import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialAnalysisContracts } from './social-analysis-contract.mjs';

// Separate factory keeps this contract reusable against the disposable PG store.
test('contratos de estimación y análisis social SQLite aislada', async t => {
  await runSocialAnalysisContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
