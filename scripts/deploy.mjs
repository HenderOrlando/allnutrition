import './env.mjs';
import { spawnSync } from 'node:child_process';
import { databaseConfig } from '../lib/db/config.mjs';
try {
 if(databaseConfig().provider!=='supabase')throw new Error('El deploy a Vercel requiere Supabase. Configura primero DATABASE_URL en .env local y en el proyecto de Vercel.');
 console.log('La CLI pedirá tu acceso a Vercel. La migración y las variables remotas deben estar configuradas antes de publicar.');
 console.log('Este comando no envía automáticamente tu .env a Vercel.');
 const result=spawnSync(process.platform==='win32'?'npx.cmd':'npx',['vercel',...process.argv.slice(2)],{stdio:'inherit'});process.exitCode=result.status??1;
}catch(error){console.error(error.message);process.exitCode=1;}
