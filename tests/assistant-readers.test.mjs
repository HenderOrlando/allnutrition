import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantBusiness, resumeAssistantBusinessRead, validateAssistantReadRequest } from '../lib/assistant/readers.mjs';
import { createAssistantEvidence, assertKnownAssistantEvidence } from '../lib/assistant/evidence.mjs';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { randomUUID } from 'node:crypto';
import { emptyRecord } from '../lib/schema.mjs';
import { createBusinessFixture, businessOrderInput, businessWorkbookProfile } from './business-fixtures.mjs';
import { financeOverview, financeQuery } from '../lib/business/finance.mjs';
import { getShipment, createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { listResources, getResource, saveResource } from '../lib/business/settings.mjs';
import { createImportBatch, updateImportBatch } from '../lib/business/imports.mjs';
import { buildBusinessReport, buildBusinessReportTx, generateReportSnapshot, getReportSnapshot } from '../lib/business/reports.mjs';
import { liveReportClientData } from '../lib/business/report-export.mjs';
import { dashboardComparisonTx } from '../lib/business/dashboard.mjs';
import { buildInsights } from '../lib/business/insights.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { preparePayroll, confirmPayroll } from '../lib/business/payroll.mjs';
import { getCashClosingPreview, recordAdvance, saveAccount } from '../lib/business/cash.mjs';
import { readSocialAnalysis, analyzeSocialCampaign, prepareSocialAnalysisRequest } from '../lib/business/social-analysis.mjs';
import { createImprovementStoreFixture, CUT } from './social-improvements-fixture.mjs';
import { getSocialResults } from '../lib/business/social-metrics.mjs';
import { getSocialBusinessResult } from '../lib/business/social-links.mjs';
import { getAssistantGuide, listAssistantGuideTasks } from '../lib/assistant/guide.mjs';
import { validatePublicBlock } from '../lib/assistant/contracts.mjs';
import { adminHref, readAdminView } from '../lib/admin-view.mjs';
import { bumpRevision } from '../lib/business/commands.mjs';
import { listAlertRules, saveAlertRule, evaluateAlerts, pageAlerts, getAlert } from '../lib/business/alerts.mjs';
import { saveSocialCampaign } from '../lib/business/social.mjs';
import { validateAssistantSelect } from '../lib/assistant/read-contracts.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';

const session={user:{id:'admin-1'}};

test('catalog reader uses one Store snapshot and emits traceable, canonical citations',async()=>{
  let snapshots=0,listed=0;
  const store={async readSnapshot(fn){snapshots++;return fn({async list(kind){listed++;assert.equal(kind,'products');return [{id:'prod-1',version:3,title:'Producto real',slug:'producto-real',status:'draft',description:'Dato registrado',price:12500,phone:'5551112222',apiKey:'do-not-return'}]}})}};
  const result=await readAssistantBusiness(store,session,{domain:'catalog',query:{kind:'products'}});
  assert.equal(snapshots,1);
  assert.equal(listed,1);
  assert.equal(result.records[0].title,'Producto real');
  assert.equal(result.evidence.find(item=>item.field==='title').value,'Producto real');
  assert.equal(result.evidence.find(item=>item.field==='title').href,'/admin?section=products&record=prod-1');
  assert.doesNotMatch(JSON.stringify(result),/5551112222|do-not-return|apiKey/);
});

test('order projection excludes customer contact and address fields even from detail readers',async()=>{
  let snapshots=0;
  const store={async readSnapshot(fn){snapshots++;return fn({async order(){return {id:'ord-1',number:17,version:4,status:'new',placedOn:'2026-01-02',totalMinor:5000,paymentState:'pending',dueMinor:5000,customerName:'Cliente reservado',phone:'+571234',email:'private@example.test',address:'Calle privada 1',credentials:'secret'}}})}};
  const result=await readAssistantBusiness(store,session,{domain:'orders',query:{id:'ord-1'}});
  assert.equal(snapshots,1);
  assert.equal(result.records[0].number,17);
  assert.doesNotMatch(JSON.stringify(result),/Cliente reservado|\+571234|private@example.test|Calle privada|credentials|secret/);
  assert.ok(result.evidence.some(item=>item.field==='number'&&item.value===17));
});

test('evidence IDs are stable and unknown citations are rejected',()=>{
  const args={domain:'cash',entityId:'account-1',recordVersion:2,field:'balanceMinor',label:'Saldo',value:2500,unit:'minor',href:{section:'cash',tab:'overview',account:'account-1'}};
  const first=createAssistantEvidence(args),second=createAssistantEvidence(args);
  assert.equal(first.id,second.id);
  assert.equal(first.href,'/admin?section=cash&tab=overview&account=account-1');
  assert.deepEqual(assertKnownAssistantEvidence([first.id],[first]),[first.id]);
  assert.throws(()=>assertKnownAssistantEvidence(['unrecognized'],[first]),{code:'ASSISTANT_SCOPE_DENIED'});
});
test('empty source values stay exact and get an explicit display label',()=>{
  const evidence=createAssistantEvidence({domain:'catalog',entityId:'prod-1',field:'description',label:'Descripción',value:''});
  assert.equal(evidence.value,'');
  assert.equal(evidence.formattedValue,'Sin dato');
});
test('access reader matches the real account schema without exposing credentials',async()=>{
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {
    await store.initialize();
    await createAdmin(store,'ali-access@example.test','ali-access-test-password');
    const user=await store.db.get('SELECT id FROM users WHERE email=?',['ali-access@example.test']);
    const result=await readAssistantBusiness(store,{user:{id:user.id}},{domain:'access'});
    assert.deepEqual(result.records,[{id:user.id,active:true}]);
    assert.equal(result.summary.count,1);
    assert.doesNotMatch(JSON.stringify(result),/ali-access@example.test|password|email/);
  } finally { await store.close(); }
});

async function businessFixture(t) {
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  t.after(()=>store.close());
  await store.initialize();
  await createAdmin(store,'reader-admin@example.test','reader-fixture-password-only');
  const user=await store.db.get('SELECT id FROM users WHERE email=?',['reader-admin@example.test']);
  const fixture=await createBusinessFixture(store,{actorId:user.id,year:2025,reportsStartOn:'2025-09-01'});
  return {...fixture,store,session:{user:{id:user.id}}};
}
async function fingerprint(store) {
  const tables=await store.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const rows={};
  for(const {name} of tables) rows[name]=await store.db.all(`SELECT * FROM "${name}" ORDER BY 1`);
  return JSON.stringify(rows);
}
function mergeFragment(target,piece,locations,path=''){
  if(Array.isArray(piece)){
    const offset=locations.find(item=>item.path===path)?.offset||0,result=Array.isArray(target)?target:[];
    for(let index=0;index<piece.length;index++)result[offset+index]=mergeFragment(result[offset+index],piece[index],locations,`${path}.${offset+index}`);
    return result;
  }
  if(piece&&typeof piece==='object'){
    const result=target&&typeof target==='object'?target:{};
    for(const [key,value] of Object.entries(piece))result[key]=mergeFragment(result[key],value,locations,path?`${path}.${key}`:key);
    return result;
  }
  const location=locations.find(item=>item.path===path);
  if(typeof piece==='string'&&location){const previous=typeof target==='string'?target:'';return previous.slice(0,location.offset)+piece+previous.slice(location.offset+piece.length);}
  return piece;
}
async function readAll(store,session,input){
  let fragment=await readAssistantBusiness(store,session,input),first=fragment,last=fragment;
  const records=[],summary={},evidence=new Map();
  for(let count=0;;count++){
    assert.ok(count<10000,'continuations must make progress');
    assert.ok(Buffer.byteLength(JSON.stringify(fragment))<=16*1024);
    const coordinates=fragment.summary.fragments||[];
    for(const position of new Set(coordinates.filter(item=>item.recordIndex!==null).map(item=>item.recordPosition))){const parts=coordinates.filter(item=>item.recordPosition===position),recordIndex=parts[0].recordIndex;records[recordIndex]=mergeFragment(records[recordIndex],fragment.records[position],parts.flatMap(item=>item.paths));}
    const {fragments,...safeSummary}=fragment.summary;
    mergeFragment(summary,safeSummary,coordinates.filter(item=>item.recordIndex===null).flatMap(item=>item.paths));
    for(const item of fragment.evidence)evidence.set(item.id,item);
    last=fragment;
    if(!fragment._continuation)break;
    fragment=await resumeAssistantBusinessRead(store,session,fragment._continuation);
    assert.ok(!fragment.retrieval.reasons.includes('source_changed'));
  }
  return {...first,records:records.filter(Boolean),summary,evidence:[...evidence.values()],retrieval:last.retrieval,continuation:last.continuation,_continuation:null};
}
const readDomain=(fixture,domain,query={})=>readAll(fixture.store,fixture.session,{domain,query,select:{mode:'records',limit:null}});

test('every domain rejects unknown keys and rejects filters that its chosen reader would ignore',async t=>{
  const f=await businessFixture(t);
  for(const domain of ['catalog','orders','shipments','cash','reports','recommendations','business','alerts','imports','advertising','access','application']) {
    await assert.rejects(()=>readDomain(f,domain,{secretField:'never'}),/Filtro no permitido/);
  }
  for(const [domain,query] of [
    ['orders',{id:f.orderId,status:'preparing'}],
    ['orders',{lookup:'approximate',q:'1'}],
    ['cash',{resource:'expenses',account:f.account.id}],
    ['cash',{resource:'overview',person:f.person.id}],
    ['cash',{resource:'movements',record:f.account.id,q:'ignored'}],
    ['reports',{mode:'live',snapshotId:'not-live'}],
    ['reports',{filters:{password:'no'}}],
    ['reports',{mode:'list',metric:'contribution'}],
    ['business',{resource:'people',source:f.source.id}],
    ['alerts',{id:'alert',person:f.person.id}],
    ['imports',{q:'requires-detail'}],
    ['advertising',{kind:'analysis',campaignId:randomUUID(),network:'facebook'}],
    ['application',{taskId:'orders',page:2}],
  ]) await assert.rejects(()=>readDomain(f,domain,query));
});

test('catalog pagination, units, nullable cost and bounded stored text remain exact',async t=>{
  const f=await businessFixture(t);
  const unknown=await f.store.save('products',{...emptyRecord('products'),title:'Costo desconocido',slug:'costo-desconocido',price:12345,unitCostMinor:null,stockQuantity:null,description:'x'.repeat(2500)},null,null,f.actorId);
  for(let index=0;index<21;index++)await f.store.save('faqs',{...emptyRecord('faqs'),title:`Pregunta ${String(index).padStart(2,'0')}`,slug:`pregunta-${index}`,answer:'Respuesta registrada'},null,null,f.actorId);
  const first=await readDomain(f,'catalog',{kind:'faqs'}),second=await readDomain(f,'catalog',{kind:'faqs',page:2});
  assert.equal(first.records.length,21);assert.equal(second.records.length,1);
  assert.equal(first.summary.count,21);assert.equal(first.retrieval.complete,true);assert.equal(first.summary.complete,true);
  const detail=await readDomain(f,'catalog',{kind:'products',id:unknown.id});
  assert.equal(detail.records[0].unitCostMinor,null);
  assert.equal(detail.evidence.find(row=>row.field==='unitCostMinor').value,null);
  assert.equal(detail.evidence.find(row=>row.field==='price').formattedValue,'12.345 COP');
  assert.equal(detail.records[0].description,'x'.repeat(2500));
  assert.equal(detail.retrieval.complete,true);
  assert.ok(detail.evidence.filter(row=>row.field==='description').every(row=>!row.coverage.reasons.includes('field_truncated')));
});

test('orders use exact identity, source filters and real detail/payment projections without personal data',async t=>{
  const f=await businessFixture(t),order=await f.store.order(f.orderId);
  const exact=await readDomain(f,'orders',{lookup:'identity',q:`AN-${order.number}`});
  assert.equal(exact.records[0].id,order.id);
  assert.equal(exact.records[0].dueMinor,order.paymentSummary.outstandingMinor);
  assert.equal((await readDomain(f,'orders',{source:randomUUID()})).records.length,0);
  assert.equal((await readDomain(f,'orders',{source:f.source.id})).records[0].id,order.id);
  const detail=await readDomain(f,'orders',{id:order.id});
  assert.equal(detail.records[0].items[0].quantity,order.items[0].quantity);
  assert.equal(detail.records[0].collections[0].amountMinor,order.collections[0].amountMinor);
  assert.doesNotMatch(JSON.stringify(detail),/Destinatario sintético|3001234567|Dirección sintética|customerName|phone|address/);
});

test('shipments reuse detail reader events and do not promote ingestion time to event evidence',async t=>{
  const f=await businessFixture(t),source=await getShipment(f.store,f.shipmentId);
  const detail=await readDomain(f,'shipments',{id:f.shipmentId});
  assert.deepEqual(detail.records[0].events.map(row=>row.occurredOn),source.events.map(row=>row.occurredOn));
  assert.ok(detail.evidence.some(row=>row.field==='events.0.occurredOn'&&row.value===source.events[0].occurredOn));
  assert.equal(detail.evidence.find(row=>row.field==='status').asOf,source.sourceAsOf||null);
  assert.equal(new URL(detail.evidence.find(row=>row.entityId===f.shipmentId&&row.field==='status').href,'https://example.test').searchParams.get('record'),f.shipmentId);
  assert.equal((await readDomain(f,'shipments',{sourceId:randomUUID()})).pagination.total,0);
});

test('cash values and pure payroll/closing previews equal their domain readers without writes',async t=>{
  const f=await businessFixture(t);
  await recordAdvance(f.store,{requestId:randomUUID(),personId:f.person.id,accountId:f.account.id,effectiveOn:'2025-09-15',amountMinor:300000,concept:'Anticipo de prueba de lectura'},f.actorId);
  const cashAccount=await saveAccount(f.store,{requestId:randomUUID(),name:'Caja de prueba para cierre',type:'cash',responsibleId:f.person.id,openingOn:'2025-09-01',openingBalanceMinor:0},f.actorId);
  const before=await fingerprint(f.store),overview=await financeOverview(f.store);
  const data=await readDomain(f,'cash');
  assert.equal(data.summary.availableMinor,overview.availableMinor);
  const citation=data.evidence.find(row=>row.field==='availableMinor');
  assert.equal(citation.value,overview.availableMinor);assert.equal(citation.asOfPrecision,'date');assert.equal(citation.asOf,overview.asOf);
  const filters={person:f.person.id,page:1},expenses=await financeQuery(f.store,'expenses',filters);
  assert.deepEqual((await readDomain(f,'cash',{resource:'expenses',...filters})).records.map(row=>row.id),expenses.records.map(row=>row.id));
  const input={personId:f.person.id,startOn:'2025-09-01',endOnExclusive:'2025-10-01',bonusMinor:10000,discountMinor:25000,reason:'Ajustes proporcionados para revisar'};
  const preview=await preparePayroll(f.store,input,f.actorId),assisted=await readDomain(f,'cash',{kind:'payroll-preview',...input});
  const fields=['bonusMinor','discountMinor','reason','earnedMinor','paidMinor','offsetMinor','outstandingMinor','creditMinor','availableCreditMinor','advanceAvailableMinor','advanceToApplyMinor','advanceAppliedMinor','netMinor','amountToPayMinor'];
  assert.equal(assisted.records[0].id,preview.id);assert.equal(assisted.records[0].version,preview.version);
  for(const field of fields)assert.equal(assisted.records[0][field],preview[field],field);
  assert.equal(assisted.summary.adjustmentsIncluded,true);
  assert.deepEqual(assisted.summary.adjustments,{bonusMinor:input.bonusMinor,discountMinor:input.discountMinor,reason:input.reason});
  const closingInput={accountId:cashAccount.id,closingOn:'2025-09-30'},closing=await getCashClosingPreview(f.store,closingInput);
  assert.equal((await readDomain(f,'cash',{kind:'closing-preview',...closingInput})).records[0].expectedMinor,closing.expectedMinor);
  assert.equal(await fingerprint(f.store),before);
  const confirmed=await confirmPayroll(f.store,{...input,requestId:randomUUID()},f.actorId);
  for(const field of fields.filter(field=>field!=='advanceToApplyMinor'))assert.equal(assisted.records[0][field],confirmed[field],field);
  assert.equal(assisted.records[0].advanceToApplyMinor,confirmed.advanceAppliedMinor);
  const after=await fingerprint(f.store),existing=await readDomain(f,'cash',{kind:'payroll-preview',...input,bonusMinor:0,discountMinor:0});
  assert.equal(existing.summary.existingPeriod,true);
  for(const field of fields.filter(field=>field!=='advanceToApplyMinor'))assert.equal(existing.records[0][field],confirmed[field],field);
  assert.equal(await fingerprint(f.store),after);
});

test('report filters/details match the real client reader; exclusions and stale snapshots keep their cut',async t=>{
  const f=await businessFixture(t),query={period:'month',anchorDate:'2025-09-01',filters:{product:f.a.id}};
  const expected=await liveReportClientData(f.store,query,{metric:'contribution'});
  const data=await readDomain(f,'reports',{mode:'live',period:query.period,anchor:query.anchorDate,filters:query.filters,metric:'contribution'});
  assert.equal(data.pagination.total,expected.details.total);
  assert.deepEqual(data.records.map(row=>row.id),expected.details.records.map(row=>row.id));
  assert.equal(data.evidence.find(row=>row.field==='metric:contribution').value,expected.metrics.contribution.value);
  assert.equal((await readDomain(f,'reports',{period:'month',anchor:'2025-09-01',filters:{product:randomUUID()}})).evidence.find(row=>row.field==='metric:netProductSales').value,0);
  const snapshot=await generateReportSnapshot(f.store,query,f.actorId);
  await recordExpense(f.store,{requestId:randomUUID(),category:'operating',amountMinor:123,incurredOn:'2025-09-10',concept:'Cambio después del corte'},f.actorId);
  const saved=await getReportSnapshot(f.store,snapshot.snapshot.id);
  const assisted=await readDomain(f,'reports',{mode:'snapshot',snapshotId:snapshot.snapshot.id});
  assert.equal(assisted.summary.snapshot.state,saved.snapshot.state);
  assert.notEqual(assisted.summary.snapshot.state,'current');
  assert.equal(assisted.evidence.find(row=>row.field==='metric:contribution').asOf,saved.dataAsOf);
  assert.equal(new URL(assisted.evidence[0].href,'https://example.test').searchParams.get('record'),snapshot.snapshot.id);
  const unknown=await f.store.save('products',{...emptyRecord('products'),title:'Costo pendiente',slug:'costo-pendiente-informe',price:10000,stockQuantity:10,unitCostMinor:null,orderable:true},null,null,f.actorId);
  const order=await f.store.saveOrder(businessOrderInput(unknown,{year:2025,placedOn:'2025-09-15',shippingChargeMinor:0}),f.actorId);
  let shipment=await createShipment(f.store,{requestId:randomUUID(),orderId:order.id,carrier:'Transportadora de prueba',tracking:randomUUID()},f.actorId);
  shipment=await recordShipmentEvent(f.store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'collected',occurredOn:'2025-09-16'},f.actorId);
  await recordShipmentEvent(f.store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'delivered',occurredOn:'2025-09-17'},f.actorId);
  const incompleteQuery={period:'month',anchorDate:'2025-09-01',filters:{product:unknown.id}};
  const report=await buildBusinessReport(f.store,incompleteQuery);
  const checked=await readDomain(f,'reports',{period:'month',anchor:'2025-09-01',filters:incompleteQuery.filters});
  const metric=checked.evidence.find(row=>row.field==='metric:contribution');
  assert.equal(metric.value,null);assert.equal(metric.coverage.state,'partial');
  assert.equal(metric.value,report.metrics.contribution.value);
  assert.deepEqual(metric.coverage.reasons,report.metrics.contribution.exclusionReasons.map(row=>row.label));
});

