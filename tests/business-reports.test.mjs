import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSQLite } from '../lib/db/sqlite.mjs';
import { migrateBusinessV3 } from '../lib/db/migrations.mjs';
import { Store } from '../lib/store.mjs';
import { addDays, bogotaDate, periodBounds } from '../lib/business/dates.mjs';
import { bumpRevision, insertRow } from '../lib/business/commands.mjs';
import { claimJob, queueJobTx } from '../lib/business/job-leases.mjs';
import {
  allocateReportAmount, buildBusinessReport, generateReportSnapshot, getReportSnapshot,
  listReportSnapshots, normalizeReportQuery, processReportTurn, reportDetails, saveReportSnapshot,
} from '../lib/business/reports.mjs';

const actor = 'report-admin';
const recordedAt = '2026-08-01T12:00:00.000Z';
const asOf = '2027-02-02T12:00:00.000Z';
const query = (anchorDate = '2026-09-15', extra = {}) => ({period:'month',anchorDate,asOf,...extra});
const requestId = () => randomUUID();
const value = (report, key) => report.metrics[key].value;
async function fixture(t) {
  const store = new Store(await openSQLite(':memory:'));
  t.after(() => store.close());
  await store.initialize();
  await migrateBusinessV3(store);
  return store;
}
function line(extra = {}) {
  return {lineId:randomUUID(),kind:'products',itemId:'product-a',productType:'product',title:'Nombre histórico A',presentation:'Unidad',quantity:1,unitPriceMinor:10000,discountMinor:0,unitCostMinor:3000,components:[],...extra};
}
async function putOrder(store, extra = {}) {
  const items = extra.items || [line()];
  const subtotalMinor = items.reduce((n,l) => n+l.quantity*l.unitPriceMinor-l.discountMinor,0);
  const number = Number((await store.db.get('SELECT COALESCE(MAX(number),0)+1 AS number FROM orders')).number);
  const data = {
    placedOn:'2026-09-01',status:'delivered',sellerId:null,sellerSnapshot:null,
    customerName:'CONTACTO-NO-EXPORTAR',phone:'3999999999',address:'DOMICILIO-NO-EXPORTAR',email:'privado@example.test',
    items,shippingChargeMinor:0,subtotalMinor,totalMinor:subtotalMinor,dispatchedOn:'2026-09-02',giftDispatches:[],
    ruleSnapshot:{id:'historical-rule',effectiveOn:'2026-01-01',saleRecognition:'delivered',commission:{enabled:false}},
    recognition:{on:'2026-09-03',basis:'delivered',ruleVersionId:'historical-rule'},
    deliverySummary:{complete:true,datedDeliveredQuantity:items.reduce((n,l) => n+l.quantity,0)},
    ...extra,
  };
  const id = randomUUID();
  await insertRow(store,'orders',{id,number,data:JSON.stringify(data),created_at:recordedAt,updated_at:recordedAt});
  return {...data,id,number};
}
async function person(store, extra = {}) {
  const row = {id:randomUUID(),name:'Persona real',active:1,version:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify(extra)};
  await insertRow(store,'people',row);
  return row.id;
}
async function putExpense(store, {category='other',amountMinor=1000,incurredOn='2026-09-04',orderId=null,personId=null,shipmentId=null,...data} = {}) {
  const id = randomUUID();
  await insertRow(store,'expenses',{id,category,amount_minor:amountMinor,incurred_on:incurredOn,order_id:orderId,person_id:personId,shipment_id:shipmentId,source_key:data.sourceKey || (amountMinor < 0 ? `adjustment:${id}` : null),recorded_at:recordedAt,version:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify(data)});
  return id;
}
async function putReturn(store,order,{occurredOn='2026-10-02',kind='return',lines,shippingCreditMinor=0} = {}) {
  const id = randomUUID();
  await insertRow(store,'order_returns',{id,order_id:order.id,occurred_on:occurredOn,reason:'Motivo comercial',kind,source_key:null,recorded_at:recordedAt,version:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify({lines,shippingCreditMinor})});
  return id;
}
async function putShipment(store,orderId = null,{events=[],status='delivered',...data} = {}) {
  const id = randomUUID();
  await insertRow(store,'shipments',{id,order_id:orderId,platform_id:null,source_id:null,external_id:null,identity_key:null,status,carrier:data.carrier || 'Transportadora real',tracking:data.tracking || id,source_as_of:null,version:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify({costStatus:'known',costStatuses:{shipping_out:'known'},...data})});
  for (const event of events) await insertRow(store,'shipment_events',{id:event.id || randomUUID(),shipment_id:id,external_key:null,status:event.status,occurred_on:event.occurredOn || null,occurred_at:event.occurredAt || null,source_as_of:event.sourceAsOf || null,recorded_at:recordedAt,data:JSON.stringify(event.correctionOf ? {correctionOf:event.correctionOf} : {})});
  return id;
}
const details = (report, metric) => reportDetails(report,{metric,pageSize:null}).records;

test('null costs are excluded while explicit zero is complete; details never retain recipient contacts',async t => {
  const store = await fixture(t);
  await putOrder(store,{items:[line({itemId:'known-zero',unitCostMinor:0}),line({itemId:'unknown',unitCostMinor:null})]});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'netProductSales'),20000);
  assert.equal(value(report,'costOfGoods'),null);
  assert.equal(report.metrics.costOfGoods.knownValue,0);
  assert.equal(report.metrics.costOfGoods.knownCount,1);
  assert.equal(report.metrics.costOfGoods.excludedCount,1);
  assert.equal(value(report,'operatingResult'),null);
  assert.equal(report.metrics.operatingResult.knownValue,20000);
  assert.equal(details(report,'costOfGoods').find(f => f.productId === 'known-zero').value,0);
  assert.equal(details(report,'costOfGoods').find(f => f.productId === 'unknown').known,false);
  const zeroOnly = await buildBusinessReport(store,query('2026-09-15',{filters:{product:'known-zero'}}));
  assert.equal(value(zeroOnly,'costOfGoods'),0);
  assert.equal(value(zeroOnly,'operatingResult'),10000);
  const serialized = JSON.stringify(report);
  for (const privateText of ['CONTACTO-NO-EXPORTAR','3999999999','DOMICILIO-NO-EXPORTAR','privado@example.test']) assert.ok(!serialized.includes(privateText));
});

