// Signed synthetic browser transport shared by the compiled app and the test worker.
import assert from 'node:assert/strict';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { entity, hash, insertRow, stamp } from '../../lib/business/commands.mjs';
import { processSocialAnalysisTurn } from '../../lib/business/social-analysis-jobs.mjs';
import { processSocialBrowserTurn } from '../../lib/business/social-jobs.mjs';
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { loadSocialRuntime } from '../../lib/social/config.mjs';
import { BROWSER_BODY_LIMIT, browserSignature } from '../../lib/social/browser-client.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';

const [action, campaignId, origin] = process.argv.slice(2);
const stages = {
  preflight: { mode: 'paid', state: 'draft' },
  prepare: { mode: 'paid', state: 'queued', step: 'prepare-paid', expected: ['ready'] },
  activate: { mode: 'paid', state: 'ready', step: 'activate:', expected: ['scheduled', 'active'] },
  publish: { mode: 'organic', state: 'queued', step: 'publish', expected: ['published'] },
  'publish-uncertain': { mode: 'organic', state: 'queued', step: 'publish', expected: ['uncertain'] },
  reconcile: { mode: 'organic', state: 'uncertain', step: 'publish', expected: ['published'] },
  measure: { mode: 'organic', state: 'published', expected: ['published'] },
};
const campaignIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
assert.ok(['configure', 'serve', 'analyze'].includes(action) || Object.hasOwn(stages, action));
assert.match(origin || '', /^https:\/\/localhost:\d+$/);
assert.equal(process.env.APP_URL, origin);
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, 'db');
assert.equal(database.pathname, '/allnutrition_test');
assert.equal(process.env.DB_SSL, 'verify');
assert.ok(process.env.DB_CA_CERT_FILE || process.env.DB_CA_CERT);
assert.equal(process.env.SOCIAL_BROWSER_URL, 'http://127.0.0.1:3320');
const name = 'Cuenta sintética del estudio';
const identities = { userId: '940001', businessId: '940002', pageId: '940003', instagramId: '940004', adAccountId: '940005' };
const capabilities = { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true };
const currency = 'COP', timeZone = 'America/Bogota';
const storageState = { cookies: [], origins: [] };
const confirmed = data => ({ status: 'confirmed', data });
const text = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const metric = (label, value) => ({ value, unit: 'count', sourceMetric: label, status: 'reported', precision: 'exact', displayValue: String(value), reason: null });

