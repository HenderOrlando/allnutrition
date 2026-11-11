import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssistantQuestion } from '../lib/assistant/contracts.mjs';
import { updateAssistantWorkMemory, normalizeAssistantWorkMemory, reconcileAssistantWorkMemory, normalizeAssistantPendingQuestion } from '../lib/assistant/memory.mjs';
import { ASSISTANT_PERSISTENCE_LIMITS } from '../lib/assistant/repository.mjs';
import { fileURLToPath } from 'node:url';

export async function runAssistantMemoryContracts(t) {
await t.test('long Unicode history leaves room for the pending question instead of rejecting the next turn', () => {
  const pendingQuestion = validateAssistantQuestion({
    id: 'next-priority', prompt: '界'.repeat(1000), input: 'text', allowText: true,
    options: Array.from({ length: 4 }, (_, index) => ({ id: `option-${index}`, label: '界'.repeat(300) })),
  });
  const previous = {
    goal: 'Priorizar tareas del negocio',
    confirmedInputs: Array.from({ length: 12 }, (_, index) => ({
      questionId: `question-${index}`, prompt: '界'.repeat(200), value: '界'.repeat(500),
      turnId: `turn-${index}`, confirmedAt: '2026-11-10T12:00:00.000Z',
    })),
    entityRefs: Array.from({ length: 20 }, (_, index) => ({
      domain: 'catalog', entityId: `product-${index}`, recordVersion: 1, field: 'title', turnId: `turn-${index}`,
    })),
  };
  const workMemory = updateAssistantWorkMemory(previous, {
    message: 'Continuar', pendingQuestion, result: { question: pendingQuestion, blocks: [], evidence: [] },
    turnId: 'turn-current', at: Date.parse('2026-11-10T13:00:00.000Z'),
  });
  const persisted = { title: 'Priorizar tareas del negocio', topic: 'catalog', pageContext: { section: 'products' }, workMemory, pendingQuestion };
  assert.ok(Buffer.byteLength(JSON.stringify(persisted), 'utf8') <= ASSISTANT_PERSISTENCE_LIMITS.memoryBytes);
  assert.equal(workMemory.goal, previous.goal);
  assert.ok(workMemory.followUps.some(item => item.id === 'question:next-priority' && item.state === 'pending'));
});
await t.test('Unicode limits do not split surrogate pairs or exceed UTF-8 durable memory bounds', () => {
  const memory = normalizeAssistantWorkMemory({
    goal: `a${'🙂'.repeat(1000)}`,
    confirmedInputs: Array.from({ length: 100 }, (_, index) => ({ questionId: `q${index}`, turnId: `t${index}`, prompt: '界'.repeat(1000), value: '🙂'.repeat(1000) })),
    entityRefs: [], pendingProposalIds: [], completedReceiptIds: [],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(memory), 'utf8') <= ASSISTANT_PERSISTENCE_LIMITS.memoryBytes - 1536);
  assert.equal(memory.goal.isWellFormed(), true);
  for (const item of memory.confirmedInputs) assert.equal(item.value.isWellFormed(), true);
});
await t.test('answers are confirmed only against the same pending question and a real option', () => {
  const questionBefore = { id: 'q', prompt: '¿Qué producto?', input: 'text', options: [{ id: 'p1', label: 'Producto real' }], allowText: true };
  const changed = updateAssistantWorkMemory({}, { questionBefore, answer: { questionId: 'foreign', optionId: 'p1' }, turnId: 't' });
  assert.deepEqual(changed.confirmedInputs, []);
  const unknown = updateAssistantWorkMemory({}, { questionBefore, answer: { questionId: 'q', optionId: 'missing', text: 'no usar' }, turnId: 't' });
  assert.deepEqual(unknown.confirmedInputs, []);
  const answered = updateAssistantWorkMemory({}, { questionBefore, answer: { questionId: 'q', optionId: 'p1' }, turnId: 't' });
  assert.equal(answered.confirmedInputs[0].value, 'Producto real');
  assert.throws(() => normalizeAssistantPendingQuestion({ ...questionBefore, options: [{ id: 'p1', label: 'Producto', url: 'https://outside.test' }] }));
});
await t.test('only persisted execution receipts survive reconciliation; stale proposals are not pending work', () => {
  const receipt = { id: 'real', proposalId: 'real', operation: 'save', target: 'record:products', entityId: 'p1', recordVersion: 2, committedAt: '2026-11-10T12:00:00.000Z', summary: 'Producto guardado.', href: '/admin?section=products' };
  const proposals = [
    { id: 'real', state: 'executed', data: { executionResponse: { result: { id: 'p1' }, receipt } } },
    { id: 'fake', state: 'prepared', data: {} },
    { id: 'stale', state: 'stale', data: {} },
  ];
  const memory = reconcileAssistantWorkMemory({ completedReceiptIds: ['forged'], pendingProposalIds: ['stale'] }, proposals);
  assert.deepEqual(memory.completedReceiptIds, ['real']);
  assert.deepEqual(memory.pendingProposalIds, ['fake']);
  const forged = updateAssistantWorkMemory({}, { result: { receipt: { ...receipt, id: 'fake', proposalId: 'fake' } }, proposals, turnId: 't' });
  assert.deepEqual(forged.completedReceiptIds, ['real']);
  assert.equal(forged.followUps.some(item => item.id === 'receipt:fake'), false);
});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('assistant durable memory contracts', runAssistantMemoryContracts);
}
