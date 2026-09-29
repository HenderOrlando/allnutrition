import './env.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
import { importData } from '../lib/import.mjs';
let target,source;
try {
 const args=process.argv.slice(2),isSQLite=args[0]==='--sqlite',filename=isSQLite?args[1]:args[0];
 if(!filename||!existsSync(filename))throw new Error('Uso: npm run db:import -- respaldo.json | npm run db:import -- --sqlite archivo.sqlite');
 let bundle;
 if(isSQLite){source=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:resolve(filename)});bundle=await source.exportData();}
 else bundle=JSON.parse(readFileSync(filename,'utf8'));
 target=await openStore();const result=await importData(target,bundle);console.log(`Importados ${result.records} contenidos y ${result.orders} pedidos. Revisa todo y vuelve a aprobar la publicación. Crea o conserva las cuentas del destino.`);
}catch(error){console.error(error.message);process.exitCode=1;}finally{await source?.close();await target?.close();}
