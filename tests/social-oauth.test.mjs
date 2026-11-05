import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { hash, insertRow, stamp, audit } from '../lib/business/commands.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';
import { startSocialOAuth, consumeSocialOAuthState, completeSocialOAuth, createBrowserSocialConnection, getSocialConnections, socialConnectionAction, previewSocialConnectionDeletion, deauthorizeSocialMeta, verifyMetaSignedRequest } from '../lib/business/social-connections.mjs';
import { loadCredentials, saveCredentials } from '../lib/social/credentials.mjs';
import { META_PERMISSIONS } from '../lib/social/config.mjs';
import { queueJobTx } from '../lib/business/job-leases.mjs';
import { socialConnection, socialTestEnv } from './social-contract.mjs';
import { createBusinessBasics, businessOrderInput, fixtureActor } from './business-fixtures.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';

const envFor = () => ({ ...socialTestEnv(), APP_URL: 'https://admin.example.test', META_APP_ID: '901', META_APP_SECRET: 'SYNTHETIC-APP-SECRET', META_LOGIN_CONFIG_ID: '902' });
const admin = () => ({ user: { id: fixtureActor }, csrf: 'SYNTHETIC-CSRF', expires: Date.now() + 3600000 });
async function withStore(fn) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await insertRow(store, 'users', { id: fixtureActor, email: 'social-admin@example.test', password: 'unused-synthetic-password', active: 1 });
    await fn(store);
  } finally { await store.close(); }
}
function provider(env) {
  const remote = { userId: '101', businessId: '301', pageId: '201', instagramId: '401', accountId: 'act_501', valid: true, exchanges: 0, calls: [], status: 'ACTIVE', losePauseResponse: false };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), path = url.pathname.replace(/^\/v26\.0\//, ''), body = new URLSearchParams(init.body);
    assert.equal(url.hostname, 'graph.facebook.com');
    remote.calls.push({ path, method: init.method || 'GET' });
    if (path === 'oauth/access_token') {
      remote.exchanges++;
      if (url.searchParams.has('code')) assert.equal(url.searchParams.get('redirect_uri'), `${env.APP_URL}/api/admin/social/oauth/callback`);
      return Response.json({ access_token: 'TOKEN-CANARY-USER', expires_in: 5184000 });
    }
    if (path === 'debug_token') return Response.json({ data: { app_id: env.META_APP_ID, is_valid: remote.valid, type: 'USER', user_id: remote.userId, expires_at: Math.floor(Date.now() / 1000) + 5000000, data_access_expires_at: Math.floor(Date.now() / 1000) + 5000000, scopes: META_PERMISSIONS } });
    if (path === 'me') return Response.json({ id: remote.userId, name: 'Cuenta de prueba' });
    if (path === 'me/permissions') return Response.json({ data: META_PERMISSIONS.map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me/accounts') return Response.json({ data: [{ id: remote.pageId, name: 'Página verificada', access_token: 'TOKEN-CANARY-PAGE', tasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'], business: { id: remote.businessId, name: 'Negocio verificado' }, instagram_business_account: { id: remote.instagramId }, whatsapp_number: '+573001234567' }] });
    if (path === 'me/adaccounts') return Response.json({ data: [{ id: remote.accountId, name: 'Cuenta publicitaria verificada', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: ['ADVERTISE', 'ANALYZE'], business: { id: remote.businessId, name: 'Negocio verificado' } }] });
    if (path === '701') {
      if (init.method === 'POST') {
        assert.equal(body.get('status'), 'PAUSED'); remote.status = 'PAUSED';
        if (remote.losePauseResponse) throw new Error('Synthetic lost response');
        return Response.json({ success: true });
      }
      return Response.json({ id: '701', account_id: '501', status: remote.status, effective_status: remote.status });
    }
    throw new Error(`Unexpected synthetic provider path: ${path}`);
  };
  return { remote, fetchImpl };
}
async function connect(store, env, fixture, session = admin(), connectionId = null) {
  const started = await startSocialOAuth(store, { connectionId }, session, { env });
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  return completeSocialOAuth(store, { code: 'SYNTHETIC-CODE', state }, session, { env, fetchImpl: fixture.fetchImpl });
}
function signed(userId, secret, issuedAt = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: userId, issued_at: issuedAt })).toString('base64url');
  return `${createHmac('sha256', secret).update(payload).digest('base64url')}.${payload}`;
}
async function campaignGraph(store, connection, { state = 'queued', sent = false } = {}) {
  const at = stamp(), assetId = randomUUID(), campaignId = randomUUID(), deliveryId = randomUUID(), operationId = randomUUID();
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: hash('synthetic-asset'), bytes: 15, data: '{}', version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connection.id, asset_id: assetId, name: 'Campaña sintética', mode: 'paid', objective: 'traffic', state: 'ready', data: '{}', version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash('spec'), approved_at: at, actor_id: fixtureActor, data: '{}' });
  await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: campaignId, revision: 1, channel: 'meta_ads', state, remote_id: state === 'active' ? '701' : null, next_sync_at: at, data: JSON.stringify({ remoteRefs: { campaignId: '701' } }), version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_operations', { id: operationId, campaign_id: campaignId, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:create_campaign`, step: 'create_campaign', state: sent ? 'sent' : 'prepared', next_attempt_at: at, data: '{}', version: 1, created_at: at, updated_at: at });
  return { assetId, campaignId, deliveryId, operationId };
}

