import { authorizeAssistant, db, json, jsonBody } from '../server.mjs';
import { AppError, fail, integer, text } from '../validation-core.mjs';
import { ASSISTANT_ERROR_STATUS, validateAssistantContext, validateAssistantReceipt } from './contracts.mjs';
import { assertAssistantAccess, assertAssistantSession } from './settings.mjs';
import { assistantProposalDTO, assertAssistantProposalFresh, executeAssistantProposal, reviseAssistantProposal } from './actions.mjs';
import { canonicalAssistantJSON, getAssistantProposal, getAssistantTurn, hashAssistantInput, hashAssistantProposalPayload, transitionAssistantProposal } from './repository.mjs';
import { getSocialConnection } from '../business/social.mjs';

const messages = Object.freeze({
  ASSISTANT_DISABLED: 'Ali está deshabilitado. Puedes consultar tus conversaciones guardadas.',
  ASSISTANT_AUTH_REQUIRED: 'Inicia sesión para continuar.',
  ASSISTANT_CREDENTIAL_INVALID: 'La credencial del asistente no es válida. Revisa su configuración.',
  ASSISTANT_CONFIG_CHANGED: 'La configuración del asistente cambió. Vuelve a revisar la solicitud.',
  ASSISTANT_CONFLICT: 'La conversación, la propuesta o los datos cambiaron. Revisa el estado guardado antes de continuar.',
  ASSISTANT_MODEL_UNSUPPORTED: 'El modelo no admite las funciones requeridas por Ali.',
  ASSISTANT_UNAVAILABLE: 'Ali no pudo completar la solicitud. Puedes reabrir la conversación para consultar su estado.',
  ASSISTANT_SCOPE_DENIED: 'La solicitud no está permitida para este formulario o registro.',
});

// Never forward provider messages, bodies, headers or arbitrary exception text.
export function assistantHTTPError(error) {
  if (Object.hasOwn(ASSISTANT_ERROR_STATUS, error?.code)) {
    return json({ error: messages[error.code], code: error.code }, ASSISTANT_ERROR_STATUS[error.code]);
  }
  const status = error instanceof AppError || Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 503;
  const code = status === 401 ? 'ASSISTANT_AUTH_REQUIRED' : status === 409 ? 'ASSISTANT_CONFLICT' : status < 500 ? 'ASSISTANT_SCOPE_DENIED' : 'ASSISTANT_UNAVAILABLE';
  const message = status === 404 ? 'Conversación, turno o propuesta no encontrados.' : [400, 413, 415, 422].includes(status) ? 'Solicitud del asistente no válida. Revisa sus campos y el tamaño del contenido.' : messages[code];
  return json({ error: message, code }, status === 400 ? 422 : status);
}

