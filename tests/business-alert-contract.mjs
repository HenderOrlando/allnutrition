import assert from 'node:assert/strict';
import { createBusinessBasics, createBusinessFixture, returnBusinessFixture, requestId, businessOrderInput } from './business-fixtures.mjs';
import { ALERT_TYPES, getBusinessSettings, saveBusinessSettings, saveResource } from '../lib/business/settings.mjs';
import { evaluateAlerts, getAlertRule, saveAlertRule, updateAlert, getAlert } from '../lib/business/alerts.mjs';
import { saveAccount, recordIncome, closeCash, reopenCash, reverseCashEntry } from '../lib/business/cash.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollectionTx } from '../lib/business/collections.mjs';
import { confirmSettlement } from '../lib/business/settlements.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { entity, runCommand, updateVersioned, audit } from '../lib/business/commands.mjs';
import { queueJobTx, claimJob } from '../lib/business/job-leases.mjs';

const alerts=async (store,type=null)=> (await store.db.all(`SELECT a.*,r.type FROM ${store.t('alerts')} a JOIN ${store.t('alert_rules')} r ON r.id=a.rule_id${type?' WHERE r.type=?':''} ORDER BY a.entity_id,a.episode`,type?[type]:[])).map(entity);
const active=rows=>rows.filter(row=>row.state!=='resolved');
const at=(f,date,time='12:00:00.000')=>`${f.year}-${date}T${time}Z`;
async function setRule(store,f,type,input) {
  const old=await getAlertRule(store,type);
  return saveAlertRule(store,{...input,version:old.version,requestId:requestId()},f.actorId,type);
}
async function shipment(store,f,extra={}) {
  return createShipment(store,{requestId:requestId(),sourceId:f.source.id,platformId:f.platform.id,...extra},f.actorId);
}
async function event(store,f,row,status,date) {
  return recordShipmentEvent(store,row.id,{requestId:requestId(),version:row.version,status,occurredAt:at(f,date)},f.actorId);
}
// Imports retain this exact observation metadata. Keep it explicit in the fixture:
// neither upload timestamps nor source_as_of alone establish a date's precision.
async function observeFileCut(store,f,row,value,precision='instant') {
  return runCommand(store,{scope:`alert-fixture:cut:${row.id}`,requestId:requestId(),payload:{value,precision},actorId:f.actorId},async tx=>{
    const old=await tx.db.get(`SELECT * FROM ${tx.t('shipments')} WHERE id=?`,[row.id]),data=JSON.parse(old.data);
    const cut={value,precision,sourceAsOf:precision==='day'?`${value}T05:00:00.000Z`:value};
    const next={...data,sourceCuts:{...(data.sourceCuts || {}),[row.sourceId]:cut}};
    await updateVersioned(tx,'shipments',row.id,old.version,{data:JSON.stringify(next)});
    await audit(tx,{entityType:'shipment_source_cut',entityId:row.id,actorId:f.actorId,previous:data.sourceCuts?.[row.sourceId] || null,next:cut,source:'excel',reason:'Corte sintético con precisión explícita'});
    return entity(await tx.db.get(`SELECT * FROM ${tx.t('shipments')} WHERE id=?`,[row.id]));
  });
}

