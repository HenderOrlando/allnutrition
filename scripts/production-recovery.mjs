import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hash, imageId, privateJSON, publicState, recoveryDirectory, requireThat, same, sha } from './production-host.mjs';
import { builderArgs, cachePut, hashFile, releaseCache, remoteStream, run, vmArgs } from './production-release.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const builderNode = '/home/allnutrition/native-toolchain-91b7ab6b/bin/node';
const scriptRoot = new URL('.', import.meta.url);

export async function cacheGitSource(commit) {
  requireThat(sha.test(commit), 'SHA de fuente inválido.');
  const root = mkdtempSync(join(tmpdir(), 'allnutrition-git-source-'));
  try {
    const archive = join(root, 'source.tar.gz');
    run('bash', ['-euo', 'pipefail', '-c', 'git archive --format=tar "$1" | gzip -1 > "$2"', 'bash', commit, archive]);
    const digest = await hashFile(archive);
    await cachePut(archive, `sources/${commit}/${digest}.tar.gz`, digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function keyAndRoot() {
  const keyPath = process.env.ALLNUTRITION_RECOVERY_KEY, rootPath = process.env.ALLNUTRITION_OFFSITE_BACKUPS;
  requireThat(keyPath && rootPath && isAbsolute(keyPath) && isAbsolute(rootPath), 'Configurar rutas absolutas ALLNUTRITION_RECOVERY_KEY y ALLNUTRITION_OFFSITE_BACKUPS fuera de VM.');
  const keyInfo = lstatSync(keyPath), root = realpathSync(rootPath), rootInfo = lstatSync(root);
  requireThat(keyInfo.isFile() && keyInfo.size === 32 && (keyInfo.mode & 0o077) === 0 && rootInfo.isDirectory() && (rootInfo.mode & 0o077) === 0 && !realpathSync(keyPath).startsWith(root + '/'), 'Clave privada de 32 bytes y directorio de copia 0700 deben estar separados.');
  return { key: readFileSync(keyPath), root };
}
function tally() {
  const digest = createHash('sha256');
  let bytes = 0;
  return {
    stream: new Transform({ transform(chunk, encoding, cb) { bytes += chunk.length; digest.update(chunk); cb(null, chunk); } }),
    value: () => ({ bytes, sha256: digest.digest('hex') })
  };
}
function decrypt(proof, key) {
  const iv = Buffer.from(proof.iv, 'hex'), tag = Buffer.from(proof.tag, 'hex');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${proof.token}/${proof.stage}`, 'utf8'));
  cipher.setAuthTag(tag);
  return cipher;
}
export async function saveOffsite(token, capture) {
  const { stage, bytes, sha256: digest } = capture;
  requireThat(sha.test(token) && ['rehearsal', 'final'].includes(stage) && Number.isSafeInteger(bytes) && bytes > 0 && hash.test(digest), 'Comprobante remoto de copia inválido.');
  const { key, root } = keyAndRoot();
  const dir = join(root, token);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${stage}.tar.enc`);
  const iv = randomBytes(12), plain = tally();
  const encrypt = createCipheriv('aes-256-gcm', key, iv);
  encrypt.setAAD(Buffer.from(`${token}/${stage}`, 'utf8'));
  const { process, exit } = remoteStream(vmArgs(`exec cat ${quote(join(recoveryDirectory(token), `${stage}.tar`))}`));
  process.stdin.end();
  try {
    await Promise.all([pipeline(process.stdout, plain.stream, encrypt, createWriteStream(path, { mode: 0o600, flags: 'wx', flush: true })), exit]);
    requireThat(same(plain.value(), { bytes, sha256: digest }), 'Bytes de copia no coinciden con VM.');
    const proof = { token, stage, path, bytes, sha256: digest, iv: iv.toString('hex'), tag: encrypt.getAuthTag().toString('hex'), encryptedSha256: await hashFile(path) };
    const check = tally();
    await pipeline(createReadStream(path), decrypt(proof, key), check.stream, new Writable({ write(_chunk, _encoding, cb) { cb(); } }));
    requireThat(same(check.value(), { bytes, sha256: digest }), 'Descifrado fuera de VM no coincide con la captura.');
    privateJSON(join(dir, `${stage}.json`), proof);
    return proof;
  } catch (error) {
    if (!existsSync(join(dir, `${stage}.json`))) rmSync(path, { force: true });
    throw error;
  } finally { key.fill(0); }
}

function ensureBuilderImages(manifest) {
  const ids = [...new Set(Object.values(manifest.services).map(entry => entry.imageId))];
  for (const id of ids) {
    requireThat(imageId.test(id), 'ID de transferencia no válido.');
    const save = ['ssh', ...vmArgs(`exec docker image save ${quote(id)}`, true)].map(quote).join(' ');
    const cache = quote(join(releaseCache(), 'cache', 'images'));
    const script = `set -euo pipefail; umask 077; mkdir -p ${cache}; file=${cache}/${id.slice(7)}.tar.gz; if ! docker image inspect ${quote(id)} >/dev/null 2>&1; then if ! test -f "$file"; then tmp=$(mktemp ${cache}/.image-XXXXXX); trap 'rm -f "$tmp"' EXIT; ${save} | gzip -1 >"$tmp"; mv -T "$tmp" "$file"; fi; docker load --input "$file" >/dev/null; fi; test "$(docker image inspect --format '{{.Id}} {{.Os}} {{.Architecture}}' ${quote(id)})" = ${quote(`${id} linux amd64`)}`;
    run('ssh', builderArgs(script), { timeout: 1_200_000 });
  }
}
export async function runPairIfNeeded(plan, release, manifest, bundleSha256) {
  const runner = release.checks['gate:runner'];
  if (!plan.gates.includes('runner') && !runner) return;
  const target = publicState(manifest);
  const expected = Object.fromEntries(Object.entries(target.services).map(([service, ref]) => [service, ref.imageId]));
  if (same(runner?.images, expected)) return { mode: 'ci', images: expected };
  requireThat(bundleSha256 === undefined ? plan.build.length === 0 : typeof bundleSha256 === 'string' && hash.test(bundleSha256),
    'Falta el hash válido del bundle aceptado para el par mixto.');
  const cache = releaseCache();
  requireThat(isAbsolute(cache), 'La caché del constructor requiere una ruta absoluta.');
  const command = `
set -euo pipefail
umask 077
test ! -e /home/allnutrition/app/.env.server.local
test ! -L /etc/allnutrition-audit && test "$(stat -c '%u:%a' /etc/allnutrition-audit)" = 0:700
config=/etc/allnutrition-audit/production.env
test -f "$config" && test ! -L "$config" && test "$(stat -c '%u:%a' "$config")" = 0:600
set -a
. "$config"
set +a
export ALLNUTRITION_BUILDER_CACHE="$1"
shift
work=$(mktemp -d /var/lib/allnutrition-audit/pair-XXXXXX)
trap 'rm -rf -- "$work"' EXIT
cat >"$work/manifest.json"
/usr/bin/flock -w 120 /var/lib/allnutrition-audit/audit.lock ${builderNode} /opt/allnutrition-audit/deploy/audit/guest-host.mjs --pair "$work/manifest.json" "$@"
`;
  const remote = ['sudo', '-n', '/usr/bin/env', '-i', 'HOME=/root', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', '/bin/bash', '-c', command, 'pair', cache,
    ...(bundleSha256 === undefined ? [] : [bundleSha256])].map(quote).join(' ');
  const output = spawnSync('ssh', ['-a', '-T', ...builderArgs(remote)], {
    input: JSON.stringify(target), encoding: 'utf8', timeout: 3 * 60 * 60_000, maxBuffer: 256 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const failure = /^La suite del invitado falló \((\d{1,3})\)\. (audit-guest:(?:launcher|isolation|media|images|sources|pair):(?:failed|exec-missing|exec-timeout|exec-error|command-failed|invalid-evidence|guard-rejected|(?:bundle|db|image)-load(?:-space|-archive|-unpack)?|image-inspect|image-identity|pair-timeout|pair-compose|pair-docker|pair-identity|pair-sandbox|pair-service|pair-cleanup|pair-rejected))$/m.exec(output.stderr || '');
  requireThat(output.status === 0, failure
    ? `El par exacto falló en el invitado (${failure[1]}): ${failure[2]}.`
    : `No hay comprobante del par exacto desde el constructor (SSH ${output.status ?? 'sin salida'}).`);
  const proof = JSON.parse(output.stdout);
  requireThat(proof?.accepted === true && proof.zeroOwnedLeftovers === true && same(proof.images, expected),
    'El invitado no acreditó el conjunto exacto de cinco imágenes.');
  return { mode: 'guest', images: expected };
}
export async function testRecovery(token, proof, base, manifest) {
  requireThat(proof.token === token && proof.stage === 'rehearsal' && await hashFile(proof.path) === proof.encryptedSha256, 'Copia de ensayo cifrada no coincide.');
  ensureBuilderImages(base);
  ensureBuilderImages(manifest);
  const { key } = keyAndRoot();
  const params = Buffer.from(JSON.stringify({ token, digest: proof.sha256, base, manifest })).toString('base64url');
  const code = readFileSync(new URL('./production-recovery-clone.mjs', scriptRoot), 'utf8');
  const args = [builderNode, '--input-type=module', '-e', code, '--', params].map(quote).join(' ');
  const { process, exit } = remoteStream(builderArgs(`exec env -i PATH=${quote(`${builderNode.slice(0, -5)}:/usr/bin:/bin`)} HOME=/home/allnutrition LANG=C.UTF-8 ${args}`));
  let stdout = '';
  process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  try {
    await Promise.all([pipeline(createReadStream(proof.path), decrypt(proof, key), process.stdin), exit]);
    const result = JSON.parse(stdout);
    requireThat(result.accepted && result.archiveSha256 === proof.sha256 && result.baseVersion === base.schemaVersion && result.schemaVersion === manifest.schemaVersion && result.candidateImage === manifest.services.web.imageId, 'El clon no acredita el candidato ni esquema observado.');
    return result;
  } finally { key.fill(0); }
}
