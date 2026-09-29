import { mkdirSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../../lib/db/index.mjs';
import { createAdmin } from '../../lib/auth.mjs';
import { seed } from '../../lib/seed.mjs';
export default async function setup(){
 mkdirSync('.test-data',{recursive:true});
 const file=resolve('.test-data/e2e.sqlite');for(const suffix of ['','-wal','-shm'])rmSync(file+suffix,{force:true});
 const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:file});
 try{await createAdmin(store,'e2e@example.test','clave-e2e-solo-pruebas');await seed(store);}finally{await store.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await setup();
