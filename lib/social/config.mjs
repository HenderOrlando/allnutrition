import { resolve } from 'node:path';
import { fail } from '../validation-core.mjs';

export const META_PERMISSIONS = Object.freeze([
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement',
  'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights',
  'ads_read', 'ads_management', 'pages_manage_ads'
]);
export const META_API_HOSTS = Object.freeze(['graph.facebook.com', 'graph-video.facebook.com', 'rupload.facebook.com']);
export const META_DOCUMENT_DOMAINS = Object.freeze(['facebook.com', 'instagram.com']);
export const META_RESOURCE_DOMAINS = Object.freeze([...META_DOCUMENT_DOMAINS, 'facebook.net', 'fbcdn.net', 'cdninstagram.com', 'fbsbx.com']);
export const hasDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function secretKey(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) fail(`Configura ${name} con 32 bytes en base64.`, 409);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) fail(`Configura ${name} con 32 bytes en base64.`, 409);
  return key;
}
function flag(env, name) {
  if (env[name] && !['true', 'false'].includes(env[name])) fail(`${name} debe ser true o false.`, 409);
  return env[name] === 'true';
}
function positiveInteger(env, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = env[name] || String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > maximum) fail(`${name}: entero positivo fuera de rango.`, 409);
  return Number(raw);
}
export function socialConfig(env = process.env) {
  return {
    appUrl: (env.APP_URL || '').replace(/\/$/, ''),
    graphVersion: env.META_GRAPH_VERSION || 'v26.0',
    publishingEnabled: flag(env, 'SOCIAL_PUBLISHING_ENABLED'),
    browserEnabled: flag(env, 'SOCIAL_BROWSER_ENABLED'),
    browserUrl: env.SOCIAL_BROWSER_URL || 'http://social-browser:3320',
    browserMaxContexts: positiveInteger(env, 'SOCIAL_BROWSER_MAX_CONTEXTS', 2, 32),
    // Private media is supplied by the runtime volume, never by the build bundle.
    mediaRoot: resolve(/*turbopackIgnore: true*/ env.SOCIAL_MEDIA_DIR || 'data/social-media'),
    mediaQuotaBytes: positiveInteger(env, 'SOCIAL_MEDIA_QUOTA_BYTES', 10737418240)
  };
}
export function integrationRequirements(method, env = process.env) {
  if (!['api', 'browser'].includes(method)) fail('Vía de integración no válida.');
  const keys = method === 'api'
    ? ['APP_URL', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY']
    : ['SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY'];
  const missing = keys.filter(name => !env[name]?.trim());
  const invalid = [];
  for (const name of keys.filter(name => name.endsWith('_KEY') && !missing.includes(name))) {
    try { secretKey(name, env); } catch { invalid.push(name); }
  }
  // Keys have different owners and rotation boundaries; sharing one defeats that isolation.
  const secretNames = ['SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY'];
  for (const name of keys.filter(name => secretNames.includes(name) && env[name])) {
    if (secretNames.some(other => other !== name && env[other] === env[name]) && !invalid.includes(name)) invalid.push(name);
  }
  if (method === 'api' && env.META_GRAPH_VERSION && env.META_GRAPH_VERSION !== 'v26.0') invalid.push('META_GRAPH_VERSION');
  if (method === 'api' && env.APP_URL) {
    try {
      const url = new URL(env.APP_URL);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) invalid.push('APP_URL');
    } catch { invalid.push('APP_URL'); }
  }
  const enabled = method === 'api' || env.SOCIAL_BROWSER_ENABLED === 'true';
  return { integrationMethod: method, enabled, configured: !missing.length && !invalid.length, missing, invalid, publishingEnabled: env.SOCIAL_PUBLISHING_ENABLED === 'true' };
}
export function requireIntegration(method, env = process.env) {
  const status = integrationRequirements(method, env);
  if (!status.enabled) fail('La vía navegador está deshabilitada en este despliegue.', 409);
  if (!status.configured) fail(`Configuración ${method}: ${[...status.missing, ...status.invalid].join(', ')}.`, 409);
  return socialConfig(env);
}
