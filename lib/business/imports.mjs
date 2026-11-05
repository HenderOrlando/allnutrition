import { createHash } from 'node:crypto';
import { AppError, fail, integer, text, validateOrder } from '../validation.mjs';
import { importFields, getImportColumnIssues, normalizeImportFieldName, isImportFieldAllowed } from '../schema.mjs';
import { assertLease, audit, canonicalJSON, entity, hash, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { businessDate, bogotaDate, instant } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { readExcel, normalizeExcelIdentifier, normalizeExcelText, normalizeExcelMoney, normalizeExcelDate, writeExcelSheets } from './excel.mjs';
import { claimJob, finishJob, queueJobTx, updateJobProgressTx, withLeaseHeartbeat } from './job-leases.mjs';
import { getBusinessSettings, ruleForOrder } from './settings.mjs';
import { loadOrderData, persistOrderData, resolveOrderRecognition, saveOrderTx, initializeInventoryOpeningTx } from './orders.mjs';
import { effectiveShipmentEvents, linkShipmentTx, recordShipmentEventTx, saveShipmentTx, validateShipmentMetadata, SHIPMENT_STATUSES } from './shipments.mjs';
import { validateImportedFields, mergeImportedFields } from './imported-fields.mjs';
import { completeOrderCostsTx } from './catalog.mjs';
import { suggestWorkbookImports } from './import-presets.mjs';
import { inventoryState, inventoryOpeningIncluded, previewInventoryChanges } from './inventory.mjs';
import { recordCollectionTx } from './collections.mjs';
import { recordExpenseTx } from './expenses.mjs';
import { saveSettlementTx } from './settlements.mjs';

const FIELD_DEFINITIONS = new Map(importFields.map(field => [field.value,field]));
const mappedColumn=column=>!!column.destination && column.destination!=='ignore';
const DESTINATION_FIELDS = importFields.map(field => field.value);
const LINE_FIELDS = new Set(importFields.filter(field => field.scope === 'line').map(field => field.value));
const MONEY_FIELDS = new Set(importFields.filter(field => field.type === 'money').map(field => field.value));
const DATE_FIELDS = new Set(importFields.filter(field => field.type === 'date').map(field => field.value));
const RECIPIENT_FIELDS = ['customerName','phone','department','city','address','addressNotes','email','documentType','documentNumber'];
const SHIPMENT_INFORMATION_FIELDS = new Set(importFields.filter(field => field.scope === 'shipment' && field.effect === 'information' && ['text','money'].includes(field.type)).map(field => field.value));
const OBSERVED_FIELDS = new Set([...SHIPMENT_INFORMATION_FIELDS,...RECIPIENT_FIELDS]);
const ORDER_FIELDS = ['externalOrderId','internalOrderNumber','placedOn',...RECIPIENT_FIELDS,'orderNotes','deliveryMethod','sellerExternalKey','shippingCharge','marketingCampaign'];
const EXPENSE_INFORMATION_PROPERTIES = new Map([['expenseConcept','concept'],['expenseSupplier','supplier'],['expenseReference','reference'],['expenseNotes','notes'],['expenseCampaign','campaign']]);
const EXPENSE_QUANTITY_OBSERVATIONS=[['quantity','expenseQuantity','integer'],['unitCostMinor','expenseUnitCost','money_minor']].map(([property,destination,valueType])=>{
  const label=FIELD_DEFINITIONS.get(destination).label;
  return {property,destination,valueType,label,key:`additional:${normalizeImportFieldName(label)}`};
});
const IMPORT_COST_FIELDS = [
  ['shippingOutCost','shippingOutCostDate','shipping_out'],
  ['shippingReturnCost','shippingReturnCostDate','shipping_return'],
  ['platformFee','platformFeeDate','platform_fee'],
  ['insuranceCost','insuranceCostDate','shipping_insurance']
];
const costIsObserved = (shipment,field) => shipment.values[field] != null || field === 'insuranceCost' && shipment.insuranceCostMapped === true;
const RESOLUTION_ACTIONS = ['link_product','link_person','link_order','link_shipment','duplicate','additional_quantity','status','review_policy','review_authority','accept_formulas','omit_group','commercial_update','cell_value','independent_record','opening_observation','line_costs','link_expense'];
const LOCKED = new Set(['queued','applying','previewing']);
const CANCELLABLE = new Set(['uploaded','previewing','review','queued','applying','failed']);
const canCancelBatch = batch => CANCELLABLE.has(batch.state) && !batch.completedAt && !batch.finishedAt;
const PAGE_SIZE = 20;
const MAX_BYTES = 10 * 1024 * 1024;
const normalizeHeader = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ').trim();
const exactSheetName=(value,{required=true}={})=>{
  if(value==null && !required)return '';
  if(typeof value!=='string' || value.length>100 || required && !value.trim() || /[\u0000-\u001f\u007f]/.test(value))fail('Nombre de hoja no válido.');
  return value;
};
const plain = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}: datos no válidos.`); return value; };
const choice = (value, values, label) => { if (!values.includes(value)) fail(`${label}: opción no válida.`); return value; };
const cutoff = value => value == null || value === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(`${businessDate(value)}T05:00:00.000Z`) + 86400000 - 1).toISOString() : instant(value,'Fecha de corte');
const on = value => value?.occurredOn || (value?.occurredAt ? bogotaDate(value.occurredAt) : null);
const importCostChargeOn = (values,field,dateField,expense) => values[dateField] ? on(values[dateField]) : field === 'insuranceCost' || !expense ? null : Object.hasOwn(expense,'chargeOn') ? expense.chargeOn : expense.incurredOn;
const observationAt = value => value?.occurredAt || (value?.occurredOn ? `${value.occurredOn}T05:00:00.000Z` : null);
const collectionIsEvent=values=>!!(values.collectionExternalId || values.collectionReference && on(values.collectionDate));
const FILE_ERRORS = new Set(['EXCEL_INVALID','EXCEL_FORMAT','EXCEL_PROTECTED','EXCEL_FILE_LIMIT','EXCEL_CONTENT_LIMIT','EXCEL_TIMEOUT','EXCEL_MEMORY_LIMIT','EXCEL_FORMULA_NO_CACHE','EXCEL_IDENTIFIER_PRECISION']);
const CONFIG_ERRORS = new Set(['EXCEL_SHEET','EXCEL_HEADER','EXCEL_TEXT_LIMIT','IMPORT_HEADER','IMPORT_COLUMN','IMPORT_COLUMN_PENDING','IMPORT_COLUMN_COLLISION','IMPORT_COLUMN_DESTINATION','IMPORT_COLUMN_DUPLICATE','IMPORT_ADDITIONAL_NAME','IMPORT_ADDITIONAL_DUPLICATE']);
const isImportAvailabilityError = error => error.status === 503 || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','57P01','57P02','57P03','08006','53300','40001','40P01','SQLITE_BUSY','SQLITE_LOCKED'].includes(error.code);
function errorRecord(error, extra = {}) {
  const internal = !error.status || error.status >= 500;
  const code = internal ? 'IMPORT_INTERNAL' : error.code || (error.status === 409 ? 'IMPORT_CONFLICT' : 'IMPORT_DATA');
  const category = FILE_ERRORS.has(code) ? 'file' : CONFIG_ERRORS.has(code) ? 'configuration' : 'system';
  const action = category === 'file' ? 'Descarga el original y revisa el problema indicado. Si debes cambiar el archivo, crea una importación nueva; este original se conserva.'
    : category === 'configuration' ? 'Revisa la hoja y el encabezado; cambia el destino, grupo o nombre del campo adicional, o ignora la columna indicada. Guarda la configuración corregida y genera una revisión nueva.'
    : internal ? 'El archivo y la configuración se conservan. Reintenta la revisión; si vuelve a fallar, comunica el código y el lote al administrador.'
    : code === 'IMPORT_EMPTY_ROWS' ? 'Comprueba la hoja y la fila de encabezados seleccionadas. Si el archivo no contiene registros, usa una importación nueva con el archivo completo.'
    : ['EXCEL_DATE','EXCEL_MONEY'].includes(code) ? 'Revisa el valor indicado junto con su columna asignada y el formato de fechas o importes. Corrige la configuración y genera una revisión nueva; si el origen debe cambiar, crea una importación nueva.'
    : 'Revisa el problema indicado, las asignaciones y los vínculos del grupo antes de generar una revisión nueva. Si no identificas la causa, comunica el código y el lote al administrador.';
  return {code,message:internal ? 'No se pudo completar el procesamiento de la importación por un error interno.' : error.message,category,action,...extra,...(internal?{}:error.location || {})};
}
function configurationError(message, code, location) {
  return Object.assign(new AppError(message),{code,location});
}
const rawById = (tx, table, id) => tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`,[id]);
const byId = async (tx, table, id) => entity(await rawById(tx,table,id));
const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Shared by profiles and batches: no executable expressions or guessed mappings.
export function validateImportConfig(input = {}, {allowDuplicateDestinations = false} = {}) {
  plain(input,'Configuración de importación');
  if (input.formatVersion != null && input.formatVersion !== 2) fail('Versión de configuración no válida.');
  if (input.formatVersion === 2 || Object.hasOwn(input,'sheets')) {
    if (Object.keys(input).some(key=>!['formatVersion','sheets'].includes(key))) fail('La configuración contiene un campo no permitido.');
    if (!Array.isArray(input.sheets) || input.sheets.length > 50) fail('Configura como máximo 50 hojas.');
    const sheets = input.sheets.map(sheet=>validateSheetConfig(sheet,{allowDuplicateDestinations,legacy:allowDuplicateDestinations && sheet?.sheetName==null}));
    if (new Set(sheets.map(sheet=>sheet.sheetName)).size !== sheets.length) fail('La hoja se repite en la configuración.');
    return {formatVersion:2,sheets};
  }
  return {formatVersion:2,sheets:Object.keys(input).length ? [validateSheetConfig(input,{allowDuplicateDestinations,legacy:true,legacyColumns:true})] : []};
}
function validateSheetConfig(input,{allowDuplicateDestinations=false,legacy=false,legacyColumns=false}={}) {
  plain(input,'Configuración de hoja');
  const allowed = ['sheetName','enabled','headerRow','dateFormat','decimalSeparator','groupSeparator','layout','purpose','columns','statusMap','oneOrderPerGuide','reportAsOf','defaults','identityMode','expenseGroupNames','expenseCategoryMap'];
  if (Object.keys(input).some(key=>!allowed.includes(key))) fail('La configuración contiene un campo no permitido.');
  const sheetName=exactSheetName(input.sheetName,{required:!legacy});
  if (input.enabled != null && typeof input.enabled !== 'boolean') fail('Confirma si se importa la hoja.');
  const purpose=choice(input.purpose || 'orders',['orders','tracking','settlements','expenses','allocations','component_costs','observations'],'Propósito');
  const auxiliary=['allocations','component_costs','observations'].includes(purpose);
  const layouts=auxiliary?['relation_rows']:purpose==='expenses'?['expense_rows','expense_columns']:['item_rows','order_rows'];
  const layout=choice(input.layout || layouts[0],layouts,'Distribución');
  const identityMode=choice(input.identityMode || 'provided',['provided','generated'],'Identidad');
  if(identityMode==='generated' && !(purpose==='expenses' || purpose==='orders' && layout==='order_rows'))fail('La generación de identidad requiere una fila por pedido o gasto.');
  const decimalSeparator=input.decimalSeparator ?? ',',groupSeparator=input.groupSeparator ?? '.';
  if(!['.',','].includes(decimalSeparator) || !['.',',',' ','\u00a0',''].includes(groupSeparator) || decimalSeparator===groupSeparator)fail('Los separadores decimales y de miles deben ser distintos.');
  if(!Array.isArray(input.columns ?? []) || (input.columns || []).length>200)fail('Asigna como máximo 200 columnas.');
  for(const column of input.columns || [])plain(column,'Columna');
  const issues=getImportColumnIssues(input.columns || [],layout,purpose);
  const issue=issues.find(issue=>!allowDuplicateDestinations || issue.code!=='IMPORT_COLUMN_DUPLICATE' || issue.indexes[0]===issue.indexes[1]);
  if(issue)throw configurationError(issue.message,issue.code,{sheet:sheetName,column:issue.indexes[0]+1,indexes:issue.indexes});
  const columns=(input.columns || []).map(column=>{
    if(Object.keys(column).some(key=>!['index','header','destination','group','fieldName'].includes(key)))fail('La columna contiene un campo no permitido.');
    const destination=column.destination || (legacyColumns?'ignore':'');
    const compatible=!destination || isImportFieldAllowed(destination,purpose);
    if(!compatible)throw configurationError('El destino no corresponde al propósito de esta hoja.','IMPORT_COLUMN_DESTINATION',{sheet:sheetName,column:Number(column.index)+1,field:destination});
    return {index:integer(column.index,'Posición de columna',0,199),header:normalizeHeader(text(column.header,'Encabezado',500)),destination,group:integer(column.group ?? 0,'Grupo',0,49),...(['additionalField','orderAdditionalField','expenseAdditionalField'].includes(destination)?{fieldName:text(column.fieldName,'Nombre del campo adicional',100,true)}:{})};
  });
  const statusMap={};plain(input.statusMap || {},'Equivalencias de estado');
  if(Object.keys(input.statusMap || {}).length>500)fail('Demasiadas equivalencias de estado.');
  for(const [key,value] of Object.entries(input.statusMap || {})){
    const normalized=text(key,'Estado de origen',500,true);
    if(Object.hasOwn(statusMap,normalized))fail('La equivalencia de estado se repite tras normalizarla.');
    Object.defineProperty(statusMap,normalized,{value:choice(value,SHIPMENT_STATUSES,'Estado del envío'),enumerable:true});
  }
  const defaults={};plain(input.defaults || {},'Valores fijos');
  const defaultKeys=purpose==='expenses'?['expenseCategory','expenseConcept','expenseSupplier','expenseCampaign']:purpose==='orders'?['deliveryMethod','carrier','giftQuantity']:auxiliary?[]:['deliveryMethod','carrier'];
  for(const [key,value] of Object.entries(input.defaults || {})){
    if(!defaultKeys.includes(key))fail('Valor fijo no permitido para esta hoja.');
    defaults[key]=key==='giftQuantity'?integer(value,'Cantidad confirmada de obsequios',1,999):key==='expenseCategory'?choice(value,['advertising','operating','other'],'Categoría'):key==='deliveryMethod'?choice(value,['carrier','local','pickup'],'Modalidad'):text(value,'Valor fijo',key==='expenseConcept'?500:200,true);
  }
  const expenseGroupNames={},expenseCategoryMap={};
  plain(input.expenseGroupNames || {},'Nombres de campaña');plain(input.expenseCategoryMap || {},'Equivalencias de categoría');
  if(layout!=='expense_columns' && Object.keys(input.expenseGroupNames || {}).length)fail('Los grupos de campaña requieren gastos por columnas.');
  for(const [key,value] of Object.entries(input.expenseGroupNames || {})){if(!/^(?:0|[1-4]?\d)$/.test(key))fail('Grupo de campaña no válido.');expenseGroupNames[key]=text(value,'Campaña',200,true);}
  if(new Set(Object.values(expenseGroupNames).map(normalizeImportFieldName)).size!==Object.keys(expenseGroupNames).length)fail('Los nombres de campaña se repiten.');
  if(Object.keys(input.expenseCategoryMap || {}).length>100 || purpose!=='expenses' && Object.keys(input.expenseCategoryMap || {}).length)fail('Equivalencias de categoría no válidas.');
  for(const [key,value] of Object.entries(input.expenseCategoryMap || {})){
    const normalized=text(key,'Categoría de origen',200,true);
    if(Object.hasOwn(expenseCategoryMap,normalized))fail('La equivalencia de categoría se repite tras normalizarla.');
    Object.defineProperty(expenseCategoryMap,normalized,{value:choice(value,['advertising','operating','other'],'Categoría'),enumerable:true});
  }
  const reportAsOf=input.reportAsOf==null || input.reportAsOf===''?null:/^\d{4}-\d{2}-\d{2}$/.test(input.reportAsOf)?businessDate(input.reportAsOf):instant(input.reportAsOf,'Fecha de corte');
  return {sheetName:sheetName || null,enabled:input.enabled!==false,headerRow:integer(input.headerRow ?? 1,'Fila de encabezados',1,10000),dateFormat:choice(input.dateFormat || 'DMY',['DMY','MDY','ISO'],'Formato de fecha'),decimalSeparator,groupSeparator,purpose,layout,columns,statusMap,oneOrderPerGuide:input.oneOrderPerGuide===true,reportAsOf,defaults,identityMode,expenseGroupNames,expenseCategoryMap};
}
const rowKey=(sheet,rowNumber)=>JSON.stringify([sheet,rowNumber]);
function reusableImportConfig(input){
  const config=validateImportConfig(input,{allowDuplicateDestinations:true});
  return {...config,sheets:config.sheets.map(sheet=>({...sheet,reportAsOf:null}))};
}
const rowRefs=rows=>rows.map(({sheet,rowNumber})=>({sheet,rowNumber}));
const rowConfig=(row,config)=>row.config || config.sheets?.find(sheet=>sheet.sheetName===row.sheet) || config;
const workbookManifest=batch=>(batch.workbook?.sheets || []).map(({name,rowCount,columnCount,empty})=>({name,rowCount,columnCount,empty}));
export function decodeImportRevision(input) {
  const revision=structuredClone(input),legacy=revision.formatVersion!==2,config=validateImportConfig(revision.config || {},{allowDuplicateDestinations:legacy});
  revision.config=config;
  for(const group of revision.groups || []){
    group.kind ||= 'commercial';group.rowRefs ||= rowRefs(group.rows || []);
    for(const row of group.rows || [])row.config ||= config.sheets.find(sheet=>!sheet.sheetName || sheet.sheetName===row.sheet);
    for(const unit of group.units || []){
      unit.oneOrderPerGuide ??= config.sheets[0]?.oneOrderPerGuide===true;
      unit.rowRefs ||= group.rowRefs;
      for(const shipment of unit.shipments || []){
        shipment.rowRefs ||= group.rowRefs.filter(ref=>shipment.rowNumbers.includes(ref.rowNumber));
        for(const financial of shipment.financial || [])financial.rowRefs ||= shipment.rowRefs.filter(ref=>financial.rowNumbers.includes(ref.rowNumber));
      }
    }
  }
  return revision;
}

