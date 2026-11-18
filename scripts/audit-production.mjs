import { spawnSync } from 'node:child_process';
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkRuntime, privateJSON, publicState, requireLive, requireThat, same, sha, sha256, smoke } from './production-host.mjs';
import { hashFile, host, origin, releaseCache, run } from './production-release.mjs';
import { ensureBuilderImages } from './production-recovery.mjs';
import { requiredChecks } from './release-impact.mjs';

const auditRoot = '/var/lib/allnutrition-audit';
const toolchain = '/home/allnutrition/native-toolchain-91b7ab6b';
const latest = join(auditRoot, 'last.json');
const currentStatus = join(releaseCache(), 'audit-status.json');
const uid = 1000, gid = 1000;

function store(report, record = false) {
  privateJSON(latest, report);
  if (record) privateJSON(join(auditRoot, 'reports', report.startedAt.replaceAll(':', '-') + '.json'), report);
  // Mirror only operational evidence readable by the release operator; the cache and journal stay private.
  privateJSON(currentStatus, report);
}
function snapshot() {
  const live = host('inspect', {}, { localBastion: true });
  const manifest = publicState(live.current?.manifest);
  requireLive(manifest, live, { strictPins: live.current.kind !== 'inventory' });
  checkRuntime(live);
  return { manifest, live };
}
async function source(commit, work) {
  requireThat(sha.test(commit), 'Falta fuente comprobada de la unidad desplegada.');
  const stored = join(releaseCache(), 'cache', 'sources', commit);
  const paths = readdirSync(stored).filter(file => /^([a-f0-9]{64})\.tar\.gz$/.test(file)).sort();
  requireThat(paths.length > 0, 'Falta archivo de fuente retenido para el SHA desplegado.');
  const archive = join(stored, paths[0]);
  requireThat(lstatSync(archive).isFile() && await hashFile(archive) === paths[0].slice(0, 64), 'Archivo de fuente alterado en caché.');
  requireThat(run('sh', ['-c', 'gzip -dc "$1" | git get-tar-commit-id', 'sh', archive]).trim() === commit, 'El tar de fuente no acredita el SHA en ejecución.');
  const output = join(work, commit);
  mkdirSync(output, { mode: 0o700 });
  run('tar', ['--no-same-owner', '-xzf', archive, '-C', output], { timeout: 180_000 });
  return output;
}
async function suite(manifest) {
  const testDaemon = process.env.ALLNUTRITION_AUDIT_DOCKER_HOST, builderPrefix = process.env.ALLNUTRITION_AUDIT_BUILDER;
  requireThat(/^unix:\/\/\/(?:run|var\/run)\/[a-zA-Z0-9/_-]+\.sock$/.test(testDaemon ?? '') && /^[a-z0-9][a-z0-9-]{1,25}$/.test(builderPrefix ?? ''), 'Configurar socket rootless y prefijo Buildx exclusivo de auditoría.');
  const socket = statSync(testDaemon.slice(7));
  requireThat(socket.isSocket() && socket.uid === uid, 'El socket de auditoría debe pertenecer al usuario aislado UID 1000.');
  const work = mkdtempSync('/tmp/allnutrition-weekly-');
  const clean = join(work, 'home'), evidence = join(work, 'evidence.json');
  const auditBuilder = `${builderPrefix}-${work.split('-').at(-1).toLowerCase()}`;
  try {
    const sources = new Map();
    for (const commit of new Set([manifest.coveredThrough, manifest.configCommit, ...Object.values(manifest.services).map(service => service.sourceCommit)])) sources.set(commit, await source(commit, work));
    const candidate = sources.get(manifest.coveredThrough), config = sources.get(manifest.configCommit);
    for (const [path, expected] of Object.entries(manifest.configHashes)) requireThat(sha256(readFileSync(join(config, path))) === expected, `Configuración de ensayo difiere de producción: ${path}.`);
    requireThat(existsSync(join(candidate, 'scripts/release-test-plan.mjs')), 'La fuente desplegada no tiene banco de pruebas para identidades selladas.');
    const dockerEnv = { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', DOCKER_HOST: testDaemon };
    const probe = spawnSync('docker', ['info', '--format', '{{.OSType}} {{.Architecture}} {{json .SecurityOptions}}'], { env: dockerEnv, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    requireThat(probe.status === 0 && /linux (?:x86_64|amd64).*rootless/.test(probe.stdout), 'La suite requiere Docker rootless Linux amd64 dedicado en el constructor.');
    const previous = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = testDaemon;
    try { ensureBuilderImages(manifest, { local: true }); }
    finally { if (previous === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previous; }
    const serviceSources = Object.fromEntries(Object.entries(manifest.services).map(([service, ref]) => [service, sources.get(ref.sourceCommit)]));
    const target = join(work, 'manifest.json');
    privateJSON(target, manifest);
    mkdirSync(clean, { mode: 0o700 });
    mkdirSync(join(work, 'toolchain'), { mode: 0o700 });
    run('chown', ['-R', `${uid}:${gid}`, work]);
    // The SSH collector's environment and route/key directories are not visible to the test process.
    const test = `set -eu
      npm ci
      npx --no-install playwright install chromium
      docker buildx create --name "$BUILDX_BUILDER" --driver docker-container >/dev/null
      trap 'docker buildx rm "$BUILDX_BUILDER" >/dev/null' EXIT
      npm run verify:docker -- --deployed "$NATIVE_ROOT/manifest.json"`;
    const isolate = `set -eu
      mount --bind "$1" "$2/toolchain"
      for path in /home /root /etc/allnutrition-audit /var/lib/allnutrition-audit; do
        if test -d "$path"; then mount -t tmpfs -o mode=000,nosuid,nodev,noexec tmpfs "$path"; fi
      done
      cd "$3"
      exec nice -n 15 setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs -- env -i \
        PATH="$2/toolchain/bin:/usr/bin:/bin" HOME="$2/home" LANG=C.UTF-8 CI=true NATIVE_ROOT="$2" \
        DOCKER_HOST="$4" BUILDX_BUILDER="$5" RELEASE_CONFIG_ROOT="$6" RELEASE_EVIDENCE_FILE="$7" \
        RELEASE_SERVICE_ROOTS="$8" PLAYWRIGHT_BROWSERS_PATH="$2/chromium" NEXT_TELEMETRY_DISABLED=1 \
        bash -euo pipefail -c "$9"`;
    const result = spawnSync('unshare', ['--mount', '--propagation', 'private', 'bash', '-c', isolate, 'bash', toolchain, work, candidate, testDaemon, auditBuilder, config, evidence, JSON.stringify(serviceSources), test], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: work, stdio: 'ignore', timeout: 5 * 60 * 60_000
    });
    const proof = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) : null;
    requireThat(result.status === 0 && proof?.exitCode === 0 && proof.head === manifest.coveredThrough && Object.keys(proof.checks).length > 0, `Suite aislada rechazada (${result.error?.code ?? result.status ?? result.signal}); revisar constructor.`);
    const required = requiredChecks({}, 'full');
    requireThat(required.every(check => Number.isSafeInteger(proof.checks[check]?.count) && proof.checks[check].count > 0), 'El informe no acredita todas las compuertas de revisión integral.');
    const expected = Object.fromEntries(Object.entries(manifest.services).map(([service, ref]) => [service, ref.imageId]));
    requireThat(same(proof.checks['gate:runner'].images, expected), 'El informe no acredita el conjunto mixto de IDs observado.');
    return { checks: Object.fromEntries(Object.entries(proof.checks).map(([check, { count, durationMs }]) => [check, { count, durationMs }])), sources: Object.fromEntries(sources.keys().map((sha) => [sha, true])) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function audit() {
  requireThat(process.platform === 'linux' && process.arch === 'x64' && process.getuid() === 0 && process.versions.node.startsWith('24.') && !existsSync('/home/allnutrition/app/.env.server.local'), 'Auditor reservado al recolector Linux amd64 Node24 del constructor, no a la VM.');
  const vmIdentity = realpathSync(process.env.ALLNUTRITION_VM_KEY || '/etc/allnutrition-audit/missing');
  const key = lstatSync(vmIdentity);
  requireThat(vmIdentity.startsWith('/etc/allnutrition-audit/') && key.isFile() && key.uid === 0 && (key.mode & 0o077) === 0, 'La identidad del recolector debe permanecer fuera del acceso del usuario de pruebas.');
  mkdirSync(join(auditRoot, 'reports'), { recursive: true, mode: 0o700 });
  requireThat(lstatSync(auditRoot).isDirectory() && (lstatSync(auditRoot).mode & 0o077) === 0, 'Estado de auditoría no es privado.');
  for (;;) {
    let report = { format: 1, status: 'running', stage: 'inventory', startedAt: new Date().toISOString() };
    try {
      store(report);
      const { manifest, live } = snapshot();
      report = { ...report, manifest, observedAt: live.observedAt, stage: 'live-https', heartbeat: live.schema.heartbeat, recentFailures: live.schema.recentFailures };
      store(report);
      report.probes = await smoke(origin, { bootstrap: manifest.schemaVersion < 15 });
      report.stage = 'disposable-suite';
      store(report);
      report.suite = await suite(manifest);
      report.stage = 'closing-inventory';
      store(report);
      const closed = snapshot();
      const superseded = !same(closed.manifest, manifest) || Object.keys(live.containers).some(name => closed.live.containers[name].id !== live.containers[name].id);
      report = { ...report, status: superseded ? 'superseded' : 'passed', stage: 'complete', finishedAt: new Date().toISOString(), closingManifest: closed.manifest };
      store(report, true);
      if (!superseded) return;
      await delay(10_000);
    } catch (error) {
      report = { ...report, status: 'failed', finishedAt: new Date().toISOString(), error: error.message.replace(/[\r\n]+/g, ' ').slice(0, 240) };
      store(report, true);
      throw error;
    }
  }
}
try { process.umask(0o077); await audit(); }
catch (error) { console.error(error.message.replace(/[\r\n]+/g, ' ').slice(0, 240)); process.exitCode = 1; }
