import './env.mjs';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
let store;
try {store=await openStore();await createAdmin(store,process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD,{reset:!process.argv.includes('--add')});console.log('Cuenta actualizada. Un cambio de contraseña revoca sus sesiones.');}
catch(error){console.error(error.message);process.exitCode=1;}finally{await store?.close();}
