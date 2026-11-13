import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assistantCredentialKey, openAssistantOAuth, sealAssistantOAuth } from './oauth-credentials.mjs';
import { googleOAuthConfig, refreshGoogleToken, revokeGoogleToken } from './google-oauth.mjs';
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
function dto(row, hasOAuthConnection = false) {
  const data = row ? JSON.parse(row.data) : {};
  return validateAssistantSettings({
    version: row?.version || 0, enabled: Boolean(row?.enabled), provider: data.provider || null,
    baseUrl: data.baseUrl || null, model: data.model || null, allowPrivateNetwork: Boolean(data.allowPrivateNetwork),
    hasApiKey: Boolean(row?.api_key_ciphertext), authMethod: data.authMethod || 'api-key',
    hasOAuthConnection, projectId: data.projectId || null,
    connectionStatus: data.connectionStatus || 'unconfigured', verifiedAt: data.verifiedAt || null,
  });
}
async function settingsDTO(store, row) {
  const connected = JSON.parse(row?.data || '{}').authMethod === 'oauth'
    && Boolean(await store.db.get(`SELECT id FROM ${store.t('assistant_oauth_credentials')} WHERE id=1`));
  return dto(row, connected);
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
  const settings = await settingsDTO(tx, row);
  if (!(settings.authMethod === 'oauth' ? settings.hasOAuthConnection : settings.hasApiKey) || settings.connectionStatus !== 'ready') throw assistantError('ASSISTANT_CREDENTIAL_INVALID', 'La autenticación no está verificada.', 422);
  return active;
}
function candidate(input, prior) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  const version = integer(input.version, 'Versión', 0);
  if (typeof input.enabled !== 'boolean' || typeof input.allowPrivateNetwork !== 'boolean') fail('Configuración no válida.');
  const provider = input.provider == null || input.provider === '' ? null : input.provider;
  if (provider && !['openai', 'openai-compatible', 'gemini'].includes(provider)) fail('Proveedor inválido.');
  const model = input.model == null ? '' : text(input.model, 'Modelo', 200);
  const baseUrl = input.baseUrl == null ? '' : text(input.baseUrl, 'URL', 2048);
  const authMethod = input.authMethod || 'api-key';
  if (!['api-key', 'oauth'].includes(authMethod) || authMethod === 'oauth' && provider !== 'gemini') fail('OAuth solo está disponible para Google/Gemini.');
  const projectId = input.projectId == null || input.projectId === '' ? null : text(input.projectId, 'Proyecto de Google Cloud', 30, true);
  if (projectId && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/.test(projectId)) fail('Proyecto de Google Cloud inválido.');
  if (provider === 'gemini' && model && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) fail('Modelo de Gemini inválido.');
  if (provider === 'openai' && baseUrl && baseUrl !== 'https://api.openai.com/v1') fail('La URL de OpenAI no se puede cambiar.');
  if (provider === 'gemini' && baseUrl) fail('La URL de Gemini no se puede cambiar.');
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
  if (authMethod === 'oauth' && (apiKey.trim() || clear)) fail('Usa «Desconectar cuenta» para cerrar OAuth; la clave API pertenece a otro método.');
  if (changedDestination && prior.hasApiKey && !apiKey.trim() && !clear) fail('Un cambio de proveedor u origen requiere una clave nueva.', 409);
  if (prior?.authMethod === 'oauth' && authMethod === 'api-key' && !apiKey.trim()) fail('Para cambiar a APIKey se requiere una clave nueva.', 422);
  if (prior?.hasApiKey && authMethod === 'oauth') fail('Conecta la cuenta de Google para sustituir la APIKey después de verificar el acceso.', 422);
  if (input.enabled && !clear && (!provider || !model || provider === 'openai-compatible' && !baseUrl || authMethod === 'oauth' && !projectId)) fail('Para habilitar Ali se requieren proveedor, modelo y destino válido; OAuth necesita un proyecto de Google Cloud.', 422);
  return { version, enabled: input.enabled && !clear, provider, baseUrl: baseUrl || null, model: model || null, allowPrivateNetwork: provider === 'openai-compatible' && input.allowPrivateNetwork, apiKey: apiKey.trim(), clear, authMethod, projectId: authMethod === 'oauth' ? projectId : null };
}
async function readRow(store) { return store.db.get(`SELECT * FROM ${store.t('assistant_settings')} WHERE id=1`); }
export async function getAssistantSettings(store) { return settingsDTO(store, await readRow(store)); }
export async function loadAssistantRuntime(store, options = {}) {
  const row = await readRow(store), safe = await settingsDTO(store, row);
  const runtime = { ...safe, apiKey: null, accessToken: null, configurationVersion: safe.version };
  if (safe.authMethod !== 'oauth') {
    if (row?.api_key_ciphertext) runtime.apiKey = open(row, await assistantCredentialKey(store, options, true));
    return runtime;
  }
  try {
    return await store.transaction(async tx => {
      // Serialize rare refreshes across processes, including rotating refresh tokens.
      await tx.lockWrites();
      if ((await readRow(tx))?.version !== safe.version) throw configurationChanged();
      const stored = await tx.db.get(`SELECT * FROM ${tx.t('assistant_oauth_credentials')} WHERE id=1`);
      if (!stored) throw assistantError('ASSISTANT_CREDENTIAL_INVALID', 'Conecta de nuevo tu cuenta de Google.', 422);
      const key = await assistantCredentialKey(tx, options, true);
      let credentials = openAssistantOAuth(stored, key);
      const config = googleOAuthConfig(options.env || process.env);
      if (!config.configured || credentials.fingerprint !== config.fingerprint) throw assistantError('ASSISTANT_CREDENTIAL_INVALID', 'La aplicación OAuth cambió. Conecta de nuevo tu cuenta de Google.', 422);
      if (credentials.expiresAt <= Date.now() + 60_000) {
        credentials = { ...await refreshGoogleToken(config, credentials, { signal: options.signal, fetchImpl: options.fetchImpl }), fingerprint: config.fingerprint };
        const sealed = sealAssistantOAuth(credentials, key);
        await tx.db.run(`UPDATE ${tx.t('assistant_oauth_credentials')} SET version=version+1,ciphertext=?,iv=?,auth_tag=?,updated_at=? WHERE id=1 AND version=?`, [sealed.ciphertext, sealed.iv, sealed.auth_tag, stamp(), stored.version]);
      }
      return { ...runtime, accessToken: credentials.accessToken };
    });
  } catch (error) {
    if (error.code === 'ASSISTANT_CREDENTIAL_INVALID') {
      await invalidateAssistantCredential(store, safe.version, options);
      throw assistantError(error.code, 'Google no permite usar esta conexión. La sesión OAuth de Ali se cerró; vuelve a autenticarte.', 422);
    }
    throw error;
  }
}
export async function saveAssistantSettings(store, input, session, options = {}) {
  await assertAssistantSession(store, session);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  const allowed = new Set(['version','requestId','enabled','provider','baseUrl','model','allowPrivateNetwork','apiKey','clearApiKey','authMethod','projectId']);
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
  const initial = await readRow(store), priorDto = await settingsDTO(store, initial), next = candidate(input, priorDto);
  if (priorDto.version !== next.version) throw configurationChanged();
  let key = null, nextSecret = next.clear ? '' : next.apiKey;
  if (nextSecret || !next.clear && initial?.api_key_ciphertext) key = await assistantCredentialKey(store, options, Boolean(initial?.api_key_ciphertext));
  if (!next.clear && !nextSecret && initial?.api_key_ciphertext) nextSecret = open(initial, key);
  const priorOAuth = priorDto.hasOAuthConnection && next.authMethod !== 'oauth'
    ? openAssistantOAuth(await store.db.get(`SELECT * FROM ${store.t('assistant_oauth_credentials')} WHERE id=1`), await assistantCredentialKey(store, options, true)) : null;
  async function revalidate() {
    await assertAssistantSession(store, session);
    if ((await readRow(store))?.version !== initial?.version) throw configurationChanged();
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
  }
  let verifiedAt = null, status = next.provider || nextSecret ? 'unverified' : 'unconfigured';
  if (next.enabled) {
    if (next.authMethod === 'api-key' && !nextSecret) fail('Para habilitar Ali se requiere una clave.', 422);
    if (next.authMethod === 'oauth' && !priorDto.hasOAuthConnection) fail('Autentica tu cuenta de Google antes de habilitar Ali.', 422);
    await revalidate();
    const runtime = next.authMethod === 'oauth'
      ? { ...await loadAssistantRuntime(store, options), model: next.model, projectId: next.projectId }
      : { provider: next.provider, baseUrl: next.baseUrl, model: next.model, apiKey: nextSecret, authMethod: 'api-key', allowPrivateNetwork: next.allowPrivateNetwork };
    let verificationError;
    try { await (options.verify || verifyAssistantProvider)(runtime, { signal: options.signal, transport: options.transport, beforeRequest: revalidate }); }
    catch (error) { verificationError = error; }
    await revalidate();
    if (verificationError && next.authMethod === 'oauth' && verificationError.code === 'ASSISTANT_CREDENTIAL_INVALID') await invalidateAssistantCredential(store, next.version, options);
    if (verificationError) {
      const code = ['ASSISTANT_MODEL_UNSUPPORTED','ASSISTANT_CREDENTIAL_INVALID'].includes(verificationError.code) ? verificationError.code : 'ASSISTANT_UNAVAILABLE';
      throw assistantError(code, code === 'ASSISTANT_MODEL_UNSUPPORTED' ? 'El modelo no admite llamadas de función.' : code === 'ASSISTANT_CREDENTIAL_INVALID' ? 'El proveedor rechazó la credencial o permite acceso anónimo.' : 'No se pudo verificar la conexión del asistente.', code === 'ASSISTANT_UNAVAILABLE' ? 503 : 422);
    }
    status = 'ready'; verifiedAt = stamp();
  }
  const data = { provider: next.provider, baseUrl: next.baseUrl, model: next.model, allowPrivateNetwork: next.allowPrivateNetwork, connectionStatus: status, verifiedAt, authMethod: next.authMethod, projectId: next.projectId };
  const sealed = next.authMethod === 'oauth' || next.clear ? null : next.apiKey ? seal(next.apiKey, key) : initial?.api_key_ciphertext ? { ciphertext: initial.api_key_ciphertext, iv: initial.api_key_iv, tag: initial.api_key_tag } : null;
  const result = await store.transaction(async tx => {
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
    if (next.authMethod !== 'oauth') await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_credentials')}`);
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')}`);
    await invalidateAssistantConfiguration(tx, { configurationVersion: nextVersion, at: Date.now() });
    const result = await settingsDTO(tx, await readRow(tx));
    await audit(tx, { entityType: scope, entityId: '1', actorId: userId, previous: priorDto, next: result, reason: 'Configuración de Ali actualizada' });
    await insertRow(tx, 'business_requests', { scope, request_id: requestId, actor_id: userId, payload_hash: payloadHash, result_json: JSON.stringify(result), created_at: now });
    await assertAssistantSession(tx, session);
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
    return result;
  });
  if (priorOAuth) await revokeGoogleToken(priorOAuth, { fetchImpl: options.fetchImpl });
  return result;
}

