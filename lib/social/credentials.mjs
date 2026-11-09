import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail, integer } from '../validation-core.mjs';
import { assertLease, entity, stamp } from '../business/commands.mjs';
import { loadSocialRuntime, hasDomain, META_DOCUMENT_DOMAINS } from './config.mjs';

function custody(connection, runtime) {
  const method = connection.integrationMethod;
  if (!['api', 'browser'].includes(method)) fail('Vía de conexión no válida.');
  const epoch = integer(connection.sessionEpoch ?? 0, 'Época de sesión', 0, Number.MAX_SAFE_INTEGER);
  const key = runtime?.keys?.[method === 'api' ? 'tokens' : 'sessions'];
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('Falta la clave privada de custodia social. Restaura el volumen original antes de reconectar.', 409);
  return {
    key,
    aad: Buffer.from(`${connection.id}:${method}:v1${method === 'browser' ? `:${epoch}` : ''}`)
  };
}
export function sanitizeBrowserState(value) {
  if (!value || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) fail('Estado de navegador no válido.');
  const cookies = value.cookies.filter(cookie => typeof cookie.domain === 'string' && META_DOCUMENT_DOMAINS.some(domain => hasDomain(cookie.domain.replace(/^\./, ''), domain))).map(cookie => {
    const { name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey } = cookie;
    if (typeof name !== 'string' || typeof value !== 'string' || !secure || !['Strict', 'Lax', 'None'].includes(sameSite)) fail('Cookie social no válida.');
    return { name, value, domain, path, expires, httpOnly, secure, sameSite, ...(partitionKey ? { partitionKey } : {}) };
  });
  const origins = value.origins.filter(item => {
    try { const url = new URL(item.origin); return url.protocol === 'https:' && !url.port && META_DOCUMENT_DOMAINS.some(domain => hasDomain(url.hostname, domain)); } catch { return false; }
  }).map(({ origin, localStorage }) => ({ origin, localStorage: Array.isArray(localStorage) ? localStorage.map(({ name, value }) => {
    if (typeof name !== 'string' || typeof value !== 'string') fail('Almacenamiento social no válido.');
    return { name, value };
  }) : [] }));
  return { cookies, origins };
}
export function encryptCredentials(connection, value, runtime) {
  const { key, aad } = custody(connection, runtime);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Credenciales no válidas.');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 8 * 1024 * 1024) fail('Estado autenticado demasiado grande.');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}
export function decryptCredentials(connection, row, runtime) {
  if (!row) return null;
  const { key, aad } = custody(connection, runtime);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { fail('La sesión social no se puede descifrar. Es necesario reconectar.', 409); }
}
export async function loadCredentials(store, connection, runtime) {
  return decryptCredentials(connection, await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connection.id]), runtime);
}
// Ciphertext is never returned from a command, audited, or stored in business_requests.
// The same transaction fences epoch and lease before and after the CAS write.
export async function saveCredentials(store, connectionId, value, { expectedVersion = 0, sessionEpoch = 0, lease = null, runtime, ...options } = {}) {
  integer(expectedVersion, 'Versión de credenciales', 0, Number.MAX_SAFE_INTEGER);
  return store.transaction(async tx => {
    await tx.lockWrites();
    const currentRuntime = runtime || await loadSocialRuntime(tx, options);
    const configuration = await tx.db.get(`SELECT version FROM ${tx.t('social_integration_settings')} WHERE id=1`);
    if ((configuration?.version || 0) !== currentRuntime.configurationVersion) fail('La configuración social cambió durante la operación.', 409);
    if (lease) await assertLease(tx, lease);
    const connection = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_connections')} WHERE id=?`, [connectionId]));
    if (!connection) fail('Conexión no encontrada.', 404);
    if ((connection.sessionEpoch ?? 0) !== sessionEpoch || connection.state === 'disconnected') fail('La sesión social fue sustituida o desconectada.', 409);
    const sealed = encryptCredentials(connection, value, currentRuntime), now = stamp();
    if (expectedVersion === 0) {
      if (await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connectionId])) fail('Las credenciales cambiaron en otra sesión.', 409);
      await tx.db.run(`INSERT INTO ${tx.t('social_credentials')}(connection_id,ciphertext,iv,auth_tag,version,updated_at) VALUES(?,?,?,?,1,?)`, [connectionId, sealed.ciphertext, sealed.iv, sealed.auth_tag, now]);
    } else {
      const result = await tx.db.run(`UPDATE ${tx.t('social_credentials')} SET ciphertext=?,iv=?,auth_tag=?,version=version+1,updated_at=? WHERE connection_id=? AND version=?`, [sealed.ciphertext, sealed.iv, sealed.auth_tag, now, connectionId, expectedVersion]);
      if (!result.changes) fail('Las credenciales cambiaron en otra sesión.', 409);
    }
    if (lease) await assertLease(tx, lease);
    return { version: expectedVersion + 1 };
  });
}
