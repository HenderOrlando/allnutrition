import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaClient, createMetaApiConnector, MetaApiError } from '../lib/social/meta.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const EXPIRES = NOW / 1000 + 3600;
const TOKEN = 'SYNTHETIC-ACCESS-TOKEN-CANARY';
const SECRET = 'SYNTHETIC-ACCESS-SECRET-CANARY';
const PAGE_TOKEN = 'SYNTHETIC-ACCESS-PAGE-CANARY';
const SCOPES = ['ads_read', 'ads_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_ads', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'business_management'];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const denied = error => error instanceof MetaApiError && error.kind === 'permission';

function fixture({ authenticationMethod = 'token', readOnly = false, identities = { userId: '100', adAccountId: 'act_400' }, debug = {}, permissions, tasks = ['ANALYZE'], pages, headers = {} } = {}) {
  const requests = [];
  const tokenData = { app_id: '42', type: 'USER', is_valid: true, user_id: '100', scopes: SCOPES, expires_at: EXPIRES, data_access_expires_at: EXPIRES + 3600, ...debug };
  const account = { id: 'act_400', name: 'Cuenta sintética', currency: 'USD', timezone_name: 'America/Bogota', account_status: 1, user_tasks: tasks, business: { id: '500', name: 'Negocio sintético' } };
  const fetchImpl = async (href, init) => {
    const path = new URL(href).pathname.replace('/v26.0/', '');
    requests.push({ path, method: init.method });
    if (path === 'debug_token') return json({ data: tokenData }, 200, headers);
    if (path === 'me') return json({ id: '100', name: 'Usuario sintético' });
    if (path === 'me/permissions' && init.method === 'GET') return json({ data: permissions ?? SCOPES.map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me/permissions' && init.method === 'DELETE') return json({ success: true });
    if (path === 'me/accounts') return json({ data: pages ?? [] });
    if (path === 'me/adaccounts') return json({ data: [account] });
    if (path === '200') return json(pages?.[0] || {});
    if (path === 'act_400') return json(account);
    throw new Error(`Unexpected synthetic request ${path}`);
  };
  const api = createMetaApiConnector({ connection: { integrationMethod: 'api', data: { ...(authenticationMethod === null ? {} : { authenticationMethod }), readOnly, identities } }, credentials: { accessToken: TOKEN }, runtime: { appId: '42', appSecret: SECRET }, transport: { fetchImpl, now: NOW } });
  return { api, requests, fetchImpl };
}

function assertPublic(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [TOKEN, SECRET, PAGE_TOKEN]) assert.equal(serialized.includes(secret), false);
}

test('Manual validation defaults to read, reports real expiration and disables every publishing capability', async () => {
  const { api, requests } = fixture();
  const status = await api.validateConnection();
  assert.deepEqual(status.capabilities, { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false });
  assert.deepEqual(status.evaluation, {
    checkedAt: new Date(NOW).toISOString(), tokenType: 'USER', expiresAt: new Date(EXPIRES * 1000).toISOString(),
    dataAccessExpiresAt: new Date((EXPIRES + 3600) * 1000).toISOString(), expirationStatus: 'reported',
    permissions: SCOPES.map(name => ({ name, status: 'granted' })),
    limits: { status: 'unknown', observedAt: null, usage: [], retryAfter: null },
    restrictions: ['Conexión de solo lectura: no permite publicar, modificar, pausar ni revocar permisos remotos.']
  });
  const { credentials, ...publicStatus } = status;
  assertPublic(publicStatus);
  assert.equal(requests.every(request => request.method === 'GET'), true);
});

test('Manual USER and SYSTEM_USER tokens preserve explicit zero and absent expiration without fictitious dates', async () => {
  for (const type of ['USER', 'SYSTEM_USER']) {
    const zero = await fixture({ debug: { type, expires_at: 0, data_access_expires_at: 0 } }).api.validateConnection();
    assert.equal(zero.evaluation.tokenType, type);
    assert.equal(zero.evaluation.expiresAt, null);
    assert.equal(zero.evaluation.dataAccessExpiresAt, null);
    assert.equal(zero.evaluation.expirationStatus, 'not_scheduled');
    const missing = await fixture({ debug: { type, expires_at: undefined, data_access_expires_at: undefined } }).api.validateConnection();
    assert.equal(missing.evaluation.expiresAt, null);
    assert.equal(missing.evaluation.dataAccessExpiresAt, null);
    assert.equal(missing.evaluation.expirationStatus, 'unknown');
  }
});

test('Manual tokens still reject expired, malformed, foreign-app and non-user authorization', async () => {
  for (const debug of [
    { expires_at: NOW / 1000 }, { data_access_expires_at: NOW / 1000 - 1 }, { expires_at: -1 },
    { expires_at: '0' }, { expires_at: false }, { expires_at: 1e20 }, { app_id: '43' },
    { type: 'PAGE' }, { is_valid: false }, { user_id: '' }
  ]) {
    await assert.rejects(() => fixture({ debug }).api.validateConnection(), error => error.kind === 'reconnect_required');
  }
});

test('Declined, expired and unconfirmed permissions never authorize ads reads', async () => {
  for (const status of ['declined', 'expired', 'unknown']) {
    const permissions = status === 'unknown' ? [] : [{ permission: 'ads_read', status }];
    const { api } = fixture({ debug: { scopes: ['ads_read'] }, permissions });
    const result = await api.validateConnection();
    assert.equal(result.capabilities.insights, false);
    assert.deepEqual(result.evaluation.permissions, [{ name: 'ads_read', status }]);
    assert.equal(result.evaluation.restrictions.some(value => value.includes('ads_read')), true);
    await assert.rejects(() => api.validateConnection({ purpose: 'insights', channel: 'meta_ads' }), denied);
  }
  const contradictory = fixture({ debug: { scopes: ['ads_read'] }, permissions: [{ permission: 'ads_read', status: 'declined' }, { permission: 'ads_read', status: 'granted' }] });
  assert.equal((await contradictory.api.validateConnection()).capabilities.insights, false);
  const debugDenied = fixture({ debug: { scopes: [] }, permissions: [{ permission: 'ads_read', status: 'granted' }] });
  assert.equal((await debugDenied.api.validateConnection()).capabilities.insights, false);
});

test('Ads reads require an analysis task and either confirmed ads_read or ads_management', async () => {
  for (const scope of ['ads_read', 'ads_management']) {
    for (const task of ['ANALYZE', 'AA_ANALYZE', 'MANAGE']) {
      const { api } = fixture({ debug: { scopes: [scope] }, tasks: [task] });
      assert.equal((await api.validateConnection()).capabilities.insights, true);
      const result = await api.validateConnection({ purpose: 'insights', channel: 'meta_ads' });
      assert.equal(result.capabilities.insights, true);
      assert.equal(result.evaluation.tokenType, 'USER');
      assert.equal(result.evaluation.permissions.find(row => row.name === scope).status, 'granted');
    }
  }
  for (const tasks of [[], ['DRAFT'], ['ADVERTISE']]) {
    const { api } = fixture({ tasks });
    assert.equal((await api.validateConnection()).capabilities.insights, false);
    await assert.rejects(() => api.validateConnection({ purpose: 'insights', channel: 'meta_ads' }), denied);
  }
});

test('Granular ads scopes apply to the selected account including empty and multiple target lists', async () => {
  for (const target_ids of [[], ['401'], ['act_401']]) {
    const { api } = fixture({ debug: { scopes: ['ads_management'], granular_scopes: [{ scope: 'ads_management', target_ids }] } });
    assert.equal((await api.validateConnection()).capabilities.insights, false);
    await assert.rejects(() => api.validateConnection({ purpose: 'insights', channel: 'meta_ads' }), denied);
  }
  for (const target_ids of [['400'], ['act_400']]) {
    const { api } = fixture({ debug: { scopes: ['ads_management'], granular_scopes: [{ scope: 'ads_management', target_ids: ['401'] }, { scope: 'ads_management', target_ids }] } });
    assert.equal((await api.validateConnection({ purpose: 'insights', channel: 'meta_ads' })).capabilities.insights, true);
  }
});

test('Manual policy rejects explicit publishing, pausing, execution and remote revocation before any network request', async () => {
  const { api, requests } = fixture({ readOnly: false, tasks: ['MANAGE'] });
  await assert.rejects(() => api.validateConnection({ purpose: 'publish' }), denied);
  await assert.rejects(() => api.validateConnection({ purpose: 'pause' }), denied);
  await assert.rejects(() => api.executeStep({}), denied);
  await assert.rejects(() => api.disconnect(), denied);
  assert.deepEqual(requests, []);
  const guarded = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, readOnly: true, fetchImpl: async () => { assert.fail('Must not send a mutation'); } });
  await assert.rejects(() => guarded.post('act_400/campaigns', {}), denied);
  await assert.rejects(() => guarded.request('me/permissions', { method: 'DELETE' }), denied);
  await assert.rejects(() => guarded.upload('200/videos', { body: new Uint8Array([1]) }), denied);
});

