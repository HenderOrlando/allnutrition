import { fail, integer } from '../validation-core.mjs';
import { importFields, normalizeImportFieldName } from '../schema.mjs';
import { instant, businessDate } from './dates.mjs';
import { moneyMinor } from './money.mjs';

function validateDeclaredOrigin(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['sheet','rowNumber','columnIndex','header'].includes(key))) fail('Origen declarado no válido.');
  const sheet = importedFieldText(value.sheet,'Hoja declarada',100,{required:true});
  if (/[\u0000-\u001f\u007f]/.test(sheet)) fail('Hoja declarada no válida.');
  return {sheet,rowNumber:integer(value.rowNumber,'Fila declarada',1,10001),columnIndex:integer(value.columnIndex,'Columna declarada',0,199),header:importedFieldText(value.header,'Encabezado declarado',500)};
}

const IMPORTED_FIELD_PROPERTIES = new Set(['key','label','value','sourceId','sourceAsOf','batchId','sheet','columnIndex','header','rowNumbers']);
const IMPORTED_INFORMATION_KEYS = new Set(['rawShipmentStatus','shippingType','insuredValue','expectedCollection','cancellationReason','shipmentReference','shipmentNotes','customerName','phone','department','city','address','addressNotes','email','documentType','documentNumber']);
const definitionsFor = scope => new Map(importFields.filter(field => scope === 'shipment' ? IMPORTED_INFORMATION_KEYS.has(field.value) : field.scope === scope && field.type !== 'additional').map(field => [field.value,field]));
const ADDITIONAL_FIELD_DEFINITION = importFields.find(field => field.value === 'additionalField');
function importedFieldText(value,label,max,{required = false,identifier = false} = {}) {
  if (typeof value !== 'string' || value.length > max || required && !value.trim() || identifier && (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value))) fail(`${label}: texto no válido.`);
  return value;
}

export function validateImportedFields(fields,scope) {
  if (!['shipment','order','expense'].includes(scope)) fail('Ámbito de datos importados no válido.');
  const definitions = definitionsFor(scope);
  if (!Array.isArray(fields)) fail('Los datos importados del envío deben ser una colección.');
  const keysBySource = new Map(), result = [];
  for (const field of fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field) || Object.getPrototypeOf(field) !== Object.prototype
      || Reflect.ownKeys(field).filter(key => !['declaredOrigin','valueType'].includes(key)).length !== IMPORTED_FIELD_PROPERTIES.size || Reflect.ownKeys(field).some(key => !['declaredOrigin','valueType'].includes(key) && !IMPORTED_FIELD_PROPERTIES.has(key))) fail('Dato importado del envío: campos no válidos.');
    if (typeof field.key !== 'string') fail('Clave del dato importado: se esperaba texto.');
    const key = field.key;
    const additional = key.startsWith('additional:'), definition = additional ? ADDITIONAL_FIELD_DEFINITION : definitions.get(key);
    if (!definition) fail('La clave del dato importado no es informativa ni está permitida.');
    const label = importedFieldText(field.label,'Nombre del dato importado',additional ? 100 : 500,{required:true});
    if (additional && key !== `additional:${normalizeImportFieldName(label)}`) fail('La clave del campo adicional no corresponde a su nombre.');
    const expectedType = definition.type === 'money' ? 'money_minor' : definition.type === 'integer' ? 'integer' : definition.type === 'date' ? 'date' : 'text';
    const valueType = field.valueType ?? expectedType;
    if (!['text','integer','money_minor','date','boolean'].includes(valueType) || !additional && valueType !== expectedType) fail('Tipo de dato informativo incompatible con su clave.');
    let value;
    if (valueType === 'money_minor') value = moneyMinor(field.value,label);
    else if (valueType === 'integer') value = integer(field.value,label,0,1000000);
    else if (valueType === 'date') value = businessDate(field.value,label);
    else if (valueType === 'boolean') {
      if (typeof field.value !== 'boolean') fail('Dato booleano importado no válido.');
      value = field.value;
    } else value = importedFieldText(field.value,label,definition.max || 4000);
    if (!additional && definition.type === 'enum' && !definition.options.some(option => option.value === value)) fail('Valor informativo fuera de las opciones del catálogo.');
    const sourceId = importedFieldText(field.sourceId,'Fuente del dato importado',100,{required:true,identifier:true});
    const batchId = importedFieldText(field.batchId,'Lote del dato importado',100,{required:true,identifier:true});
    const sheet = importedFieldText(field.sheet,'Hoja del dato importado',100,{required:true});
    if (/[\u0000-\u001f\u007f]/.test(sheet)) fail('Hoja del dato importado: texto no válido.');
    const header = importedFieldText(field.header,'Encabezado del dato importado',500);
    const sourceAsOf = instant(field.sourceAsOf,'Corte del dato importado',{nullable:true});
    if (field.sourceAsOf !== sourceAsOf) fail('El corte del dato importado debe ser un instante ISO normalizado o null.');
    const columnIndex = integer(field.columnIndex,'Posición de columna del dato importado',0,199);
    if (!Array.isArray(field.rowNumbers) || !field.rowNumbers.length || field.rowNumbers.length > 10000) fail('Indica las filas de origen del dato importado.');
    const rowNumbers = [], rows = new Set();
    for (const row of field.rowNumbers) {
      integer(row,'Fila del dato importado',1,10001);
      if (rows.has(row)) fail('Las filas de origen del dato importado no pueden repetirse.');
      rows.add(row); rowNumbers.push(row);
    }
    const keys = keysBySource.get(sourceId) || new Set();
    if (keys.has(key)) fail('La fuente tiene una clave de dato importado repetida.');
    keys.add(key); keysBySource.set(sourceId,keys);
    if (keys.size > 200) fail('Una fuente admite como máximo 200 claves de datos importados por envío.');
    const declaredOrigin = field.declaredOrigin === undefined ? undefined : validateDeclaredOrigin(field.declaredOrigin);
    result.push({key,label,value,sourceId,sourceAsOf,batchId,sheet,columnIndex,header,rowNumbers,...(field.valueType === undefined ? {} : {valueType}),...(declaredOrigin === undefined ? {} : {declaredOrigin})});
  }
  return result;
}

