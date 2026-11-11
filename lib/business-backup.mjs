import { createHash } from 'node:crypto';
import { schemas, importFields } from './schema.mjs';
import { validateRecord, validateSettings, validateOrder, fail, integer, text } from './validation.mjs';
import { convertV2Bundle, normalizeInventoryBundle, SOCIAL_TABLES, SOCIAL_INTERNAL_TABLES, INTEGRATION_INTERNAL_TABLES, ASSISTANT_INTERNAL_TABLES } from './db/migrations.mjs';
import { businessDate, instant, periodBounds, BUSINESS_PERIODS } from './business/dates.mjs';
import { ALERT_TYPES } from './business/settings.mjs';
import { stockAlertThresholds } from './business/alerts.mjs';
import { hash } from './business/commands.mjs';
import { COMMERCIAL_TABLES, CORE_BACKUP_TABLES, COMMERCIAL_COUNTERS, BACKUP_ENUMS } from './backup-schema.mjs';
import { validateImportedFields } from './business/imported-fields.mjs';
import { validateExpenseImportMetadata } from './business/expenses.mjs';
import { socialMeasurementQueryKey, clearSocialMetricWork, SOCIAL_ERROR_MESSAGES, SOCIAL_MEDIA_DIAGNOSTIC_CODES, SOCIAL_ASSET_INTERNAL_FIELDS } from './social/evidence.mjs';
import { normalizeSocialMeasurement, normalizeSocialMetric } from './business/social-metrics.mjs';
import { validateHekaImportOrigin } from './shipping/heka.mjs';

const MAX_MINOR = 10000000000000;
const SOCIAL_METRIC_FIELDS = new Set(['value', 'unit', 'sourceMetric', 'status', 'precision', 'displayValue', 'reason']);
const CATALOG_REVISION = /^[a-f0-9]{64}$/;
const ORDER_STATES = ['new','preparing','sent','delivered','returned','cancelled'];
const ORDER_FIELDS = new Set('customerName phone city department address addressNotes email documentType documentNumber notes statusReason status placedOn dateSource sellerId sellerSnapshot deliveryMethod shippingChargeMinor items subtotalMinor totalMinor cancellationOn ruleSnapshot policyReviewRequired legacyPolicyReview legacyFinancialReview recognition dispatchedOn giftCostOn giftDispatches deliverySummary economicLocked inventory inventoryOpening marketingCampaign importedFields'.split(' '));
const nullableColumns = new Set('order_id platform_id source_id external_id identity_key source_as_of external_key occurred_at occurred_on profile_id file_hash filename file_bytes_base64 expires_at entity_key unit_cost_minor transfer_id reversal_of cash_entry_id reported_on account_id settlement_receipt_id incurred_on person_id shipment_id source_key stale_since responsible_id previous_status'.split(' '));
const socialNullable = Object.freeze({social_assets:['sha256'],social_campaigns:['connection_id','asset_id'],social_deliveries:['remote_id','next_sync_at'],social_operations:['delivery_id','next_attempt_at']});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const socialRow = table => SOCIAL_TABLES.includes(table);
const assistantInternalTables = new Set(ASSISTANT_INTERNAL_TABLES);
const integrationInternalTables = new Set([...SOCIAL_INTERNAL_TABLES, ...INTEGRATION_INTERNAL_TABLES, ...assistantInternalTables]);
const assistantPrivateFields = new Set([
  'api_key_ciphertext', 'api_key_iv', 'api_key_tag', 'sessiontokenhash',
  'assistantapikey', 'assistant_api_key', 'workmemory', 'pendingquestion', 'publicresult',
]);
function rejectIntegrationInternals(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (integrationInternalTables.has(key.toLowerCase()) || assistantPrivateFields.has(key.toLowerCase())) fail('Un respaldo comercial no admite datos internos de integraciones.');
    if (['data','result_json','rule_snapshot'].includes(key) && typeof child === 'string') {
      let parsed;
      try { parsed = JSON.parse(child); } catch {}
      rejectIntegrationInternals(parsed);
    } else rejectIntegrationInternals(child);
  }
}
const assistantConfigContext = row => [row.scope, row.entity_type].some(value => /^assistant:/i.test(value || ''));
const socialContext = row => /(?:^|[:_])social(?:[:_]|$)/i.test(row.scope || row.entity_type || '');
const shippingContext = row => /^(?:shipping(?:[:_]|$)|pairing$|snapshot$)/i.test(row.scope || row.entity_type || '');
const socialAssetInternalKeys = new Set(SOCIAL_ASSET_INTERNAL_FIELDS.map(key => key.toLowerCase()));
const secretField = key => socialAssetInternalKeys.has(key.toLowerCase()) || /^(?:__proto__|prototype|constructor|password|passwd|otp|totp|otpSeed|csrf|csrfHash|csrfToken|sessionBinding|session_binding|sessionToken|session_token|storageState|storage_state|browserState|cookies?|localStorage|indexedDB|credentials|secret|token|authorization|appSecret|app_secret|app_secret_ciphertext|app_secret_iv|app_secret_tag|appsecret_proof|accessToken|access_token|refreshToken|refresh_token|userToken|pageToken|oauthCode|bearer|bearerHash|bearer_hash|pairingCode|pairing_code|ciphertext|iv|auth_tag|authTag|lease_token|leaseToken|controlKey|sessionKey|encryptionKey|signedUrl|signed_url|html|rawHtml|screenshot|frame|frames|keyboard)$/i.test(key);
function safeSocialValue(value, {redact = false} = {}) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('Dato social numérico no válido.');
  if (typeof value === 'string') {
    if (value.length > 1000000 || /(?:[?&](?:access_token|appsecret_proof|code|state|signature|sig|token|expires)=)|(?:\bBearer\s+\S+)/i.test(value)) {
      if (redact) return null;
      fail('El respaldo social contiene datos sensibles.');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(child => safeSocialValue(child,{redact}));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key,child] of Object.entries(value)) {
    if (key === 'disconnectPending' || secretField(key) || key === 'code' && !Object.hasOwn(SOCIAL_ERROR_MESSAGES,child) && !SOCIAL_MEDIA_DIAGNOSTIC_CODES.includes(child)) {
      if (redact) continue;
      fail('El respaldo social contiene un campo privado.');
    }
    if (['budgetMinor','targetCostMinor'].includes(key) && child !== null) socialMoney(child,key);
    result[key] = safeSocialValue(child,{redact});
  }
  return result;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: objeto no válido.`); return value; };
const list = (value, label) => { if (!Array.isArray(value)) fail(`Falta la colección ${label}.`); return value; };
const identifier = (value, label = 'ID') => { if (typeof value !== 'string' || !value.length || value.length > 100 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) fail(`${label}: identificador no válido.`); return value; };
const choice = (value, allowed, label) => { if (!allowed.includes(value)) fail(`${label}: opción no válida.`); return value; };
const exact = (value, label, limit = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || Math.abs(value) > limit) fail(`${label}: entero fuera de rango.`); return value; };
const money = (value, label, {signed = false, nullable = false} = {}) => { if (value === null && nullable) return value; exact(value,label,MAX_MINOR); if (!signed && value < 0) fail(`${label}: importe negativo.`); return value; };
const socialMoney = (value, label) => { exact(value,label); if (value < 0) fail(`${label}: importe negativo.`); return value; };
const unique = (rows, fields, label, nullable = false) => {
  const keys = new Set();
  for (const row of rows) {
    if (nullable && fields.some(field => row[field] == null)) continue;
    const key = JSON.stringify(fields.map(field => row[field]));
    if (keys.has(key)) fail(`${label}: clave repetida.`);
    keys.add(key);
  }
};
function importedSheetNames(origin, originSheets) {
  if (!originSheets.has(origin.id)) {
    const sheets = json(origin.data,'Lote de procedencia').workbook?.sheets;
    originSheets.set(origin.id,Array.isArray(sheets) ? new Set(sheets.map(sheet => typeof sheet === 'string' ? sheet : sheet.name)) : null);
  }
  return originSheets.get(origin.id);
}
function importedFields(fields, requireRef, batch, scope, rows, originSheets) {
  validateImportedFields(fields,scope);
  for (const field of fields) {
    requireRef('platform_sources',field.sourceId,'Fuente de dato importado');
    const origin = requireRef('import_batches',field.batchId,'Lote de dato importado');
    if (origin.source_id !== field.sourceId) fail('Dato importado de un lote de otra fuente.');
    if (batch && (field.batchId !== batch.id || field.sourceId !== batch.source_id)) fail('Dato preparado de otro lote o fuente.');
    const sheets = importedSheetNames(origin,originSheets);
    if (sheets && !sheets.has(field.sheet)) fail('Dato importado de una hoja inexistente.');
    for (const rowNumber of field.rowNumbers) if (origin.state !== 'expired' && !rows.has(JSON.stringify([field.batchId,field.sheet,rowNumber]))) fail('Dato importado sin su fila de origen.');
  }
}
function json(value, label) {
  if (typeof value !== 'string') fail(`${label}: JSON no válido.`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(`${label}: JSON no válido.`); }
  return parsed;
}
function moneyTree(value, label, aggregate = false) {
  // Measurements carry typed values; their monetary members are checked by
  // the metric schema, not as a scalar merely because the key ends in Minor.
  if (/^social_measurements\.(?:values|rows|ratios)(?:\.|$)/.test(label)) return;
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && /(?:Minor|_minor)$/.test(key)) {
      if (/^social_[a-z_]+(?:\.|$)/.test(label) && child && typeof child === 'object' && !Array.isArray(child) && child.unit === 'minor_currency') {
        if (Object.keys(child).some(field => !SOCIAL_METRIC_FIELDS.has(field))) fail(`${label}.${key}: métrica monetaria no válida.`);
        normalizeSocialMetric(child);
      } else exact(child,`${label}.${key}`,aggregate ? Number.MAX_SAFE_INTEGER : MAX_MINOR);
    }
    if (value.unit === 'minor' && ['value','knownValue','knownSubtotal'].includes(key) && child !== null) exact(child,`${label}.${key}`);
    if (child && typeof child === 'object') moneyTree(child,`${label}.${key}`,aggregate);
  }
}
async function rows(tx, table, definition) {
  return (await tx.db.all(`SELECT ${definition.columns.map(column => `"${column}"`).join(',')} FROM ${tx.t(table)} ORDER BY ${definition.key.map(column => `"${column}"`).join(',')}`)).map(row => ({...row}));
}
function reportIntent(key, data) {
  plain(data.query,'Consulta de trabajo');
  const query = {period:data.query.period,anchorDate:data.query.anchorDate,filters:{...plain(data.query.filters || {},'Filtros')}};
  validateReportQuery(query);
  if (key !== `report:${hash({period:query.period,...periodBounds(query.period,query.anchorDate),filters:query.filters})}`) fail('La identidad del informe pendiente no coincide.');
  return {kind:'report',key,requestedBy:identifier(data.requestedBy,'Administrador original'),query};
}
function importIntent(key, data) {
  const batchId = identifier(data.batchId,'Lote');
  if (key !== `import:${batchId}`) fail('La identidad del lote pendiente no coincide.');
  const phase = choice(data.phase,['inspect','preview','apply'],'Fase de importación');
  const actorId = identifier(data.actorId || data.requestedBy,'Administrador original');
  return {kind:'import',key,batchId,phase,actorId,requestedBy:identifier(data.requestedBy || actorId,'Solicitante original'),...(phase === 'apply' ? {revision:integer(data.revision,'Revisión aceptada',1)} : {})};
}

const phaseStates = Object.freeze({inspect:['uploaded'],preview:['previewing'],apply:['queued','applying']});

/** The caller supplies the single readSnapshot; no writer API is used here. */
export async function exportCommercialData(tx) {
  const bundle = {format:'allnutrition-export-v3',inventoryVersion:1,socialVersion:1,exportedAt:new Date().toISOString(),settings:await tx.settings(),orders:await tx.orders(),business:{},pendingJobs:[]};
  for (const kind of Object.keys(schemas)) bundle[kind] = await tx.list(kind);
  for (const [table, definition] of Object.entries(CORE_BACKUP_TABLES)) bundle[table] = await rows(tx,table,definition);
  bundle.counters = (await tx.db.all(`SELECT id,value FROM ${tx.t('counters')} WHERE id IN ('orders','business_revision') ORDER BY id`)).map(row => ({...row}));
  for (const [table, definition] of Object.entries(COMMERCIAL_TABLES)) bundle.business[table] = await rows(tx,table,definition);
  // Integration request results can contain ephemeral authorization responses.
  // They are not recovery intents and must never leave this database.
  bundle.business.business_requests = bundle.business.business_requests.filter(row => !socialContext(row) && !shippingContext(row) && !assistantConfigContext(row));
  bundle.business.business_audit = bundle.business.business_audit.filter(row => !shippingContext(row) && !assistantConfigContext(row)).map(row => socialContext(row) ? {...row,data:JSON.stringify(safeSocialValue(json(row.data,'Auditoría social'),{redact:true}))} : row);
  for (const table of SOCIAL_TABLES) for (const row of bundle.business[table]) {
    const data = json(row.data,table);
    if (table === 'social_connections' && Object.hasOwn(data,'disconnectPending')) { delete data.disconnectPending; row.data = JSON.stringify(data); }
    if (table === 'social_deliveries') row.data = JSON.stringify(clearSocialMetricWork(data));
    if (table === 'social_assets') {
      let changed = false;
      for (const key of SOCIAL_ASSET_INTERNAL_FIELDS) if (Object.hasOwn(data,key)) { delete data[key]; changed = true; }
      if (changed) row.data = JSON.stringify(data);
    }
    safeSocialValue(data);
  }
  if (bundle.orders.some(order => order.inventoryOpening)) bundle.inventoryVersion = 2;
  // Operational leases and scheduler cursors are deliberately not commercial rows.
  // Only accepted work's explicit inputs survive; tokens never enter the bundle.
  const jobs = await tx.db.all(`SELECT key,state,data FROM ${tx.t('job_runs')} WHERE state IN ('queued','running') AND (key LIKE 'import:%' OR key LIKE 'report:%') ORDER BY key`);
  for (const job of jobs) {
    const data = json(job.data,'Trabajo pendiente');
    if (job.key.startsWith('import:')) {
      const intent = importIntent(job.key,data), batch = bundle.business.import_batches.find(row => row.id === intent.batchId);
      // A final business commit precedes finishJob's operational cleanup.
      if (batch && phaseStates[intent.phase].includes(batch.state)) bundle.pendingJobs.push(intent);
    } else bundle.pendingJobs.push(reportIntent(job.key,data));
  }
  rejectIntegrationInternals(bundle);
  return bundle;
}

function validateReportQuery(query) {
  plain(query,'Consulta de informe');
  const bounds = periodBounds(query.period,query.anchorDate);
  if (bounds.startDate !== query.anchorDate) fail('El ancla del informe no es el inicio de su período.');
  const filters = plain(query.filters || {},'Filtros');
  for (const [key,value] of Object.entries(filters)) {
    choice(key,['seller','product','platform','carrier','status','account','source'],'Filtro');
    text(value,'Valor de filtro',key === 'carrier' ? 150 : 100,true);
    if (key === 'status') choice(value,[...ORDER_STATES,...BACKUP_ENUMS.shipments.status],'Estado del filtro');
  }
}
function commission(rule) {
  plain(rule,'Regla de comisión');
  if (typeof rule.enabled !== 'boolean') fail('Activación de comisión no válida.');
  choice(rule.mode,['percent','fixed'],'Comisión');
  integer(rule.rateBps,'Puntos básicos',0,10000);
  money(rule.fixedMinor,'Comisión fija');
  choice(rule.basis,['net_products'],'Base de comisión');
  choice(rule.earnWhen,['delivered','customer_paid','business_received'],'Devengo de comisión');
}
function rules(versions) {
  list(versions,'versiones de reglas');
  if (!versions.length) fail('Faltan reglas del negocio.');
  unique(versions,['id'],'Reglas'); unique(versions,['effectiveOn'],'Vigencias');
  for (const rule of versions) {
    identifier(rule.id,'Regla'); businessDate(rule.effectiveOn);
    choice(rule.saleRecognition,['confirmed','dispatched','delivered'],'Reconocimiento'); commission(rule.commission);
    if (rule.shippingExpenseDate != null) choice(rule.shippingExpenseDate,['charge_date','dispatch_date'],'Fecha de flete');
    if (rule.returnExpenseDate != null) choice(rule.returnExpenseDate,['charge_date','returned_date'],'Fecha de retorno');
    if (rule.platformFeeExpenseDate != null) choice(rule.platformFeeExpenseDate,['charge_date','settlement_date'],'Fecha de cargo');
  }
}
function salaries(agreements = []) {
  list(agreements,'convenios'); unique(agreements,['id'],'Convenios');
  let previous = null;
  for (const agreement of [...agreements].sort((a,b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)))) {
    identifier(agreement.id,'Convenio'); money(agreement.amountPerPeriodMinor,'Sueldo');
    choice(agreement.frequency,['weekly','halfmonthly','monthly'],'Frecuencia');
    if (typeof agreement.enabled !== 'boolean') fail('Activación de sueldo no válida.');
    businessDate(agreement.effectiveFrom); if (agreement.effectiveTo != null) businessDate(agreement.effectiveTo);
    integer(agreement.payDayOffset,'Días para pago',0,90);
    if (agreement.effectiveTo && agreement.effectiveTo < agreement.effectiveFrom) fail('Vigencia de sueldo invertida.');
    if (!agreement.enabled) continue;
    if (previous && (!previous.effectiveTo || previous.effectiveTo >= agreement.effectiveFrom)) fail('Convenios de sueldo superpuestos.');
    previous = agreement;
  }
}
function validateSQLRows(table, input, definition, {legacy = false, migrationAt} = {}) {
  const result = [];
  for (const source of list(input,table)) {
    plain(source,table);
    if (['business_requests','business_audit'].includes(table) && assistantConfigContext(source)) fail('Un respaldo comercial no admite solicitudes ni configuración del asistente.');
    if (['business_requests','business_audit'].includes(table) && shippingContext(source)) fail('Un respaldo comercial no admite consultas ni controles internos de envíos.');
    if (Object.keys(source).some(key => !definition.columns.includes(key))) fail(`${table}: columna no admitida.`);
    const row = {...source};
    if (legacy) {
      for (const field of ['created_at','updated_at','recorded_at']) if (definition.columns.includes(field) && row[field] == null) row[field] = row.recorded_at || row.updated_at || row.created_at || migrationAt;
      if (definition.columns.includes('version')) row.version ??= 1;
    }
    for (const field of definition.columns) {
      const value = row[field];
      const nullable = socialRow(table) ? (socialNullable[table] || []).includes(field) : nullableColumns.has(field);
      if (value === undefined || value === null && !nullable) fail(`${table}.${field}: valor ausente.`);
      if (value === null) continue;
      if (field === 'id' && table === 'business_settings') { if (value !== 1) fail('Configuración de negocio no válida.'); }
      else if (field === 'version' || field === 'revision' || field === 'episode' || field === 'row_number') integer(value,`${table}.${field}`,1);
      else if (field === 'bytes' && socialRow(table)) integer(value,`${table}.${field}`,0,Number.MAX_SAFE_INTEGER);
      else if (field === 'data_revision') integer(value,'Revisión de datos',0);
      else if (field === 'active' || field === 'enabled') choice(value,[0,1],field);
      else if (field.endsWith('_minor')) money(value,`${table}.${field}`,{signed:true});
      else if (field === 'data' || field === 'rule_snapshot' || field === 'result_json') {
        const parsed = json(value,`${table}.${field}`);
        if (field !== 'result_json') plain(parsed,`${table}.${field}`);
        moneyTree(parsed,table,socialRow(table) || ['report_snapshots','business_audit','business_requests','alerts'].includes(table));
        if (socialRow(table) || socialContext(row)) safeSocialValue(parsed);
      }
      else if (field.endsWith('_on') || field === 'end_on_exclusive') businessDate(value,`${table}.${field}`);
      else if (field.endsWith('_at') || field === 'source_as_of' || field === 'stale_since') row[field] = instant(value,`${table}.${field}`);
      else if (['payload_hash','preview_hash','fact_hash','query_key','file_hash','spec_hash','evidence_hash','sha256'].includes(field)) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${table}.${field}: hash no válido.`); }
      else if (field === 'id' || definition.references[field] || ['actor_id','internal_id','entity_id','request_id'].includes(field)) identifier(value,`${table}.${field}`);
      else if (typeof value !== 'string') fail(`${table}.${field}: texto no válido.`);
    }
    const enums = table === 'shipment_events' ? BACKUP_ENUMS.shipments : BACKUP_ENUMS[table] || {};
    for (const [field,values] of Object.entries(enums)) choice(row[field],values,`${table}.${field}`);
    if (table === 'alert_rules') choice(row.type,ALERT_TYPES,'Tipo de alerta');
    if (table === 'business_requests') { text(row.scope,'Operación',200,true); if (!/^[\w:-]{8,100}$/.test(row.request_id)) fail('ID de operación no válido.'); }
    if (socialRow(table)) {
      for (const field of ['id','campaign_id','connection_id','asset_id','delivery_id']) if (row[field] != null && !UUID.test(row[field])) fail(`${table}.${field}: UUID no válido.`);
      if (table === 'social_connections' && row.integration_method === 'api' && ['login_required','login_in_progress','challenge_required','layout_changed'].includes(row.state)) fail('Estado de navegador en una conexión API.');
    }
    result.push(row);
  }
  unique(result,definition.key,table);
  for (const fields of definition.unique) unique(result,fields,table,true);
  return result;
}

