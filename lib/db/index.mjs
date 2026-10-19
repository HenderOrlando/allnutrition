import { databaseConfig } from './config.mjs';
import { Store } from '../store.mjs';
import { migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5 } from './migrations.mjs';
export async function openStore(env = process.env, { migrate = false } = {}) {
  const config = databaseConfig(env);
  const adapter = config.provider === 'sqlite'
    ? await (await import('./sqlite.mjs')).openSQLite(config.filename)
    : await (await import('./postgres.mjs')).openPostgres(config, { migrate });
  const store = new Store(adapter);
  if (!migrate) {
    try {
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=5`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración de cancelación de importaciones v5.');
      }
      await store.initialize();
      if (config.provider === 'sqlite') {
        await migrateBusinessV3(store);
        await migrateInventoryV4(store);
        await migrateImportCancellationV5(store);
      }
    } catch (error) { await store.close(); throw error; }
  }
  return store;
}
