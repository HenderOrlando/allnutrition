import { createHmac } from 'node:crypto';
import { createIntegrationKeyring, openHekaKey, openHekaWebhook, sealHekaKey, sealHekaWebhook } from '../integrations/keyring.mjs';
import { HEKA_CARRIERS, HEKA_ENVIRONMENTS, HEKA_OBJECT_ID, HEKA_GUIDE_NUMBER, HEKA_STATUS, HekaApiError, hekaInputObject, hekaOperation, requestHeka } from '../shipping/heka-api.mjs';
import { assertLease, audit, canonicalJSON, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { claimJob, finishJob, LEASE_MILLISECONDS, queueJobTx } from './job-leases.mjs';
import { carrierKey, linkShipmentTx, saveShipmentTx } from './shipments.mjs';
import { attachShippingPreparationTx } from './shipping-preparations.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const die = (code,message,status) => { throw new HekaApiError(code,message,status); };
const invalid = label => die('HEKA_INPUT',`${label}: dato de Heka no válido.`,400);
const idLike = (value,pattern,label) => typeof value === 'string' && pattern.test(value) ? value : invalid(label);
const versionNumber = value => Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : invalid('Versión');
const environmentName = value => typeof value==='string' && Object.hasOwn(HEKA_ENVIRONMENTS,value) ? value : invalid('Entorno');
const settingsRow = tx => tx.db.get(`SELECT * FROM ${tx.t('heka_api_settings')} WHERE id=1`);
const settingsDTO = row => ({ configured: Boolean(row?.ciphertext), environment: row?.environment ?? 'test', version: row?.version ?? 0 });
const readMutation = (tx,id) => tx.db.get(`SELECT * FROM ${tx.t('heka_api_mutations')} WHERE id=?`,[id]);
const ring = options => options.keyring ?? createIntegrationKeyring();
const digest = (key,value) => createHmac('sha256',key).update(canonicalJSON(value)).digest('hex');
const credentialDigest = config => digest(config.privateKey,['heka-credential-v1',config.environment,config.apiKey]);
const jobKey = id => `heka-api:${id}`;
const expiry = now => new Date(Date.parse(now)+LEASE_MILLISECONDS).toISOString();
const UNKNOWN = 'HEKA_OUTCOME_UNKNOWN';
const AUTH = 'HEKA_ROLE_OR_KEY';
const MESSAGES = {
  [UNKNOWN]: 'Heka pudo aplicar el cambio. No lo vuelvas a enviar; contrasta el resultado en Heka.',
  [AUTH]: 'Heka rechazó el acceso. Comprueba la clave y el entorno, el rol requerido y la propiedad del recurso.',
  HEKA_REJECTED: 'Heka rechazó los datos o el estado de la operación.',
};

async function assertSession(tx,session) {
  const id = session?.user?.id, token = session?.sessionTokenHash;
  if (typeof id !== 'string' || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) die('HEKA_SESSION','Inicia sesión para continuar.',401);
  const suffix = tx.provider === 'supabase' ? ' FOR UPDATE' : '';
  const user = await tx.db.get(`SELECT active FROM ${tx.t('users')} WHERE id=?${suffix}`,[id]);
  const row = user?.active && await tx.db.get(`SELECT expires,csrf FROM ${tx.t('sessions')} WHERE token_hash=? AND user_id=?${suffix}`,[token,id]);
  if (!row || Number(row.expires)<=Date.now() || row.csrf!==session.csrf) die('HEKA_SESSION','La sesión ya no está activa.',401);
  return id;
}
function locked(store,session,fn) {
  return store.transaction(async tx => { await tx.lockWrites(); return fn(tx,await assertSession(tx,session)); });
}
function sameConfiguration(row,{ environment, version }) {
  const dto = settingsDTO(row);
  if (dto.version!==version || dto.environment!==environment) die('HEKA_CONFIG_CHANGED','Cambió la configuración de Heka. Recarga y revisa el entorno o la clave antes de continuar.',409);
  if (!dto.configured) die('HEKA_NOT_CONFIGURED','Configura una clave API oficial de Heka.',422);
}
export async function getHekaSettings(store) { return settingsDTO(await settingsRow(store)); }
async function credentials(row,options) {
  const privateKey = await ring(options).read('heka',{required:true});
  return { environment:row.environment, apiKey:openHekaKey(row,privateKey,row.environment), privateKey };
}
export async function saveHekaSettings(store,input,session,{ clear = false, ...options } = {}) {
  hekaInputObject(input,clear ? ['version'] : ['version','environment','apiKey'],'Configuración');
  const version = versionNumber(input.version);
  const desired = clear ? null : environmentName(input.environment);
  let apiKey;
  if (!clear && Object.hasOwn(input,'apiKey')) {
    if (typeof input.apiKey!=='string' || !/^[!-~]{1,4096}$/.test(input.apiKey.trim())) invalid('Clave API');
    apiKey = input.apiKey.trim();
  }
  return locked(store,session,async (tx,actorId) => {
    const row = await settingsRow(tx), previous = settingsDTO(row);
    if (version!==previous.version) die('HEKA_CONFIG_CHANGED','Cambió la configuración de Heka. Recarga antes de guardar.',409);
    const environment = desired ?? previous.environment;
    if (clear && !previous.configured || !clear && !apiKey && environment===previous.environment && previous.configured) return previous;
    if (!clear && !apiKey) die('HEKA_KEY_REQUIRED','Configura una clave propia del entorno seleccionado.',422);
    const now = stamp();
    if (await tx.db.get(`SELECT id FROM ${tx.t('heka_api_mutations')} WHERE state='sending' AND lease_until>? LIMIT 1`,[now])) die('HEKA_WRITE_IN_PROGRESS','Espera a que termine el envío antes de cambiar la clave de Heka.',409);
    let next = {environment,ciphertext:null,iv:null,auth_tag:null};
    if (!clear) {
      // Unresolved evidence stays bound to the original private key after a
      // commercial restore or a deliberate credential disconnect.
      const pending = await tx.db.get(`SELECT id FROM ${tx.t('heka_api_mutations')} WHERE state IN ('sending','uncertain') LIMIT 1`);
      const key = await ring(options).ensureHeka({existingCiphertexts:Boolean(previous.configured||pending)});
      if (previous.configured) openHekaKey(row,key,row.environment);
      next = {environment,...sealHekaKey(apiKey,key,environment)};
    }
    if (row) await updateVersioned(tx,'heka_api_settings',1,version,next);
    else await insertRow(tx,'heka_api_settings',{id:1,...next,version:1,created_at:now,updated_at:now});
    const result = {configured:!clear,environment,version:version+1};
    await audit(tx,{entityType:'shipping_heka_api_settings',entityId:'1',actorId,previous,next:result,reason:clear?'Clave Heka retirada':'Clave Heka actualizada'});
    return result;
  });
}

const webhookSettings = row => ({
  environment:row?.environment??'test', generation:row?.version??0,
  revision:row?.ciphertext&&row.webhook_ciphertext&&row.webhook_generation===row.version ? row.webhook_revision : null,
});
const webhookEnvelope = row => ({ciphertext:row.webhook_ciphertext,iv:row.webhook_iv,auth_tag:row.webhook_auth_tag});
export async function getHekaWebhookSettings(store) {
  const row=await settingsRow(store);
  return {...webhookSettings(row),connected:Boolean(row?.ciphertext)};
}

export async function readHekaWebhookCredential(store,environment,options={}) {
  const row=await settingsRow(store), scope=webhookSettings(row);
  if(!scope.revision||scope.environment!==environment)return null;
  const key=await ring(options).read('heka',{required:true});
  return {...scope,secret:openHekaWebhook(webhookEnvelope(row),key,environment,scope.generation,scope.revision)};
}

export async function saveHekaWebhookSettings(store,input,session,{clear=false,...options}={}) {
  hekaInputObject(input,clear?['environment','generation','revision']:['environment','generation','revision','secret'],'Webhook');
  const environment=environmentName(input.environment), generation=versionNumber(input.generation);
  const revision=input.revision===null?null:idLike(input.revision,UUID,'Revisión del webhook');
  const secret=input.secret;
  if(!clear&&(typeof secret!=='string'||!/^whsec_[!-~]{1,249}$/.test(secret)))invalid('Secreto de firma (whsec_…)');
  return locked(store,session,async (tx,actorId)=>{
    const row=await settingsRow(tx);
    sameConfiguration(row,{environment,version:generation});
    const previous=webhookSettings(row);
    if(previous.revision!==revision)die('HEKA_WEBHOOK_CHANGED','Cambió el secreto. Recarga la configuración antes de continuar.',409);
    if(clear&&!revision)return {...previous,connected:true};
    const nextRevision=clear?null:newId();
    let sealed=null;
    if(!clear){
      const key=await ring(options).read('heka',{required:true});
      openHekaKey(row,key,environment);
      sealed=sealHekaWebhook(secret,key,environment,generation,nextRevision);
    }
    await tx.db.run(`UPDATE ${tx.t('heka_api_settings')} SET webhook_ciphertext=?,webhook_iv=?,webhook_auth_tag=?,webhook_revision=?,webhook_generation=? WHERE id=1`,
    [sealed?.ciphertext??null,sealed?.iv??null,sealed?.auth_tag??null,nextRevision,clear?null:generation]);
    await audit(tx,{entityType:'shipping_heka_webhook',entityId:environment,actorId,previous:{configured:Boolean(revision)},next:{configured:!clear},reason:clear?'Secreto del webhook retirado':'Secreto del webhook guardado'});
    return {...previous,revision:nextRevision,connected:true};
  });
}

// These are local shared quotas, not undocumented provider limits. Log no query
// input (including PII) and do not put provider traffic under the login keyspace.
async function consume(tx,group,reserved = 0) {
  const limits = { read:60, sensitive:10, write:6 }, now = Date.now(), key = `heka-api:${group}`;
  const row = await tx.db.get(`INSERT INTO ${tx.t('attempts')}(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN attempts.reset_at<=? THEN 1 ELSE attempts.count+1 END,reset_at=CASE WHEN attempts.reset_at<=? THEN excluded.reset_at ELSE attempts.reset_at END RETURNING count`,[key,now+60000,now,now]);
  if (Number(row.count)>limits[group]-reserved) die('HEKA_LOCAL_LIMIT','Límite local de consultas de Heka. Espera un minuto.',429);
}

function mutationDTO(row,now=stamp()) {
  const state = row.state==='sending' && row.lease_until<=now ? 'uncertain' : row.state;
  const result = state!=='succeeded' ? null : row.operation==='createGuide' ? { _id:row.guide_id,guide_number:row.guide_number,distributor_id:row.carrier,status:row.remote_status } : { _id:row.novelty_id,last_status:row.remote_status };
  return { requestId:row.id,operation:row.operation,environment:row.environment,state,createdAt:row.created_at,updatedAt:row.updated_at,result,reconciledAt:row.reconciled_at,errorCode:state==='uncertain'?UNKNOWN:row.error_code,carrier:row.carrier };
}
function outcome(row,immediate=null) {
  const mutation = mutationDTO(row), code = mutation.errorCode;
  const rejected = mutation.state==='rejected';
  const notice = MESSAGES[code] || 'No se pudo enviar el cambio a Heka.';
  return {
    status: rejected ? (code===AUTH ? 403 : 422) : ['sending','uncertain'].includes(mutation.state) ? 202 : 200,
    data: {result:immediate ?? mutation.result,mutation,...(rejected ? {code,error:notice} : mutation.state==='uncertain' ? {code,notice} : {})}
  };
}
export async function listHekaMutations(store) {
  const now = stamp();
  // Prioritize open sends, which must stay reachable even if activity in the
  // other environment pushes them outside the most recent result window.
  const rows = await store.db.all(`SELECT * FROM ${store.t('heka_api_mutations')} ORDER BY CASE WHEN state IN ('sending','uncertain') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 100`);
  const mutations = rows.map(row=>mutationDTO(row,now));
  await guideLinks(store,mutations.filter(item=>item.environment==='production'&&item.operation==='createGuide'&&item.state==='succeeded').map(item=>item.result));
  return {mutations};
}
function getExpectations(body) { return {environment:environmentName(body.environment),version:versionNumber(body.version)}; }
function assertConfirmed(body) { if (body.confirm!==true) die('HEKA_CONFIRM_REQUIRED','Confirma expresamente la operación de Heka.',400); }
const lowerObjectId = value => typeof value==='string' && HEKA_OBJECT_ID.test(value) ? value.toLowerCase() : null;
function evidenceRow(raw) {
  if (raw === null) return null;
  if (Array.isArray(raw?.rows)) return raw.rows.length===1 ? raw.rows[0] : null;
  return raw && typeof raw==='object' && !Array.isArray(raw) ? raw : null;
}
async function providerRead(store,body,op,session,options,project=true) {
  const config = await locked(store,session,async tx => {
    const row = await settingsRow(tx);
    sameConfiguration(row,body);
    const auth = await credentials(row,options);
    await consume(tx,op.definition.sensitive || body.operation==='guides' && op.input.text ? 'sensitive' : 'read');
    return auth;
  });
  const result = await requestHeka(config,body.operation,op,{...options,project});
  await locked(store,session,async tx => sameConfiguration(await settingsRow(tx),body));
  return result;
}

export async function countHekaGuides(store,body,session,options = {}) {
  hekaInputObject(body,['environment','version'],'Totales de guías');
  const expected = {...getExpectations(body),operation:'guides'};
  const filters = ['all',...HEKA_CARRIERS], totals = {};
  async function count(carrier) {
    options.signal?.throwIfAborted();
    const op = hekaOperation('guides',{page:1,limit:2,...(carrier==='all'?{}:{distributor_id:carrier})});
    try {
      // Heka omits the pager at limit=1. The summary needs only its total:
      // no guide projection, local links or row-based inference.
      const result = await providerRead(store,expected,op,session,options,false);
      const total = result?.pager?.total;
      totals[carrier] = Number.isSafeInteger(total) && total>=0 ? total : null;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof HekaApiError) || ['HEKA_CONFIG_CHANGED','HEKA_SESSION','HEKA_NOT_CONFIGURED'].includes(error.code)) throw error;
      totals[carrier] = null;
    }
  }
  for (let index=0; index<filters.length; index+=2) {
    await Promise.all(filters.slice(index,index+2).map(count));
  }
  options.signal?.throwIfAborted();
  await locked(store,session,async tx => sameConfiguration(await settingsRow(tx),expected));
  return {totals};
}

