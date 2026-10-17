import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { saveResource, getBusinessSettings, saveBusinessSettings } from '../lib/business/settings.mjs';
import { saveAccount, recordAdvance, accountBalance } from '../lib/business/cash.mjs';
import { recordCollection, recordCollectionTx, registerReturn } from '../lib/business/collections.mjs';
import { recordExpense, expenseBalanceTx } from '../lib/business/expenses.mjs';
import { saveSettlement, confirmSettlement } from '../lib/business/settlements.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { loadOrderData, persistOrderData } from '../lib/business/orders.mjs';
import { entity, insertRow, newId, runCommand, stamp } from '../lib/business/commands.mjs';
import { addDays, bogotaDate } from '../lib/business/dates.mjs';
import { preparePayroll, confirmPayroll, payPayroll, getPayroll, materializePayrollAccrualsTx, reconcileCommissionsTx, reversePayrollPaymentTx, reverseAdvanceTx } from '../lib/business/payroll.mjs';

const actor = 'payroll-test-admin';
const request = () => randomUUID();
const command = (store, scope, fn) => runCommand(store, { scope, requestId: request(), payload: {}, actorId: actor }, fn);
const select = async (store, table, clause = '', args = []) => (await store.db.all(`SELECT * FROM ${store.t(table)} ${clause}`, args)).map(entity);
const total = rows => rows.reduce((n, row) => n + row.amountMinor, 0);
const salary = (id, frequency, amountPerPeriodMinor, effectiveFrom, effectiveTo) => ({ id, frequency, amountPerPeriodMinor, effectiveFrom, effectiveTo, enabled: true });
const person = (store, agreements = []) => saveResource(store, 'people', { requestId: request(), name: 'Responsable sintético', salaryAgreements: agreements }, actor);
async function account(store, responsibleId) {
  return saveAccount(store, { requestId: request(), name: 'Banco de prueba', type: 'bank', responsibleId, openingOn: '2026-01-01', openingBalanceMinor: 10000000 }, actor);
}
async function configure(store, commission = { enabled: true, mode: 'percent', rateBps: 500, earnWhen: 'business_received' }, saleRecognition = 'confirmed') {
  const current = await getBusinessSettings(store);
  await saveBusinessSettings(store, { ...current, requestId: request(), rulesVersions: [{ id: 'historical-payroll', effectiveOn: '2026-01-01', saleRecognition, commission }] }, actor);
}
async function order(store, sellerId, { price = 5500000, quantity = 2, shippingChargeMinor = 1200000, discountMinor = 0 } = {}) {
  const id = request();
  const product = await store.save('products', { title: 'Producto sintético', slug: `payroll-${id}`, status: 'draft', orderable: true, price: price / 100, presentation: 'Unidad', stockQuantity: 10000, unitCostMinor: 2300000, costEffectiveOn: '2026-01-01' });
  return store.saveOrder({ requestId: request(), customerName: 'Destinatario sintético', phone: '3001234567', department: 'Bogotá', city: 'Bogotá', address: 'Dirección sintética', placedOn: '2026-09-01', sellerId, status: 'new', deliveryMethod: 'carrier', shippingChargeMinor, items: [{ lineId: request(), kind: 'products', itemId: product.id, quantity, unitPriceMinor: price, discountMinor }] }, actor);
}
const reconcile = (store, orderId, extra = {}) => command(store, 'test-commission', tx => reconcileCommissionsTx(tx, orderId, { actorId: actor, ...extra }));
const undoPayroll = (store, paymentId, effectiveOn = '2026-10-15') => command(store, 'test-reverse-payroll', tx => reversePayrollPaymentTx(tx, paymentId, { effectiveOn, reason: 'Rectificación sintética', actorId: actor }));

