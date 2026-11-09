import { after } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { hash } from '../lib/business/commands.mjs';

const roots = new Set();
const KEY_NAMES = { tokens: 'SOCIAL_TOKEN_ENCRYPTION_KEY', media: 'SOCIAL_MEDIA_SIGNING_KEY', sessions: 'SOCIAL_BROWSER_SESSION_KEY', control: 'SOCIAL_BROWSER_CONTROL_KEY' };
const OPTION_FIELDS = { publicBaseUrl: 'APP_URL', appId: 'META_APP_ID', appSecret: 'META_APP_SECRET', loginConfigId: 'META_LOGIN_CONFIG_ID', publishingEnabled: 'SOCIAL_PUBLISHING_ENABLED', browserEnabled: 'SOCIAL_BROWSER_ENABLED' };
const fixtureKeys = new WeakMap();
const stores = new WeakMap();
after(async () => { await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true }))); roots.clear(); });

// Legacy-shaped fields belong only to synthetic provider fixtures, never the production loader.
export function runtimeFromTestEnv(env = {}, settings = {}) {
  let keys = fixtureKeys.get(env);
  if (!keys) {
    keys = { appSecret: randomBytes(32), ...Object.fromEntries(Object.entries(KEY_NAMES).map(([name, field]) => [name, env[field] ? Buffer.from(env[field], 'base64') : randomBytes(32)])) };
    fixtureKeys.set(env, keys);
  }
  const publicBaseUrl = settings.publicBaseUrl ?? env.APP_URL ?? 'https://panel.example.test';
  const appId = settings.appId ?? env.META_APP_ID ?? '101';
  const appSecret = settings.appSecret ?? env.META_APP_SECRET ?? 'SYNTHETIC-APP-SECRET';
  return { configurationVersion: 1, publicBaseUrl, appUrl: publicBaseUrl, appId, appSecret, loginConfigId: settings.loginConfigId ?? env.META_LOGIN_CONFIG_ID ?? '102', publishingEnabled: settings.publishingEnabled ?? (env.SOCIAL_PUBLISHING_ENABLED ? env.SOCIAL_PUBLISHING_ENABLED === 'true' : true), browserEnabled: settings.browserEnabled ?? (env.SOCIAL_BROWSER_ENABLED ? env.SOCIAL_BROWSER_ENABLED === 'true' : true), graphVersion: 'v26.0', browserUrl: env.SOCIAL_BROWSER_URL || 'http://social-browser:3320', browserMaxContexts: 2, mediaRoot: env.SOCIAL_MEDIA_DIR || 'data/social-media', mediaQuotaBytes: Number(env.SOCIAL_MEDIA_QUOTA_BYTES || 10737418240), fingerprint: hash([appId, appSecret, publicBaseUrl]), keys };
}

export async function configureSocialTestRuntime(store, { env = {}, settings = {}, actorId = 'social-fixture-admin' } = {}) {
  let custody = stores.get(store);
  if (!custody) {
    if (!env.INTEGRATION_SECRETS_DIR || !env.SOCIAL_BROWSER_CONTROL_DIR) {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'social-runtime-test-'));
      roots.add(root);
      env.INTEGRATION_SECRETS_DIR = join(root, 'secrets');
      env.SOCIAL_BROWSER_CONTROL_DIR = join(root, 'control');
    }
    const keyring = createIntegrationKeyring({ directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR });
    if (Object.values(KEY_NAMES).every(name => env[name])) await keyring.importLegacy(Object.fromEntries(Object.entries(KEY_NAMES).map(([name, field]) => [name, Buffer.from(env[field], 'base64')])));
    else await keyring.ensure();
    custody = { keyring, directory: env.INTEGRATION_SECRETS_DIR, controlDirectory: env.SOCIAL_BROWSER_CONTROL_DIR };
    stores.set(store, custody);
  }
  const { keyring } = custody;
  env.INTEGRATION_SECRETS_DIR = custody.directory;
  env.SOCIAL_BROWSER_CONTROL_DIR = custody.controlDirectory;
  await store.db.run(`INSERT INTO ${store.t('users')}(id,email,password,active) VALUES(?,?,?,1) ON CONFLICT(id) DO NOTHING`, [actorId, `${actorId}@example.test`, 'synthetic-unused-password']);
  const { getSocialSettings, saveSocialSettings } = await import('../lib/business/social-settings.mjs');
  const { loadSocialRuntime } = await import('../lib/social/config.mjs');
  const current = await getSocialSettings(store, { keyring, env });
  const prior = current.version ? await loadSocialRuntime(store, { keyring, env }) : null;
  const defaults = {};
  if (prior) for (const [field, legacy] of Object.entries(OPTION_FIELDS)) if (!Object.hasOwn(env, legacy)) defaults[field] = prior[field];
  const proposed = runtimeFromTestEnv(env, { ...defaults, ...settings });
  const fields = Object.keys(OPTION_FIELDS);
  const input = { version: current.version, requestId: 'fixture-config-' + randomBytes(12).toString('hex'), ...Object.fromEntries(fields.map(key => [key, proposed[key]])) };
  if (!prior || fields.some(key => prior[key] !== proposed[key])) await saveSocialSettings(store, input, actorId, { keyring, env, allowedOrigins: [input.publicBaseUrl] });
  const runtime = await loadSocialRuntime(store, { keyring, env });
  fixtureKeys.set(env, runtime.keys);
  for (const [name, field] of Object.entries(KEY_NAMES)) env[field] = runtime.keys[name].toString('base64');
  return { env, keyring, runtime, cleanup: async () => {
    stores.delete(store);
    const root = [...roots].find(root => env.INTEGRATION_SECRETS_DIR === join(root, 'secrets'));
    if (root) { roots.delete(root); await rm(root, { recursive: true, force: true }); }
  } };
}
