import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin, login, logout } from '../lib/auth.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { assertAssistantSession, disconnectAssistantOAuth, getAssistantSettings, loadAssistantRuntime, saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { assistantOAuthErrorResponse, completeAssistantOAuth, startAssistantOAuth } from '../lib/assistant/oauth.mjs';
import { createAssistantProvider } from '../lib/assistant/provider.mjs';
import { completeAssistantCycle } from './assistant-cycle-helper.mjs';
import { hashAssistantInput, reserveAssistantTurn } from '../lib/assistant/repository.mjs';
import { ASSISTANT_OAUTH_INTERNAL_TABLES, ASSISTANT_WORK_INTERNAL_TABLES, migrateAssistantOAuthV12, migrateAssistantWorkV13 } from '../lib/db/migrations.mjs';
import { importData } from '../lib/import.mjs';

const scope = 'https://www.googleapis.com/auth/cloud-platform';
const digest = value => createHash('sha256').update(value).digest('hex');
const reply = (name, args) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });
const denied = () => Object.assign(new Error('synthetic provider diagnostic must stay private'), { code: 'ASSISTANT_CREDENTIAL_INVALID', status: 422 });
async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ali-oauth-'));
  const env = {
    DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:', APP_URL: 'https://ali.example.test',
    ASSISTANT_GOOGLE_CLIENT_ID: 'SYNTHETIC-CLIENT.apps.googleusercontent.com', ASSISTANT_GOOGLE_CLIENT_SECRET: 'SYNTHETIC-SECRET',
    INTEGRATION_SECRETS_DIR: join(directory, 'secrets'), SOCIAL_BROWSER_CONTROL_DIR: join(directory, 'control'),
  };
  const store = await openStore(env);
  await createAdmin(store, 'ali-oauth@example.test', 'synthetic-only-password');
  const authenticated = await login(store, 'ali-oauth@example.test', 'synthetic-only-password');
  const session = { user: authenticated.user, csrf: authenticated.csrf, sessionTokenHash: digest(authenticated.token) };
  const keyring = createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
  const events = [], behavior = { probeDenied: false, refreshDenied: false, revokeUnavailable: false, expiresIn: 3600, refreshes: 0, exchanges: 0 };
  const fetchImpl = async (url, init) => {
    const form = new URLSearchParams(init.body);
    events.push({ url, form });
    if (url.endsWith('/revoke')) return new Response('', { status: behavior.revokeUnavailable ? 503 : 200 });
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(form.get('client_id'), env.ASSISTANT_GOOGLE_CLIENT_ID);
    assert.equal(form.get('client_secret'), env.ASSISTANT_GOOGLE_CLIENT_SECRET);
    if (form.get('grant_type') === 'refresh_token') {
      behavior.refreshes++;
      if (behavior.refreshDenied) return Response.json({ error: 'invalid_grant', error_description: 'SYNTHETIC-PRIVATE-DIAGNOSTIC' }, { status: 400 });
      return Response.json({ access_token: 'SYNTHETIC-ROTATED-ACCESS', refresh_token: 'SYNTHETIC-ROTATED-REFRESH', token_type: 'Bearer', expires_in: 3600, scope });
    }
    behavior.exchanges++;
    assert.equal(form.get('redirect_uri'), `${env.APP_URL}/api/admin/assistant/oauth/callback`);
    assert.ok(form.get('code_verifier'));
    return Response.json({ access_token: 'SYNTHETIC-ACCESS', refresh_token: 'SYNTHETIC-REFRESH', token_type: 'Bearer', expires_in: behavior.expiresIn, scope });
  };
  const transport = async (url, request) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(request.authMethod, 'oauth');
    assert.equal(request.apiKey, null);
    assert.equal(request.accessToken, 'SYNTHETIC-ACCESS');
    assert.equal(request.projectId, 'ali-project-123');
    const body = JSON.parse(request.body);
    assert.deepEqual(body.toolConfig.functionCallingConfig.allowedFunctionNames, ['assistant_connection_check']);
    assert.equal(request.body.includes('SYNTHETIC-ACCESS'), false);
    if (behavior.probeDenied) throw denied();
    return reply('assistant_connection_check', { ok: true });
  };
  const options = { env, keyring, fetchImpl, transport };
  async function start() {
    const result = await startAssistantOAuth(store, { version: (await getAssistantSettings(store)).version, provider: 'gemini', model: 'gemini-2.5-flash', projectId: 'ali-project-123' }, session, options);
    const url = new URL(result.authorizationUrl);
    return { url, state: url.searchParams.get('state') };
  }
  async function connect() {
    const { state } = await start();
    return (await completeAssistantOAuth(store, { state, code: 'SYNTHETIC-AUTHORIZATION-CODE' }, session, options)).settings;
  }
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, env, session, token: authenticated.token, keyring, options, behavior, events, start, connect, directory };
}
function keySettings(version, patch = {}) {
  return { version, requestId: randomUUID(), enabled: true, provider: 'openai', model: 'gpt-4.1-mini', baseUrl: null, allowPrivateNetwork: false, authMethod: 'api-key', projectId: null, apiKey: 'SYNTHETIC-API-KEY', ...patch };
}

