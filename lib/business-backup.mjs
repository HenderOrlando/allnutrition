import { createHash } from 'node:crypto';
import { schemas } from './schema.mjs';
import { validateRecord, validateSettings, validateOrder, fail, integer, text } from './validation.mjs';
import { convertV2Bundle, normalizeInventoryBundle } from './db/migrations.mjs';
import { businessDate, instant, periodBounds, BUSINESS_PERIODS } from './business/dates.mjs';
import { ALERT_TYPES } from './business/settings.mjs';
import { hash } from './business/commands.mjs';
import { COMMERCIAL_TABLES, CORE_BACKUP_TABLES, COMMERCIAL_COUNTERS, BACKUP_ENUMS } from './backup-schema.mjs';

const MAX_MINOR = 10000000000000;
const ORDER_STATES = ['new','preparing','sent','delivered','returned','cancelled'];
const ORDER_FIELDS = new Set('customerName phone city department address addressNotes email documentType documentNumber notes statusReason status placedOn dateSource sellerId sellerSnapshot deliveryMethod shippingChargeMinor items subtotalMinor totalMinor cancellationOn ruleSnapshot policyReviewRequired legacyPolicyReview legacyFinancialReview recognition dispatchedOn giftCostOn giftDispatches deliverySummary economicLocked inventory'.split(' '));
const nullableColumns = new Set('order_id platform_id source_id external_id identity_key source_as_of external_key occurred_at occurred_on profile_id file_hash filename file_bytes_base64 expires_at entity_key unit_cost_minor transfer_id reversal_of cash_entry_id reported_on account_id settlement_receipt_id incurred_on person_id shipment_id source_key stale_since responsible_id previous_status'.split(' '));
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: objeto no válido.`); return value; };
const list = (value, label) => { if (!Array.isArray(value)) fail(`Falta la colección ${label}.`); return value; };
const identifier = (value, label = 'ID') => { if (typeof value !== 'string' || !value.length || value.length > 100 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) fail(`${label}: identificador no válido.`); return value; };
const choice = (value, allowed, label) => { if (!allowed.includes(value)) fail(`${label}: opción no válida.`); return value; };
const exact = (value, label, limit = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || Math.abs(value) > limit) fail(`${label}: entero fuera de rango.`); return value; };
const money = (value, label, {signed = false, nullable = false} = {}) => { if (value === null && nullable) return value; exact(value,label,MAX_MINOR); if (!signed && value < 0) fail(`${label}: importe negativo.`); return value; };
const unique = (rows, fields, label, nullable = false) => {
  const keys = new Set();
  for (const row of rows) {
    if (nullable && fields.some(field => row[field] == null)) continue;
    const key = JSON.stringify(fields.map(field => row[field]));
    if (keys.has(key)) fail(`${label}: clave repetida.`);
    keys.add(key);
  }
};
function json(value, label) {
  if (typeof value !== 'string') fail(`${label}: JSON no válido.`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(`${label}: JSON no válido.`); }
  return parsed;
}
function moneyTree(value, label, aggregate = false) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && /(?:Minor|_minor)$/.test(key)) exact(child,`${label}.${key}`,aggregate ? Number.MAX_SAFE_INTEGER : MAX_MINOR);
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
  const bundle = {format:'allnutrition-export-v3',inventoryVersion:1,exportedAt:new Date().toISOString(),settings:await tx.settings(),orders:await tx.orders(),business:{},pendingJobs:[]};
  for (const kind of Object.keys(schemas)) bundle[kind] = await tx.list(kind);
  for (const [table, definition] of Object.entries(CORE_BACKUP_TABLES)) bundle[table] = await rows(tx,table,definition);
  bundle.counters = (await tx.db.all(`SELECT id,value FROM ${tx.t('counters')} WHERE id IN ('orders','business_revision') ORDER BY id`)).map(row => ({...row}));
  for (const [table, definition] of Object.entries(COMMERCIAL_TABLES)) bundle.business[table] = await rows(tx,table,definition);
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
    if (Object.keys(source).some(key => !definition.columns.includes(key))) fail(`${table}: columna no admitida.`);
    const row = {...source};
    if (legacy) {
      for (const field of ['created_at','updated_at','recorded_at']) if (definition.columns.includes(field) && row[field] == null) row[field] = row.recorded_at || row.updated_at || row.created_at || migrationAt;
      if (definition.columns.includes('version')) row.version ??= 1;
    }
    for (const field of definition.columns) {
      const value = row[field];
      if (value === undefined || value === null && !nullableColumns.has(field)) fail(`${table}.${field}: valor ausente.`);
      if (value === null) continue;
      if (field === 'id' && table === 'business_settings') { if (value !== 1) fail('Configuración de negocio no válida.'); }
      else if (field === 'version' || field === 'revision' || field === 'episode' || field === 'row_number') integer(value,`${table}.${field}`,1);
      else if (field === 'data_revision') integer(value,'Revisión de datos',0);
      else if (field === 'active' || field === 'enabled') choice(value,[0,1],field);
      else if (field.endsWith('_minor')) money(value,`${table}.${field}`,{signed:true});
      else if (field === 'data' || field === 'rule_snapshot' || field === 'result_json') {
        const parsed = json(value,`${table}.${field}`);
        if (field !== 'result_json') plain(parsed,`${table}.${field}`);
        moneyTree(parsed,table,['report_snapshots','business_audit','business_requests','alerts'].includes(table));
      }
      else if (field.endsWith('_on') || field === 'end_on_exclusive') businessDate(value,`${table}.${field}`);
      else if (field.endsWith('_at') || field === 'source_as_of' || field === 'stale_since') row[field] = instant(value,`${table}.${field}`);
      else if (field === 'payload_hash' || field === 'preview_hash' || field === 'fact_hash' || field === 'query_key' || field === 'file_hash') { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${table}.${field}: hash no válido.`); }
      else if (field === 'id' || definition.references[field] || ['actor_id','internal_id','entity_id','request_id'].includes(field)) identifier(value,`${table}.${field}`);
      else if (typeof value !== 'string') fail(`${table}.${field}: texto no válido.`);
    }
    const enums = table === 'shipment_events' ? BACKUP_ENUMS.shipments : BACKUP_ENUMS[table] || {};
    for (const [field,values] of Object.entries(enums)) choice(row[field],values,`${table}.${field}`);
    if (table === 'alert_rules') choice(row.type,ALERT_TYPES,'Tipo de alerta');
    if (table === 'business_requests') { text(row.scope,'Operación',200,true); if (!/^[\w:-]{8,100}$/.test(row.request_id)) fail('ID de operación no válido.'); }
    result.push(row);
  }
  unique(result,definition.key,table);
  for (const fields of definition.unique) unique(result,fields,table,true);
  return result;
}

