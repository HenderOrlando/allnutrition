import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { socialConnection } from './social-contract.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { getSocialMeasurement, saveSocialMeasurement, verifySocialMeasurement } from '../lib/business/social-measurement.mjs';
import { socialMeasurementDTO } from '../lib/social/measurement-model.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';

const actorId = 'social-fixture-admin';
async function fixture(fn) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const env = {};
  try {
    const { runtime } = await configureSocialTestRuntime(store, { env, settings: { browserEnabled: false } });
    const connection = await socialConnection(store, { data: { authenticationMethod: 'token', readOnly: true, configurationFingerprint: runtime.fingerprint, identities: { userId: '101', adAccountId: 'act_501' }, capabilities: { insights: true }, resources: { adAccounts: [{ id: 'act_501' }] } } });
    await saveCredentials(store, connection.id, { accessToken: 'SYNTHETIC-MEASUREMENT-CANARY', userId: '101' }, { runtime, env });
    const remote = { calls: [], pixelId: '601', denied: false, beforeSources: null };
    const fetchImpl = async (input, init) => {
      const url = new URL(input), path = url.pathname.replace(/^\/v26\.0\//, '');
      assert.equal(init.method, 'GET', 'measurement verification must not send events or writes');
      remote.calls.push(path);
      if (path === 'debug_token') return Response.json({ data: { app_id: runtime.appId, type: 'USER', user_id: '101', is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 3600, data_access_expires_at: Math.floor(Date.now() / 1000) + 7200, scopes: ['ads_read'] } });
      if (path === 'me') return Response.json({ id: '101', name: 'Medición sintética' });
      if (path === 'me/permissions') return Response.json({ data: [{ permission: 'ads_read', status: 'granted' }] });
      if (path === 'me/adaccounts') return Response.json({ data: [{ id: 'act_501', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: ['ANALYZE'] }] });
      if (path === 'act_501/adspixels') {
        if (remote.beforeSources) await remote.beforeSources();
        if (remote.denied) return Response.json({ error: { code: 200, message: 'SYNTHETIC-MEASUREMENT-CANARY' } }, { status: 403 });
        return Response.json({ data: [{ id: remote.pixelId, name: 'Fuente de prueba', last_fired_time: '2026-11-15T10:00:00+0000', is_unavailable: false, code: 'DO-NOT-EXPOSE-TRACKING-CODE' }] });
      }
      throw new Error('Unexpected synthetic path ' + path);
    };
    const options = { env, fetchImpl };
    const config = { objective: 'sales', source: 'meta_pixel', pixelId: '601', datasetId: '', events: [{ name: 'Purchase', objective: 'sales' }], externalDescription: '' };
    const save = async (changes = {}) => saveSocialMeasurement(store, connection.id, { version: (await getSocialConnection(store, connection.id)).version, config: { ...config, ...changes }, requestId: randomUUID() }, actorId, options);
    const verify = async () => verifySocialMeasurement(store, connection.id, { version: (await getSocialConnection(store, connection.id)).version, requestId: randomUUID() }, actorId, options);
    await fn({ store, connection, options, remote, config, save, verify });
  } finally { await store.close(); }
}

test('objective and events are local configuration, not a claim that tracking is installed', () => fixture(async ({ store, connection, save, remote }) => {
  const saved = await save();
  assert.equal(saved.config.objective, 'sales');
  assert.equal(saved.config.verification.status, 'unverified');
  assert.deepEqual(saved.config.events, [{ name: 'Purchase', objective: 'sales' }]);
  assert.equal(remote.calls.length, 0);
  assert.match(saved.requirements.sales, /no demuestra compras/);
  assert.match((await getSocialMeasurement(store, connection.id)).notice, /No instala rastreadores/);
}));

test('source access is verified by account association, never by arbitrary node IDs or event submission', () => fixture(async ({ save, verify, remote }) => {
  await save();
  const result = await verify();
  assert.equal(result.config.verification.status, 'verified');
  assert.equal(result.config.verification.accountId, 'act_501');
  assert.equal(result.config.verification.sourceId, '601');
  assert.match(result.config.verification.notice, /no comprueba instalación/);
  assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPOSE'));
  assert.deepEqual(remote.calls.filter(path => path.endsWith('adspixels')), ['act_501/adspixels']);
  remote.pixelId = '602';
  assert.equal((await verify()).config.verification.status, 'unavailable');
}));

