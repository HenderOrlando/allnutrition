import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights, insightDetails, INSIGHT_ISSUES } from '../lib/business/insights.mjs';
import { roundRatio } from '../lib/business/money.mjs';
import { periodBounds } from '../lib/business/dates.mjs';
import { openSQLite } from '../lib/db/sqlite.mjs';
import { Store } from '../lib/store.mjs';
import { migrateBusinessV3 } from '../lib/db/migrations.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { buildBusinessReport } from '../lib/business/reports.mjs';

const now = '2026-10-16T17:00:00.000Z';
const monetary = ['netProductSales','contribution','operatingResult','shippingCosts','shippingRevenue'];
const ratioKeys = ['onTimeDeliveries','shipmentReturnRate'];
function fact(id,value,extra = {}) {
  return {id,entityType:'order',entityId:id,orderId:id,occurredOn:'2026-09-03',known:value != null,value,unit:'minor',...extra};
}
function report({anchor='2026-09-01',closed=true,contribution=10000,result=1000,sales=20000,sourceFreshness=[],...extra} = {}) {
  const facts = Object.fromEntries([...monetary,...ratioKeys,'returnedUnits'].map(key => [key,[]]));
  for (const [key,value] of Object.entries({contribution,operatingResult:result,netProductSales:sales})) facts[key] = [fact(`${key}-source`,value)];
  const output = {query:{period:'month',anchorDate:anchor,filters:{},asOf:now},bounds:periodBounds('month',anchor),closed,dataAsOf:now,lastImportAt:sourceFreshness,facts,metrics:{},groups:{products:[],sellers:[],returns:[]},...extra};
  for (const key of Object.keys(facts)) updateMetric(output,key);
  return output;
}
function updateMetric(report,key) {
  const all = report.facts[key], known = all.filter(row => row.known && row.value != null);
  const subtotal = known.reduce((sum,row) => sum+row.value,0), complete = known.length === all.length;
  const ratio = ratioKeys.includes(key);
  report.metrics[key] = {label:key,unit:ratio ? 'bps' : key === 'returnedUnits' ? 'count' : 'minor',value:ratio ? known.length ? roundRatio(subtotal*10000,known.length) : null : complete ? subtotal : null,knownValue:subtotal,complete,eligibleCount:all.length,knownCount:known.length,excludedCount:all.length-known.length,...(ratio ? {numerator:subtotal,denominator:known.length} : {})};
}
function logistics(report,key,{count=20,numerator=18,unknown=0,sourceId='source-a'} = {}) {
  report.facts[key] = Array.from({length:count+unknown},(_,i) => fact(`${key}-${i}`,i >= count ? null : Number(i<numerator),{entityType:'shipment',entityId:`shipment-${i}`,shipmentId:`shipment-${i}`,sourceId,unit:'bps',estimatedDeliveryOn:key === 'onTimeDeliveries' ? '2026-09-04' : undefined,occurredOn:i >= count ? null : '2026-09-03'}));
  updateMetric(report,key);
  return report;
}
function comparison(current,previous,extra = {}) {
  return {equivalent:true,mode:'full',currentReport:current,report:previous,currentBounds:{startDate:current.bounds.startDate,endDateExclusive:current.bounds.endDateExclusive},previousBounds:{startDate:previous.bounds.startDate,endDateExclusive:previous.bounds.endDateExclusive},reason:null,...extra};
}
const insight = (value,id) => [...value.successes,...value.improvements].find(row => row.id === id);
const hasNote = (value,id) => value.notes.some(row => row.id === id);
const allItems = value => [...value.successes,...value.improvements];
const detail = (report,metric,issue) => insightDetails(report,{metric,issue});

