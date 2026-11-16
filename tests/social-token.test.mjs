import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { createTokenSocialConnection, socialConnectionAction, getSocialConnections, startSocialOAuth, completeSocialOAuth } from '../lib/business/social-connections.mjs';
import { getSocialAccountAdvertising } from '../lib/business/social-account-advertising.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';
import { loadCredentials } from '../lib/social/credentials.mjs';
import { buildSocialSpec } from '../lib/business/social-spec.mjs';

const TOKEN = 'SYNTHETIC-MANUAL-TOKEN-CANARY';
const actorId = 'social-fixture-admin';
async function setup(fn) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const env = {};
  try {
    const { runtime } = await configureSocialTestRuntime(store, { env, settings: { browserEnabled: false, loginConfigId: '', publishingEnabled: true } });
    const remote = { permissions: ['ads_read'], tasks: ['ANALYZE'], valid: true, status: 200, header: false, calls: [], onInsights: null };
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input), path = url.pathname.replace(/^\/v26\.0\//, '');
      remote.calls.push({ path, method: init.method });
      assert.equal(init.method, 'GET', 'manual tokens must never write to Meta');
      const headers = remote.header ? { 'x-app-usage': JSON.stringify({ call_count: 81, total_cputime: 12, total_time: 22 }) } : {};
      if (path === 'oauth/access_token') return Response.json({ access_token: TOKEN, expires_in: 3600 });
      if (path === 'debug_token') return Response.json({ data: { app_id: runtime.appId, is_valid: remote.valid, type: 'USER', user_id: '101', expires_at: Math.floor(Date.now() / 1000) + 3600, data_access_expires_at: Math.floor(Date.now() / 1000) + 7200, scopes: remote.permissions } }, { headers });
      if (path === 'me') return Response.json({ id: '101', name: 'Usuario sintético' });
      if (path === 'me/permissions') return Response.json({ data: remote.permissions.map(permission => ({ permission, status: 'granted' })) });
      if (path === 'me/accounts') return Response.json({ data: [] });
      if (path === 'me/adaccounts') return Response.json({ data: [{ id: 'act_501', name: 'Cuenta verificada', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: remote.tasks }] });
      if (path === 'act_501/insights') {
        if (remote.onInsights) await remote.onInsights();
        if (remote.status !== 200) return Response.json({ error: { code: 4, message: TOKEN } }, { status: 429, headers: { ...headers, 'retry-after': '60' } });
        assert.deepEqual(JSON.parse(url.searchParams.get('time_range')), { since: '2026-11-01', until: '2026-11-02' });
        return Response.json({ data: [{ account_id: '501', account_currency: 'COP', campaign_id: '701', campaign_name: 'Campaña existente', impressions: '123', clicks: '4', spend: '1000.25' }] }, { headers });
      }
      throw new Error('Unexpected synthetic Meta path: ' + path);
    };
    const options = { env, fetchImpl };
    const input = { integrationMethod: 'api', authenticationMethod: 'token', name: 'Consulta manual', accessToken: TOKEN, requestId: randomUUID() };
    const create = () => createTokenSocialConnection(store, input, actorId, options);
    const select = connection => socialConnectionAction(store, connection.id, 'select-assets', { version: connection.version, identities: { adAccountId: 'act_501' }, requestId: randomUUID() }, actorId, options);
    const query = connection => getSocialAccountAdvertising(store, connection.id, { from: '2026-11-01', to: '2026-11-02' }, actorId, options);
    await fn({ store, env, runtime, remote, options, input, create, select, query });
  } finally { await store.close(); }
}

test('manual token is encrypted, idempotent and independent of OAuth login configuration', () => setup(async ({ store, runtime, options, input, create, remote }) => {
  const connection = await create();
  assert.equal(connection.authenticationMethod, 'token');
  assert.equal(connection.readOnly, true);
  assert.equal(connection.capabilities.adsPublish, false);
  assert.equal(connection.evaluation.limits.status, 'unknown');
  assert.deepEqual(connection.resources.adAccounts.map(item => item.id), ['act_501']);
  const calls = remote.calls.length;
  assert.deepEqual(await create(), connection);
  assert.equal(remote.calls.length, calls, 'replay must not contact Meta');
  const saved = await getSocialConnection(store, connection.id);
  assert.equal((await loadCredentials(store, saved, runtime)).accessToken, TOKEN);
  for (const table of ['social_connections', 'social_credentials', 'business_requests', 'business_audit']) assert.ok(!JSON.stringify(await store.db.all(`SELECT * FROM ${store.t(table)}`)).includes(TOKEN), table + ' leaked plaintext');
  const listed = await getSocialConnections(store, options);
  assert.equal(listed.tokenRequirement.configured, true);
  assert.equal(listed.requirements.find(item => item.integrationMethod === 'api').configured, false);
  await assert.rejects(createTokenSocialConnection(store, { ...input, accessToken: 'DIFFERENT-SYNTHETIC-TOKEN' }, actorId, options), /datos distintos/);
}));

