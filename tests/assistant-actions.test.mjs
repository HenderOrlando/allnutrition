import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runAssistantActionsContracts } from './assistant-actions-contract.mjs';

test('assistant actions use real SQLite business transactions', async t => {
  await runAssistantActionsContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }));
});
