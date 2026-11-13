import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { importData } from '../lib/import.mjs';
import { migrateAssistantV11, migrateAssistantOAuthV12, migrateAssistantWorkV13, ASSISTANT_INTERNAL_TABLES, ASSISTANT_OAUTH_INTERNAL_TABLES, ASSISTANT_WORK_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { emptyRecord } from '../lib/schema.mjs';

async function dropAssistant(store) {
  await store.transaction(async tx => {
    await tx.lockWrites();
    for (const table of [...ASSISTANT_WORK_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    for (const table of [...ASSISTANT_OAUTH_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version IN (12,13)`);
    for (const table of [...ASSISTANT_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=11`);
  });
}
async function restoreAssistant(store) {
  await migrateAssistantV11(store);
  await migrateAssistantOAuthV12(store);
  await migrateAssistantWorkV13(store);
}
async function relation(store, table) {
  return store.provider === 'sqlite'
    ? Boolean(await store.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]))
    : Boolean((await store.db.get('SELECT to_regclass(?) AS relation', [store.t(table)])).relation);
}
async function schema(store) {
  const result = {};
  for (const table of ASSISTANT_INTERNAL_TABLES) result[table] = await store.db.all(store.provider === 'sqlite'
    ? `PRAGMA table_info(${table})`
    : `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='allnutrition' AND table_name='${table}' ORDER BY ordinal_position`);
  return result;
}
async function businessRows(store) {
  const result = {};
  for (const table of ['records', 'orders', 'settings', 'business_settings', 'users', 'sessions', 'business_audit', 'business_requests']) result[table] = await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY ${table === 'business_requests' ? 'scope,request_id' : table === 'sessions' ? 'token_hash' : 'id'}`);
  return result;
}
const stamp = '2026-11-10T00:00:00.000Z';
export async function runAssistantMigrationContracts(t, factory, { openRuntime = null } = {}) {
  await t.test('v10→v11 preserves existing rows, has no settings default, enforces FK ownership and is idempotent', async () => {
    const store = await factory();
    try {
      await createAdmin(store, 'assistant-migration@example.test', 'test-only-password');
      const user = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['assistant-migration@example.test']);
      await store.save('products', { ...emptyRecord('products'), title: 'Producto anterior a Ali', slug: 'producto-anterior-a-ali', price: 20000 }, null, null, user.id);
      await dropAssistant(store);
      if (openRuntime) await assert.rejects(openRuntime, /v11/);
      const before = await businessRows(store);
      assert.deepEqual(await migrateAssistantV11(store), { migrated: true, version: 11 });
      assert.deepEqual(await businessRows(store), before);
      const created = await schema(store);
      for (const table of ASSISTANT_INTERNAL_TABLES) assert.ok(created[table].length, `missing ${table}`);
      assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('assistant_settings')}`), []);
      await assert.rejects(() => store.db.run(`INSERT INTO ${store.t('assistant_threads')}(id,user_id,version,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`, ['orphan-thread', 'missing-user', 1, '{}', stamp, stamp]));
      await store.db.run(`INSERT INTO ${store.t('assistant_threads')}(id,user_id,version,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`, ['valid-thread', user.id, 1, '{}', stamp, stamp]);
      await assert.rejects(() => store.db.run(`INSERT INTO ${store.t('assistant_turns')}(id,thread_id,user_id,request_id,input_hash,configuration_version,state,data,started_at,finished_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ['orphan-turn', 'missing-thread', user.id, 'request-1', 'hash', 0, 'running', '{}', stamp, null, stamp]));
      await assert.rejects(() => store.db.run(`INSERT INTO ${store.t('assistant_settings')}(id,version,enabled,data,api_key_ciphertext,actor_id,created_at,updated_at) VALUES(1,1,0,'{}','ciphertext',?,?,?)`, [user.id, stamp, stamp]));
      assert.deepEqual(await migrateAssistantV11(store), { migrated: false, version: 11 });
      assert.deepEqual(await schema(store), created);
      if (store.provider === 'sqlite') assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
    } finally { await restoreAssistant(store); await store.close(); }
  });
  await t.test('marker failure rolls back every v11 table and index and allows a clean retry', async () => {
    const store = await factory();
    try {
      await dropAssistant(store);
      const before = await businessRows(store);
      const markerFailure = new Error('synthetic assistant marker failure');
      const failing = { provider: store.provider, transaction: fn => store.transaction(tx => {
        const db = tx.db;
        tx.db = { ...db, run: (sql, params) => {
          if (sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(11,`)) throw markerFailure;
          return db.run(sql, params);
        } };
        return fn(tx);
      }) };
      await assert.rejects(() => migrateAssistantV11(failing), error => error === markerFailure);
      assert.deepEqual(await businessRows(store), before);
      for (const table of ASSISTANT_INTERNAL_TABLES) assert.equal(await relation(store, table), false, `DDL rollback: ${table}`);
      assert.equal(await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=11`), null);
      assert.deepEqual(await migrateAssistantV11(store), { migrated: true, version: 11 });
      if (store.provider === 'sqlite') assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
    } finally { await restoreAssistant(store); await store.close(); }
  });
  await t.test('missing v10 rejects v11 atomically', async () => {
    const store = await factory();
    let original;
    try {
      await dropAssistant(store);
      original = await store.db.get(`SELECT * FROM ${store.t('migrations')} WHERE version=10`);
      await store.db.run(`DELETE FROM ${store.t('migrations')} WHERE version=10`);
      await assert.rejects(() => migrateAssistantV11(store), /v10/);
      for (const table of ASSISTANT_INTERNAL_TABLES) assert.equal(await relation(store, table), false);
    } finally {
      if (original) await store.db.run(`INSERT INTO ${store.t('migrations')}(version,applied_at) VALUES(10,?)`, [original.applied_at]);
      await restoreAssistant(store);
      await store.close();
    }
  });
  await t.test('commercial v3 export excludes all Ali internals and configuration but retains assistant commercial audit', async () => {
    const source = await factory();
    let bundle, empty;
    try {
      empty = await source.exportData();
      await createAdmin(source, 'assistant-backup@example.test', 'test-only-password');
      const user = await source.db.get(`SELECT id FROM ${source.t('users')} WHERE email=?`, ['assistant-backup@example.test']);
      await insertRow(source, 'business_requests', { scope: 'assistant:settings', request_id: 'assistant-request-001', actor_id: user.id, payload_hash: 'a'.repeat(64), result_json: '{"canary":"PRIVATE-CONFIG"}', created_at: stamp });
      await insertRow(source, 'business_audit', { id: 'assistant-config-audit', entity_type: 'assistant:settings', entity_id: '1', actor_id: user.id, recorded_at: stamp, data: '{"canary":"PRIVATE-CONFIG"}' });
      await insertRow(source, 'business_audit', { id: 'assistant-commercial-audit', entity_type: 'products', entity_id: 'product-1', actor_id: user.id, recorded_at: stamp, data: '{"source":"assistant"}' });
      await insertRow(source, 'assistant_settings', { id: 1, version: 1, enabled: 0, data: '{}', api_key_ciphertext: 'PRIVATE-CIPHERTEXT', api_key_iv: 'PRIVATE-IV', api_key_tag: 'PRIVATE-TAG', actor_id: user.id, created_at: stamp, updated_at: stamp });
      await insertRow(source, 'assistant_threads', { id: 'private-thread', user_id: user.id, version: 1, data: '{"title":"PRIVATE-CONVERSATION"}', created_at: stamp, updated_at: stamp });
      bundle = await source.exportData();
      assert.equal(bundle.format, 'allnutrition-export-v3');
      assert.equal(bundle.business.business_requests.some(row => row.scope.startsWith('assistant:')), false);
      assert.equal(bundle.business.business_audit.some(row => row.entity_type === 'assistant:settings'), false);
      assert.equal(bundle.business.business_audit.some(row => row.entity_type === 'products' && JSON.parse(row.data).source === 'assistant'), true);
      assert.equal(JSON.stringify(bundle).includes('PRIVATE-'), false);
    } finally { await source.close(); }
    const target = await factory();
    try {
      const before = await target.exportData();
      for (const table of ASSISTANT_INTERNAL_TABLES) {
        for (const malicious of [
          { ...bundle, [table]: [] },
          { ...bundle, business: { ...bundle.business, nested: { [table]: [] } } },
        ]) await assert.rejects(() => importData(target, malicious));
        const encoded = structuredClone(bundle);
        encoded.business.business_audit.push({ id: `encoded-${table}`, entity_type: 'products', entity_id: 'x', actor_id: null, recorded_at: stamp, data: JSON.stringify({ nested: { [table]: [] } }) });
        await assert.rejects(() => importData(target, encoded));
      }
      for (const key of ['ASSISTANT_THREADS', 'api_key_ciphertext', 'api_key_iv', 'api_key_tag', 'sessionTokenHash', 'workMemory', 'pendingQuestion', 'publicResult']) {
        const encoded = structuredClone(bundle);
        encoded.business.business_audit.push({ id: `private-${key}`, entity_type: 'products', entity_id: 'x', actor_id: null, recorded_at: stamp, data: JSON.stringify({ nested: { [key]: 'PRIVATE-CANARY' } }) });
        await assert.rejects(() => importData(target, encoded), /internos/);
      }
      const requestBundle = structuredClone(bundle);
      requestBundle.business.business_requests.push({ scope: 'assistant:settings', request_id: 'assistant-request-002', actor_id: null, payload_hash: 'b'.repeat(64), result_json: '{}', created_at: stamp });
      await assert.rejects(() => importData(target, requestBundle), /asistente/);
      const auditBundle = structuredClone(bundle);
      auditBundle.business.business_audit.push({ id: 'assistant-config-audit-restore', entity_type: 'assistant:settings', entity_id: '1', actor_id: null, recorded_at: stamp, data: '{}' });
      await assert.rejects(() => importData(target, auditBundle), /asistente/);
      assert.deepEqual((await target.exportData()).business, before.business);
      await createAdmin(target, 'assistant-backup-target@example.test', 'test-only-password');
      const user = await target.db.get(`SELECT id FROM ${target.t('users')} WHERE email=?`, ['assistant-backup-target@example.test']);
      await insertRow(target, 'assistant_threads', { id: 'destination-thread', user_id: user.id, version: 1, data: '{}', created_at: stamp, updated_at: stamp });
      await assert.rejects(() => importData(target, empty), /vacío/);
    } finally { await target.close(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test('assistant migration contracts (SQLite)', t => runAssistantMigrationContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
}