const connectionRow = store => store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE integration_method='browser' AND data::jsonb->>'name'=?`, [name]).then(entity);
const nextId = () => String(randomInt(100000000000, 999999999999));
const dropReceipt = (runtime, id) => join(runtime.mediaRoot, `e2e-drop-receipt-${id}`);

function targeting({ kind, q }) {
  const location = kind === 'location', label = location ? 'Ciudad de México' : 'Fitness';
  if (q.normalize('NFKC').toLocaleLowerCase('es') !== label.toLocaleLowerCase('es')) return [];
  const context = location ? { type: 'city', countryCode: 'MX', region: 'Ciudad de México', scope: 'México / Ciudad de México' }
    : { type: 'interest', countryCode: null, region: null, scope: 'Intereses / Actividades' };
  return [{ key: hash({ label, context, businessId: identities.businessId }), label, source: 'browser', providerId: null,
    context: location ? { ...context, radius: 20, distanceUnit: 'kilometer' } : context }];
}

function recordCreative(object, spec, media, channel) {
  assert.equal(media.sha256, spec.assetHash);
  const observed = { identities, caption: text(spec.caption), headline: text(spec.headline), destinationUrl: text(spec.destinationUrl),
    whatsappNumber: text(spec.whatsappNumber), whatsappGreeting: text(spec.whatsappGreeting), aiDisclosure: spec.aiDisclosure === true,
    assetHash: media.sha256, assetType: 'image', enhancements: false, platforms: channel ? [channel] : spec.platforms };
  object.mediaEvidence = { name: basename(media.key), scope: object.remoteId, remoteMediaId: nextId(), sha256: media.sha256 };
  if (spec.mode === 'paid') {
    const { budgetMinor, startAt, endAt, objective, audience, placements } = spec;
    object.budget = { budgetMinor, remainingMinor: budgetMinor, currency, startAt, endAt };
    Object.assign(observed, { objective, budgetMinor, currency, timeZone, startAt, endAt, audience, placements, budgetType: 'lifetime',
      budgetLevel: 'Ad set', expansion: false, automaticPlacements: false, campaignCount: 1, adSetCount: 1, adCount: 1 });
  }
  object.observedSpec = observed;
}

async function serve(store) {
  const objects = new Map(), byDelivery = new Map(), executed = new Set(), nonces = new Map();
  const state = object => object.state === 'active' && Date.parse(object.budget.startAt) > Date.now() ? 'scheduled' : object.state;
  function receipt(object) {
    const paid = object.mode === 'paid', remoteId = object.remoteId, published = object.state === 'published';
    return confirmed({ state: state(object), observedSpec: object.observedSpec,
      remoteRefs: { ...(paid ? { remoteDraftRef: remoteId } : {}), ...(paid && object.everActivated || published ? { remoteId } : {}),
        ...(published ? { permalink: `https://www.instagram.com/p/${remoteId}/` } : {}) },
      ...(paid ? { preparedRefs: { remoteDraftRef: remoteId } } : {}),
      evidence: { remoteRead: true, ...(object.mediaEvidence ? { mediaEvidence: object.mediaEvidence } : {}),
        ...(paid ? { budget: object.budget, everActivated: object.everActivated } : {}) } });
  }
  async function command({ command, payload }, runtime) {
    if (command === 'open') {
      assert.notEqual(payload.purpose, 'login');
      if (payload.storageState) assert.deepEqual(payload.storageState, storageState);
      return confirmed({ opened: true });
    }
    if (command === 'close' || command === 'renew') return confirmed({});
    if (command === 'export-state') return confirmed({ storageState });
    const { kind, operation, spec, media, delivery, query } = payload;
    const ref = operation?.remoteDraftRef || delivery?.remoteRefs?.remoteDraftRef || delivery?.preparedRefs?.remoteDraftRef
      || byDelivery.get(delivery?.id) || delivery?.remoteId;
    if (command === 'inspect') {
      if (kind === 'connection') return confirmed({ state: 'connected', identities, capabilities, currency, timeZone });
      if (kind === 'audience') return confirmed({});
      assert.equal(kind, 'delivery');
      const object = objects.get(ref);
      assert.ok(object && (!delivery || object.deliveryId === delivery.id));
      return receipt(object);
    }
    if (command === 'measure') {
      const object = objects.get(ref);
      assert.equal(object?.state, 'published');
      assert.equal(object.deliveryId, delivery.id);
      assert.equal(delivery.remoteId, object.remoteId);
      assert.equal(query.scope, 'organic');
      return confirmed({ unsupportedMetrics: [], snapshots: [{ integrationMethod: 'browser', adapterVersion: 'meta-ui-v2',
        definitionVersion: 'studio-fixture-v1', apiVersion: null, query, periodStart: query.windowStart, periodEnd: query.windowEnd,
        timeZone: query.timeZone, currency: null, scope: 'organic', dimension: 'aggregate', attributionSetting: null, actionReportTime: null,
        entity: { type: 'media', id: object.remoteId }, values: { interactions: metric('Interacciones de ensayo', 0), reach: metric('Alcance de ensayo', 180) },
        rows: [], coverage: { complete: true, rowCount: 1 }, evidence: {} }] });
    }
    assert.ok(['preflight', 'execute'].includes(command) && runtime.publishingEnabled && runtime.browserEnabled);
    assert.equal(operation.state, 'sent');
    assert.ok(!executed.has(operation.id), 'Un segundo envío de la misma operación está prohibido.');
    assert.deepEqual(spec.identities, identities);
    executed.add(operation.id);
    if (command === 'preflight') {
      assert.equal(operation.acceptPrivateDraft, true);
      if (operation.step === 'prepare') {
        const remoteId = nextId();
        objects.set(remoteId, { remoteId, campaignId: operation.campaignId, mode: 'paid', state: 'private', everActivated: false });
        return confirmed({ remoteRefs: { remoteDraftRef: remoteId }, evidence: { remoteRead: true } });
      }
      const draft = objects.get(ref);
      assert.ok(draft?.state === 'private' && draft.campaignId === operation.campaignId);
      if (operation.step === 'targeting') return confirmed({ remoteRefs: { remoteDraftRef: ref }, candidates: targeting(query), evidence: { remoteRead: true } });
      assert.equal(operation.step, 'validate');
      assert.deepEqual(spec.marketCountries, ['MX', 'PE']);
      recordCreative(draft, spec, media);
      const result = receipt(draft);
      delete result.data.state;
      return result;
    }
    if (operation.step === 'publish') {
      assert.ok(!byDelivery.has(operation.deliveryId), 'La entrega ya se publicó en el proveedor sintético.');
      assert.deepEqual(spec.platforms, ['instagram']);
      assert.deepEqual(spec.marketCountries, ['MX']);
      assert.equal(spec.aiDisclosure, true);
      const remoteId = nextId(), object = { remoteId, mode: 'organic', state: 'published', deliveryId: operation.deliveryId };
      recordCreative(object, spec, media, 'instagram');
      objects.set(remoteId, object);
      byDelivery.set(operation.deliveryId, remoteId);
      const lose = await unlink(dropReceipt(runtime, operation.id)).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
      if (lose) return null;
      return receipt(object);
    }
    const draft = objects.get(ref);
    assert.ok(draft?.mode === 'paid' && draft.campaignId === operation.campaignId);
    if (operation.step === 'prepare-paid') {
      assert.ok(!byDelivery.has(operation.deliveryId) && draft.state === 'private' && !draft.everActivated);
      assert.equal(media.sha256, draft.observedSpec.assetHash);
      draft.state = 'ready';
      draft.deliveryId = operation.deliveryId;
      byDelivery.set(operation.deliveryId, draft.remoteId);
    } else {
      assert.match(operation.step, /^activate:/);
      assert.equal(operation.investmentAccepted, true);
      assert.equal(draft.state, 'ready');
      assert.equal(draft.deliveryId, operation.deliveryId);
      draft.state = 'active';
      draft.everActivated = true;
    }
    return receipt(draft);
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && request.url === '/health') return send(200, { available: true });
    if (request.method !== 'POST' || request.url !== '/control') return send(404, {});
    try {
      const now = Date.now(), time = request.headers['x-social-time'], nonce = request.headers['x-social-nonce'], signature = request.headers['x-social-signature'];
      if (!/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > 30000 || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return send(401, { errorCode: 'AUTH_FAILED' });
      const runtime = await loadSocialRuntime(store);
      if (!runtime.keys.control) return send(401, { errorCode: 'AUTH_FAILED' });
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > BROWSER_BODY_LIMIT) return send(413, { errorCode: 'AUTH_FAILED' });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const expected = browserSignature(runtime.keys.control, 'POST', '/control', time, nonce, body);
      for (const [previous, expires] of nonces) if (now > expires) nonces.delete(previous);
      if (nonces.has(nonce) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return send(401, { errorCode: 'AUTH_FAILED' });
      nonces.set(nonce, Number(time) + 30000);
      const input = JSON.parse(body.toString('utf8')), connection = await connectionRow(store);
      if (!connection || input.connectionId !== connection.id || input.sessionEpoch !== 0 ||
          input.configurationVersion !== runtime.configurationVersion || input.browserEnabled !== runtime.browserEnabled || input.publishingEnabled !== runtime.publishingEnabled) return send(409, { errorCode: 'SPEC_MISMATCH' });
      const lease = input.lease;
      if (lease?.key !== `social:browser-lock:${connection.id}` || !(Date.parse(lease.leaseUntil) > now) ||
          !await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key=? AND state='running' AND lease_token=? AND lease_until>=?`, [lease.key, lease.token, lease.leaseUntil])) return send(409, { errorCode: 'LEASE_LOST' });
      const result = await command(input, runtime);
      if (!result) response.destroy(); // Lost acknowledgement after the only remote effect.
      else send(200, result);
    } catch (error) {
      console.error('El transporte sintético rechazó el comando:', error.message);
      send(409, { errorCode: 'LAYOUT_CHANGED' });
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3320, '127.0.0.1');
    process.once('SIGTERM', () => { server.close(); server.closeAllConnections(); });
    server.once('close', resolve);
  });
}

const store = await openStore();
try {
  const pg = await store.db.get('SELECT current_database() AS name, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  assert.deepEqual(pg, { name: 'allnutrition_test', ssl: true });
  assert.equal(await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`), null);
  const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email='e2e@example.test' AND active=1`);
  assert.ok(actor, 'El fixture debe estar sembrado.');
  if (action === 'serve') await serve(store);
  else if (action === 'configure') {
    let synthetic = await connectionRow(store);
    if (!synthetic) {
      const initial = await loadSocialRuntime(store);
      assert.equal(initial.configurationVersion, 0, 'No se reemplaza configuración de otro escenario.');
      assert.equal(await store.db.get(`SELECT id FROM ${store.t('social_connections')} LIMIT 1`), null);
      await saveSocialSettings(store, { version: 0, requestId: randomUUID(), publicBaseUrl: origin, appId: '', loginConfigId: '', browserEnabled: true, publishingEnabled: true }, actor.id, { allowedOrigins: [origin], env: process.env });
      const runtime = await loadSocialRuntime(store), id = randomUUID(), now = stamp();
      const resources = { businesses: [{ id: identities.businessId, name: 'Negocio de ensayo' }], pages: [{ id: identities.pageId, name: 'Página de ensayo', businessId: identities.businessId, instagramId: identities.instagramId, tasks: ['CREATE_CONTENT'] }], adAccounts: [{ id: identities.adAccountId, name: 'Cuenta publicitaria de ensayo', businessId: identities.businessId, currency, timeZone }] };
      await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: 'browser', state: 'connected', version: 1, created_at: now, updated_at: now, data: JSON.stringify({ name, identities, capabilities, resources, currency, timeZone, sessionEpoch: 0, validatedAt: now, configurationFingerprint: runtime.fingerprint }) });
      await saveCredentials(store, id, { storageState }, { runtime });
      synthetic = { id, identities };
    }
    assert.deepEqual(synthetic.identities, identities);
    console.log(JSON.stringify({ connectionId: synthetic.id, identities }));
  } else if (action === 'analyze') {
    assert.match(campaignId || '', campaignIdPattern);
    const job = await store.db.get(`SELECT state FROM ${store.t('job_runs')} WHERE key=?`, [`social:analysis:${campaignId}`]);
    assert.equal(job?.state, 'queued', 'Solicita el análisis antes de consumirlo.');
    const result = await processSocialAnalysisTurn(store, { maxCampaigns: 1 });
    assert.equal(result.processed, 1);
    const analysis = result.results[0];
    assert.equal(analysis.campaignId, campaignId);
    assert.equal(analysis.state, 'succeeded');
    assert.equal(analysis.errorCode, null);
    console.log(JSON.stringify(analysis));
  } else {
    assert.match(campaignId || '', campaignIdPattern);
    const synthetic = await connectionRow(store), stage = stages[action];
    assert.deepEqual(synthetic?.identities, identities);
    const campaign = entity(await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [campaignId]));
    assert.equal(campaign?.mode, stage.mode);
    assert.equal(campaign.connectionId, synthetic.id);
    const paid = stage.mode === 'paid', preflight = action === 'preflight';
    if (!preflight) assert.deepEqual(campaign.marketCountries, paid ? ['MX', 'PE'] : ['MX']);
    const deliveries = await store.db.all(`SELECT * FROM ${store.t('social_deliveries')} WHERE campaign_id=?`, [campaignId]);
    assert.equal(deliveries.length, preflight ? 0 : 1);
    const target = entity(deliveries[0]);
    if (preflight) assert.equal(campaign.state, stage.state);
    else {
      assert.equal(target.channel, paid ? 'meta_ads' : 'instagram');
      assert.equal(target.state, stage.state);
    }
    let operation;
    if (action === 'measure') assert.ok(target.metricsRequestedAt, 'Solicita medición explícitamente antes de consumirla.');
    else {
      const operations = (await store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE campaign_id=? AND state=?`,
        [campaignId, action === 'reconcile' ? 'uncertain' : 'prepared'])).map(entity);
      operation = preflight ? operations.find(value => value.id === campaign.preflight?.operationId && !value.deliveryId)
        : operations.find(value => value.deliveryId === target.id && value.step.startsWith(stage.step));
      assert.ok(operation, 'La interfaz no encoló la operación esperada.');
    }
    if (action === 'publish-uncertain') await writeFile(dropReceipt(await loadSocialRuntime(store), operation.id), '', { flag: 'wx', mode: 0o600 });
    const result = await processSocialBrowserTurn(store, { maxOperations: 1 });
    const uncertain = action === 'publish-uncertain';
    assert.equal(result.errorCode, uncertain ? 'OPERATION_UNCERTAIN' : null);
    assert.equal(result.processed, 1);
    if (operation) {
      const current = entity(await store.db.get(`SELECT * FROM ${store.t('social_operations')} WHERE id=?`, [operation.id]));
      assert.equal(current.state, uncertain ? 'uncertain' : 'confirmed');
      assert.equal(current.attempts, 1, 'La lectura de una operación incierta no debe volver a enviarla.');
    }
    if (preflight) {
      const { preflight } = entity(await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [campaignId]));
      assert.equal(preflight.kind, operation.step);
      console.log(JSON.stringify({ operationId: operation.id, stage: operation.step, remoteDraftRef: preflight.remoteDraftRef, candidates: preflight.candidates || [] }));
    } else {
      const current = entity(await store.db.get(`SELECT * FROM ${store.t('social_deliveries')} WHERE id=?`, [target.id]));
      assert.ok(stage.expected.includes(current.state), `Estado de entrega inesperado: ${current.state}`);
      if (action === 'prepare') {
        assert.ok(current.preparedRefs.remoteDraftRef && !current.remoteId && !current.everActivated);
        assert.equal(current.budgetSnapshot.remainingMinor, current.budgetSnapshot.budgetMinor);
      } else if (uncertain) assert.ok(!current.remoteId);
      else assert.ok(current.remoteId);
      const measurement = action === 'measure' ? await store.db.get(`SELECT id FROM ${store.t('social_measurements')} WHERE delivery_id=? ORDER BY fetched_at DESC LIMIT 1`, [target.id]) : null;
      if (action === 'measure') assert.ok(measurement?.id);
      console.log(JSON.stringify({ state: current.state, operationId: operation?.id || null, deliveryId: target.id, remoteId: current.remoteId, measurementId: measurement?.id || null }));
    }
  }
} finally { await store.close(); }
