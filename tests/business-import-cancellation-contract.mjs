import assert from 'node:assert/strict';
import { BUSINESS_WORKBOOK_COLUMNS, businessWorkbookProfile, businessWorkbookRows, createBusinessBasics, fixtureActor as actor, requestId } from './business-fixtures.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { saveSettlement } from '../lib/business/settlements.mjs';
import { createImportBatch, uploadImportFile, updateImportBatch, requestImportPreview, getImportBatch, listImportBatches, commitImport, cancelImportBatch, processImportTurn, downloadImportOriginal } from '../lib/business/imports.mjs';
import { importData } from '../lib/import.mjs';
import { COMMERCIAL_TABLES } from '../lib/backup-schema.mjs';

function sourceRows(count=3,{statement=false,missing=false}={}) {
  return Array.from({length:count},(_,index)=>({...businessWorkbookRows(2025)[0],externalOrderId:`CANCEL-${index}`,tracking:`000CANCEL${index}`,externalLineId:`CANCEL-LINE-${index}`,sellerExternalKey:'',quantity:1,collectedAmount:'67.000',collectionExternalId:`CANCEL-COL-${index}`,productExternalKey:missing&&index>0?'MISSING':'PRODUCT-A',settlementExternalId:statement?'CANCEL-STATEMENT':'',settlementDate:statement?'2025-09-05':'',settlementGross:statement?'67.000':'',settlementNet:statement?String(count*50000):'',settlementReference:''}));
}
const bytesFor=rows=>writeExcelSheets([{name:'Pedidos sintéticos',rows:[BUSINESS_WORKBOOK_COLUMNS.map(([header])=>header),...rows.map(row=>BUSINESS_WORKBOOK_COLUMNS.map(([,field])=>row[field]??''))]}]);
const count=async(store,table)=>Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);
const cancel=(store,batch,input={})=>cancelImportBatch(store,batch.id,{requestId:requestId(),...input},actor);
async function uploaded(store,f,rows=sourceRows()) {
  const batch=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},actor);
  return uploadImportFile(store,batch.id,{version:batch.version,filename:'cancelacion-sintetica.xlsx',bytes:bytesFor(rows),requestId:requestId()},actor);
}
async function reviewed(store,f,rows=sourceRows()) {
  let batch=await uploaded(store,f,rows);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:businessWorkbookProfile(),resolutions:[{action:'link_product',externalKey:'PRODUCT-A',internalId:f.a.id}]},actor);
  return preview(store,batch);
}
async function preview(store,batch) {
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  await processImportTurn(store,{batchId:batch.id});return getImportBatch(store,batch.id);
}
async function accepted(store,batch,includeValidOnly=false) {
  return commitImport(store,batch.id,{version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly,requestId:requestId()},actor);
}
const workflow=new Set(['import_batches','import_rows','import_revisions','business_requests','business_audit']);
async function facts(store) {
  const result={};
  for(const table of ['records','orders','counters',...Object.keys(COMMERCIAL_TABLES).filter(table=>!workflow.has(table))]) {
    result[table]=JSON.parse(JSON.stringify(await store.db.all(`SELECT * FROM ${store.t(table)}`))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
// Pause only after a real transaction/snapshot has released its database lock.
function holdAfter(store,method,predicate) {
  const original=store[method].bind(store),entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;
  store[method]=async(...args)=>{const value=await original(...args);if(!held&&predicate(value)){held=true;entered.resolve(value);await release.promise;}return value;};
  return {entered:entered.promise,release:()=>release.resolve(),restore:()=>{store[method]=original;}};
}
async function waitForHold(gate,work) {
  await Promise.race([gate.entered,work.then(()=>{throw new Error('El trabajo terminó sin alcanzar la pausa real.');})]);
}

export async function runImportCancellationContracts(t,factory) {
  const fixture=async fn=>{const store=await factory();try{return await fn(store,await createBusinessBasics(store,{year:2025,reportsStartOn:'2025-09-01'}));}finally{await store.close();}};
  await t.test('descarta un borrador idempotentemente sin cambiar hechos ni admitir más mutaciones',()=>fixture(async(store,f)=>{
    const batch=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},actor),before=await facts(store),input={requestId:requestId()};
    const stopped=await cancel(store,batch,input);
    assert.equal(stopped.state,'cancelled');assert.equal(stopped.canCancel,false);assert.equal(stopped.progress.processed,0);
    assert.deepEqual(await facts(store),before);
    const audits=await count(store,'business_audit');
    assert.equal((await cancel(store,batch,input)).version,stopped.version);
    assert.equal((await cancel(store,batch)).version,stopped.version);assert.equal(await count(store,'business_audit'),audits);
    for(const mutate of [
      ()=>uploadImportFile(store,batch.id,{version:stopped.version,filename:'otro.xlsx',bytes:bytesFor(sourceRows()),requestId:requestId()},actor),
      ()=>updateImportBatch(store,batch.id,{version:stopped.version,config:businessWorkbookProfile(),requestId:requestId()},actor),
      ()=>requestImportPreview(store,batch.id,{version:stopped.version,requestId:requestId()},actor),
      ()=>commitImport(store,batch.id,{version:stopped.version,previewHash:'viejo',requestId:requestId()},actor)
    ])await assert.rejects(mutate,{status:409});
    assert.equal((await processImportTurn(store,{batchId:batch.id})).processed,0);
    assert.equal((await listImportBatches(store,{state:'cancelled'})).records[0].id,batch.id);
  }));
  await t.test('descarta el original en cola y revoca también una inspección ya ejecutándose',()=>fixture(async(store,f)=>{
    const queued=await uploaded(store,f);await cancel(store,queued);
    assert.equal((await processImportTurn(store,{batchId:queued.id})).processed,0);
    await assert.rejects(()=>downloadImportOriginal(store,queued.id),{status:404});
    const batch=await uploaded(store,f),gate=holdAfter(store.db,'get',value=>value===null),work=processImportTurn(store,{batchId:batch.id});
    try{
      await waitForHold(gate,work);await cancel(store,batch);gate.release();
      assert.equal((await work).state,'cancelled');
      const stopped=await getImportBatch(store,batch.id);assert.equal(stopped.state,'cancelled');assert.equal(stopped.workbook,null);assert.equal(stopped.error,null);
      assert.equal(await count(store,'job_runs'),0);assert.equal(await count(store,'orders'),0);
    }finally{gate.release();await work;gate.restore();}
  }));
  await t.test('cancelar durante la preparación no publica una revisión ni resucita el trabajo',()=>fixture(async(store,f)=>{
    let batch=await reviewed(store,f);batch=await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
    const gate=holdAfter(store,'readSnapshot',value=>value instanceof Set),work=processImportTurn(store,{batchId:batch.id});
    try{
      await waitForHold(gate,work);const stopped=await cancel(store,batch);gate.release();
      assert.equal(stopped.state,'cancelled');assert.equal((await work).state,'cancelled');
      const final=await getImportBatch(store,batch.id);assert.equal(final.preview,null);assert.equal(final.error,null);assert.equal(final.canCancel,false);
      assert.equal(await count(store,'orders'),0);assert.equal(await count(store,'job_runs'),0);
    }finally{gate.release();await work;gate.restore();}
  }));
  await t.test('cancela una revisión aceptada en cola sin aplicar pedidos',()=>fixture(async(store,f)=>{
    const batch=await accepted(store,await reviewed(store,f)),stopped=await cancel(store,batch,{version:1});
    assert.equal(stopped.cancellation.appliedGroups,0);assert.equal(stopped.cancellation.remainingGroups,3);
    assert.equal(stopped.acceptedRevision,1);assert.equal(await count(store,'import_revisions'),1);
    assert.equal((await processImportTurn(store,{batchId:batch.id})).processed,0);assert.equal(await count(store,'orders'),0);
  }));
  await t.test('cancelación parcial conserva dinero, stock y evidencia, y otro lote continúa sin duplicarlos',()=>fixture(async(store,f)=>{
    let batch=await accepted(store,await reviewed(store,f));await processImportTurn(store,{batchId:batch.id,maxGroups:1});
    const before=await facts(store),original=await getImportBatch(store,batch.id),stopped=await cancel(store,batch,{version:1});
    assert.equal(stopped.cancellation.appliedGroups,1);assert.equal(stopped.cancellation.remainingGroups,2);assert.equal(stopped.progress.processed,1);
    assert.equal(stopped.fileHash,original.fileHash);assert.equal(stopped.fileDiscarded,true);assert.equal(stopped.rows.total,3);
    assert.equal((await store.db.get(`SELECT file_bytes_base64 FROM ${store.t('import_batches')} WHERE id=?`,[batch.id])).file_bytes_base64,null);
    await assert.rejects(()=>downloadImportOriginal(store,batch.id),{status:404});
    await processImportTurn(store,{batchId:batch.id});assert.deepEqual(await facts(store),before);
    assert.equal(await count(store,'orders'),1);assert.equal(await count(store,'order_collections'),1);assert.equal((await store.get('products',f.a.id)).stockQuantity,9999);
    batch=await accepted(store,await reviewed(store,f));await processImportTurn(store,{batchId:batch.id});
    assert.equal(await count(store,'orders'),3);assert.equal(await count(store,'order_collections'),3);assert.equal((await store.get('products',f.a.id)).stockQuantity,9997);
    assert.equal((await getImportBatch(store,stopped.id)).state,'cancelled');
  }));
  await t.test('cancela con un grupo confirmado y progreso aún antiguo sin que el worker aplique el siguiente',()=>fixture(async(store,f)=>{
    const batch=await accepted(store,await reviewed(store,f)),gate=holdAfter(store,'transaction',value=>value?.units?.some(unit=>unit.orderId)),work=processImportTurn(store,{batchId:batch.id});
    try{
      await waitForHold(gate,work);assert.equal((await getImportBatch(store,batch.id)).progress.processed,0);
      const stopped=await cancel(store,batch),before=await facts(store);assert.equal(stopped.cancellation.appliedGroups,1);assert.equal(stopped.progress.processed,1);
      gate.release();assert.equal((await work).state,'cancelled');assert.deepEqual(await facts(store),before);
      assert.equal(await count(store,'orders'),1);assert.equal(await count(store,'job_runs'),0);
    }finally{gate.release();await work;gate.restore();}
  }));
  await t.test('la última operación confirmada gana la carrera aunque todavía diga applying',()=>fixture(async(store,f)=>{
    const batch=await accepted(store,await reviewed(store,f,sourceRows(1))),gate=holdAfter(store,'transaction',value=>value?.units?.some(unit=>unit.orderId)),work=processImportTurn(store,{batchId:batch.id});
    try{
      await waitForHold(gate,work);assert.equal((await getImportBatch(store,batch.id)).state,'applying');
      const originalBytes=(await downloadImportOriginal(store,batch.id)).bytes;
      await assert.rejects(()=>cancel(store,batch,{version:1}),{status:409});
      assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,originalBytes);
      gate.release();assert.equal((await work).state,'completed');assert.equal((await getImportBatch(store,batch.id)).canCancel,false);
    }finally{gate.release();await work;gate.restore();}
  }));
  await t.test('detiene declaraciones pendientes sin deshacer los pedidos y recaudos ya confirmados',()=>fixture(async(store,f)=>{
    const batch=await accepted(store,await reviewed(store,f,sourceRows(2,{statement:true})));
    await processImportTurn(store,{batchId:batch.id,maxGroups:2});assert.equal(await count(store,'settlements'),0);
    const before=await facts(store),stopped=await cancel(store,batch);
    assert.equal(stopped.cancellation.appliedGroups,2);assert.equal(stopped.cancellation.remainingGroups,0);assert.equal(stopped.cancellation.remainingSettlements,1);
    await processImportTurn(store,{batchId:batch.id});assert.deepEqual(await facts(store),before);assert.equal(await count(store,'order_collections'),2);
  }));
  await t.test('cancelar conserva las excepciones previas y detiene las declaraciones restantes',()=>fixture(async(store,f)=>{
    const rows=sourceRows(2,{statement:true}).map((row,index)=>({...row,settlementExternalId:`CANCEL-DOCUMENT-${index}`,settlementNet:'50.000'}));
    let batch=await accepted(store,await reviewed(store,f,rows));await processImportTurn(store,{batchId:batch.id,maxGroups:2});
    for(let index=0;index<2;index++){
      const link=await store.db.get(`SELECT internal_id FROM ${store.t('external_links')} WHERE source_id=? AND entity_type='order' AND external_key=?`,[f.source.id,`CANCEL-${index}`]),order=await store.order(link.internal_id);
      await saveSettlement(store,{requestId:requestId(),sourceId:f.source.id,externalKey:`CANCEL-DOCUMENT-${index}`,reportedOn:'2025-09-05',netMinor:5000000,lines:[{collectionId:order.collections[0].id,grossMinor:6700000,deductions:order.expenses.map(expense=>({expenseId:expense.id,amountMinor:expense.amountMinor}))}]},actor);
    }
    await processImportTurn(store,{batchId:batch.id,maxGroups:1});batch=await getImportBatch(store,batch.id);
    assert.equal(batch.state,'queued');assert.equal(batch.progress.settlementIssues.length,1);
    const before=await facts(store),stopped=await cancel(store,batch);
    assert.deepEqual(stopped.progress.settlementIssues,batch.progress.settlementIssues);assert.equal(stopped.progress.errors,1);
    assert.equal(stopped.cancellation.remainingSettlements,1);assert.equal(stopped.canCancel,false);
    await processImportTurn(store,{batchId:batch.id});assert.deepEqual(await facts(store),before);
  }));
  await t.test('una importación terminada no se cancela ni al revisar y aplicar después sus excepciones',()=>fixture(async(store,f)=>{
    let batch=await accepted(store,await reviewed(store,f,sourceRows(3,{missing:true})),true);await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
    assert.equal(batch.state,'completed_with_errors');assert.equal(batch.canCancel,false);const completedAt=batch.completedAt,originalBytes=(await downloadImportOriginal(store,batch.id)).bytes;
    await assert.rejects(()=>cancel(store,batch,{version:1}),{status:409});
    batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'link_product',externalKey:'MISSING',internalId:f.a.id}]},actor);
    batch=await preview(store,batch);assert.equal(batch.canCancel,false);await assert.rejects(()=>cancel(store,batch),{status:409});
    batch=await accepted(store,batch);await processImportTurn(store,{batchId:batch.id,maxGroups:1});batch=await getImportBatch(store,batch.id);
    assert.equal(batch.state,'queued');assert.equal(batch.completedAt,completedAt);assert.equal(batch.canCancel,false);await assert.rejects(()=>cancel(store,batch),{status:409});
    await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);assert.equal(batch.state,'completed');
    const before=await facts(store);await assert.rejects(()=>cancel(store,batch,{version:1}),{status:409});assert.deepEqual(await facts(store),before);
    assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,originalBytes);
  }));
  await t.test('respaldo y restauración conservan cancelación parcial sin reanudar ni perder hechos',async()=>{
    const scenario=await fixture(async(store,f)=>{
      const batch=await accepted(store,await reviewed(store,f));await processImportTurn(store,{batchId:batch.id,maxGroups:1});await cancel(store,batch);
      return {id:batch.id,bundle:await store.exportData()};
    });
    assert.equal(scenario.bundle.pendingJobs.length,0);
    const target=await factory();try{
      const invalid=structuredClone(scenario.bundle),revision=JSON.parse(invalid.business.import_revisions[0].data);
      revision.groups[0].targets.find(target=>target.table==='records').version='invalid-catalog-fingerprint';
      invalid.business.import_revisions[0].data=JSON.stringify(revision);
      await assert.rejects(()=>importData(target,invalid),{status:400});assert.equal(await count(target,'orders'),0);
      await importData(target,scenario.bundle);
      const restored=await getImportBatch(target,scenario.id);assert.equal(restored.state,'cancelled');assert.equal(restored.canCancel,false);assert.equal(restored.cancellation.appliedGroups,1);assert.equal(restored.rows.total,3);
      await processImportTurn(target,{batchId:restored.id});assert.equal(await count(target,'orders'),1);assert.equal(await count(target,'order_collections'),1);assert.equal(await count(target,'job_runs'),0);
      await assert.rejects(()=>downloadImportOriginal(target,restored.id),{status:404});
    }finally{await target.close();}
  });
}
