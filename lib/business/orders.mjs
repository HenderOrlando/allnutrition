import { fail, integer, text, validateOrder } from '../validation.mjs';
import { audit, bumpRevision, entity, hash, insertRow, newId, stamp, updateVersioned } from './commands.mjs';
import { moneyMinor } from './money.mjs';
import { bogotaDate } from './dates.mjs';
import { snapshotCatalogItem } from './catalog.mjs';
import { getResource, ruleForOrder } from './settings.mjs';
import { effectiveShipmentEvents } from './shipments.mjs';
import { reconcileCommissionsTx } from './payroll.mjs';
import { reconcileInventoryTx } from './inventory.mjs';

// Only persisted order fields cross this boundary. Read DTOs and caller-supplied totals never do.
const ORDER_FIELDS = ['customerName','phone','city','department','address','addressNotes','email','documentType','documentNumber','notes','statusReason','status','placedOn','dateSource','sellerId','sellerSnapshot','deliveryMethod','shippingChargeMinor','items','subtotalMinor','totalMinor','cancellationOn','ruleSnapshot','policyReviewRequired','legacyPolicyReview','legacyFinancialReview','recognition','dispatchedOn','giftCostOn','giftDispatches','deliverySummary','economicLocked','inventory'];
const pick = (value,fields) => Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
function orderData(order) {
  const data=pick(order,ORDER_FIELDS);
  if (data.items) data.items=data.items.map(line=>({...pick(line,['lineId','kind','itemId','productType','title','presentation','quantity','unitPriceMinor','discountMinor','unitCostMinor']),components:(line.components || []).map(component=>pick(component,['productId','title','presentation','quantity','unitCostMinor']))}));
  return data;
}
const economics = order => pick(order,['items','placedOn','sellerId','sellerSnapshot','deliveryMethod','status','statusReason','shippingChargeMinor','subtotalMinor','totalMinor','cancellationOn','ruleSnapshot','policyReviewRequired','recognition','dispatchedOn','giftCostOn','giftDispatches','deliverySummary','economicLocked']);
const signedMoney = (amount, label = 'Importe') => moneyMinor(amount, label, { signed:true });
const sum = (rows, get) => signedMoney(rows.reduce((total,row) => total + get(row),0));
const lineNet = line => moneyMinor(line.quantity * line.unitPriceMinor - line.discountMinor);
const eventOn = event => event.occurredOn || (event.occurredAt ? bogotaDate(event.occurredAt) : null);

export async function loadOrderData(tx,id) {
  const row = await tx.db.get(`SELECT * FROM ${tx.t('orders')} WHERE id=?`,[id]);
  return row ? { ...orderData(JSON.parse(row.data)), id:row.id, number:Number(row.number), version:Number(row.version), createdAt:row.created_at, updatedAt:row.updated_at } : null;
}

export async function persistOrderData(tx,order,{actorId,reason,source='manual'}) {
  const previous = await loadOrderData(tx,order.id);
  if (!previous) fail('Pedido no encontrado.',404);
  if (previous.version !== order.version) fail('El pedido cambió en otra sesión. Recarga antes de guardar.',409);
  const next = orderData(order);
  await updateVersioned(tx,'orders',order.id,order.version,{data:JSON.stringify(next)});
  const updated = await loadOrderData(tx,order.id);
  await audit(tx,{entityType:'order',entityId:order.id,actorId,previous:economics(orderData(previous)),next:economics(next),reason,source});
  await insertRow(tx,'order_audit',{id:newId(),order_id:order.id,actor_id:actorId,created_at:stamp(),data:JSON.stringify({orderVersion:updated.version,previousStatus:previous.status,nextStatus:next.status,changedFields:Object.keys(next).filter(key=>hash(previous[key] ?? null)!==hash(next[key] ?? null)),reason:reason || '',source})});
  await bumpRevision(tx,[previous.recognition?.on,next.recognition?.on,previous.giftCostOn,next.giftCostOn,...(previous.giftDispatches || []).map(fact=>fact.on),...(next.giftDispatches || []).map(fact=>fact.on),previous.dispatchedOn,next.dispatchedOn,previous.placedOn,next.placedOn]);
  return updated;
}

// Reversals retain their original positive amount; their economic sign is the opposite of the original.
function collectionSign(row,byId,seen=new Set()) {
  if (row.kind !== 'reversal') return row.kind === 'refund' ? -1 : 1;
  if (seen.has(row.id)) fail('Referencia circular de reversión.');
  seen.add(row.id);
  const original=byId.get(row.reversalOf);
  if (!original) fail('El cobro revertido no existe.');
  return -collectionSign(original,byId,seen);
}
function activeFacts(rows) {
  const reversed = new Set(rows.filter(row=>row.reversalOf).map(row=>row.reversalOf));
  return rows.filter(row=>!row.reversalOf && !reversed.has(row.id));
}

