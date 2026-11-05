import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMetaClient, createMetaApiConnector, MetaApiError, metaBudgetUnits } from '../lib/social/meta.mjs';

const TOKEN = 'SYNTHETIC-USER-TOKEN-CANARY';
const SECRET = 'SYNTHETIC-APP-SECRET-CANARY';
const PAGE_TOKEN = 'SYNTHETIC-PAGE-TOKEN-CANARY';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const EXPIRY = Math.floor(NOW / 1000) + 3600;
const PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'ads_read', 'ads_management', 'pages_manage_ads'];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const client = fetchImpl => createMetaClient({ accessToken: TOKEN, appSecret: SECRET, fetchImpl });
const isError = (kind, extra = {}) => error => {
  assert.ok(error instanceof MetaApiError);
  assert.equal(error.kind, kind);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value);
  assert.equal(`${error.message}\n${JSON.stringify(error)}`.includes(TOKEN), false);
  assert.equal(`${error.message}\n${JSON.stringify(error)}`.includes(SECRET), false);
  return true;
};

function provider(options = {}) {
  const calls = [];
  const debug = { app_id: '42', type: 'USER', is_valid: true, user_id: '100', expires_at: EXPIRY, data_access_expires_at: EXPIRY + 3600, scopes: PERMISSIONS, ...options.debug };
  const pages = options.pages ?? [
    { id: '200', name: 'Página de prueba', tasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'], access_token: PAGE_TOKEN, business: { id: '500', name: 'Negocio de prueba' }, instagram_business_account: { id: '300', username: 'cuenta_prueba' }, whatsapp_number: '+570000000000' },
    { id: '201', name: 'Página solo lectura', tasks: ['ANALYZE'], access_token: 'SYNTHETIC-READ-ONLY-PAGE-TOKEN', business: { id: '500', name: 'Negocio de prueba' } }
  ];
  const adAccounts = options.adAccounts ?? [{ id: 'act_400', name: 'Anuncios de prueba', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: ['ADVERTISE', 'ANALYZE'], business: { id: '500', name: 'Negocio de prueba' } }];
  const fetchImpl = async (href, init) => {
    const url = new URL(href), path = url.pathname.replace('/v26.0/', '');
    calls.push({ url, init });
    assert.equal(url.hostname, 'graph.facebook.com');
    assert.equal(init.redirect, 'manual');
    if (path === 'debug_token') return json({ data: debug });
    if (path === 'me' && init.method === 'GET') return json({ id: '100', name: 'Administrador sintético' });
    if (path === 'me/permissions' && init.method === 'GET') return json({ data: (options.permissions ?? PERMISSIONS).map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me/permissions' && init.method === 'DELETE') return json({ success: true });
    if (path === 'me/accounts') {
      if (options.pagesDenied) return json({ error: { code: 200, message: `${TOKEN} ${SECRET}` } }, 403);
      if (url.searchParams.has('after')) return json({ data: pages.slice(1) });
      return json({ data: pages.slice(0, 1), ...(pages.length > 1 ? { paging: { next: `https://graph.facebook.com/v26.0/me/accounts?after=next&access_token=${PAGE_TOKEN}` } } : {}) });
    }
    if (path === 'me/adaccounts') return json({ data: adAccounts });
    if (path === 'act_400/reachestimate') return json({ data: [options.estimate ?? { users_lower_bound: 1000, users_upper_bound: 2500, estimate_ready: true }] });
    if (path === 'search') {
      if (url.searchParams.get('type') === 'adinterest') return json({ data: [{ id: '900', name: 'Fitness', path: ['Intereses', 'Deporte'] }, { id: 'untrusted', name: 'No válido' }] });
      return json({ data: [{ key: 'CO', name: 'Colombia', type: 'country', country_code: 'CO' }, { key: '11001', name: 'Bogotá', type: 'city', country_code: 'CO', region: 'Bogotá D.C.', region_id: '1' }, { key: 'unknown', type: 'postal_code', name: 'No permitido' }] });
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  return { fetchImpl, calls };
}
function connector(options = {}, identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' }) {
  const fixture = provider(options);
  return { ...fixture, api: createMetaApiConnector({ connection: { integrationMethod: 'api', identities }, credentials: { accessToken: TOKEN, userId: '100' }, transport: { ...fixture, appId: '42', appSecret: SECRET, now: NOW } }) };
}

test('Meta uses server headers, proof and form encoding without token query parameters', async () => {
  const calls = [];
  const api = client(async (url, init) => { calls.push({ url: new URL(url), init }); return json({ id: '700' }); });
  await api.get('me', { fields: 'id' });
  await api.post('700', { status: 'PAUSED', targeting: { age_min: 18 } });
  const proof = createHmac('sha256', SECRET).update(TOKEN).digest('hex');
  for (const { url, init } of calls) {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(init.redirect, 'manual');
  }
  assert.equal(calls[0].url.pathname, '/v26.0/me');
  assert.equal(calls[0].url.searchParams.get('appsecret_proof'), proof);
  const form = new URLSearchParams(calls[1].init.body);
  assert.equal(form.get('appsecret_proof'), proof);
  assert.equal(form.get('status'), 'PAUSED');
  assert.deepEqual(JSON.parse(form.get('targeting')), { age_min: 18 });
  await assert.rejects(() => api.get('me', { access_token: TOKEN }), { status: 400 });
});

test('Meta rejects external, non HTTPS, credentialed and nonstandard-port hosts before fetching', async () => {
  let fetched = 0;
  const api = client(async () => { fetched++; return json({}); });
  for (const url of ['https://graph.facebook.com.evil.test/me', 'http://graph.facebook.com/me', 'https://127.0.0.1/me', 'https://graph.facebook.com:444/me', 'https://user:pass@graph.facebook.com/me', 'https://facebook.com/me', 'https://graph.facebook.com/me#secret']) {
    await assert.rejects(() => api.get(url), isError('unsafe_url'));
  }
  assert.equal(fetched, 0);
});

test('Meta follows only allowlisted read redirects and never replays a redirected write', async () => {
  const calls = [];
  const api = client(async (href, init) => {
    calls.push({ href, method: init.method });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://graph-video.facebook.com/v26.0/700?access_token=FOREIGN-TOKEN' } }) : json({ id: '700' });
  });
  assert.equal((await api.get('700')).id, '700');
  assert.equal(new URL(calls[1].href).hostname, 'graph-video.facebook.com');
  assert.equal(new URL(calls[1].href).searchParams.has('access_token'), false);
  let writes = 0;
  const write = client(async () => { writes++; return new Response(null, { status: 307, headers: { location: 'https://graph.facebook.com/v26.0/701' } }); });
  await assert.rejects(() => write.post('700', { status: 'ACTIVE' }), isError('invalid_response', { uncertain: true, retryable: false }));
  assert.equal(writes, 1);
  let external = 0;
  const bad = client(async () => { external++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/capture' } }); });
  await assert.rejects(() => bad.get('700'), isError('unsafe_url'));
  assert.equal(external, 1);
});

test('Meta pagination rejects external continuations, cycles and incomplete rows', async () => {
  let fetched = 0;
  const api = client(async () => { fetched++; return json({ data: [{ id: '1' }], paging: { next: `https://evil.test/?access_token=${TOKEN}` } }); });
  await assert.rejects(() => api.pages('me/accounts'), isError('unsafe_url'));
  assert.equal(fetched, 1);
  const cycle = client(async () => json({ data: [], paging: { next: 'https://graph.facebook.com/v26.0/me/accounts' } }));
  await assert.rejects(() => cycle.pages('me/accounts'), isError('invalid_response'));
  await assert.rejects(() => client(async () => json({ unexpected: [] })).pages('me/accounts'), isError('invalid_response'));
});

test('Meta sanitizes provider errors and distinguishes rate limit, permission and expired token', async () => {
  const cases = [[190, 400, 'reconnect_required'], [200, 403, 'permission'], [4, 400, 'rate_limit'], [null, 429, 'rate_limit'], [null, 503, 'unavailable']];
  for (const [code, status, kind] of cases) {
    const api = client(async () => json({ error: { code, message: `Unsafe ${TOKEN} ${SECRET}`, error_user_msg: PAGE_TOKEN, fbtrace_id: TOKEN } }, status, { 'retry-after': '120' }));
    await assert.rejects(() => api.get('me'), error => {
      isError(kind, { retryAfter: 120, uncertain: false })(error);
      assert.equal(JSON.stringify(error).includes(PAGE_TOKEN), false);
      return true;
    });
  }
});

test('Meta never marks an unacknowledged POST safe to retry', async () => {
  const lost = client(async () => { throw new Error(`${TOKEN} ${SECRET}`); });
  await assert.rejects(() => lost.post('700', { status: 'ACTIVE' }), isError('transport', { uncertain: true, retryable: false }));
  await assert.rejects(() => lost.get('700'), isError('transport', { uncertain: false, retryable: true }));
  const invalid = client(async () => new Response(TOKEN, { status: 200 }));
  await assert.rejects(() => invalid.post('700'), isError('invalid_response', { uncertain: true }));
  const failure = client(async () => json({ error: { code: 2 } }, 500));
  await assert.rejects(() => failure.post('700'), isError('unavailable', { uncertain: true, retryable: false }));
  const rejected = client(async () => json({ error: { code: 200 } }, 403));
  await assert.rejects(() => rejected.post('700'), isError('permission', { uncertain: false }));
});

test('Meta limits declared and streamed responses, and aborts before sending', async () => {
  const oversized = client(async () => new Response('{}', { headers: { 'content-length': '2097153' } }));
  await assert.rejects(() => oversized.get('me'), isError('invalid_response'));
  const streamed = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2097153)); controller.close(); } })));
  await assert.rejects(() => streamed.get('me'), isError('invalid_response'));
  let sent = false;
  const api = client(async () => { sent = true; return json({}); });
  await assert.rejects(() => api.post('700', {}, { signal: AbortSignal.abort() }), isError('aborted', { uncertain: false }));
  assert.equal(sent, false);
});