// Cutoff authority is per source and informational key, never ingestion time.
export function mergeImportedFields(previous,incoming,{scope,reviewConfirmed = false} = {}) {
  const fields = validateImportedFields(previous,scope), observations = validateImportedFields(incoming,scope);
  const positions = new Map(), warnings = [], conflicts = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], source = positions.get(field.sourceId) || new Map();
    source.set(field.key,index); positions.set(field.sourceId,source);
  }
  const issue = (field,code,message) => ({code,message,key:field.key,sourceId:field.sourceId,rowNumbers:[...field.rowNumbers]});
  let changed = false;
  for (const field of observations) {
    if (typeof field.value === 'string' && !field.value.trim()) continue;
    const source = positions.get(field.sourceId) || new Map(), index = source.get(field.key);
    if (index === undefined) {
      source.set(field.key,fields.length); positions.set(field.sourceId,source); fields.push(field); changed = true;
      if (field.sourceAsOf === null) warnings.push(issue(field,'IMPORT_METADATA_UNDATED',`«${field.label}» se conserva sin corte conocido de la fuente.`));
      continue;
    }
    const old = fields[index], sameValue = old.value === field.value && (old.valueType ?? (typeof old.value === 'number' ? 'money_minor' : 'text')) === (field.valueType ?? (typeof field.value === 'number' ? 'money_minor' : 'text'));
    if (typeof old.value === 'string' && !old.value.trim()) {
      fields[index] = field; changed = true;
      if (field.sourceAsOf === null) warnings.push(issue(field,'IMPORT_METADATA_UNDATED',`«${field.label}» se conserva sin corte conocido de la fuente.`));
      continue;
    }
    if (old.sourceAsOf === field.sourceAsOf && sameValue) continue;
    const comparable = old.sourceAsOf !== null && field.sourceAsOf !== null;
    if (comparable && field.sourceAsOf < old.sourceAsOf) {
      warnings.push(issue(field,'IMPORT_METADATA_OLD_CUTOFF',`«${field.label}» tiene un corte anterior; se conserva la observación vigente.`));
      continue;
    }
    if (comparable && field.sourceAsOf > old.sourceAsOf) {
      fields[index] = field; changed = true; continue;
    }
    if (sameValue) continue;
    if (reviewConfirmed !== true) {
      conflicts.push(issue(field,'IMPORT_METADATA_AUTHORITY',`«${field.label}» difiere de la observación vigente sin un corte posterior comparable. Revisa la autoridad de la fuente y registra un motivo.`));
      continue;
    }
    fields[index] = field; changed = true;
    if (field.sourceAsOf === null) warnings.push(issue(field,'IMPORT_METADATA_UNDATED',`«${field.label}» se conserva sin corte conocido de la fuente.`));
  }
  return {fields:validateImportedFields(fields,scope),changed,warnings,conflicts};
}

