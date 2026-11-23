import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devices, expect as playwrightExpect, test } from '@playwright/test';
import { chromium } from 'playwright';
import { saveAssistantSettings } from '../../lib/assistant/settings.mjs';
import { login as loginStore } from '../../lib/auth.mjs';
import { insertRow, stamp } from '../../lib/business/commands.mjs';
import { getSocialCampaign, saveSocialCampaign } from '../../lib/business/social.mjs';
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { createIntegrationKeyring } from '../../lib/integrations/keyring.mjs';
import { createBrowserRuntime } from '../../lib/social/browser-runtime.mjs';
import { loadSocialRuntime } from '../../lib/social/config.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';
import { startAssistantProviderFixture } from '../assistant-provider-fixture.mjs';

const expect = playwrightExpect.configure({ timeout: 12000 });
const root = fileURLToPath(new URL('../..', import.meta.url)), spec = fileURLToPath(import.meta.url);
const social = '/api/admin/social', campaigns = `${social}/campaigns`, targeting = `${social}/targeting`;
const appId = '101', appSecret = 'synthetic-c6-audience-app-secret', apiToken = 'synthetic-c6-audience-token';
const apiIdentities = { userId: '102', businessId: '501', pageId: '601', adAccountId: 'act_701' };
const providerModel = 'fixture-a', privateDraft = '655701';
const marks = {
  'search-api-targeting': 'buscar candidatos verificados por API',
  'search-browser-targeting': 'buscar zonas en borrador privado',
  'choose-targeting-references': 'radio explícito de ciudad',
  'propose-ai-audience': 'solicitar audiencia con IA',
  'propose-manual-audience-improvements': 'mejoras de segmentación guardada',
  'read-audience-request': 'comprobar solicitud de segmentación',
  'apply-audience-differences': 'aceptar cambios de edad e interés',
  'apply-broad-audience': 'usar público amplio sin IA',
};
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const editor = (page, record) => page.locator(`[data-campaign-draft-editor="${record.id}"]`);
const ali = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const queryInput = scope => scope.getByRole('searchbox', { name: 'Buscar por nombre', exact: true });
const searchButton = scope => button(scope, 'Buscar candidatos verificados');
const consent = scope => scope.getByRole('checkbox', { name: /^Autorizo esta consulta/ });
const applyButton = scope => button(scope, 'Aplicar solo diferencias elegidas');
const ageChoice = scope => scope.getByRole('checkbox', { name: 'Aplicar el cambio de edad', exact: true });
const whole = (countries, ageMin = 18) => ({ countries, regions: [], cities: [], interests: [], ageMin, ageMax: 65, genders: [] });
const keyPaths = scratch => ({ INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control') });

async function serve(scratch) {
  const paths = keyPaths(scratch);
  const browserRuntime = await createBrowserRuntime({ chromium, keyring: createIntegrationKeyring({ directory: paths.INTEGRATION_SECRETS_DIR, controlDirectory: paths.SOCIAL_BROWSER_CONTROL_DIR }), mediaRoot: join(scratch, 'media') });
  const health = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(403).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(await browserRuntime.health()));
  });
  health.listen(0, '127.0.0.1'); await once(health, 'listening');
  const browserOrigin = `http://127.0.0.1:${health.address().port}`;
  process.env.SOCIAL_BROWSER_URL = browserOrigin;
  const config = pathToFileURL(join(root, 'next.config.mjs')).href, distDir = relative(root, join(scratch, 'next'));
  const transport = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  const nativeFetch = globalThis.fetch;
  registerHooks({ load(url, options, load) {
    if (url === config) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${config}?base`)}; export default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    if (url === transport) return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(`${transport}?base`)}; export const installHekaBrowserTransport = (_, origin) => globalThis.restrictAudienceFetch(origin);` };
    return load(url, options);
  } });
  globalThis.restrictAudienceFetch = origin => {
    delete globalThis.restrictAudienceFetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === origin || url.origin === browserOrigin && url.pathname === '/health') return nativeFetch(input, init);
      if (url.origin === 'https://registry.npmjs.org') return new Response(null, { status: 503 });
      if (url.origin !== 'https://graph.facebook.com') {
        appendFileSync(join(scratch, 'blocked.jsonl'), `${url.origin}${url.pathname}\n`);
        throw new Error('Fixture cerrada: sin conexiones externas reales.');
      }
      const request = new Request(input, init), path = url.pathname.slice('/v26.0/'.length), params = url.searchParams;
      assert.equal(request.method, 'GET');
      assert.ok(url.pathname.startsWith('/v26.0/'));
      const token = path === 'debug_token' ? `${appId}|${appSecret}` : apiToken;
      assert.equal(request.headers.get('Authorization'), `Bearer ${token}`);
      assert.equal(params.get('appsecret_proof'), createHmac('sha256', appSecret).update(token).digest('hex'));
      appendFileSync(join(scratch, 'graph.jsonl'), JSON.stringify({ path, q: params.get('q'), type: params.get('type') }) + '\n');
      const scopes = ['ads_read'];
      const future = Math.floor(Date.now() / 1000) + 3600;
      switch (path) {
        case 'debug_token':
          assert.equal(params.get('input_token'), apiToken);
          return Response.json({ data: { is_valid: true, app_id: appId, user_id: apiIdentities.userId, type: 'USER', scopes, expires_at: future, data_access_expires_at: future } });
        case 'me': return Response.json({ id: apiIdentities.userId });
        case 'me/permissions': return Response.json({ data: scopes.map(permission => ({ permission, status: 'granted' })) });
        case 'me/adaccounts': return Response.json({ data: [{ id: apiIdentities.adAccountId, currency: 'USD', timezone_name: 'America/Bogota', user_tasks: ['ANALYZE'] }] });
        case apiIdentities.adAccountId: return Response.json({ id: apiIdentities.adAccountId, business: { id: apiIdentities.businessId } });
        case 'search':
          if (params.get('type') === 'adinterest' && params.get('q') === 'Fitness') return Response.json({ data: [{ id: '880', name: 'Fitness', path: ['Deportes'] }] });
          assert.equal(params.get('type'), 'adgeolocation');
          assert.equal(params.get('q'), 'Guadalajara');
          return Response.json({ data: [
            { key: '871', type: 'city', name: 'Guadalajara', country_code: 'MX', region: 'Jalisco', region_id: '872' },
            { key: '873', type: 'city', name: 'Bogotá', country_code: 'CO', region: 'Bogotá', region_id: '874' },
          ] });
        default: assert.fail(`Operación Meta no permitida: ${path}`);
      }
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function audienceProvider() {
  const generic = await startAssistantProviderFixture();
  const calls = [];
  const listener = createServer(async (request, response) => {
    const reply = (code, body) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${generic.key}`) return reply(403, { error: 'Solicitud ajena a la fixture' });
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (raw.length > 128 * 1024) return reply(413, {}); }
      const body = JSON.parse(raw), tools = body.tools || [];
      if (!tools.some(tool => tool.function.name === 'proponer_audiencia')) {
        const result = await fetch(`${generic.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${generic.key}` }, body: raw });
        response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text()); return;
      }
      assert.equal(body.model, providerModel);
      assert.deepEqual(tools.map(tool => tool.function.name), ['proponer_audiencia']);
      const facts = JSON.parse(body.messages.find(message => message.role === 'user').content);
      calls.push(facts);
      // The provider receipt is deliberately unavailable only for this saved manual audience.
      if (facts.currentAudience?.ageMin === 30) return reply(503, { error: 'Respuesta sintética no confirmada' });
      const proposal = { ageMin: 24, ageMax: 58, interests: facts.currentAudience ? ['Fitness'] : [], grounding: ['objective', 'markets'], assumptions: ['no_prior_results'] };
      return reply(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name: 'proponer_audiencia', arguments: JSON.stringify(proposal) } }] } }] });
    } catch { return reply(400, { error: 'Datos inesperados en fixture de audiencia' }); }
  });
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  return { url: `http://127.0.0.1:${listener.address().port}/v1`, key: generic.key, calls, close: async () => {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); await generic.close();
  } };
}

async function seed(store, env, actor, via) {
  const createConnection = async (method, identities) => {
    const id = randomUUID(), now = stamp();
    await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: method, state: 'connected', version: 1, created_at: now, updated_at: now,
      data: JSON.stringify({ name: `Cuenta ${method} sintética ${via}`, identities, currency: 'USD', timeZone: 'America/Bogota', capabilities: { adsPublish: true, insights: true }, sessionEpoch: 0 }) });
    return id;
  };
  const apiId = await createConnection('api', apiIdentities);
  const browserId = await createConnection('browser', { ...apiIdentities, adAccountId: '702' });
  const runtime = await loadSocialRuntime(store, { env });
  await saveCredentials(store, apiId, { accessToken: apiToken, userId: apiIdentities.userId }, { runtime });
  const draft = async (name, properties) => saveSocialCampaign(store, { requestId: randomUUID(), name: `${name} · ${via}`, mode: 'paid', objective: 'reach', marketCountries: ['MX', 'PE'], ...properties }, actor, { env });
  const api = await draft('Zonas oficiales', { connectionId: apiId, audience: whole(['PE']) });
  const browser = await draft('Navegador autorizado', { connectionId: browserId, audience: whole(['MX', 'PE']) });
  const row = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [browser.id]);
  const authorized = { kind: 'prepare', remoteDraftRef: privateDraft, adapterVersion: 'meta-ui-v2', privateDraftAuthorization: { actorId: actor, acceptedAt: stamp(), requestId: randomUUID() } };
  await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), preflight: authorized }), browser.id]);
  return { apiId, api, browser, automatic: await draft('Consulta automática', {}), manual: await draft('Consulta manual', { connectionId: apiId, audience: whole(['MX', 'PE'], 28) }), uncertain: await draft('Solicitud incierta', { audience: whole(['MX', 'PE'], 30) }) };
}

