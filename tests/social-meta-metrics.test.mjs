import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaApiConnector, MetaApiError } from '../lib/social/meta.mjs';
import { createMetaMetricsProvider } from './social-meta-metrics-provider.mjs';
import { hash } from '../lib/business/commands.mjs';

const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' };
const query = (dimension = 'aggregate', organic = false) => ({ periodStart: '2026-11-01', periodEnd: '2026-11-02', windowStart: '2026-11-01T05:00:00.000Z', windowEnd: '2026-11-03T05:00:00.000Z', timeZone: 'America/Bogota', dimension, scope: organic ? 'organic' : 'paid', periodType: organic ? 'lifetime' : 'range', window: 'cumulative' });
const spec = (mode = 'paid', assetType = 'image', objective = 'whatsapp') => ({ identities, integrationMethod: 'api', mode, assetType, objective, currency: 'COP', timeZone: 'America/Bogota' });
const delivery = { id: 'local-delivery', channel: 'meta_ads', remoteId: '902', remoteRefs: { adId: '900', adSetId: '901', campaignId: '902' } };
async function fixture(t, selectedIdentities = identities) {
  const provider = await createMetaMetricsProvider();
  t.after(() => provider.close());
  const api = createMetaApiConnector({ connection: { integrationMethod: 'api', identities: selectedIdentities }, credentials: { accessToken: 'SYNTHETIC-PRIVATE-TOKEN-CANARY', userId: '100' }, transport: { appId: '42', appSecret: 'SYNTHETIC-SECRET-CANARY', fetchImpl: provider.fetchImpl, now: provider.now } });
  return { ...provider, api, measure: (overrides = {}) => api.fetchMeasurements({ delivery, spec: spec(), query: query(), ...overrides }) };
}
function sanitized(kind) {
  return error => {
    assert.ok(error instanceof MetaApiError);
    assert.equal(error.kind, kind);
    assert.equal(/PRIVATE|CANARY|SECRET/.test(`${error.message} ${JSON.stringify(error)}`), false);
    return true;
  };
}

test('Ads reads the approved ad, preserves exact money, fractional attributed actions and definition windows', async t => {
  const f = await fixture(t);
  const actualQuery = query();
  const { snapshots: [snapshot] } = await f.measure({ query: actualQuery });
  assert.deepEqual(snapshot.query, actualQuery);
  assert.deepEqual(snapshot.entity, { type: 'ad', id: '900' });
  assert.deepEqual(snapshot.attributionSetting, f.state.attribution);
  assert.equal(snapshot.actionReportTime, 'impression');
  assert.equal(snapshot.values.spendMinor.value, 10_000_000);
  assert.equal(snapshot.values.linkClicks.value, 100);
  assert.equal(snapshot.values.conversations.value, 10.5);
  assert.equal(snapshot.values.interactions.value, 125.5);
  assert.equal(snapshot.values.videoP75.value, 30);
  assert.equal(snapshot.values.conversations.sourceMetric, 'actions.onsite_conversion.messaging_conversation_started_7d');
  assert.equal(snapshot.coverage.complete, true);
  assert.deepEqual(snapshot.rows, []);
  assert.equal(JSON.stringify(snapshot).includes('fb_pixel_purchase'), false);
  assert.equal(JSON.stringify(snapshot).includes('CANARY'), false);
  const insightCall = f.calls.find(call => call.path === '900/insights');
  assert.deepEqual(JSON.parse(insightCall.params.time_range), { since: '2026-11-01', until: '2026-11-02' });
  assert.equal(insightCall.params.window, undefined);
});

test('Missing action is not zero, first reply is not a conversation and zero is explicit', async t => {
  const f = await fixture(t);
  f.state.actions = [{ action_type: 'onsite_conversion.messaging_first_reply', value: '500' }, { action_type: 'post_engagement', value: '0' }];
  let snapshot = (await f.measure()).snapshots[0];
  assert.equal(snapshot.values.conversations.value, null);
  assert.equal(snapshot.values.conversations.status, 'unavailable');
  assert.equal(snapshot.values.interactions.value, 0);
  f.state.actions.push({ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '0' });
  snapshot = (await f.measure()).snapshots[0];
  assert.equal(snapshot.values.conversations.value, 0);
  snapshot = (await f.measure({ spec: spec('paid', 'image', 'traffic') })).snapshots[0];
  assert.equal(snapshot.values.conversations.value, null);
  assert.equal(snapshot.values.conversations.status, 'unsupported');
  f.state.attribution = null;
  snapshot = (await f.measure()).snapshots[0];
  assert.equal(snapshot.values.conversations.value, null);
  assert.equal(snapshot.values.spendMinor.value, 10_000_000);
  assert.equal(snapshot.coverage.complete, false);
});

