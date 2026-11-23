import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { hash, insertRow } from '../../lib/business/commands.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { openDisclosure, selectWorkspace } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const spec = fileURLToPath(import.meta.url);
const initialView = '/admin?section=advertising&tab=campaigns';
const inventoryPath = '/api/admin/social/meta-campaigns';
const account = 'act_501', otherAccount = 'act_502', remote = '9007199254740993';
const localName = 'Campaña propia C6 acreditada';
const current = '2026-11-16T10:00:00.000Z', historic = '2026-10-16T10:00:00.000Z';
const period = { type: 'range', since: '2025-08-01', until: '2025-08-07', timeZone: 'America/Bogota' };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const controls = {
  campaign: ['open-meta-inventory-campaign', 'ficha Meta'],
  snapshot: ['select-meta-inventory-snapshot', 'historial de métricas Meta'],
  adsets: ['read-meta-inventory-adsets', 'conjuntos de anuncios guardados'],
  counterpart: ['open-meta-inventory-counterpart', 'abrir ficha propia'],
};

async function serve(scratch) {
  // Turbo reloads next.config.mjs separately from the custom server options.
  const config = pathToFileURL(join(root, 'next.config.mjs')).href;
  const distDir = relative(root, join(scratch, 'next'));
  const transport = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  registerHooks({ load(url, options, load) {
    if (url === config) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${config}?base`)};\nexport default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    if (url === transport) return { format: 'module', shortCircuit: true, source: `
      import { installHekaBrowserTransport as install } from ${JSON.stringify(`${transport}?base`)};
      export * from ${JSON.stringify(`${transport}?base`)};
      export function installHekaBrowserTransport(log, origin) {
        install(log, origin);
        globalThis.observeInventoryFetch(origin);
      }
    ` };
    return load(url, options);
  } });
  globalThis.observeInventoryFetch = origin => {
    delete globalThis.observeInventoryFetch;
    const closedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      // Next's development version/advisory probes must also stay offline.
      if (url.origin === 'https://registry.npmjs.org') return new Response(null, { status: 503 });
      if (url.origin !== origin) appendFileSync(join(scratch, 'external-fetch.log'), `${url.origin}\n`);
      return closedFetch(input, init);
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function seed(store, actorId) {
  const connection = randomUUID(), archivalConnection = randomUUID(), latest = randomUUID(), historical = randomUUID(), decoy = randomUUID(), local = randomUUID();
  await store.transaction(async tx => {
    const insert = (table, values, data) => insertRow(tx, table, { ...values, data: JSON.stringify(data) });
    const identities = { adAccountId: account };
    const accounts = [{ id: account, name: 'Cuenta principal C6', currency: 'COP' }, { id: otherAccount, name: 'Otra cuenta C6', currency: 'USD' }];
    const coverage = Object.fromEntries(accounts.map(({ id }) => [`ad_account:${id}`, { kind: 'ad_account', resourceId: id, state: 'accessible_complete', missing: [] }]));
    for (const [id, name] of [[connection, 'Conexión reciente C6'], [archivalConnection, 'Conexión histórica C6']]) await insert('social_connections', {
      id, provider: 'meta', integration_method: 'api', state: 'connected', version: 1, created_at: historic, updated_at: current,
    }, { name, authenticationMethod: 'token', readOnly: true, identities, resources: { adAccounts: accounts } });
    for (const [id, connectionId, at] of [[latest, connection, current], [historical, archivalConnection, historic], [decoy, connection, current]]) await insert('social_account_analyses', {
      id, connection_id: connectionId, actor_id: actorId, state: 'completed', version: 1, created_at: at, updated_at: at,
    }, { period, coverage, permissions: ['ads_read'] });
    const capture = (analysisId, at, kind, resourceId, accountId, fields) => insert('social_account_analysis_items', {
      id: randomUUID(), analysis_id: analysisId, resource_kind: kind, resource_id: resourceId, created_at: at, updated_at: at,
    }, { accountId, observedAt: at, period: { type: 'current_snapshot', at }, ...fields });
    await capture(latest, current, 'campaigns', remote, account, { configuration: { status: 'PAUSED' } });
    await capture(decoy, current, 'campaigns', remote, otherAccount, { configuration: { status: 'ACTIVE' } });
    await capture(latest, current, 'adsets', '700', account, { configuration: { campaignId: remote, status: 'ACTIVE' } });
    await capture(historical, historic, 'ads_campaign', remote, account, {
      period, scope: 'paid', currency: 'COP', dimensions: { level: 'campaign', breakdowns: [] },
      values: { spend: { value: '0', unit: 'account_currency_decimal', status: 'reported' } },
    });
    for (let number = 801; number <= 811; number++) await capture(historical, historic, 'adsets', String(number), account, { configuration: { campaignId: remote, status: 'PAUSED', optimization_goal: 'REACH' } });
    await capture(historical, historic, 'adsets', '899', otherAccount, { configuration: { campaignId: remote, status: 'ACTIVE' } });
    await capture(historical, historic, 'adsets', '898', account, { configuration: { campaignId: '900', status: 'ACTIVE' } });
    const assetId = randomUUID(), assetHash = hash(assetId);
    await insert('social_assets', {
      id: assetId, state: 'archived', sha256: assetHash, bytes: 0, version: 1, created_at: historic, updated_at: current,
    }, { name: 'Pieza histórica sintética C6', kind: 'image', derivativeSha256: assetHash });
    await insert('social_campaigns', {
      id: local, connection_id: connection, asset_id: assetId, name: localName, mode: 'paid', objective: 'reach', state: 'paused', version: 1, created_at: historic, updated_at: current,
    }, { platforms: ['facebook'], marketCountries: ['CO'], placements: ['facebook_feed'] });
    const spec = { name: localName, mode: 'paid', objective: 'reach', connectionId: connection, integrationMethod: 'api', identities, assetId, assetHash, assetType: 'image', platforms: ['facebook'], marketCountries: ['CO'], placements: ['facebook_feed'] };
    await insert('social_revisions', { campaign_id: local, revision: 1, spec_hash: hash(spec), approved_at: historic, actor_id: actorId }, { spec });
    await insert('social_deliveries', {
      id: randomUUID(), campaign_id: local, revision: 1, channel: 'meta_ads', state: 'paused', remote_id: remote, version: 1, created_at: historic, updated_at: current,
    }, { remoteRefs: { campaignId: remote }, integrationMethod: 'api', lastConfirmedAt: current, evidence: { remoteRead: true } });
  });
  return { connection, archivalConnection, historical, decoy, local };
}

async function action(page, via, control) {
  await button(page.getByRole('banner'), 'Ali').click();
  let dialog = page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
  const [suffix, query] = controls[control];
  const card = scope => scope.locator(`[data-capability-id="advertising.${suffix}"]`);
  if (via === 'chat') {
    if (await button(dialog, 'Responder').count()) await button(dialog, '‹ Conversaciones').click();
    const before = await card(dialog).count();
    await dialog.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
    await button(dialog, 'Enviar').click();
    await expect(card(dialog)).toHaveCount(before + 1, { timeout: 30000 });
  } else {
    await button(dialog, '¿Qué quieres hacer?').click();
    dialog = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await dialog.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await button(dialog, 'Buscar').click();
  }
  await card(dialog).last().getByRole('button', { name: /^Abrir en el panel:/ }).click();
  return dialog;
}

async function arrive(page, via, control, target) {
  if (via !== 'panel') {
    const dialog = await action(page, via, control);
    await expect(dialog).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

async function expectGuard(page, control, message) {
  const before = page.url();
  const dialog = await action(page, 'directorio', control);
  await expect(dialog.getByRole('alert')).toContainText('El control no se abrió');
  await button(dialog, 'Cerrar directorio').click();
  await expect(page.getByRole('alert').filter({ has: button(page, 'Cerrar error') })).toContainText(message);
  await expect(page).toHaveURL(before);
  await button(page, 'Cerrar error').click();
}

const viewMatches = (url, fields) => Object.entries(fields).every(([key, value]) => url.searchParams.get(key) === value);
const byView = (page, fields) => expect(page).toHaveURL(url => viewMatches(url, fields));
const savedState = store => Promise.all(['social_connections', 'social_account_analyses', 'social_account_analysis_items', 'social_campaigns', 'social_deliveries', 'social_operations'].map(table => store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`)));

if (process.argv[2] === '--serve-meta-inventory') await serve(process.argv[3]);
else test('Ali @advisor-c6: ficha de Meta, lectura exacta, conjuntos y ficha propia sin consultar Meta', async ({ browser }, info) => {
  test.setTimeout(180000);
  const directory = join(root, '.test-data');
  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(join(directory, 'heka-browser-'));
  let server, context, store;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-meta-inventory', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite') });
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const { decoy, historical, archivalConnection, connection, local } = await seed(store, actor.id);
    const baseline = await savedState(store);
    const { defaultBrowserType: _browser, ...device } = info.project.use;
    const viewport = info.project.name === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...device, baseURL: origin, viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const reads = [], writes = [], external = [], errors = [], prompts = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
      if (url.pathname.startsWith('/api/admin/social/') && request.method() !== 'GET') { writes.push(`${request.method()} ${url.pathname}`); return route.abort('blockedbyclient'); }
      if (url.pathname === inventoryPath) reads.push(url);
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
    const session = await context.request.post('/api/auth/login', { headers: { origin }, data: { email: 'e2e@example.test', password: 'clave-e2e-solo-pruebas' } });
    expect(session.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);
    const inventory = page.getByRole('region', { name: 'Campañas consultadas en Meta', exact: true });
    const detail = page.getByRole('region', { name: 'Detalle de campaña consultada', exact: true });
    const heading = detail.getByRole('heading', { name: `Campaña ${remote}`, exact: true });
    const reading = detail.getByRole('combobox', { name: 'Lectura guardada', exact: true });
    const meta = detail.getByRole('region', { name: 'Rendimiento reportado por Meta', exact: true });
    const summary = detail.locator('summary').filter({ hasText: /^Conjuntos de anuncios \(11\)$/ });
    const counterpart = button(detail, 'Abrir ficha propia');
    const row = id => button(inventory, `Ver detalle: Campaña ${remote} · ${id}`);
    const selected = { section: 'advertising', tab: 'campaigns', source: 'meta', account, metaCampaign: remote };
    const exact = { ...selected, connection: archivalConnection, snapshot: historical };
    const openInventory = async () => {
      await page.goto(initialView);
      await selectWorkspace(page, 'Origen de campañas', 'Consultadas en Meta');
      await expect(inventory.getByRole('button', { name: /^Ver detalle:/ })).toHaveCount(2, { timeout: 30000 });
    };

    await test.step('Sin selección, Ali no adivina la campaña, lectura ni vínculo', async () => {
      await openInventory();
      await expectGuard(page, 'campaign', /campaña exacta/i);
      await row(otherAccount).click();
      await expect(detail).toContainText('Vínculo no comprobado');
      await expectGuard(page, 'adsets', /lectura guardada exacta/i);
      await expectGuard(page, 'counterpart', /lectura guardada exacta/i);
      // A single displayed reading can still be explicitly selected without guessing.
      await reading.selectOption(decoy);
      await byView(page, { ...selected, account: otherAccount, connection, snapshot: decoy });
      await expect(heading).toHaveAttribute('data-advisor-control', 'ad-meta-inventory-campaign');
      await expectGuard(page, 'counterpart', /no acredita un vínculo único/i);
      await expect(counterpart).toHaveCount(0);
    });

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      await openInventory();
      await row(account).click();
      await expect(heading).toBeFocused();
      await expect(meta).toContainText('Configuración disponible · Sin métricas');
      await arrive(page, via, 'campaign', heading);
      await byView(page, { ...selected, snapshot: null, connection: null });
      await expect(detail).toContainText(`Cuenta principal C6 · ${account}`);
      await arrive(page, via, 'snapshot', reading);
      await expect(reading).toHaveValue('');
      await byView(page, { ...selected, snapshot: null, connection: null });
      await expect(reading.locator(`option[value="${historical}"]`)).toHaveText(/2025-08-01.*2025-08-07.*act_501.*Conexión histórica C6.*Con métricas/);
      await reading.selectOption(historical);
      await byView(page, exact);
      await expect(reading).toHaveValue(historical);
      await expect(meta).toContainText('2025-08-07');
      await expect(meta).toContainText(/0\s*COP/);
      await expect(meta).toContainText('Sin datos');
      await expect(detail.getByText('Conjunto 801', { exact: true })).toBeHidden();
      await arrive(page, via, 'adsets', summary);
      if (via === 'panel') await openDisclosure(detail, /^Conjuntos de anuncios \(11\)$/);
      await expect(detail.getByText('Conjunto 801', { exact: true })).toBeVisible();
      const pagination = detail.getByRole('navigation', { name: 'Páginas de conjuntos de anuncios' });
      const request = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === inventoryPath && new URL(request.url()).searchParams.get('page') === '2');
      await button(pagination, 'Siguiente').click();
      expect(viewMatches(new URL((await request).url()), { account, metaCampaign: remote, connection: archivalConnection, snapshot: historical })).toBe(true);
      await expect(pagination).toContainText('Página 2 de 2');
      await expect(detail.getByText('Conjunto 811', { exact: true })).toBeVisible();
      for (const id of ['700', '898', '899']) await expect(detail.getByText(`Conjunto ${id}`, { exact: true })).toHaveCount(0);
      await arrive(page, via, 'counterpart', counterpart);
      await byView(page, exact);
      await counterpart.click();
      await byView(page, { section: 'advertising', tab: 'campaigns', record: local, source: null, snapshot: null, connection: null });
      await expect(page.getByRole('heading', { name: localName, exact: true })).toBeVisible();
    });

    expect(reads.some(url => viewMatches(url, { account, metaCampaign: remote, connection: archivalConnection, snapshot: historical, page: '1' }))).toBe(true);
    expect(await savedState(store)).toEqual(baseline);
    expect({ writes, external, errors, prompts }).toEqual({ writes: [], external: [], errors: [], prompts: [] });
    expect(await readFile(join(scratch, 'external-fetch.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('');
    await info.attach('inventario guardado sin efectos', { body: JSON.stringify({ viewport, exact, local, reads: reads.map(url => url.search), writes, external }, null, 2), contentType: 'application/json' });
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
