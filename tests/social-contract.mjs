import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { entity, hash, insertRow, stamp } from '../lib/business/commands.mjs';
import { encryptCredentials, decryptCredentials, loadCredentials, saveCredentials, sanitizeBrowserState } from '../lib/social/credentials.mjs';
import { integrationRequirements } from '../lib/social/config.mjs';
import { socialBrowserAction, withBrowserSession } from '../lib/business/social-browser.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';
import { socialConnectionAction } from '../lib/business/social-connections.mjs';
import { BrowserControlError } from '../lib/social/browser-client.mjs';
import { exportCommercialData } from '../lib/business-backup.mjs';

export const socialTestEnv = () => Object.fromEntries(['SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY'].map(key => [key, randomBytes(32).toString('base64')]));
export async function socialConnection(store, { method = 'api', state = 'connected', data = {} } = {}) {
  const id = randomUUID(), at = stamp();
  await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: method, state, data: JSON.stringify({ name: 'Cuenta sintética', sessionEpoch: 0, ...data }), version: 1, created_at: at, updated_at: at });
  return entity(await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id=?`, [id]));
}
async function browserAdmin(store, { userId = randomUUID(), lifetime = 3600000 } = {}) {
  if (!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE id=?`, [userId])) await insertRow(store, 'users', { id: userId, email: `${userId}@example.test`, password: 'synthetic-not-used', active: 1 });
  const session = { user: { id: userId }, csrf: randomBytes(32).toString('hex'), expires: Date.now() + lifetime };
  await insertRow(store, 'sessions', { token_hash: hash(randomUUID()), user_id: userId, csrf: session.csrf, expires: session.expires });
  return session;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function browserTransport() {
  // This fixture owns authentication and resources independently of the requested
  // spec/identities. The Chromium/DOM fixture is exercised by social-browser.test.
  const fixture = {
    authenticated: false, challenge: false, cookieValid: true, inputs: 0, frames: 0, closes: 0, renewals: 0, session: null, beforeExport: null,
    identities: { userId: 'ui-user', businessId: 'ui-business' },
    resources: { businesses: [{ id: 'ui-business', name: 'Negocio visible' }], pages: [], adAccounts: [] },
    storageState: { cookies: [{ name: 'auth', value: 'COOKIE-CANARIO-SOCIAL', domain: '.facebook.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }
  };
  function assertSession(options) {
    if (!fixture.session || options.connectionId !== fixture.session.connectionId || options.sessionEpoch !== fixture.session.sessionEpoch || options.lease.token !== fixture.session.token) throw new BrowserControlError('LEASE_LOST');
  }
  fixture.client = {
    async open(options) {
      if (fixture.session && fixture.session.token !== options.lease.token) throw new BrowserControlError('BROWSER_BUSY');
      fixture.session = { connectionId: options.connectionId, sessionEpoch: options.sessionEpoch, token: options.lease.token };
      if (options.payload.storageState?.cookies.some(cookie => cookie.value === fixture.storageState.cookies[0].value) && fixture.cookieValid) fixture.authenticated = true;
      if (options.payload.purpose === 'worker' && (!fixture.authenticated || !fixture.cookieValid)) throw new BrowserControlError('SESSION_EXPIRED');
      return { status: 'confirmed', data: { state: fixture.authenticated ? 'connected' : 'login_required' } };
    },
    async renew(options) { assertSession(options); fixture.renewals++; return { status: 'confirmed', data: {} }; },
    async frame(options) { assertSession(options); fixture.frames++; return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
    async input(options) { assertSession(options); if (fixture.authenticated) throw new BrowserControlError('AUTH_FAILED'); fixture.inputs++; return { status: 'confirmed', data: { authenticated: false, inputAllowed: true } }; },
    async inspect(options) {
      assertSession(options);
      if (fixture.challenge) return { status: 'pending', data: { state: 'challenge_required', authenticated: false } };
      if (!fixture.authenticated) return { status: 'pending', data: { state: 'login_required', authenticated: false } };
      return { status: 'confirmed', data: { state: 'connected', identities: fixture.identities, resources: fixture.resources, capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: false, whatsappAds: false }, locale: 'es-CO', currency: null, timeZone: null } };
    },
    async exportState(options) { assertSession(options); if (fixture.beforeExport) await fixture.beforeExport(); return { status: 'confirmed', data: { storageState: fixture.storageState } }; },
    async close(options) { if (fixture.session?.token === options.lease.token && fixture.session?.sessionEpoch === options.sessionEpoch) { fixture.session = null; fixture.closes++; } return { status: 'confirmed', data: {} }; }
  };
  return fixture;
}
async function browserSetup(store, extra = {}) {
  const env = { ...socialTestEnv(), SOCIAL_BROWSER_ENABLED: 'true' }, fixture = browserTransport();
  const session = await browserAdmin(store, extra), connection = await socialConnection(store, { method: 'browser', state: 'login_required' });
  const options = { env, client: fixture.client };
  const action = (name, input = {}, administrative = session, changes = {}) => socialBrowserAction(store, connection.id, name, input, administrative, { ...options, ...changes });
  return { env, fixture, session, connection, options, action };
}
async function finishBrowserLogin(setup) {
  const control = await setup.action('start-login');
  setup.fixture.authenticated = true;
  const result = await setup.action('finish-login', { controlId: control.controlId });
  assert.equal(result.state, 'connected');
  return control;
}
const cases = [
  ['la pérdida de heartbeat después de enviar conserva incertidumbre, no la convierte en fallo de validación', async (store, t) => {
    const setup = await browserSetup(store); await finishBrowserLogin(setup);
    const sent = deferred(), released = deferred(), closed = deferred();
    let remotePublications = 0;
    const close = setup.fixture.client.close;
    setup.fixture.client.close = async options => { const result = await close(options); closed.resolve(); return result; };
    setup.fixture.client.execute = async () => {
      remotePublications++; sent.resolve(); await released.promise;
      return { status: 'confirmed', data: { remoteRefs: { postId: 'fixture-post-1' } } };
    };
    t.mock.timers.enable({ apis: ['setInterval'] });
    const publishing = withBrowserSession(store, setup.connection.id, { ...setup.options, owner: 'scheduler' }, async context => {
      await context.client.open({ payload: { storageState: context.credentials.storageState, purpose: 'worker' } });
      return context.client.execute({ payload: { operation: { state: 'sent', step: 'publish' } } });
    });
    const observed = assert.rejects(publishing, error => {
      assert.equal(error.errorCode, 'OPERATION_UNCERTAIN');
      assert.equal(error.uncertain, true);
      return true;
    });
    await sent.promise;
    await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_token=? WHERE key=?`, [randomUUID(), `social:browser-lock:${setup.connection.id}`]);
    t.mock.timers.tick(30000);
    await closed.promise; released.resolve();
    await observed;
    assert.equal(remotePublications, 1);
  }],
  ['perder el lease durante una consulta aborta el dueño anterior sin sobrescribir credenciales ni el nuevo lock', async store => {
    const setup = await browserSetup(store); await finishBrowserLogin(setup);
    const entered = deferred(), proceed = deferred();
    const query = withBrowserSession(store, setup.connection.id, { ...setup.options, owner: 'scheduler' }, async context => {
      await context.client.open({ payload: { storageState: context.credentials.storageState, purpose: 'worker' } });
      entered.resolve(); await proceed.promise;
      await context.client.inspect({ payload: { kind: 'connection' } });
    });
    await entered.promise;
    const token = randomUUID(), key = `social:browser-lock:${setup.connection.id}`;
    await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_token=?,version=version+1 WHERE key=?`, [token, key]);
    proceed.resolve();
    await assert.rejects(() => query, { status: 409 });
    assert.equal((await store.db.get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`, [key])).lease_token, token);
    assert.equal((await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id])).version, 1);
    assert.equal(setup.fixture.session, null);
  }],
  ['desconectar revoca controles y estado guardado con una nueva época, sin reutilizar el visor anterior', async store => {
    const setup = await browserSetup(store); await finishBrowserLogin(setup);
    const control = await setup.action('start-login'), current = await getSocialConnection(store, setup.connection.id);
    await socialConnectionAction(store, current.id, 'disconnect', { version: current.version, requestId: randomUUID() }, setup.session.user.id, setup.options);
    const disconnected = await getSocialConnection(store, current.id);
    assert.equal(disconnected.state, 'disconnected');
    assert.equal(disconnected.sessionEpoch, current.sessionEpoch + 1);
    assert.equal(await loadCredentials(store, disconnected, setup.env), null);
    assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.controlId])).state, 'cancelled');
    assert.equal(setup.fixture.session, null);
    await assert.rejects(() => setup.action('read-frame', { controlId: control.controlId }), { status: 409 });
    const replacement = await setup.action('start-login');
    assert.notEqual(replacement.controlId, control.controlId);
    await setup.action('cancel-login', { controlId: replacement.controlId });
  }],
  ['el login pertenece al actor y a la sesión que lo abrió, nunca a otra pestaña administrativa', async store => {
    const setup = await browserSetup(store), control = await setup.action('start-login');
    const otherSession = await browserAdmin(store, { userId: setup.session.user.id }), otherActor = await browserAdmin(store);
    for (const administrative of [otherSession, otherActor]) {
      await assert.rejects(() => setup.action('read-frame', { controlId: control.controlId }, administrative), { status: 403 });
      await assert.rejects(() => setup.action('start-login', {}, administrative), { status: 409 });
    }
    assert.equal(setup.fixture.frames, 0);
    assert.equal((await setup.action('read-frame', { controlId: control.controlId })).subarray(0, 2).toString('hex'), 'ffd8');
    const current = await store.db.get(`SELECT * FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.controlId]);
    assert.equal(current.session_binding, hash(setup.session.csrf));
    assert.ok(Date.parse(control.expiresAt) <= Date.parse(current.created_at) + 900000);
    await setup.action('cancel-login', { controlId: control.controlId });
    assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.controlId])).state, 'cancelled');
  }],
  ['revocar o vencer la sesión administrativa cierra el visor antes del próximo frame o teclado', async store => {
    for (const revoke of ['logout', 'inactive', 'expired']) {
      const setup = await browserSetup(store, { lifetime: 60000 }), control = await setup.action('start-login');
      assert.ok(Date.parse(control.expiresAt) <= setup.session.expires);
      if (revoke === 'logout') await store.db.run(`DELETE FROM ${store.t('sessions')} WHERE user_id=?`, [setup.session.user.id]);
      if (revoke === 'inactive') await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [setup.session.user.id]);
      if (revoke === 'expired') await store.db.run(`UPDATE ${store.t('sessions')} SET expires=? WHERE user_id=?`, [Date.now() - 1, setup.session.user.id]);
      await assert.rejects(() => setup.action('read-frame', { controlId: control.controlId }), { status: 401 });
      assert.equal(setup.fixture.frames, 0);
      assert.equal((await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`, [control.controlId])).state, 'expired');
      assert.equal((await store.db.get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser-lock:${setup.connection.id}`])).lease_token, null);
      assert.equal(setup.fixture.session, null);
    }
  }],
  ['la caducidad del control o del lease no permite retomar el token anterior', async store => {
    for (const kind of ['control', 'lease']) {
      const setup = await browserSetup(store), control = await setup.action('start-login');
      const old = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser-lock:${setup.connection.id}`]);
      if (kind === 'control') await store.db.run(`UPDATE ${store.t('social_browser_controls')} SET expires_at=? WHERE id=?`, [new Date(Date.now() - 1).toISOString(), control.controlId]);
      else await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_until=? WHERE key=?`, [new Date(Date.now() - 1).toISOString(), old.key]);
      await assert.rejects(() => setup.action('send-input', { controlId: control.controlId, sequence: 1, input: { kind: 'key', key: 'Enter' } }), { status: 409 });
      const replacement = await setup.action('start-login');
      assert.notEqual(replacement.controlId, control.controlId);
      assert.notEqual((await store.db.get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`, [old.key])).lease_token, old.lease_token);
      await setup.action('cancel-login', { controlId: replacement.controlId });
    }
  }],
  ['el teclado se deduplica por número sin persistir contraseñas, OTP, frames ni hashes del contenido', async store => {
    const setup = await browserSetup(store), control = await setup.action('start-login');
    const canaries = ['PASSWORD-CANARIO-SOCIAL', 'OTP-CANARIO-943728'];
    for (const [index, value] of canaries.entries()) {
      const input = { controlId: control.controlId, sequence: index + 1, input: { kind: 'type', text: value } };
      await setup.action('send-input', input);
      assert.equal((await setup.action('send-input', input)).duplicate, true);
    }
    assert.equal(setup.fixture.inputs, 2);
    await assert.rejects(() => setup.action('send-input', { controlId: control.controlId, sequence: 3, input: { kind: 'key', key: 'F12' } }), { status: 400 });
    await assert.rejects(() => setup.action('send-input', { controlId: control.controlId, sequence: 3, input: { kind: 'click', x: 1280, y: 0 } }), { status: 400 });
    await assert.rejects(() => setup.action('send-input', { controlId: control.controlId, sequence: 3, input: { kind: 'key', key: 'L', ctrl: true } }), { status: 400 });
    await setup.action('send-input', { controlId: control.controlId, sequence: 3, input: { kind: 'key', key: 'Tab', shift: true } });
    setup.fixture.authenticated = true;
    await setup.action('finish-login', { controlId: control.controlId });
    const connection = await getSocialConnection(store, setup.connection.id), saved = await loadCredentials(store, connection, setup.env);
    assert.equal(saved.storageState.cookies[0].value, 'COOKIE-CANARIO-SOCIAL');
    const persisted = JSON.stringify(await Promise.all(['social_connections', 'social_credentials', 'social_browser_controls', 'job_runs', 'business_audit', 'business_requests'].map(table => store.db.all(`SELECT * FROM ${store.t(table)}`))));
    for (const canary of [...canaries, 'COOKIE-CANARIO-SOCIAL']) {
      assert.equal(persisted.includes(canary), false);
      assert.equal(persisted.includes(hash(canary)), false);
    }
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), []);
    const backup = JSON.stringify(await store.readSnapshot(exportCommercialData));
    for (const canary of [...canaries, 'COOKIE-CANARIO-SOCIAL']) assert.equal(backup.includes(canary), false);
    await assert.rejects(() => setup.action('read-frame', { controlId: control.controlId }), { status: 409 });
  }],
  ['desafíos no completan login y una identidad ajena nunca reemplaza la conexión', async store => {
    const setup = await browserSetup(store), control = await setup.action('start-login');
    setup.fixture.challenge = true;
    assert.equal((await setup.action('finish-login', { controlId: control.controlId })).state, 'challenge_required');
    assert.equal(await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id]), null);
    setup.fixture.challenge = false; setup.fixture.authenticated = true;
    await setup.action('finish-login', { controlId: control.controlId });
    const prior = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id]);
    const reconnect = await setup.action('start-login');
    setup.fixture.identities = { userId: 'different-user', businessId: 'ui-business' };
    await assert.rejects(() => setup.action('finish-login', { controlId: reconnect.controlId }), error => error.errorCode === 'ACCOUNT_MISMATCH');
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id]), prior);
    assert.equal((await getSocialConnection(store, setup.connection.id)).identities.userId, 'ui-user');
    await setup.action('cancel-login', { controlId: reconnect.controlId });
  }],
  ['un usuario verificado sin recursos queda conectado sin capacidades inventadas', async store => {
    const setup = await browserSetup(store);
    setup.fixture.identities = { userId: 'ui-user' };
    setup.fixture.resources.businesses = [];
    await finishBrowserLogin(setup);
    const current = await getSocialConnection(store, setup.connection.id);
    assert.equal(current.state, 'connected');
    assert.deepEqual(current.resources, { businesses: [], pages: [], adAccounts: [] });
    assert.equal(Object.values(current.capabilities).some(Boolean), false);
    assert.ok(current.resourceNotice);
  }],
  ['un solo dueño excluye workers y login, libera el lock al terminar y renueva cookies con CAS', async store => {
    const setup = await browserSetup(store); await finishBrowserLogin(setup);
    const entered = deferred(), proceed = deferred(), owner = { ...setup.options, owner: 'scheduler' };
    const first = withBrowserSession(store, setup.connection.id, owner, async context => {
      await context.client.open({ payload: { storageState: context.credentials.storageState, expectedIdentities: context.connection.identities, purpose: 'worker' } });
      entered.resolve(); await proceed.promise;
      await context.assertActive();
      return 'read-completed';
    });
    await entered.promise;
    await assert.rejects(() => withBrowserSession(store, setup.connection.id, { ...owner, owner: 'other-worker' }, () => assert.fail('No debe entrar')), { status: 409 });
    await assert.rejects(() => setup.action('start-login'), { status: 409 });
    proceed.resolve(); assert.equal(await first, 'read-completed');
    const job = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser-lock:${setup.connection.id}`]);
    assert.equal(job.state, 'succeeded'); assert.equal(job.lease_token, null);
    assert.equal((await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id])).version, 2);
    const reconnect = await setup.action('start-login'); await setup.action('cancel-login', { controlId: reconnect.controlId });
  }],
  ['la pérdida de época o CAS impide guardar estado tardío después de exportarlo', async store => {
    for (const change of ['epoch', 'credential']) {
      const setup = await browserSetup(store), control = await setup.action('start-login');
      setup.fixture.authenticated = true;
      const entered = deferred(), proceed = deferred();
      setup.fixture.beforeExport = async () => { entered.resolve(); await proceed.promise; };
      const finish = setup.action('finish-login', { controlId: control.controlId });
      await entered.promise;
      if (change === 'epoch') {
        const current = await getSocialConnection(store, setup.connection.id);
        await store.db.run(`UPDATE ${store.t('social_connections')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ name: current.name, sessionEpoch: 1 }), current.id]);
      } else await saveCredentials(store, setup.connection.id, { storageState: { cookies: [], origins: [] } }, { env: setup.env });
      proceed.resolve();
      await assert.rejects(() => finish, { status: 409 });
      const saved = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [setup.connection.id]);
      if (change === 'epoch') assert.equal(saved, null);
      else assert.deepEqual((await loadCredentials(store, await getSocialConnection(store, setup.connection.id), setup.env)).storageState, { cookies: [], origins: [] });
      if (change === 'credential') await setup.action('cancel-login', { controlId: control.controlId });
    }
  }],
  ['validar navegador usa el lock y sus recursos observados, y la sesión expirada bloquea nuevas lecturas', async store => {
    const setup = await browserSetup(store); await finishBrowserLogin(setup);
    let current = await getSocialConnection(store, setup.connection.id);
    const validated = await socialConnectionAction(store, current.id, 'validate', { version: current.version, requestId: randomUUID() }, setup.session.user.id, setup.options);
    assert.equal(validated.state, 'connected');
    assert.equal(validated.identities.userId, 'ui-user');
    assert.equal(setup.fixture.session, null);
    setup.fixture.cookieValid = false;
    current = await getSocialConnection(store, current.id);
    await assert.rejects(() => socialConnectionAction(store, current.id, 'validate', { version: current.version, requestId: randomUUID() }, setup.session.user.id, setup.options), error => error.errorCode === 'SESSION_EXPIRED');
    assert.equal((await getSocialConnection(store, current.id)).state, 'reconnect_required');
  }],
  ['las credenciales cifradas no son portables entre conexiones, vías ni épocas', async store => {
    const env = socialTestEnv(), connection = await socialConnection(store), secret = { accessToken: 'TOKEN-CANARIO-NO-PERSISTIR', expiresAt: '2027-01-01T00:00:00.000Z' };
    const first = encryptCredentials(connection, secret, env), second = encryptCredentials(connection, secret, env);
    assert.notEqual(first.iv, second.iv);
    assert.deepEqual(decryptCredentials(connection, first, env), secret);
    assert.throws(() => decryptCredentials({ ...connection, id: randomUUID() }, first, env), { status: 409 });
    assert.throws(() => decryptCredentials({ ...connection, integrationMethod: 'browser' }, first, env), { status: 409 });
    const browser = { ...connection, integrationMethod: 'browser' }, sealed = encryptCredentials(browser, { storageState: { cookies: [], origins: [] } }, env);
    assert.throws(() => decryptCredentials({ ...browser, sessionEpoch: 1 }, sealed, env), { status: 409 });
    assert.equal(JSON.stringify(first).includes(secret.accessToken), false);
  }],
  ['CAS y época impiden sobrescribir una reconexión y no invalidan contabilidad', async store => {
    const env = socialTestEnv(), connection = await socialConnection(store), before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    await saveCredentials(store, connection.id, { accessToken: 'TOKEN-CANARIO-PRIMERO' }, { env });
    const writes = await Promise.allSettled(['SEGUNDO', 'TERCERO'].map(value => saveCredentials(store, connection.id, { accessToken: `TOKEN-CANARIO-${value}` }, { env, expectedVersion: 1 })));
    assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(writes.find(result => result.status === 'rejected').reason.status, 409);
    const current = await loadCredentials(store, connection, env);
    assert.ok(['TOKEN-CANARIO-SEGUNDO', 'TOKEN-CANARIO-TERCERO'].includes(current.accessToken));
    await store.db.run(`UPDATE ${store.t('social_connections')} SET data=? WHERE id=?`, [JSON.stringify({ sessionEpoch: 1 }), connection.id]);
    await assert.rejects(() => saveCredentials(store, connection.id, { accessToken: 'TARDIO' }, { expectedVersion: 2, sessionEpoch: 0, env }), { status: 409 });
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
    const persisted = JSON.stringify(await store.db.all(`SELECT * FROM ${store.t('social_credentials')}`));
    assert.equal(persisted.includes('TOKEN-CANARIO'), false);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), []);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_audit')}`), []);
  }],
  ['custodia del navegador descarta dominios ajenos e IndexedDB', async () => {
    const cookie = { name: 'auth', value: 'COOKIE-CANARIO', domain: '.facebook.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
    const state = sanitizeBrowserState({ cookies: [cookie, { ...cookie, domain: 'facebook.com.evil.test' }], origins: [{ origin: 'https://www.facebook.com', localStorage: [{ name: 'auth', value: 'SINTETICO' }], indexedDB: [{ secret: true }] }, { origin: 'https://evilfacebook.com', localStorage: [] }] });
    assert.deepEqual(state.cookies, [cookie]);
    assert.deepEqual(state.origins, [{ origin: 'https://www.facebook.com', localStorage: [{ name: 'auth', value: 'SINTETICO' }] }]);
  }],
  ['requisitos de API no bloquean la configuración independiente del navegador', async () => {
    const env = { ...socialTestEnv(), SOCIAL_BROWSER_ENABLED: 'true' };
    assert.equal(integrationRequirements('browser', env).configured, true);
    assert.deepEqual(integrationRequirements('api', env).missing.sort(), ['APP_URL', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'].sort());
    env.SOCIAL_BROWSER_SESSION_KEY = env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    assert.equal(integrationRequirements('browser', env).configured, false);
  }]
];
export async function runSocialContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async scenarioContext => {
    const store = await factory();
    try { await scenario(store, scenarioContext); } finally { await store.close(); }
  });
}
