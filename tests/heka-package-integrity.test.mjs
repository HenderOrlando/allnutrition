import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { createBusinessBasics, fixtureActor, requestId } from './business-fixtures.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';
import { normalizeHekaSnapshot, createHekaWorkbook } from '../lib/shipping/heka.mjs';
import { createImportBatch, uploadImportFile, updateImportBatch, requestImportPreview, getImportBatch, commitImport, processImportTurn, validateResolution } from '../lib/business/imports.mjs';
import { exportCommercialData, prepareCommercialBundle } from '../lib/business-backup.mjs';

const actor=fixtureActor;
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(fn){
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try{const basics=await createBusinessBasics(store,{year:2026});await fn(store,basics);}finally{await store.close();}
}
function snapshotWithSharedGuide(){
  const payload=hekaSnapshot(),first=payload.packages[0];
  const header={...first.header,fecha:{seconds:0,nanoseconds:999999999},guiasPagadas:['0000123'],total_pagado:'18.00',comision_heka:'0.50'};
  payload.packages.push({idPaquetePago:'fixture-package-02',header,headerAfter:structuredClone(header),lines:[{
    ...first.lines[0],documentId:'fixture-second-line',idPaquetePago:'fixture-package-02',
    RECAUDO:'20.00','ENVÍO TOTAL':'2.00','COMISION HEKA':'0.50','TOTAL A PAGAR':'18.00',
  }]});
  return normalizeHekaSnapshot(payload);
}
async function upload(store,basics){
  const snapshot=snapshotWithSharedGuide(),workbook=createHekaWorkbook(snapshot);
  let batch=await createImportBatch(store,{sourceId:basics.source.id,requestId:requestId()},actor);
  batch=await uploadImportFile(store,batch.id,{filename:'heka-synthetic.xlsx',version:batch.version,requestId:requestId(),bytes:workbook.bytes},actor);
  const shippingOrigin={format:'heka-import-v1',snapshotId:'fixture-snapshot',sourceHash:digest(JSON.stringify(snapshot)),adapterVersion:snapshot.adapterVersion,schemaVersion:1,sourceId:basics.source.id,capturedAt:snapshot.capturedAt,query:snapshot.query,accountFingerprint:digest(JSON.stringify(snapshot.account)),fileHash:batch.fileHash,...workbook.manifest};
  await store.transaction(async tx=>{
    await tx.lockWrites();
    const row=await tx.db.get(`SELECT data FROM ${tx.t('import_batches')} WHERE id=?`,[batch.id]);
    await tx.db.run(`UPDATE ${tx.t('import_batches')} SET data=? WHERE id=?`,[JSON.stringify({...JSON.parse(row.data),shippingOrigin}),batch.id]);
  });
  await processImportTurn(store,{batchId:batch.id,expectedPhase:'inspect'});
  batch=await getImportBatch(store,batch.id);
  return updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:workbook.config},actor);
}
async function preview(store,batch){
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  await processImportTurn(store,{batchId:batch.id});
  const result=await getImportBatch(store,batch.id);
  assert.ok(result.preview,result.error?.message);
  return result;
}
const commit=(store,batch)=>commitImport(store,batch.id,{version:batch.version,requestId:requestId(),previewHash:batch.preview.previewHash,includeValidOnly:true},actor);
const update=(store,batch,changes)=>updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),...changes},actor);
const job=async(store,id)=>store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`,[`import:${id}`]);

test('Heka package exclusion is strictly whole-package and supports removal',()=>{
  assert.deepEqual(validateResolution({action:'omit_settlement_package',externalKey:' package ',value:true}),{action:'omit_settlement_package',externalKey:'package',value:true});
  assert.deepEqual(validateResolution({action:'omit_settlement_package',externalKey:'package',remove:true}),{action:'omit_settlement_package',externalKey:'package',remove:true});
  for(const scope of [{sheet:'settlements'},{rowNumber:2},{entityKey:'group'},{internalId:'target'}])assert.throws(()=>validateResolution({action:'omit_settlement_package',externalKey:'package',value:true,...scope}));
  assert.throws(()=>validateResolution({action:'omit_settlement_package',externalKey:'package',value:false}));
});

for(const path of ['duplicate','omit_group','disabled_sheet','package_remap','date_correction','gross_correction','net_correction']){
  test(`Heka cannot accept an incomplete package through ${path} or includeValidOnly`,()=>fixture(async(store,basics)=>{
    let batch=await upload(store,basics),changes={};
    if(path==='duplicate')changes.resolutions=[{action:'duplicate',sheet:'settlements',rowNumber:2}];
    if(path==='omit_group'){
      batch=await preview(store,batch);
      const group=batch.preview.groups.find(group=>group.rowRefs.some(ref=>ref.sheet==='settlements'&&ref.rowNumber===4));
      changes.resolutions=[{action:'omit_group',entityKey:group.key}];
    }
    if(path==='disabled_sheet')changes.config={...batch.config,sheets:batch.config.sheets.map(sheet=>sheet.sheetName==='settlements'?{...sheet,enabled:false}:sheet)};
    if(path==='package_remap')changes.config={...batch.config,sheets:batch.config.sheets.map(sheet=>sheet.sheetName==='settlements'?{...sheet,columns:sheet.columns.map(column=>column.destination==='settlementExternalId'?{...column,destination:'ignore'}:column)}:sheet)};
    const corrected={date_correction:['settlementDate','2026-11-07'],gross_correction:['settlementGross','0.01'],net_correction:['settlementNet','0.00']}[path];
    if(corrected){const column=batch.config.sheets.find(sheet=>sheet.sheetName==='settlements').columns.find(column=>column.destination===corrected[0]);changes.resolutions=[{action:'cell_value',sheet:'settlements',rowNumber:2,columnIndex:column.index,value:corrected[1],reason:'Synthetic integrity regression'}];}
    batch=await preview(store,await update(store,batch,changes));
    assert.ok(batch.preview.groups.some(group=>group.errors.some(error=>error.code==='IMPORT_HEKA_PACKAGE_INCOMPLETE')));
    await assert.rejects(()=>commit(store,batch),{status:409});
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('settlements')}`)).n),0);
  }));
}

