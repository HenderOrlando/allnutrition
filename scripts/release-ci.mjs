import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { calculateImpact, canonicalPlan, configFiles, imageTag, requiredChecks, sha40 } from './release-impact.mjs';
import { units } from './release-impact-matrix.mjs';
import { nodeSandboxed } from './release-test-plan.mjs';

const repository = 'HenderOrlando/allnutrition';
const activeConfig = ['compose.yaml', 'compose.nginx.yaml', 'deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh', 'deploy/social-browser-seccomp.json'];
const digits = /^\d+$/;
const digest = /^[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const env = process.env;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = list => [...list].sort();
const exactKeys = (value, keys) => object(value) && JSON.stringify(sorted(Object.keys(value))) === JSON.stringify(sorted(keys));
const write = (file, value) => writeFileSync(file, canonicalPlan(value), { flag: 'wx', mode: 0o600 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const output = (key, value) => appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);

function command(binary, args, options) {
  const result = spawnSync(binary, args, { maxBuffer: 96 * 1024 * 1024, ...options });
  assert.ok(!result.error && result.status === 0, `${binary} ${args[0]} falló (${result.error?.code || result.signal || result.status})`);
  return result.stdout;
}

function git(args, options = {}) {
  return command('git', ['-C', env.SOURCE_CHECKOUT, ...args], { encoding: 'utf8', ...options });
}

function ancestor(parent, head) {
  return sha40.test(parent) && spawnSync('git', ['-C', env.SOURCE_CHECKOUT, 'merge-base', '--is-ancestor', parent, head], { stdio: 'ignore' }).status === 0;
}

function eventContext() {
  const event = json(env.GITHUB_EVENT_PATH);
  const mainPush = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main';
  const dispatch = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  assert.ok(mainPush || dispatch || env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/trunk', 'Evento no admitido');
  const source = dispatch ? event.inputs?.source_commit : env.GITHUB_SHA;
  assert.equal(source, env.SOURCE_COMMIT, 'La fuente seleccionada no coincide con el evento');
  assert.ok(sha40.test(source) && git(['rev-parse', 'HEAD']).trim() === source, 'El checkout debe coincidir con el SHA del candidato');
  assert.ok(sha40.test(env.HARNESS_COMMIT) && command('git', ['-C', env.HARNESS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === env.HARNESS_COMMIT, 'El checkout de herramientas debe coincidir con su SHA');
  if (mainPush || dispatch) assert.equal(env.HARNESS_COMMIT, env.GITHUB_SHA, 'El harness de main debe ser el SHA del evento');
  if (dispatch) {
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Para aceptación manual use --ref main');
    assert.ok(ancestor(source, env.GITHUB_SHA), 'El candidato manual no es ancestro del SHA de main del workflow');
  }
  if (mainPush) assert.equal(event.after, source, 'El SHA del push no coincide con el candidato');
  assert.equal(env.RELEASE_MODE, dispatch ? (event.inputs?.mode ?? 'impact') : 'impact', 'El modo seleccionado no coincide con el evento');
  assert.ok(['impact', 'full'].includes(env.RELEASE_MODE), 'Modo de aceptación inválido');

  let base;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const pullBase = event.pull_request?.base?.sha;
    const pullHead = event.pull_request?.head?.sha;
    // The test tree is GitHub's proposed merge, not the contributor's tip.
    // Verify both real event parents before trusting a merge-base for selection.
    if (ancestor(pullBase, source) && ancestor(pullHead, source)) {
      const merge = spawnSync('git', ['-C', env.SOURCE_CHECKOUT, 'merge-base', '--all', pullBase, pullHead], { encoding: 'utf8' });
      const found = merge.stdout?.trim();
      if (merge.status === 0 && sha40.test(found)) base = found;
    }
  } else if (env.GITHUB_EVENT_NAME === 'push' && sha40.test(event.before)) base = event.before;
  const production = (mainPush || dispatch) && env.GITHUB_REPOSITORY?.toLowerCase() === repository.toLowerCase();
  const workflow = mainPush ? 'ci.yml' : 'native-acceptance.yml';
  const promotable = production && env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/.github/workflows/${workflow}@refs/heads/main`;
  return { source, base, production, promotable };
}

function configHashes(commit) {
  const result = {};
  const files = git(['ls-tree', '--full-tree', '-z', commit, '--', ...configFiles]);
  for (const entry of files.split('\0').filter(Boolean)) {
    const [, oid, path] = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\n]+)$/.exec(entry) || [];
    // The first group is the blob ID, not a path read from the test checkout.
    assert.ok(oid && configFiles.includes(path), 'Configuración con entrada Git no regular');
    result[path] = sha256(git(['cat-file', 'blob', oid], { encoding: null }));
  }
  return result;
}

async function api(path) {
  assert.ok(env.GH_TOKEN, 'Falta token GitHub de solo lectura');
  const response = await fetch(new URL(`/repos/${repository}/${path}`, env.GITHUB_API_URL), {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Error leyendo Deployments de GitHub: HTTP ${response.status}`);
  const rows = await response.json();
  assert.ok(Array.isArray(rows), 'Respuesta inesperada de Deployments de GitHub');
  return rows;
}

function publicState(deployment) {
  const id = String(deployment.id);
  let payload = deployment.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!digits.test(id) || deployment.environment !== 'production' || !exactKeys(payload, ['format', 'coveredThrough', 'services', 'configCommit', 'configHashes', 'schemaVersion']) ||
      payload.format !== 1 || !sha40.test(payload.coveredThrough) || deployment.sha !== payload.coveredThrough || !sha40.test(payload.configCommit) ||
      !Number.isSafeInteger(payload.schemaVersion) || payload.schemaVersion < 0 || !exactKeys(payload.services, units) || !exactKeys(payload.configHashes, activeConfig)) return null;
  for (const service of Object.values(payload.services)) {
    if (!exactKeys(service, ['sourceCommit', 'imageTag', 'imageId']) || !(service.sourceCommit === null || sha40.test(service.sourceCommit)) ||
        typeof service.imageTag !== 'string' || !/^[a-zA-Z0-9._:/@-]+$/.test(service.imageTag) || !imageIdPattern.test(service.imageId)) return null;
  }
  if (Object.entries(payload.configHashes).some(([path, hash]) => !configFiles.includes(path) || !digest.test(hash))) return null;
  return { ...payload, deploymentId: id };
}

async function latestProduction(source) {
  for (let page = 1; ; page++) {
    const deployments = await api(`deployments?environment=production&per_page=100&page=${page}`);
    for (const deployment of deployments) {
      // Never fall back to an older success if the current accepted record
      // cannot be verified. Pending/failed/inactive deployments are not accepted.
      assert.ok(digits.test(String(deployment.id)), 'ID de deployment inválido');
      const [latest] = await api(`deployments/${deployment.id}/statuses?per_page=1`);
      if (latest?.state !== 'success') continue;
      const state = publicState(deployment);
      if (!state) return { state: null, reason: 'base de producción inválida' };
      const bases = [state.coveredThrough, state.configCommit, ...Object.values(state.services).map(service => service.sourceCommit).filter(Boolean)];
      if (!bases.every(commit => ancestor(commit, source))) return { state: null, reason: 'base de producción ausente o no ancestro del candidato' };
      try {
        const tracked = configHashes(state.configCommit);
        assert.ok(Object.entries(state.configHashes).every(([path, hash]) => tracked[path] === hash));
      } catch { return { state: null, reason: 'hashes de configuración de producción no verificables' }; }
      return { state, reason: null };
    }
    if (deployments.length < 100) return { state: null, reason: 'sin deployment exitoso de producción' };
  }
}

const unsafe = plan => plan.diagnostics.filter(message => !/^imports:.+:unresolved-local$/.test(message));

async function planFor(context, production) {
  return calculateImpact({ head: context.source, cwd: env.SOURCE_CHECKOUT, ...(context.production ? { state: production.state } : { base: context.base }) });
}

function preflight(planFile, plan) {
  const jsonText = command(process.execPath, [join(env.HARNESS, 'scripts/release-test-plan.mjs'), planFile], { encoding: 'utf8' });
  const needs = JSON.parse(jsonText);
  assert.ok(exactKeys(needs, ['npm', 'browser', 'ffmpeg', 'docker']) && Object.values(needs).every(value => typeof value === 'boolean'), 'Preflight de aceptación inválido');
  for (const [key, value] of Object.entries(needs)) output(key, value);
  const required = requiredChecks(plan, env.RELEASE_MODE);
  output('harness_npm', required.includes('gate:harness'));
  output('work', required.length > 0 || plan.build.length > 0);
  output('buildkit', env.RELEASE_MODE === 'full' || Boolean(plan.build.length || plan.postgres.length || plan.node.some(nodeSandboxed) ||
    required.some(id => /^(?:playwright:|gate:(?:runtime|runner|https|postgres|scheduler|migration|restore)$)/.test(id))));
}

function validateEvidence(plan, evidence) {
  const required = requiredChecks(plan, env.RELEASE_MODE);
  assert.ok(exactKeys(evidence, ['format', 'head', 'exitCode', 'checks', 'images']) && evidence.format === 1 && evidence.head === plan.head && evidence.exitCode === 0, 'Evidencia de aceptación no aprobada o de otra fuente');
  assert.ok(exactKeys(evidence.checks, required), 'Los checks ejecutados no coinciden con los requeridos');
  for (const id of required) {
    const check = evidence.checks[id];
    const paired = id === 'gate:runner';
    const legacyPg = id.startsWith('pg:') && id !== 'pg:assistant-work' && check?.execution === 'legacy-full-file';
    assert.ok(exactKeys(check, ['count', 'durationMs', ...(paired ? ['images'] : legacyPg ? ['execution'] : [])]) &&
      Number.isSafeInteger(check.count) && check.count > 0 && Number.isFinite(check.durationMs) && check.durationMs >= 0, `Evidencia de check inválida: ${id}`);
    if (paired) assert.ok(exactKeys(check.images, units) && Object.values(check.images).every(value => imageIdPattern.test(value)), 'Evidencia de identidad del runner inválida');
  }
  assert.ok(exactKeys(evidence.images, plan.build), 'La evidencia de imágenes no coincide con el plan');
  for (const kind of plan.build) {
    const image = evidence.images[kind];
    assert.ok(exactKeys(image, ['imageTag', 'imageId', 'architecture', 'os']) && imageIdPattern.test(image.imageId) &&
      image.imageTag === imageTag(kind, image.imageId) && image.architecture === 'amd64' && image.os === 'linux', `Identidad inválida: ${kind}`);
    const pair = evidence.checks['gate:runner']?.images;
    if (pair) {
      const services = kind === 'app' ? ['web', 'scheduler', 'social-browser-worker'] : ['social-browser'];
      assert.ok(services.every(service => pair[service] === image.imageId), `El par probado no usa la imagen acreditada: ${kind}`);
    }
  }
  return required;
}

function inspectImage(image) {
  const actual = command('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Architecture}} {{.Os}}', image.imageTag], { encoding: 'utf8' });
  assert.equal(actual.trim(), `${image.imageId} amd64 linux`, `La imagen local no coincide: ${image.imageTag}`);
}

function archive(outputPath, program, args) {
  const fd = openSync(outputPath, 'wx', 0o600);
  try { command('bash', ['-euo', 'pipefail', '-c', program, 'release-ci', ...args], { stdio: ['ignore', fd, 'inherit'] }); }
  finally { closeSync(fd); }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function seal(context, expected, plan, evidence, directory) {
  const required = validateEvidence(plan, evidence);
  const rejectExport = reason => output('export_reason', reason);
  if (!context.promotable) return rejectExport('evento no promovible');
  if (!expected.state) return rejectExport(expected.reason);
  if (unsafe(plan).length) return rejectExport('el selector no pudo verificar la base o la configuración');
  if (plan.gates.includes('infra')) return rejectExport('los cambios de infraestructura requieren un corte separado');
  if (!plan.build.length && !plan.recreate.length && !plan.config.some(path => activeConfig.includes(path))) {
    return rejectExport('sin cambios aplicables a producción');
  }
  const current = await latestProduction(context.source);
  if (!current.state || !isDeepStrictEqual(current.state, expected.state)) return rejectExport('la base de producción cambió durante la aceptación');
  const recomputed = await planFor(context, current);
  assert.equal(canonicalPlan(recomputed), canonicalPlan(plan), 'El recálculo confiable no coincide con el plan ejecutado');
  assert.deepEqual(requiredChecks(recomputed, env.RELEASE_MODE), required, 'El recálculo no coincide con los checks aprobados');
  assert.ok(!unsafe(recomputed).length && recomputed.bases.deploymentId === current.state.deploymentId, 'Base de release insegura');
  const runId = env.GITHUB_RUN_ID, runAttempt = env.GITHUB_RUN_ATTEMPT;
  assert.ok(digits.test(runId) && digits.test(runAttempt) && digits.test(current.state.deploymentId), 'IDs de aceptación inválidos');
  assert.ok(process.arch === 'x64' && process.platform === 'linux', 'Solo se puede sellar en Linux amd64');
  mkdirSync(directory, { mode: 0o700 });
  const sourceCommit = context.source;
  archive(join(directory, 'sealed-source.tar.gz'), 'git -C "$1" archive --format=tar "$2" | gzip -1', [env.SOURCE_CHECKOUT, sourceCommit]);
  const sourceHash = await hashFile(join(directory, 'sealed-source.tar.gz'));
  write(join(directory, 'source-manifest.json'), { format: 1, sourceCommit, sha256: sourceHash });
  write(join(directory, 'impact.json'), recomputed);
  write(join(directory, 'release.json'), {
    format: 1, mode: env.RELEASE_MODE, sourceCommit, harnessCommit: env.HARNESS_COMMIT, runId, runAttempt,
    baseDeploymentId: current.state.deploymentId, planHash: sha256(canonicalPlan(recomputed)), requiredChecks: required,
    passedChecks: sorted(Object.keys(evidence.checks)), checks: evidence.checks, services: recomputed.recreate,
    configCommit: sourceCommit, configHashes: configHashes(sourceCommit), schemaVersion: recomputed.schemaVersion, images: evidence.images,
  });
  const hashes = { 'sealed-source.tar.gz': sourceHash };
  for (const file of ['release.json', 'impact.json', 'source-manifest.json']) hashes[file] = await hashFile(join(directory, file));
  if (recomputed.build.length) {
    const images = recomputed.build.map(kind => evidence.images[kind]);
    images.forEach(inspectImage);
    const name = 'accepted-images.tar.gz';
    archive(join(directory, name), 'docker save "$@" | gzip -1', images.map(image => image.imageTag));
    images.forEach(inspectImage);
    hashes[name] = await hashFile(join(directory, name));
  }
  const latest = await latestProduction(sourceCommit);
  if (!latest.state || !isDeepStrictEqual(latest.state, expected.state)) return rejectExport('la base de producción cambió durante la exportación');
  writeFileSync(join(directory, 'SHA256SUMS'), sorted(Object.keys(hashes)).map(file => `${hashes[file]}  ${file}\n`).join(''), { flag: 'wx', mode: 0o600 });
  output('artifact', `allnutrition-amd64-${sourceCommit}-${runId}-${runAttempt}`);
}

function summarize(directory, status, artifact, reason) {
  const lines = ['## Aceptación Linux amd64', '', `Resultado del job: ${status}.`];
  const code = value => `<code>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ')}</code>`;
  if (artifact) lines.push(`Artefacto publicado: ${code(artifact)}.`);
  else if (reason) lines.push(`Sin artefacto promovible: ${code(reason)}.`);
  const planFile = join(directory, 'impact.json');
  if (existsSync(planFile)) {
    const plan = json(planFile);
    lines.push('', `Fuente: ${code(plan.head)} · Harness: ${code(env.HARNESS_COMMIT)} · Modo: ${code(env.RELEASE_MODE)}`,
      `Base: ${code(plan.bases.deploymentId ?? plan.bases.coveredThrough ?? 'no verificada')}`,
      `Imágenes nuevas: ${plan.build.map(code).join(', ') || 'ninguna'} · Servicios a recrear: ${plan.recreate.map(code).join(', ') || 'ninguno'}`);
    for (const message of plan.diagnostics) lines.push(`- Diagnóstico: ${code(message)}`);
    if (plan.paths.length) {
      lines.push('', '<details><summary>Rutas y motivos</summary>', '');
      for (const { path, reasons } of plan.paths.slice(0, 250)) lines.push(`- ${code(path)}: ${reasons.map(code).join(', ')}`);
      if (plan.paths.length > 250) lines.push(`- ${plan.paths.length - 250} rutas más.`);
      lines.push('', '</details>');
    }
    const evidenceFile = join(directory, 'evidence.json');
    const checks = existsSync(evidenceFile) ? json(evidenceFile).checks : {};
    const expected = requiredChecks(plan, env.RELEASE_MODE);
    lines.push('');
    if (!expected.length) lines.push('Sin comprobaciones adicionales para este impacto.');
    else {
      lines.push('| Comprobación | Casos | Duración |', '| --- | ---: | ---: |');
      for (const id of expected) {
        const { count, durationMs, execution } = checks?.[id] || {};
        lines.push(`| ${code(id)}${execution === 'legacy-full-file' ? ' (archivo entero; candidato sin grupos)' : ''} | ${Number.isSafeInteger(count) ? count : '—'} | ${Number.isFinite(durationMs) ? `${durationMs} ms` : '—'} |`);
      }
    }
  }
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function trunkWrappers(commit, directory) {
  assert.ok(sha40.test(commit) && !/^0+$/.test(commit) && directory, 'Uso: node scripts/release-ci.mjs trunk-wrappers <SHA main publicado> <directorio nuevo>');
  const workflows = new URL('../.github/workflows/', import.meta.url);
  const call = `    uses: ${repository}/.github/workflows/native-acceptance.yml@${commit}`;
  const ci = readFileSync(new URL('ci.yml', workflows), 'utf8');
  const local = '    uses: ./.github/workflows/native-acceptance.yml';
  assert.ok(ci.includes(local), 'No se encontró la llamada local de CI');
  const native = readFileSync(new URL('native-acceptance.yml', workflows), 'utf8');
  const registration = /^on:\n([\s\S]+?)^  workflow_call:/m.exec(native)?.[1];
  assert.ok(registration?.startsWith('  workflow_dispatch:'), 'No se encontraron los inputs de dispatch');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'ci.yml'), ci.replace(local, `${call}\n    with:\n      harness_commit: '${commit}'`), { flag: 'wx' });
  writeFileSync(join(directory, 'native-acceptance.yml'), `name: Registro de aceptación nativa (ejecutar con --ref main)\non:\n${registration}\npermissions:\n  contents: read\n  deployments: read\njobs:\n  acceptance:\n${call}\n    with:\n      harness_commit: '${commit}'\n`, { flag: 'wx' });
}

try {
  const [action, directory, ...args] = process.argv.slice(2);
  if (action === 'trunk-wrappers') trunkWrappers(directory, args[0]);
  else if (action === 'summary') summarize(directory, ...args);
  else {
    const context = eventContext();
    const stateFile = join(directory, 'deployment.json');
    const planFile = join(directory, 'impact.json');
    if (action === 'discover') {
      write(stateFile, context.production ? await latestProduction(context.source) : { state: null, reason: null });
    } else if (action === 'plan') {
      const plan = await planFor(context, json(stateFile));
      write(planFile, plan);
      preflight(planFile, plan);
    } else if (action === 'seal') {
      const evidence = json(join(directory, 'evidence.json'));
      await seal(context, json(stateFile), json(planFile), evidence, args[0]);
    } else throw Error('Operación de release CI desconocida');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}
