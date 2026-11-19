import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ensure = (value, error) => { if (!value) throw new Error(error); };
const versionSQL = 'SELECT max(version) FROM allnutrition.migrations';
const paths = ['product-images', 'social-media', 'integration-secrets', 'social-browser-control'];
const schemaCheck = `SELECT count(*)=0 FROM pg_constraint WHERE connamespace='allnutrition'::regnamespace AND NOT convalidated`;
const flag = /^[a-f0-9]{40}$/;
const { token, digest, base, manifest } = JSON.parse(Buffer.from(process.argv[1], 'base64url'));
ensure(flag.test(token) && /^[a-f0-9]{64}$/.test(digest), 'Identificador de ensayo inválido.');
ensure(process.platform === 'linux' && process.arch === 'x64' && process.getuid() === 0 && !process.env.ALLNUTRITION_PRODUCTION_HOST, 'Ensayo requiere Linux amd64 separado con custodia de permisos.');
const name = `allnutrition-recovery-${token.slice(0, 16)}`;
const database = `${name}-db`, network = `${name}-isolated`, volume = `${name}-data`;
const root = mkdtempSync(join(tmpdir(), `${name}-`));
process.umask(0o077);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
let ownsNetwork = false, ownsVolume = false, ownsDb = false;
const tracked = [];
function cmd(program, args, message, { input, stdin = input === undefined ? 'ignore' : 'pipe', timeout = 120_000, optional = false, stdout = 'pipe' } = {}) {
  const result = spawnSync(program, args, { input, encoding: 'utf8', cwd: root, env, stdio: [stdin, stdout, 'ignore'], timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 && optional) return null;
  ensure(result.status === 0, `${message}: ${result.error?.code ?? result.status ?? result.signal}.`);
  return result.stdout;
}
const docker = (args, options) => cmd('docker', args, `Ensayo Docker ${args[0]}`, options);
function psql(sql, optional = false) {
  return docker(['exec', database, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'allnutrition_test', '-c', sql], { optional })?.trim();
}
const mount = (host, container, ro = true) => `${host}:${container}${ro ? ':ro' : ''}`;
const labels = ['--label', `allnutrition.recovery=${token}`];
const localImage = ref => {
  ensure(/^sha256:[a-f0-9]{64}$/.test(ref) && docker(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', ref]).trim() === `${ref} linux amd64`, 'El clon no tiene la imagen exacta aceptada.');
  return ref;
};
const dataFingerprint = names => Object.fromEntries(names.map(table => {
  ensure(/^[a-z][a-z0-9_]*$/.test(table), 'Nombre de tabla no esperado en ensayo.');
  const digest = cmd('bash', ['-o', 'pipefail', '-c', `docker exec "$1" psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d allnutrition_test -c "$2" | sha256sum`, 'bash', database,
    `COPY (SELECT row_to_json(entry)::text COLLATE "C" FROM allnutrition."${table}" entry ORDER BY 1) TO STDOUT`], `Integridad de hechos en ${table}`, { timeout: 420_000 }).split(' ')[0];
  return [table, digest];
}));
const tables = () => psql("SELECT tablename FROM pg_tables WHERE schemaname='allnutrition' AND tablename<>'migrations' ORDER BY tablename").split('\n');
const runtimeScript = `
import { openStore } from './lib/db/index.mjs';
const version = Number(process.argv[2]);
const store = await openStore();
try {
  const facts = await store.db.readSnapshot(async db => ({
    marker: (await db.get('SELECT MAX(version) AS v FROM allnutrition.migrations')).v,
    role: (await db.get(\"SELECT current_user='allnutrition_app' AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR has_schema_privilege(current_user,'allnutrition','CREATE')) AS ok FROM pg_roles WHERE rolname=current_user\")).ok,
    tls: (await db.get('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).ssl,
    heka: (await db.get(\"SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='allnutrition' AND c.relname IN ('heka_api_settings','heka_api_mutations','heka_api_order_links') AND c.relkind='r' AND NOT EXISTS (SELECT FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE NOT has_table_privilege(c.oid,p))\")).count
  }));
  if (facts.marker!==version || !facts.role || !facts.tls || (version>=15 && facts.heka!==3)) throw new Error('Integridad de versión, rol, TLS o Heka');
} finally { await store.close(); }
`;
let failure, proof;
try {
  const archive = join(root, 'capture.tar');
  const fd = openSync(archive, 'wx', 0o600);
  try { cmd('cat', [], 'Recepción de copia ensayada', { stdin: 'inherit', stdout: fd, timeout: 600_000 }); }
  finally { closeSync(fd); }
  ensure(cmd('sha256sum', [archive], 'Hash de copia').startsWith(`${digest} `), 'Copia recibida distinta a la evidencia cifrada.');
  cmd('tar', ['--no-same-owner', '-xf', archive, './production.dump', './media.tar', './snapshot.json', './deploy/pg_hba.conf', './deploy/postgres-entrypoint.sh'], 'Extracción selectiva de copia');
  rmSync(archive);
  const snapshot = JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8'));
  for (const [service, ref] of Object.entries(base.services)) ensure(snapshot.containers[service].imageId === ref.imageId, 'Copia se tomó con otro conjunto de imágenes.');
  ensure(snapshot.schema.version === base.schemaVersion && JSON.stringify(Object.entries(snapshot.configHashes).sort()) === JSON.stringify(Object.entries(base.configHashes).sort()), 'Inventario de copia de ensayo no coincide.');
  const media = join(root, 'media'), tls = join(root, 'tls');
  mkdirSync(media, { mode: 0o700 }); mkdirSync(tls, { mode: 0o700 });
  const mediaArchive = join(root, 'media.tar');
  const beforeMedia = cmd('sha256sum', [mediaArchive], 'Hash de medios').split(' ')[0];
  const members = cmd('tar', ['-tf', mediaArchive], 'Catálogo privado de medios').split('\n').filter(Boolean);
  ensure(members.length && members.every(path => paths.includes(path.split('/')[0]) && !path.split('/').includes('..')), 'Copia de medios trae rutas ajenas.');
  cmd('tar', ['--same-owner', '--same-permissions', '-xf', mediaArchive, '-C', media], 'Restauración privada de medios', { timeout: 600_000 });
  cmd('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '2', '-subj', '/CN=db', '-addext', 'subjectAltName=DNS:db', '-keyout', join(tls, 'server.key'), '-out', join(tls, 'server.crt')], 'CA sintética de ensayo');
  cmd('chmod', ['644', join(tls, 'server.crt')], 'Permiso CA pública de ensayo');
  const admin = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
  const dbEnv = join(root, 'db.env'), appEnv = join(root, 'app.env');
  writeFileSync(dbEnv, `POSTGRES_DB=allnutrition_test\nPOSTGRES_PASSWORD=${admin}\n`, { mode: 0o600 });
  writeFileSync(appEnv, `DB_DRIVER=supabase\nNODE_ENV=production\nDB_SSL=verify\nDB_CA_CERT_FILE=/run/db-ca/ca.crt\nAPP_URL=https://localhost\nDATABASE_URL=postgresql://allnutrition_app:${password}@db:5432/allnutrition_test\nDATABASE_DIRECT_URL=postgresql://postgres:${admin}@db:5432/allnutrition_test\nDB_APP_PASSWORD=${password}\nINTEGRATION_SECRETS_DIR=/app/data/integration-secrets\nSOCIAL_BROWSER_CONTROL_DIR=/app/data/social-browser-control\nSOCIAL_MEDIA_DIR=/app/data/social-media\n`, { mode: 0o600 });
  docker(['network', 'create', ...labels, '--internal', network]); ownsNetwork = true;
  ensure(docker(['network', 'inspect', '-f', '{{.Internal}}', network]).trim() === 'true', 'Red de recuperación no está aislada.');
  // The clone is disposable. Keep PostgreSQL's durability settings, but isolate its I/O from the builder's shared disk.
  const pgDataMiB = 4096;
  const availableKiB = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]);
  ensure(availableKiB >= (pgDataMiB + 4096) * 1024, 'Memoria insuficiente para el volumen privado de recuperación.');
  docker(['volume', 'create', ...labels, '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
    '--opt', `o=size=${pgDataMiB}m,noswap,nodev,nosuid,noexec`, volume]); ownsVolume = true;
  docker(['run', '-d', '--name', database, ...labels, '--pull', 'never', '--network', network, '--network-alias', 'db', '--env-file', dbEnv,
    '-v', mount(tls, '/run/postgres-tls'), '-v', mount(join(root, 'deploy/pg_hba.conf'), '/etc/postgresql/pg_hba.conf'),
    '-v', mount(join(root, 'deploy/postgres-entrypoint.sh'), '/etc/postgresql/entrypoint'), '-v', mount(volume, '/var/lib/postgresql/data', false),
    '--entrypoint', '/bin/sh', localImage(base.services.db.imageId), '/etc/postgresql/entrypoint', 'postgres', '-c', 'ssl=on',
    '-c', 'ssl_cert_file=/var/lib/postgresql/tls/server.crt', '-c', 'ssl_key_file=/var/lib/postgresql/tls/server.key', '-c', 'hba_file=/etc/postgresql/pg_hba.conf']); ownsDb = true;
  const until = Date.now() + 60_000;
  while (!docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'allnutrition_test'], { optional: true })) {
    ensure(Date.now() < until, 'PostgreSQL del clon no inició.'); await delay(1000);
  }
  // Role creation uses stdin; synthetic passwords never enter command-line arguments or output.
  docker(['exec', '-i', database, 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'allnutrition_test'], {
    input: `CREATE ROLE allnutrition_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}';\n`
  });
  const dump = openSync(join(root, 'production.dump'), 'r');
  try { docker(['exec', '-i', database, 'pg_restore', '--exit-on-error', '--single-transaction', '-U', 'postgres', '-d', 'allnutrition_test'], { stdin: dump, timeout: 600_000 }); }
  finally { closeSync(dump); }
  ensure(Number(psql(versionSQL)) === base.schemaVersion && psql(schemaCheck) === 't', 'Restauración inicial no conserva esquema/FK.');
  const names = tables(), baseline = dataFingerprint(names);
  const common = [...labels, '--pull', 'never', '--network', network, '--env-file', appEnv, '-v', mount(join(tls, 'server.crt'), '/run/db-ca/ca.crt')];
  for (const path of paths) common.push('-v', mount(join(media, path), `/app/data/${path}`));
  function app(service, ref, entry, args, input) {
    const n = `${name}-${service}`;
    tracked.push(n);
    return docker(['run', '--rm', '-i', '--name', n, ...common, '--entrypoint', entry, localImage(ref), ...args], { input, timeout: 600_000 });
  }
  const candidate = manifest.services.web.imageId;
  for (const round of [1, 2]) {
    app(`migration-${round}`, candidate, 'npm', ['run', 'db:migrate', '--', '--provision-app-role']);
    ensure(Number(psql(versionSQL)) === manifest.schemaVersion && psql(schemaCheck) === 't', `Migración ${round} difiere del marcador/las FK esperadas.`);
    ensure(JSON.stringify(dataFingerprint(names)) === JSON.stringify(baseline), `Migración ${round} altera hechos previos.`);
    app(`runtime-${round}`, candidate, 'node', ['--input-type=module', '-', '--', String(manifest.schemaVersion)], runtimeScript.replace('process.argv[2]', 'process.argv.at(-1)'));
  }
  // Check the former write-capable cohorts without running schedulers or emitting provider traffic.
  const compatible = {};
  for (const service of ['web', 'scheduler', 'social-browser-worker']) {
    try {
      app(`previous-${service}`, base.services[service].imageId, 'node', ['--input-type=module', '-', '--', String(manifest.schemaVersion)], runtimeScript.replace('process.argv[2]', 'process.argv.at(-1)'));
      compatible[service] = true;
    } catch { compatible[service] = false; }
  }
  const fileProof = cmd('tar', ['-df', mediaArchive, '-C', media], 'Comparación de permisos y bytes de medios', { optional: true, timeout: 600_000 });
  ensure(fileProof !== null && cmd('sha256sum', [mediaArchive], 'Hash final de medios').startsWith(`${beforeMedia} `), 'Medios o custodia cambiaron durante el ensayo.');
  const roles = psql("SELECT NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AND rolcanlogin FROM pg_roles WHERE rolname='allnutrition_app'");
  ensure(roles === 't', 'Restauración no conserva una cuenta limitada.');
  proof = { accepted: true, baseVersion: base.schemaVersion, schemaVersion: manifest.schemaVersion, candidateImage: candidate, archiveSha256: digest,
    restoredTables: names.length, migrationRuns: 2, previousRuntimeReads: compatible, mediaSha256: beforeMedia };
} catch (error) { failure = error; }
finally {
  try {
    for (const id of tracked) {
      const owner = docker(['container', 'inspect', '-f', '{{index .Config.Labels "allnutrition.recovery"}}', id], { optional: true });
      if (owner?.trim() === token) docker(['container', 'rm', '-f', id]);
    }
    if (ownsDb) docker(['container', 'rm', '-f', database]);
    if (ownsVolume) docker(['volume', 'rm', volume]);
    if (ownsNetwork) docker(['network', 'rm', network]);
  } catch (error) { failure ??= error; }
  rmSync(root, { recursive: true, force: true });
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
else console.log(JSON.stringify(proof));
