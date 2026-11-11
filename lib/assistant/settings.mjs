import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createIntegrationKeyring } from '../integrations/keyring.mjs';
import { verifyAssistantProvider } from './provider.mjs';
import { validateAssistantSettings } from './contracts.mjs';
import { invalidateAssistantConfiguration } from './repository.mjs';
import { fail, integer, text } from '../validation-core.mjs';
import { audit, hash, insertRow } from '../business/commands.mjs';

const AAD = Buffer.from('allnutrition:assistant-api-key:v1:1');
const stamp = () => new Date().toISOString();
const generic = () => { const e = new Error('No se pudo leer la configuración privada del asistente.'); e.code = 'ASSISTANT_CREDENTIAL_INVALID'; return e; };
function seal(secret, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function open(row, key) {
  try {
    const iv = Buffer.from(row.api_key_iv, 'base64'), tag = Buffer.from(row.api_key_tag, 'base64'), ciphertext = Buffer.from(row.api_key_ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw generic(); }
}
function dto(row) {
  const data = row ? JSON.parse(row.data) : {};
  return validateAssistantSettings({ version: row?.version || 0, enabled: Boolean(row?.enabled), provider: data.provider || null, baseUrl: data.baseUrl || null, model: data.model || null, allowPrivateNetwork: Boolean(data.allowPrivateNetwork), hasApiKey: Boolean(row?.api_key_ciphertext), connectionStatus: data.connectionStatus || 'unconfigured', verifiedAt: data.verifiedAt || null });
}
function assistantError(code, message, status = 409) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}
const configurationChanged = () => assistantError('ASSISTANT_CONFIG_CHANGED', 'La configuración cambió en otra sesión. Recarga antes de guardar.');
export async function assertAssistantSession(tx, session, { lock = false } = {}) {
  const userId = session?.user?.id, tokenHash = session?.sessionTokenHash;
  if (typeof userId !== 'string' || !userId || typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) throw assistantError('ASSISTANT_AUTH_REQUIRED', 'Inicia sesión para continuar.', 401);
  if (lock) await tx.lockWrites();
  const suffix = lock && tx.provider === 'supabase' ? ' FOR UPDATE' : '';
  const user = await tx.db.get(`SELECT id,active FROM ${tx.t('users')} WHERE id=?${suffix}`, [userId]);
  if (!user || !Number(user.active)) throw assistantError('ASSISTANT_AUTH_REQUIRED', 'La sesión ya no está activa.', 401);
  const current = await tx.db.get(`SELECT expires,csrf FROM ${tx.t('sessions')} WHERE token_hash=? AND user_id=?${suffix}`, [tokenHash, userId]);
  if (!current || Number(current.expires) <= Date.now() || session.csrf != null && current.csrf !== session.csrf) throw assistantError('ASSISTANT_AUTH_REQUIRED', 'La sesión ya no está activa.', 401);
  return { userId, expires: Number(current.expires) };
}
export async function assertAssistantAccess(tx, session, configurationVersion, options = {}) {
  const active = await assertAssistantSession(tx, session, options);
  const row = await readRow(tx);
  if ((row?.version || 0) !== configurationVersion) throw configurationChanged();
  if (!row?.enabled) throw assistantError('ASSISTANT_DISABLED', 'Ali está deshabilitado.', 422);
  if (!row.api_key_ciphertext || JSON.parse(row.data).connectionStatus !== 'ready') throw assistantError('ASSISTANT_CREDENTIAL_INVALID', 'La credencial no está verificada.', 422);
  return active;
}
function candidate(input, prior) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  const version = integer(input.version, 'Versión', 0);
  if (typeof input.enabled !== 'boolean' || typeof input.allowPrivateNetwork !== 'boolean') fail('Configuración no válida.');
  const provider = input.provider == null || input.provider === '' ? null : input.provider;
  if (provider && !['openai', 'openai-compatible'].includes(provider)) fail('Proveedor inválido.');
  const model = input.model == null ? '' : text(input.model, 'Modelo', 200);
  const baseUrl = input.baseUrl == null ? '' : text(input.baseUrl, 'URL', 2048);
  if (provider === 'openai') {
    if (baseUrl && baseUrl !== 'https://api.openai.com/v1') fail('La URL de OpenAI no se puede cambiar.');
  }
  if (provider === 'openai-compatible' && baseUrl) {
    let url; try { url = new URL(baseUrl); } catch { fail('La URL del proveedor no es válida.'); }
    if (url.username || url.password || url.search || url.hash || url.pathname.endsWith('/chat/completions')) fail('Indica la raíz de API del proveedor, sin credenciales ni parámetros.');
    const loopback = ['localhost','[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && input.allowPrivateNetwork && loopback)) fail('El endpoint debe usar HTTPS; HTTP solo se permite en loopback con permiso explícito.');
  }
  const apiKey = input.apiKey == null ? '' : input.apiKey;
  if (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) > 4096 || /[\r\n\0]/.test(apiKey)) fail('La clave no es válida.');
  if (input.clearApiKey != null && typeof input.clearApiKey !== 'boolean') fail('clearApiKey no es válido.');
  const clear = input.clearApiKey === true;
  const origin = value => { try { return new URL(value).origin; } catch { return null; } };
  const changedDestination = prior && (prior.provider !== provider || origin(prior.baseUrl) !== origin(baseUrl));
  if (changedDestination && prior.hasApiKey && !apiKey.trim() && !clear) fail('Un cambio de proveedor u origen requiere una clave nueva.', 409);
  if (input.enabled && !clear && (!provider || !model || provider === 'openai-compatible' && !baseUrl)) fail('Para habilitar Ali se requieren proveedor, modelo y URL válida.', 422);
  return { version, enabled: input.enabled && !clear, provider, baseUrl: baseUrl || null, model: model || null, allowPrivateNetwork: input.allowPrivateNetwork, apiKey: apiKey.trim(), clear };
}
async function readRow(store) { return store.db.get(`SELECT * FROM ${store.t('assistant_settings')} WHERE id=1`); }
export async function getAssistantSettings(store) { return dto(await readRow(store)); }
export async function loadAssistantRuntime(store, options = {}) {
  const row = await readRow(store), safe = dto(row);
  if (!row || !row.api_key_ciphertext) return { ...safe, apiKey: null, configurationVersion: safe.version };
  const keyring = options.keyring || createIntegrationKeyring({ directory: options.env?.INTEGRATION_SECRETS_DIR, controlDirectory: options.env?.SOCIAL_BROWSER_CONTROL_DIR });
  const key = await keyring.ensureAssistant({ existingCiphertexts: true });
  return { ...safe, apiKey: open(row, key), configurationVersion: safe.version };
}
export async function saveAssistantSettings(store, input, session, options = {}) {
  await assertAssistantSession(store, session);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  const allowed = new Set(['version','requestId','enabled','provider','baseUrl','model','allowPrivateNetwork','apiKey','clearApiKey']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('Campo no permitido en configuración.');
  const requestId = text(input.requestId, 'Identificador de operación', 100, true);
  if (!/^[\w:-]{8,100}$/.test(requestId)) fail('Identificador de operación no válido.');
  const scope = 'assistant:settings', userId = session.user.id;
  // Idempotency contains only a one-way digest of new key material.
  const payloadHash = hash({ ...input, apiKey: undefined, apiKeyDigest: input.apiKey ? hash(input.apiKey) : null });
  async function recover(tx) {
    const prior = await tx.db.get(`SELECT actor_id,payload_hash,result_json FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, requestId]);
    if (!prior) return null;
    if (prior.actor_id !== userId || prior.payload_hash !== payloadHash) throw assistantError('ASSISTANT_CONFLICT', 'La solicitud ya se recibió con otros datos.');
    return JSON.parse(prior.result_json);
  }
  const previousResult = await recover(store);
  if (previousResult) { await assertAssistantSession(store, session); return previousResult; }
  const initial = await readRow(store), priorDto = dto(initial), next = candidate(input, priorDto);
  if (priorDto.version !== next.version) throw configurationChanged();
  const keyring = options.keyring || createIntegrationKeyring({ directory: options.env?.INTEGRATION_SECRETS_DIR, controlDirectory: options.env?.SOCIAL_BROWSER_CONTROL_DIR });
  let key = null, nextSecret = next.clear ? '' : next.apiKey;
  if (!next.clear && !nextSecret && initial?.api_key_ciphertext) {
    key = await keyring.ensureAssistant({ existingCiphertexts: true }); nextSecret = open(initial, key);
  } else if (nextSecret) key = await keyring.ensureAssistant({ existingCiphertexts: Boolean(initial?.api_key_ciphertext) });
  async function revalidate() {
    await assertAssistantSession(store, session);
    if ((await readRow(store))?.version !== initial?.version) throw configurationChanged();
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
  }
  let verifiedAt = null, status = next.provider || nextSecret ? 'unverified' : 'unconfigured';
  if (next.enabled) {
    if (!nextSecret) fail('Para habilitar Ali se requiere una clave.', 422);
    await revalidate();
    const runtime = { provider: next.provider, baseUrl: next.baseUrl, model: next.model, apiKey: nextSecret, allowPrivateNetwork: next.allowPrivateNetwork };
    let verificationError;
    try { await (options.verify || verifyAssistantProvider)(runtime, { signal: options.signal, transport: options.transport, beforeRequest: revalidate }); }
    catch (error) { verificationError = error; }
    await revalidate();
    if (verificationError) {
      const code = ['ASSISTANT_MODEL_UNSUPPORTED','ASSISTANT_CREDENTIAL_INVALID'].includes(verificationError.code) ? verificationError.code : 'ASSISTANT_UNAVAILABLE';
      throw assistantError(code, code === 'ASSISTANT_MODEL_UNSUPPORTED' ? 'El modelo no admite llamadas de función.' : code === 'ASSISTANT_CREDENTIAL_INVALID' ? 'El proveedor rechazó la credencial o permite acceso anónimo.' : 'No se pudo verificar la conexión del asistente.', code === 'ASSISTANT_UNAVAILABLE' ? 503 : 422);
    }
    status = 'ready'; verifiedAt = stamp();
  }
  const data = { provider: next.provider, baseUrl: next.baseUrl, model: next.model, allowPrivateNetwork: next.allowPrivateNetwork, connectionStatus: status, verifiedAt };
  const sealed = next.clear ? null : next.apiKey ? seal(next.apiKey, key) : initial?.api_key_ciphertext ? { ciphertext: initial.api_key_ciphertext, iv: initial.api_key_iv, tag: initial.api_key_tag } : null;
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const recovered = await recover(tx);
    if (recovered) { await assertAssistantSession(tx, session); return recovered; }
    const row = await readRow(tx);
    if ((row?.version || 0) !== next.version) throw configurationChanged();
    const now = stamp(), nextVersion = next.version + 1;
    const fields = [next.enabled ? 1 : 0, JSON.stringify(data), sealed?.ciphertext || null, sealed?.iv || null, sealed?.tag || null, userId, now];
    if (row) {
      const result = await tx.db.run(`UPDATE ${tx.t('assistant_settings')} SET version=version+1,enabled=?,data=?,api_key_ciphertext=?,api_key_iv=?,api_key_tag=?,actor_id=?,updated_at=? WHERE id=1 AND version=?`, [...fields, next.version]);
      if (!result.changes) throw configurationChanged();
    } else await tx.db.run(`INSERT INTO ${tx.t('assistant_settings')}(id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,updated_at,created_at) VALUES(1,1,?,?,?,?,?,?,?,?)`, [...fields, now]);
    await invalidateAssistantConfiguration(tx, { configurationVersion: nextVersion, at: Date.now() });
    const result = dto(await readRow(tx));
    await audit(tx, { entityType: scope, entityId: '1', actorId: userId, previous: priorDto, next: result, reason: 'Configuración de Ali actualizada' });
    await insertRow(tx, 'business_requests', { scope, request_id: requestId, actor_id: userId, payload_hash: payloadHash, result_json: JSON.stringify(result), created_at: now });
    await assertAssistantSession(tx, session);
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
    return result;
  });
}
export async function invalidateAssistantCredential(store, configurationVersion) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const row = await readRow(tx);
    if (!row || row.version !== configurationVersion || !row.enabled) return false;
    const data = { ...JSON.parse(row.data), connectionStatus: 'invalid', verifiedAt: null };
    await tx.db.run(`UPDATE ${tx.t('assistant_settings')} SET enabled=0,version=version+1,data=?,updated_at=? WHERE id=1 AND version=?`, [JSON.stringify(data), stamp(), configurationVersion]);
    await invalidateAssistantConfiguration(tx, { configurationVersion: configurationVersion + 1, at: Date.now() });
    return true;
  });
}
export const assistantKeyAAD = AAD.toString('utf8');
