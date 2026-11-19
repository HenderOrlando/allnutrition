import { closeSync, existsSync, fchownSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { auditFindings, publicationFailure, publishAuditFindings } from './audit-issues.mjs';
import { checkRuntime, privateJSON, publicState, requireLive, requireThat, same, smoke } from './production-host.mjs';
import { host, origin, releaseCache } from './production-release.mjs';
import { runAuditGuest } from '../deploy/audit/guest-host.mjs';
import { requiredChecks } from './release-impact.mjs';

const auditRoot = '/var/lib/allnutrition-audit';
const latest = join(auditRoot, 'last.json');
const issueIntents = join(auditRoot, 'issue-create-intents.json');
const currentStatus = join(releaseCache(), 'audit-status.json');
const cacheOwner = () => {
  const info = lstatSync(releaseCache());
  requireThat(info.isDirectory() && (info.mode & 0o077) === 0, 'La caché del operador no es privada.');
  return info;
};

function store(report, record = false) {
  privateJSON(latest, report);
  if (record) privateJSON(join(auditRoot, 'reports', report.startedAt.replaceAll(':', '-') + '.json'), report);
  // Mirror only operational evidence readable by the release operator; the cache and journal stay private.
  const { uid, gid } = cacheOwner();
  const temporary = `${currentStatus}.${randomUUID()}`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); fchownSync(fd, uid, gid); }
    finally { closeSync(fd); }
    renameSync(temporary, currentStatus);
  } finally { rmSync(temporary, { force: true }); }
}

function assertCurrent(report) {
  if (!report.manifest) return; // Inventory failures can have no verifiable commit.
  const { manifest, live } = snapshot();
  requireThat(same(manifest, report.manifest) && (!report.cohort || same(cohort(live), report.cohort)), 'La observación de auditoría ya no corresponde a producción.');
}

async function publish(report) {
  if (!auditFindings(report).length) {
    store({ ...report, publication: { status: 'not-needed' } }, true);
    return;
  }
  let publication = { status: 'pending' };
  store({ ...report, publication }, true);
  try {
    assertCurrent(report);
    const values = existsSync(issueIntents) ? JSON.parse(readFileSync(issueIntents, 'utf8')) : [];
    requireThat(Array.isArray(values) && values.every(value => ['audit-failure', 'job-failures'].includes(value)), 'Registro local de publicación inválido.');
    const issues = await publishAuditFindings({ report, intents: new Set(values),
      saveIntents: intents => privateJSON(issueIntents, [...intents]), beforeWrite: () => assertCurrent(report) });
    publication = { status: 'delivered', issues };
  } catch (error) {
    publication = { status: 'failed', code: publicationFailure(error) };
  }
  store({ ...report, publication }, true);
  requireThat(publication.status === 'delivered', `Publicación de hallazgos pendiente: ${publication.code}.`);
}

const cohort = live => Object.fromEntries(Object.entries(live.containers).map(([service, ref]) => [service, ref.id]));
function snapshot() {
  let live;
  try { live = host('inspect', {}, { localBastion: true }); }
  catch { throw Error('No se pudo leer el inventario de producción por el transporte verificado.'); }
  const manifest = publicState(live.current?.manifest);
  requireLive(manifest, live, { strictPins: live.current.kind !== 'inventory' });
  return { manifest, live };
}
async function suite(manifest) {
  const proof = await runAuditGuest(manifest);
  requireThat(proof?.exitCode === 0 && proof.head === manifest.coveredThrough && proof.checks, 'El invitado no acreditó la fuente desplegada.');
  const required = requiredChecks({}, 'full');
  requireThat(required.every(check => Number.isSafeInteger(proof.checks[check]?.count) && proof.checks[check].count > 0
    && Number.isSafeInteger(proof.checks[check].durationMs) && proof.checks[check].durationMs >= 0),
  'El informe del invitado no acredita todas las compuertas de revisión integral.');
  const expected = Object.fromEntries(Object.entries(manifest.services).map(([service, ref]) => [service, ref.imageId]));
  requireThat(same(proof.checks['gate:runner'].images, expected), 'El informe no acredita el conjunto mixto de IDs observado.');
  const commits = new Set([manifest.coveredThrough, manifest.configCommit, ...Object.values(manifest.services).map(ref => ref.sourceCommit)]);
  return {
    checks: Object.fromEntries(required.map(check => [check, { count: proof.checks[check].count, durationMs: proof.checks[check].durationMs }])),
    sources: Object.fromEntries([...commits].map(commit => [commit, true])),
  };
}

