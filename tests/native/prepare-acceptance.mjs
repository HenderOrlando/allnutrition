import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  chownSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const candidate = resolve(process.env.CANDIDATE || '');
const root = resolve(process.env.NATIVE_ROOT || '');
const output = resolve(process.env.ACCEPTED_OUTPUT || '');
const sourceCommit = process.env.SOURCE_COMMIT || '';
const workflowCommit = process.env.WORKFLOW_COMMIT || '';
const runId = process.env.GITHUB_RUN_ID || '';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ensure = (condition, message) => assert.ok(condition, message);

function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  ensure(!result.error && result.status === 0, `${binary} ${args[0]} failed (${result.error?.code || result.signal || result.status})`);
  return result.stdout;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function writePrivate(path, content) {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

function verifyRoot() {
  const info = lstatSync(root);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.uid === 1000 && info.gid === 1000 && (info.mode & 0o777) === 0o700, 'Private acceptance root must be a real 0700 directory owned by UID/GID 1000');
  ensure(!root.startsWith('/home/allnutrition/'), 'Production paths are forbidden');
}

function verifyOutput() {
  const info = lstatSync(output);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.uid === 1000 && info.gid === 1000 && (info.mode & 0o777) === 0o700, 'Private accepted-output directory must be a real 0700 directory owned by UID/GID 1000');
}

function trackedManifest() {
  const entries = command('git', ['ls-tree', '-r', '-t', '-z', '--full-tree', sourceCommit], candidate)
    .split('\0').filter(Boolean);
  const directories = [];
  const files = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    ensure(tab > 0, 'Malformed Git tree entry');
    const [gitMode, type] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    ensure(path && !path.startsWith('/') && !path.split('/').includes('..'), 'Unsafe source path');
    const info = lstatSync(join(candidate, path));
    ensure(!info.isSymbolicLink(), 'Symlink source entries are not accepted');
    if (type === 'tree' && gitMode === '040000') {
      ensure(info.isDirectory(), 'Source directory type mismatch');
      directories.push({ path, mode: info.mode & 0o777 });
    } else if (type === 'blob' && (gitMode === '100644' || gitMode === '100755')) {
      ensure(info.isFile(), 'Source file type mismatch');
      const expectedMode = gitMode === '100755' ? 0o755 : 0o644;
      ensure((info.mode & 0o777) === expectedMode, 'Checkout file mode differs from Git');
      files.push({ path, mode: expectedMode, size: info.size, sha256: sha256(readFileSync(join(candidate, path))) });
    } else {
      throw new Error('Unsupported source entry type');
    }
  }
  directories.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  ensure(files.length > 0 && directories.length > 0, 'Source manifest is empty');
  return { directories, files };
}

function findResults(directory, depth = 0, found = []) {
  if (!existsSync(directory) || depth > 4) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findResults(path, depth + 1, found);
    else if (entry.isFile() && entry.name === 'result.json') found.push(path);
  }
  return found;
}

function inspectImage(tag) {
  const output = command('docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Config.User}}', tag], candidate).trim();
  const [id, os, architecture, user] = output.split('|');
  ensure(/^sha256:[a-f0-9]{64}$/.test(id) && os === 'linux' && architecture === 'amd64' && user === 'node', 'Accepted image identity mismatch');
  return { id, os, architecture, user };
}

