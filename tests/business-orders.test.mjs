import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { saveBusinessSettings, getBusinessSettings, saveResource } from '../lib/business/settings.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { loadOrderData, persistOrderData, saveOrderTx, orderSummary, resolveOrderRecognition } from '../lib/business/orders.mjs';
import { insertRow, stamp, bumpRevision } from '../lib/business/commands.mjs';

const actor='order-test-admin';
const newRequest=()=>randomUUID();
const product=(slug,extra={})=>({title:slug,slug,status:'draft',orderable:true,price:55000,presentation:'Unidad',stockQuantity:10000,unitCostMinor:2300000,costEffectiveOn:'2026-01-01',...extra});
const line=(item,extra={})=>({lineId:randomUUID(),kind:'products',itemId:item.id,quantity:1,unitPriceMinor:item.price*100,discountMinor:0,...extra});
const input=(item,extra={})=>({requestId:newRequest(),customerName:'Destinatario de prueba',phone:'3001234567',department:'Bogotá',city:'Bogotá',address:'Dirección sintética',placedOn:'2026-09-01',sellerId:null,status:'new',deliveryMethod:'carrier',shippingChargeMinor:1200000,items:[line(item)],...extra});
const sqliteFactory=()=>openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
async function configure(store,basis='delivered') {
  const settings=await getBusinessSettings(store);
  return saveBusinessSettings(store,{...settings,requestId:newRequest(),rulesVersions:[{id:'historical-september',effectiveOn:'2026-01-01',saleRecognition:basis,commission:{enabled:false},shippingExpenseDate:'dispatch_date',returnExpenseDate:'returned_date'}]},actor);
}
async function setup(store,basis='delivered') {
  await configure(store,basis);
  const a=await store.save('products',product('a'));
  const b=await store.save('products',product('b',{price:10000,unitCostMinor:300000}));
  const gift=await store.save('products',product('gift',{productType:'gift',price:0,unitCostMinor:null,items:[{productId:b.id,quantity:2}]}));
  return {a,b,gift};
}
async function event(store,shipment,status,occurredOn,extra={}) {
  return recordShipmentEvent(store,shipment.id,{requestId:newRequest(),version:shipment.version,status,occurredOn,...extra},actor);
}
async function mutateFacts(store,fn) {
  return store.transaction(async tx=>{await tx.lockWrites();const result=await fn(tx);await bumpRevision(tx);return result;});
}
async function collection(tx,order,{id=newRequest(),kind='receipt',holder='business',amountMinor,occurredOn='2026-09-03',reversalOf=null,...data}) {
  await insertRow(tx,'order_collections',{id,order_id:order.id,shipment_id:null,kind,holder,amount_minor:amountMinor,occurred_on:occurredOn,cash_entry_id:null,reversal_of:reversalOf,external_key:null,recorded_at:stamp(),data:JSON.stringify(data)});
  return id;
}
async function returnFact(tx,order,{id=newRequest(),occurredOn='2026-09-04',quantity=1,condition='non_recoverable',recoveredCostMinor=0,salesCreditMinor,shippingCreditMinor=0}={}) {
  const now=stamp();
  await insertRow(tx,'order_returns',{id,order_id:order.id,kind:'return',source_key:null,occurred_on:occurredOn,reason:'Devolución de prueba',version:1,recorded_at:now,created_at:now,updated_at:now,data:JSON.stringify({lines:[{lineId:order.items[0].lineId,quantity,condition,recoveredCostMinor,salesCreditMinor:salesCreditMinor ?? order.items[0].unitPriceMinor*quantity}],shippingCreditMinor})});
  return id;
}

