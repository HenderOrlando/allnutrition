import { BUSINESS_TABLES } from '../lib/db/migrations.mjs';
import { initializeBusinessDefaults } from '../lib/business/settings.mjs';
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
  const tables = [...BUSINESS_TABLES, 'order_audit','order_events','idempotency','orders','records','sessions','users','attempts','settings'];
  await store.db.exec(`TRUNCATE ${tables.map(name => store.t(name)).join(',')};`);
  await store.db.run(`UPDATE ${store.t('counters')} SET value=0`);
  await store.initialize();
  await initializeBusinessDefaults(store);
}
