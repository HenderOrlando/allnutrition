import { readAdminView } from '../admin-view.mjs';
import { projectActiveAlertEpisodes } from '../business/alerts.mjs';
import { fail } from '../validation-core.mjs';
import { advisorAbsoluteInstant, advisorJSONText as jsonText, isClosedAdvisorImportCondition } from './advisor-tasks.mjs';
import { hashAssistantInput } from './repository.mjs';
import { assertAssistantAccess, getAssistantSettings } from './settings.mjs';
import { readAdvisorPreferencesTx } from './advisor-preferences.mjs';

const PAGE_SIZE = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SEVERITY = { critical: 0, warning: 1, info: 2 };
const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const KEY = /^(alert|import|reminder):([A-Za-z0-9_.:-]{1,100})$/;
const HASH = /^[a-f0-9]{64}$/;
const FINAL_IMPORT = new Set(['completed', 'completed_with_errors', 'failed', 'expired', 'cancelled']);
const noticeRows = tx => tx.t('assistant_advisor_notice_state');
const clock = now => new Date(typeof now === 'function' ? now() : now).toISOString();
const beforeCutoff = at => new Date(Date.parse(at) - WEEK_MS).toISOString();
function count(value) {
  const number = value == null ? NaN : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function inboxUser(tx, session, lock = false) {
  const { version } = await getAssistantSettings(tx);
  return (await assertAssistantAccess(tx, session, version, { lock })).userId;
}

function checkedAction(action, fallback) {
  const { view, orderId } = action;
  if (view) {
    const canonical = readAdminView(view);
    if (view.batch === 'new' || view.record === 'new' || Object.keys(view).some(key => canonical[key] !== view[key])) return fallback;
  }
  if (orderId && !SOURCE_ID.test(orderId)) return fallback;
  return action;
}

function candidate(kind, id, sourceLabel, data, action, material, since) {
  const key = `${kind}:${id}`;
  return {
    since,
    card: { key, fingerprint: hashAssistantInput([key, data.severity, material]), kind, ...data,
      source: { kind, id, label: sourceLabel }, action },
  };
}

function alertCard(episode, taskId) {
  const { id, title, reason, severity, asOf, firstSeenAt, material } = episode;
  const action = checkedAction(episode.action, { label: 'Ver alerta', view: { section: 'business', tab: 'alerts' } });
  return candidate('alert', id, 'Alerta del negocio', { title, reason, severity, asOf },
    taskId ? { ...action, taskId } : action, material, firstSeenAt);
}

async function projectAlertTasks(tx, userId, id = null) {
  const ref = jsonText(tx, 't', 'sourceRef.id');
  return tx.db.all(`SELECT ${ref} AS source_id, MIN(t.id) AS task_id FROM ${tx.t('assistant_advisor_tasks')} t
    WHERE t.user_id=? AND t.status='active' AND t.capability_id<>'advisor.reminder' AND ${jsonText(tx, 't', 'sourceRef.kind')}='alert'
    ${id === null ? '' : `AND ${ref}=?`} GROUP BY ${ref}`, id === null ? [userId] : [userId, id]);
}

async function projectImportBatches(tx, userId, at, id = null) {
  const field = path => jsonText(tx, 'b', path);
  const ref = jsonText(tx, 't', 'sourceRef.id');
  const finalAt = `CASE b.state WHEN 'cancelled' THEN COALESCE(${field('cancellation.cancelledAt')},b.updated_at)
    WHEN 'expired' THEN COALESCE(${field('expiredAt')},b.updated_at)
    WHEN 'failed' THEN b.updated_at
    ELSE COALESCE(${field('completedAt')},${field('finishedAt')},b.updated_at) END`;
  return tx.db.all(`WITH followed AS (
    SELECT ${ref} AS batch_id, MIN(t.id) AS task_id FROM ${tx.t('assistant_advisor_tasks')} t
    WHERE t.user_id=? AND t.status NOT IN ('completed','cancelled') AND t.capability_id<>'advisor.reminder' AND ${jsonText(tx, 't', 'sourceRef.kind')}='import'
    GROUP BY ${ref}
  ) SELECT b.id,b.state,b.file_hash,b.created_at,b.updated_at,s.name AS source_label,f.task_id,${finalAt} AS final_at,
    r.revision,r.preview_hash AS accepted_hash,
    ${field('preview.previewHash')} AS preview_hash,${field('preview.summary.total')} AS review_total,
    ${field('preview.summary.conflict')} AS conflicts,${field('preview.summary.rejected')} AS rejected,
    ${field('preview.summary.settlementsPending')} AS review_settlements,
    ${field('error.phase')} AS error_phase,${field('error.code')} AS error_code,
    ${field('progress.processed')} AS processed,${field('progress.total')} AS total,
    ${field('progress.groupsProcessed')} AS groups_processed,${field('progress.groupsTotal')} AS groups_total,
    ${field('progress.settlementsProcessed')} AS settlements_processed,${field('progress.settlementsTotal')} AS settlements_total,
    ${field('progress.errors')} AS errors,${field('progress.omitted')} AS omitted,
    ${field('progress.created')} AS created,${field('progress.updated')} AS updated,${field('progress.unchanged')} AS unchanged
  FROM ${tx.t('import_batches')} b JOIN ${tx.t('platform_sources')} s ON s.id=b.source_id
  LEFT JOIN followed f ON f.batch_id=b.id
  LEFT JOIN ${tx.t('import_revisions')} r ON r.batch_id=b.id AND CAST(r.revision AS TEXT)=CAST(${field('acceptedRevision')} AS TEXT)
  WHERE (${field('createdBy')}=? OR f.task_id IS NOT NULL) AND (
    f.task_id IS NOT NULL OR b.state NOT IN ('completed','completed_with_errors','failed','expired','cancelled')
    OR ${finalAt}>=? OR EXISTS (SELECT 1 FROM ${tx.t('assistant_advisor_tasks')} t
      WHERE t.user_id=? AND t.status='active' AND t.capability_id='advisor.reminder' AND t.due_at<=?
      AND ${jsonText(tx, 't', 'sourceRef.kind')}='import' AND ${ref}=b.id)
  )${id === null ? '' : ' AND b.id=?'}`, [userId, userId, beforeCutoff(at), userId, at, ...(id === null ? [] : [id])]);
}

function importProgress(row) {
  const processed = count(row.processed), total = count(row.total);
  const groups = count(row.groups_processed), groupsTotal = count(row.groups_total);
  const settlements = count(row.settlements_processed), settlementsTotal = count(row.settlements_total);
  if (groups !== null && groupsTotal !== null && settlements !== null && settlementsTotal !== null) {
    if (settlementsTotal === 0) return `Grupos procesados: ${groups} de ${groupsTotal}.`;
    if (groupsTotal === 0) return `Liquidaciones procesadas: ${settlements} de ${settlementsTotal}.`;
    return `Grupos procesados: ${groups} de ${groupsTotal}; liquidaciones procesadas: ${settlements} de ${settlementsTotal}.`;
  }
  return processed !== null && total !== null ? `Operaciones procesadas: ${processed} de ${total} (grupos y liquidaciones).` : '';
}

function describeImport(row) {
  const state = row.state;
  const errors = count(row.errors);
  const progress = importProgress(row);
  const progressFacts = ['processed','total','groups_processed','groups_total','settlements_processed','settlements_total',
    'errors','omitted','created','updated','unchanged'].map(key => count(row[key]));
  const material = { state, fileHash: row.file_hash, revision: row.revision, acceptedHash: row.accepted_hash };
  let title, reason, severity = 'info';
  switch (state) {
    case 'uploaded':
      title = row.file_hash ? 'Archivo recibido para importación' : 'Importación sin archivo';
      reason = row.file_hash ? 'El archivo está guardado; todavía no hay una revisión lista.' : 'Aún falta cargar un archivo al lote.';
      break;
    case 'previewing':
      title = 'Revisión de importación en proceso';
      reason = 'Se está preparando la revisión. Todavía no confirma cambios aplicados.';
      break;
    case 'review': {
      if (row.file_hash && HASH.test(row.preview_hash ?? '') && count(row.review_total) !== null) {
        const groups = count(row.review_total), conflicts = count(row.conflicts), rejected = count(row.rejected), settlements = count(row.review_settlements);
        const issues = (conflicts ?? 0) + (rejected ?? 0);
        title = issues || settlements ? 'Importación con incidencias para revisar' : 'Revisión de importación lista';
        reason = `La revisión incluye ${groups} ${groups === 1 ? 'grupo' : 'grupos'}${issues ? `; ${issues} ${issues === 1 ? 'tiene' : 'tienen'} conflicto o rechazo` : ''}${settlements ? ` y hay ${settlements} ${settlements === 1 ? 'liquidación pendiente' : 'liquidaciones pendientes'}` : ''}. La revisión no aplica cambios.`;
        if (issues || settlements) severity = 'warning';
        Object.assign(material, { previewHash: row.preview_hash, groups, conflicts, rejected, settlements });
      } else if (row.error_phase === 'preview' && row.error_code) {
        title = 'No se completó la revisión de la importación';
        reason = 'El diagnóstico está guardado en el lote. Revísalo antes de preparar otra revisión.';
        severity = 'warning';
        material.diagnostic = row.error_code;
      } else return null; // Native state `review` is also used for column mapping.
      break;
    }
    case 'queued':
    case 'applying':
      title = 'Importación en proceso';
      reason = `${progress ? progress + ' ' : ''}Todavía no hay un resultado final.`;
      // The worker returns to queued between chunks; that alone is not news.
      Object.assign(material, { state: 'processing', progress: progressFacts });
      break;
    case 'completed':
      title = 'Importación terminada';
      reason = progress || 'El lote figura como terminado. Consulta el resultado guardado.';
      material.progress = progressFacts;
      break;
    case 'completed_with_errors':
      title = 'La importación terminó con incidencias';
      reason = (errors > 0 ? `Operaciones con incidencia: ${errors} (grupos omitidos o fallidos y liquidaciones con error). ` : '')
        + (progress ? `${progress} ` : '') + 'Revisa los resultados del lote; no todo se aplicó.';
      severity = 'warning';
      material.progress = progressFacts;
      break;
    case 'failed':
      title = 'La importación se detuvo';
      reason = 'El lote registra un fallo. Consulta el diagnóstico y los resultados guardados antes de continuar.';
      severity = 'warning';
      Object.assign(material, { diagnostic: row.error_code, phase: row.error_phase, progress: progressFacts });
      break;
    case 'expired':
      title = 'El archivo de importación venció';
      reason = 'El archivo original ya no está disponible. El lote conserva su registro.';
      break;
    case 'cancelled':
      title = 'Importación cancelada';
      reason = 'El lote fue cancelado. Las operaciones previamente confirmadas no se deshicieron.';
      material.progress = progressFacts;
      break;
    default: return null;
  }
  const asOf = FINAL_IMPORT.has(state) ? row.final_at : row.updated_at;
  const action = importAction(row);
  const follow = row.task_id
    ? { taskId: row.task_id, label: 'Retomar con Ali' }
    : ['review','completed_with_errors'].includes(state) && action.view.batch
    ? { batchId: action.view.batch, label: 'Revisar con Ali' }
    : null;
  return candidate('import', row.id, row.source_label || 'Importación de Excel', { title, reason, severity, asOf },
    follow ? { ...action, follow } : action, material, FINAL_IMPORT.has(state) ? asOf : row.created_at);
}

function importAction(row) {
  return checkedAction({ label: 'Abrir importación', view: { section: 'orders', tab: 'imports', batch: row.id } },
    { label: 'Ver importaciones', view: { section: 'orders', tab: 'imports' } });
}

function importLink(row, card) {
  return { title: card?.title ?? 'Revisar importación', action: importAction(row), conditionClosed: isClosedAdvisorImportCondition(row.state) };
}

const showImport = (row, at) => row.task_id || !FINAL_IMPORT.has(row.state) || row.final_at >= beforeCutoff(at);

function projectDueReminders(tx, userId, at, id = null) {
  return tx.db.all(`SELECT id,due_at,data FROM ${tx.t('assistant_advisor_tasks')}
    WHERE user_id=? AND capability_id='advisor.reminder' AND status='active' AND due_at<=?${id === null ? '' : ' AND id=?'}`,
  id === null ? [userId, at] : [userId, at, id]);
}

function reminderCard(reminder, data, linked) {
  const destinationOnly = data.sourceBinding === 'destination';
  if (data.sourceRef && (!linked || linked.conditionClosed && !destinationOnly)) return null;
  const id = reminder.id, asOf = reminder.due_at;
  return candidate('reminder', id, 'Recordatorio', {
    title: data.label || linked?.title || 'Recordatorio pendiente',
    reason: linked && !destinationOnly ? 'Llegó la fecha que elegiste y la condición vinculada sigue vigente.' : 'Llegó la fecha que elegiste para este recordatorio.',
    severity: 'info', asOf,
  }, { ...(linked?.action ?? { label: 'Ver recordatorio' }), taskId: id },
  { dueAt: asOf, label: data.label ?? null, sourceRef: data.sourceRef ?? null }, asOf);
}

async function listCandidates(tx, userId, asOf) {
  const episodes = await projectActiveAlertEpisodes(tx);
  const follow = new Map((await projectAlertTasks(tx, userId)).map(row => [row.source_id, row.task_id]));
  const candidates = [];
  const links = new Map();
  for (const episode of episodes) {
    const value = alertCard(episode, follow.get(episode.id));
    links.set(value.card.key, value.card);
    candidates.push(value);
  }
  for (const row of await projectImportBatches(tx, userId, asOf)) {
    const value = describeImport(row);
    links.set(`import:${row.id}`, importLink(row, value?.card));
    if (value && showImport(row, asOf)) candidates.push(value);
  }
  for (const reminder of await projectDueReminders(tx, userId, asOf)) {
    const data = JSON.parse(reminder.data), ref = data.sourceRef;
    const value = reminderCard(reminder, data, ref ? links.get(`${ref.kind}:${ref.id}`) : null);
    if (value) candidates.push(value);
  }
  return candidates;
}

async function getCandidate(tx, userId, kind, id, asOf, linkedOnly = false) {
  if (kind === 'alert') {
    const [episode] = await projectActiveAlertEpisodes(tx, id);
    if (!episode) return null;
    if (linkedOnly) return episode;
    const [task] = await projectAlertTasks(tx, userId, id);
    return alertCard(episode, task?.task_id);
  }
  if (kind === 'import') {
    const [row] = await projectImportBatches(tx, userId, asOf, id);
    if (!row || (!linkedOnly && !showImport(row, asOf))) return null;
    const value = describeImport(row);
    return linkedOnly ? importLink(row, value?.card) : value;
  }
  if (kind === 'reminder' && !linkedOnly) {
    const [reminder] = await projectDueReminders(tx, userId, asOf, id);
    if (!reminder) return null;
    const data = JSON.parse(reminder.data), ref = data.sourceRef;
    const linked = ref ? await getCandidate(tx, userId, ref.kind, ref.id, asOf, true) : null;
    return reminderCard(reminder, data, linked);
  }
  return null;
}

function publicCard(card, state, asOf) {
  return { ...card, version: state?.version ?? 0, read: state?.seen_fingerprint === card.fingerprint,
    snoozedUntil: state?.snoozed_until > asOf ? state.snoozed_until : null };
}

function getNotice(tx, userId, key) {
  return tx.db.get(`SELECT seen_fingerprint,snoozed_until,version FROM ${noticeRows(tx)} WHERE user_id=? AND source_key=?`, [userId, key]);
}

async function getNotices(tx, userId, candidates) {
  if (!candidates.length) return new Map();
  const keys = tx.provider === 'sqlite' ? 'SELECT value FROM json_each(?)' : 'SELECT value FROM jsonb_array_elements_text(CAST(? AS jsonb)) AS keys(value)';
  const states = await tx.db.all(`SELECT source_key,seen_fingerprint,snoozed_until,version FROM ${noticeRows(tx)}
    WHERE user_id=? AND source_key IN (${keys})`, [userId, JSON.stringify(candidates.map(value => value.card.key))]);
  return new Map(states.map(state => [state.source_key, state]));
}

export async function listAdvisorInbox(store, session, { page = 1, summary = false, now = Date.now } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 100000 || typeof summary !== 'boolean') fail('Consulta de bandeja no válida.', 422);
  return store.readSnapshot(async tx => {
    const userId = await inboxUser(tx, session);
    const { showAnnouncements } = await readAdvisorPreferencesTx(tx, userId);
    const asOf = clock(now), candidates = await listCandidates(tx, userId, asOf);
    const notices = await getNotices(tx, userId, candidates);
    let unreadCount = 0;
    const visible = [];
    for (const value of candidates) {
      const { card } = value;
      if (!showAnnouncements && card.kind === 'import' && card.severity === 'info' && !card.action.follow?.taskId) continue;
      const state = notices.get(value.card.key);
      if (state?.snoozed_until > asOf) continue;
      if (state?.seen_fingerprint !== value.card.fingerprint) unreadCount++;
      if (!summary) visible.push(value);
    }
    if (summary) return { unreadCount, asOf };
    visible.sort((a, b) => SEVERITY[a.card.severity] - SEVERITY[b.card.severity]
      || Number(b.card.kind === 'reminder') - Number(a.card.kind === 'reminder')
      || a.since.localeCompare(b.since) || a.card.source.id.localeCompare(b.card.source.id) || a.card.key.localeCompare(b.card.key));
    const items = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(({ card }) => publicCard(card, notices.get(card.key), asOf));
    return { items, unreadCount, page, total: visible.length, asOf };
  });
}

