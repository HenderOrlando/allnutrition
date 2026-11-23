import { createHash } from 'node:crypto';
import { fail } from '../validation-core.mjs';

const CAPABILITY = 'imports.resolve-issues';
const HASH = /^[a-f0-9]{64}$/;
const PAGE_SIZE = 8;
const count = value => Number(value) || 0;
const flag = value => value === 'true' || Number(value) === 1;
const field = (tx, alias, path) => tx.provider === 'sqlite'
  ? `json_extract(${alias}.data,'$.${path}')` : `(${alias}.data::jsonb#>>'{${path.replaceAll('.', ',')}}')`;

async function readBatch(tx, id) {
  const b = path => field(tx, 'b', path);
  return tx.db.get(`SELECT b.id,b.state,b.version,b.file_hash,
    ${b('fileExpired')} AS file_expired,${b('fileDiscarded')} AS file_discarded,
    ${b('preview.previewHash')} AS preview_hash,${b('error.phase')} AS error_phase,
    ${b('progress.phase')} AS phase,${b('progress.processed')} AS processed,${b('progress.total')} AS total,
    ${b('progress.errors')} AS errors,${b('progress.settlementsProcessed')} AS settlements,
    ${b('cancellation.appliedGroups')} AS cancelled_groups,${b('cancellation.appliedSettlements')} AS cancelled_settlements,
    ${b('completedAt')} AS completed_at,
    r.revision,r.preview_hash AS accepted_hash,r.accepted_at,${field(tx, 'r', 'fileHash')} AS accepted_file_hash
    FROM ${tx.t('import_batches')} b LEFT JOIN ${tx.t('import_revisions')} r
      ON r.batch_id=b.id AND CAST(r.revision AS TEXT)=CAST(${b('acceptedRevision')} AS TEXT)
    WHERE b.id=?`, [id]);
}

function snapshot(batch) {
  return { version: batch.version, ...(batch.revision ? { revision: batch.revision } : null),
    ...(HASH.test(batch.preview_hash) ? { previewHash: batch.preview_hash } : null) };
}
function sameReview(review, batch) {
  return review?.version === batch.version && (review.revision ?? null) === (batch.revision ?? null)
    && (review.previewHash ?? null) === (batch.preview_hash ?? null);
}
function at(task, data, status, step, message, details = {}) {
  return { ...task, status, step, data: { ...data, progress: { message, ...details } } };
}
function open(batch, focus, label, row) {
  return { label, capabilityId: CAPABILITY, view: { section: 'orders', tab: 'imports', batch: batch.id }, focus,
    selection: { kind: 'import', batchId: batch.id, ...snapshot(batch), ...row } };
}
function rowOption(batch, row) {
  const binding = [batch.id, batch.version, batch.revision, batch.preview_hash, row.sheet, row.row_number];
  return { id: createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 32),
    label: `${row.sheet} · fila ${row.row_number}` };
}
function pageOption(batch, page, label) {
  return { ...rowOption(batch, { sheet: null, row_number: page }), label };
}
const appliedType = tx => tx.provider === 'sqlite' ? "json_type(i.data,'$.applied')" : "jsonb_typeof(i.data::jsonb->'applied')";
function issueFilter(tx) {
  const errors = tx.provider === 'sqlite' ? "json_array_length(i.data,'$.errors')"
    : "(CASE WHEN jsonb_typeof(i.data::jsonb->'errors')='array' THEN jsonb_array_length(i.data::jsonb->'errors') END)";
  return `i.batch_id=? AND i.state NOT IN ('applied','skipped') AND COALESCE(${appliedType(tx)},'')<>'object' AND ${errors}>0`;
}
async function issuePage(tx, batch, page) {
  const order = tx.provider === 'sqlite' ? 'COLLATE BINARY' : 'COLLATE "C"';
  return tx.db.all(`SELECT i.sheet,i.row_number FROM ${tx.t('import_rows')} i WHERE ${issueFilter(tx)}
    ORDER BY i.sheet ${order},i.row_number LIMIT ? OFFSET ?`, [batch.id, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE]);
}
async function appliedGroups(tx, batch) {
  const result = await tx.db.get(`SELECT COUNT(DISTINCT i.entity_key) AS total,
    COUNT(DISTINCT CASE WHEN CAST(${field(tx, 'i', 'acceptedRevision')} AS TEXT)=? THEN i.entity_key END) AS current
    FROM ${tx.t('import_rows')} i WHERE i.batch_id=? AND i.state='applied' AND ${appliedType(tx)}='object'`,
  [String(batch.revision), batch.id]);
  return { total: count(result.total), current: count(result.current) };
}
function resultMatches(batch) {
  return batch.revision > 0 && HASH.test(batch.accepted_hash) && batch.accepted_hash === batch.preview_hash
    && batch.file_hash && batch.accepted_file_hash === batch.file_hash && batch.completed_at >= batch.accepted_at
    && batch.phase === 'complete' && count(batch.total) > 0 && count(batch.processed) === count(batch.total) && count(batch.errors) === 0;
}