const conflict = () => { throw Object.assign(new Error('ASSISTANT_CONFLICT'), { code: 'ASSISTANT_CONFLICT' }); };
function exact(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(input, key))) fail('Solicitud del asistente no válida.', 422);
  return input;
}
function identifier(value, label, max = 120) {
  const normalized = text(value, label, max, true);
  if (normalized !== value) fail('Identificador no válido.', 422);
  return normalized;
}
function formBinding(input) {
  exact(input, ['formId', 'target', 'entityId', 'recordVersion', 'generation']);
  return {
    formId: identifier(input.formId, 'Formulario', 100), target: identifier(input.target, 'Destino', 100),
    entityId: input.entityId === null ? null : identifier(input.entityId, 'Entidad', 200),
    recordVersion: input.recordVersion === null ? null : integer(input.recordVersion, 'Versión del registro', 0),
    generation: integer(input.generation, 'Generación', 0),
  };
}
function decisionInput(input, proposalId) {
  const fields = {
    apply: ['decision', 'version', 'requestId', 'formBinding', 'formSnapshot'],
    revise: ['decision', 'version', 'requestId', 'formBinding', 'payload', 'humanAcknowledgements'],
    execute: ['decision', 'version', 'requestId', 'confirmation'],
    cancel: ['decision', 'version', 'requestId'],
  };
  if (!Object.hasOwn(fields, input?.decision)) fail('Decisión no válida.', 422);
  const required = fields[input.decision].filter(key => !['humanAcknowledgements', 'formSnapshot'].includes(key));
  exact(input, fields[input.decision], required);
  const parsed = { ...input, version: integer(input.version, 'Versión', 1), requestId: identifier(input.requestId, 'Solicitud', 100) };
  if (input.decision === 'revise' || input.decision === 'apply' && !Object.hasOwn(input, 'formSnapshot')) parsed.formBinding = formBinding(input.formBinding);
  if (input.decision === 'apply' && Object.hasOwn(input, 'formSnapshot')) {
    try {
      parsed.formBinding = formBinding(input.formBinding);
      exact(input.formSnapshot, ['formId', 'target', 'entityId', 'recordVersion', 'generation', 'values', 'dirty', 'busy']);
      const snapshot = validateAssistantContext({ view: {}, form: input.formSnapshot }).form;
      if (!snapshot || snapshot.busy || canonicalAssistantJSON(formBinding(snapshotBinding(snapshot))) !== canonicalAssistantJSON(parsed.formBinding)) conflict();
      parsed.formSnapshot = snapshot;
    } catch { conflict(); }
  }
  if (input.decision === 'revise') {
    exact(input.payload, Object.keys(input.payload || {}), []);
    if (input.humanAcknowledgements !== undefined) exact(input.humanAcknowledgements, Object.keys(input.humanAcknowledgements || {}), []);
  }
  if (input.decision === 'execute') {
    if (input.requestId !== proposalId) conflict();
    if (input.confirmation !== null) {
      exact(input.confirmation, ['proposalId', 'payloadHash']);
      identifier(input.confirmation.proposalId, 'Propuesta');
      if (input.confirmation.proposalId !== proposalId || !/^[a-f0-9]{64}$/.test(input.confirmation.payloadHash)) fail('Confirmación no válida.', 422);
    }
  }
  return parsed;
}
function snapshotBinding(snapshot) {
  return Object.fromEntries(['formId', 'target', 'entityId', 'recordVersion', 'generation'].map(key => [key, snapshot[key]]));
}
function assertBinding(binding, data, { allowGenerationChange = false } = {}) {
  if (binding.target !== data.target || binding.entityId !== (data.entityId ?? null) || binding.recordVersion !== (data.recordVersion ?? null)) conflict();
  // A proposal prepared without a mounted form may bind exactly once.
  if (data.formId == null && data.generation == null) return;
  if (binding.formId !== data.formId || (allowGenerationChange ? binding.generation < data.generation : binding.generation !== data.generation)) conflict();
}
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
async function campaignReviewCurrency(tx, snapshot, patch) {
  if (!Object.hasOwn(snapshot.values, 'connectionId')) conflict();
  const currency = async id => {
    if (id == null || id === '') return null;
    let connection;
    try { connection = await getSocialConnection(tx, id); }
    catch (error) { if ([400, 404, 422].includes(error.status)) conflict(); throw error; }
    return currencyCodes.has(connection.currency) ? connection.currency : null;
  };
  const beforeId = snapshot.values.connectionId;
  const afterId = Object.hasOwn(patch, 'connectionId') ? patch.connectionId : beforeId;
  const before = await currency(beforeId);
  return { before, after: afterId === beforeId ? before : await currency(afterId) };
}
function committedResponse(row) {
  const response = row.data.executionResponse;
  if (row.state !== 'executed' || !response || !Object.hasOwn(response, 'result')) conflict();
  const receipt = validateAssistantReceipt(response.receipt);
  if (!receipt || receipt.proposalId !== row.id || receipt.id !== row.id) conflict();
  return { ...response, receipt };
}
async function ownedProposal(tx, session, proposalId) {
  const row = await getAssistantProposal(tx, { userId: session.user.id, proposalId });
  if (!row) fail('Propuesta no encontrada.', 404);
  return row;
}