export async function saveAssistantOAuthConnection(store, { version, model, projectId, credentials }, session, options = {}) {
  const proposed = validateAssistantSettings({
    version, enabled: true, provider: 'gemini', baseUrl: null, model, projectId,
    authMethod: 'oauth', allowPrivateNetwork: false, hasApiKey: false, hasOAuthConnection: true,
    connectionStatus: 'ready', verifiedAt: stamp(),
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) fail('Modelo de Gemini inválido.');
  async function revalidate() {
    await assertAssistantSession(store, session);
    if (((await readRow(store))?.version || 0) !== version) throw configurationChanged();
    const config = googleOAuthConfig(options.env || process.env);
    if (!config.configured || config.fingerprint !== credentials.fingerprint) throw configurationChanged();
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
  }
  await revalidate();
  let verificationError;
  try {
    await (options.verify || verifyAssistantProvider)({ ...proposed, apiKey: null, accessToken: credentials.accessToken }, {
      signal: options.signal, transport: options.transport, beforeRequest: revalidate,
    });
  } catch (error) { verificationError = error; }
  await revalidate();
  if (verificationError) throw verificationError;
  const sealed = sealAssistantOAuth(credentials, await assistantCredentialKey(store, options, true));
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await readRow(tx);
    if ((row?.version || 0) !== version) throw configurationChanged();
    const config = googleOAuthConfig(options.env || process.env);
    if (!config.configured || config.fingerprint !== credentials.fingerprint) throw configurationChanged();
    const previous = await settingsDTO(tx, row), now = stamp();
    const data = { provider: 'gemini', baseUrl: null, model, projectId, authMethod: 'oauth', allowPrivateNetwork: false, connectionStatus: 'ready', verifiedAt: now };
    if (row) await tx.db.run(`UPDATE ${tx.t('assistant_settings')} SET version=version+1,enabled=1,data=?,api_key_ciphertext=NULL,api_key_iv=NULL,api_key_tag=NULL,actor_id=?,updated_at=? WHERE id=1 AND version=?`, [JSON.stringify(data), session.user.id, now, version]);
    else await tx.db.run(`INSERT INTO ${tx.t('assistant_settings')}(id,version,enabled,data,actor_id,created_at,updated_at) VALUES(1,1,1,?,?,?,?)`, [JSON.stringify(data), session.user.id, now, now]);
    // A new grant can share a Google authorization with the previous one.
    // Replace local tokens atomically; revoking the old grant could revoke both.
    await tx.db.run(`INSERT INTO ${tx.t('assistant_oauth_credentials')}(id,version,ciphertext,iv,auth_tag,updated_at) VALUES(1,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=assistant_oauth_credentials.version+1,ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`, [sealed.ciphertext, sealed.iv, sealed.auth_tag, now]);
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')}`);
    await invalidateAssistantConfiguration(tx, { configurationVersion: version + 1, at: Date.now() });
    const result = await settingsDTO(tx, await readRow(tx));
    await audit(tx, { entityType: 'assistant:oauth', entityId: '1', actorId: session.user.id, previous, next: result, reason: 'Cuenta de Google conectada y acceso al modelo verificado' });
    await assertAssistantSession(tx, session);
    if (options.signal?.aborted) throw assistantError('ASSISTANT_UNAVAILABLE', 'La comprobación se canceló.', 503);
    return result;
  });
}

