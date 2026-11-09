import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AppError, fail } from '../validation-core.mjs';
import { SOCIAL_ERROR_MESSAGES } from './evidence.mjs';

export const BROWSER_COMMANDS = Object.freeze(['open', 'frame', 'input', 'inspect', 'export-state', 'renew', 'close', 'preflight', 'execute', 'measure']);
export const BROWSER_BODY_LIMIT = 10 * 1024 * 1024;
export function browserSignature(key, method, path, timestamp, nonce, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', key).update(`${method}\n${path}\n${timestamp}\n${nonce}\n${digest}`).digest('hex');
}
export class BrowserControlError extends AppError {
  constructor(errorCode, { uncertain = false } = {}) {
    super(SOCIAL_ERROR_MESSAGES[errorCode] || SOCIAL_ERROR_MESSAGES.AUTH_FAILED, ['BROWSER_BUSY', 'LEASE_LOST', 'SPEC_MISMATCH', 'PUBLISHING_DISABLED', 'CONFIGURATION_CHANGED'].includes(errorCode) ? 409 : 502);
    this.name = 'BrowserControlError'; this.errorCode = errorCode; this.uncertain = uncertain;
  }
}
async function responseBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new BrowserControlError('AUTH_FAILED'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new BrowserControlError('AUTH_FAILED'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally { reader.releaseLock(); }
}
export function createBrowserClient({ baseUrl, controlKey, runtime, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('URL del runner privado no válida.', 409);
  const key = Buffer.isBuffer(controlKey) ? controlKey : Buffer.from(controlKey || '', 'base64');
  if (key.length !== 32) fail('Clave de control del navegador no válida.', 409);
  function configuration(value) {
    if (!Number.isSafeInteger(value?.configurationVersion) || value.configurationVersion < 0 || typeof value.publishingEnabled !== 'boolean' || typeof value.browserEnabled !== 'boolean') fail('Configuración del navegador no válida.', 409);
    return Object.freeze({ configurationVersion: value.configurationVersion, publishingEnabled: value.publishingEnabled, browserEnabled: value.browserEnabled });
  }
  const captured = configuration(runtime);
  async function control(command, { connectionId, sessionEpoch, lease, payload = {}, signal, runtime: override } = {}) {
    if (!BROWSER_COMMANDS.includes(command)) fail('Comando del navegador no válido.');
    if (!connectionId || !Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0 || !lease?.key || !lease?.token || !lease?.leaseUntil) fail('La operación de navegador requiere una sesión exclusiva vigente.', 409);
    const body = JSON.stringify({ command, ...configuration(override || captured), connectionId, sessionEpoch, lease: { key: lease.key, token: lease.token, leaseUntil: lease.leaseUntil }, payload });
    if (Buffer.byteLength(body) > BROWSER_BODY_LIMIT || command === 'input' && Buffer.byteLength(JSON.stringify(payload)) > 4096) fail('Comando de navegador demasiado grande.', 413);
    const time = String(Date.now()), nonce = randomBytes(32).toString('base64url');
    const headers = { 'content-type': 'application/json', 'x-social-time': time, 'x-social-nonce': nonce, 'x-social-signature': browserSignature(key, 'POST', '/control', time, nonce, body) };
    if (signal?.aborted) throw new BrowserControlError('TIMEOUT');
    let response;
    try { response = await fetchImpl(new URL('/control', base), { method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) }); }
    catch { throw new BrowserControlError(command === 'execute' || command === 'preflight' ? 'OPERATION_UNCERTAIN' : 'TIMEOUT', { uncertain: command === 'execute' || command === 'preflight' }); }
    let bytes;
    try { bytes = await responseBytes(response, BROWSER_BODY_LIMIT); }
    catch { throw new BrowserControlError(command === 'execute' || command === 'preflight' ? 'OPERATION_UNCERTAIN' : 'AUTH_FAILED', { uncertain: command === 'execute' || command === 'preflight' }); }
    if (command === 'frame' && response.ok && response.headers.get('content-type')?.startsWith('image/jpeg')) return bytes;
    let result;
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new BrowserControlError(command === 'execute' || command === 'preflight' ? 'OPERATION_UNCERTAIN' : 'AUTH_FAILED', { uncertain: command === 'execute' || command === 'preflight' }); }
    if (!response.ok || result.errorCode) {
      const code = Object.hasOwn(SOCIAL_ERROR_MESSAGES, result.errorCode) ? result.errorCode : 'AUTH_FAILED';
      throw new BrowserControlError(code, { uncertain: code === 'OPERATION_UNCERTAIN' });
    }
    if (!['confirmed', 'pending', 'blocked', 'uncertain', 'ok'].includes(result.status)) throw new BrowserControlError(command === 'execute' || command === 'preflight' ? 'OPERATION_UNCERTAIN' : 'AUTH_FAILED', { uncertain: command === 'execute' || command === 'preflight' });
    return result;
  }
  const client = { control, async health({ signal } = {}) {
    try { const response = await fetchImpl(new URL('/health', base), { redirect: 'error', signal: signal || AbortSignal.timeout(5000) }); const bytes = await responseBytes(response, 1024); return response.ok && JSON.parse(bytes).available === true; } catch { return false; }
  }, forSession(session) {
    return { ...client, control: (command, options) => control(command, { ...options, ...session }), ...Object.fromEntries(BROWSER_COMMANDS.map(command => [command.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), options => control(command, { ...options, ...session })])) };
  } };
  for (const command of BROWSER_COMMANDS) client[command.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = options => control(command, options);
  return client;
}
