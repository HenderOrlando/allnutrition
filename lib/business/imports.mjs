import { createHash } from 'node:crypto';
import { AppError, fail, integer, text, validateOrder } from '../validation.mjs';
import { assertLease, audit, canonicalJSON, entity, hash, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { businessDate, bogotaDate, instant } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { readExcel, normalizeExcelIdentifier, normalizeExcelMoney, normalizeExcelDate, writeExcelSheets } from './excel.mjs';
import { claimJob, finishJob, queueJobTx, updateJobProgressTx, withLeaseHeartbeat } from './job-leases.mjs';
import { getBusinessSettings, ruleForOrder } from './settings.mjs';
import { loadOrderData, persistOrderData, resolveOrderRecognition, saveOrderTx } from './orders.mjs';
import { effectiveShipmentEvents, linkShipmentTx, recordShipmentEventTx, saveShipmentTx, validateShipmentMetadata, SHIPMENT_STATUSES } from './shipments.mjs';
import { recordCollectionTx } from './collections.mjs';
import { recordExpenseTx } from './expenses.mjs';
import { saveSettlementTx } from './settlements.mjs';

export const IMPORT_DESTINATIONS = Object.freeze(['externalOrderId','internalOrderNumber','externalShipmentId','externalEventId','carrier','tracking','rawStatus','eventAt','reportAsOf','placedOn','labelCreatedAt','collectedAt','estimatedDeliveryOn','deliveredAt','returnAt','customerName','phone','department','city','address','sellerExternalKey','shippingCharge','shippingOutCost','shippingOutCostDate','shippingReturnCost','shippingReturnCostDate','platformFee','platformFeeDate','collectedAmount','collectionDate','collectionExternalId','settlementExternalId','settlementDate','settlementGross','settlementNet','externalLineId','productExternalKey','quantity','unitPrice','lineDiscount','eventDetail','collectionReference','settlementReference']);
const LINE_FIELDS = new Set(['externalLineId','productExternalKey','quantity','unitPrice','lineDiscount']);
const MONEY_FIELDS = new Set(['shippingCharge','shippingOutCost','shippingReturnCost','platformFee','collectedAmount','settlementGross','settlementNet','unitPrice','lineDiscount']);
const DATE_FIELDS = new Set(['eventAt','reportAsOf','placedOn','labelCreatedAt','collectedAt','estimatedDeliveryOn','deliveredAt','returnAt','shippingOutCostDate','shippingReturnCostDate','platformFeeDate','collectionDate','settlementDate']);
const ORDER_FIELDS = ['externalOrderId','internalOrderNumber','placedOn','customerName','phone','department','city','address','sellerExternalKey','shippingCharge'];
const RESOLUTION_ACTIONS = ['link_product','link_person','link_order','link_shipment','duplicate','additional_quantity','status','review_policy','review_authority','accept_formulas','omit_group','commercial_update'];
const LOCKED = new Set(['queued','applying','previewing']);
const PAGE_SIZE = 20;
const MAX_BYTES = 10 * 1024 * 1024;
const normalizeHeader = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ').trim();
const plain = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}: datos no válidos.`); return value; };
const choice = (value, values, label) => { if (!values.includes(value)) fail(`${label}: opción no válida.`); return value; };
const cutoff = value => value == null || value === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(`${businessDate(value)}T05:00:00.000Z`) + 86400000 - 1).toISOString() : instant(value,'Fecha de corte');
const on = value => value?.occurredOn || (value?.occurredAt ? bogotaDate(value.occurredAt) : null);
const observationAt = value => value?.occurredAt || (value?.occurredOn ? `${value.occurredOn}T05:00:00.000Z` : null);
const collectionIsEvent=values=>!!(values.collectionExternalId || values.collectionReference && on(values.collectionDate));
const FILE_ERRORS = new Set(['EXCEL_INVALID','EXCEL_FORMAT','EXCEL_PROTECTED','EXCEL_FILE_LIMIT','EXCEL_CONTENT_LIMIT','EXCEL_TIMEOUT','EXCEL_MEMORY_LIMIT','EXCEL_FORMULA_NO_CACHE','EXCEL_IDENTIFIER_PRECISION']);
const CONFIG_ERRORS = new Set(['EXCEL_SHEET','EXCEL_HEADER','IMPORT_HEADER','IMPORT_COLUMN','IMPORT_COLUMN_COLLISION']);
const isImportAvailabilityError = error => error.status === 503 || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','57P01','57P02','57P03','08006','53300','40001','40P01','SQLITE_BUSY','SQLITE_LOCKED'].includes(error.code);
function errorRecord(error, extra = {}) {
  const internal = !error.status || error.status >= 500;
  const code = internal ? 'IMPORT_INTERNAL' : error.code || (error.status === 409 ? 'IMPORT_CONFLICT' : 'IMPORT_DATA');
  const category = FILE_ERRORS.has(code) ? 'file' : CONFIG_ERRORS.has(code) ? 'configuration' : 'system';
  const action = category === 'file' ? 'Descarga el original y revisa el problema indicado. Si debes cambiar el archivo, crea una importación nueva; este original se conserva.'
    : category === 'configuration' ? 'Revisa la hoja, la fila de encabezados y las columnas asignadas. Guarda la configuración corregida y genera una revisión nueva.'
    : internal ? 'El archivo y la configuración se conservan. Reintenta la revisión; si vuelve a fallar, comunica el código y el lote al administrador.'
    : code === 'IMPORT_EMPTY_ROWS' ? 'Comprueba la hoja y la fila de encabezados seleccionadas. Si el archivo no contiene registros, usa una importación nueva con el archivo completo.'
    : ['EXCEL_DATE','EXCEL_MONEY'].includes(code) ? 'Revisa el valor indicado junto con su columna asignada y el formato de fechas o importes. Corrige la configuración y genera una revisión nueva; si el origen debe cambiar, crea una importación nueva.'
    : 'Revisa el problema indicado, las asignaciones y los vínculos del grupo antes de generar una revisión nueva. Si no identificas la causa, comunica el código y el lote al administrador.';
  return {code,message:internal ? 'No se pudo completar el procesamiento de la importación por un error interno.' : error.message,category,action,...extra};
}
function configurationError(message, code, location) {
  return Object.assign(new AppError(message),{code,location});
}
const rawById = (tx, table, id) => tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`,[id]);
const byId = async (tx, table, id) => entity(await rawById(tx,table,id));
const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Shared by profiles and batches: no executable expressions or guessed mappings.
export function validateImportConfig(input = {}) {
  plain(input,'Configuración de importación');
  const allowed = ['sheetName','headerRow','dateFormat','decimalSeparator','groupSeparator','layout','purpose','columns','statusMap','oneOrderPerGuide','reportAsOf'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('La configuración contiene un campo no permitido.');
  const decimalSeparator = input.decimalSeparator ?? ',', groupSeparator = input.groupSeparator ?? '.';
  if (!['.',','].includes(decimalSeparator) || !['.',',',' ','\u00a0',''].includes(groupSeparator) || decimalSeparator === groupSeparator) fail('Los separadores decimales y de miles deben ser distintos.');
  const layout = choice(input.layout || 'item_rows',['item_rows','order_rows'],'Distribución');
  if (!Array.isArray(input.columns ?? []) || (input.columns || []).length > 200) fail('Asigna como máximo 200 columnas.');
  const used = new Set(), destinations = new Set();
  const columns = (input.columns || []).map(column => {
    plain(column,'Columna');
    const index = integer(column.index,'Posición de columna',0,199), group = integer(column.group ?? 0,'Grupo de producto',0,49);
    if (used.has(index)) fail('Cada columna solo puede asignarse una vez.'); used.add(index);
    const destination = column.destination === 'ignore' ? '' : column.destination || '';
    if (destination && !IMPORT_DESTINATIONS.includes(destination)) fail('Destino de columna no permitido.');
    if (group && (layout !== 'order_rows' || !LINE_FIELDS.has(destination))) fail('Los grupos adicionales solo se usan para productos en filas por pedido.');
    const key = `${LINE_FIELDS.has(destination) ? group : 0}:${destination}`;
    if (destination && destinations.has(key)) fail('Un campo no puede tener dos columnas en el mismo grupo.');
    if (destination) destinations.add(key);
    return {index,header:normalizeHeader(text(column.header,'Encabezado',500)),destination,group};
  });
  const statusMap = {};
  plain(input.statusMap || {},'Equivalencias de estado');
  if (Object.keys(input.statusMap || {}).length > 500) fail('Demasiadas equivalencias de estado.');
  for (const [key,value] of Object.entries(input.statusMap || {})) {
    const external = text(key,'Estado de origen',500,true);
    Object.defineProperty(statusMap,external,{value:choice(value,SHIPMENT_STATUSES,'Estado del envío'),enumerable:true,writable:true,configurable:true});
  }
  const reportAsOf = input.reportAsOf == null || input.reportAsOf === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(input.reportAsOf) ? businessDate(input.reportAsOf) : instant(input.reportAsOf,'Fecha de corte');
  return {sheetName:text(input.sheetName,'Hoja',100) || null,headerRow:integer(input.headerRow ?? 1,'Fila de encabezados',1,10000),dateFormat:choice(input.dateFormat || 'DMY',['DMY','MDY','ISO'],'Formato de fecha'),decimalSeparator,groupSeparator,layout,purpose:choice(input.purpose || 'orders',['orders','tracking','settlements'],'Propósito'),columns,statusMap,oneOrderPerGuide:input.oneOrderPerGuide === true,reportAsOf};
}

function validateResolution(input) {
  plain(input,'Resolución');
  const action = choice(input.action,RESOLUTION_ACTIONS,'Acción de revisión');
  const result = {action};
  for (const key of ['sheet','entityKey','externalKey','internalId']) if (input[key] != null && input[key] !== '') result[key] = text(input[key],key,key === 'entityKey' ? 200 : 500,true);
  if (input.rowNumber != null) result.rowNumber = integer(input.rowNumber,'Fila',1,10001);
  if (input.reason != null) result.reason = text(input.reason,'Motivo',2000);
  if(input.remove===true)return {...result,remove:true};
  if (['review_policy','review_authority','commercial_update'].includes(action) && !result.reason) fail('La revisión requiere un motivo.');
  if (action.startsWith('link_') && !result.internalId) fail('Selecciona el registro que se vinculará.');
  if (['link_product','link_person'].includes(action) && !result.externalKey) fail('El alias requiere clave externa.');
  if (action === 'status') result.value = choice(input.value,SHIPMENT_STATUSES,'Estado del envío');
  else if (action === 'accept_formulas') { if (input.value !== true) fail('Confirma explícitamente las fórmulas con valor guardado.'); result.value = true; }
  else if (action === 'review_policy') result.value = {ruleVersionId:text(plain(input.value,'Política histórica').ruleVersionId,'Versión de regla',100,true)};
  else if (action === 'review_authority') {
    const value = plain(input.value || {},'Autoridad');
    if (Object.keys(value).some(key => !['correctionOf','allowCredit'].includes(key))) fail('Revisión de autoridad no válida.');
    result.value = {correctionOf:text(value.correctionOf,'Evento rectificado',100) || null,allowCredit:value.allowCredit === true};
  } else if (action === 'commercial_update') {
    const value = plain(input.value,'Datos comerciales'), allowed = ['customerName','phone','city','department','address','placedOn','sellerId','shippingChargeMinor','items','shipmentAssignments'];
    if (Object.keys(value).some(key => !allowed.includes(key))) fail('Campo comercial no permitido.');
    result.value = {};
    for (const key of ['customerName','phone','city','department','address','sellerId']) if (Object.hasOwn(value,key)) result.value[key] = text(value[key],key,key === 'address' ? 500 : 150) || (key === 'sellerId' ? null : '');
    if (Object.hasOwn(value,'placedOn')) result.value.placedOn = businessDate(value.placedOn);
    if (Object.hasOwn(value,'shippingChargeMinor')) result.value.shippingChargeMinor = moneyMinor(value.shippingChargeMinor);
    if (Object.hasOwn(value,'items')) {
      if (!Array.isArray(value.items) || !value.items.length || value.items.length > 50) fail('Completa entre 1 y 50 líneas reales.');
      result.value.items = value.items.map(line => ({lineId:text(line.lineId,'Línea',100) || null,kind:choice(line.kind || 'products',['products','combos'],'Tipo de producto'),itemId:text(line.itemId,'Producto',100,true),quantity:integer(line.quantity,'Cantidad',1,999),unitPriceMinor:moneyMinor(line.unitPriceMinor),discountMinor:moneyMinor(line.discountMinor ?? 0)}));
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
const resolutionKey = resolution => hash([resolution.action,resolution.sheet || null,resolution.rowNumber || null,resolution.entityKey || null,resolution.externalKey || null]);
const applicable = (resolution,group,row = null) => (!resolution.sheet || resolution.sheet === group.sheet) && (!resolution.entityKey || resolution.entityKey === group.key || group.identityKeys?.includes(resolution.entityKey)) && (!resolution.rowNumber || (row ? resolution.rowNumber === row.rowNumber : group.rowNumbers.includes(resolution.rowNumber)));
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
  return {id:value.id,version:value.version,state:value.state,sourceId:value.sourceId,platformId:source.platformId,profileId:value.profileId,profileVersion:value.profileVersion ?? null,filename:value.filename,fileHash:value.fileHash,fileExpired:!!value.fileExpired,createdAt:value.createdAt,updatedAt:value.updatedAt,completedAt:value.completedAt || null,expiresAt:value.expiresAt,workbook:value.workbook || null,config:value.config || validateImportConfig(),resolutions:value.resolutions || [],preview:value.preview || null,progress:value.progress || null,acceptedRevision:value.acceptedRevision || null,error:value.error || null};
}
export async function createImportBatch(store,input,actorId) {
  const id = await runCommand(store,{scope:'import:create',requestId:input.requestId,payload:input,actorId},async tx => {
    const source = await requireSource(tx,input.sourceId);
    if (!source.active || !source.platform.active) fail('Selecciona una plataforma y cuenta activas.');
    const profile = input.profileId ? await byId(tx,'import_profiles',input.profileId) : null;
    if (input.profileId && (!profile || profile.sourceId !== source.id)) fail('El perfil no pertenece a esta cuenta de plataforma.');
    const id = newId(), now = stamp(), config = validateImportConfig(profile ? JSON.parse((await rawById(tx,'import_profiles',profile.id)).data) : {});
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
    return {...batchDTO(batch,source),rows:{records,total,page,pageSize:PAGE_SIZE}};
  });
}
export async function listImportBatches(store,{page = 1,source = '',sourceId = source,state = ''} = {}) {
  page = integer(Number(page),'Página',1,100000);
  return store.readSnapshot(async tx => {
    const where = [], values = [];
    if (sourceId) {where.push('source_id=?');values.push(text(sourceId,'Cuenta',100,true));}
    if (state) {choice(state,['uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired'],'Estado del lote');where.push('state=?');values.push(state);}
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
    let config = batch.config, profileId = batch.profileId, profileVersion = batch.profileVersion;
    if (Object.hasOwn(input,'profileId')) {
      const profile = input.profileId ? await byId(tx,'import_profiles',input.profileId) : null;
      if (input.profileId && (!profile || profile.sourceId !== batch.sourceId)) fail('El perfil no pertenece a esta cuenta.');
      profileId = profile?.id || null; profileVersion = profile?.version || null;
      if (profile) config = validateImportConfig(JSON.parse((await rawById(tx,'import_profiles',profile.id)).data));
    }
    if (input.config != null) config = validateImportConfig(input.config);
    const resolutions = new Map((batch.resolutions || []).map(value => [resolutionKey(value),value]));
    for (const value of input.resolutions || []) {
      const clean=validateResolution(value), key=resolutionKey(clean);
      if(clean.remove){resolutions.delete(key);continue;}
      if(['duplicate','additional_quantity'].includes(clean.action))resolutions.delete(resolutionKey({...clean,action:clean.action==='duplicate'?'additional_quantity':'duplicate'}));
      resolutions.delete(key);resolutions.set(key,clean);
    }
    const resample = batch.fileHash && (config.sheetName !== batch.config.sheetName || config.headerRow !== batch.config.headerRow || batch.workbook?.sheetName !== config.sheetName || batch.workbook?.headerRow !== config.headerRow);
    const next = await changeBatch(tx,batch,{profile_id:profileId,state:resample ? 'uploaded' : 'review'},{config,profileVersion,resolutions:[...resolutions.values()],preview:null,previewGroups:null,...(resample?{sourceRowCount:null}:{}),error:null,progress:resample ? {phase:'inspect',processed:0,total:0} : {...batch.progress,error:null}});
    if (resample) await queueJobTx(tx,`import:${batchId}`,jobData(next,actorId,'inspect'));
    return {id:batchId};
  });
  return getImportBatch(store,batchId);
}
export async function requestImportPreview(store,batchId,input,actorId) {
  await runCommand(store,{scope:`import:preview:${batchId}`,requestId:input.requestId,payload:input,actorId},async tx => {
    const batch = await requireBatch(tx,batchId); editable(batch,input.version);
    if (!batch.bytes) fail('Carga el archivo original antes de revisar las columnas.');
    const config = validateImportConfig(batch.config);
    if (!config.columns.some(column => column.destination)) fail('Asigna y confirma las columnas antes de revisar.');
    const next = await changeBatch(tx,batch,{state:'previewing'},{config,preview:null,previewGroups:null,error:null,progress:{phase:'preview',processed:0,total:0}});
    await queueJobTx(tx,`import:${batchId}`,jobData(next,actorId,'preview'));
    return {id:batchId};
  });
  return {...await getImportBatch(store,batchId),accepted:true};
}

function resolveColumns(workbook,config) {
  const location = {sheet:workbook.sheetName,rowNumber:config.headerRow};
  const header = workbook.rows.find(row => row.rowNumber === config.headerRow);
  if (!header) throw configurationError('La fila de encabezados no existe en la hoja seleccionada. Selecciona la fila que contiene los nombres de las columnas.','IMPORT_HEADER',location);
  const headers = header.cells.map(cell => normalizeHeader(cell.text ?? cell.value)), used = new Set();
  return config.columns.filter(column => column.destination).map(column => {
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
  if (field === 'quantity') {
    const value = normalizeExcelIdentifier(cell,'Cantidad');
    if (value == null) return null;
    if (!/^\d+$/.test(value)) fail('Cantidad: usa un entero entre 1 y 999.');
    return integer(Number(value),'Cantidad',1,999);
  }
  return normalizeExcelIdentifier(cell,field);
}
function normalizeRows(workbook,config,resolutions) {
  const columns = resolveColumns(workbook,config), rows = [];
  for (const raw of workbook.rows) {
    if (raw.rowNumber <= config.headerRow) continue;
    if (!raw.cells.some(cell => cell && (cell.value != null && cell.value !== '' || cell.formula))) continue;
    const row = {sheet:workbook.sheetName,rowNumber:raw.rowNumber,values:{},lines:[],source:raw.cells,errors:[],warnings:[]}, lines = new Map();
    const scope = {sheet:row.sheet,key:'',rowNumbers:[row.rowNumber]};
    for (const column of columns) {
      const cell = raw.cells[column.index];
      try {
        if (cell?.formula && cell.hasCachedValue && !findResolution(resolutions,'accept_formulas',scope,row)) row.errors.push({code:'IMPORT_FORMULA_ACCEPTANCE',message:'Acepta el uso del valor guardado de la fórmula antes de importar.',rowNumber:row.rowNumber,field:column.destination});
        const value = normalizeCell(cell,column.destination,config,workbook);
        if (value == null) continue;
        if (LINE_FIELDS.has(column.destination)) {const line = lines.get(column.group) || {group:column.group};line[column.destination] = value;lines.set(column.group,line);}
        else row.values[column.destination] = value;
      } catch (error) {if (!error.status || error.status >= 500) throw error;row.errors.push(errorRecord(error,{phase:'preview',sheet:row.sheet,rowNumber:row.rowNumber,column:column.index+1,field:column.destination}));}
    }
    row.lines = [...lines.values()];
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
  return `row:${row.rowNumber}`;
}
function groupRows(rows,config) {
  const parents = new Map(), unitParents = new Map();
  const find = (map,key) => {if (!map.has(key)) map.set(key,key);let value=key;while(map.get(value)!==value)value=map.get(value);return value;};
  const join = (map,a,b) => {a=find(map,a);b=find(map,b);if(a!==b)map.set(a<b?b:a,a<b?a:b);};
  const guideOrders = new Map(), internalNumbers = new Map();
  for (const row of rows) {
    row.orderKey=rowOrderKey(row,config);find(parents,row.orderKey);find(unitParents,row.orderKey);
    const guide=shipmentKey(row.values), number=row.values.internalOrderNumber;
    for(const [key,map] of [[guide,guideOrders],[number,internalNumbers]])if(key){if(map.has(key)){join(parents,row.orderKey,map.get(key));join(unitParents,row.orderKey,map.get(key));}else map.set(key,row.orderKey);}
  }
  const groups=new Map();
  for(const row of rows){
    const identity=row.orderKey,key=`group:${hash([row.sheet,find(parents,identity)]).slice(0,40)}`;
    row.orderKey=find(unitParents,identity);
    const group=groups.get(key)||{key,sheet:row.sheet,rows:[],rowNumbers:[],identityKeys:[],errors:[],warnings:[],tasks:[],units:[],targets:[]};
    group.rows.push(row);group.rowNumbers.push(row.rowNumber);if(!group.identityKeys.includes(identity))group.identityKeys.push(identity);groups.set(key,group);
  }
  return [...groups.values()];
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
    if (values.size > 1) errors.push({code:'IMPORT_REPEATED_FIELD',message:`${label}: ${field} tiene valores contradictorios; no se sumará ni se elegirá uno.`,field});
    else if (values.size) result[field] = values.values().next().value;
  }
  return result;
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
    if (line.quantity == null || line.unitPrice == null) {incomplete=true;group.tasks.push({type:'complete_lines',message:'Completa cantidad y precio explícitos; no se tomará el precio del catálogo.',rowNumbers:[row.rowNumber]});continue;}
    const key = line.externalLineId ? `external:${line.externalLineId}` : hash([internalId,line.unitPrice,line.lineDiscount || 0]);
    const candidate = {lineId:`excel-${hash([batch.sourceId,group.key,key]).slice(0,32)}`,kind:record.kind,itemId:internalId,title:record.title,presentation:JSON.parse(record.data).presentation || '',quantity:line.quantity,unitPriceMinor:line.unitPrice,discountMinor:line.lineDiscount || 0,externalLineId:line.externalLineId || null,productExternalKey:line.productExternalKey,rowNumbers:[row.rowNumber],allocations:[{rowNumber:row.rowNumber,quantity:line.quantity}]};
    const old = result.get(key);
    if (old && line.externalLineId && !findResolution(resolutions,'additional_quantity',group,row)) {
      if (['kind','itemId','quantity','unitPriceMinor','discountMinor'].some(field => old[field] !== candidate[field])) errors.push({code:'IMPORT_LINE_CONFLICT',message:'Una misma línea externa tiene cantidades o precios diferentes.',rowNumber:row.rowNumber});
      else {old.rowNumbers.push(row.rowNumber);old.allocations.push(...candidate.allocations);}
    } else if (old) {old.quantity = integer(old.quantity+candidate.quantity,'Cantidad agrupada',1,999);old.discountMinor = moneyMinor(old.discountMinor+candidate.discountMinor);old.rowNumbers.push(row.rowNumber);old.allocations.push(...candidate.allocations);}
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
    if (unit.input || unit.policy) return true;
    if (unit.values.externalOrderId && !await lookupLink(tx,batch.sourceId,'order',unit.values.externalOrderId)) return true;
    for (const observed of unit.shipments) {
      if (!observed.existingId) return true;
      const shipment=await refreshShipment(tx,observed.existingId), values=observed.values;
      if (unit.orderId && !shipment.orderId) return true;
      if ((values.externalShipmentId || shipmentKey(values)) && !await lookupLink(tx,batch.sourceId,'shipment',values.externalShipmentId || shipmentKey(values))) return true;
      if (['carrier','tracking'].some(field=>values[field] && values[field]!==shipment[field]) || values.estimatedDeliveryOn && on(values.estimatedDeliveryOn)!==shipment.estimatedDeliveryOn) return true;
      for (const event of observed.events) {
        const same=shipment.events.some(previous=>['status','occurredAt','occurredOn','rawStatus','detail'].every(field=>(previous[field] || null)===(event[field] || null)) && (event.occurredAt || event.occurredOn || previous.sourceAsOf===event.sourceAsOf));
        if (!same) return true;
      }
      for (const [field,dateField,category] of [['shippingOutCost','shippingOutCostDate','shipping_out'],['shippingReturnCost','shippingReturnCostDate','shipping_return'],['platformFee','platformFeeDate','platform_fee']]) if(values[field]!=null) {
        const old=entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.id}:${category}`]));
        if (!old || (!old.sourceAsOf || observed.sourceAsOf>=old.sourceAsOf) && (old.amountMinor!==values[field] || values[dateField] && (old.chargeOn ?? old.incurredOn)!==on(values[dateField]) || old.sourceAsOf!==observed.sourceAsOf)) return true;
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
  if (group.rowNumbers.some(number => appliedRows.has(`${group.sheet}:${number}`))) {
    if (group.rowNumbers.every(number => appliedRows.has(`${group.sheet}:${number}`))) {group.state='applied';Object.assign(group,await captureTargets(tx,batch,group));return group;}
    group.errors.push({code:'IMPORT_APPLIED_GROUP',message:'La nueva distribución mezcla filas aplicadas y pendientes. Conserva los grupos ya importados.'});
  }
  if (findResolution(resolutions,'omit_group',group)) {group.state='skipped';return group;}
  const seen = new Map(), active = [];
  for (const row of group.rows) {
    if (findResolution(resolutions,'duplicate',group,row)) {row.skipped=true;continue;}
    if (seen.has(row.fingerprint) && !findResolution(resolutions,'additional_quantity',group,row)) group.errors.push({code:'IMPORT_DUPLICATE_ROW',message:`La fila es idéntica a la ${seen.get(row.fingerprint)}. Marca duplicada o cantidad adicional.`,rowNumber:row.rowNumber});
    else seen.set(row.fingerprint,row.rowNumber);
    if (findResolution(resolutions,'accept_formulas',group,row)) row.errors=row.errors.filter(error=>error.code!=='IMPORT_FORMULA_ACCEPTANCE');
    group.errors.push(...row.errors);active.push(row);
  }
  if (!active.length) {group.state='skipped';return group;}
  const units = new Map();
  for (const row of active) {const rows=units.get(row.orderKey)||[];rows.push(row);units.set(row.orderKey,rows);}
  for (const [key,rows] of units) {
    try {
      const values = repeated(rows,ORDER_FIELDS,group.errors,'Pedido'), shipmentRows = new Map();
      for (const row of rows) {const sk = shipmentKey(row.values) || `unidentified:${key}`;const list=shipmentRows.get(sk)||[];list.push(row);shipmentRows.set(sk,list);}
      const shipments = [];
      for (const [key,list] of shipmentRows) {
        const eventFields = new Set(['rawStatus','eventAt','externalEventId','eventDetail','labelCreatedAt','collectedAt','deliveredAt','returnAt']);
        const transactionFields = new Set(['collectedAmount','collectionDate','collectionExternalId','collectionReference','settlementExternalId','settlementDate','settlementGross','settlementNet','settlementReference']);
        const shipmentValues = repeated(list,IMPORT_DESTINATIONS.filter(field => !LINE_FIELDS.has(field) && !ORDER_FIELDS.includes(field) && !eventFields.has(field) && !transactionFields.has(field)),group.errors,'Envío');
        const financial = new Map();
        for (const row of list) {
          const values = {...shipmentValues,...Object.fromEntries(['externalOrderId',...transactionFields].filter(field=>row.values[field]!=null).map(field=>[field,row.values[field]]))};
          if (![...transactionFields].some(field=>values[field]!=null)) continue;
          const key = hash(values), old = financial.get(key);
          if (old) old.rowNumbers.push(row.rowNumber);
          else financial.set(key,{values,sourceAsOf:sourceAsOf(row.values,config),rowNumbers:[row.rowNumber]});
        }
        const existing = await findShipment(tx,batch.sourceId,shipmentValues,resolutions,group,list[0]);
        if (existing) existing.events = (await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=? ORDER BY recorded_at,id`,[existing.id])).map(entity);
        validateShipmentMetadata({carrier:shipmentValues.carrier || existing?.carrier || '',tracking:shipmentValues.tracking || existing?.tracking || '',externalId:shipmentValues.externalShipmentId || existing?.externalId || null,estimatedDeliveryOn:on(shipmentValues.estimatedDeliveryOn) || existing?.estimatedDeliveryOn || null});
        const events = [];
        for (const row of list) for (const event of shipmentEvents(row.values,config,resolutions,group,row)) if (!events.some(previous => hash(previous) === hash(event))) events.push(event);
        const sourceCut = sourceAsOf(shipmentValues,config);
        if (events.some(event => !event.occurredAt && !event.occurredOn && !event.sourceAsOf)) group.errors.push({code:'IMPORT_CUTOFF_REQUIRED',message:'Un estado sin fecha real necesita fecha de corte del reporte.',rowNumber:list[0].rowNumber});
        if (!shipmentValues.externalShipmentId && !shipmentValues.tracking && (events.length || [...financial.values()].some(observation=>observation.values.collectedAmount!=null) || ['shippingOutCost','shippingReturnCost','platformFee'].some(field=>shipmentValues[field]!=null))) group.errors.push({code:'IMPORT_SHIPMENT_IDENTITY',message:'Los eventos, costos y recaudos necesitan ID de envío o transportadora y guía explícitos.',rowNumber:list[0].rowNumber});
        if (['shippingOutCost','shippingReturnCost','platformFee'].some(field => shipmentValues[field] != null) && !sourceCut || [...financial.values()].some(observation=>observation.values.collectedAmount!=null && !observation.sourceAsOf)) group.errors.push({code:'IMPORT_CUTOFF_REQUIRED',message:'Los costos y recaudos acumulados requieren fecha de corte.',rowNumber:list[0].rowNumber});
        if (events.some(event => event.status === 'unknown')) group.warnings.push({code:'IMPORT_UNKNOWN_STATUS',message:'El estado desconocido se conservará visible sin inferir entrega ni dinero.'});
        shipments.push({key,values:shipmentValues,existingId:existing?.id || null,existing,events,financial:[...financial.values()],sourceAsOf:sourceCut,rowNumbers:list.map(row=>row.rowNumber)});
      }
      let order = await resolveOrder(tx,batch,values,shipments,resolutions,group);
      const commercial = findResolution(resolutions,'commercial_update',group,rows[0]);
      let sellerId = values.sellerExternalKey ? await alias(tx,batch,resolutions,'person',values.sellerExternalKey,group,rows[0]) : null;
      if (values.sellerExternalKey && !sellerId) group.errors.push({code:'IMPORT_PERSON_LINK',message:`Vincula la persona ${values.sellerExternalKey}.`,externalKey:values.sellerExternalKey});
      let lines = [];
      if (!order && config.purpose === 'orders' && !commercial?.value.items) lines = await buildLines(tx,batch,rows,resolutions,group,group.errors);
      const hasIdentity = !!(values.externalOrderId || values.internalOrderNumber || config.oneOrderPerGuide && shipments.some(shipment=>shipment.values.externalShipmentId || shipment.values.tracking));
      const base = {customerName:values.customerName || '',phone:values.phone || '',city:values.city || '',department:values.department || '',address:values.address || '',placedOn:on(values.placedOn),sellerId,status:'new',deliveryMethod:'carrier',shippingChargeMinor:values.shippingCharge ?? 0,items:lines};
      const shipmentAssignments=commercial?.value.shipmentAssignments || [];
      let input = null;
      if (order && commercial) input = {...order,...commercial.value};
      else if (!order && config.purpose === 'orders') input = {...base,...commercial?.value};
      const complete = input && hasIdentity && input.customerName && input.phone && input.city && input.placedOn && input.items?.length;
      if (!order && !complete) {
        input = null;
        group.tasks.push({type:'link_order',message:config.purpose==='settlements'?'Vincular los cobros de la liquidación: se conservará pendiente sin venta ni caja.':'Vincular pedido: faltan datos comerciales completos. Solo se creará seguimiento, no una venta.',rowNumbers:rows.map(row=>row.rowNumber)});
        if (!shipments.some(shipment => shipment.values.externalShipmentId || shipment.values.tracking) && !rows.some(row=>row.values.settlementExternalId || row.values.settlementNet!=null)) group.errors.push({code:'IMPORT_IDENTITY_REQUIRED',message:'Sin pedido completo, identifica el envío mediante ID externo o transportadora y guía.'});
      }
      if (input) {
        input.items = input.items.map((line,index) => ({...line,lineId:line.lineId || `excel-${hash([batch.sourceId,group.key,key,index]).slice(0,32)}`}));
        await validateOrder(input,(kind,id)=>tx.get(kind,id),order,{dispatched:order?.economicLocked,resolveSeller:id=>byId(tx,'people',id)});
      }
      const orderItems=input?.items || order?.items || [], siblings=order?(await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[order.id])).map(entity):[];
      const identified=shipments.filter(shipment=>shipment.existingId || shipment.values.externalShipmentId || shipment.values.tracking);
      for(const shipment of identified) {
        const explicit=shipmentAssignments.find(value=>value.externalShipmentId?value.externalShipmentId===shipment.values.externalShipmentId:value.tracking===shipment.values.tracking);
        const linked=findResolution(resolutions,'link_shipment',group,rows.find(row=>shipment.rowNumbers.includes(row.rowNumber)),shipment.values.externalShipmentId || shipmentKey(shipment.values));
        shipment.assignments=explicit?.assignments || linked?.value?.assignments || null;
        if(!shipment.assignments && !shipment.existingId && orderItems.length && (identified.length>1 || siblings.some(sibling=>sibling.status!=='cancelled'))) {
          if(!order && input?.items.every(line=>line.allocations?.length))shipment.assignments=input.items.map(line=>({lineId:line.lineId,quantity:line.allocations.filter(allocation=>shipment.rowNumbers.includes(allocation.rowNumber)).reduce((sum,allocation)=>sum+allocation.quantity,0)})).filter(line=>line.quantity>0);
          if(!shipment.assignments?.length)group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'Distribuye explícitamente las cantidades de cada guía; no se duplicará la venta ni las unidades enviadas.',rowNumber:shipment.rowNumbers[0]});
        }
        for(const assignment of shipment.assignments || [])if(!orderItems.some(line=>line.lineId===assignment.lineId && assignment.quantity<=line.quantity))group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'La distribución contiene una línea ajena o supera su cantidad.',rowNumber:shipment.rowNumbers[0]});
      }
      const replaced=new Set(siblings.map(shipment=>shipment.replacesShipmentId).filter(Boolean)), allocated=new Map();
      for(const sibling of siblings)if(sibling.status!=='cancelled' && !replaced.has(sibling.id)) {
        const observed=identified.find(shipment=>shipment.existingId===sibling.id);
        for(const line of observed?.assignments || sibling.assignments || [])allocated.set(line.lineId,(allocated.get(line.lineId)||0)+line.quantity);
      }
      for(const shipment of identified.filter(shipment=>!shipment.existingId))for(const line of shipment.assignments || (identified.length===1&&!siblings.length?orderItems.map(line=>({lineId:line.lineId,quantity:line.quantity})):[]))allocated.set(line.lineId,(allocated.get(line.lineId)||0)+line.quantity);
      for(const line of orderItems)if((allocated.get(line.lineId)||0)>line.quantity)group.errors.push({code:'IMPORT_SHIPMENT_ASSIGNMENTS',message:'Las guías activas asignan más unidades que las compradas. Revisa la distribución completa.'});
      const policy = findResolution(resolutions,'review_policy',group,rows[0]);
      const rule = input && !order ? await ruleForOrder(tx,input.placedOn,input.sellerId) : order?.ruleSnapshot;
      if ((input || order) && !rule) {
        if (!policy) group.errors.push({code:'IMPORT_POLICY_REQUIRED',message:'La fecha histórica no tiene regla vigente. Revisa explícitamente la política de este grupo.'});
        else if (!(await getBusinessSettings(tx)).rulesVersions.some(rule=>rule.id === policy.value.ruleVersionId)) group.errors.push({code:'IMPORT_POLICY_REQUIRED',message:'La versión de política seleccionada no existe.'});
      }
      for (const shipment of shipments) {
        if (shipment.existing?.orderId && order && shipment.existing.orderId !== order.id) group.errors.push({code:'IMPORT_ORDER_CONFLICT',message:'La guía está vinculada a otro pedido.'});
        const authority = findResolution(resolutions,'review_authority',group,rows.find(row=>shipment.rowNumbers.includes(row.rowNumber)));
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
        const costs = [['shippingOutCost','shipping_out'],['shippingReturnCost','shipping_return'],['platformFee','platform_fee']];
        for (const [field,category] of costs) if (shipment.values[field] != null && shipment.existingId) {
          const cost = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.existingId}:${category}`]));
          const previous = cost || shipment.existing.costObservations?.[category];
          if (previous && (previous.source !== 'excel' || previous.sourceId !== batch.sourceId || previous.sourceAsOf === shipment.sourceAsOf && previous.amountMinor !== shipment.values[field]) && !authority) group.errors.push({code:'IMPORT_COST_AUTHORITY',message:'El costo tiene otra autoridad o discrepa al mismo corte. Confirma una revisión con motivo.',rowNumber:shipment.rowNumbers[0],field});
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
        if (shipment.existing?.sourceId && shipment.existing.sourceId !== batch.sourceId && ['shippingOutCost','shippingReturnCost','platformFee'].some(field=>shipment.values[field]!=null)) group.errors.push({code:'IMPORT_SOURCE_AUTHORITY',message:'El vínculo entre fuentes permite seguimiento; los costos se registran en la fuente titular del envío.'});
      }
      group.units.push({key,values,orderId:order?.id || null,input,displayItems:input?.items || order?.items || [],commercialReason:commercial?.reason || null,policy,shipments:shipments.map(({existing,...shipment})=>shipment)});
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
const publicGroup = group => ({key:group.key,state:group.state,sheet:group.sheet,rowNumbers:group.rowNumbers,identityKeys:group.identityKeys,errors:group.errors,warnings:group.warnings,tasks:group.tasks,orderId:group.units.find(unit=>unit.orderId)?.orderId || null,shipmentIds:group.units.flatMap(unit=>unit.shipments.map(shipment=>shipment.existingId).filter(Boolean)),lines:group.units.flatMap(unit=>unit.displayItems || unit.input?.items || []),units:group.units.map(unit=>({key:unit.key,orderId:unit.orderId,values:{externalOrderId:unit.values.externalOrderId || null,internalOrderNumber:unit.values.internalOrderNumber || null},shipments:unit.shipments.map(shipment=>({existingId:shipment.existingId,values:shipment.values,assignments:shipment.assignments,rowNumbers:shipment.rowNumbers}))}))});
function previewSignature(batch,groups) {return hash({fileHash:batch.fileHash,sourceId:batch.sourceId,profileId:batch.profileId,profileVersion:batch.profileVersion,config:batch.config,resolutions:batch.resolutions,groups});}
async function savePreviewRows(tx,batch,groups,now) {
  const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
  const preserved=new Set((await tx.db.all(`SELECT sheet,row_number FROM ${tx.t('import_rows')} WHERE batch_id=? AND (state='applied' OR (state='skipped' AND ${appliedJSON} IS NOT NULL))`,[batch.id])).map(row=>`${row.sheet}:${row.row_number}`));
  await tx.db.run(`DELETE FROM ${tx.t('import_rows')} WHERE batch_id=? AND state<>'applied' AND NOT(state='skipped' AND ${appliedJSON} IS NOT NULL)`,[batch.id]);
  const rows=[];
  for(const group of groups)for(const row of group.rows) {
    if(preserved.has(`${row.sheet}:${row.rowNumber}`))continue;
    const data=JSON.stringify({source:row.source,normalized:{values:row.values,lines:row.lines},errors:[...row.errors,...group.errors.filter(error=>!error.rowNumber || error.rowNumber===row.rowNumber)],warnings:row.warnings,groupKey:group.key,task:group.tasks,skipped:!!row.skipped});
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
    const old=declaration.refs.find(ref=>ref.groupKey===group.key && ref.sourceIdentity===sourceIdentity);
    const fields=['externalOrderId','externalShipmentId','carrier','tracking','collectionExternalId','shippingOutCost','shippingReturnCost','platformFee','settlementExternalId','settlementDate','settlementGross','settlementNet','settlementReference','reportAsOf'];
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
    if(!selected.length && !settlements.length)fail('No hay grupos o liquidaciones pendientes para importar.');
    const now = stamp(), frozen = {fileHash:batch.fileHash,sourceId:batch.sourceId,profileId:batch.profileId,profileVersion:batch.profileVersion,config:batch.config,resolutions:batch.resolutions,groups:selected,settlements,selection:selected.map(group=>group.key),omitted:invalid.map(group=>group.key),includeValidOnly:input.includeValidOnly===true};
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
  await resolveOrderRecognition(tx,order.id,actorId,{reason:policy.reason,source:'excel'});
  return loadOrderData(tx,order.id);
}
async function updateShipmentData(tx,shipment,patch) {
  const row = await rawById(tx,'shipments',shipment.id), data = JSON.parse(row.data);
  if (Object.keys(patch).every(key=>hash(data[key] ?? null)===hash(patch[key] ?? null))) return refreshShipment(tx,shipment.id);
  await updateVersioned(tx,'shipments',shipment.id,row.version,{data:JSON.stringify({...data,...patch})});
  return refreshShipment(tx,shipment.id);
}
function economicReference(batch,group,rowNumbers) {
  const value=group.rows.find(row=>rowNumbers.includes(row.rowNumber) && row.values.reportAsOf)?.values.reportAsOf;
  const reportCutoff=value?{value:value.occurredAt || value.occurredOn,precision:value.precision}:batch.config.reportAsOf?{value:batch.config.reportAsOf,precision:batch.config.reportAsOf.length===10?'day':'instant'}:null;
  return {batchId:batch.id,groupKey:group.key,sheet:group.sheet,rowNumbers,fileHash:batch.fileHash,reportCutoff};
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
  const authority = findResolution(group.resolutions,'review_authority',group,{rowNumber:shipment.rowNumbers[0]});
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
    await audit(tx,{entityType:'import_collection',entityId:result.id,actorId,next:{...economicReference(batch,group,shipment.rowNumbers),amountMinor:amount,sourceAsOf:shipment.sourceAsOf},source:'excel'});
  }
  if (!eventMode && (!prior || shipment.sourceAsOf > prior.sourceAsOf)) {
    target = await updateShipmentData(tx,target,{collectionObservations:{...(target.collectionObservations || {}),[batch.sourceId]:{amountMinor:values.collectedAmount,sourceAsOf:shipment.sourceAsOf,collectionIds:[...(prior?.collectionIds || []),...collections.map(collection=>collection.id)]}}});
  }
  return {collections,changed:amount>0 && !before || !eventMode && (!prior || shipment.sourceAsOf>prior.sourceAsOf)};
}
function unresolvedSignature(lines) {
  const fields=['shipmentId','externalOrderId','externalShipmentId','externalCollectionId','tracking','carrier','reference','grossMinor','netMinor','shippingOutCostMinor','shippingReturnCostMinor','platformFeeMinor'];
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
  for (const resolution of group.resolutions) if (['link_product','link_person'].includes(resolution.action)) {
    const type = resolution.action.slice(5), row = await rawById(tx,type==='product'?'records':'people',resolution.internalId);
    if (!row || type==='product' && !['products','combos'].includes(row.kind)) fail('El destino del alias no existe.',404);
    await saveLink(tx,batch.sourceId,type,resolution.externalKey,resolution.internalId,actorId,batch.id);
  }
  let created = false;
  const appliedUnits = [], settlementParts = new Map();
  const source = await requireSource(tx,batch.sourceId);
  for (const original of group.units) {
    const unit = structuredClone(original);
    let order = unit.orderId ? await loadOrderData(tx,unit.orderId) : null;
    if (unit.input) {
      if (!order) {order = await saveOrderTx(tx,{...unit.input,requestId:hash([batch.sourceId,revision.previewHash,group.key,unit.key])},actorId);created=true;}
      else if (unit.commercialReason) order = await saveOrderTx(tx,{...unit.input,reason:unit.commercialReason},actorId,order.id,order.version);
    }
    if (order) {
      order = await applyPolicy(tx,await loadOrderData(tx,order.id),unit.policy,actorId,batch.id);unit.orderId=order.id;
      await saveLink(tx,batch.sourceId,'order',unit.values.externalOrderId || (revision.config.oneOrderPerGuide ? unit.key : null),order.id,actorId,batch.id);
      await audit(tx,{entityType:'import_order',entityId:order.id,actorId,next:economicReference(batch,group,group.rowNumbers),source:'excel'});
    }
    const unitResult = {orderId:order?.id || null,shipmentIds:[],collectionIds:[],expenseIds:[]};
    for (const observed of [...unit.shipments].sort((a,b)=>Number(!a.existingId)-Number(!b.existingId) || (a.assignments || []).reduce((sum,line)=>sum+line.quantity,0)-(b.assignments || []).reduce((sum,line)=>sum+line.quantity,0))) {
      let shipment = observed.existingId ? await refreshShipment(tx,observed.existingId) : null;
      const values = observed.values;
      const linkResolution = findResolution(group.resolutions,'link_shipment',group,{rowNumber:observed.rowNumbers[0]},values.externalShipmentId || shipmentKey(values));
      if (!shipment) {
        if (!values.externalShipmentId && !values.tracking) {
          for(const financial of observed.financial)if(financial.values.settlementExternalId || financial.values.settlementNet!=null)addSettlementPart(settlementParts,batch,financial.values,{shipmentId:null,orderId:unit.orderId,sourceIdentity:observed.key,partKey:`${unit.key}:${observed.key}`,rowNumber:financial.rowNumbers[0],collectionIds:[],expenseIds:[]});
          if(order || observed.financial.some(financial=>financial.values.settlementExternalId || financial.values.settlementNet!=null))continue;
          fail('Identifica el envío antes de importar.');
        }
        const assignments = observed.assignments || linkResolution?.value?.assignments || undefined;
        shipment = await saveShipmentTx(tx,{orderId:order?.id || null,platformId:source.platformId,sourceId:batch.sourceId,externalId:values.externalShipmentId || null,carrier:values.carrier || '',tracking:values.tracking || '',estimatedDeliveryOn:on(values.estimatedDeliveryOn),...(assignments ? {assignments} : {}),source:'excel'},actorId);created=true;
      } else if (order && !shipment.orderId) {
        shipment = await linkShipmentTx(tx,{shipmentId:shipment.id,version:shipment.version,orderId:order.id,reason:linkResolution?.reason || 'Vínculo revisado en importación',...(observed.assignments ? {assignments:observed.assignments} : linkResolution?.value?.assignments ? {assignments:linkResolution.value.assignments} : {})},actorId);
      }
      // Blank columns do not erase metadata; logistics are still subject to the
      // shipment domain's post-dispatch freeze and explicit corrections.
      const metadata = {}, recent = !observed.sourceAsOf || !shipment.sourceAsOf || observed.sourceAsOf >= shipment.sourceAsOf;
      if (recent) {
        for (const field of ['carrier','tracking']) if (values[field] && values[field] !== shipment[field]) metadata[field]=values[field];
        if (values.estimatedDeliveryOn && on(values.estimatedDeliveryOn)!==shipment.estimatedDeliveryOn) metadata.estimatedDeliveryOn=on(values.estimatedDeliveryOn);
      }
      if(observed.assignments && hash(observed.assignments)!==hash(shipment.assignments))metadata.assignments=observed.assignments;
      if (Object.keys(metadata).length) shipment=await saveShipmentTx(tx,{...metadata,version:shipment.version,source:'excel',reason:'Metadatos logísticos mapeados y revisados'},actorId,shipment.id);
      await saveLink(tx,batch.sourceId,'shipment',values.externalShipmentId || shipmentKey(values),shipment.id,actorId,batch.id);
      const reportCutoff=economicReference(batch,group,observed.rowNumbers).reportCutoff;
      const previousCut=shipment.sourceCuts?.[batch.sourceId];
      if (observed.sourceAsOf && reportCutoff && (!previousCut || observed.sourceAsOf>previousCut.sourceAsOf || observed.sourceAsOf===previousCut.sourceAsOf && hash(reportCutoff)!==hash({value:previousCut.value,precision:previousCut.precision}))) {
        const nextCut={...reportCutoff,sourceAsOf:observed.sourceAsOf};
        shipment=await updateShipmentData(tx,shipment,{sourceCuts:{...(shipment.sourceCuts || {}),[batch.sourceId]:nextCut}});
        await audit(tx,{entityType:'shipment_source_cut',entityId:shipment.id,actorId,previous:previousCut || null,next:{sourceId:batch.sourceId,...nextCut},reason:'Corte de origen con su precisión, no fecha inventada del evento',source:'excel'});
      }
      const authority = findResolution(group.resolutions,'review_authority',group,{rowNumber:observed.rowNumbers[0]});
      for (const event of observed.events) {
        if(event.observationOnly){await audit(tx,{entityType:'shipment_observation',entityId:shipment.id,actorId,next:{...event,...economicReference(batch,group,observed.rowNumbers)},reason:'Corte anterior discrepante sin rectificar fecha final',source:'excel'});continue;}
        const effective = effectiveShipmentEvents(shipment.events), latest = effective.at(-1);
        const snapshot = !event.occurredAt && !event.occurredOn;
        if (snapshot && latest && event.status === latest.status && event.rawStatus === (latest.rawStatus || '') && !authority?.value.correctionOf && event.sourceAsOf >= (latest.sourceAsOf || '')) {
          if (event.sourceAsOf > (shipment.sourceAsOf || '')) {
            await updateVersioned(tx,'shipments',shipment.id,shipment.version,{source_as_of:event.sourceAsOf});
            await audit(tx,{entityType:'shipment_freshness',entityId:shipment.id,actorId,previous:{sourceAsOf:shipment.sourceAsOf},next:{sourceAsOf:event.sourceAsOf,...economicReference(batch,group,observed.rowNumbers)},source:'excel'});shipment=await refreshShipment(tx,shipment.id);
          }
        } else {
          const externalKey = shipment.sourceId !== batch.sourceId ? `source:${hash([batch.sourceId,event.externalKey || null,event.status,event.occurredAt,event.occurredOn,!event.occurredAt && !event.occurredOn ? event.sourceAsOf : null,event.detail])}` : event.externalKey;
          shipment=await recordShipmentEventTx(tx,shipment.id,{...event,externalKey,version:shipment.version,source:'excel',correctionOf:authority?.value.correctionOf || null,reason:authority?.reason || ''},actorId);
        }
      }
      for (const [field,dateField,category] of [['shippingOutCost','shippingOutCostDate','shipping_out'],['shippingReturnCost','shippingReturnCostDate','shipping_return'],['platformFee','platformFeeDate','platform_fee']]) if (values[field] != null) {
        const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[`${shipment.id}:${category}`]));
        const expense=await recordExpenseTx(tx,{...(existing?{id:existing.id,version:existing.version}:{}),category,amountMinor:values[field],...(values[dateField]?{incurredOn:on(values[dateField])}:{}),shipmentId:shipment.id,orderId:order?.id || null,source:'excel',sourceId:batch.sourceId,sourceAsOf:observed.sourceAsOf,reason:authority?.reason || 'Nueva observación de costo de la misma fuente',reviewConfirmed:!!authority},actorId);
        if (expense.id) {unitResult.expenseIds.push(expense.id);await audit(tx,{entityType:'import_expense',entityId:expense.id,actorId,next:economicReference(batch,group,observed.rowNumbers),source:'excel'});}
        shipment=await refreshShipment(tx,shipment.id);
      }
      observed.id=shipment.id;
      for (const financial of observed.financial.sort((a,b)=>(a.sourceAsOf||'').localeCompare(b.sourceAsOf||''))) {
        const collected=await importCollections(tx,batch,group,{...financial,id:shipment.id},unit,actorId);
        unitResult.collectionIds.push(...collected.collections.map(collection=>collection.id));
        const values=financial.values;
        if (values.settlementExternalId || values.settlementNet != null || values.settlementGross != null) {
          addSettlementPart(settlementParts,batch,values,{shipmentId:shipment.id,orderId:unit.orderId,sourceIdentity:observed.key,partKey:shipment.id,rowNumber:financial.rowNumbers[0],collectionIds:collected.collections.map(collection=>collection.id),expenseIds:[...unitResult.expenseIds]});
        }
      }
      if (!order) await updateShipmentData(tx,shipment,{importTask:{type:'link_order',batchId:batch.id,rowNumbers:observed.rowNumbers,message:'Vincular pedido'}});
      unitResult.shipmentIds.push(shipment.id);
    }
    appliedUnits.push(unitResult);
  }
  const after=Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
  const result={state:created?'created':after===before?'unchanged':'updated',units:appliedUnits,settlementParts:[...settlementParts].flatMap(([key,parts])=>parts.map(part=>({key,...part}))),revision:revision.revision};
  for (const row of group.rows) {
    const saved=await tx.db.get(`SELECT data,state FROM ${tx.t('import_rows')} WHERE batch_id=? AND sheet=? AND row_number=?`,[batch.id,row.sheet,row.rowNumber]);
    if (saved?.state==='applied' || saved?.state==='skipped' && JSON.parse(saved.data).applied) continue;
    await tx.db.run(`UPDATE ${tx.t('import_rows')} SET state=?,data=?,version=version+1,updated_at=? WHERE batch_id=? AND sheet=? AND row_number=?`,[row.skipped?'skipped':'applied',JSON.stringify({...JSON.parse(saved.data),errors:[],applied:result,appliedAt:stamp(),acceptedRevision:revision.revision}),stamp(),batch.id,row.sheet,row.rowNumber]);
  }
  await audit(tx,{entityType:'import_group',entityId:`${batch.id}:${group.key}`,actorId,next:{...result,...economicReference(batch,group,group.rowNumbers)},source:'excel'});
  return result;
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
  for(const row of rows)if(row.result){const result=groups.get(row.entity_key)|| (typeof row.result==='string'?JSON.parse(row.result):row.result);groups.set(row.entity_key,result);sourceRows.set(`${row.sheet}:${row.row_number}`,result);}
  return {groups,sourceRows};
}
const settlementLinesHash=lines=>hash(lines.map(line=>({collectionId:line.collectionId,grossMinor:line.grossMinor,deductions:line.deductions.map(deduction=>({...deduction})).sort((a,b)=>a.expenseId.localeCompare(b.expenseId))})).sort((a,b)=>a.collectionId.localeCompare(b.collectionId)));
async function applySettlementDeclarationTx(tx,batch,declaration,revision,actorId) {
  const key=declaration.key, existing=entity(await tx.db.get(`SELECT * FROM ${tx.t('settlements')} WHERE external_key=?`,[hash([batch.sourceId,key])]));
  if((existing?.id || null)!==declaration.target.id || (existing?.version || null)!==declaration.target.version)fail('La liquidación cambió después de la revisión. Revisa la declaración sin sobrescribirla.',409);
  if(declaration.errors.length)fail(declaration.errors[0].message,409);
  const outcomes=await appliedOutcomes(tx,batch.id),parts=[];
  for(const ref of declaration.refs) {
    const outcome=outcomes.groups.get(ref.groupKey)||outcomes.sourceRows.get(`${ref.sheet}:${ref.rowNumbers[0]}`);
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
    if(gross>0 || first && deductions.length || !available.length)unresolvedLines.push({shipmentId:shipments.get(part.shipmentId)?.sourceId===batch.sourceId?part.shipmentId:null,externalOrderId:part.values.externalOrderId || null,externalShipmentId:part.values.externalShipmentId || null,externalCollectionId:part.values.collectionExternalId || null,tracking:part.values.tracking || null,carrier:part.values.carrier || null,reference:part.values.settlementReference || part.values.settlementExternalId || key,grossMinor:part.values.settlementGross==null?null:gross,netMinor:part.values.settlementNet ?? null,shippingOutCostMinor:part.values.shippingOutCost ?? null,shippingReturnCostMinor:part.values.shippingReturnCost ?? null,platformFeeMinor:part.values.platformFee ?? null,batchId:batch.id,groupKey:part.groupKey,sheet:part.sheet,rowNumber:part.rowNumbers[0]});
  }
  lines.sort((a,b)=>a.collectionId.localeCompare(b.collectionId));for(const line of lines)line.deductions.sort((a,b)=>a.expenseId.localeCompare(b.expenseId));
  const same=existing && settlementLinesHash(existing.lines)===settlementLinesHash(lines) && unresolvedSignature(existing.unresolvedLines || [])===unresolvedSignature(unresolvedLines) && existing.netMinor===values.settlementNet && existing.reportedOn===on(values.settlementDate);
  let settlement=existing;
  if(!same) {
    const resolving=existing?.unresolvedLines?.length && existing.netMinor===values.settlementNet && existing.reportedOn===on(values.settlementDate);
    if(existing && !declaration.authority && !resolving)fail('La liquidación externa tiene otros importes o vínculos. Revisa la autoridad con motivo.',409);
    settlement=await saveSettlementTx(tx,{...(existing?{id:existing.id,version:existing.version,reason:declaration.authority?.reason || 'Vínculos pendientes resueltos mediante revisión aceptada'}:{}),sourceId:batch.sourceId,externalKey:key,reportedOn:on(values.settlementDate),netMinor:values.settlementNet,lines,source:'excel',sourceAsOf:cutoff(batch.config.reportAsOf),reconciliationRequired:unresolvedLines.length>0,unresolvedLines},actorId);
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
async function readImportWorkbook(store,batch,mode) {
  // File/profile identity avoids decompressing an unchanged workbook. Only raw
  // cells are reused: normalization, aliases, authority and targets are reviewed
  // anew, so this cache can never stand in for financial fact identities.
  const prior=await store.db.get(`SELECT id,data FROM ${store.t('import_batches')} WHERE source_id=? AND file_hash=? AND id<>? AND state IN ('completed','completed_with_errors') AND ${batch.profileId?'profile_id=?':'profile_id IS NULL'} ORDER BY updated_at DESC LIMIT 1`,[batch.sourceId,batch.fileHash,batch.id,...(batch.profileId?[batch.profileId]:[])]);
  const candidates=[batch,...(prior?[{...JSON.parse(prior.data),id:prior.id}]:[])];
  for(const cached of candidates) {
    const workbook=cached.workbook;
    if(!workbook || cached.profileVersion!==batch.profileVersion)continue;
    const selected=batch.config.sheetName || workbook.sheets[0]?.name;
    if(workbook.sheetName!==selected || workbook.headerRow!==batch.config.headerRow)continue;
    if(mode==='inspect')return workbook;
    const header=workbook.rows.find(row=>row.rowNumber===batch.config.headerRow);
    if(!header)continue;
    const rows=new Map([[header.rowNumber,header]]);
    if(cached.previewGroups){for(const group of cached.previewGroups)for(const row of group.rows)if(row.sheet===selected)rows.set(row.rowNumber,{rowNumber:row.rowNumber,cells:row.source});}
    else if(cached.sourceRowCount!=null) {
      const saved=await store.db.all(`SELECT row_number,data FROM ${store.t('import_rows')} WHERE batch_id=? AND sheet=? ORDER BY row_number`,[cached.id,selected]);
      if(saved.length!==cached.sourceRowCount)continue;
      for(const row of saved)rows.set(row.row_number,{rowNumber:row.row_number,cells:JSON.parse(row.data).source});
    } else continue;
    const result={...workbook,rows:[...rows.values()].sort((a,b)=>a.rowNumber-b.rowNumber),warnings:cached.preview?.warnings || workbook.warnings || []};
    delete result.samplesOnly;delete result.sampleLimit;
    return result;
  }
  return readExcel(Buffer.from(batch.bytes,'base64'),{filename:batch.filename,sheetName:batch.config.sheetName,headerRow:batch.config.headerRow,mode});
}
async function leasedUpdate(store,lease,clock,fn) {
  return store.transaction(async tx=>{await tx.lockWrites();await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});const result=await fn(tx);await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});return result;});
}
export async function processImportTurn(store,{batchId = null,maxGroups = 25,now = stamp()} = {}) {
  maxGroups=integer(maxGroups,'Grupos por turno',1,25);
  const lease=await claimJob(store,{...(batchId?{key:`import:${text(batchId,'Lote',100,true)}`}:{prefix:'import:'}),now});
  if (!lease) return {processed:0,hasMore:false,batchId:batchId || null,state:null};
  return withLeaseHeartbeat(store,lease,async ({clock,assertActive})=>{
    let processed=0;
    try {
      let batch=await requireBatch(store,lease.batchId);
      if (lease.phase==='inspect' || lease.phase==='preview') {
        if (!batch.bytes) fail('Archivo original vencido. Crea una importación nueva.',409);
        const parsed=await readImportWorkbook(store,batch,lease.phase==='inspect'?'inspect':'rows');
        assertActive();
        if (lease.phase==='inspect') await leasedUpdate(store,lease,clock,async tx=>{
          const current=await requireBatch(tx,batch.id);
          const config={...current.config,sheetName:current.config.sheetName || parsed.sheetName};
          await changeBatch(tx,current,{state:'review'},{config,workbook:parsed,error:null,progress:{phase:'columns',processed:0,total:0}});
          await updateJobProgressTx(tx,lease,{progress:{phase:'columns'}},{now:clock()});
        });
        else {
          const config=validateImportConfig(batch.config), rows=normalizeRows(parsed,config,batch.resolutions || []);
          if (!rows.length) throw configurationError('No hay filas de datos después de los encabezados seleccionados. Revisa la hoja y la fila de encabezados.','IMPORT_EMPTY_ROWS',{sheet:parsed.sheetName,rowNumber:config.headerRow});
          const sourceHeaders=parsed.rows.find(row=>row.rowNumber===config.headerRow).cells.map(cell=>cell.text || String(cell.value ?? '')),resolved=new Map(resolveColumns(parsed,config).map(column=>[column.index,column]));
          const effectiveConfig={...config,columns:sourceHeaders.map((header,index)=>resolved.has(index)?{...resolved.get(index),header:normalizeHeader(header)}:{index,header:normalizeHeader(header),destination:'',group:0})};
          const applied=await store.readSnapshot(async tx=>{const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;return new Set((await tx.db.all(`SELECT sheet,row_number FROM ${tx.t('import_rows')} WHERE batch_id=? AND (state='applied' OR (state='skipped' AND ${appliedJSON} IS NOT NULL))`,[batch.id])).map(row=>`${row.sheet}:${row.row_number}`));});
          const groups=groupRows(rows,config);
          for(let offset=0;offset<groups.length;offset+=5){await store.readSnapshot(async tx=>{for(const group of groups.slice(offset,offset+5))await prepareGroup(tx,batch,group,config,batch.resolutions || [],applied);});assertActive();await new Promise(resolve=>setImmediate(resolve));}
          validateSettlementDeclarations(groups,batch.sourceId);
          const previewHash=previewSignature({...batch,config:effectiveConfig},groups), preview={previewHash,summary:{...summaryFor(groups),settlementsPending:Object.keys(batch.settlementIssues || {}).length},groups:groups.map(publicGroup),warnings:parsed.warnings || []};
          await leasedUpdate(store,lease,clock,async tx=>{
            const current=await requireBatch(tx,batch.id);
            if (hash(current.config)!==hash(batch.config) || hash(current.resolutions)!==hash(batch.resolutions)) fail('La configuración cambió durante la revisión.',409);
            await savePreviewRows(tx,current,groups,clock());
            await changeBatch(tx,current,{state:'review'},{config:effectiveConfig,sourceHeaders,preview,previewGroups:groups,sourceRowCount:rows.length,error:null,progress:{phase:'review',processed:groups.length,total:groups.length}});
            await updateJobProgressTx(tx,lease,{progress:{phase:'review',total:groups.length}},{now:clock()});
          });
        }
        await finishJob(store,lease,{state:'succeeded',now:clock()});
        return {processed:0,hasMore:await importBacklog(store,clock()),batchId:batch.id,state:'review'};
      }
      const row=await store.db.get(`SELECT * FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=?`,[batch.id,lease.revision]);
      if (!row) fail('No existe la revisión inmutable aceptada.',409);
      const revision={...JSON.parse(row.data),revision:row.revision,previewHash:row.preview_hash};
      if (revision.fileHash!==batch.fileHash) fail('El archivo no corresponde a la revisión aceptada.',409);
      // Never consume mutable config, resolutions or actor from the current batch.
      batch={...batch,sourceId:revision.sourceId,config:revision.config,resolutions:revision.resolutions,profileId:revision.profileId,profileVersion:revision.profileVersion};
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
        await changeBatch(tx,current,{state,expires_at:hasPending?current.expiresAt:new Date(Date.parse(clock())+90*86400000).toISOString()},{progress,finishedAt:hasPending?null:clock(),completedAt:hasPending?null:clock(),error:null});
        await updateJobProgressTx(tx,lease,{progress},{now:clock()});
      });
      await finishJob(store,lease,{state:hasPending?'queued':'succeeded',data:{progress},now:clock()});
      return {processed,hasMore:hasPending || await importBacklog(store,clock()),batchId:batch.id,state};
    } catch (error) {
      if (isImportAvailabilityError(error)) {
        // Only evidenced availability failures retry automatically. Accepted
        // revisions and already-applied commands remain intact.
        await finishJob(store,lease,{state:'queued',errorCode:'IMPORT_UNAVAILABLE',now:clock()});
        return {processed,hasMore:true,batchId:lease.batchId,state:'queued'};
      }
      const state=lease.phase==='preview'?'review':'failed';
      await leasedUpdate(store,lease,clock,async tx=>{
        const batch=await requireBatch(tx,lease.batchId);
        const location=error.location || (['EXCEL_SHEET','EXCEL_HEADER'].includes(error.code)?{sheet:batch.config.sheetName,...(error.code==='EXCEL_HEADER'?{rowNumber:batch.config.headerRow}:{})}:{});
        const diagnostic=errorRecord(error,{phase:lease.phase,...location});
        await changeBatch(tx,batch,{state},{...(['inspect','preview'].includes(lease.phase)?{preview:null,previewGroups:null}:{}),error:diagnostic,progress:{...(batch.progress || {}),error:diagnostic}});
      });
      await finishJob(store,lease,{state:'failed',errorCode:!error.status || error.status>=500?'IMPORT_INTERNAL':error.code || 'IMPORT_DATA',now:clock()});
      if (!error.status) throw error;
      return {processed,hasMore:await importBacklog(store,clock()),batchId:lease.batchId,state};
    }
  },{now});
}
async function durableProgress(tx,batchId,revision) {
  const appliedJSON=tx.provider==='sqlite'?`json_extract(data,'$.applied')`:`data::jsonb->'applied'`;
  const rows=await tx.db.all(`SELECT entity_key,state,${appliedJSON} AS applied FROM ${tx.t('import_rows')} WHERE batch_id=?`,[batchId]), groups=new Map(), selection=new Set(revision.selection);
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
  progress.phase=progress.groupsProcessed<progress.groupsTotal?'apply':progress.settlementsProcessed<progress.settlementsTotal?'settlements':'complete';
  return progress;
}
async function importBacklog(store,now) {return !!await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'import:%' AND (state='queued' OR (state='running' AND lease_until<=?)) LIMIT 1`,[now]);}
export async function downloadImportOriginal(store,batchId) {
  const batch=await requireBatch(store,batchId);
  if (!batch.bytes) fail(batch.fileHash?'Archivo original vencido.':'Todavía no se cargó el archivo original.',404);
  const types={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',xlsb:'application/vnd.ms-excel.sheet.binary.macroEnabled.12',xlsm:'application/vnd.ms-excel.sheet.macroEnabled.12'};
  return {bytes:Buffer.from(batch.bytes,'base64'),filename:batch.filename,contentType:types[batch.filename.split('.').at(-1).toLowerCase()]};
}
export async function exportImportErrors(store,batchId) {
  return store.readSnapshot(async tx=>{
    const batch=await requireBatch(tx,batchId), rows=await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE batch_id=? ORDER BY sheet,row_number`,[batchId]), documentErrors=new Map();
    for(const issue of Object.values(batch.settlementIssues || {}))for(const ref of issue.refs)for(const number of ref.rowNumbers){const key=`${ref.sheet}:${number}`,errors=documentErrors.get(key)||[];errors.push(issue.error);documentErrors.set(key,errors);}
    const decoded=rows.filter(row=>['conflict','rejected'].includes(row.state) || documentErrors.has(`${row.sheet}:${row.row_number}`)).map(row=>{const decoded=JSON.parse(row.data);return {...row,decoded:{...decoded,errors:[...(decoded.errors || []),...(documentErrors.get(`${row.sheet}:${row.row_number}`)||[])]}};});
    const width=Math.max(0,...decoded.map(row=>(row.decoded.source || []).length));
    const header=Array.from({length:width},(_,index)=>batch.sourceHeaders?.[index] || batch.config.columns.find(column=>column.index===index)?.header || `Columna ${index+1}`);
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
