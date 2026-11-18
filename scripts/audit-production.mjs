import { closeSync, existsSync, fchownSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { checkRuntime, privateJSON, publicState, requireLive, requireThat, same, smoke } from './production-host.mjs';
import { host, origin, releaseCache } from './production-release.mjs';
import { runAuditGuest } from '../deploy/audit/guest-host.mjs';
import { requiredChecks } from './release-impact.mjs';

const auditRoot = '/var/lib/allnutrition-audit';
const latest = join(auditRoot, 'last.json');
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
function snapshot() {
  let live;
  try { live = host('inspect', {}, { localBastion: true }); }
  catch { throw Error('No se pudo leer el inventario de producción por el transporte verificado.'); }
  const manifest = publicState(live.current?.manifest);
  requireLive(manifest, live, { strictPins: live.current.kind !== 'inventory' });
  checkRuntime(live);
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
