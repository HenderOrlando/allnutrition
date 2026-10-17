import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAreas, adminSections, readAdminView, adminHref, adminReturnTo } from '../lib/admin-view.mjs';
import { schemas, contentStates, orderStates, paymentStates } from '../lib/schema.mjs';

const home = {section:'home',q:'',status:'',paymentStatus:'',page:1};
const orders = {...home,section:'orders'};


test('unknown or missing sections normalize to an unfiltered home',()=>{
 for(const params of [undefined,null,{},new URLSearchParams(),{section:'unknown',q:'search',status:'new',page:9},{section:'toString'},{section:'__proto__'}]) assert.deepEqual(readAdminView(params),home);
});

test('URLSearchParams and resolved Next query objects use the first repeated value',()=>{
 const expected = {...orders,q:'first',status:'new',paymentStatus:'paid',page:2};
 assert.deepEqual(readAdminView(new URLSearchParams('section=orders&section=products&q=first&q=second&status=new&status=sent&paymentStatus=paid&paymentStatus=pending&page=2&page=4')),expected);
 assert.deepEqual(readAdminView({section:['orders','products'],q:['first','second'],status:['new','sent'],paymentStatus:['paid','pending'],page:['2','4']}),expected);
 assert.deepEqual(readAdminView({section:['invalid','orders']}),home);
 assert.deepEqual(readAdminView({section:'orders',status:['invalid','new'],page:['invalid','2']}),orders);
});

test('home, settings and users discard all list state',()=>{
 for(const section of ['home','settings','users']) assert.deepEqual(readAdminView({section,q:'test',status:'draft',paymentStatus:'paid',page:'7'}),{...home,section});
});

test('query text is capped at 100 characters without trimming or interpreting it',()=>{
 assert.equal(readAdminView({section:'orders',q:'x'.repeat(101)}).q,'x'.repeat(100));
 assert.equal(readAdminView({section:'products',q:'  proteína & combo  '}).q,'  proteína & combo  ');
 for(const q of [null,undefined,23,{},[]]) assert.equal(readAdminView({section:'orders',q}).q,'');
});

test('content lists accept publication states only and never paginate or filter payments',()=>{
 for(const section of Object.keys(schemas)) {
  for(const {value:status} of contentStates) assert.deepEqual(readAdminView({section,status,paymentStatus:'paid',page:'17'}),{...home,section,status});
  for(const {value:status} of orderStates) assert.equal(readAdminView({section,status}).status,'');
 }
});

test('orders reuse every supported order and payment state independently',()=>{
 for(const {value:status} of orderStates) assert.deepEqual(readAdminView({section:'orders',status}),{...orders,status});
 for(const {value:paymentStatus} of paymentStates) assert.deepEqual(readAdminView({section:'orders',paymentStatus}),{...orders,paymentStatus});
 for(const status of ['draft','published','archived','NEW','unknown']) assert.equal(readAdminView({section:'orders',status}).status,'');
 for(const paymentStatus of ['new','PAID','unknown']) assert.equal(readAdminView({section:'orders',paymentStatus}).paymentStatus,'');
});

test('order page accepts only bounded integer values',()=>{
 for(const page of [1,2,100000,'1','2','100000','0002']) assert.equal(readAdminView({section:'orders',page}).page,Number(page));
 for(const page of [0,-1,100001,1.5,NaN,Infinity,'0','-1','100001','1.5','2.0','1e2','0x10','+2',' 2 ','','Infinity',null,{},[]]) assert.equal(readAdminView({section:'orders',page}).page,1);
});

test('href canonicalizes order, excludes defaults and never serializes editor data',()=>{
 assert.equal(adminHref(home),'/admin');
 assert.equal(adminHref({section:'unknown',q:'ignored'}),'/admin');
 assert.equal(adminHref({...orders,page:1}),'/admin?section=orders');
 assert.equal(adminHref({section:'orders',q:'María & 23',status:'preparing',paymentStatus:'paid',page:2,editor:'secret',password:'secret',record:{id:'private'}}),'/admin?section=orders&q=Mar%C3%ADa+%26+23&status=preparing&paymentStatus=paid&page=2');
 assert.equal(adminHref({section:'products',status:'published',page:8,paymentStatus:'paid'}),'/admin?section=products&status=published');
 assert.equal(adminHref({section:'settings',q:'ignored',page:5}),'/admin?section=settings');
});