export function validateResolution(input) {
  plain(input,'Resolución');
  const action = choice(input.action,RESOLUTION_ACTIONS,'Acción de revisión');
  const result = {action};
  if(action!=='cell_value')for (const key of ['entityKey','externalKey','internalId']) if (input[key] != null && input[key] !== '') result[key] = text(input[key],key,key === 'entityKey' ? 200 : 500,true);
  if(input.sheet!=null && input.sheet!=='')result.sheet=exactSheetName(input.sheet);
  if (input.rowNumber != null) result.rowNumber = integer(input.rowNumber,'Fila',1,10001);
  if (input.reason != null) result.reason = text(input.reason,'Motivo',2000);
  if(action==='cell_value')result.columnIndex=integer(input.columnIndex,'Columna',0,199);
  if(input.remove===true)return {...result,remove:true};
  if (['review_policy','review_authority','commercial_update','cell_value','opening_observation','link_expense'].includes(action) && !result.reason) fail('La revisión requiere un motivo.');
  if (action.startsWith('link_') && !result.internalId) fail('Selecciona el registro que se vinculará.');
  if (['link_product','link_person'].includes(action) && !result.externalKey) fail('El alias requiere clave externa.');
  if(['cell_value','independent_record','opening_observation','link_expense'].includes(action) && (!result.sheet || !result.rowNumber))fail('Selecciona la hoja y fila de la revisión.');
  if(action==='cell_value'){
    if(input.value!==null && !['string','number','boolean'].includes(typeof input.value) || typeof input.value==='number' && !Number.isFinite(input.value))fail('El reemplazo debe ser un valor literal.');
    if(typeof input.value==='string' && input.value.length>4000)fail('El valor de celda supera 4000 caracteres.');
    result.value=input.value;
  } else if(action==='independent_record'){
    const value=input.value || newId();
    if(typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('Identidad independiente no válida.');
    result.value=value;
  } else if(action==='opening_observation'){
    if(typeof input.value!=='boolean' || !result.externalKey)fail('Confirma la observación de apertura concreta.');
    result.value=input.value;
  } else if(action==='line_costs'){
    const value=plain(input.value,'Costos de líneas');
    if(!result.externalKey || !Array.isArray(value.lineCosts) || !value.lineCosts.length || value.lineCosts.length>50)fail('Identifica el pedido y sus costos.');
    const seen=new Set();
    result.value={lineCosts:value.lineCosts.map(line=>{
      plain(line,'Costo de línea');const lineId=text(line.lineId,'Línea',100,true);
      if(seen.has(lineId))fail('La línea de costo se repite.');seen.add(lineId);
      if(line.components!=null && (!Array.isArray(line.components) || line.components.length>100))fail('Componentes no válidos.');
      if(line.unitCostMinor==null && !line.components?.length)fail('El costo necesita un importe explícito o los costos de componentes.');
      return {lineId,unitCostMinor:line.unitCostMinor==null?null:moneyMinor(line.unitCostMinor),...(line.components?{components:line.components.map(component=>({productId:text(component.productId,'Componente',100,true),unitCostMinor:moneyMinor(component.unitCostMinor)}))}:{})};
    })};
  }
  if (action === 'status') result.value = choice(input.value,SHIPMENT_STATUSES,'Estado del envío');
  else if (action === 'accept_formulas') { if (input.value !== true) fail('Confirma explícitamente las fórmulas con valor guardado.'); result.value = true; }
  else if (action === 'review_policy') result.value = {ruleVersionId:text(plain(input.value,'Política histórica').ruleVersionId,'Versión de regla',100,true)};
  else if (action === 'review_authority') {
    const value = plain(input.value || {},'Autoridad');
    if (Object.keys(value).some(key => !['correctionOf','allowCredit'].includes(key))) fail('Revisión de autoridad no válida.');
    result.value = {correctionOf:text(value.correctionOf,'Evento rectificado',100) || null,allowCredit:value.allowCredit === true};
  } else if (action === 'commercial_update') {
    const value = plain(input.value,'Datos comerciales'), allowed = [...RECIPIENT_FIELDS,'notes','deliveryMethod','placedOn','sellerId','shippingChargeMinor','items','shipmentAssignments','marketingCampaign'];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('Campo comercial no permitido.');
    result.value = {};
    for (const key of [...RECIPIENT_FIELDS,'notes','sellerId','marketingCampaign']) if (Object.hasOwn(value,key)) {
      const field = FIELD_DEFINITIONS.get(key === 'notes' ? 'orderNotes' : key);
      result.value[key] = text(value[key],field?.label || 'Vendedor',field?.max ?? 100) || (key === 'sellerId' ? null : '');
    }
    if (Object.hasOwn(value,'deliveryMethod')) result.value.deliveryMethod = choice(value.deliveryMethod,['carrier','local','pickup'],'Modalidad de entrega');
    if (Object.hasOwn(value,'placedOn')) result.value.placedOn = businessDate(value.placedOn);
    if (Object.hasOwn(value,'shippingChargeMinor')) result.value.shippingChargeMinor = moneyMinor(value.shippingChargeMinor);
    if (Object.hasOwn(value,'items')) {
      if (!Array.isArray(value.items) || !value.items.length || value.items.length > 50) fail('Completa entre 1 y 50 líneas reales.');
      result.value.items = value.items.map(line => ({lineId:text(line.lineId,'Línea',100) || newId(),externalLineId:text(line.externalLineId,'Identidad externa de línea',200) || null,kind:choice(line.kind || 'products',['products','combos'],'Tipo de producto'),itemId:text(line.itemId,'Producto',100,true),quantity:integer(line.quantity,'Cantidad',1,999),unitPriceMinor:moneyMinor(line.unitPriceMinor),discountMinor:moneyMinor(line.discountMinor ?? 0)}));
    }
    if(Object.hasOwn(value,'shipmentAssignments')) {
      if(!Array.isArray(value.shipmentAssignments) || value.shipmentAssignments.length>10000)fail('Distribución de envíos no válida.');
      const keys=new Set();
      result.value.shipmentAssignments=value.shipmentAssignments.map(shipment=>{
        plain(shipment,'Distribución de envío');
        const externalShipmentId=text(shipment.externalShipmentId,'ID de envío',200) || null, tracking=text(shipment.tracking,'Guía',200) || null;
        if(!externalShipmentId && !tracking)fail('Identifica cada envío de la distribución.');
        const key=externalShipmentId?`id:${externalShipmentId}`:`guide:${tracking}`;
        if(keys.has(key))fail('El envío se repite en la distribución.');keys.add(key);
        if(!Array.isArray(shipment.assignments) || !shipment.assignments.length || shipment.assignments.length>50)fail('Asigna entre 1 y 50 líneas por envío.');
        const seen=new Set(),assignments=shipment.assignments.map(line=>{const lineId=text(line.lineId,'Línea',100,true);if(seen.has(lineId))fail('La línea se repite en el envío.');seen.add(lineId);return {lineId,quantity:integer(line.quantity,'Cantidad',1,999)};});
        return {externalShipmentId,tracking,assignments};
      });
    }
  } else if (action === 'link_shipment' && input.value != null) {
    const value = plain(input.value,'Asignaciones');
    if (!Array.isArray(value.assignments) || value.assignments.length > 50) fail('Asignaciones no válidas.');
    result.value = {assignments:value.assignments.map(line => ({lineId:text(line.lineId,'Línea',100,true),quantity:integer(line.quantity,'Cantidad',1,999)}))};
  }
  return result;
}
const resolutionKey = resolution => resolution.action==='cell_value'
  ? hash([resolution.action,resolution.sheet,resolution.rowNumber,resolution.columnIndex])
  : hash([resolution.action,resolution.sheet || null,resolution.rowNumber || null,resolution.entityKey || null,resolution.externalKey || null]);
const applicable = (resolution,group,row = null) => (resolution.action==='cell_value' || !resolution.entityKey || resolution.entityKey === group.key || group.identityKeys?.includes(resolution.entityKey)) && (row ? (!resolution.sheet || resolution.sheet===(row.sheet || group.sheet)) && (!resolution.rowNumber || resolution.rowNumber===row.rowNumber) : (group.rowRefs || (group.rowNumbers || []).map(rowNumber=>({sheet:group.sheet,rowNumber}))).some(ref=>(!resolution.sheet || resolution.sheet===ref.sheet) && (!resolution.rowNumber || resolution.rowNumber===ref.rowNumber)));
const findResolution = (resolutions,action,group,row = null,externalKey = null) => [...resolutions].reverse().filter(resolution => resolution.action === action && applicable(resolution,group,row) && (externalKey == null || !resolution.externalKey || resolution.externalKey === externalKey)).sort((a,b)=>(Number(!!b.rowNumber)*8+Number(!!b.entityKey)*4+Number(!!b.sheet)*2+Number(!!b.externalKey))-(Number(!!a.rowNumber)*8+Number(!!a.entityKey)*4+Number(!!a.sheet)*2+Number(!!a.externalKey)))[0];

async function requireSource(tx,id) {
  const source = await byId(tx,'platform_sources',text(id,'Cuenta de plataforma',100,true));
  if (!source) fail('Cuenta de plataforma no encontrada.',404);
  const platform = await byId(tx,'platforms',source.platformId);
  if (!platform) fail('Plataforma no encontrada.',404);
  return {...source,platform};
}
async function requireBatch(tx,id) {
  const row = await rawById(tx,'import_batches',text(id,'Lote',100,true));
  if (!row) fail('Importación no encontrada.',404);
  return {...entity(row),bytes:row.file_bytes_base64};
}
function editable(batch,version) {
  integer(version,'Versión del lote',1);
  if (batch.version !== version) fail('El lote cambió. Recarga antes de continuar.',409);
  if (batch.state === 'cancelled') fail('La importación fue cancelada. Crea un lote nuevo para otro archivo.',409);
  if (LOCKED.has(batch.state)) fail('La importación tiene un trabajo aceptado. Espera a que termine antes de cambiar la revisión.',409);
  if (batch.state === 'expired' || batch.fileExpired) fail('Archivo original vencido. Crea un lote nuevo.',409);
}
async function changeBatch(tx,batch,fields = {},data = {}) {
  const {bytes,fileBytesBase64,...current} = batch;
  const stored = JSON.parse((await rawById(tx,'import_batches',batch.id)).data);
  await updateVersioned(tx,'import_batches',batch.id,batch.version,{...fields,data:JSON.stringify({...stored,...data})});
  return requireBatch(tx,current.id);
}
const jobData = (batch,actorId,phase,extra = {}) => ({kind:'import',phase,batchId:batch.id,actorId,requestedBy:actorId,...extra});
function batchDTO(batch,source) {
  const {bytes,fileBytesBase64,...value} = batch;
  return {id:value.id,version:value.version,state:value.state,sourceId:value.sourceId,platformId:source.platformId,profileId:value.profileId,profileVersion:value.profileVersion ?? null,filename:value.filename,fileHash:value.fileHash,fileExpired:!!value.fileExpired,fileDiscarded:!!value.fileDiscarded,canCancel:canCancelBatch(value),cancellation:value.cancellation || null,createdAt:value.createdAt,updatedAt:value.updatedAt,completedAt:value.completedAt || null,expiresAt:value.expiresAt,workbook:value.workbook || null,config:validateImportConfig(value.config || {},{allowDuplicateDestinations:true}),inventoryOpening:value.inventoryOpening || null,resolutions:value.resolutions || [],preview:value.preview || null,progress:value.progress || null,acceptedRevision:value.acceptedRevision || null,error:value.error || null};
}
export async function createImportBatch(store,input,actorId) {
  const id = await runCommand(store,{scope:'import:create',requestId:input.requestId,payload:input,actorId},async tx => {
    const source = await requireSource(tx,input.sourceId);
    if (!source.active || !source.platform.active) fail('Selecciona una plataforma y cuenta activas.');
    const profile = input.profileId ? await byId(tx,'import_profiles',input.profileId) : null;
    if (input.profileId && (!profile || profile.sourceId !== source.id)) fail('El perfil no pertenece a esta cuenta de plataforma.');
    const id = newId(), now = stamp(), config = reusableImportConfig(profile ? JSON.parse((await rawById(tx,'import_profiles',profile.id)).data) : {});
    await insertRow(tx,'import_batches',{id,source_id:source.id,profile_id:profile?.id || null,file_hash:null,filename:null,file_bytes_base64:null,state:'uploaded',version:1,created_at:now,updated_at:now,expires_at:new Date(Date.parse(now)+7*86400000).toISOString(),data:JSON.stringify({config,resolutions:[],profileVersion:profile?.version || null,createdBy:actorId,progress:{phase:'file',processed:0,total:0}})});
    return id;
  });
  return getImportBatch(store,id);
}
export async function uploadImportFile(store,batchId,input,actorId) {
  const bytes = Buffer.from(input.bytes || []), filename = text(input.filename,'Nombre del archivo',255,true);
  if (!bytes.length) fail('El archivo está vacío.');
  if (bytes.length > MAX_BYTES) fail('El archivo supera el máximo de 10 MiB.',413);
  if (!/\.(xlsx|xls|xlsb|xlsm)$/i.test(filename) || /[\r\n\0/\\]/.test(filename)) fail('Selecciona un archivo Excel .xlsx, .xls, .xlsb o .xlsm.',415);
  const signature = bytes.subarray(0,8).toString('hex');
  if (!(signature.startsWith('504b0304') && !/\.xls$/i.test(filename) || signature === 'd0cf11e0a1b11ae1' && /\.xls$/i.test(filename))) fail('La firma del archivo no coincide con su extensión Excel.',415);
  const digest = fileHash(bytes);
  await runCommand(store,{scope:`import:upload:${batchId}`,requestId:input.requestId,payload:{filename,version:input.version,fileHash:digest,size:bytes.length},actorId},async tx => {
    const batch = await requireBatch(tx,batchId); editable(batch,input.version);
    if (batch.fileHash) fail('Los bytes del lote son inmutables. Otro archivo requiere una importación nueva.',409);
    const updated = await changeBatch(tx,batch,{filename,file_hash:digest,file_bytes_base64:bytes.toString('base64'),state:'uploaded'},{progress:{phase:'inspect',processed:0,total:0},error:null});
    await queueJobTx(tx,`import:${batchId}`,jobData(updated,actorId,'inspect'));
    return {id:batchId};
  });
  return getImportBatch(store,batchId);
}
export async function cancelImportBatch(store,batchId,input,actorId) {
  await runCommand(store,{scope:`import:cancel:${batchId}`,requestId:input.requestId,payload:input,actorId,affectsIndicators:false},async tx=>{
    const batch=await requireBatch(tx,batchId);
    if(batch.state==='cancelled')return {id:batchId};
    if(!canCancelBatch(batch))fail('La importación ya terminó o su archivo venció. No se puede descartar ni cancelar.',409);
    let progress={processed:0,total:0,groupsTotal:0,groupsProcessed:0,settlementsTotal:0,settlementsProcessed:0,created:0,updated:0,unchanged:0,errors:0,omitted:0},appliedGroups=0,appliedSettlements=0;
    if(batch.acceptedRevision) {
      const row=await tx.db.get(`SELECT revision,data FROM ${tx.t('import_revisions')} WHERE batch_id=? AND revision=?`,[batchId,batch.acceptedRevision]);
      if(!row)fail('No existe la revisión aceptada de esta importación.',409);
      const revision=decodeImportRevision({...JSON.parse(row.data),revision:row.revision});
      progress=await durableProgress(tx,batchId,revision);
      // The last group may have committed before the worker publishes its final status.
      if(progress.total>0 && progress.processed>=progress.total)fail('La importación ya terminó de procesar sus operaciones. No se puede descartar ni cancelar.',409);
      const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
      appliedGroups=Number((await tx.db.get(`SELECT COUNT(DISTINCT entity_key) AS n FROM ${tx.t('import_rows')} WHERE batch_id=? AND (state='applied' OR (state='skipped' AND ${appliedJSON} IS NOT NULL))`,[batchId])).n);
      appliedSettlements=(await settlementOutcomes(tx,batchId,revision)).results.size;
    }
    const cancellation={cancelledAt:stamp(),cancelledBy:actorId,appliedGroups,appliedSettlements,remainingGroups:progress.groupsTotal-progress.groupsProcessed,remainingSettlements:progress.settlementsTotal-progress.settlementsProcessed,originalDiscarded:!!batch.bytes};
    await changeBatch(tx,batch,{state:'cancelled',file_bytes_base64:null},{cancellation,fileDiscarded:true,workbook:null,preview:null,previewGroups:null,error:null,progress:{...progress,phase:'cancelled'}});
    // Removing the work entry revokes an active lease under the same write lock.
    await tx.db.run(`DELETE FROM ${tx.t('job_runs')} WHERE key=?`,[`import:${batchId}`]);
    await audit(tx,{entityType:'import_batch',entityId:batchId,actorId,previous:{state:batch.state},next:{state:'cancelled',fileHash:batch.fileHash,cancellation},reason:'Cancelación solicitada por el administrador; se conservan las operaciones ya confirmadas.',source:'excel'});
    return {id:batchId};
  });
  return getImportBatch(store,batchId);
}
async function pendingProductLinks(tx,batch) {
  if (!canCancelBatch(batch)) return [];
  // Saved row diagnostics survive preview invalidation. This is a work queue,
  // never a replacement for a current preview or permission to apply a group.
  const field = key => tx.provider==='sqlite' ? `json_extract(data,'$.${key}')` : `data::jsonb->'${key}'`;
  const rows = await tx.db.all(`SELECT sheet,row_number,entity_key,${field('errors')} AS errors,${field('normalized')} AS normalized FROM ${tx.t('import_rows')} WHERE batch_id=? AND state NOT IN ('applied','skipped') ORDER BY sheet,row_number`,[batch.id]);
  const products = new Map(),giftReferences = new Map(),config=validateImportConfig(batch.config || {},{allowDuplicateDestinations:true});
  for (const saved of rows) {
    const sheetConfig=config.sheets.find(sheet=>sheet.sheetName===saved.sheet && sheet.enabled);
    if (!sheetConfig) continue;
    const errors=typeof saved.errors==='string'?JSON.parse(saved.errors):saved.errors || [];
    const normalized=typeof saved.normalized==='string'?JSON.parse(saved.normalized):saved.normalized || {};
    const row={sheet:saved.sheet,rowNumber:Number(saved.row_number),values:normalized.values || {}};
    const group={key:saved.entity_key,sheet:row.sheet,identityKeys:[rowOrderKey(row,sheetConfig)]};
    const references=new Set((normalized.lines || []).map(line=>line.productExternalKey));
    for (const line of normalized.lines || []) if(line.productExternalKey)giftReferences.set(line.productExternalKey,(giftReferences.get(line.productExternalKey) ?? true) && line.giftOnly===true);
    for (const key of new Set(errors.filter(error=>error.code==='IMPORT_PRODUCT_LINK' && references.has(error.externalKey)).map(error=>error.externalKey))) {
      if (findResolution(batch.resolutions || [],'link_product',group,row,key)) continue;
      if (!products.has(key)) products.set(key,new Set());
      products.get(key).add(group.key);
    }
  }
  return [...products].map(([externalKey,groups])=>({externalKey,count:groups.size,...(giftReferences.get(externalKey)?{giftOnly:true}:{})}));
}
export async function getImportBatch(store,batchId,{page = 1,state = '',q = ''} = {}) {
  page = integer(Number(page),'Página',1,100000); q = text(q,'Búsqueda',100);
  return store.readSnapshot(async tx => {
    const batch = await requireBatch(tx,batchId), source = await requireSource(tx,batch.sourceId);
    const where = ['batch_id=?'], values = [batchId];
    if (state) { choice(state,['pending','new','updated','unchanged','conflict','rejected','ready','skipped','applied'],'Estado de fila'); where.push('state=?'); values.push(state); }
    if (q) { where.push(`LOWER(data) LIKE ? ESCAPE '!'`); values.push('%'+q.toLocaleLowerCase('es').replace(/[!%_]/g,c=>'!'+c)+'%'); }
    const total = Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('import_rows')} WHERE ${where.join(' AND ')}`,values)).n);
    const records = (await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE ${where.join(' AND ')} ORDER BY sheet,row_number LIMIT ? OFFSET ?`,[...values,PAGE_SIZE,(page-1)*PAGE_SIZE])).map(entity);
    for(const record of records)for(const issue of Object.values(batch.settlementIssues || {}))if(issue.refs.some(ref=>ref.sheet===record.sheet && ref.rowNumbers.includes(record.rowNumber)))record.errors=[...(record.errors || []),{...issue.error,entityType:'settlement',externalKey:issue.key}];
    return {...batchDTO(batch,source),pendingProductLinks:await pendingProductLinks(tx,batch),rows:{records,total,page,pageSize:PAGE_SIZE}};
  });
}
export async function listImportBatches(store,{page = 1,source = '',sourceId = source,state = ''} = {}) {
  page = integer(Number(page),'Página',1,100000);
  return store.readSnapshot(async tx => {
    const where = [], values = [];
    if (sourceId) {where.push('source_id=?');values.push(text(sourceId,'Cuenta',100,true));}
    if (state) {choice(state,['uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired','cancelled'],'Estado del lote');where.push('state=?');values.push(state);}
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('import_batches')}${filter}`,values)).n);
    // Never select file_bytes_base64 for lists.
    const records = await tx.db.all(`SELECT id,source_id,profile_id,file_hash,filename,state,version,created_at,updated_at,expires_at,data FROM ${tx.t('import_batches')}${filter} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,[...values,PAGE_SIZE,(page-1)*PAGE_SIZE]);
    const result = [];
    for (const row of records) result.push(batchDTO(entity(row),await requireSource(tx,row.source_id)));
    return {records:result,total,page,pageSize:PAGE_SIZE};
  });
}
export async function updateImportBatch(store,batchId,input,actorId) {
  if (input.resolutions != null && (!Array.isArray(input.resolutions) || input.resolutions.length > 100)) fail('Envía como máximo 100 resoluciones por petición.');
  await runCommand(store,{scope:`import:update:${batchId}`,requestId:input.requestId,payload:input,actorId},async tx => {
    const batch = await requireBatch(tx,batchId); editable(batch,input.version);
    let config = validateImportConfig(batch.config || {},{allowDuplicateDestinations:true}), profileId = batch.profileId, profileVersion = batch.profileVersion,inventoryOpening=batch.inventoryOpening || null;
    if (Object.hasOwn(input,'profileId')) {
      const profile = input.profileId ? await byId(tx,'import_profiles',input.profileId) : null;
      if (input.profileId && (!profile || profile.sourceId !== batch.sourceId)) fail('El perfil no pertenece a esta cuenta.');
      profileId = profile?.id || null; profileVersion = profile?.version || null;
      if (profile) config = reusableImportConfig(JSON.parse((await rawById(tx,'import_profiles',profile.id)).data));
    }
    if (input.config != null) config = validateImportConfig(input.config);
    const resolutions = new Map((batch.resolutions || []).map(value => [resolutionKey(value),value]));
    for (const value of input.resolutions || []) {
      const clean=validateResolution(value), key=resolutionKey(clean);
      if(['cell_value','duplicate','independent_record','link_expense'].includes(clean.action) && clean.sheet && clean.rowNumber){
        const saved=await tx.db.get(`SELECT state,data FROM ${tx.t('import_rows')} WHERE batch_id=? AND sheet=? AND row_number=?`,[batchId,clean.sheet,clean.rowNumber]);
        if(saved?.state==='applied' || saved?.data && JSON.parse(saved.data).applied)fail('No puedes cambiar una fila ya aplicada.',409);
      }
      if(clean.action==='independent_record' && !value.value && resolutions.has(key))clean.value=resolutions.get(key).value;
      if(clean.remove){resolutions.delete(key);continue;}
      if(['duplicate','additional_quantity'].includes(clean.action))resolutions.delete(resolutionKey({...clean,action:clean.action==='duplicate'?'additional_quantity':'duplicate'}));
      resolutions.delete(key);resolutions.set(key,clean);
    }
    if(Object.hasOwn(input,'inventoryOpening')){
      const opening=input.inventoryOpening;
      if(opening!=null && (plain(opening,'Apertura').confirmed!==true || Object.keys(opening).some(key=>!['on','confirmed'].includes(key))))fail('Confirma el conteo físico y su fecha.');
      inventoryOpening=opening?{on:businessDate(opening.on),confirmed:true}:null;
    }
    const samples=batch.workbook?.inspections||(batch.workbook?.sheetName?[batch.workbook]:[]);
    const resample=!!batch.fileHash&&(input.config!=null||Object.hasOwn(input,'profileId'))&&(!batch.workbook||config.sheets.some(sheet=>sheet.enabled&&!samples.some(sample=>sample.sheetName===sheet.sheetName&&Number(sample.headerRow)===sheet.headerRow)));
    const next = await changeBatch(tx,batch,{profile_id:profileId,state:resample ? 'uploaded' : 'review'},{config,inventoryOpening,profileVersion,resolutions:[...resolutions.values()],preview:null,previewGroups:null,...(resample?{sourceRowCount:null}:{}),error:null,progress:resample ? {phase:'inspect',processed:0,total:0} : {...batch.progress,error:null}});
    if (resample) await queueJobTx(tx,`import:${batchId}`,jobData(next,actorId,'inspect'),{replaceRunningPhase:'inspect'});
    return {id:batchId};
  });
  return getImportBatch(store,batchId);
}
export async function requestImportPreview(store,batchId,input,actorId) {
  await runCommand(store,{scope:`import:preview:${batchId}`,requestId:input.requestId,payload:input,actorId},async tx => {
    const batch = await requireBatch(tx,batchId); editable(batch,input.version);
    if (!batch.bytes) fail('Carga el archivo original antes de revisar las columnas.');
    const config = validateImportConfig(batch.config);
    const enabled=config.sheets.filter(sheet=>sheet.enabled);
    if(!enabled.length || enabled.some(sheet=>!sheet.columns.length))fail('Selecciona hojas y confirma sus columnas antes de revisar.');
    for(const sheet of enabled){
      const pending=sheet.columns.find(column=>column.destination==='');
      if(pending)throw configurationError(`Confirma el destino o elige «Ignorar» para la columna ${pending.index+1}.`,'IMPORT_COLUMN_PENDING',{sheet:sheet.sheetName,rowNumber:sheet.headerRow,column:pending.index+1,columnIndex:pending.index,field:''});
    }
    const next = await changeBatch(tx,batch,{state:'previewing'},{config,preview:null,previewGroups:null,error:null,progress:{phase:'preview',processed:0,total:0}});
    await queueJobTx(tx,`import:${batchId}`,jobData(next,actorId,'preview'),{replaceRunningPhase:'inspect'});
    return {id:batchId};
  });
  return {...await getImportBatch(store,batchId),accepted:true};
}