export function orderSummary(order,{collections=[],returns=[],expenses=[],settlementReceipts=[],shipments=[]}={}) {
  const byId=new Map(collections.map(row=>[row.id,row]));
  const netCollectedMinor=sum(collections,row=>collectionSign(row,byId)*Number(row.amountMinor));
  const active=activeFacts(collections);
  const collectedMinor=sum(active.filter(row=>row.kind==='receipt'),row=>Number(row.amountMinor));
  const refundedMinor=sum(active.filter(row=>row.kind==='refund'),row=>Number(row.amountMinor));
  const productCreditMinor=sum(returns,row=>sum(row.lines || [],line=>line.salesCreditMinor || 0));
  const shippingCreditMinor=sum(returns,row=>row.shippingCreditMinor || 0);
  const commercialDueMinor=moneyMinor(Math.max(0,order.totalMinor-productCreditMinor-shippingCreditMinor));
  const outstandingMinor=moneyMinor(Math.max(0,commercialDueMinor-netCollectedMinor));
  const refundDueMinor=moneyMinor(Math.max(0,netCollectedMinor-commercialDueMinor));
  const legacyReview=!!(order.legacyFinancialReview?.required && !['resolved','reconciled'].includes(order.legacyFinancialReview?.state)) || active.some(row=>row.holder==='legacy' && row.requiresReconciliation!==false);
  let status;
  if (legacyReview) status='legacy_review';
  else if (refundedMinor>0 && netCollectedMinor===0) status='refunded';
  else if (refundedMinor>0) status='partially_refunded';
  else if (commercialDueMinor===0 && netCollectedMinor===0) status='not_required';
  else if (netCollectedMinor<=0) status='pending';
  else if (outstandingMinor>0) status='partial';
  else status='paid';
  const activeReceipts=activeFacts(settlementReceipts);
  const collectionIds=new Set(collections.map(row=>row.id));
  const settledGrossMinor=sum(activeReceipts,receipt=>sum(receipt.lines || receipt.allocations || [],line=>collectionIds.has(line.collectionId) ? line.grossMinor || 0 : 0));
  const platformCollectedMinor=sum(collections.filter(row=>row.holder==='platform'),row=>collectionSign(row,byId)*Number(row.amountMinor));
  const businessCollectedMinor=sum(collections.filter(row=>row.holder==='business'),row=>collectionSign(row,byId)*Number(row.amountMinor));
  const paymentSummary={status,collectedMinor,refundedMinor,netCollectedMinor,commercialDueMinor,outstandingMinor,refundDueMinor,platformHeldMinor:Math.max(0,platformCollectedMinor-settledGrossMinor),businessReceivedMinor:signedMoney(businessCollectedMinor+settledGrossMinor),legacyReview};
  const returnedByLine=new Map();
  for (const document of returns) for (const line of document.lines || []) {
    const previous=returnedByLine.get(line.lineId) || {quantity:0,recovered:0,unknown:false};
    previous.quantity+=line.quantity;
    if (document.kind==='cancellation') {
      const original=order.items.find(item=>item.lineId===line.lineId);
      if (original?.unitCostMinor!=null) previous.recovered+=original.unitCostMinor*line.quantity;
      else previous.unknown=true;
      returnedByLine.set(line.lineId,previous);
      continue;
    }
    if (line.recoveredCostMinor==null) previous.unknown=true;
    else previous.recovered+=line.recoveredCostMinor;
    returnedByLine.set(line.lineId,previous);
  }
  let knownCostOfGoodsMinor=0,knownGiftCostMinor=0;
  const unknownCostLineIds=[],unknownCostOfGoodsLineIds=[],unknownGiftCostLineIds=[];
  for (const line of order.items) {
    const returned=returnedByLine.get(line.lineId);
    if (line.unitCostMinor==null || returned?.unknown) {
      unknownCostLineIds.push(line.lineId);
      (line.productType==='gift' && line.unitPriceMinor===0 ? unknownGiftCostLineIds : unknownCostOfGoodsLineIds).push(line.lineId);
      continue;
    }
    const retainedCost=moneyMinor(Math.max(0,line.quantity*line.unitCostMinor-(returned?.recovered || 0)));
    if (line.productType==='gift' && line.unitPriceMinor===0) knownGiftCostMinor+=retainedCost;
    else knownCostOfGoodsMinor+=retainedCost;
  }
  const netProductsMinor=signedMoney(order.subtotalMinor-productCreditMinor);
  const shippingRevenueMinor=signedMoney(order.shippingChargeMinor-shippingCreditMinor);
  // A pre-recognition return loss is already represented by retained historical unit cost here.
  // Its expense fact belongs in period reports, not a second time in the accumulated order.
  const linkedExpenses=expenses.filter(row=>!row.sourceKey?.startsWith('return-loss:'));
  const expenseMinor=sum(linkedExpenses,row=>Number(row.amountMinor));
  const contributionExpenseMinor=sum(linkedExpenses.filter(row=>['shipping_out','shipping_return','platform_fee','commission'].includes(row.category)),row=>Number(row.amountMinor));
  const unknownShippingCost=shipments.some(shipment=>shipment.costStatus==='unknown' || shipment.costStatus==null);
  const complete=unknownCostLineIds.length===0 && !unknownShippingCost;
  const knownContributionMinor=signedMoney(netProductsMinor+shippingRevenueMinor-knownCostOfGoodsMinor-knownGiftCostMinor-contributionExpenseMinor);
  const knownResultMinor=signedMoney(netProductsMinor+shippingRevenueMinor-knownCostOfGoodsMinor-knownGiftCostMinor-expenseMinor);
  const financialSummary={label:'Acumulado del pedido',netProductsMinor,shippingRevenueMinor,knownCostOfGoodsMinor,knownGiftCostMinor,costOfGoodsMinor:unknownCostOfGoodsLineIds.length ? null : knownCostOfGoodsMinor,giftCostMinor:unknownGiftCostLineIds.length ? null : knownGiftCostMinor,expenseMinor,knownContributionMinor,contributionMinor:complete ? knownContributionMinor : null,knownResultMinor,resultMinor:complete ? knownResultMinor : null,complete,unknownCostLineIds,unknownCostOfGoodsLineIds,unknownGiftCostLineIds,unknownShippingCost,recognition:order.recognition || null};
  return {paymentSummary,financialSummary};
}

