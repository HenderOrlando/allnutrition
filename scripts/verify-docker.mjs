import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import https from 'node:https';
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentEnv } from './deploy-env.mjs';
import { createInterface } from 'node:readline';
import { imageTag, requiredChecks, sha40 } from './release-impact.mjs';
import { pgGroups, units, configFiles, isNodeTest } from './release-impact-matrix.mjs';
import { browserFilters, nodeSandboxed, organicCase, playwrightFailures, readPlan } from './release-test-plan.mjs';
import { setupGuidedImageFixture, setupOrganicApprovalFixture } from '../tests/e2e/acceptance-fixtures.mjs';

const harness = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = realpathSync(process.env.RELEASE_CANDIDATE || harness);
const configRoot = realpathSync(process.env.RELEASE_CONFIG_ROOT || candidate);
const initialCwd = process.cwd();
const evidencePath = process.env.RELEASE_EVIDENCE_FILE && resolve(process.env.RELEASE_EVIDENCE_FILE);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|HOME|LANG|LC_ALL|TMPDIR|CI|PLAYWRIGHT_BROWSERS_PATH|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|XDG_RUNTIME_DIR|BUILDX_BUILDER)$/.test(key)));
cleanEnv.NEXT_TELEMETRY_DISABLED = '1';
process.chdir(candidate);
process.umask(0o077);
const id = randomBytes(8).toString('hex');
const project = `allnutrition-test-${id}`;
const result = { format: 1, node: process.version, project, startedAt: new Date().toISOString(), tests: [], checks: {}, images: {}, exitCode: 1 };
const args = process.argv.slice(2);
const interactive = args.length === 1 && args[0] === '--interactive';
const planned = args.length === 2 && args[0] === '--plan';
const deployed = args.length === 2 && args[0] === '--deployed';
const full = !planned || process.env.RELEASE_MODE === 'full';
const mode = full ? 'full' : 'impact';
const temporaryImages = [];
let expected, outputImages, checksImage, portMapping, plan;
let fixturePath, restoreWebId;
let upgrade;
const secrets = [];
let values, artifacts, composeArgs, dockerEnv, httpsCA, createdProject = false;
let interrupted = false;
let cancelPause;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; cancelPause?.(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function ensure(condition, message) { if (!condition) throw new Error(message); }
function sanitize(text) {
  let clean = String(text || '');
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, '[redactado]');
  return clean.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[URL PostgreSQL redactada]');
}
function run(binary, args, label, { env = cleanEnv, cwd = candidate, timeout = 120000, allowFailure = false, quiet = false, cleanup = false, logOutput = true, maxBuffer = 64 * 1024 * 1024 } = {}) {
  if (interrupted && !cleanup) throw new Error('Verificación interrumpida.');
  const executed = spawnSync(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout, maxBuffer });
  const output = sanitize(`${executed.stdout || ''}${executed.stderr || ''}`);
  if (artifacts) appendFileSync(join(artifacts, 'commands.log'), `\n## ${label}\n${logOutput ? output : ''}`, { mode: 0o600 });
  if (!quiet) { console.log(`\n${label}`); if (logOutput && output.trim()) console.log(output.trim()); }
  if (!allowFailure && (executed.error || executed.status !== 0)) throw new Error(`${label} falló (${executed.error?.code || executed.signal || executed.status}).`);
  return executed;
}
function compose(args, label, options = {}) {
  createdProject = true;
  return run('docker', [...composeArgs, ...args], label, { ...options, env: { ...dockerEnv, ...options.env } });
}
function cleanupProject() {
  const filter = `label=com.docker.compose.project=${project}`;
  const options = { env: dockerEnv, quiet: true, cleanup: true };
  const listed = run('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', filter], 'Contenedores del proyecto descartable', options);
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  for (const containerId of ids) {
    ensure(/^[a-f0-9]{64}$/.test(containerId), 'Identificador de contenedor descartable inválido.');
    const inspected = run('docker', ['container', 'inspect', containerId], 'Propiedad del contenedor descartable', { ...options, allowFailure: true, logOutput: false });
    if (inspected.status !== 0) {
      ensure(!inspected.error && /No such (?:object|container)/i.test(inspected.stderr || ''), 'No se pudo verificar la propiedad del contenedor.');
      continue;
    }
    const [container] = JSON.parse(inspected.stdout);
    ensure(container.Id === containerId && container.Config.Labels?.['com.docker.compose.project'] === project, 'La limpieza rechazó un contenedor ajeno.');
    // Compose down may leave a timed-out run --rm attached to its networks.
    const removed = run('docker', ['container', 'rm', '--force', containerId], 'Retiro del contenedor descartable', { ...options, allowFailure: true });
    ensure(!removed.error && (removed.status === 0 || /No such container/i.test(removed.stderr || '')), 'No se pudo retirar un contenedor descartable.');
  }
  compose(['down', '--volumes', '--remove-orphans'], 'Eliminación exclusiva del proyecto descartable', { cleanup: true });
  const remaining = {};
  for (const [kind, command] of [['containers', ['ps', '--all', '--quiet']], ['volumes', ['volume', 'ls', '--quiet']], ['networks', ['network', 'ls', '--quiet']]]) {
    const output = run('docker', [...command, '--filter', filter], 'Comprobación de limpieza ' + kind, options).stdout.trim();
    remaining[kind] = output ? output.split(/\s+/) : [];
    ensure(remaining[kind].length === 0, 'La limpieza dejó recursos del proyecto: ' + kind);
  }
  writeFileSync(join(artifacts, 'cleanup.json'), JSON.stringify({ project, remaining }, null, 2) + '\n', { mode: 0o600 });
}
async function availablePort(preferred) {
  const server = createServer();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(preferred, '127.0.0.1', resolve); }); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    return availablePort(0);
  }
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function request(path, { method = 'GET', headers = {}, body, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, values.APP_URL), {
      // Docker commands block the event loop; never reuse an idle socket closed meanwhile.
      agent: false,
      method, ca: httpsCA, family: 4, rejectUnauthorized: true,
      headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const json = response.headers['content-type']?.includes('application/json');
          resolve({ status: response.statusCode, contentType: response.headers['content-type'] || '', data: json ? JSON.parse(data) : null });
        } catch { reject(new Error(`JSON inválido en ${path}.`)); }
      });
      response.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('Plazo HTTPS agotado.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function healthy() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/health', { timeout: Math.min(12000, deadline - Date.now()) });
      if (response.status === 200 && response.data?.ok === true) return;
      ensure([502, 503].includes(response.status), `Salud HTTPS inesperada: ${response.status}.`);
    } catch (error) {
      // Certificate/hostname failures are fatal, not disguised as readiness retries.
      if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) throw error;
    }
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  throw new Error('La aplicación no alcanzó salud HTTPS verificada en 120 segundos.');
}
function passed(name) { result.tests.push(name); console.log(`APROBADO: ${name}`); }
function inspectImage(image, allowFailure = false) {
  const inspected = run('docker', ['image', 'inspect', image], 'Inspección de imagen', { quiet: true, allowFailure, logOutput: false });
  if (inspected.status !== 0) {
    ensure(/No such image|not found/i.test(inspected.stderr || ''), 'No se pudo comprobar el tag de imagen.');
    return null;
  }
  return JSON.parse(inspected.stdout)[0];
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function printedCompose(args) {
  // Remove shell overrides just as compose() does; show paths/project, never credentials.
  return ['env', ...Object.keys(values).map(key => `-u ${shellQuote(key)}`), 'docker', ...composeArgs.map(arg => shellQuote(arg.startsWith('compose.') ? resolve(arg) : arg)), ...args.map(shellQuote)].join(' ');
}
function waitForEnter() {
  return new Promise((resolve, reject) => {
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; cancelPause = null; input.close();
      error ? reject(error) : resolve();
    };
    cancelPause = () => finish(new Error('Aceptación interactiva cancelada por señal.'));
    input.once('SIGINT', cancelPause);
    input.once('close', () => finish(new Error('Aceptación interactiva cancelada: EOF sin Enter.')));
    input.once('line', () => finish());
    console.log('\nCuando el escenario esté completo y el lote de reinicio esté queued con scheduler detenido, cierre todos los paneles y pulse Enter. EOF/SIGINT cancela y elimina solo este proyecto.');
  });
}
function workerState() {
  const script = `
    // node --eval resolves these modules from the checks container's working directory.
    const {openStore}=await import(process.cwd()+'/lib/db/index.mjs');
    const {entity}=await import(process.cwd()+'/lib/business/commands.mjs');
    const store=await openStore();
    try {
      const heartbeat=await store.db.get("SELECT updated_at,state FROM "+store.t('job_runs')+" WHERE key='scheduler:heartbeat'");
      const batch=(await store.db.all("SELECT * FROM "+store.t('import_batches')+" WHERE filename=?",['seguimiento-SINTETICO-reinicio-60.xlsx'])).map(entity);
      const counts={};
      for(const table of ['orders','shipments','shipment_events','order_collections','cash_entries','expenses','expense_payments','settlement_receipts','commission_entries','report_snapshots','alerts']) counts[table]=Number((await store.db.get("SELECT COUNT(*) AS n FROM "+store.t(table))).n);
      let restart=null;
      if(batch.length===1) {
        const b=batch[0], revision=await store.db.get("SELECT data FROM "+store.t('import_revisions')+" WHERE batch_id=? AND revision=?",[b.id,b.acceptedRevision || 0]);
        restart={id:b.id,state:b.state,revision:b.acceptedRevision,selection:revision?JSON.parse(revision.data).selection.length:0,applied:Number((await store.db.get("SELECT COUNT(*) AS n FROM "+store.t('import_rows')+" WHERE batch_id=? AND state='applied'",[b.id])).n)};
      }
      console.log(JSON.stringify({heartbeat,restart,counts}));
    } finally {await store.close();}
  `;
  const observed = compose(['run', '--rm', '--no-deps', 'checks', 'node', '--input-type=module', '-e', script], 'Lectura de heartbeat y progreso durable', { quiet: true, logOutput: false });
  return JSON.parse(observed.stdout.trim());
}
async function startWorker() {
  const startedAt = Date.now();
  compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'scheduler'], 'Arranque aislado del scheduler');
  const inspected = running('scheduler');
  const networks = Object.keys(inspected.NetworkSettings.Networks);
  ensure(inspected.Config.User === 'node' && Object.values(inspected.NetworkSettings.Ports || {}).every(bindings => !bindings?.length) && networks.length === 2 && networks.includes(`${project}_backend`) && networks.includes(`${project}_social_egress`), 'Scheduler debe usar usuario node, redes backend y social_egress y ningún puerto publicado.');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = workerState();
    if (state.heartbeat?.state === 'succeeded' && Date.parse(state.heartbeat.updated_at) >= startedAt) return state;
    ensure(!interrupted, 'Verificación interrumpida.');
    await delay(1000);
  }
  throw new Error('Scheduler sin heartbeat reciente después de arrancar.');
}
function stopWorker() { compose(['stop', 'scheduler'], 'Detención del scheduler antes de modificar/restaurar fixtures'); }
function workerOnce(label) {
  const output = compose(['run', '--rm', '--no-deps', 'scheduler', 'npm', 'run', 'business:jobs:once'], label).stdout;
  const line = output.trim().split('\n').findLast(line => line.startsWith('{'));
  ensure(line, 'El worker no devolvió el progreso de su turno real.');
  return JSON.parse(line);
}
function settleWorker() {
  for (let turn = 0; turn < 30; turn++) {
    if (!workerOnce('Turno acotado hasta agotar derivados pendientes').hasMore) return;
  }
  throw new Error('El worker no agotó los trabajos pendientes en 30 turnos acotados.');
}
async function proveImportRestart() {
  const active = compose(['ps', '--status', 'running', '-q', 'scheduler'], 'Comprobación de worker detenido para reinicio', { quiet: true }).stdout.trim();
  ensure(!active, 'Detenga el scheduler después del preview y antes del commit del Excel de reinicio.');
  const before = workerState();
  ensure(before.restart?.state === 'queued' && before.restart.selection === 60 && before.restart.applied === 0, 'Se requiere lote real de 60 guías, revisión aceptada queued y cero filas aplicadas.');
  compose(['run', '--rm', '--no-deps', 'scheduler', 'npm', 'run', 'business:jobs:once'], 'Primer turno acotado sobre lote aceptado con paneles cerrados');
  const partial = workerState();
  ensure(partial.restart.id === before.restart.id && partial.restart.revision === before.restart.revision && partial.restart.state === 'queued' && partial.restart.applied === 25, 'El primer turno debe conservar la revisión y aplicar solo 25 de 60 grupos.');
  await startWorker();
  const deadline = Date.now() + 120000;
  let completed;
  while (Date.now() < deadline) {
    completed = workerState();
    if (completed.restart?.state === 'completed') break;
    ensure(!['failed','completed_with_errors'].includes(completed.restart?.state), 'El lote de reinicio terminó con errores.');
    ensure(!interrupted, 'Verificación interrumpida.');
    await delay(1000);
  }
  ensure(completed?.restart?.applied === 60 && completed.restart.state === 'completed' && completed.restart.revision === before.restart.revision, 'El servicio reiniciado no reanudó los 60 grupos de la misma revisión.');
  stopWorker();
  // Drain other domain stages before comparing an unchanged repeated turn.
  settleWorker();
  const stable = workerState();
  compose(['run', '--rm', '--no-deps', 'scheduler', 'npm', 'run', 'business:jobs:once'], 'Repetición real del worker sin nuevos hechos');
  const repeated = workerState();
  ensure(JSON.stringify(stable.counts) === JSON.stringify(repeated.counts), 'Repetir el worker duplicó hechos, alertas o revisiones de informes.');
  ensure(stable.counts.orders === before.counts.orders && stable.counts.cash_entries === before.counts.cash_entries && stable.counts.order_collections === before.counts.order_collections && stable.counts.shipments === before.counts.shipments + 60 && stable.counts.shipment_events === before.counts.shipment_events + 60, 'El seguimiento debe crear exactamente 60 guías/eventos, sin ventas ni dinero.');
  writeFileSync(join(artifacts, 'business-restart.json'), JSON.stringify({ before, partial, completed, stable, repeated }, null, 2) + '\n', { mode: 0o600 });
  passed('scheduler: revisión durable 0→25→60 tras reinicio, heartbeat y repetición sin duplicados');
}

