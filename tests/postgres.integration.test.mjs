import test from 'node:test';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { runContracts } from './contract.mjs';
const url=process.env.TEST_DATABASE_URL;
test('Contrato completo con PostgreSQL real (base descartable)',{skip:!url},async t=>{
 if(process.env.TEST_ALLOW_DATABASE_RESET!=='allnutrition_test'||new URL(url).pathname!=='/allnutrition_test')throw new Error('Usa exclusivamente una base descartable allnutrition_test y TEST_ALLOW_DATABASE_RESET=allnutrition_test.');
 const env={DB_DRIVER:'supabase',DATABASE_URL:url,DB_SSL:process.env.TEST_DB_SSL||'disable'};
 const first=await openStore(env,{migrate:true});try{await first.db.exec(readFileSync(new URL('../db/supabase.sql',import.meta.url),'utf8'));}finally{await first.close();}
 await runContracts(t,async()=>{
  const store=await openStore(env);
  await store.db.exec('TRUNCATE allnutrition.order_audit,allnutrition.order_events,allnutrition.idempotency,allnutrition.orders,allnutrition.records,allnutrition.sessions,allnutrition.users,allnutrition.attempts,allnutrition.settings;');
  await store.db.run(`UPDATE ${store.t('counters')} SET value=0`);await store.initialize();return store;
 });
});