/** Validates and prepares without touching the destination. SQL also checks its own constraints. */
export async function prepareCommercialBundle(input, {migrationAt = new Date().toISOString()} = {}) {
  plain(input,'Respaldo');
  rejectIntegrationInternals(input);
  const legacy = input.format === 'allnutrition-export-v2';
  if (!legacy && input.format !== 'allnutrition-export-v3') fail('Formato de respaldo no reconocido.');
  if (legacy && (Object.hasOwn(input,'socialVersion') || SOCIAL_TABLES.some(table => Object.hasOwn(input.business || {},table) && (!Array.isArray(input.business[table]) || input.business[table].length)) || SOCIAL_INTERNAL_TABLES.some(table => Object.hasOwn(input.business || {},table)))) fail('El formato v2 no admite datos sociales.');
  const bundle = legacy ? convertV2Bundle(input,{migrationAt}) : structuredClone(input);
  const hasInventory = Object.hasOwn(bundle,'inventoryVersion') || list(bundle.products,'productos').some(product => Object.hasOwn(product,'stockReserved')) || list(bundle.orders,'pedidos').some(order => Object.hasOwn(order,'inventory'));
  const hasOpening = bundle.orders.some(order => order.inventoryOpening != null);
  if (Object.hasOwn(bundle,'inventoryVersion') && bundle.inventoryVersion !== (hasOpening ? 2 : 1) || hasOpening && bundle.inventoryVersion !== 2) fail('Versión de inventario del respaldo no admitida.');
  const inventoryBaseline = !hasInventory;
  const settings = {...validateSettings(bundle.settings),launchApproved:false};
  const settingsVersion = legacy ? bundle.settings?.version || 1 : integer(bundle.settings?.version,'Versión de configuración',1);
  if (!legacy) instant(bundle.exportedAt,'Fecha de exportación');
  const records = [], collections = {};
  for (const kind of Object.keys(schemas)) {
    collections[kind] = list(bundle[kind],kind).map(record => {
      plain(record,kind); identifier(record.id); integer(record.version,'Versión',1);
      const createdAt = instant(record.createdAt), updatedAt = instant(legacy ? record.updatedAt || record.createdAt : record.updatedAt);
      const data = validateRecord(kind,record); moneyTree(data,kind);
      if (kind === 'products') {
        if (Object.hasOwn(record,'stockQuantity') && record.stockQuantity !== null && (!Number.isSafeInteger(record.stockQuantity) || record.stockQuantity < 0)) fail('Existencia física del respaldo no válida.');
        data.stockQuantity = record.stockQuantity === undefined && inventoryBaseline ? null : record.stockQuantity;
        delete data.stockReserved;
        if (Object.hasOwn(record,'stockReserved')) data.stockReserved = record.stockReserved;
      }
      const row = {id:record.id,kind,slug:data.slug,title:data.title,status:data.status,sort_order:data.sort,data:JSON.stringify(data),version:record.version,created_at:createdAt,updated_at:updatedAt};
      records.push(row); return {...data,id:record.id};
    });
    unique(collections[kind],['slug'],kind);
  }
  unique(records,['id'],'Contenidos');
  const core = {};
  const orders = list(bundle.orders,'pedidos').map(order => {
    plain(order,'Pedido'); identifier(order.id); integer(order.number,'Número de pedido',1); integer(order.version,'Versión',1);
    const created = instant(order.createdAt), updated = instant(legacy ? order.updatedAt || order.createdAt : order.updatedAt);
    const {id,number,version,createdAt,updatedAt,history,...data} = order;
    if (Object.keys(data).some(key => !ORDER_FIELDS.has(key))) fail('El respaldo contiene campos de pedido retirados o resúmenes derivados.');
    if (!legacy && history !== undefined) fail('El historial v3 se conserva en sus filas originales.');
    if (legacy) for (const [index,event] of (history || []).entries()) {
      const {actorId,actorEmail,createdAt:eventAt,...rest} = event;
      (core.order_audit ||= []).push({id:digest(`restore:v2:audit:${id}:${index}`).slice(0,32),order_id:id,actor_id:actorId || 'importado',created_at:eventAt,data:JSON.stringify(rest)});
    }
    return {id,number,version,created_at:created,updated_at:updated,data:JSON.stringify(data)};
  });
  unique(orders,['id'],'Pedidos'); unique(orders,['number'],'Números de pedido');
  for (const [table,definition] of Object.entries(CORE_BACKUP_TABLES)) core[table] = validateSQLRows(table,legacy ? core[table] || [] : bundle[table],definition,{legacy,migrationAt});
  const business = {};
  plain(bundle.business,'Tablas de negocio');
  if (!Object.hasOwn(bundle,'socialVersion')) {
    for (const table of SOCIAL_TABLES) {
      if (Object.hasOwn(bundle.business,table)) {
        if (!Array.isArray(bundle.business[table]) || bundle.business[table].length) fail('Datos sociales sin versión de respaldo.');
      } else bundle.business[table] = [];
    }
  } else if (bundle.socialVersion !== 1) fail('Versión social del respaldo no admitida.');
  if (Object.keys(bundle.business).some(table => !Object.hasOwn(COMMERCIAL_TABLES,table) && !(legacy && table === 'job_runs' && Array.isArray(bundle.business[table]) && !bundle.business[table].length))) fail('Tabla comercial no admitida.');
  for (const [table,definition] of Object.entries(COMMERCIAL_TABLES)) business[table] = validateSQLRows(table,bundle.business[table],definition,{legacy,migrationAt});
  if (!legacy && business.business_settings.length !== 1) fail('Falta la configuración del negocio.');
  const maximumOrder = orders.reduce((maximum,row) => Math.max(maximum,row.number),0);
  const counters = legacy ? [{id:'orders',value:maximumOrder},{id:'business_revision',value:0}] : list(bundle.counters,'contadores');
  unique(counters,['id'],'Contadores');
  for (const row of counters) { choice(row.id,COMMERCIAL_COUNTERS,'Contador'); integer(row.value,'Contador',0); }
  if (counters.length !== COMMERCIAL_COUNTERS.length || counters.find(row => row.id === 'orders')?.value < maximumOrder) fail('Contadores comerciales incoherentes.');
  const revision = counters.find(row => row.id === 'business_revision').value;
  if (business.report_snapshots.some(row => row.data_revision > revision)) fail('La revisión de un informe excede la del negocio.');
  const prepared = {settings,settingsVersion,records,collections,orders,core,business,counters,pendingJobs:legacy ? [] : list(bundle.pendingJobs,'trabajos pendientes'),legacy};
  await validateRelationships(prepared);
  const inventoryBundle = {
    products:collections.products, combos:collections.combos,
    orders:orders.map(row => ({...json(row.data,'Pedido'),id:row.id})), business
  };
  normalizeInventoryBundle(inventoryBundle,{baseline:inventoryBaseline});
  const inventoryOrders = new Map(inventoryBundle.orders.map(order => [order.id,order]));
  const inventoryProducts = new Map(collections.products.map(product => [product.id,product]));
  const inventoryCombos = new Map(collections.combos.map(combo => [combo.id,combo]));
  for (const row of orders) {
    const {id,...data} = inventoryOrders.get(row.id);
    row.data = JSON.stringify(data);
  }
  for (const row of records) if (row.kind === 'products' || row.kind === 'combos') {
    const {id,...data} = (row.kind === 'products' ? inventoryProducts : inventoryCombos).get(row.id);
    row.data = JSON.stringify(data);
  }
  prepared.pendingJobs = restoreIntents(prepared);
  return prepared;
}

