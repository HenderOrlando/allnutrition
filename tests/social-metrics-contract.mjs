import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { syncSocialDelivery, getSocialResults } from '../lib/business/social-metrics.mjs';
import { createMetaApiConnector } from '../lib/social/meta.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { createMetaMetricsProvider } from './social-meta-metrics-provider.mjs';
import { socialAccountNotBefore } from '../lib/business/social-schedule.mjs';
import { prepareCommercialBundle } from '../lib/business-backup.mjs';
import { socialCampaignAction } from '../lib/business/social.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { loadSocialRuntime } from '../lib/social/config.mjs';

const NOW = '2026-11-03T02:00:00.000Z';
const START = '2026-11-01T05:00:00.000Z';
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: START, updated_at: START });
async function patch(store, table, id, update, bump = false) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?${bump ? ',version=version+1' : ''} WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...update }), id]);
}
async function setup(store, t, { mode = 'paid', channel = 'meta_ads' } = {}) {
  const provider = await createMetaMetricsProvider(); t.after(() => provider.close());
  const actorId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID(), campaignId = randomUUID(), deliveryId = randomUUID(), assetHash = hash('metric-private-image');
  const env = {}; for (const key of ['SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY']) env[key] = randomBytes(32).toString('base64');
  await configureSocialTestRuntime(store, { env, settings: { appId: '42', appSecret: 'SYNTHETIC-SECRET-CANARY' } });
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', ...editable({ identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { insights: true, facebookPublish: false, instagramPublish: false, adsPublish: false, whatsappAds: false } }) });
  await saveCredentials(store, connectionId, { accessToken: 'SYNTHETIC-PRIVATE-TOKEN-CANARY', userId: '100' }, { runtime: (await configureSocialTestRuntime(store, { env })).runtime });
  await insertRow(store, 'social_assets', { id: assetId, state: 'missing_file', sha256: assetHash, bytes: 0, ...editable({ kind: 'image', name: 'Private image unavailable for publishing', contentType: 'image/jpeg', expectedBytes: 1, reservedBytes: 0, originalKey: `${assetId}/original.jpg`, originalSha256: hash('metric-original'), originalBytes: 1, derivativeKey: `${assetId}/derivative.jpg`, derivativeSha256: assetHash, derivativeBytes: 1, derivativeContentType: 'image/jpeg' }) });
  const spec = { name: 'Canonical measurements', integrationMethod: 'api', connectionId, assetId, assetHash, assetType: 'image', identities, mode, objective: mode === 'paid' ? 'whatsapp' : 'engagement', currency: 'COP', timeZone: 'America/Bogota', budgetMinor: mode === 'paid' ? 5000000 : null, startAt: mode === 'paid' ? START : null, endAt: mode === 'paid' ? '2026-11-08T05:00:00.000Z' : null, publishAt: mode === 'organic' ? START : null, observationDays: 7, platforms: mode === 'paid' ? ['facebook', 'instagram'] : [channel], placements: mode === 'paid' ? ['facebook_feed', 'instagram_feed'] : [`${channel}_feed`], caption: 'Owned text', headline: '', destinationUrl: '', whatsappNumber: mode === 'paid' ? '+573001234567' : '', whatsappGreeting: mode === 'paid' ? 'Consulta propia' : '', audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, aiDisclosure: false };
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connectionId, asset_id: assetId, name: spec.name, mode, objective: spec.objective, state: mode === 'paid' ? 'active' : 'published', ...editable(spec) });
  await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash(spec), actor_id: actorId, approved_at: START, data: JSON.stringify({ spec, rightsAccepted: true, acceptedWarnings: [] }) });
  const remoteId = mode === 'paid' ? '902' : channel === 'instagram' ? '310' : '200_400';
  const remoteRefs = mode === 'paid' ? { campaignId: '902', adSetId: '901', adId: '900' } : channel === 'instagram' ? { mediaId: remoteId } : { postId: remoteId };
  await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: campaignId, revision: 1, channel, state: mode === 'paid' ? 'active' : 'published', remote_id: remoteId, next_sync_at: NOW,
    ...editable({ integrationMethod: 'api', remoteRefs, everActivated: mode === 'paid', ...(mode === 'paid' ? { activatedAt: START } : { publishedAt: START, publicationTimeSource: 'provider_reported' }) }) });
  const connection = await get(store, 'social_connections', connectionId);
  const api = createMetaApiConnector({ connection, credentials: { accessToken: 'SYNTHETIC-PRIVATE-TOKEN-CANARY', userId: '100' }, runtime: await loadSocialRuntime(store, { env }), transport: { fetchImpl: provider.fetchImpl, now: provider.now } });
  const f = { ...provider, store, env, actorId, connectionId, assetId, campaignId, deliveryId, spec, api, at: NOW };
  f.delivery = () => get(store, 'social_deliveries', deliveryId);
  f.read = (options = {}) => syncSocialDelivery(store, deliveryId, { now: f.at, connector: api, configurationEvidence: { verifiedAt: f.at, differences: [] }, ...options });
  f.finish = async () => {
    let result = await f.read();
    for (let remaining = 0; (await f.delivery()).metricSync?.cycle && remaining < 10; remaining++) {
      f.at = new Date(Date.parse(f.at) + 1000).toISOString(); result = await f.read();
    }
    assert.equal((await f.delivery()).metricSync.cycle, null);
    return result;
  };
  f.results = () => getSocialResults(store, { campaignId, asOf: f.at });
  return f;
}

