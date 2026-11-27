import { fail, integer } from '../validation-core.mjs';
import { HekaApiError } from '../shipping/heka-api.mjs';
import { hash, newId, stamp } from './commands.mjs';
import { getHekaWebhookSettings, HEKA_NOVELTY_CONNECTION, readHekaNoveltyPage, readHekaWebhookCredential, readHekaWebhookNovelty } from './heka-api.mjs';
import { jobClock, schedulerHealth } from './job-leases.mjs';
import { hekaWebhookQueue } from './heka-webhook.mjs';

const INTERVAL = 60000;
const CATCHUP_INTERVAL = 10000;
const DAY = 86400000;
const PROOF_TTL = 2*DAY;
const LEASE = 45000;
const PAGE_SIZE = 20;
const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const states = new Map([['in_novelty','pending'],['in_review','review'],['in_progress','review'],['in_claim','review'],['resolved','resolved']]);
const opposite = sequence => sequence==='open' ? 'resolved' : 'open';
const after = (now,ms) => new Date(Date.parse(now)+ms).toISOString();
const whereScope = (alias='') => `${alias}connection_id=? AND ${alias}environment=? AND ${alias}generation=?`;
const scopeKeys = ({ environment, generation }) => [HEKA_NOVELTY_CONNECTION,environment,generation];
const syncRow = (tx,scope) => tx.db.get(`SELECT * FROM ${tx.t('shipping_novelty_sync')} WHERE ${whereScope()}`,scopeKeys(scope));
const values = (records,width) => records.map(() => `(${Array(width).fill('?').join(',')})`).join(',');
const locked = (store,fn) => store.transaction(async tx => { await tx.lockWrites(); return fn(tx); });

const evidenceUntil = (row,config) => config.revision && row?.webhook_verified_revision===config.revision && row.webhook_verified_at
  ? after(row.webhook_verified_at,PROOF_TTL) : null;
const nextDue = (row,now,revoked,trusted) => !row || revoked ? now
  : trusted && row.guide_next_at && row.guide_next_at<row.next_at ? row.guide_next_at : row.next_at;

async function currentProof(store,row,config,now,options) {
  if (!(evidenceUntil(row,config)>now)) return false;
  try { return (await readHekaWebhookCredential(store,config.environment,options))?.revision===config.revision; }
  catch (error) {
    if (error.code?.startsWith('INTEGRATION_')) return false;
    throw error;
  }
}

async function claimPage(store,clock,options) {
  const config = await getHekaWebhookSettings(store);
  if (!config.connected) return {nextAt:null};
  const current = await syncRow(store,config), at = clock();
  if (current?.lease_until>at) return {nextAt:current.lease_until};
  const valid = current?.webhook_verified_revision && await currentProof(store,current,config,at,options);
  const due = nextDue(current,at,current?.webhook_verified_revision && !valid,valid);
  if (due>at) return {nextAt:valid && evidenceUntil(current,config)<due ? evidenceUntil(current,config) : due};
  return locked(store,async tx => {
    const scope = await getHekaWebhookSettings(tx);
    if (!scope.connected || scope.environment!==config.environment || scope.generation!==config.generation) return {nextAt:clock()};
    const now = clock(), keys = scopeKeys(scope), table = tx.t('shipping_novelty_sync');
    const row = await syncRow(tx,scope);
    if (row?.lease_until>now) return {nextAt:row.lease_until};
    const trusted = row?.webhook_verified_revision && await currentProof(tx,row,scope,now,options);
    const revoked = row?.webhook_verified_revision && !trusted;
    const nextAt = nextDue(row,now,revoked,trusted);
    if (nextAt>now) return {nextAt};
    if (!row) {
      await tx.db.run(`INSERT INTO ${table}(connection_id,environment,generation,next_sequence,next_at)
        VALUES(?,?,?,'open',?)`,[...keys,now]);
      await tx.db.run(`INSERT INTO ${tx.t('shipping_novelty_cursors')}(connection_id,environment,generation,sequence,page,initialized)
        VALUES(?,?,?,'open',1,0),(?,?,?,'resolved',1,0)`,[...keys,...keys]);
    }
    if (revoked) await tx.db.run(`UPDATE ${table} SET webhook_verified_revision=NULL,webhook_verified_at=NULL,
      sweep_open_done=0,sweep_resolved_done=0,next_at=? WHERE ${whereScope()}`,[now,...keys]);
    const guidesDue = trusted && row.guide_next_at && row.guide_next_at<row.next_at;
    const sequence = guidesDue ? 'guides' : row?.next_sequence ?? 'open';
    const cursor = guidesDue ? {page:row.guide_page} : await tx.db.get(`SELECT page,initialized FROM ${tx.t('shipping_novelty_cursors')} WHERE ${whereScope()} AND sequence=?`,[...keys,sequence]);
    const leaseId = newId();
    await tx.db.run(`UPDATE ${table} SET lease_id=?,lease_until=? WHERE ${whereScope()}`,[leaseId,after(now,LEASE),...keys]);
    return {environment:scope.environment,generation:scope.generation,revision:trusted?scope.revision:null,sequence,page:Number(cursor.page),initialized:Boolean(cursor.initialized),leaseId};
  });
}