async function associations(tx,ids) {
  if (!ids.length) return new Map();
  const placeholders=ids.map(()=>'?').join(',');
  const result=new Map(ids.map(id=>[id,{shipments:[],collections:[],returns:[],expenses:[],settlementReceipts:[]}]));
  for (const [table,key] of [['shipments','shipments'],['order_collections','collections'],['order_returns','returns']]) {
    const rows=await tx.db.all(`SELECT * FROM ${tx.t(table)} WHERE order_id IN (${placeholders}) ORDER BY id`,ids);
    for (const row of rows) result.get(row.order_id)[key].push(entity(row));
  }
  const expenseRows=await tx.db.all(`SELECT e.*,COALESCE(e.order_id,s.order_id) AS associated_order_id FROM ${tx.t('expenses')} e LEFT JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id WHERE COALESCE(e.order_id,s.order_id) IN (${placeholders}) ORDER BY e.id`,ids);
  for (const {associated_order_id:orderId,...row} of expenseRows) result.get(orderId).expenses.push(entity(row));
  const receiptLines=tx.provider==='sqlite' ? `json_each(sr.data,'$.lines') l` : `jsonb_array_elements(sr.data::jsonb->'lines') l`;
  const collectionId=tx.provider==='sqlite' ? `json_extract(l.value,'$.collectionId')` : `l->>'collectionId'`;
  const receipts=(await tx.db.all(`WITH relevant AS (SELECT DISTINCT sr.id FROM ${tx.t('settlement_receipts')} sr CROSS JOIN ${receiptLines} JOIN ${tx.t('order_collections')} c ON c.id=${collectionId} WHERE c.order_id IN (${placeholders})) SELECT sr.* FROM ${tx.t('settlement_receipts')} sr WHERE sr.id IN (SELECT id FROM relevant) OR sr.reversal_of IN (SELECT id FROM relevant)`,ids)).map(entity);
  for (const value of result.values()) {
    const collectionIds=new Set(value.collections.map(row=>row.id));
    const matching=receipts.filter(receipt=>(receipt.lines || receipt.allocations || []).some(line=>collectionIds.has(line.collectionId)));
    const matchingIds=new Set(matching.map(receipt=>receipt.id));
    value.settlementReceipts=receipts.filter(receipt=>matchingIds.has(receipt.id) || matchingIds.has(receipt.reversalOf));
  }
  return result;
}

export async function getOrder(tx,id,{history=true}={}) {
  const order=await loadOrderData(tx,id);
  if (!order) return null;
  const related=(await associations(tx,[id])).get(id);
  if (history && related.shipments.length) {
    const shipmentById=new Map(related.shipments.map(shipment=>[shipment.id,{...shipment,events:[]}]));
    const events=await tx.db.all(`SELECT e.* FROM ${tx.t('shipment_events')} e JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id WHERE s.order_id=? ORDER BY e.recorded_at,e.id`,[id]);
    for (const row of events) shipmentById.get(row.shipment_id).events.push(entity(row));
    related.shipments=[...shipmentById.values()];
  }
  const result={...order,...related,...orderSummary(order,related)};
  if (history) {
    const events=(await tx.db.all(`SELECT a.*,u.email AS actor_email FROM ${tx.t('order_audit')} a LEFT JOIN ${tx.t('users')} u ON u.id=a.actor_id WHERE a.order_id=? ORDER BY a.created_at,a.id`,[id])).map(row=>({...JSON.parse(row.data),actorId:row.actor_id,actorEmail:row.actor_email || null,createdAt:row.created_at}));
    const legacy=await tx.db.all(`SELECT previous_status AS "previousStatus",next_status AS "nextStatus",actor_id AS "actorId",created_at AS "createdAt" FROM ${tx.t('order_events')} WHERE order_id=? ORDER BY created_at,id`,[id]);
    result.history=[...legacy.map(row=>({...row,legacy:true})),...events.sort((a,b)=>(a.orderVersion || 0)-(b.orderVersion || 0)||a.createdAt.localeCompare(b.createdAt))];
  }
  return result;
}

