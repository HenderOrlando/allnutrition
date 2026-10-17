import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openSQLite } from '../lib/db/sqlite.mjs';
import { Store } from '../lib/store.mjs';
import { migrateBusinessV3 } from '../lib/db/migrations.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { buildDashboard } from '../lib/business/dashboard.mjs';
import { schedulerHealth } from '../lib/business/job-leases.mjs';
import { liveReportClientData } from '../lib/business/report-export.mjs';
import { createBusinessBasics, createBusinessFixture, returnBusinessFixture } from './business-fixtures.mjs';

const now='2026-10-16T17:00:00.000Z', actor='dashboard-admin';
async function fixture(t) {
  const store=new Store(await openSQLite(':memory:'));t.after(()=>store.close());
  await store.initialize();await migrateBusinessV3(store);return store;
}
async function order(store,on,{price=10000,cost=2000}={}) {
  const id=randomUUID(),number=Number((await store.db.get('SELECT COALESCE(MAX(number),0)+1 AS number FROM orders')).number);
  const data={placedOn:on,status:'delivered',sellerId:null,customerName:'NOLEAK-NAME',phone:'NOLEAK-PHONE',address:'NOLEAK-ADDRESS',
    items:[{lineId:randomUUID(),kind:'products',itemId:'historical-product',productType:'product',title:'Producto histórico',quantity:1,unitPriceMinor:price,discountMinor:0,unitCostMinor:cost,components:[]}],
    shippingChargeMinor:0,totalMinor:price,subtotalMinor:price,giftDispatches:[],recognition:{on,basis:'delivered',ruleVersionId:'historical'},
    ruleSnapshot:{id:'historical',effectiveOn:'2026-01-01',saleRecognition:'delivered',commission:{enabled:false}},deliverySummary:{complete:true}};
  await insertRow(store,'orders',{id,number,version:1,data:JSON.stringify(data),created_at:now,updated_at:now});return id;
}

test('opening balance and catalog alone retain real empty actions rather than numeric health cards',async t=>{
  const store=await fixture(t),basics=await createBusinessBasics(store);
  const dashboard=await buildDashboard(store,{period:'month',anchor:`${basics.year}-09-01`},{now:`${basics.year}-10-16T17:00:00Z`});
  assert.equal(dashboard.empty,true);assert.equal(dashboard.setup.productCount,3);assert.equal(dashboard.setup.accountCount,1);
  assert.equal(dashboard.cash.availableMinor,10000000);assert.equal(dashboard.setup.firstAccountId,basics.account.id);
  assert.equal(dashboard.automation.status,'never');assert.ok(dashboard.attention.records.some(row=>row.kind==='automation'));
});

test('historical operating figures and current available cash use distinct cuts without reader writes or contacts',async t=>{
  const store=await fixture(t),f=await createBusinessFixture(store,{pay:true});await returnBusinessFixture(store,f,{refund:true});
  const revision=await store.db.get("SELECT value FROM counters WHERE id='business_revision'");
  const dashboard=await buildDashboard(store,{period:'month',anchor:`${f.year}-09-01`},{now:`${f.year}-10-16T17:00:00Z`});
  assert.equal(dashboard.empty,false);assert.equal(dashboard.metrics.netProductSales.value,11000000);
  assert.equal(dashboard.metrics.operatingResult.value,3750000);assert.equal(dashboard.cash.availableMinor,12750000);
  assert.equal(dashboard.cash.asOf,`${f.year}-10-16`);assert.equal(dashboard.bounds.startDate,`${f.year}-09-01`);
  assert.deepEqual(await store.db.get("SELECT value FROM counters WHERE id='business_revision'"),revision);
  assert.equal(JSON.stringify(dashboard).includes('3001234567'),false);assert.equal(JSON.stringify(dashboard).includes('Dirección sintética'),false);
});

