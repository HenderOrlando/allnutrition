import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { saveSocialCampaign } from '../lib/business/social.mjs';
import { buildSocialSpec } from '../lib/business/social-spec.mjs';
import { estimateSocialCampaign, analyzeSocialCampaign } from '../lib/business/social-analysis.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { META_PERMISSIONS } from '../lib/social/config.mjs';
import { queueJobTx, claimJob } from '../lib/business/job-leases.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';

const NOW = '2026-11-02T12:00:00.000Z', START = '2026-11-03T12:00:00.000Z', END = '2026-11-10T12:00:00.000Z';
const OLD_START = '2026-10-01T12:00:00.000Z', OLD_END = '2026-10-08T12:00:00.000Z';
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: NOW, updated_at: NOW });
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const metric = (value, sourceMetric = 'synthetic_link_clicks', unit = 'count') => ({ value, sourceMetric, unit, status: 'reported', precision: 'exact', displayValue: String(value), reason: null });
async function patch(store, table, id, values, bump = false) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?${bump ? ',version=version+1' : ''} WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...values }), id]);
}
async function fixture(store, { method = 'api', mode = 'paid', objective = 'traffic' } = {}) {
  // Synthetic transport has its own fixed identity, budget-independent audience
  // and allowed GET surface. No real provider request can leave this fixture.
  const remote = { calls: [], beforeEstimate: null, audience: { users_lower_bound: 10000, users_upper_bound: 20000, estimate_ready: true } };
  const env = { META_APP_ID: '42', META_APP_SECRET: 'SYNTHETIC-FORECAST-SECRET', META_GRAPH_VERSION: 'v26.0', SOCIAL_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  await configureSocialTestRuntime(store, { env });
  const actorId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  const identities = { userId: '100', businessId: '500', pageId: '200', adAccountId: method === 'api' ? 'act_400' : '400' };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: method, state: 'connected', ...editable({ identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { facebookPublish: true, adsPublish: true, insights: true } }) });
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: 'a'.repeat(64), bytes: 100, ...editable({ name: 'Imagen sintética', kind: 'image', derivativeSha256: 'a'.repeat(64) }) });
  if (method === 'api') await saveCredentials(store, connectionId, { accessToken: 'SYNTHETIC-FORECAST-TOKEN', userId: '100' }, { runtime: (await configureSocialTestRuntime(store, { env })).runtime });
  remote.fetchImpl = async (href, init) => {
    const url = new URL(href), path = url.pathname.replace('/v26.0/', '');
    assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(init.method, 'GET'); remote.calls.push({ path, targeting: url.searchParams.get('targeting_spec') });
    let data;
    if (path === 'debug_token') data = { data: { app_id: '42', type: 'USER', is_valid: true, user_id: '100', expires_at: Date.parse(NOW) / 1000 + 86400, data_access_expires_at: Date.parse(NOW) / 1000 + 86400, scopes: META_PERMISSIONS } };
    else if (path === 'me') data = { id: '100', name: 'Actor sintético' };
    else if (path === 'me/permissions') data = { data: META_PERMISSIONS.map(permission => ({ permission, status: 'granted' })) };
    else if (path === 'me/accounts') data = { data: [{ id: '200', tasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'], access_token: 'SYNTHETIC-PAGE-TOKEN', business: { id: '500' } }] };
    else if (path === 'me/adaccounts') data = { data: [{ id: 'act_400', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: ['ADVERTISE'], business: { id: '500' } }] };
    else if (path === 'act_400/reachestimate') { if (remote.beforeEstimate) await remote.beforeEstimate(); data = { data: [remote.audience] }; }
    else assert.fail(`Unexpected synthetic request ${path}`);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  const saved = await saveSocialCampaign(store, { name: 'Pronóstico sintético', connectionId, assetId, mode, objective, platforms: ['facebook'], placements: ['facebook_feed'],
    caption: 'Texto aportado', destinationUrl: mode === 'paid' && objective === 'traffic' ? 'https://example.test/products' : '', audience: { countries: ['CO'], regions: [], cities: [], interests: [], ageMin: 18, ageMax: 65, genders: [] },
    budgetMinor: mode === 'paid' ? 5000000 : 0, startAt: mode === 'paid' ? START : null, endAt: mode === 'paid' ? END : null, observationDays: 7, aiDisclosure: false, requestId: randomUUID() }, actorId, { env, now: NOW });
  const campaign = await get(store, 'social_campaigns', saved.id), connection = await get(store, 'social_connections', connectionId), asset = await get(store, 'social_assets', assetId);
  const built = buildSocialSpec(campaign, { connection, asset, now: NOW });
  const f = { store, env, actorId, connectionId, assetId, campaign, ...built, remote };
  f.estimate = (options = {}) => estimateSocialCampaign(store, f.campaign.id, { version: f.campaign.version, requestId: randomUUID(), env, now: NOW, transport: { fetchImpl: remote.fetchImpl }, ...options }, actorId);
  return f;
}
function measurementData(spec, value, { organic = false, end = OLD_END } = {}) {
  return { integrationMethod: spec.integrationMethod, adapterVersion: `synthetic-${spec.integrationMethod}-v1`, apiVersion: spec.integrationMethod === 'api' ? 'v26.0' : null,
    definitionVersion: 'synthetic-click-definition-v1', query: { dimension: 'aggregate', window: organic ? 'horizon' : 'cumulative', periodType: organic ? 'lifetime' : 'range', timeZoneSource: 'account',
      ...(organic ? { horizon: 7, anchorAt: OLD_START, publicationTimeSource: 'publication_request_sent_at' } : {}) },
    periodStart: OLD_START, periodEnd: end, timeZone: 'America/Bogota', currency: 'COP', scope: organic ? 'organic' : 'paid',
    attributionSetting: organic ? null : ['7d_click'], actionReportTime: organic ? null : 'impression', dimension: 'aggregate',
    values: { impressions: metric(4000, 'synthetic_impressions'), reach: metric(value, 'synthetic_reach'), linkClicks: metric(value), spendMinor: metric(5000000, 'spend', 'minor_currency') }, coverage: { complete: true }, evidence: {} };
}
async function addMeasurement(f, deliveryId, spec, value, options = {}) {
  const id = randomUUID(), data = measurementData(spec, value, options);
  await insertRow(f.store, 'social_measurements', { id, delivery_id: deliveryId, query_key: hash(data.query), fetched_at: options.fetchedAt || OLD_END, payload_hash: hash(data), data: JSON.stringify(data) });
  return id;
}
async function history(f, values = [100, 150, 200, 250, 300]) {
  const result = [];
  for (const value of values) {
    const id = randomUUID(), deliveryId = randomUUID(), spec = { ...f.spec, startAt: f.spec.mode === 'paid' ? OLD_START : null, endAt: f.spec.mode === 'paid' ? OLD_END : null };
    await insertRow(f.store, 'social_campaigns', { id, connection_id: f.connectionId, asset_id: f.assetId, name: 'Historial sintético', mode: spec.mode, objective: spec.objective, state: spec.mode === 'paid' ? 'completed' : 'published', ...editable({}) });
    await insertRow(f.store, 'social_revisions', { campaign_id: id, revision: 1, spec_hash: hash(spec), approved_at: OLD_START, actor_id: f.actorId, data: JSON.stringify({ spec }) });
    await insertRow(f.store, 'social_deliveries', { id: deliveryId, campaign_id: id, revision: 1, channel: spec.mode === 'paid' ? 'meta_ads' : 'facebook', state: spec.mode === 'paid' ? 'completed' : 'published', remote_id: '123', next_sync_at: null,
      ...editable({ finalizedAt: OLD_END, lastConfirmedState: 'completed', publishedAt: OLD_START, publicationTimeSource: 'publication_request_sent_at' }) });
    const measurementId = await addMeasurement(f, deliveryId, spec, value, { organic: spec.mode === 'organic' });
    result.push({ id, deliveryId, measurementId, spec });
  }
  return result;
}
async function approveFixture(f, forecast, { organic = false } = {}) {
  const spec = { ...f.spec, ...(organic ? {} : { startAt: OLD_START, endAt: OLD_END }) }, approved = { ...forecast, specHash: hash(spec), horizon: organic ? 7 : { startAt: OLD_START, endAt: OLD_END } };
  for (const range of Object.values(approved.metricRanges)) range.horizon = approved.horizon;
  const deliveryId = randomUUID();
  await insertRow(f.store, 'social_revisions', { campaign_id: f.campaign.id, revision: 1, spec_hash: hash(spec), approved_at: OLD_START, actor_id: f.actorId, data: JSON.stringify({ spec, forecastId: forecast.id, forecast: approved }) });
  await insertRow(f.store, 'social_deliveries', { id: deliveryId, campaign_id: f.campaign.id, revision: 1, channel: organic ? 'facebook' : 'meta_ads', state: organic ? 'published' : 'completed', remote_id: '456', next_sync_at: null,
    ...editable({ finalizedAt: OLD_END, lastConfirmedState: 'completed', publishedAt: OLD_START, publicationTimeSource: 'publication_request_sent_at' }) });
  return { deliveryId, spec, approved };
}
const cases = [
  ['audience GET and rational history preserve zero, replay and financial revision', async store => {
    const f = await fixture(store), records = await history(f), before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), requestId = randomUUID();
    const result = await f.estimate({ requestId }), calls = f.remote.calls.length;
    assert.equal(result.source, 'history'); assert.equal(result.metricRanges.linkClicks.lower, 150); assert.equal(result.metricRanges.linkClicks.median, 200); assert.equal(result.metricRanges.linkClicks.upper, 250);
    assert.equal(result.audienceEstimate.lower, 10000); assert.equal(result.audienceEstimate.definition, 'potential_audience');
    assert.deepEqual(JSON.parse(f.remote.calls.find(row => row.path.endsWith('/reachestimate')).targeting), f.spec.targeting);
    assert.deepEqual(await f.estimate({ requestId }), result); assert.equal(f.remote.calls.length, calls);
    assert.equal((await get(store, 'social_campaigns', f.campaign.id)).version, f.campaign.version);
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
    const saved = await get(store, 'social_forecasts', result.id); assert.equal(saved.specHash, f.specHash); assert.equal(saved.sampleCount, records.length);
    f.remote.audience = { users_lower_bound: -1, users_upper_bound: -1 };
    assert.equal((await f.estimate()).audienceEstimate.lower, null);
  }],
  ['four campaigns, mixed and rounded counts never complete the fifth sample', async store => {
    const f = await fixture(store), samples = await history(f);
    await patch(store, 'social_measurements', samples[0].measurementId, { values: { ...measurementData(f.spec, 100).values, linkClicks: { ...metric(100), precision: 'rounded', status: 'estimated' } } });
    let result = await f.estimate(); assert.equal(result.metricRanges.linkClicks, undefined); assert.equal(result.metricRanges.impressions.sampleCount, 5);
    await patch(store, 'social_measurements', samples[0].measurementId, { scope: 'mixed' });
    result = await f.estimate(); assert.equal(result.source, 'insufficient'); assert.equal(result.sampleCount, 0);
  }],
  ['scenario primary bounds and required explanation are enforced before provider reads', async store => {
    const f = await fixture(store);
    for (const manualScenario of [{ metric: 'conversations', lower: 0, upper: 5, basis: 'Declarado' }, { metric: 'linkClicks', lower: 10, upper: 5, basis: 'Declarado' }, { metric: 'linkClicks', lower: 0, upper: Infinity, basis: 'Declarado' }, { metric: 'linkClicks', lower: 0, upper: 5, basis: '' }]) await assert.rejects(() => f.estimate({ manualScenario }), { status: 400 });
    assert.equal(f.remote.calls.length, 0);
    const result = await f.estimate({ manualScenario: { metric: 'linkClicks', lower: 50, upper: 100, basis: 'Prueba declarada por administrador; no evidencia histórica' } });
    assert.equal(result.source, 'manual'); assert.equal(result.manualScenario.lower, 50); assert.equal(result.sampleCount, 0); assert.deepEqual(result.metricRanges, {});
    await assert.rejects(() => f.estimate({ requestId: 'bad' }), { status: 400 });
  }],
  ['configuration edits invalidate forecast and concurrent edits fence remote completion', async store => {
    const f = await fixture(store), initial = await f.estimate();
    await saveSocialCampaign(store, { id: f.campaign.id, version: f.campaign.version, requestId: randomUUID(), caption: 'Texto cambiado' }, f.actorId, { now: NOW });
    assert.equal((await get(store, 'social_campaigns', f.campaign.id)).forecastId, undefined);
    assert.equal((await get(store, 'social_forecasts', initial.id)).specHash, initial.specHash);
    await assert.rejects(() => f.estimate(), { status: 409 });
    f.campaign = await get(store, 'social_campaigns', f.campaign.id);
    f.remote.beforeEstimate = () => patch(store, 'social_campaigns', f.campaign.id, { caption: 'Otra edición concurrente' }, true);
    await assert.rejects(() => f.estimate(), { status: 409 });
    assert.equal((await store.db.all(`SELECT id FROM ${store.t('social_forecasts')} WHERE campaign_id=?`, [f.campaign.id])).length, 1);
  }],
  ['inactive actors cannot commit or replay an otherwise valid forecast', async store => {
    const f = await fixture(store), requestId = randomUUID(); await f.estimate({ requestId });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => f.estimate({ requestId }), { status: 403 });
    await store.db.run(`UPDATE ${store.t('users')} SET active=1 WHERE id=?`, [f.actorId]);
    f.remote.beforeEstimate = () => store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => f.estimate(), { status: 403 });
    assert.equal((await store.db.all(`SELECT id FROM ${store.t('social_forecasts')} WHERE campaign_id=?`, [f.campaign.id])).length, 1);
  }],
  ['browser reads only matching confirmed preflight without opening a browser or creating a draft', async store => {
    const f = await fixture(store, { method: 'browser' }), operationId = randomUUID(), audienceEstimate = { status: 'reported', source: 'meta_ui', definition: 'potential_audience', displayValue: '100–200', lower: 100, upper: 200, horizon: null };
    const preflight = { kind: 'validate', operationId, specHash: f.specHash, checkedAt: NOW, audienceEstimate };
    await insertRow(store, 'social_operations', { id: operationId, campaign_id: f.campaign.id, delivery_id: null, operation_key: `preflight:${f.campaign.id}:${randomUUID()}`, step: 'validate', state: 'confirmed', next_attempt_at: null,
      ...editable({ campaignVersion: f.campaign.version, specHash: f.specHash, spec: f.spec, result: { status: 'confirmed', audienceEstimate } }) });
    await patch(store, 'social_campaigns', f.campaign.id, { preflight }, true); f.campaign = await get(store, 'social_campaigns', f.campaign.id);
    const result = await f.estimate(); assert.equal(result.audienceEstimate.lower, 100); assert.equal(result.audienceEstimate.displayValue, '100–200'); assert.equal(result.audienceEstimate.fetchedAt, NOW); assert.equal(f.remote.calls.length, 0);
    await patch(store, 'social_campaigns', f.campaign.id, { preflight: { ...preflight, specHash: 'b'.repeat(64) } });
    assert.equal((await f.estimate()).audienceEstimate.status, 'unavailable');
    assert.equal((await store.db.all(`SELECT id FROM ${store.t('social_operations')}`)).length, 1);
  }],
  ['analysis selects immutable approved forecast rather than a new forecast, with finality and scheduler lease', async store => {
    const f = await fixture(store); await history(f); const original = await f.estimate(), approved = await approveFixture(f, original);
    const measurementId = await addMeasurement(f, approved.deliveryId, approved.spec, 100);
    await insertRow(store, 'social_forecasts', { id: randomUUID(), campaign_id: f.campaign.id, spec_hash: f.specHash, generated_at: NOW, data: JSON.stringify({ ...original, metricRanges: {} }) });
    const requestId = randomUUID(), result = await analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId }, f.actorId), clicks = result.comparisons.find(row => row.metric === 'linkClicks');
    assert.equal(result.forecastId, original.id); assert.equal(clicks.differenceAbsolute, -100); assert.equal(clicks.differencePercent, -50); assert.deepEqual(clicks.measurementIds, [measurementId]);
    assert.deepEqual(await analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId }, f.actorId), result);
    await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state='active' WHERE id=?`, [approved.deliveryId]);
    const active = await analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId: randomUUID() }, f.actorId);
    assert.equal(active.comparisons.find(row => row.metric === 'linkClicks').status, 'in_progress');
    await assert.rejects(() => analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId: randomUUID() }, 'scheduler'), { status: 403 });
    await store.transaction(async tx => { await tx.lockWrites(); await queueJobTx(tx, `social:analysis:${f.campaign.id}`, { actorId: 'scheduler' }, { now: NOW }); });
    const lease = await claimJob(store, { prefix: 'social:analysis:', now: NOW });
    const automated = await analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId: randomUUID(), lease: { ...lease, now: NOW } }, 'scheduler');
    assert.equal(automated.forecastId, original.id);
    await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_until=? WHERE key=?`, [OLD_END, lease.key]);
    await assert.rejects(() => analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId: randomUUID(), lease: { ...lease, now: NOW } }, 'scheduler'), { status: 409 });
  }],
  ['organic SQL keeps first horizon evidence, ignores lifetime later and reports actual age', async store => {
    const f = await fixture(store, { mode: 'organic', objective: 'reach' }), samples = await history(f), original = await f.estimate();
    assert.equal(original.metricRanges['facebook.reach'].median, 200); assert.equal(f.remote.calls.length, 0);
    for (const sample of samples) await addMeasurement(f, sample.deliveryId, sample.spec, 99999, { organic: true, end: '2026-10-30T12:00:00.000Z', fetchedAt: '2026-10-30T12:00:00.000Z' });
    assert.equal((await f.estimate()).metricRanges['facebook.reach'].median, 200);
    const approved = await approveFixture(f, original, { organic: true }); await addMeasurement(f, approved.deliveryId, approved.spec, 100, { organic: true });
    await addMeasurement(f, approved.deliveryId, approved.spec, 99999, { organic: true, end: '2026-10-30T12:00:00.000Z', fetchedAt: '2026-10-30T12:00:00.000Z' });
    const result = await analyzeSocialCampaign(store, f.campaign.id, { asOf: NOW, requestId: randomUUID() }, f.actorId), reach = result.comparisons.find(row => row.metric === 'reach');
    assert.equal(reach.reported.value, 100); assert.equal(reach.captureAgeMilliseconds, 7 * 86400000); assert.equal(reach.status, 'below');
  }]
];
export async function runSocialAnalysisContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory();
    try { await scenario(store); } finally { await store.close(); }
  });
}