test('Money remains exact for COP and USD and malformed decimal/grouping is unavailable', async t => {
  const f = await fixture(t);
  for (const [raw, expected] of [['0', 0], ['0.29', 29], ['100000.01', 10_000_001], ['1,234', null], ['12.001', null], ['100000000000.01', null]]) {
    f.state.spend = raw;
    assert.equal((await f.measure()).snapshots[0].values.spendMinor.value, expected);
  }
  f.state.currency = 'USD'; f.state.spend = '50.01';
  const snapshot = (await f.measure({ spec: { ...spec(), currency: 'USD' } })).snapshots[0];
  assert.equal(snapshot.currency, 'USD'); assert.equal(snapshot.values.spendMinor.value, 5001);
});

test('Daily, unique aggregate and each independent breakdown retain their own rows without summation', async t => {
  const f = await fixture(t); f.state.pageSize = 1;
  const aggregate = (await f.measure()).snapshots[0];
  const daily = (await f.measure({ query: query('daily') })).snapshots[0];
  assert.equal(aggregate.values.reach.value, 1000);
  assert.deepEqual(daily.rows.map(row => row.values.reach.value), [800, 800]);
  assert.deepEqual(daily.values, {}); assert.equal(daily.coverage.complete, true);
  assert.deepEqual(daily.rows.map(row => row.dimensions.date), ['2026-11-01', '2026-11-02']);
  const placement = (await f.measure({ query: query('placement') })).snapshots[0];
  assert.deepEqual(placement.rows.map(row => row.dimensions), [{ publisherPlatform: 'facebook', placement: 'feed' }, { publisherPlatform: 'instagram', placement: 'reels' }]);
  const age = (await f.measure({ query: query('age_gender') })).snapshots[0];
  const country = (await f.measure({ query: query('country') })).snapshots[0];
  assert.deepEqual(age.rows[0].dimensions, { age: '25-34', gender: 'female' });
  assert.deepEqual(country.rows[0].dimensions, { country: 'CO' });
});

test('An interrupted second page preserves evidence as partial but denied/rate-limited pages propagate', async t => {
  const f = await fixture(t); f.state.pageSize = 1;
  f.state.secondPageError = { code: 2, status: 503 };
  const partial = (await f.measure({ query: query('daily') })).snapshots[0];
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.rows[0].values.spendMinor.value, 5_000_000);
  assert.equal(partial.rows[0].dimensions.date, '2026-11-01');
  assert.deepEqual(partial.values, {});
  for (const [code, status, kind] of [[190, 400, 'reconnect_required'], [200, 403, 'permission'], [4, 429, 'rate_limit']]) {
    f.state.secondPageError = { code, status };
    await assert.rejects(() => f.measure({ query: query('daily') }), sanitized(kind));
  }
});

test('A retired field is isolated, cached only for its version/type/dimension, and does not erase spend', async t => {
  const f = await fixture(t); f.state.invalidMetrics.add('video_p50_watched_actions');
  const first = await f.measure();
  assert.equal(first.snapshots[0].values.videoP50.status, 'unsupported');
  assert.equal(first.snapshots[0].values.spendMinor.value, 10_000_000);
  const before = f.calls.length;
  const second = await f.measure({ knownUnsupported: first.unsupportedMetrics });
  assert.equal(second.snapshots[0].values.videoP50.status, 'unsupported');
  assert.equal(f.calls.slice(before).filter(call => call.path === '900/insights').some(call => call.params.fields.includes('video_p50_watched_actions')), false);
  assert.equal((await f.measure({ query: query('daily'), knownUnsupported: first.unsupportedMetrics })).snapshots[0].rows[0].values.videoP50.status, 'unsupported');
});

