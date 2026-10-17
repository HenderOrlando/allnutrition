import { fail, integer, text } from '../validation-core.mjs';
import { bogotaDate, businessDate, instant } from './dates.mjs';
import { audit, bumpRevision, entity, hash, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { loadOrderData, resolveOrderRecognition } from './orders.mjs';

export const SHIPMENT_STATUSES = Object.freeze(['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown']);
const DISPATCHED = new Set(['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned']);
const TERMINAL = new Set(['delivered','returned','cancelled']);
const nullableText = (value, label, max = 100) => text(value, label, max) || null;
const carrierKey = value => value.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ').trim();
const decodeEvent = event => Object.hasOwn(event,'data') ? entity(event) : event;
const UNKNOWN_TIME=Number.MIN_SAFE_INTEGER;
const time=value=>value?Date.parse(value):UNKNOWN_TIME;
const eventTime = event => time(event.occurredAt || (event.occurredOn ? `${event.occurredOn}T05:00:00.000Z` : event.sourceAsOf));
function statusValue(value) {
  if (!SHIPMENT_STATUSES.includes(value)) fail('Estado del envío no válido.');
  return value;
}
function inputObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Datos del envío no válidos.');
}

// Never use ingestion/DB timestamps as evidence of when a shipment occurred.
export function effectiveShipmentEvents(events, { asOf = null } = {}) {
  const cutoff = asOf ? Date.parse(instant(asOf,'Fecha de corte')) : null;
  const observed = events.map(decodeEvent);
  // A historical correction replaces the fact even when its corrected date moved
  // outside the requested period; it is not a later commercial return.
  const superseded = new Set(observed.map(event => event.correctionOf).filter(Boolean));
  return observed.filter(event => !superseded.has(event.id) && (cutoff===null || eventTime(event)!==UNKNOWN_TIME && eventTime(event)<=cutoff)).sort((a,b) => eventTime(a)-eventTime(b) || time(a.sourceAsOf)-time(b.sourceAsOf) || time(a.recordedAt)-time(b.recordedAt) || a.id.localeCompare(b.id));
}
function terminalAllows(previous, next) {
  return previous === next || !TERMINAL.has(previous) || previous === 'delivered' && ['return_in_transit','returned'].includes(next);
}
export function effectiveShipmentState(events, options = {}) {
  let status = 'unknown';
  for (const event of effectiveShipmentEvents(events,options)) {
    if (event.status === 'unknown') {
      if (!TERMINAL.has(status)) status = 'unknown';
    } else if (terminalAllows(status,event.status)) status = event.status;
  }
  return status;
}
async function shipmentRow(tx,id) {
  const row = await tx.db.get(`SELECT * FROM ${tx.t('shipments')} WHERE id=?`,[text(id,'Envío',100,true)]);
  if (!row) fail('Envío no encontrado.',404);
  return entity(row);
}
async function shipmentEvents(tx,id) {
  return (await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=? ORDER BY recorded_at,id`,[id])).map(entity);
}
async function detail(tx,id) {
  const shipment = await shipmentRow(tx,id);
  return {...shipment,events:await shipmentEvents(tx,id)};
}
export function getShipment(store,id) {
  return store.readSnapshot(async tx => {
    const shipment = await detail(tx,id);
    const order=shipment.orderId ? await loadOrderData(tx,shipment.orderId) : null;
    const platform=shipment.platformId ? await tx.db.get(`SELECT name FROM ${tx.t('platforms')} WHERE id=?`,[shipment.platformId]) : null;
    const source=shipment.sourceId ? await tx.db.get(`SELECT name FROM ${tx.t('platform_sources')} WHERE id=?`,[shipment.sourceId]) : null;
    const relatedShipments=shipment.orderId ? await tx.db.all(`SELECT id,tracking,status,data FROM ${tx.t('shipments')} WHERE order_id=? ORDER BY created_at,id`,[shipment.orderId]) : [];
    return {...shipment,orderNumber:order?.number ?? null,platformName:platform?.name ?? null,sourceName:source?.name ?? null,orderLines:(order?.items || []).map(({lineId,title,presentation,quantity})=>({lineId,title,presentation,quantity})),relatedShipments:relatedShipments.map(row=>({id:row.id,tracking:row.tracking,status:row.status,assignments:JSON.parse(row.data).assignments||[]}))};
  });
}

export function validateShipmentMetadata(input, old = {}) {
  const read = key => Object.hasOwn(input,key) ? input[key] : old[key];
  const carrier = text(read('carrier'),'Transportadora',200);
  const tracking = text(read('tracking'),'Guía',200);
  if (tracking && !carrier) fail('Indica la transportadora de la guía.');
  return {
    orderId:nullableText(read('orderId'),'Pedido'),
    platformId:nullableText(read('platformId'),'Plataforma'),
    sourceId:nullableText(read('sourceId'),'Cuenta de plataforma'),
    externalId:nullableText(read('externalId'),'Identificador externo',200),
    carrier,tracking,
    estimatedDeliveryOn:businessDate(read('estimatedDeliveryOn') || null,'Entrega estimada',{nullable:true}),
    replacesShipmentId:nullableText(read('replacesShipmentId'),'Envío sustituido'),
    notes:text(read('notes'),'Notas',4000),
  };
}
async function validateSource(tx,data) {
  if (data.platformId && !await tx.db.get(`SELECT id FROM ${tx.t('platforms')} WHERE id=?`,[data.platformId])) fail('Plataforma no encontrada.',404);
  if (data.sourceId) {
    const source = await tx.db.get(`SELECT * FROM ${tx.t('platform_sources')} WHERE id=?`,[data.sourceId]);
    if (!source) fail('Cuenta de plataforma no encontrada.',404);
    if (data.platformId && source.platform_id !== data.platformId) fail('La cuenta no pertenece a esa plataforma.');
    data.platformId = source.platform_id;
  }
  if (data.externalId && !data.sourceId) fail('Un identificador externo requiere cuenta de plataforma.');
}
function identity(data) {
  if (data.sourceId && data.externalId) return `external:${hash([data.sourceId,data.externalId])}`;
  if (data.tracking) return `guide:${hash([data.sourceId,carrierKey(data.carrier),data.tracking])}`;
  return null;
}
async function validateIdentity(tx,data,id = null,old = null) {
  // Legacy duplicate guides deliberately have no claimed identity until reconciled.
  if (old && old.identityKey == null && ['sourceId','externalId','carrier','tracking'].every(key => (data[key] || null) === (old[key] || null))) {
    data.identityKey = null;
    return;
  }
  data.identityKey = identity(data);
  if (data.identityKey) {
    const duplicate = await tx.db.get(`SELECT id FROM ${tx.t('shipments')} WHERE identity_key=?`,[data.identityKey]);
    if (duplicate && duplicate.id !== id) fail('La identidad externa ya corresponde a otro envío. Vincúlalo explícitamente.',409);
  }
  if (!data.tracking) return;
  const guides = await tx.db.all(`SELECT id,carrier FROM ${tx.t('shipments')} WHERE tracking=?`,[data.tracking]);
  if (guides.some(guide => guide.id !== id && carrierKey(guide.carrier) === carrierKey(data.carrier))) fail('Esta guía ya está registrada. Revisa su origen y vincúlala explícitamente.',409);
}
function assignmentList(value,order) {
  if (!Array.isArray(value) || !value.length) fail('Asigna al menos una línea al envío.');
  const seen = new Set();
  return value.map(item => {
    const lineId = text(item?.lineId,'Línea',100,true);
    if (seen.has(lineId)) fail('La línea está repetida en el envío.');
    seen.add(lineId);
    const line = order.items.find(line => line.lineId === lineId);
    if (!line) fail('La línea no pertenece al pedido.');
    return {lineId,quantity:integer(item.quantity,'Cantidad asignada',1,line.quantity)};
  });
}
function sameAssignments(a,b) {
  return a.length === b.length && a.every(line => b.some(other => other.lineId === line.lineId && other.quantity === line.quantity));
}
async function validateAssignments(tx,data,input,id = null,{linking = false} = {}) {
  if (!data.orderId) {
    if (input.assignments?.length || data.replacesShipmentId) fail('Vincula un pedido antes de asignar líneas.');
    data.assignments = [];
    return null;
  }
  const order = await loadOrderData(tx,data.orderId);
  if (!order) fail('Pedido no encontrado.',404);
  if (order.status === 'cancelled') fail('No se puede crear ni vincular un envío a un pedido cancelado.',409);
  const shipments = (await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[order.id])).map(entity);
  const old = shipments.find(shipment => shipment.id === id);
  let defaultAssignments = old?.assignments;
  if (data.replacesShipmentId) {
    const original = shipments.find(shipment => shipment.id === data.replacesShipmentId);
    if (!original || original.id === id) fail('El envío sustituido debe ser otro envío del mismo pedido.');
    if (shipments.some(shipment => shipment.id !== id && shipment.replacesShipmentId === original.id)) fail('El envío ya tiene un sustituto.',409);
    let ancestor = original;
    const visited = new Set([id]);
    while (ancestor) {
      if (visited.has(ancestor.id)) fail('La sustitución no puede formar un ciclo.');
      visited.add(ancestor.id);
      ancestor = shipments.find(shipment => shipment.id === ancestor.replacesShipmentId);
    }
    defaultAssignments = original.assignments || [];
  } else if ((!shipments.length || linking && shipments.every(shipment => shipment.id === id)) && !defaultAssignments) {
    defaultAssignments = order.items.map(line => ({lineId:line.lineId,quantity:line.quantity}));
  }
  data.assignments = assignmentList(input.assignments === undefined ? defaultAssignments : input.assignments,order);
  if (data.replacesShipmentId && !sameAssignments(data.assignments,defaultAssignments)) fail('El reenvío debe conservar las cantidades del envío sustituido.');
  const candidate = {...data,id:id || '__new__',status:old?.status || 'unknown'};
  const all = [...shipments.filter(shipment => shipment.id !== id),candidate];
  validateActiveQuantities(order,all);
  return order;
}
function validateActiveQuantities(order,shipments) {
  const replaced = new Set(shipments.map(shipment => shipment.replacesShipmentId).filter(Boolean));
  const quantities = new Map();
  for (const shipment of shipments) {
    if (shipment.status === 'cancelled' || replaced.has(shipment.id)) continue;
    for (const line of shipment.assignments || []) quantities.set(line.lineId,(quantities.get(line.lineId) || 0)+line.quantity);
  }
  for (const line of order.items) if ((quantities.get(line.lineId) || 0) > line.quantity) fail('Las cantidades de envíos activos superan las compradas. Divide las cantidades del envío anterior primero.',409);
}
function shipmentData(data,old = {}) {
  return { ...Object.fromEntries(Object.entries(old).filter(([key]) => !['id','orderId','platformId','sourceId','externalId','identityKey','status','carrier','tracking','sourceAsOf','version','createdAt','updatedAt','events'].includes(key))), assignments:data.assignments,replacesShipmentId:data.replacesShipmentId,estimatedDeliveryOn:data.estimatedDeliveryOn,notes:data.notes,costStatus:old.costStatus || 'unknown' };
}
function rowFields(data,old = {}) {
  return {order_id:data.orderId,platform_id:data.platformId,source_id:data.sourceId,external_id:data.externalId,identity_key:data.identityKey,carrier:data.carrier,tracking:data.tracking,data:JSON.stringify(shipmentData(data,old))};
}

export function createShipment(store,input,actorId) { return saveShipment(store,input,actorId); }
export function saveShipment(store,input,actorId,id = null) {
  inputObject(input);
  return runCommand(store,{scope:id ? `shipment:save:${id}` : 'shipment:create',requestId:input.requestId,payload:input,actorId},tx => saveShipmentTx(tx,input,actorId,id));
}
export async function saveShipmentTx(tx,input,actorId,id = null) {
  inputObject(input);
  const old = id ? await detail(tx,id) : null;
  if (old) {
    integer(input.version,'Versión',1);
    if (old.version !== input.version) fail('El envío cambió. Recarga antes de guardar.',409);
  }
  const data = validateShipmentMetadata(input,old || {});
  if (old?.orderId && data.orderId !== old.orderId) fail('Una guía no se puede cambiar a otro pedido.',409);
  const reason = text(input.reason,'Motivo',2000);
  const dispatched = old && effectiveShipmentEvents(old.events).some(event => DISPATCHED.has(event.status));
  if (dispatched) {
    const keys = ['orderId','platformId','sourceId','externalId','carrier','tracking','estimatedDeliveryOn','replacesShipmentId'];
    if (keys.some(key => data[key] !== old[key] && !(data[key] == null && old[key] == null)) || input.assignments !== undefined && !sameAssignments(assignmentList(input.assignments,{items:old.assignments}),old.assignments)) fail('Los metadatos y cantidades quedan congelados después del despacho.',409);
    if (!reason) fail('Indica el motivo de la corrección de notas.');
    data.assignments = old.assignments;
  } else {
    await validateAssignments(tx,data,input,id);
  }
  await validateSource(tx,data);
  await validateIdentity(tx,data,id,old);
  const at = stamp();
  if (old) {
    if (input.status !== undefined && input.status !== old.status) fail('Registra un evento para cambiar el estado del envío.');
    await updateVersioned(tx,'shipments',id,input.version,rowFields(data,old));
  } else {
    id = newId();
    if (input.status !== undefined && !['unknown','label_created'].includes(input.status)) fail('Registra el estado observado como evento después de crear el envío.');
    await insertRow(tx,'shipments',{id,...rowFields(data),status:'unknown',source_as_of:null,version:1,created_at:at,updated_at:at});
  }
  await audit(tx,{entityType:'shipment',entityId:id,actorId,previous:old,next:await shipmentRow(tx,id),reason,source:input.source || 'manual'});
  if (!old && (input.status === 'label_created' || input.occurredAt || input.occurredOn || input.sourceAsOf)) {
    await recordShipmentEventTx(tx,id,{...input,version:1,status:input.status || 'label_created'},actorId);
  } else if (data.orderId) await resolveOrderRecognition(tx,data.orderId,actorId,{reason,source:input.source || 'manual'});
  await bumpRevision(tx);
  return detail(tx,id);
}

function normalizeEvent(input,shipment) {
  const status = statusValue(input.status);
  const occurredAt = instant(input.occurredAt || null,'Fecha del evento',{nullable:true});
  const occurredOn = businessDate(input.occurredOn || null,'Fecha del evento',{nullable:true});
  if (occurredAt && occurredOn) fail('Indica fecha o instante del evento, no ambos.');
  const sourceAsOf = instant(input.sourceAsOf || null,'Fecha de corte',{nullable:true});
  if (!occurredAt && !occurredOn && !sourceAsOf) fail('Un evento sin fecha requiere fecha de corte del reporte.');
  const source = text(input.source || 'manual','Origen',20,true);
  if (!['manual','excel','legacy'].includes(source)) fail('Origen de evento no válido.');
  const correctionOf = nullableText(input.correctionOf,'Evento corregido');
  const reason = text(input.reason,'Motivo',2000);
  if (correctionOf && !reason) fail('Indica el motivo de la rectificación.');
  const rawStatus = text(input.rawStatus,'Estado original',500);
  const detail = text(input.detail ?? input.eventDetail,'Detalle del evento',4000);
  const externalId = nullableText(input.externalKey ?? input.externalEventId,'Identificador del evento',500);
  const content = {status,occurredAt,occurredOn,sourceAsOf,source,correctionOf,reason,rawStatus,detail};
  const externalKey = `event:${hash([shipment.sourceId || `manual:${shipment.id}`,externalId ? ['external',externalId] : ['observation',shipment.id,status,occurredAt,occurredOn,!occurredAt && !occurredOn ? sourceAsOf : null,detail,correctionOf]])}`;
  return {...content,externalKey};
}
function sameEvent(a,b) {
  return ['status','occurredAt','occurredOn','correctionOf','rawStatus','detail','source'].every(key => (a[key] || null) === (b[key] || null));
}
export function recordShipmentEvent(store,shipmentId,input,actorId) {
  inputObject(input);
  return runCommand(store,{scope:`shipment:event:${shipmentId}`,requestId:input.requestId,payload:input,actorId},tx => recordShipmentEventTx(tx,shipmentId,input,actorId));
}
export async function recordShipmentEventTx(tx,shipmentId,input,actorId) {
  inputObject(input);
  const shipment = await detail(tx,shipmentId);
  const normalized = normalizeEvent(input,shipment);
  const prior = await tx.db.get(`SELECT * FROM ${tx.t('shipment_events')} WHERE external_key=?`,[normalized.externalKey]);
  if (prior) {
    if (prior.shipment_id !== shipmentId || !sameEvent(entity(prior),normalized)) fail('El evento externo ya existe con otros datos. Requiere rectificación explícita.',409);
    return shipment;
  }
  integer(input.version,'Versión',1);
  if (input.version !== shipment.version) fail('El envío cambió. Recarga antes de registrar el evento.',409);
  const effective = effectiveShipmentEvents(shipment.events);
  if (normalized.correctionOf) {
    if (!effective.some(event => event.id === normalized.correctionOf)) fail('El evento corregido no existe o ya fue rectificado.',409);
  } else {
    const latest = effective.at(-1);
    if (latest && eventTime(normalized) >= eventTime(latest) && !terminalAllows(shipment.status,normalized.status) && normalized.status !== 'unknown') fail('Rectificar un estado final requiere motivo y referencia al evento original.',409);
  }
  const eventId = newId(), recordedAt = stamp();
  const events = [...shipment.events,{...normalized,id:eventId,recordedAt}];
  const nextStatus = effectiveShipmentState(events);
  if (shipment.orderId) {
    const order = await loadOrderData(tx,shipment.orderId);
    if (order?.status === 'cancelled' && DISPATCHED.has(normalized.status)) fail('No se puede despachar un pedido cancelado.',409);
    const siblings = (await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[shipment.orderId])).map(entity);
    validateActiveQuantities(order,siblings.map(other => other.id === shipmentId ? {...other,status:nextStatus} : other));
  }
  await insertRow(tx,'shipment_events',{id:eventId,shipment_id:shipmentId,external_key:normalized.externalKey,status:normalized.status,occurred_at:normalized.occurredAt,occurred_on:normalized.occurredOn,recorded_at:recordedAt,source_as_of:normalized.sourceAsOf,data:JSON.stringify({source:normalized.source,rawStatus:normalized.rawStatus,detail:normalized.detail,reason:normalized.reason,correctionOf:normalized.correctionOf,actorId})});
  const sourceAsOf = [shipment.sourceAsOf,normalized.sourceAsOf].filter(Boolean).sort().at(-1) || null;
  await updateVersioned(tx,'shipments',shipmentId,shipment.version,{status:nextStatus,source_as_of:sourceAsOf});
  await audit(tx,{entityType:'shipment_event',entityId:eventId,actorId,previous:normalized.correctionOf ? effective.find(event => event.id === normalized.correctionOf) : null,next:{...normalized,id:eventId,shipmentId,recordedAt},reason:normalized.reason,source:normalized.source});
  if (shipment.orderId) await resolveOrderRecognition(tx,shipment.orderId,actorId,{reason:normalized.reason,source:normalized.source,historicalCorrection:Boolean(normalized.correctionOf)});
  await bumpRevision(tx,[...effective.map(event => event.occurredOn || (event.occurredAt ? bogotaDate(event.occurredAt) : null)),normalized.occurredOn || (normalized.occurredAt ? bogotaDate(normalized.occurredAt) : null)]);
  return detail(tx,shipmentId);
}

// Explicit association never changes an already assigned guide to another order.
export async function linkShipmentTx(tx,input,actorId) {
  inputObject(input);
  const shipment = await detail(tx,text(input.shipmentId,'Envío',100,true));
  integer(input.version,'Versión',1);
  if (shipment.version !== input.version) fail('El envío cambió.',409);
  const reason = text(input.reason,'Motivo',2000,true);
  const orderId = text(input.orderId,'Pedido',100,true);
  if (shipment.orderId) fail('El envío ya está vinculado a un pedido.',409);
  const data = validateShipmentMetadata({...shipment,orderId});
  await validateAssignments(tx,data,input,shipment.id,{linking:true});
  await updateVersioned(tx,'shipments',shipment.id,shipment.version,rowFields({...data,identityKey:shipment.identityKey},shipment));
  await audit(tx,{entityType:'shipment',entityId:shipment.id,actorId,previous:shipment,next:await shipmentRow(tx,shipment.id),reason,source:input.source || 'manual'});
  await resolveOrderRecognition(tx,orderId,actorId,{reason,source:input.source || 'manual'});
  await bumpRevision(tx);
  return detail(tx,shipment.id);
}

export function pageShipments(store,filters = {}) {
  return store.readSnapshot(async tx => {
    const page = integer(filters.page ?? 1,'Página',1,100000), q = text(filters.q,'Búsqueda',100);
    const conditions = [], values = [];
    for (const [key,column,alias] of [['orderId','order_id','order'],['sourceId','source_id','source'],['platformId','platform_id','platform'],['carrier','carrier','carrier'],['status','status','status']]) {
      const value = text(filters[key] ?? filters[alias],key,200);
      if (value) { if (key === 'status') statusValue(value); conditions.push(`s.${column}=?`); values.push(value); }
    }
    if (q) {
      const escaped = `%${q.toLowerCase().replace(/[!%_]/g,ch => `!${ch}`)}%`;
      conditions.push(`(LOWER(s.carrier) LIKE ? ESCAPE '!' OR LOWER(s.tracking) LIKE ? ESCAPE '!' OR LOWER(COALESCE(s.external_id,'')) LIKE ? ESCAPE '!' OR CAST(o.number AS TEXT)=?)`);
      values.push(escaped,escaped,escaped,q.replace(/^AN-0*/i,''));
    }
    if (filters.issue) {
      const issue = text(filters.issue,'Pendiente',100);
      const cost = tx.provider === 'sqlite' ? `json_extract(s.data,'$.costStatus')` : `(s.data::jsonb->>'costStatus')`;
      const issues = {
        orphan:'s.order_id IS NULL',
        incident:`s.status IN ('incident','return_in_transit')`,
        missing_data:`(s.order_id IS NULL OR s.status='unknown' OR COALESCE(${cost},'unknown')='unknown' OR NOT EXISTS(SELECT 1 FROM ${tx.t('shipment_events')} e WHERE e.shipment_id=s.id AND (e.occurred_at IS NOT NULL OR e.occurred_on IS NOT NULL)))`,
      };
      if (!issues[issue]) fail('Filtro de envíos no válido.');
      conditions.push(issues[issue]);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = ` FROM ${tx.t('shipments')} s LEFT JOIN ${tx.t('orders')} o ON o.id=s.order_id LEFT JOIN ${tx.t('platforms')} p ON p.id=s.platform_id LEFT JOIN ${tx.t('platform_sources')} src ON src.id=s.source_id`;
    const total = Number((await tx.db.get(`SELECT COUNT(*) AS count${from}${where}`,values)).count);
    const rows = await tx.db.all(`SELECT s.id,s.order_id,s.platform_id,s.source_id,s.status,s.carrier,s.tracking,s.external_id,s.source_as_of,s.version,s.created_at,p.name AS platform_name,src.name AS source_name,o.number AS order_number,(SELECT MAX(e.occurred_on) FROM ${tx.t('shipment_events')} e WHERE e.shipment_id=s.id) AS known_event_on,(SELECT MAX(e.occurred_at) FROM ${tx.t('shipment_events')} e WHERE e.shipment_id=s.id) AS known_event_at${from}${where} ORDER BY s.created_at DESC,s.id DESC LIMIT 20 OFFSET ?`,[...values,(page-1)*20]);
    const records = rows.map(row=>({id:row.id,orderId:row.order_id,orderNumber:row.order_number==null?null:Number(row.order_number),platformId:row.platform_id,platformName:row.platform_name,sourceId:row.source_id,sourceName:row.source_name,status:row.status,carrier:row.carrier,tracking:row.tracking,externalId:row.external_id,sourceAsOf:row.source_as_of,version:Number(row.version),createdAt:row.created_at,knownEventOn:row.known_event_on,knownEventAt:row.known_event_at}));
    return {records,total,page,pageSize:20};
  });
}