async function validateRelationships(bundle) {
  const all = {...bundle.business,...bundle.core,records:bundle.records,orders:bundle.orders,...bundle.collections};
  const maps = Object.fromEntries(Object.entries(all).map(([table,items]) => [table,new Map(items.filter(row => row.id !== undefined).map(row => [row.id,row]))]));
  const importRowRefs = new Set(all.import_rows.map(row => JSON.stringify([row.batch_id,row.sheet,row.row_number])));
  const originSheets = new Map();
  const requireRef = (table,id,label) => { if (id == null) return null; if (table !== 'business_settings' || id !== 1) identifier(id,label); const row = maps[table]?.get(id); if (!row) fail(`${label}: referencia inexistente en ${table}.`); return row; };
  for (const [table,definition] of Object.entries({...COMMERCIAL_TABLES,...CORE_BACKUP_TABLES})) for (const row of all[table]) for (const [field,target] of Object.entries(definition.references)) requireRef(target,row[field],`${table}.${field}`);
  const parsed = row => json(row.data,'Datos');
  const orderData = new Map(bundle.orders.map(row => [row.id,parsed(row)]));
  const orderLine = (orderId,lineId) => { const line = orderData.get(orderId)?.items?.find(item => item.lineId === lineId); if (!line) fail('Una asociación apunta a una línea de pedido inexistente.'); return line; };
  const dataRef = (data,key,table) => { if (data[key] != null) requireRef(table,data[key],key); };
  unique(bundle.collections.products.filter(row => row.sku),['sku'],'SKU');
  for (const row of all.platforms) if (row.name_key !== row.name.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ')) fail('Identidad normalizada de plataforma incoherente.');
  for (const row of all.order_events) {
    if (row.previous_status != null) choice(row.previous_status,ORDER_STATES,'Estado histórico anterior');
    choice(row.next_status,ORDER_STATES,'Estado histórico siguiente');
  }
  for (const kind of ['products','combos']) for (const record of bundle.collections[kind]) {
    for (const id of record.catalogIds || []) requireRef('catalogs',id,'Catálogo');
    for (const line of record.items || []) { const product = requireRef('products',line.productId,'Componente'); if (product.id === record.id || product.productType === 'gift') fail('Composición de producto no válida.'); }
  }
  for (const order of bundle.orders) {
    const data = orderData.get(order.id);
    if (Object.hasOwn(data,'importedFields')) importedFields(data.importedFields,requireRef,null,'order',importRowRefs,originSheets);
    if (data.marketingCampaign != null) text(data.marketingCampaign,'Campaña de origen',200);
    if (data.inventoryOpening) {
      const opening = plain(data.inventoryOpening,'Apertura de inventario');
      const source = requireRef('platform_sources',opening.sourceId,'Fuente de apertura'), batch = requireRef('import_batches',opening.batchId,'Lote de apertura');
      if (batch.source_id !== source.id) fail('Apertura de inventario de otra fuente.');
      businessDate(opening.on,'Fecha de apertura'); identifier(opening.confirmedBy,'Confirmación de apertura'); instant(opening.confirmedAt);
      for (const [key,table,idKey] of [['eventClassifications','shipment_events','eventId'],['returnClassifications','order_returns','returnId']]) {
        unique(list(opening[key],key),[idKey],'Clasificaciones de apertura');
        for (const classification of opening[key]) {
          const fact = requireRef(table,classification[idKey],'Hecho de apertura');
          const ownerId = table === 'shipment_events' ? requireRef('shipments',fact.shipment_id,'Envío de apertura').order_id : fact.order_id;
          if (ownerId !== order.id || typeof classification.included !== 'boolean') fail('Clasificación de apertura ajena al pedido o no confirmada.');
          identifier(classification.confirmedBy,'Autor de clasificación'); instant(classification.confirmedAt); text(classification.reason,'Motivo de clasificación',2000,true);
        }
      }
    }
    await validateOrder(data,async (kind,id) => requireRef(kind,id,'Referencia'),data);
    choice(data.status,ORDER_STATES,'Estado del pedido'); choice(data.deliveryMethod,['carrier','local','pickup'],'Modalidad');
    businessDate(data.placedOn,'Fecha del pedido',{nullable:true}); dataRef(data,'sellerId','people');
    if (data.sellerSnapshot && data.sellerSnapshot.id !== data.sellerId) fail('Vendedor histórico incoherente.');
    unique(data.items.filter(line => line.externalLineId != null),['externalLineId'],'Identidades externas de línea');
    list(data.items,'líneas de pedido'); if (!data.items.length || data.items.length > 50) fail('Cantidad de líneas no válida.'); unique(data.items,['lineId'],'Líneas');
    let subtotal = 0n;
    for (const line of data.items) {
      identifier(line.lineId); choice(line.kind,['products','combos'],'Referencia'); requireRef(line.kind,line.itemId,'Referencia del pedido');
      if (line.externalLineId != null) text(line.externalLineId,'Identidad externa de línea',200,true);
      choice(line.productType,['product','gift','combo'],'Tipo de línea'); integer(line.quantity,'Cantidad',1,999); money(line.unitPriceMinor,'Precio'); money(line.discountMinor,'Descuento'); money(line.unitCostMinor,'Costo',{nullable:true});
      if (!line.unitPriceMinor && line.productType !== 'gift') fail('Precio cero fuera de obsequio.');
      const net = BigInt(line.quantity)*BigInt(line.unitPriceMinor)-BigInt(line.discountMinor);
      if (net < 0n || net > BigInt(MAX_MINOR)) fail('Importe de línea no válido.'); subtotal += net;
      for (const component of list(line.components,'componentes históricos')) { requireRef('products',component.productId,'Componente histórico'); integer(component.quantity,'Cantidad componente',1,999); money(component.unitCostMinor,'Costo componente',{nullable:true}); }
    }
    money(data.shippingChargeMinor,'Flete'); money(data.subtotalMinor,'Subtotal'); money(data.totalMinor,'Total');
    if (subtotal !== BigInt(data.subtotalMinor) || subtotal+BigInt(data.shippingChargeMinor) !== BigInt(data.totalMinor)) fail('Totales del pedido incoherentes.');
    moneyTree(data,'Pedido');
    if (data.ruleSnapshot) rules([data.ruleSnapshot]);
    for (const key of ['policyReviewRequired','legacyPolicyReview','economicLocked']) if (data[key] != null && typeof data[key] !== 'boolean') fail('Estado de revisión del pedido no válido.');
    if (data.recognition) { businessDate(data.recognition.on); choice(data.recognition.basis,['confirmed','dispatched','delivered'],'Reconocimiento'); if (!data.ruleSnapshot || data.recognition.ruleVersionId !== data.ruleSnapshot.id) fail('Reconocimiento sin regla histórica.'); }
    for (const key of ['dispatchedOn','giftCostOn','cancellationOn']) if (data[key] != null) businessDate(data[key]);
    for (const fact of data.giftDispatches || []) { orderLine(order.id,fact.lineId); integer(fact.quantity,'Unidades despachadas',1,999); businessDate(fact.on); }
  }
  const sourceFor = row => requireRef('platform_sources',row.source_id,'Fuente');
  for (const row of all.shipments) {
    if (row.source_id && sourceFor(row).platform_id !== row.platform_id) fail('Fuente de envío de otra plataforma.');
    const data = parsed(row);
    if (Object.hasOwn(data,'importedFields')) importedFields(data.importedFields,requireRef,null,'shipment',importRowRefs,originSheets);
    if (data.costStatus != null) choice(data.costStatus,['known','unknown'],'Cobertura de costo logístico');
    for (const status of Object.values(data.costStatuses || {})) choice(status,['known','unknown'],'Cobertura de cargo');
    if (data.replacesShipmentId) { const previous = requireRef('shipments',data.replacesShipmentId,'Envío sustituido'); if (previous.order_id !== row.order_id || previous.id === row.id) fail('Sustitución de envío incoherente.'); }
    if (data.estimatedDeliveryOn != null) businessDate(data.estimatedDeliveryOn);
    unique(list(data.assignments || [],'asignaciones'),['lineId'],'Asignaciones');
    for (const assigned of data.assignments || []) { const line = orderLine(row.order_id,assigned.lineId); integer(assigned.quantity,'Cantidad asignada',1,line.quantity); }
    for (const [source,cut] of Object.entries(data.sourceCuts || {})) { requireRef('platform_sources',source,'Corte de fuente'); instant(cut.sourceAsOf); choice(cut.precision,['day','instant'],'Precisión de corte'); cut.precision === 'day' ? businessDate(cut.value) : instant(cut.value); }
    for (const [source,observation] of Object.entries(data.collectionObservations || {})) {
      requireRef('platform_sources',source,'Fuente de recaudo'); instant(observation.sourceAsOf);
      for (const id of observation.collectionIds || []) if (requireRef('order_collections',id,'Recaudo observado').shipment_id !== row.id) fail('Observación de recaudo de otro envío.');
    }
    for (const observation of Object.values(data.costObservations || {})) {
      dataRef(observation,'sourceId','platform_sources');
      if (observation.sourceAsOf != null) instant(observation.sourceAsOf);
      if (observation.chargeOn != null) businessDate(observation.chargeOn);
    }
    if (data.importTask?.batchId) requireRef('import_batches',data.importTask.batchId,'Lote del envío por vincular');
  }
  for (const row of all.shipment_events) {
    if (row.occurred_at && row.occurred_on) fail('Evento con dos precisiones de fecha.');
    const data = parsed(row); if (data.source != null) choice(data.source,['manual','excel','legacy'],'Fuente de evento');
    if (data.correctionOf) { const previous = requireRef('shipment_events',data.correctionOf,'Evento corregido'); if (previous.shipment_id !== row.shipment_id || previous.id === row.id) fail('Corrección de otro envío.'); }
  }
  for (const row of all.people) {
    const data = parsed(row); salaries(data.salaryAgreements || []);
    if (data.userId != null) identifier(data.userId,'Usuario vinculado');
    unique(data.commissionOverrides || [],['id'],'Comisiones del vendedor'); unique(data.commissionOverrides || [],['effectiveOn'],'Vigencias del vendedor');
    for (const rule of data.commissionOverrides || []) { identifier(rule.id); businessDate(rule.effectiveOn); commission(rule); }
  }
  for (const row of all.business_settings) {
    const data = parsed(row);
    choice(data.currency,['COP'],'Moneda'); choice(data.timeZone,['America/Bogota'],'Zona'); rules(data.rulesVersions); businessDate(data.reportsStartOn);
    for (const key of ['setupCompleted','setupPolicyConfirmed']) if (data[key] != null && typeof data[key] !== 'boolean') fail('Estado de configuración no válido.');
    list(data.reportPeriods,'períodos'); if (!data.reportPeriods.length || new Set(data.reportPeriods).size !== data.reportPeriods.length) fail('Períodos repetidos o ausentes.'); for (const period of data.reportPeriods) choice(period,BUSINESS_PERIODS,'Período');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.reportGenerationTime)) fail('Hora del informe no válida.');
    dataRef(data,'defaultReceiptAccountId','cash_accounts'); dataRef(data,'defaultPaymentAccountId','cash_accounts');
    if (data.alertDefaults) { dataRef(data.alertDefaults,'responsibleId','people'); integer(data.alertDefaults.reminderHours,'Recordatorio',1,87600); }
  }
  for (const row of all.alert_rules) {
    const data = parsed(row); dataRef(data,'responsibleId','people');
    if (data.reminderHours != null) integer(data.reminderHours,'Recordatorio',1,87600);
    if(row.type==='stock_low')stockAlertThresholds(data.thresholds);
    else for (const threshold of Object.values(data.thresholds || {})) if (threshold != null) integer(threshold,'Umbral',0);
    for (const status of data.selectedStatuses || []) choice(status,BACKUP_ENUMS.shipments.status,'Estado de regla');
  }
  const alertEntities = {shipment:'shipments',source:'platform_sources',collection:'order_collections',cash_account:'cash_accounts',cash_closing:'cash_closings',order:'orders',expense:'expenses',product:'products'};
  for (const row of all.alerts) {
    const data = parsed(row); dataRef(data,'responsibleOverrideId','people');
    const table = alertEntities[row.entity_type]; if (!table) fail('Entidad de alerta no válida.');
    requireRef(table,row.entity_id,'Entidad de alerta');
    for (const key of ['startEventId','lastEventId','endEventId']) if (data[key] != null) requireRef('shipment_events',data[key],'Evento de alerta');
  }
  const entityTables = {order:'orders',product:'products',person:'people',shipment:'shipments',collection:'order_collections',settlement:'settlements'};
  for (const row of all.external_links) {
    const table = row.entity_type === 'product' && maps.combos.has(row.internal_id) ? 'combos' : entityTables[row.entity_type];
    requireRef(table,row.internal_id,'Alias externo');
  }
  for (const row of all.cash_entries) {
    const account = requireRef('cash_accounts',row.account_id,'Cuenta');
    if (row.effective_on < account.opening_on || row.amount_minor === 0 && row.kind !== 'opening') fail('Movimiento fuera de apertura o sin importe.');
    if (row.reversal_of) { const original = requireRef('cash_entries',row.reversal_of,'Movimiento original'); if (original.reversal_of || row.amount_minor !== -original.amount_minor || row.account_id !== original.account_id) fail('Reversión de caja incoherente.'); }
    const data = parsed(row); for (const [key,table] of Object.entries({orderId:'orders',expenseId:'expenses',personId:'people',payrollId:'payroll_periods',settlementId:'settlements'})) dataRef(data,key,table);
    const sourceTables = {account:'cash_accounts',collection:'order_collections',refund:'order_collections',settlement_receipt:'settlement_receipts',expense_payment:'expense_payments'};
    if (sourceTables[row.source_type]) requireRef(sourceTables[row.source_type],row.source_id,'Origen de caja');
  }
  unique(all.cash_entries.filter(row => row.kind === 'opening'),['account_id'],'Apertura');
  for (const account of all.cash_accounts) if (!all.cash_entries.some(row => row.account_id === account.id && row.kind === 'opening')) fail('Cuenta sin apertura explícita.');
  for (const row of all.cash_accounts) {
    const data = parsed(row);
    money(data.minimumMinor,'Saldo mínimo',{signed:true,nullable:true}); money(data.toleranceMinor,'Tolerancia');
    if (typeof data.closingEnabled !== 'boolean' || data.closingTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.closingTime) || data.closingEnabled && (row.type !== 'cash' || !data.closingTime)) fail('Configuración de cierre no válida.');
  }
  const transfers = new Map();
  for (const row of all.cash_entries.filter(row => row.transfer_id && !row.reversal_of)) { const entries = transfers.get(row.transfer_id) || []; entries.push(row); transfers.set(row.transfer_id,entries); }
  for (const entries of transfers.values()) if (entries.length !== 2 || entries[0].account_id === entries[1].account_id || entries[0].amount_minor !== -entries[1].amount_minor) fail('Transferencia incompleta.');
  for (const row of all.cash_closings) if (row.difference_minor !== row.counted_minor-row.expected_minor) fail('Diferencia de cierre incoherente.');
  for (const row of all.order_collections) {
    if (row.amount_minor <= 0) fail('Cobro sin importe positivo.');
    if (row.shipment_id && requireRef('shipments',row.shipment_id,'Envío').order_id !== row.order_id) fail('Cobro de otro pedido.');
    let signedAmount = row.kind === 'refund' ? -row.amount_minor : row.amount_minor;
    if (row.reversal_of) {
      const original = requireRef('order_collections',row.reversal_of,'Cobro original');
      if (original.order_id !== row.order_id || original.amount_minor !== row.amount_minor || original.holder !== row.holder || original.reversal_of || row.kind !== 'reversal') fail('Reversión de cobro incoherente.');
      signedAmount = original.kind === 'refund' ? row.amount_minor : -row.amount_minor;
    } else if (row.kind === 'reversal') fail('Reversión sin cobro original.');
    if (row.cash_entry_id && requireRef('cash_entries',row.cash_entry_id,'Caja').amount_minor !== signedAmount) fail('Cobro y caja incoherentes.');
  }
  const settlementLines = (row,data,{declaration=false} = {}) => {
    let net = 0n;
    for (const line of list(data.lines,'líneas de liquidación')) {
      const collection = requireRef('order_collections',line.collectionId,'Recaudo liquidado'); money(line.grossMinor,'Bruto liquidado'); net += BigInt(line.grossMinor);
      if (line.grossMinor > collection.amount_minor) fail('Bruto superior al recaudo.');
      for (const deduction of list(line.deductions || [],'deducciones')) { requireRef('expenses',deduction.expenseId,'Gasto retenido'); money(deduction.amountMinor,'Deducción',{signed:true}); net -= BigInt(deduction.amountMinor); }
    }
    if (net !== BigInt(row.reversal_of ? -row.net_minor : row.net_minor) && !(declaration && data.reconciliationRequired === true && row.state !== 'confirmed')) fail('Neto de liquidación incoherente.');
  };
  for (const row of all.settlements) {
    const data = parsed(row); settlementLines(row,data,{declaration:true});
    if (data.sourceAsOf != null) instant(data.sourceAsOf);
    for (const line of data.unresolvedLines || []) {
      if (line.shipmentId && requireRef('shipments',line.shipmentId,'Envío por conciliar').source_id !== row.source_id) fail('Declaración pendiente de otra fuente.');
      if (line.batchId && requireRef('import_batches',line.batchId,'Lote por conciliar').source_id !== row.source_id) fail('Declaración pendiente de otro lote.');
    }
  }
  for (const row of all.settlement_receipts) {
    settlementLines(row,parsed(row));
    if (row.net_minor === 0 ? row.cash_entry_id != null : !row.cash_entry_id || !row.account_id) fail('Recibo sin movimiento neto coherente.');
    if (row.cash_entry_id) { const cash = requireRef('cash_entries',row.cash_entry_id,'Caja recibo'); if (cash.amount_minor !== row.net_minor || cash.account_id !== row.account_id) fail('Recibo y caja incoherentes.'); }
    if (row.reversal_of && requireRef('settlement_receipts',row.reversal_of,'Recibo original').net_minor !== -row.net_minor) fail('Reversión de recibo incoherente.');
  }
  for (const row of all.expenses) {
    if (row.amount_minor < 0 && !row.source_key) fail('Gasto negativo sin origen.');
    if (row.shipment_id && row.order_id && requireRef('shipments',row.shipment_id,'Envío de gasto').order_id !== row.order_id) fail('Gasto de otro envío.');
    const data = parsed(row);
    if (Object.hasOwn(data,'importedFields')) importedFields(data.importedFields,requireRef,null,'expense',importRowRefs,originSheets);
    if (data.sourceId != null) requireRef('platform_sources',data.sourceId,'Fuente del gasto');
    if (data.sourceAsOf != null) instant(data.sourceAsOf,'Corte del gasto');
    validateExpenseImportMetadata(data);
    if (data.importIdentity != null || row.source_key?.startsWith('excel-expense:')) {
      const identity = plain(data.importIdentity,'Identidad importada del gasto');
      if (!data.sourceId || row.source_key !== `excel-expense:${hash([data.sourceId,identity.externalId])}` || !['advertising','operating','other'].includes(row.category) || row.person_id || row.order_id || row.shipment_id || row.amount_minor < 0) fail('Identidad o naturaleza del gasto importado incoherente.');
    }
    for (const [key,table] of Object.entries({payrollId:'payroll_periods',originalExpenseId:'expenses',returnId:'order_returns',commissionId:'commission_entries',originalCommissionId:'commission_entries'})) dataRef(data,key,table);
  }
  for (const row of all.expense_payments) {
    if (!!row.cash_entry_id === !!row.settlement_receipt_id || row.amount_minor === 0) fail('Pago de gasto sin fuente exclusiva.');
    if (row.kind === 'payment' && row.amount_minor < 0 || row.kind === 'recovery' && row.amount_minor > 0 || row.kind === 'reversal' && !row.reversal_of || row.kind !== 'reversal' && row.reversal_of) fail('Tipo de pago de gasto incoherente.');
    if (row.reversal_of) { const original = requireRef('expense_payments',row.reversal_of,'Pago original'); if (original.amount_minor !== -row.amount_minor || original.expense_id !== row.expense_id || original.reversal_of) fail('Reversión de pago incoherente.'); }
    const data = parsed(row); dataRef(data,'payrollId','payroll_periods'); dataRef(data,'advanceAllocationId','payroll_allocations');
  }
  const returned = new Map(), shippingCredits = new Map();
  for (const row of all.order_returns) {
    const data = parsed(row); money(data.shippingCreditMinor,'Crédito de flete');
    const shipping = (shippingCredits.get(row.order_id) || 0n)+BigInt(data.shippingCreditMinor);
    if (shipping > BigInt(orderData.get(row.order_id).shippingChargeMinor)) fail('Crédito de flete superior al acordado.');
    shippingCredits.set(row.order_id,shipping);
    const lines = list(data.lines,'líneas de devolución'); unique(lines,['lineId'],'Líneas devueltas');
    for (const line of lines) {
      const original = orderLine(row.order_id,line.lineId);
      integer(line.quantity,'Cantidad devuelta',1,original.quantity); choice(line.condition,['recoverable','non_recoverable'],'Condición');
      money(line.salesCreditMinor,'Crédito de venta'); money(line.recoveredCostMinor,'Costo recuperado',{nullable:true});
      if (line.condition === 'non_recoverable' && line.recoveredCostMinor !== 0) fail('Mercancía no recuperable con recuperación de costo.');
      const key = JSON.stringify([row.order_id,line.lineId]), previous = returned.get(key) || {quantity:0,credit:0n};
      const quantity = previous.quantity+line.quantity, credit = previous.credit+BigInt(line.salesCreditMinor);
      if (quantity > original.quantity || credit > BigInt(original.quantity)*BigInt(original.unitPriceMinor)-BigInt(original.discountMinor)) fail('Devolución superior a lo comprado.');
      returned.set(key,{quantity,credit});
    }
  }
  for (const row of all.payroll_periods) { if (row.start_on >= row.end_on_exclusive) fail('Período salarial invertido.'); salaries(parsed(row).salaryAgreements || []); for (const id of parsed(row).reversedAdvanceAllocationIds || []) requireRef('payroll_allocations',id,'Anticipo revertido'); }
  for (const row of all.payroll_allocations) { const source = requireRef(row.source_type === 'expense' ? 'expenses' : 'cash_entries',row.source_id,'Origen salarial'); const person = requireRef('payroll_periods',row.payroll_id,'Sueldo').person_id; if (row.amount_minor === 0 || row.source_type === 'advance' && (source.kind !== 'advance' || parsed(source).personId !== person) || row.source_type === 'expense' && source.person_id !== person) fail('Asignación salarial incoherente.'); }
  for (const row of all.payroll_offsets) { const debit = requireRef('expenses',row.debit_expense_id,'Débito'); const credit = requireRef('expenses',row.credit_expense_id,'Crédito'); const person = requireRef('payroll_periods',row.payroll_id,'Sueldo').person_id; if (row.amount_minor <= 0 || debit.id === credit.id || debit.amount_minor <= 0 || credit.amount_minor >= 0 || debit.person_id !== person || credit.person_id !== person) fail('Compensación salarial incoherente.'); }
  for (const row of all.commission_entries) { const expense = requireRef('expenses',row.expense_id,'Comisión'); if (expense.category !== 'commission' || expense.amount_minor !== row.amount_minor || expense.person_id !== row.person_id || expense.order_id !== row.order_id) fail('Comisión y gasto incoherentes.'); }
  for (const row of all.report_snapshots) {
    const report = parsed(row), bounds = periodBounds(row.period,row.start_on);
    validateReportQuery({period:report.query?.period,anchorDate:report.query?.anchorDate,filters:report.query?.filters});
    const queryKey = hash({period:report.query.period,...bounds,filters:report.query.filters});
    if (bounds.startDate !== row.start_on || bounds.endDateExclusive !== row.end_on_exclusive || report.query.period !== row.period || report.query.anchorDate !== row.start_on || report.dataRevision !== row.data_revision || report.queryKey !== row.query_key || queryKey !== row.query_key || report.factHash !== row.fact_hash) fail('Identidad del snapshot incoherente.');
    instant(report.generatedAt); instant(report.dataAsOf); instant(report.query.asOf);
    for (const metric of Object.values(plain(report.metrics,'Métricas guardadas'))) {
      choice(metric.unit,['minor','count','bps','days'],'Unidad de métrica');
      if (typeof metric.complete !== 'boolean') fail('Cobertura de métrica no válida.');
      for (const field of ['eligibleCount','knownCount','excludedCount']) integer(metric[field],field,0);
      if (metric.knownCount+metric.excludedCount !== metric.eligibleCount) fail('Cobertura de métrica incoherente.');
      for (const field of ['value','knownValue']) if (metric[field] != null) {
        if (metric.unit === 'days') { if (typeof metric[field] !== 'number' || !Number.isFinite(metric[field])) fail('Promedio no válido.'); }
        else exact(metric[field],'Métrica monetaria o contador');
      }
    }
  }
  validateSocialRelationships(all,requireRef,parsed);
  await validateImports(all,requireRef,parsed,originSheets);
}

