import { createDecipheriv } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIntegrationKeyring, IntegrationKeyringError, sealAppSecret } from '../lib/integrations/keyring.mjs';

const LEGACY_KEYS = Object.freeze({
  tokens: 'SOCIAL_TOKEN_ENCRYPTION_KEY',
  media: 'SOCIAL_MEDIA_SIGNING_KEY',
  sessions: 'SOCIAL_BROWSER_SESSION_KEY',
  control: 'SOCIAL_BROWSER_CONTROL_KEY'
});
class LegacyMigrationError extends Error {
  constructor(message) { super(message); this.name = 'LegacyMigrationError'; this.status = 409; }
}
const fail = message => { throw new LegacyMigrationError(message); };
function legacyKey(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) fail(`La migración requiere la clave original ${name} de 32 bytes en base64.`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) fail(`La clave original ${name} no es base64 canónico de 32 bytes.`);
  return key;
}
function legacyOptions(env) {
  let origin;
  try {
    const url = new URL(env.APP_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error();
    origin = url.origin;
  } catch { fail('APP_URL debe ser un origen HTTPS; HTTP solo se admite en loopback de desarrollo.'); }
  for (const name of ['META_APP_ID', 'META_LOGIN_CONFIG_ID']) {
    if (typeof env[name] !== 'string' || !/^\d{1,128}$/.test(env[name])) fail(`${name} debe ser un identificador numérico de Meta.`);
  }
  if (typeof env.META_APP_SECRET !== 'string' || !env.META_APP_SECRET.trim() || Buffer.byteLength(env.META_APP_SECRET) > 4096) fail('META_APP_SECRET debe contener el secreto original de la aplicación (hasta 4096 bytes).');
  if (env.META_GRAPH_VERSION && env.META_GRAPH_VERSION !== 'v26.0') fail('Esta migración solo admite Meta Graph v26.0.');
  for (const name of ['SOCIAL_PUBLISHING_ENABLED', 'SOCIAL_BROWSER_ENABLED']) {
    if (env[name] && !['true', 'false'].includes(env[name])) fail(`${name} debe ser true o false.`);
  }
  return {
    publicBaseUrl: origin,
    appId: env.META_APP_ID,
    loginConfigId: env.META_LOGIN_CONFIG_ID,
    publishingEnabled: env.SOCIAL_PUBLISHING_ENABLED === 'true',
    browserEnabled: env.SOCIAL_BROWSER_ENABLED === 'true'
  };
}
function verifyCredential(row, keys) {
  try {
    const method = row.integration_method;
    if (!['api', 'browser'].includes(method) || typeof row.id !== 'string') throw new Error();
    const connection = JSON.parse(row.connection_data);
    const epoch = connection.sessionEpoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error();
    const key = keys[method === 'api' ? 'tokens' : 'sessions'];
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${row.id}:${method}:v1${method === 'browser' ? `:${epoch}` : ''}`));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  } catch {
    fail('No se pudo verificar una credencial social con su clave y época originales. Conserva los datos y recupera las claves originales antes de migrar.');
  }
}

/** One-shot conversion only. Runtime code must never consult these legacy variables.
 * Failed validation leaves both the database and key files untouched. A later
 * storage/commit failure can leave stable, resumable key imports, never new token
 * ciphertexts or replacements of existing keys. Keep both private volumes in the
 * physical recovery backup; they are not part of commercial exports.
 */
export async function migrateSocialConfigFromLegacyEnv(store, { env = process.env, keyring, actorId = 'system' } = {}) {
  const data = legacyOptions(env);
  const keys = Object.fromEntries(Object.entries(LEGACY_KEYS).map(([name, variable]) => [name, legacyKey(env, variable)]));
  const values = Object.values(keys);
  if (values.some((key, index) => values.slice(0, index).some(other => other.equals(key)))) fail('Las cuatro claves originales deben ser distintas; no se puede migrar custodia compartida.');
  if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 200) fail('Actor de migración no válido.');
  keyring ??= createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
  return store.transaction(async tx => {
    await tx.lockWrites();
    if (!await tx.db.get(`SELECT version FROM ${tx.t('migrations')} WHERE version=10`)) fail('Ejecuta primero la migración de base de datos v10.');
    if (await tx.db.get(`SELECT id FROM ${tx.t('social_integration_settings')} WHERE id=1`)) fail('La configuración social ya existe. La conversión heredada solo admite configuración vacía.');
    const credentials = await tx.db.all(`SELECT c.id,c.integration_method,c.data AS connection_data,s.ciphertext,s.iv,s.auth_tag FROM ${tx.t('social_credentials')} s LEFT JOIN ${tx.t('social_connections')} c ON c.id=s.connection_id`);
    // Validate every row under the same write fence as the insert, including
    // disconnected connections and browser sessions from nonzero epochs.
    for (const row of credentials) verifyCredential(row, keys);
    const imported = await keyring.importLegacy(keys);
    const sealed = sealAppSecret(env.META_APP_SECRET, imported.appSecret);
    const at = new Date().toISOString();
    const inserted = await tx.db.run(`INSERT INTO ${tx.t('social_integration_settings')}(id,version,data,app_secret_ciphertext,app_secret_iv,app_secret_tag,actor_id,created_at,updated_at) VALUES(1,1,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(data), sealed.ciphertext, sealed.iv, sealed.auth_tag, actorId, at, at]);
    if (inserted.changes !== 1) fail('La configuración social cambió durante la migración. No se reemplazó.');
    return { version: 1, verifiedCredentials: credentials.length };
  });
}

async function main() {
  let store;
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--from-legacy-env') fail('Uso: node scripts/migrate-social-config.mjs --from-legacy-env');
    await import('./env.mjs');
    const { openStore } = await import('../lib/db/index.mjs');
    store = await openStore(process.env);
    const result = await migrateSocialConfigFromLegacyEnv(store);
    console.log(`Configuración social migrada a versión ${result.version}; credenciales verificadas: ${result.verifiedCredentials}. No se recifraron tokens ni sesiones.`);
  } catch (error) {
    // Database/OS errors may embed query values or paths. Only our deliberately
    // sanitized diagnostics are safe to print; never print an exception stack.
    const detail = error instanceof LegacyMigrationError || error instanceof IntegrationKeyringError
      ? error.message
      : 'Error de almacenamiento. Conserva la base y ambos volúmenes privados; revisa su acceso y la migración v10 antes de reintentar.';
    console.error(`No se completó la migración social: ${detail}`);
    process.exitCode = 1;
  } finally {
    try { await store?.close(); }
    catch {
      console.error('No se pudo cerrar el almacén después de la migración social. Revisa su estado antes de reintentar.');
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
