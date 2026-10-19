import test from 'node:test';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { runContracts } from './contract.mjs';
import { testDatabaseEnv, resetPostgresStore } from './postgres-fixture.mjs';
import { migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5 } from '../lib/db/migrations.mjs';
import { runBusinessContracts } from './business-contract.mjs';
import { createCommercialBackupScenario,restoreCommercialBackupScenario,assertInvalidBackupsAtomic,assertLegacyPartialRestore } from './backup-contract.mjs';
import { runImportCancellationContracts } from './business-import-cancellation-contract.mjs';
const url=process.env.TEST_DATABASE_URL;
test('Contrato completo con PostgreSQL real (base descartable)',{skip:!url},async t=>{
 const env=testDatabaseEnv();
 const first=await openStore(env,{migrate:true});try{await first.db.exec(readFileSync(new URL('../db/supabase.sql',import.meta.url),'utf8'));await first.initialize();await migrateBusinessV3(first);await migrateInventoryV4(first);await migrateImportCancellationV5(first);}finally{await first.close();}
 const factory=async()=>{
  const store=await openStore(env);
  try { await resetPostgresStore(store); return store; }
  catch (error) { await store.close(); throw error; }
 };
 await runContracts(t,factory);await runBusinessContracts(t,factory);
 await runImportCancellationContracts(t,factory);
 await t.test('restaura negocio SQLite en PostgreSQL y reanuda trabajo con el actor original',async()=>{
  const source=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  let target;
  try{const scenario=await createCommercialBackupScenario(source);target=await factory();await restoreCommercialBackupScenario(target,scenario);}
  finally{await source.close();await target?.close();}
 });
 await t.test('restaura negocio PostgreSQL en SQLite sin secretos ni diferencias monetarias',async()=>{
  const source=await factory(),target=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try{await restoreCommercialBackupScenario(target,await createCommercialBackupScenario(source));}
  finally{await source.close();await target.close();}
 });
 await t.test('respaldo inválido revierte configuración y negocio completos en PostgreSQL',async()=>{
  const source=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  let target;
  try{const scenario=await createCommercialBackupScenario(source);target=await factory();await assertInvalidBackupsAtomic(target,scenario.bundle);}
  finally{await source.close();await target?.close();}
 });
 await t.test('restauración histórica en PostgreSQL conserva abono de 20000 COP sin inventar caja',async()=>{
  const target=await factory();
  try{await assertLegacyPartialRestore(target);}finally{await target.close();}
 });
});