test('manual batches cannot acquire a Heka whole-package resolution',()=>fixture(async(store,basics)=>{
  const batch=await createImportBatch(store,{sourceId:basics.source.id,requestId:requestId()},actor);
  await assert.rejects(()=>update(store,batch,{resolutions:[{action:'omit_settlement_package',externalKey:'fixture-package-01',value:true}]}),{status:400});
}));

test('excluding one whole package preserves tracking and another package sharing its guide, plus immutable backup origin',()=>fixture(async(store,basics)=>{
  let batch=await preview(store,await upload(store,basics));
  const origin=structuredClone(batch.shippingOrigin),firstHash=batch.preview.previewHash;
  assert.deepEqual(origin.trackingRows[0].updatedTimestampObserved,{seconds:1794157200,nanoseconds:987654321});
  assert.deepEqual(origin.packages.map(value=>value.settlementDate),['2026-11-08','2026-11-08'],'informational header date cannot move either complete package');
  assert.deepEqual(origin.packages[1].headerTimestampObserved,{seconds:0,nanoseconds:999999999});
  assert.ok(origin.packages.flatMap(value=>value.rows).every(row=>row.paymentDateObserved==='2026-11-08'&&!Object.hasOwn(row,'paidAt')));
  batch=await update(store,batch,{resolutions:[{action:'omit_settlement_package',externalKey:'fixture-package-01',value:true}]});
  batch=await preview(store,batch);
  assert.notEqual(batch.preview.previewHash,firstHash);
  assert.equal(batch.preview.summary.rejected,0);
  assert.deepEqual(batch.shippingOrigin,origin);
  const rows=(await getImportBatch(store,batch.id,{page:1})).rows.records;
  assert.equal(rows.find(row=>row.sheet==='tracking'&&row.rowNumber===2).state==='skipped',false);
  for(const rowNumber of [2,3,4])assert.equal(rows.find(row=>row.sheet==='settlements'&&row.rowNumber===rowNumber).state,'skipped');
  assert.notEqual(rows.find(row=>row.sheet==='settlements'&&row.rowNumber===5).state,'skipped');
  const counts={};for(const table of ['cash_entries','order_collections','expenses','settlement_receipts'])counts[table]=Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);
  await commit(store,batch);
  const frozen=JSON.parse((await store.db.get(`SELECT data FROM ${store.t('import_revisions')} WHERE batch_id=?`,[batch.id])).data);
  assert.deepEqual(frozen.shippingOrigin,origin);
  assert.deepEqual(frozen.settlements.map(value=>value.key),['fixture-package-02']);
  await processImportTurn(store,{batchId:batch.id});
  const settlements=await store.db.all(`SELECT data FROM ${store.t('settlements')}`);
  assert.equal(settlements.length,1);
  assert.equal(JSON.parse(settlements[0].data).reconciliationRequired,true);
  for(const [table,before] of Object.entries(counts))assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n),before,table);
  const bundle=await store.readSnapshot(exportCommercialData);
  await prepareCommercialBundle(bundle);
  assert.deepEqual(JSON.parse(bundle.business.import_batches.find(row=>row.id===batch.id).data).shippingOrigin,origin);
  const broken=structuredClone(bundle),accepted=broken.business.import_revisions.find(row=>row.batch_id===batch.id),data=JSON.parse(accepted.data);
  data.shippingOrigin.sourceHash='a'.repeat(64);accepted.data=JSON.stringify(data);
  await assert.rejects(()=>prepareCommercialBundle(broken));
  for(const mutate of [
    value=>{value.trackingRows[0].updatedTimestampObserved.nanoseconds-=1;},
    value=>{value.packages[1].headerTimestampObserved.nanoseconds-=1;},
  ]){
    const changed=structuredClone(bundle),revision=changed.business.import_revisions.find(row=>row.batch_id===batch.id),frozenData=JSON.parse(revision.data);
    mutate(frozenData.shippingOrigin);revision.data=JSON.stringify(frozenData);
    await assert.rejects(()=>prepareCommercialBundle(changed),'submillisecond original evidence must agree between batch and frozen revision');
  }
}));