test('recommendations are deterministic report internals with citation-backed comparison values',async t=>{
  const f=await businessFixture(t),query={period:'month',anchorDate:'2025-09-01'};
  const expected=await f.store.readSnapshot(async tx=>{const report=await buildBusinessReportTx(tx,query);return buildInsights(report,await dashboardComparisonTx(tx,report));});
  const before=await fingerprint(f.store),data=await readDomain(f,'recommendations',{period:'month',anchor:'2025-09-01'});
  assert.deepEqual(data.summary.comparison,expected.comparison);
  assert.deepEqual(data.summary.notes,expected.notes.map(({id,text})=>({id,text})));
  for(const item of [...expected.improvements,...expected.successes]) {
    const record=data.records.find(row=>row.id===item.id);assert.ok(record);
    assert.equal(record.reason,item.explanation||item.text);
    assertKnownAssistantEvidence(record.evidenceIds,data.evidence);
    const citations=data.evidence.filter(row=>record.evidenceIds.includes(row.id));
    assert.ok(citations.some(row=>['value','metricValue','currentValue'].includes(row.field)));
    assert.ok(citations.every(row=>!['observation','reason','title'].includes(row.field)));
  }
  assert.equal(await fingerprint(f.store),before);
});

test('business resources retain real versions and agreements, filter inactive entries, and omit unrelated fields',async t=>{
  const f=await businessFixture(t),people=await listResources(f.store,'people');
  const person=await readDomain(f,'business',{resource:'people',id:f.person.id});
  assert.equal(person.records[0].version,people[0].version);
  assert.equal(person.records[0].salaryAgreements[0].amountPerPeriodMinor,people[0].salaryAgreements[0].amountPerPeriodMinor);
  assert.equal((await readDomain(f,'business',{resource:'people',active:false})).records.length,0);
  assert.equal((await readDomain(f,'business',{resource:'sources',platform:randomUUID()})).records.length,0);
  const settings=await readDomain(f,'business');
  assert.equal(settings.records[0].currency,'COP');
  assert.ok(settings.records[0].rulesVersions[0].commission);
  assert.doesNotMatch(JSON.stringify(settings),/apiKey|password|csrf|ciphertext|sessionToken/);
});

