import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import https from 'node:https';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentEnv } from './deploy-env.mjs';
import { createInterface } from 'node:readline';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
process.umask(0o077);
const id = randomBytes(8).toString('hex');
const project = `allnutrition-test-${id}`;
const result = { node: process.version, project, startedAt: new Date().toISOString(), tests: [], exitCode: 1 };
const args = process.argv.slice(2);
const interactive = args.length === 1 && args[0] === '--interactive';
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
function run(binary, args, label, { env = process.env, timeout = 120000, allowFailure = false, quiet = false, cleanup = false, logOutput = true } = {}) {
  if (interrupted && !cleanup) throw new Error('Verificación interrumpida.');
  const executed = spawnSync(binary, args, { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const output = sanitize(`${executed.stdout || ''}${executed.stderr || ''}`);
  if (artifacts) appendFileSync(join(artifacts, 'commands.log'), `\n## ${label}\n${logOutput ? output : ''}`, { mode: 0o600 });
  if (!quiet) { console.log(`\n${label}`); if (output.trim()) console.log(output.trim()); }
  if (!allowFailure && (executed.error || executed.status !== 0)) throw new Error(`${label} falló (${executed.error?.code || executed.signal || executed.status}).`);
  return executed;
}
function compose(args, label, options = {}) {
  createdProject = true;
  return run('docker', [...composeArgs, ...args], label, { ...options, env: { ...dockerEnv, ...options.env } });
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(9443, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function request(path, { method = 'GET', headers = {}, body, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, values.APP_URL), {
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
  const inspected = run('docker', ['image', 'inspect', image], 'Inspección de imagen', { env: dockerEnv || process.env, quiet: true, allowFailure });
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
  compose(['up', '-d', '--no-deps', 'scheduler'], 'Arranque seguro del scheduler en la misma imagen');
  const schedulerId = compose(['ps', '-q', 'scheduler'], 'Identificación del scheduler', { quiet: true }).stdout.trim();
  ensure(schedulerId, 'El scheduler no está ejecutándose.');
  const inspected = JSON.parse(run('docker', ['inspect', schedulerId], 'Aislamiento del scheduler', { quiet: true, logOutput: false }).stdout)[0];
  ensure(inspected.Image === result.imageId && inspected.Config.User === 'node' && Object.values(inspected.NetworkSettings.Ports || {}).every(bindings => !bindings?.length) && Object.keys(inspected.NetworkSettings.Networks).every(network => network === `${project}_backend`), 'Scheduler debe usar la imagen runtime, usuario node, red backend y ningún puerto publicado.');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = workerState();
    if (Date.parse(state.heartbeat?.updated_at) >= startedAt) return state;
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

try {
  ensure(args.length === 0 || interactive, 'Uso: npm run verify:docker -- [--interactive]');
  ensure(process.versions.node.split('.')[0] === '24', 'verify:docker requiere Node major 24.');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker daemon disponible');
  result.compose = run('docker', ['compose', 'version', '--short'], 'Compose disponible').stdout.trim();
  const generated = createDeploymentEnv('test', { id });
  values = generated.values;
  artifacts = values.ARTIFACT_DIR;
  result.reports = { artifacts, playwright: join(artifacts, 'playwright-report'), screenshots: join(artifacts, 'test-results') };
  secrets.push(values.POSTGRES_PASSWORD, values.DB_APP_PASSWORD, values.ADMIN_PASSWORD);
  console.log(`Entorno privado: ${generated.envFile}`);
  await availablePort();
  dockerEnv = { ...process.env };
  // Compose shell precedence must never borrow credentials/paths from a user's deployment.
  for (const key of Object.keys(values)) delete dockerEnv[key];
  composeArgs = ['compose', '-p', project, '--env-file', generated.envFile, '-f', 'compose.yaml', '-f', 'compose.staging.yaml'];
  compose(['config', '--quiet'], 'Validación privada de Compose');
  compose(['build', 'web', 'checks'], 'Build de runtime y checks Node24', { timeout: 600000 });
  const image = inspectImage(values.APP_IMAGE);
  result.imageId = image.Id;
  result.architecture = image.Architecture;
  result.os = image.Os;
  const probe = compose(['run', '--rm', '--no-deps', 'web', 'node', '-e', 'const fs=require("node:fs");if(["@playwright/test","playwright","playwright-core","typescript"].some(n=>fs.existsSync("node_modules/"+n))||process.getuid()!==1000||process.versions.node.split(".")[0]!=="24")process.exit(1);console.log(JSON.stringify({node:process.version,uid:process.getuid()}))'], 'Identidad del runtime y ausencia de devDependencies');
  result.runtime = JSON.parse(probe.stdout.trim());
  passed('runtime Node24 sin herramientas de desarrollo');

  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'db'], 'PostgreSQL TLS saludable');
  compose(['run', '--rm', 'migrate'], 'Migración y aprovisionamiento del rol runtime');
  stopWorker();
  compose(['run', '--rm', 'checks', 'npm', 'run', 'check'], 'Sintaxis e imports de la imagen checks');
  passed('npm run check');
  const contracts = compose(['run', '--rm', 'checks', 'npm', 'test'], 'Contratos SQLite y PostgreSQL', { timeout: 180000 });
  ensure(contracts.stdout.includes('Contrato completo con PostgreSQL real') && /(?:skipped 0|# skipped 0)/.test(contracts.stdout), 'El contrato PostgreSQL no se ejecutó o hubo pruebas omitidas.');
  passed('npm test: SQLite y PostgreSQL sin omisiones');
  compose(['run', '--rm', 'checks', 'npm', 'audit', '--omit=dev', '--audit-level=high'], 'Auditoría de dependencias de producción');
  passed('npm audit --omit=dev --audit-level=high');

  stopWorker();
  compose(['run', '--rm', 'checks', 'node', 'tests/e2e/setup.mjs'], 'Fixture PostgreSQL con doble guarda');
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'web', 'proxy'], 'Arranque del contenedor compilado y HTTPS');
  const root = JSON.parse(compose(['exec', '-T', 'proxy', 'wget', '-qO-', 'http://127.0.0.1:2019/pki/ca/local'], 'Exportación de CA HTTPS pública', { quiet: true, logOutput: false }).stdout).root_certificate;
  ensure(typeof root === 'string' && root.includes('BEGIN CERTIFICATE'), 'Caddy no devolvió su certificado raíz público.');
  httpsCA = root;
  writeFileSync(join(artifacts, 'https-ca.crt'), root, { mode: 0o644 });
  await healthy();
  passed('HTTPS con CA explícita, hostname localhost y salud 200');
  const webId = compose(['ps', '-q', 'web'], 'Identificación del contenedor web', { quiet: true }).stdout.trim();
  const runningImage = run('docker', ['inspect', '--format', '{{.Image}}', webId], 'Identidad de imagen ejecutada', { quiet: true }).stdout.trim();
  ensure(runningImage === result.imageId, 'El contenedor ejecutado no coincide con el imageId construido.');
  await startWorker();
  passed('scheduler real: misma imagen limitada, sin puertos y heartbeat persistido');
  // Import E2E observes the real worker's 60-second idle before parse/preview in both serial projects.
  run('npm', ['run', 'test:e2e'], 'E2E escritorio/móvil y fronteras HTTP', {
    timeout: 600000,
    env: { ...process.env, E2E_BASE_URL: values.APP_URL, E2E_ALLOW_SELF_SIGNED: '1', PLAYWRIGHT_OUTPUT_DIR: result.reports.screenshots, PLAYWRIGHT_HTML_OUTPUT_DIR: result.reports.playwright, PLAYWRIGHT_MEDIA_SMOKE_FILE: join(artifacts, 'media-smoke.json') },
  });
  passed('Playwright desktop/mobile: upload local, render público, límites HTTP, autenticación y CSRF');

  const operations = command => compose(['run', '--rm', 'checks', 'node', 'tests/docker/operations.mjs', command], `Operaciones PostgreSQL: ${command}`);
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
  stopWorker();
  operations('prepare');
  const snapshot = JSON.parse(readFileSync(join(artifacts, 'operational.json'), 'utf8'));
  secrets.push(snapshot.session.token, snapshot.session.csrf, snapshot.account.password);
  compose(['run', '--rm', 'migrate'], 'Repetición de migración con datos y sesiones existentes');
  operations('assert');
  passed('migración idempotente, runtime sin DDL, sesión y pedido 119000');
  operations('reject-insecure');
  passed('rechazo de CA equivocada y de PostgreSQL TCP sin TLS');
  const headers = { Cookie: `allnutrition_session=${snapshot.session.token}`, 'x-csrf-token': snapshot.session.csrf, Origin: values.APP_URL };
  const before = await request('/api/admin/orders', { headers });
  ensure(before.status === 200 && before.data.total === snapshot.orderCount, 'La sesión operativa no puede leer los pedidos iniciales.');
  compose(['stop', 'db'], 'Caída real de PostgreSQL');
  ensure((await request('/api/health')).status === 503, 'La caída de DB no devolvió salud 503.');
  const outage = await request('/api/admin/orders', { method: 'POST', headers, body: { ...snapshot.payload, requestId: randomUUID() } });
  ensure(outage.status === 503, `El guardado autenticado durante la caída devolvió ${outage.status}, no 503.`);
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'db'], 'Recuperación de PostgreSQL');
  await healthy();
  const after = await request('/api/admin/orders', { headers });
  ensure(after.status === 200 && after.data.total === before.data.total, 'El guardado rechazado apareció como pedido o la sesión dejó de funcionar.');
  passed('outage: health y POST autenticado 503; recuperación sin pedidos adicionales');
  compose(['restart', 'web', 'db'], 'Reinicio de aplicación y base');
  await healthy();
  operations('assert');
  const mediaSmoke = JSON.parse(readFileSync(join(artifacts, 'media-smoke.json'), 'utf8'));
  const persistedMedia = await request(mediaSmoke.url);
  ensure(persistedMedia.status === 200 && persistedMedia.contentType.startsWith('image/webp'), 'La imagen local dejó de servirse después del reinicio de web/DB.');
  passed('imagen WebP local disponible y servida tras restart web/db');
  passed('persistencia y sesiones tras restart web/db');

  const oldBackups = new Set(readdirSync(values.BACKUP_DIR));
  compose(['run', '--rm', 'backup'], 'Backup TLS pg_dump de la base descartable');
  const newBackups = readdirSync(values.BACKUP_DIR).filter(file => !oldBackups.has(file));
  ensure(newBackups.length === 1 && /^allnutrition-\d{8}T\d{6}Z\.dump$/.test(newBackups[0]), 'No se identificó un único dump nuevo.');
  const backup = newBackups[0];
  const metadata = statSync(join(values.BACKUP_DIR, backup));
  ensure(metadata.size > 0 && (metadata.mode & 0o777) === 0o600, 'El dump está vacío o no tiene permisos 0600.');
  result.backup = join(values.BACKUP_DIR, backup);
  compose(['stop', 'web'], 'Detención de web antes del restore');
  stopWorker();
  compose(['exec', '-T', 'db', 'createdb', '-U', 'postgres', 'allnutrition_restore'], 'Creación exclusiva de una base restore vacía');
  compose(['run', '--rm', '-e', 'PGDATABASE=allnutrition_restore', 'backup', 'pg_restore', '--exit-on-error', '--dbname=allnutrition_restore', `/backups/${backup}`], 'Restore TLS en base distinta');
  compose(['run', '--rm', '-e', 'DATABASE_URL', 'checks', 'node', 'tests/docker/operations.mjs', 'assert'], 'Aceptación de la base restaurada con rol runtime', {
    env: { DATABASE_URL: `postgresql://allnutrition_app:${values.DB_APP_PASSWORD}@db:5432/allnutrition_restore` },
  });
  passed('pg_dump/restore: cuentas, sesiones, replay, numeración, historial y privilegios');
  const webMounts = JSON.parse(run('docker', ['inspect', webId], 'Volumen de imágenes separado del dump', { quiet: true, logOutput: false }).stdout)[0].Mounts;
  ensure(webMounts.some(mount => mount.Type === 'volume' && mount.Destination === '/app/data/product-images' && mount.Name === `${project}_product_images`), 'Las imágenes deben persistir en su volumen propio, no en pg_dump.');
  compose(['up', '-d', '--wait', '--wait-timeout', '120', 'web'], 'Reapertura de web tras restore aislado');
  await healthy();
  const mediaAfterRestore = await request(mediaSmoke.url);
  ensure(mediaAfterRestore.status === 200 && mediaAfterRestore.contentType.startsWith('image/webp'), 'El volumen separado de imágenes no conserva el archivo tras el procedimiento de restore.');
  passed('pg_dump conserva negocio v3; archivo WebP permanece en volumen separado');
  await startWorker();
  passed('scheduler vuelve a funcionar tras caída/reinicio y restore aislado');

  const syntaxEnv = { APP_DOMAIN: 'production.example.invalid', APP_URL: 'https://production.example.invalid' };
  compose(['-f', 'compose.production.yaml', 'config', '--quiet'], 'Sintaxis del override de producción', { env: syntaxEnv });
  compose(['-f', 'compose.production.yaml', 'run', '--rm', '--no-deps', 'proxy', 'caddy', 'adapt', '--adapter', 'caddyfile', '--config', '/etc/caddy/Caddyfile'], 'Adaptación Caddy de producción sin iniciar ACME', { env: syntaxEnv, quiet: true });
  passed('Compose/Caddy producción: fixture de sintaxis sin publicación');
  result.images = {};
  for (const tag of [values.APP_IMAGE, 'allnutrition-checks:node24-local', 'postgres:16-bookworm', 'caddy:2-alpine']) {
    const image = inspectImage(tag);
    result.images[tag] = { imageId: image.Id, architecture: image.Architecture, os: image.Os };
  }
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
      result.error = `No se pudo conservar la evidencia: ${sanitize(error.message)}`;
    } finally {
      // project is generated above, never read from user input or an environment file.
      try {
        const cleanup = compose(['down', '--volumes', '--remove-orphans'], 'Eliminación exclusiva del proyecto descartable', { allowFailure: true, cleanup: true });
        ensure(cleanup.status === 0 && !cleanup.error, 'No se pudo completar la limpieza del proyecto descartable.');
      } catch (error) { result.exitCode = 1; result.error = sanitize(error.message); }
    }
  }
}

if (result.exitCode === 0) {
  try {
    const tag = `allnutrition:release-${result.imageId.replace(/^sha256:/, '').slice(0, 12)}`;
    const existing = inspectImage(tag, true);
    ensure(!existing || existing.Id === result.imageId, 'El tag inmutable ya apunta a otra imagen; no se reemplazó.');
    if (!existing) run('docker', ['image', 'tag', result.imageId, tag], 'Promoción local de la imagen comprobada');
    ensure(inspectImage(tag).Id === result.imageId, 'La imagen promovida no coincide con el release verificado.');
    result.releaseTag = tag;
  } catch (error) { result.exitCode = 1; result.error = sanitize(error.message); }
}
result.finishedAt = new Date().toISOString();
if (artifacts) {
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidencia sanitizada: ${join(artifacts, 'result.json')}`);
}
if (result.exitCode === 0) console.log(`VERIFICACIÓN APROBADA: ${result.releaseTag} (${result.architecture}).`);
else if (result.error) console.error(result.error);
process.exitCode = result.exitCode;