function inboxConflict(current) {
  throw Object.assign(new Error('El aviso cambió. Revisa su estado antes de continuar.'), { status: 409, code: 'ASSISTANT_CONFLICT', current });
}

export async function updateAdvisorInbox(store, session, input, { now = Date.now } = {}) {
  const { key, fingerprint, version, action } = input ?? {};
  const match = typeof key === 'string' && KEY.exec(key);
  const allowed = action === 'snooze' ? ['key', 'fingerprint', 'version', 'action', 'until'] : ['key', 'fingerprint', 'version', 'action'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))
    || !match || typeof fingerprint !== 'string' || !HASH.test(fingerprint) || !Number.isInteger(version) || version < 0 || version > 2147483647
    || !['seen', 'snooze', 'unsnooze'].includes(action)) fail('Decisión de bandeja no válida.', 422);
  const until = action === 'snooze' ? advisorAbsoluteInstant(input.until) : null;
  return store.transaction(async tx => {
    const userId = await inboxUser(tx, session, true);
    const asOf = clock(now);
    const value = await getCandidate(tx, userId, match[1], match[2], asOf);
    if (!value) fail('El aviso ya no está disponible.', 404);
    const current = publicCard(value.card, await getNotice(tx, userId, key), asOf);
    if (current.version !== version || current.fingerprint !== fingerprint) inboxConflict(current);
    if (until && until <= asOf) fail('Elige un momento futuro para posponer el aviso.', 422);
    // A snooze clears the seen mark immediately. Expiry only exposes that unread mark;
    // no poll writes or schedules a repeat. Seen consumes the expiration in one write.
    const seen = action === 'seen' ? fingerprint : null;
    const result = version === 0
      ? await tx.db.run(`INSERT INTO ${noticeRows(tx)} (user_id,source_key,seen_fingerprint,snoozed_until,version)
          VALUES(?,?,?,?,1) ON CONFLICT(user_id,source_key) DO NOTHING`, [userId, key, seen, until])
      : await tx.db.run(`UPDATE ${noticeRows(tx)} SET seen_fingerprint=?,snoozed_until=?,version=version+1
          WHERE user_id=? AND source_key=? AND version=?`, [seen, until, userId, key, version]);
    if (result.changes !== 1) inboxConflict(publicCard(value.card, await getNotice(tx, userId, key), asOf));
    return publicCard(value.card, { version: version + 1, seen_fingerprint: seen, snoozed_until: until }, asOf);
  });
}