test('Generic code 100, permission, revoked token and rate failures never become unsupported metrics', async t => {
  const f = await fixture(t);
  for (const [code, status, kind, message] of [[100, 400, 'rejected', 'Invalid time_range SYNTHETIC-PRIVATE-TOKEN-CANARY'], [10, 403, 'permission', 'Denied'], [190, 400, 'reconnect_required', 'Expired'], [4, 429, 'rate_limit', 'Throttled']]) {
    f.state.metricError = { code, status, message };
    await assert.rejects(() => f.measure(), sanitized(kind));
  }
  f.state.metricError = null;
  f.state.permissions = f.state.permissions.filter(permission => !['ads_read', 'ads_management'].includes(permission));
  await assert.rejects(() => f.measure(), sanitized('permission'));
});

test('Wrong object ownership, currency, date or ad ID cannot masquerade as a complete result', async t => {
  const f = await fixture(t);
  for (const [flag, kind] of [['wrongOwner', 'account_mismatch'], ['wrongAdId', 'account_mismatch'], ['wrongDate', 'invalid_response']]) {
    f.state[flag] = true; await assert.rejects(() => f.measure(), sanitized(kind)); f.state[flag] = false;
  }
  await assert.rejects(() => f.measure({ spec: { ...spec(), currency: 'USD' } }), sanitized('account_mismatch'));
  f.state.duplicateAggregate = true;
  const ambiguous = (await f.measure()).snapshots[0];
  assert.equal(ambiguous.coverage.complete, false); assert.equal(ambiguous.values.reach.value, null);
});

test('Instagram image and Reel use organic lifetime definitions and do not invent missing metrics or watch-time units', async t => {
  const f = await fixture(t);
  delete f.instagram.shares;
  const imageDelivery = { id: 'ig-image', channel: 'instagram', remoteId: '310', remoteRefs: { mediaId: '310' } };
  let image = (await f.measure({ delivery: imageDelivery, spec: spec('organic'), query: query('aggregate', true) })).snapshots[0];
  assert.equal(image.scope, 'organic'); assert.equal(image.values.views.value, 1200);
  assert.equal(image.values.comments.value, 0); assert.equal(image.values.shares.value, null);
  assert.equal(image.values.reach.value, 900.5);
  const reelDelivery = { id: 'ig-reel', channel: 'instagram', remoteRefs: { mediaId: '311' } };
  const reel = (await f.measure({ delivery: reelDelivery, spec: spec('organic', 'video'), query: query('aggregate', true) })).snapshots[0];
  assert.equal(reel.values.skipRate.value, 12.5);
  assert.equal(reel.values.averageWatchTime.value, null);
  assert.equal(reel.values.averageWatchTime.reason, 'unit_not_documented');
  assert.equal(reel.values.totalWatchTime.value, null);
  f.state.metricDescriptions.ig_reels_avg_watch_time = 'The average amount of time, in milliseconds, spent playing the reel.';
  f.state.metricDescriptions.ig_reels_video_view_total_time = 'Total watch time in seconds.';
  const defined = (await f.measure({ delivery: reelDelivery, spec: spec('organic', 'video'), query: query('aggregate', true) })).snapshots[0];
  assert.equal(defined.values.averageWatchTime.value, 4021);
  assert.equal(defined.values.averageWatchTime.unit, 'milliseconds');
  assert.equal(defined.values.totalWatchTime.value, 150000);
  assert.equal(defined.values.totalWatchTime.unit, 'seconds');
  assert.equal(defined.evidence.metricUnits.ig_reels_avg_watch_time.source, 'metric.description');
  assert.equal(f.calls.filter(call => call.path.endsWith('/insights')).some(call => /impressions|total_views|total_likes|total_comments/.test(call.params.metric || '')), false);
  const unsupported = (await f.measure({ delivery: imageDelivery, spec: spec('organic'), query: query('daily', true) })).snapshots[0];
  assert.equal(unsupported.coverage.complete, false); assert.deepEqual(unsupported.rows, []);
  f.state.permissions = f.state.permissions.filter(permission => permission !== 'instagram_manage_insights');
  await assert.rejects(() => f.measure({ delivery: imageDelivery, spec: spec('organic'), query: query('aggregate', true) }), sanitized('permission'));
});

