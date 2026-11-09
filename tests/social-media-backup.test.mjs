import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { importData } from '../lib/import.mjs';
import { openStore } from '../lib/db/index.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { backupSocialMedia, restoreSocialMedia, resetSocialAfterPhysicalRestore } from '../lib/social/media-backup.mjs';
import { createSocialAsset, uploadSocialAsset, getSocialAsset, processSocialAssetTurn, socialAssetAction, openSocialAssetContent, verifySocialMediaFiles } from '../lib/business/social-media.mjs';
import { createBusinessBasics, businessOrderInput } from './business-fixtures.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { createSocialMediaUrl, verifySocialMediaUrl } from '../lib/social/media-http.mjs';

const now = '2026-11-02T12:00:00.000Z';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const editable = { version: 1, created_at: now, updated_at: now };
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'social-media-recovery-'));
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const env = { SOCIAL_MEDIA_DIR: join(root, 'media') };
  const { keyring, runtime } = await configureSocialTestRuntime(store, { env, settings: { publishingEnabled: false, browserEnabled: false } });
  await mkdir(env.SOCIAL_MEDIA_DIR, { mode: 0o700 });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID(), original = Buffer.from('synthetic-original-private'), derivative = Buffer.from('synthetic-jpeg-private');
  const data = { kind: 'image', name: 'Pieza de ensayo', contentType: 'image/png', expectedBytes: original.length, originalKey: `${id}/original.png`, originalSha256: digest(original), originalBytes: original.length, derivativeKey: `${id}/derivative.jpg`, derivativeSha256: digest(derivative), derivativeBytes: derivative.length, derivativeContentType: 'image/jpeg', reservedBytes: 0 };
  await mkdir(join(env.SOCIAL_MEDIA_DIR, id), { mode: 0o700 });
  await writeFile(join(env.SOCIAL_MEDIA_DIR, data.originalKey), original, { mode: 0o600 });
  await writeFile(join(env.SOCIAL_MEDIA_DIR, data.derivativeKey), derivative, { mode: 0o600 });
  await store.transaction(tx => insertRow(tx, 'social_assets', { id, state: 'ready', sha256: data.derivativeSha256, bytes: original.length + derivative.length, data: JSON.stringify(data), ...editable }));
  return { root, store, env, keyring, runtime, id, data, original, derivative, backup: join(root, 'copy') };
}
const asset = async f => f.store.db.get(`SELECT * FROM ${f.store.t('social_assets')} WHERE id=?`, [f.id]);

test('persisted settings changes preserve the private media signing key and existing URLs', async t => {
  const f = await fixture(t), record = { id: f.id, state: 'ready', kind: 'image', sha256: f.data.derivativeSha256 };
  const at = Date.parse(now), url = createSocialMediaUrl(record, { runtime: f.runtime, now: at });
  const changed = await configureSocialTestRuntime(f.store, { env: f.env, settings: { publicBaseUrl: 'https://changed.example.test', appSecret: 'changed-synthetic-secret', publishingEnabled: true, browserEnabled: false } });
  assert.notEqual(changed.runtime.configurationVersion, f.runtime.configurationVersion);
  assert.deepEqual(changed.runtime.keys.media, f.runtime.keys.media);
  assert.equal(verifySocialMediaUrl(record, url, { runtime: changed.runtime, now: at }), true);
});

test('media restore requires both persisted flags disabled regardless of deployment flags', async t => {
  const f = await fixture(t);
  await backupSocialMedia(f.store, f.backup, { env: f.env, now });
  for (const flags of [{ publishingEnabled: true, browserEnabled: false }, { publishingEnabled: false, browserEnabled: true }]) {
    await configureSocialTestRuntime(f.store, { env: f.env, settings: flags });
    await assert.rejects(() => restoreSocialMedia(f.store, f.backup, { env: { ...f.env, SOCIAL_PUBLISHING_ENABLED: 'false', SOCIAL_BROWSER_ENABLED: 'false' }, now }));
    await assert.rejects(() => resetSocialAfterPhysicalRestore(f.store, { env: f.env, now }));
  }
  await configureSocialTestRuntime(f.store, { env: f.env, settings: { publishingEnabled: false, browserEnabled: false } });
  assert.equal((await restoreSocialMedia(f.store, f.backup, { env: { ...f.env, SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_BROWSER_ENABLED: 'true' }, now })).unchanged, 2);
});