test('unknown real recognition and free gift dispatch dates are never replaced by recording dates',async t => {
  const store = await fixture(t);
  const gift = line({productType:'gift',itemId:'gift',unitPriceMinor:0,unitCostMinor:null});
  await putOrder(store,{recognition:null,items:[line(),gift],giftDispatches:[],status:'delivered'});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'netProductSales'),null);
  assert.equal(report.metrics.netProductSales.knownValue,0);
  assert.equal(value(report,'giftCost'),null);
  assert.equal(value(report,'operatingResult'),null);
  assert.equal(details(report,'giftCost')[0].occurredOn,null);
  assert.ok(report.coverage.pending.some(p => p.code === 'gift_dispatch_date_unknown'));
  const empty = await buildBusinessReport(store,query('2026-07-01'));
  assert.equal(value(empty,'netProductSales'),0);
});

test('free gift cost belongs to real dispatch; paid gift uses sales and cost sold once',async t => {
  const store = await fixture(t), free = line({productType:'gift',itemId:'free',unitPriceMinor:0,unitCostMinor:600}), paid = line({productType:'gift',itemId:'paid',unitPriceMinor:2000,unitCostMinor:700});
  const order = await putOrder(store,{items:[free,paid],recognition:{on:'2026-10-03',basis:'delivered',ruleVersionId:'historical-rule'},giftDispatches:[{lineId:free.lineId,quantity:1,on:'2026-09-29',shipmentId:'gift-shipment',eventId:'gift-dispatch'}]});
  const september = await buildBusinessReport(store,query());
  assert.equal(value(september,'netProductSales'),0);
  assert.equal(value(september,'giftCost'),600);
  assert.equal(value(september,'soldUnits'),0);
  assert.equal(value(september,'giftUnits'),1);
  const october = await buildBusinessReport(store,query('2026-10-15'));
  assert.equal(value(october,'netProductSales'),2000);
  assert.equal(value(october,'costOfGoods'),700);
  assert.equal(value(october,'giftCost'),0);
  assert.equal(value(october,'soldUnits'),1);
  assert.equal(value(october,'contribution'),1300);
  await putReturn(store,order,{occurredOn:'2026-10-04',lines:[{lineId:free.lineId,quantity:1,salesCreditMinor:0,condition:'recoverable',recoveredCostMinor:600,recognizedCostQuantity:1,unrecognizedCostQuantity:0}]});
  assert.equal(value(await buildBusinessReport(store,query('2026-10-15')),'giftCost'),-600);
});

test('unknown component cost in dispatched gift keeps result partial, never a zero-cost gift',async t => {
  const store = await fixture(t), gift = line({productType:'gift',unitPriceMinor:0,unitCostMinor:null,components:[{productId:'component',quantity:2,unitCostMinor:null}]});
  await putOrder(store,{items:[gift],giftDispatches:[{lineId:gift.lineId,quantity:1,on:'2026-09-02',shipmentId:'s',eventId:'e'}]});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'netProductSales'),0);
  assert.equal(value(report,'costOfGoods'),0);
  assert.equal(value(report,'giftCost'),null);
  assert.equal(report.metrics.giftCost.knownValue,0);
  assert.equal(value(report,'contribution'),null);
});

test('pre-recognition recoverable returns reduce first recognition; nonrecoverable loss is dated expense, not negative cost sold',async t => {
  const store = await fixture(t), item = line({quantity:3,unitPriceMinor:100,discountMinor:1,unitCostMinor:30});
  const order = await putOrder(store,{items:[item],shippingChargeMinor:50,recognition:{on:'2026-10-03',basis:'delivered',ruleVersionId:'historical-rule'}});
  const first = await putReturn(store,order,{occurredOn:'2026-09-10',lines:[{lineId:item.lineId,quantity:1,salesCreditMinor:100,condition:'recoverable',recoveredCostMinor:30,recognizedCostQuantity:0,unrecognizedCostQuantity:1}]});
  const second = await putReturn(store,order,{occurredOn:'2026-09-11',shippingCreditMinor:20,lines:[{lineId:item.lineId,quantity:1,salesCreditMinor:99,condition:'non_recoverable',recoveredCostMinor:0,recognizedCostQuantity:0,unrecognizedCostQuantity:1}]});
  await putExpense(store,{category:'other',amountMinor:30,incurredOn:'2026-09-11',orderId:order.id,sourceKey:`return-loss:${second}:${item.lineId}`});
  const september = await buildBusinessReport(store,query());
  assert.equal(value(september,'netProductSales'),0);
  assert.equal(value(september,'costOfGoods'),0);
  assert.equal(value(september,'shippingRevenue'),0);
  assert.equal(value(september,'otherExpenses'),30);
  assert.equal(value(september,'operatingResult'),-30);
  assert.equal(value(september,'returnedUnits'),2);
  const october = await buildBusinessReport(store,query('2026-10-15'));
  assert.equal(value(october,'netProductSales'),100);
  assert.equal(value(october,'costOfGoods'),30);
  assert.equal(value(october,'shippingRevenue'),30);
  assert.equal(value(october,'contribution'),100);
  assert.equal(details(october,'costOfGoods').length,1);
  assert.ok(first);
});

