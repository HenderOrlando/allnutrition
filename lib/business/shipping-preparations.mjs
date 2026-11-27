import { fail, integer, text } from '../validation-core.mjs';
import { PACK_FIELDS, RECIPIENT_FIELDS, preparationValues, shippingObject } from '../shipping/center-values.mjs';
import { audit, entity, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { moneyMinor, pesosToMinor, roundRatio } from './money.mjs';
import { getOrder, loadOrderData } from './orders.mjs';
import { effectiveShipmentEvents } from './shipments.mjs';

const DATA_FIELDS = ['route','parcel','lines','recipient','payment','options','offer'];
const UNIT_FIELDS = PACK_FIELDS.map(field => field.name);
const OPEN_SHIPMENT_STATES = ['unknown','label_created'];
const FROZEN_EVENTS = ['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned','cancelled'];
const nullableId = (value,label) => text(value,label,100) || null;
const versionOf = (value,label) => integer(value,label,1,2147483647);
const refKey = ({kind,itemId}) => `${kind}:${itemId}`;

function expectsVersion(value,id,label) {
  if (id) return versionOf(value,label);
  if (value != null) fail(`${label}: no corresponde sin un registro.`);
  return null;
}

async function related(tx,orderId,shipmentId,{context = false, inferOrder = false} = {}) {
  const shipment = shipmentId ? entity(await tx.db.get(`SELECT * FROM ${tx.t('shipments')} WHERE id=?`,[shipmentId])) : null;
  if (shipmentId && !shipment) fail('Envío no encontrado.',404);
  if (inferOrder && !orderId) orderId = shipment?.orderId ?? null;
  if (shipment && shipment.orderId !== orderId) fail('El envío no corresponde al pedido confirmado.',409);
  const order = orderId ? await (context ? getOrder(tx,orderId,{history:false}) : loadOrderData(tx,orderId)) : null;
  if (orderId && !order) fail('Pedido no encontrado.',404);
  return {order,shipment};
}

async function frozen(tx,{order,shipment}) {
  if (order && ['cancelled','delivered','returned'].includes(order.status)) return true;
  if (!shipment) return order?.status === 'sent' || order?.economicLocked === true;
  if (!OPEN_SHIPMENT_STATES.includes(shipment.status)) return true;
  const events = await tx.db.all(`SELECT id,status,occurred_at,occurred_on,source_as_of,recorded_at,data FROM ${tx.t('shipment_events')} WHERE shipment_id=?`,[shipment.id]);
  if (effectiveShipmentEvents(events).some(event => FROZEN_EVENTS.includes(event.status))) return true;
  // Replacing a shipment freezes the original, not the shipment that will replace it.
  if (!order) return false;
  const replaced = tx.provider === 'sqlite' ? `json_extract(data,'$.replacesShipmentId')` : `(data::jsonb->>'replacesShipmentId')`;
  return Boolean(await tx.db.get(`SELECT 1 FROM ${tx.t('shipments')} WHERE order_id=? AND ${replaced}=? LIMIT 1`,[order.id,shipment.id]));
}

function draftLine(line,quantity) {
  return {kind:line.kind,itemId:line.itemId,lineId:line.lineId,quantity,title:line.title,unitPriceMinor:line.unitPriceMinor};
}

function validateOrderLines(lines,{order,shipment}) {
  const allowed = new Map((shipment ? shipment.assignments ?? [] : order.items).map(line => [line.lineId,line.quantity]));
  const items = new Map(order.items.map(line => [line.lineId,line]));
  const seen = new Set();
  const result = lines.map(line => {
    const item = items.get(line.lineId);
    const quantity = allowed.get(line.lineId);
    if (!item || item.kind !== line.kind || item.itemId !== line.itemId || seen.has(line.lineId) || !quantity || line.quantity > quantity || shipment && line.quantity !== quantity)
      fail('Revisa las líneas y cantidades: no coinciden con el pedido o la asignación del envío.',409);
    seen.add(line.lineId);
    return draftLine(item,line.quantity);
  });
  if (!result.length || shipment && result.length !== allowed.size) fail('La preparación debe incluir las líneas asignadas a este envío.',409);
  return result;
}

async function catalogItem(tx,{kind,itemId}) {
  const row = await tx.db.get(`SELECT data FROM ${tx.t('records')} WHERE kind=? AND id=?`,[kind,itemId]);
  return row ? JSON.parse(row.data) : null;
}

async function validateStandaloneLines(tx,lines) {
  const result = [], seen = new Set();
  for (const line of lines) {
    const key = refKey(line);
    if (line.lineId || seen.has(key)) fail('Usa cada referencia una sola vez; este borrador no tiene líneas de pedido.');
    const item = await catalogItem(tx,line);
    if (!item) fail('Una referencia de la preparación ya no existe.',409);
    seen.add(key);
    result.push({...line,title:item.title,unitPriceMinor:pesosToMinor(item.price)});
  }
  return result;
}

function unitChanges(input = [],lines) {
  if (!Array.isArray(input) || input.length > 50) fail('Usa como máximo 50 cambios de empaque.');
  if (!input.length) return [];
  const available = new Set(lines.map(refKey));
  return input.map(patch => {
    shippingObject(patch,['kind','itemId','version',...UNIT_FIELDS],'Empaque de una unidad');
    const kind = text(patch.kind,'Tipo de referencia',20,true), itemId = text(patch.itemId,'Referencia',100,true);
    if (!available.delete(refKey({kind,itemId}))) fail('Confirma un solo cambio de empaque por referencia incluida en la preparación.');
    const values = {};
    for (const {name,label,max} of PACK_FIELDS) if (Object.hasOwn(patch,name)) values[name] = patch[name] === null ? null : integer(patch[name],label,1,max);
    if (!Object.keys(values).length) fail('Indica qué medidas unitarias confirmaste.');
    return {kind,itemId,version:versionOf(patch.version,'Versión de la referencia'),values};
  });
}

function dto(row) {
  return {...JSON.parse(row.data),id:row.id,version:row.version,updatedAt:row.updated_at,orderId:row.order_id,orderVersion:row.order_version,shipmentId:row.shipment_id,shipmentVersion:row.shipment_version};
}
const selectPreparation = tx => `SELECT p.*,o.version AS order_version,s.version AS shipment_version FROM ${tx.t('shipping_preparations')} p LEFT JOIN ${tx.t('orders')} o ON o.id=p.order_id LEFT JOIN ${tx.t('shipments')} s ON s.id=p.shipment_id`;

function collectionFacts(order,lines) {
  const summary = order?.paymentSummary;
  if (!summary) return {partial:false,collectionNeedsConfirmation:false};
  const quantities = new Map(lines.map(line => [line.lineId,line.quantity]));
  const partial = order.items.some(line => quantities.get(line.lineId) !== line.quantity);
  return {partial,collectionNeedsConfirmation:summary.legacyReview || partial && summary.outstandingMinor > 0};
}

async function savedContext(tx,preparation,relations) {
  return {...preparation,...collectionFacts(relations.order,preparation.lines),editable:!await frozen(tx,relations),
    provenance:Object.fromEntries(['recipient','route','lines','parcel','declaredMinor','collectionMinor'].map(key => [key,'preparation']))};
}

export function getShippingPreparation(store,id) {
  id = text(id,'Preparación',100,true);
  return store.readSnapshot(async tx => {
    const row = await tx.db.get(`${selectPreparation(tx)} WHERE p.id=?`,[id]);
    if (!row) fail('Preparación no encontrada.',404);
    return savedContext(tx,dto(row),await related(tx,row.order_id,row.shipment_id,{context:true}));
  });
}

export function listShippingPreparations(store,{page = 1,orderId = null} = {}) {
  page = integer(page,'Página',1,100000);
  const values = orderId == null ? [] : [text(orderId,'Pedido',100,true)];
  const where = values.length ? ' WHERE p.order_id=?' : '';
  return store.readSnapshot(async tx => {
    const limit = 20;
    const {total:count} = await tx.db.get(`SELECT COUNT(*) AS total FROM ${tx.t('shipping_preparations')} p${where}`,values);
    const total = Number(count);
    const rows = (await tx.db.all(`${selectPreparation(tx)}${where} ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`,[...values,limit,(page-1)*limit])).map(dto);
    return {rows,pager:{page,limit,total,nextPage:page*limit < total ? page+1 : null,previousPage:page > 1 ? page-1 : null}};
  });
}

export function getShippingPreparationContext(store,{orderId,shipmentId} = {}) {
  orderId = nullableId(orderId,'Pedido'); shipmentId = nullableId(shipmentId,'Envío');
  if (!orderId && !shipmentId) fail('Selecciona un pedido o envío para precargar sus datos.');
  return store.readSnapshot(async tx => {
    const relations = await related(tx,orderId,shipmentId,{context:true,inferOrder:true});
    const {order,shipment} = relations;
    if (shipment) {
      const row = await tx.db.get(`${selectPreparation(tx)} WHERE p.shipment_id=?`,[shipment.id]);
      if (row) return savedContext(tx,dto(row),relations);
    }
    const assigned = shipment ? new Map((shipment.assignments ?? []).map(line => [line.lineId,line.quantity])) : null;
    const lines = [], parcel = {}, packing = new Map();
    let declaredMinor = null, weight = 0, units = 0, allWeights = true;
    for (const line of order?.items ?? []) {
      const quantity = assigned ? assigned.get(line.lineId) : line.quantity;
      if (!quantity) continue;
      lines.push(draftLine(line,quantity));
      declaredMinor = moneyMinor((declaredMinor ?? 0) + quantity*line.unitPriceMinor - roundRatio(BigInt(line.discountMinor)*BigInt(quantity),line.quantity),'Valor declarado');
      const key = refKey(line);
      if (!packing.has(key)) packing.set(key,await catalogItem(tx,line));
      const unit = packing.get(key);
      units += quantity;
      if (Number.isSafeInteger(unit?.packedWeightG)) weight += unit.packedWeightG * quantity;
      else allWeights = false;
    }
    if (units === 1) for (const {name,key} of PACK_FIELDS) parcel[key] = packing.get(refKey(lines[0]))?.[name] ?? null;
    else if (units && allWeights && weight <= PACK_FIELDS[0].max) parcel.weightG = weight;
    const {partial,collectionNeedsConfirmation} = collectionFacts(order,lines);
    const collectionMinor = collectionNeedsConfirmation ? null : order?.paymentSummary.outstandingMinor ?? null;
    const recipient = Object.fromEntries(RECIPIENT_FIELDS.map(([key]) => [key,order?.[key] ?? '']));
    const route = {destination:{city:recipient.city,state:recipient.department},deliveryType:order?.deliveryMethod === 'pickup' ? 'office' : 'address'};
    const values = preparationValues({route,recipient,lines,parcel,payment:{declaredMinor,collectionMinor,collectionConfirmed:collectionMinor === 0}});
    return {...values,id:null,version:null,orderId:order?.id ?? null,orderVersion:order?.version ?? null,shipmentId:shipment?.id ?? null,shipmentVersion:shipment?.version ?? null,
      partial,collectionNeedsConfirmation,editable:!await frozen(tx,relations),provenance:{recipient:order ? 'order' : null,route:order ? 'order' : null,
        lines:order ? shipment ? 'shipment' : 'order' : null,parcel:units === 1 && Object.values(parcel).some(value => value !== null) ? 'unit' : parcel.weightG != null ? 'weight-suggestion' : null,
        declaredMinor:declaredMinor == null ? null : 'lines',collectionMinor:collectionMinor == null ? null : 'order-balance'}};
  });
}

export async function saveShippingPreparation(store,input,actorId) {
  shippingObject(input,['id','version','orderId','orderVersion','shipmentId','shipmentVersion','unitPatches','requestId',...DATA_FIELDS],'Preparación');
  const id = nullableId(input.id,'Preparación'), orderId = nullableId(input.orderId,'Pedido'), shipmentId = nullableId(input.shipmentId,'Envío');
  const version = expectsVersion(input.version,id,'Versión de la preparación');
  const orderVersion = expectsVersion(input.orderVersion,orderId,'Versión del pedido');
  const shipmentVersion = expectsVersion(input.shipmentVersion,shipmentId,'Versión del envío');
  const values = preparationValues(Object.fromEntries(DATA_FIELDS.map(key => [key,input[key]])));
  const patches = unitChanges(input.unitPatches,values.lines);
  actorId = text(actorId,'Administrador',100,true);
  const privileged = {transaction: fn => store.transaction(async tx => {
    await tx.lockWrites();
    if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1${tx.provider === 'supabase' ? ' FOR SHARE' : ''}`,[actorId])) fail('El administrador ya no está autorizado.',403);
    return fn(tx);
  })};
  let saved;
  const receipt = await runCommand(privileged,{scope:id ? `shipping:preparation:${id}` : 'shipping:preparation:create',requestId:input.requestId,payload:input,actorId,affectsIndicators:false},async tx => {
    const old = id ? await tx.db.get(`SELECT * FROM ${tx.t('shipping_preparations')} WHERE id=?`,[id]) : null;
    if (id && !old) fail('Preparación no encontrada.',404);
    if (old && (old.version !== version || old.order_id !== orderId || old.shipment_id !== shipmentId)) fail('La preparación o su vínculo cambiaron. Carga la versión guardada.',409);
    if (!old && shipmentId && await tx.db.get(`SELECT 1 FROM ${tx.t('shipping_preparations')} WHERE shipment_id=?`,[shipmentId])) fail('Este envío ya tiene una preparación. Abre la guardada.',409);
    const relations = await related(tx,orderId,shipmentId);
    if ((relations.order?.version ?? null) !== orderVersion || (relations.shipment?.version ?? null) !== shipmentVersion) fail('El pedido o envío cambió. Revisa su versión actual antes de guardar.',409);
    if (await frozen(tx,relations)) fail('La preparación no se modifica después del despacho, cancelación o sustitución.',409);
    values.lines = relations.order ? validateOrderLines(values.lines,relations) : await validateStandaloneLines(tx,values.lines);
    const key = id ?? newId(), at = stamp(), data = JSON.stringify(values);
    if (old) await updateVersioned(tx,'shipping_preparations',key,version,{data});
    else await insertRow(tx,'shipping_preparations',{id:key,order_id:orderId,shipment_id:shipmentId,version:1,data,created_at:at,updated_at:at});
    const references = [];
    for (const {kind,itemId,version:expected,values:change} of patches) {
      const item = await tx.get(kind,itemId);
      if (!item || item.version !== expected) fail('Una referencia cambió. Revisa sus medidas antes de guardar.',409);
      const updated = await tx.saveTx(kind,{...item,...change},itemId,expected,actorId);
      references.push({kind,itemId,version:updated.version});
    }
    const savedVersion = old ? version+1 : 1;
    await audit(tx,{entityType:'shipping_preparation',entityId:key,actorId,next:{version:savedVersion,orderId,shipmentId,references},reason:'Preparación de envío guardada'});
    saved = {...values,id:key,version:savedVersion,orderId,orderVersion,shipmentId,shipmentVersion};
    // Do not duplicate the recipient or parcel in the portable command journal.
    return {id:key,version:savedVersion,orderVersion,shipmentVersion,references};
  });
  if (saved) return saved;
  const current = await getShippingPreparation(store,receipt.id);
  if (current.version !== receipt.version || current.orderVersion !== receipt.orderVersion || current.shipmentVersion !== receipt.shipmentVersion)
    fail('La preparación ya se guardó, pero su contexto cambió. Carga la versión guardada.',409);
  return Object.fromEntries([...DATA_FIELDS,'id','version','orderId','orderVersion','shipmentId','shipmentVersion'].map(key => [key,current[key]]));
}

// Called only inside a confirmed local association, in the same write transaction.
export async function attachShippingPreparationTx(tx,{id,version,orderId,shipmentId}) {
  id = text(id,'Preparación',100,true); versionOf(version,'Versión de la preparación');
  orderId = text(orderId,'Pedido confirmado',100,true); shipmentId = text(shipmentId,'Envío confirmado',100,true);
  const row = await tx.db.get(`SELECT * FROM ${tx.t('shipping_preparations')} WHERE id=?`,[id]);
  if (!row) fail('Preparación no encontrada.',404);
  if (row.version !== version || row.shipment_id && row.shipment_id !== shipmentId || row.order_id && row.order_id !== orderId)
    fail('La preparación ya no corresponde al pedido y envío confirmados.',409);
  const relations = await related(tx,orderId,shipmentId);
  if (row.shipment_id === shipmentId && row.order_id === orderId) return {id,version};
  if (await frozen(tx,relations)) fail('No se vincula una preparación a un envío despachado, cancelado o sustituido.',409);
  if (await tx.db.get(`SELECT 1 FROM ${tx.t('shipping_preparations')} WHERE shipment_id=? AND id<>?`,[shipmentId,id])) fail('Ese envío ya tiene otra preparación.',409);
  const data = JSON.parse(row.data);
  if (!row.order_id) {
    // A standalone preparation has no line IDs. Reuse it only when each assignment
    // can be identified unambiguously by its reference and exact quantity.
    const assigned = new Set((relations.shipment.assignments ?? []).map(line => line.lineId));
    data.lines = data.lines.map(line => {
      const matches = relations.order.items.filter(item => assigned.has(item.lineId) && refKey(item) === refKey(line));
      if (matches.length !== 1) fail('Las referencias de la preparación no se pueden asociar inequívocamente al pedido.',409);
      return {...line,lineId:matches[0].lineId};
    });
  }
  data.lines = validateOrderLines(data.lines,relations);
  await updateVersioned(tx,'shipping_preparations',id,version,{order_id:orderId,shipment_id:shipmentId,data:JSON.stringify(data)});
  return {id,version:version+1};
}