const linksTable = tx => tx.t('heka_api_order_links');
const orderLinkDTO = (row,providerStatus=row.provider_status) => ({
  orderId:row.order_id,orderNumber:Number(row.order_number),shipmentId:row.shipment_id,guideId:row.guide_id,
  guideNumber:row.guide_number,carrier:row.carrier,providerStatus,linkedAt:row.linked_at
});
async function guideLinks(store,result) {
  const ids = [...new Set(result.map(row=>lowerObjectId(row?._id)).filter(Boolean))];
  if (!ids.length) return;
  const saved = await store.db.all(`SELECT l.*,o.number AS order_number FROM ${linksTable(store)} l JOIN ${store.t('orders')} o ON o.id=l.order_id WHERE l.guide_id IN (${ids.map(()=>'?').join(',')})`,ids);
  const links = new Map(saved.map(row=>[row.guide_id,row]));
  for (const row of result) {
    const link = links.get(lowerObjectId(row._id));
    if (link && link.guide_number===row.guide_number && (!row.distributor_id || row.distributor_id===link.carrier)) row.localLink = orderLinkDTO(link,row.status);
  }
}
async function linkGuide(store,body,session,options) {
  assertConfirmed(body);
  if (body.environment!=='production') die('HEKA_LINK_PRODUCTION','Las guías de prueba no se vinculan a pedidos físicos.',409);
  const requestId = idLike(body.requestId,UUID,'Solicitud').toLowerCase();
  const input = hekaInputObject(body.input,['orderNumber','guideId','guideNumber','carrier','preparationId','preparationVersion'],'Vinculación');
  const guideId = idLike(input.guideId,HEKA_OBJECT_ID,'ID de guía').toLowerCase();
  const guideNumber = idLike(input.guideNumber,HEKA_GUIDE_NUMBER,'Número de guía');
  const {orderNumber,carrier} = input;
  if (!Number.isSafeInteger(orderNumber) || orderNumber<1 || !HEKA_CARRIERS.includes(carrier)) invalid('Pedido o transportadora');
  const preparationId=input.preparationId===undefined?null:idLike(input.preparationId,UUID,'Preparación').toLowerCase();
  const preparationVersion=preparationId?versionNumber(input.preparationVersion):null;
  if(preparationId?!preparationVersion:input.preparationVersion!==undefined)invalid('Versión de la preparación');
  const check = hekaOperation('guides',{id:guideId,distributor_id:carrier,limit:1});
  const verified = evidenceRow(await providerRead(store,{...body,operation:'guides'},check,session,options,false));
  if (lowerObjectId(verified?._id)!==guideId || verified.guide_number!==guideNumber || verified.distributor_id!=null && verified.distributor_id!==carrier || typeof verified.status!=='string' || !HEKA_STATUS.test(verified.status)) die('HEKA_NO_EVIDENCE','Heka no confirmó la guía y la transportadora.',409);
  const localStore = { transaction: fn => locked(store,session,async tx => {
    const settings = await settingsRow(tx);
    sameConfiguration(settings,body);
    if (verified.distributor_id==null) {
      // The guide search example omits distributor_id. A request filter alone
      // does not prove the carrier if Heka returns a match without echoing it.
      // Only an actual create response (not an operator reconciliation) from
      // the same credential can independently corroborate the missing field.
      const receipt = await tx.db.get(`SELECT credential_hash FROM ${tx.t('heka_api_mutations')} WHERE environment='production' AND operation='createGuide' AND state='succeeded' AND reconciled_at IS NULL AND guide_id=? AND guide_number=? AND carrier=?`,[guideId,guideNumber,carrier]);
      if (!receipt || receipt.credential_hash!==credentialDigest(await credentials(settings,options))) die('HEKA_NO_EVIDENCE','Heka no informó la transportadora ni existe un recibo verificable de creación para esta guía.',409);
    }
    return fn(tx);
  }) };
  const result = await runCommand(localStore,{scope:'heka:link-guide',requestId,payload:{guideId,guideNumber,carrier,orderNumber,...(preparationId?{preparationId,preparationVersion}:{})},actorId:session.user.id,affectsIndicators:false},async tx=>{
    const order = await tx.db.get(`SELECT id,number,data FROM ${tx.t('orders')} WHERE number=?`,[orderNumber]);
    if (!order) die('HEKA_ORDER_NOT_FOUND','No existe ese pedido local.',404);
    const preparation = preparationId && await tx.db.get(`SELECT * FROM ${tx.t('shipping_preparations')} WHERE id=?`,[preparationId]);
    if(preparationId && (!preparation||preparation.version!==preparationVersion||preparation.order_id&&preparation.order_id!==order.id)) die('HEKA_PREPARATION_CHANGED','La preparación cambió o no corresponde al pedido elegido.',409);
    const attach = shipmentId => preparation && attachShippingPreparationTx(tx,{id:preparationId,version:preparationVersion,orderId:order.id,shipmentId});
    const previous = await tx.db.get(`SELECT * FROM ${linksTable(tx)} WHERE guide_id=? OR (carrier=? AND guide_number=?)`,[guideId,carrier,guideNumber]);
    if (previous) {
      if (previous.order_id!==order.id || previous.guide_id!==guideId || previous.carrier!==carrier || previous.guide_number!==guideNumber) die('HEKA_GUIDE_LINKED','La identidad de esta guía ya está vinculada a otro envío o pedido.',409);
      await attach(previous.shipment_id);
      return orderLinkDTO({...previous,order_number:order.number},verified.status);
    }
    const data = JSON.parse(order.data);
    if (data.status==='cancelled' || data.deliveryMethod!=='carrier') die('HEKA_ORDER_INELIGIBLE','La guía solo se vincula a un pedido no cancelado con entrega por transportadora.',409);
    const matching = (await tx.db.all(`SELECT id,order_id,carrier,status,version FROM ${tx.t('shipments')} WHERE tracking=?`,[guideNumber])).filter(row=>carrierKey(row.carrier)===carrierKey(carrier));
    if (matching.length>1 || matching.some(row=>row.order_id && row.order_id!==order.id)) die('HEKA_GUIDE_LINKED','La guía ya corresponde a otro envío o pedido local.',409);
    const current = matching[0], actorId = session.user.id, reason = 'Vinculación explícita de guía verificada con la API oficial de Heka';
    if (current && !current.order_id && current.status!=='unknown') die('HEKA_LOCAL_EVENTS','La guía local sin pedido ya tiene eventos. Revísalos antes de vincularla.',409);
    if(preparation?.shipment_id && preparation.shipment_id!==current?.id)die('HEKA_PREPARATION_CHANGED','La preparación corresponde a otro envío local.',409);
    const assignments=preparation?.order_id?JSON.parse(preparation.data).lines.map(({lineId,quantity})=>({lineId,quantity})):null;
    const prepared=assignments?.length?{assignments}:{};
    const shipment = !current ? await saveShipmentTx(tx,{orderId:order.id,carrier,tracking:guideNumber,reason,...prepared},actorId)
      : current.order_id ? current : await linkShipmentTx(tx,{shipmentId:current.id,version:current.version,orderId:order.id,reason,...prepared},actorId,preparationId?{shippingPreparationId:preparationId}:{});
    await attach(shipment.id);
    const linked = {guide_id:guideId,carrier,guide_number:guideNumber,order_id:order.id,shipment_id:shipment.id,local_carrier:shipment.carrier,provider_status:verified.status,actor_id:actorId,linked_at:stamp()};
    await insertRow(tx,'heka_api_order_links',linked);
    const receipt = orderLinkDTO({...linked,order_number:order.number});
    await audit(tx,{entityType:'heka_guide_link',entityId:guideId,actorId,next:receipt,reason});
    return receipt;
  });
  return {status:200,data:{result}};
}

