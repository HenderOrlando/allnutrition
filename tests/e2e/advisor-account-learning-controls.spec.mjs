import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { hash, insertRow } from '../../lib/business/commands.mjs';
import { getMetaAccountAnalysis, queueMetaAccountAnalysisTx } from '../../lib/business/social-account-analysis.mjs';
import { getSocialCampaign, getSocialConnection, saveSocialCampaign } from '../../lib/business/social.mjs';
import { createSocialAsset, getSocialAsset, processSocialAssetTurn, uploadSocialAsset } from '../../lib/business/social-media.mjs';
import { getSocialOffer } from '../../lib/business/social-offers.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';
import { HISTORY_SOURCES } from '../../lib/social/meta-account-history.mjs';
import { configureSocialTestRuntime } from '../social-runtime-fixture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), spec = fileURLToPath(import.meta.url);
const base = '/admin?section=advertising&tab=', api = '/api/admin/social';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const advisor = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const sourceUrl = HISTORY_SOURCES.health;
const learningText = 'Revisa el texto de la versión que alcanzó el criterio de esta prueba. Puedes partir de su enfoque, sin cambiar los hechos vigentes de la oferta.';

async function serve(scratch) {
  const config = pathToFileURL(join(root, 'next.config.mjs')).href;
  const transport = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  const distDir = relative(root, join(scratch, 'next'));
  registerHooks({ load(url, options, load) {
    if (url === config) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${config}?base`)}; export default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    if (url === transport) return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(`${transport}?base`)};
      import { installHekaBrowserTransport as install } from ${JSON.stringify(`${transport}?base`)};
      export function installHekaBrowserTransport(log, origin) { install(log, origin); globalThis.installAccountLearningBoundary(origin); }
    ` };
    return load(url, options);
  } });
  globalThis.installAccountLearningBoundary = origin => {
    delete globalThis.installAccountLearningBoundary;
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === 'https://registry.npmjs.org') return new Response(null, { status: 503 });
      if (url.origin !== origin && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        appendFileSync(join(scratch, 'provider-attempts.txt'), `${url.origin}\n`);
        assert.fail('El fixture no permite contactar proveedores reales.');
      }
      return fixtureFetch(input, init);
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function seed(store, env, actor) {
  const { runtime } = await configureSocialTestRuntime(store, { env, settings: { browserEnabled: false, publishingEnabled: false } });
  const selected = randomUUID(), decoy = randomUUID();
  const now = Date.now(), at = new Date(now - 8 * 86400000).toISOString(), previous = new Date(now - 9 * 86400000).toISOString();
  const identities = { userId: '516', pageId: '728' }, row = { version: 1, created_at: at, updated_at: at };
  for (const [id, name, created] of [[decoy, 'Conexión señuelo C6', previous], [selected, 'Conexión exacta C6', at]]) {
    await insertRow(store, 'social_connections', { id, provider: 'meta', integration_method: 'api', state: 'connected', ...row, created_at: created,
      data: JSON.stringify({ name, identities, sessionEpoch: 1, configurationFingerprint: runtime.fingerprint, capabilities: { facebookPublish: true, insights: true } }) });
    await saveCredentials(store, id, { accessToken: 'SYNTHETIC-C6-ACCOUNT-LEARNING', userId: identities.userId }, { runtime, env, sessionEpoch: 1 });
  }
  const baseline = await store.transaction(async tx => {
    await tx.lockWrites();
    return queueMetaAccountAnalysisTx(tx, await getSocialConnection(tx, selected), actor, { now: at });
  });
  // Historical record only; no worker or Graph transport is run. Keep canonical Meta rules on the snapshot.
  await store.db.run(`UPDATE ${store.t('social_account_analyses')} SET state='completed' WHERE id=?`, [baseline.id]);
  await store.db.run(`UPDATE ${store.t('job_runs')} SET state='succeeded' WHERE key=?`, [`social:account-analysis:${baseline.id}`]);

  const product = await store.save('products', { slug: 'c6-prueba-oferta', title: 'Oferta sintética C6', status: 'draft', orderable: true, price: 18000, stockQuantity: 10 }, null, null, actor);
  const { factsHash } = await getSocialOffer(store, 'product', product.id);
  const offerRef = { primary: { kind: 'product', id: product.id, factsHash }, gift: null };
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#67528a' } }).png().toBuffer();
  const upload = await createSocialAsset(store, { name: 'Imagen sintética C6', contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, actor, { env });
  await uploadSocialAsset(store, upload.id, { version: upload.version, contentType: 'image/png', contentLength: bytes.length, body: Readable.from([bytes]), requestId: randomUUID() }, actor, { env });
  expect(await processSocialAssetTurn(store, { env })).toMatchObject({ processed: 1 });
  const asset = await getSocialAsset(store, upload.id);
  const draft = (name, fields = {}) => saveSocialCampaign(store, { name, connectionId: selected, mode: 'organic', objective: 'engagement', caption: 'Texto sintético conservado',
    platforms: ['facebook'], placements: ['facebook_feed'], requestId: randomUUID(), ...fields }, actor, { now: previous });
  async function published(name, index, fields) {
    const { id, version } = await draft(name, { ...fields, assetId: asset.id, aiDisclosure: false }), item = await getSocialCampaign(store, id);
    const { mode, objective, caption, platforms, placements, offerHash } = item;
    const approved = { mode, objective, caption, platforms, placements, assetId: asset.id, assetHash: asset.sha256, assetType: 'image',
      ...(offerHash ? { offerHash } : {}), integrationMethod: 'api', connectionId: selected, identities };
    const specHash = hash(approved), remoteId = `${identities.pageId}_${100000 + index}`, permalink = `https://www.facebook.com/${identities.pageId}/posts/${100000 + index}`;
    await insertRow(store, 'social_revisions', { campaign_id: id, revision: 1, spec_hash: specHash, approved_at: at, actor_id: actor,
      data: JSON.stringify({ spec: approved, rightsAccepted: true, offerSnapshot: item.offerSnapshot }) });
    const deliveryId = randomUUID();
    await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: id, revision: 1, channel: 'facebook', state: 'published', remote_id: remoteId, next_sync_at: null, ...row,
      data: JSON.stringify({ remoteRefs: { postId: remoteId, permalink }, integrationMethod: 'api', publishedAt: at, lastConfirmedState: 'published', lastConfirmedAt: at }) });
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='published' WHERE id=?`, [id]);
    return { id, name, version, deliveryId, permalink };
  }
  const original = await published('Prueba original de oferta C6', 0, { offerRef });
  const recommendationId = randomUUID();
  await insertRow(store, 'social_recommendations', { id: recommendationId, campaign_id: original.id, evidence_hash: hash(original.id), rule_key: 'c6_comparable_copy', state: 'evaluated', ...row,
    data: JSON.stringify({ conclusion: 'improved', proposedChange: { type: 'copy', text: 'Hipótesis comprobada en la prueba C6' }, primaryEvidence: { channel: 'facebook' } }) });
  const mutable = await draft('Borrador con oferta C6', { offerRef });
  const empty = await draft('Sin oferta o entrega C6');
  const pieces = await Promise.all(['panel', 'chat', 'directorio'].map((name, index) => published(`Entrega C6 ${name}`, index + 1)));
  return { selected, decoy, baseline, original, recommendationId, mutable, empty, pieces };
}

async function openCapability(page, via, suffix, query) {
  await button(page.getByRole('banner'), 'Ali').click();
  let overlay = advisor(page), card;
  const find = scope => scope.locator(`[data-capability-id="advertising.${suffix}"]`);
  if (via === 'chat') {
    if (await button(overlay, 'Responder').count()) await button(overlay, '‹ Conversaciones').click();
    const prior = await find(overlay).count();
    await overlay.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
    await button(overlay, 'Enviar').click();
    await expect(find(overlay)).toHaveCount(prior + 1, { timeout: 30000 });
    card = find(overlay).last();
  } else {
    await button(overlay, '¿Qué quieres hacer?').click();
    overlay = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await overlay.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await button(overlay, 'Buscar').click();
    card = find(overlay);
  }
  await card.getByRole('button', { name: /^Abrir en el panel:/ }).click();
  return overlay;
}

if (process.argv[2] === '--serve-account-learning') await serve(process.argv[3]);
else test('Ali @advisor-c6: entregas, aprendizajes y lecturas históricas de la cuenta exacta', async ({ browser }, info) => {
  test.setTimeout(240000);
  const temp = join(root, '.test-data');
  await mkdir(temp, { recursive: true });
  const scratch = await mkdtemp(join(temp, 'heka-browser-'));
  const attempts = join(scratch, 'provider-attempts.txt');
  let server, context, store;
  try {
    await writeFile(attempts, '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-account-learning', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control'), SOCIAL_MEDIA_DIR: join(scratch, 'media'), APP_URL: origin };
    store = await openStore(env);
    const actor = (await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test'])).id;
    const records = await seed(store, env, actor);
    const { defaultBrowserType: _browser, ...device } = info.project.use;
    const viewport = info.project.name === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...device, baseURL: origin, viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const writes = [], unexpected = [], outbound = [], errors = [], observed = [];
    let allowedWrite, allowedHandoff;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        if (request.isNavigationRequest() && request.method() === 'GET' && url.href === allowedHandoff) {
          outbound.push(url.href); allowedHandoff = null;
          return route.fulfill({ status: 200, contentType: 'text/plain', body: 'Navegación interceptada por la prueba local; no se consultó Meta.' });
        }
        unexpected.push(url.href);
        return route.abort('blockedbyclient');
      }
      if (url.pathname.startsWith(`${api}/`) && !['GET', 'HEAD'].includes(request.method())) {
        const payload = request.postDataJSON();
        if (request.method() !== 'POST' || url.pathname !== allowedWrite?.path || payload.action !== allowedWrite?.action) {
          unexpected.push({ path: url.pathname, method: request.method(), payload });
          return route.abort('blockedbyclient');
        }
        writes.push({ path: url.pathname, payload }); allowedWrite = null;
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { unexpected.push(dialog.message()); await dialog.dismiss(); });
    const session = await context.request.post('/api/auth/login', { headers: { origin }, data: { email: 'e2e@example.test', password: 'clave-e2e-solo-pruebas' } });
    expect(session.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);
    const account = page.getByRole('region', { name: 'Análisis histórico de las cuentas Meta', exact: true });
    const connection = account.getByRole('combobox', { name: 'Conexión', exact: true });
    const results = page.getByRole('region', { name: 'Resultados de publicidad', exact: true });
    const disclosures = (scope, label) => scope.locator('summary').filter({ hasText: label });
    const rules = disclosures(account, 'Reglas actuales, evidencia y límites históricos');
    const analysisPath = `${api}/connections/${records.selected}/analysis`;
    const checkWidth = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    async function reach(via, suffix, query, target, panel) {
      const before = [writes.length, outbound.length];
      if (via === 'panel') await panel?.();
      else {
        const overlay = await openCapability(page, via, suffix, query);
        await expect(overlay).toHaveCount(0);
        await expect(advisor(page)).toHaveCount(0);
        await expect(target).toBeFocused();
        await expect(target).toHaveAttribute('data-advisor-arrival', '');
        await expect(target).toBeInViewport();
      }
      await expect(target).toBeVisible();
      expect([writes.length, outbound.length]).toEqual(before);
    }
    async function handoff(target, href) {
      await expect(target).toHaveAttribute('href', href);
      await expect(target).toHaveAttribute('target', '_blank');
      await expect(target).toHaveAttribute('rel', 'noopener noreferrer');
      const count = outbound.length;
      allowedHandoff = href;
      const [popup] = await Promise.all([page.waitForEvent('popup'), target.click()]);
      await expect(popup).toHaveURL(href);
      expect(outbound.slice(count)).toEqual([href]);
      await popup.close();
    }
    async function confirm(target, title, name, subject, path, action, code, fields) {
      const before = writes.length;
      const modal = page.getByRole('dialog', { name: title, exact: true });
      await target.click();
      await expect(modal).toBeVisible();
      await expect(modal).toContainText(subject);
      await expect(button(modal, 'Volver sin cambios')).toBeFocused();
      await button(modal, 'Volver sin cambios').click();
      await expect(modal).toHaveCount(0);
      expect(writes).toHaveLength(before);
      await target.click();
      const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path);
      allowedWrite = { path, action };
      await button(modal, name).click();
      const response = await pending, body = await response.json();
      expect(response.status(), JSON.stringify(body)).toBe(code);
      expect(writes).toHaveLength(before + 1);
      expect(writes.at(-1)).toEqual({ path, payload: { action, ...fields } });
      return body;
    }
    const select = async id => {
      await expect(connection.locator(`option[value="${id}"]`)).toHaveCount(1);
      const reading = page.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `${api}/connections/${id}/analysis`, { timeout: 30000 });
      await connection.selectOption(id);
      expect((await reading).status()).toBe(200);
      await expect(account).toHaveAttribute('data-account-analysis-connection', id);
    };

    let lastAnalysisId = records.baseline.id;
    for (const [index, via] of ['panel', 'chat', 'directorio'].entries()) await test.step(via, async () => {
      const piece = records.pieces[index], before = writes.length;
      await page.goto(`${base}campaigns&record=${piece.id}`);
      const preview = page.getByRole('img', { name: 'Vista previa de la pieza: Imagen sintética C6', exact: true });
      await preview.evaluate(image => image.decode());
      const publication = page.getByRole('link', { name: 'Ver en Meta', exact: true });
      await reach(via, 'open-meta-publication', 'ver publicación en Meta', publication);
      await handoff(publication, piece.permalink);
      await checkWidth();

      const draftPath = `${base}campaigns&record=${records.mutable.id}`;
      await page.goto(draftPath);
      const learning = page.getByRole('heading', { name: 'Qué aprendimos de una oferta igual', exact: true }), proof = button(page, 'Ver la prueba');
      await expect(proof).toBeVisible();
      await reach(via, 'read-offer-learning', 'ver prueba comparable', learning);
      await expect(page.getByText(learningText, { exact: true })).toBeVisible();
      await proof.click();
      await expect(page).toHaveURL(url => url.searchParams.get('record') === records.original.id && url.searchParams.get('tab') === 'results' && url.searchParams.get('resultsFocus') === 'learnings');
      await expect(results.getByText('Hipótesis comprobada en la prueba C6', { exact: true })).toBeVisible();
      await results.locator('img[alt="Vista previa de la pieza aprobada"]').evaluate(image => image.decode());
      await page.goto(draftPath);
      const reuse = button(page, 'Usar esta idea');
      await reach(via, 'reuse-learning-idea', 'usar esta idea', reuse);
      await reuse.click();
      await expect(page.getByText('Se añadió una orientación editable; no se cambió el texto ni la configuración.', { exact: true })).toBeVisible();
      await button(page, 'Cerrar estudio visual').click();
      const editable = page.getByRole('textbox', { name: 'Orientación editable para la próxima imagen' });
      await expect(editable).toHaveValue(learningText);
      await editable.fill(`${learningText}\nRevisar el encuadre localmente.`);
      await expect(page.getByRole('textbox', { name: 'Texto que acompaña la imagen o video' })).toHaveValue('Texto sintético conservado');
      expect(await getSocialCampaign(store, records.mutable.id)).toMatchObject({ state: 'draft', version: records.mutable.version, caption: 'Texto sintético conservado', deliveries: [] });
      await editable.fill('');
      expect(writes).toHaveLength(before);

      await page.goto(`${base}results&record=${piece.id}`);
      await expect(results.getByRole('heading', { name: piece.name, exact: true })).toBeVisible();
      const sync = button(results, 'Actualizar desde Meta'), campaignPath = `${api}/campaigns/${piece.id}/actions`;
      await reach(via, 'sync-results-from-meta', 'actualizar desde Meta', sync, () => disclosures(results, 'Operaciones de la entrega').click());
      const queued = await confirm(sync, 'Autorizar consulta de métricas a Meta', 'Autorizar consulta a Meta', piece.name, campaignPath, 'sync', 202, { version: piece.version, requestId: expect.any(String) });
      expect(queued).toMatchObject({ id: piece.id, requestedState: 'reading', deliveryIds: [piece.deliveryId], operationIds: [] });
      await expect(results.getByRole('status').filter({ hasText: 'Consulta a Meta encolada' })).toContainText('Esto no confirma publicación ni resultados nuevos.');
      const syncKey = `social:sync:${piece.deliveryId}`;
      expect(await store.db.get(`SELECT state FROM ${store.t('job_runs')} WHERE key=?`, [syncKey])).toEqual({ state: 'queued' });
      expect(await store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('social_measurements')} WHERE delivery_id=?`, [piece.deliveryId])).toEqual({ total: 0 });

      await page.goto(`${base}results`);
      await expect(connection).toHaveValue('');
      await expect(button(account, 'Cancelar lectura local')).toHaveCount(0);
      await select(records.selected);
      await expect(account).toHaveAttribute('data-account-analysis-state', index ? 'cancelled' : 'completed');
      await reach(via, 'open-meta-rules-source', 'fuente Meta', rules);
      await rules.click();
      await expect(account.getByText(/Fuentes revisadas: 2026-11-16/)).toBeVisible();
      await expect(account.getByText('Histórico: no verificable.', { exact: true })).toBeVisible();
      await handoff(account.getByRole('link', { name: /^Fuente Meta: Revisar claims de salud/ }), sourceUrl);
      const refresh = button(account, 'Actualizar análisis desde Meta');
      await reach(via, 'refresh-account-analysis', 'actualizar análisis de cuenta', refresh);
      const current = (await confirm(refresh, 'Autorizar una nueva lectura histórica', 'Autorizar consulta histórica a Meta', 'Conexión exacta C6', analysisPath, 'refresh', 202, {})).analysis;
      expect(current).toMatchObject({ connectionId: records.selected, state: 'queued' });
      expect(current.id).not.toBe(lastAnalysisId);
      lastAnalysisId = current.id;
      await expect(account).toHaveAttribute('data-account-analysis-state', 'queued');
      await expect(refresh).toBeDisabled();
      const cancel = button(account, 'Cancelar lectura local');
      await reach(via, 'cancel-account-analysis', 'cancelar lectura local', cancel);
      const cancelled = (await confirm(cancel, 'Confirmar cancelación de la lectura local', 'Confirmar cancelación local', current.id, analysisPath, 'cancel', 200, {})).analysis;
      expect(cancelled).toMatchObject({ id: current.id, connectionId: records.selected, state: 'cancelled', error: { code: 'cancelled_by_user' } });
      await expect(account.getByText('Análisis local cancelado; no se modificó Meta. (cancelled_by_user)', { exact: true })).toBeVisible();
      expect(await getMetaAccountAnalysis(store, records.decoy, {}, actor)).toMatchObject({ analysis: null });
      expect(await getSocialCampaign(store, piece.id)).toMatchObject({ state: 'published', version: piece.version, deliveries: [{ id: piece.deliveryId, state: 'published', remoteRefs: { permalink: piece.permalink } }], operations: [] });
      expect(writes).toHaveLength(before + 3);
      await checkWidth();
      observed.push({ via, publication: { id: piece.id, deliveryId: piece.deliveryId, href: piece.permalink, syncKey }, learning: { draftId: records.mutable.id, sourceId: records.original.id, recommendationId: records.recommendationId }, account: { connectionId: records.selected, analysisId: current.id, cancelling: cancelled.state, source: sourceUrl }, untouched: records.decoy });
    });

    const count = writes.length;
    await page.goto(`${base}campaigns&record=${records.empty.id}`);
    await reach('directorio', 'reuse-learning-idea', 'usar esta idea', page.getByText('Guarda una oferta vigente en este borrador para buscar una prueba comparable.', { exact: true }));
    await reach('directorio', 'open-meta-publication', 'ver publicación en Meta', page.getByText('Esta publicación no tiene un enlace permanente verificado en Meta.', { exact: true }));
    await page.goto(`${base}results&record=${records.empty.id}`);
    await reach('directorio', 'sync-results-from-meta', 'actualizar desde Meta', page.getByText('Esta publicación no tiene entregas para consultar en Meta.', { exact: true }));
    await page.goto(`${base}results`);
    await select(records.decoy);
    await reach('directorio', 'cancel-account-analysis', 'cancelar lectura local', account.getByText('No hay una lectura histórica en curso para esta conexión.', { exact: true }));
    await reach('directorio', 'open-meta-rules-source', 'fuente Meta', account.getByText('Esta conexión aún no tiene una lectura guardada con fuentes de Meta.', { exact: true }));
    expect(writes).toHaveLength(count);
    expect(outbound).toHaveLength(6);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(await readFile(attempts, 'utf8')).toEqual('');
    const evidencePath = info.outputPath('evidencia.json');
    await writeFile(evidencePath, JSON.stringify({ viewport, observed }, null, 2));
    await info.attach('entregas, aprendizajes y lecturas exactas', { path: evidencePath, contentType: 'application/json' });
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