test('Facebook feed separates verified organic views from mixed counts and refuses undocumented numeric scope encodings', async t => {
  const f = await fixture(t);
  const args = { delivery: { id: 'fb-image', channel: 'facebook', remoteRefs: { postId: '200_400' } }, spec: spec('organic'), query: query('aggregate', true) };
  let { snapshots } = await f.measure(args);
  let organic = snapshots.find(snapshot => snapshot.scope === 'organic'), mixed = snapshots.find(snapshot => snapshot.scope === 'mixed');
  assert.equal(organic.values.views.value, 1200);
  assert.equal(mixed.values.views.value, 2000); assert.equal(mixed.values.reach.value, 1000);
  assert.equal(mixed.values.linkClicks.value, 0); assert.equal(mixed.values.comments.value, 4); assert.equal(mixed.values.shares.value, 3);
  assert.equal(mixed.values.reactions.value, 13);
  assert.equal(organic.values.reach, undefined);
  f.state.numericAdsEncoding = true;
  snapshots = (await f.measure(args)).snapshots;
  organic = snapshots.find(snapshot => snapshot.scope === 'organic'); mixed = snapshots.find(snapshot => snapshot.scope === 'mixed');
  assert.equal(organic.values.views.value, null); assert.equal(organic.coverage.complete, false);
  assert.equal(mixed.values.views.value, 2000);
  assert.equal(f.calls.filter(call => call.path === '200_400/insights').some(call => call.params.metric.includes('post_impressions_unique')), false);
});

test('Facebook Reels use video_insights with their documented v26 reach/time and keep mixed social metrics distinct', async t => {
  const f = await fixture(t);
  const { snapshots: [reel] } = await f.measure({ delivery: { id: 'fb-reel', channel: 'facebook', remoteRefs: { videoId: '410' } }, spec: spec('organic', 'video'), query: query('aggregate', true) });
  assert.equal(reel.scope, 'mixed'); assert.equal(reel.values.plays.value, 5000);
  assert.equal(reel.values.reach.value, 2500.5); assert.equal(reel.values.reach.sourceMetric, 'post_impressions_unique');
  assert.equal(reel.values.averageWatchTime.value, 1250.5); assert.equal(reel.values.averageWatchTime.unit, 'milliseconds');
  assert.equal(reel.values.comments.value, 5); assert.equal(reel.values.shares.value, 2);
  assert.equal(reel.values.interactions, undefined); assert.equal(reel.values.views, undefined);
  assert.equal(reel.values.videoRetentionAt1.value, 75.5);
  assert.equal(reel.values.videoRetentionAt1.unit, 'percent');
  assert.equal(reel.values.videoRetentionAt1.sourceMetric, 'post_video_retention_graph.segment=1');
  assert.equal(f.calls.some(call => call.path === '410/video_insights' && call.params.metric.includes('post_impressions_unique')), true);
});

test('Organic capability failures stay localized and image cache never suppresses Reel metrics', async t => {
  const f = await fixture(t);
  const image = { delivery: { id: 'ig-image', channel: 'instagram', remoteRefs: { mediaId: '310' } }, spec: spec('organic'), query: query('aggregate', true) };
  f.state.invalidMetrics.add('shares');
  const first = await f.measure(image);
  assert.equal(first.snapshots[0].values.shares.status, 'unsupported');
  assert.equal(first.snapshots[0].values.views.value, 1200);
  assert.equal(first.snapshots[0].values.comments.value, 0);
  f.state.invalidMetrics.clear();
  f.instagram.shares = 9;
  const cached = await f.measure({ ...image, knownUnsupported: first.unsupportedMetrics });
  assert.equal(cached.snapshots[0].values.shares.value, null);
  const historicSpec = spec('organic', 'video'); delete historicSpec.assetType;
  const reel = await f.measure({ delivery: { id: 'ig-reel', channel: 'instagram', remoteRefs: { mediaId: '311' }, assetType: 'video' }, spec: historicSpec, query: query('aggregate', true), knownUnsupported: first.unsupportedMetrics });
  assert.equal(reel.snapshots[0].values.shares.value, 9);
  f.state.invalidMetrics.add('post_media_view');
  const facebook = await f.measure({ delivery: { id: 'fb-image', channel: 'facebook', remoteRefs: { postId: '200_400' } }, spec: spec('organic'), query: query('aggregate', true) });
  assert.equal(facebook.snapshots.find(snapshot => snapshot.scope === 'organic').values.views.status, 'unsupported');
  assert.equal(facebook.snapshots.find(snapshot => snapshot.scope === 'mixed').values.reach.value, 1000);
});

