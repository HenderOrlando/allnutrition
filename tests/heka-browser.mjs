// Isolated Chromium acceptance: real Next routes, SQLite, and a closed fixture transport.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, request } from 'playwright';
import { expect as playwrightExpect } from '@playwright/test';
import { login, navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './e2e/helpers.mjs';
import { createAdmin, login as loginStore } from '../lib/auth.mjs';
import { saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { openStore } from '../lib/db/index.mjs';
import { seed } from '../lib/seed.mjs';
import { saveShippingRecipient } from '../lib/business/shipping-recipients.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { FIXTURE_KEY, FIXTURE_PRODUCTION_KEY, GUIDE_A, GUIDE_B, GUIDE_C, NOVELTY, SOLUTION, TEMPLATE, UNCERTAIN_SOLUTION, WAREHOUSE, installHekaBrowserTransport } from './heka-browser-transport.mjs';
import { startAssistantProviderFixture } from './assistant-provider-fixture.mjs';
import { createBusinessFixture } from './business-fixtures.mjs';
import { linkSyntheticGuide } from './shipping-finance-contract.mjs';
import { saveHekaSettings } from '../lib/business/heka-api.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), file = fileURLToPath(import.meta.url);
const FIXTURE_CUSTOMER = 'Pedido sintético para vincular';
const WEBHOOK_TEST_SECRET = 'whsec_synthetic_heka_test';
const SETTINGS = '/api/admin/shipping/heka', CLASSIC = '/api/admin/shipping/connections';
const expect = playwrightExpect.configure({ timeout: 20000 });
const byText = (scope, value) => scope.getByText(value, { exact: true });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const form = (scope, name) => scope.getByRole('form', { name, exact: true });
const fill = (scope, name, value) => scope.getByLabel(name, { exact: true }).fill(value);
const operate = (workspace, label) => ['Datos de envío','Etiquetas PDF','Historial de operaciones'].includes(label)?button(workspace,label).click():selectWorkspace(workspace, 'Centro de envíos', label);
const center = page => page.getByRole('region',{name:'Centro de envíos',exact:true});
const prep = workspace => workspace.getByRole('region',{name:'Preparar envío',exact:true});
const quoteLabel='Cotizar con Heka · solo cotizar';
const response = (page, pathname, method) => page.waitForResponse(item => item.request().method() === method && new URL(item.url()).pathname === pathname);
const entries = async log => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const calls = async (log, method, pathname) => (await entries(log)).filter(item => item.method === method && item.path === pathname).length;
async function clickAndWait(page, scope, title, operation = 'POST', endpoint = `${SETTINGS}/operate`) {
  const pending = response(page, endpoint, operation);
  await button(scope, title).click();
  return pending;
}

async function serve(scratch, mode) {
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
    if (!mode) {
      await seed(store);
      const [product] = await store.list('products'), actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
      const measured=await store.save('products',{...product,packedWeightG:1000,packedLengthMm:60,packedWidthMm:70,packedHeightMm:50},product.id,product.version);
      const order={placedOn:bogotaDate(),customerName:FIXTURE_CUSTOMER,phone:'3000000000',city:'Bogotá',department:'Cundinamarca',status:'new',deliveryMethod:'carrier',shippingChargeMinor:0,
        items:[{kind:'products',itemId:measured.id,quantity:1,unitPriceMinor:Math.round(measured.price*100),discountMinor:0}]};
      for(const [address,addressNotes] of [['Dirección sintética de prueba','Apartamento 1'],['Segundo domicilio sintético','Apartamento 2']])await store.saveOrder({...order,address,addressNotes,requestId:crypto.randomUUID()},actor.id);
      await saveShippingRecipient(store,{recipient:{customerName:'Contacto guardado',phone:'3000000009',city:'Bogotá',department:'Cundinamarca',address:'Dirección guardada sintética'}},actor.id);
      const at=new Date().toISOString(),scope={connection_id:'heka',environment:'test',generation:1};
      await insertRow(store,'shipping_novelty_sync',{...scope,next_sequence:'open',next_at:at,last_success_at:at});
      await insertRow(store,'shipping_novelties',{...scope,guide_id:GUIDE_B._id,novelty_id:NOVELTY,state:'pending',revision:1,fingerprint:'1'.repeat(64),updated_at:at,data:JSON.stringify({...GUIDE_B,status_novelty:'in_novelty',last_novelty:{_id:NOVELTY,message:'Cliente no disponible'},movemens:[{label:'Visita de prueba'}]})});
      await insertRow(store,'shipping_novelty_events',{...scope,id:crypto.randomUUID(),guide_id:GUIDE_B._id,novelty_id:NOVELTY,revision:1,created_at:at});
    }
    const { user, csrf, token } = await loginStore(store, email, 'clave-e2e-solo-pruebas');
    if(mode==='--finance'){
      const session={user,csrf,sessionTokenHash:createHash('sha256').update(token).digest('hex')};
      const config=await saveHekaSettings(store,{version:0,environment:'production',apiKey:FIXTURE_PRODUCTION_KEY},session);
      const guide=GUIDE_A;
      const {orderId,shipmentId,actorId,year}=await createBusinessFixture(store,{actorId:user.id,tracking:guide.guide_number});
      await recordExpense(store,{requestId:crypto.randomUUID(),category:'shipping_return',amountMinor:100000,incurredOn:`${year}-09-03`,shipmentId,orderId,concept:'Flete de retorno sintético'},actorId);
      await linkSyntheticGuide(store,{guideId:guide._id,carrier:guide.distributor_id,localCarrier:'Transportadora sintética',tracking:guide.guide_number,shipmentId,orderId,actorId});
      const at=new Date().toISOString(), scope={connection_id:'heka',environment:'production',generation:config.version};
      await insertRow(store,'shipping_novelty_sync',{...scope,next_sequence:'open',next_at:at,last_success_at:at});
      await insertRow(store,'shipping_novelties',{...scope,guide_id:guide._id,novelty_id:NOVELTY,state:'pending',revision:1,fingerprint:'1'.repeat(64),updated_at:at,data:JSON.stringify({...guide,status_novelty:'in_novelty',last_novelty:{_id:NOVELTY,message:'Novedad sintética con recaudo'}})});
      await insertRow(store,'shipping_novelty_events',{...scope,id:crypto.randomUUID(),guide_id:guide._id,novelty_id:NOVELTY,revision:1,created_at:at});
    }
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
  await button(config, 'Abrir Centro de envíos').click();
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
  await expect(workspace).toContainText('Localidad elegida');
  await button(form(workspace, 'Listar bodegas'), 'Listar bodegas').click();
  await button(workspace, 'Usar bodega para el envío').click();
  await button(form(workspace, 'Consultar plantillas'), 'Consultar plantillas').click();
  await button(workspace, 'Aplicar a los datos de envío').click();
  await operate(workspace, 'Cotizar');
}

async function prepareGuide(workspace, product) {
  if(!await form(workspace,'Datos para emitir guía').isVisible())await button(workspace, 'Preparar emisión manual').click();
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
  const workspace = center(page);
  await expect(workspace).toContainText('Entorno Heka: Pruebas');
  await selectWorkspace(page, 'Vistas de pedidos', 'Seguimiento de envíos');
  await button(page, 'Abrir Centro de envíos').click();
  await expect(workspace).toContainText('Entorno Heka: Pruebas');
  const search = form(workspace, 'Buscar guías');
  await fill(search, 'Número de guía, nombre o teléfono', 'ERROR-DE-PROVEEDOR');
  assert.equal((await clickAndWait(page, search, 'Buscar guías')).status(), 403);
  await expect(workspace.getByRole('alert')).toBeVisible();
  await expect(workspace).not.toContainText('no muestres el mensaje privado');
  await expect(workspace).not.toContainText('Todavía no hay guías.');
  await fill(search, 'Número de guía, nombre o teléfono', 'SIN-RESULTADOS');
  await button(search, 'Buscar guías').click();
  await expect(byText(workspace, 'Ninguna guía coincide.')).toBeVisible();
  await fill(search, 'Número de guía, nombre o teléfono', '');
  await button(search, 'Buscar guías').click();
  await expect(byText(workspace, 'Página 1 de 3 · 41 resultados')).toBeVisible();
  await expect(button(workspace, 'Vincular guía a un pedido')).toHaveCount(0);
  await button(workspace, 'Siguiente').click();
  await expect(byText(workspace, 'Página 2 de 3 · 41 resultados')).toBeVisible();
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
  const quote = prep(workspace), sent = await calls(log, 'POST', '/shipments/guide');
  await expect(quote.getByLabel('Código DANE de destino', { exact: true })).toHaveValue('05001000');
  await button(quote, quoteLabel).click();
  await expect(workspace.getByRole('region',{name:'Comparación de tarifas'})).toContainText('Total estimado');
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
  await expect(workspace).toContainText('Cliente no disponible');
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

  await button(workspace, 'Configurar conexión Heka').click();
  await expect(page.getByRole('region', { name: 'Conexión oficial de Heka' })).toBeVisible();
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
  await button(settings, 'Abrir Centro de envíos').click();
  const workspace = center(page);
  await expect(workspace).toContainText('Entorno Heka: Producción');
  await operate(workspace,'Guías');
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
  const workspace = center(page);
  const cases = [
    ['search-guides', 'estado heka', 'Guías', 'Buscar guías', 'Buscar guías', '/shipments/guide/v2/external', `Guía ${GUIDE_A.guide_number}`],
    ['search-cities', 'código dane', 'Datos de envío', 'Buscar ciudades', 'Buscar ciudades', '/geolocation/city', '11001000', 'Ciudad o departamento', 'BOGOTA'],
    ['search-warehouses', 'lista bodegas heka', 'Datos de envío', 'Listar bodegas', 'Listar bodegas', '/warehouse', 'Bodega de prueba'],
    ['search-templates', 'buscar plantilla de envío', 'Datos de envío', 'Consultar plantillas', 'Consultar plantillas', '/shipping/template', 'Plantilla de prueba'],
    ['read-recipient-history', 'guías del destinatario heka', 'Destinatarios', 'Consultar historial de destinatario', 'Consultar historial de destinatario', '/shipments/client-log', '***123', 'Documento del destinatario', '000123'],
    ['read-recipient-rating', 'calificación por teléfono heka', 'Destinatarios', 'Calificación del destinatario', 'Consultar calificación', '/shipments/guide/client', 'qualified', 'Teléfono del destinatario', '3000000000'],
    ['search-novelties', 'incidencias heka', 'Novedades', 'Novedades', 'Actualizar bandeja', null, 'Cliente no disponible'],
    ['quote-shipment', 'cuánto cuesta envío heka', 'Cotizar', 'Preparar envío', quoteLabel, '/shipping/quoter', 'Total estimado'],
  ];
  for (const [id, query, tab, heading, submit, pathname, result, label, value] of cases) {
    for (const via of ['panel', 'chat', 'directorio']) {
      const fromOutside=id==='search-guides'&&via!=='panel';
      await page.goto(fromOutside?'/admin?section=orders&tab=list':'/admin?section=orders&tab=heka&panel=journal',{waitUntil:'domcontentloaded'});
      if(fromOutside)await expect(page.getByRole('button',{name:/^Abrir pedido AN-/}).first()).toBeVisible();
      else await expect(workspace).toContainText('Entorno Heka: Pruebas');
      if (id === 'quote-shipment') {await prepareFreight(workspace);await operate(workspace,'Historial de operaciones');}
      const before = (await entries(log)).length;
      const target = workspace.getByRole('heading', { name: heading, exact: true });
      if (via === 'panel') await operate(workspace, tab);
      else await arriveFromAli(page, via, `heka.${id}`, query, target);
      if(via!=='panel'||id!=='search-guides')assert.equal((await entries(log)).length, before, `${id} · ${via}: la llegada no debe consultar Heka`);
      const section = target.locator('..');
      if (label) await fill(section, label, value);
      if(id==='search-guides'){
        if(via!=='panel')await button(section,submit).click();
        await expect(section).toContainText(result);
        await expect(button(section,'Reintentar totales')).toBeVisible();
        const sent=(await entries(log)).slice(before);
        assert.equal(sent.length,8);assert.ok(sent.every(request=>request.method==='GET'&&request.path===pathname));
      }else if(id==='search-novelties'){
        await expect(section).toContainText(result);
        await button(section,submit).click();
        assert.equal((await entries(log)).length,before);
      } else {
        const quoted=id==='quote-shipment';
        const sent=await clickAndWait(page,section,submit,'POST',quoted?'/api/admin/shipping/quotes':`${SETTINGS}/operate`);
        assert.equal(sent.status(),200,await sent.text());
        await expect(quoted?workspace:section).toContainText(result);
        assert.deepEqual((await entries(log)).slice(before),[{method:quoted?'POST':'GET',path:pathname,productionBranch:false}]);
      }
    }
  }
}

async function exerciseAliLabels(page, log) {
  await saveFixture(page, log);
  const workspace = center(page);
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
    await button(settings, 'Abrir Centro de envíos').click();
    await operate(workspace,'Guías');
    await expect(button(workspace,'Reintentar totales')).toBeVisible();
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
  const workspace = center(page),freight=prep(workspace),city=form(workspace,'Buscar ciudades');
  const origin='Código DANE de origen',destination='Código DANE de destino',warehouse='Bodega Heka';
  const fields=[origin,destination,warehouse,'Peso del bulto (kg)'];
  const expected = ['11001111', '05001234', 'bodega-local', '3'];
  const baseline = async () => {
    await operate(workspace, 'Cotizar');
    await openDisclosure(freight,'Opciones de Heka');
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
      await operate(workspace, 'Cotizar');
      await expect(freight.getByLabel(origin, { exact: true })).toHaveValue(expected[0]);
      await operate(workspace, 'Datos de envío');
    }
    if (search === 'Buscar ciudades') await fill(city, 'Ciudad o departamento', 'BOGOTA');
    assert.equal((await clickAndWait(page, form(workspace, search), search)).status(), 200);
    const before = (await entries(log)).length, target = button(workspace, label);
    if (via !== 'panel') await arriveFromAli(page, via, `heka.${id}`, query, target);
    await target.click();
    await operate(workspace, 'Cotizar');
    for (const [index, field] of fields.entries()) await expect(freight.getByLabel(field, { exact: true })).toHaveValue(values[index]);
    assert.equal((await entries(log)).length, before);
  }
}

async function exerciseAliReview(page, log) {
  await saveFixture(page, log);
  const workspace = center(page);
  for (const via of ['panel', 'chat', 'directorio']) {
    await page.reload();
    await expect(workspace).toContainText('Entorno Heka: Pruebas');
    await prepareFreight(workspace);
    await button(workspace,'Preparar emisión manual').click();
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
  const workspace = center(page);
  const journal = workspace.getByRole('region', { name: 'Historial de operaciones Heka', exact: true });
  async function reconcile(create, result) {
    assert.equal(result.status(), 202, await result.text());
    const { mutation } = await result.json();
    assert.equal(mutation.state, 'uncertain');
    const relevant = form(journal, `Verificar solicitud ${mutation.requestId}`);
    const id = create ? 'heka.reconcile-uncertain-guide' : 'heka.reconcile-uncertain-novelty';
    const query = create ? 'conciliar emisión heka' : 'conciliar solución heka';
    const before = (await entries(log)).length;
    await operate(workspace, 'Destinatarios');
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
  await fill(workspace, 'Solución para Heka', UNCERTAIN_SOLUTION);
  await button(workspace, 'Revisar solución').click();
  const solution = page.getByRole('dialog', { name: 'Confirmar solución de novedad', exact: true });
  await solution.getByRole('checkbox').check();
  await reconcile(false, await clickAndWait(page, solution, 'Enviar solución a Heka'));
  assert.equal(await calls(log, 'POST', '/shipments/guide'), 1);
  assert.equal(await calls(log, 'PATCH', `/shipments/novelty/${NOVELTY}`), 1);
}

async function exerciseCenter(page,log) {
  await page.goto('/admin?section=orders&tab=heka&panel=freight');
  const workspace=center(page);
  let form=prep(workspace);
  const {records:products}=await (await page.request.get('/api/admin/products')).json();
  const product=products.find(row=>row.packedWeightG===1000);
  const catalog=button(form,'Agregar producto o combo');
  await catalog.click();
  await expect(form.getByLabel('SKU o nombre')).toBeFocused();
  await fill(form,'SKU o nombre',product.sku||product.title);
  await form.getByRole('button',{name:`Agregar ${product.title}${product.sku?` · ${product.sku}`:''}`,exact:true}).click();
  await expect(catalog).toBeFocused();
  const quantity=form.getByLabel('Cantidad',{exact:true}),weight=form.getByLabel('Peso del bulto (kg)',{exact:true}),length=form.getByLabel('Largo del bulto (cm)',{exact:true});
  await expect(weight).toHaveValue('1');
  await expect(length).toHaveValue('6');
  await expect(form.getByLabel('Valor declarado (COP)')).toHaveValue(String(product.price));
  await quantity.fill('2');
  await expect(weight).toHaveValue('2');
  await expect(length).toHaveValue('');
  await expect(form.getByLabel('Valor declarado (COP)')).toHaveValue(String(product.price*2));
  await quantity.fill('1');
  await fill(form,'Largo del bulto (cm)','8');
  await button(form,'Elegir destinatario').click();
  const agenda=form.getByRole('region',{name:'Agenda de destinatarios'});
  await expect(agenda).toContainText('Contacto guardado');
  const otherAddress=agenda.getByRole('listitem').filter({hasText:'Segundo domicilio sintético'});
  await expect(otherAddress).toContainText('Apartamento 2');
  await expect(agenda.getByRole('listitem').filter({hasText:'Dirección sintética de prueba'})).toContainText('0000');
  await button(otherAddress,'Usar para este envío').click();
  await expect(button(form,'Elegir destinatario')).toBeFocused();
  await expect(form.getByLabel('Municipio de destino',{exact:true})).toHaveValue('Bogotá');
  await expect(form.getByLabel('Departamento de destino',{exact:true})).toHaveValue('Cundinamarca');
  await expect(length).toHaveValue('8');
  await openDisclosure(form,'Datos del destinatario para este despacho');
  await expect(form.getByLabel('Dirección',{exact:true})).toHaveValue('Segundo domicilio sintético');
  await expect(form).toContainText('No hay plataformas cotizadoras conectadas');
  assert.equal((await entries(log)).length,0);
  await button(form,'Guardar preparación').click();
  await expect(form).toContainText('Preparación guardada · versión 1');
  await openDisclosure(form,'Preparaciones guardadas');
  await form.getByRole('button',{name:new RegExp(FIXTURE_CUSTOMER)}).click();
  await expect(page).toHaveURL(url=>url.searchParams.has('preparationId'));
  await page.reload({waitUntil:'domcontentloaded'});
  await openDisclosure(form,'Datos del destinatario para este despacho');
  await expect(form.getByLabel('Dirección',{exact:true})).toHaveValue('Segundo domicilio sintético');
  await saveFixture(page,log);
  const before=(await entries(log)).length;
  await operate(workspace,'Guías');
  const summary=workspace.getByRole('region',{name:'Guías por transportadora'});
  await expect(button(summary,'Todas · 41 · Activa')).toBeVisible();
  await expect(button(summary,'Coordinadora · 15')).toBeVisible();
  await expect(button(summary,'TCC · No disponible')).toBeVisible();
  const pages=workspace.getByRole('navigation',{name:'Páginas: Buscar guías'});
  await expect(pages).toContainText('Página 1 de 3 · 41 resultados');
  await workspace.getByRole('checkbox',{name:`Incluir guía ${GUIDE_A.guide_number} en etiquetas`,exact:true}).check();
  await button(pages,'Siguiente').focus();
  await page.keyboard.press('Enter');
  await expect(pages).toContainText('Página 2 de 3 · 41 resultados');
  await button(pages,'Anterior').click();
  await expect(workspace.getByRole('checkbox',{name:`Incluir guía ${GUIDE_A.guide_number} en etiquetas`,exact:true})).toBeChecked();
  await button(summary,'Coordinadora · 15').click();
  await expect(pages).toContainText('Página 1 de 1 · 15 resultados');
  await button(workspace,'Limpiar filtros').click();
  await expect(pages).toContainText('Página 1 de 3 · 41 resultados');
  assert.equal((await entries(log)).length,before+12);
  await operate(workspace,'Novedades');
  const inbox=workspace.getByRole('region',{name:'Novedades',exact:true});
  await expect(inbox).toContainText('Cliente no disponible');
  const unread=button(page.getByRole('banner'),'Novedades de envío: 1 sin leer');
  await expect(unread).toBeVisible();
  await inbox.getByRole('button',{name:/Marcar como leída/}).click();
  await expect(unread).toHaveCount(0);
  await expect(inbox).toContainText('Cliente no disponible');
  await expect(inbox.getByRole('heading',{name:`Guía ${GUIDE_B.guide_number}`})).toBeFocused();
  const {records}=await (await page.request.get('/api/admin/orders')).json();
  const order=records.find(row=>row.customerName===FIXTURE_CUSTOMER);
  await page.goto(`/admin?section=orders&tab=heka&panel=freight&orderId=${order.id}`,{waitUntil:'domcontentloaded'});
  form=prep(workspace);
  await expect(form.getByLabel('Peso del bulto (kg)',{exact:true})).toHaveValue('1');
  await expect(form.getByLabel('Largo del bulto (cm)',{exact:true})).toHaveValue('6');
  await fill(form,'Código DANE de origen','11001000');
  await button(form,'Elegir bodega Heka').click();
  const warehouses=form.getByRole('region',{name:'Listar bodegas'});
  await button(warehouses,'Listar bodegas').click();
  await expect(warehouses).toContainText('Bodega de prueba');
  await button(warehouses,'Usar bodega para el envío').click();
  await expect(form).toContainText('Bodega Heka: Bodega de prueba');
  await button(form,quoteLabel).click();
  const results=workspace.getByRole('region',{name:'Comparación de tarifas'});
  await expect(results.getByText('Total estimado',{exact:true})).toBeVisible();
  await expect(results.getByText('2 días',{exact:false})).toBeVisible();
  await expect(results.getByText('Importe informado',{exact:true})).toBeVisible();
  await expect(results.getByText('moneda no informada',{exact:false}).first()).toBeVisible();
  await expect(results.getByRole('option',{name:'Menor total comparable'})).toHaveCount(0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await openDisclosure(form,'Medidas unitarias para futuras ventas');
  await fill(form,'Peso unitario (kg)','1,125');
  await expect(form.getByLabel('Peso del bulto (kg)',{exact:true})).toHaveValue('1');
  await button(form,'Guardar y cotizar').click();
  const unitReview=form.getByRole('region',{name:'Confirmar medidas unitarias'});
  await expect(unitReview).toContainText('1.125 kg');
  const savedPreparation=response(page,'/api/admin/shipping/preparations','POST');
  await button(unitReview,'Confirmar y guardar').click();
  const saved=await savedPreparation;
  assert.equal(saved.status(),200,await saved.text());
  const savedDraft=await saved.json();
  assert.equal(savedDraft.parcel.weightG,1000);
  const storedProduct=await (await page.request.get(`/api/admin/products/${savedDraft.lines[0].itemId}`)).json();
  assert.equal(storedProduct.packedWeightG,1125);
  await expect(results.getByText('2 días',{exact:false})).toBeVisible();
  await button(results,'Usar esta opción').click();
  const issue=workspace.getByRole('form',{name:'Datos para emitir guía'});
  await expect(issue.getByRole('combobox',{name:'Transportadora',exact:true})).toHaveValue('coordinadora');
  await expect(issue.getByLabel('ID de bodega Heka',{exact:true})).toHaveValue(WAREHOUSE);
  await expect(issue.getByLabel('Descripción del producto',{exact:true})).toHaveValue(product.title);
  await expect(issue.getByLabel('Municipio de destino',{exact:true})).toHaveValue('Bogotá');
  await expect(issue.getByLabel('Nombre del destinatario',{exact:true})).toHaveValue('');
  assert.equal(await calls(log,'POST','/shipments/guide'),0);
}

async function exerciseProductionAutofill(page,log) {
  await navigate(page,'Configuración'); await openConfigurationTask(page,'shipping-integrations');
  const settings=form(page,'Configurar API oficial de Heka');
  await settings.getByRole('combobox',{name:'Entorno',exact:true}).selectOption('production');
  await fill(settings,'Llave API de Heka',FIXTURE_PRODUCTION_KEY);
  await button(settings,'Guardar conexión Heka').click();
  const setup=page.getByRole('dialog',{name:'Conectar Heka en producción'});
  await setup.getByRole('checkbox').check();
  assert.equal((await clickAndWait(page,setup,'Guardar en producción','PUT',SETTINGS)).status(),200);
  const {records}=await (await page.request.get('/api/admin/orders')).json();
  const order=records.find(row=>row.customerName===FIXTURE_CUSTOMER);
  const {records:products}=await (await page.request.get('/api/admin/products')).json();
  const product=products.find(row=>row.packedWeightG===1000);
  await page.goto(`/admin?section=orders&tab=heka&panel=freight&orderId=${order.id}`,{waitUntil:'domcontentloaded'});
  const workspace=center(page), preparation=prep(workspace);
  await expect(preparation).toContainText(FIXTURE_CUSTOMER);
  await button(preparation,'Preparar emisión manual').click();
  const guide=form(workspace,'Datos para emitir guía');
  await expect(guide.getByLabel('Descripción del producto',{exact:true})).toHaveValue(product.title);
  await expect(guide.getByLabel('Cantidad',{exact:true})).toHaveValue('1');
  await expect(guide.getByLabel('Peso',{exact:true})).toHaveValue('1');
  await expect(guide.getByLabel('Municipio de destino',{exact:true})).toHaveValue('Bogotá');
  await expect(guide.getByLabel('Nombre del destinatario',{exact:true})).toHaveValue(FIXTURE_CUSTOMER);
  await expect(guide.getByLabel('Teléfono del destinatario',{exact:true})).toHaveValue('3000000000');
  await expect(guide.getByLabel('Dirección del destinatario',{exact:true})).toHaveValue(/domicilio sintético|Dirección sintética/);
  await expect(guide.getByLabel('Indicaciones para la entrega',{exact:true})).toHaveValue(/Apartamento [12]/);
  assert.deepEqual(await entries(log),[]);
}

async function exercisePushWorker(page,log) {
  await saveFixture(page,log);
  const context=page.context(),origin=new URL(page.url()).origin;
  await context.grantPermissions(['notifications'],{origin});
  await expect.poll(()=>page.evaluate(()=>Notification.permission)).toBe('granted');
  await operate(center(page),'Novedades');
  const optIn=button(center(page),'Notificar en este dispositivo');
  await expect(optIn).toBeEnabled();
  // Exercise the real HTTPS registration and VAPID preparation, not an internet delivery.
  const prepared=response(page,'/api/admin/shipping/push','POST');
  await optIn.click();
  assert.equal((await prepared).status(),200);
  const scope=await page.evaluate(async()=>(await navigator.serviceWorker.ready).scope);
  assert.equal(scope,`${origin}/admin`);
  const observer=await context.newPage();
  await observer.goto('/');
  const cdp=await context.newCDPSession(observer);
  const registration=new Promise(resolve=>cdp.on('ServiceWorker.workerRegistrationUpdated',({registrations})=>{
    const worker=registrations.find(row=>row.scopeURL===scope&&!row.isDeleted);
    if(worker)resolve(worker.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  const registrationId=await Promise.race([registration,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Chromium no registró el worker de envíos')),5000).unref())]);
  const {latestEventId:eventId}=await (await page.request.get('/api/admin/shipping/novelties?summary=1')).json();
  assert.ok(eventId);
  await page.close();
  const tag='ship-0123456789abcdef01234567';
  await cdp.send('ServiceWorker.deliverPushMessage',{origin,registrationId,data:JSON.stringify({environment:'test',tag,eventId})});
  await expect.poll(()=>observer.evaluate(async tag=>{
    const worker=await navigator.serviceWorker.getRegistration('/admin');
    return (await worker.getNotifications({tag})).map(({title,body,tag,data})=>({title,body,tag,data}));
  },tag)).toEqual([{title:'Envíos · Pruebas',body:'Hay una actualización. Abre la bandeja de envíos en el administrador para revisarla.',tag,data:{eventId}}]);
  await cdp.detach();
}

async function exerciseHekaWebhook(page,log) {
  const anonymous=await request.newContext({baseURL:new URL(page.url()).origin,ignoreHTTPSErrors:true});
  try {
    const timestamp=new Date().toISOString(), event='webhook.test';
    const body=` ${JSON.stringify({id:'evt_synthetic',event,created_at:timestamp,data:{}})}\n`;
    const hmac=createHmac('sha256',WEBHOOK_TEST_SECRET).update(`${timestamp}.${body}`).digest('hex');
    const headers={'content-type':'application/json','x-heka-event':event,'x-heka-delivery':'dlv_synthetic','x-heka-timestamp':timestamp,'x-heka-signature':`sha256=${hmac}`};
    const post=(environment,data=body)=>anonymous.post(`/api/shipping/heka/webhook/${environment}`,{headers,data,maxRedirects:0});
    assert.equal((await post('test')).status(),404);
    const adminPath=`${SETTINGS}/webhook`;
    assert.equal((await anonymous.get(adminPath)).status(),401);
    await navigate(page,'Configuración'); await openConfigurationTask(page,'shipping-integrations');
    const settings=page.getByRole('region',{name:'Conexión oficial de Heka'});
    const connection=form(settings,'Configurar API oficial de Heka');
    const webhook=settings.getByRole('region',{name:'Webhook de Heka'});
    await expect(webhook).toContainText('Webhook inactivo');
    await fill(connection,'Llave API de Heka',FIXTURE_KEY);
    assert.equal((await clickAndWait(page,connection,'Guardar conexión Heka','PUT',SETTINGS)).status(),200);
    const field=webhook.getByLabel('Secreto de firma de Heka');
    await expect(field).toHaveAttribute('type','password');
    await field.fill(WEBHOOK_TEST_SECRET);
    const saved=await clickAndWait(page,webhook,'Guardar secreto del webhook','PUT',adminPath);
    assert.equal(saved.status(),200);
    assert.ok(!(await saved.text()).includes(WEBHOOK_TEST_SECRET));
    await expect(field).toHaveValue('');
    await page.reload();
    await expect(webhook).toContainText('Secreto guardado en el servidor');
    await expect(field).toHaveValue('');
    assert.equal((await post('production')).status(),404);
    assert.equal((await post('test',body.trim())).status(),401);
    const result=await post('test');
    assert.equal(result.status(),204);
    assert.equal((await result.body()).length,0);
    await button(webhook,'Retirar secreto del webhook').click();
    const removal=page.getByRole('dialog',{name:'Retirar el secreto del webhook de Heka'});
    assert.equal((await clickAndWait(page,removal,'Retirar secreto','DELETE',adminPath)).status(),200);
    await expect(webhook).toContainText('Webhook inactivo');
    assert.equal((await post('test')).status(),404);
    assert.deepEqual(await entries(log),[]);
  } finally { await anonymous.dispose(); }
}

async function exerciseShippingFinance(page,log) {
  const counts=async()=>{
    const today=bogotaDate();
    const response=await page.request.get(`/api/admin/finance/movements?startDate=${today}&endDateExclusive=2099-01-01`);
    assert.equal(response.status(),200);
    return (await response.json()).total;
  };
  const before=await counts();
  const summary=await (await page.request.get('/api/admin/shipping/novelties?summary=1')).json();
  assert.ok(summary.latestEventId);
  await page.goto(`/admin?section=orders&tab=heka&panel=novelties&eventId=${summary.latestEventId}`);
  const inbox=center(page).getByRole('region',{name:'Novedades',exact:true});
  await expect(inbox).toContainText('Novedad sintética con recaudo');
  await button(inbox,'Abrir envío local y revisar Caja').click();
  const finance=page.getByRole('region',{name:'Caja de este envío'});
  await expect(finance).toContainText('SETTLEMENT-P');
  assert.equal(await counts(),before);
  await button(finance,'Confirmar recepción de liquidación').click();
  const submit=finance.locator('button[type=submit]');
  await expect(submit).toBeDisabled();
  const account=finance.getByRole('combobox',{name:/^Cuenta de recepción/});
  await account.selectOption({label:'Banco sintético'});
  await fill(finance,'Referencia única del recibo','RECIBO-GUIA-PRUEBA');
  assert.equal(await counts(),before);
  await finance.getByRole('checkbox',{name:'Confirmo que el dinero indicado ya fue recibido o pagado.'}).check();
  const posted=response(page,'/api/admin/business/actions/settlement-confirm','POST');
  await submit.click();
  const result=await posted;
  assert.ok(result.ok(),await result.text());
  await expect(finance).not.toContainText('SETTLEMENT-P');
  assert.equal(await counts(),before+1);
  assert.deepEqual(await entries(log),[]);
  await page.goto('/admin?section=orders&tab=heka&panel=guides');
  await button(center(page),'Abrir envío local').click();
  await expect(finance).toContainText('Flete de retorno sintético');
  await button(finance,'Registrar pago de gasto vinculado').click();
  await expect(finance.locator('button[type=submit]')).toBeDisabled();
  await finance.getByRole('textbox',{name:/^Importe \(COP\)/}).fill('1000');
  await finance.getByRole('combobox',{name:/^Cuenta/}).selectOption({label:'Banco sintético'});
  assert.equal(await counts(),before+1);
  await finance.getByRole('checkbox',{name:'Confirmo que el dinero indicado ya fue recibido o pagado.'}).check();
  const payment=response(page,'/api/admin/business/actions/pay-expense','POST');
  await finance.locator('button[type=submit]').click();
  const paid=await payment;
  assert.ok(paid.ok(),await paid.text());
  await expect(finance).toContainText('No hay cobros pendientes');
  assert.equal(await counts(),before+2);
  assert.equal(await calls(log,'POST','/shipments/guide'),0);
}

async function withFixture(browser, device, check) {
  const scratch = await mkdtemp(path.join(root, '.test-data', 'heka-browser-')), log = path.join(scratch, 'provider.jsonl');
  let child, context;
  try {
    await writeFile(log, '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(scratch, 'https.key'), '-out', path.join(scratch, 'https.crt')], { stdio: 'ignore' });
    child = fork(file, ['--serve', scratch,...(check===exerciseShippingFinance?['--finance']:[])], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const url = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(([code]) => { throw new Error(`Servidor de fixture detenido (${code}).`); })]);
    context = await browser.newContext({ ...device, baseURL: url, ignoreHTTPSErrors: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog=>{void (['confirm','beforeunload'].includes(dialog.type())?dialog.accept():dialog.dismiss());});
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
  const browser = await chromium.launch({channel:'chromium',args:['--ignore-certificate-errors']});
  try {
    const standard = [
      ['escritorio', { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, (page, log) => exercise(page, log, false)],
      ['móvil', devices['iPhone 13'], (page, log) => exercise(page, log, true)],
      ['Centro de envíos · escritorio', devices['Desktop Chrome'], exerciseCenter],
      ['Centro de envíos · 320 px', {...devices['iPhone 13'],viewport:{width:320,height:740}}, exerciseCenter],
      ['Precarga de guía en producción sintética', devices['Desktop Chrome'], exerciseProductionAutofill],
      ['Caja desde novedad vinculada · escritorio', devices['Desktop Chrome'], exerciseShippingFinance],
      ['Caja desde novedad vinculada · 320 px', {...devices['iPhone 13'],viewport:{width:320,height:740}}, exerciseShippingFinance],
      ['Service worker Push por HTTPS · evento local', devices['Desktop Chrome'], exercisePushWorker],
      ['Webhook firmado por HTTPS', devices['Desktop Chrome'], exerciseHekaWebhook],
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
      : arg==='--push-worker'?standard.filter(([, , check])=>check===exercisePushWorker)
      : arg==='--webhook'?standard.filter(([, , check])=>check===exerciseHekaWebhook)
      : arg==='--production-autofill' ? standard.filter(([, , check])=>check===exerciseProductionAutofill)
      : arg==='--shipping-autofill' ? standard.filter(([, , check])=>check===exerciseCenter||check===exerciseProductionAutofill)
      : arg==='--shipping-center' ? standard.filter(([, , check])=>[exerciseCenter,exerciseProductionAutofill,exercisePushWorker,exerciseHekaWebhook,exerciseShippingFinance].includes(check)) : arg === '--ali-link' ? link : arg === '--ali-verify' ? verification : [...standard, ...link, ...advisor, ...verification];
    for (const [label, device, check] of scenarios) {
      await withFixture(browser, device, check);
      console.log(`Heka oficial: recorrido ${label} aprobado; solo transporte sintético.`);
    }
  } finally { await browser.close(); }
}

if (process.argv[2] === '--serve') await serve(process.argv[3], process.argv[4]);
else await main();