function nextPage({rows,pager},page) {
  // A shrinking listing may return an empty page past its end. Reset that
  // cursor, but never accept a nonempty page other than the requested one.
  if (!Number.isSafeInteger(pager.total) || pager.total<0 || (!rows.length && pager.nextPage!==null) ||
      (rows.length && pager.page!==page) || (pager.nextPage!==null && (pager.nextPage!==page+1 || pager.nextPage>10000))) {
    throw new HekaApiError('HEKA_RESPONSE','Heka devolvió una página de envíos incompleta.',502);
  }
  return pager.nextPage;
}

function observed(rows,sequence) {
  const guides = new Map();
  for (const row of rows) {
    const state = states.get(row.status_novelty), guideId = row._id?.toLowerCase(), noveltyId = row.last_novelty?._id?.toLowerCase();
    if (!guideId || !noveltyId || !state || (sequence==='resolved')!==(state==='resolved')) continue;
    const key = `${guideId}:${noveltyId}`, message = row.last_novelty.message?.normalize('NFC').replace(/\s+/g,' ').trim();
    const {guide_number,distributor_id,city_origin,city_destination,status_novelty,movemens} = row;
    const item = {key,guideId,noveltyId,state,guide:{_id:guideId,guide_number,distributor_id,city_origin,city_destination,status_novelty,movemens,
      last_novelty:{_id:noveltyId,message:message||undefined,code:row.last_novelty.code || undefined,last_status:row.last_novelty.last_status}}};
    const previous = guides.get(key);
    // Conflicting copies of a row in the same page are not evidence of which
    // was newer. Exact overlaps, including order changes, count only once.
    if (previous===null || previous && fingerprint(previous.guide)!==fingerprint(item.guide)) guides.set(key,null);
    else if (!previous) guides.set(key,item);
  }
  return [...guides.values()].filter(Boolean);
}

function fingerprint(guide) {
  const last = guide.last_novelty;
  return hash([guide.guide_number??null,guide.distributor_id??null,guide.status_novelty,last.message??null,last.code??null,last.last_status??null]);
}

