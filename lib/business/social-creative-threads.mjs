import { assertAssistantSession } from '../assistant/settings.mjs';
import { fail, integer } from '../validation-core.mjs';
import { newId, stamp, insertRow } from './commands.mjs';
import { instant } from './dates.mjs';
import { getSocialAsset, socialAssetClientDTO } from './social-media.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_ATTACHMENTS = 40;
const PAGE_SIZE = 20;
const THREADS = 'social_creative_threads';
const editablePhoto = asset => asset.kind === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType);

function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('Identificador del estudio no válido.'); return value; }
function exact(input, keys) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !keys.includes(key))) fail('Solicitud del estudio no válida.');
}
function cursorPair(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) fail('Paginación del estudio no válida.');
  let pair;
  try { pair = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { fail('Paginación del estudio no válida.'); }
  if (!Array.isArray(pair) || pair.length !== 2 || instant(pair[0]) !== pair[0]) fail('Paginación del estudio no válida.');
  return [pair[0], uuid(pair[1])];
}

// The scope predicate comes from the caller's authenticated identity, never the cursor.
export async function creativePage(store, { table, where, values, cursor, order = 'created_at', limit = PAGE_SIZE }) {
  const pair = cursorPair(cursor);
  const rows = await store.db.all(`SELECT * FROM ${store.t(table)} WHERE ${where}${pair ? ` AND (${order}<? OR (${order}=? AND id<?))` : ''} ORDER BY ${order} DESC,id DESC LIMIT ?`,
    [...values, ...(pair ? [pair[0], ...pair] : []), limit + 1]);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return { rows, nextCursor: hasMore ? Buffer.from(JSON.stringify([last[order], last.id])).toString('base64url') : null };
}

const attachmentRefs = thread => JSON.parse(thread.attachments_json);
const assetIdentity = asset => ({ id: asset.id, version: asset.version, sha256: asset.sha256 });
const selectedRef = thread => thread.selected_asset_id == null ? null : { id: thread.selected_asset_id, version: thread.selected_asset_version, sha256: thread.selected_asset_sha256 };
const matches = (asset, ref) => Boolean(asset && ref && asset.id === ref.id && asset.version === ref.version && asset.sha256 === ref.sha256);
function readyAsset(asset) { return asset?.state === 'ready' && SHA.test(asset.sha256 || '') && asset.sha256 === asset.derivativeSha256; }
async function readOptionalAsset(store, id) {
  if (!id) return null;
  try { return await getSocialAsset(store, id); }
  catch (error) { if (error.status !== 404) throw error; return null; }
}
function studioAsset(asset) {
  return { ...socialAssetClientDTO(asset), editable: editablePhoto(asset) && (readyAsset(asset) || asset.state === 'failed' && asset.diagnostic?.code === 'IMAGE_GEOMETRY') };
}