function validateSocialRelationships(all, requireRef, parsed) {
  const revisions = new Map(all.social_revisions.map(row => [JSON.stringify([row.campaign_id,row.revision]),row]));
  const revisionFor = delivery => {
    const revision = revisions.get(JSON.stringify([delivery.campaign_id,delivery.revision]));
    if (!revision) fail('Entrega social sin su revisión aprobada.');
    return revision;
  };
  const methodFor = campaign => {
    if (!campaign.connection_id) fail('Campaña social sin conexión.');
    return requireRef('social_connections',campaign.connection_id,'Conexión social').integration_method;
  };
  const method = (data, expected) => {
    choice(data.integrationMethod,['api','browser'],'Vía social');
    if (data.integrationMethod !== expected) fail('La evidencia social pertenece a otra vía.');
  };
  const spec = (value, campaign) => {
    const data = plain(value,'Especificación social');
    method(data,methodFor(campaign));
    if (data.connectionId !== campaign.connection_id || data.assetId !== campaign.asset_id) fail('Especificación social de otra conexión o pieza.');
    if (!CATALOG_REVISION.test(data.assetHash || '')) fail('Hash de pieza social no válido.');
    if (requireRef('social_assets',data.assetId,'Pieza aprobada').sha256 !== data.assetHash) fail('Hash de aprobación distinto de la pieza conservada.');
    if (data.assetType != null) {
      choice(data.assetType,['image','video'],'Formato aprobado');
      if (data.assetType !== parsed(requireRef('social_assets',data.assetId,'Pieza aprobada')).kind) fail('Formato de aprobación distinto de la pieza conservada.');
    }
    plain(data.identities,'Identidades sociales');
    choice(data.mode,['organic','paid'],'Modalidad social');
    choice(data.objective,['whatsapp','traffic','reach','engagement'],'Objetivo social');
    if (data.mode !== campaign.mode || data.objective !== campaign.objective) fail('Modalidad u objetivo social incoherente.');
    text(data.name,'Campaña social',200,true);
    for (const [key,limit] of [['caption',2200],['headline',40]]) if (data[key] != null) text(data[key],key,limit);
    if (data.publishAt != null) instant(data.publishAt,'Publicación social');
    if (data.observationDays != null) choice(data.observationDays,[7,14,28],'Horizonte social');
    if (data.targetCostMinor != null) socialMoney(data.targetCostMinor,'Costo objetivo');
    if (data.mode === 'paid') {
      socialMoney(data.budgetMinor,'Presupuesto social');
      if (data.budgetMinor <= 0 || !/^[A-Z]{3}$/.test(data.currency || '')) fail('Presupuesto o moneda social no válido.');
      const start = instant(data.startAt,'Inicio social'), end = instant(data.endAt,'Fin social');
      if (end <= start || Date.parse(end)-Date.parse(start) > 90*86400000) fail('Período de inversión social no válido.');
    } else if (data.budgetMinor != null && data.budgetMinor !== 0) fail('Una publicación orgánica no tiene inversión.');
    return data;
  };
  for (const row of all.social_connections) {
    const data = parsed(row);
    integer(data.sessionEpoch,'Epoch social',0,Number.MAX_SAFE_INTEGER-1);
    if (data.capabilities != null) for (const [key,value] of Object.entries(plain(data.capabilities,'Capacidades sociales'))) {
      choice(key,['facebookPublish','instagramPublish','adsPublish','insights','whatsappAds'],'Capacidad social');
      if (typeof value !== 'boolean') fail('Capacidad social no válida.');
    }
  }
  const mediaFormats = {
    'image/jpeg': {kind:'image',extension:'jpg'},
    'image/png': {kind:'image',extension:'png'},
    'image/webp': {kind:'image',extension:'webp'},
    'video/mp4': {kind:'video',extension:'mp4'},
    'video/quicktime': {kind:'video',extension:'mov'}
  };
  for (const row of all.social_assets) {
    const data = parsed(row);
    choice(data.kind,['image','video'],'Tipo de pieza social');
    if (!Object.hasOwn(mediaFormats,data.contentType) || mediaFormats[data.contentType].kind !== data.kind) fail('Tipo de contenido social incoherente.');
    text(data.name,'Nombre de pieza social',200,true);
    const maximum = (data.kind === 'image' ? 10 : 250)*1024*1024, derivativeMaximum = data.kind === 'image' ? 8000000 : 250*1024*1024;
    exact(data.expectedBytes,'Tamaño esperado social',maximum);
    exact(data.reservedBytes,'Reserva de piezas sociales',maximum+derivativeMaximum);
    if (data.expectedBytes <= 0 || data.reservedBytes < 0 || data.reservedBytes > data.expectedBytes+derivativeMaximum) fail('Tamaño o reserva social fuera de rango.');
    if (!['uploading','processing'].includes(row.state) && data.reservedBytes !== 0) fail('Reserva social sin trabajo de carga o procesamiento.');
    if (data.originalKey !== `${row.id}/original.${mediaFormats[data.contentType].extension}`) fail('Clave de original social no válida.');
    const hasOriginal = data.originalSha256 != null || data.originalBytes != null;
    if (hasOriginal) {
      if (!CATALOG_REVISION.test(data.originalSha256 || '')) fail('Hash de original social no válido.');
      exact(data.originalBytes,'Bytes del original social',maximum);
      if (data.originalBytes <= 0 || data.originalBytes !== data.expectedBytes) fail('Tamaño del original social incoherente.');
    }
    const hasDerivative = data.derivativeKey != null || data.derivativeSha256 != null || data.derivativeBytes != null || data.derivativeContentType != null;
    if (hasDerivative) {
      if (!hasOriginal || data.derivativeKey !== `${row.id}/derivative.${data.kind === 'image' ? 'jpg' : 'mp4'}` || !CATALOG_REVISION.test(data.derivativeSha256 || '') || data.derivativeSha256 !== row.sha256 || data.derivativeContentType !== (data.kind === 'image' ? 'image/jpeg' : 'video/mp4')) fail('Derivado social incoherente.');
      exact(data.derivativeBytes,'Bytes del derivado social',derivativeMaximum);
      if (data.derivativeBytes <= 0) fail('Derivado social sin contenido.');
    } else if (row.sha256 != null) fail('Hash social sin un derivado declarado.');
    if (row.state === 'ready' && (!hasOriginal || !hasDerivative)) fail('Pieza social lista sin original o derivado.');
    if (row.state === 'processing' && !hasOriginal || row.state === 'uploading' && hasOriginal) fail('Estado de carga social incoherente.');
    if (row.state !== 'missing_file' && row.bytes !== (hasOriginal ? data.originalBytes : 0)+(hasDerivative ? data.derivativeBytes : 0)) fail('Bytes retenidos sociales incoherentes.');
    if (data.uploadExpiresAt != null) instant(data.uploadExpiresAt,'Vencimiento de carga social');
    if (data.restoreState != null) choice(data.restoreState,['uploading','processing','ready','failed','archived','missing_file'],'Estado social previo a recuperación');
  }
  for (const row of all.social_campaigns) {
    const data = parsed(row);
    text(row.name,'Campaña social',200,true);
    if (row.state !== 'draft' && (!row.connection_id || !row.asset_id)) fail('Campaña aprobada sin conexión o pieza.');
    if (data.integrationMethod != null) method(data,methodFor(row));
    if (data.restore_hold != null && typeof data.restore_hold !== 'boolean') fail('Bloqueo de recuperación social no válido.');
    if (data.budgetMinor != null) socialMoney(data.budgetMinor,'Presupuesto social');
    if (data.parentCampaignId != null) {
      if (data.parentCampaignId === row.id) fail('Una campaña no puede derivar de sí misma.');
      requireRef('social_campaigns',data.parentCampaignId,'Campaña de origen');
    }
    if (data.sourceRecommendationId != null) {
      const recommendation = requireRef('social_recommendations',data.sourceRecommendationId,'Recomendación de origen');
      if (recommendation.campaign_id !== data.parentCampaignId) fail('Recomendación de otra campaña de origen.');
    }
    if (data.forecastId != null) {
      const forecast = requireRef('social_forecasts',data.forecastId,'Pronóstico social');
      if (forecast.campaign_id !== row.id) fail('Pronóstico de otra campaña.');
    }
  }
  for (const row of all.social_revisions) {
    const campaign = requireRef('social_campaigns',row.campaign_id,'Campaña aprobada'), data = parsed(row);
    const approvedSpec = spec(data.spec,campaign);
    if (hash(approvedSpec) !== row.spec_hash) fail('Hash de aprobación social incoherente.');
    if (data.forecastId != null) {
      const forecast = requireRef('social_forecasts',data.forecastId,'Pronóstico aprobado');
      if (forecast.campaign_id !== row.campaign_id || forecast.spec_hash !== row.spec_hash || hash(data.forecast) !== hash(parsed(forecast))) fail('Pronóstico aprobado incoherente.');
    } else if (data.forecast != null) fail('Pronóstico aprobado sin referencia.');
  }
  for (const row of all.social_deliveries) {
    revisionFor(row);
    const campaign = requireRef('social_campaigns',row.campaign_id,'Campaña de entrega');
    if ((campaign.mode === 'paid') !== (row.channel === 'meta_ads')) fail('Canal de entrega incompatible con modalidad.');
    const data = parsed(row);
    if (data.integrationMethod != null) method(data,methodFor(campaign));
    if (data.metricSync != null) plain(data.metricSync,'Estado de métricas');
    if (hash(clearSocialMetricWork(structuredClone(data))) !== hash(data)) fail('El respaldo social no puede restaurar cursores ni consultas ejecutables.');
  }
  for (const row of all.social_operations) {
    const campaign = requireRef('social_campaigns',row.campaign_id,'Campaña de operación'), data = parsed(row);
    method(data,methodFor(campaign));
    if (data.payloadHash != null && !CATALOG_REVISION.test(data.payloadHash)) fail('Hash de intención social no válido.');
    text(row.step,'Etapa social',200,true);
    if (row.delivery_id == null) {
      if (campaign.mode !== 'paid' || data.integrationMethod !== 'browser' || !row.operation_key.startsWith(`preflight:${campaign.id}:`) || row.operation_key.length <= `preflight:${campaign.id}:`.length) fail('Operación social sin entrega que no es preflight.');
    } else {
      const delivery = requireRef('social_deliveries',row.delivery_id,'Entrega de operación');
      if (delivery.campaign_id !== row.campaign_id || row.operation_key !== `delivery:${delivery.id}:${row.step}`) fail('Intención social de otra entrega.');
      method(data,parsed(revisionFor(delivery)).spec.integrationMethod);
    }
  }
  for (const row of all.social_measurements) {
    const delivery = requireRef('social_deliveries',row.delivery_id,'Entrega medida'), data = parsed(row);
    if (row.payload_hash !== hash(data) || row.query_key !== socialMeasurementQueryKey(data)) fail('Hash o identidad de consulta social incoherente.');
    method(data,parsed(revisionFor(delivery)).spec.integrationMethod);
    if (data.definitionVersion) {
      const normalized = normalizeSocialMeasurement(data, { delivery: { ...parsed(delivery), id: delivery.id, remoteId: delivery.remote_id }, spec: parsed(revisionFor(delivery)).spec, query: data.query });
      if (hash(normalized) !== row.payload_hash) fail('La captura social contiene campos o métricas no canónicos.');
    }
    text(data.adapterVersion,'Versión del adaptador',100,true);
    if (data.integrationMethod === 'browser' && data.apiVersion !== null) fail('Medición de navegador con versión API.');
    if (data.integrationMethod === 'api') text(data.apiVersion,'Versión API',30,true);
    choice(data.scope,['paid','organic','mixed'],'Ámbito de medición');
    const start = instant(data.periodStart,'Inicio de medición'), end = instant(data.periodEnd,'Fin de medición');
    if (end < start) fail('Período de medición invertido.');
    plain(data.query,'Consulta social'); plain(data.values,'Métricas sociales'); plain(data.coverage,'Cobertura social');
    text(data.timeZone,'Zona social',100,true);
    for (const value of Object.values(data.values)) normalizeSocialMetric(value);
    if (data.ratios != null) for (const value of Object.values(plain(data.ratios,'Ratios sociales'))) normalizeSocialMetric(value);
  }
  for (const row of all.social_forecasts) {
    const data = parsed(row);
    if (data.specHash !== row.spec_hash) fail('Hash del pronóstico social incoherente.');
    choice(data.source,['history','manual','insufficient','unavailable'],'Fuente de pronóstico');
    text(data.algorithmVersion,'Algoritmo social',100,true);
    if (instant(data.generatedAt,'Generación del pronóstico') !== row.generated_at) fail('Fecha de pronóstico incoherente.');
    const samples = list(data.sampleIds,'muestras sociales');
    unique(samples.map(id => ({id})),['id'],'Muestras sociales');
    if (integer(data.sampleCount,'Cantidad de muestras sociales',0) !== samples.length) fail('Cantidad de muestras sociales incoherente.');
    plain(data.metricRanges,'Rangos pronosticados');
    list(data.assumptions,'supuestos del pronóstico');
    list(data.unavailableReasons,'ausencias del pronóstico');
    for (const id of data.sampleIds || []) requireRef('social_campaigns',id,'Muestra social');
    for (const range of Object.values(data.metricRanges)) {
      plain(range,'Rango social');
      for (const key of ['lower','upper','median']) if (range[key] != null && (typeof range[key] !== 'number' || !Number.isFinite(range[key]) || range[key] < 0)) fail('Rango social no válido.');
      if (range.lower > range.upper || range.median != null && (range.median < range.lower || range.median > range.upper)) fail('Límites sociales incoherentes.');
    }
    if (data.budgetMinor != null) socialMoney(data.budgetMinor,'Presupuesto pronosticado');
  }
  for (const row of all.social_recommendations) {
    const data = parsed(row);
    if (data.evidenceHash != null && data.evidenceHash !== row.evidence_hash || data.ruleKey != null && data.ruleKey !== row.rule_key) fail('Identidad de recomendación social incoherente.');
    for (const id of list(data.metricIds || [],'evidencia de recomendación')) {
      const measurement = requireRef('social_measurements',id,'Evidencia social');
      if (requireRef('social_deliveries',measurement.delivery_id,'Entrega medida').campaign_id !== row.campaign_id) fail('Evidencia de otra campaña.');
    }
    for (const id of list(data.sampleIds || [],'muestras de recomendación')) requireRef('social_campaigns',id,'Muestra social');
  }
  for (const table of ['social_order_links','social_expense_links']) for (const row of all[table]) {
    text(row.reason,'Motivo del vínculo social',500,true);
    if (table === 'social_expense_links' && requireRef('expenses',row.expense_id,'Gasto vinculado').category !== 'advertising') fail('Un vínculo social exige un gasto de publicidad.');
  }
}