async function commitRows(tx,scope,rows,now) {
  const incoming = observed(rows,scope.sequence);
  if (!incoming.length) return 0;
  const keys = scopeKeys(scope);
  const previous = await tx.db.all(`WITH seen(guide_id,novelty_id) AS (VALUES ${values(incoming,2)})
    SELECT n.guide_id,n.novelty_id,n.state,n.revision,n.fingerprint,n.data FROM ${tx.t('shipping_novelties')} n
    JOIN seen s ON n.guide_id=s.guide_id AND n.novelty_id=s.novelty_id WHERE ${whereScope('n.')}`,
  [...incoming.flatMap(item=>[item.guideId,item.noveltyId]),...keys]);
  const byIdentity = new Map(previous.map(row=>[`${row.guide_id}:${row.novelty_id}`,row]));
  const updates = [], events = [];
  let eventAt = now;
  if (scope.initialized) {
    const latest = await tx.db.get(`SELECT created_at FROM ${tx.t('shipping_novelty_events')} WHERE ${whereScope()} ORDER BY created_at DESC,id DESC LIMIT 1`,keys);
    // A new page must advance the notification watermark even if the clock
    // repeats a millisecond or a second scheduler's clock runs behind.
    if (latest?.created_at>=eventAt) eventAt = after(latest.created_at,1);
  }
  for (const item of incoming) {
    const old = byIdentity.get(item.key);
    // The open sequence cannot retract an explicitly resolved novelty. A new
    // novelty on the same guide has its own identity and can still be detected.
    if (old?.state==='resolved' && item.state!=='resolved') continue;
    const oldGuide = old ? JSON.parse(old.data) : null, guide = item.guide;
    if (oldGuide) {
      // Missing fields are not corrections; keep previously verified details.
      for (const key of ['guide_number','distributor_id','city_origin','city_destination','movemens']) guide[key] ??= oldGuide[key];
      for (const key of ['message','code','last_status']) guide.last_novelty[key] ??= oldGuide.last_novelty[key];
    }
    const digest = fingerprint(guide);
    if (digest===old?.fingerprint) continue;
    const revision = Number(old?.revision ?? 0)+1;
    updates.push([...keys,item.guideId,item.noveltyId,item.state,revision,digest,JSON.stringify(guide),eventAt]);
    if (scope.initialized) events.push([newId(),...keys,item.guideId,item.noveltyId,revision,eventAt]);
  }
  if (!updates.length) return 0;
  await tx.db.run(`INSERT INTO ${tx.t('shipping_novelties')}(connection_id,environment,generation,guide_id,novelty_id,state,revision,fingerprint,data,updated_at)
    VALUES ${values(updates,10)} ON CONFLICT(connection_id,environment,generation,guide_id,novelty_id)
    DO UPDATE SET state=excluded.state,revision=excluded.revision,fingerprint=excluded.fingerprint,data=excluded.data,updated_at=excluded.updated_at`,updates.flat());
  if (events.length) {
    await tx.db.run(`INSERT INTO ${tx.t('shipping_novelty_events')}(id,connection_id,environment,generation,guide_id,novelty_id,revision,created_at)
      VALUES ${values(events,8)}`,events.flat());
    await tx.db.run(`INSERT INTO ${tx.t('shipping_push_deliveries')}(event_id,subscription_id,state,attempts,next_at)
      SELECT e.id,s.id,'pending',0,? FROM ${tx.t('shipping_novelty_events')} e
      JOIN ${tx.t('shipping_push_subscriptions')} s ON s.environment=e.environment AND s.disabled_at IS NULL
      JOIN ${tx.t('users')} u ON u.id=s.user_id AND u.active=1
      WHERE ${whereScope('e.')} AND e.created_at=?`,[now,...keys,eventAt]);
  }
  return events.length;
}

// These are transport observations only, never shipment events or links.
function verifiedGuides(rows) {
  const guides = new Map();
  for (const row of rows) {
    const id = row._id?.toLowerCase(), number = row.guide_number, carrier = row.distributor_id ?? null, status = row.status;
    const old = guides.get(id);
    if (!id || !number || !status || old && (old.number!==number || old.carrier!==carrier || old.status!==status)) {
      throw new HekaApiError('HEKA_RESPONSE','Heka devolvió una guía incompleta o contradictoria.',502);
    }
    if (!old) guides.set(id,{id,number,carrier,status});
  }
  return [...guides.values()];
}