export async function resolveAdvisorImport(tx, _session, task) {
  if (task.status === 'cancelled' && !task.data.importStopped) return task;
  const { progress: _progress, importRow, importPage, ...saved } = task.data;
  const source = saved.sourceRef;
  // Discovery is Hoy's owner-scoped projection. This resolver never looks up an
  // unspecified lot or searches other lots, including when the source disappears.
  const batch = source?.kind === 'import' && await readBatch(tx, source.id);
  if (!batch) return at(task, saved, 'blocked', 'import-source', 'Abre desde Hoy el lote concreto que quieres revisar. Esta tarea no buscará importaciones de otras personas.');
  const matches = sameReview(saved.importReview, batch);
  const changed = !!saved.importReview && !matches;
  const data = { ...saved, importReview: snapshot(batch) };
  const result = open(batch, 'import-result', 'Ver resultado guardado');

  if (batch.state === 'completed') {
    const groups = await appliedGroups(tx, batch);
    if (!resultMatches(batch) || groups.current + count(batch.settlements) !== count(batch.total)) {
      return at(task, data, task.status === 'completed' ? 'completed' : 'blocked', 'import-result', 'El lote figura como terminado, pero no se pudo comprobar su revisión aplicada. Consulta el resultado guardado.', { action: result });
    }
    const proof = { kind: 'record', label: `Lote aplicado · revisión ${batch.revision}`, entityId: batch.id,
      recordVersion: task.status === 'completed' && saved.importReview?.revision === batch.revision && saved.importReview.previewHash === batch.accepted_hash
        ? saved.importReview.version : batch.version,
      committedAt: batch.completed_at };
    return at(task, data, 'completed', 'import-result', batch.completed_at < task.createdAt
      ? 'El lote ya estaba registrado. No se aplicó nada desde esta tarea.'
      : 'El lote y su revisión aplicada constan en el resultado guardado. La tarea no hizo la importación.', {
      action: result, proof, known: [
        { label: 'Grupos incorporados en el lote', value: String(groups.total) },
        ...(batch.settlements ? [{ label: 'Liquidaciones de esta aceptación', value: String(count(batch.settlements)) }] : []),
      ],
    });
  }
  if (batch.state === 'cancelled') {
    const confirmed = count(batch.cancelled_groups) + count(batch.cancelled_settlements);
    return at(task, { ...data, importStopped: true }, 'cancelled', 'import-result', confirmed
      ? 'El lote fue cancelado. Conserva las operaciones ya confirmadas; no se reanudará ni se revertirá desde aquí.'
      : 'El lote fue cancelado. No se reanudará ni se recuperará el original descartado.', { action: result });
  }
  if (batch.state === 'expired' || flag(batch.file_expired) || flag(batch.file_discarded)) {
    return at(task, data, 'blocked', 'import-result', 'El original ya no está disponible. Consulta el resultado o los pendientes conservados; para importar otro archivo necesitas un lote nuevo.', { action: result });
  }
  if (batch.state === 'queued' || batch.state === 'applying') {
    return at(task, data, 'waiting_result', 'import-result', 'La revisión fue aceptada en el importador. El servidor todavía está aplicándola; falta comprobar el resultado.', { action: open(batch, 'import-result', 'Ver progreso de la importación') });
  }
  if (batch.state === 'previewing' || batch.state === 'uploaded' && batch.file_hash) {
    return at(task, data, 'waiting_result', 'import-preview', 'El servidor está preparando el archivo o la revisión. Aún no hay una aceptación ni un resultado nuevo.', { action: open(batch, 'import-review', 'Ver preparación de la revisión') });
  }
  if (batch.state === 'completed_with_errors' || batch.state === 'failed' && batch.revision && batch.error_phase === 'apply') {
    const { total: groups } = await appliedGroups(tx, batch);
    return at(task, data, 'waiting_human', 'import-pending', 'Quedan operaciones por revisar. Genera una revisión nueva para continuar solo con lo pendiente; lo ya incorporado se conserva.', {
      action: open(batch, 'import-pending', 'Abrir pendientes del lote'), known: [
        { label: 'Grupos incorporados en el lote', value: String(groups) },
        ...(batch.errors == null ? [] : [{ label: 'Operaciones con incidencia en la última aceptación', value: String(count(batch.errors)) }]),
      ],
    });
  }
  const review = open(batch, 'import-review', 'Abrir revisión en el importador');
  if (batch.state !== 'review' || !HASH.test(batch.preview_hash)) {
    return at(task, data, 'waiting_human', 'import-review', batch.error_phase
      ? 'El importador registra un diagnóstico. Revísalo en el lote y prepara una revisión nueva antes de aceptar.'
      : 'Este lote todavía no tiene una revisión disponible. Usa los controles del importador; guardar el borrador no aplica operaciones.', { action: review });
  }

  const page = matches && importPage ? importPage : 1;
  if (matches && importRow) {
    const row = await tx.db.get(`SELECT i.sheet,i.row_number FROM ${tx.t('import_rows')} i WHERE ${issueFilter(tx)} AND i.sheet=? AND i.row_number=?`, [batch.id, importRow.sheet, importRow.rowNumber]);
    if (row) return at(task, { ...data, importRow }, 'waiting_human', 'import-row', 'Abre la incidencia de esta fila. La decisión y el guardado se hacen en el importador; después tendrás que revisar y aceptar.', {
      action: open(batch, 'import-row', 'Abrir opciones de resolución de la fila', importRow),
      known: [{ label: 'Fila seleccionada', value: rowOption(batch, row).label }],
    });
  }
  const candidates = await issuePage(tx, batch, page);
  const prefix = changed ? 'El lote cambió. Revisa la versión actual; la selección anterior no se arrastra. ' : '';
  if (!candidates.length) return at(task, data, 'waiting_human', 'import-review', `${prefix}Revisa los efectos y las incidencias del lote en el importador. Solo la aceptación nativa aplica operaciones.`, { action: review });
  if (page === 1 && candidates.length === 1) {
    const [row] = candidates;
    return at(task, data, 'waiting_human', 'import-row', `${prefix}Hay una fila con incidencias. Elige cómo resolverla en el importador; eso no acepta la importación.`, {
      action: open(batch, 'import-row', 'Abrir opciones de resolución de la fila', { sheet: row.sheet, rowNumber: row.row_number }),
      known: [{ label: 'Fila con incidencias', value: rowOption(batch, row).label }],
    });
  }
  const options = candidates.slice(0, PAGE_SIZE).map(row => rowOption(batch, row));
  if (page > 1) options.push(pageOption(batch, page - 1, 'Filas anteriores'));
  if (candidates.length > PAGE_SIZE) options.push(pageOption(batch, page + 1, 'Más filas'));
  return at(task, page === 1 ? data : { ...data, importPage: page }, 'waiting_input', 'import-choose-row', `${prefix}Hay varias filas con incidencias registradas.`, {
    question: { id: `${task.id}:importRow`, field: 'importRow', prompt: '¿Qué hoja y fila quieres revisar?', type: 'choice', options },
  });
}