async function reach(page, via, capability, target) {
  if (via !== 'panel') {
    await button(page.getByRole('banner'), 'Ali').click();
    let overlay = ali(page);
    const find = scope => scope.locator(`[data-capability-id="advertising.${capability}"]`);
    let card;
    if (via === 'chat') {
      if (await button(overlay, 'Responder').count()) await button(overlay, '‹ Conversaciones').click();
      const count = await find(overlay).count();
      await overlay.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${marks[capability]}?`);
      await button(overlay, 'Enviar').click();
      await expect(find(overlay)).toHaveCount(count + 1);
      card = find(overlay).last();
    } else {
      await button(overlay, '¿Qué quieres hacer?').click();
      overlay = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
      await overlay.getByRole('searchbox', { name: 'Buscar una acción' }).fill(marks[capability]);
      await button(overlay, 'Buscar').click();
      card = find(overlay);
    }
    await card.getByRole('button', { name: /^Abrir en el panel:/ }).click();
    await expect(overlay).toHaveCount(0);
    await expect(ali(page)).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

async function requestAfter(page, path, method, control, filter = () => true) {
  const waited = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === method && url.pathname === path && filter(url);
  });
  await control.click();
  const response = await waited;
  expect(response.ok(), await response.text()).toBe(true);
  return { result: await response.json(), body: response.request().postDataJSON() };
}

if (process.argv[2] === '--serve-audience') await serve(process.argv[3]);
else test('Ali @advisor-c6: audiencias, consentimiento y diferencias del borrador exacto', async ({ browser }, info) => {
  test.setTimeout(360000);
  const tmp = join(root, '.test-data'); await mkdir(tmp, { recursive: true });
  const scratch = await mkdtemp(join(tmp, 'heka-browser-'));
  let provider, server, context, store;
  try {
    for (const log of ['provider.jsonl', 'graph.jsonl', 'blocked.jsonl']) await writeFile(join(scratch, log), '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    provider = await audienceProvider();
    server = fork(spec, ['--serve-audience', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    const env = { ...keyPaths(scratch), APP_URL: origin, DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), SOCIAL_MEDIA_DIR: join(scratch, 'media') };
    const mobile = info.project.name === 'mobile', viewport = mobile ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const arrivals = [], effects = [], external = [], allowed = new Set();
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith(social) && !['GET', 'HEAD'].includes(method)) {
        const body = request.postDataJSON(), key = `${method} ${url.pathname}`;
        effects.push([method, url.pathname, body]);
        if (!allowed.has(key) || url.pathname.endsWith('/browser-preflight') && body.kind !== 'targeting' || url.pathname.endsWith('/audience') && !['propose', 'apply', 'broad'].includes(body.action)) return route.abort();
      } else if (url.pathname === targeting || url.pathname.endsWith('/audience') && url.searchParams.has('requestId')) effects.push([method, url.pathname, Object.fromEntries(url.searchParams)]);
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    await page.goto('/admin/login');
    await page.getByLabel('Correo de administrador').fill('e2e@example.test');
    await page.getByLabel('Contraseña', { exact: true }).fill('clave-e2e-solo-pruebas');
    const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await button(page, 'Entrar al panel').click();
    expect((await authenticated).status()).toBe(200);
    await page.waitForURL(url => url.pathname === '/admin');
    expect(page.viewportSize()).toEqual(viewport);
    store = await openStore(env);
    const { user, csrf, token } = await loginStore(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    const actor = user.id, session = { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') };
    const settings = await saveAssistantSettings(store, { version: 1, requestId: randomUUID(), enabled: true, provider: 'openai-compatible', model: providerModel, baseUrl: provider.url, apiKey: provider.key, allowPrivateNetwork: true }, session, { env });
    await saveSocialSettings(store, { version: 0, requestId: randomUUID(), publicBaseUrl: origin, appId, loginConfigId: '102', appSecret, browserEnabled: true, publishingEnabled: false }, actor, { env, allowedOrigins: [origin] });
    const audience = record => `${campaigns}/${record.id}/audience`;
    const browserPreflight = record => `${campaigns}/${record.id}/browser-preflight`;
    const detail = record => `${campaigns}/${record.id}`;
    const assertExact = record => expect(page).toHaveURL(url => url.searchParams.get('section') === 'advertising' && url.searchParams.get('tab') === 'campaigns' && url.searchParams.get('record') === record.id);
    const saved = (record, expected = {}) => expect.poll(() => getSocialCampaign(store, record.id)).toMatchObject({ id: record.id, state: 'draft', revisions: [], deliveries: [], ...expected });
    const open = async record => {
      await page.goto(`/admin?section=advertising&tab=campaigns&record=${record.id}`);
      const scope = editor(page, record);
      const { name } = await getSocialCampaign(store, record.id);
      await expect(scope.getByRole('heading', { name, exact: true })).toBeVisible();
      if (await button(scope, 'Editar definición').isVisible()) await button(scope, 'Editar definición').click();
      return scope;
    };
    const checkArrival = async (via, record, action, target, expectsVersion = record.version) => {
      const count = effects.length, calls = provider.calls.length;
      await reach(page, via, action, target);
      await assertExact(record);
      await saved(record, { version: expectsVersion });
      expect(effects).toHaveLength(count);
      expect(provider.calls).toHaveLength(calls);
      arrivals.push({ via, id: `advertising.${action}`, campaignId: record.id, version: expectsVersion });
    };
    const other = await saveSocialCampaign(store, { requestId: randomUUID(), name: 'Borrador vecino sin cambios', mode: 'paid', objective: 'reach', marketCountries: ['CO'], audience: whole(['CO'], 38) }, actor, { env });
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const records = await seed(store, env, actor, via);
      const { api, apiId, automatic, manual, uncertain } = records, native = records.browser;
      for (const record of [automatic, manual, uncertain]) allowed.add(`POST ${audience(record)}`);
      allowed.add(`POST ${browserPreflight(native)}`); allowed.add(`PATCH ${detail(api)}`);

      const apiEditor = await open(api);
      await expect(searchButton(apiEditor)).toBeDisabled();
      if (via !== 'panel') await button(apiEditor, 'Continuar a revisión').click();
      await checkArrival(via, api, 'search-api-targeting', queryInput(apiEditor));
      await expect(queryInput(apiEditor)).toHaveValue('');
      await queryInput(apiEditor).fill('Guadalajara');
      const offset = effects.length;
      const result = await requestAfter(page, targeting, 'GET', searchButton(apiEditor));
      expect(result.result.candidates.map(item => item.label)).toEqual(['Guadalajara', 'Bogotá']);
      expect(effects.slice(offset)).toEqual([['GET', targeting, { kind: 'location', q: 'Guadalajara', connection: apiId }]]);
      const choices = apiEditor.getByRole('list', { name: 'Candidatos verificados', exact: true });
      await checkArrival(via, api, 'choose-targeting-references', choices);
      await expect(button(choices, 'Seleccionar Bogotá')).toBeDisabled();
      await expect(choices.getByText('La zona no pertenece a los mercados confirmados.')).toBeVisible();
      await expect(apiEditor.getByLabel('Radio explícito', { exact: true })).toHaveCount(0);
      await button(choices, 'Seleccionar Guadalajara').click();
      const unit = apiEditor.getByLabel('Unidad', { exact: true }), radius = apiEditor.getByLabel('Radio explícito', { exact: true });
      await expect(unit).toHaveValue(''); await expect(radius).toHaveValue(''); await expect(radius).toBeDisabled();
      await checkArrival(via, api, 'choose-targeting-references', unit);
      await unit.selectOption('mile');
      await checkArrival(via, api, 'choose-targeting-references', radius);
      await radius.fill('12');
      await saved(api, { version: api.version, audience: whole(['PE']), operations: [] });
      const localSave = await requestAfter(page, detail(api), 'PATCH', apiEditor.locator('button[type="submit"]').filter({ hasText: /^Guardar borrador$/ }));
      expect(localSave.body).toMatchObject({ version: api.version, marketCountries: ['MX', 'PE'], audience: { countries: ['PE'], cities: [{ key: 'api:location:871', context: { radius: 12, distanceUnit: 'mile' } }] } });
      await saved(api, { version: api.version + 1, audience: { countries: ['PE'], cities: [{ key: 'api:location:871', context: { radius: 12, distanceUnit: 'mile' } }] }, operations: [] });

      const browserEditor = await open(native);
      await expect(searchButton(browserEditor)).toBeDisabled();
      await queryInput(browserEditor).fill('Guadalajara');
      await checkArrival(via, native, 'search-browser-targeting', searchButton(browserEditor));
      const queued = await requestAfter(page, browserPreflight(native), 'POST', searchButton(browserEditor));
      expect(queued.body).toMatchObject({ kind: 'targeting', version: native.version, query: { kind: 'location', q: 'Guadalajara' }, requestId: expect.any(String) });
      expect(queued.body).not.toHaveProperty('acceptPrivateDraft');
      expect(queued.result).toMatchObject({ state: 'prepared', campaignId: native.id, operationId: expect.any(String) });
      await saved(native, { version: native.version + 1, audience: whole(['MX', 'PE']), preflight: { kind: 'pending', remoteDraftRef: privateDraft }, operations: [{ id: queued.result.operationId, step: 'targeting', state: 'prepared' }] });
      await expect(browserEditor.getByRole('list', { name: 'Candidatos verificados' })).toHaveCount(0);

      const autoEditor = await open(automatic);
      if (via !== 'panel') {
        const reason = autoEditor.getByText('Elige personalmente «Definir con IA» en Audiencia para continuar.', { exact: true });
        await checkArrival(via, automatic, 'propose-ai-audience', reason);
        await expect(button(autoEditor, 'Definir con IA')).toHaveAttribute('aria-pressed', 'false');
      }
      await button(autoEditor, 'Definir con IA').click();
      await expect(autoEditor.getByText(/Mercados: México \(MX\), Perú \(PE\)/)).toBeVisible();
      await checkArrival(via, automatic, 'propose-ai-audience', consent(autoEditor));
      await expect(consent(autoEditor)).not.toBeChecked();
      const propose = button(autoEditor, 'Solicitar audiencia con IA');
      await expect(propose).toBeDisabled();
      const priorAuto = provider.calls.length;
      await consent(autoEditor).check();
      await checkArrival(via, automatic, 'propose-ai-audience', propose);
      const auto = await requestAfter(page, audience(automatic), 'POST', propose);
      expect(auto.body).toMatchObject({ action: 'propose', version: automatic.version, mode: 'automatic', settingsVersion: settings.version, consent: true });
      expect(auto.result).toMatchObject({ status: 'proposed', proposal: { scope: { countries: ['MX', 'PE'] }, age: { before: [18, 65], after: [24, 58] } } });
      expect(provider.calls.slice(priorAuto)).toEqual([{ instructions: expect.stringContaining('No elijas países'), objective: 'reach', markets: ['MX', 'PE'], offer: null, currentAudience: null }]);
      await saved(automatic, { version: automatic.version, audience: whole([]), operations: [] });
      const marketScope = autoEditor.getByRole('checkbox', { name: /^Usar los mercados confirmados como países completos/ });
      await checkArrival(via, automatic, 'apply-audience-differences', marketScope);
      await expect(marketScope).not.toBeChecked(); await expect(ageChoice(autoEditor)).not.toBeChecked(); await expect(applyButton(autoEditor)).toBeDisabled();
      await marketScope.check(); await ageChoice(autoEditor).check();
      const autoApplied = await requestAfter(page, audience(automatic), 'POST', applyButton(autoEditor));
      expect(autoApplied.body).toMatchObject({ action: 'apply', proposalId: auto.result.proposalId, version: automatic.version, selectedChanges: { scope: true, age: true, interests: [] } });
      await saved(automatic, { version: automatic.version + 1, audienceMode: 'automatic', audience: { ...whole(['MX', 'PE'], 24), ageMax: 58 } });
      await expect(autoEditor.getByText(/^Audiencia guardada: Definida con IA/)).toBeVisible();

      if (via !== 'panel') {
        const reason = autoEditor.getByText('Elige personalmente «Sin personalizar» en Audiencia para continuar.', { exact: true });
        await checkArrival(via, automatic, 'apply-broad-audience', reason, automatic.version + 1);
        await expect(button(autoEditor, 'Sin personalizar')).toHaveAttribute('aria-pressed', 'false');
      }
      await button(autoEditor, 'Sin personalizar').click();
      const broad = button(autoEditor, 'Usar público amplio sin IA');
      const providerBeforeBroad = provider.calls.length;
      await checkArrival(via, automatic, 'apply-broad-audience', broad, automatic.version + 1);
      const broadResult = await requestAfter(page, audience(automatic), 'POST', broad);
      expect(broadResult.body).toMatchObject({ action: 'broad', version: automatic.version + 1 });
      await saved(automatic, { version: automatic.version + 2, audienceMode: 'broad', audience: whole(['MX', 'PE']), operations: [] });
      expect(provider.calls).toHaveLength(providerBeforeBroad);

      const manualEditor = await open(manual);
      await checkArrival(via, manual, 'propose-manual-audience-improvements', consent(manualEditor));
      const recommend = button(manualEditor, 'Solicitar recomendaciones');
      await expect(recommend).toBeDisabled(); await expect(consent(manualEditor)).not.toBeChecked();
      await consent(manualEditor).check();
      const priorManual = provider.calls.length;
      const recommendation = await requestAfter(page, audience(manual), 'POST', recommend);
      expect(recommendation.body).toMatchObject({ action: 'propose', version: manual.version, mode: 'manual', settingsVersion: settings.version, consent: true });
      expect(recommendation.result).toMatchObject({ status: 'proposed', proposal: { interests: [{ label: 'Fitness', status: 'verified' }] } });
      expect(provider.calls.slice(priorManual)).toEqual([expect.objectContaining({ markets: ['MX', 'PE'], currentAudience: expect.objectContaining({ ageMin: 28, countries: ['MX', 'PE'] }) })]);
      await saved(manual, { version: manual.version, audience: whole(['MX', 'PE'], 28) });
      const interest = manualEditor.getByLabel('Candidato para Fitness', { exact: true });
      await checkArrival(via, manual, 'apply-audience-differences', ageChoice(manualEditor));
      await expect(ageChoice(manualEditor)).not.toBeChecked(); await expect(interest).toHaveValue(''); await expect(applyButton(manualEditor)).toBeDisabled();
      await ageChoice(manualEditor).check();
      await checkArrival(via, manual, 'apply-audience-differences', applyButton(manualEditor));
      const manualApplied = await requestAfter(page, audience(manual), 'POST', applyButton(manualEditor));
      expect(manualApplied.body).toMatchObject({ action: 'apply', version: manual.version, proposalId: recommendation.result.proposalId, selectedChanges: { age: true, interests: [] } });
      await saved(manual, { version: manual.version + 1, audienceMode: 'manual', audience: { ...whole(['MX', 'PE'], 24), ageMax: 58 } });

      const uncertainEditor = await open(uncertain);
      await consent(uncertainEditor).check();
      const unknown = await requestAfter(page, audience(uncertain), 'POST', button(uncertainEditor, 'Solicitar recomendaciones'));
      expect(unknown.result).toMatchObject({ status: 'uncertain', requestId: unknown.body.requestId });
      const recover = button(uncertainEditor, 'Comprobar solicitud sin reenviar');
      if (via !== 'panel') await button(uncertainEditor, 'Continuar a revisión').click();
      await checkArrival(via, uncertain, 'read-audience-request', recover);
      const beforeRead = effects.length, callsBeforeRead = provider.calls.length;
      const checked = await requestAfter(page, audience(uncertain), 'GET', recover, url => url.searchParams.get('requestId') === unknown.body.requestId);
      expect(checked.result).toMatchObject({ status: 'uncertain', requestId: unknown.body.requestId });
      expect(effects.slice(beforeRead)).toEqual([['GET', audience(uncertain), { requestId: unknown.body.requestId }]]);
      expect(provider.calls).toHaveLength(callsBeforeRead);
      await saved(uncertain, { version: uncertain.version, audience: whole(['MX', 'PE'], 30), operations: [] });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
    const graph = (await readFile(join(scratch, 'graph.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(graph.filter(row => row.path === 'search')).toEqual(Array.from({ length: 3 }, () => [
      { path: 'search', q: 'Guadalajara', type: 'adgeolocation' }, { path: 'search', q: 'Fitness', type: 'adinterest' },
    ]).flat());
    expect(provider.calls).toHaveLength(9);
    expect(await readFile(join(scratch, 'blocked.jsonl'), 'utf8')).toBe('');
    expect(external).toEqual([]);
    expect(await store.db.all(`SELECT id FROM ${store.t('social_deliveries')}`)).toEqual([]);
    await saved(other, { version: other.version, audience: whole(['CO'], 38), operations: [] });
    expect(effects).toHaveLength(30);
    await info.attach('audiencia-fixture-local.json', {
      contentType: 'application/json',
      body: JSON.stringify({ viewport, arrivals, effectsAfterHumanActions: effects, syntheticGraphReads: graph, syntheticAudienceProviderCalls: provider.calls.length, externalRequests: external, realDeliveries: 0 }, null, 2),
    });
  } finally {
    await context?.close(); await store?.close();
    if (server && server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
    await provider?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
