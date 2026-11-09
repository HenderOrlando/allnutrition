import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBrowserRuntime } from '../lib/social/browser-runtime.mjs';
import { createBrowserClient } from '../lib/social/browser-client.mjs';
import { createMetaBrowserConnector } from '../lib/social/meta-browser.mjs';
import { createSocialBrowserProvider } from './social-browser-provider.mjs';

const identities = { userId: '101', businessId: '202', pageId: '303', instagramId: '404', adAccountId: '505' };
const baseQuery = { periodStart: '2026-10-01', periodEnd: '2026-10-31', windowStart: '2026-10-01T05:00:00.000Z', windowEnd: '2026-11-01T04:59:59.999Z', timeZone: 'America/Bogota', dimension: 'aggregate', scope: 'paid', periodType: 'range', window: 'cumulative' };
const errorCode = code => error => error.errorCode === code;
async function environment(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-measurement-')), provider = await createSocialBrowserProvider(), controlKey = randomBytes(32);
  const runtime = await createBrowserRuntime({ chromium, keyring: { read: async name => name === 'control' ? controlKey : assert.fail('Runner requested a non-control key') }, mediaRoot: root, allowedOrigins: [provider.origin] });
  const server = createServer((req, res) => { void runtime.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await provider.close(); await rm(root, { recursive: true, force: true }); });
  const session = { connectionId: 'metrics-connection', sessionEpoch: 1, lease: { key: 'social:browser-lock:metrics-connection', token: randomBytes(24).toString('base64url'), leaseUntil: new Date(Date.now() + 120000).toISOString() } };
  const client = createBrowserClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, controlKey, runtime: { configurationVersion: 1, browserEnabled: true, publishingEnabled: false } }).forSession(session);
  await client.open({ payload: { purpose: 'login' } });
  await client.input({ payload: { sequence: 1, input: { kind: 'type', text: 'admin@example.test' } } });
  await client.input({ payload: { sequence: 2, input: { kind: 'key', key: 'Tab' } } });
  await client.input({ payload: { sequence: 3, input: { kind: 'type', text: 'password-canary-2fa' } } });
  await client.input({ payload: { sequence: 4, input: { kind: 'key', key: 'Enter' } } });
  await client.inspect({ payload: { kind: 'connection', expectedIdentities: identities } });
  const storageState = (await client.exportState()).data.storageState;
  await client.close();
  const connector = createMetaBrowserConnector({ client, connection: { id: session.connectionId, sessionEpoch: 1, integrationMethod: 'browser', identities }, credentials: { storageState } });
  const object = provider.seedMeasurementObject();
  const delivery = { id: 'delivery-metrics', channel: 'meta_ads', remoteId: object.id, remoteRefs: { campaignId: object.id, adId: object.adId } };
  const spec = { mode: 'paid', objective: 'whatsapp', currency: 'COP', identities, budgetMinor: 5000000 };
  const measure = async (query = baseQuery, extra = {}) => connector.fetchMeasurements({ delivery, spec, query, ...extra });
  return { provider, connector, delivery, spec, object, measure };
}

