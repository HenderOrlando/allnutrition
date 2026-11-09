import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runHekaImportContracts } from './heka-import-contract.mjs';

test('contratos de preparación e importación Heka SQLite aislada', async t => {
  await runHekaImportContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