test('OAuth guarda solo hash y consume una vez, ligado a actor, sesión y caducidad', () => withStore(async store => {
  const env = envFor(), session = admin(), now = stamp();
  const started = await startSocialOAuth(store, {}, session, { env, now });
  const url = new URL(started.authorizationUrl), state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('config_id'), env.META_LOGIN_CONFIG_ID);
  assert.equal(url.searchParams.get('redirect_uri'), `${env.APP_URL}/api/admin/social/oauth/callback`);
  assert.equal(Buffer.from(state, 'base64url').length, 32);
  const row = await store.db.get(`SELECT * FROM ${store.t('social_oauth_states')}`);
  assert.equal(row.state_hash, hash(state)); assert.equal(row.csrf_hash, hash(session.csrf));
  assert.equal(JSON.stringify(row).includes(state), false);
  assert.equal(Date.parse(row.expires_at) - Date.parse(now), 600000);
  await assert.rejects(() => consumeSocialOAuthState(store, state, { ...session, user: { id: 'another-admin' } }), { status: 403 });
  await assert.rejects(() => consumeSocialOAuthState(store, state, { ...session, csrf: 'another-session' }), { status: 403 });
  await assert.rejects(() => consumeSocialOAuthState(store, '', session), { status: 403 });
  await assert.rejects(() => consumeSocialOAuthState(store, state, session, { now: row.expires_at }), { status: 403 });
  const simultaneous = await Promise.allSettled([consumeSocialOAuthState(store, state, session), consumeSocialOAuthState(store, state, session)]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(() => consumeSocialOAuthState(store, state, session), { status: 403 });
  await assert.rejects(() => startSocialOAuth(store, {}, { ...session, expires: 0 }, { env }), { status: 401 });
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), []);
}));

