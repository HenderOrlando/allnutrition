import { Buffer } from 'node:buffer';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { ASSISTANT_PERSISTENCE_LIMITS } from './repository.mjs';
import { validateAssistantFollowUp, validateAssistantQuestion, validateAssistantReceipt } from './contracts.mjs';

const MAX_CONFIRMED_INPUTS = 4;
const MAX_ENTITY_REFS = 6;
const MAX_PENDING_ITEMS = 4;
const MAX_FOLLOW_UPS = 3;
const THREAD_DATA_RESERVE_BYTES = 1536;
const cleanText = (value, limit) => {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
};
function fitAssistantWorkMemory(memory, reservedBytes = THREAD_DATA_RESERVE_BYTES) {
  const byteLimit = Math.max(0, ASSISTANT_PERSISTENCE_LIMITS.memoryBytes - reservedBytes);
  const tooLarge = () => Buffer.byteLength(JSON.stringify(memory), 'utf8') > byteLimit;
  while (tooLarge()) {
    if (memory.entityRefs.length) memory.entityRefs.shift();
    else if (memory.confirmedInputs.length > 1) memory.confirmedInputs.shift();
    else if (memory.followUps.length > 1) memory.followUps.pop();
    else if (memory.pendingProposalIds.length) memory.pendingProposalIds.shift();
    else if (memory.completedReceiptIds.length) memory.completedReceiptIds.shift();
    else if (memory.goal.length > 120) memory.goal = cleanText(memory.goal, 120);
    else if (memory.confirmedInputs.length) memory.confirmedInputs.shift();
    else if (memory.followUps.length) memory.followUps.pop();
    else if (memory.goal.length) memory.goal = '';
    else return { goal: '', confirmedInputs: [], entityRefs: [], pendingProposalIds: [], completedReceiptIds: [], followUps: [] };
  }
  return memory;
}

export function normalizeAssistantWorkMemory(value, { reservedBytes = THREAD_DATA_RESERVE_BYTES } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const confirmedInputs = (Array.isArray(source.confirmedInputs) ? source.confirmedInputs : []).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.questionId !== 'string' || typeof item.turnId !== 'string') return [];
    return [{
      questionId: cleanText(item.questionId, 80),
      prompt: cleanText(item.prompt, 200),
      value: cleanText(item.value, 500),
      turnId: cleanText(item.turnId, 80),
      confirmedAt: cleanText(item.confirmedAt, 40),
    }];
  }).slice(-MAX_CONFIRMED_INPUTS);
  const entityRefs = (Array.isArray(source.entityRefs) ? source.entityRefs : []).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.domain !== 'string' || typeof item.entityId !== 'string') return [];
    return [{
      domain: cleanText(item.domain, 40), entityId: cleanText(item.entityId, 100),
      recordVersion: Number.isSafeInteger(item.recordVersion) && item.recordVersion >= 0 ? item.recordVersion : null,
      field: cleanText(item.field, 60), turnId: cleanText(item.turnId, 80),
    }];
  }).slice(-MAX_ENTITY_REFS);
  const followUps = [];
  for (const item of Array.isArray(source.followUps) ? source.followUps : []) {
    try { followUps.push(validateAssistantFollowUp(item)); } catch {}
  }
  return fitAssistantWorkMemory({
    goal: cleanText(source.goal, 500),
    confirmedInputs,
    entityRefs,
    pendingProposalIds: [...new Set((Array.isArray(source.pendingProposalIds) ? source.pendingProposalIds : []).filter(item => typeof item === 'string').map(item => cleanText(item, 120)))].slice(-MAX_PENDING_ITEMS),
    completedReceiptIds: [...new Set((Array.isArray(source.completedReceiptIds) ? source.completedReceiptIds : []).filter(item => typeof item === 'string').map(item => cleanText(item, 120)))].slice(-MAX_PENDING_ITEMS),
    followUps: followUps.slice(0, MAX_FOLLOW_UPS),
  }, reservedBytes);
}
export function reconcileAssistantWorkMemory(value, proposals = []) {
  const memory = normalizeAssistantWorkMemory(value);
  const active = proposals.filter(item => ['prepared', 'applied'].includes(item.state));
  const activeIds = new Set(active.map(item => item.id));
  const receipts = proposals.flatMap(item => {
    if (item.state !== 'executed') return [];
    try {
      const receipt = validateAssistantReceipt(item.data?.executionResponse?.receipt);
      return receipt && receipt.id === item.id && receipt.proposalId === item.id ? [receipt.id] : [];
    } catch { return []; }
  });
  memory.pendingProposalIds = active.map(item => item.id).slice(-MAX_PENDING_ITEMS);
  memory.completedReceiptIds = [...new Set(receipts)].slice(-MAX_PENDING_ITEMS);
  const receiptIds = new Set(receipts);
  memory.followUps = memory.followUps.filter(item =>
    (item.kind !== 'proposal' || activeIds.has(item.id.slice('proposal:'.length))) &&
    (item.kind !== 'receipt' || receiptIds.has(item.id.slice('receipt:'.length))));
  return normalizeAssistantWorkMemory(memory);
}

export function normalizeAssistantPendingQuestion(value) {
  if (value == null) return null;
  return validateAssistantQuestion(value);
}

function followUp(value) {
  try { return validateAssistantFollowUp(value); } catch { return null; }
}

function proposalHref(proposal) {
  try { return adminHref(readAdminView(proposal.data?.open?.view || {})); } catch { return null; }
}