const cases = [
  ['un ciclo persiste consultas separadas, dinero y ratios sin requerir el archivo ni modificar hechos comerciales', async (store, t) => {
    const f = await setup(store, t), before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    await f.finish(); const results = await f.results(), aggregate = results.measurements.find(value => value.dimension === 'aggregate');
    assert.equal(aggregate.values.spendMinor.value, 10000000); assert.equal(aggregate.ratios.ctrLinkPercent.value, 2.5); assert.equal(aggregate.ratios.costPerConversationMinor.value, 952381);
    assert.equal(aggregate.values.reach.value, 1000); assert.equal(results.reachTotal, null);
    const daily = results.measurements.find(value => value.dimension === 'daily');
    assert.deepEqual(daily.rows.map(value => value.values.reach.value), [800, 800]); assert.deepEqual(daily.values, {});
    assert.deepEqual(new Set(results.measurements.map(value => value.dimension)), new Set(['aggregate', 'age_gender', 'country', 'daily', 'placement']));
    assert.equal((await f.delivery()).nextSyncAt, new Date(Date.parse(f.at) + 3600000).toISOString());
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
    for (const table of ['orders', 'expenses', 'cash_entries', 'expense_payments', 'order_collections']) assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n), 0);
    assert.equal((await get(store, 'social_assets', f.assetId)).state, 'missing_file');
  }],
  ['acciones ausentes no se vuelven cero ni usan first reply como conversaciones', async (store, t) => {
    const f = await setup(store, t); f.state.actions = [{ action_type: 'onsite_conversion.messaging_first_reply', value: '600' }];
    await f.read(); const result = (await f.results()).measurements[0];
    assert.equal(result.values.conversations.value, null); assert.equal(result.ratios.costPerConversationMinor.value, null); assert.equal(result.values.impressions.value, 4000);
    assert.equal(JSON.stringify(result).includes('messaging_first_reply'), false);
  }],
  ['una captura posterior parcial conserva la completa identificada con su fecha real sin duplicar alcance', async (store, t) => {
    const f = await setup(store, t); await f.finish();
    const complete = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    f.state.duplicateAggregate = true; f.state.pageSize = 1; f.state.secondPageError = { code: 2, status: 503 };
    f.at = '2026-11-03T03:00:30.000Z'; await f.read();
    const selected = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    assert.equal(selected.id, complete.id); assert.equal(selected.fetchedAt, complete.fetchedAt); assert.equal(selected.newerPartial, true);
    assert.equal(selected.latestAttempt.coverage.complete, false); assert.notEqual(selected.latestAttempt.id, selected.id);
    const partial = JSON.parse((await store.db.get(`SELECT data FROM ${store.t('social_measurements')} WHERE id=?`, [selected.latestAttempt.id])).data);
    assert.equal(partial.ratios.ctrLinkPercent.value, null); assert.equal(selected.values.reach.value, 1000);
  }],
  ['selección de fechas valida calendario y orden sin cambiar el corte independiente', async (store, t) => {
    const f = await setup(store, t); await f.finish();
    for (const query of [{ from: '' }, { from: '2026-02-29' }, { to: '2026-04-31' }, { from: '2026-1-01' }, { from: '2026-11-02T00:00:00Z' }, { from: 20261101 }, { from: '2026-11-03', to: '2026-11-01' }]) {
      await assert.rejects(() => getSocialResults(store, { campaignId: f.campaignId, ...query }), { status: 400 });
    }
    const result = await getSocialResults(store, { campaignId: f.campaignId, from: '2024-02-29', to: '2026-11-02', asOf: f.at });
    assert.equal(result.asOf, f.at); assert.equal(result.measurements.some(value => value.dimension === 'aggregate'), true);
    const beforeCapture = await getSocialResults(store, { campaignId: f.campaignId, from: '2026-11-01', to: '2026-11-02', asOf: START });
    assert.deepEqual(beforeCapture.measurements, []);
  }],
  ['selección diaria conserva cobertura y período originales sin recortar agregados ni sumar personas', async (store, t) => {
    const f = await setup(store, t); await f.finish();
    const original = (await f.results()).measurements.find(value => value.dimension === 'daily');
    const selected = await getSocialResults(store, { campaignId: f.campaignId, from: '2026-11-02', to: '2026-11-02', asOf: f.at });
    assert.equal(selected.measurements.length, 1);
    const daily = selected.measurements[0];
    assert.equal(daily.id, original.id); assert.equal(daily.fetchedAt, original.fetchedAt);
    assert.deepEqual(daily.rows.map(value => value.periodStart), ['2026-11-02']);
    assert.deepEqual(daily.values, {}); assert.deepEqual(daily.ratios, {}); assert.equal(selected.reachTotal, null);
    assert.deepEqual(daily.coverage, original.coverage); assert.equal(daily.coverage.rowCount, 2);
    assert.equal(daily.query.periodStart, '2026-11-01'); assert.equal(daily.periodStart, original.periodStart);
    assert.deepEqual(daily.selection, { from: '2026-11-02', to: '2026-11-02', appliedTo: 'rows', originalPeriodStart: '2026-11-01', originalPeriodEnd: '2026-11-02', originalRowCount: 2, selectedRowCount: 1, originalCoverage: original.coverage });
    assert.deepEqual((await getSocialResults(store, { campaignId: f.campaignId, dimension: 'placement', from: '2026-11-02', asOf: f.at })).measurements, []);
    assert.deepEqual((await getSocialResults(store, { campaignId: f.campaignId, to: '2026-10-31', asOf: f.at })).measurements, []);
    const inclusive = await getSocialResults(store, { campaignId: f.campaignId, from: '2026-11-01', to: '2026-11-02', asOf: f.at });
    assert.equal(inclusive.measurements.length, 5);
  }],
  ['capturas se filtran antes del fallback completo y la paginación de entregas', async (store, t) => {
    const f = await setup(store, t); await f.finish();
    const complete = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    const source = await store.db.get(`SELECT * FROM ${store.t('social_measurements')} WHERE id=?`, [complete.id]);
    const addCapture = async (periodStart, at, isComplete) => {
      const data = JSON.parse(source.data), id = randomUUID();
      data.query.periodStart = periodStart; data.coverage = { complete: isComplete, rowCount: 1, reason: isComplete ? null : 'partial_pages' };
      await insertRow(store, 'social_measurements', { id, delivery_id: f.deliveryId, query_key: source.query_key, fetched_at: at, payload_hash: hash(data), data: JSON.stringify(data) });
      return id;
    };
    await addCapture('2026-10-01', '2026-11-03T03:00:00.000Z', true);
    const partialId = await addCapture('2026-11-01', '2026-11-03T03:01:00.000Z', false);
    await addCapture('2026-10-01', '2026-11-03T03:02:00.000Z', false);
    for (let index = 0; index < 20; index++) {
      const campaignId = randomUUID(), deliveryId = randomUUID(), data = JSON.parse(source.data);
      await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: f.connectionId, asset_id: f.assetId, name: `Other period ${index}`, mode: 'paid', objective: 'whatsapp', state: 'active', ...editable(f.spec) });
      await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash(f.spec), actor_id: f.actorId, approved_at: START, data: JSON.stringify({ spec: f.spec }) });
      await insertRow(store, 'social_deliveries', {
        id: deliveryId, campaign_id: campaignId, revision: 1, channel: 'meta_ads', state: 'active', remote_id: null, next_sync_at: null,
        ...editable({ integrationMethod: 'api' }), created_at: '2026-11-03T03:03:00.000Z'
      });
      data.query.periodStart = '2026-10-01';
      await insertRow(store, 'social_measurements', { id: randomUUID(), delivery_id: deliveryId, query_key: source.query_key, fetched_at: source.fetched_at, payload_hash: hash(data), data: JSON.stringify(data) });
    }
    const result = await getSocialResults(store, { from: '2026-11-01', to: '2026-11-02', dimension: 'aggregate', asOf: '2026-11-03T04:00:00.000Z' });
    assert.equal(result.total, 1); assert.equal(result.deliveries[0].id, f.deliveryId);
    assert.equal(result.measurements.length, 1);
    const selected = result.measurements[0];
    assert.equal(selected.id, complete.id); assert.equal(selected.fetchedAt, complete.fetchedAt);
    assert.equal(selected.latestAttempt.id, partialId); assert.equal(selected.newerPartial, true);
    assert.equal(result.groups.length, 1);
    assert.deepEqual(result.groups[0], { currency: 'COP', mode: 'paid', scope: 'paid', network: 'meta_ads', integrationMethod: 'api', deliveryIds: [f.deliveryId], measurementIds: [complete.id], reachTotal: null, reachTotalReason: 'not_deduplicable_between_deliveries' });
  }],
  ['vista sin campaña conserva grupos descriptivos separados sin producir totales incompatibles', async (store, t) => {
    const paid = await setup(store, t); await paid.finish();
    const organic = await setup(store, t, { mode: 'organic', channel: 'facebook' }); await organic.finish();
    const result = await getSocialResults(store, { asOf: organic.at });
    assert.equal(result.groups.length, 3); assert.equal(result.reachTotal, null);
    assert.deepEqual(new Set(result.groups.map(value => `${value.mode}:${value.scope}:${value.network}`)), new Set(['paid:paid:meta_ads', 'organic:organic:facebook', 'organic:mixed:facebook']));
    for (const group of result.groups) {
      assert.equal(group.integrationMethod, 'api'); assert.equal(group.reachTotal, null);
      assert.equal(group.deliveryIds.length, 1);
      assert.deepEqual(new Set(group.measurementIds), new Set(result.measurements.filter(value => value.scope === group.scope && value.deliveryId === group.deliveryIds[0]).map(value => value.id)));
      assert.equal(Object.hasOwn(group, 'values'), false);
    }
  }],
  ['una métrica inválida se recuerda por conexión y definición sin rechazar los campos válidos', async (store, t) => {
    const f = await setup(store, t); f.state.invalidMetrics.add('video_p50_watched_actions'); await f.finish();
    const first = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    assert.equal(first.values.videoP50.status, 'unsupported'); assert.equal(first.values.impressions.value, 4000);
    const requests = f.calls.length; f.at = '2026-11-03T03:00:30.000Z'; await f.read();
    const current = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    assert.equal(current.values.videoP50.status, 'unsupported');
    assert.equal(f.calls.slice(requests).some(call => call.path === '900/insights' && (call.params.fields || '').split(',').includes('video_p50_watched_actions')), false);
  }],
  ['un permiso perdido bloquea futuras consultas sin borrar evidencia ni fingir cero; revalidar libera el bloqueo', async (store, t) => {
    const f = await setup(store, t); await f.finish(); const previous = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    f.state.metricError = { code: 200 }; f.at = '2026-11-03T03:00:30.000Z';
    assert.equal((await f.read()).errorCode, 'PERMISSION_REQUIRED');
    const delivery = await f.delivery(); assert.equal(delivery.state, 'active'); assert.equal(delivery.metricSync.blocked.code, 'PERMISSION_REQUIRED'); assert.equal(delivery.nextSyncAt, null);
    const count = f.calls.length; assert.equal((await f.read()).processed, 0); assert.equal(f.calls.length, count);
    assert.equal((await f.results()).measurements.find(value => value.dimension === 'aggregate').id, previous.id);
    f.state.metricError = null; await store.db.run(`UPDATE ${store.t('social_connections')} SET version=version+1 WHERE id=?`, [f.connectionId]);
    assert.equal((await f.read()).errorCode, null); assert.equal((await f.delivery()).metricSync.blocked, null);
  }],
  ['Retry-After queda por cuenta y un pedido manual no puede causar una lectura anticipada', async (store, t) => {
    const f = await setup(store, t); f.state.metricError = { code: 4, status: 429 };
    const failed = await f.read(); assert.equal(failed.errorCode, 'RATE_LIMITED');
    const connection = await get(store, 'social_connections', f.connectionId), until = await socialAccountNotBefore(store, connection, f.spec, { now: f.at });
    assert.equal(until, '2026-11-03T02:02:00.000Z');
    await patch(store, 'social_deliveries', f.deliveryId, { metricsRequestedAt: f.at });
    const count = f.calls.length; assert.equal((await f.read()).processed, 0); assert.equal(f.calls.length, count);
    assert.equal((await f.delivery()).metricSync.lastError.message.includes('CANARY'), false);
  }],
  ['orgánico Facebook conserva snapshots organic y mixed en lugar de sumar pauta a alcance orgánico', async (store, t) => {
    const f = await setup(store, t, { mode: 'organic', channel: 'facebook' }); await f.finish();
    const results = await f.results(), organic = results.measurements.find(value => value.scope === 'organic'), mixed = results.measurements.find(value => value.scope === 'mixed');
    assert.equal(organic.values.views.value, 1200); assert.equal(mixed.values.views.value, 2000); assert.equal(mixed.values.reach.value, 1000);
    assert.equal(organic.values.reach?.value ?? null, null); assert.equal(results.reachTotal, null); assert.notEqual(organic.queryKey, mixed.queryKey);
  }],
  ['cambiar la entrega mientras Graph lee descarta el resultado tardío sin escribir capturas de otro dueño', async (store, t) => {
    const f = await setup(store, t), actual = f.api.fetchMeasurements;
    const connector = { async fetchMeasurements(options) {
      const result = await actual(options);
      await store.db.run(`UPDATE ${store.t('social_deliveries')} SET version=version+1 WHERE id=?`, [f.deliveryId]);
      return result;
    } };
    await assert.rejects(() => f.read({ connector }), { errorCode: 'LEASE_LOST' });
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_measurements')}`)).n), 0);
  }],
  ['respaldo conserva capturas canónicas pero excluye el cursor activo y rechaza métricas desglosadas adulteradas', async (store, t) => {
    const f = await setup(store, t); await f.read();
    assert.equal((await f.delivery()).metricSync.cycle.index, 1);
    const bundle = await store.exportData(), exported = JSON.parse(bundle.business.social_deliveries[0].data);
    assert.equal(exported.metricSync.cycle, undefined); assert.equal(exported.metricSync.nextAt, undefined);
    assert.equal(bundle.business.social_measurements[0].payload_hash, hash(JSON.parse(bundle.business.social_measurements[0].data)));
    await prepareCommercialBundle(bundle);
    const executable = structuredClone(bundle), deliveryData = JSON.parse(executable.business.social_deliveries[0].data);
    deliveryData.metricSync.cycle = { id: randomUUID(), queries: [], index: 0 }; executable.business.social_deliveries[0].data = JSON.stringify(deliveryData);
    await assert.rejects(() => prepareCommercialBundle(executable));
    f.at = '2026-11-03T02:00:01.000Z'; await f.read();
    const corrupted = await store.exportData(), row = corrupted.business.social_measurements.find(value => JSON.parse(value.data).dimension === 'daily'), data = JSON.parse(row.data);
    data.rows[0].values.reach.value = -1; row.data = JSON.stringify(data); row.payload_hash = hash(data);
    await assert.rejects(() => prepareCommercialBundle(corrupted));
  }],
  ['token revocado detiene la conexión y conserva los resultados anteriores sin nuevas lecturas', async (store, t) => {
    const f = await setup(store, t); await f.finish(); const previous = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    f.state.metricError = { code: 190 }; f.at = '2026-11-03T03:00:30.000Z';
    assert.equal((await f.read()).errorCode, 'SESSION_EXPIRED');
    assert.equal((await get(store, 'social_connections', f.connectionId)).state, 'reconnect_required');
    const count = f.calls.length; assert.equal((await f.read()).processed, 0); assert.equal(f.calls.length, count);
    assert.equal((await f.results()).measurements.find(value => value.dimension === 'aggregate').id, previous.id);
  }],
  ['frescura se evalúa por captura completa y deja de exigir actualizaciones a una pauta finalizada', async (store, t) => {
    const f = await setup(store, t); await f.finish(); const aggregate = (await f.results()).measurements.find(value => value.dimension === 'aggregate');
    const atLimit = new Date(Date.parse(aggregate.fetchedAt) + 2 * 3600000).toISOString();
    const resultAt = at => getSocialResults(store, { campaignId: f.campaignId, asOf: at });
    assert.equal((await resultAt(atLimit)).measurements.find(value => value.dimension === 'aggregate').stale, false);
    const late = new Date(Date.parse(atLimit) + 1).toISOString();
    assert.equal((await resultAt(late)).measurements.find(value => value.dimension === 'aggregate').stale, true);
    await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state='completed' WHERE id=?`, [f.deliveryId]);
    const finished = (await resultAt(late)).measurements.find(value => value.dimension === 'aggregate');
    assert.equal(finished.stale, false); assert.equal(finished.fetchedAt, aggregate.fetchedAt);
  }],
  ['Actualizar aplica quince minutos, replay estable y reconciliación separada sin leer Meta desde el request', async (store, t) => {
    const f = await setup(store, t), campaign = await get(store, 'social_campaigns', f.campaignId), input = { version: campaign.version, requestId: randomUUID() }, options = { env: f.env, now: f.at };
    const first = await socialCampaignAction(store, campaign.id, 'sync', input, f.actorId, options);
    assert.deepEqual(await socialCampaignAction(store, campaign.id, 'sync', input, f.actorId, options), first);
    await assert.rejects(() => socialCampaignAction(store, campaign.id, 'sync', { ...input, requestId: randomUUID() }, f.actorId, { ...options, now: '2026-11-03T02:00:01.000Z' }), { status: 429 });
    await socialCampaignAction(store, campaign.id, 'reconcile', { ...input, requestId: randomUUID() }, f.actorId, { ...options, now: '2026-11-03T02:00:01.000Z' });
    assert.equal((await f.delivery()).metricsRequestedAt, f.at); assert.equal((await f.delivery()).stateReadRequestedAt, '2026-11-03T02:00:01.000Z');
    assert.deepEqual(f.calls, []);
  }]
];

export async function runSocialMetricsContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async context => {
    const store = await factory();
    try { await scenario(store, context); } finally { await store.close(); }
  });
}
