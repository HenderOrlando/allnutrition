import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSQLite } from '../lib/db/sqlite.mjs';
import { Store } from '../lib/store.mjs';
import { migrateBusinessV3 } from '../lib/db/migrations.mjs';
import { loadOrderData, pageOrders } from '../lib/business/orders.mjs';
import { createShipment, saveShipment, saveShipmentTx, getShipment, pageShipments, recordShipmentEvent, recordShipmentEventTx, effectiveShipmentEvents, effectiveShipmentState, linkShipmentTx } from '../lib/business/shipments.mjs';
import { getBusinessSettings, saveBusinessSettings } from '../lib/business/settings.mjs';

const actor = 'shipping-admin';
const at = '2026-09-01T12:00:00.000Z';
const requestId = () => randomUUID();
const conflict = error => error.status === 409;
async function fixture(t) {
  const store = new Store(await openSQLite(':memory:'));
  t.after(() => store.close());
  await store.initialize();
  await migrateBusinessV3(store);
  const settings=await getBusinessSettings(store);
  await saveBusinessSettings(store,{...settings,requestId:requestId(),rulesVersions:[{id:'historical-rule',effectiveOn:'2026-01-01',saleRecognition:'delivered',commission:{enabled:false},shippingExpenseDate:'dispatch_date',returnExpenseDate:'charge_date',platformFeeExpenseDate:'charge_date'}]},actor);
  return store;
}
async function orderFixture(store,{quantity = 2,status = 'new',extraLines = []} = {}) {
  const historicalItems = [{lineId:'line-a',title:'Producto histórico',presentation:'Unidad',quantity,unitPriceMinor:10000,discountMinor:0,unitCostMinor:3000},...extraLines];
  const items=[];
  for(const line of historicalItems) {
    const product=await store.save('products',{title:line.title,slug:`shipment-${randomUUID()}`,status:'draft',orderable:true,presentation:line.presentation,price:line.unitPriceMinor/100,stockQuantity:10000,unitCostMinor:line.unitCostMinor,costEffectiveOn:'2026-01-01'});
    items.push({lineId:line.lineId,kind:'products',itemId:product.id,quantity:line.quantity,unitPriceMinor:line.unitPriceMinor,discountMinor:line.discountMinor});
  }
  let order=await store.saveOrder({requestId:requestId(),customerName:'Ejemplo',phone:'3000000000',city:'Bogotá',department:'Bogotá',address:'Dirección de prueba',placedOn:'2026-09-01',status:'new',deliveryMethod:'carrier',shippingChargeMinor:0,items},actor);
  if(status==='cancelled') order=await store.saveOrder({...order,status,cancellationOn:'2026-09-02',statusReason:'Cancelación de prueba'},actor,order.id,order.version);
  return loadOrderData(store,order.id);
}
async function sourceFixture(store,suffix) {
  const platformId = `platform-${suffix}`, sourceId = `source-${suffix}`;
  await store.db.run('INSERT INTO platforms(id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?)',[platformId,`Plataforma ${suffix}`,suffix,at,at]);
  await store.db.run('INSERT INTO platform_sources(id,platform_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',[sourceId,platformId,'Principal',at,at]);
  return {platformId,sourceId};
}
const create = (store,orderId,extra = {}) => createShipment(store,{requestId:requestId(),orderId,...extra},actor);
const event = (store,shipment,status,extra = {}) => recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status,occurredOn:'2026-09-02',...extra},actor);

test('first guide defaults all lines without inventing an occurrence; edits are versioned',async t => {
  const store = await fixture(t), order = await orderFixture(store,{extraLines:[{lineId:'line-b',kind:'products',itemId:'historical-b',productType:'product',title:'Segundo producto',presentation:'Unidad',quantity:1,unitPriceMinor:5000,discountMinor:0,unitCostMinor:null,components:[]}]});
  const input = {requestId:requestId(),orderId:order.id,carrier:'Transportadora',tracking:'0000123456789'};
  const shipment = await createShipment(store,input,actor);
  assert.equal(shipment.version,1);
  assert.equal(shipment.status,'unknown');
  assert.deepEqual(shipment.assignments,[{lineId:'line-a',quantity:2},{lineId:'line-b',quantity:1}]);
  assert.deepEqual(shipment.events,[]);
  assert.equal(shipment.costStatus,'unknown');
  assert.deepEqual(await createShipment(store,input,actor),shipment);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM shipments')).count,1);
  const edited = await saveShipment(store,{requestId:requestId(),version:shipment.version,notes:'Preparar por la mañana',estimatedDeliveryOn:'2026-09-04'},actor,shipment.id);
  assert.equal(edited.version,2);
  assert.equal(edited.estimatedDeliveryOn,'2026-09-04');
  await assert.rejects(saveShipment(store,{requestId:requestId(),version:shipment.version,notes:'Obsoleto'},actor,shipment.id),conflict);
  assert.equal((await getShipment(store,shipment.id)).tracking,'0000123456789');
  assert.equal((await loadOrderData(store,order.id)).recognition,null);
});