test('intercambio fuera de transacción, tokens en custodia y reconexión con identidad fija', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), session = admin();
  const transaction = store.transaction.bind(store);
  let insideTransaction = false;
  store.transaction = callback => transaction(async tx => {
    insideTransaction = true;
    try { return await callback(tx); } finally { insideTransaction = false; }
  });
  const fetchProvider = fixture.fetchImpl;
  fixture.fetchImpl = async (url, init) => {
    assert.equal(insideTransaction, false, 'La red no mantiene una transacción de negocio abierta');
    return fetchProvider(url, init);
  };
  const { connection } = await connect(store, env, fixture, session);
  assert.equal(connection.identities.userId, '101'); assert.equal(fixture.remote.exchanges, 2);
  const token = await loadCredentials(store, await getSocialConnection(store, connection.id), env);
  assert.equal(token.accessToken, 'TOKEN-CANARY-USER'); assert.equal(token.pageTokens['201'], 'TOKEN-CANARY-PAGE');
  const listed = await getSocialConnections(store, { env });
  const persisted = JSON.stringify({ listed, audit: await store.db.all(`SELECT * FROM ${store.t('business_audit')}`), requests: await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), credentials: await store.db.all(`SELECT * FROM ${store.t('social_credentials')}`) });
  assert.equal(persisted.includes('TOKEN-CANARY'), false); assert.equal(persisted.includes('SYNTHETIC-CODE'), false);
  fixture.remote.userId = '102';
  await assert.rejects(() => connect(store, env, fixture, session, connection.id), { status: 409 });
  assert.equal((await getSocialConnection(store, connection.id)).version, 1);
  assert.equal((await loadCredentials(store, await getSocialConnection(store, connection.id), env)).userId, '101');
  fixture.remote.userId = '101';
  const restored = await connect(store, env, fixture, session, connection.id);
  assert.equal(restored.connection.id, connection.id); assert.equal(restored.connection.version, 2);
}));

test('selección verifica pertenencia y no cambia assets después de aprobación', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  await assert.rejects(() => socialConnectionAction(store, connection.id, 'select-assets', { version: 1, requestId: randomUUID(), identities: { pageId: '999' } }, fixtureActor, { env, fetchImpl: fixture.fetchImpl }), { status: 400 });
  const selected = await socialConnectionAction(store, connection.id, 'select-assets', { version: 1, requestId: randomUUID(), identities: { businessId: '301', pageId: '201', instagramId: '401', adAccountId: 'act_501' } }, fixtureActor, { env, fetchImpl: fixture.fetchImpl });
  assert.equal(selected.capabilities.facebookPublish, true); assert.equal(selected.capabilities.whatsappAds, true); assert.equal(selected.currency, 'COP');
  await campaignGraph(store, selected);
  await assert.rejects(() => socialConnectionAction(store, selected.id, 'select-assets', { version: selected.version, requestId: randomUUID(), identities: { adAccountId: null } }, fixtureActor, { env, fetchImpl: fixture.fetchImpl }), { status: 409 });
  fixture.remote.businessId = '302';
  await assert.rejects(() => connect(store, env, fixture, admin(), selected.id), { status: 409 });
}));

test('revocación exige HMAC válido, es idempotente y bloquea exclusivamente API del usuario', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  const browser = await socialConnection(store, { method: 'browser', data: { identities: { userId: '101' } } });
  const other = await socialConnection(store, { data: { identities: { userId: '202' } } });
  const request = signed('101', env.META_APP_SECRET);
  assert.throws(() => verifyMetaSignedRequest(`${request.slice(0, -1)}!`, env.META_APP_SECRET), { status: 403 });
  await assert.rejects(() => deauthorizeSocialMeta(store, signed('101', 'wrong-secret'), { env }), { status: 403 });
  const graph = await campaignGraph(store, connection, { sent: true });
  await store.transaction(tx => queueJobTx(tx, `social:delivery:${graph.deliveryId}`, { deliveryId: graph.deliveryId }));
  await deauthorizeSocialMeta(store, request, { env });
  const revoked = await getSocialConnection(store, connection.id);
  assert.equal(revoked.state, 'reconnect_required'); assert.equal(await loadCredentials(store, revoked, env), null);
  assert.equal((await getSocialConnection(store, browser.id)).state, 'connected'); assert.equal((await getSocialConnection(store, other.id)).state, 'connected');
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_operations')} WHERE id=?`, [graph.operationId])).state, 'uncertain');
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_deliveries')} WHERE id=?`, [graph.deliveryId])).state, 'uncertain');
  await deauthorizeSocialMeta(store, request, { env });
  assert.equal((await getSocialConnection(store, connection.id)).version, revoked.version);
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('job_runs')} WHERE key=?`, [`social:delivery:${graph.deliveryId}`])).state, 'failed');
}));

test('desconexión del navegador revoca epoch, lock y control sin borrar historial incierto', () => withStore(async store => {
  const env = envFor(), browser = await createBrowserSocialConnection(store, { integrationMethod: 'browser', name: 'Navegador sintético', requestId: randomUUID() }, fixtureActor);
  await saveCredentials(store, browser.id, { storageState: { cookies: [], origins: [] } }, { env });
  const graph = await campaignGraph(store, browser, { sent: true }), now = stamp(), controlId = randomUUID();
  await insertRow(store, 'social_browser_controls', { id: controlId, connection_id: browser.id, actor_id: fixtureActor, session_binding: hash('csrf'), lease_key: `social:browser-lock:${browser.id}`, lease_token: 'SYNTHETIC-LEASE', state: 'active', expires_at: new Date(Date.now() + 60000).toISOString(), last_seen_at: now, created_at: now, updated_at: now });
  await store.transaction(tx => queueJobTx(tx, `social:browser-lock:${browser.id}`, { connectionId: browser.id }));
  const input = { version: 1, requestId: randomUUID() };
  const result = await socialConnectionAction(store, browser.id, 'disconnect', input, fixtureActor, { env });
  assert.equal(result.connection.state, 'disconnected'); assert.equal(result.connection.sessionEpoch, 1); assert.equal(result.remoteSpendStopped, false);
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [controlId])).state, 'cancelled');
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_operations')} WHERE id=?`, [graph.operationId])).state, 'uncertain');
  assert.equal(await loadCredentials(store, result.connection, env), null);
  assert.deepEqual(await socialConnectionAction(store, browser.id, 'disconnect', input, fixtureActor, { env }), result);
}));

