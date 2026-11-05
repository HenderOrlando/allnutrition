import { fail, integer, text } from '../validation-core.mjs';
import { assertLease, audit, hash, insertRow, newId, stamp, updateVersioned } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, renewJob, updateJobProgressTx } from './job-leases.mjs';
import { getSocialConnection } from './social.mjs';
import { BROWSER_COMMANDS, BrowserControlError, createBrowserClient } from '../social/browser-client.mjs';
import { decryptCredentials, saveCredentials } from '../social/credentials.mjs';
import { requireIntegration, secretKey } from '../social/config.mjs';

const identityKeys = ['userId', 'businessId', 'pageId', 'instagramId', 'adAccountId'];
const capabilityKeys = ['facebookPublish', 'instagramPublish', 'adsPublish', 'insights', 'whatsappAds'];
const dataOf = row => JSON.parse(row.data || '{}');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const connectionData = connection => {
  const { id, provider, integrationMethod, state, version, createdAt, updatedAt, ...data } = connection;
  return data;
};
const dto = control => ({ controlId: control.id, state: control.state, expiresAt: control.expires_at });
const leaseOf = control => ({ key: control.lease_key, token: control.lease_token });
function browserClient(options) {
  const env = options.env || process.env, config = requireIntegration('browser', env);
  return options.client || createBrowserClient({ baseUrl: config.browserUrl, controlKey: secretKey('SOCIAL_BROWSER_CONTROL_KEY', env), fetchImpl: options.fetchImpl });
}
async function administrativeSession(store, session, now) {
  if (!session?.user?.id || !session.csrf || !(session.expires > Date.parse(now))) return null;
  return store.db.get(`SELECT s.expires FROM ${store.t('sessions')} s JOIN ${store.t('users')} u ON u.id=s.user_id WHERE s.user_id=? AND s.csrf=? AND s.expires>? AND u.active=1`, [session.user.id, session.csrf, Date.parse(now)]);
}
async function credentialsSnapshot(store, connection, env, allowUnreadable = false) {
  const row = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  let credentials;
  try { credentials = decryptCredentials(connection, row, env); }
  catch (error) { if (!allowUnreadable || error.status !== 409) throw error; credentials = null; }
  return { credentials, credentialVersion: row?.version || 0 };
}
async function claimTx(tx, connection, owner, now, extra = {}) {
  const key = `social:browser-lock:${connection.id}`;
  await queueJobTx(tx, key, { connectionId: connection.id, owner, sessionEpoch: connection.sessionEpoch || 0, previousState: connection.state, sequence: 0, ...extra }, { now });
  // claimJob's transaction is supplied by the already write-locked caller. Queue
  // and claim must be atomic: another administrator cannot replace a queued lock.
  return claimJob({ transaction: fn => fn(tx) }, { key, now });
}
async function quietClose(client, connectionId, sessionEpoch, lease) {
  try { await client.close({ connectionId, sessionEpoch, lease }); } catch { /* The expired token/epoch still fences every later command. */ }
}
async function release(store, lease, now, failed = false) {
  try { await finishJob(store, lease, { now, state: failed ? 'failed' : 'succeeded', errorCode: failed ? 'BROWSER_SESSION_ENDED' : null }); }
  catch (error) { if (error.status !== 409) throw error; }
}
async function assertEpoch(store, connectionId, sessionEpoch, lease, now) {
  try { await assertLease(store, { ...lease, now }); }
  catch (error) { if (error.status === 409) throw new BrowserControlError('LEASE_LOST'); throw error; }
  const current = await getSocialConnection(store, connectionId);
  if (current.integrationMethod !== 'browser' || (current.sessionEpoch || 0) !== sessionEpoch || current.state === 'disconnected') throw new BrowserControlError('LEASE_LOST');
  return current;
}
function guardedClient(client, session, assertActive, signal) {
  const bound = { health: client.health?.bind(client) };
  for (const command of BROWSER_COMMANDS) {
    const name = command.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    bound[name] = async (options = {}) => {
      await assertActive();
      const result = await client[name]({ ...options, ...session, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
      try { await assertActive(); }
      catch (error) {
        if (command === 'execute' || command === 'preflight') throw new BrowserControlError('OPERATION_UNCERTAIN', { uncertain: true });
        throw error;
      }
      return result;
    };
  }
  return bound;
}
async function withHeartbeat(store, client, connection, lease, clock, fn, { signal: outerSignal, check = null } = {}) {
  const controller = new AbortController(), signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  let pending = null, lost = null;
  const sessionEpoch = connection.sessionEpoch || 0;
  const assertActive = async () => {
    if (lost) throw lost;
    if (signal.aborted) throw new BrowserControlError('LEASE_LOST');
    await assertEpoch(store, connection.id, sessionEpoch, lease, clock());
    if (check) await check();
  };
  const timer = setInterval(() => {
    if (pending || lost) return;
    pending = (async () => {
      await assertActive();
      Object.assign(lease, await renewJob(store, lease, { now: clock() }));
      await client.renew({ connectionId: connection.id, sessionEpoch, lease, signal });
      await assertActive();
    })().catch(async error => {
      lost = error.status === 409 && !error.errorCode ? new BrowserControlError('LEASE_LOST') : error;
      controller.abort();
      await quietClose(client, connection.id, sessionEpoch, lease);
    }).finally(() => { pending = null; });
  }, 30000);
  timer.unref();
  try {
    const result = await fn({ client: guardedClient(client, { connectionId: connection.id, sessionEpoch, lease }, assertActive, signal), connection, lease, sessionEpoch, signal, clock, assertActive });
    await assertActive();
    return result;
  } finally {
    clearInterval(timer);
    if (pending) await pending;
    controller.abort();
  }
}

// One durable owner for login, reads and mutations; the runner receives the same
// mutable lease deadline that the database heartbeat renews every thirty seconds.
export async function withBrowserSession(store, connectionId, owner, fn) {
  const options = typeof owner === 'string' ? { owner } : owner || {};
  const ownerId = text(options.owner || options.actorId, 'Dueño del navegador', 100, true);
  const clock = jobClock(options.now || stamp()), client = browserClient(options), env = options.env || process.env;
  await expireControls(store, connectionId, client, clock);
  const { connection, lease, credentials, credentialVersion } = await store.transaction(async tx => {
    await tx.lockWrites();
    const connection = await getSocialConnection(tx, connectionId);
    if (connection.integrationMethod !== 'browser') fail('La conexión no corresponde al navegador.', 409);
    const repairable = options.purpose === 'pause' && ['layout_changed', 'reconnect_required'].includes(connection.state) || options.purpose === 'validate' && connection.state === 'layout_changed';
    if (connection.state !== 'connected' && !repairable) fail('La sesión social requiere intervención antes de continuar.', 409);
    const snapshot = await credentialsSnapshot(tx, connection, env);
    if (!snapshot.credentials?.storageState) fail('La conexión necesita autenticarse de nuevo.', 409);
    const lease = await claimTx(tx, connection, ownerId, clock());
    return { connection, lease, ...snapshot };
  });
  let failed = true;
  try {
    const result = await withHeartbeat(store, client, connection, lease, clock, async session => {
      const result = await fn({ ...session, credentials, credentialVersion });
      // Persist rotated cookies only while the original epoch, exclusive owner,
      // and credential version still hold. No state is written after revocation.
      const exported = await session.client.exportState({ payload: { purpose: options.purpose === 'pause' ? 'pause' : 'worker' } });
      if (!exported.data?.storageState) throw new BrowserControlError('LAYOUT_CHANGED');
      await store.transaction(async tx => {
        await tx.lockWrites();
        await assertEpoch(tx, connectionId, session.sessionEpoch, lease, clock());
        await saveCredentials({ transaction: fn => fn(tx) }, connectionId, { storageState: exported.data.storageState }, { env, expectedVersion: credentialVersion, sessionEpoch: session.sessionEpoch, lease: { ...lease, now: clock() } });
        await assertEpoch(tx, connectionId, session.sessionEpoch, lease, clock());
      });
      return result;
    }, options);
    failed = false;
    return result;
  } catch (error) {
    const state = { SESSION_EXPIRED: 'reconnect_required', CHALLENGE_REQUIRED: 'challenge_required', LAYOUT_CHANGED: 'layout_changed', ACCOUNT_MISMATCH: 'reconnect_required' }[error.errorCode];
    if (state) {
      try {
        await store.transaction(async tx => {
          await tx.lockWrites();
          const current = await assertEpoch(tx, connectionId, connection.sessionEpoch || 0, lease, clock());
          await updateVersioned(tx, 'social_connections', connectionId, current.version, { state });
          await audit(tx, { entityType: 'social_connection', entityId: connectionId, actorId: ownerId, next: { state }, reason: 'Estado de sesión observado por el navegador' });
        });
      } catch (fence) { if (![404, 409].includes(fence.status)) throw fence; }
    }
    throw error;
  } finally {
    await quietClose(client, connectionId, connection.sessionEpoch || 0, lease);
    await release(store, lease, clock(), failed);
  }
}

async function endControlTx(tx, control, state, now) {
  const changed = await tx.db.run(`UPDATE ${tx.t('social_browser_controls')} SET state=?,updated_at=? WHERE id=? AND state='active'`, [state, now, control.id]);
  if (!changed.changes) return;
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL,finished_at=?,updated_at=?,error_code='BROWSER_CONTROL_ENDED',version=version+1 WHERE key=? AND lease_token=? AND state='running'`, [now, now, control.lease_key, control.lease_token]);
  const connection = await getSocialConnection(tx, control.connection_id);
  if (['login_in_progress', 'challenge_required'].includes(connection.state)) {
    const job = await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`, [control.lease_key]);
    const priorState = dataOf(job || {}).previousState;
    await updateVersioned(tx, 'social_connections', connection.id, connection.version, { state: ['connected', 'reconnect_required', 'layout_changed', 'challenge_required'].includes(priorState) ? priorState : 'login_required' });
  }
  await audit(tx, { entityType: 'social_browser_control', entityId: control.id, actorId: control.actor_id, next: { state }, reason: 'Control de login finalizado' });
}
async function expireControls(store, connectionId, client, clock) {
  const expired = await store.transaction(async tx => {
    await tx.lockWrites();
    const controls = await tx.db.all(`SELECT * FROM ${tx.t('social_browser_controls')} WHERE connection_id=? AND state='active'`, [connectionId]), ended = [];
    for (const control of controls) {
      const sessions = await tx.db.all(`SELECT s.csrf FROM ${tx.t('sessions')} s JOIN ${tx.t('users')} u ON u.id=s.user_id WHERE s.user_id=? AND s.expires>? AND u.active=1`, [control.actor_id, Date.parse(clock())]);
      const job = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [control.lease_key]);
      const connection = await getSocialConnection(tx, connectionId);
      if (control.expires_at > clock() && sessions.some(session => hash(session.csrf) === control.session_binding) && job?.state === 'running' && job.lease_token === control.lease_token && job.lease_until > clock() && dataOf(job).sessionEpoch === (connection.sessionEpoch || 0) && connection.state !== 'disconnected') continue;
      await endControlTx(tx, control, 'expired', clock());
      ended.push({ sessionEpoch: job?.lease_token === control.lease_token ? dataOf(job).sessionEpoch : connection.sessionEpoch || 0, lease: { ...leaseOf(control), leaseUntil: job?.lease_until || clock() } });
    }
    return ended;
  });
  for (const entry of expired) await quietClose(client, connectionId, entry.sessionEpoch, entry.lease);
}
async function checkedControl(store, connectionId, controlId, session, now) {
  if (!await administrativeSession(store, session, now)) fail('La sesión administrativa venció.', 401);
  const control = await store.db.get(`SELECT * FROM ${store.t('social_browser_controls')} WHERE id=? AND connection_id=?`, [text(controlId, 'Control', 100, true), connectionId]);
  if (!control) fail('Control de navegador no encontrado.', 404);
  if (control.actor_id !== session.user.id || control.session_binding !== hash(session.csrf)) fail('El control pertenece a otra sesión administrativa.', 403);
  if (control.state !== 'active' || control.expires_at <= now) fail('El control de navegador finalizó.', 409);
  const job = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [control.lease_key]);
  const lease = { ...leaseOf(control), leaseUntil: job?.lease_until };
  const connection = await assertEpoch(store, connectionId, dataOf(job || {}).sessionEpoch, lease, now);
  return { control, lease, connection, jobData: dataOf(job) };
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 4096) fail('Entrada del visor no válida.');
  const allowed = {
    click: ['kind', 'x', 'y'], type: ['kind', 'text'], key: ['kind', 'key', 'shift'], scroll: ['kind', 'deltaX', 'deltaY']
  }[input.kind];
  if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) fail('Entrada del visor no válida.');
  if (input.kind === 'click') { integer(input.x, 'Coordenada horizontal', 0, 1279); integer(input.y, 'Coordenada vertical', 0, 799); }
  if (input.kind === 'type' && (typeof input.text !== 'string' || !input.text || input.text.length > 2048)) fail('Texto del visor no válido.');
  if (input.kind === 'key' && !['Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space'].includes(input.key)) fail('Tecla del visor no permitida.');
  if (input.kind === 'key' && input.shift !== undefined && typeof input.shift !== 'boolean') fail('Modificador de teclado no permitido.');
  if (input.kind === 'scroll') { integer(input.deltaX, 'Desplazamiento horizontal', -1600, 1600); integer(input.deltaY, 'Desplazamiento vertical', -1600, 1600); }
}
function observedConnection(result) {
  if (result?.state !== 'connected' || typeof result.identities?.userId !== 'string' || !result.identities.userId) throw new BrowserControlError('LAYOUT_CHANGED');
  const identities = pick(result.identities, [...identityKeys, 'userName']);
  const resources = {
    businesses: (result.resources?.businesses || []).map(resource => pick(resource, ['id', 'name'])),
    pages: (result.resources?.pages || []).map(resource => pick(resource, ['id', 'name', 'tasks', 'businessId', 'instagramId', 'whatsappNumber'])),
    adAccounts: (result.resources?.adAccounts || []).map(resource => pick(resource, ['id', 'name', 'currency', 'timeZone', 'businessId', 'accountStatus']))
  };
  if (resources.businesses.length && !resources.businesses.some(resource => resource.id === identities.businessId)) throw new BrowserControlError('ACCOUNT_MISMATCH');
  for (const [identity, collection] of [['pageId', 'pages'], ['adAccountId', 'adAccounts']]) if (identities[identity] && !resources[collection].some(resource => resource.id === identities[identity])) throw new BrowserControlError('ACCOUNT_MISMATCH');
  return { identities, resources, capabilities: Object.fromEntries(capabilityKeys.map(key => [key, result.capabilities?.[key] === true])), currency: result.currency || null, timeZone: result.timeZone || null, locale: result.locale || null, adapterVersion: 'meta-ui-v2', resourceNotice: !resources.pages.length && !resources.adAccounts.length ? 'La sesión está conectada, pero no se encontraron recursos profesionales elegibles.' : null };
}
async function markLoginState(store, controlId, state, session, clock) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const row = await tx.db.get(`SELECT connection_id FROM ${tx.t('social_browser_controls')} WHERE id=?`, [controlId]);
    if (!row) fail('Control de navegador no encontrado.', 404);
    const { connection } = await checkedControl(tx, row.connection_id, controlId, session, clock());
    if (connection.state !== state) {
      await updateVersioned(tx, 'social_connections', connection.id, connection.version, { state });
      await audit(tx, { entityType: 'social_browser_control', entityId: controlId, actorId: session.user.id, next: { state }, reason: 'Estado de login observado' });
    }
    return { controlId, state };
  });
}

