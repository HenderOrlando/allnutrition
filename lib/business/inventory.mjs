import { fail, integer } from '../validation-core.mjs';
import { audit, stamp } from './commands.mjs';

const DISPATCHED = new Set(['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned']);
const add = (map, key, quantity) => map.set(key, integer((map.get(key) || 0) + quantity, 'Cantidad de inventario', 0, Number.MAX_SAFE_INTEGER));

/** Rebuild the order's physical obligations from immutable composition and effective logistics. */
export function inventoryState(order, shipments = [], eventsByShipment = new Map(), returns = []) {
  const byId = new Map(shipments.map(shipment => [shipment.id, shipment]));
  const dispatched = new Set(shipments.filter(shipment => {
    const events = eventsByShipment.get(shipment.id) || [];
    return events.length ? events.some(event => DISPATCHED.has(event.status)) : DISPATCHED.has(shipment.status);
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
  for (const document of [...returns].sort((a,b) => (a.recordedAt || '').localeCompare(b.recordedAt || '') || a.id.localeCompare(b.id))) for (const line of document.lines || []) {
    const key = `${document.id}:${line.lineId}`, previous = previousReturns.get(key);
    const availableIssued = Math.max(0,(issued.get(line.lineId) || 0) - (returnedIssued.get(line.lineId) || 0));
    const issuedQuantity = previous ? integer(previous.issuedQuantity,'Unidades despachadas devueltas',0,line.quantity) : Math.min(line.quantity,availableIssued);
    if (issuedQuantity > availableIssued) fail('La rectificación elimina un despacho con unidades ya devueltas. Conserva la evidencia de su salida física.',409);
    const pendingQuantity = line.quantity - issuedQuantity;
    add(returnedIssued,line.lineId,issuedQuantity);
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

/** Caller owns lockWrites and the transaction, including the order/event/return being applied. */
export async function reconcileInventoryTx(tx, order, {shipments = [], eventsByShipment = new Map(), returns = [], actorId, reason = 'Actualización de existencias', source = 'manual'} = {}) {
  const next = inventoryState(order, shipments, eventsByShipment, returns);
  const before = new Map((order.inventory?.products || []).map(product => [product.productId, product]));
  const after = new Map(next.products.map(product => [product.productId, product]));
  for (const productId of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(productId), current = after.get(productId);
    const reservationDelta = (current?.reserved || 0) - (previous?.reserved || 0);
    const consumptionDelta = (current?.consumed || 0) - (previous?.consumed || 0);
    if (!reservationDelta && !consumptionDelta) continue;
    const row = await tx.db.get(`SELECT * FROM ${tx.t('records')} WHERE kind='products' AND id=?`, [productId]);
    if (!row) fail('Una referencia de inventario ya no existe.', 409);
    const data = JSON.parse(row.data);
    if (data.productType === 'gift') fail('El inventario debe corresponder a los componentes del obsequio.', 409);
    const stockReserved = integer((data.stockReserved || 0) + reservationDelta, 'Unidades reservadas', 0, Number.MAX_SAFE_INTEGER);
    let stockQuantity = data.stockQuantity ?? null;
    if (stockQuantity == null) {
      if (reservationDelta > 0 || consumptionDelta > 0) fail(`Define las existencias de «${row.title}» antes de reservar o despachar unidades.`, 409);
    } else {
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
