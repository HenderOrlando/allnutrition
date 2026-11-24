import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin, login, logout } from '../lib/auth.mjs';
import {
  finishAssistantTurn, getAssistantProposal, hashAssistantInput, hashAssistantProposalPayload,
  reserveAssistantTurn, saveAssistantProposal, transitionAssistantProposal,
  createAssistantThread, getAssistantThread, listAssistantThreads, cancelAssistantTurn,
  invalidateAssistantConfiguration, recordAssistantExecution, recoverAssistantExecution,
} from '../lib/assistant/repository.mjs';
import * as conversations from '../lib/assistant/conversations.mjs';
import { assertAssistantSession } from '../lib/assistant/settings.mjs';
import { validateTurnResult } from '../lib/assistant/contracts.mjs';

const password = 'assistant-persistence-only-2026';
const sessionHash = token => createHash('sha256').update(token).digest('hex');
async function authenticate(store, email) {
  await createAdmin(store, email, password);
  const authenticated = await login(store, email, password);
  const user = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
  return { userId: user.id, token: authenticated.token, sessionTokenHash: sessionHash(authenticated.token), session: { user, csrf: authenticated.csrf, sessionTokenHash: sessionHash(authenticated.token) } };
}
async function fixture(t, factory) {
  const store = await factory();
  t.after(() => store.close());
  return { store, ...await authenticate(store, 'assistant-persistence@example.test') };
}
const locked = (store, fn) => store.transaction(async tx => { await tx.lockWrites(); return fn(tx); });
function turnResult(reservation, proposal = null) {
  return {
    threadId: reservation.threadId, threadVersion: reservation.threadVersion, turnId: reservation.turn.id,
    configurationVersion: 0, topic: 'catalog', blocks: [{ type: 'text', text: 'Revisemos el producto.' }],
    evidence: [], question: null, proposal, receipt: null, followUps: [],
  };
}
async function reserve(store, auth, changes = {}) {
  const requestId = changes.requestId || randomUUID();
  return locked(store, tx => reserveAssistantTurn(tx, {
    userId: auth.userId, sessionTokenHash: auth.sessionTokenHash, requestId,
    inputHash: hashAssistantInput({ requestId }), configurationVersion: 0,
    data: { message: 'Mensaje persistido' }, ...changes,
  }));
}
async function reserveWithProposal(store, auth, changes = {}) {
  const reservation = await reserve(store, auth, changes);
  const proposal = await locked(store, tx => saveAssistantProposal(tx, {
    userId: auth.userId, threadId: reservation.threadId, turnId: reservation.turn.id, configurationVersion: 0,
    data: {
      configurationVersion: 0, target: 'record:products', entityId: null, recordVersion: null,
      formId: null, generation: null, execution: 'confirm', patch: { title: 'Producto revisado' },
      open: { owner: 'admin', view: { section: 'products' }, target: 'record:products', entityId: null, refs: {} },
      missingFields: [], diff: [{ field: 'title', label: 'Nombre', before: null, after: 'Producto revisado' }],
      moneyCurrency:{before:'COP',after:'COP'},
    },
  }));
  return { reservation, proposal };
}
function proposalDTO(proposal) {
  return { ...proposal.data, id: proposal.id, version: proposal.version, state: proposal.state };
}

