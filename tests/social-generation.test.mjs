import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile, unlink, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { openStore } from '../lib/db/index.mjs';
import { entity, insertRow } from '../lib/business/commands.mjs';
import { saveAssistantSettings, getAssistantSettings } from '../lib/assistant/settings.mjs';
import { createSocialAsset, uploadSocialAsset, processSocialAssetTurn, getSocialAsset, openSocialAssetContent, socialAssetClientDTO } from '../lib/business/social-media.mjs';
import { requestSocialGeneration, processSocialGenerationTurn, listSocialGenerations, getSocialGeneration, listSocialGenerationSources, getSocialGenerationBrief, getSocialGenerationBasePreview } from '../lib/business/social-generation.mjs';
import { generateOpenAIImage, SOCIAL_IMAGE_MODEL } from '../lib/social/openai-images.mjs';
import { saveProductImage } from '../lib/media.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { saveSocialCampaign, getSocialCampaign } from '../lib/business/social.mjs';
import { getSocialOffer } from '../lib/business/social-offers.mjs';
import { buildSocialSpec } from '../lib/business/social-spec.mjs';

const at = '2026-11-16T10:00:00.000Z', secret = 'generation-test-synthetic-key-not-real';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const image = () => sharp({ create: { width: 400, height: 500, channels: 3, background: '#cc3355' } }).png().toBuffer();
const consent = { version: 2, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true };
const response = bytes => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
async function fixture(t) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }), root = await mkdtemp(join(await realpath(tmpdir()), 'generation-'));
  const env = { NODE_ENV: 'test', SOCIAL_MEDIA_DIR: join(root, 'private'), MEDIA_DIR: join(root, 'products'), INTEGRATION_SECRETS_DIR: join(root, 'secrets'), SOCIAL_BROWSER_CONTROL_DIR: join(root, 'control') };
  const actorId = randomUUID(), tokenHash = digest(Buffer.from(randomUUID())), session = { user: { id: actorId }, csrf: 'synthetic', sessionTokenHash: tokenHash };
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  await insertRow(store, 'sessions', { token_hash: tokenHash, user_id: actorId, csrf: session.csrf, expires: Date.now() + 3600000 });
  const configure = async changes => saveAssistantSettings(store, { version: (await getAssistantSettings(store)).version, requestId: randomUUID(), enabled: true, provider: 'openai', baseUrl: '', model: 'gpt-chat-synthetic-unchanged', allowPrivateNetwork: false, apiKey: secret, ...changes }, session, { env, verify: async () => ({ ok: true }) });
  await configure();
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const { briefHash } = await getSocialGenerationBrief(store, { env });
  const input = changes => ({ requestId: randomUUID(), configurationVersion: 1, campaignId: null, campaignVersion: null, baseAsset: null, briefHash, prompt: 'Diseño de producto sin claims médicos.', format: 'png', sources: [], consent, ...changes });
  return { store, root, env, actorId, session, configure, input, options: { env, now: at } };
}
async function uploadPhoto(f, bytes) {
  const asset = await createSocialAsset(f.store, { name: 'Referencia subida', contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, f.actorId, f.options);
  await uploadSocialAsset(f.store, asset.id, { version: asset.version, requestId: randomUUID(), contentType: 'image/png', contentLength: bytes.length, body: (async function* () { yield bytes; })() }, f.actorId, f.options);
  await processSocialAssetTurn(f.store, f.options);
  return getSocialAsset(f.store, asset.id);
}
async function sources(f) {
  const bytes = await image(), ready = await uploadPhoto(f, bytes), upload = await saveProductImage(bytes, { directory: f.env.MEDIA_DIR });
  const id = randomUUID(), data = { title: 'Producto sintético', presentation: 'Envase de prueba', flavor: 'Cacao', brand: 'Marca sintética', image: upload.url };
  await insertRow(f.store, 'records', { id, kind: 'products', slug: id, title: data.title, status: 'draft', sort_order: 0, data: JSON.stringify(data), version: 1, created_at: at, updated_at: at });
  return { asset: ready, product: { id, ...data }, refs: [{ kind: 'asset', id: ready.id, version: ready.version }, { kind: 'product', id, version: 1 }] };
}
async function animatedGif() {
  const width = 576, height = 1024, pixels = width * height * 3, raw = Buffer.alloc(pixels * 2);
  raw.fill(30, 0, pixels); raw.fill(220, pixels);
  return sharp(raw, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif({ delay: [1500, 1500], loop: 0 }).toBuffer();
}

test('consentimiento informado es obligatorio; sin él no hay trabajo ni llamadas', async t => {
  const f = await fixture(t); let calls = 0;
  for (const value of [undefined, { ...consent, version: 1 }, { ...consent, cost: false }, { ...consent, externalProcessing: false }, { ...consent, noCustomerData: false }, { ...consent, humanReview: false }]) await assert.rejects(() => requestSocialGeneration(f.store, f.input({ consent: value }), f.session, f.options));
  assert.deepEqual(await processSocialGenerationTurn(f.store, { ...f.options, transport: async () => { calls++; throw new Error(); } }), { processed: 0, hasMore: false });
  assert.equal(calls, 0);
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('social_generation_jobs')}`), []);
});

test('ambas fuentes envían bytes locales reales a edits; original y derivado quedan revisables sin publicar ni filtrar secretos', async t => {
  const f = await fixture(t), src = await sources(f), listed = await listSocialGenerationSources(f.store, { query: '', limit: 1 });
  assert.equal(listed.sources.length, 1); assert.equal(listed.hasMore, true);
  assert.equal((await listSocialGenerationSources(f.store, { query: 'Producto' })).sources[0].id, src.product.id);
  const input = f.input({ sources: src.refs }), job = await requestSocialGeneration(f.store, input, f.session, f.options);
  const productBytes = await readFile(join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`));
  const output = await image(); let calls = 0, effectivePrompt;
  assert.equal((await requestSocialGeneration(f.store, input, f.session, f.options)).id, job.id);
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/images/edits'); assert.equal(request.headers.Authorization, `Bearer ${secret}`); assert.equal(request.redirect, 'error');
    const durable = await f.store.db.get(`SELECT state,data FROM ${f.store.t('social_generation_jobs')} WHERE id=?`, [job.id]);
    assert.equal(durable.state, 'sending'); assert.ok(JSON.parse(durable.data).sentAt);
    assert.equal(request.body.get('model'), SOCIAL_IMAGE_MODEL); assert.equal(request.body.get('n'), '1');
    const files = request.body.getAll('image[]'); assert.equal(files.length, 2);
    assert.equal(digest(Buffer.from(await files[0].arrayBuffer())), src.asset.derivativeSha256);
    effectivePrompt = request.body.get('prompt');
    assert.match(effectivePrompt, /Envase de prueba/); assert.match(effectivePrompt, /Cacao/); assert.match(effectivePrompt, /No inventes/);
    assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), productBytes);
    return response(output);
  } });
  assert.equal(calls, 1);
  let saved = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(saved.state, 'succeeded'); assert.equal(saved.asset.state, 'processing');
  await processSocialAssetTurn(f.store, f.options);
  saved = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(saved.asset.state, 'ready'); assert.equal(saved.asset.aiDisclosure, true); assert.equal(saved.asset.reviewRequired, true);
  const asset = await getSocialAsset(f.store, saved.asset.id);
  const internal = await f.store.db.get(`SELECT data FROM ${f.store.t('social_assets')} WHERE id=?`, [asset.id]);
  assert.equal(JSON.parse(internal.data).generation.jobId, job.id);
  assert.equal(JSON.parse(internal.data).generation.promptSha256, digest(effectivePrompt));
  assert.equal(JSON.parse(internal.data).generation.briefHash, input.briefHash);
  for (const dto of [saved, saved.asset, asset, asset.generation ?? {}]) {
    for (const key of ['prompt', 'brief', 'sources', 'sourceSnapshots']) assert.equal(Object.hasOwn(dto, key), false);
  }
  assert.equal(JSON.stringify(saved).includes(input.prompt), false);
  const original = await openSocialAssetContent(f.store, asset.id, { env: f.env, variant: 'original' });
  try { assert.deepEqual(await original.handle.readFile(), output); } finally { await original.handle.close(); }
  assert.equal((await getAssistantSettings(f.store)).model, 'gpt-chat-synthetic-unchanged');
  for (const table of ['social_generation_jobs', 'job_runs', 'business_audit', 'business_requests']) assert.equal(JSON.stringify(await f.store.db.all(`SELECT * FROM ${f.store.t(table)}`)).includes(secret), false);
  assert.equal(JSON.stringify(await listSocialGenerations(f.store, f.actorId)).includes(secret), false);
  assert.equal((await f.store.db.all(`SELECT * FROM ${f.store.t('social_campaigns')}`)).length, 0);
  assert.equal((await f.store.db.all(`SELECT * FROM ${f.store.t('social_deliveries')}`)).length, 0);
  await assert.rejects(() => getSocialGeneration(f.store, job.id, randomUUID()), { status: 404 });
});

