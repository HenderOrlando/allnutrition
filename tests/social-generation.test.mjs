import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readFile, writeFile, unlink, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { openStore } from '../lib/db/index.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { saveAssistantSettings, getAssistantSettings } from '../lib/assistant/settings.mjs';
import { createSocialAsset, uploadSocialAsset, processSocialAssetTurn, getSocialAsset, openSocialAssetContent } from '../lib/business/social-media.mjs';
import { requestSocialGeneration, processSocialGenerationTurn, listSocialGenerations, getSocialGeneration, listSocialGenerationSources } from '../lib/business/social-generation.mjs';
import { generateOpenAIImage, SOCIAL_IMAGE_MODEL } from '../lib/social/openai-images.mjs';
import { saveProductImage } from '../lib/media.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';

const at = '2026-11-16T10:00:00.000Z', secret = 'generation-test-synthetic-key-not-real';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const image = () => sharp({ create: { width: 400, height: 500, channels: 3, background: '#cc3355' } }).png().toBuffer();
const consent = { version: 1, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true };
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
  const input = changes => ({ requestId: randomUUID(), configurationVersion: 1, prompt: 'Diseño de producto sin claims médicos.', format: 'png', sources: [], consent, ...changes });
  return { store, root, env, actorId, session, configure, input, options: { env, now: at } };
}
async function sources(f) {
  const bytes = await image(), asset = await createSocialAsset(f.store, { name: 'Referencia subida', contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, f.actorId, f.options);
  await uploadSocialAsset(f.store, asset.id, { version: asset.version, requestId: randomUUID(), contentType: 'image/png', contentLength: bytes.length, body: (async function* () { yield bytes; })() }, f.actorId, f.options);
  await processSocialAssetTurn(f.store, f.options);
  const ready = await getSocialAsset(f.store, asset.id), upload = await saveProductImage(bytes, { directory: f.env.MEDIA_DIR });
  const id = randomUUID(), data = { title: 'Producto sintético', presentation: 'Envase de prueba', brand: 'Marca sintética', image: upload.url };
  await insertRow(f.store, 'records', { id, kind: 'products', slug: id, title: data.title, status: 'draft', sort_order: 0, data: JSON.stringify(data), version: 1, created_at: at, updated_at: at });
  return { asset: ready, product: { id, ...data }, refs: [{ kind: 'asset', id: ready.id }, { kind: 'product', id }] };
}
async function animatedGif() {
  const width = 576, height = 1024, pixels = width * height * 3, raw = Buffer.alloc(pixels * 2);
  raw.fill(30, 0, pixels); raw.fill(220, pixels);
  return sharp(raw, { raw: { width, height: height * 2, channels: 3, pageHeight: height } }).gif({ delay: [1500, 1500], loop: 0 }).toBuffer();
}

test('consentimiento informado es obligatorio; sin él no hay trabajo ni llamadas', async t => {
  const f = await fixture(t); let calls = 0;
  for (const value of [undefined, { ...consent, cost: false }, { ...consent, externalProcessing: false }, { ...consent, noCustomerData: false }, { ...consent, humanReview: false }]) await assert.rejects(() => requestSocialGeneration(f.store, f.input({ consent: value }), f.session, f.options));
  assert.deepEqual(await processSocialGenerationTurn(f.store, { ...f.options, transport: async () => { calls++; throw new Error(); } }), { processed: 0, hasMore: false });
  assert.equal(calls, 0);
  assert.deepEqual(await f.store.db.all(`SELECT * FROM ${f.store.t('social_generation_jobs')}`), []);
});

test('ambas fuentes envían bytes locales reales a edits; original y derivado quedan revisables sin publicar ni filtrar secretos', async t => {
  const f = await fixture(t), src = await sources(f), listed = await listSocialGenerationSources(f.store, { query: '', limit: 1 });
  assert.equal(listed.sources.length, 1); assert.equal(listed.hasMore, true);
  assert.equal((await listSocialGenerationSources(f.store, { query: 'Producto' })).sources[0].id, src.product.id);
  const input = f.input({ sources: src.refs }), job = await requestSocialGeneration(f.store, input, f.session, f.options);
  assert.equal((await requestSocialGeneration(f.store, input, f.session, f.options)).id, job.id);
  const output = await image(); let calls = 0;
  await processSocialGenerationTurn(f.store, { ...f.options, transport: async (url, request) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/images/edits'); assert.equal(request.headers.Authorization, `Bearer ${secret}`); assert.equal(request.redirect, 'error');
    const durable = await f.store.db.get(`SELECT state,data FROM ${f.store.t('social_generation_jobs')} WHERE id=?`, [job.id]);
    assert.equal(durable.state, 'sending'); assert.ok(JSON.parse(durable.data).sentAt);
    assert.equal(request.body.get('model'), SOCIAL_IMAGE_MODEL); assert.equal(request.body.get('n'), '1');
    const files = request.body.getAll('image[]'); assert.equal(files.length, 2);
    assert.equal(digest(Buffer.from(await files[0].arrayBuffer())), src.asset.derivativeSha256);
    const productBytes = await readFile(join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`));
    assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), productBytes);
    assert.match(request.body.get('prompt'), /Envase de prueba/); assert.match(request.body.get('prompt'), /No inventes/);
    return response(output);
  } });
  assert.equal(calls, 1);
  let saved = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(saved.state, 'succeeded'); assert.equal(saved.asset.state, 'processing');
  await processSocialAssetTurn(f.store, f.options);
  saved = await getSocialGeneration(f.store, job.id, f.actorId); assert.equal(saved.asset.state, 'ready'); assert.equal(saved.asset.aiDisclosure, true); assert.equal(saved.asset.reviewRequired, true);
  const asset = await getSocialAsset(f.store, saved.asset.id); assert.equal(asset.generation.jobId, job.id); assert.equal(asset.generation.sourceSnapshots.length, 2);
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
  for (const mode of ['configuration', 'actor', 'source', 'source-bytes', 'custody']) await t.test(mode, async t => {
    const f = await fixture(t), src = await sources(f), job = await requestSocialGeneration(f.store, f.input({ sources: src.refs }), f.session, f.options);
    if (mode === 'configuration') await f.configure({ model: 'new-chat-model' });
    if (mode === 'actor') await f.store.db.run(`UPDATE ${f.store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    if (mode === 'source') await f.store.db.run(`UPDATE ${f.store.t('records')} SET version=version+1 WHERE id=?`, [src.product.id]);
    if (mode === 'source-bytes') await writeFile(join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`), await sharp({ create: { width: 400, height: 500, channels: 3, background: '#00ff00' } }).webp().toBuffer());
    if (mode === 'custody') { for (const name of await readdir(f.env.INTEGRATION_SECRETS_DIR)) await unlink(join(f.env.INTEGRATION_SECRETS_DIR, name)); }
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
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ sources: [{ kind: 'product', id: src.product.id }] }), f.session, f.options));
  const path = join(f.env.MEDIA_DIR, `${src.product.image.split('/').at(-1)}.webp`);
  await unlink(path); await symlink(join(f.root, 'not-a-source'), path);
  await f.store.db.run(`UPDATE ${f.store.t('records')} SET data=? WHERE id=?`, [JSON.stringify(src.product), src.product.id]);
  await assert.rejects(() => requestSocialGeneration(f.store, f.input({ sources: [{ kind: 'product', id: src.product.id }] }), f.session, f.options));
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
