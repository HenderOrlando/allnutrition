import { createHash } from 'node:crypto';
import { fail, text } from '../validation-core.mjs';
import { createHekaWorkbook, normalizeHekaIdentity, validateHekaImportOrigin } from '../shipping/heka.mjs';
import { hash, stamp } from './commands.mjs';
import { getShippingSnapshot } from './shipping-bridge.mjs';
import { createImportBatch, uploadImportFile, updateImportBatch, requestImportPreview, processImportTurn, validateImportConfig } from './imports.mjs';

// All nested business APIs use the same write reservation, on both SQLite and PostgreSQL.
function facade(tx) {
  const store = Object.create(tx);
  store.transaction = fn => fn(tx);
  store.readSnapshot = fn => fn(tx);
  return store;
}
const requestFor = (snapshotId, stage) => `heka:${hash([snapshotId, stage])}`;
const resultOf = (batch, sourceId, preparing) => ({ batchId: batch.id, sourceId, state: batch.state, preparing });
async function batchRow(tx, id) {
  const row = await tx.db.get(`SELECT * FROM ${tx.t('import_batches')} WHERE id=?`, [id]);
  if (!row) fail('El lote de esta captura ya no está disponible.', 409);
  return { ...row, data: JSON.parse(row.data) };
}
async function saveData(tx, row, data) {
  await tx.db.run(`UPDATE ${tx.t('import_batches')} SET data=?,version=version+1,updated_at=? WHERE id=? AND version=?`, [JSON.stringify(data), stamp(), row.id, row.version]);
}
async function authorizedSnapshot(tx, input, actorId, options) {
  if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
  const capture = await getShippingSnapshot(facade(tx), input.snapshotId, options);
  if (capture.sourceId !== input.sourceId) fail('La captura no pertenece a la fuente seleccionada.', 409);
  // Snapshot access rechecks its authorized actor, source and platform, including after revocation.
  if (hash(capture.snapshot) !== capture.payloadHash || capture.snapshot.query.queryId !== capture.queryId || capture.snapshot.capturedAt !== capture.capturedAt) fail('La captura no coincide con su origen inmutable.', 409);
  return capture;
}
async function attachedBatch(tx, capture) {
  const row = await batchRow(tx, capture.importBatchId);
  const origin = validateHekaImportOrigin(row.data.shippingOrigin, { sourceId: capture.sourceId, fileHash: row.file_hash });
  if (row.file_bytes_base64 && createHash('sha256').update(Buffer.from(row.file_bytes_base64, 'base64')).digest('hex') !== row.file_hash) fail('El archivo original no coincide con su huella.', 409);
  if (row.source_id !== capture.sourceId || origin.snapshotId !== capture.id || origin.sourceHash !== capture.payloadHash
    || origin.accountFingerprint !== hash(normalizeHekaIdentity(capture.snapshot.account)) || hash(origin.query) !== hash(capture.snapshot.query)) fail('El lote no corresponde a esta captura.', 409);
  if (!row.data.shippingPreparation) fail('La preparación del lote no está disponible.', 409);
  return row;
}

