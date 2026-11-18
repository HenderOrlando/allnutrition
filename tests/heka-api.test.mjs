import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runHekaApiContracts } from './heka-api-contract.mjs';

test('API oficial Heka en SQLite aislada (proveedor sintético)', t => runHekaApiContracts(t, () => openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'})));
