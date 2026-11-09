import { fail, integer, text } from '../validation-core.mjs';
import { allowedOrigins } from '../db/config.mjs';
import { createIntegrationKeyring, sealAppSecret } from '../integrations/keyring.mjs';
import { loadSocialRuntime, integrationRequirements } from '../social/config.mjs';
import { runCommand, insertRow, updateVersioned, audit, hash, stamp } from './commands.mjs';

const publicFields = runtime => ({
  version: runtime.configurationVersion, publicBaseUrl: runtime.publicBaseUrl, appId: runtime.appId,
  loginConfigId: runtime.loginConfigId, publishingEnabled: runtime.publishingEnabled,
  browserEnabled: runtime.browserEnabled, hasAppSecret: Boolean(runtime.appSecret),
  requirements: ['api', 'browser'].map(method => integrationRequirements(method, runtime)),
  callbackUrl: runtime.publicBaseUrl ? `${runtime.publicBaseUrl}/api/admin/social/oauth/callback` : '',
  dataDeletionUrl: runtime.publicBaseUrl ? `${runtime.publicBaseUrl}/social-data-deletion` : ''
});
export async function getSocialSettings(store, options = {}) {
  return publicFields(await loadSocialRuntime(store, options));
}
function configuration(input, options) {
  const env = options.env || process.env;
  const publicBaseUrl = text(input.publicBaseUrl, 'Origen público', 2048, true);
  let url;
  try { url = new URL(publicBaseUrl); } catch { fail('publicBaseUrl debe ser un origen HTTPS autorizado.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback && env.NODE_ENV !== 'production')) fail('publicBaseUrl debe ser un origen HTTPS autorizado; HTTP solo en loopback de desarrollo.');
  const permitted = options.allowedOrigins || allowedOrigins(env);
  if (!permitted.includes(url.origin)) fail('El origen público no está autorizado en este despliegue.', 403);
  const appId = text(input.appId, 'App ID', 100), loginConfigId = text(input.loginConfigId, 'Configuración de login', 100);
  if (appId && !/^\d+$/.test(appId) || loginConfigId && !/^\d+$/.test(loginConfigId)) fail('Los identificadores de Meta deben contener solo dígitos.');
  for (const field of ['publishingEnabled', 'browserEnabled']) if (typeof input[field] !== 'boolean') fail(`${field} debe ser booleano.`);
  return { publicBaseUrl: url.origin, appId, loginConfigId, publishingEnabled: input.publishingEnabled, browserEnabled: input.browserEnabled };
}
async function invalidatePreparations(tx, now) {
  const connections = await tx.db.all(`SELECT * FROM ${tx.t('social_connections')} WHERE state<>'disconnected'`);
  for (const row of connections) {
    const data = JSON.parse(row.data);
    await updateVersioned(tx, 'social_connections', row.id, row.version, { data: JSON.stringify({ ...data, validatedAt: null, configurationFingerprint: null, revalidationRequired: true }) });
  }
  // Preserve every remote reference and receipt. Only work with no evidence of a
  // send is retired; sent/uncertain work must remain available for reconciliation.
  const operations = await tx.db.all(`SELECT * FROM ${tx.t('social_operations')} WHERE state IN ('prepared','retry_wait')`);
  for (const row of operations) {
    const data = JSON.parse(row.data);
    if (/^pause(?::|$)/.test(row.step) || data.sentAt || data.receipts?.length || data.progress && Object.keys(data.progress).length) continue;
    await updateVersioned(tx, 'social_operations', row.id, row.version, { state: 'failed', next_attempt_at: null, data: JSON.stringify({ ...data, configurationInvalidatedAt: now, lastError: { code: 'CONFIGURATION_CHANGED' } }) });
  }
  const deliveries = await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')} WHERE state IN ('queued','preparing','ready','scheduled')`);
  for (const row of deliveries) {
    const evidence = await tx.db.get(`SELECT id FROM ${tx.t('social_operations')} WHERE delivery_id=? AND state IN ('sent','uncertain') LIMIT 1`, [row.id]);
    if (evidence) continue;
    await updateVersioned(tx, 'social_deliveries', row.id, row.version, { state: 'blocked', next_sync_at: null, data: JSON.stringify({ ...JSON.parse(row.data), configurationInvalidatedAt: now, lastError: { code: 'CONFIGURATION_CHANGED' } }) });
  }
}
export async function saveSocialSettings(store, input, actorId, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  const version = integer(input.version, 'Versión', 0, 2147483646), data = configuration(input, options);
  if (input.appSecret !== undefined && typeof input.appSecret !== 'string') fail('El secreto debe ser texto.');
  const secret = input.appSecret?.trim() || '';
  if (Buffer.byteLength(secret) > 4096) fail('El secreto admite hasta 4096 bytes.');
  const keyring = options.keyring || createIntegrationKeyring({ directory: options.env?.INTEGRATION_SECRETS_DIR, controlDirectory: options.env?.SOCIAL_BROWSER_CONTROL_DIR });
  // The command's canonical payload contains only a digest of the submitted
  // secret; neither idempotency storage nor audit receives plaintext custody.
  const authorizedStore = { transaction: fn => store.transaction(async tx => {
    await tx.lockWrites();
    if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
    return fn(tx);
  }) };
  return runCommand(authorizedStore, { scope: 'social:settings', requestId: input.requestId, payload: { version, ...data, appSecretDigest: secret ? hash(secret) : null }, actorId, affectsIndicators: false }, async tx => {
    const row = await tx.db.get(`SELECT * FROM ${tx.t('social_integration_settings')} WHERE id=1`);
    if ((row?.version || 0) !== version) fail('La configuración cambió en otra sesión. Recarga antes de guardar.', 409);
    const previous = await loadSocialRuntime(tx, { ...options, keyring });
    const appChanged = previous.appId !== data.appId;
    if (appChanged && await tx.db.get(`SELECT id FROM ${tx.t('social_connections')} WHERE integration_method='api' AND state<>'disconnected' LIMIT 1`)) fail('Desconecta primero todas las conexiones API antes de cambiar de aplicación Meta.', 409);
    if (appChanged && !secret) fail('Un cambio de aplicación requiere un secreto nuevo.', 409);
    const existingCredentials = await tx.db.get(`SELECT connection_id FROM ${tx.t('social_credentials')} LIMIT 1`);
    const keys = await keyring.ensure({ existingCiphertexts: Boolean(row || existingCredentials) });
    const nextSecret = secret || previous.appSecret;
    const sealed = secret ? sealAppSecret(secret, keys.appSecret) : null;
    const fields = { data: JSON.stringify(data), actor_id: actorId, ...(sealed ? { app_secret_ciphertext: sealed.ciphertext, app_secret_iv: sealed.iv, app_secret_tag: sealed.auth_tag } : {}) };
    const now = stamp();
    if (row) await updateVersioned(tx, 'social_integration_settings', 1, version, fields);
    else await insertRow(tx, 'social_integration_settings', { id: 1, version: 1, ...fields, created_at: now, updated_at: now });
    const changed = previous.appId !== data.appId || previous.appSecret !== nextSecret || previous.publicBaseUrl !== data.publicBaseUrl;
    if (changed && row) await invalidatePreparations(tx, now);
    const result = await getSocialSettings(tx, { ...options, keyring });
    await audit(tx, { entityType: 'social_integration_settings', entityId: '1', actorId, previous: publicFields(previous), next: { ...result, appSecretChanged: Boolean(secret && secret !== previous.appSecret) }, reason: 'Configuración social actualizada' });
    return result;
  });
}
