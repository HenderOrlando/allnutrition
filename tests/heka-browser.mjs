// Isolated Chromium acceptance: real Next routes, SQLite, and a closed fixture transport.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { expect as playwrightExpect } from '@playwright/test';
import { login, navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './e2e/helpers.mjs';
import { createAdmin, login as loginStore } from '../lib/auth.mjs';
import { saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { openStore } from '../lib/db/index.mjs';
import { seed } from '../lib/seed.mjs';
import { FIXTURE_KEY, FIXTURE_PRODUCTION_KEY, GUIDE_A, GUIDE_B, GUIDE_C, NOVELTY, SOLUTION, TEMPLATE, UNCERTAIN_SOLUTION, WAREHOUSE, installHekaBrowserTransport } from './heka-browser-transport.mjs';
import { startAssistantProviderFixture } from './assistant-provider-fixture.mjs';

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

async function serve(scratch, emptyBusiness = false) {
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
    if (!emptyBusiness) {
      await seed(store);
      const [product] = await store.list('products'), actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
      await store.saveOrder({ requestId: crypto.randomUUID(), placedOn: bogotaDate(), customerName: FIXTURE_CUSTOMER, phone: '3000000000', city: 'Bogotá',
        department: 'Cundinamarca', address: 'Dirección sintética de prueba', status: 'new', deliveryMethod: 'carrier', shippingChargeMinor: 0,
        items: [{ lineId: crypto.randomUUID(), kind: 'products', itemId: product.id, quantity: 1, unitPriceMinor: Math.round(product.price * 100), discountMinor: 0 }] }, actor.id);
    }
    const { user, csrf, token } = await loginStore(store, email, 'clave-e2e-solo-pruebas');
    const assistant = await startAssistantProviderFixture();
    await saveAssistantSettings(store, { version: 0, requestId: crypto.randomUUID(), enabled: true, provider: 'openai-compatible', model: 'fixture-a', baseUrl: assistant.url, apiKey: assistant.key, allowPrivateNetwork: true },
      { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') });
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
  const refreshedJournal = response(page, `${SETTINGS}/operate`, 'GET');
  const submission = await clickAndWait(page, confirmSolution, 'Enviar solución a Heka');
  assert.equal(submission.status(), 200, await submission.text());
  await expect(journal).toContainText('Heka aceptó la solución para revisión.');
  await expect(journal).not.toContainText(SOLUTION);
  assert.equal((await entries(log)).filter(item => item.method === 'PATCH').length, previousPatches + 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  // The new journal reads on mount. Its in-flight request blocks panel navigation.
  assert.equal((await refreshedJournal).status(), 200);
  await expect(button(journal, 'Actualizar historial')).toBeEnabled();

  const discardDraft = async dialog => {
    if (dialog.type() === 'confirm' && dialog.message() === 'Hay cambios sin guardar. ¿Descartarlos y continuar?') await dialog.accept();
    else await dialog.dismiss();
  };
  page.on('dialog', discardDraft);
  try {
    await button(workspace, 'Configurar conexión Heka').click();
    await expect(page.getByRole('region', { name: 'Conexión oficial de Heka' })).toBeVisible();
  } finally {
    page.off('dialog', discardDraft);
  }
  const settings = form(page, 'Configurar API oficial de Heka');
  await button(settings, 'Retirar llave del panel').click();
  const remove = page.getByRole('dialog', { name: 'Retirar la llave de Heka' });
  assert.equal((await clickAndWait(page, remove, 'Retirar llave del panel', 'DELETE', SETTINGS)).status(), 200);
  await expect(page.getByRole('region', { name: 'Conexión oficial de Heka' })).toContainText('No hay una llave guardada');
  assert.deepEqual(await (await page.request.get(CLASSIC)).json(), classic);
}

async function exerciseLocalLink(page, log, via = 'panel') {
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
  async function findGuide() {
    await openDisclosure(search, 'Más filtros');
    await fill(search, 'ID de la guía Heka', GUIDE_A._id);
    await button(search, 'Buscar guías').click();
  }
  const result = workspace.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Guía ${GUIDE_A.guide_number}`, exact: true }) });
  await findGuide();
  await button(result, 'Vincular guía a un pedido').click();
  const confirm = page.getByRole('dialog', { name: 'Vincular guía a pedido local' });
  await expect(button(confirm, 'Confirmar vinculación al pedido')).toBeDisabled();
  const nativeHelp = button(confirm, 'Ayúdame con esta revisión');
  const localNumber = confirm.getByRole('textbox', { name: 'Número exacto del pedido All Nutrition', exact: true });
  if (via !== 'panel') await arriveFromAli(page, via, 'heka.find-local-order', 'pedido para guía heka', localNumber, nativeHelp);
  await expect(localNumber).toHaveValue('');
  await fill(confirm, 'Número exacto del pedido All Nutrition', '9999999');
  await button(confirm, 'Buscar pedido exacto').click();
  await expect(confirm.getByRole('alert')).toContainText('No se encontró un pedido con ese número exacto.');
  await fill(confirm, 'Número exacto del pedido All Nutrition', number);
  await button(confirm, 'Buscar pedido exacto').click();
  await expect(confirm).toContainText(FIXTURE_CUSTOMER);
  await expect(confirm).toContainText(GUIDE_A.guide_number);
  await expect(button(confirm, 'Confirmar vinculación al pedido')).toBeDisabled();
  const before = (await entries(log)).length;
  if (via !== 'panel') await arriveFromAli(page, via, 'heka.link-guide', 'asociar guía heka a pedido', confirm.getByRole('heading', { name: 'Vincular guía a pedido local' }), nativeHelp);
  await expect(confirm.getByRole('checkbox')).not.toBeChecked();
  await expect(button(confirm, 'Confirmar vinculación al pedido')).toBeDisabled();
  const unlinked = (await (await page.request.get('/api/admin/orders')).json()).records.find(item => item.id === order.id);
  assert.deepEqual(unlinked.shipments, []);
  assert.equal((await entries(log)).length, before);
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
  await findGuide();
  await expect(result).toContainText(`Vinculada al pedido ${number}`);
  if (via !== 'panel') await arriveFromAli(page, via, 'heka.open-linked-shipment', 'ver guía heka vinculada', button(result, 'Abrir envío local'));
  await button(result, 'Abrir envío local').click();
  await expect(page).toHaveURL(current => current.searchParams.get('tab') === 'shipments' && current.searchParams.get('record') === linked.shipmentId);
  const providerCalls = (await entries(log)).filter(item => item.productionBranch);
  assert.ok(providerCalls.length >= 3 && providerCalls.every(item => item.method === 'GET' && item.path === '/shipments/guide/v2/external'));
}

async function arriveFromAli(page, via, id, query, target, trigger = button(page.getByRole('banner'), 'Ali')) {
  await trigger.click();
  let entry = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
  if (via === 'chat') {
    await fill(entry, 'Mensaje para Ali', `¿Dónde está ${query}?`);
    await button(entry, 'Enviar').click();
  } else {
    await button(entry, '¿Qué quieres hacer?').click();
    entry = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await entry.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await button(entry, 'Buscar').click();
  }
  await entry.locator(`[data-capability-id="${id}"]`).last().getByRole('button', { name: /^Abrir en el panel:/ }).click();
  await expect(target).toBeFocused();
}

async function exerciseAliQueries(page, log) {
  await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial', exact: true });
  const cases = [
    ['search-guides', 'estado heka', 'Guías', 'Buscar guías', 'Buscar guías', '/shipments/guide/v2/external', `Guía ${GUIDE_A.guide_number}`],
    ['search-cities', 'código dane', 'Datos de envío', 'Buscar ciudades', 'Buscar ciudades', '/geolocation/city', '11001000', 'Ciudad o departamento', 'BOGOTA'],
    ['search-warehouses', 'lista bodegas heka', 'Datos de envío', 'Listar bodegas', 'Listar bodegas', '/warehouse', 'Bodega de prueba'],
    ['search-templates', 'buscar plantilla de envío', 'Datos de envío', 'Consultar plantillas', 'Consultar plantillas', '/shipping/template', 'Plantilla de prueba'],
    ['read-recipient-history', 'guías del destinatario heka', 'Destinatarios', 'Consultar historial de destinatario', 'Consultar historial de destinatario', '/shipments/client-log', '***123', 'Documento del destinatario', '000123'],
    ['read-recipient-rating', 'calificación por teléfono heka', 'Destinatarios', 'Calificación del destinatario', 'Consultar calificación', '/shipments/guide/client', 'qualified', 'Teléfono del destinatario', '3000000000'],
    ['search-novelties', 'incidencias heka', 'Novedades', 'Consultar novedades', 'Consultar novedades', '/shipments/novelty', 'Cliente no disponible'],
    ['quote-shipment', 'cuánto cuesta envío heka', 'Cotizar y emitir', 'Cotizar envío', 'Solicitar cotización', '/shipping/quoter', '12750'],
  ];
  for (const [id, query, tab, heading, submit, pathname, result, label, value] of cases) {
    for (const via of ['panel', 'chat', 'directorio']) {
      await page.reload();
      await expect(workspace).toContainText('Entorno Heka: Pruebas');
      if (id === 'quote-shipment') {
        await prepareFreight(workspace);
        await button(workspace, 'Emitir guía').click();
        await fill(form(workspace, 'Datos para emitir guía'), 'Descripción del producto', 'Borrador privado retenido');
      }
      await operate(workspace, tab === 'Guías' ? 'Datos de envío' : 'Guías');
      const before = (await entries(log)).length;
      const target = workspace.getByRole('heading', { name: heading, exact: true });
      if (via === 'panel') {
        await operate(workspace, tab);
        if (id === 'quote-shipment') await button(workspace, 'Cotizar envío').click();
      } else await arriveFromAli(page, via, `heka.${id}`, query, target);
      assert.equal((await entries(log)).length, before, `${id} · ${via}: la llegada no debe consultar Heka`);
      const section = target.locator('..');
      if (label) await fill(section, label, value);
      const sent = await clickAndWait(page, section, submit);
      assert.equal(sent.status(), 200, await sent.text());
      await expect(section).toContainText(result);
      assert.deepEqual((await entries(log)).slice(before), [{ method: id === 'quote-shipment' ? 'POST' : 'GET', path: pathname, productionBranch: false }]);
      if (id === 'quote-shipment') {
        await expect(section).toContainText('No representan un cargo confirmado.');
        await button(section, 'Emitir guía').click();
        await expect(form(workspace, 'Datos para emitir guía').getByRole('textbox', { name: 'Descripción del producto', exact: true })).toHaveValue('Borrador privado retenido');
      }
    }
  }
}

async function exerciseAliLabels(page, log) {
  await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial', exact: true });
  for (const via of ['panel', 'chat', 'directorio']) {
    await page.goto('/admin?section=business&tab=shipping');
    const settings = page.getByRole('region', { name: 'Conexión oficial de Heka', exact: true });
    const check = button(settings, 'Comprobar acceso');
    await expect(check).toBeEnabled();
    const version = await (await page.request.get(SETTINGS)).json(), start = (await entries(log)).length;
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.settings-check', 'comprobar acceso heka', check);
    assert.equal((await entries(log)).length, start);
    assert.equal((await clickAndWait(page, settings, 'Comprobar acceso')).status(), 200);
    await expect(settings).toContainText('permitió consultar bodegas');
    assert.deepEqual((await entries(log)).slice(start), [{ method: 'GET', path: '/warehouse', productionBranch: false }]);
    assert.deepEqual(await (await page.request.get(SETTINGS)).json(), version);
    await button(settings, 'Abrir operaciones Heka').click();
    await button(form(workspace, 'Buscar guías'), 'Buscar guías').click();
    const first = workspace.getByRole('checkbox', { name: `Incluir guía ${GUIDE_A.guide_number} en etiquetas` });
    const second = workspace.getByRole('checkbox', { name: `Incluir guía ${GUIDE_B.guide_number} en etiquetas` });
    await expect(second).not.toBeChecked();
    await first.check();
    const before = (await entries(log)).length;
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.prepare-guide-labels', 'preparar etiquetas heka',
      byText(workspace, 'Selecciona las guías que quieres incluir. Prepararlas no descarga el PDF.'));
    await expect(first).toBeChecked();
    await expect(second).not.toBeChecked();
    await second.check();
    await button(workspace, 'Preparar etiquetas seleccionadas (2)').click();
    const guideInput = workspace.getByRole('textbox', { name: 'IDs de guías Heka', exact: true });
    await expect(guideInput).toHaveValue(`${GUIDE_A._id}\n${GUIDE_B._id}`);
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.download-guide-labels', 'imprimir etiquetas de envío', guideInput);
    await expect(guideInput).toHaveValue(`${GUIDE_A._id}\n${GUIDE_B._id}`);
    assert.equal((await entries(log)).length, before);
    await downloadPDF(page, workspace);
    const documentId = workspace.getByRole('textbox', { name: 'ID de documento Heka', exact: true });
    if (via === 'panel') await workspace.getByRole('combobox', { name: 'Origen de etiquetas', exact: true }).selectOption('document');
    else await arriveFromAli(page, via, 'heka.download-saved-labels', 'documento pdf heka', documentId);
    await expect(documentId).toHaveValue('');
    await expect(workspace.getByRole('status').filter({ hasText: 'Se inició la descarga del PDF' })).toHaveCount(0);
    await documentId.fill(TEMPLATE);
    await downloadPDF(page, workspace);
    assert.deepEqual((await entries(log)).slice(before), Array.from({ length: 2 }, () => ({ method: 'POST', path: '/documents/sticker', productionBranch: false })));
  }
}

async function exerciseAliCopy(page, log) {
  await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial', exact: true });
  const freight = form(workspace, 'Datos para cotizar'), city = form(workspace, 'Buscar ciudades');
  const origin = 'Código DANE de origen', destination = 'Código DANE de destino', warehouse = 'ID de bodega Heka';
  const fields = [origin, destination, warehouse, 'Peso'];
  const expected = ['11001111', '05001234', 'bodega-local', '3'];
  const baseline = async () => {
    await operate(workspace, 'Cotizar y emitir');
    for (const [index, label] of fields.entries()) await fill(freight, label, expected[index]);
    await operate(workspace, 'Datos de envío');
  };
  const cases = [
    ['use-origin-city', 'dane de origen', 'Buscar ciudades', 'Usar como origen', ['11001000', ...expected.slice(1)]],
    ['use-destination-city', 'dane de destino', 'Buscar ciudades', 'Usar como destino', [expected[0], '11001000', ...expected.slice(2)]],
    ['use-warehouse', 'copiar bodega', 'Listar bodegas', 'Usar bodega para el envío', [...expected.slice(0, 2), WAREHOUSE, expected[3]]],
    ['apply-template', 'usar plantilla heka', 'Consultar plantillas', 'Aplicar a los datos de envío', [expected[0], '05001000', expected[2], '1']],
  ];
  for (const [id, query, search, label, values] of cases) for (const via of ['panel', 'chat', 'directorio']) {
    await baseline();
    if (id === 'use-origin-city' && via !== 'panel') {
      await fill(city, 'Ciudad o departamento', 'AMBIGUA');
      await button(city, search).click();
      await expect(workspace).toContainText('2 resultados');
      const before = (await entries(log)).length;
      await arriveFromAli(page, via, `heka.${id}`, query, workspace.getByRole('heading', { name: search, exact: true }));
      assert.equal((await entries(log)).length, before);
      await operate(workspace, 'Cotizar y emitir');
      await expect(freight.getByLabel(origin, { exact: true })).toHaveValue(expected[0]);
      await operate(workspace, 'Datos de envío');
    }
    if (search === 'Buscar ciudades') await fill(city, 'Ciudad o departamento', 'BOGOTA');
    assert.equal((await clickAndWait(page, form(workspace, search), search)).status(), 200);
    const before = (await entries(log)).length, target = button(workspace, label);
    if (via !== 'panel') await arriveFromAli(page, via, `heka.${id}`, query, target);
    await target.click();
    await operate(workspace, 'Cotizar y emitir');
    for (const [index, field] of fields.entries()) await expect(freight.getByLabel(field, { exact: true })).toHaveValue(values[index]);
    assert.equal((await entries(log)).length, before);
  }
}

async function exerciseAliReview(page, log) {
  await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial', exact: true });
  for (const via of ['panel', 'chat', 'directorio']) {
    await page.reload();
    await expect(workspace).toContainText('Entorno Heka: Pruebas');
    await prepareFreight(workspace);
    const draft = 'Descripción sintética que no se envía';
    const before = (await entries(log)).length;
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.prepare-guide', 'borrador de guía heka', button(workspace, 'Revisar antes de emitir'));
    await prepareGuide(workspace, draft);
    const issue = page.getByRole('dialog', { name: 'Confirmar emisión de guía', exact: true });
    const heading = issue.getByRole('heading', { name: 'Confirmar emisión de guía', exact: true });
    const consent = issue.getByRole('checkbox');
    await expect(issue).toContainText(draft);
    await expect(issue).toContainText('Entorno Heka: Pruebas.');
    await expect(consent).not.toBeChecked();
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.issue-guide', 'generar guía oficial', heading, button(issue, 'Ayúdame con esta revisión'));
    await expect(button(issue, 'Emitir guía en Heka')).toBeDisabled();
    await expect(consent).not.toBeChecked();
    await expect(issue).toContainText(draft);
    await button(issue, 'Volver sin enviar').click();
    await expect(form(workspace, 'Datos para emitir guía').getByLabel('Descripción del producto')).toHaveValue(draft);
    assert.equal((await entries(log)).length, before);

    await operate(workspace, 'Novedades');
    await button(form(workspace, 'Consultar novedades'), 'Consultar novedades').click();
    const solution = workspace.getByRole('textbox', { name: 'Solución para Heka', exact: true });
    await solution.fill(SOLUTION);
    const read = (await entries(log)).length;
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.prepare-novelty-solution', 'redactar solución heka', solution);
    await expect(solution).toHaveValue(SOLUTION);
    await button(workspace, 'Revisar solución').click();
    const confirm = page.getByRole('dialog', { name: 'Confirmar solución de novedad', exact: true });
    const confirmHeading = confirm.getByRole('heading', { name: 'Confirmar solución de novedad', exact: true });
    await expect(confirm).toContainText(SOLUTION);
    await expect(confirm).toContainText('Heka enviará la novedad a revisión');
    if (via !== 'panel') await arriveFromAli(page, via, 'heka.submit-novelty-solution', 'responder novedad heka', confirmHeading, button(confirm, 'Ayúdame con esta revisión'));
    await expect(button(confirm, 'Enviar solución a Heka')).toBeDisabled();
    await expect(confirm.getByRole('checkbox')).not.toBeChecked();
    await button(confirm, 'Volver sin enviar').click();
    await expect(solution).toHaveValue(SOLUTION);
    assert.equal((await entries(log)).length, read);
  }
}

async function exerciseAliVerification(page, log, via) {
  await saveFixture(page, log);
  const workspace = page.getByRole('region', { name: 'Operaciones de Heka oficial', exact: true });
  const journal = workspace.getByRole('region', { name: 'Historial de operaciones Heka', exact: true });
  async function reconcile(create, result) {
    assert.equal(result.status(), 202, await result.text());
    const { mutation } = await result.json();
    assert.equal(mutation.state, 'uncertain');
    const relevant = form(journal, `Verificar solicitud ${mutation.requestId}`);
    const id = create ? 'heka.reconcile-uncertain-guide' : 'heka.reconcile-uncertain-novelty';
    const query = create ? 'conciliar emisión heka' : 'conciliar solución heka';
    const before = (await entries(log)).length;
    await operate(workspace, 'Guías');
    if (via === 'panel') await operate(workspace, 'Historial de operaciones');
    else await arriveFromAli(page, via, id, query, relevant);
    assert.equal((await entries(log)).length, before);
    await expect(journal).not.toContainText(create ? 'Destinatario de prueba' : UNCERTAIN_SOLUTION);
    if (create) {
      await fill(relevant, 'ID exacto de guía en Heka', GUIDE_C._id);
      await fill(relevant, 'Número exacto de la guía', GUIDE_C.guide_number);
    }
    await button(relevant, 'Revisar verificación').click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar verificación en Heka', exact: true });
    await expect(dialog).toContainText(mutation.requestId);
    if (via !== 'panel') await arriveFromAli(page, via, id, query, dialog.getByRole('heading'), button(dialog, 'Ayúdame con esta revisión'));
    assert.equal((await entries(log)).length, before);
    if (create) {
      await expect(button(dialog, 'Verificar en Heka')).toBeDisabled();
      await dialog.getByRole('checkbox').check();
    }
    const receipt = await clickAndWait(page, dialog, 'Verificar en Heka');
    assert.equal(receipt.status(), 200, await receipt.text());
    const verified = (await receipt.json()).mutation;
    assert.equal(verified.requestId, mutation.requestId);
    assert.equal(verified.state, 'succeeded');
    assert.ok(verified.reconciledAt);
    const proof = create ? 'Esto no prueba que la solicitud original la haya creado.' : 'Se verificó la solución existente en Heka.';
    await expect(journal).toContainText(proof);
    assert.deepEqual((await entries(log)).slice(before), [{ method: 'GET', path: create ? '/shipments/guide/v2/external' : '/shipments/novelty', productionBranch: false }]);
  }

  await prepareFreight(workspace);
  await prepareGuide(workspace, 'Envío sin respuesta verificable');
  const issue = page.getByRole('dialog', { name: 'Confirmar emisión de guía', exact: true });
  await issue.getByRole('checkbox').check();
  await reconcile(true, await clickAndWait(page, issue, 'Emitir guía en Heka'));
  await operate(workspace, 'Novedades');
  await button(form(workspace, 'Consultar novedades'), 'Consultar novedades').click();
  await fill(workspace, 'Solución para Heka', UNCERTAIN_SOLUTION);
  await button(workspace, 'Revisar solución').click();
  const solution = page.getByRole('dialog', { name: 'Confirmar solución de novedad', exact: true });
  await solution.getByRole('checkbox').check();
  await reconcile(false, await clickAndWait(page, solution, 'Enviar solución a Heka'));
  assert.equal(await calls(log, 'POST', '/shipments/guide'), 1);
  assert.equal(await calls(log, 'PATCH', `/shipments/novelty/${NOVELTY}`), 1);
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
  const arg = process.argv[2];
  const filter = { '--ali-queries': exerciseAliQueries, '--ali-labels': exerciseAliLabels, '--ali-copy': exerciseAliCopy, '--ali-review': exerciseAliReview }[arg];
  await mkdir(path.join(root, '.test-data'), { recursive: true });
  const browser = await chromium.launch();
  try {
    const standard = [
      ['escritorio', { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, (page, log) => exercise(page, log, false)],
      ['móvil', devices['iPhone 13'], (page, log) => exercise(page, log, true)],
    ];
    const advisor = [
      ['consultas de Ali en escritorio', devices['Desktop Chrome'], exerciseAliQueries],
      ['consultas de Ali en móvil', { ...devices['iPhone 13'], viewport: { width: 320, height: 740 } }, exerciseAliQueries],
      ['etiquetas y acceso de Ali en escritorio', devices['Desktop Chrome'], exerciseAliLabels],
      ['etiquetas y acceso de Ali en móvil', { ...devices['iPhone 13'], viewport: { width: 320, height: 740 } }, exerciseAliLabels],
      ['copia a borrador de Ali en escritorio', devices['Desktop Chrome'], exerciseAliCopy],
      ['copia a borrador de Ali en móvil', { ...devices['iPhone 13'], viewport: { width: 320, height: 740 } }, exerciseAliCopy],
      ['revisión de Ali en escritorio', devices['Desktop Chrome'], exerciseAliReview],
      ['revisión de Ali en móvil', { ...devices['iPhone 13'], viewport: { width: 320, height: 740 } }, exerciseAliReview],
    ];
    function viaScenarios(label, exercise) {
      return [
        ['escritorio', devices['Desktop Chrome']],
        ['móvil', { ...devices['iPhone 13'], viewport: { width: 320, height: 740 } }],
      ].flatMap(([profile, device]) => ['panel', 'chat', 'directorio'].map(via => [
        `${label} desde ${via} en ${profile}`, device, (page, log) => exercise(page, log, via),
      ]));
    }
    const link = viaScenarios('vincular guía', exerciseLocalLink), verification = viaScenarios('verificar resultado incierto', exerciseAliVerification);
    const scenarios = filter ? advisor.filter(([, , exercise]) => exercise === filter)
      : arg === '--ali-link' ? link : arg === '--ali-verify' ? verification : [...standard, ...link, ...advisor, ...verification];
    for (const [label, device, check] of scenarios) {
      await withFixture(browser, device, check);
      console.log(`Heka oficial: recorrido ${label} aprobado; solo transporte sintético.`);
    }
  } finally { await browser.close(); }
}

if (process.argv[2] === '--serve') await serve(process.argv[3], process.argv[4] === '--empty-business');
else await main();