test('a later return and commission credit hit October while refund/payment dates cannot reduce sales twice',async t => {
  const store = await fixture(t), item = line({quantity:2,unitPriceMinor:5500000,unitCostMinor:2300000});
  const order = await putOrder(store,{items:[item],shippingChargeMinor:1200000});
  await putExpense(store,{category:'shipping_out',amountMinor:1500000,incurredOn:'2026-09-02',orderId:order.id});
  await putExpense(store,{category:'platform_fee',amountMinor:200000,incurredOn:'2026-09-02',orderId:order.id});
  await putExpense(store,{category:'commission',amountMinor:550000,incurredOn:'2026-09-05',orderId:order.id});
  await putReturn(store,order,{lines:[{lineId:item.lineId,quantity:1,salesCreditMinor:5500000,condition:'recoverable',recoveredCostMinor:2300000,recognizedCostQuantity:1,unrecognizedCostQuantity:0}]});
  await putExpense(store,{category:'shipping_return',amountMinor:700000,incurredOn:'2026-10-02',orderId:order.id});
  await putExpense(store,{category:'commission',amountMinor:-275000,incurredOn:'2026-10-02',orderId:order.id});
  await insertRow(store,'order_collections',{id:randomUUID(),order_id:order.id,shipment_id:null,kind:'refund',holder:'platform',amount_minor:5500000,occurred_on:'2026-10-03',cash_entry_id:null,reversal_of:null,external_key:null,recorded_at:recordedAt,data:'{}'});
  const september = await buildBusinessReport(store,query()), october = await buildBusinessReport(store,query('2026-10-20'));
  assert.equal(value(september,'netProductSales'),11000000);
  assert.equal(value(september,'costOfGoods'),4600000);
  assert.equal(value(october,'netProductSales'),-5500000);
  assert.equal(value(october,'costOfGoods'),-2300000);
  assert.equal(value(october,'commissions'),-275000);
  assert.equal(value(october,'contribution'),-3625000);
  assert.equal(details(october,'netProductSales').length,1);
  assert.equal(details(october,'netProductSales')[0].occurredOn,'2026-10-02');
});

test('largest remainder is signed, deterministic and conservative; unlinked salary is not allocated to products or sellers',async t => {
  const items = [line({lineId:'c',unitPriceMinor:1}),line({lineId:'a',unitPriceMinor:1}),line({lineId:'b',unitPriceMinor:1})];
  const positive = allocateReportAmount(2,items), negative = allocateReportAmount(-2,items);
  assert.deepEqual(Object.fromEntries(positive.map(p => [p.lineId,p.amountMinor])),{c:0,a:1,b:1});
  assert.deepEqual(Object.fromEntries(negative.map(p => [p.lineId,p.amountMinor])),{c:0,a:-1,b:-1});
  assert.deepEqual(allocateReportAmount(2,[...items].reverse()).sort((a,b) => a.lineId.localeCompare(b.lineId)),positive.sort((a,b) => a.lineId.localeCompare(b.lineId)));
  assert.equal(allocateReportAmount(10000000000000,items).reduce((n,p) => n+p.amountMinor,0),10000000000000);
  const free = [line({lineId:'small',unitPriceMinor:0,quantity:1}),line({lineId:'large',unitPriceMinor:0,quantity:2})];
  assert.deepEqual(allocateReportAmount(5,free),[{lineId:'small',amountMinor:2},{lineId:'large',amountMinor:3}]);
  const store = await fixture(t), sellerId = await person(store);
  const order = await putOrder(store,{items:items.map((item,i) => ({...item,itemId:`product-${i}`,unitCostMinor:0})),sellerId,sellerSnapshot:{id:sellerId,name:'Vendedor histórico',version:1},shippingChargeMinor:2});
  await putExpense(store,{category:'platform_fee',amountMinor:2,orderId:order.id});
  await putExpense(store,{category:'salary',amountMinor:1000,personId:sellerId});
  const report = await buildBusinessReport(store,query());
  assert.equal(report.metrics.platformFees.eligibleCount,1,'El cargo financiero existe una vez; su reparto solo pertenece a la vista por producto.');
  assert.equal(reportDetails(report,{metric:'platformFees',pageSize:null}).records[0].value,2);
  assert.equal(report.metrics.shippingRevenue.eligibleCount,1);
  assert.equal(report.groups.products.reduce((n,p) => n+p.contributionMinor,0),value(report,'contribution'));
  assert.equal(report.groups.sellers[0].contributionMinor,value(report,'contribution'));
  assert.equal(value(report,'operatingResult'),value(report,'contribution')-1000);
  assert.equal(report.groups.sellers[0].label,'Vendedor histórico');
  assert.ok(report.groups.products.every(group => group.label === 'Nombre histórico A'));
  const filtered = await buildBusinessReport(store,query('2026-09-01',{filters:{product:'product-1'}}));
  assert.equal(value(filtered,'platformFees'),1);
  assert.equal(value(filtered,'fixedSalary'),0);
});

