import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { activeFiles, hash, imageId, publicState, requireThat, same, serviceOrder, sha, sha256, stateRoot } from './production-host.mjs';

export const repo = 'HenderOrlando/allnutrition';
export const origin = 'https://allnutrition.wintimeapp.co';
export const sourceRoot = new URL('../', import.meta.url);
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
const requiredOption = name => {
  const value = process.env[name];
  requireThat(typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value), `Falta configurar ${name}.`);
  return value;
};
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const shell = args => args.map(quote).join(' ');
export const releaseCache = () => process.env.ALLNUTRITION_BUILDER_CACHE || '/home/allnutrition/.local/state/allnutrition-release';
const safeCacheKey = value => /^((?:sources|bundles|images)\/[a-f0-9]{40,64}(?:\/[a-f0-9]{64})?\.tar\.gz|audit-status\.json)$/.test(value);
const runner = source => spawnSync('ssh', source.args, { encoding: 'utf8', ...source.options });
export function run(program, args, { cwd = sourceRoot, input, optional = false, encoding = 'utf8', timeout = 120_000 } = {}) {
  const result = spawnSync(program, args, { cwd, input, encoding, timeout, maxBuffer: 32 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  if (optional && result.status !== 0) return null;
  requireThat(result.status === 0, `${program} ${args[0]}: ${result.error?.code ?? `salida ${result.status ?? result.signal}`}.`);
  return result.stdout;
}
function target(which) {
  const name = requiredOption(`ALLNUTRITION_${which}`), key = requiredOption(`ALLNUTRITION_${which}_KEY`);
  requireThat(/^(?:[\w.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(name) && key.startsWith('/'), `Destino o ruta SSH no válida: ${which}.`);
  return [...sshOptions, '-i', key, '--', name];
}
export const builderArgs = command => [...target('BASTION'), command];
export function vmArgs(command, localBastion = false) {
  const next = [...target('VM'), command];
  return localBastion ? next : builderArgs(shell(['ssh', ...next]));
}
export function hostCommand(operation, input) {
  const code = readFileSync(new URL('./production-host.mjs', import.meta.url), 'utf8');
  // Node reserves a first positional argument of `inspect` even with -e.
  const args = shell(['env', 'ALLNUTRITION_PRODUCTION_HOST=1', 'node', '--input-type=module', '-e', code, '--', 'production-host', operation, Buffer.from(JSON.stringify(input)).toString('base64url')]);
  const lock = quote(join(stateRoot, 'production.lock'));
  if (operation === 'inspect' || operation === 'status') return `if test -f ${lock}; then exec flock -s -w 10 ${lock} ${args}; else exec ${args}; fi`;
  return `set -eu; umask 077; install -d -m 0700 ${quote(stateRoot)}; exec flock -x -w 10 ${lock} ${args}`;
}
export function host(operation = 'inspect', input = {}, { localBastion = false, timeout = 120_000 } = {}) {
  const result = runner({ args: vmArgs(hostCommand(operation, input), localBastion), options: { timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] } });
  requireThat(result.status === 0, `VM ${operation}: ${result.status === 1 ? result.stderr.trim() : result.error?.code ?? result.status ?? result.signal}.`);
  return JSON.parse(result.stdout);
}
export function remoteStream(args) {
  const process = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  process.stderr.on('data', data => { if (stderr.length < 20) stderr.push(data); });
  // EPIPE on an early remote rejection is reflected by the child's exit status.
  process.stdin.on('error', () => {});
  const exit = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`SSH: ${code === 1 ? Buffer.concat(stderr).toString().trim() : code ?? signal}.`)));
  });
  exit.catch(() => {});
  return { process, exit };
}
export async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function cachePut(path, key, digest) {
  requireThat(safeCacheKey(key) && hash.test(digest), 'Identificador de caché inválido.');
  const dest = join(releaseCache(), 'cache', key);
  const cm = `set -eu; umask 077; dir=${quote(join(dest, '..'))}; dest=${quote(dest)}; hash=${quote(digest)}; mkdir -p "$dir"; tmp=$(mktemp "$dir/.input-XXXXXX"); trap 'rm -f "$tmp"' EXIT; cat >"$tmp"; test "$(sha256sum "$tmp" | cut -d ' ' -f 1)" = "$hash"; if test -e "$dest"; then test "$(sha256sum "$dest" | cut -d ' ' -f 1)" = "$hash"; else mv -T "$tmp" "$dest"; fi`;
  const { process, exit } = remoteStream(builderArgs(cm));
  process.stdout.resume();
  await Promise.all([pipeline(createReadStream(path), process.stdin), exit]);
}
export async function loadFromBuilder(key, { token, sha256: digest, bytes, images }) {
  requireThat(safeCacheKey(key) && hash.test(digest), 'Artefacto de imágenes inválido.');
  const recv = shell(['ssh', ...target('VM'), hostCommand('receive-image', { token, sha256: digest, bytes, images })]);
  const remote = runner({ args: builderArgs(`set -euo pipefail; cat ${quote(join(releaseCache(), 'cache', key))} | ${recv}`), options: { timeout: 1_800_000, stdio: ['ignore', 'pipe', 'pipe'] } });
  requireThat(remote.status === 0 && JSON.parse(remote.stdout).loaded === true, `Carga de imágenes en VM falló: ${remote.stderr?.trim() || remote.error?.code || remote.status}.`);
}
export function auditStatus() {
  const path = quote(join(releaseCache(), 'audit-status.json'));
  return JSON.parse(run('ssh', builderArgs(`if test -f ${path}; then cat ${path}; else printf 'null\\n'; fi`), { timeout: 30_000 }));
}
export const github = (endpoint, args = [], data) => {
  const raw = run('gh', ['api', endpoint, ...args, ...(data ? ['--input', '-'] : [])], { input: data && JSON.stringify(data) });
  return raw.trim() ? JSON.parse(raw) : null;
};
export function latestProduction() {
  const pages = github(`repos/${repo}/deployments?environment=production&per_page=100`, ['--paginate', '--slurp']);
  for (const deployment of pages.flat()) {
    const [latest] = github(`repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
    if (latest?.state !== 'success') continue;
    const payload = typeof deployment.payload === 'string' ? JSON.parse(deployment.payload) : deployment.payload;
    const manifest = publicState(payload);
    requireThat(deployment.sha === manifest.coveredThrough && deployment.environment === 'production' && same(payload, manifest), 'Registro exitoso no acredita su manifiesto público.');
    return { ...manifest, deploymentId: String(deployment.id) };
  }
  return null;
}
export function publishProduction(manifest, kind) {
  manifest = publicState(manifest);
  const deployments = github(`repos/${repo}/deployments?environment=production&sha=${manifest.coveredThrough}&per_page=100`);
  let deployment = deployments.find(item => same(typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload, manifest));
  if (deployment) {
    const [last] = github(`repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
    if (last?.state === 'success') return String(deployment.id);
  } else {
    deployment = github(`repos/${repo}/deployments`, ['-X', 'POST'], {
      ref: manifest.coveredThrough, task: kind === 'inventory' ? 'inventory' : 'deploy', auto_merge: false, required_contexts: [],
      environment: 'production', production_environment: true, transient_environment: false, payload: manifest
    });
  }
  github(`repos/${repo}/deployments/${deployment.id}/statuses`, ['-X', 'POST'], { state: 'success', environment: 'production', environment_url: origin, auto_inactive: false });
  return String(deployment.id);
}
export function remoteMain() {
  const remote = run('git', ['remote', 'get-url', 'origin']).trim().replace(/\.git$/i, '').toLowerCase();
  requireThat([`https://github.com/${repo}`, `git@github.com:${repo}`, `ssh://git@github.com/${repo}`].some(url => url.toLowerCase() === remote), 'origin no corresponde al repositorio de producción.');
  const output = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).trim();
  const [head, ref] = output.split(/\s+/);
  requireThat(sha.test(head) && ref === 'refs/heads/main', 'No se pudo resolver main remoto.');
  return head;
}
function history(head) {
  const response = github(`repos/${repo}/actions/runs?head_sha=${head}&branch=main&per_page=100`, ['--paginate', '--slurp']);
  return response.flatMap(page => page.workflow_runs).filter(run => run.head_sha === head && run.head_branch === 'main' && run.head_repository?.full_name?.toLowerCase() === repo.toLowerCase() && (
    run.event === 'push' && run.path.split('@')[0] === '.github/workflows/ci.yml' || run.event === 'workflow_dispatch' && run.path.split('@')[0] === '.github/workflows/native-acceptance.yml'
  ));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function candidateBundle({ head, dir, base, allowDispatch, validate }) {
  const tried = new Set();
  let dispatched = false;
  const until = Date.now() + 3 * 60 * 60_000;
  while (Date.now() < until) {
    const runs = history(head);
    const failure = runs.find(item => item.status === 'completed' && !['success', 'skipped', 'neutral', 'cancelled'].includes(item.conclusion));
    requireThat(!failure, `Candidato fallido en Actions #${failure?.id}; corregir antes de aceptar.`);
    for (const item of runs) {
      const key = `${item.id}-${item.run_attempt}`;
      if (item.status !== 'completed' || item.conclusion !== 'success' || tried.has(key)) continue;
      const name = `allnutrition-amd64-${head}-${key}`;
      const artifacts = github(`repos/${repo}/actions/runs/${item.id}/artifacts?name=${name}&per_page=100`).artifacts;
      const found = artifacts.find(artifact => artifact.name === name && !artifact.expired && (!artifact.workflow_run || String(artifact.workflow_run.id) === String(item.id)));
      tried.add(key);
      if (!found) continue;
      const download = join(dir, key);
      run('gh', ['run', 'download', String(item.id), '--repo', repo, '--name', name, '--dir', download], { timeout: 1_200_000 });
      const result = await validate(download, item, base);
      if (result) return result;
    }
    const pending = runs.some(item => item.status !== 'completed');
    if (!pending && !dispatched) {
      requireThat(allowDispatch, 'Sin artefacto vigente para el SHA y base observados; dry-run no dispara Actions.');
      run('gh', ['workflow', 'run', 'native-acceptance.yml', '--repo', repo, '--ref', 'main', '-f', `source_commit=${head}`, '-f', 'mode=impact']);
      dispatched = true;
    }
    await sleep(15_000);
  }
  throw new Error('Tiempo máximo de espera de aceptación agotado.');
}
export function configFromGit(commit, paths) {
  return Object.fromEntries(paths.flatMap(path => {
    const bytes = run('git', ['show', `${commit}:${path}`], { optional: true, encoding: 'buffer' });
    return bytes === null ? [] : [[path, bytes]];
  }));
}
export function configDigest(commit, paths) {
  return Object.fromEntries(Object.entries(configFromGit(commit, paths)).map(([path, bytes]) => [path, sha256(bytes)]));
}
function tarCommit(archive) {
  // Stop after the pax record, without retaining or extracting candidate data.
  const program = 'gzip -dc "$1" | git get-tar-commit-id';
  return run('sh', ['-c', program, 'sh', archive]).trim();
}
export async function verifyBundle(dir, item, base, { head, plan, canonicalPlan, requiredChecks, imageTag, configFiles }) {
  const file = name => join(dir, name);
  const names = ['release.json', 'impact.json', 'source-manifest.json', 'SHA256SUMS', 'sealed-source.tar.gz'];
  if (plan.build.length) names.push('accepted-images.tar.gz');
  const allowed = [...names, 'accepted-images.tar.gz'];
  const sums = Object.fromEntries(readFileSync(file('SHA256SUMS'), 'utf8').trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([a-z0-9.-]+)$/.exec(line);
    requireThat(match && allowed.includes(match[2]) && match[2] !== 'SHA256SUMS', 'Archivo o formato no autorizado en SHA256SUMS.');
    return [match[2], match[1]];
  }));
  const present = readdirSync(dir, { withFileTypes: true });
  requireThat(present.every(file => file.isFile()) && same(present.map(file => file.name).sort(), [...Object.keys(sums), 'SHA256SUMS'].sort()), 'Contenido del artefacto inesperado.');
  for (const [name, digest] of Object.entries(sums)) requireThat(await hashFile(file(name)) === digest, `Hash distinto: ${name}.`);
  const read = name => JSON.parse(readFileSync(file(name), 'utf8'));
  const release = read('release.json'), source = read('source-manifest.json');
  requireThat(release.format === 1 && release.sourceCommit === head && release.harnessCommit === head && release.runId === String(item.id) && release.runAttempt === String(item.run_attempt) && ['full', 'impact'].includes(release.mode), 'Datos de candidato, arnés o intento incorrectos.');
  requireThat(source.format === 1 && source.sourceCommit === head && source.sha256 === sums['sealed-source.tar.gz'] && tarCommit(file('sealed-source.tar.gz')) === head, 'Fuente sellada no coincide con el candidato.');
  if (release.baseDeploymentId !== base.deploymentId) return null;
  requireThat(same(present.map(file => file.name).sort(), [...names].sort()), 'Artefacto aceptado incompleto o demasiado amplio.');
  const planText = canonicalPlan(plan), actual = readFileSync(file('impact.json'), 'utf8');
  requireThat(planText === actual && release.planHash === sha256(actual), 'Plan sellado no coincide con el impacto recalculado.');
  const checks = [...requiredChecks(plan, release.mode)].sort();
  requireThat([release.requiredChecks, release.passedChecks, Object.keys(release.checks ?? {})].every(value => Array.isArray(value) && same([...value].sort(), checks)), 'Falta una compuerta obligatoria o sus resultados.');
  for (const key of checks) {
    const { count, durationMs } = release.checks[key];
    requireThat(Number.isSafeInteger(count) && count > 0 && Number.isFinite(durationMs) && durationMs >= 0, `Evidencia inválida para ${key}.`);
  }
  requireThat(same(release.services, plan.recreate) && release.schemaVersion === plan.schemaVersion && release.configCommit === head, 'Servicios, revisión de configuración o esquema distintos al plan.');
  requireThat(same(release.configHashes, configDigest(head, configFiles)), 'Hashes de configuración no coinciden con la fuente sellada.');
  requireThat(same(Object.keys(release.images ?? {}).sort(), [...plan.build].sort()), 'Composición del archivo de imágenes distinta al plan.');
  for (const [kind, built] of Object.entries(release.images)) {
    requireThat(imageId.test(built.imageId) && ['app', 'runner'].includes(kind), 'Tipo o ID de imagen inválido.');
    requireThat(built.os === 'linux' && built.architecture === 'amd64' && built.imageTag === imageTag(kind, built.imageId), `Imagen aceptada no válida: ${kind}.`);
  }
  return { release, sums, dir };
}
export function projectTarget(base, head, plan, release, archive) {
  const bad = plan.config.filter(path => ['deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh'].includes(path) || path.startsWith('deploy/nginx/') || path.startsWith('deploy/kvm/'));
  requireThat(bad.length === 0 && plan.recreate.every(service => serviceOrder.includes(service) && service !== 'db'), `Infraestructura no se aplica con este comando: ${bad.join(', ') || plan.recreate.join(', ')}.`);
  const changed = activeFiles.filter(path => release.configHashes[path] !== base.configHashes[path]);
  const selected = Object.fromEntries(changed.map(path => [path, run('tar', ['-xOf', archive, path], { optional: true, encoding: 'buffer' })]));
  requireThat(changed.every(path => selected[path] && sha256(selected[path]) === release.configHashes[path] && plan.config.includes(path)), 'Configuración productiva eliminada, no prevista o alterada.');
  const services = Object.fromEntries(serviceOrder.map(service => {
    const runtime = plan.paths.some(({ reasons }) => reasons.includes(`runtime:${service}`)) || plan.diagnostics.some(reason => reason.startsWith(`base:${service}:`));
    const kind = service === 'social-browser' ? 'runner' : 'app';
    const accepted = plan.recreate.includes(service) && runtime ? release.images[kind] : undefined;
    if (runtime && service !== 'db') requireThat(accepted, `Falta la imagen admitida para el binario de ${service}.`);
    return [service, accepted ? { sourceCommit: head, imageTag: accepted.imageTag, imageId: accepted.imageId } : base.services[service]];
  }));
  const manifest = publicState({ format: 1, coveredThrough: head, services, configCommit: changed.length ? head : base.configCommit,
    configHashes: Object.fromEntries(activeFiles.map(path => [path, release.configHashes[path]])), schemaVersion: release.schemaVersion });
  const files = Object.fromEntries(Object.entries(selected).map(([path, body]) => [path, body.toString('base64')]));
  return { manifest, files };
}
export const deploymentToken = () => randomBytes(20).toString('hex');
export const uploadArchive = async (path, input, archiveDigest) => {
  const key = `bundles/${archiveDigest}.tar.gz`;
  await cachePut(path, key, archiveDigest);
  await loadFromBuilder(key, { token: input.token, sha256: archiveDigest, bytes: statSync(path).size, images: input.images });
};