// Parent appends these to businessContracts: the existing SQLite and guarded PG
// factories own setup/reset/close. This module never starts or resets a database.
export const alertContracts=[
  ['las diez reglas persistentes requieren hechos reales y conservan responsables',async store=>{
    const f=await createBusinessFixture(store);
    const label=await shipment(store,f,{status:'label_created',occurredAt:at(f,'09-01'),estimatedDeliveryOn:`${f.year}-09-02`,carrier:'Transportadora sintética',tracking:'ALERT-LABEL'});
    await observeFileCut(store,f,label,at(f,'09-01'));
    const incident=await shipment(store,f);
    await event(store,f,incident,'incident','09-02');
    const cash=await saveAccount(store,{requestId:requestId(),name:'Caja sintética de alertas',type:'cash',openingOn:`${f.year}-09-01`,openingBalanceMinor:100000,responsibleId:f.person.id,minimumMinor:100001,closingEnabled:true,closingTime:'17:00',toleranceMinor:0},f.actorId);
    const closing=await closeCash(store,{requestId:requestId(),accountId:cash.id,closingOn:`${f.year}-09-01`,countedMinor:99999},f.actorId);
    const result=await evaluateAlerts(store,{now:new Date(at(f,'09-12','23:00:00.000'))});
    assert.equal(result.stale,false);
    const rows=active(await alerts(store));
    assert.deepEqual(new Set(rows.map(row=>row.type)),new Set(ALERT_TYPES));
    assert.equal(rows.find(row=>row.type==='cash_difference').entityId,closing.id);
    for (const row of rows.filter(row=>row.entityId===cash.id || row.entityId===closing.id || row.entityId===f.collectionId)) assert.equal(row.responsibleId,f.person.id);
    assert.ok(rows.filter(row=>row.type==='business_data_missing').every(row=>row.severity==='info'));
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')} WHERE account_id=?`,[cash.id])).n),1,'Las alertas y cierres no ajustan caja.');
  }],
  ['saldo 127500: acusar y desasignar no resuelve; ingreso real de 500 sí',async store=>{
    const f=await createBusinessFixture(store,{settle:true,pay:true});
    await returnBusinessFixture(store,f,{refund:true});
    await saveAccount(store,{requestId:requestId(),version:f.account.version,minimumMinor:12800000},f.actorId,f.account.id);
    const now=at(f,'10-04');
    await Promise.all([evaluateAlerts(store,{now}),evaluateAlerts(store,{now})]);
    let rows=await alerts(store,'cash_below_minimum');
    assert.equal(rows.length,1);assert.equal(rows[0].amountMinor,12750000);assert.equal(rows[0].responsibleId,f.person.id);
    const acknowledged=await updateAlert(store,{requestId:requestId(),version:rows[0].version,state:'acknowledged',responsibleId:null},f.actorId,rows[0].id);
    await evaluateAlerts(store,{now:at(f,'10-04','13:00:00.000')});
    let current=await getAlert(store,acknowledged.id);
    assert.equal(current.state,'acknowledged');assert.equal(current.responsibleId,null);assert.equal(current.version,acknowledged.version);
    await evaluateAlerts(store,{now:at(f,'10-05')});
    current=await getAlert(store,acknowledged.id);
    assert.equal(current.state,'acknowledged');assert.equal(current.responsibleId,null);
    assert.equal((await alerts(store,'cash_below_minimum'))[0].reminderCount,1);
    const income=await recordIncome(store,{requestId:requestId(),accountId:f.account.id,amountMinor:50000,effectiveOn:`${f.year}-10-03`,concept:'owner_funding'},f.actorId);
    await evaluateAlerts(store,{now:at(f,'10-05','13:00:00.000')});
    rows=await alerts(store,'cash_below_minimum');
    assert.equal(rows.length,1);assert.equal(rows[0].state,'resolved');assert.equal(rows[0].responsibleOverrideId,null);
    assert.equal((await alerts(store,'cash_close_missing')).length,0,'Los bancos nunca requieren cierre diario.');
    await reverseCashEntry(store,{requestId:requestId(),cashEntryId:income.id,effectiveOn:`${f.year}-10-03`,reason:'Reversión sintética del ingreso'},f.actorId);
    await evaluateAlerts(store,{now:at(f,'10-05','14:00:00.000')});
    assert.deepEqual((await alerts(store,'cash_below_minimum')).map(row=>[row.episode,row.state]),[[1,'resolved'],[2,'open']]);
  }],
  ['episodios de incidente siguen los eventos incluso al omitir una evaluación intermedia',async store=>{
    const f=await createBusinessBasics(store);
    let s=await shipment(store,f);
    s=await event(store,f,s,'incident','09-01');
    await evaluateAlerts(store,{now:at(f,'09-01','13:00:00.000')});
    let rows=await alerts(store,'shipment_incident');assert.equal(rows.length,1);
    await updateAlert(store,{requestId:requestId(),version:rows[0].version,state:'acknowledged'},f.actorId,rows[0].id);
    s=await event(store,f,s,'in_transit','09-02');
    s=await event(store,f,s,'incident','09-03');
    await Promise.all([evaluateAlerts(store,{now:at(f,'09-03','13:00:00.000')}),evaluateAlerts(store,{now:at(f,'09-03','13:00:00.000')})]);
    rows=await alerts(store,'shipment_incident');
    assert.deepEqual(rows.map(row=>[row.episode,row.state]),[[1,'resolved'],[2,'open']]);
    assert.notEqual(rows[0].startEventId,rows[1].startEventId);
    const versions=rows.map(row=>row.version);
    await evaluateAlerts(store,{now:at(f,'09-03','13:00:00.000')});
    assert.deepEqual((await alerts(store,'shipment_incident')).map(row=>row.version),versions);
    s=await event(store,f,s,'in_transit','09-04');
    await evaluateAlerts(store,{now:at(f,'09-04','13:00:00.000')});
    assert.equal(active(await alerts(store,'shipment_incident')).length,0);
    let unseen=await shipment(store,f);
    unseen=await event(store,f,unseen,'incident','09-05');
    unseen=await event(store,f,unseen,'in_transit','09-06');
    await event(store,f,unseen,'incident','09-07');
    await evaluateAlerts(store,{now:at(f,'09-07','13:00:00.000')});
    const history=(await alerts(store,'shipment_incident')).filter(row=>row.entityId===unseen.id);
    assert.deepEqual(history.map(row=>[row.episode,row.state]),[[1,'resolved'],[2,'open']]);
  }],
  ['cada cuenta de plataforma tiene su propio corte y las fechas sin hora no fingen frescura',async store=>{
    const f=await createBusinessBasics(store);
    const other=await saveResource(store,'sources',{requestId:requestId(),platformId:f.platform.id,name:'Otra cuenta sintética'},f.actorId);
    const a=await shipment(store,f),b=await shipment(store,f,{sourceId:other.id});
    await observeFileCut(store,f,a,at(f,'09-01'));
    await observeFileCut(store,f,b,at(f,'09-04','11:00:00.000'));
    await evaluateAlerts(store,{now:at(f,'09-04')});
    assert.deepEqual(active(await alerts(store,'platform_not_updated')).map(row=>row.entityId),[f.source.id]);
    await observeFileCut(store,f,a,`${f.year}-09-04`,'day');
    await evaluateAlerts(store,{now:at(f,'09-05')});
    assert.equal(active(await alerts(store,'platform_not_updated')).some(row=>row.entityId===f.source.id),false);
    const missing=active(await alerts(store,'business_data_missing')).find(row=>row.entityId===f.source.id);
    assert.ok(missing.missing.includes('source_cut_unknown'));
    await evaluateAlerts(store,{now:at(f,'09-06','05:00:00.001')});
    assert.equal(active(await alerts(store,'platform_not_updated')).filter(row=>row.entityId===f.source.id).length,1);
  }],
  ['fechas y costos desconocidos informan sin inventar retrasos ni liquidación vencida',async store=>{
    const f=await createBusinessBasics(store);
    const order=await store.saveOrder(businessOrderInput(f.a,{year:f.year,sellerId:f.person.id}),f.actorId);
    const s=await shipment(store,f,{orderId:order.id,status:'label_created',sourceAsOf:at(f,'09-01'),source:'excel',carrier:'Transportadora sintética',tracking:'SIN-FECHA'});
    const currentOrder=await store.order(order.id);
    await runCommand(store,{scope:'alert-fixture:unknown-collection',requestId:requestId(),payload:{orderId:order.id},actorId:f.actorId},tx=>recordCollectionTx(tx,{orderId:order.id,version:currentOrder.version,shipmentId:s.id,sourceId:f.source.id,holder:'platform',amountMinor:order.totalMinor,occurredOn:null,sourceAsOf:at(f,'09-01'),source:'excel',externalKey:'UNKNOWN-COLLECTION',method:'Contraentrega',reference:'RECAUDO-SIN-FECHA'},f.actorId,{allowUnknownDate:true}));
    await recordExpense(store,{requestId:requestId(),category:'other',amountMinor:100,incurredOn:null,concept:'Gasto sin fecha'},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-20')});
    for (const type of ['shipment_label_stale','shipment_no_update','shipment_overdue','platform_not_updated','settlement_overdue']) assert.equal(active(await alerts(store,type)).length,0,type);
    const missing=active(await alerts(store,'business_data_missing'));
    assert.ok(missing.some(row=>row.missing.includes('label_date_unknown')));
    assert.ok(missing.some(row=>row.missing.includes('collection_date_unknown')));
    assert.ok(missing.some(row=>row.missing.includes('expense_date_unknown')));
    assert.ok(missing.every(row=>row.severity==='info'));
    const current=await store.get('products',f.a.id);
    const zero=await store.save('products',{...current,unitCostMinor:0,costEffectiveOn:`${f.year}-09-01`},f.a.id,current.version,f.actorId);
    const freeCost=await store.saveOrder(businessOrderInput(zero,{year:f.year,sellerId:f.person.id}),f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-20')});
    assert.equal(active(await alerts(store,'business_data_missing')).some(row=>row.entityId===freeCost.id && row.missing.includes('product_cost_unknown')),false,'Un costo explícito cero es conocido.');
    const currentZero=await store.get('products',zero.id);
    const unknown=await store.save('products',{...currentZero,unitCostMinor:null,costEffectiveOn:`${f.year}-09-02`},zero.id,currentZero.version,f.actorId);
    const unknownCost=await store.saveOrder(businessOrderInput(unknown,{year:f.year,placedOn:`${f.year}-09-03`}),f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-20')});
    const orderMissing=active(await alerts(store,'business_data_missing')).find(row=>row.entityId===unknownCost.id);
    assert.ok(orderMissing.missing.includes('product_cost_unknown'));
    assert.ok(orderMissing.missing.includes('commission_seller_unknown'));
  }],
  ['un archivo de costos reciente no reemplaza la observación logística ni fecha una guía',async store=>{
    const f=await createBusinessBasics(store);
    let s=await shipment(store,f);
    s=await recordShipmentEvent(store,s.id,{requestId:requestId(),version:s.version,status:'in_transit',sourceAsOf:at(f,'09-01'),source:'excel'},f.actorId);
    assert.deepEqual(s.events.map(row=>[row.occurredAt,row.occurredOn,row.sourceAsOf]),[[null,null,at(f,'09-01')]]);
    s=await observeFileCut(store,f,s,at(f,'09-01'));
    s=await observeFileCut(store,f,s,at(f,'09-05'));
    const undated=await shipment(store,f,{status:'label_created',sourceAsOf:at(f,'09-01'),source:'excel'});
    await observeFileCut(store,f,undated,at(f,'09-01'));
    await evaluateAlerts(store,{now:at(f,'09-05','13:00:00.000')});
    assert.ok(active(await alerts(store,'shipment_no_update')).some(row=>row.entityId===s.id));
    assert.equal(active(await alerts(store,'platform_not_updated')).length,0);
    assert.equal(active(await alerts(store,'shipment_label_stale')).some(row=>row.entityId===undated.id),false,'Un corte conocido no prueba cuándo se creó la guía.');
    assert.ok(active(await alerts(store,'business_data_missing')).some(row=>row.entityId===undated.id && row.missing.includes('label_date_unknown')));
    await recordShipmentEvent(store,s.id,{requestId:requestId(),version:s.version,status:'in_transit',source:'excel',sourceAsOf:at(f,'09-05')},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-05','14:00:00.000')});
    assert.equal(active(await alerts(store,'shipment_no_update')).some(row=>row.entityId===s.id),false,'Una observación real del mismo estado sí actualiza el seguimiento.');
  }],
  ['umbrales horarios respetan precisión y el instante exacto del límite',async store=>{
    const f=await createBusinessBasics(store);
    const exact=await shipment(store,f,{status:'label_created',occurredAt:at(f,'09-01')});
    const day=await shipment(store,f,{status:'label_created',occurredOn:`${f.year}-09-01`});
    await evaluateAlerts(store,{now:at(f,'09-03')});
    assert.equal(active(await alerts(store,'shipment_label_stale')).length,0);
    await evaluateAlerts(store,{now:at(f,'09-03','12:00:00.001')});
    assert.deepEqual(active(await alerts(store,'shipment_label_stale')).map(row=>row.entityId),[exact.id]);
    await evaluateAlerts(store,{now:at(f,'09-04','05:00:00.000')});
    assert.equal(active(await alerts(store,'shipment_label_stale')).some(row=>row.entityId===day.id),false);
    await evaluateAlerts(store,{now:at(f,'09-04','05:00:00.001')});
    assert.equal(active(await alerts(store,'shipment_label_stale')).some(row=>row.entityId===day.id),true);
  }],
  ['liquidaciones parciales solo resuelven el bruto conciliado y no la declaración',async store=>{
    const f=await createBusinessFixture(store),now=at(f,'09-12');
    await evaluateAlerts(store,{now});
    let row=active(await alerts(store,'settlement_overdue'))[0];assert.equal(row.amountMinor,12200000);
    const first=await confirmSettlement(store,{requestId:requestId(),settlementId:f.settlement.id,version:f.settlement.version,receivedOn:`${f.year}-09-05`,accountId:f.account.id,lines:[{collectionId:f.collectionId,grossMinor:6100000,deductions:[]}]},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-12','13:00:00.000')});
    row=active(await alerts(store,'settlement_overdue'))[0];assert.equal(row.amountMinor,6100000);
    await confirmSettlement(store,{requestId:requestId(),settlementId:f.settlement.id,version:first.settlement.version,receivedOn:`${f.year}-09-06`,accountId:f.account.id,lines:[{collectionId:f.collectionId,grossMinor:6100000,deductions:f.settlement.lines[0].deductions}]},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-12','14:00:00.000')});
    assert.equal(active(await alerts(store,'settlement_overdue')).length,0);
    assert.equal((await alerts(store,'settlement_overdue')).length,1);
  }],
  ['cierres reabiertos y nuevas revisiones mantienen historia; billeteras no tienen cierre diario',async store=>{
    const f=await createBusinessBasics(store);
    const cash=await saveAccount(store,{requestId:requestId(),name:'Caja diaria sintética',type:'cash',openingOn:`${f.year}-09-01`,openingBalanceMinor:100000,responsibleId:f.person.id,closingEnabled:true,closingTime:'17:00',toleranceMinor:1},f.actorId);
    const wallet=await saveAccount(store,{requestId:requestId(),name:'Billetera sintética',type:'wallet',openingOn:`${f.year}-09-01`,openingBalanceMinor:0,responsibleId:f.person.id},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-01','22:00:00.000')});
    assert.equal(active(await alerts(store,'cash_close_missing')).length,0,'La hora exacta todavía no ha vencido.');
    await evaluateAlerts(store,{now:at(f,'09-01','22:00:00.001')});
    assert.deepEqual(active(await alerts(store,'cash_close_missing')).map(row=>row.entityId),[cash.id]);
    let closing=await closeCash(store,{requestId:requestId(),accountId:cash.id,closingOn:`${f.year}-09-01`,countedMinor:99999},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-01','23:00:00.000')});
    assert.equal(active(await alerts(store,'cash_close_missing')).length,0);assert.equal(active(await alerts(store,'cash_difference')).length,0,'La tolerancia es inclusiva.');
    await reopenCash(store,{requestId:requestId(),closingId:closing.id,version:closing.version,reason:'Rectificar conteo sintético'},f.actorId);
    await evaluateAlerts(store,{now:at(f,'09-01','23:10:00.000')});
    assert.equal(active(await alerts(store,'cash_close_missing')).length,1);
    closing=await closeCash(store,{requestId:requestId(),accountId:cash.id,closingOn:`${f.year}-09-01`,countedMinor:99998},f.actorId);
    assert.equal(closing.revision,2);
    await evaluateAlerts(store,{now:at(f,'09-01','23:20:00.000')});
    assert.equal(active(await alerts(store,'cash_close_missing')).length,0);assert.equal(active(await alerts(store,'cash_difference')).length,1);
    assert.equal((await alerts(store)).some(row=>row.type==='cash_close_missing' && [wallet.id,f.account.id].includes(row.entityId)),false);
  }],
  ['responsabilidad de regla, entidad y configuración; desactivar no simula corrección comercial',async store=>{
    const f=await createBusinessBasics(store);
    const general=await saveResource(store,'people',{requestId:requestId(),name:'Responsable general sintético'},f.actorId);
    const settings=await getBusinessSettings(store);
    await saveBusinessSettings(store,{...settings,requestId:requestId(),alertDefaults:{responsibleId:general.id,reminderHours:24}},f.actorId);
    let orphan=await shipment(store,f);
    orphan=await recordShipmentEvent(store,orphan.id,{requestId:requestId(),version:orphan.version,status:'incident',sourceAsOf:at(f,'09-01'),source:'excel'},f.actorId);
    assert.deepEqual(orphan.events.map(row=>[row.occurredAt,row.occurredOn,row.sourceAsOf]),[[null,null,at(f,'09-01')]]);
    await observeFileCut(store,f,orphan,at(f,'09-01'));
    await evaluateAlerts(store,{now:at(f,'09-02')});
    assert.equal(active(await alerts(store,'shipment_incident'))[0].responsibleId,general.id);
    await setRule(store,f,'shipment_incident',{responsibleId:f.person.id});
    await evaluateAlerts(store,{now:at(f,'09-02','13:00:00.000')});
    let row=active(await alerts(store,'shipment_incident'))[0];assert.equal(row.responsibleId,f.person.id);
    await updateAlert(store,{requestId:requestId(),version:row.version,responsibleId:null},f.actorId,row.id);
    await evaluateAlerts(store,{now:at(f,'09-02','14:00:00.000')});
    row=active(await alerts(store,'shipment_incident'))[0];assert.equal(row.responsibleId,null);
    await setRule(store,f,'shipment_incident',{enabled:false});
    await evaluateAlerts(store,{now:at(f,'09-02','15:00:00.000')});
    row=(await alerts(store,'shipment_incident'))[0];assert.equal(row.state,'resolved');assert.equal(row.resolutionCode,'rule_disabled');
    assert.equal((await store.db.get(`SELECT status FROM ${store.t('shipments')} WHERE id=?`,[orphan.id])).status,'incident');
    await setRule(store,f,'shipment_incident',{enabled:true});
    await evaluateAlerts(store,{now:at(f,'09-02','16:00:00.000')});
    assert.deepEqual((await alerts(store,'shipment_incident')).map(row=>row.state),['resolved','open']);
  }],
  ['evaluaciones obsoletas o sin lease vigente no escriben hechos parciales',async store=>{
    const f=await createBusinessBasics(store);
    await saveAccount(store,{requestId:requestId(),version:f.account.version,minimumMinor:10000001},f.actorId,f.account.id);
    const now=at(f,'09-02');
    const changing={readSnapshot:async fn=>{const result=await store.readSnapshot(fn);await recordIncome(store,{requestId:requestId(),accountId:f.account.id,amountMinor:1,effectiveOn:`${f.year}-09-01`,concept:'owner_funding'},f.actorId);return result;},transaction:fn=>store.transaction(fn)};
    const stale=await evaluateAlerts(changing,{now});
    assert.equal(stale.stale,true);
    assert.equal(stale.opened+stale.updated+stale.resolved,0);
    assert.equal((await alerts(store)).length,0);
    await saveAccount(store,{requestId:requestId(),version:2,minimumMinor:10000002},f.actorId,f.account.id);
    await store.transaction(async tx=>{await tx.lockWrites();await queueJobTx(tx,'alert-fixture:lease',{}, {now});});
    const lease=await claimJob(store,{key:'alert-fixture:lease',now});
    const leaseState=await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`,[lease.key]);
    const revision=await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    let ticks=0;
    // Claiming can advance past the requested origin; expire at its real deadline.
    await assert.rejects(()=>evaluateAlerts(store,{now,lease,clock:()=>ticks++===0?leaseState.updated_at:lease.leaseUntil}),{status:409});
    assert.equal((await alerts(store)).length,0,'La pérdida del lease revierte la escritura del episodio.');
    await assert.rejects(()=>evaluateAlerts(store,{now,lease,clock:()=>lease.leaseUntil}),{status:409});
    assert.equal((await alerts(store)).length,0);
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`,[lease.key]),leaseState);
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`),revision);
    const replacement=await claimJob(store,{key:lease.key,now:lease.leaseUntil});
    assert.ok(replacement);assert.notEqual(replacement.token,lease.token);
    const replacementState=await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`,[lease.key]);
    await assert.rejects(()=>evaluateAlerts(store,{now,lease,clock:()=>replacementState.updated_at}),{status:409});
    assert.equal((await alerts(store)).length,0,'El token anterior no puede escribir después de una nueva toma.');
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`,[lease.key]),replacementState);
    const result=await evaluateAlerts(store,{now,lease:replacement,clock:()=>replacementState.updated_at});
    assert.equal(result.opened,1);assert.equal(active(await alerts(store,'cash_below_minimum')).length,1);
  }],
];