test('period partitions and Bogotá midnight boundaries share the same real-date criteria',async t => {
  const store = await fixture(t);
  const dates = ['2025-12-29','2025-12-31','2026-01-01','2026-03-31','2026-04-01','2026-06-30','2026-07-01','2026-10-31','2026-11-01','2026-12-31'];
  for (const date of dates) await putOrder(store,{placedOn:date,recognition:{on:date,basis:'confirmed',ruleVersionId:'historical-rule'},items:[line({unitPriceMinor:123,unitCostMinor:23})]});
  const year = await buildBusinessReport(store,query('2026-03-15',{period:'year'}));
  const months = await Promise.all(Array.from({length:12},(_,i) => buildBusinessReport(store,query(`2026-${String(i+1).padStart(2,'0')}-15`))));
  for (const key of ['netProductSales','costOfGoods','contribution','recognizedOrders']) assert.equal(value(year,key),months.reduce((n,r) => n+value(r,key),0));
  const halves = await Promise.all(['2026-01-01','2026-07-01'].map(anchor => buildBusinessReport(store,query(anchor,{period:'halfyear'}))));
  const quarters = await Promise.all(['2026-01-01','2026-04-01','2026-07-01','2026-10-01'].map(anchor => buildBusinessReport(store,query(anchor,{period:'quarter'}))));
  assert.equal(value(year,'contribution'),halves.reduce((n,r) => n+value(r,'contribution'),0));
  assert.equal(value(year,'contribution'),quarters.reduce((n,r) => n+value(r,'contribution'),0));
  const week = await buildBusinessReport(store,query('2026-01-01',{period:'week'}));
  assert.deepEqual(week.bounds,periodBounds('week','2026-01-01'));
  const days = await Promise.all(Array.from({length:7},(_,i) => buildBusinessReport(store,query(addDays(week.bounds.startDate,i),{period:'day'}))));
  assert.equal(value(week,'netProductSales'),days.reduce((n,r) => n+value(r,'netProductSales'),0));
  await putShipment(store,null,{estimatedDeliveryOn:'2026-10-31',events:[{status:'delivered',occurredAt:'2026-11-01T04:59:59Z'}]});
  await putShipment(store,null,{estimatedDeliveryOn:'2026-11-01',events:[{status:'delivered',occurredAt:'2026-11-01T05:00:00Z'}]});
  const october = await buildBusinessReport(store,query('2026-10-15')), november = await buildBusinessReport(store,query('2026-11-15'));
  assert.equal(october.metrics.onTimeDeliveries.denominator,1);
  assert.equal(november.metrics.onTimeDeliveries.denominator,1);
  assert.equal(bogotaDate('2026-11-01T04:59:59Z'),'2026-10-31');
});

test('logistic rates use real resolution denominators once per guide, independently of commercial returns',async t => {
  const store = await fixture(t), order = await putOrder(store,{status:'delivered'});
  await putShipment(store,order.id,{status:'returned',estimatedDeliveryOn:'2026-09-04',events:[{status:'collected',occurredOn:'2026-09-02'},{status:'delivered',occurredOn:'2026-09-03'},{status:'returned',occurredOn:'2026-10-02'}]});
  await putShipment(store,null,{status:'returned',events:[{status:'returned',occurredOn:'2026-09-15'},{status:'returned',occurredOn:'2026-09-15'}]});
  await putShipment(store,null,{status:'delivered',events:[{status:'delivered',sourceAsOf:'2026-09-16T12:00:00Z'}]});
  await putShipment(store,null,{status:'delivered',events:[{status:'delivered',occurredOn:'2026-09-18'}]});
  const september = await buildBusinessReport(store,query());
  assert.equal(september.metrics.shipmentReturnRate.numerator,1);
  assert.equal(september.metrics.shipmentReturnRate.denominator,2);
  assert.equal(value(september,'shipmentReturnRate'),5000);
  assert.equal(september.metrics.shipmentReturnRate.excludedCount,1);
  assert.equal(september.metrics.onTimeDeliveries.denominator,1);
  assert.equal(september.metrics.onTimeDeliveries.excludedCount,2);
  assert.equal(value(september,'returnedUnits'),0);
  const october = await buildBusinessReport(store,query('2026-10-15',{filters:{status:'returned'}}));
  assert.equal(october.metrics.shipmentReturnRate.denominator,1);
  assert.equal(october.metrics.shipmentReturnRate.numerator,1);
  assert.equal(october.groups.shipments.length,1);
  assert.equal(value(october,'netProductSales'),0);
  const none = await buildBusinessReport(store,query('2026-07-15'));
  assert.equal(value(none,'onTimeDeliveries'),null);
  assert.equal(none.metrics.onTimeDeliveries.denominator,0);
});

test('explicit zero logistics are complete; missing charges and dates stay visible and excluded',async t => {
  const store = await fixture(t), order = await putOrder(store);
  const shipmentId = await putShipment(store,order.id,{costStatus:'unknown',costStatuses:{shipping_out:'unknown'},events:[{status:'delivered',occurredOn:'2026-09-03'}]});
  await putExpense(store,{category:'platform_fee',amountMinor:50,incurredOn:null,orderId:order.id,shipmentId});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'shippingCosts'),null);
  assert.equal(value(report,'platformFees'),null);
  assert.equal(value(report,'contribution'),null);
  assert.ok(report.coverage.pending.some(p => p.code === 'expense_date_unknown'));
  assert.equal(report.groups.costs[0].occurredOn,null);
  assert.equal(details(report,'platformFees')[0].amountMinor,50);
  const zeroStore = await fixture(t), zeroOrder = await putOrder(zeroStore);
  await putShipment(zeroStore,zeroOrder.id,{events:[{status:'delivered',occurredOn:'2026-09-03'}]});
  assert.equal(value(await buildBusinessReport(zeroStore,query()),'shippingCosts'),0);
});

