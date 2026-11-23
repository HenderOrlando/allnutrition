import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const serviceOrder = ['db', 'social-browser', 'web', 'scheduler', 'social-browser-worker'];
export const writers = ['web', 'scheduler', 'social-browser-worker'];
export const activeFiles = ['compose.yaml', 'compose.nginx.yaml', 'deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh', 'deploy/social-browser-seccomp.json'];
const writableFiles = ['compose.yaml', 'compose.nginx.yaml', 'deploy/social-browser-seccomp.json'];
export const sha = /^[a-f0-9]{40}$/;
export const hash = /^[a-f0-9]{64}$/;
export const imageId = /^sha256:[a-f0-9]{64}$/;
const releaseTag = /^allnutrition(?:-social-browser)?:release-[a-f0-9]{12}$/;
const project = 'allnutrition-production';
export const appRoot = '/home/allnutrition/app';
export const stateRoot = '/home/allnutrition/.local/state/allnutrition-deploy';
const currentPath = join(stateRoot, 'current.json');
const originalEnv = join(appRoot, '.env.server.local');
const pinPath = join(appRoot, '.env.release.local');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
const pins = { web: 'APP_IMAGE', scheduler: 'SCHEDULER_IMAGE', 'social-browser-worker': 'SOCIAL_BROWSER_WORKER_IMAGE', 'social-browser': 'SOCIAL_BROWSER_IMAGE' };
const media = ['/app/data/product-images', '/app/data/social-media', '/app/data/integration-secrets', '/app/data/social-browser-control'];
const dbTables = ['heka_api_settings', 'heka_api_mutations', 'heka_api_order_links'];

