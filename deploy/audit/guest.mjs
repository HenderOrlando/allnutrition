import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const uid = 1000, gid = 1000;
const wireSha = /^[a-f0-9]{40}$/, imageId = /^sha256:[a-f0-9]{64}$/;
const services = ['web', 'scheduler', 'social-browser-worker', 'social-browser', 'db'];
const files = ['compose.yaml', 'compose.nginx.yaml', 'deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh', 'deploy/social-browser-seccomp.json'];
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', DOCKER_HOST: 'unix:///var/run/docker.sock' };
let stage = 'isolation';
class GuestFailure extends Error {}
function command(bin, argv, { timeout = 120_000, capture = false, cwd, environment = env, reportFailure = false, captureError = false } = {}) {
  const result = spawnSync(bin, argv, { cwd, env: environment, encoding: 'utf8', maxBuffer: 512 * 1024, stdio: ['ignore', capture ? 'pipe' : 'ignore', captureError ? 'pipe' : 'ignore'], timeout });
  if (result.error) throw new GuestFailure(result.error.code === 'ENOENT' ? 'exec-missing' : result.error.code === 'ETIMEDOUT' ? 'exec-timeout' : 'exec-error');
  if (reportFailure) return result;
  if (result.status !== 0) throw new GuestFailure('command-failed');
  return result.stdout;
}

function mountInput(mount) {
  assert.equal(command('/usr/sbin/blockdev', ['--getro', '/dev/vdb'], { capture: true }).trim(), '1');
  assert.equal(command('/usr/sbin/blkid', ['-s', 'LABEL', '-o', 'value', '/dev/vdb'], { capture: true }).trim(), 'ALLNUTRITION_AUDIT');
  command('mount', ['-t', 'iso9660', '-o', 'ro,nosuid,nodev,noexec', '/dev/vdb', mount]);
}

function pairProof({ status, stdout }) {
  let proof;
  try { proof = JSON.parse(stdout); }
  catch { throw new GuestFailure('invalid-evidence'); }
  if (status === 0 && proof?.accepted === true && proof.zeroOwnedLeftovers === true) {
    return { accepted: true, zeroOwnedLeftovers: true, images: proof.images };
  }
  const message = proof?.failure?.message;
  // Only classifications derived from known native failure messages cross QGA.
  if (typeof message === 'string') {
    if (/^Command failed: .+ \(ETIMEDOUT\); see private diagnostics$/.test(message)) throw new GuestFailure('pair-timeout');
    if (/^Command failed: docker compose \([0-9]+\); see private diagnostics$/.test(message)) throw new GuestFailure('pair-compose');
    if (/^Command failed: docker [a-z-]+ \([0-9]+\); see private diagnostics$/.test(message)) throw new GuestFailure('pair-docker');
    if (/^(?:Missing image identity: |Running image identity mismatch: )/.test(message) || ['Immutable Linux/amd64 node image required', 'PostgreSQL image identity mismatch', 'Loaded image identity changed during pair acceptance'].includes(message)) throw new GuestFailure('pair-identity');
    if (/^Runner (?:sandbox isolation weakened|seccomp differs from product|tmpfs\/shm isolation mismatch|egress must be internal)$/.test(message)) throw new GuestFailure('pair-sandbox');
    if (/^(?:Worker heartbeats|Continued worker heartbeats|Runner key readiness) did not reach required state$/.test(message)) throw new GuestFailure('pair-timeout');
    if (/^Private probe failed in (?:web|scheduler|social-browser(?:-worker)?); see failed-probe diagnostics$/.test(message)) throw new GuestFailure('pair-service');
  }
  throw new GuestFailure(proof?.zeroOwnedLeftovers === false ? 'pair-cleanup' : 'pair-rejected');
}

function loadImage(archive, failure) {
  const result = command('docker', ['image', 'load', '--quiet', '--input', archive],
    { timeout: 30 * 60_000, captureError: true, reportFailure: true });
  if (result.status === 0) return;
  const error = result.stderr;
  if (/no space left on device|disk quota exceeded/i.test(error)) throw new GuestFailure(`${failure}-space`);
  if (/unexpected eof|invalid tar|invalid checksum|failed to decompress|archive\/tar/i.test(error)) throw new GuestFailure(`${failure}-archive`);
  if (/failed to (?:extract|unpack)|snapshotter/i.test(error)) throw new GuestFailure(`${failure}-unpack`);
  throw new GuestFailure(failure);
}

function verifyImage(id) {
  const result = command('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', id], { capture: true, reportFailure: true });
  if (result.status !== 0) throw new GuestFailure('image-inspect');
  if (result.stdout.trim() !== `${id} linux amd64`) throw new GuestFailure('image-identity');
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function membersEqual(left, right) { return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()); }