test('local label observations keep unknown dates separate from recording timestamps',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  const shipment = await create(store,order.id,{status:'label_created',sourceAsOf:'2026-09-01T16:00:00Z'});
  assert.equal(shipment.status,'label_created');
  assert.equal(shipment.carrier,'');
  assert.equal(shipment.tracking,'');
  assert.equal(shipment.events.length,1);
  assert.equal(shipment.events[0].occurredAt,null);
  assert.equal(shipment.events[0].occurredOn,null);
  assert.equal(shipment.events[0].sourceAsOf,'2026-09-01T16:00:00.000Z');
  await assert.rejects(event(store,shipment,'collected',{occurredOn:null}));
  await assert.rejects(event(store,shipment,'collected',{occurredAt:'2026-09-02T10:00:00Z'}));
  await assert.rejects(event(store,shipment,'unmapped-status'));
  const delivered = await event(store,shipment,'delivered',{occurredOn:null,sourceAsOf:'2026-09-03T16:00:00Z',rawStatus:'ENTREGADO',detail:'Confirmación sin fecha',source:'excel'});
  assert.equal(delivered.events.find(event => event.status === 'delivered')?.rawStatus,'ENTREGADO');
  const savedOrder = await loadOrderData(store,order.id);
  assert.equal(savedOrder.deliverySummary.complete,true);
  assert.equal(savedOrder.deliverySummary.datedDeliveredQuantity,0);
  assert.equal(savedOrder.recognition,null);
  assert.equal(savedOrder.dispatchedOn,null);
});

test('split deliveries recognize only after every purchased quantity is delivered',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  let first = await create(store,order.id);
  await assert.rejects(create(store,order.id,{assignments:[{lineId:'line-a',quantity:1}]}),conflict);
  first = await saveShipment(store,{requestId:requestId(),version:first.version,assignments:[{lineId:'line-a',quantity:1}]},actor,first.id);
  let second = await create(store,order.id,{assignments:[{lineId:'line-a',quantity:1}]});
  first = await event(store,first,'collected');
  await assert.rejects(saveShipment(store,{requestId:requestId(),version:first.version,tracking:'changed',carrier:'Carrier'},actor,first.id),conflict);
  await assert.rejects(saveShipment(store,{requestId:requestId(),version:first.version,notes:'Sin motivo'},actor,first.id));
  first = await saveShipment(store,{requestId:requestId(),version:first.version,notes:'Nota rectificada',reason:'Aclarar instrucciones'},actor,first.id);
  assert.equal(first.notes,'Nota rectificada');
  first = await event(store,first,'delivered',{occurredOn:'2026-09-03'});
  let savedOrder = await loadOrderData(store,order.id);
  assert.equal(savedOrder.deliverySummary.partial,true);
  assert.equal(savedOrder.deliverySummary.deliveredQuantity,1);
  assert.equal(savedOrder.recognition,null);
  second = await event(store,second,'delivered',{occurredOn:'2026-09-04'});
  savedOrder = await loadOrderData(store,order.id);
  assert.equal(savedOrder.deliverySummary.deliveredQuantity,2);
  assert.equal(savedOrder.status,'delivered');
  assert.equal(savedOrder.recognition.on,'2026-09-04');
  assert.equal(second.status,'delivered');
});

