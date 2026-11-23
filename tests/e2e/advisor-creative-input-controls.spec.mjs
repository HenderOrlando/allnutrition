import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devices, expect, test } from '@playwright/test';
import sharp from 'sharp';
import { saveAssistantSettings } from '../../lib/assistant/settings.mjs';
import { login as loginStore } from '../../lib/auth.mjs';
import { createSocialCreativeThread, patchSocialCreativeThread } from '../../lib/business/social-creative-threads.mjs';
import { getSocialCreativeThread, getSocialGenerationBrief, processSocialGenerationTurn, requestSocialGeneration } from '../../lib/business/social-generation.mjs';
import { createSocialAsset, getSocialAsset, processSocialAssetTurn, uploadSocialAsset } from '../../lib/business/social-media.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { startAssistantProviderFixture } from '../assistant-provider-fixture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), spec = fileURLToPath(import.meta.url);
const studioPath = '/admin?section=advertising&tab=campaigns&record=new';
const social = '/api/admin/social', generation = `${social}/generation`, threads = `${social}/creative-threads`;
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const ali = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const keepLocal = 'Autorizo el envío a OpenAI';
const contextTitle = 'Datos y fotos para preparar imagen', referencesTitle = 'Referencias opcionales: biblioteca y productos';

async function serveCreative(scratch, fixtureUrl) {
  assert.match(fixtureUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const nextConfig = pathToFileURL(join(root, 'next.config.mjs')).href;
  const distDir = relative(root, join(scratch, 'next'));
  // Next's router also loads this file independently of the runner's conf option.
  registerHooks({ load(url, options, load) {
    if (url === nextConfig) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${nextConfig}?base`)};\nexport default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    return load(url, options);
  } });
  // Preserve official OpenAI settings for availability and exercise the Responses
  // protocol against the loopback fixture. Never resolve or connect to OpenAI.
  const lookup = dns.lookup, request = https.request;
  dns.lookup = (host, ...args) => host === 'api.openai.com'
    ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
    : lookup(host, ...args);
  https.request = (input, options, callback) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : null;
    if (url?.hostname !== 'api.openai.com') return request(input, options, callback);
    assert.equal(url.href, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    return http.request(`${fixtureUrl}/responses`, { method: options.method, headers: options.headers, signal: options.signal, agent: false }, callback);
  };
  syncBuiltinESMExports();
  process.argv.splice(2, 3, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function reach(page, via, capability, query, control, openPanel) {
  if (via === 'panel') {
    await openPanel?.();
  } else {
    await button(page.getByRole('banner'), 'Ali').click();
    let overlay = ali(page);
    const find = scope => scope.locator(`[data-capability-id="advertising.${capability}"]`);
    let card;
    if (via === 'chat') {
      if (await button(overlay, 'Responder').count()) await button(overlay, '‹ Conversaciones').click();
      const count = await find(overlay).count();
      await overlay.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
      await button(overlay, 'Enviar').click();
      await expect(find(overlay)).toHaveCount(count + 1, { timeout: 30000 });
      card = find(overlay).last();
    } else {
      await button(overlay, '¿Qué quieres hacer?').click();
      overlay = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
      await overlay.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
      await button(overlay, 'Buscar').click();
      card = find(overlay);
    }
    await card.getByRole('button', { name: /^Abrir en el panel:/ }).click();
    await expect(overlay).toHaveCount(0);
    await expect(ali(page)).toHaveCount(0);
    await expect(control).toBeFocused();
    await expect(control).toHaveAttribute('data-advisor-arrival', '');
    await expect(control).toBeInViewport();
  }
  await expect(control).toBeVisible();
}

if (process.argv[2] === '--serve-creative') await serveCreative(process.argv[3], process.argv[4]);
else test('Ali @advisor-c6: indicaciones, fotos, consentimiento exacto y progreso del estudio privado', async ({ browser }, info) => {
  test.setTimeout(240000);
  const temporary = join(root, '.test-data');
  await mkdir(temporary, { recursive: true });
  const scratch = await mkdtemp(join(temporary, 'heka-browser-'));
  let fixture, server, browserContext, store;
  try {
    await writeFile(join(scratch, 'provider.jsonl'), '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    fixture = await startAssistantProviderFixture();
    server = fork(spec, ['--serve-creative', scratch, fixture.url], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control'), SOCIAL_MEDIA_DIR: join(scratch, 'media'), APP_URL: origin };
    const mobile = info.project.name === 'mobile';
    const viewport = mobile ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    browserContext = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const external = [], socialWrites = [], threadReads = [], workerCalls = [];
    await browserContext.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith(`${social}/`) && !['GET', 'HEAD'].includes(request.method())) {
        socialWrites.push([request.method(), url.pathname]);
        return route.abort();
      }
      if (url.pathname.startsWith(`${threads}/`)) threadReads.push(url.pathname);
      return route.continue();
    });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(20000);
    const sessionResponse = await browserContext.request.post('/api/auth/login', { headers: { origin }, data: { email: 'e2e@example.test', password: 'clave-e2e-solo-pruebas' } });
    expect(sessionResponse.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);
    const studio = page.getByRole('region', { name: 'Estudio visual', exact: true });
    const review = page.getByRole('dialog', { name: contextTitle, exact: true });
    const picker = page.getByRole('dialog', { name: referencesTitle, exact: true });
    const openReview = () => button(studio, contextTitle).click();
    const closeReview = () => button(review, 'Volver al chat').click();
    const openPicker = async () => { await openReview(); await button(review, referencesTitle).click(); };
    const exactStudio = async id => expect(page).toHaveURL(url => url.searchParams.get('record') === 'new' && url.searchParams.get('studio') === id);
    await page.goto(studioPath);
    await expect(studio.getByRole('region', { name: 'Compositor' })).toContainText('No está configurado el servicio de imágenes.', { timeout: 30000 });
    await openReview();
    await expect(review).toContainText('No está configurado el servicio de imágenes.');
    await expect(review).toContainText('Abrir este panel no envía nada a OpenAI.');
    await closeReview();

    store = await openStore(env);
    expect(await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`)).toBeNull();
    const { user, csrf, token } = await loginStore(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    const session = { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') };
    const configuration = await saveAssistantSettings(store, { version: 1, requestId: randomUUID(), enabled: true, provider: 'openai', model: 'fixture-a', baseUrl: '', apiKey: fixture.key, allowPrivateNetwork: false }, session, {
      env,
      transport: async (url, input) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        const response = await fetch(`${fixture.url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${input.apiKey}` }, body: input.body });
        assert.equal(response.status, 200);
        return response.json();
      },
    });
    const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#67528a' } }).png().toBuffer();
    async function photo(name) {
      const asset = await createSocialAsset(store, { name, contentType: 'image/png', expectedBytes: image.length, requestId: randomUUID() }, user.id, { env });
      await uploadSocialAsset(store, asset.id, { version: asset.version, contentType: 'image/png', contentLength: image.length, body: Readable.from([image]), requestId: randomUUID() }, user.id, { env });
      expect(await processSocialAssetTurn(store, { env })).toMatchObject({ processed: 1 });
      const ready = await getSocialAsset(store, asset.id);
      expect(ready.state).toBe('ready');
      return ready;
    }
    const base = await photo('Foto base C6');
    const references = [];
    for (const label of ['A', 'B', 'C', 'D']) references.push(await photo(`Referencia C6 ${label}`));
    const product = await store.save('products', { title: 'Referencia C6 Producto', slug: 'referencia-c6-producto', status: 'draft', price: 15000, image: '/brand/creatina-vital-force.jpg' }, null, null, user.id);
    const productChoice = picker.getByRole('checkbox', { name: `Producto: ${product.title} · Versión ${product.version}`, exact: true });
    const referenceChoice = index => picker.getByRole('checkbox', { name: `Biblioteca: ${references[index].name} · Versión ${references[index].version}`, exact: true });
    const search = picker.getByRole('searchbox', { name: 'Buscar fotos de referencia', exact: true });
    const apply = button(picker, 'Aplicar referencias');
    const prompt = studio.getByLabel('Escríbele a Ali', { exact: true });
    const consent = studio.getByRole('checkbox', { name: new RegExp(`^${keepLocal}`) });
    const brief = await getSocialGenerationBrief(store, { env });
    const notes = [];

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const createThread = () => createSocialCreativeThread(store, { requestId: randomUUID(), campaignId: null }, session);
      const thread = await createThread(), adjustment = await createThread();
      const attached = await patchSocialCreativeThread(store, adjustment.id, { action: 'attach', version: adjustment.version, assetId: base.id, assetVersion: base.version }, session);
      const queuedPrompt = `Turno sintético C6 ${via}`;
      const job = await requestSocialGeneration(store, {
        requestId: randomUUID(), threadId: thread.id, threadVersion: thread.version, campaignId: null, campaignVersion: null,
        briefHash: brief.briefHash, configurationVersion: configuration.version, baseAsset: null, prompt: queuedPrompt, format: 'png', sources: [],
        consent: { version: 2, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true },
      }, session, { env });
      expect(job).toMatchObject({ state: 'queued' });
      await page.goto(`${studioPath}&studio=${thread.id}`);
      await expect(studio.getByRole('list', { name: 'Turnos del chat' })).toContainText(queuedPrompt);
      await reach(page, via, 'prepare-creative-instructions', 'describir una idea', prompt);
      await exactStudio(thread.id);
      await expect(prompt).toHaveValue('');
      await prompt.fill('Muestra una composición geométrica con fondo claro.');
      await studio.getByText('Opciones de formato', { exact: true }).click();
      await studio.getByRole('combobox', { name: 'Formato', exact: true }).selectOption('gif');
      await studio.getByLabel('Fotogramas (2–16)', { exact: true }).fill('8');
      const frameDuration = studio.getByLabel('Milisegundos por fotograma', { exact: true });
      await frameDuration.fill('500');
      await expect(studio).toContainText('Duración: 4.00 segundos.');
      const sendIdea = button(studio, 'Enviar idea');
      await reach(page, via, 'generate-image', 'enviar idea para GIF', consent);
      await expect(consent).toHaveAttribute('data-advisor-control', 'ad-studio-consent-new');
      await expect(consent).not.toBeChecked();
      await expect(sendIdea).toBeDisabled();
      await consent.check();
      await expect(sendIdea).toBeEnabled();
      await frameDuration.fill('600');
      await expect(consent).not.toBeChecked();
      await expect(sendIdea).toBeDisabled();
      await consent.check();

      await reach(page, via, 'search-creative-references', 'buscar referencias creativas', search, openPicker);
      const searched = page.waitForResponse(response => new URL(response.url()).pathname === `${generation}/sources` && new URL(response.url()).searchParams.get('query') === 'Referencia C6');
      await search.fill('Referencia C6');
      const searchResponse = await searched;
      expect(searchResponse.ok()).toBe(true);
      expect((await searchResponse.json()).sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'asset', id: references[0].id, version: references[0].version }),
        expect.objectContaining({ kind: 'product', id: product.id, version: product.version }),
      ]));
      await expect(referenceChoice(0)).not.toBeChecked();
      await expect(productChoice).not.toBeChecked();
      await expect(picker.getByRole('list', { name: 'Selección provisional' })).toHaveCount(0);
      await referenceChoice(0).check();
      await button(picker, 'Cancelar').click();
      await expect(review.getByRole('list', { name: 'Fotos seleccionadas para el envío' })).toHaveCount(0);
      await closeReview();
      await expect(consent).toBeChecked();

      await reach(page, via, 'choose-creative-references', 'aplicar referencias', apply, openPicker);
      await expect(referenceChoice(0)).not.toBeChecked();
      for (let index = 0; index < references.length; index++) await referenceChoice(index).check();
      await expect(picker).toContainText('4 de 4 fotos seleccionadas.');
      await expect(productChoice).toBeDisabled();
      for (let index = 1; index < references.length; index++) await referenceChoice(index).uncheck();
      await apply.click();
      await expect(review.getByRole('list', { name: 'Fotos seleccionadas para el envío' })).toContainText(`${references[0].name} · Versión ${references[0].version}`);
      await closeReview();
      await expect(consent).not.toBeChecked();
      await expect(sendIdea).toBeDisabled();

      await reach(page, via, 'review-generation-inputs', 'ver disponibilidad de OpenAI', review.getByRole('heading', { name: contextTitle, exact: true }), openReview);
      await exactStudio(thread.id);
      await expect(review).toContainText('Servicio de imágenes de OpenAI disponible.');
      await expect(review.getByRole('list', { name: 'Fotos seleccionadas para el envío' })).toContainText(references[0].name);
      await button(review, referencesTitle).click();
      await referenceChoice(0).uncheck();
      await apply.click();
      await expect(review.getByRole('list', { name: 'Fotos seleccionadas para el envío' })).toHaveCount(0);
      await closeReview();
      await expect(consent).not.toBeChecked();

      const progress = button(studio, 'Actualizar progreso');
      await reach(page, via, 'read-generation-progress', 'actualizar progreso de imagen', progress);
      await exactStudio(thread.id);
      expect((await getSocialCreativeThread(store, thread.id, user.id)).turns).toMatchObject([{ id: job.id, state: 'queued' }]);
      const transport = async (url, input) => {
        workerCalls.push([via, url, input.method]);
        assert.equal(url, 'https://api.openai.com/v1/images/generations');
        assert.equal(input.method, 'POST');
        throw new Error('Envío simulado sin recibo; no se hace ninguna solicitud de red.');
      };
      expect(await processSocialGenerationTurn(store, { env, transport })).toEqual({ processed: 1, hasMore: false });
      await Promise.all([
        page.waitForResponse(response => response.request().method() === 'GET'
          && new URL(response.url()).pathname === `${threads}/${thread.id}` && response.ok()),
        progress.click(),
      ]);
      expect((await getSocialCreativeThread(store, thread.id, user.id)).turns).toMatchObject([{ id: job.id, prompt: queuedPrompt, state: 'uncertain' }]);
      await expect(studio).toContainText('No se repetirá automáticamente.');
      expect(await processSocialGenerationTurn(store, { env, transport })).toEqual({ processed: 0, hasMore: false });
      await prompt.clear();

      await page.goto(`${studioPath}&studio=${adjustment.id}`);
      await button(studio, `Original · ${base.name}`).click();
      await expect(prompt).toHaveAttribute('placeholder', '¿Qué quieres ajustar?');
      await expect(studio.getByText('Opciones de formato', { exact: true })).toHaveCount(0);
      await prompt.fill('Aclara el fondo sin modificar el diseño central.');
      const sendAdjust = button(studio, 'Enviar ajuste');
      await reach(page, via, 'adjust-image', 'enviar ajuste', consent);
      await exactStudio(adjustment.id);
      await expect(consent).toHaveAttribute('data-advisor-control', 'ad-studio-consent-adjust');
      await expect(consent).not.toBeChecked();
      await expect(sendAdjust).toBeDisabled();
      await openReview();
      await expect(review).toContainText(`Imagen a modificar: ${base.name} · Versión ${base.version}`);
      await expect(review.getByRole('img', { name: 'Imagen a modificar' })).toHaveAttribute('src', new RegExp(`${base.id}/content\\?variant=reference&sha256=[a-f0-9]{64}$`));
      await button(review, referencesTitle).click();
      for (let index = 0; index < 3; index++) await referenceChoice(index).check();
      await expect(picker).toContainText('3 de 3 fotos seleccionadas.');
      await expect(referenceChoice(3)).toBeDisabled();
      await expect(picker.getByRole('checkbox', { name: new RegExp(base.name) })).toHaveCount(0);
      await button(picker, 'Cancelar').click();
      await closeReview();
      await expect(consent).not.toBeChecked();
      await expect(sendAdjust).toBeDisabled();
      await prompt.clear();
      const unchanged = await getSocialCreativeThread(store, adjustment.id, user.id);
      expect(unchanged.thread).toMatchObject({ id: attached.id, version: attached.version, selectedAsset: null, attachments: [{ id: base.id, version: base.version }] });
      expect(unchanged.turns).toEqual([]);
      notes.push({ via, studio: thread.id, job: job.id, progress: 'uncertain', adjustment: adjustment.id, references: [references[0].id, product.id] });
    });

    expect(external).toEqual([]);
    expect(socialWrites).toEqual([]);
    expect(workerCalls).toEqual(['panel', 'chat', 'directorio'].map(via => [via, 'https://api.openai.com/v1/images/generations', 'POST']));
    expect(fixture.requests.filter(request => !request.connectionCheck && request.protocol === 'responses').length).toBeGreaterThan(0);
    expect(await readFile(join(scratch, 'provider.jsonl'), 'utf8')).toBe('');
    expect(await store.db.all(`SELECT state FROM ${store.t('social_generation_jobs')}`)).toEqual(Array.from({ length: 3 }, () => ({ state: 'uncertain' })));
    expect(await store.db.all(`SELECT id FROM ${store.t('social_campaigns')}`)).toEqual([]);
    expect(await store.db.all(`SELECT id FROM ${store.t('social_deliveries')}`)).toEqual([]);
    expect(threadReads).toEqual(expect.arrayContaining(notes.map(({ studio }) => `${threads}/${studio}`)));
    await info.attach('controles creativos privados', { body: JSON.stringify({ viewport, observations: notes }, null, 2), contentType: 'application/json' });
  } finally {
    await browserContext?.close();
    await store?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    await fixture?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