async function reserveMutation(store,body,op,session,options) {
  return locked(store,session,async (tx,actorId) => {
    const row = await settingsRow(tx);
    sameConfiguration(row,body);
    const config = await credentials(row,options);
    const payloadHash = digest(config.privateKey,[body.operation,body.environment,op.input,body.guideId??null]);
    const previous = await readMutation(tx,body.requestId);
    if (previous) {
      if (previous.actor_id!==actorId || previous.request_hash!==payloadHash) die('HEKA_REQUEST_CONFLICT','El identificador ya pertenece a otra solicitud de Heka.',409);
      return {previous};
    }
    const novelty = body.operation==='solveNovelty', now = stamp();
    const blocker = await tx.db.get(`SELECT id FROM ${tx.t('heka_api_mutations')} WHERE environment=? AND operation=? AND state IN ('sending','uncertain') LIMIT 1`,[body.environment,body.operation]);
    if (blocker) die('HEKA_RECONCILE_REQUIRED','Revisa el resultado pendiente en Historial antes de enviar otro cambio.',409);
    await consume(tx,'write');
    const intent = {
      id:body.requestId,environment:body.environment,operation:body.operation,state:'sending',actor_id:actorId,request_hash:payloadHash,
      carrier:op.input.distributor_id??null,novelty_guide_id:body.guideId??null,novelty_id:novelty?op.input.id:null,
      solution_hash:novelty?digest(config.privateKey,['novelty-solution-v1',op.input.solution]):null,
      credential_hash:credentialDigest(config),
      lease_until:expiry(now),created_at:now,updated_at:now
    };
    await insertRow(tx,'heka_api_mutations',intent);
    await queueJobTx(tx,jobKey(intent.id),{requestId:intent.id,phase:'fenced_send'},{now});
    return {intent,config};
  });
}
async function sendMutation(store,body,op,session,options) {
  const {previous,intent,config} = await reserveMutation(store,body,op,session,options);
  if (previous) return outcome(previous);
  const lease = await claimJob(store,{key:jobKey(intent.id)});
  if (!lease) return outcome(await readMutation(store,intent.id));
  let result, failure, sent = false;
  try {
    await locked(store,session,async tx => {
      sameConfiguration(await settingsRow(tx),body);
      const now = stamp(), current = await readMutation(tx,intent.id);
      await assertLease(tx,{...lease,now});
      if (current?.state!=='sending' || current.lease_until<=now) die('HEKA_WRITE_IN_PROGRESS','La autorización de envío de Heka ya no está vigente.',409);
    });
    if (options.signal?.aborted) die('HEKA_NOT_SENT','No se envió el cambio a Heka.',422);
    sent = true;
    // Deliberately do not cancel an authorized write when a browser closes:
    // the bounded provider request can still return a durable receipt.
    result = await requestHeka(config,body.operation,op,{transport:options.transport});
  } catch (error) { failure = error; }
  const state = result ? 'succeeded' : !sent || failure?.definiteRejection ? 'rejected' : 'uncertain';
  const code = result ? null : state==='uncertain' ? UNKNOWN : failure?.code===AUTH ? AUTH : 'HEKA_REJECTED';
  const saved = await store.transaction(async tx => {
    await tx.lockWrites();
    const now = stamp(), current = await readMutation(tx,intent.id);
    if (current.state!=='sending' || current.lease_until<=now) return current;
    await assertLease(tx,{...lease,now});
    const create = body.operation==='createGuide';
    if (create && result && await tx.db.get(`SELECT id FROM ${tx.t('heka_api_mutations')} WHERE environment=? AND guide_id=?`,[body.environment,result._id.toLowerCase()])) {
      // Two independent requests cannot claim the same guide. Preserve the
      // authoritative prior link and leave the later receipt uncertain.
      await tx.db.run(`UPDATE ${tx.t('heka_api_mutations')} SET state='uncertain',error_code=?,lease_until=NULL,updated_at=? WHERE id=?`,[UNKNOWN,now,intent.id]);
    } else await tx.db.run(`UPDATE ${tx.t('heka_api_mutations')} SET state=?,error_code=?,lease_until=NULL,guide_id=?,guide_number=?,remote_status=?,updated_at=? WHERE id=?`,[state,code,create?result?._id.toLowerCase()??null:null,create?result?.guide_number??null:null,(create?result?.status:result?.last_status)??null,now,intent.id]);
    return readMutation(tx,intent.id);
  });
  await finishJob(store,lease,{state:saved.state==='succeeded'?'succeeded':'failed',errorCode:saved.error_code});
  return outcome(saved,saved.state==='succeeded'?result:null);
}