async function validateImports(all, requireRef, parsed, originSheets) {
  const {validateImportConfig} = await import('./business/imports.mjs');
  const config = value => {
    const canonical = validateImportConfig(value,{allowDuplicateDestinations:true});
    for (const sheet of canonical.sheets || [value]) if (sheet.oneOrderPerGuide != null && typeof sheet.oneOrderPerGuide !== 'boolean') fail('Correspondencia de guía y pedido no válida.');
  };
  for (const row of all.import_profiles) config(parsed(row));
  const revisions = new Map();
  const sourceRows = new Set(all.import_rows.map(row => JSON.stringify([row.batch_id,row.sheet,row.row_number])));
  const resolutionTables = {link_product:'products',link_person:'people',link_order:'orders',link_shipment:'shipments',link_expense:'expenses'};
  // Frozen target/version observations and editable resolutions are intent,
  // not live FKs: a deleted/changed target must resume as a conflict, not make
  // the business backup unrestorable. Applied aliases/facts are checked above.
  const intentRef = (table,id,label) => { if (table === 'business_settings') { if (id !== 1) fail('Destino de configuración no válido.'); } else identifier(id,label); };
  const rowRef = (reference,batch) => {
    plain(reference,'Referencia de fila'); text(reference.sheet,'Hoja de origen',100,true); integer(reference.rowNumber,'Fila de origen',1,10001);
    if (batch.state !== 'expired' && !sourceRows.has(JSON.stringify([batch.id,reference.sheet,reference.rowNumber]))) fail('Referencia sin su fila de origen.');
  };
  const resolutions = (values,batch) => {
    for (const resolution of list(values || [],'resoluciones')) {
      plain(resolution,'Resolución');
      choice(resolution.action,['link_product','link_person','link_order','link_shipment','link_expense','duplicate','additional_quantity','status','review_policy','review_authority','accept_formulas','omit_group','omit_settlement_package','commercial_update','cell_value','independent_record','opening_observation','line_costs'],'Resolución');
      if(resolution.action==='omit_settlement_package'){
        if(Object.keys(resolution).some(key=>!['action','externalKey','value'].includes(key)) || resolution.value!==true || typeof resolution.externalKey!=='string' || resolution.externalKey!==resolution.externalKey.trim() || !parsed(batch).shippingOrigin?.packages.some(packet=>packet.id.trim()===resolution.externalKey))fail('Exclusión de paquete Heka no válida.');
      }
      if (['cell_value','opening_observation','link_expense'].includes(resolution.action)) text(resolution.reason,'Motivo de resolución',2000,true);
      if (['cell_value','independent_record','opening_observation','link_expense'].includes(resolution.action) && (resolution.sheet == null || resolution.rowNumber == null)) fail('Resolución sin su fila de origen.');
      if (resolutionTables[resolution.action]) intentRef(resolutionTables[resolution.action],resolution.internalId,'Vínculo revisado');
      if (resolution.action === 'status') choice(resolution.value,BACKUP_ENUMS.shipments.status,'Estado revisado');
      if (resolution.action === 'review_authority' && resolution.value?.correctionOf) intentRef('shipment_events',resolution.value.correctionOf,'Rectificación revisada');
      // A sheet-scoped authorization need not identify a single source row.
      if (resolution.sheet != null) text(resolution.sheet,'Hoja de origen',100,true);
      if (resolution.rowNumber != null) rowRef(resolution,batch);
      if (resolution.action === 'cell_value') {
        integer(resolution.columnIndex,'Columna corregida',0,199);
        if (resolution.value !== null && !['string','number','boolean'].includes(typeof resolution.value) || typeof resolution.value === 'number' && !Number.isFinite(resolution.value)) fail('Valor de celda corregida no válido.');
        if (typeof resolution.value === 'string') text(resolution.value,'Celda corregida',4000);
      }
      if (resolution.action === 'opening_observation') {
        text(resolution.externalKey,'Observación de apertura',500,true);
        if (typeof resolution.value !== 'boolean') fail('Clasificación de apertura no confirmada.');
      }
      if (resolution.action === 'independent_record' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resolution.value || '')) fail('Identidad independiente no válida.');
      if (resolution.action === 'line_costs') {
        text(resolution.externalKey,'Pedido de costos',500,true);
        for (const line of list(resolution.value?.lineCosts,'costos revisados')) {
          identifier(line.lineId,'Línea de costo'); money(line.unitCostMinor,'Costo revisado',{nullable:true});
          for (const component of line.components || []) { identifier(component.productId,'Componente revisado'); money(component.unitCostMinor,'Costo de componente'); }
        }
      }
      if (resolution.action === 'commercial_update') {
        const value = plain(resolution.value,'Corrección comercial');
        if (value.sellerId) intentRef('people',value.sellerId,'Vendedor revisado');
        for (const line of value.items || []) { choice(line.kind,['products','combos'],'Referencia revisada'); intentRef(line.kind,line.itemId,'Producto revisado'); integer(line.quantity,'Cantidad revisada',1,999); }
      }
    }
  };
  const moneyFields = new Set(importFields.filter(field => field.type === 'money').map(field => field.value));
  const normalizedFields = (fields, context, additional = false) => {
    const byScope = new Map();
    for (const field of list(fields,'campos informativos normalizados')) {
      plain(field,'Campo informativo normalizado');
      if (additional && (typeof field.key !== 'string' || !field.key.startsWith('additional:'))) fail('Campo adicional fuera de su espacio de nombres.');
      const definition = importFields.find(value => value.value === field.key);
      const scope = additional ? context.scope || 'shipment' : definition?.effect === 'information' && ['order','expense'].includes(definition.scope) ? definition.scope : 'shipment';
      const observations = byScope.get(scope) || [];
      observations.push({...field,sourceId:context.batch.source_id,batchId:context.batch.id,sourceAsOf:null,sheet:context.sheet,rowNumbers:[context.rowNumber]});
      byScope.set(scope,observations);
    }
    for (const [scope,observations] of byScope) importedFields(observations,requireRef,context.batch,scope,sourceRows,originSheets);
  };
  const normalized = (values, context) => {
    for (const [key,scope] of [['additionalFields','shipment'],['shipmentAdditionalFields','shipment'],['orderAdditionalFields','order'],['expenseAdditionalFields','expense']]) if (values && Object.hasOwn(values,key)) normalizedFields(values[key],{...context,scope},true);
    for (const [key,value] of Object.entries(values || {})) {
      if (value == null) continue;
      if (moneyFields.has(key)) money(value,'Importe normalizado',{signed:key==='settlementNet'});
      if (['quantity','giftQuantity'].includes(key)) integer(value,'Cantidad normalizada',1,999);
      if (key === 'expenseQuantity') integer(value,'Cantidad publicitaria normalizada',0,1000000);
      if (key === 'group') integer(value,'Grupo normalizado',0,49);
      if (key === 'giftOnly' && typeof value !== 'boolean') fail('Tipo de línea de obsequio no válido.');
      if (value && typeof value === 'object') {
        if (value.occurredAt != null) instant(value.occurredAt);
        if (value.occurredOn != null) businessDate(value.occurredOn);
      }
    }
  };
  const preparedFields = (groups, batch) => {
    for (const group of groups || []) {
      if (group.kind != null) choice(group.kind,['commercial','expenses'],'Tipo de operación');
      if (group.kind != null) {
        const references = list(group.rowRefs,'referencias de operación');
        if (!references.length) fail('Operación sin referencia de origen.');
        unique(references,['sheet','rowNumber'],'Referencias de operación');
        const ownRows = new Set((group.rows || []).map(reference => JSON.stringify([reference.sheet,reference.rowNumber])));
        if (Array.isArray(group.rows) && references.some(reference => !ownRows.has(JSON.stringify([reference.sheet,reference.rowNumber])))) fail('Operación con referencias ajenas a sus filas.');
      }
      for (const reference of group.rowRefs || []) rowRef(reference,batch);
      for (const expense of group.expenses || []) {
        for (const reference of expense.rowRefs || []) rowRef(reference,batch);
        if (!Object.hasOwn(expense,'input')) continue;
        const input = plain(expense.input,'Gasto preparado');
        validateExpenseImportMetadata(input);
        if (expense.sourceKey !== `excel-expense:${hash([batch.source_id,expense.externalId])}` || input.importIdentity?.externalId !== expense.externalId || input.sourceId !== batch.source_id || typeof input.importIdentity.generated !== 'boolean') fail('Identidad de gasto preparado incoherente.');
        money(input.amountMinor,'Gasto preparado'); businessDate(input.incurredOn); choice(input.category,['advertising','operating','other'],'Categoría importada'); text(input.concept,'Concepto importado',500,true);
        // Prepared expenses retain earlier observations when a reimport has no newer information.
        if (Object.hasOwn(input,'importedFields')) importedFields(input.importedFields,requireRef,null,'expense',sourceRows,originSheets);
      }
      for (const unit of group.units || []) {
        // This is the merged order history, not only observations from this batch.
        if (Object.hasOwn(unit,'importedFields')) importedFields(unit.importedFields,requireRef,null,'order',sourceRows,originSheets);
        const lines = unit.input?.items || unit.displayItems || [];
        unique(lines.filter(line => line.externalLineId != null),['externalLineId'],'Identidades externas de línea');
        for (const line of unit.lineCosts || []) {
          identifier(line.lineId,'Línea de costo revisado'); money(line.unitCostMinor,'Costo de línea revisado',{nullable:true});
          if (lines.length && !lines.some(item => item.lineId === line.lineId)) fail('Costo dirigido a otra línea de pedido.');
          for (const component of line.components || []) { identifier(component.productId,'Componente de costo'); money(component.unitCostMinor,'Costo de componente revisado'); }
        }
        if (unit.input && Object.hasOwn(unit.input,'importedFields')) importedFields(unit.input.importedFields,requireRef,batch,'order',sourceRows,originSheets);
        for (const shipment of unit.shipments || []) {
          if (Object.hasOwn(shipment,'importedFields')) importedFields(shipment.importedFields,requireRef,batch,'shipment',sourceRows,originSheets);
          if (Object.hasOwn(shipment,'insuranceCostMapped') && typeof shipment.insuranceCostMapped !== 'boolean') fail('La asignación del costo del seguro en la revisión no es válida.');
          for (const event of shipment.events || []) {
            for (const reference of event.rowRefs || []) rowRef(reference,batch);
            if (Object.hasOwn(event,'inventoryOpeningIncluded') && typeof event.inventoryOpeningIncluded !== 'boolean') fail('Clasificación de evento no confirmada.');
            if (Object.hasOwn(event,'explicitExternalKey') && typeof event.explicitExternalKey !== 'boolean') fail('Clasificación de identidad del evento no válida.');
          }
        }
      }
    }
  };
  const openingIntent = value => {
    if (value == null) return;
    plain(value,'Confirmación del conteo'); businessDate(value.on,'Fecha del conteo');
    if (value.confirmed !== true) fail('El conteo de incorporación no está confirmado.');
  };
  for (const row of all.import_batches) {
    if (row.profile_id && requireRef('import_profiles',row.profile_id,'Perfil').source_id !== row.source_id) fail('Perfil de otra fuente.');
    const data = parsed(row); config(data.config);
    if(data.shippingOrigin!=null)validateHekaImportOrigin(data.shippingOrigin,{sourceId:row.source_id,fileHash:row.file_hash});
    for (const [key,table] of Object.entries({orderIds:'orders',shipmentIds:'shipments',expenseIds:'expenses'})) if (data.progress?.[key] != null) {
      const ids = list(data.progress[key],'resultados de importación');
      if (new Set(ids).size !== ids.length) fail('Resultados de importación repetidos.');
      for (const id of ids) requireRef(table,id,'Resultado durable importado');
    }
    openingIntent(data.inventoryOpening);
    preparedFields(data.previewGroups,row);
    preparedFields(data.preview?.groups,row);
    if (data.profileVersion != null) integer(data.profileVersion,'Versión de perfil',1);
    if (row.filename != null && (text(row.filename,'Archivo original',255,true) !== row.filename || !/\.(xlsx|xls|xlsb|xlsm)$/i.test(row.filename) || /[\r\n\0/\\]/.test(row.filename))) fail('Nombre de archivo original no válido.');
    resolutions(data.resolutions,row);
    if (row.file_bytes_base64 != null) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.file_bytes_base64)) fail('Bytes originales no válidos.');
      const bytes = Buffer.from(row.file_bytes_base64,'base64');
      if (!bytes.length || bytes.length > 10*1024*1024 || bytes.toString('base64') !== row.file_bytes_base64 || digest(bytes) !== row.file_hash || !row.filename) fail('El archivo retenido no coincide con su hash o tamaño.');
      const signature = bytes.subarray(0,8).toString('hex');
      if (!(signature.startsWith('504b0304') && !/\.xls$/i.test(row.filename) || signature === 'd0cf11e0a1b11ae1' && /\.xls$/i.test(row.filename))) fail('Firma del archivo retenido no válida.');
    }
    if (!row.file_hash && (row.file_bytes_base64 != null || row.filename != null)) fail('Archivo sin identidad inmutable.');
    if (['queued','applying','previewing'].includes(row.state) && !row.file_bytes_base64) fail('Trabajo pendiente sin archivo original.');
  }
  for (const row of all.import_revisions) {
    const batch = requireRef('import_batches',row.batch_id,'Lote aceptado'), data = parsed(row);
    if (data.fileHash !== batch.file_hash || data.sourceId !== batch.source_id || data.profileId && requireRef('import_profiles',data.profileId,'Perfil aceptado').source_id !== data.sourceId) fail('Revisión aceptada de otro archivo o fuente.');
    if(data.shippingOrigin!=null)validateHekaImportOrigin(data.shippingOrigin,{sourceId:batch.source_id,fileHash:batch.file_hash});
    if(hash(data.shippingOrigin || null)!==hash(parsed(batch).shippingOrigin || null))fail('El origen Heka aceptado no coincide con el lote original.');
    config(data.config); list(data.groups,'grupos aceptados'); list(data.selection,'selección'); list(data.omitted,'omitidos'); unique(data.groups,['key'],'Grupos aceptados');
    if (data.manifest != null) {
      const manifest = list(data.manifest,'manifiesto del libro');
      if (!manifest.length || manifest.length > 50) fail('Manifiesto del libro fuera de límites.');
      unique(manifest,['name'],'Hojas del manifiesto');
      const names = new Set();
      for (const sheet of manifest) {
        text(sheet.name,'Hoja del manifiesto',100,true); names.add(sheet.name);
        integer(sheet.rowCount,'Filas declaradas',0,1048576); integer(sheet.columnCount,'Columnas declaradas',0,16384);
        if (![true,false,null].includes(sheet.empty)) fail('Estado de hoja vacía no válido.');
      }
      for (const group of data.groups) for (const reference of group.rowRefs || []) if (!names.has(reference.sheet)) fail('Referencia fuera del manifiesto aceptado.');
      for (const sheet of data.config.sheets || []) if (sheet.enabled && !names.has(sheet.sheetName)) fail('Configuración fuera del manifiesto aceptado.');
    }
    openingIntent(data.inventoryOpening);
    preparedFields(data.groups,batch);
    resolutions(data.resolutions,batch);
    if (new Set(data.selection).size !== data.selection.length || data.selection.length !== data.groups.length || data.groups.some(group => !data.selection.includes(group.key))) fail('Selección de revisión incoherente.');
    const previous = revisions.get(row.batch_id) || []; previous.push(row); revisions.set(row.batch_id,previous);
    for (const group of data.groups) {
      resolutions(group.resolutions,batch);
      for (const resolution of group.resolutions || []) {
        if (resolution.action === 'opening_observation') {
          const events = (group.units || []).flatMap(unit => (unit.shipments || []).flatMap(shipment => shipment.events || []));
          if (!events.some(event => event.observationKey === resolution.externalKey && event.rowRefs?.some(reference => reference.sheet === resolution.sheet && reference.rowNumber === resolution.rowNumber))) fail('Clasificación dirigida a otra observación de apertura.');
        }
        if (resolution.action === 'line_costs') {
          const unit = (group.units || []).find(value => (value.values?.externalOrderId || value.key) === resolution.externalKey);
          const lines = unit?.input?.items || unit?.displayItems || [];
          if (!unit || resolution.value.lineCosts.some(cost => !lines.some(line => line.lineId === cost.lineId))) fail('Corrección de costos dirigida a otro pedido o línea.');
        }
      }
      for (const identity of group.identities || []) {
        if (identity.type === 'cost') { intentRef('products',identity.productId,'Costo histórico revisado'); businessDate(identity.on); if (identity.id) intentRef('product_costs',identity.id,'Costo revisado'); }
        else if (identity.type === 'guide') for (const match of identity.matches || []) intentRef('shipments',match.id,'Guía revisada');
        else if (identity.type === 'expense_source') {
          text(identity.key,'Identidad de gasto',200,true);
          if (identity.internalId) intentRef('expenses',identity.internalId,'Gasto revisado');
          if (identity.version != null) integer(identity.version,'Versión del gasto',1);
          const expense = (group.expenses || []).find(value => value.sourceKey === identity.key);
          if (!expense || (expense.existingId || null) !== (identity.internalId || null) || (expense.version || null) !== (identity.version || null)) fail('Identidad de gasto ajena a su operación aceptada.');
        }
        else if (identity.internalId) {
          const table = {order:'orders',shipment:'shipments',product:'products',person:'people',settlement_document:'settlements'}[identity.type];
          if (!table) fail('Identidad externa de revisión no válida.');
          intentRef(table,identity.internalId,'Identidad externa revisada');
        }
      }
      for (const unit of group.units || []) {
        if (unit.orderId) intentRef('orders',unit.orderId,'Pedido revisado');
        if (unit.input?.sellerId) intentRef('people',unit.input.sellerId,'Vendedor revisado');
        for (const line of unit.input?.items || []) { choice(line.kind,['products','combos'],'Línea revisada'); intentRef(line.kind,line.itemId,'Referencia revisada'); integer(line.quantity,'Cantidad revisada',1,999); }
        for (const shipment of unit.shipments || []) if (shipment.existingId) intentRef('shipments',shipment.existingId,'Envío revisado');
      }
      for (const target of group.targets || []) {
        if (!['business_settings','platform_sources','platforms','import_profiles','orders','people','records','product_costs','shipments','expenses','settlements'].includes(target.table)) fail('Tabla destino de revisión no válida.');
        intentRef(target.table,target.id,'Destino aceptado');
        if (target.version != null) {
          if (target.table === 'records' && typeof target.version === 'string') {
            if (!CATALOG_REVISION.test(target.version)) fail('Huella comercial de catálogo no válida.');
          } else integer(target.version,'Versión destino',1);
        }
      }
      for (const source of list(group.rows || [],'filas aceptadas')) {
        rowRef(source,batch);
        const context = {batch,sheet:source.sheet,rowNumber:source.rowNumber,scope:source.config?.purpose === 'expenses' ? 'expense' : source.config?.purpose === 'orders' ? 'order' : 'shipment'};
        if (Object.hasOwn(source,'information')) normalizedFields(source.information,context);
        normalized(source.values,context); for (const line of source.lines || []) normalized(line,context);
        for (const line of source.expenseLines || []) normalized(line,context);
      }
    }
  }
  for (const batch of all.import_batches) {
    const data = parsed(batch), accepted = revisions.get(batch.id) || [];
    accepted.sort((a,b) => a.revision-b.revision);
    if (accepted.some((row,index) => row.revision !== index+1)) fail('Secuencia de revisiones incompleta.');
    if (data.acceptedRevision != null && !accepted.some(row => row.revision === data.acceptedRevision) || ['queued','applying'].includes(batch.state) && !data.acceptedRevision) fail('Lote sin revisión aceptada.');
  }
  for (const row of all.import_rows) {
    const data = parsed(row);
    const batch = requireRef('import_batches',row.batch_id,'Lote de fila'), context = {batch,sheet:row.sheet,rowNumber:row.row_number};
    text(row.sheet,'Hoja de fila importada',100,true); integer(row.row_number,'Fila importada',1,10001);
    const sheets = importedSheetNames(batch,originSheets);
    if (sheets && !sheets.has(row.sheet)) fail('Fila importada de una hoja inexistente.');
    normalized(data.normalized?.values,context); for (const line of data.normalized?.lines || []) normalized(line,context);
    for (const line of data.normalized?.expenseLines || []) normalized(line,context);
    if (data.acceptedRevision != null && !(revisions.get(row.batch_id) || []).some(revision => revision.revision === data.acceptedRevision)) fail('Fila con revisión inexistente.');
    if (data.applied) {
      for (const id of data.applied.expenseIds || []) requireRef('expenses',id,'Gasto importado');
      for (const [key,table] of Object.entries({orderId:'orders',shipmentId:'shipments',collectionId:'order_collections',settlementId:'settlements'})) if (data.applied[key]) requireRef(table,data.applied[key],'Resultado importado');
      for (const unit of data.applied.units || []) {
        if (unit.orderId) requireRef('orders',unit.orderId,'Pedido importado');
        for (const [key,table] of Object.entries({shipmentIds:'shipments',collectionIds:'order_collections',expenseIds:'expenses'})) for (const id of unit[key] || []) requireRef(table,id,'Hecho importado');
      }
    }
  }
}