async function commitGuides(tx,scope,guides,now) {
  if (!guides.length) return;
  const keys = scopeKeys(scope);
  await tx.db.run(`INSERT INTO ${tx.t('shipping_guide_observations')}(connection_id,environment,generation,guide_id,guide_number,carrier,provider_status,observed_at)
    VALUES ${values(guides,8)} ON CONFLICT(connection_id,environment,generation,guide_id)
    DO UPDATE SET guide_number=excluded.guide_number,carrier=excluded.carrier,provider_status=excluded.provider_status,observed_at=excluded.observed_at`,
  guides.flatMap(({id,number,carrier,status})=>[...keys,id,number,carrier,status,now]));
}

function providerFailure(error) {
  if (error.code?.startsWith('INTEGRATION_')) return {code:'HEKA_CUSTODY',pause:5*INTERVAL};
  if (!(error instanceof HekaApiError)) throw error;
  return {code:error.code,pause:[403,429].includes(error.status) && error.code!=='HEKA_LOCAL_LIMIT' ? (error.status===403 ? 5 : 2)*INTERVAL : INTERVAL};
}

const fenceLost = error => error instanceof HekaApiError && ['HEKA_CONFIG_CHANGED','HEKA_NOT_CONFIGURED','HEKA_NOVELTY_LEASE_LOST'].includes(error.code);
const owns = (row,claim,now) => row?.lease_id===claim.leaseId && row.lease_until>now;

async function checkpoint(tx,claim,clock,changes,params) {
  const updated = await tx.db.run(`UPDATE ${tx.t('shipping_novelty_sync')} SET lease_id=NULL,lease_until=NULL,${changes}
    WHERE ${whereScope()} AND lease_id=? AND lease_until>?`,[...params,...scopeKeys(claim),claim.leaseId,clock()]);
  // Roll back all observations and deliveries if the lease expired during a write.
  if (!updated.changes) throw new HekaApiError('HEKA_NOVELTY_LEASE_LOST','Se perdió el turno de sincronización de envíos.',409);
}

function revoke(tx,claim,clock,nextAt) {
  return checkpoint(tx,claim,clock,`webhook_verified_revision=NULL,webhook_verified_at=NULL,sweep_open_done=0,sweep_resolved_done=0,next_at=?`,[nextAt]);
}

async function pause(tx,claim,current,clock,now,failure,nextSequence) {
  const nextAt = after(now,failure.pause);
  const guideAt = current.guide_next_at && current.guide_next_at<nextAt ? nextAt : current.guide_next_at;
  await checkpoint(tx,claim,clock,`webhook_verified_revision=NULL,webhook_verified_at=NULL,sweep_open_done=0,sweep_resolved_done=0,
    next_sequence=?,next_at=?,guide_next_at=?,checked_at=?,error_code=?`,[nextSequence,nextAt,guideAt,now,failure.code]);
  return {processed:0,events:0,nextAt,errorCode:failure.code};
}

async function noveltySchedule(tx,claim,current,now,cursorPage,daily) {
  const nextSequence = opposite(claim.sequence);
  if (!daily) {
    const more = cursorPage!==null || Boolean(await tx.db.get(`SELECT 1 AS pending FROM ${tx.t('shipping_novelty_cursors')} WHERE ${whereScope()} AND sequence=? AND page>1`,[...scopeKeys(claim),nextSequence]));
    return [nextSequence,claim.sequence==='open' ? now : after(now,more ? CATCHUP_INTERVAL : INTERVAL),0,0];
  }
  const openDone = Number(current.sweep_open_done) || Number(claim.sequence==='open' && cursorPage===null);
  const resolvedDone = Number(current.sweep_resolved_done) || Number(claim.sequence==='resolved' && cursorPage===null);
  if (openDone && resolvedDone) return ['open',after(now,DAY),0,0];
  const otherDone = nextSequence==='open' ? openDone : resolvedDone;
  return [otherDone ? claim.sequence : nextSequence,claim.sequence==='open' && !otherDone ? now : after(now,CATCHUP_INTERVAL),openDone,resolvedDone];
}

