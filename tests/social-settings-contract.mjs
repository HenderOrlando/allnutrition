import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { getSocialSettings, saveSocialSettings } from '../lib/business/social-settings.mjs';
import { loadSocialRuntime, integrationRequirements } from '../lib/social/config.mjs';
import { loadCredentials, saveCredentials } from '../lib/social/credentials.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';
import { startSocialOAuth, consumeSocialOAuthState, completeSocialOAuth } from '../lib/business/social-connections.mjs';
import { insertRow, stamp, hash } from '../lib/business/commands.mjs';
import { migrateSocialConfigFromLegacyEnv } from '../scripts/migrate-social-config.mjs';

const actorId = 'settings-test-admin';
const origin = 'https://panel.example.test';
const settings = (version = 0, changes = {}) => ({ version, requestId: randomUUID(), publicBaseUrl: origin, appId: '101', loginConfigId: '102', appSecret: 'SECRET-CANARY-APP', publishingEnabled: true, browserEnabled: true, ...changes });
async function setup(t, factory) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'social-settings-'));
  const env = { NODE_ENV: 'test', INTEGRATION_SECRETS_DIR: join(root, 'secrets'), SOCIAL_BROWSER_CONTROL_DIR: join(root, 'control') };
  const keyring = createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
  const options = { env, keyring, allowedOrigins: [origin] };
  const store = await factory();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await insertRow(store, 'users', { id: actorId, email: 'settings-admin@example.test', password: 'unused-synthetic', active: 1 });
  return { store, root, env, options, keyring, session: { user: { id: actorId }, csrf: 'synthetic-csrf', expires: Date.now() + 3600000 } };
}
async function connection(store, state = 'connected') {
  const now = stamp(), id = randomUUID();
  await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: 'api', state, data: JSON.stringify({ identities: { userId: '201' }, sessionEpoch: 0, validatedAt: now }), version: 1, created_at: now, updated_at: now });
  return getSocialConnection(store, id);
}

export async function runSocialSettingsContracts(t, factory) {
await t.test('GET vacío no crea configuración ni custodia y no lee variables de integración', async t => {
  const { store, options, env, root } = await setup(t, factory);
  Object.assign(env, { META_APP_ID: '999', META_APP_SECRET: 'ENV-MUST-NOT-BE-USED', SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_BROWSER_ENABLED: 'true' });
  const dto = await getSocialSettings(store, options), runtime = await loadSocialRuntime(store, options);
  assert.equal(dto.version, 0); assert.equal(dto.appId, ''); assert.equal(dto.hasAppSecret, false);
  assert.equal(runtime.publishingEnabled, false); assert.equal(runtime.browserEnabled, false);
  assert.deepEqual(runtime.keys, {}); assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_integration_settings')}`), []);
});

await t.test('configuración viva, CAS e idempotencia conservan claves y jamás exponen secretos', async t => {
  const { store, options } = await setup(t, factory);
  const input = settings(), first = await saveSocialSettings(store, input, actorId, options);
  assert.deepEqual(await saveSocialSettings(store, input, actorId, options), first);
  assert.equal(first.version, 1); assert.equal(first.callbackUrl, `${origin}/api/admin/social/oauth/callback`);
  assert.equal(first.dataDeletionUrl, `${origin}/social-data-deletion`);
  const initial = await loadSocialRuntime(store, options);
  assert.equal(integrationRequirements('api', initial).configured, true);
  const next = await saveSocialSettings(store, settings(1, { appSecret: '', publishingEnabled: false, browserEnabled: false }), actorId, options);
  const current = await loadSocialRuntime(store, options);
  assert.equal(next.version, 2); assert.equal(current.publishingEnabled, false); assert.equal(current.browserEnabled, false);
  assert.equal(current.appSecret, initial.appSecret); assert.equal(current.fingerprint, initial.fingerprint);
  for (const name of Object.keys(initial.keys)) assert.ok(current.keys[name].equals(initial.keys[name]));
  await assert.rejects(() => saveSocialSettings(store, settings(1), actorId, options), { status: 409 });
  await assert.rejects(() => saveSocialSettings(store, { ...input, publishingEnabled: false }, actorId, options), { status: 409 });
  const persisted = JSON.stringify({ first, next, audit: await store.db.all(`SELECT * FROM ${store.t('business_audit')}`), requests: await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), row: await store.db.get(`SELECT * FROM ${store.t('social_integration_settings')}`) });
  assert.equal(persisted.includes('SECRET-CANARY-APP'), false);
  for (const key of Object.values(initial.keys)) assert.equal(persisted.includes(key.toString('base64')), false);
});

