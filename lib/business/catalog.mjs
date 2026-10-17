import { fail, integer, text } from '../validation-core.mjs';
import { moneyMinor } from './money.mjs';
import { businessDate, bogotaDate } from './dates.mjs';
import { audit, bumpRevision, insertRow, newId, runCommand, stamp } from './commands.mjs';

export async function recordProductCost(tx, productId, data, previous, actorId) {
  if (data.productType === 'gift') return;
  if (previous && previous.unitCostMinor === data.unitCostMinor && previous.costEffectiveOn === data.costEffectiveOn) return;
  const effectiveOn = data.costEffectiveOn || bogotaDate();
  data.costEffectiveOn = effectiveOn;
  const old = await tx.db.get(`SELECT * FROM ${tx.t('product_costs')} WHERE product_id=? AND effective_on=?`, [productId, effectiveOn]);
  const recordedAt = stamp();
  if (old) await tx.db.run(`UPDATE ${tx.t('product_costs')} SET unit_cost_minor=?,recorded_at=?,actor_id=?,updated_at=?,version=version+1 WHERE id=?`, [data.unitCostMinor, recordedAt, actorId, recordedAt, old.id]);
  else await insertRow(tx, 'product_costs', { id:newId(), product_id:productId, effective_on:effectiveOn, unit_cost_minor:data.unitCostMinor, recorded_at:recordedAt, actor_id:actorId, version:1, created_at:recordedAt, updated_at:recordedAt });
  await audit(tx, { entityType:'product_cost', entityId:old?.id || productId, actorId, previous:old, next:{productId,effectiveOn,unitCostMinor:data.unitCostMinor,recordedAt}, reason:old ? 'Corrección del costo vigente en la misma fecha' : 'Registro de costo' });
}

export async function snapshotCatalogItem(tx, kind, id, placedOn, { allowUnavailable = false } = {}) {
  if (!['products','combos'].includes(kind)) fail('Referencia no válida.');
  placedOn = businessDate(placedOn, 'Fecha del pedido', {nullable:true});
  const item = await tx.get(kind,id);
  if (!item) fail('Referencia no encontrada.',404);
  const productType = kind === 'combos' ? 'combo' : item.productType || 'product';
  const composed = productType === 'gift' || kind === 'combos';
  if (!allowUnavailable && (kind === 'products' ? !(item.orderable ?? item.status === 'published') : item.status !== 'published')) fail('La referencia no está habilitada para pedidos.');
  let unitCostMinor = null;
  const components = [];
  if (composed) {
    if (!item.items?.length) fail('La referencia no tiene componentes.');
    for (const line of item.items) {
      const product = await tx.get('products',line.productId);
      if (!product || product.id === id || product.productType === 'gift') fail('Los componentes deben ser productos normales.');
      const component = await snapshotCatalogItem(tx,'products',line.productId,placedOn,{allowUnavailable});
      components.push({productId:line.productId,title:component.title,presentation:component.presentation,quantity:line.quantity,unitCostMinor:component.unitCostMinor});
    }
    if (components.every(c=>c.unitCostMinor !== null)) unitCostMinor = moneyMinor(components.reduce((sum,c)=>sum + c.unitCostMinor*c.quantity,0),'Costo compuesto');
  } else if (placedOn) {
    const row = await tx.db.get(`SELECT unit_cost_minor FROM ${tx.t('product_costs')} WHERE product_id=? AND effective_on<=? ORDER BY effective_on DESC LIMIT 1`,[id,placedOn]);
    unitCostMinor = row?.unit_cost_minor == null ? null : moneyMinor(Number(row.unit_cost_minor),'Costo');
  }
  return {productType,title:item.title,presentation:item.presentation || '',unitCostMinor,components};
}

