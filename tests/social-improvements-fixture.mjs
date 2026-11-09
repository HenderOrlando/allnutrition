import { randomUUID } from 'node:crypto';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { saveSocialCampaign } from '../lib/business/social.mjs';
import { buildSocialSpec } from '../lib/business/social-spec.mjs';
import { buildSocialMetricQueries, normalizeSocialMeasurement, socialMetricRatios } from '../lib/business/social-metrics.mjs';
import { buildSocialHistoricalForecast, selectSocialComparableSamples } from '../lib/business/social-analysis.mjs';
import { socialMeasurementQueryKey } from '../lib/social/evidence.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';

export const CUT = '2026-11-02T12:00:00.000Z';
export const START = '2026-10-26T05:00:00.000Z';
export const END = '2026-11-02T05:00:00.000Z';
export const CLOCK = '2026-11-20T12:00:00.000Z';
export const DAY = 86400000;
export const exactMetric = (value, sourceMetric = 'fixture_link_clicks', unit = 'count') => ({ value, unit, sourceMetric, status: 'reported', precision: 'exact', displayValue: String(value), reason: null });
export const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: START, updated_at: START });
const measurementPayload = ({ id, deliveryId, fetchedAt, payloadHash, ...data }) => data;
export const row = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
export async function patchData(store, table, id, changes) {
  const old = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(old.data), ...changes }), id]);
}
export function improvementSpec(extra = {}) {
  return { mode: 'paid', objective: 'traffic', integrationMethod: 'api', assetType: 'image', assetId: 'fixture-asset', derivativeSha256: 'a'.repeat(64),
    platforms: ['facebook'], placements: ['facebook_feed'], identities: { userId: '100', businessId: '500', pageId: '200', adAccountId: 'act_400' },
    audience: { countries: ['CO'], regions: [], cities: [], interests: [], ageMin: 18, ageMax: 65, genders: [] },
    caption: 'Texto original aportado por el administrador', headline: '', destinationUrl: 'https://example.test/products',
    budgetMinor: 5000000, currency: 'COP', timeZone: 'America/Bogota', startAt: START, endAt: END, publishAt: null, observationDays: 7, aiDisclosure: false, ...extra };
}
export function improvementDelivery(spec, extra = {}) {
  return { id: 'fixture-delivery', campaignId: 'fixture-campaign', channel: spec.mode === 'paid' ? 'meta_ads' : spec.platforms[0],
    state: spec.mode === 'paid' ? 'completed' : 'published', lastConfirmedState: spec.mode === 'paid' ? 'completed' : 'published',
    finalizedAt: spec.endAt || END, activatedAt: spec.startAt, publishedAt: START, publicationTimeSource: 'remote_published_at',
    integrationMethod: spec.integrationMethod, remoteId: '600', remoteRefs: { campaignId: '600', adId: '601' }, ...extra };
}
export function improvementMeasurement(spec, delivery, { window = spec.mode === 'paid' ? 'cumulative' : 'horizon', dimension = 'aggregate', now = CUT, values = {}, rows = [], query = null, id = `measurement-${window}-${dimension}`, fetchedAt = now } = {}) {
  query ||= buildSocialMetricQueries(delivery, spec, { now }).find(q => q.window === window && q.dimension === dimension);
  if (!query) throw new Error(`Fixture needs a real ${window}/${dimension} query`);
  const defaults = { impressions: exactMetric(10000, 'fixture_impressions'), reach: exactMetric(2000, 'fixture_reach'), linkClicks: exactMetric(100),
    interactions: exactMetric(100, 'fixture_post_interactions'), ...(spec.mode === 'paid' ? { spendMinor: exactMetric(5000000, 'fixture_spend', 'minor_currency') } : {}),
    ...(spec.mode === 'paid' && spec.objective === 'whatsapp' ? { conversations: exactMetric(10, 'fixture_whatsapp_conversations') } : {}) };
  const data = normalizeSocialMeasurement({ integrationMethod: spec.integrationMethod, adapterVersion: spec.integrationMethod === 'api' ? 'meta-api-v1' : 'meta-ui-v1',
    apiVersion: spec.integrationMethod === 'api' ? 'v26.0' : null, definitionVersion: 'fixture-improvements-v1', query, periodStart: query.windowStart, periodEnd: query.windowEnd,
    timeZone: spec.timeZone || 'UTC', scope: spec.mode, dimension, currency: spec.currency, attributionSetting: spec.mode === 'paid' ? [{ event_type: 'CLICK_THROUGH', window_days: 7 }] : null,
    actionReportTime: spec.mode === 'paid' ? 'impression' : null, entity: { type: spec.mode === 'paid' ? 'ad' : 'post', id: spec.mode === 'paid' ? delivery.remoteRefs.adId : delivery.remoteId },
    values: dimension === 'aggregate' ? { ...defaults, ...values } : {}, rows, coverage: { complete: true, rowCount: dimension === 'aggregate' ? 1 : rows.length, reason: null }, evidence: {} }, { delivery, spec, query });
  return { id, deliveryId: delivery.id, fetchedAt, payloadHash: hash(data), ...data };
}
export function improvementCandidates(spec, { clicks = [150, 150, 200, 250, 300], reaches = [1000, 1000, 1000, 1000, 1000], publishedAt = '2026-10-01T05:00:00.000Z', suffix = '' } = {}) {
  return clicks.map((value, index) => {
    const id = `history-${suffix}-${index}`, end = new Date(Date.parse(publishedAt) + 7 * DAY).toISOString();
    const candidateSpec = { ...structuredClone(spec), startAt: spec.mode === 'paid' ? publishedAt : null, endAt: spec.mode === 'paid' ? end : null, publishAt: spec.mode === 'organic' ? publishedAt : null };
    const remoteId = String(1000 + [...suffix].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) * 100 + index);
    const delivery = improvementDelivery(candidateSpec, { id: `${id}-delivery`, campaignId: id, publishedAt, finalizedAt: end, remoteId, remoteRefs: { campaignId: remoteId, adId: String(Number(remoteId) + 1000000) } });
    const measurement = improvementMeasurement(candidateSpec, delivery, { now: end, id: `${id}-measurement`, values: { linkClicks: exactMetric(value), reach: exactMetric(reaches[index], 'fixture_reach'), interactions: exactMetric(value, 'fixture_post_interactions') } });
    return { id, spec: candidateSpec, specHash: hash(candidateSpec), deliveries: [delivery], measurements: [measurement] };
  });
}
export function financialEvidence({ orderCount = 5, contributionMinor = 4000000, spendMinor = 5000000, complete = true, currency = 'COP' } = {}) {
  const orders = Array.from({ length: orderCount }, (_, index) => ({ id: `financial-order-${index}`, pendingRecognition: false, link: { version: 1, actorId: 'fixture-admin', reason: 'Origen declarado' } }));
  const facts = { netProductSales: orders.map(order => ({ id: `sale:${order.id}`, orderId: order.id, value: 2000000, known: true })),
    contribution: orders.map((order, index) => ({ id: `contribution:${order.id}`, orderId: order.id, value: index ? 0 : contributionMinor, known: true })), customerCollections: [] };
  const component = valueMinor => ({ valueMinor: complete ? valueMinor : null, knownMinor: valueMinor, currency: 'COP', complete, reasons: complete ? [] : ['fixture_missing_cost'], factIds: [] });
  const result = { campaignId: 'fixture-campaign', asOf: CUT, businessRevision: 1, orders, expenses: [], facts,
    linkVersions: { orders: orders.map(order => ({ recordId: order.id, ...order.link })), expenses: [] },
    recognizedProductSales: component(orderCount * 2000000), knownContribution: component(contributionMinor), collections: component(0),
    budget: { amountMinor: 5000000, currency }, metaSpend: { ...component(spendMinor), currency, measurementIds: ['measurement-cumulative-aggregate'], precision: 'exact' },
    registeredAdvertising: component(0), advertisingPayments: component(0), declaredReturn: { value: complete && currency === 'COP' ? orderCount * 2000000 / spendMinor : null, complete: complete && currency === 'COP', reasons: [] },
    contributionAfterAdvertising: { ...component(contributionMinor - spendMinor), complete: complete && currency === 'COP', valueMinor: complete && currency === 'COP' ? contributionMinor - spendMinor : null },
    coverage: { complete, noLinkedOrders: orderCount === 0, pendingOrderIds: [], through: '2026-11-02', reasons: complete ? [] : ['fixture_missing_cost'] } };
  return { ...result, factHash: hash(result) };
}
export function improvementInput({ mode = 'paid', objective = mode === 'paid' ? 'traffic' : 'engagement', spec: overrides = {}, business = financialEvidence({ orderCount: 0, complete: false }) } = {}) {
  const spec = improvementSpec({ mode, objective, ...(mode === 'organic' ? { budgetMinor: 0, startAt: null, endAt: null, publishAt: START } : {}), ...overrides });
  const delivery = improvementDelivery(spec), measurements = buildSocialMetricQueries(delivery, spec, { now: CUT }).length ? [improvementMeasurement(spec, delivery)] : [];
  const samples = selectSocialComparableSamples(spec, improvementCandidates(spec), { asOf: CUT }).samples;
  return { campaign: { id: 'fixture-campaign', state: mode === 'paid' ? 'completed' : 'published', version: 1 }, spec, deliveries: [delivery], measurements, samples, business, asOf: CUT };
}
export function addFatigue(input) {
  const delivery = input.deliveries[0];
  input.measurements.push(improvementMeasurement(input.spec, delivery, { window: 'previous_3d', values: { impressions: exactMetric(2000, 'fixture_impressions'), reach: exactMetric(1000, 'fixture_reach'), linkClicks: exactMetric(20) } }),
    improvementMeasurement(input.spec, delivery, { window: 'recent_3d', values: { impressions: exactMetric(2000, 'fixture_impressions'), reach: exactMetric(500, 'fixture_reach'), linkClicks: exactMetric(16) } }));
  return input;
}
export function addPlacements(input, { best = 800000, other = 1000000, results = 20 } = {}) {
  // Two authorized feed placements share one approved total budget.
  for (const spec of [input.spec, ...input.samples.map(sample => sample.spec)]) {
    spec.platforms = ['facebook', 'instagram']; spec.placements = ['facebook_feed', 'instagram_feed']; spec.identities.instagramId = '300';
  }
  for (const sample of input.samples) sample.specHash = hash(sample.spec);
  const query = buildSocialMetricQueries(input.deliveries[0], input.spec, { now: input.asOf }).find(q => q.dimension === 'placement');
  const key = input.spec.objective === 'whatsapp' ? 'conversations' : input.spec.objective === 'engagement' ? 'interactions' : 'linkClicks';
  const rows = [['facebook', 'feed', best], ['instagram', 'stream', other]].map(([publisherPlatform, placement, spend]) => ({ dimensions: { publisherPlatform, placement }, periodStart: query.periodStart, periodEnd: query.periodEnd,
    values: { [key]: exactMetric(results, key === 'linkClicks' ? 'fixture_link_clicks' : key === 'conversations' ? 'fixture_whatsapp_conversations' : 'fixture_post_interactions'), spendMinor: exactMetric(spend, 'fixture_spend', 'minor_currency') } }));
  input.measurements.push(improvementMeasurement(input.spec, input.deliveries[0], { dimension: 'placement', query, rows }));
  return input;
}
export function refreshRatios(measurement, objective = 'traffic') {
  measurement.ratios = socialMetricRatios(measurement.values, { objective, complete: measurement.coverage.complete });
}