// Shapes below mirror the actual signed report facts; the final test also reads
// a real SQLite report, protecting this pure contract against reader changes.
test('economic threshold is exact, uses contribution and never turns sales growth with a loss into success',() => {
  const previous = report({anchor:'2026-08-01',contribution:10000});
  const current = report({contribution:11000});
  let result = buildInsights(current,comparison(current,previous));
  assert.equal(insight(result,'contribution_growth').evidence.changeBps,1000);
  current.metrics.contribution.value = 10999;
  assert.equal(insight(buildInsights(current,comparison(current,previous)),'contribution_growth'),undefined);
  for (const operatingResult of [{value:null,complete:false},{value:-1,complete:true}]) {
    current.metrics.contribution.value = 50000;
    current.metrics.netProductSales.value = 1000000;
    Object.assign(current.metrics.operatingResult,operatingResult);
    result = buildInsights(current,comparison(current,previous));
    assert.equal(insight(result,'contribution_growth'),undefined);
    assert.ok(hasNote(result,operatingResult.complete ? 'economic_negative' : 'economic_incomplete'));
  }
});

test('positive comparable base permits a negative current contribution deterioration, never percentage over zero/negative base',() => {
  const previous = report({anchor:'2026-08-01',contribution:10000});
  const current = report({contribution:-1000,result:-1000});
  let result = buildInsights(current,comparison(current,previous));
  assert.equal(insight(result,'contribution_decline').evidence.difference,-11000);
  assert.equal(insight(result,'contribution_decline').evidence.changeBps,-11000);
  previous.metrics.contribution.value = 0;
  result = buildInsights(current,comparison(current,previous));
  assert.ok(hasNote(result,'economic_zero_base'));
  assert.equal(insight(result,'contribution_decline'),undefined);
  assert.ok(!JSON.stringify(result).includes('Infinity'));
  previous.metrics.contribution.value = -10000;
  assert.ok(hasNote(buildInsights(current,comparison(current,previous)),'economic_negative_base'));
});

test('non-equivalent comparisons do not emit directional trends or copy internal reports',() => {
  const current = logistics(report({contribution:50000}),'onTimeDeliveries',{numerator:20});
  const previous = logistics(report({anchor:'2026-08-01'}),'onTimeDeliveries',{numerator:10});
  const result = buildInsights(current,comparison(current,previous,{equivalent:false,reason:'El tramo anterior es más corto.'}));
  assert.ok(hasNote(result,'comparison_not_equivalent'));
  assert.equal(allItems(result).length,0);
  assert.equal(result.comparison.equivalent,false);
  assert.equal(result.comparison.currentValues.contribution,50000);
  assert.equal(result.comparison.currentReport,undefined);
  assert.equal(result.comparison.report,undefined);
});

test('open comparisons use parent-supplied completed-day slices and exact elapsed drill issue',() => {
  const full = report({anchor:'2026-10-01',closed:false,contribution:999999});
  const slice = report({anchor:'2026-10-01',closed:false,contribution:11000});
  slice.bounds.endDateExclusive = '2026-10-16';
  const previous = report({contribution:10000});
  previous.bounds.endDateExclusive = '2026-09-16';
  const result = buildInsights(full,comparison(slice,previous,{mode:'elapsed'}));
  const growth = insight(result,'contribution_growth');
  assert.equal(growth.value,11000);
  assert.equal(growth.evidence.endDateExclusive,'2026-10-16');
  assert.equal(growth.action.view.issue,'comparison_elapsed');
  assert.equal(growth.action.view.anchor,'2026-10-01');
  assert.equal(result.comparison.currentValues.contribution,11000);
  full.metrics.operatingResult.value = -1;
  assert.equal(insight(buildInsights(full,comparison(slice,previous,{mode:'elapsed'})),'contribution_growth'),undefined);
  assert.throws(() => detail(full,'contribution','comparison_elapsed'),/Observación/);
});