test('href round trips normalized views for every section',()=>{
 for(const {id:section} of adminSections) {
  const view=readAdminView({section,q:'á + & / ? #',status:section === 'orders'?'new':'draft',paymentStatus:'partial',page:3});
  const href=adminHref(view);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
  assert.equal(adminReturnTo(href),href);
 }
});

test('return destination preserves only normalized admin query and strips fragments',()=>{
 assert.equal(adminReturnTo('/admin?paymentStatus=paid&page=2&status=preparing&q=Ana&section=orders&next=https%3A%2F%2Fevil.test#private'),'/admin?section=orders&q=Ana&status=preparing&paymentStatus=paid&page=2');
 assert.equal(adminReturnTo('/admin?section=orders&section=users&page=3&page=4'),'/admin?section=orders&page=3');
 assert.equal(adminReturnTo('/admin?section=users&q=secret#fragment'),'/admin?section=users');
 assert.equal(adminReturnTo('/admin?section=unknown&password=secret'),'/admin');
 assert.equal(adminReturnTo('/admin?section=orders&q=%2F%2Fevil.test'),'/admin?section=orders&q=%2F%2Fevil.test');
 assert.equal(adminReturnTo('/admin?section=orders&q=%23%26section%3Dusers'),'/admin?section=orders&q=%23%26section%3Dusers');
});

test('return destination rejects external, ambiguous, encoded and normalized path variants',()=>{
 const rejected=[
  undefined,null,[],{},23,'','admin','?section=orders','https://example.test/admin?section=orders',
  'https://user:password@example.test/admin','//example.test/admin','///admin?section=orders',
  '/admin/login?section=orders','/administrator?section=orders','/admin/?section=orders',
  '/other/../admin?section=orders','/admin/../admin?section=orders','/admin/./?section=orders',
  '/%61dmin?section=orders','/%2fadmin?section=orders','/%2F%2Fevil.test/admin',
  '/%252f%252fevil.test/admin','/admin%2f?section=orders','/admin%5c?section=orders',
  '/admin%3fsection=orders','/admin%23?section=orders','/admin%00?section=orders',
  '/admin\\?section=orders','/\\evil.test/admin','/admin?section=orders\\evil',
  ' /admin?section=orders','/admin\n?section=orders','/admin?section=orders\t','/admin?section=orders\u0000'
 ];
 for(const candidate of rejected) assert.equal(adminReturnTo(candidate),'/admin',String(candidate));
});

test('import batch resumes through URL without serializing mappings or file contents',()=>{
 const view=readAdminView({section:'orders',tab:'imports',batch:'batch-123',filename:'private.xlsx',fileBytes:'secret',columns:[{index:0,destination:'phone'}]});
 const href=adminHref(view);
 assert.equal(new URL(href,'https://example.test').searchParams.get('batch'),'batch-123');
 assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 assert.equal(href.includes('secret'),false);
 assert.equal(href.includes('phone'),false);
 assert.equal(Object.hasOwn(readAdminView({section:'products',tab:'imports',batch:'batch-123'}),'batch'),false);
 assert.equal(Object.hasOwn(readAdminView({section:'orders',batch:'batch-123'}),'batch'),false);
});

test('report periods, filters and exact drilldowns survive URL and login return without private forms',()=>{
 for(const period of ['day','week','month','quarter','halfyear','year']) {
  const view=readAdminView({section:'reports',tab:'shipping',period,anchor:'2026-11-01',seller:'seller-1',product:'product-1',platform:'platform-1',account:'bank-1',carrier:'Transportadora + X',status:'in_transit',page:2,record:'onTimeDeliveries',source:'not-a-report-filter',phone:'private-phone',token:'private-token'});
  const href=adminHref(view);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
  assert.equal(adminReturnTo(href),href);
  assert.equal(view.anchor,'2026-11-01');assert.equal(view.period,period);assert.equal(view.record,'onTimeDeliveries');
  assert.equal(new URL(href,'https://example.test').searchParams.has('source'),false);
  assert.equal(href.includes('private-'),false);
 }
});

test('report query rejects invalid calendar dates, unknown states and oversized identifiers',()=>{
 const view=readAdminView({section:'reports',tab:'unknown',period:'decade',anchor:'2026-02-30',status:'made_up',seller:'x'.repeat(101),record:'bad\nrecord',carrier:'x'.repeat(151),page:'100001'});
 for(const key of ['tab','period','anchor','seller','record','carrier'])assert.equal(Object.hasOwn(view,key),false,key);
 assert.equal(view.status,'');assert.equal(view.page,1);
 assert.equal(readAdminView({section:'reports',anchor:'2024-02-29',record:'opaque.snapshot-1'}).record,'opaque.snapshot-1');
});

