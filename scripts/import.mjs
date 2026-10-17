import './env.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { importData } from '../lib/import.mjs';
import { exportReadonlySQLite } from '../lib/sqlite-restore.mjs';
let target;
try {
 const args=process.argv.slice(2),isSQLite=args[0]==='--sqlite',filename=isSQLite?args[1]:args[0];
 if(!filename||!existsSync(filename))throw new Error('Uso: npm run db:import -- respaldo.json | npm run db:import -- --sqlite archivo.sqlite');
 let bundle;
 if(isSQLite)bundle=await exportReadonlySQLite(filename);
 else bundle=JSON.parse(readFileSync(filename,'utf8'));
 target=await openStore();const result=await importData(target,bundle);console.log(`Importados ${result.records} contenidos, ${result.orders} pedidos y ${result.businessRows} filas comerciales. Revisa todo y vuelve a aprobar la publicación. Conserva las cuentas de acceso del destino; las imágenes se restauran por separado.`);
}catch(error){console.error(error.message);process.exitCode=1;}finally{await target?.close();}
