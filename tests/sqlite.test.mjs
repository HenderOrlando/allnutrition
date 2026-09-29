import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runContracts } from './contract.mjs';
test('Contrato completo con SQLite real',async t=>runContracts(t,()=>openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'})));
