import { AppError, fail, integer, text } from '../validation-core.mjs';
import { audit, stamp } from './commands.mjs';
import { bogotaDate, businessDate, instant } from './dates.mjs';

const DISPATCHED = new Set(['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned']);
const add = (map, key, quantity) => map.set(key, integer((map.get(key) || 0) + quantity, 'Cantidad de inventario', 0, Number.MAX_SAFE_INTEGER));

/** The same physical projection serves both the full history and opening subset. */
function physicalState(order, shipments = [], eventsByShipment = new Map(), returns = [], {statusFallback = true} = {}) {
  const byId = new Map(shipments.map(shipment => [shipment.id, shipment]));
  const dispatched = new Set(shipments.filter(shipment => {
    const events = eventsByShipment.get(shipment.id) || [];
    return events.length ? events.some(event => DISPATCHED.has(event.status)) : statusFallback && DISPATCHED.has(shipment.status);
  }).map(shipment => shipment.id));
  const replaced = new Set(shipments.map(shipment => shipment.replacesShipmentId).filter(Boolean));
  const issued = new Map(), originalIssued = new Map(), resendPending = new Map(), roots = new Map();
  for (const shipment of shipments) {
    let ancestor = shipment, hasDispatchedAncestor = false;
    const seen = new Set([shipment.id]);
    while (ancestor.replacesShipmentId) {
      ancestor = byId.get(ancestor.replacesShipmentId);
      if (!ancestor || seen.has(ancestor.id)) fail('La cadena de reenvíos no es válida.');
      seen.add(ancestor.id);
      hasDispatchedAncestor ||= dispatched.has(ancestor.id);
    }
    for (const allocation of shipment.assignments || []) {
      if (dispatched.has(shipment.id)) {
        add(issued, allocation.lineId, allocation.quantity);
        const rootKey = `${ancestor.id}:${allocation.lineId}`;
        const previous = roots.get(rootKey) || 0;
        if (allocation.quantity > previous) {
          add(originalIssued, allocation.lineId, allocation.quantity - previous);
          roots.set(rootKey, allocation.quantity);
        }
      } else if (hasDispatchedAncestor && !replaced.has(shipment.id) && shipment.status !== 'cancelled') {
        add(resendPending, allocation.lineId, allocation.quantity);
      }
    }
  }
  const allocated = order.inventory?.returns;
  if (allocated !== undefined && !Array.isArray(allocated)) fail('Asignaciones de devolución no válidas.');
  const previousReturns = new Map();
  for (const line of allocated || []) {
    if (!line || typeof line.returnId !== 'string' || typeof line.lineId !== 'string') fail('Asignación de devolución no válida.');
    const key = `${line.returnId}:${line.lineId}`;
    if (previousReturns.has(key)) fail('Asignación de devolución repetida.');
    previousReturns.set(key,line);
  }
  const returnedIssued = new Map(), pendingClosed = new Map(), recoveredIssued = new Map(), pendingLoss = new Map(), returnAllocations = [];
  // Existing physical attribution must be reserved before any new return can claim it.
  for (const document of returns) for (const line of document.lines || []) {
    const previous = previousReturns.get(`${document.id}:${line.lineId}`);
    if (previous) add(returnedIssued,line.lineId,integer(previous.issuedQuantity,'Unidades despachadas devueltas',0,line.quantity));
  }
  for (const [lineId,quantity] of returnedIssued) {
    if (quantity > (issued.get(lineId) || 0)) fail('La rectificación elimina un despacho con unidades ya devueltas. Conserva la evidencia de su salida física.',409);
  }
  for (const document of [...returns].sort((a,b) => (a.recordedAt || '').localeCompare(b.recordedAt || '') || a.id.localeCompare(b.id))) for (const line of document.lines || []) {
    const key = `${document.id}:${line.lineId}`, previous = previousReturns.get(key);
    const availableIssued = Math.max(0,(issued.get(line.lineId) || 0) - (returnedIssued.get(line.lineId) || 0));
    const issuedQuantity = previous ? previous.issuedQuantity : Math.min(line.quantity,availableIssued);
    const pendingQuantity = line.quantity - issuedQuantity;
    if (!previous) add(returnedIssued,line.lineId,issuedQuantity);
    add(pendingClosed,line.lineId,pendingQuantity);
    if (line.condition === 'recoverable') add(recoveredIssued,line.lineId,issuedQuantity);
    else add(pendingLoss,line.lineId,pendingQuantity);
    returnAllocations.push({returnId:document.id,lineId:line.lineId,issuedQuantity});
    previousReturns.delete(key);
  }
  if (previousReturns.size) fail('El inventario contiene una devolución inexistente.');
  const products = new Map();
  for (const line of order.items) {
    const closed = pendingClosed.get(line.lineId) || 0;
    const originalDispatched = originalIssued.get(line.lineId) || 0;
    if (originalDispatched + closed > line.quantity) fail('No se pueden despachar unidades cerradas por una devolución anterior.',409);
    const consumed = (issued.get(line.lineId) || 0) - (recoveredIssued.get(line.lineId) || 0) + (pendingLoss.get(line.lineId) || 0);
    const reserved = order.status === 'cancelled' ? 0 : Math.max(0,line.quantity - originalDispatched - closed) + (resendPending.get(line.lineId) || 0);
    const components = line.components?.length ? line.components : [{productId:line.itemId,quantity:1}];
    for (const component of components) {
      const previous = products.get(component.productId) || {productId:component.productId,reserved:0,consumed:0};
      previous.reserved = integer(previous.reserved + reserved * component.quantity, 'Reserva de inventario', 0, Number.MAX_SAFE_INTEGER);
      previous.consumed = integer(previous.consumed + consumed * component.quantity, 'Salida de inventario', 0, Number.MAX_SAFE_INTEGER);
      products.set(component.productId, previous);
    }
  }
  return {version:1,products:[...products.values()].sort((a,b) => a.productId.localeCompare(b.productId)),returns:returnAllocations.sort((a,b) => a.returnId.localeCompare(b.returnId) || a.lineId.localeCompare(b.lineId))};
}

