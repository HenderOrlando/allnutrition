import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { openStore } from '../../lib/db/index.mjs';
import { getSocialConnection } from '../../lib/business/social.mjs';
import { getSocialMeasurement } from '../../lib/business/social-measurement.mjs';
import { getMetaAccountAnalysis, processMetaAccountAnalysisTurn, queueMetaAccountAnalysisTx } from '../../lib/business/social-account-analysis.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';
import { configureSocialTestRuntime } from '../social-runtime-fixture.mjs';
import { login } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const spec = fileURLToPath(import.meta.url);
const managerUrl = 'https://www.facebook.com/events_manager2/list';
const salesAccount = 'act_502', pixelId = '602', token = 'SYNTHETIC-C6-MEASUREMENT';
const results = '/admin?section=advertising&tab=results';
const social = '/api/admin/social/connections';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

function fixtureGraph(input, init, observe) {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method || (input instanceof Request && input.method);
  assert.equal(url.origin, 'https://graph.facebook.com');
  assert.equal(method, 'GET');
  const path = url.pathname.replace(/^\/v26\.0\//, '');
  observe({ method, path });
  const expires = Math.floor(Date.now() / 1000) + 7200;
  const account = { id: salesAccount, currency: 'COP', timezone_name: 'America/Bogota', account_status: 1, user_tasks: ['ANALYZE'] };
  switch (path) {
    case 'debug_token': return Response.json({ data: { app_id: '101', type: 'USER', user_id: '101', is_valid: true, expires_at: expires, data_access_expires_at: expires, scopes: ['ads_read'] } });
    case 'me': return Response.json({ id: '101', name: 'Cuenta sintética C6' });
    case 'me/permissions': return Response.json({ data: [{ permission: 'ads_read', status: 'granted' }] });
    case 'me/adaccounts': return Response.json({ data: [account] });
    case `${salesAccount}/adspixels`: return Response.json({ data: [{ id: pixelId, name: 'Fuente sintética C6', is_unavailable: false }] });
    case `${salesAccount}/campaigns`: return Response.json({ data: [{ id: '702', objective: 'OUTCOME_SALES', status: 'ACTIVE', effective_status: 'ACTIVE', created_time: '2024-01-01T00:00:00Z' }] });
    case `${salesAccount}/adsets`: return Response.json({ data: [] });
    case `${salesAccount}/insights`: {
      const period = JSON.parse(url.searchParams.get('time_range'));
      return Response.json({ data: [{ account_id: '502', account_currency: 'COP', ...(url.searchParams.get('level') === 'campaign' ? { campaign_id: '702' } : {}), date_start: period.since, date_stop: period.until, impressions: '27', reach: '19', spend: '155.50', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }] }] });
    }
    default: assert.fail(`Consulta Graph de fixture no prevista: ${path}`);
  }
}

