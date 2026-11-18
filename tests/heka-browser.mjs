// Isolated Chromium acceptance: real Next routes, SQLite, and a closed fixture transport.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { expect as playwrightExpect } from '@playwright/test';
import { login, navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './e2e/helpers.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { openStore } from '../lib/db/index.mjs';
import { seed } from '../lib/seed.mjs';
import { FIXTURE_KEY, FIXTURE_PRODUCTION_KEY, GUIDE_A, GUIDE_B, GUIDE_C, SOLUTION, TEMPLATE, installHekaBrowserTransport } from './heka-browser-transport.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), file = fileURLToPath(import.meta.url);
const FIXTURE_CUSTOMER = 'Pedido sintético para vincular';
const SETTINGS = '/api/admin/shipping/heka', CLASSIC = '/api/admin/shipping/connections';
const expect = playwrightExpect.configure({ timeout: 20000 });
const byText = (scope, value) => scope.getByText(value, { exact: true });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const form = (scope, name) => scope.getByRole('form', { name, exact: true });
const fill = (scope, name, value) => scope.getByLabel(name, { exact: true }).fill(value);
const operate = (workspace, label) => selectWorkspace(workspace, 'Operaciones Heka', label);
const response = (page, pathname, method) => page.waitForResponse(item => item.request().method() === method && new URL(item.url()).pathname === pathname);
const entries = async log => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const calls = async (log, method, pathname) => (await entries(log)).filter(item => item.method === method && item.path === pathname).length;
async function clickAndWait(page, scope, title, operation = 'POST', endpoint = `${SETTINGS}/operate`) {
  const pending = response(page, endpoint, operation);
  await button(scope, title).click();
  return pending;
}

async function serve(scratch) {
  assert.equal(typeof process.send, 'function');
  assert.match(path.relative(root, scratch), /^\.test-data[\\/]+heka-browser-[A-Za-z0-9]+$/);
  const env = {
    DB_DRIVER: 'sqlite', SQLITE_PATH: path.join(scratch, 'browser.sqlite'), INTEGRATION_SECRETS_DIR: path.join(scratch, 'keys'),
    MEDIA_DIR: path.join(scratch, 'product-images'), SOCIAL_MEDIA_DIR: path.join(scratch, 'media'), SOCIAL_BROWSER_CONTROL_DIR: path.join(scratch, 'browser-control'),
    COOKIE_SECURE: 'true', NEXT_TELEMETRY_DISABLED: '1',
  };
  Object.assign(process.env, env);
  const server = createServer({ key: await readFile(path.join(scratch, 'https.key')), cert: await readFile(path.join(scratch, 'https.crt')) }, (request, reply) => void handle(request, reply));
  let handle;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.APP_URL = `https://localhost:${server.address().port}`;
  process.env.EXTRA_ALLOWED_ORIGINS = '';
  installHekaBrowserTransport(path.join(scratch, 'provider.jsonl'), process.env.APP_URL);
  const store = await openStore(env);
  try {
    const email = await createAdmin(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    await seed(store);
    const [product] = await store.list('products'), actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
    await store.saveOrder({ requestId: crypto.randomUUID(), placedOn: bogotaDate(), customerName: FIXTURE_CUSTOMER, phone: '3000000000', city: 'Bogotá',
      department: 'Cundinamarca', address: 'Dirección sintética de prueba', status: 'new', deliveryMethod: 'carrier', shippingChargeMinor: 0,
      items: [{ lineId: crypto.randomUUID(), kind: 'products', itemId: product.id, quantity: 1, unitPriceMinor: Math.round(product.price * 100), discountMinor: 0 }] }, actor.id);
  } finally { await store.close(); }
  const [{ default: next }, { default: configuration }] = await Promise.all([import('next'), import('../next.config.mjs')]);
  const app = next({ dev: true, dir: root, httpServer: server, hostname: 'localhost', port: server.address().port, conf: { ...configuration, distDir: path.relative(root, path.join(scratch, 'next')) } });
  await app.prepare();
  handle = app.getRequestHandler();
  process.send(process.env.APP_URL);
}

async function saveFixture(page, log) {
  await navigate(page, 'Configuración'); await openConfigurationTask(page, 'shipping-integrations');
  const classic = await (await page.request.get(CLASSIC)).json();
  const settings = page.getByRole('region', { name: 'Conexión oficial de Heka' }), config = form(settings, 'Configurar API oficial de Heka');
  const fields = config.getByLabel('Llave API de Heka', { exact: true });
  await expect(fields).toHaveAttribute('type', 'password');
  await expect(fields).toHaveValue('');
  const environment = config.getByRole('combobox', { name: 'Entorno', exact: true });
  await expect(environment).toHaveValue('test');
  await environment.selectOption('production');
  await fill(config, 'Llave API de Heka', FIXTURE_KEY);
  await button(config, 'Guardar conexión Heka').click();
  const confirm = page.getByRole('dialog', { name: 'Conectar Heka en producción' });
  await expect(button(confirm, 'Guardar en producción')).toBeDisabled();
  await button(confirm, 'Volver sin enviar').click();
  await button(config, 'Descartar cambios').click();
  await expect(fields).toHaveValue('');
  await fill(config, 'Llave API de Heka', FIXTURE_KEY);
  const saved = await clickAndWait(page, config, 'Guardar conexión Heka', 'PUT', SETTINGS);
  const settingsDTO = await saved.json();
  assert.equal(saved.status(), 200, JSON.stringify(settingsDTO));
  assert.deepEqual(Object.keys(settingsDTO).sort(), ['configured', 'environment', 'version']);
  assert.equal(settingsDTO.configured, true); assert.equal(settingsDTO.environment, 'test');
  await expect(fields).toHaveValue('');
  await page.reload();
  await expect(settings).toContainText('Hay una llave guardada');
  await expect(fields).toHaveValue('');
  const before = await calls(log, 'GET', '/warehouse');
  assert.equal((await clickAndWait(page, config, 'Comprobar acceso')).status(), 200);
  await expect(settings).toContainText('permitió consultar bodegas');
  assert.equal(await calls(log, 'GET', '/warehouse'), before + 1);
  assert.equal(await page.evaluate(key => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }).includes(key), FIXTURE_KEY), false);
  await button(config, 'Abrir operaciones Heka').click();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'heka');
  return classic;
}