test('undated native Excel collections preserve platform held money but do not create dated receipts or cash',async t => {
  const store = await fixture(t), order = await putOrder(store), collectionId = randomUUID();
  await insertRow(store,'order_collections',{id:collectionId,order_id:order.id,shipment_id:null,kind:'receipt',holder:'platform',amount_minor:10000,occurred_on:null,cash_entry_id:null,reversal_of:null,external_key:null,recorded_at:recordedAt,data:JSON.stringify({source:'excel',sourceAsOf:'2026-09-05T12:00:00Z',requiresDateReview:true})});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'platformPending'),10000);
  assert.equal(value(report,'customerCollections'),null);
  assert.equal(report.metrics.customerCollections.knownValue,0);
  assert.equal(value(report,'cashAvailable'),0);
  assert.equal(report.coverage.undatedCollections,1);
  assert.equal(details(report,'customerCollections')[0].reason,'excel_collection_date_unknown');
});

test('missing salary accrual is readonly partial coverage, not a fabricated expense or salary assigned to product',async t => {
  const store = await fixture(t);
  await person(store,{salaryAgreements:[{id:'salary-agreement',enabled:true,amountPerPeriodMinor:1000,frequency:'monthly',effectiveFrom:'2026-09-01',effectiveTo:'2026-09-02'}]});
  const order = await putOrder(store);
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'fixedSalary'),null);
  assert.equal(report.metrics.fixedSalary.excludedCount,2);
  assert.equal(value(report,'operatingResult'),null);
  assert.equal(value(report,'contribution'),7000);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM expenses')).count,0);
  const product = await buildBusinessReport(store,query('2026-09-15',{filters:{product:order.items[0].itemId}}));
  assert.equal(value(product,'fixedSalary'),0);
  assert.equal(value(product,'operatingResult'),7000);
});

test('live reads use one readonly snapshot, cannot increment counters, and exact drills paginate without recomputation',async t => {
  const store = await fixture(t);
  for (let i=0; i<25; i++) await putOrder(store,{items:[line({itemId:`item-${i}`})]});
  const before = await store.db.all('SELECT * FROM counters ORDER BY id');
  let snapshots = 0;
  const reader = {readSnapshot:fn => {snapshots++; return store.readSnapshot(fn);}};
  const report = await buildBusinessReport(reader,query());
  assert.equal(snapshots,1);
  assert.deepEqual(await store.db.all('SELECT * FROM counters ORDER BY id'),before);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM business_requests')).count,0);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM report_snapshots')).count,0);
  assert.equal(reportDetails(report,{metric:'netProductSales'}).records.length,20);
  assert.equal(reportDetails(report,{metric:'netProductSales',page:2}).records.length,5);
  assert.equal(reportDetails(report,{metric:'netProductSales',pageSize:null}).records.length,25);
  assert.ok(reportDetails(report,{pageSize:null}).records.every(fact => fact.metric));
  assert.throws(() => reportDetails(report,{metric:'missing'}));
  assert.throws(() => normalizeReportQuery({filters:{status:'invented'}}));
  assert.deepEqual(normalizeReportQuery({anchorDate:'2026-09-29',asOf,filters:{seller:'seller',contact:'discard'}}).filters,{seller:'seller'});
});

test('late facts create a new immutable revision; same facts and unrelated revision changes deduplicate',async t => {
  const store = await fixture(t), order = await putOrder(store);
  const first = await generateReportSnapshot(store,query(),actor,{now:asOf});
  const originalJSON = (await store.db.get('SELECT data FROM report_snapshots WHERE id=?',[first.snapshot.id])).data;
  await store.transaction(async tx => {await tx.lockWrites(); await bumpRevision(tx,['2026-09-05']);});
  const unchanged = await generateReportSnapshot(store,query('2026-09-29',{asOf:'2027-02-03T12:00:00Z'}),actor,{now:'2027-02-03T12:00:00Z'});
  assert.equal(unchanged.snapshot.id,first.snapshot.id);
  assert.equal(unchanged.snapshot.revision,1);
  await putExpense(store,{category:'other',amountMinor:1000,incurredOn:'2026-09-05',orderId:order.id});
  await store.transaction(async tx => {await tx.lockWrites(); await bumpRevision(tx,['2026-09-05']);});
  const updated = await generateReportSnapshot(store,query(),actor,{now:asOf});
  assert.equal(updated.snapshot.revision,2);
  assert.notEqual(updated.factHash,first.factHash);
  assert.equal(value(updated,'operatingResult'),6000);
  const old = await getReportSnapshot(store,first.snapshot.id);
  assert.equal(value(old,'operatingResult'),7000);
  assert.equal(old.snapshot.state,'superseded');
  assert.equal((await store.db.get('SELECT data FROM report_snapshots WHERE id=?',[first.snapshot.id])).data,originalJSON);
  const saved = await listReportSnapshots(store,{period:'month',anchorDate:'2026-09-09'});
  assert.equal(saved.total,2);
  assert.ok(saved.records.every(row => !row.facts && !row.metrics));
  assert.equal(saved.pageSize,20);
});

test('concurrent snapshot calculations serialize revisions and stale captures cannot become current',async t => {
  const store = await fixture(t);
  await putOrder(store);
  const snapshots = await Promise.all([generateReportSnapshot(store,query(),actor,{now:asOf}),generateReportSnapshot(store,query(),actor,{now:asOf})]);
  assert.equal(snapshots[0].snapshot.id,snapshots[1].snapshot.id);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM report_snapshots')).count,1);
  const staleReader = {
    readSnapshot:async fn => {
      const report = await store.readSnapshot(fn);
      await store.transaction(async tx => {await tx.lockWrites(); await bumpRevision(tx,['2026-10-01']);});
      return report;
    },
    transaction:store.transaction.bind(store),
  };
  const captured = await generateReportSnapshot(staleReader,query('2026-10-01'),actor,{now:asOf});
  assert.equal(captured.snapshot.state,'stale');
  assert.equal(captured.snapshot.staleSince,asOf);
  const refreshed = await generateReportSnapshot(store,query('2026-10-01'),actor,{now:asOf});
  assert.equal(refreshed.snapshot.id,captured.snapshot.id);
  assert.equal(refreshed.snapshot.state,'current');
});

