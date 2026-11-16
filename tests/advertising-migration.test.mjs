import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { ADVERTISING_INTERNAL_TABLES, migrateAdvertisingIntelligenceV14 } from '../lib/db/migrations.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { socialConnection } from './social-contract.mjs';
import { importData } from '../lib/import.mjs';

async function dropAdvertising(store) {
  await store.transaction(async tx => {
    await tx.lockWrites();
    for (const table of [...ADVERTISING_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=14`);
  });
}
async function relation(store, name) { return Boolean(await store.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name])); }
const at = '2026-11-16T12:00:00.000Z';

test('v14 rollback is atomic and migration preserves existing configuration and credentials', async () => {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await insertRow(store, 'users', { id: 'migration-actor', email: 'migration-meta@example.test', password: 'SYNTHETIC-CREDENTIAL', active: 1 });
    const connection = await socialConnection(store, { data: { name: 'Conexión conservada', authenticationMethod: 'token', readOnly: true } });
    const before = await store.db.all(`SELECT * FROM ${store.t('social_connections')}`);
    await dropAdvertising(store);
    const markerError = new Error('synthetic v14 marker failure');
    const failing = { provider: store.provider, transaction: fn => store.transaction(tx => {
      const db = tx.db;
      tx.db = { ...db, run: (sql, params) => { if (sql.includes('VALUES(14,')) throw markerError; return db.run(sql, params); } };
      return fn(tx);
    }) };
    await assert.rejects(migrateAdvertisingIntelligenceV14(failing), error => error === markerError);
    for (const table of ADVERTISING_INTERNAL_TABLES) assert.equal(await relation(store, table), false);
    assert.equal(await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=14`), null);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_connections')}`), before);
    assert.deepEqual(await migrateAdvertisingIntelligenceV14(store), { migrated: true, version: 14 });
    assert.deepEqual(await migrateAdvertisingIntelligenceV14(store), { migrated: false, version: 14 });
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_connections')}`), before);
    assert.equal((await store.db.get(`SELECT password FROM ${store.t('users')} WHERE id='migration-actor'`)).password, 'SYNTHETIC-CREDENTIAL');
    const analysisId = randomUUID(), itemId = randomUUID();
    await insertRow(store, 'social_account_analyses', { id: analysisId, connection_id: connection.id, actor_id: 'migration-actor', state: 'queued', data: '{}', version: 1, created_at: at, updated_at: at });
    await insertRow(store, 'social_account_analysis_items', { id: itemId, analysis_id: analysisId, resource_kind: 'campaign', resource_id: '601', data: '{}', created_at: at, updated_at: at });
    await assert.rejects(store.db.run(`UPDATE ${store.t('social_account_analysis_items')} SET data='[]' WHERE id=?`, [itemId]));
    await assert.rejects(store.db.run(`DELETE FROM ${store.t('users')} WHERE id='migration-actor'`));
    await store.db.run(`DELETE FROM ${store.t('social_connections')} WHERE id=?`, [connection.id]);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('social_account_analysis_items')} WHERE id=?`, [itemId]), null);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('social_account_analyses')} WHERE id=?`, [analysisId]), null);
    assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
  } finally { await store.close(); }
});

test('v14 requires v13 and leaves no partially-created private tables', async () => {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await dropAdvertising(store);
    await store.db.run(`DELETE FROM ${store.t('migrations')} WHERE version=13`);
    await assert.rejects(migrateAdvertisingIntelligenceV14(store), /v13/);
    for (const table of ADVERTISING_INTERNAL_TABLES) assert.equal(await relation(store, table), false);
  } finally { await store.close(); }
});

test('private generation and history content cannot leave through a commercial backup or restore', async () => {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const target = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await insertRow(store, 'users', { id: 'privacy-actor', email: 'privacy-meta@example.test', password: 'unused', active: 1 });
    const connection = await socialConnection(store);
    const analysisId = randomUUID();
    await insertRow(store, 'social_generation_jobs', { id: randomUUID(), actor_id: 'privacy-actor', state: 'queued', data: JSON.stringify({ prompt: 'PRIVATE-GENERATION-CANARY' }), version: 1, created_at: at, updated_at: at });
    await insertRow(store, 'social_account_analyses', { id: analysisId, connection_id: connection.id, actor_id: 'privacy-actor', state: 'queued', data: JSON.stringify({ progress: 'PRIVATE-HISTORY-CANARY' }), version: 1, created_at: at, updated_at: at });
    await insertRow(store, 'social_account_analysis_items', { id: randomUUID(), analysis_id: analysisId, resource_kind: 'campaign', resource_id: '601', data: JSON.stringify({ metric: 'PRIVATE-ITEM-CANARY' }), created_at: at, updated_at: at });
    const bundle = await store.exportData();
    for (const table of ADVERTISING_INTERNAL_TABLES) assert.equal(Object.hasOwn(bundle.business, table), false);
    assert.ok(!JSON.stringify(bundle).includes('PRIVATE-'));
    const injected = structuredClone(bundle);
    injected.business.social_generation_jobs = [{ id: 'unsafe', data: '{}' }];
    await assert.rejects(importData(target, injected), /internos de integraciones/);
    assert.equal((await target.db.get(`SELECT COUNT(*) AS n FROM ${target.t('social_connections')}`)).n, 0);
  } finally { await store.close(); await target.close(); }
});
