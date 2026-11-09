import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db/index.mjs';
import { migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5, migrateShippingInsuranceV6, migrateWorkbookImportV7, migrateSocialV8, migrateStockAlertsV9, migrateRuntimeIntegrationsV10, INTEGRATION_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { insertRow, hash } from '../lib/business/commands.mjs';
import { importData } from '../lib/import.mjs';

const at = '2026-11-09T12:00:00.000Z';
const facts = ({ exportedAt, ...bundle }) => bundle;
async function v9() {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }, { migrate: true });
  await store.initialize();
  for (const migrate of [migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5, migrateShippingInsuranceV6, migrateWorkbookImportV7, migrateSocialV8, migrateStockAlertsV9]) await migrate(store);
  return store;
}
const settingsRow = () => ({ id: 1, version: 1, data: JSON.stringify({ publicBaseUrl: 'https://panel.example.test', appId: '101', loginConfigId: '102', publishingEnabled: false, browserEnabled: false }), app_secret_ciphertext: 'PRIVATE-CIPHERTEXT-CANARY', app_secret_iv: 'private-iv', app_secret_tag: 'private-tag', actor_id: 'synthetic-admin', created_at: at, updated_at: at });

test('v10 conserva hechos, invalida OAuth anterior y es idempotente', async () => {
  const store = await v9();
  try {
    const before = await store.exportData();
    await insertRow(store, 'social_oauth_states', { state_hash: hash('old-state'), actor_id: 'synthetic-admin', csrf_hash: hash('old-csrf'), connection_id: null, expires_at: '2099-01-01T00:00:00.000Z', consumed_at: null });
    assert.deepEqual(await migrateRuntimeIntegrationsV10(store), { migrated: true, version: 10 });
    assert.deepEqual(await store.db.all('SELECT * FROM social_oauth_states'), []);
    assert.deepEqual(facts(await store.exportData()), facts(before));
    await insertRow(store, 'social_integration_settings', settingsRow());
    assert.deepEqual(await migrateRuntimeIntegrationsV10(store), { migrated: false, version: 10 });
    assert.equal((await store.db.get('SELECT version FROM social_integration_settings')).version, 1);
    assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
    await assert.rejects(() => insertRow(store, 'social_integration_settings', { ...settingsRow(), id: 2 }));
  } finally { await store.close(); }
});

test('fallo del marcador v10 revierte DDL e invalidación de OAuth', async () => {
  const store = await v9();
  try {
    await insertRow(store, 'social_oauth_states', { state_hash: hash('preserved-state'), actor_id: 'synthetic-admin', csrf_hash: hash('csrf'), connection_id: null, expires_at: '2099-01-01T00:00:00.000Z', consumed_at: null });
    await store.db.exec("CREATE TRIGGER reject_v10 BEFORE INSERT ON migrations WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'synthetic marker failure'); END;");
    await assert.rejects(() => migrateRuntimeIntegrationsV10(store), /synthetic marker failure/);
    assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM social_oauth_states')).n, 1);
    assert.equal(await store.db.get("SELECT name FROM sqlite_master WHERE name='social_integration_settings'"), null);
    assert.equal((await store.db.all('PRAGMA table_info(social_oauth_states)')).some(row => row.name === 'configuration_version'), false);
    await store.db.exec('DROP TRIGGER reject_v10');
    assert.deepEqual(await migrateRuntimeIntegrationsV10(store), { migrated: true, version: 10 });
  } finally { await store.close(); }
});

test('respaldo comercial excluye internos y rechaza restauración mezclada', async () => {
  const source = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const target = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    const empty = await source.exportData();
    await insertRow(source, 'social_integration_settings', settingsRow());
    const bundle = await source.exportData();
    assert.equal(JSON.stringify(bundle).includes('PRIVATE-CIPHERTEXT-CANARY'), false);
    for (const table of INTEGRATION_INTERNAL_TABLES) {
      assert.equal(Object.hasOwn(bundle.business, table), false);
      for (const location of ['business', 'root']) {
        const invalid = structuredClone(bundle);
        (location === 'root' ? invalid : invalid.business)[table] = [];
        await assert.rejects(() => importData(target, invalid));
      }
    }
    await insertRow(target, 'social_integration_settings', settingsRow());
    await assert.rejects(() => importData(target, empty));
    assert.equal((await target.db.get('SELECT app_secret_ciphertext FROM social_integration_settings')).app_secret_ciphertext, 'PRIVATE-CIPHERTEXT-CANARY');
  } finally { await source.close(); await target.close(); }
});