test('durable requests are actor-bound, preserve active workers and original actor, and identical job reruns add no revision',async t => {
  const store = await fixture(t);
  await assert.rejects(async()=>saveReportSnapshot(store,null,actor),{status:400});
  await putOrder(store);
  const beforeRevision = (await store.db.get("SELECT value FROM counters WHERE id='business_revision'")).value;
  const input = {period:'month',anchorDate:'2026-09-07',requestId:requestId()};
  const request = await saveReportSnapshot(store,input,actor);
  assert.equal(request.state,'queued');
  assert.deepEqual(await saveReportSnapshot(store,input,actor),request);
  await assert.rejects(saveReportSnapshot(store,input,'different-admin'),error => error.status === 409);
  const lease = await claimJob(store,{key:request.jobKey,now:asOf});
  const shared = await saveReportSnapshot(store,{...input,requestId:requestId()},'different-admin');
  assert.equal(shared.state,'running');
  const jobRow = await store.db.get('SELECT * FROM job_runs WHERE key=?',[request.jobKey]);
  assert.equal(jobRow.lease_token,lease.token);
  assert.equal(JSON.parse(jobRow.data).requestedBy,actor);
  const reclaimAt = '2027-02-02T12:02:01.000Z';
  const turns = await Promise.all([processReportTurn(store,{now:reclaimAt}),processReportTurn(store,{now:reclaimAt})]);
  assert.equal(turns.reduce((n,r) => n+r.processed,0),1);
  const saved = await listReportSnapshots(store,{period:'month',anchorDate:'2026-09-20'});
  assert.equal(saved.total,1);
  assert.equal(saved.job.state,'succeeded');
  assert.ok(!JSON.stringify(saved.job).includes('token'));
  assert.equal((await store.db.get("SELECT value FROM counters WHERE id='business_revision'")).value,beforeRevision);
  await saveReportSnapshot(store,{...input,requestId:requestId()},actor);
  await processReportTurn(store,{now:'2027-02-03T12:00:00Z'});
  assert.equal((await listReportSnapshots(store,{period:'month',anchorDate:'2026-09-01'})).total,1);
});

test('lease loss blocks persistence and invalid durable report data fails without leaking the error text',async t => {
  const store = await fixture(t);
  await putOrder(store);
  const request = await saveReportSnapshot(store,{period:'month',anchorDate:'2026-09-01',requestId:requestId()},actor);
  const old = await claimJob(store,{key:request.jobKey,now:asOf});
  await claimJob(store,{key:request.jobKey,now:'2027-02-02T12:02:01Z'});
  await assert.rejects(generateReportSnapshot(store,query(),actor,{lease:old,now:'2027-02-02T12:02:02Z'}),error => error.status === 409);
  assert.equal((await store.db.get('SELECT COUNT(*) AS count FROM report_snapshots')).count,0);
  await store.transaction(async tx => {await tx.lockWrites();await queueJobTx(tx,'report:invalid',{query:{period:'invalid'},requestedBy:actor},{now:asOf});});
  await processReportTurn(store,{maxReports:1,now:asOf});
  const bad = await store.db.get('SELECT * FROM job_runs WHERE key=?',['report:invalid']);
  assert.equal(bad.state,'failed');
  assert.equal(bad.error_code,'REPORT_INVALID');
});

test('nonrecoverable returns retain recognized cost and cancellations reverse only the commercial agreement',async t => {
  const store = await fixture(t), damagedLine = line({unitCostMinor:3000});
  const damaged = await putOrder(store,{items:[damagedLine]});
  await putReturn(store,damaged,{lines:[{lineId:damagedLine.lineId,quantity:1,salesCreditMinor:10000,condition:'non_recoverable',recoveredCostMinor:0,recognizedCostQuantity:1,unrecognizedCostQuantity:0}]});
  const october = await buildBusinessReport(store,query('2026-10-10'));
  assert.equal(value(october,'netProductSales'),-10000);
  assert.equal(value(october,'costOfGoods'),0);
  assert.equal(value(october,'contribution'),-10000);
  const cancelledLine = line({itemId:'cancelled-item',unitCostMinor:2000});
  const cancelled = await putOrder(store,{status:'cancelled',items:[cancelledLine],shippingChargeMinor:500,recognition:{on:'2026-09-01',basis:'confirmed',ruleVersionId:'historical-rule'},dispatchedOn:null});
  await putReturn(store,cancelled,{kind:'cancellation',occurredOn:'2026-09-02',shippingCreditMinor:500,lines:[{lineId:cancelledLine.lineId,quantity:1,salesCreditMinor:10000,condition:'recoverable',recoveredCostMinor:2000,recognizedCostQuantity:1,unrecognizedCostQuantity:0}]});
  const report = await buildBusinessReport(store,query('2026-09-10',{filters:{product:'cancelled-item'}}));
  assert.equal(value(report,'netProductSales'),0);
  assert.equal(value(report,'costOfGoods'),0);
  assert.equal(value(report,'shippingRevenue'),0);
  assert.equal(value(report,'cancelledUnits'),1);
  assert.equal(value(report,'returnedUnits'),0);
  assert.equal(value(report,'customerCollections'),0);
  assert.equal(value(report,'cashAvailable'),0);
});

