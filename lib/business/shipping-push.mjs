import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { generateVAPIDKeys } from 'web-push';
import { createIntegrationKeyring, openShippingPushDevice, openShippingPushVapid, sealShippingPushDevice, sealShippingPushVapid } from '../integrations/keyring.mjs';
import { isPublicAddress } from '../integrations/network.mjs';
import { resolveShippingPushEndpoint, sendShippingPush, shippingPushTransient, validateShippingPushSubscription } from '../shipping/push-transport.mjs';
import { fail } from '../validation-core.mjs';
import { getHekaSettings } from './heka-api.mjs';
import { stamp } from './commands.mjs';
import { disableShippingPushDeviceTx, discardShippingPushDeliveriesTx, shippingPushDeviceId } from './shipping-push-devices.mjs';
import { jobClock } from './job-leases.mjs';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 45000;
const TURN_SIZE = 4;
const digest = value => createHash('sha256').update(value).digest('hex');
const after = (now, ms) => new Date(Date.parse(now) + ms).toISOString();
const keyringFor = ({ keyring, env = process.env }) => keyring ?? createIntegrationKeyring({ directory:env.INTEGRATION_SECRETS_DIR, controlDirectory:env.SOCIAL_BROWSER_CONTROL_DIR });
const vapidRow = store => store.db.get(`SELECT * FROM ${store.t('shipping_push_vapid')} WHERE id=1`);
const scopeChanged = () => fail('Cambió la conexión o el entorno de Heka. Recarga y revisa dónde activar los avisos.', 409);