export async function completeOrderCosts(store,input,actorId) {
  const orderId = text(input.orderId,'Pedido',100,true), reason = text(input.reason,'Motivo',2000,true);
  integer(input.version,'Versión',1);
  if (!Array.isArray(input.lineCosts) || !input.lineCosts.length) fail('Indica los costos a corregir.');
  return runCommand(store,{scope:'order:complete-costs',requestId:input.requestId,payload:input,actorId},async tx=>{
    const order = await tx.order(orderId);
    if (!order) fail('Pedido no encontrado.',404);
    if (order.version !== input.version) fail('El pedido cambió.',409);
    const before = structuredClone(order.items), seen = new Set();
    for (const correction of input.lineCosts) {
      if (seen.has(correction.lineId)) fail('Línea repetida.'); seen.add(correction.lineId);
      const line = order.items.find(l=>l.lineId === correction.lineId);
      if (!line) fail('La línea no pertenece al pedido.');
      if (line.components?.length) {
        if (!Array.isArray(correction.components) || correction.components.length !== line.components.length) fail('Completa los costos de todos los componentes.');
        for (const component of line.components) {
          const matches = correction.components.filter(c=>c.productId === component.productId);
          if (matches.length !== 1) fail('Componente no válido.');
          component.unitCostMinor = moneyMinor(matches[0].unitCostMinor,'Costo del componente');
        }
        line.unitCostMinor = moneyMinor(line.components.reduce((s,c)=>s+c.quantity*c.unitCostMinor,0),'Costo compuesto');
      } else line.unitCostMinor = moneyMinor(correction.unitCostMinor,'Costo unitario');
    }
    const dates = [order.placedOn,order.recognition?.on];
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`,[orderId])) {
      const data = JSON.parse(row.data), previous = structuredClone(data);
      for (const returned of data.lines || []) {
        const line = order.items.find(l=>l.lineId === returned.lineId);
        if (!line || !seen.has(line.lineId)) continue;
        returned.recoveredCostMinor = returned.condition === 'recoverable' ? moneyMinor(line.unitCostMinor*returned.quantity,'Costo recuperado') : 0;
        const loss = moneyMinor(line.unitCostMinor*returned.quantity-returned.recoveredCostMinor,'Pérdida');
        const sourceKey = `return-loss:${row.id}:${line.lineId}`;
        const expense = await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`,[sourceKey]);
        if (expense) {
          await tx.db.run(`UPDATE ${tx.t('expenses')} SET amount_minor=?,version=version+1,updated_at=? WHERE id=?`,[loss,stamp(),expense.id]);
          await audit(tx,{entityType:'expense',entityId:expense.id,actorId,previous:expense,next:{...expense,amount_minor:loss},reason});
        } else if ((!order.recognition?.on || order.recognition.on > row.occurred_on) && loss > 0) {
          await insertRow(tx,'expenses',{id:newId(),category:'other',amount_minor:loss,incurred_on:row.occurred_on,person_id:null,order_id:orderId,shipment_id:null,source_key:sourceKey,version:1,recorded_at:stamp(),created_at:stamp(),updated_at:stamp(),data:JSON.stringify({returnId:row.id,lineId:line.lineId})});
        }
      }
      await tx.db.run(`UPDATE ${tx.t('order_returns')} SET data=?,version=version+1,updated_at=? WHERE id=?`,[JSON.stringify(data),stamp(),row.id]);
      await audit(tx,{entityType:'order_return',entityId:row.id,actorId,previous,next:data,reason});
      dates.push(row.occurred_on);
    }
    const raw = await tx.db.get(`SELECT data FROM ${tx.t('orders')} WHERE id=?`,[orderId]);
    const data = {...JSON.parse(raw.data),items:order.items};
    await tx.db.run(`UPDATE ${tx.t('orders')} SET data=?,version=version+1,updated_at=? WHERE id=? AND version=?`,[JSON.stringify(data),stamp(),orderId,input.version]);
    await audit(tx,{entityType:'order_costs',entityId:orderId,actorId,previous:before,next:order.items,reason});
    await bumpRevision(tx,dates);
    return tx.order(orderId);
  });
}
