import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../validation-core.mjs';
import { validateAssistantReceipt, validateTurnResult } from './contracts.mjs';
import { normalizeAssistantWorkMemory, normalizeAssistantPendingQuestion } from './memory.mjs';

const HEX_256 = /^[a-f0-9]{64}$/;
const STATES = new Set(['running', 'completed', 'failed', 'cancelled']);
const PROPOSAL_STATES = new Set(['prepared', 'applied', 'executed', 'cancelled', 'stale']);
const MAX_JSON_BYTES = 96 * 1024;
const MAX_MEMORY_BYTES = 12 * 1024;
const MAX_THREAD_TITLE = 200;
const MAX_PAGE = 100000;
const nowISO = value => new Date(value ?? Date.now()).toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const conflict = message => fail(message, 409);
const notFound = () => fail('Conversación no encontrada.', 404);

function requireOwner(userId) {
  if (typeof userId !== 'string' || !userId || userId.length > 200) fail('Usuario del asistente inválido.', 401);
}

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('El contenido persistido contiene un número inválido.');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) fail('El contenido persistido no es serializable.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  else {
    const keys = Object.keys(value).sort();
    if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) fail('Clave persistida no permitida.');
    result = `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

export function canonicalAssistantJSON(value) { return canonical(value); }
export function hashAssistantInput(value) { return digest(canonical(value)); }

// Bind confirmation to the entire normalized effect, including human-only controls and previews.
export function hashAssistantProposalPayload(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) fail('Propuesta inválida.');
  const payload = {
    target: proposal.target ?? null,
    entityId: proposal.entityId ?? null,
    recordVersion: proposal.recordVersion ?? null,
    formId: proposal.formId ?? null,
    generation: proposal.generation ?? null,
    configurationVersion: proposal.configurationVersion ?? null,
    execution: proposal.execution ?? null,
    patch: proposal.patch,
    payload: proposal.payload ?? null,
    submission: proposal.submission ?? null,
    humanAcknowledgements: proposal.humanAcknowledgements ?? null,
    references: proposal.references ?? null,
    preview: proposal.preview ?? null,
    moneyCurrency: proposal.moneyCurrency ?? null,
    reviewBase:proposal.reviewBase??null,
    operation: proposal.operation ?? null,
  };
  if (!payload.target || !payload.patch || typeof payload.patch !== 'object' || Array.isArray(payload.patch)) fail('La propuesta no tiene un payload válido.');
  return digest(canonical(payload));
}

function safeThreadData(value) {
  safeObject(value, 'Memoria', MAX_JSON_BYTES);
  if (typeof value.title === 'string' && value.title.length > MAX_THREAD_TITLE) fail('El título de conversación excede el límite permitido.');
  const result = { ...value };
  if (Object.hasOwn(value, 'pendingQuestion')) result.pendingQuestion = normalizeAssistantPendingQuestion(value.pendingQuestion);
  if (Object.hasOwn(value, 'workMemory')) {
    const reserve = jsonBytes({ ...result, workMemory: {} }) - 2;
    result.workMemory = normalizeAssistantWorkMemory(value.workMemory, { reservedBytes: reserve });
  }
  return safeObject(result, 'Memoria', MAX_MEMORY_BYTES);
}

function safeObject(value, label, limit = MAX_JSON_BYTES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} inválido.`);
  canonical(value);
  if (jsonBytes(value) > limit) fail(`${label} excede el límite permitido.`);
  return value;
}
function safeReason(reason) {
  if (typeof reason !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(reason)) fail('Motivo de cancelación inválido.');
  return reason;
}
function validateHash(value, label) {
  if (typeof value !== 'string' || !HEX_256.test(value)) fail(`${label} inválido.`);
  return value;
}
function decodeTurn(row) {
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
function decodeProposal(row) {
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
async function ownedThread(tx, userId, threadId) {
  requireOwner(userId);
  const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_threads')} WHERE id=? AND user_id=?`, [threadId, userId]);
  if (!row) notFound();
  return row;
}

export async function assertAssistantSessionActive(tx, { userId, sessionTokenHash }) {
  if (typeof userId !== 'string' || !userId || typeof sessionTokenHash !== 'string' || !HEX_256.test(sessionTokenHash)) {
    fail('La sesión del asistente no es válida.', 401);
  }
  const lock = tx.provider === 'supabase' ? ' FOR UPDATE' : '';
  const user = await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1${lock}`, [userId]);
  if (!user) fail('La sesión ya no está activa.', 401);
  const active = await tx.db.get(
    `SELECT token_hash FROM ${tx.t('sessions')} WHERE token_hash=? AND user_id=? AND expires>?${lock}`,
    [sessionTokenHash, userId, Date.now()],
  );
  if (!active) fail('La sesión ya no está activa.', 401);
  return true;
}

export async function cancelAssistantTurns(tx, { userId, sessionTokenHash = null, reason, at }) {
  if (typeof userId !== 'string' || !userId) fail('Usuario inválido.');
  if (sessionTokenHash !== null) validateHash(sessionTokenHash, 'Hash de sesión');
  const safe = safeReason(reason), stamp = nowISO(at);
  const rows = await tx.db.all(`SELECT id,data FROM ${tx.t('assistant_turns')} WHERE user_id=? AND state='running'`, [userId]);
  let cancelled = 0;
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (sessionTokenHash !== null && data.sessionTokenHash !== sessionTokenHash) continue;
    const next = { ...data, cancellation: { reason: safe, at: stamp } };
    const result = await tx.db.run(
      `UPDATE ${tx.t('assistant_turns')} SET state='cancelled',data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`,
      [JSON.stringify(next), stamp, row.id, userId],
    );
    if (result.changes) {
      cancelled++;
      await tx.db.run(
        `UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE turn_id=? AND user_id=? AND state IN ('prepared','applied')`,
        [stamp, row.id, userId],
      );
    }
  }
  return cancelled;
}

export async function createAssistantThread(tx, { userId, id = randomUUID(), data = {}, at = Date.now() }) {
  requireOwner(userId);
  const stamp = nowISO(at);
  data = safeThreadData(data);
  await tx.db.run(`INSERT INTO ${tx.t('assistant_threads')}(id,user_id,version,data,created_at,updated_at) VALUES(?,?,1,?,?,?)`,
    [id, userId, JSON.stringify(data), stamp, stamp]);
  return { id, user_id: userId, version: 1, data, created_at: stamp, updated_at: stamp };
}

export async function getAssistantThread(tx, { userId, threadId, before = null }) {
  const thread = await ownedThread(tx, userId, threadId);
  let cursor = null;
  if (before !== null) {
    if (typeof before !== 'string' || !before || before.length > 200) fail('Cursor de conversación inválido.');
    cursor = await tx.db.get(`SELECT started_at,id FROM ${tx.t('assistant_turns')} WHERE id=? AND user_id=? AND thread_id=?`, [before, userId, threadId]);
    if (!cursor) notFound();
  }
  const rows = await tx.db.all(
    `SELECT * FROM ${tx.t('assistant_turns')} WHERE user_id=? AND thread_id=?${cursor ? ' AND (started_at<? OR (started_at=? AND id<?))' : ''} ORDER BY started_at DESC,id DESC LIMIT 41`,
    cursor ? [userId, threadId, cursor.started_at, cursor.started_at, cursor.id] : [userId, threadId],
  );
  const hasMore = rows.length > 40;
  const turns = rows.slice(0, 40).reverse().map(decodeTurn);
  const proposals = await tx.db.all(
    `SELECT * FROM ${tx.t('assistant_proposals')} WHERE user_id=? AND thread_id=? ORDER BY created_at,id`,
    [userId, threadId],
  );
  return {
    ...thread, data: JSON.parse(thread.data), turns, proposals: proposals.map(decodeProposal),
    pagination: { hasMore, before: hasMore ? turns[0].id : null },
  };
}

export async function listAssistantThreads(tx, { userId, page = 1 } = {}) {
  requireOwner(userId);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) fail('Página inválida.');
  const offset = (page - 1) * 20;
  const rows = await tx.db.all(`SELECT * FROM ${tx.t('assistant_threads')} WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET ?`, [userId, offset]);
  const count = await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('assistant_threads')} WHERE user_id=?`, [userId]);
  return { threads: rows.map(row => ({ ...row, data: JSON.parse(row.data) })), page, hasMore: offset + rows.length < Number(count.count) };
}

export async function updateAssistantThread(tx, { userId, threadId, version, data, at = Date.now() }) {
  await ownedThread(tx, userId, threadId);
  data = safeThreadData(data);
  const stamp = nowISO(at);
  const result = await tx.db.run(`UPDATE ${tx.t('assistant_threads')} SET data=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?`,
    [JSON.stringify(data), stamp, threadId, userId, version]);
  if (!result.changes) conflict('La conversación cambió en otra solicitud.');
  return { ...data, id: threadId, version: version + 1, updatedAt: stamp };
}

export async function deleteAssistantThread(tx, { userId, threadId, version, at = Date.now() }) {
  const thread = await ownedThread(tx, userId, threadId);
  if (thread.version !== version) conflict('La conversación cambió en otra solicitud.');
  const stamp = nowISO(at);
  const turns = await tx.db.all(`SELECT id,data FROM ${tx.t('assistant_turns')} WHERE user_id=? AND thread_id=? AND state='running'`, [userId, threadId]);
  for (const turn of turns) {
    const data = { ...JSON.parse(turn.data), cancellation: { reason: 'thread_deleted', at: stamp } };
    await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='cancelled',data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [JSON.stringify(data), stamp, turn.id, userId]);
  }
  await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE user_id=? AND thread_id=? AND state IN ('prepared','applied')`, [stamp, userId, threadId]);
  const deleted = await tx.db.run(`DELETE FROM ${tx.t('assistant_threads')} WHERE id=? AND user_id=? AND version=?`, [threadId, userId, version]);
  if (!deleted.changes) conflict('La conversación cambió en otra solicitud.');
  return { deleted: true };
}

export async function reserveAssistantTurn(tx, { userId, threadId = null, threadVersion = null, requestId, inputHash, configurationVersion, data, sessionTokenHash, at = Date.now(), deadlineAt = at + 90_000 }) {
  validateHash(inputHash, 'Hash de entrada');
  validateHash(sessionTokenHash, 'Hash de sesión');
  await assertAssistantSessionActive(tx, { userId, sessionTokenHash });
  if (!Number.isSafeInteger(configurationVersion) || configurationVersion < 0) fail('Versión de configuración inválida.');
  if (typeof requestId !== 'string' || !requestId || requestId.length > 100) fail('Solicitud inválida.');
  safeObject(data, 'Turno');
  const stamp = nowISO(at), deadline = nowISO(deadlineAt);
  const prior = await tx.db.get(`SELECT * FROM ${tx.t('assistant_turns')} WHERE user_id=? AND request_id=?`, [userId, requestId]);
  if (prior) {
    const priorData = JSON.parse(prior.data);
    if (prior.input_hash !== inputHash || (threadId !== null && prior.thread_id !== threadId)) conflict('La solicitud ya se recibió con datos diferentes.');
    if (prior.state === 'running' && Date.parse(prior.deadline_at) <= Date.parse(stamp)) {
      const expired = { ...priorData, cancellation: { reason: 'deadline', at: stamp } };
      await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='failed',data=?,finished_at=? WHERE id=? AND state='running'`, [JSON.stringify(expired), stamp, prior.id]);
      await cancelPendingTurnProposals(tx, { userId, turnId: prior.id, stamp });
      return { duplicate: true, expired: true, turn: decodeTurn({ ...prior, state: 'failed', data: JSON.stringify(expired), finished_at: stamp }) };
    }
    return { duplicate: true, turn: decodeTurn(prior) };
  }
  let thread;
  if (threadId === null) {
    thread = await createAssistantThread(tx, { userId, data: {}, at });
    threadId = thread.id;
  } else {
    thread = await ownedThread(tx, userId, threadId);
    if (thread.version !== threadVersion) conflict('La conversación cambió en otra solicitud.');
  }
  const running = await tx.db.get(`SELECT id,data,deadline_at FROM ${tx.t('assistant_turns')} WHERE thread_id=? AND user_id=? AND state='running'`, [threadId, userId]);
  if (running && Date.parse(running.deadline_at) <= Date.parse(stamp)) {
    const stale = { ...JSON.parse(running.data), cancellation: { reason: 'deadline', at: stamp } };
    await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='failed',data=?,finished_at=? WHERE id=? AND state='running'`, [JSON.stringify(stale), stamp, running.id]);
    await cancelPendingTurnProposals(tx, { userId, turnId: running.id, stamp });
  } else if (running) conflict('Ya hay una respuesta en curso para esta conversación.');
  const nextVersion = thread.version + 1;
  const versioned = await tx.db.run(`UPDATE ${tx.t('assistant_threads')} SET version=?,updated_at=? WHERE id=? AND user_id=? AND version=?`,
    [nextVersion, stamp, threadId, userId, thread.version]);
  if (!versioned.changes) conflict('La conversación cambió en otra solicitud.');
  thread = { ...thread, version: nextVersion, updated_at: stamp };
  const id = randomUUID(), internal = { ...data, sessionTokenHash };
  if (jsonBytes(internal) > MAX_JSON_BYTES) fail('El contexto del turno excede el límite permitido.');
  try {
    await tx.db.run(`INSERT INTO ${tx.t('assistant_turns')}(id,thread_id,user_id,request_id,input_hash,configuration_version,state,data,started_at,finished_at,deadline_at) VALUES(?,?,?,?,?,?,'running',?,?,NULL,?)`,
      [id, threadId, userId, requestId, inputHash, configurationVersion, JSON.stringify(internal), stamp, deadline]);
  } catch (error) {
    if (/unique|constraint/i.test(error.message)) conflict('Ya hay una respuesta en curso o esta solicitud ya se recibió.');
    throw error;
  }
  return { duplicate: false, threadId, threadVersion: thread.version, turn: { id, thread_id: threadId, user_id: userId, request_id: requestId, input_hash: inputHash, configuration_version: configurationVersion, state: 'running', data: internal, started_at: stamp, deadline_at: deadline } };
}

export async function getAssistantTurn(tx, { userId, turnId }) {
  requireOwner(userId);
  const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_turns')} WHERE id=? AND user_id=?`, [turnId, userId]);
  return decodeTurn(row);
}