export async function prepareShippingImport(store, input, actorId, options = {}) {
  const requestId = text(input.requestId, 'Identificador de operación', 100, true);
  if (!/^[\w:-]{8,100}$/.test(requestId)) fail('Identificador de operación no válido.');
  const snapshotId = text(input.snapshotId, 'Captura', 100, true), sourceId = text(input.sourceId, 'Fuente', 100, true);
  actorId = text(actorId, 'Administrador', 100, true);
  const selection = { snapshotId, sourceId };
  // Reservation, immutable upload, provenance and snapshot linkage commit together or not at all.
  const state = await store.transaction(async tx => {
    await tx.lockWrites();
    const capture = await authorizedSnapshot(tx, selection, actorId, options);
    if (capture.importBatchId) return attachedBatch(tx, capture);
    if (!capture.snapshot.guides.length && !capture.snapshot.packages.length) fail('La captura no contiene guías ni paquetes pagados para importar.');
    const workbook = createHekaWorkbook(capture.snapshot), nested = facade(tx);
    let batch = await createImportBatch(nested, { requestId: requestFor(snapshotId, 'create'), sourceId }, actorId);
    batch = await uploadImportFile(nested, batch.id, {
      requestId: requestFor(snapshotId, 'upload'), version: batch.version, filename: 'heka.xlsx', bytes: workbook.bytes,
    }, actorId);
    const row = await batchRow(tx, batch.id);
    const shippingOrigin = validateHekaImportOrigin({
      format: 'heka-import-v1', snapshotId, sourceHash: capture.payloadHash,
      adapterVersion: capture.snapshot.adapterVersion, schemaVersion: capture.snapshot.schemaVersion,
      sourceId, capturedAt: capture.capturedAt, query: capture.snapshot.query,
      accountFingerprint: hash(normalizeHekaIdentity(capture.snapshot.account)), fileHash: batch.fileHash,
      ...workbook.manifest,
    }, { sourceId, fileHash: batch.fileHash });
    // Inspect every populated sheet, without asking the inspector to guess mappings.
    const inspectionConfig = validateImportConfig({ formatVersion: 2, sheets: workbook.config.sheets.map(sheet => ({ ...sheet, columns: [] })) });
    await saveData(tx, row, { ...row.data, config: inspectionConfig, shippingOrigin,
      shippingPreparation: { stage: 'inspect', initialConfig: workbook.config, inspectionConfigHash: hash(inspectionConfig) } });
    await tx.db.run(`UPDATE ${tx.t('shipping_snapshots')} SET import_batch_id=? WHERE id=? AND import_batch_id IS NULL`, [batch.id, snapshotId]);
    return batchRow(tx, batch.id);
  });
  if (state.data.shippingPreparation.stage === 'ready') return resultOf(state, sourceId, false);

  // This gate is indispensable: a retry must never claim a preview or accepted apply job.
  if (state.data.shippingPreparation.stage === 'inspect' || state.state === 'uploaded') await processImportTurn(store, { batchId: state.id, expectedPhase: 'inspect' });

  return store.transaction(async tx => {
    await tx.lockWrites();
    const capture = await authorizedSnapshot(tx, selection, actorId, options);
    let row = await attachedBatch(tx, capture), marker = row.data.shippingPreparation;
    if (marker.stage === 'ready') return resultOf(row, sourceId, false);
    if (['cancelled', 'expired'].includes(row.state) || row.data.fileExpired || row.data.fileDiscarded) fail('El lote fue descartado o su archivo venció.', 409);
    if (row.state === 'failed') fail(row.data.error?.message || 'No se pudo inspeccionar el archivo de Heka.', 409);
    if (marker.stage === 'inspect') {
      if (!row.data.workbook || row.state === 'uploaded') return resultOf(row, sourceId, true);
      // A human may already have changed the config. Never restore the generated defaults over it.
      const untouched = hash(row.data.config) === marker.inspectionConfigHash;
      if (untouched) await updateImportBatch(facade(tx), row.id, {
        requestId: requestFor(snapshotId, 'map'), version: row.version, config: marker.initialConfig,
      }, actorId);
      row = await batchRow(tx, row.id);
      marker = { stage: 'mapped' };
      await saveData(tx, row, { ...row.data, shippingPreparation: marker });
      row = await batchRow(tx, row.id);
    }
    if (marker.stage !== 'mapped') fail('Etapa de preparación no válida.', 409);
    if (row.state === 'uploaded') return resultOf(row, sourceId, true);
    // Existing human/scheduler work is already the hand-off; never replace it.
    if (!['previewing', 'queued', 'applying', 'completed', 'completed_with_errors'].includes(row.state) && !row.data.preview) {
      await requestImportPreview(facade(tx), row.id, { requestId: requestFor(snapshotId, 'preview'), version: row.version }, actorId);
      row = await batchRow(tx, row.id);
    }
    await saveData(tx, row, { ...row.data, shippingPreparation: { stage: 'ready' } });
    row = await batchRow(tx, row.id);
    return resultOf(row, sourceId, false);
  });
}
