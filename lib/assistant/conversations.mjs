import { fail } from '../validation-core.mjs';
import { assertAssistantSession } from './settings.mjs';
import { validateAssistantQuestion, validateTurnResult } from './contracts.mjs';
import { publicAssistantWorkMemory, reconcileAssistantWorkMemory } from './memory.mjs';
import { assistantProposalDTO } from './actions.mjs';
import { getAssistantTurnStatus } from './engine.mjs';
import {
  listAssistantThreads as listThreadsTx, getAssistantThread as getThreadTx,
  deleteAssistantThread as deleteThreadTx, setAssistantThreadArchived as setThreadArchivedTx,
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
    visitedPhases: data.visitedPhases ?? [],
    result, startedAt: turn.started_at, finishedAt: turn.finished_at,
  };
}

const threadTitle = (title, message) => title || (typeof message === 'string' ? message.slice(0, 100) : '');

// Memory/history remain available with Ali disabled, but never to a revoked session.
export async function listAssistantThreads(store, session, { page = 1, q = '', archived = false } = {}) {
  return store.readSnapshot(async tx => {
    await assertAssistantSession(tx, session);
    const result = await listThreadsTx(tx, { userId: session.user.id, page, q, archived });
    return {
      ...result,
      threads: result.threads.map(row => ({
        id: row.id, version: row.version, archived: row.data.archived === true,
        data: { title: threadTitle(row.data.title, row.fallback_title), topic: row.data.topic || null },
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
      id: thread.id, version: thread.version, archived: thread.data.archived === true,
      data: {
        title: threadTitle(thread.data.title, thread.pagination.hasMore ? null : thread.turns[0]?.data.message),
        topic: thread.data.topic || null,
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

export async function setAssistantThreadArchived(store, session, id, { version, archived }) {
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const result = await setThreadArchivedTx(tx, { userId: session.user.id, threadId: id, version, archived });
    await assertAssistantSession(tx, session);
    return result;
  });
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
