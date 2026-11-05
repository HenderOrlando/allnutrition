import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { fail } from '../validation-core.mjs';
import { secretKey, socialConfig } from './config.mjs';

const MAX_URL_SECONDS = 86400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const QUERY_KEYS = new Set(['variant', 'expires', 'signature']);
const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']);

function publicImage(asset) {
  return asset?.state === 'ready' && asset.kind === 'image' && UUID.test(asset.id || '') && HASH.test(asset.sha256 || '');
}
function signature(asset, expires, key) {
  return createHmac('sha256', key).update(`${asset.id}\n${asset.sha256}\nderivative\n${expires}`).digest('hex');
}
function epochSeconds(now) {
  if (!Number.isSafeInteger(now) || now < 0) fail('Fecha de firma no válida.');
  return Math.floor(now / 1000);
}
function authorization(url, now) {
  const params = url.searchParams;
  if ([...params.keys()].some(key => !QUERY_KEYS.has(key)) || [...QUERY_KEYS].some(key => params.getAll(key).length !== 1) || params.get('variant') !== 'derivative') return null;
  const expires = params.get('expires'), supplied = params.get('signature');
  if (!/^[1-9]\d{0,10}$/.test(expires || '') || !HASH.test(supplied || '')) return null;
  const seconds = epochSeconds(now), value = Number(expires);
  if (value <= seconds || value > seconds + MAX_URL_SECONDS) return null;
  return { expires, supplied };
}

// URLs are generated at the point of provider use. Never persist their value in
// command results, operations, audit records, logs or commercial backups.
export function createSocialMediaUrl(asset, { env = process.env, now = Date.now(), expiresInSeconds = 3600 } = {}) {
  if (!publicImage(asset)) fail('Sólo una imagen derivada lista puede entregarse mediante enlace firmado.', 409);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_URL_SECONDS) fail('El enlace debe vencer dentro de 24 horas.');
  let base;
  try { base = new URL(socialConfig(env).appUrl); } catch { fail('Configura APP_URL para entregar la imagen a Meta.', 409); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) fail('APP_URL no es un origen admitido para medios.', 409);
  const expires = String(epochSeconds(now) + expiresInSeconds), key = secretKey('SOCIAL_MEDIA_SIGNING_KEY', env);
  const url = new URL(`/api/social/media/${asset.id}`, base);
  url.searchParams.set('variant', 'derivative');
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', signature(asset, expires, key));
  return url.href;
}

export function verifySocialMediaUrl(asset, rawUrl, { env = process.env, now = Date.now() } = {}) {
  if (!publicImage(asset)) return false;
  let url, key;
  try { url = new URL(rawUrl); key = secretKey('SOCIAL_MEDIA_SIGNING_KEY', env); } catch { return false; }
  if (url.pathname !== `/api/social/media/${asset.id}`) return false;
  const value = authorization(url, now);
  return value !== null && timingSafeEqual(Buffer.from(signature(asset, value.expires, key), 'hex'), Buffer.from(value.supplied, 'hex'));
}

// One range is sufficient for native image/video previews. Multiple or invalid
// ranges return 416 instead of allocating a multipart copy of the file.
function byteRange(raw, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || !match[1] && !match[2] || size === 0) return null;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (suffix === 0n) return null;
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || end < start) return null;
  return { start: Number(start), end: Number(end < total ? end : total - 1n) };
}

// The descriptor owns a pinned read-only FileHandle, not a path that could be
// replaced between validation and the response. Stream cancellation closes it.
export async function socialMediaResponse(file, request) {
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !CONTENT_TYPES.has(file.contentType) || !HASH.test(file.sha256 || '')) fail('Metadatos de la pieza no válidos.', 409);
    const etag = `"${file.sha256}"`;
    const headers = {
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private,no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ETag: etag,
    };
    // RFC 9110: Range applies to GET, not HEAD; an unmatched If-Range sends the
    // complete representation rather than bytes from a different derivative.
    const ifRange = request.headers.get('if-range');
    const rangeHeader = request.method === 'GET' && (!ifRange || ifRange === etag) ? request.headers.get('range') : null;
    const range = rangeHeader ? byteRange(rangeHeader, file.size) : null;
    if (rangeHeader && !range) {
      await file.handle.close();
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': '0' } });
    }
    const start = range?.start ?? 0, end = range?.end ?? file.size - 1;
    headers['Content-Length'] = String(range ? end - start + 1 : file.size);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    if (request.method === 'HEAD' || file.size === 0) {
      await file.handle.close();
      return new Response(null, { status: 200, headers });
    }
    const stream = file.handle.createReadStream({ start, end, autoClose: true, signal: request.signal });
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } });
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    await file.handle.close();
    throw error;
  }
}