test('dataset and external source configuration never invent dataset ownership or external attribution', () => fixture(async ({ save, verify, remote }) => {
  await save({ source: 'dataset', datasetId: '999' });
  const missing = await verify();
  assert.equal(missing.config.verification.status, 'unavailable');
  await save({ source: 'external', externalDescription: 'UTM de campaña y reporte agregado de compras' });
  const calls = remote.calls.length;
  assert.equal((await verify()).config.verification.status, 'unavailable');
  assert.equal(remote.calls.length, calls);
}));

test('changing source/events invalidates verification, while changing only goal preserves source evidence', () => fixture(async ({ save, verify, store, connection }) => {
  await save(); await verify();
  assert.equal((await save({ objective: 'traffic' })).config.verification.status, 'verified');
  assert.equal((await save({ events: [{ name: 'Contact', objective: 'whatsapp' }] })).config.verification.status, 'unverified');
  await save(); await verify();
  const current = await getSocialConnection(store, connection.id);
  assert.equal(socialMeasurementDTO({ ...current, identities: { ...current.identities, adAccountId: 'act_999' } }).verification.status, 'unverified');
  assert.equal(socialMeasurementDTO({ ...current, state: 'disconnected' }).verification.status, 'unverified');
  assert.equal(socialMeasurementDTO({ ...current, sessionEpoch: (current.sessionEpoch || 0) + 1 }).verification.status, 'unverified');
  assert.equal(socialMeasurementDTO({ ...current, configurationFingerprint: 'changed-app-config' }).verification.status, 'unverified');
}));

test('permission failure is visible and does not credit an inaccessible pixel', () => fixture(async ({ save, verify, remote }) => {
  await save(); remote.denied = true;
  const result = await verify();
  assert.equal(result.config.verification.status, 'unavailable');
  assert.match(result.config.verification.notice, /no autoriza/);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC-MEASUREMENT-CANARY'));
}));

test('late source verification cannot overwrite a changed configuration', () => fixture(async ({ save, verify, remote, store, connection }) => {
  await save();
  remote.beforeSources = async () => { await save({ objective: 'traffic' }); };
  await assert.rejects(verify(), /cambió durante/);
  assert.equal((await getSocialMeasurement(store, connection.id)).config.objective, 'traffic');
  assert.equal((await getSocialMeasurement(store, connection.id)).config.verification.status, 'unverified');
}));

test('verification replays do not repeat Meta reads, and inactive administrators cannot replay results', () => fixture(async ({ save, options, store, connection, remote }) => {
  await save();
  const input = { version: (await getSocialConnection(store, connection.id)).version, requestId: randomUUID() };
  const first = await verifySocialMeasurement(store, connection.id, input, actorId, options);
  const calls = remote.calls.length;
  assert.deepEqual(await verifySocialMeasurement(store, connection.id, input, actorId, options), first);
  assert.equal(remote.calls.length, calls);
  await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [actorId]);
  await assert.rejects(verifySocialMeasurement(store, connection.id, input, actorId, options), error => error.status === 403);
  assert.equal(remote.calls.length, calls);
}));

test('malformed IDs, duplicate events and stale saves are rejected before any provider call', () => fixture(async ({ save, store, connection, config, options, remote }) => {
  await assert.rejects(save({ pixelId: 'https://example.test/601' }), /dígitos/);
  await assert.rejects(save({ events: [{ name: 'Purchase', objective: 'sales' }, { name: 'Purchase', objective: 'sales' }] }), /No repitas/);
  const before = await getSocialConnection(store, connection.id);
  await save();
  await assert.rejects(saveSocialMeasurement(store, connection.id, { version: before.version, requestId: randomUUID(), config }, actorId, options), /cambió/);
  assert.equal(remote.calls.length, 0);
}));