test('manual connection reads existing campaign metrics, preserving unknown values and live permissions', () => setup(async ({ create, select, query, remote }) => {
  const connection = await select(await create());
  assert.equal(connection.capabilities.insights, true);
  assert.equal(connection.capabilities.adsPublish, false);
  remote.header = true;
  const report = await query(connection);
  assert.equal(report.accountId, 'act_501');
  assert.equal(report.currency, 'COP');
  assert.deepEqual(report.rows, [{ campaignId: '701', campaignName: 'Campaña existente', impressions: '123', clicks: '4', reach: null, spend: '1000.25' }]);
  assert.equal(report.evaluation.limits.status, 'reported');
  remote.permissions = [];
  await assert.rejects(query(connection), error => error.kind === 'permission');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/insights')).length, 1, 'lost permissions must prevent insights request');
}));

test('manual publication cannot be approved even if stored capabilities claim write access', () => setup(async ({ create, runtime, store, env }) => {
  const connection = await create();
  assert.throws(() => buildSocialSpec({}, { connection: { ...connection, capabilities: { adsPublish: true, facebookPublish: true } } }), /solo lectura/);
  // OAuth reconnect cannot silently remove the read-only policy.
  await store.db.run(`UPDATE ${store.t('social_integration_settings')} SET data=? WHERE id=1`, [JSON.stringify({ publicBaseUrl: runtime.publicBaseUrl, appId: runtime.appId, loginConfigId: '102', browserEnabled: false, publishingEnabled: true })]);
  await assert.rejects(startSocialOAuth(store, { connectionId: connection.id }, { user: { id: actorId }, csrf: 'synthetic', expires: Date.now() + 60000 }, { env }), /no se convierte a OAuth/);
}));

test('account tasks are required even with ads_read; revoked token disables the connection', () => setup(async ({ create, select, query, remote, store }) => {
  const connection = await select(await create());
  remote.tasks = ['DRAFT'];
  await assert.rejects(query(connection), error => error.kind === 'permission');
  assert.equal(remote.calls.some(call => call.path.endsWith('/insights')), false);
  remote.valid = false;
  await assert.rejects(query(connection), error => error.kind === 'reconnect_required');
  assert.equal((await getSocialConnection(store, connection.id)).state, 'reconnect_required');
}));

test('rate limiting retains provider usage and retry delay without exposing raw error text', () => setup(async ({ create, select, query, remote, store }) => {
  const connection = await select(await create());
  remote.status = 429; remote.header = true;
  await assert.rejects(query(connection), error => error.kind === 'rate_limit' && error.retryAfter === 60 && error.limits.status === 'reported' && !error.message.includes(TOKEN));
  const current = await getSocialConnection(store, connection.id);
  assert.equal(current.evaluation.limits.retryAfter, 60);
  assert.equal(current.state, 'connected');
}));

test('a connection disconnected during a report cannot return stale authorized data', () => setup(async ({ create, select, query, remote, store }) => {
  const connection = await select(await create());
  remote.onInsights = () => store.db.run(`UPDATE ${store.t('social_connections')} SET state='disconnected',version=version+1 WHERE id=?`, [connection.id]);
  await assert.rejects(query(connection), /cambiaron durante la consulta/);
}));

test('invalid request IDs and dates never trigger remote calls', () => setup(async ({ store, input, options, remote, create, select }) => {
  await assert.rejects(createTokenSocialConnection(store, { ...input, requestId: 'bad' }, actorId, options), /Identificador/);
  assert.equal(remote.calls.length, 0);
  const connection = await select(await create());
  const calls = remote.calls.length;
  await assert.rejects(getSocialAccountAdvertising(store, connection.id, { from: '2026-02-30', to: '2026-11-02' }, actorId, options), /fecha no válida/);
  assert.equal(remote.calls.length, calls);
}));

test('OAuth keeps its own flow and uses the same evaluated account report with ads_management', () => setup(async ({ store, env, remote, options, select, query }) => {
  await configureSocialTestRuntime(store, { env, settings: { loginConfigId: '902' } });
  remote.permissions = ['ads_management']; remote.header = true;
  const session = { user: { id: actorId }, csrf: 'synthetic-oauth-csrf', expires: Date.now() + 60000 };
  const started = await startSocialOAuth(store, {}, session, options);
  const completed = await completeSocialOAuth(store, { code: 'synthetic-code', state: new URL(started.authorizationUrl).searchParams.get('state') }, session, options);
  assert.equal(completed.connection.authenticationMethod, 'oauth');
  assert.equal(completed.connection.readOnly, false);
  const connection = await select(completed.connection);
  assert.equal(connection.evaluation.permissions.find(item => item.name === 'ads_management').status, 'granted');
  const result = await query(connection);
  assert.equal(result.rows[0].campaignId, '701');
  assert.equal(result.evaluation.limits.status, 'reported');
}));