export async function socialBrowserAction(store, connectionId, action, input, session, options = {}) {
  if (!['start-login', 'read-frame', 'send-input', 'finish-login', 'cancel-login'].includes(action)) fail('Acción de navegador no válida.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 4096) fail('Solicitud del visor demasiado grande.', 413);
  const client = browserClient(options), env = options.env || process.env, clock = jobClock(options.now || stamp());
  await expireControls(store, connectionId, client, clock);
  if (!await administrativeSession(store, session, clock())) fail('La sesión administrativa venció.', 401);
  if (action === 'start-login') {
    const opened = await store.transaction(async tx => {
      await tx.lockWrites();
      const administrative = await administrativeSession(tx, session, clock());
      if (!administrative) fail('La sesión administrativa venció.', 401);
      const connection = await getSocialConnection(tx, connectionId);
      if (connection.integrationMethod !== 'browser') fail('La conexión no corresponde al navegador.', 409);
      const prior = await tx.db.get(`SELECT * FROM ${tx.t('social_browser_controls')} WHERE connection_id=? AND state='active'`, [connectionId]);
      if (prior) {
        if (prior.actor_id !== session.user.id || prior.session_binding !== hash(session.csrf)) fail('Otro administrador está usando el navegador.', 409);
        return { prior };
      }
      const snapshot = await credentialsSnapshot(tx, connection, env, true);
      const controlId = newId(), expiresAt = new Date(Math.min(Date.parse(clock()) + 900000, session.expires, Number(administrative.expires))).toISOString();
      const lease = await claimTx(tx, connection, session.user.id, clock(), { controlId, credentialVersion: snapshot.credentialVersion });
      const control = { id: controlId, connection_id: connectionId, actor_id: session.user.id, session_binding: hash(session.csrf), lease_key: lease.key, lease_token: lease.token, state: 'active', expires_at: expiresAt, last_seen_at: clock(), created_at: clock(), updated_at: clock() };
      await insertRow(tx, 'social_browser_controls', control);
      await updateVersioned(tx, 'social_connections', connectionId, connection.version, { state: 'login_in_progress' });
      await audit(tx, { entityType: 'social_browser_control', entityId: controlId, actorId: session.user.id, next: { state: 'active' }, reason: 'Inicio de login asistido' });
      return { connection, lease, control, ...snapshot };
    });
    if (opened.prior) return { ...dto(opened.prior), state: 'login_in_progress' };
    try {
      await withHeartbeat(store, client, opened.connection, opened.lease, clock, context => context.client.open({ payload: { storageState: opened.credentials?.storageState || null, expectedIdentities: opened.connection.identities || {}, purpose: 'login' } }), { signal: options.signal, check: () => checkedControl(store, connectionId, opened.control.id, session, clock()) });
      return { ...dto(opened.control), state: 'login_in_progress' };
    } catch (error) {
      await store.transaction(async tx => { await tx.lockWrites(); await endControlTx(tx, opened.control, 'cancelled', clock()); });
      await quietClose(client, connectionId, opened.connection.sessionEpoch || 0, opened.lease);
      throw error;
    }
  }
  const current = await checkedControl(store, connectionId, input.controlId, session, clock());
  const { connection, control } = current;
  if (action === 'cancel-login') {
    await store.transaction(async tx => { await tx.lockWrites(); await checkedControl(tx, connectionId, control.id, session, clock()); await endControlTx(tx, control, 'cancelled', clock()); });
    await quietClose(client, connectionId, connection.sessionEpoch || 0, current.lease);
    return { ...dto(control), state: 'cancelled' };
  }
  if (action === 'send-input') { integer(input.sequence, 'Secuencia', 1, Number.MAX_SAFE_INTEGER); validateInput(input.input); }
  const lease = await renewJob(store, current.lease, { now: clock() });
  const check = () => checkedControl(store, connectionId, control.id, session, clock());
  try {
    await client.renew({ connectionId, sessionEpoch: connection.sessionEpoch || 0, lease, signal: options.signal });
    return await withHeartbeat(store, client, connection, lease, clock, async context => {
      await store.transaction(async tx => { await tx.lockWrites(); await checkedControl(tx, connectionId, control.id, session, clock()); await tx.db.run(`UPDATE ${tx.t('social_browser_controls')} SET last_seen_at=?,updated_at=? WHERE id=?`, [clock(), clock(), control.id]); });
      if (action === 'read-frame') return context.client.frame();
      if (action === 'send-input') {
        const duplicate = await store.transaction(async tx => {
          await tx.lockWrites();
          const current = await checkedControl(tx, connectionId, control.id, session, clock());
          const sequence = current.jobData.sequence || 0;
          if (input.sequence <= sequence) return true;
          if (input.sequence !== sequence + 1) fail('La secuencia del visor no es consecutiva.', 409);
          await updateJobProgressTx(tx, lease, { sequence: input.sequence }, { now: clock() });
          return false;
        });
        let result;
        if (!duplicate) result = await context.client.input({ payload: { sequence: input.sequence, input: input.input } });
        return { controlId: control.id, state: result?.data?.authenticated === true || result?.data?.inputAllowed === false ? 'authenticated' : connection.state, sequence: input.sequence, duplicate };
      }
      const response = await context.client.inspect({ payload: { kind: 'connection', expectedIdentities: connection.identities || {} } });
      if (response.data?.state === 'challenge_required') return markLoginState(store, control.id, 'challenge_required', session, clock);
      if (response.status !== 'confirmed' || response.data?.state === 'login_required') return markLoginState(store, control.id, 'login_in_progress', session, clock);
      const observed = observedConnection(response.data);
      for (const key of identityKeys) if (connection.identities?.[key] && connection.identities[key] !== observed.identities[key]) throw new BrowserControlError('ACCOUNT_MISMATCH');
      const exported = await context.client.exportState();
      if (!exported.data?.storageState) throw new BrowserControlError('LAYOUT_CHANGED');
      await store.transaction(async tx => {
        await tx.lockWrites();
        const latest = await checkedControl(tx, connectionId, control.id, session, clock());
        // saveCredentials joins this transaction, keeping session validity,
        // control/epoch fencing and the credential CAS in one atomic commit.
        await saveCredentials({ transaction: fn => fn(tx) }, connectionId, { storageState: exported.data.storageState }, { env, expectedVersion: latest.jobData.credentialVersion, sessionEpoch: context.sessionEpoch, lease: { ...lease, now: clock() } });
        await checkedControl(tx, connectionId, control.id, session, clock());
        await updateVersioned(tx, 'social_connections', connectionId, latest.connection.version, { state: 'connected', data: JSON.stringify({ ...connectionData(latest.connection), ...observed, validatedAt: clock() }) });
        await tx.db.run(`UPDATE ${tx.t('social_browser_controls')} SET state='completed',updated_at=? WHERE id=? AND state='active'`, [clock(), control.id]);
        await audit(tx, { entityType: 'social_browser_control', entityId: control.id, actorId: session.user.id, next: { state: 'completed' }, reason: 'Identidad y sesión social verificadas' });
      });
      return { ...dto(control), state: 'connected' };
    }, { signal: options.signal, check: async () => {
      // A successfully completed control remains valid only for this final
      // heartbeat check; it can never authorize another frame or input.
      const row = await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.id]);
      if (action === 'finish-login' && row?.state === 'completed') {
        if (!await administrativeSession(store, session, clock())) fail('La sesión administrativa venció.', 401);
      } else await check();
    } });
  } catch (error) {
    if (error.errorCode === 'CHALLENGE_REQUIRED') return markLoginState(store, control.id, 'challenge_required', session, clock);
    const state = { LAYOUT_CHANGED: 'layout_changed', SESSION_EXPIRED: 'reconnect_required' }[error.errorCode];
    if (state) {
      await markLoginState(store, control.id, state, session, clock);
      await store.transaction(async tx => { await tx.lockWrites(); await endControlTx(tx, control, 'expired', clock()); });
      await quietClose(client, connectionId, connection.sessionEpoch || 0, lease);
    }
    await expireControls(store, connectionId, client, clock);
    throw error;
  } finally {
    const latest = await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.id]);
    if (latest?.state === 'completed') {
      await quietClose(client, connectionId, connection.sessionEpoch || 0, lease);
      await release(store, lease, clock());
    }
  }
}
