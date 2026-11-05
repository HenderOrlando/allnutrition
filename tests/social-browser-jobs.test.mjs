import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialBrowserJobContracts } from './social-browser-jobs-contract.mjs';

test('contratos del consumidor de navegador en SQLite', async t => {
  await runSocialBrowserJobContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
