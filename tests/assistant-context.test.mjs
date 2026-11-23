import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAssistantScope,validateAssistantSelection} from '../lib/assistant/context.mjs';
const now = new Date('2026-11-12T02:00:00Z');
const scope = (view,selection = null) => resolveAssistantScope({view,selection},{now});
const read = view => scope(view).reads[0];

test('home freezes the Bogotá period and attention severity',()=>{
  assert.deepEqual(read({section:'home'}).query,{period:'month',anchor:'2026-11-11'});
  assert.deepEqual(read({section:'home',issue:'attention',status:'warning'}).query,{page:1,severity:'warning'});
  assert.deepEqual(scope({section:'home'}).reads[1].query,{resource:'automation'});
});
test('catalog sections preserve kind, gifts, search and concrete identities',()=>{
  for(const kind of ['products','combos','catalogs','faqs','messages','shipping']) assert.equal(read({section:kind}).query.kind,kind);
  assert.equal(read({section:'products',productType:'gift'}).query.productType,'gift');
  assert.deepEqual(read({section:'products',record:'p',q:'ignored'}).query,{kind:'products',id:'p'});
  assert.equal(read({section:'products',q:'té',status:'draft'}).query.q,'té');
});
test('orders and shipping preserve applied filters with distinct identities',()=>{
  const result=read({section:'orders',q:'AN',status:'new',paymentStatus:'pending',seller:'s',product:'p',platform:'m',carrier:'c',issue:'missing_cost'});
  assert.equal(result.domain,'orders');assert.equal(result.query.seller,'s');assert.equal(result.query.issue,'missing_cost');
  assert.deepEqual(read({section:'orders',record:'o',q:'ignored'}).query,{id:'o'});
  const shipping=read({section:'orders',tab:'shipments',source:'s',platform:'p',status:'delivered'});
  assert.equal(shipping.query.sourceId,'s');assert.equal(shipping.query.platformId,'p');assert.equal(shipping.query.status,'delivered');
});
test('Heka scope reads the official configuration and local journal, never a guessed order',()=>{
  const heka=scope({section:'orders',tab:'heka',record:'unrelated-order',q:'private'});
  assert.deepEqual(heka.guideTaskIds,['heka']);
  assert.deepEqual(heka.reads.map(({domain,query})=>[domain,query]),[['business',{resource:'heka-status'}],['business',{resource:'heka-journal',page:1}]]);
  assert.equal(read({section:'business',tab:'shipping'}).query.resource,'heka-status');
});
test('cash uses real period bounds, translates person and distinguishes accounts from closings',()=>{
  const expense=read({section:'cash',tab:'expenses',seller:'person',category:'advertising',period:'week',anchor:'2026-11-11'}).query;
  assert.equal(expense.person,'person');assert.equal(expense.category,'advertising');assert.equal(expense.startDate,'2026-11-09');assert.equal(expense.endDateExclusive,'2026-11-16');
  const account=scope({section:'cash',account:'a',record:'a'});
  assert.deepEqual(account.reads.map(r=>r.query),[{resource:'overview'},{resource:'closings',account:'a',page:1}]);
  assert.deepEqual(scope({section:'cash',account:'a',record:'c'}).reads[1].query,{resource:'closings',record:'c',account:'a'});
  for(const resource of ['movements','settlements','expenses','payroll']) assert.deepEqual(read({section:'cash',tab:resource,record:'r'}).query,{resource,record:'r'});
});
test('report savedMetric binds to snapshot and ignores live controls',()=>{
  const view={section:'reports',record:'snapshot',period:'year',seller:'other',page:2};
  const selection={kind:'report',snapshotId:'snapshot',metric:'netProductSales',issue:null};
  assert.deepEqual(scope(view,selection).reads[0].query,{mode:'snapshot',snapshotId:'snapshot',page:2,metric:'netProductSales'});
  assert.equal(read({section:'reports',record:'netProductSales'}).query.mode,'live');
  assert.equal(read({section:'reports',mode:'saved'}).query.mode,'list');
  assert.equal(read({section:'reports',seller:'s'}).query.filters.seller,'s');
});
test('only a visible live report can carry its source data revision',()=>{
  const live={section:'reports'}, selection={kind:'report',snapshotId:null,metric:null,issue:null};
  assert.deepEqual(validateAssistantSelection(live,selection),selection);
  assert.equal(validateAssistantSelection(live,{...selection,dataRevision:0}).dataRevision,0);
  assert.equal(validateAssistantSelection(live,{...selection,dataRevision:null}).dataRevision,null);
  assert.throws(()=>validateAssistantSelection(live,{...selection,dataRevision:'1'}));
  assert.throws(()=>validateAssistantSelection({...live,mode:'saved'},{...selection,dataRevision:1}));
  assert.throws(()=>validateAssistantSelection({...live,record:'snapshot'},{...selection,snapshotId:'snapshot',dataRevision:1}));
});
test('import selection contains persisted row filters only and new is never a persisted ID',()=>{
  const view={section:'orders',tab:'imports',batch:'b'};
  const selection={kind:'import',batchId:'b',sheet:'Pedidos',rowNumber:65,state:'conflict',q:'texto',page:4};
  assert.deepEqual(scope(view,selection).reads[0].query,{id:'b',sheet:'Pedidos',rowNumber:65,state:'conflict',q:'texto',page:4});
  assert.equal(read({...view,batch:'new'}).query.id,undefined);
  assert.throws(()=>validateAssistantSelection(view,{...selection,bytes:'secret'}));
  assert.throws(()=>validateAssistantSelection(view,{...selection,batchId:'other'}));
  assert.throws(()=>validateAssistantSelection(view,{...selection,sheet:null}));
});
test('advertising uses applied view dates, dimensions and source',()=>{
  const query=read({section:'advertising',tab:'results',from:'2026-10-01',to:'2026-10-31',dimension:'daily',integrationMethod:'browser',scope:'paid'}).query;
  assert.equal(query.from,'2026-10-01');assert.equal(query.to,'2026-10-31');assert.equal(query.dimension,'daily');assert.equal(query.integrationMethod,'browser');
  assert.equal(read({section:'advertising',tab:'assets',status:'ready'}).query.state,'ready');
  assert.equal(read({section:'advertising',mode:'organic',network:'instagram'}).query.network,'instagram');
  const record='aabcfd33-1edc-468a-8a38-5bd1f93933c4',view={section:'advertising',tab:'results'};
  assert.deepEqual(read({...view,record,resultsFocus:'learnings'}).query,{kind:'learnings',campaignId:record});
  assert.deepEqual(read({...view,record,resultsFocus:'recommendations'}).query,{kind:'analysis',campaignId:record});
  assert.equal(read({...view,record:'ambiguous',resultsFocus:'learnings'}).query.kind,'results');
});
test('the Meta source keeps its account, connection and exact snapshot separate from local campaigns',()=>{
  const connection='aabcfd33-1edc-468a-8a38-5bd1f93933c4',snapshot='bbcfd733-1edc-468a-8a38-5bd1f93933a4';
  const view={section:'advertising',source:'meta',connection,account:'act_501',metaCampaign:'9007199254740993',snapshot,page:2};
  assert.deepEqual(read(view).query,{kind:'meta-inventory',connection,account:view.account,metaCampaign:view.metaCampaign,snapshot,page:1});
  assert.deepEqual(read({...view,account:null}).query,{kind:'meta-inventory',connection,page:2});
});
test('configuration, storefront and access remain closed resources',()=>{
  for(const resource of ['people','accounts','platforms']) assert.equal(read({section:'business',tab:resource}).query.resource,resource);
  assert.equal(read({section:'business',tab:'rules'}).query.kind,'rules');
  assert.equal(read({section:'business',tab:'alerts',status:'resolved'}).query.state,'resolved');
  assert.equal(read({section:'settings'}).query.resource,'storefront');
  assert.equal(read({section:'users'}).domain,'access');
  for(const [tab,id] of [['social','social'],['shipping','shipping-integrations'],['assistant','assistant']]) assert.deepEqual(scope({section:'business',tab}).guideTaskIds,[id]);
});
test('selection rejects wrong section, record, fields, metric and row states',()=>{
  const report={kind:'report',snapshotId:null,metric:'netProductSales',issue:null};
  assert.throws(()=>validateAssistantSelection({section:'products'},report));
  assert.throws(()=>validateAssistantSelection({section:'reports',record:'contribution'},report));
  assert.throws(()=>validateAssistantSelection({section:'reports',record:'unknown'},{...report,snapshotId:'unknown',metric:'SQL'}));
  assert.throws(()=>validateAssistantSelection({section:'cash',account:'a',record:'a'},{kind:'cash-closings',accountId:'other',recordId:null,page:1}));
  assert.throws(()=>validateAssistantSelection({section:'orders',tab:'imports',batch:'b'},{kind:'import',batchId:'b',sheet:null,rowNumber:null,state:'secret',q:'',page:1}));
});

test('scope remains frozen after the originating view changes',()=>{
  const view={section:'products',productType:'gift',q:'regalo'};
  const frozen=scope(view);
  view.section='cash';view.q='otro';
  assert.equal(frozen.view.section,'products');
  assert.equal(frozen.reads[0].query.q,'regalo');
  assert.deepEqual(frozen.reads[0].select,{mode:'auto'});
});

test('closing page selection is bound to the visible account and closing identity',()=>{
  const view={section:'cash',account:'a',record:'a'};
  const selection={kind:'cash-closings',accountId:'a',page:3,recordId:null};
  assert.deepEqual(scope(view,selection).reads[1].query,{resource:'closings',account:'a',page:3});
  assert.throws(()=>validateAssistantSelection({...view,record:'c'},selection));
  assert.throws(()=>validateAssistantSelection({...view,tab:'expenses'},selection));
});
