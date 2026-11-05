import { constants } from 'node:fs';
import { lstat, mkdir, realpath, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, integer } from '../validation-core.mjs';
import { socialConfig } from './config.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^(${UUID})/(original\\.(?:jpg|png|webp|mp4|mov)|derivative\\.(?:jpg|mp4))$`);
const ID = new RegExp(`^${UUID}$`);
export function validateSocialMediaKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) fail('Clave de pieza privada no válida.');
  return key;
}
async function directory(env, assetId = null, create = false) {
  const configured = socialConfig(env).mediaRoot;
  if (create) await mkdir(configured, { recursive: true, mode: 0o700 });
  // Resolve platform aliases in ancestors, but never accept a symlink as the
  // configured root or asset directory. All subsequent access uses canonical paths.
  const rootInfo = await lstat(configured);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('El almacén privado no es un directorio seguro.', 409);
  const root = await realpath(configured);
  if (!assetId) return root;
  if (!ID.test(assetId)) fail('Identificador de pieza no válido.');
  const parent = join(/*turbopackIgnore: true*/ root, assetId);
  if (create) await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(/*turbopackIgnore: true*/ parent) !== parent) fail('El directorio de la pieza no es seguro.', 409);
  return parent;
}
export async function hashSocialMediaHandle(handle, { signal } = {}) {
  const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
  let bytes = 0;
  while (true) {
    signal?.throwIfAborted();
    const result = await handle.read(buffer, 0, buffer.length, bytes);
    if (!result.bytesRead) break;
    digest.update(buffer.subarray(0, result.bytesRead));
    bytes += result.bytesRead;
    if (!Number.isSafeInteger(bytes)) fail('El archivo supera el tamaño admitido.', 413);
  }
  return { sha256: digest.digest('hex'), bytes };
}
export async function openSocialMediaFile(key, { env = process.env, expectedSha256 = null, expectedBytes = null, signal } = {}) {
  validateSocialMediaKey(key);
  const [id, name] = key.split('/'), parent = await directory(env, id);
  const path = join(parent, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail('La pieza privada no es un archivo regular exclusivo.', 409);
    const actual = await hashSocialMediaHandle(handle, { signal });
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || actual.bytes !== after.size) fail('La pieza cambió durante su lectura.', 409);
    if (expectedSha256 != null && actual.sha256 !== expectedSha256 || expectedBytes != null && actual.bytes !== expectedBytes) fail('El archivo privado no coincide con su evidencia SHA-256.', 409);
    return { handle, size: actual.bytes, sha256: actual.sha256, path };
  } catch (error) { await handle.close(); throw error; }
}
export async function createSocialMediaTemporary(assetId, extension, { env = process.env, temporaryId = randomUUID() } = {}) {
  if (!ID.test(temporaryId) || !['part', 'jpg', 'mp4'].includes(extension)) fail('Temporal de pieza no válido.');
  const parent = await directory(env, assetId, true);
  const path = join(parent, `.stage-${temporaryId}.${extension}`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let published = false;
  return {
    handle, path,
    async publish(key) {
      validateSocialMediaKey(key);
      if (key.split('/')[0] !== assetId) fail('Destino de pieza no válido.');
      const destination = join(await directory(env, assetId), key.split('/')[1]);
      // A hard link is an atomic no-replace publication on this same filesystem.
      await link(path, destination);
      published = true;
      await unlink(path);
    },
    async discard() { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
    get published() { return published; }
  };
}
async function* chunks(body, signal) {
  if (body?.getReader) {
    const reader = body.getReader();
    const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) { signal?.throwIfAborted(); const next = await reader.read(); if (next.done) break; yield next.value; }
    } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } else if (body?.[Symbol.asyncIterator]) {
    const iterator = body[Symbol.asyncIterator]();
    let rejectAbort, completed = false;
    const interrupted = signal ? new Promise((_, reject) => { rejectAbort = reject; }) : null;
    const abort = () => { body.destroy?.(signal.reason); rejectAbort(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await (interrupted ? Promise.race([iterator.next(), interrupted]) : iterator.next());
        if (next.done) { completed = true; break; }
        yield next.value;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!completed) Promise.resolve(iterator.return?.()).catch(() => {});
    }
  } else fail('La carga debe ser un flujo de bytes.');
}
export async function stageSocialMediaFile(key, body, { env = process.env, expectedSha256 = null, expectedBytes = null, maxBytes = Number.MAX_SAFE_INTEGER, signal, temporaryId } = {}) {
  validateSocialMediaKey(key);
  integer(maxBytes, 'Tamaño máximo', 1, Number.MAX_SAFE_INTEGER);
  const temporary = await createSocialMediaTemporary(key.split('/')[0], 'part', { env, temporaryId });
  const digest = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of chunks(body, signal)) {
      if (!(chunk instanceof Uint8Array)) fail('La carga contiene datos que no son bytes.');
      bytes += chunk.byteLength;
      if (bytes > maxBytes || expectedBytes != null && bytes > expectedBytes) fail('La carga supera el tamaño registrado.', 413);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) { signal?.throwIfAborted(); const result = await temporary.handle.write(chunk, offset, chunk.byteLength - offset); offset += result.bytesWritten; }
    }
    signal?.throwIfAborted();
    const sha256 = digest.digest('hex');
    if (!bytes || expectedBytes != null && bytes !== expectedBytes) fail('La carga está incompleta o no coincide con el tamaño registrado.');
    if (expectedSha256 != null && sha256 !== expectedSha256) fail('El archivo no coincide con su SHA-256.', 409);
    await temporary.handle.sync();
    await temporary.handle.close();
    return { bytes, sha256, publish: () => temporary.publish(key), discard: () => temporary.discard() };
  } catch (error) { await temporary.handle.close().catch(() => {}); await temporary.discard(); throw error; }
}
export async function removeSocialMediaFile(key, { env = process.env, expectedSha256 = null, signal } = {}) {
  validateSocialMediaKey(key);
  try {
    const file = await openSocialMediaFile(key, { env, expectedSha256, signal });
    try { await unlink(file.path); } finally { await file.handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function discardSocialMediaTemporary(assetId, temporaryId, { env = process.env } = {}) {
  if (!ID.test(temporaryId)) fail('Temporal de pieza no válido.');
  try {
    const parent = await directory(env, assetId);
    for (const extension of ['part', 'jpg', 'mp4']) {
      await unlink(join(parent, `.stage-${temporaryId}.${extension}`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