test('a failed original remains recoverable through commercial backup, volume restore and explicit processing retry', async t => {
  const f = await fixture(t), actor = 'media-recovery-admin';
  const bytes = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#5974a1' } }).png().toBuffer();
  const input = await createSocialAsset(f.store, { name: 'Original incompatible conservado', contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, actor, { env: f.env, now });
  await uploadSocialAsset(f.store, input.id, { body: Readable.from([bytes]), version: input.version, requestId: randomUUID(), contentType: 'image/png', contentLength: bytes.length }, actor, { env: f.env, now });
  await processSocialAssetTurn(f.store, { env: f.env, now });
  assert.equal((await getSocialAsset(f.store, input.id)).state, 'failed');
  const bundle = await f.store.exportData(), target = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  t.after(() => target.close());
  const env = { ...f.env, SOCIAL_MEDIA_DIR: join(f.root, 'recovered-media') };
  await backupSocialMedia(f.store, f.backup, { env: f.env, now });
  await importData(target, bundle);
  assert.equal((await getSocialAsset(target, input.id)).state, 'missing_file');
  await restoreSocialMedia(target, f.backup, { env, now });
  const restored = await getSocialAsset(target, input.id);
  assert.equal(restored.state, 'failed');
  assert.deepEqual(await readFile(join(env.SOCIAL_MEDIA_DIR, restored.originalKey)), bytes);
  await socialAssetAction(target, input.id, 'retry-processing', { version: restored.version, requestId: randomUUID() }, actor, { env, now });
  await processSocialAssetTurn(target, { env, now });
  const rejected = await getSocialAsset(target, input.id);
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.bytes, bytes.length);
  assert.equal(rejected.reservedBytes, 0);
  await assert.rejects(() => openSocialAssetContent(target, input.id, { env }), { status: 409 });
  assert.deepEqual(await target.db.get(`SELECT value FROM ${target.t('counters')} WHERE id='business_revision'`), await f.store.db.get(`SELECT value FROM ${f.store.t('counters')} WHERE id='business_revision'`));
});

