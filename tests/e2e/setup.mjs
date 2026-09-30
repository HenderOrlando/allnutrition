import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../../lib/db/index.mjs';
import { createAdmin } from '../../lib/auth.mjs';
import { seed } from '../../lib/seed.mjs';
import { testDatabaseEnv, resetPostgresStore } from '../postgres-fixture.mjs';
export default async function setup(){
 const env=testDatabaseEnv();
 const store=await openStore(env,{migrate:true});
 try {
  await resetPostgresStore(store);
  await createAdmin(store,'e2e@example.test','clave-e2e-solo-pruebas');
  await seed(store);
 } finally { await store.close(); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await setup();
