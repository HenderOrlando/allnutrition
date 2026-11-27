import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PACK_FIELDS, parsePackedMeasure, preparationValues } from '../lib/shipping/center-values.mjs';
import { attachShippingPreparationTx, getShippingPreparation, getShippingPreparationContext, listShippingPreparations, saveShippingPreparation } from '../lib/business/shipping-preparations.mjs';
import { createShipment, linkShipmentTx, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { loadOrderData, persistOrderData } from '../lib/business/orders.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { saveResource } from '../lib/business/settings.mjs';

const actor = 'shipping-preparations-admin';
const asInput = ({editable,partial,collectionNeedsConfirmation,provenance,updatedAt,...dto},patch = {}) => ({...dto,requestId:randomUUID(),...patch});
const product = (slug,extra = {}) => ({title:slug,slug,status:'draft',orderable:true,price:20000,presentation:'Unidad',stockQuantity:100,...extra});
const measures = {packedWeightG:525,packedLengthMm:135,packedWidthMm:100,packedHeightMm:85};
const parcel = {weightG:525,lengthMm:135,widthMm:100,heightMm:85};
const orderLine = (item,{quantity=1,kind='products',discountMinor=0} = {}) => ({kind,itemId:item.id,quantity,unitPriceMinor:item.price*100,discountMinor});
const orderInput = items => ({requestId:randomUUID(),customerName:'Destinatario sintético',phone:'3001234567',address:'Dirección sintética',addressNotes:'Apartamento de prueba',city:'Bogotá',department:'Bogotá',placedOn:'2026-09-01',deliveryMethod:'carrier',shippingChargeMinor:300000,items});
const shipmentInput = extra => ({carrier:'Transportadora sintética',tracking:randomUUID(),requestId:randomUUID(),...extra});
const recordEvent = (store,shipment,status) => recordShipmentEvent(store,shipment.id,{requestId:randomUUID(),version:shipment.version,status,occurredOn:'2026-09-02'},actor);
async function fixture(store) {
  await store.db.run(`INSERT INTO ${store.t('users')}(id,email,password) VALUES(?,?,?)`,[actor,'preparations-contract@example.invalid','unused']);
  const a = await store.save('products',product('bien-a',{...measures,status:'published',image:'/brand/creatina-vital-force.jpg'}));
  const b = await store.save('products',product('bien-b'));
  return {a,b};
}
async function selectFacts(store) {
  const data = {};
  for (const table of ['shipments','shipment_events','orders','expenses','order_collections','cash_entries','product_costs']) data[table] = await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`);
  return data;
}

export async function runShippingPreparationContracts(t,factory) {
  await t.test('packing uses exact optional units; preparing or replaying does not mutate logistics or finances',async () => {
    const store = await factory();
    try {
      const {a,b} = await fixture(store);
      assert.equal(parsePackedMeasure('0,525',PACK_FIELDS[0]),525);
      assert.equal(parsePackedMeasure('13.5',PACK_FIELDS[1]),135);
      assert.equal(parsePackedMeasure('',PACK_FIELDS[3]),null);
      for (const value of ['0','0.0001','1e2','1000.001']) assert.throws(()=>parsePackedMeasure(value,PACK_FIELDS[0]),{status:400});
      await assert.rejects(store.save('products',{...a,packedWeightG:525.1},a.id,a.version),{status:400});
      const item = (await store.publicData()).products.find(row=>row.id===a.id);
      assert.ok(item);
      for (const field of PACK_FIELDS) assert.equal(Object.hasOwn(item,field.name),false);
      const order = await store.saveOrder(orderInput([orderLine(a,{discountMinor:100000})]),actor);
      // An imported v2 reference has no dated cost fact until one is recorded.
      await store.transaction(async tx=>{
        const row = await tx.db.get(`SELECT data FROM ${tx.t('records')} WHERE id=?`,[a.id]);
        await tx.db.run(`UPDATE ${tx.t('records')} SET data=? WHERE id=?`,[JSON.stringify({...JSON.parse(row.data),costEffectiveOn:null}),a.id]);
        await tx.db.run(`DELETE FROM ${tx.t('product_costs')} WHERE product_id=?`,[a.id]);
      });
      const currentA = await store.get('products',a.id);
      const draft = await getShippingPreparationContext(store,{orderId:order.id});
      assert.deepEqual(draft.parcel,parcel);
      assert.equal(draft.provenance.parcel,'unit');
      assert.equal(draft.recipient.addressNotes,'Apartamento de prueba');
      assert.equal(draft.route.destination.state,'Bogotá');
      assert.equal(draft.payment.declaredMinor,1900000);
      assert.equal(draft.payment.collectionMinor,order.paymentSummary.outstandingMinor);
      assert.equal(draft.collectionNeedsConfirmation,false);
      const input = asInput(draft,{parcel:{...parcel,weightG:675},unitPatches:[{kind:'products',itemId:a.id,version:currentA.version,packedWeightG:550}]});
      const before = await selectFacts(store);
      await assert.rejects(saveShippingPreparation(store,input,'not-an-admin'),{status:403});
      const saved = await saveShippingPreparation(store,input,actor);
      assert.deepEqual(await saveShippingPreparation(store,input,actor),saved);
      assert.deepEqual(await selectFacts(store),before);
      const updated = await store.get('products',a.id);
      assert.equal(updated.version,currentA.version+1);
      assert.equal(updated.packedWeightG,550);
      assert.equal(updated.packedLengthMm,135);
      assert.equal(updated.costEffectiveOn,null);
      assert.equal(updated.price,a.price);
      assert.deepEqual(await store.get('products',b.id),b);
      const detail = await getShippingPreparation(store,saved.id);
      assert.deepEqual(detail.parcel,{...parcel,weightG:675});
      assert.match(detail.updatedAt,/^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(await listShippingPreparations(store,{orderId:order.id}),{rows:[{...saved,updatedAt:detail.updatedAt}],pager:{page:1,limit:20,total:1,nextPage:null,previousPage:null}});
      assert.deepEqual((await listShippingPreparations(store,{orderId:randomUUID()})).rows,[]);
      const journal = await store.db.get(`SELECT result_json FROM ${store.t('business_requests')} WHERE request_id=?`,[input.requestId]);
      assert.equal(JSON.parse(journal.result_json).recipient,undefined);
      await assert.rejects(saveShippingPreparation(store,{...input,parcel},actor),{status:409});
    } finally { await store.close(); }
  });

  await t.test('partial shipments use exactly their assignments and roll back the draft and every unit patch on a stale reference',async () => {
    const store = await factory();
    try {
      const {a,b} = await fixture(store);
      const order = await store.saveOrder(orderInput([orderLine(a,{quantity:3,discountMinor:120000}),orderLine(b)]),actor);
      const another = await store.saveOrder(orderInput([orderLine(b)]),actor);
      const quantities = [{lineId:order.items[0].lineId,quantity:2},{lineId:order.items[1].lineId,quantity:1}];
      const shipment = await createShipment(store,shipmentInput({orderId:order.id,assignments:quantities}),actor);
      await assert.rejects(getShippingPreparationContext(store,{orderId:another.id,shipmentId:shipment.id}),{status:409});
      const draft = await getShippingPreparationContext(store,{shipmentId:shipment.id});
      assert.equal(draft.orderId,order.id);
      assert.equal(draft.partial,true);
      assert.equal(draft.collectionNeedsConfirmation,true);
      assert.equal(draft.payment.collectionMinor,null);
      assert.equal(draft.payment.declaredMinor,5920000);
      assert.deepEqual(draft.parcel,{weightG:null,lengthMm:null,widthMm:null,heightMm:null});
      assert.deepEqual(draft.lines.map(({lineId,quantity})=>({lineId,quantity})),quantities);
      await assert.rejects(saveShippingPreparation(store,asInput(draft,{lines:[draft.lines[0]]}),actor),{status:409});
      await assert.rejects(saveShippingPreparation(store,asInput(draft,{lines:[{...draft.lines[0],itemId:b.id},draft.lines[1]]}),actor),{status:409});
      await assert.rejects(saveShippingPreparation(store,asInput(draft,{shipmentVersion:draft.shipmentVersion+1}),actor),{status:409});
      const saved = await saveShippingPreparation(store,asInput(draft),actor);
      await assert.rejects(saveShippingPreparation(store,asInput(draft),actor),{status:409});
      const savedDraft = await getShippingPreparationContext(store,{orderId:order.id,shipmentId:shipment.id});
      assert.equal(savedDraft.id,saved.id);
      assert.equal(savedDraft.provenance.lines,'preparation');
      const currentA = await store.get('products',a.id), currentB = await store.get('products',b.id);
      const patches = [{kind:'products',itemId:a.id,version:currentA.version,packedWidthMm:151},{kind:'products',itemId:b.id,version:currentB.version+1,packedWeightG:250}];
      const next = asInput(savedDraft,{parcel:{...parcel,weightG:1900},unitPatches:patches});
      await assert.rejects(saveShippingPreparation(store,next,actor),{status:409});
      assert.deepEqual(await getShippingPreparation(store,saved.id),savedDraft);
      assert.deepEqual(await store.get('products',a.id),currentA);
      assert.deepEqual(await store.get('products',b.id),currentB);
      await assert.rejects(saveShippingPreparation(store,{...next,unitPatches:[{...patches[0],price:1}]},actor),{status:400});
      const recovered = await saveShippingPreparation(store,{...next,unitPatches:[patches[0],{...patches[1],version:currentB.version}]},actor);
      assert.equal(recovered.version,saved.version+1);
      assert.equal((await store.get('products',a.id)).packedWidthMm,151);
      assert.equal((await store.get('products',b.id)).packedWeightG,250);
      const replacement = await createShipment(store,shipmentInput({orderId:order.id,replacesShipmentId:shipment.id}),actor);
      assert.equal((await getShippingPreparation(store,saved.id)).editable,false);
      await assert.rejects(saveShippingPreparation(store,asInput(await getShippingPreparation(store,saved.id)),actor),{status:409});
      const ready = await getShippingPreparationContext(store,{shipmentId:replacement.id});
      assert.deepEqual(ready.parcel,{weightG:1300,lengthMm:null,widthMm:null,heightMm:null});
      assert.equal(ready.provenance.parcel,'weight-suggestion');
      const replacementDraft = await saveShippingPreparation(store,asInput(ready),actor);
      await recordEvent(store,replacement,'cancelled');
      assert.equal((await getShippingPreparation(store,replacementDraft.id)).editable,false);
      const dispatched = await createShipment(store,shipmentInput({orderId:order.id,replacesShipmentId:replacement.id}),actor);
      const dispatchDraft = await saveShippingPreparation(store,asInput(await getShippingPreparationContext(store,{shipmentId:dispatched.id})),actor);
      await recordEvent(store,dispatched,'collected');
      const frozen = await getShippingPreparation(store,dispatchDraft.id);
      assert.equal(frozen.editable,false);
      await assert.rejects(saveShippingPreparation(store,asInput(frozen),actor),{status:409});
    } finally { await store.close(); }
  });

  await t.test('attach only the confirmed preparation and keep paid/legacy collection semantics separate from merchandise',async () => {
    const store = await factory();
    try {
      const {a} = await fixture(store);
      const combo = await store.save('combos',{title:'Combo de prueba',slug:'combo-medido',status:'draft',orderable:true,price:30000,items:[{productId:a.id,quantity:2}],packedWeightG:850});
      const order = await store.saveOrder(orderInput([orderLine(combo,{kind:'combos'})]),actor);
      const context = await getShippingPreparationContext(store,{orderId:order.id});
      assert.deepEqual(context.parcel,{weightG:850,lengthMm:null,widthMm:null,heightMm:null});
      const person = await saveResource(store,'people',{requestId:randomUUID(),name:'Responsable de prueba'},actor);
      const account = await saveAccount(store,{requestId:randomUUID(),name:'Caja sintética',type:'bank',responsibleId:person.id,openingOn:'2026-09-01',openingBalanceMinor:0},actor);
      await recordCollection(store,{requestId:randomUUID(),orderId:order.id,version:order.version,holder:'business',accountId:account.id,amountMinor:order.totalMinor,occurredOn:'2026-09-01',method:'transfer',reference:'Pago sintético'},actor);
      const paid = await getShippingPreparationContext(store,{orderId:order.id});
      assert.equal(paid.payment.collectionMinor,0);
      assert.equal(paid.payment.declaredMinor,3000000);
      assert.equal(paid.collectionNeedsConfirmation,false);
      const saved = await saveShippingPreparation(store,asInput(paid),actor);
      const shipment = await createShipment(store,shipmentInput({orderId:order.id}),actor);
      const other = await store.saveOrder(orderInput([orderLine(a)]),actor);
      await assert.rejects(store.transaction(async tx=>{await tx.lockWrites();return attachShippingPreparationTx(tx,{id:saved.id,version:saved.version,orderId:other.id,shipmentId:shipment.id});}),{status:409});
      await store.transaction(async tx=>{
        await tx.lockWrites();
        assert.deepEqual(await attachShippingPreparationTx(tx,{id:saved.id,version:saved.version,orderId:order.id,shipmentId:shipment.id}),{id:saved.id,version:saved.version+1});
      });
      assert.equal((await getShippingPreparationContext(store,{shipmentId:shipment.id})).id,saved.id);
      assert.equal((await listShippingPreparations(store)).pager.total,1);
      const standaloneShipment = await createShipment(store,shipmentInput({}),actor);
      const standalone = await saveShippingPreparation(store,asInput(await getShippingPreparationContext(store,{shipmentId:standaloneShipment.id}),{lines:[{kind:'products',itemId:a.id,quantity:1}]}),actor);
      assert.equal(standalone.orderId,null);
      await store.transaction(async tx=>{
        await tx.lockWrites();
        await linkShipmentTx(tx,{shipmentId:standaloneShipment.id,orderId:other.id,version:standaloneShipment.version,reason:'Asociación confirmada'},actor);
      });
      const linked = await getShippingPreparation(store,standalone.id);
      assert.equal(linked.orderId,other.id);
      assert.equal(linked.lines[0].lineId,other.items[0].lineId);
      await store.transaction(async tx=>{
        await tx.lockWrites();
        const current = await loadOrderData(tx,other.id);
        await persistOrderData(tx,{...current,legacyFinancialReview:{required:true,state:'pending'}},{actorId:actor,reason:'Saldo histórico de prueba'});
      });
      const legacy = await getShippingPreparationContext(store,{orderId:other.id});
      assert.equal(legacy.collectionNeedsConfirmation,true);
      assert.equal(legacy.payment.collectionMinor,null);
      const freeDraft = await saveShippingPreparation(store,asInput(preparationValues({parcel})),actor);
      assert.equal(freeDraft.shipmentId,null);
      assert.equal(freeDraft.orderId,null);
    } finally { await store.close(); }
  });
}
