import { fail } from '../validation-core.mjs';
import { HEKA_CARRIERS, HEKA_ENVIRONMENTS, HEKA_GUIDE_NUMBER, HEKA_OBJECT_ID, HEKA_STATUS } from './heka-api.mjs';

const COLUMNS = ['id','environment','operation','state','actor_id','request_hash','carrier','novelty_guide_id','novelty_id','solution_hash','credential_hash','guide_id','guide_number','remote_status','error_code','reconciled_at','created_at','updated_at'];
const LINK_COLUMNS = ['guide_id','carrier','guide_number','order_id','shipment_id','local_carrier','provider_status','actor_id','linked_at'];
const ACTOR_ID = /^[\w:-]{1,100}$/;
const RECORD_ID = /^[\w:-]{1,200}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const scalar = (value,regex) => typeof value==='string' && regex.test(value);
const time = value => scalar(value,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
const only = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const invalid = () => fail('La evidencia de envíos de Heka no es válida en el respaldo.');

export async function exportHekaEvidence(tx) {
  const rows = await tx.db.all(`SELECT ${COLUMNS.join(',')} FROM ${tx.t('heka_api_mutations')} ORDER BY id`);
  const orderLinks = await tx.db.all(`SELECT ${LINK_COLUMNS.join(',')} FROM ${tx.t('heka_api_order_links')} ORDER BY guide_id`);
  if (!rows.length && !orderLinks.length) return undefined;
  // A snapshot may be captured between sending a request and saving the
  // reply. The restored instance must preserve the fence, not the lease.
  return {
    version:1,
    mutations:rows.map(row=>row.state==='sending'?{...row,state:'uncertain',error_code:'HEKA_OUTCOME_UNKNOWN'}:{...row}),
    orderLinks:orderLinks.map(row=>({...row}))
  };
}

export function prepareHekaEvidence(evidence,shipments) {
  if (evidence===undefined) return {mutations:[],orderLinks:[]};
  if (!only(evidence,['version','mutations','orderLinks']) || evidence.version!==1 || !Array.isArray(evidence.mutations) || !Array.isArray(evidence.orderLinks)) invalid();
  const ids = new Set(), linked = new Set();
  for (const row of evidence.mutations) {
    if (!only(row,COLUMNS) || !scalar(row.id,uuid) || ids.has(row.id) || typeof row.environment!=='string' || !Object.hasOwn(HEKA_ENVIRONMENTS,row.environment) || !['createGuide','solveNovelty'].includes(row.operation) || !scalar(row.actor_id,ACTOR_ID) || !scalar(row.request_hash,digest) || !scalar(row.credential_hash,digest) || !time(row.created_at) || !time(row.updated_at) || row.updated_at<row.created_at) invalid();
    ids.add(row.id);
    const create = row.operation==='createGuide', success = row.state==='succeeded';
    if (create) {
      if (!HEKA_CARRIERS.includes(row.carrier) || row.novelty_guide_id!==null || row.novelty_id!==null || row.solution_hash!==null) invalid();
    } else if (row.carrier!==null || !scalar(row.novelty_guide_id,HEKA_OBJECT_ID) || !scalar(row.novelty_id,HEKA_OBJECT_ID) || !scalar(row.solution_hash,digest)) invalid();
    if (create && success) {
      const link = `${row.environment}:${row.guide_id}`;
      if (!scalar(row.guide_id,HEKA_OBJECT_ID) || row.guide_id!==row.guide_id.toLowerCase() || !scalar(row.guide_number,HEKA_GUIDE_NUMBER) || !scalar(row.remote_status,HEKA_STATUS) || linked.has(link)) invalid();
      linked.add(link);
    } else if (row.guide_id!==null || row.guide_number!==null || (success ? row.remote_status!==null && !scalar(row.remote_status,HEKA_STATUS) : row.remote_status!==null)) invalid();
    if (success ? row.error_code!==null : row.state==='uncertain' ? row.error_code!=='HEKA_OUTCOME_UNKNOWN' : row.state==='rejected' ? !['HEKA_ROLE_OR_KEY','HEKA_REJECTED'].includes(row.error_code) : true) invalid();
    if (row.reconciled_at!==null && (!success || !time(row.reconciled_at) || row.reconciled_at!==row.updated_at)) invalid();
  }
  if (evidence.orderLinks.length) {
    const byShipment = new Map(shipments.map(row=>[row.id,row])), local = new Set(), remote = new Set(), tracking = new Set();
    for (const link of evidence.orderLinks) {
      if (!only(link,LINK_COLUMNS) || !scalar(link.guide_id,HEKA_OBJECT_ID) || link.guide_id!==link.guide_id.toLowerCase() || !HEKA_CARRIERS.includes(link.carrier) || !scalar(link.guide_number,HEKA_GUIDE_NUMBER) || !scalar(link.order_id,RECORD_ID) || !scalar(link.shipment_id,RECORD_ID) || !scalar(link.provider_status,HEKA_STATUS) || !scalar(link.actor_id,ACTOR_ID) || !time(link.linked_at)) invalid();
      const physical = byShipment.get(link.shipment_id), carrier = link.local_carrier;
      const key = `${link.carrier}:${link.guide_number}`;
      if (!physical || physical.order_id!==link.order_id || physical.tracking!==link.guide_number || physical.carrier!==carrier || typeof carrier!=='string' || carrier.normalize('NFKC').toLocaleLowerCase('es').trim()!==link.carrier || local.has(link.shipment_id) || remote.has(link.guide_id) || tracking.has(key)) invalid();
      local.add(link.shipment_id); remote.add(link.guide_id); tracking.add(key);
    }
  }
  return {mutations:evidence.mutations,orderLinks:evidence.orderLinks};
}
