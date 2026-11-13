import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../validation-core.mjs';
import { validateAssistantReceipt, validateAssistantReadPage, validateEvidence, validateTurnResult } from './contracts.mjs';
import { readAdminView } from '../admin-view.mjs';
import { ASSISTANT_LIMITS } from './limits.mjs';
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
const WORK_MODES = new Set(['quick', 'extended']);
const WORK_PHASES = new Set(['planning', 'reading', 'analyzing', 'answering', 'done']);
const WORK_KINDS = new Set(['input', 'read', 'guide', 'analysis']);

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
      await invalidateWorkLease(tx, row.id, stamp);
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
    if (prior.input_hash !== inputHash || (threadId !== null && prior.thread_id !== threadId)) conflict('La solicitud ya se recibió con datos diferentes.');
    if (prior.state === 'running' && Date.parse(prior.deadline_at) <= Date.parse(stamp)) {
      return { duplicate: true, expired: true, turn: await expireAssistantTurn(tx, { userId, turnId: prior.id, at }) };
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
    await expireAssistantTurn(tx, { userId, turnId: running.id, at });
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
    if (await getAssistantWork(tx, { userId, turnId })) return decodeTurn(row);
    if (row.state === state && canonical(prior) === canonical({ ...prior, ...data, sessionTokenHash: prior.sessionTokenHash })) return decodeTurn(row);
    conflict('El turno ya terminó.');
  }
  const prior = JSON.parse(row.data);
  await assertAssistantSessionActive(tx, { userId, sessionTokenHash: prior.sessionTokenHash });
  const stamp = nowISO(at);
  if (Date.parse(row.deadline_at) <= Date.parse(stamp)) {
    return expireAssistantTurn(tx, { userId, turnId, at });
  }
  const work = await getAssistantWork(tx, { userId, turnId });
  const next = { ...prior, ...data, ...(work ? { preview: null } : {}), sessionTokenHash: prior.sessionTokenHash };
  if (work && next.publicResult) {
    next.publicResult = validateTurnResult(next.publicResult);
    safeObject(next.publicResult, 'Resultado público', ASSISTANT_LIMITS.publicResultBytes);
  }
  if (jsonBytes(next) > MAX_JSON_BYTES) fail('El resultado del turno excede el límite permitido.');
  const result = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state=?,data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [state, JSON.stringify(next), stamp, turnId, userId]);
  if (!result.changes) conflict('El turno cambió antes de guardar el resultado.');
  if (work) await invalidateWorkLease(tx, turnId, stamp);
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
  await invalidateWorkLease(tx, turnId, stamp);
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
  const work = await getAssistantWork(tx, { userId, turnId });
  if (work?.mode === 'extended') conflict('La ampliación solo permite consultar y analizar.');
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
    await invalidateWorkLease(tx, row.id, stamp);
  }
  await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET state='stale',version=version+1,updated_at=? WHERE state IN ('prepared','applied') AND configuration_version<>?`, [stamp, configurationVersion]);
}

export async function cancelPendingTurnProposals(tx, { userId, turnId, stamp = nowISO() }) {
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

function decodeWork(row) {
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

function workPreview(turn, thread, work, input) {
  return validateTurnResult({
    threadId: turn.thread_id, threadVersion: thread.version, turnId: turn.id,
    configurationVersion: turn.configuration_version, topic: 'application',
    blocks: [{ type: 'text', text: 'Aún no se han consultado datos del negocio.' }],
    evidence: [], question: null, proposal: null, receipt: null, followUps: [],
    analysis: {
      status: 'empty',
      scope: { view: readAdminView(input?.context?.view ?? { section: 'home' }), selection: input?.context?.selection ?? null, datasets: [], startedAt: turn.started_at, consultedThrough: null },
      reason: null, remaining: [], canContinue: false, sourceTurnId: work.source_turn_id,
    },
  });
}

function safePreview(value, turn) {
  const result = validateTurnResult(value);
  if (result.turnId !== turn.id || result.threadId !== turn.thread_id || result.configurationVersion !== turn.configuration_version) fail('La respuesta parcial pertenece a otro turno.');
  if (result.proposal || result.receipt) fail('Una respuesta parcial no puede autorizar operaciones.');
  safeObject(result, 'Respuesta parcial', ASSISTANT_LIMITS.publicResultBytes);
  return result;
}

async function invalidateWorkLease(tx, turnId, stamp) {
  await tx.db.run(`UPDATE ${tx.t('assistant_workspaces')} SET lease_token=NULL,lease_until=NULL,phase='done',version=version+1,updated_at=? WHERE turn_id=? AND phase<>'done'`, [stamp, turnId]);
}

async function assertWorkActive(tx, work, at) {
  const turn = await getAssistantTurn(tx, { userId: work.user_id, turnId: work.turn_id });
  if (!turn || turn.state !== 'running' || work.phase === 'done') conflict('El análisis ya terminó.');
  await assertAssistantSessionActive(tx, { userId: turn.user_id, sessionTokenHash: turn.data.sessionTokenHash });
  const settings = await tx.db.get(`SELECT version,enabled FROM ${tx.t('assistant_settings')} WHERE id=1`);
  if (settings && (!settings.enabled || settings.version !== turn.configuration_version)) conflict('La configuración del asistente cambió.');
  if (Date.parse(turn.deadline_at) <= Date.parse(nowISO(at))) conflict('El análisis venció.');
  return turn;
}

export async function getAssistantWork(tx, { userId, turnId }) {
  requireOwner(userId);
  return decodeWork(await tx.db.get(`SELECT * FROM ${tx.t('assistant_workspaces')} WHERE turn_id=? AND user_id=?`, [turnId, userId]));
}

export async function createAssistantWork(tx, { turn, mode = 'quick', sourceTurnId = null, input, at = Date.now() }) {
  if (!turn || typeof turn.id !== 'string') fail('Turno de análisis inválido.');
  const owned = await getAssistantTurn(tx, { userId: turn.user_id, turnId: turn.id });
  if (!owned || owned.thread_id !== turn.thread_id) notFound();
  if (!WORK_MODES.has(mode)) fail('Modo de análisis inválido.');
  safeObject(input, 'Entrada del análisis', ASSISTANT_LIMITS.inputBytes);
  const prior = await getAssistantWork(tx, { userId: owned.user_id, turnId: owned.id });
  if (prior) {
    const saved = await tx.db.get(`SELECT data FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=? AND kind='input'`, [owned.id]);
    if (prior.mode !== mode || prior.source_turn_id !== sourceTurnId || !saved || canonical(JSON.parse(saved.data)) !== canonical(input)) conflict('El análisis ya se inició con otra entrada.');
    return prior;
  }
  if (owned.state !== 'running') conflict('El turno ya terminó.');
  await assertAssistantSessionActive(tx, { userId: owned.user_id, sessionTokenHash: owned.data.sessionTokenHash });
  if (sourceTurnId !== null) {
    const source = await getAssistantWork(tx, { userId: owned.user_id, turnId: sourceTurnId });
    if (!source || source.turn_id === owned.id || source.thread_id !== owned.thread_id) fail('Origen del análisis no encontrado.', 404);
  }
  const stamp = nowISO(at);
  await tx.db.run(`INSERT INTO ${tx.t('assistant_workspaces')}(turn_id,thread_id,user_id,version,mode,phase,source_turn_id,lease_token,lease_until,active_request_id,data,created_at,updated_at) VALUES(?,?,?,1,?,'planning',?,NULL,NULL,NULL,'{}',?,?)`,
    [owned.id, owned.thread_id, owned.user_id, mode, sourceTurnId, stamp, stamp]);
  await tx.db.run(`INSERT INTO ${tx.t('assistant_work_chunks')}(id,turn_id,thread_id,user_id,sequence,kind,query_hash,data,created_at) VALUES(?,?,?,?,0,'input',NULL,?,?)`,
    [randomUUID(), owned.id, owned.thread_id, owned.user_id, JSON.stringify(input), stamp]);
  const work = await getAssistantWork(tx, { userId: owned.user_id, turnId: owned.id });
  const thread = await ownedThread(tx, owned.user_id, owned.thread_id);
  const preview = owned.data.preview ? safePreview(owned.data.preview, owned) : workPreview(owned, thread, work, input);
  const data = safeObject({ ...owned.data, preview }, 'Turno');
  await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET deadline_at=?,data=? WHERE id=? AND state='running'`, [nowISO(Date.parse(stamp) + ASSISTANT_LIMITS.idleMs), JSON.stringify(data), owned.id]);
  return work;
}