test('OAuth preserves user expiration safeguards, independent publishing and remote disconnect', async () => {
  const page = { id: '200', name: 'Página sintética', tasks: ['MANAGE'], access_token: PAGE_TOKEN, instagram_business_account: { id: '300' }, business: { id: '500' }, whatsapp_number: '+570000000000' };
  const { api, requests } = fixture({ authenticationMethod: null, identities: { userId: '100', adAccountId: 'act_400', pageId: '200', instagramId: '300' }, tasks: ['MANAGE'], pages: [page] });
  const status = await api.validateConnection();
  assert.deepEqual(status.capabilities, { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true });
  assert.equal(status.evaluation.expirationStatus, 'reported');
  assert.deepEqual(status.evaluation.restrictions, []);
  assertPublic(status.evaluation);
  assert.deepEqual(await api.disconnect(), { revoked: true });
  assert.deepEqual(requests.at(-1), { path: 'me/permissions', method: 'DELETE' });
  for (const debug of [{ type: 'SYSTEM_USER' }, { expires_at: 0 }, { expires_at: undefined }, { data_access_expires_at: 0 }, { data_access_expires_at: undefined }]) {
    await assert.rejects(() => fixture({ authenticationMethod: 'oauth', debug }).api.validateConnection(), error => error.kind === 'reconnect_required');
  }
});