test('imports expose config, bounded row diagnostics and batch metadata without workbook bytes',async t=>{
  const f=await businessFixture(t),batch=await createImportBatch(f.store,{requestId:randomUUID(),sourceId:f.source.id},f.actorId);
  const configured=await updateImportBatch(f.store,batch.id,{requestId:randomUUID(),version:batch.version,config:{formatVersion:2,sheets:[businessWorkbookProfile()]}},f.actorId);
  const before=await fingerprint(f.store),data=await readDomain(f,'imports',{id:batch.id});
  assert.equal(data.summary.batch.version,configured.version);
  assert.equal(data.summary.config.sheets[0].columns[0].destination,'externalOrderId');
  assert.equal(data.summary.config.sheets[0].columns.length,businessWorkbookProfile().columns.length);
  assert.equal(data.retrieval.complete,true);
  assert.doesNotMatch(JSON.stringify(data),/fileBytesBase64|file_bytes_base64|workbook|bytes|download/);
  assert.equal(await fingerprint(f.store),before);
});

test('persisted social analysis is pure even when stale; metric and business projections use actual readers',async t=>{
  const f=await businessFixture(t),social=await createImprovementStoreFixture(f.store);
  const request=await prepareSocialAnalysisRequest(f.store,social.campaignId,{asOf:CUT});
  await analyzeSocialCampaign(f.store,social.campaignId,{asOf:CUT,requestId:request.requestId,expectedEvidenceHash:request.evidenceHash},social.actorId);
  const metrics=await getSocialResults(f.store,{campaignId:social.campaignId,asOf:CUT});
  const projected=await readDomain(f,'advertising',{kind:'results',campaignId:social.campaignId,asOf:CUT});
  assert.equal(projected.records[0].values.linkClicks.value,metrics.measurements[0].values.linkClicks.value);
  assert.equal(projected.evidence.find(row=>row.field==='metric:linkClicks').asOf,metrics.measurements[0].fetchedAt);
  const business=await getSocialBusinessResult(f.store,social.campaignId,{asOf:CUT});
  const result=await readDomain(f,'advertising',{kind:'business-result',campaignId:social.campaignId,asOf:CUT});
  assert.equal(result.records.find(row=>row.id==='knownContribution').valueMinor,business.knownContribution.valueMinor);
  await f.store.transaction(async tx=>{await tx.lockWrites();await bumpRevision(tx,['2026-10-29']);});
  const before=await fingerprint(f.store),stale=await readSocialAnalysis(f.store,social.campaignId,{asOf:CUT});
  assert.equal(stale.stale,true);assert.equal(stale.status,'stale');
  const assisted=await readDomain(f,'advertising',{kind:'analysis',campaignId:social.campaignId,asOf:CUT});
  assert.equal(assisted.records[0].stale,true);
  assert.equal(assisted.evidence.find(row=>row.field==='status').coverage.state,'partial');
  await readDomain(f,'recommendations',{period:'month',anchor:'2025-09-01'});
  assert.equal(await fingerprint(f.store),before);
  assert.doesNotMatch(JSON.stringify({projected,result,assisted}),/SYNTHETIC-IMPROVEMENTS-SECRET|accessToken|sessionEpoch|configurationFingerprint|remoteRefs|ciphertext/);
});

