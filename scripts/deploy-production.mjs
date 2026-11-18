import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { activeFiles, publicState, requireLive, requireThat, same, serviceOrder, sha, sha256, smoke } from './production-host.mjs';
import { auditStatus, cachePut, candidateBundle, configDigest, deploymentToken, host, hostCommand, latestProduction, loadFromBuilder, origin, projectTarget, publishProduction, remoteMain, remoteStream, run, sourceRoot, verifyBundle, vmArgs } from './production-release.mjs';
import { cacheGitSource, runPairIfNeeded, saveOffsite, testRecovery } from './production-recovery.mjs';

const bootstrap = {
  coveredThrough: '7af05b7303c38471554e33db2c39d5c5be3043c2',
  configCommit: '4992bba17f611096cef281e4bdb8d1103f371e6f',
  services: {
    web: ['2ccdf408e6ea325300ec7e2d0820ad5e2550593ab64a362ba548ec6fb644f7b8', '9f04da63a2d1bcedb8bbaa7cf45944601813b55d'],
    scheduler: ['1edf00d36941a065cd51255ea929749da92be45bfa4dc26f78a4af604fd6b05f', '7af05b7303c38471554e33db2c39d5c5be3043c2'],
    'social-browser-worker': ['1edf00d36941a065cd51255ea929749da92be45bfa4dc26f78a4af604fd6b05f', '7af05b7303c38471554e33db2c39d5c5be3043c2'],
    'social-browser': ['ac109ca45d9966d4ad7e8f61e4ce2bab8429d2189eea292f145a9f9e62caa8e6', '7af05b7303c38471554e33db2c39d5c5be3043c2'],
    db: ['efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67', '4992bba17f611096cef281e4bdb8d1103f371e6f']
  }
};
const pretty = value => console.log(JSON.stringify(value, null, 2));
const validateLive = snapshot => {
  const live = publicState(snapshot.current?.manifest);
  requireLive(live, snapshot, { strictPins: snapshot.current.kind !== 'inventory' });
  return live;
};
async function inventory() {
  console.error('Inventario: leyendo la VM.');
  const observed = host('inspect', {}, { timeout: 30_000 });
  console.error('Inventario: leyendo el éxito registrado en GitHub.');
  const indexed = latestProduction();
  if (observed.current) {
    const live = validateLive(observed);
    requireThat(!indexed || same(publicState(indexed), live), 'Ya existe una base exitosa distinta. No se reemplaza con inventario.');
    pretty({ deploymentId: publishProduction(live, observed.current.kind), manifest: live });
    return;
  }
  requireThat(!indexed, 'GitHub ya tiene una base productiva; investigar antes de registrar inventario.');
  requireThat(same(observed.configHashes, configDigest(bootstrap.configCommit, activeFiles)), 'Compose vivo no coincide con el suplemento comprobado 4992bba. Conciliar configuración antes de registrar.');
  const manifest = publicState({ format: 1, coveredThrough: bootstrap.coveredThrough, configCommit: bootstrap.configCommit,
    configHashes: observed.configHashes, schemaVersion: observed.schema.version, services: Object.fromEntries(serviceOrder.map(service => {
      const { imageTag, imageId } = observed.containers[service];
      const [expected, source] = bootstrap.services[service];
      return [service, { imageTag, imageId, sourceCommit: imageId === `sha256:${expected}` ? source : null }];
    })) });
  requireLive(manifest, observed, { strictPins: false });
  console.error('Inventario: verificando HTTPS público.');
  await smoke(origin, { bootstrap: manifest.schemaVersion < 15 });
  console.error('Inventario: registrando recibo privado en VM.');
  host('inventory', { manifest, origin }, { timeout: 45_000 });
  console.error('Inventario: registrando procedencia pública en GitHub.');
  pretty({ deploymentId: publishProduction(manifest, 'inventory'), manifest });
}
function status() {
  const live = host('status');
  let audit = auditStatus();
  if (audit && live.current && ((audit.manifest && !same(audit.manifest, live.current.manifest)) || Date.now() - Date.parse(audit.finishedAt ?? audit.startedAt) > 8 * 86400_000)) audit = { status: 'overdue', last: audit };
  pretty({ ...live, audit: audit ?? { status: 'pending' } });
  if (live.pending || ['failed', 'overdue'].includes(audit?.status)) process.exitCode = 1;
}
async function apply(input) {
  const { process, exit } = remoteStream(vmArgs(hostCommand('apply', input)));
  let completed;
  try {
    const lines = createInterface({ input: process.stdout });
    for await (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.command === 'offsite-final') {
        const proof = await saveOffsite(input.token, frame);
        process.stdin.end(JSON.stringify({ verified: true, sha256: proof.sha256, encryptedSha256: proof.encryptedSha256 }) + '\n');
      } else completed = frame;
    }
    requireThat(completed && same(completed.manifest, input.manifest), 'No se recibió confirmación del manifiesto aplicado. Consultar --status sin repetir DDL.');
    await exit;
    return completed;
  } catch (error) {
    process.stdin.end();
    try { await exit; } catch (transport) { throw new Error(`${error.message} (${transport.message})`); }
    throw error;
  }
}
async function release(head, dryRun) {
  requireThat(sha.test(head) && head === remoteMain(), 'El candidato debe ser el HEAD exacto de main remoto.');
  const snapshot = host();
  const live = validateLive(snapshot), indexed = latestProduction();
  if (live.coveredThrough === head) {
    await smoke(origin);
    if (dryRun) pretty({ unchanged: true, manifest: live, indexed: Boolean(indexed && same(publicState(indexed), live)) });
    else pretty({ unchanged: true, deploymentId: publishProduction(live, snapshot.current.kind), manifest: live });
    return;
  }
  requireThat(indexed && same(live, publicState(indexed)), 'La base del API no coincide con el recibo y las imágenes vivas.');
  for (const file of ['scripts/release-impact.mjs', 'scripts/release-impact-matrix.mjs']) {
    const actual = readFileSync(new URL(file, sourceRoot));
    const sealed = run('git', ['show', `${head}:${file}`], { encoding: 'buffer' });
    requireThat(sha256(actual) === sha256(sealed), `Herramientas de impacto distintas al candidato sellado: ${file}.`);
  }
  const harness = await import('./release-impact.mjs');
  const { calculateImpact, requiredChecks } = harness;
  const plan = await calculateImpact({ head, state: indexed, cwd: fileURLToPath(sourceRoot) });
  requireThat(plan.schemaVersion >= live.schemaVersion, 'El plan baja el esquema activo.');
  if (!plan.recreate.length && plan.schemaVersion === live.schemaVersion) {
    pretty({ noCut: true, head, baseDeploymentId: indexed.deploymentId, requiredChecks: requiredChecks(plan), diagnostics: plan.diagnostics });
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'allnutrition-release-'));
  try {
    const outcome = await candidateBundle({ head, dir: root, base: indexed, allowDispatch: !dryRun,
      validate: (dir, item, base) => verifyBundle(dir, item, base, { ...harness, head, plan }) });
    const { release: accepted, sums, dir } = outcome;
    const sealed = join(dir, 'sealed-source.tar.gz');
    const { manifest, files } = projectTarget(live, head, plan, accepted, sealed);
    const report = { candidate: head, baseDeploymentId: indexed.deploymentId, runId: accepted.runId, runAttempt: accepted.runAttempt,
      mode: accepted.mode, checks: accepted.checks, build: plan.build, recreate: plan.recreate,
      preserved: serviceOrder.filter(service => !plan.recreate.includes(service)), config: Object.keys(files), schema: [live.schemaVersion, manifest.schemaVersion], manifest };
    if (dryRun) { pretty({ dryRun: true, ...report }); return; }
    const token = deploymentToken(), transferStartedAt = new Date().toISOString();
    await cachePut(sealed, `sources/${head}/${sums['sealed-source.tar.gz']}.tar.gz`, sums['sealed-source.tar.gz']);
    const retained = new Set([manifest.configCommit, live.coveredThrough, live.configCommit, ...Object.values(live.services).map(entry => entry.sourceCommit)]);
    for (const source of retained) if (source && source !== head) await cacheGitSource(source);
    const bundleSha = sums['accepted-images.tar.gz'];
    const bundleKey = `bundles/${bundleSha}.tar.gz`;
    const bundlePath = join(dir, 'accepted-images.tar.gz');
    if (bundleSha) await cachePut(bundlePath, bundleKey, bundleSha);
    const builderStagedAt = new Date().toISOString();
    const pair = await runPairIfNeeded(plan, accepted, manifest, bundleSha);
    const pairFinishedAt = new Date().toISOString();
    if (bundleSha) {
      requireThat(head === remoteMain() && same(latestProduction(), indexed), 'Cambió main o la base tras la prueba del par.');
      await loadFromBuilder(bundleKey, { token, sha256: bundleSha, bytes: statSync(bundlePath).size, images: accepted.images });
    }
    const transferFinishedAt = new Date().toISOString();
    let rehearsal;
    if (manifest.schemaVersion > live.schemaVersion) {
      const capture = host('capture-rehearsal', { token, base: live }, { timeout: 1_200_000 });
      const proof = await saveOffsite(token, capture);
      rehearsal = await testRecovery(token, proof, live, manifest);
      host('retire-rehearsal-copy', { token, sha256: proof.sha256 });
    }
    requireThat(head === remoteMain() && same(latestProduction(), indexed), 'main o la base de Actions cambiaron antes del corte; recalcular.');
    const acceptance = { runId: accepted.runId, runAttempt: accepted.runAttempt, planHash: accepted.planHash, baseDeploymentId: accepted.baseDeploymentId };
    const record = await apply({ token, base: live, manifest, services: plan.recreate, files, origin, rehearsal, acceptance });
    const deploymentId = publishProduction(record.manifest, record.kind);
    pretty({ ...report, deploymentId, transferStartedAt, builderStagedAt, pair, pairFinishedAt, transferFinishedAt,
      cutStartedAt: record.startedAt, writesPausedAt: record.writesPausedAt, verifiedAt: record.observedAt });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--inventory') await inventory();
  else if (args.length === 1 && args[0] === '--status') status();
  else if (args.length === 2 && args[0] === '--recover' && sha.test(args[1])) {
    const record = host('recover', { token: args[1] }, { timeout: 1_200_000 });
    pretty({ ...record, deploymentId: record.kind === 'release' ? publishProduction(record.manifest, record.kind) : undefined });
  } else if (args.length === 1 && sha.test(args[0])) await release(args[0], false);
  else if (args.length === 2 && args[0] === '--dry-run' && sha.test(args[1])) await release(args[1], true);
  else throw new Error('Uso: npm run deploy:production -- [--inventory | --status | --recover <id> | [--dry-run] <sha40>]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
