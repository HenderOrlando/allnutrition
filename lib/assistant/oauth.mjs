import { createHash, randomBytes } from 'node:crypto';
import { fail, integer, text } from '../validation-core.mjs';
import { assertAssistantSession, getAssistantSettings, invalidateAssistantCredential, saveAssistantOAuthConnection } from './settings.mjs';
import { assistantCredentialKey, openAssistantOAuth, sealAssistantOAuth } from './oauth-credentials.mjs';
import { exchangeGoogleCode, googleAuthorizationUrl, googleOAuthConfig, revokeGoogleToken } from './google-oauth.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const aad = stateHash => `allnutrition:assistant:google-oauth:state:v1:${stateHash}`;
const error = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const expired = () => error('ASSISTANT_CREDENTIAL_INVALID', 'La autorización venció, ya se usó o no corresponde a esta sesión. Inicia otra conexión.');
function exact(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) fail('Solicitud OAuth no válida.');
}

export async function startAssistantOAuth(store, input, session, options = {}) {
  exact(input, ['version', 'provider', 'model', 'projectId']);
  const version = integer(input.version, 'Versión', 0);
  if (input.provider !== 'gemini') fail('OAuth solo está disponible para Google/Gemini.');
  const model = text(input.model, 'Modelo', 128, true), projectId = text(input.projectId, 'Proyecto de Google Cloud', 30, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/.test(projectId)) fail('Modelo o proyecto de Google Cloud inválido.');
  await assertAssistantSession(store, session);
  const config = googleOAuthConfig(options.env || process.env);
  if (!config.configured) throw error('ASSISTANT_UNAVAILABLE', 'Configura la aplicación OAuth de Google en el servidor antes de conectar.', 409);
  const state = randomBytes(32).toString('base64url'), stateHash = hash(state), codeVerifier = randomBytes(48).toString('base64url');
  const key = await assistantCredentialKey(store, options);
  const sealed = sealAssistantOAuth({ model, projectId, codeVerifier, fingerprint: config.fingerprint }, key, aad(stateHash));
  await store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    if ((await getAssistantSettings(tx)).version !== version) throw error('ASSISTANT_CONFIG_CHANGED', 'La configuración cambió. Recarga antes de conectar.', 409);
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')} WHERE expires_at<=? OR (user_id=? AND session_token_hash=?)`, [Date.now(), session.user.id, session.sessionTokenHash]);
    await tx.db.run(`INSERT INTO ${tx.t('assistant_oauth_states')}(state_hash,user_id,session_token_hash,configuration_version,ciphertext,iv,auth_tag,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [stateHash, session.user.id, session.sessionTokenHash, version, sealed.ciphertext, sealed.iv, sealed.auth_tag, Date.now() + 10 * 60_000, new Date().toISOString()]);
  });
  return { authorizationUrl: googleAuthorizationUrl(config, { state, codeVerifier }) };
}

export async function completeAssistantOAuth(store, input, session, options = {}) {
  exact(input, ['state', 'code', 'error']);
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw expired();
  const stateHash = hash(input.state);
  const pending = await store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_oauth_states')} WHERE state_hash=? AND user_id=? AND session_token_hash=?`, [stateHash, session.user.id, session.sessionTokenHash]);
    if (!row) return null;
    await tx.db.run(`DELETE FROM ${tx.t('assistant_oauth_states')} WHERE state_hash=?`, [stateHash]);
    return row;
  });
  if (!pending || Number(pending.expires_at) <= Date.now()) throw expired();
  if (input.error != null) throw error('ASSISTANT_CREDENTIAL_INVALID', 'No autorizaste el acceso de Google. El intento OAuth de Ali se cerró; tu sesión del panel continúa.');
  const key = await assistantCredentialKey(store, options, true);
  const attempt = openAssistantOAuth(pending, key, aad(stateHash));
  const config = googleOAuthConfig(options.env || process.env);
  if (!config.configured || attempt.fingerprint !== config.fingerprint || (await getAssistantSettings(store)).version !== pending.configuration_version) throw error('ASSISTANT_CONFIG_CHANGED', 'La configuración cambió durante la autorización. Inicia otra conexión.', 409);
  let credentials = null;
  try {
    credentials = { ...await exchangeGoogleCode(config, { code: input.code, codeVerifier: attempt.codeVerifier, signal: options.signal, fetchImpl: options.fetchImpl }), fingerprint: config.fingerprint };
    return { settings: await saveAssistantOAuthConnection(store, { version: pending.configuration_version, model: attempt.model, projectId: attempt.projectId, credentials }, session, options) };
  } catch (cause) {
    const revoked = credentials ? await revokeGoogleToken(credentials, { fetchImpl: options.fetchImpl }) : false;
    // Revoking a reconnect grant can invalidate the previous Google grant too.
    if (credentials) {
      const current = await getAssistantSettings(store);
      if (current.authMethod === 'oauth' && current.version === pending.configuration_version) await invalidateAssistantCredential(store, current.version, options);
    }
    const code = ['ASSISTANT_AUTH_REQUIRED', 'ASSISTANT_CONFIG_CHANGED', 'ASSISTANT_MODEL_UNSUPPORTED', 'ASSISTANT_CREDENTIAL_INVALID'].includes(cause?.code) ? cause.code : 'ASSISTANT_UNAVAILABLE';
    const message = code === 'ASSISTANT_AUTH_REQUIRED' ? 'La sesión del panel venció durante la autorización.' : code === 'ASSISTANT_CONFIG_CHANGED' ? 'La configuración cambió durante la autorización.' : code === 'ASSISTANT_MODEL_UNSUPPORTED' ? 'El modelo de Google no admite las funciones que necesita Ali.' : 'No se pudo autorizar el uso del modelo con esta cuenta y proyecto. Revisa los permisos, la cuota y la facturación con Google.';
    throw Object.assign(error(code, `${message} La conexión OAuth nueva de Ali se cerró.${credentials && !revoked ? ' No se pudo confirmar la revocación remota; revisa el acceso de la aplicación en tu cuenta de Google.' : ''}`, code === 'ASSISTANT_AUTH_REQUIRED' ? 401 : code === 'ASSISTANT_CONFIG_CHANGED' ? 409 : code === 'ASSISTANT_UNAVAILABLE' ? 503 : 422), { revoked });
  }
}

export function assistantOAuthErrorResponse(cause) {
  const code = typeof cause?.code === 'string' && cause.code.startsWith('ASSISTANT_') ? cause.code : null;
  if (code) return Response.json({ error: cause.message, code, ...(typeof cause.revoked === 'boolean' ? { revoked: cause.revoked } : {}) }, { status: cause.status || 503, headers: { 'Cache-Control': 'no-store' } });
  if (cause?.code?.startsWith('INTEGRATION_KEY_')) return Response.json({ error: 'La custodia privada de Ali no está disponible. Restaura su clave original o desconecta la cuenta.', code: 'ASSISTANT_CREDENTIAL_INVALID' }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  return null;
}