function resolveColumns(workbook,config,{includeIgnored=false}={}) {
  const location = {sheet:workbook.sheetName,rowNumber:config.headerRow};
  const header = workbook.rows.find(row => row.rowNumber === config.headerRow);
  if (!header) throw configurationError('La fila de encabezados no existe en la hoja seleccionada. Selecciona la fila que contiene los nombres de las columnas.','IMPORT_HEADER',location);
  const headers = header.cells.map(cell => normalizeHeader(cell.text ?? cell.value)), used = new Set();
  return config.columns.filter(column=>mappedColumn(column) || includeIgnored && column.destination==='ignore').map(column => {
    let index = column.index;
    if (headers[index] !== column.header) {
      const positions = headers.flatMap((value,index) => value === column.header ? [index] : []);
      if (!column.header || positions.length !== 1) throw configurationError(`Revisa la columna ${column.index+1}: el encabezado falta, cambió o está repetido.`,'IMPORT_COLUMN',{...location,column:column.index+1,field:column.destination});
      index = positions[0];
    }
    if (used.has(index)) throw configurationError(`La columna ${index+1} termina asignada a más de un campo. Confirma las asignaciones con los encabezados actuales.`,'IMPORT_COLUMN_COLLISION',{...location,column:index+1,field:column.destination});
    used.add(index);
    return index === column.index ? column : {...column,index};
  });
}
function normalizeCell(cell,field,config,workbook) {
  if (cell == null || cell.value == null && !cell.formula || cell.value === '' && !cell.formula) return null;
  if (MONEY_FIELDS.has(field)) {const value=normalizeExcelMoney(cell,config,field);return value==null?null:moneyMinor(value,field,{signed:field==='settlementNet'});}
  if (DATE_FIELDS.has(field)) return normalizeExcelDate(cell,{date1904:workbook.date1904,dateFormat:config.dateFormat},field);
  if (['quantity','giftQuantity','allocationQuantity','expenseQuantity','observationOriginRow','observationOriginColumn'].includes(field)) {
    const value=normalizeExcelIdentifier(cell,'Cantidad');
    if(value==null)return null;
    if(!/^\d+$/.test(value))fail('Usa un número entero.');
    const minimum=field==='expenseQuantity'?0:1,maximum=field==='expenseQuantity'?1000000:field==='observationOriginRow'?10001:field==='observationOriginColumn'?200:999;
    return integer(Number(value),'Cantidad',minimum,maximum);
  }
  const definition = FIELD_DEFINITIONS.get(field);
  if (['text','enum','additional'].includes(definition?.type)) return normalizeExcelText(cell,definition.label,definition.max ?? 4000);
  return normalizeExcelIdentifier(cell,field);
}
function normalizeRows(workbook,config,resolutions,filename='') {
  const columns = resolveColumns(workbook,config), rows = [];
  const headerCells = workbook.rows.find(row => row.rowNumber === config.headerRow).cells;
  for (const raw of workbook.rows) {
    if (raw.rowNumber <= config.headerRow) continue;
    if (!raw.cells.some(cell => cell && (cell.value != null && cell.value !== '' || cell.formula))) continue;
    const row = {sheet:workbook.sheetName,rowNumber:raw.rowNumber,config,values:{},information:[],lines:[],expenseLines:[],source:raw.cells,errors:[],warnings:[]}, lines = new Map(),expenseLines=new Map();
    const scope = {sheet:row.sheet,key:'',rowRefs:[{sheet:row.sheet,rowNumber:row.rowNumber}]};
    const cells=[...raw.cells];
    for(const resolution of resolutions.filter(value=>value.action==='cell_value' && applicable(value,scope,row)))cells[resolution.columnIndex]={value:resolution.value,text:resolution.value==null?'':String(resolution.value),type:typeof resolution.value==='number'?'n':typeof resolution.value==='boolean'?'b':'s'};
    for (const column of columns) {
      const cell = cells[column.index];
      try {
        if(cell?.formula && !cell.hasCachedValue)throw Object.assign(new AppError('La fórmula utilizada no tiene un valor guardado válido.'),{code:'EXCEL_FORMULA_NO_CACHE'});
        if (cell?.formula && cell.hasCachedValue && !findResolution(resolutions,'accept_formulas',scope,row,column.destination)) row.errors.push({code:'IMPORT_FORMULA_ACCEPTANCE',message:'Acepta el uso del valor guardado de la fórmula antes de importar.',sheet:row.sheet,rowNumber:row.rowNumber,columnIndex:column.index,column:column.index+1,field:column.destination});
        const value = normalizeCell(cell,column.destination,config,workbook);
        if (value == null) continue;
        const header = String(headerCells[column.index]?.text ?? headerCells[column.index]?.value ?? '');
        if (['additionalField','orderAdditionalField','expenseAdditionalField'].includes(column.destination)) {
          const scope=column.destination==='orderAdditionalField'?'order':column.destination==='expenseAdditionalField'?'expense':'shipment';
          const fields = row.values[`${scope}AdditionalFields`] || (row.values[`${scope}AdditionalFields`] = []);
          fields.push({key:`additional:${normalizeImportFieldName(column.fieldName)}`,label:column.fieldName,value,columnIndex:column.index,header});
        } else {
          if(FIELD_DEFINITIONS.get(column.destination)?.scope==='expense_line'){const line=expenseLines.get(column.group)||{group:column.group};line[column.destination]=value;expenseLines.set(column.group,line);}
          else if (LINE_FIELDS.has(column.destination) && config.layout!=='relation_rows') {const line = lines.get(column.group) || {group:column.group};line[column.destination] = value;lines.set(column.group,line);}
          else row.values[column.destination] = value;
          if (OBSERVED_FIELDS.has(column.destination) || column.destination!=='expenseExternalId' && ['order','expense'].includes(FIELD_DEFINITIONS.get(column.destination)?.scope) && FIELD_DEFINITIONS.get(column.destination)?.effect==='information') row.information.push({key:column.destination,label:FIELD_DEFINITIONS.get(column.destination).label,value,columnIndex:column.index,header});
        }
      } catch (error) {if (!error.status || error.status >= 500) throw error;row.errors.push(errorRecord(error,{phase:'preview',sheet:row.sheet,rowNumber:row.rowNumber,column:column.index+1,field:column.destination}));}
    }
    for(const [field,value] of Object.entries(config.defaults || {}))if(field!=='giftQuantity' && !columns.some(column=>column.destination===field))row.values[field]=value;
    if(row.values.expenseCategory!=null && Object.hasOwn(config.expenseCategoryMap || {},row.values.expenseCategory))row.values.expenseCategory=config.expenseCategoryMap[row.values.expenseCategory];
    row.expenseLines=[...expenseLines.values()];
    const commercial=['orders','tracking','settlements'].includes(config.purpose);
    const identityFields=['externalOrderId','internalOrderNumber','externalShipmentId','tracking','customerName','phone','city','settlementExternalId'];
    const hasCommercialData=identityFields.some(field=>row.values[field]!=null) || [...lines.values()].some(line=>line.productExternalKey || line.giftProductExternalKey);
    const hasExpenseData=config.layout==='expense_columns'?row.expenseLines.length>0:['expenseExternalId','expenseConcept','expenseAmount','expenseSupplier','expenseReference','expenseNotes','expenseCampaign'].some(field=>columns.some(column=>column.destination===field && cells[column.index]?.value!=null && cells[column.index]?.value!==''));
    if(commercial && !hasCommercialData || config.purpose==='expenses' && !hasExpenseData){row.structuralOmission=true;row.errors=[];row.warnings.push({code:'IMPORT_STRUCTURAL_ROW',message:'Fila de plantilla o resumen sin datos de una operación; no genera un registro.'});}
    const filled=columns.filter(column=>cells[column.index]?.value!=null && cells[column.index]?.value!=='');
    if(!row.structuralOmission && filled.length>1 && filled.every(column=>normalizeHeader(cells[column.index]?.text ?? cells[column.index]?.value)===column.header))row.errors.push({code:'IMPORT_ROW_EXCLUSION_REQUIRED',message:'Esta fila repite los encabezados. Confirma su exclusión antes de importar.',sheet:row.sheet,rowNumber:row.rowNumber});
    if(!row.structuralOmission)for(const column of columns.filter(column=>['placedOn','expenseDate'].includes(column.destination) && row.values[column.destination])){
      const date=on(row.values[column.destination]),year=Number(date?.slice(0,4)),sheetYear=Number((/\b(20\d{2})\b/.exec(row.sheet)||[])[1]),fileYear=Number((/\b(20\d{2})\b/.exec(filename)||[])[1]);
      if(sheetYear && year!==sheetYear || fileYear && year!==fileYear){
        const confirmed=resolutions.some(resolution=>resolution.action==='cell_value' && resolution.columnIndex===column.index && applicable(resolution,scope,row));
        const issue={code:'IMPORT_YEAR_MISMATCH',message:`La fecha pertenece a ${year}, distinto del año indicado en la hoja o archivo. Confirma conservar la fecha original o corrígela explícitamente.`,sheet:row.sheet,rowNumber:row.rowNumber,columnIndex:column.index,column:column.index+1,field:column.destination,originalValue:raw.cells[column.index]?.value ?? null,normalizedDate:date,confirmed};
        row.warnings.push(issue);
        if(!confirmed)row.errors.push({...issue,code:'IMPORT_YEAR_CONFIRMATION'});
      }
    }
    for (const line of lines.values()) {
      const {giftProductExternalKey,giftQuantity,...product}=line;
      if (Object.keys(product).some(key=>!['group','externalLineId'].includes(key)) || !giftProductExternalKey && product.externalLineId) row.lines.push(product);
      if (giftProductExternalKey) {
        const quantityMapped=columns.some(column=>column.destination==='giftQuantity' && column.group===line.group);
        row.lines.push({group:line.group,productExternalKey:giftProductExternalKey,quantity:quantityMapped?giftQuantity ?? null:config.defaults.giftQuantity ?? null,unitPrice:0,lineDiscount:0,giftOnly:true,...(line.externalLineId?{externalLineId:`excel-gift:${hash([line.externalLineId,giftProductExternalKey])}`}:{})});
      } else if (giftQuantity != null) row.errors.push({code:'IMPORT_GIFT_REQUIRED',message:'La cantidad de obsequios necesita su referencia real.',sheet:row.sheet,rowNumber:row.rowNumber});
    }
    row.fingerprint = hash({values:row.values,lines:row.lines});
    rows.push(row);
  }
  return rows;
}
const shipmentKey = values => values.externalShipmentId ? `shipment:${values.externalShipmentId}` : values.tracking ? `guide:${normalizeHeader(values.carrier)}:${values.tracking}` : null;
const settlementIdentity = (sourceId,values) => values.settlementExternalId || `fingerprint:${hash([sourceId,values.settlementReference || '',on(values.settlementDate),values.settlementGross ?? null,values.settlementNet ?? null,values.tracking || values.externalShipmentId || values.externalOrderId || null])}`;
function rowOrderKey(row,config) {
  const values = row.values;
  if (values.externalOrderId) return `order:${values.externalOrderId}`;
  if (values.internalOrderNumber) return `number:${values.internalOrderNumber}`;
  const guide = shipmentKey(values);
  if (guide) return `${config.oneOrderPerGuide ? 'guide-order' : 'unlinked'}:${guide}`;
  return `row:${rowKey(row.sheet,row.rowNumber)}`;
}
function groupRows(rows,config) {
  const parents = new Map(), unitParents = new Map();
  const find = (map,key) => {if (!map.has(key)) map.set(key,key);let value=key;while(map.get(value)!==value)value=map.get(value);return value;};
  const join = (map,a,b) => {a=find(map,a);b=find(map,b);if(a!==b)map.set(a<b?b:a,a<b?a:b);};
  const guideOrders = new Map(), internalNumbers = new Map();
  for (const row of rows) {
    row.orderKey=rowOrderKey(row,rowConfig(row,config));find(parents,row.orderKey);find(unitParents,row.orderKey);
    const guide=shipmentKey(row.values), number=row.values.internalOrderNumber;
    for(const [key,map] of [[guide,guideOrders],[number,internalNumbers]])if(key){if(map.has(key)){join(parents,row.orderKey,map.get(key));join(unitParents,row.orderKey,map.get(key));}else map.set(key,row.orderKey);}
  }
  const groups=new Map();
  for(const row of rows){
    const identity=row.orderKey,key=`group:${hash(find(parents,identity)).slice(0,40)}`;
    row.orderKey=find(unitParents,identity);
    const group=groups.get(key)||{kind:'commercial',key,sheet:row.sheet,rows:[],rowNumbers:[],rowRefs:[],identityKeys:[],errors:[],warnings:[],tasks:[],units:[],targets:[]};
    group.rows.push(row);group.rowRefs.push({sheet:row.sheet,rowNumber:row.rowNumber});group.rowNumbers.push(row.rowNumber);if(!group.identityKeys.includes(identity))group.identityKeys.push(identity);groups.set(key,group);
    for(const key of row.resolutionKeys || [])if(!group.identityKeys.includes(key))group.identityKeys.push(key);
  }
  return [...groups.values()];
}
function identityProjection(row){
  const values=row.values,config=row.config;
  if(config.purpose==='orders')return [on(values.placedOn),...['customerName','phone','city','address'].map(key=>values[key] ?? ''),row.lines.map(line=>[line.productExternalKey || '',line.quantity ?? null,line.unitPrice ?? null,line.lineDiscount ?? 0]).sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b)))];
  return [on(values.expenseDate),values.expenseCategory ?? '',values.expenseConcept ?? '',values.expenseSupplier ?? '',values.expenseReference ?? '',config.layout==='expense_columns'?row.expenseLines.map(line=>[normalizeImportFieldName(config.expenseGroupNames[line.group] || ''),line.expenseQuantity ?? null,line.expenseUnitCost ?? null]).sort((a,b)=>a[0].localeCompare(b[0])):[values.expenseAmount ?? null,values.expenseCampaign ?? '']];
}
async function prepareIdentities(tx,batch,rows,resolutions){
  const seen=new Map(),generatedOrders=(await tx.db.all(`SELECT external_key FROM ${tx.t('external_links')} WHERE source_id=? AND entity_type='order'`,[batch.sourceId])).some(row=>row.external_key.startsWith('excel-order:'));
  const importedExpenses=(await tx.db.all(`SELECT * FROM ${tx.t('expenses')} WHERE source_key LIKE 'excel-expense:%'`)).map(entity).filter(value=>value.sourceId===batch.sourceId && value.importIdentity?.generated),generatedExpenses=importedExpenses.length>0;
  for(const row of rows){
    const config=row.config;if(row.structuralOmission || !['orders','expenses'].includes(config.purpose))continue;
    const field=config.purpose==='orders'?'externalOrderId':'expenseExternalId';
    if(row.values[field] || row.values.internalOrderNumber)continue;
    const initialKey=`group:${hash(rowOrderKey(row,config)).slice(0,40)}`;
    row.resolutionKeys=[initialKey];
    const scope={key:initialKey,identityKeys:[rowOrderKey(row,config)],rowRefs:[{sheet:row.sheet,rowNumber:row.rowNumber}]},independent=findResolution(resolutions,'independent_record',scope,row),linked=config.purpose==='expenses'?findResolution(resolutions,'link_expense',scope,row):findResolution(resolutions,'link_order',scope,row);
    if(config.purpose==='orders' && linked && config.identityMode!=='generated'){row.values.externalOrderId=`excel-order:${hash([batch.sourceId,'linked',linked.internalId])}`;continue;}
    if(config.purpose==='orders' && config.oneOrderPerGuide && shipmentKey(row.values))continue;
    if(config.identityMode!=='generated'){row.errors.push({code:'IMPORT_IDENTITY_REQUIRED',message:'Indica un ID explícito o confirma la generación de identidad para una fila por operación.',sheet:row.sheet,rowNumber:row.rowNumber});continue;}
    const fingerprint=hash([batch.sourceId,config.purpose,canonicalJSON(identityProjection(row))]),key=`excel-${config.purpose==='orders'?'order':'expense'}:${independent?.value || fingerprint}`;
    row.generatedIdentity=true;row.identityFingerprint=fingerprint;
    row.values[field]=key;
    if(config.purpose==='orders')row.values.externalShipmentId ||= `excel-shipment:${hash([batch.sourceId,key])}`;
    if(config.purpose==='orders' && linked && !row.source.some((cell,index)=>config.columns.some(column=>column.index===index && column.destination==='externalShipmentId') && cell?.value)){
      const shipments=(await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=? AND source_id=?`,[linked.internalId,batch.sourceId])).map(entity).filter(shipment=>shipment.externalId?.startsWith('excel-shipment:') && !shipment.tracking);
      if(shipments.length===1)row.values.externalShipmentId=shipments[0].externalId;
      else if(shipments.length>1)row.errors.push({code:'IMPORT_SHIPMENT_LINK',message:'El pedido tiene varios envíos técnicos. Vincula el envío correcto explícitamente.',sheet:row.sheet,rowNumber:row.rowNumber});
    }
    if(linked && config.purpose==='expenses' && config.layout!=='expense_columns'){
      const expense=await byId(tx,'expenses',linked.internalId);
      if(!expense || expense.sourceId!==batch.sourceId || !expense.importIdentity || expense.category!==row.values.expenseCategory)row.errors.push({code:'IMPORT_EXPENSE_LINK',message:'Selecciona un gasto importado de esta fuente y categoría, con identidad conservada.'});
      else {row.values.expenseExternalId=expense.importIdentity.externalId;row.generatedIdentity=expense.importIdentity.generated;}
    }
    const existingExpenseId=config.layout==='expense_columns' && row.expenseLines.length?`group:${hash([key,normalizeImportFieldName(config.expenseGroupNames[row.expenseLines[0].group] || '')])}`:key;
    let exists=config.purpose==='orders'?await lookupLink(tx,batch.sourceId,'order',key):await tx.db.get(`SELECT id FROM ${tx.t('expenses')} WHERE source_key=?`,[`excel-expense:${hash([batch.sourceId,existingExpenseId])}`]);
    if(!exists && config.purpose==='expenses' && !independent && !linked){
      const values=row.values,base=importedExpenses.filter(expense=>expense.incurredOn===on(values.expenseDate) && expense.category===values.expenseCategory && expense.concept===(values.expenseConcept || '') && expense.supplier===(values.expenseSupplier || '') && (expense.reference || '')===(values.expenseReference || ''));
      if(config.layout==='expense_rows'){
        const matches=base.filter(expense=>expense.amountMinor===values.expenseAmount && (expense.campaign || '')===(values.expenseCampaign || ''));
        if(matches.length===1){row.values.expenseExternalId=matches[0].importIdentity.externalId;exists=matches[0];}
      }else{
        const matched={};let complete=true;
        for(const line of row.expenseLines){
          const campaign=config.expenseGroupNames[line.group],matches=base.filter(expense=>normalizeImportFieldName(expense.campaign)===normalizeImportFieldName(campaign) && expense.quantity===line.expenseQuantity && expense.unitCostMinor===line.expenseUnitCost);
          if(matches.length!==1){complete=false;break;}
          Object.defineProperty(matched,normalizeImportFieldName(campaign),{value:matches[0].importIdentity.externalId,enumerable:true});
        }
        if(complete && row.expenseLines.length){row.matchedExpenseIdentities=matched;exists=true;}
      }
    }
    if(!exists && !independent && !linked && (config.purpose==='orders'?generatedOrders:generatedExpenses))row.errors.push({code:'IMPORT_NEW_IDENTITY_REVIEW',message:'La fuente ya tiene identidades generadas. Confirma «Es nuevo» o vincula el registro existente.',sheet:row.sheet,rowNumber:row.rowNumber});
    if(seen.has(`${config.purpose}:${fingerprint}`) && !independent){
      const previous=seen.get(`${config.purpose}:${fingerprint}`);
      if(!findResolution(resolutions,'duplicate',scope,row)){row.errors.push({code:'IMPORT_DUPLICATE_IDENTITY',message:'Posible operación duplicada entre filas u hojas. Omite una o confirma que son independientes.',rowRefs:[previous,{sheet:row.sheet,rowNumber:row.rowNumber}]});}
    }else seen.set(`${config.purpose}:${fingerprint}`,{sheet:row.sheet,rowNumber:row.rowNumber});
  }
}
function expenseGroups(rows){
  const groups=new Map();
  for(const row of rows){
    const key=`expense-group:${hash(row.values.expenseExternalId || rowKey(row.sheet,row.rowNumber)).slice(0,40)}`;
    const group=groups.get(key)||{kind:'expenses',key,sheet:row.sheet,rowNumbers:[],rowRefs:[],rows:[],identityKeys:[],errors:[],warnings:[],tasks:[],units:[],expenses:[],targets:[],identities:[]};
    group.rows.push(row);group.rowNumbers.push(row.rowNumber);group.rowRefs.push({sheet:row.sheet,rowNumber:row.rowNumber});group.warnings.push(...row.warnings);groups.set(key,group);
  }
  return [...groups.values()];
}
async function prepareExpenseGroup(tx,batch,group,resolutions,appliedRows){
  group.resolutions=resolutions.filter(value=>applicable(value,group));
  if(group.rowRefs.some(ref=>appliedRows.has(rowKey(ref.sheet,ref.rowNumber)))){
    if(group.rowRefs.every(ref=>appliedRows.has(rowKey(ref.sheet,ref.rowNumber)))){group.state='applied';return group;}
    group.errors.push({code:'IMPORT_APPLIED_GROUP',message:'La nueva distribución mezcla filas aplicadas y pendientes.'});
  }
  if(findResolution(resolutions,'omit_group',group)){for(const row of group.rows)row.skipped=true;group.state='skipped';return group;}
  for(const row of group.rows)if(!row.auxiliary && (row.structuralOmission || findResolution(resolutions,'duplicate',group,row)))row.skipped=true;
  const active=group.rows.filter(row=>!row.auxiliary && !row.skipped),row=active[0];
  if(!row){group.state=group.errors.length?'rejected':'skipped';return group;}
  const config=row.config,values=row.values;
  for(const source of group.rows.filter(row=>!row.skipped)){
    source.errors=source.errors.filter(error=>error.code!=='IMPORT_FORMULA_ACCEPTANCE' || !findResolution(resolutions,'accept_formulas',group,source,error.field));
    group.errors.push(...source.errors);
  }
  for(const source of active.filter(source=>source!==row))if(hash({values:source.values,lines:source.expenseLines})!==hash({values:row.values,lines:row.expenseLines}))group.errors.push({code:'IMPORT_EXPENSE_CONFLICT',message:'El mismo ID de gasto contiene datos contradictorios.',rowRefs:rowRefs(active)});
  if(active.length>1)group.errors.push({code:'IMPORT_DUPLICATE_EXPENSE',message:'El mismo gasto aparece en varias filas u hojas. Confirma qué copia omitir; no se sumará dos veces.',rowRefs:rowRefs(active)});
  try{
    const category=choice(values.expenseCategory,['advertising','operating','other'],'Categoría del gasto'),incurredOn=businessDate(on(values.expenseDate),'Fecha del gasto'),concept=text(values.expenseConcept,'Concepto del gasto',500,true),sourceCut=sourceAsOf(values,config);
    if(!sourceCut)throw configurationError('Confirma la fecha de corte del archivo.','IMPORT_CUTOFF_REQUIRED',{sheet:row.sheet,rowNumber:row.rowNumber});
    const id=text(values.expenseExternalId,'ID del gasto',200,true),candidates=[];
    if(config.layout==='expense_columns'){
      let sum=0n;
      for(const line of row.expenseLines){
        const campaign=text(config.expenseGroupNames[line.group],'Nombre de campaña',200,true);
        if(line.expenseQuantity==null && line.expenseUnitCost==null)continue;
        if(line.expenseQuantity==null || line.expenseUnitCost==null)throw configurationError('Completa cantidad y costo unitario del grupo de campaña.','IMPORT_EXPENSE_OPERAND',{sheet:row.sheet,rowNumber:row.rowNumber,group:line.group});
        const minor=BigInt(line.expenseQuantity)*BigInt(line.expenseUnitCost);
        const amountMinor=moneyMinor(Number(minor),'Gasto de campaña');sum+=minor;
        candidates.push({externalId:`group:${hash([id,normalizeImportFieldName(campaign)])}`,campaign,amountMinor,quantity:line.expenseQuantity,unitCostMinor:line.expenseUnitCost,group:line.group});
      }
      if(values.expenseControlTotal!=null && BigInt(values.expenseControlTotal)!==sum)throw configurationError('El total de control no coincide con la suma exacta de las campañas.','IMPORT_EXPENSE_TOTAL',{sheet:row.sheet,rowNumber:row.rowNumber});
    }else {if(values.expenseAmount==null)fail('Completa el importe explícito del gasto.');candidates.push({externalId:id,campaign:values.expenseCampaign || '',amountMinor:moneyMinor(values.expenseAmount,'Importe del gasto')});}
    const authority=findResolution(resolutions,'review_authority',group,row),importedFields=prepareImportedFields(active,batch,config,group.errors,'expense');
    for(const candidate of candidates){
      const linked=config.layout==='expense_columns'?findResolution(resolutions,'link_expense',group,row,normalizeImportFieldName(candidate.campaign)):null;
      if(linked){
        const saved=await byId(tx,'expenses',linked.internalId);
        if(!saved || saved.sourceId!==batch.sourceId || !saved.importIdentity || saved.category!==category)fail('Vincula un gasto importado de esta fuente y categoría.');
        candidate.externalId=saved.importIdentity.externalId;row.generatedIdentity=saved.importIdentity.generated;
      }
      if(row.matchedExpenseIdentities?.[normalizeImportFieldName(candidate.campaign)])candidate.externalId=row.matchedExpenseIdentities[normalizeImportFieldName(candidate.campaign)];
      const sourceKey=`excel-expense:${hash([batch.sourceId,candidate.externalId])}`,existing=entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[sourceKey]));
      const observationRows=(group.auxiliaryRows || []).filter(row=>row.values.observationScope==='expense' && row.values.observationEntityId===candidate.externalId);
      const quantityFields=EXPENSE_QUANTITY_OBSERVATIONS.filter(field=>candidate[field.property]!=null).map(field=>{
        const column=config.columns.find(column=>column.destination===field.destination && column.group===candidate.group);
        return {key:field.key,label:field.label,valueType:field.valueType,value:candidate[field.property],sourceId:batch.sourceId,sourceAsOf:sourceCut,batchId:batch.id,sheet:row.sheet,rowNumbers:[row.rowNumber],columnIndex:column.index,header:column.header};
      });
      const candidateFields=combineImportedFields([...importedFields,...quantityFields,...observationRows.map(row=>observationField(row,batch))],'expense',group.errors);
      const generated=existing?.importIdentity?.generated ?? !!row.generatedIdentity;
      const input={category,concept,incurredOn,amountMinor:candidate.amountMinor,supplier:values.expenseSupplier || '',reference:values.expenseReference || '',notes:values.expenseNotes || '',campaign:candidate.campaign,sourceKey,source:'excel',sourceId:batch.sourceId,sourceAsOf:sourceCut,importIdentity:{externalId:candidate.externalId,generated},importedFields:candidateFields,...(candidate.quantity!=null?{quantity:candidate.quantity,unitCostMinor:candidate.unitCostMinor}:{})};
      for(const field of EXPENSE_QUANTITY_OBSERVATIONS){
        const observation=candidateFields.find(observation=>observation.key===field.key && observation.valueType===field.valueType);
        if(observation)input[field.property]=observation.value;
      }
      if(existing && (existing.category!==category || existing.orderId || existing.personId || existing.shipmentId))group.errors.push({code:'IMPORT_EXPENSE_IDENTITY',message:'La identidad del gasto existente no admite cambiar categoría ni vínculos.'});
      const ignored=existing?.sourceId===batch.sourceId && existing.sourceAsOf && sourceCut<existing.sourceAsOf;
      const same=existing && ['category','concept','incurredOn','amountMinor','supplier','reference','notes','campaign','sourceId'].every(key=>(existing[key] ?? '')===(input[key] ?? ''));
      if(ignored)group.warnings.push({code:'IMPORT_OLD_EXPENSE',message:'Se conserva el gasto vigente; el archivo tiene un corte anterior.'});
      if(existing && !ignored && (!same || existing.source!=='excel' || existing.sourceId!==batch.sourceId) && !authority)group.errors.push({code:'IMPORT_EXPENSE_AUTHORITY',message:'El gasto tiene datos discrepantes. Confirma la corrección y su motivo.'});
      const previousFields=existing?.importedFields || [];
      // A layout can make implicit values explicit without changing the expense or its provenance.
      const informativeFields=existing?candidateFields.filter(field=>{
        const property=EXPENSE_INFORMATION_PROPERTIES.get(field.key);
        return !property || field.sourceId!==existing.sourceId || field.value!==existing[property] || previousFields.some(previous=>previous.key===field.key && previous.sourceId===field.sourceId);
      }):candidateFields;
      const merged=mergeImportedFields(previousFields,informativeFields,{scope:'expense',reviewConfirmed:!!authority});
      const sameInformativeContent=existing && merged.fields.length===previousFields.length && merged.fields.every(field=>previousFields.some(previous=>previous.key===field.key && previous.sourceId===field.sourceId && hash(previous.value)===hash(field.value) && (previous.valueType || 'text')===(field.valueType || 'text')));
      input.importedFields=sameInformativeContent?previousFields:merged.fields;
      const metadataChanged=existing && (hash(input.importedFields)!==hash(previousFields) || EXPENSE_QUANTITY_OBSERVATIONS.some(field=>Object.hasOwn(input,field.property) && input[field.property]!==existing[field.property]));
      if(existing && !ignored && metadataChanged && !authority)group.errors.push({code:'IMPORT_EXPENSE_AUTHORITY',message:'Los datos informativos del gasto difieren. Confirma la revisión con motivo.',rowRefs:rowRefs(active)});
      group.errors.push(...merged.conflicts);group.warnings.push(...merged.warnings);
      group.expenses.push({externalId:candidate.externalId,generated,sourceKey,existingId:existing?.id || null,version:existing?.version || null,input,unchanged:!!ignored || !!same && existing.sourceAsOf===sourceCut && !metadataChanged,rowRefs:rowRefs(active)});
      group.identities.push({type:'expense_source',key:sourceKey,internalId:existing?.id || null,version:existing?.version || null});
      if(existing)group.targets.push({table:'expenses',id:existing.id,version:existing.version});
    }
    const source=await requireSource(tx,batch.sourceId);
    for(const [table,id] of [['platform_sources',batch.sourceId],['platforms',source.platformId]])group.targets.push({table,id,version:(await rawById(tx,table,id)).version});
  }catch(error){if(!error.status || error.status>=500)throw error;group.errors.push(errorRecord(error,{sheet:row.sheet,rowNumber:row.rowNumber}));}
  group.state=group.errors.length?'rejected':!group.expenses.length?'skipped':group.expenses.every(expense=>expense.unchanged)?'unchanged':group.expenses.some(expense=>expense.existingId)?'updated':'new';
  return group;
}
function attachAuxiliaryRows(groups,rows){
  for(const row of rows){
    row.auxiliary=true;
    const value=row.values,candidates=groups.filter(group=>{
      if(value.externalOrderId)return group.kind==='commercial' && group.rows.some(source=>source.values.externalOrderId===value.externalOrderId);
      if(value.observationScope==='order')return group.kind==='commercial' && group.rows.some(source=>source.values.externalOrderId===value.observationEntityId);
      if(value.observationScope==='shipment')return group.kind==='commercial' && group.rows.some(source=>source.values.externalShipmentId===value.observationEntityId);
      if(value.observationScope==='expense')return group.kind==='expenses' && group.rows.some(source=>source.values.expenseExternalId===value.observationEntityId || source.config.layout==='expense_columns' && source.expenseLines.some(line=>`group:${hash([source.values.expenseExternalId,normalizeImportFieldName(source.config.expenseGroupNames[line.group] || '')])}`===value.observationEntityId));
      return false;
    });
    if(candidates.length===1){const group=candidates[0];group.rows.push(row);group.rowRefs.push({sheet:row.sheet,rowNumber:row.rowNumber});group.rowNumbers.push(row.rowNumber);(group.auxiliaryRows ||= []).push(row);}
    else{
      const error={code:'IMPORT_RELATION_REFERENCE',message:'La información acompañante necesita una referencia única a un pedido, envío o gasto seleccionado.',sheet:row.sheet,rowNumber:row.rowNumber};
      groups.push({kind:'commercial',key:`relation:${hash(rowKey(row.sheet,row.rowNumber))}`,sheet:row.sheet,rowNumbers:[row.rowNumber],rowRefs:rowRefs([row]),rows:[row],auxiliaryRows:[row],units:[],identityKeys:[],errors:[error],warnings:[],tasks:[],targets:[],identities:[],resolutions:[],state:'rejected'});
    }
  }
}
function observationField(row,batch){
  const values=row.values,scope=choice(values.observationScope,['order','shipment','expense'],'Ámbito'),key=text(values.observationKey,'Clave',200,true),label=text(values.observationLabel,'Etiqueta',200,true),valueType=choice(values.observationValueType,['text','integer','money_minor','date','boolean'],'Tipo de observación');
  let value=values.observationValue;
  if(value==null)fail('La observación necesita un valor explícito.');
  if(valueType==='integer' || valueType==='money_minor'){
    if(!/^-?\d+$/.test(String(value)))fail('La observación necesita un entero.');
    value=valueType==='money_minor'?moneyMinor(Number(value),'Observación monetaria'):integer(Number(value),'Observación entera',0,1000000);
  }else if(valueType==='date')value=businessDate(String(value));
  else if(valueType==='boolean'){if(!['true','false',true,false].includes(value))fail('La observación booleana debe ser true o false.');value=value===true || value==='true';}
  else value=text(String(value),'Observación',4000,true);
  const originKeys=['observationOriginSheet','observationOriginRow','observationOriginColumn','observationOriginHeader'],hasOrigin=originKeys.some(key=>values[key]!=null);
  const declaredOrigin=hasOrigin?{sheet:exactSheetName(values.observationOriginSheet),rowNumber:integer(values.observationOriginRow,'Fila declarada',1,10001),columnIndex:integer(values.observationOriginColumn,'Columna declarada',1,200)-1,header:text(values.observationOriginHeader,'Encabezado declarado',500)}:null;
  const column=row.config.columns.find(column=>column.destination==='observationValue');
  return validateImportedFields([{key,label,value,valueType,sourceId:batch.sourceId,batchId:batch.id,sourceAsOf:sourceAsOf(values,row.config),sheet:row.sheet,rowNumbers:[row.rowNumber],columnIndex:column.index,header:column.header,...(declaredOrigin?{declaredOrigin}:{})}],scope)[0];
}
async function prepareAuxiliary(tx,batch,group,values,orderItems,shipments,resolutions){
  const orderFields=[],costs=new Map(),allocations=new Map(),seen=new Map();
  for(const row of group.auxiliaryRows || []){
    const source=row.values;
    if(source.externalOrderId && source.externalOrderId!==values.externalOrderId)continue;
    try{
      if(row.errors.length){group.errors.push(...row.errors);continue;}
      if(row.config.purpose==='observations'){
        const field=observationField(row,batch);
        if(source.observationScope==='order'){if(source.observationEntityId!==values.externalOrderId)continue;orderFields.push(field);}
        else if(source.observationScope==='shipment'){
          const target=shipments.find(shipment=>shipment.values.externalShipmentId===source.observationEntityId);
          if(!target)fail('La observación no corresponde a un envío del pedido.');
          target.importedFields=combineImportedFields([...target.importedFields,field],'shipment',group.errors);
        }
      }else{
        const line=orderItems.find(line=>line.externalLineId===source.externalLineId);
        if(!line)fail('La relación no corresponde a una línea externa de este pedido.');
        if(row.config.purpose==='allocations'){
          const shipment=shipments.find(shipment=>shipment.values.externalShipmentId===source.externalShipmentId);
          if(!shipment)fail('La asignación no corresponde a un envío del pedido.');
          const quantity=integer(source.allocationQuantity,'Cantidad asignada',1,999),key=JSON.stringify([values.externalOrderId,source.externalShipmentId,source.externalLineId]);
          if(seen.has(key) && seen.get(key)!==quantity)fail('La misma relación repite cantidades contradictorias.',409);
          seen.set(key,quantity);
          const list=allocations.get(shipment.key)||new Map();list.set(line.lineId,{lineId:line.lineId,quantity});allocations.set(shipment.key,list);
        }else{
          const productId=await alias(tx,batch,resolutions,'product',source.componentProductExternalKey,group,row) || (await tx.get('products',source.componentProductExternalKey))?.id;
          if(!productId)fail('Vincula la referencia real del componente.');
          const product=await tx.get(line.kind,line.itemId),composition=line.components?.length?line.components:product?.items;
          if(!composition?.some(component=>component.productId===productId))fail('El componente no pertenece a la composición de esta línea.');
          const minor=moneyMinor(source.componentUnitCost,'Costo unitario del componente'),key=JSON.stringify([line.lineId,productId]);
          if(seen.has(key) && seen.get(key)!==minor)fail('El costo del mismo componente es contradictorio.',409);
          seen.set(key,minor);
          const value=costs.get(line.lineId)||{lineId:line.lineId,unitCostMinor:null,components:[]};
          if(!value.components.some(component=>component.productId===productId))value.components.push({productId,unitCostMinor:minor});costs.set(line.lineId,value);
        }
      }
    }catch(error){if(!error.status || error.status>=500)throw error;group.errors.push(errorRecord(error,{sheet:row.sheet,rowNumber:row.rowNumber}));}
  }
  for(const cost of costs.values()){
    const line=orderItems.find(line=>line.lineId===cost.lineId),product=await tx.get(line.kind,line.itemId),composition=line.components?.length?line.components:product?.items || [];
    if(cost.components.length!==composition.length)group.errors.push({code:'IMPORT_COMPONENT_COSTS',message:'Completa el costo de todos los componentes reales de la línea.'});
    else cost.unitCostMinor=moneyMinor(Number(composition.reduce((sum,component)=>sum+BigInt(component.quantity)*BigInt(cost.components.find(value=>value.productId===component.productId).unitCostMinor),0n)),'Costo compuesto');
  }
  return {orderFields,costs:[...costs.values()],allocations:new Map([...allocations].map(([key,values])=>[key,[...values.values()]]))};
}
async function prepareInventoryPreview(tx,batch,groups){
  const projections=[],owners=[];
  for(const group of groups)for(const unit of group.units || []){
    if(group.errors.length || ['skipped','applied'].includes(group.state) || !unit.previewOrder && !unit.orderId)continue;
    try{
      const order=unit.orderId?await loadOrderData(tx,unit.orderId):structuredClone(unit.previewOrder),previous=order.inventory || null;
      const shipments=unit.orderId?(await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[unit.orderId])).map(entity):[],events=new Map(),classifications=[];
      for(const shipment of shipments)events.set(shipment.id,(await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=?`,[shipment.id])).map(entity));
      for(const observed of unit.shipments){
        let shipment=shipments.find(shipment=>shipment.id===observed.existingId);
        if(!shipment){shipment={id:observed.existingId || `preview:${observed.key}`,status:'label_created',assignments:observed.assignments || order.items.map(line=>({lineId:line.lineId,quantity:line.quantity}))};shipments.push(shipment);}
        if(observed.assignments)shipment.assignments=observed.assignments;
        const history=events.get(shipment.id)||[];
        for(const event of observed.events.filter(event=>!event.observationOnly)){
          const same=matchingShipmentEvent(history,event);
          const authority=findResolution(group.resolutions,'review_authority',group,event.rowRefs?.[0] || observed.rowRefs[0]);
          const prepared={...event,id:same?.id || `preview:${event.observationKey}`,shipmentId:shipment.id,correctionOf:authority?.value.correctionOf || null};
          if(!same)history.push(prepared);
          if(typeof event.inventoryOpeningIncluded==='boolean')classifications.push({eventId:prepared.id,included:event.inventoryOpeningIncluded,confirmedBy:batch.createdBy || 'import',confirmedAt:batch.updatedAt || batch.createdAt,reason:event.openingReason});
        }
        events.set(shipment.id,history);
      }
      if(!unit.orderId && batch.inventoryOpening)order.inventoryOpening={on:batch.inventoryOpening.on,sourceId:batch.sourceId,batchId:batch.id,confirmedBy:batch.createdBy || 'import',confirmedAt:batch.updatedAt || batch.createdAt,eventClassifications:classifications,returnClassifications:[]};
      const returns=unit.orderId?(await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`,[unit.orderId])).map(entity):[];
      const next=inventoryState(order,shipments,events,returns);projections.push({previous,next});owners.push(group);
    }catch(error){if(!error.status || error.status>=500)throw error;group.errors.push(errorRecord(error,{rowRefs:group.rowRefs}));group.state='rejected';}
  }
  const products=(await tx.db.all(`SELECT * FROM ${tx.t('records')} WHERE kind='products'`)).map(entity),effects=previewInventoryChanges(projections,products);
  for(let index=0;index<projections.length;index++){
    const group=owners[index];group.inventory=previewInventoryChanges([projections[index]],products);
    const ids=new Set(group.inventory.map(effect=>effect.productId));
    for(const effect of effects.filter(effect=>effect.issue && ids.has(effect.productId)))group.errors.push({code:'IMPORT_INVENTORY',message:effect.issue,productId:effect.productId,rowRefs:group.rowRefs});
    if(group.errors.length && !['applied','skipped'].includes(group.state))group.state='rejected';
  }
  return effects;
}
async function lookupLink(tx,sourceId,type,key) {
  if (!key) return null;
  return entity(await tx.db.get(`SELECT * FROM ${tx.t('external_links')} WHERE source_id=? AND entity_type=? AND external_key=?`,[sourceId,type,key]));
}
async function alias(tx,batch,resolutions,type,key,group,row = null) {
  const resolution = findResolution(resolutions,`link_${type}`,group,row,key);
  const saved = await lookupLink(tx,batch.sourceId,type,key);
  if (saved && resolution && saved.internalId !== resolution.internalId) fail(`El alias ${key} ya apunta a otro registro. Revisa el vínculo existente.`,409);
  return resolution?.internalId || saved?.internalId || null;
}
function repeated(rows,fields,errors,label) {
  const result = {};
  for (const field of fields) {
    const values = new Map(rows.filter(row => row.values[field] != null).map(row => [canonicalJSON(row.values[field]),row.values[field]]));
    if (values.size > 1) errors.push({code:'IMPORT_REPEATED_FIELD',message:`${label}: ${field} tiene valores contradictorios; no se sumará ni se elegirá uno.`,field,rowRefs:rows.filter(row=>row.values[field]!=null).flatMap(row=>row.rowRefs || (row.sheet?[{sheet:row.sheet,rowNumber:row.rowNumber}]:[]))});
    else if (values.size) result[field] = values.values().next().value;
  }
  return result;
}
function prepareImportedFields(rows,batch,config,errors,scope='shipment') {
  const fields = new Map();
  for(const row of rows)for(const value of [...(row.information || []).filter(value=>scope==='shipment'?OBSERVED_FIELDS.has(value.key):FIELD_DEFINITIONS.get(value.key)?.scope===scope && (scope!=='order' || rowConfig(row,config).purpose==='orders')),...(row.values[`${scope}AdditionalFields`] || (scope==='shipment'?row.values.additionalFields:[]) || [])]){
    const previous=fields.get(value.key);
    if(previous){
      if(hash(previous.value)!==hash(value.value))errors.push({code:'IMPORT_REPEATED_FIELD',message:`El campo «${value.label}» tiene valores contradictorios.`,field:value.key,rowRefs:[{sheet:previous.sheet,rowNumber:previous.rowNumbers[0]},{sheet:row.sheet,rowNumber:row.rowNumber}]});
      else if(previous.sheet===row.sheet && !previous.rowNumbers.includes(row.rowNumber))previous.rowNumbers.push(row.rowNumber);
    }else fields.set(value.key,{...value,sourceId:batch.sourceId,sourceAsOf:sourceAsOf(row.values,rowConfig(row,config)),batchId:batch.id,sheet:row.sheet,rowNumbers:[row.rowNumber]});
  }
  return validateImportedFields([...fields.values()],scope);
}
function matchingShipmentEvent(history,event){
  const exact=history.find(previous=>previous.externalKey && previous.externalKey===event.externalKey);
  if(exact || event.explicitExternalKey)return exact || null;
  const candidates=event.occurredAt || event.occurredOn?history:[effectiveShipmentEvents(history).at(-1)].filter(Boolean);
  return candidates.find(previous=>['status','occurredAt','occurredOn','rawStatus','detail'].every(key=>(previous[key] || null)===(event[key] || null))) || null;
}
function combineImportedFields(fields,scope,errors){
  const result=new Map();
  for(const field of fields){
    const key=JSON.stringify([field.sourceId,field.key]),previous=result.get(key);
    if(!previous)result.set(key,field);
    else if(hash(previous.value)!==hash(field.value) || previous.valueType && field.valueType && previous.valueType!==field.valueType)errors.push({code:'IMPORT_REPEATED_FIELD',message:`La observación «${field.label}» tiene valores contradictorios.`,field:field.key,rowRefs:[{sheet:previous.sheet,rowNumber:previous.rowNumbers[0]},{sheet:field.sheet,rowNumber:field.rowNumbers[0]}]});
  }
  return validateImportedFields([...result.values()],scope);
}
async function findShipment(tx,sourceId,values,resolutions,group,row = null) {
  const external = values.externalShipmentId || shipmentKey(values);
  const explicit = findResolution(resolutions,'link_shipment',group,row,external);
  const link = await lookupLink(tx,sourceId,'shipment',external);
  const candidates = new Map();
  if (explicit) {const shipment = await byId(tx,'shipments',explicit.internalId);if (!shipment) fail('Envío a vincular no encontrado.',404);candidates.set(shipment.id,shipment);}
  if (link) {const shipment = await byId(tx,'shipments',link.internalId);if (!shipment) fail('El vínculo de guía apunta a un envío inexistente.',409);candidates.set(shipment.id,shipment);}
  if (values.externalShipmentId) {
    const matches = await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE source_id=? AND external_id=?`,[sourceId,values.externalShipmentId]);
    for (const match of matches) candidates.set(match.id,entity(match));
  }
  if (values.tracking) {
    const matches = (await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE tracking=?`,[values.tracking])).map(entity).filter(shipment => normalizeHeader(shipment.carrier) === normalizeHeader(values.carrier));
    for (const shipment of matches) {
      if (shipment.sourceId === sourceId || explicit?.internalId === shipment.id || link?.internalId === shipment.id) candidates.set(shipment.id,shipment);
      else fail('La guía ya pertenece a otra cuenta o plataforma. Vincula el envío explícitamente; no se duplicará.',409);
    }
  }
  if (candidates.size > 1) fail('Las identidades externas señalan envíos diferentes.',409);
  return candidates.values().next().value || null;
}
async function resolveOrder(tx,batch,values,shipments,resolutions,group) {
  const ids = new Set();
  const explicit = findResolution(resolutions,'link_order',group,null,values.externalOrderId);
  if (explicit) ids.add(explicit.internalId);
  const link = await lookupLink(tx,batch.sourceId,'order',values.externalOrderId);
  if (link) ids.add(link.internalId);
  if (values.internalOrderNumber) {
    const match = /^(?:AN[-\s]?)?0*([1-9]\d*)$/i.exec(values.internalOrderNumber);
    if (!match || !Number.isSafeInteger(Number(match[1]))) fail('Indica un número interno AN explícito y válido.');
    const row = await tx.db.get(`SELECT id FROM ${tx.t('orders')} WHERE number=?`,[Number(match[1])]);
    if (!row) fail('El número interno no corresponde a un pedido.',404);
    ids.add(row.id);
  }
  for (const shipment of shipments) if (shipment.existing?.orderId) ids.add(shipment.existing.orderId);
  if (ids.size > 1) fail('El ID de pedido y las guías apuntan a pedidos diferentes.',409);
  if (!ids.size) return null;
  const order = await loadOrderData(tx,[...ids][0]);
  if (!order) fail('Pedido a vincular no encontrado.',404);
  return order;
}
async function buildLines(tx,batch,rows,resolutions,group,errors) {
  const result = new Map(); let incomplete = false;
  for (const row of rows) for (const line of row.lines) {
    if (!line.productExternalKey) {errors.push({code:'IMPORT_PRODUCT_REQUIRED',message:'La línea necesita un producto real vinculado.',rowNumber:row.rowNumber});continue;}
    const internalId = await alias(tx,batch,resolutions,'product',line.productExternalKey,group,row);
    if (!internalId) {errors.push({code:'IMPORT_PRODUCT_LINK',message:`Vincula el producto ${line.productExternalKey}.`,rowNumber:row.rowNumber,externalKey:line.productExternalKey});continue;}
    const record = await rawById(tx,'records',internalId);
    if (!record || !['products','combos'].includes(record.kind)) {errors.push({code:'IMPORT_PRODUCT_LINK',message:'El alias debe apuntar a un producto o combo real.',rowNumber:row.rowNumber});continue;}
    if (line.giftOnly && (record.kind!=='products' || JSON.parse(record.data).productType!=='gift')) {errors.push({code:'IMPORT_GIFT_LINK',message:`${line.productExternalKey} debe vincularse a un obsequio con componentes, no a un producto con precio ni a un combo.`,sheet:row.sheet,rowNumber:row.rowNumber,externalKey:line.productExternalKey});continue;}
    if (line.giftOnly && line.quantity == null) {incomplete=true;errors.push({code:'IMPORT_GIFT_QUANTITY',message:`Confirma la cantidad de ${line.productExternalKey} en su columna o como cantidad fija de obsequios para esta hoja.`,sheet:row.sheet,rowNumber:row.rowNumber,externalKey:line.productExternalKey});continue;}
    if (line.quantity == null || line.unitPrice == null) {incomplete=true;group.tasks.push({type:'complete_lines',message:'Completa cantidad y precio explícitos; no se tomará el precio del catálogo.',rowNumbers:[row.rowNumber]});continue;}
    const key = line.externalLineId ? `external:${line.externalLineId}` : hash([internalId,line.unitPrice,line.lineDiscount || 0]);
    const externalLineId=line.externalLineId || `excel-line:${hash([batch.sourceId,group.key,key]).slice(0,40)}`;
    const candidate = {lineId:`excel-${hash([batch.sourceId,group.key,key]).slice(0,32)}`,kind:record.kind,itemId:internalId,title:record.title,presentation:JSON.parse(record.data).presentation || '',quantity:line.quantity,unitPriceMinor:line.unitPrice,discountMinor:line.lineDiscount || 0,externalLineId,productExternalKey:line.productExternalKey,orderUnitCostMinor:line.orderUnitCost ?? null,rowRefs:[{sheet:row.sheet,rowNumber:row.rowNumber}],rowNumbers:[row.rowNumber],allocations:[{sheet:row.sheet,rowNumber:row.rowNumber,quantity:line.quantity}]};
    const old = result.get(key);
    if (old && line.externalLineId && !findResolution(resolutions,'additional_quantity',group,row)) {
      if (['kind','itemId','quantity','unitPriceMinor','discountMinor','orderUnitCostMinor'].some(field => old[field] !== candidate[field])) errors.push({code:'IMPORT_LINE_CONFLICT',message:'Una misma línea externa tiene cantidades, precios o costos diferentes.',sheet:row.sheet,rowNumber:row.rowNumber});
      else {old.rowNumbers.push(row.rowNumber);old.allocations.push(...candidate.allocations);}
    } else if (old) {
      if(old.orderUnitCostMinor!==candidate.orderUnitCostMinor){errors.push({code:'IMPORT_LINE_COST_CONFLICT',message:'Líneas sin ID explícito tienen costos distintos. Confirma identidades de línea antes de agrupar.',rowRefs:[...old.rowRefs,...candidate.rowRefs]});continue;}
      old.quantity = integer(old.quantity+candidate.quantity,'Cantidad agrupada',1,999);old.discountMinor = moneyMinor(old.discountMinor+candidate.discountMinor);old.rowNumbers.push(row.rowNumber);old.rowRefs.push(...candidate.rowRefs);old.allocations.push(...candidate.allocations);
    }
    else result.set(key,candidate);
  }
  return incomplete ? [] : [...result.values()];
}
function sourceAsOf(values,config) { return values.reportAsOf ? values.reportAsOf.occurredAt || cutoff(values.reportAsOf.occurredOn) : cutoff(config.reportAsOf); }
function shipmentEvents(values,config,resolutions,group,row) {
  const events = [];
  for (const [field,status] of [['labelCreatedAt','label_created'],['collectedAt','collected'],['deliveredAt','delivered'],['returnAt','returned']]) if (values[field]) events.push({status,occurredAt:values[field].occurredAt || null,occurredOn:values[field].occurredOn || null,sourceAsOf:sourceAsOf(values,config),rawStatus:values.rawStatus || '',detail:values.eventDetail || '',externalKey:null});
  if (values.rawStatus != null || values.eventAt) {
    const selected = findResolution(resolutions,'status',group,row);
    const status = selected?.value || (Object.hasOwn(config.statusMap,values.rawStatus) ? config.statusMap[values.rawStatus] : 'unknown');
    if(values.eventAt || !events.some(event=>event.status===status))events.push({status,occurredAt:values.eventAt?.occurredAt || null,occurredOn:values.eventAt?.occurredOn || null,sourceAsOf:sourceAsOf(values,config),rawStatus:values.rawStatus || '',detail:values.eventDetail || '',externalKey:values.externalEventId || null});
  }
  return events;
}
// Inventory changes between groups are expected; only a catalog-content change invalidates review.
function targetRevision(table,row) {
  if (!row) return null;
  if (table !== 'records' || row.kind !== 'products') return row.version ?? null;
  return hash(Object.fromEntries(Object.entries(JSON.parse(row.data)).filter(([key]) => !['stockQuantity','stockReserved','stockAvailable','availability'].includes(key))));
}
async function captureTargets(tx,batch,group) {
  const targets = [], costIdentities = [], seen = new Set();
  const add = async (table,id) => {if (!id || seen.has(`${table}:${id}`)) return;seen.add(`${table}:${id}`);const row = await rawById(tx,table,id);targets.push({table,id,version:targetRevision(table,row)});};
  const addCost = async (productId,on) => {
    if(!on || costIdentities.some(identity=>identity.productId===productId && identity.on===on))return;
    const row=await tx.db.get(`SELECT id,version FROM ${tx.t('product_costs')} WHERE product_id=? AND effective_on<=? ORDER BY effective_on DESC LIMIT 1`,[productId,on]);
    if(row)await add('product_costs',row.id);
    costIdentities.push({type:'cost',productId,on,id:row?.id || null,version:row?.version || null});
  };
  await add('platform_sources',batch.sourceId);
  const source = await requireSource(tx,batch.sourceId);await add('platforms',source.platformId);
  await add('business_settings',1);
  if (batch.profileId) await add('import_profiles',batch.profileId);
  for (const unit of group.units) {
    await add('orders',unit.orderId);await add('people',unit.input?.sellerId);
    for (const line of unit.input?.items || []) {
      await add('records',line.itemId);
      if(line.kind==='products')await addCost(line.itemId,unit.input.placedOn);
      const product=await tx.get(line.kind,line.itemId);
      for(const component of product?.items || []){await add('records',component.productId);await addCost(component.productId,unit.input.placedOn);}
    }
    for (const shipment of unit.shipments) {
      await add('shipments',shipment.existingId);
      if (shipment.existingId) for (const expense of await tx.db.all(`SELECT id FROM ${tx.t('expenses')} WHERE shipment_id=?`,[shipment.existingId])) await add('expenses',expense.id);
    }
  }
  for (const resolution of group.resolutions || []) {
    if (resolution.action === 'link_product') await add('records',resolution.internalId);
    if (resolution.action === 'link_person') await add('people',resolution.internalId);
  }
  for (const values of group.rows.map(row => row.values)) if (values.settlementExternalId || values.settlementNet!=null || values.settlementGross!=null) {
    const key=settlementIdentity(batch.sourceId,values), row=await tx.db.get(`SELECT id FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,key])]);
    if(row)await add('settlements',row.id);
    if(!costIdentities.some(identity=>identity.type==='settlement_document' && identity.key===key))costIdentities.push({type:'settlement_document',key,internalId:row?.id || null});
  }
  // Include absent identities too: a concurrently created alias/guide is a race,
  // not permission to silently switch the accepted destination.
  const identities = [];
  for (const unit of group.units) {
    const key = unit.values.externalOrderId;
    if (key) identities.push({type:'order',key,internalId:(await lookupLink(tx,batch.sourceId,'order',key))?.internalId || null});
    for (const shipment of unit.shipments) {
      const key = shipment.values.externalShipmentId || shipmentKey(shipment.values);
      if (key) identities.push({type:'shipment',key,internalId:(await lookupLink(tx,batch.sourceId,'shipment',key))?.internalId || null});
      const matches = shipment.values.tracking ? (await tx.db.all(`SELECT id,carrier,version FROM ${tx.t('shipments')} WHERE tracking=?`,[shipment.values.tracking])).filter(row => normalizeHeader(row.carrier) === normalizeHeader(shipment.values.carrier)) : [];
      identities.push({type:'guide',key:shipment.values.tracking || '',carrier:normalizeHeader(shipment.values.carrier),matches:matches.map(row => ({id:row.id,version:row.version})).sort((a,b)=>a.id.localeCompare(b.id))});
    }
  }
  for (const resolution of group.resolutions || []) if (['link_product','link_person'].includes(resolution.action)) identities.push({type:resolution.action.slice(5),key:resolution.externalKey,internalId:(await lookupLink(tx,batch.sourceId,resolution.action.slice(5),resolution.externalKey))?.internalId || null});
  return {targets,identities:[...identities,...costIdentities]};
}
async function groupHasChanges(tx,batch,group) {
  for (const resolution of group.resolutions) {
    if (resolution.action==='review_authority' || resolution.action==='commercial_update') return true;
    if (['link_product','link_person'].includes(resolution.action) && !await lookupLink(tx,batch.sourceId,resolution.action.slice(5),resolution.externalKey)) return true;
  }
  for (const unit of group.units) {
    if (unit.input || unit.policy || unit.informationChanged || unit.lineCosts?.some(cost=>{const line=unit.order?.items.find(line=>line.lineId===cost.lineId);return line && (line.unitCostMinor!==cost.unitCostMinor || cost.components?.some(component=>line.components.find(previous=>previous.productId===component.productId)?.unitCostMinor!==component.unitCostMinor));})) return true;
    if (unit.values.externalOrderId && !await lookupLink(tx,batch.sourceId,'order',unit.values.externalOrderId)) return true;
    for (const observed of unit.shipments) {
      if (!observed.existingId) return true;
      const shipment=await refreshShipment(tx,observed.existingId), values=observed.values;
      if (unit.orderId && !shipment.orderId) return true;
      if ((values.externalShipmentId || shipmentKey(values)) && !await lookupLink(tx,batch.sourceId,'shipment',values.externalShipmentId || shipmentKey(values))) return true;
      if (['carrier','tracking'].some(field=>values[field] && values[field]!==shipment[field]) || values.estimatedDeliveryOn && on(values.estimatedDeliveryOn)!==shipment.estimatedDeliveryOn) return true;
      if (mergeImportedFields(shipment.importedFields || [],observed.importedFields || [],{scope:'shipment',reviewConfirmed:!!findResolution(group.resolutions,'review_authority',group,observed.rowRefs[0])}).changed) return true;
      for (const event of observed.events) {
        const same=shipment.events.some(previous=>['status','occurredAt','occurredOn','rawStatus','detail'].every(field=>(previous[field] || null)===(event[field] || null)) && (event.occurredAt || event.occurredOn || previous.sourceAsOf===event.sourceAsOf));
        if (!same) return true;
      }
      for (const [field,dateField,category] of IMPORT_COST_FIELDS) if (costIsObserved(observed,field)) {
        const old=entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.id}:${category}`]));
        if (values[field] == null && old) continue;
        const previous=old || shipment.costObservations?.[category];
        const chargeOn=importCostChargeOn(values,field,dateField,old);
        if (!previous || (!previous.sourceAsOf || observed.sourceAsOf>=previous.sourceAsOf) && (previous.amountMinor!==(values[field] ?? null) || previous.chargeOn!==chargeOn || previous.sourceAsOf!==observed.sourceAsOf || previous.source!=='excel' || previous.sourceId!==batch.sourceId)) return true;
      }
      for (const financial of observed.financial) {
        const values=financial.values;
        if(values.collectedAmount!=null) {
          if(collectionIsEvent(values)) {
            const reference=values.collectionReference || values.collectionExternalId;
            const key=values.collectionExternalId || `fingerprint:${hash([batch.sourceId,reference,on(values.collectionDate),values.collectedAmount,values.tracking || values.externalShipmentId || shipment.id])}`;
            if(!await tx.db.get(`SELECT id FROM ${tx.t('order_collections')} WHERE external_key=?`,[`collection:${hash([batch.sourceId,key])}`]))return true;
          } else {
            const prior=shipment.collectionObservations?.[batch.sourceId];
            if(!prior || financial.sourceAsOf>prior.sourceAsOf || financial.sourceAsOf===prior.sourceAsOf && values.collectedAmount!==prior.amountMinor)return true;
          }
        }
        if(values.settlementExternalId || values.settlementNet!=null) {
          const key=settlementIdentity(batch.sourceId,values);
          const old=entity(await tx.db.get(`SELECT * FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,key])]));
          if(!old || old.netMinor!==values.settlementNet || old.reportedOn!==on(values.settlementDate))return true;
        }
      }
    }
  }
  return false;
}
async function prepareGroup(tx,batch,group,config,resolutions,appliedRows) {
  group.resolutions = resolutions.filter(resolution => applicable(resolution,group));
  if (group.rowRefs.some(ref=>appliedRows.has(rowKey(ref.sheet,ref.rowNumber)))) {
    if (group.rowRefs.every(ref=>appliedRows.has(rowKey(ref.sheet,ref.rowNumber)))) {group.state='applied';Object.assign(group,await captureTargets(tx,batch,group));return group;}
    group.errors.push({code:'IMPORT_APPLIED_GROUP',message:'La nueva distribución mezcla filas aplicadas y pendientes. Conserva los grupos ya importados.'});
  }
  if (findResolution(resolutions,'omit_group',group)) {group.state='skipped';return group;}
  const seen = new Map(), active = [];
  for (const row of group.rows) {
    if(row.auxiliary){group.errors.push(...row.errors);continue;}
    group.warnings.push(...row.warnings);
    if (row.structuralOmission || findResolution(resolutions,'duplicate',group,row)) {row.skipped=true;continue;}
    if (seen.has(row.fingerprint) && !findResolution(resolutions,'additional_quantity',group,row)) group.errors.push({code:'IMPORT_DUPLICATE_ROW',message:`La fila es idéntica a la ${seen.get(row.fingerprint)}. Marca duplicada o cantidad adicional.`,rowNumber:row.rowNumber});
    else seen.set(row.fingerprint,row.rowNumber);
    row.errors=row.errors.filter(error=>error.code!=='IMPORT_FORMULA_ACCEPTANCE' || !findResolution(resolutions,'accept_formulas',group,row,error.field));
    group.errors.push(...row.errors);active.push(row);
  }
  if (!active.length) {group.state=group.errors.length?'rejected':'skipped';return group;}
  const units = new Map();
  for (const row of active) {const rows=units.get(row.orderKey)||[];rows.push(row);units.set(row.orderKey,rows);}
  for (const [key,rows] of units) {
    try {
      const commercialConfig=rows.find(row=>row.config.purpose==='orders')?.config,hasOrders=!!commercialConfig;
      const values = repeated(rows,ORDER_FIELDS,group.errors,'Pedido'), shipmentRows = new Map();
      for(const row of rows){
        const logistics=['rawStatus','eventAt','externalEventId','labelCreatedAt','collectedAt','deliveredAt','returnAt','collectedAmount','settlementExternalId','settlementGross','settlementNet',...IMPORT_COST_FIELDS.flatMap(([field,date])=>[field,date]),...SHIPMENT_INFORMATION_FIELDS].some(field=>row.values[field]!=null) || row.values.shipmentAdditionalFields?.length || row.values.additionalFields?.length;
        if(!shipmentKey(row.values) && row.config.purpose==='orders' && !logistics)continue;
        const sk=shipmentKey(row.values) || `unidentified:${key}`,list=shipmentRows.get(sk)||[];list.push(row);shipmentRows.set(sk,list);
      }
      const shipments = [];
      for (const [key,list] of shipmentRows) {
        const insuranceCostMapped=list.some(row=>row.config.columns.some(column=>column.destination==='insuranceCost'));
        const eventFields = new Set(['rawStatus','eventAt','externalEventId','eventDetail','labelCreatedAt','collectedAt','deliveredAt','returnAt']);
        const transactionFields = new Set(['collectedAmount','collectionDate','collectionExternalId','collectionReference','settlementExternalId','settlementDate','settlementGross','settlementNet','settlementReference']);
        const shipmentValues = repeated(list,DESTINATION_FIELDS.filter(field => field!=='reportAsOf' && FIELD_DEFINITIONS.get(field)?.type!=='additional' && !LINE_FIELDS.has(field) && !ORDER_FIELDS.includes(field) && !eventFields.has(field) && !transactionFields.has(field)),group.errors,'Envío');
        const financial = new Map();
        for (const row of list) {
          const values = {...shipmentValues,...Object.fromEntries(['externalOrderId',...transactionFields].filter(field=>row.values[field]!=null).map(field=>[field,row.values[field]]))};
          if (![...transactionFields].some(field=>values[field]!=null)) continue;
          const key = hash(values), old = financial.get(key);
          if (old) {old.rowNumbers.push(row.rowNumber);old.rowRefs.push({sheet:row.sheet,rowNumber:row.rowNumber});}
          else financial.set(key,{values,sourceAsOf:sourceAsOf(row.values,row.config),rowNumbers:[row.rowNumber],rowRefs:rowRefs([row])});
        }
        const existing = await findShipment(tx,batch.sourceId,shipmentValues,resolutions,group,list[0]);
        const hasShipmentInformation = list.some(row => row.values.shipmentAdditionalFields?.length || row.values.additionalFields?.length || [...SHIPMENT_INFORMATION_FIELDS].some(field => row.values[field] != null));
        const importedFields = existing || shipmentValues.externalShipmentId || shipmentValues.tracking || hasShipmentInformation ? prepareImportedFields(list,batch,config,group.errors) : [];
        if (existing) existing.events = (await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=? ORDER BY recorded_at,id`,[existing.id])).map(entity);
        validateShipmentMetadata({carrier:shipmentValues.carrier || existing?.carrier || '',tracking:shipmentValues.tracking || existing?.tracking || '',externalId:shipmentValues.externalShipmentId || existing?.externalId || null,estimatedDeliveryOn:on(shipmentValues.estimatedDeliveryOn) || existing?.estimatedDeliveryOn || null});
        const events = [];
        for (const row of list) for (const event of shipmentEvents(row.values,row.config,resolutions,group,row)) {
          const snapshotCut=!event.occurredAt && !event.occurredOn?event.sourceAsOf:null;
          event.explicitExternalKey=!!event.externalKey;
          event.observationKey=`observation:${hash([batch.sourceId,shipmentValues.externalShipmentId || key,event.externalKey,event.status,event.occurredAt,event.occurredOn,snapshotCut,event.rawStatus,event.detail])}`;
          event.externalKey ||= `excel-event:${hash([batch.sourceId,shipmentValues.externalShipmentId || key,event.status,event.occurredAt,event.occurredOn,snapshotCut,event.rawStatus,event.detail])}`;
          event.rowRefs=rowRefs([row]);
          if(!events.some(previous=>previous.observationKey===event.observationKey))events.push(event);
        }
        const cuts=list.map(row=>sourceAsOf(row.values,row.config)).filter(Boolean),sourceCut=cuts.sort().at(-1) || null;
        const hasCosts = IMPORT_COST_FIELDS.some(([field])=>costIsObserved({values:shipmentValues,insuranceCostMapped},field));
        if (events.some(event => !event.occurredAt && !event.occurredOn && !event.sourceAsOf)) group.errors.push({code:'IMPORT_CUTOFF_REQUIRED',message:'Un estado sin fecha real necesita fecha de corte del reporte.',rowNumber:list[0].rowNumber});
        if (!existing && !shipmentValues.externalShipmentId && !shipmentValues.tracking && (hasShipmentInformation || events.length || [...financial.values()].some(observation=>observation.values.collectedAmount!=null) || hasCosts)) group.errors.push({code:'IMPORT_SHIPMENT_IDENTITY',message:'Los datos informativos, eventos, costos y recaudos necesitan ID de envío, transportadora y guía o un envío vinculado explícitamente.',rowNumber:list[0].rowNumber});
        if (hasCosts && !sourceCut || [...financial.values()].some(observation=>observation.values.collectedAmount!=null && !observation.sourceAsOf)) group.errors.push({code:'IMPORT_CUTOFF_REQUIRED',message:'Los costos y recaudos acumulados requieren fecha de corte.',rowNumber:list[0].rowNumber});
        if (events.some(event => event.status === 'unknown')) group.warnings.push({code:'IMPORT_UNKNOWN_STATUS',message:'El estado desconocido se conservará visible sin inferir entrega ni dinero.'});
        shipments.push({key,values:shipmentValues,importedFields,insuranceCostMapped,insuranceCostObservation:existing?.costObservations?.shipping_insurance || null,existingId:existing?.id || null,existing,events,financial:[...financial.values()],sourceAsOf:sourceCut,rowNumbers:list.map(row=>row.rowNumber),rowRefs:rowRefs(list)});
      }
      let order = await resolveOrder(tx,batch,values,shipments,resolutions,group);
      const commercial = findResolution(resolutions,'commercial_update',group,rows[0]);
      let sellerId = values.sellerExternalKey ? await alias(tx,batch,resolutions,'person',values.sellerExternalKey,group,rows[0]) : null;
      if (values.sellerExternalKey && !sellerId) group.errors.push({code:'IMPORT_PERSON_LINK',message:`Vincula la persona ${values.sellerExternalKey}.`,externalKey:values.sellerExternalKey});
      let lines = [];
      if (hasOrders && !commercial?.value.items) lines = await buildLines(tx,batch,rows.filter(row=>row.config.purpose==='orders'),resolutions,group,group.errors);
      if(order && hasOrders && !commercial){
        const differences=ORDER_FIELDS.filter(field=>!['externalOrderId','internalOrderNumber','sellerExternalKey'].includes(field) && values[field]!=null && values[field]!=='').filter(field=>{
          const target=field==='placedOn'?on(values[field]):values[field],key=field==='orderNotes'?'notes':field==='shippingCharge'?'shippingChargeMinor':field;
          return target!==(order[key] ?? '');
        });
        if(values.sellerExternalKey && sellerId!==order.sellerId)differences.push('sellerExternalKey');
        if(differences.length || lines.some(line=>{const previous=order.items.find(previous=>previous.externalLineId===line.externalLineId);return !previous || ['kind','itemId','quantity','unitPriceMinor','discountMinor'].some(key=>previous[key]!==line[key]);}))group.errors.push({code:'IMPORT_COMMERCIAL_AUTHORITY',message:'Los datos comerciales difieren del pedido vigente. Confirma la actualización con motivo.',fields:differences,rowRefs:rowRefs(rows)});
      }
      const hasIdentity = !!(values.externalOrderId || values.internalOrderNumber || commercialConfig?.oneOrderPerGuide && shipments.some(shipment=>shipment.values.externalShipmentId || shipment.values.tracking));
      const base = {...Object.fromEntries(RECIPIENT_FIELDS.map(field=>[field,values[field] || ''])),notes:values.orderNotes || '',placedOn:on(values.placedOn),sellerId,status:'new',deliveryMethod:values.deliveryMethod || 'carrier',shippingChargeMinor:values.shippingCharge ?? 0,marketingCampaign:values.marketingCampaign || '',items:lines};
      const shipmentAssignments=commercial?.value.shipmentAssignments || [];
      let input = null;
      if (order && commercial) {const {inventoryOpening,...editableOrder}=order;input={...editableOrder,...commercial.value};}
      else if (!order && hasOrders) input = {...base,...commercial?.value};
      const complete = input && hasIdentity && input.customerName && input.phone && input.city && input.placedOn && input.items?.length;
      if (!order && !complete) {
        input = null;
        group.tasks.push({type:'link_order',message:hasOrders?'Completa los datos comerciales obligatorios o vincula el pedido existente.':'Vincula el seguimiento o liquidación al pedido cuando corresponda.',rowRefs:rowRefs(rows)});
        if(hasOrders)group.errors.push({code:'IMPORT_ORDER_INCOMPLETE',message:'Este grupo de pedidos necesita cliente, celular, ciudad, fecha comercial y líneas válidas; no se creará solo seguimiento.',rowRefs:rowRefs(rows)});
        if (!shipments.some(shipment => shipment.values.externalShipmentId || shipment.values.tracking) && !rows.some(row=>row.values.settlementExternalId || row.values.settlementNet!=null)) group.errors.push({code:'IMPORT_IDENTITY_REQUIRED',message:'Sin pedido completo, identifica el envío mediante ID externo o transportadora y guía.'});
      }
      let previewOrder=order;
      if (input) {
        input.items = input.items.map(line=>{
          const lineId=line.lineId || newId(),externalLineId=line.externalLineId || order?.items.find(previous=>previous.lineId===lineId)?.externalLineId || `excel-line:${hash([batch.sourceId,values.externalOrderId || key,lineId]).slice(0,40)}`;
          return {...line,lineId,externalLineId};
        });
        previewOrder=await validateOrder(input,(kind,id)=>tx.get(kind,id),order,{dispatched:order?.economicLocked,resolveSeller:id=>byId(tx,'people',id)});
      }
      const orderItems=input?.items || order?.items || lines, siblings=order?(await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[order.id])).map(entity):[];
      const auxiliary=await prepareAuxiliary(tx,batch,group,values,orderItems,shipments,resolutions);
      const identified=shipments.filter(shipment=>shipment.existingId || shipment.values.externalShipmentId || shipment.values.tracking);
      for(const shipment of identified) {
        const explicit=shipmentAssignments.find(value=>value.externalShipmentId?value.externalShipmentId===shipment.values.externalShipmentId:value.tracking===shipment.values.tracking);
        const linked=findResolution(resolutions,'link_shipment',group,shipment.rowRefs[0],shipment.values.externalShipmentId || shipmentKey(shipment.values));
        shipment.assignments=explicit?.assignments || linked?.value?.assignments || auxiliary.allocations.get(shipment.key) || (shipment.existing?.orderId?shipment.existing.assignments:null) || null;
        if(!shipment.assignments&&orderItems.length&&identified.length===1&&!siblings.length)shipment.assignments=orderItems.map(line=>({lineId:line.lineId,quantity:line.quantity}));
        if(!shipment.assignments && !shipment.existingId && orderItems.length && (identified.length>1 || siblings.some(sibling=>sibling.status!=='cancelled'))) {
          if(!order && input?.items.every(line=>line.allocations?.length))shipment.assignments=input.items.map(line=>({lineId:line.lineId,quantity:line.allocations.filter(allocation=>shipment.rowRefs.some(ref=>ref.sheet===allocation.sheet && ref.rowNumber===allocation.rowNumber)).reduce((sum,allocation)=>sum+allocation.quantity,0)})).filter(line=>line.quantity>0);
          if(!shipment.assignments?.length)group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'Distribuye explícitamente las cantidades de cada guía; no se duplicará la venta ni las unidades enviadas.',rowNumber:shipment.rowNumbers[0]});
        }
        for(const assignment of shipment.assignments || [])if(!orderItems.some(line=>line.lineId===assignment.lineId && assignment.quantity<=line.quantity))group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'La distribución contiene una línea ajena o supera su cantidad.',rowNumber:shipment.rowNumbers[0]});
      }
      const replaced=new Set(siblings.map(shipment=>shipment.replacesShipmentId).filter(Boolean)), allocated=new Map();
      for(const sibling of siblings)if(sibling.status!=='cancelled' && !replaced.has(sibling.id)) {
        const observed=identified.find(shipment=>shipment.existingId===sibling.id);
        for(const line of observed?.assignments || sibling.assignments || [])allocated.set(line.lineId,(allocated.get(line.lineId)||0)+line.quantity);
      }
      for(const shipment of identified.filter(shipment=>!shipment.existingId))for(const line of shipment.assignments || [])allocated.set(line.lineId,(allocated.get(line.lineId)||0)+line.quantity);
      for(const line of orderItems)if((allocated.get(line.lineId)||0)>line.quantity)group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'Las guías activas asignan más unidades que las compradas. Revisa la distribución completa.'});
      const policy = findResolution(resolutions,'review_policy',group,rows[0]);
      const rule = input && !order ? await ruleForOrder(tx,input.placedOn,input.sellerId) : order?.ruleSnapshot;
      if ((input || order) && !rule) {
        if (!policy) group.errors.push({code:'IMPORT_POLICY_REQUIRED',message:'La fecha histórica no tiene regla vigente. Revisa explícitamente la política de este grupo.'});
        else if (!(await getBusinessSettings(tx)).rulesVersions.some(rule=>rule.id === policy.value.ruleVersionId)) group.errors.push({code:'IMPORT_POLICY_REQUIRED',message:'La versión de política seleccionada no existe.'});
      }
      for (const shipment of shipments) {
        if (shipment.existing?.orderId && order && shipment.existing.orderId !== order.id) group.errors.push({code:'IMPORT_ORDER_CONFLICT',message:'La guía está vinculada a otro pedido.'});
        const authority = findResolution(resolutions,'review_authority',group,shipment.rowRefs[0]);
        const merged = mergeImportedFields(shipment.existing?.importedFields || [],shipment.importedFields,{scope:'shipment',reviewConfirmed:!!authority});
        group.warnings.push(...merged.warnings);
        group.errors.push(...merged.conflicts);
        if (merged.conflicts.length) group.tasks.push({type:'review_authority',message:'Revisa los datos informativos discrepantes y confirma la autoridad con un motivo.',rowNumbers:shipment.rowNumbers});
        const effective = shipment.existing ? effectiveShipmentEvents(shipment.existing.events) : [], latest = effective.at(-1);
        if (latest && ['delivered','returned','cancelled'].includes(shipment.existing.status)) {
          const finalEvent=[...effective].reverse().find(event=>event.status===shipment.existing.status) || latest;
          const contradictions = shipment.events.filter(event => event.status !== 'unknown' && event.status !== shipment.existing.status && !(shipment.existing.status==='delivered' && ['return_in_transit','returned'].includes(event.status)) && (observationAt(event) || event.sourceAsOf || '') >= (observationAt(finalEvent) || finalEvent.sourceAsOf || ''));
          const datedFinal=effective.filter(event=>event.status===shipment.existing.status && (event.occurredAt || event.occurredOn));
          const changedDates=shipment.events.filter(event=>event.status===shipment.existing.status && (event.occurredAt || event.occurredOn) && datedFinal.length && !datedFinal.some(previous=>previous.occurredAt===event.occurredAt && previous.occurredOn===event.occurredOn));
          for(const event of changedDates)if(shipment.sourceAsOf && shipment.existing.sourceAsOf && shipment.sourceAsOf<shipment.existing.sourceAsOf && !authority?.value.correctionOf){event.observationOnly=true;group.warnings.push({code:'IMPORT_OLD_FINAL_DATE',message:'Una fecha final discrepante de un corte anterior se conservará como observación, sin rectificar el hecho vigente.'});}
          if ((contradictions.length || changedDates.some(event=>!event.observationOnly)) && !authority?.value.correctionOf) {
            const target=datedFinal.at(-1) || finalEvent;
            group.errors.push({code:'IMPORT_FINAL_RECTIFICATION',message:`Rectificar el estado o fecha final requiere motivo y referencia al evento vigente: ${target.id}.`,rowNumber:shipment.rowNumbers[0],eventId:target.id});
            group.tasks.push({type:'review_authority',message:`Evento ${target.id} (${target.status}). La rectificación recalcula reconocimiento, costos y comisiones históricas; no mueve caja.`,eventId:target.id,shipmentId:shipment.existingId});
          }
        }
        if (authority?.value.correctionOf && !effective.some(event=>event.id===authority.value.correctionOf)) group.errors.push({code:'IMPORT_EVENT_CORRECTION',message:'Selecciona un evento vigente del envío para rectificar.',rowNumber:shipment.rowNumbers[0]});
        if(authority?.value.correctionOf && shipment.events.length!==1)group.errors.push({code:'IMPORT_CORRECTION_SCOPE',message:'Una rectificación debe identificar un único hecho corregido. Deja mapeado solo el evento que se rectifica; conserva el resto del historial sin volver a declararlo.',rowNumber:shipment.rowNumbers[0]});
        for (const [field,dateField,category] of IMPORT_COST_FIELDS) if (costIsObserved(shipment,field)) {
          const cost = shipment.existingId ? entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.existingId}:${category}`])) : null;
          const previous = cost || shipment.existing?.costObservations?.[category];
          const chargeOn = importCostChargeOn(shipment.values,field,dateField,cost);
          const oldCut = previous?.source === 'excel' && previous.sourceId === batch.sourceId && previous.sourceAsOf && shipment.sourceAsOf < previous.sourceAsOf;
          const previousCharge = previous && Object.hasOwn(previous,'chargeOn') ? previous.chargeOn : previous?.incurredOn ?? null;
          if (field === 'insuranceCost') {
            const preserved = shipment.values[field] == null && cost || oldCut;
            shipment.insuranceCostObservation = {amountMinor:preserved ? previous.amountMinor : shipment.values[field] ?? null,chargeOn:preserved ? previousCharge : chargeOn,sourceAsOf:preserved ? previous.sourceAsOf : shipment.sourceAsOf};
          }
          if (shipment.values[field] == null && cost) continue;
          if (previous && !oldCut && (previous.source !== 'excel' || previous.sourceId !== batch.sourceId || previous.sourceAsOf === shipment.sourceAsOf && (previous.amountMinor !== (shipment.values[field] ?? null) || previousCharge !== chargeOn)) && !authority) group.errors.push({code:'IMPORT_COST_AUTHORITY',message:'El costo tiene otra autoridad o discrepa en importe o fecha al mismo corte. Confirma una revisión con motivo.',rowNumber:shipment.rowNumbers[0],field});
          if (shipment.values[field] != null && !chargeOn) group.tasks.push({type:'cost_date',field,message:`${FIELD_DEFINITIONS.get(field).label}: importe conocido con fecha del cargo pendiente; no se usará la fecha de carga ni el corte.`,rowNumbers:shipment.rowNumbers});
        }
        for (const observation of shipment.financial) {
          const values=observation.values;
          if(values.collectedAmount!=null && shipment.existingId && !collectionIsEvent(values)){
            const prior=shipment.existing.collectionObservations?.[batch.sourceId];
            if(prior && observation.sourceAsOf>=prior.sourceAsOf && (values.collectedAmount<prior.amountMinor || observation.sourceAsOf===prior.sourceAsOf && values.collectedAmount!==prior.amountMinor))group.errors.push({code:'IMPORT_COLLECTION_RECTIFICATION',message:'El recaudo acumulado disminuye o discrepa al mismo corte. Rectifica el documento financiero antes de importar.'});
          }
          if (values.collectedAmount>0 && shipment.existingId && collectionIsEvent(values)) {
            const prior=shipment.existing.collectionObservations?.[batch.sourceId], reference=values.collectionReference || values.collectionExternalId;
            const externalKey=values.collectionExternalId || `fingerprint:${hash([batch.sourceId,reference,on(values.collectionDate),values.collectedAmount,values.tracking || values.externalShipmentId || shipment.existingId])}`;
            const saved=await tx.db.get(`SELECT id FROM ${tx.t('order_collections')} WHERE external_key=?`,[`collection:${hash([batch.sourceId,externalKey])}`]);
            if(prior && !saved && (observationAt(values.collectionDate) || '')<=prior.sourceAsOf && !authority)group.errors.push({code:'IMPORT_COLLECTION_AUTHORITY',message:'El evento puede estar incluido en un acumulado ya importado. Revisa su autoridad con motivo antes de sumar dinero.',rowNumber:observation.rowNumbers[0]});
          }
          if(values.collectedAmount>0 && !on(values.collectionDate))group.tasks.push({type:'collection_date',message:'Recaudo conocido con fecha pendiente: se conservará sin fecha inventada, sin caja y con cobertura incompleta.',rowNumbers:observation.rowNumbers});
          if(values.collectedAmount>0 && !order && !input)group.errors.push({code:'IMPORT_COLLECTION_ORDER',message:'Vincula el pedido antes de registrar recaudos.'});
          if(shipment.existing?.sourceId && shipment.existing.sourceId!==batch.sourceId && values.collectedAmount!=null)group.errors.push({code:'IMPORT_SOURCE_AUTHORITY',message:'Los recaudos deben registrarse en la fuente titular del envío.'});
        }
        if (shipment.existing?.sourceId && shipment.existing.sourceId !== batch.sourceId && IMPORT_COST_FIELDS.some(([field])=>costIsObserved(shipment,field))) group.errors.push({code:'IMPORT_SOURCE_AUTHORITY',message:'El vínculo entre fuentes permite seguimiento; los costos se registran en la fuente titular del envío.'});
      }
      const importedFields=combineImportedFields([...prepareImportedFields(rows,batch,config,group.errors,'order'),...auxiliary.orderFields],'order',group.errors),authority=findResolution(resolutions,'review_authority',group,rows[0]);
      const merged=mergeImportedFields(order?.importedFields || [],importedFields,{scope:'order',reviewConfirmed:!!authority});
      group.errors.push(...merged.conflicts);group.warnings.push(...merged.warnings);
      if(order && hasOrders && values.marketingCampaign && values.marketingCampaign!==order.marketingCampaign && !commercial)group.errors.push({code:'IMPORT_COMMERCIAL_AUTHORITY',message:'Cambiar la campaña de origen requiere revisar los datos comerciales con motivo.'});
      const costResolution=findResolution(resolutions,'line_costs',group,null,values.externalOrderId || key),mappedCosts=lines.filter(line=>line.orderUnitCostMinor!=null).map(line=>({lineId:order?.items.find(item=>item.externalLineId===line.externalLineId)?.lineId || line.lineId,unitCostMinor:line.orderUnitCostMinor}));
      const costs=costResolution?.value.lineCosts || [...new Map([...mappedCosts,...auxiliary.costs].map(cost=>[cost.lineId,cost])).values()];
      for(const cost of costs){
        const line=(previewOrder?.items || input?.items || order?.items || lines).find(line=>line.lineId===cost.lineId);
        if(!line)group.errors.push({code:'IMPORT_LINE_COST',message:'El costo apunta a una línea ajena al pedido.'});
        else if(line.components?.length){
          const ids=new Set((cost.components || []).map(component=>component.productId));
          if(!cost.components || ids.size!==line.components.length || cost.components.length!==ids.size || line.components.some(component=>!ids.has(component.productId)))group.errors.push({code:'IMPORT_COMPONENT_COSTS',message:'Completa los costos reales de todos los componentes del combo.'});
          else{
            const total=moneyMinor(Number(line.components.reduce((sum,component)=>sum+BigInt(component.quantity)*BigInt(cost.components.find(value=>value.productId===component.productId).unitCostMinor),0n)),'Costo compuesto');
            if(cost.unitCostMinor!=null && cost.unitCostMinor!==total)group.errors.push({code:'IMPORT_COMPONENT_COSTS',message:'El costo compuesto no coincide con los costos de sus componentes.'});
            cost.unitCostMinor=total;
          }
        }
        if(order && line?.unitCostMinor!=null && (cost.unitCostMinor!==line.unitCostMinor || cost.components && cost.components.some(component=>line.components.find(previous=>previous.productId===component.productId)?.unitCostMinor!==component.unitCostMinor)) && !costResolution?.reason)group.errors.push({code:'IMPORT_COST_AUTHORITY',message:'Corregir el costo histórico requiere motivo.'});
      }
      const opening=order?.inventoryOpening || (!order?batch.inventoryOpening:null);
      if(opening)for(const shipment of shipments)for(const event of shipment.events.filter(event=>['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned'].includes(event.status))){
        const occurred=on(event),decision=findResolution(resolutions,'opening_observation',group,event.rowRefs[0],event.observationKey);
        if(!occurred || occurred===opening.on){
          if(decision){event.inventoryOpeningIncluded=decision.value;event.openingReason=decision.reason;}
          else{
            const history=shipment.existing?.events || [],saved=matchingShipmentEvent(history,event);
            const correction=findResolution(resolutions,'review_authority',group,event.rowRefs[0])?.value.correctionOf;
            let inherited=false;
            if(order?.inventoryOpening)try{inventoryOpeningIncluded(opening,{...event,id:saved?.id || event.observationKey,correctionOf:correction || null},{documents:history});inherited=true;}catch(error){if(error.code!=='IMPORT_OPENING_CLASSIFICATION')throw error;}
            if(!inherited)group.errors.push({code:'IMPORT_OPENING_CLASSIFICATION',message:'Confirma si este hecho ya estaba reflejado en el conteo físico.',externalKey:event.observationKey,rowRefs:event.rowRefs});
          }
        }
      }
      const displayItems=structuredClone(input?.items || order?.items || lines);
      for(const cost of costs){const line=displayItems.find(line=>line.lineId===cost.lineId);if(line){line.orderUnitCostMinor=cost.unitCostMinor;if(cost.components)line.components=cost.components;}}
      group.units.push({key,values,rowRefs:rowRefs(rows),oneOrderPerGuide:!!commercialConfig?.oneOrderPerGuide,orderId:order?.id || null,order:order || null,input,previewOrder,importedFields:merged.fields,informationChanged:merged.changed,lineCosts:costs,lineCostReason:costResolution?.reason || null,displayItems,commercialReason:commercial?.reason || null,policy,shipments:shipments.map(({existing,...shipment})=>shipment)});
    } catch (error) {if (!error.status || error.status >= 500) throw error;group.errors.push(errorRecord(error,{phase:'preview',sheet:group.sheet,...(rows.length===1?{rowNumber:rows[0].rowNumber}:{})}));}
  }
  const declarations=new Map();
  for(const unit of group.units)for(const shipment of unit.shipments)for(const observation of shipment.financial) {
    const values=observation.values;
    if(!values.settlementExternalId && values.settlementNet==null && values.settlementGross==null)continue;
    if(values.settlementNet==null)group.errors.push({code:'IMPORT_SETTLEMENT_NET',message:'La liquidación necesita un neto declarado; no se inventará su importe.',rowNumber:observation.rowNumbers[0]});
    if(!values.settlementExternalId && (!on(values.settlementDate) || !values.settlementReference && !values.tracking && !values.externalShipmentId && !values.externalOrderId))group.errors.push({code:'IMPORT_SETTLEMENT_IDENTITY',message:'Sin ID externo, indica referencia o guía y fecha real para identificar la liquidación.',rowNumber:observation.rowNumbers[0]});
    const key=settlementIdentity(batch.sourceId,values), entries=declarations.get(key)||[];entries.push({values});declarations.set(key,entries);
  }
  for(const [key,entries] of declarations) {
    const values=repeated(entries,['settlementNet','settlementDate','settlementReference'],group.errors,'Liquidación');
    const old=entity(await tx.db.get(`SELECT * FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,key])]));
    if(old && (values.settlementNet!=null && values.settlementNet!==old.netMinor || values.settlementDate && on(values.settlementDate)!==old.reportedOn) && !findResolution(resolutions,'review_authority',group))group.errors.push({code:'IMPORT_SETTLEMENT_AUTHORITY',message:'El documento externo ya tiene otros importes o fecha. Revisa su autoridad con motivo; no es otro abono.'});
  }
  const targets = await captureTargets(tx,batch,group);Object.assign(group,targets);
  const mappedExisting = group.units.some(unit=>unit.orderId || unit.shipments.some(shipment=>shipment.existingId)) || group.targets.some(target=>target.table==='settlements');
  group.state = group.errors.length ? group.errors.some(error=>/CONFLICT|AUTHORITY|RECTIFICATION/.test(error.code)) ? 'conflict' : 'rejected' : mappedExisting ? await groupHasChanges(tx,batch,group) ? 'updated' : 'unchanged' : 'new';
  return group;
}
function summaryFor(groups) {
  const summary = {new:0,updated:0,unchanged:0,conflict:0,rejected:0,skipped:0,applied:0,total:groups.length,valid:0,omitted:0};
  for (const group of groups) {summary[group.state]=(summary[group.state]||0)+1;if (['new','updated','unchanged','ready'].includes(group.state)) summary.valid++;if (['conflict','rejected','skipped'].includes(group.state)) summary.omitted++;}
  return summary;
}
const publicGroup = group => ({kind:group.kind,key:group.key,state:group.state,sheet:group.sheet,rowNumbers:group.rowNumbers,rowRefs:group.rowRefs,identityKeys:group.identityKeys,errors:group.errors,warnings:group.warnings,tasks:group.tasks,inventory:group.inventory || null,expenses:group.expenses || [],expenseIds:(group.expenses || []).map(expense=>expense.existingId).filter(Boolean),orderId:group.units.find(unit=>unit.orderId)?.orderId || null,shipmentIds:group.units.flatMap(unit=>unit.shipments.map(shipment=>shipment.existingId).filter(Boolean)),lines:group.units.flatMap(unit=>unit.displayItems || unit.input?.items || []),units:group.units.map(({previewOrder,...unit})=>unit)});
function previewSignature(batch,groups) {return hash({fileHash:batch.fileHash,sourceId:batch.sourceId,profileId:batch.profileId,profileVersion:batch.profileVersion,manifest:workbookManifest(batch),config:batch.config,resolutions:batch.resolutions,inventoryOpening:batch.inventoryOpening || null,groups});}
async function savePreviewRows(tx,batch,groups,now) {
  const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
  const preserved=new Set((await tx.db.all(`SELECT sheet,row_number FROM ${tx.t('import_rows')} WHERE batch_id=? AND (state='applied' OR (state='skipped' AND ${appliedJSON} IS NOT NULL))`,[batch.id])).map(row=>rowKey(row.sheet,row.row_number)));
  await tx.db.run(`DELETE FROM ${tx.t('import_rows')} WHERE batch_id=? AND state<>'applied' AND NOT(state='skipped' AND ${appliedJSON} IS NOT NULL)`,[batch.id]);
  const rows=[];
  for(const group of groups)for(const row of group.rows) {
    if(preserved.has(rowKey(row.sheet,row.rowNumber)))continue;
    const data=JSON.stringify({source:row.source,normalized:{values:row.values,lines:row.lines},errors:[...row.errors,...group.errors.filter(error=>(!error.sheet || error.sheet===row.sheet) && (!error.rowNumber || error.rowNumber===row.rowNumber))],warnings:row.warnings,groupKey:group.key,task:group.tasks,skipped:!!row.skipped});
    rows.push([batch.id,row.sheet,row.rowNumber,group.key,row.skipped?'skipped':group.state,data,1,now,now]);
  }
  const columns=['batch_id','sheet','row_number','entity_key','state','data','version','created_at','updated_at'];
  for(let offset=0;offset<rows.length;offset+=250){const chunk=rows.slice(offset,offset+250);await tx.db.run(`INSERT INTO ${tx.t('import_rows')}(${columns.join(',')}) VALUES ${chunk.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',')}`,chunk.flat());}
}
function settlementDeclarations(groups,sourceId) {
  const declarations=new Map();
  for(const group of groups)for(const row of group.rows) {
    if(row.skipped)continue;
    const source=row.values;
    if(!source.settlementExternalId && source.settlementNet==null && source.settlementGross==null)continue;
    const key=settlementIdentity(sourceId,source), sourceIdentity=shipmentKey(source)||`unidentified:${row.orderKey}`;
    const declaration=declarations.get(key)||{key,refs:[],errors:[]};
    const old=declaration.refs.find(ref=>ref.groupKey===group.key && ref.sourceIdentity===sourceIdentity && ref.sheet===row.sheet);
    const fields=['externalOrderId','externalShipmentId','carrier','tracking','collectionExternalId',...IMPORT_COST_FIELDS.map(([field])=>field),'settlementExternalId','settlementDate','settlementGross','settlementNet','settlementReference','reportAsOf'];
    const values=Object.fromEntries(fields.filter(field=>source[field]!=null).map(field=>[field,source[field]]));
    if(old) {
      for(const field of ['settlementGross','settlementNet','settlementDate','settlementReference'])if(old.values[field]!=null && values[field]!=null && hash(old.values[field])!==hash(values[field]))declaration.errors.push({code:'IMPORT_SETTLEMENT_CONFLICT',message:`La misma liquidación/envío repite ${field} con valores contradictorios.`});
      old.rowNumbers.push(row.rowNumber);if(source.collectionExternalId && !old.collectionExternalIds.includes(source.collectionExternalId))old.collectionExternalIds.push(source.collectionExternalId);
    } else declaration.refs.push({groupKey:group.key,sourceIdentity,sheet:row.sheet,rowNumbers:[row.rowNumber],collectionExternalIds:source.collectionExternalId?[source.collectionExternalId]:[],values});
    declarations.set(key,declaration);
  }
  for(const declaration of declarations.values())repeated(declaration.refs,['settlementNet','settlementDate','settlementReference'],declaration.errors,'Liquidación completa');
  return [...declarations.values()];
}
function validateSettlementDeclarations(groups,sourceId) {
  for(const declaration of settlementDeclarations(groups,sourceId))if(declaration.errors.length)for(const group of groups)if(declaration.refs.some(ref=>ref.groupKey===group.key) && group.state!=='applied') {
    group.errors.push(...declaration.errors);group.state='conflict';
  }
}
function freezeSettlementDeclarations(batch,selected) {
  const selectedKeys=new Set(selected.map(group=>group.key));
  return settlementDeclarations(batch.previewGroups,batch.sourceId).filter(declaration=>declaration.refs.some(ref=>selectedKeys.has(ref.groupKey)) || Object.values(batch.settlementIssues || {}).some(issue=>issue.key===declaration.key)).map(declaration=>{
    const relevant=batch.previewGroups.filter(group=>declaration.refs.some(ref=>ref.groupKey===group.key));
    const identities=relevant.flatMap(group=>group.identities || []).filter(identity=>identity.type==='settlement_document' && identity.key===declaration.key);
    const id=identities[0]?.internalId || null, target=relevant.flatMap(group=>group.targets || []).find(target=>target.table==='settlements' && target.id===id);
    return {...declaration,target:{id,version:target?.version || null},authority:relevant.flatMap(group=>group.resolutions || []).find(resolution=>resolution.action==='review_authority') || null};
  });
}
export async function commitImport(store,batchId,input,actorId) {
  await runCommand(store,{scope:`import:commit:${batchId}`,requestId:input.requestId,payload:input,actorId},async tx => {
    const batch = await requireBatch(tx,batchId);editable(batch,input.version);
    if (!batch.preview || !batch.previewGroups || input.previewHash !== batch.preview.previewHash || previewSignature(batch,batch.previewGroups) !== input.previewHash) fail('La revisión ya no corresponde al archivo, configuración y destinos actuales. Genera una revisión nueva.',409);
    if (batch.profileId && (await byId(tx,'import_profiles',batch.profileId))?.version !== batch.profileVersion) fail('El perfil guardado cambió. Selecciónalo y revisa otra vez.',409);
    const groups = batch.previewGroups.filter(group => !['applied','skipped'].includes(group.state));
    const invalid = groups.filter(group=>group.errors.length);
    if (invalid.length && input.includeValidOnly !== true) fail('Resuelve las excepciones o elige explícitamente importar solo grupos válidos.',409);
    const selected = groups.filter(group=>!group.errors.length);
    const revision = Number((await tx.db.get(`SELECT COALESCE(MAX(revision),0) AS n FROM ${tx.t('import_revisions')} WHERE batch_id=?`,[batchId])).n)+1;
    const settlements=freezeSettlementDeclarations(batch,selected);
    if(!selected.length && !settlements.length)fail('No hay grupos o liquidaciones pendientes para importar.',409);
    const now = stamp(), frozen = {formatVersion:2,fileHash:batch.fileHash,sourceId:batch.sourceId,profileId:batch.profileId,profileVersion:batch.profileVersion,manifest:workbookManifest(batch),config:batch.config,resolutions:batch.resolutions,inventoryOpening:batch.inventoryOpening || null,groups:selected,settlements,selection:selected.map(group=>group.key),omitted:invalid.map(group=>group.key),includeValidOnly:input.includeValidOnly===true};
    await insertRow(tx,'import_revisions',{batch_id:batchId,revision,preview_hash:input.previewHash,accepted_at:now,actor_id:actorId,recorded_at:now,data:JSON.stringify(frozen)});
    const next = await changeBatch(tx,batch,{state:'queued'},{acceptedRevision:revision,error:null,previewGroups:null,settlementIssues:{},progress:{phase:'apply',processed:0,total:selected.length+settlements.length,groupsTotal:selected.length,settlementsTotal:settlements.length,settlementsProcessed:0,created:0,updated:0,unchanged:0,errors:invalid.length,omitted:invalid.length}});
    await queueJobTx(tx,`import:${batchId}`,jobData(next,actorId,'apply',{revision}));
    return {id:batchId,revision};
  });
  return {...await getImportBatch(store,batchId),accepted:true};
}

async function checkTargets(tx,batch,group) {
  const allowed = new Set(['platform_sources','platforms','business_settings','import_profiles','orders','people','records','product_costs','shipments','expenses','settlements']);
  for (const target of group.targets) {
    if(target.table==='import_profiles')continue;
    if (!allowed.has(target.table)) fail('Destino de revisión no válido.');
    const row = await rawById(tx,target.table,target.id);
    if (targetRevision(target.table,row) !== target.version) fail('Un destino cambió después de la revisión. Vuelve a revisar el grupo.',409);
  }
  for (const identity of group.identities) {
    if (identity.type === 'guide') {
      const matches = identity.key ? (await tx.db.all(`SELECT id,carrier,version FROM ${tx.t('shipments')} WHERE tracking=?`,[identity.key])).filter(row=>normalizeHeader(row.carrier)===identity.carrier).map(row=>({id:row.id,version:row.version})).sort((a,b)=>a.id.localeCompare(b.id)) : [];
      if (hash(matches)!==hash(identity.matches)) fail('La guía cambió después de la revisión.',409);
    } else if(identity.type==='cost') {
      const row=await tx.db.get(`SELECT id,version FROM ${tx.t('product_costs')} WHERE product_id=? AND effective_on<=? ORDER BY effective_on DESC LIMIT 1`,[identity.productId,identity.on]);
      if((row?.id || null)!==identity.id || (row?.version || null)!==identity.version)fail('El costo histórico aplicable cambió después de la revisión.',409);
    } else if(identity.type==='settlement_document') {
      const row=await tx.db.get(`SELECT id FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,identity.key])]);
      if((row?.id || null)!==identity.internalId)fail('La identidad de la liquidación cambió después de la revisión.',409);
    } else if(identity.type==='expense_source'){
      const row=await tx.db.get(`SELECT id,version FROM ${tx.t('expenses')} WHERE source_key=?`,[identity.key]);
      if((row?.id || null)!==identity.internalId || (row?.version || null)!==identity.version)fail('La identidad del gasto cambió después de revisar.',409);
    } else {
      const currentId=(await lookupLink(tx,batch.sourceId,identity.type,identity.key))?.internalId || null;
      // Independent groups may save the same reviewed alias in an earlier
      // transaction. That converges on the frozen target, not a new destination.
      const reviewedAlias=identity.internalId==null && ['product','person'].includes(identity.type) && group.resolutions.some(resolution=>resolution.action===`link_${identity.type}` && resolution.externalKey===identity.key && resolution.internalId===currentId);
      if(currentId!==identity.internalId && !reviewedAlias)fail('Un vínculo externo cambió después de la revisión.',409);
    }
  }
}
async function saveLink(tx,sourceId,type,key,internalId,actorId,batchId) {
  if (!key || !internalId) return;
  const old = await lookupLink(tx,sourceId,type,key);
  if (old) {if (old.internalId !== internalId) fail('La identidad externa ya corresponde a otro registro.',409);return;}
  const now = stamp();
  await insertRow(tx,'external_links',{source_id:sourceId,entity_type:type,external_key:key,internal_id:internalId,version:1,created_at:now,updated_at:now});
  await audit(tx,{entityType:'external_link',entityId:hash([sourceId,type,key]),actorId,next:{sourceId,entityType:type,externalKey:key,internalId,batchId},source:'excel',reason:'Vínculo explícito o identidad importada'});
}
async function refreshShipment(tx,id) {
  const shipment = await byId(tx,'shipments',id);
  return {...shipment,events:(await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=? ORDER BY recorded_at,id`,[id])).map(entity)};
}
async function applyPolicy(tx,order,policy,actorId,batchId) {
  if (order.ruleSnapshot || !policy) return order;
  const settings = await getBusinessSettings(tx), rule = settings.rulesVersions.find(rule=>rule.id===policy.value.ruleVersionId);
  if (!rule) fail('La política histórica seleccionada ya no existe.',409);
  order.ruleSnapshot = {...rule};order.policyReviewRequired=false;order.legacyPolicyReview=false;
  await persistOrderData(tx,order,{actorId,reason:policy.reason,source:'excel'});
  await audit(tx,{entityType:'import_policy',entityId:order.id,actorId,next:{batchId,ruleVersionId:rule.id,placedOn:order.placedOn},reason:policy.reason,source:'excel'});
  await resolveOrderRecognition(tx,order.id,actorId,{reason:policy.reason,source:'excel',deferInventory:true});
  return loadOrderData(tx,order.id);
}
async function updateShipmentData(tx,shipment,patch) {
  const row = await rawById(tx,'shipments',shipment.id), data = JSON.parse(row.data);
  if (Object.keys(patch).every(key=>hash(data[key] ?? null)===hash(patch[key] ?? null))) return refreshShipment(tx,shipment.id);
  await updateVersioned(tx,'shipments',shipment.id,row.version,{data:JSON.stringify({...data,...patch})});
  return refreshShipment(tx,shipment.id);
}
function economicReference(batch,group,references=group.rowRefs) {
  const refs=references.length && typeof references[0]==='object'?references:group.rowRefs.filter(ref=>references.includes(ref.rowNumber));
  const rows=group.rows.filter(row=>refs.some(ref=>ref.sheet===row.sheet && ref.rowNumber===row.rowNumber));
  const row=rows.find(row=>row.values.reportAsOf) || rows[0],value=row?.values.reportAsOf,config=row?rowConfig(row,batch.config):{};
  const reportCutoff=value?{value:value.occurredAt || value.occurredOn,precision:value.precision}:config.reportAsOf?{value:config.reportAsOf,precision:config.reportAsOf.length===10?'day':'instant'}:null;
  return {batchId:batch.id,groupKey:group.key,rowRefs:refs,...(new Set(refs.map(ref=>ref.sheet)).size===1?{sheet:refs[0]?.sheet,rowNumbers:refs.map(ref=>ref.rowNumber)}:{}),fileHash:batch.fileHash,reportCutoff};
}
async function importCollections(tx,batch,group,shipment,unit,actorId) {
  const values = shipment.values;
  if (values.collectedAmount == null) return {collections:[],changed:false};
  let target = await refreshShipment(tx,shipment.id), prior = target.collectionObservations?.[batch.sourceId];
  const eventMode = collectionIsEvent(values);
  let amount = values.collectedAmount;
  if (!eventMode) {
    if (prior && shipment.sourceAsOf < prior.sourceAsOf) {await audit(tx,{entityType:'collection_observation',entityId:target.id,actorId,previous:prior,next:{amountMinor:amount,sourceAsOf:shipment.sourceAsOf},reason:'Corte anterior observado sin modificar recaudo',source:'excel'});return {collections:[],changed:false};}
    if (prior && (shipment.sourceAsOf === prior.sourceAsOf && amount !== prior.amountMinor || amount < prior.amountMinor)) fail('Una disminución del recaudo exige rectificación financiera explícita; no se infiere un reembolso.',409);
    const facts = (await tx.db.all(`SELECT * FROM ${tx.t('order_collections')} WHERE shipment_id=?`,[target.id])).map(entity), reversed = new Set(facts.map(fact=>fact.reversalOf).filter(Boolean));
    const accumulated = facts.filter(fact=>fact.kind==='receipt' && !reversed.has(fact.id) && fact.sourceId===batch.sourceId).reduce((sum,fact)=>sum+Number(fact.amountMinor),0);
    if (amount < accumulated) fail('El acumulado es menor que los cobros vigentes de esta fuente. Revisa sus rectificaciones.',409);
    amount -= accumulated;
  }
  const authority = findResolution(group.resolutions,'review_authority',group,shipment.rowRefs[0]);
  const occurredOn = on(values.collectionDate), reference = values.collectionReference || values.collectionExternalId || `Recaudo acumulado ${values.externalShipmentId || values.tracking || target.id}`;
  const externalKey = values.collectionExternalId || `fingerprint:${hash(eventMode ? [batch.sourceId,reference,occurredOn,values.collectedAmount,values.tracking || values.externalShipmentId || target.id] : [batch.sourceId,target.id,'snapshot',shipment.sourceAsOf,values.collectedAmount])}`;
  const before = await tx.db.get(`SELECT id FROM ${tx.t('order_collections')} WHERE external_key=?`,[`collection:${hash([batch.sourceId,externalKey])}`]);
  if (eventMode && prior && !before && (observationAt(values.collectionDate) || '')<=prior.sourceAsOf && !authority) fail('El evento puede estar incluido en el recaudo acumulado. Revisa su autoridad antes de sumar dinero.',409);
  const collections = [];
  if (amount > 0) {
    const order = await loadOrderData(tx,unit.orderId);
    const result = await recordCollectionTx(tx,{orderId:order.id,version:order.version,shipmentId:target.id,sourceId:batch.sourceId,platformId:target.platformId,externalKey,holder:'platform',amountMinor:amount,occurredOn,method:'Recaudo de plataforma',reference,source:'excel',sourceAsOf:shipment.sourceAsOf,allowCredit:authority?.value.allowCredit===true},actorId,{allowUnknownDate:!occurredOn});
    collections.push(result);
    await saveLink(tx,batch.sourceId,'collection',values.collectionExternalId || externalKey,result.id,actorId,batch.id);
    await audit(tx,{entityType:'import_collection',entityId:result.id,actorId,next:{...economicReference(batch,group,shipment.rowRefs),amountMinor:amount,sourceAsOf:shipment.sourceAsOf},source:'excel'});
  }
  if (!eventMode && (!prior || shipment.sourceAsOf > prior.sourceAsOf)) {
    target = await updateShipmentData(tx,target,{collectionObservations:{...(target.collectionObservations || {}),[batch.sourceId]:{amountMinor:values.collectedAmount,sourceAsOf:shipment.sourceAsOf,collectionIds:[...(prior?.collectionIds || []),...collections.map(collection=>collection.id)]}}});
  }
  return {collections,changed:amount>0 && !before || !eventMode && (!prior || shipment.sourceAsOf>prior.sourceAsOf)};
}
function unresolvedSignature(lines) {
  const fields=['shipmentId','externalOrderId','externalShipmentId','externalCollectionId','tracking','carrier','reference','grossMinor','netMinor','shippingOutCostMinor','shippingReturnCostMinor','platformFeeMinor','insuranceCostMinor'];
  return hash(lines.map(line=>Object.fromEntries(fields.map(field=>[field,line[field]??null]))).sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b))));
}
function addSettlementPart(partsByKey,batch,values,part) {
  const key=settlementIdentity(batch.sourceId,values);
  const parts=partsByKey.get(key)||[], old=parts.find(old=>old.partKey===part.partKey);
  if(old) {
    for(const field of ['settlementGross','settlementNet','settlementDate','settlementReference'])if(old.values[field]!=null && values[field]!=null && hash(old.values[field])!==hash(values[field]))fail(`La liquidación repite ${field} con valores contradictorios.`,409);
    old.values={...values,...old.values};old.collectionIds=[...new Set([...old.collectionIds,...part.collectionIds])];old.expenseIds=[...new Set([...old.expenseIds,...part.expenseIds])];
  } else parts.push({...part,values});
  partsByKey.set(key,parts);
}
async function applyGroup(tx,batch,group,revision,actorId) {
  const before = Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
  await checkTargets(tx,batch,group);
  if(group.kind==='expenses'){
    const expenseIds=[];let created=false,changed=false;
    for(const expense of group.expenses){
      let id=expense.existingId;
      if(!expense.unchanged){
        const authority=findResolution(group.resolutions,'review_authority',group,expense.rowRefs[0]);
        const saved=await recordExpenseTx(tx,{...expense.input,...(id?{id,version:expense.version}:{}),reason:authority?.reason || 'Gasto confirmado desde Excel',reviewConfirmed:!!authority},actorId);
        id=saved.id;created ||= !expense.existingId;changed ||= !saved.observationIgnored;
        await audit(tx,{entityType:'import_expense',entityId:id,actorId,next:{...economicReference(batch,group,expense.rowRefs),externalId:expense.externalId,column:group.rows[0].config.columns.find(column=>column.destination==='expenseAmount')?.index ?? null},reason:authority?.reason,source:'excel'});
      }
      expenseIds.push(id);
    }
    const result={state:created?'created':changed?'updated':'unchanged',units:[],expenseIds,settlementParts:[],revision:revision.revision};
    await saveAppliedRows(tx,batch,group,revision,result,actorId);
    return result;
  }
  for (const resolution of group.resolutions) if (['link_product','link_person'].includes(resolution.action)) {
    const type = resolution.action.slice(5), row = await rawById(tx,type==='product'?'records':'people',resolution.internalId);
    if (!row || type==='product' && !['products','combos'].includes(row.kind)) fail('El destino del alias no existe.',404);
    await saveLink(tx,batch.sourceId,type,resolution.externalKey,resolution.internalId,actorId,batch.id);
  }
  let created = false, informationChanged = false;
  const appliedUnits = [], settlementParts = new Map();
  const source = await requireSource(tx,batch.sourceId);
  for (const original of group.units) {
    const unit = structuredClone(original);
    let order = unit.orderId ? await loadOrderData(tx,unit.orderId) : null;
    const newOrder=!order,eventClassifications=[];
    if (unit.input) {
      if (!order) {order = await saveOrderTx(tx,{...unit.input,requestId:hash([batch.sourceId,revision.previewHash,group.key,unit.key])},actorId,null,null,{deferInventory:true});created=true;}
      else if (unit.commercialReason) order = await saveOrderTx(tx,{...unit.input,reason:unit.commercialReason},actorId,order.id,order.version,{deferInventory:true});
    }
    if (order) {
      order = await applyPolicy(tx,await loadOrderData(tx,order.id),unit.policy,actorId,batch.id);unit.orderId=order.id;
      if(unit.informationChanged){order.importedFields=unit.importedFields;await persistOrderData(tx,order,{actorId,source:'excel',reason:'Información importada confirmada'});informationChanged=true;order=await loadOrderData(tx,order.id);}
      const costs=(unit.lineCosts || []).filter(cost=>{const line=order.items.find(line=>line.lineId===cost.lineId);return line && (line.unitCostMinor!==cost.unitCostMinor || cost.components && hash(line.components.map(({productId,unitCostMinor})=>({productId,unitCostMinor})))!==hash(cost.components));});
      if(costs.length){await completeOrderCostsTx(tx,{orderId:order.id,version:order.version,lineCosts:costs,reason:unit.lineCostReason || 'Costo histórico confirmado desde Excel'},actorId);order=await loadOrderData(tx,order.id);}
      await saveLink(tx,batch.sourceId,'order',unit.values.externalOrderId || (unit.oneOrderPerGuide ? unit.key : null),order.id,actorId,batch.id);
      await audit(tx,{entityType:'import_order',entityId:order.id,actorId,next:economicReference(batch,group,unit.rowRefs),source:'excel'});
    }
    const unitResult = {orderId:order?.id || null,shipmentIds:[],collectionIds:[],expenseIds:[]};
    for (const observed of [...unit.shipments].sort((a,b)=>Number(!a.existingId)-Number(!b.existingId) || (a.assignments || []).reduce((sum,line)=>sum+line.quantity,0)-(b.assignments || []).reduce((sum,line)=>sum+line.quantity,0))) {
      let shipment = observed.existingId ? await refreshShipment(tx,observed.existingId) : null;
      const values = observed.values;
      const linkResolution = findResolution(group.resolutions,'link_shipment',group,observed.rowRefs[0],values.externalShipmentId || shipmentKey(values));
      if (!shipment) {
        if (!values.externalShipmentId && !values.tracking) {
          for(const financial of observed.financial)if(financial.values.settlementExternalId || financial.values.settlementNet!=null)addSettlementPart(settlementParts,batch,financial.values,{shipmentId:null,orderId:unit.orderId,sourceIdentity:observed.key,partKey:`${unit.key}:${observed.key}`,rowNumber:financial.rowNumbers[0],collectionIds:[],expenseIds:[]});
          if(order || observed.financial.some(financial=>financial.values.settlementExternalId || financial.values.settlementNet!=null))continue;
          fail('Identifica el envío antes de importar.');
        }
        const assignments = observed.assignments || linkResolution?.value?.assignments || undefined;
        shipment = await saveShipmentTx(tx,{orderId:order?.id || null,platformId:source.platformId,sourceId:batch.sourceId,externalId:values.externalShipmentId || null,carrier:values.carrier || '',tracking:values.tracking || '',estimatedDeliveryOn:on(values.estimatedDeliveryOn),...(assignments ? {assignments} : {}),source:'excel'},actorId,null,{deferInventory:true});created=true;
      } else if (order && !shipment.orderId) {
        shipment = await linkShipmentTx(tx,{shipmentId:shipment.id,version:shipment.version,orderId:order.id,reason:linkResolution?.reason || 'Vínculo revisado en importación',...(observed.assignments ? {assignments:observed.assignments} : linkResolution?.value?.assignments ? {assignments:linkResolution.value.assignments} : {})},actorId,{deferInventory:true});
      }
      // Blank columns do not erase metadata; logistics are still subject to the
      // shipment domain's post-dispatch freeze and explicit corrections.
      const metadata = {}, recent = !observed.sourceAsOf || !shipment.sourceAsOf || observed.sourceAsOf >= shipment.sourceAsOf;
      if (recent) {
        for (const field of ['carrier','tracking']) if (values[field] && values[field] !== shipment[field]) metadata[field]=values[field];
        if (values.estimatedDeliveryOn && on(values.estimatedDeliveryOn)!==shipment.estimatedDeliveryOn) metadata.estimatedDeliveryOn=on(values.estimatedDeliveryOn);
      }
      if(observed.assignments && hash(observed.assignments)!==hash(shipment.assignments))metadata.assignments=observed.assignments;
      if (Object.keys(metadata).length) shipment=await saveShipmentTx(tx,{...metadata,version:shipment.version,source:'excel',reason:'Metadatos logísticos mapeados y revisados'},actorId,shipment.id,{deferInventory:true});
      await saveLink(tx,batch.sourceId,'shipment',values.externalShipmentId || shipmentKey(values),shipment.id,actorId,batch.id);
      const reportCutoff=economicReference(batch,group,observed.rowRefs).reportCutoff;
      const previousCut=shipment.sourceCuts?.[batch.sourceId];
      if (observed.sourceAsOf && reportCutoff && (!previousCut || observed.sourceAsOf>previousCut.sourceAsOf || observed.sourceAsOf===previousCut.sourceAsOf && hash(reportCutoff)!==hash({value:previousCut.value,precision:previousCut.precision}))) {
        const nextCut={...reportCutoff,sourceAsOf:observed.sourceAsOf};
        shipment=await updateShipmentData(tx,shipment,{sourceCuts:{...(shipment.sourceCuts || {}),[batch.sourceId]:nextCut}});
        await audit(tx,{entityType:'shipment_source_cut',entityId:shipment.id,actorId,previous:previousCut || null,next:{sourceId:batch.sourceId,...nextCut},reason:'Corte de origen con su precisión, no fecha inventada del evento',source:'excel'});
      }
      const authority = findResolution(group.resolutions,'review_authority',group,observed.rowRefs[0]);
      const merged = mergeImportedFields(shipment.importedFields || [],observed.importedFields || [],{scope:'shipment',reviewConfirmed:!!authority});
      if (merged.conflicts.length) throw Object.assign(new AppError(merged.conflicts[0].message,409),{code:merged.conflicts[0].code});
      if (merged.changed) {
        const previous = shipment.importedFields || [];
        shipment = await updateShipmentData(tx,shipment,{importedFields:merged.fields});
        informationChanged = true;
        await audit(tx,{entityType:'shipment_import_fields',entityId:shipment.id,actorId,previous,next:{fields:merged.fields,...economicReference(batch,group,observed.rowRefs)},reason:authority?.reason || 'Datos informativos mapeados y revisados de la fuente',source:'excel'});
      }
      for (const event of observed.events) {
        if(event.observationOnly){await audit(tx,{entityType:'shipment_observation',entityId:shipment.id,actorId,next:{...event,...economicReference(batch,group,event.rowRefs || observed.rowRefs)},reason:'Corte anterior discrepante sin rectificar fecha final',source:'excel'});continue;}
        const effective = effectiveShipmentEvents(shipment.events), latest = effective.at(-1);
        const snapshot = !event.occurredAt && !event.occurredOn;
        if (snapshot && latest && event.status === latest.status && event.rawStatus === (latest.rawStatus || '') && (!event.explicitExternalKey || latest.externalKey===event.externalKey) && !authority?.value.correctionOf && event.sourceAsOf >= (latest.sourceAsOf || '')) {
          if (event.sourceAsOf > (shipment.sourceAsOf || '')) {
            await updateVersioned(tx,'shipments',shipment.id,shipment.version,{source_as_of:event.sourceAsOf});
            await audit(tx,{entityType:'shipment_freshness',entityId:shipment.id,actorId,previous:{sourceAsOf:shipment.sourceAsOf},next:{sourceAsOf:event.sourceAsOf,...economicReference(batch,group,observed.rowRefs)},source:'excel'});shipment=await refreshShipment(tx,shipment.id);
          }
        } else {
          const externalKey = shipment.sourceId !== batch.sourceId ? `source:${hash([batch.sourceId,event.externalKey || null,event.status,event.occurredAt,event.occurredOn,!event.occurredAt && !event.occurredOn ? event.sourceAsOf : null,event.detail])}` : event.externalKey;
          shipment=await recordShipmentEventTx(tx,shipment.id,{...event,externalKey,version:shipment.version,source:'excel',correctionOf:authority?.value.correctionOf || null,reason:authority?.reason || event.openingReason || ''},actorId,{deferInventory:true});
          if(newOrder && batch.inventoryOpening && typeof event.inventoryOpeningIncluded==='boolean'){
            const saved=shipment.events.find(saved=>saved.externalKey===externalKey) || [...shipment.events].reverse().find(saved=>saved.status===event.status && saved.occurredOn===event.occurredOn && saved.occurredAt===event.occurredAt);
            if(!saved)fail('No se pudo enlazar la observación de apertura al evento real.',409);
            eventClassifications.push({eventId:saved.id,included:event.inventoryOpeningIncluded,reason:event.openingReason});
          }
        }
      }
      const shipmentExpenseIds = [];
      for (const [field,dateField,category] of IMPORT_COST_FIELDS) if (costIsObserved(observed,field)) {
        const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.id}:${category}`]));
        if (values[field] == null && existing) continue;
        const expense=await recordExpenseTx(tx,{...(existing?{id:existing.id,version:existing.version}:{}),category,amountMinor:values[field] ?? null,...(field === 'insuranceCost' || values[dateField]?{incurredOn:on(values[dateField])}:{}),shipmentId:shipment.id,orderId:order?.id || null,source:'excel',sourceId:batch.sourceId,sourceAsOf:observed.sourceAsOf,reason:authority?.reason || 'Nueva observación de costo de la misma fuente',reviewConfirmed:!!authority},actorId);
        if (expense.id) {shipmentExpenseIds.push(expense.id);unitResult.expenseIds.push(expense.id);await audit(tx,{entityType:'import_expense',entityId:expense.id,actorId,next:economicReference(batch,group,observed.rowRefs),source:'excel'});}
        shipment=await refreshShipment(tx,shipment.id);
      }
      observed.id=shipment.id;
      for (const financial of observed.financial.sort((a,b)=>(a.sourceAsOf||'').localeCompare(b.sourceAsOf||''))) {
        const collected=await importCollections(tx,batch,group,{...financial,id:shipment.id},unit,actorId);
        unitResult.collectionIds.push(...collected.collections.map(collection=>collection.id));
        const values=financial.values;
        if (values.settlementExternalId || values.settlementNet != null || values.settlementGross != null) {
          addSettlementPart(settlementParts,batch,values,{shipmentId:shipment.id,orderId:unit.orderId,sourceIdentity:observed.key,partKey:shipment.id,rowNumber:financial.rowNumbers[0],collectionIds:collected.collections.map(collection=>collection.id),expenseIds:shipmentExpenseIds});
        }
      }
      if (!order) await updateShipmentData(tx,shipment,{importTask:{type:'link_order',batchId:batch.id,rowRefs:observed.rowRefs,message:'Vincular pedido'}});
      unitResult.shipmentIds.push(shipment.id);
    }
    if(order){
      if(newOrder && batch.inventoryOpening)await initializeInventoryOpeningTx(tx,order.id,{on:batch.inventoryOpening.on,sourceId:batch.sourceId,batchId:batch.id,eventClassifications,returnClassifications:[]},actorId);
      await resolveOrderRecognition(tx,order.id,actorId,{source:'excel',reason:'Grupo importado completo'});
    }
    appliedUnits.push(unitResult);
  }
  const after=Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
  const result={state:created?'created':informationChanged || after!==before?'updated':'unchanged',units:appliedUnits,settlementParts:[...settlementParts].flatMap(([key,parts])=>parts.map(part=>({key,...part}))),revision:revision.revision};
  await saveAppliedRows(tx,batch,group,revision,result,actorId);
  return result;
}
async function saveAppliedRows(tx,batch,group,revision,result,actorId){
  for(const row of group.rows){
    const saved=await tx.db.get(`SELECT data,state FROM ${tx.t('import_rows')} WHERE batch_id=? AND sheet=? AND row_number=?`,[batch.id,row.sheet,row.rowNumber]);
    if(saved?.state==='applied' || saved?.state==='skipped' && JSON.parse(saved.data).applied)continue;
    await tx.db.run(`UPDATE ${tx.t('import_rows')} SET state=?,data=?,version=version+1,updated_at=? WHERE batch_id=? AND sheet=? AND row_number=?`,[row.skipped?'skipped':'applied',JSON.stringify({...JSON.parse(saved.data),errors:[],applied:result,appliedAt:stamp(),acceptedRevision:revision.revision}),stamp(),batch.id,row.sheet,row.rowNumber]);
  }
  for(const resolution of group.resolutions.filter(value=>value.action==='cell_value'))await audit(tx,{entityType:'import_cell',entityId:batch.id,actorId,next:resolution,reason:resolution.reason,source:'excel'});
  await audit(tx,{entityType:'import_group',entityId:`${batch.id}:${group.key}`,actorId,next:{...result,...economicReference(batch,group)},source:'excel'});
}