test('open comparisons and their exact drill exclude unfinished today from both economic tranches',async t=>{
  const store=await fixture(t);
  const early=await order(store,'2026-09-05');await order(store,'2026-09-16',{price:5000,cost:1000});
  await order(store,'2026-08-05',{price:5000,cost:1000});await order(store,'2026-08-16',{price:3000,cost:1000});
  const cut='2026-09-16T17:00:00Z',query={period:'month',anchorDate:'2026-09-01',asOf:cut};
  const dashboard=await buildDashboard(store,query,{now:cut});
  assert.equal(dashboard.metrics.netProductSales.value,15000);assert.equal(dashboard.comparison.equivalent,true);
  assert.equal(dashboard.comparison.currentBounds.endDateExclusive,'2026-09-16');assert.equal(dashboard.comparison.previousBounds.endDateExclusive,'2026-08-16');
  assert.equal(dashboard.insights.comparison.currentValues.contribution,8000);assert.equal(dashboard.insights.comparison.previousValues.contribution,4000);
  const growth=dashboard.insights.successes.find(row=>row.id==='contribution_growth');assert.equal(growth.action.view.issue,'comparison_elapsed');
  const data=await liveReportClientData(store,query,{metric:'contribution',issue:'comparison_elapsed'});
  assert.equal(data.metrics.contribution.value,12000);assert.equal(data.details.metricSummary.value,8000);
  assert.equal(data.details.bounds.endDateExclusive,'2026-09-16');assert.ok(data.details.records.every(row=>row.orderId===early));
});

test('short previous months and a first-day cut expose values but never directional comparisons',async t=>{
  const store=await fixture(t);await order(store,'2026-03-30');await order(store,'2026-02-28');
  const short=await buildDashboard(store,{period:'month',anchor:'2026-03-01'},{now:'2026-03-31T17:00:00Z'});
  assert.equal(short.comparison.equivalent,false);assert.equal(short.comparison.currentBounds.endDateExclusive,'2026-03-31');
  assert.equal(short.comparison.previousBounds.endDateExclusive,'2026-03-01');assert.equal(short.insights.comparison.currentValues.contribution,8000);
  assert.equal(short.insights.comparison.previousValues.contribution,8000);assert.equal(short.insights.successes.length,0);
  const first=await buildDashboard(store,{period:'month',anchor:'2026-04-01'},{now:'2026-04-01T17:00:00Z'});
  assert.equal(first.comparison.equivalent,false);assert.equal(first.insights.comparison.previousValues.contribution,8000);
});

test('completed-day logistics use their own cutoff without altering the full-period resolution criterion',async t=>{
  const store=await fixture(t),orderId=await order(store,'2026-10-10'),shipmentId=randomUUID();
  await insertRow(store,'shipments',{id:shipmentId,order_id:orderId,platform_id:null,source_id:null,external_id:null,identity_key:null,
    status:'returned',carrier:'Transportadora real',tracking:'0001',source_as_of:null,version:1,created_at:now,updated_at:now,
    data:JSON.stringify({estimatedDeliveryOn:'2026-10-11',costStatus:'known',costStatuses:{shipping_out:'known'}})});
  for(const [status,on] of [['delivered','2026-10-10'],['returned','2026-10-16']])await insertRow(store,'shipment_events',{
    id:randomUUID(),shipment_id:shipmentId,external_key:null,status,occurred_on:on,occurred_at:null,source_as_of:null,recorded_at:now,data:'{}'});
  const data=await liveReportClientData(store,{period:'month',anchorDate:'2026-10-01',asOf:now},{metric:'shipmentReturnRate',issue:'comparison_elapsed'});
  assert.equal(data.metrics.shipmentReturnRate.value,10000);assert.equal(data.details.metricSummary.value,0);
  assert.equal(data.details.metricSummary.denominator,1);assert.equal(data.details.records[0].occurredOn,'2026-10-10');
  assert.equal(data.details.bounds.endDateExclusive,'2026-10-16');
});