test('removing whole-package exclusion restores every original row',()=>fixture(async(store,basics)=>{
  let batch=await upload(store,basics);
  batch=await update(store,batch,{resolutions:[{action:'omit_settlement_package',externalKey:'fixture-package-01',value:true}]});
  batch=await preview(store,batch);
  batch=await update(store,batch,{resolutions:[{action:'omit_settlement_package',externalKey:'fixture-package-01',remove:true}]});
  batch=await preview(store,batch);
  assert.equal(batch.resolutions.some(value=>value.action==='omit_settlement_package'),false);
  assert.equal(batch.rows.records.some(row=>row.state==='skipped'),false);
  const accepted=await commit(store,batch);assert.equal(accepted.accepted,true);
}));

test('inspect guard leaves preview/apply leases unclaimed and rejects other guard phases',()=>fixture(async(store,basics)=>{
  let batch=await upload(store,basics);
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  const before=await job(store,batch.id);
  assert.deepEqual(await processImportTurn(store,{batchId:batch.id,expectedPhase:'inspect'}),{processed:0,hasMore:false,batchId:batch.id,state:null});
  assert.deepEqual(await job(store,batch.id),before);
  await assert.rejects(()=>processImportTurn(store,{batchId:batch.id,expectedPhase:'preview'}),{status:400});
  await assert.rejects(()=>processImportTurn(store,{expectedPhase:'inspect'}),{status:400});
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);await commit(store,batch);
  const accepted=await job(store,batch.id);
  await processImportTurn(store,{batchId:batch.id,expectedPhase:'inspect'});
  assert.deepEqual(await job(store,batch.id),accepted);
}));

test('inspect guard checks the current phase only after acquiring the write lock',async()=>{
  let locked=false,claims=0;
  const tx={lockWrites:async()=>{locked=true;},t:name=>name,db:{get:async sql=>{
    assert.equal(locked,true);
    if(sql.includes('job_runs'))return {data:JSON.stringify({phase:'apply'})};
    return {state:'queued',data:JSON.stringify({acceptedRevision:1})};
  },run:async()=>{claims++;}}};
  const store={transaction:async fn=>fn(tx)};
  assert.deepEqual(await processImportTurn(store,{batchId:'fixture-raced-batch',expectedPhase:'inspect'}),{processed:0,hasMore:false,batchId:'fixture-raced-batch',state:null});
  assert.equal(claims,0);
});
