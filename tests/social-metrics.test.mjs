import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialMetricsContracts } from './social-metrics-contract.mjs';

test('contratos de métricas sociales canónicas en SQLite', async t => {
  await runSocialMetricsContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
