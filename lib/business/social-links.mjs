import { fail, integer, text } from '../validation-core.mjs';
import { audit, entity, hash, insertRow, runCommand, stamp } from './commands.mjs';
import { bogotaDate, instant, periodBounds } from './dates.mjs';
import { queueSocialAnalysisTx } from './social-analysis-queue.mjs';
import { buildBusinessReportTx } from './reports.mjs';
import { socialMetricAnchor } from './social-metrics.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = Object.freeze({ order: { table: 'social_order_links', recordTable: 'orders', key: 'order_id' }, expense: { table: 'social_expense_links', recordTable: 'expenses', key: 'expense_id' } });
const raw = row => JSON.parse(row?.data || '{}');
const ordered = values => values.sort((a, b) => a.id.localeCompare(b.id));
function campaignIdentifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('Identificador de campaña no válido.');
  return value;
}
function safe(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('El resultado financiero excede el rango seguro.', 409);
  return number;
}
const sum = values => safe(values.reduce((total, value) => total + BigInt(value), 0n));
async function requireActor(tx, actorId) {
  if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador debe estar activo para realizar esta acción.', 403);
}

export async function saveSocialLink(store, input, actorId, { scopeCampaignId = null } = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['kind', 'recordId', 'campaignId', 'version', 'requestId', 'reason'].includes(key))) fail('Datos del vínculo no válidos.');
  const type = Object.hasOwn(TYPES, input.kind) ? TYPES[input.kind] : null;
  if (!type) fail('Tipo de vínculo no válido.');
  const recordId = text(input.recordId, 'Registro', 100, true);
  const campaignId = input.campaignId === null ? null : campaignIdentifier(input.campaignId);
  if (scopeCampaignId !== null) scopeCampaignId = campaignIdentifier(scopeCampaignId);
  const version = integer(input.version, 'Versión del vínculo', 0, Number.MAX_SAFE_INTEGER);
  const reason = text(input.reason, 'Motivo', 500, true);
  actorId = text(actorId, 'Administrador', 100, true);
  const payload = { kind: input.kind, recordId, campaignId, version, reason, ...(scopeCampaignId ? { scopeCampaignId } : {}) };
  const activeStore = { transaction: fn => store.transaction(async tx => {
    await tx.lockWrites();
    await requireActor(tx, actorId);
    return fn(tx);
  }) };
  return runCommand(activeStore, { scope: `social:link:${input.kind}:${recordId}`, requestId: input.requestId, payload, actorId, affectsIndicators: false }, async tx => {
    const record = entity(await tx.db.get(`SELECT * FROM ${tx.t(type.recordTable)} WHERE id=?`, [recordId]));
    if (!record) fail('Registro comercial no encontrado.', 404);
    if (input.kind === 'expense' && record.category !== 'advertising') fail('Solo se pueden vincular gastos de publicidad.');
    if (campaignId && !await tx.db.get(`SELECT id FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId])) fail('Campaña no encontrada.', 404);
    const previous = entity(await tx.db.get(`SELECT * FROM ${tx.t(type.table)} WHERE ${type.key}=?`, [recordId]));
    if ((previous?.version || 0) !== version) fail('El vínculo cambió en otra sesión. Recarga antes de continuar.', 409);
    if (scopeCampaignId && (campaignId ? campaignId !== scopeCampaignId : previous?.campaignId !== scopeCampaignId)) fail('El vínculo no pertenece a la campaña indicada.', 409);
    if (!previous && !campaignId) fail('El registro no tiene un vínculo para retirar.', 409);
    const now = stamp();
    if (!campaignId) {
      const result = await tx.db.run(`DELETE FROM ${tx.t(type.table)} WHERE ${type.key}=? AND version=?`, [recordId, version]);
      if (!result.changes) fail('El vínculo cambió en otra sesión.', 409);
    } else if (previous) {
      const result = await tx.db.run(`UPDATE ${tx.t(type.table)} SET campaign_id=?,actor_id=?,reason=?,version=version+1,updated_at=? WHERE ${type.key}=? AND version=?`, [campaignId, actorId, reason, now, recordId, version]);
      if (!result.changes) fail('El vínculo cambió en otra sesión.', 409);
    } else {
      // Deleted links have no row/version, but their audit retains the outgoing
      // generation. Never reuse it after relinking (stale clients must fail).
      const history = await tx.db.all(`SELECT data FROM ${tx.t('business_audit')} WHERE entity_type=? AND entity_id=?`, [`social_${input.kind}_link`, recordId]);
      let lastVersion = 0;
      for (const row of history) {
        const change = raw(row);
        lastVersion = Math.max(lastVersion, change.previous?.version || 0, change.next?.version || 0);
      }
      await insertRow(tx, type.table, { [type.key]: recordId, campaign_id: campaignId, actor_id: actorId, reason, data: '{}', version: safe(BigInt(lastVersion) + 1n), created_at: now, updated_at: now });
    }
    const next = entity(await tx.db.get(`SELECT * FROM ${tx.t(type.table)} WHERE ${type.key}=?`, [recordId]));
    await audit(tx, { entityType: `social_${input.kind}_link`, entityId: recordId, actorId, previous, next, reason, source: 'social', recordedAt: now });
    for (const id of new Set([previous?.campaignId, campaignId].filter(Boolean))) await queueSocialAnalysisTx(tx, id, { now, requestedBy: actorId });
    return { kind: input.kind, recordId, campaignId, previousCampaignId: previous?.campaignId || null, version: next?.version || 0, link: next };
  });
}

function component(facts, reasons = [], { absent = false } = {}) {
  const unknown = facts.filter(fact => fact.known !== true || fact.value == null);
  const allReasons = [...new Set([...reasons, ...unknown.map(fact => fact.reason || 'financial_fact_unknown')])].sort();
  const knownMinor = sum(facts.filter(fact => fact.known === true && fact.value != null).map(fact => fact.value));
  const complete = !absent && !allReasons.length;
  return { valueMinor: complete ? knownMinor : null, knownMinor, currency: 'COP', complete, reasons: allReasons, factIds: facts.map(fact => fact.id) };
}
function monthAfter(month) { return periodBounds('month', month).endDateExclusive; }
function dateInZone(value, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
async function metaSpendTx(tx, campaign, asOf) {
  const missing = reason => ({ valueMinor: null, knownMinor: null, currency: campaign.currency || null, complete: false, measurementIds: [], asOf: null, fetchedAt: null, reasons: [reason], newerPartial: false, providerDelayHours: 48 });
  if (campaign.mode !== 'paid') return missing('organic_spend_not_applicable');
  const deliveries = await tx.db.all(`SELECT d.*,r.data AS revision_data FROM ${tx.t('social_deliveries')} d JOIN ${tx.t('social_revisions')} r ON r.campaign_id=d.campaign_id AND r.revision=d.revision WHERE d.campaign_id=? AND d.channel='meta_ads'`, [campaign.id]);
  if (deliveries.length !== 1) return missing('canonical_paid_delivery_unavailable');
  const delivery = entity(deliveries[0]), spec = raw({ data: deliveries[0].revision_data }).spec;
  if (!spec || spec.mode !== 'paid') return missing('approved_spec_unavailable');
  const snapshots = await tx.db.all(`SELECT * FROM ${tx.t('social_measurements')} WHERE delivery_id=? AND fetched_at<=? ORDER BY fetched_at DESC,id DESC`, [delivery.id, asOf]);
  const candidates = snapshots.map(row => ({ row, data: raw(row) })).filter(({ data }) => data.integrationMethod === spec.integrationMethod && data.scope === 'paid' && data.dimension === 'aggregate' && data.query?.window === 'cumulative' && data.periodEnd <= asOf && data.timeZone === spec.timeZone && data.currency === spec.currency);
  const usable = ({ data }) => {
    const spend = data.values?.spendMinor;
    const start = socialMetricAnchor(delivery, spec);
    return data.coverage?.complete === true && data.definitionVersion && start && data.query.periodStart === dateInZone(start, spec.timeZone)
      && data.query.windowStart === data.periodStart && data.query.windowEnd === data.periodEnd
      && spend && spend.status === 'reported' && spend.precision === 'exact' && spend.unit === 'minor_currency' && Number.isSafeInteger(spend.value) && spend.value >= 0;
  };
  const selected = candidates.find(usable);
  if (!selected) return missing('complete_exact_cumulative_spend_unavailable');
  const { row, data } = selected;
  // A prior complete value remains visible, but cannot claim coverage of a newer partial attempt.
  const newerPartial = candidates[0].row.id !== row.id;
  const reasons = newerPartial ? ['newer_spend_capture_incomplete'] : [];
  if (delivery.state === 'active' && Date.parse(asOf) - Date.parse(row.fetched_at) > 2 * 3600000) reasons.push('meta_spend_stale');
  return { valueMinor: data.values.spendMinor.value, knownMinor: data.values.spendMinor.value, currency: data.currency, complete: !reasons.length, measurementIds: [row.id], asOf: data.periodEnd, fetchedAt: row.fetched_at, periodStart: data.periodStart, integrationMethod: data.integrationMethod, sourceMetric: data.values.spendMinor.sourceMetric, precision: 'exact', reasons, newerPartial, providerDelayHours: 48 };
}

async function linkedRowsTx(tx, kind, campaignId) {
  const type = TYPES[kind];
  return tx.db.all(`SELECT r.*,l.actor_id AS link_actor_id,l.reason AS link_reason,l.version AS link_version,l.created_at AS link_created_at,l.updated_at AS link_updated_at FROM ${tx.t(type.recordTable)} r JOIN ${tx.t(type.table)} l ON l.${type.key}=r.id WHERE l.campaign_id=? ORDER BY r.id`, [campaignId]);
}
const linkEvidence = row => ({ version: row.link_version, actorId: row.link_actor_id, reason: row.link_reason, createdAt: row.link_created_at, updatedAt: row.link_updated_at });
function linkedOrder(row, through) {
  const order = entity(row);
  return { id: order.id, number: order.number, status: order.status, version: order.version, recognitionOn: order.recognition?.on || null, recognitionBasis: order.recognition?.basis || null, marketingCampaign: order.marketingCampaign || '', pendingRecognition: !order.recognition?.on || order.recognition.on > through, link: linkEvidence(row) };
}
function linkedExpense(row) {
  const expense = entity(row);
  return { id: expense.id, version: expense.version, category: expense.category, concept: expense.concept || '', campaign: expense.campaign || '', amountMinor: expense.amountMinor, incurredOn: expense.incurredOn, costPending: !!expense.costPending, link: linkEvidence(row) };
}

export async function getSocialCampaignLinks(store, campaignId, { kind = null, q = '', page = 1, asOf = stamp() } = {}) {
  campaignId = campaignIdentifier(campaignId); asOf = instant(asOf);
  if (kind !== null && !Object.hasOwn(TYPES, kind)) fail('Tipo de vínculo no válido.');
  q = text(q, 'Búsqueda de registros', 200); page = integer(page, 'Página', 1, 1000000);
  if (!kind && (q || page !== 1)) fail('Elige pedidos o gastos para buscar candidatos.');
  return store.readSnapshot(async tx => {
    if (!await tx.db.get(`SELECT id FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId])) fail('Campaña no encontrada.', 404);
    const orders = (await linkedRowsTx(tx, 'order', campaignId)).map(row => linkedOrder(row, bogotaDate(asOf)));
    const expenses = (await linkedRowsTx(tx, 'expense', campaignId)).map(linkedExpense);
    if (!kind) return { campaignId, orders, expenses, candidates: null };
    const type = TYPES[kind], field = name => tx.provider === 'sqlite' ? `json_extract(r.data,'$.${name}')` : `r.data::jsonb->>'${name}'`;
    const label = kind === 'order' ? 'CAST(r.number AS TEXT)' : `COALESCE(${field('concept')},'')`, historical = `COALESCE(${field(kind === 'order' ? 'marketingCampaign' : 'campaign')},'')`;
    const pattern = `%${q.replace(/[!%_]/g, value => '!' + value)}%`, where = `${kind === 'expense' ? "r.category='advertising' AND " : ''}(${label} LIKE ? ESCAPE '!' OR ${historical} LIKE ? ESCAPE '!')`, args = [pattern, pattern];
    const total = safe((await tx.db.get(`SELECT COUNT(*) AS total FROM ${tx.t(type.recordTable)} r WHERE ${where}`, args)).total);
    const rows = await tx.db.all(`SELECT r.*,l.campaign_id AS link_campaign_id,l.actor_id AS link_actor_id,l.reason AS link_reason,l.version AS link_version,l.created_at AS link_created_at,l.updated_at AS link_updated_at,c.name AS link_campaign_name FROM ${tx.t(type.recordTable)} r LEFT JOIN ${tx.t(type.table)} l ON l.${type.key}=r.id LEFT JOIN ${tx.t('social_campaigns')} c ON c.id=l.campaign_id WHERE ${where} ORDER BY ${kind === 'order' ? 'r.number DESC,r.id' : 'r.created_at DESC,r.id'} LIMIT ? OFFSET ?`, [...args, 20, (page - 1) * 20]);
    const items = rows.map(row => {
      const record = entity(row);
      return { kind, recordId: record.id, ...(kind === 'order' ? { number: record.number, status: record.status, marketingCampaign: record.marketingCampaign || '', totalMinor: record.totalMinor } : { concept: record.concept || '', campaign: record.campaign || '', amountMinor: record.amountMinor, incurredOn: record.incurredOn, costPending: !!record.costPending }),
        link: row.link_campaign_id ? { campaignId: row.link_campaign_id, campaignName: row.link_campaign_name, ...linkEvidence(row) } : null };
    });
    return { campaignId, orders, expenses, candidates: { kind, q, page, pageSize: 20, total, items } };
  });
}