export async function processShippingNoveltyTurn(store,{now=stamp(),clock=jobClock(now),...options} = {}) {
  const claim = await claimPage(store,clock,options);
  if (!claim.leaseId) return {processed:0,events:0,nextAt:claim.nextAt};
  const guides = claim.sequence==='guides';
  let result, cursorPage, observations, failure;
  try {
    result = await readHekaNoveltyPage(store,claim,{...options,clock});
    cursorPage = nextPage(result,claim.page);
    if (guides) observations = verifiedGuides(result.rows);
  } catch (error) {
    if (fenceLost(error)) return {processed:0,events:0,errorCode:error.code,nextAt:clock()};
    failure = providerFailure(error);
  }
  return locked(store,async tx => {
    const current = await syncRow(tx,claim), config = await getHekaWebhookSettings(tx), now = clock();
    if (!config.connected || config.environment!==claim.environment || config.generation!==claim.generation) {
      return {processed:0,events:0,nextAt:now,errorCode:'HEKA_CONFIG_CHANGED'};
    }
    if (!owns(current,claim,now)) return {processed:0,events:0,nextAt:now,errorCode:'HEKA_NOVELTY_LEASE_LOST'};
    const daily = claim.revision && await currentProof(tx,current,config,now,options);
    if (claim.revision && !daily) {
      await revoke(tx,claim,clock,now);
      return {processed:0,events:0,nextAt:now};
    }
    if (failure) return pause(tx,claim,current,clock,now,failure,guides ? current.next_sequence : opposite(claim.sequence));
    if (guides) {
      await commitGuides(tx,claim,observations,now);
      const guideAt = after(now,cursorPage===null ? DAY : CATCHUP_INTERVAL);
      await checkpoint(tx,claim,clock,'guide_page=?,guide_next_at=?',[cursorPage ?? 1,guideAt]);
      return {processed:result.rows.length,events:0,nextAt:guideAt<current.next_at ? guideAt : current.next_at};
    }
    const events = await commitRows(tx,claim,result.rows,now);
    await tx.db.run(`UPDATE ${tx.t('shipping_novelty_cursors')} SET page=?,initialized=? WHERE ${whereScope()} AND sequence=?`,
      [cursorPage ?? 1,claim.initialized || cursorPage===null ? 1 : 0,...scopeKeys(claim),claim.sequence]);
    const [nextSequence,nextAt,openDone,resolvedDone] = await noveltySchedule(tx,claim,current,now,cursorPage,daily);
    await checkpoint(tx,claim,clock,`next_sequence=?,next_at=?,sweep_open_done=?,sweep_resolved_done=?,checked_at=?,last_success_at=?,error_code=NULL`,
      [nextSequence,nextAt,openDone,resolvedDone,now,now]);
    return {processed:result.rows.length,events,nextAt:daily && current.guide_next_at<nextAt ? current.guide_next_at : nextAt};
  }).catch(error => {
    if (error instanceof HekaApiError && error.code==='HEKA_NOVELTY_LEASE_LOST') return {processed:0,events:0,errorCode:error.code,nextAt:clock()};
    throw error;
  });
}

async function findWebhookTurn(tx,now) {
  const scope=await getHekaWebhookSettings(tx);
  if(!scope.revision)return null;
  const prefix=hekaWebhookQueue(scope);
  const job=await tx.db.get(`SELECT key,data FROM ${tx.t('job_runs')}
    WHERE key>=? AND key<? AND state='queued' ORDER BY created_at,key LIMIT 1`,[prefix,`${prefix}g`]);
  if(!job)return null;
  const sync=await syncRow(tx,scope);
  if(!sync || sync.lease_until>now || sync.error_code && sync.next_at>now)return null;
  const baseline=await tx.db.get(`SELECT COUNT(*) AS total FROM ${tx.t('shipping_novelty_cursors')} WHERE ${whereScope()} AND initialized=1`,scopeKeys(scope));
  return Number(baseline?.total)===2 ? {...scope,key:job.key,guideId:JSON.parse(job.data).guideId} : null;
}