export async function disconnectAssistantOAuth(store, input, session, options = {}) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => key !== 'version')) fail('Desconexión OAuth inválida.');
  const version = integer(input.version, 'Versión', 0);
  const result = await store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await readRow(tx);
    if ((row?.version || 0) !== version) throw configurationChanged();
    const stored = await tx.db.get(`SELECT * FROM ${tx.t('assistant_oauth_credentials')} WHERE id=1`);
    let credentials = null;
    if (stored) {
      try { credentials = openAssistantOAuth(stored, await assistantCredentialKey(tx, options, true)); }
      catch (error) { if (!error.code?.startsWith('INTEGRATION_KEY_') && error.code !== 'ASSISTANT_CREDENTIAL_INVALID') throw error; }
    }
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_credentials')}`);
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')}`);
    const data = JSON.parse(row?.data || '{}');
    if (data.authMethod === 'oauth') {
      const previous = dto(row, Boolean(stored));
      await tx.db.run(`UPDATE ${tx.t('assistant_settings')} SET enabled=0,version=version+1,data=?,actor_id=?,updated_at=? WHERE id=1 AND version=?`, [JSON.stringify({ ...data, connectionStatus: 'unconfigured', verifiedAt: null }), session.user.id, stamp(), version]);
      await invalidateAssistantConfiguration(tx, { configurationVersion: version + 1, at: Date.now() });
      await audit(tx, { entityType: 'assistant:oauth', entityId: '1', actorId: session.user.id, previous, next: await settingsDTO(tx, await readRow(tx)), reason: 'Conexión OAuth de Google eliminada' });
    }
    return { settings: await settingsDTO(tx, await readRow(tx)), credentials };
  });
  const revoked = result.credentials ? await revokeGoogleToken(result.credentials, { fetchImpl: options.fetchImpl }) : false;
  return { settings: result.settings, revoked };
}
export async function invalidateAssistantCredential(store, configurationVersion, options = {}) {
  const result = await store.transaction(async tx => {
    await tx.lockWrites();
    const row = await readRow(tx);
    if (!row || row.version !== configurationVersion) return { changed: false };
    const data = JSON.parse(row.data), oauth = data.authMethod === 'oauth';
    if (!row.enabled && !oauth) return { changed: false };
    let credentials = null;
    if (oauth) {
      const stored = await tx.db.get(`SELECT * FROM ${tx.t('assistant_oauth_credentials')} WHERE id=1`);
      if (stored) {
        try { credentials = openAssistantOAuth(stored, await assistantCredentialKey(tx, options, true)); }
        catch (error) { if (!error.code?.startsWith('INTEGRATION_KEY_') && error.code !== 'ASSISTANT_CREDENTIAL_INVALID') throw error; }
      }
      await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_credentials')}`);
      await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')}`);
    }
    await tx.db.run(`UPDATE ${tx.t('assistant_settings')} SET enabled=0,version=version+1,data=?,updated_at=? WHERE id=1 AND version=?`, [JSON.stringify({ ...data, connectionStatus: 'invalid', verifiedAt: null }), stamp(), configurationVersion]);
    await invalidateAssistantConfiguration(tx, { configurationVersion: configurationVersion + 1, at: Date.now() });
    return { changed: true, credentials };
  });
  if (result.credentials) await revokeGoogleToken(result.credentials, { fetchImpl: options.fetchImpl });
  return result.changed;
}
export const assistantKeyAAD = AAD.toString('utf8');
