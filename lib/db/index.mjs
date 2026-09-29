import { databaseConfig } from './config.mjs';
import { Store } from '../store.mjs';
export async function openStore(env = process.env, { migrate = false } = {}) {
  const config = databaseConfig(env);
  const adapter = config.provider === 'sqlite'
    ? await (await import('./sqlite.mjs')).openSQLite(config.filename)
    : await (await import('./postgres.mjs')).openPostgres(config, { migrate });
  const store = new Store(adapter);
  if (!migrate) {
    try { await store.initialize(); } catch (error) { await store.close(); throw error; }
  }
  return store;
}