test('anuncios activos requieren advertencia o pausa remota comprobada; no afirma pausa ante respuesta perdida', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  const selected = await socialConnectionAction(store, connection.id, 'select-assets', { version: 1, requestId: randomUUID(), identities: { businessId: '301', pageId: '201', adAccountId: 'act_501' } }, fixtureActor, { env, fetchImpl: fixture.fetchImpl });
  await campaignGraph(store, selected, { state: 'active' });
  await assert.rejects(() => socialConnectionAction(store, selected.id, 'disconnect', { version: selected.version, requestId: randomUUID() }, fixtureActor, { env, fetchImpl: fixture.fetchImpl }), { status: 409 });
  fixture.remote.losePauseResponse = true;
  await assert.rejects(() => socialConnectionAction(store, selected.id, 'disconnect', { version: selected.version, requestId: randomUUID(), pauseAndDisconnect: true }, fixtureActor, { env, fetchImpl: fixture.fetchImpl }));
  assert.equal((await getSocialConnection(store, selected.id)).state, 'connected');
  assert.ok((await store.db.all(`SELECT state FROM ${store.t('social_operations')}`)).some(row => row.state === 'uncertain'));
  fixture.remote.losePauseResponse = false;
  const result = await socialConnectionAction(store, selected.id, 'disconnect', { version: selected.version, requestId: randomUUID(), pauseAndDisconnect: true }, fixtureActor, { env, fetchImpl: fixture.fetchImpl });
  assert.equal(result.remoteSpendStopped, true); assert.equal(fixture.remote.status, 'PAUSED');
}));