/** Validates and prepares without touching the destination. SQL also checks its own constraints. */
export async function prepareCommercialBundle(input, {migrationAt = new Date().toISOString()} = {}) {
  plain(input,'Respaldo');
  const legacy = input.format === 'allnutrition-export-v2';
  if (!legacy && input.format !== 'allnutrition-export-v3') fail('Formato de respaldo no reconocido.');
  const bundle = legacy ? convertV2Bundle(input,{migrationAt}) : structuredClone(input);
  const hasInventory = Object.hasOwn(bundle,'inventoryVersion') || list(bundle.products,'productos').some(product => Object.hasOwn(product,'stockReserved')) || list(bundle.orders,'pedidos').some(order => Object.hasOwn(order,'inventory'));
  if (Object.hasOwn(bundle,'inventoryVersion') && bundle.inventoryVersion !== 1) fail('Versión de inventario del respaldo no admitida.');
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
    await validateOrder(data,async (kind,id) => requireRef(kind,id,'Referencia'),data);
    choice(data.status,ORDER_STATES,'Estado del pedido'); choice(data.deliveryMethod,['carrier','local','pickup'],'Modalidad');
    businessDate(data.placedOn,'Fecha del pedido',{nullable:true}); dataRef(data,'sellerId','people');
    if (data.sellerSnapshot && data.sellerSnapshot.id !== data.sellerId) fail('Vendedor histórico incoherente.');
    list(data.items,'líneas de pedido'); if (!data.items.length || data.items.length > 50) fail('Cantidad de líneas no válida.'); unique(data.items,['lineId'],'Líneas');
    let subtotal = 0n;
    for (const line of data.items) {
      identifier(line.lineId); choice(line.kind,['products','combos'],'Referencia'); requireRef(line.kind,line.itemId,'Referencia del pedido');
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
    for (const threshold of Object.values(data.thresholds || {})) if (threshold != null) integer(threshold,'Umbral',0);
    for (const status of data.selectedStatuses || []) choice(status,BACKUP_ENUMS.shipments.status,'Estado de regla');
  }
  const alertEntities = {shipment:'shipments',source:'platform_sources',collection:'order_collections',cash_account:'cash_accounts',cash_closing:'cash_closings',order:'orders',expense:'expenses'};
  for (const row of all.alerts) {
    const data = parsed(row); dataRef(data,'responsibleOverrideId','people');
    const table = alertEntities[row.entity_type]; if (!table) fail('Entidad de alerta no válida.');
    requireRef(table,row.entity_id,'Entidad de alerta');
    for (const key of ['startEventId','lastEventId','endEventId']) if (data[key] != null) requireRef('shipment_events',data[key],'Evento de alerta');
  }
  const entityTables = {order:'orders',product:'products',person:'people',shipment:'shipments',collection:'order_collections',settlement:'settlements'};
  for (const row of all.external_links) requireRef(entityTables[row.entity_type],row.internal_id,'Alias externo');
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
  await validateImports(all,requireRef,parsed);
}

