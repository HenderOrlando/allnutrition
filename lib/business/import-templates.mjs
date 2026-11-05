import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { importFields, normalizeImportFieldName } from '../schema.mjs';
import { AppError } from '../validation-core.mjs';
import { OPERATION_HEADERS } from './excel-expand.mjs';

const require = createRequire(import.meta.url);
const definitions = new Map(importFields.map(field => [field.value, field]));
const column = (header, destination) => Object.freeze({ header, destination });
const sales = [
  ['ID PEDIDO','externalOrderId'],['ID LINEA','externalLineId'],['FECHA PEDIDO','placedOn'],['NOMBRE CLIENTE','customerName'],['CELULAR','phone'],['CIUDAD','city'],['DEPARTAMENTO','department'],['DIRECCION','address'],['PRODUCTO','productExternalKey'],['CANTIDAD','quantity'],['PRECIO UNITARIO','unitPrice'],['COSTO UNITARIO','orderUnitCost'],['DESCUENTO','lineDiscount'],['FLETE COBRADO','shippingCharge'],['CAMPAÑA','marketingCampaign'],['NOTAS','orderNotes'],
];
const shipments = [
  ['ID ENVIO','externalShipmentId'],['ID PEDIDO','externalOrderId'],['TRANSPORTADORA','carrier'],['GUIA','tracking'],['ESTADO','rawStatus'],['FECHA ESTADO','eventAt'],['FECHA CORTE','reportAsOf'],['FLETE IDA','shippingOutCost'],['FECHA FLETE','shippingOutCostDate'],['FLETE RETORNO','shippingReturnCost'],['FECHA RETORNO','shippingReturnCostDate'],['COSTO SEGURO','insuranceCost'],['FECHA SEGURO','insuranceCostDate'],['CARGO PLATAFORMA','platformFee'],['FECHA CARGO','platformFeeDate'],
];
const expense = [
  ['ID GASTO','expenseExternalId'],['FECHA GASTO','expenseDate'],['CONCEPTO','expenseConcept'],['VALOR','expenseAmount'],['PROVEEDOR','expenseSupplier'],['REFERENCIA','expenseReference'],['NOTAS','expenseNotes'],
];
function table(name, purpose, pairs, { defaults = {}, preparedOnly = false } = {}) {
  return Object.freeze({ name, purpose, layout: ['allocations','component_costs','observations'].includes(purpose) ? 'relation_rows' : purpose === 'expenses' ? 'expense_rows' : 'item_rows', columns: Object.freeze(pairs.map(pair => column(...pair))), defaults: Object.freeze(defaults), preparedOnly });
}
export const IMPORT_TABLES = Object.freeze({
  sales: table('VENTAS','orders',sales),
  shipments: table('ENVIOS','tracking',shipments),
  advertising: table('GASTOS PAUTA','expenses',[...expense.slice(0,2),['CAMPAÑA','expenseCampaign'],...expense.slice(2)],{ defaults: { expenseCategory:'advertising' } }),
  operating: table('GASTOS OPERACION','expenses',expense,{ defaults: { expenseCategory:'operating' } }),
  expenses: table('GASTOS','expenses',[...expense.slice(0,2),['CATEGORIA','expenseCategory'],...expense.slice(2),['CAMPAÑA','expenseCampaign'],['FECHA CORTE','reportAsOf']],{ preparedOnly: true }),
  allocations: table('ASIGNACIONES','allocations',[['ID PEDIDO','externalOrderId'],['ID ENVIO','externalShipmentId'],['ID LINEA','externalLineId'],['CANTIDAD','allocationQuantity']],{ preparedOnly: true }),
  components: table('COSTOS COMPONENTES','component_costs',[['ID PEDIDO','externalOrderId'],['ID LINEA','externalLineId'],['REFERENCIA COMPONENTE','componentProductExternalKey'],['COSTO UNITARIO COMPONENTE','componentUnitCost']],{ preparedOnly: true }),
  observations: table('OBSERVACIONES','observations',[['AMBITO','observationScope'],['ID ENTIDAD','observationEntityId'],['CLAVE','observationKey'],['ETIQUETA','observationLabel'],['TIPO VALOR','observationValueType'],['VALOR','observationValue'],['HOJA ORIGEN','observationOriginSheet'],['FILA ORIGEN','observationOriginRow'],['COLUMNA ORIGEN','observationOriginColumn'],['ENCABEZADO','observationOriginHeader'],['FECHA CORTE','reportAsOf']],{ preparedOnly: true }),
});
export const IMPORT_INSTRUCTIONS = Object.freeze([
  'Fechas: AAAA-MM-DD. Los instantes de seguimiento/corte pueden incluir hora y zona ISO. Moneda: COP. Guarda los identificadores como texto.',
  'VENTAS: una fila por producto; repite ID PEDIDO para las líneas de un mismo pedido. ID LINEA es opcional al empezar y debe mantenerse estable una vez asignado. No uses nombres ni teléfonos como IDs.',
  'Ventas requieren fecha comercial, cliente, celular, ciudad, producto real, cantidad y precio. Dirección, departamento, campaña y notas son opcionales; no inventes datos ausentes.',
  'Combos: vincula PRODUCTO a un combo real y confirma sus componentes. Obsequios: una línea de PRODUCTO vinculada a obsequio con precio 0, o columnas Referencia del obsequio y Cantidad de obsequios en una fila por pedido. Sin cantidad asignada puedes confirmar una cantidad fija en el asistente; nunca se deduce de la venta. El preparado convierte obsequios a líneas independientes con IDs estables.',
  'Las referencias nuevas creadas desde la importación quedan en borrador, disponibles para pedidos pero fuera de la vitrina. Vincular una existente no cambia su publicación.',
  'ENVIOS: usa IDs estables de envío y pedido, guía real cuando exista, transportadora y fechas logísticas reales. ESTADO necesita confirmación de equivalencias; Pagado no es cobro ni entrega.',
  'GASTOS: una fila por gasto, fecha económica, concepto e importe obligatorios. Publicidad y operación tienen categoría fija en sus tablas. ID opcional en primera carga solo tras confirmar generación; después conserva el ID.',
  'Blanco significa dato desconocido; cero es un importe explícito conocido. No sustituyas un blanco por cero.',
  'Costos y gastos no son pagos. Registrar gastos no registra caja, recaudos ni pagos; no se requieren cuenta ni tarjeta.',
  'CAMPAÑA en ventas indica el origen del cliente: es texto y no un gasto adicional. Publicidad se registra únicamente en la tabla de gastos.',
  'FECHA CORTE indica hasta cuándo está actualizado el archivo; confírmala en cada carga. Nunca se usa la fecha de carga como fecha del hecho.',
  'La apertura es la fecha del conteo físico actual confirmado en el asistente. Confirma existencias reales; hechos del mismo día o sin fecha necesitan clasificación expresa.',
  'El archivo preparado no es copia íntegra: conserva solo datos seleccionados/preparados y observaciones mapeadas. Conserva el original para consultar columnas no mapeadas.',
  'ASIGNACIONES, COSTOS COMPONENTES y OBSERVACIONES acompañan a los datos; no crean entidades por sí solos. No edites IDs para cambiar vínculos sin revisarlos.',
  'POR COMPLETAR es una revisión informativa excluida: completa el registro en el asistente o lleva los datos corregidos a su tabla. No se importa como venta ni gasto.',
]);
function invalid(message, code = 'IMPORT_EXPORT_LIMIT', status = 413) {
  const error = new AppError(message, status); error.code = code; return error;
}
function baseName(name) { return String(name).replace(/ \(\d+\)$/, ''); }
export function importTableConfig(name, { columns } = {}) {
  const definition = Object.values(IMPORT_TABLES).find(item => item.name === baseName(name));
  if (!definition) return { sheetName:name, enabled:false, headerRow:1, dateFormat:'ISO', decimalSeparator:'.', groupSeparator:'', purpose:'orders', layout:'item_rows', columns:[], statusMap:{}, oneOrderPerGuide:false, reportAsOf:null, defaults:{}, identityMode:'provided', expenseGroupNames:{}, expenseCategoryMap:{} };
  return { sheetName:name, enabled:true, headerRow:1, dateFormat:'ISO', decimalSeparator:'.', groupSeparator:'', purpose:definition.purpose, layout:definition.layout,
    columns:(columns ?? definition.columns).map((field,index) => ({ index, header:field.header, destination:field.destination, group:0 })),
    statusMap:{}, oneOrderPerGuide:false, reportAsOf:null, defaults:{...definition.defaults}, identityMode:'provided', expenseGroupNames:{}, expenseCategoryMap:{} };
}
export function importTemplateConfig() {
  return { formatVersion:2, sheets:[...Object.values(IMPORT_TABLES).filter(item => !item.preparedOnly).map(item => importTableConfig(item.name)),importTableConfig('INSTRUCCIONES')] };
}
function writeTables(tables) {
  const XLSX = require('xlsx'), workbook = XLSX.utils.book_new();
  let selectedRows = 0;
  for (const { name, headers, rows, excluded = false } of tables) {
    if (headers.length > 200) throw invalid(`La tabla ${name} supera 200 columnas.`);
    if (!excluded) selectedRows += rows.length;
    if (selectedRows > 50000) throw invalid('Los datos preparados superan 50000 filas seleccionadas. Divide la incorporación antes de descargar.');
    const parts = Math.max(1, Math.ceil(rows.length / 9999));
    for (let part = 0; part < parts; part++) {
      if (workbook.SheetNames.length >= 50) throw invalid('El archivo preparado supera 50 hojas. Divide la incorporación antes de descargar.');
      const sheetName = parts === 1 ? name : `${name} (${part + 1})`;
      const values = [headers, ...rows.slice(part * 9999, (part + 1) * 9999)].map(row => row.map(value => {
        if (value === null || value === undefined) return undefined;
        if (typeof value === 'boolean') return { t:'b', v:value };
        if (typeof value === 'number' && Number.isFinite(value)) return { t:'n', v:value };
        const text = String(value);
        if (text.length > 32767) throw invalid(`Una celda de ${name} supera 32767 caracteres. Conserva el original y divide los datos antes de descargar.`);
        return { t:'s', v:text };
      }));
      XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(values),sheetName);
    }
  }
  const bytes = XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true});
  if (bytes.length > 10 * 1024 * 1024) throw invalid('El archivo preparado supera 10 MiB. Divide la incorporación antes de descargar.');
  return bytes;
}
export function writeImportTemplate() {
  // All business tables have exactly one header row and no sample records.
  const tables = Object.values(IMPORT_TABLES).filter(item => !item.preparedOnly).map(item => ({ name:item.name, headers:item.columns.map(field=>field.header), rows:[] }));
  tables.push({ name:'INSTRUCCIONES', headers:['INSTRUCCIONES'], rows:IMPORT_INSTRUCTIONS.map(text=>[text]), excluded:true });
  return writeTables(tables);
}
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function money(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('El importe preparado no contiene centavos válidos.','IMPORT_EXPORT_DATA',409);
  const integer = BigInt(value);
  return `${integer / 100n}.${String(integer % 100n).padStart(2,'0')}`;
}
function sourceValue(value, destination) {
  if (value === null || value === undefined) return null;
  const definition = definitions.get(destination);
  if (definition?.type === 'money') return money(value);
  if (definition?.type === 'date' && typeof value === 'object') return value.occurredAt || value.occurredOn || null;
  return value;
}
function observationType(field) {
  if (field.valueType) return field.valueType;
  const type = definitions.get(field.key)?.type;
  return type === 'money' ? 'money_minor' : type === 'integer' ? 'integer' : typeof field.value === 'boolean' ? 'boolean' : 'text';
}
function addObservations(output, scope, entityId, fields = []) {
  for (const field of fields) {
    for (const rowNumber of field.rowNumbers ?? [field.rowNumber]) output.push({ observationScope:scope, observationEntityId:entityId, observationKey:field.key,
      observationLabel:field.label, observationValueType:observationType(field), observationValue:field.value,
      observationOriginSheet:field.declaredOrigin?.sheet ?? field.sheet, observationOriginRow:field.declaredOrigin?.rowNumber ?? rowNumber, observationOriginColumn:(field.declaredOrigin?.columnIndex ?? field.columnIndex) + 1,
      observationOriginHeader:field.declaredOrigin?.header ?? field.header, reportAsOf:field.sourceAsOf });
  }
}
function addExpenseQuantityObservations(output, expense, group, data, entityId) {
  const input = expense.input;
  for (const ref of expense.rowRefs ?? group.rowRefs ?? []) {
    const config = data.config?.sheets?.find(sheet => sheet.sheetName === ref.sheet);
    if (config?.layout !== 'expense_columns') continue;
    const groupEntry = Object.entries(config.expenseGroupNames ?? {}).find(([,name]) => normalizeImportFieldName(name) === normalizeImportFieldName(input.campaign));
    if (!groupEntry) continue;
    for (const [property,destination,valueType] of [['quantity','expenseQuantity','integer'],['unitCostMinor','expenseUnitCost','money_minor']]) {
      if (input[property] === null || input[property] === undefined) continue;
      const label = definitions.get(destination).label, key = `additional:${normalizeImportFieldName(label)}`;
      if (input.importedFields?.some(field => field.key === key && observationType(field) === valueType && field.value === input[property])) continue;
      const source = config.columns.find(column => column.destination === destination && column.group === Number(groupEntry[0]));
      if (!source) continue;
      output.push({observationScope:'expense',observationEntityId:entityId,observationKey:key,observationLabel:label,
        observationValueType:valueType,observationValue:input[property],observationOriginSheet:ref.sheet,observationOriginRow:ref.rowNumber,
        observationOriginColumn:source.index + 1,observationOriginHeader:source.header,reportAsOf:input.sourceAsOf});
    }
  }
}
function configuredDestinations(data, purposes) {
  return new Set((data.config?.sheets ?? []).filter(sheet => sheet.enabled && purposes.includes(sheet.purpose)).flatMap(sheet => sheet.columns.map(column=>column.destination)).filter(destination => destination && destination !== 'ignore'));
}
function preparedColumns(definition, used, scopes) {
  const columns = [...definition.columns], destinations = new Set(columns.map(field=>field.destination));
  for (const field of importFields) if (used.has(field.value) && !['giftProductExternalKey','giftQuantity'].includes(field.value) && scopes.includes(field.scope) && field.type !== 'additional' && !destinations.has(field.value)) {
    columns.push(column(field.label,field.value)); destinations.add(field.value);
  }
  return columns;
}
function rowsTable(definition, columns, records) {
  return { name:definition.name, headers:columns.map(field=>field.header), rows:records.map(record=>columns.map(field=>sourceValue(record[field.destination],field.destination))) };
}
export function writePreparedImportWorkbook(data) {
  if (!data || !Array.isArray(data.groups)) throw invalid('Revisa el lote antes de descargar los datos preparados.','IMPORT_PREVIEW_REQUIRED',409);
  const salesRows = [], shipmentRows = [], expenseRows = [], allocationRows = [], componentRows = [], observationRows = [], omittedRows = [];
  const allocationKeys = new Map(), lineKeys = new Map();
  const excluded = group => ['invalid','skipped','pending','conflict','rejected'].includes(group.state) || group.errors?.length;
  for (const group of data.groups) {
    if (excluded(group)) {
      for (const row of group.rows ?? group.rowRefs ?? []) omittedRows.push([row.values?.externalOrderId || row.values?.expenseExternalId || '',row.sheet || group.sheet,row.rowNumber,
        JSON.stringify(row.values ?? {}),[...(row.errors ?? []),...(group.errors ?? [])].map(issue=>issue.message || String(issue)).join('; ') || 'Registro excluido; completa y vuelve a revisar.']);
      continue;
    }
    if (group.kind === 'expenses') {
      for (const expense of group.expenses ?? []) {
        const input = expense.input, id = expense.externalId || input.importIdentity?.externalId;
        if (!id) throw invalid('Un gasto preparado no tiene identidad estable. Vuelve a revisar.','IMPORT_EXPORT_IDENTITY',409);
        expenseRows.push({expenseExternalId:id,expenseDate:input.incurredOn,expenseCategory:input.category,expenseConcept:input.concept,expenseAmount:input.amountMinor,
          expenseSupplier:input.supplier,expenseReference:input.reference,expenseNotes:input.notes,expenseCampaign:input.campaign,reportAsOf:input.sourceAsOf});
        addObservations(observationRows,'expense',id,input.importedFields);
        addExpenseQuantityObservations(observationRows,expense,group,data,id);
      }
      continue;
    }
    for (const unit of group.units ?? []) {
      const input = unit.input ?? unit.order ?? {}, values = unit.values ?? {}, orderId = values.externalOrderId || input.importIdentity?.externalId;
      const items = unit.displayItems ?? input.items ?? [];
      if (items.length && !orderId) throw invalid('Un pedido preparado no tiene identidad estable. Vuelve a revisar.','IMPORT_EXPORT_IDENTITY',409);
      const lineIds = new Map();
      for (const line of items) {
        const lineId = line.externalLineId || line.importExternalLineId || line.lineId;
        if (!lineId) throw invalid('Una línea preparada no tiene identidad estable. Vuelve a revisar.','IMPORT_EXPORT_IDENTITY',409);
        lineIds.set(line.lineId,lineId);
        const costs = unit.lineCosts?.find(cost => cost.lineId === line.lineId);
        const record = {...values,...input,externalOrderId:orderId,externalLineId:lineId,productExternalKey:line.productExternalKey || line.itemId,
          quantity:line.quantity,unitPrice:line.unitPriceMinor,lineDiscount:line.discountMinor,orderUnitCost:costs?.unitCostMinor ?? line.orderUnitCostMinor ?? line.unitCostMinor,
          shippingCharge:input.shippingChargeMinor ?? values.shippingCharge,orderNotes:input.notes ?? values.orderNotes};
        const key = JSON.stringify([orderId,lineId]), prior = lineKeys.get(key);
        if (prior && fingerprint(prior) !== fingerprint(record)) throw invalid('Una línea preparada contiene valores contradictorios. Vuelve a revisar.','IMPORT_EXPORT_DATA',409);
        if (!prior) { salesRows.push(record);lineKeys.set(key,record); }
        for (const component of costs?.components ?? line.components ?? []) if (component.unitCostMinor != null) componentRows.push({externalOrderId:orderId,externalLineId:lineId,
          componentProductExternalKey:component.productExternalKey || component.productId,componentUnitCost:component.unitCostMinor});
      }
      addObservations(observationRows,'order',orderId,input.importedFields ?? unit.importedFields);
      for (const shipment of unit.shipments ?? []) {
        const shipmentValues = shipment.values ?? {}, shipmentId = shipmentValues.externalShipmentId || shipment.externalId || shipmentValues.tracking;
        if (!shipmentId) throw invalid('Un envío preparado no tiene identidad estable. Vuelve a revisar.','IMPORT_EXPORT_IDENTITY',409);
        const events = shipment.events?.length ? shipment.events : [null];
        for (const event of events) {
          const eventId = event && (event.externalEventId || event.externalKey || event.externalId || event.observationKey || `event:${fingerprint([shipmentId,event.status,event.occurredAt,event.occurredOn,event.rawStatus,event.detail,event.sourceAsOf])}`);
          shipmentRows.push({...shipmentValues,externalOrderId:orderId,externalShipmentId:shipmentId,externalEventId:eventId,
            rawStatus:event ? event.rawStatus || event.status : null,eventAt:event?.occurredAt || event?.occurredOn || null,eventDetail:event?.detail,
            reportAsOf:event?.sourceAsOf || shipment.sourceAsOf});
        }
        for (const financial of shipment.financial ?? []) shipmentRows.push({...shipmentValues,...financial.values,externalOrderId:orderId,externalShipmentId:shipmentId,reportAsOf:financial.sourceAsOf});
        for (const assignment of shipment.assignments ?? []) {
          const lineId = lineIds.get(assignment.lineId) || assignment.externalLineId;
          if (!lineId) throw invalid('Una asignación no corresponde a una línea preparada.','IMPORT_EXPORT_DATA',409);
          const record = {externalOrderId:orderId,externalShipmentId:shipmentId,externalLineId:lineId,allocationQuantity:assignment.quantity};
          const key = JSON.stringify([orderId,shipmentId,lineId]), prior = allocationKeys.get(key);
          if (prior && prior.allocationQuantity !== record.allocationQuantity) throw invalid('Una asignación tiene cantidades contradictorias.','IMPORT_EXPORT_DATA',409);
          if (!prior) { allocationKeys.set(key,record);allocationRows.push(record); }
        }
        addObservations(observationRows,'shipment',shipmentId,shipment.importedFields);
      }
    }
  }
  for (const row of data.omitted ?? []) omittedRows.push([row.externalId || '',row.sheet,row.rowNumber,JSON.stringify(row.values ?? {}),(row.errors ?? []).map(issue=>issue.message).join('; ') || row.reason || 'Registro excluido']);
  const used = configuredDestinations(data,['orders','tracking','settlements']);
  // Values added during review (rather than mapped cells) are equally real.
  for (const record of [...salesRows,...shipmentRows]) for (const [key,value] of Object.entries(record)) if (value !== null && value !== undefined && definitions.has(key)) used.add(key);
  const salesColumns = preparedColumns(IMPORT_TABLES.sales,used,['order','line']);
  const shipmentColumns = preparedColumns(IMPORT_TABLES.shipments,new Set([...used,'externalEventId']),['shipment','event','collection','settlement']);
  const tables = [rowsTable(IMPORT_TABLES.sales,salesColumns,salesRows),rowsTable(IMPORT_TABLES.shipments,shipmentColumns,shipmentRows),
    rowsTable(IMPORT_TABLES.expenses,IMPORT_TABLES.expenses.columns,expenseRows),rowsTable(IMPORT_TABLES.allocations,IMPORT_TABLES.allocations.columns,allocationRows),
    rowsTable(IMPORT_TABLES.components,IMPORT_TABLES.components.columns,componentRows),rowsTable(IMPORT_TABLES.observations,IMPORT_TABLES.observations.columns,observationRows),
    {name:'POR COMPLETAR',headers:['ID DISPONIBLE','HOJA ORIGEN','FILA ORIGEN','VALORES','MOTIVOS'],rows:omittedRows,excluded:true},
    {name:'INSTRUCCIONES',headers:['INSTRUCCIONES'],rows:IMPORT_INSTRUCTIONS.map(text=>[text]),excluded:true}];
  return writeTables(tables);
}

// Keep the expansion headers and reusable operating table inseparable.
if (!IMPORT_TABLES.operating.columns.every((field,index)=>field.header === OPERATION_HEADERS[index])) throw new Error('Encabezados de operación inconsistentes.');
