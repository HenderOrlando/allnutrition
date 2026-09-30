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
  const current = await store.db.get('SELECT current_database() AS name');
  if (current.name !== 'allnutrition_test') throw new Error('Reset rechazado: la conexión real no es allnutrition_test.');
  await store.db.exec('TRUNCATE allnutrition.order_audit,allnutrition.order_events,allnutrition.idempotency,allnutrition.orders,allnutrition.records,allnutrition.sessions,allnutrition.users,allnutrition.attempts,allnutrition.settings;');
  await store.db.run(`UPDATE ${store.t('counters')} SET value=0`);
  await store.initialize();
}