test('medición firmada con Chromium lee export exacto sin pieza/caption ni credenciales API, conserva query y fuente', async t => {
  const apiKeys = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'];
  const previous = Object.fromEntries(apiKeys.map(key => [key, process.env[key]]));
  for (const key of apiKeys) delete process.env[key];
  t.after(() => { for (const key of apiKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const env = await environment(t);
  env.provider.state.metricTooltips = { Impressions: 'Number of times the advertisement appeared on screen' };
  const result = await env.measure(), snapshot = result.snapshots[0];
  assert.equal(snapshot.values.spendMinor.value, 10000000);
  assert.equal(snapshot.values.impressions.value, 4000);
  assert.equal(snapshot.values.reach.value, 3000);
  assert.equal(snapshot.values.linkClicks.value, 100);
  assert.equal(snapshot.values.conversations.value, 10);
  assert.equal(snapshot.values.frequency.value, null);
  assert.equal(snapshot.coverage.complete, true);
  assert.deepEqual(snapshot.query, baseQuery);
  assert.equal(snapshot.periodStart, baseQuery.windowStart);
  assert.equal(snapshot.periodEnd, baseQuery.windowEnd);
  assert.equal(snapshot.entity.id, env.object.id);
  assert.equal(snapshot.adapterVersion, 'meta-ui-v2');
  assert.equal(snapshot.apiVersion, null);
  assert.equal(new URL(snapshot.evidence.sourcePage).search, '');
  assert.equal(snapshot.values.conversations.sourceMetric, 'WhatsApp conversations started');
  assert.deepEqual(snapshot.evidence.columnDefinitions, [{ label: 'Impressions', tooltip: 'Number of times the advertisement appeared on screen' }]);
  assert.equal(snapshot.evidence.externalDOMVerified, false);
  assert.equal(env.provider.state.activationCount, 0);
  assert.equal(env.provider.state.publishCount, 0);
  env.provider.state.unknownAttribution = true;
  const incomplete = (await env.measure()).snapshots[0];
  assert.equal(incomplete.coverage.complete, false);
  assert.equal(incomplete.coverage.reason, 'unknown_attribution');
  assert.equal(incomplete.values.spendMinor.value, 10000000);
});

test('dimensiones cinco, páginas y filas virtuales guardan filas separadas y cobertura probada', async t => {
  const env = await environment(t);
  env.provider.state.metricDimensions = ['none', 'day', 'placement', 'age_gender', 'country'];
  for (const dimension of ['placement', 'age_gender', 'country']) {
    env.provider.state.exportRows = 2;
    const snapshot = (await env.measure({ ...baseQuery, dimension })).snapshots[0];
    assert.deepEqual(snapshot.values, {});
    assert.equal(snapshot.coverage.complete, true);
    assert.equal(snapshot.rows.length, 2);
    if (dimension === 'placement') assert.deepEqual(snapshot.rows.map(row => row.dimensions.publisherPlatform), ['facebook', 'instagram']);
    if (dimension === 'country') assert.deepEqual(snapshot.rows.map(row => row.dimensions.country), ['CO', 'US']);
    if (dimension === 'age_gender') assert.deepEqual(snapshot.rows.map(row => row.dimensions.age), ['25-34', '35-44']);
  }
  env.provider.state.exportAvailable = false; env.provider.state.exportRows = 5;
  const paged = (await env.measure({ ...baseQuery, dimension: 'daily' })).snapshots[0];
  assert.equal(paged.coverage.complete, true);
  assert.deepEqual(paged.rows.map(row => row.dimensions.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  env.provider.state.virtualRows = true;
  const virtual = (await env.measure({ ...baseQuery, dimension: 'daily' })).snapshots[0];
  assert.equal(virtual.coverage.complete, true);
  assert.equal(virtual.coverage.rowCount, 5);
  assert.equal(virtual.rows[0].values.reach.value, 3000);
  env.provider.state.virtualRows = false; env.provider.state.stopPagination = true;
  const partial = (await env.measure({ ...baseQuery, dimension: 'daily' })).snapshots[0];
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.rowCount, 2);
  assert.equal(partial.coverage.reason, 'incomplete_rows');
  env.provider.state.metricDimensions = ['none', 'day'];
  const unsupported = await env.measure({ ...baseQuery, dimension: 'country' });
  assert.deepEqual(unsupported.unsupportedMetrics, ['dimension:country']);
  assert.equal(unsupported.snapshots[0].coverage.reason, 'unsupported_breakdown');
});

test('formato/precisión/ausencias visibles no inventan ceros ni conversaciones genéricas', async t => {
  const env = await environment(t);
  env.provider.state.numberFormat = '1.234,56'; env.provider.state.csvSeparator = ';';
  env.provider.state.metricValues = { 'Amount spent': '100.000,25', Impressions: '1,2 mil', Reach: '—', 'Link clicks': '0', 'WhatsApp conversations started': '' };
  const snapshot = (await env.measure()).snapshots[0];
  assert.equal(snapshot.values.spendMinor.value, 10000025);
  assert.equal(snapshot.values.impressions.value, 1200);
  assert.equal(snapshot.values.impressions.precision, 'rounded');
  assert.equal(snapshot.values.reach.value, null);
  assert.equal(snapshot.values.linkClicks.value, 0);
  assert.equal(snapshot.values.conversations.value, null);
  env.provider.state.numberFormat = 'unverified';
  const unknown = (await env.measure()).snapshots[0];
  assert.equal(unknown.values.spendMinor.reason, 'number_format_unverified');
  env.provider.state.metricHeaders = ['Campaign ID', 'Reporting starts', 'Reporting ends', 'Amount spent', 'Results', 'Customer name', 'Comment text'];
  env.provider.state.metricValues = { 'Amount spent': '0', Results: '99', 'Customer name': 'person-canary', 'Comment text': 'private-canary' };
  const generic = (await env.measure()).snapshots[0];
  assert.equal(generic.values.conversations.value, null);
  assert.equal(JSON.stringify(generic).includes('person-canary'), false);
  assert.equal(JSON.stringify(generic).includes('private-canary'), false);
});

test('orgánico video mantiene scope mixto y métricas propias sin exigir archivo o comparar caption', async t => {
  const env = await environment(t), object = env.provider.seedMeasurementObject({ kind: 'organic', channel: 'instagram', video: true });
  env.provider.state.metricScope = 'Mixed';
  const query = { ...baseQuery, scope: 'organic', periodType: 'lifetime' };
  const snapshot = (await env.connector.fetchMeasurements({ delivery: { id: 'organic-record', remoteId: object.id, channel: 'instagram', assetType: 'video' }, spec: { mode: 'organic', objective: 'traffic', caption: 'changed local caption', assetType: 'video', identities }, query })).snapshots[0];
  assert.equal(snapshot.scope, 'mixed');
  assert.equal(snapshot.query.scope, 'organic');
  assert.equal(snapshot.values.views.value, 4500);
  assert.equal(snapshot.values.plays.value, 4200);
  assert.equal(snapshot.values.comments.value, 0);
  assert.equal(snapshot.values.averageWatchTime.value, 2.125);
  assert.equal(snapshot.values.averageWatchTime.unit, 'seconds');
  assert.equal(snapshot.values.totalWatchTime.value, 8925.5);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.values.conversations.value, null);
  assert.equal(snapshot.values.conversations.status, 'unsupported');
  assert.equal(snapshot.values.conversations.reason, 'organic_attribution_unavailable');
  assert.equal(env.provider.state.publishCount, 0);
});

test('zona orgánica observada conserva diferencia frente a ancla UTC sin inventar una ventana completa', async t => {
  const env = await environment(t), object = env.provider.seedMeasurementObject({ kind: 'organic', channel: 'facebook' });
  const query = { ...baseQuery, scope: 'organic', periodType: 'lifetime', timeZone: 'UTC', timeZoneSource: 'observation_utc',
    publicationTimeSource: 'delivery_created_at', anchorAt: '2026-10-01T00:00:00.000Z', windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-31T23:59:59.999Z' };
  const snapshot = (await env.connector.fetchMeasurements({ delivery: { id: 'organic-utc-record', remoteId: object.id, channel: 'facebook', assetType: 'image' }, spec: { mode: 'organic', objective: 'reach', assetType: 'image', identities }, query })).snapshots[0];
  assert.deepEqual(snapshot.query, query);
  assert.equal(snapshot.timeZone, 'America/Bogota');
  assert.equal(snapshot.periodStart, query.windowStart);
  assert.equal(snapshot.coverage.complete, false);
  assert.equal(snapshot.coverage.reason, 'observation_time_zone_mismatch');
  assert.deepEqual(snapshot.evidence.timeZoneMismatch, { requested: 'UTC', reported: 'America/Bogota' });
  assert.deepEqual(snapshot.evidence.reportedPeriod, { periodStart: '2026-10-01', periodEnd: '2026-10-31', timeZone: 'America/Bogota' });
  assert.equal(snapshot.values.reach.value, 3000);
});

test('cuenta, ID exportado, moneda, período, zona y sesión inválidos bloquean sin efectos', async t => {
  const env = await environment(t);
  env.provider.state.metricRemoteId = '999999'; await assert.rejects(env.measure(), errorCode('ACCOUNT_MISMATCH')); delete env.provider.state.metricRemoteId;
  env.provider.state.metricFrom = '2026-09-01'; await assert.rejects(env.measure(), errorCode('SPEC_MISMATCH')); delete env.provider.state.metricFrom;
  env.provider.state.metricCurrency = 'USD'; await assert.rejects(env.measure(), errorCode('SPEC_MISMATCH')); delete env.provider.state.metricCurrency;
  env.provider.state.metricTimeZone = 'UTC'; await assert.rejects(env.measure(), errorCode('SPEC_MISMATCH')); delete env.provider.state.metricTimeZone;
  env.provider.state.adAccountId = '999'; await assert.rejects(env.measure(), errorCode('ACCOUNT_MISMATCH')); env.provider.state.adAccountId = '505';
  env.provider.state.challenge = true; await assert.rejects(env.measure(), errorCode('CHALLENGE_REQUIRED')); env.provider.state.challenge = false;
  env.provider.expireSessions(); await assert.rejects(env.measure(), errorCode('SESSION_EXPIRED'));
  assert.equal(env.provider.state.activationCount, 0);
});