test('GIF nativo real conserva animación y original; MP4 contiene frames reales y cumple controles', async t => {
  const f = await fixture(t), bytes = await animatedGif(), job = await requestSocialGeneration(f.store, f.input({ format: 'gif', frameCount: 2, frameDurationMs: 1500 }), f.session, f.options);
  let calls = 0;
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/images/generations');
    const body = JSON.parse(request.body); assert.equal(body.output_format, 'gif'); assert.equal(body.frame_count, 2); assert.equal(body.frame_duration_ms, 1500); assert.equal(body.n, 1);
    return response(bytes);
  } });
  const saved = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(saved.state, 'succeeded');
  await processSocialAssetTurn(f.store, f.options);
  const asset = await getSocialAsset(f.store, saved.asset.id); assert.equal(asset.state, 'ready'); assert.equal(asset.kind, 'video'); assert.equal(asset.contentType, 'image/gif'); assert.equal(asset.derivativeContentType, 'video/mp4'); assert.equal(asset.frameCount, 2); assert.equal(asset.frameRate, 30); assert.equal(asset.cropped, false); assert.equal(asset.fit, 'contain'); assert.equal(asset.faststart, true); assert.equal(asset.width * 16, asset.height * 9);
  const original = await openSocialAssetContent(f.store, asset.id, { env: f.env, variant: 'original' });
  try { const actual = await original.handle.readFile(); assert.deepEqual(actual, bytes); assert.equal((await sharp(actual, { animated: true }).metadata()).pages, 2); } finally { await original.handle.close(); }
  assert.equal(calls, 1);
});