async function cancelOrder(tx,order,actorId) {
  const sourceKey=`cancel:${order.id}`;
  if (await tx.db.get(`SELECT id FROM ${tx.t('order_returns')} WHERE source_key=?`,[sourceKey])) return;
  const returns=(await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`,[order.id])).map(entity);
  const lines=[];
  for (const line of order.items) {
    const previous=returns.flatMap(row=>row.lines || []).filter(row=>row.lineId===line.lineId);
    const quantity=line.quantity-previous.reduce((total,row)=>total+row.quantity,0);
    if (quantity>0) lines.push({lineId:line.lineId,quantity,salesCreditMinor:moneyMinor(lineNet(line)-sum(previous,row=>row.salesCreditMinor)),condition:'recoverable',recoveredCostMinor:order.recognition?.on && line.unitCostMinor!=null ? moneyMinor(quantity*line.unitCostMinor) : line.unitCostMinor==null ? null : 0});
  }
  const now=stamp(),id=newId();
  const data={lines,shippingCreditMinor:moneyMinor(order.shippingChargeMinor-sum(returns,row=>row.shippingCreditMinor || 0)),closesUnits:true,source:'manual'};
  await insertRow(tx,'order_returns',{id,order_id:order.id,kind:'cancellation',source_key:sourceKey,occurred_on:order.cancellationOn,reason:order.statusReason,version:1,recorded_at:now,created_at:now,updated_at:now,data:JSON.stringify(data)});
  await audit(tx,{entityType:'order_return',entityId:id,actorId,next:{...data,kind:'cancellation',occurredOn:order.cancellationOn},reason:order.statusReason});
  await bumpRevision(tx,[order.recognition?.on,order.cancellationOn]);
}

export async function saveOrderTx(tx,input,actorId,id=null,version=null) {
  if (!input || typeof input!=='object' || Array.isArray(input)) fail('Datos del pedido no válidos.');
  if (id) integer(version,'Versión',1);
  actorId=text(actorId,'Administrador',100,true);
  const requestId=id ? null : text(input.requestId,'Identificador de guardado',100,true);
  if (requestId && !/^[\w-]{16,100}$/.test(requestId)) fail('Identificador de guardado no válido.');
  const payloadHash=hash(input);
  if (requestId) {
    const previous=await tx.db.get(`SELECT * FROM ${tx.t('idempotency')} WHERE key=?`,[requestId]);
    if (previous) {
      if (previous.actor_id!==actorId || previous.payload_hash!==payloadHash) fail('Este intento ya fue guardado con otros datos. Abre el pedido existente o inicia uno nuevo.',409);
      return getOrder(tx,previous.order_id);
    }
  }
  const old=id ? await loadOrderData(tx,id) : null;
  if (id && !old) fail('Pedido no encontrado.',404);
  if (old && old.version!==version) fail('El pedido cambió en otra sesión. Recarga antes de guardar.',409);
  const shipmentRows=id ? await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[id]) : [];
  const dispatched=shipmentRows.some(row=>!['label_created','cancelled','unknown'].includes(row.status));
  const clean=await validateOrder(input,(kind,key)=>tx.get(kind,key),old,{dispatched,snapshotItem:(kind,key,on)=>snapshotCatalogItem(tx,kind,key,on),resolveSeller:key=>getResource(tx,'people',key)});
  const assigned=new Map(),shipmentEntities=shipmentRows.map(entity);
  const replaced=new Set(shipmentEntities.map(shipment=>shipment.replacesShipmentId).filter(Boolean));
  for (const shipment of shipmentEntities) {
    if (shipment.status==='cancelled' || replaced.has(shipment.id)) continue;
    for (const allocation of shipment.assignments || []) assigned.set(allocation.lineId,(assigned.get(allocation.lineId) || 0)+allocation.quantity);
  }
  for (const [lineId,quantity] of assigned) {
    const line=clean.items.find(item=>item.lineId===lineId);
    if (!line || line.quantity<quantity) fail('Actualiza primero la asignación de los envíos vinculados a estas líneas.',409);
  }
  const now=stamp(),key=id || newId();
  let order;
  if (old) {
    order={...old,...clean};
    if (clean.placedOn !== old.placedOn) {
      order.ruleSnapshot=await ruleForOrder(tx,clean.placedOn,clean.sellerId);
      order.policyReviewRequired=!order.ruleSnapshot || Boolean(old.legacyPolicyReview) || Boolean(old.policyReviewRequired && old.dateSource==='legacy_record');
    } else if (clean.sellerId !== old.sellerId && old.ruleSnapshot) {
      const reassignedRule=await ruleForOrder(tx,clean.placedOn,clean.sellerId);
      if (!reassignedRule) fail('Revisa las reglas históricas antes de reasignar el vendedor.',409);
      order.ruleSnapshot={...old.ruleSnapshot,commission:reassignedRule.commission};
    }
    await persistOrderData(tx,order,{actorId,reason:clean.statusReason || input.reason || 'Edición del pedido'});
    order=await loadOrderData(tx,key);
  } else {
    const ruleSnapshot=await ruleForOrder(tx,clean.placedOn,clean.sellerId);
    const orderedQuantity=clean.items.reduce((total,line)=>total+line.quantity,0);
    order={...clean,ruleSnapshot,policyReviewRequired:!ruleSnapshot,recognition:ruleSnapshot?.saleRecognition==='confirmed' ? {on:clean.placedOn,ruleVersionId:ruleSnapshot.id,basis:'confirmed'} : null,dispatchedOn:null,giftCostOn:null,giftDispatches:[],economicLocked:false,deliverySummary:{orderedQuantity,deliveredQuantity:0,datedDeliveredQuantity:0,returnedQuantity:0,partial:false,complete:false}};
    order.inventory=await reconcileInventoryTx(tx,{...order,id:key},{actorId,reason:'Reserva al crear el pedido'});
    await tx.db.run(`UPDATE ${tx.t('counters')} SET value=value+1 WHERE id='orders'`);
    const counter=await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='orders'`);
    await insertRow(tx,'orders',{id:key,number:Number(counter.value),data:JSON.stringify(orderData(order)),created_at:now,updated_at:now});
    await insertRow(tx,'idempotency',{key:requestId,actor_id:actorId,payload_hash:payloadHash,order_id:key});
    await audit(tx,{entityType:'order',entityId:key,actorId,next:economics(orderData(order)),reason:'Creación del pedido'});
    await insertRow(tx,'order_audit',{id:newId(),order_id:key,actor_id:actorId,created_at:now,data:JSON.stringify({orderVersion:1,previousStatus:null,nextStatus:order.status,changedFields:Object.keys(order),reason:'Creación del pedido'})});
    await bumpRevision(tx,[order.placedOn,order.recognition?.on]);
    order=await loadOrderData(tx,key);
  }
  if (old?.status!=='cancelled' && order.status==='cancelled') await cancelOrder(tx,order,actorId);
  await resolveOrderRecognition(tx,key,actorId,{reason:input.reason || clean.statusReason || 'Actualización del pedido'});
  return getOrder(tx,key);
}

export async function saveOrder(store,input,actorId,id=null,version=null) {
  return store.transaction(async tx=>{ await tx.lockWrites(); return saveOrderTx(tx,input,actorId,id,version); });
}