test('all curated guides resolve stable local step IDs and canonical destinations',async()=>{
  const rows=listAssistantGuideTasks();
  for(const task of rows) {
    const guide=getAssistantGuide(task.taskId);
    assert.equal(guide.id,guide.taskId);assert.deepEqual(guide,task);
    assert.equal(guide.href,adminHref(readAdminView(new URL(guide.href,'https://example.test').searchParams)));
    assert.ok(guide.steps.every(step=>step.id.startsWith(`${guide.taskId}:`)));
    assert.equal(new Set(guide.steps.map(step=>step.id)).size,guide.steps.length);
    validatePublicBlock({type:'guide',taskId:guide.taskId,title:guide.title,steps:guide.steps,href:guide.href});
  }
  assert.equal(getAssistantGuide('https://outside.test'),null);
  const data=await readAll({readSnapshot:fn=>fn({})},session,{domain:'application',query:{taskId:'orders'}});
  assert.equal(data.records[0].steps[0].id,'orders:open');
  assert.ok(data.evidence.some(item=>item.entityId==='orders'&&item.field==='title'));
});

test('evidence identity changes with version/cut, null is unknown, long strings disclose truncation',()=>{
  const fact={domain:'catalog',entityId:'product',field:'description',label:'Descripción',value:'Dato'};
  assert.notEqual(createAssistantEvidence({...fact,recordVersion:1}).id,createAssistantEvidence({...fact,recordVersion:2}).id);
  assert.notEqual(createAssistantEvidence({...fact,asOf:'2025-01-01',asOfPrecision:'date'}).id,createAssistantEvidence({...fact,asOf:'2025-01-02',asOfPrecision:'date'}).id);
  assert.equal(createAssistantEvidence({...fact,value:null}).coverage.state,'unknown');
  const long=createAssistantEvidence({...fact,value:'x'.repeat(2500)});
  assert.equal(long.value.length,2000);assert.equal(long.coverage.state,'partial');
  assert.ok(long.coverage.reasons.includes('field_truncated'));
});

