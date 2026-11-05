import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialLinkContracts } from './social-links-contract.mjs';

test('contratos financieros de vínculos sociales SQLite aislada', async t => {
  await runSocialLinkContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