test('logistics exact 20 dated guides, 90 percent coverage, 5 percentage points; 19 or just-under boundaries reject',() => {
  const previous = logistics(report({anchor:'2026-08-01'}),'onTimeDeliveries',{numerator:18});
  const current = logistics(report(),'onTimeDeliveries',{numerator:19});
  let result = buildInsights(current,comparison(current,previous));
  const improvement = insight(result,'onTimeDeliveries_improved');
  assert.equal(improvement.evidence.changeBps,500);
  assert.equal(improvement.evidence.numerator,19);
  assert.equal(improvement.evidence.denominator,20);
  logistics(current,'onTimeDeliveries',{count:19,numerator:19});
  assert.equal(insight(buildInsights(current,comparison(current,previous)),'onTimeDeliveries_improved'),undefined);
  logistics(current,'onTimeDeliveries',{count:90,numerator:90,unknown:10});
  logistics(previous,'onTimeDeliveries',{count:90,numerator:81,unknown:10});
  assert.ok(insight(buildInsights(current,comparison(current,previous)),'onTimeDeliveries_improved'));
  logistics(current,'onTimeDeliveries',{count:90,numerator:90,unknown:11});
  assert.equal(insight(buildInsights(current,comparison(current,previous)),'onTimeDeliveries_improved'),undefined);
  logistics(current,'onTimeDeliveries',{count:10001,numerator:9500});
  logistics(previous,'onTimeDeliveries',{count:10001,numerator:9000});
  result = buildInsights(current,comparison(current,previous));
  assert.equal(insight(result,'onTimeDeliveries_improved'),undefined); // 4.9995pp, even though display rounds to 5.
  assert.ok(hasNote(result,'onTimeDeliveries_stable'));
});

test('logistics closed declines open only exact failure subset, not all delivered guides',() => {
  const previous = logistics(report({anchor:'2026-08-01'}),'onTimeDeliveries',{numerator:20});
  const current = logistics(report(),'onTimeDeliveries',{numerator:19});
  const result = buildInsights(current,comparison(current,previous));
  const decline = insight(result,'onTimeDeliveries_worsened');
  assert.equal(decline.action.view.issue,'late_deliveries');
  const rows = detail(current,'onTimeDeliveries','late_deliveries');
  assert.equal(rows.records.length,1);
  assert.equal(rows.summary.value,1);
  assert.equal(rows.summary.unit,'count');
  assert.equal(rows.records.reduce((sum,row)=>sum+row.value,0),rows.summary.value);
  assert.equal(rows.records[0].unit,'count');assert.equal(rows.records[0].sourceValue,0);
  assert.equal(rows.summary.denominator,20);
});

test('return rate uses resolved-guide denominator and counts only real known returned guides',() => {
  const previous = logistics(report({anchor:'2026-08-01'}),'shipmentReturnRate',{numerator:1});
  const current = logistics(report(),'shipmentReturnRate',{numerator:2});
  let result = buildInsights(current,comparison(current,previous));
  assert.equal(insight(result,'shipmentReturnRate_worsened').evidence.changeBps,500);
  let rows = detail(current,'shipmentReturnRate','shipping_returns');
  assert.equal(rows.records.length,2);
  assert.equal(rows.summary.value,2);
  assert.equal(rows.summary.denominator,20);
  logistics(current,'shipmentReturnRate',{numerator:0});
  result = buildInsights(current,comparison(current,previous));
  assert.ok(insight(result,'shipmentReturnRate_improved'));
  rows = detail(current,'shipmentReturnRate','shipping_returns');
  assert.equal(rows.records.length,0);
});

