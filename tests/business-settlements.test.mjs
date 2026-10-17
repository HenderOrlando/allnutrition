import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { saveResource, getBusinessSettings, saveBusinessSettings, listResources } from '../lib/business/settings.mjs';
import { saveAccount, accountBalance } from '../lib/business/cash.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollection, recordRefund } from '../lib/business/collections.mjs';
import { recordExpense, payExpense, recordExpenseRecovery, expenseBalanceTx, reverseExpensePaymentTx } from '../lib/business/expenses.mjs';
import { saveSettlement, confirmSettlement, getSettlement, reverseSettlementReceiptTx, reverseSettlementTx } from '../lib/business/settlements.mjs';
import { runCommand } from '../lib/business/commands.mjs';

const actor = 'settlement-test-admin';
const request = input => ({ requestId:randomUUID(), ...input });
const count = async (store, table) => (await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n;
const reverseReceipt = (store, id) => runCommand(store, { scope:'test:reverse-receipt', requestId:randomUUID(), payload:{ id }, actorId:actor }, tx => reverseSettlementReceiptTx(tx, id, { effectiveOn:'2026-09-10', reason:'Rectificación documentada', actorId:actor }));
const reversePayment = (store, id) => runCommand(store, { scope:'test:reverse-payment', requestId:randomUUID(), payload:{ id }, actorId:actor }, tx => reverseExpensePaymentTx(tx, id, { effectiveOn:'2026-09-10', reason:'Rectificación documentada', actorId:actor }));
async function fixture(store, { grossMinor = 12200000, expenseMinor = 1700000, datePolicy = 'charge_date' } = {}) {
  const settings = await getBusinessSettings(store);
  await saveBusinessSettings(store, request({ ...settings, rulesVersions:[{ id:'historic-test-policy', effectiveOn:'2026-01-01', saleRecognition:'confirmed', commission:{ enabled:false }, shippingExpenseDate:datePolicy, platformFeeExpenseDate:'settlement_date' }] }), actor);
  const person = await saveResource(store, 'people', request({ name:'Responsable sintético' }), actor);
  const account = await saveAccount(store, request({ name:'Banco de prueba', type:'bank', responsibleId:person.id, openingOn:'2026-09-01', openingBalanceMinor:10000000 }), actor);
  const platform = await saveResource(store, 'platforms', request({ name:'Plataforma sintética' }), actor);
  const [source] = await listResources(store, 'sources', { platform:platform.id });
  const product = await store.save('products', { title:'Producto sintético', slug:'settlement-product', status:'draft', orderable:true, price:Math.ceil(grossMinor / 100), presentation:'Unidad', stockQuantity:10000, unitCostMinor:0, costEffectiveOn:'2026-01-01' });
  const order = await store.saveOrder(request({ customerName:'Destinatario sintético', phone:'3001234567', department:'Bogotá', city:'Bogotá', address:'Dirección sintética', placedOn:'2026-09-01', status:'new', deliveryMethod:'carrier', shippingChargeMinor:0, items:[{ lineId:randomUUID(), kind:'products', itemId:product.id, quantity:1, unitPriceMinor:grossMinor, discountMinor:0 }] }), actor);
  const shipment = await createShipment(store, request({ orderId:order.id, platformId:platform.id, sourceId:source.id, carrier:'Transportadora sintética', tracking:'0000123456789' }), actor);
  const collection = await recordCollection(store, request({ orderId:order.id, version:(await store.order(order.id)).version, shipmentId:shipment.id, sourceId:source.id, holder:'platform', amountMinor:grossMinor, occurredOn:'2026-09-03', method:'cod', reference:'recaudo-sintético', externalKey:'0001' }), actor);
  const expense = await recordExpense(store, request({ category:'shipping_out', shipmentId:shipment.id, amountMinor:expenseMinor, incurredOn:'2026-09-02', concept:'Flete real informado' }), actor);
  return { account, source, order, shipment, collection, expense };
}
const line = (f, grossMinor, amountMinor) => ({ collectionId:f.collection.id, grossMinor, deductions:amountMinor === 0 ? [] : [{ expenseId:f.expense.id, amountMinor }] });
const declare = (store, f, lines, netMinor, extra = {}) => saveSettlement(store, request({ sourceId:f.source.id, externalKey:'liquidación-0001', reportedOn:'2026-09-05', lines, netMinor, ...extra }), actor);
const receive = (store, f, settlement, lines, extra = {}) => confirmSettlement(store, request({ settlementId:settlement.id, version:settlement.version, accountId:f.account.id, receivedOn:'2026-09-05', lines, ...extra }), actor);

export const businessSettlementContracts = [
  ['a full-size unresolved declaration preserves coverage without truncation or invented collections',async store=>{
    const f=await fixture(store);
    const unresolvedLines=Array.from({length:10000},(_,index)=>({externalOrderId:'PENDING-'+index,grossMinor:index===9999?null:100}));
    const settlement=await declare(store,f,[],900000,{source:'excel',reconciliationRequired:true,unresolvedLines});
    assert.equal(settlement.unresolvedLines.length,10000);
    assert.equal(settlement.unresolvedLines[9999].externalOrderId,'PENDING-9999');
    assert.equal(settlement.declaredGrossMinor,null);assert.equal(settlement.knownDeclaredGrossMinor,999900);
    assert.equal(await accountBalance(store,f.account.id),10000000);assert.equal(await count(store,'order_collections'),1);
    await assert.rejects(()=>saveSettlement(store,request({sourceId:f.source.id,externalKey:'TOO-MANY',source:'excel',netMinor:0,lines:[],reconciliationRequired:true,unresolvedLines:[...unresolvedLines,{externalOrderId:'PENDING-10000',grossMinor:100}]}),actor),{status:400});
    assert.equal(await count(store,'settlements'),1);
  }],
  ['unlinked Excel declaration remains pending and becomes receivable only after explicit linkage',async store=>{
    const f=await fixture(store);
    let settlement=await declare(store,f,[],10500000,{source:'excel',sourceAsOf:'2026-09-05T05:00:00.000Z',reconciliationRequired:true,unresolvedLines:[{tracking:'0000999999999',externalOrderId:'UNLINKED-ORDER',grossMinor:12200000}]});
    assert.equal(settlement.state,'pending');assert.equal(settlement.reconciliationRequired,true);
    assert.equal(settlement.declaredGrossMinor,12200000);assert.equal(await accountBalance(store,f.account.id),10000000);
    await assert.rejects(()=>receive(store,f,settlement,[line(f,12200000,1700000)]),{status:409});
    assert.equal(await count(store,'order_collections'),1);assert.equal(await count(store,'settlement_receipts'),0);
    settlement=await saveSettlement(store,request({settlementId:settlement.id,version:settlement.version,sourceId:f.source.id,netMinor:10500000,reportedOn:'2026-09-05',lines:[line(f,12200000,1700000)],reason:'Cobro y retención comprobados y vinculados'}),actor);
    assert.equal(settlement.reconciliationRequired,false);
    const result=await receive(store,f,settlement,[line(f,12200000,1700000)]);
    assert.equal(result.settlement.state,'confirmed');assert.equal(await accountBalance(store,f.account.id),20500000);
  }],
  ['declared platform money creates no cash; partial receipts reserve gross and deductions exactly', async store => {
    const f = await fixture(store);
    let settlement = await declare(store, f, [line(f, 12200000, 1700000)], 10500000);
    assert.equal(settlement.state, 'pending');
    assert.equal(await accountBalance(store, f.account.id), 10000000);
    assert.equal((await store.order(f.order.id)).paymentSummary.platformHeldMinor, 12200000);
    let result = await receive(store, f, settlement, [line(f, 6000000, 1000000)], { externalKey:'abono-01' });
    settlement = result.settlement;
    assert.equal(settlement.state, 'partial');
    assert.equal(settlement.remainingNetMinor, 5500000);
    assert.equal(await accountBalance(store, f.account.id), 15000000);
    assert.equal((await expenseBalanceTx(store, f.expense.id)).outstandingMinor, 700000);
    result = await receive(store, f, settlement, [line(f, 6200000, 700000)], { externalKey:'abono-02' });
    assert.equal(result.settlement.state, 'confirmed');
    assert.equal(await accountBalance(store, f.account.id), 20500000);
    assert.equal((await store.order(f.order.id)).paymentSummary.platformHeldMinor, 0);
    assert.deepEqual(await expenseBalanceTx(store, f.expense.id), { paidMinor:1700000, offsetMinor:0, outstandingMinor:0, creditMinor:0 });
    assert.equal(await count(store, 'order_collections'), 1);
    assert.equal(await count(store, 'expenses'), 1);
    assert.equal(await count(store, 'cash_entries'), 3);
  }],
  ['negative and zero net receipts retain exact supporting gross and create at most one cash entry', async store => {
    const f = await fixture(store, { grossMinor:10000, expenseMinor:15000 });
    let settlement = await declare(store, f, [line(f, 10000, 15000)], -5000);
    let result = await receive(store, f, settlement, [line(f, 5000, 5000)]);
    assert.equal(result.receipt.netMinor, 0);
    assert.equal(result.receipt.cashEntryId, null);
    assert.equal(await count(store, 'cash_entries'), 1);
    result = await receive(store, f, result.settlement, [line(f, 5000, 10000)]);
    assert.equal(result.receipt.netMinor, -5000);
    assert.equal(result.settlement.state, 'confirmed');
    assert.equal(await accountBalance(store, f.account.id), 9995000);
    assert.equal(await count(store, 'cash_entries'), 2);
    await reverseReceipt(store, result.receipt.id);
    settlement = await getSettlement(store, settlement.id);
    assert.equal(settlement.state, 'partial');
    assert.equal(await accountBalance(store, f.account.id), 10000000);
    await reverseReceipt(store, settlement.receipts.find(receipt => receipt.netMinor === 0).id);
    assert.equal((await getSettlement(store, settlement.id)).state, 'pending');
    assert.equal((await expenseBalanceTx(store, f.expense.id)).outstandingMinor, 15000);
  }],
  ['external receipt identity and optimistic allocation races cannot duplicate cash or costs', async store => {
    const f = await fixture(store);
    let settlement = await declare(store, f, [line(f, 12200000, 1700000)], 10500000);
    await assert.rejects(declare(store, f, [line(f, 12200000, 1700000)], 10500000), { status:409 });
    const payload = request({ settlementId:settlement.id, version:settlement.version, accountId:f.account.id, receivedOn:'2026-09-05', externalKey:'same-receipt', lines:[line(f, 6000000, 1000000)] });
    const first = await confirmSettlement(store, payload, actor);
    assert.equal((await confirmSettlement(store, payload, actor)).receipt.id, first.receipt.id);
    await assert.rejects(receive(store, f, first.settlement, [line(f, 1, 0)], { externalKey:'same-receipt' }), { status:409 });
    const raced = await Promise.allSettled([
      receive(store, f, first.settlement, [line(f, 6200000, 700000)], { externalKey:'race-one' }),
      receive(store, f, first.settlement, [line(f, 6200000, 700000)], { externalKey:'race-two' }),
    ]);
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(raced.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal(await count(store, 'settlement_receipts'), 2);
    assert.equal(await accountBalance(store, f.account.id), 20500000);
    assert.equal(await count(store, 'expenses'), 1);
  }],
  ['unsupported differences and exhausted allocations roll back the whole receipt', async store => {
    const f = await fixture(store);
    let settlement = await declare(store, f, [line(f, 12200000, 1700000)], 10499999);
    assert.equal(settlement.reconciliationRequired, true);
    await assert.rejects(receive(store, f, settlement, [line(f, 12200000, 1700000)]), { status:409 });
    settlement = await saveSettlement(store, request({ id:settlement.id, version:settlement.version, sourceId:f.source.id, lines:settlement.lines, netMinor:10500000, reason:'Diferencia declarada corregida' }), actor);
    await payExpense(store, request({ expenseId:f.expense.id, amountMinor:1700000, accountId:f.account.id, effectiveOn:'2026-09-04' }), actor);
    const before = { cash:await count(store, 'cash_entries'), payments:await count(store, 'expense_payments'), requests:await count(store, 'business_requests') };
    await assert.rejects(receive(store, f, settlement, [line(f, 12200000, 1700000)]), { status:409 });
    assert.equal(await count(store, 'settlement_receipts'), 0);
    assert.equal(await count(store, 'cash_entries'), before.cash);
    assert.equal(await count(store, 'expense_payments'), before.payments);
    assert.equal(await count(store, 'business_requests'), before.requests);
    assert.equal((await getSettlement(store, settlement.id)).version, settlement.version);
  }],
  ['cost correction opens supplier credit; real recovery never changes the expense a second time', async store => {
    const f = await fixture(store);
    const payment = await payExpense(store, request({ expenseId:f.expense.id, amountMinor:1700000, accountId:f.account.id, effectiveOn:'2026-09-04' }), actor);
    const corrected = await recordExpense(store, request({ expenseId:f.expense.id, version:f.expense.version, amountMinor:1500000, reason:'Cargo corregido con soporte' }), actor);
    assert.equal(corrected.creditMinor, 200000);
    assert.equal(await accountBalance(store, f.account.id), 8300000);
    const recovery = await recordExpenseRecovery(store, request({ expenseId:f.expense.id, amountMinor:200000, accountId:f.account.id, effectiveOn:'2026-09-06', reason:'Proveedor devolvió el excedente' }), actor);
    assert.equal(recovery.expense.amountMinor, 1500000);
    assert.equal(recovery.expense.creditMinor, 0);
    assert.equal(await accountBalance(store, f.account.id), 8500000);
    await assert.rejects(recordExpenseRecovery(store, request({ expenseId:f.expense.id, amountMinor:1, accountId:f.account.id, effectiveOn:'2026-09-06', reason:'Excede crédito' }), actor), { status:409 });
    await assert.rejects(reversePayment(store, payment.payment.id), { status:409 });
    await reversePayment(store, recovery.payment.id);
    assert.equal((await expenseBalanceTx(store, f.expense.id)).creditMinor, 200000);
    await reversePayment(store, payment.payment.id);
    assert.equal(await accountBalance(store, f.account.id), 10000000);
    assert.equal((await expenseBalanceTx(store, f.expense.id)).outstandingMinor, 1500000);
    assert.equal(await count(store, 'expenses'), 1);
  }],
  ['manual expense plus payment is atomic and occurrence date stays independent of cash date', async store => {
    const f = await fixture(store);
    const expense = await recordExpense(store, request({ category:'other', amountMinor:10000, incurredOn:null, concept:'Gasto sin fecha comprobada', supplier:'Proveedor sintético', accountId:f.account.id, effectiveOn:'2026-09-06' }), actor);
    assert.equal(expense.incurredOn, null);
    assert.equal(expense.paidMinor, 10000);
    assert.equal(expense.outstandingMinor, 0);
    assert.equal(await accountBalance(store, f.account.id), 9990000);
    const before = await count(store, 'expenses');
    await assert.rejects(recordExpense(store, request({ category:'other', amountMinor:10000, incurredOn:'2026-09-01', accountId:f.account.id, effectiveOn:'2999-01-01' }), actor), { status:400 });
    assert.equal(await count(store, 'expenses'), before);
    assert.equal(await accountBalance(store, f.account.id), 9990000);
  }],
  ['platform fee date follows its first active confirmed deduction, not import or reported date', async store => {
    const f = await fixture(store);
    const fee = await recordExpense(store, request({ category:'platform_fee', shipmentId:f.shipment.id, amountMinor:200000, incurredOn:'2026-09-02', concept:'Cargo plataforma' }), actor);
    assert.equal(fee.dateSource, 'settlement_date');
    assert.equal(fee.incurredOn, null);
    const lines = [{ collectionId:f.collection.id, grossMinor:12200000, deductions:[{ expenseId:fee.id, amountMinor:200000 }] }];
    const declaration = await declare(store, f, lines, 12000000);
    const received = await receive(store, f, declaration, lines);
    assert.equal((await store.db.get(`SELECT incurred_on FROM ${store.t('expenses')} WHERE id=?`, [fee.id])).incurred_on, '2026-09-05');
    await reverseReceipt(store, received.receipt.id);
    assert.equal((await store.db.get(`SELECT incurred_on FROM ${store.t('expenses')} WHERE id=?`, [fee.id])).incurred_on, null);
  }],
  ['an explicitly negative retention recovers supplier overpayment without a second expense adjustment', async store => {
    const f = await fixture(store);
    await payExpense(store, request({ expenseId:f.expense.id, amountMinor:1700000, accountId:f.account.id, effectiveOn:'2026-09-04' }), actor);
    const expense = await recordExpense(store, request({ expenseId:f.expense.id, version:f.expense.version, amountMinor:1500000, reason:'Costo final menor que el anticipo' }), actor);
    const declaration = await declare(store, f, [line(f, 12200000, -200000)], 12400000);
    const received = await receive(store, f, declaration, [line(f, 12200000, -200000)]);
    assert.equal(received.receipt.netMinor, 12400000);
    assert.equal((await expenseBalanceTx(store, expense.id)).creditMinor, 0);
    assert.equal((await store.db.get(`SELECT amount_minor FROM ${store.t('expenses')} WHERE id=?`, [expense.id])).amount_minor, 1500000);
    assert.equal(await accountBalance(store, f.account.id), 20700000);
    await reverseReceipt(store, received.receipt.id);
    assert.equal((await expenseBalanceTx(store, expense.id)).creditMinor, 200000);
    assert.equal(await accountBalance(store, f.account.id), 8300000);
  }],
  ['full reversal frees receipt allocations, expense payments and bank cash together', async store => {
    const f = await fixture(store);
    const declaration = await declare(store, f, [line(f, 12200000, 1700000)], 10500000);
    const first = await receive(store, f, declaration, [line(f, 6000000, 1000000)]);
    const second = await receive(store, f, first.settlement, [line(f, 6200000, 700000)]);
    const reversed = await runCommand(store, { scope:'test:reverse-settlement', requestId:randomUUID(), payload:{ id:declaration.id }, actorId:actor }, tx => reverseSettlementTx(tx, declaration.id, { version:second.settlement.version, effectiveOn:'2026-09-10', reason:'Liquidación completa incorrecta', actorId:actor }));
    assert.equal(reversed.state, 'pending');
    assert.equal(reversed.receipts.length, 4);
    assert.equal(await accountBalance(store, f.account.id), 10000000);
    assert.equal((await expenseBalanceTx(store, f.expense.id)).outstandingMinor, 1700000);
    assert.equal((await store.order(f.order.id)).paymentSummary.platformHeldMinor, 12200000);
    const replacement = await receive(store, f, reversed, [line(f, 12200000, 1700000)], { externalKey:'replacement-receipt' });
    assert.equal(replacement.settlement.state, 'confirmed');
    assert.equal(await accountBalance(store, f.account.id), 20500000);
    await assert.rejects(reverseReceipt(store, first.receipt.id), { status:409 });
  }],
  ['unknown and explicit zero shipping costs remain distinct and historical date policy uses real events', async store => {
    const f = await fixture(store, { expenseMinor:0, datePolicy:'dispatch_date' });
    assert.equal(f.expense.amountMinor, 0);
    assert.equal(f.expense.incurredOn, null);
    let shipment = (await store.order(f.order.id)).shipments.find(row => row.id === f.shipment.id);
    assert.equal(shipment.costStatus, 'known');
    await recordExpense(store, request({ category:'shipping_return', shipmentId:shipment.id, amountMinor:null, incurredOn:null }), actor);
    shipment = (await store.order(f.order.id)).shipments.find(row => row.id === f.shipment.id);
    assert.equal(shipment.costStatus, 'unknown');
    assert.equal(await count(store, 'expenses'), 1);
    shipment = await recordShipmentEvent(store, shipment.id, request({ version:shipment.version, status:'collected', occurredOn:'2026-09-02' }), actor);
    const expense = await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE id=?`, [f.expense.id]);
    assert.equal(expense.incurred_on, '2026-09-02');
    await recordExpense(store, request({ category:'shipping_return', shipmentId:shipment.id, amountMinor:0, incurredOn:null }), actor);
    assert.equal((await store.order(f.order.id)).shipments.find(row => row.id === shipment.id).costStatus, 'known');
    assert.equal(await count(store, 'cash_entries'), 1);
    await assert.rejects(recordExpense(store, request({ category:'salary', amountMinor:100, incurredOn:'2026-09-01' }), actor), { status:400 });
  }],
  ['cost snapshots preserve authority and cutoffs; older reports never overwrite newer expense facts', async store => {
    const f = await fixture(store);
    let expense = await recordExpense(store, request({ id:f.expense.id, version:f.expense.version, category:'shipping_out', shipmentId:f.shipment.id, amountMinor:1800000, incurredOn:'2026-09-02', source:'excel', sourceId:f.source.id, sourceAsOf:'2026-09-05T12:00:00Z', reason:'Revisión explícita del cargo', reviewConfirmed:true }), actor);
    const older = await recordExpense(store, request({ category:'shipping_out', shipmentId:f.shipment.id, amountMinor:1000000, incurredOn:'2026-09-02', source:'excel', sourceAsOf:'2026-09-04T12:00:00Z' }), actor);
    assert.equal(older.observationIgnored, true);
    assert.equal(older.amountMinor, 1800000);
    assert.equal(older.version, expense.version);
    await assert.rejects(recordExpense(store, request({ id:expense.id, version:expense.version, amountMinor:1900000, incurredOn:'2026-09-02', source:'excel', sourceAsOf:'2026-09-05T12:00:00Z', reason:'Mismo corte contradictorio' }), actor), { status:409 });
    expense = await recordExpense(store, request({ id:expense.id, version:expense.version, amountMinor:1900000, incurredOn:'2026-09-02', source:'excel', sourceAsOf:'2026-09-06T12:00:00Z', reason:'Corte posterior informado' }), actor);
    assert.equal(expense.amountMinor, 1900000);
    assert.equal(await count(store, 'expenses'), 1);
    assert.ok(await count(store, 'business_audit') > 0);
  }],
  ['a platform refund consumes pending gross and prevents a declaration receiving the same money', async store => {
    const f = await fixture(store);
    const settlement = await declare(store, f, [line(f, 12200000, 1700000)], 10500000);
    await recordRefund(store, request({ orderId:f.order.id, version:(await store.order(f.order.id)).version, shipmentId:f.shipment.id, sourceId:f.source.id, holder:'platform', amountMinor:1000000, occurredOn:'2026-09-04', method:'platform', reference:'reembolso-real', reason:'Reembolso previo a liquidación' }), actor);
    await assert.rejects(receive(store, f, settlement, [line(f, 12200000, 1700000)]), { status:409 });
    assert.equal(await accountBalance(store, f.account.id), 10000000);
    assert.equal(await count(store, 'settlement_receipts'), 0);
  }],
];

export async function runBusinessSettlementContracts(t, factory) {
  for (const [name, run] of businessSettlementContracts) await t.test(name, async () => {
    const store = await factory();
    try { await run(store); } finally { await store.close(); }
  });
}
test('Expense and settlement contracts on real SQLite', async t => runBusinessSettlementContracts(t, () => openStore({ DB_DRIVER:'sqlite', SQLITE_PATH:':memory:' })));