export function requireThat(test, message) { if (!test) throw new Error(message); }
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export function privateJSON(path, value) { replace(path, `${JSON.stringify(value, null, 2)}\n`, 0o600); }
function replace(path, data, mode) {
  const temp = `${path}.${randomBytes(8).toString('hex')}`;
  try { writeFileSync(temp, data, { mode, flag: 'wx', flush: true }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

export function publicState(input) {
  requireThat(input?.format === 1 && sha.test(input.coveredThrough) && sha.test(input.configCommit) && Number.isSafeInteger(input.schemaVersion) && input.schemaVersion > 0, 'Manifiesto de producción inválido.');
  requireThat(same(Object.keys(input.services ?? {}).sort(), [...serviceOrder].sort()) && same(Object.keys(input.configHashes ?? {}).sort(), [...activeFiles].sort()), 'Servicios o configuración activa incompletos.');
  const services = {};
  for (const service of serviceOrder) {
    const { sourceCommit, imageTag, imageId: id } = input.services[service];
    const tagged = service === 'db' ? /^postgres:16-bookworm$/.test(imageTag) : releaseTag.test(imageTag) && imageTag.endsWith(`-${String(id).slice(7, 19)}`) && imageTag.startsWith(service === 'social-browser' ? 'allnutrition-social-browser:' : 'allnutrition:');
    requireThat((sha.test(sourceCommit) || sourceCommit === null) && imageId.test(id) && tagged, `Procedencia inválida: ${service}.`);
    services[service] = { sourceCommit, imageTag, imageId: id };
  }
  const configHashes = Object.fromEntries(activeFiles.map(file => {
    requireThat(hash.test(input.configHashes[file]), `Hash de producción inválido: ${file}.`);
    return [file, input.configHashes[file]];
  }));
  return { format: 1, coveredThrough: input.coveredThrough, services, configCommit: input.configCommit, configHashes, schemaVersion: input.schemaVersion };
}

function command(program, args, label, { input, stdin = input === undefined ? 'ignore' : 'pipe', stdout = 'pipe', optional = false, timeout = 180_000 } = {}) {
  const result = spawnSync(program, args, { cwd: appRoot, env, encoding: 'utf8', input, stdio: [stdin, stdout, 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout });
  if (optional && result.status !== 0) return null;
  requireThat(result.status === 0, `${label}: ${result.error?.code ?? `salida ${result.status ?? result.signal}`}.`);
  return result.stdout;
}
const docker = (args, opts) => command('docker', args, 'Docker ' + args.slice(0, 2).join(' '), opts);
function compose(args, { root = appRoot, selector = pinPath, override, ...opts } = {}) {
  const flags = ['compose', '-p', project, '--project-directory', appRoot, '--env-file', originalEnv];
  if (existsSync(selector)) flags.push('--env-file', selector);
  for (const file of activeFiles.slice(0, 2)) flags.push('-f', join(root, file));
  if (override) flags.push('-f', override);
  return docker([...flags, ...args], opts);
}
function config(options) {
  compose(['config', '--quiet'], options);
  const config = JSON.parse(compose(['--profile', '*', 'config', '--format', 'json'], options));
  const services = config.services;
  for (const service of [...serviceOrder, 'migrate']) {
    requireThat(services[service], `Servicio ausente en Compose: ${service}.`);
    for (const volume of services[service].volumes ?? []) {
      if (volume.type === 'bind') requireThat(existsSync(volume.source), `Mount ausente: ${service}:${volume.target}.`);
    }
  }
  return config;
}
function publicHashes(root = appRoot) {
  return Object.fromEntries(activeFiles.map(file => {
    const path = join(root, file);
    requireThat(lstatSync(path).isFile(), `Configuración pública no es un archivo regular: ${file}.`);
    return [file, sha256(readFileSync(path))];
  }));
}
function containers() {
  return Object.fromEntries(serviceOrder.map(service => {
    const result = docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`]).trim();
    requireThat(hash.test(result), `Se esperaba un único contenedor: ${service}.`);
    const format = '{"id":{{json .Id}},"imageId":{{json .Image}},"imageTag":{{json .Config.Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';
    const { mounts, ...entry } = JSON.parse(docker(['container', 'inspect', '--format', format, result]));
    image(entry.imageId);
    return [service, { ...entry, mounts: mounts.map(({ Type, Name, Destination, RW }) => ({ type: Type, name: Name ?? null, destination: Destination, writable: RW })) }];
  }));
}
function image(ref, optional = false) {
  const output = docker(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}} {{.Size}} {{json .Descriptor}}', ref], { optional });
  if (output === null) return null;
  const [id, os, architecture, size, ...descriptor] = output.trim().split(' ');
  requireThat(imageId.test(id) && os === 'linux' && architecture === 'amd64' && Number.isSafeInteger(Number(size)), 'Imagen no es Linux amd64.');
  return { id, size: Number(size), descriptor: JSON.parse(descriptor.join(' '))?.digest };
}
const databaseCode = `
import { openPostgres } from './lib/db/postgres.mjs';
import { databaseConfig } from './lib/db/config.mjs';
const db = await openPostgres(databaseConfig());
try {
  console.log(JSON.stringify(await db.readSnapshot(async tx => {
    const schema = await tx.get('SELECT max(version) AS version, bool_or(version=15) AS heka FROM allnutrition.migrations');
    const role = await tx.get(\`SELECT current_user='allnutrition_app' AS runtime, NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR has_schema_privilege(current_user,'allnutrition','CREATE')) AS limited FROM pg_roles WHERE rolname=current_user\`);
    const tls = await tx.get('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    const tables = (await tx.all(\`SELECT c.relname AS name, NOT EXISTS (SELECT FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE NOT has_table_privilege(c.oid,p)) AS allowed FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='allnutrition' AND c.relkind IN ('r','p') AND c.relname IN ('heka_api_settings','heka_api_mutations','heka_api_order_links') ORDER BY c.relname\`));
    const heartbeat = await tx.all(\`SELECT key,state,error_code AS "errorCode",updated_at AS "updatedAt" FROM allnutrition.job_runs WHERE key IN ('scheduler:heartbeat','scheduler:social-browser:heartbeat') ORDER BY key\`);
    const recentFailures = await tx.all(\`SELECT state,CASE WHEN error_code ~ '^[A-Z0-9_]{1,80}$' THEN error_code ELSE 'REDACTED' END AS "errorCode",updated_at AS "updatedAt" FROM allnutrition.job_runs WHERE state='failed' AND updated_at>=? ORDER BY updated_at DESC LIMIT 50\`,[new Date(Date.now()-7*86400_000).toISOString()]);
    return { ...schema, ...role, ...tls, tables, heartbeat, recentFailures };
  })));
} finally { await db.close(); }
`;
function database(containers, stoppedImage) {
  const args = ['node', '--input-type=module', '-'];
  const output = stoppedImage ? compose(['run', '-T', '--rm', '--no-deps', '--pull', 'never', '--entrypoint', 'node', 'web', ...args.slice(1)], { input: databaseCode })
    : docker(['exec', '-i', containers.web.id, ...args], { input: databaseCode });
  const db = JSON.parse(output);
  requireThat(db.runtime && db.limited && db.ssl && Number.isSafeInteger(db.version), 'PostgreSQL runtime no acredita TLS, rol limitado o esquema.');
  requireThat(db.version < 15 ? !db.heka && db.tables.length === 0 : db.heka && same(db.tables.map(t => t.name).sort(), [...dbTables].sort()) && db.tables.every(t => t.allowed), 'Marcador, tablas o permisos Heka incoherentes.');
  return db;
}
function verifyCompiledRoutes(container) {
  const routes = ['/api/admin/shipping/heka/route', '/api/admin/social/oauth/callback/route', '/api/admin/social/oauth/complete/route', '/api/admin/social/campaigns/[id]/actions/route'];
  const source = 'const paths=require("./.next/server/app-paths-manifest.json");if(!JSON.parse(process.argv[1]).every(path=>typeof paths[path]==="string"))process.exit(1)';
  docker(['exec', container.id, 'node', '-e', source, JSON.stringify(routes)]);
}

function inspect() {
  const effective = config();
  const active = containers();
  return { observedAt: new Date().toISOString(), containers: active, configHashes: publicHashes(),
    effectiveImages: Object.fromEntries([...serviceOrder, 'migrate'].map(service => [service, effective.services[service].image])),
    schema: database(active), current: existsSync(currentPath) ? readJSON(currentPath) : null };
}
export function requireLive(manifest, snapshot, { strictPins = true } = {}) {
  requireThat(same(manifest.configHashes, snapshot.configHashes) && manifest.schemaVersion === snapshot.schema.version, 'Deriva de configuración pública o esquema respecto del recibo.');
  for (const service of serviceOrder) {
    const observed = snapshot.containers[service], expected = manifest.services[service];
    requireThat(observed.imageId === expected.imageId && observed.imageTag === expected.imageTag && observed.running && (observed.health === 'healthy' || observed.health === null && writers.includes(service) && service !== 'web'), `Deriva o salud inválida: ${service}.`);
    if (strictPins) requireThat(snapshot.effectiveImages[service] === expected.imageTag, `Pin efectivo inválido: ${service}.`);
  }
  if (strictPins) requireThat(snapshot.effectiveImages.migrate === manifest.services.web.imageTag, 'Pin efectivo inválido: migrate.');
  if (snapshot.current?.observed) requireThat(same(snapshot.containers.db, snapshot.current.observed?.db), 'Cambió el contenedor PostgreSQL o su inicio/mounts.');
}
export function checkRuntime(saved, requireFreshStart = []) {
  const limits = { 'scheduler:heartbeat': 'scheduler', 'scheduler:social-browser:heartbeat': 'social-browser-worker' };
  requireThat(saved.schema.heartbeat.length === 2, 'Faltan latidos de los dos workers.');
  for (const beat of saved.schema.heartbeat) {
    const service = limits[beat.key], time = Date.parse(beat.updatedAt), age = Date.now() - time;
    requireThat(service && beat.state === 'succeeded' && beat.errorCode === null && age >= 0 && age < 90_000 && (!requireFreshStart.includes(service) || time >= Date.parse(saved.containers[service].startedAt)), `Latido inválido: ${service ?? 'worker'}.`);
  }
}
export async function smoke(origin, { bootstrap = false } = {}) {
  requireThat(/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin), 'Origen HTTPS inválido.');
  const requests = [['/', 200], ['/privacy', 200], ['/api/health', 200], ['/api/admin/social/oauth/complete', 401], ['/api/admin/social/oauth/callback', 200]];
  if (!bootstrap) requests.push(['/api/admin/shipping/heka', 401]);
  return Object.fromEntries(await Promise.all(requests.map(async ([path, status]) => {
    const response = await fetch(origin + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    requireThat(response.status === status, `Humo HTTPS ${path}: HTTP ${response.status}; esperado ${status}.`);
    if (path === '/api/health') requireThat((await response.json()).ok === true, 'Humo HTTPS no acredita salud de DB.');
    else {
      if (path.endsWith('/callback')) requireThat(response.headers.get('cache-control')?.includes('no-store') && response.headers.get('content-security-policy')?.includes("default-src 'none'"), 'Documento OAuth sin CSP/no-store esperado.');
      await response.body?.cancel();
    }
    return [path, status];
  })));
}

function saveReceipt(manifest, snapshot, origin, extra) {
  const record = { manifest: publicState(manifest), observed: snapshot.containers, observedAt: snapshot.observedAt, origin, ...extra };
  privateJSON(currentPath, record);
  return record;
}
// A containerd image ID is the OCI target descriptor, not the config JSON's digest.
export function verifyImageArchive(path, images) {
  const indexTypes = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
  const manifestTypes = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
  const blob = digest => {
    requireThat(imageId.test(digest), 'Digest OCI inválido.');
    return `blobs/sha256/${digest.slice(7)}`;
  };
  const read = name => {
    const result = spawnSync('tar', ['-xOf', path, '--', name], {
      env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 * 1024 * 1024, timeout: 180_000
    });
    requireThat(result.status === 0, `Falta un metadato OCI válido: ${name}.`);
    return result.stdout;
  };
  const descriptor = entry => {
    const bytes = read(blob(entry.digest));
    requireThat(entry.size === bytes.length && `sha256:${sha256(bytes)}` === entry.digest, 'Descriptor OCI alterado.');
    return JSON.parse(bytes);
  };
  const amd64 = entry => entry?.os === 'linux' && entry.architecture === 'amd64' && !entry.variant;
  const index = JSON.parse(read('index.json'));
  const saved = JSON.parse(read('manifest.json'));
  const refs = Object.values(images);
  requireThat(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length === refs.length &&
    Array.isArray(saved) && saved.length === refs.length, 'Conjunto de imágenes OCI inesperado.');
  for (const { imageTag, imageId: id } of refs) {
    requireThat(releaseTag.test(imageTag) && imageId.test(id), 'Identidad aprobada inválida.');
    const entries = index.manifests.filter(entry => entry.annotations?.['io.containerd.image.name'] === `docker.io/library/${imageTag}`);
    const manifests = saved.filter(entry => same(entry.RepoTags, [imageTag]));
    requireThat(entries.length === 1 && entries[0].digest === id &&
      entries[0].annotations['org.opencontainers.image.ref.name'] === imageTag.split(':')[1] && manifests.length === 1,
    'El tag sellado no identifica al descriptor OCI aprobado.');
    let entry = entries[0], manifest = descriptor(entry);
    if (indexTypes.includes(entry.mediaType)) {
      requireThat(manifest.schemaVersion === 2 && Array.isArray(manifest.manifests), 'Índice OCI inválido.');
      const platform = manifest.manifests.filter(item => amd64(item.platform));
      requireThat(platform.length === 1, 'El índice OCI no identifica una única imagen linux/amd64.');
      entry = platform[0];
      manifest = descriptor(entry);
    }
    requireThat(manifestTypes.includes(entry.mediaType) && manifest.schemaVersion === 2 && Array.isArray(manifest.layers), 'Manifiesto OCI inválido.');
    const configuration = descriptor(manifest.config);
    const { Config, Layers } = manifests[0];
    const diffIds = configuration.rootfs?.diff_ids;
    requireThat(amd64(configuration) && Config === blob(manifest.config.digest) &&
      same(Layers, manifest.layers.map(layer => blob(layer.digest))) && Array.isArray(diffIds) &&
      diffIds.length === Layers.length && diffIds.every(digest => imageId.test(digest)), 'Config o capas OCI distintas al manifiesto Docker.');
  }
}

function verifiedImagePresent(ref) {
  const tagged = image(ref.imageTag, true);
  if (!tagged) return false;
  requireThat(tagged.id === ref.imageId, 'Colisión de tag inmutable.');
  const pinned = image(ref.imageId, true);
  return [tagged, pinned].every(value => value?.id === ref.imageId && value.descriptor === ref.imageId);
}

function loadImages(path, images) {
  verifyImageArchive(path, images);
  for (const ref of Object.values(images)) requireThat((image(ref.imageTag, true)?.id ?? ref.imageId) === ref.imageId, 'Colisión de tag inmutable.');
  docker(['load', '--input', path], { timeout: 1_200_000 });
  for (const ref of Object.values(images)) requireThat(verifiedImagePresent(ref), 'Descriptor OCI cargado distinto al ID aprobado.');
}
function up(services, options) {
  for (const service of serviceOrder.filter(s => services.includes(s) && s !== 'db')) {
    compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '120', service], options);
  }
}
async function verifyAfter(manifest, services, origin, previous) {
  const until = Date.now() + 95_000;
  do {
    const snapshot = inspect();
    requireLive(manifest, snapshot);
    for (const service of serviceOrder.filter(service => !services.includes(service))) {
      requireThat(snapshot.containers[service].id === previous.containers[service].id && snapshot.containers[service].startedAt === previous.containers[service].startedAt, `Se alteró un servicio ajeno al corte: ${service}.`);
    }
    verifyCompiledRoutes(snapshot.containers.web);
    try { checkRuntime(snapshot, services); await smoke(origin); return snapshot; }
    catch (error) { if (Date.now() >= until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  } while (true);
}

export const recoveryDirectory = token => {
  requireThat(/^[a-f0-9]{40}$/.test(token), 'Identificador de corte inválido.');
  return join(stateRoot, 'releases', token);
};
function capture(directory, stage, snapshot) {
  requireThat(['rehearsal', 'final'].includes(stage), 'Etapa de copia inválida.');
  const root = join(directory, stage);
  mkdirSync(root, { mode: 0o700 });
  for (const file of [originalEnv, pinPath]) if (existsSync(file)) {
    const dest = join(root, file.split('/').at(-1));
    copyFileSync(file, dest);
    chmodSync(dest, 0o600);
  }
  for (const file of activeFiles) {
    mkdirSync(join(root, file, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(join(appRoot, file), join(root, file));
  }
  privateJSON(join(root, 'snapshot.json'), snapshot);
  // Configure stdout using shell positional arguments; private values remain inside Compose.
  const write = (target, args) => command('sh', ['-ec', 'umask 077; out=$1; shift; exec "$@" > "$out"', 'sh', join(root, target), 'docker', ...args], 'Copia privada ' + target, { timeout: 600_000 });
  const flags = ['compose', '-p', project, '--project-directory', appRoot, '--env-file', originalEnv];
  if (existsSync(pinPath)) flags.push('--env-file', pinPath);
  for (const file of activeFiles.slice(0, 2)) flags.push('-f', join(appRoot, file));
  requireThat(image('postgres:16-bookworm').id === snapshot.containers.db.imageId, 'Herramienta PG no coincide con la DB activa.');
  write('production.dump', [...flags, 'run', '-T', '--rm', '--no-deps', '--pull', 'never', '--entrypoint', 'pg_dump', 'backup', '--format=custom', '--serializable-deferrable']);
  docker(['run', '--rm', '--pull', 'never', '--network', 'none', '-v', `${root}:/capture:ro`, '--entrypoint', 'pg_restore', snapshot.containers.db.imageId, '--list', '/capture/production.dump']);
  write('media.tar', ['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0', '--volumes-from', `${snapshot.containers.web.id}:ro`, '--entrypoint', 'tar', snapshot.containers.web.imageId, '-C', '/app/data', '-cf', '-', ...media.map(path => path.split('/').at(-1))]);
  const archive = join(directory, `${stage}.tar`);
  command('tar', ['-cf', archive, '-C', root, '.'], 'Archivo privado de recuperación', { timeout: 600_000 });
  chmodSync(archive, 0o600);
  const digest = command('sha256sum', [archive], 'Hash de copia privada').split(' ')[0];
  rmSync(root, { recursive: true });
  return { stage, bytes: statSync(archive).size, sha256: digest };
}

function journaled() {
  const root = join(stateRoot, 'releases');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => sha.test(name)).flatMap(name => {
    const journal = join(root, name, 'journal.json');
    if (!existsSync(journal)) return [];
    const state = readJSON(journal);
    return ['reverted', 'verified'].includes(state.stage) ? [] : [state];
  });
}
function localMarker(container) {
  const sql = "BEGIN READ ONLY; SELECT max(version) FROM allnutrition.migrations; ROLLBACK;";
  return Number(docker(['exec', container.id, 'sh', '-ec', 'exec psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -c "$1"', 'sh', sql]).trim());
}
function status() {
  const pending = journaled();
  if (!pending.length) return { ...inspect(), pending: null };
  const active = containers();
  return { observedAt: new Date().toISOString(), containers: active, schema: { version: localMarker(active.db) }, configHashes: publicHashes(),
    current: readJSON(currentPath), pending: pending.map(({ token, stage, updatedAt, error }) => ({ token, stage, updatedAt, error })) };
}
function rollback(directory, state) {
  const { oldPin, files, observed, started, migrate } = state;
  for (const file of files) {
    requireThat(writableFiles.includes(file), 'Configuración previa inválida.');
    replace(join(appRoot, file), readFileSync(join(directory, 'previous', file)), 0o644);
  }
  if (oldPin) replace(pinPath, readFileSync(join(directory, 'previous', 'selector')), 0o600);
  else rmSync(pinPath, { force: true });
  if (started) {
    const override = join(directory, 'rollback-compose.json');
    privateJSON(override, { services: Object.fromEntries(state.services.map(service => {
      const { imageTag, imageId } = observed[service];
      requireThat(image(imageTag).id === imageId, 'Imagen previa no disponible para rollback.');
      return [service, { image: imageTag }];
    })) });
    up(state.services, { override });
    rmSync(override);
  } else if (migrate) compose(['start', ...writers]);
  const restored = containers();
  for (const service of serviceOrder) {
    requireThat(restored[service].imageId === observed[service].imageId && restored[service].running, `No se restituyó la imagen previa de ${service}.`);
  }
}
async function recover(token) {
  const [state, ...others] = journaled();
  requireThat(state?.token === token && !others.length, 'No hay un intento único en espera con ese identificador.');
  const directory = recoveryDirectory(token), path = join(directory, 'journal.json');
  const active = containers(), marker = localMarker(active.db);
  const current = readJSON(currentPath);
  requireThat(same(active.db, state.observed.db), 'Cambió DB desde el inicio del corte; intervención requerida.');
  if (current.token === token) {
    const snapshot = inspect();
    requireLive(publicState(current.manifest), snapshot);
    checkRuntime(snapshot);
    verifyCompiledRoutes(snapshot.containers.web);
    await smoke(state.origin);
    privateJSON(path, { ...state, stage: 'verified' });
    return current;
  }
  if (!state.attemptedDDL) {
    requireThat(marker === state.base.schemaVersion, 'Cambió el esquema previo; recuperación automática detenida.');
    rollback(directory, state);
    privateJSON(path, { ...state, stage: 'reverted' });
    return { kind: 'rollback', token, manifest: state.base };
  }
  requireThat(marker === state.candidate.schemaVersion && same(publicHashes(), state.candidate.configHashes), 'DDL de resultado incierto o parcial. Conservar escrituras detenidas y corregir hacia adelante; no repetir DDL con este comando.');
  requireThat(!docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=migrate']).trim(), 'El contenedor de migración todavía está activo; no iniciar escritores.');
  requireThat(database(active, true).version === marker, 'El esquema no acredita el rol runtime después de DDL.');
  try {
    up(state.services);
    const snapshot = await verifyAfter(publicState(state.candidate), state.services, state.origin, { containers: state.observed });
    const record = saveReceipt(state.candidate, snapshot, state.origin, { kind: 'release', token, startedAt: state.startedAt, acceptance: state.acceptance, writesPausedAt: state.writesPausedAt });
    privateJSON(path, { ...state, stage: 'verified' });
    return record;
  } catch (error) {
    compose(['stop', '--timeout', '30', ...writers]);
    throw error;
  }
}

async function apply({ token, base, manifest, services, files, origin, rehearsal, acceptance }) {
  requireThat(journaled().length === 0, 'Hay un corte inconcluso; consultar --status y --recover antes de otro intento.');
  const directory = recoveryDirectory(token), journal = join(directory, 'journal.json');
  const previous = inspect();
  const live = publicState(previous.current?.manifest);
  requireThat(same(live, publicState(base)), 'La base en VM cambió antes del corte.');
  requireLive(live, previous, { strictPins: previous.current.kind !== 'inventory' });
  checkRuntime(previous);
  const desired = publicState(manifest);
  requireThat(desired.schemaVersion >= live.schemaVersion && services.length === new Set(services).size && services.every(service => serviceOrder.includes(service) && service !== 'db'), 'Corte incluye infraestructura o downgrade no autorizado.');
  requireThat(/^[1-9]\d*$/.test(acceptance?.runId) && /^[1-9]\d*$/.test(acceptance?.runAttempt) && /^[1-9]\d*$/.test(acceptance?.baseDeploymentId) && hash.test(acceptance?.planHash), 'Falta evidencia de aceptación nativa.');
  for (const service of serviceOrder) {
    if (!services.includes(service)) requireThat(same(desired.services[service], live.services[service]), `Servicio conservado tiene otro binario: ${service}.`);
    for (const ref of [desired.services[service], live.services[service]]) requireThat(image(ref.imageTag).id === ref.imageId, `Imagen no disponible o mutable: ${service}.`);
  }
  const migrate = desired.schemaVersion > live.schemaVersion;
  if (migrate) requireThat(rehearsal?.accepted === true && rehearsal.baseVersion === live.schemaVersion && rehearsal.schemaVersion === desired.schemaVersion && rehearsal.candidateImage === desired.services.web.imageId && rehearsal.archiveSha256 === readJSON(join(directory, 'rehearsal.json')).sha256 && writers.every(service => services.includes(service)), 'Migración sin ensayo correspondiente o sin sus escritores seleccionados.');
  requireThat(!existsSync(journal), 'Ya existe un intento de corte; revisar diario y estado antes de reanudar.');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const staged = mkdtempSync(join(directory, 'config-'));
  const backup = join(directory, 'previous');
  const beforeConfig = config();
  const preflight = () => {
    for (const file of Object.keys(files)) requireThat(writableFiles.includes(file), `Configuración de infraestructura requiere operación separada: ${file}.`);
    for (const file of activeFiles) {
      const path = join(staged, file);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      const body = Object.hasOwn(files, file) ? Buffer.from(files[file], 'base64') : readFileSync(join(appRoot, file));
      requireThat(sha256(body) === desired.configHashes[file], `Hash de configuración no coincide: ${file}.`);
      writeFileSync(path, body, { mode: 0o600 });
    }
    const selector = join(staged, '.env.release.local');
    writeFileSync(selector, Object.entries(pins).map(([service, key]) => `${key}=${desired.services[service].imageTag}\n`).join(''), { mode: 0o600 });
    const after = config({ root: staged, selector });
    const { services: beforeServices, ...beforeRest } = beforeConfig;
    const { services: afterServices, ...afterRest } = after;
    requireThat(same(beforeRest, afterRest), 'Cambió configuración global de la infraestructura.');
    for (const name of Object.keys(afterServices)) {
      const { image: expectedTag, ...entry } = afterServices[name];
      const { image: oldTag, ...oldEntry } = beforeServices[name] ?? {};
      if (serviceOrder.includes(name) || name === 'migrate') requireThat(expectedTag === desired.services[name === 'migrate' ? 'web' : name].imageTag, `Pin futuro no coincide: ${name}.`);
      else if (name !== 'setup' && name !== 'checks') requireThat(expectedTag === oldTag, `Cambió la imagen de infraestructura: ${name}.`);
      if (!services.includes(name)) requireThat(same(entry, oldEntry), `Cambió configuración fuera del corte: ${name}.`);
    }
    requireThat(same(Object.keys(beforeServices).sort(), Object.keys(afterServices).sort()), 'Se agregaron u omitieron servicios Compose.');
    if (migrate) {
      const space = statfsSync(directory, { bigint: true });
      requireThat(space.bavail * space.bsize > BigInt(readJSON(join(directory, 'rehearsal.json')).bytes) * 3n, 'Espacio insuficiente para la copia final y su contingencia.');
    }
    return selector;
  };
  const selector = preflight();
  const oldPin = existsSync(pinPath);
  mkdirSync(backup, { mode: 0o700 });
  if (oldPin) copyFileSync(pinPath, join(backup, 'selector'));
  for (const file of Object.keys(files)) {
    mkdirSync(join(backup, file, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(join(appRoot, file), join(backup, file));
  }
  let attemptedDDL = false, started = false;
  const details = { token, base: live, candidate: desired, services, observed: previous.containers, oldPin, files: Object.keys(files), origin, migrate,
    startedAt: previous.observedAt, acceptance, rehearsal };
  const save = (stage, more = {}) => privateJSON(journal, { ...details, stage, attemptedDDL, started, updatedAt: new Date().toISOString(), ...more });
  try {
    save('prepared');
    if (migrate) {
      save('pausing-writers');
      details.writesPausedAt = new Date().toISOString();
      compose(['stop', '--timeout', '30', ...writers]);
      save('capturing-final');
      const final = capture(directory, 'final', { ...previous, current: null });
      privateJSON(join(directory, 'final.json'), final);
      save('waiting-offsite-proof', { final });
      console.log(JSON.stringify({ command: 'offsite-final', ...final }));
      const rl = createInterface({ input: process.stdin, signal: AbortSignal.timeout(20 * 60_000) });
      const acknowledgement = await rl[Symbol.asyncIterator]().next();
      rl.close();
      const verified = !acknowledgement.done && JSON.parse(acknowledgement.value);
      requireThat(verified?.verified === true && verified.sha256 === final.sha256 && hash.test(verified.encryptedSha256), 'No se verificó descifrado de la copia final fuera de VM.');
      details.offsite = { final, encryptedSha256: verified.encryptedSha256 };
      save('final-verified');
      rmSync(join(directory, 'final.tar'));
    }
    save('switching-config');
    for (const file of Object.keys(files)) replace(join(appRoot, file), readFileSync(join(staged, file)), 0o644);
    replace(pinPath, readFileSync(selector), 0o600);
    config();
    if (migrate) {
      attemptedDDL = true;
      save('migration-started');
      compose(['run', '--rm', '-T', '--no-deps', '--pull', 'never', 'migrate'], { timeout: 420_000 });
      const after = database(previous.containers, true);
      requireThat(after.version === desired.schemaVersion, 'La migración no dejó el marcador esperado.');
      save('migration-confirmed');
    }
    started = true;
    save('starting-services');
    up(services);
    const verified = await verifyAfter(desired, services, origin, previous);
    const record = saveReceipt(desired, verified, origin, { kind: 'release', token, startedAt: previous.observedAt, acceptance, writesPausedAt: details.writesPausedAt });
    save('verified');
    return record;
  } catch (error) {
    save(attemptedDDL ? 'quarantining-after-ddl' : 'reverting-before-ddl', { error: error.message });
    if (attemptedDDL) {
      // Commit state may be unknown. Preserve every write and require a forward recovery decision.
      compose(['stop', '--timeout', '30', ...writers]);
      save('recovery-required', { error: error.message });
    } else {
      rollback(directory, { ...details, started });
      save('reverted', { error: error.message });
    }
    throw error;
  } finally { rmSync(staged, { recursive: true, force: true }); }
}

async function host(operation, input) {
  switch (operation) {
    case 'inspect': return inspect();
    case 'status': return status();
    case 'recover': return recover(input.token);
    case 'inventory': {
      requireThat(!existsSync(currentPath), 'Ya existe un inventario local.');
      const snapshot = inspect();
      const manifest = publicState(input.manifest);
      requireLive(manifest, snapshot, { strictPins: false });
      checkRuntime(snapshot);
      await smoke(input.origin, { bootstrap: manifest.schemaVersion < 15 });
      return saveReceipt(manifest, snapshot, input.origin, { kind: 'inventory' });
    }
    case 'capture-rehearsal': {
      const snapshot = inspect();
      const base = publicState(input.base);
      requireThat(same(base, publicState(snapshot.current?.manifest)), 'Cambió la base del ensayo.');
      requireLive(base, snapshot, { strictPins: snapshot.current.kind !== 'inventory' });
      const directory = recoveryDirectory(input.token);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      const receipt = capture(directory, 'rehearsal', { ...snapshot, current: null });
      privateJSON(join(directory, 'rehearsal.json'), receipt);
      return receipt;
    }
    case 'retire-rehearsal-copy': {
      const directory = recoveryDirectory(input.token);
      requireThat(readJSON(join(directory, 'rehearsal.json')).sha256 === input.sha256, 'Hash de ensayo distinto.');
      rmSync(join(directory, 'rehearsal.tar'));
      return { retired: true };
    }
    case 'check-loaded-images': {
      const refs = Object.values(input.images ?? {});
      requireThat(refs.length > 0 && refs.every(ref => imageId.test(ref.imageId) && /^allnutrition(?:-social-browser)?:release-[a-f0-9]{12}$/.test(ref.imageTag)), 'Referencias OCI inválidas.');
      return { loaded: refs.map(verifiedImagePresent).every(Boolean) };
    }
    case 'receive-image': {
      const directory = recoveryDirectory(input.token);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      const { openSync, closeSync } = await import('node:fs');
      const size = statfsSync(directory, { bigint: true });
      requireThat(Number.isSafeInteger(input.bytes) && input.bytes > 0 && hash.test(input.sha256) && size.bavail * size.bsize > BigInt(input.bytes) * 4n, 'No hay capacidad segura para las imágenes aceptadas.');
      const path = join(directory, 'incoming-images.tar.gz');
      const fd = openSync(path, 'wx', 0o600);
      try { command('cat', [], 'Transferencia de imágenes', { stdout: fd, input: undefined, timeout: 1_200_000, stdin: 'inherit' }); }
      finally { closeSync(fd); }
      try {
        requireThat(statSync(path).size === input.bytes && command('sha256sum', [path], 'Hash de imágenes').startsWith(`${input.sha256} `), 'Transferencia de imágenes incompleta o alterada.');
        loadImages(path, input.images);
      } finally { rmSync(path, { force: true }); }
      return { loaded: true };
    }
    case 'apply': return apply(input);
    default: throw new Error('Operación de VM desconocida.');
  }
}

if (process.env.ALLNUTRITION_PRODUCTION_HOST === '1') {
  process.umask(0o077);
  try {
    const [operation, encoded] = process.argv.slice(2);
    const result = await host(operation, JSON.parse(Buffer.from(encoded, 'base64url')));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