async function recordWorkRequest(tx, work, requestId, version, complete, stamp) {
  const sequence = Number((await tx.db.get(`SELECT MAX(sequence) AS sequence FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=?`, [work.turn_id])).sequence ?? -1) + 1;
  await tx.db.run(`INSERT INTO ${tx.t('assistant_work_chunks')}(id,turn_id,thread_id,user_id,sequence,kind,query_hash,data,created_at) VALUES(?,?,?,?,?,'analysis',?,?,?)`,
    [randomUUID(), work.turn_id, work.thread_id, work.user_id, sequence, hashAssistantInput({ requestId }), JSON.stringify({ requestReceipt: { id: requestId, version, complete } }), stamp]);
}

export async function claimAssistantWork(tx, { userId, turnId, requestId, version, at = Date.now() }) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 100 || !Number.isSafeInteger(version) || version < 1) fail('Solicitud de avance inválida.');
  const work = await getAssistantWork(tx, { userId, turnId });
  if (!work) fail('Análisis no encontrado.', 404);
  const receiptHash = hashAssistantInput({ requestId });
  const receipt = await tx.db.get(`SELECT id,data FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=? AND kind='analysis' AND query_hash=?`, [turnId, receiptHash]);
  const prior = receipt ? JSON.parse(receipt.data).requestReceipt : null;
  if (prior && prior.version !== version) conflict('La solicitud de avance ya se recibió con otro cuerpo.');
  const stamp = nowISO(at);
  const turn = await getAssistantTurn(tx, { userId, turnId });
  if (turn?.state === 'running' && Date.parse(turn.deadline_at) <= Date.parse(stamp)) {
    if (!receipt) await recordWorkRequest(tx, work, requestId, version, true, stamp);
    await expireAssistantTurn(tx, { userId, turnId, at });
    return { work: await getAssistantWork(tx, { userId, turnId }), claimed: false, duplicate: Boolean(prior), leaseToken: null };
  }
  if (work.version !== version || turn?.state !== 'running' || prior?.complete || (work.lease_token && Date.parse(work.lease_until) > Date.parse(stamp))) {
    if (!receipt) await recordWorkRequest(tx, work, requestId, version, true, stamp);
    return { work, claimed: false, duplicate: Boolean(prior), leaseToken: null };
  }
  await assertWorkActive(tx, work, at);
  const leaseToken = randomUUID(), leaseUntil = nowISO(Date.parse(stamp) + ASSISTANT_LIMITS.leaseMs);
  const updated = await tx.db.run(`UPDATE ${tx.t('assistant_workspaces')} SET lease_token=?,lease_until=?,active_request_id=?,updated_at=? WHERE turn_id=? AND user_id=? AND version=? AND (lease_token IS NULL OR lease_until<=?)`,
    [leaseToken, leaseUntil, requestId, stamp, turnId, userId, version, stamp]);
  if (!updated.changes) return { work: await getAssistantWork(tx, { userId, turnId }), claimed: false, duplicate: false, leaseToken: null };
  if (!receipt) await recordWorkRequest(tx, work, requestId, version, false, stamp);
  await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET deadline_at=? WHERE id=? AND user_id=? AND state='running'`, [nowISO(Date.parse(stamp) + ASSISTANT_LIMITS.idleMs), turnId, userId]);
  return { work: await getAssistantWork(tx, { userId, turnId }), claimed: true, duplicate: false, leaseToken };
}

async function authorizedWorkChain(tx, userId, turnId) {
  const first = await getAssistantWork(tx, { userId, turnId });
  if (!first) fail('Análisis no encontrado.', 404);
  const chain = [], visited = new Set();
  let current = first;
  while (current) {
    if (visited.has(current.turn_id) || current.thread_id !== first.thread_id) fail('Origen de análisis inválido.', 404);
    visited.add(current.turn_id);
    chain.push(current);
    if (!current.source_turn_id) break;
    current = await getAssistantWork(tx, { userId, turnId: current.source_turn_id });
    if (!current) fail('Origen de análisis no encontrado.', 404);
  }
  return chain;
}

export async function getAssistantWorkChunks(tx, { userId, turnId, sourceTurnId = null }) {
  const chain = await authorizedWorkChain(tx, userId, turnId);
  if (sourceTurnId !== null && !chain.some(work => work.turn_id === sourceTurnId)) fail('Origen de análisis no autorizado.', 404);
  const rows = [];
  for (const work of chain.toReversed()) {
    if (sourceTurnId !== null && work.turn_id !== sourceTurnId) continue;
    rows.push(...(await tx.db.all(`SELECT * FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=? AND user_id=? ORDER BY sequence`, [work.turn_id, userId])).map(row => ({ ...row, queryHash: row.query_hash, data: JSON.parse(row.data) })).filter(row => !row.data.requestReceipt));
  }
  return rows;
}

export async function resolveAssistantWorkCursor(tx, { userId, turnId, cursor }) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 120) fail('Continuación inválida.');
  const chunks = await getAssistantWorkChunks(tx, { userId, turnId });
  const chunk = chunks.find(item => item.kind === 'read' && item.data.result?.continuation?.cursor === cursor && item.data.continuationDescriptor);
  if (!chunk) fail('Continuación no encontrada.', 404);
  return JSON.parse(JSON.stringify(chunk.data.continuationDescriptor));
}

function normalizeWorkChunk(chunk) {
  if (!chunk || !WORK_KINDS.has(chunk.kind) || chunk.kind === 'input') fail('Fragmento de análisis inválido.');
  const id = chunk.id ?? randomUUID();
  if (typeof id !== 'string' || !id || id.length > 120) fail('Identidad de fragmento inválida.');
  const data = JSON.parse(canonical(safeObject(chunk.data, 'Fragmento', MAX_JSON_BYTES * 4)));
  if (Object.hasOwn(data, 'requestReceipt')) fail('Fragmento interno no permitido.');
  if (chunk.kind === 'read') {
    if (typeof data.readId !== 'string' || !data.readId || data.readId.length > 120 || !data.result) fail('Lectura persistida inválida.');
    const result = data.result;
    data.dataset = data.dataset ?? result._dataset ?? null;
    delete result._dataset;
    const descriptor = data.continuationDescriptor ?? result._continuation;
    data.evidenceMetadata = data.evidenceMetadata ?? result._evidenceMetadata ?? {};
    delete result._continuation;
    delete result._evidenceMetadata;
    if (descriptor) {
      data.continuationDescriptor = descriptor;
      if (!result.continuation) fail('Continuación de lectura inválida.');
      result.continuation = { ...result.continuation, cursor: randomUUID() };
    } else if (result.continuation) fail('La continuación no tiene un descriptor privado.');
    if (!Array.isArray(result.records) || result.records.length > 20 || !Array.isArray(result.evidence)) fail('La lectura debe dividirse en fragmentos completos.');
    result.evidence = result.evidence.map(validateEvidence);
    data.pageCursor = randomUUID();
    const publicPage = { readId: data.readId, records: result.records, evidence: result.evidence, pagination: { cursor: data.pageCursor, nextCursor: null, total: result.retrieval ? result.retrieval.recordsTotal : result.pagination?.total ?? null }, retrieval: result.retrieval };
    validateAssistantReadPage(safeObject(publicPage, 'Página de lectura', ASSISTANT_LIMITS.readPageBytes));
  }
  safeObject(data, 'Fragmento', ASSISTANT_LIMITS.chunkBytes);
  const queryHash = chunk.queryHash ?? (data.request ? hashAssistantInput({ request: data.request, sourceStamp: data.result?.retrieval?.sourceStamp ?? null }) : null);
  if (queryHash !== null) validateHash(queryHash, 'Hash de consulta');
  return { id, kind: chunk.kind, queryHash, data };
}

async function checkpointPreview(tx, turn, work, supplied) {
  const prior = supplied === undefined ? turn.data.preview : safePreview(supplied, turn);
  if (!prior) fail('El análisis no tiene una respuesta parcial inicial.');
  const current = (await getAssistantWorkChunks(tx, { userId: turn.user_id, turnId: turn.id })).filter(chunk => chunk.turn_id === turn.id);
  const invalidated = new Set(current.flatMap(chunk => chunk.data.invalidatedChunkIds ?? []));
  const all = current.filter(chunk => !invalidated.has(chunk.id));
  const result = { ...prior, proposal: null, receipt: null, question: null, evidence: [] };
  const seen = new Set();
  for (const chunk of all) for (const item of [...(chunk.data.result?.evidence ?? []), ...(chunk.data.evidence ?? [])]) {
    if (seen.has(item.id) || result.evidence.length >= 50) continue;
    const candidate = { ...result, evidence: [...result.evidence, item] };
    if (jsonBytes(candidate) > ASSISTANT_LIMITS.publicResultBytes - 8192) continue;
    seen.add(item.id);
    result.evidence.push(item);
  }
  result.blocks = result.evidence.length
    ? [{ type: 'fact', title: 'Datos consultados', evidenceIds: result.evidence.map(item => item.id) }]
    : [{ type: 'text', text: 'Aún no se han consultado datos del negocio.' }];
  const continued = new Set(all.map(chunk => chunk.data.resumedCursor ?? chunk.data.request?.select?.cursor).filter(Boolean));
  const remaining = all.filter(chunk => chunk.kind === 'read' && chunk.data.result?.continuation && !continued.has(chunk.data.result.continuation.cursor))
    .map(chunk => ({ id: chunk.data.result.continuation.cursor, label: chunk.data.result.continuation.label, kind: 'unread' }));
  for (const [index, request] of (work.data.pendingReads ?? []).entries()) remaining.push({ id: `pending_${index}`, label: `Consultar ${request.domain ?? 'datos del negocio'}`, kind: 'unread' });
  for (const [index, call] of (work.data.pendingCalls ?? []).entries()) {
    if (call.name === 'read_business' || call.name === 'read_application') remaining.push({ id: `pending_call_${index}`, label: call.name === 'read_application' ? 'Consultar guía de la aplicación' : `Consultar ${call.arguments?.domain ?? 'datos del negocio'}`, kind: 'unread' });
  }
  if (result.analysis) {
    const datasets = new Map();
    let consultedThrough = null;
    for (const chunk of all) {
      if (chunk.kind !== 'read') continue;
      if (chunk.data.dataset) datasets.set(hashAssistantInput(chunk.data.dataset), chunk.data.dataset);
      const consultedAt = chunk.data.result?.retrieval?.consultedAt;
      if (consultedAt && (!consultedThrough || consultedAt > consultedThrough)) consultedThrough = consultedAt;
    }
    result.analysis = { ...result.analysis, scope: { ...result.analysis.scope, datasets: [...datasets.values()], consultedThrough }, status: result.evidence.length ? 'partial' : 'empty', remaining: remaining.slice(0, 100), canContinue: remaining.length > 0, sourceTurnId: work.source_turn_id };
  }
  return safePreview(result, turn);
}

export async function checkpointAssistantWork(tx, { userId, turnId, leaseToken, version, phase, chunks = [], data = {}, at = Date.now() }) {
  if (!WORK_PHASES.has(phase) || !Array.isArray(chunks)) fail('Avance de análisis inválido.');
  const work = await getAssistantWork(tx, { userId, turnId });
  if (!work) fail('Análisis no encontrado.', 404);
  const stamp = nowISO(at);
  if (work.version !== version || !leaseToken || work.lease_token !== leaseToken || Date.parse(work.lease_until) <= Date.parse(stamp)) conflict('El avance perdió su autorización.');
  const turn = await assertWorkActive(tx, work, at);
  safeObject(data, 'Trabajo', ASSISTANT_LIMITS.workspaceBytes + ASSISTANT_LIMITS.publicResultBytes + 1024);
  const { preview: suppliedPreview, ...incoming } = data;
  const nextData = safeObject(incoming, 'Trabajo', ASSISTANT_LIMITS.workspaceBytes);
  const saved = [];
  let sequence = Number((await tx.db.get(`SELECT MAX(sequence) AS sequence FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=?`, [turnId])).sequence ?? -1) + 1;
  for (const chunk of chunks) {
    const normalized = normalizeWorkChunk(chunk);
    const prior = await tx.db.get(`SELECT * FROM ${tx.t('assistant_work_chunks')} WHERE id=?`, [normalized.id]);
    if (prior) {
      if (prior.turn_id !== turnId || prior.user_id !== userId || prior.kind !== normalized.kind) conflict('El fragmento ya pertenece a otro trabajo.');
      const previous = JSON.parse(prior.data);
      const comparison = { ...normalized.data };
      if (comparison.result?.continuation && previous.result?.continuation) comparison.result = { ...comparison.result, continuation: { ...comparison.result.continuation, cursor: previous.result.continuation.cursor } };
      if (previous.pageCursor) comparison.pageCursor = previous.pageCursor;
      if (canonical(previous) !== canonical(comparison)) conflict('El fragmento ya se recibió con otros datos.');
      saved.push({ ...normalized, data: previous });
      continue;
    }
    await tx.db.run(`INSERT INTO ${tx.t('assistant_work_chunks')}(id,turn_id,thread_id,user_id,sequence,kind,query_hash,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [normalized.id, turnId, work.thread_id, userId, sequence++, normalized.kind, normalized.queryHash, JSON.stringify(normalized.data), stamp]);
    saved.push(normalized);
  }
  const preview = await checkpointPreview(tx, turn, { ...work, data: nextData }, suppliedPreview);
  const turnData = safeObject({ ...turn.data, preview }, 'Turno');
  const updated = await tx.db.run(`UPDATE ${tx.t('assistant_workspaces')} SET version=version+1,phase=?,data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE turn_id=? AND user_id=? AND version=? AND lease_token=? AND lease_until>?`,
    [phase, JSON.stringify(nextData), stamp, turnId, userId, version, leaseToken, stamp]);
  if (!updated.changes) conflict('El avance perdió su autorización.');
  const receiptHash = hashAssistantInput({ requestId: work.active_request_id });
  const receipt = await tx.db.get(`SELECT id,data FROM ${tx.t('assistant_work_chunks')} WHERE turn_id=? AND kind='analysis' AND query_hash=?`, [turnId, receiptHash]);
  if (!receipt) conflict('El avance no tiene una solicitud autorizada.');
  const receiptData = JSON.parse(receipt.data);
  await tx.db.run(`UPDATE ${tx.t('assistant_work_chunks')} SET data=? WHERE id=? AND turn_id=?`, [JSON.stringify({ requestReceipt: { ...receiptData.requestReceipt, complete: true } }), receipt.id, turnId]);
  const updatedTurn = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET data=?,deadline_at=? WHERE id=? AND user_id=? AND state='running'`,
    [JSON.stringify(turnData), nowISO(Date.parse(stamp) + ASSISTANT_LIMITS.idleMs), turnId, userId]);
  if (!updatedTurn.changes) conflict('El turno terminó antes de guardar el avance.');
  return { ...await getAssistantWork(tx, { userId, turnId }), chunks: saved };
}

export async function pageAssistantWorkRead(tx, { userId, turnId, readId, cursor = null }) {
  if (typeof readId !== 'string' || !readId || (cursor !== null && (typeof cursor !== 'string' || !cursor))) fail('Página de lectura inválida.');
  const chunks = (await getAssistantWorkChunks(tx, { userId, turnId })).filter(chunk => chunk.kind === 'read' && (readId === 'all' || chunk.data.readId === readId));
  const index = cursor === null ? 0 : chunks.findIndex(chunk => chunk.data.pageCursor === cursor);
  if (index < 0 || !chunks[index]) fail('Lectura no encontrada.', 404);
  const chunk = chunks[index], result = chunk.data.result;
  const page = { readId, records: result.records, evidence: result.evidence, pagination: { cursor, nextCursor: chunks[index + 1]?.data.pageCursor ?? null, total: result.retrieval ? result.retrieval.recordsTotal : result.pagination?.total ?? null }, retrieval: result.retrieval };
  return validateAssistantReadPage(safeObject(page, 'Página de lectura', ASSISTANT_LIMITS.readPageBytes));
}

export async function expireAssistantTurn(tx, { userId, turnId, at = Date.now() }) {
  const turn = await getAssistantTurn(tx, { userId, turnId });
  if (!turn) fail('Turno no encontrado.', 404);
  if (turn.state !== 'running' || Date.parse(turn.deadline_at) > Date.parse(nowISO(at))) return turn;
  await assertAssistantSessionActive(tx, { userId, sessionTokenHash: turn.data.sessionTokenHash });
  const work = await getAssistantWork(tx, { userId, turnId }), stamp = nowISO(at);
  let data = { ...turn.data, cancellation: { reason: 'deadline', at: stamp } };
  if (work && turn.data.preview) {
    const preview = safePreview(turn.data.preview, turn);
    const result = safePreview({ ...preview, analysis: preview.analysis ? { ...preview.analysis, status: preview.evidence.length ? 'partial' : 'empty', reason: 'interrupted' } : null }, turn);
    data = { ...data, preview: null, publicResult: result };
  }
  safeObject(data, 'Turno');
  const updated = await tx.db.run(`UPDATE ${tx.t('assistant_turns')} SET state='failed',data=?,finished_at=? WHERE id=? AND user_id=? AND state='running'`, [JSON.stringify(data), stamp, turnId, userId]);
  if (!updated.changes) return getAssistantTurn(tx, { userId, turnId });
  await cancelPendingTurnProposals(tx, { userId, turnId, stamp });
  if (work) await invalidateWorkLease(tx, turnId, stamp);
  return { ...turn, state: 'failed', data, finished_at: stamp };
}
