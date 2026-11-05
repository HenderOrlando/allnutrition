import assert from 'node:assert/strict';
import { createBusinessFixture,createBusinessBasics,settleBusinessFixture,payBusinessFixture,returnBusinessFixture,requestId,businessOrderInput,businessWorkbookRows,businessWorkbookProfile,BUSINESS_WORKBOOK_COLUMNS } from './business-fixtures.mjs';
import { accountBalance,saveAccount } from '../lib/business/cash.mjs';
import { financeOverview,financeQuery,reverseFinancialDocument } from '../lib/business/finance.mjs';
import { getSettlement,confirmSettlement } from '../lib/business/settlements.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch,uploadImportFile,getImportBatch,updateImportBatch,requestImportPreview,commitImport,processImportTurn } from '../lib/business/imports.mjs';
import { buildBusinessReport,generateReportSnapshot,getReportSnapshot,saveReportSnapshot,processReportTurn,listReportSnapshots,reportDetails } from '../lib/business/reports.mjs';
import { recordExpense,payExpense } from '../lib/business/expenses.mjs';
import { buildDashboard } from '../lib/business/dashboard.mjs';
import { alertContracts } from './business-alert-contract.mjs';
import { businessJobsContracts } from './business-jobs-contract.mjs';
import { saveResource,getBusinessSettings,saveBusinessSettings } from '../lib/business/settings.mjs';
import { createShipment,getShipment } from '../lib/business/shipments.mjs';
import { businessInventoryContracts } from './business-inventory-contract.mjs';
import { confirmPayroll } from '../lib/business/payroll.mjs';
async function drainImports(store){
  for(let i=0;i<50;i++){const turn=await processImportTurn(store,{maxGroups:25});if(!turn.hasMore)return;}
  throw new Error('El importador no agotó el trabajo sintético acotado.');
}
async function importFixtureWorkbook(store,fixture,bytes,{config=businessWorkbookProfile(),resolutions=[]}={}){
  let batch=await createImportBatch(store,{sourceId:fixture.source.id,requestId:requestId()},fixture.actorId);
  await uploadImportFile(store,batch.id,{filename:'pedidos-sinteticos.xlsx',bytes,version:batch.version,requestId:requestId()},fixture.actorId);
  await drainImports(store);batch=await getImportBatch(store,batch.id);
  assert.notEqual(batch.state,'failed',JSON.stringify(batch.error||batch.progress));
  await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config,resolutions:[
    {action:'link_product',externalKey:'PRODUCT-A',internalId:fixture.a.id},
    {action:'link_product',externalKey:'GIFT-G',internalId:fixture.gift.id},
    {action:'link_person',externalKey:'SELLER-V',internalId:fixture.person.id},
    ...resolutions
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
  ['seguro opcional conserva identidad, contribución y transporte sin pagar hasta una acción explícita',async store=>{
    const f=await createBusinessFixture(store,{year:2025,reportsStartOn:'2025-09-01'});
    const query={period:'month',anchorDate:'2025-09-01',asOf:'2025-10-01T05:00:00.000Z'};
    const before=await buildBusinessReport(store,query),orderBefore=await store.order(f.orderId);
    const balanceBefore=await accountBalance(store,f.account.id);
    const cashBefore=Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')}`)).n);
    const paymentsBefore=Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expense_payments')}`)).n);
    const input={category:'shipping_insurance',shipmentId:f.shipmentId,amountMinor:100000,incurredOn:'2025-09-02',source:'insurance-contract',sourceId:f.source.id,sourceAsOf:'2025-09-05T05:00:00.000Z',concept:'Prima sintética'};
    const expense=await recordExpense(store,{...input,requestId:requestId()},f.actorId);
    assert.equal(expense.amountMinor,100000);assert.equal(expense.incurredOn,'2025-09-02');
    assert.equal(expense.chargeOn,'2025-09-02');assert.equal(expense.dateSource,'charge_date');
    assert.equal(expense.sourceKey,`${f.shipmentId}:shipping_insurance`);
    assert.equal(expense.orderId,f.orderId);assert.equal(expense.outstandingMinor,100000);assert.equal(expense.paidMinor,0);
    const repeated=await recordExpense(store,{...input,requestId:requestId()},f.actorId);
    assert.equal(repeated.id,expense.id);assert.equal(repeated.version,expense.version);
    const rows=await store.db.all(`SELECT id,amount_minor,source_key FROM ${store.t('expenses')} WHERE shipment_id=? AND category=?`,[f.shipmentId,'shipping_insurance']);
    assert.equal(rows.length,1);assert.equal(rows[0].id,expense.id);assert.equal(Number(rows[0].amount_minor),100000);
    assert.equal(rows[0].source_key,`${f.shipmentId}:shipping_insurance`);
    const after=await buildBusinessReport(store,query),orderAfter=await store.order(f.orderId);
    assert.equal(after.metrics.shippingCosts.value,before.metrics.shippingCosts.value+100000);
    assert.equal(after.metrics.shippingCosts.complete,true);
    assert.equal(after.metrics.contribution.value,before.metrics.contribution.value-100000);
    assert.equal(after.metrics.operatingResult.knownValue,before.metrics.operatingResult.knownValue-100000);
    assert.equal(orderAfter.financialSummary.contributionMinor,orderBefore.financialSummary.contributionMinor-100000);
    assert.deepEqual(orderAfter.paymentSummary,orderBefore.paymentSummary);
    const details=reportDetails(after,{metric:'shippingCosts',pageSize:null}).records.filter(row=>row.expenseId===expense.id);
    assert.equal(details.length,1);assert.equal(details[0].value,100000);assert.equal(details[0].occurredOn,'2025-09-02');
    assert.equal(await accountBalance(store,f.account.id),balanceBefore);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')}`)).n),cashBefore);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expense_payments')}`)).n),paymentsBefore);
    const paid=await payExpense(store,{requestId:requestId(),expenseId:expense.id,version:expense.version,amountMinor:100000,accountId:f.account.id,effectiveOn:'2025-10-02'},f.actorId);
    assert.equal(paid.expense.id,expense.id);assert.equal(paid.expense.paidMinor,100000);assert.equal(paid.expense.outstandingMinor,0);
    assert.equal(await accountBalance(store,f.account.id),balanceBefore-100000);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expense_payments')} WHERE expense_id=?`,[expense.id])).n),1);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')} WHERE shipment_id=? AND category=?`,[f.shipmentId,'shipping_insurance'])).n),1);
    const afterPayment=await buildBusinessReport(store,query);
    assert.equal(afterPayment.metrics.shippingCosts.value,after.metrics.shippingCosts.value);
    assert.equal(afterPayment.metrics.contribution.value,after.metrics.contribution.value);
  }],
  ['seguro distingue ausencia, observación desconocida, cero y cargo sin fecha sin inventar gastos',async store=>{
    const f=await createBusinessFixture(store,{year:2025,reportsStartOn:'2025-09-01'});
    const query={period:'month',anchorDate:'2025-09-01',asOf:'2025-10-01T05:00:00.000Z'};
    const before=await buildBusinessReport(store,query),initial=await getShipment(store,f.shipmentId);
    assert.equal(Object.hasOwn(initial.costStatuses,'shipping_insurance'),false);
    assert.equal(Object.hasOwn(initial.costObservations,'shipping_insurance'),false);
    assert.equal(initial.costStatus,'known');assert.equal(before.metrics.shippingCosts.complete,true);
    const base={category:'shipping_insurance',shipmentId:f.shipmentId};
    const unknown=await recordExpense(store,{...base,requestId:requestId(),amountMinor:null,incurredOn:null},f.actorId);
    assert.equal(unknown.id,null);assert.equal(unknown.amountMinor,null);
    const observed=await getShipment(store,f.shipmentId);
    assert.equal(observed.costStatuses.shipping_insurance,'unknown');
    assert.equal(observed.costObservations.shipping_insurance.amountMinor,null);
    assert.equal(observed.costStatus,'unknown');
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')} WHERE category=?`,['shipping_insurance'])).n),0);
    const unknownReport=await buildBusinessReport(store,query);
    assert.equal(unknownReport.metrics.shippingCosts.complete,false);
    assert.equal(unknownReport.metrics.shippingCosts.knownValue,before.metrics.shippingCosts.value);
    assert.ok(reportDetails(unknownReport,{metric:'shippingCosts',pageSize:null}).records.some(row=>row.category==='shipping_insurance'&&row.reason==='shipment_cost_unknown'&&!row.known));
    const zero=await recordExpense(store,{...base,requestId:requestId(),amountMinor:0,incurredOn:'2025-09-02'},f.actorId);
    assert.ok(zero.id);assert.equal(zero.amountMinor,0);assert.equal(zero.outstandingMinor,0);
    const known=await getShipment(store,f.shipmentId);
    assert.equal(known.costStatuses.shipping_insurance,'known');assert.equal(known.costStatus,'known');
    assert.equal(known.costObservations.shipping_insurance.amountMinor,0);
    const zeroReport=await buildBusinessReport(store,query);
    assert.equal(zeroReport.metrics.shippingCosts.complete,true);
    assert.equal(zeroReport.metrics.shippingCosts.value,before.metrics.shippingCosts.value);
    await assert.rejects(()=>recordExpense(store,{...base,requestId:requestId(),id:zero.id,version:zero.version,amountMinor:null,incurredOn:'2025-09-02',reason:'Observación vacía posterior'},f.actorId),{status:409});
    assert.equal((await getShipment(store,f.shipmentId)).costObservations.shipping_insurance.amountMinor,0);
    const undated=await recordExpense(store,{...base,requestId:requestId(),id:zero.id,version:zero.version,amountMinor:100000,incurredOn:null,reason:'Prima conocida sin fecha informada'},f.actorId);
    assert.equal(undated.id,zero.id);assert.equal(undated.incurredOn,null);assert.equal(undated.chargeOn,null);assert.equal(undated.dateSource,'charge_date');
    const pending=await buildBusinessReport(store,query);
    assert.equal(pending.metrics.shippingCosts.complete,false);
    assert.equal(pending.metrics.shippingCosts.knownValue,before.metrics.shippingCosts.value);
    const pendingRows=reportDetails(pending,{metric:'shippingCosts',pageSize:null}).records.filter(row=>row.expenseId===zero.id);
    assert.equal(pendingRows.length,1);assert.equal(pendingRows[0].reason,'expense_date_unknown');assert.equal(pendingRows[0].known,false);
    const dated=await recordExpense(store,{...base,requestId:requestId(),id:undated.id,version:undated.version,amountMinor:100000,incurredOn:'2025-09-02',reason:'Fecha explícita del cargo recibida'},f.actorId);
    assert.equal(dated.id,zero.id);
    const resolved=await buildBusinessReport(store,query);
    assert.equal(resolved.metrics.shippingCosts.complete,true);assert.equal(resolved.metrics.shippingCosts.value,before.metrics.shippingCosts.value+100000);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')} WHERE category=?`,['shipping_insurance'])).n),1);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expense_payments')} WHERE expense_id=?`,[zero.id])).n),0);
    assert.equal(await accountBalance(store,f.account.id),10000000);
  }],
  ['seguro usa fecha del cargo aunque plataforma use fecha de liquidación',async store=>{
    const f=await createBusinessBasics(store,{year:2025,reportsStartOn:'2025-09-01'});
    const settings=await getBusinessSettings(store);
    await saveBusinessSettings(store,{...settings,requestId:requestId(),rulesVersions:settings.rulesVersions.map(rule=>({...rule,platformFeeExpenseDate:'settlement_date'}))},f.actorId);
    const order=await store.saveOrder(businessOrderInput(f.a,{year:2025}),f.actorId);
    const shipment=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:f.platform.id,sourceId:f.source.id,externalId:'INSURANCE-DATE',carrier:'Transportadora sintética',tracking:'000009999'},f.actorId);
    const fee=await recordExpense(store,{requestId:requestId(),category:'platform_fee',shipmentId:shipment.id,amountMinor:200000,incurredOn:'2025-09-02'},f.actorId);
    assert.equal(fee.dateSource,'settlement_date');assert.equal(fee.incurredOn,null);
    const insurance=await recordExpense(store,{requestId:requestId(),category:'shipping_insurance',shipmentId:shipment.id,amountMinor:100000,incurredOn:'2025-09-02'},f.actorId);
    assert.equal(insurance.dateSource,'charge_date');assert.equal(insurance.incurredOn,'2025-09-02');assert.equal(insurance.chargeOn,'2025-09-02');
    assert.equal(insurance.sourceKey,`${shipment.id}:shipping_insurance`);
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
  ['Excel importa seguro repetido por producto, distribuye centavos y reutiliza el cargo sin pagar al declarar',async store=>{
    const f=await createBusinessBasics(store,{year:2025,reportsStartOn:'2025-09-01'});
    const informationColumns=[...BUSINESS_WORKBOOK_COLUMNS,['Valor declarado COP','insuredValue'],['Recaudo solicitado COP','expectedCollection']];
    const costColumns=[...informationColumns,['Prima COP','insuranceCost'],['Fecha prima','insuranceCostDate']];
    const profile=columns=>({...businessWorkbookProfile(),columns:columns.map(([header,destination],index)=>({index,header,destination,group:0}))});
    const workbook=(rows,columns=costColumns)=>writeExcelSheets([{name:'Pedidos sintéticos',rows:[columns.map(([header])=>header),...rows.map(row=>columns.map(([,field])=>row[field]??''))]}]);
    const options={config:profile(costColumns),resolutions:[{action:'link_product',externalKey:'PRODUCT-B',internalId:f.b.id}]};
    const rows=businessWorkbookRows(f.year).map((row,index)=>({...row,
      ...(index?{productExternalKey:'PRODUCT-B',unitPrice:'10.000'}:{}),
      collectedAmount:'132.000',settlementExternalId:null,settlementDate:null,settlementGross:null,settlementNet:null,settlementReference:null,
      insuredValue:55000,expectedCollection:55000,insuranceCost:1000,insuranceCostDate:'2025-09-02'
    }));
    const first=await importFixtureWorkbook(store,f,workbook(rows,informationColumns),{...options,config:profile(informationColumns)});
    await confirmPayroll(store,{requestId:requestId(),personId:f.person.id,startOn:'2025-09-01',endOnExclusive:'2025-10-01',bonusMinor:0,discountMinor:0},f.actorId);
    const initial=(await store.pageOrders()).records[0],orderBefore=await store.order(initial.id),shipmentBefore=await getShipment(store,orderBefore.shipments[0].id);
    assert.equal(orderBefore.totalMinor,13200000);assert.equal(orderBefore.items.length,2);
    assert.equal(orderBefore.paymentSummary.netCollectedMinor,13200000);
    assert.equal(shipmentBefore.costStatus,'known');assert.equal(Object.hasOwn(shipmentBefore.costStatuses,'shipping_insurance'),false);
    for(const key of ['insuredValue','expectedCollection']){
      const field=shipmentBefore.importedFields.find(field=>field.key===key);
      assert.equal(field.value,5500000);assert.equal(field.sourceId,f.source.id);assert.equal(field.batchId,first.id);
      assert.equal(field.sourceAsOf,'2025-09-06T04:59:59.999Z');assert.deepEqual(field.rowNumbers,[2,3]);
    }
    const query={period:'month',anchorDate:'2025-09-01',asOf:'2025-10-01T05:00:00.000Z'};
    const before=await buildBusinessReport(store,query),balanceBefore=await accountBalance(store,f.account.id);
    const financialRows=async()=>Object.fromEntries(await Promise.all(['cash_entries','expense_payments','settlement_receipts'].map(async table=>[table,await store.db.all(`SELECT id FROM ${store.t(table)} ORDER BY id`)])));
    const moneyBefore=await financialRows();
    for(const key of ['shippingCosts','contribution','operatingResult'])assert.equal(before.metrics[key].complete,true,key);
    assert.equal(balanceBefore,10000000);assert.equal(moneyBefore.expense_payments.length,0);
    const imported=await importFixtureWorkbook(store,f,workbook(rows),options);
    assert.equal(imported.preview.summary.rejected,0);
    const order=await store.order(initial.id),shipment=await getShipment(store,shipmentBefore.id);
    const insurance=order.expenses.filter(expense=>expense.category==='shipping_insurance');
    assert.equal(insurance.length,1);
    const expense=insurance[0];
    assert.equal(expense.shipmentId,shipment.id);assert.equal(expense.orderId,order.id);
    assert.equal(expense.amountMinor,100000);assert.equal(expense.sourceKey,`${shipment.id}:shipping_insurance`);
    assert.equal(expense.sourceId,f.source.id);assert.equal(expense.sourceAsOf,'2025-09-06T04:59:59.999Z');
    assert.equal(expense.incurredOn,'2025-09-02');assert.equal(expense.chargeOn,'2025-09-02');assert.equal(expense.dateSource,'charge_date');
    assert.equal(shipment.costStatus,'known');assert.equal(shipment.costStatuses.shipping_insurance,'known');
    assert.equal(shipment.costObservations.shipping_insurance.amountMinor,100000);
    assert.deepEqual(shipment.importedFields,shipmentBefore.importedFields);
    const after=await buildBusinessReport(store,query);
    for(const [key,delta] of [['shippingCosts',100000],['contribution',-100000],['operatingResult',-100000]]){
      assert.equal(after.metrics[key].complete,true,key);assert.equal(after.metrics[key].value,before.metrics[key].value+delta,key);
    }
    assert.equal(order.financialSummary.contributionMinor,orderBefore.financialSummary.contributionMinor-100000);
    assert.deepEqual(order.paymentSummary,orderBefore.paymentSummary);
    const detail=reportDetails(after,{metric:'shippingCosts',pageSize:null}).records.filter(row=>row.expenseId===expense.id);
    assert.equal(detail.length,1);assert.equal(detail[0].value,100000);assert.equal(detail[0].occurredOn,'2025-09-02');
    assert.equal(detail[0].allocationBasis,'net_products');
    const shares=new Map(detail[0].allocations.map(part=>[part.productId,part.value]));
    assert.equal(shares.size,2);assert.equal(shares.get(f.a.id),91667);assert.equal(shares.get(f.b.id),8333);
    assert.equal([...shares.values()].reduce((sum,value)=>sum+value,0),100000);
    for(const [productId,share] of shares){
      const previous=before.groups.products.find(product=>product.id===productId),current=after.groups.products.find(product=>product.id===productId);
      assert.equal(current.complete,true);assert.equal(current.contributionMinor,previous.contributionMinor-share);
      const filtered=await buildBusinessReport(store,{...query,filters:{product:productId}});
      assert.equal(reportDetails(filtered,{metric:'shippingCosts',pageSize:null}).records.find(row=>row.expenseId===expense.id).value,share);
    }
    assert.equal(await accountBalance(store,f.account.id),balanceBefore);assert.deepEqual(await financialRows(),moneyBefore);
    const identities=async()=>Object.fromEntries(await Promise.all(['orders','shipments','shipment_events','order_collections','expenses','commission_entries'].map(async table=>[table,await store.db.all(`SELECT id FROM ${store.t(table)} ORDER BY id`)])));
    const identitiesBefore=await identities();
    for(const repeated of [rows,rows.toReversed()]){
      await importFixtureWorkbook(store,f,workbook(repeated),options);
      assert.deepEqual(await identities(),identitiesBefore);assert.deepEqual(await financialRows(),moneyBefore);
      const current=await store.order(order.id),currentShipment=await getShipment(store,shipment.id);
      assert.deepEqual(current.recognition,order.recognition);assert.deepEqual(current.paymentSummary,order.paymentSummary);
      assert.deepEqual(currentShipment.importedFields,shipment.importedFields);
      const report=await buildBusinessReport(store,query);
      for(const key of ['netProductSales','soldUnits','shippingCosts','contribution','operatingResult'])assert.equal(report.metrics[key].value,after.metrics[key].value,key);
    }
    const declarationRows=rows.map(row=>({...row,settlementExternalId:'INSURANCE-RETENTION',settlementDate:'2025-09-05',settlementGross:'132.000',settlementNet:'114.000',settlementReference:'Retención explícita de la prima'}));
    await importFixtureWorkbook(store,f,workbook(declarationRows),options);
    const declaredRow=await store.db.get(`SELECT id FROM ${store.t('settlements')}`),declaration=await getSettlement(store,declaredRow.id);
    assert.equal(declaration.state,'pending');assert.equal(declaration.reconciliationRequired,false);assert.equal(declaration.unresolvedLines.length,0);
    assert.equal(declaration.lines.length,1);assert.equal(declaration.lines[0].collectionId,order.collections[0].id);
    assert.deepEqual(declaration.lines[0].deductions.filter(deduction=>deduction.expenseId===expense.id),[{expenseId:expense.id,amountMinor:100000}]);
    assert.deepEqual(declaration.lines[0].deductions.map(deduction=>deduction.expenseId).sort(),order.expenses.map(expense=>expense.id).sort());
    assert.deepEqual(await identities(),identitiesBefore);assert.deepEqual(await financialRows(),moneyBefore);
    assert.equal(await accountBalance(store,f.account.id),balanceBefore);
    const received=await confirmSettlement(store,{requestId:requestId(),settlementId:declaration.id,version:declaration.version,receivedOn:'2025-09-05',accountId:f.account.id,externalKey:'INSURANCE-RETENTION-RECEIPT',lines:declaration.lines},f.actorId);
    assert.equal(received.settlement.state,'confirmed');assert.equal(received.receipt.netMinor,11400000);
    assert.equal(await accountBalance(store,f.account.id),balanceBefore+11400000);
    const paid=await store.db.all(`SELECT expense_id,amount_minor,settlement_receipt_id,cash_entry_id FROM ${store.t('expense_payments')} WHERE expense_id=?`,[expense.id]);
    assert.equal(paid.length,1);assert.equal(Number(paid[0].amount_minor),100000);assert.equal(paid[0].settlement_receipt_id,received.receipt.id);assert.equal(paid[0].cash_entry_id,null);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')} WHERE shipment_id=? AND category=?`,[shipment.id,'shipping_insurance'])).n),1);
  }],
  ['liquidación de dos guías del mismo pedido retiene cada prima solo contra su propio recaudo',async store=>{
    const f=await createBusinessBasics(store,{year:2025,reportsStartOn:'2025-09-01'});
    const columns=[...BUSINESS_WORKBOOK_COLUMNS,['ID envío','externalShipmentId'],['Prima COP','insuranceCost'],['Fecha prima','insuranceCostDate']];
    const config={...businessWorkbookProfile(),columns:columns.map(([header,destination],index)=>({index,header,destination,group:0}))};
    const options={config,resolutions:[{action:'link_product',externalKey:'PRODUCT-B',internalId:f.b.id}]};
    const workbook=rows=>writeExcelSheets([{name:'Pedidos sintéticos',rows:[columns.map(([header])=>header),...rows.map(row=>columns.map(([,field])=>row[field]??''))]}]);
    const rows=businessWorkbookRows(f.year).map((row,index)=>({...row,quantity:1,
      ...(index?{productExternalKey:'PRODUCT-B',unitPrice:'10.000'}:{}),
      externalShipmentId:`INSURANCE-SPLIT-${index+1}`,tracking:`000INSURANCE${index+1}`,collectionExternalId:`INSURANCE-COLLECTION-${index+1}`,
      collectedAmount:index?'12.000':'65.000',settlementExternalId:null,settlementDate:null,settlementGross:null,settlementNet:null,settlementReference:null,
      insuranceCost:index?2500:1000,insuranceCostDate:'2025-09-02'
    }));
    await importFixtureWorkbook(store,f,workbook(rows),options);
    const initial=(await store.pageOrders()).records[0],order=await store.order(initial.id);
    assert.equal((await store.pageOrders()).total,1);assert.equal(order.shipments.length,2);assert.equal(order.items.length,2);assert.equal(order.totalMinor,7700000);
    assert.equal(order.paymentSummary.netCollectedMinor,7700000);
    const premiums=order.expenses.filter(expense=>expense.category==='shipping_insurance');
    assert.equal(premiums.length,2);assert.deepEqual(premiums.map(expense=>expense.amountMinor).sort((a,b)=>a-b),[100000,250000]);
    for(const shipment of order.shipments){
      const premium=premiums.find(expense=>expense.shipmentId===shipment.id),index=rows.findIndex(row=>row.externalShipmentId===shipment.externalId);
      assert.ok(index>=0);assert.equal(premium.amountMinor,index?250000:100000);assert.equal(premium.sourceKey,`${shipment.id}:shipping_insurance`);
      assert.equal(shipment.assignments.length,1);assert.equal(shipment.assignments[0].quantity,1);
    }
    const balance=await accountBalance(store,f.account.id);
    const originalIds=async()=>Object.fromEntries(await Promise.all(['orders','shipments','shipment_events','order_collections','expenses','cash_entries','expense_payments','settlement_receipts'].map(async table=>[table,await store.db.all(`SELECT id FROM ${store.t(table)} ORDER BY id`)])));
    const before=await originalIds();
    assert.equal(balance,10000000);assert.equal(before.expense_payments.length,0);assert.equal(before.settlement_receipts.length,0);
    const declared=rows.map((row,index)=>({...row,settlementExternalId:'INSURANCE-TWO-GUIDES',settlementDate:'2025-09-05',settlementGross:index?'12.000':'65.000',settlementNet:'39.500',settlementReference:'Dos guías, primas independientes'}));
    await importFixtureWorkbook(store,f,workbook(declared),options);
    const row=await store.db.get(`SELECT id FROM ${store.t('settlements')}`),settlement=await getSettlement(store,row.id);
    assert.equal(settlement.state,'pending');assert.equal(settlement.reconciliationRequired,false);assert.equal(settlement.unresolvedLines.length,0);
    assert.equal(settlement.lines.length,2);assert.equal(settlement.declaredGrossMinor,7700000);assert.equal(settlement.netMinor,3950000);
    const expenseById=new Map(order.expenses.map(expense=>[expense.id,expense])),collectionById=new Map(order.collections.map(collection=>[collection.id,collection]));
    const retained=[];
    for(const line of settlement.lines){
      const collection=collectionById.get(line.collectionId),shipmentExpenses=order.expenses.filter(expense=>expense.shipmentId===collection.shipmentId);
      assert.deepEqual(line.deductions.map(deduction=>deduction.expenseId).sort(),shipmentExpenses.map(expense=>expense.id).sort());
      for(const deduction of line.deductions){
        const expense=expenseById.get(deduction.expenseId);
        assert.equal(expense.shipmentId,collection.shipmentId);assert.equal(deduction.amountMinor,expense.amountMinor);retained.push(expense.id);
      }
    }
    assert.equal(new Set(retained).size,retained.length);
    assert.deepEqual(retained.sort(),order.expenses.map(expense=>expense.id).sort());
    assert.deepEqual(await originalIds(),before);assert.equal(await accountBalance(store,f.account.id),balance);
    for(const repeated of [declared,declared.toReversed()]){
      await importFixtureWorkbook(store,f,workbook(repeated),options);
      const current=await getSettlement(store,settlement.id);
      assert.deepEqual(current.lines,settlement.lines);assert.equal(current.version,settlement.version);
      assert.deepEqual(await originalIds(),before);assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('settlements')}`)).n),1);
    }
    const confirmed=await confirmSettlement(store,{requestId:requestId(),settlementId:settlement.id,version:settlement.version,receivedOn:'2025-09-05',accountId:f.account.id,externalKey:'INSURANCE-TWO-GUIDES-RECEIPT',lines:settlement.lines},f.actorId);
    assert.equal(confirmed.settlement.state,'confirmed');assert.equal(await accountBalance(store,f.account.id),balance+3950000);
    for(const premium of premiums){
      const payments=await store.db.all(`SELECT amount_minor,settlement_receipt_id,cash_entry_id FROM ${store.t('expense_payments')} WHERE expense_id=?`,[premium.id]);
      assert.equal(payments.length,1);assert.equal(Number(payments[0].amount_minor),premium.amountMinor);
      assert.equal(payments[0].settlement_receipt_id,confirmed.receipt.id);assert.equal(payments[0].cash_entry_id,null);
    }
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')} WHERE category=?`,['shipping_insurance'])).n),2);
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
  ['perfil heredado duplicado conserva ambas columnas hasta corregir antes de revisar',async store=>{
    const f=await createBusinessBasics(store),headers=['Id','Guía','Otra guía','Transportadora'];
    const config={sheetName:'Heredado',headerRow:1,dateFormat:'ISO',purpose:'tracking',reportAsOf:`${f.year}-09-05`,columns:[
      {index:0,header:headers[0],destination:'externalShipmentId'},
      {index:1,header:headers[1],destination:'tracking'},
      {index:2,header:headers[2],destination:'shipmentReference'},
      {index:3,header:headers[3],destination:'carrier'},
    ]};
    const profile=await saveResource(store,'profiles',{requestId:requestId(),name:'Perfil heredado sintético',sourceId:f.source.id,profile:config},f.actorId);
    const legacy={...config,columns:config.columns.map(column=>column.index===2?{...column,destination:'tracking'}:column)};
    await store.db.run(`UPDATE ${store.t('import_profiles')} SET data=?,version=version+1 WHERE id=?`,[JSON.stringify(legacy),profile.id]);
    let batch=await createImportBatch(store,{sourceId:f.source.id,profileId:profile.id,requestId:requestId()},f.actorId);
    assert.deepEqual(batch.config.sheets[0].columns.filter(column=>column.destination==='tracking').map(column=>column.index),[1,2]);
    await uploadImportFile(store,batch.id,{filename:'perfil-heredado.xlsx',bytes:writeExcelSheets([{name:'Heredado',rows:[headers,['LEGACY-SHIP','000LEGACY01','000LEGACY02','Transportadora sintética']]}]),version:batch.version,requestId:requestId()},f.actorId);
    await drainImports(store);batch=await getImportBatch(store,batch.id);
    assert.equal(batch.state,'review');
    const conflict={status:400,code:'IMPORT_COLUMN_DUPLICATE'};
    await assert.rejects(()=>updateImportBatch(store,batch.id,{version:batch.version,config:batch.config,requestId:requestId()},f.actorId),conflict);
    await assert.rejects(()=>requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},f.actorId),conflict);
    await assert.rejects(()=>saveResource(store,'profiles',{requestId:requestId(),name:'No guardar duplicado',sourceId:f.source.id,profile:legacy},f.actorId),conflict);
    let selected=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},f.actorId);
    selected=await updateImportBatch(store,selected.id,{version:selected.version,profileId:profile.id,requestId:requestId()},f.actorId);
    assert.deepEqual(selected.config.sheets[0].columns.filter(column=>column.destination==='tracking').map(column=>column.index),[1,2]);
    const corrected={...batch.config,sheets:batch.config.sheets.map(sheet=>({...sheet,reportAsOf:`${f.year}-09-05`,columns:sheet.columns.map(column=>column.index===2?{...column,destination:'ignore'}:column)}))};
    batch=await updateImportBatch(store,batch.id,{version:batch.version,config:corrected,requestId:requestId()},f.actorId);
    await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},f.actorId);await drainImports(store);
    batch=await getImportBatch(store,batch.id);assert.equal(batch.preview.summary.valid,1);
    await commitImport(store,batch.id,{version:batch.version,previewHash:batch.preview.previewHash,requestId:requestId()},f.actorId);await drainImports(store);
    assert.equal((await getImportBatch(store,batch.id)).state,'completed');
    const row=await store.db.get(`SELECT id FROM ${store.t('shipments')}`);
    assert.equal((await getShipment(store,row.id)).tracking,'000LEGACY01');
    assert.equal((await financeOverview(store)).availableMinor,10000000);
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
