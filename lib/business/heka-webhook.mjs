import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../validation-core.mjs';
import { HEKA_OBJECT_ID } from '../shipping/heka-api.mjs';
import { stamp } from './commands.mjs';
import { getHekaWebhookSettings } from './heka-api.mjs';

const PREFIX = 'heka-webhook:';
export const hekaWebhookQueue = ({environment,generation,revision}) => `${PREFIX}queue:${environment}:${generation}:${revision}:`;
export const HEKA_WEBHOOK_MAX_BYTES = 256 * 1024;
const EVENTS = new Set(['guide.created','guide.status_changed','guide.movements_added','webhook.test']);
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-z0-9_.:-]{1,160}$/i;
const record = value => value && typeof value==='object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');

export function authenticateHekaWebhook(headers,raw,secret,now=stamp()) {
  const timestamp=headers.get('x-heka-timestamp')??'', signature=headers.get('x-heka-signature')??'';
  const match=/^sha256=([a-f0-9]{64})$/i.exec(signature);
  const sent=/^\d{10}$/.test(timestamp) ? Number(timestamp)*1000 : /^\d{13}$/.test(timestamp) ? Number(timestamp)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(timestamp) ? Date.parse(timestamp) : NaN;
  // Allow the documented retry series (up to ~32 minutes) even if Heka reuses the original timestamp.
  const age=Date.parse(now)-sent;
  if(!match || !Number.isFinite(age) || age < -300000 || age > 3600000) fail('Firma o fecha de entrega Heka no válida.',401);
  const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest();
  if(!timingSafeEqual(expected,Buffer.from(match[1],'hex')))fail('Firma o fecha de entrega Heka no válida.',401);
  let payload;
  try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
  catch { fail('JSON de webhook no válido.'); }
  const delivery=headers.get('x-heka-delivery')??'', headerEvent=headers.get('x-heka-event');
  if(!record(payload) || typeof payload.id!=='string' || !TOKEN.test(payload.id) || !TOKEN.test(delivery) || !EVENTS.has(payload.event) || payload.event!==headerEvent ||
      typeof payload.created_at!=='string' || payload.created_at.length>40 || !Number.isFinite(Date.parse(payload.created_at)))fail('Sobre de webhook Heka no válido.');
  if(payload.event==='webhook.test')return {event:payload.event};
  const guideId=payload.data?.guide_id;
  if(typeof guideId!=='string'||!HEKA_OBJECT_ID.test(guideId))fail('ID de guía Heka no válido.');
  return {event:payload.event,guideId:guideId.toLowerCase(),delivery:digest(delivery),id:digest(payload.id)};
}

export async function enqueueHekaWebhook(store,{environment,generation,revision},event,{now=stamp()}={}) {
  if (event?.event==='webhook.test') return false;
  if (!EVENTS.has(event?.event) || typeof event.guideId!=='string' || !HEKA_OBJECT_ID.test(event.guideId)
      || typeof event.delivery!=='string' || !HASH.test(event.delivery) || typeof event.id!=='string' || !HASH.test(event.id)) {
    fail('Evento de guía Heka no válido.');
  }
  return store.transaction(async tx=>{
    await tx.lockWrites();
    const current=await getHekaWebhookSettings(tx);
    if(!revision||current.revision!==revision||current.environment!==environment||current.generation!==generation)fail('Cambió la configuración del webhook Heka.',409);
    const delivery=`${PREFIX}delivery:${environment}:${event.delivery}`, id=`${PREFIX}event:${environment}:${event.id}`;
    const table=tx.t('job_runs');
    if(await tx.db.get(`SELECT key FROM ${table} WHERE key IN (?,?) LIMIT 1`,[delivery,id]))return false;
    await tx.db.run(`INSERT INTO ${table}(key,state,data,version,created_at,updated_at)
      VALUES(?,'succeeded','{}',1,?,?),(?,'succeeded','{}',1,?,?),(?,'queued',?,1,?,?) ON CONFLICT(key) DO NOTHING`,
    [delivery,now,now,id,now,now,`${hekaWebhookQueue(current)}${event.id}`,JSON.stringify({guideId:event.guideId}),now,now]);
    return true;
  });
}

export async function expireHekaWebhookJobs(store,now) {
  const cutoff=new Date(Date.parse(now)-7*86400000).toISOString();
  await store.transaction(async tx=>{
    await tx.lockWrites();
    await tx.db.run(`DELETE FROM ${tx.t('job_runs')} WHERE key IN (SELECT key FROM ${tx.t('job_runs')} WHERE key LIKE ? AND created_at<? ORDER BY created_at,key LIMIT 100)`,[`${PREFIX}%`,cutoff]);
  });
}
