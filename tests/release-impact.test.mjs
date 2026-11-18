import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { calculateImpact, requiredChecks } from '../scripts/release-impact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const noGit = spawnSync('git', ['--version']).error?.code === 'ENOENT';
const historyUnavailable = noGit || !existsSync(join(root, '.git'));
const fixtureOptions = { skip: noGit && 'Git is not installed' };
const historyOptions = { skip: historyUnavailable && 'Historical cases require a Git checkout' };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'allnutrition-impact-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--quiet', '--object-format=sha1', '--template=');
  const write = (path, contents) => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const commit = (message, files = {}) => {
    for (const [path, contents] of Object.entries(files)) write(path, contents);
    git(cwd, 'add', '--all');
    git(cwd, '-c', 'user.name=Release Impact Test', '-c', 'user.email=release-impact@example.invalid',
      '-c', 'core.hooksPath=.git/hooks', 'commit', '--quiet', '--no-gpg-sign', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  return { cwd, commit };
}

async function historical(revision) {
  const head = git(root, 'rev-parse', '--verify', `${revision}^{commit}`);
  const base = git(root, 'rev-parse', '--verify', `${head}^1`);
  const plan = await calculateImpact({ head, base, cwd: root });
  assert.equal(plan.head, head);
  assert.equal(plan.bases.coveredThrough, base);
  return plan;
}

function includes(actual, expected) {
  for (const value of expected) assert.ok(actual.includes(value), `Expected ${value} in ${JSON.stringify(actual)}`);
}

function noRelease(plan) {
  assert.deepEqual(plan.build, []);
  assert.deepEqual(plan.recreate, []);
  assert.deepEqual(plan.config, []);
}

function paths(plan) {
  return plan.paths.map(entry => entry.path);
}

test('4ad2aa3: documentation needs only the successful status check', historyOptions, async () => {
  const plan = await historical('4ad2aa345f30f2b59d10de0c0f2edd07ba7b38cc');
  assert.deepEqual(paths(plan), ['docs/CAMBIOS_V2.md']);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(requiredChecks(plan), []);
  noRelease(plan);
});

test('edfd99d: the public privacy page requires a compiled web and HTTPS only', historyOptions, async () => {
  const plan = await historical('edfd99dd366b3736649527cbfad20d100e3706f8');
  assert.deepEqual(paths(plan), ['app/privacy/page.jsx']);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.build, ['app']);
  assert.deepEqual(plan.recreate, ['web']);
  assert.deepEqual(plan.playwright, ['privacy']);
  assert.deepEqual(requiredChecks(plan), ['gate:https', 'gate:runtime']);
});

test('4992bba: the read-only Products mount recreates only scheduler', historyOptions, async t => {
  // Compose config requires the client plugin, not a running Docker daemon.
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (compose.status !== 0 && process.env.GITHUB_ACTIONS !== 'true') {
    assert.ok(!compose.error || compose.error.code === 'ENOENT', String(compose.error));
    return t.skip('Docker Compose is not installed');
  }
  assert.equal(compose.status, 0, compose.stderr || String(compose.error));
  const plan = await historical('4992bba17f611096cef281e4bdb8d1103f371e6f');
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(paths(plan), ['compose.yaml']);
  assert.deepEqual(plan.config, ['compose.yaml']);
  assert.deepEqual(plan.build, []);
  assert.deepEqual(plan.recreate, ['scheduler']);
  assert.deepEqual(requiredChecks(plan), ['gate:compose']);
});

test('an app image build and scheduler mount retain distinct pin decisions', fixtureOptions, async t => {
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (compose.status !== 0 && process.env.GITHUB_ACTIONS !== 'true') return t.skip('Docker Compose is not installed');
  assert.equal(compose.status, 0, compose.stderr);
  const { cwd, commit } = repository(t);
  const yaml = [
    'services:', '  web:', '    image: ${APP_IMAGE}', '  scheduler:', '    image: ${SCHEDULER_IMAGE}',
  ];
  const base = commit('base', { 'app/privacy/page.jsx': 'export default function Page() { return <p>Base</p> }\n', 'compose.yaml': `${yaml.join('\n')}\n` });
  const head = commit('web update and scheduler mount', {
    'app/privacy/page.jsx': 'export default function Page() { return <p>Updated</p> }\n',
    'compose.yaml': `${[...yaml, '    volumes: ["products:/products:ro"]', 'volumes:', '  products:'].join('\n')}\n`,
  });
  const plan = await calculateImpact({ head, base, cwd });
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.build, ['app']);
  assert.deepEqual(plan.recreate, ['scheduler', 'web']);
  assert.ok(!plan.paths.some(item => item.reasons.includes('runtime:scheduler')));
  assert.deepEqual(requiredChecks(plan), ['gate:compose', 'gate:https', 'gate:runtime']);
});