test('Unknown limits stay unknown and malformed or arbitrary header content is never retained', async () => {
  const headers = {
    'x-app-usage': JSON.stringify({ call_count: '50', total_cputime: -1, total_time: null, message: TOKEN }),
    'x-page-usage': '{not-json', 'x-business-use-case-usage': JSON.stringify({ [TOKEN]: [{ call_count: 99 }] }),
    'retry-after': SECRET, 'x-private-secret': SECRET
  };
  const { api } = fixture({ headers });
  const result = await api.validateConnection();
  assert.deepEqual(result.evaluation.limits, { status: 'unknown', observedAt: null, usage: [], retryAfter: null });
  assertPublic(result.evaluation);
});

test('Usage snapshots retain only reported numeric metrics, safe scope IDs and detached values', async () => {
  const headers = {
    'x-app-usage': JSON.stringify({ call_count: 0, total_cputime: 12.5, total_time: 9, access_token: TOKEN }),
    'x-page-usage': JSON.stringify({ call_count: 30, total_cputime: null, total_time: '40', arbitrary: SECRET }),
    'x-business-use-case-usage': JSON.stringify({ '500': [{ type: TOKEN, call_count: 42, total_cputime: 18, total_time: 27, estimated_time_to_regain_access: 2 }], [SECRET]: [{ call_count: 100 }] }),
    'retry-after': '17', 'x-private': TOKEN
  };
  const { api } = fixture({ headers });
  const result = await api.validateConnection();
  assert.deepEqual(result.evaluation.limits, {
    status: 'reported', observedAt: new Date(NOW).toISOString(), retryAfter: 17,
    usage: [
      { source: 'x-app-usage', scope: 'app', callCount: 0, totalCpuTime: 12.5, totalTime: 9, estimatedTimeToRegainAccess: null },
      { source: 'x-page-usage', scope: 'page', callCount: 30, totalCpuTime: null, totalTime: null, estimatedTimeToRegainAccess: null },
      { source: 'x-business-use-case-usage', scope: '500', callCount: 42, totalCpuTime: 18, totalTime: 27, estimatedTimeToRegainAccess: 2 }
    ]
  });
  assertPublic(result.evaluation);
  const snapshot = api.usageSnapshot();
  snapshot.usage[0].callCount = 999;
  snapshot.usage.push({ source: TOKEN });
  assert.equal(api.usageSnapshot().usage[0].callCount, 0);
  assert.equal(api.usageSnapshot().usage.length, 3);
});