await t.test('origen autorizado, tipos y administrador activo se comprueban antes de generar claves', async t => {
  const { store, options, root } = await setup(t, factory);
  await assert.rejects(() => saveSocialSettings(store, settings(0, { publicBaseUrl: 'https://other.example.test' }), actorId, options), { status: 403 });
  await assert.rejects(() => saveSocialSettings(store, settings(0, { publicBaseUrl: `${origin}/path` }), actorId, options), { status: 400 });
  await assert.rejects(() => saveSocialSettings(store, settings(0, { publishingEnabled: 'true' }), actorId, options), { status: 400 });
  await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [actorId]);
  await assert.rejects(() => saveSocialSettings(store, settings(), actorId, options), { status: 403 });
  assert.deepEqual(await readdir(root), []);
});

await t.test('cambio de secreto conserva tokens y recibos pero invalida preparación no enviada', async t => {
  const { store, options } = await setup(t, factory);
  await saveSocialSettings(store, settings(), actorId, options);
  const initial = await loadSocialRuntime(store, options), account = await connection(store);
  await saveCredentials(store, account.id, { accessToken: 'TOKEN-CANARY' }, { runtime: initial });
  const now = stamp(), campaignId = randomUUID(), assetId = randomUUID(), deliveryId = randomUUID(), sentId = randomUUID(), preparedId = randomUUID();
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: hash('synthetic-asset'), bytes: 1, data: '{}', version: 1, created_at: now, updated_at: now });
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: account.id, asset_id: assetId, name: 'Synthetic', mode: 'organic', objective: 'reach', state: 'ready', data: '{}', version: 1, created_at: now, updated_at: now });
  await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash('synthetic-spec'), approved_at: now, actor_id: actorId, data: JSON.stringify({ configurationFingerprint: initial.fingerprint }) });
  await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: campaignId, revision: 1, channel: 'facebook', state: 'queued', remote_id: null, next_sync_at: null, data: '{}', version: 1, created_at: now, updated_at: now });
  for (const [id, state, step, data] of [[sentId, 'sent', 'publish', { receipts: [{ remoteId: 'remote-synthetic' }] }], [preparedId, 'prepared', 'create_post', {}]]) {
    await insertRow(store, 'social_operations', { id, campaign_id: campaignId, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:${step}`, step, state, next_attempt_at: now, data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
  }
  const sentBefore = await store.db.get(`SELECT * FROM ${store.t('social_operations')} WHERE id=?`, [sentId]);
  await saveSocialSettings(store, settings(1, { appSecret: 'NEW-SECRET-CANARY' }), actorId, options);
  const runtime = await loadSocialRuntime(store, options), current = await getSocialConnection(store, account.id);
  assert.equal(current.revalidationRequired, true); assert.equal(current.validatedAt, null); assert.deepEqual(current.identities, account.identities);
  assert.notEqual(runtime.fingerprint, initial.fingerprint);
  assert.equal((await loadCredentials(store, current, runtime)).accessToken, 'TOKEN-CANARY');
  assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_operations')} WHERE id=?`, [preparedId])).state, 'failed');
  assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_operations')} WHERE id=?`, [sentId]), sentBefore);
  for (const name of Object.keys(initial.keys)) assert.ok(initial.keys[name].equals(runtime.keys[name]));
});

await t.test('otra app exige desconexión explícita y un secreto nuevo', async t => {
  const { store, options } = await setup(t, factory);
  await saveSocialSettings(store, settings(), actorId, options);
  const account = await connection(store);
  await assert.rejects(() => saveSocialSettings(store, settings(1, { appId: '301' }), actorId, options), { status: 409 });
  await store.db.run(`UPDATE ${store.t('social_connections')} SET state='disconnected' WHERE id=?`, [account.id]);
  await assert.rejects(() => saveSocialSettings(store, settings(1, { appId: '301', appSecret: '' }), actorId, options), { status: 409 });
  const saved = await saveSocialSettings(store, settings(1, { appId: '301', appSecret: 'DIFFERENT-APP-SECRET' }), actorId, options);
  assert.equal(saved.appId, '301');
});

