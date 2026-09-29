import './env.mjs';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
let store;
try {
 const env={...process.env};
 if(env.DATABASE_DIRECT_URL){env.DATABASE_URL=env.DATABASE_DIRECT_URL;delete env.SUPABASE_DATABASE_URL;}
 store=await openStore(env,{migrate:true});
 if(store.provider==='supabase')await store.db.exec(readFileSync(new URL('../db/supabase.sql',import.meta.url),'utf8'));
 await store.initialize();console.log(`Migración v2 completada en ${store.provider}. No se borraron registros.`);
}catch(error){console.error(`No se completó la migración: ${error.message}`);process.exitCode=1;}finally{await store?.close();}
