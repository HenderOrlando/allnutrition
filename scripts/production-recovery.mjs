import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hash, imageId, privateJSON, recoveryDirectory, requireThat, same, sha } from './production-host.mjs';
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

export function ensureBuilderImages(manifest, { local = false, socket } = {}) {
  const ids = [...new Set(Object.values(manifest.services).map(entry => entry.imageId))];
  for (const id of ids) {
    requireThat(imageId.test(id), 'ID de transferencia no válido.');
    const save = vmArgs(`exec docker image save ${quote(id)}`, true).map(quote).join(' ');
    const cache = quote(join(releaseCache(), 'cache', 'images'));
    const script = `set -euo pipefail; umask 077; mkdir -p ${cache}; file=${cache}/${id.slice(7)}.tar.gz; if ! docker image inspect ${quote(id)} >/dev/null 2>&1; then if ! test -f "$file"; then tmp=$(mktemp ${cache}/.image-XXXXXX); trap 'rm -f "$tmp"' EXIT; ${save} | gzip -1 >"$tmp"; mv -T "$tmp" "$file"; fi; docker load --input "$file" >/dev/null; fi; test "$(docker image inspect --format '{{.Id}} {{.Os}} {{.Architecture}}' ${quote(id)})" = ${quote(`${id} linux amd64`)}`;
    if (local) run('bash', ['-c', script], { timeout: 1_200_000 });
    else run('ssh', builderArgs(socket ? `export DOCKER_HOST=${quote(socket)}; ${script}` : script), { timeout: 1_200_000 });
  }
}
export async function runPairIfNeeded(plan, release, manifest, source, token) {
  if (!plan.gates.includes('runner')) return;
  const expected = Object.fromEntries(Object.entries(manifest.services).map(([service, entry]) => [service, entry.imageId]));
  const peerIds = release.checks['gate:runner']?.images;
  if (['social-browser', 'social-browser-worker'].every(service => peerIds?.[service] === expected[service])) return;
  const socket = process.env.ALLNUTRITION_AUDIT_DOCKER_HOST;
  requireThat(/^unix:\/\/\/(?:run|var\/run)\/[a-zA-Z0-9/_-]+\.sock$/.test(socket ?? ''), 'El par heredado requiere un daemon rootless aislado en el constructor.');
  const isolate = `export DOCKER_HOST=${quote(socket)}; test "$(stat -c %u ${quote(socket.slice(7))})" = 1000; docker info --format '{{json .SecurityOptions}}' | grep -q rootless`;
  run('ssh', builderArgs(`set -euo pipefail; ${isolate}`));
  ensureBuilderImages(manifest, { socket });
  const digest = await hashFile(source);
  const archive = join(releaseCache(), 'cache', 'sources', manifest.coveredThrough, `${digest}.tar.gz`);
  const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64');
  const config = quote(join(releaseCache(), 'cache', 'sources', manifest.configCommit));
  const command = `set -euo pipefail; umask 077; ${isolate}; work=$(mktemp -d /tmp/allnutrition-pair-${token.slice(0, 12)}-XXXXXX); trap 'rm -rf "$work"' EXIT; mkdir "$work/source" "$work/config" "$work/home"; tar -xzf ${quote(archive)} -C "$work/source"; config=$(find ${config} -maxdepth 1 -type f -name '*.tar.gz' | sort | head -n 1); test -n "$config"; test "$(sha256sum "$config" | cut -d ' ' -f 1).tar.gz" = "\${config##*/}"; tar -xzf "$config" -C "$work/config"; printf %s ${quote(encoded)} | base64 -d >"$work/state.json"; chown -R 1000:1000 "$work"; cd "$work/source"; setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs env -i PATH=${quote(`${builderNode.slice(0, -5)}:/usr/bin:/bin`)} HOME="$work/home" LANG=C.UTF-8 DOCKER_HOST=${quote(socket)} RELEASE_CONFIG_ROOT="$work/config" ${quote(builderNode)} tests/native/browser-acceptance.mjs pair "$work/state.json"`;
  const output = run('ssh', builderArgs(command), { timeout: 1_200_000 });
  const result = JSON.parse(output.trim().split('\n').at(-1));
  requireThat(result.accepted && result.zeroOwnedLeftovers && same(result.images, expected), 'El par exacto de runner y consumidor no aprobó aceptación.');
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
