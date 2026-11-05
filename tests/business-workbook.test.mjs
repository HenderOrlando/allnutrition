import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runWorkbookImportContracts } from './business-workbook-contract.mjs';

test('Contratos de incorporación de libros con SQLite real en memoria', async t => {
  await runWorkbookImportContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
