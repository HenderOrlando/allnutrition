import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { insertRow, stamp } from '../lib/business/commands.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { emptyRecord } from '../lib/schema.mjs';
import { getBusinessSettings, saveBusinessSettings, saveResource, listResources, ALERT_TYPES, initializeBusinessDefaults, isOnboardingProduct } from '../lib/business/settings.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { listAlertRules, getAlertRule, saveAlertRule, pageAlerts, getAlert, updateAlert, alertClientData, stockAlertThresholds } from '../lib/business/alerts.mjs';

const actor='settings-alert-admin', requestId=()=>randomUUID();
async function fixture(fn) {
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {await fn(store);} finally {await store.close();}
}
async function alertFact(store,{id=requestId(),ruleId='shipment_incident',entityType='shipment',entityId=requestId(),state='open',severity='warning',firstSeenAt='2026-09-01T05:00:00.000Z',data={}}={}) {
  const now=stamp();
  await store.transaction(async tx=>{
    await tx.lockWrites();
    await insertRow(tx,'alerts',{id,rule_id:ruleId,entity_type:entityType,entity_id:entityId,episode:1,state,severity,first_seen_at:firstSeenAt,last_seen_at:firstSeenAt,responsible_id:null,version:1,data:JSON.stringify({reason:'Evidencia sintética del contrato',count:1,...data}),created_at:now,updated_at:now});
  });
  return id;
}
const revision=async store=>(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value;

test('reglas tipadas persisten versiones, auditoría e idempotencia sin invalidar indicadores',()=>fixture(async store=>{
  assert.equal((await listAlertRules(store)).records.length,ALERT_TYPES.length);
  const rule=await getAlertRule(store,'shipment_label_stale');
  const person=await saveResource(store,'people',{name:'Responsable sin cuenta de acceso',requestId:requestId()},actor);
  const before=await revision(store);
  const input={version:rule.version,requestId:requestId(),thresholds:{hours:60},responsibleId:person.id,enabled:false,reminderHours:12,reason:'Cambiar umbral calendario'};
  const next=await saveAlertRule(store,input,actor,rule.id);
  assert.equal(next.thresholds.hours,60);assert.equal(next.enabled,false);assert.equal(next.version,2);
  assert.deepEqual(next.selectedStatuses,rule.selectedStatuses);
  assert.deepEqual(await saveAlertRule(store,input,actor,rule.id),next);
  assert.equal(await revision(store),before);
  await assert.rejects(()=>saveAlertRule(store,{...input,thresholds:{hours:61}},actor,rule.id),{status:409});
  await assert.rejects(()=>saveAlertRule(store,{...input,requestId:requestId()},actor,rule.id),{status:409});
  for (const change of [{enabled:'false'},{enabled:null},{type:'cash_difference'},{thresholds:{days:2}},{thresholds:{hours:0}},{reminderHours:0},{selectedStatuses:['invented']},{responsibleId:'missing'}]) {
    await assert.rejects(()=>saveAlertRule(store,{version:next.version,requestId:requestId(),...change},actor,rule.id),{status:400});
  }
  await assert.rejects(()=>getAlertRule(store,'missing'),{status:404});
  const audit=await store.db.get(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='alert_rule' AND entity_id=?`,[rule.id]);
  assert.equal(JSON.parse(audit.data).previous.thresholds.hours,48);
  assert.equal(JSON.parse(audit.data).next.thresholds.hours,60);
}));

test('anticipación de existencias valida enteros y horizontes normalizados sin mutar datos',()=>{
  assert.deepEqual(stockAlertThresholds(),{amount:1,unit:'week'});
  for (const [unit,maximum] of [['day',3650],['week',521],['month',121]]) {
    const input=Object.freeze({amount:maximum,unit});
    assert.deepEqual(stockAlertThresholds(input),input);
    assert.throws(()=>stockAlertThresholds({amount:maximum+1,unit}),{status:400});
  }
  for (const input of [null,[],{amount:0},{amount:-1},{amount:1.5},{amount:'1'},{amount:null},{unit:null},{unit:'year'},{days:7}]) assert.throws(()=>stockAlertThresholds(input),{status:400});
});

test('regla stock_low persiste unidad, cantidad, responsable y configuración independiente',()=>fixture(async store=>{
  const original=await getAlertRule(store,'stock_low');
  assert.deepEqual(original.thresholds,{amount:1,unit:'week'});
  const input={requestId:requestId(),version:original.version,thresholds:{amount:2,unit:'month'},reminderHours:6};
  const saved=await saveAlertRule(store,input,actor,original.id);
  assert.deepEqual(saved.thresholds,{amount:2,unit:'month'});
  assert.equal(saved.reminderHours,6);
  assert.deepEqual(await saveAlertRule(store,input,actor,original.id),saved);
  const updated=await saveAlertRule(store,{requestId:requestId(),version:saved.version,thresholds:{unit:'week'}},actor,original.id);
  assert.deepEqual(updated.thresholds,{amount:2,unit:'week'});
  for (const thresholds of [{amount:0},{amount:522,unit:'week'},{unit:'year'},{hours:1}]) await assert.rejects(()=>saveAlertRule(store,{requestId:requestId(),version:updated.version,thresholds},actor,original.id),{status:400});
}));

test('inicialización de actualización solo inserta reglas ausentes sin cambiar configuraciones ni marcadores',()=>fixture(async store=>{
  const person=await saveResource(store,'people',{name:'Responsable conservado',requestId:requestId()},actor);
  await saveAccount(store,{name:'Banco conservado',type:'bank',responsibleId:person.id,openingOn:bogotaDate(),openingBalanceMinor:100,requestId:requestId()},actor);
  const old=await getAlertRule(store,'shipment_label_stale');
  await saveAlertRule(store,{requestId:requestId(),version:old.version,thresholds:{hours:80},enabled:false,responsibleId:person.id,reminderHours:9},actor,old.id);
  await store.db.run(`DELETE FROM ${store.t('alert_rules')} WHERE id='stock_low'`);
  const snapshot=async ()=>({
    settings:await store.db.all(`SELECT * FROM ${store.t('business_settings')} ORDER BY id`),
    accounts:await store.db.all(`SELECT * FROM ${store.t('cash_accounts')} ORDER BY id`),
    rules:await store.db.all(`SELECT * FROM ${store.t('alert_rules')} WHERE id<>'stock_low' ORDER BY id`),
    counters:await store.db.all(`SELECT * FROM ${store.t('counters')} ORDER BY id`),
    migrations:await store.db.all(`SELECT * FROM ${store.t('migrations')} ORDER BY version`),
  });
  const before=await snapshot();
  const initialize=()=>store.transaction(async tx=>{await tx.lockWrites();await initializeBusinessDefaults(tx);});
  // Reads do not silently provision a default.
  assert.equal((await listAlertRules(store)).records.some(rule=>rule.type==='stock_low'),false);
  await initialize();
  assert.deepEqual(await snapshot(),before);
  let stock=await getAlertRule(store,'stock_low');
  assert.deepEqual(stock.thresholds,{amount:1,unit:'week'});assert.equal(stock.enabled,true);
  stock=await saveAlertRule(store,{requestId:requestId(),version:stock.version,enabled:false,thresholds:{amount:3,unit:'month'},responsibleId:person.id,reminderHours:7},actor,stock.id);
  const preserved=await snapshot();
  await initialize();await initialize();
  assert.deepEqual(await getAlertRule(store,'stock_low'),stock);
  assert.deepEqual(await snapshot(),preserved);
  await store.db.run(`UPDATE ${store.t('alert_rules')} SET id='restored-stock-rule' WHERE id='stock_low'`);
  const restored=await getAlertRule(store,'restored-stock-rule');
  await initialize();
  assert.deepEqual(await getAlertRule(store,'restored-stock-rule'),restored);
  assert.equal((await listAlertRules(store)).records.filter(rule=>rule.type==='stock_low').length,1);
}));

test('alertas paginan20 por severidad/antigüedad y no exponen JSON ni contactos',()=>fixture(async store=>{
  for(let i=0;i<21;i++)await alertFact(store,{id:'warning-'+String(i).padStart(2,'0'),firstSeenAt:'2026-08-01T05:00:00.000Z',data:{phone:'privado',address:'privada',customerName:'privado'}});
  const critical=await alertFact(store,{severity:'critical',firstSeenAt:'2026-09-01T05:00:00.000Z'});
  const resolved=await alertFact(store,{state:'resolved'});
  const first=await pageAlerts(store,{}),second=await pageAlerts(store,{page:2});
  assert.equal(first.total,22);assert.equal(first.records.length,20);assert.equal(second.records.length,2);assert.equal(first.pageSize,20);
  assert.equal(first.records[0].id,critical);assert.equal(first.records[1].id,'warning-00');
  assert.equal((await pageAlerts(store,{state:'resolved'})).records[0].id,resolved);
  assert.equal((await pageAlerts(store,{severity:'critical',type:'shipment_incident'})).total,1);
  assert.ok(!JSON.stringify(first).includes('privad'));
  for(const bad of [{state:'deleted'},{severity:'urgent'},{type:'other'},{page:0}])await assert.rejects(()=>pageAlerts(store,bad),{status:400});
  await assert.rejects(()=>getAlert(store,'missing'),{status:404});
}));

test('En atención conserva condición; asignación explícita sobrevive como override para el evaluador',()=>fixture(async store=>{
  const id=await alertFact(store),person=await saveResource(store,'people',{name:'Atiende la incidencia',requestId:requestId()},actor);
  const before=await revision(store),input={version:1,requestId:requestId(),state:'acknowledged',responsibleId:person.id};
  const next=await updateAlert(store,input,actor,id);
  assert.equal(next.state,'acknowledged');assert.equal(next.responsibleName,person.name);
  assert.deepEqual(await updateAlert(store,input,actor,id),next);
  const raw=JSON.parse((await store.db.get(`SELECT data FROM ${store.t('alerts')} WHERE id=?`,[id])).data);
  assert.equal(raw.responsibleOverride,true);assert.equal(raw.responsibleOverrideId,person.id);assert.equal(raw.count,1);
  const unassigned=await updateAlert(store,{version:next.version,requestId:requestId(),responsibleId:null},actor,id);
  assert.equal(unassigned.state,'acknowledged');assert.equal(unassigned.responsibleId,null);
  assert.equal(JSON.parse((await store.db.get(`SELECT data FROM ${store.t('alerts')} WHERE id=?`,[id])).data).responsibleOverrideId,null);
  assert.equal(await revision(store),before);
  for(const state of ['resolved','open','deleted'])await assert.rejects(()=>updateAlert(store,{version:unassigned.version,requestId:requestId(),state},actor,id),{status:400});
  const resolved=await alertFact(store,{state:'resolved'});
  await assert.rejects(()=>updateAlert(store,{version:1,requestId:requestId(),state:'acknowledged'},actor,resolved),{status:409});
}));

test('acciones de alertas usan pedidos vinculados o destinos reales; sin inventar liquidaciones para cobros',()=>{
  const base={id:'alert',rule_id:'rule',type:'settlement_overdue',entity_type:'collection',entity_id:'collection',episode:1,state:'open',severity:'warning',first_seen_at:'2026-09-01',last_seen_at:'2026-09-01',version:1,data:'{}'};
  assert.deepEqual(alertClientData({...base,target_order_id:'order',order_number:7}).action,{label:'Abrir pedido AN-000007',orderId:'order'});
  assert.equal(alertClientData(base).action.view.section,'business');
  const closing=alertClientData({...base,entity_type:'cash_closing',entity_id:'closing',target_account_id:'bank'}).action.view;
  assert.deepEqual(closing,{section:'cash',tab:'overview',account:'bank',record:'closing'});
  assert.deepEqual(alertClientData({...base,entity_type:'source',entity_id:'source'}).action.view,{section:'orders',tab:'imports',source:'source'});
  assert.deepEqual(alertClientData({...base,type:'stock_low',entity_type:'product',entity_id:'product'}).action.view,{section:'products',record:'product'});
});

test('configuración completa exige recursos reales, no crea caja ni exige sueldo fijo y excluye heartbeat derivado',()=>fixture(async store=>{
  let settings=await getBusinessSettings(store);
  await assert.rejects(()=>saveBusinessSettings(store,{version:settings.version,requestId:requestId(),setupCompleted:true,setupPolicyConfirmed:true},actor),{status:400});
  const person=await saveResource(store,'people',{name:'Responsable real',requestId:requestId()},actor);
  const account=await saveAccount(store,{name:'Banco real',type:'bank',responsibleId:person.id,openingOn:bogotaDate(),openingBalanceMinor:0,requestId:requestId()},actor);
  await assert.rejects(()=>saveBusinessSettings(store,{version:settings.version,requestId:requestId(),setupCompleted:true,setupPolicyConfirmed:true,defaultReceiptAccountId:account.id,defaultPaymentAccountId:account.id,alertDefaults:{responsibleId:person.id,reminderHours:24}},actor),/producto/);
  await store.save('products',{...emptyRecord('products'),title:'Producto agotado',slug:'producto-agotado',price:1000,stockQuantity:0,orderable:true},null,null,actor);
  await assert.rejects(()=>saveBusinessSettings(store,{version:settings.version,requestId:requestId(),setupCompleted:true,setupPolicyConfirmed:true,defaultReceiptAccountId:account.id,defaultPaymentAccountId:account.id,alertDefaults:{responsibleId:person.id,reminderHours:24}},actor),/producto/);
  await store.save('products',{...emptyRecord('products'),title:'Producto sin contar',slug:'producto-sin-contar',price:1000,stockQuantity:null,orderable:true},null,null,actor);
  settings=await saveBusinessSettings(store,{version:settings.version,requestId:requestId(),setupCompleted:true,setupPolicyConfirmed:true,defaultReceiptAccountId:account.id,defaultPaymentAccountId:account.id,alertDefaults:{responsibleId:person.id,reminderHours:24},automation:{status:'running'}},actor);
  assert.equal(settings.setupCompleted,true);assert.equal(settings.automation,undefined);assert.equal(settings.setupPayrollSkipped,undefined);
  assert.equal((await listResources(store,'people'))[0].salaryAgreements.length,0);
  for(const change of [{reportPeriods:[]},{alertDefaults:{responsibleId:'missing',reminderHours:24}},{alertDefaults:{responsibleId:person.id,reminderHours:0}},{setupPolicyConfirmed:'true'}])await assert.rejects(()=>saveBusinessSettings(store,{version:settings.version,requestId:requestId(),...change},actor),{status:400});
}));

test('producto inicial admite saldo desconocido, no cero explícito ni referencias no vendibles',()=>{
  const product={productType:'product',orderable:true,status:'draft',price:1000,stockQuantity:null,stockReserved:5};
  assert.equal(isOnboardingProduct(product),true);
  assert.equal(isOnboardingProduct({...product,stockQuantity:0}),false);
  assert.equal(isOnboardingProduct({...product,stockQuantity:5}),false);
  assert.equal(isOnboardingProduct({...product,stockQuantity:6}),true);
  for (const change of [{productType:'gift'},{orderable:false},{status:'archived'},{price:0}]) assert.equal(isOnboardingProduct({...product,...change}),false);
});

test('personas validan usuario real, convenios sin solape y versiones de comisión únicas',()=>fixture(async store=>{
  await assert.rejects(()=>saveResource(store,'people',{name:'Persona',userId:'missing',requestId:requestId()},actor),{status:400});
  const agreement={id:'first',enabled:true,amountPerPeriodMinor:0,frequency:'weekly',effectiveFrom:'2026-09-01',effectiveTo:'2026-09-30',payDayOffset:0};
  const override={id:'commission',effectiveOn:'2026-09-01',enabled:true,mode:'percent',rateBps:500};
  const person=await saveResource(store,'people',{name:'Persona',salaryAgreements:[agreement],commissionOverrides:[override],requestId:requestId()},actor);
  const archived=await saveResource(store,'people',{name:'Persona archivada',active:false,version:person.version,requestId:requestId()},actor,person.id);
  assert.deepEqual(archived.salaryAgreements,person.salaryAgreements);assert.deepEqual(archived.commissionOverrides,person.commissionOverrides);
  for(const change of [{salaryAgreements:[agreement,{...agreement,id:'second'}]},{salaryAgreements:[{...agreement,enabled:'true'}]},{commissionOverrides:[override,{...override,id:'second'}]},{commissionOverrides:[{...override,enabled:'true'}]}])await assert.rejects(()=>saveResource(store,'people',{name:archived.name,version:archived.version,requestId:requestId(),...change},actor,person.id),{status:400});
  const platform=await saveResource(store,'platforms',{name:'Plataforma real',requestId:requestId()},actor);
  const sources=await listResources(store,'sources',{platform:platform.id});
  assert.equal(sources.length,1);assert.equal(sources[0].name,'Principal');
}));