test('eliminar datos requiere conteos confirmados, conserva documentos y piezas, retira jobs y referencias', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture), graph = await campaignGraph(store, connection);
  const business = await createBusinessBasics(store, { withPlatform: false });
  const order = await store.saveOrder(businessOrderInput(business.a), fixtureActor);
  const expense = await recordExpense(store, { requestId: randomUUID(), category: 'advertising', amountMinor: 100000, incurredOn: `${business.year}-09-02`, concept: 'Pauta sintética' }, fixtureActor);
  const at = stamp(), recommendationId = randomUUID();
  await insertRow(store, 'social_order_links', { order_id: order.id, campaign_id: graph.campaignId, actor_id: fixtureActor, reason: 'Origen declarado', data: '{}', version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_expense_links', { expense_id: expense.id, campaign_id: graph.campaignId, actor_id: fixtureActor, reason: 'Gasto vinculado', data: '{}', version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_recommendations', { id: recommendationId, campaign_id: graph.campaignId, evidence_hash: hash('evidence'), rule_key: 'measurement_gap', state: 'suggested', data: '{}', version: 1, created_at: at, updated_at: at });
  await insertRow(store, 'social_measurements', { id: randomUUID(), delivery_id: graph.deliveryId, query_key: 'synthetic', fetched_at: at, payload_hash: hash('metrics'), data: '{}' });
  await insertRow(store, 'social_forecasts', { id: randomUUID(), campaign_id: graph.campaignId, spec_hash: hash('spec'), generated_at: at, data: '{}' });
  const draftId = randomUUID();
  await insertRow(store, 'social_campaigns', { id: draftId, connection_id: null, asset_id: null, name: 'Borrador conservado', mode: 'organic', objective: 'reach', state: 'draft', data: JSON.stringify({ parentCampaignId: graph.campaignId, sourceRecommendationId: recommendationId }), version: 1, created_at: at, updated_at: at });
  await store.transaction(async tx => {
    await queueJobTx(tx, `social:delivery:${graph.deliveryId}`, { campaignId: graph.campaignId, deliveryId: graph.deliveryId });
    await queueJobTx(tx, `social:analysis:${graph.campaignId}`, { campaignId: graph.campaignId });
    await queueJobTx(tx, `business:unrelated:${randomUUID()}`, { orderId: order.id });
    await audit(tx, { entityType: 'social_campaign', entityId: graph.campaignId, actorId: fixtureActor, next: { userId: '101' } });
  });
  const before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
  const preview = await previewSocialConnectionDeletion(store, connection.id);
  const input = { version: 1, requestId: randomUUID(), confirmDelete: true, confirmCounts: preview.counts };
  await assert.rejects(() => socialConnectionAction(store, connection.id, 'delete-platform-data', { ...input, confirmCounts: { ...preview.counts, campaigns: 0 } }, fixtureActor, { env }), { status: 409 });
  const receipt = await socialConnectionAction(store, connection.id, 'delete-platform-data', input, fixtureActor, { env });
  assert.equal(receipt.counts.campaigns, 1); assert.equal(receipt.counts.measurements, 1);
  assert.equal(receipt.remoteContentDeleted, false); assert.equal(receipt.remoteSpendStopped, false);
  assert.ok(await store.db.get(`SELECT id FROM ${store.t('orders')} WHERE id=?`, [order.id]));
  assert.ok(await store.db.get(`SELECT id FROM ${store.t('expenses')} WHERE id=?`, [expense.id]));
  assert.ok(await store.db.get(`SELECT id FROM ${store.t('social_assets')} WHERE id=?`, [graph.assetId]));
  for (const table of ['social_connections', 'social_credentials', 'social_order_links', 'social_expense_links', 'social_recommendations', 'social_forecasts', 'social_measurements', 'social_operations', 'social_deliveries', 'social_revisions']) assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t(table)}`), []);
  const draft = JSON.parse((await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [draftId])).data);
  assert.equal(draft.parentCampaignId, undefined); assert.equal(draft.sourceRecommendationId, undefined);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('job_runs')} WHERE key LIKE 'social:%'`), []);
  assert.equal((await store.db.all(`SELECT * FROM ${store.t('job_runs')} WHERE key LIKE 'business:%'`)).length, 1);
  assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
  const receiptAudit = await store.db.all(`SELECT * FROM ${store.t('business_audit')} WHERE entity_type='social_deletion_receipt'`);
  assert.equal(receiptAudit.length, 1); assert.equal(JSON.stringify(receiptAudit).includes(connection.id), false);
  assert.deepEqual(await socialConnectionAction(store, connection.id, 'delete-platform-data', input, fixtureActor, { env }), receipt);
}));