/** Reclassifies historical return loss and logistic expense dates; cash facts never change here. */
export async function reconcileOrderDerivedTx(tx,order,{actorId,reason,source='manual',shipments,eventsByShipment,returns}={}) {
  returns=returns || (await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`,[order.id])).map(entity);
  const expenses=(await tx.db.all(`SELECT * FROM ${tx.t('expenses')} WHERE order_id=? OR (order_id IS NULL AND shipment_id IN (SELECT id FROM ${tx.t('shipments')} WHERE order_id=?))`,[order.id,order.id])).map(entity);
  const bySource=new Map(expenses.filter(expense=>expense.sourceKey).map(expense=>[expense.sourceKey,expense]));
  const returnedQuantities=new Map();
  for (const document of [...returns].sort((a,b)=>a.occurredOn.localeCompare(b.occurredOn)||(a.recordedAt || '').localeCompare(b.recordedAt || '')||a.id.localeCompare(b.id))) {
    const nextLines=[];
    for (const returned of document.lines || []) {
      const line=order.items.find(item=>item.lineId===returned.lineId);
      if (!line) fail('La devolución contiene una línea ajena al pedido.');
      const freeGift=line.productType==='gift' && line.unitPriceMinor===0;
      const dispatchedQuantity=freeGift ? (order.giftDispatches || []).filter(fact=>fact.lineId===line.lineId && fact.on<=document.occurredOn).reduce((quantity,fact)=>quantity+fact.quantity,0) : 0;
      const recognizedCostQuantity=freeGift ? Math.min(returned.quantity,Math.max(0,dispatchedQuantity-(returnedQuantities.get(line.lineId) || 0))) : order.recognition?.on && order.recognition.on<=document.occurredOn ? returned.quantity : 0;
      const unrecognizedCostQuantity=returned.quantity-recognizedCostQuantity;
      returnedQuantities.set(line.lineId,(returnedQuantities.get(line.lineId) || 0)+returned.quantity);
      const known=line.unitCostMinor!=null;
      const recoveredCostMinor=returned.condition==='non_recoverable' ? 0 : known ? moneyMinor(line.unitCostMinor*(document.kind==='cancellation' ? recognizedCostQuantity : returned.quantity)) : null;
      nextLines.push({...returned,recoveredCostMinor,recognizedCostQuantity,unrecognizedCostQuantity});
      const sourceKey=`return-loss:${document.id}:${line.lineId}`,previous=bySource.get(sourceKey);
      const lossPending=!known && unrecognizedCostQuantity>0 && document.kind!=='cancellation';
      const amountMinor=known && unrecognizedCostQuantity>0 && document.kind!=='cancellation' && returned.condition==='non_recoverable' ? moneyMinor(line.unitCostMinor*unrecognizedCostQuantity) : 0;
      const metadata={returnId:document.id,lineId:line.lineId,costPending:lossPending,dateSource:'return_date'};
      if (previous && (previous.amountMinor!==amountMinor || previous.incurredOn!==document.occurredOn || previous.costPending!==lossPending)) {
        await updateVersioned(tx,'expenses',previous.id,previous.version,{amount_minor:amountMinor,incurred_on:document.occurredOn,data:JSON.stringify(metadata)});
        await audit(tx,{entityType:'expense',entityId:previous.id,actorId,previous,next:{...previous,...metadata,amountMinor,incurredOn:document.occurredOn},reason,source});
        await bumpRevision(tx,[previous.incurredOn,document.occurredOn]);
      } else if (!previous && amountMinor>0) {
        const id=newId(),now=stamp();
        await insertRow(tx,'expenses',{id,category:'other',amount_minor:amountMinor,incurred_on:document.occurredOn,person_id:null,order_id:order.id,shipment_id:null,source_key:sourceKey,version:1,recorded_at:now,created_at:now,updated_at:now,data:JSON.stringify(metadata)});
        await audit(tx,{entityType:'expense',entityId:id,actorId,next:{...metadata,amountMinor,incurredOn:document.occurredOn},reason,source});
        await bumpRevision(tx,[document.occurredOn]);
      }
    }
    if (hash(nextLines)!==hash(document.lines || [])) {
      const metadata=pick(document,Object.keys(document).filter(key=>!['id','orderId','occurredOn','reason','kind','sourceKey','version','recordedAt','createdAt','updatedAt'].includes(key)));
      metadata.lines=nextLines;
      await updateVersioned(tx,'order_returns',document.id,document.version,{data:JSON.stringify(metadata)});
      await audit(tx,{entityType:'order_return',entityId:document.id,actorId,previous:{lines:document.lines},next:{lines:nextLines},reason,source});
      await bumpRevision(tx,[document.occurredOn]);
    }
  }
  if (!shipments || !eventsByShipment) return;
  for (const expense of expenses) {
    if (!expense.shipmentId || !['shipping_out','shipping_return'].includes(expense.category)) continue;
    const rule=order.ruleSnapshot;
    const policy=expense.category==='shipping_out' ? rule?.shippingExpenseDate : rule?.returnExpenseDate;
    if (!['dispatch_date','returned_date'].includes(policy)) continue;
    const dates=(eventsByShipment.get(expense.shipmentId) || []).filter(event=>event.status===(policy==='dispatch_date' ? 'collected' : 'returned')).map(eventOn).filter(Boolean).sort();
    const incurredOn=dates[0] || null;
    if (incurredOn===expense.incurredOn && expense.dateSource===policy) continue;
    const metadata=pick(expense,Object.keys(expense).filter(key=>!['id','category','amountMinor','incurredOn','personId','orderId','shipmentId','sourceKey','version','recordedAt','createdAt','updatedAt'].includes(key)));
    metadata.dateSource=policy;
    await updateVersioned(tx,'expenses',expense.id,expense.version,{incurred_on:incurredOn,data:JSON.stringify(metadata)});
    await audit(tx,{entityType:'expense',entityId:expense.id,actorId,previous:expense,next:{...expense,incurredOn,dateSource:policy},reason,source});
    await bumpRevision(tx,[expense.incurredOn,incurredOn]);
  }
}

/** Called inside the shipment command transaction; never opens or commits a transaction. */
export async function resolveOrderRecognition(tx,orderId,actorId,{reason='Actualización de evidencia logística',source='manual',adjustmentOn=null,historicalCorrection=false}={}) {
  const order=await loadOrderData(tx,orderId);
  if (!order) fail('Pedido no encontrado.',404);
  const shipments=(await tx.db.all(`SELECT * FROM ${tx.t('shipments')} WHERE order_id=?`,[orderId])).map(entity);
  const rows=await tx.db.all(`SELECT e.* FROM ${tx.t('shipment_events')} e JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id WHERE s.order_id=?`,[orderId]);
  const grouped=new Map(shipments.map(shipment=>[shipment.id,[]]));
  for (const row of rows) grouped.get(row.shipment_id).push(entity(row));
  const eventsByShipment=new Map([...grouped].map(([id,events])=>[id,effectiveShipmentEvents(events)]));
  const allEvents=[...eventsByShipment.values()].flat();
  const dispatchDates=allEvents.filter(event=>event.status==='collected').map(eventOn).filter(Boolean).sort();
  const dispatchedOn=dispatchDates[0] || null;
  const observedDispatch=allEvents.some(event=>['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned'].includes(event.status));
  const replaced=new Set(shipments.map(shipment=>shipment.replacesShipmentId).filter(Boolean));
  const deliveredByLine=new Map(), datedDeliveredByLine=new Map();
  let deliveredOn=null;
  for (const shipment of shipments) {
    if (replaced.has(shipment.id) || shipment.status==='cancelled') continue;
    const events=(eventsByShipment.get(shipment.id) || []).filter(event=>event.status==='delivered');
    // A real later return does not erase delivery. Only correctionOf removes false evidence.
    const delivered=events.find(event=>eventOn(event)) || events[0];
    if (!delivered) continue;
    const on=eventOn(delivered);
    if (on) deliveredOn=!deliveredOn || on>deliveredOn ? on : deliveredOn;
    for (const allocation of shipment.assignments || []) {
      deliveredByLine.set(allocation.lineId,(deliveredByLine.get(allocation.lineId) || 0)+allocation.quantity);
      if (on) datedDeliveredByLine.set(allocation.lineId,(datedDeliveredByLine.get(allocation.lineId) || 0)+allocation.quantity);
    }
  }
  const orderedQuantity=order.items.reduce((total,line)=>total+line.quantity,0);
  const deliveredQuantity=order.items.reduce((total,line)=>total+Math.min(line.quantity,deliveredByLine.get(line.lineId) || 0),0);
  const datedDeliveredQuantity=order.items.reduce((total,line)=>total+Math.min(line.quantity,datedDeliveredByLine.get(line.lineId) || 0),0);
  const returns=(await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`,[orderId])).map(entity);
  const returnedQuantity=returns.filter(row=>row.kind==='return').reduce((total,row)=>total+(row.lines || []).reduce((n,line)=>n+line.quantity,0),0);
  const complete=deliveredQuantity===orderedQuantity;
  const basis=!order.policyReviewRequired && !order.legacyPolicyReview ? order.ruleSnapshot?.saleRecognition : null;
  let recognition=null;
  if (basis==='confirmed' && order.placedOn) recognition={on:order.placedOn,ruleVersionId:order.ruleSnapshot.id,basis};
  else if (basis==='dispatched' && dispatchedOn) recognition={on:dispatchedOn,ruleVersionId:order.ruleSnapshot.id,basis};
  else if (basis==='delivered' && datedDeliveredQuantity===orderedQuantity && deliveredOn) recognition={on:deliveredOn,ruleVersionId:order.ruleSnapshot.id,basis};
  let status=order.status;
  if (status!=='cancelled') {
    if (returnedQuantity===orderedQuantity) status='returned';
    else if (complete) status='delivered';
    else if (observedDispatch) status='sent';
    else if (['sent','delivered','returned'].includes(status)) status='preparing';
  }
  const giftIds=new Set(order.items.filter(line=>line.productType==='gift' && line.unitPriceMinor===0).map(line=>line.lineId));
  const giftObservations=shipments.flatMap(shipment=>{
    const collected=(eventsByShipment.get(shipment.id) || []).find(event=>event.status==='collected' && eventOn(event));
    if (!collected) return [];
    return (shipment.assignments || []).filter(line=>giftIds.has(line.lineId)).map(line=>({...line,on:eventOn(collected),shipmentId:shipment.id,eventId:collected.id}));
  }).sort((a,b)=>a.on.localeCompare(b.on)||a.shipmentId.localeCompare(b.shipmentId)||a.lineId.localeCompare(b.lineId));
  const remainingGiftQuantities=new Map(order.items.filter(line=>giftIds.has(line.lineId)).map(line=>[line.lineId,line.quantity]));
  const giftDispatches=[];
  for (const observation of giftObservations) {
    const quantity=Math.min(observation.quantity,remainingGiftQuantities.get(observation.lineId));
    if (quantity>0) giftDispatches.push({...observation,quantity});
    remainingGiftQuantities.set(observation.lineId,remainingGiftQuantities.get(observation.lineId)-quantity);
  }
  const giftCostOn=giftDispatches[0]?.on || null;
  const next={...order,status,recognition,dispatchedOn,giftCostOn,giftDispatches,economicLocked:order.economicLocked || observedDispatch || ['cancelled','returned'].includes(status),deliverySummary:{orderedQuantity,deliveredQuantity,datedDeliveredQuantity,returnedQuantity,partial:deliveredQuantity>0 && !complete,complete}};
  next.inventory=await reconcileInventoryTx(tx,next,{shipments,eventsByShipment,returns,actorId,reason,source});
  await reconcileOrderDerivedTx(tx,next,{actorId,reason,source,shipments,eventsByShipment,returns});
  const result=hash(orderData(next))===hash(orderData(order)) ? order : await persistOrderData(tx,next,{actorId,reason,source});
  await reconcileCommissionsTx(tx,orderId,{actorId,reason,adjustmentOn:adjustmentOn || (next.status==='cancelled' ? next.cancellationOn : null),historicalCorrection,previousRecognitionOn:order.recognition?.on || null});
  return result;
}

