import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runImportCancellationContracts } from './business-import-cancellation-contract.mjs';

test('Cancelación de importaciones en SQLite real',async t=>{
  await runImportCancellationContracts(t,()=>openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'}));
});