export const businessPayrollContracts = [
  ['daily salary uses calendar residue, inclusive agreements and idempotent completed-day jobs', async store => {
    const monthly = await person(store, [salary('monthly', 'monthly', 100, '2026-09-01', '2026-09-30')]);
    const weekly = await person(store, [salary('weekly', 'weekly', 70, '2026-09-08', '2026-09-10')]);
    const half = await person(store, [salary('half', 'halfmonthly', 100, '2026-09-01', '2026-09-30')]);
    await command(store, 'test-accrual', tx => materializePayrollAccrualsTx(tx, { throughOn: '2026-09-30', actorId: actor }));
    const monthlyExpenses = await select(store, 'expenses', 'WHERE person_id=? ORDER BY incurred_on', [monthly.id]);
    assert.equal(monthlyExpenses.length, 30);
    assert.deepEqual(monthlyExpenses.map(e => e.amountMinor), [...Array(10).fill(4), ...Array(20).fill(3)]);
    assert.equal(total(monthlyExpenses), 100);
    const weeklyExpenses = await select(store, 'expenses', 'WHERE person_id=? ORDER BY incurred_on', [weekly.id]);
    assert.deepEqual(weeklyExpenses.map(e => [e.incurredOn, e.amountMinor]), [['2026-09-08', 10], ['2026-09-09', 10], ['2026-09-10', 10]]);
    const halfExpenses = await select(store, 'expenses', 'WHERE person_id=? ORDER BY incurred_on', [half.id]);
    assert.equal(total(halfExpenses.filter(e => e.incurredOn < '2026-09-16')), 100);
    assert.equal(total(halfExpenses.filter(e => e.incurredOn >= '2026-09-16')), 100);
    assert.deepEqual(halfExpenses.slice(0, 15).map(e => e.amountMinor), [...Array(10).fill(7), ...Array(5).fill(6)]);
    const repeated = await command(store, 'test-accrual', tx => materializePayrollAccrualsTx(tx, { throughOn: '2026-09-30', actorId: actor }));
    assert.equal(repeated.createdCount, 0);
    const next = await person(store, [salary('a', 'monthly', 300, '2026-09-01', '2026-09-15'), salary('b', 'monthly', 600, '2026-09-16', '2026-09-30')]);
    await command(store, 'test-accrual', tx => materializePayrollAccrualsTx(tx, { throughOn: '2026-09-30', personId: next.id, actorId: actor }));
    assert.equal(total(await select(store, 'expenses', 'WHERE person_id=?', [next.id])), 450);
  }],
  ['preview is read-only and confirmation freezes accruals, validates discounts and rejects future periods', async store => {
    const p = await person(store, [salary('sept', 'monthly', 1000000, '2026-09-01', '2026-09-30')]);
    const before = (await select(store, 'counters', "WHERE id='business_revision'"))[0].value;
    const preview = await preparePayroll(store, { personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01', requestId: request() }, actor);
    assert.equal(preview.missingDayCount, 30);
    assert.equal(preview.earnedMinor, 1000000);
    assert.equal((await select(store, 'expenses')).length, 0);
    assert.equal((await select(store, 'payroll_periods')).length, 0);
    assert.equal((await select(store, 'counters', "WHERE id='business_revision'"))[0].value, before);
    await assert.rejects(confirmPayroll(store, { personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01', discountMinor: 1000001, reason: 'Descuento excesivo', requestId: request() }, actor), { status: 400 });
    assert.equal((await select(store, 'expenses')).length, 0);
    const payload = { personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01', bonusMinor: 10000, discountMinor: 25000, reason: 'Bonificación y descuento interno', requestId: request() };
    const confirmed = await confirmPayroll(store, payload, actor);
    assert.equal(confirmed.earnedMinor, 985000);
    assert.equal(confirmed.outstandingMinor, 985000);
    assert.equal(confirmed.offsetMinor, 25000);
    assert.deepEqual(await confirmPayroll(store, payload, actor), confirmed);
    const changed = await saveResource(store, 'people', { ...p, requestId: request(), salaryAgreements: [salary('amended', 'monthly', 2000000, '2026-09-01', '2026-09-30')] }, actor, p.id);
    await command(store, 'test-accrual', tx => materializePayrollAccrualsTx(tx, { throughOn: '2026-09-30', personId: changed.id, actorId: actor }));
    assert.equal(total((await select(store, 'expenses', 'WHERE person_id=?', [p.id])).filter(e => e.agreementId)), 1000000);
    const future = addDays(bogotaDate(), 2);
    await assert.rejects(confirmPayroll(store, { personId: p.id, startOn: future, endOnExclusive: addDays(future, 1), requestId: request() }, actor), { status: 400 });
    await assert.rejects(command(store, 'test-accrual', tx => materializePayrollAccrualsTx(tx, { throughOn: future, actorId: actor })), { status: 400 });
  }],
  ['business receipt supplies the commission date when the original Excel collection date is unknown', async store => {
    await configure(store);
    const p = await person(store), bank = await account(store, p.id), sale = await order(store, p.id);
    const platform = await saveResource(store, 'platforms', { name: 'Plataforma con fecha pendiente', requestId: request() }, actor);
    const source = (await select(store, 'platform_sources', 'WHERE platform_id=?', [platform.id]))[0];
    const shipment = await createShipment(store, { requestId: request(), orderId: sale.id, platformId: platform.id, sourceId: source.id, carrier: 'Transportador sintético', tracking: '0000000000123' }, actor);
    const current = await store.order(sale.id);
    const collection = await command(store, 'test:undated-platform', tx => recordCollectionTx(tx, { orderId: sale.id, version: current.version, shipmentId: shipment.id, holder: 'platform', sourceId: source.id, amountMinor: sale.totalMinor, occurredOn: null, source: 'excel', sourceAsOf: '2026-09-04T18:00:00.000Z', method: 'Contraentrega', reference: 'Recaudo observado', externalKey: 'KNOWN-AMOUNT-UNKNOWN-DATE' }, actor, { allowUnknownDate: true }));
    assert.equal(total(await select(store, 'commission_entries')), 0);
    const lines = [{ collectionId: collection.id, grossMinor: sale.totalMinor, deductions: [] }];
    const settlement = await saveSettlement(store, { requestId: request(), sourceId: source.id, reportedOn: '2026-09-05', netMinor: sale.totalMinor, lines }, actor);
    await confirmSettlement(store, { requestId: request(), settlementId: settlement.id, version: settlement.version, accountId: bank.id, receivedOn: '2026-09-05', lines }, actor);
    const entries = await select(store, 'commission_entries');
    assert.equal(total(entries), 550000);
    assert.equal(entries[0].earnedOn, '2026-09-05');
    assert.equal(await accountBalance(store, bank.id), 22200000);
    assert.equal((await select(store, 'order_collections', 'WHERE id=?', [collection.id]))[0].occurredOn, null);
  }],
  ['122000 gross settlement earns 5500 commission once, salary pays 15500 and later 2750 credit offsets next 10000', async store => {
    await configure(store);
    const p = await person(store, [salary('sept', 'monthly', 1000000, '2026-09-01', '2026-09-30'), salary('oct', 'halfmonthly', 1000000, '2026-10-01', '2026-10-15')]);
    const bank = await account(store, p.id), sale = await order(store, p.id);
    const platform = await saveResource(store, 'platforms', { name: 'Plataforma sintética', requestId: request() }, actor);
    const source = (await select(store, 'platform_sources', 'WHERE platform_id=?', [platform.id]))[0];
    const shipment = await createShipment(store, { requestId: request(), orderId: sale.id, sourceId: source.id, platformId: platform.id, carrier: 'Transportador sintético', tracking: '0000123456789' }, actor);
    const collection = await recordCollection(store, { requestId: request(), version: (await store.order(sale.id)).version, orderId: sale.id, shipmentId: shipment.id, holder: 'platform', amountMinor: 12200000, occurredOn: '2026-09-03', method: 'Contraentrega', reference: 'receipt-synthetic' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 0);
    const shipping = await recordExpense(store, { requestId: request(), category: 'shipping_out', orderId: sale.id, shipmentId: shipment.id, amountMinor: 1500000, incurredOn: '2026-09-02' }, actor);
    const fee = await recordExpense(store, { requestId: request(), category: 'platform_fee', orderId: sale.id, shipmentId: shipment.id, amountMinor: 200000, incurredOn: '2026-09-02' }, actor);
    const lines = [{ collectionId: collection.id, grossMinor: 12200000, deductions: [{ expenseId: shipping.id, amountMinor: 1500000 }, { expenseId: fee.id, amountMinor: 200000 }] }];
    const settlement = await saveSettlement(store, { requestId: request(), sourceId: source.id, reportedOn: '2026-09-05', netMinor: 10500000, lines }, actor);
    await confirmSettlement(store, { requestId: request(), settlementId: settlement.id, version: settlement.version, accountId: bank.id, receivedOn: '2026-09-05', lines }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 550000);
    assert.equal(await accountBalance(store, bank.id), 20500000);
    const payroll = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01' }, actor);
    assert.equal(payroll.earnedMinor, 1550000);
    const paid = await payPayroll(store, { requestId: request(), payrollId: payroll.id, version: payroll.version, amountMinor: 1550000, accountId: bank.id, effectiveOn: '2026-09-30' }, actor);
    assert.equal(paid.outstandingMinor, 0);
    assert.ok(paid.payrollPaymentId);
    assert.equal(await accountBalance(store, bank.id), 18950000);
    const latest = await store.order(sale.id);
    await registerReturn(store, { requestId: request(), orderId: sale.id, version: latest.version, occurredOn: '2026-10-02', reason: 'Retorno sintético', lines: [{ lineId: sale.items[0].lineId, quantity: 1, condition: 'recoverable' }], shippingCreditMinor: 0 }, actor);
    const entries = await select(store, 'commission_entries');
    assert.equal(total(entries), 275000);
    assert.equal(entries.find(e => e.amountMinor < 0).earnedOn, '2026-10-02');
    assert.equal(await accountBalance(store, bank.id), 18950000);
    const october = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-10-01', endOnExclusive: '2026-10-16' }, actor);
    assert.equal(october.outstandingMinor, 725000);
    assert.equal(october.offsetMinor, 275000);
    const octPaid = await payPayroll(store, { requestId: request(), payrollId: october.id, version: october.version, amountMinor: 725000, accountId: bank.id, effectiveOn: '2026-10-15' }, actor);
    assert.equal(octPaid.outstandingMinor, 0);
    const undone = await undoPayroll(store, octPaid.payrollPaymentId);
    assert.equal(undone.outstandingMinor, 1000000);
    assert.equal(undone.creditMinor, 275000);
    assert.equal(undone.activeOffsets.length, 0);
    assert.equal(await accountBalance(store, bank.id), 18950000);
    await assert.rejects(undoPayroll(store, octPaid.payrollPaymentId), { status: 409 });
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 275000);
  }],
  ['advances are cash-only, globally bounded and partial payroll reversal restores original sources', async store => {
    const p = await person(store, [salary('sept', 'monthly', 1000000, '2026-09-01', '2026-09-30'), salary('oct', 'halfmonthly', 1000000, '2026-10-01', '2026-10-15')]);
    const bank = await account(store, p.id);
    const advance = await recordAdvance(store, { requestId: request(), personId: p.id, amountMinor: 300000, accountId: bank.id, effectiveOn: '2026-09-15', concept: 'Anticipo sintético' }, actor);
    assert.equal((await select(store, 'expenses')).length, 0);
    let payroll = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01' }, actor);
    assert.equal(payroll.outstandingMinor, 700000);
    assert.equal(payroll.advanceAppliedMinor, 300000);
    await assert.rejects(command(store, 'test-reverse-advance', tx => reverseAdvanceTx(tx, advance.id, { effectiveOn: '2026-10-15', reason: 'Revertir anticipo', actorId: actor })), { status: 409 });
    const first = await payPayroll(store, { requestId: request(), payrollId: payroll.id, version: payroll.version, amountMinor: 200000, accountId: bank.id, effectiveOn: '2026-09-30' }, actor);
    const second = await payPayroll(store, { requestId: request(), payrollId: payroll.id, version: first.version, amountMinor: 500000, accountId: bank.id, effectiveOn: '2026-09-30' }, actor);
    assert.equal(second.outstandingMinor, 0);
    await assert.rejects(payPayroll(store, { requestId: request(), payrollId: payroll.id, version: first.version, amountMinor: 1, accountId: bank.id, effectiveOn: '2026-09-30' }, actor), { status: 409 });
    payroll = await undoPayroll(store, first.payrollPaymentId);
    assert.equal(payroll.outstandingMinor, 200000);
    assert.equal(payroll.advanceAppliedMinor, 300000);
    payroll = await undoPayroll(store, second.payrollPaymentId);
    assert.equal(payroll.outstandingMinor, 1000000);
    assert.equal(payroll.advanceAppliedMinor, 0);
    assert.equal(payroll.advances[0].availableMinor, 300000);
    const next = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-10-01', endOnExclusive: '2026-10-16' }, actor);
    assert.equal(next.advanceAppliedMinor, 300000);
    assert.equal(next.outstandingMinor, 700000);
    const sources = (await select(store, 'payroll_allocations')).filter(a => a.sourceType === 'expense').map(a => a.sourceId);
    assert.equal(new Set(sources).size, sources.length);
    await undoPayroll(store, next.id);
    await command(store, 'test-reverse-advance', tx => reverseAdvanceTx(tx, advance.id, { effectiveOn: '2026-10-15', reason: 'Anticipo no aplicado', actorId: actor }));
    assert.equal(await accountBalance(store, bank.id), 10000000);
    assert.equal(total((await select(store, 'expenses')).filter(e => e.category === 'salary')), 2000000);
  }],
  ['commission uses immutable seller rules, full payment thresholds and fixed retained-product proration', async store => {
    await configure(store, { enabled: true, mode: 'fixed', fixedMinor: 500, earnWhen: 'customer_paid' });
    const p = await person(store), bank = await account(store, p.id), sale = await order(store, p.id, { quantity: 3, price: 100, discountMinor: 1, shippingChargeMinor: 100 });
    await recordCollection(store, { requestId: request(), version: (await store.order(sale.id)).version, orderId: sale.id, holder: 'business', accountId: bank.id, amountMinor: 398, occurredOn: '2026-09-02', method: 'Transferencia', reference: 'partial' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 0);
    await recordCollection(store, { requestId: request(), version: (await store.order(sale.id)).version, orderId: sale.id, holder: 'business', accountId: bank.id, amountMinor: 1, occurredOn: '2026-09-03', method: 'Transferencia', reference: 'complete' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 500);
    await configure(store, { enabled: true, mode: 'percent', rateBps: 10000, earnWhen: 'customer_paid' });
    for (const [occurredOn, expected] of [['2026-10-01', 333], ['2026-10-02', 167], ['2026-10-03', 0]]) {
      const current = await store.order(sale.id);
      await registerReturn(store, { requestId: request(), orderId: sale.id, version: current.version, occurredOn, reason: 'Devolución parcial sintética', lines: [{ lineId: sale.items[0].lineId, quantity: 1, condition: 'recoverable' }] }, actor);
      await reconcile(store, sale.id);
      assert.equal(total(await select(store, 'commission_entries')), expected);
    }
    const facts = await select(store, 'order_returns', 'ORDER BY occurred_on');
    assert.deepEqual(facts.map(r => r.lines[0].salesCreditMinor), [100, 99, 100]);
    assert.equal((await reconcile(store, sale.id)).createdCount, 0);
    assert.equal(total(await select(store, 'expenses', "WHERE category='commission'")), 0);
  }],
  ['historical recognition corrections move or withdraw earned commission, leaving paid money untouched', async store => {
    await configure(store, { enabled: true, mode: 'percent', rateBps: 500, earnWhen: 'customer_paid' });
    const p = await person(store), bank = await account(store, p.id), sale = await order(store, p.id);
    await recordCollection(store, { requestId: request(), version: (await store.order(sale.id)).version, orderId: sale.id, holder: 'business', accountId: bank.id, amountMinor: 12200000, occurredOn: '2026-09-03', method: 'Transferencia', reference: 'paid' }, actor);
    await reconcile(store, sale.id);
    const payroll = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01' }, actor);
    await payPayroll(store, { requestId: request(), payrollId: payroll.id, version: payroll.version, amountMinor: 550000, accountId: bank.id, effectiveOn: '2026-09-30' }, actor);
    const cashBefore = await accountBalance(store, bank.id);
    await command(store, 'test-correction', async tx => { const current = await loadOrderData(tx, sale.id); await persistOrderData(tx, { ...current, recognition: { ...current.recognition, on: '2026-10-01' } }, { actorId: actor, reason: 'Corrección de fecha real' }); return reconcileCommissionsTx(tx, sale.id, { actorId: actor, reason: 'Corrección de fecha real' }); });
    let entries = await select(store, 'commission_entries');
    assert.equal(total(entries.filter(e => e.earnedOn < '2026-10-01')), 0);
    assert.equal(total(entries.filter(e => e.earnedOn === '2026-10-01')), 550000);
    await command(store, 'test-correction', async tx => { const current = await loadOrderData(tx, sale.id); await persistOrderData(tx, { ...current, recognition: null }, { actorId: actor, reason: 'La entrega no ocurrió' }); return reconcileCommissionsTx(tx, sale.id, { actorId: actor, reason: 'La entrega no ocurrió' }); });
    entries = await select(store, 'commission_entries');
    assert.equal(total(entries), 0);
    assert.equal(await accountBalance(store, bank.id), cashBefore);
    const credits = await select(store, 'expenses', 'WHERE amount_minor<0');
    assert.ok(credits.every(e => e.originalExpenseId));
    assert.ok((await expenseBalanceTx(store, credits[0].id)).creditMinor > 0);
  }],
  ['negative periods carry credit forward without reassigning the original expense or withdrawing cash', async store => {
    await configure(store, { enabled: true, mode: 'percent', rateBps: 500, earnWhen: 'customer_paid' });
    const p = await person(store), bank = await account(store, p.id), sale = await order(store, p.id);
    await recordCollection(store, { requestId: request(), version: (await store.order(sale.id)).version, orderId: sale.id, holder: 'business', accountId: bank.id, amountMinor: 12200000, occurredOn: '2026-09-03', method: 'Transferencia', reference: 'credit-carry-receipt' }, actor);
    let september = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-09-01', endOnExclusive: '2026-10-01' }, actor);
    september = await payPayroll(store, { requestId: request(), payrollId: september.id, version: september.version, amountMinor: 550000, accountId: bank.id, effectiveOn: '2026-09-30' }, actor);
    const current = await store.order(sale.id);
    await registerReturn(store, { requestId: request(), orderId: sale.id, version: current.version, occurredOn: '2026-10-02', reason: 'Crédito para período posterior', lines: [{ lineId: sale.items[0].lineId, quantity: 1, condition: 'recoverable' }] }, actor);
    const cashBefore = await accountBalance(store, bank.id);
    const creditPeriod = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-10-01', endOnExclusive: '2026-10-03' }, actor);
    assert.equal(creditPeriod.netMinor, -275000);
    assert.equal(creditPeriod.outstandingMinor, 0);
    assert.equal(await accountBalance(store, bank.id), cashBefore);
    const creditExpense = creditPeriod.obligations.find(e => e.amountMinor < 0);
    const next = await confirmPayroll(store, { requestId: request(), personId: p.id, startOn: '2026-10-03', endOnExclusive: '2026-10-16', bonusMinor: 1000000, reason: 'Remuneración nueva documentada' }, actor);
    assert.equal(next.outstandingMinor, 725000);
    assert.equal(next.obligations.some(e => e.id === creditExpense.id), false);
    assert.equal((await getPayroll(store, creditPeriod.id)).creditMinor, 0);
    const assigned = await select(store, 'payroll_allocations', "WHERE source_type='expense' AND source_id=?", [creditExpense.id]);
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].payrollId, creditPeriod.id);
    const paid = await payPayroll(store, { requestId: request(), payrollId: next.id, version: next.version, amountMinor: 725000, accountId: bank.id, effectiveOn: '2026-10-15' }, actor);
    await undoPayroll(store, paid.payrollPaymentId);
    assert.equal((await getPayroll(store, creditPeriod.id)).creditMinor, 275000);
    assert.equal(await accountBalance(store, bank.id), cashBefore);
  }],
  ['seller override snapshots require complete dated delivery and survive prospective rule edits', async store => {
    await configure(store, { enabled: true, mode: 'percent', rateBps: 500, earnWhen: 'delivered' }, 'delivered');
    const initial = await person(store);
    const p = await saveResource(store, 'people', { ...initial, requestId: request(), commissionOverrides: [{ id: 'seller-fixed', effectiveOn: '2026-08-01', enabled: true, mode: 'fixed', fixedMinor: 777, earnWhen: 'delivered' }] }, actor, initial.id);
    const sale = await order(store, p.id);
    let shipment = await createShipment(store, { requestId: request(), orderId: sale.id }, actor);
    shipment = await recordShipmentEvent(store, shipment.id, { requestId: request(), version: shipment.version, status: 'collected', occurredOn: '2026-09-02' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 0);
    shipment = await recordShipmentEvent(store, shipment.id, { requestId: request(), version: shipment.version, status: 'delivered', sourceAsOf: '2026-09-03T18:00:00Z' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 0);
    const unknownDelivery = shipment.events.find(e => e.status === 'delivered');
    shipment = await recordShipmentEvent(store, shipment.id, { requestId: request(), version: shipment.version, status: 'delivered', occurredOn: '2026-09-03', correctionOf: unknownDelivery.id, reason: 'Fecha real de entrega documentada' }, actor);
    await reconcile(store, sale.id);
    assert.equal(total(await select(store, 'commission_entries')), 777);
    await saveResource(store, 'people', { ...p, requestId: request(), commissionOverrides: [{ id: 'seller-new', effectiveOn: '2026-10-01', enabled: true, mode: 'fixed', fixedMinor: 900, earnWhen: 'delivered' }] }, actor, p.id);
    assert.equal((await reconcile(store, sale.id)).createdCount, 0);
    assert.equal(total(await select(store, 'commission_entries')), 777);
  }],
  ['unreviewed legacy money and unknown collection dates cannot earn commissions', async store => {
    await configure(store, { enabled: true, mode: 'percent', rateBps: 500, earnWhen: 'customer_paid' });
    const p = await person(store), sale = await order(store, p.id);
    await command(store, 'test-legacy', async tx => {
      await insertRow(tx, 'order_collections', { id: newId(), order_id: sale.id, shipment_id: null, kind: 'receipt', holder: 'legacy', amount_minor: sale.totalMinor, occurred_on: null, cash_entry_id: null, reversal_of: null, external_key: null, recorded_at: stamp(), data: JSON.stringify({ requiresReconciliation: true }) });
      return reconcileCommissionsTx(tx, sale.id, { actorId: actor });
    });
    assert.equal((await reconcile(store, sale.id)).blocked, true);
    assert.equal((await select(store, 'commission_entries')).length, 0);
    await assert.rejects(getPayroll(store, 'missing'), { status: 404 });
  }],
];

export async function runBusinessPayrollContracts(t, factory) {
  for (const [name, run] of businessPayrollContracts) await t.test(name, async () => {
    const store = await factory();
    try { await run(store); } finally { await store.close(); }
  });
}
test('Business payroll contracts on real SQLite', async t => runBusinessPayrollContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