export async function runAssistantPersistenceContracts(t, factory, { openPeer = null } = {}) {
  await t.test('failed, cancelled and expired turns invalidate all their pending proposals', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    for (const state of ['failed', 'cancelled']) {
      const { reservation, proposal } = await reserveWithProposal(store, auth);
      await locked(store, tx => state === 'cancelled'
        ? cancelAssistantTurn(tx, { userId, turnId: reservation.turn.id })
        : finishAssistantTurn(tx, { userId, turnId: reservation.turn.id, state, data: { errorCode: 'ASSISTANT_UNAVAILABLE' } }));
      assert.equal((await getAssistantProposal(store, { userId, proposalId: proposal.id })).state, 'cancelled');
    }
    for (const sameRequest of [true, false]) {
      const now = Date.now(), requestId = randomUUID();
      const { reservation, proposal } = await reserveWithProposal(store, auth, { requestId, at: now, deadlineAt: now + 1000 });
      await reserve(store, auth, { requestId: sameRequest ? requestId : randomUUID(), threadId: reservation.threadId, threadVersion: reservation.threadVersion, at: now + 2000 });
      assert.equal((await getAssistantProposal(store, { userId, proposalId: proposal.id })).state, 'cancelled');
    }
    const now = Date.now();
    const late = await reserveWithProposal(store, auth, { at: now, deadlineAt: now + 1000 });
    const expired = await locked(store, tx => finishAssistantTurn(tx, {
      userId, turnId: late.reservation.turn.id, data: { publicResult: turnResult(late.reservation) }, at: now + 2000,
    }));
    assert.equal(expired.state, 'failed');
    const cancelled = await getAssistantProposal(store, { userId, proposalId: late.proposal.id });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.version, 2);
  });
  await t.test('review compare-and-swap and payload hash bind the entire commercial effect', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const { proposal } = await reserveWithProposal(store, auth);
    const data = { ...proposal.data, patch: { title: 'Título corregido' }, payload: { title: 'Título corregido', price: 100 } };
    data.payloadHash = hashAssistantProposalPayload(data);
    const revised = await locked(store, tx => transitionAssistantProposal(tx, { userId, proposalId: proposal.id, version: proposal.version, state: 'prepared', data }));
    assert.equal(revised.version, 2);
    assert.equal(revised.state, 'prepared');
    assert.equal(revised.data.patch.title, 'Título corregido');
    await assert.rejects(() => locked(store, tx => transitionAssistantProposal(tx, { userId, proposalId: proposal.id, version: 1, state: 'prepared', data })), error => error.status === 409);
    for (const change of [{ payload: { ...data.payload, price: 101 } }, { submission: { title: 'Cambio humano' } }, { humanAcknowledgements: { confirmed: true } }, { preview: { hash: 'changed' } }, { references: [{ id: 'changed' }] }, { moneyCurrency:{before:'COP',after:'USD'} }, { reviewBase:{title:'Otro valor mostrado'} }, { operation: 'remove' }]) {
      assert.notEqual(hashAssistantProposalPayload({ ...data, ...change }), data.payloadHash);
    }
  });
  await t.test('requests are private per user, survive a new owner session and reject different inputs', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const requestId = randomUUID(), first = await reserve(store, auth, { requestId });
    const result = turnResult(first);
    result.evidence = [{
      id: 'persisted-price', domain: 'catalog', entityId: 'product-1', recordVersion: 3,
      field: 'price', label: 'Precio registrado', value: 25000, unit: 'COP', formattedValue: '$25.000',
      asOf: '2026-11-10T12:00:00.000Z', asOfPrecision: 'instant',
      coverage: { state: 'complete', knownCount: 1, eligibleCount: 1, excludedCount: 0, reasons: [] },
      href: '/admin?section=products',
    }];
    result.blocks = [{ type: 'fact', title: 'Precio registrado', evidenceIds: ['persisted-price'] }];
    await locked(store, tx => finishAssistantTurn(tx, { userId, turnId: first.turn.id, data: { publicResult: result } }));
    const nextLogin = await login(store, 'assistant-persistence@example.test', password);
    const duplicate = await reserve(store, { ...auth, sessionTokenHash: sessionHash(nextLogin.token) }, { requestId });
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.turn.data.publicResult, result);
    assert.equal(duplicate.turn.data.message, 'Mensaje persistido');
    const reopened = await conversations.getAssistantThread(store, auth.session, first.threadId);
    assert.deepEqual(reopened.turns[0].result.evidence, result.evidence);
    assert.deepEqual(reopened.turns[0].result.blocks, result.blocks);
    await assert.rejects(() => reserve(store, auth, { requestId, inputHash: hashAssistantInput({ different: true }) }), error => error.status === 409);
    const other = await authenticate(store, 'assistant-other@example.test');
    const independent = await reserve(store, other, { requestId });
    assert.notEqual(independent.threadId, first.threadId);
    await assert.rejects(() => conversations.getAssistantThread(store, other.session, first.threadId), error => error.status === 404);
    await assert.rejects(() => conversations.deleteAssistantThread(store, other.session, first.threadId, first.threadVersion), error => error.status === 404);
    await assert.rejects(() => recoverAssistantExecution(store, { userId: other.userId, proposalId: 'not-owned', executionDigest: 'a'.repeat(64) }), error => error.status === 404);
    await assert.rejects(() => listAssistantThreads(store), error => error.status === 401);
  });
  await t.test('pagination visits all 85 turns with equal timestamps and all 22 threads without exposing internals', async t => {
    const auth = await fixture(t, factory), { store, userId, session } = auth;
    const created = await locked(store, tx => createAssistantThread(tx, { userId }));
    let version = created.version;
    const ids = new Set();
    const at = Date.now();
    for (let index = 0; index < 85; index++) {
      const current = await reserve(store, auth, { threadId: created.id, threadVersion: version, at });
      version = current.threadVersion;
      ids.add(current.turn.id);
      await locked(store, tx => finishAssistantTurn(tx, { userId, turnId: current.turn.id, data: { publicResult: turnResult(current) } }));
    }
    const visited = new Set();
    let before = null;
    do {
      const page = await conversations.getAssistantThread(store, session, created.id, { before });
      assert.ok(page.turns.length <= 40);
      for (const turn of page.turns) { assert.ok(!visited.has(turn.id)); visited.add(turn.id); }
      assert.equal(JSON.stringify(page).includes(auth.sessionTokenHash), false);
      before = page.pagination.before;
      assert.equal(Boolean(before), page.pagination.hasMore);
    } while (before);
    assert.deepEqual(visited, ids);
    for (let index = 0; index < 21; index++) await locked(store, tx => createAssistantThread(tx, { userId }));
    const first = await conversations.listAssistantThreads(store, session), second = await conversations.listAssistantThreads(store, session, { page: 2 });
    assert.equal(first.threads.length, 20); assert.equal(first.hasMore, true);
    assert.equal(second.threads.length, 2); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.threads, ...second.threads].map(row => row.id)).size, 22);
    const other = await authenticate(store, 'assistant-pagination-other@example.test');
    const otherTurn = await reserve(store, other);
    await assert.rejects(() => getAssistantThread(store, { userId, threadId: created.id, before: otherTurn.turn.id }), error => error.status === 404);
  });
  await t.test('thread search matches owned titles and messages before paginating the archive view', async t => {
    const auth = await fixture(t, factory), { store, session, userId } = auth;
    const other = await authenticate(store, 'assistant-history-other@example.test');
    const list = options => conversations.listAssistantThreads(store, session, options);
    const ids = result => result.threads.map(thread => thread.id);
    const title = await locked(store, tx => createAssistantThread(tx, { userId, data: { title: 'Plan 50%_oferta', internal: 'secret-marker' } }));
    const at = Date.now();
    const firstMessage = `Revisar 50%_OFERTA ${'abc '.repeat(30)}`;
    const message = await reserve(store, auth, { data: { message: firstMessage }, at });
    await locked(store, tx => finishAssistantTurn(tx, { userId, turnId: message.turn.id, data: {} }));
    assert.equal((await conversations.getAssistantThread(store, session, message.threadId)).data.title, firstMessage.slice(0, 100));
    await reserve(store, auth, { threadId: message.threadId, threadVersion: message.threadVersion, data: { message: 'Otra 50%_oferta' }, at: at + 1 });
    const foreign = await reserve(store, other, { data: { message: '50%_oferta foreign-marker' } });
    assert.deepEqual(ids(await list({ q: 'foreign-marker' })), []);
    const archive = (id, version, archived = true, actor = session) =>
      conversations.setAssistantThreadArchived(store, actor, id, { version, archived });
    await archive(foreign.threadId, foreign.threadVersion, true, other.session);
    await locked(store, tx => createAssistantThread(tx, { userId, data: { title: '50XAoferta' } }));

    const active = await list({ q: '  50%_OFERTA  ' });
    assert.deepEqual(new Set(ids(active)), new Set([title.id, message.threadId]));
    assert.equal(active.threads.length, 2);
    assert.equal(active.threads.find(thread => thread.id === message.threadId).data.title, firstMessage.slice(0, 100));
    assert.deepEqual(ids(await list({ q: 'secret-marker' })), []);
    assert.deepEqual(ids(await list({ q: 'foreign-marker', archived: true })), []);
    assert.deepEqual(ids(await list({ q: '50%_oferta', archived: true })), []);

    const archivedAt = Date.now();
    const archived = await locked(store, async tx => {
      const threads = [];
      for (let index = 0; index < 22; index++) {
        threads.push(await createAssistantThread(tx, { userId, data: { title: index === 0 ? 'No coincide' : 'Filtro archivado' }, at: archivedAt + index }));
      }
      return threads;
    });
    for (const thread of archived) await archive(thread.id, thread.version);
    await locked(store, tx => createAssistantThread(tx, { userId, data: { title: 'Filtro archivado activo' } }));
    const first = await list({ q: 'filtro archivado', archived: true });
    const second = await list({ q: 'filtro archivado', archived: true, page: 2 });
    assert.equal(first.threads.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(second.threads.length, 1);
    assert.equal(second.hasMore, false);
    assert.ok([...first.threads, ...second.threads].every(thread => thread.archived === true));
    assert.deepEqual(new Set([...ids(first), ...ids(second)]), new Set(archived.slice(1).map(thread => thread.id)));
  });
  await t.test('thread search includes displayed Ali responses but not private fields, hidden IDs or links', async t => {
    const auth = await fixture(t, factory), { store, session, userId } = auth;
    const other = await authenticate(store, 'assistant-response-search-other@example.test');
    const reservation = await reserve(store, auth);
    const foreign = await reserve(store, other);
    const evidence = {
      id: 'evidence-id-marker', domain: 'catalog', entityId: 'entity-id-marker', recordVersion: 2,
      field: 'field-id-marker', label: 'Etiqueta pública exclusiva', value: 'raw-value-marker',
      unit: null, formattedValue: 'Valor visible exclusivo', asOf: null, asOfPrecision: 'unknown',
      coverage: { state: 'complete', knownCount: 1, eligibleCount: 1, excludedCount: 0, reasons: [] },
      href: '/admin?section=products',
    };
    const result = validateTurnResult({
      ...turnResult(reservation),
      evidence: [evidence, { ...evidence, id: 'extra-fact-id-marker', label: 'Total observado', value: 783215, formattedValue: null }],
      blocks: [
        { type: 'text', text: 'Respuesta pública exclusiva' },
        { type: 'analysis', kind: 'explanation', evidenceIds: [evidence.id], segments: [
          { type: 'text', text: 'Segmento de análisis exclusivo' },
          { type: 'evidence', evidenceId: evidence.id, display: 'label' },
        ] },
        { type: 'guide', taskId: 'guide-id-marker', title: 'Guía pública exclusiva', href: '/admin?section=products',
          steps: [{ id: 'step-id-marker', text: 'Paso visible exclusivo' }] },
        { type: 'recommendation', id: 'recommendation-id-marker', title: 'Sugerencia de Ali', reason: 'Motivo público exclusivo',
          actionLabel: 'Consultar registros', href: '/admin?section=products', evidenceIds: [evidence.id] },
      ],
    });
    await locked(store, async tx => {
      await finishAssistantTurn(tx, { userId, turnId: reservation.turn.id, data: {
        publicResult: result,
        providerTrace: 'provider-private-marker',
        preview: { blocks: [{ type: 'text', text: 'preview-private-marker' }] },
      } });
      await finishAssistantTurn(tx, { userId: other.userId, turnId: foreign.turn.id, data: {
        publicResult: { ...turnResult(foreign), blocks: [{ type: 'text', text: 'foreign-answer-marker' }] },
      } });
    });
    const ids = async (q, archived = false) =>
      (await conversations.listAssistantThreads(store, session, { q, archived })).threads.map(thread => thread.id);
    for (const query of ['RESPUESTA', 'segmento de análisis', 'paso visible', 'guía pública', 'motivo público', 'etiqueta pública', 'valor visible', '783215']) {
      assert.deepEqual(await ids(query), [reservation.threadId], query);
    }
    for (const query of ['provider-private-marker', 'preview-private-marker', 'foreign-answer-marker', 'raw-value-marker',
      'evidence-id-marker', 'entity-id-marker', 'field-id-marker', 'guide-id-marker', 'step-id-marker',
      'recommendation-id-marker', 'section=products']) {
      assert.deepEqual(await ids(query), [], query);
    }
    await conversations.setAssistantThreadArchived(store, session, reservation.threadId, { version: reservation.threadVersion, archived: true });
    assert.deepEqual(await ids('segmento de análisis'), []);
    assert.deepEqual(await ids('segmento de análisis', true), [reservation.threadId]);
  });
  await t.test('archiving and restoring a thread version-checks ownership and preserves running work and history', async t => {
    const auth = await fixture(t, factory), { store, session, userId } = auth;
    const other = await authenticate(store, 'assistant-archive-other@example.test');
    const created = await locked(store, tx => createAssistantThread(tx, { userId, data: { title: 'Archivo reversible', topic: 'catalog' } }));
    const { reservation, proposal } = await reserveWithProposal(store, auth, { threadId: created.id, threadVersion: created.version });
    const { threadId, threadVersion, turn } = reservation;
    const archive = (version, archived, actor = session) =>
      conversations.setAssistantThreadArchived(store, actor, threadId, { version, archived });

    await assert.rejects(() => archive(threadVersion, true, other.session), error => error.status === 404);
    await assert.rejects(() => archive(created.version, true), error => error.status === 409);
    await assert.rejects(() => archive(threadVersion, 'true'), error => error.status === 400);
    const result = await archive(threadVersion, true);
    assert.deepEqual(result, { id: threadId, version: threadVersion + 1, archived: true, updatedAt: result.updatedAt });
    assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
    await assert.rejects(() => archive(threadVersion, false), error => error.status === 409);
    const raw = await getAssistantThread(store, { userId, threadId });
    assert.equal(raw.turns[0].state, 'running');
    assert.equal(raw.proposals[0].state, 'prepared');
    assert.deepEqual((await conversations.listAssistantThreads(store, session)).threads, []);
    const listed = await conversations.listAssistantThreads(store, session, { archived: true, q: 'mensaje persistido' });
    assert.deepEqual(listed.threads.map(row => [row.id, row.version, row.archived]), [[threadId, result.version, true]]);

    await locked(store, tx => finishAssistantTurn(tx, { userId, turnId: turn.id, data: { publicResult: turnResult(reservation, proposalDTO(proposal)) } }));
    const archived = await conversations.getAssistantThread(store, session, threadId);
    assert.equal(archived.archived, true);
    assert.equal(archived.data.title, created.data.title);
    assert.equal(archived.turns[0].message, turn.data.message);
    assert.equal(archived.turns[0].result.proposal.id, proposal.id);
    const restored = await archive(archived.version, false);
    assert.equal(restored.version, archived.version + 1);
    assert.equal(restored.archived, false);
    const reopened = await conversations.getAssistantThread(store, session, threadId);
    assert.equal(reopened.archived, false);
    assert.deepEqual(reopened.turns, archived.turns);
    assert.deepEqual(reopened.data, archived.data);
    assert.deepEqual((await conversations.listAssistantThreads(store, session, { archived: true })).threads, []);
    assert.deepEqual((await conversations.listAssistantThreads(store, session, { q: 'reversible' })).threads.map(row => row.id), [threadId]);
  });
  await t.test('one simultaneous turn wins and deletion cancels pending work before cascading', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const thread = await locked(store, tx => createAssistantThread(tx, { userId }));
    const settled = await Promise.allSettled([reserve(store, auth, { threadId: thread.id, threadVersion: 1 }), reserve(store, auth, { threadId: thread.id, threadVersion: 1 })]);
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(settled.find(item => item.status === 'rejected').reason.status, 409);
    const winner = settled.find(item => item.status === 'fulfilled').value;
    await conversations.deleteAssistantThread(store, auth.session, thread.id, winner.threadVersion);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('assistant_turns')} WHERE thread_id=?`, [thread.id]), null);
    await assert.rejects(() => locked(store, tx => finishAssistantTurn(tx, { userId, turnId: winner.turn.id, data: { publicResult: turnResult(winner) } })), error => error.status === 404);
  });
  await t.test('database foreign keys cannot mix thread, turn or proposal owners', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const other = await authenticate(store, 'assistant-fk-other@example.test');
    const own = await reserve(store, auth), foreign = await reserve(store, other);
    const stamp = new Date().toISOString();
    await assert.rejects(() => store.db.run(`INSERT INTO ${store.t('assistant_turns')}(id,thread_id,user_id,request_id,input_hash,configuration_version,state,data,started_at,deadline_at) VALUES(?,?,?,?,?,0,'completed','{}',?,?)`, [randomUUID(), own.threadId, other.userId, randomUUID(), 'a'.repeat(64), stamp, stamp]));
    await assert.rejects(() => store.db.run(`INSERT INTO ${store.t('assistant_proposals')}(id,thread_id,turn_id,user_id,version,configuration_version,state,data,created_at,updated_at) VALUES(?,?,?,?,1,0,'prepared','{}',?,?)`, [randomUUID(), own.threadId, foreign.turn.id, userId, stamp, stamp]));
  });
  await t.test('receipt recovery remains exact after configuration invalidation; cancellation never invents receipts', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const { reservation, proposal } = await reserveWithProposal(store, auth);
    await locked(store, tx => finishAssistantTurn(tx, { userId, turnId: reservation.turn.id, data: { publicResult: turnResult(reservation, proposalDTO(proposal)) } }));
    const response = { result: { id: 'synthetic-saved-product', version: 2, title: 'Producto revisado' }, receipt: {
      id: proposal.id, proposalId: proposal.id, operation: 'save', target: 'record:products', entityId: 'synthetic-saved-product', recordVersion: 2,
      committedAt: new Date().toISOString(), summary: 'Producto guardado.', href: '/admin?section=products',
    } };
    const args = { userId, proposalId: proposal.id, version: 1, executionDigest: 'a'.repeat(64), executionRequestId: proposal.id, response, sessionTokenHash: auth.sessionTokenHash };
    await locked(store, tx => recordAssistantExecution(tx, args));
    await locked(store, tx => invalidateAssistantConfiguration(tx, { configurationVersion: 2 }));
    assert.deepEqual(await locked(store, tx => recordAssistantExecution(tx, args)), response);
    await assert.rejects(() => recoverAssistantExecution(store, { ...args, executionDigest: 'b'.repeat(64) }), error => error.status === 409);
    const thread = await conversations.getAssistantThread(store, auth.session, reservation.threadId);
    assert.deepEqual(thread.turns[0].result.receipt, response.receipt);
    const stored = await getAssistantThread(store, { userId, threadId: reservation.threadId });
    assert.deepEqual(stored.data.workMemory.completedReceiptIds, [proposal.id]);
    const pending = await reserveWithProposal(store, auth);
    await locked(store, tx => cancelAssistantTurn(tx, { userId, turnId: pending.reservation.turn.id }));
    await assert.rejects(() => locked(store, tx => recordAssistantExecution(tx, { ...args, proposalId: pending.proposal.id, executionRequestId: pending.proposal.id })), error => error.status === 409);
    assert.equal((await getAssistantProposal(store, { userId, proposalId: pending.proposal.id })).data.executionResponse, undefined);
  });
  await t.test('expired and revoked sessions cannot read, delete or reserve even with disabled configuration', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const reservation = await reserve(store, auth);
    await store.db.run(`UPDATE ${store.t('sessions')} SET expires=? WHERE token_hash=?`, [Date.now() - 1, auth.sessionTokenHash]);
    await assert.rejects(() => conversations.getAssistantThread(store, auth.session, reservation.threadId), error => error.status === 401);
    await assert.rejects(() => conversations.listAssistantThreads(store, auth.session), error => error.status === 401);
    await assert.rejects(() => conversations.deleteAssistantThread(store, auth.session, reservation.threadId, reservation.threadVersion), error => error.status === 401);
    await assert.rejects(() => conversations.setAssistantThreadArchived(store, auth.session, reservation.threadId, { version: reservation.threadVersion, archived: true }), error => error.status === 401);
    await assert.rejects(() => reserve(store, auth), error => error.status === 401);
    assert.equal((await getAssistantThread(store, { userId, threadId: reservation.threadId })).version, reservation.threadVersion);
  });
  await t.test('expiration at the final guard rolls back the entire pending write', async t => {
    const auth = await fixture(t, factory), { store, userId } = auth;
    const id = randomUUID();
    await assert.rejects(() => store.transaction(async tx => {
      await assertAssistantSession(tx, auth.session, { lock: true });
      await createAssistantThread(tx, { userId, id });
      await tx.db.run(`UPDATE ${tx.t('sessions')} SET expires=? WHERE token_hash=?`, [Date.now() - 1, auth.sessionTokenHash]);
      await assertAssistantSession(tx, auth.session);
    }), error => error.status === 401);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('assistant_threads')} WHERE id=?`, [id]), null);
    await conversations.listAssistantThreads(store, auth.session);
  });
  if (openPeer) await t.test('PostgreSQL revocation waits for the current owner guard and rejects every later write', async t => {
    // TRUNCATE has its own 120s SQL limit; the 30s watchdog covers concurrency, not fixture I/O.
    const auth = await fixture(t, factory), { store, userId } = auth;
    const peer = await openPeer();
    t.after(() => peer.close());
    await t.test('owner-held write precedes logout; revoked sessions reject later reads and writes', { timeout: 30000 }, async context => {
      const held = Promise.withResolvers(), release = Promise.withResolvers(), revoking = Promise.withResolvers();
      context.signal.addEventListener('abort', () => release.resolve(), { once: true });
      const id = randomUUID();
      let revoked = false;
      const writing = store.transaction(async tx => {
        await assertAssistantSession(tx, auth.session, { lock: true });
        held.resolve();
        await release.promise;
        await createAssistantThread(tx, { userId, id });
        await assertAssistantSession(tx, auth.session);
      });
      let revocation;
      try {
        await Promise.race([held.promise, writing]);
        const revocationStore = { transaction: fn => peer.transaction(tx => {
          const db = tx.db;
          tx.db = { ...db, get: async (sql, params) => {
            if (sql.includes(tx.t('users'))) {
              revoking.resolve();
              assert.match(sql, /FOR UPDATE/);
            }
            return db.get(sql, params);
          } };
          return fn(tx);
        }) };
        revocation = logout(revocationStore, auth.token).then(() => { revoked = true; });
        await Promise.race([revoking.promise, revocation]);
        assert.equal(revoked, false);
        release.resolve();
        await writing;
        await revocation;
        assert.ok(await store.db.get(`SELECT id FROM ${store.t('assistant_threads')} WHERE id=?`, [id]));
        await assert.rejects(() => conversations.listAssistantThreads(store, auth.session), error => error.status === 401);
        await assert.rejects(() => reserve(store, auth), error => error.status === 401);
      } finally {
        release.resolve();
        await Promise.allSettled([writing, revocation]);
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('assistant persistence contracts (SQLite)', t => runAssistantPersistenceContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
}
