import { ECDH } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { generateRequestDetails } from 'web-push';
import { isPublicAddress } from '../integrations/network.mjs';
import { fail } from '../validation-core.mjs';

const invalid = () => fail('La suscripción Web Push no corresponde a un servicio admitido.');
const NETWORK_TIMEOUT = 8000;
const transientCodes = new Set(['EAI_AGAIN','ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EPIPE','ETIMEDOUT','ABORT_ERR']);

export function shippingPushEndpoint(value) {
  if (typeof value !== 'string' || !/^https:\/\/[!-~]{1,2040}$/.test(value) || /[\\#]/.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.username || url.password || url.port || url.href !== value) invalid();
  const { hostname, pathname, search } = url;
  const supported = hostname === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]+$/.test(pathname) && !search
    || hostname === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/[A-Za-z0-9_-]+={0,2}$/.test(pathname) && !search
    || hostname === 'web.push.apple.com' && /^\/[A-Za-z0-9_-]+={0,2}$/.test(pathname) && !search
    || /^wns2-[a-z0-9-]+\.notify\.windows\.com$/.test(hostname) && pathname === '/w/' && /^\?token=[A-Za-z0-9_%+\/=.-]+$/.test(search);
  if (!supported) invalid();
  return url;
}

function base64Key(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) invalid();
  return decoded;
}

export function validateShippingPushSubscription(value) {
  const endpoint = shippingPushEndpoint(value?.endpoint).href;
  const { p256dh, auth } = value?.keys ?? {};
  const point = base64Key(p256dh, 65);
  if (point[0] !== 4) invalid();
  try { ECDH.convertKey(point, 'prime256v1'); } catch { invalid(); }
  base64Key(auth, 16);
  return { endpoint, keys: { p256dh, auth } };
}

// Resolve twice: enrollment rejects unsafe endpoints; delivery pins fresh,
// verified addresses while HTTPS still authenticates the service hostname.
export async function resolveShippingPushEndpoint(endpoint, resolve = lookup) {
  const url = shippingPushEndpoint(endpoint);
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Push DNS timeout'), { code:'ETIMEDOUT' })), NETWORK_TIMEOUT); });
    const addresses = await Promise.race([resolve(url.hostname, { all:true }), deadline]);
    if (!addresses.length || addresses.some(({ address, family }) => ![4,6].includes(family) || !isPublicAddress(address) || /^::ffff:/i.test(address) || address === '168.63.129.16' || address.startsWith('192.88.99.'))) invalid();
    return { url, addresses };
  } finally { clearTimeout(timer); }
}

export function sendShippingPush(subscription, payload, { vapidDetails, target, topic }) {
  const { url, addresses } = target;
  const { method, headers, body } = generateRequestDetails(subscription, payload, { vapidDetails, topic, TTL:3600 });
  return new Promise((resolve, reject) => {
    // Node HTTPS does not follow redirects. Read no provider body and let a
    // total deadline cover connect, TLS, and waiting for response headers.
    const req = request(url, {
      method, headers, agent:false, signal:AbortSignal.timeout(NETWORK_TIMEOUT), rejectUnauthorized:true,
      lookup(host, options, callback) {
        if (host !== url.hostname) { callback(new Error('Push hostname changed')); return; }
        const eligible = options.family ? addresses.filter(record => record.family === options.family) : addresses;
        if (!eligible.length) { callback(new Error('No approved address for IP family')); return; }
        if (options.all) callback(null, eligible);
        else callback(null, eligible[0].address, eligible[0].family);
      },
    }, response => {
      resolve({ statusCode:response.statusCode, retryAfter:response.headers['retry-after'] });
      response.destroy();
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function shippingPushTransient(error) {
  return transientCodes.has(error?.code);
}