test('configuración, actor y hashes de fuente cercan solicitudes pendientes antes de cualquier POST', async t => {
  for (const mode of ['configuration', 'actor', 'source', 'source-bytes', 'custody', 'legacy-consent']) await t.test(mode, async t => {
    const f = await fixture(t), src = await sources(f), job = await requestSocialGeneration(f.store, f.input({ sources: src.refs }), f.session, f.options);
    if (mode === 'configuration') await f.configure({ model: 'new-chat-model' });
    if (mode === 'actor') await f.store.db.run(`UPDATE ${f.store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    if (mode === 'source') await f.store.db.run(`UPDATE ${f.store.t('records')} SET version=version+1 WHERE id=?`, [src.product.id]);
    if (mode === 'source-bytes') await writeFile(join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`), await sharp({ create: { width: 400, height: 500, channels: 3, background: '#00ff00' } }).webp().toBuffer());
    if (mode === 'custody') { for (const name of await readdir(f.env.INTEGRATION_SECRETS_DIR)) await unlink(join(f.env.INTEGRATION_SECRETS_DIR, name)); }
    if (mode === 'legacy-consent') {
      const row = await f.store.db.get(`SELECT data FROM ${f.store.t('social_generation_jobs')} WHERE id=?`, [job.id]);
      await f.store.db.run(`UPDATE ${f.store.t('social_generation_jobs')} SET data=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), consent: { ...consent, version: 1 } }), job.id]);
    }
    let calls = 0;
    await processSocialGenerationTurn(f.store, { ...f.options, transport: async () => { calls++; throw new Error(secret); } });
    assert.equal(calls, 0); assert.equal((await getSocialGeneration(f.store, job.id, f.actorId)).state, 'blocked');
  });
});

test('URLs de usuario, productos remotos y symlinks nunca se descargan ni se envían', async t => {
  const f = await fixture(t), src = await sources(f);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ sources: [{ kind: 'url', id: 'http://127.0.0.1/secret' }] }), f.session, f.options));
  const data = { title: 'Remoto', image: 'http://169.254.169.254/latest/meta-data' };
  await f.store.db.run(`UPDATE ${f.store.t('records')} SET data=? WHERE id=?`, [JSON.stringify(data), src.product.id]);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ sources: [src.refs[1]] }), f.session, f.options), /foto local/);
  const path = join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`);
  await unlink(path); await symlink(join(f.root, 'not-a-source'), path);
  await f.store.db.run(`UPDATE ${f.store.t('records')} SET data=? WHERE id=?`, [JSON.stringify(src.product), src.product.id]);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ sources: [src.refs[1]] }), f.session, f.options), /foto/);
  await f.configure({ provider: 'openai-compatible', baseUrl: 'https://not-openai.example/v1' });
  assert.equal((await listSocialGenerations(f.store, f.actorId)).availability.available, false);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ configurationVersion: 2 }), f.session, f.options));
  await f.configure({ provider: 'gemini', baseUrl: '', model: 'gemini-synthetic', enabled: false });
  const settings = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_settings')} WHERE id=1`);
  await f.store.db.run(`UPDATE ${f.store.t('assistant_settings')} SET data=? WHERE id=1`, [JSON.stringify({ ...JSON.parse(settings.data), authMethod: 'oauth' })]);
  assert.equal((await listSocialGenerations(f.store, f.actorId)).availability.available, false);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ configurationVersion: 3 }), f.session, f.options));
});