test('OAuth denegado y replay no intercambian código ni destruyen credenciales anteriores', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), session = admin(), { connection } = await connect(store, env, fixture, session);
  const started = await startSocialOAuth(store, { connectionId: connection.id }, session, { env });
  const state = new URL(started.authorizationUrl).searchParams.get('state'), exchanges = fixture.remote.exchanges;
  await assert.rejects(() => completeSocialOAuth(store, { state, error: 'access_denied' }, session, { env, fetchImpl: fixture.fetchImpl }), { status: 400 });
  await assert.rejects(() => completeSocialOAuth(store, { state, code: 'REPLAY-CODE' }, session, { env, fetchImpl: fixture.fetchImpl }), { status: 403 });
  assert.equal(fixture.remote.exchanges, exchanges);
  assert.equal((await loadCredentials(store, await getSocialConnection(store, connection.id), env)).accessToken, 'TOKEN-CANARY-USER');
  assert.equal((await getSocialConnection(store, connection.id)).state, 'connected');
}));

test('credenciales rotadas durante una validación no admiten escritura tardía del token antiguo', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  let rotated = false;
  const rotatingFetch = async (url, init) => {
    if (!rotated && new URL(url).pathname.endsWith('/me/adaccounts')) {
      rotated = true;
      await saveCredentials(store, connection.id, { accessToken: 'TOKEN-NEW-ROTATION', userId: '101' }, { expectedVersion: 1, sessionEpoch: connection.sessionEpoch, env });
    }
    return fixture.fetchImpl(url, init);
  };
  await assert.rejects(() => socialConnectionAction(store, connection.id, 'validate', { version: 1, requestId: randomUUID() }, fixtureActor, { env, fetchImpl: rotatingFetch }), { status: 409 });
  assert.equal((await loadCredentials(store, await getSocialConnection(store, connection.id), env)).accessToken, 'TOKEN-NEW-ROTATION');
  assert.equal((await getSocialConnection(store, connection.id)).version, 1);
}));

test('token revocado bloquea consulta API local sin afectar otra vía', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  const browser = await socialConnection(store, { method: 'browser' });
  fixture.remote.valid = false;
  const result = await socialConnectionAction(store, connection.id, 'validate', { version: 1, requestId: randomUUID() }, fixtureActor, { env, fetchImpl: fixture.fetchImpl });
  assert.equal(result.state, 'reconnect_required');
  assert.equal(await loadCredentials(store, result, env), null);
  assert.equal((await getSocialConnection(store, browser.id)).state, 'connected');
}));

test('pausa rechaza credenciales sustituidas antes del envío y no realiza POST tardío', () => withStore(async store => {
  const env = envFor(), fixture = provider(env), { connection } = await connect(store, env, fixture);
  const selected = await socialConnectionAction(store, connection.id, 'select-assets', { version: 1, requestId: randomUUID(), identities: { pageId: '201', adAccountId: 'act_501' } }, fixtureActor, { env, fetchImpl: fixture.fetchImpl });
  await campaignGraph(store, selected, { state: 'active' });
  const credentialRow = await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [selected.id]);
  let rotated = false;
  const rotatingFetch = async (url, init) => {
    const response = await fixture.fetchImpl(url, init);
    if (!rotated && new URL(url).pathname.endsWith('/701')) {
      rotated = true;
      await saveCredentials(store, selected.id, { accessToken: 'TOKEN-NEW-BEFORE-PAUSE', userId: '101' }, { expectedVersion: credentialRow.version, sessionEpoch: selected.sessionEpoch, env });
    }
    return response;
  };
  await assert.rejects(() => socialConnectionAction(store, selected.id, 'disconnect', { version: selected.version, requestId: randomUUID(), pauseAndDisconnect: true }, fixtureActor, { env, fetchImpl: rotatingFetch }), { status: 409 });
  assert.equal(fixture.remote.calls.filter(call => call.path === '701' && call.method === 'POST').length, 0);
  assert.equal((await getSocialConnection(store, selected.id)).state, 'connected');
  assert.equal((await loadCredentials(store, await getSocialConnection(store, selected.id), env)).accessToken, 'TOKEN-NEW-BEFORE-PAUSE');
}));
