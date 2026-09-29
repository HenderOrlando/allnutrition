import './env.mjs';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { seed } from '../lib/seed.mjs';
let store;
try {
  if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)throw new Error('Completa ADMIN_EMAIL y ADMIN_PASSWORD en .env local. No los publiques.');
  store=await openStore();
  const exists=await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`,[process.env.ADMIN_EMAIL.trim().toLowerCase()]);
  if(!exists)await createAdmin(store,process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD);
  const created=await seed(store);
  console.log(`Base ${store.provider}: administrador listo. ${created?'Material inicial cargado para revisión.':'Contenido existente conservado.'}`);
  console.log('La página pública no muestra el catálogo hasta aprobarlo. El administrador lo ve en /?preview=1.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{await store?.close();}