test('respuesta perdida o worker muerto después de sending queda uncertain sin segundo POST', async t => {
  for (const mode of ['network', 'crash']) await t.test(mode, async t => {
    const f = await fixture(t), job = await requestSocialGeneration(f.store, f.input(), f.session, f.options); let calls = 0;
    if (mode === 'crash') {
      await claimJob(f.store, { key: `social:generation:${job.id}`, now: at });
      const row = await f.store.db.get(`SELECT data FROM ${f.store.t('social_generation_jobs')} WHERE id=?`, [job.id]);
      await f.store.db.run(`UPDATE ${f.store.t('social_generation_jobs')} SET state='sending',data=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), phase: 'sending', sentAt: at }), job.id]);
    }
    const options = { ...f.options, now: '2026-11-16T10:03:00.000Z', transport: async () => { calls++; throw new Error(`private-${secret}`); } };
    await processSocialGenerationTurn(f.store, options); await processSocialGenerationTurn(f.store, options);
    const result = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(result.state, 'uncertain'); assert.match(result.notice, /cargo/); assert.equal(calls, mode === 'network' ? 1 : 0); assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

test('proveedor rechaza GIF estático, frames corruptos, respuesta URL y redirecciones sin usar fallback', async () => {
  const png = await image(), gif = await animatedGif(), staticGif = await sharp(png).gif().toBuffer();
  for (const bytes of [png, staticGif, gif.subarray(0, 30)]) await assert.rejects(() => generateOpenAIImage({ apiKey: secret, prompt: 'Prueba', format: 'gif', frameCount: 2, frameDurationMs: 1500, actorId: 'synthetic', beforePost: async () => {} }, { transport: async () => response(bytes) }));
  let before = 0;
  await assert.rejects(() => generateOpenAIImage({ apiKey: secret, prompt: 'Prueba', format: 'png', actorId: 'synthetic', beforePost: async () => { before++; } }, { transport: async (_url, request) => { assert.equal(request.redirect, 'error'); return new Response(JSON.stringify({ data: [{ url: 'http://127.0.0.1/secret' }] })); } }));
  assert.equal(before, 1);
});

const offerImagePath = (f, url) => join(f.env.MEDIA_DIR, `${url.split('/').at(-1)}.webp`);
async function contextualOffer(f, { photos = true } = {}) {
  const settings = await f.store.settings();
  await f.store.saveSettings({ ...settings, brandName: 'Nutrición Norte', logo: '', hours: 'Lunes a viernes' }, settings.version);
  const urls = [];
  if (photos) for (const background of ['#334477', '#dd7700', '#559944']) {
    const bytes = await sharp({ create: { width: 400, height: 500, channels: 3, background } }).png().toBuffer();
    urls.push((await saveProductImage(bytes, { directory: f.env.MEDIA_DIR })).url);
  }
  const cacao = await f.store.save('products', { slug: 'cacao', title: 'Proteína', status: 'draft', orderable: true, flavor: 'Cacao', presentation: '500 g', image: urls[2] ?? '', stockQuantity: 4321, unitCostMinor: 876543, sku: 'SKU-INTERNO-CACAO', price: 45000 });
  const sample = await f.store.save('products', { slug: 'sample', title: 'Vainilla', status: 'draft', orderable: true, presentation: '30 g', price: 1000 });
  await f.store.save('products', { slug: 'other-variant', title: 'Proteína', status: 'draft', orderable: true, flavor: 'Frambuesa ajena', presentation: '500 g', price: 45000 });
  const combo = await f.store.save('combos', { slug: 'duo', title: 'Dúo', status: 'draft', orderable: true, price: 73000, items: [{ productId: cacao.id, quantity: 2 }] });
  const gift = await f.store.save('products', { slug: 'gift', title: 'Muestra vainilla', status: 'draft', productType: 'gift', price: 0, presentation: '30 g', image: urls[1] ?? '', items: [{ productId: sample.id, quantity: 1 }] });
  if (photos) {
    // Install the local storage reference directly: the generic combo form does not upload photos.
    const row = await f.store.db.get(`SELECT data FROM ${f.store.t('records')} WHERE id=?`, [combo.id]);
    await f.store.db.run(`UPDATE ${f.store.t('records')} SET data=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), image: urls[0] }), combo.id]);
  }
  const primary = await getSocialOffer(f.store, 'combo', combo.id), extra = await getSocialOffer(f.store, 'gift', gift.id);
  return { urls, offerRef: { primary: { kind: 'combo', id: combo.id, factsHash: primary.factsHash }, gift: { id: gift.id, factsHash: extra.factsHash, condition: 'Solo con Dúo' } } };
}
function contextualInput(f, review, changes = {}) {
  const { campaignId, campaignVersion, briefHash, baseAsset } = review;
  return f.input({ campaignId, campaignVersion, briefHash, baseAsset: baseAsset && { id: baseAsset.id, version: baseAsset.version, sha256: baseAsset.sha256 }, ...changes });
}
const createDraft = (f, fields) => saveSocialCampaign(f.store, { name: 'Dúo de prueba', mode: 'organic', platforms: ['instagram'], requestId: randomUUID(), ...fields }, f.actorId, f.options);

