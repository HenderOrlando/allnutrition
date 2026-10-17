import { fail } from './validation.mjs';
import { initializeBusinessDefaults, businessDefaults, ALERT_TYPES } from './business/settings.mjs';
import { canonicalJSON, insertRow } from './business/commands.mjs';
import { queueJobTx } from './business/job-leases.mjs';
import { COMMERCIAL_TABLES, CORE_BACKUP_TABLES } from './backup-schema.mjs';
import { dependencyOrderedRows, prepareCommercialBundle } from './business-backup.mjs';

async function requireCommerciallyEmpty(tx) {
  for (const table of ['records','orders',...Object.keys(CORE_BACKUP_TABLES),...Object.keys(COMMERCIAL_TABLES).filter(name => !['business_settings','alert_rules'].includes(name))]) {
    if (Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t(table)}`)).n)) fail('El destino debe estar vacío: no se sobrescriben ni mezclan datos.');
  }
  const counters = await tx.db.all(`SELECT id,value FROM ${tx.t('counters')} WHERE id IN ('orders','business_revision')`);
  if (counters.some(row => Number(row.value) !== 0)) fail('El destino contiene contadores comerciales anteriores.');
  const settings = await tx.db.get(`SELECT data,version FROM ${tx.t('business_settings')} WHERE id=1`);
  if (settings) {
    const data = JSON.parse(settings.data);
    if (settings.version !== 1 || canonicalJSON(data) !== canonicalJSON(businessDefaults(data.reportsStartOn))) fail('El destino contiene configuración comercial modificada.');
  }
  for (const row of await tx.db.all(`SELECT id,type,scope_key,version FROM ${tx.t('alert_rules')}`)) if (!ALERT_TYPES.includes(row.id) || row.id !== row.type || row.scope_key !== 'global' || row.version !== 1) fail('El destino contiene reglas comerciales modificadas.');
}

/** Deliberate restoration into an empty business, never an operational merge. */
export async function importData(store, input, options = {}) {
  // Complete input validation happens before any destination mutation. The same
  // transaction still owns emptiness, local-user links and every inserted row.
  const bundle = await prepareCommercialBundle(input,options);
  try {
    return await store.transaction(async tx => {
      await tx.lockWrites();
      await requireCommerciallyEmpty(tx);
      await tx.db.run(`DELETE FROM ${tx.t('job_runs')}`);
      await tx.db.run(`DELETE FROM ${tx.t('alert_rules')}`);
      await tx.db.run(`DELETE FROM ${tx.t('business_settings')}`);
      await tx.db.run(`UPDATE ${tx.t('settings')} SET data=?,version=? WHERE id=1`,[JSON.stringify(bundle.settings),bundle.settingsVersion]);
      for (const row of bundle.records) await insertRow(tx,'records',row);
      for (const row of bundle.orders) await insertRow(tx,'orders',row);
      for (const [table,definition] of Object.entries(CORE_BACKUP_TABLES)) for (const row of dependencyOrderedRows(table,bundle.core[table],definition)) await insertRow(tx,table,row);
      const localUsers = new Set((await tx.db.all(`SELECT id FROM ${tx.t('users')}`)).map(row => row.id));
      for (const [table,definition] of Object.entries(COMMERCIAL_TABLES)) {
        for (const source of dependencyOrderedRows(table,bundle.business[table],definition)) {
          let row = source;
          if (table === 'people') {
            const data = JSON.parse(row.data);
            if (data.userId && !localUsers.has(data.userId)) row = {...row,data:JSON.stringify({...data,userId:null})};
          }
          await insertRow(tx,table,row);
        }
      }
      for (const counter of bundle.counters) await tx.db.run(`INSERT INTO ${tx.t('counters')}(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,[counter.id,counter.value]);
      if (bundle.legacy) await initializeBusinessDefaults(tx);
      for (const intent of bundle.pendingJobs) {
        const {key,...data} = intent;
        await queueJobTx(tx,key,data);
      }
      return {records:bundle.records.length,orders:bundle.orders.length,businessRows:Object.values(bundle.business).reduce((total,rows) => total+rows.length,0),pendingJobs:bundle.pendingJobs.length};
    });
  } catch (error) {
    if (error.code === '23503' || error.code === '23505' || error.code === '23514' || error.code === '23502' || /(?:FOREIGN KEY|UNIQUE|CHECK|NOT NULL) constraint failed/.test(error.message)) fail('El respaldo contiene relaciones o valores comerciales incoherentes.');
    throw error;
  }
}
