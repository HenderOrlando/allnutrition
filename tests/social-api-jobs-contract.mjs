import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { entity, insertRow } from '../lib/business/commands.mjs';
import { queueJobTx } from '../lib/business/job-leases.mjs';
import { normalizeSocialCampaignInput, buildSocialSpec } from '../lib/business/social-spec.mjs';
import { getSocialCampaign, socialCampaignAction } from '../lib/business/social.mjs';
import { processSocialApiTurn, prepareSocialApiJobs, queueSocialApiJobTx } from '../lib/business/social-api-jobs.mjs';
import { deferSocialAccountTx, socialAccountNotBefore, socialAccountScope } from '../lib/business/social-schedule.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { createMetaPublishingProvider } from './social-meta-provider.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { loadSocialRuntime } from '../lib/social/config.mjs';

const NOW = '2026-11-02T12:00:00.000Z';
const later = (ms, origin = NOW) => new Date(Date.parse(origin) + ms).toISOString();
const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' };
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: NOW, updated_at: NOW });
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const operations = async f => (await f.store.db.all(`SELECT * FROM ${f.store.t('social_operations')} WHERE campaign_id=? ORDER BY created_at,id`, [f.campaignId])).map(entity);
async function patch(store, table, id, data) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...data }), id]);
}
const httpProviders = new WeakMap();
const storeFixtures = new WeakMap();
const providerClocks = new WeakMap();
async function providerHttp(remote, t) {
  if (httpProviders.has(remote)) return httpProviders.get(remote);
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers['x-fixture-host'];
      assert.ok(['graph.facebook.com', 'graph-video.facebook.com', 'rupload.facebook.com'].includes(host));
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert.ok(length <= 10 * 1024 * 1024); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), headers = new Headers(Object.entries(request.headers).filter(([key, value]) => key !== 'x-fixture-host' && key !== 'host' && typeof value === 'string'));
      const body = host === 'rupload.facebook.com' ? Readable.from([bytes]) : (headers.get('content-type') || '').startsWith('multipart/') ? bytes : bytes.toString('utf8');
      const result = await remote.fetchImpl(`https://${host}${request.url}`, { method: request.method, headers, ...(request.method === 'GET' ? {} : { body, duplex: 'half' }) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.protocol, 'https:'); assert.ok(['graph.facebook.com', 'graph-video.facebook.com', 'rupload.facebook.com'].includes(url.hostname));
    const headers = new Headers(options.headers); headers.set('x-fixture-host', url.hostname);
    return fetch(`${origin}${url.pathname}${url.search}`, { ...options, headers });
  };
  httpProviders.set(remote, fetchImpl);
  return fetchImpl;
}
async function setup(store, t, { mode = 'organic', platforms = ['facebook'], kind = 'image', publishAt = null, remote = null } = {}) {
  if (!storeFixtures.has(store)) {
    const root = await mkdtemp(join(tmpdir(), 'social-api-job-contract-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = { APP_URL: 'https://app.example.test', META_APP_ID: '42', META_APP_SECRET: 'synthetic-secret', META_LOGIN_CONFIG_ID: '43', SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_MEDIA_DIR: root };
    for (const key of ['SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY']) env[key] = randomBytes(32).toString('base64');
    storeFixtures.set(store, { root, env });
  }
  const { root, env: deploymentEnv } = storeFixtures.get(store), env = { ...deploymentEnv };
  await configureSocialTestRuntime(store, { env });
  const actorId = randomUUID(), approverId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID(), campaignId = randomUUID();
  for (const id of [actorId, approverId]) await insertRow(store, 'users', { id, email: `${id}@example.test`, password: 'unused-synthetic-password', active: 1 });
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', ...editable({ name: 'Cuenta sintética', identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true } }) });
  const connection = await get(store, 'social_connections', connectionId);
  await saveCredentials(store, connectionId, { accessToken: 'synthetic-user', userId: '100', pageTokens: { 200: 'synthetic-page-200' } }, { runtime: (await configureSocialTestRuntime(store, { env })).runtime });
  await mkdir(join(root, assetId), { mode: 0o700 });
  const key = `${assetId}/derivative.${kind === 'image' ? 'jpg' : 'mp4'}`;
  if (kind === 'image') await writeFile(join(root, key), await sharp({ create: { width: 540, height: 675, channels: 3, background: '#446688' } }).jpeg().toBuffer(), { mode: 0o600 });
  else await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:r=30:d=3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(root, key)]);
  const bytes = await readFile(join(root, key)), assetHash = createHash('sha256').update(bytes).digest('hex');
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: assetHash, bytes: bytes.length, ...editable({ kind, name: 'Pieza sintética real', derivativeKey: key, derivativeSha256: assetHash, derivativeBytes: bytes.length, derivativeContentType: kind === 'image' ? 'image/jpeg' : 'video/mp4', width: 540, height: kind === 'image' ? 675 : 960 }) });
  const asset = await get(store, 'social_assets', assetId);
  const configuration = normalizeSocialCampaignInput({ name: 'Campaña de contrato', connectionId, assetId, mode, objective: mode === 'paid' ? 'traffic' : 'reach', platforms, caption: 'Pieza escrita por el administrador', headline: mode === 'paid' ? 'Nutrition' : '', destinationUrl: mode === 'paid' ? 'https://example.test/product' : '', placements: platforms.map(platform => `${platform}_${kind === 'image' ? 'feed' : 'reels'}`), budgetMinor: mode === 'paid' ? 5000000 : 0, startAt: mode === 'paid' ? NOW : null, endAt: mode === 'paid' ? later(7 * 86400000) : null, publishAt, observationDays: 7, aiDisclosure: false }, { connection });
  const { spec, specHash } = buildSocialSpec({ id: campaignId, state: 'draft', ...configuration }, { connection, asset, now: later(-60000) });
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connectionId, asset_id: assetId, name: spec.name, mode, objective: spec.objective, state: publishAt ? 'scheduled' : 'publishing', ...editable(configuration) });
  const forecast = { source: 'insufficient', algorithmVersion: 'social-history-v1', specHash, sampleIds: [], sampleCount: 0, metricRanges: {}, unavailableReasons: ['Fixture sin historial.'] };
  const runtime = await loadSocialRuntime(store, { env });
  await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: specHash, approved_at: NOW, actor_id: approverId, data: JSON.stringify({ spec, configurationFingerprint: runtime.fingerprint, forecast, rightsAccepted: true, acceptedWarnings: [], ...(mode === 'paid' ? { budgetConfirmation: { investmentAccepted: true, budgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt } } : {}) }) });
  if (!remote) {
    const clock = { now: Date.parse(NOW) };
    remote = createMetaPublishingProvider({ now: () => clock.now });
    providerClocks.set(remote, clock);
  }
  const providerClock = providerClocks.get(remote);
  let logicalNow = Date.parse(NOW) - 1000;
  const f = { store, env, root, actorId, approverId, connectionId, connection, campaignId, assetId, assetHash, spec, specHash, remote, deliveries: [], transport: { fetchImpl: await providerHttp(remote, t) } };
  f.delivery = async channel => {
    const id = randomUUID(); await insertRow(store, 'social_deliveries', { id, campaign_id: campaignId, revision: 1, channel, state: publishAt ? 'scheduled' : 'queued', remote_id: null, next_sync_at: null, ...editable({ integrationMethod: 'api', remoteRefs: {} }) });
    f.deliveries.push(id); return get(store, 'social_deliveries', id);
  };
  for (const channel of mode === 'paid' ? ['meta_ads'] : platforms) await f.delivery(channel);
  f.now = () => new Date(logicalNow).toISOString();
  f.turn = (options = {}) => {
    logicalNow = options.now ? Date.parse(options.now) : logicalNow + 1000;
    providerClock.now = logicalNow;
    return processSocialApiTurn(store, { maxOperations: 1, env, transport: f.transport, ...options, now: f.now() });
  };
  f.until = async (predicate, options = {}) => { for (let count = 0; count < 25; count++) { if (await predicate()) return; await f.turn(options); } assert.fail('El proveedor no alcanzó el estado esperado dentro de las etapas acotadas.'); };
  f.ready = async () => { await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'ready'); return get(store, 'social_deliveries', f.deliveries[0]); };
  f.control = async (kind, { deliveryId = f.deliveries[0], actor = actorId } = {}) => {
    const delivery = await get(store, 'social_deliveries', deliveryId), requestId = randomUUID(), id = randomUUID();
    const budgetConfirmation = { remainingMinor: delivery.budgetSnapshot?.remainingMinor, originalBudgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt, checkedAt: NOW };
    await store.transaction(async tx => {
      await tx.lockWrites(); await patch(tx, 'social_deliveries', deliveryId, { controlIntent: { id: requestId, kind, actorId: actor, requestedAt: NOW } });
      await insertRow(tx, 'social_operations', { id, campaign_id: campaignId, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:${kind}:${requestId}`, step: `${kind}:${requestId}`, state: 'prepared', next_attempt_at: null, ...editable({ integrationMethod: 'api', actorId: actor, channel: delivery.channel, specHash, controlId: requestId, investmentAccepted: kind !== 'pause', preparedRefs: delivery.preparedRefs, budgetConfirmation }) });
      await queueSocialApiJobTx(tx, { kind: 'delivery', id: deliveryId }, { now: NOW });
    });
    return { id, requestId };
  };
  f.sync = async (now = NOW) => { await store.db.run(`UPDATE ${store.t('social_deliveries')} SET next_sync_at=? WHERE id=?`, [now, f.deliveries[0]]); await store.transaction(tx => queueSocialApiJobTx(tx, { kind: 'sync', id: f.deliveries[0] }, { now })); return f.turn({ now }); };
  return f;
}
const pathOf = input => new URL(input).pathname.replace(/^\//, '').replace(/^v26\.0\//, '');
const writing = request => request.method === 'POST';

const cases = [
  ['el consumidor publica con custodia persistida y sin variables de integración', async (store, t) => {
    const f = await setup(store, t);
    for (const key of ['APP_URL', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'META_GRAPH_VERSION', 'SOCIAL_PUBLISHING_ENABLED', 'SOCIAL_BROWSER_ENABLED', 'SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY']) delete f.env[key];
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'published');
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '200/feed').length, 1);
  }],
  ['el mismo consumidor relee la habilitación bajo reserva antes de enviar y continúa al habilitar', async (store, t) => {
    const f = await setup(store, t), nativeFetch = f.transport.fetchImpl;
    let changed = false;
    f.transport.fetchImpl = async (input, init) => {
      if (!changed && pathOf(input) === 'debug_token') {
        changed = true;
        await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
      }
      return nativeFetch(input, init);
    };
    assert.equal((await f.turn()).errorCode, 'PUBLISHING_DISABLED');
    assert.equal(f.remote.requests.filter(writing).length, 0);
    assert.equal((await operations(f))[0].sentAt, undefined);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } });
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'published');
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '200/feed').length, 1);
  }],
  ['un secreto cambiado durante validación invalida aprobación no enviada sin usar overrides de transporte', async (store, t) => {
    const f = await setup(store, t), nativeFetch = f.transport.fetchImpl;
    let changed = false;
    f.transport.appId = '999'; f.transport.appSecret = 'UNTRUSTED-TRANSPORT-OVERRIDE';
    f.transport.fetchImpl = async (input, init) => {
      const response = await nativeFetch(input, init);
      if (!changed && pathOf(input) === 'me') {
        changed = true;
        await configureSocialTestRuntime(store, { env: f.env, settings: { appSecret: 'ROTATED-SYNTHETIC-SECRET' } });
      }
      return response;
    };
    const approved = await store.db.get(`SELECT data FROM ${store.t('social_revisions')} WHERE campaign_id=?`, [f.campaignId]);
    assert.equal((await f.turn()).errorCode, 'CONFIGURATION_CHANGED');
    assert.equal(f.remote.requests.filter(writing).length, 0);
    assert.deepEqual(await store.db.get(`SELECT data FROM ${store.t('social_revisions')} WHERE campaign_id=?`, [f.campaignId]), approved);
    assert.equal((await get(store, 'social_connections', f.connectionId)).revalidationRequired, true);
  }],
  ['deshabilitar después de autorizar conserva recibo y referencias del envío en curso', async (store, t) => {
    const f = await setup(store, t), nativeFetch = f.transport.fetchImpl;
    let changed = false;
    f.transport.fetchImpl = async (input, init) => {
      const response = await nativeFetch(input, init);
      if (!changed && init.method === 'POST') {
        changed = true;
        await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
      }
      return response;
    };
    assert.equal((await f.turn()).errorCode, null);
    const operation = (await operations(f)).find(value => value.step === 'upload_photo');
    assert.equal(operation.state, 'confirmed'); assert.equal(operation.receipts.length, 1);
    assert.ok((await get(store, 'social_deliveries', f.deliveries[0])).remoteRefs.photoId);
    const writes = f.remote.requests.filter(writing).length;
    assert.equal((await f.turn()).processed, 0);
    assert.equal(f.remote.requests.filter(writing).length, writes);
  }],
  ['crea una sola intención inicial bajo lease, sólo reclama sus UUID y no altera contabilidad', async (store, t) => {
    const f = await setup(store, t), untouched = [`social:browser:delivery:${randomUUID()}`, `social:browser-lock:${randomUUID()}`, 'social:delivery:not-a-uuid', 'import:worker-contract'];
    for (const key of untouched) await store.transaction(tx => queueJobTx(tx, key, { marker: key }, { now: NOW }));
    const before = await store.db.all(`SELECT * FROM ${store.t('job_runs')} ORDER BY key`), revision = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    const results = await Promise.all([f.turn(), f.turn()]); assert.ok(results.some(result => result.processed > 0));
    assert.equal((await operations(f)).filter(operation => operation.step === 'upload_photo').length, 1);
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '200/photos').length, 1);
    for (const row of before) assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [row.key]), row);
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), revision);
    for (const table of ['orders', 'expenses', 'expense_payments', 'cash_entries', 'order_collections']) assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n), 0);
  }],
  ['agenda futura no envía ni gira, y una promoción con más de quince minutos de atraso exige intervención', async (store, t) => {
    const f = await setup(store, t, { publishAt: later(3600000) });
    assert.equal((await f.turn()).processed, 0); assert.equal((await f.turn()).hasMore, false); assert.equal(f.remote.requests.length, 0);
    const due = await f.turn({ now: later(3600000) }); assert.equal(due.processed, 1); assert.equal(f.remote.requests.filter(writing).length, 1);
    const late = await setup(store, t);
    assert.equal((await late.turn({ now: later(901000) })).errorCode, 'SCHEDULE_MISSED'); assert.equal(late.remote.requests.filter(writing).length, 0);
    assert.equal((await get(store, 'social_deliveries', late.deliveries[0])).state, 'blocked');
  }],
  ['flags y restore hold detienen efectos sin hasMore, pero lectura de restaurado sigue disponible', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.ready();
    await patch(store, 'social_campaigns', f.campaignId, { restore_hold: true }); await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const writes = f.remote.requests.filter(writing).length;
    await f.control('activate'); assert.equal((await f.turn()).hasMore, false);
    const result = await f.sync(); assert.equal(result.errorCode, null); assert.equal(f.remote.requests.filter(writing).length, writes);
    assert.equal((await get(store, 'social_deliveries', f.deliveries[0])).state, 'ready');
  }],
  ['actor original o actual deshabilitado y archivo adulterado bloquean antes del primer POST', async (store, t) => {
    for (const fault of ['approver', 'asset']) {
      const f = await setup(store, t);
      if (fault === 'approver') await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
      else await writeFile(join(f.root, f.assetId, 'derivative.jpg'), 'tampered-content');
      const result = await f.turn(); assert.equal(result.errorCode, fault === 'approver' ? 'PERMISSION_REQUIRED' : 'MISSING_FILE'); assert.equal(f.remote.requests.filter(writing).length, 0);
    }
    const f = await setup(store, t, { mode: 'paid' }); await f.ready(); await f.control('activate');
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    const writes = f.remote.requests.filter(writing).length; assert.equal((await f.turn()).errorCode, 'PERMISSION_REQUIRED'); assert.equal(f.remote.requests.filter(writing).length, writes);
  }],
  ['preparación pagada persiste IDs antes de avanzar y no activa; controles hijos primero y campaña al final', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', platforms: ['facebook', 'instagram'] }), delivery = await f.ready();
    assert.equal(f.deliveries.length, 1); assert.ok(delivery.remoteRefs.campaignId); assert.ok(delivery.preparedRefs.adSetId); assert.equal(delivery.everActivated, false);
    for (const id of [delivery.preparedRefs.campaignId, delivery.preparedRefs.adSetId, delivery.preparedRefs.adId]) assert.equal(f.remote.objects.get(id).status, 'PAUSED');
    assert.equal(delivery.budgetSnapshot.budgetMinor, 5000000);
    const activation = await f.control('activate');
    for (const stage of ['adset', 'campaign', 'confirm']) {
      const turn = await f.turn(); assert.equal(turn.processed, 1); const operation = await get(store, 'social_operations', activation.id);
      assert.equal(operation.state, 'prepared'); assert.equal(operation.progress.controlStage, stage); assert.equal(operation.result.operationComplete, false);
    }
    assert.equal((await get(store, 'social_deliveries', delivery.id)).state, 'ready');
    await f.turn(); assert.equal((await get(store, 'social_operations', activation.id)).state, 'confirmed');
    const receipts = (await get(store, 'social_operations', activation.id)).receipts;
    assert.deepEqual(receipts.map(receipt => receipt.operationComplete), [false, false, false, true]);
    assert.deepEqual(receipts.slice(0, 3).map(receipt => receipt.progress.controlStage), ['adset', 'campaign', 'confirm']);
    const final = await get(store, 'social_deliveries', delivery.id); assert.equal(final.state, 'active'); assert.equal(final.everActivated, true);
    const controls = f.remote.requests.filter(request => writing(request) && [delivery.preparedRefs.adId, delivery.preparedRefs.adSetId, delivery.preparedRefs.campaignId].includes(request.path));
    assert.deepEqual(controls.map(request => request.path), [delivery.preparedRefs.adId, delivery.preparedRefs.adSetId, delivery.preparedRefs.campaignId]);
  }],
  ['dos ciclos de pausa y reanudación conservan presupuesto/fin y la pausa funciona sin pieza, flag ni aprobador', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.ready();
    const publicControl = async kind => {
      const campaign = await getSocialCampaign(store, f.campaignId), delivery = await get(store, 'social_deliveries', f.deliveries[0]);
      const result = await socialCampaignAction(store, f.campaignId, kind === 'activate' ? 'activate-paid' : kind, {
        version: campaign.version, requestId: randomUUID(),
        ...(kind === 'pause' ? {} : { specHash: f.specHash, preparedRefs: delivery.preparedRefs, investmentAccepted: true, remainingBudgetMinor: delivery.budgetSnapshot.remainingMinor })
      }, f.actorId, { env: f.env, now: NOW, transport: f.transport });
      return { id: result.operationId };
    };
    const activation = await publicControl('activate');
    await f.until(async () => (await get(store, 'social_operations', activation.id)).state === 'confirmed');
    for (let cycle = 0; cycle < 2; cycle++) {
      await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } }); await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
      await patch(store, 'social_campaigns', f.campaignId, { restore_hold: true }); await rm(join(f.root, f.assetId, 'derivative.jpg'));
      await store.db.run(`UPDATE ${store.t('social_connections')} SET state='reconnect_required' WHERE id=?`, [f.connection.id]);
      const pause = await publicControl('pause'); assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_operations', pause.id)).state, 'confirmed');
      assert.equal((await get(store, 'social_deliveries', f.deliveries[0])).state, 'paused');
      // A new complete file is revalidated before any subsequent resumption.
      const image = await sharp({ create: { width: 540, height: 675, channels: 3, background: '#446688' } }).jpeg().toBuffer(); await writeFile(join(f.root, f.assetId, 'derivative.jpg'), image);
      await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } }); await store.db.run(`UPDATE ${store.t('users')} SET active=1 WHERE id=?`, [f.approverId]); await patch(store, 'social_campaigns', f.campaignId, { restore_hold: false });
      await store.db.run(`UPDATE ${store.t('social_connections')} SET state='connected' WHERE id=?`, [f.connection.id]);
      const resume = await publicControl('resume'); await f.until(async () => (await get(store, 'social_operations', resume.id)).state === 'confirmed');
      const delivery = await get(store, 'social_deliveries', f.deliveries[0]); assert.equal(delivery.state, 'active'); assert.equal(delivery.budgetSnapshot.budgetMinor, 5000000); assert.equal(delivery.budgetSnapshot.endAt, f.spec.endAt);
    }
    assert.equal((await operations(f)).filter(operation => operation.step.startsWith('pause:')).length, 2);
    assert.equal((await operations(f)).filter(operation => operation.step.startsWith('resume:')).length, 2);
  }],
  ['respuesta de creación perdida queda incierta y sólo inspección recupera el UUID sin segundo objeto', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.turn();
    f.remote.state.loseResponse = { path: 'act_400/campaigns', times: 1 };
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN');
    let operation = (await operations(f)).find(value => value.step === 'create_campaign'); assert.equal(operation.state, 'uncertain');
    const writes = f.remote.requests.filter(request => writing(request) && request.path === 'act_400/campaigns').length;
    assert.equal((await f.turn()).processed, 0);
    const retry = operation.nextAttemptAt; assert.ok(retry); assert.equal((await f.turn({ now: retry })).errorCode, null);
    operation = await get(store, 'social_operations', operation.id); assert.equal(operation.state, 'confirmed');
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === 'act_400/campaigns').length, writes);
    assert.ok((await get(store, 'social_deliveries', f.deliveries[0])).remoteRefs.campaignId);
  }],
  ['un GET rechazado después de un envío ambiguo no acredita ausencia ni borra incertidumbre', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.turn();
    f.remote.state.loseResponse = { path: 'act_400/campaigns', times: 1 }; await f.turn();
    const operation = (await operations(f)).find(value => value.step === 'create_campaign');
    f.remote.state.tokenRevoked = true;
    await f.turn({ now: operation.nextAttemptAt });
    const saved = await get(store, 'social_operations', operation.id);
    assert.equal(saved.state, 'uncertain'); assert.equal(saved.lastError.providerCode, 190);
    assert.equal((await get(store, 'social_connections', f.connectionId)).state, 'reconnect_required');
    assert.equal([...f.remote.objects.values()].filter(object => object.type === 'campaign').length, 1);
  }],
  ...['before', 'after'].map(phase => [`perder fence ${phase} del envío conserva intención y exige dueño nuevo`, async (store, t) => {
      const f = await setup(store, t, { mode: 'paid' }); await f.turn();
      const nativeFetch = f.transport.fetchImpl; let stolen = false;
      f.transport.fetchImpl = async (input, init) => {
        const path = pathOf(input), method = init.method || 'GET';
        if (!stolen && (phase === 'before' && method === 'GET' && path === 'me' || phase === 'after' && method === 'POST' && path === 'act_400/campaigns')) {
          stolen = true;
          const response = phase === 'after' ? await nativeFetch(input, init) : null;
          await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_token=?,lease_until=? WHERE key=?`, [randomUUID(), later(-1), `social:delivery:${f.deliveries[0]}`]);
          return response || nativeFetch(input, init);
        }
        return nativeFetch(input, init);
      };
      assert.equal((await f.turn()).errorCode, 'LEASE_LOST');
      const operation = (await operations(f)).find(value => value.step === 'create_campaign'); assert.equal(operation.state, phase === 'after' ? 'sent' : 'prepared');
      const count = f.remote.requests.filter(request => writing(request) && request.path === 'act_400/campaigns').length; assert.equal(count, phase === 'after' ? 1 : 0);
      f.transport.fetchImpl = nativeFetch;
      await f.turn();
      assert.equal(f.remote.requests.filter(request => writing(request) && request.path === 'act_400/campaigns').length, 1);
      assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
  }]),
  ['una pausa nueva frena activación antigua incluso cuando su respuesta llega tarde', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); const delivery = await f.ready(), activation = await f.control('activate');
    const nativeFetch = f.transport.fetchImpl; let pauseId;
    f.transport.fetchImpl = async (input, init) => {
      const response = await nativeFetch(input, init);
      if ((init.method || 'GET') === 'POST' && pathOf(input) === delivery.preparedRefs.adId && !pauseId) pauseId = (await f.control('pause')).id;
      return response;
    };
    assert.equal((await f.turn()).errorCode, null); const old = await get(store, 'social_operations', activation.id); assert.equal(old.state, 'prepared');
    await f.turn(); assert.equal((await get(store, 'social_operations', pauseId)).state, 'confirmed');
    for (let index = 0; index < 3; index++) await f.turn();
    assert.equal(f.remote.objects.get(delivery.remoteRefs.campaignId).status, 'PAUSED'); assert.equal((await get(store, 'social_deliveries', delivery.id)).state, 'paused');
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === delivery.preparedRefs.adSetId).length, 0);
    assert.equal((await get(store, 'social_operations', activation.id)).progress.controlStage, 'adset');
  }],
  ['rate-limit comparte cuenta entre conexiones, Retry-After mayor vence y un sync nuevo no evade espera', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.ready();
    const other = await setup(store, t, { mode: 'paid', remote: f.remote }); await other.ready();
    const campaign = (await get(store, 'social_deliveries', f.deliveries[0])).remoteId;
    f.remote.state.rateLimit = { path: campaign, times: 1, retryAfter: 7200 };
    assert.equal((await f.sync()).errorCode, 'RATE_LIMITED');
    const deadline = await socialAccountNotBefore(store, f.connection, f.spec, { now: NOW }); assert.ok(Date.parse(deadline) >= Date.parse(later(7200000)));
    const calls = f.remote.requests.length; assert.equal((await other.sync()).hasMore, false); assert.equal(f.remote.requests.length, calls);
    assert.equal((await f.turn()).processed, 0);
    assert.equal(await socialAccountNotBefore(store, other.connection, other.spec, { now: NOW }), deadline);
    assert.equal((await other.turn({ now: deadline })).errorCode, null);
  }],
  ['cooldown no reclamable separa API de navegador y conserva el mayor plazo', async (store, t) => {
    const f = await setup(store, t), browser = { ...f.connection, integrationMethod: 'browser' }, browserSpec = { ...f.spec, integrationMethod: 'browser' };
    await store.transaction(async tx => { await deferSocialAccountTx(tx, f.connection, f.spec, later(300000), { now: NOW }); await deferSocialAccountTx(tx, f.connection, f.spec, later(60000), { now: NOW }); });
    assert.equal(await socialAccountNotBefore(store, f.connection, f.spec, { now: NOW }), later(300000));
    assert.equal(await socialAccountNotBefore(store, browser, browserSpec, { now: NOW }), null);
    const key = socialAccountScope(f.connection, f.spec), before = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [key]);
    assert.equal(before.state, 'succeeded'); assert.equal((await f.turn()).processed, 0); assert.equal((await f.turn()).hasMore, false);
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [key]), before);
  }],
  ['backoff persistido 1/5/15/60 minutos agota sin spin y no almacena el error crudo', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), nativeFetch = f.transport.fetchImpl;
    f.transport.fetchImpl = async (input, init) => pathOf(input) === 'debug_token' ? new Response(JSON.stringify({ error: { code: 2, message: 'PRIVATE-provider-error-canary' } }), { status: 503, headers: { 'content-type': 'application/json' } }) : nativeFetch(input, init);
    let now = NOW;
    for (const minutes of [1, 5, 15, 60]) {
      assert.equal((await f.turn({ now })).errorCode, 'PROVIDER_ERROR');
      const operation = (await operations(f))[0]; assert.equal(operation.state, 'retry_wait');
      const wait = Date.parse(operation.nextAttemptAt) - Date.parse(now);
      assert.ok(wait >= minutes * 60000 && wait < minutes * 60000 + 10000);
      assert.equal((await f.turn({ now })).processed, 0);
      now = operation.nextAttemptAt;
    }
    assert.equal((await f.turn({ now })).hasMore, false);
    const operation = (await operations(f))[0]; assert.equal(operation.state, 'failed'); assert.equal(operation.nextAttemptAt, null);
    assert.equal(operation.attempts, 5); assert.equal(JSON.stringify(operation).includes('PRIVATE-provider-error-canary'), false);
  }],
  ['token 190 obliga a reconectar y un cambio externo de presupuesto bloquea sin activar', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.ready(); const writes = f.remote.requests.filter(writing).length;
    f.remote.state.tokenRevoked = true;
    assert.equal((await f.sync()).errorCode, 'SESSION_EXPIRED'); assert.equal((await get(store, 'social_connections', f.connectionId)).state, 'reconnect_required');
    assert.equal(f.remote.requests.filter(writing).length, writes);
    const other = await setup(store, t, { mode: 'paid' }), delivery = await other.ready();
    other.remote.objects.get(delivery.preparedRefs.adSetId).lifetime_budget = 99999;
    await other.control('activate'); const before = other.remote.requests.filter(writing).length;
    assert.equal((await other.turn()).errorCode, 'SPEC_MISMATCH'); assert.equal(other.remote.requests.filter(writing).length, before);
    assert.equal(other.remote.objects.get(delivery.preparedRefs.campaignId).status, 'PAUSED');
  }],
  ['avance del reloj no equivale a completed y un anuncio rechazado conserva motivo humano', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.ready(); const activation = await f.control('activate');
    await f.until(async () => (await get(store, 'social_operations', activation.id)).state === 'confirmed');
    await f.sync(later(8 * 86400000));
    assert.notEqual((await get(store, 'social_deliveries', f.deliveries[0])).state, 'completed');
    f.remote.state.rejectAds = true; await f.sync();
    const delivery = await get(store, 'social_deliveries', f.deliveries[0]); assert.equal(delivery.state, 'failed'); assert.equal(delivery.lastError.code, 'PROVIDER_REJECTED');
    assert.equal(delivery.evidence.remoteRead, true);
  }],
  ['consentimiento restaurado reemplaza sólo al aprobador efectivo y nunca modifica la revisión histórica', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' });
    const before = await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=1`, [f.campaignId]);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
    await patch(store, 'social_campaigns', f.campaignId, { restore_hold: true, restoredAuthorization: { actorId: f.actorId, specHash: f.specHash, rightsAccepted: true, acceptedWarnings: [], acceptedAt: NOW } });
    assert.equal((await f.turn()).processed, 0); assert.equal(f.remote.requests.length, 0);
    await patch(store, 'social_campaigns', f.campaignId, { restore_hold: false });
    await f.ready();
    assert.ok((await operations(f)).every(operation => operation.actorId === f.actorId));
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=1`, [f.campaignId]), before);
  }],
  ['cancelar pauta espera pausa remota y puede detenerse sin identidades de página ni capacidades de publicación', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); const delivery = await f.ready(), activation = await f.control('activate');
    await f.until(async () => (await get(store, 'social_operations', activation.id)).state === 'confirmed');
    await patch(store, 'social_connections', f.connectionId, { identities: { userId: '100', adAccountId: 'act_400' }, capabilities: {} });
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    f.remote.state.hidePages = true; f.remote.state.accountStatus = 2; f.remote.state.permissions = ['ads_management'];
    const cancellation = await f.control('pause');
    await patch(store, 'social_operations', cancellation.id, { cancelAfterPause: true });
    assert.equal((await get(store, 'social_deliveries', delivery.id)).state, 'active');
    assert.equal((await f.turn()).errorCode, null);
    const saved = await get(store, 'social_deliveries', delivery.id);
    assert.equal(saved.state, 'cancelled'); assert.equal(saved.lastConfirmedState, 'paused');
    assert.equal(f.remote.objects.get(delivery.preparedRefs.campaignId).status, 'PAUSED');
  }],
  ['dos workers pueden progresar redes distintas sin confundir cambios del agregado con cambios de especificación', async (store, t) => {
    const f = await setup(store, t, { platforms: ['facebook', 'instagram'] });
    await Promise.all([f.turn(), f.turn()]);
    await f.until(async () => (await Promise.all(f.deliveries.map(id => get(store, 'social_deliveries', id)))).every(delivery => delivery.state === 'published'));
    assert.equal((await get(store, 'social_campaigns', f.campaignId)).state, 'published');
    assert.equal([...f.remote.objects.values()].filter(object => object.type === 'post').length, 1);
    assert.equal([...f.remote.objects.values()].filter(object => object.type === 'media').length, 1);
  }],
  ['preparar trabajo con publicación deshabilitada no crea intención ni considera browser como trabajo propio', async (store, t) => {
    const f = await setup(store, t); await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    await store.transaction(tx => queueJobTx(tx, `social:browser:delivery:${randomUUID()}`, { kind: 'delivery' }, { now: NOW }));
    const result = await prepareSocialApiJobs(store, { now: NOW, env: f.env });
    assert.deepEqual(result, { queued: 0, hasMore: false }); assert.equal((await operations(f)).length, 0); assert.equal((await f.turn()).processed, 0);
  }],
  ['éxito de Facebook y rechazo Instagram conservan entrega parcial sin republicar la red exitosa', async (store, t) => {
    const f = await setup(store, t, { platforms: ['facebook', 'instagram'] });
    const nativeFetch = f.transport.fetchImpl;
    f.transport.fetchImpl = async (input, init) => pathOf(input) === '300/media' && (init.method || 'GET') === 'POST' ? new Response(JSON.stringify({ error: { code: 10, message: 'DO-NOT-PERSIST-provider-permission-secret' } }), { status: 403, headers: { 'content-type': 'application/json' } }) : nativeFetch(input, init);
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'published' && (await get(store, 'social_deliveries', f.deliveries[1])).state === 'blocked');
    assert.equal((await get(store, 'social_campaigns', f.campaignId)).state, 'partial');
    const posts = f.remote.requests.filter(request => writing(request) && request.path === '200/feed').length; await f.turn(); assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '200/feed').length, posts);
    const journal = JSON.stringify(await operations(f)); for (const secret of ['synthetic-user', 'synthetic-page-200', 'synthetic-secret', 'DO-NOT-PERSIST-provider-permission-secret']) assert.equal(journal.includes(secret), false);
  }],
  ['consumidor nuevo retoma chunks pagados desde el recibo confirmado sin recrear sesión', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', kind: 'video' }); f.remote.state.chunkSize = 1024;
    await f.turn();
    const initial = (await operations(f)).find(operation => operation.step === 'upload_video');
    assert.deepEqual(initial.progress, { offset: 0, endOffset: 1024 });
    const before = await get(store, 'social_deliveries', f.deliveries[0]); assert.ok(before.remoteRefs.uploadSessionId);
    await f.turn();
    const checkpoint = await get(store, 'social_operations', initial.id);
    assert.equal(checkpoint.state, 'prepared'); assert.equal(checkpoint.progress.offset, 1024);
    assert.equal(checkpoint.receipts[0].operationComplete, false);
    await processSocialApiTurn(store, { now: later(1000, f.now()), maxOperations: 1, env: f.env, transport: f.transport });
    const resumed = await get(store, 'social_operations', initial.id);
    assert.equal(resumed.progress.offset, 2048);
    assert.equal((await get(store, 'social_deliveries', f.deliveries[0])).remoteRefs.uploadSessionId, before.remoteRefs.uploadSessionId);
    await f.ready();
    const upload = f.remote.uploads.get(before.remoteRefs.videoId);
    assert.equal(upload.complete, true); assert.equal(upload.sha256, f.assetHash);
    assert.equal([...f.remote.objects.values()].filter(object => object.type === 'video').length, 1);
  }],
  ['chunk pagado sin cursor de respuesta permanece incierto y nunca adivina un GET de offset', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', kind: 'video' }); f.remote.state.chunkSize = 1024; await f.turn();
    f.remote.state.loseResponse = { path: 'act_400/advideos', times: 1 };
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN');
    const transfer = (await operations(f)).find(operation => operation.step === 'upload_video');
    const posts = f.remote.requests.filter(request => writing(request) && request.path === 'act_400/advideos').length;
    await f.turn({ now: transfer.nextAttemptAt });
    const saved = await get(store, 'social_operations', transfer.id);
    assert.equal(saved.state, 'uncertain'); assert.equal(saved.progress.offset, 0);
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === 'act_400/advideos').length, posts);
  }],
  ['subida de video perdida recupera offset confirmado y no recrea sesión', async (store, t) => {
    const f = await setup(store, t, { kind: 'video' }); await f.turn();
    const delivery = await get(store, 'social_deliveries', f.deliveries[0]), videoId = delivery.remoteRefs.videoId;
    assert.ok(videoId); f.remote.state.partialUploadBytes = 1024;
    const lost = await f.turn(); assert.equal(lost.errorCode, 'OPERATION_UNCERTAIN');
    const transfer = (await operations(f)).find(value => value.step === 'upload_video');
    await f.turn({ now: transfer.nextAttemptAt });
    const recovered = await get(store, 'social_operations', transfer.id); assert.equal(recovered.state, 'prepared'); assert.ok(recovered.progress.offset > 0); assert.equal(recovered.result.operationComplete, false);
    assert.equal((await get(store, 'social_deliveries', f.deliveries[0])).remoteRefs.videoId, videoId);
    await f.turn({ now: transfer.nextAttemptAt });
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '200/video_reels').length, 1);
  }],
  ['vínculo manual verifica contenido sin publicar y sólo el inspector confirma el journal incierto', async (store, t) => {
    const f = await setup(store, t, { platforms: ['instagram'] });
    f.remote.state.loseResponse = { path: '300/media_publish', times: 1 };
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'uncertain');
    const campaign = await getSocialCampaign(store, f.campaignId), operation = (await operations(f)).find(value => value.step === 'publish');
    const media = [...f.remote.objects.values()].find(value => value.type === 'media');
    const input = { requestId: randomUUID(), version: campaign.version, deliveryId: f.deliveries[0], operationId: operation.id, specHash: f.specHash, remoteId: media.id, acceptContentVerification: true, reason: 'Operador verifica cuenta, pieza y texto.' };
    const before = f.remote.requests.filter(writing).length;
    await assert.rejects(() => socialCampaignAction(store, f.campaignId, 'link-remote', { ...input, requestId: randomUUID(), acceptContentVerification: false }, f.actorId, { env: f.env, now: f.now(), transport: f.transport }), { status: 400 });
    const result = await socialCampaignAction(store, f.campaignId, 'link-remote', input, f.actorId, { env: f.env, now: f.now(), transport: f.transport });
    assert.deepEqual(await socialCampaignAction(store, f.campaignId, 'link-remote', input, f.actorId, { env: f.env, now: f.now(), transport: f.transport }), result);
    assert.equal(f.remote.requests.filter(writing).length, before);
    assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain');
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'published');
    const delivery = await get(store, 'social_deliveries', f.deliveries[0]);
    assert.equal(delivery.remoteId, media.id); assert.equal(delivery.remoteRefs.permalink, media.permalink);
    assert.equal([...f.remote.objects.values()].filter(value => value.type === 'media').length, 1);
    assert.equal((await get(store, 'social_operations', operation.id)).resolution.actorId, f.actorId);
  }],
  ['ausencia confirmada exige riesgo expreso, registra nuevo ejecutor y permite un solo envío pendiente', async (store, t) => {
    const f = await setup(store, t, { platforms: ['instagram'] }), nativeFetch = f.transport.fetchImpl;
    let drop = true;
    f.transport.fetchImpl = (input, init) => {
      if (drop && init.method === 'POST' && pathOf(input) === '300/media_publish') { drop = false; throw new TypeError('Synthetic socket lost before request'); }
      return nativeFetch(input, init);
    };
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'uncertain');
    await patch(store, 'social_campaigns', f.campaignId, { restore_hold: true });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]); await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const campaign = await getSocialCampaign(store, f.campaignId), operation = (await operations(f)).find(value => value.step === 'publish');
    assert.equal([...f.remote.objects.values()].filter(value => value.type === 'media').length, 0);
    const input = { requestId: randomUUID(), version: campaign.version, deliveryId: f.deliveries[0], operationId: operation.id, specHash: f.specHash, confirmAbsence: true, acceptDuplicateRisk: true, reason: 'Ausencia comprobada por operador; reconoce riesgo residual.' };
    const options = { env: f.env, now: f.now(), transport: f.transport };
    await assert.rejects(() => socialCampaignAction(store, f.campaignId, 'confirm-absent', { ...input, requestId: randomUUID(), acceptDuplicateRisk: false }, f.actorId, options), { status: 400 });
    const result = await socialCampaignAction(store, f.campaignId, 'confirm-absent', input, f.actorId, options);
    assert.deepEqual(await socialCampaignAction(store, f.campaignId, 'confirm-absent', input, f.actorId, options), result);
    const prepared = await get(store, 'social_operations', operation.id);
    assert.equal(prepared.state, 'prepared'); assert.equal(prepared.actorId, f.actorId);
    assert.equal(prepared.resolution.previousActorId, f.approverId); assert.equal(prepared.resolution.acceptDuplicateRisk, true);
    assert.equal((await f.turn()).processed, 0);
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '300/media_publish').length, 0);
    const held = await getSocialCampaign(store, f.campaignId); await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } });
    await socialCampaignAction(store, f.campaignId, 'resume-restored', { requestId: randomUUID(), version: held.version, specHash: f.specHash, rightsAccepted: true, acceptedWarnings: [], acceptDuplicateRisk: true }, f.actorId, { ...options, now: f.now() });
    await f.until(async () => (await get(store, 'social_deliveries', f.deliveries[0])).state === 'published');
    assert.equal([...f.remote.objects.values()].filter(value => value.type === 'media').length, 1);
    assert.equal(f.remote.requests.filter(request => writing(request) && request.path === '300/media_publish').length, 1);
  }],
  ['consentimiento público de recuperación habilita un actor nuevo sin reescribir historia ni activar por sí solo', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); const delivery = await f.ready();
    const previous = await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=1`, [f.campaignId]);
    await patch(store, 'social_campaigns', f.campaignId, { restore_hold: true });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const held = await getSocialCampaign(store, f.campaignId), before = f.remote.requests.filter(writing).length;
    await socialCampaignAction(store, f.campaignId, 'resume-restored', { requestId: randomUUID(), version: held.version, specHash: f.specHash, rightsAccepted: true, acceptedWarnings: [], investmentAccepted: true, remainingBudgetMinor: delivery.budgetSnapshot.remainingMinor }, f.actorId, { env: f.env, now: f.now(), transport: f.transport });
    await f.turn();
    const restored = await getSocialCampaign(store, f.campaignId);
    assert.equal(restored.restore_hold, false); assert.equal(restored.restoredAuthorization.actorId, f.actorId);
    assert.equal(f.remote.requests.filter(writing).length, before); assert.equal(restored.deliveries[0].state, 'ready');
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } });
    const activation = await socialCampaignAction(store, f.campaignId, 'activate-paid', { requestId: randomUUID(), version: restored.version, specHash: f.specHash, preparedRefs: delivery.preparedRefs, investmentAccepted: true, remainingBudgetMinor: delivery.budgetSnapshot.remainingMinor }, f.actorId, { env: f.env, now: f.now(), transport: f.transport });
    await f.until(async () => (await get(store, 'social_operations', activation.operationId)).state === 'confirmed');
    assert.equal((await get(store, 'social_deliveries', f.deliveries[0])).state, 'active');
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=1`, [f.campaignId]), previous);
  }]
];
export async function runSocialApiJobContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async context => {
    const store = await factory();
    try { await scenario(store, context); } finally { await store.close(); }
  });
}
