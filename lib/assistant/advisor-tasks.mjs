import { fail, integer, text } from '../validation-core.mjs';
import { getAssistantCapability } from './capabilities.mjs';
import { getAssistantProposal, hashAssistantInput, transitionAssistantProposal } from './repository.mjs';
import { assertAssistantAccess, assertAssistantSession, getAssistantSettings } from './settings.mjs';
import { advisorTaskStorage, answerAdvisorStep, canAdvanceAdvisorTask, resolveAdvisorStep } from './advisor-steps.mjs';
import { captureAdvisorRecommendation } from './advisor-recommendations.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;
const MAX_DATA_BYTES = 16 * 1024;
const SOURCES = new Map([
  ['alert', 'alerts'], ['import', 'import_batches'], ['order', 'orders'], ['cash-account', 'cash_accounts'],
]);
const SOURCE_KINDS = new Map([
  ['advisor.reminder', ['alert', 'import']], ['orders.ship-order', ['order']],
  ['cash.close-day', ['cash-account']], ['imports.resolve-issues', ['import']],
]);
const FOLLOW_RECOMMENDATION = 'advisor.follow-recommendation';

export const isClosedAdvisorImportCondition = state => ['completed', 'expired', 'cancelled'].includes(state);
export const advisorJSONText = (tx, alias, path) => tx.provider === 'sqlite'
  ? `json_extract(${alias}.data,'$.${path}')` : `(${alias}.data::jsonb#>>'{${path.replaceAll('.', ',')}}')`;

function exact(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    fail('Solicitud de tarea no válida.', 422);
  }
}

function taskId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('La tarea requiere un UUID válido.', 422);
  return value.toLowerCase();
}

export function advisorAbsoluteInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail('Indica una fecha y hora absolutos en UTC.', 422);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) fail('Fecha de recordatorio no válida.', 422);
  const normalized = new Date(millis).toISOString();
  if (normalized !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) fail('Fecha de recordatorio no válida.', 422);
  return normalized;
}

function reservation(input) {
  exact(input, ['id', 'capabilityId', 'sourceRef', 'dueAt', 'label', 'recommendationId']);
  const id = taskId(input.id);
  const capability = getAssistantCapability(input.capabilityId);
  if (!capability) fail('La acción no forma parte del directorio de Ali.', 422);
  const { id: capabilityId } = capability;
  if (!SOURCE_KINDS.has(capabilityId) && capabilityId !== FOLLOW_RECOMMENDATION) fail('Esta acción se usa desde su control; no reserva una tarea personal.', 422);
  const data = {};
  if (capabilityId === FOLLOW_RECOMMENDATION) {
    if (typeof input.recommendationId !== 'string' || !/^rec_[a-f0-9]{64}$/.test(input.recommendationId)) fail('Selecciona una recomendación vigente.', 422);
    data.recommendationId = input.recommendationId;
  } else if (Object.hasOwn(input, 'recommendationId')) fail('La recomendación no corresponde a esta tarea.', 422);
  if (Object.hasOwn(input, 'sourceRef')) {
    exact(input.sourceRef, ['kind', 'id']);
    const { kind } = input.sourceRef;
    if (!SOURCE_KINDS.get(capabilityId)?.includes(kind)) fail('La fuente no corresponde a esta acción.', 422);
    const sourceId = text(input.sourceRef.id, 'Identificador de fuente', 100, true);
    if (!/^[A-Za-z0-9_.:-]+$/.test(sourceId)) fail('Identificador de fuente no válido.', 422);
    data.sourceRef = { kind, id: sourceId };
  }
  if (capabilityId === 'imports.resolve-issues' && !data.sourceRef) fail('Elige el lote de importación que quieres revisar.', 422);
  const reminder = capabilityId === 'advisor.reminder';
  const hasDueAt = Object.hasOwn(input, 'dueAt');
  if (hasDueAt !== reminder) fail(reminder ? 'Indica cuándo quieres el recordatorio.' : 'Solo un recordatorio tiene vencimiento.', 422);
  const dueAt = hasDueAt ? advisorAbsoluteInstant(input.dueAt) : null;
  if (Object.hasOwn(input, 'label')) {
    if (!reminder) fail('Solo un recordatorio admite un asunto personal.', 422);
    data.label = text(input.label, 'Asunto', 120, true);
    if (/[\u0000-\u001f\u007f]/.test(data.label)) fail('El asunto debe ser de una sola línea.', 422);
  }
  if (reminder && !data.label && !data.sourceRef) fail('Indica qué quieres recordar.', 422);
  return { id, capabilityId, dueAt, data };
}