test('persisted acknowledgement remains actionable and priority/date/id pagination merges informational health honestly',async t=>{
  const store=await fixture(t),person=await saveResource(store,'people',{requestId:randomUUID(),name:'Responsable real'},actor);
  const ids=[];
  for(let i=0;i<27;i++){
    const account=await saveAccount(store,{requestId:randomUUID(),name:'Cuenta '+i,type:'bank',responsibleId:person.id,openingOn:'2026-01-01',openingBalanceMinor:0,minimumMinor:100},actor);
    const id='alert-'+String(i).padStart(2,'0');ids.push(id);
    await insertRow(store,'alerts',{id,rule_id:'cash_below_minimum',entity_type:'cash_account',entity_id:account.id,episode:1,
      state:i===2?'acknowledged':'open',severity:i===1||i===2?'critical':i===0?'warning':'info',first_seen_at:`2026-08-${String(i===2?1:i+1).padStart(2,'0')}T12:00:00.000Z`,last_seen_at:now,
      responsible_id:person.id,version:1,created_at:now,updated_at:now,data:JSON.stringify({reason:'Saldo 0 COP inferior al mínimo configurado de 1 COP.',amountMinor:0,count:1})});
  }
  const summary=await buildDashboard(store,{}, {now});
  assert.equal(summary.attention.total,28);assert.equal(summary.attention.records.length,5);
  assert.deepEqual(summary.attention.records.slice(0,3).map(row=>row.id),[ids[2],ids[1],ids[0]]);
  assert.equal(summary.attention.records[0].state,'acknowledged');assert.equal(summary.attention.records[0].responsibleName,person.name);
  assert.equal(summary.attention.records[0].action.view.section,'cash');
  const page=await buildDashboard(store,{issue:'attention',page:2},{now});
  assert.equal(page.attention.records.length,8);assert.equal(new Set([...summary.attention.records,...page.attention.records].map(row=>row.id)).size,13);
  assert.ok(page.attention.records.some(row=>row.kind==='automation'));
  const critical=await buildDashboard(store,{issue:'attention',status:'critical',page:999},{now});
  assert.equal(critical.attention.total,2);assert.equal(critical.attention.page,1);assert.ok(critical.attention.records.every(row=>row.severity==='critical'));
});

test('missing-data drill is the exact unknown subset and cannot show the complete grand total',async t=>{
  const store=await fixture(t);await order(store,'2026-09-01');const unknown=await order(store,'2026-09-02',{cost:null});
  const data=await liveReportClientData(store,{period:'month',anchorDate:'2026-09-01',asOf:now},{metric:'operatingResult',issue:'missing'});
  assert.equal(data.metrics.operatingResult.value,null);assert.equal(data.details.metricSummary.value,null);
  assert.equal(data.details.total,1);assert.equal(data.details.records[0].orderId,unknown);
  assert.equal(data.details.records[0].reason,'product_cost_unknown');assert.equal(JSON.stringify(data).includes('NOLEAK'),false);
  await assert.rejects(liveReportClientData(store,{asOf:now},{metric:'operatingResult',issue:'arbitrary-expression'}),{status:400});
});

test('scheduler liveness expires at three minutes and never treats absent, future or failed evidence as healthy',()=>{
  const row={state:'succeeded',updated_at:'2026-10-16T17:00:00.000Z',error_code:null};
  assert.equal(schedulerHealth(null,now).status,'never');
  assert.equal(schedulerHealth(row,'2026-10-16T17:02:59.999Z').status,'running');
  assert.equal(schedulerHealth(row,'2026-10-16T17:03:00.000Z').status,'stale');
  assert.equal(schedulerHealth(row,'2026-10-16T16:59:59.999Z').status,'clock_skew');
  assert.equal(schedulerHealth({...row,state:'failed',error_code:'DB_UNAVAILABLE'},now).status,'error');
});
