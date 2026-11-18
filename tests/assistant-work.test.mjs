import test from 'node:test';
import { runAssistantWorkContracts } from './assistant-work-contract.mjs';
import { openStore } from '../lib/db/index.mjs';

test('recoverable assistant work contracts (SQLite)', t => runAssistantWorkContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