async function auditGuest() {
  assert(process.platform === 'linux' && process.arch === 'x64' && process.getuid() === 0 && process.versions.node.startsWith('24.'));
  assert(!existsSync('/home/allnutrition/app') && !existsSync('/etc/allnutrition-audit/production.env'));
  const account = command('getent', ['passwd', String(uid)], { capture: true }).trim().split(':');
  assert.equal(account[0], 'allnutrition-audit');
  assert.equal(account[3], String(gid));
  const dockerGid = command('getent', ['group', 'docker'], { capture: true }).split(':')[2];
  assert(/^[1-9]\d*$/.test(dockerGid));
  const socket = lstatSync('/run/docker.sock');
  assert(socket.isSocket() && socket.uid === 0 && socket.gid === Number(dockerGid));
  const security = JSON.parse(command('docker', ['info', '--format', '{{json .SecurityOptions}}'], { capture: true }));
  assert(Array.isArray(security) && security.every(option => !/^name=(?:userns|rootless)(?:,|$)/.test(option)));

  const work = mkdtempSync('/tmp/allnutrition-weekly-');
  const mount = join(work, 'input'), writable = join(work, 'run');
  let mounted = false;
  try {
    stage = 'media';
    mkdirSync(mount, { mode: 0o700 });
    mkdirSync(writable, { mode: 0o700 });
    // The transient domain defines vdb as the only input, readonly and without a share.
    mountInput(mount);
    mounted = true;
    const snapshotPath = join(mount, 'snapshot.json');
    assert(lstatSync(snapshotPath).isFile() && lstatSync(snapshotPath).size < 65_536);
    const { format, mode, manifest, hashes, bundleIds } = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert(['pair', 'full'].includes(mode));
    assert(format === 1 && manifest.format === 1 && membersEqual(Object.keys(manifest.services), services));
    assert(Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion > 0 && membersEqual(Object.keys(manifest.configHashes), files));
    const commits = [...new Set([manifest.coveredThrough, manifest.configCommit, ...(mode === 'full' ? Object.values(manifest.services).map(ref => ref.sourceCommit) : [])])];
    const ids = [...new Set(Object.values(manifest.services).map(ref => ref.imageId))];
    assert(commits.every(commit => wireSha.test(commit)) && ids.every(id => imageId.test(id)));
    assert(Array.isArray(bundleIds) && bundleIds.every(id => ids.includes(id)) && (mode === 'pair' || !bundleIds.length));
    const names = [...commits.map(commit => `source-${commit}.tar.gz`), ...ids.filter(id => !bundleIds.includes(id)).map(id => `image-${id.slice(7)}.tar.gz`), ...(bundleIds.length ? ['bundle.tar.gz'] : [])];
    assert(membersEqual(Object.keys(hashes), names));
    for (const name of names) {
      const path = join(mount, name);
      assert(lstatSync(path).isFile() && await hash(path) === hashes[name]);
    }

    stage = 'images';
    if (bundleIds.length) loadImage(join(mount, 'bundle.tar.gz'), 'bundle-load');
    for (const id of ids) {
      if (!bundleIds.includes(id)) loadImage(join(mount, `image-${id.slice(7)}.tar.gz`), id === manifest.services.db.imageId ? 'db-load' : 'image-load');
      verifyImage(id);
    }
    stage = 'sources';
    const paths = new Map();
    for (const commit of commits) {
      const archive = join(mount, `source-${commit}.tar.gz`), path = join(writable, commit);
      assert.equal(command('bash', ['-c', 'git get-tar-commit-id < <(gzip -dc "$1")', 'audit', archive], { capture: true }).trim(), commit);
      mkdirSync(path, { mode: 0o700 });
      command('tar', ['--no-same-owner', '-xzf', archive, '-C', path], { timeout: 180_000 });
      paths.set(commit, path);
    }
    const candidate = paths.get(manifest.coveredThrough), config = paths.get(manifest.configCommit);
    for (const name of files) assert.equal(await hash(join(config, name)), manifest.configHashes[name]);
    const manifestPath = join(writable, 'manifest.json'), evidence = join(writable, 'evidence.json'), home = join(writable, 'home');
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    mkdirSync(home, { mode: 0o700 });
    command('chown', ['-hR', `${uid}:${gid}`, writable]);
    chownSync(work, uid, gid);
    const serviceSources = Object.fromEntries(Object.entries(manifest.services).map(([name, ref]) => [name, paths.get(ref.sourceCommit)]));
    const builder = 'allnutrition-audit';
    const testEnv = { ...env, HOME: home, CI: 'true', NATIVE_ROOT: writable, BUILDX_BUILDER: builder, RELEASE_CONFIG_ROOT: config, RELEASE_EVIDENCE_FILE: evidence,
      RELEASE_SERVICE_ROOTS: JSON.stringify(serviceSources), PLAYWRIGHT_BROWSERS_PATH: join(writable, 'chromium'), NEXT_TELEMETRY_DISABLED: '1' };
    const execute = (program, argv, timeout, options = {}) => command('setpriv', ['--reuid=1000', '--regid=1000', `--groups=${dockerGid}`, '--no-new-privs', '--', program, ...argv],
      { timeout, cwd: candidate, environment: testEnv, ...options });
    if (mode === 'pair') {
      stage = 'pair';
      return pairProof(execute('node', ['tests/native/browser-acceptance.mjs', 'pair', manifestPath], 900_000, { capture: true, reportFailure: true }));
    }
    stage = 'npm';
    execute('npm', ['ci'], 600_000);
    stage = 'chromium';
    execute('npx', ['--no-install', 'playwright', 'install', 'chromium'], 600_000);
    stage = 'builder';
    execute('docker', ['buildx', 'create', '--name', builder, '--driver', 'docker-container', '--bootstrap'], 600_000);
    stage = 'verification';
    execute('npm', ['run', 'verify:docker', '--', '--deployed', manifestPath], 4.5 * 60 * 60_000);
    stage = 'evidence';
    assert(lstatSync(evidence).isFile() && lstatSync(evidence).size < 120_000);
    return JSON.parse(readFileSync(evidence, 'utf8'));
  } finally {
    if (mounted) command('umount', [mount]);
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  process.umask(0o077);
  console.log(JSON.stringify(await auditGuest()));
} catch (error) {
  const code = error instanceof GuestFailure ? error.message : error instanceof SyntaxError ? 'invalid-evidence' : 'guard-rejected';
  console.error(`audit-guest:${stage}:${code}`);
  process.exitCode = 1;
}