test('cash cutoffs, openings, transfers, closings and signed payroll offsets/payments remain separate from period result',async t => {
  const store = await fixture(t), personId = await person(store), a = randomUUID(), b = randomUUID(), payrollId = randomUUID();
  for (const [id,name] of [[a,'Banco A'],[b,'Caja B']]) await insertRow(store,'cash_accounts',{id,name,type:'bank',opening_on:'2026-09-01',responsible_id:personId,active:1,version:1,created_at:recordedAt,updated_at:recordedAt,data:'{}'});
  const entry = async (accountId,effectiveOn,amountMinor,kind,extra = {}) => {
    const id = randomUUID();
    await insertRow(store,'cash_entries',{id,account_id:accountId,effective_on:effectiveOn,amount_minor:amountMinor,kind,source_type:kind,source_id:id,transfer_id:extra.transferId || null,reversal_of:extra.reversalOf || null,recorded_at:recordedAt,data:JSON.stringify(extra)});
    return id;
  };
  await entry(a,'2026-09-01',10000,'opening');
  await entry(b,'2026-09-01',0,'opening');
  const transferId = randomUUID();
  await entry(a,'2026-09-10',-2000,'transfer',{transferId});
  await entry(b,'2026-09-10',2000,'transfer',{transferId});
  const salary = await putExpense(store,{category:'salary',personId,amountMinor:1000,incurredOn:'2026-09-15'});
  const credit = await putExpense(store,{category:'commission',personId,amountMinor:-275,incurredOn:'2026-09-15'});
  await insertRow(store,'payroll_periods',{id:payrollId,person_id:personId,start_on:'2026-09-01',end_on_exclusive:'2026-10-01',due_on:'2026-09-30',state:'paid',version:1,created_at:recordedAt,updated_at:recordedAt,data:'{}'});
  await insertRow(store,'payroll_offsets',{id:randomUUID(),payroll_id:payrollId,debit_expense_id:salary,credit_expense_id:credit,amount_minor:275,reversal_of:null,recorded_at:'2026-09-20T12:00:00.000Z'});
  const paidCash = await entry(a,'2026-09-20',-725,'payroll_payment');
  const paymentId = randomUUID();
  await insertRow(store,'expense_payments',{id:paymentId,expense_id:salary,kind:'payment',cash_entry_id:paidCash,settlement_receipt_id:null,amount_minor:725,reversal_of:null,recorded_at:recordedAt,data:'{}'});
  await entry(a,'2026-10-01',1000,'owner_funding');
  await insertRow(store,'cash_closings',{id:randomUUID(),account_id:b,closing_on:'2026-09-30',revision:1,state:'closed',expected_minor:2000,counted_minor:1999,difference_minor:-1,responsible_id:personId,recorded_at:recordedAt,data:'{}',version:1,created_at:recordedAt,updated_at:recordedAt});
  const september = await buildBusinessReport(store,query());
  assert.equal(value(september,'cashAvailable'),9275);
  assert.equal(value(september,'netProductSales'),0);
  assert.equal(value(september,'payrollEarned'),725);
  assert.equal(value(september,'payrollPaid'),725);
  assert.equal(value(september,'payrollOutstanding'),0);
  assert.equal(value(september,'operatingResult'),-725);
  assert.equal(september.groups.payroll[0].creditMinor,0);
  assert.equal(september.groups.accounts.reduce((n,account) => n+account.transferMinor,0),0);
  assert.equal(value(september,'cashClosingDifference'),-1);
  assert.equal(september.groups.accounts.find(account => account.id === b).closing.differenceMinor,-1);
  const accountOnly = await buildBusinessReport(store,query('2026-09-01',{filters:{account:a}}));
  assert.equal(value(accountOnly,'cashAvailable'),7275);
  assert.equal(value(accountOnly,'operatingResult'),-725);
  const reversalCash = await entry(a,'2026-10-05',725,'reversal',{reversalOf:paidCash});
  await insertRow(store,'expense_payments',{id:randomUUID(),expense_id:salary,kind:'reversal',cash_entry_id:reversalCash,settlement_receipt_id:null,amount_minor:-725,reversal_of:paymentId,recorded_at:recordedAt,data:'{}'});
  const october = await buildBusinessReport(store,query('2026-10-15'));
  assert.equal(value(october,'payrollEarned'),0);
  assert.equal(value(october,'payrollPaid'),-725);
  assert.equal(value(october,'payrollOutstanding'),725);
  assert.equal(value(october,'cashAvailable'),11000);
  assert.equal(value(october,'operatingResult'),0);
  assert.equal(value(await buildBusinessReport(store,query()),'cashAvailable'),9275);
});

test('undated timeless observations remain visible without inventing dates or logistic rate denominators',async t => {
  const store = await fixture(t);
  await putShipment(store,null,{status:'returned',events:[{status:'returned'}]});
  const report = await buildBusinessReport(store,query());
  assert.equal(report.groups.shipments.length,1);
  assert.equal(report.groups.shipments[0].returnedOn,null);
  assert.equal(report.groups.shipments[0].status,'returned');
  assert.equal(value(report,'shipmentReturnRate'),null);
  assert.equal(report.metrics.shipmentReturnRate.denominator,0);
  assert.equal(report.metrics.shipmentReturnRate.excludedCount,1);
  assert.equal(report.groups.shipments[0].transitDays,null);
});

test('clock-only changes do not create an open-period revision when material facts remain unchanged',async t => {
  const store = await fixture(t);
  await putOrder(store);
  const first = await generateReportSnapshot(store,query('2026-09-01',{asOf:'2026-09-10T12:00:00Z'}),actor,{now:'2026-09-10T12:00:00Z'});
  const second = await generateReportSnapshot(store,query('2026-09-01',{asOf:'2026-09-11T12:00:00Z'}),actor,{now:'2026-09-11T12:00:00Z'});
  assert.equal(first.factHash,second.factHash);
  assert.equal(first.snapshot.id,second.snapshot.id);
});