test('replacement chains count only leaf delivery and retain predecessor costs and history',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  let original = await create(store,order.id);
  original = await event(store,original,'collected');
  original = await event(store,original,'delivered',{occurredOn:'2026-09-03'});
  await store.db.run('INSERT INTO expenses(id,category,amount_minor,incurred_on,order_id,shipment_id,source_key,recorded_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['shipping-old','shipping_out',700,'2026-09-02',order.id,original.id,`${original.id}:shipping_out`,at,at,at,'{}']);
  let replacement = await create(store,order.id,{replacesShipmentId:original.id});
  assert.deepEqual(replacement.assignments,original.assignments);
  assert.equal((await loadOrderData(store,order.id)).deliverySummary.deliveredQuantity,0);
  assert.equal((await loadOrderData(store,order.id)).recognition,null);
  await assert.rejects(create(store,order.id,{replacesShipmentId:original.id}),conflict);
  replacement = await event(store,replacement,'delivered',{occurredOn:'2026-09-05'});
  let savedOrder = await loadOrderData(store,order.id);
  assert.equal(savedOrder.deliverySummary.deliveredQuantity,2);
  assert.equal(savedOrder.recognition.on,'2026-09-05');
  let last = await create(store,order.id,{replacesShipmentId:replacement.id});
  last = await event(store,last,'delivered',{occurredOn:'2026-09-06'});
  savedOrder = await loadOrderData(store,order.id);
  assert.equal(savedOrder.deliverySummary.deliveredQuantity,2);
  assert.equal(savedOrder.recognition.on,'2026-09-06');
  assert.equal((await getShipment(store,original.id)).events.length,2);
  assert.equal((await store.db.get('SELECT amount_minor FROM expenses WHERE id=?',['shipping-old'])).amount_minor,700);
});

test('identities preserve tracking text, enforce source/platform relation and never merge guides',async t => {
  const store = await fixture(t), a = await sourceFixture(store,'a'), b = await sourceFixture(store,'b');
  const shipment = await create(store,null,{...a,externalId:'000001',carrier:'  CARRIER   Uno ',tracking:'000AbC'});
  assert.ok(shipment.identityKey);
  await assert.rejects(create(store,null,{...a,externalId:'000001'}),conflict);
  await assert.rejects(create(store,null,{...b,externalId:'000001',carrier:'carrier uno',tracking:'000AbC'}),conflict);
  await assert.rejects(create(store,null,{carrier:'Carrier Uno',tracking:'000AbC'}),conflict);
  const otherAccount = await create(store,null,{...b,externalId:'000001',carrier:'carrier uno',tracking:'000abc'});
  assert.notEqual(otherAccount.id,shipment.id);
  assert.notEqual(otherAccount.identityKey,shipment.identityKey);
  await assert.rejects(create(store,null,{platformId:a.platformId,sourceId:b.sourceId,externalId:'another'}));
  await assert.rejects(create(store,null,{externalId:'no-source'}));
  await assert.rejects(create(store,null,{tracking:'no-carrier'}));
  assert.equal((await pageShipments(store,{source:a.sourceId,q:'000AbC'})).total,1);
  assert.equal((await pageShipments(store,{platform:b.platformId})).total,1);
});

test('old observations, unknown codes, and snapshot incidents retain evidence without downgrade',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  let shipment = await create(store,order.id);
  const snapshot = (status,sourceAsOf,extra = {}) => event(store,shipment,status,{occurredOn:null,sourceAsOf,source:'excel',...extra});
  shipment = await snapshot('incident','2026-09-02T12:00:00Z',{detail:'Dirección'});
  shipment = await snapshot('in_transit','2026-09-03T12:00:00Z');
  shipment = await snapshot('incident','2026-09-04T12:00:00Z',{detail:'Dirección'});
  assert.equal(shipment.events.filter(event => event.status === 'incident').length,2);
  shipment = await event(store,shipment,'delivered',{occurredOn:'2026-09-05'});
  shipment = await snapshot('in_transit','2026-09-03T15:00:00Z');
  assert.equal(shipment.status,'delivered');
  const recognition = (await loadOrderData(store,order.id)).recognition;
  shipment = await snapshot('unknown','2026-09-06T12:00:00Z',{rawStatus:'X-404'});
  assert.equal(shipment.events.find(event => event.rawStatus === 'X-404')?.status,'unknown');
  assert.equal(shipment.status,'delivered');
  assert.deepEqual((await loadOrderData(store,order.id)).recognition,recognition);
  await assert.rejects(snapshot('in_transit','2026-09-07T12:00:00Z'),conflict);
  assert.equal((await loadOrderData(store,order.id)).dispatchedOn,null);
});