async function audit() {
  for (;;) {
    let report = { format: 1, status: 'running', stage: 'inventory', startedAt: new Date().toISOString() };
    let failure;
    try {
      store(report);
      const { manifest, live } = snapshot();
      report = { ...report, manifest, cohort: cohort(live), observedAt: live.observedAt, heartbeat: live.schema.heartbeat, recentFailures: live.schema.recentFailures };
      checkRuntime(live);
      report.stage = 'live-https';
      store(report);
      report.probes = await smoke(origin, { bootstrap: manifest.schemaVersion < 15 });
      report.stage = 'disposable-suite';
      store(report);
      report.suite = await suite(manifest);
      report.stage = 'closing-inventory';
      store(report);
      const closed = snapshot();
      const superseded = !same(closed.manifest, manifest) || !same(cohort(closed.live), report.cohort);
      if (superseded) {
        store({ ...report, status: 'superseded', stage: 'complete', finishedAt: new Date().toISOString(), closingManifest: closed.manifest }, true);
        await delay(10_000);
        continue;
      }
      report.closingRecentFailures = closed.live.schema.recentFailures;
      checkRuntime(closed.live);
      report = { ...report, status: 'passed', stage: 'complete', finishedAt: new Date().toISOString(), closingManifest: closed.manifest };
    } catch (error) {
      failure = error;
      report = { ...report, status: 'failed', finishedAt: new Date().toISOString(), error: error.message.replace(/[\r\n]+/g, ' ').slice(0, 240) };
    }
    await publish(report);
    if (failure) throw failure;
    return;
  }
}
try {
  process.umask(0o077);
  requireThat(process.platform === 'linux' && process.arch === 'x64' && process.getuid() === 0 && process.versions.node.startsWith('24.') && !existsSync('/home/allnutrition/app/.env.server.local'), 'Auditor reservado al recolector Linux amd64 Node24 del constructor, no a la VM.');
  const vmIdentity = realpathSync(process.env.ALLNUTRITION_VM_KEY || '/etc/allnutrition-audit/missing');
  const key = lstatSync(vmIdentity);
  requireThat(vmIdentity.startsWith('/etc/allnutrition-audit/') && key.isFile() && key.uid === 0 && (key.mode & 0o077) === 0, 'La identidad del recolector debe permanecer fuera del acceso del usuario de pruebas.');
  mkdirSync(join(auditRoot, 'reports'), { recursive: true, mode: 0o700 });
  const dir = lstatSync(auditRoot);
  requireThat(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o077) === 0, 'Estado de auditoría no es privado.');
  const args = process.argv.slice(2);
  if (!args.length) await audit();
  else if (args.length === 1 && args[0] === '--publish-pending') {
    const report = JSON.parse(readFileSync(latest, 'utf8'));
    requireThat(['passed', 'failed'].includes(report.status) && auditFindings(report).length &&
      (!report.publication || ['pending', 'failed'].includes(report.publication.status)), 'No hay hallazgos recientes pendientes de publicar.');
    await publish(report);
  } else throw Error('Uso: audit-production.mjs [--publish-pending]; ejecutar bajo audit.lock.');
}
catch (error) { console.error(error.message.replace(/[\r\n]+/g, ' ').slice(0, 240)); process.exitCode = 1; }
