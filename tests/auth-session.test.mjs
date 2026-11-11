import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin, getSession, login, logout } from '../lib/auth.mjs';
import { assertAssistantSessionActive } from '../lib/assistant/repository.mjs';

const email = 'auth-race@example.test';
const originalPassword = 'Clave-anterior-de-prueba-2026';
const replacementPassword = 'Clave-nueva-de-prueba-2026';

async function fixture() {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  await store.initialize();
  await createAdmin(store, email, originalPassword);
  return store;
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

async function runningTurn(store, userId, token, suffix) {
  const threadId = `thread-${suffix}`, turnId = `turn-${suffix}`, now = new Date().toISOString();
  const hash = tokenHash(token);
  await store.db.run(
    `INSERT INTO ${store.t('assistant_threads')}(id,user_id,version,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
    [threadId, userId, 1, JSON.stringify({}), now, now],
  );
  await store.db.run(
    `INSERT INTO ${store.t('assistant_turns')}(id,thread_id,user_id,request_id,input_hash,configuration_version,state,data,started_at,finished_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [turnId, threadId, userId, `request-${suffix}`, 'input-hash', 1, 'running', JSON.stringify({ sessionTokenHash: hash }), now, null, new Date(Date.now() + 60_000).toISOString()],
  );
  return { turnId, hash };
}

test('logout revoca únicamente la sesión enlazada e impide confirmar su turno en curso', async () => {
  const store = await fixture();
  try {
    const user = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
    const revoked = await login(store, email, originalPassword);
    const retained = await login(store, email, originalPassword);
    const target = await runningTurn(store, user.id, revoked.token, 'logout-target');
    await runningTurn(store, user.id, retained.token, 'logout-retained');
    let continueWorker;
    let workerPaused;
    const paused = new Promise(resolve => { workerPaused = resolve; });
    const resume = new Promise(resolve => { continueWorker = resolve; });
    const worker = (async () => {
      workerPaused();
      await resume;
      return store.transaction(tx => assertAssistantSessionActive(tx, {
        userId: user.id,
        sessionTokenHash: target.hash,
      }));
    })();
    await paused;
    await logout(store, revoked.token);
    assert.equal(await getSession(store, revoked.token), null);
    assert.equal((await getSession(store, retained.token)).user.id, user.id);
    continueWorker();
    await assert.rejects(worker);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('assistant_turns')} WHERE id=? AND state='running'`, [target.turnId])).count), 0);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('assistant_turns')} WHERE user_id=? AND state='running' AND json_extract(data,'$.sessionTokenHash')=?`, [user.id, tokenHash(retained.token)])).count), 1);
    await logout(store, retained.token);
  } finally { await store.close(); }
});

test('reset revoca todas las sesiones y turnos del usuario sin afectar a otra cuenta', async () => {
  const store = await fixture();
  try {
    const anotherEmail = 'auth-other@example.test';
    await createAdmin(store, anotherEmail, originalPassword);
    const user = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [email]);
    const other = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, [anotherEmail]);
    const first = await login(store, email, originalPassword);
    const second = await login(store, email, originalPassword);
    const otherSession = await login(store, anotherEmail, originalPassword);
    const targetTurn = await runningTurn(store, user.id, first.token, 'reset-target');
    await runningTurn(store, user.id, second.token, 'reset-second');
    const otherTurn = await runningTurn(store, other.id, otherSession.token, 'reset-other');
    let continueWorker;
    let workerPaused;
    const paused = new Promise(resolve => { workerPaused = resolve; });
    const resume = new Promise(resolve => { continueWorker = resolve; });
    const worker = (async () => {
      workerPaused();
      await resume;
      return store.transaction(tx => assertAssistantSessionActive(tx, {
        userId: user.id,
        sessionTokenHash: targetTurn.hash,
      }));
    })();
    await paused;
    await createAdmin(store, email, replacementPassword, { reset: true });
    continueWorker();
    await assert.rejects(worker);
    assert.equal(await getSession(store, first.token), null);
    assert.equal(await getSession(store, second.token), null);
    assert.equal((await getSession(store, otherSession.token)).user.id, other.id);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('assistant_turns')} WHERE user_id=? AND state='running'`, [user.id])).count), 0);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('assistant_turns')} WHERE id=? AND state='running'`, [otherTurn.turnId])).count), 1);
    await logout(store, otherSession.token);
  } finally { await store.close(); }
});

test('un acceso verificado con una contraseña revocada no crea una sesión', async () => {
  const store = await fixture();
  let continueLogin;
  let reachedSessionTransaction;
  const loginPaused = new Promise(resolve => { reachedSessionTransaction = resolve; });
  const resumeLogin = new Promise(resolve => { continueLogin = resolve; });
  const racingStore = {
    db: store.db,
    t: store.t.bind(store),
    transaction: async callback => {
      reachedSessionTransaction();
      await resumeLogin;
      return store.transaction(callback);
    },
  };

  try {
    const staleLogin = login(racingStore, email, originalPassword);
    await loginPaused;
    await createAdmin(store, email, replacementPassword, { reset: true });
    continueLogin();
    await assert.rejects(staleLogin, error => error?.status === 401);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('sessions')}`)).count), 0);

    const freshLogin = await login(store, email, replacementPassword);
    assert.equal((await getSession(store, freshLogin.token)).user.email, email);
    await logout(store, freshLogin.token);
    assert.equal(await getSession(store, freshLogin.token), null);
  } finally {
    continueLogin();
    await store.close();
  }
});