export function shippingPushOrigin(env, environment) {
  let url;
  try { url = new URL(env.APP_URL); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (local) return environment === 'test' ? url.origin : null;
  if (isIP(host) ? !isPublicAddress(host) : !host.includes('.') || /(?:\.(?:test|example|invalid|local|internal|onion)|(?:^|\.)home\.arpa)$/.test(host)) return null;
  return url.origin;
}

export async function getShippingPushStatus(store, userId, device, { env = process.env } = {}) {
  const config = await getHekaSettings(store);
  const id = shippingPushDeviceId(device);
  const own = id && await store.db.get(`SELECT environment FROM ${store.t('shipping_push_subscriptions')} WHERE id=? AND user_id=? AND disabled_at IS NULL`, [id, userId]);
  return { available:Boolean(config.configured && shippingPushOrigin(env, config.environment)), environment:config.environment, deviceEnvironment:own?.environment ?? null };
}

async function assertActiveSession(tx, session) {
  const suffix = tx.provider === 'supabase' ? ' FOR UPDATE' : '';
  const userId = session?.user?.id;
  if (typeof userId !== 'string' || typeof session?.sessionTokenHash !== 'string') fail('Inicia sesión para continuar.', 401);
  const user = await tx.db.get(`SELECT active FROM ${tx.t('users')} WHERE id=?${suffix}`, [userId]);
  const row = user?.active === 1 && await tx.db.get(`SELECT expires,csrf FROM ${tx.t('sessions')} WHERE token_hash=? AND user_id=?${suffix}`, [session.sessionTokenHash, userId]);
  if (!row || Number(row.expires) <= Date.now() || row.csrf !== session.csrf) fail('La sesión ya no está activa.', 401);
  return userId;
}

async function assertScope(tx, input, { origin, env = process.env }) {
  const config = await getHekaSettings(tx);
  if (!config.configured || config.environment !== input.environment || config.version !== input.version) scopeChanged();
  if (shippingPushOrigin(env, config.environment) !== origin || !origin) fail('Activa los avisos desde la dirección HTTPS configurada para el administrador.', 403);
  return config;
}

async function provisionVapid(tx, options, now) {
  const ring = keyringFor(options);
  const row = await vapidRow(tx);
  if (row) {
    openShippingPushVapid(row, await ring.read('shipping-push', { required:true }));
    return row.public_key;
  }
  if (await tx.db.get(`SELECT id FROM ${tx.t('shipping_push_subscriptions')} LIMIT 1`)) fail('Falta la clave VAPID original. Restaura la custodia privada y el respaldo de la base.', 422);
  const key = await ring.ensureShippingPush();
  const pair = generateVAPIDKeys();
  const sealed = sealShippingPushVapid(pair.privateKey, key);
  await tx.db.run(`INSERT INTO ${tx.t('shipping_push_vapid')}(id,public_key,ciphertext,iv,auth_tag,created_at) VALUES(1,?,?,?,?,?)`, [pair.publicKey, sealed.ciphertext, sealed.iv, sealed.auth_tag, now]);
  return pair.publicKey;
}

const decryptDevice = (row, key) => JSON.parse(openShippingPushDevice(row, key, row.id, row.user_id, row.environment, row.endpoint_hash));
const sameKeys = (left, right) => left.keys.p256dh === right.keys.p256dh && timingSafeEqual(Buffer.from(left.keys.auth, 'base64url'), Buffer.from(right.keys.auth, 'base64url'));

export async function changeShippingPushDevice(store, input, session, device, options = {}) {
  const action = input?.action;
  if (!['prepare','subscribe','disable'].includes(action)) fail('Acción de notificaciones inválida.');
  const now = stamp();
  let subscription;
  if (action === 'subscribe') {
    await assertScope(store, input, options);
    subscription = validateShippingPushSubscription(input.subscription);
    try { await resolveShippingPushEndpoint(subscription.endpoint, options.lookup); }
    catch (error) {
      if (error.status) throw error;
      fail('No se pudo verificar el servicio de notificaciones de este dispositivo. Vuelve a intentarlo.', 422);
    }
  }
  return store.transaction(async tx => {
    await tx.lockWrites();
    const userId = await assertActiveSession(tx, session);
    if (action === 'disable') {
      await disableShippingPushDeviceTx(tx, userId, device, now);
      return { data:{ deviceEnvironment:null }, device:null };
    }
    const { environment } = await assertScope(tx, input, options);
    if (action === 'prepare') {
      // Assign the cookie before the endpoint exists, so logout in another
      // tab can retire a new device even while enrollment is in flight.
      return { data:{ publicKey:await provisionVapid(tx, options, now) }, device:shippingPushDeviceId(device) ?? randomUUID() };
    }
    const row = await vapidRow(tx);
    if (!row || row.public_key !== input.publicKey) fail('La clave de avisos cambió. Vuelve a activar este dispositivo.', 409);
    const key = await keyringFor(options).read('shipping-push', { required:true });
    openShippingPushVapid(row, key);
    const endpointHash = digest(subscription.endpoint);
    const existing = await tx.db.get(`SELECT * FROM ${tx.t('shipping_push_subscriptions')} WHERE endpoint_hash=?`, [endpointHash]);
    const reserved = shippingPushDeviceId(device);
    const occupied = !existing && reserved && await tx.db.get(`SELECT id FROM ${tx.t('shipping_push_subscriptions')} WHERE id=?`, [reserved]);
    const id = existing?.id ?? (reserved && !occupied ? reserved : randomUUID());
    // Never let a browser rebind an active endpoint to another user's account.
    if (existing && ((existing.user_id !== userId && existing.disabled_at === null) || !sameKeys(decryptDevice(existing, key), subscription))) {
      fail('La suscripción pertenece a otro acceso o ya no coincide. Retírala en este navegador y vuelve a activarla.', 409);
    }
    if (id !== device) await disableShippingPushDeviceTx(tx, userId, device, now);
    if (!existing || existing.disabled_at !== null || existing.user_id !== userId || existing.environment !== environment) {
      const sealed = sealShippingPushDevice(JSON.stringify(subscription), key, id, userId, environment, endpointHash);
      if (existing) {
        await discardShippingPushDeliveriesTx(tx, id);
        await tx.db.run(`UPDATE ${tx.t('shipping_push_subscriptions')} SET user_id=?,environment=?,ciphertext=?,iv=?,auth_tag=?,updated_at=?,disabled_at=NULL WHERE id=?`, [userId, environment, sealed.ciphertext, sealed.iv, sealed.auth_tag, now, id]);
      } else await tx.db.run(`INSERT INTO ${tx.t('shipping_push_subscriptions')}(id,user_id,environment,endpoint_hash,ciphertext,iv,auth_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, [id, userId, environment, endpointHash, sealed.ciphertext, sealed.iv, sealed.auth_tag, now, now]);
    }
    return { data:{ deviceEnvironment:environment }, device:id };
  });
}

async function claimDeliveries(store, now) {
  const work = await store.db.get(`SELECT 1 AS work
    WHERE EXISTS (SELECT 1 FROM ${store.t('shipping_push_deliveries')} WHERE state='pending' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?))
       OR EXISTS (SELECT 1 FROM ${store.t('shipping_push_subscriptions')} s JOIN ${store.t('users')} u ON u.id=s.user_id WHERE s.disabled_at IS NULL AND u.active=0)`, [now, now]);
  if (!work) return [];
  return store.transaction(async tx => {
    await tx.lockWrites();
    await tx.db.run(`UPDATE ${tx.t('shipping_push_subscriptions')} SET disabled_at=?,updated_at=? WHERE disabled_at IS NULL AND user_id IN (SELECT id FROM ${tx.t('users')} WHERE active=0)`, [now, now]);
    const table = tx.t('shipping_push_deliveries');
    const rows = await tx.db.all(`SELECT event_id,subscription_id FROM ${table} WHERE state='pending' AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,event_id,subscription_id LIMIT ${TURN_SIZE}`, [now, now]);
    const until = after(now, LEASE_MS);
    for (const row of rows) {
      row.lease_id = randomUUID();
      await tx.db.run(`UPDATE ${table} SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE event_id=? AND subscription_id=?`, [row.lease_id, until, row.event_id, row.subscription_id]);
    }
    return rows;
  });
}

async function leasedDelivery(store, lease, now) {
  return store.db.get(`SELECT d.attempts,s.*,e.environment AS event_environment,
      CASE WHEN s.disabled_at IS NULL AND u.active=1 AND s.environment=e.environment AND e.connection_id='heka' AND h.ciphertext IS NOT NULL AND h.environment=e.environment AND h.version=e.generation THEN 1 ELSE 0 END AS eligible
      FROM ${store.t('shipping_push_deliveries')} d JOIN ${store.t('shipping_push_subscriptions')} s ON s.id=d.subscription_id
      JOIN ${store.t('users')} u ON u.id=s.user_id JOIN ${store.t('shipping_novelty_events')} e ON e.id=d.event_id
      LEFT JOIN ${store.t('heka_api_settings')} h ON h.id=1
      WHERE d.event_id=? AND d.subscription_id=? AND d.state='pending' AND d.lease_id=? AND d.lease_until>?`, [lease.event_id, lease.subscription_id, lease.lease_id, now]);
}

function retryDelay(result, attempts, now) {
  const hint = typeof result.retryAfter === 'string' ? result.retryAfter : '';
  const server = /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - Date.parse(now);
  return Math.min(3600000, Math.max(30000 * 2 ** (attempts - 1), server || 0));
}

async function finishDelivery(store, lease, result, clock) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const now = clock();
    const current = await leasedDelivery(tx, lease, now);
    if (!current) return;
    if (result.paused && current.eligible) {
      // Local misconfiguration or a missing private volume is not a remote
      // attempt. Retain the queue and wait for the original configuration.
      await tx.db.run(`UPDATE ${tx.t('shipping_push_deliveries')} SET next_at=?,attempts=attempts-1,lease_id=NULL,lease_until=NULL WHERE event_id=? AND subscription_id=? AND lease_id=?`, [after(now,300000), lease.event_id, lease.subscription_id, lease.lease_id]);
      return;
    }
    const status = result.statusCode;
    if ((status === 404 || status === 410) && current.eligible) {
      await disableShippingPushDeviceTx(tx, current.user_id, current.id, now);
      return;
    }
    const delivered = current.eligible && status >= 200 && status < 300;
    const retry = current.eligible && current.attempts < MAX_ATTEMPTS && (result.transient || status === 408 || status === 429 || status >= 500 && status <= 599);
    await tx.db.run(`UPDATE ${tx.t('shipping_push_deliveries')} SET state=?,next_at=?,lease_id=NULL,lease_until=NULL WHERE event_id=? AND subscription_id=? AND lease_id=?`, [delivered?'sent':retry?'pending':'discarded', retry?after(now,retryDelay(result,current.attempts,now)):now, lease.event_id, lease.subscription_id, lease.lease_id]);
  });
}

const deliveryError = error => ({
  statusCode:error.statusCode,
  retryAfter:error.headers?.['retry-after'],
  transient:shippingPushTransient(error),
  paused:error.code?.startsWith('INTEGRATION_KEY_') || error.code === 'INTEGRATION_SECRET_UNREADABLE',
});

async function deliver(store, lease, clock, options) {
  const row = await leasedDelivery(store, lease, clock());
  if (!row) return;
  if (!row.eligible || row.attempts > MAX_ATTEMPTS) return finishDelivery(store, lease, {}, clock);
  const subject = shippingPushOrigin(options.env, row.event_environment);
  if (!subject) return finishDelivery(store, lease, { paused:true }, clock);
  const vapid = await vapidRow(store);
  if (!vapid) return finishDelivery(store, lease, { paused:true }, clock);
  let subscription, vapidDetails, target;
  try {
    const key = await keyringFor(options).read('shipping-push', { required:true });
    subscription = decryptDevice(row, key);
    vapidDetails = { subject, publicKey:vapid.public_key, privateKey:openShippingPushVapid(vapid, key) };
    target = await resolveShippingPushEndpoint(subscription.endpoint, options.lookup);
  } catch (error) {
    return finishDelivery(store, lease, deliveryError(error), clock);
  }
  const current = await leasedDelivery(store, lease, clock());
  if (!current?.eligible) return finishDelivery(store, lease, {}, clock);
  const tag = `ship-${digest(lease.event_id).slice(0, 24)}`;
  let result;
  try {
    result = await (options.send ?? sendShippingPush)(subscription, JSON.stringify({ tag, environment:row.event_environment, eventId:lease.event_id }), { vapidDetails, target, topic:tag });
  } catch (error) {
    result = deliveryError(error);
  }
  return finishDelivery(store, lease, result, clock);
}

export async function processShippingPushTurn(store, { now = stamp(), env = process.env, ...options } = {}) {
  const clock = jobClock(now instanceof Date ? now.toISOString() : typeof now === 'number' ? new Date(now).toISOString() : now);
  const deliveries = await claimDeliveries(store, clock());
  await Promise.all(deliveries.map(lease => deliver(store, lease, clock, { ...options, env })));
  const next = await store.db.get(`SELECT MIN(CASE WHEN lease_until>next_at THEN lease_until ELSE next_at END) AS next_at FROM ${store.t('shipping_push_deliveries')} WHERE state='pending'`);
  return { nextAt:next?.next_at ?? null };
}