test('undated payroll and unreconciled legacy money cannot be reported as known zero obligations or confirmed receipts',async t => {
  const store = await fixture(t), personId = await person(store), order = await putOrder(store);
  await putExpense(store,{category:'salary',personId,amountMinor:1000,incurredOn:null});
  await insertRow(store,'order_collections',{id:randomUUID(),order_id:order.id,shipment_id:null,kind:'receipt',holder:'legacy',amount_minor:2000000,occurred_on:'2026-09-04',cash_entry_id:null,reversal_of:null,external_key:null,recorded_at:recordedAt,data:JSON.stringify({requiresReconciliation:true,source:'legacy'})});
  const report = await buildBusinessReport(store,query());
  assert.equal(value(report,'payrollOutstanding'),null);
  assert.equal(value(report,'payrollEarned'),null);
  assert.equal(value(report,'customerCollections'),null);
  assert.equal(value(report,'cashAvailable'),0);
  assert.equal(details(report,'customerCollections')[0].amountMinor,2000000);
  assert.equal(details(report,'customerCollections')[0].reason,'legacy_collection_unreconciled');
  assert.equal(details(report,'payrollOutstanding')[0].reason,'expense_date_unknown');
  assert.equal(report.groups.payroll[0].outstandingMinor,null);
  assert.equal(report.groups.payroll[0].knownOutstandingMinor,0);
  assert.equal(report.groups.payroll[0].complete,false);
});

test('voiding an undated platform observation and recording its proven date removes ghost coverage without inventing cash',async t=>{
  const {createBusinessBasics,businessOrderInput}=await import('./business-fixtures.mjs');
  const {createShipment}=await import('../lib/business/shipments.mjs');
  const {recordCollectionTx,recordCollection}=await import('../lib/business/collections.mjs');
  const {reverseFinancialDocument}=await import('../lib/business/finance.mjs');
  const {runCommand}=await import('../lib/business/commands.mjs');
  const store=await fixture(t),f=await createBusinessBasics(store,{actorId:actor});
  const order=await store.saveOrder(businessOrderInput(f.a,{year:f.year}),actor);
  const shipment=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:f.platform.id,sourceId:f.source.id,carrier:'Fuente real',tracking:'000-fecha-revisada'},actor);
  const originalInput={requestId:requestId(),orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,sourceId:f.source.id,
    externalKey:'RECAUDO-SIN-FECHA',holder:'platform',amountMinor:order.totalMinor,occurredOn:null,source:'excel',sourceAsOf:`${f.year}-09-05T12:00:00.000Z`,method:'Contraentrega',reference:'Corte conocido sin fecha de recaudo'};
  const original=await runCommand(store,{scope:'test:undated-observation',requestId:originalInput.requestId,payload:originalInput,actorId:actor},tx=>recordCollectionTx(tx,originalInput,actor,{allowUnknownDate:true}));
  await reverseFinancialDocument(store,{requestId:requestId(),documentType:'collection',documentId:original.id,version:1,effectiveOn:`${f.year}-10-02`,reason:'Anular observación sin fecha antes de registrar el soporte real'},actor);
  const corrected=await recordCollection(store,{requestId:requestId(),orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,sourceId:f.source.id,
    externalKey:'RECAUDO-FECHA-COMPROBADA',holder:'platform',amountMinor:order.totalMinor,occurredOn:`${f.year}-09-03`,method:'Contraentrega',reference:'Soporte comprobado de fecha real'},actor);
  const report=await buildBusinessReport(store,{period:'month',anchorDate:`${f.year}-09-01`,asOf:`${f.year}-10-16T17:00:00.000Z`});
  assert.equal(report.metrics.customerCollections.value,order.totalMinor);assert.equal(report.metrics.customerCollections.complete,true);
  assert.equal(report.metrics.platformPending.value,order.totalMinor);
  assert.equal(report.metrics.cashAvailable.value,10000000,'La plataforma no crea otro depósito bancario al corregir su fecha.');
  assert.deepEqual(details(report,'customerCollections').map(row=>row.entityId),[corrected.id]);
  assert.equal(report.coverage.undatedCollections,0);
  assert.equal(report.coverage.pending.some(row=>row.code==='excel_collection_date_unknown'),false);
});

test('a daily-cut collection stays unknown-date money today and never proves a balance before its observation',async t=>{
  const store=await fixture(t),order=await putOrder(store),id=randomUUID();
  await insertRow(store,'order_collections',{id,order_id:order.id,shipment_id:null,kind:'receipt',holder:'platform',amount_minor:10000,occurred_on:null,cash_entry_id:null,reversal_of:null,external_key:null,recorded_at:recordedAt,
    data:JSON.stringify({source:'excel',sourceAsOf:'2026-10-01T04:59:59.999Z',requiresDateReview:true})});
  const current=await buildBusinessReport(store,{period:'month',anchorDate:'2026-09-01',asOf:'2026-09-30T17:00:00.000Z'});
  assert.equal(current.metrics.customerCollections.value,null);assert.equal(current.metrics.customerCollections.excludedCount,1);
  assert.equal(current.metrics.platformPending.value,10000);
  const earlier=await buildBusinessReport(store,{period:'day',anchorDate:'2026-09-15',asOf:'2026-09-30T17:00:00.000Z'});
  assert.equal(earlier.metrics.platformPending.value,null);assert.equal(earlier.metrics.platformPending.excludedCount,1);
  assert.equal(earlier.metrics.cashAvailable.value,0);
});
