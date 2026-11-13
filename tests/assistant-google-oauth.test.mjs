import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  googleOAuthConfig, googleAuthorizationUrl, exchangeGoogleCode,
  refreshGoogleToken, revokeGoogleToken
} from '../lib/assistant/google-oauth.mjs';

const scope = 'https://www.googleapis.com/auth/cloud-platform';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revokeEndpoint = 'https://oauth2.googleapis.com/revoke';
const env = {
  APP_URL: 'https://admin.example.test',
  ASSISTANT_GOOGLE_CLIENT_ID: 'SYNTHETIC-CLIENT.apps.googleusercontent.com',
  ASSISTANT_GOOGLE_CLIENT_SECRET: 'SYNTHETIC-CLIENT-SECRET'
};
const config = googleOAuthConfig(env);
const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const state = 'SYNTHETIC-STATE-00000000000000000000000000000000';
const exchangeOptions = fetchImpl => ({ code: 'SYNTHETIC-CODE', codeVerifier, fetchImpl });
const tokenPayload = (changes = {}) => ({
  access_token: 'SYNTHETIC-ACCESS-TOKEN', refresh_token: 'SYNTHETIC-REFRESH-TOKEN',
  token_type: 'Bearer', expires_in: 3600, scope, ...changes
});
const credentials = { accessToken: 'SYNTHETIC-OLD-ACCESS', refreshToken: 'SYNTHETIC-OLD-REFRESH', scope, expiresAt: 1 };
const invalidCode = 'ASSISTANT_CREDENTIAL_INVALID';
const unavailableCode = 'ASSISTANT_UNAVAILABLE';

function safeFailure(code, forbidden = []) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.status, code === invalidCode ? 422 : 503);
    for (const value of [...Object.values(env), 'SYNTHETIC-CODE', 'SYNTHETIC-REFRESH-TOKEN', 'SYNTHETIC-ACCESS-TOKEN', ...forbidden]) {
      assert.equal(`${error.message}\n${error.stack}`.includes(value), false);
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

function formRequest(input, init, expectedEndpoint) {
  assert.equal(input, expectedEndpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.headers.Accept, 'application/json');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
  assert.equal(new URL(input).search, '');
  return new URLSearchParams(init.body);
}

test('Google config is private, fixed to the app callback, and fenced by all credentials', () => {
  assert.deepEqual(Object.keys(config).sort(), ['clientId', 'clientSecret', 'configured', 'fingerprint', 'redirectUri']);
  assert.equal(config.configured, true);
  assert.equal(config.redirectUri, 'https://admin.example.test/api/admin/assistant/oauth/callback');
  assert.equal(config.fingerprint, createHash('sha256').update(JSON.stringify([config.clientId, config.clientSecret, config.redirectUri])).digest('hex'));
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(googleOAuthConfig({}), {
    clientId: '', clientSecret: '', redirectUri: '', configured: false,
    fingerprint: createHash('sha256').update(JSON.stringify(['', '', ''])).digest('hex')
  });
  for (const absent of Object.keys(env)) assert.equal(googleOAuthConfig({ ...env, [absent]: '' }).configured, false);
  for (const [key, value] of [
    ['ASSISTANT_GOOGLE_CLIENT_ID', 'another-client'],
    ['ASSISTANT_GOOGLE_CLIENT_SECRET', 'another-secret'],
    ['APP_URL', 'https://another.example.test']
  ]) assert.notEqual(googleOAuthConfig({ ...env, [key]: value }).fingerprint, config.fingerprint);
  assert.equal(googleOAuthConfig({ ...env, APP_URL: `${env.APP_URL}/` }).fingerprint, config.fingerprint);
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(googleOAuthConfig({ ...env, APP_URL: url }).redirectUri, `${url}/api/admin/assistant/oauth/callback`);
  }
  assert.deepEqual(googleOAuthConfig({ ...env, ASSISTANT_GOOGLE_TOKEN_URL: 'https://evil.example/token' }), config);
});

test('Malformed supplied config fails safely instead of authorizing an unsafe callback', () => {
  for (const APP_URL of [
    'http://admin.example.test', 'http://localhost.evil.example', 'ftp://admin.example.test',
    'https://user:password@admin.example.test', 'https://admin.example.test/path',
    'https://admin.example.test/?code=secret', 'https://admin.example.test/#fragment',
    'https://admin.example.test?', 'https://admin.example.test#',
    'https://admin.example.test/../', ' https://admin.example.test',
    'https://admin.example.test\\evil', 'not-a-url'
  ]) assert.throws(() => googleOAuthConfig({ ...env, APP_URL }), safeFailure(unavailableCode, ['password']));
  for (const value of ['bad\nsecret', 'has space', 'x'.repeat(4097), 123]) {
    assert.throws(() => googleOAuthConfig({ ...env, ASSISTANT_GOOGLE_CLIENT_SECRET: value }), safeFailure(unavailableCode));
  }
});

