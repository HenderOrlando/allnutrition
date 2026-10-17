import assert from 'node:assert/strict';
import { createBusinessFixture,createBusinessBasics,settleBusinessFixture,payBusinessFixture,returnBusinessFixture,requestId,businessOrderInput,businessWorkbookRows,businessWorkbookProfile,BUSINESS_WORKBOOK_COLUMNS } from './business-fixtures.mjs';
import { accountBalance,saveAccount } from '../lib/business/cash.mjs';
import { financeOverview,financeQuery,reverseFinancialDocument } from '../lib/business/finance.mjs';
import { getSettlement } from '../lib/business/settlements.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch,uploadImportFile,getImportBatch,updateImportBatch,requestImportPreview,commitImport,processImportTurn } from '../lib/business/imports.mjs';
import { buildBusinessReport,generateReportSnapshot,getReportSnapshot,saveReportSnapshot,processReportTurn,listReportSnapshots,reportDetails } from '../lib/business/reports.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { buildDashboard } from '../lib/business/dashboard.mjs';
import { alertContracts } from './business-alert-contract.mjs';
import { businessJobsContracts } from './business-jobs-contract.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { getShipment } from '../lib/business/shipments.mjs';
import { businessInventoryContracts } from './business-inventory-contract.mjs';
async function drainImports(store){
  for(let i=0;i<50;i++){const turn=await processImportTurn(store,{maxGroups:25});if(!turn.hasMore)return;}
  throw new Error('El importador no agotó el trabajo sintético acotado.');
}
async function importFixtureWorkbook(store,fixture,bytes){
  let batch=await createImportBatch(store,{sourceId:fixture.source.id,requestId:requestId()},fixture.actorId);
  await uploadImportFile(store,batch.id,{filename:'pedidos-sinteticos.xlsx',bytes,version:batch.version,requestId:requestId()},fixture.actorId);
  await drainImports(store);batch=await getImportBatch(store,batch.id);
  assert.notEqual(batch.state,'failed',JSON.stringify(batch.error||batch.progress));
  await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:businessWorkbookProfile(),resolutions:[
    {action:'link_product',externalKey:'PRODUCT-A',internalId:fixture.a.id},
    {action:'link_product',externalKey:'GIFT-G',internalId:fixture.gift.id},
    {action:'link_person',externalKey:'SELLER-V',internalId:fixture.person.id}
  ]},fixture.actorId);
  batch=await getImportBatch(store,batch.id);await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},fixture.actorId);
  await drainImports(store);batch=await getImportBatch(store,batch.id);
  assert.ok(batch.preview?.previewHash,'La revisión debe ser aceptable antes de aplicar.');
  await commitImport(store,batch.id,{version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false,requestId:requestId()},fixture.actorId);
  await drainImports(store);batch=await getImportBatch(store,batch.id);
  assert.equal(batch.state,'completed',JSON.stringify(batch.preview?.summary||batch.progress));
  return batch;
}
export const businessContracts=[
  ['escenario comercial conserva caja, recaudo bruto, retenciones, sueldo y devolución',async store=>{
    const f=await createBusinessFixture(store);
    const initial=await store.order(f.orderId);
    assert.equal(initial.totalMinor,12200000);assert.equal(initial.paymentSummary.netCollectedMinor,12200000);
    assert.equal(initial.paymentSummary.platformHeldMinor,12200000);assert.equal(await accountBalance(store,f.account.id),10000000);
    const collections=await financeQuery(store,'settlements',{candidates:'collections',source:f.source.id});
    assert.equal(collections.total,1);assert.equal(collections.records[0].id,f.collectionId);
    assert.equal(collections.records[0].availableGrossMinor,12200000);
    const charges=await financeQuery(store,'settlements',{candidates:'expenses',source:f.source.id,collection:f.collectionId});
    assert.deepEqual(charges.records.map(row=>row.availableMinor).sort((a,b)=>a-b),[200000,1500000]);
    await settleBusinessFixture(store,f);
    const received=await store.order(f.orderId);
    assert.equal(received.paymentSummary.platformHeldMinor,0);assert.equal(received.paymentSummary.businessReceivedMinor,12200000);
    assert.equal(await accountBalance(store,f.account.id),20500000);
    const paid=await store.db.get(`SELECT SUM(amount_minor) AS n FROM ${store.t('expense_payments')} WHERE settlement_receipt_id=?`,[f.receipt.id]);
    assert.equal(Number(paid.n),1700000);
    await payBusinessFixture(store,f);assert.equal(await accountBalance(store,f.account.id),18950000);
    const salary=await store.db.get(`SELECT SUM(amount_minor) AS n FROM ${store.t('expenses')} WHERE category IN ('salary','commission','bonus')`);
    assert.equal(Number(salary.n),1550000);
    const septemberQuery={period:'month',anchorDate:`${f.year}-09-01`};
    const september=await buildBusinessReport(store,septemberQuery);
    for(const [key,expected] of Object.entries({netProductSales:11000000,shippingRevenue:1200000,costOfGoods:4600000,giftCost:600000,shippingCosts:1500000,platformFees:200000,commissions:550000,contribution:4750000,fixedSalary:1000000,operatingResult:3750000})) {
      assert.equal(september.metrics[key].value,expected,key);assert.equal(september.metrics[key].complete,true,key);
    }
    const savedSeptember=await generateReportSnapshot(store,septemberQuery,f.actorId);
    const before=await store.order(f.orderId),a=await store.get('products',f.a.id);
    await store.save('products',{...a,unitCostMinor:3000000,costEffectiveOn:`${f.year}-10-01`},a.id,a.version,f.actorId);
    assert.equal((await store.order(f.orderId)).items[0].unitCostMinor,2300000);
    const october=await store.saveOrder(businessOrderInput(a,{year:f.year,placedOn:`${f.year}-10-01`,shippingChargeMinor:0}),f.actorId);
    assert.equal(october.items[0].unitCostMinor,3000000);assert.equal(before.financialSummary.contributionMinor,4750000);
    assert.equal((await generateReportSnapshot(store,septemberQuery,f.actorId)).snapshot.id,savedSeptember.snapshot.id);
    assert.equal((await getReportSnapshot(store,savedSeptember.snapshot.id)).metrics.operatingResult.value,3750000);
    await returnBusinessFixture(store,f,{refund:true});assert.equal(await accountBalance(store,f.account.id),12750000);
    const after=await store.order(f.orderId),returned=after.returns.find(r=>r.kind==='return');
    assert.equal(returned.lines[0].salesCreditMinor,5500000);assert.equal(returned.lines[0].recoveredCostMinor,2300000);
    assert.equal(after.paymentSummary.netCollectedMinor,6700000);assert.equal(after.paymentSummary.refundDueMinor,0);
    const commission=await store.db.all(`SELECT * FROM ${store.t('commission_entries')} ORDER BY earned_on,id`);
    assert.equal(commission.reduce((sum,e)=>sum+Number(e.amount_minor),0),275000);
    assert.equal(commission.filter(e=>e.amount_minor<0)[0].earned_on,`${f.year}-10-02`);
    const overview=await financeOverview(store);assert.equal(overview.availableMinor,12750000);assert.equal(overview.platformPendingMinor,0);
    const octoberReport=await buildBusinessReport(store,{period:'month',anchorDate:`${f.year}-10-01`});
    assert.equal(octoberReport.metrics.contribution.value,-3625000);
    assert.equal((await buildBusinessReport(store,septemberQuery)).metrics.operatingResult.value,3750000);
    const explained=reportDetails(september,{metric:'operatingResult',pageSize:null}).records;
    assert.equal(explained.filter(row=>row.known).reduce((sum,row)=>sum+row.value,0),3750000);
    const dashboard=await buildDashboard(store,septemberQuery,{now:`${f.year}-10-16T17:00:00.000Z`});
    assert.equal(dashboard.metrics.operatingResult.value,3750000);
    assert.equal(dashboard.cash.availableMinor,12750000);
    assert.equal(dashboard.cash.asOf,`${f.year}-10-16`);
    assert.equal(dashboard.metrics.netProductSales.value,11000000);
    assert.equal(dashboard.automation.status,'never');
    assert.ok(dashboard.attention.records.some(task=>task.kind==='automation'));
  }],
  ['reversión de liquidación conserva historia y reabre las asignaciones sin duplicar dinero',async store=>{
    const f=await createBusinessFixture(store,{settle:true});
    await reverseFinancialDocument(store,{requestId:requestId(),documentType:'settlement_receipt',documentId:f.receipt.id,version:1,effectiveOn:`${f.year}-09-06`,reason:'Recepción sintética corregida'},f.actorId);
    assert.equal(await accountBalance(store,f.account.id),10000000);
    const settlement=await getSettlement(store,f.settlement.id);
    assert.equal(settlement.state,'pending');assert.equal(settlement.receipts.length,2);
    assert.equal((await store.order(f.orderId)).paymentSummary.platformHeldMinor,12200000);
    await assert.rejects(()=>reverseFinancialDocument(store,{requestId:requestId(),documentType:'settlement_receipt',documentId:f.receipt.id,version:1,effectiveOn:`${f.year}-09-06`,reason:'Duplicada'},f.actorId),{status:409});
    assert.equal(await accountBalance(store,f.account.id),10000000);
  }],
  ['Excel completo y filas reordenadas conservan una sola venta, recaudo y flete',async store=>{
    const fixture=await createBusinessBasics(store),rows=businessWorkbookRows(fixture.year);
    const workbook=values=>writeExcelSheets([{name:'Pedidos sintéticos',rows:[BUSINESS_WORKBOOK_COLUMNS.map(([title])=>title),...values.map(row=>BUSINESS_WORKBOOK_COLUMNS.map(([,field])=>row[field]??null))]}]);
    const bytes=workbook(rows);
    await importFixtureWorkbook(store,fixture,bytes);
    const initial=(await store.pageOrders()).records[0],order=await store.order(initial.id);
    assert.equal((await store.pageOrders()).total,1);assert.equal(order.totalMinor,12200000);assert.equal(order.items.length,2);
    assert.equal(order.paymentSummary.netCollectedMinor,12200000);assert.equal(order.paymentSummary.platformHeldMinor,12200000);
    assert.equal(await accountBalance(store,fixture.account.id),10000000);
    const expenses=await store.db.all(`SELECT category,amount_minor FROM ${store.t('expenses')} WHERE order_id=?`,[order.id]);
    assert.equal(expenses.filter(e=>e.category==='shipping_out').reduce((sum,e)=>sum+Number(e.amount_minor),0),1500000);
    const eventCount=Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('shipment_events')}`)).n);
    await importFixtureWorkbook(store,fixture,bytes);await importFixtureWorkbook(store,fixture,workbook(rows.toReversed()));
    const after=await store.order(order.id);
    assert.equal((await store.pageOrders()).total,1);assert.equal(after.totalMinor,12200000);assert.equal(after.items.length,2);
    assert.equal(after.paymentSummary.netCollectedMinor,12200000);assert.equal(after.shipments.length,1);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('shipment_events')}`)).n),eventCount);
    assert.equal(await accountBalance(store,fixture.account.id),10000000);
  }],
  ['cierres concurrentes conservan revisión previa y datos tardíos generan una sola revisión nueva',async store=>{
    const f=await createBusinessFixture(store,{settle:true,pay:true}),query={period:'month',anchorDate:`${f.year}-09-01`};
    const requests=await Promise.all([saveReportSnapshot(store,{...query,requestId:requestId()},f.actorId),saveReportSnapshot(store,{...query,requestId:requestId()},f.actorId)]);
    assert.equal(requests[0].jobKey,requests[1].jobKey);
    assert.equal((await processReportTurn(store,{maxReports:10})).processed,1);
    const initial=await listReportSnapshots(store,query);assert.equal(initial.total,1);assert.equal(initial.job.state,'succeeded');
    const first=await getReportSnapshot(store,initial.records[0].id);assert.equal(first.metrics.operatingResult.value,3750000);
    await recordExpense(store,{requestId:requestId(),category:'other',amountMinor:10000,incurredOn:`${f.year}-09-20`,concept:'Gasto tardío sintético'},f.actorId);
    assert.equal((await getReportSnapshot(store,first.snapshot.id)).snapshot.state,'stale');
    await saveReportSnapshot(store,{...query,requestId:requestId()},f.actorId);
    await processReportTurn(store,{maxReports:10});
    const revisions=await listReportSnapshots(store,query);assert.equal(revisions.total,2);
    const latest=await getReportSnapshot(store,revisions.records[0].id),original=await getReportSnapshot(store,first.snapshot.id);
    assert.equal(latest.snapshot.revision,2);assert.equal(latest.metrics.operatingResult.value,3740000);
    assert.equal(original.snapshot.state,'superseded');assert.equal(original.metrics.operatingResult.value,3750000);
    await saveReportSnapshot(store,{...query,requestId:requestId()},f.actorId);await processReportTurn(store,{maxReports:10});
    assert.equal((await listReportSnapshots(store,query)).total,2);
  }],
  ['consolidado suma importes legales sin aplicar el máximo de un documento al total',async store=>{
    const actor='aggregate-contract-admin',person=await saveResource(store,'people',{requestId:requestId(),name:'Responsable del consolidado'},actor);
    for(let i=0;i<2;i++)await saveAccount(store,{requestId:requestId(),name:`Banco grande ${i}`,type:'bank',openingOn:'2025-01-01',openingBalanceMinor:6000000000000,responsibleId:person.id},actor);
    assert.equal((await financeOverview(store)).availableMinor,12000000000000);
    const report=await buildBusinessReport(store,{period:'month',anchorDate:'2025-01-01',asOf:'2025-02-01T12:00:00.000Z'});
    assert.equal(report.metrics.cashAvailable.value,12000000000000);
    await assert.rejects(()=>saveAccount(store,{requestId:requestId(),name:'Importe fuera del límite',type:'bank',openingOn:'2025-01-01',openingBalanceMinor:10000000000001,responsibleId:person.id},actor),{status:400});
  }],
  ['seguimiento valida transportadora antes del commit y conserva guía huérfana sin venta ni dinero inventado',async store=>{
    const f=await createBusinessBasics(store),headers=['externalShipmentId','tracking','carrier','rawStatus'];
    const config={sheetName:'Tracking',headerRow:1,dateFormat:'ISO',purpose:'tracking',layout:'item_rows',reportAsOf:`${f.year}-09-05`,columns:headers.map((header,index)=>({index,header,destination:header})),statusMap:{Etiqueta:'label_created'}};
    async function inspect(carrier){
      let batch=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},f.actorId);
      await uploadImportFile(store,batch.id,{filename:'tracking.xlsx',bytes:writeExcelSheets([{name:'Tracking',rows:[headers,['SHIP-HUERFANA','000000007700',carrier,'Etiqueta']]}]),version:batch.version,requestId:requestId()},f.actorId);
      await drainImports(store);batch=await getImportBatch(store,batch.id);
      await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config},f.actorId);batch=await getImportBatch(store,batch.id);
      await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},f.actorId);await drainImports(store);
      return getImportBatch(store,batch.id);
    }
    const bad=await inspect('');assert.equal(bad.preview.summary.valid,0);assert.equal(bad.preview.summary.rejected,1);
    await assert.rejects(()=>commitImport(store,bad.id,{version:bad.version,previewHash:bad.preview.previewHash,includeValidOnly:false,requestId:requestId()},f.actorId));
    for(const table of ['shipments','import_revisions'])assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n),0,table);
    const good=await inspect('Transportadora sintética');assert.equal(good.preview.summary.valid,1);
    await commitImport(store,good.id,{version:good.version,previewHash:good.preview.previewHash,includeValidOnly:false,requestId:requestId()},f.actorId);await drainImports(store);
    assert.equal((await getImportBatch(store,good.id)).state,'completed');
    const row=await store.db.get(`SELECT id FROM ${store.t('shipments')}`),shipment=await getShipment(store,row.id);
    assert.equal(shipment.orderId,null);assert.equal(shipment.tracking,'000000007700');
    assert.equal(shipment.events[0].occurredOn,null);assert.equal(shipment.events[0].occurredAt,null);
    assert.equal(shipment.sourceCuts[f.source.id].value,`${f.year}-09-05`);assert.equal(shipment.sourceCuts[f.source.id].precision,'day');
    const repeated=await inspect('');assert.equal(repeated.preview.summary.valid,1);
    await commitImport(store,repeated.id,{version:repeated.version,previewHash:repeated.preview.previewHash,includeValidOnly:false,requestId:requestId()},f.actorId);await drainImports(store);
    for(const [table,expected] of [['orders',0],['order_collections',0],['shipments',1],['shipment_events',1],['cash_entries',1]])assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n),expected,table);
    assert.equal((await financeOverview(store)).availableMinor,10000000);
  }],
  ...alertContracts,
  ...businessJobsContracts,
  ...businessInventoryContracts,
];
export async function runBusinessContracts(t,factory){for(const [name,execute] of businessContracts)await t.test(name,async()=>{const store=await factory();try{await execute(store);}finally{await store.close();}});}
