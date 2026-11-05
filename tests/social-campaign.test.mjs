import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialCampaignContracts } from './social-campaign-contract.mjs';

test('contratos de campañas sociales SQLite aislada', async t => {
  await runSocialCampaignContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