export async function ownedCreativeThread(store, id, actorId) {
  const row = await store.db.get(`SELECT * FROM ${store.t(THREADS)} WHERE id=? AND actor_id=?`, [uuid(id), actorId]);
  if (!row) fail('Pieza en curso no encontrada.', 404);
  return row;
}
export function expectCreativeThreadVersion(thread, version) {
  if (thread.version !== integer(version, 'Versión de la pieza en curso', 1)) fail('La pieza en curso cambió. Recarga y revisa la selección.', 409);
}
export async function projectCreativeThread(store, row, { attachments = false } = {}) {
  const selection = selectedRef(row);
  const selected = await readOptionalAsset(store, selection?.id);
  const result = { id: row.id, campaignId: row.campaign_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    selectedAsset: readyAsset(selected) && matches(selected, selection) ? studioAsset(selected) : null, selectionChanged: Boolean(selection && (!readyAsset(selected) || !matches(selected, selection))) };
  if (attachments) {
    const assets = await Promise.all(attachmentRefs(row).map(ref => readOptionalAsset(store, ref.id)));
    result.attachments = assets.filter(Boolean).map(studioAsset);
  }
  return result;
}
export async function listSocialCreativeThreads(store, actorId, { cursor = null, campaignId = null } = {}) {
  return store.readSnapshot(async tx => {
    const { rows, nextCursor } = await creativePage(tx, { table: THREADS, where: `actor_id=? AND ${campaignId ? 'campaign_id=?' : 'campaign_id IS NULL'}`,
      values: [actorId, ...(campaignId ? [uuid(campaignId)] : [])], cursor, order: 'updated_at' });
    return { threads: await Promise.all(rows.map(row => projectCreativeThread(tx, row))), nextCursor };
  });
}
export async function createSocialCreativeThread(store, input, session, { now = stamp() } = {}) {
  exact(input, ['requestId', 'campaignId']);
  const requestId = uuid(input.requestId), campaignId = input.campaignId == null ? null : uuid(input.campaignId);
  now = instant(now);
  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    let row = await tx.db.get(`SELECT * FROM ${tx.t(THREADS)} WHERE actor_id=? AND request_id=?`, [userId, requestId]);
    if (row) {
      if (campaignId && row.campaign_id !== campaignId) fail('La solicitud ya se recibió para otro borrador.', 409);
    } else {
      if (campaignId) {
        const campaign = await tx.db.get(`SELECT state FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId]);
        if (!campaign) fail('Borrador no encontrado.', 404);
        if (campaign.state !== 'draft') fail('Solo se puede abrir el estudio de un borrador editable.', 409);
        row = await tx.db.get(`SELECT * FROM ${tx.t(THREADS)} WHERE actor_id=? AND campaign_id=?`, [userId, campaignId]);
      }
      if (!row) row = await insertRow(tx, THREADS, { id: newId(), actor_id: userId, request_id: requestId, campaign_id: campaignId, selected_asset_id: null,
        selected_asset_version: null, selected_asset_sha256: null, attachments_json: '[]', version: 1, created_at: now, updated_at: now });
    }
    return projectCreativeThread(tx, row, { attachments: true });
  });
}
export async function patchSocialCreativeThread(store, id, input, session, { now = stamp() } = {}) {
  exact(input, ['action', 'version', 'assetId', 'assetVersion']);
  if (!['attach', 'select'].includes(input.action)) fail('Acción del estudio no válida.');
  const assetId = uuid(input.assetId), version = integer(input.assetVersion, 'Versión del archivo', 1);
  now = instant(now);
  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    const row = await ownedCreativeThread(tx, id, userId);
    expectCreativeThreadVersion(row, input.version);
    const asset = await getSocialAsset(tx, assetId);
    if (asset.version !== version) fail('El archivo cambió. Recarga y revisa su versión actual.', 409);
    if (input.action === 'select' && !readyAsset(asset)) fail('Solo puedes usar una pieza con derivado listo; un archivo no apto solo se puede ajustar.', 409);
    if (input.action === 'attach' && !readyAsset(asset) && !['uploading', 'processing'].includes(asset.state) && !studioAsset(asset).editable) fail('Este archivo no se puede adjuntar. Elige otro o vuelve a subirlo.', 409);
    const refs = attachmentRefs(row);
    // Generated results are already retained by their originating job.
    if (!await threadJobAsset(tx, row, assetId)) {
      const index = refs.findIndex(ref => ref.id === assetId);
      const ref = { ...assetIdentity(asset), sha256: asset.sha256 ?? asset.originalSha256 ?? null };
      if (index !== -1) refs[index] = ref;
      else {
        if (refs.length === MAX_ATTACHMENTS) fail('Esta pieza en curso alcanzó el límite de archivos adjuntos.', 409);
        refs.push(ref);
      }
    }
    const selection = input.action === 'select' ? assetIdentity(asset) : selectedRef(row);
    const updated = await tx.db.run(`UPDATE ${tx.t(THREADS)} SET selected_asset_id=?,selected_asset_version=?,selected_asset_sha256=?,attachments_json=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
      [selection?.id ?? null, selection?.version ?? null, selection?.sha256 ?? null, JSON.stringify(refs), now, id, row.version]);
    if (!updated.changes) fail('La pieza en curso cambió. Recarga y revisa la selección.', 409);
    return projectCreativeThread(tx, await ownedCreativeThread(tx, id, userId), { attachments: true });
  });
}
function threadJobAsset(store, thread, assetId) {
  const field = store.provider === 'sqlite' ? "json_extract(data,'$.assetId')" : "data::json->>'assetId'";
  return store.db.get(`SELECT id FROM ${store.t('social_generation_jobs')} WHERE thread_id=? AND actor_id=? AND ${field}=?`, [thread.id, thread.actor_id, assetId]);
}
export async function assertCreativeBase(store, thread, assetId) {
  if (!assetId || selectedRef(thread)?.id === assetId || attachmentRefs(thread).some(ref => ref.id === assetId) || await threadJobAsset(store, thread, assetId)) return;
  if (thread.campaign_id && await store.db.get(`SELECT id FROM ${store.t('social_campaigns')} WHERE id=? AND asset_id=?`, [thread.campaign_id, assetId])) return;
  fail('Primero adjunta o elige la foto que se ajustará en este estudio.', 409);
}
export async function creativeDraftSelection(tx, { threadId, threadVersion, campaignId, assetId, actorId }) {
  const thread = await ownedCreativeThread(tx, threadId, actorId);
  if (thread.campaign_id && thread.campaign_id !== campaignId) fail('Esta pieza en curso ya está vinculada a otro borrador.', 409);
  expectCreativeThreadVersion(thread, threadVersion);
  const selection = selectedRef(thread);
  const asset = await readOptionalAsset(tx, selection?.id);
  if (!selection || assetId !== selection.id || !readyAsset(asset) || !matches(asset, selection)) fail('La pieza elegida cambió o no está lista. Vuelve al estudio a revisar y elegir el derivado.', 409);
  if (campaignId && !thread.campaign_id && await tx.db.get(`SELECT id FROM ${tx.t(THREADS)} WHERE actor_id=? AND campaign_id=?`, [actorId, campaignId])) fail('El borrador ya tiene un estudio para este administrador.', 409);
  return thread;
}
export async function linkCreativeDraftTx(tx, thread, campaignId, now) {
  if (thread.campaign_id === campaignId) return;
  const updated = await tx.db.run(`UPDATE ${tx.t(THREADS)} SET campaign_id=?,version=version+1,updated_at=? WHERE id=? AND campaign_id IS NULL AND version=?`, [campaignId, now, thread.id, thread.version]);
  if (!updated.changes) fail('La pieza en curso cambió. Recarga y revisa la selección.', 409);
}
