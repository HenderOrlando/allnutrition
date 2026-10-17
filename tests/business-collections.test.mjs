import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { getBusinessSettings, saveBusinessSettings, saveResource, listResources } from '../lib/business/settings.mjs';
import { saveAccount, accountBalance, closeCash, reopenCash, reverseCashEntry } from '../lib/business/cash.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { getOrder, loadOrderData, persistOrderData } from '../lib/business/orders.mjs';
import { insertRow, stamp, runCommand, entity } from '../lib/business/commands.mjs';
import { recordCollection, recordCollectionTx, recordRefund, registerReturn, resolveLegacyPayment, reverseCollectionTx } from '../lib/business/collections.mjs';

const actor = 'collections-contract-admin';
const requestId = () => randomUUID();
const sqliteFactory = () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
const moneyInput = (order, account, amountMinor, extra = {}) => ({ requestId: requestId(), orderId: order.id, version: order.version, holder: 'business', amountMinor, occurredOn: '2025-09-03', accountId: account.id, method: 'transfer', reference: 'Referencia explícita', ...extra });
const returnInput = (order, extra = {}) => ({ requestId: requestId(), orderId: order.id, version: order.version, occurredOn: '2025-10-02', reason: 'Devolución aprobada', lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'recoverable' }], shippingCreditMinor: 0, ...extra });
const reverse = (store, id, extra = {}) => runCommand(store, { scope: 'test:reverse-collection', requestId: requestId(), actorId: actor, payload: { id, ...extra } }, tx => reverseCollectionTx(tx, id, { effectiveOn: '2025-10-03', reason: 'Corrección documentada', actorId: actor, ...extra }));
async function fixture(store, { quantity = 2, unitPriceMinor = 5500000, discountMinor = 0, unitCostMinor = 2300000, shippingChargeMinor = 1200000, recognition = 'confirmed', commission = false, commissionEarnWhen = 'business_received', accountType = 'bank' } = {}) {
  const settings = await getBusinessSettings(store);
  await saveBusinessSettings(store, { ...settings, requestId: requestId(), rulesVersions: [{ id: 'historical-rule', effectiveOn: '2025-01-01', saleRecognition: recognition, commission: { enabled: commission, mode: 'percent', rateBps: 500, earnWhen: commissionEarnWhen } }] }, actor);
  const seller = await saveResource(store, 'people', { requestId: requestId(), name: 'Persona responsable' }, actor);
  const account = await saveAccount(store, { requestId: requestId(), name: 'Cuenta real de prueba', type: accountType, responsibleId: seller.id, openingOn: '2025-09-01', openingBalanceMinor: 10000000 }, actor);
  const product = await store.save('products', { title: 'Producto A', slug: 'producto-a', status: 'draft', orderable: true, price: 55000, presentation: 'Unidad', stockQuantity: 10000, unitCostMinor, costEffectiveOn: '2025-01-01' });
  const order = await store.saveOrder({ requestId: requestId(), customerName: 'Cliente sintético', phone: '3001234567', department: 'Bogotá', city: 'Bogotá', address: 'Dirección sintética', placedOn: '2025-09-01', sellerId: seller.id, status: 'new', deliveryMethod: 'carrier', shippingChargeMinor, items: [{ lineId: requestId(), kind: 'products', itemId: product.id, quantity, unitPriceMinor, discountMinor }] }, actor);
  return { order, account, seller, product };
}
async function platformShipment(store, order, name = 'Plataforma sintética') {
  const platform = await saveResource(store, 'platforms', { requestId: requestId(), name }, actor);
  const source = (await listResources(store, 'sources', { platform: platform.id }))[0];
  const shipment = await createShipment(store, { requestId: requestId(), orderId: order.id, platformId: platform.id, sourceId: source.id, carrier: 'Transportadora de prueba', tracking: requestId() }, actor);
  return { platform, source, shipment, order: await getOrder(store, order.id) };
}
async function legacyFixture(store, order, { ambiguous = false, amountMinor = 2000000, occurredOn = null } = {}) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const data = await loadOrderData(tx, order.id);
    await persistOrderData(tx, { ...data, legacyFinancialReview: { required: true, state: 'pending', reason: ambiguous ? 'ambiguous_refund' : 'legacy_payment_unreconciled', paymentStatus: ambiguous ? 'refunded' : 'partial', paymentAmount: amountMinor / 100 } }, { actorId: actor, reason: 'Fixture histórico convertido', source: 'legacy' });
    if (!ambiguous) await insertRow(tx, 'order_collections', { id: requestId(), order_id: order.id, shipment_id: null, kind: 'receipt', holder: 'legacy', amount_minor: amountMinor, occurred_on: occurredOn, cash_entry_id: null, reversal_of: null, external_key: `legacy:${order.id}:payment`, recorded_at: stamp(), data: JSON.stringify({ source: 'legacy', requiresReconciliation: true }) });
    return getOrder(tx, order.id);
  });
}
async function count(store, table) { return Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t(table)}`)).count); }

export const businessCollectionContracts = [
  ['cash collection derives partial/full payment without changing the sale and replays exactly', async store => {
    const { order, account } = await fixture(store);
    const input = moneyInput(order, account, 2000000);
    const first = await recordCollection(store, input, actor);
    assert.equal(first.order.paymentSummary.status, 'partial');
    assert.equal(first.order.paymentSummary.outstandingMinor, 10200000);
    assert.equal(first.order.totalMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 12000000);
    assert.deepEqual(await recordCollection(store, input, actor), first);
    assert.equal(await count(store, 'order_collections'), 1);
    await assert.rejects(recordCollection(store, { ...input, amountMinor: 1 }, actor), { status: 409 });
    await assert.rejects(recordCollection(store, { ...input, requestId: requestId() }, actor), { status: 409 });
    const complete = await recordCollection(store, moneyInput(first.order, account, 10200000), actor);
    assert.equal(complete.order.paymentSummary.status, 'paid');
    assert.equal(complete.order.paymentSummary.netCollectedMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 22200000);
    assert.ok(complete.cashEntryId);
  }],
  ['overcollection requires explicit credit and refunds cannot exceed effective net receipts', async store => {
    const { order, account } = await fixture(store);
    await assert.rejects(recordCollection(store, moneyInput(order, account, 12200001), actor), { status: 400 });
    let result = await recordCollection(store, moneyInput(order, account, 13000000, { allowCredit: true }), actor);
    assert.equal(result.order.paymentSummary.refundDueMinor, 800000);
    const refundInput = moneyInput(result.order, account, 800000, { reason: 'Devolución del saldo a favor' });
    result = await recordRefund(store, refundInput, actor);
    assert.equal(result.order.paymentSummary.netCollectedMinor, 12200000);
    assert.equal(result.order.paymentSummary.status, 'partially_refunded');
    assert.equal(result.order.paymentSummary.refundDueMinor, 0);
    await assert.rejects(recordRefund(store, moneyInput(result.order, account, 12200001, { reason: 'Exceso rechazado' }), actor), { status: 400 });
    result = await recordRefund(store, moneyInput(result.order, account, 12200000, { reason: 'Reembolso completo' }), actor);
    assert.equal(result.order.paymentSummary.status, 'refunded');
    assert.equal(result.order.paymentSummary.netCollectedMinor, 0);
    assert.equal(result.order.paymentSummary.outstandingMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 10000000);
  }],
  ['undated Excel platform observations earn no customer-paid commission until explicitly corrected with a real date', async store => {
    const base = await fixture(store, { commission: true, commissionEarnWhen: 'customer_paid' });
    const { platform, source, shipment, order } = await platformShipment(store, base.order);
    const input = moneyInput(order, base.account, 12200000, { holder: 'platform', accountId: null, platformId: platform.id, sourceId: source.id, shipmentId: shipment.id, externalKey: 'UN-DATED', source: 'excel', sourceAsOf: '2025-09-05T18:00:00.000Z', occurredOn: null });
    const observe = candidate => runCommand(store, { scope: 'test:excel-observation', requestId: candidate.requestId, payload: candidate, actorId: actor }, tx => recordCollectionTx(tx, candidate, actor, { allowUnknownDate: true }));
    await assert.rejects(recordCollection(store, { ...input, allowUnknownDate: true }, actor), { status: 400 });
    for (const invalid of [{ source: 'manual' }, { holder: 'business', accountId: base.account.id }, { sourceAsOf: null }]) await assert.rejects(observe({ ...input, ...invalid, requestId: requestId() }), { status: 400 });
    const received = await observe(input);
    assert.equal(received.occurredOn, null);
    assert.equal(received.requiresDateReview, true);
    assert.equal(received.order.paymentSummary.status, 'paid');
    assert.equal(received.order.paymentSummary.platformHeldMinor, 12200000);
    assert.equal(await accountBalance(store, base.account.id), 10000000);
    assert.equal(await count(store, 'commission_entries'), 0);
    const replay = await observe({ ...input, requestId: requestId(), sourceAsOf: '2025-09-06T18:00:00.000Z' });
    assert.equal(replay.id, received.id);
    assert.equal(await count(store, 'order_collections'), 1);
    assert.equal(await count(store, 'cash_entries'), 1);
    await assert.rejects(recordCollection(store, { ...input, requestId: requestId(), occurredOn: '2025-09-03' }, actor), { status: 409 });
    const reversed = await reverse(store, received.id, { effectiveOn: '2025-09-06' });
    await recordCollection(store, { ...input, requestId: requestId(), version: reversed.order.version, externalKey: 'DATED-CORRECTION', occurredOn: '2025-09-03', reference: `Rectificación de ${received.id}`, reason: 'Fecha real documentada tras revertir la observación' }, actor);
    const commissions = (await store.db.all(`SELECT * FROM ${store.t('commission_entries')}`)).map(entity);
    assert.deepEqual(commissions.map(row => ({ on: row.earnedOn, amountMinor: row.amountMinor })), [{ on: '2025-09-03', amountMinor: 550000 }]);
    assert.equal(await accountBalance(store, base.account.id), 10000000);
  }],
  ['platform receipts and refunds never fabricate bank movements and external source identities are stable', async store => {
    const base = await fixture(store);
    const { platform, source, shipment, order } = await platformShipment(store, base.order);
    const input = moneyInput(order, base.account, 12200000, { holder: 'platform', accountId: null, platformId: platform.id, sourceId: source.id, shipmentId: shipment.id, externalKey: '000ABC', source: 'excel', sourceAsOf: '2025-09-05T18:00:00.000Z' });
    const received = await recordCollection(store, input, actor);
    assert.equal(received.externalId, '000ABC');
    assert.equal(received.cashEntryId, null);
    assert.equal(received.order.paymentSummary.status, 'paid');
    assert.equal(received.order.paymentSummary.platformHeldMinor, 12200000);
    assert.equal(await accountBalance(store, base.account.id), 10000000);
    const replay = await recordCollection(store, { ...input, requestId: requestId() }, actor);
    assert.equal(replay.id, received.id);
    assert.equal((await recordCollection(store, { ...input, requestId: requestId(), sourceAsOf: '2025-09-06T18:00:00.000Z' }, actor)).id, received.id);
    assert.equal(await count(store, 'cash_entries'), 1);
    await assert.rejects(recordCollection(store, { ...input, requestId: requestId(), amountMinor: 1 }, actor), { status: 409 });
    await assert.rejects(recordCollection(store, { ...input, requestId: requestId(), shipmentId: null, externalKey: 'other' }, actor), { status: 400 });
    await assert.rejects(recordCollection(store, { ...input, requestId: requestId(), accountId: base.account.id }, actor), { status: 400 });
    const refunded = await recordRefund(store, { ...input, requestId: requestId(), version: received.order.version, externalKey: 'refund-000ABC', amountMinor: 1000000, reason: 'Reembolso retenido por plataforma' }, actor);
    assert.equal(refunded.cashEntryId, null);
    assert.equal(refunded.order.paymentSummary.platformHeldMinor, 11200000);
    assert.equal(await accountBalance(store, base.account.id), 10000000);
    const otherOrder = await store.saveOrder({ ...base.order, requestId: requestId() }, actor);
    const otherSource = await saveResource(store, 'sources', { requestId: requestId(), platformId: platform.id, name: 'Segunda cuenta de la misma plataforma' }, actor);
    const otherShipment = await createShipment(store, { requestId: requestId(), orderId: otherOrder.id, platformId: platform.id, sourceId: otherSource.id, carrier: 'Transportadora de prueba', tracking: requestId() }, actor);
    const other = { source: otherSource, platform, shipment: otherShipment, order: await getOrder(store, otherOrder.id) };
    const distinct = await recordCollection(store, { ...input, requestId: requestId(), orderId: other.order.id, version: other.order.version, shipmentId: other.shipment.id, sourceId: other.source.id, platformId: other.platform.id, amountMinor: 1000000 }, actor);
    assert.notEqual(distinct.id, received.id);
    assert.equal(distinct.externalId, '000ABC');
  }],
  ['validates exact cents, known dates, account, method and reference before recording money', async store => {
    const { order, account } = await fixture(store);
    for (const patch of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.2 }, { amountMinor: 10000000000001 }, { occurredOn: null }, { occurredOn: '2025-02-30' }, { occurredOn: '9999-01-01' }, { accountId: null }, { method: '' }, { reference: '' }, { holder: 'legacy' }]) await assert.rejects(recordCollection(store, moneyInput(order, account, 100, patch), actor), { status: 400 });
    assert.equal(await count(store, 'order_collections'), 0);
    assert.equal(await count(store, 'cash_entries'), 1);
  }],
  ['cumulative return rounding credits 100,99,100, caps quantity and shipping separately', async store => {
    const { order } = await fixture(store, { quantity: 3, unitPriceMinor: 100, discountMinor: 1, unitCostMinor: 23, shippingChargeMinor: 7 });
    let current = order;
    const credits = [];
    for (let index = 0; index < 3; index++) {
      const result = await registerReturn(store, returnInput(current, { shippingCreditMinor: index === 0 ? 7 : 0 }), actor);
      credits.push(result.lines[0].salesCreditMinor);
      assert.equal(result.lines[0].recoveredCostMinor, 23);
      current = result.order;
      assert.equal(current.status === 'returned', index === 2);
    }
    assert.deepEqual(credits, [100, 99, 100]);
    assert.equal(current.paymentSummary.commercialDueMinor, 0);
    assert.equal(current.paymentSummary.status, 'not_required');
    assert.equal(current.shipments.length, 0);
    assert.equal(await count(store, 'shipment_events'), 0);
    await assert.rejects(registerReturn(store, returnInput(current), actor), { status: 400 });
    await assert.rejects(registerReturn(store, returnInput(order), actor), { status: 409 });
  }],
  ['return alone creates no refund or cash and shipping credit cannot be reused', async store => {
    const { order, account } = await fixture(store);
    const paid = await recordCollection(store, moneyInput(order, account, 12200000), actor);
    const returned = await registerReturn(store, returnInput(paid.order, { shippingCreditMinor: 1200000 }), actor);
    assert.equal(returned.lines[0].salesCreditMinor, 5500000);
    assert.equal(returned.lines[0].recoveredCostMinor, 2300000);
    assert.equal(returned.order.paymentSummary.refundDueMinor, 6700000);
    assert.equal(returned.order.paymentSummary.netCollectedMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 22200000);
    assert.equal(await count(store, 'order_collections'), 1);
    await assert.rejects(registerReturn(store, returnInput(returned.order, { shippingCreditMinor: 1 }), actor), { status: 400 });
    const refund = await recordRefund(store, moneyInput(returned.order, account, 6700000, { occurredOn: '2025-10-03', reason: 'Reembolso aprobado' }), actor);
    assert.equal(refund.order.paymentSummary.commercialDueMinor, 5500000);
    assert.equal(refund.order.paymentSummary.netCollectedMinor, 5500000);
    assert.equal(refund.order.returns.length, 1);
  }],
  ['unknown and zero recovery costs stay distinct and pre-recognition losses use actual return date', async store => {
    const { order } = await fixture(store, { recognition: 'delivered', unitCostMinor: null });
    const returned = await registerReturn(store, returnInput(order), actor);
    assert.equal(returned.lines[0].recoveredCostMinor, null);
    assert.equal(returned.lines[0].recognizedCostQuantity, 0);
    assert.equal(returned.lines[0].unrecognizedCostQuantity, 1);
    assert.equal(returned.order.financialSummary.complete, false);
    const discarded = await registerReturn(store, returnInput(returned.order, { lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'non_recoverable' }] }), actor);
    assert.equal(discarded.lines[0].recoveredCostMinor, 0);
    assert.equal(discarded.order.status, 'returned');
    assert.equal(await count(store, 'expenses'), 0);
  }],
  ['explicit zero cost remains known and invalid return lines never mutate the agreement', async store => {
    const { order } = await fixture(store, { unitCostMinor: 0 });
    const lineId = order.items[0].lineId;
    for (const lines of [
      [{ lineId, quantity: 0, condition: 'recoverable' }],
      [{ lineId, quantity: 3, condition: 'recoverable' }],
      [{ lineId, quantity: 1, condition: 'unknown' }],
      [{ lineId: 'foreign-line', quantity: 1, condition: 'recoverable' }],
      [{ lineId, quantity: 1, condition: 'recoverable' }, { lineId, quantity: 1, condition: 'recoverable' }],
    ]) await assert.rejects(registerReturn(store, returnInput(order, { lines }), actor), { status: 400 });
    assert.equal(await count(store, 'order_returns'), 0);
    const result = await registerReturn(store, returnInput(order), actor);
    assert.equal(result.lines[0].recoveredCostMinor, 0);
    assert.equal(result.order.financialSummary.costOfGoodsMinor, 0);
    assert.equal(await count(store, 'cash_entries'), 1);
  }],
  ['non-recoverable return before recognition creates only loss expense, without fake negative COGS', async store => {
    const { order } = await fixture(store, { recognition: 'delivered' });
    const result = await registerReturn(store, returnInput(order, { lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'non_recoverable' }] }), actor);
    const expense = entity(await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE source_key=?`, [`return-loss:${result.id}:${order.items[0].lineId}`]));
    assert.equal(expense.amountMinor, 2300000);
    assert.equal(expense.incurredOn, '2025-10-02');
    assert.equal(result.lines[0].recognizedCostQuantity, 0);
    assert.equal(result.lines[0].recoveredCostMinor, 0);
    assert.equal(await count(store, 'expense_payments'), 0);
    assert.equal(await count(store, 'cash_entries'), 1);
  }],
  ['a returned logistics event is not an approved commercial return', async store => {
    const { order } = await fixture(store);
    let shipment = await createShipment(store, { requestId: requestId(), orderId: order.id, carrier: 'Transportadora', tracking: '0000123456789' }, actor);
    shipment = await recordShipmentEvent(store, shipment.id, { requestId: requestId(), version: shipment.version, status: 'returned', occurredOn: '2025-10-02' }, actor);
    const current = await getOrder(store, order.id);
    assert.equal(current.returns.length, 0);
    assert.equal(current.paymentSummary.commercialDueMinor, 12200000);
    assert.notEqual(current.status, 'returned');
    assert.equal(current.shipments[0].status, 'returned');
  }],
  ['legacy included in opening balance reconciles append-only without duplicate cash or invented dates', async store => {
    const { order, account } = await fixture(store);
    const legacy = await legacyFixture(store, order);
    assert.equal(legacy.paymentSummary.status, 'legacy_review');
    await assert.rejects(recordCollection(store, moneyInput(legacy, account, 100), actor), { status: 409 });
    await assert.rejects(resolveLegacyPayment(store, { requestId: requestId(), orderId: legacy.id, version: legacy.version, mode: 'opening_balance', accountId: account.id, reason: 'No duplicar apertura' }, actor), { status: 400 });
    const input = { requestId: requestId(), orderId: legacy.id, version: legacy.version, mode: 'opening_balance', reason: 'Ya incluido en apertura verificada' };
    const result = await resolveLegacyPayment(store, input, actor);
    assert.equal(result.order.paymentSummary.status, 'partial');
    assert.equal(result.order.paymentSummary.netCollectedMinor, 2000000);
    assert.equal(result.order.paymentSummary.legacyReview, false);
    assert.equal(result.documents[0].occurredOn, null);
    assert.equal(result.documents[0].cashEntryId, null);
    assert.equal(result.order.collections.length, 3);
    assert.equal(await accountBalance(store, account.id), 10000000);
    assert.equal(await count(store, 'cash_entries'), 1);
    assert.deepEqual(await resolveLegacyPayment(store, input, actor), result);
    assert.ok(await store.db.get(`SELECT id FROM ${store.t('business_audit')} WHERE entity_type='legacy_payment_resolution' AND entity_id=?`, [order.id]));
  }],
  ['reviewing a fully paid legacy opening balance with no occurrence date never earns commission automatically', async store => {
    const { order, account } = await fixture(store, { commission: true });
    const legacy = await legacyFixture(store, order, { amountMinor: 12200000 });
    const resolved = await resolveLegacyPayment(store, { requestId: requestId(), orderId: legacy.id, version: legacy.version, mode: 'opening_balance', reason: 'Saldo confirmado, fecha todavía desconocida' }, actor);
    assert.equal(resolved.order.paymentSummary.status, 'paid');
    assert.equal(resolved.documents[0].occurredOn, null);
    assert.equal(await count(store, 'commission_entries'), 0);
    assert.equal(await accountBalance(store, account.id), 10000000);
  }],
  ['legacy real cash reconciliation requires explicit movement and preserves the amount exactly once', async store => {
    const { order, account } = await fixture(store);
    const legacy = await legacyFixture(store, order, { occurredOn: '2025-09-03' });
    const input = { requestId: requestId(), orderId: legacy.id, version: legacy.version, mode: 'cash_movement', accountId: account.id, method: 'cash', reference: 'Comprobante real', reason: 'Ingreso real confirmado' };
    await assert.rejects(resolveLegacyPayment(store, input, actor), { status: 400 });
    const result = await resolveLegacyPayment(store, { ...input, requestId: requestId(), occurredOn: '2025-09-04' }, actor);
    assert.equal(result.order.paymentSummary.netCollectedMinor, 2000000);
    assert.equal(result.documents[0].occurredOn, '2025-09-04');
    assert.ok(result.documents[0].cashEntryId);
    assert.equal(await accountBalance(store, account.id), 12000000);
    await assert.rejects(resolveLegacyPayment(store, { ...input, requestId: requestId(), version: result.order.version, occurredOn: '2025-09-04' }, actor), { status: 409 });
  }],
  ['ambiguous historical refund needs explicit receipt and refund facts, never infers a refund from status', async store => {
    const { order, account } = await fixture(store);
    const legacy = await legacyFixture(store, order, { ambiguous: true });
    const input = { requestId: requestId(), orderId: legacy.id, version: legacy.version, mode: 'opening_balance', reason: 'Documentos históricos revisados' };
    await assert.rejects(resolveLegacyPayment(store, input, actor), { status: 400 });
    assert.equal(await count(store, 'order_collections'), 0);
    const result = await resolveLegacyPayment(store, { ...input, requestId: requestId(), receiptAmountMinor: 12200000, refundAmountMinor: 5500000, receiptOn: '2025-09-03', refundOn: '2025-10-02' }, actor);
    assert.equal(result.order.paymentSummary.netCollectedMinor, 6700000);
    assert.equal(result.order.paymentSummary.status, 'partially_refunded');
    assert.deepEqual(result.documents.map(row => row.kind), ['receipt', 'refund']);
    assert.equal(await accountBalance(store, account.id), 10000000);
    assert.equal(await count(store, 'cash_entries'), 1);
  }],
  ['reversals protect refund dependencies, append opposite facts, and never reverse just commercial cash', async store => {
    const { order, account } = await fixture(store);
    const receipt = await recordCollection(store, moneyInput(order, account, 12200000), actor);
    const refund = await recordRefund(store, moneyInput(receipt.order, account, 2000000, { reason: 'Reembolso parcial' }), actor);
    await assert.rejects(reverse(store, receipt.id), { status: 409 });
    await assert.rejects(reverseCashEntry(store, { requestId: requestId(), cashEntryId: receipt.cashEntryId, effectiveOn: '2025-10-03', reason: 'No aislar caja' }, actor), { status: 409 });
    const reversedRefund = await reverse(store, refund.id);
    assert.equal(reversedRefund.reversalOf, refund.id);
    assert.equal(reversedRefund.order.paymentSummary.netCollectedMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 22200000);
    const reversedReceipt = await reverse(store, receipt.id);
    assert.equal(reversedReceipt.order.paymentSummary.netCollectedMinor, 0);
    assert.equal(reversedReceipt.order.totalMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 10000000);
    assert.equal(await count(store, 'order_collections'), 4);
    await assert.rejects(reverse(store, receipt.id), { status: 409 });
    await assert.rejects(reverse(store, reversedReceipt.id), { status: 409 });
  }],
  ['failed cash reversal is atomic and can be retried only after reopening the close', async store => {
    const { order, account } = await fixture(store, { accountType: 'cash' });
    const receipt = await recordCollection(store, moneyInput(order, account, 2000000), actor);
    const closing = await closeCash(store, { requestId: requestId(), accountId: account.id, closingOn: '2025-10-03', countedMinor: 12000000 }, actor);
    const collectionsBefore = await count(store, 'order_collections'), cashBefore = await count(store, 'cash_entries');
    await assert.rejects(reverse(store, receipt.id), { status: 409 });
    assert.equal(await count(store, 'order_collections'), collectionsBefore);
    assert.equal(await count(store, 'cash_entries'), cashBefore);
    assert.equal((await getOrder(store, order.id)).version, receipt.order.version);
    await reopenCash(store, { requestId: requestId(), closingId: closing.id, version: closing.version, reason: 'Permitir la corrección aprobada' }, actor);
    const result = await reverse(store, receipt.id);
    assert.equal(result.order.paymentSummary.netCollectedMinor, 0);
    assert.equal(await accountBalance(store, account.id), 10000000);
  }],
  ['confirmed platform settlement blocks collection reversal until its receipt is reversed', async store => {
    const { saveSettlement, confirmSettlement, reverseSettlementReceiptTx } = await import('../lib/business/settlements.mjs');
    const base = await fixture(store);
    const { source, shipment, order } = await platformShipment(store, base.order);
    const collection = await recordCollection(store, moneyInput(order, base.account, 12200000, { holder: 'platform', accountId: null, sourceId: source.id, shipmentId: shipment.id }), actor);
    const lines = [{ collectionId: collection.id, grossMinor: 12200000, deductions: [] }];
    const settlement = await saveSettlement(store, { requestId: requestId(), sourceId: source.id, reportedOn: '2025-09-05', netMinor: 12200000, lines }, actor);
    const { receipt } = await confirmSettlement(store, { requestId: requestId(), settlementId: settlement.id, version: settlement.version, receivedOn: '2025-09-05', accountId: base.account.id, lines }, actor);
    const countBefore = await count(store, 'order_collections');
    await assert.rejects(reverse(store, collection.id), { status: 409 });
    assert.equal(await count(store, 'order_collections'), countBefore);
    const latest = await getOrder(store, order.id);
    await assert.rejects(recordRefund(store, moneyInput(latest, base.account, 1, { holder: 'platform', accountId: null, sourceId: source.id, shipmentId: shipment.id, reason: 'Fondos ya liquidados' }), actor), { status: 409 });
    await runCommand(store, { scope: 'test:reverse-settlement', requestId: requestId(), actorId: actor, payload: { id: receipt.id } }, tx => reverseSettlementReceiptTx(tx, receipt.id, { effectiveOn: '2025-10-03', reason: 'Deshacer dependencia', actorId: actor }));
    const reversed = await reverse(store, collection.id);
    assert.equal(reversed.order.paymentSummary.netCollectedMinor, 0);
    assert.equal(await accountBalance(store, base.account.id), 10000000);
  }],
  ['actual return date generates commission credit without moving cash', async store => {
    const { order, account } = await fixture(store, { commission: true });
    const paid = await recordCollection(store, moneyInput(order, account, 12200000), actor);
    const original = (await store.db.all(`SELECT * FROM ${store.t('commission_entries')} WHERE order_id=?`, [order.id])).map(entity);
    assert.equal(original.reduce((sum, row) => sum + row.amountMinor, 0), 550000);
    const returned = await registerReturn(store, returnInput(paid.order), actor);
    const entries = (await store.db.all(`SELECT * FROM ${store.t('commission_entries')} WHERE order_id=?`, [order.id])).map(entity);
    const credit = entries.find(row => row.amountMinor < 0);
    assert.equal(credit.amountMinor, -275000);
    assert.equal(credit.earnedOn, '2025-10-02');
    const expense = entity(await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE id=?`, [credit.expenseId]));
    assert.equal(expense.incurredOn, '2025-10-02');
    assert.equal(returned.order.paymentSummary.netCollectedMinor, 12200000);
    assert.equal(await accountBalance(store, account.id), 22200000);
  }],
  ['transaction variant participates in caller rollback with all monetary facts and audit', async store => {
    const { order, account } = await fixture(store);
    const auditBefore = await count(store, 'business_audit');
    await assert.rejects(store.transaction(async tx => {
      await tx.lockWrites();
      await recordCollectionTx(tx, moneyInput(order, account, 2000000), actor);
      throw new Error('Abort the whole imported group');
    }), /Abort the whole imported group/);
    assert.equal(await count(store, 'order_collections'), 0);
    assert.equal(await count(store, 'cash_entries'), 1);
    assert.equal(await count(store, 'business_audit'), auditBefore);
    assert.equal((await getOrder(store, order.id)).version, order.version);
  }],
];
export async function runBusinessCollectionContracts(t, factory) {
  for (const [name, run] of businessCollectionContracts) await t.test(name, async () => {
    const store = await factory();
    try { await run(store); } finally { await store.close(); }
  });
}
test('Business collection/return contracts on real SQLite', async t => runBusinessCollectionContracts(t, sqliteFactory));