// Export the same contracts so the integration owner can exercise them with the guarded PG fixture.
export const businessOrderContracts=[
  ['snapshots historical costs/composition, discounts and public pesos exactly once',async store=>{
    const {a,b,gift}=await setup(store);
    const order=await store.saveOrder(input(a,{totalMinor:1,subtotalMinor:1,items:[line(a,{quantity:2,discountMinor:100000}),line(gift)]}),actor);
    assert.equal(order.version,1);
    assert.equal(order.subtotalMinor,10900000);
    assert.equal(order.totalMinor,12100000);
    assert.equal(order.items[0].unitCostMinor,2300000);
    assert.equal(order.items[1].unitCostMinor,600000);
    assert.equal(order.items[1].components[0].quantity,2);
    assert.equal(order.items[1].components[0].unitCostMinor,300000);
    assert.equal(order.financialSummary.costOfGoodsMinor,4600000);
    assert.equal(order.financialSummary.giftCostMinor,600000);
    assert.equal(order.financialSummary.contributionMinor,6900000);
    assert.equal(order.ruleSnapshot.id,'historical-september');
    const currentB=await store.get('products',b.id);
    await store.save('products',{...currentB,title:'Nombre cambiado',unitCostMinor:700000,costEffectiveOn:'2026-10-01'},b.id,currentB.version);
    const edited=await store.saveOrder({...order,notes:'Solo una nota',items:order.items.map(item=>({...item,title:'Título no confiable',unitCostMinor:0,components:[]}))},actor,order.id,order.version);
    assert.equal(edited.items[1].unitCostMinor,600000);
    assert.equal(edited.items[1].components[0].title,'b');
    assert.equal((await store.get('products',a.id)).price,55000);
  }],
  ['rejects invalid money, quantities, dates, counterfeit gifts and actor-as-seller',async store=>{
    const {a}=await setup(store),valid=input(a);
    for (const patch of [{quantity:0},{quantity:1000},{quantity:1.5},{unitPriceMinor:0,productType:'gift'},{unitPriceMinor:10000000000001},{unitPriceMinor:Number.MAX_SAFE_INTEGER},{discountMinor:-1},{discountMinor:5500001},{unitPriceMinor:1.5}]) {
      await assert.rejects(store.saveOrder({...valid,requestId:newRequest(),items:[{...valid.items[0],...patch}]},actor),{status:400});
    }
    await assert.rejects(store.saveOrder({...valid,placedOn:null},actor),{status:400});
    await assert.rejects(store.saveOrder({...valid,placedOn:'2026-02-30'},actor),{status:400});
    await assert.rejects(store.saveOrder({...valid,sellerId:actor},actor),{status:400});
    const seller=await saveResource(store,'people',{requestId:newRequest(),name:'Vendedor real'},actor);
    const order=await store.saveOrder({...valid,sellerId:seller.id},actor);
    assert.equal(order.sellerId,seller.id);
    await assert.rejects(store.saveOrder({...order,placedOn:''},actor,order.id,order.version),{status:400});
  }],
  ['seller names stay historical and an explicit reassignment uses the new seller commission',async store=>{
    const {a}=await setup(store,'confirmed');
    const override=rateBps=>({effectiveOn:'2026-01-01',enabled:true,mode:'percent',rateBps,earnWhen:'customer_paid'});
    const first=await saveResource(store,'people',{requestId:newRequest(),name:'Nombre histórico',commissionOverrides:[override(500)]},actor);
    const second=await saveResource(store,'people',{requestId:newRequest(),name:'Vendedora nueva',commissionOverrides:[override(1500)]},actor);
    let order=await store.saveOrder(input(a,{sellerId:first.id}),actor);
    await saveResource(store,'people',{...first,requestId:newRequest(),name:'Nombre posterior'},actor,first.id);
    order=await store.saveOrder({...order,notes:'Solo una nota',sellerSnapshot:{id:first.id,name:'Nombre falso',version:99}},actor,order.id,order.version);
    assert.equal(order.sellerSnapshot.name,'Nombre histórico');
    order=await store.saveOrder({...order,sellerId:second.id},actor,order.id,order.version);
    assert.equal(order.sellerSnapshot.name,'Vendedora nueva');
    assert.equal(order.ruleSnapshot.commission.rateBps,1500);
    const account=await saveAccount(store,{requestId:newRequest(),name:'Banco de comisión',type:'bank',openingOn:'2026-09-01',openingBalanceMinor:0,responsibleId:second.id},actor);
    await recordCollection(store,{requestId:newRequest(),orderId:order.id,version:order.version,holder:'business',accountId:account.id,amountMinor:order.totalMinor,occurredOn:'2026-09-03',method:'Transferencia',reference:'SELLER-REASSIGNMENT'},actor);
    const earned=await store.db.all(`SELECT person_id,amount_minor FROM ${store.t('commission_entries')}`);
    assert.deepEqual(earned.map(row=>({personId:row.person_id,amountMinor:row.amount_minor})),[{personId:second.id,amountMinor:825000}]);
  }],
  ['an explicit commercial date correction selects that date rule without recosting historical lines',async store=>{
    const {a}=await setup(store);
    let order=await store.saveOrder(input(a),actor);
    const settings=await getBusinessSettings(store);
    await saveBusinessSettings(store,{...settings,requestId:newRequest(),rulesVersions:[...settings.rulesVersions,{id:'october-confirmed',effectiveOn:'2026-10-01',saleRecognition:'confirmed',commission:{enabled:false}}]},actor);
    order=await store.saveOrder({...order,placedOn:'2026-10-01'},actor,order.id,order.version);
    assert.equal(order.recognition.on,'2026-10-01');
    assert.equal(order.recognition.ruleVersionId,'october-confirmed');
    assert.equal(order.items[0].unitCostMinor,2300000);
    assert.equal(order.totalMinor,6700000);
  }],
  ['distinguishes unknown and explicit zero costs and a completely free gift order',async store=>{
    const {a,b,gift}=await setup(store);
    const unknown=await store.save('products',{...a,unitCostMinor:null},a.id,a.version);
    const missing=await store.saveOrder(input(unknown),actor);
    assert.equal(missing.items[0].unitCostMinor,null);
    assert.equal(missing.financialSummary.complete,false);
    assert.equal(missing.financialSummary.resultMinor,null);
    assert.equal(missing.financialSummary.giftCostMinor,0);
    const currentUnknown=await store.get('products',unknown.id);
    const zero=await store.save('products',{...currentUnknown,unitCostMinor:0},unknown.id,currentUnknown.version);
    const known=await store.saveOrder(input(zero),actor);
    assert.equal(known.items[0].unitCostMinor,0);
    assert.equal(known.financialSummary.complete,true);
    await store.save('products',{...b,unitCostMinor:null},b.id,b.version);
    const free=await store.saveOrder(input(gift,{shippingChargeMinor:0,items:[line(gift)]}),actor);
    assert.equal(free.totalMinor,0);
    assert.equal(free.paymentSummary.status,'not_required');
    assert.equal(free.paymentSummary.netCollectedMinor,0);
    assert.equal(free.items[0].unitCostMinor,null);
    assert.equal(free.financialSummary.complete,false);
    assert.equal(free.collections.length,0);
  }],
  ['preserves snapshots and permits notes on archived or unavailable old references',async store=>{
    const {a}=await setup(store),order=await store.saveOrder(input(a),actor);
    const current=await store.get('products',a.id);
    await store.save('products',{...current,orderable:false,status:'archived',title:'Otro título'},a.id,current.version);
    const saved=await store.saveOrder({...order,notes:'Conservar operación histórica'},actor,order.id,order.version);
    assert.equal(saved.items[0].title,'a');
    assert.equal(saved.items[0].unitCostMinor,2300000);
    await assert.rejects(store.saveOrder(input(a),actor),{status:400});
    await assert.rejects(store.saveOrder({...saved,items:[{...saved.items[0],quantity:2}]},actor,saved.id,saved.version),{status:400});
  }],
  ['canonical creation idempotency remains actor-bound and optimistic updates conflict',async store=>{
    const {a}=await setup(store),payload=input(a);
    const order=await store.saveOrder(payload,actor);
    const reordered=Object.fromEntries(Object.entries(payload).reverse());
    reordered.items=payload.items.map(item=>Object.fromEntries(Object.entries(item).reverse()));
    assert.equal((await store.saveOrder(reordered,actor)).id,order.id);
    await assert.rejects(store.saveOrder(payload,'another-admin'),{status:409});
    await assert.rejects(store.saveOrder({...payload,city:'Otra ciudad'},actor),{status:409});
    const updated=await store.saveOrder({...order,notes:'Primera edición'},actor,order.id,order.version);
    assert.equal(updated.version,order.version+1);
    await assert.rejects(store.saveOrder({...order,notes:'Edición obsoleta'},actor,order.id,order.version),{status:409});
    assert.equal((await store.orders()).length,1);
  }],
  ['dispatched economics freeze while recipient notes remain editable and DTOs never persist',async store=>{
    const {a}=await setup(store),order=await store.saveOrder(input(a),actor);
    await assert.rejects(store.saveOrder({...order,status:'sent'},actor,order.id,order.version),{status:409});
    let shipment=await createShipment(store,{requestId:newRequest(),orderId:order.id},actor);
    shipment=await event(store,shipment,'collected','2026-09-02');
    const dispatched=await store.order(order.id);
    for (const changed of [{shippingChargeMinor:0},{items:[{...dispatched.items[0],quantity:2}]},{items:[{...dispatched.items[0],discountMinor:1}]},{status:'cancelled',cancellationOn:'2026-09-03',statusReason:'No permitido'}]) {
      await assert.rejects(store.saveOrder({...dispatched,...changed},actor,order.id,dispatched.version),{status:409});
    }
    const saved=await store.saveOrder({...dispatched,notes:'Nota del destinatario',history:[{bad:true}],paymentSummary:{status:'paid'},financialSummary:{complete:true}},actor,order.id,dispatched.version);
    assert.equal(saved.paymentSummary.status,'pending');
    const raw=JSON.parse((await store.db.get(`SELECT data FROM ${store.t('orders')} WHERE id=?`,[order.id])).data);
    for (const key of ['history','shipments','collections','returns','paymentSummary','financialSummary','settlementReceipts','expenses']) assert.equal(Object.hasOwn(raw,key),false);
    assert.equal(saved.shipments[0].events[0].status,'collected');
    assert.ok(saved.history.length>=3);
    await mutateFacts(store,async tx=>{
      const data=await loadOrderData(tx,order.id);
      await persistOrderData(tx,{...data,shipments:[{bad:true}],history:[{bad:true}],notes:'Interna'},{actorId:actor,reason:'Actualización interna'});
    });
    const businessAudit=await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='order' AND entity_id=?`,[order.id]);
    assert.ok(businessAudit.some(row=>JSON.parse(row.data).previous?.items));
    assert.ok(businessAudit.every(row=>!Object.hasOwn(JSON.parse(row.data).next || {},'documentNumber')));
  }],
  ['delivered recognition requires complete actual quantities and corrections move or remove dates',async store=>{
    const {a}=await setup(store),order=await store.saveOrder(input(a,{items:[line(a,{quantity:2})]}),actor);
    let first=await createShipment(store,{requestId:newRequest(),orderId:order.id,assignments:[{lineId:order.items[0].lineId,quantity:1}]},actor);
    let second=await createShipment(store,{requestId:newRequest(),orderId:order.id,assignments:[{lineId:order.items[0].lineId,quantity:1}]},actor);
    first=await event(store,first,'collected','2026-09-02');
    first=await event(store,first,'delivered','2026-09-03');
    assert.equal((await store.order(order.id)).recognition,null);
    assert.equal((await store.order(order.id)).deliverySummary.partial,true);
    second=await event(store,second,'delivered',null,{sourceAsOf:'2026-09-04T12:00:00.000Z'});
    const unknownDate=await store.order(order.id);
    assert.equal(unknownDate.status,'delivered');
    assert.equal(unknownDate.recognition,null);
    const observed=second.events.find(row=>row.status==='delivered');
    second=await event(store,second,'delivered','2026-09-05',{correctionOf:observed.id,reason:'Fecha real confirmada'});
    assert.equal((await store.order(order.id)).recognition.on,'2026-09-05');
    const actual=second.events.find(row=>row.correctionOf===observed.id);
    second=await event(store,second,'delivered','2026-10-01',{correctionOf:actual.id,reason:'Fecha estaba en mes equivocado'});
    assert.equal((await store.order(order.id)).recognition.on,'2026-10-01');
    const moved=second.events.find(row=>row.correctionOf===actual.id);
    await event(store,second,'unknown','2026-10-01',{correctionOf:moved.id,reason:'La entrega no ocurrió'});
    const corrected=await store.order(order.id);
    assert.equal(corrected.recognition,null);
    assert.equal(corrected.deliverySummary.deliveredQuantity,1);
    assert.equal(corrected.economicLocked,true);
    const audits=(await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='order' AND entity_id=?`,[order.id])).map(row=>JSON.parse(row.data));
    assert.ok(audits.some(row=>row.previous?.recognition?.on==='2026-09-05' && row.next?.recognition?.on==='2026-10-01'));
    assert.ok(audits.some(row=>row.previous?.recognition?.on==='2026-10-01' && row.next?.recognition===null));
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('cash_entries')}`)).length,0);
  }],
  ['confirmed and dispatched rules stay historical and unknown observations invent no date',async store=>{
    const {a}=await setup(store,'confirmed');
    const confirmed=await store.saveOrder(input(a),actor);
    assert.equal(confirmed.recognition.on,'2026-09-01');
    await configure(store,'dispatched');
    const old=await store.saveOrder({...confirmed,notes:'No cambiar la regla guardada'},actor,confirmed.id,confirmed.version);
    assert.equal(old.ruleSnapshot.saleRecognition,'confirmed');
    const dispatched=await store.saveOrder(input(a),actor);
    let shipment=await createShipment(store,{requestId:newRequest(),orderId:dispatched.id},actor);
    shipment=await event(store,shipment,'in_transit',null,{sourceAsOf:'2026-09-03T12:00:00.000Z'});
    assert.equal((await store.order(dispatched.id)).recognition,null);
    shipment=await event(store,shipment,'collected','2026-09-02');
    assert.equal((await store.order(dispatched.id)).recognition.on,'2026-09-02');
    const collected=shipment.events.find(row=>row.status==='collected');
    await event(store,shipment,'unknown','2026-09-02',{correctionOf:collected.id,reason:'Recogida reportada por error'});
    assert.equal((await store.order(dispatched.id)).recognition,null);
    const settings=await getBusinessSettings(store);
    await saveBusinessSettings(store,{...settings,requestId:newRequest(),rulesVersions:[{id:'later',effectiveOn:'2026-10-01',saleRecognition:'confirmed'}]},actor);
    const review=await store.saveOrder(input(a),actor);
    assert.equal(review.ruleSnapshot,null);
    assert.equal(review.policyReviewRequired,true);
    assert.equal(review.recognition,null);
  }],
  ['gift cost dates follow allocated collected events rather than unrelated shipments',async store=>{
    const {a,gift}=await setup(store),order=await store.saveOrder(input(a,{items:[line(a),line(gift)]}),actor);
    let normal=await createShipment(store,{requestId:newRequest(),orderId:order.id,assignments:[{lineId:order.items[0].lineId,quantity:1}]},actor);
    let free=await createShipment(store,{requestId:newRequest(),orderId:order.id,assignments:[{lineId:order.items[1].lineId,quantity:1}]},actor);
    normal=await event(store,normal,'collected','2026-09-02');
    assert.equal((await store.order(order.id)).giftCostOn,null);
    free=await event(store,free,'collected','2026-09-04');
    const dispatched=await store.order(order.id);
    assert.equal(dispatched.dispatchedOn,'2026-09-02');
    assert.equal(dispatched.giftCostOn,'2026-09-04');
    assert.equal(dispatched.giftDispatches[0].quantity,1);
    const original=free.events.find(row=>row.status==='collected');
    await event(store,free,'collected','2026-10-01',{correctionOf:original.id,reason:'Fecha del regalo corregida'});
    assert.equal((await store.order(order.id)).giftCostOn,'2026-10-01');
  }],
  ['cancellation credits remaining agreement once without cash or fake logistics',async store=>{
    const {a}=await setup(store,'confirmed'),order=await store.saveOrder(input(a,{items:[line(a,{quantity:2,discountMinor:1})]}),actor);
    await mutateFacts(store,tx=>collection(tx,order,{amountMinor:2000000}));
    const cancelled=await store.saveOrder({...order,status:'cancelled',statusReason:'Cliente cancela antes de despacho',cancellationOn:'2026-09-02'},actor,order.id,order.version);
    assert.equal(cancelled.status,'cancelled');
    assert.equal(cancelled.paymentSummary.commercialDueMinor,0);
    assert.equal(cancelled.paymentSummary.refundDueMinor,2000000);
    assert.equal(cancelled.returns.length,1);
    assert.equal(cancelled.returns[0].kind,'cancellation');
    assert.equal(cancelled.returns[0].sourceKey,`cancel:${order.id}`);
    assert.equal(cancelled.returns[0].lines[0].salesCreditMinor,10999999);
    assert.equal(cancelled.returns[0].lines[0].recoveredCostMinor,4600000);
    assert.equal(cancelled.returns[0].shippingCreditMinor,1200000);
    assert.equal(cancelled.financialSummary.contributionMinor,0);
    const saved=await store.saveOrder({...cancelled,notes:'Aún pendiente devolver el dinero'},actor,order.id,cancelled.version);
    assert.equal(saved.returns.length,1);
    assert.equal(saved.collections.length,1);
    assert.equal(saved.shipments.length,0);
    await assert.rejects(createShipment(store,{requestId:newRequest(),orderId:order.id},actor),{status:409});
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('cash_entries')}`)).length,0);
  }],
  ['payment filters derive real amounts including refunds and explicit reversal facts',async store=>{
    const {a}=await setup(store),order=await store.saveOrder(input(a),actor);
    const receiptId=newRequest();
    await mutateFacts(store,tx=>collection(tx,order,{id:receiptId,amountMinor:order.totalMinor}));
    assert.equal((await store.pageOrders({paymentStatus:'paid'})).total,1);
    let saved=await store.order(order.id);
    assert.equal(saved.paymentSummary.netCollectedMinor,6700000);
    const refundId=await mutateFacts(store,async tx=>{
      await returnFact(tx,order,{salesCreditMinor:5500000});
      return collection(tx,order,{kind:'refund',amountMinor:1000000});
    });
    saved=await store.order(order.id);
    assert.equal(saved.paymentSummary.status,'partially_refunded');
    assert.equal(saved.paymentSummary.refundDueMinor,4500000);
    assert.equal(saved.paymentSummary.outstandingMinor,0);
    assert.equal((await store.pageOrders({paymentStatus:'partially_refunded'})).total,1);
    await mutateFacts(store,tx=>collection(tx,order,{kind:'reversal',amountMinor:1000000,reversalOf:refundId}));
    saved=await store.order(order.id);
    assert.equal(saved.paymentSummary.status,'paid');
    assert.equal(saved.paymentSummary.netCollectedMinor,6700000);
    await mutateFacts(store,tx=>collection(tx,order,{kind:'reversal',amountMinor:order.totalMinor,reversalOf:receiptId}));
    assert.equal((await store.order(order.id)).paymentSummary.status,'pending');
    assert.equal((await store.pageOrders({paymentStatus:'pending'})).total,1);
  }],
  ['page queries are reduced, twenty per page and find guides without per-row history',async store=>{
    const {a}=await setup(store);
    let target;
    for (let i=0;i<23;i++) {
      const order=await store.saveOrder(input(a,{customerName:`Destino ${i}`}),actor);
      if (i===0) target=order;
    }
    const platform=await saveResource(store,'platforms',{requestId:newRequest(),name:'Plataforma sintética'},actor);
    const source=await store.db.get(`SELECT id FROM ${store.t('platform_sources')} WHERE platform_id=?`,[platform.id]);
    await createShipment(store,{requestId:newRequest(),orderId:target.id,sourceId:source.id,carrier:'Transportadora sintética',tracking:'0000123456789'},actor);
    assert.equal((await store.pageOrders()).records.length,20);
    assert.equal((await store.pageOrders({page:2})).records.length,3);
    const result=await store.pageOrders({q:'0000123456789',platform:platform.id,source:source.id,carrier:'Transportadora sintética',product:a.id});
    assert.equal(result.total,1);
    assert.equal(result.records[0].id,target.id);
    assert.equal(result.records[0].shipments[0].tracking,'0000123456789');
    for (const key of ['history','items','collections','returns','expenses','documentNumber','address']) assert.equal(Object.hasOwn(result.records[0],key),false);
    assert.equal(Object.hasOwn(result.records[0].shipments[0],'events'),false);
    assert.equal((await store.pageOrders({q:'AN-000001'})).total,1);
    assert.equal((await store.pageOrders({issue:'missing_cost'})).total,0);
    assert.equal((await store.pageOrders({paymentStatus:'pending'})).total,23);
  }],
  ['recognition corrections reclassify return loss and shipping dates without creating cash',async store=>{
    const {a}=await setup(store),order=await store.saveOrder(input(a),actor);
    let shipment=await createShipment(store,{requestId:newRequest(),orderId:order.id},actor);
    shipment=await event(store,shipment,'collected','2026-09-02');
    shipment=await event(store,shipment,'delivered','2026-09-03');
    let returnId;
    await mutateFacts(store,async tx=>{
      returnId=await returnFact(tx,order,{occurredOn:'2026-09-04',condition:'non_recoverable'});
      const now=stamp();
      await insertRow(tx,'expenses',{id:newRequest(),category:'shipping_out',amount_minor:1500000,incurred_on:'2026-09-02',person_id:null,order_id:order.id,shipment_id:shipment.id,source_key:`${shipment.id}:shipping_out`,version:1,recorded_at:now,created_at:now,updated_at:now,data:JSON.stringify({dateSource:'dispatch_date'})});
      await resolveOrderRecognition(tx,order.id,actor,{reason:'Recalcular evidencia original'});
    });
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('expenses')} WHERE source_key=?`,[`return-loss:${returnId}:${order.items[0].lineId}`])).length,0);
    const delivered=shipment.events.find(row=>row.status==='delivered');
    shipment=await event(store,shipment,'delivered','2026-10-01',{correctionOf:delivered.id,reason:'La entrega real fue posterior al retorno documentado'});
    let loss=await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE source_key=?`,[`return-loss:${returnId}:${order.items[0].lineId}`]);
    assert.equal(Number(loss.amount_minor),2300000);
    assert.equal(loss.incurred_on,'2026-09-04');
    const moved=shipment.events.find(row=>row.correctionOf===delivered.id);
    shipment=await event(store,shipment,'delivered','2026-09-03',{correctionOf:moved.id,reason:'Se restaura fecha respaldada'});
    loss=await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE id=?`,[loss.id]);
    assert.equal(Number(loss.amount_minor),0);
    const collected=shipment.events.find(row=>row.status==='collected');
    await event(store,shipment,'unknown','2026-09-02',{correctionOf:collected.id,reason:'No hubo recogida ese día'});
    const shipping=await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE source_key=?`,[`${shipment.id}:shipping_out`]);
    assert.equal(shipping.incurred_on,null);
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('cash_entries')}`)).length,0);
  }],
  ['transaction helper creates orders without nested transactions',async store=>{
    const {a}=await setup(store);
    const result=await mutateFacts(store,tx=>saveOrderTx(tx,input(a),actor));
    assert.equal(result.version,1);
    assert.equal(result.number,1);
    assert.equal((await store.order(result.id)).id,result.id);
  }],
];

export async function runBusinessOrderContracts(t,factory) {
  for (const [name,run] of businessOrderContracts) await t.test(name,async()=>{
    const store=await factory();
    try {await run(store);} finally {await store.close();}
  });
}

test('Business order contracts on real SQLite',async t=>runBusinessOrderContracts(t,sqliteFactory));

test('payment precedence retains outstanding/refund amounts and legacy reconciliation',()=>{
  const agreement={totalMinor:1000,subtotalMinor:1000,shippingChargeMinor:0,items:[{lineId:'a',quantity:1,unitPriceMinor:1000,discountMinor:0,unitCostMinor:0,productType:'product'}]};
  const receipt={id:'receipt',kind:'receipt',holder:'business',amountMinor:1000};
  const refund={id:'refund',kind:'refund',holder:'business',amountMinor:300};
  let summary=orderSummary(agreement,{collections:[receipt,refund]}).paymentSummary;
  assert.equal(summary.status,'partially_refunded');
  assert.equal(summary.outstandingMinor,300);
  assert.equal(summary.netCollectedMinor,700);
  summary=orderSummary(agreement,{collections:[receipt,{...refund,amountMinor:1000}]}).paymentSummary;
  assert.equal(summary.status,'refunded');
  assert.equal(summary.outstandingMinor,1000);
  const legacy=orderSummary({...agreement,legacyFinancialReview:{required:true,state:'pending'}},{collections:[{...receipt,holder:'legacy'}]}).paymentSummary;
  assert.equal(legacy.status,'legacy_review');
  summary=orderSummary(agreement,{collections:[receipt,refund,{id:'undo',kind:'reversal',holder:'business',amountMinor:300,reversalOf:'refund'}]}).paymentSummary;
  assert.equal(summary.status,'paid');
  assert.equal(summary.netCollectedMinor,1000);
});

test('settlement gross, not net bank deposit, measures business-received funds',()=>{
  const agreement={totalMinor:12200000,subtotalMinor:11000000,shippingChargeMinor:1200000,items:[{lineId:'a',quantity:2,unitPriceMinor:5500000,discountMinor:0,unitCostMinor:2300000,productType:'product'}]};
  const collections=[{id:'platform-collection',kind:'receipt',holder:'platform',amountMinor:12200000}];
  const receipt={id:'settlement-receipt',netMinor:10500000,lines:[{collectionId:'platform-collection',grossMinor:12200000,deductions:[{amountMinor:1700000}]}]};
  assert.equal(orderSummary(agreement,{collections}).paymentSummary.platformHeldMinor,12200000);
  let summary=orderSummary(agreement,{collections,settlementReceipts:[receipt]}).paymentSummary;
  assert.equal(summary.businessReceivedMinor,12200000);
  assert.equal(summary.platformHeldMinor,0);
  summary=orderSummary(agreement,{collections,settlementReceipts:[receipt,{id:'reversal',reversalOf:receipt.id,netMinor:-10500000}]}).paymentSummary;
  assert.equal(summary.businessReceivedMinor,0);
  assert.equal(summary.platformHeldMinor,12200000);
});