test('el multipart conserva hechos, correspondencia de fotos y dirección distinta para cada objetivo guardado', async t => {
  const f = await fixture(t), { urls, offerRef } = await contextualOffer(f), output = await image();
  const connectionId = randomUUID();
  const connectionData = { name: 'Cuenta de prueba', identities: { userId: '91372167', businessId: '91372168', pageId: '91372169', instagramId: '91372170' }, capabilities: { instagramPublish: true }, measurementConfig: { updatedAt: at, objective: 'sales', pixelId: '91372171' } };
  await insertRow(f.store, 'social_connections', { id: connectionId, state: 'connected', provider: 'meta', integration_method: 'api', version: 1, data: JSON.stringify(connectionData), created_at: at, updated_at: at });
  const expected = await Promise.all(urls.map(async url => digest(await readFile(offerImagePath(f, url)))));
  const directions = { reach: /reconocibles a primera vista.*descubrimiento/i, engagement: /pregunta breve.*invitar a comentar/i, traffic: /conocer los detalles en el sitio elegido.*código QR/i, whatsapp: /condición e invita a consultar por WhatsApp/i };
  for (const [objective, direction] of Object.entries(directions)) await t.test(objective, async () => {
    const draft = await createDraft(f, { connectionId, objective, offerRef, caption: 'Una oferta real https://externa.example/imagen.png', destinationUrl: 'https://nutricion.com/ofertas?privado=QUERY-OCULTO#FRAGMENTO-OCULTO', whatsappNumber: '+573001234567', whatsappGreeting: 'MENSAJE PRIVADO DE CHAT' });
    const review = await getSocialGenerationBrief(f.store, { campaignId: draft.id, env: f.env });
    assert.deepEqual(review.automaticSources.map(photo => photo.sha256), expected);
    const input = contextualInput(f, review, { prompt: 'fondo azul, sin texto adicional' });
    const job = await requestSocialGeneration(f.store, input, f.session, f.options);
    let calls = 0, effectivePrompt;
    await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      const files = request.body.getAll('image[]');
      assert.deepEqual(await Promise.all(files.map(async file => digest(Buffer.from(await file.arrayBuffer())))), expected);
      effectivePrompt = request.body.get('prompt');
      for (const pattern of [/Nutrición Norte/, /Dúo/, /500 g.*Cacao.*"quantity":2/, /Muestra vainilla.*30 g/, /Solo con Dúo/, /fondo azul, sin texto adicional/, /Oferta principal: Dúo/, /Obsequio adicional: Muestra vainilla/, /Componente de oferta principal: Proteína · 500 g · Cacao/, direction]) assert.match(effectivePrompt, pattern);
      if (objective === 'whatsapp') assert.match(effectivePrompt, /sales/);
      if (objective === 'traffic') assert.match(effectivePrompt, /nutricion\.com/);
      assert.doesNotMatch(effectivePrompt, /Frambuesa ajena|573001234567|4321|876543|SKU-INTERNO|9137217[01]|QUERY-OCULTO|FRAGMENTO-OCULTO|externa\.example|MENSAJE PRIVADO DE CHAT/);
      assert.ok(!effectivePrompt.includes(secret));
      return response(output);
    } });
    assert.equal(calls, 1);
    await processSocialAssetTurn(f.store, f.options);
    const saved = await getSocialGeneration(f.store, job.id, f.actorId);
    const campaign = await getSocialCampaign(f.store, draft.id);
    assert.equal(saved.asset.state, 'ready');
    assert.deepEqual(saved.asset.alignment, { mode: 'organic', objective, offerHash: campaign.offerHash });
    assert.equal(saved.asset.aiDisclosure, true);
    assert.equal(saved.asset.reviewRequired, true);
    const derived = await openSocialAssetContent(f.store, saved.asset.id, { env: f.env });
    try {
      const bytes = await derived.handle.readFile();
      assert.equal(digest(bytes), saved.asset.sha256);
      assert.equal((await sharp(bytes).stats()).channels.length, 3);
    } finally { await derived.handle.close(); }
    assert.equal(campaign.assetId, null);
    assert.equal(campaign.state, 'draft');
    assert.deepEqual((await listSocialGenerations(f.store, f.actorId, { campaignId: draft.id })).jobs.map(item => item.id), [job.id]);
  });
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('social_deliveries')}`), []);
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('social_revisions')}`), []);
});