export async function shippingWebhookReady(store,now=stamp()) {
  return Boolean(await store.readSnapshot(tx=>findWebhookTurn(tx,now)));
}

export async function processShippingWebhookTurn(store,{now=stamp(),clock=jobClock(now),...options}={}) {
  if(!await shippingWebhookReady(store,clock()))return {processed:0,events:0};
  const claim=await locked(store,async tx=>{
    const at=clock(),job=await findWebhookTurn(tx,at);
    if(!job)return null;
    const leaseId=newId();
    await tx.db.run(`UPDATE ${tx.t('shipping_novelty_sync')} SET lease_id=?,lease_until=? WHERE ${whereScope()}`,[leaseId,after(at,LEASE),...scopeKeys(job)]);
    return {...job,leaseId};
  });
  if(!claim)return {processed:0,events:0};
  let verification, failure;
  async function assertCustody(db) {
    if ((await readHekaWebhookCredential(db,claim.environment,options))?.revision!==claim.revision) {
      throw new HekaApiError('HEKA_WEBHOOK_CHANGED','Cambió el secreto del webhook Heka.',409);
    }
  }
  try {
    await assertCustody(store);
    verification=await readHekaWebhookNovelty(store,claim,{...options,clock});
  } catch(error) {
    if (fenceLost(error)) return {processed:0,events:0};
    failure=providerFailure(error);
  }
  return locked(store,async tx=>{
    const at=clock(),current=await syncRow(tx,claim), config=await getHekaWebhookSettings(tx);
    if(!owns(current,claim,at))return {processed:0,events:0};
    if(config.revision!==claim.revision || config.environment!==claim.environment || config.generation!==claim.generation) {
      await revoke(tx,claim,clock,at);
      return {processed:0,events:0};
    }
    if(!failure)try { await assertCustody(tx); } catch(error) { failure=providerFailure(error); }
    let result;
    if(failure)result=await pause(tx,claim,current,clock,at,failure,current.next_sequence);
    else {
      await commitGuides(tx,claim,verifiedGuides([verification.guide]),at);
      let events=0;
      for(const {sequence,row} of verification.observations)events+=await commitRows(tx,{...claim,sequence,initialized:true},[row],at);
      const alreadyDaily = evidenceUntil(current,config)>at;
      const pending = !alreadyDaily && await tx.db.get(`SELECT 1 AS pending FROM ${tx.t('shipping_novelty_cursors')} WHERE ${whereScope()} AND page>1 LIMIT 1`,scopeKeys(claim));
      await checkpoint(tx,claim,clock,`webhook_verified_revision=?,webhook_verified_at=?,next_at=?,next_sequence=?,
        sweep_open_done=?,sweep_resolved_done=?,guide_next_at=?,checked_at=?,error_code=NULL`,[
        claim.revision,at,alreadyDaily || pending ? current.next_at : after(at,DAY),alreadyDaily || pending ? current.next_sequence : 'open',
        alreadyDaily ? current.sweep_open_done : 0,alreadyDaily ? current.sweep_resolved_done : 0,current.guide_next_at ?? after(at,DAY),at]);
      result={processed:1,events};
    }
    await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state=?,error_code=?,updated_at=?,finished_at=?,version=version+1 WHERE key=?`,
      [failure?'failed':'succeeded',failure?.code??null,at,at,claim.key]);
    return result;
  }).catch(error=>{
    if(error instanceof HekaApiError&&error.code==='HEKA_NOVELTY_LEASE_LOST')return {processed:0,events:0};
    throw error;
  });
}

async function scopeWithSync(tx,now) {
  const config = await getHekaWebhookSettings(tx), {environment,connected:active} = config;
  // Disconnect increments the version exactly once. Never fall back to the
  // archive of a different credential that preceded the disconnected one.
  const row = await syncRow(tx,{environment,generation:config.generation-(active?0:1)});
  const generation = active ? config.generation : Number(row?.generation) || null;
  const heartbeat = await tx.db.get(`SELECT state,updated_at,error_code FROM ${tx.t('job_runs')} WHERE key='scheduler:heartbeat'`);
  const {status:schedulerStatus} = schedulerHealth(heartbeat,now), errorCode = row?.error_code ?? null;
  const initialized = row ? !await tx.db.get(`SELECT 1 AS pending FROM ${tx.t('shipping_novelty_cursors')} WHERE ${whereScope()} AND initialized=0 LIMIT 1`,scopeKeys({environment,generation})) : false;
  const lastSuccessAt = row?.last_success_at ?? null, daily = evidenceUntil(row,config)>now;
  const status = !active ? 'disconnected' : errorCode==='HEKA_ROLE_OR_KEY' ? 'forbidden'
    : ['HEKA_PROVIDER_LIMIT','HEKA_LOCAL_LIMIT'].includes(errorCode) ? 'rate_limited' : errorCode ? 'unavailable'
    : schedulerStatus!=='running' ? 'scheduler_unavailable' : !initialized ? 'initializing'
    : !lastSuccessAt || Date.parse(now)-Date.parse(lastSuccessAt)>=(daily ? DAY : 0)+3*INTERVAL ? 'stale' : 'current';
  return {status,environment,generation,active,cadence:daily?'webhook_daily':'polling',lastSuccessAt,checkedAt:row?.checked_at ?? null,errorCode,schedulerStatus};
}

async function summaryFor(tx,sync,userId) {
  if (sync.generation===null) return {unreadCount:0,latestEventId:null,sync};
  const keys = scopeKeys(sync);
  const latest = await tx.db.get(`SELECT id FROM ${tx.t('shipping_novelty_events')} WHERE ${whereScope()} ORDER BY created_at DESC,id DESC LIMIT 1`,keys);
  const unread = latest && await tx.db.get(`SELECT count(*) AS total FROM ${tx.t('shipping_novelty_events')} e
    WHERE ${whereScope('e.')} AND NOT EXISTS (SELECT 1 FROM ${tx.t('shipping_novelty_reads')} r WHERE r.event_id=e.id AND r.user_id=?)`,[...keys,userId]);
  return {unreadCount:Number(unread?.total ?? 0),latestEventId:latest?.id ?? null,sync};
}

async function addLocalShipmentIds(tx,sync,rows) {
  if (!sync.active || sync.environment!=='production' || !rows.length) return;
  const guideIds = [...new Set(rows.filter(({guide})=>guide.guide_number&&guide.distributor_id).map(({guide})=>guide._id))];
  if (!guideIds.length) return;
  const links = await tx.db.all(`SELECT l.guide_id,l.guide_number,l.carrier,l.shipment_id FROM ${tx.t('heka_api_order_links')} l
    JOIN ${tx.t('shipments')} s ON s.id=l.shipment_id AND s.order_id=l.order_id AND s.tracking=l.guide_number AND s.carrier=l.local_carrier
    WHERE l.guide_id IN (${guideIds.map(()=>'?').join(',')})`,guideIds);
  const byGuide = new Map(links.map(link=>[link.guide_id,link]));
  for (const row of rows) {
    const link = byGuide.get(row.guide._id);
    if (link && link.guide_number===row.guide.guide_number && link.carrier===row.guide.distributor_id) row.shipmentId=link.shipment_id;
  }
}

export function listShippingNovelties(store,userId,{summary=false,page=1,state='',eventId,now=stamp()} = {}) {
  integer(page,'Página',1,1000000);
  if (!['','pending','review','resolved'].includes(state)) fail('Estado de novedad no válido.');
  if (eventId!==undefined && (typeof eventId!=='string' || !EVENT_ID.test(eventId))) fail('Aviso de novedad no válido.');
  return store.readSnapshot(async tx => {
    const sync = await scopeWithSync(tx,now);
    if (summary) return summaryFor(tx,sync,userId);
    const table = tx.t('shipping_novelties'), events = tx.t('shipping_novelty_events'), reads = tx.t('shipping_novelty_reads');
    const matching = `e.connection_id=n.connection_id AND e.environment=n.environment AND e.generation=n.generation AND e.guide_id=n.guide_id AND e.novelty_id=n.novelty_id`;
    const filter = `${state ? ' AND n.state=?' : ''}${eventId ? ` AND EXISTS (SELECT 1 FROM ${events} e WHERE e.id=? AND ${matching})` : ''}`;
    const params = [...scopeKeys(sync),...(state?[state]:[]),...(eventId?[eventId]:[])];
    const total = sync.generation===null || eventId && !sync.active ? 0
      : Number((await tx.db.get(`SELECT count(*) AS total FROM ${table} n WHERE ${whereScope('n.')}${filter}`,params)).total);
    const throughTarget = eventId ? ` AND e.revision<=(SELECT revision FROM ${events} WHERE id=?)` : '';
    const rows = total ? await tx.db.all(`SELECT n.state,n.data,n.revision,n.updated_at,
      (SELECT e.id FROM ${events} e WHERE ${matching} ORDER BY e.revision DESC LIMIT 1) AS event_id,
      (SELECT count(*) FROM ${events} e WHERE ${matching}${throughTarget} AND NOT EXISTS (SELECT 1 FROM ${reads} r WHERE r.event_id=e.id AND r.user_id=?)) AS unread
      FROM ${table} n WHERE ${whereScope('n.')}${filter} ORDER BY n.updated_at DESC,n.guide_id,n.novelty_id LIMIT ? OFFSET ?`,[...(eventId?[eventId]:[]),userId,...params,PAGE_SIZE,(page-1)*PAGE_SIZE]) : [];
    const entries=rows.map(row=>({state:row.state,guide:JSON.parse(row.data),revision:Number(row.revision),updatedAt:row.updated_at,eventId:eventId??row.event_id,unreadCount:Number(row.unread)}));
    await addLocalShipmentIds(tx,sync,entries);
    const pages = Math.ceil(total/PAGE_SIZE);
    return {sync,rows:entries,
      pager:{total,page,pages,previousPage:page>1 ? page-1 : null,nextPage:page<pages ? page+1 : null}};
  });
}

export function markShippingNoveltyRead(store,userId,input,{now=stamp()} = {}) {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==1 || typeof input.eventId!=='string' || !EVENT_ID.test(input.eventId)) fail('Aviso de novedad no válido.');
  return locked(store,async tx => {
    const sync = await scopeWithSync(tx,now), keys = scopeKeys(sync), table = tx.t('shipping_novelty_events');
    const anchor = sync.generation!==null && await tx.db.get(`SELECT guide_id,novelty_id,revision FROM ${table} WHERE ${whereScope()} AND id=?`,[...keys,input.eventId]);
    if (!anchor) fail('El aviso no pertenece a la bandeja actual.',404);
    await tx.db.run(`INSERT INTO ${tx.t('shipping_novelty_reads')}(user_id,event_id,read_at)
      SELECT ?,id,? FROM ${table} WHERE ${whereScope()} AND guide_id=? AND novelty_id=? AND revision<=?
      ON CONFLICT(user_id,event_id) DO NOTHING`,[userId,now,...keys,anchor.guide_id,anchor.novelty_id,anchor.revision]);
    return {ok:true};
  });
}