test('events are idempotent across commands and external identities are scoped to source',async t => {
  const store = await fixture(t), a = await sourceFixture(store,'a'), b = await sourceFixture(store,'b');
  let first = await create(store,null,a), second = await create(store,null,b);
  const input = {requestId:requestId(),version:first.version,status:'incident',occurredOn:null,sourceAsOf:'2026-09-02T12:00:00Z',externalKey:'000event',rawStatus:'NOVEDAD',source:'excel'};
  const initial = await recordShipmentEvent(store,first.id,input,actor);
  assert.deepEqual(await recordShipmentEvent(store,first.id,input,actor),initial);
  first = await recordShipmentEvent(store,first.id,{...input,requestId:requestId()},actor);
  assert.equal(first.events.length,1);
  assert.equal(first.version,2);
  second = await recordShipmentEvent(store,second.id,{...input,requestId:requestId()},actor);
  assert.equal(second.events.length,1);
  assert.notEqual(second.events[0].externalKey,first.events[0].externalKey);
  await assert.rejects(recordShipmentEvent(store,first.id,{...input,requestId:requestId(),version:first.version,status:'in_transit'},actor),conflict);
  await assert.rejects(recordShipmentEvent(store,first.id,{...input,status:'unknown'},actor),conflict);
  let manual = await create(store,null);
  manual = await event(store,manual,'incident',{occurredOn:null,sourceAsOf:'2026-09-02T12:00:00Z'});
  const count = manual.events.length;
  manual = await event(store,manual,'incident',{occurredOn:null,sourceAsOf:'2026-09-02T12:00:00Z'});
  assert.equal(manual.events.length,count);
});

test('terminal corrections supersede facts, move recognition, preserve audit, and never touch cash',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  let shipment = await create(store,order.id);
  shipment = await event(store,shipment,'delivered',{occurredOn:'2026-09-03'});
  const delivered = shipment.events.find(event => event.status === 'delivered');
  await assert.rejects(event(store,shipment,'in_transit',{occurredOn:'2026-09-04'}),conflict);
  await assert.rejects(event(store,shipment,'unknown',{correctionOf:delivered.id,reason:''}));
  await assert.rejects(event(store,shipment,'unknown',{correctionOf:'another-event',reason:'Corregir'}),conflict);
  shipment = await event(store,shipment,'delivered',{occurredOn:'2026-10-02',correctionOf:delivered.id,reason:'Fecha real comprobada'});
  assert.equal((await loadOrderData(store,order.id)).recognition.on,'2026-10-02');
  assert.equal(effectiveShipmentEvents(shipment.events).length,1);
  assert.equal(effectiveShipmentEvents(shipment.events,{asOf:'2026-09-30T23:59:59Z'}).length,0);
  const moved = shipment.events.find(event => event.correctionOf === delivered.id);
  shipment = await event(store,shipment,'unknown',{occurredOn:'2026-10-02',correctionOf:moved.id,reason:'No hubo entrega real'});
  assert.equal(shipment.status,'unknown');
  assert.equal((await loadOrderData(store,order.id)).recognition,null);
  assert.equal(shipment.events.length,3);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM cash_entries')).count,0);
  const correctionAudit = await store.db.get('SELECT data FROM business_audit WHERE entity_type=? AND entity_id=?',['shipment_event',shipment.events.find(event => event.correctionOf === moved.id).id]);
  assert.equal(JSON.parse(correctionAudit.data).previous.id,moved.id);
  assert.equal(JSON.parse(correctionAudit.data).reason,'No hubo entrega real');
});

test('cancelled orders reject dispatch and cancelled guides cannot reactivate over allocated quantities',async t => {
  const store = await fixture(t), order = await orderFixture(store);
  let shipment = await create(store,order.id);
  shipment = await event(store,shipment,'cancelled');
  const cancellation = shipment.events.find(event => event.status === 'cancelled');
  await create(store,order.id,{assignments:[{lineId:'line-a',quantity:2}]});
  await assert.rejects(event(store,shipment,'label_created',{correctionOf:cancellation.id,reason:'Reactivar guía'}),conflict);
  const cancelled = await orderFixture(store,{status:'cancelled'});
  await assert.rejects(create(store,cancelled.id),conflict);
  const unbound = await create(store,null);
  await assert.rejects(store.transaction(async tx => { await tx.lockWrites(); return linkShipmentTx(tx,{shipmentId:unbound.id,orderId:cancelled.id,version:unbound.version,reason:'Vincular guía'},actor); }),conflict);
  const raw = await store.db.get('SELECT data FROM orders WHERE id=?',[order.id]);
  await store.db.run('UPDATE orders SET data=? WHERE id=?',[JSON.stringify({...JSON.parse(raw.data),status:'cancelled'}),order.id]);
  const active = (await pageShipments(store,{orderId:order.id,status:'unknown'})).records[0];
  await assert.rejects(event(store,active,'collected'),conflict);
});

