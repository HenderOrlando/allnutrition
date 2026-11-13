import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createIntegrationKeyring } from '../integrations/keyring.mjs';

export const assistantOAuthAAD = 'allnutrition:assistant:google-oauth:credentials:v1:1';
const invalid = () => Object.assign(new Error('La conexión OAuth de Ali no se puede leer. Desconéctala y vuelve a autenticarte.'), { code: 'ASSISTANT_CREDENTIAL_INVALID', status: 422 });

export async function assistantCredentialKey(store, options = {}, existingCiphertexts = false) {
  const env = options.env || process.env;
  const keyring = options.keyring || createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
  const existing = await store.db.get(`SELECT 1 AS present FROM ${store.t('assistant_settings')} WHERE api_key_ciphertext IS NOT NULL UNION ALL SELECT 1 FROM ${store.t('assistant_oauth_credentials')} UNION ALL SELECT 1 FROM ${store.t('assistant_oauth_states')} LIMIT 1`);
  return keyring.ensureAssistant({ existingCiphertexts: existingCiphertexts || Boolean(existing) });
}
export function sealAssistantOAuth(value, key, aad = assistantOAuthAAD) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > 64 * 1024) throw invalid();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}
export function openAssistantOAuth(row, key, aad = assistantOAuthAAD) {
  try {
    const iv = Buffer.from(row.iv, 'base64'), tag = Buffer.from(row.auth_tag, 'base64'), ciphertext = Buffer.from(row.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > 64 * 1024) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value;
  } catch { throw invalid(); }
}