test('Meta exchanges a code and then a user token without inventing a refresh token', async () => {
  const calls = [];
  const api = createMetaClient({ appSecret: SECRET, fetchImpl: async (href, init) => {
    const url = new URL(href);
    calls.push({ url, init });
    assert.equal(url.pathname, '/v26.0/oauth/access_token');
    return url.searchParams.get('grant_type') === 'fb_exchange_token' ? json({ access_token: 'LONG-LIVED-SYNTHETIC', expires_in: 5184000 }) : json({ access_token: 'SHORT-SYNTHETIC', expires_in: 3600 });
  } });
  const short = await api.exchangeCode({ code: 'SYNTHETIC-CODE', appId: '42', redirectUri: 'https://app.example/api/admin/social/oauth/callback' });
  const long = await api.exchangeLongLivedToken({ accessToken: short.accessToken, appId: '42' });
  assert.equal(long.accessToken, 'LONG-LIVED-SYNTHETIC');
  assert.ok(Date.parse(long.expiresAt) > Date.parse(short.expiresAt));
  assert.equal('refreshToken' in long, false);
  assert.equal(calls[0].url.searchParams.get('client_id'), '42');
  assert.equal(calls[0].url.searchParams.get('redirect_uri'), 'https://app.example/api/admin/social/oauth/callback');
  assert.equal(calls[1].url.searchParams.get('fb_exchange_token'), short.accessToken);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const bad = client(async () => json({ access_token: TOKEN }));
  await assert.rejects(() => bad.exchangeCode({ code: 'x', appId: '42', redirectUri: 'https://app.example/callback' }), isError('invalid_response'));
});