test('separate volume round trip verifies DB hashes and only then recovers preview state', async t => {
  const f = await fixture(t);
  const result = await backupSocialMedia(f.store, f.backup, { env: f.env, now });
  assert.deepEqual(result, { files: 2, bytes: f.original.length + f.derivative.length });
  const manifest = JSON.parse(await readFile(join(f.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.find(file => file.key === f.data.derivativeKey).sha256, digest(f.derivative));
  await resetSocialAfterPhysicalRestore(f.store, { env: f.env, now });
  assert.equal((await asset(f)).state, 'missing_file');
  const env = { ...f.env, SOCIAL_MEDIA_DIR: join(f.root, 'restored') };
  const restored = await restoreSocialMedia(f.store, f.backup, { env, now });
  assert.equal(restored.restored, 2);
  assert.equal((await asset(f)).state, 'ready');
  assert.deepEqual(await readFile(join(env.SOCIAL_MEDIA_DIR, f.data.derivativeKey)), f.derivative);
  assert.equal((await restoreSocialMedia(f.store, f.backup, { env, now })).unchanged, 2);
  await assert.rejects(() => backupSocialMedia(f.store, f.backup, { env: f.env }), /EEXIST/);
});

test('restore rejects tampered manifest, traversal, source symlink and conflicting destination without replacing data', async t => {
  const f = await fixture(t);
  await backupSocialMedia(f.store, f.backup, { env: f.env });
  const manifestPath = join(f.backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const env = { ...f.env, SOCIAL_MEDIA_DIR: join(f.root, 'target') };
  for (const mutate of [
    m => { m.files[0].key = '../outside.png'; },
    m => { m.files[0].sha256 = 'a'.repeat(64); },
    m => { m.files.push(m.files[0]); },
    m => { m.files[0].assetId = randomUUID(); }
  ]) {
    const altered = structuredClone(manifest); mutate(altered);
    await writeFile(manifestPath, JSON.stringify(altered));
    await assert.rejects(() => restoreSocialMedia(f.store, f.backup, { env }));
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  const copiedOriginal = join(f.backup, f.data.originalKey);
  await rm(copiedOriginal);
  await symlink(join(f.env.SOCIAL_MEDIA_DIR, f.data.originalKey), copiedOriginal);
  await assert.rejects(() => restoreSocialMedia(f.store, f.backup, { env }));
  await rm(copiedOriginal);
  await writeFile(copiedOriginal, f.original);
  await mkdir(join(env.SOCIAL_MEDIA_DIR, f.id), { recursive: true });
  const conflicting = join(env.SOCIAL_MEDIA_DIR, f.data.derivativeKey);
  await writeFile(conflicting, 'different-private-file');
  await assert.rejects(() => restoreSocialMedia(f.store, f.backup, { env }));
  assert.equal(await readFile(conflicting, 'utf8'), 'different-private-file');
  await assert.rejects(() => readFile(join(env.SOCIAL_MEDIA_DIR, f.data.originalKey)), /ENOENT/);
});

test('corrupt bytes cannot be adopted by changing the manifest, and absent volume files remain blocked', async t => {
  const f = await fixture(t);
  await backupSocialMedia(f.store, f.backup, { env: f.env });
  await writeFile(join(f.backup, f.data.derivativeKey), 'corrupt');
  await assert.rejects(() => restoreSocialMedia(f.store, f.backup, { env: { ...f.env, SOCIAL_MEDIA_DIR: join(f.root, 'target') } }));
  await rm(join(f.env.SOCIAL_MEDIA_DIR, f.data.derivativeKey));
  await verifySocialMediaFiles(f.store, { env: f.env, now });
  assert.ok(['missing_file', 'failed'].includes((await asset(f)).state));
  assert.equal((await asset(f)).sha256, f.data.derivativeSha256);
  assert.equal((await f.store.db.all(`SELECT * FROM ${f.store.t('job_runs')} WHERE key LIKE 'social:%'`)).length, 0);
});

test('backup rejects symlink roots and does not place a copy inside the media volume', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  await symlink(f.env.SOCIAL_MEDIA_DIR, alias);
  await assert.rejects(() => backupSocialMedia(f.store, join(f.env.SOCIAL_MEDIA_DIR, 'copy'), { env: f.env }));
  await assert.rejects(() => backupSocialMedia(f.store, f.backup, { env: { ...f.env, SOCIAL_MEDIA_DIR: alias } }));
});

test('a source ancestor alias cannot hide a backup directory inside the private volume', async t => {
  const f = await fixture(t), alias = join(f.root, 'ancestor-alias'), nested = join(f.env.SOCIAL_MEDIA_DIR, 'nested-copy');
  await symlink(f.root, alias);
  const env = { ...f.env, SOCIAL_MEDIA_DIR: join(alias, 'media') };
  await assert.rejects(() => backupSocialMedia(f.store, nested, { env, now }));
  await assert.rejects(() => lstat(nested), error => error.code === 'ENOENT');
});

test('physical reset revokes browser custody and social jobs but preserves business, remote IDs and uncertain evidence', async t => {
  const f = await fixture(t);
  const basics = await createBusinessBasics(f.store);
  await f.store.saveOrder(businessOrderInput(basics.a), basics.actorId);
  const ordersBefore = await f.store.db.all(`SELECT * FROM ${f.store.t('orders')}`);
  const revisionBefore = await f.store.db.get(`SELECT * FROM ${f.store.t('counters')} WHERE id='business_revision'`);
  const browserId = randomUUID(), apiId = randomUUID(), campaignId = randomUUID(), deliveryId = randomUUID(), operationId = randomUUID();
  await f.store.transaction(async tx => {
    for (const [id, method] of [[browserId, 'browser'], [apiId, 'api']]) {
      await insertRow(tx, 'social_connections', { id, provider: 'meta', integration_method: method, state: 'connected', data: JSON.stringify({ sessionEpoch: 7, identities: { userId: '101' } }), ...editable });
      await insertRow(tx, 'social_credentials', { connection_id: id, ciphertext: 'ciphertext-only', iv: 'iv', auth_tag: 'tag', version: 1, updated_at: now });
    }
    await insertRow(tx, 'social_campaigns', { id: campaignId, connection_id: browserId, asset_id: f.id, name: 'Campaña incierta', mode: 'organic', objective: 'reach', state: 'needs_attention', data: '{}', ...editable });
    await insertRow(tx, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: 'b'.repeat(64), approved_at: now, actor_id: basics.actorId, data: '{"immutable":"evidence"}' });
    await insertRow(tx, 'social_deliveries', { id: deliveryId, campaign_id: campaignId, revision: 1, channel: 'facebook', state: 'uncertain', remote_id: 'remote-known-post', next_sync_at: null, data: '{"remoteRefs":{"remoteId":"remote-known-post"}}', ...editable });
    await insertRow(tx, 'social_operations', { id: operationId, campaign_id: campaignId, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:publish`, step: 'publish', state: 'sent', next_attempt_at: null, data: '{"evidence":"sent-before-crash"}', ...editable });
    for (const key of [`social:browser-lock:${browserId}`, `social:browser:delivery:${deliveryId}`, 'accounting:retained-job']) await insertRow(tx, 'job_runs', { key, state: 'running', lease_token: randomUUID(), lease_until: '2099-01-01T00:00:00.000Z', data: '{}', ...editable });
    await insertRow(tx, 'social_browser_controls', { id: randomUUID(), connection_id: browserId, actor_id: basics.actorId, session_binding: 'binding', lease_key: `social:browser-lock:${browserId}`, lease_token: 'old-lease', state: 'active', expires_at: '2099-01-01T00:00:00.000Z', last_seen_at: now, created_at: now, updated_at: now });
  });
  const deliveryBefore = await f.store.db.get(`SELECT * FROM ${f.store.t('social_deliveries')} WHERE id=?`, [deliveryId]);
  const operationBefore = await f.store.db.get(`SELECT * FROM ${f.store.t('social_operations')} WHERE id=?`, [operationId]);
  await configureSocialTestRuntime(f.store, { env: f.env, settings: { publishingEnabled: false, browserEnabled: true } });
  await assert.rejects(() => resetSocialAfterPhysicalRestore(f.store, { env: f.env }));
  await configureSocialTestRuntime(f.store, { env: f.env, settings: { publishingEnabled: false, browserEnabled: false } });
  const counts = await resetSocialAfterPhysicalRestore(f.store, { env: f.env, now, requestId: 'physical-restore-contract' });
  assert.equal(counts.jobs, 2);
  assert.equal(counts.browserCredentials, 1);
  for (const connection of await f.store.db.all(`SELECT * FROM ${f.store.t('social_connections')}`)) {
    assert.equal(connection.state, 'reconnect_required');
    assert.equal(JSON.parse(connection.data).sessionEpoch, 8);
  }
  assert.equal((await f.store.db.all(`SELECT * FROM ${f.store.t('social_browser_controls')}`)).length, 0);
  assert.equal((await f.store.db.all(`SELECT * FROM ${f.store.t('social_credentials')}`)).length, 1);
  assert.equal(JSON.parse((await f.store.db.get(`SELECT data FROM ${f.store.t('social_campaigns')} WHERE id=?`, [campaignId])).data).restore_hold, true);
  assert.deepEqual(await f.store.db.get(`SELECT * FROM ${f.store.t('social_deliveries')} WHERE id=?`, [deliveryId]), deliveryBefore);
  assert.deepEqual(await f.store.db.get(`SELECT * FROM ${f.store.t('social_operations')} WHERE id=?`, [operationId]), operationBefore);
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('orders')}`), ordersBefore);
  assert.deepEqual(await f.store.db.get(`SELECT * FROM ${f.store.t('counters')} WHERE id='business_revision'`), revisionBefore);
  assert.ok(await f.store.db.get(`SELECT * FROM ${f.store.t('job_runs')} WHERE key='accounting:retained-job'`));
  assert.deepEqual(await resetSocialAfterPhysicalRestore(f.store, { env: f.env, now, requestId: 'physical-restore-contract' }), counts);
});

function cli(args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/social-media-backup.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout, stderr }));
  });
}

test('CLI rejects malformed commands before opening a database and performs a discarded physical-reset/verify cycle', async t => {
  const f = await fixture(t);
  const env = { ...f.env, DB_DRIVER: 'sqlite', SQLITE_PATH: join(f.root, 'cli.sqlite') };
  const bad = await cli(['restore'], env);
  assert.equal(bad.code, 1);
  await assert.rejects(() => readFile(env.SQLITE_PATH), /ENOENT/);
  const discarded = await openStore(env);
  await configureSocialTestRuntime(discarded, { env, settings: { publishingEnabled: true, browserEnabled: false } });
  await discarded.close();
  const unsafe = await cli(['reset-after-physical-restore'], env);
  assert.equal(unsafe.code, 1);
  const disabled = await openStore(env);
  await configureSocialTestRuntime(disabled, { env, settings: { publishingEnabled: false, browserEnabled: false } });
  await disabled.close();
  const reset = await cli(['reset-after-physical-restore'], env);
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(JSON.parse(reset.stdout).command, 'reset-after-physical-restore');
  const verification = await cli(['verify'], env);
  assert.equal(verification.code, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).command, 'verify');
});