test('Authorization requests offline cloud access with state and RFC7636 S256 only', () => {
  const url = new URL(googleAuthorizationUrl(config, { state, codeVerifier }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope,
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256'
  });
  assert.equal(url.href.includes(config.clientSecret), false);
  assert.equal(url.href.includes(codeVerifier), false);
  assert.equal(url.searchParams.has('openid'), false);
  assert.equal(url.searchParams.has('email'), false);
  for (const options of [{ state: 'short', codeVerifier }, { state, codeVerifier: 'short' }, { state: `${state}&x=y`, codeVerifier }]) {
    assert.throws(() => googleAuthorizationUrl(config, options), safeFailure(invalidCode));
  }
});

test('Initial exchange sends fixed official form fields and returns normalized credentials', async () => {
  const before = Date.now();
  const result = await exchangeGoogleCode(config, exchangeOptions(async (input, init) => {
    const form = formRequest(input, init, tokenEndpoint);
    assert.deepEqual(Object.fromEntries(form), {
      client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: 'authorization_code',
      code: 'SYNTHETIC-CODE', code_verifier: codeVerifier
    });
    return Response.json(tokenPayload({ id_token: 'UNUSED-IDENTITY-TOKEN' }));
  }));
  assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'scope']);
  assert.equal(result.accessToken, 'SYNTHETIC-ACCESS-TOKEN');
  assert.equal(result.refreshToken, 'SYNTHETIC-REFRESH-TOKEN');
  assert.equal(result.scope, scope);
  assert.ok(result.expiresAt >= before + 3600000 && result.expiresAt <= Date.now() + 3600000);
});

test('Form encoding prevents code tampering and caller endpoint options cannot redirect credentials', async () => {
  const code = 'code&redirect_uri=https://evil.example/callback&client_secret=attacker';
  const result = await exchangeGoogleCode({ ...config, tokenEndpoint: 'https://evil.example/token' }, {
    code, codeVerifier, tokenUrl: 'https://evil.example/token',
    fetchImpl: async (input, init) => {
      const form = formRequest(input, init, tokenEndpoint);
      assert.equal(form.get('code'), code);
      assert.deepEqual(form.getAll('redirect_uri'), [config.redirectUri]);
      assert.deepEqual(form.getAll('client_secret'), [config.clientSecret]);
      return Response.json(tokenPayload());
    }
  });
  assert.equal(result.accessToken, 'SYNTHETIC-ACCESS-TOKEN');
  let calls = 0;
  for (const tampered of [
    { ...config, redirectUri: 'https://evil.example/api/admin/assistant/oauth/callback' },
    { ...config, clientId: 'attacker' }, { ...config, clientSecret: 'attacker' },
    { ...config, configured: false }
  ]) await assert.rejects(exchangeGoogleCode(tampered, exchangeOptions(async () => { calls++; })), safeFailure(unavailableCode));
  for (const bad of ['code\nheader', '', 'x'.repeat(8193)]) {
    await assert.rejects(exchangeGoogleCode(config, { code: bad, codeVerifier, fetchImpl: async () => { calls++; } }), safeFailure(invalidCode));
  }
  assert.equal(calls, 0);
});

test('Initial missing or insufficient scopes revoke the newly issued grant before rejection', async () => {
  for (const grantedScope of [undefined, '', 'https://www.googleapis.com/auth/userinfo.email', `${scope}.different`]) {
    const calls = [];
    const parent = new AbortController();
    let cleaned = false;
    await assert.rejects(exchangeGoogleCode(config, {
      ...exchangeOptions(async (input, init) => {
        calls.push(input);
        if (input === tokenEndpoint) return Response.json(tokenPayload({ scope: grantedScope }));
        const form = formRequest(input, init, revokeEndpoint);
        assert.equal(form.get('token'), 'SYNTHETIC-REFRESH-TOKEN');
        assert.notEqual(init.signal, parent.signal);
        parent.abort();
        assert.equal(init.signal.aborted, false);
        cleaned = true;
        return new Response(null, { status: 200 });
      }), signal: parent.signal
    }), safeFailure(invalidCode));
    assert.deepEqual(calls, [tokenEndpoint, revokeEndpoint]);
    assert.equal(cleaned, true);
  }
});