async function reconcile(store,body,session,options) {
  assertConfirmed(body);
  const input = hekaInputObject(body.input,['requestId','guideId','guideNumber'],'Conciliación');
  const id = idLike(input.requestId,UUID,'Solicitud').toLowerCase();
  const {previous,config} = await locked(store,session,async tx => {
    const row = await settingsRow(tx);
    sameConfiguration(row,body);
    const previous = await readMutation(tx,id);
    if (!previous || previous.environment!==body.environment) die('HEKA_MUTATION_NOT_FOUND','No existe ese envío en este entorno.',404);
    if (mutationDTO(previous).state!=='uncertain') die('HEKA_RECONCILE_STATE','Solo se concilian resultados inciertos.',409);
    const config = await credentials(row,options);
    if (credentialDigest(config)!==previous.credential_hash) die('HEKA_RECONCILE_KEY','Configura la clave API original para contrastar este cambio con la misma cuenta de Heka.',409);
    await consume(tx,'read');
    return {previous,config};
  });
  let guideId = null, number = null, status = null;
  if (previous.operation==='createGuide') {
    guideId = idLike(input.guideId,HEKA_OBJECT_ID,'ID de guía').toLowerCase();
    number = idLike(input.guideNumber,HEKA_GUIDE_NUMBER,'Número de guía');
    const op = hekaOperation('guides',{id:guideId,distributor_id:previous.carrier,limit:1});
    const row = evidenceRow(await requestHeka(config,'guides',op,{...options,project:false}));
    if (lowerObjectId(row?._id)!==guideId || row?.guide_number!==number || row.distributor_id!=null && row.distributor_id!==previous.carrier || typeof row.status!=='string' || !HEKA_STATUS.test(row.status)) die('HEKA_NO_EVIDENCE','Heka no confirmó esa guía, número y transportadora. No se repetirá el envío.',409);
    status = row.status;
  } else {
    if (input.guideId!==undefined || input.guideNumber!==undefined) invalid('Conciliación de novedad');
    const op = hekaOperation('novelties',{id:previous.novelty_guide_id,limit:1});
    const row = evidenceRow(await requestHeka(config,'novelties',op,{...options,project:false})), last = row?.last_novelty;
    if (lowerObjectId(row?._id)!==previous.novelty_guide_id || lowerObjectId(last?._id)!==previous.novelty_id || typeof last?.solution!=='string' || last.solution.length>2000 || digest(config.privateKey,['novelty-solution-v1',last.solution])!==previous.solution_hash) die('HEKA_NO_EVIDENCE','Heka no confirmó la solución de esa novedad. No se repetirá el envío.',409);
    status = typeof last.last_status==='string' && HEKA_STATUS.test(last.last_status) ? last.last_status : null;
  }
  return locked(store,session,async (tx,actorId) => {
    sameConfiguration(await settingsRow(tx),body);
    const now = stamp(), current = await readMutation(tx,id);
    if (mutationDTO(current,now).state!=='uncertain') return outcome(current);
    if (guideId && await tx.db.get(`SELECT id FROM ${tx.t('heka_api_mutations')} WHERE environment=? AND guide_id=?`,[body.environment,guideId])) die('HEKA_EVIDENCE_LINKED','Esa guía ya está vinculada a otra solicitud.',409);
    await tx.db.run(`UPDATE ${tx.t('heka_api_mutations')} SET state='succeeded',error_code=NULL,lease_until=NULL,guide_id=?,guide_number=?,remote_status=?,updated_at=?,reconciled_at=? WHERE id=?`,[guideId,number,status,now,now,id]);
    await audit(tx,{entityType:'shipping_heka_api_mutation',entityId:id,actorId,next:{reconciledAt:now},reason:guideId?'Guía contrastada en Heka y vinculada por el operador':'Solución de novedad comprobada con evidencia de Heka'});
    return outcome(await readMutation(tx,id));
  });
}

