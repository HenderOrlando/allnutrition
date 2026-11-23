import { execFileSync, fork } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect as playwrightExpect, test } from '@playwright/test';
import { chromium } from 'playwright';
import { audit, insertRow } from '../../lib/business/commands.mjs';
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { createIntegrationKeyring } from '../../lib/integrations/keyring.mjs';
import { browserSignature } from '../../lib/social/browser-client.mjs';
import { createBrowserRuntime } from '../../lib/social/browser-runtime.mjs';
import { navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './helpers.mjs';

const expect = playwrightExpect.configure({ timeout: 12000 });
const root = fileURLToPath(new URL('../..', import.meta.url));
const spec = fileURLToPath(import.meta.url);
const settingsPath = '/admin?section=business&tab=social';
const social = '/api/admin/social';
const connectionsPath = `${social}/connections`;
const appSecret = 'synthetic-meta-secret-not-a-credential';
const at = '2026-11-16T10:00:00.000Z';
const marks = {
  'oauth-connect': ['conectar con facebook', 'meta-oauth-connect-control'],
  'oauth-renew': ['volver a autorizar facebook', 'meta-oauth-reauthorize-control'],
  token: ['conectar token de solo lectura', 'meta-manual-token-form'],
  'browser-create': ['crear conexión de navegador', 'meta-browser-connection-create'],
  'browser-open': ['abrir acceso asistido', 'meta-existing-browser-connection-open'],
  'browser-login': ['abrir acceso privado', null],
  'browser-finish': ['verificar y guardar sesión', 'meta-browser-dialog-finish'],
  'browser-cancel': ['cancelar acceso meta', 'meta-browser-dialog-cancel'],
  'connection-evaluation': ['evaluación de acceso', 'meta-connection-permissions-detail'],
  'select-assets': ['elegir página y cuenta', 'meta-connection-resource-picker'],
  validate: ['verificar conexión con meta', 'meta-connection-validate-control'],
  'advertising-read': ['consultar publicidad con token', 'meta-account-live-metrics-form'],
  'open-results': ['ver análisis encolado', 'Análisis histórico y contenido actual'],
  'disconnect-pause': ['pausar y desconectar', 'meta-disconnect-with-pause-confirmation'],
  'disconnect-local': ['desconectar sin afirmar pausa', 'meta-disconnect-local-confirmation'],
  'delete-preview': ['cantidades a eliminar', 'meta-delete-data-counts'],
  'delete-pause': ['pausar y eliminar datos', 'meta-delete-with-pause-confirmation'],
  'delete-local': ['eliminar sólo datos locales', 'meta-delete-local-confirmation'],
  'disconnection-status': ['recibos de eliminación', 'meta-disconnection-and-deletion-receipts'],
};
const names = { oauth: 'OAuth C6 elegida', token: 'Token C6 de lectura', browser: 'Navegador C6 sin acceso', pending: 'Pausa C6 pendiente' };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const marker = (scope, name) => scope.locator(`[data-advisor-control="${name}"]`);
const keyPaths = scratch => ({ INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control') });

async function serve(scratch) {
  const keys = keyPaths(scratch);
  const keyring = createIntegrationKeyring({ directory: keys.INTEGRATION_SECRETS_DIR, controlDirectory: keys.SOCIAL_BROWSER_CONTROL_DIR });
  const runner = await createBrowserRuntime({ chromium, keyring, mediaRoot: join(scratch, 'media') });
  const frame = await sharp({ create: { width: 1280, height: 800, channels: 3, background: '#254955' } }).jpeg().toBuffer();
  const controls = new Map();
  const health = createServer(async (request, reply) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        return reply.end(JSON.stringify(await runner.health()));
      }
      if (request.method !== 'POST' || request.url !== '/control') throw new Error('Ruta no admitida.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error('Comando de prueba demasiado grande.');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks), time = request.headers['x-social-time'], nonce = request.headers['x-social-nonce'];
      const signature = request.headers['x-social-signature'];
      const key = await keyring.read('control', { required: true });
      const expected = browserSignature(key, 'POST', '/control', time, nonce, body);
      if (!/^[0-9a-f]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Firma incorrecta.');
      const {command,connectionId,lease,payload,publishingEnabled} = JSON.parse(body);
      if (publishingEnabled) throw new Error('Fixture sin publicación.');
      if (command === 'open' && payload.purpose === 'login') controls.set(connectionId, lease.token);
      if (controls.get(connectionId) !== lease.token) throw new Error('Control desconocido.');
      if (command === 'frame') { reply.writeHead(200, { 'content-type': 'image/jpeg' }); return reply.end(frame); }
      let data = {};
      if (command === 'inspect' && payload.kind === 'connection') data = { state: 'challenge_required' };
      else if (command === 'close') controls.delete(connectionId);
      else if (!['open','renew'].includes(command)) throw new Error('Comando no admitido.');
      reply.writeHead(200, { 'content-type': 'application/json' });
      return reply.end(JSON.stringify({ status: 'confirmed', data }));
    } catch {
      appendFileSync(join(scratch, 'blocked-fetch.log'), `${request.method} ${request.url}\n`);
      return reply.writeHead(403).end();
    }
  });
  health.listen(0, '127.0.0.1');
  await once(health, 'listening');
  const runnerOrigin = `http://127.0.0.1:${health.address().port}`;
  process.env.SOCIAL_BROWSER_URL = runnerOrigin;
  const config = pathToFileURL(join(root, 'next.config.mjs')).href;
  const distDir = relative(root, join(scratch, 'next'));
  const transport = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  const nativeFetch = globalThis.fetch;
  registerHooks({ load(url, options, load) {
    if (url === config) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${config}?base`)}; export default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    if (url === transport) return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(`${transport}?base`)}; export const installHekaBrowserTransport = (_, origin) => globalThis.restrictMetaFetch(origin);` };
    return load(url, options);
  } });
  globalThis.restrictMetaFetch = origin => {
    delete globalThis.restrictMetaFetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === origin || url.origin === runnerOrigin && ['/health','/control'].includes(url.pathname)) return nativeFetch(input, init);
      if (url.origin === 'https://registry.npmjs.org') return new Response(null, { status: 503 });
      appendFileSync(join(scratch, 'blocked-fetch.log'), `${url.origin}${url.pathname}\n`);
      throw new Error('La prueba solo permite red privada local y salud del visor.');
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function seed(store, scratch, origin) {
  const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
  await saveSocialSettings(store, {
    version: 0, requestId: randomUUID(), publicBaseUrl: origin, appId: '991103001', loginConfigId: '991103002',
    appSecret, browserEnabled: true, publishingEnabled: false,
  }, actor.id, { env: keyPaths(scratch), allowedOrigins: [origin] });
  const ids = Object.fromEntries(['oauth', 'token', 'browser', 'pending', 'receipt', 'requested'].map(name => [name, randomUUID()]));
  await store.transaction(async tx => {
    const add = (key, integrationMethod, state, data) => insertRow(tx, 'social_connections', {
      id: ids[key], provider: 'meta', integration_method: integrationMethod, state, version: 7, created_at: at, updated_at: at,
      data: JSON.stringify({ name: names[key], sessionEpoch: 0, ...data }),
    });
    const permissions = ['ads_read'];
    const resources = {
      businesses: [{ id: '31', name: 'Negocio original C6' }, { id: '32', name: 'Otro negocio C6' }],
      pages: [{ id: '41', name: 'Página original C6', instagramId: '51' }, { id: '42', name: 'Página alterna C6', instagramId: '52', instagramName: 'Instagram alterno C6' }],
      adAccounts: [{ id: 'act_61', name: 'Cuenta original C6', currency: 'COP' }, { id: 'act_62', name: 'Otra cuenta C6', currency: 'USD' }],
    };
    const evidence = {
      permissions, currency: 'COP', timeZone: 'America/Bogota', validatedAt: at,
      capabilities: { insights: true, facebookPublish: true, adsPublish: true }, resources,
      identities: { userName: 'Identidad local sintética', businessId: '31', pageId: '41', instagramId: '51', adAccountId: 'act_61' },
      evaluation: { checkedAt: at, tokenType: 'USER', expirationStatus: 'not_scheduled', permissions: [{ name: 'ads_read', status: 'granted' }], limits: { status: 'reported', observedAt: at, retryAfter: 17 } },
    };
    await add('oauth', 'api', 'connected', { authenticationMethod: 'oauth', ...evidence });
    await add('token', 'api', 'connected', { authenticationMethod: 'token', readOnly: true, ...evidence });
    await add('browser', 'browser', 'login_required', {});
    await add('pending', 'api', 'connected', { authenticationMethod: 'oauth', disconnectPending: { action: 'delete-platform-data', state: 'waiting_for_pause', requestedAt: at, receiptId: ids.requested } });
    for (const key of ['oauth', 'oauth', 'token']) await insertRow(tx, 'social_campaigns', {
      id: randomUUID(), connection_id: ids[key], name: `Borrador privado ${key}`, mode: 'organic', objective: 'reach', state: 'draft', version: 1, created_at: at, updated_at: at, data: '{}',
    });
    await audit(tx, { entityType: 'social_deletion_receipt', entityId: ids.receipt, actorId: actor.id, next: { receiptId: ids.receipt, deletedAt: at, counts: { campaigns: 1 }, remoteContentDeleted: false, remoteSpendStopped: false } });
  });
  return ids;
}

async function handoff(page, via, capability, modal) {
  await (modal ? button(modal, 'Ali: revisar este control') : button(page.getByRole('banner'), 'Ali')).click();
  let assistant = page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
  const [query] = marks[capability];
  const card = scope => scope.locator(`[data-capability-id="business.meta-${capability}"]`);
  if (via === 'chat') {
    if (await button(assistant, 'Responder').count()) await button(assistant, '‹ Conversaciones').click();
    const before = await card(assistant).count();
    await assistant.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
    await button(assistant, 'Enviar').click();
    await expect(card(assistant)).toHaveCount(before + 1, { timeout: 30000 });
  } else {
    await button(assistant, '¿Qué quieres hacer?').click();
    assistant = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await assistant.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await button(assistant, 'Buscar').click();
  }
  await card(assistant).last().getByRole('button', { name: /^Abrir en el panel:/ }).click();
  return assistant;
}

async function arrive(page, via, capability, { target = marker(page, marks[capability][1]), panel, modal } = {}) {
  if (via === 'panel') await panel?.();
  else {
    const assistant = await handoff(page, via, capability, modal);
    await expect(assistant).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

async function expectGuard(page, capability) {
  const before = page.url();
  const directory = await handoff(page, 'directorio', capability);
  await expect(directory.getByRole('alert')).toContainText('El control no se abrió');
  await button(directory, 'Cerrar directorio').click();
  const guard = page.getByRole('alert').filter({ has: button(page, 'Cerrar error') });
  await expect(guard).toContainText('Ali no elige credenciales ni confirma cambios por ti');
  await expect(page).toHaveURL(before);
  await button(guard, 'Cerrar error').click();
}

const snapshot = (store, added = []) => Promise.all([
  store.db.all(`SELECT * FROM ${store.t('social_connections')} ORDER BY id`).then(rows => rows.filter(row => !added.includes(row.id))),
  ...['social_credentials', 'social_integration_settings', 'social_campaigns', 'social_operations', 'social_account_analyses'].map(table => store.db.all(`SELECT * FROM ${store.t(table)}`)),
  store.db.all(`SELECT * FROM ${store.t('business_requests')} WHERE scope LIKE 'social:%' AND scope <> 'social:connection:create' ORDER BY scope,request_id`),
]);

if (process.argv[2] === '--serve-meta-connections') await serve(process.argv[3]);
else test('Ali @advisor-c6: controles de la conexión Meta exacta sin autenticar, pausar ni invertir', async ({ browser }, info) => {
  test.setTimeout(240000);
  const base = join(root, '.test-data');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'heka-browser-'));
  let server, context, store;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-meta-connections', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite') });
    const ids = await seed(store, scratch, origin), baseline = await snapshot(store);
    const { defaultBrowserType: _browser, ...device } = info.project.use;
    const viewport = info.project.name === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...device, baseURL: origin, viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const requests = [], unexpected = [], turns = [], errors = [], prompts = [], created = [];
    const previewPath = `${connectionsPath}/${ids.oauth}/actions`;
    const browserActions = [], viewerPath = `${connectionsPath}/${ids.browser}/browser/actions`;
    let viewerEnabled = false;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (path === '/api/admin/assistant/turns' && method === 'POST') turns.push(request.postData());
      if (viewerEnabled && url.origin === origin && path === viewerPath && method === 'POST') {
        const data = request.postDataJSON();
        if (['start-login','finish-login','cancel-login','read-frame'].includes(data.action)) {
          if (data.action !== 'read-frame') browserActions.push(data);
          return route.continue();
        }
      }
      if (url.origin !== origin || path.endsWith('/advertising') || path.endsWith('/browser/actions')) {
        unexpected.push(`${method} ${url.origin}${path}`);
        return route.abort('blockedbyclient');
      }
      if (path.startsWith(`${social}/`) && method !== 'GET') {
        const data = request.postDataJSON();
        if (method === 'POST' && (path === previewPath && data.action === 'preview-delete-platform-data' || path === connectionsPath && data.integrationMethod === 'browser')) {
          requests.push({ path, data });
        } else {
          unexpected.push(`${method} ${path}`);
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.accept(); });
    const session = await context.request.post('/api/auth/login', { headers: { origin }, data: { email: 'e2e@example.test', password: 'clave-e2e-solo-pruebas' } });
    expect(session.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);

    const panel = page.getByRole('region', { name: 'Configuración de redes sociales', exact: true });
    const card = key => panel.getByRole('article', { name: names[key], exact: true });
    const selected = record => expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'social' && url.searchParams.get('record') === record);
    const list = () => button(panel, 'Ver mis conexiones').click();
    const choose = async key => {
      await button(panel, `Administrar ${names[key]}`).click();
      await expect(card(key)).toHaveAttribute('data-meta-connection-id', ids[key]);
      await selected(ids[key]);
    };
    const review = (action, label) => page.getByRole('dialog', { name: `${label} · ${names.oauth}`, exact: true }).and(page.locator(`[data-meta-action="${action}"]`));
    const browserDialog = page.getByRole('dialog', { name: 'Conectar mediante navegador', exact: true });
    const openPrivate = button(browserDialog, 'Abrir acceso privado');
    const confirmDeletion = dialog => dialog.getByRole('checkbox', { name: /^Confirmo eliminar definitivamente/ });
    const acceptSpend = dialog => dialog.getByRole('checkbox', { name: /^Acepto que pueden seguir gastando/ });
    const pause = dialog => dialog.getByRole('checkbox', { name: /^Pausar anuncios y comprobar/ });
    const resource = name => card('oauth').getByRole('combobox', { name, exact: true });

    await page.goto(settingsPath, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await expect(button(panel, `Administrar ${names.oauth}`)).toBeVisible({ timeout: 30000 });
    await expectGuard(page, 'oauth-renew');
    await expectGuard(page, 'delete-preview');
    await choose('token');
    await expectGuard(page, 'oauth-renew');
    await expect(card('token')).toContainText('Token manual · Solo lectura');

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const count = requests.length;
      const nativeNew = () => button(panel, 'Conectar otra cuenta').click();
      const other = () => openDisclosure(panel, /^Otras formas de conexión$/);
      const disconnect = review('disconnect', 'Desconectar cuenta');
      const deleting = review('delete-platform-data', 'Eliminar datos locales de plataforma');
      const openDestructive = async name => {
        await openDisclosure(card('oauth'), /^Desconectar o eliminar datos locales$/);
        await button(card('oauth'), name).click();
      };
      await list();
      await arrive(page, via, 'oauth-connect', { panel: nativeNew });
      await selected('new');
      await expect(button(panel, 'Conectar con Facebook')).toBeEnabled();
      await arrive(page, via, 'token', { panel: other });
      const token = panel.locator('input[name="manualMetaToken"]'), tokenName = panel.locator('input[name="manualMetaName"]');
      await expect(token).toHaveAttribute('type', 'password');
      await expect(token).toHaveValue('');
      const secret = `synthetic-token-not-a-credential-${randomUUID()}`;
      await token.fill(secret);
      await tokenName.fill('Token no enviado');
      await arrive(page, via, 'token');
      await expect(token).toHaveValue(secret);
      await expect(tokenName).toHaveValue('Token no enviado');
      await expect(button(panel, 'Conectar token de solo lectura')).toBeEnabled();
      expect(turns.every(body => !body.includes(secret) && !body.includes(appSecret))).toBe(true);
      expect(requests).toHaveLength(count);
      await token.fill('');
      await tokenName.fill('');

      await arrive(page, via, 'browser-create', { panel: other });
      const browserName = marker(panel, 'meta-browser-connection-create'), name = `Ficha local C6 ${via}`;
      const create = button(panel, 'Crear conexión y abrir acceso');
      await expect(create).toBeDisabled();
      await browserName.fill(name);
      await arrive(page, via, 'browser-create');
      await expect(browserName).toHaveValue(name);
      expect(requests).toHaveLength(count);
      const response = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === connectionsPath);
      await create.click();
      const result = await response;
      expect(result.ok(), await result.text()).toBe(true);
      const local = await result.json();
      expect(local).toMatchObject({ name, state: 'login_required', integrationMethod: 'browser', version: 1, identities: {}, sessionEpoch: 0 });
      expect(Object.values(local.capabilities).every(flag => flag === false)).toBe(true);
      created.push(local.id);
      await selected(local.id);
      await expect(browserDialog).toContainText(name);
      await expect(openPrivate).toBeEnabled();
      await expect(browserDialog.getByRole('application')).toHaveCount(0);
      await button(browserDialog, 'Cerrar').click();
      await list();

      await choose('browser');
      await arrive(page, via, 'browser-open');
      await expect(browserDialog).toHaveCount(0);
      await arrive(page, via, 'browser-login', { target: openPrivate, panel: () => button(card('browser'), 'Abrir acceso asistido').click() });
      await selected(ids.browser);
      await expect(browserDialog).toContainText(names.browser);
      await expect(browserDialog.getByRole('application')).toHaveCount(0);
      await button(browserDialog, 'Cerrar').click();
      await list();

      await choose('oauth');
      await arrive(page, via, 'oauth-renew');
      await expect(button(card('oauth'), 'Volver a autorizar con Facebook')).toBeEnabled();
      await arrive(page, via, 'validate');
      await expect(button(card('oauth'), 'Verificar conexión')).toBeEnabled();
      await arrive(page, via, 'advertising-read');
      await expect(marker(panel, 'meta-account-live-metrics-form')).toContainText('Cuenta seleccionada: act_61');
      await arrive(page, via, 'connection-evaluation', { panel: () => openDisclosure(card('oauth'), /^Detalles técnicos$/) });
      await expect(marker(panel, 'meta-connection-permissions-detail')).toContainText(`${ids.oauth} · Versión 7`);
      const evidence = card('oauth').getByRole('region', { name: 'Evaluación de acceso Meta' });
      await expect(evidence).toContainText('ads_read: Concedido');
      await expect(evidence).toContainText('17 segundos reportados por Meta');
      await expect(evidence).toContainText('no garantizan cuota restante');
      const openResources = () => openDisclosure(card('oauth'), /^Seleccionar página y cuenta$/);
      await arrive(page, via, 'select-assets', { panel: openResources });
      const confirmResources = button(card('oauth'), 'Confirmar y revalidar recursos');
      await expect(confirmResources).toBeDisabled();
      await resource('Negocio').selectOption('32');
      await resource('Página Facebook').selectOption('42');
      await resource('Cuenta de anuncios').selectOption('act_62');
      await arrive(page, via, 'select-assets');
      await expect(resource('Negocio')).toHaveValue('32');
      await expect(resource('Página Facebook')).toHaveValue('42');
      await expect(resource('Instagram profesional vinculado')).toHaveValue('52');
      await expect(resource('Cuenta de anuncios')).toHaveValue('act_62');
      await expect(confirmResources).toBeEnabled();
      await expect(button(card('oauth'), 'Verificar conexión')).toBeDisabled();
      if (via === 'directorio') await expectGuard(page, 'delete-preview');
      await selected(ids.oauth);
      expect(requests).toHaveLength(count + 1);
      await resource('Negocio').selectOption('31');
      await resource('Página Facebook').selectOption('41');
      await resource('Cuenta de anuncios').selectOption('act_61');
      await expect(confirmResources).toBeDisabled();

      await arrive(page, via, 'disconnect-pause', { panel: () => openDestructive('Desconectar cuenta') });
      await expect(disconnect).toHaveAttribute('data-meta-connection-id', ids.oauth);
      await expect(pause(disconnect)).toBeChecked();
      await pause(disconnect).uncheck();
      await expect(button(disconnect, 'Desconectar sin afirmar pausa')).toBeDisabled();
      await acceptSpend(disconnect).check();
      await arrive(page, via, 'disconnect-local', { modal: disconnect });
      await expect(pause(disconnect)).not.toBeChecked();
      await expect(acceptSpend(disconnect)).toBeChecked();
      await selected(ids.oauth);
      expect(requests).toHaveLength(count + 1);
      await button(disconnect, 'Cancelar').click();

      await arrive(page, via, 'delete-preview', { panel: () => openDestructive('Eliminar datos locales…') });
      await expect(deleting).toHaveAttribute('data-meta-connection-id', ids.oauth);
      const counts = marker(deleting, 'meta-delete-data-counts');
      await expect(counts.getByText('Publicaciones y anuncios', { exact: true }).locator('..').locator('dd')).toHaveText('2');
      // Next dev's Strict Mode may abort and replay the mount read.
      const previewRequests = requests.slice(count + 1);
      expect(previewRequests.length).toBeGreaterThan(0);
      for (const request of previewRequests) expect(request).toEqual({ path: previewPath, data: { action: 'preview-delete-platform-data' } });
      await expect(deleting).toContainText('no despublica ni garantiza detener anuncios remotos');
      await expect(confirmDeletion(deleting)).not.toBeChecked();
      await expect(button(deleting, 'Pausar y eliminar datos')).toBeDisabled();
      await arrive(page, via, 'delete-pause', { modal: deleting });
      await expect(pause(deleting)).toBeChecked();
      await expect(confirmDeletion(deleting)).not.toBeChecked();
      await confirmDeletion(deleting).check();
      await pause(deleting).uncheck();
      await expect(button(deleting, 'Eliminar sólo datos locales')).toBeDisabled();
      await acceptSpend(deleting).check();
      await arrive(page, via, 'delete-local', { modal: deleting });
      await expect(pause(deleting)).not.toBeChecked();
      await expect(acceptSpend(deleting)).toBeChecked();
      await expect(confirmDeletion(deleting)).toBeChecked();
      await selected(ids.oauth);
      await button(deleting, 'Cancelar').click();

      await list();
      await choose('pending');
      await arrive(page, via, 'disconnection-status', { target: marker(card('pending'), 'meta-current-disconnection-status') });
      await expect(card('pending')).toContainText(ids.requested);
      await expect(card('pending')).toContainText('Aún no se afirma que se detuvo el gasto');
      await selected(ids.pending);
      await list();
      await arrive(page, via, 'disconnection-status', { panel: () => openDisclosure(panel, /^Recibos de eliminación local$/) });
      await expect(panel.getByRole('heading', { name: ids.receipt, exact: true })).toBeVisible();
      await expect(panel).toContainText('Detención del gasto no confirmada');
      await choose('oauth');
      await arrive(page, via, 'open-results', { panel: async () => {
        await navigate(page, 'Publicidad');
        await selectWorkspace(page, 'Vistas de publicidad', 'Resultados');
      } });
      await expect(page).toHaveURL(url => url.searchParams.get('section') === 'advertising' && url.searchParams.get('tab') === 'results' && !url.searchParams.has('record'));
      const analysis = page.getByRole('region', { name: 'Análisis histórico de las cuentas Meta' });
      await analysis.getByRole('combobox', { name: 'Conexión', exact: true }).selectOption(ids.oauth);
      await expect(analysis).toContainText('Aún no existe un análisis guardado para esta conexión');
      expect(requests.slice(count + 1)).toEqual(previewRequests);
      await navigate(page, 'Configuración');
      await openConfigurationTask(page, 'social');
      if (via !== 'directorio') await choose('token');
    });

    expect(await snapshot(store, created)).toEqual(baseline);
    viewerEnabled = true;
    for (const via of ['panel','chat','directorio']) await test.step(`visor activo · ${via}`,async()=>{
      await page.goto(`${settingsPath}&record=${ids.browser}`);
      await expect(card('browser')).toHaveAttribute('data-meta-connection-id',ids.browser);
      await button(card('browser'),'Abrir acceso asistido').click();
      const before = browserActions.length;
      await openPrivate.click();
      const finish = marker(browserDialog, marks['browser-finish'][1]);
      const cancel = marker(browserDialog, marks['browser-cancel'][1]);
      await arrive(page, via, 'browser-finish', { target:finish,modal:browserDialog });
      await selected(ids.browser);
      expect(browserActions.slice(before).map(x=>x.action)).toEqual(['start-login']);
      await finish.click();
      await expect(browserDialog.getByRole('status')).toContainText('Completa el acceso o desafío de Meta');
      await arrive(page, via, 'browser-cancel', { target:cancel,modal:browserDialog });
      const [{id,state}] = await store.db.all(`SELECT id,state FROM ${store.t('social_browser_controls')} WHERE connection_id=? AND state='active'`,[ids.browser]);
      expect(state).toBe('active');
      expect(browserActions.slice(before)).toEqual([{action:'start-login'},{action:'finish-login',controlId:id}]);
      await cancel.click();
      await expect(browserDialog).toHaveCount(0);
      expect(browserActions.slice(before).at(-1)).toEqual({action:'cancel-login',controlId:id});
      expect(await store.db.get(`SELECT state FROM ${store.t('social_browser_controls')} WHERE id=?`,[id])).toEqual({state:'cancelled'});
      expect(await store.db.get(`SELECT connection_id FROM ${store.t('social_credentials')} WHERE connection_id=?`,[ids.browser])).toBeFalsy();
    });
    expect(created).toHaveLength(3);
    expect(requests.filter(({ path }) => path === connectionsPath).map(({ data }) => data)).toEqual(['panel', 'chat', 'directorio'].map(via => ({ integrationMethod: 'browser', name: `Ficha local C6 ${via}`, requestId: expect.any(String) })));
    expect({ unexpected, errors }).toEqual({ unexpected: [], errors: [] });
    expect(prompts).toEqual(Array(6).fill('Hay cambios sin guardar. ¿Descartarlos y cerrar?'));
    expect(await readFile(join(scratch, 'blocked-fetch.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('');
    await info.attach('traspasos Meta sin ejecución externa', { body: JSON.stringify({ viewport, ids, created, capabilities: Object.keys(marks).map(key => `business.meta-${key}`), requests: requests.map(({ path, data }) => ({ path, action: data.action || 'create-local-browser-record' })) }, null, 2), contentType: 'application/json' });
  } finally {
    await context?.close();
    await store?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
