import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../validation-core.mjs';
import { createIntegrationKeyring, openAppSecret } from '../integrations/keyring.mjs';

export const META_PERMISSIONS = Object.freeze([
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement',
  'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights',
  'ads_read', 'ads_management', 'pages_manage_ads'
]);
export const META_API_HOSTS = Object.freeze(['graph.facebook.com', 'graph-video.facebook.com', 'rupload.facebook.com']);
export const META_DOCUMENT_DOMAINS = Object.freeze(['facebook.com', 'instagram.com']);
export const META_RESOURCE_DOMAINS = Object.freeze([...META_DOCUMENT_DOMAINS, 'facebook.net', 'fbcdn.net', 'cdninstagram.com', 'fbsbx.com']);
export const hasDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function positiveInteger(env, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = env[name] || String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > maximum) fail(`${name}: entero positivo fuera de rango.`, 409);
  return Number(raw);
}
export function socialConfig(env = process.env) {
  return {
    graphVersion: 'v26.0',
    browserUrl: env.SOCIAL_BROWSER_URL || 'http://social-browser:3320',
    browserMaxContexts: positiveInteger(env, 'SOCIAL_BROWSER_MAX_CONTEXTS', 2, 32),
    mediaRoot: resolve(/*turbopackIgnore: true*/ env.SOCIAL_MEDIA_DIR || 'data/social-media'),
    mediaQuotaBytes: positiveInteger(env, 'SOCIAL_MEDIA_QUOTA_BYTES', 10737418240)
  };
}
export async function loadSocialRuntime(store, { keyring, env = process.env } = {}) {
  const row = await store.db.get(`SELECT * FROM ${store.t('social_integration_settings')} WHERE id=1`);
  const data = row ? JSON.parse(row.data) : {};
  const keys = {};
  if (row) {
    keyring ||= createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
    // Configuration is initialized with the entire custody set. Never repair lost
    // files by generating replacements, even if this turn only needs one key.
    for (const name of ['appSecret', 'tokens', 'media', 'sessions', 'control']) keys[name] = await keyring.read(name, { required: true });
  }
  const appSecret = row?.app_secret_ciphertext ? openAppSecret({ ciphertext: row.app_secret_ciphertext, iv: row.app_secret_iv, auth_tag: row.app_secret_tag }, keys.appSecret) : '';
  const publicBaseUrl = data.publicBaseUrl || '', appId = data.appId || '';
  const fingerprint = createHash('sha256').update(JSON.stringify([appId, appSecret, publicBaseUrl])).digest('hex');
  return Object.freeze({
    ...socialConfig(env), configurationVersion: row?.version || 0,
    publicBaseUrl, appUrl: publicBaseUrl, appId, appSecret, loginConfigId: data.loginConfigId || '',
    publishingEnabled: data.publishingEnabled === true, browserEnabled: data.browserEnabled === true,
    fingerprint, keys: Object.freeze(keys)
  });
}
export function integrationRequirements(method, runtime) {
  if (!['api', 'browser'].includes(method)) fail('Vía de integración no válida.');
  if (!runtime || typeof runtime !== 'object') fail('Carga la configuración social persistente antes de usar la integración.', 409);
  const fields = method === 'api' ? ['publicBaseUrl', 'appId', 'appSecret', 'loginConfigId'] : [];
  const missing = fields.filter(name => !runtime[name]);
  const names = method === 'api' ? ['tokens', 'media'] : ['control', 'sessions'];
  for (const name of names) if (!runtime.keys?.[name]) missing.push(`keys.${name}`);
  const invalid = [];
  for (const name of names) if (runtime.keys?.[name] && (!Buffer.isBuffer(runtime.keys[name]) || runtime.keys[name].length !== 32)) invalid.push(`keys.${name}`);
  for (const name of names) if (Buffer.isBuffer(runtime.keys?.[name]) && Object.entries(runtime.keys).some(([other, key]) => other !== name && Buffer.isBuffer(key) && key.equals(runtime.keys[name])) && !invalid.includes(`keys.${name}`)) invalid.push(`keys.${name}`);
  if (runtime.publicBaseUrl) {
    try {
      const url = new URL(runtime.publicBaseUrl);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) invalid.push('publicBaseUrl');
    } catch { invalid.push('publicBaseUrl'); }
  }
  return { integrationMethod: method, enabled: method === 'api' || runtime.browserEnabled === true, configured: !missing.length && !invalid.length, missing, invalid, publishingEnabled: runtime.publishingEnabled === true };
}
export function requireIntegration(method, runtime) {
  const status = integrationRequirements(method, runtime);
  if (!status.enabled) fail('La vía navegador está deshabilitada en Configuraciones.', 409);
  if (!status.configured) fail(`Configuración ${method}: ${[...status.missing, ...status.invalid].join(', ')}.`, 409);
  return runtime;
}