export async function operateHeka(store,body,session,options = {}) {
  hekaInputObject(body,['operation','input','confirm','requestId','environment','version'],'Operación');
  const expected = {...getExpectations(body),operation:body.operation};
  if (body.operation==='reconcile') return reconcile(store,{...body,...expected},session,options);
  if (body.operation==='linkGuide') return linkGuide(store,{...body,...expected},session,options);
  let input = body.input, guideId;
  if (body.operation==='solveNovelty') {
    const fields = hekaInputObject(input,['id','guideId','solution'],'Novedad');
    guideId = idLike(fields.guideId,HEKA_OBJECT_ID,'ID de la guía').toLowerCase();
    input = {id:idLike(fields.id,HEKA_OBJECT_ID,'ID de la novedad').toLowerCase(),solution:fields.solution};
  }
  const op = hekaOperation(body.operation,input);
  if (op.definition.mutation) {
    assertConfirmed(body);
    const requestId = idLike(body.requestId,UUID,'Solicitud').toLowerCase();
    if (guideId) {
      // Verify that the entered parent is the guide of this precise novelty;
      // this is recoverable using only the official guide-by-id filter.
      const previous = await readMutation(store,requestId);
      if (!previous) {
        const read = hekaOperation('novelties',{id:guideId,limit:1});
        const row = evidenceRow(await providerRead(store,{...expected,operation:'novelties'},read,session,options,false));
        if (lowerObjectId(row?._id)!==guideId || lowerObjectId(row?.last_novelty?._id)!==op.input.id || !['in_novelty','in_review'].includes(row.status_novelty)) die('HEKA_NO_EVIDENCE','La novedad ya no coincide con esa guía o no admite solución.',409);
      }
    }
    return sendMutation(store,{...expected,requestId,guideId},op,session,options);
  }
  const fetched = await providerRead(store,expected,op,session,options);
  if (body.operation==='guides' && expected.environment==='production') await guideLinks(store,fetched?.rows ?? (fetched?[fetched]:[]));
  return body.operation==='sticker' ? {pdf:fetched} : {status:200,data:{result:fetched}};
}