test('Malformed initial bundles revoke usable refresh or access credentials, never expose them', async () => {
  for (const changes of [
    { token_type: 'Basic' }, { token_type: undefined }, { expires_in: 0 },
    { expires_in: -1 }, { expires_in: '3600' }, { expires_in: 1e100 },
    { expires_in: null }, { expires_in: true }, { expires_in: { valueOf: null, toString: null } },
    { access_token: 'bad token' }, { access_token: 'x'.repeat(8193) },
    { refresh_token: undefined }, { refresh_token: 'bad token' }, { scope: [scope] }
  ]) {
    const payload = tokenPayload(changes);
    const revocations = [];
    await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async (input, init) => {
      if (input === tokenEndpoint) return Response.json(payload);
      revocations.push(formRequest(input, init, revokeEndpoint).get('token'));
      return new Response(null, { status: 200 });
    })), safeFailure(invalidCode));
    assert.deepEqual(revocations, [typeof payload.refresh_token === 'string' && !payload.refresh_token.includes(' ') ? payload.refresh_token : payload.access_token]);
  }
});

test('Malformed responses without usable credentials fail without attempting an invented revocation', async () => {
  for (const response of [Response.json({}), Response.json(null), Response.json([]), new Response('not-json')]) {
    let calls = 0;
    await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async input => {
      calls++;
      assert.equal(input, tokenEndpoint);
      return response;
    })), safeFailure(invalidCode));
    assert.equal(calls, 1);
  }
});

test('Refresh preserves omitted scope and refresh token and accepts rotation atomically', async () => {
  for (const rotate of [false, true]) {
    const result = await refreshGoogleToken(config, credentials, { fetchImpl: async (input, init) => {
      const form = formRequest(input, init, tokenEndpoint);
      assert.deepEqual(Object.fromEntries(form), {
        client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'refresh_token', refresh_token: credentials.refreshToken
      });
      return Response.json(tokenPayload({ refresh_token: rotate ? 'SYNTHETIC-ROTATED-REFRESH' : undefined, scope: undefined }));
    } });
    assert.equal(result.refreshToken, rotate ? 'SYNTHETIC-ROTATED-REFRESH' : credentials.refreshToken);
    assert.equal(result.scope, scope);
    assert.equal(result.accessToken, 'SYNTHETIC-ACCESS-TOKEN');
    assert.ok(result.expiresAt > Date.now());
    assert.equal(credentials.refreshToken, 'SYNTHETIC-OLD-REFRESH');
  }
  const additionalScope = `${scope} https://www.googleapis.com/auth/another`;
  const result = await refreshGoogleToken(config, credentials, { fetchImpl: async () => Response.json(tokenPayload({ scope: additionalScope })) });
  assert.equal(result.scope, additionalScope);
});

test('Scope loss on refresh revokes inaccessible rotated credentials before failing', async () => {
  const calls = [];
  await assert.rejects(refreshGoogleToken(config, credentials, { fetchImpl: async (input, init) => {
    calls.push(input);
    if (input === tokenEndpoint) return Response.json(tokenPayload({ refresh_token: 'SYNTHETIC-ROTATED-REFRESH', scope: '' }));
    assert.equal(formRequest(input, init, revokeEndpoint).get('token'), 'SYNTHETIC-ROTATED-REFRESH');
    return new Response(null, { status: 200 });
  } }), safeFailure(invalidCode));
  assert.deepEqual(calls, [tokenEndpoint, revokeEndpoint]);
});

test('Revoked and denied grants produce sanitized reconnect errors for exchange and refresh', async () => {
  for (const error of ['invalid_grant', 'access_denied', 'insufficient_scope', 'invalid_client']) {
    const fetchImpl = async () => Response.json({ error, error_description: 'PROVIDER-SECRET-CANARY https://evil.example/?code=SYNTHETIC-CODE' }, { status: 400 });
    await assert.rejects(exchangeGoogleCode(config, exchangeOptions(fetchImpl)), safeFailure(invalidCode, ['PROVIDER-SECRET-CANARY', 'evil.example']));
    await assert.rejects(refreshGoogleToken(config, credentials, { fetchImpl }), safeFailure(invalidCode, ['PROVIDER-SECRET-CANARY', 'evil.example']));
  }
});

