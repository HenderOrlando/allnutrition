import { randomUUID } from 'node:crypto';
import { schemas, settingsFields } from '../schema.mjs';
import { assistantFieldLabel } from './forms.mjs';
import { validateAssistantModelFinish, validateAssistantQuestion, validatePublicBlock } from './contracts.mjs';

const denied = () => { const error = new Error('ASSISTANT_SCOPE_DENIED'); error.code = 'ASSISTANT_SCOPE_DENIED'; throw error; };
const entries = value => value instanceof Map ? value : new Map((value || []).map(item => [item.id, item]));
const taskFrom = (guides, id) => { const task = guides.get(id); if (!task) denied(); return task; };
const evidenceFrom = (evidence, id) => { const item = evidence.get(id); if (!item) denied(); return item; };

function textBlock(block, { evidence, guides, message }) {
  const task = block.slots.taskId ? taskFrom(guides, block.slots.taskId) : null;
  const ref = block.slots.evidenceId ? evidenceFrom(evidence, block.slots.evidenceId) : null;
  const templates = {
    welcome: 'Soy Ali. Puedo ayudarte a revisar información y preparar el siguiente paso dentro del panel.',
    acknowledged: 'Entendido. Podemos continuar con esta tarea.',
    topic_changed: task ? `Ahora revisamos ${task.title}.` : '',
    missing_data: 'Falta información para continuar sin inventar datos. Completa lo pendiente o elige un registro.',
    choose_record: 'Hay varios registros posibles. Elige cuál quieres revisar.',
    next_step: task ? `Puedes continuar con ${task.title}. Revisa la información antes de guardar.` : '',
    scope_limit: 'Solo puedo ayudarte con los datos y las tareas de este panel. No consulto servicios externos ni realizo acciones fuera de la aplicación.',
  };
  let text = templates[block.templateId];
  if (!text) denied();
  if (ref) text += ` Referencia consultada: ${ref.label}.`;
  if (block.slots.quote) {
    const { start, end } = block.slots.quote;
    if (end > message.length) denied();
    text += ` Tu indicación: «${message.slice(start, end)}».`;
  }
  if (task && !['next_step', 'topic_changed'].includes(block.templateId)) text += ` Puedes abrir ${task.title}.`;
  return { type: 'text', text };
}

function resolveQuestion(selector, { evidence, guides }) {
  if (!selector) return { question: null, questionContext: null };
  const id = randomUUID();
  const bindings = [];
  let prompt, input = 'text', options = [];
  if (selector.kind === 'missing_field') {
    const kind = selector.target.startsWith('record:') ? selector.target.slice('record:'.length) : null;
    const field = (kind ? schemas[kind]?.fields : selector.target === 'storefront-settings' ? settingsFields : [])?.find(item => item.name === selector.field);
    prompt = `¿Qué valor quieres usar para ${assistantFieldLabel(selector.target, selector.field)}?`;
    if (field?.type === 'date' || /(?:On|Date)$/.test(selector.field)) input = 'date';
    else if (field && ['number', 'optionalNumber'].includes(field.type)) input = 'number';
    if (Array.isArray(field?.options) && field.options.length >= 2 && field.options.length <= 4) {
      options = field.options.map(option => {
        const optionId = randomUUID();
        bindings.push({ id: optionId, value: option.value });
        return { id: optionId, label: option.label };
      });
    }
  } else if (selector.kind === 'choose_goal') {
    prompt = '¿Qué quieres hacer ahora?';
    options = selector.taskIds.map(taskId => {
      const task = taskFrom(guides, taskId), optionId = randomUUID();
      bindings.push({ id: optionId, taskId });
      return { id: optionId, label: task.title };
    });
  } else {
    prompt = '¿Con cuál de estos registros quieres continuar?';
    const seen = new Set();
    options = selector.candidateEvidenceIds.map(evidenceId => {
      const item = evidenceFrom(evidence, evidenceId);
      if (!item.entityId) denied();
      const key = `${item.domain}\0${item.entityId}`;
      if (seen.has(key)) denied();
      seen.add(key);
      const optionId = randomUUID();
      const label = typeof item.value === 'string' && ['title', 'name', 'tracking', 'number', 'orderNumber'].includes(item.field)
        ? item.value : `${item.label} · ${item.entityId}`;
      bindings.push({ id: optionId, entityRef: { domain: item.domain, entityId: item.entityId, recordVersion: item.recordVersion } });
      return { id: optionId, label: label.slice(0, 300) };
    });
  }
  return {
    question: validateAssistantQuestion({ id, prompt, input, options, allowText: true }),
    questionContext: { kind: selector.kind, ...(selector.target ? { target: selector.target, field: selector.field } : {}), options: bindings },
  };
}

export function resolveAssistantModelResult(payload, { evidence: evidenceValue, recommendations: recommendationValue, guides: guideValue, message = '' } = {}) {
  let final;
  try{final=validateAssistantModelFinish(payload);}catch{denied();}
  const evidence = entries(evidenceValue), recommendations = entries(recommendationValue), guides = entries(guideValue);
  const referencedEvidenceIds = new Set();
  const blocks = final.blocks.map(block => {
    if (block.type === 'text') {
      if (block.slots.evidenceId) referencedEvidenceIds.add(block.slots.evidenceId);
      return validatePublicBlock(textBlock(block, { evidence, guides, message }));
    }
    if (block.type === 'fact') {
      if (!block.evidenceIds.length) denied();
      const refs = block.evidenceIds.map(id => evidenceFrom(evidence, id));
      block.evidenceIds.forEach(id => referencedEvidenceIds.add(id));
      return validatePublicBlock({ type: 'fact', title: refs.length === 1 ? refs[0].label : 'Información consultada', evidenceIds: block.evidenceIds });
    }
    if (block.type === 'guide') {
      const task = taskFrom(guides, block.taskId);
      const available = new Map((task.steps || []).map(step => [step.id, step]));
      const ids = block.stepIds.length ? block.stepIds : [...available.keys()];
      if (!ids.length || new Set(ids).size !== ids.length) denied();
      const steps = ids.map(id => { const step = available.get(id); if (!step) denied(); return { id: step.id, text: step.text }; });
      return validatePublicBlock({ type: 'guide', taskId: block.taskId, title: task.title, steps, href: task.href });
    }
    const item = recommendations.get(block.recommendationId);
    if (!item || !item.href || !item.actionLabel) denied();
    const ids = Array.isArray(item.evidenceIds) ? item.evidenceIds
      : [...evidence.values()].filter(ref => ref.domain === 'recommendations' && ref.entityId === item.id).map(ref => ref.id);
    if (!ids.length) denied();
    ids.forEach(id => { evidenceFrom(evidence, id); referencedEvidenceIds.add(id); });
    return validatePublicBlock({ type: 'recommendation', id: item.id, title: item.title, reason: item.reason, actionLabel: item.actionLabel, href: item.href, evidenceIds: ids });
  });
  if (final.question?.kind === 'choose_entity') final.question.candidateEvidenceIds.forEach(id => referencedEvidenceIds.add(id));
  const question = resolveQuestion(final.question, { evidence, guides });
  return { topic: final.topic, blocks, ...question, proposalId: final.proposalId, referencedEvidenceIds: [...referencedEvidenceIds] };
}