async function downloadPDF(page, workspace) {
  const expected = Promise.all([
    page.waitForEvent('download'),
    response(page, `${SETTINGS}/operate`, 'POST').then(async pdf => assert.equal(pdf.status(), 200, pdf.ok() ? undefined : await pdf.text())),
  ]);
  await button(workspace, 'Descargar etiquetas PDF').click();
  const [download] = await expected;
  assert.equal(download.suggestedFilename(), 'etiquetas-heka.pdf');
  const bytes = await readFile(await download.path());
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) && bytes.includes(Buffer.from('%%EOF')));
}

async function prepareFreight(workspace) {
  await operate(workspace, 'Datos de envío');
  const city = form(workspace, 'Buscar ciudades');
  await fill(city, 'Ciudad o departamento', 'BOGOTA');
  await button(city, 'Buscar ciudades').click();
  await button(workspace, 'Usar como origen').click();
  await expect(workspace).toContainText('11001000');
  await button(form(workspace, 'Listar bodegas'), 'Listar bodegas').click();
  await button(workspace, 'Usar bodega para el envío').click();
  await button(form(workspace, 'Consultar plantillas'), 'Consultar plantillas').click();
  await button(workspace, 'Aplicar a los datos de envío').click();
  await operate(workspace, 'Cotizar y emitir');
}

async function prepareGuide(workspace, product) {
  await button(workspace, 'Emitir guía').click();
  const guide = form(workspace, 'Datos para emitir guía');
  await guide.getByRole('combobox', { name: 'Transportadora', exact: true }).selectOption('coordinadora');
  await fill(guide, 'Descripción del producto', product);
  await fill(guide, 'Nombre del destinatario', 'Destinatario de prueba');
  await fill(guide, 'Dirección del destinatario', 'Calle sintética sin destinatario real');
  await fill(guide, 'Teléfono del destinatario', '3000000000');
  await button(guide, 'Revisar antes de emitir').click();
  return guide;
}

