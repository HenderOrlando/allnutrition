import './env.mjs';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { databaseConfig } from '../lib/db/config.mjs';

async function provisionAppRole(db, password) {
  const role = 'allnutrition_app';
  const existing = await db.get('SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=?', [role]);
  if (existing) {
    const ownership = await db.get(`SELECT
      EXISTS(SELECT 1 FROM pg_database WHERE datdba=?) AS database_owner,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=?) AS schema_owner,
      EXISTS(SELECT 1 FROM pg_class WHERE relowner=?) AS relation_owner,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=?) AS memberships,
      has_database_privilege(?, current_database(), 'CREATE') AS database_create,
      has_schema_privilege(?, 'allnutrition', 'CREATE') AS schema_create`, [existing.oid, existing.oid, existing.oid, existing.oid, role, role]);
    if (!existing.rolcanlogin || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'].some(flag => existing[flag]) || Object.values(ownership).some(Boolean)) {
      throw new Error('allnutrition_app tiene privilegios, ownership o membresías incompatibles. No se alteró su contraseña ni se revocaron permisos silenciosamente.');
    }
  } else {
    const { sql } = await db.get("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', ?::text, ?::text) AS sql", [role, password]);
    await db.exec(sql);
  }
  const { sql } = await db.get("SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ?::text) AS sql", [role]);
  await db.exec(sql);
  await db.exec(`GRANT USAGE ON SCHEMA allnutrition TO allnutrition_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA allnutrition TO allnutrition_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA allnutrition GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO allnutrition_app;`);
}

let store;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--provision-app-role') || args.length > 1) throw new Error('Uso: npm run db:migrate -- [--provision-app-role]');
  const provision = args.includes('--provision-app-role');
  const env = { ...process.env };
  if (provision && (databaseConfig(env).provider !== 'supabase' || !env.DB_APP_PASSWORD?.trim())) throw new Error('--provision-app-role requiere PostgreSQL y DB_APP_PASSWORD no vacía.');
  if (env.DATABASE_DIRECT_URL) { env.DATABASE_URL = env.DATABASE_DIRECT_URL; delete env.SUPABASE_DATABASE_URL; }
  store = await openStore(env, { migrate: true });
  if (store.provider === 'supabase') await store.db.exec(readFileSync(new URL('../db/supabase.sql', import.meta.url), 'utf8'));
  await store.initialize();
  const provider = store.provider;
  if (provision) {
    const migrated = await store.db.get('SELECT current_database() AS name');
    await provisionAppRole(store.db, env.DB_APP_PASSWORD);
    await store.close();
    store = null;
    store = await openStore(process.env);
    const runtime = await store.db.get('SELECT current_user AS role, current_database() AS name');
    if (runtime.role !== 'allnutrition_app' || runtime.name !== migrated.name) throw new Error('DATABASE_URL debe abrir la base migrada con el rol limitado allnutrition_app.');
  }
  console.log(`Migración v2 completada en ${provider}${provision ? ' y conexión runtime limitada verificada' : ''}. No se borraron registros.`);
} catch (error) {
  const message = process.env.DB_APP_PASSWORD ? error.message.replaceAll(process.env.DB_APP_PASSWORD, '[redactado]') : error.message;
  console.error(`No se completó la migración: ${message}`);
  process.exitCode = 1;
} finally { await store?.close(); }
