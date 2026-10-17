import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db/index.mjs';
import { queueJobTx,claimJob,renewJob,finishJob } from '../lib/business/job-leases.mjs';
import { runCommand } from '../lib/business/commands.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { saveAccount,postCashEntryTx,accountBalance } from '../lib/business/cash.mjs';

test('solo un lease vigente puede aplicar dinero y la reanudación conserva actor/progreso',async()=>{
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {
    const person=await saveResource(store,'people',{name:'Responsable',requestId:'person-proof-001'},'original-admin');
    const today=bogotaDate(),account=await saveAccount(store,{requestId:'account-proof-001',name:'Banco',type:'bank',openingOn:today,openingBalanceMinor:0,responsibleId:person.id},'original-admin');
    const now='2026-09-01T05:00:00.000Z',later='2026-09-01T05:02:01.000Z';
    await store.transaction(async tx=>{await tx.lockWrites();await queueJobTx(tx,'import:proof',{kind:'import',actorId:'original-admin',requestedBy:'original-admin',progress:0},{now});});
    const claims=await Promise.all([claimJob(store,{prefix:'import:',now}),claimJob(store,{prefix:'import:',now})]);
    assert.equal(claims.filter(Boolean).length,1);const old=claims.find(Boolean);
    assert.equal(await claimJob(store,{prefix:'import:',now:'2026-09-01T05:01:59.000Z'}),null);
    const current=await claimJob(store,{prefix:'import:',now:later});assert.notEqual(current.token,old.token);
    const command={scope:'import:proof:group',requestId:'group-proof-001',payload:{accountId:account.id,amountMinor:12345},actorId:current.actorId};
    const write=tx=>postCashEntryTx(tx,{accountId:account.id,effectiveOn:today,amountMinor:12345,kind:'income',sourceType:'proof',sourceId:'group-proof',data:{concept:'other_non_sale'}},current.actorId);
    await assert.rejects(()=>runCommand(store,{...command,lease:{...old,now:later}},write),{status:409});
    assert.equal(await accountBalance(store,account.id),0);
    await assert.rejects(()=>runCommand(store,{...command,lease:{...current,now:later}},async tx=>{
      const entry=await write(tx);
      await tx.db.run(`UPDATE ${tx.t('job_runs')} SET lease_until=? WHERE key=?`,[now,current.key]);
      return entry;
    }),{status:409});
    assert.equal(await accountBalance(store,account.id),0);
    const entry=await runCommand(store,{...command,lease:{...current,now:later}},write);
    assert.equal((await runCommand(store,{...command,lease:{...current,now:later}},write)).id,entry.id);
    assert.equal(await accountBalance(store,account.id),12345);
    await assert.rejects(()=>renewJob(store,old,{now:later}),{status:409});
    await finishJob(store,current,{state:'queued',data:{progress:1},now:later});
    const resumed=await claimJob(store,{prefix:'import:',now:later});
    assert.equal(resumed.actorId,'original-admin');assert.equal(resumed.progress,1);assert.notEqual(resumed.token,current.token);
    await assert.rejects(()=>finishJob(store,current,{now:later}),{status:409});
    await finishJob(store,resumed,{state:'succeeded',now:later});assert.equal(await claimJob(store,{prefix:'import:',now:later}),null);
    assert.equal(await accountBalance(store,account.id),12345);
  }finally{await store.close();}
});