function prepare() {
  verifyRoot();
  ensure(process.getuid() === 1000 && process.getgid() === 1000, 'Source seal must run as UID/GID 1000');
  ensure(/^([a-f0-9]{40})$/.test(sourceCommit) && /^([a-f0-9]{40})$/.test(workflowCommit), 'Exact source and workflow commits are required');
  ensure(command('git', ['rev-parse', 'HEAD'], candidate).trim() === sourceCommit, 'Candidate checkout does not match requested commit');
  ensure(command('git', ['status', '--porcelain', '--untracked-files=no'], candidate).trim() === '', 'Tracked source changed before sealing');
  const archivePath = join(root, 'source.tar');
  ensure(!existsSync(archivePath) && !existsSync(join(root, 'manifest.json')), 'Refusing to overwrite an existing source seal');
  command('git', ['archive', '--format=tar', '--output', archivePath, sourceCommit], candidate);
  chmodSync(archivePath, 0o600);
  const source = trackedManifest();
  const manifest = {
    id: randomUUID(),
    nativeBuilder: 'default',
    nativeCandidate: candidate,
    productionRoot: '/__production_is_forbidden__',
    sourceCommit,
    workflowCommit,
    archiveSha256: sha256(readFileSync(archivePath)),
    directories: source.directories,
    files: source.files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writePrivate(join(root, 'manifest.json'), manifestBytes);
  const tool = join(dirname(fileURLToPath(import.meta.url)), 'browser-acceptance.mjs');
  const copiedTool = join(root, 'browser-acceptance.mjs');
  copyFileSync(tool, copiedTool);
  chmodSync(copiedTool, 0o600);
  ensure(sha256(readFileSync(tool)) === sha256(readFileSync(copiedTool)), 'Runner acceptance tool copy mismatch');
  console.log(JSON.stringify({ archiveSha256: manifest.archiveSha256, manifestSha256: sha256(manifestBytes), files: source.files.length, directories: source.directories.length }));
}

function core() {
  verifyRoot();
  ensure(process.getuid() === 0, 'Core result packaging must read the private verifier result as root');
  const manifestBytes = readFileSync(join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  ensure(manifest.sourceCommit === sourceCommit && manifest.workflowCommit === workflowCommit && manifest.nativeCandidate === candidate, 'Source seal provenance mismatch');
  const paths = findResults(join(candidate, '.test-data', 'docker'));
  ensure(paths.length === 1, 'Expected exactly one full verifier result');
  const result = JSON.parse(readFileSync(paths[0], 'utf8'));
  ensure(result.exitCode === 0 && !result.error && result.os === 'linux' && result.architecture === 'amd64', 'Full Docker verifier did not pass on Linux/amd64');
  ensure(/^sha256:[a-f0-9]{64}$/.test(result.imageId) && result.releaseTag === `allnutrition:release-${result.imageId.slice(7, 19)}`, 'Core release image is not immutable');
  ensure(Array.isArray(result.tests) && result.tests.length > 0 && result.reusedContracts == null, 'Fresh full verifier tests are required');
  const image = inspectImage(result.releaseTag);
  ensure(image.id === result.imageId, 'Core image tag does not match verifier image ID');
  const acceptance = {
    accepted: true,
    code: 0,
    sourceFilesVerified: true,
    sourceCommit,
    workflowCommit,
    archiveSha256: manifest.archiveSha256,
    manifestSha256: sha256(manifestBytes),
    result: {
      exitCode: 0,
      imageId: result.imageId,
      releaseTag: result.releaseTag,
      architecture: result.architecture,
      os: result.os,
      tests: result.tests,
    },
  };
  writePrivate(join(root, 'acceptance.json'), `${JSON.stringify(acceptance, null, 2)}\n`);
  writePrivate(join(root, 'image-refs.json'), `${JSON.stringify({ app: result.releaseTag, appImageId: result.imageId }, null, 2)}\n`);

  for (const path of [join(root, 'acceptance.json'), join(root, 'image-refs.json')]) chownSync(path, 1000, 1000);
  console.log(JSON.stringify({ accepted: true, appImageId: result.imageId, releaseTag: result.releaseTag, tests: result.tests.length }));
}

async function bundle() {
  verifyRoot();
  verifyOutput();
  ensure(process.getuid() === 1000 && process.getgid() === 1000, 'Image bundling must run as UID/GID 1000');
  ensure(/^\d+$/.test(runId) && /^\d+$/.test(runAttempt), 'Workflow run identity is required');
  const manifestBytes = readFileSync(join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);

  ensure(manifest.sourceCommit === sourceCommit && manifest.workflowCommit === workflowCommit, 'Workflow source provenance mismatch');
  const coreAcceptance = JSON.parse(readFileSync(join(root, 'acceptance.json'), 'utf8'));
  const runner = JSON.parse(readFileSync(join(root, 'runner-image.json'), 'utf8'));
  const browser = JSON.parse(readFileSync(join(root, 'browser-acceptance.json'), 'utf8'));
  ensure(coreAcceptance.accepted === true && coreAcceptance.code === 0 && coreAcceptance.sourceFilesVerified === true && coreAcceptance.result?.exitCode === 0 && coreAcceptance.result.reusedContracts == null, 'Fresh full core acceptance is required');
  ensure(runner.accepted === true && runner.archiveSha256 === manifest.archiveSha256 && runner.manifestSha256 === sha256(manifestBytes), 'Same-source runner build is required');
  ensure(browser.accepted === true && browser.archiveSha256 === manifest.archiveSha256 && browser.manifestSha256 === sha256(manifestBytes) && browser.cleanup?.zeroOwnedLeftovers === true && browser.productionWrites === false, 'Isolated runner verification is required');
  ensure(browser.appImageId === coreAcceptance.result.imageId && browser.imageId === runner.imageId && browser.releaseTag === runner.releaseTag, 'Runner and app image provenance mismatch');
  const app = inspectImage(coreAcceptance.result.releaseTag);
  const runnerImage = inspectImage(runner.releaseTag);
  ensure(app.id === coreAcceptance.result.imageId && runnerImage.id === runner.imageId && runnerImage.architecture === 'amd64', 'Immutable image identity mismatch');
  const archivePath = join(output, 'accepted-images.tar.gz');
  ensure(!existsSync(archivePath) && readdirSync(output).length === 0, 'Accepted output directory must be empty');
  const refs = JSON.parse(readFileSync(join(root, 'image-refs.json'), 'utf8'));
  const appTag = coreAcceptance.result.releaseTag, runnerTag = runner.releaseTag;
  ensure(/^allnutrition:release-[a-f0-9]{12}$/.test(appTag) && /^allnutrition-social-browser:release-[a-f0-9]{12}$/.test(runnerTag) && refs.app === appTag && refs.appImageId === coreAcceptance.result.imageId, 'Unsafe image export references');
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const saved = spawnSync('bash', ['-euo', 'pipefail', '-c', `docker save ${quote(appTag)} ${quote(runnerTag)} | gzip -1 > ${quote(archivePath)}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  ensure(!saved.error && saved.status === 0, `Accepted image export failed (${saved.error?.code || saved.signal || saved.status})`);
  ensure(existsSync(archivePath) && lstatSync(archivePath).isFile() && !lstatSync(archivePath).isSymbolicLink() && statSync(archivePath).size > 0, 'Accepted image archive is missing');
  const archiveSha256 = await hashFile(archivePath);
  const sourceManifest = {
    format: 1,
    sourceCommit: manifest.sourceCommit,
    workflowCommit: manifest.workflowCommit,
    sourceArchiveSha256: manifest.archiveSha256,
    manifestSha256: sha256(manifestBytes),
    directories: manifest.directories,
    files: manifest.files,
  };
  const proof = {
    format: 1,
    accepted: true,
    sourceCommit: manifest.sourceCommit,
    workflowCommit: manifest.workflowCommit,
    runId,
    runAttempt,
    sourceArchiveSha256: manifest.archiveSha256,
    manifestSha256: sha256(manifestBytes),
    core: {
      accepted: true,
      exitCode: 0,
      imageTag: coreAcceptance.result.releaseTag,
      imageId: app.id,
      os: app.os,
      architecture: app.architecture,
      tests: coreAcceptance.result.tests,
      reusedContracts: false,
    },
    runner: {
      accepted: true,
      imageTag: runner.releaseTag,
      imageId: runnerImage.id,
      appImageId: app.id,
      os: runnerImage.os,
      architecture: runnerImage.architecture,
      node: runner.node,
      uid: runner.uid,
      gid: runner.gid,
      gates: Object.keys(browser.proof || {}).sort(),
      zeroOwnedLeftovers: true,
      productionWrites: false,
    },
    imageArchive: { file: 'accepted-images.tar.gz', sha256: archiveSha256, bytes: statSync(archivePath).size },
  };
  const sourceBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  const proofBytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  writePrivate(join(output, 'source-manifest.json'), sourceBytes);
  writePrivate(join(output, 'acceptance.json'), proofBytes);
  const sums = `${archiveSha256}  accepted-images.tar.gz\n${sha256(proofBytes)}  acceptance.json\n${sha256(sourceBytes)}  source-manifest.json\n`;
  writePrivate(join(output, 'SHA256SUMS'), sums);
  for (const name of ['accepted-images.tar.gz', 'acceptance.json', 'source-manifest.json', 'SHA256SUMS']) chmodSync(join(output, name), 0o644);
  chmodSync(output, 0o755);
  console.log(JSON.stringify({ accepted: true, sourceCommit, appImageId: app.id, runnerImageId: runnerImage.id, archiveSha256, archiveBytes: statSync(archivePath).size }));
}

async function main() {
  ensure(['prepare', 'core', 'bundle'].includes(mode), 'Usage: prepare-acceptance.mjs prepare|core|bundle');
  if (mode === 'prepare') prepare();
  else if (mode === 'core') core();
  else await bundle();
}

main().catch(error => {
  console.error(`Acceptance packaging failed: ${error.message}`);
  process.exitCode = 1;
});