export async function finishAssistantTurn(tx, { userId, turnId, state = 'completed', data, at = Date.now() }) {
  requireOwner(userId);
  if (!STATES.has(state) || state === 'running') fail('Estado final de turno inválido.');
  safeObject(data, 'Resultado del turno');
  const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_turns')} WHERE id=? AND user_id=?`, [turnId, userId]);
  if (!row) fail('Turno no encontrado.', 404);
  if (row.state !== 'running') {
    const prior = JSON.parse(row.data);
    if (row.state === state && canonical(prior) === canonical({ ...prior, ...data, sessionTokenHash: prior.sessionTokenHash })) return decodeTurn(row);
    conflict('El turno ya terminó.');
  }
  const prior = JSON.parse(row.data);
  await assertAssistantSessionActive(tx, { userId, sessionTokenHash: prior.sessionTokenHash });
  const stamp = nowISO(at);
  if (Date.parse(row.deadline_at) <= Date.parse(stamp)) {
    const expired = { ...prior, cancellation: { reason: 'deadline', at: stamp } };
    const expiredResult = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='failed',data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [JSON.stringify(expired), stamp, turnId, userId]);
    if (!expiredResult.changes) conflict('El turno cambió antes de registrar su vencimiento.');
    await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE turn_id=? AND user_id=? AND state IN ('prepared','applied')`, [stamp, turnId, userId]);
    return { ...row, state: 'failed', data: expired, finished_at: stamp };
  }
  const next = { ...prior, ...data, sessionTokenHash: prior.sessionTokenHash };
  if (jsonBytes(next) > MAX_JSON_BYTES) fail('El resultado del turno excede el límite permitido.');
  const result = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state=?,data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [state, JSON.stringify(next), stamp, turnId, userId]);
  if (!result.changes) conflict('El turno cambió antes de guardar el resultado.');
  if (state !== 'completed') await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE turn_id=? AND user_id=? AND state IN ('prepared','applied')`, [stamp, turnId, userId]);
  return { ...row, state, data: next, finished_at: stamp };
}

