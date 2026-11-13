import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { resetPostgresStore, withPostgresTestDatabase } from './postgres-fixture.mjs';
import { runAssistantWorkContracts } from './assistant-work.test.mjs';
import { runAssistantEngineContracts } from './assistant-engine-contract.mjs';

test('recoverable assistant work contracts (disposable PostgreSQL)', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  await withPostgresTestDatabase(async env=>{
    const factory = async () => {
      const store = await openStore(env);
      try { await resetPostgresStore(store); return store; }
      catch (error) { await store.close(); throw error; }
    };
    await runAssistantWorkContracts(t, factory, { openRuntime: () => openStore(env) });
    await t.test('recoverable engine and authoritative reads on PostgreSQL',async context=>{
      const store=await factory();
      try { await runAssistantEngineContracts(context,store); }
      finally { await store.close(); }
    });
  });
});
