import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialSettingsContracts } from './social-settings-contract.mjs';

test('contratos de configuración social SQLite aislada', async t => {
  await runSocialSettingsContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
