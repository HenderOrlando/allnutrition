import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { login, navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './helpers.mjs';
import { hekaSnapshot } from '../heka-fixtures.mjs';
import { formatMoneyMinor } from '../../lib/business/money.mjs';
import { databaseConfig } from '../../lib/db/config.mjs';
import { openPostgres } from '../../lib/db/postgres.mjs';
import { Store } from '../../lib/store.mjs';
import { insertRow } from '../../lib/business/commands.mjs';
import { testDatabaseEnv } from '../postgres-fixture.mjs';

const SETTINGS = '/api/admin/social/settings';
const formFor = page => page.getByRole('form', { name: 'Opciones de Meta', exact: true });

async function settingsFixture(page) {
  const panelRequest = page.waitForRequest(request => new URL(request.url()).pathname.startsWith('/api/admin/') && Boolean(request.headers()['x-csrf-token']));
  await login(page);
  const request = await panelRequest;
  const headers = { Origin: new URL(page.url()).origin, 'x-csrf-token': await request.headerValue('x-csrf-token') };
  const get = async () => {
    const response = await page.request.get(SETTINGS);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const put = async settings => {
    const { version, publicBaseUrl, appId, loginConfigId, browserEnabled } = settings;
    const response = await page.request.put(SETTINGS, { headers, data: { version, publicBaseUrl, appId, loginConfigId, browserEnabled, publishingEnabled: false, requestId: randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await navigate(page, 'Configuración');
  await openConfigurationTask(page, 'social');
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'social');
  const add = page.getByRole('button', { name: 'Conectar otra cuenta', exact: true });
  const wizard = page.getByRole('heading', { name: 'Alta guiada de Meta', exact: true });
  await expect(add.or(wizard)).toBeVisible();
  if (await add.isVisible()) await add.click();
  const prepare = page.getByRole('button', { name: 'Configurar la aplicación', exact: true });
  await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toBeVisible();
  if (await prepare.isVisible()) {
    await expect(page.locator('[aria-current="step"]')).toContainText('Preparar la aplicación');
    await prepare.click();
  } else await openDisclosure(page, /^Opciones de Meta$/);
  await expect(formFor(page)).toBeVisible();
  return { get, put };
}

async function saveOptions(page, expectedStatus = 200) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === SETTINGS && response.request().method() === 'PUT');
  await formFor(page).getByRole('button', { name: 'Guardar opciones de Meta', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(expectedStatus);
  return result;
}

test('redes sociales: configuración dinámica, custodia, CAS y navegación sin publicar', async ({ page }) => {
  test.setTimeout(180000);
  const f = await settingsFixture(page), before = await f.get(), form = formFor(page);
  const writes = [];
  const watch = request => {
    if (new URL(request.url()).pathname.startsWith('/api/admin/social') && !['GET', 'HEAD'].includes(request.method())) writes.push(request);
  };
  page.on('request', watch);
  try {
    const origin = new URL(page.url()).origin;
    await expect(form.locator('input[name="publicBaseUrl"]')).toHaveValue(before.publicBaseUrl || origin);
    await expect(form.locator('input[name="appSecret"]')).toHaveAttribute('type', 'password');
    await expect(form.locator('input[name="appSecret"]')).toHaveValue('');
    await form.locator('input[name="publicBaseUrl"]').fill(origin);
    await form.locator('input[name="appId"]').fill(before.appId || '991100001');
    await form.locator('input[name="loginConfigId"]').fill('991100002');
    if (!before.hasAppSecret) await form.locator('input[name="appSecret"]').fill('synthetic-e2e-app-secret-not-a-provider-credential');
    await form.getByRole('checkbox', { name: 'Habilitar publicación y activación', exact: true }).uncheck();
    await form.getByRole('checkbox', { name: 'Habilitar acceso asistido por navegador', exact: true }).uncheck();
    // Force a real edit even on a repeated run with the same persisted fixture.
    await form.locator('input[name="loginConfigId"]').fill(before.loginConfigId === '991100002' ? '991100003' : '991100002');
    await expect(form.getByText('Cambios sin guardar', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toBeDisabled();

    let discardCount = 0;
    const keep = async dialog => { discardCount++; await dialog.dismiss(); };
    page.on('dialog', keep);
    try {
      await openConfigurationTask(page, 'rules');
    } finally { page.off('dialog', keep); }
    expect(discardCount).toBe(1);
    await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'social');
    await expect(form.locator('input[name="publicBaseUrl"]')).toHaveValue(origin);

    const savedResponse = await saveOptions(page), saved = await savedResponse.json();
    expect(saved.version).toBeGreaterThan(before.version);
    expect(saved.publishingEnabled).toBe(false);
    expect(saved.browserEnabled).toBe(false);
    expect(saved.hasAppSecret).toBe(true);
    expect(saved).not.toHaveProperty('appSecret');
    expect(saved).not.toHaveProperty('keys');
    expect(saved).not.toHaveProperty('app_secret_ciphertext');
    await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toBeEnabled();
    await expect(form.locator('input[name="appSecret"]')).toHaveValue('');
    await expect(form.getByText(saved.callbackUrl, { exact: true })).toBeVisible();
    await expect(form.getByText(saved.dataDeletionUrl, { exact: true })).toBeVisible();
    await page.reload();
    await openDisclosure(page, /^Opciones de Meta$/);
    await openDisclosure(page, /^Otras formas de conexión$/);
    await expect(form.getByRole('checkbox', { name: 'Habilitar publicación y activación', exact: true })).not.toBeChecked();
    await expect(form.locator('input[name="appSecret"]')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Crear conexión y abrir acceso', exact: true })).toBeDisabled();

    // A running panel can enable the browser path while publication stays disabled.
    await form.getByRole('checkbox', { name: 'Habilitar acceso asistido por navegador', exact: true }).check();
    const enabledResponse = await saveOptions(page), enabled = await enabledResponse.json();
    expect(enabled.browserEnabled).toBe(true);
    expect(enabled.publishingEnabled).toBe(false);
    expect(enabled.hasAppSecret).toBe(true);
    expect(enabledResponse.request().postDataJSON()).not.toHaveProperty('appSecret');
    await expect(page.locator('input[name="browserName"]')).toBeEnabled();
    await form.getByRole('checkbox', { name: 'Habilitar acceso asistido por navegador', exact: true }).uncheck();
    const disabled = await (await saveOptions(page)).json();
    expect(disabled.browserEnabled).toBe(false);
    expect(disabled.publishingEnabled).toBe(false);

    // Another administrator advances CAS while this form retains a local draft.
    const localLoginId = disabled.loginConfigId === '991100004' ? '991100005' : '991100004';
    await form.locator('input[name="loginConfigId"]').fill(localLoginId);
    const concurrent = await f.put({ ...disabled, browserEnabled: false });
    await saveOptions(page, 409);
    const alert = form.getByRole('alert');
    await expect(alert).toBeFocused();
    await expect(form.locator('input[name="loginConfigId"]')).toHaveValue(localLoginId);
    expect((await f.get()).version).toBe(concurrent.version);
    page.once('dialog', dialog => dialog.accept());
    await alert.getByRole('button', { name: 'Cargar configuración vigente', exact: true }).click();
    await expect(form.locator('input[name="loginConfigId"]')).toHaveValue(concurrent.loginConfigId);
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(form.locator('input[name="appSecret"]')).toHaveValue('');

    await navigate(page, 'Publicidad');
    await expect(page.getByRole('form', { name: 'Opciones de Meta', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Crear publicación o campaña', exact: true }).click();
    await page.getByRole('button', { name: 'Definir primero, sin imagen aún', exact: true }).click();
    await page.getByRole('button', { name: 'Publicación sin inversión', exact: true }).click();
    await page.getByRole('button', { name: 'Conectar cuenta en Redes sociales', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'social');
    await openDisclosure(page, /^Opciones de Meta$/);
    await expect(form).toBeVisible();
    await expect(form.getByRole('checkbox', { name: 'Habilitar publicación y activación', exact: true })).not.toBeChecked();
    for (const request of writes) {
      expect(new URL(request.url()).pathname).toBe(SETTINGS);
      expect(request.method()).toBe('PUT');
      expect(request.postDataJSON().publishingEnabled).toBe(false);
    }
    const current = await f.get();
    expect(current.publishingEnabled).toBe(false);
    expect(current.browserEnabled).toBe(false);
  } finally { page.off('request', watch); }
});

async function seedConnectionHistory() {
  const env = testDatabaseEnv(), host = new URL(env.DATABASE_URL).hostname;
  if (!['db', 'localhost', '127.0.0.1'].includes(host) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('La ficha sintética requiere PostgreSQL local con TLS verificado.');
  const store = new Store(await openPostgres(databaseConfig(env)));
  let committed = false;
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test') throw new Error('La conexión real no corresponde al fixture allnutrition_test.');
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const at = new Date(Date.now() - 60000).toISOString();
    const publishedAt = '2025-08-03T15:00:00.000Z';
    const period = { type: 'range', since: '2025-08-01', until: '2025-08-07', timeZone: 'America/Bogota' };
    const [first, second, waiting] = ['Alfa', 'Beta', 'En pausa'].map(label => {
      const id = randomUUID(), prefix = BigInt(`0x${id.replaceAll('-', '')}`).toString().slice(0, 18);
      return { id, name: `${label} ${id.slice(0, 8)}`, pageId: `${prefix}01`, instagramId: `${prefix}02`, adAccountId: `act_${prefix}03`, postId: `${prefix}01_${prefix}04`, mediaId: `${prefix}05`, campaignId: `${prefix}06`, analysisId: randomUUID() };
    });
    const evidence = (tx, connection, kind, resourceId, data, id = randomUUID()) => insertRow(tx, 'social_account_analysis_items', {
      id, analysis_id: connection.analysisId, resource_kind: kind, resource_id: resourceId, created_at: at, updated_at: at,
      data: JSON.stringify({ observedAt: at, ...data })
    });
    const metric = (value, unit = 'count') => ({ value, unit, status: value == null ? 'unavailable' : 'reported', precision: 'provider_decimal_string' });
    const sample = (value, ownerId, channel, contentId) => ({
      ownerId, contentId, scope: 'organic', dimensions: { level: 'content', channel, breakdowns: [] },
      period: { type: 'lifetime', publishedAt }, values: { views: metric(value), reach: metric('0') }
    });
    await store.transaction(async tx => {
      for (const [index, item] of [first, second, waiting].entries()) {
        const { id, name, pageId, instagramId, adAccountId, postId, mediaId, campaignId, analysisId } = item;
        const pending = item === waiting, token = item === second;
        await insertRow(tx, 'social_connections', { id, provider: 'meta', integration_method: 'api', state: pending ? 'connected' : token ? 'reconnect_required' : 'connected',
          version: 1, created_at: at, updated_at: at, data: JSON.stringify({
            name, authenticationMethod: token ? 'token' : 'oauth', readOnly: token, validatedAt: at, currency: 'COP', timeZone: 'America/Bogota',
            identities: { pageId, ...(token ? {} : { instagramId, adAccountId }) }, capabilities: { facebookPublish: true, insights: true },
            resources: { pages: [{ id: pageId, name: `Página ${name}`, instagramId, instagramName: `Instagram ${name}` }], adAccounts: [{ id: adAccountId, name: `Anuncios ${name}`, currency: 'COP', timeZone: 'America/Bogota' }] },
            ...(pending ? { disconnectPending: { state: 'waiting_for_pause', action: 'disconnect', requestedAt: at, requestId: randomUUID(), actorId: actor.id, deliveryIds: [randomUUID()] } } : {})
          }) });
        if (pending) continue;
        await insertRow(tx, 'social_account_analyses', { id: analysisId, connection_id: id, actor_id: actor.id, state: 'completed', version: 1, created_at: at, updated_at: at,
          data: JSON.stringify({ period, phase: 'completed', stats: { completedUnits: 4, resources: 3, pages: 1, objects: 3 }, work: [], permissions: ['ads_read'], coverage: {
            page: { kind: 'facebook', resourceId: pageId, state: 'accessible_complete', missing: [] },
            ig: { kind: 'instagram', resourceId: instagramId, state: 'accessible_complete', missing: [] },
            ads: { kind: 'ad_account', resourceId: adAccountId, state: 'accessible_complete', missing: [] }
          } }) });
        const postMetricsId = randomUUID(), mediaMetricsId = randomUUID();
        await evidence(tx, item, 'facebook_post', postId, { ownerId: pageId, configuration: { assetType: 'photo' }, period: { type: 'current_snapshot', publishedAt }, metricsItemIds: [postMetricsId], metricsAvailability: 'available' });
        await evidence(tx, item, 'instagram_media', mediaId, { ownerId: instagramId, configuration: { mediaType: 'IMAGE' }, period: { type: 'current_snapshot', publishedAt }, metricsItemIds: [mediaMetricsId], metricsAvailability: 'available' });
        await evidence(tx, item, 'organic_metrics', `facebook:${postId}:0`, sample(index ? '7654321' : '137531', pageId, 'facebook', postId), postMetricsId);
        await evidence(tx, item, 'organic_metrics', `instagram:${mediaId}:0`, sample(index ? '9876542' : '246812', instagramId, 'instagram', mediaId), mediaMetricsId);
        await evidence(tx, item, 'campaigns', campaignId, { accountId: adAccountId, configuration: { status: 'PAUSED', objective: 'OUTCOME_SALES' }, period: { type: 'current_snapshot', at } });
        await evidence(tx, item, 'ads_campaign', campaignId, {
          accountId: adAccountId, period, dimensions: { level: 'campaign', breakdowns: [] }, currency: 'COP', scope: 'paid',
          values: { impressions: metric('9007199254740993'), clicks: metric('0'), reach: metric(null), spend: metric('1000.25', 'account_currency_decimal') }
        });
      }
    });
    committed = true;
    return { first, second, waiting, async cleanup() {
      try {
        await store.transaction(async tx => {
          const ids = [first.id, second.id, waiting.id];
          await tx.db.run(`DELETE FROM ${tx.t('business_requests')} WHERE scope=?`, [`social:connection:${first.id}:disconnect`]);
          await tx.db.run(`DELETE FROM ${tx.t('business_audit')} WHERE entity_type='social_connection' AND entity_id IN (?,?,?)`, ids);
          await tx.db.run(`DELETE FROM ${tx.t('social_account_analyses')} WHERE id IN (?,?)`, [first.analysisId, second.analysisId]);
          await tx.db.run(`DELETE FROM ${tx.t('social_connections')} WHERE id IN (?,?,?)`, ids);
        });
      } finally { await store.close(); }
    } };
  } finally { if (!committed) await store.close(); }
}

test('redes sociales: configuración dinámica y datos consultados por conexión', async ({ page }, info) => {
  test.setTimeout(180000);
  const fixture = await seedConnectionHistory(), { first, second, waiting } = fixture;
  const root = '/admin?section=business&tab=social';
  const writes = [], reads = [];
  const watch = request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/admin/social')) return;
    if (['GET', 'HEAD'].includes(request.method())) reads.push(url);
    else writes.push(request);
  };
  const data = page.getByRole('region', { name: 'Datos consultados', exact: true });
  const record = id => `${root}&record=${id}`;
  const expectRecord = id => expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'social' && url.searchParams.get('record') === id);
  page.on('request', watch);
  try {
    await login(page);
    await page.goto(record(second.id));
    await expectRecord(second.id);
    await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeFocused();
    await expect(page.getByText(`Página ${second.name}`, { exact: true })).toBeVisible();
    await expect(data.getByText('7654321', { exact: true })).toBeVisible();
    await expect(data.getByText('137531', { exact: true })).toHaveCount(0);
    await expect(data.locator('pre')).toHaveCount(0);
    await expect(page.getByText('Sin Instagram profesional', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Volver a autorizar con Facebook', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Conectar un token nuevo', exact: true })).toBeVisible();
    await expect(data.getByText(/Histórico guardado/)).toBeVisible();
    await expect(data.getByText(/Última consulta:/)).toBeVisible();

    await selectWorkspace(data, 'Contenido consultado', 'Facebook');
    await expect(data.getByRole('heading', { name: `Facebook · Publicación ${second.postId}`, exact: true })).toBeVisible();
    await expect(data.getByText('7654321', { exact: true })).toBeVisible();
    await expect(data.getByText(/Desde que se publicó/)).toBeVisible();
    await selectWorkspace(data, 'Contenido consultado', 'Instagram');
    await expect(data.getByRole('heading', { name: `Instagram · Publicación ${second.mediaId}`, exact: true })).toBeVisible();
    await expect(data.getByText('9876542', { exact: true })).toBeVisible();
    await expect(data.getByText(/Publicada:/)).toBeVisible();
    await selectWorkspace(data, 'Contenido consultado', 'Campañas');
    await expect(data.getByRole('heading', { name: `Campaña ${second.campaignId}`, exact: true })).toBeVisible();
    for (const text of ['9007199254740993', '1000.25 COP', '0', 'Sin dato']) await expect(data.getByText(text, { exact: true })).toBeVisible();
    await expect(data.getByText(/2025-08-01 a 2025-08-07 · COP/)).toBeVisible();
    await expectRecord(second.id);
    expect(reads.filter(url => /\/connections\/[^/]+\/analysis$/.test(url.pathname)).every(url => url.pathname.includes(second.id) && url.searchParams.has('content'))).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const screenshot = info.outputPath('ficha-meta-con-datos.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('Ficha Meta con datos', { path: screenshot, contentType: 'image/png' });

    await page.getByRole('button', { name: 'Ver mis conexiones', exact: true }).click();
    await expectRecord(null);
    const manage = item => page.getByRole('button', { name: `Administrar ${item.name}`, exact: true });
    await manage(first).click();
    await expectRecord(first.id);
    await expect(data.getByText('137531', { exact: true })).toBeVisible();
    await expect(data.getByText('7654321', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(data.getByText('137531', { exact: true })).toBeVisible();
    await page.goBack();
    await expectRecord(null);
    await page.goBack();
    await expectRecord(second.id);
    await expect(data.getByText('7654321', { exact: true })).toBeVisible();
    await page.goForward();
    await expectRecord(null);
    await page.goForward();
    await expectRecord(first.id);
    await expect(data.getByText('137531', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);

    await openDisclosure(page, /^Desconectar o eliminar datos locales$/);
    const disconnect = page.getByRole('button', { name: 'Desconectar cuenta', exact: true });
    await disconnect.click();
    const dialog = page.getByRole('dialog', { name: `Desconectar cuenta · ${first.name}`, exact: true });
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(disconnect).toBeFocused();
    expect(writes).toHaveLength(0);
    await disconnect.click();
    const post = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/social/connections/${first.id}/actions` && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Pausar y desconectar', exact: true }).click();
    const result = await post;
    expect(result.ok()).toBe(true);
    expect((await result.json()).remoteSpendStopped).toBe(false);
    await expect(page.getByText(/La desconexión local no confirma/)).toBeVisible();
    await page.reload();
    await expect(page.getByText('Desconectada', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verificar conexión', exact: true })).toHaveCount(0);
    await expect(data.getByText('137531', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Ver mis conexiones', exact: true }).click();
    await manage(waiting).click();
    await expect(page.getByText(/Pausas pendientes de confirmar/)).toBeVisible();
    await page.reload();
    await expectRecord(waiting.id);
    await expect(page.getByText(/Pausas pendientes de confirmar/)).toBeVisible();
    await openDisclosure(page, /^Desconectar o eliminar datos locales$/);
    await expect(disconnect).toBeDisabled();

    const unknown = randomUUID();
    await page.goto(record(unknown));
    await expect(page.getByRole('heading', { name: 'No se encontró esta conexión' })).toBeVisible();
    expect(reads.some(url => url.pathname.includes(unknown))).toBe(false);
    await page.getByRole('button', { name: 'Ver mis conexiones', exact: true }).click();
    await manage(second).click();
    await page.getByRole('button', { name: 'Preparar publicación o campaña', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('section') === 'advertising' && url.searchParams.get('tab') === 'campaigns' && url.searchParams.get('record') === 'new');
    await expect(page.getByRole('button', { name: 'Definir primero, sin imagen aún', exact: true })).toBeVisible();
    expect(writes.map(request => ({ path: new URL(request.url()).pathname, action: request.postDataJSON().action }))).toEqual([
      { path: `/api/admin/social/connections/${first.id}/actions`, action: 'disconnect' }
    ]);
  } finally {
    page.off('request', watch);
    await fixture.cleanup();
  }
});

async function openShippingSettings(page) {
  await navigate(page, 'Configuración');
  await openConfigurationTask(page, 'shipping-integrations');
  await expect(page).toHaveURL(url => url.searchParams.get('section') === 'business' && url.searchParams.get('tab') === 'shipping');
}

test('Heka: emparejar, confirmar, leer y preparar revisión inmutable sin efectos comerciales', async ({ page, playwright }) => {
  test.setTimeout(180000);
  const panelRequest = page.waitForRequest(request => new URL(request.url()).pathname.startsWith('/api/admin/') && Boolean(request.headers()['x-csrf-token']));
  await login(page);
  const csrf = await panelRequest, origin = new URL(page.url()).origin;
  expect(new URL(origin).protocol).toBe('https:');
  const headers = { Origin: origin, 'x-csrf-token': await csrf.headerValue('x-csrf-token') };
  const get = async path => {
    const response = await page.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const post = async (path, data) => {
    const response = await page.request.post(path, { headers, data: { ...data, requestId: randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const finances = async () => {
    const [overview, movements] = await Promise.all([get('/api/admin/finance/overview'), get('/api/admin/finance/movements')]);
    return { availableMinor: overview.availableMinor, movements: movements.total, balances: overview.accounts.map(row => [row.id, row.balanceMinor]).sort() };
  };
  const marker = randomUUID(), platform = await post('/api/admin/business/platforms', { name: 'Heka sintético ' + marker });
  const source = (await get('/api/admin/business/sources')).records.find(row => row.platformId === platform.id);
  expect(source).toBeTruthy();
  const before = await finances();
  // A separate cookie-free client exercises the real bearer-only bridge, not web-session authentication.
  const bridge = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
  let bearer, connectionId;
  const deviceId = 'e2e-' + marker, writes = [];
  const watch = request => {
    if (new URL(request.url()).pathname.startsWith('/api/admin/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request);
  };
  page.on('request', watch);
  const devicePost = async (path, data, authenticated = true) => {
    const response = await bridge.post('/api/shipping/bridge/' + path, {
      headers: authenticated ? { Authorization: 'Bearer ' + bearer } : {},
      data: { deviceId, ...data },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    await openShippingSettings(page);
    const workspace = page.getByRole('region', { name: 'Proveedores de envíos', exact: true });
    await expect(workspace).toContainText(origin);
    const create = page.getByRole('form', { name: 'Conectar fuente con Heka', exact: true });
    await create.getByRole('combobox', { name: 'Fuente comercial', exact: true }).selectOption(source.id);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/shipping/connections' && response.request().method() === 'POST');
    await create.getByRole('button', { name: 'Conectar fuente con Heka', exact: true }).click();
    const response = await created;
    expect(response.ok(), await response.text()).toBe(true);
    connectionId = (await response.json()).id;
    const card = page.locator(`[data-shipping-connection="${connectionId}"]`);
    const queryForm = card.getByRole('form', { name: 'Consultar Heka', exact: true });
    await expect(queryForm.getByRole('button', { name: 'Consultar Heka', exact: true })).toBeDisabled();
    await expect(card).toContainText('Electron desconectado');
    await card.getByRole('button', { name: 'Generar código de emparejamiento', exact: true }).click();
    const code = card.getByTestId('shipping-pairing-code');
    await expect(code).toBeVisible();
    const pairingCode = await code.textContent();
    expect(pairingCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const paired = await devicePost('pair', { code: pairingCode }, false);
    bearer = paired.bearer;
    expect(paired.sourceId).toBe(source.id);
    const reused = await bridge.post('/api/shipping/bridge/pair', { data: { code: pairingCode, deviceId } });
    expect(reused.status()).toBe(401);
    const raw = hekaSnapshot();
    raw.account = { userId: 'e2e-synthetic-' + marker + ' ', centerCost: '0007' };
    for (const packet of raw.packages) {
      packet.header.id_user = raw.account.userId;
      packet.headerAfter.id_user = raw.account.userId;
    }
    await devicePost('identity', { identity: raw.account });
    expect((await devicePost('claim', {})).job).toBeNull();
    await card.getByRole('checkbox', { name: 'Confirmo que esta cuenta Heka corresponde a esta fuente comercial.', exact: true }).check();
    await expect(code).toHaveCount(0);
    await expect(queryForm.getByRole('button', { name: 'Consultar Heka', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: 'Confirmar fuente y cuenta Heka', exact: true }).click();
    await expect(queryForm.getByRole('button', { name: 'Consultar Heka', exact: true })).toBeEnabled();
    await queryForm.getByLabel('Desde', { exact: true }).fill('2026-10-01');
    await queryForm.getByLabel('Hasta', { exact: true }).fill('2026-11-08');
    await queryForm.getByRole('button', { name: 'Consultar Heka', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('máximo 31 días calendario');
    await queryForm.getByLabel('Desde', { exact: true }).fill('2026-11-08');
    await queryForm.getByLabel('Hasta', { exact: true }).fill('2026-11-08');
    const queryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/shipping/connections/${connectionId}/queries` && response.request().method() === 'POST');
    await queryForm.getByRole('button', { name: 'Consultar Heka', exact: true }).click();
    const requested = await queryResponse;
    expect(requested.ok(), await requested.text()).toBe(true);
    const query = await requested.json(), { job } = await devicePost('claim', {});
    expect(job.queryId).toBe(query.queryId);
    expect(job.query.from).toBe('2026-11-08');
    await page.reload();
    await expect(card.getByRole('region', { name: 'Progreso de consulta', exact: true })).toContainText(query.queryId);
    await expect(card).toContainText('Leyendo Heka');
    raw.query = job.query;
    raw.capturedAt = new Date().toISOString();
    const completeInput = { lease: job.lease, snapshot: raw };
    const completed = await devicePost(`jobs/${job.queryId}/complete`, completeInput);
    expect((await devicePost(`jobs/${job.queryId}/complete`, completeInput)).snapshotId).toBe(completed.snapshotId);
    const results = card.getByRole('region', { name: 'Resultados de Heka', exact: true });
    await expect(results).toBeVisible({ timeout: 30000 });
    await expect(results.getByRole('heading', { name: 'Guías observadas (1)', exact: true })).toBeVisible();
    await expect(results.getByRole('region', { name: 'Guías observadas', exact: true })).toContainText('0000123');
    await expect(results).toContainText('ESTADO_DESCONOCIDO');
    const paid = results.getByRole('region', { name: 'Paquetes pagados', exact: true });
    await expect(paid).toContainText('fixture-package-01');
    await expect(paid.getByRole('cell', { name: formatMoneyMinor(-500), exact: true })).toHaveCount(1);
    await expect(paid.getByRole('cell', { name: formatMoneyMinor(-1500), exact: true })).toHaveCount(1);
    await expect(paid.getByRole('row')).toHaveCount(4);
    await expect(paid).toContainText('000002');
    await expect(paid).toContainText(formatMoneyMinor(7025));
    await expect(results.getByRole('region', { name: 'Pendientes de billetera', exact: true })).toContainText('2026-11-09T00:00:00.000Z');
    await page.reload();
    await expect(results).toBeVisible();
    const prepare = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/shipping/imports' && response.request().method() === 'POST');
    await card.getByRole('button', { name: 'Preparar importación completa', exact: true }).click();
    expect((await prepare).ok()).toBe(true);
    await expect(page).toHaveURL(url => url.searchParams.get('section') === 'orders' && url.searchParams.get('tab') === 'imports' && Boolean(url.searchParams.get('batch')), { timeout: 60000 });
    const batchId = new URL(page.url()).searchParams.get('batch'), batch = await get('/api/admin/imports/' + batchId);
    expect(batch.sourceId).toBe(source.id);
    expect(batch.shippingOrigin.snapshotId).toBe(completed.snapshotId);
    expect(batch.shippingOrigin.packages[0].rows).toHaveLength(3);
    expect(batch.shippingOrigin.packages[0].rows.map(row => row.netMinor).sort((a, b) => a - b)).toEqual([-1500, -500, 9025]);
    expect(batch.config.sheets.map(sheet => sheet.sheetName).sort()).toEqual(['settlements', 'tracking']);
    expect(['queued', 'applying', 'completed', 'completed_with_errors']).not.toContain(batch.state);
    const again = await post('/api/admin/shipping/imports', { snapshotId: completed.snapshotId, sourceId: source.id });
    expect(again.batchId).toBe(batchId);
    expect(again.preparing).toBe(false);
    expect(await finances()).toEqual(before);

    await openShippingSettings(page);
    await expect(results).toBeVisible();
    const requestAnother = async () => {
      await expect(queryForm.getByRole('button', { name: 'Consultar Heka', exact: true })).toBeEnabled();
      await queryForm.getByLabel('Desde', { exact: true }).fill('2026-11-08');
      await queryForm.getByLabel('Hasta', { exact: true }).fill('2026-11-08');
      const queued = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/shipping/connections/${connectionId}/queries` && response.request().method() === 'POST');
      await queryForm.getByRole('button', { name: 'Consultar Heka', exact: true }).click();
      const response = await queued;
      expect(response.ok(), await response.text()).toBe(true);
      const claimed = await devicePost('claim', {});
      expect(claimed.job).toBeTruthy();
      return claimed.job;
    };
    const emptyJob = await requestAnother();
    const emptyQueryFinished = page.waitForResponse(async response => new URL(response.url()).pathname === `/api/admin/shipping/queries/${emptyJob.queryId}` && response.request().method() === 'GET' && response.ok() && (await response.json()).state === 'succeeded');
    await devicePost(`jobs/${emptyJob.queryId}/complete`, { lease: emptyJob.lease, snapshot: hekaSnapshot({ account: raw.account, query: emptyJob.query, capturedAt: new Date().toISOString(), guides: [], packages: [], pending: { cutoff: '2026-11-09T00:00:00.000Z', lines: [] } }) });
    await emptyQueryFinished;
    await expect(results).toContainText('Lectura completa sin resultados', { timeout: 30000 });
    await expect(card.getByRole('button', { name: 'Preparar importación completa', exact: true })).toBeDisabled();
    const failedJob = await requestAnother();
    const loginRequired = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/api/admin/shipping/connections' || response.request().method() !== 'GET' || !response.ok()) return false;
      return (await response.json()).connections.some(row => row.id === connectionId && row.state === 'login_required');
    });
    await devicePost(`jobs/${failedJob.queryId}/fail`, { lease: failedJob.lease, errorCode: 'login_required' });
    await loginRequired;
    await expect(card.getByRole('region', { name: 'Progreso de consulta', exact: true })).toContainText('Inicia sesión personalmente en Heka', { timeout: 30000 });
    await expect(card.getByText(/^Heka · Necesita iniciar sesión en Heka · Versión /)).toBeVisible();
    await expect(card).toContainText('Electron conectado');
    await expect(queryForm.getByRole('button', { name: 'Consultar Heka', exact: true })).toBeDisabled();
    page.once('dialog', dialog => dialog.accept());
    await card.getByRole('button', { name: 'Revocar acceso de Electron', exact: true }).click();
    await expect(card).toContainText('Acceso revocado');
    const revoked = await bridge.post('/api/shipping/bridge/heartbeat', { headers: { Authorization: 'Bearer ' + bearer }, data: { deviceId } });
    expect(revoked.status()).toBe(401);
    expect(await finances()).toEqual(before);
    expect(writes.some(request => /\/(commit|confirm|receipts)(\/|$)/.test(new URL(request.url()).pathname))).toBe(false);
  } finally {
    page.off('request', watch);
    if (connectionId) {
      const connection = (await get('/api/admin/shipping/connections')).connections.find(row => row.id === connectionId);
      if (connection && connection.state !== 'revoked') await post(`/api/admin/shipping/connections/${connectionId}/revoke`, { version: connection.version });
    }
    await bridge.dispose();
  }
});