export async function answerAdvisorImport(tx, session, current, input) {
  if (input.field !== 'importRow' || typeof input.value !== 'string') fail('Elige una fila de la revisión vigente.', 422);
  const source = current.data.sourceRef;
  const batch = source?.kind === 'import' && await readBatch(tx, source.id);
  if (!batch || batch.state !== 'review' || !HASH.test(batch.preview_hash) || !sameReview(current.data.importReview, batch)) {
    fail('El lote cambió. Revisa sus filas actuales antes de volver a elegir.', 409);
  }
  const page = current.data.importPage || 1;
  const candidates = await issuePage(tx, batch, page);
  const row = candidates.slice(0, PAGE_SIZE).find(candidate => rowOption(batch, candidate).id === input.value);
  if (row) return resolveAdvisorImport(tx, session, { ...current, data: { ...current.data, importRow: { sheet: row.sheet, rowNumber: row.row_number } } });
  const next = page > 1 && input.value === pageOption(batch, page - 1).id ? page - 1
    : candidates.length > PAGE_SIZE && input.value === pageOption(batch, page + 1).id ? page + 1 : null;
  if (next) return resolveAdvisorImport(tx, session, { ...current, data: { ...current.data, importPage: next } });
  fail('La opción ya no corresponde a esta revisión. Consulta las filas actuales.', 409);
}