test('explicit linking and tx APIs participate in caller transaction without nesting',async t => {
  const store = await fixture(t), firstOrder = await orderFixture(store), otherOrder = await orderFixture(store);
  const unbound = await create(store,null);
  let linked = await store.transaction(async tx => {
    await tx.lockWrites();
    return linkShipmentTx(tx,{shipmentId:unbound.id,orderId:firstOrder.id,version:unbound.version,reason:'Identidad confirmada'},actor);
  });
  assert.equal(linked.orderId,firstOrder.id);
  assert.deepEqual(linked.assignments,[{lineId:'line-a',quantity:2}]);
  await assert.rejects(saveShipment(store,{requestId:requestId(),version:linked.version,orderId:otherOrder.id},actor,linked.id),conflict);
  linked = await store.transaction(async tx => {
    await tx.lockWrites();
    return recordShipmentEventTx(tx,linked.id,{version:linked.version,status:'collected',occurredOn:'2026-09-02'},actor);
  });
  assert.equal(linked.status,'collected');
  const count = (await store.db.get('SELECT COUNT(*) AS count FROM shipments')).count;
  await assert.rejects(store.transaction(async tx => {
    await tx.lockWrites();
    const transient = await saveShipmentTx(tx,{orderId:otherOrder.id},actor);
    await recordShipmentEventTx(tx,transient.id,{version:transient.version,status:'incident',occurredOn:'2026-09-02'},actor);
    throw new Error('rollback caller group');
  }),/rollback caller group/);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM shipments')).count,count);
});

test('shipment paging is reduced, twenty rows, filtered, and literal wildcard search',async t => {
  const store = await fixture(t);
  for (let i = 0; i < 23; i++) await create(store,null,{carrier:'Carrier',tracking:`guide-${i}`});
  await create(store,null,{carrier:'Carrier',tracking:'guide-%_exact'});
  const first = await pageShipments(store), second = await pageShipments(store,{page:2});
  assert.equal(first.total,24);
  assert.equal(first.pageSize,20);
  assert.equal(first.records.length,20);
  assert.equal(second.records.length,4);
  assert.equal(new Set([...first.records,...second.records].map(row => row.id)).size,24);
  assert.ok(first.records.every(row => !Object.hasOwn(row,'events')));
  assert.equal((await pageShipments(store,{q:'%_'})).total,1);
  assert.equal((await pageShipments(store,{carrier:'Other'})).total,0);
  await assert.rejects(pageShipments(store,{status:'invalid'}));
});

test('effective timeline accepts decoded and raw rows and never substitutes recorded_at',() => {
  const rows = [
    {id:'old',status:'delivered',occurred_on:'2026-09-01',occurred_at:null,source_as_of:null,recorded_at:'2026-10-01T00:00:00Z',data:'{}'},
    {id:'corrected',status:'unknown',occurred_on:null,occurred_at:null,source_as_of:'2026-09-02T12:00:00Z',recorded_at:'2026-10-02T00:00:00Z',data:JSON.stringify({correctionOf:'old'})},
    {id:'later',status:'incident',occurred_on:null,occurred_at:null,source_as_of:'2026-09-03T12:00:00Z',recorded_at:'2026-09-03T13:00:00Z',data:'{}'},
  ];
  const effective = effectiveShipmentEvents(rows);
  assert.deepEqual(effective.map(row => row.id),['corrected','later']);
  assert.equal(effectiveShipmentState(rows),'incident');
  assert.equal(effectiveShipmentState([]),'unknown');
  assert.equal(effectiveShipmentEvents(rows,{asOf:'2026-09-01T23:59:59Z'}).length,0);
});