export const HEKA_NOVELTY_CONNECTION = 'heka';

// Scheduler-only: the claimed local scope is the entire capability. Only
// official reads are allowed and background traffic reserves 12 shared slots.
async function readClaimedShipping(store,operation,input,assertClaim,options,signal) {
  const op = hekaOperation(operation,input);
  const config = await store.transaction(async tx=>{
    await tx.lockWrites();
    const row = await assertClaim(tx), auth = await credentials(row,options);
    await consume(tx,'read',12);
    await assertClaim(tx);
    return auth;
  });
  const result = await requestHeka(config,operation,op,{transport:options.transport,signal});
  await store.readSnapshot(assertClaim);
  return result;
}

function assertWebhookRevision(row,revision) {
  if (webhookSettings(row).revision!==revision) die('HEKA_WEBHOOK_CHANGED','Cambió el secreto del webhook Heka.',409);
}

export async function readHekaNoveltyPage(store,lease,{clock=stamp,...options} = {}) {
  const {environment,generation,sequence,page,leaseId,revision} = lease;
  const expected = {environment:environmentName(environment),version:versionNumber(generation)};
  if (!['open','resolved','guides'].includes(sequence) || !Number.isInteger(page) || typeof leaseId!=='string' || !UUID.test(leaseId)) invalid('Turno de envíos');
  const guides = sequence==='guides';
  if (guides) idLike(revision,UUID,'Revisión del webhook');
  return readClaimedShipping(store,guides?'guides':'novelties',{page,limit:50,...(sequence==='resolved'?{status_novelty:'resolved'}:{})},async tx=>{
    const row = await settingsRow(tx);
    sameConfiguration(row,expected);
    if (revision) assertWebhookRevision(row,revision);
    const cursors = guides ? '' : `JOIN ${tx.t('shipping_novelty_cursors')} c USING(connection_id,environment,generation)`;
    const checkpoint = guides ? 's.guide_page=? AND s.webhook_verified_revision=? AND s.guide_next_at<=?' : 's.next_sequence=? AND c.sequence=s.next_sequence AND c.page=?';
    const active = await tx.db.get(`SELECT 1 AS owned FROM ${tx.t('shipping_novelty_sync')} s ${cursors}
      WHERE s.connection_id=? AND s.environment=? AND s.generation=? AND s.lease_id=? AND s.lease_until>? AND ${checkpoint}`,
    [HEKA_NOVELTY_CONNECTION,environment,generation,leaseId,clock(),...(guides?[page,revision,clock()]:[sequence,page])]);
    if (!active) die('HEKA_NOVELTY_LEASE_LOST','Se perdió el turno de sincronización de envíos.',409);
    return row;
  },options);
}