test('home attention and period survive login return without accepting report or editor payloads',()=>{
 const view=readAdminView({section:'home',period:'month',anchor:'2026-10-01',issue:'attention',status:'warning',page:2,phone:'private',seller:'ignored',mapping:{private:true}});
 const href=adminHref(view),params=new URL(href,'https://example.test').searchParams;
 assert.equal(params.get('issue'),'attention');assert.equal(params.get('status'),'warning');
 assert.equal(params.get('period'),'month');assert.equal(params.get('anchor'),'2026-10-01');assert.equal(params.get('page'),'2');
 assert.equal(params.has('phone'),false);assert.equal(params.has('mapping'),false);assert.equal(params.has('seller'),false);
 assert.deepEqual(readAdminView(params),view);assert.equal(adminReturnTo(href),href);
});

test('content detail links and typed report subsets keep only opaque bounded identifiers',()=>{
 const product=readAdminView({section:'products',record:'product-opaque',password:'secret'});
 const productParams=new URL(adminHref(product),'https://example.test').searchParams;
 assert.equal(productParams.get('record'),'product-opaque');assert.equal(productParams.has('password'),false);
 assert.deepEqual(readAdminView(productParams),product);
 for(const issue of ['missing','negative_contribution','comparison_elapsed']){
  const view=readAdminView({section:'reports',record:'contribution',issue,period:'month',anchor:'2026-10-01'});
  const href=adminHref(view);
  assert.equal(new URL(href,'https://example.test').searchParams.get('issue'),issue);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 }
 assert.equal(readAdminView({section:'reports',issue:'untrusted-expression'}).issue,undefined);
 assert.equal(readAdminView({section:'products',record:{phone:'secret'}}).record,undefined);
});

test('six areas retain every actual destination and group legacy sections without aliases',()=>{
 assert.deepEqual(adminAreas.map(area=>area.id),['home','orders','products','cash','reports','business']);
 assert.equal(new Set(adminSections.map(section=>section.id)).size,adminSections.length);
 for(const section of adminSections) {
  assert.ok(adminAreas.some(area=>area.id===section.area));
  assert.equal(readAdminView({section:section.id}).section,section.id);
 }
 for(const id of ['products','combos','catalogs'])assert.equal(adminSections.find(section=>section.id===id).area,'products');
 for(const id of ['business','settings','faqs','messages','shipping','users'])assert.equal(adminSections.find(section=>section.id===id).area,'business');
 for(const id of Object.keys(schemas))assert.ok(adminSections.some(section=>section.id===id));
});

test('gift filtering is a real product-only URL context that survives login and reload',()=>{
 for(const productType of ['product','gift']) {
  const view=readAdminView({section:'products',productType,q:'B',status:'draft',record:'gift:opaque/1'});
  const href=adminHref(view);
  assert.equal(new URL(href,'https://example.test').searchParams.get('productType'),productType);
  assert.equal(adminReturnTo(href),href);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 }
 for(const {id:section} of adminSections.filter(section=>section.id!=='products'))assert.equal(readAdminView({section,productType:'gift'}).productType,undefined);
 assert.equal(readAdminView({section:'products',productType:'free'}).productType,undefined);
});

test('each URL tab is section-specific and round trips without a second local state',()=>{
 const tabs={orders:['list','shipments','imports'],cash:['overview','movements','settlements','expenses','payroll'],business:['setup','people','accounts','platforms','rules','alerts'],reports:['overview','sales','shipping','returns','costs','payroll','cash']};
 for(const [section,values] of Object.entries(tabs)) {
  for(const tab of values) {
   const view=readAdminView({section,tab,record:'opaque:record.1',page:2});
   const href=adminHref(view);
   assert.equal(view.tab,tab);
   assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
   assert.equal(adminReturnTo(href),href);
  }
  assert.equal(readAdminView({section,tab:'unknown'}).tab,undefined);
 }
 for(const section of ['home','products','settings','users'])assert.equal(readAdminView({section,tab:'imports'}).tab,undefined);
});

