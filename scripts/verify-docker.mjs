import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import https from 'node:https';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentEnv } from './deploy-env.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
process.umask(0o077);
const id = randomBytes(8).toString('hex');
const project = `allnutrition-test-${id}`;
const result = { node: process.version, project, startedAt: new Date().toISOString(), tests: [], exitCode: 1 };
const secrets = [];
let values, artifacts, composeArgs, dockerEnv, httpsCA, createdProject = false;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
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
          resolve({ status: response.statusCode, data: json ? JSON.parse(data) : null });
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

try {
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
  compose(['run', '--rm', 'checks', 'npm', 'run', 'check'], 'Sintaxis e imports de la imagen checks');
  passed('npm run check');
  const contracts = compose(['run', '--rm', 'checks', 'npm', 'test'], 'Contratos SQLite y PostgreSQL', { timeout: 180000 });
  ensure(contracts.stdout.includes('Contrato completo con PostgreSQL real') && /(?:skipped 0|# skipped 0)/.test(contracts.stdout), 'El contrato PostgreSQL no se ejecutó o hubo pruebas omitidas.');
  passed('npm test: SQLite y PostgreSQL sin omisiones');
  compose(['run', '--rm', 'checks', 'npm', 'audit', '--omit=dev', '--audit-level=high'], 'Auditoría de dependencias de producción');
  passed('npm audit --omit=dev --audit-level=high');

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
  run('npm', ['run', 'test:e2e'], 'E2E escritorio/móvil y fronteras HTTP', {
    timeout: 300000,
    env: { ...process.env, E2E_BASE_URL: values.APP_URL, E2E_ALLOW_SELF_SIGNED: '1', PLAYWRIGHT_OUTPUT_DIR: result.reports.screenshots, PLAYWRIGHT_HTML_OUTPUT_DIR: result.reports.playwright },
  });
  passed('Playwright desktop/mobile: flujos, cookies, CSRF, Origin, versiones, logout y publicación');

  const operations = command => compose(['run', '--rm', 'checks', 'node', 'tests/docker/operations.mjs', command], `Operaciones PostgreSQL: ${command}`);
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
  compose(['exec', '-T', 'db', 'createdb', '-U', 'postgres', 'allnutrition_restore'], 'Creación exclusiva de una base restore vacía');
  compose(['run', '--rm', '-e', 'PGDATABASE=allnutrition_restore', 'backup', 'pg_restore', '--exit-on-error', '--dbname=allnutrition_restore', `/backups/${backup}`], 'Restore TLS en base distinta');
  compose(['run', '--rm', '-e', 'DATABASE_URL', 'checks', 'node', 'tests/docker/operations.mjs', 'assert'], 'Aceptación de la base restaurada con rol runtime', {
    env: { DATABASE_URL: `postgresql://allnutrition_app:${values.DB_APP_PASSWORD}@db:5432/allnutrition_restore` },
  });
  passed('pg_dump/restore: cuentas, sesiones, replay, numeración, historial y privilegios');

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