export async function pageOrders(tx,filters={}) {
  const page=integer(filters.page ?? 1,'Página',1,100000), q=text(filters.q || '','Búsqueda',100);
  const conditions=[],values=[];
  const json=(alias,field)=>tx.provider==='sqlite' ? `json_extract(${alias}.data,'$.${field}')` : `(${alias}.data::jsonb->>'${field}')`;
  if (filters.status) { conditions.push(`${json('o','status')}=?`); values.push(text(filters.status,'Estado',50)); }
  if (filters.seller || filters.sellerId) { conditions.push(`${json('o','sellerId')}=?`); values.push(text(filters.seller || filters.sellerId,'Vendedor',100)); }
  const shipmentConditions=[];
  for (const [filter,column] of [['platform','platform_id'],['source','source_id'],['carrier','carrier']]) if (filters[filter]) { shipmentConditions.push(`s.${column}=?`); values.push(text(filters[filter],filter,150)); }
  if (shipmentConditions.length) conditions.push(`EXISTS(SELECT 1 FROM ${tx.t('shipments')} s WHERE s.order_id=o.id AND ${shipmentConditions.join(' AND ')})`);
  if (filters.product) {
    const product=tx.provider==='sqlite' ? `EXISTS(SELECT 1 FROM json_each(o.data,'$.items') i WHERE json_extract(i.value,'$.itemId')=? OR EXISTS(SELECT 1 FROM json_each(i.value,'$.components') c WHERE json_extract(c.value,'$.productId')=?))` : `EXISTS(SELECT 1 FROM jsonb_array_elements(o.data::jsonb->'items') i WHERE i->>'itemId'=? OR EXISTS(SELECT 1 FROM jsonb_array_elements(i->'components') c WHERE c->>'productId'=?))`;
    const id=text(filters.product,'Producto',100);
    conditions.push(product); values.push(id,id);
  }
  if (q) {
    if (filters.lookup === 'identity') {
      conditions.push(`(CAST(o.number AS TEXT)=? OR EXISTS(SELECT 1 FROM ${tx.t('shipments')} s WHERE s.order_id=o.id AND s.tracking=?))`);
      values.push(q.replace(/^AN-0*/i,''),q);
    } else {
      const pattern=`%${q.toLowerCase().replace(/[!%_]/g,ch=>'!'+ch)}%`;
      conditions.push(`(LOWER(${json('o','customerName')}) LIKE ? ESCAPE '!' OR ${json('o','phone')} LIKE ? ESCAPE '!' OR CAST(o.number AS TEXT)=? OR EXISTS(SELECT 1 FROM ${tx.t('shipments')} s WHERE s.order_id=o.id AND LOWER(s.tracking) LIKE ? ESCAPE '!'))`);
      values.push(pattern,pattern,q.replace(/^AN-0*/i,''),pattern);
    }
  }
  const creditLines=tx.provider==='sqlite' ? `(SELECT COALESCE(SUM(CAST(json_extract(l.value,'$.salesCreditMinor') AS BIGINT)),0) FROM json_each(r.data,'$.lines') l)` : `(SELECT COALESCE(SUM((l->>'salesCreditMinor')::bigint),0) FROM jsonb_array_elements(r.data::jsonb->'lines') l)`;
  const numeric=(alias,field)=>`COALESCE(CAST(${json(alias,field)} AS BIGINT),0)`;
  const review=tx.provider==='sqlite' ? `(COALESCE(json_extract(o.data,'$.legacyFinancialReview.required'),0)=1 AND COALESCE(json_extract(o.data,'$.legacyFinancialReview.state'),'pending') NOT IN ('resolved','reconciled'))` : `(COALESCE(o.data::jsonb#>>'{legacyFinancialReview,required}','false')='true' AND COALESCE(o.data::jsonb#>>'{legacyFinancialReview,state}','pending') NOT IN ('resolved','reconciled'))`;
  const legacyCollectionPending=tx.provider==='sqlite' ? `COALESCE(json_extract(c.data,'$.requiresReconciliation'),1)<>0` : `COALESCE(c.data::jsonb->>'requiresReconciliation','true')<>'false'`;
  const base=`WITH facts AS (SELECT o.*,${numeric('o','totalMinor')} AS agreed_minor,
    COALESCE((SELECT SUM(CASE WHEN c.kind='refund' OR (c.kind='reversal' AND original.kind='receipt') THEN -c.amount_minor ELSE c.amount_minor END) FROM ${tx.t('order_collections')} c LEFT JOIN ${tx.t('order_collections')} original ON original.id=c.reversal_of WHERE c.order_id=o.id),0) AS collected_minor,
    COALESCE((SELECT SUM(c.amount_minor) FROM ${tx.t('order_collections')} c WHERE c.order_id=o.id AND c.kind='refund' AND NOT EXISTS(SELECT 1 FROM ${tx.t('order_collections')} rev WHERE rev.reversal_of=c.id)),0) AS refunded_minor,
    COALESCE((SELECT SUM(${creditLines}+${numeric('r','shippingCreditMinor')}) FROM ${tx.t('order_returns')} r WHERE r.order_id=o.id),0) AS credit_minor,
    CASE WHEN ${review} OR EXISTS(SELECT 1 FROM ${tx.t('order_collections')} c WHERE c.order_id=o.id AND c.holder='legacy' AND c.kind='receipt' AND ${legacyCollectionPending} AND NOT EXISTS(SELECT 1 FROM ${tx.t('order_collections')} rev WHERE rev.reversal_of=c.id)) THEN 1 ELSE 0 END AS legacy_review
    FROM ${tx.t('orders')} o${conditions.length ? ' WHERE '+conditions.join(' AND ') : ''}), summary AS (SELECT facts.*,CASE WHEN agreed_minor-credit_minor>0 THEN agreed_minor-credit_minor ELSE 0 END AS due_minor FROM facts), filtered AS (SELECT summary.*,CASE WHEN legacy_review=1 THEN 'legacy_review' WHEN refunded_minor>0 AND collected_minor=0 THEN 'refunded' WHEN refunded_minor>0 THEN 'partially_refunded' WHEN due_minor=0 AND collected_minor=0 THEN 'not_required' WHEN collected_minor<=0 THEN 'pending' WHEN collected_minor<due_minor THEN 'partial' ELSE 'paid' END AS payment_state FROM summary)`;
  const extra=[],extraValues=[];
  if (filters.paymentStatus) { extra.push('payment_state=?'); extraValues.push(text(filters.paymentStatus,'Estado del cobro',50)); }
  if (filters.issue) {
    const issue=text(filters.issue,'Pendiente',100);
    const costMissing=tx.provider==='sqlite' ? `EXISTS(SELECT 1 FROM json_each(filtered.data,'$.items') i WHERE json_extract(i.value,'$.unitCostMinor') IS NULL)` : `EXISTS(SELECT 1 FROM jsonb_array_elements(filtered.data::jsonb->'items') i WHERE i->>'unitCostMinor' IS NULL)`;
    const platformNet=`COALESCE((SELECT SUM(CASE WHEN c.kind='refund' OR (c.kind='reversal' AND original.kind='receipt') THEN -c.amount_minor ELSE c.amount_minor END) FROM ${tx.t('order_collections')} c LEFT JOIN ${tx.t('order_collections')} original ON original.id=c.reversal_of WHERE c.order_id=filtered.id AND c.holder='platform'),0)`;
    const receiptLines=tx.provider==='sqlite' ? `json_each(sr.data,'$.lines') l` : `jsonb_array_elements(sr.data::jsonb->'lines') l`;
    const lineCollection=tx.provider==='sqlite' ? `json_extract(l.value,'$.collectionId')` : `l->>'collectionId'`;
    const lineGross=tx.provider==='sqlite' ? `json_extract(l.value,'$.grossMinor')` : `(l->>'grossMinor')::bigint`;
    const settledGross=`COALESCE((SELECT SUM(${lineGross}) FROM ${tx.t('settlement_receipts')} sr CROSS JOIN ${receiptLines} JOIN ${tx.t('order_collections')} c ON c.id=${lineCollection} WHERE c.order_id=filtered.id AND sr.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ${tx.t('settlement_receipts')} rev WHERE rev.reversal_of=sr.id)),0)`;
    const issues={missing_cost:costMissing,missing_data:`(${costMissing} OR legacy_review=1 OR ${json('filtered','policyReviewRequired')} ${tx.provider==='sqlite' ? '=1' : "='true'"})`,legacy_review:'legacy_review=1',incident:`EXISTS(SELECT 1 FROM ${tx.t('shipments')} s WHERE s.order_id=filtered.id AND s.status IN ('incident','return_in_transit'))`,pending_settlement:`${platformNet}>${settledGross}`};
    if (!issues[issue]) fail('Filtro de pendientes no válido.');
    extra.push(issues[issue]);
  }
  const where=extra.length ? ' WHERE '+extra.join(' AND ') : '';
  const params=[...values,...extraValues];
  const total=Number((await tx.db.get(`${base} SELECT COUNT(*) AS count FROM filtered${where}`,params)).count);
  const rows=await tx.db.all(`${base} SELECT * FROM filtered${where} ORDER BY number DESC LIMIT 20 OFFSET ?`,[...params,(page-1)*20]);
  const related=await associations(tx,rows.map(row=>row.id));
  const records=rows.map(row=>{
    const order={...orderData(JSON.parse(row.data)),id:row.id,number:Number(row.number),version:Number(row.version),createdAt:row.created_at,updatedAt:row.updated_at};
    const links=related.get(order.id), summaries=orderSummary(order,links);
    return {id:order.id,number:order.number,version:order.version,createdAt:order.createdAt,updatedAt:order.updatedAt,customerName:order.customerName,city:order.city,placedOn:order.placedOn,sellerId:order.sellerId,status:order.status,totalMinor:order.totalMinor,deliverySummary:order.deliverySummary,shipments:links.shipments.map(({id,status,carrier,tracking,platformId,sourceId})=>({id,status,carrier,tracking,platformId,sourceId})),...summaries};
  });
  return {records,total,page,pageSize:20};
}