test('429 errors capture sanitized limits even for non-JSON bodies without claiming an exact quota', async () => {
  for (const body of [JSON.stringify({ error: { code: 4, message: `${TOKEN} ${SECRET}` } }), `${TOKEN} ${SECRET}`]) {
    const client = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, now: NOW, fetchImpl: async () => new Response(body, { status: 429, headers: { 'x-app-usage': JSON.stringify({ call_count: 99, secret: SECRET }), 'retry-after': '45' } }) });
    await assert.rejects(() => client.get('me'), error => {
      assert.equal(error.kind, 'rate_limit');
      assert.equal(error.retryAfter, 45);
      assert.equal(error.limits.status, 'reported');
      assert.equal(error.limits.usage[0].callCount, 99);
      assert.equal(Object.hasOwn(error.limits, 'quota'), false);
      assert.deepEqual(error.limits, client.usageSnapshot());
      assertPublic(error);
      return true;
    });
  }
  const unknown = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, now: NOW, fetchImpl: async () => json({ error: { code: 4 } }, 429) });
  await assert.rejects(() => unknown.get('me'), error => error.kind === 'rate_limit' && error.limits.status === 'unknown' && error.limits.retryAfter === null);
});

test('Retry-After date uses the injected clock and reports no fabricated usage percentages', async () => {
  const client = createMetaClient({ accessToken: TOKEN, appSecret: SECRET, now: NOW, fetchImpl: async () => json({ error: { code: 4 } }, 429, { 'retry-after': new Date(NOW + 60000).toUTCString() }) });
  await assert.rejects(() => client.get('me'), error => {
    assert.equal(error.retryAfter, 60);
    assert.deepEqual(error.limits, { status: 'reported', observedAt: new Date(NOW).toISOString(), usage: [], retryAfter: 60 });
    return true;
  });
});

test('Manual policy overrides genuine remote publishing scopes, page tokens and management tasks', async () => {
  const { api } = fixture({
    identities: { userId: '100', pageId: '200', instagramId: '300', adAccountId: 'act_400' }, tasks: ['MANAGE'],
    pages: [{ id: '200', name: 'Página sintética', tasks: ['MANAGE'], access_token: PAGE_TOKEN, instagram_business_account: { id: '300' }, business: { id: '500' }, whatsapp_number: '+570000000000' }]
  });
  const result = await api.validateConnection();
  assert.deepEqual(result.capabilities, { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false });
  assertPublic(result.evaluation);
});

test('Targeting and reach estimate cannot bypass granular account read authorization', async () => {
  const { api, requests } = fixture({ debug: { granular_scopes: [{ scope: 'ads_read', target_ids: ['401'] }, { scope: 'ads_management', target_ids: ['401'] }] } });
  await assert.rejects(() => api.searchTargeting({ kind: 'interest', q: 'Fitness' }), denied);
  await assert.rejects(() => api.estimateAudience({ spec: { targeting: { geo_locations: { countries: ['CO'] } } } }), denied);
  assert.equal(requests.some(request => request.path === 'search' || request.path.endsWith('/reachestimate')), false);
});