await t.test('custodia perdida bloquea lectura y guardado sin reemplazar claves', async t => {
  const { store, options, env, keyring } = await setup(t, factory);
  await saveSocialSettings(store, settings(), actorId, options);
  await unlink(join(env.INTEGRATION_SECRETS_DIR, 'tokens.key'));
  await assert.rejects(() => loadSocialRuntime(store, options), { code: 'INTEGRATION_KEY_MISSING' });
  await assert.rejects(() => saveSocialSettings(store, settings(1), actorId, options), { code: 'INTEGRATION_KEY_MISSING' });
  assert.equal(await keyring.read('tokens'), null);
  assert.equal((await store.db.get(`SELECT version FROM ${store.t('social_integration_settings')} WHERE id=1`)).version, 1);
});

await t.test('OAuth liga inicio, consumo y finalización a la versión persistida', async t => {
  const { store, options, session } = await setup(t, factory);
  await saveSocialSettings(store, settings(), actorId, options);
  const start = await startSocialOAuth(store, {}, session, options), state = new URL(start.authorizationUrl).searchParams.get('state');
  await saveSocialSettings(store, settings(1, { publishingEnabled: false, appSecret: '' }), actorId, options);
  await assert.rejects(() => consumeSocialOAuthState(store, state, session, options), { status: 409 });
  const second = await startSocialOAuth(store, {}, session, options), nextState = new URL(second.authorizationUrl).searchParams.get('state');
  let exchanges = 0;
  await assert.rejects(() => completeSocialOAuth(store, { state: nextState, code: 'synthetic-code' }, session, {
    ...options,
    fetchImpl: async () => {
      exchanges++;
      if (exchanges === 1) await saveSocialSettings(store, settings(2, { publishingEnabled: true, appSecret: '' }), actorId, options);
      return Response.json({ access_token: 'SYNTHETIC-TOKEN', expires_in: 3600 });
    },
    connectorFactory: () => ({ validateConnection: async () => ({ state: 'connected', identities: { userId: '201' }, resources: {}, capabilities: {} }) })
  }), { status: 409 });
  assert.equal(exchanges, 2);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_connections')}`), []);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_credentials')}`), []);
});
await t.test('conversión explícita conserva ciphertext API y sesión de época anterior con sus claves originales', async t => {
  const { store, options, env } = await setup(t, factory);
  const names = { tokens: 'SOCIAL_TOKEN_ENCRYPTION_KEY', media: 'SOCIAL_MEDIA_SIGNING_KEY', sessions: 'SOCIAL_BROWSER_SESSION_KEY', control: 'SOCIAL_BROWSER_CONTROL_KEY' };
  const keys = Object.fromEntries(Object.keys(names).map(name => [name, randomBytes(32)]));
  const legacy = { ...env, APP_URL: origin, META_APP_ID: '101', META_LOGIN_CONFIG_ID: '102', META_APP_SECRET: 'LEGACY-APP-CANARY', ...Object.fromEntries(Object.entries(names).map(([name, field]) => [field, keys[name].toString('base64')])) };
  const api = await connection(store), browserId = randomUUID(), now = stamp();
  await insertRow(store, 'social_connections', { id: browserId, provider: 'meta', integration_method: 'browser', state: 'connected', data: JSON.stringify({ sessionEpoch: 7, identities: { userId: '302' } }), version: 1, created_at: now, updated_at: now });
  for (const [id, method, epoch, value] of [[api.id, 'api', 0, { accessToken: 'LEGACY-TOKEN-CANARY' }], [browserId, 'browser', 7, { storageState: { cookies: [], origins: [] } }]]) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keys[method === 'api' ? 'tokens' : 'sessions'], iv);
    cipher.setAAD(Buffer.from(`${id}:${method}:v1${method === 'browser' ? `:${epoch}` : ''}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    await insertRow(store, 'social_credentials', { connection_id: id, ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64'), version: 3, updated_at: now });
  }
  const before = await store.db.all(`SELECT * FROM ${store.t('social_credentials')} ORDER BY connection_id`);
  await assert.rejects(() => migrateSocialConfigFromLegacyEnv(store, { env: { ...legacy, SOCIAL_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }));
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_integration_settings')}`), []);
  assert.deepEqual(await migrateSocialConfigFromLegacyEnv(store, { env: legacy }), { version: 1, verifiedCredentials: 2 });
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_credentials')} ORDER BY connection_id`), before);
  const runtime = await loadSocialRuntime(store, options);
  assert.equal((await loadCredentials(store, api, runtime)).accessToken, 'LEGACY-TOKEN-CANARY');
  assert.deepEqual((await loadCredentials(store, await getSocialConnection(store, browserId), runtime)).storageState, { cookies: [], origins: [] });
  for (const name of Object.keys(names)) assert.ok(runtime.keys[name].equals(keys[name]));
});
}