function encodeData(data) {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > MAX_DATA_BYTES) fail('La tarea supera su límite de información personal.', 422);
  return json;
}

const columns = 'id, capability_id, status, step, version, created_at, updated_at, due_at, data';
const rows = tx => tx.t('assistant_advisor_tasks');
function dto(row) {
  return {
    id: row.id, capabilityId: row.capability_id, status: row.status, step: row.step, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, dueAt: row.due_at, data: JSON.parse(row.data),
  };
}

async function owned(tx, userId, id) {
  const row = await tx.db.get(`SELECT ${columns}, initial_digest FROM ${rows(tx)} WHERE user_id=? AND id=?`, [userId, id]);
  if (!row) fail('Tarea no encontrada.', 404);
  return row;
}

function versionMatches(row, version) {
  if (row.version !== version) fail('La tarea cambió. Vuelve a consultar el estado guardado.', 409);
}

async function cancelLinkedProposal(tx, userId, id) {
  if (!id) return;
  const proposal = await getAssistantProposal(tx, { userId, proposalId: id });
  if (['prepared', 'applied'].includes(proposal?.state)) {
    await transitionAssistantProposal(tx, { userId, proposalId: id, version: proposal.version, state: 'cancelled' });
  }
}

export async function listAdvisorTasks(store, session, { page = 1, kind } = {}) {
  integer(page, 'Página', 1, 100000);
  if (kind !== undefined && !['reminder', 'task'].includes(kind)) fail('Tipo de tarea no válido.', 422);
  return store.readSnapshot(async tx => {
    const { userId } = await assertAssistantSession(tx, session);
    const filter = `user_id=?${kind === 'reminder' ? " AND capability_id='advisor.reminder'" : kind === 'task' ? " AND capability_id<>'advisor.reminder'" : ''}`;
    const { total } = await tx.db.get(`SELECT COUNT(*) AS total FROM ${rows(tx)} WHERE ${filter}`, [userId]);
    const items = await tx.db.all(`SELECT ${columns} FROM ${rows(tx)} WHERE ${filter} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`, [userId, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
    return { items: items.map(dto), page, total: Number(total) };
  });
}

export async function getAdvisorTask(store, session, inputId) {
  const id = taskId(inputId);
  return store.readSnapshot(async tx => {
    const { userId } = await assertAssistantSession(tx, session);
    return resolveAdvisorStep(tx, session, dto(await owned(tx, userId, id)));
  });
}

async function reminderImportDestination(tx, userId, id) {
  const source = await tx.db.get(`SELECT b.state FROM ${tx.t('import_batches')} b WHERE b.id=? AND (
    ${advisorJSONText(tx, 'b', 'createdBy')}=? OR EXISTS (SELECT 1 FROM ${rows(tx)} t
      WHERE t.user_id=? AND t.status NOT IN ('completed','cancelled') AND t.capability_id<>'advisor.reminder'
      AND ${advisorJSONText(tx, 't', 'sourceRef.kind')}='import' AND ${advisorJSONText(tx, 't', 'sourceRef.id')}=b.id))`, [id, userId, userId]);
  if (!source) fail('No se encontró la fuente de la tarea.', 404);
  return isClosedAdvisorImportCondition(source.state);
}

export async function reserveAdvisorTask(store, session, input, { now = Date.now } = {}) {
  const { id, capabilityId, dueAt, data } = reservation(input);
  const initialDigest = hashAssistantInput({ capabilityId, dueAt, data });
  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    const prior = await tx.db.get(`SELECT ${columns}, initial_digest FROM ${rows(tx)} WHERE user_id=? AND id=?`, [userId, id]);
    if (prior) {
      if (prior.initial_digest !== initialDigest) fail('Ese identificador ya corresponde a otra solicitud.', 409);
      return resolveAdvisorStep(tx, session, dto(prior), { now });
    }
    const settings = await getAssistantSettings(tx);
    await assertAssistantAccess(tx, session, settings.version);
    const at = new Date(now()).toISOString();
    if (dueAt && dueAt <= at) fail('Elige un momento futuro para el recordatorio.', 422);
    if (capabilityId === 'advisor.reminder' && data.sourceRef?.kind === 'import') {
      // A finished, informational lot can be a destination, not an outstanding condition.
      if (await reminderImportDestination(tx, userId, data.sourceRef.id)) data.sourceBinding = 'destination';
    } else if (data.sourceRef && !await tx.db.get(`SELECT id FROM ${tx.t(SOURCES.get(data.sourceRef.kind))} WHERE id=?`, [data.sourceRef.id])) {
      fail('No se encontró la fuente de la tarea.', 404);
    }
    if (capabilityId === FOLLOW_RECOMMENDATION) data.recommendation = await captureAdvisorRecommendation(tx, session, data.recommendationId, { now });
    const draft = { id, capabilityId, status: 'active', step: capabilityId === 'advisor.reminder' ? 'remind' : 'start',
      version: 1, createdAt: at, updatedAt: at, dueAt, data };
    const resolved = await resolveAdvisorStep(tx, session, draft, { now });
    await tx.db.run(`INSERT INTO ${rows(tx)} (id, user_id, capability_id, status, step, version, created_at, updated_at, due_at, initial_digest, data) VALUES(?,?,?,?,?,1,?,?,?,?,?)`,
      [id, userId, capabilityId, resolved.status, resolved.step, at, at, dueAt, initialDigest, encodeData(advisorTaskStorage(resolved))]);
    return resolved;
  });
}

