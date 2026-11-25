import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { emptyRecord, schemas } from '../../lib/schema.mjs';
import { login } from './helpers.mjs';
import resetBrowserFixture from './setup.mjs';
import { seedResults } from './social-results-fixture.mjs';
import { createAdmin, getSession, SESSION_COOKIE } from '../../lib/auth.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { evaluateAlerts, getAlertRule, saveAlertRule } from '../../lib/business/alerts.mjs';
import { reserveAdvisorTask } from '../../lib/assistant/advisor-tasks.mjs';
import { testDatabaseEnv } from '../postgres-fixture.mjs';
import { seedAdvisorAlert, seedAdvisorImport, setAdvisorImportResult, stockEpisode } from '../assistant-advisor-fixtures.mjs';
import { businessOrderInput, completedFixtureYear, workbookOnboardingConfig, workbookOnboardingSheets } from '../business-fixtures.mjs';
import { closeCash, saveAccount, recordAdvance, recordIncome } from '../../lib/business/cash.mjs';
import { getBusinessSettings, listResources, saveBusinessSettings, saveResource } from '../../lib/business/settings.mjs';
import { addDays as addC6ReportDays, bogotaDate } from '../../lib/business/dates.mjs';
import { writeExcelSheets } from '../../lib/business/excel.mjs';
import { createHekaWorkbook, normalizeHekaSnapshot } from '../../lib/shipping/heka.mjs';
import { formatMoneyMinor as formatC6ReportMoney } from '../../lib/business/money.mjs';
import { recordExpense } from '../../lib/business/expenses.mjs';
import { createShipment, recordShipmentEvent } from '../../lib/business/shipments.mjs';
import { initializeInventoryOpeningTx, saveOrderTx } from '../../lib/business/orders.mjs';
import { recordCollection, recordRefund, registerReturn } from '../../lib/business/collections.mjs';
import { completeOrderCosts } from '../../lib/business/catalog.mjs';
import { reverseFinancialDocument } from '../../lib/business/finance.mjs';
import { saveSettlement, confirmSettlement } from '../../lib/business/settlements.mjs';
import { confirmPayroll, materializePayrollAccrualsTx, payPayroll } from '../../lib/business/payroll.mjs';
import { createImportBatch, getImportBatch, commitImport, processImportTurn, requestImportPreview, updateImportBatch, uploadImportFile } from '../../lib/business/imports.mjs';
import { advisorImportWorkbook, prepareAdvisorImportBatch } from '../assistant-advisor-imports-contract.mjs';
import { getSocialCampaign, saveSocialCampaign } from '../../lib/business/social.mjs';
import { generateReportSnapshot, getReportCopyRunTx, processReportTurn, reportQueryKey } from '../../lib/business/reports.mjs';
import { buildDashboard } from '../../lib/business/dashboard.mjs';
import { insertRow } from '../../lib/business/commands.mjs';
import { createShippingConnection, createShippingPairing, pairShippingBridge, reportShippingIdentity, claimShippingQuery, completeShippingQuery } from '../../lib/business/shipping-bridge.mjs';
import { LEASE_MILLISECONDS } from '../../lib/business/job-leases.mjs';
import { hekaSnapshot } from '../heka-fixtures.mjs';

const controlURL = process.env.ALI_FIXTURE_CONTROL_URL;
const baseURL = process.env.ALI_FIXTURE_BASE_URL;
async function control(request, body) {
  if (!controlURL || !baseURL) throw new Error('Set ALI_FIXTURE_CONTROL_URL and ALI_FIXTURE_BASE_URL to the private synthetic fixture');
  const response = await request.post(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function screenshot(page, info, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false, animations: 'disabled' });
}

async function loginWithAdvisorFixture(page, request) {
  await control(request, { action: 'reset' });
  await login(page);
  await page.goto('/admin?section=business&tab=assistant');
  await page.locator('select[name=provider]').selectOption('openai-compatible');
  await page.locator('input[name=baseUrl]').fill(baseURL);
  await page.locator('input[name=model]').fill('fixture-a');
  await page.locator('input[name=apiKey]').fill('assistant-fixture-only');
  await page.locator('input[name=allowPrivateNetwork]').check();
  await page.locator('input[name=enabled]').check();
  const verified = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Guardar y verificar', exact: true }).click();
  expect((await verified).ok()).toBe(true);
}

async function fixtureActor(context, store) {
  const token = (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE).value;
  return (await getSession(store, token)).user.id;
}

const fixtureConnections = new WeakMap();
function trackFixtureConnection(info, id) {
  const ids = fixtureConnections.get(info);
  if (ids) ids.push(id);
  else fixtureConnections.set(info, [id]);
}
test.afterEach(async ({}, info) => {
  const ids = fixtureConnections.get(info);
  if (!ids?.length) return;
  const store = await openStore(testDatabaseEnv());
  try {
    expect((await store.db.get('SELECT current_database() AS name')).name).toBe('allnutrition_test');
    for (const id of ids) {
      const result = await store.db.run(`UPDATE ${store.t('social_connections')} SET state='disconnected',version=version+1,updated_at=? WHERE id=? AND provider='meta' AND integration_method='api'`, [new Date().toISOString(), id]);
      expect(result.changes).toBe(1);
    }
  } finally { await store.close(); }
});

test('Ali @advisor-c6: partial → explicit acceptance → durable stop → reload', async ({ page, request }, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await control(request, { action: 'reset' });
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  expect((await request.get(`${controlURL}/__control`)).status()).toBe(401);
  await login(page);
  const session=await page.request.get('/api/admin/social/oauth/complete');
  expect(session.ok(),await session.text()).toBe(true);
  const {csrf}=await session.json();
  const headers={Origin:new URL(page.url()).origin,'x-csrf-token':csrf};
  const marker = `ali-review-${randomUUID()}`;
  for (let index = 1; index <= 65; index++) {
    const response = await page.request.post('/api/admin/products', { headers, data: {
      ...emptyRecord('products'), title: `${marker} ${String(index).padStart(2, '0')}`, slug: `${marker}-${index}`,
      description: `${index === 65 ? 'ÚLTIMO-FRAGMENTO ' : ''}${'Texto multibyte café 營養 🥑 '.repeat(90)}`,
      presentation: 'Unidad', status: 'draft', price: 12000,
    } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto('/admin?section=business&tab=assistant');
  await page.locator('select[name=provider]').selectOption('gemini');
  await page.locator('select[name=authMethod]').selectOption('oauth');
  // Clipped grids can hide overflow from document.scrollWidth.
  for (const name of ['provider', 'authMethod', 'model', 'projectId']) {
    const control = page.locator(`[name=${name}]`);
    await expect(control).toBeVisible();
    const bounds = await control.evaluate(element => {
      const field = element.getBoundingClientRect(), grid = element.closest('.product-form-grid').getBoundingClientRect();
      return { left: field.left, right: field.right, min: grid.left, max: Math.min(grid.right, innerWidth) };
    });
    expect(bounds.left, `${name} left edge`).toBeGreaterThanOrEqual(bounds.min - 1);
    expect(bounds.right, `${name} right edge`).toBeLessThanOrEqual(bounds.max + 1);
  }
  const endpoint = page.getByText(/^Endpoint fijo de Gemini:/);
  await expect(endpoint).toBeVisible();
  expect(await endpoint.evaluate(element => {
    const field = element.getBoundingClientRect(), grid = element.closest('.product-form-grid').getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth + 1 && field.left >= grid.left - 1 && field.right <= Math.min(grid.right, innerWidth) + 1;
  }), 'Provider endpoint stays readable inside the form').toBe(true);
  await page.locator('select[name=authMethod]').scrollIntoViewIfNeeded();
  await screenshot(page, info, 'assistant-oauth-controls');
  await page.locator('select[name=provider]').selectOption('openai-compatible');
  await page.locator('input[name=baseUrl]').fill(baseURL);
  await page.locator('input[name=model]').fill('fixture-a');
  await page.locator('input[name=apiKey]').fill('assistant-fixture-only');
  await page.locator('input[name=allowPrivateNetwork]').check();
  await page.locator('input[name=enabled]').check();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Guardar y verificar', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  await control(request, { action: 'configure', behavior: { scenario: 'review', query: { kind: 'products', q: marker } } });
  await page.goto('/admin?section=products');
  await page.getByRole('banner').getByRole('button', { name: 'Ali', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
  const topAli=page.getByRole('banner').getByRole('button',{name:'Ali',exact:true});
  const native=(id)=>dialog.locator(`[data-assistant-result-control="assistant.${id}"]:not(:disabled)`);
  const fromDirectory=async(id,label)=>{
    await dialog.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
    const directory=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
    await directory.getByRole('searchbox',{name:'Buscar una acción'}).fill(label);
    await directory.getByRole('button',{name:'Buscar',exact:true}).click();
    await directory.locator(`[data-capability-id="assistant.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
    await expect(directory).toHaveCount(0);
    await expect(native(id)).toBeFocused();
  };
  const composer = dialog.getByLabel('Mensaje para Ali');
  await expect(composer).toBeFocused();
  await composer.fill(`${marker}: revisa todos los textos de estos productos.`);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  const source = dialog.locator('[data-assistant-turn]').filter({ has: page.getByText('Respuesta parcial', { exact: true }) });
  await expect(source).toBeVisible();
  await expect(source.getByRole('button', { name: 'Completar análisis', exact: true })).toBeVisible();
  const sourceTurnId = await source.getAttribute('data-assistant-turn');
  await screenshot(page, info, 'assistant-partial');
  const before = await request.get(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' } });
  const records = (await before.json()).requests.filter(item => !item.connectionCheck);
  expect(records.length).toBeLessThanOrEqual(2);
  expect(records.every(item => item.bytes <= 96 * 1024)).toBe(true);
  await control(request,{action:'configure',behavior:{}});
  const fromChat=async id=>{
    await dialog.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
    await expect(native(id)).toBeFocused();
  };
  for(const [id,query] of [['extend-analysis','completar análisis'],['continue-running','continuar análisis en curso'],['stop-analysis','detener ali']]){
    await askAli(dialog,`¿Dónde encuentro ${query}?`);
    await expect(dialog.locator(`[data-capability-id="assistant.${id}"]`).last()).toBeVisible();
  }
  const turnPath='/api/admin/assistant/turns';
  const created=[];
  page.on('request',outbound=>{if(outbound.method()==='POST'&&new URL(outbound.url()).pathname===turnPath)created.push(outbound.postDataJSON());});
  await fromChat('extend-analysis');
  await fromDirectory('extend-analysis','completar análisis');
  expect(created).toHaveLength(0);
  await control(request,{action:'configure',behavior:{scenario:'review',query:{kind:'products',q:marker}}});
  const gate = await control(request, { action: 'hold', afterReads: 1 });
  let stoppedResult;
  try {
    const accepted=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===turnPath&&res.request().postDataJSON()?.continueFromTurnId);
    await native('extend-analysis').click();
    const acceptedResponse=await accepted;
    expect(acceptedResponse.status()).toBe(202);
    const running=await acceptedResponse.json(),runningPath=`${turnPath}/${running.turnId}`;
    expect(running).toMatchObject({state:'running',mode:'extended'});
    expect(running.turnId).not.toBe(sourceTurnId);
    expect(created).toEqual([expect.objectContaining({threadId:running.threadId,continueFromTurnId:sourceTurnId})]);
    await control(request, { action: 'wait', id: gate.id });
    await expect(dialog.getByTestId('assistant-progress')).toBeVisible();
    await screenshot(page, info, 'assistant-progress');
    await dialog.getByRole('button',{name:'Cerrar asistente'}).click();
    await expect(dialog).toBeHidden();
    await topAli.click();
    await expect(native('continue-running')).toBeVisible();
    await fromChat('continue-running');
    await fromDirectory('continue-running','continuar análisis en curso');
    const recovered=page.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===runningPath);
    const advanced=page.waitForRequest(req=>req.method()==='POST'&&new URL(req.url()).pathname===`${runningPath}/advance`);
    await native('continue-running').click();
    const recoveredResponse=await recovered;
    expect(recoveredResponse.ok()).toBe(true);
    expect(await recoveredResponse.json()).toMatchObject({turnId:running.turnId,state:'running'});
    await advanced;
    expect(created).toHaveLength(1);
    await fromChat('stop-analysis');
    await fromDirectory('stop-analysis','detener ali');
    const cancelled=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`${runningPath}/cancel`);
    await native('stop-analysis').click();
    const cancelledResponse=await cancelled;
    expect(cancelledResponse.ok()).toBe(true);
    expect(await cancelledResponse.json()).toMatchObject({turnId:running.turnId,state:'completed',result:{analysis:{reason:'user_stopped',sourceTurnId,status:'partial'}}});
    await expect(dialog.getByTestId('assistant-progress')).toHaveCount(0);
    stoppedResult=dialog.locator(`[data-assistant-turn="${running.turnId}"]`).getByTestId('assistant-result');
    await expect(stoppedResult.getByText('Análisis detenido. Esto es lo revisado.',{exact:true})).toBeVisible();
    await screenshot(page, info, 'assistant-stopped');
  } finally { await control(request, { action: 'release', id: gate.id }); }
  await stoppedResult.getByText(/^Fuentes \(/).click();
  await expect(stoppedResult.locator('details[open]')).toBeVisible();
  await stoppedResult.getByRole('button', { name: 'Ver registros consultados', exact: true }).click();
  await expect(dialog.getByTestId('assistant-read-page')).toContainText(marker);
  await page.reload();
  await topAli.click();
  await dialog.getByRole('region', {name:'Conversaciones anteriores'}).getByRole('button', {name:new RegExp(marker)}).click();
  await expect(stoppedResult.getByText('Análisis detenido. Esto es lo revisado.',{exact:true})).toBeVisible();
  await expect(dialog.getByTestId('assistant-progress')).toHaveCount(0);
  await screenshot(page, info, 'assistant-reloaded');
});

function bogotaInput(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

async function fillBogota(dialog, instant) {
  const value = bogotaInput(instant), combined = dialog.locator('input[type=datetime-local]');
  if (await combined.count()) await combined.fill(value);
  else {
    const [day, hour] = value.split('T');
    await dialog.locator('input[type=date]').fill(day);
    await dialog.locator('input[type=time]').fill(hour);
  }
}

async function loginAdvisorPeer(page,email='advisor-c2-b@example.test',password='advisor-c2-only-synthetic') {
  await page.goto('/admin/login');
  await page.getByLabel('Correo de administrador').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar al panel' }).click();
  await expect(page).toHaveURL(url => url.pathname === '/admin');
}

test('Ali @advisor-c2: avisos personales sin abrir el chat, recuperación y recordatorios', async ({ page, context, browser, request }, info) => {
  test.setTimeout(120000);
  await control(request, { action: 'reset' });
  const store = await openStore(testDatabaseEnv());
  const ownerEmail=`c2-${randomUUID()}@example.test`,ownerPassword=randomUUID();
  await createAdmin(store,ownerEmail,ownerPassword);
  await loginAdvisorPeer(page,ownerEmail,ownerPassword);
  await page.goto('/admin?section=business&tab=assistant');
  await page.locator('select[name=provider]').selectOption('openai-compatible');
  await page.locator('input[name=baseUrl]').fill(baseURL);
  await page.locator('input[name=model]').fill('fixture-a');
  await page.locator('input[name=apiKey]').fill('assistant-fixture-only');
  await page.locator('input[name=allowPrivateNetwork]').check();
  await page.locator('input[name=enabled]').check();
  const verified = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Guardar y verificar', exact: true }).click();
  expect((await verified).ok()).toBe(true);
  const providerRequests = async () => {
    const response = await request.get(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' } });
    expect(response.ok()).toBe(true);
    return (await response.json()).requests.length;
  };
  const modelCalls = await providerRequests();
  const peer = await browser.newContext({ baseURL: info.project.use.baseURL, ignoreHTTPSErrors: true });
  const stamp = () => new Date().toISOString();
  const token = (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE).value;
  const session = { ...await getSession(store, token), sessionTokenHash: createHash('sha256').update(token).digest('hex') };
  const actorId = session.user.id;
  const title = `Agotado C2 ${randomUUID().slice(0, 7)}`, filename = `Lote C2 ${randomUUID().slice(0, 7)}.xlsx`;
  let product;
  try {
    const peerEmail = 'advisor-c2-b@example.test';
    if (!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [peerEmail])) {
      await createAdmin(store, peerEmail, 'advisor-c2-only-synthetic');
    }
    const seeded = await seedAdvisorAlert(store, { title, actorId, now: stamp() });
    product = seeded.product;
    const alertId = seeded.alert.id;
    const batchId = await seedAdvisorImport(store, { actorId, now: stamp(), label: filename });
    await evaluateAlerts(store, { now: stamp() });
    await evaluateAlerts(store, { now: stamp() });
    const b = await peer.newPage();
    await loginAdvisorPeer(b);
    const list = async (target,page=1) => {
      const response = await target.request.get(`/api/admin/assistant/inbox?page=${page}`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const row = (dto, id) => dto.items.find(card => card.source.id === id);
    const card = (target, key) => target.locator(`[data-advisor-key="${key}"]`);
    async function locate(target,id){
      for(let pageNumber=1,scanned=0;;pageNumber++){
        const dto=await list(target,pageNumber),item=row(dto,id);
        if(item)return{item,page:pageNumber};
        scanned+=dto.items.length;
        if(!dto.items.length||scanned>=dto.total)return null;
      }
    }
    async function openPage(wanted){
      const navigation=page.getByRole('navigation',{name:'Páginas de avisos',exact:true});
      for(let index=1;index<wanted;index++){
        await navigation.getByRole('button',{name:'Siguiente',exact:true}).click();
        await expect(navigation).toContainText(`Página ${index+1} de`);
      }
    }
    await page.goto('/admin');
    const home = page.getByRole('region', { name: 'Hoy con Ali' });
    await expect(home).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const a = await list(page);
    const alert=row(a,alertId);
    const queued=await locate(page,batchId);
    await expect(card(page, alert.key)).toHaveCount(1);
    await expect(card(page, alert.key)).toContainText(title);
    expect(queued).not.toBeNull();
    await openPage(queued.page);
    await expect(card(page,queued.item.key)).toContainText(/en proceso/i);
    expect(await locate(b,batchId)).toBeNull();
    await screenshot(page, info, 'advisor-c2-hoy');

    await page.reload();
    await expect(card(page, alert.key)).toHaveCount(1);
    await card(page, alert.key).locator('summary').filter({ hasText: 'Acciones personales' }).click();
    const postpone = card(page, alert.key).getByRole('button', { name: /^Posponer/ });
    await postpone.click();
    const dismiss = page.getByRole('dialog').getByRole('button', { name: 'Ahora no', exact: true });
    await dismiss.click();
    await expect(postpone).toBeFocused();
    await page.keyboard.press('Enter');
    let dialog = page.getByRole('dialog');
    await fillBogota(dialog, new Date(Date.now() + 86400000));
    await dialog.getByRole('button', { name: /^(Posponer|Confirmar)( aviso| aplazamiento)?$/i }).click();
    await expect.poll(async () => row(await list(page), alertId)).toBeUndefined();
    expect(row(await list(b), alertId).read).toBe(false);
    await b.goto('/admin?issue=attention');
    await expect(b.getByRole('heading', { name: 'Toda la atención pendiente' })).toBeVisible();
    await expect(b.getByText(title, { exact: false }).first()).toBeVisible();
    expect((await store.db.get(`SELECT state FROM ${store.t('alerts')} WHERE id=?`, [alertId])).state).toBe('open');

    ({ product } = await stockEpisode(store, product, actorId, stamp(), 20));
    await page.reload();
    expect(row(await list(page), alertId)).toBeUndefined();
    const newEpisode = await stockEpisode(store, product, actorId, stamp());
    product = newEpisode.product;
    expect(newEpisode.alert.id).not.toBe(alertId);
    await setAdvisorImportResult(store, batchId, { state: 'completed_with_errors', now: stamp(), label: filename });
    await page.reload();
    const completed=await locate(page,batchId);
    expect(completed?.item.key).toBe(queued.item.key);
    await openPage(completed.page);
    await expect(card(page,queued.item.key)).toContainText(/terminó con incidencias/i);
    await expect(card(page,queued.item.key)).not.toContainText(/todo aplicado|filas duplicadas/i);
    if(completed.page>1)await page.reload();
    const live = await list(page);
    await expect(card(page, row(live, newEpisode.alert.id).key)).toHaveCount(1);
    const summary = await page.request.get('/api/admin/assistant/inbox?summary=1');
    expect((await summary.json()).unreadCount).toBe(live.unreadCount);
    await expect(page.locator('.advisor-nav-count:visible')).toHaveText(String(live.unreadCount));
    const fresh = card(page, row(live, newEpisode.alert.id).key);
    await fresh.locator('summary').filter({ hasText: 'Acciones personales' }).click();
    await fresh.getByRole('button', { name: /^Marcar leído/ }).click();
    await expect.poll(async () => row(await list(page), newEpisode.alert.id).read).toBe(true);

    const futureTitle = `Revisar muestra C2 ${title.slice(-7)}`;
    await home.getByRole('button', { name: /^Recordarme$/, exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(/asunto/i).fill(futureTitle);
    await fillBogota(dialog, new Date(Date.now() + 86400000));
    await dialog.getByRole('button', { name: /^(Guardar recordatorio|Programar recordatorio|Confirmar)$/i }).click();
    await expect.poll(async () => {
      const response = await page.request.get('/api/admin/assistant/tasks?kind=reminder&page=1');
      return (await response.json()).items.some(task => task.data.label === futureTitle);
    }).toBe(true);
    await page.close();
    const now = Date.now(), dueTitle = `Vencido sin panel ${title.slice(-7)}`;
    const due = await reserveAdvisorTask(store, session, {
      id: randomUUID(), capabilityId: 'advisor.reminder', label: dueTitle, dueAt: new Date(now - 30000).toISOString(),
    }, { now: () => now - 60000 });
    const returned = await context.newPage();
    await returned.goto('/admin');
    const dueCard = card(returned, row(await list(returned), due.id).key);
    await expect(dueCard).toContainText(dueTitle);
    await expect(returned.getByRole('dialog')).toHaveCount(0);
    await returned.setViewportSize({ width: 320, height: 700 });
    await expect(returned.locator('.advisor-nav-count:visible')).toHaveCount(1);
    await dueCard.scrollIntoViewIfNeeded();
    await screenshot(returned, info, 'advisor-c2-320');
    expect(await providerRequests()).toBe(modelCalls);
  } finally {
    await peer.close();
    if (product) await stockEpisode(store, product, actorId, stamp(), 20);
    await store.close();
  }
});

test('Ali @advisor-c3: una pregunta, retomar, revisar el formulario y recuperar un comprobante perdido', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const token = (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE).value;
    const { user } = await getSession(store, token);
    const marker = randomUUID().slice(0, 8);
    const products = [];
    for (const suffix of ['A', 'B']) products.push(await store.save('products', {
      ...emptyRecord('products'), title: `Artículo C3 ${marker} ${suffix}`, slug: `c3-${marker}-${suffix.toLowerCase()}`,
      status: 'draft', orderable: true, presentation: 'Unidad', price: 10000, stockQuantity: 100,
    }, null, null, user.id));
    const order = await store.saveOrder(businessOrderInput(products[0], { items: products.map(product => ({
      lineId: randomUUID(), kind: 'products', itemId: product.id, quantity: 1, unitPriceMinor: 1000000, discountMinor: 0,
    })) }), user.id);
    const tracking = `GUÍA-C3-${marker}`, carrier = 'Transportadora sintética C3';
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Empezar envío de un pedido', exact: true }).click();
    let task = page.getByRole('dialog');
    const answer = async (question, value) => {
      await expect(task.getByRole('textbox')).toHaveCount(1);
      await task.getByLabel(question).fill(value);
      await task.getByRole('button', { name: 'Guardar respuesta' }).click();
    };
    await task.getByRole('button', { name: 'Empezar', exact: true }).click();
    await answer('¿Cuál es el número AN del pedido?', `AN-${order.number}`);
    await answer('¿Cuál es el número de la guía?', tracking);
    await expect(task.getByLabel('¿Cuál es la transportadora?')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    task = page.getByRole('dialog');
    await task.getByRole('button', { name: 'Retomar', exact: true }).first().click();
    await expect(task).toContainText(tracking);
    await screenshot(page, info, 'advisor-c3-retoma');
    await answer('¿Cuál es la transportadora?', carrier);
    await expect(task.getByText('1 por asignar')).toHaveCount(2);
    await task.getByRole('button', { name: 'Revisar envío en el pedido' }).click();
    const editor = page.getByRole('dialog').filter({ has: page.getByText('Registrar guía o entrega local', { exact: true }) });
    await expect(editor.getByLabel('Número de guía')).toHaveValue(tracking);
    await expect(editor.getByLabel('Transportadora')).toHaveValue(carrier);
    await expect(editor.getByText('Registrar guía o entrega local', { exact: true })).toBeFocused();
    expect((await store.order(order.id)).shipments).toEqual([]);
    await screenshot(page, info, 'advisor-c3-revision-nativa');
    const close = editor.getByRole('button', { name: 'Cerrar', exact: true });
    await editor.getByLabel('Número de guía').fill(`${tracking}-borrador`);
    const declined = page.waitForEvent('dialog');
    const stay = close.click();
    const guard = await declined;
    expect(guard.message()).toMatch(/cambios sin guardar/i);
    await guard.dismiss();
    await stay;
    await expect(editor.getByLabel('Número de guía')).toHaveValue(`${tracking}-borrador`);
    page.once('dialog', dialog => dialog.accept());
    await editor.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(editor).toHaveCount(0);

    await page.getByRole('banner').getByRole('button', { name: 'Ali', exact: true }).click();
    const chat = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
    await expect(chat).toContainText('Tarea de envío seleccionada');
    const composer = chat.getByLabel('Mensaje para Ali');
    await composer.fill(`Revisa esta propuesta para confirmar manualmente: ${JSON.stringify({
      target: 'shipment-create', entityId: order.id, patch: { tracking, carrier }, intent: 'save',
    })}`);
    await composer.press('Enter');
    const confirm = chat.getByRole('button', { name: 'Confirmar cambio / recuperar' });
    await expect(confirm).toBeEnabled({ timeout: 25000 });
    expect((await store.order(order.id)).shipments).toEqual([]);

    let committed, submitted;
    await page.route('**/api/admin/assistant/proposals/*', async route => {
      const body = route.request().method() === 'POST' && route.request().postDataJSON();
      if (body?.decision !== 'execute' || committed) return route.continue();
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      submitted = body;
      committed = await response.json();
      await route.abort('failed');
    });
    page.once('dialog', dialog => dialog.accept());
    await confirm.click();
    await expect(chat.getByRole('alert')).toContainText('Puedes recuperar el resultado con la misma propuesta');
    expect(committed.receipt.entityId).toBe((await store.order(order.id)).shipments[0].id);
    const retry = page.waitForResponse(response => response.url().includes('/api/admin/assistant/proposals/') && response.request().method() === 'POST');
    await confirm.click();
    const replay = await retry;
    expect(replay.request().postDataJSON()).toEqual(submitted);
    expect((await replay.json()).receipt).toEqual(committed.receipt);
    expect((await store.order(order.id)).shipments).toHaveLength(1);

    await page.goto('/admin');
    await page.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    task = page.getByRole('dialog');
    await task.getByRole('button', { name: 'Ver tarea', exact: true }).first().click();
    await expect(task.getByRole('heading', { name: 'Comprobante', exact: true })).toBeVisible();
    await expect(task).toContainText(committed.receipt.entityId);
    await screenshot(page, info, 'advisor-c3-comprobante');
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c4: cierre de efectivo, comparación vigente y ningún asiento de ajuste', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store);
    const code = randomUUID().slice(0, 7), day = bogotaDate();
    const responsible = await saveResource(store, 'people', { requestId: randomUUID(), name: `Responsable C4 ${code}` }, actorId);
    const accounts = [];
    for (const suffix of ['A', 'B']) accounts.push(await saveAccount(store, {
      requestId: randomUUID(), name: `Caja C4 ${code} ${suffix}`, type: 'cash', openingOn: day,
      openingBalanceMinor: 10000000, responsibleId: responsible.id,
    }, actorId));
    const closing = id => store.db.get(`SELECT id,expected_minor,counted_minor,difference_minor FROM ${store.t('cash_closings')} WHERE account_id=? AND state='closed'`, [id]);
    const entries = async id => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')} WHERE account_id=?`, [id])).n);
    const start = async account => {
      await page.goto('/admin');
      await page.getByRole('button', { name: 'Empezar cierre de caja', exact: true }).click();
      const task = page.getByRole('dialog');
      await task.getByRole('button', { name: 'Empezar', exact: true }).click();
      await task.getByRole('radio', { name: account.name, exact: true }).check();
      const next = task.getByRole('button', { name: 'Guardar respuesta' });
      await next.click();
      await task.locator('input[type=date]').fill(day);
      await next.click();
      await task.getByRole('textbox').fill('98.000');
      await next.click();
      await expect(task).toContainText(/100[.,]000/);
      await expect(task).toContainText(/98[.,]000/);
      await expect(task).toContainText(/2[.,]000/);
      expect(await closing(account.id)).toBeNull();
      await screenshot(page, info, `advisor-c4-comparacion-${account.name.at(-1)}`);
      await task.getByRole('button', { name: /revisar.*cierre|abrir.*cierre/i }).click();
      const dialog = page.getByRole('dialog', { name: 'Cerrar caja', exact: true });
      await expect(dialog).toContainText(/Faltante de.+2[.,]000/s);
      return dialog;
    };

    let form = await start(accounts[0]);
    await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(await closing(accounts[0].id)).toBeNull();
    expect(await entries(accounts[0].id)).toBe(1);
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Retomar', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: /revisar.*cierre|abrir.*cierre/i }).click();
    form = page.getByRole('dialog', { name: 'Cerrar caja', exact: true });
    await form.getByRole('button', { name: /^(Cerrar caja|Confirmar cierre)$/ }).click();
    await expect(form).toHaveCount(0);
    const saved = await closing(accounts[0].id);
    expect(saved).toMatchObject({ expected_minor: 10000000, counted_minor: 9800000, difference_minor: -200000 });
    expect(await entries(accounts[0].id)).toBe(1);
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ver tarea', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toContainText(saved.id);

    form = await start(accounts[1]);
    await recordIncome(store, { requestId: randomUUID(), accountId: accounts[1].id, concept: 'owner_funding', amountMinor: 100000, effectiveOn: day }, actorId);
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/admin/business/actions/cash-close') && response.request().method() === 'POST');
    await form.getByRole('button', { name: /^(Cerrar caja|Confirmar cierre)$/ }).click();
    expect((await rejected).status()).toBe(409);
    await expect(form.getByRole('alert')).toContainText(/cambi[oó]/i);
    expect(await closing(accounts[1].id)).toBeNull();
    expect(await entries(accounts[1].id)).toBe(2);
    await screenshot(page, info, 'advisor-c4-saldo-cambiado');
    await form.getByRole('button', { name: 'Consultar nueva comparación', exact: true }).click();
    await expect(form).toContainText(/Faltante de.+3[.,]000/s);
    await expect(form.getByRole('button', { name: 'Cerrar caja', exact: true })).toBeDisabled();
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await form.getByLabel('He revisado la nueva comparación').scrollIntoViewIfNeeded();
      await screenshot(page, info, 'advisor-c4-caja-320');
    }
    await form.getByLabel('He revisado la nueva comparación').check();
    await form.getByRole('button', { name: 'Cerrar caja', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(await closing(accounts[1].id)).toMatchObject({ expected_minor: 10100000, counted_minor: 9800000, difference_minor: -300000 });
    expect(await entries(accounts[1].id)).toBe(2);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c4: el lote parcial retoma la fila exacta y aplica solo lo pendiente', async ({ page, context, request }, info) => {
  test.setTimeout(240000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store), code = randomUUID().slice(0, 8);
    const platform = await saveResource(store, 'platforms', { requestId: randomUUID(), name: `Excel C4 ${code}` }, actorId);
    const [source] = await listResources(store, 'sources', { platform: platform.id });
    const { correction } = advisorImportWorkbook();
    const { sheet, rowNumber, columnIndex, value, reason } = correction;
    let batch = await prepareAdvisorImportBatch(store, { sourceId: source.id, actorId });
    const id = batch.id, read = () => getImportBatch(store, id);
    const runUntil = async (state, previousHash) => {
      await expect.poll(async () => {
        await processImportTurn(store, { batchId: id });
        const current = await read();
        return current.state === state && (!previousHash || Boolean(current.preview?.previewHash && current.preview.previewHash !== previousHash));
      }, { timeout: 20000 }).toBe(true);
      return read();
    };
    expect(batch.preview.summary).toMatchObject({ valid: 1, rejected: 1 });
    await commitImport(store, id, { version: batch.version, previewHash: batch.preview.previewHash, includeValidOnly: true, requestId: randomUUID() }, actorId);
    batch = await runUntil('completed_with_errors');
    const expenses = () => store.db.all(`SELECT id,version,amount_minor FROM ${store.t('expenses')} WHERE data::jsonb->>'sourceId'=? ORDER BY id`, [source.id]);
    const originalExpenses = await expenses(), acceptedFirst = batch.acceptedRevision;
    expect(originalExpenses).toHaveLength(1);
    expect(Number(originalExpenses[0].amount_minor)).toBe(1200000);
    const commands = () => store.db.all(`SELECT scope,request_id FROM ${store.t('business_requests')} WHERE scope LIKE ? ORDER BY scope,request_id`, [`import:${id}:expense-group:%`]);
    const originalCommands = await commands();
    expect(originalCommands).toHaveLength(1);

    const cardKey = `import:${id}`;
    const inbox = page.getByRole('navigation', { name: 'Páginas de avisos', exact: true });
    async function openExactNotice() {
      const readPage = number => page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.ok() && url.pathname === '/api/admin/assistant/inbox' && url.searchParams.get('page') === String(number);
      }, { timeout: 15000 });
      let number = 1, pending = readPage(number);
      await page.goto('/admin');
      for (;;) {
        const { items } = await (await pending).json();
        if (items.some(item => item.key === cardKey)) return;
        const next = inbox.getByRole('button', { name: 'Siguiente', exact: true });
        await expect(next).toBeEnabled();
        pending = readPage(++number);
        await next.click();
      }
    }
    await openExactNotice();
    const card = page.locator(`[data-advisor-key="import:${id}"]`);
    await card.getByRole('button', { name: 'Revisar con Ali', exact: true }).click();
    let task = page.getByRole('dialog');
    await task.getByRole('button', { name: 'Empezar', exact: true }).click();
    await task.getByRole('button', { name: 'Abrir pendientes del lote', exact: true }).click();
    await page.getByRole('button', { name: 'Revisar pendientes', exact: true }).click();
    batch = await runUntil('review', batch.preview.previewHash);
    await openExactNotice();
    await card.getByRole('button', { name: 'Retomar con Ali', exact: true }).click();
    task = page.getByRole('dialog');
    await expect(task).toContainText(`${sheet} · fila ${rowNumber}`);
    await screenshot(page, info, 'advisor-c4-fila-pendiente');
    const rowResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/api/admin/imports/${id}`) && response.request().method() === 'POST');
    await task.getByRole('button', { name: 'Abrir opciones de resolución de la fila', exact: true }).click();
    const located = await rowResponse;
    expect(located.ok()).toBe(true);
    expect(new URL(located.url()).search).toBe('');
    expect((await located.json()).rows.records.map(({ sheet, rowNumber }) => ({ sheet, rowNumber }))).toEqual([{ sheet, rowNumber }]);
    expect(new URL(page.url()).searchParams.get('batch')).toBe(id);
    expect(new URL(page.url()).search).not.toContain('sheet');
    const resolve = page.getByRole('dialog', { name: 'Completar o corregir celda', exact: true });
    const options = page.getByText('Opciones de resolución de esta fila', { exact: true });
    await expect(options).toBeFocused();
    const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name: `${sheet} · fila ${rowNumber}`, exact: true }) });
    await row.getByRole('button', { name: `Corregir columna ${columnIndex + 1} de esta fila`, exact: true }).click();
    await expect(resolve).toContainText(`fila ${rowNumber}`);
    await expect(resolve.getByLabel('Columna de la celda')).toHaveValue(String(columnIndex + 1));
    await resolve.getByLabel('Tipo de valor').selectOption('number');
    await resolve.getByLabel('Valor corregido').fill(String(value));
    await resolve.getByLabel('Motivo de la resolución').fill(reason);
    await resolve.getByRole('button', { name: 'Preparar corrección', exact: true }).click();
    await expect(resolve).toHaveCount(0);
    expect(await expenses()).toEqual(originalExpenses);
    await page.getByRole('button', { name: 'Guardar cambios y revisar', exact: true }).click();
    batch = await runUntil('review', batch.preview.previewHash);
    await page.getByRole('button', { name: 'Continuar a confirmación', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Confirmar importación', exact: true })).toBeVisible();
    await screenshot(page, info, 'advisor-c4-confirmar-lote');
    if (info.project.name === 'mobile') {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.getByRole('button', { name: 'Confirmar e importar', exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, info, 'advisor-c4-excel-320');
    }
    expect(await expenses()).toEqual(originalExpenses);
    await page.getByRole('button', { name: 'Confirmar e importar', exact: true }).click();
    batch = await runUntil('completed');
    expect(batch.acceptedRevision).toBeGreaterThan(acceptedFirst);
    await expect(page.getByRole('heading', { name: 'Importación completada', exact: true })).toBeVisible();
    const result = await expenses(), after = await commands();
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(originalExpenses[0]);
    expect(result.some(expense => Number(expense.amount_minor) === value * 100)).toBe(true);
    expect(after).toHaveLength(2);
    expect(after).toContainEqual(originalCommands[0]);
    const { total, processed, errors, phase } = batch.progress;
    const accepted = await store.db.get(`SELECT accepted_at,preview_hash,data::jsonb->>'fileHash' AS file_hash FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=?`, [id, batch.acceptedRevision]);
    expect(accepted).toMatchObject({ preview_hash: batch.preview.previewHash, file_hash: batch.fileHash });
    expect(Date.parse(batch.completedAt), 'La revisión no puede constar aplicada antes de que se acepte').toBeGreaterThanOrEqual(Date.parse(accepted.accepted_at));
    expect({ total, processed, errors, phase }).toEqual({ total: 1, processed: 1, errors: 0, phase: 'complete' });
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ver tarea', exact: true }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Registro verificado', exact: true })).toBeVisible();
  } finally {
    await store.close();
  }
});

async function openAli(page) {
  await page.getByRole('banner').getByRole('button', { name: 'Ali', exact: true }).click();
  return page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
}

async function askAli(dialog, message) {
  await dialog.getByLabel('Mensaje para Ali').fill(message);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
}

async function askAliCatalog(dialog,message) {
  const another=dialog.getByRole('button',{name:'Empezar otra consulta',exact:true});
  if(await another.isVisible()){
    await another.click();
    await expect(another).toHaveCount(0);
  }
  const results=dialog.getByRole('article').getByTestId('assistant-result');
  const before=await results.count();
  await askAli(dialog,message);
  await expect(results).toHaveCount(before+1);
}

test('Ali @advisor-c5: directorio, coincidencia en chat y traspaso sin ejecutar', async ({ page, request }, info) => {
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/admin');
  const entry = page.getByRole('button', { name: '¿Qué quieres hacer?', exact: true });
  await entry.click();
  const directory = page.getByRole('dialog', { name: '¿Qué quieres hacer?' });
  const search = directory.getByRole('searchbox', { name: 'Buscar una acción' });
  await expect(search).toBeFocused();
  await expect(directory.getByTestId('advisor-action')).toHaveCount(5);
  await directory.getByRole('button', { name: 'Siguiente' }).click();
  await expect(directory.getByText(/^Página 2 de /)).toBeVisible();
  await directory.getByLabel('Área').selectOption('cash');
  await search.fill('ARQUEO');
  await directory.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(directory.locator('[data-capability-id="cash.close-day"]')).toBeVisible();
  await screenshot(page, info, 'advisor-c5-directorio');
  await page.keyboard.press('Escape');
  await expect(entry).toBeFocused();
  let chat = await openAli(page);
  await askAli(chat, '¿Dónde hago un hipopótamo termonuclear?');
  await chat.getByRole('button', { name: 'Buscar en el directorio', exact: true }).click();
  await expect(search).toHaveValue('ARQUEO');
  await directory.getByRole('button', { name: 'Cerrar directorio' }).click();
  chat = await openAli(page);
  await askAli(chat, '¿Dónde hago un arqueo?');
  const close = chat.locator('[data-capability-id="cash.close-day"]');
  await expect(close).toBeVisible();
  await close.getByRole('button', { name: /^Abrir en el panel:/ }).click();
  const task = page.getByRole('dialog');
  await expect(task.getByRole('heading', { name: 'Empezar cierre de caja' })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Empezar', exact: true })).toBeVisible();
});

test('Ali @advisor-c5: preferencias reversibles y privadas, con recomendaciones explicadas', async ({ page, browser, context, request }, info) => {
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(testDatabaseEnv());
  const peer = await browser.newContext({ baseURL: info.project.use.baseURL, ignoreHTTPSErrors: true });
  let seeded, actorId;
  try {
    actorId = await fixtureActor(context, store);
    const title = `Seguimiento C5 ${randomUUID().slice(0, 7)}`;
    seeded = await seedAdvisorAlert(store, { title, actorId, now: new Date().toISOString() });
    const peerEmail = 'advisor-c2-b@example.test';
    if (!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [peerEmail])) {
      await createAdmin(store, peerEmail, 'advisor-c2-only-synthetic');
    }
    const preferences = async current => {
      await current.goto('/admin');
      await current.getByRole('button', { name: 'Mis preferencias', exact: true }).click();
      return current.getByRole('dialog', { name: 'Mis preferencias', exact: true });
    };
    let pref = await preferences(page);
    await expect(pref.getByLabel('Área de interés')).toBeVisible();
    const reset = pref.getByRole('button', { name: 'Restablecer y olvidar' });
    if (await reset.isEnabled()) {
      await reset.click();
      await expect(pref.getByRole('status')).toHaveText('Restableciste los valores iniciales de tus preferencias.');
    }
    await pref.getByLabel('Área de interés').selectOption('products');
    await pref.getByRole('radio', { name: 'Breve' }).check();
    await pref.getByLabel('Mostrar avisos informativos de Ali').uncheck();
    await pref.getByRole('button', { name: 'Recordar para otras conversaciones' }).click();
    await expect(pref.getByRole('status')).toHaveText('Tus preferencias se guardaron para otras conversaciones.');
    await expect.poll(() => pref.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await screenshot(page, info, 'advisor-c5-preferencias');
    await pref.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mis preferencias', exact: true })).toBeFocused();
    const peerPage = await peer.newPage();
    await loginAdvisorPeer(peerPage);
    const peerPref = await preferences(peerPage);
    await expect(peerPref.getByLabel('Área de interés')).toHaveValue('');
    await expect(peerPref.getByLabel('Mostrar avisos informativos de Ali')).toBeChecked();
    await expect(peerPref.getByRole('radio', { name: 'Guiado' })).toBeChecked();
    await peerPref.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const chat = await openAli(page);
    await askAli(chat, '¿Qué reviso primero?');
    await expect(chat.getByTestId('assistant-result').getByRole('link', { name: 'Fuente', exact: true }).first()).toBeVisible();
    const provider = await request.get(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' } });
    expect(provider.ok()).toBe(true);
    const contexts = (await provider.json()).requests.flatMap(item => (item.body.messages || []).filter(message => message.role === 'user').map(message => {
      try { return JSON.parse(message.content); } catch { return {}; }
    }));
    expect(contexts.some(item => item.advisorPreferences?.focusArea === 'products' && item.advisorPreferences?.detail === 'brief')).toBe(true);
    expect(contexts.filter(item => item.advisorPreferences).every(item => !Object.hasOwn(item.advisorPreferences, 'showAnnouncements'))).toBe(true);
    await chat.getByRole('button', { name: 'Cerrar asistente' }).click();
    pref = await preferences(page);
    await expect(pref.getByRole('radio', { name: 'Breve' })).toBeChecked();
    await pref.getByRole('button', { name: 'Restablecer y olvidar' }).click();
    await expect(pref.getByLabel('Área de interés')).toHaveValue('');
    await expect(pref.getByLabel('Mostrar avisos informativos de Ali')).toBeChecked();
    await expect(pref.getByRole('radio', { name: 'Guiado' })).toBeChecked();
    await pref.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const rec = page.getByTestId('advisor-recommendation-list').getByRole('listitem').filter({ hasText: title });
    await expect(rec.getByText(/Corte:/)).toBeVisible();
    await rec.getByRole('button', { name: 'Hacer seguimiento' }).click();
    const task = page.getByRole('dialog');
    await expect(task.getByText(/Lectura de partida/)).toBeVisible();
    await expect(task.getByRole('heading', { name: 'Sigue pendiente' })).toBeVisible();
    await screenshot(page, info, 'advisor-c5-seguimiento');
    seeded = await stockEpisode(store, seeded.product, actorId, new Date().toISOString(), 1000);
    await task.getByRole('button', { name: 'Retomar', exact: true }).click();
    await expect(task.getByRole('heading', { name: 'Resuelto' })).toBeVisible();
    await expect(task.getByText(/Última comprobación/)).toBeVisible();
    await peerPage.reload();
    await peerPage.getByRole('button', { name: 'Mis tareas', exact: true }).click();
    await expect(peerPage.getByRole('dialog').getByText('Seguimiento de una recomendación', { exact: true })).toHaveCount(0);
  } finally {
    if (seeded?.product?.stockQuantity === 0) await stockEpisode(store, seeded.product, actorId, new Date().toISOString(), 1000);
    await peer.close();
    await store.close();
  }
});

test('Ali @advisor-c5: Heka conserva la incertidumbre y solo abre el historial', async ({ page, context, request }, info) => {
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  const id = randomUUID();
  try {
    const now = new Date().toISOString(), actor = await fixtureActor(context, store);
    await store.db.run(`INSERT INTO ${store.t('heka_api_mutations')}(id,environment,operation,state,actor_id,carrier,request_hash,credential_hash,created_at,updated_at) VALUES(?,'test','createGuide','uncertain',?,?,?,?,?,?)`,
      [id, actor, 'interrapidisimo', 'b'.repeat(64), 'c'.repeat(64), now, now]);
    const operations = [];
    page.on('request', req => { if (req.url().includes('/shipping/heka') && req.method() !== 'GET') operations.push(req.url()); });
    await page.goto('/admin');
    const chat = await openAli(page);
    await askAli(chat, 'Heka quedó incierto');
    await chat.locator('[data-capability-id="heka.read-journal"]').getByRole('button', { name: /^Abrir en el panel:/ }).click();
    const journal = page.getByRole('region', { name: 'Historial de operaciones Heka' });
    await expect(journal.getByRole('heading', { name: 'Historial de operaciones' })).toBeFocused();
    await expect(journal).toContainText(id);
    expect(operations).toEqual([]);
    expect((await store.db.get(`SELECT state FROM ${store.t('heka_api_mutations')} WHERE id=?`, [id])).state).toBe('uncertain');
    await screenshot(page, info, 'advisor-c5-heka');
  } finally {
    await store.db.run(`DELETE FROM ${store.t('heka_api_mutations')} WHERE id=?`, [id]);
    await store.close();
  }
});

test('Ali @advisor-c5: duplicar acredita solo un borrador; publicar solo enfoca la revisión', async ({ page, context, request }, info) => {
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store), name = `Campaña C5 ${randomUUID().slice(0, 7)}`;
    const campaign = await saveSocialCampaign(store, { name, mode:'organic', objective:'reach', caption:'Texto sintético', platforms:['facebook'], requestId:randomUUID() }, actorId);
    const operations = async () => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_operations')}`)).n);
    const originalOperations = await operations();
    await page.goto(`/admin?section=advertising&tab=campaigns&record=${campaign.id}`);
    let chat = await openAli(page);
    await askAli(chat, `Duplica la campaña «${name}»`);
    const confirm = chat.getByRole('button', { name: 'Confirmar duplicación', exact: true });
    await expect(confirm).toBeEnabled();
    await expect(chat.getByText(/sin publicar ni activar gasto/).last()).toBeVisible();
    await screenshot(page, info, 'advisor-c5-duplicar');
    page.once('dialog', dialog => dialog.accept());
    await confirm.click();
    const receipt = chat.getByRole('region', { name: 'Borrador creado' });
    const link = receipt.getByRole('link', { name: 'Abrir registro guardado' });
    await expect(link).toBeVisible();
    const id = new URL(await link.getAttribute('href'), 'https://fixture.test').searchParams.get('record');
    const duplicate = await getSocialCampaign(store, id);
    expect(id).not.toBe(campaign.id);
    expect(duplicate).toMatchObject({ id, state:'draft', version:1, parentCampaignId:campaign.id, deliveries:[] });
    await chat.getByRole('button', { name: 'Cerrar asistente' }).click();
    chat = await openAli(page);
    await askAli(chat, 'Publica esta campaña');
    await chat.locator('[data-capability-id="advertising.publish-organic-now"]').getByRole('button', { name: /^Abrir en el panel:/ }).click();
    await expect(page.getByRole('navigation', { name: 'Pasos de preparación' }).getByRole('button', { name: /^2\./ })).toBeFocused();
    expect(await operations()).toBe(originalOperations);
    expect((await getSocialCampaign(store, campaign.id)).state).toBe('draft');
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c5: solicitar no es guardar; comprobar recupera el trabajo exacto', async ({ page, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const anchor = info.project.name === 'mobile' ? '2023-02-01' : '2023-01-01';
    await page.goto(`/admin?section=reports&tab=sales&period=month&anchor=${anchor}`);
    await expect(page.getByRole('button', { name: 'Guardar copia', exact: true })).toBeEnabled();
    const queryKey = reportQueryKey({period:'month',anchorDate:anchor,filters:{}});
    const snapshots = async () => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('report_snapshots')} WHERE query_key=?`, [queryKey])).n);
    const original = await snapshots();
    const run = () => store.readSnapshot(tx => getReportCopyRunTx(tx, queryKey));
    expect(['queued','running']).not.toContain((await run())?.state);
    const chat = await openAli(page);
    await askAli(chat, 'Solicita una copia del informe');
    const confirm = chat.getByRole('button', { name: 'Confirmar solicitud', exact: true });
    await expect(confirm).toBeEnabled();
    expect(await snapshots()).toBe(original);
    page.once('dialog', dialog => dialog.accept());
    await confirm.click();
    const receipt = chat.getByRole('region', { name: 'Solicitud recibida' });
    await expect(receipt).toBeVisible();
    const requested = await run();
    expect(requested?.key).toBe(`report:${queryKey}`);
    const check = receipt.getByRole('button', { name: 'Comprobar esta solicitud' });
    await check.click();
    if (requested.state === 'queued' && !process.env.ALI_FIXTURE_SCHEDULER) {
      await expect(receipt.getByText(/sigue en cola/)).toBeVisible();
      expect(await snapshots()).toBe(original);
      await screenshot(page, info, 'advisor-c5-copia-en-cola');
    }
    await expect.poll(async () => {
      if (!process.env.ALI_FIXTURE_SCHEDULER) await processReportTurn(store);
      return (await run())?.state;
    }, {timeout:85000}).toBe('succeeded');
    await check.click();
    await expect(receipt.getByText(/Copia de esta consulta comprobada|conservó la misma copia/)).toBeVisible();
    await receipt.getByRole('link', { name: 'Consultar estado de la copia' }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('mode') === 'saved' && url.searchParams.get('anchor') === anchor);
    await expect(page.getByRole('button', { name: 'Abrir copia comprobada', exact: true })).toBeVisible();
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: compara solo días completos sin incorporar los registros de hoy',async({page,request},info)=>{
  test.setTimeout(90000);
  page.setDefaultTimeout(12000);
  // Unrelated sales with incomplete costs would correctly suppress this comparison.
  await resetBrowserFixture();
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  const orders=[];
  try{
    const today=bogotaDate(), code=randomUUID().slice(0,7), now=new Date().toISOString();
    let cut;
    for(const period of ['week','month','quarter','halfyear','year']){
      const snapshot=await buildDashboard(store,{period,anchor:today});
      if(snapshot.comparison.equivalent&&snapshot.comparison.mode==='elapsed'){cut=snapshot;break;}
    }
    if(!cut){
      await page.goto(`/admin?period=month&anchor=${today}`);
      await expect(page.getByRole('region',{name:'Base de comparación'})).toContainText('Comparación no equivalente');
      await expect(page.getByRole('button',{name:'Ver registros del tramo comparado',exact:true})).toHaveCount(0);
      return;
    }
    // Load known historical facts and allocate their IDs independently from application actions.
    async function sale(on,price,cost){
      const id=randomUUID();
      const number=await store.transaction(async tx=>{
        await tx.db.run(`UPDATE ${tx.t('counters')} SET value=value+1 WHERE id='orders'`);
        const {value}=await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='orders'`);
        const item={lineId:randomUUID(),kind:'products',itemId:`historical-${code}`,productType:'product',title:`Referencia comparada ${code}`,quantity:1,unitPriceMinor:price,discountMinor:0,unitCostMinor:cost,components:[]};
        const data={placedOn:on,status:'delivered',sellerId:null,customerName:'Cliente ficticio',items:[item],shippingChargeMinor:0,totalMinor:price,subtotalMinor:price,giftDispatches:[],
          recognition:{on,basis:'delivered',ruleVersionId:'c6-tramo'},ruleSnapshot:{id:'c6-tramo',effectiveOn:on,saleRecognition:'delivered',commission:{enabled:false}},deliverySummary:{complete:true}};
        await insertRow(tx,'orders',{id,number:Number(value),version:1,data:JSON.stringify(data),created_at:now,updated_at:now});
        return Number(value);
      });
      orders.push(id);
      return {id,number};
    }
    const includedOn=addC6ReportDays(today,-1), prior=cut.comparison.previousBounds.startDate;
    const included=await sale(includedOn,8_000_000,2_000_000);
    const current=await sale(today,900_000,200_000);
    await sale(prior,10_000_000,1_000_000);
    const dayLabel=day=>day.split('-').reverse().join('/');
    const detail=page.getByRole('region',{name:'Registros exactos de la métrica'});
    const fields=page.getByRole('region',{name:'Base de comparación'});
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(path);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(`/admin?period=${cut.period}&anchor=${today}`);
      await expect(fields).toContainText('Mismo tramo de días completados');
      await expect(fields).toContainText(`Actual: ${dayLabel(cut.comparison.currentBounds.startDate)}–${dayLabel(includedOn)}`);
      const insight=page.getByRole('region',{name:'Dónde mejorar',exact:true}).getByRole('listitem').filter({
        has:page.getByRole('heading',{name:'La contribución disminuyó',exact:true}),
      });
      await expect(insight).toBeVisible();
      let trigger=insight.getByRole('button',{name:'Ver registros del tramo comparado',exact:true});
      if(via!=='panel'){
        let entry=await openAli(page);
        const q='registros del tramo comparado';
        if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        trigger=entry.locator('[data-capability-id="reports.view-elapsed-comparison-detail"]').getByRole('button',{name:/^Abrir en el panel:/});
      }
      const result=page.waitForResponse(res=>{
        const {pathname,searchParams}=new URL(res.url());
        return pathname==='/api/admin/reports'&&searchParams.get('metric')==='contribution'&&searchParams.get('issue')==='comparison_elapsed';
      });
      await trigger.click();
      const response=await result;
      expect(response.ok()).toBe(true);
      const data=await response.json();
      expect(data.details.bounds).toMatchObject(cut.comparison.currentBounds);
      expect(data.details.records.filter(row=>row.orderId===included.id).reduce((total,row)=>total+row.value,0)).toBe(6_000_000);
      expect(data.details.records.some(row=>row.orderId===current.id||row.occurredOn>=today)).toBe(false);
      const full=await page.request.get(`/api/admin/reports?mode=live&period=${cut.period}&anchor=${today}&metric=contribution&product=historical-${code}`);
      expect(full.ok()).toBe(true);
      const fullData=await full.json();
      expect(fullData.details.records.filter(row=>row.orderId===current.id).reduce((total,row)=>total+row.value,0)).toBe(700_000);
      await expect(detail.getByText('El día abierto no entra en esta comparación.',{exact:false})).toBeVisible();
      await expect(detail.getByRole('heading',{level:3})).toBeFocused();
      if(via==='directorio')await screenshot(page,info,'advisor-c6-tramo-comparado');
    });
    expect(writes).toEqual([]);
  }finally{
    try{
      for(const id of orders)await store.db.run(`DELETE FROM ${store.t('orders')} WHERE id=?`,[id]);
    }finally{await store.close();}
  }
});

test('Ali @advisor-c6: controla el mismo destino nativo sin guardar datos ni aceptar credenciales', async ({ page, context, request }, info) => {
  test.setTimeout(300000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store), code = randomUUID().slice(0, 7);
    const title = `Producto C6 ${code}`;
    const product = await store.save('products', { ...emptyRecord('products'), title, slug:`e2e-c6-${code}`, price:1000, presentation:'Unidad', status:'draft', productType:'product', orderable:true, stockQuantity:10 }, null, null, actorId);
    const archived = await store.save('products', { ...emptyRecord('products'), title:`${title} archivado`, slug:`e2e-c6-arch-${code}`, price:1000, presentation:'Unidad', status:'archived', productType:'product' }, null, null, actorId);
    const gift = await store.save('products', { ...emptyRecord('products'), title:`Obsequio ${code}`, slug:`e2e-c6-gift-${code}`, productType:'gift', orderable:true, price:0, items:[{productId:product.id,quantity:2}] }, null, null, actorId);
    const combo = await store.save('combos', { ...emptyRecord('combos'), title:`Combo ${code}`, slug:`e2e-c6-combo-${code}`, price:2500, status:'draft', items:[{productId:product.id,quantity:2}] }, null, null, actorId);
    const collection = await store.save('catalogs', { ...emptyRecord('catalogs'), title:`Colección ${code}`, slug:`e2e-c6-col-${code}`, status:'draft', sort:42 }, null, null, actorId);
    const order = await store.saveOrder(businessOrderInput(product, {placedOn:bogotaDate(),customerName:`Destinatario C6 ${code}`}), actorId);
    const day=bogotaDate();
    const incidentProduct=await store.save('products',{...emptyRecord('products'),title:`Referencia operativa ${code}`,slug:`e2e-operativa-${code}`,price:1000,presentation:'Unidad',status:'draft',orderable:true,stockQuantity:5},null,null,actorId);
    const incidentOrder=await store.saveOrder(businessOrderInput(incidentProduct,{placedOn:day,customerName:`Destinatario con novedad ${code}`}),actorId);
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Recaudo ${code}`},actorId);
    const shipment=await createShipment(store,{requestId:randomUUID(),orderId:incidentOrder.id,platformId:platform.id,carrier:`Mensajería ${code}`,tracking:`NOVEDAD-${code}`},actorId);
    await recordShipmentEvent(store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'incident',occurredOn:day,notes:'Novedad sintética'},actorId);
    await recordCollection(store,{requestId:randomUUID(),orderId:incidentOrder.id,version:(await store.order(incidentOrder.id)).version,shipmentId:shipment.id,holder:'platform',amountMinor:1300000,occurredOn:day,method:'Contraentrega',reference:`RETENIDO-${code}`},actorId);
    const productVersion = (await store.get('products', product.id)).version;
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable C6 ${code}`},actorId);
    const orderNumber = `AN-${String(order.number).padStart(6,'0')}`;
    const visibleOrder = p => p.getByRole('region',{name:'Resultados de pedidos'}).getByText(orderNumber,{exact:true}).filter({visible:true});
    const orderEntry = p => visibleOrder(p).locator('xpath=ancestor::*[self::tr or self::li][1]');
    async function revealOrderFilters(p) {
      if (await p.locator('details.order-advanced-filters').getAttribute('open')===null) await p.getByText(/^Filtros de pedidos(?: · \d+ activos?)?$/).click();
    }
    function matchOrderFilter(name, key, excluded, included) {
      return async p => {
        await revealOrderFilters(p);
        const filter=p.getByRole('combobox',{name});
        await expect(filter).toHaveValue('');
        await filter.selectOption(excluded);
        await expect(p).toHaveURL(url=>url.searchParams.get(key)===excluded);
        await expect(visibleOrder(p)).toHaveCount(0);
        await filter.selectOption(included);
        await expect(visibleOrder(p)).toHaveCount(1);
      };
    }
    const contentEntry = (p, title) => p.getByText(title,{exact:true}).filter({visible:true}).locator('xpath=ancestor::*[self::tr or self::li][1]');
    function orderIssue(id, search, issue, label, included, witnessText) {
      const target = p => p.getByRole('button',{name:label,exact:true});
      return { id, search, href:`/admin?section=orders&tab=list&issue=${issue}`, directory:true, target, native:async p=>{
        await revealOrderFilters(p);
        await expect(target(p)).toHaveAttribute('aria-pressed','true');
        await expect(p.getByRole('region',{name:'Resultados de pedidos'})).toHaveAttribute('aria-busy','false');
        await expect(visibleOrder(p)).toHaveCount(included?1:0);
        if (witnessText) {
          const number=`AN-${String(incidentOrder.number).padStart(6,'0')}`;
          const witness=p.getByRole('region',{name:'Resultados de pedidos'}).getByText(number,{exact:true}).filter({visible:true}).locator('xpath=ancestor::*[self::tr or self::li][1]');
          await expect(witness.getByText(witnessText,{exact:true})).toBeVisible();
        }
      }};
    }
    // Independent native routes, names and effects, not generated from the directory.
    const fixtures = [
      { id:'home.overview', search:'resumen', href:'/admin', target: p => p.getByRole('heading', { name:'Tu negocio', exact:true }), native: async p => {
        await expect(p.getByText(/Actualizado:.*Bogotá/).first()).toBeVisible();
      }},
      { id:'home.attention', search:'ver pendientes', href:'/admin?issue=attention', target:p=>p.getByRole('heading',{name:'Toda la atención pendiente',exact:true}), native:async p=>{
        await expect(p.getByRole('combobox',{name:'Severidad'})).toBeVisible();
        await expect(p.getByRole('button',{name:'Volver al resumen',exact:true})).toBeVisible();
      }},
      { id:'home.attention-filter', search:'pendientes críticos', href:'/admin?issue=attention', target:p=>p.getByRole('combobox',{name:'Severidad'}), native:async p=>{
        await p.getByRole('combobox',{name:'Severidad'}).selectOption({label:'Crítica'});
        await expect(p).toHaveURL(url=>url.searchParams.get('status')==='critical');
        await expect(p.getByRole('button',{name:'Limpiar filtro',exact:true})).toBeVisible();
      }},
      { id:'orders.search', search:'buscar un pedido', href:'/admin?section=orders&tab=list', target:p=>p.getByRole('textbox',{name:'Buscar pedidos'}), native:async p=>{
        await p.getByRole('textbox',{name:'Buscar pedidos'}).fill(`sin-coincidencias-${code}`);
        await expect(p).toHaveURL(url=>url.searchParams.get('q')===`sin-coincidencias-${code}`);
        await expect(p.getByRole('region',{name:'Resultados de pedidos'})).toHaveAttribute('aria-busy','false');
        await expect(p.getByRole('region',{name:'Resultados de pedidos'}).getByText(/no hay (?:pedidos|coincidencias)/i)).toBeVisible();
      }},
      { id:'orders.list', search:'pedidos guardados', href:'/admin?section=orders&tab=list', directory:true, target:p=>p.getByRole('region',{name:'Resultados de pedidos'}), native:async p=>{
        for (const label of ['Preparando','Envíos: Sin envío registrado','Cobro: Pendiente']) await expect(orderEntry(p).getByText(label,{exact:true})).toBeVisible();
      }},
      { id:'orders.filter-status', search:'pedidos nuevos', href:'/admin?section=orders&tab=list', directory:true, target:p=>p.getByRole('combobox',{name:'Estado del pedido'}), native:matchOrderFilter('Estado del pedido','status','new','preparing') },
      { id:'orders.filter-payment', search:'pedidos pagados', href:'/admin?section=orders&tab=list', directory:true, target:p=>p.getByRole('combobox',{name:'Estado de cobro'}), native:matchOrderFilter('Estado de cobro','paymentStatus','paid','pending') },
      { id:'orders.filter-carrier', search:'pedidos por operador logístico', href:'/admin?section=orders&tab=list', directory:true, target:p=>p.getByRole('textbox',{name:'Transportadora exacta'}), native:async p=>{
        await revealOrderFilters(p);
        const carrier=`Transportadora inexistente ${code}`;
        await p.getByRole('textbox',{name:'Transportadora exacta'}).fill(carrier);
        await expect(p).toHaveURL(url=>url.searchParams.get('carrier')===carrier);
        await expect(p.getByRole('heading',{name:'No hay coincidencias',exact:true})).toBeVisible();
      }},
      { id:'orders.filter-missing-cost', search:'costos por completar', href:'/admin?section=orders&tab=list&issue=missing_cost', directory:true, target:p=>p.getByRole('button',{name:'Faltan costos',exact:true}), native:async p=>{
        await revealOrderFilters(p);
        await expect(p.getByRole('button',{name:'Faltan costos',exact:true})).toHaveAttribute('aria-pressed','true');
        await expect(orderEntry(p).getByText('Faltan costos',{exact:true})).toBeVisible();
      }},
      orderIssue('orders.filter-incident','retorno en tránsito','incident','Con novedad',false,'Envíos: Con novedad'),
      orderIssue('orders.filter-pending-settlement','recaudo retenido','pending_settlement','Pendiente de liquidar',false,'Pendiente de liquidar'),
      orderIssue('orders.filter-missing-data','cobertura de pedidos','missing_data','Faltan datos',true),
      { id:'orders.clear-filters', search:'limpiar búsqueda de pedidos', href:`/admin?section=orders&tab=list&q=${orderNumber}&status=new`, directory:true, context:true, target:p=>p.getByRole('button',{name:'Limpiar filtros',exact:true}), native:async p=>{
        await expect(p.getByRole('heading',{name:'No hay coincidencias',exact:true})).toBeVisible();
        await p.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='list'&&!url.searchParams.has('q')&&!url.searchParams.has('status'));
        await expect(visibleOrder(p)).toHaveCount(1);
      }},
      orderIssue('orders.filter-legacy-payment','cobros antiguos','legacy_review','Pago histórico por conciliar',false),
      { id:'heka.operation-status', search:'heka configurada', href:'/admin?section=orders&tab=heka', directory:true, target:p=>p.getByText(/No hay una llave Heka configurada/).locator('..'), native:async p=>{
        await expect(p.getByText(/No hay una llave Heka configurada.*historial del panel sigue disponible/)).toBeVisible();
      }},
      { id:'cash.view-overview', search:'resumen financiero', href:'/admin?section=cash&tab=overview', directory:true, target:p=>p.getByRole('region',{name:'Resumen financiero'}), native:async p=>{
        const summary=p.getByRole('region',{name:'Resumen financiero'});
        await expect(summary.getByText(/Saldo registrado al .* Bogotá\. No es la ganancia/)).toBeVisible();
        await expect(summary.getByRole('heading',{name:'Por recibir de plataforma',exact:true})).toBeVisible();
        await expect(summary.getByRole('heading',{name:'Gastos por pagar',exact:true})).toBeVisible();
        await expect(summary.getByRole('heading',{name:'Créditos por recuperar',exact:true})).toBeVisible();
      }},
      { id:'products.list', search:'lista de productos', href:'/admin?section=products', target:p=>p.getByRole('heading',{name:'Productos',exact:true,level:2}), native:async p=>{
        await expect(p.getByText(title,{exact:true}).filter({visible:true})).toHaveCount(1);
        await expect(p.getByText(/registros guardados · .* borradores/)).toBeVisible();
      }},
      { id:'products.list-gifts', search:'productos de regalo', href:'/admin?section=products&productType=gift', directory:true, target:p=>p.getByRole('heading',{name:'Obsequios',exact:true,level:2}), native:async p=>{
        await expect(contentEntry(p,gift.title).getByText('4 posibles con sus componentes',{exact:true})).toBeVisible();
        await expect(contentEntry(p,product.title)).toHaveCount(0);
      }},
      { id:'products.list-combos', search:'listado de paquetes', href:'/admin?section=combos', directory:true, target:p=>p.getByRole('heading',{name:'Combos',exact:true,level:2}), native:async p=>{
        await expect(contentEntry(p,combo.title).getByText('Borrador',{exact:true})).toBeVisible();
        await expect(contentEntry(p,combo.title).getByText(/\$\s*2[.,]500/)).toBeVisible();
      }},
      { id:'products.list-catalogs', search:'colecciones guardadas', href:'/admin?section=catalogs', directory:true, target:p=>p.getByRole('heading',{name:'Catálogos',exact:true,level:2}), native:async p=>{
        await expect(contentEntry(p,collection.title).getByText('Borrador',{exact:true})).toBeVisible();
        await expect(contentEntry(p,collection.title).getByText(/^(?:Orden: )?42$/)).toBeVisible();
      }},
      { id:'products.search-content', search:'buscar nombre producto', href:'/admin?section=products', target: p => p.getByRole('textbox', { name:'Buscar por nombre, presentación o referencia' }), native: async p => {
        await p.getByRole('textbox', { name:'Buscar por nombre, presentación o referencia' }).fill(title);
        await expect(p.getByText(title, {exact:true}).filter({visible:true})).toHaveCount(1);
      }},
      { id:'products.filter-publication', search:'productos borrador', href:'/admin?section=products', directory:true, target:p=>p.getByRole('combobox',{name:'Filtrar por publicación'}), native:async p=>{
        const filter=p.getByRole('combobox',{name:'Filtrar por publicación'});
        await expect(p.getByText(archived.title,{exact:true}).filter({visible:true})).toHaveCount(1);
        await filter.selectOption('draft');
        await expect(p).toHaveURL(url=>url.searchParams.get('status')==='draft');
        await expect(p.getByText(title,{exact:true}).filter({visible:true})).toHaveCount(1);
        await expect(p.getByText(archived.title,{exact:true}).filter({visible:true})).toHaveCount(0);
      }},
      { id:'products.filter-type', search:'filtrar tipo de producto', href:'/admin?section=products', directory:true, target:p=>p.getByRole('combobox',{name:'Tipo de producto'}), native:async p=>{
        const filter=p.getByRole('combobox',{name:'Tipo de producto'});
        await expect(p.getByText(title,{exact:true}).filter({visible:true})).toHaveCount(1);
        await filter.selectOption('gift');
        await expect(p).toHaveURL(url=>url.searchParams.get('productType')==='gift');
        await expect(p.getByText(title,{exact:true}).filter({visible:true})).toHaveCount(0);
        await filter.selectOption('product');
        await expect(p.getByText(title,{exact:true}).filter({visible:true})).toHaveCount(1);
      }},
      { id:'products.clear-filters', search:'mostrar todas las fichas', href:`/admin?section=products&q=${code}&status=draft&productType=product`, directory:true, context:true, target:p=>p.getByRole('button',{name:'Limpiar filtros',exact:true}), native:async p=>{
        await expect(contentEntry(p,product.title)).toBeVisible();
        await expect(contentEntry(p,archived.title)).toHaveCount(0);
        await p.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
        await expect(p).toHaveURL(url=>url.searchParams.get('section')==='products'&&['q','status','productType'].every(key=>!url.searchParams.has(key)));
        await expect(contentEntry(p,archived.title)).toBeVisible();
        await expect(contentEntry(p,gift.title)).toBeVisible();
      }},
      { id:'products.prepare-record', search:'borrador de producto', href:'/admin?section=products&record=new', target: p => p.getByRole('dialog').getByRole('heading', {name:'Crear producto',exact:true}), native: async p => {
        await expect(p.getByRole('dialog').getByText('Sin cambios pendientes', {exact:true})).toBeVisible();
      }},
      { id:'business.user-prepare', search:'preparar nuevo acceso', href:'/admin?section=users', target: p => p.getByRole('heading', { name:'Crear usuario', exact:true }), native: async p => {
        await p.getByRole('button', { name:'Preparar nuevo acceso' }).click();
        await expect(p.getByRole('heading', { name:'Crear usuario', exact:true })).toBeFocused();
      }},
      { id:'business.users', search:'usuarios registrados', href:'/admin?section=users', directory:true, target:p=>p.getByRole('heading',{name:/^Usuarios registrados \(\d+\)$/}), native:async p=>{
        const users=p.getByRole('region',{name:/^Usuarios registrados \(\d+\)$/});
        await expect(users.getByText('Administrador',{exact:true}).filter({visible:true}).first()).toBeVisible();
        await expect(users.getByText('Activo',{exact:true}).filter({visible:true}).first()).toBeVisible();
      }},
      { id:'storefront.whatsapp-preview', search:'ejemplo de mensaje prellenado', href:'/admin?section=settings', directory:true, target:p=>p.getByRole('heading',{name:'Mensaje de ejemplo',exact:true}), native:async p=>{
        const example=p.getByRole('heading',{name:'Mensaje de ejemplo',exact:true}).locator('..');
        await expect(example).toContainText('Solo es texto de ejemplo: no se envía ni responde automáticamente.');
        const rendered=String(savedStorefront.whatsappTemplate||'').replaceAll('{producto}','producto de ejemplo');
        if (rendered) await expect(example).toContainText(rendered);
      }},
      { id:'storefront.settings', search:'configurar mi página', href:'/admin?section=settings', directory:true, target:p=>p.getByText(/^Estado guardado: (?:vitrina publicada|modo preparación)$/), native:async p=>{
        await expect(p.getByText(savedStorefront.launchApproved?'Estado guardado: vitrina publicada':'Estado guardado: modo preparación',{exact:true})).toBeVisible();
        await expect(p.locator('input[name=brandName]')).toHaveValue(savedStorefront.brandName);
      }},
      { id:'storefront.launch', search:'habilitar página pública', href:'/admin?section=settings', target: p => p.getByRole('checkbox', { name:/Publicar la vitrina/ }), native: async p => {
        await p.getByRole('button', { name:'Revisar publicación', exact:true }).click();
        await expect(p.getByRole('heading', { name:'Publicación de la vitrina', exact:true })).toBeFocused();
      }},
      { id:'assistant.settings-key', search:'api key de ali', href:'/admin?section=business&tab=assistant', target: p => p.locator('input[name=apiKey]'), native: async p => {
        await expect(p.getByText('Guardada; no se muestra', { exact:true })).toBeVisible();
      }},
      { id:'assistant.settings-status', search:'estado del proveedor de ali', href:'/admin?section=business&tab=assistant', directory:true, target:p=>p.locator('dl[aria-label="Estado de conexión de Ali"]'), native:async p=>{
        const status=p.locator('dl[aria-label="Estado de conexión de Ali"]');
        await expect(status.getByText('Clave API',{exact:true})).toBeVisible();
        await expect(status.getByText('Habilitado · Conexión verificada',{exact:true})).toBeVisible();
        await expect(status.getByText('Guardada; no se muestra',{exact:true})).toBeVisible();
        await expect(status).not.toContainText('assistant-fixture-only');
      }},
      { id:'business.setup', search:'primeros pasos', href:'/admin?section=business&tab=setup', directory:true, target:p=>p.getByRole('list',{name:'Progreso de puesta en marcha'}), native:async p=>{
        const progress=p.getByRole('list',{name:'Progreso de puesta en marcha'});
        await expect(progress.getByRole('button',{name:/^\d\. .* (?:Pendiente|Prueba opcional|Realizado)$/})).toHaveCount(4);
        await expect(progress.locator('button[aria-current=step]')).toBeEnabled();
        await expect(p.getByText(/Mostrando datos guardados/)).toBeVisible();
      }},
      { id:'business.people', search:'personas responsables', href:'/admin?section=business&tab=people', directory:true, target:p=>p.getByRole('heading',{name:'Personas responsables y vendedores',exact:true}), native:async p=>{
        const personRow=p.getByRole('listitem').filter({has:p.getByText(person.name,{exact:true})});
        await expect(personRow).toContainText('Activa · 0 convenios · 0 vigencias de comisión');
        await expect(p.getByText(/No crea acceso al panel/)).toBeVisible();
      }},
      { id:'business.financial-rules', search:'historial de reglas', href:'/admin?section=business&tab=rules', directory:true, target:p=>p.getByText('Historial de vigencias',{exact:true}), native:async p=>{
        await p.getByText('Historial de vigencias',{exact:true}).click();
        const active=await p.locator('.settings-policy strong').textContent();
        const effective=active.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        expect(effective).toBeTruthy();
        await expect(p.getByText(`Desde ${effective}`,{exact:true})).toBeVisible();
      }},
      { id:'business.automation-status', search:'estado del proceso programado', href:'/admin?section=business&tab=rules', directory:true, target:p=>p.getByRole('heading',{name:'Estado de actualización automática',exact:true}), native:async p=>{
        await expect(p.getByText(/^Última señal:/)).toBeVisible();
        await expect(p.getByText(/El panel no inicia ni configura un servicio externo/)).toBeVisible();
      }},
    ];
    const writes = [];
    page.on('request', req => {
      if (req.method() !== 'GET' && /\/api\/admin\/(?:orders|users|settings|products|business|assistant\/settings)(?:\/|[?#]|$)/.test(req.url())) writes.push(req.url());
    });
    const savedStorefront = await store.settings();
    for (const fixture of fixtures) {
      await page.goto(fixture.href);
      if (fixture.context) await expect(fixture.target(page)).toBeVisible();
      await fixture.native(page);
      if (!fixture.context) await expect(fixture.target(page)).toBeVisible();
      await page.goto(fixture.context?fixture.href:'/admin');
      const chat = await openAli(page);
      await askAli(chat, `¿Dónde está ${fixture.search}?`);
      const action = chat.locator(`[data-capability-id="${fixture.id}"]`);
      await action.getByRole('button', {name:/^Abrir en el panel:/}).click();
      const expected = new URL(fixture.href, info.project.use.baseURL);
      await expect(page).toHaveURL(url => url.pathname === expected.pathname && [...expected.searchParams].every(([key,value]) => url.searchParams.get(key) === value));
      await expect(fixture.target(page)).toBeFocused();
      if (fixture.id === 'orders.filter-status') await screenshot(page, info, 'advisor-c6-filtro-pedido');
      if (['home.attention','home.attention-filter','orders.search','products.list','products.search-content'].includes(fixture.id) || fixture.directory) await fixture.native(page);
      if (fixture.directory) {
        await page.goto(fixture.context?fixture.href:'/admin');
        const launcher=fixture.context?await openAli(page):page;
        await launcher.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        const directory=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await directory.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.search);
        await directory.getByRole('button',{name:'Buscar',exact:true}).click();
        await directory.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(fixture.target(page)).toBeFocused();
        await fixture.native(page);
      }
      if (fixture.id === 'assistant.settings-key') {
        await expect(fixture.target(page)).toHaveAttribute('type','password');
        await expect(fixture.target(page)).toHaveValue('');
      }
      if (fixture.id === 'storefront.launch') {
        expect(await fixture.target(page).isChecked()).toBe(Boolean(savedStorefront.launchApproved));
        await screenshot(page, info, 'advisor-c6-publicacion-nativa');
      }
    }
    expect(writes).toEqual([]);
    expect((await store.get('products', product.id)).version).toBe(productVersion);
    for (const [kind, record] of [['products',archived],['products',gift],['combos',combo],['catalogs',collection]]) {
      expect((await store.get(kind,record.id)).version).toBe(record.version);
    }
    expect((await store.settings()).version).toBe(savedStorefront.version);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: contrasta filtros de informes y envíos y entradas privadas de publicidad', async ({ page, context, request }, info) => {
  test.setTimeout(300000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try {
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), day=bogotaDate();
    const seller=await saveResource(store,'people',{requestId:randomUUID(),name:`Vendedor ${code}`},actorId);
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Plataforma ${code}`},actorId);
    const account=await saveAccount(store,{requestId:randomUUID(),name:`Caja ${code}`,type:'cash',openingOn:day,openingBalanceMinor:14900000,responsibleId:seller.id},actorId);
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto informe ${code}`,slug:`e2e-report-${code}`,status:'draft',price:1000,presentation:'Unidad',orderable:true,stockQuantity:20},null,null,actorId);
    const sale=await store.saveOrder(businessOrderInput(product,{placedOn:day,sellerId:seller.id,customerName:`Pedido informe ${code}`,items:[{lineId:randomUUID(),kind:'products',itemId:product.id,quantity:2,unitPriceMinor:100000,discountMinor:0}]}),actorId);
    const tracking=`GUIA-INFORME-${code}`, carrier=`Operador ${code}`;
    let shipment=await createShipment(store,{requestId:randomUUID(),orderId:sale.id,platformId:platform.id,carrier,tracking,estimatedDeliveryOn:day},actorId);
    shipment=await recordShipmentEvent(store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'collected',occurredOn:day},actorId);
    await recordShipmentEvent(store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'delivered',occurredOn:day},actorId);
    await recordExpense(store,{requestId:randomUUID(),shipmentId:shipment.id,category:'shipping_out',concept:`Flete ${code}`,amountMinor:870000,incurredOn:day},actorId);
    const orphanTracking=`GUIA-HUERFANA-${code}`;
    const orphan=await createShipment(store,{requestId:randomUUID(),carrier:`Otro operador ${code}`,tracking:orphanTracking},actorId);
    await recordShipmentEvent(store,orphan.id,{requestId:randomUUID(),version:orphan.version,status:'incident',occurredOn:day,notes:'Incidencia sintética'},actorId);
    const currentSale=await store.order(sale.id);
    const returnReason=`Devolución ${code}`, costConcept=`Gasto informe ${code}`;
    await registerReturn(store,{requestId:randomUUID(),orderId:sale.id,version:currentSale.version,occurredOn:day,reason:returnReason,lines:[{lineId:currentSale.items[0].lineId,quantity:1,condition:'recoverable'}]},actorId);
    await recordExpense(store,{requestId:randomUUID(),orderId:sale.id,category:'operating',concept:costConcept,amountMinor:3180000,incurredOn:day},actorId);
    const campaignName=`Campaña ${code}`;
    const campaign=await saveSocialCampaign(store,{requestId:randomUUID(),name:campaignName,mode:'organic',objective:'reach',caption:'Texto sintético',platforms:['facebook']},actorId);
    const copyAnchor=info.project.name==='mobile'?'2023-12-01':'2023-11-01';
    const copyFilter=`Transportadora ${code}`;
    const copy=await generateReportSnapshot(store,{period:'month',anchorDate:copyAnchor,filters:{carrier:copyFilter}},actorId);
    const savedView=`/admin?${new URLSearchParams({section:'reports',tab:'overview',mode:'saved',period:'month',anchor:copyAnchor,carrier:copyFilter})}`;
    const versionView=`${savedView}&record=${copy.snapshot.id}`;
    const metricsView=tab=>`/admin?section=reports&tab=${tab}&period=month&anchor=${day}&seller=${seller.id}`;
    const frozen=await generateReportSnapshot(store,{period:'month',anchorDate:day,filters:{seller:seller.id}},actorId);
    const frozenView=tab=>`${metricsView(tab)}&mode=saved&record=${frozen.snapshot.id}`;

    function reportFilter(id, search, key, label, record, tab='overview') {
      return {id,search,href:`/admin?section=reports&tab=${tab}`,target:p=>p.getByRole('combobox',{name:label,exact:true}),native:async(p,target)=>{
        const disclosure=p.locator('details.report-filters');
        if (await disclosure.getAttribute('open')===null) await disclosure.locator('summary').click();
        await expect(target.locator(`option[value="${record.id}"]`)).toHaveCount(1);
        const data=p.waitForResponse(res=>{
          const url=new URL(res.url());
          return res.request().method()==='GET'&&url.pathname==='/api/admin/reports'&&url.searchParams.get(key)===record.id;
        });
        await target.selectOption(record.id);
        const response=await data;
        expect(response.ok()).toBe(true);
        expect((await response.json()).query.filters[key]).toBe(record.id);
        await expect(p.getByRole('button',{name:new RegExp(`^Quitar filtro: ${label}:`,'u')})).toContainText(record.name||record.title);
        await expect(p.getByText(/Datos hasta .* · hora de Bogotá/)).toBeVisible();
      }};
    }
    function reportGroup(id, search, tab, title, caption, text, expected, query) {
      return {id,search,href:`/admin?section=reports&tab=${tab}&${query}`,startAtDestination:true,target:p=>p.getByRole('heading',{name:new RegExp(`^${title} · `)}),native:async p=>{
        const row=p.getByRole('table',{name:caption,exact:true}).getByRole('row').filter({has:p.getByText(text,{exact:true})});
        await expect(row).toContainText(expected);
      }};
    }
    const shipView=`/admin?section=orders&tab=shipments&q=${code}`;
    const shipRegion=p=>p.getByRole('region',{name:'Seguimiento de envíos'});
    const guide=(p,name)=>shipRegion(p).getByRole('article').filter({has:p.getByRole('heading',{name,exact:true})});
    async function shipFilter(p) {
      const summary=shipRegion(p).locator('summary').filter({hasText:/^Filtros de envíos/});
      if (await summary.locator('..').getAttribute('open')===null) await summary.click();
    }
    function shipPriority(id, search, issue, label) {
      const target=p=>shipRegion(p).getByRole('button',{name:label,exact:true});
      return {id,search,href:`${shipView}&issue=${issue}`,startAtDestination:true,target,native:async p=>{
        await shipFilter(p);
        await expect(target(p)).toHaveAttribute('aria-pressed','true');
        await expect(guide(p,orphanTracking)).toContainText('Revisar y vincular');
        await expect(guide(p,tracking)).toHaveCount(0);
      }};
    }
    const campaignView='/admin?section=advertising&tab=campaigns';
    const detail=p=>p.getByRole('region',{name:'Registros exactos de la métrica'});
    const saleButton=`Abrir pedido AN-${String(sale.number).padStart(6,'0')}`;
    const pending=p=>p.locator('summary').filter({hasText:/^Datos por completar \(/});
    const openMetric=metric=>p=>p.getByRole('button',{name:`Ver registros de ${metric}`,exact:true}).click();
    const openMissing=async p=>{
      await pending(p).click();
      const cost=p.locator('details.report-pending li').filter({hasText:/^Costo histórico de producto pendiente:/});
      await cost.getByRole('button',{name:'Ver registros pendientes',exact:true}).click();
    };
    function reportDetail(id,search,saved,missing) {
      const href=(saved?frozenView:metricsView)(missing?'costs':'sales');
      const metric=missing?'Costo vendido':'Ventas netas de productos';
      return {id,search,href,startAtDestination:true,prepare:missing?openMissing:openMetric(metric),target:p=>detail(p).getByRole('heading',{name:missing?`Datos pendientes · ${metric}`:metric,exact:true}),native:async p=>{
        if(saved)await expect(p.getByRole('heading',{name:`Copia guardada · Versión ${frozen.snapshot.revision}`,exact:true})).toBeVisible();
        const table=detail(p).getByRole('table',{name:'Registros que explican la cifra',exact:true});
        const rows=table.getByRole('row').filter({has:p.getByRole('button',{name:saleButton,exact:true})});
        if(missing){
          await expect(rows.filter({hasText:/Excluido:.*[Cc]osto histórico de producto pendiente/})).toHaveCount(1);
          await expect(detail(p).getByText(/Faltan datos para completar esta cifra/)).toBeVisible();
        }else{
          await expect(rows.filter({hasText:/\$\s*2[.,]000/})).toHaveCount(1);
          await expect(rows.filter({hasText:/\$\s*1[.,]000/})).toHaveCount(1);
        }
      }};
    }
    const cases=[
      reportFilter('reports.filter-by-seller','reporte de vendedor','seller','Vendedor',seller),
      reportFilter('reports.filter-by-product','filtrar por producto','product','Producto u obsequio / combo',product),
      reportFilter('reports.filter-by-platform','reporte de la plataforma','platform','Plataforma',platform),
      reportFilter('reports.filter-by-account','reporte de una cuenta','account','Cuenta de caja o banco',account,'cash'),
      {id:'reports.clear-filters',search:'limpiar filtros del informe',href:`/admin?section=reports&tab=overview&period=month&anchor=${day}&seller=${seller.id}&product=${product.id}`,startAtDestination:true,target:p=>p.getByRole('button',{name:'Limpiar filtros',exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p).toHaveURL(url=>url.searchParams.get('anchor')===day&&url.searchParams.get('period')==='month'&&!url.searchParams.has('seller')&&!url.searchParams.has('product'));
        await expect(p.getByText('Sin filtros: se consulta todo el período',{exact:true})).toBeVisible();
        await expect(p.getByText('Filtrar resultados',{exact:true})).toBeFocused();
      }},
      {id:'reports.view-live',search:'resumen de informes',href:'/admin?section=reports&tab=overview',target:p=>p.getByRole('heading',{name:/^Resumen · /}),native:async p=>{
        await expect(p.getByText('Consulta los datos registrados sin guardar una copia ni cambiar el negocio.',{exact:true})).toBeVisible();
        await expect(p.getByText(/Datos hasta .* · hora de Bogotá/)).toBeVisible();
      }},
      {id:'reports.view-cash',search:'flujo por cuenta',href:`/admin?section=reports&tab=cash&account=${account.id}`,startAtDestination:true,target:p=>p.getByRole('heading',{name:/^Caja · /}),native:async p=>{
        const row=p.getByRole('table',{name:'Saldos y movimientos por cuenta'}).getByRole('row').filter({hasText:account.name});
        await expect(row.getByText(account.name,{exact:true})).toBeVisible();
        await expect(row).toContainText(/149[.,]000/);
        await expect(p.getByText(/El recaudo retenido en plataforma se informa aparte/)).toBeVisible();
      }},
      {id:'reports.filter-by-period',search:'reporte trimestral',href:'/admin?section=reports&tab=overview',target:p=>p.getByRole('combobox',{name:'Frecuencia',exact:true}),native:async(p,target)=>{
        await target.selectOption('quarter');
        await expect(p).toHaveURL(url=>url.searchParams.get('period')==='quarter');
        const range=await p.locator('.report-period-range').textContent();
        const [start,end]=range.match(/\d{2}\/\d{2}\/\d{4}/g);
        await expect(p.getByRole('heading',{name:`Resumen · ${start} al ${end}`,exact:true})).toBeVisible();
      }},
      {id:'reports.view-definitions',search:'definiciones del informe',href:'/admin?section=reports&tab=overview',target:p=>p.getByText('Definiciones, criterios y reglas del informe',{exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p.getByText(/inicio incluido y fin excluido.*Sin dato no equivale a cero/)).toBeVisible();
      }},
      {id:'reports.view-guide',search:'cómo usar informes',href:'/admin?section=reports&tab=overview',target:p=>p.getByText('Cómo usar Informes',{exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p.getByRole('region',{name:'Glosario de Informes'})).toContainText('Fecha y hora hasta la que se tomaron los datos.');
        await expect(p.getByText(/Leer esta guía no cambia datos, solicita copias ni guarda progreso/)).toBeVisible();
      }},
      {id:'reports.view-saved-list',search:'listar copias',href:savedView,startAtDestination:true,target:p=>p.getByText(/^Copias de este período y estos filtros/),native:async p=>{
        const versions=p.getByRole('table',{name:'Informes guardados'});
        await expect(versions.getByRole('button',{name:new RegExp(`^Abrir versión ${copy.snapshot.revision}:`)})).toBeVisible();
        await expect(versions.getByText('Última versión guardada',{exact:true})).toBeVisible();
      }},
      {id:'reports.view-snapshot-filters',search:'filtros de la copia',href:versionView,startAtDestination:true,target:p=>p.getByText(/^Filtros de esta copia \(/),native:async(p,target)=>{
        await target.click();
        await expect(p.getByText(/Estos filtros pertenecen a la copia/)).toBeVisible();
        await expect(p.getByText(`Transportadora: ${copyFilter}`,{exact:true})).toBeVisible();
        await expect(p.getByRole('combobox',{name:'Transportadora',exact:true})).toHaveCount(0);
      }},
      {id:'reports.compare-with-live',search:'comparar copia con datos actuales',href:versionView,startAtDestination:true,target:p=>p.getByRole('button',{name:'Ver datos actuales de este período',exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p).toHaveURL(url=>url.searchParams.get('anchor')===copyAnchor&&url.searchParams.get('carrier')===copyFilter&&!url.searchParams.has('record')&&!url.searchParams.has('mode'));
        await expect(p.getByText('Consulta los datos registrados sin guardar una copia ni cambiar el negocio.',{exact:true})).toBeVisible();
      }},
      {id:'reports.view-source-cuts',search:'hasta cuándo hay datos',href:`/admin?section=reports&tab=overview&platform=${platform.id}`,startAtDestination:true,target:p=>p.getByText('Cortes y últimas importaciones por plataforma',{exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(target.locator('..')).toContainText('No hay importaciones de plataforma registradas. Las operaciones manuales no tienen un corte de archivo ficticio.');
      }},
      {id:'reports.view-sales',search:'ventas por producto',href:`/admin?section=reports&tab=sales&seller=${seller.id}`,startAtDestination:true,target:p=>p.getByRole('heading',{name:/^Ventas · /}),native:async p=>{
        await expect(p.getByText(/No son necesariamente cobros recibidos/)).toBeVisible();
        for (const [table,label] of [['Por producto histórico',product.title],['Por vendedor histórico',seller.name]]) {
          const row=p.getByRole('table',{name:table,exact:true}).getByRole('row').filter({has:p.getByText(label,{exact:true})});
          await expect(row.locator('td').nth(1)).toHaveText('1');
          await expect(row.locator('td').nth(2)).toHaveText('2');
          await expect(row.locator('td').nth(3)).toHaveText(/\$\s*1[.,]000/);
          await expect(row.locator('td').nth(4)).toContainText(/Sin dato|parcial/i);
        }
      }},
      {id:'reports.view-coverage',search:'datos por completar en informe',href:metricsView('costs'),startAtDestination:true,target:pending,native:async(p,target)=>{
        await target.click();
        await expect(target.locator('..')).toContainText('Costo histórico de producto pendiente');
        await expect(target.locator('..')).toContainText('Estas cifras pueden estar incompletas');
      }},
      reportDetail('reports.view-metric-detail','desglose de métrica',false,false),
      reportDetail('reports.view-missing-detail','registros sin costo en informe',false,true),
      reportDetail('reports.view-snapshot-metric-detail','registros de métrica guardada',true,false),
      reportDetail('reports.view-snapshot-missing-detail','pendientes del informe guardado',true,true),
      reportGroup('reports.view-shipping','tránsito de guías','shipping','Envíos','Guías y fechas reales (los pedidos se cuentan por separado)',tracking,'Entregado',`carrier=${encodeURIComponent(carrier)}`),
      reportGroup('reports.view-returns','mercancía devuelta','returns','Devoluciones','Devoluciones y cancelaciones comerciales (no reembolsos)',returnReason,/\$\s*1[.,]000/,`seller=${seller.id}`),
      reportGroup('reports.view-costs','costos devengados y pagados','costs','Costos','Gastos registrados; las fechas desconocidas permanecen pendientes',costConcept,/31[.,]800/,`seller=${seller.id}`),
      reportFilter('reports.filter-by-carrier','filtrar informe por mensajería','carrier','Transportadora',{id:carrier,name:carrier}),
      reportFilter('reports.filter-by-state','filtrar reporte por estado','status','Estado',{id:'delivered',name:'Entregado'}),
      {id:'shipments.list',search:'lista de guías',href:shipView,startAtDestination:true,target:p=>shipRegion(p).getByRole('heading',{name:'Seguimiento de envíos',exact:true}),native:async p=>{
        await expect(guide(p,tracking)).toContainText('Entregado');
        await expect(guide(p,tracking)).toContainText(carrier);
        await expect(guide(p,orphanTracking)).toContainText('Revisar y vincular');
      }},
      {id:'shipments.search',search:'buscar guía',href:shipView,startAtDestination:true,target:p=>shipRegion(p).getByRole('searchbox',{name:'Buscar guía o número AN'}),native:async(p,target)=>{
        await target.fill(orphanTracking);
        await expect(guide(p,orphanTracking)).toBeVisible();
        await expect(guide(p,tracking)).toHaveCount(0);
      }},
      {id:'shipments.filter-status',search:'guías entregadas',href:shipView,startAtDestination:true,target:p=>shipRegion(p).getByRole('combobox',{name:'Estado',exact:true}),native:async(p,target)=>{
        await shipFilter(p);await target.selectOption('delivered');
        await expect(p).toHaveURL(url=>url.searchParams.get('status')==='delivered');
        await expect(guide(p,tracking)).toBeVisible();
        await expect(guide(p,orphanTracking)).toHaveCount(0);
      }},
      {id:'shipments.filter-origin',search:'guías por fuente',href:shipView,startAtDestination:true,target:p=>shipRegion(p).getByRole('combobox',{name:'Plataforma',exact:true}),native:async(p,target)=>{
        await shipFilter(p);await target.selectOption(platform.id);
        await expect(p).toHaveURL(url=>url.searchParams.get('platform')===platform.id);
        await expect(guide(p,tracking)).toContainText(platform.name);
        await expect(guide(p,orphanTracking)).toHaveCount(0);
      }},
      {id:'shipments.filter-carrier',search:'guías por transportadora',href:shipView,startAtDestination:true,target:p=>shipRegion(p).getByRole('textbox',{name:'Transportadora exacta'}),native:async(p,target)=>{
        await shipFilter(p);await target.fill(`${carrier} no existe`);
        await expect(shipRegion(p).getByRole('heading',{name:'No hay envíos con estos filtros',exact:true})).toBeVisible();
        await target.fill(carrier);
        await expect(guide(p,tracking)).toBeVisible();
        await expect(guide(p,orphanTracking)).toHaveCount(0);
      }},
      shipPriority('shipments.filter-unlinked','envíos huérfanos','orphan','Vincular pedido'),
      shipPriority('shipments.filter-incident','incidencias de seguimiento','incident','Con novedad'),
      shipPriority('shipments.filter-missing-data','faltan datos de guía','missing_data','Faltan datos'),
      {id:'shipments.clear-filters',search:'limpiar filtros de envíos',href:`${shipView}&status=incident`,startAtDestination:true,target:p=>shipRegion(p).getByRole('button',{name:'Limpiar filtros',exact:true}),native:async(p,target)=>{
        await expect(guide(p,orphanTracking)).toBeVisible();
        await target.click();
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='shipments'&&!url.searchParams.has('q')&&!url.searchParams.has('status'));
        await expect(shipRegion(p).getByText(/^Filtros activos:/)).toHaveCount(0);
      }},
      {id:'advertising.open-guide',search:'manual de publicidad',href:campaignView,target:p=>p.getByRole('button',{name:'Ver guía',exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p.getByText('Leer la guía no guarda, publica ni autoriza inversión.',{exact:true})).toBeVisible();
        await expect(p.getByRole('heading',{name:'Glosario breve',exact:true})).toBeVisible();
      }},
      {id:'advertising.list-campaigns',search:'listar anuncios',href:campaignView,target:p=>p.getByRole('textbox',{name:'Buscar publicación'}),native:async(p,target)=>{
        await target.fill(`${campaignName} inexistente`);
        await expect(p.getByRole('heading',{name:'No hay publicaciones con estos filtros',exact:true})).toBeVisible();
        await target.fill(campaignName);
        await expect(p.getByText(campaignName,{exact:true})).toBeVisible();
        await expect(p.getByRole('region',{name:'Buscar y filtrar publicaciones'})).toContainText('1 registro');
      }},
      {id:'advertising.read-meta-inventory',search:'inventario Meta',href:`${campaignView}&source=meta`,target:p=>p.getByRole('heading',{name:'Campañas consultadas en Meta',exact:true}),native:async p=>{
        const region=p.getByRole('region',{name:'Campañas consultadas en Meta',exact:true});
        await expect(region).toContainText('No se consulta a Meta al abrir esta vista.');
        await expect(region.getByRole('combobox',{name:'Conexión de origen'})).toBeVisible();
        await expect(region.getByRole('combobox',{name:'Cuenta publicitaria'})).toBeVisible();
        await expect(region.getByText(/^\d+ campañas?$/)).toBeVisible();
      }},
      {id:'advertising.list-assets',search:'biblioteca de imágenes y videos',href:'/admin?section=advertising&tab=assets',target:p=>p.getByRole('textbox',{name:'Buscar imagen o video'}),native:async(p,target)=>{
        await target.fill(`Sin archivo sintético ${code}`);
        await expect(p.getByRole('region',{name:'Imágenes y videos guardados'})).toContainText('0 archivos');
        await expect(p.getByRole('heading',{name:'No hay imágenes o videos con estos filtros',exact:true})).toBeVisible();
      }},
      {id:'advertising.read-results',search:'actualizar vista de resultados',href:`/admin?section=advertising&tab=results&record=${campaign.id}`,startAtDestination:true,target:p=>p.getByRole('button',{name:'Actualizar vista',exact:true}),native:async(p,target)=>{
        await expect(p.getByText(/Sin entregas; aún no hay rendimiento que analizar/)).toBeVisible();
        const response=p.waitForResponse(res=>{
          const url=new URL(res.url());
          return res.request().method()==='GET'&&url.pathname==='/api/admin/social/results'&&url.searchParams.get('campaignId')===campaign.id;
        });
        await target.click();
        const saved=await response;
        expect(saved.ok()).toBe(true);
        const result=await saved.json();
        expect(result.deliveries).toEqual([]);
        expect(result.measurements).toEqual([]);
        await expect(p.getByRole('button',{name:'Actualizar desde Meta',exact:true})).toHaveCount(0);
      }},
      {id:'advertising.filter-results',search:'desglose de resultados',href:`/admin?section=advertising&tab=results&record=${campaign.id}`,startAtDestination:true,target:p=>p.getByRole('combobox',{name:'Origen de los datos',exact:true}),native:async(p,target)=>{
        const summary=p.getByText('Más filtros de resultados',{exact:true});
        if(await summary.locator('..').getAttribute('open')===null) await summary.click();
        await expect(target).toHaveValue('');
        const response=p.waitForResponse(res=>{
          const url=new URL(res.url());
          return res.request().method()==='GET'&&url.pathname==='/api/admin/social/results'&&url.searchParams.get('campaignId')===campaign.id&&url.searchParams.get('integrationMethod')==='browser';
        });
        await target.selectOption('browser');
        const saved=await response;
        expect(saved.ok()).toBe(true);
        expect((await saved.json()).measurements).toEqual([]);
        await expect(p).toHaveURL(url=>url.searchParams.get('integrationMethod')==='browser'&&url.searchParams.get('record')===campaign.id);
        await expect(p.getByRole('button',{name:'Quitar filtro: Origen de los datos: Acceso asistido por navegador'})).toBeVisible();
      }},
      {id:'advertising.open-studio',search:'abrir chat creativo',href:`${campaignView}&record=new`,target:p=>p.getByRole('heading',{name:'Estudio visual',exact:true}),native:async p=>{
        await expect(p.getByRole('region',{name:'Estudio visual',exact:true})).toBeVisible();
        await expect(p.getByRole('button',{name:'Volver a publicaciones',exact:true})).toBeVisible();
      }},
    ];
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if (req.method()!=='GET'&&/^\/api\/admin\/(?:reports|social|business\/shipments)(?:\/|$)/.test(path)) writes.push(path);
    });
    for (const fixture of cases) {
      const target=fixture.target(page);
      await page.goto(fixture.href);
      await fixture.prepare?.(page);
      await fixture.native(page,target);
      const mobileWidthCheck=info.project.name==='mobile'&&fixture.id==='shipments.filter-status';
      for (const via of mobileWidthCheck?['chat','directory','chat-390']:['chat','directory']) {
        if (via==='chat-390') await page.setViewportSize({width:390,height:844});
        await page.goto(fixture.startAtDestination?fixture.href:'/admin');
        await fixture.prepare?.(page);
        let source;
        if (via!=='directory') {
          source=await openAli(page);
          await askAli(source,`¿Dónde está ${fixture.search}?`);
        } else {
          const launcher=fixture.startAtDestination?await openAli(page):page;
          await launcher.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click({timeout:7000});
          source=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await source.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.search);
          await source.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await source.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        const expected=new URL(fixture.href,info.project.use.baseURL);
        await expect(page).toHaveURL(url=>url.pathname===expected.pathname&&[...expected.searchParams].every(([key,value])=>url.searchParams.get(key)===value));
        await expect(target).toBeFocused();
        if (via==='directory'&&fixture.id==='reports.filter-by-product') {
          await expect(target).toBeInViewport({ratio:0.9});
          await screenshot(page,info,'advisor-c6-filtro-informe');
        }
        if (via==='directory'&&fixture.id==='shipments.filter-status') {
          await expect(target).toBeInViewport({ratio:0.9});
          await screenshot(page,info,'advisor-c6-filtro-envios');
        }
        if (via==='chat-390') {
          await expect(target).toBeInViewport({ratio:0.9});
          await expect(target).toHaveValue('');
          await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          await screenshot(page,info,'advisor-c6-filtro-envios-390');
        }
        await fixture.native(page,target);
        if (via==='chat-390') await page.setViewportSize({width:320,height:740});
      }
    }
    expect(writes).toEqual([]);
    expect((await getSocialCampaign(store,campaign.id)).version).toBe(campaign.version);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: recupera una lectura fallida, explica el requisito y no conserva acceso al vencer', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  const endpoint = '**/api/admin/assistant/recommendations';
  try {
    await page.route(endpoint, route => route.fulfill({ status:503, json:{error:'Fuente no disponible'} }));
    await page.goto('/admin');
    const recommendations = page.getByTestId('advisor-recommendation-list');
    await expect(recommendations.getByRole('alert')).toHaveText('No pude consultar las recomendaciones. No se cambió ningún dato.');
    await page.unroute(endpoint);
    const recovered = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/recommendations') && response.ok());
    await recommendations.getByRole('button', { name:'Volver a consultar' }).click();
    await recovered;
    await expect(recommendations.getByRole('alert')).toHaveCount(0);
    const owner = await fixtureActor(context, store), title = `Fuente retirada C6 ${randomUUID().slice(0,7)}`;
    const seeded = await seedAdvisorAlert(store, { title, actorId:owner, now:new Date().toISOString() });
    await page.reload();
    await recommendations.getByRole('listitem').filter({hasText:title}).getByRole('button', {name:'Hacer seguimiento'}).click();
    const task = page.getByRole('dialog', {name:'Seguimiento de una recomendación'});
    await expect(task.getByRole('heading', {name:'Sigue pendiente',exact:true})).toBeVisible();
    await stockEpisode(store, seeded.product, owner, new Date().toISOString(), 1000);
    await store.db.run(`DELETE FROM ${store.t('alerts')} WHERE id=?`, [seeded.alert.id]);
    await task.getByRole('button', {name:'Retomar',exact:true}).click();
    await expect(task.getByRole('heading', {name:'Aún no es comparable',exact:true})).toBeVisible();
    await expect(task).toContainText('No se encuentra el mismo episodio');
    await expect(task.getByRole('button', {name:'Abrir el registro de la alerta'})).toHaveCount(0);
    await screenshot(page, info, 'advisor-c6-fuente-retirada');
    await task.getByRole('button', {name:'Ahora no',exact:true}).click();
    const operations = [];
    page.on('request', req => { if (req.url().includes('/shipping/heka') && req.method() !== 'GET') operations.push(req.url()); });
    await page.getByRole('button', { name:'¿Qué quieres hacer?', exact:true }).click();
    const directory = page.getByRole('dialog', { name:'¿Qué quieres hacer?' });
    await directory.getByRole('searchbox').fill('cotizar flete');
    await directory.getByRole('button', { name:'Buscar', exact:true }).click();
    const quote = directory.locator('[data-capability-id="heka.quote-shipment"]');
    await expect(quote).toContainText('conexión válidos');
    await quote.getByRole('button', { name:/^Abrir en el panel:/ }).click();
    await expect(directory.getByRole('alert')).toContainText('El control no se abrió', { timeout:8000 });
    await expect(directory.getByRole('searchbox')).toHaveValue('cotizar flete');
    expect(operations).toEqual([]);
    await screenshot(page, info, 'advisor-c6-requisito');
    await directory.getByRole('button', { name:'Cerrar directorio' }).click();
    await page.goto('/admin?section=business&tab=assistant');
    await page.locator('input[name=enabled]').uncheck();
    const disabled = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method()==='PUT');
    await page.getByRole('button', { name:'Guardar configuración', exact:true }).click();
    expect((await disabled).ok()).toBe(true);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name:'Tu negocio', exact:true })).toBeVisible();
    await expect(recommendations).toContainText('Las recomendaciones no están disponibles mientras Ali no esté listo.');
    const chat = await openAli(page);
    await expect(chat.getByLabel('Mensaje para Ali')).toBeDisabled();
    const token = (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE).value;
    await store.db.run(`UPDATE ${store.t('sessions')} SET expires=? WHERE token_hash=?`, [Date.now()-1000,createHash('sha256').update(token).digest('hex')]);
    for (const path of ['/api/admin/assistant/actions','/api/admin/assistant/preferences','/api/admin/assistant/inbox?summary=1']) {
      expect((await page.request.get(path)).status()).toBe(401);
    }
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: descarta una respuesta tardía después de cambiar la configuración', async ({ page, browser, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  const peer = await browser.newContext({baseURL:info.project.use.baseURL,ignoreHTTPSErrors:true});
  const { id:gate } = await control(request, {action:'hold',model:'fixture-a'});
  try {
    const owner = await fixtureActor(context, store), email = 'advisor-c2-b@example.test';
    if (!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email])) await createAdmin(store, email, 'advisor-c2-only-synthetic');
    const other = await peer.newPage();
    await loginAdvisorPeer(other);
    await other.goto('/admin?section=business&tab=assistant');
    await page.goto('/admin');
    const chat = await openAli(page);
    const message = '¿Dónde está preparar nuevo acceso?';
    const started = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/turns') && response.status()===202);
    await askAli(chat, message);
    await control(request, {action:'wait',id:gate});
    const {turnId} = await (await started).json();
    const turn = await store.db.get(`SELECT id,state,configuration_version FROM ${store.t('assistant_turns')} WHERE id=? AND user_id=?`, [turnId,owner]);
    expect(turn?.state).toBe('running');
    await other.locator('input[name=model]').fill('fixture-b');
    const changed = other.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method()==='PUT');
    await other.getByRole('button', {name:'Guardar y verificar',exact:true}).click();
    const saved = await changed;
    expect(saved.ok()).toBe(true);
    expect((await saved.json()).version).toBeGreaterThan(turn.configuration_version);
    const late = page.waitForResponse(response => response.url().endsWith(`/turns/${turn.id}/advance`));
    await control(request, {action:'release',id:gate});
    expect((await late).status()).toBe(409);
    const cancelled = await store.db.get(`SELECT state,data FROM ${store.t('assistant_turns')} WHERE id=?`, [turn.id]);
    expect(cancelled.state).toBe('cancelled');
    expect(JSON.parse(cancelled.data).cancellation.reason).toBe('configuration_changed');
    expect(await store.db.get(`SELECT id FROM ${store.t('assistant_proposals')} WHERE turn_id=?`, [turn.id])).toBeNull();
    await expect(chat.locator('[data-capability-id="business.user-prepare"]')).toHaveCount(0);
    await page.reload();
    const restarted = await openAli(page);
    await askAli(restarted, message);
    await expect(restarted.locator('[data-capability-id="business.user-prepare"]')).toBeVisible();
  } finally {
    await control(request, {action:'release',id:gate});
    await peer.close();
    await store.close();
  }
});

test('Ali @advisor-c6: la descarga conserva consulta o revisión y no crea otra copia', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page, request);
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store);
    const anchor = info.project.name === 'mobile' ? '2022-04-01' : '2022-03-01';
    const query = {period:'month', anchorDate:anchor, filters:{carrier:'Transportadora de exportación sintética'}};
    const snapshot = await generateReportSnapshot(store, query, actorId);
    const jobs = () => store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key=?`, [`report:${snapshot.queryKey}`]);
    const rows = () => store.db.all(`SELECT id,version FROM ${store.t('report_snapshots')} WHERE query_key=?`, [snapshot.queryKey]);
    const before = await rows();
    const xlsx = createRequire(import.meta.url)('xlsx');
    const control = page.getByRole('button', {name:'Descargar Excel', exact:true});
    const readDelivered = async () => {
      const pending = page.waitForEvent('download');
      await control.click();
      const file = await pending;
      expect(await file.failure()).toBeNull();
      expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
      const book = xlsx.read(await readFile(await file.path()), {type:'buffer'});
      expect(book.SheetNames).toEqual(['Resumen','Detalle','Definiciones']);
      return xlsx.utils.sheet_to_json(book.Sheets.Definiciones, {header:1});
    };
    const live = `/admin?${new URLSearchParams({section:'reports',tab:'sales',period:'month',anchor,carrier:query.filters.carrier})}`;
    const saved = `/admin?section=reports&tab=sales&mode=saved&record=${snapshot.snapshot.id}`;
    for (const [id, search, href] of [
      ['reports.export-live','exportar informe actual',live],
      ['reports.export-snapshot','exportar copia de informe',saved],
    ]) {
      await page.goto(href);
      const official = await readDelivered();
      const chat = await openAli(page);
      await askAli(chat, `¿Dónde está ${search}?`);
      let downloaded = false;
      const unexpected = () => { downloaded = true; };
      page.on('download', unexpected);
      await chat.locator(`[data-capability-id="${id}"]`).getByRole('button', {name:/^Abrir en el panel:/}).click();
      await expect(control).toBeFocused();
      expect(downloaded).toBe(false);
      page.off('download', unexpected);
      const expected = new URL(href, info.project.use.baseURL);
      await expect(page).toHaveURL(url => [...expected.searchParams].every(([key,value]) => url.searchParams.get(key) === value));
      const received = await readDelivered();
      const identity = data => data.filter(row => ['period','snapshot'].includes(row[0]));
      expect(identity(received)).toEqual(identity(official));
      expect(received.find(row => row[0]==='period')[3]).toContain(anchor);
      if (id==='reports.export-snapshot') expect(received.find(row => row[0]==='snapshot')[2]).toBe(snapshot.snapshot.id);
    }
    expect(await rows()).toEqual(before);
    expect(await jobs()).toBeNull();
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: contrasta Caja archivada, movimientos y gastos pendientes', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if (info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try {
    const actorId=await fixtureActor(context,store), suffix=randomUUID().slice(0,7), day=bogotaDate();
    const responsible=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable Caja ${suffix}`},actorId);
    const active=await saveAccount(store,{requestId:randomUUID(),name:`Caja activa ${suffix}`,type:'cash',openingOn:day,openingBalanceMinor:9300000,responsibleId:responsible.id},actorId);
    const archived=await saveAccount(store,{requestId:randomUUID(),name:`Banco histórico ${suffix}`,type:'bank',openingOn:day,openingBalanceMinor:12700000,responsibleId:responsible.id},actorId);
    await saveAccount(store,{requestId:randomUUID(),version:archived.version,active:false},actorId,archived.id);
    const movementRef=`APORTE-${suffix}`;
    const movement=await recordIncome(store,{requestId:randomUUID(),accountId:active.id,amountMinor:2130000,effectiveOn:day,concept:'owner_funding',reference:movementRef},actorId);
    const adName=`Gasto publicidad ${suffix}`, opsName=`Gasto operación ${suffix}`;
    const expense=await recordExpense(store,{requestId:randomUUID(),personId:responsible.id,category:'advertising',concept:adName,amountMinor:3270000,incurredOn:day},actorId);
    await recordExpense(store,{requestId:randomUUID(),category:'operating',concept:opsName,amountMinor:5190000,incurredOn:day},actorId);
    const otherResponsibleCategory=`Gasto operativo del responsable ${suffix}`;
    await recordExpense(store,{requestId:randomUUID(),personId:responsible.id,category:'operating',concept:otherResponsibleCategory,amountMinor:2910000,incurredOn:day},actorId);
    const closingAccount=await saveAccount(store,{requestId:randomUUID(),name:`Caja con cierre ${suffix}`,type:'cash',openingOn:day,openingBalanceMinor:9300000,responsibleId:responsible.id},actorId);
    const closing=await closeCash(store,{requestId:randomUUID(),accountId:closingAccount.id,closingOn:day,countedMinor:9000000},actorId);

    const overview='/admin?section=cash&tab=overview', movements='/admin?section=cash&tab=movements', expenses='/admin?section=cash&tab=expenses';
    const movementRow=p=>p.getByRole('region',{name:'Movimientos',exact:true}).getByRole('article').filter({hasText:movementRef});
    const expenseRow=(p,name)=>p.getByRole('region',{name:'Gastos y pagos',exact:true}).getByRole('article').filter({has:p.getByRole('heading',{name,exact:true})});
    async function reveal(p) {
      const filters=p.locator('summary').filter({hasText:/^Filtros(?: \(\d+ activos\))?$/});
      const disclosure=filters.locator('..');
      if (await disclosure.getAttribute('open')===null) await filters.click();
    }
    function selectScope(p, key, target, value) {
      return target.selectOption(value).then(()=>expect(p).toHaveURL(url=>url.searchParams.get(key)===value));
    }
    const cases=[
      {id:'cash.view-guide',search:'guía de caja',href:overview,target:p=>p.getByText('Guía de caja',{exact:true}),native:async(p,target)=>{
        await target.click();
        await expect(p.getByRole('region',{name:'Glosario de caja'})).toContainText('Obligación generada aunque no se haya pagado.');
      }},
      {id:'cash.view-archived-accounts',search:'cuentas archivadas',href:overview,target:p=>p.getByText('Cuentas archivadas',{exact:true}),native:async(p,target)=>{
        await target.click();
        const card=p.getByRole('region',{name:'Cuentas',exact:true}).getByRole('article').filter({has:p.getByRole('heading',{name:archived.name,exact:true})});
        await expect(card.getByText('Archivada · Banco',{exact:true})).toBeVisible();
        await expect(card.getByText(/127[.,]000/)).toBeVisible();
        await expect(card.getByText('El total registrado incluye el saldo de esta cuenta archivada.',{exact:true})).toBeVisible();
      }},
      {id:'cash.view-movements',search:'movimientos del período',href:movements,target:p=>p.getByRole('region',{name:'Movimientos',exact:true}),native:async p=>{
        await p.getByRole('textbox',{name:'Buscar',exact:true}).fill(movementRef);
        await expect(p).toHaveURL(url=>url.searchParams.get('q')===movementRef);
        await expect(movementRow(p)).toContainText(active.name);
        await expect(movementRow(p)).toContainText(day);
        await expect(movementRow(p)).toContainText(/Entrada \+\s*\$\s*21[.,]300/);
      }},
      {id:'cash.view-account-movements',search:'filtrar movimientos por cuenta',href:movements,target:p=>p.getByRole('combobox',{name:'Cuenta',exact:true}),native:async(p,target)=>{
        await reveal(p);
        await selectScope(p,'account',target,archived.id);
        await expect(p.getByRole('region',{name:'Movimientos',exact:true})).toContainText(archived.name);
        await expect(movementRow(p)).toHaveCount(0);
        await selectScope(p,'account',target,active.id);
        await expect(movementRow(p)).toBeVisible();
      }},
      {id:'cash.view-expenses',search:'gastos pendientes',href:expenses,target:p=>p.getByRole('region',{name:'Gastos y pagos',exact:true}),native:async p=>{
        await expect(expenseRow(p,adName)).toContainText(/Importe .*32[.,]700 · Pagado .*0 · Pendiente .*32[.,]700/);
      }},
      {id:'cash.filter-expense-category',search:'solo gastos de publicidad',href:expenses,target:p=>p.getByRole('combobox',{name:'Categoría',exact:true}),native:async(p,target)=>{
        await reveal(p);
        await selectScope(p,'category',target,'advertising');
        await expect(expenseRow(p,adName)).toBeVisible();
        await expect(expenseRow(p,opsName)).toHaveCount(0);
      }},
      {id:'cash.filter-expense-person',search:'filtrar gastos por responsable',href:expenses,target:p=>p.getByRole('combobox',{name:'Persona responsable',exact:true}),native:async(p,target)=>{
        await reveal(p);
        await selectScope(p,'seller',target,responsible.id);
        await expect(expenseRow(p,adName)).toContainText(responsible.name);
        await expect(expenseRow(p,opsName)).toHaveCount(0);
      }},
      {id:'cash.view-account',search:'detalle de cuenta bancaria',href:`${overview}&account=${archived.id}&record=${archived.id}`,context:true,target:p=>p.locator('.cash-detail').getByRole('heading',{name:archived.name,exact:true}),native:async(p,target)=>{
        const detail=target.locator('../..');
        await expect(detail).toContainText('Cuenta archivada: consulta su historia');
        await expect(detail).toContainText(/127[.,]000/);
        await expect(detail).toContainText(day);
        await expect(detail).toContainText('Saldo mínimoSin dato');
      }},
      {id:'cash.view-closings',search:'historial de arqueos',href:`${overview}&account=${active.id}&record=${active.id}`,context:true,target:p=>p.getByRole('heading',{name:'Cierres históricos',exact:true}),native:async p=>{
        await expect(p.getByText('No hay cierres registrados para esta cuenta.',{exact:true})).toBeVisible();
      }},
      {id:'cash.view-movement-detail',search:'referencia de movimiento',href:`${movements}&account=${active.id}&record=${movement.id}`,context:true,target:p=>p.getByRole('heading',{name:/^Detalle · Aporte/}),native:async(p,target)=>{
        const detail=target.locator('../..');
        await expect(detail.getByText(new RegExp(`${day} · ${movementRef}`))).toBeVisible();
        await expect(detail).toContainText(/21[.,]300/);
      }},
      {id:'cash.view-expense-detail',search:'detalle de gasto',href:`${expenses}&record=${expense.id}`,context:true,target:p=>p.getByRole('heading',{name:`Detalle · ${adName}`,exact:true}),native:async(p,target)=>{
        const detail=target.locator('../..');
        await expect(detail).toContainText(/Pendiente\s*\$\s*32[.,]700/);
        await expect(detail).toContainText(/Pagado\s*\$\s*0/);
      }},
      {id:'cash.search-records',search:'buscar gasto por concepto',href:expenses,context:true,target:p=>p.getByRole('textbox',{name:'Buscar',exact:true}),native:async(p,target)=>{
        await target.fill(adName);
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='expenses'&&url.searchParams.get('q')===adName);
        await expect(expenseRow(p,adName)).toBeVisible();
        await expect(expenseRow(p,opsName)).toHaveCount(0);
      }},
      {id:'cash.filter-by-period',search:'otro mes de caja',href:expenses,context:true,target:p=>p.getByRole('combobox',{name:'Frecuencia',exact:true}),native:async(p,target)=>{
        await target.selectOption('day');
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='expenses'&&url.searchParams.get('period')==='day');
        await expect(expenseRow(p,adName)).toBeVisible();
        await p.getByRole('button',{name:'Período anterior',exact:true}).click();
        await expect(p).toHaveURL(url=>url.searchParams.get('anchor')!==day);
        await expect(expenseRow(p,adName)).toHaveCount(0);
      }},
      {id:'cash.view-closing-detail',search:'ver cierre',href:`${overview}&account=${closingAccount.id}&record=${closing.id}`,context:true,target:p=>p.getByRole('heading',{name:`Cierre del ${day}`,exact:true}),native:async(p,target)=>{
        const detail=target.locator('../..');
        await expect(detail).toContainText(/Esperado\s*\$\s*93[.,]000/);
        await expect(detail).toContainText(/Contado\s*\$\s*90[.,]000/);
        await expect(detail).toContainText(/Faltante de \$\s*3[.,]000/);
        await expect(detail).toContainText('Revisión 1 · Cerrado');
      }},
      {id:'cash.clear-filters',search:'limpiar filtros de caja',href:`${expenses}&category=advertising&seller=${responsible.id}`,context:true,target:p=>p.getByRole('button',{name:'Limpiar filtros',exact:true}),native:async(p,target)=>{
        await expect(expenseRow(p,adName)).toBeVisible();
        await expect(expenseRow(p,opsName)).toHaveCount(0);
        await target.click();
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='expenses'&&!url.searchParams.has('category')&&!url.searchParams.has('seller'));
        await expect(expenseRow(p,opsName)).toBeVisible();
      }},
      {id:'cash.remove-filter',search:'borrar un filtro de caja',href:`${expenses}&period=month&anchor=${day}&category=advertising&seller=${responsible.id}`,context:true,target:p=>p.getByRole('group',{name:'Filtros activos',exact:true}),native:async(p,target)=>{
        await expect(expenseRow(p,adName)).toBeVisible();
        await expect(expenseRow(p,opsName)).toHaveCount(0);
        await target.getByRole('button',{name:/^Quitar filtro: Categoría:/}).click();
        await expect(p).toHaveURL(url=>url.searchParams.get('tab')==='expenses'&&url.searchParams.get('period')==='month'&&url.searchParams.get('anchor')===day&&!url.searchParams.has('category')&&url.searchParams.get('seller')===responsible.id);
        await expect(expenseRow(p,adName)).toBeVisible();
        await expect(expenseRow(p,opsName)).toHaveCount(0);
        await expect(expenseRow(p,otherResponsibleCategory)).toBeVisible();
        await expect(target.getByRole('button',{name:/^Quitar filtro: Persona responsable:/})).toBeVisible();
      }},
    ];
    const writes=[];
    page.on('request',r=>{if(r.method()!=='GET'&&/\/api\/admin\/(?:finance|business)\//.test(r.url()))writes.push(r.url());});
    for(const fixture of cases) await test.step(fixture.id,async()=>{
      const target=fixture.target(page);
      await page.goto(fixture.href);
      await fixture.native(page,target);
      for(const via of ['conversación','directorio']) {
        await page.goto(fixture.context?fixture.href:'/admin');
        let entry;
        if(via==='conversación') {
          entry=await openAli(page);
          await askAli(entry,`¿Dónde está ${fixture.search}?`);
        } else {
          const launcher=fixture.context?await openAli(page):page;
          await launcher.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.search);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(target).toBeFocused();
        if (via==='directorio'&&fixture.id==='cash.filter-expense-person') {
          await expect(target).toBeInViewport({ratio:0.9});
          await screenshot(page,info,'advisor-c6-filtro-caja');
        }
        await fixture.native(page,target);
      }
    });
    expect(writes).toEqual([]);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: contrasta historial, origen y archivo local de importación', async ({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try {
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Origen Excel ${code}`},actorId);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const batch=await prepareAdvisorImportBatch(store,{sourceId:source.id,actorId});
    const otherFile=`previo-${code}.xlsx`;
    const otherId=await seedAdvisorImport(store,{label:otherFile,actorId,now:new Date().toISOString(),state:'completed_with_errors'});
    const other=await getImportBatch(store,otherId);
    const history='/admin?section=orders&tab=imports', draft=`${history}&batch=new`, saved=`${history}&batch=${batch.id}`;
    const list=p=>p.getByRole('region',{name:'Importaciones',exact:true});
    const card=(p,name)=>list(p).getByRole('article').filter({has:p.getByRole('heading',{name,exact:true})});
    const wizard=p=>p.getByRole('region',{name:'Importar Excel',exact:true});
    const save=p=>wizard(p).getByRole('button',{name:'Guardar archivo y continuar',exact:true});
    const workbook=advisorImportWorkbook();
    const xlsx=createRequire(import.meta.url)('xlsx');
    const rows=(book,name)=>xlsx.utils.sheet_to_json(book.Sheets[name],{header:1});
    async function downloaded(p,target,name,href) {
      const pending=p.waitForEvent('download',{timeout:8000});
      const response=p.waitForResponse(res=>new URL(res.url()).pathname===href&&res.request().method()==='GET');
      await target.click();
      expect((await response).ok()).toBe(true);
      const download=await pending;
      expect(download.suggestedFilename()).toBe(name);
      return readFile(await download.path());
    }
    function savedDownload(id,query,label,kind,filename,check) {
      return {id,query,href:saved,target:p=>wizard(p).getByRole('button',{name:label,exact:true}),check:async(p,target)=>{
        await check(await downloaded(p,target,filename,`/api/admin/imports/${batch.id}/${kind}`));
      }};
    }
    const fixtures=[
      {id:'imports.list',query:'importaciones anteriores',href:history,target:p=>list(p).getByRole('heading',{name:'Importaciones',exact:true}),check:async p=>{
        await expect(card(p,batch.filename).filter({hasText:platform.name})).toContainText('Por revisar');
        await expect(card(p,otherFile)).toContainText('Importación parcial: quedan pendientes');
      }},
      {id:'imports.filter-history',query:'lotes de una cuenta',href:history,target:p=>list(p).getByRole('combobox',{name:'Origen',exact:true}),check:async(p,target)=>{
        await expect(target).toHaveValue('');
        await target.selectOption(source.id);
        await expect(p).toHaveURL(url=>url.searchParams.get('source')===source.id);
        await expect(list(p)).toHaveAttribute('aria-busy','false');
        await expect(card(p,batch.filename).filter({hasText:platform.name})).toBeVisible();
        await expect(card(p,otherFile)).toHaveCount(0);
        const status=list(p).getByRole('combobox',{name:'Estado',exact:true});
        await status.selectOption('completed_with_errors');
        await expect(list(p).getByRole('heading',{name:'No hay importaciones con estos filtros'})).toBeVisible();
        await status.selectOption('review');
        await expect(card(p,batch.filename).filter({hasText:platform.name})).toBeVisible();
      }},
      {id:'imports.start-batch',query:'nueva importación',href:draft,target:p=>wizard(p).getByRole('heading',{name:'Elige el archivo y su origen',exact:true}),check:async p=>{
        await expect(wizard(p).getByText(/Guardar el original no incorpora pedidos ni gastos/)).toBeVisible();
        await expect(wizard(p).getByRole('button',{name:'2. Hojas y columnas'})).toBeDisabled();
        await expect(save(p)).toBeDisabled();
      }},
      {id:'imports.select-origin',query:'cuenta principal de importación',href:draft,target:p=>wizard(p).getByRole('combobox',{name:'Origen',exact:true}),check:async(p,target)=>{
        await expect(target).toHaveValue('');
        await target.selectOption(platform.id);
        await expect(wizard(p).getByText('Principal',{exact:true}).filter({visible:true})).toHaveCount(1);
        await expect(wizard(p).getByText(/No es una cuenta bancaria/)).toBeVisible();
        await expect(save(p)).toBeDisabled();
      }},
      {id:'imports.select-file',query:'seleccionar archivo local',href:draft,target:p=>wizard(p).getByLabel('Archivo Excel',{exact:true}),check:async(p,target)=>{
        const name=`local-${code}.xlsx`;
        await target.setInputFiles({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(workbook.bytes)});
        await expect(wizard(p).getByRole('region',{name:'Archivo privado'})).toContainText(`${name} ·`);
        await expect(wizard(p).getByText(/listo para guardar/)).toBeVisible();
        await expect(save(p)).toBeDisabled();
      }},
      {id:'imports.download-template',query:'plantilla para importar',href:draft,target:p=>wizard(p).getByRole('button',{name:'Descargar plantilla',exact:true}),check:async(p,target)=>{
        const bytes=await downloaded(p,target,'plantilla-negocio.xlsx','/api/admin/imports/template');
        const template=xlsx.read(bytes);
        expect(rows(template,'GASTOS OPERACION')).toHaveLength(1);
        expect(rows(template,'INSTRUCCIONES').length).toBeGreaterThan(1);
      }},
      {id:'imports.open-batch',query:'actualizar estado del lote',href:saved,target:p=>wizard(p).getByRole('heading',{name:'Importar Excel',exact:true}),check:async(p,target)=>{
        await expect(target.locator('..')).toContainText(`${batch.filename} · Versión ${batch.version}`);
        await expect(wizard(p).getByText('Revisión actualizada',{exact:true})).toBeVisible();
      }},
      savedDownload('imports.download-original','bajar excel original','Descargar original','file',batch.filename,bytes=>{
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(batch.fileHash);
      }),
      savedDownload('imports.download-expanded','agregar hoja gastos operacion','Descargar copia con hoja de gastos de operación','expanded',batch.filename.replace(/\.xlsx$/i,' - con operacion.xlsx'),bytes=>{
        const expanded=xlsx.read(bytes);
        expect(rows(expanded,'Gastos C4')).toEqual(rows(xlsx.read(workbook.bytes),'Gastos C4'));
        expect(rows(expanded,'GASTOS OPERACION')).toHaveLength(1);
      }),
      savedDownload('imports.download-errors','exportar incidencias de excel','Descargar pendientes y errores','errors',`errores-${batch.id}.xlsx`,bytes=>{
        const exported=xlsx.read(bytes);
        expect(rows(exported,'Origen')[1]).toEqual([batch.filename,batch.fileHash,source.id]);
        const [,issue]=rows(exported,'Excepciones');
        expect(issue.slice(0,2)).toEqual(['Gastos C4',3]);
        expect(issue[4]).toMatch(/importe/i);
      }),
      savedDownload('imports.download-prepared','exportar datos preparados','Descargar datos preparados para volver a importar','prepared',`datos-preparados-${batch.id}.xlsx`,bytes=>{
        const prepared=xlsx.read(bytes);
        expect(rows(prepared,'GASTOS')[1]).toContain('Gasto válido C4');
        expect(rows(prepared,'POR COMPLETAR')[1]).toContain(3);
      }),
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:imports|business|orders)(?:\/|$)/.test(new URL(req.url()).pathname)) writes.push(req.method()+' '+new URL(req.url()).pathname);
    });
    for(const fixture of fixtures) await test.step(fixture.id,async()=>{
      const target=fixture.target(page);
      await page.goto(history);
      if(fixture.href===draft) await list(page).getByRole('button',{name:'Nueva importación',exact:true}).first().click();
      if(fixture.href===saved) await card(page,batch.filename).filter({hasText:platform.name}).getByRole('button',{name:'Continuar',exact:true}).click();
      await expect(target).toBeVisible();
      await fixture.check(page,target);
      for(const via of ['chat','directorio']){
        await page.goto(fixture.href===saved?saved:'/admin');
        let entry;
        if(via==='chat'){
          entry=await openAli(page);
          await askAli(entry,`¿Dónde está ${fixture.query}?`);
        }else{
          const launcher=fixture.href===saved?await openAli(page):page;
          await launcher.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(page).toHaveURL(new RegExp(fixture.href.replace('?','\\?')+'$'));
        await expect(target).toBeFocused();
        if(via==='directorio'&&fixture.id==='imports.select-file') await screenshot(page,info,'advisor-c6-archivo-local');
        await fixture.check(page,target);
      }
    });
    expect(writes).toEqual([]);
    expect((await getImportBatch(store,batch.id)).version).toBe(batch.version);
    expect((await getImportBatch(store,otherId)).version).toBe(other.version);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: contrasta fuentes comerciales y confirma sus cambios solo en Configuración',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), path='/admin?section=business&tab=platforms';
    const save=(resource,input,id)=>saveResource(store,resource,{requestId:randomUUID(),...input},actorId,id);
    let platform=await save('platforms',{name:`Marketplace ${code}`});
    const archived=await save('platforms',{name:`Mayorista histórico ${code}`,active:false});
    let source=await save('sources',{name:`Cuenta histórica ${code}`,platformId:platform.id,active:false});
    const name=`Perfil privado ${code}`, config=advisorImportWorkbook().config;
    const first=await save('profiles',{sourceId:source.id,name,profile:config});
    const profile=await save('profiles',{version:first.version,name,profile:config},first.id);
    const startingAccounts=(await listResources(store,'accounts')).map(row=>row.id).sort();
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:business|imports|finance)(?:\/|$)/.test(new URL(req.url()).pathname)) writes.push(req.url());
    });
    const dialog=()=>page.getByRole('dialog',{name:/^(?:Crear plataforma|Editar plataforma|Crear otra cuenta de plataforma|Editar cuenta de plataforma)$/});
    const target=label=>page.getByRole('combobox',{name:label,exact:true});
    async function saveAndReplay(button,resource,kind,id){
      const endpoint=`/api/admin/business/${resource}${id?`/${id}`:''}`;
      const response=page.waitForResponse(res=>res.request().method()===kind&&new URL(res.url()).pathname===endpoint);
      const before=writes.length;
      await dialog().getByRole('button',{name:button,exact:true}).click();
      const result=await response;
      expect(result.status()).toBe(id?200:201);
      const persisted=await result.json();
      await expect(dialog()).toHaveCount(0);
      expect(writes).toHaveLength(before+1);
      const req=result.request();
      const replay=await context.request.fetch(result.url(),{method:kind,data:req.postDataJSON(),headers:{
        origin:await req.headerValue('origin'),
        'x-csrf-token':await req.headerValue('x-csrf-token'),
      }});
      expect(replay.status()).toBe(result.status());
      expect(await replay.json()).toEqual(persisted);
      return persisted;
    }
    async function choose(select,id,button){
      await expect(select).toHaveValue('');
      const open=page.getByRole('button',{name:button,exact:true});
      await expect(open).toBeDisabled();
      await select.selectOption(id);
      await open.click();
    }
    const cases=[
      {id:'business.platforms',query:'plataformas de venta',control:()=>page.getByRole('heading',{name:'Plataformas y cuentas de origen',exact:true}),effect:async()=>{
        await expect(page.getByRole('heading',{name:`${archived.name} · Archivada`,exact:true})).toBeVisible();
        const group=page.getByRole('heading',{name:`${platform.name} · Activa`,exact:true}).locator('../..');
        await expect(group.getByRole('heading',{name:'Principal · Activa',exact:true})).toBeVisible();
        await expect(group.getByRole('heading',{name:`${source.name} · Archivada`,exact:true})).toBeVisible();
        await expect(group.getByText(`${profile.name} · versión 2`,{exact:true})).toBeVisible();
        await expect(page.getByText(/no una transportadora ni una cuenta de caja/i)).toBeVisible();
      }},
      {id:'business.platform-create',query:'crear plataforma comercial',control:()=>page.getByRole('button',{name:'Crear plataforma',exact:true}),effect:async(control,via)=>{
        await control.click();
        const name=dialog().getByRole('textbox',{name:'Nombre',exact:true}), value=`Canal C6 ${code} ${via}`;
        await expect(name).toHaveValue('');
        await name.fill(value);
        expect((await listResources(store,'platforms')).some(row=>row.name===value)).toBe(false);
        const result=await saveAndReplay('Crear plataforma','platforms','POST');
        expect(result).toMatchObject({name:value,version:1,active:true});
        expect(await listResources(store,'sources',{platform:result.id})).toEqual([expect.objectContaining({name:'Principal',platformId:result.id})]);
        await expect(page.getByRole('heading',{name:`${value} · Activa`,exact:true})).toBeVisible();
      }},
      {id:'business.platform-edit',query:'editar una plataforma de venta guardada',details:'Editar plataforma',control:()=>target('Plataforma para editar'),effect:async(control,via)=>{
        await choose(control,platform.id,'Abrir editor de plataforma');
        const name=dialog().getByRole('textbox',{name:'Nombre',exact:true}), next=`Marketplace ${code} ${via}`;
        await expect(name).toHaveValue(platform.name);
        await name.fill(next);
        await dialog().getByRole('textbox',{name:'Motivo del cambio'}).fill('Nombre comercial verificado en prueba');
        const result=await saveAndReplay('Guardar plataforma','platforms','PUT',platform.id);
        expect(result).toMatchObject({id:platform.id,name:next,version:platform.version+1});
        platform=result;
      }},
      {id:'business.source-create',query:'crear otra cuenta de plataforma',details:'Crear otra cuenta',control:()=>target('Plataforma de la nueva cuenta'),effect:async(control,via)=>{
        await choose(control,platform.id,'Abrir formulario de cuenta nueva');
        await expect(dialog().getByText(`Plataforma: ${platform.name}.`,{exact:false})).toBeVisible();
        const next=`Cuenta operativa ${code} ${via}`;
        await dialog().getByRole('textbox',{name:'Nombre',exact:true}).fill(next);
        const result=await saveAndReplay('Crear cuenta de plataforma','sources','POST');
        expect(result).toMatchObject({name:next,platformId:platform.id,version:1});
        expect((await listResources(store,'sources',{platform:platform.id})).filter(row=>row.name===next)).toHaveLength(1);
      }},
      {id:'business.source-edit',query:'editar fuente comercial',details:'Editar cuenta de plataforma',control:()=>target('Cuenta de origen para editar'),effect:async(control,via)=>{
        await expect(control.getByRole('option',{name:new RegExp(`${archived.name} · Principal`)})).toHaveCount(1);
        await choose(control,source.id,'Abrir editor de cuenta');
        const name=dialog().getByRole('textbox',{name:'Nombre',exact:true}), next=`Cuenta histórica ${code} ${via}`;
        await expect(name).toHaveValue(source.name);
        await expect(dialog().getByRole('checkbox',{name:'Activo para nuevos registros'})).not.toBeChecked();
        await name.fill(next);
        await dialog().getByRole('textbox',{name:'Motivo del cambio'}).fill('Nombre de la cuenta verificado en prueba');
        const result=await saveAndReplay('Guardar cuenta de plataforma','sources','PUT',source.id);
        expect(result).toMatchObject({id:source.id,platformId:platform.id,name:next,version:source.version+1,active:false});
        source=result;
        expect((await listResources(store,'profiles',{source:source.id}))[0]).toMatchObject({id:profile.id,version:2});
      }},
    ];
    for(const fixture of cases) await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        const before=writes.length;
        await page.goto(via==='panel'?path:'/admin');
        const control=fixture.control();
        if(via==='panel'){
          if(fixture.details) await page.getByText(fixture.details,{exact:true}).click();
        }else{
          let entry;
          if(via==='chat'){
            entry=await openAli(page);
            await askAli(entry,`¿Dónde está ${fixture.query}?`);
          }else{
            await page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.query);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(control).toBeFocused();
        }
        await expect(dialog()).toHaveCount(0);
        expect(writes).toHaveLength(before);
        await fixture.effect(control,via);
      }
    });
    expect((await listResources(store,'accounts')).map(row=>row.id).sort()).toEqual(startingAccounts);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva la ficha elegida para consultar existencias y preparar imágenes',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const save=(kind,title,extra)=>store.save(kind,{...emptyRecord(kind),title:`${title} ${code}`,slug:`e2e-${title.toLowerCase()}-${code}`,status:'draft',...extra},null,null,actorId);
    const product=await save('products','Referencia',{price:21000,presentation:'Tarro de 500 g',stockQuantity:11,orderable:true,image:'/brand/logo.jpg'});
    const combo=await save('combos','Paquete',{price:53000,conditions:'Máximo dos paquetes por pedido',orderable:true,items:[{productId:product.id,quantity:2}]});
    const catalog=await save('catalogs','Colección',{slug:`e2e-catalogo-${code}`,sort:42,description:'Selección privada de prueba'});
    await store.saveOrder(businessOrderInput(product,{placedOn:bogotaDate(),items:[{lineId:randomUUID(),itemId:product.id,kind:'products',quantity:2,unitPriceMinor:2100000,discountMinor:0}]}),actorId);
    const productVersion=(await store.get('products',product.id)).version;
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:products|combos|catalogs|orders|upload)(?:\/|$)/.test(new URL(req.url()).pathname)) writes.push(req.url());
    });
    const editor=()=>page.locator('dialog.editor-drawer').filter({has:page.getByRole('heading',{name:/^Editar (producto|combo|catálogo)$/})});
    const field=name=>editor().locator(`[name="${name}"]`);
    const cases=[
      {id:'products.open-product',query:'detalle de producto',kind:'products',record:product,focus:()=>editor().getByRole('heading',{name:'Editar producto',exact:true}),check:async()=>{
        await expect(field('title')).toHaveValue(product.title);
        await expect(field('presentation')).toHaveValue('Tarro de 500 g');
        await expect(field('price')).toHaveValue('21000');
        await expect(field('status')).toHaveValue('draft');
      }},
      {id:'products.open-combo',query:'ver productos incluidos',kind:'combos',record:combo,focus:()=>editor().getByRole('heading',{name:'Editar combo',exact:true}),check:async()=>{
        await expect(field('title')).toHaveValue(combo.title);
        await expect(field('price')).toHaveValue('53000');
        await expect(field('conditions')).toHaveValue('Máximo dos paquetes por pedido');
        await expect(editor().getByText(`2 × ${product.title}`,{exact:true}).first()).toHaveCount(1);
      }},
      {id:'products.open-catalog',query:'detalle de catálogo',kind:'catalogs',record:catalog,focus:()=>editor().getByRole('heading',{name:'Editar catálogo',exact:true}),check:async()=>{
        await expect(field('title')).toHaveValue(catalog.title);
        await expect(field('sort')).toHaveValue('42');
        await expect(field('description')).toHaveValue('Selección privada de prueba');
      }},
      {id:'products.read-stock',query:'cuántas unidades quedan',kind:'products',record:product,focus:()=>editor().getByRole('heading',{name:'Existencias y reservas',exact:true}),check:async()=>{
        await expect(field('stockQuantity')).toHaveValue('11');
        await expect(editor().getByText(/Reservadas: 2 · Disponibles para nuevos pedidos: 9/)).toBeVisible();
        await expect(editor().getByText(/Registrar existencias no crea compras, gastos ni movimientos de caja/)).toBeVisible();
      }},
      {id:'products.preview-image-url',query:'usar enlace de imagen',kind:'products',record:product,focus:()=>field('image'),check:async(focus)=>{
        await focus.fill('/brand/creatina-vital-force.jpg');
        await editor().getByRole('button',{name:'Ver vista previa',exact:true}).click();
        const preview=editor().getByRole('img',{name:'Vista previa de la fotografía del producto'});
        await expect(preview).toHaveAttribute('src','/brand/creatina-vital-force.jpg');
        await expect.poll(()=>preview.evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
      },discard:true},
      {id:'products.remove-image',query:'limpiar fotografía de producto',kind:'products',record:product,focus:()=>editor().getByRole('button',{name:'Quitar imagen',exact:true}),check:async(focus)=>{
        await focus.click();
        await expect(focus).toHaveCount(0);
        await expect(field('image')).toHaveValue('');
        await expect(editor().getByText('Cambios sin guardar',{exact:true})).toBeVisible();
      },discard:true},
    ];
    for(const fixture of cases) await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(`/admin?section=${fixture.kind}`);
        await page.getByRole('button',{name:`Editar ${fixture.record.title}`,exact:true}).click();
        await expect(editor()).toBeVisible();
        if(via!=='panel'){
          await editor().getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
          let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.query}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.query);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:30000});
          await expect(fixture.focus()).toBeFocused();
          if(via==='directorio'&&fixture.id==='products.read-stock'){
            if(info.project.name==='mobile'){
              const footer=editor().locator('footer');
              for(const width of [390,320]){
                await page.setViewportSize({width,height:740});
                const buttons=footer.getByRole('button');
                const [help,cancel,save]=await Promise.all([0,1,2].map(index=>buttons.nth(index).boundingBox()));
                expect(help.height).toBeGreaterThanOrEqual(44);
                expect(help.y+help.height/2).toBeCloseTo(cancel.y+cancel.height/2,0);
                expect(cancel.x+cancel.width).toBeLessThan(save.x);
                expect(save.x+save.width).toBeLessThanOrEqual(width);
                await screenshot(page,info,`advisor-c6-existencias-${width}`);
              }
            }else await screenshot(page,info,'advisor-c6-existencias');
          }
        }
        await fixture.check(fixture.focus());
        if(fixture.discard)page.once('dialog',request=>request.accept());
        await editor().getByRole('button',{name:'Cerrar editor'}).click();
        await expect(editor()).toHaveCount(0);
      }
    });
    expect(writes).toEqual([]);
    expect(await store.get('products',product.id)).toMatchObject({version:productVersion,image:'/brand/logo.jpg'});
    expect((await store.get('combos',combo.id)).version).toBe(combo.version);
    expect((await store.get('catalogs',catalog.id)).version).toBe(catalog.version);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: contrasta liquidaciones y sueldos sin registrar dinero',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), today=bogotaDate(), year=completedFixtureYear();
    const start=`${year}-09-01`, end=`${year}-10-01`, last=`${year}-09-30`;
    const payload=input=>({requestId:randomUUID(),...input});
    const person=await saveResource(store,'people',payload({name:`Operador ${code}`,salaryAgreements:[{id:`salario-${code}`,enabled:true,amountPerPeriodMinor:10000000,frequency:'monthly',effectiveFrom:start,effectiveTo:last,payDayOffset:0}]}),actorId);
    const otherPerson=await saveResource(store,'people',payload({name:`Sin sueldo ${code}`}),actorId);
    const account=await saveAccount(store,payload({name:`Banco ${code}`,type:'bank',openingOn:start,openingBalanceMinor:20000000,responsibleId:person.id}),actorId);
    const platform=await saveResource(store,'platforms',payload({name:`Plataforma ${code}`}),actorId);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const alternate=await saveResource(store,'sources',payload({platformId:platform.id,name:`Cuenta sin liquidaciones ${code}`}),actorId);
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto de recaudo ${code}`,slug:`recaudo-${code}`,price:100000,presentation:'Unidad',status:'draft',orderable:true,stockQuantity:10},null,null,actorId);
    const order=await store.saveOrder(businessOrderInput(product,{placedOn:today,customerName:`Recaudo ${code}`}),actorId);
    const shipment=await createShipment(store,payload({orderId:order.id,platformId:platform.id,sourceId:source.id,carrier:'Operador sintético',tracking:`LIQ-${code}`}),actorId);
    const collection=await recordCollection(store,payload({orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,holder:'platform',amountMinor:11200000,occurredOn:today,method:'Contraentrega',reference:`REC-${code}`}),actorId);
    const freight=await recordExpense(store,payload({category:'shipping_out',concept:`Flete ${code}`,amountMinor:700000,incurredOn:today,shipmentId:shipment.id}),actorId);
    const reference=`SETTLEMENT-${code}`;
    const settlement=await saveSettlement(store,payload({sourceId:source.id,externalKey:reference,reportedOn:today,netMinor:10500000,lines:[{collectionId:collection.id,grossMinor:11200000,deductions:[{expenseId:freight.id,amountMinor:700000}]}]}),actorId);
    await confirmSettlement(store,payload({settlementId:settlement.id,version:settlement.version,receivedOn:today,accountId:account.id,externalKey:`RECEPCION-${code}`,lines:settlement.lines}),actorId);
    const payroll=await confirmPayroll(store,payload({personId:person.id,startOn:start,endOnExclusive:end,bonusMinor:0,discountMinor:0}),actorId);
    await payPayroll(store,payload({payrollId:payroll.id,version:payroll.version,amountMinor:1550000,accountId:account.id,effectiveOn:last}),actorId);
    const settlementView=`/admin?section=cash&tab=settlements&period=month&anchor=${today}`, payrollView=`/admin?section=cash&tab=payroll&period=month&anchor=${start}`;
    const record=id=>page.locator(`[data-cash-record="${id}"]`).locator('..');
    const list=label=>page.getByRole('region',{name:label,exact:true});
    const confirmReceipt=new RegExp(`^Recepción · ${today}$`);
    const settlePath=`${settlementView}&record=${settlement.id}`, payrollPath=`${payrollView}&record=${payroll.id}`;
    async function filter(control,key,negative,positive,id=settlement.id){
      const summary=page.locator('summary').filter({hasText:/^Filtros(?: \(\d+ activos\))?$/});
      if(await summary.locator('..').getAttribute('open')===null)await summary.click();
      await expect(control).toHaveValue('');
      await control.selectOption(negative);
      await expect(page).toHaveURL(url=>url.searchParams.get(key)===negative);
      await expect(record(id)).toHaveCount(0);
      await control.selectOption(positive);
      await expect(page).toHaveURL(url=>url.searchParams.get(key)===positive);
      await expect(record(id)).toBeVisible();
    }
    const cases=[
      {id:'cash.view-settlements',q:'recaudos pendientes de plataforma',href:settlementView,target:()=>list('Liquidaciones'),check:async()=>{
        await expect(record(settlement.id)).toContainText(/Declarado \$\s*105[.,]000 · Recibido \$\s*105[.,]000 · Pendiente \$\s*0/);
        await expect(page.getByText(/pendiente no es disponible/i)).toBeVisible();
      }},
      {id:'cash.view-settlement-detail',q:'retenciones de una liquidación',href:settlePath,record:settlement.id,target:()=>page.getByRole('heading',{name:`Detalle · ${reference}`,exact:true}),check:async target=>{
        const detail=target.locator('../..');
        const receipt=detail.getByRole('heading',{name:confirmReceipt}).locator('../..');
        await expect(receipt).toContainText(/Neto: \$\s*105[.,]000/);
        await expect(receipt).toContainText(/Bruto asignado: \$\s*112[.,]000/);
        await expect(receipt.getByRole('listitem')).toContainText(/\$\s*7[.,]000/);
      }},
      {id:'cash.filter-settlement-source',q:'liquidaciones de un origen',href:settlementView,target:()=>page.getByRole('combobox',{name:'Cuenta de plataforma',exact:true}),check:target=>filter(target,'source',alternate.id,source.id)},
      {id:'cash.filter-settlement-state',q:'buscar liquidaciones confirmadas',href:settlementView,target:()=>page.getByRole('combobox',{name:'Estado',exact:true}),check:target=>filter(target,'status','pending','confirmed')},
      {id:'cash.view-payroll',q:'ver nómina interna',href:payrollView,target:()=>list('Sueldos y anticipos'),check:async()=>{
        await expect(record(payroll.id)).toContainText(person.name);
        await expect(record(payroll.id)).toContainText(`${start} a ${end}`);
        await expect(record(payroll.id)).toContainText(/Devengado\$\s*100[.,]000/);
        await expect(record(payroll.id)).toContainText(/Pendiente\$\s*84[.,]500/);
        await expect(page.getByText(/no nómina legal/)).toBeVisible();
      }},
      {id:'cash.view-payroll-detail',q:'aplicaciones de nómina interna',href:payrollPath,record:payroll.id,target:()=>page.getByRole('heading',{name:`Detalle · ${start}`,exact:true}),check:async target=>{
        const detail=target.locator('../..');
        await expect(detail.getByRole('heading',{name:'Obligaciones registradas',exact:true})).toBeVisible();
        await expect(detail.getByText(new RegExp(`Pago ${last} · \\$\\s*15[.,]500`))).toBeVisible();
      }},
      {id:'cash.filter-payroll-person',q:'buscar sueldo por persona',href:payrollView,target:()=>page.getByRole('combobox',{name:'Persona',exact:true}),check:target=>filter(target,'seller',otherPerson.id,person.id,payroll.id)},
      {id:'cash.filter-payroll-state',q:'sueldos parcialmente pagados',href:payrollView,target:()=>page.getByRole('combobox',{name:'Estado',exact:true}),check:target=>filter(target,'status','paid','partial',payroll.id)},
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:finance|business)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      const target=fixture.target();
      for(const via of ['panel','chat','directorio']){
        const nativeList=via==='panel'&&fixture.record;
        await page.goto(nativeList?fixture.href.split('&record=')[0]:fixture.href);
        if(nativeList)await record(fixture.record).getByRole('button',{name:'Ver detalle',exact:true}).click();
        if(via!=='panel'){
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(target).toBeFocused();
        }
        await fixture.check(target);
      }
    });
    expect(writes).toEqual([]);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva el pedido elegido al consultar acuerdo, cobros y rentabilidad',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), date=bogotaDate();
    const product=await store.save('products',{...emptyRecord('products'),title:`Referencia ${code}`,slug:`pedido-detalle-${code}`,price:23000,unitCostMinor:850000,costEffectiveOn:date,stockQuantity:15,presentation:'Unidad',orderable:true},null,null,actorId);
    const otherProduct=await store.save('products',{...emptyRecord('products'),title:`Sin costo ${code}`,slug:`pedido-sin-costo-${code}`,price:41000,stockQuantity:10,presentation:'Unidad',orderable:true},null,null,actorId);
    const customer=`Comprador ${code}`;
    const other=await store.saveOrder(businessOrderInput(otherProduct,{placedOn:date,customerName:`Otro comprador ${code}`}),actorId);
    const order=await store.saveOrder(businessOrderInput(product,{placedOn:date,customerName:customer}),actorId);
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Origen pedido ${code}`},actorId);
    const shipment=await createShipment(store,{requestId:randomUUID(),orderId:order.id,platformId:platform.id,carrier:'Operador de prueba',tracking:`PEDIDO-${code}`},actorId);
    await recordCollection(store,{requestId:randomUUID(),orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,holder:'platform',amountMinor:950000,occurredOn:date,method:'Contraentrega',reference:`COBRO-${code}`},actorId);
    const saved=await store.order(order.id);
    const number=value=>`AN-${String(value.number).padStart(6,'0')}`;
    const editor=()=>page.locator('dialog.editor-drawer[open]');
    const customerName=()=>editor().locator('input[name=customerName]');
    async function nativeTab(id,label){
      const nav=editor().getByRole('navigation',{name:'Detalle del pedido'});
      if(mobile)await nav.getByRole('combobox',{name:'Detalle del pedido'}).selectOption(id);
      else await nav.getByRole('button',{name:label,exact:true}).click();
    }
    const cases=[
      {id:'orders.open-order',q:'detalle del pedido',target:()=>editor().getByRole('heading',{name:number(order),exact:true}),check:async()=>{
        await expect(customerName()).toHaveValue(customer);
        await expect(editor().getByRole('heading',{name:number(other),exact:true})).toHaveCount(0);
      }},
      {id:'orders.read-agreement',q:'productos acordados',target:()=>editor().getByRole('heading',{name:'2. Productos y valor acordado',exact:true}),check:async()=>{
        await expect(editor().locator('select[name="item-0"]')).toHaveValue(`products:${product.id}`);
        await expect(editor().getByText(/Total acordado\s*\$\s*35[.,]000/)).toBeVisible();
        const imported=editor().getByText('Datos importados del pedido',{exact:true});
        if(await imported.locator('..').getAttribute('open')===null)await imported.click();
        await expect(editor().getByText('No hay datos informativos importados para este registro.',{exact:true})).toBeVisible();
      }},
      {id:'orders.read-collections',q:'historial de cobros',tab:['collections','Cobros'],target:()=>editor().getByRole('heading',{name:'Cobros y devoluciones de dinero',exact:true}),check:async()=>{
        await expect(editor().getByText(/Cobro · \$\s*9[.,]500 · .* · Plataforma/)).toBeVisible();
        await expect(editor().getByText(/no es dinero disponible en el banco/i)).toBeVisible();
      }},
      {id:'orders.read-profitability',q:'contribución del pedido',tab:['profit','Rentabilidad'],target:()=>editor().getByRole('heading',{name:'Acumulado del pedido',exact:true}),check:async()=>{
        await expect(editor().getByText(/Costos históricos: \$\s*8[.,]500/)).toBeVisible();
        await expect(editor().getByText('No hay devoluciones ni cancelaciones registradas.',{exact:true})).toBeVisible();
      }},
      {id:'orders.prepare-order',q:'armar pedido',newOrder:true,target:customerName,check:async()=>{
        await expect(editor().getByRole('heading',{name:'Nuevo pedido',exact:true})).toBeVisible();
        await expect(customerName()).toHaveValue('');
        await expect(editor().getByText(/Aún no agregas referencias/)).toBeVisible();
      }},
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:orders|business|finance)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(fixture.newOrder&&via!=='panel'?'/admin':'/admin?section=orders&tab=list');
        if(!fixture.newOrder){
          await page.getByRole('button',{name:`Abrir pedido ${number(order)}`,exact:true}).click();
          await expect(editor().getByRole('heading',{name:number(order),exact:true})).toBeVisible();
          if(via==='panel'&&fixture.tab)await nativeTab(...fixture.tab);
          if(via!=='panel'&&!fixture.tab)await nativeTab('collections','Cobros');
        }else if(via==='panel')await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();
        if(via!=='panel'){
          let entry;
          if(!fixture.newOrder){
            await editor().getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
            entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
          }else entry=via==='chat'?await openAli(page):page;
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:30000});
          await expect(fixture.target()).toBeFocused();
        }
        await fixture.check();
      }
    });
    expect(writes).toEqual([]);
    const after=await store.order(order.id);
    expect(after.version).toBe(saved.version);
    expect(after.collections.map(row=>row.id)).toEqual(saved.collections.map(row=>row.id));
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva la selección local de Excel hasta la decisión humana',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7);
    const save=(resource,input)=>saveResource(store,resource,{requestId:randomUUID(),...input},actorId);
    const platform=await save('platforms',{name:`Plataforma de archivo ${code}`});
    const source=await save('sources',{name:`Mayoristas ${code}`,platformId:platform.id});
    const workbook=advisorImportWorkbook();
    const profile=await save('profiles',{sourceId:source.id,name:`Formato ${code}`,profile:workbook.config});
    const lookup=()=>page.getByRole('region',{name:'Importar Excel',exact:true});
    const profileSelect=()=>lookup().getByRole('combobox',{name:'Usar una configuración guardada (opcional)',exact:true});
    const account=()=>lookup().getByText(`Cuenta: ${source.name}`,{exact:true});
    const saveFile=()=>lookup().getByRole('button',{name:'Guardar archivo y continuar',exact:true});
    const fixturePath='/admin?section=business&tab=platforms';
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:imports|business|finance|orders)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push([req.method(),new URL(req.url()).pathname]);
    });
    const cases=[
      {id:'business.import-from-source',q:'importar desde una plataforma',target:account,check:async()=>{
        await expect(account()).toBeVisible();
        await expect(profileSelect()).toHaveValue('');
        await expect(lookup().getByText(/Cuenta del enlace seleccionada/)).toBeVisible();
        await expect(saveFile()).toBeDisabled();
      }},
      {id:'business.use-import-profile',q:'usar perfil y revisar columnas',profile:true,target:profileSelect,check:async()=>{
        await expect(account()).toBeVisible();
        await expect(profileSelect()).toHaveValue(profile.id);
        await expect(lookup().getByText(/Cuenta y perfil del enlace seleccionados/)).toBeVisible();
        await expect(saveFile()).toBeDisabled();
      }},
      {id:'imports.select-profile',q:'configuración anterior de excel',target:profileSelect,check:async()=>{
        await expect(profileSelect()).toHaveValue('');
        await profileSelect().selectOption(profile.id);
        await expect(lookup().getByText(/no copiamos el corte anterior/i)).toBeVisible();
        await expect(saveFile()).toBeDisabled();
      }},
      {id:'imports.discard-unuploaded-file',q:'quitar archivo local',file:true,target:()=>lookup().getByRole('button',{name:'Descartar archivo',exact:true}),check:async(target,name)=>{
        await target.click();
        const confirmation=page.getByRole('dialog',{name:'Quitar archivo seleccionado',exact:true});
        await expect(confirmation).toContainText('El archivo no se ha subido');
        await expect(confirmation).toContainText(name);
        await confirmation.getByRole('button',{name:'Volver sin cambios',exact:true}).filter({hasText:'Volver sin cambios'}).click();
        await expect(lookup().getByText(name,{exact:true})).toBeVisible();
        await target.click();
        await confirmation.getByRole('button',{name:'Quitar de esta selección',exact:true}).click();
        await expect(lookup().getByText(/Archivo quitado de la selección. No se enviaron datos/)).toBeVisible();
        await expect(lookup().getByText(name,{exact:true})).toHaveCount(0);
        await expect(saveFile()).toBeDisabled();
      }},
      {id:'imports.upload-file',q:'subir excel',file:true,target:saveFile,check:async(target,name)=>{
        const receipt=page.waitForResponse(res=>res.request().method()==='PUT'&&/^\/api\/admin\/imports\/[^/]+\/file$/.test(new URL(res.url()).pathname));
        await target.click();
        const response=await receipt;
        expect(response.ok()).toBe(true);
        const saved=await response.json();
        const hash=createHash('sha256').update(workbook.bytes).digest('hex');
        expect(saved).toMatchObject({filename:name,fileHash:hash,sourceId:source.id,state:'uploaded'});
        await expect(page).toHaveURL(url=>url.searchParams.get('batch')===saved.id);
        expect(await getImportBatch(store,saved.id)).toMatchObject({filename:name,fileHash:hash,sourceId:source.id});
        expect(writes.splice(0)).toEqual([['POST','/api/admin/imports'],['PUT',`/api/admin/imports/${saved.id}/file`]]);
      }},
    ];
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(fixturePath);
        const scope=page.getByRole('heading',{name:`${source.name} · Activa`,exact:true}).locator('../..');
        await scope.getByRole('button',{name:fixture.profile?'Usar perfil y revisar columnas':'Importar o crear perfil de esta cuenta',exact:true}).click();
        await expect(account()).toBeVisible();
        const name=`archivo-${code}-${via}.xlsx`;
        if(fixture.file){
          await lookup().getByLabel('Archivo Excel',{exact:true}).setInputFiles({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(workbook.bytes)});
          await expect(lookup().getByText(name,{exact:true})).toBeVisible();
        }
        if(via!=='panel'){
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(fixture.target()).toBeFocused();
          if(fixture.file)await expect(lookup().getByText(name,{exact:true})).toBeVisible();
        }
        expect(writes).toEqual([]);
        await fixture.check(fixture.target(),name);
        expect(writes).toEqual([]);
      }
    });
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: consulta evidencia publicitaria guardada sin contactar proveedores',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const origin=new URL(page.url()).origin;
  const session=await context.request.get('/api/admin/social/oauth/complete');
  expect(session.ok(),await session.text()).toBe(true);
  const {csrf}=await session.json();
  const headers={Origin:origin,'x-csrf-token':csrf};
  async function get(path){
    const response=await context.request.get(path);
    expect(response.ok(),await response.text()).toBe(true);
    return response.json();
  }
  const campaign=await seedResults({marker:`resultados-ali-${randomUUID()}`,get,campaign:id=>get(`/api/admin/social/campaigns/${id}`),post:async(path,data)=>{
    const response=await context.request.post(path,{headers,data:{requestId:randomUUID(),...data}});
    expect(response.ok(),await response.text()).toBe(true);
    return response.json();
  }});
  trackFixtureConnection(info,campaign.connectionId);
  const href=`/admin?section=advertising&tab=results&record=${campaign.id}`;
  const read=()=>get(`/api/admin/social/results?campaignId=${campaign.id}`);
  const prior=await read();
  expect(prior.measurements).toEqual([expect.objectContaining({id:campaign.captureId})]);
  const writes=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if((req.method()!=='GET'&&url.pathname.startsWith('/api/admin/social/'))||url.origin!==new URL(href,info.project.use.baseURL).origin)writes.push(req.url());
  });
  const store=await openStore(testDatabaseEnv());
  let candidateOrder,candidateExpense;
  try{
    const actor=await fixtureActor(context,store),code=randomUUID().slice(0,8);
    const product=await store.save('products',{...emptyRecord('products'),title:`Candidato ${code}`,slug:`candidato-${code}`,status:'draft',price:49000,orderable:true,stockQuantity:10},null,null,actor);
    candidateOrder=await store.saveOrder(businessOrderInput(product,{placedOn:bogotaDate(),customerName:`Candidato ${code}`}),actor);
    candidateExpense=await recordExpense(store,{requestId:randomUUID(),category:'advertising',concept:`Pauta candidata ${code}`,amountMinor:1839000,incurredOn:bogotaDate()},actor);
    await recordExpense(store,{requestId:randomUUID(),category:'operating',concept:`Pauta candidata ${code} solo operación`,amountMinor:1839000,incurredOn:bogotaDate()},actor);
  }finally{await store.close();}
  for(const [kind,intent,query,label,needle,expected] of [
    ['order','find-order-to-link','candidatos de pedido por etiqueta','Vincular pedido existente',String(candidateOrder.number),`Pedido ${candidateOrder.number}`],
    ['expense','find-expense-to-link','buscar por concepto de gasto','Vincular gasto publicitario existente',candidateExpense.concept,candidateExpense.concept]
  ])for(const via of ['panel','chat','directorio'])await test.step(`${kind} · ${via}`,async()=>{
    await page.goto(href);
    const results=page.getByRole('region',{name:'Resultados de publicidad',exact:true});
    const launch=results.getByRole('button',{name:label,exact:true});
    async function arrive(target,source){
      if(source)await source.getByRole('button',{name:'Ali: revisar este control',exact:true}).click({timeout:8000});
      let entry=source?page.getByRole('dialog',{name:'Ali, asistente del negocio'}):await openAli(page);
      if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="advertising.${intent}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
      await expect(target).toBeFocused();
    }
    if(via==='panel')await results.getByText('Pedidos y gastos vinculados (separados de Meta)',{exact:true}).click();
    else await arrive(launch);
    await launch.click();
    const dialog=page.getByRole('dialog',{name:label,exact:true});
    const search=dialog.getByRole('textbox',{name:/^Buscar por (número|concepto) o etiqueta histórica$/});
    await expect(dialog.getByRole('button',{name:'Ayúdame con el motivo',exact:true})).toHaveCount(0);
    if(via!=='panel')await arrive(search,dialog);
    await search.fill(needle);
    await dialog.getByRole('button',{name:'Buscar registros',exact:true}).click();
    await expect(dialog.getByText(`Resultados para «${needle}»`,{exact:false})).toBeVisible();
    const candidate=dialog.getByRole('article').filter({has:page.getByText(expected,{exact:true})});
    await expect(candidate.getByRole('button',{name:'Seleccionar para vincular',exact:true})).toHaveAttribute('aria-pressed','false');
    if(kind==='expense')await expect(dialog.getByText(`${needle} solo operación`,{exact:true})).toHaveCount(0);
    await expect(dialog.getByRole('button',{name:'Guardar vínculo',exact:true})).toBeDisabled();
    await expect(page).toHaveURL(url=>url.searchParams.get('record')===campaign.id);
    await candidate.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('heading',{name:label,exact:true})).toBeInViewport({ratio:1});
    await expect(dialog.getByRole('button',{name:'Cerrar',exact:true})).toBeInViewport({ratio:1});
    if(kind==='expense'&&via==='directorio')await screenshot(page,info,'advisor-c6-publicidad-gasto-candidato');
  });
  const cases=[
    {id:'advertising.read-recommendations',q:'ver propuesta de mejora',summary:'Evidencia y acciones de las recomendaciones',check:async scope=>{
      await expect(scope.getByText(/Qué probar:\s*Probar una llamada a la acción más clara/)).toBeVisible();
      await expect(scope.getByText('Aumentar interacciones al mismo horizonte.',{exact:false})).toBeVisible();
    }},
    {id:'advertising.read-learnings',q:'pruebas anteriores y criterio',summary:'Historial de pruebas y aprendizajes',check:async scope=>{
      const item=scope.getByRole('article').filter({hasText:'Texto claro en la prueba anterior'});
      await expect(item.getByText('Mejoró según este criterio',{exact:true})).toBeVisible();
      await expect(item).toContainText('Aumentar interacciones al mismo horizonte.');
    }},
    {id:'advertising.read-business-results',q:'pedidos y gastos declarados',summary:'Pedidos y gastos vinculados (separados de Meta)',check:async scope=>{
      await expect(scope.getByText(/Sin pedidos vinculados. No se afirma que la publicidad haya causado cero ventas/)).toBeVisible();
      await expect(scope.getByText('Gastos publicitarios registrados y vinculados',{exact:true})).toBeVisible();
      await expect(scope.getByText(/No se suman ni se descuentan juntos estos cuatro importes/)).toBeVisible();
    }},
    {id:'advertising.review-business-gap',q:'revisar pedidos y costos vinculados',summary:'Pedidos y gastos vinculados (separados de Meta)',check:async scope=>{
      await expect(scope.getByText(/Sin pedidos vinculados. No se afirma que la publicidad haya causado cero ventas/)).toBeVisible();
      await expect(scope.getByText('Gastos publicitarios registrados y vinculados',{exact:true})).toBeVisible();
    }},
    {id:'advertising.compare-result-forecast',q:'resultados frente a estimación',summary:'Comparar con la estimación y mi meta de costo',details:true,check:async scope=>{
      await expect(scope.getByRole('heading',{name:'Estimación aprobada frente a resultados',exact:true})).toBeVisible();
      await expect(scope.getByText(/Se necesita una previsión aprobada y evidencia comparable/)).toBeVisible();
      await expect(scope.getByRole('region',{name:'Comparación de previsión aprobada'})).toHaveCount(0);
    }},
    {id:'advertising.review-measurement-gap',q:'faltan métricas para recomendar',heading:'Lectura y actualizaciones',check:async scope=>{
      await expect(scope.getByText(/Última lectura local:/)).toBeVisible();
      await expect(scope.getByRole('button',{name:'Actualizar vista',exact:true})).toBeEnabled();
      await scope.getByText('Operaciones de la entrega',{exact:true}).click();
      await expect(scope.getByRole('button',{name:'Actualizar desde Meta',exact:true})).toBeVisible();
      await expect(scope.getByText(/Solicita una consulta al proveedor/)).toBeVisible();
    }},
    {id:'advertising.find-results',q:'encontrar resultados de campaña',search:true,check:async scope=>{
      await expect(scope.getByRole('list',{name:'Piezas con ficha de resultados',exact:true})).toHaveAttribute('aria-busy','false');
      const input=scope.getByRole('searchbox',{name:'Buscar publicaciones',exact:true});
      await input.fill(campaign.name);
      await input.press('Enter');
      await expect(scope.getByRole('status').filter({hasText:`1 coincidencia para «${campaign.name}».`})).toBeVisible({timeout:30000});
      const pieces=scope.getByRole('list',{name:'Piezas con ficha de resultados',exact:true});
      await expect(pieces.getByRole('listitem')).toHaveCount(1);
      await pieces.getByRole('button',{name:campaign.name,exact:true}).click();
      await expect(page).toHaveURL(url=>url.searchParams.get('record')===campaign.id);
    }},
  ];
  for(const fixture of cases)await test.step(fixture.id,async()=>{
    for(const via of ['panel','chat','directorio']){
      const list='/admin?section=advertising&tab=results';
      await page.goto(fixture.search?(via==='panel'?list:'/admin'):href);
      const results=page.getByRole('region',{name:'Resultados de publicidad',exact:true});
      const target=fixture.search?results.getByRole('searchbox',{name:'Buscar publicaciones',exact:true}):fixture.heading?results.getByRole('heading',{name:fixture.heading,exact:true}):results.locator('summary').filter({hasText:fixture.summary});
      if(via==='panel'&&fixture.details)await results.getByText('Métricas completas, capturas y estado por destino',{exact:true}).click();
      if(via==='panel')await expect(target).toBeVisible();
      if(via!=='panel'){
        let entry=await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${fixture.q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        const handoff=entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/});
        await handoff.click({timeout:30000});
        await expect(target).toBeFocused();
        await expect(page).toHaveURL(url=>(url.searchParams.get('record')||null)===(fixture.search?null:campaign.id)&&url.searchParams.get('tab')==='results');
      }
      if(fixture.search||fixture.heading){
        await fixture.check(fixture.search?results:results.getByRole('region',{name:fixture.heading,exact:true}));
      }else{
        const disclosure=target.locator('..');
        if(await disclosure.getAttribute('open')===null)await target.click();
        await fixture.check(disclosure);
      }
    }
  });
  expect(writes).toEqual([]);
  const after=await read();
  expect(after.measurements.map(row=>row.id)).toEqual(prior.measurements.map(row=>row.id));
  expect(after.analysis.recommendations.map(row=>row.id)).toEqual(prior.analysis.recommendations.map(row=>row.id));
});

test('Ali @advisor-c6: confirma vínculos publicitarios sin modificar los registros de Caja o Pedidos',async({page,context,request},info)=>{
  test.setTimeout(110000);
  page.setDefaultTimeout(9000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const adminRead=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/admin/settings');
  await page.goto('/admin');
  const headers={origin:new URL(page.url()).origin,'x-csrf-token':await (await adminRead).headerValue('x-csrf-token')};
  const get=async path=>{const res=await context.request.get(path);expect(res.ok(),await res.text()).toBe(true);return res.json();};
  const post=async(path,data)=>{const res=await context.request.post(path,{headers,data});expect(res.ok(),await res.text()).toBe(true);return res.json();};
  const campaign=await seedResults({marker:`vinculos-ali-${randomUUID()}`,get,campaign:id=>get(`/api/admin/social/campaigns/${id}`),post:(path,data)=>post(path,{requestId:randomUUID(),...data})});
  trackFixtureConnection(info,campaign.connectionId);
  const href=`/admin?section=advertising&tab=results&record=${campaign.id}`;
  const endpoint=`/api/admin/social/campaigns/${campaign.id}/links`;
  const results=page.getByRole('region',{name:'Resultados de publicidad',exact:true}),writes=[],otherWrites=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(req.method()==='POST'&&url.pathname===endpoint)writes.push(req.postDataJSON());
    else if(url.origin!==headers.origin||req.method()!=='GET'&&/^\/api\/admin\/(social|orders|finance)/.test(url.pathname))otherWrites.push(req.url());
  });
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])for(const kind of ['order','expense'])await test.step(`${via}: ${kind}`,async()=>{
      const code=randomUUID().slice(0,8),reason=`Validación ${code} del origen declarado`;
      const order=kind==='order';
      const record=order?await store.saveOrder(businessOrderInput(await store.save('products',{...emptyRecord('products'),title:`Vínculo ${code}`,slug:`vinculo-${code}`,status:'draft',price:55000,orderable:true,stockQuantity:10},null,null,actor),{placedOn:bogotaDate()}),actor)
        :await recordExpense(store,{requestId:randomUUID(),category:'advertising',concept:`Pauta ${code}`,amountMinor:1839000,incurredOn:bogotaDate()},actor);
      const stored=()=>store.db.get(`SELECT * FROM ${store.t(order?'orders':'expenses')} WHERE id=?`,[record.id]);
      const original=await stored(),count=writes.length;
      const label=order?'Vincular pedido existente':'Vincular gasto publicitario existente';
      const launch=results.getByRole('button',{name:label,exact:true});
      const dialog=page.getByRole('dialog',{name:label,exact:true});
      const confirm=dialog.getByRole('checkbox',{name:/^Confirmo el registro seleccionado/});
      async function arrive(target,source=null,verb=`link-${kind}`,query=order?'asociar pedido sin vínculo':'asociar gasto sin vínculo'){
        if(via==='panel')return;
        if(source)await source.getByRole('button',{name:'Ayúdame con el motivo',exact:true}).click();
        let entry=source?page.getByRole('dialog',{name:'Ali, asistente del negocio'}):await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="advertising.${verb}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      }
      await page.goto(href);
      if(via==='panel')await results.getByText('Pedidos y gastos vinculados (separados de Meta)',{exact:true}).click();
      else await arrive(launch);
      await launch.click();
      await dialog.getByRole('textbox',{name:/^Buscar por (número|concepto)/}).fill(order?String(record.number):record.concept);
      await dialog.getByRole('button',{name:'Buscar registros',exact:true}).click();
      const tile=dialog.getByRole('article').filter({has:page.getByText(order?`Pedido ${record.number}`:record.concept,{exact:true})});
      await tile.getByRole('button',{name:'Seleccionar para vincular',exact:true}).click();
      const reasonInput=dialog.getByRole('textbox',{name:/^Motivo de la rectificación/});
      await reasonInput.fill(reason);
      await arrive(confirm,dialog);
      await expect(reasonInput).toHaveValue(reason);
      await expect(confirm).not.toBeChecked();
      expect(writes).toHaveLength(count);
      const accepted=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
      await confirm.check();
      await dialog.getByRole('button',{name:'Guardar vínculo',exact:true}).click();
      const response=await accepted;
      expect(response.ok(),await response.text()).toBe(true);
      const receipt=await response.json();
      expect(receipt).toMatchObject({kind,campaignId:campaign.id,recordId:record.id,version:1,link:{reason}});
      expect(await post(endpoint,writes.at(-1))).toEqual(receipt);
      expect(writes).toHaveLength(count+1);
      const links=await get(endpoint);
      expect(links[order?'orders':'expenses'].filter(item=>item.id===record.id)).toEqual([expect.objectContaining({link:expect.objectContaining({reason,version:1})})]);
      expect(await stored()).toEqual(original);
      await expect(dialog).toHaveCount(0);
      await expect(results.getByText(/Vínculo guardado. Recalculo comercial encolado/)).toBeVisible();
      const card=results.getByRole('article').filter({has:page.getByRole('heading',{name:order?`Pedido ${record.number}`:record.concept,exact:true})});
      const businessSummary=results.getByText('Pedidos y gastos vinculados (separados de Meta)',{exact:true});
      const openRecord=card.getByRole('button',{name:order?'Abrir pedido':'Abrir gasto en Caja',exact:true});
      await arrive(openRecord,null,`open-linked-${kind}`,order?'detalle de pedido publicitario':'detalle de gasto vinculado');
      await openRecord.click();
      await expect(page).toHaveURL(url=>url.searchParams.get('record')===record.id&&url.searchParams.get('section')===(order?'orders':'cash'));
      if(!order){
        await expect(page.getByRole('heading',{name:`Detalle · ${record.concept}`,exact:true})).toBeVisible();
        await page.goto(href);
        if(via==='panel'){
          await businessSummary.click();
          await results.getByRole('button',{name:'Consultar gastos en Caja',exact:true}).click();
        }else await arrive(page.getByRole('region',{name:'Gastos y pagos',exact:true}),null,'open-advertising-expenses','lista de gastos publicitarios');
        await expect(page).toHaveURL(url=>url.searchParams.get('category')==='advertising'&&url.searchParams.get('section')==='cash');
        const expenses=page.getByRole('region',{name:'Gastos y pagos',exact:true});
        await expect(expenses.getByText(record.concept,{exact:true})).toBeVisible();
        await expect(page.getByRole('button',{name:'Quitar filtro: Categoría: Publicidad',exact:true})).toBeVisible();
      }
      await page.goto(href);
      await businessSummary.click();
      const rectify=page.getByRole('dialog',{name:'Rectificar vínculo declarado',exact:true});
      const rectifyReason=rectify.getByRole('textbox',{name:/^Motivo de la rectificación/});
      const acknowledge=rectify.getByRole('checkbox',{name:/^Confirmo el registro seleccionado/});
      const removal=rectify.getByRole('checkbox',{name:/^Retirar este vínculo sin borrar/});
      async function saveExisting(label,expected){
        const accepted=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
        await acknowledge.check();
        await rectify.getByRole('button',{name:label,exact:true}).click();
        const response=await accepted;
        expect(response.ok(),await response.text()).toBe(true);
        const receipt=await response.json();
        expect(receipt).toMatchObject({kind,recordId:record.id,...expected});
        expect(await post(endpoint,writes.at(-1))).toEqual(receipt);
        await expect(rectify).toHaveCount(0);
        expect(await stored()).toEqual(original);
      }
      await card.getByRole('button',{name:'Rectificar o retirar vínculo',exact:true}).click();
      await arrive(rectifyReason,rectify,`rectify-${kind}-link`,order?'corregir vínculo de pedido':'corregir vínculo de gasto');
      const correction=`Corrige el motivo ${code}, no el origen`;
      await rectifyReason.fill(correction);
      await expect(removal).not.toBeChecked();
      await expect(acknowledge).not.toBeChecked();
      expect(writes).toHaveLength(count+1);
      await saveExisting('Guardar vínculo',{campaignId:campaign.id,version:2,link:{reason:correction}});
      await expect(card).toContainText(correction);
      await card.getByRole('button',{name:'Rectificar o retirar vínculo',exact:true}).click();
      await arrive(removal,rectify,`unlink-${kind}`,order?'desvincular pedido':'desvincular gasto');
      await expect(removal).not.toBeChecked();
      await expect(acknowledge).not.toBeChecked();
      expect(writes).toHaveLength(count+2);
      await removal.check();
      await rectifyReason.fill(`Retira el vínculo ${code}`);
      await saveExisting('Retirar vínculo',{campaignId:null,previousCampaignId:campaign.id,link:null});
      expect(writes).toHaveLength(count+3);
      await expect(card).toHaveCount(0);
    });
    expect(otherWrites).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: conserva el corte de Inicio al explicar cifras y pendientes',async({page,context,request},info)=>{
  test.setTimeout(120000);
  // Persisted data alerts replace computed coverage tasks in the attention list.
  await resetBrowserFixture();
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  const cleanup=[];
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),today=bogotaDate();
    const day=`${Number(today.slice(0,4))-(info.project.name==='mobile'?2:1)}-09-12`;
    const command=input=>({requestId:randomUUID(),...input});
    const settings=await getBusinessSettings(store);
    if(!settings.rulesVersions.some(rule=>rule.effectiveOn<=day)){
      await saveBusinessSettings(store,command({...settings,rulesVersions:[...settings.rulesVersions,{...settings.rulesVersions[0],id:`inicio-${code}`,effectiveOn:day}]}),actorId);
      cleanup.push(async()=>{
        const current=await getBusinessSettings(store);
        await saveBusinessSettings(store,command({...current,rulesVersions:current.rulesVersions.filter(rule=>rule.id!==`inicio-${code}`)}),actorId);
      });
    }
    const responsible=await saveResource(store,'people',command({name:`Responsable Inicio ${code}`}),actorId);
    const account=await saveAccount(store,command({name:`Caja de Inicio ${code}`,type:'cash',openingOn:today,openingBalanceMinor:13700000,responsibleId:responsible.id}),actorId);
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto Inicio ${code}`,slug:`inicio-${code}`,status:'draft',price:28000,presentation:'Unidad',orderable:true,stockQuantity:100},null,null,actorId);
    const order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Inicio ${code}`}),actorId);
    const missingOrder=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Sin fecha estimada ${code}`}),actorId);
    const delivered=`ENTREGA-${code}`, undated=`SIN-ESTIMADA-${code}`;
    for(const [record,tracking,estimatedDeliveryOn] of [[order,delivered,day],[missingOrder,undated,null]]){
      const shipment=await createShipment(store,command({orderId:record.id,carrier:'Operador Inicio',tracking,estimatedDeliveryOn}),actorId);
      const collected=await recordShipmentEvent(store,shipment.id,command({version:shipment.version,status:'collected',occurredOn:day}),actorId);
      await recordShipmentEvent(store,shipment.id,command({version:collected.version,status:'delivered',occurredOn:day}),actorId);
    }
    const legacyId=randomUUID();
    const legacyNumber=await store.transaction(async tx=>{
      await tx.db.run(`UPDATE ${tx.t('counters')} SET value=value+1 WHERE id='orders'`);
      const {value}=await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='orders'`);
      const raw=await tx.db.get(`SELECT data,created_at,updated_at FROM ${tx.t('orders')} WHERE id=?`,[order.id]);
      const data={...JSON.parse(raw.data),recognition:null,ruleSnapshot:null,policyReviewRequired:true};
      await insertRow(tx,'orders',{...raw,id:legacyId,number:Number(value),version:1,data:JSON.stringify(data)});
      return Number(value);
    });
    cleanup.push(()=>store.db.run(`DELETE FROM ${store.t('orders')} WHERE id=?`,[legacyId]));
    const ruleRow=await store.db.get(`SELECT id FROM ${store.t('alert_rules')} WHERE type='business_data_missing' AND scope_key='global'`);
    const missingRule=await getAlertRule(store,ruleRow.id);
    if(!missingRule.enabled){
      await saveAlertRule(store,command({...missingRule,enabled:true}),actorId);
      cleanup.push(async()=>{
        const current=await getAlertRule(store,missingRule.id);
        await saveAlertRule(store,command({...missingRule,version:current.version}),actorId);
      });
    }
    await recordExpense(store,command({category:'operating',concept:`Operación Inicio ${code}`,amountMinor:2500000,incurredOn:day}),actorId);
    const href=`/admin?period=quarter&anchor=${day}`;
    const dashboard=await context.request.get(`/api/admin/dashboard?period=quarter&anchor=${day}`);
    expect(dashboard.ok()).toBe(true);
    const [pending]= (await dashboard.json()).vitrina.pending;
    const pendingBefore=await store.get(pending.kind,pending.id);
    const homeSummary=()=>page.locator('summary').filter({hasText:/^Mi vitrina · /});
    const automation=()=>page.locator('details.home-automation > summary');
    const detail=()=>page.getByRole('region',{name:'Registros exactos de la métrica'});
    const rows=()=>detail().getByRole('table',{name:'Registros que explican la cifra',exact:true});
    const orderNumber=`AN-${String(order.number).padStart(6,'0')}`;
    const legacyRef=`AN-${String(legacyNumber).padStart(6,'0')}`;
    const checkMissingSale=async()=>{
      const pendingRow=rows().getByRole('row').filter({has:page.getByRole('button',{name:`Abrir pedido ${legacyRef}`,exact:true})});
      await expect(pendingRow).toContainText('Venta pendiente de fecha real o de política histórica');
      await expect(rows().getByRole('button',{name:`Abrir pedido ${orderNumber}`,exact:true})).toHaveCount(0);
    };
    const nativeMetric=(id,q,button,path,metric,name,check,{missing=false,period='quarter'}={})=>({
      id,q,period,target:()=>detail().getByRole('heading',{name,exact:true}),native:typeof button==='function'?button:()=>page.getByRole('button',{name:button,exact:true}).click(),
      check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('section')==='reports'&&url.searchParams.get('tab')===path&&url.searchParams.get('record')===metric&&url.searchParams.get('period')===period&&url.searchParams.get('anchor')===(metric==='cashAvailable'?today:day)&&Boolean(url.searchParams.get('issue'))===missing);
        await check();
      }
    });
    const cases=[
      {id:'home.period',q:'frecuencia del resumen',target:()=>page.getByRole('combobox',{name:'Frecuencia',exact:true}),check:async target=>{
        await expect(target).toHaveValue('quarter');
        await target.selectOption('week');
        await expect(page).toHaveURL(url=>url.searchParams.get('period')==='week'&&url.searchParams.get('anchor')===day);
        await expect(page.getByRole('heading',{name:'Disponible ahora en caja/cuentas'}).locator('..')).toContainText('Fuera del período elegido');
      }},
      {id:'home.automation-health',q:'salud del proceso',target:automation,check:async target=>{
        await target.click();
        await expect(target.locator('..')).toContainText('Última señal del proceso');
        await expect(target.locator('..')).toContainText('No inicia ni repara el servicio desde el navegador');
      }},
      {id:'home.storefront-status',q:'publicación y pendientes',target:homeSummary,check:async target=>{
        if(await target.locator('..').getAttribute('open')===null)await target.click();
        await expect(target.locator('..').getByText(/^Productos: \d+ registros · [1-9]\d* borradores$/)).toBeVisible();
        await expect(target.locator('..').getByRole('button',{name:'Revisar publicación',exact:true})).toBeVisible();
      }},
      {id:'home.storefront-list',q:'revisar borradores por tipo',native:()=>homeSummary().click(),target:()=>page.getByRole('list',{name:'Tipos de contenido de Mi vitrina'}),check:async target=>{
        await target.getByRole('button',{name:'Revisar Productos',exact:true}).click();
        await expect(page).toHaveURL(url=>url.searchParams.get('section')==='products'&&url.searchParams.get('status')==='draft');
        const filtered=page.getByRole('combobox',{name:'Filtrar por publicación',exact:true});
        await expect(filtered).toHaveValue('draft');
        await expect(page.getByRole('button',{name:`Editar ${product.title}`,exact:true})).toBeVisible();
      }},
      {id:'home.storefront-draft',q:'abrir borrador de inicio',native:()=>homeSummary().click(),target:()=>page.getByRole('list',{name:'Fichas pendientes de Mi vitrina'}),check:async target=>{
        await target.getByRole('button',{name:`Abrir ${pending.title}`,exact:true}).click({timeout:7000});
        await expect(page).toHaveURL(url=>url.searchParams.get('section')===pending.kind&&url.searchParams.get('record')===pending.id);
        const editor=page.getByRole('dialog',{name:`Editar ${schemas[pending.kind].singular}`,exact:true});
        await expect(editor.locator('[name="title"]')).toHaveValue(pending.title);
        await expect(editor.locator('[name="status"]')).toHaveValue('draft');
        expect(await store.get(pending.kind,pending.id)).toMatchObject({version:pendingBefore.version,status:'draft'});
      }},
      {id:'home.observations',q:'más criterios',target:()=>page.getByRole('heading',{name:'Lectura del período',exact:true}),check:async target=>{
        const section=target.locator('..');
        await expect(section).toContainText(/Datos al .* una comparación abierta excluye el día sin completar/);
        await expect(section).toContainText(/Comparación no equivalente|Mismo tramo de días completados|Períodos completos equivalentes/);
      }},
      {id:'home.metric-coverage',q:'cobertura de cifras',target:()=>page.getByRole('region',{name:'Cifras del negocio'}),check:async target=>{
        const result=target.getByRole('heading',{name:'Resultado operativo registrado',exact:true}).locator('..');
        await result.getByText('Qué falta en esta cifra',{exact:true}).click();
        await expect(result.getByText(/Costo histórico de producto pendiente/)).toBeVisible();
        await expect(result).toContainText('no es un resultado completo');
      }},
      nativeMetric('home.sales-records','hechos de venta neta','Ver registros de ventas netas del período','sales','netProductSales','Ventas netas de productos',async()=>{
        const row=rows().getByRole('row').filter({has:page.getByRole('button',{name:`Abrir pedido ${orderNumber}`,exact:true})});
        await expect(row).toContainText(/\$\s*28[.,]000/);
      }),
      nativeMetric('home.sales-gaps','huecos de ventas','Completar datos de ventas netas del período','sales','netProductSales','Datos pendientes · Ventas netas de productos',checkMissingSale,{missing:true}),
      {id:'home.coverage-task',q:'completar registros del pendiente',target:()=>page.getByRole('heading',{name:'Toda la atención pendiente',exact:true}),
        native:()=>page.getByRole('button',{name:/^Toda la atención pendiente/}).click(),check:async()=>{
          const action=page.getByRole('button',{name:'Completar registros de Ventas netas de productos',exact:true});
          await expect(action.locator('..')).toContainText('Cifra: Ventas netas de productos');
          await action.click();
          await expect(page).toHaveURL(url=>url.searchParams.get('record')==='netProductSales'&&url.searchParams.get('issue')==='missing'&&url.searchParams.get('period')==='quarter'&&url.searchParams.get('anchor')===day);
          await checkMissingSale();
        }},
      nativeMetric('home.observation-result','evidencia económica',()=>page.getByText(/^Resultado por completar: los subtotales/).locator('..').getByRole('button',{name:'Ver registros del período',exact:true}).click(),'overview','operatingResult','Datos pendientes · Resultado operativo registrado',async()=>{
        const orderRow=rows().getByRole('row').filter({has:page.getByRole('button',{name:`Abrir pedido ${orderNumber}`,exact:true})});
        await expect(orderRow.filter({hasText:'Costo histórico de producto pendiente'})).toBeVisible();
        await expect(detail()).toContainText('Faltan datos para completar esta cifra');
      },{missing:true}),
      nativeMetric('home.result-records','detalle de resultado','Ver registros de resultado operativo registrado','costs','operatingResult','Resultado operativo registrado',async()=>{
        await expect(detail()).toContainText('No es el dinero disponible ni la utilidad final después de impuestos');
        await expect(rows().getByRole('row').filter({hasText:/Operación/})).toContainText(/-\$\s*25[.,]000/);
      }),
      nativeMetric('home.result-gaps','huecos del resultado operativo','Completar datos de resultado operativo registrado','costs','operatingResult','Datos pendientes · Resultado operativo registrado',async()=>{
        await expect(rows().getByRole('row').filter({hasText:'Excluido:'}).first()).toBeVisible();
        await expect(detail()).toContainText('Faltan datos para completar esta cifra');
      },{missing:true}),
      nativeMetric('home.delivery-records','registros de puntualidad','Ver registros de entregas a tiempo','shipping','onTimeDeliveries','Entregas a tiempo',async()=>{
        await expect(rows().getByRole('row').filter({hasText:delivered})).toBeVisible();
        await expect(detail()).toContainText('1 de 1');
      }),
      nativeMetric('home.delivery-gaps','puntualidad sin datos','Completar datos de entregas a tiempo','shipping','onTimeDeliveries','Datos pendientes · Entregas a tiempo',async()=>{
        await expect(rows().getByRole('row').filter({hasText:undated})).toContainText('Excluido:');
        await expect(rows().getByRole('row').filter({hasText:delivered})).toHaveCount(0);
      },{missing:true}),
      nativeMetric('home.cash-records','movimientos del saldo disponible','Ver movimientos del saldo','cash','cashAvailable','Disponible al corte',async()=>{
        await expect(rows().getByRole('row').filter({hasText:account.name})).toContainText(/\$\s*137[.,]000/);
      },{period:'month'}),
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:dashboard|reports|settings|finance|products)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(href);
        const target=fixture.target();
        if(via==='panel')await fixture.native?.();
        else{
          let entry;
          if(via==='chat'){
            entry=await openAli(page);
            await askAli(entry,`¿Dónde está ${fixture.q}?`);
          }else{
            await page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(target).toBeFocused();
          if(via==='directorio'&&fixture.id==='home.cash-records')await screenshot(page,info,'advisor-c6-movimientos-saldo-de-hoy');
        }
        await fixture.check(target);
      }
    });
    expect(writes).toEqual([]);
  }finally{
    try{for(const restore of cleanup.reverse())await restore();}finally{await store.close();}
  }
});

test('Ali @advisor-c6: vuelve al historial de la guía exacta sin registrar eventos',async({page,context,request},info)=>{
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),day=bogotaDate();
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto Guía ${code}`,slug:`guia-${code}`,status:'draft',price:13000,presentation:'Unidad',orderable:true,stockQuantity:10},null,null,actorId);
    const order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Guía ${code}`}),actorId);
    const tracking=`DETALLE-${code}`, carrier=`Logística ${code}`, note=`Observación privada ${code}`;
    const shipment=await createShipment(store,{requestId:randomUUID(),orderId:order.id,carrier,tracking,estimatedDeliveryOn:day},actorId);
    await recordShipmentEvent(store,shipment.id,{requestId:randomUUID(),version:shipment.version,status:'incident',occurredOn:day,reason:note},actorId);
    const other=await createShipment(store,{requestId:randomUUID(),carrier:`Otro ${code}`,tracking:`OTRA-${code}`},actorId);
    const href=`/admin?section=orders&tab=shipments&q=${code}`;
    const endpoint=`/api/admin/business/shipments/${shipment.id}`;
    const prior=await (await context.request.get(endpoint)).json();
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:orders|business\/shipments)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(href);
      await expect(page.getByRole('heading',{name:other.tracking,exact:true})).toBeVisible();
      const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:tracking,exact:true})});
      await card.getByRole('button',{name:'Ver envío',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:tracking,exact:true}),heading=dialog.getByRole('heading',{name:tracking,exact:true});
      await expect(heading).toBeVisible();
      if(via!=='panel'){
        await dialog.getByRole('heading',{name:'Registrar estado y fecha',exact:true}).locator('..').getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
        if(via==='chat')await askAli(entry,'¿Dónde está detalle de guía?');
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill('detalle de guía');
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator('[data-capability-id="shipments.open-shipment"]').getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(heading).toBeFocused();
      }
      await expect(page).toHaveURL(url=>url.searchParams.get('record')===shipment.id&&url.searchParams.get('q')===code);
      await expect(dialog.getByRole('region',{name:'Origen del envío',exact:true})).toContainText(carrier);
      await expect(dialog.getByRole('button',{name:`Abrir AN-${String(order.number).padStart(6,'0')}`,exact:true})).toBeVisible();
      const metadata=dialog.locator('summary').filter({hasText:'Guía, notas y distribución de cantidades'});
      await metadata.click();
      await expect(metadata.locator('..').getByRole('spinbutton',{name:new RegExp(`Producto Guía ${code}`)})).toHaveValue('1');
      const history=dialog.locator('summary').filter({hasText:/^Historial de eventos/});
      await history.click();
      const event=history.locator('..').getByRole('listitem').filter({hasText:note});
      await expect(event).toContainText('Con novedad');
      await expect(event).toContainText('Corte (día):');
    });
    expect(writes).toEqual([]);
    const after=await (await context.request.get(endpoint)).json();
    expect(after.version).toBe(prior.version);
    expect(after.events).toEqual(prior.events);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: abre una revisión elegida y conserva los otros criterios del informe',async({page,context,request},info)=>{
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),year=completedFixtureYear();
    const day=`${year}-09-01`,end=`${year}-10-01`,last=`${year}-09-30`;
    const command=input=>({requestId:randomUUID(),...input});
    const person=await saveResource(store,'people',command({name:`Persona Informe ${code}`,salaryAgreements:[{id:`salario-${code}`,enabled:true,amountPerPeriodMinor:10000000,frequency:'monthly',effectiveFrom:day,effectiveTo:last,payDayOffset:0}]}),actorId);
    const account=await saveAccount(store,command({name:`Cuenta Informe ${code}`,type:'cash',openingOn:day,openingBalanceMinor:20000000,responsibleId:person.id}),actorId);
    const payroll=await confirmPayroll(store,command({personId:person.id,startOn:day,endOnExclusive:end,bonusMinor:0,discountMinor:0}),actorId);
    const query={period:'month',anchorDate:day,filters:{seller:person.id}};
    const old=await generateReportSnapshot(store,query,actorId);
    await payPayroll(store,command({payrollId:payroll.id,version:payroll.version,amountMinor:1550000,accountId:account.id,effectiveOn:last}),actorId);
    const current=await generateReportSnapshot(store,query,actorId);
    expect(current.snapshot.revision).toBe(old.snapshot.revision+1);
    const platform=await saveResource(store,'platforms',command({name:`Plataforma Informe ${code}`}),actorId);
    const href=`/admin?section=reports&tab=overview&period=month&anchor=${day}&seller=${person.id}`;
    const payrollRow=()=>page.getByRole('table',{name:'Devengos, pagos y saldos por persona',exact:true}).getByRole('row').filter({hasText:person.name});
    const paid=(row,expected)=>expect(row.getByRole('cell',{name:new RegExp(`^(Pagado )?\\$\\s*${expected}$`)})).toHaveCount(1);
    const openPayroll=()=>{
      const tabs=page.getByRole('navigation',{name:'Áreas del informe'});
      return info.project.name==='mobile'
        ?tabs.getByRole('combobox',{name:'Áreas del informe',exact:true}).selectOption('payroll',{timeout:7000})
        :tabs.getByRole('button',{name:'Sueldos',exact:true}).click({timeout:7000});
    };
    const versions=()=>page.getByRole('region',{name:'Versiones del período',exact:true});
    const filters=()=>page.getByRole('group',{name:'Filtros activos',exact:true});
    const cases=[
      {id:'reports.view-payroll',q:'remuneración por persona',start:href,target:()=>page.getByRole('heading',{name:/^Sueldos · /}),native:openPayroll,check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('tab')==='payroll'&&url.searchParams.get('seller')===person.id&&url.searchParams.get('anchor')===day);
        await expect(payrollRow()).toContainText(/\$\s*100[.]000/);
        await paid(payrollRow(),'15[.]500');
        await expect(payrollRow()).toContainText(/\$\s*84[.]500/);
      }},
      {id:'reports.remove-filter',q:'quitar filtro de plataforma',start:`${href}&platform=${platform.id}`,target:filters,check:async()=>{
        await filters().getByRole('button',{name:new RegExp(`^Quitar filtro: Plataforma: ${platform.name}$`)}).click({timeout:7000});
        await expect(page).toHaveURL(url=>!url.searchParams.get('platform')&&url.searchParams.get('seller')===person.id&&url.searchParams.get('anchor')===day);
        await expect(filters().getByRole('button',{name:new RegExp(`^Quitar filtro: .*${person.name}$`)})).toBeVisible();
        await expect(filters().getByRole('button',{name:/^Quitar filtro: Plataforma:/})).toHaveCount(0);
      }},
      {id:'reports.view-snapshot',q:'consultar versión histórica',start:`${href}&mode=saved`,target:versions,check:async()=>{
        await expect(versions().getByRole('button',{name:new RegExp(`^Abrir versión ${current.snapshot.revision}:`)})).toBeVisible();
        await versions().getByRole('button',{name:new RegExp(`^Abrir versión ${old.snapshot.revision}:`)}).click();
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===old.snapshot.id);
        await expect(page.getByRole('heading',{name:`Copia guardada · Versión ${old.snapshot.revision}`,exact:true})).toBeVisible();
        await openPayroll();
        await expect(payrollRow()).toContainText(/\$\s*100[.]000/);
        await expect(payrollRow()).not.toContainText(/\$\s*15[.]500/);
      }},
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:reports|finance)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(fixture.start);
        if(via==='panel')await fixture.native?.();
        else{
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
          await expect(fixture.target()).toBeFocused();
        }
        await fixture.check();
      }
    });
    expect(writes).toEqual([]);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: acredita alta, edición, archivo y vínculo humano de personas',async({page,context,request},info)=>{
  test.setTimeout(180000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const vias=['panel','chat','directorio'], href='/admin?section=business&tab=people';
    const peoplePath='/api/admin/business/people';
    const get=async path=>{
      const res=await page.request.get(path);
      expect(res.status()).toBe(200);
      return res.json();
    };
    const readPerson=id=>get(`${peoplePath}/${id}`);
    const email=`advisor-c6-person-${code}@example.test`;
    await createAdmin(store,email,'advisor-c6-only-synthetic');
    const {users}=await get('/api/admin/users');
    const user=users.find(item=>item.email===email);
    expect(user).toMatchObject({active:true,role:'administrator'});
    expect(user.id).not.toBe(actorId);

    const effectiveOn='2025-01-15';
    const edits=new Map(), created=new Map();
    for(const via of vias){
      const seed=await saveResource(store,'people',{
        requestId:randomUUID(), name:`Responsable histórico ${code} ${via}`,
        salaryAgreements:[{id:randomUUID(),enabled:true,amountPerPeriodMinor:125000000,frequency:'monthly',effectiveFrom:effectiveOn,payDayOffset:2}],
        commissionOverrides:[{id:randomUUID(),effectiveOn,enabled:true,mode:'percent',rateBps:525}],
      },actorId);
      edits.set(via,await readPerson(seed.id));
    }

    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname, method=req.method();
      if(path.startsWith('/api/admin/')&&!['GET','HEAD','OPTIONS'].includes(method)) writes.push({path,method});
    });
    const isChatWrite=({path,method})=>method==='POST'&&/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(path);
    const workspace=page.getByRole('region',{name:'Configuración del negocio',exact:true});
    const dialog=page.getByRole('dialog',{name:/^(Crear|Editar) persona$/});
    const name=dialog.getByRole('textbox',{name:'Nombre',exact:true});
    const reason=dialog.getByRole('textbox',{name:'Motivo del cambio',exact:true});
    const active=dialog.getByRole('checkbox',{name:'Activo para nuevos registros',exact:true});
    const card=personName=>workspace.getByRole('listitem').filter({has:page.getByText(personName,{exact:true})});

    async function audit(current,previous,change){
      const rows=await store.db.all(`SELECT actor_id,data FROM ${store.t('business_audit')} WHERE entity_type=? AND entity_id=?`,['people',current.id]);
      expect(rows).toHaveLength(current.version);
      const revision=rows.find(row=>JSON.parse(row.data).next.version===current.version);
      expect(revision?.actor_id).toBe(actorId);
      expect(JSON.parse(revision.data)).toEqual({previous,next:current,reason:change,source:'manual'});
    }
    async function savePerson(button,current,change){
      const method=current?'PUT':'POST', path=current?`${peoplePath}/${current.id}`:peoplePath;
      const before=writes.length;
      await reason.fill(change);
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path),
        dialog.getByRole('button',{name:button,exact:true}).click(),
      ]);
      expect(response.status()).toBe(current?200:201);
      if(current) expect(response.request().postDataJSON()).toMatchObject({version:current.version});
      const saved=await response.json();
      expect(saved.version).toBe((current?.version||0)+1);
      await expect(dialog).toHaveCount(0);
      expect(writes.slice(before)).toEqual([{path,method}]);
      expect(await readPerson(saved.id)).toEqual(saved);
      await audit(saved,current,change);
      return saved;
    }
    async function selectPerson(select,button,person){
      const before=writes.length, open=workspace.getByRole('button',{name:button,exact:true});
      await expect(select).toHaveValue('');
      await expect(open).toBeDisabled();
      await select.selectOption(person.id);
      await expect(dialog).toHaveCount(0);
      expect(writes).toHaveLength(before);
      await open.click();
      await expect(name).toHaveValue(person.name);
      expect(writes).toHaveLength(before);
    }

    const cases=[
      {id:'business.person-create',query:'crear responsable',marker:'settings-person-create',
        target:()=>workspace.getByRole('button',{name:'Crear persona',exact:true}),effect:async(target,via)=>{
          const before=writes.length, value=`Persona nueva ${code} ${via}`;
          await target.click();
          await expect(name).toHaveValue('');
          await expect(active).toBeChecked();
          await expect(dialog.locator('input[type=email],input[type=password]')).toHaveCount(0);
          await dialog.getByText('Vincular usuario de acceso (opcional)',{exact:true}).click();
          await expect(dialog.getByRole('combobox',{name:'Usuario existente',exact:true})).toHaveValue('');
          await name.fill(value);
          expect((await get(peoplePath)).records.some(person=>person.name===value)).toBe(false);
          expect(writes).toHaveLength(before);
          const person=await savePerson('Crear persona',null,`Alta sintética ${via}`);
          expect(person).toMatchObject({name:value,active:true,userId:null,salaryAgreements:[],commissionOverrides:[]});
          await expect(card(value)).toContainText('Activa · 0 convenios · 0 vigencias de comisión');
          created.set(via,person);
        }},
      {id:'business.person-edit',query:'editar responsable',marker:'settings-person-edit',details:'Editar o archivar una persona',
        target:()=>workspace.getByRole('combobox',{name:'Persona para editar',exact:true}),effect:async(target,via)=>{
          const original=edits.get(via), button='Abrir editor de persona', value=`Responsable corregido ${code} ${via}`;
          const history={salaryAgreements:original.salaryAgreements,commissionOverrides:original.commissionOverrides};
          const before=writes.length;
          await selectPerson(target,button,original);
          await expect(active).toBeChecked();
          await name.fill(value);
          expect(await readPerson(original.id)).toEqual(original);
          expect(writes).toHaveLength(before);
          const renamed=await savePerson('Guardar persona',original,`Corrección de persona activa ${via}`);
          expect(renamed).toMatchObject({id:original.id,name:value,active:true,userId:null,...history});
          await expect(card(value)).toContainText('Activa · 1 convenios · 1 vigencias de comisión');
          await expect(target).toHaveValue(original.id);
          await workspace.getByRole('button',{name:button,exact:true}).click();
          await expect(name).toHaveValue(value);
          await active.uncheck();
          expect(await readPerson(original.id)).toEqual(renamed);
          expect(writes).toHaveLength(before+1);
          const archived=await savePerson('Guardar persona',renamed,`Archivo explícito ${via}`);
          expect(archived).toMatchObject({id:original.id,name:value,active:false,userId:null,...history});
          await expect(card(value)).toContainText('Archivada · 1 convenios · 1 vigencias de comisión');
          await expect(target.getByRole('option',{name:`${value} · Archivada`,exact:true})).toHaveCount(1);
          await expect(target).toHaveValue(original.id);
          await workspace.getByRole('button',{name:button,exact:true}).click();
          await expect(active).not.toBeChecked();
          await dialog.getByText('Sueldos internos (1 convenios)',{exact:true}).click();
          await expect(dialog.getByText(/Mensual.*desde 2025-01-15/)).toBeVisible();
          await dialog.getByText('Comisión particular (1 vigencias)',{exact:true}).click();
          await expect(dialog.getByText(/Desde 2025-01-15 · 5,25 %/)).toBeVisible();
          await dialog.getByRole('button',{name:'Cancelar edición',exact:true}).click();
          await expect(dialog).toHaveCount(0);
          expect(writes).toHaveLength(before+2);
        }},
      {id:'business.person-link-user',query:'vincular usuario de acceso',marker:'settings-person-user-link',details:'Vincular o desvincular usuario de acceso',
        target:()=>workspace.getByRole('combobox',{name:'Persona para gestionar el vínculo',exact:true}),effect:async(target,via)=>{
          const person=created.get(via), button='Abrir formulario de vínculo', before=writes.length;
          await selectPerson(target,button,person);
          const existing=dialog.getByRole('combobox',{name:'Usuario existente',exact:true});
          await expect(existing).toBeVisible();
          await expect(existing).toHaveValue('');
          expect(await existing.locator('option').evaluateAll(options=>options.map(option=>option.value))).toEqual(['',...users.map(item=>item.id)]);
          await expect(existing.getByRole('option',{name:email,exact:true})).toHaveAttribute('value',user.id);
          await existing.selectOption(user.id);
          expect(await readPerson(person.id)).toEqual(person);
          expect(writes).toHaveLength(before);
          const linked=await savePerson('Guardar persona',person,`Vínculo humano ${via}`);
          expect(linked).toMatchObject({id:person.id,name:person.name,active:true,userId:user.id,salaryAgreements:[],commissionOverrides:[]});
          await expect(card(person.name)).toContainText('usuario vinculado');
          await expect(target).toHaveValue(person.id);
          await workspace.getByRole('button',{name:button,exact:true}).click();
          await expect(existing).toHaveValue(user.id);
          await existing.selectOption('');
          expect(await readPerson(person.id)).toEqual(linked);
          expect(writes).toHaveLength(before+1);
          const unlinked=await savePerson('Guardar persona',linked,`Retiro humano del vínculo ${via}`);
          expect(unlinked).toMatchObject({id:person.id,name:person.name,active:true,userId:null});
          await expect(card(person.name)).not.toContainText('usuario vinculado');
          expect((await get('/api/admin/users')).users).toEqual(users);
        }},
    ];

    for(const fixture of cases) await test.step(fixture.id,async()=>{
      for(const via of vias) await test.step(via,async()=>{
        const before=writes.length, target=fixture.target();
        await page.goto(via==='panel'?href:'/admin');
        if(via==='panel'){
          if(fixture.details) await workspace.getByText(fixture.details,{exact:true}).click();
        }else{
          let entry;
          if(via==='chat'){
            entry=await openAli(page);
            await askAli(entry,`¿Dónde está ${fixture.query}?`);
          }else{
            await page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.query);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          const action=entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/});
          await expect(action).toBeVisible({timeout:7000});
          expect(writes.slice(before).filter(write=>!isChatWrite(write))).toEqual([]);
          const handoff=writes.length;
          await action.click();
          await expect(target).toBeFocused();
          await expect(entry).toBeHidden();
          expect(writes).toHaveLength(handoff);
          if(via==='directorio') await screenshot(page,info,`advisor-c6-${fixture.marker}`);
        }
        await expect(page).toHaveURL(/\/admin\?section=business&tab=people$/);
        await expect(target).toHaveAttribute('data-advisor-control',fixture.marker);
        await expect(dialog).toHaveCount(0);
        expect(writes.slice(before).filter(write=>!isChatWrite(write))).toEqual([]);
        await fixture.effect(target,via);
      });
    });
    expect(writes.filter(write=>!isChatWrite(write))).toHaveLength(15);
    expect((await get('/api/admin/users')).users).toEqual(users);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: prepara y guarda fichas privadas de combos y catálogos', async ({page,context,request},info)=>{
  test.setTimeout(180000);
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile) await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const product=await store.save('products',{...emptyRecord('products'),title:`Referencia sintética ${code}`,slug:`referencia-sintetica-${code}`,status:'draft',price:19000,stockQuantity:14,orderable:true},null,null,actorId);
    const storefront=await store.settings();
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!/^\/api\/admin\/assistant\/turns(?:\/|$)/.test(path)) writes.push(`${req.method()} ${path}`);
    });
    const viaList=['panel','chat','directorio'];
    const catalogues=[
      {kind:'combos',singular:'combo',prepare:'preparar ficha de combo',create:'armar paquete de productos',update:'cambiar productos del combo',newControl:'combo-new-save',savedControl:'combo-record-save'},
      {kind:'catalogs',singular:'catálogo',prepare:'preparar una ficha nueva de contenido',create:'crear catálogo',update:'ordenar colecciones',newControl:'catalog-new-save',savedControl:'catalog-record-save'},
    ];
    const formatter=new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0});
    const editor=()=>page.locator('dialog.editor-drawer');
    const field=name=>editor().locator(`[name="${name}"]`);
    const save=()=>editor().getByRole('button',{name:'Guardar borrador',exact:true});
    const summary=()=>editor().locator(mobile?'.editor-mobile-summary':'.editor-summary');
    const summaryValue=label=>summary().getByText(label,{exact:true}).locator('../dd');
    const titleField=()=>field('title');
    const component=()=>field('items[0].productId');
    const quantity=()=>field('items[0].quantity');
    const heading=(flow,row)=>editor().getByRole('heading',{name:`${row?'Editar':'Crear'} ${flow.singular}`,exact:true});
    const editButton=title=>page.getByRole('button',{name:`Editar ${title}`,exact:true});
    const listRow=title=>page.locator('.list-table tr:visible, .list-cards .record-card:visible').filter({has:editButton(title)});
    const expectBefore=(first,second)=>expect(listRow(first).locator('xpath=following-sibling::*').filter({has:editButton(second)})).toBeVisible();
    const verifyAbsent=async(kind,title)=>{
      expect((await store.list(kind)).filter(row=>row.title===title)).toEqual([]);
    };
    async function openFromPanel(flow,row){
      await page.goto(`/admin?section=${flow.kind}`);
      if(row) await editButton(row.title).click();
      else await page.locator('section.data-card .list-toolbar').getByRole('button',{name:`Crear ${flow.singular}`,exact:true}).click();
      await expect(heading(flow,row)).toBeVisible();
      if(mobile) await summary().locator('summary').click();
    }
    async function focusVia(via,id,query,control){
      const before=writes.length;
      await expect(control).toBeVisible();
      if(via!=='panel'){
        await editor().getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
        if(via==='chat') await askAli(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(control).toBeFocused();
      }
      expect(writes).toHaveLength(before);
    }
    async function checkEmpty(flow){
      await expect(titleField()).toHaveValue('');
      await expect(field('slug')).toHaveValue('');
      await expect(field('status')).toHaveValue('draft');
      await expect(editor().getByText(/Esta ficha aún no está guardada/)).toBeVisible();
      await expect(summaryValue('Título')).toHaveText('Sin título');
      if(flow.kind==='combos'){
        await expect(field('price')).toHaveValue('0');
        await expect(field('orderable')).not.toBeChecked();
        await expect(editor().getByText('Aún no hay productos incluidos.',{exact:true})).toBeVisible();
        await expect(summaryValue('Componentes')).toHaveText('Sin productos incluidos');
        await expect(summaryValue('Precio')).toHaveText('Precio sin definir');
      }else{
        await expect(field('sort')).toHaveValue('0');
        await expect(summaryValue('Orden de aparición')).toHaveText('0');
      }
    }
    async function editDraft(flow,title,variation,row){
      if(!row) await titleField().fill(title);
      const description=`Contenido privado sintético ${variation}`;
      await field('description').fill(description);
      if(flow.kind==='combos'){
        const price=41000+variation*100, count=2+variation, conditions=`Límite sintético ${variation}`;
        if(!row){
          await editor().getByRole('button',{name:'Agregar producto',exact:true}).click();
          await expect(component()).toBeFocused();
          await component().selectOption(product.id);
          await field('orderable').check();
        }
        await quantity().fill(String(count));
        await field('price').fill(String(price));
        await field('conditions').fill(conditions);
        return {title,status:'draft',description,price,orderable:true,items:[{productId:product.id,quantity:count}],conditions};
      }
      const sort=row&&variation%2===1?25+variation:31+variation;
      await field('sort').fill(String(sort));
      return {title,status:'draft',description,sort};
    }
    async function checkDraft(flow,fields){
      await expect(titleField()).toHaveValue(fields.title);
      await expect(field('description')).toHaveValue(fields.description);
      await expect(field('status')).toHaveValue('draft');
      await expect(summaryValue('Publicación')).toHaveText('Borrador');
      if(flow.kind==='combos'){
        await expect(component()).toHaveValue(fields.items[0].productId);
        await expect(quantity()).toHaveValue(String(fields.items[0].quantity));
        await expect(field('price')).toHaveValue(String(fields.price));
        await expect(field('conditions')).toHaveValue(fields.conditions);
        await expect(field('orderable')).toBeChecked();
        await expect(summaryValue('Componentes')).toHaveText(`${fields.items[0].quantity} × ${product.title}`);
        await expect(summaryValue('Precio')).toHaveText(formatter.format(fields.price));
      }else{
        await expect(field('sort')).toHaveValue(String(fields.sort));
        await expect(summaryValue('Orden de aparición')).toHaveText(String(fields.sort));
      }
    }
    async function saveDraft(flow,fields,row){
      const path=`/api/admin/${flow.kind}${row?`/${row.id}`:''}`, method=row?'PUT':'POST', before=writes.length;
      await expect(save()).toHaveAttribute('type','submit');
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path),
        save().click(),
      ]);
      expect(response.status()).toBe(row?200:201);
      const payload=response.request().postDataJSON(), result=await response.json();
      expect(payload).toMatchObject(fields);
      expect(result).toMatchObject({...fields,slug:payload.slug,version:row?row.version+1:1});
      if(row){
        expect(payload.version).toBe(row.version);
        expect(result.id).toBe(row.id);
      }else expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
      await expect(editor()).toHaveCount(0);
      await expect(page.getByText(`Guardado: ${fields.title} · Borrador`,{exact:true})).toBeVisible();
      const card=listRow(fields.title);
      await expect(card).toContainText('Borrador');
      await expect(card).toContainText(flow.kind==='combos'?formatter.format(fields.price):String(fields.sort));
      expect(writes.slice(before)).toEqual([`${method} ${path}`]);
      expect(await store.get(flow.kind,result.id)).toMatchObject({...fields,version:result.version});
      return result;
    }

    await test.step('products.prepare-record',async()=>{
      for(const flow of catalogues) for(const [index,via] of viaList.entries()){
        const before=writes.length, title=`Preparación ${flow.singular} ${code} ${via}`;
        await openFromPanel(flow);
        await focusVia(via,'products.prepare-record',flow.prepare,heading(flow));
        await checkEmpty(flow);
        const fields=await editDraft(flow,title,index);
        await expect(field('slug')).not.toHaveValue('');
        await checkDraft(flow,fields);
        await expect(editor().getByText('Cambios sin guardar',{exact:true})).toBeVisible();
        expect(writes).toHaveLength(before);
        await verifyAbsent(flow.kind,title);
        page.once('dialog',prompt=>prompt.accept());
        await editor().getByRole('button',{name:'Cancelar',exact:true}).click();
        await expect(editor()).toHaveCount(0);
        expect(writes).toHaveLength(before);
        await verifyAbsent(flow.kind,title);
      }
    });
    for(const flow of catalogues){
      let selected, orderReference;
      const createId=`products.create-${flow.kind==='combos'?'combo':'catalog'}`;
      await test.step(createId,async()=>{
        for(const [index,via] of viaList.entries()){
          const before=writes.length, title=`Nuevo ${flow.singular} ${code} ${via}`;
          await openFromPanel(flow);
          await checkEmpty(flow);
          await expect(save()).toHaveAttribute('data-advisor-control',flow.newControl);
          await save().click();
          await expect(titleField()).toHaveAttribute('aria-invalid','true');
          expect(writes).toHaveLength(before);
          const fields=await editDraft(flow,title,index);
          await focusVia(via,createId,flow.create,save());
          await checkDraft(flow,fields);
          expect(writes).toHaveLength(before);
          await verifyAbsent(flow.kind,title);
          const saved=await saveDraft(flow,fields);
          if(via==='panel') selected=saved;
          if(flow.kind==='catalogs'&&via==='directorio'){
            orderReference=saved;
            await expectBefore(selected.title,orderReference.title);
          }
          expect(writes).toHaveLength(before+1);
        }
      });
      const updateId=`products.update-${flow.kind==='combos'?'combo':'catalog'}`;
      await test.step(updateId,async()=>{
        for(const [index,via] of viaList.entries()){
          const before=writes.length;
          await openFromPanel(flow,selected);
          await checkDraft(flow,selected);
          await expect(save()).toHaveAttribute('data-advisor-control',flow.savedControl);
          const fields=await editDraft(flow,selected.title,index+4,selected);
          await focusVia(via,updateId,flow.update,save());
          await checkDraft(flow,fields);
          expect(writes).toHaveLength(before);
          expect(await store.get(flow.kind,selected.id)).toMatchObject({version:selected.version,description:selected.description,status:'draft'});
          selected=await saveDraft(flow,fields,selected);
          if(orderReference){
            if(selected.sort<orderReference.sort) await expectBefore(selected.title,orderReference.title);
            else await expectBefore(orderReference.title,selected.title);
          }
          expect(writes).toHaveLength(before+1);
        }
      });
    }
    expect(writes).toHaveLength(12);
    expect(await store.settings()).toMatchObject({version:storefront.version,launchApproved:storefront.launchApproved});
    expect(await store.get('products',product.id)).toMatchObject({version:product.version,status:'draft',catalogIds:[]});
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: distingue alertas resueltas, episodio elegido y reglas sin ejecutar',async({page,context,request},info)=>{
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7);
    const waitForEpisode=async(product,{id,state})=>{
      let episode;
      await expect.poll(async()=>{
        episode=await store.db.get(`SELECT id,state FROM ${store.t('alerts')} WHERE rule_id='stock_low' AND entity_id=? ORDER BY episode DESC LIMIT 1`,[product.id]);
        if(episode?.state===state&&(!id||episode.id===id))return true;
        // The scheduler can invalidate an evaluation's snapshot. Reconcile facts, not product writes.
        await evaluateAlerts(store);
        return false;
      },{timeout:20000,message:`Episodio ${state} para ${product.title}`}).toBe(true);
      return episode;
    };
    const historical=await seedAdvisorAlert(store,{title:`Existencia repuesta ${code}`,actorId,now:new Date().toISOString()});
    const opened=await waitForEpisode(historical.product,{state:'open'});
    await stockEpisode(store,historical.product,actorId,new Date().toISOString(),1000);
    const resolved=await waitForEpisode(historical.product,{id:opened.id,state:'resolved'});
    const pending=await seedAdvisorAlert(store,{title:`Existencia pendiente ${code}`,actorId,now:new Date().toISOString()});
    const current=await waitForEpisode(pending.product,{state:'open'});
    const read=async path=>{
      const result=await context.request.get(`/api/admin/${path}`);
      expect(result.ok()).toBe(true);
      return result.json();
    };
    const priorResolved=await read(`alerts/${resolved.id}`),priorCurrent=await read(`alerts/${current.id}`);
    expect(priorResolved.state).toBe('resolved');
    expect(priorCurrent.state).toBe('open');
    const {records:rules}=await read('alert-rules');
    const stockRule=rules.find(rule=>rule.type==='stock_low');
    const href='/admin?section=business&tab=alerts&issue=stock_low', article=id=>page.locator(`[data-alert-id="${id}"]`);
    const filters=()=>page.getByRole('group',{name:'Filtros de alertas'});
    const cases=[
      {id:'alerts.list',q:'alertas activas',target:()=>page.getByRole('heading',{name:'Revisar alertas del negocio',exact:true}),check:async()=>{
        await expect(filters().getByRole('combobox',{name:'Tipo',exact:true})).toHaveValue('stock_low');
        await expect(article(current.id)).toContainText(priorCurrent.reason);
        await expect(article(current.id)).toContainText('Abierta');
        await expect(article(resolved.id)).toHaveCount(0);
      }},
      {id:'alerts.filter',q:'ver alertas resueltas',target:filters,check:async()=>{
        const state=filters().getByRole('combobox',{name:'Estado',exact:true});
        await expect(state).toHaveValue('active');
        await state.selectOption('resolved');
        await expect(article(resolved.id)).toContainText('Resuelta');
        await expect(article(resolved.id)).toContainText(priorResolved.reason);
        await expect(article(current.id)).toHaveCount(0);
        await expect(page).toHaveURL(url=>url.searchParams.get('status')==='resolved'&&url.searchParams.get('issue')==='stock_low');
      }},
      {id:'alerts.episode',q:'abrir episodio',target:()=>article(current.id).getByRole('heading'),prepare:async()=>{
        await article(current.id).getByRole('button',{name:/^Ver episodio:/}).click();
        await expect(article(current.id)).toHaveAttribute('aria-current','true');
      },check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===current.id&&url.searchParams.get('issue')==='stock_low');
        await expect(article(current.id)).toContainText('Alerta seleccionada');
        await expect(article(current.id)).toContainText(priorCurrent.reason);
        await article(current.id).getByRole('button',{name:'Cerrar selección',exact:true}).click();
        await expect(page).toHaveURL(url=>!url.searchParams.get('record')&&url.searchParams.get('issue')==='stock_low');
        await expect(article(current.id)).toContainText('Abierta');
      }},
      {id:'alerts.rules',q:'reglas de alertas',target:()=>page.getByRole('heading',{name:'Configurar reglas de avisos',exact:true}),check:async()=>{
        const group=page.getByRole('region',{name:'Configurar reglas de avisos',exact:true});
        const stock=group.getByRole('listitem').filter({has:page.getByText('Existencias próximas a agotarse',{exact:true})});
        await expect(stock).toContainText(`recordatorio ${stockRule.reminderHours} h`);
        await expect(stock).toContainText(stockRule.enabled?'Habilitada':'Deshabilitada');
        await expect(group).toContainText('Habilitar una regla no inicia el proceso automático.');
      }},
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:alerts|alert-rules|products|business)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(href);
        await fixture.prepare?.();
        if(via!=='panel'){
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(fixture.target()).toBeFocused();
        }
        await fixture.check();
      }
    });
    expect(writes).toEqual([]);
    expect(await read(`alerts/${resolved.id}`)).toEqual(priorResolved);
    expect(await read(`alerts/${current.id}`)).toEqual(priorCurrent);
    expect((await read('alert-rules')).records).toEqual(rules);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: lleva a la regla exacta de avisos y conserva los hechos del negocio',async({page,context,request},info)=>{
  test.setTimeout(155000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  let restoreRules;
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7);
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable aviso ${code}`},actorId);
    const {alert}=await seedAdvisorAlert(store,{title:`Existencia previa ${code}`,actorId,now:new Date().toISOString()});
    const read=async path=>{
      const response=await context.request.get(`/api/admin/${path}`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const initialAlert=await read(`alerts/${alert.id}`);
    const {records:rules}=await read('alert-rules');
    restoreRules=async()=>{
      for(const prior of rules){
        const current=await getAlertRule(store,prior.id);
        if(current.version===prior.version)continue;
        const {enabled,thresholds,selectedStatuses,reminderHours,responsibleId}=prior;
        await saveAlertRule(store,{requestId:randomUUID(),version:current.version,enabled,thresholds,selectedStatuses,reminderHours,responsibleId,reason:'Restituir regla después del contraste sintético'},actorId,prior.id);
      }
    };
    const scenarios=[
      ['label-stale','umbral etiqueta','shipment_label_stale','Guía sin recogida','hours'],
      ['no-shipment-update','envío sin actualización','shipment_no_update','Envío sin actualización','hours'],
      ['overdue-shipment','entrega fuera de fecha','shipment_overdue','Entrega fuera de fecha','enabled'],
      ['shipment-incident','estados que requieren atención','shipment_incident','Novedad de envío','status'],
      ['stale-source','umbral de excel vencido','platform_not_updated','Archivo de plataforma desactualizado','hours'],
      ['settlement-overdue','umbral de liquidación','settlement_overdue','Recaudo sin liquidar','days'],
      ['cash-minimum','regla saldo mínimo','cash_below_minimum','Saldo bajo','account'],
      ['cash-difference','aviso diferencia de caja','cash_difference','Diferencia de cierre','account'],
      ['missing-closing','alerta cierre pendiente','cash_close_missing','Cierre pendiente','account'],
      ['missing-data','regla completar datos','business_data_missing','Datos faltantes','enabled'],
      ['stock-low','regla stock bajo','stock_low','Existencias próximas a agotarse','stock'],
    ];
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(`${req.method()} ${path}`);
    });
    const rulesRegion=page.getByRole('region',{name:'Configurar reglas de avisos'});
    const dialog=page.getByRole('dialog',{name:'Configurar aviso',exact:true});
    const input=label=>dialog.getByRole('spinbutton',{name:label,exact:true});
    const submit=dialog.getByRole('button',{name:'Guardar aviso',exact:true});
    const href='/admin?section=business&tab=alerts&issue=stock_low';
    for(const [intent,q,type,label,shape] of scenarios)await test.step(`alerts.rule-${intent}`,async()=>{
      const id=rules.find(rule=>rule.type===type).id,rulePath=`alert-rules/${id}`;
      for(const via of ['panel','chat','directorio']){
        const before=writes.length, prior=await read(rulePath);
        await page.goto(href);
        const target=rulesRegion.getByRole('listitem').filter({has:page.getByText(label,{exact:true})}).getByRole('button',{name:'Configurar aviso',exact:true});
        if(via!=='panel'){
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="alerts.rule-${intent}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(target).toBeFocused();
          await expect(dialog).toBeHidden();
        }
        await expect(page).toHaveURL(url=>url.searchParams.get('issue')==='stock_low');
        await target.click({timeout:7000});
        await expect(dialog.getByRole('heading',{name:label,exact:true})).toBeVisible();
        await expect(dialog).toContainText('Habilitar no evalúa la condición ni crea alertas.');
        const reminder=prior.reminderHours+3;
        await input('Recordatorio cada (horas calendario)').fill(String(reminder));
        const expected={id,version:prior.version+1,type,enabled:prior.enabled,thresholds:prior.thresholds,selectedStatuses:prior.selectedStatuses,reminderHours:reminder};
        if(shape==='hours'||shape==='days'){
          const threshold=input(shape==='hours'?'Umbral (horas calendario)':'Umbral (días calendario)');
          await expect(threshold).toHaveValue(String(prior.thresholds[shape]));
          const value=prior.thresholds[shape]+2;
          await threshold.fill(String(value));
          expected.thresholds={...prior.thresholds,[shape]:value};
          await dialog.getByRole('combobox',{name:'Responsable de esta regla (opcional)',exact:true}).selectOption(person.id);
          expected.responsibleId=person.id;
        }else if(shape==='stock'){
          const amount=input('Cantidad de anticipación');
          await expect(amount).toHaveValue(String(prior.thresholds.amount));
          const unit=prior.thresholds.unit==='week'?'day':'week';
          await dialog.getByRole('combobox',{name:'Unidad de anticipación',exact:true}).selectOption(unit);
          await amount.fill(String(prior.thresholds.amount+1));
          expected.thresholds={unit,amount:prior.thresholds.amount+1};
        }else if(shape==='status'){
          const cancelled=dialog.getByRole('checkbox',{name:'Cancelado',exact:true}), enabled=!prior.selectedStatuses.includes('cancelled');
          await cancelled.setChecked(enabled);
          expected.selectedStatuses=enabled?[...prior.selectedStatuses,'cancelled']:prior.selectedStatuses.filter(status=>status!=='cancelled');
        }else{
          if(shape==='account')await expect(dialog).toContainText('El saldo mínimo, tolerancia y hora de cierre se configuran por cuenta.');
          await dialog.getByRole('checkbox',{name:'Regla habilitada',exact:true}).setChecked(!prior.enabled);
          expected.enabled=!prior.enabled;
        }
        await dialog.getByRole('textbox',{name:'Motivo del cambio',exact:true}).fill(`Contraste sintético ${intent} ${via}`);
        expect(writes).toHaveLength(before);
        expect(await read(rulePath)).toEqual(prior);
        const [response]=await Promise.all([
          page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===`/api/admin/${rulePath}`,{timeout:8000}),
          submit.click(),
        ]);
        const result=await response.json();
        expect(response.ok(),JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject(expected);
        await expect(dialog).toBeHidden();
        expect(writes.slice(before)).toEqual([`PUT /api/admin/${rulePath}`]);
        const sent=response.request();
        const replay=await context.request.put(`/api/admin/${rulePath}`,{data:sent.postDataJSON(),headers:{origin:await sent.headerValue('origin'),'x-csrf-token':await sent.headerValue('x-csrf-token')}});
        expect(replay.ok()).toBe(true);
        expect(await replay.json()).toEqual(result);
        expect(await read(rulePath)).toEqual(result);
      }
    });
    expect(await read(`alerts/${alert.id}`)).toEqual(initialAlert);
  }finally{
    try{ await restoreRules?.(); }finally{ await store.close(); }
  }
});

test('Ali @advisor-c6: deja en manos del operador atender y reasignar la alerta elegida',async({page,context,request},info)=>{
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7);
    const alternate=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable secundario ${code}`},actorId);
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(`${req.method()} ${path}`);
    });
    const dialog=page.getByRole('dialog',{name:'Atender alerta',exact:true});
    const holder=dialog.getByRole('combobox',{name:'Responsable',exact:true}), attentive=dialog.getByRole('checkbox',{name:'En atención',exact:true});
    for(const via of ['panel','chat','directorio']){
      const {alert,product}=await seedAdvisorAlert(store,{title:`Episodio de atención ${code} ${via}`,actorId,now:new Date().toISOString()});
      const path=`/api/admin/alerts/${alert.id}`, read=async()=>await (await context.request.get(path)).json();
      const card=page.locator(`[data-alert-id="${alert.id}"]`);
      await page.goto('/admin?section=business&tab=alerts&issue=stock_low');
      await card.getByRole('button',{name:/^Ver episodio:/}).click({timeout:8000});
      for(const [id,query,next] of [['alerts.acknowledge','marcar en atención',false],['alerts.assign','reasignar atención',true]])await test.step(`${via} · ${id}`,async()=>{
        const before=writes.length, prior=await read();
        expect(prior.state).toBe(next?'acknowledged':'open');
        const button=card.getByRole('button',{name:next?'Reasignar atención':'En atención / asignar',exact:true});
        if(via!=='panel'){
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${query}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(button).toBeFocused();
          await expect(dialog).toBeHidden();
        }
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===alert.id);
        await button.click();
        await expect(dialog.getByRole('heading',{name:prior.title,exact:true})).toBeVisible();
        await expect(dialog).toContainText(prior.reason);
        if(next){
          await expect(attentive).toBeChecked();
          await expect(attentive).toBeDisabled();
          await expect(holder).toHaveValue('');
          await holder.selectOption(alternate.id);
        }else{
          await expect(attentive).not.toBeChecked();
          await attentive.check();
        }
        await dialog.getByRole('textbox',{name:'Motivo del cambio',exact:true}).fill(`Decisión humana ${via} ${next?'reasignar':'atender'}`);
        expect(writes).toHaveLength(before);
        expect(await read()).toEqual(prior);
        const [response]=await Promise.all([
          page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===path,{timeout:8000}),
          dialog.getByRole('button',{name:'Guardar atención',exact:true}).click(),
        ]);
        expect(response.ok()).toBe(true);
        const record=await response.json();
        expect(record).toMatchObject({id:alert.id,episode:prior.episode,version:prior.version+1,state:'acknowledged',responsibleId:next?alternate.id:prior.responsibleId,reason:prior.reason,firstSeenAt:prior.firstSeenAt});
        await expect(dialog).toBeHidden();
        await expect(card).toContainText('En atención');
        if(next)await expect(card).toContainText(alternate.name);
        const sent=response.request();
        const replay=await context.request.put(path,{data:sent.postDataJSON(),headers:{origin:await sent.headerValue('origin'),'x-csrf-token':await sent.headerValue('x-csrf-token')}});
        expect(replay.ok()).toBe(true);
        expect(await replay.json()).toEqual(record);
        expect(await read()).toEqual(record);
        expect(writes.slice(before)).toEqual([`PUT ${path}`]);
      });
      expect(await store.get('products',product.id)).toMatchObject({version:product.version,stockQuantity:0});
    }
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: prepara y confirma guías locales en el pedido exacto',async({page,context,request,baseURL:appURL},info)=>{
  test.setTimeout(180000);
  const origin=new URL(appURL).origin, forbidden=[];
  await context.route(/^https?:\/\//,route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin&&!url.pathname.startsWith('/api/admin/shipping/'))return route.continue();
    forbidden.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),day=bogotaDate();
    const products=[];
    for(const suffix of ['A','B'])products.push(await store.save('products',{
      ...emptyRecord('products'),title:`Referencia envío ${code} ${suffix}`,slug:`c6-envio-${code}-${suffix.toLowerCase()}`,
      status:'draft',orderable:true,stockQuantity:100,presentation:'Unidad',price:13000,
    },null,null,actorId));
    const makeOrder=customerName=>store.saveOrder(businessOrderInput(products[0],{placedOn:day,customerName,items:products.map((product,index)=>({
      lineId:randomUUID(),kind:'products',itemId:product.id,quantity:[5,3][index],unitPriceMinor:product.price*100,discountMinor:0,
    }))}),actorId);
    const other=await makeOrder(`No seleccionado ${code}`);
    const otherShipment=await createShipment(store,{requestId:randomUUID(),orderId:other.id,carrier:'Logística sintética',tracking:`C6-${code}-AJENA`},actorId);
    const otherBefore=await store.order(other.id);
    const hekaSnapshot=()=>Promise.all([
      store.db.all(`SELECT id,state,guide_id,reconciled_at FROM ${store.t('heka_api_mutations')} ORDER BY id`),
      store.db.all(`SELECT guide_id,order_id,shipment_id FROM ${store.t('heka_api_order_links')} ORDER BY guide_id`),
    ]);
    const hekaBefore=await hekaSnapshot();
    const endpoint='/api/admin/business/shipments',writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!/^\/api\/admin\/assistant\/turns(?:\/|$)/.test(path))writes.push(`${req.method()} ${path}`);
    });
    const cases=[
      {id:'shipments.prepare-shipment',q:'borrador de envío',focus:'prepare'},
      {id:'shipments.create-shipment',q:'registrar guía local',focus:'create'},
      {id:'shipments.split-shipment',q:'repartir cantidades',focus:'split'},
      {id:'shipments.replace-shipment',q:'reemplazar envío',focus:'replace'},
    ];
    const editor=page.locator('dialog.editor-drawer[open]');
    const number=order=>`AN-${String(order.number).padStart(6,'0')}`;
    const heading=order=>editor.getByRole('heading',{name:number(order),exact:true});
    const summary=editor.locator('summary').filter({hasText:/^Registrar guía o entrega local$/});
    const form=summary.locator('..');
    const carrier=form.getByLabel('Transportadora',{exact:true}), tracking=form.getByLabel('Número de guía',{exact:true});
    const estimate=form.getByLabel('Entrega estimada',{exact:true}), replace=form.getByRole('combobox',{name:'Reemplaza a',exact:true});
    const split=form.getByRole('checkbox',{name:'Dividir envío',exact:true}), submit=form.getByRole('button',{name:'Registrar envío',exact:true});
    const targets={prepare:summary,create:submit,split,replace};
    const nav=editor.getByRole('navigation',{name:'Detalle del pedido'});
    const chooseShipments=()=>mobile?nav.getByRole('combobox').selectOption('shipments'):nav.getByRole('button',{name:'Envíos',exact:true}).click();
    const viaList=['panel','chat','directorio'];
    for(const flow of cases)await test.step(flow.id,async()=>{
      for(const via of viaList)await test.step(via,async()=>{
        const key=`${code}-${flow.focus}-${via}`,order=await makeOrder(`Pedido local ${key}`);
        const allocations=(a,b)=>order.items.map(({lineId},index)=>({lineId,quantity:[a,b][index]}));
        let original;
        if(flow.focus==='split'||flow.focus==='replace'){
          original=await createShipment(store,{requestId:randomUUID(),orderId:order.id,carrier:'Logística sintética anterior',tracking:`C6-${key}-ORIGINAL`,assignments:allocations(2,1)},actorId);
          if(flow.focus==='replace')original=await recordShipmentEvent(store,original.id,{requestId:randomUUID(),version:original.version,status:'incident',occurredOn:day,reason:'Novedad sintética antes de registrar sustitución'},actorId);
        }
        const before=await store.order(order.id),writeCount=writes.length;
        await page.goto(`/admin?section=orders&tab=list&q=${key}`);
        await page.getByRole('button',{name:`Abrir pedido ${number(order)}`,exact:true}).click();
        await expect(heading(order)).toBeVisible();
        const drawer=await editor.elementHandle(),href=page.url();
        if(via!=='chat'){
          await chooseShipments();
          await expect(summary).toBeVisible();
          await expect(form).toHaveJSProperty('open',false);
        }
        if(via==='panel')await summary.click();
        else{
          await editor.locator('footer').getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
          let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
          if(via==='chat')await askAli(entry,`¿Dónde está ${flow.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(flow.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${flow.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:12000});
          await expect(targets[flow.focus]).toBeFocused();
        }
        await expect(heading(order)).toBeVisible();
        await expect(heading(other)).toHaveCount(0);
        await expect(page).toHaveURL(href);
        expect(await editor.evaluate((node,previous)=>node===previous,drawer)).toBe(true);
        await drawer.dispose();
        await expect(form).toHaveJSProperty('open',true);
        await expect(targets[flow.focus]).toBeVisible();
        await expect(submit).toBeEnabled();
        await expect(split).not.toBeChecked();
        await expect(replace).toHaveValue('');
        await expect(replace.locator('option')).toHaveCount(original?2:1);
        await expect(replace.locator(`option[value="${otherShipment.id}"]`)).toHaveCount(0);
        await expect(carrier).toHaveValue('');
        await expect(tracking).toHaveValue('');
        await expect(estimate).toHaveValue('');
        expect(writes).toHaveLength(writeCount);
        expect(await store.order(order.id)).toEqual(before);
        if(via!=='panel')await screenshot(page,info,`advisor-c6-envio-${flow.focus}-${via}-foco`);

        const metadata={carrier:`Logística sintética ${code}`,tracking:`C6-${key}`,estimatedDeliveryOn:day};
        await carrier.fill(metadata.carrier);
        await tracking.fill(metadata.tracking);
        await estimate.fill(metadata.estimatedDeliveryOn);
        if(flow.focus==='split'){
          await split.check();
          for(const [index,quantity] of [1,2].entries()){
            const field=form.getByRole('spinbutton',{name:`${products[index].title} (comprado: ${order.items[index].quantity})`,exact:true});
            await expect(field).toHaveValue('0');
            await field.fill(String(quantity));
            await expect(field).toHaveValue(String(quantity));
          }
        }else if(flow.focus==='replace'){
          await expect(replace.locator(`option[value="${original.id}"]`)).toHaveText(`${original.tracking} · ${original.carrier}`);
          await replace.selectOption(original.id);
          await expect(replace).toHaveValue(original.id);
          await expect(split).toHaveCount(0);
        }
        expect(writes).toHaveLength(writeCount);
        expect(await store.order(order.id)).toEqual(before);
        await expect(editor.getByRole('status')).toContainText('Cambios sin guardar');
        if(flow.focus==='prepare'){
          const confirmation=page.waitForEvent('dialog');
          const closing=editor.getByRole('button',{name:'Cerrar',exact:true}).click();
          const discard=await confirmation;
          const message=discard.message();
          await discard.accept();
          await closing;
          expect(message).toMatch(/cambios sin guardar/i);
          await expect(editor).toHaveCount(0);
          expect(await store.order(order.id)).toEqual(before);
          expect(writes).toHaveLength(writeCount);
          return;
        }

        const wrote=page.waitForResponse(res=>new URL(res.url()).pathname===endpoint&&res.request().method()==='POST');
        await submit.click();
        const response=await wrote;
        expect(response.status(),await response.text()).toBe(201);
        const {requestId,...payload}=response.request().postDataJSON();
        expect(requestId).toMatch(/^[\w-]{16,100}$/);
        expect(payload).toEqual({orderId:order.id,...metadata,replacesShipmentId:flow.focus==='replace'?original.id:null,
          ...(flow.focus==='split'?{assignments:allocations(1,2)}:{}),
        });
        const created=await response.json();
        await expect(editor.getByRole('heading',{name:metadata.tracking,exact:true})).toBeVisible();
        await expect(heading(order)).toBeVisible();
        await expect(tracking).toHaveValue('');
        await expect(submit).toBeEnabled();
        expect(writes.slice(writeCount)).toEqual([`POST ${endpoint}`]);
        const after=await store.order(order.id);
        expect(after.shipments).toHaveLength(before.shipments.length+1);
        const saved=after.shipments.find(row=>row.id===created.id);
        expect(saved).toMatchObject({orderId:order.id,...metadata,version:1,status:'unknown',events:[],sourceAsOf:null,sourceId:null,externalId:null,
          replacesShipmentId:flow.focus==='replace'?original.id:null,
          assignments:flow.focus==='create'?allocations(5,3):flow.focus==='split'?allocations(1,2):original.assignments,
        });
        expect(after.shipments.filter(row=>row.id!==created.id)).toEqual(before.shipments);
        const inactive=new Set(after.shipments.map(row=>row.replacesShipmentId).filter(Boolean));
        const active=after.shipments.filter(row=>!inactive.has(row.id));
        expect(order.items.map(({lineId})=>active.flatMap(row=>row.assignments).filter(line=>line.lineId===lineId).reduce((sum,line)=>sum+line.quantity,0)))
          .toEqual(flow.focus==='create'?[5,3]:flow.focus==='split'?[3,3]:[2,1]);
        expect(after).toMatchObject({version:before.version,status:before.status,items:before.items,totalMinor:before.totalMinor,
          dispatchedOn:null,deliverySummary:before.deliverySummary,inventory:before.inventory,recognition:before.recognition,
        });
        if(via==='directorio')await screenshot(page,info,`advisor-c6-envio-${flow.focus}-persistido`);
      });
    });
    expect(forbidden).toEqual([]);
    expect(await hekaSnapshot()).toEqual(hekaBefore);
    expect(await store.order(other.id)).toEqual(otherBefore);
    expect(writes).toEqual(Array.from({length:9},()=>`POST ${endpoint}`));
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: abre la fuente exacta de la alerta sin cambiar el registro',async({page,context,request},info)=>{
  test.setTimeout(150000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),day=bogotaDate();
    const command=input=>({requestId:randomUUID(),...input});
    const {product}=await seedAdvisorAlert(store,{title:`Producto origen alerta ${code}`,actorId,now:new Date().toISOString()});
    const forOrder=await store.save('products',{...emptyRecord('products'),title:`Producto pedido alerta ${code}`,slug:`producto-pedido-alerta-${code}`,status:'draft',price:10000,presentation:'Unidad',stockQuantity:10,orderable:true},null,null,actorId);
    const order=await store.saveOrder(businessOrderInput(forOrder,{placedOn:day,customerName:`Pedido de alerta ${code}`}),actorId);
    const orphan=await createShipment(store,command({carrier:`Origen local ${code}`,tracking:`HUERFANA-${code}`}),actorId);
    const linked=await createShipment(store,command({carrier:`Segunda guía ${code}`,tracking:`PEDIDO-${code}`,orderId:order.id}),actorId);
    const person=await saveResource(store,'people',command({name:`Caja responsable alerta ${code}`}),actorId);
    const account=await saveAccount(store,command({type:'cash',name:`Caja origen alerta ${code}`,responsibleId:person.id,openingOn:day,openingBalanceMinor:1230000,minimumMinor:1500000}),actorId);
    const platform=await saveResource(store,'platforms',command({name:`Origen de alerta ${code}`}),actorId);
    const source=await saveResource(store,'sources',command({platformId:platform.id,name:`Cuenta externa exacta ${code}`}),actorId);
    const closing=await closeCash(store,command({accountId:account.id,closingOn:day,countedMinor:1200000}),actorId);
    const sale=await store.saveOrder(businessOrderInput(forOrder,{placedOn:day,customerName:`Recaudo de alerta ${code}`}),actorId);
    const gathering=await createShipment(store,command({orderId:sale.id,platformId:platform.id,sourceId:source.id,carrier:'Operador sintético',tracking:`PENDIENTE-${code}`}),actorId);
    const collection=await recordCollection(store,command({orderId:sale.id,version:(await store.order(sale.id)).version,shipmentId:gathering.id,holder:'platform',amountMinor:800000,occurredOn:day,method:'Contraentrega',reference:`REC-${code}`}),actorId);
    const settlement=await saveSettlement(store,command({sourceId:source.id,externalKey:`LIQ-${code}`,reportedOn:day,netMinor:800000,lines:[{collectionId:collection.id,grossMinor:800000,deductions:[]}]}),actorId);
    const expense=await recordExpense(store,command({category:'operating',concept:`Gasto alertado ${code}`,amountMinor:160000,incurredOn:day}),actorId);
    const historicalAlert=async(type,entityType,entityId)=>{
      const rule=await store.db.get(`SELECT id FROM ${store.t('alert_rules')} WHERE type=?`,[type]);
      const id=randomUUID(),at=new Date().toISOString();
      await insertRow(store,'alerts',{id,rule_id:rule.id,entity_type:entityType,entity_id:entityId,episode:1,state:'resolved',severity:'warning',first_seen_at:at,last_seen_at:at,responsible_id:null,version:1,data:JSON.stringify({reason:`Evidencia histórica sintética · ${code}`}),created_at:at,updated_at:at});
      return id;
    };
    await evaluateAlerts(store,{now:new Date().toISOString()});
    const alerts=async(type,entityId)=>{
      const alert=await store.db.get(`SELECT a.id FROM ${store.t('alerts')} a JOIN ${store.t('alert_rules')} r ON r.id=a.rule_id WHERE r.type=? AND a.entity_id=? AND a.state='open' ORDER BY a.episode DESC LIMIT 1`,[type,entityId]);
      expect(alert,`${type} ${entityId}`).toBeTruthy();
      return alert.id;
    };
    const orderNumber=`AN-${String(order.number).padStart(6,'0')}`;
    const cases=[
      {id:'alerts.open-stock',q:'existencias alertadas',alert:await alerts('stock_low',product.id),target:()=>page.getByRole('heading',{name:'Existencias y reservas',exact:true}),button:'Revisar existencias',check:async()=>{
        const dialog=page.getByRole('dialog',{name:'Editar producto',exact:true});
        await expect(dialog.locator('[name="title"]')).toHaveValue(product.title);
        await expect(dialog.locator('[name="stockQuantity"]')).toHaveValue('0');
      }},
      {id:'alerts.open-shipment',q:'envío alertado',alert:await alerts('business_data_missing',orphan.id),target:()=>page.getByRole('dialog',{name:orphan.tracking,exact:true}).getByRole('heading',{name:orphan.tracking,exact:true}),button:'Revisar envío',check:async()=>{
        await expect(page.getByRole('dialog',{name:orphan.tracking,exact:true}).getByText(new RegExp(`^${orphan.carrier} · Origen manual`))).toBeVisible();
        await expect(page.getByRole('button',{name:'Vincular pedido conocido',exact:true})).toBeVisible();
      }},
      {id:'alerts.open-order',q:'ver pedido alertado',alert:await alerts('business_data_missing',linked.id),target:()=>page.getByRole('heading',{name:'2. Productos y valor acordado',exact:true}),button:`Abrir pedido ${orderNumber}`,check:async()=>{
        const dialog=page.getByRole('dialog',{name:orderNumber,exact:true});
        await expect(dialog.locator('[name="customerName"]')).toHaveValue(order.customerName);
        await expect(dialog.getByRole('combobox',{name:'Referencia 1',exact:true}).locator('option:checked')).toContainText(forOrder.title);
      }},
      {id:'alerts.open-account',q:'ver cuenta alertada',alert:await alerts('cash_below_minimum',account.id),target:()=>page.getByRole('heading',{name:account.name,exact:true}).last(),button:'Revisar cuenta',check:async()=>{
        const cashDetail=page.locator('.cash-detail').filter({has:page.getByRole('heading',{name:account.name,exact:true})});
        await expect(cashDetail).toContainText(/\$\s*12[.]300/);
        await expect(cashDetail).toContainText(/\$\s*15[.]000/);
      }},
      {id:'alerts.open-source',q:'archivo desactualizado de una cuenta',alert:await historicalAlert('platform_not_updated','source',source.id),target:()=>page.locator('[data-advisor-control="import-new-with-source"]'),button:'Importar archivo de esta cuenta',check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('batch')==='new'&&url.searchParams.get('source')===source.id);
        await expect(page.locator('[data-advisor-control="import-new-with-source"]')).toContainText(source.name);
        await expect(page.getByLabel('Archivo Excel',{exact:true})).toHaveValue('');
      }},
      {id:'alerts.open-closing',q:'detalle de cierre alertado',alert:await alerts('cash_difference',closing.id),target:()=>page.locator('[data-advisor-control="cash-closing-open-detail"]'),button:'Revisar cierre',check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('account')===account.id&&url.searchParams.get('record')===closing.id);
        const detail=page.locator('.cash-detail').filter({has:page.getByRole('heading',{name:`Cierre del ${day}`,exact:true})});
        await expect(detail).toContainText(/\$\s*12[.]000/);
        await expect(detail.getByRole('button',{name:'Reabrir cierre con motivo',exact:true})).toBeVisible();
      }},
      {id:'alerts.open-settlement',q:'liquidación alertada',alert:await historicalAlert('business_data_missing','settlement',settlement.id),target:()=>page.locator('[data-advisor-control="cash-settlement-open-detail"]'),button:'Revisar liquidación',check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===settlement.id);
        await expect(page.locator('.cash-detail')).toContainText(/\$\s*8[.]000/);
      }},
      {id:'alerts.open-expense',q:'completar gasto alertado',alert:await historicalAlert('business_data_missing','expense',expense.id),target:()=>page.locator('[data-advisor-control="cash-expense-open-detail"]'),button:'Completar gasto',check:async()=>{
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===expense.id);
        await expect(page.getByRole('heading',{name:`Detalle · ${expense.concept}`,exact:true})).toBeVisible();
      }},
    ];
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:alerts|products|business|finance|orders|imports)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    const readAlert=async id=>await (await context.request.get(`/api/admin/alerts/${id}`)).json();
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      const initial=await readAlert(fixture.alert);
      for(const via of ['panel','chat','directorio']){
        await page.goto(`/admin?section=business&tab=alerts&record=${fixture.alert}&status=resolved`);
        const card=page.locator(`[data-alert-id="${fixture.alert}"][aria-current="true"]`);
        await expect(card).toContainText(initial.reason);
        if(via==='panel')await card.getByRole('button',{name:fixture.button,exact:true}).click({timeout:7000});
        else{
          let entry=await openAli(page);
          if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:30000});
          await expect(fixture.target()).toBeFocused();
        }
        await fixture.check();
      }
      expect(await readAlert(fixture.alert)).toEqual(initial);
    });
    expect(writes).toEqual([]);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva revisión, entregas, diario y captura de la campaña exacta', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  const app = new URL(info.project.use.baseURL);
  if (app.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(app.hostname)) throw new Error('La evidencia requiere la aplicación HTTPS descartable local.');
  const root = '/api/admin/social', forbidden = [];
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== app.origin || req.method() !== 'GET' && url.pathname.startsWith(`${root}/`)) {
      forbidden.push(`${req.method()} ${req.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const csrfRead = page.waitForRequest(req => new URL(req.url()).pathname.startsWith('/api/admin/') && Boolean(req.headers()['x-csrf-token']));
  await page.goto('/admin');
  const headers = { Origin: app.origin, 'x-csrf-token': await (await csrfRead).headerValue('x-csrf-token') };
  async function json(path, data) {
    const response = data ? await context.request.post(path, { headers, data: { requestId: randomUUID(), ...data } }) : await context.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const detail = id => json(`${root}/campaigns/${id}`);
  const f = await seedResults({ marker: `evidencia-ali-${randomUUID()}`, get: json, campaign: detail, post: json }, { campaignEvidence: true });
  trackFixtureConnection(info,f.connectionId);
  const draft = await json(`${root}/campaigns`, { name: `Sin aprobación ${randomUUID()}`, mode: 'organic', objective: 'engagement' });
  const before = await detail(f.id), draftBefore = await detail(draft.id);
  const [revision] = before.revisions;
  const facebook = before.deliveries.find(item => item.channel === 'facebook');
  const instagram = before.deliveries.find(item => item.channel === 'instagram');
  const filters = { integrationMethod: 'api', dimension: 'aggregate' };
  const results = () => json(`${root}/results?${new URLSearchParams({ campaignId: f.id, ...filters })}`);
  const beforeResults = await results();
  const capture = beforeResults.measurements.find(item => item.id === f.captureId);
  expect(before).toMatchObject({ state: 'partial', caption: 'Texto actual de la publicación' });
  expect(revision).toMatchObject({ spec: { caption: 'Texto congelado en la aprobación' }, rightsAccepted: true, acceptedWarnings: ['organicDistribution'] });
  expect(new Set([revision.spec.publishAt, facebook.publishedAt, facebook.lastConfirmedAt]).size).toBe(3);
  expect(capture).toMatchObject({ deliveryId: facebook.id, values: { interactions: { value: 0, status: 'reported', precision: 'exact' } } });
  expect(draftBefore).toMatchObject({ state: 'draft', revisions: [], deliveries: [], operations: [] });

  const href = (tab, id, extra = {}) => `/admin?${new URLSearchParams({ section: 'advertising', tab, record: id, ...extra })}`;
  const fact = (scope, name) => scope.getByText(name, { exact: true }).locator('..').locator('dd');
  const savedTime = (scope, name, value) => expect(fact(scope, name).locator('time')).toHaveAttribute('datetime', value);
  const summary = (scope, label) => scope.locator('summary').and(scope.getByText(label, { exact: true }));
  async function disclose(control) {
    const section = control.locator('..');
    if (await section.getAttribute('open') === null) await control.click();
    await expect(section).toHaveAttribute('open', '');
    return section;
  }
  async function openVia(via, read) {
    let entry = await openAli(page);
    if (via === 'chat') await askAli(entry, `¿Dónde está ${read.query}?`);
    else {
      await entry.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
      entry = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
      await entry.getByLabel('Área').selectOption('advertising');
      await entry.getByRole('searchbox', { name: 'Buscar una acción' }).fill(read.query);
      await entry.getByRole('button', { name: 'Buscar', exact: true }).click();
    }
    await entry.locator(`[data-capability-id="${read.id}"]`).getByRole('button', { name: /^Abrir en el panel:/ }).click();
  }
  const reads = [
    {
      id: 'advertising.read-approved-revision', query: 'ver aprobación', tab: 'campaigns',
      target: () => page.getByRole('heading', { name: 'Configuración aprobada · Solo lectura', exact: true }),
      async prove(target) {
        const section = target.locator('..');
        await expect(section.getByText(`Versión aprobada ${revision.revision}.`, { exact: false })).toBeVisible();
        await expect(fact(section, 'Texto')).toHaveText(revision.spec.caption);
        await expect(section.getByText(before.caption, { exact: true })).toHaveCount(0);
        await savedTime(section, 'Fecha de aprobación', revision.approvedAt);
        await expect(fact(section, 'Derechos de imagen o video y audio')).toHaveText('Aceptados');
        await expect(fact(section, 'Advertencias aceptadas')).toHaveText(revision.acceptedWarnings[0]);
        await expect(fact(section, 'Hash de especificación')).toHaveText(revision.specHash);
        await expect(fact(section, 'ID de estimación')).toHaveText(revision.forecastId);
        await expect((await disclose(summary(section, 'Estimación conservada al aprobar'))).getByRole('heading', { name: '2. Rango histórico comparable' })).toBeVisible();
      },
    },
    {
      id: 'advertising.read-delivery-status', query: 'progreso por red', tab: 'campaigns',
      target: () => page.getByRole('heading', { name: 'Estado por destino', exact: true }),
      async prove(target, via) {
        const section = target.locator('..');
        await expect(section.getByText(/Cada red se confirma por separado/)).toBeVisible();
        const first = section.getByRole('article', { name: 'Página de Facebook · Publicada' });
        const chosen = section.getByRole('article', { name: 'Cuenta profesional de Instagram · Fallida' });
        const firstEvidence = summary(first, 'Evidencia y próximas lecturas'), chosenEvidence = summary(chosen, 'Evidencia y próximas lecturas');
        await expect(firstEvidence.locator('..')).not.toHaveAttribute('open');
        await expect(chosenEvidence.locator('..')).not.toHaveAttribute('open');
        if (via === 'chat') await screenshot(page, info, 'advisor-c6-grupo-entregas');
        const selected = await disclose(chosenEvidence);
        await expect(firstEvidence.locator('..')).not.toHaveAttribute('open');
        await expect(fact(selected, 'ID de entrega')).toHaveText(instagram.id);
        await expect(fact(selected, 'Revisión de la entrega')).toHaveText(String(instagram.revision));
        await expect(fact(selected, 'ID remoto')).toHaveText('No confirmado');
        await expect(fact(chosen, 'Último estado confirmado')).toHaveText('Sin confirmación remota');
        await expect(fact(chosen, 'Confirmación remota')).toHaveText('Sin fecha');
        await savedTime(selected, 'Fecha prevista (revisión aprobada)', revision.spec.publishAt);
        const confirmed = await disclose(firstEvidence);
        await expect(fact(confirmed, 'ID de entrega')).toHaveText(facebook.id);
        await expect(fact(confirmed, 'ID remoto')).toHaveText(facebook.remoteId);
        await savedTime(confirmed, 'Envío registrado (no hora de publicación)', facebook.publishedAt);
        await savedTime(first, 'Confirmación remota', facebook.lastConfirmedAt);
      },
    },
    {
      id: 'advertising.read-operation-history', query: 'estado de operación publicitaria', tab: 'campaigns',
      target: () => summary(page, 'Historial técnico de operaciones y recuperación'),
      async prove(target) {
        const history = await disclose(target);
        for (const [delivery, localState] of [[instagram, 'Fallida'], [facebook, 'Confirmada']]) {
          const op = before.operations.find(item => item.deliveryId === delivery.id);
          const row = history.getByRole('article').filter({ hasText: op.id });
          await expect(row.getByRole('heading', { name: `publish · ${localState}`, exact: true })).toBeVisible();
          await expect(fact(row, 'Entrega')).toHaveText(delivery.id);
          await savedTime(row, 'Actualización guardada', op.updatedAt);
          if (op.lastError) await expect(row.getByText(op.lastError.message)).toBeVisible();
        }
      },
    },
    {
      id: 'advertising.inspect-result-capture', query: 'ratios y métricas sin dato', tab: 'results',
      target: () => summary(page, 'Métricas completas, capturas y estado por destino'),
      async prove(target, via) {
        const disclosure = await disclose(target);
        const record = disclosure.locator(`#social-measurement-${capture.id}`);
        await expect(record.getByText('Conexión oficial de Meta (API) · Publicación sin inversión', { exact: true })).toBeVisible();
        await expect(record.locator('time')).toHaveAttribute('datetime', capture.fetchedAt);
        const metric = record.getByRole('heading', { name: 'Interacciones', exact: true }).locator('..');
        await expect(metric.getByText('0', { exact: true })).toBeVisible();
        await expect(metric.getByText('Reportado · Precisión exacta de lectura', { exact: true })).toBeVisible();
        const metricEvidence = await disclose(summary(metric, 'Evidencia de la métrica'));
        await expect(metricEvidence.getByText(`Definición original: ${capture.values.interactions.sourceMetric}`, { exact: false })).toBeVisible();
        const evidence = await disclose(summary(record, 'Definición, cobertura y evidencia de esta captura'));
        await expect(fact(evidence, 'ID de captura')).toHaveText(capture.id);
        await expect(fact(evidence, 'Entrega')).toHaveText(facebook.id);
        await expect(fact(evidence, 'Definición')).toHaveText(capture.definitionVersion);
        await expect(fact(evidence, 'Cobertura')).toContainText('"complete":true');
        if (via === 'directorio') await screenshot(page, info, 'advisor-c6-captura-exacta');
      },
    },
  ];
  for (const read of reads) await test.step(read.id, async () => {
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const opposite = read.tab === 'campaigns' ? 'results' : 'campaigns';
      await page.goto(via === 'directorio' ? href(read.tab, f.id, read.tab === 'results' ? filters : {}) : href(opposite, f.id));
      await expect(page.getByRole('heading', { name: f.name, exact: true })).toBeVisible();
      if (via === 'panel') await page.getByRole('button', { name: read.tab === 'campaigns' ? 'Administrar publicación' : 'Ver resultados', exact: true }).click();
      else await openVia(via, read);
      await expect(page).toHaveURL(url => url.searchParams.get('record') === f.id && url.searchParams.get('tab') === read.tab);
      const target = read.target();
      await expect(target).toBeVisible();
      if (via !== 'panel') await expect(target).toBeFocused();
      if (via === 'directorio' && read.tab === 'results') {
        await expect(page).toHaveURL(url => Object.entries(filters).every(([key, value]) => url.searchParams.get(key) === value));
      }
      await read.prove(target, via);
    });
  });

  await test.step('ausencias y filtros no fabrican datos', async () => {
    await page.goto(href('campaigns', draft.id));
    await openVia('directorio', reads[0]);
    const noApproval = page.getByRole('heading', { name: 'Sin configuración aprobada' });
    await expect(noApproval).toBeFocused();
    await expect(noApproval.locator('..')).toContainText('No hay una revisión aprobada guardada.');
    await expect(noApproval.locator('..').locator('time')).toHaveCount(0);
    await openVia('chat', reads[1]);
    await expect(reads[1].target()).toBeFocused();
    await expect(reads[1].target().locator('..')).toContainText('Sin entregas registradas para esta campaña.');
    await openVia('directorio', reads[2]);
    await expect(reads[2].target()).toBeFocused();
    await expect((await disclose(reads[2].target())).getByText('No hay operaciones guardadas para esta campaña.')).toBeVisible();
    await openVia('chat', reads[3]);
    const noDeliveries = page.getByText('Sin entregas; aún no hay rendimiento que analizar.', { exact: false });
    await expect(noDeliveries).toBeFocused();
    await expect(page).toHaveURL(url => url.searchParams.get('record') === draft.id && url.searchParams.get('tab') === 'results');

    await page.goto(href('results', f.id, { ...filters, scope: 'paid' }));
    await openVia('directorio', reads[3]);
    await expect(reads[3].target()).toBeFocused();
    await expect(page).toHaveURL(url => url.searchParams.get('scope') === 'paid');
    const filtered = await disclose(reads[3].target());
    await expect(filtered.getByRole('heading', { name: 'Sin capturas en esta selección' })).toBeVisible();
    await expect(filtered.getByText(/No disponible no equivale a cero/)).toBeVisible();
    await expect(filtered.locator(`#social-measurement-${capture.id}`)).toHaveCount(0);
  });

  const evidenceState = ({ state, version, revisions, deliveries, operations }) => ({ state, version, revisions, deliveries, operations });
  expect(evidenceState(await detail(f.id))).toEqual(evidenceState(before));
  expect(evidenceState(await detail(draft.id))).toEqual(evidenceState(draftBefore));
  expect((await results()).measurements.map(({ id, deliveryId, fetchedAt, values }) => ({ id, deliveryId, fetchedAt, values })))
    .toEqual(beforeResults.measurements.map(({ id, deliveryId, fetchedAt, values }) => ({ id, deliveryId, fetchedAt, values })));
  expect(forbidden).toEqual([]);
});

test('Ali @advisor-c6: vuelve al lanzador y al índice nativos con teclado',async({page,request},info)=>{
  test.setTimeout(60000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const writes=[];
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(path);
  });
  const arm=page.getByRole('banner').getByRole('button',{name:/^Ir a…/});
  const launcher=page.getByRole('dialog',{name:'Ir a…',exact:true});
  const toggle=page.locator('details.home-task-directory > summary');
  const cases=[
    {id:'home.task-launcher',q:'buscar sección',target:arm,choose:async()=>{
      const input=launcher.getByRole('textbox',{name:'Buscar sección o acción',exact:true});
      await expect(input).toBeFocused();
      await input.press('Escape');
      await expect(launcher).toBeHidden();
      await expect(arm).toBeFocused();
      await arm.press('Enter');
      await input.fill('seguimiento de envíos');
      const result=launcher.getByRole('button',{name:'Seguimiento de envíos',exact:true});
      await expect(result).toBeVisible();
      await input.press('ArrowDown');
      await expect(result).toBeFocused();
      await result.press('Enter');
      await expect(launcher).toBeHidden();
    }},
    {id:'home.task-directory',q:'más secciones',target:toggle,choose:async()=>{
      const directory=toggle.locator('..');
      const button=directory.getByRole('button',{name:'Seguimiento de envíos',exact:true});
      await expect(directory.getByRole('region',{name:'Pedidos y envíos',exact:true})).toBeVisible();
      await expect(button).toBeVisible();
      await button.press('Enter');
    }},
  ];
  for(const fixture of cases)await test.step(fixture.id,async()=>{
    for(const via of ['panel','chat','directorio']){
      await page.goto('/admin');
      if(via==='panel')await fixture.target.click();
      else{
        let entry=await openAli(page);
        if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(fixture.target).toBeFocused();
        await expect(fixture.target).toHaveCSS('outline-style','solid');
        await expect(page).toHaveURL(/\/admin$/);
        await fixture.target.press('Enter');
      }
      await fixture.choose();
      await expect(page).toHaveURL(url=>url.searchParams.get('section')==='orders'&&url.searchParams.get('tab')==='shipments');
      await expect(page.getByRole('region',{name:'Seguimiento de envíos',exact:true}).getByRole('searchbox',{name:'Buscar guía o número AN',exact:true})).toBeVisible();
    }
  });
  expect(writes).toEqual([]);
});

test('Ali @advisor-c6: consulta, abre y configura la cuenta elegida sin repetir su apertura', async ({ page, context, request }, info) => {
  test.setTimeout(180000);
  const dbEnv = testDatabaseEnv(), app = new URL(info.project.use.baseURL);
  const local = value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  if (app.protocol !== 'https:' || ![app.href, controlURL, baseURL, dbEnv.DATABASE_URL].every(local)) {
    throw new Error('La evidencia requiere aplicación, proveedor simulado y PostgreSQL descartable locales.');
  }
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(dbEnv);
  try {
    const actorId = await fixtureActor(context, store), code = randomUUID().slice(0, 7), day = bogotaDate();
    const accountsView = '/admin?section=business&tab=accounts', accountAPI = '/api/admin/business/accounts';
    const person = name => saveResource(store, 'people', { requestId: randomUUID(), name: `${name} ${code}` }, actorId);
    const responsible = await person('Responsable de apertura'), replacement = await person('Responsable de edición');
    const seed = (name, data = {}) => saveAccount(store, {
      requestId: randomUUID(), name: `${name} ${code}`, type: 'cash', openingOn: day, openingBalanceMinor: 125043,
      responsibleId: responsible.id, ...data,
    }, actorId);
    const available = await seed('Caja disponible');
    const ruled = await seed('Caja con regla', { closingEnabled: true, closingTime: '17:45', toleranceMinor: 1000 });
    const bank = await seed('Banco de contraste', { type: 'bank' });
    const archivedBank = await seed('Banco fuera de uso', { type: 'bank' });
    await saveAccount(store, { requestId: randomUUID(), version: archivedBank.version, active: false }, actorId, archivedBank.id);
    const writes = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (req.method() !== 'GET' && /^\/api\/admin\/(?:business|finance|orders|reports)(?:\/|$)/.test(path)) writes.push(`${req.method()} ${path}`);
    });
    const accountIds = async () => (await listResources(store, 'accounts')).map(row => row.id).sort();
    const snapshot = async id => ({
      movements: await store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`, [id]),
      closings: await store.db.all(`SELECT * FROM ${store.t('cash_closings')} WHERE account_id=? ORDER BY id`, [id]),
    });
    const read = async path => {
      const response = await context.request.get(path);
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const sales = async () => (await read('/api/admin/reports?mode=live&period=month')).metrics.netProductSales;
    const salesBefore = await sales();
    const accounts = () => page.getByRole('region', { name: 'Cuentas de caja y bancos', exact: true });
    const row = name => accounts().getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
    const drawer = () => page.getByRole('dialog', { name: /^(Crear|Editar) cuenta$/ });
    const field = name => drawer().locator(`[name="${name}"]`);
    const checkboxNames = { active: 'Cuenta activa para nuevos movimientos', closingEnabled: 'Exigir cierre diario de esta caja' };
    const cases = [
      { id: 'view-account-settings', query: 'ajustes de cuentas', target: () => accounts().getByRole('heading', { name: 'Cuentas de caja y bancos' }) },
      { id: 'create-account', query: 'crear billetera', target: () => accounts().getByRole('button', { name: 'Crear cuenta', exact: true }) },
      { id: 'edit-account', query: 'cambiar saldo mínimo', choice: 'Cuenta para editar', seed: 'Cuenta para corregir' },
      { id: 'archive-account', query: 'archivar cuenta', choice: 'Cuenta para archivar', seed: 'Caja para archivar', field: 'active', next: false, contrast: archivedBank },
      { id: 'reactivate-account', query: 'reactivar cuenta', choice: 'Cuenta para reactivar', seed: 'Caja para reactivar', archived: true, field: 'active', next: true, contrast: bank },
      { id: 'enable-closing-rule', query: 'activar cierre diario', choice: 'Caja para exigir cierre diario', seed: 'Caja para exigir cierre', field: 'closingEnabled', next: true, contrast: ruled },
      { id: 'disable-closing-rule', query: 'quitar cierre obligatorio', choice: 'Caja para retirar la obligación de cierre', seed: 'Caja con cierre anterior', rule: true, field: 'closingEnabled', next: false, contrast: available },
    ];
    async function handoff(fixture, via) {
      if (via === 'panel') {
        if (fixture.id === 'view-account-settings') {
          await page.goto('/admin?section=cash&tab=overview');
          await page.getByRole('button', { name: 'Configurar cuentas', exact: true }).click();
        } else await page.goto(accountsView);
        if (fixture.id === 'edit-account') await accounts().getByText('Elegir cuenta para editar', { exact: true }).click();
      } else {
        await page.goto('/admin');
        let entry;
        if (via === 'chat') {
          entry = await openAli(page);
          await askAli(entry, `¿Dónde está ${fixture.query}?`);
        } else {
          await page.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
          entry = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
          await entry.getByLabel('Área').selectOption('cash');
          await entry.getByRole('searchbox', { name: 'Buscar una acción' }).fill(fixture.query);
          await entry.getByRole('button', { name: 'Buscar', exact: true }).click();
        }
        await entry.locator(`[data-capability-id="cash.${fixture.id}"]`).getByRole('button', { name: /^Abrir en el panel:/ }).click();
        const focus = fixture.target?.() || accounts().getByRole('combobox', { name: fixture.choice, exact: true });
        await expect(focus).toBeFocused();
        await expect(focus).toBeInViewport();
      }
      await expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'accounts');
      await expect(drawer()).toHaveCount(0);
    }
    async function persist({ id, before, expected, afterClick }) {
      const method = id ? 'PUT' : 'POST', path = id ? `${accountAPI}/${id}` : accountAPI;
      const response = page.waitForResponse(res => res.request().method() === method && new URL(res.url()).pathname === path);
      await drawer().getByRole('button', { name: id ? 'Guardar cuenta' : 'Crear cuenta', exact: true }).click();
      const saved = await response, req = saved.request(), payload = req.postDataJSON();
      expect(saved.status(), await saved.text()).toBe(id ? 200 : 201);
      const account = await saved.json();
      expect(account).toMatchObject(expected);
      await expect(drawer()).toHaveCount(0);
      expect(writes.slice(before)).toEqual([`${method} ${path}`]);
      if (id) {
        expect(payload).not.toHaveProperty('openingBalanceMinor');
        expect(payload).toMatchObject({ version: expected.version - 1, openingOn: day, type: expected.type });
      }
      await afterClick?.(account);
      const retry = await context.request.fetch(saved.url(), { method, data: payload, headers: {
        origin: await req.headerValue('origin'), 'x-csrf-token': await req.headerValue('x-csrf-token'),
      } });
      expect(retry.status(), await retry.text()).toBe(saved.status());
      expect(await retry.json()).toEqual(account);
      await page.reload();
      await expect(row(account.name)).toContainText(`${account.active ? 'Activa' : 'Archivada'} · apertura ${day}`);
      expect(await read(`${accountAPI}/${account.id}`)).toMatchObject(expected);
      return account;
    }
    for (const fixture of cases) for (const via of ['panel', 'chat', 'directorio']) {
      await test.step(`cash.${fixture.id} desde ${via}`, async () => {
        let account, prior, stored;
        if (fixture.seed) {
          account = await seed(`${fixture.seed} ${via}`, fixture.rule ? { closingEnabled: true, closingTime: '18:40', toleranceMinor: 1700 } : {});
          if (fixture.archived) account = await saveAccount(store, { requestId: randomUUID(), version: account.version, active: false }, actorId, account.id);
          if (fixture.rule) await closeCash(store, { requestId: randomUUID(), accountId: account.id, closingOn: day, countedMinor: 125043 }, actorId);
          prior = await snapshot(account.id);
          stored = await read(`${accountAPI}/${account.id}`);
        }
        const before = writes.length, startingIds = await accountIds();
        await handoff(fixture, via);
        expect(writes).toHaveLength(before);
        expect(await accountIds()).toEqual(startingIds);
        if (fixture.id === 'view-account-settings') {
          await expect(row(available.name)).toContainText(`Activa · apertura ${day}`);
          await expect(row(archivedBank.name)).toContainText(`Archivada · apertura ${day}`);
          await expect(accounts()).toContainText('crearlas no registra una venta ni un recaudo');
          return;
        }
        if (fixture.id === 'create-account') {
          const type = { panel: 'cash', chat: 'bank', directorio: 'wallet' }[via];
          const opening = { panel: ['0', 0], chat: ['1.250,43', 125043], directorio: ['700,01', 70001] }[via];
          const name = `Apertura C6 ${code} ${via}`;
          await fixture.target().click();
          await expect(field('name')).toBeEnabled();
          await expect(field('name')).toHaveValue('');
          await expect(field('type')).toHaveValue('');
          await expect(field('responsibleId')).toHaveValue('');
          await expect(field('openingBalanceMinor')).toHaveValue('');
          expect(writes).toHaveLength(before);
          await field('name').fill(name);
          await field('type').selectOption(type);
          await field('responsibleId').selectOption(responsible.id);
          await field('openingOn').fill(day);
          await field('openingBalanceMinor').fill(opening[0]);
          expect(await accountIds()).toEqual(startingIds);
          const saved = await persist({ before, expected: { name, type, openingOn: day, active: true, responsibleId: responsible.id, version: 1, closingEnabled: false }, afterClick: async created => {
            const ledger = await snapshot(created.id);
            expect(ledger.movements).toEqual([expect.objectContaining({ kind: 'opening', source_type: 'account', source_id: created.id, amount_minor: opening[1], effective_on: day })]);
            expect(ledger.closings).toEqual([]);
          } });
          const ledger = await read(`/api/admin/finance/movements?account=${saved.id}`);
          expect(ledger).toMatchObject({ total: 1, records: [expect.objectContaining({ kind: 'opening', amountMinor: opening[1], effectiveOn: day, sourceType: 'account', sourceId: saved.id })] });
          const detail = await read(`/api/admin/finance/movements?record=${ledger.records[0].id}`);
          expect(detail).toMatchObject({ accountId: saved.id, documentType: null });
          expect(await accountIds()).toEqual([...startingIds, saved.id].sort());
          return;
        }
        const loaded = page.waitForResponse(res => res.request().method() === 'GET' && new URL(res.url()).pathname === `${accountAPI}/${account.id}`);
        if (via === 'panel' && fixture.field) await row(account.name).getByRole('button', { name: 'Editar cuenta', exact: true }).click();
        else {
          const choice = accounts().getByRole('combobox', { name: fixture.choice, exact: true });
          const open = accounts().getByRole('button', { name: 'Abrir editor de cuenta', exact: true });
          await expect(choice).toHaveValue('');
          await expect(open).toBeDisabled();
          if (fixture.contrast) await expect(choice.locator(`option[value="${fixture.contrast.id}"]`)).toHaveCount(0);
          if (fixture.field === 'closingEnabled') await expect(choice.locator(`option[value="${bank.id}"]`)).toHaveCount(0);
          await choice.selectOption(account.id);
          await expect(drawer()).toHaveCount(0);
          expect(writes).toHaveLength(before);
          await open.click();
        }
        const fetched = await loaded;
        expect(fetched.ok()).toBe(true);
        expect(await fetched.json()).toEqual(stored);
        await expect(field('name')).toBeEnabled();
        await expect(field('name')).toHaveValue(account.name);
        await expect(field('openingOn')).toHaveValue(day);
        await expect(field('openingOn')).toBeDisabled();
        await expect(field('openingBalanceMinor')).toHaveCount(0);
        expect(writes).toHaveLength(before);
        expect(await read(`${accountAPI}/${account.id}`)).toEqual(stored);
        expect(await snapshot(account.id)).toEqual(prior);
        let changes;
        if (!fixture.field) {
          const name = `${account.name} corregida`, minimumMinor = 76543;
          await field('name').fill(name);
          await field('responsibleId').selectOption(replacement.id);
          await drawer().getByText('Mínimo y cierre de efectivo', { exact: true }).click();
          await field('minimumMinor').fill('765,43');
          changes = { name, minimumMinor, responsibleId: replacement.id };
        } else {
          if (via === 'panel' && fixture.field === 'closingEnabled') await drawer().getByText('Mínimo y cierre de efectivo', { exact: true }).click();
          const native = drawer().getByRole('checkbox', { name: checkboxNames[fixture.field], exact: true });
          if (via !== 'panel') {
            await expect(native).toBeFocused();
            await expect(native).toBeInViewport();
            await expect(drawer().getByRole('button', { name: 'Guardar cuenta', exact: true })).toBeDisabled();
            if (via === 'directorio' && fixture.id === 'enable-closing-rule') await screenshot(page, info, 'advisor-c6-caja-exigir-cierre');
          }
          await expect(native).toHaveJSProperty('checked', !fixture.next);
          await native.setChecked(fixture.next);
          changes = { [fixture.field]: fixture.next };
          if (fixture.id === 'enable-closing-rule') {
            await expect(field('closingTime')).toHaveValue('');
            await field('closingTime').fill('19:10');
            await field('toleranceMinor').fill('17,25');
            Object.assign(changes, { closingTime: '19:10', toleranceMinor: 1725 });
          }
        }
        expect(writes).toHaveLength(before);
        expect(await read(`${accountAPI}/${account.id}`)).toEqual(stored);
        await persist({ id: account.id, before, expected: { id: account.id, name: account.name, version: account.version + 1,
          active: account.active, closingEnabled: account.closingEnabled, responsibleId: responsible.id, type: account.type, openingOn: day, ...changes,
        } });
        expect(await accountIds()).toEqual(startingIds);
        expect(await snapshot(account.id)).toEqual(prior);
        expect((await read(`/api/admin/finance/movements?account=${account.id}`)).total).toBe(1);
        if (fixture.rule) {
          const recovered = await read(`/api/admin/finance/closings?account=${account.id}`);
          expect(recovered).toMatchObject({ total: 1, records: [expect.objectContaining({ id: prior.closings[0].id, state: 'closed', countedMinor: 125043 })] });
        }
      });
    }
    expect(await sales()).toEqual(salesBefore);
  } finally {
    await store.close();
  }
});
test('Ali @advisor-c6: conserva seis observaciones económicas reales de Inicio y sus hechos exactos', async ({ page, context, request }, info) => {
  test.setTimeout(180000);
  // Unknown dates from another scenario can affect even a closed historical period.
  await resetBrowserFixture();
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(testDatabaseEnv());
  let restorePolicy;
  try {
    const actorId = await fixtureActor(context, store), code = randomUUID().slice(0, 7);
    // Weeks reserved for this fixture, with an empty preceding week. Retries do not reuse the seeded range.
    const start = addC6ReportDays(info.project.name === 'mobile' ? '2018-06-04' : '2017-06-05', info.retry * 21);
    const date = offset => addC6ReportDays(start, offset);
    const prior = date(-7), dispatch = date(1), delivery = date(2), returned = date(3), returnedAgain = date(4), end = date(7);
    const period = 'week', call = body => ({ requestId: randomUUID(), ...body });
    const settings = await getBusinessSettings(store);
    const rule = { id: `c6-subconjuntos-${code}`, effectiveOn: start, saleRecognition: 'delivered', commission: { enabled: false }, shippingExpenseDate: 'dispatch_date', returnExpenseDate: 'charge_date', platformFeeExpenseDate: 'charge_date' };
    await saveBusinessSettings(store, call({ ...settings, rulesVersions: [...settings.rulesVersions, rule] }), actorId);
    restorePolicy = async () => {
      const current = await getBusinessSettings(store);
      if (current.rulesVersions.some(version => version.id === rule.id)) {
        await saveBusinessSettings(store, call({ ...current, rulesVersions: current.rulesVersions.filter(version => version.id !== rule.id) }), actorId);
      }
    };

    const seller = await saveResource(store, 'people', call({ name: `Vendedora positiva ${code}` }), actorId);
    const otherSeller = await saveResource(store, 'people', call({ name: `Vendedor excluido ${code}` }), actorId);
    const platform = await saveResource(store, 'platforms', call({ name: `Plataforma de informes ${code}` }), actorId);
    const product = (label, price, unitCostMinor) => store.save('products', {
      ...emptyRecord('products'), title: `Referencia ${label} ${code}`, slug: `c6-subconjunto-${label.toLowerCase()}-${code}`,
      status: 'draft', orderable: true, presentation: 'Unidad', price, unitCostMinor, costEffectiveOn: start, stockQuantity: 30,
    }, null, null, actorId);
    const alpha = await product('A', 60_000, 1_000_000);
    const beta = await product('B', 20_000, 1_800_000);
    const line = (p, quantity = 1, unitPriceMinor = p.price * 100) => ({ lineId: randomUUID(), kind: 'products', itemId: p.id, quantity, unitPriceMinor, discountMinor: 0 });
    async function sale(label, sellerId, items, shippingChargeMinor, freight, { outside = false, fee = null } = {}) {
      const placedOn = outside ? end : start, dispatchedOn = outside ? date(8) : dispatch, deliveredOn = outside ? date(9) : delivery;
      const order = await store.saveOrder(businessOrderInput(alpha, { placedOn, customerName: `Pedido ${label} ${code}`, sellerId, shippingChargeMinor, items }), actorId);
      let shipment = await createShipment(store, call({ orderId: order.id, ...(fee !== null ? { platformId: platform.id } : {}), carrier: `Transporte ${code}`, tracking: `C6-${code}-${label}`, estimatedDeliveryOn: deliveredOn }), actorId);
      shipment = await recordShipmentEvent(store, shipment.id, call({ version: shipment.version, status: 'collected', occurredOn: dispatchedOn }), actorId);
      await recordShipmentEvent(store, shipment.id, call({ version: shipment.version, status: 'delivered', occurredOn: deliveredOn }), actorId);
      await recordExpense(store, call({ shipmentId: shipment.id, category: 'shipping_out', concept: `Flete ${label} ${code}`, amountMinor: freight, incurredOn: deliveredOn }), actorId);
      if (fee !== null) await recordExpense(store, call({ shipmentId: shipment.id, category: 'platform_fee', concept: `Tarifa ${label} ${code}`, amountMinor: fee, incurredOn: deliveredOn }), actorId);
      const saved = await store.order(order.id);
      expect(saved.recognition).toMatchObject({ ruleVersionId: rule.id, basis: 'delivered', on: deliveredOn });
      expect(saved.items.map(row => row.unitCostMinor)).toEqual(items.map(row => row.itemId === alpha.id ? 1_000_000 : 1_800_000));
      return saved;
    }
    // Mixed line weights are 3:1: each shared charge is recorded once, not once per product.
    const mixed = await sale('MIXTO', seller.id, [line(alpha), line(beta)], 800_000, 400_000, { fee: 400_000 });
    const negative = await sale('NEGATIVO', otherSeller.id, [line(beta, 3)], 300_000, 1_000_000);
    const refundCredit = await sale('DEVOLUCION', seller.id, [line(alpha, 2)], 900_000, 300_000);
    const unassigned = await sale('SINVENDEDOR', null, [line(alpha)], 500_000, 500_000);
    const zero = await sale('CERO', otherSeller.id, [line(beta, 1, 1_800_000)], 200_000, 200_000);
    const outside = await sale('FUERA', seller.id, [line(alpha)], 500_000, 500_000, { outside: true });
    const leadingReason = `Empaque dañado ${code}`, otherReason = `Cambio de preferencia ${code}`;
    async function commercialReturn(order, occurredOn, reason, shippingCreditMinor = 0) {
      return registerReturn(store, call({ orderId: order.id, version: (await store.order(order.id)).version, occurredOn, reason, shippingCreditMinor,
        lines: [{ lineId: order.items[0].lineId, quantity: 1, condition: 'recoverable' }] }), actorId);
    }
    const dominant = await commercialReturn(refundCredit, returned, leadingReason, 100_000);
    await commercialReturn(negative, returned, otherReason);
    await commercialReturn(negative, returnedAgain, otherReason);
    await recordExpense(store, call({ category: 'operating', concept: `Operación observada ${code}`, amountMinor: 200_000, incurredOn: delivery }), actorId);

    // Literal expectations in centavos from the fixture above, not from the report or insight implementation.
    const sales = 'Ventas netas de productos', cost = 'Costo vendido', freight = 'Transporte y seguros', shipping = 'Flete cobrado reconocido', fees = 'Cargos de plataforma';
    const fact = (order, label, on, amount, dimension = null) => [order.id, label, on, amount, dimension];
    const mixedFacts = [fact(mixed, sales, delivery, 6_000_000), fact(mixed, cost, delivery, -1_000_000), fact(mixed, sales, delivery, 2_000_000), fact(mixed, cost, delivery, -1_800_000),
      fact(mixed, shipping, delivery, 800_000), fact(mixed, freight, dispatch, -400_000), fact(mixed, fees, delivery, -400_000)];
    const negativeFacts = [fact(negative, sales, delivery, 6_000_000), fact(negative, cost, delivery, -5_400_000), fact(negative, shipping, delivery, 300_000), fact(negative, freight, dispatch, -1_000_000),
      fact(negative, sales, returned, -2_000_000), fact(negative, cost, returned, 1_800_000), fact(negative, sales, returnedAgain, -2_000_000), fact(negative, cost, returnedAgain, 1_800_000)];
    const returnFacts = [fact(refundCredit, sales, delivery, 12_000_000), fact(refundCredit, cost, delivery, -2_000_000), fact(refundCredit, shipping, delivery, 900_000), fact(refundCredit, freight, dispatch, -300_000),
      fact(refundCredit, sales, returned, -6_000_000), fact(refundCredit, cost, returned, 1_000_000), fact(refundCredit, shipping, returned, -100_000)];
    const unassignedFacts = [fact(unassigned, sales, delivery, 6_000_000), fact(unassigned, cost, delivery, -1_000_000), fact(unassigned, shipping, delivery, 500_000), fact(unassigned, freight, dispatch, -500_000)];
    const by = (facts, dimension) => facts.map(([id, label, on, amount]) => [id, label, on, amount, dimension]);
    const cases = [
      { action: 'negative-contribution', issue: 'negative_contribution', query: 'desglose de contribución negativa', title: 'Pedidos con contribución negativa en el período',
        heading: 'Contribución negativa de pedidos en el período (no acumulada)', total: -500_000, summary: { orderCount: 1 }, home: /1 pedidos suman .* no es su rentabilidad acumulada/, facts: negativeFacts, excluded: [mixed, refundCredit, zero] },
      { action: 'positive-contribution', issue: 'positive_contribution', query: 'desglose positivo por pedido', title: 'Pedidos con contribución positiva, sin afirmar tendencia',
        heading: 'Contribución positiva de pedidos en el período (no acumulada)', total: 15_700_000, summary: { orderCount: 3 }, home: /Base: 5 pedidos completos; no hay historial comparable/, facts: [...mixedFacts, ...returnFacts, ...unassignedFacts], excluded: [negative, zero] },
      { action: 'positive-products', issue: 'positive_products', query: 'aporte positivo por producto', title: 'Productos con contribución positiva completa',
        heading: 'Contribución del período de productos con datos completos y saldo positivo', total: 15_500_000, summary: { groupCount: 1 }, home: /no es un ranking de desempeño ni una tendencia/, dimension: 'productId',
        facts: [...by([...returnFacts, ...unassignedFacts], alpha.id), fact(mixed, sales, delivery, 6_000_000, alpha.id), fact(mixed, cost, delivery, -1_000_000, alpha.id),
          fact(mixed, shipping, delivery, 600_000, alpha.id), fact(mixed, freight, dispatch, -300_000, alpha.id), fact(mixed, fees, delivery, -300_000, alpha.id)], excluded: [negative, zero], visibleGroup: alpha.title, excludedGroup: beta.title },
      { action: 'positive-sellers', issue: 'positive_sellers', query: 'contribución positiva por vendedor', title: 'Vendedores con contribución positiva completa',
        heading: 'Contribución del período de vendedores con datos completos y saldo positivo', total: 10_700_000, summary: { groupCount: 1 }, home: /no es un ranking de desempeño ni una tendencia/, dimension: 'sellerId',
        facts: by([...mixedFacts, ...returnFacts], seller.id), excluded: [unassigned, negative, zero], visibleGroup: seller.name, excludedGroup: otherSeller.name },
      { action: 'absorbed-shipping', issue: 'shipping_absorbed', metric: 'shippingCosts', query: 'flete absorbido', title: 'Transporte no cubierto por el flete del período',
        heading: 'Transporte menos flete reconocido en el período, solo pedidos con diferencia positiva', total: 700_000, summary: { orderCount: 1 }, home: /Las fechas de costo y venta pueden ser distintas; no prueba una pérdida acumulada/, dimension: 'sourceValue',
        facts: [fact(negative, freight, dispatch, 1_000_000, 1_000_000), fact(negative, shipping, delivery, -300_000, 300_000)], excluded: [mixed, refundCredit, unassigned, zero] },
      { action: 'costly-returns', issue: 'costly_returns', metric: 'returnedUnits', tab: 'returns', query: 'mayor crédito por devolución', title: 'Principal motivo de devolución por importe',
        heading: 'Créditos comerciales del principal motivo de devolución del período', total: 6_100_000, summary: { reason: leadingReason }, home: /Es importe acreditado, no pérdida ni reembolso pagado/,
        facts: [fact(refundCredit, leadingReason, returned, 6_100_000, dominant.id)], excluded: [mixed, negative, unassigned, zero] },
    ];
    const orderButton = order => `Abrir pedido AN-${String(order.number).padStart(6, '0')}`;
    const amount = formatC6ReportMoney;
    const dateLabel = day => day.split('-').reverse().join('/');
    const sorted = tuples => tuples.map(tuple => JSON.stringify(tuple)).sort();
    const detail = page.getByRole('region', { name: 'Registros exactos de la métrica' });
    const table = detail.getByRole('table', { name: 'Registros que explican la cifra', exact: true });
    const queryKey = reportQueryKey({ period, anchorDate: start, filters: {} });
    const orderIds = [mixed, negative, refundCredit, unassigned, zero, outside].map(order => order.id);
    const placeholders = orderIds.map(() => '?').join(',');
    const state = () => store.readSnapshot(async tx => ({
      rules: (await getBusinessSettings(tx)).version,
      orders: await tx.db.all(`SELECT * FROM ${tx.t('orders')} WHERE id IN (${placeholders}) ORDER BY id`, orderIds),
      returns: await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id IN (${placeholders}) ORDER BY id`, orderIds),
      collections: await tx.db.all(`SELECT * FROM ${tx.t('order_collections')} WHERE order_id IN (${placeholders}) ORDER BY id`, orderIds),
      expenses: await tx.db.all(`SELECT * FROM ${tx.t('expenses')} WHERE order_id IN (${placeholders}) ORDER BY id`, orderIds),
      saved: await tx.db.all(`SELECT id,revision,state FROM ${tx.t('report_snapshots')} WHERE query_key=? ORDER BY revision`, [queryKey]),
      copy: await getReportCopyRunTx(tx, queryKey),
    }));
    const before = await state();
    expect(before.collections).toEqual([]);
    expect(before.returns).toHaveLength(3);
    expect(before.saved).toEqual([]);
    const writes = [];
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (!['GET', 'HEAD'].includes(req.method()) && path.startsWith('/api/admin/') && !/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(path)) writes.push(`${req.method()} ${path}`);
    });

    function matchesReport(response, fixture) {
      const { pathname, searchParams: params } = new URL(response.url());
      return response.request().method() === 'GET' && pathname === '/api/admin/reports' && params.get('period') === period && params.get('anchor') === start
        && params.get('metric') === (fixture.metric || 'contribution') && params.get('issue') === fixture.issue && params.get('mode') === 'live';
    }
    async function checkDetail(fixture, response, { focused = true } = {}) {
      const metric = fixture.metric || 'contribution';
      await expect(page).toHaveURL(url => url.searchParams.get('section') === 'reports' && url.searchParams.get('tab') === (fixture.tab || 'overview')
        && url.searchParams.get('period') === period && url.searchParams.get('anchor') === start && url.searchParams.get('record') === metric && url.searchParams.get('issue') === fixture.issue);
      expect(response.ok()).toBe(true);
      const report = await response.json();
      expect(report).toMatchObject({ query: { period, anchorDate: start, filters: {} }, bounds: { startDate: start, endDateExclusive: end }, closed: true,
        metrics: { recognizedOrders: { value: 5, complete: true }, contribution: { value: 15_200_000, complete: true }, operatingResult: { value: 15_000_000, complete: true } },
        details: { total: fixture.facts.length, metricSummary: { value: fixture.total, unit: 'minor', complete: true, knownCount: fixture.facts.length, excludedCount: 0, ...fixture.summary } } });
      expect(report.query.filters).toEqual({});
      const rows = report.details.records;
      expect(rows.every(row => row.known && row.unit === 'minor')).toBe(true);
      if (fixture.issue === 'costly_returns') expect(rows).toMatchObject([{ id: dominant.id, entityType: 'order_return', quantity: 1, salesCreditMinor: 6_000_000, shippingCreditMinor: 100_000 }]);
      expect(sorted(rows.map(row => [row.orderId, row.label ?? row.reason, row.occurredOn, row.value,
        fixture.issue === 'costly_returns' ? row.entityId : fixture.dimension ? row[fixture.dimension] : null]))).toEqual(sorted(fixture.facts));
      const heading = detail.getByRole('heading', { name: fixture.heading, exact: true });
      if (focused) await expect(heading).toBeFocused();
      await expect(heading).toBeVisible();
      await expect(page.getByRole('button', { name: 'Datos actuales', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(detail.getByText(`Total: ${amount(fixture.total)}`, { exact: true })).toBeVisible();
      await expect(detail).toContainText(`${fixture.facts.length} de ${fixture.facts.length} registros con datos · 0 excluidos`);
      await expect(table.locator('tbody tr')).toHaveCount(fixture.facts.length);
      for (const order of [...fixture.excluded, outside]) await expect(table.getByRole('button', { name: orderButton(order), exact: true })).toHaveCount(0);
      for (const order of [mixed, negative, refundCredit, unassigned, zero]) {
        const count = fixture.facts.filter(([id]) => id === order.id).length;
        if (count) await expect(table.getByRole('button', { name: orderButton(order), exact: true })).toHaveCount(count);
      }
      if (fixture.visibleGroup) {
        await expect(table.getByText(fixture.visibleGroup, { exact: false })).toHaveCount(fixture.facts.length);
        await expect(table).not.toContainText(fixture.excludedGroup);
      }
      if (fixture.issue === 'shipping_absorbed') {
        for (const [label, on, value] of [[freight, dispatch, 1_000_000], [shipping, delivery, -300_000]]) {
          const row = table.getByRole('row').filter({ has: page.getByText(label, { exact: true }) });
          await expect(row.getByText(dateLabel(on), { exact: true })).toBeVisible();
          await expect(row.getByText(amount(value), { exact: true })).toBeVisible();
        }
      }
      if (fixture.issue === 'costly_returns') {
        await expect(table.getByRole('button', { name: orderButton(refundCredit), exact: true })).toBeVisible();
        await expect(table).toContainText(`Motivo: ${leadingReason} · Unidades: 1`);
        await expect(table).toContainText(`Crédito de productos: ${amount(6_000_000)} · Crédito de flete: ${amount(100_000)}`);
        await expect(table).not.toContainText(otherReason);
        await expect(detail).toContainText('Los créditos comerciales no representan pérdidas ni pagos de reembolso.');
      }
    }

    const homeCases = [
      {...cases[0],id:'home.observation-contribution',query:'abrir la base de una observación de contribución',selected:true},
      {...cases[4],id:'home.observation-shipping-cost',query:'examinar pedidos cuyo flete no cubre transporte'},
      {...cases[5],id:'home.observation-return-credits',query:'examinar créditos comerciales de devoluciones'},
    ];
    for (const fixture of [...cases,...homeCases]) await test.step(fixture.id||`reports.view-${fixture.action}`, async () => {
      for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
        await page.goto('/admin');
        await expect(page.getByRole('heading', { name: 'Tu negocio', exact: true })).toBeVisible();
        await page.getByRole('combobox', { name: 'Frecuencia', exact: true }).selectOption(period);
        await page.getByLabel('Fecha de referencia', { exact: true }).fill(start);
        await expect(page).toHaveURL(url => url.searchParams.get('period') === period && url.searchParams.get('anchor') === start);
        const observation = page.getByRole('heading', { name: fixture.title, exact: true }).locator('..');
        await expect(observation.getByText(`Actual: ${amount(fixture.total)}`, { exact: true })).toBeVisible();
        await expect(observation).toContainText(fixture.home);
        await expect(page.getByRole('region', { name: 'Base de comparación' })).toContainText(`Anterior: ${dateLabel(prior)}–${dateLabel(date(-1))}`);
        await expect(page.getByText(/Sin base anterior: diferencia absoluta de contribución .* no se calcula un porcentaje/)).toBeVisible();
        await expect(page.getByRole('heading', { name: /La contribución (?:creció|disminuyó)/ })).toHaveCount(0);
        if (fixture.visibleGroup) {
          const groups = observation.getByRole('list', { name: 'Grupos con contribución conocida' });
          await expect(groups.getByRole('listitem')).toHaveCount(1);
          await expect(groups).toContainText(fixture.visibleGroup);
          await expect(groups).not.toContainText(fixture.excludedGroup);
        }
        let trigger = observation.getByRole('button', { name: 'Ver registros del período', exact: true });
        const openReport = async button => {
          const [response] = await Promise.all([
            page.waitForResponse(candidate => matchesReport(candidate, fixture), { timeout: 15000 }),
            button.click({ timeout: 12000 }),
          ]);
          return response;
        };
        // These actions revisit an already-open report and may not fetch it again.
        const currentReport = fixture.selected && via !== 'panel' ? await openReport(trigger) : null;
        if (currentReport) await checkDetail(fixture, currentReport);
        if (via !== 'panel') {
          let launcher;
          if (via === 'chat') {
            launcher = await openAli(page);
            await askAli(launcher, `¿Dónde está ${fixture.query}?`);
          } else {
            const entry=fixture.selected?await openAli(page):page;
            await entry.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
            launcher = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
            await launcher.getByRole('searchbox', { name: 'Buscar una acción' }).fill(fixture.query);
            await launcher.getByRole('button', { name: 'Buscar', exact: true }).click();
          }
          trigger = launcher.locator(`[data-capability-id="${fixture.id||`reports.view-${fixture.action}`}"]`).getByRole('button', { name: /^Abrir en el panel:/ });
        }
        if (currentReport) {
          await trigger.click({ timeout: 12000 });
          await checkDetail(fixture, currentReport);
        } else {
          await checkDetail(fixture, await openReport(trigger));
        }
        if (via === 'directorio' && !fixture.id) {
          const reopened = page.waitForResponse(response => matchesReport(response, fixture));
          await page.reload();
          await checkDetail(fixture, await reopened, { focused: false });
          await detail.getByRole('heading', { name: fixture.heading, exact: true }).scrollIntoViewIfNeeded();
          await screenshot(page, info, `advisor-c6-${fixture.action}`);
        }
      });
    });
    expect(writes).toEqual([]);
    expect(await state()).toEqual(before);
  } finally {
    try { await restorePolicy?.(); } finally { await store.close(); }
  }
});

test('Ali @advisor-c6: registra hechos logísticos distintos únicamente al confirmar en la guía',async({page,context,request},info)=>{
  test.setTimeout(145000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), day=bogotaDate();
    const payload=input=>({requestId:randomUUID(),...input});
    const scenarios=[
      ['record-dispatch','guía recogida',null,'collected','Recogido','linked'],
      ['record-delivery','confirmar entregado','collected','delivered','Entregado','linked'],
      ['record-incident','guía con novedad local',null,'incident','Con novedad'],
      ['record-return','guía devuelta','delivered','returned','Devuelto'],
      ['record-cancellation','cancelación de guía local',null,'cancelled','Cancelado'],
      ['record-tracking-event','guía creada en seguimiento',null,'label_created','Guía creada'],
      ['record-unknown-status','estado logístico desconocido',null,'unknown','Estado sin identificar'],
      ['rectify-event','corregir evento del envío','delivered','incident','Con novedad','rectify'],
    ];
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(`${req.method()} ${path}`);
    });
    const writeSnapshot=async()=>({
      cash:(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')}`)).n,
      returns:(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_returns')}`)).n,
      collections:(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('order_collections')}`)).n,
      heka:(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('heka_api_mutations')}`)).n,
    });
    const read=async path=>{
      const response=await context.request.get(path);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const unchanged=await writeSnapshot();
    for(const [intent,q,seedStatus,status,label,mode] of scenarios)await test.step(`shipments.${intent}`,async()=>{
      for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
        const key=`${code}-${intent}-${via}`, tracking=`C6-${key}`;
        let product,order;
        if(mode==='linked'){
          product=await store.save('products',{...emptyRecord('products'),title:`Referencia envío ${key}`,slug:`referencia-evento-${key}`,status:'draft',price:18000,presentation:'Unidad',stockQuantity:5,orderable:true},null,null,actorId);
          order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Pedido ${key}`}),actorId);
        }
        const guide=await createShipment(store,payload({orderId:order?.id,carrier:'Logística sin proveedor',tracking,estimatedDeliveryOn:day}),actorId);
        const path=`/api/admin/business/shipments/${guide.id}`;
        if(seedStatus)await recordShipmentEvent(store,guide.id,payload({version:guide.version,status:seedStatus,occurredOn:day,reason:'Hecho previo de prueba'}),actorId);
        const previous=await read(path), count=writes.length;
        await page.goto(`/admin?section=orders&tab=shipments&q=${tracking}`);
        const card=page.getByRole('article').filter({has:page.getByRole('heading',{name:tracking,exact:true})});
        await card.getByRole('button',{name:order?'Ver envío':'Revisar y vincular',exact:true}).click({timeout:7000});
        const dialog=page.getByRole('dialog',{name:tracking,exact:true});
        const form=dialog.getByRole('heading',{name:'Registrar estado y fecha',exact:true}).locator('..');
        const state=form.getByRole('combobox',{name:'Estado observado',exact:true}), precision=form.getByRole('combobox',{name:'Precisión de la fecha',exact:true});
        const corrected=form.getByRole('combobox',{name:'Hecho que no ocurrió o cuya fecha / estado era incorrecto',exact:true});
        const target=mode==='rectify'?corrected:state;
        if(via==='panel'){
          if(mode==='rectify')await form.getByText('Rectificar un evento anterior',{exact:true}).click();
        }else{
          await form.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
          let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
          if(via==='chat')await askAli(entry,`¿Dónde está ${q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="shipments.${intent}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
          await expect(target).toBeFocused();
        }
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===guide.id&&url.searchParams.get('q')===tracking);
        await expect(state).toHaveValue(previous.status);
        await expect(precision).toHaveValue('day');
        const eventDate=form.getByLabel('Fecha real del evento',{exact:true});
        await expect(eventDate).toHaveValue('');
        const cause=`Evidencia ${key}`;
        if(mode==='rectify'){
          await expect(corrected).toHaveValue('');
          await corrected.selectOption(previous.events[0].id);
          await expect(form).toContainText('no mueve dinero de caja');
        }
        await state.selectOption(status);
        if(status==='unknown'){
          await precision.selectOption('unknown');
          await expect(eventDate).toHaveCount(0);
        }else await eventDate.fill(day);
        await form.getByRole('textbox',{name:/^Motivo/}).fill(cause);
        await form.getByRole('textbox',{name:'Detalle del evento',exact:true}).fill(`Observación manual ${via}`);
        expect(writes).toHaveLength(count);
        expect(await read(path)).toEqual(previous);
        const [response]=await Promise.all([
          page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`${path}/events`,{timeout:9000}),
          form.getByRole('button',{name:'Guardar evento',exact:true}).click(),
        ]);
        const result=await response.json();
        expect(response.ok(),JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({id:guide.id,tracking,version:previous.version+1,status,orderId:order?.id??null});
        expect(result.events).toHaveLength(previous.events.length+1);
        const event=result.events.find(row=>row.reason===cause);
        const expected={source:'manual',status,occurredOn:status==='unknown'?null:day,occurredAt:null,correctionOf:mode==='rectify'?previous.events[0].id:null};
        expect(event).toMatchObject(expected);
        expect(event.sourceAsOf).toEqual(expect.any(String));
        const summary=dialog.locator('summary').filter({hasText:/^Historial de eventos/});
        await expect(summary).toHaveText(`Historial de eventos (${result.events.length})`);
        await summary.click();
        const history=summary.locator('..');
        await expect(history.getByRole('listitem').filter({hasText:cause})).toContainText(label);
        if(mode==='rectify'){
          await expect(history.getByRole('listitem').filter({hasText:'Hecho previo de prueba'})).toContainText('Rectificado');
          await expect(history.getByRole('listitem').filter({hasText:cause})).toContainText('Rectificación');
        }
        if(status==='unknown')await expect(history.getByRole('listitem').filter({hasText:cause})).toContainText('Fecha desconocida');
        if(order){
          const saved=await store.order(order.id);
          expect(saved.recognition?.on??null).toBe(status==='delivered'?day:null);
          expect((await store.get('products',product.id)).stockQuantity).toBe(4);
        }
        expect(writes.slice(count)).toEqual([`POST ${path}/events`]);
        const sent=response.request();
        const replay=await context.request.post(`${path}/events`,{data:sent.postDataJSON(),headers:{origin:await sent.headerValue('origin'),'x-csrf-token':await sent.headerValue('x-csrf-token')}});
        expect(replay.ok()).toBe(true);
        expect(await replay.json()).toEqual(result);
        expect(await read(path)).toMatchObject(result);
      });
    });
    expect(await writeSnapshot()).toEqual(unchanged);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva la población al revisar entregas tardías y retornos',async({page,context,request},info)=>{
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7);
    const start=addC6ReportDays(info.project.name==='mobile'?'2016-08-08':'2016-07-11',info.retry*14);
    const prior=addC6ReportDays(start,-7), day=addC6ReportDays(start,2), expected=addC6ReportDays(start,1);
    const command=input=>({requestId:randomUUID(),...input});
    async function complete(prefix,n,status,occurredOn,estimatedDeliveryOn){
      const tracking=`${prefix}-${code}-${n}`;
      const guide=await createShipment(store,command({carrier:`Logística informe ${code}`,tracking,estimatedDeliveryOn}),actorId);
      await recordShipmentEvent(store,guide.id,command({version:guide.version,status,occurredOn}),actorId);
      return tracking;
    }
    const late=[],onTime=[],earlier=[],returned=[];
    for(let index=0;index<20;index++){
      earlier.push(await complete('ANTERIOR',index,'delivered',prior,prior));
      const list=index<6?late:onTime;
      list.push(await complete(index<6?'FUERA-PLAZO':'EN-PLAZO',index,'delivered',day,index<6?expected:day));
    }
    for(let index=0;index<5;index++)returned.push(await complete('RETORNO',index,'returned',day,null));
    const missing=await complete('SIN-ESTIMADA',0,'delivered',day,null);
    const href=`/admin?period=week&anchor=${start}`;
    const detail=page.getByRole('region',{name:'Registros exactos de la métrica'});
    const table=detail.getByRole('table',{name:'Registros que explican la cifra',exact:true});
    const cases=[
      {id:'reports.view-late-deliveries',q:'desglose de entregas tardías',title:'Entregas a tiempo: deterioro observable',issue:'late_deliveries',metric:'onTimeDeliveries',included:late,excluded:[...earlier,...onTime,...returned,missing],base:/14\/20 guías frente a 20\/20/,header:'Entregas fuera de plazo del período',total:6,population:20},
      {id:'reports.view-shipment-returns',q:'retornos de guías',title:'Devoluciones logísticas: deterioro observable',issue:'shipping_returns',metric:'shipmentReturnRate',included:returned,excluded:[...earlier,...onTime,...late,missing],base:/5\/26 guías frente a 0\/20/,header:'Guías devueltas en el período de resolución',total:5,population:26},
    ];
    cases.push(
      {...cases[0],id:'home.observation-deliveries',q:'ver la base de la comparación de puntualidad',selected:true},
      {...cases[1],id:'home.observation-logistic-returns',q:'ver la base de una comparación de retorno logístico',selected:true},
    );
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(path);
    });
    for(const fixture of cases)await test.step(fixture.id,async()=>{
      for(const via of ['panel','chat','directorio']){
        await page.goto(href);
        const source=page.getByRole('heading',{name:fixture.title,exact:true}).locator('..');
        await expect(source).toContainText(fixture.base);
        const response=page.waitForResponse(res=>{
          const {pathname,searchParams:p}=new URL(res.url());
          return pathname==='/api/admin/reports'&&p.get('period')==='week'&&p.get('anchor')===start&&p.get('issue')===fixture.issue&&p.get('metric')===fixture.metric;
        },{timeout:15000});
        if(via==='panel'||fixture.selected)await source.getByRole('button',{name:'Ver registros del período',exact:true}).click();
        if(via!=='panel'){
          if(fixture.selected){
            expect((await response).ok()).toBe(true);
            await expect(detail.getByRole('heading',{name:fixture.header,exact:true})).toBeVisible();
          }
          let entry=await openAli(page);
          if(via==='chat')await askAli(entry,`¿Dónde está ${fixture.q}?`);
          else{
            await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
            entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
            await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(fixture.q);
            await entry.getByRole('button',{name:'Buscar',exact:true}).click();
          }
          await entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        }
        const result=await response;
        expect(result.ok()).toBe(true);
        const report=await result.json();
        expect(report.details.metricSummary).toMatchObject({unit:'count',value:fixture.total,denominator:fixture.population,numerator:fixture.total});
        expect(report.details.records.map(row=>row.tracking).sort()).toEqual([...fixture.included].sort());
        expect(report.details.records.every(row=>row.value===1&&row.occurredOn===day)).toBe(true);
        const heading=detail.getByRole('heading',{name:fixture.header,exact:true});
        await expect(heading).toBeFocused();
        await expect(detail.getByText(`Total: ${fixture.total}`,{exact:true})).toBeVisible();
        await expect(detail.getByText(`Población evaluada: ${fixture.population} guías.`,{exact:false})).toBeVisible();
        for(const tracking of fixture.included)await expect(table.getByText(tracking,{exact:true})).toBeVisible();
        for(const tracking of fixture.excluded)await expect(table.getByText(tracking,{exact:true})).toHaveCount(0);
        if(via==='directorio')await screenshot(page,info,`advisor-c6-${fixture.issue}`);
      }
    });
    expect(writes).toEqual([]);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: asienta ingresos, traslados, gastos y contrapartidas sin duplicar dinero', async ({ page, context, request }, info) => {
  test.setTimeout(180000);
  const dbEnv = testDatabaseEnv(), app = new URL(info.project.use.baseURL);
  const local = value => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  if (app.protocol !== 'https:' || ![app.href, controlURL, baseURL, dbEnv.DATABASE_URL].every(local)) {
    throw new Error('La prueba requiere app, proveedor sintético y PostgreSQL descartable locales.');
  }
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(dbEnv);
  try {
    const actorId = await fixtureActor(context, store), code = randomUUID().slice(0, 7);
    const today = bogotaDate(), incurredOn = addC6ReportDays(today, -1);
    const owner = await saveResource(store, 'people', { requestId: randomUUID(), name: `Responsable asientos ${code}` }, actorId);
    const read = async path => {
      const response = await context.request.get(path);
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const overview = () => read('/api/admin/finance/overview');
    const sales = async () => (await read(`/api/admin/reports?mode=live&period=day&anchor=${today}`)).metrics.netProductSales;
    const saleRows = () => Promise.all([
      store.db.all(`SELECT id,version FROM ${store.t('orders')} ORDER BY id`),
      store.db.all(`SELECT id,kind,order_id,cash_entry_id FROM ${store.t('order_collections')} ORDER BY id`),
    ]);
    const startingSales = await sales(), startingSaleRows = await saleRows();
    const writes = [], externalWrites = [];
    page.on('request', req => {
      const { pathname } = new URL(req.url());
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && pathname.startsWith('/api/admin/') && !pathname.startsWith('/api/admin/assistant/')) writes.push(`${req.method()} ${pathname}`);
    });
    await page.route('**/*', route => {
      const req = route.request();
      if (new URL(req.url()).origin !== app.origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
        externalWrites.push(`${req.method()} ${req.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    const cashView = tab => `/admin?section=cash&tab=${tab}`;
    const drawer = page.getByRole('dialog', { name: /^(Registrar ingreso|Transferir|Registrar gasto|Revertir movimiento)$/ });
    const field = name => drawer.locator(`[name="${name}"]`);
    const dayActions = page.getByRole('region', { name: 'Acciones del día' });
    const native = name => dayActions.getByRole('button', { name, exact: true });
    const expenseButton = page.locator('[aria-label="Acciones de caja"]').getByRole('button', { name: 'Registrar gasto', exact: true });
    const reversalButton = page.locator('.cash-detail').getByRole('button', { name: 'Revertir movimiento completo', exact: true });
    const added = (before, after) => {
      const ids = new Set(before.map(row => row.id));
      expect(after.filter(row => ids.has(row.id))).toEqual(before);
      return after.filter(row => !ids.has(row.id));
    };

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const prefix = `Asientos ${code} ${via}`;
      const [openingCash, openingBank] = [400076, 100059];
      const seed = (label, type, openingBalanceMinor) => saveAccount(store, {
        requestId: randomUUID(), name: `${prefix} ${label}`, type, openingOn: incurredOn,
        openingBalanceMinor, responsibleId: owner.id,
      }, actorId);
      const cash = await seed('Efectivo', 'cash', openingCash), bank = await seed('Banco sintético', 'bank', openingBank);
      const baseline = await overview();
      const snapshot = async () => {
        const [entries, expenses, payments, counts] = await Promise.all([
          store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id IN (?,?) ORDER BY id`, [cash.id, bank.id]),
          store.db.all(`SELECT * FROM ${store.t('expenses')} WHERE data::jsonb->>'concept' LIKE ? ORDER BY id`, [`${prefix}%`]),
          store.db.all(`SELECT p.* FROM ${store.t('expense_payments')} p JOIN ${store.t('expenses')} e ON e.id=p.expense_id WHERE e.data::jsonb->>'concept' LIKE ? ORDER BY p.id`, [`${prefix}%`]),
          store.db.get(`SELECT (SELECT COUNT(*) FROM ${store.t('cash_entries')}) AS entries, (SELECT COUNT(*) FROM ${store.t('expenses')}) AS expenses, (SELECT COUNT(*) FROM ${store.t('expense_payments')}) AS payments`),
        ]);
        return { entries, expenses, payments, counts };
      };
      const balances = async (cashMinor, bankMinor, newDebt = 0) => {
        const result = await overview();
        expect(result.accounts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: cash.id, balanceMinor: cashMinor }),
          expect.objectContaining({ id: bank.id, balanceMinor: bankMinor }),
        ]));
        expect(result.availableMinor).toBe(baseline.availableMinor + cashMinor - openingCash + bankMinor - openingBank);
        expect(result.expensesOutstandingMinor).toBe(baseline.expensesOutstandingMinor + newDebt);
      };
      const entry = (account, amount, kind, sourceType, sourceId, id, other = {}) => expect.objectContaining({
        id, account_id: account.id, effective_on: today, amount_minor: amount, kind, source_type: sourceType,
        source_id: sourceId, transfer_id: null, reversal_of: null, ...other,
      });
      const movementHref = row => `${cashView('movements')}&period=day&anchor=${today}&account=${row.accountId}&record=${row.id}`;

      async function run({ id, query, tab = 'overview', original, target, action, button, fill, proof }) {
        await test.step(`cash.${id}`, async () => {
          const count = writes.length, before = await snapshot();
          const href = original ? movementHref(original) : cashView(tab);
          await page.goto(via === 'panel' || original ? href : '/admin');
          if (via !== 'panel') {
            let source;
            if (via === 'chat') {
              source = await openAli(page);
              await askAli(source, `¿Dónde está ${query}?`);
            } else {
              const launcher = original ? await openAli(page) : page;
              await launcher.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
              source = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
              await source.getByLabel('Área').selectOption('cash');
              await source.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
              await source.getByRole('button', { name: 'Buscar', exact: true }).click();
            }
            await source.locator(`[data-capability-id="cash.${id}"]`).getByRole('button', { name: /^Abrir en el panel:/ }).click();
            await expect(target).toBeFocused();
            await expect(target).toBeInViewport();
            await expect(target).toHaveCSS('outline-style', 'solid');
          }
          await expect(page).toHaveURL(url => url.searchParams.get('section') === 'cash' && url.searchParams.get('tab') === tab && (!original || url.searchParams.get('record') === original.id));
          await expect(drawer).toHaveCount(0);
          expect(writes).toHaveLength(count);
          expect(await snapshot()).toEqual(before);
          if (via === 'panel') await target.click();
          else await target.press('Enter');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const submit = drawer.getByRole('button', { name: button, exact: true });
          await expect(drawer).toBeVisible();
          await fill();
          await expect(submit).toBeEnabled();
          expect(writes).toHaveLength(count);
          expect(await snapshot()).toEqual(before);
          const path = `/api/admin/business/actions/${action}`;
          const response = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === path);
          await submit.click();
          const saved = await response, sent = saved.request(), payload = sent.postDataJSON();
          expect(saved.status(), await saved.text()).toBe(200);
          const result = await saved.json();
          await expect(drawer).toHaveCount(0);
          const message = { income: 'Ingreso no comercial registrado; no aumenta las ventas.', transfer: 'Transferencia registrada: salida y entrada entre cuentas propias, sin cambio del total.',
            expense: button === 'Registrar gasto y pago' ? 'Gasto y pago registrados.' : 'Gasto pendiente registrado; no se movió dinero.', 'cash-reverse': 'Reversión registrada; el original se conserva.' }[action];
          await expect(page.locator('.cash-workspace').getByRole('status').filter({ hasText: message })).toBeVisible();
          expect(writes.slice(count)).toEqual([`POST ${path}`]);
          const after = await snapshot();
          for (const key of ['entries', 'expenses', 'payments']) expect(after.counts[key] - before.counts[key]).toBe(after[key].length - before[key].length);
          const retry = await context.request.post(saved.url(), { data: payload, headers: {
            Origin: await sent.headerValue('origin'), 'x-csrf-token': await sent.headerValue('x-csrf-token'),
          } });
          expect(retry.status(), await retry.text()).toBe(200);
          expect(await retry.json()).toEqual(result);
          const receipts = await store.db.all(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [action === 'expense' ? 'expense' : `cash:${action === 'cash-reverse' ? 'reverse' : action}`, payload.requestId]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].actor_id).toBe(actorId);
          expect(JSON.parse(receipts[0].result_json)).toEqual(result);
          expect(await snapshot()).toEqual(after);
          await proof(result, payload, after, before);
          expect(await saleRows()).toEqual(startingSaleRows);
        });
      }
      const [incomeMinor, transferMinor, dueMinor, paidMinor] = [125043, 71017, 32761, 40823];
      const incomeRef = `${prefix} aporte`, transferRef = `${prefix} traslado`;
      let income, transfer;
      await run({ id: 'record-income', query: 'aporte del dueño', target: native('Registrar ingreso'), action: 'income', button: 'Registrar ingreso',
        fill: async () => {
          await expect(field('amountMinor')).toHaveValue('');
          await expect(field('description')).toHaveValue('');
          await field('concept').selectOption('owner_funding');
          await field('description').fill(`${prefix} capital del propietario`);
          await field('accountId').selectOption(cash.id);
          await field('effectiveOn').fill(today);
          await field('amountMinor').fill('1.250,43');
          await field('reference').fill(incomeRef);
        },
        proof: async (result, payload, after, before) => {
          income = result;
          expect(payload).toMatchObject({ accountId: cash.id, amountMinor: incomeMinor, effectiveOn: today, concept: 'owner_funding' });
          expect(result).toMatchObject({ nonSale: true, reference: incomeRef, balanceMinor: openingCash + incomeMinor });
          const movements = added(before.entries, after.entries);
          expect(movements).toEqual([entry(cash, incomeMinor, 'income', 'income', result.id, result.id)]);
          expect(JSON.parse(movements[0].data)).toMatchObject({ nonSale: true, concept: 'owner_funding', reference: incomeRef });
          expect(after.expenses).toEqual(before.expenses);
          expect(after.payments).toEqual(before.payments);
          await balances(openingCash + incomeMinor, openingBank);
          expect(await sales()).toEqual(startingSales);
        },
      });
      await run({ id: 'transfer-money', query: 'transferencia interna', target: native('Transferir'), action: 'transfer', button: 'Transferir',
        fill: async () => {
          await expect(drawer.getByText(/No envía dinero al banco/)).toBeVisible();
          await expect(field('amountMinor')).toHaveValue('');
          await expect(field('toAccountId')).toHaveValue('');
          await field('fromAccountId').selectOption(cash.id);
          await expect(field('toAccountId').locator(`option[value="${cash.id}"]`)).toHaveCount(0);
          await field('toAccountId').selectOption(bank.id);
          await field('effectiveOn').fill(today);
          await field('concept').fill(transferRef);
          await field('amountMinor').fill('710,17');
          await field('reference').fill(transferRef);
        },
        proof: async (result, payload, after, before) => {
          transfer = result;
          expect(payload).toMatchObject({ fromAccountId: cash.id, toAccountId: bank.id, amountMinor: transferMinor, effectiveOn: today, reference: transferRef });
          expect(result.entries).toHaveLength(2);
          const [out, into] = result.entries;
          const movements = added(before.entries, after.entries), link = { transfer_id: result.transferId };
          expect(movements).toHaveLength(2);
          expect(movements).toEqual(expect.arrayContaining([
            entry(cash, -transferMinor, 'transfer', 'transfer', result.transferId, out.id, link),
            entry(bank, transferMinor, 'transfer', 'transfer', result.transferId, into.id, link),
          ]));
          expect(after.expenses).toEqual(before.expenses);
          expect(after.payments).toEqual(before.payments);
          await balances(openingCash + incomeMinor - transferMinor, openingBank + transferMinor);
        },
      });
      for (const pay of [false, true]) {
        const concept = `${prefix} ${pay ? 'pago registrado' : 'obligación pendiente'}`;
        const amountMinor = pay ? paidMinor : dueMinor;
        await run({ id: pay ? 'record-and-pay-expense' : 'record-expense', query: pay ? 'registrar gasto y pago' : 'guardar gasto pendiente',
          tab: 'expenses', target: expenseButton, action: 'expense', button: pay ? 'Registrar gasto y pago' : 'Guardar gasto pendiente',
          fill: async () => {
            await expect(field('concept')).toBeEnabled();
            await expect(field('concept')).toHaveValue('');
            await expect(field('amountMinor')).toHaveValue('');
            await expect(drawer.getByRole('radio', { name: 'Dejar pendiente', exact: true })).toBeChecked();
            const payNow = drawer.getByRole('radio', { name: 'Registrar y pagar ahora', exact: true });
            await expect(payNow).not.toBeChecked();
            await expect(field('accountId')).toHaveCount(0);
            await expect(field('effectiveOn')).toHaveCount(0);
            await field('category').selectOption('operating');
            await field('concept').fill(concept);
            await field('supplier').fill('Proveedor ficticio (solo registro local)');
            await field('incurredOn').fill(incurredOn);
            await field('amountMinor').fill(pay ? '408,23' : '327,61');
            if (pay) {
              await payNow.check();
              await expect(drawer.getByText(/no se envía dinero al banco ni al proveedor/)).toBeVisible();
              await field('accountId').selectOption(bank.id);
              await field('effectiveOn').fill(today);
              await field('reference').fill(concept);
            }
          },
          proof: async (result, payload, after, before) => {
            expect(result).toMatchObject({ concept, category: 'operating', incurredOn, amountMinor, paidMinor: pay ? amountMinor : 0, outstandingMinor: pay ? 0 : amountMinor });
            expect(added(before.expenses, after.expenses)).toEqual([expect.objectContaining({ id: result.id, category: 'operating', amount_minor: amountMinor, incurred_on: incurredOn, order_id: null, shipment_id: null })]);
            const detail = await read(`/api/admin/finance/expenses?record=${result.id}`);
            expect(detail).toMatchObject(result);
            if (!pay) {
              for (const key of ['accountId', 'effectiveOn', 'reference']) expect(payload).not.toHaveProperty(key);
              expect(after.entries).toEqual(before.entries);
              expect(after.payments).toEqual(before.payments);
              expect(detail.payments).toEqual([]);
            } else {
              expect(payload).toMatchObject({ accountId: bank.id, effectiveOn: today, incurredOn, reference: concept });
              expect(detail.payments).toHaveLength(1);
              expect(detail.activePayments).toEqual(detail.payments);
              const [payment] = detail.payments;
              expect(added(before.payments, after.payments)).toEqual([expect.objectContaining({ id: payment.id, cash_entry_id: payment.cashEntryId, expense_id: result.id, kind: 'payment', amount_minor: paidMinor, settlement_receipt_id: null, reversal_of: null })]);
              expect(payment).toMatchObject({ effectiveOn: today, amountMinor: paidMinor });
              expect(added(before.entries, after.entries)).toEqual([entry(bank, -paidMinor, 'expense_payment', 'expense_payment', payment.id, payment.cashEntryId)]);
              expect(await read(`/api/admin/finance/movements?record=${payment.cashEntryId}`)).toMatchObject({ sourceId: payment.id, documentId: payment.id, documentType: 'expense_payment', expenseId: result.id, reference: concept });
            }
            await balances(openingCash + incomeMinor - transferMinor, openingBank + transferMinor - (pay ? paidMinor : 0), dueMinor);
            await page.goto(`${cashView('expenses')}&period=day&anchor=${incurredOn}&record=${result.id}`);
            const shown = page.locator('.cash-detail');
            await expect(shown.getByRole('heading', { name: `Detalle · ${concept}`, exact: true })).toBeVisible();
            const amount = formatC6ReportMoney;
            for (const [label, value] of [['Importe', amountMinor], ['Pagado', pay ? paidMinor : 0], ['Pendiente', pay ? 0 : dueMinor]]) {
              await expect(shown.getByText(label, { exact: true }).locator('..').locator('dd')).toHaveText(amount(value));
            }
          },
        });
      }
      for (const kind of ['income', 'transfer']) {
        const isTransfer = kind === 'transfer', originals = isTransfer ? transfer.entries : [income];
        // Select the receiving leg of the transfer: the command must reverse both legs even from this detail.
        const original = originals.at(-1), reason = `${prefix} corrige ${isTransfer ? 'el traslado' : 'el aporte'}`;
        await run({ id: `reverse-${kind}`, query: isTransfer ? 'deshacer traslado' : 'revertir aporte', tab: 'movements', original,
          target: reversalButton, action: 'cash-reverse', button: 'Revertir movimiento',
          fill: async () => {
            const shown = drawer.getByRole('region', { name: 'Movimiento original', exact: true });
            await expect(shown).toContainText(isTransfer ? bank.name : cash.name);
            await expect(shown).toContainText(today);
            await expect(shown).toContainText(original.reference);
            if (isTransfer) await expect(shown).toContainText('las dos caras del traslado');
            await expect(field('reason')).toHaveValue('');
            await field('effectiveOn').fill(today);
            await field('reason').fill(reason);
          },
          proof: async (result, payload, after, before) => {
            expect(payload).toMatchObject({ cashEntryId: original.id, effectiveOn: today, reason });
            const reversals = isTransfer ? result.entries : [result];
            const movements = added(before.entries, after.entries);
            expect(reversals).toHaveLength(originals.length);
            expect(movements).toHaveLength(originals.length);
            if (isTransfer) expect(result.transferId).toBe(transfer.transferId);
            for (const prior of originals) {
              const reversal = reversals.find(row => row.reversalOf === prior.id);
              expect(reversal).toMatchObject({ amountMinor: -prior.amountMinor, accountId: prior.accountId, reason });
              expect(movements).toContainEqual(entry({ id: prior.accountId }, -prior.amountMinor, 'reversal', prior.sourceType, prior.sourceId, reversal.id,
                { reversal_of: prior.id, transfer_id: isTransfer ? transfer.transferId : null }));
              expect(await read(`/api/admin/finance/movements?record=${prior.id}`)).toMatchObject({ id: prior.id, amountMinor: prior.amountMinor, reversed: true, reversalOf: null });
            }
            expect(after.expenses).toEqual(before.expenses);
            expect(after.payments).toEqual(before.payments);
            await balances(openingCash - (isTransfer ? 0 : transferMinor), openingBank + (isTransfer ? 0 : transferMinor) - paidMinor, dueMinor);
            await page.reload();
            await expect(page.locator('.cash-detail')).toContainText('Movimiento revertido o de reversión; se conserva la historia.');
            await expect(reversalButton).toHaveCount(0);
          },
        });
      }
      await page.goto(cashView('overview'));
      for (const [account, balance] of [[cash, openingCash], [bank, openingBank - paidMinor]]) {
        await expect(page.getByRole('heading', { name: account.name, exact: true }).locator('..').locator('strong')).toHaveText(formatC6ReportMoney(balance));
      }
      expect(await sales()).toEqual(startingSales);
    });
    expect(externalWrites).toEqual([]);
    expect(writes).toHaveLength(18);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: guarda fichas físicas privadas, reservas y costos sin registrar gastos ni Caja', async ({page,context,request},info)=>{
  test.setTimeout(180000);
  if(info.project.name==='mobile') await page.setViewportSize({width:320,height:740});
  await loginWithAdvisorFixture(page,request);
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7), day=bogotaDate();
    const originalDate=addC6ReportDays(day,-2), effectiveOn=addC6ReportDays(day,-1), originalCost=875_025;
    const storefront=await store.settings(), unaffectedProducts=await store.list('products'), reserve=3;
    const catalog=await store.save('catalogs',{
      ...emptyRecord('catalogs'),title:`Catálogo físico privado ${code}`,slug:`c6-catalogo-fisico-${code}`,status:'draft',
    },null,null,actorId);
    const finance=()=>store.readSnapshot(async tx=>({
      expenses:await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('expenses')}`),
      cash:await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('cash_entries')}`),
    }));
    const unchangedFinance=await finance();
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(!['GET','HEAD'].includes(req.method())&&path.startsWith('/api/admin/')&&!/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(path)) writes.push(`${req.method()} ${path}`);
    });
    const href=`/admin?section=products&q=${code}&status=draft&productType=product`;
    const editor=()=>page.locator('dialog.editor-drawer');
    const field=name=>editor().locator(`[name="${name}"]`);
    const stock=()=>editor().getByRole('spinbutton',{name:'Existencias físicas (unidades)',exact:true});
    const cost=()=>editor().getByRole('textbox',{name:'Costo unitario',exact:true});
    const orderable=()=>editor().getByRole('checkbox',{name:'Disponible para pedidos',exact:true});
    const membership=()=>editor().getByRole('group',{name:/^Catálogos \(/});
    const costsDisclosure=()=>editor().locator('details').filter({has:page.locator('summary').filter({hasText:'Costos y obsequios'})});
    const save=row=>editor().getByRole('button',{name:row?'Guardar cambios':'Crear producto',exact:true});
    const editButton=title=>page.getByRole('button',{name:`Editar ${title}`,exact:true});
    const listRow=title=>page.locator('.list-table tr:visible, .list-cards .record-card:visible').filter({has:editButton(title)});
    const currentRow=row=>store.get('products',row.id);
    const counts=async row=>(await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='inventory' AND entity_id=?`,[row.id]))
      .map(entry=>JSON.parse(entry.data)).filter(entry=>entry.reason==='Conteo físico de existencias');
    const costHistory=async row=>(await store.db.all(`SELECT effective_on,unit_cost_minor,actor_id FROM ${store.t('product_costs')} WHERE product_id=? ORDER BY effective_on`,[row.id]))
      .map(entry=>({effectiveOn:entry.effective_on,unitCostMinor:Number(entry.unit_cost_minor),actorId:entry.actor_id}));
    const actions={
      create:{id:'create-product',query:'alta de producto',marker:'product-new-save',control:()=>save(null)},
      update:{id:'update-product',query:'editar descripción de producto',marker:'product-record-save',control:()=>save(true)},
      stock:{id:'record-stock-count',query:'ajustar unidades físicas',marker:'product-stock-count',control:stock},
      cost:{id:'record-unit-cost',query:'cambiar costo de producto',marker:'product-unit-cost',control:cost,disclosure:true},
      orderability:{id:'set-orderability',query:'producto disponible para pedidos',marker:'product-orderability',control:orderable,disclosure:true},
      catalogues:{id:'assign-catalogs',query:'agregar producto a catálogo',marker:'product-catalog-membership',control:membership},
    };

    async function open(row=null){
      await page.goto(href);
      if(row) await editButton(row.title).click();
      else await page.locator('.list-toolbar').getByRole('button',{name:'Crear producto',exact:true}).click();
      await expect(editor().getByRole('heading',{name:row?'Editar producto':'Crear producto',exact:true})).toBeVisible();
      if(row) await expect(field('title')).toHaveValue(row.title);
      await expect(field('status')).toHaveValue('draft');
    }
    async function reach(via,action){
      const before=writes.length, target=action.control();
      if(action.disclosure) await expect(costsDisclosure()).not.toHaveAttribute('open','');
      if(via==='panel'){
        if(action.disclosure) await costsDisclosure().locator('summary').click();
      }else{
        await editor().getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
        if(via==='chat') await askAli(entry,`¿Dónde está ${action.query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(action.query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="products.${action.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(target).toBeFocused();
        await expect(entry).toBeHidden();
      }
      await expect(target).toBeVisible();
      await expect(target).toHaveAttribute('data-advisor-control',action.marker);
      expect(writes).toHaveLength(before);
      expect(await target.evaluate(node=>{
        const rect=node.getBoundingClientRect();
        return rect.left>=-1&&rect.right<=innerWidth+1;
      })).toBe(true);
      if(via==='directorio') await screenshot(page,info,`advisor-c6-${action.marker}`);
      return target;
    }
    async function commit(row,fields){
      const method=row?'PUT':'POST', path=`/api/admin/products${row?`/${row.id}`:''}`, before=writes.length;
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path),
        save(row).click(),
      ]);
      expect(response.status(),await response.text()).toBe(row?200:201);
      const payload=response.request().postDataJSON(), result=await response.json();
      const {stockReserved,...editableFields}=fields;
      const privateFields={...editableFields,status:'draft',productType:'product'};
      expect(payload).toMatchObject({...privateFields,...(row?{version:row.version,stockReserved:row.stockReserved}:{})});
      expect(result).toMatchObject({...privateFields,...(stockReserved===undefined?{}:{stockReserved}),version:row?row.version+1:1});
      if(row) expect(result.id).toBe(row.id);
      else expect(result.id).toMatch(/^[\da-f-]{36}$/i);
      expect(await currentRow(result)).toEqual(result);
      await expect(editor()).toHaveCount(0);
      await expect(page.getByText(`Guardado: ${result.title} · Borrador`,{exact:true})).toBeVisible();
      await expect(listRow(result.title)).toContainText('Borrador');
      expect(writes.slice(before)).toEqual([`${method} ${path}`]);
      return result;
    }

    const privateIds=[];
    for(const [index,via] of ['panel','chat','directorio'].entries()) await test.step(via,async()=>{
      const title=`Producto físico ${code} ${via}`, price=20000+index*1000, initialStock=12;
      let row, order;
      async function expectUnchanged(){
        expect(await currentRow(row)).toEqual(row);
        if(order) expect(await store.order(order.id)).toEqual(order);
        expect(await finance()).toEqual(unchangedFinance);
      }

      await test.step('products.create-product',async()=>{
        await open();
        const before=writes.length;
        await save(null).click();
        await expect(field('title')).toHaveAttribute('aria-invalid','true');
        await field('title').fill(title);
        await field('price').fill(String(price));
        const presentation='Unidad privada';
        await field('presentation').fill(presentation);
        await stock().fill(String(initialStock));
        await costsDisclosure().locator('summary').click();
        await cost().fill('8.750,25');
        await field('costEffectiveOn').fill(originalDate);
        await expect(field('productType')).toHaveValue('product');
        await expect(orderable()).not.toBeChecked();
        await reach(via,actions.create);
        await expect(field('title')).toHaveValue(title);
        expect((await store.list('products')).some(product=>product.title===title)).toBe(false);
        expect(writes).toHaveLength(before);
        row=await commit(null,{title,presentation,price,stockQuantity:initialStock,stockReserved:0,unitCostMinor:originalCost,costEffectiveOn:originalDate,orderable:false,catalogIds:[]});
        privateIds.push(row.id);
      });

      await test.step('products.update-product',async()=>{
        await open(row);
        const description=`Descripción privada corregida ${via}`, presentation=`Presentación corregida ${via}`;
        const before=writes.length;
        await field('description').fill(description);
        await field('presentation').fill(presentation);
        await reach(via,actions.update);
        await expect(field('description')).toHaveValue(description);
        await expect(field('presentation')).toHaveValue(presentation);
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        row=await commit(row,{title,description,presentation,price,stockQuantity:initialStock,unitCostMinor:originalCost});
      });

      await test.step('products.set-orderability',async()=>{
        await open(row);
        const before=writes.length, target=await reach(via,actions.orderability);
        await expect(target).not.toBeChecked();
        await target.check();
        await expect(field('status')).toHaveValue('draft');
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        row=await commit(row,{orderable:true,stockQuantity:initialStock,unitCostMinor:originalCost});
        order=await store.saveOrder(businessOrderInput(row,{
          placedOn:day,customerName:`Pedido reservado privado ${code} ${via}`,
          items:[{lineId:randomUUID(),kind:'products',itemId:row.id,quantity:reserve,unitPriceMinor:price*100,discountMinor:0}],
        }),actorId);
        row=await currentRow(row);
        expect(row).toMatchObject({stockQuantity:initialStock,stockReserved:reserve,stockAvailable:initialStock-reserve,orderable:true,status:'draft'});
        expect(order.items).toMatchObject([{itemId:row.id,quantity:reserve,unitCostMinor:originalCost}]);
        expect(order.inventory.products).toEqual([{productId:row.id,reserved:reserve,consumed:0}]);
      });

      await test.step('products.record-stock-count',async()=>{
        await open(row);
        const before=writes.length, previousCounts=await counts(row), target=await reach(via,actions.stock);
        await expect(target).toHaveValue(String(initialStock));
        await expect(target).toHaveAttribute('min',String(reserve));
        await expect(editor().getByText(`Reservadas: ${reserve} · Disponibles para nuevos pedidos: ${initialStock-reserve}.`,{exact:false})).toBeVisible();
        await target.fill(String(reserve-1));
        await save(row).click();
        await expect(target).toHaveAttribute('aria-invalid','true');
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        const stockQuantity=reserve+2+index;
        await target.fill(String(stockQuantity));
        await expect(target).not.toHaveAttribute('aria-invalid','true');
        await expect(editor().getByText(`Reservadas: ${reserve} · Disponibles para nuevos pedidos: ${stockQuantity-reserve}.`,{exact:false})).toBeVisible();
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        row=await commit(row,{stockQuantity,stockReserved:reserve,unitCostMinor:originalCost});
        expect(row.stockAvailable).toBe(stockQuantity-reserve);
        await expect(listRow(title)).toContainText(`${stockQuantity} físicas · ${reserve} reservadas · ${stockQuantity-reserve} disponibles`);
        const audit=await counts(row);
        expect(audit).toHaveLength(previousCounts.length+1);
        expect(audit).toEqual(expect.arrayContaining(previousCounts));
        expect(audit).toContainEqual({
          previous:{stockQuantity:initialStock,stockReserved:reserve},next:{stockQuantity,stockReserved:reserve},
          reason:'Conteo físico de existencias',source:'manual',
        });
        await expectUnchanged();
      });

      await test.step('products.record-unit-cost',async()=>{
        await open(row);
        const before=writes.length, target=await reach(via,actions.cost), unitCostMinor=925_050+index*100_000;
        const previous=[{effectiveOn:originalDate,unitCostMinor:originalCost,actorId}];
        await expect(target).toHaveValue(new Intl.NumberFormat('es-CO',{maximumFractionDigits:2}).format(originalCost/100));
        await expect(field('costEffectiveOn')).toHaveValue(originalDate);
        expect(await costHistory(row)).toEqual(previous);
        await target.fill(`${9+index}.250,50`);
        await field('costEffectiveOn').fill(effectiveOn);
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        expect(await costHistory(row)).toEqual(previous);
        row=await commit(row,{unitCostMinor,costEffectiveOn:effectiveOn,stockQuantity:row.stockQuantity,stockReserved:reserve});
        expect(await costHistory(row)).toEqual([...previous,{effectiveOn,unitCostMinor,actorId}]);
        await expectUnchanged();
      });

      await test.step('products.assign-catalogs',async()=>{
        await open(row);
        const before=writes.length, target=await reach(via,actions.catalogues);
        const checkbox=target.getByRole('checkbox',{name:catalog.title,exact:true});
        await expect(checkbox).not.toBeChecked();
        await checkbox.check();
        await expect(target).toHaveAccessibleName('Catálogos (1 seleccionados)');
        expect(writes).toHaveLength(before);
        await expectUnchanged();
        row=await commit(row,{catalogIds:[catalog.id],orderable:true,stockReserved:reserve,unitCostMinor:row.unitCostMinor});
        await open(row);
        await expect(checkbox).toBeChecked();
        await editor().getByRole('button',{name:'Cancelar',exact:true}).click();
        await expect(editor()).toHaveCount(0);
        await expectUnchanged();
      });
    });
    expect(writes).toHaveLength(18);
    expect(await store.settings()).toEqual(storefront);
    expect(await store.get('catalogs',catalog.id)).toEqual(catalog);
    expect((await store.list('products')).filter(product=>!privateIds.includes(product.id))).toEqual(unaffectedProducts);
    expect((await store.publicData()).products.filter(product=>privateIds.includes(product.id))).toEqual([]);
    expect(await finance()).toEqual(unchangedFinance);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: separa vigencia, preferencias y aceptación de reglas guardadas',async({page,context,request},info)=>{
  test.setTimeout(120000);
  page.setDefaultTimeout(12000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store), start=await getBusinessSettings(store);
    const href='/admin?section=business&tab=rules';
    const policyTitle='Reglas financieras con vigencia', historyLabel='Historial de vigencias';
    const reviewLabel='Revisé y acepto las reglas de venta, comisión y fechas logísticas guardadas.';
    const policyDialog=page.getByRole('dialog',{name:'Agregar vigencia de reglas',exact:true});
    const prefs=page.getByRole('dialog',{name:'Editar preferencias del negocio',exact:true});
    const writes=[];
    page.on('request',req=>{
      if(new URL(req.url()).pathname==='/api/admin/business/settings'&&req.method()==='PUT')writes.push(req);
    });
    async function open(via,id,q,native,{form=null}={}){
      if(via==='panel'){await native.click();return;}
      let entry;
      if(form){
        await form.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        entry=page.getByRole('dialog',{name:/Ali/});
      }else entry=await openAli(page);
      if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="business.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(native).toBeFocused();
    }
    const stored=async()=>{
      const {version,updatedAt,automation,...value}=await getBusinessSettings(store);
      return value;
    };
    async function save(dialog,label,count){
      const response=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/admin/business/settings'&&res.request().method()==='PUT');
      await dialog.getByRole('button',{name:label,exact:true}).click();
      const result=await response;
      expect(result.ok(),await result.text()).toBe(true);
      await expect(dialog).toHaveCount(0);
      expect(writes).toHaveLength(count);
      return stored();
    }
    try{
      for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
        const before=await stored(), count=writes.length;
        await page.goto(href);
        const history=page.getByText(historyLabel,{exact:true});
        await test.step('business.financial-rules',async()=>{
          await open(via,'financial-rules','revisar qué reglas financieras rigen',history);
          if(via!=='panel')await page.keyboard.press('Enter');
          for(const rule of before.rulesVersions)await expect(page.getByText(`Desde ${rule.effectiveOn}`,{exact:true})).toBeVisible();
          expect(writes).toHaveLength(count);
          expect(await stored()).toEqual(before);
        });
        await test.step('business.policy-version',async()=>{
          const add=page.getByRole('button',{name:'Agregar nueva vigencia',exact:true});
          await open(via,'policy-version','agregar reglas financieras a partir de una nueva fecha',add);
          if(via!=='panel')await page.keyboard.press('Enter');
          await expect(policyDialog).toBeVisible();
          const effectiveOn=addC6ReportDays(bogotaDate(),101+index);
          await policyDialog.getByLabel('Vigente desde (Bogotá)',{exact:true}).fill(effectiveOn);
          await policyDialog.getByRole('combobox',{name:'Reconocer la venta',exact:true}).selectOption('dispatched');
          await policyDialog.getByLabel('Motivo del cambio',{exact:true}).fill(`Vigencia de prueba ${via}`);
          await expect(policyDialog.getByRole('button',{name:'Agregar vigencia',exact:true})).toBeDisabled();
          if(via==='directorio'){
            const buttons=policyDialog.locator('footer button');
            const positions=await buttons.evaluateAll(nodes=>nodes.map(node=>{const {top,left,right,bottom}=node.getBoundingClientRect();return {top,left,right,bottom};}));
            expect(positions).toHaveLength(3);
            if(info.project.name==='mobile'){
              expect(positions.every(({left,right})=>left>=0&&right<=320)).toBe(true);
              expect(Math.max(...positions.map(({top})=>top))).toBeLessThan(Math.min(...positions.map(({bottom})=>bottom)));
            }
            await screenshot(page,info,'advisor-c6-vigencia-sin-confirmar');
          }
          expect(await stored()).toEqual(before);
          await policyDialog.getByRole('checkbox',{name:/Revisé la fecha de vigencia/}).check();
          const after=await save(policyDialog,'Agregar vigencia',count+1);
          const version=after.rulesVersions.find(rule=>rule.effectiveOn===effectiveOn);
          expect(version).toMatchObject({effectiveOn,saleRecognition:'dispatched'});
          expect(after.rulesVersions.filter(rule=>rule.id!==version.id)).toEqual(before.rulesVersions);
          expect(after).toEqual({...before,rulesVersions:after.rulesVersions,setupPolicyConfirmed:true});
          await expect(page.getByRole('heading',{name:policyTitle,exact:true}).locator('../..')).not.toContainText(`Vigente desde ${effectiveOn}`);
        });
        await test.step('business.preferences',async()=>{
          const previous=await stored(), time=`0${index+5}:17`;
          const edit=page.getByRole('button',{name:'Editar preferencias',exact:true});
          await open(via,'preferences','cambiar predeterminadas y programación operativa',edit);
          if(via!=='panel')await page.keyboard.press('Enter');
          await prefs.getByLabel('Hora local de generación (Bogotá)',{exact:true}).fill(time);
          expect(await stored()).toEqual(previous);
          expect(await save(prefs,'Guardar preferencias',count+2)).toEqual({...previous,reportGenerationTime:time});
          await expect(page.getByText(new RegExp(`${time} Bogotá`))).toBeVisible();
        });
        await test.step('business.accept-saved-policy',async()=>{
          const current=await getBusinessSettings(store);
          await saveBusinessSettings(store,{...current,setupPolicyConfirmed:false,requestId:randomUUID()},actor);
          const draftBase=await stored();
          await page.goto(href);
          await page.getByRole('button',{name:'Editar preferencias',exact:true}).click();
          const check=prefs.getByRole('checkbox',{name:reviewLabel,exact:true});
          await expect(check).not.toBeChecked();
          if(via!=='panel')await open(via,'accept-saved-policy','aceptar la revisión de las reglas ya guardadas',check,{form:prefs});
          await expect(check).not.toBeChecked();
          expect(await stored()).toEqual(draftBase);
          expect(writes).toHaveLength(count+2);
          await check.check();
          expect(await save(prefs,'Guardar preferencias',count+3)).toEqual({...draftBase,setupPolicyConfirmed:true});
        });
      });
    }finally{
      const current=await getBusinessSettings(store);
      await saveBusinessSettings(store,{...start,version:current.version,requestId:randomUUID()},actor);
    }
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: conserva el gasto al abonar, corregir, recuperar y revertir pagos',async({page,context,request},info)=>{
  test.setTimeout(120000);
  page.setDefaultTimeout(12000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),today=bogotaDate(),code=randomUUID().slice(0,7);
    const draft=fields=>({requestId:randomUUID(),...fields});
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(path);
    });
    const detail=page.locator('.cash-detail');
    async function reach(via,id,q,control){
      if(via==='panel')return;
      let entry=await openAli(page);
      if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="cash.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(control).toBeFocused();
    }
    const owner=await saveResource(store,'people',draft({name:`Responsable gastos ${code}`}),actor);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const account=await saveAccount(store,draft({name:`Caja pagos ${code} ${via}`,type:'bank',openingOn:today,openingBalanceMinor:2_000_000,responsibleId:owner.id}),actor);
      const original=await recordExpense(store,draft({concept:`Gasto de proveedor ${code} ${via}`,category:'operating',amountMinor:1_000_000,incurredOn:today}),actor);
      const target=`/admin?section=cash&tab=expenses&period=day&anchor=${today}&q=${encodeURIComponent(original.concept)}`;
      await page.goto(target);
      await page.getByRole('region',{name:'Gastos y pagos',exact:true}).getByRole('article').filter({hasText:original.concept}).getByRole('button',{name:'Ver detalle',exact:true}).click();
      await expect(detail.getByRole('heading',{name:`Detalle · ${original.concept}`,exact:true})).toBeVisible();
      const read=async()=>{
        const response=await context.request.get(`/api/admin/finance/expenses?record=${original.id}`);
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const ledger=async()=>(await store.db.all(`SELECT id,amount_minor,source_id,reversal_of FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]))
        .map(row=>({...row,amount_minor:Number(row.amount_minor)}));
      async function action({id,q,control,title,endpoint,inputs,submit=title},expected){
        await test.step(`cash.${id}`,async()=>{
          const before=await read(), movements=await ledger(), count=writes.length;
          await reach(via,id,q,control);
          if(control===reverseChoice)await detail.getByRole('button',{name:'Revertir recuperación',exact:true}).click();
          else if(via==='panel')await control.click();
          else await page.keyboard.press('Enter');
          const dialog=page.getByRole('dialog',{name:title,exact:true});
          await expect(dialog).toBeVisible();
          for(const [field,value] of Object.entries(inputs||{})){
            const input=dialog.locator(`[name="${field}"]`);
            if(field==='accountId')await input.selectOption(value);
            else await input.fill(value);
          }
          expect(await read()).toEqual(before);
          expect(await ledger()).toEqual(movements);
          expect(writes).toHaveLength(count);
          const path=`/api/admin/business/actions/${endpoint}`;
          const committed=page.waitForResponse(res=>new URL(res.url()).pathname===path&&res.request().method()==='POST');
          await dialog.getByRole('button',{name:submit,exact:true}).click();
          const response=await committed;
          expect(response.ok(),await response.text()).toBe(true);
          const receipt=await response.json();
          await expect(dialog).toHaveCount(0);
          expect(writes.slice(count)).toEqual([path]);
          const saved=await read(), after=await ledger();
          expect(saved).toMatchObject({id:original.id,...expected.balance});
          expect(after.filter(row=>movements.some(previous=>previous.id===row.id))).toEqual(movements);
          const added=after.filter(row=>!movements.some(previous=>previous.id===row.id));
          if(expected.cash===0){
            expect(added).toEqual([]);
            expect(saved.activePayments).toEqual(before.activePayments);
            expect(saved.version).toBe(before.version+1);
          }else{
            expect(added).toEqual([expect.objectContaining({id:receipt.payment.cashEntryId,amount_minor:expected.cash})]);
            if(!expected.reverse)expect(added[0].source_id).toBe(receipt.payment.id);
            expect(saved.version).toBe(before.version);
          }
          if(expected.reverse){
            const previous=before.activePayments.find(payment=>payment.kind==='recovery');
            expect(receipt.payment.reversalOf).toBe(previous.id);
            expect(added[0].reversal_of).toBe(previous.cashEntryId);
            expect(saved.activePayments).toEqual(before.activePayments.filter(payment=>payment.id!==previous.id));
          }
          const sent=response.request();
          const replay=await context.request.post(path,{data:sent.postDataJSON(),headers:{origin:await sent.headerValue('origin'),'x-csrf-token':await sent.headerValue('x-csrf-token')}});
          expect(replay.ok()).toBe(true);
          expect(await replay.json()).toEqual(receipt);
          expect(await ledger()).toEqual(after);
        });
      }
      const pay=detail.getByRole('button',{name:'Pagar saldo o abono',exact:true});
      const correction=detail.getByRole('button',{name:'Corregir importe o fecha con motivo',exact:true});
      const recover=detail.getByRole('button',{name:'Recuperar sobrepago',exact:true});
      const reverseChoice=detail.getByRole('heading',{name:'Pagos y recuperaciones vigentes',exact:true});
      const payment={control:pay,title:'Pagar gasto',endpoint:'pay-expense'};
      const fields={accountId:account.id,effectiveOn:today};
      await action({...payment,id:'part-pay-expense',q:'pago parcial a proveedor',inputs:{...fields,amountMinor:'2.500,00'}},{cash:-250000,balance:{paidMinor:250000,outstandingMinor:750000,creditMinor:0}});
      await action({...payment,id:'pay-expense',q:'liquidar saldo del gasto',inputs:{...fields,amountMinor:'7.500,00'}},{cash:-750000,balance:{paidMinor:1000000,outstandingMinor:0,creditMinor:0}});
      await action({id:'correct-expense',q:'editar importe registrado',control:correction,title:'Registrar gasto',submit:'Guardar corrección del gasto',endpoint:'expense',inputs:{amountMinor:'6.000,00',reason:'Ajuste respaldado por el proveedor'}},
        {cash:0,balance:{amountMinor:600000,paidMinor:1000000,outstandingMinor:0,creditMinor:400000}});
      await action({id:'recover-expense-credit',q:'recuperar crédito de proveedor',control:recover,title:'Recuperar sobrepago',endpoint:'expense-recovery',inputs:{...fields,amountMinor:'1.500,00',reason:'Importe devuelto por el proveedor'}},
        {cash:150000,balance:{amountMinor:600000,paidMinor:850000,outstandingMinor:0,creditMinor:250000}});
      await action({id:'reverse-expense-payment',q:'revertir recuperación de sobrepago',control:reverseChoice,title:'Revertir documento',endpoint:'document-reverse',inputs:{effectiveOn:today,reason:'Comprobante de devolución duplicado'}},
        {cash:-150000,balance:{amountMinor:600000,paidMinor:1000000,outstandingMinor:0,creditMinor:400000},reverse:true});
      expect((await ledger()).reduce((total,row)=>total+row.amount_minor,0)).toBe(1_000_000);
      await expect(detail).toContainText('Crédito');
      if(via==='directorio')await screenshot(page,info,'advisor-c6-gasto-credito');
    });
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: guarda obsequios compuestos y combos privados solo desde sus fichas',async({page,context,request},info)=>{
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await loginWithAdvisorFixture(page,request);
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const seed=(kind,key,extra)=>store.save(kind,{...emptyRecord(kind),title:`${key} ${code}`,slug:`c6-${key.toLowerCase().replaceAll(' ','-')}-${code}`,status:'draft',...extra},null,null,actorId);
    const references=await Promise.all([12,30,45].map((stock,index)=>seed('products',`Componente ${index+1}`,{
      price:20000+index*1000,presentation:'Unidad privada',stockQuantity:stock,orderable:true,unitCostMinor:300000+index*10000,
    })));
    const catalogs=await Promise.all(['Colección inicial','Colección elegida','Colección sin elegir'].map((title,index)=>seed('catalogs',`Coleccion ${index+1}`,{title:`${title} ${code}`})));
    const finance=()=>store.readSnapshot(async tx=>({
      expenses:await tx.db.all(`SELECT * FROM ${tx.t('expenses')} ORDER BY id`),
      cash:await tx.db.all(`SELECT * FROM ${tx.t('cash_entries')} ORDER BY id`),
    }));
    const startingCash=await finance(), storefront=await store.settings(), publicData=await store.publicData();
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(!['GET','HEAD'].includes(req.method())&&path.startsWith('/api/admin/')&&!/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(path))writes.push(`${req.method()} ${path}`);
    });
    const editor=page.locator('dialog.editor-drawer');
    const field=name=>editor.locator(`[name="${name}"]`);
    const gift=editor.getByRole('group',{name:'Productos del obsequio',exact:true});
    const costs=editor.locator('details.editor-more-options').filter({has:page.locator('summary').filter({hasText:'Costos y obsequios'})});
    const orderable=editor.getByRole('checkbox',{name:'Disponible para pedidos',exact:true});
    const membership=editor.getByRole('group',{name:/^Catálogos \(/});
    const catalogCheckbox=catalog=>membership.getByRole('checkbox',{name:catalog.title,exact:true});
    const disclosure=costs.locator('summary');
    const giftList=`/admin?section=products&productType=gift&status=draft&q=${code}`;
    const comboList=`/admin?section=combos&status=draft&q=${code}`;
    const actions={
      create:{id:'create-gift',query:'crear regalo',target:gift,marker:'gift-components-editor'},
      update:{id:'update-gift',query:'editar productos del regalo',target:gift,marker:'gift-components-editor'},
      orderable:{id:'set-combo-orderability',query:'combo disponible para pedidos',target:orderable,marker:'combo-orderability'},
      catalog:{id:'assign-combo-catalogs',query:'agregar combo a catálogo',target:membership,marker:'combo-catalog-membership'},
    };
    const editButton=record=>page.getByRole('button',{name:`Editar ${record.title}`,exact:true});
    const toolbar=label=>page.locator('.list-toolbar').getByRole('button',{name:label,exact:true});
    const submit=label=>editor.getByRole('button',{name:label,exact:true});
    const ali=()=>page.getByRole('dialog',{name:'Ali, asistente del negocio'});
    const openHelp=()=>editor.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
    const directory=async entry=>{
      await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      return page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
    };
    async function handoff(via,entry,action){
      if(via==='chat')await askAli(entry,`¿Dónde está ${action.query}?`);
      else{
        entry=await directory(entry);
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(action.query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="products.${action.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
      return entry;
    }
    async function reach(via,action,{fromList=false}={}){
      const before=writes.length;
      if(via==='panel'){
        if(fromList)await toolbar('Crear obsequio').click();
        if(action.target===gift&&await costs.getAttribute('open')===null)await disclosure.click();
      }else{
        if(!fromList)await openHelp();
        const entry=await handoff(via,fromList?await openAli(page):ali(),action);
        await expect(action.target).toBeFocused();
        await expect(entry).toBeHidden();
      }
      await expect(action.target).toBeVisible();
      await expect(action.target).toHaveAttribute('data-advisor-control',action.marker);
      expect(writes).toHaveLength(before);
      if(via==='directorio'){
        expect(await action.target.evaluate(node=>{
          const {left,right}=node.getBoundingClientRect();return left>=-1&&right<=innerWidth+1;
        })).toBe(true);
        await screenshot(page,info,`advisor-c6-${action.id}`);
      }
    }
    async function openRecord(kind,row){
      await page.goto(kind==='products'?giftList:comboList);
      await editButton(row).click();
      await expect(editor.getByRole('heading',{name:kind==='products'?'Editar obsequio':'Editar combo',exact:true})).toBeVisible();
      await expect(field('title')).toHaveValue(row.title);
      await expect(field('status')).toHaveValue('draft');
    }
    async function commit(kind,row,label,expected){
      const method=row?'PUT':'POST', path=`/api/admin/${kind}${row?`/${row.id}`:''}`, before=writes.length;
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path),
        submit(label).click(),
      ]);
      expect(response.status(),await response.text()).toBe(row?200:201);
      const {stockAvailable,availability,...editable}=expected;
      expect(response.request().postDataJSON()).toMatchObject({...editable,status:'draft',...(row?{version:row.version}:{})});
      const record=await response.json();
      expect(record).toMatchObject({...expected,status:'draft',version:row?row.version+1:1});
      if(row)expect(record.id).toBe(row.id);
      else expect(record.id).toMatch(/^[\da-f-]{36}$/i);
      expect(await store.get(kind,record.id)).toEqual(record);
      await expect(editor).toHaveCount(0);
      await expect(page.getByText(`Guardado: ${record.title} · Borrador`,{exact:true})).toBeVisible();
      expect(writes.slice(before)).toEqual([`${method} ${path}`]);
      expect(await finance()).toEqual(startingCash);
      expect(await store.publicData()).toEqual(publicData);
      return record;
    }
    async function setLine(index,product,quantity){
      await gift.getByRole('combobox',{name:`Producto ${index}`,exact:true}).selectOption(product.id);
      await gift.getByRole('spinbutton',{name:`Cantidad ${index}`,exact:true}).fill(String(quantity));
    }
    const addLine=()=>gift.getByRole('button',{name:'Agregar producto',exact:true}).click();
    const giftFields={productType:'gift',price:0,stockQuantity:null,unitCostMinor:null,orderable:true,catalogIds:[]};

    await test.step('un producto físico con cambios no se convierte en obsequio por una acción de Ali',async()=>{
      await page.goto(`/admin?section=products&productType=product&q=${code}`);
      await toolbar('Crear producto').click();
      const title=`Borrador físico ${code}`;
      await field('title').fill(title);
      await field('stockQuantity').fill('8');
      await openHelp();
      const entry=await handoff('directorio',ali(),actions.create);
      await expect(entry.getByText(/El control no se abrió/)).toBeVisible();
      await entry.getByRole('button',{name:'Cerrar directorio',exact:true}).click();
      if(await ali().isVisible())await ali().getByRole('button',{name:'Cerrar asistente',exact:true}).click();
      await expect(editor.getByRole('heading',{name:'Crear producto',exact:true})).toBeVisible();
      await expect(field('title')).toHaveValue(title);
      await expect(field('stockQuantity')).toHaveValue('8');
      await expect(field('productType')).toHaveValue('product');
      await expect(gift).toHaveCount(0);
      expect(writes).toEqual([]);
      page.once('dialog',dialog=>dialog.accept());
      await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
      await expect(editor).toHaveCount(0);
    });

    for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
      const [a,b,c]=references;
      const createTitle=`Obsequio privado ${code} ${via}`, updateTitle=`${createTitle} revisado`;
      const initialItems=[{productId:a.id,quantity:index+1},{productId:b.id,quantity:2}];
      const revisedItems=[{productId:a.id,quantity:index+2},{productId:c.id,quantity:3}];
      const available=items=>Math.min(...items.map(({productId,quantity})=>Math.floor(references.find(row=>row.id===productId).stockQuantity/quantity)));
      let savedGift;
      await test.step('products.create-gift',async()=>{
        await page.goto(giftList);
        await expect(toolbar('Crear obsequio')).toBeVisible();
        await reach(via,actions.create,{fromList:true});
        await expect(editor.getByRole('heading',{name:'Crear obsequio',exact:true})).toBeVisible();
        await expect(field('productType')).toHaveValue('gift');
        await expect(field('stockQuantity')).toHaveCount(0);
        await expect(field('unitCostMinor')).toHaveCount(0);
        await field('title').fill(createTitle);
        await field('price').fill('0');
        await expect(field('status')).toHaveValue('draft');
        await addLine();await setLine(1,a,index+1);
        await addLine();await setLine(2,b,2);
        expect((await store.list('products')).some(row=>row.title===createTitle)).toBe(false);
        savedGift=await commit('products',null,'Crear obsequio',{...giftFields,title:createTitle,items:initialItems,stockAvailable:available(initialItems)});
      });
      await test.step('products.update-gift',async()=>{
        await openRecord('products',savedGift);
        await expect(gift.getByRole('combobox',{name:'Producto 2',exact:true})).toHaveValue(b.id);
        await field('title').fill(updateTitle);
        await setLine(1,a,index+2);
        await gift.getByRole('button',{name:'Quitar producto 2',exact:true}).click();
        await addLine();await setLine(2,c,3);
        await expect(gift.getByRole('combobox',{name:'Producto 2',exact:true}).locator(`option[value="${savedGift.id}"]`)).toHaveCount(0);
        await disclosure.click();
        await reach(via,actions.update);
        await expect(field('title')).toHaveValue(updateTitle);
        await expect(gift.getByRole('combobox',{name:'Producto 2',exact:true})).toHaveValue(c.id);
        expect(await store.get('products',savedGift.id)).toEqual(savedGift);
        expect(available(revisedItems)).not.toBe(available(initialItems));
        savedGift=await commit('products',savedGift,'Guardar cambios',{...giftFields,title:updateTitle,items:revisedItems,stockAvailable:available(revisedItems)});
      });
      const comboItems=[{productId:b.id,quantity:index+1},{productId:c.id,quantity:2}];
      const enabled=index!==1;
      const comboFields={price:53000,items:comboItems,orderable:enabled,stockAvailable:available(comboItems),availability:enabled?'available':'soldout'};
      let combo=await seed('combos',`Combo privado ${via}`,{price:53000,orderable:!enabled,items:comboItems,catalogIds:[catalogs[0].id]});
      await test.step('products.set-combo-orderability',async()=>{
        await openRecord('combos',combo);
        await reach(via,actions.orderable);
        await expect(orderable).toBeChecked({checked:!enabled});
        await orderable.setChecked(enabled);
        expect(await store.get('combos',combo.id)).toEqual(combo);
        combo=await commit('combos',combo,'Guardar borrador',{...comboFields,title:combo.title,catalogIds:[catalogs[0].id]});
      });
      await test.step('products.assign-combo-catalogs',async()=>{
        await openRecord('combos',combo);
        await reach(via,actions.catalog);
        await expect(catalogCheckbox(catalogs[0])).toBeChecked();
        await expect(catalogCheckbox(catalogs[1])).not.toBeChecked();
        await catalogCheckbox(catalogs[0]).uncheck();
        await catalogCheckbox(catalogs[1]).check();
        await expect(catalogCheckbox(catalogs[2])).not.toBeChecked();
        expect(await store.get('combos',combo.id)).toEqual(combo);
        combo=await commit('combos',combo,'Guardar borrador',{...comboFields,title:combo.title,catalogIds:[catalogs[1].id]});
        await openRecord('combos',combo);
        await expect(catalogCheckbox(catalogs[0])).not.toBeChecked();
        await expect(catalogCheckbox(catalogs[1])).toBeChecked();
        await expect(orderable).toBeChecked({checked:enabled});
        await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
        await expect(editor).toHaveCount(0);
      });
    });
    expect(writes).toHaveLength(12);
    expect(await store.settings()).toEqual(storefront);
    for(const row of references)expect(await store.get('products',row.id)).toEqual(row);
    for(const row of catalogs)expect(await store.get('catalogs',row.id)).toEqual(row);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: edita y vincula solo la guía exacta con evidencia y selección humana',async({page,context,request},info)=>{
  test.setTimeout(180000);
  page.setDefaultTimeout(12000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),code=randomUUID().slice(0,7),day=bogotaDate();
    const command=input=>({requestId:randomUUID(),...input});
    const guidePath=id=>`/api/admin/business/shipments/${id}`;
    const linkPath='/api/admin/business/actions/link-shipment';
    const orderLabel=number=>`AN-${String(number).padStart(6,'0')}`;
    const writes=[],hekaRequests=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(path.startsWith('/api/admin/shipping/heka'))hekaRequests.push(path);
      if(req.method()!=='GET'&&path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/'))writes.push(`${req.method()} ${path}`);
    });
    const read=async path=>{
      const response=await context.request.get(path);
      expect(response.ok(),await response.text()).toBe(true);
      return response.json();
    };
    const effects=async()=>Object.fromEntries(await Promise.all(['cash_entries','order_collections','order_returns','orders','shipments','shipment_events','heka_api_mutations','heka_api_order_links'].map(async table=>[table,(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n])));
    const formHelp=drawer=>drawer.getByRole('heading',{name:'Registrar estado y fecha',exact:true}).locator('..').getByRole('button',{name:'Ayúdame con este formulario',exact:true});
    const card=tracking=>page.getByRole('article').filter({has:page.getByRole('heading',{name:tracking,exact:true})});
    async function openGuide(guide,linked){
      await page.goto(`/admin?section=orders&tab=shipments&q=${encodeURIComponent(guide.tracking)}`);
      await card(guide.tracking).getByRole('button',{name:linked?'Ver envío':'Revisar y vincular',exact:true}).click();
      const drawer=page.getByRole('dialog',{name:guide.tracking,exact:true});
      await expect(drawer).toHaveAttribute('data-shipment-version',String(guide.version));
      return drawer;
    }
    async function viaAli(drawer,via,capability,alias){
      await formHelp(drawer).click();
      let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
      if(via==='chat')await askAli(entry,`¿Dónde está ${alias}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(alias);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="shipments.${capability}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:9000});
    }
    async function seed(label,linked,withPrior=false){
      const key=`${code}-${label}`,customerName=`Destinatario mismo nombre ${key}`;
      const product=await store.save('products',{...emptyRecord('products'),title:`Perfil de envío ${key}`,slug:`perfil-envio-${key}`,status:'draft',price:19000,presentation:'Unidad',stockQuantity:20,orderable:true},null,null,actorId);
      const orderInput=()=>businessOrderInput(product,{placedOn:day,customerName,items:[{lineId:randomUUID(),kind:'products',itemId:product.id,quantity:3,unitPriceMinor:1900000,discountMinor:0}]});
      const order=await store.saveOrder(orderInput(),actorId),decoy=await store.saveOrder(orderInput(),actorId);
      const allocation=quantity=>[{lineId:order.items[0].lineId,quantity}];
      const prior=withPrior?await createShipment(store,command({orderId:order.id,carrier:`Otro operador ${key}`,tracking:`REL-${key}`,assignments:allocation(1)}),actorId):null;
      const guide=await createShipment(store,command({orderId:linked?order.id:undefined,carrier:`Operador ${key}`,tracking:`C6-${key}`,estimatedDeliveryOn:day,notes:`Nota previa ${key}`}),actorId);
      return {guide,product,order,prior,decoy,allocation,customerName};
    }
    const cases=[
      ['update-metadata','editar transportadora',true,false],
      ['correct-notes','nota de guía despachada',true,true],
      ['find-order-to-link','buscar pedido para guía huérfana',false,false],
      ['link-orphan','asociar guía sin pedido',false,false],
    ];
    for(const [capability,alias,linked,dispatched] of cases)await test.step(`shipments.${capability}`,async()=>{
      for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
        const data=await seed(`${capability}-${via}`,linked,!linked&&via==='directorio');
        const guide=dispatched?await recordShipmentEvent(store,data.guide.id,command({version:data.guide.version,status:'collected',occurredOn:day}),actorId):data.guide;
        const path=guidePath(guide.id),previous=await read(path),orderBefore=await store.order(data.order.id);
        const decoyBefore=await store.order(data.decoy.id),oldEffects=await effects(),mark=writes.length;
        const drawer=await openGuide(guide,linked);
        const lookup=capability==='find-order-to-link';
        const summary=drawer.locator('summary').filter({hasText:dispatched?'Corregir notas del envío':'Guía, notas y distribución de cantidades'});
        const metadata=summary.locator('..');
        const carrier=metadata.getByRole('textbox',{name:'Transportadora',exact:true});
        const notes=metadata.getByRole('textbox',{name:'Notas',exact:true});
        const identity=drawer.getByRole('searchbox',{name:'Número AN o guía exacta',exact:true});
        const linkHeading=drawer.getByRole('heading',{name:'Vincular esta guía con un pedido existente',exact:true});
        if(via==='panel'){
          if(linked)await summary.click();
          else await drawer.getByRole('button',{name:lookup?'Identificar el pedido':'Vincular pedido conocido',exact:true}).click();
        }else{
          await viaAli(drawer,via,capability,alias);
          const focus=linked?(dispatched?notes:carrier):(lookup?identity:linkHeading);
          await expect(focus).toBeFocused();
          if(via==='directorio'){
            await expect(focus).toBeInViewport();
            await screenshot(page,info,`advisor-c6-${capability}-control`);
          }
        }
        await expect(page).toHaveURL(url=>url.searchParams.get('section')==='orders'&&url.searchParams.get('tab')==='shipments'&&url.searchParams.get('record')===guide.id&&url.searchParams.get('q')===guide.tracking);
        expect(writes).toHaveLength(mark);
        expect(await read(path)).toEqual(previous);
        let submit,method,endpoint,expectedPayload,expectedState;
        const newNotes=`Evidencia revisada ${capability} ${via} ${code}`;
        if(linked){
          const tracking=metadata.getByRole('textbox',{name:'Guía',exact:true}),estimate=metadata.getByLabel('Entrega estimada',{exact:true});
          const quantity=metadata.getByRole('spinbutton',{name:new RegExp(data.product.title)});
          const reason=metadata.getByRole('textbox',{name:'Motivo de corrección',exact:true});
          await expect(carrier).toHaveValue(previous.carrier);
          await expect(tracking).toHaveValue(previous.tracking);
          await expect(estimate).toHaveValue(day);
          await expect(quantity).toHaveValue('3');
          await expect(notes).toHaveValue(previous.notes);
          await expect(reason).toHaveValue('');
          await notes.fill(newNotes);
          method='PUT';endpoint=path;
          submit=metadata.getByRole('button',{name:dispatched?'Guardar corrección de notas':'Guardar guía y notas',exact:true});
          if(dispatched){
            for(const field of [carrier,tracking,estimate,quantity])await expect(field).toBeDisabled();
            await expect(reason).toHaveAttribute('required','');
            await submit.click();
            expect(writes).toHaveLength(mark);
            const explanation=`El soporte aclara la nota: ${via}`;
            await reason.fill(explanation);
            expectedPayload={version:previous.version,notes:newNotes,reason:explanation};
            expectedState={carrier:previous.carrier,tracking:previous.tracking,estimatedDeliveryOn:day,assignments:previous.assignments,notes:newNotes};
          }else{
            const changed={carrier:`Operador comprobado ${via} ${code}`,tracking:`${guide.tracking}-CORREGIDA`,estimatedDeliveryOn:addC6ReportDays(day,1),assignments:data.allocation(2),notes:newNotes};
            await carrier.fill(changed.carrier);
            await tracking.fill(changed.tracking);
            await estimate.fill(changed.estimatedDeliveryOn);
            await quantity.fill('2');
            expectedPayload={...changed,version:previous.version,replacesShipmentId:'',reason:''};
            expectedState=changed;
          }
        }else{
          await expect(identity).toHaveValue('');
          const section=drawer.getByRole('region',{name:lookup?'Identificar el pedido de esta guía':'Vincular esta guía con un pedido existente',exact:true});
          const candidates=section.getByRole('list',{name:'Pedidos que coinciden con la identidad',exact:true});
          await expect(candidates).toHaveCount(0);
          const query=async(value,count)=>{
            const received=page.waitForResponse(res=>{
              const url=new URL(res.url());
              return res.request().method()==='GET'&&url.pathname==='/api/admin/orders'&&url.searchParams.get('lookup')==='identity'&&url.searchParams.get('q')===value;
            });
            await identity.fill(value);
            const response=await received;
            expect(response.ok()).toBe(true);
            expect((await response.json()).records.map(({id})=>id)).toEqual(count?[data.order.id]:[]);
          };
          await query(data.customerName,0);
          await expect(section.getByText(/^No hay pedidos con esa identidad/)).toBeVisible();
          await query(via==='directorio'?data.prior.tracking:orderLabel(data.order.number),1);
          const chosen=candidates.getByRole('button',{name:new RegExp(`^${orderLabel(data.order.number)} · `)});
          await expect(candidates.getByRole('button')).toHaveCount(1);
          await expect(chosen).toHaveAttribute('aria-pressed','false');
          await expect(section.getByRole('button',{name:'Vincular pedido',exact:true})).toHaveCount(0);
          const selection=page.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===`/api/admin/orders/${data.order.id}`);
          await chosen.click();
          expect((await (await selection).json()).version).toBe(orderBefore.version);
          await expect(chosen).toHaveAttribute('aria-pressed','true');
          if(lookup){
            const lines=section.getByRole('region',{name:`Líneas de ${orderLabel(data.order.number)}`,exact:true});
            await expect(lines.getByRole('listitem')).toHaveText(`${data.product.title} · Unidad · 3 unidades`);
            await expect(section.getByRole('button',{name:'Vincular pedido',exact:true})).toHaveCount(0);
            expect(await read(path)).toEqual(previous);
            expect(await store.order(data.order.id)).toEqual(orderBefore);
            expect(await store.order(data.decoy.id)).toEqual(decoyBefore);
            expect(await effects()).toEqual(oldEffects);
            expect(writes).toHaveLength(mark);
            return;
          }
          const quantity=section.getByRole('spinbutton',{name:new RegExp(data.product.title)});
          const reason=section.getByRole('textbox',{name:/^Motivo/});
          await expect(quantity).toHaveValue('0');
          await expect(reason).toHaveValue('');
          await reason.fill(newNotes);
          submit=section.getByRole('button',{name:'Vincular pedido',exact:true});
          await expect(submit).toBeDisabled();
          await quantity.fill('2');
          await expect(submit).toBeEnabled();
          method='POST';endpoint=linkPath;
          expectedPayload={shipmentId:guide.id,orderId:data.order.id,version:previous.version,assignments:data.allocation(2),reason:newNotes};
          expectedState={orderId:data.order.id,assignments:data.allocation(2),notes:previous.notes,tracking:previous.tracking,carrier:previous.carrier,estimatedDeliveryOn:day};
        }
        expect(writes).toHaveLength(mark);
        expect(await read(path)).toEqual(previous);
        const [response]=await Promise.all([
          page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===endpoint),
          submit.click(),
        ]);
        const result=await response.json();
        expect(response.ok(),JSON.stringify(result)).toBe(true);
        const sent=response.request(),body=sent.postDataJSON(),{requestId,...operation}=body;
        expect(requestId).toMatch(/^[\w-]{16,100}$/);
        expect(operation).toEqual(expectedPayload);
        expect(result).toMatchObject({id:guide.id,version:previous.version+1,status:previous.status,orderId:linked?previous.orderId:data.order.id,...expectedState});
        expect(result.events).toEqual(previous.events);
        const saved=page.getByRole('dialog',{name:result.tracking,exact:true});
        await expect(saved).toHaveAttribute('data-shipment-version',String(result.version));
        await expect(saved.getByText(linked?'Envío actualizado.':'Guía vinculada al pedido.',{exact:true})).toBeVisible();
        const replay=await context.request.fetch(endpoint,{method,data:body,headers:{origin:await sent.headerValue('origin'),'x-csrf-token':await sent.headerValue('x-csrf-token')}});
        expect(replay.ok(),await replay.text()).toBe(true);
        expect(await replay.json()).toEqual(result);
        expect(await read(path)).toMatchObject(result);
        const orderAfter=await store.order(data.order.id);
        expect(orderAfter).toMatchObject({version:orderBefore.version,status:orderBefore.status,items:orderBefore.items,totalMinor:orderBefore.totalMinor,paymentSummary:orderBefore.paymentSummary,recognition:orderBefore.recognition});
        expect(orderAfter.shipments.filter(record=>record.id===guide.id)).toHaveLength(1);
        expect(orderAfter.shipments.filter(record=>record.id!==guide.id)).toEqual(orderBefore.shipments.filter(record=>record.id!==guide.id));
        expect(await store.order(data.decoy.id)).toEqual(decoyBefore);
        expect(await effects()).toEqual(oldEffects);
        expect(writes.slice(mark)).toEqual([`${method} ${endpoint}`]);
      });
    });
    await test.step('rechaza una versión vencida y conserva la identidad Heka protegida',async()=>{
      const mark=writes.length;
      const stale=(await seed('guia-vencida',true)).guide;
      let drawer=await openGuide(stale,true);
      const fresh=await recordShipmentEvent(store,stale.id,command({version:stale.version,status:'incident',occurredOn:day}),actorId);
      await viaAli(drawer,'chat','update-metadata','editar transportadora');
      await expect(drawer.locator('[role=alert]').filter({hasText:'El envío cambió. Carga los datos actuales antes de continuar.'})).toBeVisible();
      await expect(drawer.locator('details[open]').filter({has:page.getByText('Guía, notas y distribución de cantidades',{exact:true})})).toHaveCount(0);
      expect(await read(guidePath(stale.id))).toMatchObject(fresh);

      const {guide,order}=await seed('identidad-protegida',true);
      await insertRow(store,'heka_api_order_links',{
        guide_id:randomUUID().replaceAll('-','').slice(0,24),carrier:'coordinadora',guide_number:guide.tracking,
        order_id:order.id,shipment_id:guide.id,local_carrier:guide.carrier,provider_status:'created',actor_id:actorId,linked_at:new Date().toISOString(),
      });
      drawer=await openGuide(guide,true);
      expect((await read(guidePath(guide.id))).hekaIdentityProtected).toBe(true);
      await viaAli(drawer,'chat','update-metadata','editar transportadora');
      await expect(drawer.locator('[role=alert]').filter({hasText:'La identidad de la guía oficial Heka está protegida'})).toBeVisible();
      const summary=drawer.getByText('Guía, notas y distribución de cantidades',{exact:true});
      await summary.click();
      await expect(drawer.getByRole('textbox',{name:'Transportadora',exact:true})).toBeDisabled();
      await expect(drawer.getByRole('textbox',{name:'Guía',exact:true})).toBeDisabled();
      expect(writes).toHaveLength(mark);
      expect(await read(guidePath(guide.id))).toMatchObject(guide);
    });
    expect(hekaRequests).toEqual([]);
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: entrega el cierre de sesión a la persona sin afectar otra sesión',async({page,browser,context,request},info)=>{
  test.setTimeout(60000);
  page.setDefaultTimeout(12000);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  const independent=await browser.newContext({baseURL:info.project.use.baseURL,ignoreHTTPSErrors:true});
  try{
    const independentPage=await independent.newPage();
    await login(independentPage);
    const cookieOf=async target=>(await target.cookies()).find(cookie=>cookie.name===SESSION_COOKIE)?.value;
    const otherToken=await cookieOf(independent);
    expect(otherToken).toBeTruthy();
    let logoutRequests=0;
    page.on('request',req=>{
      if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/auth/logout')logoutRequests++;
    });
    const close=page.getByRole('button',{name:'Cerrar sesión',exact:true});
    for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
      await loginWithAdvisorFixture(page,request);
      const token=await cookieOf(context);
      expect(token).toBeTruthy();
      expect(token).not.toBe(otherToken);
      await page.goto('/admin');
      if(via==='panel'){
        if(info.project.name==='mobile')await page.getByRole('button',{name:'Más',exact:true}).click();
      }else{
        let entry=await openAli(page);
        if(via==='chat')await askAli(entry,'¿Dónde encuentro salir de mi cuenta?');
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill('salir de mi cuenta');
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator('[data-capability-id="home.sign-out"]').getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(close).toBeFocused();
        await expect(close).toBeInViewport();
      }
      expect(logoutRequests).toBe(index);
      expect(await getSession(store,token)).toBeTruthy();
      expect(await cookieOf(context)).toBe(token);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-salida-sin-ejecutar');
      const response=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/auth/logout'&&res.request().method()==='POST');
      if(via==='panel')await close.click();
      else await page.keyboard.press('Enter');
      expect((await response).ok()).toBe(true);
      await expect(page).toHaveURL(url=>url.pathname==='/admin/login');
      expect(logoutRequests).toBe(index+1);
      expect(await cookieOf(context)).toBeUndefined();
      expect(await getSession(store,token)).toBeFalsy();
      expect(await getSession(store,otherToken)).toBeTruthy();
      expect((await independent.request.get('/api/admin/orders')).ok()).toBe(true);
    });
  }finally{
    try{await independent.close();}finally{await store.close();}
  }
});

test('Ali @advisor-c6: abre la preparación de caja sin registrar una apertura desde Inicio',async({page,request,context},info)=>{
  test.setTimeout(65000);
  page.setDefaultTimeout(12000);
  await resetBrowserFixture();
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const accounts=async()=>{
    const res=await context.request.get('/api/admin/business/accounts');
    expect(res.ok()).toBe(true);
    return (await res.json()).records;
  };
  const writes=[];
  page.on('request',req=>{
    if(!['GET','HEAD'].includes(req.method())&&/^\/api\/admin\/(business|finance)\//.test(new URL(req.url()).pathname))writes.push(req.url());
  });
  const checkState=async eligible=>{
    const before=await accounts();
    const dashboard=await context.request.get('/api/admin/dashboard');
    expect(dashboard.ok()).toBe(true);
    const current=await dashboard.json();
    expect(current.empty||current.cash.accountsCount===0).toBe(eligible);
    for(const via of ['panel','chat','directorio'])await test.step(`${eligible?'sin actividad':'con caja operativa'} · ${via}`,async()=>{
      await page.goto('/admin');
      const cta=page.getByRole('button',{name:'Configurar caja',exact:true});
      const drawer=page.locator('dialog.editor-drawer');
      if(!eligible){
        await expect(page.getByRole('region',{name:'Cifras del negocio'})).toBeVisible();
        await expect(cta).toHaveCount(0);
      }
      if(via!=='panel'){
        let entry=await openAli(page);
        const q='configurar caja en inicio';
        if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator('[data-capability-id="home.configure-cash"]').getByRole('button',{name:/^Abrir en el panel:/}).click();
        if(eligible)await expect(cta).toBeFocused();
        else{
          await expect(entry).toHaveCount(0);
          await expect(page.getByRole('main').getByRole('alert')).toContainText('no encontré un control disponible para «Preparar la configuración de caja desde el tablero»');
          await expect(page.getByRole('heading',{name:'Tu negocio',exact:true})).toBeVisible();
        }
      }
      await expect(drawer).toHaveCount(0);
      expect(await accounts()).toEqual(before);
      if(!eligible)return;
      if(via==='panel')await cta.click();
      else await page.keyboard.press('Enter');
      await expect(drawer.getByRole('heading',{name:'Crear cuenta',exact:true})).toBeVisible();
      await expect(drawer.locator('[name="name"]')).toHaveValue('');
      await expect(drawer.locator('[name="openingBalanceMinor"]')).toHaveValue('');
      await expect(drawer.getByRole('button',{name:'Crear cuenta',exact:true})).toBeVisible();
      if(via==='directorio')await screenshot(page,info,'advisor-c6-cuenta-sin-guardar');
      await drawer.getByRole('button',{name:'Cancelar edición',exact:true}).click();
      await expect(drawer).toHaveCount(0);
      expect(await accounts()).toEqual(before);
    });
  };
  await checkState(true);
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate();
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:'Responsable de caja ya configurada'},actor);
    await saveAccount(store,{requestId:randomUUID(),name:'Cuenta operativa existente',type:'cash',openingOn:day,openingBalanceMinor:250000,responsibleId:person.id},actor);
    await recordExpense(store,{requestId:randomUUID(),category:'operating',incurredOn:day,amountMinor:100000,concept:'Gasto pendiente de caja ya configurada'},actor);
  }finally{await store.close();}
  await checkState(false);
  expect(writes).toEqual([]);
});

test('Ali @advisor-c6: vuelve a la fuente y retira solo el aplazamiento personal',async({page,request,context,browser},info)=>{
  test.setTimeout(120000);
  page.setDefaultTimeout(12000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  const peer=await browser.newContext({baseURL:info.project.use.baseURL,ignoreHTTPSErrors:true});
  try{
    const actor=await fixtureActor(context,store),stamp=()=>new Date().toISOString(),code=randomUUID().slice(0,7);
    if(!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`,['advisor-c2-b@example.test']))await createAdmin(store,'advisor-c2-b@example.test','advisor-c2-only-synthetic');
    const other=await peer.newPage();await loginAdvisorPeer(other);
    const list=async server=>{
      const response=await server.get('/api/admin/assistant/inbox?page=1');
      expect(response.ok()).toBe(true);
      return (await response.json()).items;
    };
    const history=alertId=>store.db.get(`SELECT id,state,version FROM ${store.t('alerts')} WHERE id=?`,[alertId]);
    const patches=[];
    page.on('request',req=>{
      if(req.method()==='PATCH'&&new URL(req.url()).pathname==='/api/admin/assistant/inbox')patches.push(req.postDataJSON());
    });
    async function reach(via,id,q){
      if(via==='panel')return;
      let entry=await openAli(page);
      if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="advisor.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
    }
    for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
      const {product,alert}=await seedAdvisorAlert(store,{title:`Aviso propio ${code} ${via}`,actorId:actor,now:stamp()});
      try{
        const before=await history(alert.id);
        const own=()=>list(context.request).then(items=>items.find(card=>card.source.id===alert.id));
        const otherOwn=()=>list(peer.request).then(items=>items.find(card=>card.source.id===alert.id));
        await page.goto('/admin');
        const source=await own();
        expect(source?.action?.view).toMatchObject({section:'products',record:product.id});
        const card=page.locator(`[data-advisor-key="${source.key}"]`);
        const button=card.getByRole('button',{name:source.action.label,exact:true});
        await expect(button).toBeVisible();
        await reach(via,'open-notice-source','ir a la fuente del aviso personal');
        if(via!=='panel')await expect(page.locator('[data-advisor-control="advisor-inbox-source-control"]')).toBeFocused();
        expect(patches).toHaveLength(index*2);
        await button.click();
        const editor=page.getByRole('dialog',{name:'Editar producto',exact:true});
        await expect(editor.locator('[name="title"]')).toHaveValue(product.title);
        expect(await history(alert.id)).toEqual(before);
        expect((await own()).fingerprint).toBe(source.fingerprint);
        expect((await own()).read).toBe(false);
        await page.goto('/admin');
        await card.locator('summary').filter({hasText:'Acciones personales'}).click();
        await card.getByRole('button',{name:'Posponer',exact:true}).click();
        const schedule=page.getByRole('dialog',{name:'Posponer aviso',exact:true});
        await fillBogota(schedule,new Date(Date.now()+86400000));
        await schedule.getByRole('button',{name:'Posponer aviso',exact:true}).click();
        await expect.poll(own).toBeUndefined();
        const deferred=page.getByRole('list',{name:'Avisos pospuestos en esta visita',exact:true}).getByRole('button',{name:'Deshacer aplazamiento',exact:true});
        if(via==='panel')await page.getByText('Avisos que pospusiste (1)',{exact:true}).click();
        await reach(via,'notice-unsnooze','quitar aplazamiento');
        if(via!=='panel')await expect(deferred).toBeFocused();
        expect(patches).toHaveLength(index*2+1);
        expect(await own()).toBeUndefined();
        expect((await otherOwn()).read).toBe(false);
        await deferred.click();
        await expect(card).toBeVisible();
        expect(await own()).toMatchObject({key:source.key,fingerprint:source.fingerprint,read:false});
        expect(patches.slice(-2).map(({key,action})=>({key,action}))).toEqual([{key:source.key,action:'snooze'},{key:source.key,action:'unsnooze'}]);
        expect(await history(alert.id)).toEqual(before);
        expect(await store.get('products',product.id)).toEqual(product);
        expect((await otherOwn()).fingerprint).toBe(source.fingerprint);
      }finally{await stockEpisode(store,product,actor,stamp(),1000);}
    });
  }finally{try{await peer.close();}finally{await store.close();}}
});

test('Ali @advisor-c6: conserva la decisión sobre publicación, fotos y eliminación de fichas privadas',async({page,request,context},info)=>{
  test.setTimeout(150000);
  page.setDefaultTimeout(12000);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await loginWithAdvisorFixture(page,request);
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),code=randomUUID().slice(0,7),globalSettings=await store.settings();
    const sharp=(await import('sharp')).default;
    const image=await sharp({create:{width:80,height:40,channels:3,background:{r:72,g:130,b:169}}}).png().toBuffer();
    const seed=(kind,key,extra={})=>store.save(kind,{...emptyRecord(kind),title:`${key} ${code}`,slug:`c6-${randomUUID()}`,status:'draft',...extra},null,null,actor);
    const component=await seed('products','Componente vigente',{price:23000,presentation:'Unidad',stockQuantity:12,orderable:true});
    const open=async(kind,row)=>{
      await page.goto(`/admin?section=${kind}&q=${code}`);
      await page.getByRole('button',{name:`Editar ${row.title}`,exact:true}).click();
      const editor=page.locator('dialog.editor-drawer');
      await expect(editor.locator('[name="title"]')).toHaveValue(row.title);
      return editor;
    };
    const mutations=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(!['GET','HEAD'].includes(req.method())&&/^\/api\/admin\/(products|combos|catalogs|upload)(\/|$)/.test(path))mutations.push(`${req.method()} ${path}`);
    });
    async function reach(via,editor,id,q,control){
      if(via==='panel')return;
      await editor.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
      let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      if(via==='chat')await askAli(entry,`¿Dónde encuentro ${q}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="products.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(control).toBeFocused();
    }
    const response=(method,path)=>page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path);
    async function deleteRecord(via,{kind,id,q,label,row,expected=200}){
      const editor=await open(kind,row),control=editor.getByRole('button',{name:label,exact:true}),path=`/api/admin/${kind}/${row.id}`;
      const before=mutations.length;
      if(via==='panel')await editor.locator('summary').filter({hasText:/^(Más opciones|Eliminar contenido)$/}).click();
      await reach(via,editor,id,q,control);
      expect(mutations).toHaveLength(before);
      const verifyDialog=async accept=>{
        const clicked=page.waitForEvent('dialog');
        const action=via==='panel'?control.click():page.keyboard.press('Enter');
        const dialog=await clicked;
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('Esta acción es irreversible');
        await (accept?dialog.accept():dialog.dismiss());
        await action;
      };
      await verifyDialog(false);
      await expect(control).toBeVisible();
      expect(await store.get(kind,row.id)).toEqual(row);
      expect(mutations).toHaveLength(before);
      const pending=response('DELETE',path);
      await verifyDialog(true);
      const result=await pending;
      expect(result.status(),await result.text()).toBe(expected);
      expect(result.request().postDataJSON()).toEqual({version:row.version});
      expect(mutations.slice(before)).toEqual([`DELETE ${path}`]);
      if(expected===200){
        await expect(editor).toHaveCount(0);
        expect(await store.get(kind,row.id)).toBeNull();
        await expect(page.getByRole('button',{name:`Editar ${row.title}`,exact:true})).toHaveCount(0);
      }else{
        await expect(editor.getByRole('alert')).toContainText('tiene existencias o reservas');
        expect(await store.get(kind,row.id)).toEqual(row);
        await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
      }
    }
    for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
      const kind=['products','combos','catalogs'][index];
      const publication=await seed(kind,`Estado editorial ${via}`,index===1?{price:42000,items:[{productId:component.id,quantity:1}],orderable:false}:index===0?{price:17000,presentation:'Unidad'}:{});
      await test.step('products.set-publication',async()=>{
        const editor=await open(kind,publication),select=editor.getByRole('combobox',{name:'Publicación',exact:true});
        const before=mutations.length;
        await reach(via,editor,'set-publication','decidir si se publica, archiva o deja en borrador una ficha',select);
        await expect(select).toHaveValue('draft');
        await select.selectOption('archived');
        await expect(editor).toContainText('El contenido archivado se conserva y permanece oculto.');
        expect((await store.get(kind,publication.id)).status).toBe('draft');
        expect(mutations).toHaveLength(before);
        const path=`/api/admin/${kind}/${publication.id}`,pending=response('PUT',path);
        await editor.getByRole('button',{name:'Guardar cambios',exact:true}).click();
        const committed=await pending;
        expect(committed.ok(),await committed.text()).toBe(true);
        expect(await store.get(kind,publication.id)).toMatchObject({id:publication.id,version:publication.version+1,status:'archived'});
        expect(mutations.slice(before)).toEqual([`PUT ${path}`]);
      });
      const photo=await seed('products',`Foto provisional ${via}`,{price:25000,presentation:'Unidad'});
      await test.step('products.upload-image',async()=>{
        const editor=await open('products',photo),file=editor.getByLabel('Archivo de imagen del producto',{exact:true}),before=mutations.length;
        await reach(via,editor,'upload-image','elegir imagen de producto',file);
        expect(mutations).toHaveLength(before);
        await expect(editor.getByText('Imagen subida',{exact:true})).toHaveCount(0);
        const chooser=page.waitForEvent('filechooser');
        await file.click();
        const selected=await chooser,pending=response('POST','/api/admin/upload');
        await selected.setFiles({name:`foto-${code}.png`,mimeType:'image/png',buffer:image});
        const uploaded=await pending;
        expect(uploaded.status(),await uploaded.text()).toBe(201);
        const {url}=await uploaded.json();
        const preview=editor.getByRole('img',{name:'Vista previa de la fotografía del producto',exact:true});
        await expect(preview).toHaveAttribute('src',url);
        await expect.poll(()=>preview.evaluate(node=>node.naturalWidth)).toBe(80);
        expect((await context.request.get(url)).headers()['content-type']).toBe('image/webp');
        expect(await store.get('products',photo.id)).toEqual(photo);
        expect(mutations.slice(before)).toEqual(['POST /api/admin/upload']);
        if(via==='directorio')await screenshot(page,info,'advisor-c6-foto-provisional');
        const discarded=response('DELETE','/api/admin/upload');
        page.once('dialog',dialog=>dialog.accept());
        await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
        expect((await (await discarded).json()).deleted).toBe(true);
        expect((await context.request.get(url)).status()).toBe(404);
        expect(await store.get('products',photo.id)).toEqual(photo);
        expect(mutations.slice(before)).toEqual(['POST /api/admin/upload','DELETE /api/admin/upload']);
      });
      const deletions=[
        // Uncounted inventory is not counted zero: zero creates a durable stock alert.
        {kind:'products',id:'delete-product',q:'borrar producto',label:'Eliminar producto',row:await seed('products',`Producto sin referencias ${via}`,{price:13000,presentation:'Unidad',stockQuantity:null})},
        {kind:'combos',id:'delete-combo',q:'borrar oferta',label:'Eliminar combo',row:await seed('combos',`Combo sin pedidos ${via}`,{price:38000,items:[{productId:component.id,quantity:1}],orderable:false})},
        {kind:'catalogs',id:'delete-catalog',q:'borrar catálogo',label:'Eliminar catálogo',row:await seed('catalogs',`Colección sin referencias ${via}`)},
      ];
      for(const deletion of deletions)await test.step(`products.${deletion.id}`,()=>deleteRecord(via,deletion));
      if(via==='directorio')await test.step('el inventario bloquea la eliminación aun después de confirmar',()=>deleteRecord(via,{...deletions[0],row:component,expected:409}));
      expect(await store.get('products',component.id)).toEqual(component);
      expect(await store.settings()).toEqual(globalSettings);
    });
  }finally{
    await store.close();
  }
});

test('Ali @advisor-c6: recorre la guía, adopta una caja guardada, termina y consulta un diagnóstico ficticio aislado', async ({page,request,context},info)=>{
  test.setTimeout(180000);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await loginWithAdvisorFixture(page,request);
  const store=await openStore(testDatabaseEnv());
  const settingsRow=tx=>tx.db.get(`SELECT data,version FROM ${tx.t('business_settings')} WHERE id=1`);
  const fixtureKeys=['defaultReceiptAccountId','defaultPaymentAccountId','alertDefaults','setupPolicyConfirmed','setupCompleted'];
  // Only the disposable fixture changes these five fields. Keep unrelated data and never rewind the version.
  const fixturePreferences=patch=>store.transaction(async tx=>{
    await tx.lockWrites();
    const row=await settingsRow(tx), data=JSON.parse(row.data);
    for(const name of fixtureKeys){
      if(Object.hasOwn(patch,name))data[name]=patch[name];
      else delete data[name];
    }
    const next=JSON.stringify(data);
    if(next===row.data)return;
    const {changes}=await tx.db.run(`UPDATE ${tx.t('business_settings')} SET data=?,version=version+1,updated_at=? WHERE id=1 AND version=?`,[next,new Date().toISOString(),row.version]);
    expect(changes).toBe(1);
  });
  let original;
  try{
    const actor=await fixtureActor(context,store), code=randomUUID().slice(0,7);
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable sintético guía ${code}`},actor);
    const account=await saveAccount(store,{requestId:randomUUID(),name:`Caja sintética guía ${code}`,type:'cash',openingOn:bogotaDate(),openingBalanceMinor:1234500,responsibleId:person.id},actor);
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto sintético guía ${code}`,slug:`c6-producto-guia-${code}`,status:'draft',productType:'product',orderable:true,price:24700,stockQuantity:8},null,null,actor);
    original=JSON.parse((await settingsRow(store)).data);
    const endpoint='/api/admin/business/onboarding', location='/admin?section=business&tab=setup', origin=new URL(page.url()).origin;
    const writes=[], external=[];
    page.on('request',req=>{
      const url=new URL(req.url());
      if(/^https?:$/.test(url.protocol)&&url.origin!==origin)external.push(req.url());
      if(!['GET','HEAD'].includes(req.method())&&url.pathname.startsWith('/api/admin/')&&!/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(url.pathname))writes.push([req.method(),url.pathname]);
    });
    const operational=()=>store.readSnapshot(async tx=>Object.fromEntries(await Promise.all([
      'orders','order_audit','order_events','idempotency','records','counters','settings','cash_accounts','cash_entries','order_collections','shipments','shipment_events','expenses','report_snapshots','social_operations',
    ].map(async table=>[table,await tx.db.get(`SELECT COUNT(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,',' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${tx.t(table)} r`)]))));
    const command=(action,id)=>store.db.get(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`,[`onboarding:${action}`,id]);
    const receipts=()=>store.db.all(`SELECT request_id,result_json FROM ${store.t('business_requests')} WHERE actor_id=? AND scope='onboarding:trial' ORDER BY request_id`,[actor]);
    const baseOperation=await operational();
    const unchanged=async()=>{
      expect(await operational()).toEqual(baseOperation);
      expect(external).toEqual([]);
    };
    const guide=page.locator('[data-onboarding]');
    const step=index=>guide.locator(`[data-onboarding-step="${index}"]`);
    const assertStage=async index=>{
      await expect(step(index)).toHaveAttribute('aria-current','step');
      await expect(guide.locator(`[data-onboarding-stage="${index}"]`)).toBeVisible();
    };
    const accountPicker=guide.getByRole('combobox',{name:'Cuenta que quieres usar',exact:true});
    const receipt=guide.locator('[data-onboarding-trial-receipt]');
    const actions={
      stage:{id:'setup-stage',query:'ir a un paso de la guía',marker:'onboarding-stage-picker',target:guide.locator('[aria-current=step][data-onboarding-step]')},
      cash:{id:'setup-use-cash',query:'adoptar caja guardada',marker:'onboarding-cash-existing-opening',target:accountPicker},
      trial:{id:'setup-trial',query:'probar pedido sin cobro',marker:'onboarding-run-trial',target:guide.locator('[data-onboarding-trial]')},
      receipt:{id:'setup-trial-receipt',query:'recibo de prueba',marker:'onboarding-trial-receipt',target:receipt.getByRole('heading',{name:/Último diagnóstico guardado/})},
      complete:{id:'setup-complete',query:'finalizar guía',marker:'onboarding-finish',target:guide.locator('[data-onboarding-complete]')},
    };
    async function handoff(via,action){
      let entry=await openAli(page);
      if(via==='chat')await askAli(entry,`¿Dónde encuentro ${action.query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(action.query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="business.${action.id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:10000});
      return entry;
    }
    async function reach(via,action,nativeOpen){
      const before=writes.length, settingsBefore=await settingsRow(store), receiptBefore=await receipts();
      if(via==='panel')await nativeOpen?.();
      else{
        const entry=await handoff(via,action);
        await expect(action.target).toBeFocused();
        await expect(entry).toBeHidden();
      }
      await expect(action.target).toBeVisible();
      await expect(action.target).toHaveAttribute('data-advisor-control',action.marker);
      expect(await action.target.evaluate(node=>{
        const {left,right}=node.getBoundingClientRect();return left>=-1&&right<=innerWidth+1;
      })).toBe(true);
      expect(writes).toHaveLength(before);
      expect(await settingsRow(store)).toEqual(settingsBefore);
      expect(await receipts()).toEqual(receiptBefore);
    }
    async function commit(action,perform,fields){
      const before=writes.length;
      const [response]=await Promise.all([
        page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint),
        perform(),
      ]);
      expect(response.status(),await response.text()).toBe(200);
      const payload=response.request().postDataJSON();
      expect(payload).toEqual({action,requestId:expect.any(String),...fields});
      const row=await command(action,payload.requestId);
      expect(row?.actor_id).toBe(actor);
      expect(writes.slice(before)).toEqual([['POST',endpoint]]);
      return {response:await response.json(),result:JSON.parse(row.result_json)};
    }
    async function confirmTrial(accept){
      const [message]=await Promise.all([
        page.waitForEvent('dialog').then(async dialog=>{
          expect(dialog.type()).toBe('confirm');
          const text=dialog.message();
          await (accept?dialog.accept():dialog.dismiss());
          return text;
        }),
        actions.trial.target.click(),
      ]);
      expect(message).toContain('Solo se guardará un recibo de prueba. No se creará un pedido real, ni se moverá inventario, ni se hará un cobro ni se usará un servicio externo.');
    }

    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await fixturePreferences({defaultReceiptAccountId:null,defaultPaymentAccountId:null,alertDefaults:{...original.alertDefaults,responsibleId:null},setupPolicyConfirmed:true,setupCompleted:false});
      await page.goto(location);
      await assertStage(0);
      for(const index of [1,2,3])await expect(step(index)).toBeDisabled();
      const pastReceipts=await receipts();
      if(via==='chat'){
        const before=writes.length, preferences=await settingsRow(store);
        await handoff(via,actions.trial);
        await expect(page.getByRole('main').getByRole('alert')).toContainText('no encontré un control disponible',{timeout:12000});
        await assertStage(0);
        expect(await settingsRow(store)).toEqual(preferences);
        expect(await receipts()).toEqual(pastReceipts);
        expect(writes).toHaveLength(before);
      }

      await reach(via,actions.cash,()=>guide.locator('summary').filter({hasText:'Cambiar los datos propuestos'}).click());
      await accountPicker.selectOption(account.id);
      await expect(guide.getByText(`Responsable: ${person.name}`,{exact:true})).toBeVisible();
      const approval=guide.getByRole('checkbox',{name:'Confirmo que usaré esta cuenta con su apertura guardada.',exact:true});
      const saveCash=guide.getByRole('button',{name:'Guardar caja y continuar',exact:true});
      const preferences=await settingsRow(store), beforeCash=writes.length;
      await expect(approval).not.toBeChecked();
      await saveCash.click();
      expect(writes).toHaveLength(beforeCash);
      expect(await settingsRow(store)).toEqual(preferences);
      await approval.check();
      const prepared=await commit('prepare',()=>saveCash.click(),{accountId:account.id,responsibleId:person.id,openingConfirmed:true});
      expect(prepared.result).toEqual({accountId:account.id,responsibleId:person.id});
      expect(prepared.response.readiness).toEqual({cash:true,product:true,orders:true,completed:false});
      expect(await getBusinessSettings(store)).toMatchObject({defaultReceiptAccountId:account.id,defaultPaymentAccountId:account.id,alertDefaults:{responsibleId:person.id},setupCompleted:false});
      await unchanged();
      await assertStage(3);

      const beforeStage=writes.length, savedStage=await settingsRow(store);
      await reach(via,actions.stage);
      await step(1).click();
      await assertStage(1);
      await expect(guide.getByRole('heading',{name:'2. Producto',exact:true})).toBeFocused();
      expect(await settingsRow(store)).toEqual(savedStage);
      expect(writes).toHaveLength(beforeStage);

      await reach(via,actions.complete,()=>step(3).click());
      await assertStage(3);
      const completed=await commit('complete',()=>actions.complete.target.click(),{});
      expect(completed.result).toEqual({ok:true});
      expect(completed.response.readiness.completed).toBe(true);
      expect((await getBusinessSettings(store)).setupCompleted).toBe(true);
      expect(await receipts()).toEqual(pastReceipts);
      await expect(guide.locator('[data-onboarding-new-order]')).toBeVisible();
      await unchanged();

      await step(2).click();
      await assertStage(2);
      await reach(via,actions.trial,()=>step(3).click());
      await assertStage(3);
      await guide.getByRole('combobox',{name:'Producto para el diagnóstico',exact:true}).selectOption(product.id);
      const beforeTrial=writes.length, trialSettings=await settingsRow(store);
      await confirmTrial(false);
      expect(writes).toHaveLength(beforeTrial);
      expect(await receipts()).toEqual(pastReceipts);
      const {response,result:trial}=await commit('trial',()=>confirmTrial(true),{productId:product.id});
      expect(response.trialOrder).toEqual(trial);
      expect(trial).toMatchObject({id:expect.stringMatching(/^trial:/),isTest:true,status:'received',deliveryMethod:'pickup',productId:product.id,totalMinor:product.price*100,items:[{itemId:product.id,title:product.title,quantity:1}]});
      expect(trial).not.toHaveProperty('number');
      expect(await store.order(trial.id)).toBeNull();
      expect(await receipts()).toHaveLength(pastReceipts.length+1);
      expect(await settingsRow(store)).toEqual(trialSettings);
      await unchanged();

      await page.reload();
      await assertStage(3);
      await step(1).click();
      await assertStage(1);
      await reach(via,actions.receipt,()=>step(3).click());
      await assertStage(3);
      await expect(receipt).toContainText(trial.id);
      await expect(receipt).toContainText(product.title);
      await expect(receipt).toContainText(formatC6ReportMoney(trial.totalMinor));
      await expect(receipt).toContainText('No cobrado.');
      if(via==='panel')await actions.receipt.target.scrollIntoViewIfNeeded();
      await screenshot(page,info,`advisor-c6-guia-${via}`);
      expect(await settingsRow(store)).toEqual(trialSettings);
      await unchanged();
    });
    expect(writes).toEqual(Array.from({length:9},()=>['POST',endpoint]));
  }finally{
    try{
      if(original)await fixturePreferences(original);
    }finally{
      await store.close();
    }
  }
});

test('Ali @advisor-c6: biblioteca privada, selección local, recibo y archivo con confirmación', async ({page, request, context}, info) => {
  // Each of the three paths processes two fixture files and one upload through the scheduler.
  test.setTimeout(720000);
  page.setDefaultTimeout(12000);
  if (info.project.name === 'mobile') await page.setViewportSize({width:320,height:740});
  await loginWithAdvisorFixture(page, request);
  const {execFileSync} = await import('node:child_process');
  const sharp = (await import('sharp')).default;
  const origin = new URL(page.url()).origin;
  expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
  const store = await openStore(testDatabaseEnv());
  const assets = '/api/admin/social/assets', library = '/admin?section=advertising&tab=assets';
  const url = (q, status) => `${library}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`;
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const mutations=[], imageReads=[];
  let chooserCount=0;
  page.on('filechooser', () => { chooserCount++; });
  page.on('request', req => {
    const {pathname, search} = new URL(req.url());
    if (pathname.startsWith('/api/admin/social/') && !['GET','HEAD'].includes(req.method())) mutations.push(`${req.method()} ${pathname}`);
    if (req.method()==='GET' && pathname.startsWith(`${assets}/`) && pathname.endsWith('/content')) imageReads.push(`${pathname}${search}`);
  });
  try {
    expect((await store.db.get('SELECT current_database() AS name')).name).toBe('allnutrition_test');
    const actor=await fixtureActor(context,store), marker=randomUUID().slice(0,8);
    const freshRead=page.waitForRequest(req => new URL(req.url()).pathname===assets && Boolean(req.headers()['x-csrf-token']));
    await page.goto(library);
    const csrf=await (await freshRead).headerValue('x-csrf-token');
    const headers={Origin:origin,'x-csrf-token':csrf};
    const makePng=(width,height,background)=>sharp({create:{width,height,channels:3,background}}).png().toBuffer();
    const good=await makePng(400,500,'#336688'), small=await makePng(80,40,'#884433'), local=await makePng(480,600,'#449966');
    const status=async(res,code)=>{expect(res.status(),await res.text()).toBe(code);return res.json();};
    const read=id=>store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`,[id]);
    const allRows=()=>store.db.all(`SELECT * FROM ${store.t('social_assets')} ORDER BY id`);
    const quota=async()=> (await status(await page.request.get(`${assets}?limit=1`),200)).quota;
    const unrelated=()=>Promise.all(['social_campaigns','social_deliveries','social_operations','social_connections','social_generation_jobs','social_creative_threads'].map(table=>store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`)));
    const untouched=await unrelated();
    const expectNoChanges=async(snapshot,expectedQuota,start)=>{
      expect(mutations.slice(start)).toEqual([]);
      expect(await allRows()).toEqual(snapshot);
      expect(await quota()).toEqual(expectedQuota);
      expect(await unrelated()).toEqual(untouched);
    };
    const waitResponse=(method,path)=>page.waitForResponse(res=>res.request().method()===method && new URL(res.url()).pathname===path);
    const content=(id,variant)=>`${assets}/${id}/content?variant=${variant}`;
    const readContent=async(id,variant)=>{
      const res=await page.request.get(content(id,variant));
      expect(res.status()).toBe(200);
      return res.body();
    };
    async function processAsset(id,state) {
      const container=process.env.ALI_FIXTURE_ASSET_CONTAINER;
      if(container){
        expect(container).toMatch(/^advisor-c1-[a-f0-9]+-web$/);
        // The disposable browser harness can run a turn inside the same private media volume.
        execFileSync('docker',['exec',container,'node','tests/e2e/guided-image-worker.mjs','asset',id,origin],{timeout:20000,encoding:'utf8'});
      }
      await expect.poll(async()=>(await read(id))?.state,{timeout:70000}).toBe(state);
    }
    async function seed(name,image,state){
      const reserved=await status(await page.request.post(assets,{headers,data:{name,contentType:'image/png',expectedBytes:image.length,requestId:randomUUID()}}),201);
      await status(await page.request.put(`${assets}/${reserved.id}/content`,{headers:{...headers,'content-type':'image/png','x-asset-version':String(reserved.version),'x-request-id':randomUUID()},data:image}),202);
      await processAsset(reserved.id,state);
      const row=await read(reserved.id);
      expect(row.state).toBe(state);
      return {...JSON.parse(row.data),id:row.id,version:row.version,name};
    }
    const gallery=page.getByRole('region',{name:'Imágenes y videos guardados',exact:true});
    const search=page.getByRole('textbox',{name:'Buscar imagen o video',exact:true});
    const filter=page.getByRole('combobox',{name:'Estado del archivo',exact:true});
    const detail=page.getByRole('region',{name:'Ficha del archivo',exact:true});
    const uploadEntry=page.getByRole('button',{name:'Subir archivo privado',exact:true});
    const dialog=page.getByRole('dialog',{name:'Subir archivo privado',exact:true});
    const picker=dialog.getByRole('button',{name:'Seleccionar archivo',exact:true});
    const submit=dialog.getByRole('button',{name:'Subir archivo',exact:true});
    const name=dialog.getByRole('textbox',{name:'Nombre para encontrarlo después',exact:true});
    const back=detail.getByRole('button',{name:'Volver a la biblioteca',exact:true});
    const archive=detail.getByRole('button',{name:'Archivar archivo',exact:true});
    const heading=title=>detail.getByRole('heading',{name:title,exact:true});
    const card=title=>gallery.getByRole('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
    const showDetails=()=>detail.locator('summary').filter({hasText:/^Detalles técnicos del archivo$/}).click();
    const listPath=()=>expect(page).toHaveURL(target=>target.searchParams.get('tab')==='assets'&&!target.searchParams.has('record'));
    const recordPath=id=>expect(page).toHaveURL(target=>target.searchParams.get('tab')==='assets'&&target.searchParams.get('record')===id);
    async function reach(via,id,q,target,{inside=false}={}){
      if(via==='panel')return;
      let overlay;
      if(inside){
        await dialog.getByRole('button',{name:'Ayúdame con el nombre',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      }else overlay=await openAli(page);
      const selector=`[data-capability-id="advertising.${id}"]`;
      if(via==='chat'){
        const previous=await overlay.locator(selector).count();
        await askAli(overlay,`¿Dónde encuentro ${q}?`);
        await expect(overlay.locator(selector)).toHaveCount(previous+1);
      }else{
        await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      const cards=overlay.locator(selector);
      const card=via==='chat'?cards.last():cards;
      await expect(card).toBeVisible();
      await card.getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(overlay).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    async function choose(filename, image){
      const before=chooserCount;
      const opened=page.waitForEvent('filechooser');
      await picker.click();
      await (await opened).setFiles({name:filename,mimeType:'image/png',buffer:image});
      expect(chooserCount).toBe(before+1);
      await expect(name).toHaveValue(filename);
      await expect(dialog.getByRole('status').filter({hasText:filename})).toContainText('MiB');
      await expect(submit).toBeEnabled();
    }
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const key=`c6-biblioteca-${marker}-${via}`, ready=await seed(`${key} lista`,good,'ready'), failed=await seed(`${key} sin derivado`,small,'failed');
      const baseline=await allRows(), originalQuota=await quota(), start=mutations.length;
      await test.step('advertising.read-asset',async()=>{
        // This is a business library shared by authenticated admins, not a per-operator creative thread.
        expect((await request.get(`${assets}?limit=1`)).status()).toBe(401);
        expect((await request.get(content(ready.id,'derivative'))).status()).toBe(401);
        await page.goto(url(key));
        await expect(search).toHaveValue(key);
        await filter.selectOption('ready');
        await expect(card(ready.name)).toBeVisible();
        await expect(card(failed.name)).toHaveCount(0);
        await reach(via,'read-asset','ver archivo de la biblioteca',search);
        await listPath();
        await expect(search).toHaveValue(key);
        await expect(filter).toHaveValue('ready');
        await expect(gallery.getByRole('article')).toHaveCount(1);
        await card(ready.name).getByRole('button',{name:'Ver archivo',exact:true}).click();
        await reach(via,'read-asset','ver archivo de la biblioteca',heading(ready.name));
        await recordPath(ready.id);
        await expect(detail.getByText('Lista para revisar',{exact:true})).toBeVisible();
        const preview=detail.getByRole('img',{name:`Derivado normalizado de ${ready.name}`,exact:true});
        await expect(preview).toHaveAttribute('src',content(ready.id,'derivative'));
        await expect.poll(()=>preview.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
        await showDetails();
        await expect(detail.getByText(ready.originalSha256,{exact:true})).toBeVisible();
        await expect(detail.getByText(ready.derivativeSha256,{exact:true})).toBeVisible();
        expect(digest(await readContent(ready.id,'derivative'))).toBe(ready.derivativeSha256);
        expect(ready.derivativeSha256).not.toBe(ready.originalSha256);
        await back.click();
        await expect(filter).toHaveValue('ready');
        await expect(search).toHaveValue(key);
        await filter.selectOption('failed');
        await expect(card(ready.name)).toHaveCount(0);
        await card(failed.name).getByRole('button',{name:'Ver archivo',exact:true}).click();
        await reach(via,'read-asset','ver archivo de la biblioteca',heading(failed.name));
        await recordPath(failed.id);
        await expect(detail.getByText('Sin vista previa',{exact:true})).toBeVisible();
        await expect(detail.getByText(/ancho mínimo 320 px/)).toBeVisible();
        await expect(detail.getByRole('img')).toHaveCount(0);
        await showDetails();
        await expect(detail.getByText(failed.originalSha256,{exact:true})).toBeVisible();
        await expect(detail.getByText('Todavía no verificado',{exact:true})).toBeVisible();
        expect(await readContent(failed.id,'original')).toEqual(small);
        expect((await page.request.get(content(failed.id,'derivative'))).status()).toBe(409);
        expect(imageReads.filter(path=>path.startsWith(`${assets}/${failed.id}/`))).toEqual([]);
        await back.click();
        await expectNoChanges(baseline,originalQuota,start);
      });
      await test.step('advertising.choose-upload-file',async()=>{
        const chooseStart=chooserCount;
        await reach(via,'choose-upload-file','elegir archivo local',uploadEntry);
        await expect(dialog).toHaveCount(0);
        expect(chooserCount).toBe(chooseStart);
        await uploadEntry.click();
        await expect(submit).toBeDisabled();
        await reach(via,'choose-upload-file','elegir archivo local',picker,{inside:true});
        expect(chooserCount).toBe(chooseStart);
        await choose(`${key}-descartable.png`,good);
        await expectNoChanges(baseline,originalQuota,start);
        await dialog.getByRole('button',{name:'Descartar selección local',exact:true}).click();
        await expect(dialog.getByText('Ningún archivo seleccionado',{exact:true})).toBeVisible();
        await expect(name).toHaveValue('');
        await expect(submit).toBeDisabled();
        await expect(picker).toBeFocused();
        await dialog.getByRole('button',{name:'Cerrar carga',exact:true}).click();
        await page.reload();
        await expect(search).toHaveValue(key);
        await expectNoChanges(baseline,originalQuota,start);
      });
      let uploaded, readyRow;
      const uploadedName=`${key} recibo privado`, filename=`${key}-local.png`;
      await test.step('advertising.upload-private-asset',async()=>{
        await filter.selectOption('ready');
        await reach(via,'upload-private-asset','subir foto o video',uploadEntry);
        await expect(dialog).toHaveCount(0);
        await uploadEntry.click();
        await reach(via,'upload-private-asset','subir foto o video',picker,{inside:true});
        await choose(filename,local);
        await name.fill(uploadedName);
        await reach(via,'upload-private-asset','subir foto o video',submit,{inside:true});
        await expect(name).toHaveValue(uploadedName);
        await expect(dialog.getByRole('status').filter({hasText:filename})).toContainText('MiB');
        await expectNoChanges(baseline,originalQuota,start);
        const post=waitResponse('POST',assets);
        const put=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname.startsWith(`${assets}/`)&&new URL(res.url()).pathname.endsWith('/content'));
        await submit.click();
        const postResponse=await post, putResponse=await put;
        const reserved=await status(postResponse,201);
        uploaded=await status(putResponse,202);
        const reserveInput=postResponse.request().postDataJSON();
        expect(reserveInput).toEqual({name:uploadedName,contentType:'image/png',expectedBytes:local.length,requestId:expect.any(String)});
        expect(reserved).toMatchObject({state:'uploading',version:1,bytes:0});
        expect(reserved.originalSha256).toBeUndefined();
        expect(new URL(putResponse.url()).pathname).toBe(`${assets}/${reserved.id}/content`);
        expect(await putResponse.request().headerValue('x-asset-version')).toBe(String(reserved.version));
        const uploadId=await putResponse.request().headerValue('x-request-id');
        expect(uploadId).toBeTruthy();
        expect(uploadId).not.toBe(reserveInput.requestId);
        expect(uploaded).toMatchObject({id:reserved.id,version:reserved.version+2,state:'processing',name:uploadedName,originalBytes:local.length,originalSha256:digest(local)});
        await expect(dialog.getByText(/^Original recibido\. Preparando la imagen; todavía no está lista para usar\.$/)).toBeVisible();
        const receipt=await read(uploaded.id);
        expect(receipt).toMatchObject({version:uploaded.version,state:'processing',bytes:local.length});
        const stored=JSON.parse(receipt.data);
        expect(stored).toMatchObject({originalBytes:local.length,originalSha256:digest(local)});
        expect(stored.derivativeSha256).toBeUndefined();
        expect(await readContent(uploaded.id,'original')).toEqual(local);
        const savedReceipt=await store.db.get(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`,[`social:asset:uploaded:${uploaded.id}`,uploadId]);
        expect(savedReceipt.actor_id).toBe(actor);
        expect(JSON.parse(savedReceipt.result_json)).toMatchObject({id:uploaded.id,version:uploaded.version,originalSha256:digest(local)});
        expect(mutations.slice(start)).toEqual([`POST ${assets}`,`PUT ${assets}/${uploaded.id}/content`]);
        expect(await unrelated()).toEqual(untouched);
        await processAsset(uploaded.id,'ready');
        readyRow=await read(uploaded.id);
        expect(readyRow).toMatchObject({state:'ready'});
        await expect(dialog.getByText(`${uploadedName} · Lista para revisar.`,{exact:true})).toBeVisible();
        await dialog.getByRole('button',{name:'Cerrar carga',exact:true}).click();
        await page.reload();
        await expect(card(uploadedName)).toBeVisible();
      });
      await test.step('advertising.archive-asset',async()=>{
        const before=mutations.length, beforeRows=await allRows(), oldQuota=await quota(), original=await readContent(uploaded.id,'original'), derivative=await readContent(uploaded.id,'derivative');
        await card(uploadedName).getByRole('button',{name:'Ver archivo',exact:true}).click();
        await reach(via,'archive-asset','archivar archivo privado',archive);
        await recordPath(uploaded.id);
        const confirmation=page.getByRole('dialog',{name:`¿Archivar «${uploadedName}»?`,exact:true});
        await expect(confirmation).toHaveCount(0);
        await expectNoChanges(beforeRows,oldQuota,before);
        await archive.click();
        const cancel=confirmation.getByRole('button',{name:'Cancelar',exact:true});
        await expect(cancel).toBeFocused();
        await expect(confirmation.getByText(/no se libera espacio y no se modifica contenido publicado/)).toBeVisible();
        await cancel.click();
        await expect(confirmation).toHaveCount(0);
        await expect(archive).toBeFocused();
        await expectNoChanges(beforeRows,oldQuota,before);
        await archive.click();
        const confirmed=waitResponse('POST',`${assets}/${uploaded.id}/actions`);
        await confirmation.getByRole('button',{name:'Sí, archivar archivo',exact:true}).click();
        const result=await confirmed, archived=await status(result,200);
        const input=result.request().postDataJSON();
        expect(input).toEqual({action:'archive',version:readyRow.version,requestId:expect.any(String)});
        expect(archived).toMatchObject({id:uploaded.id,state:'archived',version:readyRow.version+1,bytes:readyRow.bytes,originalBytes:original.length,derivativeBytes:derivative.length,originalSha256:digest(original),derivativeSha256:digest(derivative)});
        expect(mutations.slice(before)).toEqual([`POST ${assets}/${uploaded.id}/actions`]);
        await expect(confirmation).toHaveCount(0);
        await expect(detail.getByText('Archivada',{exact:true})).toBeVisible();
        await expect(page.getByRole('status').filter({hasText:'Archivo archivado.'})).toContainText('no se libera espacio');
        const archivedRow=await read(uploaded.id), readyFields=JSON.parse(readyRow.data);
        expect(archivedRow).toMatchObject({state:'archived',version:readyRow.version+1,bytes:readyRow.bytes,sha256:readyRow.sha256});
        expect(JSON.parse(archivedRow.data)).toEqual({...readyFields,archivedFrom:'ready'});
        const audit=await store.db.get(`SELECT actor_id,data FROM ${store.t('business_audit')} WHERE entity_type='social_asset' AND entity_id=? AND data::jsonb->>'reason' LIKE 'Pieza archivada%'`,[uploaded.id]);
        expect(audit.actor_id).toBe(actor);
        expect(JSON.parse(audit.data)).toMatchObject({previous:{id:uploaded.id,state:'ready',version:readyRow.version},next:{id:uploaded.id,state:'archived',version:archivedRow.version}});
        await page.reload();
        await recordPath(uploaded.id);
        await expect(detail.getByText('Archivada',{exact:true})).toBeVisible();
        await expect(detail.getByText('La historia se conserva. Ya no puedes seleccionar este archivo para nuevas publicaciones.',{exact:true})).toBeVisible();
        await expect(archive).toHaveCount(0);
        expect(await readContent(uploaded.id,'original')).toEqual(original);
        expect(await readContent(uploaded.id,'derivative')).toEqual(derivative);
        expect(await quota()).toEqual(oldQuota);
        const untouchedRows=ids=>ids.filter(row=>row.id!==uploaded.id);
        expect(untouchedRows(await allRows())).toEqual(untouchedRows(beforeRows));
        expect(await unrelated()).toEqual(untouched);
        await back.click();
        await expect(filter).toHaveValue('ready');
        await expect(card(uploadedName)).toHaveCount(0);
        await filter.selectOption('archived');
        await expect(card(uploadedName)).toBeVisible();
        await screenshot(page,info,`c6-biblioteca-${via}-archivada`);
      });
    });
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: reabre solo el arqueo elegido y conserva la revisión original',async({page,context,request},info)=>{
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store),day=bogotaDate(),code=randomUUID().slice(0,8);
    const command=data=>({requestId:randomUUID(),...data});
    const person=await saveResource(store,'people',command({name:`Responsable de reapertura ${code}`}),actorId);
    const path='/api/admin/business/actions/cash-reopen',posts=[];
    page.on('request',req=>{
      if(req.method()==='POST'&&new URL(req.url()).pathname===path)posts.push(req.postDataJSON());
    });
    const cash='/admin?section=cash&tab=overview';
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const account=await saveAccount(store,command({name:`Caja de reapertura ${code} ${via}`,type:'cash',openingOn:day,openingBalanceMinor:9300000,responsibleId:person.id}),actorId);
      const original=await closeCash(store,command({accountId:account.id,closingOn:day,countedMinor:9000000}),actorId);
      const href=`${cash}&account=${account.id}&record=${original.id}`;
      const read=()=>store.db.get(`SELECT * FROM ${store.t('cash_closings')} WHERE id=?`,[original.id]);
      const entries=()=>store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]);
      const before=await read(),beforeEntries=await entries(),beforePosts=posts.length;
      await page.goto(href);
      const detail=page.getByRole('heading',{name:`Cierre del ${day}`,exact:true}).locator('../..');
      const reopen=detail.getByRole('button',{name:'Reabrir cierre con motivo',exact:true});
      const form=page.getByRole('dialog',{name:'Reabrir cierre',exact:true});
      const reason=form.getByRole('textbox',{name:'Motivo'});
      const submit=form.getByRole('button',{name:'Reabrir cierre',exact:true});
      await expect(detail).toContainText('Revisión 1 · Cerrado');
      if(via!=='panel'){
        let overlay=await openAli(page);
        if(via==='chat')await askAli(overlay,'¿Dónde está corregir un día cerrado?');
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill('reabrir arqueo');
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator('[data-capability-id="cash.reopen-closing"]').getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(reopen).toBeFocused();
        await expect(reopen).toBeInViewport();
      }
      await expect(page).toHaveURL(url=>url.searchParams.get('account')===account.id&&url.searchParams.get('record')===original.id);
      await expect(form).toHaveCount(0);
      await reopen.click();
      await expect(reason).toHaveValue('');
      await submit.click();
      await expect(reason).toBeFocused();
      expect(await reason.evaluate(input=>input.validity.valueMissing)).toBe(true);
      await form.getByRole('button',{name:'Cancelar',exact:true}).click();
      await expect(reopen).toBeFocused();
      expect(posts).toHaveLength(beforePosts);
      expect(await read()).toEqual(before);
      await reopen.click();
      const note=`Verificar asiento omitido ${code} ${via}`;
      await reason.fill(note);
      const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===path);
      await submit.click();
      const saved=await response;
      expect(saved.ok(),await saved.text()).toBe(true);
      expect(await saved.json()).toMatchObject({id:original.id,revision:1,state:'reopened',reopenedBy:actorId,reopenReason:note,expectedMinor:9300000,countedMinor:9000000,differenceMinor:-300000});
      expect(posts.slice(beforePosts)).toEqual([expect.objectContaining({closingId:original.id,version:original.version,reason:note})]);
      await expect(page.getByText('Cierre reabierto con motivo; su historia se conserva.',{exact:true})).toBeVisible();
      await page.goto(href);
      await expect(detail).toContainText('Revisión 1 · Reabierto');
      await expect(reopen).toHaveCount(0);
      expect(await entries()).toEqual(beforeEntries);
      const next=await closeCash(store,command({accountId:account.id,closingOn:day,countedMinor:9300000}),actorId);
      expect(next).toMatchObject({revision:2,state:'closed',differenceMinor:0});
      expect(next.id).not.toBe(original.id);
      expect(await read()).toMatchObject({id:original.id,revision:1,state:'reopened',version:original.version+1});
      expect(await entries()).toEqual(beforeEntries);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-cierre-reabierto');
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: distingue un pago histórico por conciliar sin inferir depósito',async({page,context,request},info)=>{
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store), day=bogotaDate(), code=randomUUID().slice(0,8);
    const product=await store.save('products',{...emptyRecord('products'),title:`Referencia histórica ${code}`,slug:`historica-${code}`,status:'draft',price:25000,presentation:'Unidad',orderable:true,stockQuantity:10},null,null,actor);
    const ordinary=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Sin cobro ${code}`}),actor);
    const historical=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Pago antiguo ${code}`}),actor);
    const historicalId=randomUUID(), oldDate=`${completedFixtureYear()}-03-01T15:00:00.000Z`;
    await store.transaction(async tx=>{
      const row=await tx.db.get(`SELECT data FROM ${tx.t('orders')} WHERE id=?`,[historical.id]);
      const data={...JSON.parse(row.data),legacyFinancialReview:{required:true,state:'pending',reason:'legacy_payment_unreconciled',paymentStatus:'partial',paymentAmount:8000}};
      await tx.db.run(`UPDATE ${tx.t('orders')} SET data=? WHERE id=?`,[JSON.stringify(data),historical.id]);
      await insertRow(tx,'order_collections',{id:historicalId,order_id:historical.id,shipment_id:null,kind:'receipt',holder:'legacy',amount_minor:800000,occurred_on:null,cash_entry_id:null,reversal_of:null,external_key:`legacy:${historical.id}:payment`,recorded_at:oldDate,data:JSON.stringify({source:'legacy',requiresReconciliation:true})});
    });
    const payment=()=>store.db.get(`SELECT * FROM ${store.t('order_collections')} WHERE id=?`,[historicalId]);
    const snapshot=await payment();
    expect(snapshot).toMatchObject({holder:'legacy',occurred_on:null,cash_entry_id:null});
    expect(Number(snapshot.amount_minor)).toBe(800000);
    const href=`/admin?section=orders&tab=list&q=${code}`;
    const results=page.getByRole('region',{name:'Resultados de pedidos'});
    const orderRow=order=>results.getByText(`AN-${String(order.number).padStart(6,'0')}`,{exact:true}).filter({visible:true}).locator('xpath=ancestor::*[self::tr or self::li][1]');
    const filters=page.locator('details.order-advanced-filters > summary');
    const issue=page.getByRole('button',{name:'Pago histórico por conciliar',exact:true});
    const writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:orders|finance|business)(?:\/|$)/.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(href);
      await expect(orderRow(ordinary)).toContainText('Cobro: Pendiente');
      if(via==='panel'){
        if(await filters.locator('..').getAttribute('open')===null)await filters.click();
        await issue.click();
      }else{
        let overlay=await openAli(page);
        if(via==='chat')await askAli(overlay,'¿Dónde está cobros antiguos?');
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill('cobros antiguos');
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator('[data-capability-id="orders.filter-legacy-payment"]').getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        await expect(issue).toBeFocused();
        await expect(issue).toBeInViewport();
      }
      await expect(page).toHaveURL(url=>url.searchParams.get('q')===code&&url.searchParams.get('issue')==='legacy_review');
      await expect(issue).toHaveAttribute('aria-pressed','true');
      await expect(results).toHaveAttribute('aria-busy','false');
      await expect(orderRow(ordinary)).toHaveCount(0);
      await expect(orderRow(historical)).toContainText('Cobro: Pago histórico por conciliar');
      if(via==='directorio')await screenshot(page,info,'advisor-c6-pago-historico-por-conciliar');
    });
    expect(writes).toEqual([]);
    expect(await payment()).toEqual(snapshot);
    expect(await store.db.get(`SELECT id FROM ${store.t('cash_entries')} WHERE source_id=?`,[historicalId])).toBeFalsy();
  }finally{await store.close();}
});

test('Ali @advisor-c6: separa anticipo, propuesta, devengo, abono y pago de sueldo',async({page,context,request},info)=>{
  test.setTimeout(120000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear(),code=randomUUID().slice(0,7);
    const start=`${year}-09-01`,last=`${year}-09-30`,end=`${year}-10-01`;
    const href=`/admin?section=cash&tab=payroll&period=month&anchor=${start}`;
    const calls=[];
    const prefix='/api/admin/business/actions/';
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()==='POST'&&path.startsWith(prefix))calls.push(path.slice(prefix.length));
    });
    async function reach(via,id,query,target,{inside=false}={}){
      if(via==='panel')return;
      let overlay;
      if(inside){
        await page.getByRole('dialog',{name:'Preparar sueldo',exact:true}).getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      }else overlay=await openAli(page);
      if(via==='chat')await askAli(overlay,`¿Dónde está ${query}?`);
      else{
        await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await overlay.locator(`[data-capability-id="cash.${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
      await expect(overlay).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    async function submit(action,button){
      const reply=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===prefix+action);
      await button.click();
      const result=await reply;
      expect(result.ok(),await result.text()).toBe(true);
      return {saved:await result.json(),body:result.request().postDataJSON()};
    }
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const who=await saveResource(store,'people',{requestId:randomUUID(),name:`Sueldo ${code} ${via}`,salaryAgreements:[{id:`acuerdo-${code}-${via}`,enabled:true,frequency:'monthly',amountPerPeriodMinor:10000000,effectiveFrom:start,effectiveTo:last,payDayOffset:0}]},actor);
      const account=await saveAccount(store,{requestId:randomUUID(),name:`Caja sueldo ${code} ${via}`,type:'cash',responsibleId:who.id,openingOn:start,openingBalanceMinor:30000000},actor);
      const entries=()=>store.db.all(`SELECT id,kind,amount_minor,source_id FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]);
      const periods=()=>store.db.all(`SELECT id,version,state FROM ${store.t('payroll_periods')} WHERE person_id=?`,[who.id]);
      const salary=()=>store.db.all(`SELECT id,amount_minor FROM ${store.t('expenses')} WHERE person_id=? AND category='salary' ORDER BY id`,[who.id]);
      // Closed days may accrue independently while the browser is testing the proposal.
      await store.transaction(async tx=>{
        await tx.lockWrites();
        await materializePayrollAccrualsTx(tx,{throughOn:last,personId:who.id,actorId:actor});
      });
      await page.goto(href);
      const actions=page.locator('[aria-label="Acciones de caja"]');
      const advance=actions.getByRole('button',{name:'Registrar anticipo',exact:true});
      const prepare=actions.getByRole('button',{name:'Preparar período',exact:true});
      const startCalls=calls.length,opening=await entries(),initialSalary=await salary();
      expect(initialSalary).toHaveLength(30);
      expect(initialSalary.reduce((total,row)=>total+Number(row.amount_minor),0)).toBe(10000000);
      await reach(via,'record-advance','registrar adelanto a persona',advance);
      const advanceForm=page.getByRole('dialog',{name:'Registrar anticipo',exact:true});
      await expect(advanceForm).toHaveCount(0);
      expect(await entries()).toEqual(opening);
      await advance.click();
      await advanceForm.getByRole('combobox',{name:'Persona responsable'}).selectOption(who.id);
      await advanceForm.getByRole('combobox',{name:/^Cuenta(?: \*)?$/}).selectOption(account.id,{timeout:8000});
      await advanceForm.getByLabel('Concepto del anticipo').fill(`Adelanto comprobado ${code}`);
      await advanceForm.getByLabel('Importe (COP)').fill('20000');
      await advanceForm.locator('[name="effectiveOn"]').fill(last);
      expect(calls.slice(startCalls)).toEqual([]);
      const first=await submit('advance',advanceForm.getByRole('button',{name:'Registrar anticipo',exact:true}));
      expect(first.saved).toMatchObject({accountId:account.id,personId:who.id,kind:'advance',amountMinor:-2000000});
      expect(await recordAdvance(store,first.body,actor)).toEqual(first.saved);
      const withAdvance=await entries();
      expect(withAdvance).toHaveLength(opening.length+1);
      expect(await salary()).toEqual(initialSalary);
      await expect(advanceForm).toHaveCount(0);
      await page.goto(href);
      await reach(via,'prepare-payroll','proyectar pago de sueldo',prepare);
      const review=page.getByRole('dialog',{name:'Preparar sueldo',exact:true});
      await expect(review).toHaveCount(0);
      await prepare.click();
      await review.getByRole('combobox',{name:'Persona responsable'}).selectOption(who.id);
      await review.locator('[name="startOn"]').fill(start);
      await review.locator('[name="endOnExclusive"]').fill(end);
      const calculation=await submit('payroll-prepare',review.getByRole('button',{name:'Revisar período',exact:true}));
      expect(calculation.saved).toMatchObject({id:null,version:null,earnedMinor:10000000,advanceToApplyMinor:2000000,amountToPayMinor:8000000});
      const confirm=review.getByRole('button',{name:'Confirmar período revisado',exact:true});
      await expect(confirm).toBeVisible();
      await expect(review.getByText(/pagar es una acción separada/)).toBeVisible();
      expect(await periods()).toEqual([]);
      expect(await salary()).toEqual(initialSalary);
      expect(await entries()).toEqual(withAdvance);
      await reach(via,'confirm-payroll','confirmar devengo de sueldo',confirm,{inside:true});
      expect(calls.slice(startCalls)).toEqual(['advance','payroll-prepare']);
      await expect(review.getByRole('combobox',{name:'Persona responsable'})).toHaveValue(who.id);
      await expect(review.locator('[name="endOnExclusive"]')).toHaveValue(end);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-nomina-revision-sin-pago');
      const period=await submit('payroll-confirm',confirm);
      expect(period.saved).toMatchObject({personId:who.id,state:'partial',earnedMinor:10000000,advanceAppliedMinor:2000000,outstandingMinor:8000000,activePayments:[]});
      expect(await confirmPayroll(store,period.body,actor)).toEqual(period.saved);
      expect(await periods()).toHaveLength(1);
      expect(await entries()).toEqual(withAdvance);
      await expect(page.getByText('Sueldo confirmado como obligación; no registra un pago.',{exact:true})).toBeVisible();
      const recordHref=`${href}&seller=${who.id}&record=${period.saved.id}`;
      const openPay=page.locator('.cash-detail').getByRole('button',{name:'Pagar saldo o abono',exact:true});
      const payForm=page.getByRole('dialog',{name:'Pagar sueldo',exact:true});
      const payments=[];
      for(const part of [true,false]){
        await page.goto(recordHref);
        await reach(via,part?'part-pay-payroll':'pay-payroll',part?'abonar sueldo':'pagar sueldo completo',openPay);
        await expect(payForm).toHaveCount(0);
        const beforePay=await entries();
        await openPay.click();
        await payForm.getByRole('combobox',{name:/^Cuenta(?: \*)?$/}).selectOption(account.id,{timeout:8000});
        await payForm.locator('[name="effectiveOn"]').fill(last);
        if(part)await payForm.getByLabel('Pago nuevo (COP)').fill('30000');
        expect(await entries()).toEqual(beforePay);
        const payment=await submit('payroll-pay',payForm.getByRole('button',{name:'Pagar sueldo',exact:true}));
        expect(payment.saved).toMatchObject({id:period.saved.id,state:part?'partial':'paid',outstandingMinor:part?5000000:0,advanceAppliedMinor:2000000});
        payments.push(payment.saved);
        expect(await payPayroll(store,payment.body,actor)).toEqual(payment.saved);
        const current=await entries();
        expect(current).toHaveLength(beforePay.length+1);
        const entry=current.find(row=>row.id===payment.saved.cashEntryId);
        expect(entry).toMatchObject({kind:'payroll_payment',source_id:payment.saved.payrollPaymentId});
        expect(Number(entry.amount_minor)).toBe(part?-3000000:-5000000);
        await expect(page.getByText('Pago de sueldo registrado.',{exact:true})).toBeVisible();
      }
      const reverseForm=page.getByRole('dialog',{name:'Revertir documento',exact:true});
      async function reverse(button,documentId,type){
        const noWrites=calls.length;
        await expect(reverseForm).toHaveCount(0);
        await button.click();
        await expect(reverseForm.getByLabel('Motivo')).toHaveValue('');
        await reverseForm.locator('[name="effectiveOn"]').fill(last);
        await reverseForm.getByLabel('Motivo').fill('Revisión de comprobante duplicado');
        expect(calls).toHaveLength(noWrites);
        const result=await submit('document-reverse',reverseForm.getByRole('button',{name:'Revertir documento',exact:true}));
        expect(result.body).toMatchObject({documentId,documentType:type});
        expect(await reverseFinancialDocument(store,result.body,actor)).toEqual(result.saved);
        await expect(page.getByText('Documento revertido completo; se conserva la historia.',{exact:true})).toBeVisible();
        return result.saved;
      }
      const [firstPayment,secondPayment]=payments;
      const paymentButtons=page.getByRole('button',{name:'Revertir pago y aplicaciones',exact:true});
      await page.goto(recordHref);
      const paymentList=page.getByRole('region',{name:'Pagos de sueldo vigentes',exact:true});
      await reach(via,'reverse-payroll-payment','revertir desembolso de nómina',paymentList.getByRole('heading'));
      const firstRow=paymentList.getByRole('article').filter({hasText:/\$\s*30[.,]000/});
      const firstUndo=await reverse(firstRow.getByRole('button',{name:'Revertir pago y aplicaciones',exact:true}),firstPayment.payrollPaymentId,'payroll_payment');
      expect(firstUndo).toMatchObject({outstandingMinor:3000000,advanceAppliedMinor:2000000,activePayments:[expect.objectContaining({id:secondPayment.cashEntryId})]});
      await page.goto(recordHref);
      const lastUndo=await reverse(paymentButtons,secondPayment.payrollPaymentId,'payroll_payment');
      expect(lastUndo).toMatchObject({outstandingMinor:10000000,advanceAppliedMinor:0,activePayments:[]});
      const cashMove=`/admin?section=cash&tab=movements&period=month&anchor=${start}&account=${account.id}&record=${first.saved.id}`;
      await page.goto(cashMove);
      const undoAdvance=page.getByRole('button',{name:'Revertir documento vinculado',exact:true});
      await reach(via,'reverse-advance','revertir adelanto entregado',undoAdvance);
      const advanceUndo=await reverse(undoAdvance,first.saved.id,'advance');
      expect(advanceUndo).toMatchObject({reversalOf:first.saved.id,amountMinor:2000000});
      const ledger=await entries();
      expect(ledger.reduce((total,row)=>total+Number(row.amount_minor),0)).toBe(30000000);
      for(const [original,compensation,minor] of [[firstPayment.cashEntryId,firstUndo.reversalId,3000000],[secondPayment.cashEntryId,lastUndo.reversalId,5000000]]){
        const entry=await store.db.get(`SELECT reversal_of,amount_minor FROM ${store.t('cash_entries')} WHERE id=?`,[compensation]);
        expect(entry.reversal_of).toBe(original);
        expect(Number(entry.amount_minor)).toBe(minor);
      }
      const secondPerson=await saveResource(store,'people',{requestId:randomUUID(),name:`Aplicaciones ${code} ${via}`,salaryAgreements:[{id:`aplica-${code}-${via}`,enabled:true,frequency:'monthly',amountPerPeriodMinor:10000000,effectiveFrom:start,effectiveTo:last,payDayOffset:0}]},actor);
      await recordAdvance(store,{requestId:randomUUID(),personId:secondPerson.id,accountId:account.id,effectiveOn:last,amountMinor:1000000,concept:`Anticipo por desaplicar ${code}`},actor);
      const onlyApplications=await confirmPayroll(store,{requestId:randomUUID(),personId:secondPerson.id,startOn:start,endOnExclusive:end},actor);
      expect(onlyApplications).toMatchObject({advanceAppliedMinor:1000000,outstandingMinor:9000000,activePayments:[]});
      const beforeUndo=await entries();
      await page.goto(`${href}&seller=${secondPerson.id}&record=${onlyApplications.id}`);
      const undoApplications=page.getByRole('button',{name:'Revertir compensaciones y anticipos sin caja nueva',exact:true});
      await reach(via,'reverse-payroll-applications','revertir compensación sin caja nueva',undoApplications);
      const applicationsUndo=await reverse(undoApplications,onlyApplications.id,'payroll_payment');
      expect(applicationsUndo).toMatchObject({reversalId:null,advanceAppliedMinor:0,outstandingMinor:10000000,activePayments:[]});
      expect(await entries()).toEqual(beforeUndo);
      expect(calls.slice(startCalls)).toEqual(['advance','payroll-prepare','payroll-confirm','payroll-pay','payroll-pay','document-reverse','document-reverse','document-reverse','document-reverse']);
      const persisted=await salary();
      expect(persisted.reduce((total,row)=>total+Number(row.amount_minor),0)).toBe(10000000);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: revisa la diferencia de caja y conserva el conteo al reintentar',async({page,context,request},info)=>{
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store), day=bogotaDate(), prior=addC6ReportDays(day,-1), code=randomUUID().slice(0,7);
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable comparación ${code}`},actor);
    const account=await saveAccount(store,{requestId:randomUUID(),name:`Caja comparación ${code}`,type:'cash',openingOn:day,openingBalanceMinor:8600000,responsibleId:person.id},actor);
    const href=`/admin?section=cash&tab=overview&account=${account.id}&record=${account.id}`;
    const entries=()=>store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]);
    const closings=()=>store.db.all(`SELECT id FROM ${store.t('cash_closings')} WHERE account_id=?`,[account.id]);
    const baseline=await entries(), writes=[];
    page.on('request',req=>{
      if(!['GET','HEAD'].includes(req.method())&&/^\/api\/admin\/(?:business|finance)\//.test(new URL(req.url()).pathname))writes.push(req.url());
    });
    const compare=page.getByRole('button',{name:'Cerrar esta caja',exact:true});
    const drawer=page.getByRole('dialog',{name:'Cerrar caja',exact:true});
    const date=drawer.locator('[name="closingOn"]'), count=drawer.getByLabel('Dinero contado (COP)');
    const previewFor=value=>page.waitForResponse(res=>{
      const url=new URL(res.url());
      return res.request().method()==='GET'&&url.pathname==='/api/admin/finance/closings'&&url.searchParams.get('preview')==='1'&&url.searchParams.get('account')===account.id&&url.searchParams.get('closingOn')===value;
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(href);
      await expect(page.getByRole('heading',{name:account.name,level:2,exact:true})).toBeVisible();
      if(via!=='panel'){
        let overlay=await openAli(page);
        const q='diferencia entre efectivo y saldo';
        if(via==='chat')await askAli(overlay,`¿Dónde está ${q}?`);
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator('[data-capability-id="cash.preview-closing"]').getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(compare).toBeFocused();
        await expect(compare).toBeInViewport();
      }
      await expect(drawer).toHaveCount(0);
      const opening=previewFor(day);
      await compare.click();
      expect(await (await opening).json()).toMatchObject({accountId:account.id,closingOn:day,expectedMinor:8600000});
      await expect(drawer.getByRole('combobox',{name:/^Cuenta(?: \*)?$/})).toHaveValue(account.id);
      await count.fill('83000');
      const failed=previewFor(prior);
      await date.fill(prior);
      expect((await failed).ok()).toBe(false);
      const retry=drawer.getByRole('button',{name:'Reintentar consulta',exact:true});
      await expect(drawer.getByRole('alert')).toContainText(/apertura/i);
      const repeated=previewFor(prior);
      await retry.click();
      expect((await repeated).ok()).toBe(false);
      await expect(count).toHaveValue(/83[.,]?000/);
      await expect(drawer.getByRole('button',{name:'Cerrar caja',exact:true})).toBeDisabled();
      const restored=previewFor(day);
      await date.fill(day);
      expect((await restored).ok()).toBe(true);
      await expect(drawer.getByText(/Faltante de \$\s*3[.,]000/)).toBeVisible();
      await expect(drawer.getByText(`Esperado al ${day}`,{exact:true}).locator('..')).toContainText(/\$\s*86[.,]000/);
      if(via==='directorio'){
        await drawer.getByRole('heading',{name:'3. Comparación',exact:true}).scrollIntoViewIfNeeded();
        await screenshot(page,info,'advisor-c6-comparacion-sin-cierre');
      }
      expect(await entries()).toEqual(baseline);
      expect(await closings()).toEqual([]);
      page.once('dialog',prompt=>prompt.accept());
      await drawer.getByRole('button',{name:'Cancelar',exact:true}).click();
      await expect(compare).toBeFocused();
    });
    expect(writes).toEqual([]);
  }finally{await store.close();}
});

const c6StorefrontFixtures = [
  {
    key:'faq', kind:'faqs', singular:'pregunta', navigation:'Gestionar preguntas frecuentes',
    editField:'answer', editLabel:/^Respuesta(?: \*)?$/, editAnchor:'content-editor',
    fields:{answer:'Respuesta ficticia comprobada en el panel.'},
    queries:{list:'filtrar faq',open:'ver respuesta guardada',prepare:'preparar faq',create:'añadir pregunta y respuesta',edit:'corregir respuesta',archive:'archivar faq',delete:'borrar una faq',publish:'mostrar una respuesta',unpublish:'quitar una faq del sitio sin borrar'},
  },{
    key:'message', kind:'messages', singular:'mensaje', navigation:'Editar mensajes de la vitrina',
    editField:'body', editLabel:'Texto de apoyo', editAnchor:'content-editor',
    fields:{placement:'announcement',body:'Texto ficticio de la franja superior.',buttonText:'Consultar (solo prueba)'},
    queries:{list:'filtrar mensaje publicado',open:'abrir texto comercial',prepare:'formulario de texto comercial',create:'crear mensaje comercial',edit:'cambiar mensaje principal',archive:'archivar mensaje de vitrina',delete:'borrar mensaje de la web',publish:'publicar aviso de vitrina',unpublish:'ocultar texto comercial sin borrarlo'},
  },{
    key:'shipping', kind:'shipping', singular:'condición de envío', navigation:'Editar condiciones de envío',
    editField:'costText', editLabel:'Cómo se determina el costo', editAnchor:'terms-editor',
    fields:{zone:'Zona ficticia C6',costText:'Acuerdo ficticio; no es una cotización.',estimatedTime:'Plazo ficticio de prueba',cashOnDelivery:'Solo texto de prueba.',details:'No genera guía ni despacho.'},
    queries:{list:'filtrar cobertura',open:'ver cobertura guardada',prepare:'formulario de condiciones de envío',create:'añadir cobertura de vitrina',edit:'costos de envío públicos',archive:'archivar una cobertura',delete:'borrar condición de envío',publish:'mostrar cobertura pública',unpublish:'ocultar condición pública'},
  },
];

const c6StorefrontGroups={read:'lista, abre y prepara sin escribir',write:'crea, edita, archiva y elimina solo tras confirmar',publication:'publica y retira solo el estado de fichas ficticias'};
for(const [group,title] of Object.entries(c6StorefrontGroups))
for(const fixture of c6StorefrontFixtures){
  test(`Ali @advisor-c6: Vitrina — ${fixture.kind}, ${title}`,async({page,context,request},info)=>{
    test.setTimeout(180000);
    await loginWithAdvisorFixture(page,request);
    if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
    const store=await openStore(testDatabaseEnv());
    try{
      const {kind,key,singular,editField,editLabel,editAnchor,fields,queries}=fixture;
      const code=randomUUID().slice(0,8), actorId=await fixtureActor(context,store);
      const settings=await store.settings();
      expect(settings.launchApproved,'La vitrina global debe estar en modo preparación antes de cualquier cambio de estado').toBe(false);
      const path=`/admin?section=${kind}`, endpoint=`/api/admin/${kind}`, tag=`storefront.${key}`;
      const variants=['panel','chat','directorio'];
      const defaults=emptyRecord(kind);
      const displayState={draft:'Borrador',archived:'Archivado',published:'Publicado'};
      const values=record=>Object.fromEntries(Object.keys(defaults).map(name=>[name,record[name]]));
      const draftValues=(label,extra={})=>({...defaults,...fields,title:`Ficha C6 ${code} ${label}`,slug:`ficha-c6-${code}-${label}`,sort:38,...extra});
      const seed=payload=>store.save(kind,payload,null,null,actorId);
      const startRecords=await store.list(kind);
      const selected=group==='read'?await seed(draftValues('guardada')):null;
      const archived=group==='read'?await seed(draftValues('archivo',{status:'archived'})):null;
      const outside=group==='read'?await seed(draftValues('otra',{title:`No coincide ${code}`})):null;
      if(group==='read')startRecords.push(selected,archived,outside);
      const current=new Map();
      const writes=[], detailReads=[];
      page.on('request',req=>{
        const pathname=new URL(req.url()).pathname, method=req.method();
        if(!pathname.startsWith('/api/admin/'))return;
        if(method==='GET'){
          if(pathname.startsWith(`${endpoint}/`))detailReads.push(pathname);
          return;
        }
        if(method==='HEAD'||method==='OPTIONS'||method==='POST'&&/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(pathname))return;
        writes.push({pathname,method});
      });

      const editor=(fresh=false)=>page.getByRole('dialog',{name:`${fresh?'Crear':'Editar'} ${singular}`,exact:true});
      const field=(name,fresh=false)=>editor(fresh).locator(`[name="${name}"]`);
      const search=()=>page.getByRole('textbox',{name:'Buscar por nombre, presentación o referencia',exact:true});
      const filter=()=>page.getByRole('combobox',{name:'Filtrar por publicación',exact:true});
      const rowButton=record=>page.getByRole('button',{name:`Editar ${record.title}`,exact:true});
      const row=record=>rowButton(record).locator('xpath=ancestor::*[self::tr or self::li][1]');
      const createButton=()=>page.getByRole('button',{name:`Crear ${singular}`,exact:true});
      const heading=fresh=>editor(fresh).getByRole('heading',{name:`${fresh?'Crear':'Editar'} ${singular}`,exact:true});
      const status=()=>editor().getByRole('combobox',{name:'Publicación',exact:true});
      const editControl=()=>editor().getByRole('textbox',{name:editLabel,exact:true});
      const submit=fresh=>editor(fresh).getByRole('button',{name:fresh?`Crear ${singular}`:'Guardar cambios',exact:true});
      const deleteControl=()=>editor().getByRole('button',{name:`Eliminar ${singular}`,exact:true});
      const mode={list:'Consulta',open:'Consulta',prepare:'Preparación',create:'Requiere confirmación',edit:'Requiere confirmación',archive:'Paso manual',delete:'Requiere confirmación',publish:'Paso manual',unpublish:'Paso manual'};
      const responseFor=(method,pathname)=>page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===pathname);
      const urlIs=href=>expect(page).toHaveURL(url=>url.pathname+url.search===href);

      async function visitNativeList(){
        await page.goto('/admin?section=business&tab=setup');
        await page.getByText('Más opciones de configuración',{exact:true}).click();
        const listing=responseFor('GET',endpoint);
        await page.getByRole('button',{name:fixture.navigation,exact:true}).click();
        expect((await listing).status()).toBe(200);
        await urlIs(path);
      }
      async function openNativeRecord(record){
        const detail=responseFor('GET',`${endpoint}/${record.id}`);
        await rowButton(record).click();
        const response=await detail;
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual(record);
        await expect(heading(false)).toBeVisible();
      }
      async function advise(verb,via,insideEditor=false,fresh=false){
        let entry;
        if(insideEditor){
          await editor(fresh).getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
          entry=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        }else if(via==='chat')entry=await openAli(page);
        if(via==='chat')await askAli(entry,`¿Dónde está ${queries[verb]}?`);
        else{
          await (entry||page).getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción',exact:true}).fill(queries[verb]);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        const card=entry.locator(`[data-capability-id="${tag}-${verb}"]`);
        await expect(card).toContainText(mode[verb]);
        await card.getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:7000});
        return entry;
      }
      async function arrival(target,suffix,via){
        await expect(target).toBeVisible();
        await expect(target).toHaveAttribute('data-advisor-control',`storefront-${key}-${suffix}`);
        if(via!=='panel'){
          await expect(target).toBeFocused();
          await expect(target).toHaveAttribute('data-advisor-arrival','');
          await expect(target).toBeInViewport();
        }
      }
      async function checkFields(record,fresh=false){
        for(const [name,value] of Object.entries(values(record)))await expect(field(name,fresh)).toHaveValue(String(value));
      }
      async function commit(verb,input,previous){
        const fresh=verb==='create', deleting=verb==='delete';
        const method=deleting?'DELETE':fresh?'POST':'PUT', pathname=fresh?endpoint:`${endpoint}/${previous.id}`;
        const before=writes.length, pending=responseFor(method,pathname);
        if(deleting){
          const firstConfirm=page.waitForEvent('dialog');
          const firstClick=deleteControl().click();
          const cancelled=await firstConfirm;
          expect(cancelled.type()).toBe('confirm');
          expect(cancelled.message()).toMatch(/acción es irreversible/);
          expect(writes).toHaveLength(before);
          await cancelled.dismiss();
          await firstClick;
          await expect(editor()).toBeVisible();
          expect(await store.get(kind,previous.id)).toEqual(previous);
          expect(writes).toHaveLength(before);

          const finalConfirm=page.waitForEvent('dialog');
          const finalClick=deleteControl().click();
          const accepted=await finalConfirm;
          expect(accepted.message()).toBe(cancelled.message());
          expect(writes).toHaveLength(before);
          await accepted.accept();
          await finalClick;
        }else await submit(fresh).click();
        const response=await pending;
        expect(response.status(),await response.text()).toBe(fresh?201:200);
        const saved=await response.json(), req=response.request(), payload=req.postDataJSON();
        expect(writes.slice(before)).toEqual([{pathname,method}]);
        await expect(editor(fresh)).toHaveCount(0);
        const notice=deleting?`Eliminado: ${previous.title}`:`Guardado: ${saved.title} · ${displayState[saved.status]}`;
        await expect(page.locator('main .success[role="status"]')).toContainText(notice);
        if(deleting){
          expect(payload).toEqual({version:previous.version,requestId:expect.any(String)});
          expect(saved).toEqual({ok:true});
          expect(await store.get(kind,previous.id)).toBeNull();
          expect((await context.request.get(response.url())).status()).toBe(404);
          await expect(rowButton(previous)).toHaveCount(0);
        }else{
          expect(payload).toMatchObject(input);
          if(previous)expect(payload.version).toBe(previous.version);
          expect(saved).toMatchObject({...input,id:previous?.id??expect.any(String),version:previous?previous.version+1:1});
          expect(await store.get(kind,saved.id)).toEqual(saved);
          const readback=await context.request.get(`${endpoint}/${saved.id}`);
          expect(readback.status()).toBe(200);
          expect(await readback.json()).toEqual(saved);
          await expect(row(saved).getByText(displayState[saved.status],{exact:true})).toBeVisible();
        }
        const headers={origin:await req.headerValue('origin'),'x-csrf-token':await req.headerValue('x-csrf-token')};
        const replay=await context.request.fetch(response.url(),{method,data:payload,headers});
        expect(replay.status()).toBe(response.status());
        expect(await replay.json()).toEqual(saved);
        const scope=`storefront-content:${kind}:${fresh?'create':deleting?'delete':'update'}${fresh?'':':'+previous.id}`;
        const receipt=await store.db.get(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE request_id=? AND scope=?`,[payload.requestId,scope]);
        expect(receipt.actor_id).toBe(actorId);
        expect(JSON.parse(receipt.result_json)).toEqual(saved);
        const conflict=await context.request.fetch(response.url(),{method,data:{...payload,...(deleting?{version:payload.version+1}:{title:`${saved.title} diferente`})},headers});
        expect(conflict.status()).toBe(409);
        expect(await store.get(kind,previous?.id??saved.id)).toEqual(deleting?null:saved);
        if(fresh)expect((await store.list(kind)).filter(record=>record.slug===saved.slug)).toHaveLength(1);
        return saved;
      }

      if(group==='read')await test.step(`${tag}-list`,async()=>{
        for(const via of variants){
          const before=writes.length;
          if(via==='panel')await visitNativeList();
          else{await page.goto('/admin');await advise('list',via);}
          await urlIs(path);
          await arrival(search(),'filters',via);
          await search().fill(`Ficha C6 ${code}`);
          await expect(rowButton(selected)).toBeVisible();
          await expect(rowButton(archived)).toBeVisible();
          await expect(rowButton(outside)).toHaveCount(0);
          await filter().selectOption('archived');
          await expect(row(archived).getByText('Archivado',{exact:true})).toBeVisible();
          await expect(rowButton(selected)).toHaveCount(0);
          expect(writes).toHaveLength(before);
        }
      });

      if(group==='read')await test.step(`${tag}-open`,async()=>{
        for(const via of variants){
          const before=writes.length;
          await visitNativeList();
          await openNativeRecord(selected);
          const reads=detailReads.length;
          if(via!=='panel')await advise('open',via,true);
          await urlIs(path);
          await arrival(heading(false),'open-record',via);
          await expect(heading(false)).toBeFocused();
          await checkFields(selected);
          expect(detailReads).toHaveLength(reads);
          expect(writes).toHaveLength(before);
          if(via==='directorio')await screenshot(page,info,`advisor-c6-vitrina-${key}`);
          await editor().getByRole('button',{name:'Cerrar editor',exact:true}).click();
          await expect(editor()).toHaveCount(0);
        }
      });

      if(group==='read')await test.step(`${tag}-prepare`,async()=>{
        for(const via of variants){
          const before=writes.length, records=(await store.list(kind)).map(record=>record.id).sort();
          if(via==='panel'){
            await visitNativeList();
            await createButton().click();
          }else{
            await page.goto('/admin');
            await advise('prepare',via);
          }
          await urlIs(via==='panel'?path:`${path}&record=new`);
          await arrival(heading(true),'new-form',via);
          await checkFields(defaults,true);
          await field('title',true).fill(`Preparación ficticia ${code} ${via}`);
          await field(editField,true).fill(`Dato local ${code} ${via}`);
          await expect(editor(true).getByText('Cambios sin guardar',{exact:true})).toBeVisible();
          expect(writes).toHaveLength(before);
          expect((await store.list(kind)).map(record=>record.id).sort()).toEqual(records);
          page.once('dialog',dialog=>dialog.accept());
          await editor(true).getByRole('button',{name:'Cancelar edición',exact:true}).click();
          await expect(editor(true)).toHaveCount(0);
          await urlIs(path);
        }
      });

      if(group==='write')await test.step(`${tag}-create`,async()=>{
        for(const via of variants){
          const before=writes.length, input=draftValues(via);
          if(via==='chat'){
            await page.goto('/admin');
            await advise('create',via);
          }else{
            await visitNativeList();
            await createButton().click();
            if(via==='directorio'){
              await field('title',true).fill(input.title);
              await advise('create',via,true,true);
            }
          }
          await urlIs(via==='chat'?`${path}&record=new`:path);
          await arrival(submit(true),'create-editor',via);
          await expect(field('title',true)).toHaveValue(via==='directorio'?input.title:'');
          await expect(field('status',true)).toHaveValue('draft');
          for(const [name,value] of Object.entries(input)){
            if(name==='status')continue;
            if(name==='placement')await field(name,true).selectOption(value);
            else await field(name,true).fill(String(value));
          }
          await expect(field('slug',true)).toHaveValue(input.slug);
          expect(writes).toHaveLength(before);
          expect((await store.list(kind)).some(record=>record.slug===input.slug)).toBe(false);
          current.set(via,await commit('create',input));
          await urlIs(path);
        }
      });

      if(group==='write')await test.step(`${tag}-edit`,async()=>{
        for(const via of variants){
          const before=writes.length, record=current.get(via), change=`Condición textual ficticia ${code} ${via}`;
          await visitNativeList();
          await openNativeRecord(record);
          const reads=detailReads.length;
          if(via==='directorio')await editControl().fill(change);
          if(via!=='panel')await advise('edit',via,true);
          await urlIs(path);
          await arrival(editControl(),editAnchor,via);
          await expect(editControl()).toHaveValue(via==='directorio'?change:record[editField]);
          if(via!=='directorio')await editControl().fill(change);
          await field('sort').fill('39');
          await expect(status()).toHaveValue(record.status);
          expect(detailReads).toHaveLength(reads);
          expect(writes).toHaveLength(before);
          expect(await store.get(kind,record.id)).toEqual(record);
          current.set(via,await commit('edit',{...values(record),[editField]:change,sort:39},record));
        }
      });

      async function transition(verb,next){
        await test.step(`${tag}-${verb}`,async()=>{
          for(const via of variants){
            const before=writes.length, record=current.get(via);
            expect((await store.settings()).launchApproved).toBe(false);
            await visitNativeList();
            await openNativeRecord(record);
            const reads=detailReads.length;
            if(via!=='panel')await advise(verb,via,true);
            await urlIs(path);
            await arrival(status(),'publication-control',via);
            await expect(status()).toHaveValue(record.status);
            await status().selectOption(next);
            await expect(status()).toHaveValue(next);
            await expect(editor().getByText('Cambios sin guardar',{exact:true})).toBeVisible();
            expect(detailReads).toHaveLength(reads);
            expect(writes).toHaveLength(before);
            expect(await store.get(kind,record.id)).toEqual(record);
            const saved=await commit(verb,{...values(record),status:next},record);
            current.set(via,saved);
            expect(await store.settings()).toEqual(settings);
            if(next==='archived'){
              await filter().selectOption('draft');
              await expect(rowButton(saved)).toHaveCount(0);
              await filter().selectOption('archived');
              await expect(row(saved).getByText('Archivado',{exact:true})).toBeVisible();
            }
          }
        });
      }
      if(group==='write')await transition('archive','archived');

      if(group==='write')await test.step(`${tag}-delete`,async()=>{
        for(const via of variants){
          const before=writes.length, record=current.get(via);
          await visitNativeList();
          await openNativeRecord(record);
          const reads=detailReads.length;
          if(via==='panel')await editor().getByText('Eliminar contenido',{exact:true}).click();
          else await advise('delete',via,true);
          await urlIs(path);
          await arrival(deleteControl(),'delete-confirmation',via);
          await expect(deleteControl().locator('xpath=ancestor::details[1]')).toHaveAttribute('open','');
          expect(detailReads).toHaveLength(reads);
          expect(writes).toHaveLength(before);
          expect(await store.get(kind,record.id)).toEqual(record);
          await commit('delete',null,record);
        }
      });

      if(group==='read')await test.step(`${tag}: no adivina el registro sin editor`,async()=>{
        const before=writes.length;
        for(const [verb,via] of [['open','chat'],['delete','directorio']]){
          await page.goto('/admin');
          const entry=await advise(verb,via);
          await expect(entry.getByRole('alert')).toContainText('El control no se abrió.');
          await expect(page.locator('dialog.editor-drawer[open]')).toHaveCount(0);
          await urlIs('/admin');
        }
        expect(writes).toHaveLength(before);
      });
      if(group==='publication'){
        // Publication and withdrawal affect only these synthetic records. The global gate never opens.
        for(const via of variants)current.set(via,await seed(draftValues(via)));
        await transition('publish','published');
        await transition('unpublish','draft');
        startRecords.push(...current.values());
      }
      expect(writes).toHaveLength({read:0,write:12,publication:6}[group]);
      expect(await store.settings()).toEqual(settings);
      const remaining=await store.list(kind), byId=new Map(remaining.map(record=>[record.id,record]));
      expect(remaining).toHaveLength(startRecords.length);
      for(const original of startRecords)expect(byId.get(original.id)).toEqual(original);
    }finally{
      await store.close();
    }
  });
}

test('Ali @advisor-c6: prepara, revisa y guarda campañas locales sin contactar proveedores', async ({ page, context, request }, info) => {
  test.setTimeout(240000);
  const app = new URL(info.project.use.baseURL);
  if (app.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(app.hostname)) throw new Error('La evidencia requiere HTTPS local descartable.');
  const env = testDatabaseEnv();
  if (!['db', 'localhost', '127.0.0.1'].includes(new URL(env.DATABASE_URL).hostname) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('La evidencia requiere PostgreSQL local con TLS verificado.');
  const root = '/api/admin/social', campaigns = `${root}/campaigns`, assets = `${root}/assets`;
  const writes = [], forbidden = [], pageErrors = [];
  let allowed = null;
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.origin !== app.origin) {
      forbidden.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname.startsWith(`${root}/`) && !['GET', 'HEAD'].includes(method)) {
      const body = req.postDataJSON();
      writes.push({ method, path: url.pathname, body });
      if (allowed?.method !== method || allowed.path !== url.pathname || body?.action !== allowed.action) {
        forbidden.push(`${method} ${url.pathname}`);
        return route.abort();
      }
      allowed = null;
    }
    return route.continue();
  });
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 740 });
    expect(page.viewportSize().width).toBe(320);
  }
  const store = await openStore(env);
  try {
    expect((await store.db.get('SELECT current_database() AS name')).name).toBe('allnutrition_test');
    const actor = await fixtureActor(context, store);
    const appPath = (params = {}) => `/admin?${new URLSearchParams({ section: 'advertising', tab: 'campaigns', ...params })}`;
    const first = page.waitForRequest(req => new URL(req.url()).pathname === campaigns && Boolean(req.headers()['x-csrf-token']));
    await page.goto(appPath({ q: 'borrador evidencia local sin coincidencias' }));
    const headers = { Origin: app.origin, 'x-csrf-token': await (await first).headerValue('x-csrf-token') };
    async function json(response, code = 200) {
      expect(response.status(), await response.text()).toBe(code);
      return response.json();
    }
    // Upload and normalize one known private PNG through the same fixture used by the library test.
    const sharp = (await import('sharp')).default;
    const marker = randomUUID().slice(0, 8).replace(/\d/g, digit => 'ghijklmnop'[Number(digit)]);
    const image = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#375572' } }).png().toBuffer();
    const reserved = await json(await context.request.post(assets, { headers, data: { name: `Pieza local ${marker}`, contentType: 'image/png', expectedBytes: image.length, requestId: randomUUID() } }), 201);
    await json(await context.request.put(`${assets}/${reserved.id}/content`, { headers: { ...headers, 'content-type': 'image/png', 'x-asset-version': String(reserved.version), 'x-request-id': randomUUID() }, data: image }), 202);
    const container = process.env.ALI_FIXTURE_ASSET_CONTAINER;
    if (container) {
      expect(container).toMatch(/^advisor-c1-[a-f0-9]+-web$/);
      const { execFileSync } = await import('node:child_process');
      execFileSync('docker', ['exec', container, 'node', 'tests/e2e/guided-image-worker.mjs', 'asset', reserved.id, app.origin], { timeout: 20000, encoding: 'utf8' });
    }
    const assetRow = () => store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [reserved.id]);
    await expect.poll(async () => (await assetRow()).state, { timeout: 70000 }).toBe('ready');
    const originalAsset = await assetRow();
    const derivative = await context.request.get(`${assets}/${reserved.id}/content?variant=derivative`);
    expect(derivative.status()).toBe(200);
    expect(createHash('sha256').update(await derivative.body()).digest('hex')).toBe(JSON.parse(originalAsset.data).derivativeSha256);

    const connectionId = randomUUID(), connectionName = `Cuenta retirada ${marker}`, now = new Date().toISOString();
    await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'disconnected', data: JSON.stringify({ name: connectionName, identities: {}, capabilities: {} }), version: 1, created_at: now, updated_at: now });
    const connectionRow = () => store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id=?`, [connectionId]);
    const originalConnection = await connectionRow();
    const credentials = () => store.db.all(`SELECT connection_id FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connectionId]);
    expect(await credentials()).toEqual([]);
    const providerWork = () => store.db.all(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'social:%' AND key NOT LIKE 'social:asset:%' ORDER BY key`);
    const jobsBefore = await providerWork();
    const receipts = () => store.db.all(`SELECT scope,request_id,actor_id,result_json FROM ${store.t('business_requests')} WHERE actor_id=? AND scope LIKE 'social:campaign:%' ORDER BY scope,request_id`, [actor]);
    const campaignRow = id => store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [id]);
    const trail = id => store.db.all(`SELECT actor_id,data FROM ${store.t('business_audit')} WHERE entity_type='social_campaign' AND entity_id=? ORDER BY recorded_at,id`, [id]);
    const startDraft = (name, data = {}) => saveSocialCampaign(store, { requestId: randomUUID(), version: 0, mode: 'organic', objective: 'engagement', name, ...data }, actor);
    async function detail(id, expected) {
      const saved = await getSocialCampaign(store, id);
      expect(saved).toMatchObject({ id, revisions: [], deliveries: [], operations: [], forecasts: [], recommendations: [], ...expected });
      const read = await json(await context.request.get(`${campaigns}/${id}`));
      expect(read).toMatchObject({ id, version: saved.version, state: saved.state, revisions: [], deliveries: [], operations: [], ...expected });
      return saved;
    }
    async function noMutation(before, draftBefore, receiptBefore) {
      expect(writes).toHaveLength(before);
      for (const row of draftBefore) expect(await campaignRow(row.id)).toEqual(row);
      expect(await receipts()).toEqual(receiptBefore);
      expect(await providerWork()).toEqual(jobsBefore);
    }
    async function nativeWrite(control, method, path, code, action) {
      const count = writes.length;
      const pending = page.waitForResponse(res => res.request().method() === method && new URL(res.url()).pathname === path);
      allowed = { method, path, action };
      await control.click();
      const result = await json(await pending, code);
      expect(allowed).toBeNull();
      expect(writes).toHaveLength(count + 1);
      return { result, body: writes.at(-1).body };
    }
    async function verifyReceipt(scope, body, result, path, method) {
      const read = () => store.db.get(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, body.requestId]);
      const receipt = await read();
      expect(receipt.actor_id).toBe(actor);
      expect(JSON.parse(receipt.result_json)).toEqual(result);
      const row = await campaignRow(result.id), history = await trail(result.id), before = await receipts();
      const replay = await context.request.fetch(path, { method, headers, data: body });
      expect(await json(replay, method === 'POST' && path === campaigns ? 201 : 200)).toEqual(result);
      expect(await read()).toEqual(receipt);
      expect(await campaignRow(result.id)).toEqual(row);
      expect(await trail(result.id)).toEqual(history);
      expect(await receipts()).toEqual(before);
    }
    async function arrive(via, id, query, target) {
      if (via === 'panel') { await expect(target).toBeVisible(); return; }
      let dialog = await openAli(page);
      const selector = `[data-capability-id="advertising.${id}"]`;
      if (via === 'chat') {
        const count = await dialog.locator(selector).count();
        await askAli(dialog, `¿Dónde encuentro ${query}?`);
        await expect(dialog.locator(selector)).toHaveCount(count + 1);
      } else {
        await dialog.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
        dialog = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
        await dialog.getByLabel('Área').selectOption('advertising');
        await dialog.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
        await dialog.getByRole('button', { name: 'Buscar', exact: true }).click();
      }
      await (via === 'chat' ? dialog.locator(selector).last() : dialog.locator(selector)).getByRole('button', { name: /^Abrir en el panel:/ }).click();
      await expect(dialog).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    const button = name => page.getByRole('button', { name, exact: true });
    const heading = name => page.getByRole('heading', { name, exact: true });
    const textbox = name => page.getByRole('textbox', { name, exact: true });
    const select = name => page.getByRole('combobox', { name, exact: true });
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    const summary = name => page.locator('summary').and(page.getByText(name, { exact: true }));
    const onRecord = id => expect(page).toHaveURL(url => url.searchParams.get('section') === 'advertising' && url.searchParams.get('tab') === 'campaigns' && url.searchParams.get('record') === id && !url.searchParams.has('source'));
    const campaignTitle = name => page.getByRole('heading', { name, exact: true, level: 2 });
    const campaignName = page.getByRole('textbox', { name: /^Nombre de la publicación/ });
    const radio = mode => page.locator(`input[type=radio][name=mode][value=${mode}]`);
    const save = button('Guardar borrador'), start = button('Crear publicación o campaña'), skip = button('Definir primero, sin imagen aún');
    const cancel = button('Cancelar trabajo / detener anuncios');
    const confirmation = dialog('Cancelar trabajo o pausar anuncios emitidos');
    const cancelConfirm = confirmation.getByRole('button', { name: 'Confirmar solicitud', exact: true });
    const cancelBack = confirmation.getByRole('button', { name: 'Volver sin ejecutar', exact: true });

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const filter = `C6 local ${marker} ${via}`, primaryName = `${filter} principal`, otherName = `${filter} alterna`, paidName = `${filter} pagada`;
      const primary = await startDraft(primaryName, { assetId: reserved.id, platforms: ['facebook', 'instagram'], placements: ['facebook_feed', 'instagram_feed'], marketCountries: [], aiDisclosure: false });
      const other = await startDraft(otherName, { assetId: reserved.id, platforms: ['facebook'], placements: ['facebook_feed'], marketCountries: ['CO'], aiDisclosure: false });
      const paid = await startDraft(paidName, { mode: 'paid', objective: 'traffic', platforms: ['instagram'] });
      const localName = `${filter} retirable`, local = await startDraft(localName, { connectionId, assetId: reserved.id });
      const originals = await Promise.all([primary, other, paid, local].map(({ id }) => campaignRow(id)));
      const receiptBefore = await receipts(), before = writes.length;
      const originalHistory = await trail(primary.id);
      await test.step('advertising.open-campaign · búsqueda y filtros nativos', async () => {
        await page.goto(appPath({ q: filter }));
        const scope = page.getByRole('region', { name: 'Buscar y filtrar publicaciones', exact: true });
        const search = textbox('Buscar publicación');
        const row = name => page.getByRole('article').filter({ has: heading(name) });
        await expect(search).toHaveValue(filter);
        await scope.getByRole('combobox', { name: 'Tipo de publicación', exact: true }).selectOption('organic');
        await scope.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('draft');
        await summary('Más filtros').click();
        await scope.getByRole('combobox', { name: 'Objetivo', exact: true }).selectOption('engagement');
        const network = scope.getByRole('combobox', { name: 'Red', exact: true });
        const expected = { q: filter, status: 'draft', mode: 'organic', objective: 'engagement', network: 'instagram', page: '1' };
        const read = page.waitForResponse(res => {
          const url = new URL(res.url());
          return res.request().method() === 'GET' && url.pathname === campaigns && Object.entries(expected).every(([key, value]) => url.searchParams.get(key) === value);
        });
        await network.selectOption('instagram');
        expect((await json(await read)).campaigns.map(({ id, version }) => ({ id, version }))).toEqual([{ id: primary.id, version: primary.version }]);
        await expect(row(primaryName)).toBeVisible();
        await expect(row(otherName)).toHaveCount(0);
        await expect(row(paidName)).toHaveCount(0);
        await scope.getByRole('button', { name: 'Quitar filtro: Red: Instagram', exact: true }).click();
        await expect(search).toBeFocused();
        await expect(row(otherName)).toBeVisible();
        await network.selectOption('instagram');
        await expect(row(otherName)).toHaveCount(0);
        await arrive(via, 'open-campaign', 'retomar publicación', search);
        await expect(page).toHaveURL(url => ['q', 'status', 'mode', 'objective', 'network'].every(key => url.searchParams.get(key) === expected[key]));
        await row(primaryName).getByRole('button', { name: 'Continuar borrador', exact: true }).click();
        await onRecord(primary.id);
        const title = campaignTitle(primaryName);
        await expect(title).toBeVisible();
        await arrive(via, 'open-campaign', 'retomar publicación', title);
        await onRecord(primary.id);
        await detail(primary.id, { name: primaryName, version: primary.version, state: 'draft', connectionId: null, assetId: reserved.id });
      });

      await test.step('advertising.review-draft', async () => {
        const review = button('Continuar a revisión');
        await arrive(via, 'review-draft', 'requisitos pendientes', review);
        await review.click();
        await expect(heading('Paso 2 de 2 · Revisar y publicar')).toBeFocused();
        const missing = page.getByRole('region', { name: 'Qué falta antes de aprobar', exact: true });
        await expect(missing).toContainText('Falta confirmar el mercado');
        await expect(missing).toContainText('Selecciona una cuenta de Facebook o Instagram.');
        await expect(page.getByText('Por comprobar · conecta una cuenta al revisar los destinos.', { exact: true })).toHaveCount(2);
        const preview = page.getByRole('article').filter({ has: heading('Página de Facebook · Sin nombre verificado') }).getByRole('img');
        await expect.poll(() => preview.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
        await expect(button('Aprobar sin publicar')).toHaveCount(0);
        await screenshot(page, info, `advisor-c6-publicidad-requisitos-${via}`);
        await missing.getByRole('button', { name: 'Elegir mercados', exact: true }).click();
        await expect(button('Elegir mercados')).toBeFocused();
        await noMutation(before, originals, receiptBefore);
      });

      const edited = `${primaryName} revisada`, copy = 'Texto sintético preparado por la persona';
      await test.step('advertising.define-message', async () => {
        await arrive(via, 'define-message', 'redactar texto de campaña', heading('Idea y oferta'));
        await expect(campaignName).toHaveValue(primaryName);
        await campaignName.fill(edited);
        await select('Objetivo comercial').selectOption('traffic');
        await textbox('Texto que acompaña la imagen o video').fill(copy);
        await textbox('Título o llamada a la acción').fill('Conoce la idea');
        await textbox('URL de destino').fill('https://example.test/idea');
        await expect(page.getByText(/En Instagram sin inversión, los enlaces del texto no son llamadas a la acción clicables/)).toBeVisible();
        await noMutation(before, originals, receiptBefore);
      });

      await test.step('advertising.choose-networks', async () => {
        const networks = button('Elegir redes');
        await arrive(via, 'choose-networks', 'seleccionar redes', networks);
        await expect(networks).toHaveAccessibleDescription('Página de Facebook, Cuenta profesional de Instagram');
        await networks.click();
        const pick = dialog('Redes donde saldrá'), instagram = pick.getByRole('checkbox', { name: 'Cuenta profesional de Instagram', exact: true });
        await expect(instagram).toBeChecked();
        await instagram.uncheck();
        await pick.getByRole('button', { name: 'Aplicar', exact: true }).click();
        await expect(networks).toBeFocused();
        await expect(networks).toHaveAccessibleDescription('Página de Facebook');
        await expect(button('Elegir ubicaciones')).toHaveAccessibleDescription('Facebook · Feed');
        await noMutation(before, originals, receiptBefore);
      });

      await test.step('advertising.choose-placements', async () => {
        const placements = button('Elegir ubicaciones');
        await arrive(via, 'choose-placements', 'ubicaciones del anuncio', placements);
        const pick = dialog('Ubicaciones'), feed = pick.getByRole('checkbox', { name: 'Facebook · Feed', exact: true });
        await placements.click();
        await expect(pick.getByRole('checkbox')).toHaveCount(1);
        await expect(feed).toBeChecked();
        await feed.uncheck();
        await pick.getByRole('button', { name: 'Aplicar', exact: true }).click();
        await expect(placements).toHaveAccessibleDescription('Sin seleccionar');
        await placements.click();
        await expect(feed).not.toBeChecked();
        await feed.check();
        await pick.getByRole('button', { name: 'Aplicar', exact: true }).click();
        await expect(placements).toBeFocused();
        await expect(placements).toHaveAccessibleDescription('Facebook · Feed');
        await noMutation(before, originals, receiptBefore);
      });

      await test.step('advertising.choose-markets', async () => {
        const markets = button('Elegir mercados');
        await arrive(via, 'choose-markets', 'países de campaña', markets);
        await markets.click();
        const pick = dialog('¿En qué país o países quieres publicar?'), search = pick.getByRole('searchbox', { name: 'Buscar país' });
        await search.fill('Mexico');
        const mx = pick.getByRole('checkbox', { name: 'México (MX)', exact: true });
        await mx.check();
        await search.press('Escape');
        await expect(markets).toBeFocused();
        await expect(markets).toHaveAccessibleDescription('Ningún país elegido');
        await markets.click();
        await search.fill('Mexico');
        await expect(mx).not.toBeChecked();
        await mx.check();
        await search.fill('Colombia');
        await pick.getByRole('checkbox', { name: 'Colombia (CO)', exact: true }).check();
        await expect(pick.getByText('Seleccionados: 2', { exact: true })).toBeVisible();
        await screenshot(page, info, `advisor-c6-publicidad-mercados-${via}`);
        await pick.getByRole('button', { name: 'Aplicar', exact: true }).click();
        await expect(markets).toHaveAccessibleDescription('Colombia (CO), México (MX)');
        await expect(page.getByText(/No restringe ni garantiza la distribución de un post en Meta/)).toBeVisible();
        await noMutation(before, originals, receiptBefore);
      });

      let date;
      await test.step('advertising.plan-organic-schedule', async () => {
        await arrive(via, 'plan-organic-schedule', 'horizonte de observación', heading('Agenda de publicación'));
        date = await page.evaluate(() => {
          const next = new Date();
          next.setDate(next.getDate() + 7);
          next.setHours(10, 30, 0, 0);
          const pad = value => String(value).padStart(2, '0');
          return { local: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T10:30`, iso: next.toISOString() };
        });
        const agenda = page.getByLabel(/^Publicación programada opcional \(hora del dispositivo\)/);
        await agenda.fill(date.local);
        await expect(agenda).toHaveValue(date.local);
        await summary('Opciones de seguimiento').click();
        await select('Horizonte de observación').selectOption('14');
        await expect(select('Horizonte de observación')).toHaveValue('14');
        await expect(page.getByText(/Aprobar no publica ni programa entregas/)).toBeVisible();
        await noMutation(before, originals, receiptBefore);
      });

      let updated;
      await test.step('advertising.update-draft', async () => {
        const path = `${campaigns}/${primary.id}`;
        await arrive(via, 'update-draft', 'editar borrador de campaña', save);
        await onRecord(primary.id);
        await expect(campaignName).toHaveValue(edited);
        await expect(textbox('Texto que acompaña la imagen o video')).toHaveValue(copy);
        await noMutation(before, originals, receiptBefore);
        const payload = { name: edited, objective: 'traffic', caption: copy, headline: 'Conoce la idea', destinationUrl: 'https://example.test/idea', mode: 'organic', platforms: ['facebook'], placements: ['facebook_feed'], marketCountries: ['CO', 'MX'], observationDays: 14, publishAt: date.iso, connectionId: null, assetId: reserved.id };
        const { result, body } = await nativeWrite(save, 'PATCH', path, 200);
        expect(body).toMatchObject({ ...payload, version: primary.version });
        expect(result).toMatchObject({ id: primary.id, version: primary.version + 1, state: 'draft' });
        await expect(campaignTitle(edited)).toBeVisible();
        await expect(page.getByText('Borrador guardado. No se publicó ni se autorizó gasto.', { exact: true })).toBeVisible();
        await detail(primary.id, { ...payload, version: result.version, state: 'draft' });
        expect(await trail(primary.id)).toEqual(expect.arrayContaining(originalHistory));
        expect(await trail(primary.id)).toHaveLength(originalHistory.length + 1);
        await verifyReceipt(`social:campaign:save:${primary.id}`, body, result, path, 'PATCH');
        updated = await campaignRow(primary.id);
      });

      await test.step('advertising.review-connection-prerequisite', async () => {
        // The campaign is attached to a deliberately disconnected fixture with no credentials.
        await page.goto(appPath({ record: local.id }));
        const prerequisite = button('Revisar esta cuenta en Redes sociales');
        await expect(campaignTitle(localName)).toBeVisible();
        await expect(page.getByText(/La cuenta seleccionada no está lista para publicar/)).toBeVisible();
        await arrive(via, 'review-connection-prerequisite', 'falta conexión para publicar', prerequisite);
        await onRecord(local.id);
        const unchanged = await receipts(), count = writes.length;
        await prerequisite.click();
        await expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'social' && url.searchParams.get('record') === connectionId);
        const account = page.getByRole('article', { name: connectionName, exact: true });
        await expect(account.getByRole('heading', { name: connectionName, exact: true })).toBeFocused();
        await expect(account).toContainText('Las credenciales fueron retiradas.');
        await expect(account.getByText('Desconectada', { exact: true })).toBeVisible();
        await noMutation(count, [originals[3]], unchanged);
        expect(await connectionRow()).toEqual(originalConnection);
        expect(await credentials()).toEqual([]);
      });

      await test.step('advertising.cancel-local-work · abandono, rechazo y confirmación local', async () => {
        const receiptBaseline = await receipts(), beforeCancel = writes.length;
        await page.goto(appPath({ record: primary.id }));
        await arrive(via, 'cancel-local-work', 'cancelar agenda sin envío', cancel);
        await cancel.click();
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByText(/Cancelar una agenda no enviada es local/)).toBeVisible();
        await cancelBack.click();
        await expect(cancel).toBeFocused();
        await noMutation(beforeCancel, [updated, originals[3]], receiptBaseline);
        await cancel.click();
        const failed = await nativeWrite(cancelConfirm, 'POST', `${campaigns}/${primary.id}/actions`, 409, 'cancel');
        expect(failed.body).toMatchObject({ action: 'cancel', version: primary.version + 1 });
        await expect(confirmation.getByRole('alert')).toContainText('El borrador incompleto no tiene una publicación local que cancelar.');
        await cancelBack.click();
        await noMutation(beforeCancel + 1, [updated, originals[3]], receiptBaseline);

        await page.goto(appPath({ record: local.id }));
        await arrive(via, 'cancel-local-work', 'cancelar agenda sin envío', cancel);
        await onRecord(local.id);
        await detail(local.id, { state: 'draft', mode: 'organic', connectionId, assetId: reserved.id, version: local.version });
        await cancel.click();
        const reason = `Retiro estrictamente local ${via}`;
        await confirmation.getByRole('textbox', { name: 'Motivo de la acción', exact: true }).fill(reason);
        await noMutation(beforeCancel + 1, [updated, originals[3]], receiptBaseline);
        await screenshot(page, info, `advisor-c6-publicidad-cancelar-local-${via}`);
        const path = `${campaigns}/${local.id}/actions`;
        const { result, body } = await nativeWrite(cancelConfirm, 'POST', path, 200, 'cancel');
        expect(body).toMatchObject({ action: 'cancel', version: local.version, reason });
        expect(result).toEqual({ id: local.id, version: local.version + 1, state: 'cancelled', deliveryIds: [] });
        await expect(page.getByText('Trabajo local cancelado. No se borraron publicaciones en Meta.', { exact: true })).toBeVisible();
        await expect(cancel).toHaveCount(0);
        await detail(local.id, { state: 'cancelled', version: local.version + 1, connectionId, assetId: reserved.id });
        expect((await trail(local.id)).map(row => ({ actor: row.actor_id, ...JSON.parse(row.data) }))).toContainEqual(expect.objectContaining({ actor, previous: { state: 'draft' }, next: { state: 'cancelled', cancelledDeliveryIds: [] }, reason: expect.stringContaining('No se modificó ningún objeto en Meta.') }));
        await verifyReceipt(`social:campaign:cancel:${local.id}`, body, result, path, 'POST');
        expect(await receipts()).toHaveLength(receiptBaseline.length + 1);
        expect(await providerWork()).toEqual(jobsBefore);
      });

      await test.step('advertising.choose-publication-mode y advertising.create-draft', async () => {
        await page.goto(appPath({ q: filter }));
        const count = writes.length, unchanged = await receipts(), draftName = `Idea nueva ${marker} ${via}`;
        const namedRows = () => store.db.all(`SELECT id,version,state FROM ${store.t('social_campaigns')} WHERE name=? ORDER BY id`, [draftName]);
        if (via === 'panel') await start.click();
        await arrive(via, 'choose-publication-mode', 'definir primero sin imagen', skip);
        await onRecord('new');
        await skip.click();
        await expect(heading('¿Qué quieres publicar?')).toBeFocused();
        await button('Anuncio pagado').click();
        await expect(radio('paid')).toBeChecked();
        await expect(heading('Presupuesto y agenda')).toBeVisible();
        await radio('organic').check();
        await expect(radio('organic')).toBeChecked();
        await expect(heading('Agenda de publicación')).toBeVisible();
        await expect(heading('Presupuesto y agenda')).toHaveCount(0);
        await campaignName.fill('');
        await expect(save).toBeDisabled();
        await campaignName.fill(draftName);
        const caption = textbox('Texto que acompaña la imagen o video');
        await caption.fill('Una idea nueva sin pieza ni cuenta');
        await arrive(via, 'create-draft', 'guardar sin publicar', save);
        await onRecord('new');
        await expect(campaignName).toHaveValue(draftName);
        await expect(caption).toHaveValue('Una idea nueva sin pieza ni cuenta');
        expect(await namedRows()).toEqual([]);
        await noMutation(count, [], unchanged);
        await screenshot(page, info, `advisor-c6-publicidad-guardar-borrador-${via}`);
        const { result, body } = await nativeWrite(save, 'POST', campaigns, 201);
        const created = { name: draftName, caption: 'Una idea nueva sin pieza ni cuenta', mode: 'organic', objective: 'engagement', connectionId: null, assetId: null, platforms: [], placements: [], budgetMinor: 0 };
        expect(body).toMatchObject({ ...created, version: 0 });
        expect(result).toMatchObject({ state: 'draft', version: 1 });
        await onRecord(result.id);
        await expect(campaignTitle(draftName)).toBeVisible();
        expect(await namedRows()).toEqual([{ id: result.id, version: 1, state: 'draft' }]);
        await detail(result.id, { ...created, state: 'draft', version: 1 });
        await verifyReceipt('social:campaign:create', body, result, campaigns, 'POST');
        expect(await trail(result.id)).toHaveLength(1);
        expect(await receipts()).toHaveLength(unchanged.length + 1);
      });
      expect(await campaignRow(primary.id)).toEqual(updated);
      expect(await campaignRow(other.id)).toEqual(originals[1]);
      expect(await campaignRow(paid.id)).toEqual(originals[2]);
      expect(await assetRow()).toEqual(originalAsset);
      expect(await connectionRow()).toEqual(originalConnection);
      expect(await credentials()).toEqual([]);
      expect(await providerWork()).toEqual(jobsBefore);
    });
    expect(writes).toHaveLength(12);
    expect(forbidden).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await store.close(); }
});

test('Ali @advisor-c6: separa cobro, sobrepago, reembolso y reversión del pedido exacto',async({page,context,request},info)=>{
  test.setTimeout(135000);
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate(),code=randomUUID().slice(0,8);
    const command=input=>({requestId:randomUUID(),...input});
    const product=await store.save('products',{...emptyRecord('products'),title:`Pago y reversión ${code}`,slug:`cobro-c6-${code}`,status:'draft',price:28000,presentation:'Unidad',orderable:true,stockQuantity:50},null,null,actor);
    const who=await saveResource(store,'people',command({name:`Responsable cobros ${code}`}),actor);
    const platform=await saveResource(store,'platforms',command({name:`Plataforma de recaudo ${code}`}),actor);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const prefix='/api/admin/business/actions/', calls=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()==='POST'&&path.startsWith(prefix))calls.push(path.slice(prefix.length));
    });
    const useAli=async(via,id,q,target)=>{
      if(via==='panel')return;
      await page.getByRole('dialog').getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
      let overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      if(via==='chat')await askAli(overlay,`¿Dónde está ${q}?`);
      else{
        await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
        await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await overlay.locator(`[data-capability-id="${id}"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
      await expect(overlay).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    };
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const account=await saveAccount(store,command({name:`Cuenta recaudo ${code} ${via}`,type:'cash',openingOn:day,openingBalanceMinor:9000000,responsibleId:who.id}),actor);
      const order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Pedido sintético ${code} ${via}`}),actor);
      const shipment=await createShipment(store,command({orderId:order.id,sourceId:source.id,platformId:platform.id,carrier:'Transporte sintético',tracking:`COBRO-${code}-${via}`}),actor);
      const stock=await store.get('products',product.id);
      const fetchOrder=()=>store.order(order.id);
      const entries=()=>store.db.all(`SELECT id,kind,amount_minor,reversal_of FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]);
      const before=await entries(), start=calls.length;
      const href=`/admin?section=orders&tab=list&record=${order.id}`;
      const number=`AN-${String(order.number).padStart(6,'0')}`;
      const editor=page.getByRole('dialog',{name:number,exact:true});
      const form=editor.locator('.business-action-form');
      const summary=editor.getByRole('heading',{name:'Cobros y devoluciones de dinero',exact:true});
      const panel=async()=>{
        const tabs=editor.getByRole('navigation',{name:'Detalle del pedido'});
        if(mobile)await tabs.getByRole('combobox',{name:'Detalle del pedido'}).selectOption('collections');
        else await tabs.getByRole('button',{name:'Cobros',exact:true}).click();
      };
      await page.goto(href);
      if(via==='panel')await panel();
      async function submit(action,title){
        const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===prefix+action,{timeout:10000});
        await form.getByRole('button',{name:title,exact:true}).click();
        const result=await response;
        expect(result.ok(),await result.text()).toBe(true);
        const receipt=await result.json(),payload=result.request().postDataJSON();
        expect(await ({collection:recordCollection,refund:recordRefund,'document-reverse':reverseFinancialDocument}[action])(store,payload,actor)).toEqual(receipt);
        await expect(summary).toBeVisible();
        return {receipt,payload};
      }
      async function record({id,q,type='collection',holder='business',amount,credit=false}){
        const title=type==='collection'?'Registrar cobro':'Registrar reembolso';
        const target=editor.getByRole('button',{name:title,exact:true}).filter({visible:true}).and(editor.locator('[data-advisor-control]'));
        const original=await fetchOrder(), ledger=await entries(), writeCount=calls.length;
        await useAli(via,id,q,target);
        await expect(summary).toBeVisible();
        await expect(form).toHaveCount(0);
        await target.click();
        const holderInput=form.locator('[name="holder"]');
        await expect(holderInput).toHaveValue('business');
        if(holder==='platform'){
          await holderInput.selectOption('platform');
          await form.locator('[name="shipmentId"]').selectOption(shipment.id);
        }else await form.locator('[name="accountId"]').selectOption(account.id);
        await form.locator('[name="occurredOn"]').fill(day);
        await form.getByLabel('Importe (COP)').fill(String(amount/100));
        await form.locator('[name="method"]').fill('Transferencia sintética');
        await form.locator('[name="reference"]').fill(`${type} ${holder} ${code}`);
        if(type==='refund')await form.getByLabel('Motivo').fill('Devolución comprobada de un sobrepago');
        else{
          const checkbox=form.getByRole('checkbox',{name:/Permitir cobro superior/});
          await form.getByText('Saldo a favor explícito',{exact:true}).click();
          await expect(checkbox).not.toBeChecked();
          if(credit)await useAli(via,'orders.record-collection-credit','autorizar sobrepago',checkbox);
          await expect(checkbox).not.toBeChecked();
          await expect(form.locator('[name="reference"]')).toHaveValue(`${type} ${holder} ${code}`);
          await checkbox.check();
          if(credit&&via==='directorio')await screenshot(page,info,'advisor-c6-cobro-saldo-a-favor');
        }
        expect(calls).toHaveLength(writeCount);
        expect(await fetchOrder()).toEqual(original);
        expect(await entries()).toEqual(ledger);
        const {receipt,payload}=await submit(type,title);
        expect(payload).toMatchObject({orderId:order.id,version:original.version,holder,amountMinor:amount});
        expect(receipt).toMatchObject({orderId:order.id,holder,amountMinor:amount,kind:type==='collection'?'receipt':'refund',cashEntryId:holder==='business'?expect.any(String):null});
        if(holder==='business'){
          const posted=(await entries()).find(row=>row.id===receipt.cashEntryId);
          expect(Number(posted.amount_minor)).toBe(type==='collection'?amount:-amount);
          expect(await entries()).toHaveLength(ledger.length+1);
        }else{
          expect(receipt.shipmentId).toBe(shipment.id);
          expect(await entries()).toEqual(ledger);
        }
        return receipt;
      }
      const received=await record({id:'orders.record-collection',q:'abono del cliente',amount:order.totalMinor+200000,credit:true});
      expect(received.order.paymentSummary.refundDueMinor).toBe(200000);
      const retained=await record({id:'orders.record-platform-collection',q:'recaudo de transportadora',amount:600000,holder:'platform'});
      const refunded=await record({id:'orders.record-refund',q:'dinero devuelto al cliente',type:'refund',amount:100000});
      const refundedByPlatform=await record({id:'orders.record-platform-refund',q:'reembolso de transportadora',type:'refund',amount:200000,holder:'platform'});
      expect(refundedByPlatform.order.paymentSummary.refundDueMinor).toBe(500000);
      async function undo(receipt,id,q,{many=false}={}){
        const refund=receipt.kind==='refund',label=refund?'reembolso':'cobro';
        const button=editor.getByRole('button',{name:`Revertir ${label}`,exact:true});
        const choice=many?editor.getByText(new RegExp(`^Hay varios ${label}s vigentes`)):button;
        const ledger=await entries(), version=(await fetchOrder()).version, writes=calls.length;
        if(id)await useAli(via,id,q,choice);
        await expect(form).toHaveCount(0);
        const amount=receipt.amountMinor/100,sourceLabel=receipt.holder==='business'?'Negocio':'Plataforma';
        const description=new RegExp(`^${refund?'Reembolso':'Cobro'} · \\$\\s*${new Intl.NumberFormat('es-CO').format(amount).replaceAll('.','[.,]')} · ${day} · ${sourceLabel}$`);
        await editor.getByRole('listitem').filter({has:page.getByText(description)}).getByRole('button',{name:`Revertir ${label}`,exact:true}).click();
        await form.locator('[name="effectiveOn"]').fill(day);
        await form.getByLabel('Motivo').fill(`Revisión del ${label} ya documentado`);
        expect(calls).toHaveLength(writes);
        expect(await entries()).toEqual(ledger);
        expect((await fetchOrder()).version).toBe(version);
        const result=await submit('document-reverse','Revertir documento');
        expect(result.payload).toMatchObject({documentId:receipt.id,documentType:refund?'refund':'collection'});
        expect(result.receipt).toMatchObject({reversalOf:receipt.id,cashEntryId:receipt.cashEntryId?expect.any(String):null});
        if(receipt.cashEntryId){
          const posted=(await entries()).find(row=>row.id===result.receipt.cashEntryId);
          expect(posted.reversal_of).toBe(receipt.cashEntryId);
          expect(Number(posted.amount_minor)).toBe(receipt.amountMinor*(refund?1:-1));
        }else expect(await entries()).toEqual(ledger);
      }
      await undo(refunded,'cash.reverse-refund','contrarregistrar reembolso',{many:true});
      await undo(refundedByPlatform);
      await undo(received,'cash.reverse-collection','revertir recibo de cliente',{many:true});
      const final=await fetchOrder();
      expect(final.paymentSummary.netCollectedMinor).toBe(retained.amountMinor);
      expect(final.returns).toEqual([]);
      expect(final.shipments).toEqual([expect.objectContaining({id:shipment.id,status:shipment.status,version:shipment.version})]);
      expect(await store.get('products',product.id)).toEqual(stock);
      expect((await entries()).reduce((sum,row)=>sum+Number(row.amount_minor),0)).toBe(before.reduce((sum,row)=>sum+Number(row.amount_minor),0));
      expect(calls.slice(start)).toEqual(['collection','collection','refund','refund','document-reverse','document-reverse','document-reverse']);
    });
  }finally{await store.close();}
});

async function c6SettlementFixture(context, store) {
  const actor = await fixtureActor(context, store), code = randomUUID().slice(0, 7), today = bogotaDate();
  const collectedOn = addC6ReportDays(today, -3), reportedOn = addC6ReportDays(today, -2);
  const payload = fields => ({ requestId: randomUUID(), ...fields });
  const platform = await saveResource(store, 'platforms', payload({ name: `Plataforma de liquidación ${code}` }), actor);
  const [source] = await listResources(store, 'sources', { platform: platform.id });
  const product = await store.save('products', { ...emptyRecord('products'), title: `Producto de liquidación ${code}`, slug: `liquidacion-${code}`, price: 100000, presentation: 'Unidad', status: 'draft', orderable: true, stockQuantity: 24 }, null, null, actor);
  async function shipmentFacts(suffix, expenses) {
    const tracking = `LIQ-${code}-${suffix}`;
    const order = await store.saveOrder(businessOrderInput(product, { placedOn: collectedOn, customerName: `Recaudo ${tracking}` }), actor);
    const shipment = await createShipment(store, payload({ orderId: order.id, platformId: platform.id, sourceId: source.id, carrier: 'Operador sintético', tracking }), actor);
    const collection = await recordCollection(store, payload({ orderId: order.id, version: (await store.order(order.id)).version, shipmentId: shipment.id, holder: 'platform', amountMinor: 11200000, occurredOn: collectedOn, method: 'Contraentrega', reference: `REC-${tracking}` }), actor);
    const deductions = [];
    for (const [concept, amountMinor, category = 'shipping_out'] of expenses) deductions.push(await recordExpense(store, payload({ category, concept: `${concept} ${tracking}`, amountMinor, incurredOn: collectedOn, shipmentId: shipment.id }), actor));
    return { tracking, order, shipment, collection, deductions };
  }
  const href = `/admin?section=cash&tab=settlements&period=month&anchor=${reportedOn}&source=${source.id}`;
  const snapshot = () => Promise.all([
    store.db.all(`SELECT * FROM ${store.t('settlements')} WHERE source_id=? ORDER BY id`, [source.id]),
    store.db.all(`SELECT r.* FROM ${store.t('settlement_receipts')} r JOIN ${store.t('settlements')} s ON s.id=r.settlement_id WHERE s.source_id=? ORDER BY r.id`, [source.id]),
    store.db.all(`SELECT p.* FROM ${store.t('expense_payments')} p JOIN ${store.t('settlement_receipts')} r ON r.id=p.settlement_receipt_id JOIN ${store.t('settlements')} s ON s.id=r.settlement_id WHERE s.source_id=? ORDER BY p.id`, [source.id]),
    store.db.all(`SELECT e.* FROM ${store.t('cash_entries')} e JOIN ${store.t('settlement_receipts')} r ON r.cash_entry_id=e.id JOIN ${store.t('settlements')} s ON s.id=r.settlement_id WHERE s.source_id=? ORDER BY e.id`, [source.id]),
  ]);
  return { actor, code, today, collectedOn, reportedOn, payload, source, href, shipmentFacts, snapshot };
}

function c6SettlementWrites(page) {
  const writes = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET' && /^\/api\/admin\/(business|finance)(?:\/|$)/.test(path)) writes.push(`${req.method()} ${path}`);
  });
  return writes;
}

async function c6SettlementFocus(page, via, id, query, target, drawer) {
  if (via === 'panel') return;
  let entry;
  if (drawer) {
    await drawer.getByRole('button', { name: 'Ayúdame con este formulario', exact: true }).click();
    entry = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
  } else entry = await openAli(page);
  if (via === 'chat') await askAli(entry, `¿Dónde está ${query}?`);
  else {
    await entry.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
    entry = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await entry.getByLabel('Área').selectOption('cash');
    await entry.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await entry.getByRole('button', { name: 'Buscar', exact: true }).click();
  }
  await entry.locator(`[data-capability-id="${id}"]`).getByRole('button', { name: /^Abrir en el panel:/ }).click({ timeout: 9000 });
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
}

async function c6SettlementCommit({ page, context, store, fixture, writes, count, before, action, submit }) {
  const path = `/api/admin/business/actions/${action}`;
  expect(writes).toHaveLength(count);
  expect(await fixture.snapshot()).toEqual(before);
  const response = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === path);
  await submit.click();
  const saved = await response, sent = saved.request(), body = sent.postDataJSON();
  expect(saved.status(), await saved.text()).toBe(200);
  const result = await saved.json();
  expect(writes.slice(count)).toEqual([`POST ${path}`]);
  const after = await fixture.snapshot();
  const replay = await context.request.post(saved.url(), { data: body, headers: { origin: await sent.headerValue('origin'), 'x-csrf-token': await sent.headerValue('x-csrf-token') } });
  expect(replay.status(), await replay.text()).toBe(200);
  expect(await replay.json()).toEqual(result);
  const commands = await store.db.all(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [action === 'document-reverse' ? 'financial:reverse' : action, body.requestId]);
  expect(commands).toHaveLength(1);
  expect(commands[0].actor_id).toBe(fixture.actor);
  expect(JSON.parse(commands[0].result_json)).toEqual(result);
  expect(await fixture.snapshot()).toEqual(after);
  return { body, result, after };
}

async function c6SettlementProof(page, id, reference) {
  await page.getByRole('button', { name: 'Ver liquidación registrada', exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('record') === id);
  await expect(page.getByRole('heading', { name: `Detalle · ${reference}`, exact: true })).toBeVisible();
}

test('Ali @advisor-c6: busca y edita cobros y gastos en el mismo borrador; declara y corrige sin recepción', async ({ page, context, request }, info) => {
  test.setTimeout(240000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(testDatabaseEnv());
  try {
    const fixture = await c6SettlementFixture(context, store), { href, source, collectedOn, reportedOn, today } = fixture;
    const main = await fixture.shipmentFacts('principal', [['Flete principal', 700000], ['Recargo auxiliar', 400000, 'platform_fee']]);
    const second = await fixture.shipmentFacts('alterno', [['Flete alterno', 350000]]);
    const [freight, surcharge] = main.deductions;
    const writes = c6SettlementWrites(page);
    const register = page.locator('[aria-label="Acciones de caja"]').getByRole('button', { name: 'Registrar liquidación', exact: true });
    const correction = page.getByRole('button', { name: 'Completar o corregir declaración', exact: true });
    const lineData = [{ collectionId: main.collection.id, grossMinor: 11200000, deductions: [{ expenseId: freight.id, amountMinor: 700000 }] }];
    const candidateSearchLabel = 'Buscar por pedido, guía o concepto';
    async function findCandidates(disclosure, type, query, collection) {
      const pending = page.waitForResponse(response => {
        const url = new URL(response.url()), params = url.searchParams;
        return url.pathname === '/api/admin/finance/settlements' && params.get('candidates') === type && params.get('source') === source.id && params.get('q') === query && params.get('collection') === (collection || null);
      });
      await disclosure.getByRole('textbox', { name: candidateSearchLabel, exact: true }).fill(query);
      const response = await pending;
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).records;
    }
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const before = await fixture.snapshot(), count = writes.length;
      const reference = `DECL-${fixture.code}-${via}`;
      await page.goto(href);
      await expect(page.getByRole('region', { name: 'Liquidaciones', exact: true })).toBeVisible();
      const origin = page.url();
      await c6SettlementFocus(page, via, 'cash.declare-settlement', 'registrar liquidación', register);
      await register.click();
      const drawer = page.getByRole('dialog', { name: 'Registrar liquidación', exact: true });
      const selectedSource = drawer.getByLabel(/^Cuenta de plataforma/), declaredDate = drawer.getByLabel('Fecha declarada', { exact: true }), declarationRef = drawer.getByLabel(/^Referencia de liquidación/);
      await expect(selectedSource).toHaveValue(source.id);
      await declaredDate.fill(reportedOn);
      await declarationRef.fill(reference);
      const originalDrawer = await drawer.elementHandle();
      async function sameDraft() {
        await expect(page).toHaveURL(origin);
        expect(await drawer.evaluate((node, previous) => node === previous, originalDrawer)).toBe(true);
        await expect(selectedSource).toHaveValue(source.id);
        await expect(declaredDate).toHaveValue(reportedOn);
        await expect(declarationRef).toHaveValue(reference);
        expect(writes).toHaveLength(count);
      }
      const group = drawer.getByRole('heading', { name: 'Cobros y gastos del borrador', exact: true });
      const line = facts => drawer.getByRole('region', { name: new RegExp(facts.tracking) });
      const collectionPicker = drawer.locator('details').filter({ has: page.getByText('Buscar y añadir cobro', { exact: true }) });
      const collectionResults = collectionPicker.getByRole('region', { name: 'Cobros elegibles', exact: true });
      const mainCollection = collectionResults.getByRole('listitem').filter({ hasText: main.tracking });
      const expensePicker = (facts = main) => line(facts).locator('details').filter({ has: page.getByText('Buscar y añadir gasto o crédito', { exact: true }) });
      const add = (list, text) => list.getByRole('listitem').filter({ hasText: text }).getByRole('button', { name: 'Añadir', exact: true });
      await test.step('cash.search-settlement-collections', async () => {
        if (via === 'panel') await collectionPicker.getByText('Buscar y añadir cobro', { exact: true }).click();
        await c6SettlementFocus(page, via, 'cash.search-settlement-collections', 'buscar recaudo de plataforma', collectionPicker.getByRole('textbox', { name: candidateSearchLabel, exact: true }), drawer);
        expect(await findCandidates(collectionPicker, 'collections', main.tracking)).toMatchObject([{ id: main.collection.id, sourceId: source.id, date: collectedOn, availableGrossMinor: 11200000 }]);
        await expect(mainCollection).toContainText(main.tracking);
        await expect(line(main)).toHaveCount(0);
        await sameDraft();
      });
      await test.step('cash.add-settlement-collection', async () => {
        await c6SettlementFocus(page, via, 'cash.add-settlement-collection', 'vincular cobro en liquidación', collectionResults, drawer);
        await add(collectionResults, main.tracking).click();
        await expect(line(main).getByRole('textbox', { name: 'Bruto declarado (COP)', exact: true })).not.toHaveValue('');
        await findCandidates(collectionPicker, 'collections', second.tracking);
        await add(collectionResults, second.tracking).click();
        await expect(line(second)).toBeVisible();
        await sameDraft();
      });
      await test.step('cash.search-settlement-expenses', async () => {
        await c6SettlementFocus(page, via, 'cash.search-settlement-expenses', 'buscar retención', group, drawer);
        await expensePicker().getByText('Buscar y añadir gasto o crédito', { exact: true }).click();
        expect(await findCandidates(expensePicker(), 'expenses', second.tracking, main.collection.id)).toEqual([]);
        expect(await findCandidates(expensePicker(), 'expenses', main.tracking, main.collection.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: freight.id, sourceId: source.id, date: collectedOn, availableMinor: 700000 }),
          expect.objectContaining({ id: surcharge.id, sourceId: source.id, date: collectedOn, availableMinor: 400000 }),
        ]));
        await expect(line(main).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(0);
        await sameDraft();
      });
      await test.step('cash.add-settlement-expense', async () => {
        const list = expensePicker().getByRole('region', { name: 'Gastos y créditos elegibles', exact: true });
        await c6SettlementFocus(page, via, 'cash.add-settlement-expense', 'vincular gasto en liquidación', group, drawer);
        await add(list, freight.concept).click();
        await expect(line(main).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(1);
        await add(list, surcharge.concept).click();
        await expect(line(main).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(2);
        await expect(line(second).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(0);
        await sameDraft();
      });
      await test.step('cash.remove-settlement-expense', async () => {
        await c6SettlementFocus(page, via, 'cash.remove-settlement-expense', 'quitar gasto en liquidación', group, drawer);
        await line(main).getByText(surcharge.concept, { exact: false }).filter({ hasNotText: 'Disponible' }).locator('..').getByRole('button', { name: 'Quitar gasto', exact: true }).click();
        await expect(line(main).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(1);
        await expect(line(main).getByRole('textbox', { name: 'Retención positiva / recuperación negativa (COP)', exact: true })).not.toHaveValue('');
        await sameDraft();
      });
      await test.step('cash.remove-settlement-collection', async () => {
        await expensePicker(second).getByText('Buscar y añadir gasto o crédito', { exact: true }).click();
        await findCandidates(expensePicker(second), 'expenses', second.tracking, second.collection.id);
        await add(expensePicker(second).getByRole('region', { name: 'Gastos y créditos elegibles', exact: true }), second.deductions[0].concept).click();
        await expect(line(second).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(1);
        await c6SettlementFocus(page, via, 'cash.remove-settlement-collection', 'quitar cobro de liquidación', group, drawer);
        await line(second).getByRole('button', { name: 'Quitar cobro y sus gastos', exact: true }).click();
        await expect(line(second)).toHaveCount(0);
        await expect(line(main).getByRole('button', { name: 'Quitar gasto', exact: true })).toHaveCount(1);
        await sameDraft();
      });
      await drawer.getByRole('textbox', { name: 'Neto declarado (COP)', exact: true }).fill('104000');
      await c6SettlementFocus(page, via, 'cash.declare-settlement', 'registrar liquidación', selectedSource, drawer);
      await sameDraft();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const saved = await c6SettlementCommit({ page, context, store, fixture, writes, count, before, action: 'settlement-save', submit: drawer.getByRole('button', { name: 'Registrar liquidación', exact: true }) });
      expect(saved.body).not.toHaveProperty('settlementId');
      expect(saved.body).toMatchObject({ version: 1, sourceId: source.id, reportedOn, externalKey: reference, netMinor: 10400000, lines: lineData });
      expect(saved.result).toMatchObject({ version: 1, state: 'pending', reconciliationRequired: true, receipts: [] });
      expect(saved.after.slice(1)).toEqual(before.slice(1));
      await expect(drawer).toHaveCount(0);
      await c6SettlementProof(page, saved.result.id, reference);
      await expect(page.getByText(/Requiere conciliación:/)).toBeVisible();
      const corrected = page.getByRole('dialog', { name: 'Completar o corregir declaración', exact: true });
      await test.step('cash.correct-settlement', async () => {
        const editOrigin = page.url(), editCount = writes.length;
        await c6SettlementFocus(page, via, 'cash.correct-settlement', 'corregir liquidación', correction);
        await correction.click();
        const reason = corrected.getByLabel(/^Motivo/);
        await expect(corrected.getByLabel(/^Cuenta de plataforma/)).toHaveValue(source.id);
        await expect(corrected.getByLabel('Fecha declarada', { exact: true })).toHaveValue(reportedOn);
        await expect(corrected.getByLabel(/^Referencia de liquidación/)).toHaveValue(reference);
        await expect(corrected.getByRole('region', { name: new RegExp(main.tracking) })).toBeVisible();
        await corrected.getByRole('textbox', { name: 'Neto declarado (COP)', exact: true }).fill('105000');
        await corrected.getByLabel('Fecha declarada', { exact: true }).fill(today);
        await reason.fill('Completar conciliación con soporte sintético');
        const sameEditor = await corrected.elementHandle();
        await c6SettlementFocus(page, via, 'cash.correct-settlement', 'corregir liquidación', reason, corrected);
        await expect(page).toHaveURL(editOrigin);
        expect(await corrected.evaluate((node, previous) => node === previous, sameEditor)).toBe(true);
        await expect(reason).toHaveValue('Completar conciliación con soporte sintético');
        const result = await c6SettlementCommit({ page, context, store, fixture, writes, count: editCount, before: saved.after, action: 'settlement-save', submit: corrected.getByRole('button', { name: 'Guardar corrección de la declaración', exact: true }) });
        expect(result.body).toMatchObject({ settlementId: saved.result.id, version: saved.result.version, sourceId: source.id, externalKey: reference, reportedOn: today, netMinor: 10500000, lines: lineData, reason: 'Completar conciliación con soporte sintético' });
        expect(result.result).toMatchObject({ id: saved.result.id, reportedOn: today, sourceId: source.id, externalId: reference, state: 'pending', reconciliationRequired: false, receipts: [], lines: lineData });
        expect(result.result.version).toBeGreaterThan(saved.result.version);
        expect(result.after.slice(1)).toEqual(saved.after.slice(1));
        await expect(corrected).toHaveCount(0);
        await c6SettlementProof(page, saved.result.id, reference);
        await expect(page.getByText(/Requiere conciliación:/)).toHaveCount(0);
      });
    });
  } finally {
    await store.close();
  }
});
const c6AliSettingsApi = '/api/admin/assistant/settings';
const c6AliFixtureKey = 'assistant-fixture-only';
const c6AliSettingsForm = page => page.getByRole('region', { name: 'Ali · asistente conversacional', exact: true });
const c6AliStatus = page => c6AliSettingsForm(page).locator('dl[aria-label="Estado de conexión de Ali"]');
const c6AliField = (page, name) => c6AliSettingsForm(page).locator(`[name="${name}"]`);
const c6AliButton = (page, name) => c6AliSettingsForm(page).getByRole('button', { name, exact: true });
const c6AliActions = {
  status: ['status', 'estado del proveedor de ali', 'Consultar la configuración y verificación de Ali'],
  save: ['save', 'guardar proveedor desactivado', 'Guardar opciones de Ali sin habilitarlo'],
  verify: ['verify', 'guardar y verificar ali', 'Habilitar Ali con una conexión verificada'],
  key: ['key', 'api key de ali', 'Configurar o cambiar la clave del proveedor de Ali'],
  clear: ['clear-key', 'eliminar clave de ali', 'Retirar la clave guardada y apagar Ali'],
  discard: ['discard', 'descartar borrador de proveedor', 'Descartar cambios de configuración de Ali'],
};

async function c6AliOpenFixtureStore(info) {
  const env = testDatabaseEnv(), app = new URL(info.project.use.baseURL);
  if (app.protocol !== 'https:' || app.hostname !== 'localhost' || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) {
    throw new Error('La evidencia de configuración de Ali requiere HTTPS local y PostgreSQL descartable con TLS verificado.');
  }
  if (![controlURL, baseURL].every(value => {
    if (!value) return false;
    const endpoint = new URL(value);
    return ['http:', 'https:'].includes(endpoint.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash;
  })) {
    throw new Error('La prueba solo verifica el proveedor sintético local.');
  }
  return openStore(env);
}

async function c6AliLoginFixture(page, request, store, info) {
  const existing = await store.db.get(`SELECT data FROM ${store.t('assistant_settings')} WHERE id=1`);
  const oauth = await store.db.get(`SELECT id FROM ${store.t('assistant_oauth_credentials')} WHERE id=1`);
  const prior = JSON.parse(existing?.data || '{}');
  if (oauth || (prior.provider && (prior.provider !== 'openai-compatible' || prior.baseUrl !== baseURL || prior.authMethod === 'oauth'))) {
    throw new Error('No se sustituye una configuración ajena al proveedor sintético ni se toca autorización OAuth.');
  }
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
}

async function c6AliPublic(response) {
  expect(response.ok()).toBe(true);
  const body = await response.text();
  expect(body.includes(c6AliFixtureKey)).toBe(false);
  const dto = JSON.parse(body);
  expect(Object.keys(dto).sort()).toEqual(['allowPrivateNetwork','authMethod','baseUrl','connectionStatus','enabled','hasApiKey','hasOAuthConnection','model','projectId','provider','verifiedAt','version']);
  return dto;
}

async function c6AliSettingsSnapshot(page, store) {
  const [response, stored, receipts, audit] = await Promise.all([
    page.request.get(c6AliSettingsApi),
    store.db.get(`SELECT version,(api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL) AS sealed,(api_key_ciphertext IS NULL AND api_key_iv IS NULL AND api_key_tag IS NULL) AS empty FROM ${store.t('assistant_settings')} WHERE id=1`),
    store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('business_requests')} WHERE scope='assistant:settings'`),
    store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('business_audit')} WHERE entity_type='assistant:settings' AND entity_id='1'`),
  ]);
  expect(response.headers()['cache-control']).toBe('no-store');
  const dto = await c6AliPublic(response);
  expect(Number(stored.version)).toBe(dto.version);
  expect(stored.sealed).toBe(dto.hasApiKey);
  expect(stored.empty).toBe(!dto.hasApiKey);
  return { dto, receipts: Number(receipts.total), audit: Number(audit.total) };
}

async function c6AliProviderRequests(request) {
  const response = await request.get(`${controlURL}/__control`, { headers: { Authorization: `Bearer ${c6AliFixtureKey}` } });
  expect(response.ok()).toBe(true);
  return (await response.json()).requests;
}

async function c6AliProviderChecks(request) {
  return (await c6AliProviderRequests(request)).filter(call => call.connectionCheck).map(({ model, authenticated }) => ({ model, authenticated }));
}

function c6AliObserveSettingsWrites(page) {
  const writes = [];
  page.on('request', req => {
    const { pathname } = new URL(req.url());
    if (req.method() !== 'GET' && (pathname === c6AliSettingsApi || pathname.startsWith('/api/admin/assistant/oauth'))) writes.push(`${req.method()} ${pathname}`);
  });
  return writes;
}

async function c6AliSettingsHandoff(page, action, source, target) {
  const [id, search, label] = action;
  let surface;
  if (source === 'chat') {
    surface = await openAli(page);
    await askAli(surface, `¿Dónde está ${search}?`);
  } else {
    const entry = source === 'home-directory'
      ? page.getByRole('button', { name: '¿Qué quieres hacer?', exact: true })
      : c6AliButton(page, '¿Qué quieres hacer?');
    await entry.click();
    surface = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await surface.getByRole('searchbox', { name: 'Buscar una acción', exact: true }).fill(search);
    await surface.getByRole('button', { name: 'Buscar', exact: true }).click();
  }
  const card = surface.locator(`[data-capability-id="assistant.settings-${id}"]`);
  await expect(card).toBeVisible({timeout:source==='chat'?30000:5000});
  if (source === 'chat') expect((await surface.innerText()).includes(c6AliFixtureKey)).toBe(false);
  await card.getByRole('button', { name: `Abrir en el panel: ${label}`, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/admin' && url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'assistant');
  await expect(surface).toBeHidden();
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport();
}

function c6AliClickSettingsSave(page, name) {
  return Promise.all([
    page.waitForResponse(res => new URL(res.url()).pathname === c6AliSettingsApi && res.request().method() === 'PUT'),
    c6AliButton(page, name).click(),
  ]).then(([response]) => response);
}

async function c6AliSettingsCommit(page, store, session, headers, response, before, expected) {
  const after = await c6AliPublic(response);
  const sent = response.request().postDataJSON();
  expect(sent.version).toBe(before.dto.version);
  expect(sent.authMethod).toBe('api-key');
  expect(sent.provider).toBe('openai-compatible');
  expect(sent.model).toBe('fixture-a');
  expect(sent.enabled).toBe(expected.enabled);
  expect(sent.clearApiKey).toBe(expected.clear);
  expect(Boolean(sent.apiKey)).toBe(Boolean(expected.newKey));
  expect(after).toMatchObject({ version: before.dto.version + 1, enabled: expected.enabled, hasApiKey: !expected.clear, authMethod: 'api-key', hasOAuthConnection: false, connectionStatus: expected.enabled ? 'ready' : 'unverified' });
  const persisted = { dto: after, receipts: before.receipts + 1, audit: before.audit + 1 };
  expect(await c6AliSettingsSnapshot(page, store)).toEqual(persisted);
  const receipt = await store.db.get(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope='assistant:settings' AND request_id=?`, [sent.requestId]);
  expect(receipt.actor_id).toBe(session.user.id);
  expect(receipt.result_json.includes(c6AliFixtureKey)).toBe(false);
  expect(JSON.parse(receipt.result_json)).toEqual(after);
  const repeated = await page.request.put(c6AliSettingsApi, { headers, data: sent });
  expect(await c6AliPublic(repeated)).toEqual(after);
  expect(await c6AliSettingsSnapshot(page, store)).toEqual(persisted);
  return persisted;
}

test('Ali @advisor-c6: configuración, lectura y traspaso al control exacto sin escribir', async ({ page, request }, info) => {
  test.setTimeout(180000);
  const store = await c6AliOpenFixtureStore(info);
  try {
    await c6AliLoginFixture(page, request, store, info);
    const before = await c6AliSettingsSnapshot(page, store), probes = await c6AliProviderChecks(request);
    const writes = c6AliObserveSettingsWrites(page);
    await page.goto('/admin?section=business&tab=setup');
    const nav = page.getByRole('navigation', { name: 'Vistas de configuración', exact: true });
    await nav.locator('summary').filter({ hasText: 'Más opciones de configuración' }).click();
    await nav.getByRole('button', { name: 'Configurar Ali', exact: true }).click();
    const status = c6AliStatus(page), provider = c6AliField(page, 'provider'), model = c6AliField(page, 'model');
    const method = c6AliField(page, 'authMethod'), key = c6AliField(page, 'apiKey');
    const enabled = c6AliField(page, 'enabled'), clear = c6AliField(page, 'clearApiKey');
    const verify = c6AliButton(page, 'Guardar y verificar'), discard = c6AliButton(page, 'Descartar cambios');
    await expect(status.getByText('OpenAI compatible', { exact: true })).toBeVisible();
    await expect(status.getByText('fixture-a', { exact: true })).toBeVisible();
    await expect(status.getByText('Clave API', { exact: true })).toBeVisible();
    await expect(status.getByText('Habilitado · Conexión verificada', { exact: true })).toBeVisible();
    await expect(status.getByText('Guardada; no se muestra', { exact: true })).toBeVisible();
    await expect(status.locator('time')).toHaveAttribute('datetime', before.dto.verifiedAt);
    await expect(provider).toHaveAccessibleName('Proveedor');
    await expect(method).toHaveAccessibleName('Método de autenticación');
    await expect(model).toHaveAccessibleName('Modelo');
    await expect(c6AliField(page, 'baseUrl')).toHaveAccessibleName('URL raíz de API');
    await expect(key).toHaveAccessibleName('Clave API');
    await expect(key).toHaveValue('');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(provider).toHaveValue('openai-compatible');
    await expect(method).toHaveValue('api-key');
    await expect(model).toHaveValue('fixture-a');
    await expect(enabled).toHaveAccessibleName('Habilitar Ali y verificar la conexión al guardar');
    await expect(clear).toHaveAccessibleName('Eliminar la clave guardada y deshabilitar Ali');
    await expect(method.locator('option[value="oauth"]')).toHaveAttribute('disabled','');
    await expect(c6AliField(page, 'allowPrivateNetwork')).toBeChecked();

    for (const [action, target] of [[c6AliActions.status,status], [c6AliActions.save,enabled], [c6AliActions.verify,verify], [c6AliActions.key,key], [c6AliActions.clear,clear]]) {
      await expect(target).toBeVisible();
      await page.goto('/admin');
      await c6AliSettingsHandoff(page, action, 'chat', target);
      await page.goto('/admin');
      await c6AliSettingsHandoff(page, action, 'home-directory', target);
      await expect(enabled).toBeChecked();
      await expect(clear).not.toBeChecked();
      await expect(key).toHaveValue('');
    }

    await provider.selectOption('gemini');
    await method.selectOption('oauth');
    await expect(c6AliField(page, 'projectId')).toHaveAccessibleName('Proyecto de Google Cloud');
    await expect(c6AliButton(page, 'Conectar cuenta de Google')).toBeDisabled();
    await expect(c6AliButton(page, 'Desconectar cuenta de Google')).toHaveCount(0);
    await expect(key).toHaveCount(0);
    await expect(verify).toBeDisabled();
    await model.fill('gemini-fixture-local');
    await expect(discard).toBeVisible();
    await c6AliSettingsHandoff(page, c6AliActions.discard, 'chat', discard);
    await c6AliSettingsHandoff(page, c6AliActions.discard, 'directory', discard);
    await expect(provider).toHaveValue('gemini');
    await expect(method).toHaveValue('oauth');
    await expect(model).toHaveValue('gemini-fixture-local');
    await expect(status.getByText('OpenAI compatible', { exact: true })).toBeVisible();
    await expect(status.getByText('Clave API', { exact: true })).toBeVisible();
    await expect(status.getByText('Habilitado · Conexión verificada', { exact: true })).toBeVisible();
    await expect(page.getByRole('group',{name:'Editar configuración de Ali',exact:true}).getByRole('status').filter({hasText:'Cambios sin guardar'})).toBeVisible();
    await expect(method.locator('option:checked')).toHaveText('Cuenta de Google');
    expect((await page.locator('body').innerText()).includes(c6AliFixtureKey)).toBe(false);
    const providerCalls = await c6AliProviderRequests(request);
    expect(providerCalls.some(call => call.tools.includes('find_action'))).toBe(true);
    expect(providerCalls.some(call => JSON.stringify(call.body).includes(c6AliFixtureKey))).toBe(false);
    expect(writes).toEqual([]);
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(before);
    expect(await c6AliProviderChecks(request)).toEqual(probes);
    await screenshot(page, info, 'advisor-c6-config-ali-foco');
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: guardar apagado, descartar, retirar custodia local y reactivar tras verificar', async ({ page, context, request }, info) => {
  test.setTimeout(120000);
  const store = await c6AliOpenFixtureStore(info);
  let session, headers, start;
  try {
    await c6AliLoginFixture(page, request, store, info);
    const token = (await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE)?.value;
    session = await getSession(store, token);
    headers = { Origin: new URL(page.url()).origin, 'x-csrf-token': session.csrf };
    start = await c6AliSettingsSnapshot(page, store);
    const probes = await c6AliProviderChecks(request), writes = c6AliObserveSettingsWrites(page);
    const enabled = c6AliField(page, 'enabled'), clear = c6AliField(page, 'clearApiKey'), key = c6AliField(page, 'apiKey');
    const method = c6AliField(page, 'authMethod'), model = c6AliField(page, 'model');
    const save = c6AliButton(page, 'Guardar configuración'), discard = c6AliButton(page, 'Descartar cambios');
    const status = c6AliStatus(page);
    const offRequest = { ...Object.fromEntries(['version','provider','baseUrl','model','authMethod','allowPrivateNetwork','projectId'].map(k => [k, start.dto[k]])), enabled: false, clearApiKey: false, requestId: randomUUID() };

    expect((await request.get(c6AliSettingsApi)).status()).toBe(401);
    expect((await request.put(c6AliSettingsApi, { data: offRequest })).status()).toBe(401);
    expect((await page.request.put(c6AliSettingsApi, { headers: { Origin: headers.Origin }, data: offRequest })).status()).toBe(403);
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(start);
    await enabled.uncheck();
    expect(writes).toEqual([]);
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(start);
    const off = await c6AliSettingsCommit(page, store, session, headers, await c6AliClickSettingsSave(page, 'Guardar configuración'), start, { enabled: false, clear: false });
    await expect(status.getByText('Deshabilitado · Pendiente de verificar', { exact: true })).toBeVisible();
    await expect(status.getByText('Guardada; no se muestra', { exact: true })).toBeVisible();
    await expect(status.locator('time')).toHaveCount(0);
    expect(off.dto.verifiedAt).toBeNull();
    expect((await page.request.put(c6AliSettingsApi, { headers, data: offRequest })).status()).toBe(409);
    expect(await c6AliProviderChecks(request)).toEqual(probes);
    expect(writes).toEqual([`PUT ${c6AliSettingsApi}`]);

    const chat = await openAli(page);
    await expect(chat.getByLabel('Mensaje para Ali')).toBeDisabled();
    await chat.getByRole('button', { name: 'Cerrar asistente', exact: true }).click();
    await c6AliSettingsHandoff(page, c6AliActions.status, 'directory', status);
    await c6AliSettingsHandoff(page, c6AliActions.save, 'directory', save);
    await c6AliSettingsHandoff(page, c6AliActions.key, 'directory', key);
    await key.fill('borrador-sintetico-no-guardado');
    await model.fill('fixture-b');
    await expect(method).toBeDisabled();
    await c6AliSettingsHandoff(page, c6AliActions.discard, 'directory', discard);
    await expect(model).toHaveValue('fixture-b');
    const rejected = page.waitForEvent('dialog').then(async dialog => { const valid = dialog.message() === '¿Descartar los cambios sin guardar?'; await dialog.dismiss(); return valid; });
    await discard.click();
    expect(await rejected).toBe(true);
    await expect(model).toHaveValue('fixture-b');
    expect(await key.evaluate(input => input.value.length > 0)).toBe(true);
    const accepted = page.waitForEvent('dialog').then(async dialog => { const valid = dialog.message() === '¿Descartar los cambios sin guardar?'; await dialog.accept(); return valid; });
    await discard.click();
    expect(await accepted).toBe(true);
    await expect(c6AliSettingsForm(page).getByText('Cambios descartados. La configuración guardada no cambió.', { exact: true })).toBeVisible();
    await expect(model).toHaveValue('fixture-a');
    await expect(key).toHaveValue('');
    await expect(method).toHaveValue('api-key');
    await expect(method).toBeEnabled();
    await expect(discard).toHaveCount(0);
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(off);
    expect(writes).toEqual([`PUT ${c6AliSettingsApi}`]);

    await c6AliSettingsHandoff(page, c6AliActions.clear, 'directory', clear);
    await expect(clear).not.toBeChecked();
    await clear.check();
    await expect(enabled).toBeDisabled();
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(off);
    expect(writes).toHaveLength(1);
    const removed = await c6AliSettingsCommit(page, store, session, headers, await c6AliClickSettingsSave(page, 'Guardar configuración'), off, { enabled: false, clear: true });
    await expect(c6AliSettingsForm(page).getByText(/^Clave eliminada de la custodia local/)).toBeVisible();
    await expect(status.getByText('No guardada', { exact: true })).toBeVisible();
    await expect(clear).toHaveCount(0);
    expect(await c6AliProviderChecks(request)).toEqual(probes);

    await c6AliSettingsHandoff(page, c6AliActions.verify, 'directory', enabled);
    await expect(enabled).not.toBeChecked();
    await enabled.check();
    await expect(key).toHaveAttribute('required', '');
    await c6AliButton(page, 'Guardar y verificar').click();
    expect(await key.evaluate(input => input.validity.valueMissing)).toBe(true);
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(removed);
    expect(writes).toHaveLength(2);
    await key.fill(c6AliFixtureKey);
    await control(request, { action: 'configure', model: 'fixture-a', behavior: { noTools: true } });
    const failed = await c6AliClickSettingsSave(page, 'Guardar y verificar');
    expect(failed.status()).toBe(422);
    expect((await failed.json()).code).toBe('ASSISTANT_MODEL_UNSUPPORTED');
    await expect(c6AliSettingsForm(page).getByRole('alert')).toContainText('El modelo no admite llamadas de función.');
    await expect(status.getByText('No guardada', { exact: true })).toBeVisible();
    expect(await c6AliSettingsSnapshot(page, store)).toEqual(removed);
    const checked = { model: 'fixture-a', authenticated: true };
    expect(await c6AliProviderChecks(request)).toEqual([...probes, checked]);

    await control(request, { action: 'configure', model: 'fixture-a', behavior: {} });
    const restored = await c6AliSettingsCommit(page, store, session, headers, await c6AliClickSettingsSave(page, 'Guardar y verificar'), removed, { enabled: true, clear: false, newKey: true });
    await expect(status.getByText('Habilitado · Conexión verificada', { exact: true })).toBeVisible();
    await expect(status.locator('time')).toHaveAttribute('datetime', restored.dto.verifiedAt);
    await expect(key).toHaveValue('');
    expect((await page.locator('body').innerText()).includes(c6AliFixtureKey)).toBe(false);
    expect(await c6AliProviderChecks(request)).toEqual([...probes, checked, checked]);
    expect(writes).toEqual(Array(4).fill(`PUT ${c6AliSettingsApi}`));
    await screenshot(page, info, 'advisor-c6-config-ali-verificada');
  } finally {
    try {
      if (start) {
        await control(request, { action: 'reset' });
        const { dto } = await c6AliSettingsSnapshot(page, store);
        if (!dto.enabled || !dto.hasApiKey || dto.connectionStatus !== 'ready') {
          const { provider, baseUrl, model, authMethod, allowPrivateNetwork, projectId } = start.dto;
          await c6AliPublic(await page.request.put(c6AliSettingsApi, { headers, data: {
            provider, baseUrl, model, authMethod, allowPrivateNetwork, projectId, version: dto.version,
            enabled: true, apiKey: c6AliFixtureKey, clearApiKey: false, requestId: randomUUID(),
          } }));
        }
      }
    } finally { await store.close(); }
  }
});

test('Ali @advisor-c6: confirma abonos, netos cero y negativos y revierte recibos sin duplicar asientos', async ({ page, context, request }, info) => {
  test.setTimeout(240000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(testDatabaseEnv());
  try {
    const fixture = await c6SettlementFixture(context, store), { actor, href, source, code, today, collectedOn, reportedOn, payload } = fixture;
    const yesterday = addC6ReportDays(today, -1);
    const person = await saveResource(store, 'people', payload({ name: `Operador de recibos ${code}` }), actor);
    const bank = await saveAccount(store, payload({ name: `Banco de recibos ${code}`, type: 'bank', openingOn: collectedOn, openingBalanceMinor: 20000000, responsibleId: person.id }), actor);
    const writes = c6SettlementWrites(page);
    const moneyRows = rows => rows.map(row => ({ ...row, amount_minor: Number(row.amount_minor) }));
    const ledger = async () => moneyRows(await store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`, [bank.id]));
    const declarationButton = page.getByRole('button', { name: 'Confirmar recepción o abono', exact: true });
    const confirmDrawer = page.getByRole('dialog', { name: 'Confirmar recepción', exact: true });
    const reversalDrawer = page.getByRole('dialog', { name: 'Revertir documento', exact: true });
    const makeLine = (facts, grossMinor, amountMinor) => ({ collectionId: facts.collection.id, grossMinor, deductions: [{ expenseId: facts.deductions[0].id, amountMinor }] });
    async function declaration(suffix, gross, deducted) {
      const facts = await fixture.shipmentFacts(suffix, [['Flete para recepción', deducted]]);
      const reference = `DECL-${code}-${suffix}`;
      const saved = await saveSettlement(store, payload({ sourceId: source.id, externalKey: reference, reportedOn, netMinor: gross - deducted, lines: [makeLine(facts, gross, deducted)] }), actor);
      return { facts, reference, saved };
    }
    async function openDeclaration(via, item) {
      await page.goto(via === 'panel' ? href : `${href}&record=${item.saved.id}`);
      if (via === 'panel') await page.locator(`[data-cash-record="${item.saved.id}"]`).click();
      await expect(page.getByRole('heading', { name: `Detalle · ${item.reference}`, exact: true })).toBeVisible();
    }
    async function showReceipt(item, receipt, label) {
      await c6SettlementProof(page, item.saved.id, item.reference);
      const cards = page.getByRole('region', { name: 'Recibos de la liquidación', exact: true });
      const row = cards.getByRole('article').filter({ hasText: `Referencia: ${receipt.externalId}` });
      await expect(row.getByRole('heading', { name: `${label} · ${receipt.receivedOn}`, exact: true })).toBeVisible();
      await expect(row.getByRole('heading', { name: new RegExp(item.facts.tracking) })).toBeVisible();
      return row;
    }
    async function receive(via, item, { id, query, version, date, gross, deducted, remainingNet, state, edit = false }) {
      return test.step(id, async () => {
        const before = await fixture.snapshot(), beforeLedger = await ledger(), count = writes.length, origin = page.url();
        const receiptRef = `REC-${item.reference}-${id.slice('cash.confirm-settlement-'.length)}`, netMinor = gross - deducted;
        await c6SettlementFocus(page, via, id, query, declarationButton);
        await expect(page).toHaveURL(origin);
        await expect(confirmDrawer).toHaveCount(0);
        await declarationButton.click();
        await expect(confirmDrawer.getByText(`Declaración ${item.reference} · ${reportedOn}`, { exact: true })).toBeVisible();
        await expect(confirmDrawer.getByRole('heading', { name: new RegExp(item.facts.tracking) })).toBeVisible();
        if (edit) {
          await confirmDrawer.getByRole('textbox', { name: 'Bruto asignado (COP)', exact: true }).fill(String(gross / 100));
          await confirmDrawer.locator('input[name="deduction-0-0"]').fill(String(deducted / 100));
        }
        const account = confirmDrawer.getByLabel(/^Cuenta de recepción/);
        await account.selectOption(netMinor === 0 ? '' : bank.id);
        await confirmDrawer.getByLabel(/^Fecha de recepción/).fill(date);
        await confirmDrawer.getByLabel('Referencia única del recibo', { exact: true }).fill(receiptRef);
        await expect(confirmDrawer.getByText(netMinor < 0 ? 'Registra una salida por el neto confirmado.' : netMinor === 0 ? 'Neto cero: no registra movimiento de dinero.' : 'Registra una entrada por el neto confirmado.', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await ledger()).toEqual(beforeLedger);
        const { body, result, after } = await c6SettlementCommit({ page, context, store, fixture, writes, count, before, action: 'settlement-confirm', submit: confirmDrawer.getByRole('button', { name: 'Confirmar recepción', exact: true }) });
        const lines = [makeLine(item.facts, gross, deducted)];
        expect(body).toMatchObject({ settlementId: item.saved.id, version, receivedOn: date, externalKey: receiptRef, lines });
        if (netMinor === 0) expect(body).not.toHaveProperty('accountId');
        else expect(body.accountId).toBe(bank.id);
        expect(result.receipt).toMatchObject({ settlementId: item.saved.id, sourceId: source.id, receivedOn: date, externalId: receiptRef, netMinor, lines });
        expect(result.settlement).toMatchObject({ id: item.saved.id, sourceId: source.id, reportedOn, remainingNetMinor: remainingNet, state });
        expect(result.settlement.version).toBe(version + 1);
        expect(result.settlement.remainingLines).toHaveLength(state === 'confirmed' ? 0 : 1);
        expect(after[1]).toHaveLength(before[1].length + 1);
        expect(moneyRows(after[2].filter(row => row.settlement_receipt_id === result.receipt.id))).toEqual([expect.objectContaining({ expense_id: item.facts.deductions[0].id, amount_minor: deducted, kind: 'payment', reversal_of: null })]);
        const entries = (await ledger()).filter(row => !beforeLedger.some(prior => prior.id === row.id));
        if (netMinor === 0) {
          expect(result.receipt.cashEntryId).toBeNull();
          expect(entries).toEqual([]);
        } else expect(entries).toEqual([expect.objectContaining({ id: result.receipt.cashEntryId, amount_minor: netMinor, effective_on: date, source_type: 'settlement_receipt', source_id: result.receipt.id, reversal_of: null })]);
        await expect(confirmDrawer).toHaveCount(0);
        await showReceipt(item, result.receipt, 'Recepción');
        return result;
      });
    }
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const positive = await declaration(`${via}-positiva`, 11200000, 700000);
      await openDeclaration(via, positive);
      const partial = await receive(via, positive, { id: 'cash.confirm-settlement-partial-receipt', query: 'confirmar recepción parcial', version: positive.saved.version, date: yesterday, gross: 5000000, deducted: 300000, remainingNet: 5800000, state: 'partial', edit: true });
      const full = await receive(via, positive, { id: 'cash.confirm-settlement-receipt', query: 'confirmar recepción completa', version: partial.settlement.version, date: today, gross: 6200000, deducted: 400000, remainingNet: 0, state: 'confirmed' });
      await test.step('cash.reverse-settlement-receipt', async () => {
        const count = writes.length, before = await fixture.snapshot(), beforeLedger = await ledger(), origin = page.url();
        const choices = page.getByRole('heading', { name: 'Recibos de la liquidación', exact: true });
        await c6SettlementFocus(page, via, 'cash.reverse-settlement-receipt', 'revertir abono de liquidación', choices);
        await expect(page).toHaveURL(origin);
        const rows = page.getByRole('region', { name: 'Recibos de la liquidación', exact: true }).getByRole('article');
        await expect(rows.getByRole('button', { name: 'Revertir este recibo', exact: true })).toHaveCount(2);
        await rows.filter({ hasText: `Referencia: ${partial.receipt.externalId}` }).getByRole('button', { name: 'Revertir este recibo', exact: true }).click();
        await expect(reversalDrawer.getByText(new RegExp(`${partial.receipt.externalId} · ${yesterday}`))).toBeVisible();
        const reason = 'Revertir únicamente el abono sintético';
        await reversalDrawer.getByLabel(/^Fecha de reversión/).fill(today);
        await reversalDrawer.getByLabel(/^Motivo/).fill(reason);
        expect(await ledger()).toEqual(beforeLedger);
        const { body, result, after } = await c6SettlementCommit({ page, context, store, fixture, writes, count, before, action: 'document-reverse', submit: reversalDrawer.getByRole('button', { name: 'Revertir documento', exact: true }) });
        expect(body).toMatchObject({ documentType: 'settlement_receipt', documentId: partial.receipt.id, version: 1, effectiveOn: today, reason });
        expect(result.receipt).toMatchObject({ reversalOf: partial.receipt.id, netMinor: -4700000, receivedOn: today, settlementId: positive.saved.id });
        expect(result.settlement).toMatchObject({ id: positive.saved.id, version: full.settlement.version + 1, state: 'partial', receivedNetMinor: 5800000, remainingNetMinor: 4700000, remainingLines: [makeLine(positive.facts, 5000000, 300000)] });
        expect(result.settlement.receipts).toEqual(expect.arrayContaining([partial.receipt, full.receipt, result.receipt]));
        expect(moneyRows(after[2].filter(row => row.settlement_receipt_id === result.receipt.id))).toEqual([expect.objectContaining({ kind: 'reversal', amount_minor: -300000, reversal_of: before[2].find(row => row.settlement_receipt_id === partial.receipt.id).id })]);
        expect((await ledger()).filter(row => !beforeLedger.some(prior => prior.id === row.id))).toEqual([expect.objectContaining({ id: result.receipt.cashEntryId, amount_minor: -4700000, effective_on: today, reversal_of: partial.receipt.cashEntryId })]);
        await expect(reversalDrawer).toHaveCount(0);
        const reversed = await showReceipt(positive, partial.receipt, 'Recibo revertido');
        await expect(reversed.getByRole('button', { name: 'Revertir este recibo', exact: true })).toHaveCount(0);
        await expect(rows.filter({ hasText: `Referencia: ${full.receipt.externalId}` }).getByRole('button', { name: 'Revertir este recibo', exact: true })).toBeVisible();
      });
      const zero = await declaration(`${via}-cero`, 700000, 700000);
      await openDeclaration(via, zero);
      await receive(via, zero, { id: 'cash.confirm-settlement-zero-net', query: 'liquidación neto cero', version: zero.saved.version, date: today, gross: 700000, deducted: 700000, remainingNet: 0, state: 'confirmed' });
      const negative = await declaration(`${via}-negativa`, 400000, 700000);
      await openDeclaration(via, negative);
      await receive(via, negative, { id: 'cash.confirm-settlement-negative-net', query: 'recepción de neto negativo', version: negative.saved.version, date: yesterday, gross: 400000, deducted: 700000, remainingNet: 0, state: 'confirmed' });
      await test.step('cash.reverse-settlement', async () => {
        const item = await declaration(`${via}-reversion-total`, 11200000, 700000);
        const noCash = await confirmSettlement(store, payload({ settlementId: item.saved.id, version: item.saved.version, receivedOn: yesterday, externalKey: `REC-Z-${item.reference}`, lines: [makeLine(item.facts, 300000, 300000)] }), actor);
        const withCash = await confirmSettlement(store, payload({ settlementId: item.saved.id, version: noCash.settlement.version, receivedOn: today, accountId: bank.id, externalKey: `REC-P-${item.reference}`, lines: [makeLine(item.facts, 10900000, 400000)] }), actor);
        await openDeclaration(via, item);
        const count = writes.length, before = await fixture.snapshot(), beforeLedger = await ledger(), origin = page.url();
        const reverseAll = page.getByRole('button', { name: 'Revertir liquidación completa', exact: true });
        await c6SettlementFocus(page, via, 'cash.reverse-settlement', 'revertir liquidación completa', reverseAll);
        await expect(page).toHaveURL(origin);
        await reverseAll.click();
        await expect(reversalDrawer.getByText(`Declaración ${item.reference} · ${reportedOn}`, { exact: true })).toBeVisible();
        const reason = 'Revertir la recepción sintética completa';
        await reversalDrawer.getByLabel(/^Fecha de reversión/).fill(today);
        await reversalDrawer.getByLabel(/^Motivo/).fill(reason);
        expect(await ledger()).toEqual(beforeLedger);
        const { body, result, after } = await c6SettlementCommit({ page, context, store, fixture, writes, count, before, action: 'document-reverse', submit: reversalDrawer.getByRole('button', { name: 'Revertir documento', exact: true }) });
        expect(body).toMatchObject({ documentType: 'settlement', documentId: item.saved.id, version: withCash.settlement.version, effectiveOn: today, reason });
        expect(result).toMatchObject({ id: item.saved.id, sourceId: source.id, reportedOn, state: 'pending', version: withCash.settlement.version + 2, receivedNetMinor: 0, remainingNetMinor: 10500000, lines: item.saved.lines });
        expect(result.receipts).toHaveLength(4);
        const reversedZero = result.receipts.find(row => row.reversalOf === noCash.receipt.id), reversedPayment = result.receipts.find(row => row.reversalOf === withCash.receipt.id);
        expect(reversedZero).toMatchObject({ netMinor: 0, cashEntryId: null });
        expect(reversedPayment).toMatchObject({ netMinor: -10500000, receivedOn: today });
        const paymentIds = new Set([reversedZero.id, reversedPayment.id]);
        expect(moneyRows(after[2].filter(row => paymentIds.has(row.settlement_receipt_id)))).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'reversal', expense_id: item.facts.deductions[0].id, amount_minor: -300000, settlement_receipt_id: reversedZero.id }),
          expect.objectContaining({ kind: 'reversal', expense_id: item.facts.deductions[0].id, amount_minor: -400000, settlement_receipt_id: reversedPayment.id }),
        ]));
        expect((await ledger()).filter(row => !beforeLedger.some(prior => prior.id === row.id))).toEqual([expect.objectContaining({ id: reversedPayment.cashEntryId, amount_minor: -10500000, reversal_of: withCash.receipt.cashEntryId, effective_on: today })]);
        await expect(reversalDrawer).toHaveCount(0);
        await showReceipt(item, noCash.receipt, 'Recibo revertido');
        const receiptRows = page.getByRole('region', { name: 'Recibos de la liquidación', exact: true });
        await expect(receiptRows.getByRole('heading', { name: `Reversión · ${today}`, exact: true })).toHaveCount(2);
        await expect(receiptRows.getByRole('button', { name: 'Revertir este recibo', exact: true })).toHaveCount(0);
        await expect(reverseAll).toHaveCount(0);
      });
    });
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: distingue costo histórico, devolución y gasto del pedido sin confundir Caja',async({page,context,request},info)=>{
  test.setTimeout(125000);
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate(),marker=randomUUID().slice(0,8);
    const cmd=input=>({requestId:randomUUID(),...input});
    const product=await store.save('products',{...emptyRecord('products'),title:`Venta privada ${marker}`,slug:`rentabilidad-${marker}`,status:'draft',price:34000,presentation:'Unidad',orderable:true,stockQuantity:24,unitCostMinor:1100000,costEffectiveOn:day},null,null,actor);
    const responsible=await saveResource(store,'people',cmd({name:`Responsable de Caja ${marker}`}),actor);
    const prefix='/api/admin/business/actions/', writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/\/api\/admin\/(?:finance|business)\//.test(req.url()))writes.push(new URL(req.url()).pathname);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const account=await saveAccount(store,cmd({name:`Caja costo ${marker} ${via}`,type:'cash',openingOn:day,openingBalanceMinor:9000000,responsibleId:responsible.id}),actor);
      const order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Rentabilidad privada ${marker} ${via}`}),actor);
      const href=`/admin?section=orders&tab=list&record=${order.id}`;
      const editor=page.getByRole('dialog',{name:`AN-${String(order.number).padStart(6,'0')}`,exact:true});
      const form=editor.locator('.business-action-form');
      const summary=editor.getByRole('heading',{name:'Acumulado del pedido',exact:true});
      const ctrl=name=>editor.locator(`[data-advisor-control="${name}"]`);
      const fetchOrder=()=>store.order(order.id);
      const entries=()=>store.db.all(`SELECT id,kind,amount_minor,source_id FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`,[account.id]);
      async function handoff(id,query,target){
        if(via==='panel')return;
        await editor.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        if(via==='chat')await askAliCatalog(overlay,`¿Dónde está ${query}?`);
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(overlay).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
      }
      async function submit(action,title,service){
        const wait=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===prefix+action);
        await form.getByRole('button',{name:title,exact:true}).click();
        const response=await wait, payload=response.request().postDataJSON();
        expect(response.ok(),await response.text()).toBe(true);
        const result=await response.json();
        expect(await service(store,payload,actor)).toEqual(result);
        await expect(summary).toBeVisible();
        return {payload,result};
      }
      await page.goto(href);
      if(via==='panel'){
        const tabs=editor.getByRole('navigation',{name:'Detalle del pedido'});
        if(mobile)await tabs.getByRole('combobox',{name:'Detalle del pedido'}).selectOption('profit');
        else await tabs.getByRole('button',{name:'Rentabilidad',exact:true}).click();
      }
      const baseline=await entries(), noWrite=writes.length, before=await fetchOrder();
      await handoff('orders.complete-costs','corregir costo del pedido',ctrl('order-historical-costs'));
      await ctrl('order-historical-costs').click();
      await form.getByRole('checkbox',{name:product.title,exact:true}).check();
      await form.getByLabel('Costo unitario histórico (COP)').fill('12500');
      await form.getByLabel('Motivo').fill('Costo de factura de la fecha de la venta');
      expect(writes).toHaveLength(noWrite);
      expect(await fetchOrder()).toEqual(before);
      const cost=await submit('complete-costs','Completar o corregir costos',completeOrderCosts);
      expect(cost.payload).toMatchObject({orderId:order.id,version:before.version,lineCosts:[{lineId:before.items[0].lineId,unitCostMinor:1250000}]});
      expect((await fetchOrder()).items[0]).toMatchObject({unitPriceMinor:3400000,unitCostMinor:1250000});
      expect(await entries()).toEqual(baseline);
      const afterCost=await fetchOrder();
      await handoff('orders.record-return','devolución comercial',ctrl('order-return-form'));
      await ctrl('order-return-form').click();
      await form.getByLabel('Fecha de devolución').fill(day);
      await form.getByLabel('Cantidad a devolver').fill('1');
      await form.getByLabel('Condición').selectOption('recoverable');
      await form.getByLabel('Motivo').fill('Mercancía inspeccionada en devolución sintética');
      expect(writes).toHaveLength(noWrite+1);
      expect(await fetchOrder()).toEqual(afterCost);
      const returned=await submit('return','Registrar devolución',registerReturn);
      expect(returned.payload).toMatchObject({orderId:order.id,version:afterCost.version,occurredOn:day});
      expect(returned.result.lines).toEqual([expect.objectContaining({lineId:before.items[0].lineId,quantity:1,condition:'recoverable',salesCreditMinor:3400000,recoveredCostMinor:1250000})]);
      expect((await fetchOrder()).returns.map(value=>value.id)).toEqual([returned.result.id]);
      expect((await fetchOrder()).collections).toEqual([]);
      expect(await entries()).toEqual(baseline);
      for(const pay of [false,true]){
        const id=pay?'orders.record-and-pay-expense':'orders.record-expense';
        const query=pay?'pagado ahora en el pedido':'gasto pendiente del pedido';
        const choice=pay?'order-expense-pay-now':'order-expense-pending';
        await handoff(id,query,ctrl('order-expense-launch'));
        await ctrl('order-expense-launch').click();
        const concept=`Gasto ${pay?'pagado':'pendiente'} ${marker} ${via}`;
        await form.getByRole('textbox',{name:/^Concepto/}).fill(concept);
        await form.getByLabel('Importe (COP)').fill('2300');
        await form.getByLabel('Fecha del gasto').fill(day);
        await handoff(id,query,ctrl(choice));
        await expect(ctrl('order-expense-pending')).toBeChecked();
        await expect(form.getByRole('textbox',{name:/^Concepto/})).toHaveValue(concept);
        if(pay){
          await ctrl(choice).check();
          await form.getByLabel('Cuenta de pago').selectOption(account.id);
          await form.getByLabel('Fecha del pago').fill(day);
        }
        expect(await entries()).toEqual(baseline);
        if(pay&&via==='directorio')await screenshot(page,info,'advisor-c6-pedido-gasto-pagado');
        const expense=await submit('expense',pay?'Registrar gasto y pago':'Guardar gasto pendiente',recordExpense);
        expect(expense.result).toMatchObject({orderId:order.id,concept,amountMinor:230000,outstandingMinor:pay?0:230000});
        const ledger=await entries();
        if(pay){
          expect(ledger.filter(entry=>baseline.some(original=>original.id===entry.id))).toEqual(baseline);
          const posted=ledger.filter(entry=>!baseline.some(original=>original.id===entry.id));
          const payments=await store.db.all(`SELECT id,cash_entry_id FROM ${store.t('expense_payments')} WHERE expense_id=?`,[expense.result.id]);
          expect(payments).toEqual([{id:posted[0]?.source_id,cash_entry_id:posted[0]?.id}]);
          expect(posted.map(entry=>[entry.kind,Number(entry.amount_minor)])).toEqual([['expense_payment',-230000]]);
        }else expect(ledger).toEqual(baseline);
      }
      expect(writes.slice(noWrite)).toEqual(['complete-costs','return','expense','expense'].map(action=>prefix+action));
      expect((await store.get('products',product.id)).unitCostMinor).toBe(1100000);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: deja al operador clasificar una devolución del día del conteo físico',async({page,context,request},info)=>{
  test.setTimeout(110000);
  await loginWithAdvisorFixture(page,request);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear(),openingOn=`${year}-10-01`;
    const marker=randomUUID().slice(0,8),cmd=input=>({requestId:randomUUID(),...input});
    const writes=[];
    page.on('request',req=>{
      if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/admin/business/actions/return')writes.push(req.postDataJSON());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const platform=await saveResource(store,'platforms',cmd({name:`Origen histórico ${marker} ${via}`}),actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const product=await store.save('products',{...emptyRecord('products'),title:`Producto histórico ${marker} ${via}`,slug:`apertura-${marker}-${via}`,status:'draft',orderable:true,presentation:'Unidad',price:55000,unitCostMinor:2000000,costEffectiveOn:`${year}-09-01`,stockQuantity:10},null,null,actor);
      let batch=await createImportBatch(store,cmd({sourceId:source.id}),actor);
      const sheets=workbookOnboardingSheets({year,pending:true});
      for(const row of sheets.find(sheet=>sheet.name==='ENVIOS').rows.slice(1))row[3]=`${row[3]}-${marker}-${via}`;
      const {id:batchId}=batch;
      // The scheduler may already own this batch. Wait for the persisted result, not one worker turn.
      async function settleImport(state,phase=state){
        await expect.poll(async()=>{
          await processImportTurn(store,{batchId,...(phase==='inspect'?{expectedPhase:phase}:{})});
          batch=await getImportBatch(store,batchId);
          if(batch.error&&['review','failed'].includes(batch.state))throw new Error(`${phase}: ${JSON.stringify(batch.error)}`);
          return batch.state;
        },{timeout:20000,message:`El lote sintético ${batchId} debe completar ${phase}`}).toBe(state);
      }
      await uploadImportFile(store,batchId,cmd({version:batch.version,filename:'apertura.xlsx',bytes:writeExcelSheets(sheets)}),actor);
      await settleImport('review','inspect');
      expect(batch.workbook).toBeTruthy();
      batch=await updateImportBatch(store,batch.id,cmd({version:batch.version,config:workbookOnboardingConfig({year}),inventoryOpening:{on:openingOn,confirmed:true},resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:product.id}]}),actor);
      await requestImportPreview(store,batch.id,cmd({version:batch.version}),actor);
      await settleImport('review','preview');
      const groups=batch.preview.groups.filter(group=>group.errors.some(error=>error.code==='IMPORT_POLICY_REQUIRED'));
      if(groups.length){
        const settings=await getBusinessSettings(store);
        const rule=settings.rulesVersions.at(-1);
        expect(rule?.id).toBeTruthy();
        batch=await updateImportBatch(store,batch.id,cmd({version:batch.version,resolutions:groups.map(group=>({action:'review_policy',entityKey:group.key,value:{ruleVersionId:rule.id},reason:'Política revisada para la apertura sintética'}))}),actor);
        await requestImportPreview(store,batch.id,cmd({version:batch.version}),actor);
        await settleImport('review','preview');
      }
      expect(batch.preview.groups.flatMap(group=>group.errors)).toEqual([]);
      await commitImport(store,batch.id,cmd({version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false}),actor);
      await settleImport('completed','apply');
      const link=await store.db.get(`SELECT internal_id FROM ${store.t('external_links')} WHERE source_id=? AND entity_type='order' AND external_key='ORDER-A'`,[source.id]);
      const fetchOrder=()=>store.order(link.internal_id);
      const order=await fetchOrder(),stock=()=>store.get('products',product.id),originalStock=await stock();
      expect(order.inventoryOpening).toMatchObject({on:openingOn,batchId:batch.id,returnClassifications:[]});
      expect(originalStock.stockQuantity).toBe(10);
      const editor=page.getByRole('dialog',{name:`AN-${String(order.number).padStart(6,'0')}`,exact:true});
      const form=editor.locator('.business-action-form');
      await page.goto(`/admin?section=orders&tab=list&record=${order.id}`);
      const tabs=editor.getByRole('navigation',{name:'Detalle del pedido'});
      if(mobile)await tabs.getByRole('combobox',{name:'Detalle del pedido'}).selectOption('profit');
      else await tabs.getByRole('button',{name:'Rentabilidad',exact:true}).click();
      await editor.getByRole('button',{name:'Registrar devolución',exact:true}).click();
      await form.getByLabel('Fecha de devolución').fill(openingOn);
      await form.getByLabel('Cantidad a devolver').fill('1');
      const reason=via==='panel'?'Recibida antes de contar':'Recibida después de contar';
      await form.getByLabel('Motivo').fill(reason);
      const choice=form.getByRole('combobox',{name:`Relación con el conteo físico del ${openingOn}`,exact:true});
      const writeCount=writes.length;
      if(via!=='panel'){
        await editor.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        if(via==='chat')await askAli(overlay,'¿Dónde está devolución ya en el conteo?');
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill('devolución ya en el conteo');
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator('[data-capability-id="orders.classify-return-opening"]').getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(choice).toBeFocused();
        await expect(choice).toBeInViewport();
      }
      await expect(choice).toHaveValue('');
      await expect(form.getByLabel('Motivo')).toHaveValue(reason);
      expect(writes).toHaveLength(writeCount);
      expect(await fetchOrder()).toEqual(order);
      expect(await stock()).toEqual(originalStock);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-devolucion-clasificar-conteo');
      const included=via==='panel';
      await choice.selectOption(String(included));
      const wait=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname==='/api/admin/business/actions/return');
      await form.getByRole('button',{name:'Registrar devolución',exact:true}).click();
      const response=await wait,payload=response.request().postDataJSON();
      expect(response.ok(),await response.text()).toBe(true);
      const receipt=await response.json();
      expect(payload).toMatchObject({orderId:order.id,version:order.version,occurredOn:openingOn,inventoryOpeningIncluded:included});
      expect(await registerReturn(store,payload,actor)).toEqual(receipt);
      const updated=await fetchOrder(),counted=await stock();
      expect(updated.inventoryOpening.returnClassifications).toEqual([expect.objectContaining({returnId:receipt.id,included,reason})]);
      expect(updated.collections).toEqual([]);
      expect(counted.stockQuantity).toBe(included?10:11);
      expect(counted.stockReserved).toBe(originalStock.stockReserved);
      expect(writes).toHaveLength(writeCount+1);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: contrasta la revisión guardada de Excel y localiza sus filas originales', async ({page, context, request}, info) => {
  test.setTimeout(180000);
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({width:320, height:740});
  const store = await openStore(testDatabaseEnv());
  try {
    const actorId = await fixtureActor(context, store);
    const platform = await saveResource(store, 'platforms', {requestId:randomUUID(), name:`Revisión Excel ${randomUUID().slice(0,7)}`}, actorId);
    const [source] = await listResources(store, 'sources', {platform:platform.id});
    const batch = await prepareAdvisorImportBatch(store, {sourceId:source.id, actorId});
    const workbook = advisorImportWorkbook();
    const {sheet, rowNumber} = workbook.correction;
    const xlsx = createRequire(import.meta.url)('xlsx');
    const rows = (book, name) => xlsx.utils.sheet_to_json(book.Sheets[name], {header:1});
    const original = xlsx.read(workbook.bytes);
    const [header, valid, pending] = rows(original, sheet);
    const [validId, expenseDay, expenseConcept] = valid;
    const [, , privateConcept, privateAmount] = pending;
    const history = '/admin?section=orders&tab=imports', saved = `${history}&batch=${batch.id}`, endpoint = `/api/admin/imports/${batch.id}`;
    const wizard = p => p.getByRole('region', {name:'Importar Excel', exact:true});
    const filters = p => wizard(p).getByRole('region', {name:'Problemas por resolver', exact:true});
    const operation = (p, row) => wizard(p).locator('[data-import-operation]').filter({hasText:`Ubicación: ${sheet} · fila ${row}`});
    const allOperations = p => filters(p).getByRole('button', {name:'Todas las operaciones', exact:true});
    const sourceSearch = p => wizard(p).getByRole('searchbox', {name:'Buscar en las filas de este archivo', exact:true});
    const sourceHeading = (p, row) => wizard(p).getByRole('heading', {name:`${sheet} · fila ${row}`, exact:true});
    expect(batch).toMatchObject({state:'review', preview:{summary:{valid:1, rejected:1}}});
    expect(batch.preview.previewHash).toBeTruthy();

    const persisted = () => store.readSnapshot(async tx => ({
      batch: await tx.db.get(`SELECT * FROM ${tx.t('import_batches')} WHERE id=?`, [batch.id]),
      batchesForSource: await tx.db.all(`SELECT id,version FROM ${tx.t('import_batches')} WHERE source_id=? ORDER BY id`, [source.id]),
      rows: await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE batch_id=? ORDER BY sheet,row_number`, [batch.id]),
      revisions: await tx.db.all(`SELECT * FROM ${tx.t('import_revisions')} WHERE batch_id=? ORDER BY revision`, [batch.id]),
      jobs: await tx.db.all(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [`import:${batch.id}`]),
      commands: await tx.db.all(`SELECT * FROM ${tx.t('business_requests')} WHERE scope LIKE ? ORDER BY scope,request_id`, [`import:%${batch.id}%`]),
      audits: await tx.db.all(`SELECT * FROM ${tx.t('business_audit')} WHERE entity_id=? ORDER BY id`, [batch.id]),
      expenses: await tx.db.all(`SELECT id,version,amount_minor FROM ${tx.t('expenses')} WHERE data::jsonb->>'sourceId'=? ORDER BY id`, [source.id]),
      businessRevision: await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`),
    }));
    const baseline = await persisted();
    expect(baseline.rows).toHaveLength(2);
    expect(baseline.expenses).toEqual([]);
    expect(baseline.revisions).toEqual([]);

    const writes = [], located = [], confirmations = [];
    page.on('dialog', dialog => { confirmations.push(dialog.type()); void dialog.dismiss(); });
    page.on('request', req => {
      const {pathname} = new URL(req.url()), method = req.method();
      if (method === 'GET') return;
      if (method === 'POST' && pathname === endpoint && req.postDataJSON()?.sheet === sheet && req.postDataJSON()?.rowNumber === rowNumber) {
        located.push(req.postDataJSON());
      } else if (/^\/api\/admin\/(?:imports|business|orders|finance|products|assistant\/proposals)(?:\/|$)/.test(pathname)) {
        writes.push(`${method} ${pathname}`);
      }
    });

    const fixtures = [
      {id:'imports.filter-review', query:'filtrar por incidencia', target:p => filters(p).getByRole('button', {name:'Pendientes · 1', exact:true}), async prepare(p) {
        await allOperations(p).click();
        await expect(operation(p,2)).toBeVisible();
        await operation(p,2).getByRole('checkbox', {name:/^Seleccionar operación/}).check();
        await expect(wizard(p).getByRole('region', {name:'Acciones para seleccionadas'})).toBeVisible();
      }, async check(p, target) {
        await expect(target).toHaveAttribute('aria-pressed', 'false');
        await expect(wizard(p).getByRole('region', {name:'Acciones para seleccionadas'})).toBeVisible();
        await target.click();
        await expect(target).toHaveAttribute('aria-pressed', 'true');
        await expect(operation(p,2)).toHaveCount(0);
        await expect(operation(p,rowNumber)).toContainText('Completa el importe explícito del gasto.');
        await expect(wizard(p).getByRole('region', {name:'Acciones para seleccionadas'})).toHaveCount(0);
        const occurrence = filters(p).getByRole('button', {name:'Datos por revisar · EXCEL_MONEY · 1', exact:true});
        await occurrence.click();
        await expect(occurrence).toHaveAttribute('aria-pressed', 'true');
        await expect(target).toHaveAttribute('aria-pressed', 'false');
        await expect(operation(p,2)).toHaveCount(0);
        await expect(operation(p,rowNumber)).toContainText('Campo: expenseAmount');
        await allOperations(p).click();
        await expect(operation(p,2)).toBeVisible();
      }},
      {id:'imports.read-review-effects', query:'proyección de la importación', target:p => wizard(p).getByRole('heading', {name:'Efectos previstos de esta revisión', exact:true}), async check(p, target) {
        const effects = wizard(p).getByRole('region', {name:'Efectos de la importación', exact:true});
        await expect(target).toBeVisible();
        await expect(effects).toContainText('Caja no cambia por registrar estos gastos.');
        await expect(effects).toContainText(/Operación\s*\$\s*12[.,]000/);
        await expect(effects).toContainText('Todavía no hay una proyección de inventario disponible.');
        await allOperations(p).click();
        await operation(p,2).getByText('Ver datos y efectos de esta operación', {exact:true}).click();
        const projection = operation(p,2).getByRole('region', {name:'Gastos de esta operación'});
        await expect(projection.getByRole('heading', {name:expenseConcept, exact:true})).toBeVisible();
        await expect(projection).toContainText(expenseDay);
        await expect(projection).toContainText('Crear gasto');
        await expect(projection).toContainText('Gastos preparados, sin pagos automáticos');
        await projection.getByText('Datos informativos y procedencia del gasto', {exact:true}).click();
        await expect(projection.getByText(validId, {exact:true})).toBeVisible();
        await expect(projection.getByText(source.id, {exact:true})).toBeVisible();
      }},
      {id:'imports.inspect-source-rows', query:'buscar datos en el lote', target:p => wizard(p).getByText(/^Filas originales y motivos \(\d+\)$/), async check(p, target) {
        await expect(sourceSearch(p)).toBeHidden();
        await target.click();
        await sourceSearch(p).fill(validId);
        await wizard(p).getByRole('button', {name:'Buscar filas', exact:true}).click();
        await expect(sourceHeading(p,2)).toBeVisible();
        await expect(sourceHeading(p,rowNumber)).toHaveCount(0);
        await wizard(p).getByRole('button', {name:'Limpiar búsqueda', exact:true}).click();
        await expect(sourceHeading(p,rowNumber)).toBeVisible();
        await wizard(p).getByRole('combobox', {name:'Filtrar filas', exact:true}).selectOption('rejected');
        await expect(sourceHeading(p,2)).toHaveCount(0);
        await expect(sourceHeading(p,rowNumber)).toBeVisible();
        const response = p.waitForResponse(res => new URL(res.url()).pathname === endpoint && res.request().method() === 'POST');
        await operation(p,rowNumber).getByRole('button', {name:'Ver fila original', exact:true}).click();
        const exact = await response;
        expect(exact.ok()).toBe(true);
        expect(new URL(exact.url()).search).toBe('');
        const payload = await exact.json();
        expect(payload.version).toBe(batch.version);
        expect(payload.rows.records.map(({sheet, rowNumber}) => ({sheet, rowNumber}))).toEqual([{sheet, rowNumber}]);
        await expect(target).toBeFocused();
        await expect(wizard(p).getByText(`Hoja ${sheet} · fila ${rowNumber}`, {exact:true})).toBeVisible();
        await expect(sourceHeading(p,2)).toHaveCount(0);
        const row = sourceHeading(p,rowNumber).locator('..');
        await expect(row).toContainText('Completa el importe explícito del gasto.');
        await row.getByText('Valores originales por posición', {exact:true}).click();
        const cells = row.locator('details[data-import-source-values] dl');
        await expect(cells.locator('dt')).toHaveText(header.map((_, index) => `Columna ${index+1}`));
        await expect(cells.locator('dd')).toHaveText(pending.map(String));
      }},
    ];

    for (const fixture of fixtures) await test.step(fixture.id, async () => {
      const target = fixture.target(page);
      for (const via of ['panel', 'chat', 'directorio']) {
        await page.goto(via === 'panel' ? history : saved);
        if (via === 'panel') {
          const card = page.getByRole('region', {name:'Importaciones', exact:true}).getByRole('article').filter({hasText:platform.name});
          await card.getByRole('button', {name:'Continuar', exact:true}).click();
        }
        await expect(wizard(page).getByText('Revisión actualizada', {exact:true})).toBeVisible();
        if (fixture.prepare) await fixture.prepare(page);
        if (via !== 'panel') {
          if (fixture.id === 'imports.read-review-effects') {
            await wizard(page).getByRole('button', {name:'2. Hojas y columnas', exact:true}).click();
            await expect(target).toHaveCount(0);
          }
          const chat = await openAli(page);
          let entry = chat;
          if (via === 'chat') await askAli(chat, `¿Dónde está ${fixture.query}?`);
          else {
            await chat.getByRole('button', {name:'¿Qué quieres hacer?', exact:true}).click();
            entry = page.getByRole('dialog', {name:'¿Qué quieres hacer?', exact:true});
            await entry.getByRole('searchbox', {name:'Buscar una acción'}).fill(fixture.query);
            await entry.getByRole('button', {name:'Buscar', exact:true}).click();
          }
          const seen = located.length;
          const control = entry.locator(`[data-capability-id="${fixture.id}"]`).getByRole('button', {name:/^Abrir en el panel:/});
          await expect(control).toBeVisible();
          await expect(entry).not.toContainText(privateConcept);
          await expect(entry).not.toContainText(privateAmount);
          await control.click();
          await expect(target).toBeFocused();
          expect(located).toHaveLength(seen);
        }
        await expect(page).toHaveURL(url => url.pathname + url.search === saved);
        await fixture.check(page, target);
        await expect(page).toHaveURL(url => url.pathname + url.search === saved);
        if (via === 'directorio' && fixture.id === 'imports.inspect-source-rows') await screenshot(page, info, 'advisor-c6-excel-fila-conservada');
        expect(await persisted()).toEqual(baseline);
      }
    });
    expect(located).toEqual(Array.from({length:3}, () => ({page:1,state:'',q:'',sheet,rowNumber})));
    expect(confirmations).toEqual([]);
    expect(writes).toEqual([]);
  } finally {
    await store.close();
  }
});

test('Ali @advisor-c6: crea una persona sin guardar el borrador, revierte un ajuste y acepta un gasto Excel', async ({ page, context, request }, info) => {
  test.setTimeout(185000);
  const env = testDatabaseEnv(), app = new URL(info.project.use.baseURL);
  const local = value => Boolean(value) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  if (app.protocol !== 'https:' || ![app.href, controlURL, baseURL, env.DATABASE_URL].every(local)) {
    throw new Error('La prueba requiere app, proveedor sintético y PostgreSQL descartable locales.');
  }
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const [{ postCashEntryTx }, { payExpense }, { writeExcelSheets }, imports] = await Promise.all([
    import('../../lib/business/cash.mjs'), import('../../lib/business/expenses.mjs'),
    import('../../lib/business/excel.mjs'), import('../../lib/business/imports.mjs'),
  ]);
  const store = await openStore(env);
  try {
    const actor = await fixtureActor(context, store), code = randomUUID().slice(0, 8), today = bogotaDate();
    const incurredOn = addC6ReportDays(today, -2), reportAsOf = addC6ReportDays(today, -1);
    const viaNames = ['panel', 'chat', 'directorio'];
    const command = data => ({ requestId: randomUUID(), ...data });
    const owner = await saveResource(store, 'people', command({ name: `Operador local ${code}` }), actor);
    const platform = await saveResource(store, 'platforms', command({ name: `Fuente de soporte ${code}` }), actor);
    const [source] = await listResources(store, 'sources', { platform: platform.id });
    const sheet = 'Soportes de gastos C6', headers = ['ID gasto', 'Fecha', 'Concepto', 'Importe', 'Soporte original'];
    const destinations = ['expenseExternalId', 'expenseDate', 'expenseConcept', 'expenseAmount', 'expenseReference'];
    const fixtures = viaNames.map((via, index) => ({ via, row: index + 2, externalId: `C6-${code}-${via}`, concept: `Gasto Excel ${code} ${via}`, support: `FACTURA-SINTETICA-${code}-${via}` }));
    const bytes = writeExcelSheets([{ name: sheet, rows: [headers, ...fixtures.map(item => [item.externalId, incurredOn, item.concept, 12500, item.support])] }]);
    const config = { formatVersion: 2, sheets: [{ sheetName: sheet, enabled: true, headerRow: 1, purpose: 'expenses', layout: 'expense_rows', dateFormat: 'ISO', decimalSeparator: '.', groupSeparator: ',', reportAsOf, identityMode: 'provided', defaults: { expenseCategory: 'operating' }, columns: headers.map((header, index) => ({ header: header.toLowerCase(), index, destination: destinations[index], group: 0 })) }] };
    let batch = await imports.createImportBatch(store, command({ sourceId: source.id }), actor);
    const { id: batchId } = batch;
    async function settleImport(phase, verify) {
      let value;
      await expect.poll(async () => {
        await processImportTurn(store, { batchId, ...(phase === 'inspect' ? { expectedPhase: phase } : {}) });
        value = await getImportBatch(store, batchId);
        return Boolean(verify(value));
      }, { timeout: 20000, message: `El lote local ${batchId} debe publicar ${phase}` }).toBe(true);
      return value;
    }
    await imports.uploadImportFile(store, batchId, command({ filename: `soportes-${code}.xlsx`, bytes, version: batch.version }), actor);
    batch = await settleImport('inspect', value => value.state !== 'uploaded' && value.workbook);
    batch = await imports.updateImportBatch(store, batchId, command({ version: batch.version, config }), actor);
    if (batch.state === 'uploaded') batch = await settleImport('inspect', value => value.state !== 'uploaded' && value.workbook);
    await imports.requestImportPreview(store, batchId, command({ version: batch.version }), actor);
    batch = await settleImport('preview', value => value.state !== 'previewing' && value.preview?.previewHash);
    expect(batch.preview.summary.valid).toBe(fixtures.length);
    await commitImport(store, batchId, command({ version: batch.version, previewHash: batch.preview.previewHash }), actor);
    batch = await settleImport('commit', value => value.state === 'completed');
    expect(batch.fileHash).toBe(createHash('sha256').update(bytes).digest('hex'));

    const peoplePath = '/api/admin/business/people', reversePath = '/api/admin/business/actions/cash-reverse', expensePath = '/api/admin/business/actions/expense';
    const writes = [], forbidden = [], errors = [];
    let allowed = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const req = route.request(), url = new URL(req.url()), { pathname: path } = url;
      if (url.origin === app.origin && (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || path.startsWith('/api/admin/assistant/'))) return route.continue();
      if (url.origin === app.origin && req.method() === 'POST' && path === allowed) {
        writes.push(path);
        allowed = null;
        return route.continue();
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !['http:', 'https:'].includes(url.protocol)) return route.continue();
      forbidden.push(`${req.method()} ${url.origin}${path}`);
      return route.abort();
    });
    const json = async (res, status = 200) => {
      expect(res.status(), await res.text()).toBe(status);
      return res.json();
    };
    const get = path => context.request.get(path).then(json);
    const row = (table, id) => store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]);
    const trail = (type, id) => store.db.all(`SELECT id,actor_id,data FROM ${store.t('business_audit')} WHERE entity_type=? AND entity_id=? ORDER BY id`, [type, id]);
    const tableNames = ['people', 'users', 'cash_accounts', 'cash_entries', 'expenses', 'expense_payments', 'orders', 'order_collections', 'business_requests', 'business_audit'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tableNames.map(async table => [table, Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n)])));
    async function changedOnly(before, changes) {
      expect(await snapshot()).toEqual({ ...before, business_requests: before.business_requests + 1, business_audit: before.business_audit + 1, ...changes });
    }
    async function unchanged(before, count) {
      expect(writes).toHaveLength(count);
      expect(forbidden).toEqual([]);
      expect(await snapshot()).toEqual(before);
    }
    async function submit(control, path, status) {
      const count = writes.length;
      const pending = page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === path);
      allowed = path;
      await control.click();
      const res = await pending;
      const sent = res.request(), body = sent.postDataJSON();
      const result = await json(res, status);
      expect(allowed).toBeNull();
      expect(writes.slice(count)).toEqual([path]);
      expect(forbidden).toEqual([]);
      return { body, result, url: res.url(), headers: { Origin: await sent.headerValue('origin'), 'x-csrf-token': await sent.headerValue('x-csrf-token') } };
    }
    async function receipt(scope, submission, status, state) {
      const { url, headers, body, result } = submission;
      const stored = () => store.db.get(`SELECT * FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, body.requestId]);
      const commandReceipt = await stored(), before = await snapshot(), proof = await state();
      expect(commandReceipt.actor_id).toBe(actor);
      expect(JSON.parse(commandReceipt.result_json)).toEqual(result);
      expect(await json(await context.request.post(url, { headers, data: body }), status)).toEqual(result);
      expect(await stored()).toEqual(commandReceipt);
      expect(await snapshot()).toEqual(before);
      expect(await state()).toEqual(proof);
    }
    async function arrive(via, id, query, target, form) {
      if (via === 'panel') { await expect(target).toBeVisible(); return; }
      if (form) await form.getByRole('button', { name: 'Ayúdame con este formulario', exact: true }).click();
      let overlay = form ? page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true }) : await openAli(page);
      const selector = `[data-capability-id="${id}"]`;
      if (via === 'chat') {
        const count = await overlay.locator(selector).count();
        await askAli(overlay, `¿Dónde está ${query}?`);
        await expect(overlay.locator(selector)).toHaveCount(count + 1);
      } else {
        await overlay.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
        overlay = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
        await overlay.getByRole('combobox', { name: 'Área', exact: true }).selectOption('cash');
        await overlay.getByRole('searchbox', { name: 'Buscar una acción', exact: true }).fill(query);
        await overlay.getByRole('button', { name: 'Buscar', exact: true }).click();
      }
      await (via === 'chat' ? overlay.locator(selector).last() : overlay.locator(selector)).getByRole('button', { name: /^Abrir en el panel:/ }).click();
      await expect(overlay).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    const drawer = name => page.getByRole('dialog', { name, exact: true });
    const button = (scope, name) => scope.getByRole('button', { name, exact: true });
    const field = (scope, name) => scope.locator(`[name="${name}"]`);
    const summary = (scope, name) => scope.locator('summary').and(scope.getByText(name, { exact: true }));
    const openExpense = button(page.locator('[aria-label="Acciones de caja"]'), 'Registrar gasto');
    const expenseForm = drawer('Registrar gasto'), reverseForm = drawer('Revertir movimiento');
    const detail = page.locator('.cash-detail');
    const openRecord = id => page.locator(`[data-cash-record="${id}"]`);
    const ledger = account => store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=? ORDER BY id`, [account]);
    const payments = expense => store.db.all(`SELECT * FROM ${store.t('expense_payments')} WHERE expense_id=? ORDER BY id`, [expense]);
    const cashPage = (tab, anchor, query = {}) => `/admin?${new URLSearchParams({ section: 'cash', tab, period: 'day', anchor, ...query })}`;
    const financeRecord = (tab, id) => get(`/api/admin/finance/${tab}?record=${id}`);
    const exactRecord = (tab, id) => expect(page).toHaveURL(url => url.searchParams.get('section') === 'cash' && url.searchParams.get('tab') === tab && url.searchParams.get('record') === id);

    for (const item of fixtures) await test.step(item.via, async () => {
      const { via, externalId, concept, support, row: line } = item;
      const account = await saveAccount(store, command({ name: `Caja histórica ${code} ${via}`, type: 'cash', openingOn: incurredOn, openingBalanceMinor: 9000000, responsibleId: owner.id }), actor);
      const ref = `AJUSTE-${code}-${via}`, adjustmentReason = 'Ajuste registrado en el documento sintético';
      const original = await store.transaction(async tx => {
        await tx.lockWrites();
        return postCashEntryTx(tx, { accountId: account.id, effectiveOn: incurredOn, kind: 'adjustment', sourceType: 'adjustment', sourceId: randomUUID(), amountMinor: -123400, data: { concept: `Ajuste directo ${code} ${via}`, reference: ref, reason: adjustmentReason } }, actor);
      });

      await test.step('cash.create-inline-responsible', async () => {
        const before = await snapshot(), count = writes.length, name = `Responsable sin acceso ${code} ${via}`;
        const personSummary = summary(expenseForm, 'Crear persona sin acceso al panel');
        const nameInput = field(expenseForm, 'newPersonName'), newExpense = `Borrador que no se guarda ${code} ${via}`;
        await page.goto(cashPage('expenses', today));
        await openExpense.click();
        await field(expenseForm, 'category').selectOption('operating');
        await field(expenseForm, 'concept').fill(newExpense);
        await field(expenseForm, 'amountMinor').fill('4.250');
        await expect(button(expenseForm, 'Guardar gasto pendiente')).toBeEnabled();
        if (via === 'panel') await summary(expenseForm, 'Responsable opcional del gasto').click();
        await arrive(via, 'cash.create-inline-responsible', 'añadir responsable sin usuario', personSummary, expenseForm);
        await expect(field(expenseForm, 'concept')).toHaveValue(newExpense);
        await expect(field(expenseForm, 'personId')).toHaveValue('');
        await personSummary.click();
        await nameInput.fill(name);
        await expect(expenseForm.locator('input[type=email], input[type=password]')).toHaveCount(0);
        await nameInput.press('Enter');
        await expect(nameInput).toHaveValue(name);
        await expect(expenseForm).toBeVisible();
        await unchanged(before, count);
        await screenshot(page, info, `advisor-c6-caja-responsable-${via}`);
        const saved = await submit(button(expenseForm, 'Crear persona'), peoplePath, 201), person = saved.result;
        expect(saved.body).toEqual({ requestId: expect.any(String), name, active: true });
        expect(person).toMatchObject({ name, active: true, userId: null, version: 1 });
        await expect(field(expenseForm, 'personId')).toHaveValue(person.id);
        await expect(field(expenseForm, 'concept')).toHaveValue(newExpense);
        await expect(nameInput).toHaveValue('');
        const savedPerson = await row('people', person.id), history = await trail('people', person.id);
        expect(savedPerson).toMatchObject({ name, version: 1 });
        expect(JSON.parse(savedPerson.data).userId).toBeNull();
        expect(await get(`${peoplePath}/${person.id}`)).toEqual(person);
        expect(history).toHaveLength(1);
        expect(history[0].actor_id).toBe(actor);
        expect(JSON.parse(history[0].data)).toMatchObject({ previous: null, next: { id: person.id, userId: null, name } });
        await changedOnly(before, { people: before.people + 1 });
        const after = await snapshot();
        page.once('dialog', confirm => confirm.accept());
        await button(expenseForm, 'Cancelar').click();
        await expect(expenseForm).toHaveCount(0);
        await unchanged(after, count + 1);
        expect(await row('people', person.id)).toEqual(savedPerson);
        await receipt('people:new', saved, 201, () => Promise.all([row('people', person.id), trail('people', person.id)]));
      });

      await test.step('cash.reverse-adjustment', async () => {
        const before = await snapshot(), count = writes.length;
        const oldRow = await row('cash_entries', original.id), oldLedger = await ledger(account.id), history = await trail('cash_entry', original.id);
        const href = cashPage('movements', incurredOn, { account: account.id, q: ref });
        await page.goto(via === 'panel' ? href : `${href}&record=${original.id}`);
        if (via === 'panel') await openRecord(original.id).click();
        const reverse = button(detail, 'Revertir movimiento completo');
        await expect(detail).toContainText(ref);
        await arrive(via, 'cash.reverse-adjustment', 'revertir ajuste', reverse);
        await exactRecord('movements', original.id);
        await unchanged(before, count);
        await reverse.click();
        await expect(reverseForm.getByRole('region', { name: 'Movimiento original', exact: true })).toContainText(ref);
        await expect(field(reverseForm, 'reason')).toHaveValue('');
        const reason = `Contrapartida de ajuste comprobada ${via}`;
        await field(reverseForm, 'effectiveOn').fill(today);
        await field(reverseForm, 'reason').fill(reason);
        await unchanged(before, count);
        await screenshot(page, info, `advisor-c6-caja-ajuste-${via}`);
        const saved = await submit(button(reverseForm, 'Revertir movimiento'), reversePath, 200), { result } = saved;
        expect(saved.body).toEqual({ cashEntryId: original.id, effectiveOn: today, reason, requestId: expect.any(String) });
        expect(result).toMatchObject({ accountId: account.id, kind: 'reversal', sourceType: 'adjustment', sourceId: original.sourceId, reversalOf: original.id, effectiveOn: today, amountMinor: 123400, balanceMinor: 9000000, reference: ref, reason });
        await expect(reverseForm).toHaveCount(0);
        await expect(page.getByText('Reversión registrada; el original se conserva.', { exact: true })).toBeVisible();
        await expect(detail).toContainText('se conserva la historia');
        await expect(reverse).toHaveCount(0);
        expect(await row('cash_entries', original.id)).toEqual(oldRow);
        expect(await trail('cash_entry', original.id)).toEqual(history);
        const reversalRow = await row('cash_entries', result.id), afterLedger = await ledger(account.id);
        expect(afterLedger.filter(entry => entry.id !== result.id)).toEqual(oldLedger);
        expect(reversalRow).toMatchObject({ account_id: account.id, source_id: original.sourceId, kind: 'reversal', reversal_of: original.id });
        expect(Number(reversalRow.amount_minor)).toBe(123400);
        const reversalHistory = await trail('cash_entry', result.id);
        expect(reversalHistory).toHaveLength(1);
        expect(reversalHistory[0].actor_id).toBe(actor);
        expect(JSON.parse(reversalHistory[0].data)).toMatchObject({ reason, source: 'adjustment', next: { id: result.id, reversalOf: original.id, amountMinor: 123400 } });
        await changedOnly(before, { cash_entries: before.cash_entries + 1 });
        expect(await financeRecord('movements', original.id)).toMatchObject({ reference: ref, amountMinor: -123400, reversed: true });
        expect(await financeRecord('movements', result.id)).toMatchObject({ reference: ref, reason, amountMinor: 123400, reversalOf: original.id });
        await page.goto(cashPage('movements', today, { account: account.id, q: ref }));
        await openRecord(result.id).click();
        await expect(detail).toContainText(reason);
        await exactRecord('movements', result.id);
        await receipt('cash:reverse', saved, 200, () => Promise.all([ledger(account.id), trail('cash_entry', original.id), trail('cash_entry', result.id)]));
      });

      await test.step('cash.correct-imported-expense', async () => {
        const expense = await store.db.get(`SELECT * FROM ${store.t('expenses')} WHERE data::jsonb->'importIdentity'->>'externalId'=?`, [externalId]);
        const { id } = expense, amountBefore = 1250000, paid = 300000, corrected = 1185075;
        const sourceBefore = JSON.parse(expense.data);
        expect(sourceBefore).toMatchObject({ reference: support, source: 'excel', sourceId: source.id, importIdentity: { externalId, generated: false } });
        const fieldOrigin = sourceBefore.importedFields.find(field => field.key === 'expenseReference');
        expect(fieldOrigin).toMatchObject({ value: support, batchId, sourceId: source.id, sourceAsOf: sourceBefore.sourceAsOf, sheet, columnIndex: 4, rowNumbers: [line] });
        const importTrail = await trail('import_expense', id);
        expect(importTrail).toHaveLength(1);
        expect(JSON.parse(importTrail[0].data)).toMatchObject({ source: 'excel', next: { batchId, externalId, fileHash: batch.fileHash, sheet, rowNumbers: [line], column: 3, reportCutoff: { value: reportAsOf, precision: 'day' } } });
        const seeded = await payExpense(store, command({ expenseId: id, version: expense.version, accountId: account.id, effectiveOn: today, amountMinor: paid, reference: `PAGO-EXISTENTE-${code}-${via}` }), actor);
        const before = await snapshot(), count = writes.length, oldLedger = await ledger(account.id), oldPayments = await payments(id), oldHistory = await trail('expense', id);
        const href = cashPage('expenses', incurredOn, { q: concept });
        await page.goto(via === 'panel' ? href : `${href}&record=${id}`);
        if (via === 'panel') await openRecord(id).click();
        await expect(detail).toContainText(support);
        const edit = button(detail, 'Corregir importe o fecha con motivo');
        const checkbox = expenseForm.getByRole('checkbox', { name: 'Confirmo la corrección del costo importado después de revisar su soporte.', exact: true });
        if (via === 'panel') await edit.click();
        await arrive(via, 'cash.correct-imported-expense', 'corregir gasto de excel', checkbox);
        await exactRecord('expenses', id);
        await expect(checkbox).not.toBeChecked();
        await expect(field(expenseForm, 'concept')).toHaveValue(concept);
        await expect(field(expenseForm, 'incurredOn')).toHaveValue(incurredOn);
        await expect(expenseForm.getByRole('heading', { name: 'Historial de pagos', exact: true })).toBeVisible();
        await expect(expenseForm.getByText(`${today} · ${formatC6ReportMoney(paid)} · Pago`, { exact: true })).toBeVisible();
        await unchanged(before, count);
        await summary(expenseForm, 'Consultar datos de origen').click();
        const provenance = expenseForm.getByRole('article').filter({ hasText: support });
        await expect(provenance).toContainText(batchId);
        await expect(provenance).toContainText(sheet);
        await expect(provenance).toContainText('E · columna 5 (índice 4)');
        await expect(provenance.getByText(String(line), { exact: true })).toBeVisible();
        const reason = `Importe del soporte original comprobado ${via}`;
        await field(expenseForm, 'amountMinor').fill('11.850,75');
        await field(expenseForm, 'reason').fill(reason);
        // Re-enter a dirty correction with Ali; focus may not reset fields or accept the review.
        if (via !== 'panel') await arrive(via, 'cash.correct-imported-expense', 'corregir gasto de excel', checkbox, expenseForm);
        await expect(field(expenseForm, 'reason')).toHaveValue(reason);
        await expect(checkbox).not.toBeChecked();
        const save = button(expenseForm, 'Guardar corrección del gasto');
        await save.click();
        await expect(checkbox).toBeFocused();
        await unchanged(before, count);
        await screenshot(page, info, `advisor-c6-caja-soporte-importado-${via}`);
        await checkbox.check();
        await unchanged(before, count);
        const saved = await submit(save, expensePath, 200), { result } = saved;
        expect(saved.body).toMatchObject({ expenseId: id, version: expense.version, amountMinor: corrected, incurredOn, reason, reviewConfirmed: true });
        for (const key of ['accountId', 'effectiveOn', 'reference']) expect(saved.body).not.toHaveProperty(key);
        expect(result).toMatchObject({ id, version: expense.version + 1, amountMinor: corrected, incurredOn, paidMinor: paid, outstandingMinor: corrected - paid, creditMinor: 0 });
        expect(result.observationIgnored).toBeUndefined();
        await expect(expenseForm).toHaveCount(0);
        await expect(page.getByText('Gasto corregido; se conservó el historial de pagos, sin otro movimiento de dinero.', { exact: true })).toBeVisible();
        const correctedRow = await row('expenses', id), newHistory = await trail('expense', id);
        expect(correctedRow).toMatchObject({ id, version: expense.version + 1, source_key: expense.source_key });
        expect(Number(correctedRow.amount_minor)).toBe(corrected);
        expect(JSON.parse(correctedRow.data)).toMatchObject({ sourceAsOf: sourceBefore.sourceAsOf, sourceId: source.id, importIdentity: sourceBefore.importIdentity, importedFields: sourceBefore.importedFields });
        expect(newHistory.filter(entry => oldHistory.some(previous => previous.id === entry.id))).toEqual(oldHistory);
        const [revision] = newHistory.filter(entry => !oldHistory.some(previous => previous.id === entry.id));
        expect(newHistory).toHaveLength(oldHistory.length + 1);
        expect(revision.actor_id).toBe(actor);
        expect(JSON.parse(revision.data)).toMatchObject({ reason, source: 'excel', previous: { amountMinor: amountBefore, version: expense.version }, next: { amountMinor: corrected, version: expense.version + 1 } });
        expect(await trail('import_expense', id)).toEqual(importTrail);
        expect(await payments(id)).toEqual(oldPayments);
        expect(await ledger(account.id)).toEqual(oldLedger);
        await changedOnly(before, {});
        await page.reload();
        await exactRecord('expenses', id);
        await expect(detail).toContainText(formatC6ReportMoney(corrected));
        await expect(detail).toContainText(support);
        expect(await financeRecord('expenses', id)).toMatchObject({ id, version: result.version, amountMinor: corrected, paidMinor: paid, outstandingMinor: corrected - paid, activePayments: [expect.objectContaining({ id: seeded.payment.id, cashEntryId: seeded.payment.cashEntryId, amountMinor: paid })] });
        await receipt('expense', saved, 200, () => Promise.all([row('expenses', id), payments(id), ledger(account.id), trail('expense', id), trail('import_expense', id)]));
      });
    });
    expect(writes).toEqual(viaNames.flatMap(() => [peoplePath, reversePath, expensePath]));
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await store.close(); }
});

test('Ali @advisor-c6: busca ofertas, prepara un obsequio y compara su ficha actual sin publicar',async({page,context,request},info)=>{
  test.setTimeout(145000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store), marker=randomUUID().slice(0,8), api='/api/admin/social';
    const writes=[], lookups=[];
    page.on('request',req=>{
      const url=new URL(req.url());
      if(url.pathname===`${api}/offers`)lookups.push(url.searchParams);
      if(req.method()!=='GET'&&url.pathname.startsWith(`${api}/`))writes.push([req.method(),url.pathname]);
    });
    const button=name=>page.getByRole('button',{name,exact:true});
    const offer=page.getByRole('region',{name:'Oferta',exact:true});
    const condition=offer.getByRole('textbox',{name:/^¿Para qué compra aplica el obsequio/});
    const preview=offer.getByRole('heading',{name:'Ficha actual del catálogo',exact:true}).locator('..');
    async function handoff(via,id,query,target){
      if(via==='panel'){await expect(target).toBeVisible();return;}
      let overlay=await openAli(page);
      const entry=()=>overlay.locator(`[data-capability-id="advertising.${id}"]`);
      if(via==='chat'){
        await askAliCatalog(overlay,`¿Dónde está ${query}?`);
        await expect(entry().last()).toBeVisible();
      }else{
        await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await overlay.getByLabel('Área').selectOption('advertising');
        await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry().last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(overlay).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const productTitle=`Proteína privada ${marker} ${via}`, giftTitle=`Muestra privada ${marker} ${via}`;
      const product=await store.save('products',{...emptyRecord('products'),title:productTitle,slug:`oferta-${marker}-${via}`,status:'draft',price:34000,stockQuantity:35,orderable:true,presentation:'Bolsa'},null,null,actor);
      const gift=await store.save('products',{...emptyRecord('products'),title:giftTitle,slug:`regalo-${marker}-${via}`,status:'draft',productType:'gift',orderable:true,price:0,items:[{productId:product.id,quantity:1}]},null,null,actor);
      const campaign=await saveSocialCampaign(store,{requestId:randomUUID(),name:`Promoción privada ${marker} ${via}`,mode:'organic',objective:'engagement'},actor);
      const row=()=>store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`,[campaign.id]);
      const providerWork=()=>store.db.all(`SELECT id,state,version FROM ${store.t('social_operations')} WHERE campaign_id=? ORDER BY id`,[campaign.id]);
      const baseline=await row(), work=await providerWork(), count=writes.length;
      await page.goto(`/admin?section=advertising&tab=campaigns&record=${campaign.id}`);
      const launch=offer.getByRole('button',{name:'Elegir oferta del catálogo',exact:true});
      await handoff(via,'choose-offer','cambiar oferta principal',offer.getByRole('heading',{name:'Oferta',exact:true}));
      await handoff(via,'search-offers','consultar catálogo para anuncio',launch);
      await launch.click();
      const search=offer.getByRole('searchbox',{name:/^Buscar oferta/});
      await search.fill(productTitle);
      await handoff(via,'search-offers','consultar catálogo para anuncio',search);
      await expect(search).toHaveValue(productTitle);
      await offer.getByRole('button',{name:new RegExp(productTitle)}).click();
      await expect(offer.getByRole('article')).toContainText(/34[.,]000/);
      const addGift=offer.getByRole('button',{name:'Añadir un obsequio',exact:true});
      await handoff(via,'define-offer-gift','añadir un obsequio',addGift);
      await addGift.click();
      await offer.getByRole('searchbox',{name:'Buscar obsequios',exact:true}).fill(giftTitle);
      await offer.getByRole('button',{name:new RegExp(giftTitle)}).click();
      await handoff(via,'define-offer-gift','añadir un obsequio',condition);
      await expect(condition).toHaveValue('');
      await condition.fill('Solo al comprar la bolsa de esta oferta');
      await store.save('products',{...product,price:38000},product.id,product.version,actor);
      const reread=offer.getByRole('button',{name:'Volver a leer la ficha',exact:true});
      const beforeLookups=lookups.filter(params=>params.get('id')===product.id).length;
      await handoff(via,'reread-offer','volver a leer ficha',reread);
      expect(lookups.filter(params=>params.get('id')===product.id)).toHaveLength(beforeLookups);
      await reread.click();
      await expect(preview.getByText(/38[.,]000/)).toBeVisible();
      const oldCard=offer.getByRole('article').filter({hasText:/34[.,]000/});
      await expect(oldCard).toBeVisible();
      const accept=preview.getByRole('button',{name:'Aceptar la ficha actual',exact:true});
      await handoff(via,'accept-current-offer','aceptar ficha actual',accept);
      await expect(oldCard).toBeVisible();
      await expect(condition).toHaveValue('Solo al comprar la bolsa de esta oferta');
      if(via==='directorio')await screenshot(page,info,'advisor-c6-publicidad-ficha-actual');
      await accept.click();
      await expect(preview).toHaveCount(0);
      await expect(oldCard).toHaveCount(0);
      await expect(offer.getByText(/38[.,]000/)).toBeVisible();
      await expect(condition).toHaveValue('Solo al comprar la bolsa de esta oferta');
      expect(writes).toHaveLength(count);
      expect(await row()).toEqual(baseline);
      expect(await providerWork()).toEqual(work);
      const path=`${api}/campaigns/${campaign.id}`;
      const received=page.waitForResponse(res=>res.request().method()==='PATCH'&&new URL(res.url()).pathname===path,{timeout:10000});
      await button('Guardar borrador').click();
      const response=await received, payload=response.request().postDataJSON();
      expect(response.ok(),await response.text()).toBe(true);
      expect(payload.offerRef).toMatchObject({primary:{id:product.id,kind:'product',factsHash:expect.any(String)},gift:{id:gift.id,condition:'Solo al comprar la bolsa de esta oferta'}});
      const stored=await getSocialCampaign(store,campaign.id);
      expect(stored).toMatchObject({id:campaign.id,state:'draft',version:campaign.version+1,offerRef:payload.offerRef,offerSnapshot:{primary:{id:product.id,price:38000},gift:{id:gift.id}}});
      expect(await providerWork()).toEqual(work);
      expect(writes.slice(count)).toEqual([['PATCH',path]]);
      expect((await store.get('products',product.id)).stockQuantity).toBe(35);
      await offer.getByRole('button',{name:'Publicación de marca, sin producto',exact:true}).click();
      await expect(condition).toHaveCount(0);
      await expect(offer.getByText(giftTitle,{exact:false})).toHaveCount(0);
      expect((await row()).version).toBe(campaign.version+1);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: dirige el costo del flete a la guía elegida y conserva el total acordado',async({page,context,request},info)=>{
  test.setTimeout(100000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate(),code=randomUUID().slice(0,8);
    const product=await store.save('products',{...emptyRecord('products'),title:`Flete por guía ${code}`,slug:`flete-${code}`,status:'draft',price:24000,presentation:'Unidad',orderable:true,stockQuantity:30},null,null,actor);
    const path='/api/admin/business/actions/expense',writes=[];
    page.on('request',req=>{
      if(req.method()!=='GET'&&/\/api\/admin\/(?:finance|business)\//.test(req.url()))writes.push(new URL(req.url()).pathname);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const lineId=randomUUID(),cmd=input=>({requestId:randomUUID(),...input});
      const order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Flete privado ${code} ${via}`,items:[{lineId,kind:'products',itemId:product.id,quantity:2,unitPriceMinor:2400000,discountMinor:0}]}),actor);
      const makeGuide=suffix=>createShipment(store,cmd({orderId:order.id,carrier:'Transportadora sintética',tracking:`FLETE-${code}-${via}-${suffix}`,assignments:[{lineId,quantity:1}]}),actor);
      const first=await makeGuide('A'),second=await makeGuide('B');
      const ledger=()=>store.db.all(`SELECT id FROM ${store.t('cash_entries')} ORDER BY id`);
      const originalLedger=await ledger(),before=await store.order(order.id),count=writes.length;
      const target=page.getByRole('dialog',{name:`AN-${String(order.number).padStart(6,'0')}`,exact:true});
      const freight=target.getByRole('region',{name:'Flete / costo de envío',exact:true});
      const form=target.locator('.business-action-form');
      async function arrive(verb,q,guidance){
        if(via==='panel')return;
        await target.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let overlay=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        if(via==='chat')await askAliCatalog(overlay,`¿Dónde está ${q}?`);
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator(`[data-capability-id="orders.${verb}-freight-cost"]`).getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(guidance).toBeFocused();
        await expect(guidance).toBeInViewport();
        await expect(form).toHaveCount(0);
      }
      async function save(amount,reason){
        await form.getByRole('textbox',{name:'Importe (COP)',exact:true}).fill(String(amount/100));
        await form.locator('[name="incurredOn"]').fill(day);
        if(reason)await form.getByLabel('Motivo').fill(reason);
        const wait=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===path);
        await form.getByRole('button',{name:'Guardar costo de envío',exact:true}).click();
        const res=await wait,payload=res.request().postDataJSON();
        expect(res.ok(),await res.text()).toBe(true);
        const receipt=await res.json();
        expect(await recordExpense(store,payload,actor)).toEqual(receipt);
        await expect(freight).toBeVisible();
        expect(payload).not.toHaveProperty('accountId');
        expect(receipt).toMatchObject({orderId:order.id,shipmentId:second.id,amountMinor:amount,outstandingMinor:amount});
        return receipt;
      }
      await page.goto(`/admin?section=orders&tab=list&record=${order.id}`);
      await arrive('record','registrar flete de guía',freight.getByText('Elige la guía a la que corresponde el costo. No se registrará en las demás.',{exact:true}));
      expect(await store.order(order.id)).toEqual(before);
      await freight.getByRole('button',{name:`Registrar costo de envío · ${second.tracking}`,exact:true}).click();
      const expense=await save(570000);
      const other=await recordExpense(store,cmd({orderId:order.id,shipmentId:first.id,category:'shipping_out',amountMinor:710000,incurredOn:day,concept:'Flete testigo'}),actor);
      await page.reload();
      const choices=freight.getByText('Hay varios costos guardados. Elige el costo por guía, importe y fecha antes de corregirlo.',{exact:true});
      await arrive('correct','corregir flete importado',choices);
      if(info.project.name==='mobile'){
        const footer=target.locator(':scope > footer');
        const help=await footer.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).boundingBox();
        const close=await footer.getByRole('button',{name:'Cerrar',exact:true}).boundingBox();
        const saveButton=await footer.getByRole('button',{name:'Guardar cambios',exact:true}).boundingBox();
        expect(help.width).toBeGreaterThanOrEqual(280);
        expect(help.y+help.height).toBeLessThan(close.y);
        expect(saveButton.height).toBeLessThanOrEqual(64);
      }
      if(via==='directorio')await screenshot(page,info,'advisor-c6-flete-elige-guia');
      const card=freight.getByRole('article').filter({has:page.getByRole('heading',{name:`Guía ${second.tracking}`,exact:true})});
      await card.getByRole('button',{name:'Corregir costo de envío',exact:true}).click();
      const corrected=await save(610000,'Nuevo importe comprobado con factura');
      expect(corrected).toMatchObject({id:expense.id,version:expense.version+1,paidMinor:0});
      expect(await store.db.all(`SELECT id FROM ${store.t('expense_payments')} WHERE expense_id=?`,[expense.id])).toEqual([]);
      const final=await store.order(order.id);
      expect(final).toMatchObject({totalMinor:before.totalMinor,shippingChargeMinor:before.shippingChargeMinor,collections:[]});
      expect(final.expenses).toEqual(expect.arrayContaining([expect.objectContaining({id:other.id,version:other.version,amountMinor:710000}),expect.objectContaining({id:expense.id,version:expense.version+1,amountMinor:610000})]));
      expect(await ledger()).toEqual(originalLedger);
      expect(writes.slice(count)).toEqual([path,path]);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: prepara, registra, actualiza y cancela acuerdos sin inventar cobros ni despachos',async({page,context,request},info)=>{
  test.setTimeout(110000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate(),marker=randomUUID().slice(0,8),root='/api/admin/orders';
    const product=await store.save('products',{...emptyRecord('products'),title:`Referencia de acuerdo ${marker}`,slug:`acuerdo-${marker}`,status:'draft',price:31000,presentation:'Unidad',orderable:true,stockQuantity:21},null,null,actor);
    const stock=()=>store.get('products',product.id),writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:orders|business|finance)(?:\/|$)/.test(path))writes.push([req.method(),path]);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const editor=page.locator('dialog[open].editor-drawer');
      const field=name=>editor.locator(`[name="${name}"]`);
      const button=name=>editor.getByRole('button',{name,exact:true});
      const customer=`Destinatario de acuerdo ${marker} ${via}`;
      const count=writes.length, beforeStock=await stock();
      async function focus(id,query,target,inside=true){
        if(via==='panel')return;
        if(inside)await button('Ayúdame con este formulario').click();
        let overlay=inside?page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true}):await openAli(page);
        if(via==='chat'){
          await askAliCatalog(overlay,`¿Dónde está ${query}?`);
          await expect(overlay.locator(`[data-capability-id="${id}"]`).last()).toBeVisible();
        }else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(overlay).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
      }
      async function submit(title,method,path){
        const wait=page.waitForResponse(res=>res.request().method()===method&&new URL(res.url()).pathname===path);
        await button(title).click();
        const res=await wait;
        expect(res.ok(),await res.text()).toBe(true);
        return {result:await res.json(),payload:res.request().postDataJSON()};
      }
      await page.goto(via==='panel'?'/admin?section=orders&tab=list':'/admin');
      if(via==='panel')await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();
      await focus('orders.prepare-order','armar pedido',field('customerName'),false);
      await field('customerName').fill(customer);
      await field('phone').fill('3001234567');
      await field('city').fill('Bogotá');
      await field('department').fill('Bogotá');
      await field('address').fill('Dirección de prueba sin destinatario real');
      await field('placedOn').fill(day);
      await button('Agregar referencia').click();
      await field('item-0').selectOption(`products:${product.id}`);
      await field('quantity-0').fill('2');
      await focus('orders.create-order','crear pedido',button('Crear pedido'));
      await expect(field('customerName')).toHaveValue(customer);
      expect(await stock()).toEqual(beforeStock);
      expect(writes).toHaveLength(count);
      const created=await submit('Crear pedido','POST',root),orderId=created.result.id,path=`${root}/${orderId}`;
      expect(created.result).toMatchObject({customerName:customer,status:'new',totalMinor:6200000,shipments:[],collections:[]});
      const fetch=()=>store.order(orderId);
      expect(await fetch()).toEqual(created.result);
      expect(await store.saveOrder(created.payload,actor)).toEqual(created.result);
      expect((await stock()).stockReserved).toBe(beforeStock.stockReserved+2);
      const open=()=>page.goto(`/admin?section=orders&tab=list&record=${orderId}`);
      await open();
      await field('city').fill('Soacha');
      await focus('orders.update-order','editar destinatario',button('Guardar cambios'));
      await expect(field('city')).toHaveValue('Soacha');
      expect((await fetch()).city).toBe('Bogotá');
      const updated=await submit('Guardar cambios','PUT',path);
      expect(updated.result).toMatchObject({id:orderId,city:'Soacha',version:created.result.version+1,totalMinor:6200000});
      await open();
      await focus('orders.mark-preparing','marcar preparando',field('status'));
      await expect(field('status')).toHaveValue('new');
      await field('status').selectOption('preparing');
      expect((await fetch()).status).toBe('new');
      const prepared=await submit('Guardar cambios','PUT',path);
      expect(prepared.result.history).toEqual(expect.arrayContaining([expect.objectContaining({previousStatus:'new',nextStatus:'preparing'})]));
      expect(prepared.result.shipments).toEqual([]);
      await open();
      await focus('orders.cancel-order','anular pedido no despachado',field('status'));
      await expect(field('status')).toHaveValue('preparing');
      await field('status').selectOption('cancelled');
      await field('statusReason').fill('El cliente desistió antes del despacho de prueba');
      await field('cancellationOn').fill(day);
      await focus('orders.cancel-order','anular pedido no despachado',editor.locator('[data-advisor-control="order-cancellation"]'));
      await expect(field('statusReason')).toHaveValue('El cliente desistió antes del despacho de prueba');
      expect((await fetch()).status).toBe('preparing');
      expect((await stock()).stockReserved).toBe(beforeStock.stockReserved+2);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-acuerdo-cancelar-con-motivo');
      const cancelled=await submit('Guardar cambios','PUT',path);
      expect(cancelled.result).toMatchObject({id:orderId,status:'cancelled',collections:[],shipments:[],returns:[{kind:'cancellation',occurredOn:day,reason:'El cliente desistió antes del despacho de prueba'}]});
      expect(await fetch()).toEqual(cancelled.result);
      const restored=await stock();
      expect([restored.stockQuantity,restored.stockReserved]).toEqual([beforeStock.stockQuantity,beforeStock.stockReserved]);
      expect(writes.slice(count)).toEqual([['POST',root],['PUT',path],['PUT',path],['PUT',path]]);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: conserva las hojas y el mapa de Excel hasta guardar el borrador',async({page,context,request},info)=>{
  test.setTimeout(115000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),marker=randomUUID().slice(0,8),writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname,method=req.method();
      if(path.startsWith('/api/admin/imports/')&&!['GET','HEAD'].includes(method))writes.push([method,path]);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Columnas ${marker} ${via}`},actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const batch=await prepareAdvisorImportBatch(store,{sourceId:source.id,actorId:actor,extraIssue:true});
      const saved=()=>getImportBatch(store,batch.id),count=writes.length,path=`/api/admin/imports/${batch.id}`;
      const expenses=()=>store.db.all(`SELECT id FROM ${store.t('expenses')} WHERE data::jsonb->>'sourceId'=?`,[source.id]);
      const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
      const button=(name,root=wizard)=>root.getByRole('button',{name,exact:true});
      const sheetCard=name=>wizard.locator(`[data-import-sheet="${name}"]`);
      const mapping=wizard.getByRole('region',{name:'Asignación de columnas',exact:true});
      const search=mapping.getByRole('searchbox',{name:'Buscar columnas',exact:true});
      const save=button('Guardar borrador');
      async function arrive(id,q,target){
        if(via==='panel'){await expect(target).toBeVisible();return;}
        let overlay=await openAli(page);
        if(via==='chat')await askAliCatalog(overlay,`¿Dónde está ${q}?`);
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(overlay).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
      }
      await page.goto(`/admin?section=orders&tab=imports&batch=${batch.id}`);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      if(via==='panel')await button('2. Hojas y columnas').click();
      await arrive('imports.choose-sheet','excluir hoja',wizard.getByRole('heading',{name:'Elige qué importar de cada hoja',exact:true}));
      const excluded=sheetCard('A C4'),main=sheetCard('Gastos C4');
      await excluded.getByRole('button',{name:/^No importar esta hoja\s*:/}).click({timeout:8000});
      await expect(excluded).toContainText('Excluida');
      await button('Configurar Gastos C4',main).click();
      await arrive('imports.configure-sheet','formato de fechas de excel',wizard.locator('[data-advisor-control="import-sheet-structure"]'));
      await wizard.locator('summary').filter({hasText:/^Cómo leer fechas y números/}).click();
      const dateFormat=wizard.getByRole('combobox',{name:/^Orden explícito de las fechas/});
      await expect(dateFormat).toHaveValue('ISO');
      await dateFormat.selectOption('DMY');
      const cutoff=wizard.getByLabel('Este archivo está actualizado hasta…',{exact:true});
      await arrive('imports.confirm-file-cutoff','fecha de corte del excel',cutoff);
      await expect(cutoff).toHaveValue('');
      await cutoff.fill('2026-09-06');
      await button('Confirmar corte para hojas elegidas').click();
      const confirmation=page.getByRole('dialog',{name:'Confirmar corte del archivo',exact:true});
      await expect(confirmation).toContainText('Gastos C4');
      await expect(confirmation).not.toContainText('A C4');
      await confirmation.getByRole('button',{name:'Confirmar este corte',exact:true}).click();
      const identity=wizard.getByRole('checkbox',{name:/^Generar identidad técnica para cada gasto/});
      await arrive('imports.confirm-sheet-identity','generar identidad por fila',identity);
      await expect(identity).not.toBeChecked();
      await identity.check();
      await arrive('imports.filter-columns','columnas sin decidir',search);
      await search.fill('Concepto');
      const col=mapping.getByRole('button',{name:'Destino de columna 3',exact:true});
      await expect(col).toBeVisible();
      await expect(mapping.getByRole('button',{name:'Destino de columna 4',exact:true})).toHaveCount(0);
      await arrive('imports.map-columns','ignorar columna',mapping.getByRole('heading',{name:'Asignación de columnas',exact:true}));
      await expect(search).toHaveValue('Concepto');
      await col.click();
      const picker=page.getByRole('dialog',{name:/^Asignar columna C/});
      await button('Ignorar esta columna',picker).click();
      await expect(col).toContainText('Ignorada');
      const fixed=wizard.locator('summary').filter({hasText:/^Valores comunes de esta hoja$/});
      await arrive('imports.configure-fixed-values','constantes de importación',fixed);
      await fixed.click();
      const supplier=wizard.getByRole('textbox',{name:/^Proveedor/});
      await expect(supplier).toHaveValue('');
      await supplier.fill('Proveedor fijo sintético');
      await arrive('imports.save-draft','guardar correcciones del excel',save);
      const persisted=await saved();
      expect(persisted.version).toBe(batch.version);
      expect(persisted.preview.previewHash).toBe(batch.preview.previewHash);
      expect(persisted.config).toEqual(batch.config);
      expect(await expenses()).toEqual([]);
      expect(writes).toHaveLength(count);
      if(via==='directorio')await screenshot(page,info,'advisor-c6-excel-guardar-mapeo');
      const wait=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===path);
      await save.click();
      const response=await wait;
      expect(response.ok(),await response.text()).toBe(true);
      const result=await saved();
      expect(result).toMatchObject({id:batch.id,version:batch.version+1,preview:null,acceptedRevision:null,fileHash:batch.fileHash});
      expect(result.config.sheets).toEqual(expect.arrayContaining([expect.objectContaining({sheetName:'A C4',enabled:false,reportAsOf:batch.config.sheets.find(sheet=>sheet.sheetName==='A C4').reportAsOf}),expect.objectContaining({sheetName:'Gastos C4',dateFormat:'DMY',reportAsOf:'2026-09-06',identityMode:'generated',columns:expect.arrayContaining([expect.objectContaining({index:2,destination:'ignore'})])})]));
      expect(result.config.sheets.find(sheet=>sheet.sheetName==='Gastos C4').defaults.expenseSupplier).toBe('Proveedor fijo sintético');
      expect(writes.slice(count)).toEqual([['PUT',path]]);
      expect(await expenses()).toEqual([]);
      await page.reload();
      await button('2. Hojas y columnas').click();
      await button('Configurar Gastos C4',sheetCard('Gastos C4')).click();
      await expect(sheetCard('A C4')).toContainText('Excluida');
      await expect(mapping.getByRole('button',{name:'Destino de columna 3',exact:true})).toContainText('Ignorada');
      const profile=wizard.getByRole('region',{name:'Guardar configuración reutilizable'});
      const openProfile=profile.locator('summary');
      await arrive('imports.save-profile','crear perfil de columnas',openProfile);
      expect(await listResources(store,'profiles',{source:source.id})).toEqual([]);
      await openProfile.click();
      const profileName=`Mapa reutilizable ${marker} ${via}`;
      await profile.getByRole('textbox',{name:'Nombre de la configuración',exact:true}).fill(profileName);
      const stored=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname==='/api/admin/business/profiles');
      await button('Guardar configuración',profile).click();
      expect((await stored).ok()).toBe(true);
      await expect(wizard.getByText(/guardado para próximas cargas/)).toBeVisible();
      const [configured]=await listResources(store,'profiles',{source:source.id});
      expect(configured).toMatchObject({name:profileName,sourceId:source.id});
      expect(configured.sheets.find(sheet=>sheet.sheetName==='Gastos C4').defaults.expenseSupplier).toBe('Proveedor fijo sintético');
      expect(await saved()).toMatchObject({profileId:configured.id,fileHash:batch.fileHash,preview:null,acceptedRevision:null});
      expect(await expenses()).toEqual([]);
      const heading=wizard.locator('summary').filter({hasText:/^Encabezado y muestras de esta hoja$/});
      await heading.click();
      const headerRow=wizard.getByRole('spinbutton',{name:'Fila de encabezados',exact:true});
      await headerRow.fill('2');
      const sample=button('Leer muestras de esta hoja y encabezado');
      const beforeSample=await saved();
      await arrive('imports.inspect-samples','leer muestras de excel',sample);
      expect((await saved()).version).toBe(beforeSample.version);
      await sample.click();
      await expect.poll(async()=>{
        await processImportTurn(store,{batchId:batch.id,expectedPhase:'inspect'});
        const fresh=await saved();
        return fresh.workbook?.inspections?.find(item=>item.sheetName==='Gastos C4'&&Number(item.headerRow)===2)?.rows?.find(row=>row.rowNumber===2)?.cells?.[0]?.value;
      },{timeout:20000}).toBe('C4-OK');
      await expect(sample).toBeDisabled();
      const discard=button('Descartar archivo');
      await arrive('imports.cancel-batch','detener lote excel',discard);
      const beforeDiscard=await saved(),beforeRequests=writes.length;
      await discard.click();
      const decision=page.getByRole('dialog',{name:'Descartar archivo',exact:true});
      await expect(decision).toContainText('El original se descartará de forma irreversible');
      await expect(decision).toContainText(batch.filename);
      await decision.getByRole('button',{name:'Volver sin cambios',exact:true}).last().click();
      expect(writes).toHaveLength(beforeRequests);
      expect((await saved()).version).toBe(beforeDiscard.version);
      await discard.click();
      await decision.getByRole('button',{name:'Descartar original y cancelar',exact:true}).click();
      await expect(wizard.getByText('Archivo descartado',{exact:true})).toBeVisible();
      expect(writes.slice(beforeRequests)).toEqual([['POST',`${path}/cancel`]]);
      expect(await saved()).toMatchObject({fileHash:batch.fileHash,fileDiscarded:true,state:'cancelled',cancellation:{originalDiscarded:true,appliedGroups:0}});
      expect((await page.request.get(`${path}/file`)).status()).toBe(404);
      expect(await expenses()).toEqual([]);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: guía las vigencias de sueldo y comisión de la persona exacta sin pagar',async({page,context,request},info)=>{
  test.setTimeout(180000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store), year=completedFixtureYear(), code=randomUUID().slice(0,7);
    const peoplePath='/api/admin/business/people', href='/admin?section=business&tab=people';
    const priorStart=`${year}-08-01`, priorEnd=`${year}-08-31`, activeStart=`${year}-09-01`, payrollEnd=`${year}-10-01`, lastDay=`${year}-10-31`, newStart=`${year}-11-01`;
    const operations=[
      {verb:'salary-end',query:'terminar convenio de sueldo',title:'Cerrar una vigencia de sueldo guardada',button:'Abrir convenios guardados',focus:'settings-person-salary-end-date'},
      {verb:'salary-add',query:'agregar convenio',title:'Agregar un convenio de sueldo',button:'Abrir formulario de sueldo',focus:'settings-person-new-salary'},
      {verb:'commission-add',query:'nueva vigencia de comisión',title:'Agregar una vigencia de comisión particular',button:'Abrir formulario de comisión',focus:'settings-person-new-commission'},
    ];
    const editor=page.getByRole('dialog',{name:'Editar persona',exact:true});
    const name=editor.getByLabel('Nombre',{exact:true}), reason=editor.getByLabel('Motivo del cambio',{exact:true});
    const save=editor.getByRole('button',{name:'Guardar persona',exact:true});
    const marker=(root,focus)=>root.locator(`[data-advisor-control="${focus}"]`);
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(/^\/api\/admin\/(business|finance)(?:\/|$)/.test(path)&&!['GET','HEAD','OPTIONS'].includes(req.method()))writes.push({path,method:req.method()});
    });
    async function readPerson(id){
      const response=await page.request.get(`${peoplePath}/${id}`);
      expect(response.status()).toBe(200);
      return response.json();
    }
    async function financialFacts(id,confirmedEnd){
      const personRows=table=>store.db.all(`SELECT * FROM ${store.t(table)} WHERE person_id=? ORDER BY id`,[id]);
      return Promise.all([
        personRows('payroll_periods'),
        // The scheduler accrues later salary days independently of these edits.
        store.db.all(`SELECT * FROM ${store.t('expenses')} WHERE person_id=? AND incurred_on<? ORDER BY id`,[id,confirmedEnd]),
        personRows('commission_entries'),
        store.db.all(`SELECT p.* FROM ${store.t('expense_payments')} p JOIN ${store.t('expenses')} e ON e.id=p.expense_id WHERE e.person_id=? ORDER BY p.id`,[id]),
        store.db.all(`SELECT * FROM ${store.t('cash_entries')} WHERE (data::jsonb->>'personId')=? ORDER BY id`,[id]),
      ]);
    }
    async function handoff(operation,via,target,inside=false){
      let entry;
      if(inside){
        await editor.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        entry=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      }else entry=await openAli(page);
      if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${operation.query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(operation.query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="business.${operation.verb}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
      await expect(entry).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
    }
    const decoy=await saveResource(store,'people',{requestId:randomUUID(),name:`Otra persona sin convenio ${code}`},actor);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      let person=await saveResource(store,'people',{requestId:randomUUID(),name:`Vigencias internas ${code} ${via}`,
        salaryAgreements:[
          {id:randomUUID(),enabled:true,amountPerPeriodMinor:21000000,frequency:'weekly',effectiveFrom:priorStart,effectiveTo:priorEnd,payDayOffset:2},
          {id:randomUUID(),enabled:true,amountPerPeriodMinor:125000000,frequency:'monthly',effectiveFrom:activeStart,payDayOffset:2},
        ],commissionOverrides:[{id:randomUUID(),effectiveOn:priorStart,enabled:true,mode:'percent',rateBps:420,earnWhen:'delivered'}],
      },actor);
      const payroll=await confirmPayroll(store,{requestId:randomUUID(),personId:person.id,startOn:activeStart,endOnExclusive:payrollEnd,bonusMinor:0,discountMinor:0},actor);
      expect(payroll).toMatchObject({state:'confirmed',paidMinor:0});
      const facts=await financialFacts(person.id,payrollEnd);
      expect(facts[0]).toHaveLength(1);
      expect(JSON.parse(facts[0][0].data).salaryAgreements).toEqual(person.salaryAgreements);
      expect(facts[1].length).toBeGreaterThan(0);
      expect(facts.slice(2)).toEqual([[],[],[]]);
      for(const operation of operations)await test.step(operation.verb,async()=>{
        const path=`${peoplePath}/${person.id}`, before=writes.length, previous=person;
        const savedRequest=()=>page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===path);
        async function submit(status){
          const pending=savedRequest();
          await save.click();
          const response=await pending;
          expect(response.status(),await response.text()).toBe(status);
          expect(response.request().postDataJSON()).toMatchObject({version:previous.version});
          return response.json();
        }
        await page.goto(via==='panel'?href:'/admin');
        const workspace=page.getByRole('region',{name:'Configuración del negocio',exact:true});
        const picker=marker(workspace,`${operation.focus}-person`), target=marker(editor,operation.focus);
        if(via==='panel')await workspace.getByText(operation.title,{exact:true}).click();
        else await handoff(operation,via,picker);
        await expect(page).toHaveURL(/\/admin\?section=business&tab=people$/);
        await expect(picker).toHaveValue('');
        const open=workspace.getByRole('button',{name:operation.button,exact:true});
        await expect(open).toBeDisabled();
        if(operation.verb==='salary-end')await expect(picker.getByRole('option',{name:`${decoy.name} · Activa`,exact:true})).toHaveCount(0);
        await picker.selectOption(person.id);
        await expect(editor).toHaveCount(0);
        expect(writes).toHaveLength(before);
        await open.click();
        await expect(editor).toHaveAttribute('data-person-id',person.id);
        await expect(name).toHaveValue(person.name);
        await expect(target).toBeFocused();
        await expect(editor.getByRole('button',{name:/^Quitar (?:convenio|vigencia) nuev[oa]$/})).toHaveCount(0);
        const change=`Vigencia elegida ${operation.verb} ${via}`;
        await reason.fill(change);
        if(via!=='panel')await handoff(operation,via,target,true);
        await expect(reason).toHaveValue(change);
        expect(await readPerson(person.id)).toEqual(previous);
        expect(writes).toHaveLength(before);
        if(via==='directorio')await screenshot(page,info,`advisor-c6-${operation.focus}`);
        let nextSalary=previous.salaryAgreements, nextCommission=previous.commissionOverrides, attempts=1;
        if(operation.verb==='salary-end'){
          const dates=editor.getByLabel('Último día de vigencia (opcional)',{exact:true});
          await expect(dates).toHaveCount(2);
          await expect(dates.nth(0)).toHaveValue(priorEnd);
          await expect(dates.nth(1)).toHaveValue('');
          await expect(dates.nth(0)).not.toBeFocused();
          await expect(dates.nth(1)).not.toBeFocused();
          const end=editor.getByRole('group',{name:'Convenio 2 · guardado',exact:true}).getByLabel('Último día de vigencia (opcional)',{exact:true});
          await end.fill(priorEnd);
          expect(await end.evaluate(input=>input.validity.rangeUnderflow)).toBe(true);
          await save.click();
          expect(writes).toHaveLength(before);
          await end.fill(lastDay);
          await reason.clear();
          await save.click();
          expect(writes).toHaveLength(before);
          await reason.fill(change);
          nextSalary=[previous.salaryAgreements[0],{...previous.salaryAgreements[1],effectiveTo:lastDay}];
        }else if(operation.verb==='salary-add'){
          await target.click();
          const amount=editor.getByLabel('Sueldo por período (COP)',{exact:true});
          await expect(amount).toHaveValue('');
          await save.click();
          expect(writes).toHaveLength(before);
          await editor.getByRole('button',{name:'Quitar convenio nuevo',exact:true}).click();
          await expect(amount).toHaveCount(0);
          await target.click();
          await amount.fill('270000,25');
          await editor.getByRole('combobox',{name:'Frecuencia',exact:true}).selectOption('halfmonthly',{timeout:8000});
          await editor.getByRole('spinbutton',{name:'Días después del período para pagar',exact:true}).fill('5');
          const start=editor.locator('label').filter({hasText:'Vigente desde'}).locator('input[type="date"]');
          await start.fill(activeStart);
          const rejected=await submit(400);
          expect(rejected.error).toMatch(/no pueden superponerse/i);
          expect(await readPerson(person.id)).toEqual(previous);
          await start.fill(newStart);
          attempts++;
          nextSalary=[...previous.salaryAgreements,{id:expect.any(String),enabled:true,amountPerPeriodMinor:27000025,frequency:'halfmonthly',effectiveFrom:newStart,effectiveTo:null,payDayOffset:5}];
        }else{
          await target.click();
          const start=editor.locator('label').filter({hasText:'Vigente desde'}).locator('input[type="date"]');
          const enabled=editor.getByRole('checkbox',{name:'Generar comisión para ventas con vendedor',exact:true});
          await enabled.check();
          const rate=editor.getByLabel('Comisión (%)',{exact:true});
          await rate.fill('100,01');
          await expect(save).toBeDisabled();
          expect(writes).toHaveLength(before);
          const disabled=via==='directorio';
          if(disabled){
            await rate.fill('0');
            await enabled.uncheck();
          }else{
            await rate.fill('5,25');
            await editor.getByRole('combobox',{name:'Cuándo se gana',exact:true}).selectOption('customer_paid',{timeout:8000});
          }
          await start.fill(priorStart);
          const rejected=await submit(400);
          expect(rejected.error).toMatch(/vigencia de comisión repetida/i);
          expect(await readPerson(person.id)).toEqual(previous);
          await start.fill(newStart);
          attempts++;
          nextCommission=[...previous.commissionOverrides,{id:expect.any(String),enabled:!disabled,mode:'percent',rateBps:disabled?0:525,fixedMinor:0,basis:'net_products',earnWhen:disabled?'business_received':'customer_paid',effectiveOn:newStart}];
        }
        person=await submit(200);
        await expect(editor).toHaveCount(0);
        expect(person).toMatchObject({id:previous.id,version:previous.version+1,name:previous.name,active:previous.active,userId:previous.userId});
        expect(person.salaryAgreements).toEqual(nextSalary);
        expect(person.commissionOverrides).toEqual(nextCommission);
        if(operation.verb==='salary-add')expect(previous.salaryAgreements.some(row=>row.id===person.salaryAgreements.at(-1).id)).toBe(false);
        if(operation.verb==='commission-add')expect(previous.commissionOverrides.some(row=>row.id===person.commissionOverrides.at(-1).id)).toBe(false);
        expect(writes.slice(before)).toEqual(Array.from({length:attempts},()=>({path,method:'PUT'})));
        expect(await readPerson(person.id)).toEqual(person);
        const rows=await store.db.all(`SELECT actor_id,data FROM ${store.t('business_audit')} WHERE entity_type=? AND entity_id=?`,['people',person.id]);
        expect(rows).toHaveLength(person.version);
        const row=rows.find(item=>JSON.parse(item.data).next.version===person.version);
        expect(row?.actor_id).toBe(actor);
        expect(JSON.parse(row.data)).toEqual({previous,next:person,reason:change,source:'manual'});
        expect(await financialFacts(person.id,payrollEnd)).toEqual(facts);
      });
    });
    expect(await readPerson(decoy.id)).toEqual(decoy);
    expect(writes).toHaveLength(15);
  }finally{await store.close();}
});

test('Ali @advisor-c6: cuenta, presupuesto y audiencia pagada se preparan localmente', async ({ page, context, request }, info) => {
  test.setTimeout(180000);
  const app = new URL(info.project.use.baseURL), env = testDatabaseEnv();
  if (app.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(app.hostname) ||
      !['db', 'localhost', '127.0.0.1'].includes(new URL(env.DATABASE_URL).hostname) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('Fixture local HTTPS y PostgreSQL TLS obligatorio.');
  const root = '/api/admin/social', writes = [], forbidden = [];
  let permitted;
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.origin === app.origin && (!url.pathname.startsWith(`${root}/`) || ['GET', 'HEAD'].includes(method))) return route.continue();
    if (url.origin === app.origin && method === 'PATCH' && url.pathname === permitted) {
      writes.push(req.postDataJSON());
      permitted = undefined;
      return route.continue();
    }
    forbidden.push(`${method} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await loginWithAdvisorFixture(page, request);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const store = await openStore(env);
  try {
    expect((await store.db.get('SELECT current_database() AS name')).name).toBe('allnutrition_test');
    const actor = await fixtureActor(context, store), marker = randomUUID().slice(0, 8), now = new Date().toISOString();
    async function connection(name, currency, readOnly = false) {
      const id = randomUUID();
      await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: 'api', state: 'connected', version: 1,
        created_at: now, updated_at: now, data: JSON.stringify({ name: `${name} ${marker}`, currency, timeZone: 'America/Bogota',
          authenticationMethod: readOnly ? 'token' : 'oauth', readOnly, capabilities: { facebookPublish: !readOnly, adsPublish: !readOnly, insights: true } }) });
      trackFixtureConnection(info,id);
      return id;
    }
    const cop = await connection('Cuenta pesos', 'COP'), usd = await connection('Cuenta dólares', 'USD'), token = await connection('Cuenta token', 'USD', true);
    const draft = (suffix, config = {}) => saveSocialCampaign(store, { requestId: randomUUID(), name: `Audiencia ${marker} ${suffix}`, version: 0,
      mode: 'paid', objective: 'engagement', connectionId: cop, marketCountries: ['CO'], ...config }, actor);
    const row = id => store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [id]);
    const jobs = () => store.db.all(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'social:%' ORDER BY key`);
    const baselineJobs = await jobs();
    const contrast = await draft('contraste', { mode: 'organic' }), contrastBefore = await row(contrast.id);
    const missingMarkets = await draft('sin mercado', { marketCountries: [] }), missingBefore = await row(missingMarkets.id);
    const href = id => `/admin?${new URLSearchParams({ section: 'advertising', tab: 'campaigns', record: id })}`;
    async function entry(via, action, query) {
      let dialog = await openAli(page);
      const selector = `[data-capability-id="advertising.${action}"]`;
      if (via === 'chat') await askAliCatalog(dialog, `¿Dónde encuentro ${query}?`);
      else {
        await dialog.getByRole('button', { name: '¿Qué quieres hacer?', exact: true }).click();
        dialog = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
        await dialog.getByLabel('Área').selectOption('advertising');
        await dialog.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
        await dialog.getByRole('button', { name: 'Buscar', exact: true }).click();
      }
      await dialog.locator(selector).last().getByRole('button', { name: /^Abrir en el panel:/ }).click();
      return dialog;
    }
    async function arrive(via, id, action, query, target) {
      if (via !== 'panel') {
        const dialog = await entry(via, action, query);
        await expect(dialog).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport();
      }
      await expect(target).toBeVisible();
      await expect(page).toHaveURL(url => url.searchParams.get('record') === id);
    }
    async function confirmDraft(path, control) {
      permitted = path;
      const response = page.waitForResponse(res => new URL(res.url()).pathname === path && res.request().method() === 'PATCH');
      await control.click();
      const updated = await response;
      expect(updated.ok(), await updated.text()).toBe(true);
    }
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const saved = await draft(via, { budgetMinor: 1000000 }), before = await row(saved.id), count = writes.length;
      await page.goto(href(saved.id));
      const editor = page.locator(`[data-campaign-draft-editor="${saved.id}"]`);
      await expect(editor.getByRole('heading', { name: `Audiencia ${marker} ${via}`, exact: true, level: 2 })).toBeVisible();
      const button = name => editor.getByRole('button', { name, exact: true });
      const heading = name => editor.getByRole('heading', { name, exact: true });
      const account = editor.getByRole('combobox', { name: 'Cuenta conectada', exact: true });
      const total = editor.locator('[name=budgetMinor]');
      const message = editor.locator('[name=caption]'), text = `Texto local todavía sin guardar ${marker} ${via}`;
      await message.fill(text);
      if (via !== 'panel') await button('Continuar a revisión').click();
      await arrive(via, saved.id, 'choose-connection', 'seleccionar conexión', account);
      await expect(account).toHaveValue(cop);
      await expect(account.locator(`option[value="${token}"]`)).toHaveText(/Conectada.*Solo lectura.*USD/);
      await expect(account.locator(`option[value="${usd}"]`)).toHaveText(/Conectada.*USD/);
      await account.selectOption(token);
      await expect(editor.getByText(/La cuenta elegida es de solo lectura/).first()).toBeVisible();
      await expect(editor.getByRole('status').filter({ hasText: 'Cambió la moneda' })).toBeVisible();
      await account.selectOption(usd);
      await expect(message).toHaveValue(text);
      await arrive(via, saved.id, 'plan-paid-budget', 'presupuesto y agenda', heading('Presupuesto y agenda'));
      const schedule = heading('Presupuesto y agenda').locator('..');
      await expect(schedule.getByText('USD', { exact: true })).toBeVisible();
      await expect(schedule.getByText('America/Bogota', { exact: true })).toBeVisible();
      await expect(total).toBeDisabled();
      expect(await row(saved.id)).toEqual(before);
      expect(writes).toHaveLength(count);
      const path = `${root}/campaigns/${saved.id}`;
      await confirmDraft(path, button('Guardar cuenta y borrador'));
      await expect(total).toBeEnabled();
      expect(writes).toHaveLength(count + 1);
      expect(await getSocialCampaign(store, saved.id)).toMatchObject({ connectionId: usd, budgetMinor: 0, targetCostMinor: null, caption: text, state: 'draft' });
      const accountSaved = await row(saved.id);
      await total.fill('230,50');
      await schedule.locator('summary').filter({ hasText: 'Opciones de inversión' }).click();
      await schedule.locator('[name=targetCostMinor]').fill('12,75');
      const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      await schedule.locator('[name=startAt]').fill(`${day(5)}T10:00`);
      await schedule.locator('[name=endAt]').fill(`${day(12)}T16:30`);
      await arrive(via, saved.id, 'choose-audience-mode', 'definir yo o sin personalizar', heading('¿Cómo quieres definir la audiencia?'));
      await expect(button('Definir yo')).toHaveAttribute('aria-pressed', 'false');
      await button('Sin personalizar').click();
      await expect(button('Sin personalizar')).toHaveAttribute('aria-pressed', 'true');
      if (via !== 'panel') {
        await arrive(via, saved.id, 'define-manual-audience', 'segmentación manual', heading('¿Cómo quieres definir la audiencia?'));
        await expect(button('Sin personalizar')).toHaveAttribute('aria-pressed', 'true');
      }
      const manualSummary = editor.locator('summary').filter({ hasText: /^Segmentación manual$/ });
      const manual = manualSummary.locator('..');
      await expect(manual).toHaveCount(0);
      expect(await row(saved.id)).toEqual(accountSaved);
      expect(writes).toHaveLength(count + 1);
      await button('Definir yo').click();
      const country = editor.getByRole('combobox', { name: 'País completo', exact: true });
      await expect(manual).toHaveJSProperty('open', true);
      if (via !== 'panel') {
        await manualSummary.click();
        await expect(manual).toHaveJSProperty('open', false);
      }
      await arrive(via, saved.id, 'define-manual-audience', 'segmentación manual', country);
      await expect(country.locator('option')).toHaveCount(2);
      await country.selectOption('CO');
      await button('Añadir país completo').click();
      const min = editor.locator('[name=ageMin]'), max = editor.locator('[name=ageMax]');
      await expect(min).toHaveAttribute('min', '18');
      await expect(max).toHaveAttribute('max', '65');
      await min.fill('27');
      await max.fill('54');
      await button('Elegir géneros').click();
      const genders = page.getByRole('dialog', { name: /Géneros/ });
      await genders.getByRole('checkbox', { name: 'Mujeres', exact: true }).check();
      await genders.getByRole('button', { name: 'Aplicar', exact: true }).click();
      await expect(button('Elegir géneros')).toHaveAccessibleDescription('Mujeres');
      expect(await row(saved.id)).toEqual(accountSaved);
      expect(writes).toHaveLength(count + 1);
      await confirmDraft(path, button('Guardar borrador').first());
      expect(writes).toHaveLength(count + 2);
      expect(writes.at(-1)).toMatchObject({ budgetMinor: 23050, targetCostMinor: 1275, connectionId: usd, caption: text });
      const detail = await getSocialCampaign(store, saved.id);
      expect(detail).toMatchObject({ state: 'draft', mode: 'paid', connectionId: usd, caption: text, marketCountries: ['CO'], audienceMode: 'manual',
        audience: { countries: ['CO'], regions: [], cities: [], interests: [], ageMin: 27, ageMax: 54, genders: [2] }, budgetMinor: 23050, targetCostMinor: 1275,
        startAt: writes.at(-1).startAt, endAt: writes.at(-1).endAt, deliveries: [], operations: [], revisions: [] });
      await page.reload();
      await expect(heading(detail.name)).toBeVisible();
      await expect(account).toHaveValue(usd);
      await expect(min).toHaveValue('27');
      await expect(button('Quitar país CO')).toBeVisible();
      const shared = editor.locator('[aria-label="Datos que se enviarán"]');
      if (via === 'panel') {
        const disclosure = shared.locator('..');
        await expect(disclosure).toBeAttached();
        if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
      }
      await arrive(via, saved.id, 'review-audience-sharing', 'revisar consentimiento de segmentación', shared);
      const disclosure = shared.locator('..');
      await expect(disclosure).toContainText('openai-compatible · fixture-a');
      await expect(shared).toContainText('Mercados: Colombia (CO)');
      await expect(shared).toContainText('27–54 años');
      await expect(disclosure.getByRole('checkbox', { name: /^Autorizo esta consulta/ })).not.toBeChecked();
      await expect(disclosure.getByRole('button', { name: 'Solicitar recomendaciones', exact: true })).toBeDisabled();
      expect(await store.db.get(`SELECT id FROM ${store.t('social_audience_requests')} WHERE campaign_id=? LIMIT 1`, [saved.id])).toBeFalsy();
      if (via !== 'panel') await screenshot(page, info, `advisor-c6-audiencia-${via}`);
    });
    await page.goto(href(missingMarkets.id));
    const marketTrigger = page.locator(`[data-campaign-draft-editor="${missingMarkets.id}"]`).getByRole('button', { name: 'Elegir mercados', exact: true });
    await arrive('directorio', missingMarkets.id, 'choose-audience-mode', 'definir yo o sin personalizar', marketTrigger);
    expect(await row(missingMarkets.id)).toEqual(missingBefore);
    await page.goto(href(contrast.id));
    await entry('directorio', 'plan-paid-budget', 'presupuesto y agenda');
    await expect(page.getByText(/Abre un borrador pagado/).first()).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get('record') === contrast.id);
    expect(await row(contrast.id)).toEqual(contrastBefore);
    expect(await jobs()).toEqual(baselineJobs);
    expect(permitted).toBeUndefined();
    expect(writes).toHaveLength(6);
    expect(forbidden).toEqual([]);
  } finally { await store.close(); }
});

test('Ali @advisor-c6: permite empezar otra consulta y conserva la aclaración anterior',async({page,request},info)=>{
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await page.goto('/admin');
  const turns=[];
  page.on('request',req=>{
    if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/admin/assistant/turns')turns.push(req.postDataJSON());
  });
  const chat=await openAli(page), question=chat.getByRole('textbox',{name:'¿Cuál de estas acciones quieres revisar?',exact:true});
  const history=chat.getByRole('region',{name:'Conversaciones anteriores',exact:true});
  const heading=history.getByRole('heading',{name:'Conversaciones',exact:true});
  const newConversation=chat.getByRole('button',{name:'Nueva conversación',exact:true});
  const composer=chat.getByRole('textbox',{name:'Mensaje para Ali',exact:true});
  const original='¿Dónde encuentro devolución comercial?';
  const originalTurn=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname==='/api/admin/assistant/turns');
  await askAli(chat,original);
  const {threadId:originalId}=await (await originalTurn).json();
  expect(originalId).toBeTruthy();
  await expect(question).toBeFocused();
  const another=chat.getByRole('button',{name:'Empezar otra consulta',exact:true});
  await expect(another).toBeInViewport({ratio:1});
  await screenshot(page,info,'advisor-c6-ali-otra-consulta');
  await another.click();
  await expect(composer).toBeFocused();
  await expect(question).toHaveCount(0);
  expect(turns).toHaveLength(1);
  await askAli(chat,'¿Dónde hago un arqueo?');
  await expect(chat.locator('[data-capability-id="cash.close-day"]')).toBeVisible();
  expect(turns).toHaveLength(2);
  expect(turns.map(turn=>[turn.threadId,turn.answer])).toEqual([[null,null],[null,null]]);
  await showChatHistory(chat);
  const originalRequest=page.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===`/api/admin/assistant/threads/${originalId}`);
  const originalRow=history.getByRole('button',{name:original,exact:true}).first();
  await originalRow.click();
  expect((await originalRequest).ok()).toBe(true);
  await expect(question).toBeFocused();
  const transcript=chat.getByRole('article').filter({has:page.getByText('Tú',{exact:true})});
  await expect(transcript.getByText(original,{exact:true})).toBeVisible();
  expect(turns).toHaveLength(2);

  await showChatHistory(chat);
  await expect(heading).toBeFocused();
  await expect(question).toBeVisible();
  expect(turns).toHaveLength(2);
  await newConversation.click();
  await expect(composer).toBeFocused();
  await expect(history).toHaveCount(0);
  await expect(question).toHaveCount(0);
  expect(turns).toHaveLength(2);
  for(const via of ['chat','directorio'])await test.step(via,async()=>{
    for(const [id,query,target] of [
      ['assistant.thread-list','historial de ali',heading],
      ['assistant.thread-new','empezar nuevo chat',newConversation]
    ]){
      let entry=chat;
      if(via==='chat')await askAliCatalog(chat,`¿Dónde está ${query}?`);
      else{
        await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      const action=entry.locator(`[data-capability-id="${id}"]`).last();
      await expect(action).toBeVisible();
      const count=turns.length;
      await action.getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport({ratio:1});
      if(id==='assistant.thread-new'){
        await expect(history).toHaveCount(0);
        await expect(composer).toHaveValue('');
        await showChatHistory(chat);
      }
      await expect(originalRow).toBeVisible();
      expect(turns).toHaveLength(count);
    }
  });
});

test('Ali @advisor-c6: revisa y acepta solo operaciones válidas de Excel tras una decisión explícita',async({page,context,request},info)=>{
  test.setTimeout(85000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),commits=[];
    page.on('request',req=>{
      if(req.method()==='POST'&&/\/api\/admin\/imports\/[^/]+\/commit$/.test(new URL(req.url()).pathname))commits.push(req.postDataJSON());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Aceptación ${via} ${randomUUID().slice(0,8)}`},actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const batch=await prepareAdvisorImportBatch(store,{sourceId:source.id,actorId:actor});
      const anchor=`/admin?section=orders&tab=imports&batch=${batch.id}`, count=commits.length;
      const expenses=()=>store.db.all(`SELECT amount_minor,data FROM ${store.t('expenses')} WHERE data::jsonb->>'sourceId'=?`,[source.id]);
      const ledger=()=>store.db.all(`SELECT id FROM ${store.t('cash_entries')} ORDER BY id`);
      const originalLedger=await ledger();
      const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
      const advance=wizard.getByRole('button',{name:'Revisar importación parcial',exact:true});
      const confirm=wizard.getByRole('button',{name:'Confirmar e importar',exact:true});
      const partial=wizard.getByRole('checkbox',{name:/^Importar 1 operaciones válidas y dejar 1 pendientes/});
      async function arrive(id,q,target){
        if(via==='panel')return;
        let overlay=await openAli(page);
        if(via==='chat')await askAliCatalog(overlay,`¿Dónde está ${q}?`);
        else{
          await overlay.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          overlay=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await overlay.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await overlay.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await overlay.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click({timeout:8000});
        await expect(overlay).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(page).toHaveURL(url=>url.searchParams.get('batch')===batch.id);
      }
      await page.goto(anchor);
      await arrive('imports.review-confirmation','revisar importación parcial',advance);
      await advance.click({timeout:8000});
      const summary=wizard.getByRole('region',{name:'Resumen antes de importar',exact:true});
      await expect(summary).toContainText('Hojas incluidas: Gastos C4');
      await expect(summary).toContainText('No se confirma dinero recibido ni pagado.');
      await expect(confirm).toBeDisabled();
      await arrive('imports.apply-review','confirmar e importar excel',partial);
      await expect(partial).not.toBeChecked();
      await partial.check();
      await arrive('imports.apply-review','confirmar e importar excel',confirm);
      await expect(partial).toBeChecked();
      const scope=wizard.getByText('Importación parcial: 1 para incorporar y 1 sin importar.',{exact:true});
      await expect(confirm).toHaveAccessibleDescription('Importación parcial: 1 para incorporar y 1 sin importar.');
      expect(commits).toHaveLength(count);
      expect(await expenses()).toEqual([]);
      expect((await getImportBatch(store,batch.id)).acceptedRevision).toBeNull();
      if(via==='directorio'){
        await expect(scope).toBeInViewport({ratio:1});
        await screenshot(page,info,'advisor-c6-excel-aceptar-parcial');
      }
      const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`/api/admin/imports/${batch.id}/commit`,{timeout:10000});
      await confirm.click();
      const accepted=await response;
      expect(accepted.ok(),await accepted.text()).toBe(true);
      expect(commits.slice(count)).toEqual([{version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:true,requestId:expect.any(String)}]);
      await expect.poll(async()=>{
        await processImportTurn(store,{batchId:batch.id});
        return (await getImportBatch(store,batch.id)).state;
      },{timeout:20000}).toBe('completed_with_errors');
      await page.reload();
      await arrive('imports.read-results','qué se importó',wizard.getByRole('heading',{name:'Resultado y progreso',exact:true}));
      await expect(wizard.getByRole('heading',{name:'Importación parcial: quedan pendientes',exact:true})).toBeVisible();
      const result=await expenses();
      expect(result.map(row=>[Number(row.amount_minor),JSON.parse(row.data).concept])).toEqual([[1200000,'Gasto válido C4']]);
      expect(await ledger()).toEqual(originalLedger);
      expect(commits).toHaveLength(count+1);
      const pending=wizard.getByRole('button',{name:'Revisar pendientes',exact:true});
      const partialBatch=await getImportBatch(store,batch.id);
      await arrive('imports.request-preview','revisar pendientes otra vez',pending);
      expect((await getImportBatch(store,batch.id)).version).toBe(partialBatch.version);
      const previewPath=`/api/admin/imports/${batch.id}/preview`;
      const requested=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===previewPath);
      await pending.click();
      const previewResponse=await requested;
      expect(previewResponse.ok()).toBe(true);
      expect(previewResponse.request().postDataJSON()).toEqual({version:partialBatch.version,requestId:expect.any(String)});
      await expect.poll(async()=>{
        await processImportTurn(store,{batchId:batch.id});
        const next=await getImportBatch(store,batch.id);
        return !!next.preview?.previewHash&&next.preview.previewHash!==batch.preview.previewHash;
      },{timeout:20000}).toBe(true);
      expect(await expenses()).toEqual(result);
      expect(await ledger()).toEqual(originalLedger);
      expect(commits).toHaveLength(count+1);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: gestiona recordatorios propios por fecha y estado sin tocar el negocio',async({page,request},info)=>{
  test.setTimeout(85000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await page.goto('/admin');
  const endpoint='/api/admin/assistant/tasks';
  const date=new Date(Math.floor(Date.now()/60000)*60000+86400000);
  const revised=new Date(date.getTime()+2*86400000);
  const writes=[],businessWrites=[];
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(path.startsWith(`${endpoint}/`)&&!['GET','HEAD'].includes(req.method()))writes.push({method:req.method(),path,body:req.postDataJSON()});
    if(path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/assistant/')&&!['GET','HEAD'].includes(req.method()))businessWrites.push(`${req.method()} ${path}`);
  });
  const history=page.getByRole('region',{name:'Mis recordatorios',exact:true});
  const heading=history.getByRole('heading',{name:'Mis recordatorios',exact:true});
  const home=page.getByRole('region',{name:'Hoy con Ali',exact:true});
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    const label=`Revisión privada ${via} ${randomUUID().slice(0,8)}`;
    await home.getByRole('button',{name:'Recordarme',exact:true}).first().click();
    const create=page.getByRole('dialog',{name:'Crear recordatorio',exact:true});
    await create.getByLabel('Asunto',{exact:true}).fill(label);
    await fillBogota(create,date);
    const creation=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
    await create.getByRole('button',{name:'Guardar recordatorio',exact:true}).click();
    const created=await creation;
    expect(created.ok(),await created.text()).toBe(true);
    const {id}=await created.json(),path=`${endpoint}/${id}`;
    await expect(create).toHaveCount(0);
    const read=async()=>{const res=await page.request.get(path);expect(res.ok()).toBe(true);return res.json();};
    const row=history.getByRole('listitem').filter({has:page.getByRole('heading',{name:label,exact:true})});
    async function arrive(capability,query){
      if(via==='panel'){
        if(!await history.isVisible())await home.getByRole('button',{name:'Mis recordatorios',exact:true}).click();
      }else{
        let entry=await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="${capability}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(entry).toHaveCount(0);
        await expect(heading).toBeFocused();
      }
      await expect(row).toBeVisible();
    }
    await page.goto('/admin');
    const count=writes.length;
    await arrive('advisor.reminder-list','mis recordatorios');
    await expect(row.getByText('Programado',{exact:true})).toBeVisible();
    const initial=await read();
    expect(initial).toMatchObject({id,dueAt:date.toISOString(),data:{label}});
    await arrive('advisor.reminder-reschedule','reprogramar recordatorio');
    await row.getByRole('button',{name:'Reprogramar',exact:true}).click();
    let dialog=page.getByRole('dialog',{name:'Reprogramar recordatorio',exact:true});
    await expect(dialog).toContainText(label);
    await fillBogota(dialog,revised);
    expect(writes).toHaveLength(count);
    await dialog.getByRole('button',{name:'Guardar nueva fecha',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    const rescheduled=await read();
    expect(rescheduled).toMatchObject({id,dueAt:revised.toISOString(),version:initial.version+1});

    await arrive('advisor.reminder-acknowledge','marcar recordatorio atendido');
    await row.getByRole('button',{name:'Marcar como atendido',exact:true}).click();
    dialog=page.getByRole('dialog',{name:'Marcar recordatorio como atendido',exact:true});
    await expect(dialog).toContainText(label);
    expect(writes).toHaveLength(count+1);
    if(via==='directorio')await screenshot(page,info,'advisor-c6-recordatorio-marcar-atendido');
    await dialog.getByRole('button',{name:'Marcar como atendido',exact:true}).click();
    await expect(row.getByText('Atendido',{exact:true})).toBeVisible();
    const done=await read();
    expect(done).toMatchObject({id,status:'completed',version:rescheduled.version+1});

    await arrive('advisor.reminder-delete','borrar recordatorio');
    const remove=row.getByRole('button',{name:'Eliminar',exact:true});
    await remove.click();
    dialog=page.getByRole('dialog',{name:'Eliminar recordatorio',exact:true});
    await expect(dialog).toContainText(label);
    await dialog.getByRole('button',{name:'Ahora no',exact:true}).click();
    await expect(remove).toBeFocused();
    expect(writes).toHaveLength(count+2);
    await remove.click();
    await dialog.getByRole('button',{name:'Eliminar recordatorio',exact:true}).click();
    await expect(row).toHaveCount(0);
    expect((await page.request.get(path)).status()).toBe(404);
    expect(writes.slice(count)).toEqual([
      {method:'PATCH',path,body:{version:initial.version,action:'snooze',until:revised.toISOString()}},
      {method:'PATCH',path,body:{version:rescheduled.version,action:'acknowledge-reminder'}},
      {method:'DELETE',path,body:{version:done.version}}
    ]);
  });
  expect(businessWrites).toEqual([]);
});

async function showChatHistory(chat) {
  const picker=chat.getByRole('button',{name:/^‹? ?Conversaciones$/});
  if(await picker.getAttribute('aria-expanded')!=='true') await picker.click();
}

test('Ali @chat-ux: buscar mensajes, archivar y restaurar el historial', async ({page, request}, info) => {
  await loginWithAdvisorFixture(page, request);
  const tag = randomUUID().slice(0, 8);
  const title = `¿Dónde hago un arqueo? ${tag}`;
  const followUp = `Consultar productos para el seguimiento ${tag}`;
  const chat = await openAli(page);
  const history = chat.getByRole('region', {name:'Conversaciones anteriores'});
  const search = history.getByRole('searchbox', {name:'Buscar por título o mensaje'});
  const row = history.getByRole('button', {name:new RegExp(tag)});
  await chat.getByRole('button',{name:'Solicitar una intención',exact:true}).click();
  const intent=chat.getByRole('searchbox',{name:'Buscar intenciones'});
  await intent.fill('arqueo');
  const prepare=chat.getByRole('button',{name:'Preparar consulta: Contar y cerrar la caja del día'});
  await prepare.click();
  await expect(chat.getByLabel('Mensaje para Ali')).toHaveValue(/caja/i);
  await expect(chat.getByTestId('assistant-result')).toHaveCount(0);
  await askAli(chat, title);
  await expect(chat.locator('[data-capability-id="cash.close-day"]')).toBeVisible();
  await askAli(chat, followUp);
  await expect(chat.getByTestId('assistant-result')).toHaveCount(2);
  await showChatHistory(chat);
  for (const query of ['arqueo? '+tag, 'seguimiento '+tag]) {
    await search.fill(`sin-coincidencia-${tag}`);
    await expect(row).toHaveCount(0);
    await search.fill(query);
    await expect(row).toBeVisible();
  }
  await row.click();
  await expect(chat.getByText(followUp, {exact:true})).toBeVisible();
  await chat.getByRole('button', {name:'Archivar',exact:true}).click();
  await expect(chat.getByRole('button',{name:'Restaurar',exact:true})).toBeVisible();
  await showChatHistory(chat);
  await expect(row).toHaveCount(0);
  await history.getByRole('button', {name:'Archivadas',exact:true}).click();
  await expect(row).toBeVisible();
  await screenshot(page,info,'ali-historial-archivado');
  await row.click();
  await chat.getByRole('button', {name:'Restaurar',exact:true}).click();
  await expect(chat.getByRole('button',{name:'Archivar',exact:true})).toBeVisible();
  await showChatHistory(chat);
  await history.getByRole('button', {name:'Activas',exact:true}).click();
  await row.click();
  await expect(chat.getByText(followUp, {exact:true})).toBeVisible();
});

test('Ali @chat-ux: dos lecturas continúan y un cambio espera por su registro', async ({page, request, context}, info) => {
  test.setTimeout(90000);
  await loginWithAdvisorFixture(page,request);
  const store = await openStore(testDatabaseEnv());
  const tag = randomUUID().slice(0,8);
  // Hold only the outgoing advances after a *real* read checkpoint. No fabricated API responses.
  const held = new Set();
  let release;
  const gate = new Promise(resolve => {release=resolve;});
  try {
    const product = await store.save('products',{...emptyRecord('products'),title:`Ficha ${tag}`,
      slug:`ficha-${tag}`,status:'draft',description:'Original',price:25000,presentation:'Unidad'},null,null,await fixtureActor(context,store));
    await page.goto(`/admin?section=products&record=${product.id}`);
    await page.getByRole('dialog',{name:'Editar producto'}).getByRole('button',{name:/^Ayúdame/}).click();
    const chat=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
    await page.route('**/assistant/turns/*/advance',async route=>{
      const id=new URL(route.request().url()).pathname.split('/').at(-2);
      if(held.has(id))await gate;
      const response=await route.fetch();
      if(response.ok()){
        const status=await response.json();
        if(status.state==='running' && status.progress.readsCompleted)held.add(id);
      }
      await route.fulfill({response});
    });
    const beginRead=async text=>{
      const advanced=page.waitForResponse(async response=>{
        if(!response.url().endsWith('/advance')||!response.ok())return false;
        const status=await response.json();
        return status.state==='running' && status.progress.readsCompleted>0;
      });
      await askAli(chat,text);
      return (await (await advanced).json()).threadId;
    };
    const fresh=()=>chat.getByRole('button',{name:'Nueva conversación',exact:true}).click();
    const a=await beginRead(`Consulta el producto para revisión ${tag}`);
    await fresh();
    const b=await beginRead(`Consulta el producto para contraste ${tag}`);
    expect(a).not.toBe(b);
    await expect(chat.getByTestId('assistant-progress')).toBeVisible();
    await showChatHistory(chat);
    await chat.getByRole('region',{name:'Conversaciones anteriores'}).getByRole('button',{name:new RegExp(`producto para revisión ${tag}`)}).click();
    await expect(chat.getByTestId('assistant-progress')).toBeVisible();
    await expect(chat.getByTestId('assistant-progress')).toContainText('Preparar consulta');
    await screenshot(page,info,'ali-progreso-simultaneo');
    await fresh();
    const change=`Cambia la descripción a «Revisada ${tag}»`;
    await askAli(chat,change);
    await expect(chat.getByText(/otra conversación/i).last()).toBeVisible();
    expect((await store.get('products',product.id)).description).toBe('Original');
    release();
    for(const id of [a,b])await expect.poll(async()=>{
      const r=await page.request.get(`/api/admin/assistant/threads/${id}`);
      return (await r.json()).turns[0].state;
    }).toBe('completed');
    await showChatHistory(chat);
    await chat.getByRole('region',{name:'Conversaciones anteriores'}).getByRole('button',{name:new RegExp(`producto para revisión ${tag}`)}).click();
    await expect(chat.getByTestId('assistant-result')).toBeVisible();
    await chat.getByText('Etapas registradas',{exact:true}).click();
    await expect(chat.getByText('Preparar consulta',{exact:true}).first()).toBeVisible();
    await fresh();
    await askAli(chat,change);
    await expect(chat.getByRole('region',{name:'Comprobante de cambio guardado'})).toBeVisible();
    expect((await store.get('products',product.id)).description).toBe(`Revisada ${tag}`);
  } finally { release(); await store.close(); }
});

test('Ali @advisor-c6: recupera y borra solo la conversación elegida tras confirmar',async({page,request},info)=>{
  test.setTimeout(85000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await page.goto('/admin');
  const chat=await openAli(page),eliminations=[];
  const history=chat.getByRole('region',{name:'Conversaciones anteriores',exact:true});
  const list=history.getByRole('heading',{name:'Conversaciones',exact:true});
  const erase=chat.getByRole('button',{name:'Borrar',exact:true});
  page.on('request',req=>{if(req.method()==='DELETE')eliminations.push(new URL(req.url()).pathname);});
  async function navigate(via,id,q){
    let entry=chat;
    if(via==='chat')await askAliCatalog(chat,`¿Dónde está ${q}?`);
    else{
      await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
      await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
      await entry.getByRole('button',{name:'Buscar',exact:true}).click();
    }
    await entry.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
  }
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    const balance='¿Dónde hago un arqueo?';
    const posted=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname==='/api/admin/assistant/turns');
    await askAli(chat,balance);
    const {threadId}=await (await posted).json(),path=`/api/admin/assistant/threads/${threadId}`;
    await expect(chat.locator('[data-capability-id="cash.close-day"]')).toBeVisible();
    if(via==='panel')await chat.getByRole('button',{name:'‹ Conversaciones',exact:true}).click();
    else await navigate(via,'assistant.thread-open','abrir un hilo');
    await expect(list).toBeFocused();
    const fetchThread=page.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===path,{timeout:6500});
    await history.getByRole('button',{name:/^¿Dónde hago un arqueo\?/}).first().click();
    expect((await fetchThread).ok()).toBe(true);
    await expect(chat.locator('[data-capability-id="cash.close-day"]')).toBeVisible();
    const count=eliminations.length;
    if(via!=='panel'){
      await navigate(via,'assistant.thread-delete','borrar conversación');
      await expect(erase).toBeFocused();
    }
    expect(eliminations).toHaveLength(count);
    for(const confirm of [false,true]){
      const warning=page.waitForEvent('dialog');
      const clicked=erase.click();
      const decision=await warning;
      expect(decision.message()).toContain(balance);
      expect(decision.message()).toContain('Los cambios que ya guardaste en el negocio se conservan.');
      await (confirm?decision.accept():decision.dismiss());
      await clicked;
      if(!confirm){
        expect(eliminations).toHaveLength(count);
        expect((await page.request.get(path)).ok()).toBe(true);
      }
    }
    await expect(list).toBeVisible();
    expect(eliminations.slice(count)).toEqual([path]);
    expect((await page.request.get(path)).status()).toBe(404);
  });
});

test('Ali @advisor-c6: conserva los cambios de vitrina hasta su guardado explícito',async({page,request},info)=>{
  test.setTimeout(100000);
  page.setDefaultTimeout(10000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const endpoint='/api/admin/settings',writes=[];
  page.on('request',req=>{if(req.method()==='PUT'&&new URL(req.url()).pathname===endpoint)writes.push(req.postDataJSON());});
  const saved=async()=>{const res=await page.request.get(endpoint);expect(res.ok()).toBe(true);return res.json();};
  const form=page.locator('.settings-form');
  const storefront=page.getByRole('checkbox',{name:/^Publicar la vitrina/});
  const guidance=page.getByRole('checkbox',{name:/^Mostrar orientación sobre la siguiente etapa/});
  const intro=form.getByText(/^Estado guardado:/);
  const settingsRead=page.waitForRequest(req=>req.method()==='GET'&&new URL(req.url()).pathname===endpoint);
  await page.goto('/admin?section=settings');
  const csrf=await (await settingsRead).headerValue('x-csrf-token');
  const original=await saved();
  try {
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    await page.goto('/admin?section=settings');
    await expect(intro).toBeVisible();
    if(!await storefront.isChecked()){
      const created=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===endpoint);
      await storefront.check();
      await form.getByRole('button',{name:'Guardar configuración',exact:true}).click();
      expect((await created).ok()).toBe(true);
      await expect(intro).toHaveText('Estado guardado: vitrina publicada');
    }
    const before=await saved(),count=writes.length,marker=randomUUID().slice(0,8);
    const brandName=`Vitrina sintética ${marker}`,email=`${marker}@example.test`,paymentInfo=`Acuerdo de pago sintético ${marker}`,metaDomainVerification=`dominio-publico-${marker}`;
    async function arrive(capability,query,target){
      if(via==='panel'){await expect(target).toBeVisible();return;}
      let entry=await openAli(page);
      if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="${capability}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(entry).toHaveCount(0);
      await expect(target).toBeFocused();
    }
    const brand=page.getByRole('textbox',{name:/^Nombre de la marca/});
    await arrive('storefront.brand','nombre de marca',form.getByRole('heading',{name:'Identidad de la marca',exact:true}));
    await brand.fill(brandName);
    await arrive('storefront.contact','correo y horario',form.getByRole('heading',{name:'Contacto y redes',exact:true}));
    await page.getByRole('textbox',{name:'Correo público',exact:true}).fill(email);
    const logo=page.getByRole('textbox',{name:'Enlace del logo',exact:true});
    await arrive('storefront.logo-preview','previsualizar logo',logo);
    const previousLogo=await logo.inputValue();
    await logo.fill('/brand/creatina-vital-force.jpg');
    await form.getByRole('button',{name:'Ver vista previa',exact:true}).click();
    const image=form.getByRole('img',{name:'Vista previa',exact:true});
    await expect.poll(()=>image.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);
    await logo.fill(previousLogo);
    const payment=page.getByRole('textbox',{name:'Métodos de pago que se mostrarán',exact:true});
    await arrive('storefront.payment-text','editar pagos de vitrina',payment);
    await payment.fill(paymentInfo);
    const domain=page.getByRole('textbox',{name:/^Código de verificación de dominio de Meta/});
    await arrive('storefront.domain-verification','etiqueta facebook domain verification',domain);
    await domain.fill(metaDomainVerification);
    await arrive('storefront.next-stage-guidance','ocultar aviso de siguiente etapa',guidance);
    await guidance.setChecked(!before.showNextStage);
    await arrive('storefront.unlaunch','desactivar publicación global',storefront);
    await expect(storefront).toBeChecked();
    await storefront.uncheck();
    await expect(intro).toHaveText('Estado guardado: vitrina publicada');
    const pendingPublication=form.getByRole('status').filter({hasText:'Selección pendiente: volver a modo preparación al guardar.'});
    await expect(pendingPublication).toBeInViewport({ratio:1});
    const preview=page.getByRole('link',{name:'Ver mi página (abre en otra pestaña)',exact:true});
    await arrive('storefront.preview','vista de revisión',preview);
    const opened=page.waitForEvent('popup');
    await preview.click();
    const popup=await opened;
    try{
      await expect(popup).toHaveURL(url=>url.pathname==='/'&&url.searchParams.get('preview')==='1');
      await expect(popup).toHaveTitle(before.brandName);
    }finally{await popup.close();}
    await expect(brand).toHaveValue(brandName);
    expect(await saved()).toEqual(before);
    expect(writes).toHaveLength(count);
    if(via==='directorio')await screenshot(page,info,'advisor-c6-vitrina-seleccion-pendiente');
    const committed=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===endpoint);
    await form.getByRole('button',{name:'Guardar configuración',exact:true}).click();
    const response=await committed;
    expect(response.ok(),await response.text()).toBe(true);
    const result=await response.json();
    expect(result).toMatchObject({brandName,email,paymentInfo,metaDomainVerification,launchApproved:false,showNextStage:!before.showNextStage,version:before.version+1});
    expect(await saved()).toEqual(result);
    expect(writes).toHaveLength(count+1);
    await expect(intro).toHaveText('Estado guardado: modo preparación');
    const publicPage=await page.context().newPage();
    try{
      await publicPage.goto('/');
      await expect(publicPage.getByRole('heading',{name:/Estamos preparando.*nuestro catálogo/i})).toBeVisible();
      await expect(publicPage.locator('meta[name="facebook-domain-verification"]')).toHaveAttribute('content',metaDomainVerification);
    }finally{await publicPage.close();}
  });
  } finally {
    const restored=await saved();
    const reset=await page.request.put(endpoint,{headers:{origin:new URL(page.url()).origin,'x-csrf-token':csrf},data:{...original,version:restored.version}});
    expect(reset.ok(),await reset.text()).toBe(true);
  }
});

test('Ali @advisor-c6: traslada el vínculo entre campañas sin mover dinero',async({page,context,request},info)=>{
  test.setTimeout(100000);
  page.setDefaultTimeout(9000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const adminRead=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/admin/settings');
  await page.goto('/admin');
  const headers={origin:new URL(page.url()).origin,'x-csrf-token':await (await adminRead).headerValue('x-csrf-token')};
  const get=async path=>{const res=await context.request.get(path);expect(res.ok(),await res.text()).toBe(true);return res.json();};
  const post=async(path,data)=>{const res=await context.request.post(path,{headers,data});expect(res.ok(),await res.text()).toBe(true);return res.json();};
  const fixture=async marker=>{
    const record=await seedResults({marker:`reasignación-${marker}-${randomUUID()}`,get,campaign:id=>get(`/api/admin/social/campaigns/${id}`),post:(path,data)=>post(path,{requestId:randomUUID(),...data})});
    trackFixtureConnection(info,record.connectionId);
    return record;
  };
  const source=await fixture('origen'),destination=await fixture('destino');
  const path=id=>`/api/admin/social/campaigns/${id}/links`;
  const endpoint=path(destination.id),writes=[];
  page.on('request',req=>{const url=new URL(req.url());if(req.method()==='POST'&&url.pathname===endpoint)writes.push(req.postDataJSON());});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])for(const kind of ['order','expense'])await test.step(`${via} · ${kind}`,async()=>{
      const code=randomUUID().slice(0,8),order=kind==='order';
      const record=order?await store.saveOrder(businessOrderInput(await store.save('products',{...emptyRecord('products'),title:`Traslado ${code}`,slug:`traslado-${code}`,status:'draft',price:55000,orderable:true,stockQuantity:10},null,null,actor),{placedOn:bogotaDate()}),actor)
        :await recordExpense(store,{requestId:randomUUID(),category:'advertising',concept:`Pauta ${code}`,amountMinor:1839000,incurredOn:bogotaDate()},actor);
      const key=order?'orders':'expenses',criteria=order?`Pedido ${record.number}`:record.concept;
      const saved=()=>store.db.get(`SELECT * FROM ${store.t(key)} WHERE id=?`,[record.id]);
      const before=await saved(),count=writes.length;
      const link=await post(path(source.id),{kind,recordId:record.id,campaignId:source.id,reason:'Acuerdo inicial sintético',version:0,requestId:randomUUID()});
      const label=order?'Vincular pedido existente':'Vincular gasto publicitario existente';
      const dialog=page.getByRole('dialog',{name:label,exact:true}),confirm=dialog.getByRole('checkbox',{name:/^Confirmo el registro seleccionado/});
      const results=page.getByRole('region',{name:'Resultados de publicidad',exact:true});
      await page.goto(`/admin?section=advertising&tab=results&record=${destination.id}`);
      await results.getByText('Pedidos y gastos vinculados (separados de Meta)',{exact:true}).click();
      await results.getByRole('button',{name:label,exact:true}).click();
      await dialog.getByRole('textbox',{name:/^Buscar por (número|concepto)/}).fill(order?String(record.number):record.concept);
      await dialog.getByRole('button',{name:'Buscar registros',exact:true}).click();
      const candidate=dialog.getByRole('article').filter({has:page.getByText(criteria,{exact:true})});
      await candidate.getByRole('button',{name:'Cambiar vínculo a esta campaña',exact:true}).click();
      const reason=`Confirmo cambio de campaña ${code}`;
      await dialog.getByRole('textbox',{name:/^Motivo de la rectificación/}).fill(reason);
      if(via!=='panel'){
        await dialog.getByRole('button',{name:'Ayúdame con el motivo',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio'});
        const query=order?'reasignar vínculo de pedido':'reasignar el vínculo del gasto';
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="advertising.reassign-${kind}-link"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(confirm).toBeFocused();
      }
      await expect(dialog.getByText(/Ambas evaluaciones comerciales deberán recalcularse/)).toContainText(source.name);
      await expect(confirm).not.toBeChecked();
      expect(writes).toHaveLength(count);
      expect((await get(path(source.id)))[key]).toContainEqual(expect.objectContaining({id:record.id}));
      const accepted=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
      await confirm.check();
      await dialog.getByRole('button',{name:'Cambiar vínculo',exact:true}).click();
      const response=await accepted;
      expect(response.ok(),await response.text()).toBe(true);
      const receipt=await response.json();
      expect(receipt).toMatchObject({kind,recordId:record.id,previousCampaignId:source.id,campaignId:destination.id,version:link.version+1,link:{reason}});
      expect(await post(endpoint,writes.at(-1))).toEqual(receipt);
      expect((await get(path(source.id)))[key].some(item=>item.id===record.id)).toBe(false);
      expect((await get(endpoint))[key]).toContainEqual(expect.objectContaining({id:record.id,link:expect.objectContaining({version:link.version+1})}));
      expect(await saved()).toEqual(before);
      expect(writes).toHaveLength(count+1);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: recupera una pieza privada y consulta el historial anterior sin generar',async({page,request},info)=>{
  test.setTimeout(70000);
  page.setDefaultTimeout(9000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const endpoint='/api/admin/social/creative-threads';
  const adminRead=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/admin/settings');
  await page.goto('/admin');
  const headers={origin:new URL(page.url()).origin,'x-csrf-token':await (await adminRead).headerValue('x-csrf-token')};
  const created=await page.request.post(endpoint,{headers,data:{requestId:randomUUID()}});
  expect(created.ok(),await created.text()).toBe(true);
  const thread=await created.json();
  const before=await (await page.request.get(endpoint)).json();
  expect(before.threads[0]).toMatchObject({id:thread.id,version:thread.version,campaignId:null});
  const legacy=await (await page.request.get('/api/admin/social/generation')).json();
  const mutations=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==headers.origin||url.pathname.startsWith('/api/admin/social/')&&req.method()!=='GET')mutations.push(url.pathname);
  });
  const pieces=page.locator('summary').filter({hasText:/^Mis piezas en curso/});
  const prior=page.locator('summary').filter({hasText:'Historial de imágenes anterior al estudio'});
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    async function arrive(id,query,target){
      if(via==='panel'){await target.click();return;}
      let entry=await openAli(page);
      if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(target).toBeFocused();
    }
    const campaigns='/admin?section=advertising&tab=campaigns',library='/admin?section=advertising&tab=assets';
    await page.goto(via==='panel'?campaigns:'/admin');
    await arrive('advertising.list-private-pieces','mis piezas privadas',pieces);
    await expect(pieces.locator('..')).toHaveJSProperty('open',true);
    await expect(pieces.locator('..').getByText('Pieza sin seleccionar',{exact:true}).first()).toBeVisible();
    if(via!=='panel')await arrive('advertising.resume-private-piece','reanudar pieza',pieces);
    await expect(pieces.locator('..')).toHaveJSProperty('open',true);
    await expect(page).toHaveURL(url=>!url.searchParams.has('studio'));
    const opened=page.waitForResponse(res=>res.request().method()==='GET'&&new URL(res.url()).pathname===`${endpoint}/${thread.id}`,{timeout:8000});
    await pieces.locator('..').getByRole('button',{name:'Reanudar pieza',exact:true}).first().click();
    expect((await opened).ok()).toBe(true);
    await expect(page).toHaveURL(url=>url.searchParams.get('studio')===thread.id);
    await expect(page.getByRole('heading',{name:'Estudio visual',exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'Añadir una pieza',exact:true})).toBeVisible();
    await page.goto(via==='panel'?library:'/admin');
    await arrive('advertising.read-legacy-generation-history','historial antiguo de imágenes',prior);
    const details=prior.locator('..');
    if(await details.getAttribute('open')===null)await prior.click();
    if(legacy.jobs.length){
      const first=legacy.jobs[0];
      await expect(details.getByText(first.asset?.name||`Solicitud ${first.format?.toUpperCase()||'de imagen'}`,{exact:true}).first()).toBeVisible();
    }else await expect(details.getByText('No hay solicitudes anteriores.',{exact:true})).toBeVisible();
  });
  expect((await (await page.request.get(endpoint)).json()).threads).toEqual(before.threads);
  expect(mutations).toEqual([]);
});

test('Ali @advisor-c6: adjunta, revisa y elige una pieza local sin publicar',async({page,request},info)=>{
  // Panel, chat and directory each wait for a separate scheduler turn.
  test.setTimeout(300000);
  page.setDefaultTimeout(10000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const {execFileSync}=await import('node:child_process');
  const sharp=(await import('sharp')).default;
  const assets='/api/admin/social/assets',threads='/api/admin/social/creative-threads';
  const studioHref='/admin?section=advertising&tab=campaigns&record=new';
  const adminRead=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/admin/settings');
  await page.goto('/admin');
  const origin=new URL(page.url()).origin;
  const headers={origin,'x-csrf-token':await (await adminRead).headerValue('x-csrf-token')};
  const forbidden=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==origin||req.method()!=='GET'&&/^\/api\/admin\/social\/(campaigns|generation)/.test(url.pathname))forbidden.push(url.pathname);
  });
  const studio=page.getByRole('region',{name:'Estudio visual',exact:true});
  async function readThread(id){
    const res=await page.request.get(`${threads}/${id}`);
    expect(res.ok(),await res.text()).toBe(true);
    return res.json();
  }
  for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
    async function arrive(id,query,target){
      if(via==='panel')return;
      let entry=await openAli(page);
      if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="advertising.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(target).toBeFocused();
    }
    await page.goto(studioHref);
    const upload=studio.getByRole('button',{name:'Adjuntar foto o video',exact:true});
    await arrive('upload-studio-attachment','subir foto al estudio',upload);
    await upload.click();
    const file=studio.getByLabel('Archivo de imagen o video',{exact:true});
    const name=`foto-ali-${randomUUID().slice(0,8)}`;
    const bytes=await sharp({create:{width:400+index*2,height:500,channels:3,background:'#43805d'}}).png().toBuffer();
    await file.setInputFiles({name:`${name}.png`,mimeType:'image/png',buffer:bytes});
    const put=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname.startsWith(`${assets}/`)&&new URL(res.url()).pathname.endsWith('/content'));
    await studio.getByRole('button',{name:'Subir archivo',exact:true}).click();
    const response=await put;
    expect(response.ok(),await response.text()).toBe(true);
    const asset=await response.json();
    await expect(page).toHaveURL(url=>Boolean(url.searchParams.get('studio')));
    const uploadedThread=new URL(page.url()).searchParams.get('studio');
    const container=process.env.ALI_FIXTURE_ASSET_CONTAINER;
    if(container){
      expect(container).toMatch(/^advisor-c1-[a-f0-9]+-web$/);
      execFileSync('docker',['exec',container,'node','tests/e2e/guided-image-worker.mjs','asset',asset.id,origin],{timeout:20000,encoding:'utf8'});
    }
    const ready=studio.getByRole('button',{name:'Usar esta pieza y continuar',exact:true});
    await expect(ready).toBeEnabled({timeout:65000});
    const assembled=await readThread(uploadedThread);
    expect(assembled.thread).toMatchObject({selectedAsset:null,campaignId:null,attachments:[expect.objectContaining({id:asset.id,state:'ready'})]});
    const created=await page.request.post(threads,{headers,data:{requestId:randomUUID()}});
    expect(created.ok(),await created.text()).toBe(true);
    const second=await created.json();
    await page.goto(`${studioHref}&studio=${second.id}`);
    const library=studio.getByRole('button',{name:'Elegir de biblioteca',exact:true});
    await arrive('attach-library-asset','elegir de biblioteca',library);
    await library.click();
    const choose=studio.getByRole('combobox',{name:'Archivo de biblioteca',exact:true});
    await arrive('attach-library-asset','elegir de biblioteca',choose);
    await expect(choose).toHaveValue('');
    await choose.selectOption(asset.id);
    const variants=studio.locator('summary').filter({hasText:/^Original y variantes/});
    await expect(ready).toBeEnabled();
    await arrive('inspect-creative-variant','ver variante de imagen',variants);
    await studio.getByRole('button',{name:'Comparar con el original',exact:true}).click();
    await expect(studio.getByRole('img',{name:'Archivo original',exact:true})).toBeVisible();
    await expect(ready).toBeDisabled();
    await studio.getByRole('button',{name:'Volver al archivo preparado',exact:true}).click();
    await expect(ready).toBeEnabled();
    await arrive('use-reviewed-asset','elegir derivado para el borrador',ready);
    expect((await readThread(second.id)).thread.selectedAsset).toBeNull();
    await ready.click();
    await expect(page.getByRole('heading',{name:'¿Qué quieres publicar?',exact:true})).toBeVisible();
    const selected=await readThread(second.id);
    expect(selected.thread).toMatchObject({campaignId:null,selectedAsset:{id:asset.id,state:'ready'}});
    expect(selected.turns).toEqual([]);
  });
  expect(forbidden).toEqual([]);
});

test('Ali @advisor-c6: distingue estado oficial y alta local de Heka clásico',async({page,context,request},info)=>{
  test.setTimeout(85000);
  page.setDefaultTimeout(9000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await page.goto('/admin');
  const origin=new URL(page.url()).origin,classic='/api/admin/shipping/connections',official='/api/admin/shipping/heka';
  const get=async path=>{const res=await page.request.get(path);expect(res.ok(),await res.text()).toBe(true);return res.json();};
  const savedOfficial=await get(official);
  expect(savedOfficial).not.toHaveProperty('apiKey');
  const panel=page.getByRole('region',{name:'Proveedores de envíos',exact:true});
  const settings=panel.getByRole('region',{name:'Estado guardado de Heka oficial',exact:true});
  const docs=panel.getByRole('link',{name:'Documentación oficial de Heka',exact:true});
  const form=panel.getByRole('form',{name:'Conectar fuente con Heka',exact:true});
  const source= form.getByRole('combobox',{name:'Fuente comercial',exact:true});
  const list=panel.getByRole('region',{name:'Conexiones guardadas de Heka clásico',exact:true});
  const writes=[],external=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==origin)external.push(url.origin);
    if(url.pathname.startsWith('/api/admin/shipping/')&&req.method()!=='GET')writes.push(url.pathname);
  });
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const platform=await saveResource(store,'platforms',{name:`Canal Heka sintético ${via} ${randomUUID().slice(0,7)}`,requestId:randomUUID()},actor);
      const [account]=await listResources(store,'sources',{platform:platform.id});
      async function arrive(id,query,target){
        if(via==='panel'){await expect(target).toBeVisible();return;}
        let entry=await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="heka.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      }
      await page.goto(via==='panel'?'/admin?section=business&tab=shipping':'/admin');
      const count=writes.length;
      await arrive('settings-status','estado de heka oficial',settings);
      await expect(settings).toContainText(savedOfficial.configured?'Hay una llave guardada':'No hay una llave guardada');
      await expect(settings).toContainText(savedOfficial.environment==='production'?'Entorno Heka: Producción':'Entorno Heka: Pruebas');
      await expect(panel.getByLabel('Llave API de Heka',{exact:true})).toHaveValue('');
      await arrive('settings-docs','manual de api heka',docs);
      await expect(docs).toHaveAttribute('href','https://new.hekaentrega.co/api/docs');
      await expect(docs).toHaveAttribute('target','_blank');
      await arrive('classic-create','conectar fuente con heka',source);
      await expect(source).toHaveValue('');
      const create=form.getByRole('button',{name:'Conectar fuente con Heka',exact:true});
      await expect(create).toBeDisabled();
      expect(writes).toHaveLength(count);
      await source.selectOption(account.id);
      const created=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===classic);
      await create.click();
      const response=await created;
      expect(response.ok(),await response.text()).toBe(true);
      const connection=await response.json();
      expect(connection).toMatchObject({sourceId:account.id,state:'awaiting_pairing'});
      await arrive('classic-connections','fuentes heka clásico',list);
      const card=list.getByRole('article',{name:`${platform.name} · ${account.name}`,exact:true});
      await expect(card).toContainText('Pendiente de emparejamiento');
      await expect(card).toContainText('Electron desconectado');
      expect((await get(classic)).connections).toContainEqual(expect.objectContaining({id:connection.id,sourceId:account.id,state:'awaiting_pairing'}));
      expect(await get(official)).toEqual(savedOfficial);
      expect(writes.slice(count)).toEqual([classic]);
      const pair=card.getByRole('button',{name:'Generar código de emparejamiento',exact:true});
      const revoke=card.getByRole('button',{name:'Revocar acceso de Electron',exact:true});
      const recordPath=`${classic}/${connection.id}`;
      await page.goto('/admin?section=business&tab=shipping');
      if(via!=='panel')await arrive('classic-pair','generar código de emparejamiento',list);
      await card.getByRole('button',{name:'Elegir esta conexión',exact:true}).click();
      await expect(page).toHaveURL(url=>url.searchParams.get('record')===connection.id);
      await arrive('classic-pair','generar código de emparejamiento',pair);
      const code=card.getByRole('region',{name:'Código de emparejamiento',exact:true});
      await expect(code).toHaveCount(0);
      expect(writes).toHaveLength(count+1);
      const generated=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`${recordPath}/pairing`);
      await pair.click();
      const result=await generated;
      expect(result.ok()).toBe(true);
      const {connectionId,sourceId,expiresAt}=await result.json();
      expect({connectionId,sourceId}).toEqual({connectionId:connection.id,sourceId:account.id});
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
      await expect(code.getByRole('heading',{name:'Código de un solo uso',exact:true})).toBeVisible();
      await expect(code).toContainText(origin);
      await code.getByRole('button',{name:'Ocultar código',exact:true}).click();
      await expect(code).toHaveCount(0);
      const livePairings=()=>store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('shipping_pairings')} WHERE connection_id=? AND consumed_at IS NULL`,[connection.id]);
      expect(Number((await livePairings()).total)).toBe(1);
      await arrive('classic-revoke','revocar complemento heka',revoke);
      for(const confirm of [false,true]){
        const warning=page.waitForEvent('dialog');
        const clicked=revoke.click();
        const decision=await warning;
        expect(decision.message()).toContain('Las capturas históricas y los lotes se conservan.');
        await (confirm?decision.accept():decision.dismiss());
        await clicked;
        if(!confirm)expect(writes).toHaveLength(count+2);
      }
      await expect(card).toContainText('Acceso revocado');
      expect((await get(classic)).connections).toContainEqual(expect.objectContaining({id:connection.id,sourceId:account.id,state:'revoked',version:connection.version+1}));
      expect(Number((await livePairings()).total)).toBe(0);
      expect(writes.slice(count)).toEqual([classic,`${recordPath}/pairing`,`${recordPath}/revoke`]);
    });
    expect(external).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: confirma identidad clásica y prepara la captura exacta sin aceptar Excel',async({page,context,request},info)=>{
  test.setTimeout(115000);
  page.setDefaultTimeout(12000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  await page.goto('/admin');
  const origin=new URL(page.url()).origin,path='/api/admin/shipping';
  const writes=[],forbidden=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==origin||req.method()!=='GET'&&(/\/shipping\/heka\/operate$|\/imports\/[^/]+\/commit$/.test(url.pathname)))forbidden.push(url.pathname);
    if(url.pathname.startsWith(`${path}/`)&&req.method()==='POST')writes.push(url.pathname);
  });
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    const businessCounts=()=>store.db.get(`SELECT ${['orders','shipments','settlement_receipts','cash_entries'].map(table=>`(SELECT COUNT(*) FROM ${store.t(table)}) AS ${table}`).join(', ')}`);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const code=randomUUID().slice(0,8);
      const platform=await saveResource(store,'platforms',{name:`Captura clásica ${code}`,requestId:randomUUID()},actor);
      const originalBusiness=await businessCounts();
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const connection=await createShippingConnection(store,{sourceId:source.id,requestId:randomUUID()},actor);
      const pairing=await createShippingPairing(store,connection.id,{version:connection.version,requestId:randomUUID()},actor);
      const deviceId=randomUUID();
      const {bearer}=await pairShippingBridge(store,{code:pairing.code,deviceId});
      const identity={...hekaSnapshot().account,userId:`sintetico-${code}`};
      const candidate=await reportShippingIdentity(store,{deviceId,identity},{bearer});
      const recordPath=`${path}/connections/${connection.id}`;
      const card=page.getByRole('article',{name:`${platform.name} · ${source.name}`,exact:true});
      const query=card.getByRole('form',{name:'Consultar Heka',exact:true});
      const confirm=card.getByRole('region',{name:'Confirmar identidad Heka',exact:true});
      const scope=confirm.getByRole('checkbox',{name:/^Confirmo que esta cuenta Heka/});
      async function arrive(id,q,target){
        if(via==='panel'){await expect(target).toBeVisible();return;}
        let entry=await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="heka.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
        await expect(page).toHaveURL(url=>url.searchParams.get('record')===connection.id);
      }
      await page.goto(`/admin?section=business&tab=shipping&record=${connection.id}`);
      const count=writes.length;
      await arrive('classic-confirm-identity','aceptar identidad heka clásico',scope);
      await expect(confirm).toContainText(identity.userId);
      await expect(confirm).toContainText(candidate.identityFingerprint);
      await expect(scope).not.toBeChecked();
      expect(writes).toHaveLength(count);
      await scope.check();
      await confirm.getByRole('button',{name:'Confirmar fuente y cuenta Heka',exact:true}).click();
      await expect(card.getByRole('region',{name:'Cuenta Heka confirmada',exact:true})).toContainText(identity.userId);

      const from=query.getByLabel('Desde',{exact:true}),day='2026-11-08';
      await arrive('classic-query','capturar pagos heka',from);
      await from.fill(day);
      await query.getByLabel('Hasta',{exact:true}).fill(day);
      await arrive('classic-query','capturar pagos heka',from);
      await expect(from).toHaveValue(day);
      expect(writes).toHaveLength(count+1);
      const requested=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`${recordPath}/queries`);
      await query.getByRole('button',{name:'Consultar Heka',exact:true}).click();
      const response=await requested;
      expect(response.ok(),await response.text()).toBe(true);
      const queued=await response.json(),progress=card.getByRole('region',{name:'Progreso de consulta',exact:true});
      await arrive('classic-query-status','consulta heka pendiente',progress);
      await expect(progress).toContainText('En cola; esperando Electron');
      await expect(progress).toContainText(queued.queryId);
      const {job}=await claimShippingQuery(store,{deviceId},{bearer});
      expect(job.queryId).toBe(queued.queryId);
      const capturedAt=new Date(Date.parse(job.lease.leaseUntil)-LEASE_MILLISECONDS).toISOString();
      const snapshot=hekaSnapshot({query:job.query,capturedAt,account:identity});
      for(const item of snapshot.packages){item.header.id_user=identity.userId;item.headerAfter.id_user=identity.userId;}
      const completed=await completeShippingQuery(store,job.queryId,{deviceId,lease:job.lease,snapshot},{bearer},{now:capturedAt});
      await page.reload();
      const capture=card.getByRole('region',{name:'Resultados de Heka',exact:true});
      await arrive('classic-read-capture','ver captura de liquidación',capture);
      await expect(progress).toContainText('Lectura completada');
      await expect(capture.getByRole('heading',{name:'Paquetes pagados (1)',exact:true})).toBeVisible();
      await expect(capture).toContainText('no recepción bancaria');
      await capture.getByText('Trazabilidad de la captura',{exact:true}).click();
      await expect(capture.getByText(completed.snapshotId,{exact:true})).toBeVisible();
      const prepare=card.getByRole('button',{name:'Preparar importación completa',exact:true});
      await arrive('classic-prepare-import','importar captura heka',prepare);
      expect(writes.slice(count)).toEqual([`${recordPath}/identity`,`${recordPath}/queries`]);
      const firstPreparation=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`${path}/imports`);
      await prepare.click();
      const preparing=await firstPreparation;
      expect(preparing.ok(),await preparing.text()).toBe(true);
      await expect(page).toHaveURL(url=>url.searchParams.get('tab')==='imports'&&Boolean(url.searchParams.get('batch')),{timeout:26000});
      const batch=await getImportBatch(store,new URL(page.url()).searchParams.get('batch'));
      expect(batch).toMatchObject({sourceId:source.id,acceptedRevision:null,shippingOrigin:{snapshotId:completed.snapshotId}});
      expect(await businessCounts()).toEqual(originalBusiness);
    });
    expect(forbidden).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: conserva la decisión de entorno y retira solo la llave de prueba local',async({page,request},info)=>{
  test.setTimeout(110000);
  page.setDefaultTimeout(10000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const path='/api/admin/shipping/heka',location='/admin?section=business&tab=shipping',ops='/admin?section=orders&tab=heka';
  const initialRead=page.waitForRequest(req=>req.method()==='GET'&&new URL(req.url()).pathname===path);
  await page.goto(location);
  const origin=new URL(page.url()).origin,headers={origin,'x-csrf-token':await (await initialRead).headerValue('x-csrf-token')};
  const get=async()=>{const res=await page.request.get(path);expect(res.ok(),await res.text()).toBe(true);return res.json();};
  expect(await get()).toMatchObject({configured:false,environment:'test'});
  const panel=page.getByRole('region',{name:'Conexión oficial de Heka',exact:true});
  const environment=panel.getByRole('combobox',{name:'Entorno',exact:true});
  const key=panel.getByLabel('Llave API de Heka',{exact:true});
  const update=panel.getByRole('button',{name:'Guardar conexión Heka',exact:true});
  const open=page.getByRole('heading',{name:'Despachos con Heka · API oficial',exact:true});
  const writes=[],forbidden=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==origin||url.pathname.startsWith(`${path}/`)&&req.method()!=='GET')forbidden.push(url.pathname);
    if(url.pathname===path&&req.method()!=='GET')writes.push(req.method());
  });
  try{
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(location);
      async function arrive(id,q,target){
        if(via==='panel'){await expect(target).toBeVisible();return;}
        let entry=await openAli(page);
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${q}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(q);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="heka.settings-${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      }
      const count=writes.length,start=await get();
      await arrive('production','cambiar heka a producción',environment);
      await expect(environment).toHaveValue('test');
      await environment.selectOption('production');
      await arrive('production','cambiar heka a producción',key);
      await expect(key).toHaveValue('');
      await key.fill(`NO-ES-LLAVE-CANCELAR-${randomUUID()}`);
      await update.click();
      const production=page.getByRole('dialog',{name:'Conectar Heka en producción',exact:true});
      await expect(production.getByRole('button',{name:'Guardar en producción',exact:true})).toBeDisabled();
      await expect(production).toContainText('puede afectar envíos reales');
      await production.getByRole('button',{name:'Volver sin enviar',exact:true}).click();
      await panel.getByRole('button',{name:'Descartar cambios',exact:true}).click();
      expect(await get()).toEqual(start);
      expect(writes).toHaveLength(count);

      await arrive('test','llave de pruebas heka',key);
      await expect(key).toHaveValue('');
      const response=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===path);
      await key.fill(`NO-ES-LLAVE-SINTETICA-${randomUUID()}`);
      await update.click();
      const configured=await response;
      expect(configured.ok(),await configured.text()).toBe(true);
      const state=await configured.json();
      expect(state).toEqual({configured:true,environment:'test',version:start.version+1});
      await expect(key).toHaveValue('');
      if(via==='panel')await panel.getByRole('button',{name:'Abrir operaciones Heka',exact:true}).click();
      else await arrive('open-operations','abrir operaciones heka',open);
      await expect(page).toHaveURL(url=>`${url.pathname}${url.search}`===ops);
      await expect(page.getByText('Entorno Heka: Pruebas.',{exact:true})).toBeVisible();
      await page.goto(location);
      await arrive('disconnect','quitar llave heka',panel.getByRole('button',{name:'Retirar llave del panel',exact:true}));
      await panel.getByRole('button',{name:'Retirar llave del panel',exact:true}).click();
      const withdrawal=page.getByRole('dialog',{name:'Retirar la llave de Heka',exact:true});
      await expect(withdrawal).toContainText('Esto no revoca la llave en Heka');
      expect(await get()).toEqual(state);
      await withdrawal.getByRole('button',{name:'Retirar llave del panel',exact:true}).click();
      await expect(withdrawal).toHaveCount(0);
      expect(await get()).toEqual({configured:false,environment:'test',version:state.version+1});
      expect(writes.slice(count)).toEqual(['PUT','DELETE']);
    });
    expect(forbidden).toEqual([]);
  }finally{
    const current=await get();
    if(current.configured){
      const reset=await page.request.delete(path,{headers,data:{version:current.version}});
      expect(reset.ok(),await reset.text()).toBe(true);
    }
  }
});

test('Ali @advisor-c6: conserva la celda y el grupo elegidos en la revisión de Excel',async({page,context,request},info)=>{
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actorId=await fixtureActor(context,store);
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Resolución Excel ${randomUUID()}`},actorId);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const batch=await prepareAdvisorImportBatch(store,{sourceId:source.id,actorId});
    const {sheet,rowNumber,columnIndex}=advisorImportWorkbook().correction;
    const path=`/admin?section=orders&tab=imports&batch=${batch.id}`;
    const endpoint=`/api/admin/imports/${batch.id}`;
    const writes=[];
    page.on('request',req=>{
      const url=new URL(req.url());
      if(!/^\/api\/admin\/(?:imports|business)(?:\/|$)/.test(url.pathname)||req.method()==='GET')return;
      if(url.pathname===endpoint&&req.method()==='POST'&&req.postDataJSON()?.rowNumber===rowNumber)return;
      writes.push(`${req.method()} ${url.pathname}`);
    });
    const persisted=()=>store.readSnapshot(async tx=>({
      batch:await tx.db.get(`SELECT id,state,version FROM ${tx.t('import_batches')} WHERE id=?`,[batch.id]),
      rows:await tx.db.all(`SELECT * FROM ${tx.t('import_rows')} WHERE batch_id=? ORDER BY sheet,row_number`,[batch.id]),
      revisions:await tx.db.all(`SELECT revision FROM ${tx.t('import_revisions')} WHERE batch_id=? ORDER BY revision`,[batch.id]),
      expenses:await tx.db.all(`SELECT id FROM ${tx.t('expenses')} WHERE data::jsonb->>'sourceId'=?`,[source.id]),
    }));
    const baseline=await persisted();
    const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
    const group=wizard.locator('[data-import-operation]').filter({hasText:`Ubicación: ${sheet} · fila ${rowNumber}`});
    const cases=[
      {id:'imports.correct-cell',query:'modificar celda excel',label:'Completar o corregir celda',async open(){
        await group.getByRole('button',{name:'Ver fila original',exact:true}).click();
        const row=wizard.getByRole('heading',{name:`${sheet} · fila ${rowNumber}`,exact:true}).locator('..');
        await row.getByText('Valores originales por posición',{exact:true}).click();
        await row.getByRole('button',{name:`Completar o corregir columna ${columnIndex+1}`,exact:true}).click();
      },async fill(editor){
        await expect(editor.getByLabel('Columna de la celda',{exact:true})).toHaveValue(String(columnIndex+1));
        await expect(editor).toContainText('El original no se modifica');
        await editor.getByRole('combobox',{name:'Tipo de valor',exact:true}).selectOption('number');
        await editor.getByRole('textbox',{name:'Valor corregido',exact:true}).fill('8500');
      },async check(editor){
        await expect(editor.getByRole('textbox',{name:'Valor corregido',exact:true})).toHaveValue('8500');
      }},
      {id:'imports.omit-group',query:'no importar este grupo',label:'Omitir grupo completo',async open(){
        await group.locator('[data-import-other-options] > summary').click();
        await group.getByRole('button',{name:'Omitir grupo completo',exact:true}).click();
      },async fill(editor){
        await expect(editor.getByRole('region',{name:'Alcance de la exclusión',exact:true})).toContainText('No se modifica el Excel original');
      },async check(editor){
        await expect(editor).toContainText(`Ubicación conocida: ${sheet} · fila ${rowNumber}`);
      }},
    ];
    for(const step of cases)for(const via of ['panel','chat','directorio'])await test.step(`${step.id} · ${via}`,async()=>{
      await page.goto(path);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      await step.open();
      const editor=page.getByRole('dialog',{name:step.label,exact:true}),reason=editor.getByLabel('Motivo de la resolución',{exact:true});
      const draft=`Decisión sintética ${randomUUID()}`;
      await reason.fill(draft);
      await step.fill(editor);
      if(via!=='panel'){
        await editor.getByRole('button',{name:'Ayúdame con esta resolución',exact:true}).click();
        let entry=page.locator('dialog[open]').filter({has:page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true})});
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${step.query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(step.query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        const action=entry.locator(`[data-capability-id="${step.id}"]`).last();
        await expect(action).not.toContainText(draft);
        await action.getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(reason).toBeFocused();
      }
      await expect(reason).toHaveValue(draft);
      await step.check(editor);
      await expect(page).toHaveURL(url=>url.pathname+url.search===path);
      if(via==='directorio'&&step.id==='imports.correct-cell')await screenshot(page,info,'advisor-c6-excel-celda-exacta-sin-guardar');
      await editor.getByRole('button',{name:'Preparar corrección',exact:true}).click();
      await expect(editor).toHaveCount(0);
      await wizard.getByText(/^Resoluciones preparadas \(1\)/).click();
      await expect(wizard.getByRole('listitem').filter({hasText:draft})).toContainText(step.label);
      expect(await persisted()).toEqual(baseline);
    });
    expect(writes).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: crea el origen de Excel y otra cuenta sin subir el archivo elegido',async({page,request},info)=>{
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const path='/admin?section=orders&tab=imports&batch=new',platforms='/api/admin/business/platforms',sources='/api/admin/business/sources';
  const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
  const origin=wizard.getByRole('combobox',{name:'Origen',exact:true}),file=wizard.getByLabel('Archivo Excel',{exact:true});
  const originName=wizard.getByRole('textbox',{name:'Nombre del origen',exact:true});
  const accountName=wizard.getByRole('textbox',{name:'Nombre de la otra cuenta',exact:true});
  const writes=[];
  page.on('request',req=>{
    const {pathname}=new URL(req.url());
    if(req.method()!=='GET'&&/^\/api\/admin\/(?:business|imports|finance|orders)(?:\/|$)/.test(pathname))writes.push(`${req.method()} ${pathname}`);
  });
  async function open(via,id,query,target){
    const chat=await openAli(page);
    let entry=chat;
    if(via==='chat')await askAliCatalog(chat,`¿Dónde está ${query}?`);
    else{
      await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
      await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
      await entry.getByRole('button',{name:'Buscar',exact:true}).click();
    }
    await entry.locator(`[data-capability-id="imports.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
    await expect(target).toBeFocused();
  }
  async function records(endpoint){
    const response=await page.request.get(endpoint);
    expect(response.ok(),await response.text()).toBe(true);
    return (await response.json()).records;
  }
  const {bytes}=advisorImportWorkbook(),filename='origen-local-sintetico.xlsx';
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    await page.goto(path);
    await expect(origin).toHaveValue('');
    if(via!=='panel')await open(via,'create-source','crear cuenta de importación independiente',origin);
    await expect(accountName).toHaveCount(0);
    await file.setInputFiles({name:filename,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
    const count=writes.length, name=`Origen Excel ${randomUUID()}`,subName=`Cuenta Excel ${randomUUID()}`;
    if(via==='panel')await wizard.getByRole('button',{name:'Crear un origen para mis archivos',exact:true}).click();
    else await open(via,'create-origin','crear origen con principal',originName);
    await expect(originName).toHaveValue('');
    expect(writes).toHaveLength(count);
    await originName.fill(name);
    const platformSaved=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===platforms);
    await wizard.getByRole('button',{name:'Crear origen',exact:true}).click();
    const platformResponse=await platformSaved;
    expect(platformResponse.ok(),await platformResponse.text()).toBe(true);
    const platform=await platformResponse.json();
    expect(platform).toMatchObject({name,active:true});
    await expect(origin).toHaveValue(platform.id);
    await expect(wizard.getByRole('strong').filter({hasText:/^Principal$/})).toBeVisible();
    const accounts=`${sources}?platform=${encodeURIComponent(platform.id)}`;
    expect((await records(accounts)).map(item=>item.name)).toEqual(['Principal']);
    if(via==='panel')await wizard.getByText('Uso otra cuenta de este origen',{exact:true}).click();
    else await open(via,'create-source','crear cuenta de importación independiente',accountName);
    await expect(accountName).toHaveValue('');
    await expect(origin).toHaveValue(platform.id);
    expect(writes.slice(count)).toEqual([`POST ${platforms}`]);
    await accountName.fill(subName);
    const sourceSaved=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===sources);
    await wizard.getByRole('button',{name:'Crear cuenta independiente',exact:true}).click();
    const sourceResponse=await sourceSaved;
    expect(sourceResponse.ok(),await sourceResponse.text()).toBe(true);
    const source=await sourceResponse.json();
    expect(source).toMatchObject({name:subName,platformId:platform.id});
    await expect(wizard.getByRole('combobox',{name:'Cuenta de origen',exact:true})).toHaveValue(source.id);
    await expect(wizard.getByText(filename,{exact:true})).toBeVisible();
    expect(writes.slice(count)).toEqual([`POST ${platforms}`,`POST ${sources}`]);
    expect((await records(accounts)).map(item=>item.name).sort()).toEqual([subName,'Principal'].sort());
  });
});

test('Ali @advisor-c6: conserva el alcance de propuestas de hoja, variante, estados y libro',async({page,context,request},info)=>{
  test.setTimeout(150000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const headings=['ESTADO','FECHA','NOMBRE Y APELLIDO','PRODUCTO','CANTIDAD','PRECIO VENTA UND'];
  const bytes=writeExcelSheets([
    {name:'ENERO',rows:[headings,['ENTREGADO','2026-01-21','Persona sintética A','Referencia A',1,45000]]},
    {name:'FEBRERO',rows:[headings,['REPARTO','2026-02-22','Persona sintética B','Referencia B',2,59000]]},
    {name:'NOTAS',rows:[['INSTRUCCIONES'],['Solo texto; no es una tabla de ventas.']]},
  ]);
  const w=page.getByRole('region',{name:'Importar Excel',exact:true});
  const button=(text,scope=w)=>scope.getByRole('button',{name:text,exact:true});
  const card=name=>w.locator(`[data-import-sheet="${name}"]`);
  const posts=[];
  let endpoint='';
  page.on('request',req=>{
    if(!endpoint||req.method()==='GET')return;
    const path=new URL(req.url()).pathname;
    if(/^\/api\/admin\/(?:imports|orders|finance)(?:\/|$)/.test(path))posts.push(`${req.method()} ${path}`);
  });
  async function go(via,id,query,target){
    if(via==='panel')return;
    let entry=await openAli(page);
    if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
    else{
      await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
      await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
      await entry.getByRole('button',{name:'Buscar',exact:true}).click();
    }
    await entry.locator(`[data-capability-id="imports.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
    await expect(target).toBeFocused();
  }
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
  const actorId=await fixtureActor(context,store);
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Hojas para contraste ${randomUUID()}`},actorId);
    const [src]=await listResources(store,'sources',{platform:platform.id});
    const {id:batchId,version}=await createImportBatch(store,{requestId:randomUUID(),sourceId:src.id},actorId);
    await uploadImportFile(store,batchId,{requestId:randomUUID(),filename:'variantes-sinteticas.xlsx',bytes,version},actorId);
    await processImportTurn(store,{batchId,expectedPhase:'inspect'});
    await expect.poll(async()=>Boolean((await getImportBatch(store,batchId)).workbook)).toBe(true);
    endpoint=`/api/admin/imports/${batchId}`;
    const baseline=await (await page.request.get(endpoint)).json(),seen=posts.length;
    await page.goto(`/admin?section=orders&tab=imports&batch=${batchId}`);
    const workbookAction=button('Aplicar propuesta del libro');
    await expect(workbookAction).toBeEnabled();
    await expect(card('ENERO')).toContainText('Sin decidir');
    await expect(card('FEBRERO')).toContainText('Sin decidir');
    await button('Elegir FEBRERO',card('FEBRERO')).click();
    const sheetAction=button('Usar propuesta de FEBRERO',card('FEBRERO'));
    await go(via,'apply-sheet-suggestion','propuesta para esta hoja',sheetAction);
    await expect(card('ENERO')).toContainText('Sin decidir');
    await expect(card('FEBRERO')).toContainText('Sin decidir');
    await sheetAction.click();
    await expect(button('Configurar FEBRERO',card('FEBRERO'))).toBeVisible();
    await expect(card('ENERO')).toContainText('Sin decidir');

    const similar=button('Aplicar a hojas similares a FEBRERO',card('FEBRERO'));
    await go(via,'apply-matching-sheets','repetir mapeo compatible',similar);
    await similar.click();
    const variant=page.getByRole('dialog',{name:'Aplicar configuración a hojas similares',exact:true});
    const affected=dialog=>dialog.getByRole('region',{name:'Elementos afectados',exact:true});
    await expect(affected(variant).getByRole('strong')).toHaveText(['ENERO']);
    await expect(variant).toContainText('El corte se confirmará por separado');
    await button('Aplicar a estas hojas',variant).click();
    await expect(button('Configurar ENERO',card('ENERO'))).toBeVisible();
    await expect(card('NOTAS')).toContainText('Sin decidir');

    const states=button('Revisar equivalencias de estados propuestas');
    await go(via,'map-statuses','mapear estados externos',states);
    await states.click();
    const aliases=page.getByRole('dialog',{name:'Confirmar equivalencias de seguimiento',exact:true});
    await expect(affected(aliases)).toContainText('FEBRERO · ENTREGADO');
    await expect(affected(aliases)).toContainText('ENERO · ENTREGADO');
    await expect(affected(aliases)).not.toContainText('NOTAS');
    await expect(aliases).toContainText('Un estado administrativo no confirma entrega ni cobro');
    await button('Usar estas equivalencias',aliases).click();
    await w.locator('summary').filter({hasText:/^Equivalencias del estado de entrega \/ seguimiento$/}).click();
    const delivered=w.locator('.order-line').filter({hasText:'Identificador exacto del archivo: ENTREGADO'});
    await expect(delivered.getByRole('combobox',{name:'Estado en All Nutrition',exact:true})).toHaveValue('delivered');

    await go(via,'apply-workbook-suggestion','mapear ventas mensuales y publicidad',workbookAction);
    await workbookAction.click();
    const proposal=page.getByRole('dialog',{name:'Revisar propuesta del libro',exact:true});
    const exclusions=affected(proposal).getByRole('listitem').filter({hasText:'NOTAS'});
    await expect(exclusions).toContainText('No importar');
    await expect(affected(proposal).getByRole('listitem').filter({hasText:'Incluir y usar propuesta'})).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(proposal).toHaveCount(0);
    await expect(card('NOTAS')).toContainText('Sin decidir');
    await workbookAction.click();
    await button('Usar estas propuestas',proposal).click();
    await expect(card('NOTAS')).toContainText('Excluida');
    await expect(button('Configurar ENERO',card('ENERO'))).toBeVisible();
    await expect(button('Configurar FEBRERO',card('FEBRERO'))).toBeVisible();
    const saved=await (await page.request.get(endpoint)).json();
    expect(saved).toMatchObject({id:batchId,version:baseline.version,fileHash:baseline.fileHash,config:baseline.config});
    expect(posts.slice(seen)).toEqual([]);
  });
  }finally{await store.close();}
});

test('Ali @advisor-c6: abre ayuda, ofrece ideas editables y espera el envío explícito',async({page,request},info)=>{
  test.setTimeout(105000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const dialog=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
  const heading=dialog.getByRole('heading',{name:/^Asistente de/});
  const ideas=dialog.getByRole('group',{name:'Ideas para empezar',exact:true});
  const composer=dialog.getByRole('textbox',{name:'Mensaje para Ali',exact:true});
  const turns=[],businessWrites=[];
  page.on('request',req=>{
    if(req.method()==='GET')return;
    const path=new URL(req.url()).pathname;
    if(path==='/api/admin/assistant/turns')turns.push(req.postDataJSON()?.message);
    if(/^\/api\/admin\/(?:orders|business|finance|imports|assistant\/proposals)(?:\/|$)/.test(path))businessWrites.push(path);
  });
  async function locate(via,id,query,target){
    if(via==='panel')return;
    let entry=dialog;
    if(via==='chat')await askAliCatalog(dialog,`¿Dónde está ${query}?`);
    else{
      await dialog.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
      await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
      await entry.getByRole('button',{name:'Buscar',exact:true}).click();
    }
    const card=entry.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/});
    await expect(card).toBeEnabled();
    const count=turns.length;
    await card.click();
    await expect(target).toBeFocused();
    expect(turns).toHaveLength(count);
  }
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    await page.goto('/admin?section=orders');
    const before=turns.length;
    await openAli(page);
    await expect(heading).toBeVisible();
    expect(turns).toHaveLength(before);
    await locate(via,'open-console','abrir ali',heading);
    await locate(via,'suggested-message','ideas para empezar',ideas);
    await expect(ideas).toBeVisible();
    const count=turns.length;
    await ideas.getByRole('button',{name:'Explicar esta sección',exact:true}).click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('Explícame qué puedo hacer aquí y cómo empezar.');
    expect(turns).toHaveLength(count);
    await locate(via,'ask','consultar ali',composer);
    if(via==='directorio')await expect(composer).toHaveValue('Explícame qué puedo hacer aquí y cómo empezar.');
    const consulted=turns.length;
    const edited='¿Dónde está cotizar flete?';
    await composer.fill(edited);
    await expect(composer).toHaveValue(edited);
    expect(turns).toHaveLength(consulted);
    await dialog.getByRole('button',{name:'Enviar',exact:true}).click();
    await expect(dialog.locator('[data-capability-id="heka.quote-shipment"]').last()).toContainText('Consultar una cotización de Heka');
    expect(turns.slice(consulted)).toEqual([edited]);
    expect(businessWrites).toEqual([]);
    await expect(page).toHaveURL(url=>url.searchParams.get('section')==='orders');
  });
});

test('Ali @advisor-c6: devuelve a las fuentes y registros de una respuesta identificable',async({page,request},info)=>{
  test.setTimeout(115000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  let product;
  try{[product]=await store.list('products');}finally{await store.close();}
  expect(product?.id).toBeTruthy();
  const requests=[];
  page.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(req.method()==='GET'&&/^\/api\/admin\/assistant\/turns\/[^/]+\/reads\/all$/.test(path))requests.push(path);
  });
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    await page.goto('/admin?section=products');
    const chat=await openAli(page);
    await askAli(chat,`Consulta este producto exacto ${JSON.stringify({domain:'catalog',query:{kind:'products',id:product.id}})}`);
    const answer=chat.locator('article[data-assistant-turn]').filter({hasText:product.title});
    const result=answer.getByTestId('assistant-result');
    const summary=result.locator('summary').filter({hasText:/^Fuentes \(\d+\)$/});
    const records=result.getByRole('button',{name:'Ver registros consultados',exact:true});
    async function locate(id,query,target){
      if(via==='panel')return;
      let entry=chat;
      if(via==='chat')await askAliCatalog(chat,`¿Dónde está ${query}?`);
      else{
        await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(target).toBeFocused();
    }
    await expect(summary).toBeVisible();
    const turn=await answer.getAttribute('data-assistant-turn'),before=requests.length;
    await locate('read-records','ver registros consultados',records);
    expect(requests).toHaveLength(before);
    await records.click();
    const read=chat.getByRole('region',{name:'Registros consultados',exact:true});
    await expect(read).toContainText(product.title);
    expect(requests.slice(before)).toEqual([`/api/admin/assistant/turns/${turn}/reads/all`]);
    await read.getByRole('button',{name:'Cerrar registros',exact:true}).click();
    await locate('sources','fuentes del análisis',summary);
    await expect(summary.locator('..')).not.toHaveAttribute('open','');
    await summary.click();
    const proof=result.locator('details[open] [data-source-id]').filter({hasText:product.title});
    await proof.getByRole('link',{name:'Abrir fuente',exact:true}).click();
    await expect(page).toHaveURL(url=>url.searchParams.get('section')==='products'&&url.searchParams.get('record')===product.id);
    await expect(chat).toBeHidden();
    expect(requests).toHaveLength(before+1);
  });
});

test('Ali @advisor-c6: entrega el alta de administrador sin recibir la contraseña',async({page,request},info)=>{
  test.setTimeout(105000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const endpoint='/api/admin/users';
  const form=page.getByRole('region',{name:'Crear usuario',exact:true});
  const email=form.getByRole('textbox',{name:/Correo electrónico/}),password=form.getByLabel(/^Contraseña inicial/),confirmation=form.getByLabel(/^Confirmar contraseña/);
  const create=form.getByRole('button',{name:'Crear usuario',exact:true});
  const turns=[],posts=[];
  page.on('request',req=>{
    if(req.method()!=='POST')return;
    const {pathname}=new URL(req.url());
    if(pathname==='/api/admin/assistant/turns')turns.push(req.postData());
    if(pathname===endpoint)posts.push(pathname);
  });
  const users=async()=>{
    const response=await page.request.get(endpoint);
    expect(response.ok()).toBe(true);
    return (await response.json()).users;
  };
  for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
    await page.goto('/admin?section=users');
    await expect(create).toBeEnabled();
    const address=`alta-ali-${randomUUID()}@example.test`,secret=`Solo-fixture-${randomUUID()}`,count=posts.length;
    const previous=await users();
    await email.fill(address);
    await password.fill(secret);
    await confirmation.fill(`${secret}-distinta`);
    if(via!=='panel'){
      let entry=await openAli(page);
      if(via==='chat')await askAliCatalog(entry,'¿Dónde está crear usuario del panel?');
      else{
        await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill('crear usuario del panel');
        await entry.getByRole('button',{name:'Buscar',exact:true}).click();
      }
      await entry.locator('[data-capability-id="business.user-create"]').last().getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(create).toBeFocused();
    }
    await expect(email).toHaveValue(address);
    await expect(password).toHaveValue(secret);
    expect(turns.every(body=>!body.includes(address)&&!body.includes(secret))).toBe(true);
    expect(posts).toHaveLength(count);
    await create.click();
    await expect(form.getByRole('alert')).toHaveText('Las contraseñas no coinciden.');
    expect(posts).toHaveLength(count);
    expect(await users()).toEqual(previous);
    await confirmation.fill(secret);
    await create.click();
    await expect(form.getByRole('status').filter({hasText:address})).toContainText('creada con rol Administrador');
    expect(posts).toHaveLength(count+1);
    expect((await users()).filter(user=>user.email===address)).toEqual([expect.objectContaining({active:true,role:'administrator'})]);
    await expect(password).toHaveValue('');
    await expect(confirmation).toHaveValue('');
    await expect(form).toContainText('No se envía una invitación automática ni un correo');
  });
});

test('Ali @advisor-c6: separa opciones locales, publicación y salud técnica de Meta',async({page,request},info)=>{
  test.setTimeout(130000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const origin=new URL(page.url()).origin,path='/admin?section=business&tab=social',endpoint='/api/admin/social/settings';
  const panel=page.getByRole('region',{name:'Configuración de redes sociales',exact:true});
  const form=panel.getByRole('form',{name:'Opciones de Meta',exact:true});
  const heading=form.getByRole('heading',{name:'Configurar la aplicación',exact:true});
  const publication=form.getByRole('checkbox',{name:'Habilitar publicación y activación',exact:true});
  const browser=form.getByRole('checkbox',{name:'Habilitar acceso asistido por navegador',exact:true});
  const health=panel.locator('summary').filter({hasText:/^Detalles técnicos del acceso$/});
  const writes=[],remote=[],turns=[];
  page.on('request',req=>{
    const url=new URL(req.url());
    if(url.origin!==origin)remote.push(url.origin);
    if(url.pathname.startsWith('/api/admin/social')&&req.method()!=='GET')writes.push(`${req.method()} ${url.pathname}`);
    if(url.pathname==='/api/admin/assistant/turns'&&req.method()==='POST')turns.push(req.postData());
  });
  async function get(){
    const response=await page.request.get(endpoint);
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function save(){
    const response=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===endpoint);
    await form.getByRole('button',{name:'Guardar opciones de Meta',exact:true}).click();
    const result=await response;
    expect(result.ok(),await result.text()).toBe(true);
    const current=await result.json();
    await expect(form.getByRole('status').filter({hasText:'Opciones guardadas'})).toContainText('No se publicó ni activó ningún anuncio');
    expect(await get()).toEqual(current);
    return current;
  }
  async function arrive(via,id,query,target){
    if(via==='panel')return;
    let entry=await openAli(page);
    if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
    else{
      await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
      entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
      await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
      await entry.getByRole('button',{name:'Buscar',exact:true}).click();
    }
    await entry.locator(`[data-capability-id="business.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
    await expect(target).toBeFocused();
  }
  for(const [index,via] of ['panel','chat','directorio'].entries())await test.step(via,async()=>{
    await page.goto(path);
    await expect(panel).toBeVisible();
    const baseline=await get(),count=writes.length;
    expect(baseline).toMatchObject({publishingEnabled:false,browserEnabled:false});
    await arrive(via,'social-settings','configurar redes sociales',panel);
    await expect(panel).toContainText('Guardar opciones o conectar no publica ni activa anuncios');
    expect(writes).toHaveLength(count);

    if(via==='panel')await panel.locator('summary').filter({hasText:/^Opciones de Meta$/}).click();
    else await arrive(via,'meta-settings-save','app de meta',heading);
    await expect(heading).toBeVisible();
    const key=form.locator('input[name=appSecret]'),id='991100001',loginConfig=`99110${index}${info.project.name==='mobile'?2:1}031`,secret=`synthetic-key-${randomUUID()}`;
    await form.locator('input[name=publicBaseUrl]').fill(origin);
    const connections=await page.request.get('/api/admin/social/connections');
    expect(connections.ok()).toBe(true);
    const lockedAppId=(await connections.json()).connections.some(connection=>connection.integrationMethod==='api'&&connection.state!=='disconnected');
    const appId=lockedAppId?baseline.appId||'':baseline.appId||id;
    await form.locator('input[name=appId]').fill(appId);
    await form.locator('input[name=loginConfigId]').fill(loginConfig);
    if(!baseline.hasAppSecret){
      await key.fill(secret);
      await arrive(via,'meta-settings-save','app de meta',heading);
      await expect(key).toHaveValue(secret);
    }
    expect(turns.every(body=>!body.includes(secret))).toBe(true);
    expect(await get()).toMatchObject({version:baseline.version});
    const saved=await save();
    expect(saved).toMatchObject({version:baseline.version+1,publicBaseUrl:origin,appId,loginConfigId:loginConfig,hasAppSecret:true,publishingEnabled:false,browserEnabled:false});
    expect(saved).not.toHaveProperty('appSecret');
    await expect(key).toHaveValue('');
    await arrive(via,'meta-browser-setting','habilitar acceso asistido',browser);
    await expect(browser).not.toBeChecked();
    await browser.check();
    expect(await get()).toMatchObject({version:saved.version,browserEnabled:false});
    const enabled=await save();
    expect(enabled).toMatchObject({version:saved.version+1,browserEnabled:true,publishingEnabled:false});

    await arrive(via,'meta-publishing-setting','habilitar publicación y activación',publication);
    await expect(publication).not.toBeChecked();
    await publication.check();
    expect(await get()).toMatchObject({version:enabled.version,publishingEnabled:false});
    expect(await save()).toMatchObject({version:enabled.version+1,browserEnabled:true,publishingEnabled:true});
    await expect(form).toContainText('no confirma detener gasto remoto');

    if(via==='panel')await panel.locator('summary').filter({hasText:/^Estado del acceso asistido$/}).click();
    else await arrive(via,'meta-browser-health','estado navegador meta',health);
    await health.click();
    await expect(panel).toContainText('Servicio disponible no significa sesión iniciada en Meta');
    await expect(panel).toContainText('Último heartbeat:');
    if(via==='directorio')await screenshot(page,info,'advisor-c6-meta-version-y-acceso');
    await browser.uncheck();await publication.uncheck();
    expect(await save()).toMatchObject({browserEnabled:false,publishingEnabled:false});
    expect(writes.slice(count)).toEqual(Array(4).fill(`PUT ${endpoint}`));
    expect(remote).toEqual([]);
  });
});

test('Ali @advisor-c6: conserva la decisión de inventario del evento de la guía exacta',async({page,context,request},info)=>{
  test.setTimeout(110000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear(),openingOn=`${year}-10-01`;
    const previousDay=`${year}-09-30`,command=input=>({requestId:randomUUID(),...input});
    const writes=[];
    page.on('request',req=>{
      const url=new URL(req.url());
      if(req.method()==='POST'&&/^\/api\/admin\/business\/shipments\/[^/]+\/events$/.test(url.pathname))writes.push(req.postDataJSON());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,10),platform=await saveResource(store,'platforms',command({name:`Conteo de envío ${tag}`}),actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const batch=await createImportBatch(store,command({sourceId:source.id}),actor);
      const product=await store.save('products',{...emptyRecord('products'),title:`Producto contado ${tag}`,slug:`conteo-envio-${tag}`,status:'draft',orderable:true,presentation:'Unidad',price:55000,unitCostMinor:2000000,costEffectiveOn:`${year}-09-01`,stockQuantity:10},null,null,actor);
      const order=await store.transaction(async tx=>{
        await tx.lockWrites();
        const saved=await saveOrderTx(tx,businessOrderInput(product,{placedOn:previousDay,customerName:`Pedido sintético ${tag}`}),actor,null,null,{deferInventory:true});
        await initializeInventoryOpeningTx(tx,saved.id,{on:openingOn,sourceId:source.id,batchId:batch.id},actor);
        return saved;
      });
      const tracking=`AP-${tag}`,guide=await createShipment(store,command({orderId:order.id,carrier:'Transportadora sintética',tracking,occurredOn:previousDay}),actor);
      const endpoint=`/api/admin/business/shipments/${guide.id}/events`;
      await page.goto(`/admin?section=orders&tab=shipments&record=${guide.id}`);
      const drawer=page.getByRole('dialog',{name:tracking,exact:true});
      const form=drawer.getByRole('heading',{name:'Registrar estado y fecha',exact:true}).locator('..');
      const choice=form.getByRole('combobox',{name:`Relación con el conteo físico del ${openingOn}`,exact:true});
      await form.getByRole('combobox',{name:'Estado observado',exact:true}).selectOption('collected');
      await form.getByRole('combobox',{name:'Precisión de la fecha',exact:true}).selectOption('day');
      await form.getByLabel('Fecha real del evento',{exact:true}).fill(previousDay);
      await expect(choice).toHaveCount(0);
      await form.getByLabel('Fecha real del evento',{exact:true}).fill(openingOn);
      await form.getByLabel('Corte de esta observación (Bogotá)',{exact:true}).fill(`${openingOn}T15:00`);
      const reason='Guía sintética cotejada con el conteo';
      await form.getByLabel('Motivo',{exact:true}).fill(reason);
      const start=await store.order(order.id),before=await store.get('products',product.id),count=writes.length;
      expect(start.inventoryOpening.eventClassifications).toEqual([]);
      if(via!=='panel'){
        await form.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        if(via==='chat')await askAliCatalog(entry,'¿Dónde está evento anterior al conteo?');
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill('evento anterior al conteo');
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator('[data-capability-id="shipments.classify-event-opening"]').last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(choice).toBeFocused();
      }
      await expect(choice).toHaveValue('');
      await expect(form.getByLabel('Motivo',{exact:true})).toHaveValue(reason);
      expect(await store.order(order.id)).toEqual(start);
      expect(writes).toHaveLength(count);
      const included=via!=='chat';
      await choice.selectOption(String(included));
      const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
      await form.getByRole('button',{name:'Guardar evento',exact:true}).click();
      const saved=await response;
      expect(saved.ok(),await saved.text()).toBe(true);
      const details=await saved.json(),event=details.events.find(item=>item.reason===reason);
      expect(event).toMatchObject({status:'collected',occurredOn:openingOn,reason});
      const after=await store.order(order.id);
      expect(after.inventoryOpening.eventClassifications).toEqual([expect.objectContaining({eventId:event.id,included,confirmedBy:actor,reason})]);
      expect((await store.get('products',product.id)).stockQuantity).toBe(before.stockQuantity-(included?0:1));
      expect(writes.slice(count)).toEqual([expect.objectContaining({inventoryOpeningIncluded:included})]);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: concilia un pago histórico sin deducir un asiento de caja',async({page,context,request},info)=>{
  test.setTimeout(150000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  const mobile=info.project.name==='mobile';
  if(mobile)await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),day=bogotaDate(),tag=randomUUID().slice(0,8);
    const product=await store.save('products',{...emptyRecord('products'),title:`Producto con histórico ${tag}`,slug:`producto-historico-${tag}`,status:'draft',price:25000,presentation:'Unidad',orderable:true,stockQuantity:10},null,null,actor);
    const person=await saveResource(store,'people',{requestId:randomUUID(),name:`Responsable histórico ${tag}`},actor);
    const cash=await saveAccount(store,{requestId:randomUUID(),name:`Banco histórico ${tag}`,type:'bank',openingOn:day,openingBalanceMinor:2000000,responsibleId:person.id},actor);
    const movements=()=>store.db.all(`SELECT id,amount_minor,effective_on,source_type FROM ${store.t('cash_entries')} WHERE account_id=? AND source_type<>'opening' ORDER BY id`,[cash.id]);
    const endpoint='/api/admin/business/actions/resolve-legacy-payment',posts=[];
    page.on('request',req=>{
      if(req.method()==='POST'&&new URL(req.url()).pathname===endpoint)posts.push(req.postDataJSON());
    });
    for(const [mode,id,query,label] of [
      ['opening_balance','reconcile-legacy-opening','ya estaba en saldo inicial','Ya incluido en saldo inicial, sin nuevo movimiento de caja'],
      ['cash_movement','reconcile-legacy-cash','registrar depósito de pago histórico','Registrar un movimiento real en la cuenta elegida'],
    ])for(const via of ['panel','chat','directorio'])await test.step(`${mode} · ${via}`,async()=>{
      const move=mode==='cash_movement',order=await store.saveOrder(businessOrderInput(product,{placedOn:day,customerName:`Histórico ${via} ${tag}`}),actor);
      const legacy=randomUUID();
      await store.transaction(async tx=>{
        const row=await tx.db.get(`SELECT data FROM ${tx.t('orders')} WHERE id=?`,[order.id]);
        const data={...JSON.parse(row.data),legacyFinancialReview:{required:true,state:'pending',reason:'legacy_payment_unreconciled',paymentStatus:'partial',paymentAmount:8000}};
        await tx.db.run(`UPDATE ${tx.t('orders')} SET data=? WHERE id=?`,[JSON.stringify(data),order.id]);
        await insertRow(tx,'order_collections',{id:legacy,order_id:order.id,shipment_id:null,kind:'receipt',holder:'legacy',amount_minor:800000,occurred_on:null,cash_entry_id:null,reversal_of:null,external_key:`legacy:${order.id}:payment`,recorded_at:`${completedFixtureYear()}-03-01T15:00:00.000Z`,data:JSON.stringify({source:'legacy',requiresReconciliation:true})});
      });
      const start=await store.order(order.id),before=await movements(),count=posts.length;
      expect(start.paymentSummary.legacyReview).toBeTruthy();
      await page.goto(`/admin?section=orders&tab=list&record=${order.id}`);
      const drawer=page.getByRole('dialog',{name:`AN-${String(order.number).padStart(6,'0')}`,exact:true});
      const tabs=drawer.getByRole('navigation',{name:'Detalle del pedido',exact:true});
      if(mobile)await tabs.getByRole('combobox',{name:'Detalle del pedido',exact:true}).selectOption('collections');
      else await tabs.getByRole('button',{name:'Cobros',exact:true}).click();
      await drawer.getByRole('button',{name:'Conciliar pago histórico',exact:true}).click();
      const form=drawer.locator('.business-action-form'),choice=form.getByRole('radio',{name:label,exact:true}),submit=form.locator('button[type=submit]');
      const reason='Soporte de pago verificado en la fixture';
      await form.getByLabel(/^Motivo/).fill(reason);
      if(via!=='panel'){
        await drawer.getByRole('button',{name:'Ayúdame con este formulario',exact:true}).click();
        let entry=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="orders.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(choice).toBeFocused();
      }
      await expect(form.getByRole('radio',{checked:true})).toHaveCount(0);
      await expect(form.getByLabel(/^Motivo/)).toHaveValue(reason);
      await submit.click();
      expect(posts).toHaveLength(count);
      expect(await store.order(order.id)).toEqual(start);
      await choice.check();
      if(move){
        await form.getByLabel(/^Fecha real del movimiento/).fill(day);
        await form.getByRole('combobox',{name:/^Cuenta/}).selectOption(cash.id);
        await form.getByLabel(/^Método/).fill('Transferencia comprobada');
        await form.getByLabel(/^Referencia/).fill(`Depósito sintético ${tag} ${via}`);
      }else await expect(form.getByRole('combobox',{name:/^Cuenta/})).toHaveCount(0);
      const response=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===endpoint);
      await submit.click();
      const receipt=await response;
      expect(receipt.ok(),await receipt.text()).toBe(true);
      const data=await receipt.json();
      expect(data).toMatchObject({mode,order:{id:order.id,legacyFinancialReview:{state:'resolved',resolution:{mode,reason,originalDocumentIds:[legacy]}}}});
      expect(data.documents).toEqual([expect.objectContaining({amountMinor:800000,occurredOn:move?day:null,cashEntryId:move?expect.any(String):null})]);
      expect(posts.slice(count)).toEqual([expect.objectContaining({orderId:order.id,mode,reason})]);
      const after=await movements();
      if(move){
        const entries=after.filter(entry=>!before.some(item=>item.id===entry.id));
        expect(entries).toEqual([expect.objectContaining({id:data.documents[0].cashEntryId,effective_on:day})]);
        expect(Number(entries[0].amount_minor)).toBe(800000);
      }else expect(after).toEqual(before);
    });
  }finally{await store.close();}
});

async function prepareResolutionWorkbook(store,actor,source,year,{resolutions,inventoryOpening,filename='resoluciones.xlsx',sheetNames}={}){
  const cmd=data=>({requestId:randomUUID(),...data});
  let batch=await createImportBatch(store,cmd({sourceId:source.id}),actor);
  const id=batch.id;
  async function finish(phase){
    await expect.poll(async()=>{
      await processImportTurn(store,{batchId:id,...(phase==='inspect'?{expectedPhase:phase}:{})});
      batch=await getImportBatch(store,id);
      if(batch.state==='failed')throw new Error(`${phase}: ${JSON.stringify(batch.error||batch.diagnostic)}`);
      return phase==='inspect'?Boolean(batch.workbook):batch.state==='review';
    },{timeout:25000}).toBe(true);
  }
  const sheets=workbookOnboardingSheets({year}).filter(sheet=>sheet.rows.length&&(!sheetNames||sheetNames.includes(sheet.name)));
  await uploadImportFile(store,id,cmd({version:batch.version,filename,bytes:writeExcelSheets(sheets)}),actor);
  await finish('inspect');
  const config=workbookOnboardingConfig({year});
  config.sheets=config.sheets.filter(sheet=>sheet.enabled&&(!sheetNames||sheetNames.includes(sheet.sheetName)));
  batch=await updateImportBatch(store,id,cmd({version:batch.version,config,...(resolutions?{resolutions}:null),...(inventoryOpening?{inventoryOpening}:null)}),actor);
  if(batch.state==='uploaded')await finish('inspect');
  await requestImportPreview(store,id,cmd({version:batch.version}),actor);
  await finish('preview');
  return batch;
}

async function openExcelDecisionViaAli(page,variant,cap,query,control,form){
  if(variant==='panel')return;
  let entry;
  if(form){
    await form.getByRole('button',{name:'Ayúdame con esta resolución',exact:true}).click();
    entry=page.locator('dialog[open]').filter({has:page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true})});
  }else{
    const current=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
    entry=await current.isVisible()?current:await openAli(page);
  }
  if(variant==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
  else{
    await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
    entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
    await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
    await entry.getByRole('button',{name:'Buscar',exact:true}).click();
  }
  await entry.locator(`[data-capability-id="imports.${cap}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
  await expect(control).toBeFocused();
}

test('Ali @advisor-c6: conserva la referencia elegida al vincular registros de una revisión de Excel',async({page,context,request},info)=>{
  test.setTimeout(180000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),tag=randomUUID().slice(0,8),year=completedFixtureYear();
    const cmd=data=>({requestId:randomUUID(),...data});
    const platform=await saveResource(store,'platforms',cmd({name:`Vínculos Excel ${tag}`}),actor);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const product=await store.save('products',{...emptyRecord('products'),title:`Referencia física ${tag}`,slug:`ref-fisica-${tag}`,status:'draft',price:25000,presentation:'Unidad',orderable:true,stockQuantity:10},null,null,actor);
    await saveResource(store,'people',cmd({name:`Vendedor sintético ${tag}`}),actor);
    const known=await prepareResolutionWorkbook(store,actor,source,year),id=known.id;
    const path=`/admin?section=orders&tab=imports&batch=${id}`;
    const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
    const productIssue=wizard.getByRole('button',{name:'Vincular producto SKU-A',exact:true}).first();
    const writes=[];
    page.on('request',req=>{
      const {pathname}=new URL(req.url());
      if(/^\/api\/admin\/(?:imports|products|combos|orders|business|finance)(?:\/|$)/.test(pathname)&&req.method()!=='GET')writes.push(pathname);
    });
    for(const [cap,query,label,control,where] of [
      ['link-product','identificar producto importado','Vincular producto','import-product-identity','product'],
      ['create-linked-product','crear producto faltante','Vincular producto','import-create-linked-item','product'],
      ['link-seller','vincular vendedor importado','Vincular vendedor','import-seller-identity','orders'],
      ['link-order','vincular número an al excel','Vincular pedido','import-order-identity','orders'],
      ['link-shipment','vincular envío de archivo','Vincular envío','import-shipment-identity','orders'],
      ['link-expense','vincular gasto excel existente','Vincular gasto importado','import-expense-identity','expenses'],
    ])for(const via of ['panel','chat','directorio'])await test.step(`${cap} · ${via}`,async()=>{
      await page.goto(path);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      if(where==='product')await productIssue.click();
      else{
        if(where==='expenses')await wizard.getByRole('button',{name:'Todas las operaciones',exact:true}).click();
        const row=wizard.locator('[data-import-operation]').filter({hasText:where==='orders'?'ORDER-A':'OP-1'}).first();
        await row.locator('[data-import-other-options] > summary').click();
        await row.getByRole('button',{name:label,exact:true}).click();
      }
      const form=page.getByRole('dialog',{name:label,exact:true});
      const reason=form.getByLabel('Motivo de la resolución',{exact:true});
      const search=form.getByRole('textbox',{name:'Buscar registro real',exact:true});
      const selection=form.getByRole('combobox',{name:'Registro que se vinculará',exact:true});
      const draft=`Decisión sintética ${tag} ${via}`;
      await reason.fill(draft);
      await search.fill(tag);
      if(via!=='panel'){
        await form.getByRole('button',{name:'Ayúdame con esta resolución',exact:true}).click();
        let entry=page.locator('dialog[open]').filter({has:page.getByRole('button',{name:'¿Qué quieres hacer?',exact:true})});
        if(via==='chat')await askAliCatalog(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="imports.${cap}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(form.locator(`[data-advisor-control="${control}"]`)).toBeFocused();
      }
      await expect(form).toContainText(where==='product'?'Referencia SKU-A':where==='orders'?'ORDER-A':'Ubicación conocida: OPERACION · fila 2');
      await expect(reason).toHaveValue(draft);
      await expect(search).toHaveValue(tag);
      await expect(selection).toHaveValue('');
      if(cap==='link-product')await expect(selection.locator(`option[value="${product.id}"]`)).toContainText(product.title);
      if(cap==='link-seller')await expect(selection.getByRole('option',{name:`Vendedor sintético ${tag}`,exact:true})).toHaveCount(1);
      if(cap==='create-linked-product')await expect(form.getByRole('group',{name:'Elegir tipo de ficha nueva',exact:true}).getByRole('button')).toHaveCount(3);
      await expect(page).toHaveURL(url=>url.pathname+url.search===path);
      const saved=await getImportBatch(store,id);
      expect({version:saved.version,state:saved.state,resolutions:saved.resolutions}).toEqual({version:known.version,state:known.state,resolutions:known.resolutions});
    });
    expect(writes).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: vuelve a decisiones de revisión Excel sin aceptar por el operador',async({page,context,request},info)=>{
  test.setTimeout(180000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),tag=randomUUID().slice(0,8),year=completedFixtureYear();
    const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Decisiones Excel ${tag}`},actor);
    const [source]=await listResources(store,'sources',{platform:platform.id});
    const known=await prepareResolutionWorkbook(store,actor,source,year),id=known.id;
    const wizard=page.getByRole('region',{name:'Importar Excel',exact:true}),path=`/admin?section=orders&tab=imports&batch=${id}`;
    const writes=[];
    page.on('request',req=>{
      const {pathname}=new URL(req.url());
      if(/^\/api\/admin\/(?:imports|orders|business|finance)(?:\/|$)/.test(pathname)&&req.method()!=='GET')writes.push(pathname);
    });
    const rowDecisions=new Set(['mark-duplicate','confirm-independent-row','confirm-additional-quantity']);
    const variations=['panel','chat','directorio'];
    for(const [cap,query,label] of [
      ['mark-duplicate','omitir fila duplicada','Marcar fila duplicada'],
      ['confirm-independent-row','confirmar operaciones separadas','Confirmar operación independiente'],
      ['confirm-additional-quantity','sumar cantidad de fila','Contar como cantidad adicional'],
      ['resolve-observed-status','asignar estado de seguimiento importado','Asignar estado externo'],
      ['approve-historical-policy','política histórica excel','Aprobar política histórica'],
      ['review-source-authority','rectificar evidencia de fuente','Revisar autoridad o rectificación'],
      ['correct-commercial-data','corregir datos comerciales importados','Completar o corregir datos del pedido'],
      ['accept-cached-formulas','usar caché de formula','Aceptar valores guardados de fórmulas'],
    ])for(const via of variations)await test.step(`${cap} · ${via}`,async()=>{
      await page.goto(path);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      const allFormulas=cap==='accept-cached-formulas';
      if(allFormulas)await wizard.getByText('Otras opciones de corrección del archivo',{exact:true}).click();
      else await wizard.locator('[data-import-operation]').filter({hasText:'ORDER-A'}).first().locator('[data-import-other-options] > summary').click();
      await wizard.getByRole('button',{name:label,exact:true}).click();
      const form=page.getByRole('dialog',{name:label,exact:true});
      const reason=form.getByLabel('Motivo de la resolución',{exact:true});
      const draft=`Decisión revisada ${tag} ${via}`;
      await reason.fill(draft);
      if(rowDecisions.has(cap)){
        await form.getByRole('combobox',{name:'Hoja de origen',exact:true}).selectOption('VENTAS');
        await form.getByLabel('Fila de origen (si aplica)',{exact:true}).fill('2');
      }
      if(allFormulas)await form.getByRole('combobox',{name:'Hoja con fórmulas',exact:true}).selectOption('VENTAS');
      await openExcelDecisionViaAli(page,via,cap,query,reason,form);
      await expect(reason).toHaveValue(draft);
      await expect(form).toContainText(allFormulas?'Ubicación conocida: VENTAS':rowDecisions.has(cap)?'VENTAS · fila 2':'ORDER-A');
      if(cap==='resolve-observed-status'){
        const result=form.getByRole('combobox',{name:'Estado en All Nutrition',exact:true});
        await expect(result).toHaveValue('');
        await form.getByLabel('Texto exacto del estado en el archivo',{exact:true}).fill('Entregado');
        await result.selectOption('delivered');
      }
      if(cap==='approve-historical-policy'){
        const result=form.getByRole('combobox',{name:'Versión de regla aprobada',exact:true});
        await expect(result).toHaveValue('');
        await expect(result.locator('option').nth(1)).toBeAttached();
        await result.selectOption({index:1});
      }
      const consentName=cap==='review-source-authority'?/^Autorizar explícitamente saldo a favor/:cap==='correct-commercial-data'?/^Asignar vendedor explícitamente$/:allFormulas?/^He revisado estas fórmulas/:null;
      if(consentName){
        const consent=form.getByRole('checkbox',{name:consentName});
        await expect(consent).not.toBeChecked();
        await consent.check();
      }
      await form.getByRole('button',{name:'Preparar corrección',exact:true}).click();
      await expect(form).toHaveCount(0);
      await wizard.getByText(/^Resoluciones preparadas \(1\)/).click();
      await expect(wizard.getByRole('listitem').filter({hasText:draft})).toContainText(label);
      const saved=await getImportBatch(store,id);
      expect({version:saved.version,state:saved.state,resolutions:saved.resolutions}).toEqual({version:known.version,state:known.state,resolutions:known.resolutions});
    });
    for(const via of variations)await test.step(`confirm-inventory-opening · ${via}`,async()=>{
      await page.goto(path);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      const date=wizard.getByLabel('Fecha del conteo físico',{exact:true});
      const consent=wizard.getByRole('checkbox',{name:/^Confirmo que las existencias guardadas/});
      const openingOn=`${year}-09-30`;
      await date.fill(openingOn);
      await openExcelDecisionViaAli(page,via,'confirm-inventory-opening','apertura del inventario importado',date);
      await expect(date).toHaveValue(openingOn);
      await expect(consent).not.toBeChecked();
      await consent.check();
      await expect(wizard.getByText(`Apertura preparada para ${openingOn}.`,{exact:false})).toBeVisible();
      expect((await getImportBatch(store,id)).inventoryOpening).toBeNull();
    });
    expect(writes).toEqual([]);
  }finally{await store.close();}
});

test('Ali @advisor-c6: separa revisión, cancelación, confirmación y recibo de una propuesta',async({page,context,request},info)=>{
  test.setTimeout(160000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const user=await fixtureActor(context,store);
    const calls=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()==='POST'&&path.startsWith('/api/admin/assistant/proposals/'))calls.push(req.postDataJSON());
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const name=`Propuesta única ${randomUUID().slice(0,8)}`;
      const source=await saveSocialCampaign(store,{name,mode:'organic',objective:'reach',caption:'Texto sintético del borrador',platforms:['facebook'],requestId:randomUUID()},user);
      const duplicates=()=>store.db.all(`SELECT id FROM ${store.t('social_campaigns')} WHERE data::jsonb->>'parentCampaignId'=?`,[source.id]);
      const path=`/admin?section=advertising&tab=campaigns&record=${source.id}`;
      await page.goto(path);
      const chat=await openAli(page);
      const proposal=chat.getByRole('region',{name:'Propuesta de cambio',exact:true});
      const confirm=proposal.getByRole('button',{name:'Confirmar duplicación',exact:true});
      const reach=async(id,query,target)=>{
        if(via==='panel')return;
        let entry=chat;
        if(via==='chat')await askAli(entry,`¿Dónde está ${query}?`);
        else{
          await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      };
      const before=calls.length;
      await askAli(chat,`Duplica la campaña «${name}»`);
      await expect(confirm).toBeEnabled();
      await reach('proposal-review','ver diff de propuesta',proposal);
      await expect(proposal).toContainText('Pendiente de revisión');
      await expect(proposal).toContainText('Se creará un borrador sin publicar ni activar gasto');
      const follow=chat.locator('[data-assistant-result-control="assistant.thread-follow-up"]');
      await reach('thread-follow-up','memoria del hilo',follow);
      await follow.click();
      await expect(chat.getByRole('group',{name:'Objetivo y siguientes pasos',exact:true})).toContainText('Ali recuerda el objetivo y las respuestas de esta conversación');
      const cancel=proposal.getByRole('button',{name:'Cancelar propuesta',exact:true});
      await reach('proposal-cancel','cancelar valores sugeridos',cancel);
      expect(calls).toHaveLength(before);
      expect(await duplicates()).toEqual([]);
      await cancel.click();
      await expect(proposal).toContainText('Cancelada');
      expect(calls.slice(before)).toEqual([expect.objectContaining({decision:'cancel'})]);
      expect(await duplicates()).toEqual([]);

      await askAli(chat,`Duplica la campaña «${name}»`);
      const action=proposal.getByRole('button',{name:'Confirmar duplicación',exact:true});
      await expect(action).toBeEnabled({timeout:30000});
      await reach('proposal-confirm','confirmar cambio de ali',action);
      await expect(action).toBeEnabled();
      expect(calls).toHaveLength(before+1);
      for(const accepted of [false,true]){
        const decision=page.waitForEvent('dialog'),clicked=action.click();
        const prompt=await decision;
        expect(prompt.message()).toContain('Crear el borrador');
        await (accepted?prompt.accept():prompt.dismiss());
        await clicked;
        if(!accepted)expect(calls).toHaveLength(before+1);
      }
      const receipt=chat.getByRole('region',{name:'Borrador creado',exact:true});
      await expect(receipt).toBeVisible();
      await reach('receipt','recibo de ali',receipt);
      const link=receipt.getByRole('link',{name:'Abrir registro guardado',exact:true});
      const newId=new URL(await link.getAttribute('href'),page.url()).searchParams.get('record');
      expect(await duplicates()).toEqual([{id:newId}]);
      expect(calls.slice(before)).toEqual([expect.objectContaining({decision:'cancel'}),expect.objectContaining({decision:'execute'})]);
      await link.click();
      await expect(page).toHaveURL(url=>url.searchParams.get('record')===newId);
      expect(await getSocialCampaign(store,newId)).toMatchObject({id:newId,state:'draft',parentCampaignId:source.id,deliveries:[]});
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: empieza, cancela y elimina solo el acompañamiento elegido',async({page,context,request},info)=>{
  test.setTimeout(150000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const path='/api/admin/assistant/tasks',writes=[];
  page.on('request',req=>{
    const target=new URL(req.url()).pathname;
    if(target.startsWith(path)&&req.method()!=='GET')writes.push([req.method(),target,req.postDataJSON()]);
  });
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    const revision=async()=>Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);
    const before=await revision();
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto('/admin');
      async function navigate(id,query){
        let entry=await openAli(page);
        if(via==='chat')await askAli(entry,`¿Dónde está ${query}?`);
        else{
          await entry.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="advisor.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(entry).toHaveCount(0);
      }
      async function start(){
        const count=writes.length,action='Empezar envío de un pedido';
        if(via==='panel')await page.getByRole('button',{name:action,exact:true}).click();
        else{
          await navigate('task-start','iniciar tarea personal');
          const chooser=page.getByRole('dialog',{name:'Elegir acompañamiento de Ali',exact:true});
          await expect(chooser.getByRole('heading')).toBeFocused();
          expect(writes).toHaveLength(count);
          await chooser.getByRole('button',{name:action,exact:true}).click();
        }
        const intro=page.getByRole('dialog',{name:action,exact:true});
        await expect(intro).toContainText('Empezar no modifica pedidos ni registra guías');
        expect(writes).toHaveLength(count);
        const response=page.waitForResponse(res=>new URL(res.url()).pathname===path&&res.request().method()==='POST');
        await intro.getByRole('button',{name:'Empezar',exact:true}).click();
        const saved=await response;
        expect(saved.ok(),await saved.text()).toBe(true);
        const task=await saved.json(),detail=page.getByRole('dialog',{name:'Envío de un pedido',exact:true});
        await expect(detail.getByLabel('¿Cuál es el número AN del pedido?')).toBeVisible();
        expect(writes.slice(count)).toEqual([['POST',path,expect.objectContaining({id:task.id,capabilityId:'orders.ship-order'})]]);
        expect(await store.db.get(`SELECT user_id FROM ${store.t('assistant_advisor_tasks')} WHERE id=?`,[task.id])).toEqual({user_id:actor});
        return {task,detail};
      }
      for(const type of ['cancel','delete']){
        const {task,detail}=await start();
        const count=writes.length,decision=type==='cancel'?'Cancelar tarea':'Eliminar tarea',endpoint=`${path}/${task.id}`;
        if(via!=='panel'){
          await detail.getByRole('button',{name:'Usar en la conversación',exact:true}).click();
          await detail.getByRole('button',{name:'Ahora no',exact:true}).click();
          await navigate(`task-${type}`,type==='cancel'?'cancelar acompañamiento':'eliminar mi tarea');
          await expect(detail.getByRole('button',{name:decision,exact:true})).toBeFocused();
        }
        const read=async()=>page.request.get(endpoint);
        const original=await (await read()).json();
        expect(original.id).toBe(task.id);
        const decisionDialog=page.getByRole('dialog',{name:decision,exact:true});
        await detail.getByRole('button',{name:decision,exact:true}).click();
        await expect(decisionDialog).toContainText(/no (?:revierte cambios|se eliminará ningún registro) de negocio/i);
        await decisionDialog.getByRole('button',{name:'Volver a la tarea',exact:true}).click();
        expect(writes).toHaveLength(count);
        expect(await (await read()).json()).toEqual(original);
        await detail.getByRole('button',{name:decision,exact:true}).click();
        const method=type==='delete'?'DELETE':'PATCH',finished=page.waitForResponse(res=>new URL(res.url()).pathname===endpoint&&res.request().method()===method);
        await decisionDialog.getByRole('button',{name:decision,exact:true}).click();
        expect((await finished).ok()).toBe(true);
        expect(writes.slice(count)).toEqual([[method,endpoint,expect.objectContaining({version:original.version,...(type==='cancel'?{action:'cancel'}:null)})]]);
        if(type==='delete'){
          expect((await read()).status()).toBe(404);
          await expect(page.getByRole('dialog',{name:'Mis tareas',exact:true})).toContainText('Tarea eliminada');
        }else{
          expect((await (await read()).json()).status).toBe('cancelled');
          await expect(detail).toContainText('Tarea cancelada');
        }
        await page.getByRole('dialog').getByRole('button',{name:'Ahora no',exact:true}).click();
      }
    });
    expect(await revision()).toBe(before);
  }finally{await store.close();}
});

test('Ali @advisor-c6: crea una ficha privada desde una referencia exacta del Excel',async({page,context,request},info)=>{
  test.setTimeout(150000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear();
    const writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:imports|products|orders|business|finance)(?:\/|$)/.test(path))writes.push([req.method(),path]);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8),title=`Ficha privada ${tag}`;
      const platform=await saveResource(store,'platforms',{requestId:randomUUID(),name:`Alta de Excel ${tag}`},actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const batch=await prepareResolutionWorkbook(store,actor,source,year),before=writes.length;
      const path=`/admin?section=orders&tab=imports&batch=${batch.id}`;
      const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
      await page.goto(path);
      await wizard.getByRole('button',{name:'Vincular o crear SKU-A',exact:true}).click();
      const resolve=page.getByRole('dialog',{name:'Vincular producto',exact:true});
      const options=resolve.getByRole('group',{name:'Elegir tipo de ficha nueva',exact:true});
      await openExcelDecisionViaAli(page,via,'create-linked-product','crear producto faltante',options,resolve);
      await expect(resolve).toContainText('Referencia SKU-A');
      expect(writes).toHaveLength(before);
      await options.getByRole('button',{name:'Guardar lote y crear producto',exact:true}).click();
      const editor=page.getByRole('dialog').filter({has:page.getByLabel('Precio en pesos colombianos')});
      await expect(editor).toBeVisible();
      const prior=await getImportBatch(store,batch.id);
      expect(prior.resolutions).toEqual([]);
      await editor.getByLabel(/Nombre/).first().fill(title);
      await editor.getByLabel('Presentación / contenido',{exact:true}).fill('Frasco de prueba');
      await editor.getByLabel('Precio en pesos colombianos').fill('25000');
      const save=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/admin/products'&&res.request().method()==='POST');
      await editor.getByRole('button',{name:'Crear producto',exact:true}).click();
      const response=await save;
      expect(response.ok(),await response.text()).toBe(true);
      const created=await response.json();
      expect(created).toMatchObject({title,status:'draft',price:25000,orderable:true});
      await expect(editor).toHaveCount(0);
      await expect(wizard).toContainText(`SKU-A → ${title}`);
      const stored=await getImportBatch(store,batch.id);
      expect(stored).toMatchObject({state:'review',preview:null,resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:created.id}]});
      expect(stored.acceptedRevision).toBeNull();
      const performed=writes.slice(before);
      expect(performed.filter(([method])=>method==='POST')).toEqual([['POST','/api/admin/products']]);
      expect(performed.filter(([method,target])=>method==='PUT'&&target===`/api/admin/imports/${batch.id}`).length).toBeGreaterThan(0);
      expect(performed.every(([method,target])=>method==='POST'&&target==='/api/admin/products'||method==='PUT'&&target===`/api/admin/imports/${batch.id}`)).toBe(true);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: reabre la ficha propuesta y distingue revisión, prellenado y guardado',async({page,context,request},info)=>{
  test.setTimeout(150000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8),description=`Texto propuesto ${tag}`,baseline=`Texto guardado ${tag}`;
      const product=await store.save('products',{...emptyRecord('products'),title:`Ficha revisada ${tag}`,slug:`ficha-revisada-${tag}`,status:'draft',description:baseline,presentation:'Unidad',price:23000,orderable:true},null,null,actor);
      const current=()=>store.get('products',product.id);
      await page.goto(`/admin?section=products&record=${product.id}`);
      const editor=page.getByRole('dialog',{name:'Editar producto',exact:true}),chat=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      const field=editor.locator('[name="description"]'),proposal=chat.getByRole('region',{name:'Propuesta de cambio',exact:true});
      const help=async()=>{
        await editor.getByRole('button',{name:/^Ayúdame/}).click();
        await expect(chat).toBeVisible();
      };
      const reach=async(id,query,target)=>{
        if(via==='panel')return;
        let entry=chat;
        if(via==='chat')await askAli(chat,`¿Dónde está ${query}?`);
        else{
          await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      };
      await help();
      await askAli(chat,`Prepara el cambio para revisar, sin guardar: ${JSON.stringify({target:'record:products',entityId:product.id,patch:{description},intent:'prefill'})}`);
      await expect(proposal).toContainText(description);
      const reopen=proposal.getByRole('button',{name:'Revisar formulario',exact:true});
      await reach('proposal-form','ir al editor propuesto',reopen);
      await reopen.click();
      await expect(chat).toHaveCount(0);
      await expect(field).toHaveValue(baseline);
      const local=`Edición aún no guardada ${tag}`;
      await field.fill(local);
      await help();
      const rebase=proposal.getByRole('button',{name:'Actualizar revisión',exact:true});
      await reach('proposal-rebase','actualizar revisión de propuesta',rebase);
      const variation=page.waitForResponse(res=>res.request().method()==='POST'&&res.request().postDataJSON()?.formSnapshot&&new URL(res.url()).pathname.startsWith('/api/admin/assistant/proposals/'));
      await rebase.click();
      const reviewed=await variation;
      expect(reviewed.ok(),await reviewed.text()).toBe(true);
      await expect(proposal).toContainText(local);
      expect((await current()).description).toBe(baseline);
      const apply=proposal.getByRole('button',{name:'Aplicar valores',exact:true});
      await reach('proposal-apply','aplicar valores',apply);
      const permission=page.waitForEvent('dialog'),clicked=apply.click();
      const prompt=await permission;
      expect(prompt.message()).toContain('combinar estos valores con tu borrador');
      await prompt.accept();
      await clicked;
      await expect(chat).toHaveCount(0);
      await expect(field).toHaveValue(description);
      expect((await current()).description).toBe(baseline);
      const saveControl=editor.getByRole('button',{name:'Guardar cambios',exact:true});
      await expect(saveControl).toHaveAttribute('data-assistant-bound-save','');
      if(via!=='panel'){
        await help();
        await reach('proposal-confirm-form','confirmar propuesta en el editor',saveControl);
        await expect(chat).toHaveCount(0);
        await expect(saveControl).toHaveAttribute('data-advisor-arrival','');
        await expect(field).toHaveValue(description);
        expect((await current()).description).toBe(baseline);
      }
      const execution=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname.startsWith('/api/admin/assistant/proposals/')&&res.request().postDataJSON()?.decision==='execute');
      const review=page.waitForEvent('dialog'),saving=saveControl.click();
      const final=await review;
      expect(final.message()).toContain('Revisa los cambios del formulario antes de guardar');
      await final.accept();
      await saving;
      const result=await execution;
      expect(result.ok(),await result.text()).toBe(true);
      expect(await result.json()).toMatchObject({receipt:{target:'record:products',id:expect.any(String),proposalId:expect.any(String)}});
      await expect(editor).toHaveCount(0);
      expect(await current()).toMatchObject({id:product.id,version:product.version+1,description,status:'draft',price:23000});
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: conserva hecho, costo y conteo del Excel hasta la decisión nativa',async({page,context,request},info)=>{
  test.setTimeout(180000);
  page.setDefaultTimeout(10000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear(),openingOn=`${year}-09-30`;
    const cmd=data=>({requestId:randomUUID(),...data});
    const wizard=page.getByRole('region',{name:'Importar Excel',exact:true});
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8),title=`Producto conteo ${tag}`;
      const platform=await saveResource(store,'platforms',cmd({name:`Conteo Excel ${tag}`}),actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const product=await store.save('products',{...emptyRecord('products'),title,slug:`conteo-excel-${tag}`,status:'draft',presentation:'Unidad',orderable:true,price:55000,unitCostMinor:2000000,costEffectiveOn:`${year}-09-01`,stockQuantity:10},null,null,actor);
      const batch=await prepareResolutionWorkbook(store,actor,source,year,{resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:product.id}],inventoryOpening:{on:openingOn,confirmed:true}});
      const href=`/admin?section=orders&tab=imports&batch=${batch.id}`;
      const record=()=>store.get('products',product.id);
      const order=wizard.locator('[data-import-operation]').filter({has:page.getByRole('heading',{name:'Pedido ORDER-A',exact:true})});
      await page.goto(href);
      await expect(wizard.getByText('Revisión actualizada',{exact:true})).toBeVisible();
      await order.getByRole('button',{name:'Clasificar hecho frente al conteo',exact:true}).first().click();
      const observation=page.getByRole('dialog',{name:'Clasificar hecho frente al conteo',exact:true});
      const reason=observation.getByLabel('Motivo de la resolución',{exact:true}),original=batch.preview.previewHash;
      const related=observation.getByRole('combobox',{name:'Relación con el conteo físico',exact:true});
      const note=`Consta en el conteo del ${openingOn} · ${tag}`;
      await reason.fill(note);
      await openExcelDecisionViaAli(page,via,'classify-opening-observation','incluido en saldo físico',reason,observation);
      await expect(related).toHaveValue('');
      await expect(observation).toContainText('Hecho concreto:');
      await expect(reason).toHaveValue(note);
      await related.selectOption('true');
      await observation.getByRole('button',{name:'Preparar corrección',exact:true}).click();
      await expect(observation).toHaveCount(0);
      expect((await getImportBatch(store,batch.id)).preview.previewHash).toBe(original);
      expect(await record()).toEqual(product);

      await page.goto(href);
      await order.locator('[data-import-other-options] > summary').click();
      await order.getByRole('button',{name:'Completar costos históricos',exact:true}).click();
      const costs=page.getByRole('dialog',{name:'Completar costos históricos',exact:true});
      const costReason=costs.getByLabel('Motivo de la resolución',{exact:true});
      await costReason.fill(`Soporte histórico del costo ${tag}`);
      await openExcelDecisionViaAli(page,via,'complete-historical-costs','costo de componentes del excel',costReason,costs);
      const amount=costs.getByLabel(/Costo unitario histórico/).first();
      await expect(costs).toContainText(title);
      await amount.fill('21000');
      await costs.getByRole('button',{name:'Preparar corrección',exact:true}).click();
      await expect(costs).toHaveCount(0);
      expect((await getImportBatch(store,batch.id)).preview.previewHash).toBe(original);
      expect((await record()).unitCostMinor).toBe(2000000);
      const group=batch.preview.groups.find(item=>item.errors?.some(issue=>issue.code==='IMPORT_OPENING_CLASSIFICATION'));
      const rule=(await getBusinessSettings(store)).rulesVersions.at(-1);
      const decisions=group.errors.filter(issue=>issue.code==='IMPORT_OPENING_CLASSIFICATION').map(issue=>({action:'opening_observation',...issue.rowRefs[0],externalKey:issue.externalKey,value:true,reason:note}));
      const ready=await updateImportBatch(store,batch.id,cmd({version:batch.version,resolutions:[...decisions,{action:'review_policy',entityKey:group.key,value:{ruleVersionId:rule.id},reason:'Política histórica de la fixture'}]}),actor);
      await requestImportPreview(store,batch.id,cmd({version:ready.version}),actor);
      await expect.poll(async()=>{
        await processImportTurn(store,{batchId:batch.id});
        return (await getImportBatch(store,batch.id)).preview?.inventory?.map(item=>item.productId);
      },{timeout:25000}).toContain(product.id);


      await page.goto(href);
      const stock=wizard.getByRole('region',{name:'Efectos de la importación',exact:true});
      await stock.getByText('Ver detalles de inventario por producto',{exact:true}).click();
      await stock.getByRole('button',{name:`Revisar conteo de ${title}`,exact:true}).click();
      const editor=page.getByRole('dialog',{name:'Editar producto',exact:true}),quantity=editor.locator('[name="stockQuantity"]');
      await expect(quantity).toHaveValue('10');
      await quantity.fill('13');
      if(via!=='panel'){
        await editor.getByRole('button',{name:/^Ayúdame/}).click();
        await openExcelDecisionViaAli(page,via,'edit-product-count','existencias de referencia con incidencia',quantity);
      }
      await expect(quantity).toHaveValue('13');
      expect(await record()).toEqual(product);
      const review=page.waitForResponse(res=>res.request().method()==='POST'&&new URL(res.url()).pathname===`/api/admin/imports/${batch.id}/preview`);
      await editor.getByRole('button',{name:'Guardar cambios',exact:true}).click();
      expect((await review).ok()).toBe(true);
      await page.waitForURL(url=>url.searchParams.get('batch')===batch.id);
      expect(await record()).toMatchObject({id:product.id,stockQuantity:13,unitCostMinor:2000000,version:product.version+1});
      const saved=await getImportBatch(store,batch.id);
      expect(saved.acceptedRevision).toBeNull();
      expect(saved.resolutions).toEqual(ready.resolutions);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: conserva el original, una fecha y el paquete Heka elegidos',async({page,context,request},info)=>{
  test.setTimeout(180000);
  if(controlURL&&baseURL)await loginWithAdvisorFixture(page,request);
  else await login(page);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(process.env.ALI_SQLITE_PATH?{DB_DRIVER:'sqlite',SQLITE_PATH:process.env.ALI_SQLITE_PATH}:testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store),year=completedFixtureYear();
    const cmd=data=>({requestId:randomUUID(),...data}),hash=value=>createHash('sha256').update(value).digest('hex');
    const wizard=page.getByRole('region',{name:'Importar Excel',exact:true}),writes=[];
    page.on('request',req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'&&/^\/api\/admin\/(?:imports|business|finance)(?:\/|$)/.test(path))writes.push([req.method(),path]);
    });
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8);
      const platform=await saveResource(store,'platforms',cmd({name:`Soportes conservados ${tag}`}),actor);
      const [source]=await listResources(store,'sources',{platform:platform.id});
      const open=async id=>page.goto(`/admin?section=orders&tab=imports&batch=${id}`);
      const review=async id=>expect.poll(async()=>{
        await processImportTurn(store,{batchId:id});
        return (await getImportBatch(store,id)).state;
      },{timeout:25000}).toBe('review');
      const savedBeforeClick=async(id,count)=>{
        expect(writes).toHaveLength(count);
        const saved=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===`/api/admin/imports/${id}`);
        await wizard.getByRole('button',{name:'Guardar borrador',exact:true}).click();
        const response=await saved;
        expect(response.ok(),await response.text()).toBe(true);
        expect(writes.slice(count)).toEqual([['PUT',`/api/admin/imports/${id}`]]);
        return getImportBatch(store,id);
      };

      const dateBatch=await prepareResolutionWorkbook(store,actor,source,year,{filename:`Gastos ${year-1}.xlsx`,sheetNames:['OPERACION']});
      await open(dateBatch.id);
      const keep=wizard.getByRole('button',{name:'Conservar fecha del archivo',exact:true}),count=writes.length;
      await expect(keep).toBeVisible();
      await openExcelDecisionViaAli(page,via,'keep-original-dates','conservar año del archivo',keep);
      await expect(keep.locator('..')).toContainText(`${year}-09-29 · OPERACION · fila 2`);
      expect(writes).toHaveLength(count);
      await keep.click();
      expect((await getImportBatch(store,dateBatch.id)).resolutions).toEqual([]);
      const dateSaved=await savedBeforeClick(dateBatch.id,count);
      expect(dateSaved.fileHash).toBe(dateBatch.fileHash);
      expect(dateSaved.resolutions).toEqual([expect.objectContaining({action:'cell_value',sheet:'OPERACION',rowNumber:2,columnIndex:1,value:`${year}-09-29`})]);
      expect(dateSaved.acceptedRevision).toBeNull();

      const raw=hekaSnapshot(),first=raw.packages[0];
      const header={...first.header,fecha:{seconds:0,nanoseconds:999999999},guiasPagadas:['0000123'],total_pagado:'18.00',comision_heka:'0.50'};
      raw.packages.push({idPaquetePago:'fixture-package-02',header,headerAfter:structuredClone(header),lines:[{
        ...first.lines[0],documentId:'fixture-second-line',idPaquetePago:'fixture-package-02',RECAUDO:'20.00','ENVÍO TOTAL':'2.00','COMISION HEKA':'0.50','TOTAL A PAGAR':'18.00',
      }]});
      const capture=normalizeHekaSnapshot(raw),workbook=createHekaWorkbook(capture);
      let pack=await createImportBatch(store,cmd({sourceId:source.id}),actor);
      pack=await uploadImportFile(store,pack.id,cmd({filename:'Paquetes Heka sintéticos.xlsx',version:pack.version,bytes:workbook.bytes}),actor);
      const shippingOrigin={format:'heka-import-v1',snapshotId:`captura-${tag}`,sourceHash:hash(JSON.stringify(capture)),adapterVersion:capture.adapterVersion,schemaVersion:1,sourceId:source.id,capturedAt:capture.capturedAt,query:capture.query,accountFingerprint:hash(JSON.stringify(capture.account)),fileHash:pack.fileHash,...workbook.manifest};
      await store.transaction(async tx=>{
        await tx.lockWrites();
        const row=await tx.db.get(`SELECT data FROM ${tx.t('import_batches')} WHERE id=?`,[pack.id]);
        await tx.db.run(`UPDATE ${tx.t('import_batches')} SET data=? WHERE id=?`,[JSON.stringify({...JSON.parse(row.data),shippingOrigin}),pack.id]);
      });
      await review(pack.id);
      pack=await getImportBatch(store,pack.id);
      pack=await updateImportBatch(store,pack.id,cmd({version:pack.version,config:workbook.config}),actor);
      if(pack.state==='uploaded'){await review(pack.id);pack=await getImportBatch(store,pack.id);}
      await requestImportPreview(store,pack.id,cmd({version:pack.version}),actor);
      await review(pack.id);
      await open(pack.id);
      const packageList=wizard.getByRole('region',{name:'Paquetes Heka originales',exact:true});
      const option=packageList.getByRole('checkbox',{name:'Incluir paquete completo fixture-package-02',exact:true});
      const other=packageList.getByRole('checkbox',{name:/Incluir paquete completo fixture-package-01/});
      await packageList.getByText('IDs e importes originales por fila · fixture-package-02',{exact:true}).click();
      const before=writes.length;
      await openExcelDecisionViaAli(page,via,'omit-heka-package','omitir liquidación clásica',option);
      await expect(option).toBeChecked();
      await expect(other).toBeChecked();
      await option.uncheck();
      await expect(other).toBeChecked();
      expect((await getImportBatch(store,pack.id)).resolutions).toEqual([]);
      const packSaved=await savedBeforeClick(pack.id,before);
      expect(packSaved.resolutions).toEqual([{action:'omit_settlement_package',externalKey:'fixture-package-02',value:true}]);
      expect(packSaved.shippingOrigin).toEqual(shippingOrigin);
      expect(packSaved.acceptedRevision).toBeNull();

      let retained=await createImportBatch(store,cmd({sourceId:source.id}),actor);
      const bytes=writeExcelSheets([{name:'OPERACION',rows:[['ID','Concepto'],['PRUEBA',tag]]}]);
      retained=await uploadImportFile(store,retained.id,cmd({filename:'Original recuperable.xlsx',version:retained.version,bytes}),actor);
      await store.transaction(async tx=>{
        await tx.lockWrites();
        const row=await tx.db.get(`SELECT data FROM ${tx.t('import_batches')} WHERE id=?`,[retained.id]);
        const error={code:'IMPORT_INTERNAL',category:'system',phase:'inspect',message:'Se interrumpió la lectura del archivo retenido.'};
        await tx.db.run(`UPDATE ${tx.t('import_batches')} SET state='failed',data=? WHERE id=?`,[JSON.stringify({...JSON.parse(row.data),workbook:null,error}),retained.id]);
        await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL WHERE key=?`,[`import:${retained.id}`]);
      });
      await open(retained.id);
      const reread=wizard.getByRole('button',{name:'Volver a leer el archivo',exact:true}),beforeRetry=writes.length;
      await expect(reread).toBeVisible();
      if(via==='chat'){
        const history=Promise.withResolvers();
        await page.route('**/api/admin/assistant/threads?page=1',async route=>{await history.promise;await route.continue();},{times:1});
        try{
          const pending=page.waitForRequest(req=>new URL(req.url()).pathname==='/api/admin/assistant/threads');
          const chat=await openAli(page);
          await pending;
          await expect(chat.getByRole('region',{name:'Conversaciones anteriores'}).getByRole('status')).toBeVisible();
          await expect(chat.getByRole('textbox',{name:'Mensaje para Ali'})).toBeEnabled();
        }finally{history.resolve();}
      }
      await openExcelDecisionViaAli(page,via,'reread-file','releer archivo tras error',reread);
      expect(writes).toHaveLength(beforeRetry);
      const inspect=page.waitForResponse(res=>res.request().method()==='PUT'&&new URL(res.url()).pathname===`/api/admin/imports/${retained.id}`);
      await reread.click();
      expect((await inspect).ok()).toBe(true);
      await review(retained.id);
      const inspected=await getImportBatch(store,retained.id);
      expect(inspected).toMatchObject({id:retained.id,filename:'Original recuperable.xlsx',fileHash:hash(bytes),state:'review',error:null,acceptedRevision:null});
      expect(inspected.workbook).toBeTruthy();
      expect(writes.slice(beforeRetry)).toEqual([['PUT',`/api/admin/imports/${retained.id}`]]);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: guarda solo el texto literal pedido en una ficha limpia',async({page,context,request},info)=>{
  test.setTimeout(100000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8),title=`Ficha literal ${tag}`,description=`Texto literal sin inferencias · ${tag}`;
      const product=await store.save('products',{...emptyRecord('products'),title,slug:`literal-${tag}`,status:'draft',description:'Texto original del borrador',price:25000,presentation:'Unidad',orderable:true},null,null,actor);
      const after=()=>store.get('products',product.id);
      await page.goto(`/admin?section=products&record=${product.id}`);
      const editor=page.getByRole('dialog',{name:'Editar producto',exact:true});
      await editor.getByRole('button',{name:/^Ayúdame/}).click();
      const chat=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      const message=chat.getByRole('textbox',{name:'Mensaje para Ali',exact:true});
      const pending=`Cambia la descripción a «${description}»`;
      if(via==='chat')await askAli(chat,'¿Dónde está cambiar texto exacto?');
      await message.fill(pending);
      if(via!=='panel'){
        let entry=chat;
        if(via==='directorio'){
          await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill('cambio literal en borrador');
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator('[data-capability-id="assistant.literal-draft"]').last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(message).toBeFocused();
      }
      await expect(message).toHaveValue(pending);
      expect(await after()).toEqual(product);
      await chat.getByRole('button',{name:'Enviar',exact:true}).click();
      const receipt=chat.getByRole('region',{name:'Comprobante de cambio guardado',exact:true});
      await expect(receipt.getByRole('link',{name:'Abrir registro guardado',exact:true})).toBeVisible();
      expect(await after()).toMatchObject({id:product.id,title,status:'draft',description,price:25000,version:product.version+1});
      await chat.getByRole('button',{name:'Cerrar asistente',exact:true}).click();
      await expect(editor.locator('[name="description"]')).toHaveValue(description);
    });
  }finally{await store.close();}
});

test('Ali @advisor-c6: responde una pregunta exacta y vuelve al borrador sin guardarlo',async({page,context,request},info)=>{
  test.setTimeout(130000);
  await loginWithAdvisorFixture(page,request);
  if(info.project.name==='mobile')await page.setViewportSize({width:320,height:740});
  const store=await openStore(testDatabaseEnv());
  try{
    const actor=await fixtureActor(context,store);
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      const tag=randomUUID().slice(0,8),draft=`Borrador local · ${tag}`;
      const saved=await store.save('products',{...emptyRecord('products'),title:`Pregunta contextual ${tag}`,slug:`pregunta-contextual-${tag}`,status:'draft',description:'Original conservado',price:22000,presentation:'Unidad',orderable:true},null,null,actor);
      await page.goto(`/admin?section=products&record=${saved.id}`);
      const editor=page.getByRole('dialog',{name:'Editar producto',exact:true}),field=editor.locator('[name="description"]');
      await field.fill(draft);
      await editor.getByRole('button',{name:/^Ayúdame/}).click();
      const chat=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
      const question=chat.locator('[data-assistant-question]');
      const answerControl=question.locator('[data-assistant-result-control="assistant.answer-question"]');
      const contextual=chat.getByRole('button',{name:'Volver al formulario',exact:true});
      const focus=async(id,query,target)=>{
        if(via==='panel')return;
        let entry=chat;
        if(via==='directorio'){
          await chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true}).click();
          entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
          await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
          await entry.getByRole('button',{name:'Buscar',exact:true}).click();
        }
        await entry.locator(`[data-capability-id="assistant.${id}"]`).last().getByRole('button',{name:/^Abrir en el panel:/}).click();
        await expect(target).toBeFocused();
      };
      const answerQuery='elegir respuesta a una pregunta',contextQuery='ir a la sección de la solicitud';
      if(via==='chat'){
        for(const [id,query] of [['answer-question',answerQuery],['context-destination',contextQuery]]){
          await askAli(chat,`¿Dónde está ${query}?`);
          await expect(chat.locator(`[data-capability-id="assistant.${id}"]`).last()).toBeVisible();
        }
      }
      await askAli(chat,'Completa la descripción');
      const answer=question.getByPlaceholder('Escribe tu respuesta',{exact:true});
      await expect(answer).toBeVisible();
      const id=await question.getAttribute('data-assistant-question'),text=`Dato dado por la persona ${tag}`;
      await answer.fill(text);
      await focus('answer-question',answerQuery,answerControl);
      await expect(question).toHaveAttribute('data-assistant-question',id);
      await expect(answer).toHaveValue(text);
      const sent=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/admin/assistant/turns'&&res.request().method()==='POST'&&res.request().postDataJSON()?.answer?.questionId===id);
      await question.getByRole('button',{name:'Responder',exact:true}).click();
      const response=await sent;
      expect(response.ok(),await response.text()).toBe(true);
      expect(response.request().postDataJSON().answer).toEqual({questionId:id,optionId:null,text});
      await expect(chat.getByRole('button',{name:'Enviar',exact:true})).toBeDisabled();
      await expect(chat.getByRole('button',{name:'¿Qué quieres hacer?',exact:true})).toBeEnabled();
      expect(await store.get('products',saved.id)).toEqual(saved);
      await expect(contextual).toBeEnabled({timeout:30000});
      await focus('context-destination',contextQuery,contextual);
      await contextual.click();
      await expect(chat).toHaveCount(0);
      await expect(field).toHaveValue(draft);
      expect(await store.get('products',saved.id)).toEqual(saved);
      page.once('dialog',prompt=>prompt.accept());
      await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
      await expect(editor).toHaveCount(0);
    });
  }finally{await store.close();}
});
