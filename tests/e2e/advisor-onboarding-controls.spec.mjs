import { test, expect as playwrightExpect } from '@playwright/test';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOnboarding } from '../../lib/business/onboarding.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { login, openDisclosure } from './helpers.mjs';

const expect = playwrightExpect.configure({ timeout: 15000 });
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('../heka-browser.mjs', import.meta.url));
const endpoint = '/api/admin/business/onboarding';
const accountName = 'Caja sintética C6';
const responsibleName = 'Responsable sintético C6';
const openingOn = '2024-08-19';
const openingBalanceMinor = 467525;
const title = 'Primera ficha sintética C6';
const price = 32741;
const actions = [
  ['setup-new-cash', 'apertura inicial', 'onboarding-cash-new-opening'],
  ['setup-product', 'primera ficha de producto', 'onboarding-product-submit'],
  ['setup-orders', 'aceptar reglas vigentes', 'onboarding-orders-policy-acceptance'],
];
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

const isolated = test.extend({
  cleanBusiness: async ({ browser }, use, info) => {
    const directory = path.join(root, '.test-data');
    await mkdir(directory, { recursive: true });
    const scratch = await mkdtemp(path.join(directory, 'heka-browser-'));
    const log = path.join(scratch, 'provider.jsonl');
    let child, context, store;
    try {
      await writeFile(log, '', { mode: 0o600 });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(scratch, 'https.key'), '-out', path.join(scratch, 'https.crt')], { stdio: 'ignore' });
      child = fork(fixture, ['--serve', scratch, '--empty-business'], {
        cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' },
      });
      const url = await Promise.race([
        once(child, 'message').then(([value]) => value),
        once(child, 'exit').then(([code]) => { throw new Error(`La fixture de inicio terminó antes de abrir HTTPS (${code}).`); }),
      ]);
      const { defaultBrowserType: _browser, ...device } = info.project.use;
      context = await browser.newContext({ ...device, baseURL: url, ignoreHTTPSErrors: true, serviceWorkers: 'block', ...(info.project.name === 'mobile' && { viewport: { width: 320, height: 740 } }) });
      const external = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      await login(page);
      store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: path.join(scratch, 'browser.sqlite') });
      const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
      await use({ page, store, actor, external, log });
    } finally {
      await context?.close();
      await store?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await rm(scratch, { recursive: true, force: true });
    }
  },
});

