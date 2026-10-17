import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db/index.mjs';
import { runCommand, insertRow, newId, stamp } from '../lib/business/commands.mjs';

test('comandos comerciales son atómicos e idempotentes por actor y payload canónico', async () => {
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {
    const input={scope:'proof',requestId:'request-0001',actorId:'admin',payload:{b:2,a:1}};
    const execute=tx=>insertRow(tx,'people',{id:'person',name:'Responsable',active:1,data:'{}',version:1,created_at:stamp(),updated_at:stamp()}).then(()=>({id:'person'}));
    const results=await Promise.all([runCommand(store,input,execute),runCommand(store,{...input,payload:{a:1,b:2}},execute)]);
    assert.deepEqual(results,[{id:'person'},{id:'person'}]);
    assert.equal((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value,1);
    await assert.rejects(()=>runCommand(store,{...input,actorId:'another'},execute),{status:409});
    await assert.rejects(()=>runCommand(store,{...input,payload:{a:3,b:2}},execute),{status:409});
    await assert.rejects(()=>runCommand(store,{...input,requestId:'request-0002'},async tx=>{await insertRow(tx,'people',{id:newId(),name:'Revertido',active:1,data:'{}',version:1,created_at:stamp(),updated_at:stamp()});throw new Error('interrumpido');}),/interrumpido/);
    assert.equal((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('people')}`)).n,1);
    assert.equal((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('business_requests')}`)).n,1);
    await store.readSnapshot(async tx=>{
      assert.equal((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('people')}`)).n,1);
      assert.equal(tx.db.run,undefined);
      await assert.rejects(()=>tx.db.all(`DELETE FROM ${tx.t('people')} RETURNING id`),/readonly/);
    });
  } finally { await store.close(); }
});
