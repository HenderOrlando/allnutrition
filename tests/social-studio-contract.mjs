import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { insertRow, hash } from '../lib/business/commands.mjs';
import { migratePublicationStudioV16, PUBLICATION_STUDIO_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { getAssistantSettings, saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { createSocialCreativeThread, listSocialCreativeThreads, patchSocialCreativeThread } from '../lib/business/social-creative-threads.mjs';
import { getSocialCreativeThread, getSocialGenerationAvailability, getSocialGenerationBrief, listSocialGenerations, requestSocialGeneration, processSocialGenerationTurn } from '../lib/business/social-generation.mjs';
import { createSocialAsset, uploadSocialAsset, processSocialAssetTurn, getSocialAsset, openSocialAssetContent } from '../lib/business/social-media.mjs';
import { getSocialCampaign, saveSocialCampaign } from '../lib/business/social.mjs';
import { importData } from '../lib/import.mjs';

const at = '2026-11-16T10:00:00.000Z';
const key = 'studio-synthetic-provider-credential-not-real';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const photo = (background, width = 400, height = 500) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const response = bytes => Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
const consent = { version: 2, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true };

async function actor(store) {
  const id = randomUUID(), sessionTokenHash = hash(randomUUID());
  const session = { user: { id }, csrf: randomUUID(), sessionTokenHash };
  await insertRow(store, 'users', { id, email: `${id}@example.test`, password: 'unused', active: 1 });
  await insertRow(store, 'sessions', { token_hash: sessionTokenHash, user_id: id, csrf: session.csrf, expires: Date.now() + 3600000 });
  return session;
}
async function fixture(t, factory) {
  const store = await factory(); t.after(() => store.close());
  const root = await mkdtemp(join(await realpath(tmpdir()), 'social-studio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { NODE_ENV: 'test', SOCIAL_MEDIA_DIR: join(root, 'private'), MEDIA_DIR: join(root, 'products'), INTEGRATION_SECRETS_DIR: join(root, 'secrets') };
  return { store, session: await actor(store), options: { env, now: at } };
}
async function upload(f, bytes) {
  const { store, session: { user }, options } = f;
  const asset = await createSocialAsset(store, { name: 'Foto propia de ensayo', contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, user.id, options);
  return uploadSocialAsset(store, asset.id, { version: asset.version, requestId: randomUUID(), contentType: 'image/png', contentLength: bytes.length,
    body: (async function* () { yield bytes; })() }, user.id, options);
}
function patch(f, thread, action, asset) {
  return patchSocialCreativeThread(f.store, thread.id, { action, version: thread.version, assetId: asset.id, assetVersion: asset.version }, f.session, f.options);
}
async function turn(f, thread, prompt, baseAssetId = null, campaignId = null) {
  const { store, options: { env } } = f;
  const { baseAsset, briefHash, campaignVersion } = await getSocialGenerationBrief(store, { campaignId, baseAssetId, env });
  return { threadId: thread.id, threadVersion: thread.version, requestId: randomUUID(), configurationVersion: 1, campaignId, campaignVersion,
    baseAsset: baseAsset ? { id: baseAsset.id, version: baseAsset.version, sha256: baseAsset.sha256 } : null,
    briefHash, prompt, format: 'png', sources: [], consent };
}
async function oldJob(store, session, fields = {}) {
  return insertRow(store, 'social_generation_jobs', { id: randomUUID(), actor_id: session.user.id, state: 'blocked',
    data: JSON.stringify({ prompt: 'PRIVATE-user-turn', effectivePrompt: 'PRIVATE-effective-prompt', sources: ['PRIVATE-source-bytes'], apiKey: key }),
    version: 1, created_at: at, updated_at: at, ...fields });
}

export async function removeStudioV16(store) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const index = tx.provider === 'sqlite' ? 'social_generation_jobs_thread_created' : 'allnutrition.social_generation_jobs_thread_created';
    await tx.db.exec(`DROP INDEX ${index}`);
    await tx.db.exec(`ALTER TABLE ${tx.t('social_generation_jobs')} DROP COLUMN thread_id`);
    for (const table of [...PUBLICATION_STUDIO_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=16`);
  });
}

export async function runStudioMigrationContract(t, factory, reopen) {
  await t.test('v16 transaccional conserva los trabajos sin hilo de v15 y reabre sin mezclar datos', async t => {
    const store = await factory();
    t.after(async () => { try { await migratePublicationStudioV16(store); } finally { await store.close(); } });
    const session = await actor(store);
    await removeStudioV16(store);
    const old = await oldJob(store, session);
    const markerError = new Error('Fallo sintético del marcador v16');
    const failingStore = { provider: store.provider, transaction: fn => store.transaction(tx => {
      const db = tx.db;
      tx.db = { ...db, run: (sql, args) => { if (sql.includes('VALUES(16,')) throw markerError; return db.run(sql, args); } };
      return fn(tx);
    }) };
    await assert.rejects(() => migratePublicationStudioV16(failingStore), error => error === markerError);
    assert.equal(await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=16`), null);
    assert.deepEqual({ ...await store.db.get(`SELECT * FROM ${store.t('social_generation_jobs')} WHERE id=?`, [old.id]) }, old);
    if (store.provider !== 'sqlite') {
      await assert.rejects(reopen, /v16/);
      assert.deepEqual(await migratePublicationStudioV16(store), { migrated: true, version: 16 });
    }
    const reopened = await reopen();
    try {
      assert.deepEqual({ ...await reopened.db.get(`SELECT * FROM ${reopened.t('social_generation_jobs')} WHERE id=?`, [old.id]) }, { ...old, thread_id: null });
      assert.deepEqual((await listSocialGenerations(reopened, session.user.id)).jobs.map(job => job.id), [old.id]);
      assert.deepEqual(await migratePublicationStudioV16(reopened), { migrated: false, version: 16 });
      const draft = await saveSocialCampaign(reopened, { requestId: randomUUID(), name: 'Borrador para el registro de audiencia', mode: 'paid' }, session.user.id);
      const audience = { id: randomUUID(), actor_id: session.user.id, request_id: randomUUID(), campaign_id: draft.id, campaign_version: draft.version,
        settings_version: 1, context_hash: 'a'.repeat(64), mode: 'manual', status: 'reserved', created_at: at, updated_at: at };
      await insertRow(reopened, 'social_audience_requests', audience);
      await assert.rejects(() => insertRow(reopened, 'social_audience_requests', { ...audience, id: randomUUID() }));
      await assert.rejects(() => reopened.db.run(`UPDATE ${reopened.t('social_audience_requests')} SET result_json='[]' WHERE id=?`, [audience.id]));
      await reopened.db.run(`DELETE FROM ${reopened.t('social_campaigns')} WHERE id=?`, [draft.id]);
      assert.equal(await reopened.db.get(`SELECT id FROM ${reopened.t('social_audience_requests')} WHERE id=?`, [audience.id]), null);
    } finally { await reopened.close(); }
  });
}

export async function runSocialStudioContracts(t, factory) {
  await t.test('hilos privados, reanudación paginada con empate, y borrado no destructivo', async t => {
    const f = await fixture(t, factory), { store, session, options } = f, collaborator = await actor(store);
    const input = { requestId: randomUUID() };
    const [left, replay] = await Promise.all([createSocialCreativeThread(store, input, session, options), createSocialCreativeThread(store, input, session, options)]);
    assert.equal(left.id, replay.id);
    const right = await createSocialCreativeThread(store, { requestId: randomUUID() }, session, options);
    const own = await createSocialCreativeThread(store, input, collaborator, options);
    assert.notEqual(own.id, left.id);
    const ids = [];
    for (let i = 0; i < 23; i++) ids.push((await oldJob(store, session, { thread_id: left.id })).id);
    await oldJob(store, session, { thread_id: right.id, data: '{"prompt":"PRIVATE-other"}' });
    const legacy = await oldJob(store, session);
    const first = await getSocialCreativeThread(store, left.id, session.user.id);
    const second = await getSocialCreativeThread(store, left.id, session.user.id, { cursor: first.nextCursor });
    assert.equal(first.turns.length, 20); assert.equal(second.turns.length, 3); assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.turns, ...second.turns].map(item => item.id), ids.sort().reverse());
    assert.equal(first.turns[0].prompt, 'PRIVATE-user-turn');
    for (const privateValue of ['PRIVATE-effective-prompt', 'PRIVATE-source-bytes', 'PRIVATE-other', key]) assert.ok(!JSON.stringify(first).includes(privateValue));
    assert.deepEqual((await listSocialCreativeThreads(store, collaborator.user.id)).threads.map(item => item.id), [own.id]);
    await assert.rejects(() => getSocialCreativeThread(store, left.id, collaborator.user.id), { status: 404 });
    await assert.rejects(() => patchSocialCreativeThread(store, left.id, { action: 'select', version: 1, assetId: randomUUID(), assetVersion: 1 }, collaborator), { status: 404 });
    await assert.rejects(() => getSocialCreativeThread(store, left.id, session.user.id, { cursor: 'bad' }), { status: 400 });
    assert.deepEqual((await listSocialGenerations(store, session.user.id)).jobs.map(item => item.id), [legacy.id]);
    await store.db.run(`DELETE FROM ${store.t('social_creative_threads')} WHERE id=?`, [left.id]);
    assert.equal((await store.db.get(`SELECT thread_id FROM ${store.t('social_generation_jobs')} WHERE id=?`, [ids[0]])).thread_id, null);
  });

  await t.test('foto sin IA y enlace transaccional no duplican borradores, preservan huella y permiten colaborar sin chat', async t => {
    const f = await fixture(t, factory), { store, session, options } = f, collaborator = await actor(store);
    assert.equal((await getSocialGenerationAvailability(store)).available, false);
    const thread = await createSocialCreativeThread(store, { requestId: randomUUID() }, session, options);
    const uploaded = await upload(f, await photo('#ffa000'));
    let linked = await patch(f, thread, 'attach', uploaded);
    assert.equal(linked.attachments[0].state, 'processing');
    await assert.rejects(() => patch(f, linked, 'select', uploaded), { status: 409 });
    await processSocialAssetTurn(store, options);
    const ready = (await getSocialCreativeThread(store, thread.id, session.user.id)).thread.attachments[0];
    assert.equal(ready.state, 'ready'); assert.equal(ready.sha256, ready.derivativeSha256);
    await assert.rejects(() => patch(f, thread, 'select', ready), { status: 409 });
    await assert.rejects(() => patch(f, linked, 'select', uploaded), { status: 409 });
    linked = await patch(f, linked, 'select', ready);
    const draft = { threadId: thread.id, threadVersion: linked.version, requestId: randomUUID(), name: 'Borrador comercial con foto propia', mode: 'paid', objective: 'reach', assetId: ready.id };
    await assert.rejects(() => saveSocialCampaign(store, { ...draft, assetId: randomUUID() }, session.user.id), { status: 409 });
    await assert.rejects(() => saveSocialCampaign(store, draft, collaborator.user.id), { status: 404 });
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('social_campaigns')} LIMIT 1`), null);
    const [campaign, replay] = await Promise.all([saveSocialCampaign(store, draft, session.user.id), saveSocialCampaign(store, draft, session.user.id)]);
    assert.deepEqual(campaign, replay);
    await assert.rejects(() => saveSocialCampaign(store, { ...draft, requestId: randomUUID() }, session.user.id), { status: 409 });
    const dto = await getSocialCampaign(store, campaign.id);
    assert.equal(dto.asset.id, ready.id); assert.equal(dto.state, 'draft'); assert.equal(dto.connectionId, null); assert.deepEqual(dto.deliveries, []);
    assert.ok(!JSON.stringify(dto).includes(thread.id));
    const storage = (await getSocialCreativeThread(store, thread.id, session.user.id)).thread;
    assert.equal(storage.campaignId, campaign.id); assert.equal(storage.selectedAsset.version, ready.version); assert.equal(storage.selectedAsset.sha256, ready.sha256);
    assert.deepEqual((await listSocialCreativeThreads(store, collaborator.user.id, { campaignId: campaign.id })).threads, []);
    const colleagueThread = await createSocialCreativeThread(store, { campaignId: campaign.id, requestId: randomUUID() }, collaborator, options);
    assert.notEqual(colleagueThread.id, thread.id);
    assert.deepEqual((await getSocialCreativeThread(store, colleagueThread.id, collaborator.user.id)).turns, []);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('social_generation_jobs')} LIMIT 1`), null);
    const exported = await store.exportData();
    assert.ok(!JSON.stringify(exported).includes(thread.id));
    for (const relation of PUBLICATION_STUDIO_INTERNAL_TABLES) {
      const injected = structuredClone(exported); injected.business[relation] = [];
      await assert.rejects(() => importData(store, injected), /internos de integraciones/);
    }
    await store.db.run(`UPDATE ${store.t('social_assets')} SET version=version+1 WHERE id=?`, [ready.id]);
    assert.equal((await getSocialCreativeThread(store, thread.id, session.user.id)).thread.selectionChanged, true);
    await assert.rejects(() => saveSocialCampaign(store, { ...draft, id: campaign.id, version: campaign.version, threadVersion: storage.version, requestId: randomUUID() }, session.user.id), { status: 409 });
    await store.db.run(`DELETE FROM ${store.t('social_campaigns')} WHERE id=?`, [campaign.id]);
    assert.equal((await getSocialCreativeThread(store, thread.id, session.user.id)).thread.campaignId, null);
  });

  await t.test('dos ajustes encadenados usan el derivado exacto; una respuesta perdida no repite un cargo', async t => {
    const f = await fixture(t, factory), { store, session, options } = f;
    await saveAssistantSettings(store, { version: (await getAssistantSettings(store)).version, requestId: randomUUID(), enabled: true, provider: 'openai', baseUrl: '',
      model: 'gpt-chat-synthetic', allowPrivateNetwork: false, apiKey: key }, session, { env: options.env, verify: async () => ({ ok: true }) });
    const uploaded = await upload(f, await photo('#886655'));
    await processSocialAssetTurn(store, options);
    const original = await getSocialAsset(store, uploaded.id);
    const thread = await patch(f, await createSocialCreativeThread(store, { requestId: randomUUID() }, session, options), 'attach', original);
    let base = original, providerCalls = 0;
    const prompts = ['Aclara el fondo.', 'Conserva el encuadre y cambia el fondo.'];
    for (const [index, prompt] of prompts.entries()) {
      const input = await turn(f, thread, prompt, base.id);
      assert.equal(input.baseAsset.sha256, base.derivativeSha256);
      await assert.rejects(() => requestSocialGeneration(store, { ...input, baseAsset: { ...input.baseAsset, sha256: 'a'.repeat(64) } }, session, options), { status: 409 });
      const [job, replay] = await Promise.all([requestSocialGeneration(store, input, session, options), requestSocialGeneration(store, input, session, options)]);
      assert.equal(job.id, replay.id);
      const reloaded = await getSocialCreativeThread(store, thread.id, session.user.id);
      assert.ok(reloaded.turns.some(item => item.id === job.id && item.state === 'queued' && item.prompt === prompt));
      const generated = await photo(index === 0 ? '#0ff01a' : '#176ccc');
      await processSocialGenerationTurn(store, { ...options, transport: async (url, request) => {
        providerCalls++; assert.equal(url, 'https://api.openai.com/v1/images/edits');
        const [first, ...rest] = request.body.getAll('image[]'); assert.equal(rest.length, 0);
        assert.equal(digest(Buffer.from(await first.arrayBuffer())), base.derivativeSha256);
        assert.match(request.body.get('prompt'), new RegExp(prompt));
        return response(generated);
      } });
      assert.equal((await getSocialCreativeThread(store, thread.id, session.user.id)).turns.find(item => item.id === job.id).asset.state, 'processing');
      await processSocialAssetTurn(store, options);
      const ready = (await getSocialCreativeThread(store, thread.id, session.user.id)).turns.find(item => item.id === job.id).asset;
      assert.equal(ready.state, 'ready'); assert.notEqual(ready.id, base.id); assert.equal(ready.aiDisclosure, true);
      assert.ok(!JSON.stringify(ready).includes(prompt));
      base = ready;
    }
    assert.equal(providerCalls, 2);
    const stillOriginal = await openSocialAssetContent(store, original.id, { env: options.env, variant: 'original' });
    try { assert.equal(digest(await stillOriginal.handle.readFile()), original.originalSha256); } finally { await stillOriginal.handle.close(); }
    const before = await turn(f, thread, 'Nuevo ajuste con respuesta perdida.', base.id);
    const sent = await requestSocialGeneration(store, before, session, options);
    const lost = { ...options, transport: async () => { providerCalls++; throw new Error(key); } };
    await processSocialGenerationTurn(store, lost);
    const replay = await requestSocialGeneration(store, before, session, options);
    assert.equal(replay.id, sent.id); assert.equal(replay.state, 'uncertain');
    assert.deepEqual(await processSocialGenerationTurn(store, lost), { processed: 0, hasMore: false });
    assert.equal(providerCalls, 3);
    assert.ok(!JSON.stringify(await getSocialCreativeThread(store, thread.id, session.user.id)).includes(key));
  });
}