// The signed event provides an exact ID, not status or local-order evidence.
// Confirm the guide itself even when neither novelty filter returns a row.
export async function readHekaWebhookNovelty(store,claim,{clock=stamp,...options}={}) {
  const {environment,generation,guideId,leaseId,revision}=claim;
  const expected={environment:environmentName(environment),version:versionNumber(generation)};
  idLike(guideId,HEKA_OBJECT_ID,'Guía');
  idLike(leaseId,UUID,'Turno');
  idLike(revision,UUID,'Revisión del webhook');
  async function verified(tx) {
    const row=await settingsRow(tx);
    sameConfiguration(row,expected);
    assertWebhookRevision(row,revision);
    const active=await tx.db.get(`SELECT 1 AS owned FROM ${tx.t('shipping_novelty_sync')}
      WHERE connection_id=? AND environment=? AND generation=? AND lease_id=? AND lease_until>?`,
    [HEKA_NOVELTY_CONNECTION,environment,generation,leaseId,clock()]);
    if(!active)die('HEKA_NOVELTY_LEASE_LOST','Se perdió el turno de sincronización de envíos.',409);
    return row;
  }
  const signal=AbortSignal.timeout(40000), query={id:guideId,limit:1};
  const read=(operation,input)=>readClaimedShipping(store,operation,input,verified,options,signal);
  const exact=(result)=>{
    if (result===null || Array.isArray(result?.rows) && !result.rows.length) return null;
    const row=evidenceRow(result);
    if(lowerObjectId(row?._id)!==guideId)die('HEKA_NO_EVIDENCE','Heka no confirmó la guía exacta del webhook.',409);
    return row;
  };
  const guide=exact(await read('guides',query));
  if(!guide?.guide_number || !guide.status)die('HEKA_NO_EVIDENCE','Heka no confirmó el estado de la guía del webhook.',409);
  const observations=[];
  for(const sequence of ['open','resolved']){
    const row=exact(await read('novelties',{...query,...(sequence==='resolved'?{status_novelty:'resolved'}:{})}));
    if (row && (row.guide_number && row.guide_number!==guide.guide_number || row.distributor_id && guide.distributor_id && row.distributor_id!==guide.distributor_id)) {
      die('HEKA_NO_EVIDENCE','Heka devolvió identidades de guía incompatibles.',409);
    }
    if(row && (sequence==='resolved')===(row.status_novelty==='resolved'))observations.push({sequence,row});
  }
  // If the same novelty resolved between the two reads, prefer its later state.
  const [first,second]=observations;
  return {guide,observations:second && first.row.last_novelty?._id && lowerObjectId(first.row.last_novelty._id)===lowerObjectId(second.row.last_novelty?._id) ? [second] : observations};
}