test('alert adapters preserve rule versions, real thresholds and responsible filtering',async t=>{
  const f=await businessFixture(t),rules=(await listAlertRules(f.store)).records;
  const original=rules.find(row=>row.type==='settlement_overdue');
  const configured=await saveAlertRule(f.store,{id:original.id,requestId:randomUUID(),version:original.version,enabled:true,responsibleId:f.person.id,thresholds:{days:1}},f.actorId);
  await evaluateAlerts(f.store,{now:new Date('2026-11-02T12:00:00Z')});
  const before=await fingerprint(f.store);
  const detail=await readDomain(f,'alerts',{kind:'rules',id:original.id});
  assert.equal(detail.records[0].version,configured.version);
  assert.equal(detail.records[0].thresholds.days,1);
  const filters={type:'settlement_overdue',responsible:f.person.id,state:'active',page:1};
  const expected=await pageAlerts(f.store,filters),data=await readDomain(f,'alerts',{type:filters.type,person:f.person.id,state:'active'});
  assert.ok(expected.records.length>0);
  assert.deepEqual(data.records.map(row=>row.id),expected.records.map(row=>row.id));
  assert.equal((await readDomain(f,'alerts',{person:randomUUID()})).records.length,0);
  const alert=await getAlert(f.store,data.records[0].id),single=await readDomain(f,'alerts',{id:alert.id});
  assert.equal(single.records[0].amountMinor,alert.amountMinor);
  assert.equal(await fingerprint(f.store),before);
});