test('Meta debug validates app, token type, user, actual expiration and data-access expiration', async () => {
  const good = provider();
  const result = await client(good.fetchImpl).debugToken({ appId: '42', expectedUserId: '100', now: NOW });
  assert.equal(result.expiresAt, new Date(EXPIRY * 1000).toISOString());
  assert.equal(result.dataAccessExpiresAt, new Date((EXPIRY + 3600) * 1000).toISOString());
  const authorization = good.calls[0].init.headers.Authorization;
  assert.equal(authorization, `Bearer 42|${SECRET}`);
  for (const debug of [{ is_valid: false }, { app_id: 'wrong-app' }, { type: 'PAGE' }, { user_id: '' }, { expires_at: Math.floor(NOW / 1000) }, { data_access_expires_at: Math.floor(NOW / 1000) - 1 }]) {
    await assert.rejects(() => client(provider({ debug }).fetchImpl).debugToken({ appId: '42', now: NOW }), isError('reconnect_required'));
  }
  await assert.rejects(() => client(provider().fetchImpl).debugToken({ appId: '42', expectedUserId: '101', now: NOW }), isError('account_mismatch'));
});

test('Meta discovers resources over every page and separates page tokens from public capabilities', async () => {
  const { api, calls } = connector();
  const result = await api.validateConnection();
  assert.equal(result.state, 'connected');
  assert.deepEqual(result.identities, { userId: '100', userName: 'Administrador sintético', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' });
  assert.deepEqual(result.capabilities, { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true });
  assert.equal(result.resources.pages.length, 2);
  assert.equal(result.currency, 'COP');
  assert.equal(result.timeZone, 'America/Bogota');
  assert.equal(result.credentials.pageTokens['200'], PAGE_TOKEN);
  const { credentials, ...dto } = result;
  for (const canary of [TOKEN, PAGE_TOKEN, SECRET]) assert.equal(JSON.stringify(dto).includes(canary), false);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/me/accounts')).length, 2);
  assert.equal(calls.find(call => call.url.searchParams.has('after')).url.searchParams.has('access_token'), false);
});

test('Meta preserves independent capabilities when account, tasks or optional permissions are unavailable', async () => {
  const noAds = connector({ adAccounts: [{ id: 'act_400', name: 'Deshabilitada', currency: 'COP', timezone_name: 'America/Bogota', account_status: 2, business: { id: '500', name: 'Negocio' } }] });
  assert.deepEqual((await noAds.api.validateConnection()).capabilities, { facebookPublish: true, instagramPublish: true, adsPublish: false, insights: true, whatsappAds: false });
  const noIg = connector({ permissions: PERMISSIONS.filter(scope => scope !== 'instagram_content_publish') });
  const capabilities = (await noIg.api.validateConnection()).capabilities;
  assert.equal(capabilities.facebookPublish, true);
  assert.equal(capabilities.instagramPublish, false);
  assert.equal(capabilities.adsPublish, true);
  const readOnly = connector({}, { userId: '100', businessId: '500', pageId: '201' });
  assert.deepEqual((await readOnly.api.validateConnection()).capabilities, { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false });
  const noPages = connector({ pagesDenied: true }, { userId: '100', adAccountId: '400' });
  assert.deepEqual((await noPages.api.validateConnection()).capabilities, { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false });
});

test('Meta no acredita pauta por permiso de app si el usuario no puede anunciar en la cuenta', async () => {
  for (const tasks of [['ANALYZE'], [], undefined]) {
    const account = { id: 'act_400', name: 'Cuenta analista', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, business: { id: '500' }, ...(tasks ? { user_tasks: tasks } : {}) };
    const status = await connector({ adAccounts: [account] }).api.validateConnection();
    assert.equal(status.capabilities.adsPublish, false);
    assert.equal(status.capabilities.whatsappAds, false);
    assert.equal(status.capabilities.facebookPublish, true);
  }
});

test('Meta requires chosen resources and linked Instagram to belong to the verified user/business', async () => {
  for (const identities of [
    { userId: '101' }, { pageId: '999' }, { adAccountId: '999' }, { pageId: '200', instagramId: '999' }, { businessId: '999' },
    { businessId: '500', pageId: '200', adAccountId: '400' }
  ]) {
    const options = identities.adAccountId === '400' ? { adAccounts: [{ id: 'act_400', name: 'Otro negocio', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, business: { id: '501', name: 'Otro' } }] } : {};
    await assert.rejects(() => connector(options, identities).api.validateConnection(), isError('account_mismatch'));
  }
  const scoped = connector({ debug: { granular_scopes: [{ scope: 'pages_manage_posts', target_ids: ['201'] }] } });
  const capabilities = (await scoped.api.validateConnection()).capabilities;
  assert.equal(capabilities.facebookPublish, false);
  assert.equal(capabilities.instagramPublish, true);
});

test('Meta connects a valid user with no eligible resources without fabricating accounts', async () => {
  const { api } = connector({ pages: [], adAccounts: [] }, {});
  const result = await api.validateConnection();
  assert.equal(result.state, 'connected');
  assert.deepEqual(result.resources, { businesses: [], pages: [], adAccounts: [] });
  assert.deepEqual(result.capabilities, { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: false, whatsappAds: false });
});

test('Meta reach estimate means potential audience and -1 or not-ready means unavailable, not zero', async () => {
  const spec = { targeting: { geo_locations: { countries: ['CO'] }, age_min: 18 } };
  const normal = await connector().api.estimateAudience({ spec });
  assert.equal(normal.definition, 'potential_audience');
  assert.equal(normal.lower, 1000);
  assert.equal(normal.upper, 2500);
  for (const estimate of [{ users_lower_bound: -1, users_upper_bound: -1 }, { users_lower_bound: 0, users_upper_bound: 100, estimate_ready: false }, {}]) {
    const result = await connector({ estimate }).api.estimateAudience({ spec });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  }
  const zero = await connector({ estimate: { users_lower_bound: 0, users_upper_bound: 0, estimate_ready: true } }).api.estimateAudience({ spec });
  assert.equal(zero.lower, 0);
  assert.equal(zero.status, 'reported');
});

test('Meta targeting returns only supported official candidates after verifying account ownership', async () => {
  const { api, calls } = connector();
  const locations = await api.searchTargeting({ kind: 'location', q: 'Colombia' });
  assert.deepEqual(locations.map(row => [row.source, row.providerId, row.context.type]), [['api', 'CO', 'country'], ['api', '11001', 'city']]);
  const interests = await api.searchTargeting({ kind: 'interest', q: 'Fitness' });
  assert.deepEqual(interests, [{ key: 'api:interest:900', source: 'api', providerId: '900', label: 'Fitness', context: { type: 'interest', path: ['Intereses', 'Deporte'] } }]);
  assert.deepEqual(JSON.parse(calls.find(call => call.url.searchParams.get('type') === 'adgeolocation').url.searchParams.get('location_types')), ['country', 'region', 'city']);
  const foreign = connector({}, { adAccountId: '999' });
  await assert.rejects(() => foreign.api.searchTargeting({ kind: 'interest', q: 'Fitness' }), isError('account_mismatch'));
  assert.equal(foreign.calls.some(call => call.url.pathname.endsWith('/search')), false);
});

test('Meta currency conversion uses verified offsets exactly and never rounds COP', () => {
  assert.equal(metaBudgetUnits(5000000, 'COP'), 50000);
  assert.equal(metaBudgetUnits(5000, 'USD'), 5000);
  assert.equal(metaBudgetUnits(0, 'COP'), 0);
  assert.equal(metaBudgetUnits(Number.MAX_SAFE_INTEGER, 'USD'), Number.MAX_SAFE_INTEGER);
  for (const [value, currency] of [[5000001, 'COP'], [100, 'ZZZ'], [-1, 'USD'], [1.2, 'USD'], [Number.MAX_SAFE_INTEGER + 1, 'USD'], [NaN, 'COP']]) assert.throws(() => metaBudgetUnits(value, currency), { status: 400 });
});

test('Meta disconnect confirms revocation and never claims remote ads stopped spending', async () => {
  const { api, calls } = connector();
  assert.deepEqual(await api.disconnect(), { revoked: true });
  const request = calls.at(-1);
  assert.equal(request.init.method, 'DELETE');
  assert.equal(request.url.pathname, '/v26.0/me/permissions');
  assert.equal(calls.some(call => call.url.pathname.includes('campaign')), false);
});

test('Meta streams native upload bytes and offset headers without replay or arbitrary headers', async () => {
  const bytes = new Uint8Array([1, 2, 3]), calls = [];
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const api = client(async (href, init) => {
    calls.push({ url: new URL(href), init });
    if (init.method === 'GET') return json({ start_offset: '3', end_offset: '3' });
    assert.equal(init.body, stream);
    assert.equal(init.duplex, 'half');
    assert.equal(init.headers.offset, '0');
    assert.equal(init.headers.file_size, '3');
    const received = new Uint8Array(await new Response(init.body).arrayBuffer());
    assert.deepEqual(received, bytes);
    return json({ success: true, start_offset: '3', end_offset: '3' });
  });
  const result = await api.upload('https://rupload.facebook.com/video-upload/v26.0/700', { body: stream, headers: { offset: '0', file_size: '3' } });
  assert.equal(result.start_offset, '3');
  assert.equal(calls[0].init.headers.Authorization, `OAuth ${TOKEN}`);
  assert.equal(calls[0].url.searchParams.get('appsecret_proof'), createHmac('sha256', SECRET).update(TOKEN).digest('hex'));
  assert.equal((await api.get('https://graph-video.facebook.com/v26.0/700', { fields: 'status' })).end_offset, '3');
  await assert.rejects(() => api.upload('https://rupload.facebook.com/700', { body: bytes, headers: { Authorization: 'OVERRIDE' } }), { status: 400 });
  await assert.rejects(() => api.upload('https://evil.test/700', { body: bytes }), isError('unsafe_url'));
  assert.equal(calls.length, 2);
});

test('Meta preserves rate-limit classification even when the provider returns non-JSON', async () => {
  const api = client(async () => new Response(TOKEN, { status: 429, headers: { 'retry-after': '300' } }));
  await assert.rejects(() => api.get('me'), isError('rate_limit', { retryAfter: 300, retryable: true }));
});