test('Organic insights need no approved business/ad-account identity and preserve explicit observation metadata', async t => {
  const organicIdentities = { userId: '100', pageId: '200', instagramId: '300' };
  const f = await fixture(t, organicIdentities);
  const observation = { ...query('aggregate', true), timeZone: 'UTC', timeZoneSource: 'observation_utc', publicationTimeSource: 'confirmed_remote', anchorAt: '2026-11-01T05:00:00.000Z' };
  const result = await f.measure({
    delivery: { id: 'ig-image', channel: 'instagram', remoteRefs: { mediaId: '310' } },
    spec: { ...spec('organic'), identities: organicIdentities, currency: null, timeZone: null },
    query: observation
  });
  assert.equal(result.snapshots[0].values.views.value, 1200);
  assert.deepEqual(result.snapshots[0].query, observation);
  assert.equal(result.snapshots[0].timeZone, 'UTC');
});

test('Ads measurements survive losing Page/Instagram publishing access without authorizing a write', async t => {
  const f = await fixture(t);
  f.state.hidePages = true;
  f.state.permissions = ['ads_read'];
  const { snapshots: [snapshot] } = await f.measure();
  assert.equal(snapshot.values.spendMinor.value, 10_000_000);
  assert.equal(snapshot.coverage.complete, true);
  const status = await f.api.validateConnection({ purpose: 'insights', channel: 'meta_ads' });
  assert.equal(status.identities.businessId, '500');
  assert.equal(status.capabilities.insights, true);
  assert.equal(status.capabilities.adsPublish, false);
  assert.equal(status.capabilities.facebookPublish, false);
  assert.equal(status.capabilities.instagramPublish, false);
  let sent = false;
  const frozen = spec();
  await assert.rejects(() => f.api.executeStep({
    operation: { channel: 'meta_ads', deliveryId: 'local-delivery', state: 'prepared', step: 'create_campaign', specHash: hash(frozen), remoteRefs: {} },
    spec: frozen, beforeSend: () => { sent = true; }
  }), sanitized('account_mismatch'));
  assert.equal(sent, false);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  f.state.adTasks = ['DRAFT'];
  await assert.rejects(() => f.measure(), sanitized('permission'));
});

test('Page insights survive losing the selected ad account and enforce the actual resource business', async t => {
  const f = await fixture(t);
  f.state.hideAdAccounts = true;
  f.state.permissions = ['pages_show_list', 'pages_read_engagement', 'read_insights'];
  const args = { delivery: { id: 'fb-image', channel: 'facebook', remoteRefs: { postId: '200_400' } }, spec: spec('organic'), query: query('aggregate', true) };
  const { snapshots } = await f.measure(args);
  assert.equal(snapshots.find(snapshot => snapshot.scope === 'mixed').values.reach.value, 1000);
  const status = await f.api.validateConnection({ purpose: 'insights', channel: 'facebook' });
  assert.equal(status.identities.adAccountId, undefined);
  assert.equal(status.identities.businessId, '500');
  f.state.pageBusinessId = '999';
  await assert.rejects(() => f.measure(args), sanitized('account_mismatch'));
  f.state.pageBusinessId = '500'; f.state.pageTasks = ['CREATE_CONTENT'];
  await assert.rejects(() => f.measure(args), sanitized('permission'));
});

test('Ads insights compare approved business with account evidence instead of copying the selected identity', async t => {
  const f = await fixture(t);
  f.state.adBusinessId = '999';
  await assert.rejects(() => f.measure(), sanitized('account_mismatch'));
});
