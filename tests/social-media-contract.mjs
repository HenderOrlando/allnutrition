import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat, rename, unlink, symlink, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createSocialAsset, uploadSocialAsset, getSocialAsset, listSocialAssets, processSocialAssetTurn, socialAssetAction, openSocialAssetContent, verifySocialMediaFiles } from '../lib/business/social-media.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { queueJobTx, claimJob } from '../lib/business/job-leases.mjs';
import { openSocialMediaFile, stageSocialMediaFile } from '../lib/social/media-files.mjs';
import { socialConnection } from './social-contract.mjs';
import { getSocialCampaign } from '../lib/business/social.mjs';

const execute = promisify(execFile), actor = 'social-media-test-admin', at = '2026-11-01T12:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const png = (width = 400, height = 500) => sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const options = env => ({ env, now: at });
async function register(store, env, bytes, contentType = 'image/png') {
  return createSocialAsset(store, { name: 'Pieza sintética', contentType, expectedBytes: typeof bytes === 'number' ? bytes : bytes.length, requestId: randomUUID() }, actor, options(env));
}
async function upload(store, env, asset, body, contentType = asset.contentType) {
  return uploadSocialAsset(store, asset.id, { version: asset.version, requestId: randomUUID(), body: Buffer.isBuffer(body) ? Readable.from([body]) : body, contentType, contentLength: asset.expectedBytes }, actor, options(env));
}
async function readyImage(store, env, bytes = null, contentType = 'image/png') {
  bytes ||= await png();
  const asset = await register(store, env, bytes, contentType);
  await upload(store, env, asset, bytes);
  const result = await processSocialAssetTurn(store, options(env));
  assert.equal(result.errorCode, null);
  const ready = await getSocialAsset(store, asset.id);
  assert.equal(ready.state, 'ready');
  return ready;
}
async function financialSnapshot(store) {
  const result = {};
  for (const table of ['orders', 'expenses', 'expense_payments', 'cash_entries', 'product_costs', 'report_snapshots', 'counters']) result[table] = await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY 1`);
  return result;
}
async function fixtureVideo(path, { width = 540, height = 960, seconds = 3, rate = 25, audio = false, container = 'mp4' } = {}) {
  await execute('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=${rate}:d=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-ar', '44100'] : ['-an']), '-metadata', 'comment=private-source-metadata', '-f', container, path], { timeout: 300000 });
}
async function rotatedMovie(source, destination) {
  // A real QuickTime track matrix keeps this fixture independent of FFmpeg's
  // version-specific rotate metadata flags. The encoded frames are unchanged.
  const bytes = await readFile(source);
  let parent = { start: 0, end: bytes.length };
  for (const type of ['moov', 'trak', 'tkhd']) {
    let child = null;
    for (let at = parent.start; at + 8 <= parent.end;) {
      const size = bytes.readUInt32BE(at);
      if (size < 8 || at + size > parent.end) throw new Error('Contenedor MOV sintético inválido.');
      if (bytes.toString('ascii', at + 4, at + 8) === type) { child = { start: at + 8, end: at + size }; break; }
      at += size;
    }
    if (!child) throw new Error('Pista MOV sintética ausente.');
    parent = child;
  }
  const version = bytes[parent.start];
  if (![0, 1].includes(version)) throw new Error('Versión de pista MOV sintética no admitida.');
  const matrix = parent.start + (version === 1 ? 52 : 40);
  if (matrix + 44 > parent.end) throw new Error('Matriz MOV sintética incompleta.');
  [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824].forEach((value, index) => bytes.writeInt32BE(value, matrix + index * 4));
  await writeFile(destination, bytes);
}
const cases = [
  ['reservas concurrentes y expiración de 24 horas no crean cuota fantasma', async (store, env) => {
    env.SOCIAL_MEDIA_QUOTA_BYTES = '8000100';
    const firstRequest = { name: 'Reserva', contentType: 'image/png', expectedBytes: 100, requestId: randomUUID() };
    const results = await Promise.allSettled([createSocialAsset(store, firstRequest, actor, options(env)), register(store, env, 100)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.find(item => item.status === 'rejected').reason.status, 413);
    const asset = results.find(item => item.status === 'fulfilled').value;
    if (results[0].status === 'fulfilled') assert.equal((await createSocialAsset(store, firstRequest, actor, options(env))).id, asset.id);
    assert.deepEqual((await listSocialAssets(store, {}, options(env))).quota, { limitBytes: 8000100, usedBytes: 0, reservedBytes: 8000100, availableBytes: 0 });
    assert.equal((await processSocialAssetTurn(store, { env, now: '2026-11-02T11:59:59.000Z' })).hasMore, false);
    assert.equal((await getSocialAsset(store, asset.id)).state, 'uploading');
    await processSocialAssetTurn(store, { env, now: '2026-11-02T12:00:00.000Z' });
    const expired = await getSocialAsset(store, asset.id);
    assert.equal(expired.state, 'failed'); assert.equal(expired.reservedBytes, 0); assert.equal(expired.bytes, 0);
    assert.equal((await listSocialAssets(store, {}, options(env))).quota.availableBytes, 8000100);
  }],
  ['stream interrumpido, corto o excesivo libera todo y no registra sus bytes sensibles', async (store, env) => {
    for (const kind of ['interrupted', 'short', 'excess']) {
      const asset = await register(store, env, 32);
      async function* body() {
        yield Buffer.from('upload-body-private-canary');
        if (kind === 'interrupted') throw new Error('upload-body-private-canary');
        if (kind === 'excess') yield Buffer.alloc(20);
      }
      await assert.rejects(() => upload(store, env, asset, body()), error => error.status === (kind === 'excess' ? 413 : 400));
      const failed = await getSocialAsset(store, asset.id);
      assert.equal(failed.state, 'failed'); assert.equal(failed.bytes, 0); assert.equal(failed.reservedBytes, 0);
      assert.deepEqual(await readdir(join(env.SOCIAL_MEDIA_DIR, asset.id)), []);
    }
    const stored = JSON.stringify([await store.db.all(`SELECT * FROM ${store.t('business_requests')}`), await store.db.all(`SELECT * FROM ${store.t('business_audit')}`)]);
    assert.equal(stored.includes('upload-body-private-canary'), false);
    assert.equal((await listSocialAssets(store, {}, options(env))).quota.reservedBytes, 0);
  }],
  ['abortar un stream pendiente cancela el PUT y libera la reserva sin esperar al productor', async (store, env) => {
    const asset = await register(store, env, 100), began = deferred(), release = deferred(), controller = new AbortController();
    async function* body() { began.resolve(); yield Buffer.alloc(10); await release.promise; yield Buffer.alloc(90); }
    const running = uploadSocialAsset(store, asset.id, { version: asset.version, requestId: randomUUID(), body: body(), contentType: asset.contentType, contentLength: 100 }, actor, { ...options(env), signal: controller.signal });
    await began.promise;
    controller.abort(new Error('private-abort-reason'));
    try { await assert.rejects(() => running, { status: 400 }); } finally { release.resolve(); }
    const failed = await getSocialAsset(store, asset.id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.bytes, 0); assert.equal(failed.reservedBytes, 0);
    assert.deepEqual(await readdir(join(env.SOCIAL_MEDIA_DIR, asset.id)), []);
  }],
  ['PUT concurrente/repetido no consume ni sobrescribe el original y la carga activa no vence antes de 24 horas', async (store, env) => {
    const bytes = await png(), asset = await register(store, env, bytes), began = deferred(), release = deferred();
    const requestId = randomUUID();
    let commercial, privateFence;
    async function* body() { began.resolve(); yield bytes.subarray(0, 20); await release.promise; yield bytes.subarray(20); }
    const input = { version: asset.version, requestId, body: body(), contentType: asset.contentType, contentLength: bytes.length };
    const running = uploadSocialAsset(store, asset.id, input, actor, options(env));
    await began.promise;
    try {
      const duplicateBody = { async *[Symbol.asyncIterator]() { assert.fail('El duplicado no debe consumir el stream.'); } };
      await assert.rejects(() => uploadSocialAsset(store, asset.id, { ...input, body: duplicateBody }, actor, options(env)), { status: 409 });
      await assert.rejects(() => uploadSocialAsset(store, asset.id, { ...input, requestId: randomUUID(), body: duplicateBody }, actor, options(env)), { status: 409 });
      await processSocialAssetTurn(store, { env, now: '2026-11-02T11:59:59.000Z' });
      assert.equal((await getSocialAsset(store, asset.id)).state, 'uploading');
      privateFence = JSON.parse((await store.db.get(`SELECT data FROM ${store.t('social_assets')} WHERE id=?`, [asset.id])).data).uploadFence;
      commercial = JSON.stringify(await store.exportData());
    } finally { release.resolve(); }
    assert.equal((await running).state, 'processing');
    assert.equal(commercial.includes(privateFence), false);
    assert.equal(commercial.includes(requestId), false);
    assert.equal((await uploadSocialAsset(store, asset.id, { ...input, body: null }, actor, options(env))).state, 'processing');
    await processSocialAssetTurn(store, options(env));
    const ready = await getSocialAsset(store, asset.id);
    assert.equal(ready.originalSha256, sha(bytes));
    assert.equal(ready.state, 'ready');
    await assert.rejects(() => upload(store, env, ready, bytes), { status: 409 });
  }],
  ['el respaldo descarta el lease de procesamiento sin invalidar el trabajo vivo ni su recuperación', async (store, env) => {
    const before = await financialSnapshot(store), bytes = await png(), asset = await register(store, env, bytes);
    await upload(store, env, asset, bytes);
    const lease = await claimJob(store, { key: `social:asset:${asset.id}`, now: at });
    const row = await store.db.get(`SELECT data FROM ${store.t('social_assets')} WHERE id=?`, [asset.id]);
    const data = JSON.stringify({ ...JSON.parse(row.data), processingFence: lease.token });
    await store.db.run(`UPDATE ${store.t('social_assets')} SET data=?,version=version+1 WHERE id=?`, [data, asset.id]);
    const commercial = JSON.stringify(await store.exportData());
    assert.equal(commercial.includes(lease.token), false);
    const campaignId = randomUUID();
    await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: null, asset_id: asset.id, name: 'Borrador con pieza en procesamiento', mode: 'organic', objective: 'reach', state: 'draft', data: '{}', version: 1, created_at: at, updated_at: at });
    const campaign = await getSocialCampaign(store, campaignId);
    assert.equal(campaign.asset.state, 'processing');
    assert.equal(JSON.stringify(campaign).includes(lease.token), false);
    assert.equal((await store.db.get(`SELECT data FROM ${store.t('social_assets')} WHERE id=?`, [asset.id])).data, data);
    await processSocialAssetTurn(store, { env, now: '2026-11-01T12:03:00.000Z' });
    assert.equal((await getSocialAsset(store, asset.id)).state, 'ready');
    assert.deepEqual(await financialSnapshot(store), before);
  }],
  ['PNG transparente y JPEG orientado producen el JPEG visto sin metadata ni efectos contables', async (store, env) => {
    const before = await financialSnapshot(store), bytes = await png();
    const ready = await readyImage(store, env, bytes);
    assert.equal(ready.originalSha256, sha(bytes));
    assert.equal(ready.bytes, ready.originalBytes + ready.derivativeBytes); assert.equal(ready.reservedBytes, 0);
    const content = await openSocialAssetContent(store, ready.id, { env });
    let jpeg;
    try { jpeg = await content.handle.readFile(); } finally { await content.handle.close(); }
    assert.equal(sha(jpeg), ready.sha256); assert.equal(ready.sha256, ready.derivativeSha256);
    const metadata = await sharp(jpeg).metadata();
    assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 400); assert.equal(metadata.height, 500);
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.orientation, undefined);
    const pixel = await sharp(jpeg).resize(1, 1).raw().toBuffer();
    assert.ok(pixel.every(channel => channel >= 250));
    const rotated = await sharp({ create: { width: 500, height: 400, channels: 3, background: 'blue' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const oriented = await readyImage(store, env, rotated, 'image/jpeg');
    assert.equal(oriented.width, 400); assert.equal(oriented.height, 500);
    const larger = await readyImage(store, env, await png(3200, 2000));
    assert.equal(larger.width, 1440); assert.equal(larger.height, 900);
    assert.deepEqual(await financialSnapshot(store), before);
  }],
  ['imágenes animadas, corruptas, disfrazadas y con geometría incompatible conservan original pero nunca ready', async (store, env) => {
    const raw = Buffer.alloc(400 * 800 * 3); raw.fill(255, 0, 400 * 400 * 3);
    const animated = await sharp(raw, { raw: { width: 400, height: 800, channels: 3, pageHeight: 400 } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
    assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
    const inputs = [
      [animated, 'image/webp'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"></svg>'), 'image/png'],
      [Buffer.from([137, 80, 78, 71, 0, 0]), 'image/png'],
      [await png(800, 400), 'image/png'],
      [await png(319, 398), 'image/png']
    ];
    for (const [bytes, type] of inputs) {
      const asset = await register(store, env, bytes, type);
      await upload(store, env, asset, bytes);
      await processSocialAssetTurn(store, options(env));
      const failed = await getSocialAsset(store, asset.id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.bytes, bytes.length); assert.equal(failed.originalBytes, bytes.length); assert.equal(failed.reservedBytes, 0); assert.equal(failed.sha256, null);
      assert.deepEqual(await readFile(join(env.SOCIAL_MEDIA_DIR, failed.originalKey)), bytes);
      await assert.rejects(() => openSocialAssetContent(store, failed.id, { env }), { status: 409 });
    }
  }],
  ['MOV con audio previo y MP4 silencioso pasan FFmpeg real a H264 progresivo 30fps sin inventar audio', async (store, env, directory) => {
    for (const audio of [true, false]) {
      const source = join(directory, audio ? 'audio.mov' : 'silent.mp4');
      await fixtureVideo(source, { audio, container: audio ? 'mov' : 'mp4' });
      const size = (await stat(source)).size, type = audio ? 'video/quicktime' : 'video/mp4';
      const asset = await register(store, env, size, type);
      await upload(store, env, asset, createReadStream(source));
      const result = await processSocialAssetTurn(store, options(env));
      assert.equal(result.errorCode, null);
      const ready = await getSocialAsset(store, asset.id);
      assert.equal(ready.state, 'ready'); assert.equal(ready.width, 540); assert.equal(ready.height, 960); assert.equal(ready.frameRate, 30); assert.equal(ready.reservedBytes, 0);
      const file = await openSocialMediaFile(ready.derivativeKey, { env, expectedSha256: ready.sha256 });
      try {
        const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file.path]);
        const observed = JSON.parse(stdout), video = observed.streams.find(stream => stream.codec_type === 'video'), sound = observed.streams.find(stream => stream.codec_type === 'audio');
        assert.equal(video.codec_name, 'h264'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(video.field_order, 'progressive'); assert.equal(video.avg_frame_rate, '30/1');
        assert.ok(Number(observed.format.duration) >= 3 && Number(observed.format.duration) <= 90);
        assert.ok(Number(observed.format.bit_rate) <= 25000000); assert.equal(observed.format.tags?.comment, undefined);
        assert.equal(Boolean(sound), audio);
        if (audio) { assert.equal(sound.codec_name, 'aac'); assert.equal(Number(sound.sample_rate), 48000); }
        assert.equal(ready.bytes, size + file.size);
      } finally { await file.handle.close(); }
    }
  }],
  ['MOV móvil con displaymatrix apaisado se valida por geometría visible y normaliza sin recortar', async (store, env, directory) => {
    const landscape = join(directory, 'mobile-source.mov'), rotated = join(directory, 'mobile-rotated.mov');
    await fixtureVideo(landscape, { width: 960, height: 540, container: 'mov' });
    await rotatedMovie(landscape, rotated);
    const asset = await register(store, env, (await stat(rotated)).size, 'video/quicktime');
    await upload(store, env, asset, createReadStream(rotated));
    assert.equal((await processSocialAssetTurn(store, options(env))).errorCode, null);
    const ready = await getSocialAsset(store, asset.id);
    assert.equal(ready.state, 'ready'); assert.equal(ready.width, 540); assert.equal(ready.height, 960);
    assert.equal(ready.sourceWidth, 540); assert.equal(ready.sourceHeight, 960); assert.equal(ready.audio, null);
  }],
  ['duración mayor de 90 segundos y video horizontal se diagnostican sin perder original ni reserva', async (store, env, directory) => {
    for (const [name, settings, code] of [['long', { seconds: 91, rate: 1 }, 'VIDEO_DURATION'], ['wide', { width: 960, height: 540 }, 'VIDEO_GEOMETRY']]) {
      const source = join(directory, `${name}.mp4`); await fixtureVideo(source, settings);
      const size = (await stat(source)).size, asset = await register(store, env, size, 'video/mp4');
      await upload(store, env, asset, createReadStream(source));
      assert.equal((await processSocialAssetTurn(store, options(env))).errorCode, code);
      const failed = await getSocialAsset(store, asset.id);
      assert.equal(failed.state, 'failed'); assert.equal(failed.bytes, size); assert.equal(failed.reservedBytes, 0);
    }
    await assert.rejects(() => register(store, env, 250 * 1024 * 1024 + 1, 'video/mp4'), { status: 400 });
  }],
  ['cuota reducida durante procesamiento no conserva derivados sin contabilizar', async (store, env) => {
    const bytes = await png(), asset = await register(store, env, bytes);
    await upload(store, env, asset, bytes);
    env.SOCIAL_MEDIA_QUOTA_BYTES = String(bytes.length + 100);
    assert.equal((await processSocialAssetTurn(store, options(env))).errorCode, 'QUOTA_EXCEEDED');
    const failed = await getSocialAsset(store, asset.id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.bytes, bytes.length); assert.equal(failed.reservedBytes, 0);
    assert.deepEqual(await readdir(join(env.SOCIAL_MEDIA_DIR, asset.id)), ['original.png']);
  }],
  ['job futuro no se reclama ni mantiene el consumidor girando', async (store, env) => {
    const bytes = await png(), asset = await register(store, env, bytes);
    await upload(store, env, asset, bytes);
    await store.db.run(`UPDATE ${store.t('job_runs')} SET data=? WHERE key=?`, [JSON.stringify({ assetId: asset.id, phase: 'processing', nextRunAt: '2026-11-01T13:00:00.000Z' }), `social:asset:${asset.id}`]);
    assert.deepEqual(await processSocialAssetTurn(store, options(env)), { processed: 0, hasMore: false, errorCode: null });
    assert.equal((await getSocialAsset(store, asset.id)).state, 'processing');
    await processSocialAssetTurn(store, { env, now: '2026-11-01T13:00:00.000Z' });
    assert.equal((await getSocialAsset(store, asset.id)).state, 'ready');
  }],
  ['lease robado antes de normalizar impide ready y otro dueño recupera el job sin tocar contabilidad', async (store, env) => {
    const before = await financialSnapshot(store), bytes = await png(), asset = await register(store, env, bytes);
    await upload(store, env, asset, bytes);
    const get = store.db.get.bind(store.db), run = store.db.run.bind(store.db); let stolen = false;
    store.db.get = async (sql, params) => {
      if (!stolen && sql.startsWith('SELECT state,lease_token,lease_until') && params[0] === `social:asset:${asset.id}`) {
        stolen = true;
        await run(`UPDATE ${store.t('job_runs')} SET lease_token=? WHERE key=?`, [randomUUID(), params[0]]);
      }
      return get(sql, params);
    };
    let result;
    try { result = await processSocialAssetTurn(store, options(env)); } finally { store.db.get = get; }
    assert.equal(stolen, true); assert.equal(result.errorCode, 'LEASE_LOST');
    assert.equal((await getSocialAsset(store, asset.id)).state, 'processing');
    assert.equal((await getSocialAsset(store, asset.id)).reservedBytes, 8000000);
    const orphan = await stageSocialMediaFile(`${asset.id}/derivative.jpg`, Readable.from([Buffer.from('uncommitted-output-after-crash')]), { env });
    try { await orphan.publish(); } finally { await orphan.discard(); }
    await processSocialAssetTurn(store, { env, now: '2026-11-01T12:03:00.000Z' });
    assert.equal((await getSocialAsset(store, asset.id)).state, 'ready');
    assert.deepEqual(await financialSnapshot(store), before);
  }],
  ['archivo alterado, symlink y path traversal no sirven contenido; el FD de preview permanece fijado', async (store, env, directory) => {
    const asset = await readyImage(store, env), path = join(env.SOCIAL_MEDIA_DIR, asset.derivativeKey);
    const original = await readFile(path), fixed = await openSocialAssetContent(store, asset.id, { env }), moved = join(directory, 'moved.jpg');
    await rename(path, moved); await symlink(moved, path);
    try {
      assert.deepEqual(await fixed.handle.readFile(), original);
      await assert.rejects(() => openSocialAssetContent(store, asset.id, { env }));
      await assert.rejects(() => openSocialMediaFile(`${asset.id}/../../moved.jpg`, { env }), { status: 400 });
    } finally { await fixed.handle.close(); await unlink(path); await rename(moved, path); }
    const tampered = Buffer.from(original); tampered[tampered.length - 5] ^= 1; await writeFile(path, tampered);
    await assert.rejects(() => openSocialAssetContent(store, asset.id, { env }), { status: 409 });
    const missing = await verifySocialMediaFiles(store, options(env));
    assert.equal(missing.missing, 1); assert.equal((await getSocialAsset(store, asset.id)).state, 'missing_file');
    await writeFile(path, original);
    const restored = await verifySocialMediaFiles(store, options(env));
    assert.equal(restored.restored, 1); assert.equal((await getSocialAsset(store, asset.id)).state, 'ready');
    const jobs = await store.db.all(`SELECT state FROM ${store.t('job_runs')} WHERE key LIKE 'social:%'`);
    assert.ok(jobs.every(job => job.state === 'succeeded'));
  }],
  ['archivo ausente conserva su hash esperado y restore incompleto exige retry explícito', async (store, env) => {
    const ready = await readyImage(store, env), path = join(env.SOCIAL_MEDIA_DIR, ready.derivativeKey), derivative = await readFile(path);
    await unlink(path);
    assert.equal((await verifySocialMediaFiles(store, options(env))).missing, 1);
    let missing = await getSocialAsset(store, ready.id);
    assert.equal(missing.restoreState, 'ready'); assert.equal(missing.derivativeSha256, ready.sha256); assert.equal(missing.bytes, missing.originalBytes);
    await assert.rejects(() => socialAssetAction(store, missing.id, 'retry-processing', { version: missing.version, requestId: randomUUID() }, actor, options(env)), { status: 409 });
    const staged = await stageSocialMediaFile(ready.derivativeKey, Readable.from([derivative]), { env, expectedBytes: derivative.length, expectedSha256: ready.sha256 });
    try { await staged.publish(); } finally { await staged.discard(); }
    await verifySocialMediaFiles(store, options(env));
    assert.equal((await getSocialAsset(store, ready.id)).state, 'ready');
    const bytes = await png(), pending = await register(store, env, bytes); await upload(store, env, pending, bytes);
    const row = await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [pending.id]), data = JSON.parse(row.data);
    await store.db.run(`UPDATE ${store.t('social_assets')} SET state='missing_file',data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...data, restoreState: 'processing', reservedBytes: 0 }), pending.id]);
    await store.db.run(`DELETE FROM ${store.t('job_runs')} WHERE key=?`, [`social:asset:${pending.id}`]);
    await verifySocialMediaFiles(store, options(env));
    const incomplete = await getSocialAsset(store, pending.id);
    assert.equal(incomplete.state, 'failed'); assert.equal(incomplete.reservedBytes, 0);
    assert.equal((await processSocialAssetTurn(store, options(env))).processed, 0);
    await socialAssetAction(store, incomplete.id, 'retry-processing', { version: incomplete.version, requestId: randomUUID() }, actor, options(env));
    await processSocialAssetTurn(store, options(env));
    assert.equal((await getSocialAsset(store, pending.id)).state, 'ready');
  }],
  ['archive protege entregas pendientes, conserva bytes y no consume jobs contables', async (store, env) => {
    const asset = await readyImage(store, env), connection = await socialConnection(store), campaignId = randomUUID();
    await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connection.id, asset_id: asset.id, name: 'Agenda sintética', mode: 'organic', objective: 'reach', state: 'scheduled', data: '{}', version: 1, created_at: at, updated_at: at });
    await assert.rejects(() => socialAssetAction(store, asset.id, 'archive', { version: asset.version, requestId: randomUUID() }, actor, options(env)), { status: 409 });
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='cancelled' WHERE id=?`, [campaignId]);
    const archived = await socialAssetAction(store, asset.id, 'archive', { version: asset.version, requestId: randomUUID() }, actor, options(env));
    assert.equal(archived.state, 'archived'); assert.equal(archived.bytes, asset.bytes);
    const content = await openSocialAssetContent(store, asset.id, { env }); await content.handle.close();
    await store.transaction(tx => queueJobTx(tx, 'payroll:synthetic', { phase: 'queued' }, { now: at }));
    assert.deepEqual(await processSocialAssetTurn(store, options(env)), { processed: 0, hasMore: false, errorCode: null });
    assert.equal((await store.db.get(`SELECT state FROM ${store.t('job_runs')} WHERE key='payroll:synthetic'`)).state, 'queued');
    assert.equal((await listSocialAssets(store, {}, options(env))).quota.usedBytes, asset.bytes);
  }]
];

export async function runSocialMediaContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory(), directory = await mkdtemp(join(tmpdir(), 'allnutrition-social-media-'));
    const env = { SOCIAL_MEDIA_DIR: join(directory, 'private') };
    try { await scenario(store, env, directory); }
    finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
