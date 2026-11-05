import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import sharp from 'sharp';
import { fail, integer, text } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { entity, newId, stamp, insertRow, updateVersioned, runCommand, audit, assertLease } from './commands.mjs';
import { queueJobTx, claimJob, renewJob, finishJob, jobClock } from './job-leases.mjs';
import { openSocialMediaFile, hashSocialMediaHandle, stageSocialMediaFile, createSocialMediaTemporary, discardSocialMediaTemporary, removeSocialMediaFile } from '../social/media-files.mjs';
import { socialConfig } from '../social/config.mjs';
import { SOCIAL_MEDIA_DIAGNOSTIC_CODES, SOCIAL_ASSET_INTERNAL_FIELDS } from '../social/evidence.mjs';

const MiB = 1024 * 1024;
const TYPES = Object.freeze({
  'image/jpeg': { kind: 'image', extension: 'jpg', format: 'jpeg', maxBytes: 10 * MiB, derivativeMax: 8000000 },
  'image/png': { kind: 'image', extension: 'png', format: 'png', maxBytes: 10 * MiB, derivativeMax: 8000000 },
  'image/webp': { kind: 'image', extension: 'webp', format: 'webp', maxBytes: 10 * MiB, derivativeMax: 8000000 },
  'video/mp4': { kind: 'video', extension: 'mp4', maxBytes: 250 * MiB, derivativeMax: 250 * MiB },
  'video/quicktime': { kind: 'video', extension: 'mov', maxBytes: 250 * MiB, derivativeMax: 250 * MiB }
});
const STATES = ['uploading', 'processing', 'ready', 'failed', 'archived', 'missing_file'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEADLINE = 300000;
const CONSTRAINTS = Object.freeze({
  image: { contentTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * MiB, maxFrames: 1, maxPixels: 40000000, minWidth: 320, maxWidth: 1440, minAspectRatio: 0.8, maxAspectRatio: 1.91, derivativeMaxBytes: 8000000, derivativeContentType: 'image/jpeg', crop: false },
  video: { contentTypes: ['video/mp4', 'video/quicktime'], maxBytes: 250 * MiB, aspectRatio: '9:16', minWidth: 540, minHeight: 960, maxWidth: 1080, maxHeight: 1920, minDurationSeconds: 3, maxDurationSeconds: 90, frameRate: 30, maxBitrate: 25000000, videoCodec: 'h264', audioCodec: 'aac', derivativeContentType: 'video/mp4', crop: false }
});
let videoProcessing = false;
function assetId(id) { if (!UUID.test(id || '')) fail('Identificador de pieza no válido.'); return id; }
function typeInfo(contentType) { if (!Object.hasOwn(TYPES, contentType)) fail('Tipo no admitido. Usa JPEG, PNG, WebP, MP4 o MOV.'); return TYPES[contentType]; }
function dataOf(asset) {
  const data = { ...asset };
  for (const field of ['id', 'state', 'sha256', 'bytes', 'version', 'createdAt', 'updatedAt']) delete data[field];
  return data;
}
function dto(asset) {
  const result = { ...asset };
  for (const key of SOCIAL_ASSET_INTERNAL_FIELDS) delete result[key];
  return result;
}
async function readAsset(store, id) {
  const asset = entity(await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [assetId(id)]));
  if (!asset) fail('Pieza no encontrada.', 404);
  return asset;
}
async function quota(store, env) {
  const limitBytes = socialConfig(env).mediaQuotaBytes;
  const reserved = store.provider === 'sqlite'
    ? "CAST(COALESCE(json_extract(data,'$.reservedBytes'),0) AS BIGINT)"
    : "CAST(COALESCE(data::json->>'reservedBytes','0') AS BIGINT)";
  const totals = await store.db.get(`SELECT COALESCE(SUM(bytes),0) AS used_bytes,COALESCE(SUM(${reserved}),0) AS reserved_bytes FROM ${store.t('social_assets')}`);
  const usedBytes = Number(totals.used_bytes), reservedBytes = Number(totals.reserved_bytes);
  if (!Number.isSafeInteger(usedBytes + reservedBytes)) fail('La cuota de piezas no tiene un valor seguro.', 409);
  return { limitBytes, usedBytes, reservedBytes, availableBytes: Math.max(0, limitBytes - usedBytes - reservedBytes) };
}
function requireQuota(usage, additional) { if (additional > usage.availableBytes) fail('No hay cuota privada suficiente para el original y su derivado máximo.', 413); }
async function saveAsset(tx, asset, fields, data) {
  await updateVersioned(tx, 'social_assets', asset.id, asset.version, { ...fields, data: JSON.stringify(data) });
  return readAsset(tx, asset.id);
}
export async function createSocialAsset(store, input, actorId, { env = process.env, now = stamp() } = {}) {
  now = instant(now);
  const name = text(input.name, 'Nombre', 200, true), contentType = text(input.contentType, 'Tipo', 100, true), info = typeInfo(contentType);
  const expectedBytes = integer(input.expectedBytes, 'Tamaño esperado', 1, info.maxBytes);
  return runCommand(store, { scope: 'social:asset:create', requestId: input.requestId, payload: { name, contentType, expectedBytes }, actorId, affectsIndicators: false }, async tx => {
    const reservedBytes = expectedBytes + info.derivativeMax;
    requireQuota(await quota(tx, env), reservedBytes);
    const id = newId(), data = { kind: info.kind, name, contentType, expectedBytes, originalKey: `${id}/original.${info.extension}`, reservedBytes, uploadExpiresAt: new Date(Date.parse(now) + 86400000).toISOString() };
    await insertRow(tx, 'social_assets', { id, state: 'uploading', sha256: null, bytes: 0, data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
    const asset = await readAsset(tx, id);
    await audit(tx, { entityType: 'social_asset', entityId: id, actorId, next: dto(asset), reason: 'Reserva de cuota para carga privada.', recordedAt: now });
    return dto(asset);
  });
}
export async function listSocialAssets(store, filters = {}, { env = process.env, now = stamp() } = {}) {
  instant(now);
  const limit = integer(filters.limit == null ? 20 : Number(filters.limit), 'Límite', 1, 100), offset = integer(filters.offset == null ? 0 : Number(filters.offset), 'Desplazamiento', 0, 10000000);
  if (filters.state != null && !STATES.includes(filters.state)) fail('Estado de pieza no válido.');
  return store.readSnapshot(async tx => {
    const assets = await tx.db.all(`SELECT * FROM ${tx.t('social_assets')} ${filters.state ? 'WHERE state=?' : ''} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`, [...(filters.state ? [filters.state] : []), limit, offset]);
    return { assets: assets.map(row => dto(entity(row))), quota: await quota(tx, env), constraints: CONSTRAINTS };
  });
}
export async function getSocialAsset(store, id) { return dto(await readAsset(store, id)); }

export async function uploadSocialAsset(store, id, input, actorId, { env = process.env, now = stamp(), signal } = {}) {
  id = assetId(id); now = instant(now);
  const version = integer(input.version, 'Versión', 1), contentType = text(input.contentType, 'Tipo', 100, true);
  typeInfo(contentType);
  const contentLength = input.contentLength == null ? null : integer(input.contentLength, 'Content-Length', 1, TYPES[contentType].maxBytes);
  const fence = newId(), clock = jobClock(now), controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(DEADLINE), ...(signal ? [signal] : [])]);
  const started = await runCommand(store, { scope: `social:asset:upload:${id}`, requestId: input.requestId, payload: { id, version, contentType, contentLength }, actorId, affectsIndicators: false }, async tx => {
    const asset = await readAsset(tx, id);
    if (asset.version !== version || asset.state !== 'uploading' || asset.uploadFence) fail('La carga ya empezó o la pieza cambió. Recarga antes de continuar.', 409);
    if (asset.uploadExpiresAt <= clock()) fail('La reserva de esta carga caducó. Registra una pieza nueva.', 409);
    if (contentType !== asset.contentType || contentLength != null && contentLength !== asset.expectedBytes) fail('El tipo o tamaño de carga no coincide con el registro.');
    await saveAsset(tx, asset, {}, { ...dataOf(asset), uploadFence: fence, uploadRequestId: input.requestId, uploadStartedAt: clock() });
    await audit(tx, { entityType: 'social_asset', entityId: id, actorId, reason: 'Inicio de carga privada.', recordedAt: clock() });
    return { fence };
  });
  if (started.fence !== fence) {
    const asset = await readAsset(store, id);
    if (asset.state === 'uploading') fail('La misma carga sigue en curso.', 409);
    return dto(asset);
  }
  let staged = null, published = false;
  try {
    const asset = await readAsset(store, id);
    staged = await stageSocialMediaFile(asset.originalKey, input.body, { env, expectedBytes: asset.expectedBytes, maxBytes: TYPES[contentType].maxBytes, signal: combined, temporaryId: fence });
    combined.throwIfAborted();
    const current = await readAsset(store, id);
    if (current.state !== 'uploading' || current.uploadFence !== fence || current.uploadExpiresAt <= clock()) fail('La carga perdió su reserva o venció.', 409);
    await staged.publish(); published = true;
    return await runCommand(store, { scope: `social:asset:uploaded:${id}`, requestId: input.requestId, payload: { id, fence, sha256: staged.sha256, bytes: staged.bytes }, actorId, affectsIndicators: false }, async tx => {
      const current = await readAsset(tx, id);
      if (current.state !== 'uploading' || current.uploadFence !== fence || current.uploadExpiresAt <= clock()) fail('La carga perdió su reserva o venció.', 409);
      const data = { ...dataOf(current), originalSha256: staged.sha256, originalBytes: staged.bytes, reservedBytes: TYPES[contentType].derivativeMax };
      delete data.uploadFence; delete data.uploadRequestId; delete data.diagnostic;
      const next = await saveAsset(tx, current, { state: 'processing', bytes: staged.bytes }, data);
      await queueJobTx(tx, `social:asset:${id}`, { assetId: id, phase: 'processing' }, { now: clock() });
      await audit(tx, { entityType: 'social_asset', entityId: id, actorId, next: dto(next), reason: 'Original privado recibido; procesamiento pendiente.', recordedAt: clock() });
      return dto(next);
    });
  } catch (error) {
    await staged?.discard();
    const failed = await runCommand(store, { scope: `social:asset:upload-failed:${id}`, requestId: input.requestId, payload: { id, fence }, actorId, affectsIndicators: false }, async tx => {
      const current = await readAsset(tx, id);
      if (current.state !== 'uploading' || current.uploadFence !== fence) return false;
      const data = { ...dataOf(current), reservedBytes: 0, diagnostic: { code: 'UPLOAD_INTERRUPTED', message: 'Carga incompleta o interrumpida. Registra una pieza nueva para volver a cargar.' } };
      delete data.uploadFence; delete data.uploadRequestId;
      await saveAsset(tx, current, { state: 'failed', bytes: 0 }, data);
      await audit(tx, { entityType: 'social_asset', entityId: id, actorId, reason: data.diagnostic.message, recordedAt: clock() });
      return true;
    });
    if (published && failed) await removeSocialMediaFile(`${id}/original.${TYPES[contentType].extension}`, { env, expectedSha256: staged.sha256 });
    if (error.status) throw error;
    fail('La carga se interrumpió; se liberó su reserva. Registra una pieza nueva.', 400);
  } finally { controller.abort(); await staged?.discard(); }
}
async function requireArchivable(tx, id) {
  const pending = await tx.db.get(`SELECT c.id FROM ${tx.t('social_campaigns')} c WHERE c.asset_id=? AND (c.state IN ('ready','scheduled','publishing','partial','in_review','active','paused','needs_attention') OR EXISTS (SELECT 1 FROM ${tx.t('social_deliveries')} d WHERE d.campaign_id=c.id AND d.state IN ('queued','preparing','ready','scheduled','publishing','in_review','active','paused','uncertain','blocked'))) LIMIT 1`, [id]);
  if (pending) fail('La pieza tiene una entrega pendiente o pauta que aún la necesita. Cancela o completa ese trabajo antes de archivarla.', 409);
}
export async function socialAssetAction(store, id, action, input, actorId, { env = process.env, now = stamp() } = {}) {
  id = assetId(id); now = instant(now);
  if (!['archive', 'retry-processing'].includes(action)) fail('Acción de pieza no válida.');
  const version = integer(input.version, 'Versión', 1);
  return runCommand(store, { scope: `social:asset:${action}:${id}`, requestId: input.requestId, payload: { id, action, version }, actorId, affectsIndicators: false }, async tx => {
    const asset = await readAsset(tx, id);
    if (asset.version !== version) fail('La pieza cambió. Recarga antes de continuar.', 409);
    const data = dataOf(asset);
    if (action === 'archive') {
      if (['uploading', 'processing', 'missing_file'].includes(asset.state)) fail('Termina la carga/procesamiento o verifica sus archivos antes de archivar.', 409);
      await requireArchivable(tx, id);
      data.archivedFrom = asset.state; data.reservedBytes = 0;
    } else {
      if (asset.state !== 'failed' || !HASH.test(asset.originalSha256 || '') || !asset.originalBytes || asset.derivativeKey) fail('La pieza no tiene un original íntegro pendiente de procesamiento. Verifica/restaura el archivo o registra una carga nueva.', 409);
      requireQuota(await quota(tx, env), TYPES[asset.contentType].derivativeMax);
      data.reservedBytes = TYPES[asset.contentType].derivativeMax; delete data.diagnostic;
      await queueJobTx(tx, `social:asset:${id}`, { assetId: id, phase: 'processing' }, { now });
    }
    const next = await saveAsset(tx, asset, { state: action === 'archive' ? 'archived' : 'processing' }, data);
    await audit(tx, { entityType: 'social_asset', entityId: id, actorId, previous: dto(asset), next: dto(next), reason: action === 'archive' ? 'Pieza archivada; archivos e historia conservados.' : 'Reintento explícito del procesamiento.', recordedAt: now });
    return dto(next);
  });
}
function mediaError(code, message) { const error = new Error(message); error.mediaCode = code; return error; }
async function processImage(asset, handle, output, signal) {
  const input = `/dev/fd/${handle.fd}`;
  let metadata;
  try { metadata = await sharp(input, { animated: true, limitInputPixels: 40000000, failOn: 'error' }).metadata(); }
  catch { throw mediaError('INVALID_IMAGE', 'El original no es una imagen válida de hasta 40 megapíxeles.'); }
  if (metadata.format !== TYPES[asset.contentType].format) throw mediaError('CONTENT_TYPE_MISMATCH', 'El contenido real no coincide con el tipo de imagen registrado.');
  if ((metadata.pages || 1) !== 1) throw mediaError('ANIMATED_IMAGE', 'La imagen debe contener un único frame; no se admiten imágenes animadas.');
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = swapped ? metadata.height : metadata.width, height = swapped ? metadata.width : metadata.height;
  if (!width || !height || width * height > 40000000) throw mediaError('IMAGE_PIXELS', 'La imagen debe tener dimensiones válidas y como máximo 40 megapíxeles.');
  if (width < 320 || width / height < 0.8 || width / height > 1.91) throw mediaError('IMAGE_GEOMETRY', 'Corrige la pieza fuera de la herramienta: ancho mínimo 320 px y proporción entre 4:5 y 1.91:1, sin recorte automático.');
  const pipeline = sharp(input, { limitInputPixels: 40000000, failOn: 'error' }).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').resize({ width: 1440, withoutEnlargement: true }).jpeg({ quality: 90, chromaSubsampling: '4:2:0' });
  const abort = () => pipeline.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); await pipeline.toFile(output); signal.throwIfAborted(); }
  catch (error) { if (signal.aborted) throw error; throw mediaError('INVALID_IMAGE', 'No fue posible decodificar y normalizar la imagen completa.'); }
  finally { signal.removeEventListener('abort', abort); }
  const result = await sharp(output, { failOn: 'error' }).metadata();
  if (result.format !== 'jpeg' || result.width < 320 || result.width > 1440 || result.width / result.height < 0.8 || result.width / result.height > 1.91 || result.orientation || result.exif || result.icc) throw mediaError('INVALID_DERIVATIVE', 'La imagen normalizada no cumple las restricciones de publicación.');
  return { width: result.width, height: result.height, sourceWidth: width, sourceHeight: height, frameCount: 1, colourSpace: result.space, durationSeconds: null, frameRate: null };
}
function subprocess(command, args, signal, inputHandle = null) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore', ...(inputHandle ? [inputHandle.fd] : [])], windowsHide: true });
    const chunks = []; let bytes = 0, failure = null, killTimer = null;
    const abort = () => { failure ||= signal.reason || mediaError('PROCESSING_ABORTED', 'Procesamiento detenido.'); child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MiB) { failure = mediaError('INVALID_VIDEO', 'La inspección excedió el límite técnico de salida.'); abort(); } else chunks.push(chunk); });
    child.on('error', error => { failure = error.code === 'ENOENT' ? mediaError('PROCESSOR_UNAVAILABLE', 'FFmpeg/ffprobe no está disponible en este worker.') : mediaError('PROCESSING_FAILED', 'No fue posible iniciar el procesador multimedia.'); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort); clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(mediaError('INVALID_VIDEO', 'El archivo no pudo inspeccionarse o convertirse como video válido.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function probe(path, signal, inputHandle = null) {
  const raw = await subprocess('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], signal, inputHandle);
  try { return JSON.parse(raw); } catch { throw mediaError('INVALID_VIDEO', 'FFprobe no devolvió metadatos válidos.'); }
}
function fraction(value) { const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value)); return match ? Number(match[1]) / Number(match[2] || 1) : NaN; }
function videoDetails(metadata) {
  const videos = metadata.streams?.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic) || [];
  if (videos.length !== 1) throw mediaError('INVALID_VIDEO', 'El archivo debe contener una única pista de video.');
  const video = videos[0], audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  const rotation = Number(video.side_data_list?.find(data => data.rotation != null)?.rotation ?? video.tags?.rotate ?? 0);
  if (![0, 90, 180, 270, -90, -180, -270].includes(rotation)) throw mediaError('VIDEO_GEOMETRY', 'La rotación del video no permite una pieza vertical válida.');
  const swapped = Math.abs(rotation) % 180 === 90;
  const width = Number(swapped ? video.height : video.width), height = Number(swapped ? video.width : video.height);
  const durationSeconds = Number(video.duration || metadata.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 90) throw mediaError('VIDEO_DURATION', 'El video debe durar entre 3 y 90 segundos.');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 540 || height < 960 || width * 16 !== height * 9 || !['1:1', 'N/A', undefined].includes(video.sample_aspect_ratio)) throw mediaError('VIDEO_GEOMETRY', 'Corrige el video fuera de la herramienta: vertical 9:16, píxeles cuadrados y mínimo 540×960, sin recorte automático.');
  if (!metadata.format?.format_name?.split(',').includes('mov') && !metadata.format?.format_name?.split(',').includes('mp4')) throw mediaError('INVALID_VIDEO', 'El contenedor real debe ser MP4 o MOV.');
  return { video, audio, width, height, durationSeconds, frameRate: fraction(video.avg_frame_rate) };
}
async function faststart(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = (await handle.stat()).size, header = Buffer.alloc(16); let offset = 0, moov = -1, mdat = -1;
    while (offset + 8 <= size) {
      await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0), headerSize = 8;
      if (boxSize === 1) { const big = header.readBigUInt64BE(8); if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false; boxSize = Number(big); headerSize = 16; }
      if (boxSize === 0) boxSize = size - offset;
      if (boxSize < headerSize || offset + boxSize > size) return false;
      const type = header.toString('ascii', 4, 8);
      if (type === 'moov') moov = offset;
      if (type === 'mdat') { mdat = offset; break; }
      offset += boxSize;
    }
    return moov >= 0 && mdat > moov;
  } finally { await handle.close(); }
}
async function processVideo(asset, inputHandle, output, signal) {
  const input = '/dev/fd/3', source = videoDetails(await probe(input, signal, inputHandle));
  const width = Math.floor(Math.min(source.width, 1080) / 18) * 18, height = width * 16 / 9;
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-map', `0:${source.video.index}`, ...(source.audio ? ['-map', `0:${source.audio.index}`] : ['-an']),
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '24M', '-bufsize', '48M',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
    '-x264-params', 'open-gop=0:interlaced=0', '-pix_fmt', 'yuv420p', '-r', '30', '-fps_mode', 'cfr',
    ...(source.audio ? ['-c:a', 'aac', '-ar', '48000', '-b:a', '128k'] : []),
    '-movflags', '+faststart', '-f', 'mp4', output
  ];
  await subprocess('ffmpeg', args, signal, inputHandle);
  const metadata = await probe(output, signal), result = videoDetails(metadata);
  const bitrate = Number(metadata.format.bit_rate), videoBitrate = Number(result.video.bit_rate);
  if (result.width > 1080 || result.height > 1920 || result.video.codec_name !== 'h264' || result.video.pix_fmt !== 'yuv420p' || result.video.field_order !== 'progressive' || result.frameRate !== 30 || fraction(result.video.r_frame_rate) !== 30 || !Number.isFinite(bitrate) || bitrate > 25000000 || !Number.isFinite(videoBitrate) || videoBitrate > 25000000 || Boolean(result.audio) !== Boolean(source.audio) || result.audio && (result.audio.codec_name !== 'aac' || Number(result.audio.sample_rate) !== 48000) || !await faststart(output)) throw mediaError('INVALID_DERIVATIVE', 'El video normalizado no cumple H.264/AAC, progresivo, 30 fps, bitrate y faststart requeridos.');
  return { width: result.width, height: result.height, durationSeconds: result.durationSeconds, frameRate: 30, sourceWidth: source.width, sourceHeight: source.height, sourceDurationSeconds: source.durationSeconds, sourceFrameRate: Number.isFinite(source.frameRate) ? source.frameRate : null, videoCodec: 'h264', pixelFormat: 'yuv420p', progressive: true, closedGop: true, bitrate, audio: result.audio ? { codec: 'aac', sampleRate: 48000, bitrate: Number(result.audio.bit_rate) || null } : null, faststart: true };
}
async function expireUploads(store, { env, now }) {
  const expired = await store.transaction(async tx => {
    await tx.lockWrites(); const result = [];
    const expiry = tx.provider === 'sqlite' ? "json_extract(data,'$.uploadExpiresAt')" : "data::json->>'uploadExpiresAt'";
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_assets')} WHERE state='uploading' AND ${expiry}<=?`, [now])) {
      const asset = entity(row), data = { ...dataOf(asset), reservedBytes: 0, diagnostic: { code: 'UPLOAD_EXPIRED', message: 'La carga incompleta venció después de 24 horas. Registra una pieza nueva.' } };
      delete data.uploadFence; delete data.uploadRequestId;
      await saveAsset(tx, asset, { state: 'failed', bytes: 0 }, data);
      await audit(tx, { entityType: 'social_asset', entityId: asset.id, actorId: 'scheduler', reason: data.diagnostic.message, source: 'scheduler', recordedAt: now });
      result.push(asset);
    }
    return result;
  });
  for (const asset of expired) {
    if (asset.uploadFence) await discardSocialMediaTemporary(asset.id, asset.uploadFence, { env });
    await removeSocialMediaFile(asset.originalKey, { env }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function assetJob(store, lease, { env, now, signal }) {
  const controller = new AbortController(), clock = jobClock(now), combined = AbortSignal.any([controller.signal, AbortSignal.timeout(DEADLINE), ...(signal ? [signal] : [])]);
  let pending = null, lost = null, temporary = null, original = null, ownsVideo = false, outputKey = null, staleFence = null, readyCommitted = false;
  const timer = setInterval(() => {
    if (pending || lost) return;
    pending = renewJob(store, lease, { now: clock() }).catch(error => { lost = error; controller.abort(error); }).finally(() => { pending = null; });
  }, 30000); timer.unref();
  const assertActive = async () => { combined.throwIfAborted(); if (lost) throw lost; await assertLease(store, { ...lease, now: clock() }); };
  try {
    const asset = await store.transaction(async tx => {
      await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
      const current = await readAsset(tx, lease.assetId || lease.key.slice('social:asset:'.length));
      if (current.state !== 'processing') return null;
      staleFence = current.processingFence || null;
      return saveAsset(tx, current, {}, { ...dataOf(current), processingFence: lease.token });
    });
    if (!asset) { await finishJob(store, lease, { now: clock() }); return null; }
    if (asset.kind === 'video') {
      if (videoProcessing) { await finishJob(store, lease, { state: 'queued', now: clock() }); return 'VIDEO_BUSY'; }
      videoProcessing = true; ownsVideo = true;
    }
    if (asset.derivativeKey || asset.sha256) throw mediaError('IMMUTABLE_ASSET', 'Una pieza con derivado conservado no se puede sobrescribir.');
    if (staleFence && staleFence !== lease.token) await discardSocialMediaTemporary(asset.id, staleFence, { env });
    original = await openSocialMediaFile(asset.originalKey, { env, expectedSha256: asset.originalSha256, expectedBytes: asset.originalBytes, signal: combined });
    await assertActive();
    const extension = asset.kind === 'image' ? 'jpg' : 'mp4', key = `${asset.id}/derivative.${extension}`;
    outputKey = key;
    // Only an unapproved, unreferenced output from an interrupted processor can
    // exist here. Its lease is fenced before removing it; originals never change.
    await removeSocialMediaFile(key, { env, signal: combined });
    temporary = await createSocialMediaTemporary(asset.id, extension, { env, temporaryId: lease.token });
    await temporary.handle.close();
    const metadata = asset.kind === 'image' ? await processImage(asset, original.handle, temporary.path, combined) : await processVideo(asset, original.handle, temporary.path, combined);
    await assertActive();
    const handle = await open(temporary.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > TYPES[asset.contentType].derivativeMax || !stat.size) throw mediaError('DERIVATIVE_SIZE', 'El derivado excede el límite de bytes publicables.');
      output = await hashSocialMediaHandle(handle, { signal: combined });
      await handle.sync();
    } finally { await handle.close(); }
    // A prior owner can have published before losing its DB lease. Never
    // overwrite that file: accept it only if its complete bytes are identical.
    await assertActive();
    try { await temporary.publish(key); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await openSocialMediaFile(key, { env, expectedSha256: output.sha256, expectedBytes: output.bytes, signal: combined });
      await existing.handle.close();
    }
    await assertActive();
    await store.transaction(async tx => {
      await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
      const current = await readAsset(tx, asset.id);
      if (current.state !== 'processing' || current.processingFence !== lease.token) fail('El procesamiento perdió la propiedad de la pieza.', 409);
      const usage = await quota(tx, env), retained = current.originalBytes + output.bytes;
      if (usage.usedBytes + usage.reservedBytes - current.bytes - current.reservedBytes + retained > usage.limitBytes) throw mediaError('QUOTA_EXCEEDED', 'La cuota configurada ya no permite conservar el derivado.');
      const data = { ...dataOf(current), ...metadata, derivativeKey: key, derivativeSha256: output.sha256, derivativeBytes: output.bytes, derivativeContentType: asset.kind === 'image' ? 'image/jpeg' : 'video/mp4', reservedBytes: 0 };
      delete data.processingFence; delete data.diagnostic; delete data.restoreState;
      const next = await saveAsset(tx, current, { state: 'ready', sha256: output.sha256, bytes: retained }, data);
      await audit(tx, { entityType: 'social_asset', entityId: asset.id, actorId: 'scheduler', next: dto(next), reason: 'Derivado real normalizado y verificado.', source: 'scheduler', recordedAt: clock() });
    });
    readyCommitted = true;
    await finishJob(store, lease, { now: clock() });
    return null;
  } catch (error) {
    const diagnostic = SOCIAL_MEDIA_DIAGNOSTIC_CODES.includes(error.mediaCode) ? { code: error.mediaCode, message: error.message } : combined.aborted ? { code: lost ? 'LEASE_LOST' : 'PROCESSING_ABORTED', message: lost ? 'El worker perdió el lease. El nuevo dueño debe recuperar el procesamiento.' : 'El procesamiento se interrumpió o superó cinco minutos; puedes reintentarlo explícitamente.' } : { code: 'PROCESSING_FAILED', message: 'El original no pudo procesarse o no coincide con su SHA-256. Verifica el archivo y reintenta explícitamente.' };
    if (readyCommitted) return lost || error.status === 409 ? 'LEASE_LOST' : diagnostic.code;
    if (!lost) {
      try {
        if (outputKey) {
          await assertLease(store, { ...lease, now: clock() });
          await removeSocialMediaFile(outputKey, { env });
        }
        await store.transaction(async tx => {
          await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
          const asset = await readAsset(tx, lease.assetId || lease.key.slice('social:asset:'.length));
          if (asset.state !== 'processing' || asset.processingFence !== lease.token) return;
          const data = { ...dataOf(asset), reservedBytes: 0, diagnostic }; delete data.processingFence;
          await saveAsset(tx, asset, { state: 'failed', bytes: asset.originalBytes || 0 }, data);
          await audit(tx, { entityType: 'social_asset', entityId: asset.id, actorId: 'scheduler', reason: diagnostic.message, source: 'scheduler', recordedAt: clock() });
        });
        await finishJob(store, lease, { state: 'failed', errorCode: diagnostic.code, now: clock() });
      } catch (leaseError) { if (leaseError.status !== 409) throw leaseError; diagnostic.code = 'LEASE_LOST'; }
    }
    return diagnostic.code;
  } finally {
    clearInterval(timer); controller.abort(); if (pending) await pending;
    await temporary?.discard(); await original?.handle.close();
    if (ownsVideo) videoProcessing = false;
  }
}
async function dueAssetJob(store, now) {
  const next = store.provider === 'sqlite' ? "json_extract(data,'$.nextRunAt')" : "data::json->>'nextRunAt'";
  return store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'social:asset:%' AND (state='queued' OR (state='running' AND lease_until<=?)) AND (${next} IS NULL OR ${next}<=?) ORDER BY created_at,key LIMIT 1`, [now, now]);
}
async function claimDueAssetJob(store, now) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const row = await dueAssetJob(tx, now);
    return row ? claimJob({ transaction: fn => fn(tx) }, { key: row.key, now }) : null;
  });
}
export async function processSocialAssetTurn(store, { now = stamp(), maxAssets = 1, env = process.env, signal } = {}) {
  now = instant(now); integer(maxAssets, 'Máximo de piezas', 1, 100);
  const clock = jobClock(now); let processed = 0, errorCode = null;
  await expireUploads(store, { env, now: clock() });
  while (processed < maxAssets && !signal?.aborted) {
    const lease = await claimDueAssetJob(store, clock());
    if (!lease) break;
    const result = await assetJob(store, lease, { env, now: clock(), signal });
    if (result === 'VIDEO_BUSY') break;
    processed++; errorCode ||= result;
  }
  const due = await dueAssetJob(store, clock());
  return { processed, hasMore: Boolean(due), errorCode };
}
export async function openSocialAssetContent(store, id, { variant = 'derivative', env = process.env } = {}) {
  if (!['original', 'derivative'].includes(variant)) fail('Variante de pieza no válida.');
  const asset = await readAsset(store, id);
  if (variant === 'derivative' && !['ready', 'archived'].includes(asset.state)) fail('La pieza no tiene una vista previa publicable verificada.', 409);
  const key = asset[`${variant}Key`], sha256 = asset[`${variant}Sha256`], bytes = asset[`${variant}Bytes`];
  if (!key || !HASH.test(sha256 || '') || !bytes) fail('El archivo de esta variante no está disponible.', 404);
  let file;
  try { file = await openSocialMediaFile(key, { env, expectedSha256: sha256, expectedBytes: bytes }); }
  catch (error) { if (error.code === 'ENOENT') fail('Falta el archivo privado; restaura y verifica el volumen.', 404); throw error; }
  return { handle: file.handle, size: file.size, contentType: variant === 'original' ? asset.contentType : asset.derivativeContentType, sha256, filename: key.split('/')[1], kind: asset.kind };
}
export async function verifySocialMediaFiles(store, { env = process.env, now = stamp() } = {}) {
  now = instant(now);
  const counts = { checked: 0, filesChecked: 0, verified: 0, missing: 0, restored: 0, failed: 0, skipped: 0 };
  for (const row of await store.db.all(`SELECT * FROM ${store.t('social_assets')} ORDER BY id`)) {
    const asset = entity(row); counts.checked++;
    if (asset.state === 'uploading' || asset.state === 'processing') { counts.skipped++; continue; }
    let missing = false, hasOriginal = false, hasDerivative = false, retainedBytes = 0;
    for (const variant of ['original', 'derivative']) {
      const key = asset[`${variant}Key`], sha256 = asset[`${variant}Sha256`], bytes = asset[`${variant}Bytes`];
      if (!sha256 || !bytes) continue;
      counts.filesChecked++;
      try {
        const file = await openSocialMediaFile(key, { env });
        retainedBytes += file.size;
        const matches = file.sha256 === sha256 && file.size === bytes;
        await file.handle.close();
        if (!matches) missing = true;
        else if (variant === 'original') hasOriginal = true;
        else hasDerivative = true;
      } catch (error) {
        if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code) && error.status !== 409 && error.status !== 400) throw error;
        missing = true;
      }
    }
    const previousState = ['uploading', 'processing', 'ready', 'failed', 'archived'].includes(asset.restoreState) ? asset.restoreState : asset.state === 'missing_file' ? 'failed' : asset.state;
    if ((previousState === 'ready' || previousState === 'archived' && asset.archivedFrom === 'ready') && (!hasOriginal || !hasDerivative)) missing = true;
    if (asset.originalSha256 && !hasOriginal || asset.derivativeSha256 && !hasDerivative) missing = true;
    let state = asset.state, data = dataOf(asset);
    if (missing) {
      state = 'missing_file'; data.restoreState = previousState;
      data.reservedBytes = 0; data.diagnostic = { code: 'MISSING_FILE', message: 'Falta un archivo privado o su SHA-256 no coincide. Restaura el archivo exacto antes de publicar.' };
    } else if (asset.state === 'missing_file') {
      state = hasOriginal && hasDerivative && ['ready', 'archived'].includes(previousState) ? previousState : 'failed';
      data.reservedBytes = 0; delete data.restoreState; delete data.uploadFence; delete data.uploadRequestId; delete data.processingFence;
      if (state === 'failed') data.diagnostic = { code: 'RESTORED_ORIGINAL_ONLY', message: hasOriginal ? 'Original recuperado; requiere reintento explícito de procesamiento.' : 'Carga incompleta sin original recuperable. Registra una pieza nueva.' };
      else delete data.diagnostic;
    }
    if (asset.state === 'missing_file') {
      if (asset.uploadFence) await discardSocialMediaTemporary(asset.id, asset.uploadFence, { env });
      if (asset.processingFence) await discardSocialMediaTemporary(asset.id, asset.processingFence, { env });
    }
    if (state !== asset.state || retainedBytes !== asset.bytes || JSON.stringify(data) !== JSON.stringify(dataOf(asset))) {
      const changed = await store.transaction(async tx => {
        await tx.lockWrites(); const current = await readAsset(tx, asset.id);
        if (current.version !== asset.version) return false;
        await saveAsset(tx, current, { state, bytes: retainedBytes }, data);
        await audit(tx, { entityType: 'social_asset', entityId: asset.id, actorId: 'social-media-verify', reason: missing ? data.diagnostic.message : 'Archivos privados cotejados por SHA-256 con la evidencia de la BD.', source: 'restore', recordedAt: now });
        return true;
      });
      if (!changed) { counts.skipped++; continue; }
      if (!missing && state !== 'failed') counts.restored++;
    }
    if (missing) counts.missing++;
    else if (state === 'failed') counts.failed++;
    else counts.verified++;
  }
  return counts;
}