test('open logistics requires each actual source at exact 24h, not import upload time or unrelated account freshness',() => {
  const current = logistics(report({closed:false}),'onTimeDeliveries',{numerator:20});
  const previous = logistics(report({anchor:'2026-08-01'}),'onTimeDeliveries',{numerator:18});
  const cmp = comparison(current,previous,{mode:'elapsed'});
  let cuts = [{sourceId:'source-a',sourceAsOf:'2026-10-15T17:00:00.000Z',precision:'instant'}];
  let result = buildInsights(current,cmp,{now,sourceFreshness:cuts});
  assert.equal(insight(result,'onTimeDeliveries_improved').action.view.issue,'comparison_elapsed');
  cuts = [{sourceId:'source-a',sourceAsOf:'2026-10-15T16:59:59.999Z',precision:'instant',importedAt:now}];
  assert.equal(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'),undefined);
  current.facts.onTimeDeliveries[0].sourceId = 'source-b';
  cuts = [{sourceId:'source-a',sourceAsOf:now,precision:'instant'}];
  assert.equal(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'),undefined);
  cuts.push({sourceId:'source-b',sourceAsOf:now,precision:'instant'});
  assert.ok(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'));
  cuts[1].sourceAsOf = '2026-10-17T00:00:00Z';
  assert.equal(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'),undefined);
});

test('day-precision freshness uses maximum possible age; unknown and missing cuts or manual sources do not fake a fresh instant',() => {
  const current = logistics(report({closed:false}),'onTimeDeliveries',{numerator:20});
  const previous = logistics(report({anchor:'2026-08-01'}),'onTimeDeliveries',{numerator:18});
  const cmp = comparison(current,previous);
  const cuts = [{sourceId:'source-a',sourceAsOf:'2026-10-15T05:00:00Z',sourceDate:'2026-10-15',precision:'day'}];
  assert.ok(insight(buildInsights(current,cmp,{now:'2026-10-16T05:00:00Z',sourceFreshness:cuts}),'onTimeDeliveries_improved'));
  assert.equal(insight(buildInsights(current,cmp,{now:'2026-10-16T05:00:00.001Z',sourceFreshness:cuts}),'onTimeDeliveries_improved'),undefined);
  cuts[0].sourceDate = '2026-10-16';
  assert.ok(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'));
  cuts[0].precision = 'unknown';
  assert.equal(insight(buildInsights(current,cmp,{now,sourceFreshness:cuts}),'onTimeDeliveries_improved'),undefined);
  logistics(current,'onTimeDeliveries',{numerator:20,sourceId:null});
  logistics(previous,'onTimeDeliveries',{numerator:18,sourceId:null});
  assert.equal(insight(buildInsights(current,cmp,{now,sourceFreshness:[]}),'onTimeDeliveries_improved'),undefined);
  assert.ok(insight(buildInsights(current,cmp,{now,sourceFreshness:[{sourceId:null,sourceAsOf:now,precision:'instant'}]}),'onTimeDeliveries_improved'));
});

test('negative contribution is the complete signed period sum per order, not each negative cost or all-time margin',() => {
  const current = report();
  current.facts.contribution = [fact('a-sale',100,{orderId:'a'}),fact('a-cost',-50,{orderId:'a'}),fact('b-return',-90,{orderId:'b',returnId:'return-b'}),fact('b-recovery',20,{orderId:'b'}),fact('c-sale',10,{orderId:'c'}),fact('c-unknown',null,{orderId:'c'}),fact('unlinked',-1000,{orderId:null})];
  updateMetric(current,'contribution');
  const rows = detail(current,'contribution','negative_contribution');
  assert.equal(rows.summary.value,-70);
  assert.equal(rows.summary.orderCount,1);
  assert.deepEqual(rows.records.map(row => row.id),['b-recovery','b-return']);
  assert.ok(rows.summary.label.includes('no acumulada'));
  const observation = insight(buildInsights(current,null),'negative_contribution');
  assert.equal(observation.value,-70);
  assert.equal(observation.action.view.issue,'negative_contribution');
});

test('absorbed shipping preserves signed original source identities, excludes incomplete and avoids all-time claims',() => {
  const current = report();
  current.facts.shippingCosts = [fact('a-cost',1500,{orderId:'a',expenseId:'expense-a'}),fact('b-cost',100,{orderId:'b'}),fact('b-unknown',null,{orderId:'b'}),fact('c-cost',100,{orderId:'c'}),fact('unlinked',1000,{orderId:null})];
  current.facts.shippingRevenue = [fact('a-freight',1200,{orderId:'a'}),fact('c-freight',200,{orderId:'c'})];
  const rows = detail(current,'shippingCosts','shipping_absorbed');
  assert.equal(rows.summary.value,300);
  assert.equal(rows.summary.orderCount,1);
  assert.equal(rows.records.find(row => row.id === 'a-cost').expenseId,'expense-a');
  assert.equal(rows.records.find(row => row.id === 'a-freight').sourceValue,1200);
  assert.equal(rows.records.find(row => row.id === 'a-freight').value,-1200);
  assert.equal(current.facts.shippingRevenue[0].value,1200);
  assert.equal(insight(buildInsights(current,null),'shipping_absorbed').value,300);
});

test('most costly commercial return reason has its exact documents and credits; cancels/logistics/refunds are not loss',() => {
  const current = report();
  current.groups.returns = [
    {id:'a',orderId:'oa',kind:'return',reason:'Talla',salesCreditMinor:600,shippingCreditMinor:20},
    {id:'b',orderId:'ob',kind:'return',reason:'Talla',salesCreditMinor:500,shippingCreditMinor:0},
    {id:'c',orderId:'oc',kind:'return',reason:'Otro',salesCreditMinor:1000,shippingCreditMinor:0},
    {id:'cancel',orderId:'od',kind:'cancellation',reason:'No despachado',salesCreditMinor:999999,shippingCreditMinor:0},
  ];
  const rows = detail(current,'returnedUnits','costly_returns');
  assert.equal(rows.summary.reason,'Talla');
  assert.equal(rows.summary.value,1120);
  assert.deepEqual(rows.records.map(row => row.entityId),['a','b']);
  assert.equal(rows.records[0].returnId,'a');
  const observation = insight(buildInsights(current,null),'costly_returns');
  assert.equal(observation.value,1120);
  assert.equal(observation.action.view.record,'returnedUnits');
  assert.equal(observation.action.view.issue,'costly_returns');
  current.groups.returns.reverse();
  assert.deepEqual(detail(current,'returnedUnits','costly_returns'),rows);
});

test('no-history economics requires at least five complete orders and never calls incomplete product/seller the best',() => {
  const current = report();
  current.facts.contribution = Array.from({length:4},(_,i) => fact(`order-${i}`,100));
  assert.equal(insight(buildInsights(current,null),'positive_contribution'),undefined);
  current.facts.contribution.push(fact('fifth',100));
  current.groups.products = [{id:'a',kind:'products',label:'Producto histórico',contributionMinor:500,complete:true,knownCount:5,eligibleCount:5,orderCount:5,units:10},{id:'unknown',kind:'products',label:'Producto incompleto',contributionMinor:null,knownContributionMinor:999999,complete:false,knownCount:1,eligibleCount:2,orderCount:1,units:1}];
  current.groups.sellers = [{id:'unassigned',label:'Sin vendedor',contributionMinor:999999,complete:true,knownCount:1,eligibleCount:1,orderCount:5,units:10}];
  current.facts.contribution = current.facts.contribution.map(row => ({...row,productKind:'products',productId:'a',lineId:`line-${row.id}`,productLabel:'Producto histórico'}));
  const result = buildInsights(current,null);
  assert.equal(insight(result,'positive_contribution').evidence.orderCount,5);
  const product = insight(result,'positive_products');
  assert.equal(product.value,500);
  assert.deepEqual(product.evidence.groups.map(row => row.id),['a']);
  assert.equal(product.evidence.groups[0].units,10);
  assert.equal(product.evidence.groups[0].knownCount,5);
  assert.equal(insight(result,'positive_sellers'),undefined);
  assert.ok(!JSON.stringify(result).includes('Producto incompleto'));
  assert.ok(!product.title.includes('mejor'));
  current.metrics.operatingResult.value = -1;
  assert.equal(insight(buildInsights(current,null),'positive_products'),undefined);
});

test('product allocation subsets conserve shared costs instead of repeating parent source amounts',() => {
  const current = report();
  current.facts.contribution = [fact('shared',300,{allocations:[{productKind:'products',productId:'a',lineId:'la',value:100,known:true},{productKind:'products',productId:'b',lineId:'lb',value:200,known:true}]}),fact('seller',50,{sellerId:'seller-a'})];
  current.groups.products = ['a','b'].map((id,i) => ({id,kind:'products',label:id,complete:true,contributionMinor:(i+1)*100,knownCount:1,eligibleCount:1}));
  current.groups.sellers = [{id:'seller-a',complete:true,contributionMinor:50,knownCount:1,eligibleCount:1}];
  const products = detail(current,'contribution','positive_products');
  assert.equal(products.summary.value,300);
  assert.equal(products.records.length,2);
  assert.ok(products.records.every(row => row.sourceFactId === 'shared'));
  assert.equal(detail(current,'contribution','positive_sellers').summary.value,50);
});

test('missing is unknown not zero; issue/metric mismatch rejects rather than accidentally opening every record',() => {
  const current = report();
  current.facts.shippingCosts = [fact('zero',0),fact('unknown',null)];
  const rows = detail(current,'shippingCosts','missing');
  assert.deepEqual(rows.records.map(row => row.id),['unknown']);
  assert.equal(rows.summary.value,null);
  assert.equal(rows.summary.knownValue,0);
  assert.equal(rows.summary.complete,false);
  assert.equal(rows.summary.excludedCount,1);
  assert.equal(insightDetails(current,{metric:'contribution'}),null);
  assert.throws(() => detail(current,'contribution','late_deliveries'),/no corresponde/);
  assert.throws(() => detail(current,'shippingCosts','invented'),/Observación/);
  assert.throws(() => detail(current,'invented','missing'),/Métrica/);
  assert.ok(INSIGHT_ISSUES.includes('costly_returns'));
});

test('bounded deterministic priority uses known money before counts and never mutates report facts',() => {
  const current = report({contribution:-1000,result:-1000});
  current.facts.contribution = [fact('negative',-500)];
  current.facts.shippingCosts = [fact('shipping',300)];
  current.groups.returns = [{id:'return',kind:'return',reason:'Registrado',salesCreditMinor:100,shippingCreditMinor:0}];
  logistics(current,'onTimeDeliveries',{numerator:10});
  const previous = logistics(report({anchor:'2026-08-01',contribution:1000}),'onTimeDeliveries',{numerator:20});
  const before = JSON.stringify(current);
  const first = buildInsights(current,comparison(current,previous));
  assert.equal(first.improvements.length,3);
  assert.deepEqual(first.improvements.map(row => row.id),['contribution_decline','negative_contribution','shipping_absorbed']);
  assert.ok(first.successes.length<=3);
  assert.equal(JSON.stringify(current),before);
  for (const records of Object.values(current.facts)) records.reverse();
  assert.deepEqual(buildInsights(current,comparison(current,previous)),first);
});

test('real report facts retain dated return-period negative contribution and no recipient contacts in insight outputs',async t => {
  const store = new Store(await openSQLite(':memory:'));
  t.after(() => store.close());
  await store.initialize();
  await migrateBusinessV3(store);
  const recordedAt = '2026-08-01T12:00:00.000Z';
  const line = {lineId:'line',kind:'products',itemId:'a',productType:'product',title:'Histórico A',presentation:'Unidad',quantity:2,unitPriceMinor:5500000,discountMinor:0,unitCostMinor:2300000,components:[]};
  await insertRow(store,'orders',{id:'order',number:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify({placedOn:'2026-09-01',status:'delivered',sellerId:null,customerName:'CONTACTO-PRIVADO',phone:'3999999999',address:'DOMICILIO-PRIVADO',items:[line],shippingChargeMinor:0,subtotalMinor:11000000,totalMinor:11000000,giftDispatches:[],ruleSnapshot:{id:'rule',effectiveOn:'2026-01-01',saleRecognition:'delivered',commission:{enabled:false}},recognition:{on:'2026-09-03',basis:'delivered',ruleVersionId:'rule'}})});
  await insertRow(store,'order_returns',{id:'return',order_id:'order',occurred_on:'2026-10-02',reason:'Motivo documentado',kind:'return',source_key:null,recorded_at:recordedAt,version:1,created_at:recordedAt,updated_at:recordedAt,data:JSON.stringify({shippingCreditMinor:0,lines:[{lineId:'line',quantity:1,salesCreditMinor:5500000,condition:'recoverable',recoveredCostMinor:2300000,recognizedCostQuantity:1,unrecognizedCostQuantity:0}]})});
  const actual = await buildBusinessReport(store,{period:'month',anchorDate:'2026-10-01',asOf:'2026-11-02T12:00:00.000Z'});
  const rows = detail(actual,'contribution','negative_contribution');
  assert.equal(rows.summary.value,-3200000);
  assert.equal(rows.summary.orderCount,1);
  assert.equal(rows.records.length,2);
  assert.ok(rows.records.every(row => row.returnId === 'return'));
  const result = buildInsights(actual,null);
  assert.equal(insight(result,'negative_contribution').value,-3200000);
  assert.equal(insight(result,'costly_returns').value,5500000);
  const serialized = JSON.stringify({result,rows});
  for (const contact of ['CONTACTO-PRIVADO','3999999999','DOMICILIO-PRIVADO']) assert.ok(!serialized.includes(contact));
});

test('aggregate money remains exact above the per-document limit, including fractional centavos display',() => {
  const previous = report({anchor:'2026-08-01',contribution:20000000000001});
  const current = report({contribution:22000000000002});
  const result = buildInsights(current,comparison(current,previous));
  const growth = insight(result,'contribution_growth');
  assert.equal(growth.value,22000000000002);
  assert.equal(growth.evidence.difference,2000000000001);
  assert.ok(growth.explanation.includes(',02'));
});

test('positive product/seller evidence is capped, stable by contribution then identity, and source sums stay exact',() => {
  const current = report();
  current.facts.contribution = Array.from({length:5},(_,i) => fact(`order-${i}`,100,{sellerId:`seller-${i}`,productId:`product-${i}`,productKind:'products',productLabel:`Producto ${i}`}));
  const groups = Array.from({length:5},(_,i) => ({id:`product-${i}`,kind:'products',label:`Producto ${i}`,contributionMinor:100,complete:true,knownCount:1,eligibleCount:1,orderCount:1,units:1}));
  current.groups.products = [...groups].reverse();
  current.groups.sellers = groups.map((row,i) => ({...row,id:`seller-${i}`,label:`Responsable ${i}`}));
  const first = buildInsights(current,null);
  assert.equal(first.successes.length,3);
  const products = insight(first,'positive_products');
  assert.deepEqual(products.evidence.groups.map(row => row.id),['product-0','product-1','product-2']);
  assert.equal(products.value,500);
  assert.equal(detail(current,'contribution','positive_products').summary.value,500);
  assert.equal(detail(current,'contribution','positive_sellers').summary.value,500);
  current.groups.products.reverse();
  current.groups.sellers.reverse();
  current.facts.contribution.reverse();
  assert.deepEqual(buildInsights(current,null),first);
});

test('empty and incomplete evidence never produces placeholder successes or leaks arbitrary comparison fields',() => {
  const current = report({contribution:null,result:null,sales:null});
  const cmp = {equivalent:false,mode:'elapsed',currentBounds:{startDate:'2026-09-01',endDateExclusive:'2026-09-02',customerName:'NO-LEAK'},reason:'No hay días completos.'};
  const output = buildInsights(current,cmp);
  assert.equal(output.successes.length,0);
  assert.equal(output.improvements.length,0);
  assert.ok(hasNote(output,'economic_incomplete'));
  assert.ok(hasNote(output,'evidence_insufficient'));
  assert.ok(!JSON.stringify(output).includes('NO-LEAK'));
  assert.equal(output.notes.find(row => row.id === 'economic_incomplete').action.view.issue,'missing');
});

test('comparison evidence respects explicit parent slice bounds even when internal period identity stays full',() => {
  const current = report({anchor:'2026-10-01',closed:false,contribution:11000});
  const previous = report({contribution:10000});
  const cmp = comparison(current,previous,{mode:'elapsed',currentBounds:{startDate:'2026-10-01',endDateExclusive:'2026-10-16'},previousBounds:{startDate:'2026-09-01',endDateExclusive:'2026-09-16'}});
  const growth = insight(buildInsights(current,cmp),'contribution_growth');
  assert.equal(growth.evidence.endDateExclusive,'2026-10-16');
  assert.equal(growth.evidence.previousEndDateExclusive,'2026-09-16');
  assert.equal(growth.action.label,'Ver registros del tramo comparado');
});