test('Redirects are refused even if a fetch implementation reports a followed redirect', async () => {
  for (const response of [
    Response.redirect('https://evil.example/steal', 302),
    Object.defineProperty(Response.json(tokenPayload()), 'redirected', { value: true })
  ]) {
    let calls = 0;
    await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async (input, init) => {
      calls++;
      formRequest(input, init, tokenEndpoint);
      return response;
    })), safeFailure(unavailableCode, ['evil.example']));
    assert.equal(calls, 1);
  }
  assert.equal(await revokeGoogleToken(credentials, { fetchImpl: async () => Response.redirect('https://evil.example', 307) }), false);
});

test('Response byte bounds apply to streaming and declared body lengths', async () => {
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32768)); controller.enqueue(new Uint8Array(32769)); },
    cancel() { cancelled = true; }
  }));
  await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async () => oversized())), safeFailure(unavailableCode));
  assert.equal(cancelled, true);
  await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async () => new Response('{}', { headers: { 'content-length': '65537' } }))), safeFailure(unavailableCode));
  const payload = tokenPayload({ padding: '' });
  payload.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), 65536);
  const result = await exchangeGoogleCode(config, exchangeOptions(async () => Response.json(payload)));
  assert.equal(result.accessToken, 'SYNTHETIC-ACCESS-TOKEN');
});

test('Timeout bounds a fetch that never settles, independently of fetch cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const result = exchangeGoogleCode(config, exchangeOptions(async (_input, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  }));
  const rejected = assert.rejects(result, safeFailure(unavailableCode));
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('Timeout also bounds stalled response bodies', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const result = exchangeGoogleCode(config, exchangeOptions(async () => new Response(new ReadableStream({
    pull() { reading(); return new Promise(() => {}); }
  }))));
  const rejected = assert.rejects(result, safeFailure(unavailableCode));
  await started;
  context.mock.timers.tick(10_000);
  await rejected;
});

test('Aborted requests and network/provider failures are sanitized and unavailable', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(exchangeGoogleCode(config, { ...exchangeOptions(async () => { calls++; }), signal: controller.signal }), safeFailure(unavailableCode));
  assert.equal(calls, 0);
  for (const fetchImpl of [
    async () => { throw new Error('NETWORK-SECRET-CANARY'); },
    async () => Response.json({ error: 'invalid_grant', error_description: 'PROVIDER-SECRET-CANARY' }, { status: 503 }),
    async () => new Response('PROVIDER-SECRET-CANARY', { status: 429 })
  ]) {
    await assert.rejects(exchangeGoogleCode(config, exchangeOptions(fetchImpl)), safeFailure(unavailableCode, ['NETWORK-SECRET-CANARY', 'PROVIDER-SECRET-CANARY']));
  }
});

test('Failed cleanup does not turn rejected credentials into a successful exchange', async () => {
  let revocations = 0;
  await assert.rejects(exchangeGoogleCode(config, exchangeOptions(async input => {
    if (input === tokenEndpoint) return Response.json(tokenPayload({ scope: '' }));
    revocations++;
    throw new Error('REVOKE-SECRET-CANARY');
  })), safeFailure(invalidCode, ['REVOKE-SECRET-CANARY']));
  assert.equal(revocations, 1);
});

test('Revocation uses refresh token first, supports access-only and already-invalid grants, and never throws', async () => {
  for (const [bundle, token] of [[credentials, credentials.refreshToken], [{ accessToken: credentials.accessToken }, credentials.accessToken]]) {
    assert.equal(await revokeGoogleToken(bundle, { fetchImpl: async (input, init) => {
      assert.deepEqual(Object.fromEntries(formRequest(input, init, revokeEndpoint)), { token });
      return new Response(null, { status: 200 });
    } }), true);
  }
  for (const error of ['invalid_token', 'invalid_grant']) {
    assert.equal(await revokeGoogleToken(credentials, { fetchImpl: async () => Response.json({ error, error_description: 'IGNORED-SECRET' }, { status: 400 }) }), true);
  }
  for (const fetchImpl of [
    async () => { throw new Error('NETWORK-SECRET'); },
    async () => new Response('SECRET', { status: 503 }),
    async () => Response.json({ error: 'invalid_request' }, { status: 400 })
  ]) assert.equal(await revokeGoogleToken(credentials, { fetchImpl }), false);
  let calls = 0;
  assert.equal(await revokeGoogleToken({}, { fetchImpl: async () => { calls++; } }), false);
  assert.equal(calls, 0);
});
