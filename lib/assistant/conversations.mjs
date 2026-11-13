import { fail } from '../validation-core.mjs';
import { assertAssistantSession } from './settings.mjs';
import { validateAssistantQuestion, validateTurnResult } from './contracts.mjs';
import { publicAssistantWorkMemory, reconcileAssistantWorkMemory } from './memory.mjs';
import { assistantProposalDTO } from './actions.mjs';
import { getAssistantTurnStatus } from './engine.mjs';
import {
  listAssistantThreads as listThreadsTx, getAssistantThread as getThreadTx,
  deleteAssistantThread as deleteThreadTx,
} from './repository.mjs';


function publicTurn(turn, proposals) {
  const data = turn.data;
  let result = data.publicResult ? validateTurnResult(data.publicResult) : null;
  if (result?.proposal) {
    const proposal = proposals.get(result.proposal.id);
    result = validateTurnResult({ ...result, proposal: proposal ? assistantProposalDTO(proposal) : null });
  }
  return {
    id: turn.id, state: turn.state, message: typeof data.message === 'string' ? data.message.slice(0, 8000) : null,
    result, startedAt: turn.started_at, finishedAt: turn.finished_at,
  };
}

// Memory/history remain available with Ali disabled, but never to a revoked session.
export async function listAssistantThreads(store, session, { page = 1 } = {}) {
  return store.readSnapshot(async tx => {
    await assertAssistantSession(tx, session);
    const result = await listThreadsTx(tx, { userId: session.user.id, page });
    return {
      ...result,
      threads: result.threads.map(row => ({
        id: row.id, version: row.version,
        data: { title: row.data.title || '', topic: row.data.topic || null },
        createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  });
}

export async function getAssistantThread(store, session, id, { before = null } = {}) {
  const result = await store.readSnapshot(async tx => {
    await assertAssistantSession(tx, session);
    const thread = await getThreadTx(tx, { userId: session.user.id, threadId: id, before });
    const proposals = new Map(thread.proposals.map(row => [row.id, row]));
    return {
      id: thread.id, version: thread.version,
      data: {
        title: thread.data.title || '', topic: thread.data.topic || null,
        workMemory: publicAssistantWorkMemory(reconcileAssistantWorkMemory(thread.data.workMemory, thread.proposals)),
        pendingQuestion: thread.data.pendingQuestion ? validateAssistantQuestion(thread.data.pendingQuestion) : null,
      },
      createdAt: thread.created_at, updatedAt: thread.updated_at,
      turns: thread.turns.map(turn => publicTurn(turn, proposals)), pagination: thread.pagination,
    };
  });
  // Resolve durable status outside the history snapshot: status may expire a turn.
  const active = result.turns.filter(turn => turn.state === 'running');
  for (const turn of active) {
    const status = await getAssistantTurnStatus(store, session, turn.id);
    turn.state = status.state;
    turn.status = status;
    result.version = status.threadVersion;
    turn.result = status.result;
  }
  return result;
}

export async function deleteAssistantThread(store, session, id, version) {
  if (!Number.isSafeInteger(version) || version < 1) fail('Versión de conversación inválida.');
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const result = await deleteThreadTx(tx, { userId: session.user.id, threadId: id, version });
    await assertAssistantSession(tx, session);
    return result;
  });
}
