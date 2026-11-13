import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin, login, logout } from '../lib/auth.mjs';
import { ASSISTANT_WORK_INTERNAL_TABLES, migrateAssistantWorkV13 } from '../lib/db/migrations.mjs';
import { ASSISTANT_LIMITS } from '../lib/assistant/limits.mjs';
import { createAssistantEvidence } from '../lib/assistant/evidence.mjs';
import { importData } from '../lib/import.mjs';
import {
  reserveAssistantTurn, finishAssistantTurn, getAssistantTurn, getAssistantThread,
  createAssistantWork, claimAssistantWork, checkpointAssistantWork, getAssistantWork,
  getAssistantWorkChunks, resolveAssistantWorkCursor, pageAssistantWorkRead,
  expireAssistantTurn, invalidateAssistantConfiguration, deleteAssistantThread,
  saveAssistantProposal, getAssistantProposal, cancelPendingTurnProposals,
} from '../lib/assistant/repository.mjs';
import { hashAssistantInput } from '../lib/assistant/repository.mjs';

const locked = (store, fn) => store.transaction(async tx => { await tx.lockWrites(); return fn(tx); });
const stamp = '2026-11-12T12:00:00.000Z';
async function authenticate(store, email = 'assistant-work@example.test') {
  const password = 'workspace-contract-only-2026';
  await createAdmin(store, email, password);
  const user = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
  const session = await login(store, email, password);
  return { userId: user.id, token: session.token, sessionTokenHash: createHash('sha256').update(session.token).digest('hex') };
}
async function fixture(t, factory) {
  const store = await factory();
  t.after(() => store.close());
  return { store, ...await authenticate(store) };
}
async function start(f, { at = Date.now(), sourceTurnId = null, threadId = null, threadVersion = null, input = { message: 'Revisar el catálogo', context: { view: { section: 'products' }, selection: null } } } = {}) {
  return locked(f.store, async tx => {
    const requestId = randomUUID();
    const reservation = await reserveAssistantTurn(tx, { userId: f.userId, sessionTokenHash: f.sessionTokenHash, requestId, inputHash: hashAssistantInput(input), configurationVersion: 0, threadId, threadVersion, data: { message: input.message }, at });
    const work = await createAssistantWork(tx, { turn: reservation.turn, mode: sourceTurnId ? 'extended' : 'quick', sourceTurnId, input, at });
    return { ...reservation, work };
  });
}
const claim = (f, turn, changes = {}) => locked(f.store, tx => claimAssistantWork(tx, { userId: f.userId, turnId: turn.turn.id, requestId: randomUUID(), version: turn.work.version, ...changes }));
function readChunk({ id = randomUUID(), readId = 'catalog-read', index = 1, continuation = false, resumedCursor = null } = {}) {
  const evidence = createAssistantEvidence({ domain: 'catalog', entityId: `product-${index}`, recordVersion: 1, field: 'title', label: 'Producto', value: `Producto ${index}`, asOf: stamp, asOfPrecision: 'instant' });
  return { id, kind: 'read', data: {
    readId, request: { domain: 'catalog', query: { kind: 'products' }, select: { mode: 'records', limit: null } }, resumedCursor,
    result: { records: [{ id: `product-${index}`, version: 1, title: `Producto ${index}` }], summary: {}, pagination: { total: 2 }, evidence: [evidence],
      retrieval: { complete: !continuation, selection: 'all', recordsRead: 1, recordsTotal: 2, sourceStamp: 'catalog-source-1', consultedAt: stamp, reasons: continuation ? ['unread_pages'] : [] },
      continuation: continuation ? { cursor: null, label: 'Revisar productos restantes', remainingRecords: 1 } : null,
      ...(continuation ? { _continuation: { domain: 'catalog', query: { kind: 'products' }, select: { mode: 'records', limit: null }, offset: 1, sourceStamp: 'catalog-source-1' } } : {}),
      _evidenceMetadata: { [evidence.id]: { currency: null, interval: null, semantic: 'title', sourceStamp: 'catalog-source-1' } },
      _dataset: { domain: 'catalog', resource: 'products', recordId: null, filters: {}, startDate: null, endDateExclusive: null, asOf: stamp, sourceStamp: 'catalog-source-1' },
    },
  } };
}
async function checkpoint(f, turn, lease, chunks = [], changes = {}) {
  return locked(f.store, tx => checkpointAssistantWork(tx, { userId: f.userId, turnId: turn.turn.id, leaseToken: lease.leaseToken, version: lease.work.version, phase: 'reading', chunks, data: {}, ...changes }));
}
async function dropWork(store) {
  await locked(store, async tx => {
    for (const table of [...ASSISTANT_WORK_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=13`);
  });
}
async function relation(store, name) {
  return store.provider === 'sqlite'
    ? Boolean(await store.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]))
    : Boolean((await store.db.get('SELECT to_regclass(?) AS relation', [store.t(name)])).relation);
}

export async function runAssistantWorkContracts(t, factory, { openRuntime = null } = {}) {
  await t.test('v12→v13 is atomic, requires v12, preserves existing data and is idempotent', async t => {
    const f = await fixture(t, factory), { store } = f;
    const before = await store.exportData();
    try {
      await dropWork(store);
      if (openRuntime) await assert.rejects(openRuntime, /v13/);
      const markerFailure = new Error('synthetic workspace marker failure');
      const failing = { provider: store.provider, transaction: fn => store.transaction(tx => {
        const db = tx.db;
        tx.db = { ...db, run: (sql, params) => { if (sql.includes('VALUES(13,')) throw markerFailure; return db.run(sql, params); } };
        return fn(tx);
      }) };
      await assert.rejects(migrateAssistantWorkV13(failing), error => error === markerFailure);
      for (const table of ASSISTANT_WORK_INTERNAL_TABLES) assert.equal(await relation(store, table), false);
      assert.equal(await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=13`), null);
      const v12 = await store.db.get(`SELECT * FROM ${store.t('migrations')} WHERE version=12`);
      await store.db.run(`DELETE FROM ${store.t('migrations')} WHERE version=12`);
      try { await assert.rejects(migrateAssistantWorkV13(store), /v12/); }
      finally { await store.db.run(`INSERT INTO ${store.t('migrations')}(version,applied_at) VALUES(12,?)`, [v12.applied_at]); }
      assert.deepEqual(await migrateAssistantWorkV13(store), { migrated: true, version: 13 });
      assert.deepEqual(await migrateAssistantWorkV13(store), { migrated: false, version: 13 });
      const after = await store.exportData();
      delete before.exportedAt; delete after.exportedAt;
      assert.deepEqual(after, before);
      if (store.provider === 'sqlite') assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
    } finally { await migrateAssistantWorkV13(store); }
  });
  await t.test('leases are exclusive, versioned, request-idempotent and expire after forty-five seconds', async t => {
    const f = await fixture(t, factory), at = Date.now(), turn = await start(f, { at });
    const requestId = randomUUID(), first = await claim(f, turn, { requestId, at });
    assert.equal(first.claimed, true);
    assert.equal(Date.parse(first.work.lease_until) - at, ASSISTANT_LIMITS.leaseMs);
    assert.equal((await claim(f, turn, { requestId, at: at + 1 })).claimed, false);
    assert.equal((await claim(f, turn, { at: at + 1 })).claimed, false);
    await assert.rejects(claim(f, turn, { requestId, version: 2, at: at + 1 }), error => error.status === 409);
    const replacement = await claim(f, turn, { requestId, at: at + ASSISTANT_LIMITS.leaseMs + 1 });
    assert.equal(replacement.claimed, true);
    assert.notEqual(replacement.leaseToken, first.leaseToken);
    await assert.rejects(checkpoint(f, turn, first, [], { at: at + ASSISTANT_LIMITS.leaseMs + 2 }), error => error.status === 409);
    const saved = await checkpoint(f, turn, replacement, [readChunk()], { at: at + ASSISTANT_LIMITS.leaseMs + 2 });
    assert.equal(saved.version, 2);
    const staleRequestId = randomUUID();
    assert.equal((await claim(f, turn, { requestId: staleRequestId, at: at + ASSISTANT_LIMITS.leaseMs + 3 })).claimed, false);
    await assert.rejects(claim(f, { ...turn, work: saved }, { requestId: staleRequestId, at: at + ASSISTANT_LIMITS.leaseMs + 4 }), error => error.status === 409);
    assert.equal(saved.lease_token, null);
    assert.equal((await claim(f, turn, { requestId, at: at + ASSISTANT_LIMITS.leaseMs + 3 })).claimed, false);
    assert.equal((await claim(f, turn, { at: at + ASSISTANT_LIMITS.leaseMs + 3 })).claimed, false);
    assert.equal((await getAssistantWorkChunks(f.store, { userId: f.userId, turnId: turn.turn.id })).filter(chunk => chunk.kind === 'read').length, 1);
  });
  await t.test('checkpoints retain private cursors, publish factual previews and paginate only projected records', async t => {
    const f = await fixture(t, factory), turn = await start(f), before = await getAssistantThread(f.store, { userId: f.userId, threadId: turn.threadId });
    const first = await checkpoint(f, turn, await claim(f, turn), [readChunk({ continuation: true })]);
    const result = first.chunks[0].data.result, cursor = result.continuation.cursor;
    assert.match(cursor, /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(result, '_continuation'), false);
    assert.equal(Object.hasOwn(result, '_evidenceMetadata'), false);
    assert.equal(Object.hasOwn(result, '_dataset'), false);
    const descriptor = await resolveAssistantWorkCursor(f.store, { userId: f.userId, turnId: turn.turn.id, cursor });
    assert.equal(descriptor.offset, 1);
    const persisted = await getAssistantTurn(f.store, { userId: f.userId, turnId: turn.turn.id });
    assert.equal(persisted.data.preview.proposal, null);
    assert.equal(persisted.data.preview.analysis.canContinue, true);
    assert.equal(persisted.data.preview.analysis.scope.datasets[0].sourceStamp, 'catalog-source-1');
    assert.equal(persisted.data.preview.evidence[0].value, 'Producto 1');
    const after = await getAssistantThread(f.store, { userId: f.userId, threadId: turn.threadId });
    assert.equal(after.version, before.version);
    assert.deepEqual(after.data, before.data);
    assert.equal(after.updated_at, before.updated_at);
    const secondLease = await claim(f, { ...turn, work: first });
    await checkpoint(f, turn, secondLease, [readChunk({ index: 2, resumedCursor: cursor })]);
    let page = await pageAssistantWorkRead(f.store, { userId: f.userId, turnId: turn.turn.id, readId: 'catalog-read' });
    assert.deepEqual(Object.keys(page).sort(), ['readId','records','evidence','pagination','retrieval'].sort());
    assert.equal(page.records[0].id, 'product-1');
    const serialized = JSON.stringify(page);
    for (const secret of ['continuationDescriptor','evidenceMetadata','sessionTokenHash','request','pageCursor','_continuation']) assert.equal(serialized.includes(secret), false);
    page = await pageAssistantWorkRead(f.store, { userId: f.userId, turnId: turn.turn.id, readId: 'catalog-read', cursor: page.pagination.nextCursor });
    assert.equal(page.records[0].id, 'product-2');
    assert.equal(page.pagination.nextCursor, null);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= ASSISTANT_LIMITS.readPageBytes);
    assert.equal((await pageAssistantWorkRead(f.store, { userId: f.userId, turnId: turn.turn.id, readId: 'all' })).records[0].id, 'product-1');
    assert.equal((await getAssistantTurn(f.store, { userId: f.userId, turnId: turn.turn.id })).data.preview.analysis.canContinue, false);
    await assert.rejects(resolveAssistantWorkCursor(f.store, { userId: f.userId, turnId: turn.turn.id, cursor: randomUUID() }), error => error.status === 404);
    const foreign = await authenticate(f.store, 'assistant-work-foreign@example.test');
    for (const fn of [resolveAssistantWorkCursor, pageAssistantWorkRead, getAssistantWorkChunks]) await assert.rejects(fn(f.store, { userId: foreign.userId, turnId: turn.turn.id, cursor, readId: 'catalog-read' }), error => error.status === 404);
  });
  await t.test('continuations authorize only same-thread source chunks and deletion cascades through descendants', async t => {
    const f = await fixture(t, factory), original = await start(f);
    const saved = await checkpoint(f, original, await claim(f, original), [readChunk({ continuation: true })]);
    const cursor = saved.chunks[0].data.result.continuation.cursor;
    const prior = await getAssistantTurn(f.store, { userId: f.userId, turnId: original.turn.id });
    await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.userId, turnId: original.turn.id, data: { publicResult: prior.data.preview } }));
    const extended = await start(f, { threadId: original.threadId, threadVersion: original.threadVersion, sourceTurnId: original.turn.id });
    await assert.rejects(locked(f.store, tx => saveAssistantProposal(tx, { userId: f.userId, threadId: extended.threadId, turnId: extended.turn.id, configurationVersion: 0, data: { configurationVersion: 0, target: 'record:products', patch: { title: 'No ejecutar' } } })), error => error.status === 409);
    assert.equal((await resolveAssistantWorkCursor(f.store, { userId: f.userId, turnId: extended.turn.id, cursor })).offset, 1);
    assert.equal((await pageAssistantWorkRead(f.store, { userId: f.userId, turnId: extended.turn.id, readId: 'catalog-read' })).records[0].id, 'product-1');
    const independent = await start(f);
    await assert.rejects(resolveAssistantWorkCursor(f.store, { userId: f.userId, turnId: independent.turn.id, cursor }), error => error.status === 404);
    await assert.rejects(getAssistantWorkChunks(f.store, { userId: f.userId, turnId: extended.turn.id, sourceTurnId: independent.turn.id }), error => error.status === 404);
    await assert.rejects(start(f, { sourceTurnId: original.turn.id }), error => error.status === 404);
    await locked(f.store, tx => tx.db.run(`DELETE FROM ${tx.t('assistant_turns')} WHERE id=?`, [original.turn.id]));
    assert.equal(await getAssistantWork(f.store, { userId: f.userId, turnId: extended.turn.id }), null);
    await locked(f.store, tx => deleteAssistantThread(tx, { userId: f.userId, threadId: original.threadId, version: extended.threadVersion }));
    assert.equal(await getAssistantWork(f.store, { userId: f.userId, turnId: original.turn.id }), null);
    assert.equal(await getAssistantWork(f.store, { userId: f.userId, turnId: extended.turn.id }), null);
    assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('assistant_work_chunks')} WHERE turn_id IN (?,?)`, [original.turn.id, extended.turn.id])).n), 0);
  });
  await t.test('database constraints reject mixed ownership, self origins and oversized multibyte JSON', async t => {
    const f = await fixture(t, factory), own = await start(f), foreign = await authenticate(f.store, 'assistant-work-fk@example.test'), other = await start({ store: f.store, ...foreign });
    const workspace = (turn, userId, threadId, source = null, data = '{}') => f.store.db.run(`INSERT INTO ${f.store.t('assistant_workspaces')}(turn_id,thread_id,user_id,version,mode,phase,source_turn_id,data,created_at,updated_at) VALUES(?,?,?,1,'quick','planning',?,?,?,?)`, [turn, threadId, userId, source, data, stamp, stamp]);
    await assert.rejects(workspace(randomUUID(), f.userId, own.threadId));
    await assert.rejects(f.store.db.run(`UPDATE ${f.store.t('assistant_workspaces')} SET source_turn_id=? WHERE turn_id=?`, [other.turn.id, own.turn.id]));
    await assert.rejects(f.store.db.run(`UPDATE ${f.store.t('assistant_workspaces')} SET source_turn_id=turn_id WHERE turn_id=?`, [own.turn.id]));
    await assert.rejects(f.store.db.run(`UPDATE ${f.store.t('assistant_workspaces')} SET data=? WHERE turn_id=?`, [JSON.stringify({ value: 'ñ'.repeat(17000) }), own.turn.id]));
    const insert = (kind, data, userId = f.userId, sequence = 1) => f.store.db.run(`INSERT INTO ${f.store.t('assistant_work_chunks')}(id,turn_id,thread_id,user_id,sequence,kind,data,created_at) VALUES(?,?,?,?,?,?,?,?)`, [randomUUID(), own.turn.id, own.threadId, userId, sequence, kind, JSON.stringify(data), stamp]);
    await assert.rejects(insert('read', {}, foreign.userId));
    await assert.rejects(insert('read', { value: 'ñ'.repeat(25000) }));
    await assert.rejects(insert('input', { value: 'ñ'.repeat(33000) }));
    await insert('analysis', { value: 'valid' });
    await assert.rejects(insert('analysis', {}, f.userId, 1));
    const lease = await claim(f, own);
    await assert.rejects(checkpoint(f, own, lease, [], { data: { records: 'ñ'.repeat(17000) } }), /límite/);
    assert.equal((await getAssistantWork(f.store, { userId: f.userId, turnId: own.turn.id })).version, 1);
    await assert.rejects(start(f, { input: { message: 'ñ'.repeat(33000) } }), /límite/);
  });
  await t.test('idle expiry promotes the last preview exactly once, frees the thread and clears both copies', async t => {
    const f = await fixture(t, factory), at = Date.now(), turn = await start(f, { at });
    await checkpoint(f, turn, await claim(f, turn, { at }), [readChunk({ continuation: true })], { at: at + 1 });
    const expired = await locked(f.store, tx => expireAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id, at: at + ASSISTANT_LIMITS.idleMs + 2 }));
    assert.equal(expired.state, 'failed');
    assert.equal(expired.data.preview, null);
    assert.equal(expired.data.publicResult.evidence[0].value, 'Producto 1');
    assert.equal(expired.data.publicResult.analysis.reason, 'interrupted');
    assert.equal(expired.data.publicResult.analysis.canContinue, true);
    assert.equal((await getAssistantWork(f.store, { userId: f.userId, turnId: turn.turn.id })).phase, 'done');
    const late = await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id, data: { publicResult: { invalid: true } } }));
    assert.deepEqual(late, expired);
    await start(f, { threadId: turn.threadId, threadVersion: turn.threadVersion, at: at + ASSISTANT_LIMITS.idleMs + 3 });
    const empty = await start(f, { at: at + ASSISTANT_LIMITS.idleMs + 3 });
    const noRead = await locked(f.store, tx => expireAssistantTurn(tx, { userId: f.userId, turnId: empty.turn.id, at: at + 2 * ASSISTANT_LIMITS.idleMs + 4 }));
    assert.equal(noRead.data.publicResult.analysis.status, 'empty');
    assert.equal(noRead.data.publicResult.analysis.canContinue, false);
    assert.deepEqual(noRead.data.publicResult.evidence, []);
  });
  await t.test('finish, configuration changes and logout invalidate leases and reject late checkpoints', async t => {
    for (const cause of ['finish','configuration','logout']) {
      const f = await fixture(t, factory), turn = await start(f), lease = await claim(f, turn);
      if (cause === 'finish') {
        const current = await getAssistantTurn(f.store, { userId: f.userId, turnId: turn.turn.id });
        await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id, data: { publicResult: current.data.preview } }));
      } else if (cause === 'configuration') await locked(f.store, tx => invalidateAssistantConfiguration(tx, { configurationVersion: 1 }));
      else await logout(f.store, f.token);
      assert.equal((await getAssistantWork(f.store, { userId: f.userId, turnId: turn.turn.id })).lease_token, null);
      await assert.rejects(checkpoint(f, turn, lease, [readChunk()]), error => error.status === 409 || error.status === 401);
      assert.equal(Number((await f.store.db.get(`SELECT COUNT(*) AS n FROM ${f.store.t('assistant_work_chunks')} WHERE turn_id=? AND kind='read'`, [turn.turn.id])).n), 0);
    }
  });
  await t.test('stop atomically promotes persisted facts, cancels unexecuted proposals and defeats late completion', async t => {
    const f = await fixture(t, factory), turn = await start(f);
    const saved = await checkpoint(f, turn, await claim(f, turn), [readChunk({ continuation: true })]);
    const lease = await claim(f, { ...turn, work: saved });
    const proposal = await locked(f.store, tx => saveAssistantProposal(tx, { userId: f.userId, threadId: turn.threadId, turnId: turn.turn.id, configurationVersion: 0, data: { configurationVersion: 0, target: 'record:products', patch: { title: 'Producto revisado' } } }));
    const stopped = await locked(f.store, async tx => {
      const current = await getAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id });
      await cancelPendingTurnProposals(tx, { userId: f.userId, turnId: turn.turn.id });
      return finishAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id, data: { publicResult: { ...current.data.preview, analysis: { ...current.data.preview.analysis, reason: 'user_stopped' } } } });
    });
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.data.preview, null);
    assert.equal(stopped.data.publicResult.analysis.reason, 'user_stopped');
    assert.equal(stopped.data.publicResult.evidence[0].value, 'Producto 1');
    assert.equal((await getAssistantProposal(f.store, { userId: f.userId, proposalId: proposal.id })).state, 'cancelled');
    await assert.rejects(checkpoint(f, turn, lease, [readChunk({ index: 2 })]), error => error.status === 409);
    const loser = await locked(f.store, tx => finishAssistantTurn(tx, { userId: f.userId, turnId: turn.turn.id, data: { publicResult: { invalid: true } } }));
    assert.deepEqual(loser.data.publicResult, stopped.data.publicResult);
  });
  await t.test('commercial backups exclude private input, fragments and cursors and reject nested restoration', async t => {
    const f = await fixture(t, factory), turn = await start(f);
    await checkpoint(f, turn, await claim(f, turn), [readChunk({ continuation: true })]);
    const bundle = await f.store.exportData(), serialized = JSON.stringify(bundle);
    for (const table of ASSISTANT_WORK_INTERNAL_TABLES) {
      assert.equal(Object.hasOwn(bundle, table), false);
      assert.equal(serialized.includes(table), false);
      await assert.rejects(importData(f.store, { ...bundle, [table]: [] }), /internos/);
      await assert.rejects(importData(f.store, { ...bundle, business: { ...bundle.business, nested: { [table]: [] } } }), /internos/);
    }
    assert.equal(serialized.includes(f.sessionTokenHash), false);
    assert.equal(serialized.includes('continuationDescriptor'), false);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('recoverable assistant work contracts (SQLite)', t => runAssistantWorkContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
}