test('sin fotos el encargo tipográfico omite envases inventados; un borrador cambiado bloquea antes del POST pero permite replay', async t => {
  const f = await fixture(t), { offerRef } = await contextualOffer(f, { photos: false });
  const incomplete = await createDraft(f, { offerRef: { ...offerRef, gift: { ...offerRef.gift, condition: '' } } });
  await assert.rejects(() => getSocialGenerationBrief(f.store, { campaignId: incomplete.id, env: f.env }), /condición/i);
  const draft = await createDraft(f, { objective: 'reach', offerRef });
  const request = async changes => contextualInput(f, await getSocialGenerationBrief(f.store, { campaignId: draft.id, env: f.env }), changes);
  const first = await request({ prompt: '' });
  await requestSocialGeneration(f.store, first, f.session, f.options);
  const bytes = await image();
  let calls = 0;
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    const { prompt } = JSON.parse(request.body);
    assert.match(prompt, /texto tipográfico.*no redibujes un envase/);
    assert.match(prompt, /Cacao/);
    return response(bytes);
  } });
  assert.equal(calls, 1);
  const input = await request(), job = await requestSocialGeneration(f.store, input, f.session, f.options);
  await saveSocialCampaign(f.store, { id: draft.id, version: draft.version, requestId: randomUUID(), objective: 'engagement' }, f.actorId, f.options);
  assert.equal((await requestSocialGeneration(f.store, input, f.session, f.options)).id, job.id);
  await assert.rejects(() => requestSocialGeneration(f.store, { ...input, prompt: 'Otra instrucción' }, f.session, f.options), { status: 409 });
  await assert.rejects(() => requestSocialGeneration(f.store, { ...input, requestId: randomUUID() }, f.session, f.options), { status: 409 });
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async () => { calls++; throw new Error('unexpected POST'); } });
  assert.equal(calls, 1);
  assert.equal((await getSocialGeneration(f.store, job.id, f.actorId)).state, 'blocked');
});