function record(key, start, count, extra = {}) {
  ensure(!result.checks[key] && Number.isInteger(count) && count > 0, `Sin casos ejecutados para ${key}`);
  result.checks[key] = { count, durationMs: Math.max(0, Math.round(performance.now() - start)), ...extra };
  passed(key);
}
function tapCount(output, suite) {
  const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|skipped|cancelled|todo) (\d+)\r?$/gm)].map(([, name, value]) => [name, Number(value)]));
  const summary = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map(name => `${name}=${counts[name] ?? 'ausente'}`).join(', ');
  ensure(counts.pass > 0 && counts.pass === counts.tests && ['fail', 'skipped', 'cancelled', 'todo'].every(name => counts[name] === 0),
    `${suite}: TAP sin casos o con fallos/omisiones (${summary}).`);
  return counts.pass;
}
function checkImage(image, architecture) {
  const actual = inspectImage(image.imageId);
  ensure(actual.Id === image.imageId && actual.Os === 'linux' && actual.Architecture === architecture, 'Identidad/arquitectura incorrecta: ' + image.imageTag);
  return image;
}
function tagged(tag) {
  const image = inspectImage(tag);
  ensure(/^sha256:[a-f0-9]{64}$/.test(image?.Id) && image.Os === 'linux', 'Imagen de fixture inválida: ' + tag);
  return { imageTag: tag, imageId: image.Id, architecture: image.Architecture, os: image.Os };
}
function running(service) {
  const containerId = compose(['ps', '-q', service], 'Contenedor aislado: ' + service, { quiet: true }).stdout.trim();
  ensure(/^[a-f0-9]{64}$/.test(containerId), 'El servicio no está activo: ' + service);
  const [info] = JSON.parse(run('docker', ['inspect', containerId], 'Identidad del contenedor de prueba', { quiet: true, logOutput: false }).stdout);
  ensure(info.State.Running && info.Config.Labels?.['com.docker.compose.project'] === project && info.Image === expected[service]?.imageId, 'Imagen ejecutada incorrecta: ' + service);
  return info;
}
let buildKitCredentials;
function buildImage(tag, scope, options) {
  const cache = process.env.RELEASE_GHA_CACHE;
  const flags = [];
  const env = { ...cleanEnv };
  if (cache === 'read' || cache === 'write') {
    if (!buildKitCredentials) {
      // Drain the one-way credential pipe. fd 0 must stay occupied for libuv.
      // Candidate subprocesses use ignored stdin and the stripped environment.
      const { ACTIONS_RESULTS_URL: url, ACTIONS_RUNTIME_TOKEN: token } = JSON.parse(readFileSync(0, 'utf8'));
      ensure(typeof url === 'string' && url && typeof token === 'string' && token, 'Credenciales efímeras de BuildKit ausentes');
      secrets.push(token);
      buildKitCredentials = { ACTIONS_RESULTS_URL: url, ACTIONS_RUNTIME_TOKEN: token, ACTIONS_CACHE_SERVICE_V2: 'true' };
    }
    Object.assign(env, buildKitCredentials);
    flags.push('--cache-from', `type=gha,version=2,scope=${scope}`);
    if (cache === 'write') flags.push('--cache-to', `type=gha,version=2,mode=max,scope=${scope}`);
  }
  temporaryImages.push(tag);
  run('docker', ['buildx', 'build', '--load', '--provenance=false', '--tag', tag, ...flags, ...options, candidate], `Build Docker: ${scope}`, { timeout: 5400000, env, logOutput: !cache });
  return tagged(tag);
}
function prepareChecks(web, sandboxed) {
  const target = web ? 'checks-with-web' : 'checks';
  const options = ['--file', join(harness, 'Dockerfile.checks'), '--target', target, '--build-context', `heka_contract=${join(candidate, 'desktop/providers')}`];
  if (sandboxed.length) options.push('--build-arg', 'CHECKS_CHROMIUM=1');
  if (sandboxed.includes('tests/social-browser.test.mjs')) options.push('--build-arg', 'CHECKS_FFMPEG=1');
  if (web) {
    const compiled = join(artifacts, 'compiled-web');
    mkdirSync(compiled, { mode: 0o700 });
    const containerId = run('docker', ['create', '--name', `${project}-build-context`, '--label', `com.docker.compose.project=${project}`, '--network', 'none', web.imageId], 'Derivación de checks desde la web aceptada', { quiet: true }).stdout.trim();
    ensure(/^[a-f0-9]{64}$/.test(containerId), 'Identidad inesperada de contenedor de build');
    try {
      // The checks image never runs Next; browser requests use the sealed web
      // container. Copy compiled assets, not the generated dependency links
      // that resolve outside .next, nor standalone/cache/build tools.
      for (const entry of ['BUILD_ID', 'app-path-routes-manifest.json', 'build-manifest.json', 'images-manifest.json',
        'prerender-manifest.json', 'required-server-files.json', 'routes-manifest.json', 'server', 'static']) {
        run('docker', ['cp', `${containerId}:/app/.next/${entry}`, compiled], `Copiar salida compilada: ${entry}`, { quiet: true });
      }
    }
    finally { run('docker', ['container', 'rm', containerId], 'Retiro del contexto compilado', { cleanup: true, quiet: true }); }
    options.push('--build-context', `accepted_web=${compiled}`);
  }
  return buildImage(`allnutrition-checks:test-${id}`, 'allnutrition-checks', options);
}
function nodeChecks(files, idFor) {
  let total = 0;
  for (const file of files) {
    const start = performance.now();
    const special = file === 'tests/heka-browser.mjs';
    const command = special ? [file] : ['--test', '--test-reporter=tap', file];
    const output = nodeSandboxed(file)
      ? compose(['run', '--rm', '--no-deps', '--pull', 'never', 'checks', 'node', ...command], file, { timeout: 7200000 })
      : run('node', command, file, { timeout: 7200000 });
    const count = special ? 1 : tapCount(output.stdout, file);
    total += count;
    if (idFor) record(idFor(file), start, count);
  }
  return total;
}
function pgChecks(groups, separate) {
  let total = 0;
  const regular = groups.filter(group => group !== 'assistant-work');
  const pgCommand = ['node', '--test', '--test-reporter=tap'];
  if (regular.length) {
    const start = performance.now();
    const file = 'tests/postgres.integration.test.mjs';
    const grouped = readFileSync(file, 'utf8').includes('TEST_PG_GROUPS');
    const output = compose(['run', '--rm', '--no-deps', ...(grouped && separate ? ['-e', `TEST_PG_GROUPS=${regular.join(',')}`] : []), 'checks', ...pgCommand, file], grouped && separate ? `Contratos PostgreSQL: ${regular.join(', ')}` : 'Contratos PostgreSQL (archivo completo)', { timeout: 14400000 });
    ensure(output.stdout.includes('Contrato completo con PostgreSQL real'), 'No se ejecutó el contrato PostgreSQL');
    const count = tapCount(output.stdout, `${file} (${regular.join(', ')})`);
    total += count;
    const observed = Object.fromEntries([...output.stdout.matchAll(/^\s*# PG_GROUP ([a-z-]+) cases=([1-9]\d*)\s*$/gm)].map(m => [m[1], Number(m[2])]));
    if (grouped) ensure(JSON.stringify(Object.keys(observed).sort()) === JSON.stringify((separate ? regular : pgGroups).slice().sort()), 'Grupos PostgreSQL observados no coinciden');
    if (separate) for (const group of regular) record(`pg:${group}`, start, grouped ? observed[group] : count, grouped ? {} : { execution: 'legacy-full-file' });
  }
  if (groups.includes('assistant-work')) {
    const start = performance.now();
    const output = compose(['run', '--rm', '--no-deps', 'checks', ...pgCommand, 'tests/assistant-work-postgres.test.mjs'], 'Contratos PostgreSQL de ejecución Ali', { timeout: 3600000 });
    ensure(output.stdout.includes('recoverable assistant work contracts (disposable PostgreSQL)'), 'No se ejecutó el contrato Ali en PostgreSQL');
    const count = tapCount(output.stdout, 'tests/assistant-work-postgres.test.mjs');
    total += count;
    if (separate) record('pg:assistant-work', start, count);
  }
  return total;
}
function testOptions(tag, extraEnv, args) {
  const outputFile = join(artifacts, `playwright-${tag}.json`);
  const output = run('node', ['node_modules/@playwright/test/cli.js', 'test', ...args, '--reporter=json'], `Playwright: ${tag}`, {
    timeout: 10800000, allowFailure: true, logOutput: false,
    env: { ...cleanEnv, ...extraEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: outputFile, PLAYWRIGHT_OUTPUT_DIR: join(artifacts, `playwright-${tag}-results`) },
  });
  let stats, failures;
  try {
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    stats = report.stats;
    failures = playwrightFailures(report);
  } catch {
    throw new Error(`Playwright no generó un informe JSON legible: ${tag} (${output.error?.code || output.signal || output.status}).`);
  }
  for (const failure of failures) console.error(`Playwright ${sanitize(JSON.stringify(failure))}`);
  ensure(!output.error && output.status === 0 && stats?.expected > 0 && stats.unexpected === 0 && stats.flaky === 0 && stats.skipped === 0 && !failures.length, `Playwright sin casos aceptados o con fallos/omisiones: ${tag}`);
  return stats.expected;
}
async function playwrightChecks(selectors) {
  const commonEnv = {
    E2E_BASE_URL: values.APP_URL, E2E_ALLOW_SELF_SIGNED: '1', PLAYWRIGHT_MEDIA_SMOKE_FILE: join(artifacts, 'media-smoke.json'),
    ALI_FIXTURE_CONTROL_URL: `http://127.0.0.1:${portMapping.fixture}`, ALI_FIXTURE_BASE_URL: 'http://127.0.0.1:3339/v1',
    TEST_DATABASE_URL: `postgresql://postgres:${values.POSTGRES_PASSWORD}@localhost:${portMapping.db}/allnutrition_test`,
    TEST_ALLOW_DATABASE_RESET: 'allnutrition_test', TEST_DB_SSL: 'verify', TEST_DB_CA_CERT_FILE: join(values.DEPLOY_TLS_DIR, 'ca.crt'),
  };
  const refs = { appImage: { tag: expected.web.imageId, id: expected.web.imageId }, checksImage: { tag: checksImage.imageId, id: checksImage.imageId }, dbImage: { tag: expected.db.imageId, id: expected.db.imageId }, configRoot, run, availablePort, suffix: id };
  const advertising = full || selectors.includes('advertising');
  const advertisingSource = advertising && existsSync('tests/e2e/advertising.spec.mjs') ? readFileSync('tests/e2e/advertising.spec.mjs', 'utf8') : '';
  let guided, count = 0, advertisingStart;
  try {
    if (advertisingSource.includes('ADVERTISING_IMAGE_E2E_URL')) guided = await setupGuidedImageFixture(refs);
    if (full) {
      const start = performance.now();
      count = testOptions('full', { ...commonEnv, ...guided?.environment }, advertisingSource.includes(organicCase) ? ['--grep-invert', organicCase] : []);
      advertisingStart = start;
    } else {
      for (const selector of selectors) {
        if (selector === 'privacy') continue;
        const start = performance.now();
        const [spec] = selector.split(':');
        const file = `tests/e2e/${spec}.spec.mjs`;
        const filter = browserFilters[selector];
        // A pre-tag candidate still runs its full existing spec.
        const hasTags = !filter?.startsWith('@') || readFileSync(file, 'utf8').includes(filter.split('|')[0]);
        const executed = testOptions(selector.replace(':', '-'), { ...commonEnv, ...guided?.environment }, [file, ...(filter && hasTags ? ['--grep', filter] : []), ...(spec === 'advertising' && advertisingSource.includes(organicCase) ? ['--grep-invert', organicCase] : [])]);
        if (spec === 'advertising') { count += executed; advertisingStart = start; }
        else record(`playwright:${selector}`, start, executed);
      }
    }
  } finally { await guided?.cleanup(); }
  if (advertisingSource.includes(organicCase)) {
    const approval = await setupOrganicApprovalFixture(refs);
    try { count += testOptions('organic-approval', { ...commonEnv, ...approval.environment }, ['tests/e2e/advertising.spec.mjs', '--project', 'desktop', '--grep', organicCase]); }
    finally { await approval.cleanup(); }
  }
  if (full || advertising) record(full ? 'full:playwright' : 'playwright:advertising', advertisingStart, count);
}

async function prepareProject({ needApp, needChecks, needDb, needBrowser, sandboxed, pair, manifest }) {
  const generated = createDeploymentEnv('test', { id });
  values = generated.values;
  artifacts = values.ARTIFACT_DIR;
  secrets.push(values.POSTGRES_PASSWORD, values.DB_APP_PASSWORD, values.ADMIN_PASSWORD);
  dockerEnv = cleanEnv;
  const app = deployed ? manifest.services.web : needApp ? buildImage(`allnutrition:test-${id}`, 'allnutrition-app', ['--target', 'runtime', '--file', 'Dockerfile']) : null;
  const runner = deployed ? manifest.services['social-browser'] : pair || plan.build.includes('runner') ? buildImage(`allnutrition-social-browser:test-${id}`, 'allnutrition-runner', ['--file', 'Dockerfile.social-browser']) : null;
  if ((needDb || pair) && !deployed && !inspectImage('postgres:16-bookworm', true)) run('docker', ['pull', 'postgres:16-bookworm'], 'PostgreSQL local de pruebas');
  const db = deployed ? manifest.services.db : needDb || pair ? tagged('postgres:16-bookworm') : null;
  expected = deployed ? manifest.services : { web: app, scheduler: app, 'social-browser-worker': app, 'social-browser': runner, db };
  outputImages = { app, runner };
  if (needChecks) checksImage = prepareChecks(deployed || needBrowser ? app : null, sandboxed);
  portMapping = needBrowser ? { fixture: await availablePort(0), db: await availablePort(0) } : null;
  if (needApp) {
    values.APP_URL = `https://localhost:${await availablePort(0)}`;
    values.HTTPS_PORT = new URL(values.APP_URL).port;
  }
  values.APP_IMAGE = app?.imageId || `allnutrition:synthetic-${id}`;
  writeFileSync(generated.envFile, readFileSync(generated.envFile, 'utf8').replace(/^APP_URL=.*$/m, `APP_URL=${values.APP_URL}`).replace(/^HTTPS_PORT=.*$/m, `HTTPS_PORT=${values.HTTPS_PORT}`).replace(/^APP_IMAGE=.*$/m, `APP_IMAGE=${values.APP_IMAGE}`), { mode: 0o600 });
  fixturePath = join(artifacts, 'fixture.compose.json');
  const dbRelay = "const net=require('node:net');net.createServer(client=>{const db=net.connect(5432,'db');db.on('error',()=>client.destroy());client.on('error',()=>db.destroy());db.pipe(client).pipe(db)}).listen(5432,'0.0.0.0')";
  const serviceImage = entry => ({ image: entry.imageId, pull_policy: 'never' });
  const overrides = {
    ...(db ? { db: serviceImage(db), backup: serviceImage(db) } : {}),
    ...(app ? { web: serviceImage(app), migrate: serviceImage(app), scheduler: serviceImage(expected.scheduler), 'social-browser-worker': serviceImage(expected['social-browser-worker']) } : {}),
    ...(runner ? { 'social-browser': serviceImage(runner) } : {}),
    ...(checksImage ? { checks: serviceImage(checksImage) } : {}),
  };
  if (portMapping) {
    overrides.web.ports = [`127.0.0.1:${portMapping.fixture}:3339`];
    overrides['db-relay'] = { ...serviceImage(app), networks: ['backend','frontend'], ports: [`127.0.0.1:${portMapping.db}:5432`], command:['node', '-e', dbRelay] };
  }
  writeFileSync(fixturePath, JSON.stringify({ services: overrides, networks: { social_egress: { internal: true } } }) + '\n', { mode: 0o600 });
  const staging = existsSync(join(configRoot, 'compose.staging.yaml')) ? configRoot : candidate;
  composeArgs = ['compose', '-p', project, '--env-file', generated.envFile, '-f', join(configRoot, 'compose.yaml'), '-f', join(staging, 'compose.staging.yaml'), '-f', fixturePath];
  compose(['config', '--quiet'], 'Validación privada de Compose');
  if (needDb) {
    compose(['up', '-d', '--wait', '--wait-timeout', '120', '--no-build', '--pull', 'never', 'db'], 'PostgreSQL TLS saludable', { timeout: 150000 });
    running('db');
  }
  result.imageId = app?.imageId;
  result.architecture = app?.architecture;
  result.os = app?.os;
  return generated;
}
function readDeployed(filename) {
  const manifest = JSON.parse(readFileSync(filename, 'utf8'));
  const mountedFiles = ['compose.yaml', 'compose.nginx.yaml', 'deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh', 'deploy/social-browser-seccomp.json'];
  ensure(manifest.format === 1 && sha40.test(manifest.coveredThrough) && sha40.test(manifest.configCommit) && Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion > 0 && mountedFiles.every(path => Object.hasOwn(manifest.configHashes || {}, path)), 'Manifiesto desplegado inválido');
  for (const [path, expectedHash] of Object.entries(manifest.configHashes)) {
    ensure(configFiles.includes(path) && /^[a-f0-9]{64}$/.test(expectedHash) && createHash('sha256').update(readFileSync(join(configRoot, path))).digest('hex') === expectedHash, 'Hash de configuración incorrecto: ' + path);
  }
  for (const service of units) {
    const ref = manifest.services?.[service];
    ensure(/^sha256:[a-f0-9]{64}$/.test(ref?.imageId || '') && typeof ref.imageTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/.test(ref.imageTag) && (service === 'db' || sha40.test(ref.sourceCommit)), 'Falta la identidad desplegada de ' + service);
    checkImage(ref, 'amd64');
  }
  return manifest;
}
function verifyRuntime() {
  const start = performance.now();
  const probe = compose(['run', '--rm', '--no-deps', '--pull', 'never', 'web', 'node', '-e', 'const fs=require("node:fs");if(["@playwright/test","typescript"].some(n=>fs.existsSync("node_modules/"+n))||["/ms-playwright","/root/.cache/ms-playwright","/home/node/.cache/ms-playwright","node_modules/playwright-core/.local-browsers"].some(p=>fs.existsSync(p))||process.getuid()!==1000||process.versions.node.split(".")[0]!=="24")process.exit(1);console.log(JSON.stringify({node:process.version,uid:process.getuid()}))'], 'Identidad del runtime y ausencia de Chromium/devDependencies');
  result.runtime = JSON.parse(probe.stdout.trim());
  record('gate:runtime', start, 1);
}
async function verifyWeb({ browser, scheduler, operational }) {
  const start = performance.now();
  if (browser || operational) compose(['run', '--rm', '--no-deps', 'checks', 'node', 'tests/e2e/setup.mjs'], 'Fixture PostgreSQL con doble guarda');
  // Proxy is a public fixture image; web, db and relay are pinned locally by the override.
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'web', 'proxy', ...(browser ? ['db-relay'] : [])], 'Arranque HTTPS compilado', { timeout: 180000 });
  if (browser && existsSync('tests/assistant-provider-fixture.mjs')) compose(['exec', '-d', 'web', 'node', 'tests/assistant-provider-fixture.mjs', '--port', '3339', '--host', '0.0.0.0'], 'Proveedor sintético Ali');
  const root = JSON.parse(compose(['exec', '-T', 'proxy', 'wget', '-qO-', 'http://127.0.0.1:2019/pki/ca/local'], 'Exportación de CA HTTPS pública', { quiet: true, logOutput: false }).stdout).root_certificate;
  ensure(typeof root === 'string' && root.includes('BEGIN CERTIFICATE'), 'Caddy no devolvió su certificado raíz público.');
  httpsCA = root;
  if (operational) writeFileSync(join(artifacts, 'https-ca.crt'), root, { mode: 0o600, flag: 'wx' });
  await healthy();
  const privacy = existsSync('app/privacy/page.jsx');
  for (const path of ['/', ...(privacy ? ['/privacy'] : [])]) ensure((await request(path)).status === 200, 'Smoke HTTPS rechazado: ' + path);
  ensure((await request('/api/admin/orders')).status === 401, 'La API administrativa debe conservar autorización');
  restoreWebId = running('web').Id;
  running('db');
  record('gate:https', start, privacy ? 4 : 3);
  if (scheduler) await startWorker();
}
function verifyCompose({ pair, includeProduction }) {
  const start = performance.now();
  const { envFile } = pair;
  const syntaxEnv = { ...cleanEnv, APP_DOMAIN: 'production.example.invalid', APP_URL: 'https://production.example.invalid' };
  let count = 0;
  for (const name of ['compose.nginx.yaml', 'compose.production.yaml']) {
    const path = [configRoot, candidate].map(root => join(root, name)).find(existsSync);
    if (!path) continue;
    const args = ['compose', '-p', project, '--env-file', envFile, '-f', join(configRoot, 'compose.yaml'), '-f', path];
    run('docker', [...args, 'config', '--quiet'], `Sintaxis aislada de ${name}`, { env: syntaxEnv });
    count++;
    if (includeProduction && name === 'compose.production.yaml') {
      run('docker', [...args, 'run', '--rm', '--no-deps', 'proxy', 'caddy', 'adapt', '--adapter', 'caddyfile', '--config', '/etc/caddy/Caddyfile'], 'Adaptación Caddy sin iniciar ACME', { env: syntaxEnv, quiet: true });
      count++;
    }
  }
  return { start, count: count + 1 }; // incluye config --quiet de staging
}
function verifyPair(manifest) {
  const start = performance.now();
  const path = join(artifacts, 'pair.json');
  writeFileSync(path, JSON.stringify(manifest || { format: 1, services: expected }), { mode: 0o600, flag: 'wx' });
  const check = run('node', [join(harness, 'tests/native/browser-acceptance.mjs'), 'pair', path], 'Protocolo, TLS y sandbox del runner aislado', { env: { ...cleanEnv, RELEASE_CANDIDATE: candidate, RELEASE_CONFIG_ROOT: configRoot }, timeout: 900000, logOutput: false, allowFailure: true });
  const observed = JSON.parse(check.stdout.trim());
  ensure(check.status === 0 && observed.accepted && observed.zeroOwnedLeftovers && units.every(unit => observed.images[unit] === expected[unit].imageId), 'No se aceptó el conjunto aislado de runner: ' + (observed.failure?.message || 'identidad'));
  record('gate:runner', start, 1, { images: observed.images });
}
function migrateFixture() {
  compose(['run', '--rm', '--no-deps', '--pull', 'never', 'migrate'], 'Migración de PostgreSQL descartable y aprovisionamiento del rol runtime', { timeout: 600000 });
  const target = plan.schemaVersion;
  if (Number.isInteger(target) && target > 0) {
    const observed = compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'allnutrition_test', '-At', '-c', 'SELECT max(version) FROM allnutrition.migrations'], 'Versión del esquema de fixture').stdout.trim();
    ensure(Number(observed) === target, `Esquema de fixture inesperado: se esperaba ${target}`);
  }
}
function rehearseUpgrade(base) {
  const start = performance.now();
  const path = join(harness, 'tests/docker/prepare-upgrade.mjs');
  const fixture = (phase, version) => {
    const observed = compose(['run', '--rm', '--no-deps', '-v', `${path}:/app/tests/docker/prepare-upgrade.mjs:ro`, 'checks', 'node', 'tests/docker/prepare-upgrade.mjs', phase, String(version)], `Ensayo de esquema v${version}: ${phase}`, { timeout: 600000, logOutput: false });
    return JSON.parse(observed.stdout.trim());
  };
  const before = fixture('prepare', base);
  migrateFixture();
  const after = fixture('observe', plan.schemaVersion);
  ensure(before.factsSha256 === after.factsSha256, 'La actualización alteró datos sintéticos del esquema base.');
  return { durationMs: performance.now() - start, count: 3 };
}
async function verifyOperational(operationalGates) {
  const start = performance.now();
  const operations = command => compose(['run', '--rm', '--no-deps', 'checks', 'node', 'tests/docker/operations.mjs', command], `Operaciones PostgreSQL: ${command}`);
  if (operationalGates.scheduler) {
    if (!operationalGates.browserWorker) await startWorker();
  if (interactive) {
    stopWorker();
    operations('business-prepare');
    await startWorker();
    const manifestPath = join(artifacts, 'business.json');
    console.log(`\nACEPTACIÓN INTERACTIVA: ${values.APP_URL}/admin`);
    console.log(`Manifest sin secretos: ${manifestPath}\nExcel sintéticos en: ${artifacts}`);
    console.log('Ejercite desde la UI: main y reordenado; liquidación105000; sueldo/comisión15500; septiembre37500; costo A30000desde1octubre y NUEVO pedido1octubre A×1/flete0, guardado sin envío/cobro para comprobar snapshot30000; devolución recuperable55000/23000 del principal; reembolso55000 y pago retorno7000 →127500.');
    console.log('Configure mínimo128000 y solicite snapshot septiembre. Cierre TODOS los paneles antes de jobs:once. Repita sin duplicar; acuse alerta En atención sin resolver; ingreso propietario500 con referencia APORTE-SINTETICO-500 y nueva corrida →128000 y mismo episodio resuelto.');
    console.log(`DETENER:\n${printedCompose(['stop', 'scheduler'])}`);
    console.log(`UNA CORRIDA REAL SIN PANELES:\n${printedCompose(['run', '--rm', '--no-deps', 'scheduler', 'npm', 'run', 'business:jobs:once'])}`);
    console.log(`REINICIAR:\n${printedCompose(['up', '-d', '--no-deps', 'scheduler'])}`);
    console.log('Finalmente: con scheduler ACTIVO suba seguimiento-SINTETICO-reinicio-60.xlsx y espere parseo/preview válido de60 grupos (perfil en manifest, carrier explícito). SOLO ENTONCES detenga scheduler, confirme Importar, deje queued, cierre paneles y pulse Enter. El verificador hará turno25 y reinicio→60 sin sembrar datos.');
    await waitForEnter();
    operations('business-assert');
    await proveImportRestart();
    operations('business-assert');
    passed('escenario comercial completo ejercido en UI, snapshot/alerta sin paneles e importación reanudable');
  } else {
    stopWorker();
    settleWorker();
    const before = workerState();
    workerOnce('Repetición automatizada del worker sin nuevos hechos');
    const after = workerState();
    ensure(JSON.stringify(before.counts) === JSON.stringify(after.counts), 'El worker automatizado duplicó hechos, alertas o snapshots sin cambios.');
    writeFileSync(join(artifacts, 'scheduler-repeat.json'), JSON.stringify({ before, after }, null, 2) + '\n', { mode: 0o600 });
    passed('scheduler automatizado sin hechos, alertas ni revisiones duplicadas');
  }
    record('gate:scheduler', start, 2);
  }
  if (!operationalGates.migration && !operationalGates.restore) return;
  const recoveryStart = performance.now();
  stopWorker();
  operations('prepare');
  const snapshot = JSON.parse(readFileSync(join(artifacts, 'operational.json'), 'utf8'));
  secrets.push(snapshot.session.token, snapshot.session.csrf, snapshot.account.password);
  if (operationalGates.migration) compose(['run', '--rm', '--no-deps', 'migrate'], 'Repetición de migración con datos y sesiones existentes');
  operations('assert');
  passed('migración idempotente, runtime sin DDL, sesión y pedido 119000');
  operations('reject-insecure');
  passed('rechazo de CA equivocada y de PostgreSQL TCP sin TLS');
  if (operationalGates.migration) record('gate:migration', recoveryStart - (upgrade?.durationMs || 0), (upgrade?.count || 0) + 3);
  if (!operationalGates.restore) return;
  const headers = { Cookie: `allnutrition_session=${snapshot.session.token}`, 'x-csrf-token': snapshot.session.csrf, Origin: values.APP_URL };
  const before = await request('/api/admin/orders', { headers });
  ensure(before.status === 200 && before.data.total === snapshot.orderCount, 'La sesión operativa no puede leer los pedidos iniciales.');
  compose(['stop', 'db'], 'Caída real de PostgreSQL');
  ensure((await request('/api/health')).status === 503, 'La caída de DB no devolvió salud 503.');
  const outage = await request('/api/admin/orders', { method: 'POST', headers, body: { ...snapshot.payload, requestId: randomUUID() } });
  ensure(outage.status === 503, `El guardado autenticado durante la caída devolvió ${outage.status}, no 503.`);
  compose(['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'db'], 'Recuperación de PostgreSQL', { timeout: 150000 });
  running('db');
  await healthy();
  const after = await request('/api/admin/orders', { headers });
  ensure(after.status === 200 && after.data.total === before.data.total, 'El guardado rechazado apareció como pedido o la sesión dejó de funcionar.');
  passed('outage: health y POST autenticado 503; recuperación sin pedidos adicionales');
  compose(['restart', 'web', 'db'], 'Reinicio de aplicación y base');
  await healthy();
  running('web');
  running('db');
  operations('assert');
  const mediaSmoke = JSON.parse(readFileSync(join(artifacts, 'media-smoke.json'), 'utf8'));
  const persistedMedia = await request(mediaSmoke.url);
  ensure(persistedMedia.status === 200 && persistedMedia.contentType.startsWith('image/webp'), 'La imagen local dejó de servirse después del reinicio de web/DB.');
  passed('imagen WebP local disponible y servida tras restart web/db');
  passed('persistencia y sesiones tras restart web/db');

  const oldBackups = new Set(readdirSync(values.BACKUP_DIR));
  compose(['run', '--rm', '--no-deps', 'backup'], 'Backup TLS pg_dump de la base descartable');
  const newBackups = readdirSync(values.BACKUP_DIR).filter(file => !oldBackups.has(file));
  ensure(newBackups.length === 1 && /^allnutrition-\d{8}T\d{6}Z\.dump$/.test(newBackups[0]), 'No se identificó un único dump nuevo.');
  const backup = newBackups[0];
  const metadata = statSync(join(values.BACKUP_DIR, backup));
  ensure(metadata.size > 0 && (metadata.mode & 0o777) === 0o600, 'El dump está vacío o no tiene permisos 0600.');
  result.backup = join(values.BACKUP_DIR, backup);
  compose(['stop', 'web'], 'Detención de web antes del restore');
  stopWorker();
  compose(['exec', '-T', 'db', 'createdb', '-U', 'postgres', 'allnutrition_restore'], 'Creación exclusiva de una base restore vacía');
  compose(['run', '--rm', '--no-deps', '-e', 'PGDATABASE=allnutrition_restore', 'backup', 'pg_restore', '--exit-on-error', '--dbname=allnutrition_restore', `/backups/${backup}`], 'Restore TLS en base distinta', { timeout: 15 * 60 * 1000 });
  compose(['run', '--rm', '--no-deps', '-e', 'DATABASE_URL', 'checks', 'node', 'tests/docker/operations.mjs', 'assert'], 'Aceptación de la base restaurada con rol runtime', {
    env: { DATABASE_URL: `postgresql://allnutrition_app:${values.DB_APP_PASSWORD}@db:5432/allnutrition_restore` },
  });
  passed('pg_dump/restore: cuentas, sesiones, replay, numeración, historial y privilegios');
  const webMounts = JSON.parse(run('docker', ['inspect', restoreWebId], 'Volumen de imágenes separado del dump', { quiet: true, logOutput: false }).stdout)[0].Mounts;
  ensure(webMounts.some(mount => mount.Type === 'volume' && mount.Destination === '/app/data/product-images' && mount.Name === `${project}_product_images`), 'Las imágenes deben persistir en su volumen propio, no en pg_dump.');
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'web'], 'Reapertura de web tras restore aislado', { timeout: 150000 });
  await healthy();
  running('web');
  const mediaAfterRestore = await request(mediaSmoke.url);
  ensure(mediaAfterRestore.status === 200 && mediaAfterRestore.contentType.startsWith('image/webp'), 'El volumen separado de imágenes no conserva el archivo tras el procedimiento de restore.');
  passed('pg_dump conserva negocio v3; archivo WebP permanece en volumen separado');
  if (operationalGates.scheduler) {
    await startWorker();
    passed('scheduler vuelve a funcionar tras caída/reinicio y restore aislado');
  }
  record('gate:restore', recoveryStart, 5);
}