export async function updateAdvisorTask(store, session, inputId, input, { now = Date.now } = {}) {
  const id = taskId(inputId);
  const action = input?.action;
  exact(input, action === 'snooze' ? ['version', 'action', 'until'] : action === 'answer' ? ['version', 'action', 'step', 'questionId', 'field', 'value'] : ['version', 'action']);
  const version = integer(input.version, 'Versión', 1, 2147483647);
  if (!['cancel', 'snooze', 'acknowledge-reminder', 'resume', 'answer'].includes(action)) fail('Esta decisión no está permitida para la tarea.', 422);
  const until = action === 'snooze' ? advisorAbsoluteInstant(input.until) : null;
  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    const task = await owned(tx, userId, id);
    versionMatches(task, version);
    if (action === 'resume' || action === 'answer') {
      const current = dto(task);
      if (!canAdvanceAdvisorTask(current)) fail('El paso de esta tarea ya no se puede avanzar.', 409);
      const settings = await getAssistantSettings(tx);
      await assertAssistantAccess(tx, session, settings.version);
      const next = await (action === 'answer' ? answerAdvisorStep(tx, session, current, input) : resolveAdvisorStep(tx, session, current, { now }));
      if (current.data.proposal?.id !== next.data.proposal?.id) await cancelLinkedProposal(tx, userId, current.data.proposal?.id);
      const data = encodeData(advisorTaskStorage(next));
      if (task.step === next.step && task.status === next.status && task.data === data) return next;
      const at = new Date(now()).toISOString();
      const saved = await tx.db.run(`UPDATE ${rows(tx)} SET status=?,step=?,data=?,version=version+1,updated_at=? WHERE user_id=? AND id=? AND version=?`,
        [next.status, next.step, data, at, userId, id, version]);
      if (saved.changes !== 1) fail('La tarea cambió. Vuelve a consultar el estado guardado.', 409);
      return { ...next, version: version + 1, updatedAt: at };
    }
    if (action !== 'cancel' && task.capability_id !== 'advisor.reminder') fail('Esta decisión solo se admite para recordatorios.', 422);
    if (task.status === 'cancelled' || task.status === 'completed') fail('La tarea ya terminó.', 409);
    const updatedAt = new Date(now()).toISOString();
    if (until && until <= updatedAt) fail('Elige un momento futuro para el recordatorio.', 422);
    const status = action === 'cancel' ? 'cancelled' : action === 'acknowledge-reminder' ? 'completed' : task.status;
    const data = JSON.parse(task.data);
    if (action === 'cancel') {
      await cancelLinkedProposal(tx, userId, data.proposal?.id);
      delete data.proposal;
      if (data.progress) data.progress = { message: 'Tarea cancelada. El historial comercial no cambió.' };
    }
    const result = await tx.db.run(`UPDATE ${rows(tx)} SET status=?, due_at=?, data=?, version=version+1, updated_at=? WHERE user_id=? AND id=? AND version=?`,
      [status, until ?? task.due_at, encodeData(data), updatedAt, userId, id, version]);
    if (result.changes !== 1) fail('La tarea cambió. Vuelve a consultar el estado guardado.', 409);
    return dto(await owned(tx, userId, id));
  });
}

export async function deleteAdvisorTask(store, session, inputId, input) {
  const id = taskId(inputId);
  exact(input, ['version']);
  const version = integer(input.version, 'Versión', 1);
  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    const row = await owned(tx, userId, id);
    versionMatches(row, version);
    await cancelLinkedProposal(tx, userId, JSON.parse(row.data).proposal?.id);
    await tx.db.run(`DELETE FROM ${rows(tx)} WHERE user_id=? AND id=? AND version=?`, [userId, id, version]);
    return { id };
  });
}
