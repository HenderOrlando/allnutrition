import './env.mjs';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
let store;
try {
 store=await openStore();mkdirSync('backups',{recursive:true,mode:0o700});
 const destination=resolve('backups',`allnutrition-${new Date().toISOString().replaceAll(':','-')}.json`);
 writeFileSync(destination,JSON.stringify(await store.exportData(),null,2),{mode:0o600});
 console.log(`Respaldo comercial creado: ${destination}. Contiene datos privados. No incluye cuentas ni sesiones.`);
 if(store.provider==='sqlite'&&process.argv.includes('--full-sqlite')) {
  const {backup}=await import('node:sqlite');const full=destination.replace('.json','.sqlite');await backup(store.db.native,full);if(process.platform!=='win32')chmodSync(full,0o600);console.log(`Copia completa SQLite creada: ${full}. Incluye cuentas y sesiones; protégela.`);
 }
}catch(error){console.error(error.message);process.exitCode=1;}finally{await store?.close();}