test('operational order filters preserve exact supported issues and discard source outside shipping/imports',()=>{
 for(const issue of ['incident','pending_settlement','missing_data','missing_cost','legacy_review']) {
  const view=readAdminView({section:'orders',issue,seller:'person:1',platform:'platform.1',product:'product-1',carrier:'Empresa + A',record:'order/1',source:'foreign',account:'foreign'});
  const href=adminHref(view);
  assert.equal(view.issue,issue);assert.equal(view.source,undefined);assert.equal(view.account,undefined);
  assert.equal(view.seller,'person:1');assert.equal(view.platform,'platform.1');assert.equal(view.product,'product-1');
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 }
 assert.equal(readAdminView({section:'orders',issue:'arbitrary_sql'}).issue,undefined);
 for(const tab of ['imports','shipments']) {
  const view=readAdminView({section:'orders',tab,source:'source:opaque/01',platform:'platform-1',record:'profile:real-profile',batch:'batch:opaque/01'});
  assert.equal(view.source,'source:opaque/01');
  assert.equal(view.batch,tab==='imports'?'batch:opaque/01':undefined);
  const href=adminHref(view);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
  assert.equal(adminReturnTo(href),href);
 }
 for(const {id:section} of adminSections.filter(section=>section.id!=='orders'))assert.equal(readAdminView({section,source:'not-allowed'}).source,undefined);
});

test('operational statuses and issues cannot bleed between tabs',()=>{
 assert.equal(readAdminView({section:'orders',tab:'shipments',status:'in_transit',issue:'orphan'}).status,'in_transit');
 assert.equal(readAdminView({section:'orders',tab:'shipments',status:'preparing',issue:'pending_settlement'}).status,'');
 assert.equal(readAdminView({section:'orders',tab:'shipments',issue:'pending_settlement'}).issue,undefined);
 assert.equal(readAdminView({section:'orders',tab:'imports',status:'queued',paymentStatus:'paid'}).status,'queued');
 assert.equal(readAdminView({section:'orders',tab:'imports',paymentStatus:'paid'}).paymentStatus,'');
 assert.equal(readAdminView({section:'cash',tab:'settlements',status:'partial'}).status,'partial');
 assert.equal(readAdminView({section:'cash',tab:'payroll',status:'paid'}).status,'paid');
 assert.equal(readAdminView({section:'cash',tab:'movements',status:'paid'}).status,'');
 for(const status of ['active','open','acknowledged','resolved','all']) {
  const view=readAdminView({section:'business',tab:'alerts',status,issue:'cash_below_minimum',record:'alert-1',page:3});
  assert.equal(view.status,status);assert.equal(view.issue,'cash_below_minimum');
  const href=adminHref(view);assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 }
 assert.equal(readAdminView({section:'business',tab:'people',status:'resolved',issue:'cash_below_minimum'}).issue,undefined);
 assert.equal(readAdminView({section:'business',tab:'alerts',status:'paid',issue:'made_up'}).status,'');
 assert.equal(readAdminView({section:'business',tab:'alerts',issue:'made_up'}).issue,undefined);
});

test('cash period and exact record context survives return without source or form values',()=>{
 const view=readAdminView({section:'cash',tab:'movements',period:'quarter',anchor:'2026-10-01',account:'bank-1',record:'cash-entry.1',page:4,q:'aporte',source:'private-source',amountMinor:50000,reason:'private reason',csrf:'private token'});
 const href=adminHref(view);
 assert.equal(view.period,'quarter');assert.equal(view.anchor,'2026-10-01');assert.equal(view.account,'bank-1');assert.equal(view.record,'cash-entry.1');
 assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 assert.equal(adminReturnTo(href),href);assert.equal(href.includes('private'),false);
});

test('bounded opaque identifiers preserve identity and reject controls across contexts',()=>{
 const contexts=[{section:'orders',tab:'imports',key:'source'},{section:'orders',tab:'imports',key:'batch'},{section:'products',key:'record'},{section:'cash',key:'account'},{section:'business',tab:'people',key:'record'},{section:'orders',key:'seller'}];
 for(const {key,...context} of contexts) {
  for(const value of ['x'.repeat(101),`bad${String.fromCharCode(10)}value`,`bad${String.fromCharCode(127)}value`,{},17])assert.equal(readAdminView({...context,[key]:value})[key],undefined);
  const value='opaque/ID:0001.A+B',view=readAdminView({...context,[key]:value}),href=adminHref(view);
  assert.equal(view[key],value);
  assert.deepEqual(readAdminView(new URL(href,'https://example.test').searchParams),view);
 }
 assert.equal(readAdminView({section:'cash',anchor:' 2026-10-01 '}).anchor,undefined);
 assert.equal(readAdminView({section:'orders',q:`normal${String.fromCharCode(10)}query${String.fromCharCode(0)}`}).q,'normalquery');
});
