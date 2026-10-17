import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runContracts } from './contract.mjs';
import { runBusinessContracts } from './business-contract.mjs';
test('Contrato completo con SQLite real',async t=>{
 const factory=()=>openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
 await runContracts(t,factory);await runBusinessContracts(t,factory);
});