// No credentials or provider client: these are already-confirmed, synthetic
// remote facts. Every SQL mutation under test goes through the real domain.
export async function createImprovementStoreFixture(store, { mode = 'paid', objective = mode === 'paid' ? 'traffic' : 'engagement', history = true } = {}) {
  const env = {};
  const { runtime } = await configureSocialTestRuntime(store, { env, settings: { publicBaseUrl: 'https://example.test', appId: '42', appSecret: 'SYNTHETIC-IMPROVEMENTS-SECRET', loginConfigId: '43' } });
  const actorId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'unused-synthetic-password', active: 1 });
  const identities = { userId: '100', businessId: '500', pageId: '200', adAccountId: 'act_400' };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', ...editable({ identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { facebookPublish: true, adsPublish: true, insights: true } }) });
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: 'a'.repeat(64), bytes: 100, ...editable({ name: 'Pieza sintética', kind: 'image', derivativeSha256: 'a'.repeat(64) }) });
  const config = improvementSpec({ mode, objective, assetId, connectionId, ...(mode === 'organic' ? { budgetMinor: 0, startAt: null, endAt: null, publishAt: START } : {}) });
  const saved = await saveSocialCampaign(store, { ...Object.fromEntries(['mode', 'objective', 'platforms', 'placements', 'caption', 'headline', 'destinationUrl', 'audience', 'budgetMinor', 'startAt', 'endAt', 'publishAt', 'observationDays', 'aiDisclosure'].map(key => [key, config[key]])), name: 'Campaña de mejoras sintética', connectionId, assetId, requestId: randomUUID() }, actorId, { now: '2026-10-25T05:00:00.000Z' });
  const campaign = await row(store, 'social_campaigns', saved.id);
  const { spec, specHash } = buildSocialSpec(campaign, { connection: await row(store, 'social_connections', connectionId), asset: await row(store, 'social_assets', assetId), now: '2026-10-25T05:00:00.000Z' });
  const candidates = improvementCandidates(spec);
  const historyForecast = buildSocialHistoricalForecast(spec, history ? candidates : [], { asOf: CUT }), forecastId = randomUUID();
  const forecast = { algorithmVersion: 'social-history-v1', source: Object.keys(historyForecast.metricRanges).length ? 'history' : 'insufficient', ...historyForecast,
    specHash, budgetMinor: spec.budgetMinor, currency: spec.currency, horizon: spec.mode === 'paid' ? { startAt: spec.startAt, endAt: spec.endAt } : spec.observationDays,
    assumptions: [], generatedAt: '2026-10-25T05:00:00.000Z' };
  await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: campaign.id, spec_hash: specHash, generated_at: forecast.generatedAt, data: JSON.stringify(forecast) });
  await insertRow(store, 'social_revisions', { campaign_id: campaign.id, revision: 1, spec_hash: specHash, approved_at: '2026-10-25T05:00:00.000Z', actor_id: actorId, data: JSON.stringify({ spec, forecastId, forecast, rightsConfirmed: true, investmentConfirmed: true }) });
  const delivery = improvementDelivery(spec, { id: randomUUID(), campaignId: campaign.id });
  await insertRow(store, 'social_deliveries', { id: delivery.id, campaign_id: campaign.id, revision: 1, channel: delivery.channel, state: delivery.state, remote_id: delivery.remoteId, next_sync_at: null, ...editable(delivery) });
  await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state=? WHERE id=?`, [mode === 'paid' ? 'completed' : 'published', campaign.id]);
  const f = { store, env, runtime, actorId, connectionId, assetId, campaignId: campaign.id, deliveryId: delivery.id, spec, forecastId, forecast, campaign, delivery };
  f.addMeasurement = async (options = {}) => {
    const measurement = improvementMeasurement(spec, delivery, { id: randomUUID(), ...options });
    await insertRow(store, 'social_measurements', { id: measurement.id, delivery_id: delivery.id, query_key: socialMeasurementQueryKey(measurement), fetched_at: measurement.fetchedAt, payload_hash: measurement.payloadHash, data: JSON.stringify(measurementPayload(measurement)) });
    return measurement;
  };
  f.measurement = await f.addMeasurement({ now: '2026-11-02T11:59:59.000Z' });
  if (history) for (const candidate of candidates) {
    const cid = randomUUID(), did = randomUUID(), remoteId = BigInt('0x' + randomUUID().replaceAll('-', '')).toString().slice(0, 20);
    const historyDelivery = { ...candidate.deliveries[0], id: did, campaignId: cid, remoteId, remoteRefs: { campaignId: remoteId, adId: remoteId + '1' } };
    const m = improvementMeasurement(candidate.spec, historyDelivery, { now: candidate.measurements[0].fetchedAt, id: randomUUID(), values: candidate.measurements[0].values });
    await insertRow(store, 'social_campaigns', { id: cid, connection_id: connectionId, asset_id: assetId, name: 'Historial de mejoras sintético', mode, objective, state: mode === 'paid' ? 'completed' : 'published', ...editable(candidate.spec) });
    await insertRow(store, 'social_revisions', { campaign_id: cid, revision: 1, spec_hash: candidate.specHash, approved_at: candidate.deliveries[0].publishedAt, actor_id: actorId, data: JSON.stringify({ spec: candidate.spec }) });
    await insertRow(store, 'social_deliveries', { id: did, campaign_id: cid, revision: 1, channel: delivery.channel, state: mode === 'paid' ? 'completed' : 'published', remote_id: remoteId, next_sync_at: null, ...editable(historyDelivery) });
    await insertRow(store, 'social_measurements', { id: m.id, delivery_id: did, query_key: socialMeasurementQueryKey(m), fetched_at: m.fetchedAt, payload_hash: m.payloadHash, data: JSON.stringify(measurementPayload(m)) });
  }
  return f;
}
export async function commercialFingerprint(store) {
  const tables = ['orders', 'records', 'shipments', 'shipment_events', 'expenses', 'expense_payments', 'cash_entries', 'order_returns', 'order_collections', 'counters', 'report_snapshots'];
  const data = {};
  for (const table of tables) data[table] = await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`);
  return hash(JSON.stringify(data));
}