export function getSocialBusinessResult(store, campaignId, options = {}) {
  return store.readSnapshot(tx => getSocialBusinessResultTx(tx, campaignId, options));
}

// Read-only composition: the caller owns the coherent snapshot/transaction.
export async function getSocialBusinessResultTx(tx, campaignId, { asOf = stamp() } = {}) {
  campaignId = campaignIdentifier(campaignId); asOf = instant(asOf, 'Corte comercial');
    const campaign = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId]));
    if (!campaign) fail('Campaña no encontrada.', 404);
    const through = bogotaDate(asOf);
    const orderRows = await linkedRowsTx(tx, 'order', campaignId);
    const orders = orderRows.map(row => linkedOrder(row, through));
    const orderIds = new Set(orders.map(order => order.id));
    // Only economic occurrence dates bound the traversal; link/creation/placement timestamps do not.
    const dates = [];
    const addDate = date => { if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= through) dates.push(date); };
    for (const row of orderRows) { const order = raw(row); addDate(order.recognition?.on); for (const dispatch of order.giftDispatches || []) addDate(dispatch.on); }
    const dated = await tx.db.all(`SELECT r.occurred_on AS economic_on,NULL AS economic_at FROM ${tx.t('order_returns')} r JOIN ${tx.t('social_order_links')} l ON l.order_id=r.order_id WHERE l.campaign_id=?
      UNION ALL SELECT c.occurred_on,NULL FROM ${tx.t('order_collections')} c JOIN ${tx.t('social_order_links')} l ON l.order_id=c.order_id WHERE l.campaign_id=?
      UNION ALL SELECT e.incurred_on,NULL FROM ${tx.t('expenses')} e LEFT JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id JOIN ${tx.t('social_order_links')} l ON l.order_id=COALESCE(e.order_id,s.order_id) WHERE l.campaign_id=?
      UNION ALL SELECT e.occurred_on,e.occurred_at FROM ${tx.t('shipment_events')} e JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id JOIN ${tx.t('social_order_links')} l ON l.order_id=s.order_id WHERE l.campaign_id=?`, [campaignId, campaignId, campaignId, campaignId]);
    for (const row of dated) addDate(row.economic_on || (row.economic_at ? bogotaDate(row.economic_at) : null));
    const facts = { netProductSales: [], contribution: [], customerCollections: [] };
    const seen = new Map(Object.keys(facts).map(key => [key, new Set()]));
    if (orders.length) {
      // One cutoff-month read exposes undated facts even when no economic start is known.
      const first = dates.sort()[0] || through;
      for (let month = `${first.slice(0, 7)}-01`; month <= through; month = monthAfter(month)) {
        const report = await buildBusinessReportTx(tx, { period: 'month', anchorDate: month, asOf });
        for (const key of Object.keys(facts)) for (const fact of report.facts[key]) {
          if (!orderIds.has(fact.orderId) || seen.get(key).has(fact.id)) continue;
          seen.get(key).add(fact.id); facts[key].push(fact);
        }
      }
    }
    for (const list of Object.values(facts)) ordered(list);
    const noOrders = !orders.length, pending = orders.filter(order => order.pendingRecognition);
    const salesReasons = noOrders ? ['no_linked_orders'] : pending.length ? ['linked_orders_pending_recognition'] : [];
    const recognizedProductSales = component(facts.netProductSales, salesReasons, { absent: noOrders });
    const knownContribution = component(facts.contribution, salesReasons, { absent: noOrders });
    const collections = component(facts.customerCollections, noOrders ? ['no_linked_orders'] : [], { absent: noOrders });
    const expenses = (await linkedRowsTx(tx, 'expense', campaignId)).map(linkedExpense);
    const expenseFacts = expenses.filter(expense => !expense.incurredOn || expense.incurredOn <= through).map(expense => ({ id: expense.id, value: expense.amountMinor, known: !!expense.incurredOn && !expense.costPending, reason: !expense.incurredOn ? 'expense_date_unknown' : expense.costPending ? 'expense_cost_unknown' : null }));
    const payments = (await tx.db.all(`SELECT p.id,p.expense_id,p.amount_minor,COALESCE(c.effective_on,r.received_on) AS payment_on FROM ${tx.t('expense_payments')} p JOIN ${tx.t('social_expense_links')} l ON l.expense_id=p.expense_id LEFT JOIN ${tx.t('cash_entries')} c ON c.id=p.cash_entry_id LEFT JOIN ${tx.t('settlement_receipts')} r ON r.id=p.settlement_receipt_id WHERE l.campaign_id=? ORDER BY p.id`, [campaignId])).map(row => ({ id: row.id, expenseId: row.expense_id, value: safe(row.amount_minor), occurredOn: row.payment_on, known: !!row.payment_on, reason: row.payment_on ? null : 'expense_payment_date_unknown' })).filter(payment => !payment.occurredOn || payment.occurredOn <= through);
    const registeredAdvertising = component(expenseFacts);
    const advertisingPayments = { ...component(payments), payments: payments.map(payment => ({ id: payment.id, expenseId: payment.expenseId, amountMinor: payment.value, occurredOn: payment.occurredOn, known: payment.known, reason: payment.reason })) };
    const metaSpend = await metaSpendTx(tx, campaign, asOf);
    const returnReasons = [...recognizedProductSales.reasons, ...knownContribution.reasons, ...collections.reasons, ...metaSpend.reasons];
    if (metaSpend.currency !== 'COP') returnReasons.push('meta_currency_not_cop');
    if (!(metaSpend.valueMinor > 0)) returnReasons.push('positive_meta_spend_required');
    const declaredReturn = { value: !returnReasons.length ? recognizedProductSales.valueMinor / metaSpend.valueMinor : null, complete: !returnReasons.length, reasons: [...new Set(returnReasons)].sort() };
    const contributionReasons = [...knownContribution.reasons, ...metaSpend.reasons];
    if (metaSpend.currency !== 'COP') contributionReasons.push('meta_currency_not_cop');
    const contributionComplete = !contributionReasons.length;
    const contributionAfterAdvertising = { valueMinor: contributionComplete ? safe(BigInt(knownContribution.valueMinor) - BigInt(metaSpend.valueMinor)) : null, knownMinor: !noOrders && metaSpend.currency === 'COP' && metaSpend.valueMinor != null ? safe(BigInt(knownContribution.knownMinor) - BigInt(metaSpend.valueMinor)) : null, currency: 'COP', complete: contributionComplete, reasons: [...new Set(contributionReasons)].sort() };
    const businessRevision = safe((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`))?.value || 0);
    const linkVersions = { orders: orders.map(order => ({ recordId: order.id, ...order.link })), expenses: expenses.map(expense => ({ recordId: expense.id, ...expense.link })) };
    const coverage = { complete: recognizedProductSales.complete && knownContribution.complete && collections.complete && metaSpend.complete, noLinkedOrders: noOrders, pendingOrderIds: pending.map(order => order.id), economicStartOn: dates[0] || null, through, providerDelayHours: 48, reasons: [...new Set([...recognizedProductSales.reasons, ...knownContribution.reasons, ...collections.reasons, ...metaSpend.reasons])].sort() };
    const budget = { amountMinor: campaign.budgetMinor ?? null, currency: campaign.currency || null };
    const factHash = hash({ version: 'social-business-v1', linkVersions, facts, expenses, payments, metaSpend, budget });
    return { campaignId, asOf, businessRevision, linkVersions, factHash, orders, expenses, recognizedProductSales, knownContribution, collections, budget, metaSpend, registeredAdvertising, advertisingPayments, declaredReturn, contributionAfterAdvertising, coverage, facts, attribution: 'administrator_declared', accumulatedThrough: through };
}