async function validateImports(all, requireRef, parsed) {
  const {validateImportConfig} = await import('./business/imports.mjs');
  const config = value => {
    validateImportConfig(value);
    if (value.oneOrderPerGuide != null && typeof value.oneOrderPerGuide !== 'boolean') fail('Correspondencia de guía y pedido no válida.');
  };
  for (const row of all.import_profiles) config(parsed(row));
  const revisions = new Map();
  const sourceRows = new Set(all.import_rows.map(row => JSON.stringify([row.batch_id,row.sheet,row.row_number])));
  const resolutionTables = {link_product:'products',link_person:'people',link_order:'orders',link_shipment:'shipments'};
  // Frozen target/version observations and editable resolutions are intent,
  // not live FKs: a deleted/changed target must resume as a conflict, not make
  // the business backup unrestorable. Applied aliases/facts are checked above.
  const intentRef = (table,id,label) => { if (table === 'business_settings') { if (id !== 1) fail('Destino de configuración no válido.'); } else identifier(id,label); };
  const resolutions = values => {
    for (const resolution of list(values || [],'resoluciones')) {
      plain(resolution,'Resolución');
      choice(resolution.action,['link_product','link_person','link_order','link_shipment','duplicate','additional_quantity','status','review_policy','review_authority','accept_formulas','omit_group','commercial_update'],'Resolución');
      if (resolutionTables[resolution.action]) intentRef(resolutionTables[resolution.action],resolution.internalId,'Vínculo revisado');
      if (resolution.action === 'status') choice(resolution.value,BACKUP_ENUMS.shipments.status,'Estado revisado');
      if (resolution.action === 'review_authority' && resolution.value?.correctionOf) intentRef('shipment_events',resolution.value.correctionOf,'Rectificación revisada');
      if (resolution.action === 'commercial_update') {
        const value = plain(resolution.value,'Corrección comercial');
        if (value.sellerId) intentRef('people',value.sellerId,'Vendedor revisado');
        for (const line of value.items || []) { choice(line.kind,['products','combos'],'Referencia revisada'); intentRef(line.kind,line.itemId,'Producto revisado'); integer(line.quantity,'Cantidad revisada',1,999); }
      }
    }
  };
  const normalized = values => {
    for (const [key,value] of Object.entries(values || {})) {
      if (value == null) continue;
      if (['shippingCharge','shippingOutCost','shippingReturnCost','platformFee','collectedAmount','settlementGross','settlementNet','unitPrice','lineDiscount'].includes(key)) money(value,'Importe normalizado',{signed:key==='settlementNet'});
      if (key === 'quantity') integer(value,'Cantidad normalizada',1,999);
      if (value && typeof value === 'object') {
        if (value.occurredAt != null) instant(value.occurredAt);
        if (value.occurredOn != null) businessDate(value.occurredOn);
      }
    }
  };
  for (const row of all.import_batches) {
    if (row.profile_id && requireRef('import_profiles',row.profile_id,'Perfil').source_id !== row.source_id) fail('Perfil de otra fuente.');
    const data = parsed(row); config(data.config);
    if (data.profileVersion != null) integer(data.profileVersion,'Versión de perfil',1);
    if (row.filename != null && (text(row.filename,'Archivo original',255,true) !== row.filename || !/\.(xlsx|xls|xlsb|xlsm)$/i.test(row.filename) || /[\r\n\0/\\]/.test(row.filename))) fail('Nombre de archivo original no válido.');
    resolutions(data.resolutions);
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
    config(data.config); list(data.groups,'grupos aceptados'); list(data.selection,'selección'); list(data.omitted,'omitidos'); unique(data.groups,['key'],'Grupos aceptados');
    resolutions(data.resolutions);
    if (new Set(data.selection).size !== data.selection.length || data.selection.length !== data.groups.length || data.groups.some(group => !data.selection.includes(group.key))) fail('Selección de revisión incoherente.');
    const previous = revisions.get(row.batch_id) || []; previous.push(row); revisions.set(row.batch_id,previous);
    for (const group of data.groups) {
      resolutions(group.resolutions);
      for (const identity of group.identities || []) {
        if (identity.type === 'cost') { intentRef('products',identity.productId,'Costo histórico revisado'); businessDate(identity.on); if (identity.id) intentRef('product_costs',identity.id,'Costo revisado'); }
        else if (identity.type === 'guide') for (const match of identity.matches || []) intentRef('shipments',match.id,'Guía revisada');
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
        if (target.version != null) integer(target.version,'Versión destino',1);
      }
      for (const source of list(group.rows,'filas aceptadas')) {
        if (batch.state !== 'expired' && !sourceRows.has(JSON.stringify([row.batch_id,source.sheet,source.rowNumber]))) fail('Revisión aceptada sin su fila de origen.');
        normalized(source.values); for (const line of source.lines || []) normalized(line);
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
    normalized(data.normalized?.values); for (const line of data.normalized?.lines || []) normalized(line);
    if (data.acceptedRevision != null && !(revisions.get(row.batch_id) || []).some(revision => revision.revision === data.acceptedRevision)) fail('Fila con revisión inexistente.');
    if (data.applied) {
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