test('387b4e7: official Heka selects backup/export, PostgreSQL, UI and v15 migration', historyOptions, async () => {
  const plan = await historical('387b4e72b39fcfa6a75036a48842d08a224009b7');
  includes(paths(plan), ['app/api/admin/shipping/heka/route.js', 'lib/business-backup.mjs',
    'db/heka-api-v15.postgres.sql', 'db/heka-api-v15.sqlite.sql']);
  includes(plan.node, ['tests/heka-api.test.mjs', 'tests/heka-browser.mjs', 'tests/backup-restore.test.mjs']);
  includes(plan.postgres, ['heka', 'backup', 'schema']);
  assert.ok(plan.playwright.includes('integrations:heka') || plan.playwright.includes('integrations'));
  includes(plan.gates, ['https', 'postgres', 'migration', 'restore']);
  includes(plan.build, ['app']);
  includes(plan.recreate, ['web']);
  assert.ok(!plan.recreate.includes('db'));
  assert.equal(plan.schemaVersion, 15);
});

test('rename and deletion retain launchers from the previous dependency graph', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const base = commit('launchers and their independent helpers', {
    'tests/renamed input.mjs': 'export const renamed = 1;\n',
    'tests/deleted input.mjs': 'export const deleted = 2;\n',
    'tests/rename-case.test.mjs': 'import { renamed } from "./renamed input.mjs";\n',
    'tests/delete-case.test.mjs': 'import { deleted } from "./deleted input.mjs";\n',
    'tests/unrelated.test.mjs': 'export {};\n',
  });
  git(cwd, 'mv', 'tests/renamed input.mjs', 'tests/moved input.mjs');
  git(cwd, 'rm', '--quiet', 'tests/deleted input.mjs');
  const head = commit('move one helper and delete the other without touching launchers');
  const plan = await calculateImpact({ head, base, cwd });
  assert.deepEqual(paths(plan), ['tests/deleted input.mjs', 'tests/moved input.mjs', 'tests/renamed input.mjs']);
  assert.deepEqual(plan.node, ['tests/delete-case.test.mjs', 'tests/rename-case.test.mjs']);
  noRelease(plan);
});

test('a shared leaf reaches web and both jobs roles via re-export and literal dynamic alias', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const base = commit('two consumers of a shared transitive runtime module', {
    'lib/shared/leaf.mjs': 'export const value = 1;\n',
    'lib/shared/runtime.mjs': 'export { value } from "./leaf.mjs";\n',
    'app/api/admin/orders/route.js': 'export const GET = () => import("@/lib/shared/runtime");\n',
    'scripts/business-jobs.mjs': 'await import("@/lib/shared/runtime");\n',
    'scripts/social-browser.mjs': 'export {};\n',
    'tests/shared-contract.mjs': 'export { value } from "../lib/shared/runtime.mjs";\n',
    'tests/shared-runtime.test.mjs': 'import { value } from "./shared-contract.mjs";\n',
    'tests/unrelated.test.mjs': 'export {};\n',
    'tests/e2e/app.spec.mjs': 'export {};\n',
  });
  const head = commit('change only the leaf', { 'lib/shared/leaf.mjs': 'export const value = 2;\n' });
  const plan = await calculateImpact({ head, base, cwd });
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.node, ['tests/shared-runtime.test.mjs']);
  assert.deepEqual(plan.playwright, ['app:orders']);
  assert.deepEqual(plan.build, ['app']);
  assert.deepEqual(plan.recreate, ['scheduler', 'social-browser-worker', 'web']);
  assert.deepEqual(plan.paths, [{ path: 'lib/shared/leaf.mjs', reasons: [
    'coveredThrough', 'runtime:scheduler', 'runtime:social-browser-worker', 'runtime:web',
  ] }]);
  assert.deepEqual(await calculateImpact({ head, base, cwd }), plan);
});

test('zero, missing and non-ancestor bases fail wide instead of reporting no work', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const initial = commit('candidate baseline', {
    'README.md': 'Baseline\n',
    'db/example-v1.postgres.sql': 'SELECT 1;\n',
    'tests/smoke.test.mjs': 'export {};\n',
    'tests/postgres.integration.test.mjs': 'export {};\n',
    'tests/e2e/app.spec.mjs': 'export {};\n',
  });
  const head = commit('candidate documentation', { 'README.md': 'Candidate\n' });
  git(cwd, 'checkout', '--quiet', '--detach', initial);
  const diverged = commit('other branch', { 'README.md': 'Not in the candidate\n' });
  const missing = 'f'.repeat(40);
  for (const [kind, base] of [['missing argument', undefined], ['missing object', missing],
    ['zero SHA', '0'.repeat(40)], ['non-ancestor', diverged]]) {
    await t.test(kind, async () => {
      const plan = await calculateImpact({ head, base, cwd });
      includes(plan.diagnostics, ['base:coveredThrough:unknown-or-not-ancestor']);
      assert.deepEqual(plan.build, ['app', 'runner']);
      assert.deepEqual(plan.recreate, ['scheduler', 'social-browser', 'social-browser-worker', 'web']);
      includes(requiredChecks(plan), ['node:tests/smoke.test.mjs', 'playwright:app', 'pg:schema',
        'gate:runtime', 'gate:https', 'gate:migration', 'gate:restore', 'gate:infra']);
    });
  }
});

