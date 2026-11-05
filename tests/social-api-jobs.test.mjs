import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialApiJobContracts } from './social-api-jobs-contract.mjs';

test('contratos del consumidor social API SQLite aislada', async t => {
  await runSocialApiJobContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
