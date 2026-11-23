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
import { entity, hash, insertRow } from '../../lib/business/commands.mjs';
import { DAY, exactMetric, improvementMeasurement, patchData } from '../social-improvements-fixture.mjs';
import { openStore } from '../../lib/db/index.mjs';
import { getSocialCampaign, saveSocialCampaign } from '../../lib/business/social.mjs';
import { buildSocialHistoricalForecast, SOCIAL_ANALYSIS_VERSION } from '../../lib/business/social-analysis.mjs';
import { processSocialAnalysisTurn } from '../../lib/business/social-analysis-jobs.mjs';
import { socialMeasurementQueryKey } from '../../lib/social/evidence.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), spec = fileURLToPath(import.meta.url);
const social = '/api/admin/social', resultsPage = '/admin?section=advertising&tab=results';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const control = (scope, name) => scope.locator(`[data-advisor-control="ad-results-${name}"]`);
const ali = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const recommendations = 'Evidencia y acciones de las recomendaciones';
const learnings = 'Historial de pruebas y aprendizajes';
const reasonLabel = 'Motivo de la rectificación o decisión *';
const choiceCapture = 'Elige la captura citada exacta';
const choiceDismiss = 'Elige qué recomendación descartar';
const disclosure = (scope, name) => scope.locator('summary').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });

async function openDisclosure(scope, name) {
  const summary = disclosure(scope, name);
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
}

