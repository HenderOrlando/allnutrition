import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runSocialAudienceContracts } from './social-audience-contract.mjs';

test('audiencia de publicaciones · SQLite privada', t => runSocialAudienceContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