test('usar una foto lista no solicita generación; ajustar una vertical conserva el original hasta elegir la variante', async t => {
  const f = await fixture(t), { offerRef, urls } = await contextualOffer(f);
  const ready = await uploadPhoto(f, await image());
  assert.equal(ready.state, 'ready');
  const originalBytes = await sharp({ create: { width: 540, height: 960, channels: 3, background: '#202099' } }).withExif({ IFD0: { Artist: 'METADATO-PRIVADO' } }).png().toBuffer();
  const base = await uploadPhoto(f, originalBytes);
  assert.equal(base.state, 'failed');
  assert.equal(base.diagnostic.code, 'IMAGE_GEOMETRY');
  assert.ok((await sharp(originalBytes).metadata()).exif);
  const connectionId = randomUUID();
  const connectionData = { name: 'Cuenta de prueba', identities: { userId: '100', businessId: '500', pageId: '200', instagramId: '300' }, capabilities: { instagramPublish: true } };
  await insertRow(f.store, 'social_connections', { id: connectionId, state: 'connected', provider: 'meta', integration_method: 'api', version: 1, data: JSON.stringify(connectionData), created_at: at, updated_at: at });
  const draft = await createDraft(f, { connectionId, assetId: ready.id, aiDisclosure: false, objective: 'whatsapp', placements: ['instagram_feed'], offerRef });
  let detail = await getSocialCampaign(f.store, draft.id);
  assert.equal(detail.assetId, ready.id);
  assert.equal(detail.validation.valid, true);
  assert.deepEqual((await listSocialGenerations(f.store, f.actorId)).jobs, []);
  assert.throws(() => buildSocialSpec({ ...detail, assetId: base.id }, { connection: detail.connection, asset: base, now: at }), /pieza normalizada debe estar lista/);
  const review = await getSocialGenerationBrief(f.store, { campaignId: draft.id, baseAssetId: base.id, env: f.env });
  const preview = await getSocialGenerationBasePreview(f.store, base.id, review.baseAsset.sha256, { env: f.env });
  const previewMetadata = await sharp(preview.bytes).metadata();
  assert.equal(previewMetadata.exif, undefined);
  assert.equal(previewMetadata.width * 16, previewMetadata.height * 9);
  assert.equal(digest(preview.bytes), review.baseAsset.sha256);
  const input = contextualInput(f, review, { prompt: 'Aclara el fondo y conserva la etiqueta' });
  await assert.rejects(() => requestSocialGeneration(f.store, { ...input, prompt: '' }, f.session, f.options));
  await assert.rejects(() => requestSocialGeneration(f.store, input, { ...f.session, sessionTokenHash: digest(randomUUID()) }, f.options));
  const job = await requestSocialGeneration(f.store, input, f.session, f.options);
  const output = await image();
  let calls = 0;
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    const files = request.body.getAll('image[]');
    assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), preview.bytes);
    assert.deepEqual(await Promise.all(files.slice(1).map(async file => digest(Buffer.from(await file.arrayBuffer())))), await Promise.all(urls.map(async url => digest(await readFile(offerImagePath(f, url))))));
    const prompt = request.body.get('prompt');
    for (const pattern of [/primera foto es la imagen a modificar/, /Solo con Dúo/, /consultar por WhatsApp/, /Aclara el fondo y conserva la etiqueta/]) assert.match(prompt, pattern);
    return response(output);
  } });
  assert.equal(calls, 1);
  await processSocialAssetTurn(f.store, f.options);
  const variant = (await getSocialGeneration(f.store, job.id, f.actorId)).asset;
  assert.equal(variant.state, 'ready');
  assert.notEqual(variant.id, base.id);
  assert.notEqual(variant.id, ready.id);
  const readAsset = async id => entity(await f.store.db.get(`SELECT * FROM ${f.store.t('social_assets')} WHERE id=?`, [id]));
  assert.equal((await readAsset(base.id)).originalSha256, digest(originalBytes));
  assert.equal((await readAsset(base.id)).state, 'failed');
  assert.deepEqual(await readFile(join(f.env.SOCIAL_MEDIA_DIR, (await readAsset(base.id)).originalKey)), originalBytes);
  const { generation } = await readAsset(variant.id);
  assert.equal(generation.baseAssetId, base.id);
  assert.equal(generation.baseAssetSha256, review.baseAsset.sha256);
  const publicAsset = socialAssetClientDTO(await readAsset(variant.id));
  assert.deepEqual(publicAsset.alignment, variant.alignment);
  assert.equal(Object.hasOwn(publicAsset, 'generation'), false);
  assert.equal(generation.briefHash, review.briefHash);
  assert.equal((await getSocialCampaign(f.store, draft.id)).assetId, ready.id);
  await saveSocialCampaign(f.store, { id: draft.id, version: draft.version, requestId: randomUUID(), assetId: variant.id, aiDisclosure: true }, f.actorId, f.options);
  detail = await getSocialCampaign(f.store, draft.id);
  assert.equal(detail.assetId, variant.id);
  assert.deepEqual(variant.alignment, { mode: 'organic', objective: 'whatsapp', offerHash: detail.offerHash });
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('social_deliveries')}`), []);

  const rereview = await getSocialGenerationBrief(f.store, { campaignId: draft.id, baseAssetId: base.id, env: f.env });
  const stale = await requestSocialGeneration(f.store, contextualInput(f, rereview), f.session, f.options);
  await writeFile(join(f.env.SOCIAL_MEDIA_DIR, (await readAsset(base.id)).originalKey), Buffer.from('corrupt source'));
  await assert.rejects(() => getSocialGenerationBrief(f.store, { campaignId: draft.id, baseAssetId: base.id, env: f.env }));
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async () => { calls++; throw new Error('unexpected POST'); } });
  assert.equal(calls, 1);
  assert.equal((await getSocialGeneration(f.store, stale.id, f.actorId)).state, 'blocked');
});