test('unowned runtime changes identify every binary selected for safe fallback', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const base = commit('base', { 'README.md': 'Fixtures\n' });
  const head = commit('unowned module', { 'lib/unowned.mjs': 'export const flag = true;\n' });
  const plan = await calculateImpact({ head, base, cwd });
  assert.deepEqual(plan.build, ['app', 'runner']);
  assert.deepEqual(plan.recreate, ['scheduler', 'social-browser', 'social-browser-worker', 'web']);
  includes(plan.paths.find(item => item.path === 'lib/unowned.mjs').reasons,
    ['runtime:unowned', 'runtime:web', 'runtime:scheduler', 'runtime:social-browser', 'runtime:social-browser-worker']);
});

test('a changed test contract runs its launcher without offering a release', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const base = commit('test contract and launcher', {
    'tests/fixture-contract.mjs': 'export const example = 1;\n',
    'tests/fixture.test.mjs': 'import { example } from "./fixture-contract.mjs";\n',
    'tests/unrelated.test.mjs': 'export {};\n',
  });
  const head = commit('change only the test contract', { 'tests/fixture-contract.mjs': 'export const example = 2;\n' });
  const plan = await calculateImpact({ head, base, cwd });
  assert.deepEqual(requiredChecks(plan), ['node:tests/fixture.test.mjs']);
  noRelease(plan);
});

test('workflow, harness and npm-script-only changes each require harness checks, not images', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const pkg = { name: 'impact-fixture', dependencies: { example: '1.0.0' }, scripts: { verify: 'node one.mjs' } };
  let base = commit('initial harness', {
    '.github/workflows/ci.yml': 'name: CI\n',
    'scripts/verify-docker.mjs': 'export const version = 1;\n',
    'package.json': JSON.stringify(pkg),
    'scripts/business-jobs.mjs': 'export {};\n',
    'scripts/social-browser.mjs': 'export {};\n',
  });
  for (const [path, content] of [
    ['.github/workflows/ci.yml', 'name: Impact CI\n'],
    ['scripts/verify-docker.mjs', 'export const version = 2;\n'],
    ['package.json', JSON.stringify({ ...pkg, scripts: { verify: 'node two.mjs' } })],
  ]) {
    await t.test(path, async () => {
      const head = commit(path, { [path]: content });
      const plan = await calculateImpact({ head, base, cwd });
      assert.deepEqual(paths(plan), [path]);
      assert.deepEqual(requiredChecks(plan), ['gate:harness']);
      noRelease(plan);
      base = head;
    });
  }
});

test('mixed production provenance preserves a pending Heka change behind a docs-only HEAD', fixtureOptions, async t => {
  const { cwd, commit } = repository(t);
  const web = commit('web and database on the old release', {
    'README.md': 'Previous release\n',
    'db/old-v14.postgres.sql': 'SELECT 14;\n',
    'scripts/business-jobs.mjs': 'export {};\n',
    'scripts/migrate.mjs': 'export {};\n',
    'scripts/social-browser.mjs': 'export {};\n',
    'tests/postgres.integration.test.mjs': 'export {};\n',
    'tests/e2e/integrations.spec.mjs': 'export {};\n',
  });
  const heka = commit('Heka is reviewed but web and schema were not promoted', {
    'app/api/admin/shipping/heka/route.js': 'export const GET = () => new Response("heka");\n',
    'db/heka-api-v15.postgres.sql': 'SELECT 15;\n',
    'tests/heka-api.test.mjs': 'export {};\n',
    'tests/heka-browser.mjs': 'export {};\n',
  });
  const head = commit('documentation follow-up', { 'README.md': 'Heka release notes\n' });
  const immediate = await calculateImpact({ head, base: heka, cwd });
  assert.deepEqual(requiredChecks(immediate), []);
  noRelease(immediate);

  const sources = { web, scheduler: heka, 'social-browser-worker': heka, 'social-browser': heka, db: web };
  const state = {
    format: 1, coveredThrough: heka, configCommit: heka, deploymentId: '123', schemaVersion: 14,
    services: Object.fromEntries(Object.entries(sources).map(([unit, sourceCommit]) => [unit, { sourceCommit }])),
  };
  const plan = await calculateImpact({ head, state, cwd });
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.bases, { coveredThrough: heka, configCommit: heka, deploymentId: '123', services: sources, schemaVersion: 14 });
  includes(paths(plan), ['README.md', 'app/api/admin/shipping/heka/route.js', 'db/heka-api-v15.postgres.sql']);
  assert.deepEqual(plan.build, ['app']);
  assert.deepEqual(plan.recreate, ['scheduler', 'social-browser-worker', 'web']);
  assert.ok(!plan.paths.some(item => item.reasons.some(reason => ['runtime:scheduler', 'runtime:social-browser-worker'].includes(reason))));
  includes(requiredChecks(plan), ['node:tests/heka-api.test.mjs', 'node:tests/heka-browser.mjs',
    'pg:heka', 'pg:backup', 'pg:schema', 'playwright:integrations:heka', 'gate:migration', 'gate:restore']);
  assert.equal(plan.schemaVersion, 15);
});