async function exercise(page, log, uncertainty) {
  const classic = await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial' });
  await expect(workspace).toContainText('Entorno Heka: Pruebas');
  await selectWorkspace(page, 'Vistas de pedidos', 'Envíos');
  await button(page, 'Operar con Heka oficial').click();
  await expect(workspace).toContainText('Entorno Heka: Pruebas');
  const search = form(workspace, 'Buscar guías');
  await fill(search, 'Número de guía, nombre o teléfono', 'ERROR-DE-PROVEEDOR');
  assert.equal((await clickAndWait(page, search, 'Buscar guías')).status(), 403);
  await expect(workspace.getByRole('alert')).toBeVisible();
  await expect(workspace).not.toContainText('no muestres el mensaje privado');
  await expect(workspace).not.toContainText('Heka no devolvió resultados.');
  await fill(search, 'Número de guía, nombre o teléfono', 'SIN-RESULTADOS');
  await button(search, 'Buscar guías').click();
  await expect(byText(workspace, 'Heka no devolvió resultados.')).toBeVisible();
  await fill(search, 'Número de guía, nombre o teléfono', '');
  await button(search, 'Buscar guías').click();
  await expect(byText(workspace, 'Página 1 de 2 · 3 resultados')).toBeVisible();
  await expect(button(workspace, 'Vincular guía a un pedido')).toHaveCount(0);
  await button(workspace, 'Siguiente').click();
  await expect(byText(workspace, `Guía ${GUIDE_C.guide_number}`)).toBeVisible();
  await button(workspace, 'Anterior').click();
  await workspace.getByRole('checkbox', { name: `Incluir guía ${GUIDE_A.guide_number} en etiquetas`, exact: true }).check();
  await workspace.getByRole('checkbox', { name: `Incluir guía ${GUIDE_B.guide_number} en etiquetas`, exact: true }).check();
  await button(workspace, 'Preparar etiquetas seleccionadas (2)').click();
  await downloadPDF(page, workspace);
  await workspace.getByLabel('Origen de etiquetas').selectOption('document');
  await fill(workspace, 'ID de documento Heka', TEMPLATE);
  await downloadPDF(page, workspace);

  await operate(workspace, 'Destinatarios');
  const history = form(workspace, 'Consultar historial de destinatario');
  await fill(history, 'Documento del destinatario', '000123');
  await button(history, 'Consultar historial de destinatario').click();
  await expect(byText(history.locator('..'), '***123')).toBeVisible();
  const rating = form(workspace, 'Consultar calificación del destinatario');
  await fill(rating, 'Teléfono del destinatario', '3000000001');
  await button(rating, 'Consultar calificación').click();
  await expect(byText(workspace, 'Heka no tiene guías registradas para este teléfono.')).toBeVisible();
  await fill(rating, 'Teléfono del destinatario', '3000000000');
  await button(rating, 'Consultar calificación').click();
  await expect(byText(workspace, 'qualified')).toBeVisible();
  assert.ok(!page.url().includes('3000000000') && !page.url().includes('000123'));

  await prepareFreight(workspace);
  const quote = form(workspace, 'Datos para cotizar'), sent = await calls(log, 'POST', '/shipments/guide');
  await expect(quote.getByLabel('Código DANE de destino', { exact: true })).toHaveValue('05001000');
  await button(quote, 'Solicitar cotización').click();
  await expect(byText(workspace, '12750')).toBeVisible();
  await expect(workspace).not.toContainText('never-return-provider-token');
  assert.equal(await calls(log, 'POST', '/shipments/guide'), sent);
  const guide = await prepareGuide(workspace, uncertainty ? 'Envío sin respuesta verificable' : 'Producto de prueba');
  const review = page.getByRole('dialog', { name: 'Confirmar emisión de guía' });
  await expect(review).toContainText('Entorno Heka: Pruebas');
  await expect(review).toContainText('Destinatario de prueba');
  await expect(button(review, 'Emitir guía en Heka')).toBeDisabled();
  await button(review, 'Volver sin enviar').click();
  assert.equal(await calls(log, 'POST', '/shipments/guide'), sent);
  await button(guide, 'Revisar antes de emitir').click();
  await review.getByRole('checkbox').check();
  const issuance = await clickAndWait(page, review, 'Emitir guía en Heka');
  assert.equal(issuance.status(), uncertainty ? 202 : 200, await issuance.text());
  await expect(review).toHaveCount(0);
  const journal = workspace.getByRole('region', { name: 'Historial de operaciones Heka' });
  if (uncertainty) {
    await expect(journal).toContainText('Emisión de guía · Resultado incierto');
    await expect(journal).toContainText('Otras emisiones en este entorno quedan bloqueadas');
    await operate(workspace, 'Guías');
    await openDisclosure(search, 'Más filtros');
    await fill(search, 'ID de la guía Heka', GUIDE_C._id);
    await button(search, 'Buscar guías').click();
    await expect(byText(workspace, `Guía ${GUIDE_C.guide_number}`)).toBeVisible();
    await operate(workspace, 'Historial de operaciones');
    await fill(journal, 'ID exacto de guía en Heka', GUIDE_C._id);
    await fill(journal, 'Número exacto de la guía', GUIDE_C.guide_number);
    await button(journal, 'Revisar verificación').click();
    const verify = page.getByRole('dialog', { name: 'Confirmar verificación en Heka' });
    await expect(button(verify, 'Verificar en Heka')).toBeDisabled();
    await verify.getByRole('checkbox').check();
    const receipt = await clickAndWait(page, verify, 'Verificar en Heka');
    assert.equal(receipt.status(), 200, await receipt.text());
    await expect(journal).toContainText('Esto no prueba que la solicitud original la haya creado.');
  } else await expect(journal).toContainText('Emisión de guía · Confirmada por Heka');
  assert.equal(await calls(log, 'POST', '/shipments/guide'), sent + 1);
  await expect(journal).not.toContainText('Destinatario de prueba');

  await operate(workspace, 'Novedades');
  await expect(workspace).toContainText('cuenta seller');
  await button(form(workspace, 'Consultar novedades'), 'Consultar novedades').click();
  await openDisclosure(workspace, 'Movimientos informados por Heka');
  await expect(workspace).toContainText('Visita de prueba');
  const novelty = form(workspace, `Solucionar novedad: ${GUIDE_B.guide_number}`);
  const previousPatches = (await entries(log)).filter(item => item.method === 'PATCH').length;
  await fill(novelty, 'Solución para Heka', SOLUTION);
  await button(novelty, 'Revisar solución').click();
  const confirmSolution = page.getByRole('dialog', { name: 'Confirmar solución de novedad' });
  await expect(confirmSolution).toContainText(SOLUTION);
  await expect(button(confirmSolution, 'Enviar solución a Heka')).toBeDisabled();
  assert.equal((await entries(log)).filter(item => item.method === 'PATCH').length, previousPatches);
  await confirmSolution.getByRole('checkbox').check();
  const submission = await clickAndWait(page, confirmSolution, 'Enviar solución a Heka');
  assert.equal(submission.status(), 200, await submission.text());
  await expect(journal).toContainText('Heka aceptó la solución para revisión.');
  await expect(journal).not.toContainText(SOLUTION);
  assert.equal((await entries(log)).filter(item => item.method === 'PATCH').length, previousPatches + 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  await button(workspace, 'Configurar conexión Heka').click();
  const settings = form(page, 'Configurar API oficial de Heka');
  await button(settings, 'Retirar llave del panel').click();
  const remove = page.getByRole('dialog', { name: 'Retirar la llave de Heka' });
  assert.equal((await clickAndWait(page, remove, 'Retirar llave del panel', 'DELETE', SETTINGS)).status(), 200);
  await expect(page.getByRole('region', { name: 'Conexión oficial de Heka' })).toContainText('No hay una llave guardada');
  assert.deepEqual(await (await page.request.get(CLASSIC)).json(), classic);
}

async function exerciseLocalLink(page, log) {
  const records = (await (await page.request.get('/api/admin/orders')).json()).records;
  const order = records.find(item => item.customerName === FIXTURE_CUSTOMER), number = `AN-${String(order.number).padStart(6, '0')}`;
  assert.equal(order.shipments.length, 0);
  await navigate(page, 'Configuración'); await openConfigurationTask(page, 'shipping-integrations');
  const settings = form(page, 'Configurar API oficial de Heka');
  await settings.getByRole('combobox', { name: 'Entorno', exact: true }).selectOption('production');
  await fill(settings, 'Llave API de Heka', FIXTURE_PRODUCTION_KEY);
  await button(settings, 'Guardar conexión Heka').click();
  const setup = page.getByRole('dialog', { name: 'Conectar Heka en producción' });
  await setup.getByRole('checkbox').check();
  assert.equal((await clickAndWait(page, setup, 'Guardar en producción', 'PUT', SETTINGS)).status(), 200);
  await button(settings, 'Abrir operaciones Heka').click();

  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial' });
  await expect(workspace).toContainText('Entorno Heka: Producción');
  const search = form(workspace, 'Buscar guías');
  const result = workspace.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Guía ${GUIDE_A.guide_number}`, exact: true }) });
  await button(search, 'Buscar guías').click();
  await button(result, 'Vincular guía a un pedido').click();
  const confirm = page.getByRole('dialog', { name: 'Vincular guía a pedido local' });
  await expect(button(confirm, 'Confirmar vinculación al pedido')).toBeDisabled();
  await fill(confirm, 'Número exacto del pedido All Nutrition', '9999999');
  await button(confirm, 'Buscar pedido exacto').click();
  await expect(confirm.getByRole('alert')).toContainText('No se encontró un pedido con ese número exacto.');
  await fill(confirm, 'Número exacto del pedido All Nutrition', number);
  await button(confirm, 'Buscar pedido exacto').click();
  await expect(confirm).toContainText(FIXTURE_CUSTOMER);
  await expect(confirm).toContainText(GUIDE_A.guide_number);
  await expect(button(confirm, 'Confirmar vinculación al pedido')).toBeDisabled();
  await confirm.getByRole('checkbox').check();
  const receipt = await clickAndWait(page, confirm, 'Confirmar vinculación al pedido');
  assert.equal(receipt.status(), 200, await receipt.text());
  const { result: linked } = await receipt.json();
  assert.equal(linked.orderId, order.id);
  await expect(result).toContainText(`Vinculada al pedido ${number}`);
  const status = (await (await page.request.get('/api/admin/orders')).json()).records.find(item => item.id === order.id);
  assert.equal(status.status, order.status);
  assert.deepEqual(status.shipments.map(item => [item.tracking, item.status]), [[GUIDE_A.guide_number, 'unknown']]);
  await page.reload();
  await button(search, 'Buscar guías').click();
  await expect(result).toContainText(`Vinculada al pedido ${number}`);
  await button(result, 'Abrir envío local').click();
  await expect(page).toHaveURL(current => current.searchParams.get('tab') === 'shipments' && current.searchParams.get('record') === linked.shipmentId);
  const providerCalls = (await entries(log)).filter(item => item.productionBranch);
  assert.ok(providerCalls.length >= 3 && providerCalls.every(item => item.method === 'GET' && item.path === '/shipments/guide/v2/external'));
}

async function withFixture(browser, device, check) {
  const scratch = await mkdtemp(path.join(root, '.test-data', 'heka-browser-')), log = path.join(scratch, 'provider.jsonl');
  let child, context;
  try {
    await writeFile(log, '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(scratch, 'https.key'), '-out', path.join(scratch, 'https.crt')], { stdio: 'ignore' });
    child = fork(file, ['--serve', scratch], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const url = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(([code]) => { throw new Error(`Servidor de fixture detenido (${code}).`); })]);
    context = await browser.newContext({ ...device, baseURL: url, ignoreHTTPSErrors: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await login(page); await check(page, log); assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(path.join(root, '.test-data'), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [label, device, check] of [
      ['escritorio', { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, (page, log) => exercise(page, log, false)],
      ['móvil', devices['iPhone 13'], (page, log) => exercise(page, log, true)],
      ['vinculación local desde guía sintética', devices['Desktop Chrome'], exerciseLocalLink],
    ]) {
      await withFixture(browser, device, check);
      console.log(`Heka oficial: recorrido ${label} aprobado; solo transporte sintético.`);
    }
  } finally { await browser.close(); }
}

if (process.argv[2] === '--serve') await serve(process.argv[3]);
else await main();
