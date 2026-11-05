import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialImprovementContracts } from './social-improvements-contract.mjs';

test('contratos de mejoras sociales en SQLite aislada', async t => {
  await runSocialImprovementContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