async function serveMeasurement(scratch) {
  // The router reloads next.config.mjs without the custom server's conf option.
  // Override that one module in this child so both loaders use the same private distDir.
  const projectConfig = pathToFileURL(join(root, 'next.config.mjs')).href;
  const transportModule = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  const distDir = relative(root, join(scratch, 'next'));
  registerHooks({
    load(url, options, load) {
      if (url === projectConfig) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${projectConfig}?base`)};\nexport default { ...config, distDir: ${JSON.stringify(distDir)} };` };
      if (url === transportModule) {
        // Install both fixture transports before Next captures fetch during app.prepare().
        const base = JSON.stringify(`${transportModule}?base`);
        return { format: 'module', shortCircuit: true, source: `
          export * from ${base};
          import { installHekaBrowserTransport as install } from ${base};
          export function installHekaBrowserTransport(log, origin) {
            install(log, origin);
            globalThis.installC6MeasurementTransport();
          }
        ` };
      }
      return load(url, options);
    },
  });
  globalThis.installC6MeasurementTransport = () => {
    delete globalThis.installC6MeasurementTransport;
    const closedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'https://graph.facebook.com') return closedFetch(input, init);
      return fixtureGraph(input, init, event => appendFileSync(join(scratch, 'measurement-graph.jsonl'), JSON.stringify(event) + '\n'));
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function seed(store, env, actor) {
  const { runtime } = await configureSocialTestRuntime(store, { env, settings: { browserEnabled: false, publishingEnabled: false } });
  const first = randomUUID(), selected = randomUUID();
  const earlier = '2025-01-01T00:00:00.000Z', later = '2025-02-01T00:00:00.000Z';
  for (const [id, name, accountId, at] of [[first, 'Otra cuenta C6', 'act_501', earlier], [selected, 'Ventas C6', salesAccount, later]]) {
    const data = { name, authenticationMethod: 'token', readOnly: true, sessionEpoch: 1, configurationFingerprint: runtime.fingerprint, identities: { userId: '101', adAccountId: accountId }, capabilities: { insights: true }, resources: { adAccounts: [{ id: accountId, currency: 'COP', timeZone: 'America/Bogota', tasks: ['ANALYZE'] }] } };
    await store.db.run(`INSERT INTO ${store.t('social_connections')}(id,provider,integration_method,state,data,version,created_at,updated_at) VALUES(?,'meta','api','connected',?,1,?,?)`, [id, JSON.stringify(data), at, at]);
    await saveCredentials(store, id, { accessToken: token, userId: '101' }, { runtime, env, sessionEpoch: 1 });
  }
  const now = new Date().toISOString(), historyCalls = [];
  const queued = await store.transaction(async tx => {
    await tx.lockWrites();
    return queueMetaAccountAnalysisTx(tx, await getSocialConnection(tx, selected), actor, { now });
  });
  for (let n = 0; n < 30; n++) {
    const turn = await processMetaAccountAnalysisTurn(store, { now, env, transport: { fetchImpl: async (input, init) => fixtureGraph(input, init, call => historyCalls.push(call)) } });
    if (!turn.hasMore) break;
  }
  const { analysis, items } = await getMetaAccountAnalysis(store, selected, {}, actor);
  expect(analysis).toMatchObject({ id: queued.id, state: 'partial', permissions: ['ads_read'] });
  expect(items.some(item => item.resourceId === '702')).toBe(true);
  expect(historyCalls).toContainEqual({ method: 'GET', path: `${salesAccount}/insights` });
  return { first, selected, analysis };
}

