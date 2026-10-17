import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { importData } from '../lib/import.mjs';
import { emptyRecord, defaults, schemas } from '../lib/schema.mjs';
import { createBusinessFixture, returnBusinessFixture, requestId } from './business-fixtures.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch, uploadImportFile, getImportBatch, requestImportPreview, commitImport, processImportTurn } from '../lib/business/imports.mjs';
import { generateReportSnapshot, saveReportSnapshot, processReportTurn } from '../lib/business/reports.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { saveAccount, recordAdvance, transferMoney, closeCash } from '../lib/business/cash.mjs';
import { confirmPayroll } from '../lib/business/payroll.mjs';
import { saveSettlement } from '../lib/business/settlements.mjs';

const stable = bundle => { const copy = structuredClone(bundle); delete copy.exportedAt; return copy; };

/** Use before a destination reset; its plain return value also crosses engines. */
export async function createCommercialBackupScenario(store) {
  const fixture = await createBusinessFixture(store,{year:2025,pay:true});
  await returnBusinessFixture(store,fixture,{refund:true});
  await recordAdvance(store,{requestId:requestId(),personId:fixture.person.id,accountId:fixture.account.id,effectiveOn:'2025-10-04',amountMinor:50000,concept:'Anticipo conservado en respaldo'},fixture.actorId);
  await confirmPayroll(store,{requestId:requestId(),personId:fixture.person.id,startOn:'2025-10-01',endOnExclusive:'2025-11-01',bonusMinor:1000000,discountMinor:0,reason:'Bonificación interna de prueba'},fixture.actorId);
  const cash = await saveAccount(store,{requestId:requestId(),name:'Caja conservada',type:'cash',openingOn:'2025-10-01',openingBalanceMinor:0,responsibleId:fixture.person.id},fixture.actorId);
  await transferMoney(store,{requestId:requestId(),fromAccountId:fixture.account.id,toAccountId:cash.id,effectiveOn:'2025-10-05',amountMinor:50000,concept:'Transferencia conservada'},fixture.actorId);
  await closeCash(store,{requestId:requestId(),accountId:cash.id,closingOn:'2025-10-05',countedMinor:50000,responsibleId:fixture.person.id},fixture.actorId);
  await saveSettlement(store,{requestId:requestId(),sourceId:fixture.source.id,externalKey:'BACKUP-UNRECONCILED',reportedOn:'2025-09-06',netMinor:11000000,lines:fixture.settlement.lines},fixture.actorId);
  await createAdmin(store,'backup-auth-only@example.test','backup-auth-only-password');
  const auth = await login(store,'backup-auth-only@example.test','backup-auth-only-password');
  const person = await store.db.get(`SELECT version FROM ${store.t('people')} WHERE id=?`,[fixture.person.id]);
  await saveResource(store,'people',{name:fixture.person.name,active:true,version:person.version,userId:auth.user.id,requestId:requestId()},fixture.actorId,fixture.person.id);
  const query = {period:'month',anchorDate:'2025-09-01'};
  await generateReportSnapshot(store,query,fixture.actorId);
  const reportRequest = await saveReportSnapshot(store,{period:'month',anchorDate:'2025-10-01',requestId:requestId()},fixture.actorId);
  const config = {sheetName:'Seguimiento',headerRow:1,dateFormat:'ISO',purpose:'tracking',columns:[
    {index:0,header:'Guía',destination:'tracking'},{index:1,header:'Transportadora',destination:'carrier'},
    {index:2,header:'Estado',destination:'rawStatus'},{index:3,header:'Fecha',destination:'eventAt'},
    {index:4,header:'Corte',destination:'reportAsOf'},
  ],statusMap:{Entregado:'delivered'}};
  const profile = await saveResource(store,'profiles',{requestId:requestId(),name:'Seguimiento conservado',sourceId:fixture.source.id,profile:config},fixture.actorId);
  const bytes = writeExcelSheets([{name:'Seguimiento',rows:[['Guía','Transportadora','Estado','Fecha','Corte'],['0000123456789','Transportadora sintética','Entregado','2025-09-03','2025-09-05']]}]);
  let batch;
  for (let pass=0;pass<2;pass++) {
    batch = await createImportBatch(store,{requestId:requestId(),sourceId:fixture.source.id,profileId:profile.id},fixture.actorId);
    await uploadImportFile(store,batch.id,{requestId:requestId(),version:batch.version,filename:'seguimiento.xlsx',bytes},fixture.actorId);
    await processImportTurn(store,{batchId:batch.id});
    batch = await getImportBatch(store,batch.id);
    await requestImportPreview(store,batch.id,{requestId:requestId(),version:batch.version},fixture.actorId);
    await processImportTurn(store,{batchId:batch.id});
    batch = await getImportBatch(store,batch.id);
    assert.equal(batch.preview.summary.valid,1,JSON.stringify(batch.preview));
    await commitImport(store,batch.id,{requestId:requestId(),version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false},fixture.actorId);
    if (pass===0) {
      await processImportTurn(store,{batchId:batch.id});
      assert.equal((await getImportBatch(store,batch.id)).state,'completed');
    }
  }
  const lease = await claimJob(store,{key:`import:${batch.id}`});
  assert.ok(lease.token);
  await store.db.run(`INSERT INTO ${store.t('job_runs')}(key,state,lease_token,lease_until,data,version,created_at,updated_at) VALUES('scheduler:heartbeat','running',?,?,?,1,?,?)`,['private-heartbeat-token','2099-01-01T00:00:00.000Z','{}',new Date().toISOString(),new Date().toISOString()]);
  const before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
  // If export regresses to a writer transaction this fails on either adapter.
  const transaction = store.transaction, lockWrites = store.lockWrites;
  store.transaction = () => { throw new Error('Export attempted a write transaction'); };
  store.lockWrites = () => { throw new Error('Export attempted a write lock'); };
  let bundle;
  try { bundle = await store.exportData(); }
  finally { store.transaction = transaction; store.lockWrites = lockWrites; }
  assert.equal((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value,before.value);
  const serialized = JSON.stringify(bundle);
  for (const secret of [auth.token,auth.csrf,'scrypt:','private-heartbeat-token',lease.token,'lease_token','leaseToken','scheduler:heartbeat','backup-auth-only@example.test']) assert.ok(!serialized.includes(secret),`Leaked ${secret}`);
  assert.equal(bundle.format,'allnutrition-export-v3');
  assert.equal(bundle.inventoryVersion,1);
  assert.ok(bundle.products.every(product => Number.isSafeInteger(product.stockReserved) && product.stockReserved >= 0));
  assert.ok(bundle.orders.every(order => order.inventory?.version === 1));
  assert.equal(bundle.orders[0].history,undefined);
  assert.equal(bundle.orders[0].financialSummary,undefined);
  assert.ok(bundle.order_audit.length && bundle.idempotency.length);
  assert.ok(bundle.business.external_links.length,'Applied source aliases are commercial data');
  assert.equal(bundle.business.import_revisions.length,2);
  assert.ok(bundle.business.payroll_offsets.length && bundle.business.cash_closings.length && bundle.business.order_returns.length);
  assert.ok(bundle.business.settlements.some(row => JSON.parse(row.data).reconciliationRequired));
  assert.equal(bundle.business.import_batches[0].file_bytes_base64,Buffer.from(bytes).toString('base64'));
  assert.equal(bundle.pendingJobs.find(job => job.kind === 'import').actorId,fixture.actorId);
  assert.equal(bundle.pendingJobs.find(job => job.kind === 'report').key,reportRequest.jobKey);
  return {bundle,batchId:batch.id,bytes:Buffer.from(bytes).toString('base64'),actorId:fixture.actorId,orderId:fixture.orderId,personId:fixture.person.id,sourceUserId:auth.user.id};
}

/** Restore into a fresh/reset store; no reset is performed by this helper. */
export async function restoreCommercialBackupScenario(store, scenario, {resume = true} = {}) {
  const {bundle,batchId,bytes,actorId,personId} = scenario;
  const original = JSON.stringify(bundle);
  await createAdmin(store,'destination-only@example.test','destination-only-password');
  const result = await importData(store,bundle);
  assert.equal(result.orders,1); assert.ok(result.businessRows > 30); assert.equal(result.pendingJobs,2);
  assert.equal(JSON.stringify(bundle),original,'Restore must not rewrite its input');
  const restored = await store.exportData();
  const expected = stable(bundle), actual = stable(restored);
  expected.settings.launchApproved = false;
  const person = expected.business.people.find(row => row.id === personId);
  person.data = JSON.stringify({...JSON.parse(person.data),userId:null});
  assert.deepEqual(actual,expected);
  assert.equal((await store.settings()).launchApproved,false);
  assert.equal((await store.db.get(`SELECT file_bytes_base64 FROM ${store.t('import_batches')} WHERE id=?`,[batchId])).file_bytes_base64,bytes);
  assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('users')}`)).n),1);
  const jobs = await store.db.all(`SELECT * FROM ${store.t('job_runs')} ORDER BY key`);
  assert.ok(jobs.every(row => row.state === 'queued' && row.lease_token === null && row.lease_until === null));
  assert.ok(jobs.every(row => JSON.parse(row.data).requestedBy === actorId));
  if (resume) {
    const before = await store.order(scenario.orderId);
    await processImportTurn(store,{batchId});
    const batch = await getImportBatch(store,batchId);
    assert.equal(batch.state,'completed',JSON.stringify(batch.error || batch.progress));
    const after = await store.order(scenario.orderId);
    assert.deepEqual(after.paymentSummary,before.paymentSummary);
    assert.equal(after.totalMinor,before.totalMinor);
    const count = Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_collections')}`)).n);
    await processImportTurn(store,{batchId});
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_collections')}`)).n),count);
    await processReportTurn(store,{maxReports:10});
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('report_snapshots')}`)).n),2);
  }
}

export async function assertInvalidBackupsAtomic(store, bundle) {
  const before = stable(await store.exportData());
  const mutateData = (copy,table,fn) => {const row = copy.business[table][0], data = JSON.parse(row.data);fn(data);row.data=JSON.stringify(data);};
  const invalid = [
    copy => {copy.business.expenses[0].amount_minor=Number.MAX_SAFE_INTEGER;},
    copy => {copy.business.cash_entries[0].account_id='missing-account';},
    copy => {copy.business.order_collections[0].holder='invented';},
    copy => {copy.business.people.push(copy.business.people[0]);},
    copy => {copy.business.import_batches[0].file_bytes_base64='Y29ycnVwdA==';},
    copy => {copy.business.import_revisions[0].preview_hash='not-a-hash';},
    copy => {copy.business.shipment_events[0].occurred_on='2025-02-30';},
    copy => {copy.business.people[0].version=0;},
    copy => {copy.counters.find(row => row.id==='orders').value=0;},
    copy => mutateData(copy,'settlements',data => {data.lines[0].collectionId='missing-collection';}),
    copy => mutateData(copy,'shipments',data => {data.assignments[0].lineId='missing-line';}),
    copy => mutateData(copy,'order_returns',data => {data.lines[0].lineId='missing-line';}),
    copy => {copy.business.payroll_allocations[0].source_id='missing-obligation';},
    copy => mutateData(copy,'report_snapshots',data => {data.metrics.cashAvailable.value=Number.MAX_SAFE_INTEGER+1;}),
    copy => {copy.products[0].stockReserved++;},
    copy => {copy.products[0].stockQuantity=-1;},
    copy => {copy.products[0].stockQuantity='10000';},
    copy => {copy.orders[0].inventory.products[0].consumed++;},
    copy => {copy.orders[0].inventory.products[0].productId='missing-product';},
    copy => {delete copy.orders[0].inventory;},
    copy => {delete copy.products[0].stockReserved;},
    copy => {copy.orders[0].inventory.products.push({...copy.orders[0].inventory.products[0]});},
  ];
  // The fixture need not contain a return for the other independent cases.
  if (!bundle.business.order_returns.length) invalid.splice(11,1);
  for (const corrupt of invalid) {
    const copy = structuredClone(bundle); corrupt(copy); copy.settings.brandName='Must roll back';
    await assert.rejects(() => importData(store,copy));
    assert.deepEqual(stable(await store.exportData()),before);
  }
  // A database constraint failure after settings and parents have been inserted
  // must roll the entire transaction back as well, not only validation errors.
  const copy = structuredClone(bundle);
  copy.business.product_costs[0].unit_cost_minor=-1;
  await assert.rejects(() => importData(store,copy));
  assert.deepEqual(stable(await store.exportData()),before);
}

export function legacyPartialBackup() {
  const productId = randomUUID(), orderId = randomUUID(), at = '2025-09-01T15:00:00.000Z';
  const bundle = {format:'allnutrition-export-v2',settings:{...defaults,launchApproved:true},orders:[],...Object.fromEntries(Object.keys(schemas).map(kind => [kind,[]]))};
  bundle.products.push({...emptyRecord('products'),id:productId,version:1,createdAt:at,updatedAt:at,title:'Producto histórico',slug:'producto-historico',status:'archived',presentation:'Unidad',price:55000});
  bundle.orders.push({id:orderId,number:7,version:2,createdAt:at,updatedAt:at,customerName:'Destinatario histórico',phone:'3001234567',city:'Bogotá',department:'Bogotá',address:'Dirección histórica',status:'new',deliveryMethod:'carrier',shippingCost:0,subtotal:55000,total:55000,paymentStatus:'partial',paymentAmount:20000,paymentDate:'2025-09-01',items:[{kind:'products',itemId:productId,title:'Producto histórico',presentation:'Unidad',quantity:1,unitPrice:55000}],history:[{actorId:'historical-admin',previousStatus:null,nextStatus:'new',createdAt:at}]});
  return bundle;
}
export async function assertLegacyPartialRestore(store) {
  const bundle = legacyPartialBackup(), original = JSON.stringify(bundle);
  await importData(store,bundle,{migrationAt:'2025-10-01T00:00:00.000Z'});
  assert.equal(JSON.stringify(bundle),original);
  const restored = await store.exportData();
  assert.equal(restored.orders[0].number,7);
  assert.equal(restored.orders[0].totalMinor,5500000);
  assert.equal(restored.business.order_collections[0].amount_minor,2000000);
  assert.equal(restored.business.order_collections[0].holder,'legacy');
  assert.equal(restored.business.order_collections[0].cash_entry_id,null);
  assert.equal(restored.business.cash_entries.length,0);
  assert.equal(restored.order_audit[0].actor_id,'historical-admin');
  assert.equal(restored.orders[0].paymentAmount,undefined);
  assert.equal(restored.counters.find(row => row.id==='orders').value,7);
  assert.equal(restored.inventoryVersion,1);
  assert.equal(restored.products[0].stockQuantity,null);
  assert.equal(restored.products[0].stockReserved,1);
}