export async function cancelAssistantTurn(tx, { userId, turnId, reason = 'cancelled', at = Date.now() }) {
  requireOwner(userId);
  const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_turns')} WHERE id=? AND user_id=?`, [turnId, userId]);
  if (!row) fail('Turno no encontrado.', 404);
  if (row.state !== 'running') return decodeTurn(row);
  const stamp = nowISO(at), data = { ...JSON.parse(row.data), cancellation: { reason: safeReason(reason), at: stamp } };
  const result = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='cancelled',data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [JSON.stringify(data), stamp, turnId, userId]);
  if (!result.changes) conflict('El turno cambió antes de cancelarlo.');
  await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE turn_id=? AND user_id=? AND state IN ('prepared','applied')`, [stamp, turnId, userId]);
  return { ...row, state: 'cancelled', data, finished_at: stamp };
}

export async function saveAssistantProposal(tx, { userId, threadId, turnId, id = randomUUID(), configurationVersion, data, at = Date.now() }) {
  safeObject(data, 'Propuesta');
  const turn = await tx.db.get(`SELECT id,state,thread_id,configuration_version,data,deadline_at FROM ${tx.t('assistant_turns')} WHERE id=? AND user_id=? AND thread_id=?`, [turnId, userId, threadId]);
  if (!turn || turn.state !== 'running') conflict('El turno ya no puede preparar propuestas.');
  await assertAssistantSessionActive(tx, { userId, sessionTokenHash: JSON.parse(turn.data).sessionTokenHash });
  if (Date.parse(turn.deadline_at) <= Date.parse(nowISO(at))) conflict('El turno ya venció.');
  if (!Number.isSafeInteger(configurationVersion) || configurationVersion !== turn.configuration_version
    || data.configurationVersion !== configurationVersion) conflict('La configuración cambió antes de guardar la propuesta.');
  const thread = await ownedThread(tx, userId, threadId);
  if (await tx.db.get(`SELECT id FROM ${tx.t('assistant_proposals')} WHERE turn_id=? AND user_id=?`, [turnId, userId])) conflict('Este turno ya tiene una propuesta.');
  const payloadHash = hashAssistantProposalPayload(data);
  const stamp = nowISO(at), stored = { ...data, payloadHash };
  await tx.db.run(`INSERT INTO ${tx.t('assistant_proposals')}(id,thread_id,turn_id,user_id,version,configuration_version,state,data,created_at,updated_at) VALUES(?,?,?,?,1,?,'prepared',?,?,?)`,
    [id, thread.id, turnId, userId, configurationVersion, JSON.stringify(stored), stamp, stamp]);
  return { id, thread_id: threadId, turn_id: turnId, user_id: userId, version: 1, configuration_version: configurationVersion, state: 'prepared', data: stored, created_at: stamp, updated_at: stamp };
}

export async function getAssistantProposal(tx, { userId, proposalId }) {
  requireOwner(userId);
  return decodeProposal(await tx.db.get(`SELECT * FROM ${tx.t('assistant_proposals')} WHERE id=? AND user_id=?`, [proposalId, userId]));
}

const ALLOWED_TRANSITIONS = Object.freeze({ prepared: new Set(['prepared', 'applied', 'executed', 'cancelled', 'stale']), applied: new Set(['prepared', 'executed', 'cancelled', 'stale']), executed: new Set(), cancelled: new Set(), stale: new Set() });
export async function transitionAssistantProposal(tx, { userId, proposalId, version, state, data = null, at = Date.now() }) {
  requireOwner(userId);
  if (!PROPOSAL_STATES.has(state)) fail('Estado de propuesta inválido.');
  const row = await tx.db.get(`SELECT * FROM ${tx.t('assistant_proposals')} WHERE id=? AND user_id=?`, [proposalId, userId]);
  if (!row) fail('Propuesta no encontrada.', 404);
  if (row.version !== version) conflict('La propuesta cambió en otra solicitud.');
  if (!ALLOWED_TRANSITIONS[row.state]?.has(state)) conflict(`Transición de propuesta no permitida: ${row.state} → ${state}.`);
  if (state === 'executed') conflict('La ejecución requiere un resultado y un recibo comercial persistidos.');
  const current = JSON.parse(row.data), next = data == null ? current : safeObject(data, 'Propuesta');
  const expectedHash = hashAssistantProposalPayload(next);
  if (next.payloadHash !== expectedHash) conflict('El hash de payload de la propuesta no coincide.');
  const stamp = nowISO(at), result = await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state=?,data=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND state=?`,
    [state, JSON.stringify(next), stamp, proposalId, userId, version, row.state]);
  if (!result.changes) conflict('La propuesta cambió en otra solicitud.');
  return { ...row, version: version + 1, state, data: next, updated_at: stamp };
}

