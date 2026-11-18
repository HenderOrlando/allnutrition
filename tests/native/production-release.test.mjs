import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeFiles, publicState, requireLive, serviceOrder, sha256 } from '../../scripts/production-host.mjs';
import { configDigest, hashFile, hostCommand, projectTarget, run, verifyBundle } from '../../scripts/production-release.mjs';
import { canonicalPlan, configFiles, imageTag, requiredChecks } from '../../scripts/release-impact.mjs';

const commit = run('git', ['rev-parse', 'HEAD']).trim();
const configHashes = configDigest(commit, activeFiles);
const built = (kind, digit) => {
  const imageId = 'sha256:' + digit.repeat(64);
  return { imageId, imageTag: imageTag(kind, imageId), os: 'linux', architecture: 'amd64' };
};
const refs = Object.fromEntries(serviceOrder.map((name, i) => {
  const { imageTag, imageId } = built(name === 'social-browser' ? 'runner' : 'app', String(i + 1));
  return [name, { sourceCommit: commit, imageTag: name === 'db' ? 'postgres:16-bookworm' : imageTag, imageId }];
}));
const base = { format: 1, coveredThrough: commit, configCommit: commit, schemaVersion: 15, services: refs, configHashes, deploymentId: '29' };
const writeJSON = (name, data) => writeFileSync(name, JSON.stringify(data, null, 2) + '\n');

test('remote inspect is forwarded after a non-reserved Node positional argument', () => {
  const command = hostCommand('inspect', { scoped: true });
  assert.match(command, /'--' 'production-host' 'inspect' '[a-zA-Z0-9_-]+'/);
});

test('public deployment payload omits IDs, stages and private state; rejects mixed or altered live pins', () => {
  const live = publicState({ ...base, observed: { private: true }, credentials: 'excluded' });
  assert.equal(Object.hasOwn(live, 'deploymentId'), false);
  assert.equal(Object.hasOwn(live, 'observed'), false);
  assert.equal(Object.hasOwn(live, 'credentials'), false);
  const snapshot = { configHashes, schema: { version: 15 }, effectiveImages: { migrate: refs.web.imageTag }, containers: {} };
  for (const [service, ref] of Object.entries(refs)) {
    snapshot.containers[service] = { ...ref, running: true, health: ['scheduler', 'social-browser-worker'].includes(service) ? null : 'healthy' };
    snapshot.effectiveImages[service] = ref.imageTag;
  }
  requireLive(live, snapshot);
  snapshot.effectiveImages.scheduler = refs.web.imageTag;
  assert.throws(() => requireLive(live, snapshot), /Pin efectivo inválido: scheduler/);
  requireLive(live, snapshot, { strictPins: false });
  snapshot.containers.scheduler.imageId = refs.web.imageId;
  assert.throws(() => requireLive(live, snapshot, { strictPins: false }), /Deriva o salud inválida: scheduler/);
});

test('release envelope rejects stale base, missing gates, incorrect hash and separates applied paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allnutrition-release-test-'));
  const path = name => join(dir, name);
  const archive = path('sealed-source.tar.gz');
  try {
    run('bash', ['-euo', 'pipefail', '-c', 'git archive --format=tar "$1" | gzip -1 > "$2"', 'bash', commit, archive]);
    const plan = { gates: ['compose'], node: [], postgres: [], playwright: [], diagnostics: [], paths: [], build: [], recreate: ['scheduler'], config: [], schemaVersion: 15 };
    const item = { id: 123, run_attempt: 2 };
    const helpers = { head: commit, plan, canonicalPlan, requiredChecks, imageTag, configFiles };
    writeFileSync(path('impact.json'), canonicalPlan(plan));
    writeJSON(path('source-manifest.json'), { format: 1, sourceCommit: commit, sha256: await hashFile(archive) });
    const release = { format: 1, mode: 'impact', sourceCommit: commit, harnessCommit: commit, runId: '123', runAttempt: '2', baseDeploymentId: '29', planHash: sha256(canonicalPlan(plan)),
      requiredChecks: ['gate:compose'], passedChecks: ['gate:compose'], checks: { 'gate:compose': { count: 1, durationMs: 0 } }, services: ['scheduler'], configCommit: commit,
      schemaVersion: 15, configHashes: configDigest(commit, configFiles), images: {} };
    async function stamp() {
      writeJSON(path('release.json'), release);
      const names = ['release.json', 'source-manifest.json', 'impact.json', 'sealed-source.tar.gz'];
      writeFileSync(path('SHA256SUMS'), (await Promise.all(names.map(async name => `${await hashFile(path(name))}  ${name}\n`))).join(''));
    }
    await stamp();
    assert.equal(await verifyBundle(dir, item, { ...base, deploymentId: '30' }, helpers), null);
    const accepted = await verifyBundle(dir, item, base, helpers);
    assert.deepEqual(projectTarget(base, commit, plan, accepted.release, archive).manifest.services, refs);
    const mixed = { ...plan, recreate: ['web', 'scheduler'], paths: [{ path: 'app/page.js', reasons: ['runtime:web'] }] };
    const web = projectTarget(base, commit, mixed, { ...accepted.release, images: { app: built('app', 'f') } }, archive).manifest;
    assert.notEqual(web.services.web.imageId, refs.web.imageId);
    for (const name of serviceOrder.filter(service => service !== 'web')) assert.deepEqual(web.services[name], refs[name]);
    assert.throws(() => projectTarget(base, commit, { ...plan, config: ['deploy/pg_hba.conf'] }, accepted.release, archive), /Infraestructura/);
    release.passedChecks = [];
    await stamp();
    await assert.rejects(() => verifyBundle(dir, item, base, helpers), /compuerta obligatoria/);
    writeFileSync(path('impact.json'), '{}\n');
    await assert.rejects(() => verifyBundle(dir, item, base, helpers), /Hash distinto/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
