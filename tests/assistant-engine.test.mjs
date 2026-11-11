import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runAssistantEngineContracts } from './assistant-engine-contract.mjs';

test('assistant engine acceptance with SQLite', async t => {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await store.initialize();
    await runAssistantEngineContracts(t, store);
  } finally {
    await store.close();
  }
});
