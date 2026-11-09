import { databaseConfig } from './config.mjs';
import { Store } from '../store.mjs';
import { migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5, migrateShippingInsuranceV6, migrateWorkbookImportV7, migrateSocialV8, migrateStockAlertsV9, migrateRuntimeIntegrationsV10 } from './migrations.mjs';
export async function openStore(env = process.env, { migrate = false } = {}) {
  const config = databaseConfig(env);
  const adapter = config.provider === 'sqlite'
    ? await (await import('./sqlite.mjs')).openSQLite(config.filename)
    : await (await import('./postgres.mjs')).openPostgres(config, { migrate });
  const store = new Store(adapter);
  if (!migrate) {
    try {
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=6`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración de seguro de envíos v6.');
      }
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=7`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración de incorporación de libros v7.');
      }
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=8`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración social v8.');
      }
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=9`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración de avisos de existencias v9.');
      }
      if (config.provider !== 'sqlite' && !await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=10`)) {
        throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación: falta la migración de integraciones v10.');
      }
      await store.initialize();
      if (config.provider === 'sqlite') {
        await migrateBusinessV3(store);
        await migrateInventoryV4(store);
        await migrateImportCancellationV5(store);
        await migrateShippingInsuranceV6(store);
        await migrateWorkbookImportV7(store);
        await migrateSocialV8(store);
        await migrateStockAlertsV9(store);
        await migrateRuntimeIntegrationsV10(store);
      }
    } catch (error) { await store.close(); throw error; }
  }
  return store;
}
