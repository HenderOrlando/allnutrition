import { expect, test, devices } from '@playwright/test';
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { login } from './helpers.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { createSocialAsset, getSocialAsset, processSocialAssetTurn, uploadSocialAsset } from '../../lib/business/social-media.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runner = fileURLToPath(new URL('../heka-browser.mjs', import.meta.url));
const library = '/admin?section=advertising&tab=assets';
const assets = '/api/admin/social/assets';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const ali = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const hash = data => createHash('sha256').update(data).digest('hex');

async function ask(chat, message) {
  await chat.getByLabel('Mensaje para Ali').fill(message);
  await button(chat, 'Enviar').click();
}

async function reach(page, via, capability, query, target) {
  if (via !== 'panel') {
    await button(page.getByRole('banner'), 'Ali').click();
    let overlay = ali(page);
    const find = scope => scope.locator(`[data-capability-id="advertising.${capability}"]`);
    let card;
    if (via === 'chat') {
      if (await button(overlay, 'Responder').count()) await button(overlay, '‹ Conversaciones').click();
      const count = await find(overlay).count();
      await ask(overlay, `¿Dónde encuentro ${query}?`);
      await expect(find(overlay)).toHaveCount(count + 1);
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
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

test('Ali @advisor-c6: original privado, nombre editable y reintento íntegro en la biblioteca', async ({ browser }, info) => {
  test.setTimeout(180000);
  const tmp = join(root, '.test-data');
  await mkdir(tmp, { recursive: true });
  const scratch = await mkdtemp(join(tmp, 'heka-browser-'));
  const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), SOCIAL_MEDIA_DIR: join(scratch, 'media') };
  let server, context, anonymous, store;
  try {
    await writeFile(join(scratch, 'provider.jsonl'), '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(runner, ['--serve', scratch], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    const mobile = info.project.name === 'mobile';
    const viewport = mobile ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    anonymous = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true });
    const external = [], writes = [], originalGets = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      external.push(url.origin);
      return route.abort();
    });
    context.on('request', req => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/api/admin/social/') && !['GET', 'HEAD'].includes(req.method())) writes.push(`${req.method()} ${url.pathname}`);
      if (req.method() === 'GET' && url.searchParams.get('variant') === 'original') originalGets.push(url.pathname);
    });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await login(page);
    expect(page.viewportSize()).toEqual(viewport);
    store = await openStore(env);
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const rows = () => store.db.all(`SELECT * FROM ${store.t('social_assets')} ORDER BY id`);
    const jobs = () => store.db.all(`SELECT * FROM ${store.t('job_runs')} WHERE key LIKE 'social:asset:%' ORDER BY key`);
    const notes = [];
    let choosers = 0;
    page.on('filechooser', () => { choosers++; });
    const fixture = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#336688' } }).png().toBuffer();
    const originalSha256 = hash(fixture);
    const tampered = Buffer.from(fixture);
    tampered[tampered.length - 1] ^= 1;

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      // Seed only disposable bytes through the real private custody and processor, without an HTTP upload.
      const filename = `C6 imagen sintética 80x40 ${via}`;
      const reserved = await createSocialAsset(store, { name: filename, contentType: 'image/png', expectedBytes: fixture.length, requestId: randomUUID() }, actor.id, { env });
      await uploadSocialAsset(store, reserved.id, { requestId: randomUUID(), version: reserved.version, contentType: 'image/png', contentLength: fixture.length, body: Readable.from([fixture]) }, actor.id, { env });
      expect(await processSocialAssetTurn(store, { env })).toMatchObject({ processed: 1, errorCode: 'IMAGE_GEOMETRY' });
      const asset = await getSocialAsset(store, reserved.id);
      expect(asset).toMatchObject({ name: filename, state: 'failed', originalBytes: fixture.length, originalSha256, diagnostic: { code: 'IMAGE_GEOMETRY' } });
      expect(asset.derivativeSha256).toBeUndefined();
      const beforeRows = await rows(), beforeJobs = await jobs();
      const key = `social:asset:${asset.id}`, failedJob = beforeJobs.find(job => job.key === key);
      expect(failedJob).toMatchObject({ state: 'failed', error_code: 'IMAGE_GEOMETRY' });
      const writeOffset = writes.length;
      const path = `${assets}/${asset.id}`, original = `${path}/content?variant=original`;
      const detail = page.getByRole('region', { name: 'Ficha del archivo', exact: true });
      const target = name => page.locator(`[data-advisor-control="advertising-asset-${name}"]`);
      const selectRecord = async () => {
        await page.goto(library);
        const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: filename, exact: true }) });
        await button(card, 'Ver archivo').click();
        await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'assets' && url.searchParams.get('record') === asset.id);
        await expect(detail.getByText('No se pudo preparar', { exact: true })).toBeVisible();
      };
      const unchanged = async () => {
        expect(await rows()).toEqual(beforeRows);
        expect(await jobs()).toEqual(beforeJobs);
        expect(writes.slice(writeOffset)).toEqual([]);
      };

      await test.step('advertising.open-original-asset: el enlace privado entrega los bytes exactos', async () => {
        const anonymousResult = await anonymous.request.get(original);
        expect(anonymousResult.status()).toBe(401);
        await selectRecord();
        const link = target('original');
        if (via === 'panel') await detail.locator('summary').filter({ hasText: /^Detalles técnicos del archivo$/ }).click();
        const beforeGet = originalGets.length;
        await reach(page, via, 'open-original-asset', 'abrir original privado', link);
        expect(originalGets).toHaveLength(beforeGet);
        await expect(link).toHaveAttribute('href', original);
        const delivered = context.waitForEvent('response', response => response.url() === `${origin}${original}` && response.request().method() === 'GET');
        const opened = page.waitForEvent('popup');
        await link.click();
        const response = await delivered, popup = await opened;
        try {
          expect(response.status()).toBe(200);
          expect(await response.headerValue('content-type')).toBe('image/png');
          expect(await response.headerValue('cache-control')).toBe('private,no-store');
          expect(await response.headerValue('etag')).toBe(`"${originalSha256}"`);
          expect(await response.body()).toEqual(fixture);
        } finally { await popup.close(); }
        expect(originalGets.slice(beforeGet)).toEqual([`${path}/content`]);
        await unchanged();
        notes.push({ via, id: 'advertising.open-original-asset', assetId: asset.id, original, mime: 'image/png', dimensions: '80×40', bytes: fixture.length, sha256: originalSha256, authenticated: 200, anonymous: anonymousResult.status() });
      });

      await test.step('advertising.assist-asset-name: propuesta y edición en el formulario, sin archivo ni carga', async () => {
        await page.goto(library);
        const upload = page.getByRole('dialog', { name: 'Subir archivo privado', exact: true });
        await expect(upload).toHaveCount(0);
        if (via === 'panel') await button(page, 'Subir archivo privado').click();
        const help = target('assist-name');
        await reach(page, via, 'assist-asset-name', 'ayúdame con el nombre', help);
        const field = upload.getByRole('textbox', { name: 'Nombre para encontrarlo después', exact: true });
        const submit = button(upload, 'Subir archivo');
        await expect(field).toHaveValue('');
        await expect(submit).toBeDisabled();
        await help.click();
        const chat = ali(page), proposed = `Color azul de prueba ${via}`;
        await ask(chat, `Completa el nombre con «${proposed}».`);
        const proposal = chat.getByRole('region', { name: 'Propuesta de cambio', exact: true }).filter({ hasText: proposed });
        await expect(proposal.locator('ins')).toHaveText([proposed], { timeout: 30000 });
        await expect(proposal).toContainText('Destino: asset-metadata');
        await expect(button(proposal, 'Confirmar cambio / recuperar')).toHaveCount(0);
        await button(proposal, 'Aplicar valores').click();
        await expect(chat).toHaveCount(0);
        await expect(field).toHaveValue(proposed);
        const edited = `${proposed} editado`;
        await field.fill(edited);
        await expect(field).toHaveValue(edited);
        await expect(upload.getByText('Ningún archivo seleccionado', { exact: true })).toBeVisible();
        await expect(submit).toBeDisabled();
        expect(choosers).toBe(0);
        await unchanged();
        page.once('dialog', dialog => dialog.accept());
        await button(upload, 'Cerrar carga').click();
        await expect(upload).toHaveCount(0);
        notes.push({ via, id: 'advertising.assist-asset-name', proposed, edited, fileChosen: false, assetWrites: 0 });
      });

      await test.step('advertising.retry-asset-processing: 409 con hash distinto; misma pieza reencolada con original íntegro', async () => {
        await selectRecord();
        const retry = target('retry');
        await reach(page, via, 'retry-asset-processing', 'reintentar procesamiento', retry);
        await unchanged();
        const originalPath = join(env.SOCIAL_MEDIA_DIR, asset.originalKey);
        expect(await readFile(originalPath)).toEqual(fixture);
        await writeFile(originalPath, tampered);
        const tapRetry = async () => {
          const result = page.waitForResponse(response => response.url() === `${origin}${path}/actions` && response.request().method() === 'POST');
          await retry.click();
          const response = await result;
          expect(response.request().postDataJSON()).toEqual({ action: 'retry-processing', version: asset.version, requestId: expect.any(String) });
          return response;
        };
        const blocked = await tapRetry();
        expect(blocked.status()).toBe(409);
        await expect(detail.getByRole('alert')).toContainText('no tiene un original íntegro');
        expect(await rows()).toEqual(beforeRows);
        expect(await jobs()).toEqual(beforeJobs);
        await writeFile(originalPath, fixture);
        const queued = await tapRetry();
        expect(queued.status()).toBe(200);
        expect(await queued.json()).toMatchObject({ id: asset.id, state: 'processing', version: asset.version + 1, originalSha256, originalBytes: fixture.length });
        await expect(detail.getByText('Preparando imagen o video', { exact: true })).toBeVisible();
        await expect(detail.getByText('Procesamiento encolado. Espera a que el archivo esté listo para revisar.', { exact: true })).toBeVisible();
        await expect(detail.getByText('Lista para revisar', { exact: true })).toHaveCount(0);
        await expect(retry).toHaveCount(0);
        expect(await rows()).toHaveLength(beforeRows.length);
        const persisted = await getSocialAsset(store, asset.id);
        expect(persisted).toMatchObject({ id: asset.id, state: 'processing', version: asset.version + 1, originalSha256, originalBytes: fixture.length });
        expect(persisted.derivativeSha256).toBeUndefined();
        const queuedJobs = await jobs(), job = queuedJobs.find(item => item.key === key);
        expect(queuedJobs.filter(item => item.key !== key)).toEqual(beforeJobs.filter(item => item.key !== key));
        expect(job).toMatchObject({ state: 'queued', version: failedJob.version + 1, error_code: null });
        expect(JSON.parse(job.data)).toMatchObject({ assetId: asset.id, phase: 'processing' });
        expect(await readFile(originalPath)).toEqual(fixture);
        expect(writes.slice(writeOffset)).toEqual([`POST ${path}/actions`, `POST ${path}/actions`]);
        notes.push({ via, id: 'advertising.retry-asset-processing', assetId: asset.id, originalSha256, sentVersion: asset.version, savedVersion: persisted.version, corruptOriginal: blocked.status(), intactOriginal: queued.status(), jobKey: job.key, jobState: job.state, displayState: persisted.state, derivative: null });
        // Drain our queued synthetic failure through the real processor before seeding the next route.
        expect(await processSocialAssetTurn(store, { env })).toMatchObject({ processed: 1, errorCode: 'IMAGE_GEOMETRY' });
      });
    });
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(await readFile(join(scratch, 'provider.jsonl'), 'utf8')).toBe('');
    await info.attach('controles de biblioteca privada', { body: JSON.stringify({ viewport, observations: notes }, null, 2), contentType: 'application/json' });
  } finally {
    await store?.close();
    await anonymous?.close();
    await context?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
