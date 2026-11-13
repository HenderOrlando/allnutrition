import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { isPublicAddress } from '../integrations/network.mjs';
import { ASSISTANT_LIMITS } from './limits.mjs';

const MAX_RESPONSE = 1024 * 1024;
const TIMEOUT = ASSISTANT_LIMITS.extended.providerMs;
const hostname = url => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const isLoopback = address => address === '::1' || /^127\./.test(address);
const validSecret = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\r\n\0]/.test(value);
const validProject = value => typeof value === 'string' && value.trim() === value && (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value) || /^[0-9]{1,30}$/.test(value));
const geminiEndpoint = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}:generateContent$/;
function privateAllowed(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 127;
  }
  return address === '::1' || /^f[cd][0-9a-f]{2}:/i.test(address);
}
function safeError(code = 'ASSISTANT_UNAVAILABLE') {
  const error = new Error(code === 'ASSISTANT_CREDENTIAL_INVALID' ? 'No se pudo autenticar con el proveedor.' : 'El proveedor no está disponible.');
  error.code = code; error.status = code === 'ASSISTANT_CREDENTIAL_INVALID' ? 422 : 503; return error;
}
async function addressesFor(url, lookup) {
  const host = hostname(url), family = isIP(host);
  if (family) return [{ address: host, family }];
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    if (!Array.isArray(answers)) throw safeError();
    return answers.map(item => {
      if (!isIP(item?.address || '')) throw safeError();
      const address = isIP(item.address) === 6 ? hostname(new URL(`https://[${item.address}]/`)) : item.address;
      return { address, family: isIP(address) };
    });
  } catch { throw safeError(); }
}
export async function resolveAssistantEndpoint(raw, { provider, allowPrivateNetwork = false, env = process.env, lookup = dnsLookup } = {}) {
  let url; try { url = new URL(raw); } catch { throw safeError(); }
  if (!['openai','openai-compatible','gemini'].includes(provider) || url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol)) throw safeError();
  if (provider === 'openai' && (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses')) throw safeError();
  if (provider === 'gemini' && (typeof raw !== 'string' || raw !== url.href || !geminiEndpoint.test(raw))) throw safeError();
  const addresses = await addressesFor(url, lookup);
  if (!addresses.length || addresses.some(item => {
    const address = item.address?.toLowerCase();
    // Provider-controlled DNS cannot opt into metadata, even where a cloud
    // metadata address happens to fall inside ULA or public-looking space.
    return !isIP(address || '') || address === '168.63.129.16' || address === 'fd00:ec2::254' || address.startsWith('192.88.99.') || !isPublicAddress(address) && !(provider === 'openai-compatible' && allowPrivateNetwork && privateAllowed(address));
  })) throw safeError();
  if (url.protocol === 'http:' && !(provider === 'openai-compatible' && allowPrivateNetwork && addresses.every(item => isLoopback(item.address)))) throw safeError();
  if (env.APP_URL) {
    let own; try { own = new URL(env.APP_URL); } catch { throw safeError(); }
    if (own.origin === url.origin) throw safeError();
    if (own.protocol === url.protocol && (own.port || (own.protocol === 'https:' ? '443' : '80')) === (url.port || (url.protocol === 'https:' ? '443' : '80'))) {
      const ownAddresses = await addressesFor(own, lookup);
      if (addresses.some(item => ownAddresses.some(other => other.address === item.address || isLoopback(other.address) && isLoopback(item.address)))) throw safeError();
    }
  }
  return { url, addresses };
}
export async function assistantRequest(urlString, { method = 'POST', body, apiKey, accessToken, projectId, authMethod = 'api-key', provider, allowPrivateNetwork, signal, env, lookup = dnsLookup, timeoutMs = TIMEOUT, maxResponseBytes = MAX_RESPONSE, requestImpl } = {}) {
  if (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > MAX_RESPONSE || !Number.isFinite(timeoutMs) || !Number.isFinite(maxResponseBytes) || apiKey != null && (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > 4096 || /[\r\n\0]/.test(apiKey))) throw safeError();
  if (provider === 'gemini') {
    if (authMethod === 'oauth' ? !validSecret(accessToken, 8192) || apiKey != null || !validProject(projectId) : authMethod !== 'api-key' || !validSecret(apiKey, 4096) || accessToken != null || projectId != null) throw safeError('ASSISTANT_CREDENTIAL_INVALID');
  } else if (accessToken != null || projectId != null || authMethod !== 'api-key') throw safeError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, Math.min(TIMEOUT, Math.max(1, timeoutMs)));
  if (signal?.aborted) cancel();
  let request;
  const aborted = new Promise((_, reject) => {
    const abort = () => { request?.destroy(); reject(safeError()); };
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  try {
    return await Promise.race([aborted, (async () => {
      const { url, addresses } = await resolveAssistantEndpoint(urlString, { provider, allowPrivateNetwork, env, lookup });
      if (controller.signal.aborted) throw safeError();
      const first = addresses[0], transport = url.protocol === 'https:' ? https : http;
      return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(Buffer.byteLength(body)) };
        if (provider === 'gemini') {
          if (authMethod === 'oauth') { headers.authorization = `Bearer ${accessToken}`; headers['x-goog-user-project'] = projectId; }
          else headers['x-goog-api-key'] = apiKey;
        } else if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        // No pooling: every socket is tied to this exact validated resolution.
        // Host and TLS SNI remain the administrator-selected hostname.
        request = (requestImpl || transport.request)(url, {
          method, agent: false, signal: controller.signal, headers,
          lookup: (_host, options, callback) => options?.all ? callback(null, [first]) : callback(null, first.address, first.family),
          ...(isIP(hostname(url)) ? {} : { servername: hostname(url) }),
          rejectUnauthorized: true,
        }, response => {
          const status = response.statusCode;
          if (status === 401 || status === 403) { response.destroy(); reject(safeError('ASSISTANT_CREDENTIAL_INVALID')); return; }
          if (status < 200 || status >= 300) { response.destroy(); reject(safeError()); return; }
          const chunks = []; let size = 0;
          response.on('error', () => reject(safeError()));
          response.on('aborted', () => reject(safeError()));
          response.on('data', chunk => {
            size += chunk.length;
            if (size > Math.min(MAX_RESPONSE, Math.max(1, maxResponseBytes))) { response.destroy(); reject(safeError()); }
            else chunks.push(chunk);
          });
          response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(safeError()); } });
        });
        request.on('error', () => reject(safeError()));
        request.end(body);
      });
    })()]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export const assistantTransportLimits = Object.freeze({ maxResponseBytes: MAX_RESPONSE, timeoutMs: TIMEOUT });
