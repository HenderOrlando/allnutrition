import { BUSINESS_TABLES, SOCIAL_TABLES, SOCIAL_INTERNAL_TABLES, INTEGRATION_INTERNAL_TABLES, ASSISTANT_INTERNAL_TABLES, ASSISTANT_OAUTH_INTERNAL_TABLES, ASSISTANT_WORK_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { initializeBusinessDefaults } from '../lib/business/settings.mjs';
import { openPostgres } from '../lib/db/postgres.mjs';
import { databaseConfig } from '../lib/db/config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
export function testDatabaseEnv(env = process.env) {
  let database;
  try { database = new URL(env.TEST_DATABASE_URL).pathname; } catch {}
  if (!env.TEST_DATABASE_URL || database !== '/allnutrition_test' || env.TEST_ALLOW_DATABASE_RESET !== 'allnutrition_test') {
    throw new Error('Usa exclusivamente una base descartable allnutrition_test y TEST_ALLOW_DATABASE_RESET=allnutrition_test.');
  }
  return {
    DB_DRIVER: 'supabase', DATABASE_URL: env.TEST_DATABASE_URL,
    DB_SSL: env.TEST_DB_SSL || 'verify', DB_CA_CERT: env.TEST_DB_CA_CERT,
    DB_CA_CERT_FILE: env.TEST_DB_CA_CERT_FILE,
  };
}

export async function resetPostgresStore(store) {
  if (process.env.TEST_ALLOW_DATABASE_RESET !== 'allnutrition_test') throw new Error('Reset requiere TEST_ALLOW_DATABASE_RESET=allnutrition_test.');
  const current = await store.db.get('SELECT current_database() AS name');
  if (current.name !== 'allnutrition_test') throw new Error('Reset rechazado: la conexión real no es allnutrition_test.');
  const tables = [...BUSINESS_TABLES, ...SOCIAL_TABLES, ...SOCIAL_INTERNAL_TABLES, ...INTEGRATION_INTERNAL_TABLES, ...ASSISTANT_INTERNAL_TABLES,...ASSISTANT_OAUTH_INTERNAL_TABLES,...ASSISTANT_WORK_INTERNAL_TABLES,'order_audit','order_events','idempotency','orders','records','sessions','users','attempts','settings'];
  // TRUNCATE recreates relation files; slow fsync must not consume a runtime query's 15s limit.
  await store.db.exec({ text: `TRUNCATE ${tables.map(name => store.t(name)).join(',')};`, query_timeout: 120000 });
  await store.db.run(`UPDATE ${store.t('counters')} SET value=0`);
  await store.initialize();
  await initializeBusinessDefaults(store);
}

// Contract files share the one explicitly guarded database. This test-only
// advisory lock prevents concurrent TRUNCATE/DDL without changing runtime SQL limits.
export async function withPostgresTestDatabase(run) {
  const env=testDatabaseEnv(),lock=await openPostgres({...databaseConfig(env),max:1},{migrate:true});
  try {
    return await lock.transaction(async tx=>{
      while(!(await tx.get('SELECT pg_try_advisory_xact_lock(1095522633,13) AS locked')).locked)await delay(1000);
      return run(env);
    });
  } finally { await lock.close(); }
}
