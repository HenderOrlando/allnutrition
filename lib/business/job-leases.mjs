import { fail, text } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { entity, insertRow, newId, stamp, assertLease } from './commands.mjs';
export const LEASE_MILLISECONDS=120000;
const expires=now=>new Date(Date.parse(now)+LEASE_MILLISECONDS).toISOString();
export function jobClock(now=stamp()) {const origin=Date.parse(instant(now)),started=Date.now();return ()=>new Date(origin+Date.now()-started).toISOString();}
export function schedulerHealth(row, now = stamp()) {
  now=instant(now);
  const lastHeartbeatAt=row?.updated_at || row?.updatedAt || null;
  const age=lastHeartbeatAt ? Date.parse(now)-Date.parse(lastHeartbeatAt) : null;
  const status=!lastHeartbeatAt ? 'never' : !Number.isFinite(age) || age<0 ? 'clock_skew'
    : row.error_code || row.errorCode || row.state==='failed' ? 'error' : age>=180000 ? 'stale' : 'running';
  return {status,lastHeartbeatAt,checkedAt:now,staleAfterSeconds:180,errorCode:row?.error_code || row?.errorCode || null};
}
export async function queueJobTx(tx,key,data,{now=stamp()}={}) {
  key=text(key,'Trabajo',300,true);now=instant(now);
  const old=await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`,[key]);
  if(old?.state==='running'&&old.lease_until>now)fail('El trabajo ya se está ejecutando.',409);
  if(old)await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='queued',lease_token=NULL,lease_until=NULL,started_at=NULL,finished_at=NULL,error_code=NULL,data=?,version=version+1,updated_at=? WHERE key=?`,[JSON.stringify(data),now,key]);
  else await insertRow(tx,'job_runs',{key,state:'queued',lease_token:null,lease_until:null,started_at:null,finished_at:null,error_code:null,data:JSON.stringify(data),version:1,created_at:now,updated_at:now});
  return entity(await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`,[key]));
}
export async function claimJob(store,{key=null,prefix='',now=stamp()}={}) {
  const clock=jobClock(now);
  return store.transaction(async tx=>{
    await tx.lockWrites();
    now=clock();
    const where=[`(state='queued' OR (state='running' AND lease_until<=?))`],values=[now];
    if(key){where.push('key=?');values.push(text(key,'Trabajo',300,true));}
    if(prefix){where.push(`key LIKE ? ESCAPE '!'`);values.push(text(prefix,'Tipo de trabajo',150,true).replace(/[!%_]/g,c=>'!'+c)+'%');}
    const row=await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE ${where.join(' AND ')} ORDER BY created_at,key LIMIT 1`,values);
    if(!row)return null;
    const token=newId(),until=expires(now);
    await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='running',lease_token=?,lease_until=?,started_at=COALESCE(started_at,?),finished_at=NULL,error_code=NULL,version=version+1,updated_at=? WHERE key=?`,[token,until,now,now,row.key]);
    return {...JSON.parse(row.data),key:row.key,token,leaseUntil:until};
  });
}
export async function renewJob(store,lease,{now=stamp()}={}) {
  const clock=jobClock(now);
  return store.transaction(async tx=>{
    await tx.lockWrites();now=clock();await assertLease(tx,{key:lease.key,token:lease.token,now});
    const result=await tx.db.run(`UPDATE ${tx.t('job_runs')} SET lease_until=?,updated_at=?,version=version+1 WHERE key=? AND lease_token=? AND state='running' AND lease_until>?`,[expires(now),now,lease.key,lease.token,clock()]);
    if(!result.changes)fail('El trabajo fue tomado por otro proceso.',409);
    await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});
    return {...lease,leaseUntil:expires(now)};
  });
}
export async function updateJobProgressTx(tx,lease,data,{now=stamp()}={}) {
  const clock=jobClock(now);now=clock();await assertLease(tx,{key:lease.key,token:lease.token,now});
  const row=await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`,[lease.key]);
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET data=?,updated_at=?,version=version+1 WHERE key=? AND lease_token=?`,[JSON.stringify({...JSON.parse(row.data),...data}),now,lease.key,lease.token]);
  await assertLease(tx,{key:lease.key,token:lease.token,now:clock()});
}
export async function finishJob(store,lease,{state='succeeded',data={},errorCode=null,now=stamp()}={}) {
  if(!['queued','succeeded','failed'].includes(state))fail('Estado del trabajo no válido.');const clock=jobClock(now);
  return store.transaction(async tx=>{
    await tx.lockWrites();now=clock();await assertLease(tx,{key:lease.key,token:lease.token,now});
    const row=await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`,[lease.key]);
    const result=await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state=?,lease_token=NULL,lease_until=NULL,finished_at=?,error_code=?,data=?,version=version+1,updated_at=? WHERE key=? AND lease_token=? AND state='running' AND lease_until>?`,[state,state==='queued'?null:now,errorCode,JSON.stringify({...JSON.parse(row.data),...data}),now,lease.key,lease.token,clock()]);
    if(!result.changes)fail('El trabajo fue tomado por otro proceso.',409);
    return entity(await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`,[lease.key]));
  });
}
export async function withLeaseHeartbeat(store,lease,fn,{now=stamp()}={}) {
  const clock=jobClock(now);let pending=null,lost=null;
  const timer=setInterval(()=>{if(pending||lost)return;pending=renewJob(store,lease,{now:clock()}).catch(error=>{lost=error;}).finally(()=>{pending=null;});},30000);
  timer.unref();
  try {const result=await fn({lease,clock,assertActive:()=>{if(lost)throw lost;}});if(lost)throw lost;return result;}
  finally {clearInterval(timer);if(pending)await pending;}
}