for (const via of ['panel', 'chat', 'directorio']) isolated(`Ali @advisor-c6: apertura, primera ficha y reglas vigentes desde ${via}`, async ({ cleanBusiness }) => {
  const { page, store, actor, external, log } = cleanBusiness;
  const guide = page.locator('[data-onboarding]');
  const step = index => guide.locator(`[data-onboarding-step="${index}"]`);
  const field = name => guide.locator(`[name="${name}"]`);
  const current = () => getOnboarding(store, actor.id);
  const commands = () => store.db.all(`SELECT scope,request_id,actor_id,result_json FROM ${store.t('business_requests')} WHERE scope LIKE 'onboarding:%' ORDER BY scope`);
  const cashEntries = () => store.db.all(`SELECT account_id,effective_on,amount_minor,kind,source_type FROM ${store.t('cash_entries')}`);
  const writes = [], assistantPayloads = [];
  page.on('request', req => {
    const pathname = new URL(req.url()).pathname;
    if (['GET', 'HEAD'].includes(req.method()) || !pathname.startsWith('/api/admin/')) return;
    if (/^\/api\/admin\/assistant\/turns(?:\/[^/]+\/advance)?$/.test(pathname)) assistantPayloads.push(req.postData() || '');
    else writes.push([req.method(), pathname]);
  });

  async function assertStage(index) {
    await expect(step(index)).toHaveAttribute('aria-current', 'step');
    await expect(guide.locator(`[data-onboarding-stage="${index}"]`)).toBeVisible();
  }
  async function reach(index) {
    const before = await current(), requests = await commands(), count = writes.length;
    const [id, query, marker] = actions[index];
    const target = guide.locator(`[data-advisor-control="${marker}"]`);
    if (via === 'panel') {
      if (index === 0) {
        // The dashboard renders this heading only after the client loads its data.
        await expect(page.getByRole('heading', { name: 'Requiere atención', exact: true })).toBeVisible();
        await page.locator('[data-onboarding-entry]').click();
      } else await step(index).click();
    } else {
      await button(page.getByRole('banner'), 'Ali').click();
      let source = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
      if (via === 'chat') {
        const pending = button(source, 'Empezar otra consulta');
        if (await pending.isVisible()) {
          await pending.click();
          await expect(pending).toBeHidden();
        }
        const message = source.getByLabel('Mensaje para Ali', { exact: true });
        await message.fill(`¿Dónde encuentro ${query}?`);
        await expect(message).toHaveValue(`¿Dónde encuentro ${query}?`);
        await button(source, 'Enviar').click({ timeout: 30000 });
      } else {
        await button(source, '¿Qué quieres hacer?').click();
        source = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
        await source.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
        await button(source, 'Buscar').click();
      }
      await source.locator(`[data-capability-id="business.${id}"]`).getByRole('button', { name: /^Abrir en el panel:/ }).click();
      await expect(target).toBeFocused();
      await expect(source).toBeHidden();
    }
    await assertStage(index);
    await expect(target).toBeVisible();
    expect(await target.evaluate(node => {
      const { left, right } = node.getBoundingClientRect();
      return left >= -1 && right <= innerWidth + 1;
    })).toBe(true);
    expect(await current()).toEqual(before);
    expect(await commands()).toEqual(requests);
    expect(writes).toHaveLength(count);
  }
  async function commit(action, control, fields) {
    const count = writes.length;
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === endpoint),
      control.click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    const payload = response.request().postDataJSON();
    expect(payload).toEqual({ action, requestId: expect.any(String), ...fields });
    expect(writes.slice(count)).toEqual([['POST', endpoint]]);
    const command = (await commands()).find(row => row.request_id === payload.requestId);
    expect(command).toMatchObject({ scope: `onboarding:${action}`, actor_id: actor.id });
    return JSON.parse(command.result_json);
  }

  const empty = await current();
  expect(empty).toMatchObject({ accounts: [], people: [], products: [], existingOrders: { count: 0, latestNumber: null }, trialOrder: null, readiness: { cash: false, product: false, orders: false, completed: false } });
  expect(await commands()).toEqual([]);
  expect(await cashEntries()).toEqual([]);
  const rule = empty.settings.rulesVersions.at(-1);
  expect(rule).toMatchObject({ saleRecognition: 'delivered', commission: { enabled: false }, shippingExpenseDate: 'dispatch_date', returnExpenseDate: 'charge_date', platformFeeExpenseDate: 'charge_date' });

  await reach(0);
  await expect(field('openingBalanceMinor')).toHaveValue('0');
  await expect(field('openingConfirmed')).not.toBeChecked();
  for (const index of [1, 2, 3]) await expect(step(index)).toBeDisabled();
  await openDisclosure(guide, 'Cambiar los datos propuestos (opcional)');
  await expect(field('accountName')).toHaveValue(empty.defaults.accountName);
  await expect(field('responsibleName')).toHaveValue(empty.defaults.responsibleName);
  await expect(field('openingOn')).toHaveValue(empty.defaults.openingOn);
  await field('accountName').fill(accountName);
  await field('responsibleName').fill(responsibleName);
  await field('openingOn').fill(openingOn);
  await field('openingBalanceMinor').fill('4.675,25');
  const saveCash = button(guide, 'Guardar caja y continuar');
  await saveCash.click();
  await expect(field('openingConfirmed')).toBeFocused();
  expect(writes).toEqual([]);
  expect(await current()).toEqual(empty);
  await field('openingConfirmed').check();
  const { accountId, responsibleId } = await commit('prepare', saveCash, { accountName, responsibleName, openingOn, openingBalanceMinor, openingConfirmed: true });
  await assertStage(1);
  const prepared = await current(), openingEntry = [{ account_id: accountId, effective_on: openingOn, amount_minor: openingBalanceMinor, kind: 'opening', source_type: 'account' }];
  expect(prepared.accounts).toEqual([expect.objectContaining({ id: accountId, name: accountName, responsibleId, openingOn, type: 'cash' })]);
  expect(prepared.people).toEqual([expect.objectContaining({ id: responsibleId, name: responsibleName, salaryAgreements: [], commissionOverrides: [] })]);
  expect(prepared.settings).toMatchObject({ defaultReceiptAccountId: accountId, defaultPaymentAccountId: accountId, alertDefaults: { responsibleId } });
  expect(await cashEntries()).toEqual(openingEntry);

  // Approach each subsequent control from the previous, saved stage, not an already focused form.
  await step(0).click();
  await reach(1);
  const saveProduct = button(guide, 'Guardar producto y continuar');
  for (const name of ['title', 'price', 'stockQuantity', 'unitCostMinor']) await expect(field(name)).toHaveValue('');
  await saveProduct.click();
  await expect(field('title')).toBeFocused();
  expect(writes).toHaveLength(1);
  expect(await current()).toEqual(prepared);
  await field('title').fill(title);
  await field('price').fill(String(price));
  const { productId } = await commit('product', saveProduct, { title, price, stockQuantity: null, unitCostMinor: null, presentation: '', sku: '' });
  await assertStage(2);
  const drafted = await current();
  expect(drafted.products).toEqual([expect.objectContaining({ id: productId, title, price, status: 'draft', orderable: true, stockQuantity: null, unitCostMinor: null })]);
  expect(await store.list('products', { published: true })).toEqual([]);

  await step(1).click();
  await reach(2);
  await expect(guide.getByRole('heading', { name: `Reglas guardadas vigentes desde ${rule.effectiveOn}` })).toBeVisible();
  await expect(guide.getByText('Al completar la entrega.', { exact: false })).toBeVisible();
  await expect(guide.getByText(/^Comisiones deshabilitadas/)).toBeVisible();
  await openDisclosure(guide, 'Ver fechas de gastos y alcance');
  await expect(guide.getByText('Flete de ida: recogida real. Retorno: fecha del cargo. Cargo de plataforma: fecha del cargo.', { exact: true })).toBeVisible();
  const saveRules = button(guide, 'Confirmar pedidos y continuar');
  await expect(field('policyConfirmed')).not.toBeChecked();
  await saveRules.click();
  await expect(field('policyConfirmed')).toBeFocused();
  expect(writes).toHaveLength(2);
  expect(await current()).toEqual(drafted);
  await field('policyConfirmed').check();
  expect(await commit('orders', saveRules, { policyConfirmed: true })).toEqual({ ok: true });
  await assertStage(3);
  await page.reload();
  await assertStage(3);
  await expect(guide.getByText('Confirmaste explícitamente la revisión de las reglas de pedidos.', { exact: true })).toBeVisible();
  const ready = await current();
  expect(ready).toMatchObject({ readiness: { cash: true, product: true, orders: true, completed: false }, existingOrders: { count: 0, latestNumber: null }, trialOrder: null });
  expect(ready.settings.setupPolicyConfirmed).toBe(true);
  expect(ready.settings.rulesVersions).toEqual(empty.settings.rulesVersions);
  expect(ready.products).toEqual(drafted.products);
  expect(ready.accounts).toEqual(prepared.accounts);
  expect(ready.people).toEqual(prepared.people);
  expect(await cashEntries()).toEqual(openingEntry);
  for (const table of ['order_collections', 'shipments', 'expenses', 'social_operations']) {
    expect(await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).toEqual({ n: 0 });
  }
  expect(await commands()).toHaveLength(3);
  expect(writes).toEqual(Array(3).fill(['POST', endpoint]));
  for (const value of [accountName, responsibleName, openingOn, String(openingBalanceMinor), title, String(price)]) {
    expect(assistantPayloads.join('\n')).not.toContain(value);
    expect(page.url()).not.toContain(encodeURIComponent(value));
  }
  expect(external).toEqual([]);
  expect(await readFile(log, 'utf8')).toBe('');
});

isolated.setTimeout(150000);