try {
  ensure(args.length === 0 || interactive || planned || deployed, 'Uso: npm run verify:docker -- [--interactive | --plan <impact.json> | --deployed <manifest.json>]');
  ensure(process.versions.node.split('.')[0] === '24', 'verify:docker requiere Node major 24.');
  ensure(![candidate, configRoot].some(path => path === '/home/allnutrition/app' || path.startsWith('/home/allnutrition/app/')), 'Checkout de producción prohibido como fuente de pruebas.');
  if (planned) ensure(!process.env.RELEASE_MODE || ['impact', 'full'].includes(process.env.RELEASE_MODE), 'Modo de aceptación inválido');
  const manifest = deployed ? readDeployed(resolve(initialCwd, args[1])) : null;
  plan = planned ? readPlan(resolve(initialCwd, args[1]), candidate) : { build: [], gates: [], node: [], postgres: [], playwright: [], head: manifest?.coveredThrough ?? null, schemaVersion: manifest?.schemaVersion ?? null };
  result.head = plan.head;
  result.mode = deployed ? 'deployed' : mode;
  const required = requiredChecks(plan, mode);
  const has = gate => required.includes(`gate:${gate}`);
  const browser = full || plan.playwright.some(spec => spec !== 'privacy');
  const browserWorker = browser && (full || plan.playwright.some(spec => spec !== 'app:media' && /^(?:app|workbook)(?::|$)/.test(spec)));
  const web = has('https') || has('restore') || has('migration');
  const sandboxed = (full ? readdirSync('tests').map(name => `tests/${name}`) : plan.node).filter(nodeSandboxed);
  const databaseChecks = full || browser || Boolean(plan.postgres.length) || has('postgres') || has('scheduler') || has('migration') || has('restore');
  const checks = databaseChecks || Boolean(sandboxed.length);
  const db = databaseChecks || web;
  const needsDocker = checks || db || Boolean(plan.build.length) || ['runtime', 'runner', 'compose', 'infra', 'harness'].some(has);
  let generated;
  if (needsDocker) {
    run('docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker daemon disponible');
    result.compose = run('docker', ['compose', 'version', '--short'], 'Compose disponible').stdout.trim();
    generated = await prepareProject({ needApp: web || has('runtime') || has('runner') || has('scheduler') || plan.build.includes('app'), needChecks: checks, needDb: db, needBrowser: browser, sandboxed, pair: has('runner'), manifest });
  }
  if (has('harness')) {
    const start = performance.now();
    const test = join(harness, 'tests/release-impact.test.mjs');
    const observed = run('node', ['--test', '--test-reporter=tap', test], 'Selector ante historial Git y Compose real descartable', { cwd: harness, timeout: 300000 });
    const count = tapCount(observed.stdout, 'gate:harness (historial Git)');
    record('gate:harness', start, count + 1);
  }
  if (has('desktop')) {
    const start = performance.now();
    run('npm', ['--prefix', 'desktop', 'ci'], 'Dependencias de empaquetado desktop', { timeout: 600000 });
    run('npm', ['run', 'desktop:package', '--', '--dir'], 'Empaquetado desktop local sin publicar', { timeout: 600000, env: { ...cleanEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    record('gate:desktop', start, 1);
  }
  if (has('audit')) {
    const start = performance.now();
    run('npm', ['audit', '--omit=dev', '--audit-level=high'], 'Auditoría de dependencias de producción', { timeout: 300000 });
    record('gate:audit', start, 1);
  }
  if (has('runtime')) verifyRuntime();
  if (has('compose') || has('infra')) {
    const { start, count } = verifyCompose({ pair: generated, includeProduction: full });
    if (has('compose')) record('gate:compose', start, count);
    if (has('infra')) record('gate:infra', start, count);
  }
  if (has('runner')) verifyPair(manifest);
  if (has('migration') && plan.bases?.schemaVersion > 0 && plan.bases.schemaVersion < plan.schemaVersion) upgrade = rehearseUpgrade(plan.bases.schemaVersion);
  if (full) {
    const start = performance.now();
    run('npm', ['run', 'check'], 'Sintaxis e imports de candidato', { timeout: 300000 });
    const files = readdirSync('tests').map(name => `tests/${name}`).filter(isNodeTest).sort();
    let count = nodeChecks(files);
    if (!deployed && existsSync(join(harness, '.git'))) {
      const observed = run('node', ['--test', '--test-reporter=tap', join(harness, 'tests/release-impact.test.mjs')], 'Contratos del selector en checkout con historial', { cwd: harness });
      count += tapCount(observed.stdout, 'tests/release-impact.test.mjs (historial Git)');
    }
    const groups = [...pgGroups, ...(existsSync('tests/assistant-work-postgres.test.mjs') ? ['assistant-work'] : [])];
    count += pgChecks(groups, false);
    record('full:contracts', start, count);
    nodeChecks(['tests/heka-browser.mjs'], file => `node:${file}`);
  } else {
    nodeChecks(plan.node, file => `node:${file}`);
    if (plan.postgres.length) {
      const start = performance.now();
      const cases = pgChecks(plan.postgres, true);
      if (has('postgres')) record('gate:postgres', start, cases);
    }
  }
  if (web || has('scheduler')) migrateFixture();
  if (web) await verifyWeb({ browser, scheduler: browserWorker, operational: has('migration') || has('restore') });
  else ensure(!browser, 'Los casos Playwright requieren web/HTTPS');
  if (browser) {
    await playwrightChecks(plan.playwright);
    running('web');
    running('db');
    if (browserWorker) running('scheduler');
  }
  if (has('scheduler') || has('migration') || has('restore')) await verifyOperational({ scheduler: has('scheduler'), migration: has('migration'), restore: has('restore'), browserWorker });
  if (deployed) for (const unit of units) checkImage(manifest.services[unit], 'amd64');
  ensure(JSON.stringify(Object.keys(result.checks).sort()) === JSON.stringify(required), 'La evidencia observada no coincide con las compuertas obligatorias.');
  result.exitCode = 0;
} catch (error) {
  result.error = sanitize(error.message);
  console.error(`VERIFICACIÓN FALLIDA: ${result.error}`);
} finally {
  if (createdProject) {
    try {
      for (const [args, file] of [[['logs', '--no-color'], 'containers.log'], [['ps', '--all', '--format', 'json'], 'state.json']]) {
        const captured = compose(args, 'Captura de evidencia de contenedores', { allowFailure: true, quiet: true, cleanup: true });
        writeFileSync(join(artifacts, file), sanitize(captured.stdout + captured.stderr), { mode: 0o600 });
      }
    } catch (error) {
      result.exitCode = 1;
      result.captureError = `No se pudo conservar la evidencia: ${sanitize(error.message)}`;
      result.error ||= result.captureError;
    } finally {
      // project is generated above, never read from user input or an environment file.
      try {
        cleanupProject();
      } catch (error) { result.exitCode = 1; result.cleanupError = sanitize(error.message); result.error ||= result.cleanupError; }
    }
  }
}

if (result.exitCode === 0 && !deployed) {
  try {
    for (const kind of planned ? plan.build : ['app']) {
      const image = outputImages[kind];
      const tag = imageTag(kind, image.imageId);
      const existing = inspectImage(tag, true);
      ensure(!existing || existing.Id === image.imageId, 'Colisión del tag inmutable: ' + tag);
      if (!existing) run('docker', ['image', 'tag', image.imageId, tag], 'Tag inmutable de imagen aceptada');
      ensure(inspectImage(tag).Id === image.imageId, 'Identidad del tag sellado incorrecta');
      result.images[kind] = { ...image, imageTag: tag };
    }
    result.releaseTag = result.images.app?.imageTag;
  } catch (error) { result.exitCode = 1; result.error = sanitize(error.message); }
}
for (const tag of temporaryImages.reverse()) {
  const removed = run('docker', ['image', 'rm', tag], 'Retiro de tag temporal', { cleanup: true, quiet: true, allowFailure: true });
  if (removed.status !== 0 && !/No such image/i.test(removed.stderr || '')) {
    result.exitCode = 1;
    result.error ||= 'No se pudo retirar una imagen temporal';
  }
}
result.finishedAt = new Date().toISOString();
if (artifacts) {
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidencia sanitizada: ${join(artifacts, 'result.json')}`);
}
if (evidencePath) writeFileSync(evidencePath, JSON.stringify({ format: 1, head: result.head, exitCode: result.exitCode, checks: result.checks, images: result.images }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
if (result.exitCode === 0) console.log(`VERIFICACIÓN APROBADA: ${result.mode}; ${Object.keys(result.checks).length} compuertas, ${Object.keys(result.images).length} imágenes selladas.`);
else if (result.error) console.error(result.error);
process.exitCode = result.exitCode;
