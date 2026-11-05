import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/db/index.mjs';
import { schedulerHealth } from '../lib/business/job-leases.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/business-jobs.mjs', import.meta.url));
async function environment(t) {
  const directory = await mkdtemp(join(tmpdir(), 'allnutrition-jobs-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    ...process.env,
    DB_DRIVER: 'sqlite', SQLITE_PATH: join(directory, 'jobs.sqlite'),
    NODE_OPTIONS: '', SOCIAL_BROWSER_ENABLED: 'false', SOCIAL_PUBLISHING_ENABLED: 'false',
    META_APP_ID: '', META_APP_SECRET: '', META_LOGIN_CONFIG_ID: '',
    SOCIAL_MEDIA_DIR: join(directory, 'social-media'), IMPORT_FILES_DIR: join(directory, 'imports'),
  };
}
const run = (args, env) => execute(process.execPath, [script, ...args], { cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024 });
const heartbeat = (store, key) => store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [key]);

test('worker CLI rejects unknown or duplicate arguments before creating a database', async t => {
  const env = await environment(t);
  for (const args of [
    ['--invalid'], ['--once', '--once'], ['--social-browser', '--social-browser'],
    ['--social-browser', '--once', '--once'], ['--once', '--social-browser', '--invalid'],
  ]) {
    await assert.rejects(run(args, env), error => error.code === 1 && !error.stdout.trim());
    await assert.rejects(access(env.SQLITE_PATH), error => error.code === 'ENOENT');
  }
});

test('normal once worker preserves its result and does not report browser health', async t => {
  const env = await environment(t);
  const { stdout } = await run(['--once'], env);
  const result = JSON.parse(stdout);
  assert.equal(result.browser, undefined);
  const store = await openStore(env);
  try {
    assert.equal(schedulerHealth(await heartbeat(store, 'scheduler:heartbeat')).status, 'running');
    assert.equal(schedulerHealth(await heartbeat(store, 'scheduler:social-browser:heartbeat')).status, 'never');
  } finally { await store.close(); }
});

for (const args of [['--social-browser', '--once'], ['--once', '--social-browser']]) {
  test(`browser once worker accepts ${args.join(' ')} and only renews browser health`, async t => {
    const env = await environment(t);
    const before = await openStore(env);
    let revision;
    try { revision = await before.db.get(`SELECT value FROM ${before.t('counters')} WHERE id='business_revision'`); }
    finally { await before.close(); }
    const { stdout } = await run(args, env);
    assert.deepEqual(JSON.parse(stdout), { browser: { processed: 0, errorCode: null }, hasMore: false });
    const store = await openStore(env);
    try {
      assert.equal(schedulerHealth(await heartbeat(store, 'scheduler:social-browser:heartbeat')).status, 'running');
      assert.equal(schedulerHealth(await heartbeat(store, 'scheduler:heartbeat')).status, 'never');
      assert.equal(await heartbeat(store, 'scheduler:payroll'), null);
      assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), revision);
    } finally { await store.close(); }
  });
}
