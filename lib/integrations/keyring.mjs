import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { join, parse, relative, resolve, sep } from 'node:path';

const NAMES = Object.freeze(['appSecret', 'tokens', 'media', 'sessions', 'control']);
const LEGACY_NAMES = Object.freeze(['tokens', 'media', 'sessions', 'control']);
const APP_SECRET_AAD = Buffer.from('social-integration-settings:app-secret:v1');
const uid = () => process.getuid?.();

export class IntegrationKeyringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntegrationKeyringError';
    this.code = code;
    this.status = 409;
    this.recoverable = true;
  }
}
const unsafe = () => { throw new IntegrationKeyringError('INTEGRATION_KEY_UNSAFE', 'La custodia de integración no es segura: usa directorios privados sin enlaces simbólicos y archivos exclusivos de 32 bytes (0700/0600).'); };
const missing = name => { throw new IntegrationKeyringError('INTEGRATION_KEY_MISSING', `Falta la clave de integración ${name}. Restaura su volumen privado desde la copia original; no generes otra clave para los datos cifrados existentes.`); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
const owned = info => uid() === undefined || info.uid === uid();
const mode = info => info.mode & 0o7777;
function keyBytes(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new IntegrationKeyringError('INTEGRATION_KEY_INVALID', 'Cada clave de integración debe contener exactamente 32 bytes.');
  return key;
}
function distinct(keys) {
  const values = Object.values(keys);
  for (let i = 0; i < values.length; i++) {
    keyBytes(values[i]);
    if (values.slice(0, i).some(other => other.equals(values[i]))) throw new IntegrationKeyringError('INTEGRATION_KEY_REUSED', 'Las claves de integración deben ser independientes y distintas.');
  }
}

// Traverse every component before using a path: O_NOFOLLOW on the final file
// alone would still follow a symlink in one of its parent directories.
async function directory(path, { create = false } = {}) {
  const root = parse(path).root;
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) unsafe();
    if (uid() !== undefined && info.uid !== 0 && !owned(info)) unsafe();
    // Sticky shared ancestors (e.g. /private/tmp) cannot rename another user's
    // private child. Non-sticky shared writable ancestors are not safe custody.
    if (mode(info) & 0o022 && !(mode(info) & 0o1000)) unsafe();
  }
  const info = await lstat(path);
  if (!owned(info) || mode(info) !== 0o700 || await realpath(path) !== path) unsafe();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(info, await handle.stat())) unsafe();
    return { info, handle };
  } catch (error) { await handle.close(); throw error; }
}
async function assertDirectory(path, expected) {
  const current = await directory(path);
  if (!current) unsafe();
  try { if (!sameFile(current.info, expected.info)) unsafe(); }
  finally { await current.handle.close(); }
}
function validFile(info) {
  if (!info.isFile() || !owned(info) || mode(info) !== 0o600 || info.size !== 32) unsafe();
}

