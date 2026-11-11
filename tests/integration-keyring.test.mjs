import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { createIntegrationKeyring, openAppSecret, sealAppSecret } from '../lib/integrations/keyring.mjs';
import { migrateSocialConfigFromLegacyEnv } from '../scripts/migrate-social-config.mjs';

const names = ['appSecret', 'tokens', 'media', 'sessions', 'control'];
const legacyNames = { tokens: 'SOCIAL_TOKEN_ENCRYPTION_KEY', media: 'SOCIAL_MEDIA_SIGNING_KEY', sessions: 'SOCIAL_BROWSER_SESSION_KEY', control: 'SOCIAL_BROWSER_CONTROL_KEY' };
async function fixture(t) {
  // macOS /var can itself be a platform symlink; configured custody paths and
  // every component beneath this canonical temporary root are always real.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'integration-custody-'));
  const directory = join(root, 'secrets'), controlDirectory = join(root, 'control');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, controlDirectory, keyring: createIntegrationKeyring({ directory, controlDirectory }) };
}
const file = (f, name) => join(name === 'control' ? f.controlDirectory : f.directory, `${name}.key`);
const keySet = () => Object.fromEntries(Object.keys(legacyNames).map(name => [name, randomBytes(32)]));
const snapshot = keys => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, key.toString('base64')]));
function encryptLegacy(id, method, key, epoch, value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${id}:${method}:v1${method === 'browser' ? `:${epoch}` : ''}`));
  return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}
function decryptLegacy(row, method, key, epoch) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${row.connection_id}:${method}:v1${method === 'browser' ? `:${epoch}` : ''}`));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
async function migrationFixture(t) {
  const f = await fixture(t), keys = keySet();
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  t.after(() => store.close());
  const env = {
    APP_URL: 'https://panel.example.test/', META_APP_ID: '901', META_APP_SECRET: 'SYNTHETIC-APP-SECRET-CANARY', META_LOGIN_CONFIG_ID: '902', META_GRAPH_VERSION: 'v26.0',
    SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_BROWSER_ENABLED: 'false',
    INTEGRATION_SECRETS_DIR: f.directory, SOCIAL_BROWSER_CONTROL_DIR: f.controlDirectory,
    ...Object.fromEntries(Object.entries(legacyNames).map(([name, variable]) => [variable, keys[name].toString('base64')]))
  };
  const connections = [];
  for (const [method, state, epoch] of [['api', 'connected', 0], ['browser', 'connected', 7], ['api', 'disconnected', 0]]) {
    const id = randomUUID(), at = new Date().toISOString();
    const value = method === 'api' ? { accessToken: 'SYNTHETIC-TOKEN-CANARY' } : { storageState: { cookies: [], origins: [] } };
    await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: method, state, version: 1, data: JSON.stringify({ sessionEpoch: epoch }), created_at: at, updated_at: at });
    await insertRow(store, 'social_credentials', { connection_id: id, ...encryptLegacy(id, method, keys[method === 'api' ? 'tokens' : 'sessions'], epoch, value), version: 1, updated_at: at });
    connections.push({ id, method, epoch, value });
  }
  return { ...f, store, keys, env, connections };
}
const credentials = f => f.store.db.all(`SELECT * FROM ${f.store.t('social_credentials')} ORDER BY connection_id`);
const settings = f => f.store.db.get(`SELECT * FROM ${f.store.t('social_integration_settings')} WHERE id=1`);
async function noFiles(f) {
  for (const path of [f.directory, f.controlDirectory]) await assert.rejects(() => lstat(path), { code: 'ENOENT' });
}

test('read is side-effect free; first ensure creates private, independent and stable custody', async t => {
  const f = await fixture(t);
  assert.equal(await f.keyring.read('tokens'), null);
  await assert.rejects(() => f.keyring.read('tokens', { required: true }), { code: 'INTEGRATION_KEY_MISSING', recoverable: true, status: 409 });
  await noFiles(f);
  const keys = await f.keyring.ensure();
  assert.equal(new Set(Object.values(snapshot(keys))).size, 5);
  for (const directory of [f.directory, f.controlDirectory]) assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  assert.deepEqual((await readdir(f.controlDirectory)).sort(), ['control.key']);
  assert.deepEqual((await readdir(f.directory)).sort(), ['appSecret.key', 'media.key', 'sessions.key', 'tokens.key']);
  for (const name of names) {
    const info = await lstat(file(f, name));
    assert.equal(info.mode & 0o7777, 0o600);
    assert.equal(info.size, 32);
    assert.deepEqual(await readFile(file(f, name)), keys[name]);
  }
  const reopened = createIntegrationKeyring(f);
  assert.deepEqual(snapshot(await reopened.ensure({ existingCiphertexts: true })), snapshot(keys));
  const copy = await reopened.read('tokens');
  copy.fill(0);
  assert.deepEqual(await reopened.read('tokens'), keys.tokens);
  await assert.rejects(() => reopened.read('../tokens'), { code: 'INTEGRATION_KEY_NAME' });
});