// This exercises the real settings, provider wire parser, engine and persistence,
// without credentials or network access to a real provider.
test('Google OAuth verifies a function call before enabling Ali and permits an actual turn without an APIKey', async t => {
  const f = await fixture(t), initial = await f.start();
  assert.equal((await getAssistantSettings(f.store)).enabled, false);
  const pending = await f.store.db.get('SELECT * FROM assistant_oauth_states');
  assert.equal(pending.state_hash, digest(initial.state));
  assert.equal(JSON.stringify(pending).includes(initial.state), false);
  assert.equal(JSON.stringify(pending).includes('codeVerifier'), false);
  const result = (await completeAssistantOAuth(f.store, { state: initial.state, code: 'SYNTHETIC-CODE' }, f.session, f.options)).settings;
  assert.equal(result.enabled, true);
  assert.equal(result.authMethod, 'oauth');
  assert.equal(result.hasApiKey, false);
  assert.equal(result.hasOAuthConnection, true);
  assert.equal(result.connectionStatus, 'ready');
  const runtime = await loadAssistantRuntime(f.store, f.options);
  assert.equal(runtime.accessToken, 'SYNTHETIC-ACCESS');
  assert.equal(runtime.apiKey, null);
  assert.equal(JSON.stringify(await f.store.db.all('SELECT * FROM assistant_oauth_credentials')).includes('SYNTHETIC-ACCESS'), false);
  assert.equal(JSON.stringify(await f.store.exportData()).includes('SYNTHETIC-'), false);
  const oldEnv = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  t.after(() => { for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const turn = await completeAssistantCycle(f.store, f.session, { requestId: randomUUID(), threadId: null, threadVersion: null, message: 'Revisa los datos del negocio.', answer: null, context: { view: { section: 'orders', tab: 'list' }, form: null } }, {
    providerFactory: runtime => createAssistantProvider(runtime, { transport: async (_url, request) => {
      assert.equal(request.accessToken, 'SYNTHETIC-ACCESS');
      assert.equal(request.body.includes('SYNTHETIC-ACCESS'), false);
      return reply('finish_turn', { payload: JSON.stringify({ topic: 'application', blocks: [{ type: 'text', templateId: 'acknowledged', slots: {} }], question: null, proposalId: null }) });
    } }),
  });
  assert.equal(turn.blocks[0].type, 'text');
  assert.equal((await f.store.db.get('SELECT state FROM assistant_turns WHERE request_id=?', [turn.requestId || (await f.store.db.get('SELECT request_id FROM assistant_turns')).request_id])).state, 'completed');
  assert.equal(JSON.stringify(turn).includes('SYNTHETIC-'), false);
});

test('denied inference revokes new Google credentials, notifies the user and preserves the panel session', async t => {
  const f = await fixture(t);
  f.behavior.probeDenied = true;
  const { state } = await f.start();
  let failure;
  try { await completeAssistantOAuth(f.store, { state, code: 'SYNTHETIC-CODE' }, f.session, f.options); } catch (error) { failure = error; }
  assert.equal(failure.code, 'ASSISTANT_CREDENTIAL_INVALID');
  const response = assistantOAuthErrorResponse(failure), body = await response.json();
  assert.equal(response.status, 422);
  assert.match(body.error, /conexión OAuth nueva de Ali se cerró/);
  assert.equal(body.error.includes('synthetic provider diagnostic'), false);
  assert.equal(body.revoked, true);
  assert.equal(f.events.at(-1).form.get('token'), 'SYNTHETIC-REFRESH');
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_credentials'), null);
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_states'), null);
  assert.equal((await getAssistantSettings(f.store)).enabled, false);
  await assertAssistantSession(f.store, f.session);
});

test('declined consent, replay, expiry and session swapping cannot redeem authorization codes', async t => {
  const f = await fixture(t), first = await f.start();
  const other = await login(f.store, 'ali-oauth@example.test', 'synthetic-only-password');
  const otherSession = { user: other.user, csrf: other.csrf, sessionTokenHash: digest(other.token) };
  await assert.rejects(completeAssistantOAuth(f.store, { state: first.state, code: 'SYNTHETIC-CODE' }, otherSession, f.options), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  assert.ok(await f.store.db.get('SELECT * FROM assistant_oauth_states'));
  await assert.rejects(completeAssistantOAuth(f.store, { state: first.state, error: 'access_denied' }, f.session, f.options), /No autorizaste/);
  await assert.rejects(completeAssistantOAuth(f.store, { state: first.state, code: 'SYNTHETIC-CODE' }, f.session, f.options), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  const next = await f.start();
  await f.store.db.run('UPDATE assistant_oauth_states SET expires_at=0');
  await assert.rejects(completeAssistantOAuth(f.store, { state: next.state, code: 'SYNTHETIC-CODE' }, f.session, f.options), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  assert.equal(f.behavior.exchanges, 0);
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_states'), null);
});

test('a state is consumed atomically and only one concurrent completion exchanges its code', async t => {
  const f = await fixture(t), { state } = await f.start();
  const results = await Promise.allSettled([1, 2].map(() => completeAssistantOAuth(f.store, { state, code: 'SYNTHETIC-CODE' }, f.session, f.options)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.behavior.exchanges, 1);
  assert.equal((await getAssistantSettings(f.store)).hasOAuthConnection, true);
});

test('configuration changes and logout invalidate pending Google authorizations before token exchange', async t => {
  const f = await fixture(t), attempt = await f.start();
  await saveAssistantSettings(f.store, keySettings(0), f.session, { ...f.options, verify: async () => true });
  await assert.rejects(completeAssistantOAuth(f.store, { state: attempt.state, code: 'SYNTHETIC-CODE' }, f.session, f.options));
  const next = await f.start();
  await logout(f.store, f.token);
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_states'), null);
  await assert.rejects(completeAssistantOAuth(f.store, { state: next.state, code: 'SYNTHETIC-CODE' }, f.session, f.options), { code: 'ASSISTANT_AUTH_REQUIRED' });
  assert.equal(f.behavior.exchanges, 0);
});

test('a late successful probe cannot enable OAuth after the administrator logs out', async t => {
  const f = await fixture(t), { state } = await f.start();
  const options = { ...f.options, transport: async () => { await logout(f.store, f.token); return reply('assistant_connection_check', { ok: true }); } };
  await assert.rejects(completeAssistantOAuth(f.store, { state, code: 'SYNTHETIC-CODE' }, f.session, options), { code: 'ASSISTANT_AUTH_REQUIRED' });
  assert.equal((await getAssistantSettings(f.store)).enabled, false);
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_credentials'), null);
  assert.equal(f.events.at(-1).url, 'https://oauth2.googleapis.com/revoke');
});

test('expired credentials refresh once across concurrent consumers and persist rotating tokens atomically', async t => {
  const f = await fixture(t);
  f.behavior.expiresIn = 1;
  const connected = await f.connect();
  const runtimes = await Promise.all([loadAssistantRuntime(f.store, f.options), loadAssistantRuntime(f.store, f.options)]);
  assert.equal(f.behavior.refreshes, 1);
  assert.deepEqual(runtimes.map(item => item.accessToken), ['SYNTHETIC-ROTATED-ACCESS', 'SYNTHETIC-ROTATED-ACCESS']);
  assert.equal((await getAssistantSettings(f.store)).version, connected.version);
  const disconnected = await disconnectAssistantOAuth(f.store, { version: connected.version }, f.session, f.options);
  assert.equal(disconnected.revoked, true);
  assert.equal(f.events.at(-1).form.get('token'), 'SYNTHETIC-ROTATED-REFRESH');
});

test('invalid refresh grants disable Ali and remove OAuth custody without leaking provider diagnostics', async t => {
  const f = await fixture(t);
  f.behavior.expiresIn = 1;
  await f.connect();
  f.behavior.refreshDenied = true;
  await assert.rejects(loadAssistantRuntime(f.store, f.options), error => error.code === 'ASSISTANT_CREDENTIAL_INVALID' && /sesión OAuth de Ali se cerró/.test(error.message) && !error.message.includes('SYNTHETIC-PRIVATE'));
  const settings = await getAssistantSettings(f.store);
  assert.equal(settings.enabled, false);
  assert.equal(settings.hasOAuthConnection, false);
  assert.equal(settings.connectionStatus, 'invalid');
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_credentials'), null);
  await assertAssistantSession(f.store, f.session);
});

test('disconnect cancels running Ali work even when remote revocation is unavailable', async t => {
  const f = await fixture(t), connected = await f.connect(), now = Date.now();
  const reservation = await f.store.transaction(tx => reserveAssistantTurn(tx, { userId: f.session.user.id, requestId: 'oauth-turn-disconnect', inputHash: hashAssistantInput({ message: 'consulta activa' }), configurationVersion: connected.version, sessionTokenHash: f.session.sessionTokenHash, data: { message: 'consulta activa' }, at: now, deadlineAt: now + 60_000 }));
  f.behavior.revokeUnavailable = true;
  const result = await disconnectAssistantOAuth(f.store, { version: connected.version }, f.session, f.options);
  assert.equal(result.revoked, false);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.hasOAuthConnection, false);
  assert.equal((await f.store.db.get('SELECT state FROM assistant_turns WHERE id=?', [reservation.turn.id])).state, 'cancelled');
  assert.equal(await f.store.db.get('SELECT * FROM assistant_oauth_credentials'), null);
  await assertAssistantSession(f.store, f.session);
});

test('APIKey stays usable after a failed OAuth attempt and can replace OAuth only after successful verification', async t => {
  const f = await fixture(t);
  const prior = await saveAssistantSettings(f.store, keySettings(0), f.session, { ...f.options, verify: async () => true });
  f.behavior.probeDenied = true;
  const { state } = await f.start();
  await assert.rejects(completeAssistantOAuth(f.store, { state, code: 'SYNTHETIC-CODE' }, f.session, f.options));
  assert.deepEqual(await getAssistantSettings(f.store), prior);
  assert.equal((await loadAssistantRuntime(f.store, f.options)).apiKey, 'SYNTHETIC-API-KEY');
  f.behavior.probeDenied = false;
  const connected = await f.connect();
  await assert.rejects(saveAssistantSettings(f.store, keySettings(connected.version), f.session, { ...f.options, verify: async () => { throw denied(); } }));
  assert.equal((await getAssistantSettings(f.store)).hasOAuthConnection, true);
  const key = await saveAssistantSettings(f.store, keySettings(connected.version), f.session, { ...f.options, verify: async () => true });
  assert.equal(key.authMethod, 'api-key');
  assert.equal(key.hasApiKey, true);
  assert.equal(key.hasOAuthConnection, false);
  assert.equal((await loadAssistantRuntime(f.store, f.options)).apiKey, 'SYNTHETIC-API-KEY');
  assert.equal(f.events.at(-1).url, 'https://oauth2.googleapis.com/revoke');
});

test('lost OAuth custody fails closed and still allows explicit local disconnect', async t => {
  const f = await fixture(t), connected = await f.connect();
  await unlink(join(f.env.INTEGRATION_SECRETS_DIR, 'assistant.key'));
  await assert.rejects(loadAssistantRuntime(f.store, f.options), { code: 'INTEGRATION_KEY_MISSING' });
  const result = await disconnectAssistantOAuth(f.store, { version: connected.version }, f.session, f.options);
  assert.equal(result.settings.hasOAuthConnection, false);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.revoked, false);
});

test('OAuth v12 migration rolls back atomically, preserves an existing APIKey, and excludes private tables from backup restore', async t => {
  const f = await fixture(t);
  const prior = await saveAssistantSettings(f.store, keySettings(0), f.session, { ...f.options, verify: async () => true });
  for (const table of [...ASSISTANT_WORK_INTERNAL_TABLES].reverse()) await f.store.db.exec(`DROP TABLE ${f.store.t(table)}`);
  await f.store.db.run('DELETE FROM migrations WHERE version=13');
  for (const table of [...ASSISTANT_OAUTH_INTERNAL_TABLES].reverse()) await f.store.db.exec(`DROP TABLE ${f.store.t(table)}`);
  await f.store.db.run('DELETE FROM migrations WHERE version=12');
  const markerFailure = new Error('synthetic OAuth marker failure');
  const failing = { provider: f.store.provider, transaction: fn => f.store.transaction(tx => {
    const db = tx.db;
    tx.db = { ...db, run: (sql, params) => { if (sql.includes('VALUES(12,')) throw markerFailure; return db.run(sql, params); } };
    return fn(tx);
  }) };
  await assert.rejects(migrateAssistantOAuthV12(failing), error => error === markerFailure);
  for (const table of ASSISTANT_OAUTH_INTERNAL_TABLES) assert.equal(await f.store.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]), null);
  assert.deepEqual(await migrateAssistantOAuthV12(f.store), { migrated: true, version: 12 });
  assert.deepEqual(await getAssistantSettings(f.store), prior);
  assert.equal((await loadAssistantRuntime(f.store, f.options)).apiKey, 'SYNTHETIC-API-KEY');
  assert.deepEqual(await migrateAssistantOAuthV12(f.store), { migrated: false, version: 12 });
  await migrateAssistantWorkV13(f.store);
  await f.connect();
  const bundle = await f.store.exportData();
  assert.equal(JSON.stringify(bundle).includes('SYNTHETIC-'), false);
  for (const table of ASSISTANT_OAUTH_INTERNAL_TABLES) {
    assert.equal(Object.hasOwn(bundle, table), false);
    await assert.rejects(importData(f.store, { ...bundle, [table]: [] }), /internos/);
  }
});
