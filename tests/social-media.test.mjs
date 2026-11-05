import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialMediaContracts } from './social-media-contract.mjs';

test('piezas sociales privadas con archivos y procesadores reales en SQLite', async t => {
  await runSocialMediaContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
