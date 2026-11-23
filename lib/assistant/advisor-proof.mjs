const CAPABILITY = 'orders.ship-order';
const CREATE = 'shipment-create';
const LINK = 'business-action:link-shipment';
const EVENT = 'shipment-event';
const TARGETS = new Map([['review-create', CREATE], ['review-link', LINK], ['review-event', EVENT]]);
const pending = state => state === 'prepared' || state === 'applied';
const terminal = status => status === 'cancelled' || status === 'completed';
const taskTable = tx => tx.t('assistant_advisor_tasks');
const versioned = (id, version) => typeof id === 'string' && id.length > 0 && Number.isSafeInteger(version) && version > 0;
const conflict = () => {
  throw Object.assign(new Error('La propuesta no corresponde al paso vigente de la tarea.'), {
    code: 'ASSISTANT_CONFLICT', status: 409, businessConflict: true,
  });
};

export async function getAdvisorTurnTask(tx, userId, taskId) {
  const row = await tx.db.get(`SELECT id,capability_id,status,step,version,data FROM ${taskTable(tx)} WHERE id=? AND user_id=?`, [taskId, userId]);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

// A task is descriptive context, not a reference source or an input to a business payload.
export function advisorTurnSummary(task) {
  if (!task) return null;
  const { question, action } = task.data.progress ?? {};
  return {
    capabilityId: task.capability_id, status: task.status, step: task.step,
    ...(!terminal(task.status) && question ? { question: { field: question.field, type: question.type } } : {}),
    ...(!terminal(task.status) && action ? { focus: action.focus, target: TARGETS.get(task.step) ?? null } : {}),
  };
}

function assertObservedEvent(observed, payload, draft) {
  if (!observed?.status || !observed.occurredOn || payload.occurredAt || payload.correctionOf
    || (payload.precision && payload.precision !== 'day') || (payload.source && payload.source !== 'manual')) conflict();
  for (const field of ['status', 'occurredOn']) {
    if ((!draft || payload[field]) && payload[field] !== observed[field]) conflict();
  }
}

function assertCandidate(task, binding, data, { draft = false } = {}) {
  const shipment = task?.data.shipment;
  if (!task || task.capability_id !== CAPABILITY || task.status !== 'waiting_human' || task.step !== binding.step
    || TARGETS.get(task.step) !== data.target || data.operation !== 'save'
    || !shipment || !versioned(shipment.orderId, shipment.orderVersion)) conflict();
  const { orderId, orderVersion, shipmentId, shipmentVersion } = shipment;
  const { target, entityId, recordVersion, payload, references } = data;
  const hasRef = (kind, id, version) => references?.some(ref => ref.kind === kind && ref.id === id && ref.version === version);
  if (!payload || !hasRef('order', orderId, orderVersion)) conflict();
  if (target === CREATE) {
    if (entityId !== orderId || recordVersion !== orderVersion || payload.orderId !== orderId || payload.replacesShipmentId) conflict();
    for (const field of ['tracking', 'carrier']) {
      const value = payload[field]?.trim();
      if (!shipment[field] || ((!draft || value) && value !== shipment[field])) conflict();
    }
    return;
  }
  if (!versioned(shipmentId, shipmentVersion) || entityId !== shipmentId || recordVersion !== shipmentVersion
    || payload.version !== shipmentVersion || !hasRef('shipment', shipmentId, shipmentVersion)) conflict();
  if (target === LINK) {
    if (payload.shipmentId !== shipmentId || payload.orderId !== orderId) conflict();
  } else {
    if (data.fixed?.shipment?.orderId !== orderId) conflict();
    assertObservedEvent(shipment.observedEvent, payload, draft);
  }
}

function proposalLink(proposal, step) {
  const { target, entityId, recordVersion } = proposal.data;
  return { id: proposal.id, target, entityId, recordVersion, step };
}

async function updateTaskData(tx, task, userId, data, at) {
  const saved = await tx.db.run(`UPDATE ${taskTable(tx)} SET data=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=?`,
    [JSON.stringify(data), at, task.id, userId, task.version]);
  if (saved.changes !== 1) conflict();
}

export async function linkAdvisorProposal(tx, turn, proposal, at) {
  const binding = turn.data.advisorTask, userId = turn.user_id;
  if (!binding || proposal.user_id !== userId || proposal.turn_id !== turn.id || !pending(proposal.state)) conflict();
  const task = await getAdvisorTurnTask(tx, userId, binding.id);
  assertCandidate(task, binding, proposal.data, { draft: proposal.data.missingFields.length > 0 });
  if (task.version !== binding.version) conflict();
  const previous = task.data.proposal;
  if (previous) {
    const row = await tx.db.get(`SELECT state FROM ${tx.t('assistant_proposals')} WHERE id=? AND user_id=?`, [previous.id, userId]);
    if (pending(row?.state)) conflict();
  }
  await updateTaskData(tx, task, userId, { ...task.data, proposal: proposalLink(proposal, binding.step) }, new Date(at).toISOString());
}

export async function assertAdvisorProposalPending(tx, turn, proposal, { draft = false } = {}) {
  const binding = turn.data.advisorTask;
  if (!binding) return null;
  if (proposal.user_id !== turn.user_id || proposal.turn_id !== turn.id || !pending(proposal.state)) conflict();
  const task = await getAdvisorTurnTask(tx, turn.user_id, binding.id);
  assertCandidate(task, binding, proposal.data, { draft });
  const expected = proposalLink(proposal, binding.step), linked = task.data.proposal;
  if (!linked || Object.keys(expected).some(key => linked[key] !== expected[key])) conflict();
  return task;
}

export async function assertAdvisorProposalCanExecute(tx, turn, proposal) {
  if (!await assertAdvisorProposalPending(tx, turn, proposal)) return;
  const { target, entityId } = proposal.data;
  const scope = target === CREATE ? 'shipment:create' : target === LINK ? 'shipment:link' : `shipment:event:${entityId}`;
  // Ali's own committed replay has already returned. A pre-existing native request
  // under this key must not be mistaken for a commercial commit by this proposal.
  if (await tx.db.get(`SELECT request_id FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, proposal.id])) conflict();
}

export async function recordAdvisorExecutionProof(tx, turn, proposal, receipt, result) {
  const task = await assertAdvisorProposalPending(tx, turn, proposal);
  if (!task) return;
  const shipment = task.data.shipment;
  if (!versioned(receipt.entityId, receipt.recordVersion) || receipt.entityId !== result?.id
    || receipt.recordVersion !== result.version || result.orderId !== shipment.orderId
    || (receipt.target !== CREATE && (receipt.entityId !== proposal.data.entityId || receipt.recordVersion <= proposal.data.recordVersion))) conflict();
  const { proposalId, target, entityId, recordVersion, committedAt } = receipt;
  const taskData = { ...task.data, proof: { proposalId, target, entityId, recordVersion, committedAt } };
  delete taskData.proposal;
  await updateTaskData(tx, task, turn.user_id, taskData, committedAt);
}
