import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { saveSocialLink, getSocialBusinessResult, getSocialCampaignLinks } from '../lib/business/social-links.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { recordExpense, payExpense, reverseExpensePaymentTx } from '../lib/business/expenses.mjs';
import { recordCollection, recordRefund, registerReturn } from '../lib/business/collections.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { createBusinessBasics, businessOrderInput } from './business-fixtures.mjs';

const START = '2026-09-01T05:00:00.000Z', CUT = '2026-11-01T23:00:00.000Z';
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: START, updated_at: START });
const id = () => randomUUID();
const read = async (store, table, key) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [key]));
async function patch(store, table, key, changes) {
  const row = await read(store, table, key);
  const data = JSON.parse((await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [key])).data);
  await store.db.run(`UPDATE ${store.t(table)} SET data=? WHERE id=?`, [JSON.stringify({ ...data, ...changes }), row.id]);
}
async function commercialFingerprint(store) {
  const rows = {};
  for (const table of ['orders', 'expenses', 'expense_payments', 'cash_entries', 'order_returns', 'order_collections', 'counters']) rows[table] = await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`);
  return hash(JSON.stringify(rows));
}
async function setup(store, { currency = 'COP', method = 'api', mode = 'paid' } = {}) {
  const actorId = id(), connectionId = id(), assetId = id(), campaignId = id(), deliveryId = id();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  const basics = await createBusinessBasics(store, { year: 2026, actorId, reportsStartOn: '2026-09-01' });
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: method, state: 'connected', ...editable({ currency, identities: { businessId: 'synthetic-business', adAccountId: '505' } }) });
  await insertRow(store, 'social_assets', { id: assetId, state: 'archived', sha256: hash('synthetic-not-a-media-operation'), bytes: 0, ...editable({ kind: 'image' }) });
  const spec = { mode, integrationMethod: method, currency, timeZone: 'America/Bogota', startAt: START, endAt: '2026-09-10T05:00:00.000Z', budgetMinor: 20000000, objective: 'traffic' };
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connectionId, asset_id: assetId, name: 'Campaña financiera explícitamente sintética', mode, objective: 'traffic', state: 'completed', ...editable(spec) });
  await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash(spec), approved_at: START, actor_id: actorId, data: JSON.stringify({ spec }) });
  await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: campaignId, revision: 1, channel: mode === 'paid' ? 'meta_ads' : 'facebook', state: 'completed', remote_id: '600', next_sync_at: null, ...editable({ integrationMethod: method, activatedAt: START, remoteRefs: { campaignId: '600', adId: '601' } }) });
  const f = { store, ...basics, actorId, campaignId, deliveryId, spec };
  f.link = (kind, recordId, extra = {}) => saveSocialLink(store, { kind, recordId, campaignId, version: 0, requestId: id(), reason: 'Origen declarado de ensayo sintético', ...extra }, actorId);
  f.result = (asOf = CUT) => getSocialBusinessResult(store, campaignId, { asOf });
  f.spend = async ({ value = 10000000, complete = true, precision = 'exact', method: source = method, dimension = 'aggregate', scope = 'paid', fetchedAt = CUT, periodEnd = fetchedAt, window = 'cumulative', currency: metricCurrency = currency, ...extra } = {}) => {
    const measurementId = id();
    const data = { integrationMethod: source, adapterVersion: source === 'api' ? 'meta-api-v1' : 'meta-ui-v2', apiVersion: source === 'api' ? 'v26.0' : null, definitionVersion: `${source}-synthetic-finance-v1`, dimension, scope, currency: metricCurrency, timeZone: 'America/Bogota', query: { periodStart: '2026-09-01', periodEnd: periodEnd.slice(0, 10), windowStart: START, windowEnd: periodEnd, dimension, scope, window, timeZone: 'America/Bogota', periodType: 'range' }, periodStart: START, periodEnd, attributionSetting: 'synthetic-window', actionReportTime: 'impression', entity: { type: 'ad', id: '601' }, coverage: { complete, rowCount: 1, reason: complete ? null : 'synthetic_missing_rows' }, values: { spendMinor: { value, unit: 'minor_currency', sourceMetric: source === 'api' ? 'spend' : 'Importe gastado · sintético', status: 'reported', precision, displayValue: String(value), reason: null } }, ...extra };
    await insertRow(store, 'social_measurements', { id: measurementId, delivery_id: deliveryId, query_key: hash(data.query), fetched_at: fetchedAt, payload_hash: hash(data), data: JSON.stringify(data) });
    return measurementId;
  };
  f.order = async ({ recognized = true, quantity = 5, price = 10000000 } = {}) => {
    const order = await store.saveOrder(businessOrderInput(f.a, { year: 2026, shippingChargeMinor: 0, marketingCampaign: 'Etiqueta histórica no atribuida', items: [{ lineId: id(), kind: 'products', itemId: f.a.id, quantity, unitPriceMinor: price, discountMinor: 0 }] }), actorId);
    if (recognized) {
      let shipment = await createShipment(store, { requestId: id(), orderId: order.id, carrier: 'Transportadora sintética', tracking: id() }, actorId);
      shipment = await recordShipmentEvent(store, shipment.id, { requestId: id(), version: shipment.version, status: 'collected', occurredOn: '2026-09-02' }, actorId);
      shipment = await recordShipmentEvent(store, shipment.id, { requestId: id(), version: shipment.version, status: 'delivered', occurredOn: '2026-09-03' }, actorId);
      await recordExpense(store, { requestId: id(), category: 'shipping_out', amountMinor: 0, incurredOn: '2026-09-02', shipmentId: shipment.id, orderId: order.id, concept: 'Flete sintético explícitamente cero' }, actorId);
    }
    return store.order(order.id);
  };
  return f;
}

const cases = [
  ['desvincular en ámbito público conserva replay incluso tras volver a vincular y no borra la generación nueva', async store => {
    const f = await setup(store), order = await f.order({ recognized: false }), other = id();
    await f.link('order', order.id);
    const input = { kind: 'order', recordId: order.id, campaignId: null, version: 1, requestId: id(), reason: 'Retirar origen declarado de ensayo' };
    await assert.rejects(() => saveSocialLink(store, input, f.actorId, { scopeCampaignId: other }), { status: 409 });
    const options = { scopeCampaignId: f.campaignId }, removed = await saveSocialLink(store, input, f.actorId, options);
    const restored = await f.link('order', order.id); assert.equal(restored.version, 2);
    assert.deepEqual(await saveSocialLink(store, input, f.actorId, options), removed);
    const current = await getSocialCampaignLinks(store, f.campaignId);
    assert.equal(current.orders.find(value => value.id === order.id).link.version, 2);
    await assert.rejects(() => saveSocialLink(store, input, f.actorId, { scopeCampaignId: other }), { status: 409 });
  }],
  ['candidatos buscan número/etiqueta o concepto literal, sólo publicidad y sin campos de clientes', async store => {
    const f = await setup(store), order = await f.order({ recognized: false });
    await f.link('order', order.id);
    const ad = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 10000, incurredOn: '2026-09-04', concept: 'Ensayo 100% local', campaign: 'Etiqueta histórica de búsqueda' }, f.actorId);
    await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 20000, incurredOn: '2026-09-04', concept: 'Ensayo 1000 local' }, f.actorId);
    await recordExpense(store, { requestId: id(), category: 'operating', amountMinor: 10000, incurredOn: '2026-09-04', concept: 'Ensayo 100% local' }, f.actorId);
    const expenses = await getSocialCampaignLinks(store, f.campaignId, { kind: 'expense', q: '100%', page: 1 });
    assert.deepEqual(expenses.candidates.items.map(value => value.recordId), [ad.id]);
    const orders = await getSocialCampaignLinks(store, f.campaignId, { kind: 'order', q: String(order.number), page: 1 });
    const candidate = orders.candidates.items.find(value => value.recordId === order.id);
    assert.equal(candidate.link.campaignId, f.campaignId); assert.equal(candidate.link.version, 1);
    for (const key of ['data', 'customer', 'phone', 'address', 'items']) assert.equal(Object.hasOwn(candidate, key), false);
    await assert.rejects(() => getSocialCampaignLinks(store, f.campaignId, { kind: '__proto__' }), { status: 400 });
  }],
  ['vincular y repetir no altera documentos, etiquetas, pagos, caja ni revisión comercial', async store => {
    const f = await setup(store), order = await f.order();
    const expense = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 7000000, incurredOn: '2026-09-04', concept: 'Publicidad registrada sintética', campaign: 'Etiqueta de gasto conservada' }, f.actorId);
    const before = await commercialFingerprint(store), requestId = id();
    const input = { kind: 'order', recordId: order.id, campaignId: f.campaignId, version: 0, requestId, reason: 'Declaración explícita sintética' };
    const [first, replay] = await Promise.all([saveSocialLink(store, input, f.actorId), saveSocialLink(store, input, f.actorId)]);
    assert.deepEqual(first, replay); assert.equal(first.version, 1);
    await f.link('expense', expense.id);
    assert.equal(await commercialFingerprint(store), before);
    const result = await f.result();
    assert.equal(result.orders[0].marketingCampaign, 'Etiqueta histórica no atribuida');
    assert.equal(result.expenses[0].campaign, 'Etiqueta de gasto conservada');
    assert.equal(result.registeredAdvertising.valueMinor, 7000000); assert.equal(result.advertisingPayments.valueMinor, 0);
    const audit = await store.db.all(`SELECT * FROM ${store.t('business_audit')} WHERE entity_type='social_order_link' AND entity_id=?`, [order.id]);
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, f.actorId);
    assert.equal(JSON.parse(audit[0].data).reason, input.reason);
    const job = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:analysis:${f.campaignId}`]);
    assert.equal(job.state, 'queued'); assert.equal(JSON.parse(job.data).generation, 2);
  }],
  ['versiones y acciones explícitas cambian una asociación única, retiran el vínculo y recalculan ambas campañas', async store => {
    const f = await setup(store), order = await f.order(), other = id();
    await insertRow(store, 'social_campaigns', { id: other, connection_id: null, asset_id: null, name: 'Segundo borrador sintético', mode: 'organic', objective: 'reach', state: 'draft', ...editable({}) });
    await f.link('order', order.id);
    await assert.rejects(() => f.link('order', order.id, { campaignId: other }), { status: 409 });
    await assert.rejects(() => f.link('order', order.id, { campaignId: other, version: 1, reason: ' ' }), { status: 400 });
    const moved = await f.link('order', order.id, { campaignId: other, version: 1, reason: 'Cambiar vínculo después de revisar el origen' });
    assert.equal(moved.version, 2); assert.equal(moved.previousCampaignId, f.campaignId);
    assert.equal((await f.result()).orders.length, 0);
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('social_order_links')} WHERE order_id=?`, [order.id])).length, 1);
    const removed = await f.link('order', order.id, { campaignId: null, version: 2 });
    assert.equal(removed.version, 0); assert.equal(removed.link, null);
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('social_order_links')} WHERE order_id=?`, [order.id])).length, 0);
    const relinked = await f.link('order', order.id);
    assert.equal(relinked.version, 3);
    await assert.rejects(() => f.link('order', order.id, { version: 1, campaignId: other }), { status: 409 });
    await assert.rejects(() => f.link('order', order.id, { version: 2, campaignId: null }), { status: 409 });
    const jobs = await store.db.all(`SELECT key FROM ${store.t('job_runs')} WHERE key IN (?,?)`, [`social:analysis:${other}`, `social:analysis:${f.campaignId}`]);
    assert.equal(jobs.length, 2);
  }],
  ['actor inactivo tampoco reproduce solicitudes y referencias/categoría/motivo se validan sin efectos', async store => {
    const f = await setup(store), order = await f.order(), requestId = id();
    const input = { kind: 'order', recordId: order.id, campaignId: f.campaignId, version: 0, requestId, reason: 'Declaración sintética válida' };
    await saveSocialLink(store, input, f.actorId);
    await assert.rejects(() => saveSocialLink(store, { ...input, reason: 'Payload cambiado' }, f.actorId), { status: 409 });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => saveSocialLink(store, input, f.actorId), { status: 403 });
    await store.db.run(`UPDATE ${store.t('users')} SET active=1 WHERE id=?`, [f.actorId]);
    const before = await commercialFingerprint(store);
    await assert.rejects(() => f.link('order', id()), { status: 404 });
    await assert.rejects(() => f.link('order', order.id, { campaignId: id(), version: 1 }), { status: 404 });
    const expense = await recordExpense(store, { requestId: id(), category: 'operating', amountMinor: 100, incurredOn: '2026-09-04' }, f.actorId);
    await assert.rejects(() => f.link('expense', expense.id), { status: 400 });
    await assert.rejects(() => f.link('__proto__', order.id), { status: 400 });
    await assert.rejects(() => f.link('order', order.id, { version: -1 }), { status: 400 });
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('social_order_links')} WHERE order_id=?`, [order.id])).length, 1);
    assert.notEqual(await commercialFingerprint(store), before); // Only the explicitly recorded operating expense changed commerce.
  }],
  ['dos solicitudes distintas compiten por versión sin duplicar y un job activo conserva su lease', async store => {
    const f = await setup(store), order = await f.order();
    const results = await Promise.allSettled([f.link('order', order.id), f.link('order', order.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    const lease = await claimJob(store, { key: `social:analysis:${f.campaignId}` });
    await f.link('order', order.id, { version: 1, reason: 'Rectificación declarada durante el análisis' });
    const job = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [lease.key]);
    assert.equal(job.state, 'running'); assert.equal(job.lease_token, lease.token);
    assert.equal(JSON.parse(job.data).generation, 2);
  }],
  ['ventas reconocidas menos devolución posterior, cobros y cuatro magnitudes independientes al corte', async store => {
    const f = await setup(store), order = await f.order();
    await recordCollection(store, { requestId: id(), orderId: order.id, version: order.version, holder: 'business', accountId: f.account.id, occurredOn: '2026-09-04', amountMinor: 50000000, method: 'Transferencia sintética', reference: 'COL-SYNTHETIC' }, f.actorId);
    await registerReturn(store, { requestId: id(), orderId: order.id, version: (await store.order(order.id)).version, occurredOn: '2026-10-02', reason: 'Devolución sintética posterior al fin de pauta', shippingCreditMinor: 0, lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'recoverable' }] }, f.actorId);
    await recordRefund(store, { requestId: id(), orderId: order.id, version: (await store.order(order.id)).version, holder: 'business', accountId: f.account.id, occurredOn: '2026-10-03', amountMinor: 10000000, method: 'Transferencia sintética', reference: 'REF-SYNTHETIC', reason: 'Reembolso sintético del crédito comercial' }, f.actorId);
    const expense = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 7000000, incurredOn: '2026-09-04', concept: 'Gasto sintético independiente de Meta' }, f.actorId);
    await payExpense(store, { requestId: id(), expenseId: expense.id, version: expense.version, amountMinor: 3000000, accountId: f.account.id, effectiveOn: '2026-10-04' }, f.actorId);
    await f.link('order', order.id); await f.link('expense', expense.id); await f.spend();
    const fingerprint = await commercialFingerprint(store), result = await f.result();
    assert.equal(result.recognizedProductSales.valueMinor, 40000000); assert.equal(result.collections.valueMinor, 40000000);
    assert.equal(result.knownContribution.valueMinor, 30800000);
    assert.equal(result.budget.amountMinor, 20000000); assert.equal(result.metaSpend.valueMinor, 10000000);
    assert.equal(result.registeredAdvertising.valueMinor, 7000000); assert.equal(result.advertisingPayments.valueMinor, 3000000);
    assert.equal(result.declaredReturn.value, 4); assert.equal(result.contributionAfterAdvertising.valueMinor, 20800000);
    assert.equal(result.recognizedProductSales.complete, true); assert.equal(result.knownContribution.complete, true);
    assert.equal(await commercialFingerprint(store), fingerprint);
    const earlier = await f.result('2026-09-30T23:00:00.000Z');
    assert.equal(earlier.recognizedProductSales.valueMinor, 50000000); assert.equal(earlier.collections.valueMinor, 50000000);
    assert.equal(earlier.advertisingPayments.valueMinor, 0); assert.equal(earlier.metaSpend.valueMinor, null);
    const repeated = await f.result(); assert.equal(repeated.factHash, result.factHash);
    assert.ok(result.facts.netProductSales.some(fact => fact.returnId && fact.occurredOn === '2026-10-02'));
  }],
  ['sin pedidos no hay ventas causadas; pendientes y fechas desconocidas nunca toman la fecha del vínculo', async store => {
    const f = await setup(store); await f.spend();
    let result = await f.result();
    assert.equal(result.recognizedProductSales.valueMinor, null); assert.equal(result.declaredReturn.value, null); assert.equal(result.contributionAfterAdvertising.valueMinor, null); assert.equal(result.contributionAfterAdvertising.knownMinor, null);
    const order = await f.order({ recognized: false });
    await patch(store, 'orders', order.id, { placedOn: null, status: 'delivered', recognition: null, deliverySummary: { complete: true } });
    await f.link('order', order.id); result = await f.result();
    assert.equal(result.coverage.economicStartOn, null); assert.deepEqual(result.coverage.pendingOrderIds, [order.id]);
    assert.equal(result.recognizedProductSales.valueMinor, null); assert.equal(result.recognizedProductSales.knownMinor, 0);
    assert.equal(result.declaredReturn.value, null); assert.equal(result.facts.netProductSales.length, 1);
    assert.equal(result.facts.netProductSales[0].occurredOn, null);
  }],
  ['costos desconocidos conservan ventas/subtotal sin afirmar contribución y hechos sin fecha no se multiplican por mes', async store => {
    const f = await setup(store), recognized = await f.order(), unknown = await f.order({ recognized: false });
    await patch(store, 'orders', recognized.id, { items: recognized.items.map(line => ({ ...line, unitCostMinor: null })) });
    await patch(store, 'orders', unknown.id, { placedOn: null, status: 'delivered', recognition: null, deliverySummary: { complete: true } });
    await f.link('order', recognized.id); await f.link('order', unknown.id); await f.spend();
    const result = await f.result();
    assert.equal(result.recognizedProductSales.knownMinor, 50000000); assert.equal(result.recognizedProductSales.valueMinor, null);
    assert.equal(result.knownContribution.valueMinor, null); assert.equal(result.knownContribution.knownMinor, 50000000);
    assert.equal(result.contributionAfterAdvertising.valueMinor, null); assert.equal(result.contributionAfterAdvertising.knownMinor, 40000000);
    assert.equal(result.facts.netProductSales.filter(fact => fact.orderId === unknown.id).length, 1);
    assert.equal(new Set(result.facts.contribution.map(fact => fact.id)).size, result.facts.contribution.length);
    assert.ok(result.knownContribution.reasons.includes('product_cost_unknown'));
    await f.link('order', unknown.id, { campaignId: null, version: 1 });
    const knownSales = await f.result(); assert.equal(knownSales.recognizedProductSales.valueMinor, 50000000); assert.equal(knownSales.knownContribution.valueMinor, null);
    assert.equal(knownSales.declaredReturn.value, null); assert.equal(knownSales.declaredReturn.complete, false);
    assert.ok(knownSales.declaredReturn.reasons.includes('product_cost_unknown'));
  }],
  ['USD preserva moneda y componentes COP sin inventar retorno convertido', async store => {
    const f = await setup(store, { currency: 'USD' }), order = await f.order();
    await f.link('order', order.id); await f.spend({ value: 5000 });
    const result = await f.result();
    assert.equal(result.metaSpend.valueMinor, 5000); assert.equal(result.metaSpend.currency, 'USD'); assert.equal(result.recognizedProductSales.valueMinor, 50000000);
    assert.equal(result.declaredReturn.value, null); assert.equal(result.contributionAfterAdvertising.valueMinor, null);
    assert.ok(result.declaredReturn.reasons.includes('meta_currency_not_cop'));
  }],
  ['gasto cero explícito permite contribución sin dividir por cero; captura redondeada sin exacta no sirve para retorno', async store => {
    const cop = await setup(store), copOrder = await cop.order(); await cop.link('order', copOrder.id);
    await cop.spend({ precision: 'rounded' });
    const unavailable = await cop.result(); assert.equal(unavailable.metaSpend.valueMinor, null); assert.equal(unavailable.declaredReturn.value, null);
    await cop.spend({ value: 0, fetchedAt: '2026-11-01T23:00:00.001Z' });
    const zero = await cop.result('2026-11-01T23:00:00.001Z'); assert.equal(zero.metaSpend.valueMinor, 0); assert.equal(zero.declaredReturn.value, null); assert.equal(zero.contributionAfterAdvertising.valueMinor, 38500000);
  }],
  ['gasto canónico acumulado no suma días ni fuentes y conserva completo anterior con intento parcial explícito', async store => {
    const f = await setup(store, { method: 'browser' }), order = await f.order(); await f.link('order', order.id);
    const prior = await f.spend({ fetchedAt: '2026-10-30T23:00:00.000Z' });
    await f.spend({ fetchedAt: '2026-10-31T23:00:00.000Z', complete: false, value: 0 });
    await f.spend({ method: 'api', value: 99999999 }); await f.spend({ dimension: 'daily', value: 77777777 });
    let result = await f.result();
    assert.deepEqual(result.metaSpend.measurementIds, [prior]); assert.equal(result.metaSpend.valueMinor, 10000000); assert.equal(result.metaSpend.complete, false); assert.equal(result.declaredReturn.value, null);
    const exact = await f.spend({ fetchedAt: '2026-11-01T23:00:00.001Z', value: 12000000 });
    result = await f.result('2026-11-01T23:00:00.001Z');
    assert.deepEqual(result.metaSpend.measurementIds, [exact]); assert.equal(result.metaSpend.complete, true);
    const rounded = await f.spend({ fetchedAt: '2026-11-01T23:00:00.002Z', precision: 'rounded', value: 12000000 });
    result = await f.result('2026-11-01T23:00:00.002Z'); assert.equal(result.metaSpend.newerPartial, true); assert.equal(result.metaSpend.complete, false); assert.ok(!result.metaSpend.measurementIds.includes(rounded));
  }],
  ['corte de gastos y pagos con reversión mantiene hechos financieros y fingerprint coherentes en una sola snapshot', async store => {
    const f = await setup(store), order = await f.order(); await f.link('order', order.id); await f.spend();
    const expense = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 5000000, incurredOn: '2026-09-04' }, f.actorId);
    const paid = await payExpense(store, { requestId: id(), expenseId: expense.id, version: expense.version, amountMinor: 3000000, accountId: f.account.id, effectiveOn: '2026-09-05' }, f.actorId);
    await f.link('expense', expense.id);
    const before = await f.result();
    await store.transaction(tx => reverseExpensePaymentTx(tx, paid.payment.id, { effectiveOn: '2026-10-05', reason: 'Reversión sintética explícita', actorId: f.actorId }));
    const after = await f.result();
    assert.equal(before.advertisingPayments.valueMinor, 3000000); assert.equal(after.advertisingPayments.valueMinor, 0);
    assert.equal(after.registeredAdvertising.valueMinor, 5000000); assert.equal(after.contributionAfterAdvertising.valueMinor, before.contributionAfterAdvertising.valueMinor);
    assert.ok(after.businessRevision > before.businessRevision); assert.notEqual(after.factHash, before.factHash);
    const earlier = await f.result('2026-09-30T23:00:00.000Z'); assert.equal(earlier.advertisingPayments.valueMinor, 3000000);
  }],
  ['ceros financieros explícitos son conocidos y no se sustituyen por ausencias ni por el total del pedido', async store => {
    const f = await setup(store), order = await f.order();
    await registerReturn(store, { requestId: id(), orderId: order.id, version: order.version, occurredOn: '2026-10-02', reason: 'Devolución sintética completa con costo recuperado', shippingCreditMinor: 0, lines: [{ lineId: order.items[0].lineId, quantity: 5, condition: 'recoverable' }] }, f.actorId);
    await f.link('order', order.id); await f.spend();
    const result = await f.result();
    assert.equal(result.recognizedProductSales.valueMinor, 0); assert.equal(result.recognizedProductSales.complete, true);
    assert.equal(result.knownContribution.valueMinor, 0); assert.equal(result.knownContribution.complete, true);
    assert.equal(result.declaredReturn.value, 0); assert.equal(result.contributionAfterAdvertising.valueMinor, -10000000);
  }],
  ['gasto registrado sin fecha queda pendiente aunque su pago sí tenga fecha; no altera retorno de ventas reconocidas', async store => {
    const f = await setup(store), order = await f.order(); await f.link('order', order.id); await f.spend();
    const expense = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 5000000, incurredOn: null }, f.actorId);
    await payExpense(store, { requestId: id(), expenseId: expense.id, version: expense.version, amountMinor: 2000000, accountId: f.account.id, effectiveOn: '2026-10-05' }, f.actorId);
    await f.link('expense', expense.id);
    const result = await f.result();
    assert.equal(result.registeredAdvertising.valueMinor, null); assert.equal(result.registeredAdvertising.knownMinor, 0);
    assert.ok(result.registeredAdvertising.reasons.includes('expense_date_unknown'));
    assert.equal(result.advertisingPayments.valueMinor, 2000000); assert.equal(result.declaredReturn.value, 5);
    assert.equal(result.contributionAfterAdvertising.valueMinor, 28500000);
  }],
  ['orgánico y gasto mixto no inventan cero Meta ni retorno contra publicidad registrada', async store => {
    const f = await setup(store, { mode: 'organic' }), order = await f.order();
    await f.link('order', order.id); await f.spend({ scope: 'mixed' });
    const result = await f.result();
    assert.equal(result.recognizedProductSales.valueMinor, 50000000);
    assert.equal(result.metaSpend.valueMinor, null); assert.equal(result.declaredReturn.value, null); assert.equal(result.contributionAfterAdvertising.valueMinor, null);
    assert.ok(result.metaSpend.reasons.includes('organic_spend_not_applicable'));
  }],
];

export async function runSocialLinkContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory();
    try { await scenario(store); } finally { await store.close(); }
  });
}
