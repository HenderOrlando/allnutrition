import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runShippingBridgeContracts } from './shipping-bridge-contract.mjs';

test('contratos de bridge Heka SQLite aislada', async t => {
  await runShippingBridgeContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
