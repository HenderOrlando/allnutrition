import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const CALLBACK_PATH = '/api/admin/assistant/oauth/callback';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 8192;

function failure(code = 'ASSISTANT_UNAVAILABLE') {
  const invalid = code === 'ASSISTANT_CREDENTIAL_INVALID';
  const error = new Error(invalid ? 'No se pudo autenticar con Google.' : 'Google no está disponible.');
  error.code = code;
  error.status = invalid ? 422 : 503;
  return error;
}
const invalid = () => failure('ASSISTANT_CREDENTIAL_INVALID');
const clientValue = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
const usableToken = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_BYTES && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const verifierValid = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
const fingerprintFor = (clientId, clientSecret, redirectUri) => createHash('sha256').update(JSON.stringify([clientId, clientSecret, redirectUri])).digest('hex');

function appOrigin(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\/[^/?#\\\s]+\/?$/.test(value)) throw failure();
  let url;
  try { url = new URL(value); } catch { throw failure(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw failure();
  return url.origin;
}

export function googleOAuthConfig(env = process.env) {
  const clientId = env.ASSISTANT_GOOGLE_CLIENT_ID ?? '';
  const clientSecret = env.ASSISTANT_GOOGLE_CLIENT_SECRET ?? '';
  const appUrl = env.APP_URL ?? '';
  if (clientId !== '' && !clientValue(clientId) || clientSecret !== '' && !clientValue(clientSecret)) throw failure();
  const redirectUri = appUrl === '' ? '' : `${appOrigin(appUrl)}${CALLBACK_PATH}`;
  const configured = Boolean(clientId && clientSecret && redirectUri);
  return Object.freeze({ clientId, clientSecret, redirectUri, fingerprint: fingerprintFor(clientId, clientSecret, redirectUri), configured });
}

function assertConfig(config) {
  if (!config || config.configured !== true || !clientValue(config.clientId) || !clientValue(config.clientSecret) || typeof config.redirectUri !== 'string') throw failure();
  let callback;
  try { callback = new URL(config.redirectUri); } catch { throw failure(); }
  if (config.redirectUri !== `${appOrigin(callback.origin)}${CALLBACK_PATH}` || config.fingerprint !== fingerprintFor(config.clientId, config.clientSecret, config.redirectUri)) throw failure();
}

export function googleAuthorizationUrl(config, { state, codeVerifier }) {
  assertConfig(config);
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(state) || !verifierValid(codeVerifier)) throw invalid();
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256'
  }).toString();
  return url.href;
}

// The deadline covers both headers and the streamed body, even for an injected fetch.
async function postForm(url, form, { signal, fetchImpl }) {
  const controller = new AbortController();
  let timer, reader, response;
  const abort = () => controller.abort();
  const stopped = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
  });
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, TIMEOUT_MS);
  if (signal?.aborted) abort();
  const operation = async () => {
    if (controller.signal.aborted) throw failure();
    response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(), redirect: 'error', signal: controller.signal
    });
    if (response.redirected || response.status >= 300 && response.status < 400 || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw failure();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw failure();
    const chunks = [];
    let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw failure();
        chunks.push(Buffer.from(value));
      }
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    let payload = null;
    try { payload = text === '' ? null : JSON.parse(text); } catch { /* Invalid provider JSON is never exposed. */ }
    return { status: response.status, payload };
  };
  try { return await Promise.race([operation(), stopped]); }
  catch { throw failure(); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    // Do not wait on a remote stream's cancellation to finish cleanup.
    try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch { /* Best effort. */ }
  }
}

function validateStatus({ status, payload }) {
  if (status >= 500 || status === 408 || status === 429) throw failure();
  if (status !== 200 || payload?.error) {
    const denied = status === 401 || status === 403 || ['invalid_grant', 'access_denied', 'invalid_token', 'insufficient_scope', 'invalid_client', 'unauthorized_client'].includes(payload?.error);
    throw denied ? invalid() : failure();
  }
}

function validScope(value) {
  return typeof value === 'string' && value.length <= 8192 && /^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value) && value.split(' ').includes(SCOPE);
}

function normalizedTokens(payload, previous = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const refreshToken = payload.refresh_token === undefined ? previous?.refreshToken : payload.refresh_token;
  const scope = payload.scope === undefined ? previous?.scope : payload.scope;
  if (!usableToken(payload.access_token) || !usableToken(refreshToken) || typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer' || typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0 || !validScope(scope)) throw invalid();
  const now = Date.now();
  const expiresAt = now + Math.floor(payload.expires_in * 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw invalid();
  return { accessToken: payload.access_token, refreshToken, expiresAt, scope };
}

async function cleanupRejectedTokens(payload, fetchImpl) {
  if (!payload || typeof payload !== 'object') return;
  const refreshToken = usableToken(payload.refresh_token) ? payload.refresh_token : undefined;
  const accessToken = usableToken(payload.access_token) ? payload.access_token : undefined;
  if (refreshToken || accessToken) await revokeGoogleToken({ refreshToken, accessToken }, { fetchImpl });
}

export async function exchangeGoogleCode(config, { code, codeVerifier, signal, fetchImpl = fetch }) {
  assertConfig(config);
  if (typeof code !== 'string' || code.length < 1 || code.length > 8192 || /[\x00-\x20\x7f]/.test(code) || !verifierValid(codeVerifier)) throw invalid();
  const result = await postForm(TOKEN_URL, new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
    grant_type: 'authorization_code', code, code_verifier: codeVerifier
  }), { signal, fetchImpl });
  try {
    validateStatus(result);
    return normalizedTokens(result.payload);
  } catch (error) {
    // No caller receives these newly issued credentials, so this adapter owns revocation.
    await cleanupRejectedTokens(result.payload, fetchImpl);
    throw error;
  }
}

export async function refreshGoogleToken(config, credentials, { signal, fetchImpl = fetch } = {}) {
  assertConfig(config);
  if (!usableToken(credentials?.refreshToken) || !validScope(credentials?.scope)) throw invalid();
  const result = await postForm(TOKEN_URL, new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret,
    grant_type: 'refresh_token', refresh_token: credentials.refreshToken
  }), { signal, fetchImpl });
  try {
    validateStatus(result);
    return normalizedTokens(result.payload, credentials);
  } catch (error) {
    await cleanupRejectedTokens(result.payload, fetchImpl);
    throw error;
  }
}

export async function revokeGoogleToken(credentials, { signal, fetchImpl = fetch } = {}) {
  try {
    const token = usableToken(credentials?.refreshToken) ? credentials.refreshToken : credentials?.accessToken;
    if (!usableToken(token)) return false;
    const result = await postForm(REVOKE_URL, new URLSearchParams({ token }), { signal, fetchImpl });
    return result.status === 200 || result.status === 400 && ['invalid_token', 'invalid_grant'].includes(result.payload?.error);
  } catch { return false; }
}