const settlementScope=(batchId,key)=>`import:${batchId}:settlement:${hash(key).slice(0,40)}`;
const settlementRequest=(revision,key)=>hash(revision.previewHash+'settlement:'+key);
async function selectByIds(tx,table,column,ids) {
  const unique=[...new Set(ids.filter(Boolean))],rows=[];
  for(let offset=0;offset<unique.length;offset+=1000){const chunk=unique.slice(offset,offset+1000);rows.push(...await tx.db.all(`SELECT * FROM ${tx.t(table)} WHERE ${column} IN (${chunk.map(()=>'?').join(',')})`,chunk));}
  return rows.map(entity);
}
async function appliedOutcomes(tx,batchId) {
  const resultJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
  const rows=await tx.db.all(`SELECT entity_key,sheet,row_number,${resultJSON} AS result FROM ${tx.t('import_rows')} WHERE batch_id=? AND state IN ('applied','skipped')`,[batchId]);
  const groups=new Map(),sourceRows=new Map();
  for(const row of rows)if(row.result){const result=groups.get(row.entity_key)|| (typeof row.result==='string'?JSON.parse(row.result):row.result);groups.set(row.entity_key,result);sourceRows.set(rowKey(row.sheet,row.row_number),result);}
  return {groups,sourceRows};
}
const settlementLinesHash=lines=>hash(lines.map(line=>({collectionId:line.collectionId,grossMinor:line.grossMinor,deductions:line.deductions.map(deduction=>({...deduction})).sort((a,b)=>a.expenseId.localeCompare(b.expenseId))})).sort((a,b)=>a.collectionId.localeCompare(b.collectionId)));
async function applySettlementDeclarationTx(tx,batch,declaration,revision,actorId) {
  const key=declaration.key, existing=entity(await tx.db.get(`SELECT * FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,key])]));
  if((existing?.id || null)!==declaration.target.id || (existing?.version || null)!==declaration.target.version)fail('La liquidación cambió después de la revisión. Revisa la declaración sin sobrescribirla.',409);
  if(declaration.errors.length)fail(declaration.errors[0].message,409);
  const outcomes=await appliedOutcomes(tx,batch.id),parts=[];
  for(const ref of declaration.refs) {
    const outcome=outcomes.groups.get(ref.groupKey)||outcomes.sourceRows.get(rowKey(ref.sheet,ref.rowNumbers[0]));
    const applied=outcome?.settlementParts?.find(part=>part.key===key && part.sourceIdentity===ref.sourceIdentity);
    parts.push({...ref,values:ref.values,shipmentId:applied?.shipmentId || null,collectionIds:applied?.collectionIds || [],expenseIds:applied?.expenseIds || [],applied:!!applied});
  }
  const values=repeated(parts,['settlementNet','settlementDate','settlementReference'],[],'Liquidación');
  if(values.settlementNet==null)fail('La liquidación necesita neto declarado; no se inventará su importe.');
  const shipmentIds=parts.map(part=>part.shipmentId), shipments=new Map((await selectByIds(tx,'shipments','id',shipmentIds)).map(shipment=>[shipment.id,shipment]));
  const facts=await selectByIds(tx,'order_collections','shipment_id',shipmentIds), reversed=new Set(facts.map(fact=>fact.reversalOf).filter(Boolean)),factsByShipment=new Map();
  for(const fact of facts)if(fact.kind==='receipt' && fact.holder==='platform' && fact.sourceId===batch.sourceId && !reversed.has(fact.id)){const list=factsByShipment.get(fact.shipmentId)||[];list.push(fact);factsByShipment.set(fact.shipmentId,list);}
  for(const list of factsByShipment.values())list.sort((a,b)=>(a.occurredOn || '').localeCompare(b.occurredOn || '')||a.id.localeCompare(b.id));
  const expenses=new Map((await selectByIds(tx,'expenses','id',parts.flatMap(part=>part.expenseIds))).map(expense=>[expense.id,expense]));
  const lines=[],unresolvedLines=[],usedCollections=new Set(),usedExpenses=new Set();
  for(const part of parts) {
    const available=part.applied?(factsByShipment.get(part.shipmentId)||[]).filter(fact=>!part.collectionExternalIds.length || part.collectionExternalIds.includes(fact.externalId)):[];
    let gross=part.values.settlementGross ?? available.reduce((sum,fact)=>sum+Number(fact.amountMinor),0);
    const deductions=[];
    for(const id of part.expenseIds)if(!usedExpenses.has(id)){const expense=expenses.get(id);if(expense && expense.shipmentId===part.shipmentId && expense.amountMinor){deductions.push({expenseId:id,amountMinor:expense.amountMinor});usedExpenses.add(id);}}
    let first=true;
    for(const fact of available)if(!usedCollections.has(fact.id) && (gross>0 || first && deductions.length)){const amount=Math.min(gross,Number(fact.amountMinor));lines.push({collectionId:fact.id,grossMinor:amount,deductions:first?deductions:[]});gross-=amount;first=false;usedCollections.add(fact.id);}
    if(gross>0 || first && deductions.length || !available.length)unresolvedLines.push({shipmentId:shipments.get(part.shipmentId)?.sourceId===batch.sourceId?part.shipmentId:null,externalOrderId:part.values.externalOrderId || null,externalShipmentId:part.values.externalShipmentId || null,externalCollectionId:part.values.collectionExternalId || null,tracking:part.values.tracking || null,carrier:part.values.carrier || null,reference:part.values.settlementReference || part.values.settlementExternalId || key,grossMinor:part.values.settlementGross==null?null:gross,netMinor:part.values.settlementNet ?? null,shippingOutCostMinor:part.values.shippingOutCost ?? null,shippingReturnCostMinor:part.values.shippingReturnCost ?? null,platformFeeMinor:part.values.platformFee ?? null,insuranceCostMinor:part.values.insuranceCost ?? null,batchId:batch.id,groupKey:part.groupKey,sheet:part.sheet,rowNumber:part.rowNumbers[0]});
  }
  lines.sort((a,b)=>a.collectionId.localeCompare(b.collectionId));for(const line of lines)line.deductions.sort((a,b)=>a.expenseId.localeCompare(b.expenseId));
  const same=existing && settlementLinesHash(existing.lines)===settlementLinesHash(lines) && unresolvedSignature(existing.unresolvedLines || [])===unresolvedSignature(unresolvedLines) && existing.netMinor===values.settlementNet && existing.reportedOn===on(values.settlementDate);
  let settlement=existing;
  if(!same) {
    const resolving=existing?.unresolvedLines?.length && existing.netMinor===values.settlementNet && existing.reportedOn===on(values.settlementDate);
    if(existing && !declaration.authority && !resolving)fail('La liquidación externa tiene otros importes o vínculos. Revisa la autoridad con motivo.',409);
    const sourceCut=declaration.refs.map(ref=>sourceAsOf(ref.values,batch.config.sheets.find(sheet=>sheet.sheetName===ref.sheet) || {})).filter(Boolean).sort().at(-1) || null;
    settlement=await saveSettlementTx(tx,{...(existing?{id:existing.id,version:existing.version,reason:declaration.authority?.reason || 'Vínculos pendientes resueltos mediante revisión aceptada'}:{}),sourceId:batch.sourceId,externalKey:key,reportedOn:on(values.settlementDate),netMinor:values.settlementNet,lines,source:'excel',sourceAsOf:sourceCut,reconciliationRequired:unresolvedLines.length>0,unresolvedLines},actorId);
  }
  await saveLink(tx,batch.sourceId,'settlement',key,settlement.id,actorId,batch.id);
  await audit(tx,{entityType:'import_settlement',entityId:settlement.id,actorId,next:{batchId:batch.id,revision:revision.revision,groupKeys:[...new Set(declaration.refs.map(ref=>ref.groupKey))],fileHash:batch.fileHash,unresolvedCount:unresolvedLines.length},source:'excel'});
  return {state:existing?same?'unchanged':'updated':'created',settlementId:settlement.id,key,unresolvedCount:unresolvedLines.length};
}
async function settlementOutcomes(tx,batchId,revision) {
  const prefix=`import:${batchId}:settlement:`,rows=await tx.db.all(`SELECT scope,request_id,result_json FROM ${tx.t('business_requests')} WHERE scope LIKE ? ESCAPE '!'`,[prefix.replace(/[!%_]/g,c=>'!'+c)+'%']);
  const results=new Map(),byRequest=new Map(rows.map(row=>[`${row.scope}:${row.request_id}`,JSON.parse(row.result_json)]));
  for(const declaration of revision.settlements || []){const result=byRequest.get(`${settlementScope(batchId,declaration.key)}:${settlementRequest(revision,declaration.key)}`);if(result)results.set(declaration.key,result);}
  const batch=await tx.db.get(`SELECT data FROM ${tx.t('import_batches')} WHERE id=?`,[batchId]),issues=Object.values(JSON.parse(batch.data).settlementIssues || {}).filter(issue=>issue.revision===revision.revision);
  return {results,issues};
}
async function readImportWorkbook(store,batch,mode,onProgress) {
  const bytes=Buffer.from(batch.bytes,'base64'),catalog=batch.workbook?.sheets && !batch.workbook.sheetName?batch.workbook:await readExcel(bytes,{filename:batch.filename,mode:'catalog'}),config=validateImportConfig(batch.config,{allowDuplicateDestinations:mode==='inspect'});
  const workbooks=[],errors=[],warnings=[],selected=config.sheets.filter(sheet=>sheet.enabled);
  let selectedRows=0;
  for(let index=0;index<selected.length;index++){
    const sheet=selected[index];
    if(onProgress)await onProgress({sheetName:sheet.sheetName,index,total:selected.length});
    try{
      const workbook=await readExcel(bytes,{filename:batch.filename,sheetName:sheet.sheetName,headerRow:sheet.headerRow,mode});
      selectedRows+=workbook.rows.filter(row=>row.rowNumber>sheet.headerRow).length;
      if(mode==='rows' && selectedRows>50000)throw configurationError('El libro supera 50.000 filas seleccionadas. Divide la incorporación.','IMPORT_BOOK_ROWS',{sheet:sheet.sheetName});
      workbooks.push(workbook);warnings.push(...(workbook.warnings || []));
    }catch(error){
      if(!error.status || error.status>=500 || FILE_ERRORS.has(error.code) && !['EXCEL_CONTENT_LIMIT','EXCEL_FORMULA_NO_CACHE','EXCEL_IDENTIFIER_PRECISION'].includes(error.code) || error.code==='IMPORT_BOOK_ROWS')throw error;
      errors.push(errorRecord(error,{sheet:sheet.sheetName,rowNumber:sheet.headerRow}));
    }
  }
  return {catalog,workbooks,errors,warnings};
}
async function leasedUpdate(store,lease,clock,fn) {
  return store.transaction(async tx=>{await tx.lockWrites();await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});const result=await fn(tx);await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});return result;});
}
export async function processImportTurn(store,{batchId = null,maxGroups = 25,now = stamp()} = {}) {
  maxGroups=integer(maxGroups,'Grupos por turno',1,25);
  const lease=await claimJob(store,{...(batchId?{key:`import:${text(batchId,'Lote',100,true)}`}:{prefix:'import:'}),now});
  if (!lease) return {processed:0,hasMore:false,batchId:batchId || null,state:null};
  let processed=0;
  try {
    return await withLeaseHeartbeat(store,lease,async ({clock,assertActive})=>{
    try {
      let batch=await requireBatch(store,lease.batchId);
      if (lease.phase==='inspect' || lease.phase==='preview') {
        if (!batch.bytes) fail('Archivo original vencido. Crea una importación nueva.',409);
        const parsed=await readImportWorkbook(store,batch,lease.phase==='inspect'?'inspect':'rows',async progress=>{assertActive();await leasedUpdate(store,lease,clock,async tx=>{await updateJobProgressTx(tx,lease,{progress:{phase:lease.phase,...progress}},{now:clock()});});});
        assertActive();
        await assertLease(store,{key:lease.key,token:lease.token,now:clock()});
        if (lease.phase==='inspect') await leasedUpdate(store,lease,clock,async tx=>{
          const current=await requireBatch(tx,batch.id);
          const config=validateImportConfig(current.config || {},{allowDuplicateDestinations:true}),workbook={...parsed.catalog,inspections:parsed.workbooks,errors:parsed.errors,suggestions:suggestWorkbookImports(parsed.catalog,config)};
          await changeBatch(tx,current,{state:'review'},{config,workbook,error:null,progress:{phase:'columns',processed:parsed.workbooks.length,total:parsed.workbooks.length}});
          await updateJobProgressTx(tx,lease,{progress:{phase:'columns'}},{now:clock()});
        });
        else {
          const config=validateImportConfig(batch.config),rows=[],sourceHeaders={},effectiveConfig=structuredClone(config),sheetErrors=[...parsed.errors];
          for(const workbook of parsed.workbooks){
            const sheet=config.sheets.find(sheet=>sheet.sheetName===workbook.sheetName);
            try{
              const normalized=normalizeRows(workbook,sheet,batch.resolutions || [],batch.filename);
              if(!normalized.length)parsed.warnings.push({code:'IMPORT_EMPTY_ROWS',message:'La hoja seleccionada está vacía o solo tiene encabezados; no genera operaciones.',sheet:sheet.sheetName,rowNumber:sheet.headerRow});
              rows.push(...normalized);
              const headers=workbook.rows.find(row=>row.rowNumber===sheet.headerRow).cells.map(cell=>cell?.text || String(cell?.value ?? '')),resolved=resolveColumns(workbook,sheet,{includeIgnored:true});
              Object.defineProperty(sourceHeaders,sheet.sheetName,{value:headers,enumerable:true});
              effectiveConfig.sheets[config.sheets.indexOf(sheet)]={...sheet,columns:resolved.map(column=>({...column,header:normalizeHeader(headers[column.index] ?? column.header)}))};
            }catch(error){if(!error.status || error.status>=500)throw error;sheetErrors.push(errorRecord(error,{sheet:sheet.sheetName,rowNumber:sheet.headerRow}));}
          }
          if(rows.length>50000)throw configurationError('El libro supera 50.000 filas seleccionadas.','IMPORT_BOOK_ROWS',{});
          await store.readSnapshot(tx=>prepareIdentities(tx,batch,rows,batch.resolutions || []));
          const applied=await store.readSnapshot(async tx=>{const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;return new Set((await tx.db.all(`SELECT sheet,row_number FROM ${tx.t('import_rows')} WHERE batch_id=? AND (state='applied' OR (state='skipped' AND ${appliedJSON} IS NOT NULL))`,[batch.id])).map(row=>rowKey(row.sheet,row.row_number)));});
          const groups=[...groupRows(rows.filter(row=>['orders','tracking','settlements'].includes(row.config.purpose)),config),...expenseGroups(rows.filter(row=>row.config.purpose==='expenses'))];
          attachAuxiliaryRows(groups,rows.filter(row=>['allocations','component_costs','observations'].includes(row.config.purpose)));
          for(let offset=0;offset<groups.length;offset+=5){await store.readSnapshot(async tx=>{await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});for(const group of groups.slice(offset,offset+5))await (group.kind==='expenses'?prepareExpenseGroup(tx,batch,group,batch.resolutions || [],applied):prepareGroup(tx,batch,group,config,batch.resolutions || [],applied));});assertActive();await new Promise(resolve=>setImmediate(resolve));}
          for(const error of sheetErrors){const row={sheet:error.sheet,rowNumber:error.rowNumber || 1,config:config.sheets.find(sheet=>sheet.sheetName===error.sheet),values:{},lines:[],source:[],errors:[error],warnings:[]};groups.push({kind:'commercial',key:`sheet-error:${hash(error.sheet)}`,sheet:error.sheet,rowNumbers:[row.rowNumber],rowRefs:rowRefs([row]),rows:[row],units:[],identityKeys:[],errors:[error],warnings:[],tasks:[],targets:[],identities:[],resolutions:[],state:'rejected'});}
          validateSettlementDeclarations(groups,batch.sourceId);
          const inventory=await store.readSnapshot(tx=>prepareInventoryPreview(tx,batch,groups));
          if(!groups.length || groups.every(group=>['skipped','applied'].includes(group.state)))parsed.warnings.push({code:'IMPORT_EMPTY_ROWS',message:'No hay operaciones pendientes: las hojas están vacías, contienen filas de plantilla omitidas o sus registros ya fueron aplicados. Revisa la selección y las asignaciones.'});
          const previewHash=previewSignature({...batch,config:effectiveConfig},groups),preview={previewHash,summary:{...summaryFor(groups),settlementsPending:Object.keys(batch.settlementIssues || {}).length},groups:groups.map(publicGroup),warnings:parsed.warnings,inventory,sheets:config.sheets.map(sheet=>({sheetName:sheet.sheetName,enabled:sheet.enabled,groups:groups.filter(group=>group.rowRefs.some(ref=>ref.sheet===sheet.sheetName)).map(group=>({key:group.key,kind:group.kind,state:group.state})),errors:sheetErrors.filter(error=>error.sheet===sheet.sheetName)}))};
          await leasedUpdate(store,lease,clock,async tx=>{
            const current=await requireBatch(tx,batch.id);
            if (hash(current.config)!==hash(batch.config) || hash(current.resolutions)!==hash(batch.resolutions)) fail('La configuración cambió durante la revisión.',409);
            await savePreviewRows(tx,current,groups,clock());
            await changeBatch(tx,current,{state:'review'},{config:effectiveConfig,sourceHeaders,preview,previewGroups:groups,sourceRowCount:rows.length,error:null,progress:{phase:'review',processed:groups.length,total:groups.length}});
            await updateJobProgressTx(tx,lease,{progress:{phase:'review',total:groups.length}},{now:clock()});
          });
        }
        await finishJob(store,lease,{state:'succeeded',now:clock()});
        return await importTurnOutcome(store,{processed:0,batchId:batch.id,state:'review'},clock());
      }
      const row=await store.db.get(`SELECT * FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=?`,[batch.id,lease.revision]);
      if (!row) fail('No existe la revisión inmutable aceptada.',409);
      const revision=decodeImportRevision({...JSON.parse(row.data),revision:row.revision,previewHash:row.preview_hash});
      if (revision.fileHash!==batch.fileHash) fail('El archivo no corresponde a la revisión aceptada.',409);
      // Never consume mutable config, resolutions or actor from the current batch.
      batch={...batch,sourceId:revision.sourceId,config:revision.config,resolutions:revision.resolutions,profileId:revision.profileId,profileVersion:revision.profileVersion,inventoryOpening:revision.inventoryOpening || null};
      await leasedUpdate(store,lease,clock,async tx=>{const current=await requireBatch(tx,batch.id);if(current.state!=='applying')await changeBatch(tx,current,{state:'applying'});});
      const actorId=row.actor_id, outcomes=[];
      for (const group of revision.groups) {
        assertActive();
        const pending=await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('import_rows')} WHERE batch_id=? AND entity_key=? AND state NOT IN ('applied','skipped','conflict','rejected')`,[batch.id,group.key]);
        if (!Number(pending.n)) continue;
        if (processed>=maxGroups) break;
        try {
          const result=await runCommand(store,{scope:`import:${batch.id}:${group.key}`,requestId:hash(revision.previewHash+group.key),payload:{revision:revision.revision,previewHash:revision.previewHash,group},actorId,lease:{key:lease.key,token:lease.token,now:clock()}},tx=>applyGroup(tx,batch,group,revision,actorId));
          outcomes.push(result);
        } catch (error) {
          if (!error.status || error.status>=500) throw error;
          await leasedUpdate(store,lease,clock,async tx=>{
            for (const sourceRow of group.rows) {
              const saved=await tx.db.get(`SELECT data,state FROM ${tx.t('import_rows')} WHERE batch_id=? AND sheet=? AND row_number=?`,[batch.id,sourceRow.sheet,sourceRow.rowNumber]);
              if (!saved || ['applied','skipped'].includes(saved.state)) continue;
              await tx.db.run(`UPDATE ${tx.t('import_rows')} SET state=?,data=?,version=version+1,updated_at=? WHERE batch_id=? AND sheet=? AND row_number=?`,[error.status===409?'conflict':'rejected',JSON.stringify({...JSON.parse(saved.data),errors:[errorRecord(error)],acceptedRevision:revision.revision}),clock(),batch.id,sourceRow.sheet,sourceRow.rowNumber]);
            }
          });
          outcomes.push({state:'error'});
        }
        processed++;
        await new Promise(resolve=>setImmediate(resolve));
      }
      let progress=await durableProgress(store,batch.id,revision);
      if(progress.groupsProcessed===progress.groupsTotal && processed<maxGroups) {
        const completed=await settlementOutcomes(store,batch.id,revision);
        for(const declaration of revision.settlements || []) {
          if(processed>=maxGroups)break;
          if(completed.results.has(declaration.key) || completed.issues.some(issue=>issue.key===declaration.key))continue;
          assertActive();
          try {
            await runCommand(store,{scope:settlementScope(batch.id,declaration.key),requestId:settlementRequest(revision,declaration.key),payload:{revision:revision.revision,previewHash:revision.previewHash,declaration},actorId,lease:{key:lease.key,token:lease.token,now:clock()}},tx=>applySettlementDeclarationTx(tx,batch,declaration,revision,actorId));
          } catch(error) {
            if(!error.status || error.status>=500)throw error;
            await leasedUpdate(store,lease,clock,async tx=>{
              const current=await requireBatch(tx,batch.id),issue={key:declaration.key,revision:revision.revision,error:errorRecord(error),refs:declaration.refs.map(ref=>({sheet:ref.sheet,rowNumbers:ref.rowNumbers,groupKey:ref.groupKey}))};
              await changeBatch(tx,current,{}, {settlementIssues:{...(current.settlementIssues || {}),[hash(declaration.key)]:issue}});
            });
          }
          processed++;await new Promise(resolve=>setImmediate(resolve));
        }
        progress=await durableProgress(store,batch.id,revision);
      }
      const hasPending=progress.processed<progress.total;
      const state=hasPending?'queued':progress.errors?'completed_with_errors':'completed';
      await leasedUpdate(store,lease,clock,async tx=>{
        const current=await requireBatch(tx,batch.id);
        await changeBatch(tx,current,{state,expires_at:hasPending?current.expiresAt:new Date(Date.parse(clock())+90*86400000).toISOString()},{progress,finishedAt:hasPending?current.finishedAt || null:clock(),completedAt:hasPending?current.completedAt || null:clock(),error:null});
        await updateJobProgressTx(tx,lease,{progress},{now:clock()});
      });
      await finishJob(store,lease,{state:hasPending?'queued':'succeeded',data:{progress},now:clock()});
      return await importTurnOutcome(store,{processed,batchId:batch.id,state,hasMore:hasPending || undefined},clock());
    } catch (error) {
      if (isImportAvailabilityError(error)) {
        // Only evidenced availability failures retry automatically. Accepted
        // revisions and already-applied commands remain intact.
        await finishJob(store,lease,{state:'queued',errorCode:'IMPORT_UNAVAILABLE',now:clock()});
        return await importTurnOutcome(store,{processed,batchId:lease.batchId,state:'queued',hasMore:true},clock());
      }
      const state=lease.phase==='preview'?'review':'failed';
      await leasedUpdate(store,lease,clock,async tx=>{
        const batch=await requireBatch(tx,lease.batchId);
        const location=error.location || {};
        const diagnostic=errorRecord(error,{phase:lease.phase,...location});
        await changeBatch(tx,batch,{state},{...(['inspect','preview'].includes(lease.phase)?{preview:null,previewGroups:null}:{}),error:diagnostic,progress:{...(batch.progress || {}),error:diagnostic}});
      });
      await finishJob(store,lease,{state:'failed',errorCode:!error.status || error.status>=500?'IMPORT_INTERNAL':error.code || 'IMPORT_DATA',now:clock()});
      if (!error.status) throw error;
      return await importTurnOutcome(store,{processed,batchId:lease.batchId,state},clock());
    }
    },{now});
  } catch(error) {
    if(error.status===409) {
      const current=await store.db.get(`SELECT state FROM ${store.t('import_batches')} WHERE id=?`,[lease.batchId]);
      if(current?.state==='cancelled')return await importTurnOutcome(store,{processed,batchId:lease.batchId,state:'cancelled'},stamp());
      if(lease.phase==='inspect'&&['uploaded','previewing','review'].includes(current?.state)){
        const active=await store.db.get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`,[lease.key]);
        if(active&&active.lease_token!==lease.token)return await importTurnOutcome(store,{processed,batchId:lease.batchId,state:current.state},stamp());
      }
    }
    throw error;
  }
}
async function durableProgress(tx,batchId,revision) {
  const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
  const rows=await tx.db.all(`SELECT entity_key,sheet,row_number,state,${appliedJSON} AS applied FROM ${tx.t('import_rows')} WHERE batch_id=?`,[batchId]), groups=new Map(), selection=new Set(revision.selection);
  for (const row of rows) {if (!selection.has(row.entity_key) || row.state==='skipped') continue;const old=groups.get(row.entity_key)||{states:[],result:null};old.states.push(row.state);if(row.state==='applied')old.result=typeof row.applied==='string'?JSON.parse(row.applied):row.applied;groups.set(row.entity_key,old);}
  const progress={phase:'apply',processed:0,total:revision.selection.length+(revision.settlements || []).length,groupsTotal:revision.selection.length,groupsProcessed:0,settlementsTotal:(revision.settlements || []).length,settlementsProcessed:0,created:0,updated:0,unchanged:0,errors:revision.omitted.length,omitted:revision.omitted.length};
  for (const group of groups.values()) {
    if (group.states.every(state=>state==='applied')) {progress.processed++;const key=group.result?.state==='created'?'created':group.result?.state==='unchanged'?'unchanged':'updated';progress[key]++;}
    else if (group.states.some(state=>['conflict','rejected'].includes(state))) {progress.processed++;progress.errors++;}
  }
  progress.groupsProcessed=progress.processed;
  const declarations=await settlementOutcomes(tx,batchId,revision);
  progress.settlementsProcessed=declarations.results.size+declarations.issues.length;
  progress.processed+=progress.settlementsProcessed;progress.errors+=declarations.issues.length;
  progress.settlementIssues=declarations.issues.map(({key,error})=>({key,...error}));
  for(const result of declarations.results.values())progress[result.state]=(progress[result.state]||0)+1;
  const sheets=new Map(),orderIds=new Set(),shipmentIds=new Set(),expenseIds=new Set();
  for(const group of revision.groups){
    const outcome=groups.get(group.key),state=outcome?.states.every(state=>state==='applied')?outcome.result?.state || 'updated':'pending';
    for(const sheetName of new Set(group.rowRefs.map(ref=>ref.sheet))){
      const summary=sheets.get(sheetName)||{sheetName,commercial:{created:0,updated:0,unchanged:0,omitted:0,pending:0},expenses:{created:0,updated:0,unchanged:0,omitted:0,pending:0}};
      summary[group.kind || 'commercial'][state]=(summary[group.kind || 'commercial'][state] || 0)+1;sheets.set(sheetName,summary);
    }
    for(const unit of outcome?.result?.units || []){
      if(unit.orderId)orderIds.add(unit.orderId);
      for(const id of unit.shipmentIds || [])shipmentIds.add(id);
      for(const id of unit.expenseIds || [])expenseIds.add(id);
    }
    for(const id of outcome?.result?.expenseIds || [])expenseIds.add(id);
  }
  for(const key of revision.omitted)for(const sheetName of new Set(rows.filter(row=>row.entity_key===key).map(row=>row.sheet))){
    const summary=sheets.get(sheetName)||{sheetName,commercial:{created:0,updated:0,unchanged:0,omitted:0,pending:0},expenses:{created:0,updated:0,unchanged:0,omitted:0,pending:0}};
    const category=key.startsWith('expense-group:')?'expenses':'commercial';summary[category].omitted++;sheets.set(sheetName,summary);
  }
  progress.sheets=[...sheets.values()];progress.orderIds=[...orderIds];progress.shipmentIds=[...shipmentIds];progress.expenseIds=[...expenseIds];
  progress.phase=progress.groupsProcessed<progress.groupsTotal?'apply':progress.settlementsProcessed<progress.settlementsTotal?'settlements':'complete';
  return progress;
}
async function importBacklog(store,now) {return !!await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'import:%' AND (state='queued' OR (state='running' AND lease_until<=?)) LIMIT 1`,[now]);}
async function importTurnOutcome(store,{processed,batchId,state,hasMore},now){
  // A queued retry is a job outcome, not the batch's extraction/apply phase.
  // Only cancellation supersedes that outcome after the backlog lookup;
  // no writes follow this final authoritative cancellation read.
  const backlog=hasMore ?? await importBacklog(store,now);
  const current=await store.db.get(`SELECT state FROM ${store.t('import_batches')} WHERE id=?`,[batchId]);
  return {processed,hasMore:backlog,batchId,state:current?.state==='cancelled'?'cancelled':state};
}
export async function getImportPrepared(store,batchId){
  return store.readSnapshot(async tx=>{
    const batch=await requireBatch(tx,batchId);
    if(!batch.bytes || batch.fileDiscarded || batch.fileExpired)fail('El archivo original ya no está disponible. Vuelve a cargarlo.',404);
    let data;
    if(batch.acceptedRevision){
      const saved=await tx.db.get(`SELECT * FROM ${tx.t('import_revisions')} WHERE batch_id=? AND revision=?`,[batchId,batch.acceptedRevision]);
      if(!saved)fail('No existe la revisión aceptada.',409);
      data=decodeImportRevision(JSON.parse(saved.data));
      const omitted=[];
      for(const row of await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE batch_id=? AND state IN ('rejected','conflict','skipped')`,[batchId])){
        const value=JSON.parse(row.data);
        if(!data.groups.some(group=>group.rowRefs.some(ref=>ref.sheet===row.sheet && ref.rowNumber===row.row_number)))omitted.push({sheet:row.sheet,rowNumber:row.row_number,values:value.normalized?.values || {},errors:value.errors || []});
      }
      data.omitted=omitted;
    }else{
      if(!batch.preview || !batch.previewGroups || previewSignature(batch,batch.previewGroups)!==batch.preview.previewHash)throw Object.assign(new AppError('Genera una revisión actualizada antes de descargar los datos preparados.',409),{code:'IMPORT_PREVIEW_REQUIRED',action:'Revisar'});
      data={formatVersion:2,sourceId:batch.sourceId,config:batch.config,resolutions:batch.resolutions,inventoryOpening:batch.inventoryOpening || null,groups:structuredClone(batch.previewGroups),omitted:[]};
    }
    return {filename:`${batch.filename.replace(/\.[^.]+$/,'')} - preparado.xlsx`,data};
  });
}
export async function downloadImportOriginal(store,batchId) {
  const batch=await requireBatch(store,batchId);
  if(batch.fileDiscarded)fail('El archivo original fue descartado al cancelar la importación.',404);
  if (!batch.bytes) fail(batch.fileHash?'Archivo original vencido.':'Todavía no se cargó el archivo original.',404);
  const types={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',xlsb:'application/vnd.ms-excel.sheet.binary.macroEnabled.12',xlsm:'application/vnd.ms-excel.sheet.macroEnabled.12'};
  return {bytes:Buffer.from(batch.bytes,'base64'),filename:batch.filename,contentType:types[batch.filename.split('.').at(-1).toLowerCase()]};
}
export async function exportImportErrors(store,batchId) {
  return store.readSnapshot(async tx=>{
    const batch=await requireBatch(tx,batchId), rows=await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE batch_id=? ORDER BY sheet,row_number`,[batchId]), documentErrors=new Map();
    for(const issue of Object.values(batch.settlementIssues || {}))for(const ref of issue.refs)for(const number of ref.rowNumbers){const key=rowKey(ref.sheet,number),errors=documentErrors.get(key)||[];errors.push(issue.error);documentErrors.set(key,errors);}
    const decoded=rows.filter(row=>['conflict','rejected'].includes(row.state) || documentErrors.has(rowKey(row.sheet,row.row_number))).map(row=>{const decoded=JSON.parse(row.data);return {...row,decoded:{...decoded,errors:[...(decoded.errors || []),...(documentErrors.get(rowKey(row.sheet,row.row_number))||[])]}};});
    const width=Math.max(0,...decoded.map(row=>(row.decoded.source || []).length));
    const header=Array.from({length:width},(_,index)=>`Columna ${index+1}`);
    const output=[['Hoja','Fila','Grupo','Estado','Motivo',...header]];
    for (const row of decoded) output.push([row.sheet,row.row_number,row.entity_key,row.state,(row.decoded.errors || []).map(error=>error.message).join('; '),...Array.from({length:width},(_,index)=>{const cell=row.decoded.source?.[index];return cell?.text || (cell?.value==null?'':String(cell.value));})]);
    return writeExcelSheets([{name:'Excepciones',rows:output},{name:'Origen',rows:[['Archivo','SHA256','Cuenta'],[batch.filename,batch.fileHash,batch.sourceId]]}]);
  });
}
export async function expireImportFiles(store,{now=stamp(),maxBatches=25,lease=null,clock=null}={}) {
  now=instant(now);maxBatches=integer(maxBatches,'Archivos por turno',1,25);
  const started=Date.now(),origin=Date.parse(now);
  clock=clock || (()=>new Date(origin+Date.now()-started).toISOString());
  return store.transaction(async tx=>{
    await tx.lockWrites();
    if(lease)await assertLease(tx,{...lease,now:clock()});
    const where="file_bytes_base64 IS NOT NULL AND expires_at<=? AND state NOT IN ('queued','applying','previewing')";
    const batches=await tx.db.all(`SELECT id,state,version,file_hash,data FROM ${tx.t('import_batches')} WHERE ${where} ORDER BY expires_at,id LIMIT ?`,[now,maxBatches]);
    for (const row of batches) {
      const batch=entity(row), finished=!!batch.finishedAt || ['completed','completed_with_errors'].includes(batch.state);
      await updateVersioned(tx,'import_batches',batch.id,batch.version,{file_bytes_base64:null,...(!finished?{state:'expired'}:{}),data:JSON.stringify({...JSON.parse(row.data),fileExpired:true,workbook:null,previewGroups:null,expiredAt:now})});
      if (!finished) await tx.db.run(`DELETE FROM ${tx.t('import_rows')} WHERE batch_id=? AND state<>'applied'`,[batch.id]);
      await audit(tx,{entityType:'import_file',entityId:batch.id,actorId:'system',previous:{fileHash:batch.fileHash,retained:true},next:{fileHash:batch.fileHash,retained:false},reason:'Venció la retención del archivo original',source:'retention',recordedAt:now});
      if(lease)await assertLease(tx,{...lease,now:clock()});
    }
    const pending=await tx.db.get(`SELECT id FROM ${tx.t('import_batches')} WHERE ${where} LIMIT 1`,[now]);
    if(lease)await assertLease(tx,{...lease,now:clock()});
    return {expired:batches.length,hasMore:!!pending};
  });
}
