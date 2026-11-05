import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialContracts } from './social-contract.mjs';

test('contratos sociales SQLite aislada', async t => {
  await runSocialContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