async function applyProposal(store, session, proposalId, input) {
  const digest = hashAssistantInput({ proposalId, ...input });
  const response = await store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await ownedProposal(tx, session, proposalId);
    await assertAssistantAccess(tx, session, row.configuration_version);
    if (row.data.operation === 'remove') throw Object.assign(new Error('ASSISTANT_SCOPE_DENIED'), { code: 'ASSISTANT_SCOPE_DENIED' });
    if (input.formSnapshot && !['prepared', 'applied'].includes(row.state)) conflict();
    assertBinding(input.formBinding, row.data, { allowGenerationChange: Boolean(input.formSnapshot) });
    const moneyCurrency = input.formSnapshot && row.data.target === 'campaign-draft'
      ? await campaignReviewCurrency(tx, input.formSnapshot, row.data.patch) : row.data.moneyCurrency;
    const previous = row.data.lastApplication;
    if (previous?.requestId === input.requestId) {
      if (previous.digest !== digest || row.state !== 'applied') conflict();
      if (input.formSnapshot && canonicalAssistantJSON(moneyCurrency) !== canonicalAssistantJSON(row.data.moneyCurrency)) conflict();
      await assertAssistantProposalFresh(tx, row.data);
      await assertAssistantSession(tx, session);
      return { proposal: assistantProposalDTO(row), patch: row.data.patch, unchanged: true };
    }
    if (row.version !== input.version || !['prepared', 'applied'].includes(row.state)) conflict();
    const origin = await getAssistantTurn(tx, { userId: session.user.id, turnId: row.turn_id });
    if (!origin || origin.thread_id !== row.thread_id || origin.state !== 'completed' || origin.data.publicResult?.proposal?.id !== proposalId) conflict();
    try { await assertAssistantProposalFresh(tx, row.data); }
    catch (error) {
      if (!error.businessConflict) throw error;
      await transitionAssistantProposal(tx, { userId: session.user.id, proposalId, version: row.version, state: 'stale' });
      await assertAssistantSession(tx, session);
      return { conflict: true };
    }
    const data = {
      ...row.data, formId: input.formBinding.formId, generation: input.formBinding.generation,
      lastApplication: { requestId: input.requestId, digest },
    };
    if (input.formSnapshot) {
      const values = input.formSnapshot.values;
      const reviewBase = {};
      for (const field of Object.keys(data.patch)) {
        if (!Object.hasOwn(values, field)) conflict();
        reviewBase[field] = values[field];
      }
      data.reviewBase = reviewBase;
      data.diff = data.diff.map(change => ({ ...change, before: reviewBase[change.field] }));
      data.execution = 'prefill';
      data.humanAcknowledgements = {};
      data.humanDiff = [];
      data.moneyCurrency = moneyCurrency;
      delete data.lastRevisionRequestId;
      delete data.lastRevisionDigest;
      delete data.lastRevisionResponse;
    }
    data.payloadHash = hashAssistantProposalPayload(data);
    let updated;
    if (row.state === 'applied' && input.formSnapshot) {
      // Rebase is a new review revision, never an authorization to execute.
      const updatedAt = new Date().toISOString();
      const changed = await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET data=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND state='applied'`, [JSON.stringify(data), updatedAt, proposalId, session.user.id, input.version]);
      if (!changed.changes) conflict();
      updated = { ...row, data, version: row.version + 1, updated_at: updatedAt };
    } else if (row.state === 'applied') {
      // Re-delivery does not create a new revision or change the already bound form.
      if (canonicalAssistantJSON(data.patch) !== canonicalAssistantJSON(row.data.patch)) conflict();
      await tx.db.run(`UPDATE ${tx.t('assistant_proposals')} SET data=? WHERE id=? AND user_id=? AND version=?`, [JSON.stringify(data), proposalId, session.user.id, row.version]);
      updated = { ...row, data };
    } else {
      updated = await transitionAssistantProposal(tx, { userId: session.user.id, proposalId, version: input.version, state: 'applied', data });
    }
    await assertAssistantSession(tx, session);
    return { proposal: assistantProposalDTO(updated), patch: updated.data.patch, unchanged: !input.formSnapshot && row.state === 'applied' };
  });
  if (response.conflict) conflict();
  return response;
}

async function cancelProposal(store, session, proposalId, input) {
  const digest = hashAssistantInput({ proposalId, ...input });
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const row = await ownedProposal(tx, session, proposalId);
    // A committed result wins over cancellation, even after disabling or changing Ali.
    if (row.state === 'executed') {
      const response = { proposal: assistantProposalDTO(row), cancelled: false, ...committedResponse(row) };
      await assertAssistantSession(tx, session);
      return response;
    }
    const previous = row.data.lastCancellation;
    if (previous?.requestId === input.requestId) {
      if (previous.digest !== digest || row.state !== 'cancelled') conflict();
      await assertAssistantSession(tx, session);
      return { proposal: assistantProposalDTO(row), cancelled: true };
    }
    if (row.version !== input.version) conflict();
    if (row.state === 'cancelled') {
      await assertAssistantSession(tx, session);
      return { proposal: assistantProposalDTO(row), cancelled: true };
    }
    if (!['prepared', 'applied'].includes(row.state)) conflict();
    const data = { ...row.data, lastCancellation: { requestId: input.requestId, digest } };
    const updated = await transitionAssistantProposal(tx, { userId: session.user.id, proposalId, version: input.version, state: 'cancelled', data });
    await assertAssistantSession(tx, session);
    return { proposal: assistantProposalDTO(updated), cancelled: true };
  });
}

export async function getAssistantProposalHTTP(request, { params }) {
  try {
    const session = await authorizeAssistant(request);
    const { proposalId } = await params;
    identifier(proposalId, 'Propuesta');
    const store = await db();
    return json(await store.readSnapshot(async tx => {
      await assertAssistantSession(tx, session);
      const row = await ownedProposal(tx, session, proposalId);
      return { proposal: assistantProposalDTO(row), receipt: row.state === 'executed' ? committedResponse(row).receipt : null };
    }));
  } catch (error) { return assistantHTTPError(error); }
}

export async function postAssistantProposalHTTP(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const { proposalId } = await params;
    identifier(proposalId, 'Propuesta');
    const input = decisionInput(await jsonBody(request, { maxBytes: 64 * 1024 }), proposalId);
    const store = await db();
    if (input.decision === 'execute') {
      // Central execution recovers its durable receipt before current config/version guards.
      return json(await executeAssistantProposal(store, session, { proposalId, version: input.version, requestId: input.requestId, confirmation: input.confirmation }));
    }
    if (input.decision === 'revise') {
      return json(await reviseAssistantProposal(store, session, { proposalId, version: input.version, requestId: input.requestId, formBinding: input.formBinding, payload: input.payload, humanAcknowledgements: input.humanAcknowledgements }));
    }
    return json(input.decision === 'apply' ? await applyProposal(store, session, proposalId, input) : await cancelProposal(store, session, proposalId, input));
  } catch (error) { return assistantHTTPError(error); }
}