test('local advertising campaigns, assets and connection state are bounded read-only projections',async t=>{
  const f=await businessFixture(t);
  const draft=await saveSocialCampaign(f.store,{requestId:randomUUID(),name:'Borrador de prueba',caption:'Texto aportado por el negocio'},f.actorId,{env:{}});
  const before=await fingerprint(f.store);
  const list=await readDomain(f,'advertising',{q:'Borrador de prueba',status:'draft'});
  assert.equal(list.records[0].id,draft.id);
  assert.equal((await readDomain(f,'advertising',{q:'No existe'})).pagination.total,0);
  const detail=await readDomain(f,'advertising',{kind:'campaign',id:draft.id});
  assert.equal(detail.records[0].caption,'Texto aportado por el negocio');
  const assets=await readDomain(f,'advertising',{kind:'assets'});
  assert.deepEqual(assets.records,[]);assert.equal(assets.pagination.total,null);assert.equal(assets.summary.complete,false);
  const connections=await readDomain(f,'advertising',{kind:'connections'});
  assert.deepEqual(connections.records,[]);
  assert.equal(await fingerprint(f.store),before);
  assert.doesNotMatch(JSON.stringify({list,detail,assets,connections}),/capabilities|identities|remoteRefs|ciphertext|browserWorker|requirements/);
});