export function updateAssistantWorkMemory(previous, {
  message, answer = null, questionBefore = null, pendingQuestion = null,
  result, proposals = [], turnId, at = Date.now(),
} = {}) {
  const prior = reconcileAssistantWorkMemory(previous, proposals);
  pendingQuestion = normalizeAssistantPendingQuestion(pendingQuestion);
  const confirmedInputs = [...prior.confirmedInputs];
  if (answer && questionBefore && answer.questionId === questionBefore.id) {
    const value = answer.optionId
      ? questionBefore.options?.find(option => option.id === answer.optionId)?.label
      : answer.text;
    if (typeof value === 'string' && value.trim()) {
      const saved = {
        questionId: questionBefore.id,
        prompt: cleanText(questionBefore.prompt, 200),
        value: cleanText(value, 500),
        turnId: cleanText(turnId, 80),
        confirmedAt: new Date(at).toISOString(),
      };
      const index = confirmedInputs.findIndex(item => item.questionId === saved.questionId);
      if (index >= 0) confirmedInputs.splice(index, 1);
      confirmedInputs.push(saved);
    }
  }

  const refs = new Map(prior.entityRefs.map(item => [`${item.domain}\0${item.entityId}`, item]));
  for (const item of result?.evidence || []) {
    if (!item.entityId) continue;
    const ref = {
      domain: cleanText(item.domain, 40), entityId: cleanText(item.entityId, 100), recordVersion: item.recordVersion,
      field: cleanText(item.field, 60), turnId: cleanText(turnId, 80),
    };
    refs.delete(`${ref.domain}\0${ref.entityId}`);
    refs.set(`${ref.domain}\0${ref.entityId}`, ref);
  }

  const activeProposals = proposals.filter(item => ['prepared', 'applied'].includes(item.state));
  const pendingProposalIds = activeProposals.map(item => item.id).slice(-MAX_PENDING_ITEMS);
  const completedReceiptIds = [...prior.completedReceiptIds];
  const realReceipt = result?.receipt && proposals.some(item => item.state === 'executed' && item.id === result.receipt.id && item.data?.executionResponse?.receipt?.id === result.receipt.id);
  if (realReceipt && !completedReceiptIds.includes(result.receipt.id)) completedReceiptIds.push(result.receipt.id);

  const questionTurn = pendingQuestion
    ? pendingQuestion.id === result?.question?.id
      ? turnId
      : prior.followUps.find(item => item.id === `question:${pendingQuestion.id}`)?.turnId || turnId
    : null;
  const followUps = [];
  const addFollowUp = item => {
    if (item && !followUps.some(existing => existing.id === item.id)) followUps.push(item);
  };
  if (pendingQuestion) addFollowUp(followUp({
    id: `question:${pendingQuestion.id}`, kind: 'question', title: 'Responder pregunta',
    description: cleanText(pendingQuestion.prompt, 200), href: null, turnId: questionTurn, state: 'pending',
  }));
  for (const block of result?.blocks || []) {
    if (block.type === 'recommendation') addFollowUp(followUp({
      id: `action:${block.id}`, kind: 'action', title: cleanText(block.actionLabel,150),
      description: cleanText(block.title,200), href: block.href, turnId, state: 'suggested',
    }));
    else if (block.type === 'guide') addFollowUp(followUp({
      id: `task:${block.taskId}`, kind: 'task', title: cleanText(block.title,150),
      description: cleanText(block.steps[0]?.text || 'Continuar esta tarea.',200), href: block.href, turnId, state: 'suggested',
    }));
  }
  if (realReceipt) addFollowUp(followUp({
    id: `receipt:${result.receipt.id}`, kind: 'receipt', title: 'Revisar cambio guardado',
    description: cleanText(result.receipt.summary,200), href: result.receipt.href, turnId, state: 'suggested',
  }));
  for (const proposal of activeProposals.slice(-2).reverse()) {
    const href = proposalHref(proposal);
    if (!href) continue;
    const fields = (proposal.data?.diff || []).map(item => cleanText(item.label,80)).filter(Boolean).slice(0, 3);
    addFollowUp(followUp({
      id: `proposal:${proposal.id}`, kind: 'proposal', title: 'Revisar propuesta',
      description: cleanText(fields.length ? `Campos: ${fields.join(', ')}` : `Destino: ${proposal.data?.target || 'formulario'}`,200),
      href, turnId: proposal.turn_id, state: 'pending',
    }));
  }
  for (const item of prior.followUps) {
    if (['action','task'].includes(item.kind) && item.state === 'suggested') addFollowUp(item);
  }
  const reservedBytes = THREAD_DATA_RESERVE_BYTES + (pendingQuestion ? Buffer.byteLength(JSON.stringify(pendingQuestion), 'utf8') : 0);
  return normalizeAssistantWorkMemory({
    goal: prior.goal || cleanText(message, 500),
    confirmedInputs: confirmedInputs.slice(-MAX_CONFIRMED_INPUTS),
    entityRefs: [...refs.values()].slice(-MAX_ENTITY_REFS),
    pendingProposalIds,
    completedReceiptIds: [...new Set(completedReceiptIds)].slice(-MAX_PENDING_ITEMS),
    followUps: followUps.filter(Boolean).slice(0, MAX_FOLLOW_UPS),
  }, { reservedBytes });
}

export function publicAssistantWorkMemory(value) {
  const memory = normalizeAssistantWorkMemory(value);
  return { goal: memory.goal, confirmedInputs: memory.confirmedInputs, followUps: memory.followUps };
}