export function createIntegrationKeyring({ directory: configuredDirectory, controlDirectory: configuredControlDirectory } = {}) {
  // Private runtime volumes are provisioned separately, never traced into deployment artifacts.
  const secrets = resolve(/*turbopackIgnore: true*/ configuredDirectory ?? process.env.INTEGRATION_SECRETS_DIR ?? 'data/integration-secrets');
  const control = resolve(/*turbopackIgnore: true*/ configuredControlDirectory ?? process.env.SOCIAL_BROWSER_CONTROL_DIR ?? 'data/social-browser-control');
  if (secrets === control || secrets.startsWith(`${control}${sep}`) || control.startsWith(`${secrets}${sep}`)) unsafe();
  function location(name) {
    if (!NAMES.includes(name)) throw new IntegrationKeyringError('INTEGRATION_KEY_NAME', 'Nombre de clave de integración no válido.');
    const parent = name === 'control' ? control : secrets;
    return { parent, path: join(parent, `${name}.key`) };
  }
  async function read(name, { required = false } = {}) {
    const { parent, path } = location(name);
    const dir = await directory(parent);
    if (!dir) { if (required) missing(name); return null; }
    let handle;
    try {
      try { handle = await open(/*turbopackIgnore: true*/ path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (error.code === 'ELOOP') unsafe();
        if (error.code !== 'ENOENT') throw error;
        await assertDirectory(parent, dir);
        if (required) missing(name);
        return null;
      }
      const before = await handle.stat();
      validFile(before);
      const bytes = Buffer.alloc(32);
      const { bytesRead } = await handle.read(bytes, 0, 32, 0);
      const after = await handle.stat();
      validFile(after);
      if (bytesRead !== 32 || !unchanged(before, after)) unsafe();
      const linked = await lstat(path);
      validFile(linked);
      if (!sameFile(after, linked)) unsafe();
      await assertDirectory(parent, dir);
      return bytes;
    } finally { await handle?.close(); await dir.handle.close(); }
  }
  async function publish(name, value) {
    const { parent, path } = location(name);
    const dir = await directory(parent, { create: true });
    const temporary = join(parent, `.key-${randomUUID()}.tmp`);
    let handle, staged = false;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      staged = true;
      await handle.chmod(0o600);
      await handle.writeFile(keyBytes(value));
      await handle.sync();
      await assertDirectory(parent, dir);
      // link is exclusive, unlike rename: readers see all 32 bytes at once and
      // a concurrent initializer can never overwrite the winner's stable key.
      await link(temporary, path).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await unlink(temporary);
      staged = false;
      await dir.handle.sync();
      await assertDirectory(parent, dir);
    } finally {
      await handle?.close();
      if (staged) await unlink(temporary).catch(() => {});
      await dir.handle.close();
    }
    return read(name, { required: true });
  }
  async function all() {
    const keys = Object.fromEntries(await Promise.all(NAMES.map(async name => [name, await read(name)])));
    distinct(Object.fromEntries(Object.entries(keys).filter(([, value]) => value)));
    return keys;
  }
  return Object.freeze({
    read,
    async ensure({ existingCiphertexts = false } = {}) {
      const keys = await all();
      // Preflight the entire custody set before creating even one key.
      if (existingCiphertexts) for (const name of NAMES) if (!keys[name]) missing(name);
      for (const name of NAMES) if (!keys[name]) keys[name] = await publish(name, randomBytes(32));
      distinct(keys);
      return keys;
    },
    async importLegacy(keys) {
      if (!keys || Object.keys(keys).length !== LEGACY_NAMES.length || !LEGACY_NAMES.every(name => Object.hasOwn(keys, name))) throw new IntegrationKeyringError('INTEGRATION_KEY_INVALID', 'Importa las cuatro claves originales de tokens, medios, sesiones y control.');
      distinct(keys);
      const existing = await all();
      for (const name of LEGACY_NAMES) {
        if (existing[name] && !existing[name].equals(keys[name])) throw new IntegrationKeyringError('INTEGRATION_KEY_CONFLICT', 'La custodia existente no coincide con las claves originales. No se reemplazó ninguna clave.');
      }
      distinct({ ...keys, ...(existing.appSecret ? { appSecret: existing.appSecret } : {}) });
      for (const name of LEGACY_NAMES) {
        if (!existing[name]) existing[name] = await publish(name, keys[name]);
        if (!existing[name].equals(keys[name])) throw new IntegrationKeyringError('INTEGRATION_KEY_CONFLICT', 'Otra operación importó una custodia distinta. Conserva los archivos originales para recuperar la integración.');
      }
      if (!existing.appSecret) existing.appSecret = await publish('appSecret', randomBytes(32));
      distinct(existing);
      return existing;
    }
  });
}

export function sealAppSecret(secret, key) {
  keyBytes(key);
  if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret) > 4096) throw new IntegrationKeyringError('INTEGRATION_SECRET_INVALID', 'El secreto de la aplicación debe ser texto no vacío de hasta 4096 bytes.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(APP_SECRET_AAD);
  return {
    ciphertext: Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]).toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64')
  };
}
export function openAppSecret(row, key) {
  keyBytes(key);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(APP_SECRET_AAD);
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new IntegrationKeyringError('INTEGRATION_SECRET_UNREADABLE', 'El secreto de la aplicación no se puede descifrar. Restaura la clave y el ciphertext originales desde la copia privada.');
  }
}