function restoreIntents(bundle) {
  const intents = [], keys = new Set();
  for (const input of bundle.pendingJobs) {
    plain(input,'Trabajo pendiente');
    const intent = input.kind === 'import' ? importIntent(input.key,input) : input.kind === 'report' ? reportIntent(input.key,input) : fail('Tipo de trabajo no comercial.');
    if (keys.has(intent.key)) fail('Trabajo pendiente repetido.'); keys.add(intent.key);
    if (intent.kind === 'import') {
      const batch = bundle.business.import_batches.find(row => row.id === intent.batchId);
      if (!batch || !batch.file_bytes_base64 || !phaseStates[intent.phase].includes(batch.state)) fail('Trabajo de importación sin lote pendiente.');
      if (intent.phase === 'apply') { const accepted = bundle.business.import_revisions.find(row => row.batch_id === batch.id && row.revision === intent.revision); if (!accepted || accepted.actor_id !== intent.actorId || JSON.parse(batch.data).acceptedRevision !== intent.revision) fail('Trabajo distinto de la revisión aceptada.'); }
    }
    intents.push(intent);
  }
  for (const batch of bundle.business.import_batches) {
    const data = JSON.parse(batch.data);
    if (keys.has(`import:${batch.id}`)) continue;
    const phase = ['queued','applying'].includes(batch.state) ? 'apply' : batch.state === 'previewing' ? 'preview' : batch.state === 'uploaded' && batch.file_bytes_base64 ? 'inspect' : null;
    if (!phase) continue;
    const revision = phase === 'apply' ? bundle.business.import_revisions.find(row => row.batch_id === batch.id && row.revision === data.acceptedRevision) : null;
    const scopes = phase === 'preview' ? [`import:preview:${batch.id}`] : [`import:upload:${batch.id}`,`import:update:${batch.id}`];
    const request = bundle.business.business_requests.filter(row => scopes.includes(row.scope)).sort((a,b) => b.created_at.localeCompare(a.created_at))[0];
    const actorId = revision?.actor_id || request?.actor_id || data.createdBy;
    intents.push(importIntent(`import:${batch.id}`,{batchId:batch.id,phase,actorId,requestedBy:actorId,revision:revision?.revision}));
  }
  return intents;
}

// Reversal rows may appear in any export order. Preserve FKs without disabling them.
export function dependencyOrderedRows(table, items, definition) {
  const selfFields = Object.entries(definition.references).filter(([,target]) => target === table).map(([field]) => field);
  if (!selfFields.length) return items;
  const remaining = new Map(items.map(row => [row.id,row])), complete = new Set(), ordered = [];
  while (remaining.size) {
    let advanced = false;
    for (const [id,row] of remaining) if (selfFields.every(field => row[field] == null || complete.has(row[field]))) { ordered.push(row); complete.add(id); remaining.delete(id); advanced = true; }
    if (!advanced) fail(`${table}: ciclo de referencias.`);
  }
  return ordered;
}
