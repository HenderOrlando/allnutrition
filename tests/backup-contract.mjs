import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { importData } from '../lib/import.mjs';
import { emptyRecord, defaults, schemas } from '../lib/schema.mjs';
import { createBusinessFixture, returnBusinessFixture, requestId } from './business-fixtures.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch, uploadImportFile, getImportBatch, updateImportBatch, requestImportPreview, commitImport, processImportTurn } from '../lib/business/imports.mjs';
import { generateReportSnapshot, saveReportSnapshot, processReportTurn } from '../lib/business/reports.mjs';
import { claimJob, queueJobTx } from '../lib/business/job-leases.mjs';
import { saveAccount, recordAdvance, transferMoney, closeCash } from '../lib/business/cash.mjs';
import { confirmPayroll } from '../lib/business/payroll.mjs';
import { saveSettlement } from '../lib/business/settlements.mjs';
import { createShipment, getShipment, saveShipment } from '../lib/business/shipments.mjs';
import { recordExpense, payExpense } from '../lib/business/expenses.mjs';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { inventoryState } from '../lib/business/inventory.mjs';
import { COMMERCIAL_TABLES, CORE_BACKUP_TABLES } from '../lib/backup-schema.mjs';
import { SOCIAL_TABLES, SOCIAL_INTERNAL_TABLES, INTEGRATION_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { socialMeasurementQueryKey } from '../lib/social/evidence.mjs';
import { prepareSocialApiJobs } from '../lib/business/social-api-jobs.mjs';
import { prepareSocialBrowserJobs } from '../lib/business/social-jobs.mjs';

const stable = bundle => {
  const copy = structuredClone(bundle);
  delete copy.exportedAt;
  const sortRows = (rows,keys) => rows?.sort((left,right) => JSON.stringify(keys.map(key => left[key])).localeCompare(JSON.stringify(keys.map(key => right[key]))));
  for (const [table,{key}] of Object.entries(COMMERCIAL_TABLES)) sortRows(copy.business?.[table],key);
  for (const [table,{key}] of Object.entries(CORE_BACKUP_TABLES)) sortRows(copy[table],key);
  for (const table of [...Object.keys(schemas),'orders','counters']) sortRows(copy[table],['id']);
  sortRows(copy.pendingJobs,['key']);
  return copy;
};
const configSheet = config => config.formatVersion === 2 ? config.sheets.find(sheet => sheet.enabled) : config;
const shipmentAdditionalFields = values => values?.shipmentAdditionalFields || values?.additionalFields;
const financialTables = ['order_collections','cash_entries','expense_payments'];
const financialFacts = async store => Object.fromEntries(await Promise.all(financialTables.map(async table => [table,await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`)])));

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
  const insurance = await recordExpense(store,{requestId:requestId(),category:'shipping_insurance',shipmentId:fixture.shipmentId,amountMinor:100000,incurredOn:'2025-09-02',concept:'Prima conservada en respaldo'},fixture.actorId);
  await payExpense(store,{requestId:requestId(),expenseId:insurance.id,version:insurance.version,amountMinor:25000,accountId:fixture.account.id,effectiveOn:'2025-09-06',reference:'PAGO-SEGURO-RESPALDO'},fixture.actorId);
  const insuranceShipments = {known:fixture.shipmentId};
  for (const [state,amountMinor] of [['zero',0],['unknown',null]]) {
    const shipment = await createShipment(store,{requestId:requestId(),sourceId:fixture.source.id,externalId:`BACKUP-INSURANCE-${state}`,carrier:'Transportadora sintética',tracking:`BACKUP-${state}`},fixture.actorId);
    insuranceShipments[state] = shipment.id;
    await recordExpense(store,{requestId:requestId(),category:'shipping_insurance',shipmentId:shipment.id,amountMinor,incurredOn:'2025-09-02',concept:`Seguro ${state} conservado`},fixture.actorId);
  }
  const financesBeforeImports = await financialFacts(store);
  const query = {period:'month',anchorDate:'2025-09-01'};
  await generateReportSnapshot(store,query,fixture.actorId);
  const reportRequest = await saveReportSnapshot(store,{period:'month',anchorDate:'2025-10-01',requestId:requestId()},fixture.actorId);
  const config = {sheetName:'Seguimiento',headerRow:1,dateFormat:'ISO',purpose:'tracking',columns:[
    {index:0,header:'Guía',destination:'tracking'},{index:1,header:'Transportadora',destination:'carrier'},
    {index:2,header:'Estado',destination:'rawStatus'},{index:3,header:'Fecha',destination:'eventAt'},
    {index:4,header:'Corte',destination:'reportAsOf'},{index:5,header:'Estado',destination:'rawShipmentStatus'},
    {index:6,header:'Extra',destination:'additionalField',fieldName:'Centro de despacho'},
    {index:7,header:'Extra',destination:'additionalField',fieldName:'__proto__'},
    {index:8,header:'Valor declarado',destination:'insuredValue'},{index:9,header:'Valor solicitado',destination:'expectedCollection'},
    {index:10,header:'Tipo',destination:'shippingType'},{index:11,header:'Destinatario',destination:'customerName'},
  ],statusMap:{Entregado:'delivered'}};
  const profile = await saveResource(store,'profiles',{requestId:requestId(),name:'Seguimiento conservado',sourceId:fixture.source.id,profile:config},fixture.actorId);
  const legacyProfile = await saveResource(store,'profiles',{requestId:requestId(),name:'Perfil antiguo pendiente de corregir',sourceId:fixture.source.id,profile:config},fixture.actorId);
  const legacyConfig = {...config,columns:config.columns.map(column => column.index === 1 ? {...column,destination:'tracking'} : column)};
  await store.db.run(`UPDATE ${store.t('import_profiles')} SET data=?,version=version+1 WHERE id=?`,[JSON.stringify(legacyConfig),legacyProfile.id]);
  const otherSource = await saveResource(store,'sources',{requestId:requestId(),name:'Observaciones secundarias',platformId:fixture.platform.id},fixture.actorId);
  const otherConfig = {...config,columns:config.columns.map(column => ['rawStatus','eventAt','reportAsOf'].includes(column.destination) ? {...column,destination:'ignore'} : column)};
  const otherProfile = await saveResource(store,'profiles',{requestId:requestId(),name:'Información de otra fuente',sourceId:otherSource.id,profile:otherConfig},fixture.actorId);
  const bytes = writeExcelSheets([{name:'Seguimiento',rows:[
    ['Guía','Transportadora','Estado','Fecha','Corte','Estado','Extra','Extra','Valor declarado','Valor solicitado','Tipo','Destinatario'],
    ['0000123456789','Transportadora sintética','Entregado','2025-09-03','2025-09-05','PAGADA','Bodega sintética','<b>00017</b>',55000,55000,'PAGO CONTRAENTREGA','Destinatario observado'],
  ]}]);
  let batch, firstImportedFields;
  for (let pass=0;pass<3;pass++) {
    const secondary = pass === 1;
    batch = await createImportBatch(store,{requestId:requestId(),sourceId:secondary ? otherSource.id : fixture.source.id,profileId:secondary ? otherProfile.id : profile.id},fixture.actorId);
    await uploadImportFile(store,batch.id,{requestId:requestId(),version:batch.version,filename:'seguimiento.xlsx',bytes},fixture.actorId);
    await processImportTurn(store,{batchId:batch.id});
    batch = await getImportBatch(store,batch.id);
    if (secondary) batch = await updateImportBatch(store,batch.id,{requestId:requestId(),version:batch.version,resolutions:[{action:'link_shipment',sheet:'Seguimiento',rowNumber:2,internalId:fixture.shipmentId}]},fixture.actorId);
    await requestImportPreview(store,batch.id,{requestId:requestId(),version:batch.version},fixture.actorId);
    await processImportTurn(store,{batchId:batch.id});
    batch = await getImportBatch(store,batch.id);
    assert.equal(batch.preview.summary.valid,1,JSON.stringify(batch.preview));
    await commitImport(store,batch.id,{requestId:requestId(),version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false},fixture.actorId);
    if (pass<2) {
      await processImportTurn(store,{batchId:batch.id});
      assert.equal((await getImportBatch(store,batch.id)).state,'completed');
      const fields = (await getShipment(store,fixture.shipmentId)).importedFields;
      if (pass === 0) {
        firstImportedFields = structuredClone(fields);
        const shipment = await getShipment(store,fixture.shipmentId);
        await saveShipment(store,{requestId:requestId(),version:shipment.version,notes:'Nota manual separada de la información importada',reason:'Conservar observaciones al corregir notas'},fixture.actorId,shipment.id);
        assert.deepEqual((await getShipment(store,shipment.id)).importedFields,firstImportedFields);
      }
      else assert.deepEqual(fields.filter(field => field.sourceId === fixture.source.id),firstImportedFields,'A second source must preserve the first source provenance');
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
  assert.equal(bundle.business.import_revisions.length,3);
  assert.ok(bundle.business.payroll_offsets.length && bundle.business.cash_closings.length && bundle.business.order_returns.length);
  assert.ok(bundle.business.settlements.some(row => JSON.parse(row.data).reconciliationRequired));
  assert.equal(bundle.business.import_batches[0].file_bytes_base64,Buffer.from(bytes).toString('base64'));
  assert.equal(bundle.pendingJobs.find(job => job.kind === 'import').actorId,fixture.actorId);
  assert.equal(bundle.pendingJobs.find(job => job.kind === 'report').key,reportRequest.jobKey);
  assert.deepEqual(await financialFacts(store),financesBeforeImports,'Informational import must not create collections, cash entries, or expense payments');
  const shipmentData = JSON.parse(bundle.business.shipments.find(row => row.id === fixture.shipmentId).data);
  const fields = shipmentData.importedFields;
  assert.equal(fields.length,14);
  assert.deepEqual(fields.filter(field => field.sourceId === fixture.source.id),firstImportedFields);
  for (const sourceId of [fixture.source.id,otherSource.id]) {
    const observations = fields.filter(field => field.sourceId === sourceId);
    const value = key => observations.find(field => field.key === key)?.value;
    assert.equal(value('rawShipmentStatus'),'PAGADA');
    assert.equal(value('shippingType'),'PAGO CONTRAENTREGA');
    assert.equal(value('insuredValue'),5500000);
    assert.equal(value('expectedCollection'),5500000);
    assert.equal(value('additional:centro de despacho'),'Bodega sintética');
    assert.equal(value('additional:__proto__'),'<b>00017</b>');
    assert.equal(value('customerName'),'Destinatario observado');
    for (const field of observations) {
      assert.equal(field.sourceAsOf,sourceId === fixture.source.id ? '2025-09-06T04:59:59.999Z' : null);
      assert.equal(field.sheet,'Seguimiento'); assert.deepEqual(field.rowNumbers,[2]);
      assert.equal(bundle.business.import_batches.find(row => row.id === field.batchId).source_id,sourceId);
      assert.equal(field.header,['Guía','Transportadora','Estado','Fecha','Corte','Estado','Extra','Extra','Valor declarado','Valor solicitado','Tipo','Destinatario'][field.columnIndex]);
    }
  }
  assert.equal((await store.order(fixture.orderId)).customerName,'Destinatario sintético','Observed recipient is not an authorized order edit');
  assert.equal(shipmentData.notes,'Nota manual separada de la información importada');
  const frozen = JSON.parse(bundle.business.import_revisions.find(row => row.batch_id === batch.id).data);
  assert.equal(configSheet(frozen.config).columns.find(column => column.index === 7).fieldName,'__proto__');
  assert.deepEqual(shipmentAdditionalFields(frozen.groups[0].rows[0].values).map(field => [field.key,field.value,field.columnIndex]),[['additional:centro de despacho','Bodega sintética',6],['additional:__proto__','<b>00017</b>',7]]);
  for (const [state,shipmentId] of Object.entries(insuranceShipments)) {
    const data = JSON.parse(bundle.business.shipments.find(row => row.id === shipmentId).data);
    assert.equal(data.costStatuses.shipping_insurance,state === 'unknown' ? 'unknown' : 'known');
    assert.equal(data.costObservations.shipping_insurance.amountMinor,state === 'known' ? 100000 : state === 'zero' ? 0 : null);
    const expense = bundle.business.expenses.find(row => row.source_key === `${shipmentId}:shipping_insurance`);
    assert.equal(expense?.amount_minor,state === 'unknown' ? undefined : state === 'zero' ? 0 : 100000);
  }
  const baselineBundle = structuredClone(bundle);
  // Restore opening evidence and imported metadata without changing stock.
  const order = bundle.orders.find(value => value.id === fixture.orderId);
  const audit = {confirmedBy:fixture.actorId,confirmedAt:'2025-10-02T12:00:00.000Z',reason:'Conteo físico confirmado del negocio'};
  const shipments = bundle.business.shipments.map(entity).filter(value => value.orderId === order.id);
  const events = new Map(shipments.map(shipment => [shipment.id,bundle.business.shipment_events.map(entity).filter(value => value.shipmentId === shipment.id)]));
  const returns = bundle.business.order_returns.map(entity).filter(value => value.orderId === order.id);
  order.marketingCampaign = 'CAMP-RESPALDO';
  order.items.forEach((line,index) => {line.externalLineId = `LINEA-RESPALDO-${index+1}`;});
  order.inventoryOpening = {on:'2025-10-01',sourceId:fixture.source.id,batchId:batch.id,confirmedBy:audit.confirmedBy,confirmedAt:audit.confirmedAt,eventClassifications:[...events.values()].flat().map(event => ({eventId:event.id,included:true,...audit})),returnClassifications:returns.map(returned => ({returnId:returned.id,included:true,...audit}))};
  order.inventory = inventoryState(order,shipments,events,returns);
  bundle.inventoryVersion = 2;
  const provenance = {...firstImportedFields.find(field => field.key.startsWith('additional:')),declaredOrigin:{sheet:'Archivo anterior',rowNumber:17,columnIndex:3,header:'Referencia original'}};
  order.importedFields = [provenance];
  const importedExpense = {...bundle.business.expenses[0],id:randomUUID(),category:'advertising',amount_minor:2500000,incurred_on:'2025-09-02',person_id:null,order_id:null,shipment_id:null,source_key:`excel-expense:${hash([fixture.source.id,'GASTO-RESPALDO'])}`,version:1};
  importedExpense.data = JSON.stringify({concept:'Publicidad conservada',supplier:'Proveedor sintético',source:'excel',sourceId:fixture.source.id,sourceAsOf:'2025-09-06T04:59:59.999Z',campaign:'CAMP-RESPALDO',quantity:10,unitCostMinor:250000,reference:'REF-RESPALDO',notes:'Sin pago implícito',importIdentity:{externalId:'GASTO-RESPALDO',generated:false},importedFields:[provenance]});
  bundle.business.expenses.push(importedExpense);
  assert.equal(bundle.business.expense_payments.filter(row => row.expense_id === insurance.id).reduce((sum,row) => sum+row.amount_minor,0),25000);
  return {bundle,baselineBundle,batchId:batch.id,bytes:Buffer.from(bytes).toString('base64'),actorId:fixture.actorId,orderId:fixture.orderId,shipmentId:fixture.shipmentId,insuranceShipments,insuranceId:insurance.id,personId:fixture.person.id,sourceUserId:auth.user.id};
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
    const accepted = bundle.business.import_revisions.find(row => row.batch_id === batchId);
    const acceptedBytes = accepted.data;
    const profileId = JSON.parse(acceptedBytes).profileId;
    if (profileId) await store.db.run(`UPDATE ${store.t('import_profiles')} SET version=version+1 WHERE id=?`,[profileId]);
    const shipmentBefore = await getShipment(store,scenario.shipmentId), financesBefore = await financialFacts(store);
    await processImportTurn(store,{batchId});
    const batch = await getImportBatch(store,batchId);
    assert.equal(batch.state,'completed',JSON.stringify(batch.error || batch.progress));
    const after = await store.order(scenario.orderId);
    assert.deepEqual(after.paymentSummary,before.paymentSummary);
    assert.equal(after.totalMinor,before.totalMinor);
    const shipmentAfter = await getShipment(store,scenario.shipmentId);
    assert.equal(after.marketingCampaign,'CAMP-RESPALDO');
    assert.deepEqual(after.inventoryOpening,before.inventoryOpening);
    assert.deepEqual(after.inventory,before.inventory);
    assert.equal((await store.db.get(`SELECT data FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=?`,[batchId,accepted.revision])).data,acceptedBytes,'Accepted bytes remain immutable after resume and profile edits');
    assert.deepEqual(shipmentAfter.importedFields,shipmentBefore.importedFields,'Resume preserves original observation provenance');
    assert.deepEqual(await financialFacts(store),financesBefore,'Resume must not duplicate insurance payments or other financial facts');
    for (const shipmentId of Object.values(scenario.insuranceShipments)) {
      const expectedData = JSON.parse(bundle.business.shipments.find(row => row.id === shipmentId).data);
      const shipment = await getShipment(store,shipmentId);
      assert.deepEqual(shipment.costObservations.shipping_insurance,expectedData.costObservations.shipping_insurance);
      assert.equal(shipment.costStatuses.shipping_insurance,expectedData.costStatuses.shipping_insurance);
    }
    const count = Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_collections')}`)).n);
    await processImportTurn(store,{batchId});
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_collections')}`)).n),count);
    await processReportTurn(store,{maxReports:10});
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('report_snapshots')}`)).n),2);
  }
}

export async function assertInvalidBackupsAtomic(store, bundle) {
  const before = stable(await store.exportData());
  const mutateData = (copy,table,fn,predicate = () => true) => {const row = copy.business[table].find(row => predicate(JSON.parse(row.data))), data = JSON.parse(row.data);fn(data);row.data=JSON.stringify(data);};
  const mutateImported = (copy,fn) => mutateData(copy,'shipments',data => fn(data.importedFields),data => data.importedFields?.length);
  const mutateFrozen = (copy,fn) => mutateData(copy,'import_revisions',data => fn(data.groups[0].units[0].shipments[0].importedFields));
  const revisionEvents = data => data.groups.flatMap(group => group.units.flatMap(unit => unit.shipments.flatMap(shipment => shipment.events || [])));
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
    copy => mutateData(copy,'shipments',data => {data.assignments[0].lineId='missing-line';},data => data.assignments?.length),
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
    copy => {copy.inventoryVersion=1;},
    copy => {copy.orders[0].inventoryOpening.sourceId='missing-source';},
    copy => {copy.orders[0].inventoryOpening.batchId='missing-batch';},
    copy => {copy.orders[0].inventory.openingProducts.push({productId:'missing-product',consumed:1});},
    copy => {copy.orders[0].inventoryOpening.eventClassifications[0].eventId='missing-event';},
    copy => {copy.orders[0].inventoryOpening.eventClassifications[0].included=null;},
    copy => {copy.orders[0].inventoryOpening.returnClassifications[0].returnId='missing-return';},
    copy => {const expense=copy.business.expenses.find(row => row.source_key?.startsWith('excel-expense:'));expense.source_key+='tampered';},
    copy => mutateData(copy,'expenses',data => {data.importIdentity.externalId='another-id';},data => !!data.importIdentity),
    copy => mutateData(copy,'expenses',data => {data.importIdentity.generated='false';},data => !!data.importIdentity),
    copy => mutateData(copy,'expenses',data => {data.sourceId='missing-source';},data => !!data.importIdentity),
    copy => {copy.orders[0].importedFields[0].declaredOrigin.columnIndex=200;},
    copy => mutateData(copy,'import_revisions',data => {data.groups[0].rowRefs=[{sheet:'missing-sheet',rowNumber:2}];}),
    copy => mutateData(copy,'import_revisions',data => {data.manifest=[];}),
    copy => mutateData(copy,'import_revisions',data => {revisionEvents(data)[0].explicitExternalKey='false';},data => revisionEvents(data).length>0),
    copy => mutateData(copy,'import_batches',data => {(data.progress ||= {}).expenseIds=['missing-expense'];}),
    copy => mutateData(copy,'import_revisions',data => {(data.resolutions ||= []).push({action:'cell_value',sheet:'Seguimiento',rowNumber:2,columnIndex:200,value:'Dato',reason:'Corrección inválida'});}),
    copy => {copy.orders[0].inventory.products.push({...copy.orders[0].inventory.products[0]});},
    copy => mutateImported(copy,fields => {fields[0].sourceId='missing-source';}),
    copy => mutateImported(copy,fields => {fields[0].batchId='missing-batch';}),
    copy => mutateImported(copy,fields => {fields[0].sourceId=fields.find(field => field.sourceId !== fields[0].sourceId).sourceId;}),
    copy => mutateImported(copy,fields => {fields[0].batchId=fields.find(field => field.sourceId !== fields[0].sourceId).batchId;}),
    copy => mutateImported(copy,fields => {fields[0].key='status';}),
    copy => mutateImported(copy,fields => {fields[0].value={html:'not a string'};}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='insuredValue').value='5500000';}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='expectedCollection').value=1.5;}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='insuredValue').value=-1;}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='expectedCollection').value=Number.MAX_SAFE_INTEGER;}),
    copy => mutateImported(copy,fields => {fields.push({...fields[0]});}),
    copy => mutateImported(copy,fields => {const base=fields[0];for(let index=0;index<201;index++)fields.push({...base,key:`additional:campo ${index}`,label:`Campo ${index}`,value:'Dato adicional'});}),
    copy => mutateImported(copy,fields => {fields[0].sourceAsOf='2025-09-05';}),
    copy => mutateImported(copy,fields => {fields[0].sourceAsOf='2025-09-06T04:59:59.999-00:00';}),
    copy => mutateImported(copy,fields => {const field=fields[1],row=copy.business.import_rows.find(row=>row.batch_id===field.batchId && row.sheet===field.sheet && row.row_number===field.rowNumbers[0]);field.sheet='Hoja inexistente';copy.business.import_rows.push({...row,sheet:field.sheet});}),
    copy => {const field=JSON.parse(copy.business.shipments.find(row=>JSON.parse(row.data).importedFields?.length).data).importedFields[0];mutateData(copy,'import_batches',data=>{data.workbook.sheets=[];},data=>data.workbook?.sheets?.some(sheet=>(typeof sheet==='string'?sheet:sheet.name)===field.sheet));},
    copy => mutateImported(copy,fields => {fields[0].rowNumbers=[0];}),
    copy => mutateImported(copy,fields => {fields[0].columnIndex=200;}),
    copy => mutateImported(copy,fields => {fields[0].extra='not part of the contract';}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='additional:__proto__').key='__proto__';}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='additional:__proto__').value='x'.repeat(4001);}),
    copy => mutateImported(copy,fields => {fields.find(field => field.key==='additional:centro de despacho').key='additional:Centro de despacho';}),
    copy => mutateData(copy,'shipments',data => {data.importedFields=null;},data => data.importedFields?.length),
    copy => mutateData(copy,'import_profiles',data => {configSheet(data).columns.find(column => column.destination==='additionalField').fieldName='';},data => configSheet(data).columns.some(column => column.destination === 'additionalField')),
    copy => mutateData(copy,'import_profiles',data => {const additional=configSheet(data).columns.filter(column => column.destination==='additionalField');additional[1].fieldName=` ${additional[0].fieldName.toUpperCase()} `;},data => configSheet(data).columns.filter(column => column.destination === 'additionalField').length > 1),
    copy => mutateData(copy,'import_profiles',data => {configSheet(data).columns[0].destination='not-a-destination';}),
    copy => mutateData(copy,'import_profiles',data => {configSheet(data).columns[1].index=configSheet(data).columns[0].index;}),
    copy => mutateFrozen(copy,fields => {fields[0].batchId='missing-batch';}),
    copy => mutateFrozen(copy,fields => {const other=copy.business.import_batches.find(batch => batch.source_id !== fields[0].sourceId);fields[0].batchId=other.id;fields[0].sourceId=other.source_id;}),
    copy => mutateFrozen(copy,fields => {fields[0].key='status';}),
    copy => mutateFrozen(copy,fields => {fields.find(field => field.key==='insuredValue').value=0.5;}),
    copy => mutateFrozen(copy,fields => {fields.push({...fields[0]});}),
    copy => mutateData(copy,'import_rows',data => {shipmentAdditionalFields(data.normalized.values)[0].value={not:'text'};},data => shipmentAdditionalFields(data.normalized?.values)?.length),
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

/** Sequential source/destination factories also work with the reset-only PG fixture. */
export async function runSocialBackupContracts(t, factory) {
  await t.test('social evidence survives restoration without credentials, runnable work or publishable media',async () => {
    const source = await factory();
    let scenario;
    try { scenario = await createSocialBackupScenario(source); }
    finally { await source.close(); }
    const target = await factory();
    try {
      const {bundle,ids} = scenario, original = structuredClone(bundle);
      assert.equal(bundle.socialVersion,1);
      assert.ok(!JSON.stringify(bundle).includes('social-private-canary'));
      for (const table of [...SOCIAL_INTERNAL_TABLES,...INTEGRATION_INTERNAL_TABLES]) assert.equal(Object.hasOwn(bundle.business,table),false);
      assert.ok(!bundle.pendingJobs.some(job => job.key.startsWith('social:')));
      assert.ok(!bundle.business.business_requests.some(row => row.scope.startsWith('social:')));
      assert.equal(JSON.parse(bundle.business.business_audit.find(row => row.entity_type === 'social_connection').data).action,'validate');
      const before = stable(await target.exportData());
      const mutate = (copy,table,fn) => { const row = copy.business[table][0], data = JSON.parse(row.data); fn(data); row.data=JSON.stringify(data); };
      const corruptions = [
        copy => {delete copy.socialVersion;},
        copy => {delete copy.business.social_measurements;},
        copy => {copy.socialVersion=2;},
        copy => {copy.business.social_credentials=[];},
        copy => {copy.business.social_deliveries[0].revision=99;},
        copy => {const row=copy.business.social_operations[0];row.delivery_id=ids.deliveries.find(id => id !== row.delivery_id);},
        copy => {copy.business.social_order_links[0].campaign_id=randomUUID();},
        copy => {copy.business.social_forecasts[0].spec_hash='invalid';},
        copy => mutate(copy,'social_forecasts',data => {data.specHash='a'.repeat(64);}),
        copy => mutate(copy,'social_revisions',data => {data.spec.budgetMinor++;}),
        copy => mutate(copy,'social_revisions',data => {data.spec.integrationMethod=data.spec.integrationMethod === 'api' ? 'browser' : 'api';}),
        copy => mutate(copy,'social_measurements',data => {data.integrationMethod=data.integrationMethod === 'api' ? 'browser' : 'api';}),
        copy => mutate(copy,'social_operations',data => {data.integrationMethod=data.integrationMethod === 'api' ? 'browser' : 'api';}),
        copy => mutate(copy,'social_campaigns',data => {data.budgetMinor=0.5;}),
        copy => mutate(copy,'social_campaigns',data => {data.analysis.comparisons[0].spendMinor.value=-1;}),
        copy => mutate(copy,'social_campaigns',data => {data.analysis.comparisons[0].spendMinor.value=1.5;}),
        copy => mutate(copy,'social_campaigns',data => {data.analysis.comparisons[0].spendMinor.unit='count';}),
        copy => mutate(copy,'social_connections',data => {data.accessToken='social-private-canary';}),
        copy => mutate(copy,'social_connections',data => {data.disconnectPending={state:'waiting_for_pause',action:'disconnect',actorId:'backup-admin',deliveryIds:[ids.deliveries[0]]};}),
        copy => mutate(copy,'social_assets',data => {data.derivativeKey='../outside.jpg';}),
        copy => mutate(copy,'social_assets',data => {data.derivativeKey=`${randomUUID()}/derivative.jpg`;}),
        copy => mutate(copy,'social_assets',data => {data.originalKey=`${ids.asset}/original.mp4`;}),
        copy => mutate(copy,'social_assets',data => {data.originalBytes++;}),
        copy => mutate(copy,'social_assets',data => {data.reservedBytes=-1;}),
        copy => mutate(copy,'social_assets',data => {data.kind='video';}),
        copy => {copy.business.social_assets[0].bytes++;},
        copy => mutate(copy,'social_assets',data => {data.diagnostic={code:'RAW-OAUTH-CODE-CANARY',message:'No debe entrar en el respaldo'};}),
        copy => mutate(copy,'social_assets',data => {data.processingFence='private-runtime-lease-canary';}),
        copy => {copy.pendingJobs.push({kind:'social',key:`social:delivery:${ids.deliveries[0]}`});},
        copy => {const row=copy.business.business_audit.find(value => value.entity_type === 'social_connection');row.data=JSON.stringify({cookies:['social-private-canary']});},
        copy => {copy.business.business_requests.push({scope:'social:oauth:start',request_id:'private-restored-request',actor_id:'backup-admin',payload_hash:hash('unsafe'),result_json:JSON.stringify({accessToken:'social-private-canary'}),created_at:'2026-11-02T12:00:00.000Z'});},
        copy => {copy.business.social_measurements[0].payload_hash='a'.repeat(64);},
        copy => {copy.business.social_measurements[0].query_key='a'.repeat(64);},
      ];
      for (const corrupt of corruptions) {
        const copy = structuredClone(bundle); corrupt(copy);
        await assert.rejects(() => importData(target,copy));
        assert.deepEqual(stable(await target.exportData()),before);
      }
      await importData(target,bundle);
      assert.deepEqual(bundle,original);
      const restored = await target.exportData();
      for (const table of ['social_revisions','social_operations','social_measurements','social_forecasts','social_recommendations','social_order_links','social_expense_links']) assert.deepEqual(restored.business[table],bundle.business[table]);
      const deliveryEvidence = rows => rows.map(row => Object.fromEntries(['id','campaign_id','revision','channel','state','remote_id','data'].map(key => [key,row[key]])));
      assert.deepEqual(deliveryEvidence(restored.business.social_deliveries),deliveryEvidence(bundle.business.social_deliveries));
      await prepareSocialApiJobs(target); await prepareSocialBrowserJobs(target);
      for (const row of restored.business.social_connections) {
        const old = bundle.business.social_connections.find(value => value.id === row.id);
        assert.equal(row.state,'reconnect_required');
        assert.equal(row.integration_method,old.integration_method);
        assert.equal(JSON.parse(row.data).sessionEpoch,JSON.parse(old.data).sessionEpoch+1);
      }
      for (const row of restored.business.social_campaigns) assert.equal(JSON.parse(row.data).restore_hold,true);
      for (const row of restored.business.social_campaigns) {
        const spend = JSON.parse(row.data).analysis.comparisons[0].spendMinor;
        assert.equal(spend.value,5000000); assert.equal(spend.unit,'minor_currency'); assert.equal(spend.precision,'exact');
      }
      for (const row of restored.business.social_assets) {
        assert.equal(row.state,'missing_file');
        assert.equal(JSON.parse(row.data).restoreState,'ready');
        assert.equal(row.sha256,bundle.business.social_assets.find(value => value.id === row.id).sha256);
        assert.equal(row.bytes,0);
        assert.equal(JSON.parse(row.data).reservedBytes,0);
      }
      for (const table of [...SOCIAL_INTERNAL_TABLES,...INTEGRATION_INTERNAL_TABLES]) assert.equal(Number((await target.db.get(`SELECT COUNT(*) AS n FROM ${target.t(table)}`)).n),0);
      assert.equal(Number((await target.db.get(`SELECT COUNT(*) AS n FROM ${target.t('job_runs')} WHERE key LIKE 'social:%'`)).n),0);
      assert.deepEqual(restored.orders,bundle.orders);
      assert.deepEqual(restored.business.expenses,bundle.business.expenses);
      assert.deepEqual(restored.business.cash_entries,bundle.business.cash_entries);
      assert.deepEqual(restored.counters,bundle.counters);
    } finally { await target.close(); }
  });
  await t.test('old v3 bundles initialize only absent social collections and internal-only destinations are occupied',async () => {
    const source = await factory();
    let old;
    try { old = await source.exportData(); delete old.socialVersion; for (const table of SOCIAL_TABLES) delete old.business[table]; }
    finally { await source.close(); }
    const target = await factory();
    try {
      const before = stable(await target.exportData());
      for (const invalid of [null,{},'not-a-collection']) {
        const copy = structuredClone(old);
        copy.business.social_assets=invalid;
        await assert.rejects(() => importData(target,copy));
        assert.deepEqual(stable(await target.exportData()),before);
      }
      await importData(target,old);
      const restored = await target.exportData();
      assert.equal(restored.socialVersion,1);
      for (const table of SOCIAL_TABLES) assert.deepEqual(restored.business[table],[]);
    } finally { await target.close(); }
    const occupied = await factory();
    try {
      await insertRow(occupied,'social_oauth_states',{state_hash:hash('pending-oauth'),actor_id:'backup-admin',csrf_hash:hash('social-private-canary'),connection_id:null,expires_at:'2026-11-02T12:10:00.000Z',consumed_at:null});
      const before = await occupied.db.all(`SELECT * FROM ${occupied.t('social_oauth_states')}`);
      await assert.rejects(() => importData(occupied,old));
      assert.deepEqual(await occupied.db.all(`SELECT * FROM ${occupied.t('social_oauth_states')}`),before);
    } finally { await occupied.close(); }
  });
}

async function createSocialBackupScenario(store) {
  await importData(store,legacyPartialBackup());
  const at = '2026-11-02T12:00:00.000Z', actor = 'backup-admin';
  const editable = {version:1,created_at:at,updated_at:at};
  const expense = await recordExpense(store,{requestId:requestId(),category:'advertising',amountMinor:5000000,incurredOn:'2026-11-02',concept:'Publicidad declarada, sin pago implícito'},actor);
  const ids = {connections:[randomUUID(),randomUUID()],asset:randomUUID(),campaigns:[randomUUID(),randomUUID()],deliveries:[randomUUID(),randomUUID()]};
  await store.transaction(async tx => {
    await tx.lockWrites();
    await insertRow(tx,'social_assets',{id:ids.asset,state:'ready',sha256:hash('derived-jpeg'),bytes:300,data:JSON.stringify({kind:'image',name:'Pieza privada',contentType:'image/png',expectedBytes:100,originalKey:`${ids.asset}/original.png`,originalSha256:hash('original-png'),originalBytes:100,derivativeKey:`${ids.asset}/derivative.jpg`,derivativeSha256:hash('derived-jpeg'),derivativeBytes:200,derivativeContentType:'image/jpeg',reservedBytes:0}),...editable});
    for (const [index,integrationMethod] of ['api','browser'].entries()) {
      const connectionId=ids.connections[index], campaignId=ids.campaigns[index], deliveryId=ids.deliveries[index];
      await insertRow(tx,'social_connections',{id:connectionId,provider:'meta',integration_method:integrationMethod,state:'connected',data:JSON.stringify({sessionEpoch:4,identities:{pageId:'verified-page'},capabilities:{adsPublish:true,insights:true},...(index ? {disconnectPending:{state:'waiting_for_pause',action:'delete-platform-data',actorId:actor,requestId:'social-private-canary-disconnect',deliveryIds:[deliveryId]}} : {})}),...editable});
      await insertRow(tx,'social_credentials',{connection_id:connectionId,ciphertext:'social-private-canary-ciphertext',iv:'social-private-canary-iv',auth_tag:'social-private-canary-tag',version:1,updated_at:at});
      const spec = {name:`Campaña ${integrationMethod}`,integrationMethod,connectionId,assetId:ids.asset,assetHash:hash('derived-jpeg'),identities:{pageId:'verified-page'},mode:'paid',objective:'traffic',caption:'Pieza aportada',budgetMinor:5000000,currency:'COP',startAt:at,endAt:'2026-11-09T12:00:00.000Z',observationDays:7};
      const specHash=hash(spec), forecastId=randomUUID();
      const forecast={algorithmVersion:'social-history-v1',source:'insufficient',specHash,metricRanges:{},sampleIds:[],sampleCount:0,budgetMinor:5000000,currency:'COP',horizon:7,assumptions:[],generatedAt:at,unavailableReasons:['Sin historial comparable']};
      await insertRow(tx,'social_campaigns',{id:campaignId,connection_id:connectionId,asset_id:ids.asset,name:spec.name,mode:'paid',objective:'traffic',state:index ? 'ready' : 'active',data:JSON.stringify({...spec,forecastId}),...editable});
      await insertRow(tx,'social_revisions',{campaign_id:campaignId,revision:1,spec_hash:specHash,approved_at:at,actor_id:actor,data:JSON.stringify({spec,forecastId,forecast,acceptedWarnings:[]})});
      await insertRow(tx,'social_deliveries',{id:deliveryId,campaign_id:campaignId,revision:1,channel:'meta_ads',state:index ? 'ready' : 'active',remote_id:`remote-campaign-${index}`,next_sync_at:at,data:JSON.stringify({integrationMethod,remoteRefs:{campaignId:`remote-campaign-${index}`}}),...editable});
      await insertRow(tx,'social_operations',{id:randomUUID(),campaign_id:campaignId,delivery_id:deliveryId,operation_key:`delivery:${deliveryId}:create_campaign`,step:'create_campaign',state:'confirmed',next_attempt_at:null,data:JSON.stringify({integrationMethod,payloadHash:hash(spec),evidence:{remoteId:`remote-campaign-${index}`}}),...editable});
      const query={since:'2026-11-02',until:'2026-11-02',dimension:'aggregate'};
      const measurement={integrationMethod,adapterVersion:index ? 'meta-ui-v1' : 'meta-api-v1',apiVersion:index ? null : 'v26.0',query,periodStart:at,periodEnd:'2026-11-02T13:00:00.000Z',timeZone:'America/Bogota',scope:'paid',attributionSetting:'7d_click',actionReportTime:'impression',dimension:'aggregate',values:{impressions:{value:4000,unit:'count',sourceMetric:'impressions',status:'reported',precision:'exact',displayValue:'4000',reason:null},spendMinor:{value:5000000,unit:'minor_currency',sourceMetric:'spend',status:'reported',precision:'exact',displayValue:'5000000',reason:null}},coverage:{complete:true}};
      const measurementId=randomUUID();
      await insertRow(tx,'social_measurements',{id:measurementId,delivery_id:deliveryId,query_key:socialMeasurementQueryKey(measurement),fetched_at:at,payload_hash:hash(measurement),data:JSON.stringify(measurement)});
      await insertRow(tx,'social_forecasts',{id:forecastId,campaign_id:campaignId,spec_hash:specHash,generated_at:at,data:JSON.stringify(forecast)});
      const analysis={algorithmVersion:'social-history-v1',specHash,forecastId,asOf:at,comparisons:[{metric:'linkClicks',spendMinor:measurement.values.spendMinor,measurementIds:[measurementId]}]};
      await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET data=? WHERE id=?`,[JSON.stringify({...spec,forecastId,analysis}),campaignId]);
      await insertRow(tx,'social_recommendations',{id:randomUUID(),campaign_id:campaignId,evidence_hash:hash(measurement),rule_key:'measurement_gap',state:'suggested',data:JSON.stringify({metricIds:[measurementId],sampleIds:[],observation:'Evidencia conservada',proposedChange:'Completar observación'}),...editable});
      await queueJobTx(tx,`social:${integrationMethod === 'browser' ? 'browser:' : ''}delivery:${deliveryId}`,{deliveryId,requestedBy:actor});
    }
    const order = (await tx.orders())[0];
    await insertRow(tx,'social_order_links',{order_id:order.id,campaign_id:ids.campaigns[0],actor_id:actor,reason:'Origen declarado por el administrador',data:'{}',...editable});
    await insertRow(tx,'social_expense_links',{expense_id:expense.id,campaign_id:ids.campaigns[0],actor_id:actor,reason:'Gasto completo declarado',data:'{}',...editable});
    await insertRow(tx,'social_oauth_states',{state_hash:hash('social-private-canary-state'),actor_id:actor,csrf_hash:hash('social-private-canary-csrf'),connection_id:ids.connections[0],expires_at:'2026-11-02T12:10:00.000Z',consumed_at:null});
    await insertRow(tx,'social_browser_controls',{id:randomUUID(),connection_id:ids.connections[1],actor_id:actor,session_binding:'social-private-canary-binding',lease_key:`social:browser-lock:${ids.connections[1]}`,lease_token:'social-private-canary-lease',state:'active',expires_at:'2026-11-02T12:10:00.000Z',last_seen_at:at,created_at:at,updated_at:at});
    await insertRow(tx,'business_requests',{scope:'social:oauth:start',request_id:'private-oauth-request',actor_id:actor,payload_hash:hash('oauth'),result_json:JSON.stringify({url:'https://example.test/?code=social-private-canary-code',accessToken:'social-private-canary-token'}),created_at:at});
    await insertRow(tx,'business_audit',{id:randomUUID(),entity_type:'social_connection',entity_id:ids.connections[0],actor_id:actor,recorded_at:at,data:JSON.stringify({action:'validate',accessToken:'social-private-canary-token',details:{cookies:['social-private-canary-cookie']}})});
  });
  return {bundle:await store.exportData(),ids};
}