test('concurrent exclusive initialization publishes complete keys without replacement', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => createIntegrationKeyring(f).ensure()));
  for (const result of results) assert.deepEqual(snapshot(result), snapshot(results[0]));
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await readdir(f.controlDirectory)).some(name => name.endsWith('.tmp')), false);
});

test('missing custody with existing ciphertext blocks the entire ensure before creating anything', async t => {
  const empty = await fixture(t);
  await assert.rejects(() => empty.keyring.ensure({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  await noFiles(empty);
  const f = await fixture(t), before = await f.keyring.ensure();
  const sealed = sealAppSecret('SYNTHETIC-SECRET', before.appSecret);
  await unlink(file(f, 'tokens'));
  await unlink(file(f, 'appSecret'));
  await assert.rejects(() => f.keyring.ensure({ existingCiphertexts: true }), error => error.code === 'INTEGRATION_KEY_MISSING' && /Restaura/.test(error.message));
  for (const name of ['tokens', 'appSecret']) assert.equal(await f.keyring.read(name), null);
  for (const name of ['media', 'sessions', 'control']) assert.deepEqual(await f.keyring.read(name), before[name]);
  assert.equal(openAppSecret(sealed, before.appSecret), 'SYNTHETIC-SECRET');
});
test('assistant custody is isolated from social initialization in either order', async t => {
  const f = await fixture(t);
  const assistant = await f.keyring.ensureAssistant();
  assert.equal(assistant.length, 32);
  assert.deepEqual((await readdir(f.directory)).sort(), ['assistant.key']);
  const social = await f.keyring.ensure();
  assert.equal(new Set([...Object.values(social), assistant].map(key => key.toString('base64'))).size, 6);
  assert.deepEqual((await readdir(f.directory)).sort(), ['appSecret.key', 'assistant.key', 'media.key', 'sessions.key', 'tokens.key']);

  const reverse = await fixture(t);
  const socialFirst = await reverse.keyring.ensure();
  const assistantSecond = await reverse.keyring.ensureAssistant();
  assert.equal(new Set([...Object.values(socialFirst), assistantSecond].map(key => key.toString('base64'))).size, 6);
  assert.deepEqual((await readdir(reverse.directory)).sort(), ['appSecret.key', 'assistant.key', 'media.key', 'sessions.key', 'tokens.key']);
});

test('assistant ciphertext with missing assistant custody fails without creating or repairing keys', async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(() => f.keyring.ensureAssistant({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  assert.deepEqual(await readdir(f.directory), []);
  const social = await f.keyring.ensure();
  assert.deepEqual((await readdir(f.directory)).sort(), ['appSecret.key', 'media.key', 'sessions.key', 'tokens.key']);
  await assert.rejects(() => f.keyring.ensureAssistant({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['appSecret.key', 'media.key', 'sessions.key', 'tokens.key']);
  assert.deepEqual(snapshot(await f.keyring.ensure({ existingCiphertexts: true })), snapshot(social));
});
test('social initialization never repairs assistant custody, and assistant initialization never repairs social custody', async t => {
  const assistantLoss = await fixture(t);
  await assistantLoss.keyring.ensureAssistant();
  await unlink(join(assistantLoss.directory, 'assistant.key'));
  await assert.rejects(() => assistantLoss.keyring.ensureAssistant({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  assert.deepEqual(await readdir(assistantLoss.directory), []);
  await assistantLoss.keyring.ensure();
  assert.deepEqual((await readdir(assistantLoss.directory)).sort(), ['appSecret.key', 'media.key', 'sessions.key', 'tokens.key']);
  await assert.rejects(() => assistantLoss.keyring.ensureAssistant({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  assert.deepEqual((await readdir(assistantLoss.directory)).sort(), ['appSecret.key', 'media.key', 'sessions.key', 'tokens.key']);

  const socialLoss = await fixture(t);
  const socialKeys = await socialLoss.keyring.ensure();
  const preservedAssistant = await socialLoss.keyring.ensureAssistant();
  await unlink(join(socialLoss.directory, 'tokens.key'));
  assert.deepEqual(await socialLoss.keyring.ensureAssistant(), preservedAssistant);
  assert.equal(await socialLoss.keyring.read('tokens'), null);
  await assert.rejects(() => socialLoss.keyring.ensure({ existingCiphertexts: true }), { code: 'INTEGRATION_KEY_MISSING' });
  for (const [name, key] of Object.entries(socialKeys)) {
    if (name !== 'tokens') assert.deepEqual(await socialLoss.keyring.read(name), key);
  }
  assert.deepEqual(await socialLoss.keyring.read('assistant'), preservedAssistant);
});
test('assistant custody rejects a reused social key', async t => {
  const f = await fixture(t), social = await f.keyring.ensure();
  await writeFile(join(f.directory, 'assistant.key'), social.tokens, { mode: 0o600 });
  await assert.rejects(() => f.keyring.ensureAssistant(), { code: 'INTEGRATION_KEY_REUSED' });
});
test('social initialization rejects a preexisting key colliding with assistant custody', async t => {
  const f = await fixture(t), assistant = await f.keyring.ensureAssistant();
  await writeFile(join(f.directory, 'appSecret.key'), assistant, { mode: 0o600 });
  await assert.rejects(() => f.keyring.ensure(), { code: 'INTEGRATION_KEY_REUSED' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['appSecret.key', 'assistant.key']);
  assert.equal(await f.keyring.read('tokens'), null);
});
test('legacy social import rejects collision with assistant custody before publishing', async t => {
  const f = await fixture(t), assistant = await f.keyring.ensureAssistant(), legacy = keySet();
  legacy.tokens = assistant;
  await assert.rejects(() => f.keyring.importLegacy(legacy), { code: 'INTEGRATION_KEY_REUSED' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['assistant.key']);
});

test('configured roots, ancestor directories and key symlinks are rejected without following them', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, f.directory);
  await assert.rejects(() => f.keyring.ensure(), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.deepEqual(await readdir(outside), []);
  await unlink(f.directory);
  const alias = join(f.root, 'alias');
  await symlink(outside, alias);
  const nested = createIntegrationKeyring({ directory: join(alias, 'nested'), controlDirectory: f.controlDirectory });
  await assert.rejects(() => nested.read('tokens'), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.deepEqual(await readdir(outside), []);
  await mkdir(f.directory, { mode: 0o700 });
  const target = join(outside, 'original.key'), original = randomBytes(32);
  await writeFile(target, original, { mode: 0o600 });
  await symlink(target, file(f, 'tokens'));
  await assert.rejects(() => f.keyring.read('tokens'), { code: 'INTEGRATION_KEY_UNSAFE' });
  await assert.rejects(() => f.keyring.ensure(), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.deepEqual(await readFile(target), original);
  await unlink(file(f, 'tokens'));
  await symlink(outside, f.controlDirectory);
  await assert.rejects(() => f.keyring.importLegacy(keySet()), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.deepEqual(await readdir(f.directory), []);
  assert.throws(() => createIntegrationKeyring({ directory: f.directory, controlDirectory: join(f.directory, 'runner') }), { code: 'INTEGRATION_KEY_UNSAFE' });
});

test('unsafe permissions and malformed key files fail closed without overwriting custody', async t => {
  const f = await fixture(t), keys = await f.keyring.ensure();
  await chmod(file(f, 'tokens'), 0o644);
  await assert.rejects(() => f.keyring.read('tokens'), { code: 'INTEGRATION_KEY_UNSAFE' });
  await assert.rejects(() => f.keyring.ensure(), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.deepEqual(await readFile(file(f, 'tokens')), keys.tokens);
  await chmod(file(f, 'tokens'), 0o600);
  await chmod(f.directory, 0o755);
  await assert.rejects(() => f.keyring.read('tokens'), { code: 'INTEGRATION_KEY_UNSAFE' });
  await chmod(f.directory, 0o700);
  await writeFile(file(f, 'tokens'), Buffer.alloc(31));
  await assert.rejects(() => f.keyring.ensure(), { code: 'INTEGRATION_KEY_UNSAFE' });
  assert.equal((await readFile(file(f, 'tokens'))).length, 31);
});

test('legacy imports are stable, distinct and exclusive, including conflict preflight', async t => {
  const f = await fixture(t), legacy = keySet();
  const first = await f.keyring.importLegacy(legacy);
  for (const name of Object.keys(legacyNames)) assert.deepEqual(first[name], legacy[name]);
  assert.equal(Object.values(legacy).some(key => key.equals(first.appSecret)), false);
  assert.deepEqual(snapshot(await f.keyring.importLegacy(legacy)), snapshot(first));
  const conflicting = { ...legacy, control: randomBytes(32) };
  await assert.rejects(() => f.keyring.importLegacy(conflicting), { code: 'INTEGRATION_KEY_CONFLICT' });
  assert.deepEqual(snapshot(await f.keyring.ensure({ existingCiphertexts: true })), snapshot(first));
  const empty = await fixture(t);
  await assert.rejects(() => empty.keyring.importLegacy({ ...legacy, media: legacy.tokens }), { code: 'INTEGRATION_KEY_REUSED' });
  await noFiles(empty);
});

test('app secret encryption uses independent IVs and the fixed settings AAD, with no plaintext DTO', () => {
  const key = randomBytes(32), secret = 'SYNTHETIC-APP-SECRET';
  const first = sealAppSecret(secret, key), second = sealAppSecret(secret, key);
  assert.equal(openAppSecret(first, key), secret);
  const independent = createDecipheriv('aes-256-gcm', key, Buffer.from(first.iv, 'base64'));
  independent.setAAD(Buffer.from('social-integration-settings:app-secret:v1'));
  independent.setAuthTag(Buffer.from(first.auth_tag, 'base64'));
  assert.equal(Buffer.concat([independent.update(Buffer.from(first.ciphertext, 'base64')), independent.final()]).toString('utf8'), secret);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.throws(() => openAppSecret(first, randomBytes(32)), { code: 'INTEGRATION_SECRET_UNREADABLE' });
  assert.throws(() => openAppSecret({ ...first, auth_tag: randomBytes(16).toString('base64') }, key), { code: 'INTEGRATION_SECRET_UNREADABLE' });
  const wrongAad = encryptLegacy('settings', 'api', key, 0, { secret });
  assert.throws(() => openAppSecret(wrongAad, key), { code: 'INTEGRATION_SECRET_UNREADABLE' });
});

test('one-shot legacy conversion verifies API and browser epoch ciphertexts, copying custody without reciphering', async t => {
  const f = await migrationFixture(t), before = await credentials(f);
  const result = await migrateSocialConfigFromLegacyEnv(f.store, { env: f.env });
  assert.deepEqual(result, { version: 1, verifiedCredentials: 3 });
  assert.deepEqual(await credentials(f), before);
  const row = await settings(f), keys = await f.keyring.ensure({ existingCiphertexts: true });
  assert.equal(row.version, 1);
  assert.equal(row.actor_id, 'system');
  assert.deepEqual(JSON.parse(row.data), { publicBaseUrl: 'https://panel.example.test', appId: '901', loginConfigId: '902', publishingEnabled: true, browserEnabled: false });
  assert.equal(openAppSecret({ ciphertext: row.app_secret_ciphertext, iv: row.app_secret_iv, auth_tag: row.app_secret_tag }, keys.appSecret), f.env.META_APP_SECRET);
  assert.equal(JSON.stringify(row).includes(f.env.META_APP_SECRET), false);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  for (const name of Object.keys(legacyNames)) assert.deepEqual(keys[name], f.keys[name]);
  for (const connection of f.connections) {
    const ciphertext = before.find(row => row.connection_id === connection.id);
    assert.deepEqual(decryptLegacy(ciphertext, connection.method, keys[connection.method === 'api' ? 'tokens' : 'sessions'], connection.epoch), connection.value);
  }
  await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env: f.env }), /configuración social ya existe/);
  assert.deepEqual(await settings(f), row);
  assert.deepEqual(snapshot(await f.keyring.ensure({ existingCiphertexts: true })), snapshot(keys));
});

test('wrong original API/session keys, tampered ciphertext and stale browser epochs preserve all data', async t => {
  for (const fault of ['tokens', 'sessions', 'epoch', 'ciphertext']) {
    await t.test(fault, async t => {
      const f = await migrationFixture(t), env = { ...f.env };
      if (fault === 'tokens' || fault === 'sessions') env[legacyNames[fault]] = randomBytes(32).toString('base64');
      if (fault === 'epoch') {
        const browser = f.connections.find(connection => connection.method === 'browser');
        await f.store.db.run(`UPDATE ${f.store.t('social_connections')} SET data=? WHERE id=?`, [JSON.stringify({ sessionEpoch: browser.epoch + 1 }), browser.id]);
      }
      if (fault === 'ciphertext') await f.store.db.run(`UPDATE ${f.store.t('social_credentials')} SET auth_tag=? WHERE connection_id=?`, [randomBytes(16).toString('base64'), f.connections[0].id]);
      const before = await credentials(f);
      await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env }), /clave y época originales/);
      assert.deepEqual(await credentials(f), before);
      assert.equal(await settings(f), null);
      await noFiles(f);
    });
  }
});

test('legacy options and all four distinct original keys are required even with integrations disabled', async t => {
  const f = await migrationFixture(t), before = await credentials(f);
  const invalid = [
    { APP_URL: 'https://panel.example.test/other' }, { APP_URL: 'http://panel.example.test' },
    { APP_URL: 'https://user:password@panel.example.test' }, { META_APP_ID: '' }, { META_LOGIN_CONFIG_ID: 'not-an-id' },
    { META_APP_SECRET: '' }, { META_GRAPH_VERSION: 'v27.0' }, { SOCIAL_BROWSER_ENABLED: 'yes' },
    { SOCIAL_TOKEN_ENCRYPTION_KEY: '' }, { SOCIAL_BROWSER_SESSION_KEY: randomBytes(31).toString('base64') },
    { SOCIAL_MEDIA_SIGNING_KEY: f.env.SOCIAL_TOKEN_ENCRYPTION_KEY }, { SOCIAL_BROWSER_CONTROL_KEY: '' }
  ];
  for (const changes of invalid) {
    await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env: { ...f.env, SOCIAL_PUBLISHING_ENABLED: 'false', SOCIAL_BROWSER_ENABLED: 'false', ...changes } }), { status: 409 });
    await noFiles(f);
  }
  assert.deepEqual(await credentials(f), before);
  assert.equal(await settings(f), null);
});

test('custody conflict and database commit failure preserve credentials and allow safe recovery', async t => {
  const f = await migrationFixture(t), before = await credentials(f);
  await mkdir(f.directory, { mode: 0o700 });
  const conflicting = randomBytes(32);
  await writeFile(file(f, 'tokens'), conflicting, { mode: 0o600 });
  await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env: f.env }), { code: 'INTEGRATION_KEY_CONFLICT' });
  assert.deepEqual(await readFile(file(f, 'tokens')), conflicting);
  assert.deepEqual(await readdir(f.directory), ['tokens.key']);
  assert.equal(await settings(f), null);
  assert.deepEqual(await credentials(f), before);
  await unlink(file(f, 'tokens'));
  await f.store.db.exec(`CREATE TRIGGER reject_social_settings BEFORE INSERT ON social_integration_settings BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END;`);
  await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env: f.env }), /synthetic commit failure/);
  const imported = await f.keyring.ensure({ existingCiphertexts: true });
  assert.equal(await settings(f), null);
  assert.deepEqual(await credentials(f), before);
  await f.store.db.exec('DROP TRIGGER reject_social_settings');
  await migrateSocialConfigFromLegacyEnv(f.store, { env: f.env });
  assert.deepEqual(snapshot(await f.keyring.ensure({ existingCiphertexts: true })), snapshot(imported));
  assert.deepEqual(await credentials(f), before);
});

test('migration requires v10 and concurrent one-shot attempts serialize at the settings insert', async t => {
  const f = await migrationFixture(t), before = await credentials(f);
  await f.store.db.run(`DELETE FROM ${f.store.t('migrations')} WHERE version=10`);
  await assert.rejects(() => migrateSocialConfigFromLegacyEnv(f.store, { env: f.env }), /primero la migración.*v10/);
  assert.deepEqual(await credentials(f), before);
  await noFiles(f);
  const ready = await migrationFixture(t);
  const results = await Promise.allSettled([
    migrateSocialConfigFromLegacyEnv(ready.store, { env: ready.env }),
    migrateSocialConfigFromLegacyEnv(ready.store, { env: ready.env })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /configuración social ya existe/);
  assert.equal((await settings(ready)).version, 1);
  await ready.keyring.ensure({ existingCiphertexts: true });
});