function effectiveEvents(events) {
  const superseded = new Set(events.map(event => event.correctionOf).filter(Boolean));
  return events.filter(event => !superseded.has(event.id));
}

const openingFailure = message => { const error=new AppError(message,409); error.code='IMPORT_OPENING_CLASSIFICATION'; throw error; };
const properties = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: campos no válidos.`);
};

/** Validate audit evidence independently of the derived stock projection. */
export function validateInventoryOpening(opening, shipments = [], eventsByShipment = new Map(), returns = []) {
  properties(opening,['on','sourceId','batchId','confirmedBy','confirmedAt','eventClassifications','returnClassifications'],'Apertura de inventario');
  businessDate(opening.on,'Fecha del conteo físico');
  for (const key of ['sourceId','batchId','confirmedBy']) text(opening[key],key,100,true);
  if (instant(opening.confirmedAt,'Confirmación de apertura') !== opening.confirmedAt) fail('La confirmación de apertura debe ser un instante normalizado.');
  const events = new Map(shipments.flatMap(shipment => (eventsByShipment.get(shipment.id) || []).map(event => [event.id,event])));
  for (const shipment of shipments) {
    const documents = eventsByShipment.get(shipment.id) || [],byId = new Map(documents.map(event => [event.id,event]));
    for (const event of documents) {
      let current=event;
      const seen=new Set();
      while (current?.correctionOf) {
        if (seen.has(current.id) || !byId.has(current.correctionOf)) fail('La rectificación de inventario debe referirse a un evento anterior del mismo envío.');
        seen.add(current.id);
        current=byId.get(current.correctionOf);
      }
    }
  }
  const returned = new Map(returns.map(document => [document.id,document]));
  for (const [key,idKey,documents] of [['eventClassifications','eventId',events],['returnClassifications','returnId',returned]]) {
    if (!Array.isArray(opening[key])) fail('Las clasificaciones de apertura deben ser una colección.');
    const seen = new Set();
    for (const decision of opening[key]) {
      properties(decision,[idKey,'included','confirmedBy','confirmedAt','reason'],'Clasificación de apertura');
      const id = text(decision[idKey],'Documento clasificado',100,true);
      if (seen.has(id) || !documents.has(id)) fail('La clasificación de apertura no pertenece a un documento de este pedido.');
      seen.add(id);
      if (typeof decision.included !== 'boolean') fail('Confirma si el hecho estaba incluido en el conteo.');
      text(decision.confirmedBy,'Administrador que confirmó',100,true);
      if (instant(decision.confirmedAt,'Confirmación de clasificación') !== decision.confirmedAt) fail('La confirmación debe ser un instante normalizado.');
      text(decision.reason,'Motivo de clasificación',2000,true);
    }
  }
  return opening;
}

/** Real event date wins; ambiguous corrections inherit only explicit raw-chain evidence. */
export function inventoryOpeningIncluded(opening, document, {kind = 'event', documents = []} = {}) {
  const on = document.occurredOn || (document.occurredAt ? bogotaDate(document.occurredAt) : null);
  if (on && on !== opening.on) return on < opening.on;
  const idKey = kind === 'return' ? 'returnId' : 'eventId';
  const decisions = new Map(opening[kind === 'return' ? 'returnClassifications' : 'eventClassifications'].map(value => [value[idKey],value.included]));
  const byId = new Map(documents.map(value => [value.id,value]));
  const seen = new Set();
  let current = document;
  while (current) {
    if (seen.has(current.id)) fail('La cadena de rectificaciones de inventario contiene un ciclo.');
    seen.add(current.id);
    if (decisions.has(current.id)) return decisions.get(current.id);
    current = current.correctionOf ? byId.get(current.correctionOf) : null;
  }
  return openingFailure(`Confirma si ${kind === 'return' ? 'la devolución' : 'el evento'} «${document.id}» ${on ? 'del día del conteo' : 'sin fecha real'} ya estaba reflejado en las existencias físicas.`);
}

/** Pure, auditable projection; opening never falls back to a guide's current status. */
export function inventoryState(order, shipments = [], eventsByShipment = new Map(), returns = []) {
  const effective = new Map(shipments.map(shipment => [shipment.id,effectiveEvents(eventsByShipment.get(shipment.id) || [])]));
  const full = physicalState(order,shipments,effective,returns);
  if (!order.inventoryOpening) return full;
  const opening = validateInventoryOpening(order.inventoryOpening,shipments,eventsByShipment,returns);
  const included = new Map(shipments.map(shipment => {
    const raw = eventsByShipment.get(shipment.id) || [];
    return [shipment.id,(effective.get(shipment.id) || []).filter(event => DISPATCHED.has(event.status) && inventoryOpeningIncluded(opening,event,{documents:raw}))];
  }));
  const includedReturns = returns.filter(document => inventoryOpeningIncluded(opening,document,{kind:'return',documents:returns}));
  const includedIds = new Set(includedReturns.map(document => document.id));
  const openingOrder = {...order,inventory:{returns:(order.inventory?.returns || []).filter(line => includedIds.has(line.returnId))}};
  const baseline = physicalState(openingOrder,shipments,included,includedReturns,{statusFallback:false});
  return {...full,version:2,openingProducts:baseline.products.map(({productId,consumed}) => ({productId,consumed}))};
}

/** Deltas are reusable in preview and under the write lock. */
export function inventoryChanges(previous, next) {
  const before = new Map((previous?.products || []).map(product => [product.productId,product]));
  const after = new Map((next?.products || []).map(product => [product.productId,product]));
  const beforeOpening = new Map((previous?.openingProducts || []).map(product => [product.productId,product.consumed]));
  const afterOpening = new Map((next?.openingProducts || []).map(product => [product.productId,product.consumed]));
  return [...new Set([...before.keys(),...after.keys()])].map(productId => ({
    productId,
    reservationDelta:(after.get(productId)?.reserved || 0) - (before.get(productId)?.reserved || 0),
    consumptionDelta:(after.get(productId)?.consumed || 0) - (afterOpening.get(productId) || 0) - (before.get(productId)?.consumed || 0) + (beforeOpening.get(productId) || 0)
  }));
}

/** Aggregate first, then check real product balances; no writes or transient reservations. */
export function previewInventoryChanges(projections, products) {
  const aggregate = new Map();
  for (const {previous = null,next} of projections) for (const change of inventoryChanges(previous,next)) {
    const value = aggregate.get(change.productId) || {productId:change.productId,reservationDelta:0,consumptionDelta:0};
    value.reservationDelta += change.reservationDelta;
    value.consumptionDelta += change.consumptionDelta;
    aggregate.set(change.productId,value);
  }
  const byId = new Map(products.map(product => [product.id,product]));
  return [...aggregate.values()].map(change => {
    const product = byId.get(change.productId);
    const stockReserved = (product?.stockReserved || 0) + change.reservationDelta;
    const stockQuantity = product?.stockQuantity == null ? null : product.stockQuantity - change.consumptionDelta;
    const issue = !product ? 'Producto inexistente.' : stockReserved < 0 || stockQuantity !== null && stockQuantity < stockReserved ? 'Existencias insuficientes.' : null;
    return {...change,stockQuantity,stockReserved,available:stockQuantity === null ? null : stockQuantity-stockReserved,issue};
  });
}

/** Caller owns lockWrites and the transaction, including the order/event/return being applied. */
export async function reconcileInventoryTx(tx, order, {shipments = [], eventsByShipment = new Map(), returns = [], actorId, reason = 'Actualización de existencias', source = 'manual'} = {}) {
  const next = inventoryState(order, shipments, eventsByShipment, returns);
  for (const {productId,reservationDelta,consumptionDelta} of inventoryChanges(order.inventory,next)) {
    if (!reservationDelta && !consumptionDelta) continue;
    const row = await tx.db.get(`SELECT * FROM ${tx.t('records')} WHERE kind='products' AND id=?`, [productId]);
    if (!row) fail('Una referencia de inventario ya no existe.', 409);
    const data = JSON.parse(row.data);
    if (data.productType === 'gift') fail('El inventario debe corresponder a los componentes del obsequio.', 409);
    const stockReserved = integer((data.stockReserved || 0) + reservationDelta, 'Unidades reservadas', 0, Number.MAX_SAFE_INTEGER);
    let stockQuantity = data.stockQuantity ?? null;
    // Unknown counts stay unknown; the order still records factual reservations and consumption.
    if (stockQuantity !== null) {
      stockQuantity = stockQuantity - consumptionDelta;
      if (!Number.isSafeInteger(stockQuantity) || stockQuantity < stockReserved) fail(`Existencias insuficientes de «${row.title}». Disponibles: ${Math.max(0, data.stockQuantity - (data.stockReserved || 0))}.`, 409);
    }
    const updated = {...data,stockQuantity,stockReserved};
    delete updated.availability;
    delete updated.stockAvailable;
    await tx.db.run(`UPDATE ${tx.t('records')} SET data=?,version=version+1,updated_at=? WHERE id=?`, [JSON.stringify(updated), stamp(), productId]);
    await audit(tx, {entityType:'inventory',entityId:productId,actorId,previous:{stockQuantity:data.stockQuantity ?? null,stockReserved:data.stockReserved || 0},next:{stockQuantity,stockReserved,orderId:order.id},reason,source});
  }
  return next;
}