test('comparison_elapsed details use the completed internal report rather than the client DTO',async t=>{
  const f=await businessFixture(t),today=bogotaDate(),query={period:'month',anchorDate:today};
  const input={mode:'live',period:'month',anchor:today,metric:'contribution',issue:'comparison_elapsed'};
  if(today.endsWith('-01')) {
    await assert.rejects(()=>readDomain(f,'reports',input),/días completos/);
    return;
  }
  const expected=await liveReportClientData(f.store,query,{metric:'contribution',issue:'comparison_elapsed'});
  const actual=await readDomain(f,'reports',input);
  assert.deepEqual(actual.summary.detailBounds,expected.details.bounds);
  assert.equal(actual.summary.detailSummary.value,expected.details.metricSummary.value);
  assert.deepEqual(actual.records.map(row=>row.id),expected.details.records.map(row=>row.id));
});

test('person detail exposes canonical saved commission overrides with their effective dates',async t=>{
  const f=await businessFixture(t);
  await saveResource(f.store,'people',{...f.person,requestId:randomUUID(),commissionOverrides:[
    {id:'later-fixed-override',effectiveOn:'2025-10-01',enabled:true,mode:'fixed',fixedMinor:777,earnWhen:'delivered'},
    {id:'earlier-percent-override',effectiveOn:'2025-08-01',enabled:true,mode:'percent',rateBps:650,fixedMinor:0,basis:'net_products',earnWhen:'business_received'},
  ]},f.actorId,f.person.id);
  const saved=await getResource(f.store,'people',f.person.id),before=await fingerprint(f.store);
  const data=await readDomain(f,'business',{resource:'people',id:f.person.id});
  assert.deepEqual(data.records[0].commissionOverrides,saved.commissionOverrides);
  assert.deepEqual(data.records[0].salaryAgreements,saved.salaryAgreements);
  assert.equal(data.records[0].version,saved.version);
  assert.equal(Object.hasOwn(data.records[0],'commissionAgreements'),false);
  assert.deepEqual(data.evidence.filter(row=>/^commissionOverrides\.\d+\.effectiveOn$/.test(row.field)).map(row=>row.value),saved.commissionOverrides.map(row=>row.effectiveOn));
  assert.equal(data.evidence.find(row=>row.field==='commissionOverrides.1.fixedMinor').value,777);
  assert.equal(await fingerprint(f.store),before);
});


test('closed select and read contracts reject inapplicable fields and incompatible query branches',()=>{
  assert.deepEqual(validateAssistantSelect(null),{mode:'auto'});
  for(const select of [{mode:'sql'},{mode:'records',sortBy:'id'},{mode:'summary',fields:['password']},{mode:'records',fields:['title'],limit:21},{mode:'groups',group:'products',sortBy:'label'}]){
    assert.throws(()=>validateAssistantReadRequest({domain:'catalog',query:{kind:'products'},select}));
  }
  for(const request of [
    {domain:'reports',query:{startDate:'2026-09-01',endDateExclusive:'2026-10-02',period:'month'}},
    {domain:'orders',query:{startDate:'2026-09-01'}},
    {domain:'shipments',query:{eventStatus:'delivered'}},
    {domain:'imports',query:{id:'batch',rowNumber:1}},
    {domain:'reports',query:{mode:'list'},select:{mode:'groups',group:'products'}},
  ])assert.throws(()=>validateAssistantReadRequest(request));
});