export async function invalidateAssistantConfiguration(tx, { configurationVersion, at = Date.now() }) {
  if (!Number.isSafeInteger(configurationVersion) || configurationVersion < 0) fail('Versión de configuración inválida.');
  const stamp = nowISO(at);
  const turns = await tx.db.all(`SELECT id,data FROM ${tx.t('assistant_turns')} WHERE state='running' AND configuration_version<>?`, [configurationVersion]);
  for (const row of turns) {
    const data = { ...JSON.parse(row.data), cancellation: { reason: 'configuration_changed', at: stamp } };
    await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='cancelled',data=?,finished_at=? WHERE id=? AND state='running'`, [JSON.stringify(data), stamp, row.id]);
  }
  await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='stale',version=version+1,updated_at=? WHERE state IN ('prepared','applied') AND configuration_version<>?`, [stamp, configurationVersion]);
}

async function cancelPendingTurnProposals(tx, { userId, turnId, stamp }) {
  await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='cancelled',version=version+1,updated_at=? WHERE turn_id=? AND user_id=? AND state IN ('prepared','applied')`, [stamp, turnId, userId]);
}

// Callers authorize the current session and keep the write lock through the business commit.
// Recovery intentionally precedes configuration and commercial-version checks.
export async function recoverAssistantExecution(tx, { userId, proposalId, executionDigest }) {
  validateHash(executionDigest, 'Hash de ejecución');
  const proposal = await getAssistantProposal(tx, { userId, proposalId });
  if (!proposal) fail('Propuesta no encontrada.', 404);
  const data = proposal.data;
  if (!data.executionDigest) return null;
  if (data.executionDigest !== executionDigest) conflict('La ejecución ya se recibió con datos diferentes.');
  if (proposal.state !== 'executed' || !data.executionResponse?.receipt || !Object.hasOwn(data.executionResponse, 'result')) conflict('El resultado de ejecución no está disponible.');
  const receipt = validateAssistantReceipt(data.executionResponse.receipt);
  if (receipt.id !== proposalId || receipt.proposalId !== proposalId) conflict('El recibo no corresponde a la propuesta.');
  return data.executionResponse;
}

export async function recordAssistantExecution(tx, {
  userId, proposalId, version, executionDigest, executionRequestId = proposalId,
  response, sessionTokenHash = null, at = Date.now(),
}) {
  if (sessionTokenHash !== null) await assertAssistantSessionActive(tx, { userId, sessionTokenHash });
  const recovered = await recoverAssistantExecution(tx, { userId, proposalId, executionDigest });
  if (recovered) return recovered;
  const proposal = await getAssistantProposal(tx, { userId, proposalId });
  if (executionRequestId !== proposalId || proposal.version !== version || !['prepared', 'applied'].includes(proposal.state)) conflict('La propuesta ya no se puede ejecutar.');
  if (proposal.data.payloadHash !== hashAssistantProposalPayload(proposal.data)) conflict('El payload persistido de la propuesta cambió.');
  safeObject(response, 'Resultado comercial');
  if (!Object.hasOwn(response, 'result')) fail('Falta el resultado comercial.');
  const receipt = validateAssistantReceipt(response.receipt);
  if (!receipt || receipt.id !== proposalId || receipt.proposalId !== proposalId || receipt.target !== proposal.data.target) conflict('El recibo no corresponde a la propuesta.');
  const thread = await ownedThread(tx, userId, proposal.thread_id);
  const turn = await getAssistantTurn(tx, { userId, turnId: proposal.turn_id });
  if (!turn || turn.thread_id !== thread.id || turn.state !== 'completed' || !turn.data.publicResult) conflict('El turno de origen ya no permite guardar cambios.');
  const stamp = nowISO(at);
  const stored = { ...proposal.data, executionRequestId, executionDigest, executionResponse: response };
  safeObject(stored, 'Propuesta ejecutada');
  const updated = await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='executed',version=version+1,data=?,updated_at=? WHERE id=? AND user_id=? AND version=? AND state=?`,
    [JSON.stringify(stored), stamp, proposalId, userId, version, proposal.state]);
  if (!updated.changes) conflict('La propuesta cambió antes de guardar el recibo.');
  const memoryData = JSON.parse(thread.data);
  const memory = normalizeAssistantWorkMemory(memoryData.workMemory);
  memory.pendingProposalIds = memory.pendingProposalIds.filter(id => id !== proposalId);
  memory.completedReceiptIds = [...new Set([...memory.completedReceiptIds, receipt.id])].slice(-4);
  memory.followUps = memory.followUps.filter(item => item.id !== `proposal:${proposalId}`);
  const publicProposal = turn.data.publicResult.proposal;
  if (!publicProposal || publicProposal.id !== proposalId) conflict('La propuesta no pertenece al resultado del turno.');
  const publicResult = validateTurnResult({
    ...turn.data.publicResult, threadVersion: thread.version + 1, receipt,
    proposal: {
      ...publicProposal, version: version + 1, state: 'executed',
      entityId: receipt.entityId, recordVersion: receipt.recordVersion,
      open: { ...stored.open, entityId: receipt.entityId },
      payloadHash: stored.payloadHash, patch: stored.patch, diff: stored.diff,
      execution: stored.execution, missingFields: stored.missingFields,
      formId: stored.formId ?? null, generation: stored.generation ?? null,
      humanDiff: stored.humanDiff ?? [],
      moneyCurrency:stored.moneyCurrency,
    },
    followUps: memory.followUps,
  });
  await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET data=? WHERE id=? AND user_id=? AND thread_id=? AND state='completed'`,
    [JSON.stringify({ ...turn.data, publicResult }), turn.id, userId, thread.id]);
  await updateAssistantThread(tx, {
    userId, threadId: thread.id, version: thread.version,
    data: { ...memoryData, workMemory: memory }, at,
  });
  return response;
}

export const ASSISTANT_PERSISTENCE_LIMITS = Object.freeze({ threadPageSize: 20, turnPageSize: 40, memoryBytes: MAX_MEMORY_BYTES, jsonBytes: MAX_JSON_BYTES, titleCharacters: MAX_THREAD_TITLE });