async function serveResults(scratch) {
  const config = pathToFileURL(join(root, 'next.config.mjs')).href;
  const transport = new URL('../heka-browser-transport.mjs', import.meta.url).href;
  const distDir = relative(root, join(scratch, 'next'));
  registerHooks({ load(url, options, load) {
    if (url === config) return { format: 'module', shortCircuit: true, source: `import config from ${JSON.stringify(`${config}?base`)}; export default { ...config, distDir: ${JSON.stringify(distDir)} };` };
    if (url === transport) return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(`${transport}?base`)};
      import { installHekaBrowserTransport as install } from ${JSON.stringify(`${transport}?base`)};
      export function installHekaBrowserTransport(log, origin) { install(log, origin); globalThis.installResultsBoundary(origin); }
    ` };
    return load(url, options);
  } });
  globalThis.installResultsBoundary = origin => {
    delete globalThis.installResultsBoundary;
    const closedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      // Next dev checks its installed version; this test never needs the registry.
      if (url.origin === 'https://registry.npmjs.org') return new Response(null, { status: 503 });
      if (url.origin !== origin && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        appendFileSync(join(scratch, 'provider-attempts.txt'), `${url.origin}\n`);
        assert.fail('La prueba de resultados no permite contactar integraciones externas.');
      }
      return closedFetch(input, init);
    };
  };
  process.argv.splice(2, 2, '--serve', scratch, '--empty-business');
  await import('../heka-browser.mjs');
}

async function fixtures(store, actor) {
  const cut = new Date(Date.now() - 1000).toISOString(), start = new Date(Date.now() - 8 * DAY).toISOString();
  const common = { version: 1, created_at: start, updated_at: cut };
  const connectionId = randomUUID(), assetId = randomUUID(), assetHash = 'a'.repeat(64);
  const identities = { userId: '100', businessId: '500', pageId: '200' };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected',
    data: JSON.stringify({ name: 'Conexión privada de ensayo', identities, capabilities: { facebookPublish: true } }), ...common });
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: assetHash, bytes: 100,
    data: JSON.stringify({ name: 'Imagen de evidencia sintética', kind: 'image', derivativeSha256: assetHash }), ...common });
  const businessRevision = Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);
  async function piece(name, { metrics = [11], suggested = [], historical = [] } = {}) {
    const draft = await saveSocialCampaign(store, { name, connectionId, assetId, mode: 'organic', objective: 'engagement', caption: 'Texto sintético aprobado', marketCountries: ['CO'],
      platforms: ['facebook'], placements: ['facebook_feed'], publishAt: start, aiDisclosure: false, requestId: randomUUID() }, actor, { now: new Date(Date.parse(start) - DAY).toISOString() });
    const id = draft.id, campaign = await getSocialCampaign(store, id), fields = ['name', 'mode', 'objective', 'connectionId', 'assetId', 'caption', 'headline', 'destinationUrl', 'whatsappNumber', 'whatsappGreeting', 'marketCountries', 'platforms', 'placements', 'audience', 'budgetMinor', 'currency', 'publishAt', 'startAt', 'endAt', 'observationDays', 'targetCostMinor', 'aiDisclosure', 'integrationMethod', 'identities', 'timeZone'];
    const spec = { ...Object.fromEntries(fields.filter(key => campaign[key] !== undefined).map(key => [key, campaign[key]])), assetHash, assetType: 'image' };
    const specHash = hash(spec), forecastId = randomUUID();
    const forecast = { ...buildSocialHistoricalForecast(spec, [], { asOf: start }), specHash, generatedAt: start };
    await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: id, spec_hash: specHash, generated_at: start, data: JSON.stringify(forecast) });
    await insertRow(store, 'social_revisions', { campaign_id: id, revision: 1, spec_hash: specHash, approved_at: start, actor_id: actor,
      data: JSON.stringify({ spec, forecastId, forecast, rightsAccepted: true }) });
    const deliveryId = randomUUID(), object = BigInt(`0x${deliveryId.replaceAll('-', '')}`).toString().slice(0, 16), remoteId = `200_${object}`;
    const delivery = { id: deliveryId, channel: 'facebook', remoteId, remoteRefs: { postId: remoteId, photoId: object }, integrationMethod: 'api',
      state: 'published', publishedAt: start, publicationTimeSource: 'publication_request_sent_at' };
    await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: id, revision: 1, channel: 'facebook', state: 'published', remote_id: remoteId, next_sync_at: null, data: JSON.stringify(delivery), ...common });
    await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: id, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:publish`, step: 'publish', state: 'confirmed', next_attempt_at: null,
      data: JSON.stringify({ actorId: actor, specHash, integrationMethod: 'api', channel: 'facebook', result: { evidence: { remoteRead: true } } }), ...common });
    const captureIds = [];
    for (const [index, interactions] of metrics.entries()) {
      const fetchedAt = new Date(Date.parse(cut) - (metrics.length - index) * 1000).toISOString();
      const { id: captureId, deliveryId: _delivery, fetchedAt: fetched, payloadHash, ...data } = improvementMeasurement(spec, delivery, {
        id: randomUUID(), now: cut, fetchedAt, values: { interactions: exactMetric(interactions, 'fixture_post_interactions') },
      });
      await insertRow(store, 'social_measurements', { id: captureId, delivery_id: deliveryId, query_key: socialMeasurementQueryKey(data), fetched_at: fetched, payload_hash: payloadHash, data: JSON.stringify(data) });
      captureIds.push(captureId);
    }
    const evidenceHash = hash([id, cut]);
    const records = [];
    for (const [index, input] of [...suggested, ...historical].entries()) {
      const recommendationId = randomUUID(), historical = index >= suggested.length;
      const { text, type = 'copy', metricIds = [], sampleIds = [], childCampaignId } = input;
      const created_at = new Date(Date.parse(cut) - index).toISOString();
      await insertRow(store, 'social_recommendations', { id: recommendationId, campaign_id: id, evidence_hash: evidenceHash, rule_key: `fixture_${index}`,
        state: historical ? 'applied' : 'suggested', version: 1, created_at, updated_at: cut,
        data: JSON.stringify({ proposedChange: { type, text }, observation: `Observación de ${text}`, hypothesis: `Hipótesis de ${text}`, primaryEvidence: { channel: 'facebook', metric: 'organicResponse' },
          successCriterion: { text: 'Aumentar interacciones al mismo horizonte', metric: 'organicResponse', operator: 'gt', target: 0.1 },
          metricIds: metricIds.map(index => captureIds[index]), sampleIds, childCampaignId }) });
      records.push({ id: recommendationId, text, evidenceHash });
    }
    if (records.length) await patchData(store, 'social_campaigns', id, { analysis: { analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash, businessRevision, asOf: cut,
      checkedAt: cut, measurementCount: metrics.length, recommendationIds: records.map(item => item.id), linkVersions: { orders: [], expenses: [] } } });
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='published' WHERE id=?`, [id]);
    return { id, name, version: draft.version, captureIds, records, deliveryId, specHash };
  }
  return piece;
}

async function openCapability(page, via, suffix, query, launch = () => button(page.getByRole('banner'), 'Ali').click()) {
  await launch();
  let overlay = ali(page), card;
  const find = scope => scope.locator(`[data-capability-id="advertising.${suffix}"]`);
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
  return overlay;
}

async function reach(page, via, suffix, query, target, panel, launch) {
  if (via === 'panel') await panel?.();
  else {
    const overlay = await openCapability(page, via, suffix, query, launch);
    await expect(overlay).toHaveCount(0);
    await expect(ali(page)).toHaveCount(0);
    await expect(target).toBeFocused();
    await expect(target).toHaveAttribute('data-advisor-arrival', '');
    await expect(target).toBeInViewport();
  }
  await expect(target).toBeVisible();
}

if (process.argv[2] === '--serve-result-recommendations') await serveResults(process.argv[3]);
else test('Ali @advisor-c6: análisis, evidencia y decisiones privadas de resultados', async ({ browser }, info) => {
  test.setTimeout(240000);
  const temp = join(root, '.test-data');
  await mkdir(temp, { recursive: true });
  const scratch = await mkdtemp(join(temp, 'heka-browser-'));
  const attempts = join(scratch, 'provider-attempts.txt');
  let server, context, store;
  try {
    await writeFile(attempts, '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-result-recommendations', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite') });
    const actor = (await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test'])).id;
    const piece = await fixtures(store, actor);
    const { defaultBrowserType: _browser, ...device } = info.project.use;
    const viewport = info.project.name === 'mobile' ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...device, baseURL: origin, viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const writes = [], unexpected = [], external = [], errors = [], observations = [];
    let permitted = null;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
      if (url.pathname.startsWith(`${social}/`) && !['GET', 'HEAD'].includes(request.method())) {
        const payload = request.postDataJSON();
        if (request.method() !== (permitted?.method||'POST') || url.pathname !== permitted?.path || payload.action !== permitted?.action) {
          unexpected.push({ path: url.pathname, method: request.method(), payload });
          return route.abort('blockedbyclient');
        }
        permitted = null;
        writes.push({ path: url.pathname, payload });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const session=await context.request.post('/api/auth/login',{headers:{origin},data:{email:'e2e@example.test',password:'clave-e2e-solo-pruebas'}});
    expect(session.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);
    const results = page.getByRole('region', { name: 'Resultados de publicidad', exact: true });
    const go = async item => {
      await page.goto(`${resultsPage}&record=${item.id}`);
      await expect(results.getByRole('heading', { name: item.name, exact: true })).toBeVisible();
    };
    const isRecord = (url, id, tab = 'results') => url.searchParams.get('section') === 'advertising' && url.searchParams.get('tab') === tab && url.searchParams.get('record') === id;
    const post = async (path, action, target, status, fields) => {
      expect(permitted).toBeNull();
      permitted = { path, action };
      const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path);
      await target.click();
      const response = await pending, body = await response.json();
      expect(response.status(), JSON.stringify(body)).toBe(status);
      expect(writes.at(-1)).toEqual({ path, payload: { action, ...fields, requestId: expect.any(String) } });
      return body;
    };
    const recommendation = async id => entity(await store.db.get(`SELECT * FROM ${store.t('social_recommendations')} WHERE id=?`, [id]));
    const outcome = id => store.db.get(`SELECT state,data FROM ${store.t('job_runs')} WHERE key=?`, [`social:analysis:${id}`]);
    const checkDraft = async (id, source, record) => {
      await expect(page).toHaveURL(url => isRecord(url, id, 'campaigns'));
      const draft = await getSocialCampaign(store, id);
      expect(draft).toMatchObject({ state: 'draft', parentCampaignId: source.id, sourceRecommendationId: record.id, revisions: [], deliveries: [], operations: [], forecasts: [] });
      expect(draft.analysis).toBeUndefined();
      return draft;
    };

    await page.goto(resultsPage);
    await expect(results.getByRole('heading', { name: 'Elige una publicación o campaña', exact: true })).toBeVisible();
    await openCapability(page, 'directorio', 'analyze-local-results', 'revisar mejoras');
    await expect(page.getByText('Abre la campaña exacta en Resultados antes de revisar su análisis o sus recomendaciones.', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);

    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const analysis = await piece(`Evaluación local ${via}`);
      const sample = await piece(`Muestra comparable ${via}`, { metrics: [73] });
      const variant = await piece(`Original de variante ${via}`, { metrics: [0, 17],
        suggested: [{ text: `Probar nueva llamada ${via}`, metricIds: [0, 1] }],
        historical: [{ text: `Prueba comparable ${via}`, sampleIds: [sample.id], childCampaignId: sample.id }] });
      const same = await piece(`Original de cambio local ${via}`, { suggested: [{ text: `Probar un texto ${via}`, metricIds: [0] }] });
      const dismissal = await piece(`Original de descarte ${via}`, { suggested: [
        { text: `Conservar propuesta ${via}`, type: 'measurement' }, { text: `Descartar propuesta ${via}` },
      ] });
      const offset = writes.length;
      const showRecommendations = () => openDisclosure(results, recommendations);
      const showLearnings = () => openDisclosure(results, learnings);

      await go(analysis);
      await reach(page, via, 'analyze-local-results', 'revisar mejoras', button(results, 'Revisar mejoras'), showRecommendations);
      expect(await outcome(analysis.id)).toBeNull();
      expect(writes).toHaveLength(offset);
      const queued = await post(`${social}/campaigns/${analysis.id}/actions`, 'analyze', button(results, 'Revisar mejoras'), 202, { version: analysis.version });
      const jobKey = `social:analysis:${analysis.id}`;
      expect(queued).toMatchObject({ id: analysis.id, analysisJob: { key: jobKey, state: 'queued', generation: 1 } });
      await expect(results.getByText(/Análisis local encolado/)).toBeVisible();
      const queuedRow = await outcome(analysis.id);
      expect(queuedRow.state).toBe('queued');
      expect(JSON.parse(queuedRow.data)).toMatchObject({ id: analysis.id, requestedBy: actor, generation: 1 });
      expect(await processSocialAnalysisTurn(store)).toMatchObject({ processed: 1, results: [{ campaignId: analysis.id, state: 'succeeded' }] });
      await expect(button(results, 'Actualizar vista')).toBeEnabled();
      const refreshed = page.waitForResponse(item => item.request().method() === 'GET' && new URL(item.url()).pathname === `${social}/results` && new URL(item.url()).searchParams.get('campaignId') === analysis.id);
      await button(results, 'Actualizar vista').click();
      const persisted = await (await refreshed).json();
      expect(persisted.analysis).toMatchObject({ status: 'current', measurementCount: 1, job: { key: jobKey, state: 'succeeded', lastProcessedGeneration: 1 } });
      expect(JSON.parse((await outcome(analysis.id)).data).lastResult.evidenceHash).toBe(persisted.analysis.evidenceHash);

      await go(variant);
      await openDisclosure(results, 'Más filtros de resultados');
      await results.getByRole('combobox', { name: 'Tipo de resultados', exact: true }).selectOption('paid');
      await expect(page).toHaveURL(url => isRecord(url, variant.id) && url.searchParams.get('scope') === 'paid');
      await openDisclosure(results, 'Métricas completas, capturas y estado por destino');
      await expect(results.getByRole('heading', { name: 'Sin capturas en esta selección', exact: true })).toBeVisible();
      const captureChoice = results.getByRole('heading', { name: choiceCapture, exact: true });
      await reach(page, via, 'open-cited-capture', 'captura exacta del análisis', captureChoice, showRecommendations);
      expect(writes).toHaveLength(offset + 1);
      await expect(page.getByRole('dialog', { name: 'Captura exacta del análisis' })).toHaveCount(0);
      const [variantRec] = variant.records, captureId = variant.captureIds[1];
      const evidenceRead = page.waitForResponse(item => new URL(item.url()).pathname === `${social}/recommendations/${variantRec.id}/evidence`);
      await button(results, 'Abrir captura citada 2').click();
      const captured = await evidenceRead;
      expect(captured.status()).toBe(200);
      expect(Object.fromEntries(new URL(captured.url()).searchParams)).toEqual({ campaignId: variant.id, evidenceHash: variantRec.evidenceHash, captureId });
      expect(await captured.json()).toMatchObject({ delivery: { id: variant.deliveryId, campaignId: variant.id }, measurement: { id: captureId, values: { interactions: { value: 17 } } } });
      const captureDialog = page.getByRole('dialog', { name: 'Captura exacta del análisis', exact: true });
      await expect(captureDialog.getByText('Lectura conservada, independiente de los filtros de la ficha.', { exact: true })).toBeVisible();
      await openDisclosure(captureDialog, 'Fechas, cobertura y evidencia de la captura');
      await expect(captureDialog.getByText(captureId, { exact: true })).toBeVisible();
      await button(captureDialog, 'Cerrar captura').click();
      await expect(page).toHaveURL(url => isRecord(url, variant.id) && url.searchParams.get('scope') === 'paid');

      // Reload the exact record to start with both recommendation disclosures collapsed.
      await go(variant);
      const openSample = button(results, `Abrir publicación de muestra ${sample.id}`);
      await reach(page, via, 'open-comparable-campaign', 'ver muestra comparable', openSample, async () => {
        await showRecommendations();
        await openDisclosure(results, 'Ver las demás (1)');
        await openDisclosure(results.getByRole('article').filter({ hasText: variant.records[1].text }), 'Hipótesis y limitaciones');
      });
      await openSample.click();
      await expect(page).toHaveURL(url => isRecord(url, sample.id));
      await expect(results.getByRole('heading', { name: sample.name, exact: true })).toBeVisible();
      const original = button(results, 'Ver pieza original');
      await reach(page, via, 'open-comparable-campaign', 'abrir la pieza de muestra', original, showLearnings);
      await original.click();
      await expect(page).toHaveURL(url => isRecord(url, variant.id));
      await expect(results.getByRole('heading', { name: variant.name, exact: true })).toBeVisible();
      expect(writes).toHaveLength(offset + 1);

      const newVariant = button(results, 'Preparar una variante');
      await reach(page, via, 'create-recommended-variant', 'preparar una variante', newVariant, showRecommendations);
      await newVariant.click();
      const variantDialog = page.getByRole('dialog', { name: 'Preparar una variante', exact: true });
      await expect(variantDialog.getByText(`Idea: ${variantRec.text}`, { exact: true })).toBeVisible();
      await expect(variantDialog.getByText(/sin copiar fechas, aprobación, autorizaciones de gasto/)).toBeVisible();
      const variantAck = variantDialog.getByRole('checkbox');
      await expect(variantAck).not.toBeChecked();
      await button(variantDialog, 'Crear variante').click();
      expect(writes).toHaveLength(offset + 1);
      await variantAck.check();
      const created = await post(`${social}/recommendations/${variantRec.id}/actions`, 'duplicate-from-recommendation', button(variantDialog, 'Crear variante'), 201,
        { version: 1, evidenceHash: variantRec.evidenceHash });
      const variantDraft = await checkDraft(created.id, variant, variantRec);
      expect(variantDraft).toMatchObject({ caption: 'Texto sintético aprobado', publishAt: null, startAt: null, endAt: null, budgetMinor: 0,
        recommendationInstructions: { changeType: 'copy', needsConfirmation: true, text: variantRec.text } });
      expect(await recommendation(variantRec.id)).toMatchObject({ state: 'applied', version: 2, childCampaignId: created.id });

      await go(same);
      const singleCapture = button(results, 'Abrir captura citada');
      if (via !== 'panel') {
        await reach(page, via, 'open-cited-capture', 'captura exacta del análisis', singleCapture);
        expect(writes).toHaveLength(offset + 2);
      }
      const prepare = button(results, 'Cambiar aquí · solo Facebook');
      await reach(page, via, 'prepare-in-place-change', 'preparar cambio en la misma pieza', prepare, showRecommendations);
      await prepare.click();
      const [sameRec] = same.records;
      const sameDialog = page.getByRole('dialog', { name: 'Revisar cambio en la misma pieza', exact: true });
      await expect(sameDialog.getByText(`Propuesta: ${sameRec.text}`, { exact: true })).toBeVisible();
      await expect(sameDialog.getByText(/^Destino: Facebook\. Solo cambiará el texto/)).toBeVisible();
      const sameAck = sameDialog.getByRole('checkbox');
      await expect(sameAck).not.toBeChecked();
      await button(sameDialog, 'Preparar cambio').click();
      expect(writes).toHaveLength(offset + 2);
      await sameAck.check();
      const prepared = await post(`${social}/recommendations/${sameRec.id}/actions`, 'prepare-in-place', button(sameDialog, 'Preparar cambio'), 201,
        { version: 1, evidenceHash: sameRec.evidenceHash, deliveryId: same.deliveryId });
      const change = await checkDraft(prepared.id, same, sameRec);
      expect(change).toMatchObject({ applicationMode: 'same', changeDraft: { deliveryId: same.deliveryId, variable: 'caption', evidenceHash: sameRec.evidenceHash } });
      expect(await recommendation(sameRec.id)).toMatchObject({ state: 'suggested', version: 2, changeDrafts: { [same.deliveryId]: prepared.id } });
      const editor=page.getByRole('heading',{name:'Cambiar esta publicación',exact:true}).locator('../..');
      const proposed=editor.getByRole('heading',{name:'Propuesta guardada',exact:true});
      await reach(page,via,'review-in-place-draft','ver diferencia de la prueba',proposed);
      const revised=`Texto de prueba editable ${via}`;
      await editor.getByLabel('Texto propuesto',{exact:true}).fill(revised);
      const save=button(editor,'Guardar borrador de cambio');
      await reach(page,via,'save-in-place-caption','guardar texto propuesto',save);
      expect((await getSocialCampaign(store,prepared.id)).caption).not.toBe(revised);
      const patchPath=`${social}/campaigns/${prepared.id}`;
      permitted={path:patchPath,method:'PATCH'};
      const patchResponse=page.waitForResponse(res=>res.request().method()==='PATCH'&&new URL(res.url()).pathname===patchPath);
      await save.click();
      const saved=await patchResponse;
      expect(saved.ok(),await saved.text()).toBe(true);
      await expect.poll(async()=>(await getSocialCampaign(store,prepared.id)).caption).toBe(revised);
      const persistedChange=await getSocialCampaign(store,prepared.id);
      expect(persistedChange).toMatchObject({id:prepared.id,state:'draft',changeDraft:{deliveryId:same.deliveryId,variable:'caption'},operations:[]});
      const confirmation=editor.getByRole('group',{name:'Confirmar solo esta diferencia'});
      await reach(page,via,'confirm-in-place-change','confirmar cambio en esta pieza',confirmation);
      for(const checkbox of await confirmation.getByRole('checkbox').all())await expect(checkbox).not.toBeChecked();
      await expect(button(confirmation,'Confirmar cambio en esta pieza')).toBeDisabled();
      const cancel=button(editor,'Cancelar borrador de cambio');
      await reach(page,via,'cancel-in-place-draft','cancelar borrador de cambio',cancel);
      const rejection=page.waitForEvent('dialog'),first=cancel.click();
      await (await rejection).dismiss();await first;
      expect(writes).toHaveLength(offset+4);
      const accepted=page.waitForEvent('dialog');
      const cancelled=post(`${social}/recommendations/${sameRec.id}/actions`,'cancel-in-place',cancel,200,{
        version:persistedChange.changeDraft.recommendationVersion,evidenceHash:sameRec.evidenceHash,draftId:prepared.id,draftVersion:persistedChange.version,deliveryId:same.deliveryId,
      });
      await (await accepted).accept();
      expect(await cancelled).toMatchObject({id:prepared.id,state:'cancelled'});
      expect(await getSocialCampaign(store,prepared.id)).toMatchObject({state:'cancelled',operations:[]});

      await go(dismissal);
      const dismissChoice = results.getByRole('heading', { name: choiceDismiss, exact: true });
      await reach(page, via, 'dismiss-recommendation', 'descartar con motivo', dismissChoice, showRecommendations);
      expect(writes).toHaveLength(offset + 5);
      const dismissalDialog = page.getByRole('dialog', { name: 'Descartar propuesta con motivo', exact: true });
      await expect(dismissalDialog).toHaveCount(0);
      await openDisclosure(results, 'Ver las demás (1)');
      const [decoy, dismissed] = dismissal.records;
      await button(results.getByRole('article').filter({ hasText: dismissed.text }), 'Descartar con motivo').click();
      await expect(dismissalDialog.getByText(`Propuesta: ${dismissed.text}`, { exact: true })).toBeVisible();
      const assist = control(dismissalDialog, 'action-reason');
      const assistButton = button(dismissalDialog, 'Ayúdame con el motivo');
      const launch = () => assistButton.click();
      const reasonField = dismissalDialog.getByRole('textbox', { name: reasonLabel, exact: true });
      const dismissAck = dismissalDialog.getByRole('checkbox');
      await reach(page, via, 'assist-result-action-reason', 'ayúdame con el motivo', assist, null, launch);
      expect(writes).toHaveLength(offset + 5);
      await launch();
      const conversation = ali(page);
      if (await button(conversation, 'Responder').count()) await button(conversation, '‹ Conversaciones').click();
      const suggestion = `Prefiero revisar más evidencia de esta pieza ${via}`;
      await conversation.getByLabel('Mensaje para Ali').fill(`Completa el motivo con «${suggestion}»`);
      await button(conversation, 'Enviar').click();
      const proposal = conversation.getByRole('region', { name: 'Propuesta de cambio', exact: true }).filter({ hasText: suggestion });
      await expect(proposal).toContainText(`Destino: advertising-result-action · ${dismissed.id}`, { timeout: 30_000 });
      await expect(proposal.getByRole('listitem')).toHaveCount(1);
      await expect(proposal.getByRole('button', { name: /Confirmar cambio/ })).toHaveCount(0);
      await button(proposal, 'Aplicar valores').click();
      await expect(conversation).toHaveCount(0);
      await expect(reasonField).toHaveValue(suggestion);
      await expect(dismissAck).not.toBeChecked();
      expect(await recommendation(dismissed.id)).toMatchObject({ state: 'suggested', version: 1 });
      expect(writes).toHaveLength(offset + 5);
      const reason = `${suggestion}; decisión revisada por la administración.`;
      await reasonField.fill(reason);
      await dismissAck.check();
      const result = await post(`${social}/recommendations/${dismissed.id}/actions`, 'dismiss', button(dismissalDialog, 'Descartar propuesta'), 200,
        { version: 1, evidenceHash: dismissed.evidenceHash, reason });
      expect(result).toEqual({ id: dismissed.id, version: 2, state: 'dismissed' });
      expect(await recommendation(dismissed.id)).toMatchObject({ state: 'dismissed', version: 2, dismissalReason: reason, dismissedBy: actor });
      expect((await recommendation(dismissed.id)).conclusion).toBeUndefined();
      expect(await recommendation(decoy.id)).toMatchObject({ state: 'suggested', version: 1 });
      const audit = await store.db.get(`SELECT actor_id,data FROM ${store.t('business_audit')} WHERE entity_type='social_recommendation' AND entity_id=?`, [dismissed.id]);
      expect(audit.actor_id).toBe(actor);
      expect(JSON.parse(audit.data)).toMatchObject({ reason, previous: { state: 'suggested', version: 1 }, next: { state: 'dismissed' } });
      await expect(results.getByText('Propuesta descartada con motivo.', { exact: true })).toBeVisible();
      await showLearnings();
      await expect(results.getByText(`Descartada, no evaluada. ${reason}`, { exact: true })).toBeVisible();
      const originalCampaigns = await Promise.all([analysis, sample, variant, same, dismissal].map(item => getSocialCampaign(store, item.id)));
      for (const original of originalCampaigns) expect(original).toMatchObject({ state: 'published', deliveries: [{ state: 'published' }], operations: [{ step: 'publish', state: 'confirmed' }] });
      expect(writes).toHaveLength(offset + 6);
      observations.push({ via, analysis: { campaignId: analysis.id, jobKey, evidenceHash: persisted.analysis.evidenceHash }, cited: { campaignId: variant.id, captureId, recommendationId: variantRec.id, interactions: 17 },
        comparable: { sampleId: sample.id, originalId: variant.id }, variant: { draftId: created.id, recommendationId: variantRec.id }, same: { draftId: prepared.id, deliveryId: same.deliveryId, recommendationId: sameRec.id },
        dismissed: { recommendationId: dismissed.id, version: result.version, reason }, untouched: decoy.id });
    });
    expect(external).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(await readFile(attempts, 'utf8')).toEqual('');
    await info.attach('resultados privados y decisiones locales', { body: JSON.stringify({ viewport, observations }, null, 2), contentType: 'application/json' });
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