test('summary authority covers sixty-five products; multibyte text and nested tails are losslessly resumed',async()=>{
  const rows=Array.from({length:65},(_,index)=>({id:`product-${String(index+1).padStart(2,'0')}`,version:1,title:`Producto ${String(index+1).padStart(2,'0')}`,productType:index===0?'gift':'product',status:'published',price:100,stockQuantity:index===2?null:1,description:`${'á漢😀'.repeat(1200)}:${index===64?'DISTINTIVO-ULTIMO':'ordinario'}`,items:Array.from({length:index===64?25:0},(_,part)=>({productId:`component-${part}`,quantity:part+1}))}));
  const store={readSnapshot:fn=>fn({list:async()=>rows,get:async(kind,id)=>rows.find(row=>row.id===id)})};
  const summary=await readAssistantBusiness(store,session,{domain:'catalog',query:{kind:'products'},select:{mode:'summary'}});
  assert.equal(summary.summary.count,65);assert.equal(summary.retrieval.recordsTotal,65);assert.equal(summary.retrieval.complete,true);
  assert.equal(summary.summary.stock.unknown,1);
  assert.ok(summary.evidence.some(item=>item.field==='summary:count'&&item.value===65));
  assert.ok(summary.records.length<=10);
  const full=await readAll(store,session,{domain:'catalog',query:{kind:'products'},select:{mode:'records',fields:['title','description','items'],limit:null}});
  assert.equal(full.records.length,65);assert.equal(full.retrieval.complete,true);
  assert.equal(full.records.at(-1).description,rows.at(-1).description);
  assert.equal(full.records.at(-1).items.at(-1).productId,'component-24');
  assert.equal(full.records.at(-1).items.length,25);
  const gifts=await readAll(store,session,{domain:'catalog',query:{kind:'products',productType:'gift'},select:{mode:'summary'}});
  assert.equal(gifts.summary.count,1);
  assert.ok(full.evidence.every(item=>!item.coverage.reasons.includes('field_truncated')));
  await assert.rejects(()=>readAssistantBusiness(store,session,{domain:'catalog',query:{kind:'products'},select:{mode:'records',cursor:'fabricated'}}),/trabajo autorizado/);
});

test('a whole-selection stamp detects replacement without count/version maxima and restarts once',async()=>{
  const rows=Array.from({length:25},(_,index)=>({id:`row-${index}`,version:1,title:`Título ${index}`,status:'draft',description:'A'.repeat(3000)}));
  const store={readSnapshot:fn=>fn({list:async()=>rows})};
  const first=await readAssistantBusiness(store,session,{domain:'catalog',query:{kind:'products'},select:{mode:'records',limit:null}});
  assert.ok(first._continuation);
  rows[24]={...rows[24],title:'Sustitución sin cambiar máximo ni cantidad'};
  const changed=await resumeAssistantBusinessRead(store,session,first._continuation);
  assert.ok(changed.retrieval.reasons.includes('source_changed'));
  assert.notEqual(changed.retrieval.sourceStamp,first.retrieval.sourceStamp);
  assert.equal(changed._continuation.state.restarts,1);
  rows[23]={...rows[23],title:'Segunda modificación'};
  const changedAgain=await resumeAssistantBusinessRead(store,session,changed._continuation);
  assert.equal(changedAgain.retrieval.complete,false);
  assert.ok(changedAgain.retrieval.reasons.includes('source_changed'));
  assert.equal(changedAgain.continuation,null);
});

test('order ranges use placedOn and shipment ranges use corrected effective events before pagination',async t=>{
  const f=await businessFixture(t);
  const orders=await readDomain(f,'orders',{startDate:'2025-09-01',endDateExclusive:'2025-09-02'});
  assert.ok(orders.records.some(row=>row.id===f.orderId));
  assert.equal((await readDomain(f,'orders',{startDate:'2025-09-02',endDateExclusive:'2025-09-04'})).records.length,0);
  let shipment=await getShipment(f.store,f.shipmentId);
  const delivered=shipment.events.find(row=>row.status==='delivered');
  await recordShipmentEvent(f.store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'delivered',occurredOn:'2025-10-02',correctionOf:delivered.id,reason:'Corrección real de fecha'},f.actorId);
  const september=await readDomain(f,'shipments',{startDate:'2025-09-03',endDateExclusive:'2025-09-04',eventStatus:'delivered'});
  assert.ok(!september.records.some(row=>row.id===f.shipmentId));
  const october=await readDomain(f,'shipments',{startDate:'2025-10-01',endDateExclusive:'2025-10-03',eventStatus:'delivered',status:'delivered'});
  assert.ok(october.records.some(row=>row.id===f.shipmentId));
});

test('Unicode evidence never exposes a split surrogate at value or display boundaries',()=>{
  for(const boundary of [999,1999]){
    const evidence=createAssistantEvidence({domain:'catalog',field:'description',label:'Descripción',value:`${'a'.repeat(boundary)}🥑${'b'.repeat(1200)}`});
    assert.equal(evidence.value.isWellFormed(),true);
    assert.equal(evidence.formattedValue.isWellFormed(),true);
    assert.equal(evidence.value.includes('\uFFFD'),false);
  }
});