async function reach(page, via, suffix, query, target) {
  if (via !== 'panel') {
    await button(page.getByRole('banner'), 'Ali').click();
    let dialog = page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
    const find = scope => scope.locator(`[data-capability-id="advertising.${suffix}"]`);
    let card;
    if (via === 'chat') {
      if (await button(dialog, 'Responder').count()) await button(dialog, '‹ Conversaciones').click();
      const count = await find(dialog).count();
      await dialog.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
      await button(dialog, 'Enviar').click();
      await expect(find(dialog)).toHaveCount(count + 1, { timeout: 30000 });
      card = find(dialog).last();
    } else {
      await button(dialog, '¿Qué quieres hacer?').click();
      dialog = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
      await dialog.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
      await button(dialog, 'Buscar').click();
      card = find(dialog);
    }
    await card.getByRole('button', { name: /^Abrir en el panel:/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

if (process.argv[2] === '--serve-measurement') await serveMeasurement(process.argv[3]);
else test('Ali @advisor-c6: medición local, verificación consentida, Events Manager y análisis guardado', async ({ browser }, info) => {
  test.setTimeout(180000);
  const directory = join(root, '.test-data');
  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(join(directory, 'heka-browser-'));
  const graphLog = join(scratch, 'measurement-graph.jsonl'), hekaLog = join(scratch, 'provider.jsonl');
  let server, context, store;
  try {
    await Promise.all([graphLog, hekaLog].map(file => writeFile(file, '', { mode: 0o600 })));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-measurement', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control'), APP_URL: origin };
    store = await openStore(env);
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const { first, selected, analysis } = await seed(store, env, actor.id);
    const untouched = await getSocialMeasurement(store, first), endpoint = `${social}/${selected}/measurement`;
    const analysisPath = `${social}/${selected}/analysis`;
    const provider = async () => (await readFile(graphLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const { defaultBrowserType: _browser, ...device } = info.project.use;
    const viewport = info.project.name === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...device, baseURL: origin, viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const external = [], handoffs = [], writes = [], errors = [], confirms = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.href === managerUrl && request.isNavigationRequest() && request.method() === 'GET') handoffs.push(url.href);
      else external.push(url.href);
      return route.abort('blockedbyclient');
    });
    context.on('request', request => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/admin/social/') && request.method() !== 'GET') writes.push({ path: pathname, method: request.method(), body: request.postDataJSON() });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { confirms.push(dialog.message()); await dialog.dismiss(); });
    await login(page);
    expect(page.viewportSize()).toEqual(viewport);
    const observations = [];
    const panel = page.getByRole('region', { name: 'Objetivo y medición del negocio' });
    const selector = panel.getByRole('combobox', { name: 'Conexión para objetivo y medición' });
    const savedState = panel.getByRole('region', { name: 'Estado comprobado de la fuente' });
    const define = panel.locator('[data-advisor-control="Configuración local"]');
    const objective = panel.getByLabel('Objetivo a mejorar');
    const source = panel.getByLabel('Fuente de medición');
    const save = button(panel, 'Guardar objetivo y medición');
    const verify = button(panel, 'Comprobar fuente en Meta');
    const manager = button(panel, 'Events Manager de Meta');
    const analysisGroup = page.getByRole('group', { name: 'Análisis histórico y contenido actual' });
    const report = analysisGroup.getByRole('region', { name: 'Análisis histórico de las cuentas Meta' });
    const response = (path, method) => page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === method);
    const addEvent = button(panel, 'Añadir evento'), discard = button(panel, 'Descartar cambios de medición');

    await test.step('buscar publicaciones mientras todavía se lee la medición', async () => {
      const path = `${social}/${first}/measurement`;
      const pending = Promise.withResolvers();
      const release = Promise.withResolvers();
      const delayRead = async route => {
        pending.resolve();
        await release.promise;
        await route.continue();
      };
      await page.route(`**${path}`, delayRead, { times: 1 });
      try {
        await page.goto(results);
        await pending.promise;
        const list = page.getByRole('region', { name: 'Publicaciones y campañas', exact: true });
        const term = 'Nombre sintético inexistente';
        await list.getByRole('searchbox', { name: 'Buscar publicaciones' }).fill(term);
        await button(list, 'Buscar publicaciones').click();
        await expect(list.getByRole('heading', { name: 'No hay coincidencias con ese nombre' })).toBeVisible();
        await expect(page).toHaveURL(url => url.searchParams.get('q') === term);
      } finally {
        release.resolve();
      }
    });

    for (const [index, via] of ['panel', 'chat', 'directorio'].entries()) await test.step(via, async () => {
      const before = await getSocialMeasurement(store, selected), readOffset = (await provider()).length, writeOffset = writes.length;
      const purchase = { name: 'Purchase', objective: 'sales' }, event = { name: `C6Visit${index + 1}`, objective: 'traffic' };
      await page.goto('/admin?section=advertising&tab=campaigns');
      if (via === 'panel') {
        const views = page.getByRole('navigation', { name: 'Vistas de publicidad' });
        if (info.project.name === 'mobile') await views.getByRole('combobox').selectOption('results');
        else await button(views, 'Resultados').click();
      }
      await reach(page, via, 'read-account-measurement', 'medición de la cuenta', selector);
      await expect(page).toHaveURL(new URL(results, origin).href);
      await expect(selector).toHaveValue(first);
      await selector.selectOption(selected);
      await expect(objective).toHaveValue(before.config.objective);
      await expect(selector).toHaveValue(selected);
      await expect(savedState.getByText(before.config.verification.status === 'verified' ? /^Acceso y asociación comprobados$/ : /^Sin comprobar$/).first()).toBeVisible();
      expect((await provider()).length).toBe(readOffset);
      expect(writes).toHaveLength(writeOffset);

      await reach(page, via, 'define-account-measurement', 'configurar medición local', define);
      await objective.selectOption('sales');
      await source.selectOption('meta_pixel');
      await panel.getByLabel('ID del píxel').fill(pixelId);
      if (!before.config.events.length) {
        await addEvent.click();
        await panel.getByLabel('Nombre del evento 1').fill(purchase.name);
      } else await button(panel, 'Quitar evento 2').click();
      await addEvent.click();
      await panel.getByLabel('Nombre del evento 2').fill(event.name);
      await panel.getByLabel('Objetivo del evento 2').selectOption(event.objective);
      await expect(selector).toBeDisabled();
      await expect(verify).toBeDisabled();
      expect(await getSocialMeasurement(store, selected)).toEqual(before);
      expect(writes).toHaveLength(writeOffset);

      await reach(page, via, 'open-meta-events-manager', 'instalar píxel en Meta', manager);
      await manager.click();
      let consent = page.getByRole('dialog', { name: 'Abrir Events Manager de Meta' });
      await expect(consent).toBeVisible();
      await expect(button(consent, 'Cancelar')).toBeFocused();
      await expect(consent.getByText(/consentimiento, la instalación, las pruebas y la deduplicación/)).toBeVisible();
      await button(consent, 'Cancelar').click();
      expect(handoffs).toHaveLength(index);
      await manager.click();
      const externalLink = consent.getByRole('link', { name: 'Continuar a Events Manager de Meta' });
      await expect(externalLink).toHaveAttribute('href', managerUrl);
      await expect(externalLink).toHaveAttribute('target', '_blank');
      await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
      const popupRequest = context.waitForEvent('request', { predicate: item => item.url() === managerUrl && item.isNavigationRequest() });
      await externalLink.click();
      await popupRequest;
      await expect.poll(() => handoffs.length).toBe(index + 1);
      for (const popup of context.pages().filter(item => item !== page)) await popup.close();
      await expect(page).toHaveURL(new URL(results, origin).href);
      await expect(selector).toHaveValue(selected);
      await expect(panel.getByLabel('Nombre del evento 2')).toHaveValue(event.name);
      expect(await getSocialMeasurement(store, selected)).toEqual(before);
      expect(writes).toHaveLength(writeOffset);

      await reach(page, via, 'save-account-measurement', 'guardar objetivo y medición', save);
      await expect(panel.getByLabel('Nombre del evento 2')).toHaveValue(event.name);
      const saveResponse = response(endpoint, 'POST');
      await save.click();
      expect((await saveResponse).status()).toBe(200);
      await expect(panel.getByText(/Objetivo y medición guardados/)).toBeVisible();
      const stored = await getSocialMeasurement(store, selected);
      expect(stored).toMatchObject({ connectionVersion: before.connectionVersion + 1, config: { objective: 'sales', source: 'meta_pixel', pixelId, events: [purchase, event], verification: { status: 'unverified' } } });
      expect(writes.slice(writeOffset)).toEqual([{ path: endpoint, method: 'POST', body: { action: 'save', version: before.connectionVersion, requestId: expect.any(String), config: expect.objectContaining({ objective: 'sales', source: 'meta_pixel', pixelId, events: [purchase, event] }) } }]);
      expect((await provider()).length).toBe(readOffset);
      const reloadResponse = response(endpoint, 'GET');
      await button(panel, 'Recargar configuración').click();
      expect((await reloadResponse).status()).toBe(200);
      await expect(objective).toHaveValue('sales');
      await expect(panel.getByLabel('Nombre del evento 2')).toHaveValue(event.name);

      await reach(page, via, 'verify-account-measurement-source', 'comprobar fuente en Meta', verify);
      await verify.click();
      consent = page.getByRole('dialog', { name: 'Comprobar fuente en Meta' });
      await expect(button(consent, 'Cancelar')).toBeFocused();
      await expect(consent.getByText(/Ventas C6 · act_502 a Píxel de Meta 602/)).toBeVisible();
      await expect(consent.getByText(/no envía eventos ni confirma conversiones/)).toBeVisible();
      await button(consent, 'Cancelar').click();
      await expect(consent).toHaveCount(0);
      expect(writes).toHaveLength(writeOffset + 1);
      expect((await provider()).length).toBe(readOffset);
      await verify.click();
      const verifyResponse = response(endpoint, 'POST');
      await button(consent, 'Autorizar consulta en Meta').click();
      const verified = await verifyResponse;
      expect(verified.status(), `Respuesta: ${await verified.text()} · Graph: ${JSON.stringify((await provider()).slice(readOffset))}`).toBe(200);
      await expect(savedState.getByText('Acceso y asociación comprobados', { exact: true })).toBeVisible();
      await expect(savedState.getByText(/no comprueba instalación, recepción del evento configurado, compras ni atribución/)).toBeVisible();
      await savedState.getByText('Fuentes accesibles comprobadas (1)', { exact: true }).click();
      await expect(savedState.getByText('Fuente sintética C6 · 602', { exact: true })).toBeVisible();
      const checked = await getSocialMeasurement(store, selected);
      expect(checked).toMatchObject({ connectionVersion: stored.connectionVersion + 1, config: { events: [purchase, event], verification: { status: 'verified', accountId: salesAccount, sourceId: pixelId, checkedAt: expect.any(String) } } });
      const graph = (await provider()).slice(readOffset);
      expect(graph).toEqual(['debug_token', 'me', 'me/permissions', 'me/adaccounts', `${salesAccount}/adspixels`].map(path => ({ method: 'GET', path })));

      await reach(page, via, 'read-account-analysis', 'análisis histórico y contenido actual', analysisGroup);
      const analysisSelector = report.getByRole('combobox', { name: 'Conexión', exact: true });
      await expect(analysisSelector).toHaveValue('');
      await expect(analysisSelector.locator('option:checked')).toHaveText('Elige la conexión Meta exacta');
      await analysisSelector.selectOption(selected);
      await expect(button(report, 'Reintentar estado local')).toBeEnabled();
      const localAnalysis = response(analysisPath, 'GET');
      await button(report, 'Reintentar estado local').click();
      expect((await (await localAnalysis).json()).analysis.id).toBe(analysis.id);
      await expect(report.getByText(new RegExp(`Período solicitado: ${analysis.period.since} – ${analysis.period.until}`))).toBeVisible();
      await report.getByText('Cobertura y faltantes', { exact: true }).click();
      await expect(report.getByText(/Permisos confirmados en la última lectura: ads_read/)).toBeVisible();
      await expect(report.getByText(/ad_account act_502:/)).toBeVisible();
      await expect(report.getByRole('heading', { name: 'Completar medición antes de optimizar' })).toBeVisible();
      await expect(report.getByText(/El histórico agregado no permite comprobar qué pixel\/evento originó las compras/)).toBeVisible();
      await expect(selector).toHaveValue(selected);
      await expect(discard).toBeDisabled();
      expect(writes.slice(writeOffset + 1)).toEqual([{ path: endpoint, method: 'POST', body: { action: 'verify', version: stored.connectionVersion, requestId: expect.any(String) } }]);
      expect((await provider()).slice(readOffset)).toEqual(graph);
      expect(await getSocialMeasurement(store, first)).toEqual(untouched);
      observations.push({ via, selected, salesAccount, pixelId, event, savedVersion: stored.connectionVersion, verifiedVersion: checked.connectionVersion, checkedAt: checked.config.verification.checkedAt, handoff: { url: managerUrl, blocked: true }, analysis: { id: analysis.id, period: analysis.period, state: analysis.state, permissions: analysis.permissions }, graph });
    });
    expect(errors).toEqual([]);
    expect(confirms).toEqual([]);
    expect(external).toEqual([]);
    expect(await readFile(hekaLog, 'utf8')).toBe('');
    await info.attach('controles de medición', { body: JSON.stringify({ viewport, observations }, null, 2), contentType: 'application/json' });
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