test('legacy duplicate guides remain unclaimed while unrelated notes are edited',async t => {
  const store = await fixture(t);
  for (const id of ['legacy-one','legacy-two']) await store.db.run('INSERT INTO shipments(id,status,carrier,tracking,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[id,'unknown','Legacy Carrier','000duplicate',JSON.stringify({assignments:[],notes:'',costStatus:'unknown'}),at,at]);
  const result = await saveShipment(store,{requestId:requestId(),version:1,notes:'Pendiente de conciliación'},actor,'legacy-one');
  assert.equal(result.identityKey,null);
  assert.equal(result.notes,'Pendiente de conciliación');
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM shipments')).count,2);
  await assert.rejects(create(store,null,{carrier:'legacy carrier',tracking:'000duplicate'}),conflict);
});

test('event cutoffs compare instants across offsets and optional fractional seconds',()=>{
 const earlier={id:'earlier',status:'collected',occurredAt:'2026-11-01T04:59:59Z'};
 const later={id:'later',status:'delivered',occurredAt:'2026-11-01T00:00:00-05:00'};
 assert.deepEqual(effectiveShipmentEvents([later,earlier],{asOf:'2026-11-01T04:59:59.999Z'}).map(row=>row.id),['earlier']);
 assert.deepEqual(effectiveShipmentEvents([later,earlier],{asOf:'2026-11-01T05:00:00.000Z'}).map(row=>row.id),['earlier','later']);
 assert.equal(effectiveShipmentState([later,earlier]),'delivered');
 assert.equal(effectiveShipmentEvents([{id:'epoch',status:'delivered',occurredAt:'1970-01-01T00:00:00Z'}],{asOf:'1970-01-01T00:00:00.000Z'}).length,1);
});

test('shipping workspace reads source-scoped orphans and incidents without contact or history list leakage',async t=>{
  const store=await fixture(t),a=await sourceFixture(store,'workspace-a'),b=await sourceFixture(store,'workspace-b'),order=await orderFixture(store);
  let orphan=await create(store,null,{...a,carrier:'Exacta',tracking:'000-orphan'});
  orphan=await event(store,orphan,'incident',{occurredOn:null,sourceAsOf:'2026-09-03T12:00:00Z'});
  await create(store,null,{...b,carrier:'Exacta',tracking:'other-source'});
  const linked=await create(store,order.id,{...a,carrier:'Exacta',tracking:'000-linked'});
  const orphanPage=await pageShipments(store,{source:a.sourceId,issue:'orphan'});
  assert.equal(orphanPage.total,1);
  assert.equal(orphanPage.records[0].id,orphan.id);
  assert.equal(orphanPage.records[0].platformName,'Plataforma workspace-a');
  assert.equal(orphanPage.records[0].sourceName,'Principal');
  assert.equal(orphanPage.records[0].knownEventOn,null);
  assert.equal(orphanPage.records[0].knownEventAt,null);
  assert.equal(orphanPage.records[0].sourceAsOf,'2026-09-03T12:00:00.000Z');
  assert.equal((await pageShipments(store,{source:a.sourceId,issue:'incident'})).total,1);
  assert.equal((await pageShipments(store,{source:b.sourceId,issue:'incident'})).total,0);
  assert.equal((await pageShipments(store,{source:a.sourceId,issue:'missing_data'})).total,2);
  assert.equal((await pageShipments(store,{q:`AN-${String(order.number).padStart(6,'0')}`})).records[0].id,linked.id);
  for(const key of ['data','phone','email','address','customerName','events','assignments','notes'])assert.ok(!Object.hasOwn(orphanPage.records[0],key),key);
  const detail=await getShipment(store,linked.id);
  assert.equal(detail.orderNumber,order.number);
  assert.deepEqual(detail.orderLines,[{lineId:'line-a',title:'Producto histórico',presentation:'Unidad',quantity:2}]);
  assert.equal(detail.relatedShipments[0].id,linked.id);
  assert.equal(detail.version,linked.version);
  assert.ok(!Object.hasOwn(detail,'phone'));
  assert.ok(!Object.hasOwn(detail,'customerName'));
  assert.equal((await getShipment(store,orphan.id)).events.length,1);
  await assert.rejects(pageShipments(store,{issue:'invented'}),error=>error.status===400);
});

test('known-order selector searches exact number or guide, never fuzzy customer identity',async t=>{
  const store=await fixture(t),order=await orderFixture(store);
  await create(store,order.id,{carrier:'Exacta',tracking:'000-ExactGuide'});
  const select=filters=>store.readSnapshot(tx=>pageOrders(tx,{lookup:'identity',...filters}));
  assert.equal((await select({q:'Ejemplo'})).total,0);
  assert.equal((await select({q:'3000000000'})).total,0);
  assert.equal((await select({q:'ExactGuide'})).total,0);
  assert.equal((await select({q:'000-exactguide'})).total,0);
  assert.equal((await select({q:'000-ExactGuide'})).records[0].id,order.id);
  const found=await select({q:`AN-${String(order.number).padStart(6,'0')}`});
  assert.equal(found.records[0].id,order.id);
  assert.ok(!Object.hasOwn(found.records[0],'phone'));
  assert.ok(!Object.hasOwn(found.records[0],'email'));
  assert.ok(!Object.hasOwn(found.records[0],'address'));
});
