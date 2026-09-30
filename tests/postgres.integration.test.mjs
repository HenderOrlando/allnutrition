import test from 'node:test';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { runContracts } from './contract.mjs';
import { testDatabaseEnv, resetPostgresStore } from './postgres-fixture.mjs';
const url=process.env.TEST_DATABASE_URL;
test('Contrato completo con PostgreSQL real (base descartable)',{skip:!url},async t=>{
 const env=testDatabaseEnv();
 const first=await openStore(env,{migrate:true});try{await first.db.exec(readFileSync(new URL('../db/supabase.sql',import.meta.url),'utf8'));}finally{await first.close();}
 await runContracts(t,async()=>{
  const store=await openStore(env);
  try { await resetPostgresStore(store); return store; }
  catch (error) { await store.close(); throw error; }
 });
});
