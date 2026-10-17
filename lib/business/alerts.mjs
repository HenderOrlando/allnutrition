import { fail, integer, text } from '../validation-core.mjs';
import { ALERT_TYPES } from './settings.mjs';
import { assertLease, audit, canonicalJSON, entity, insertRow, newId, runCommand, updateVersioned } from './commands.mjs';
import { addDays, bogotaDate, instant } from './dates.mjs';
import { jobClock } from './job-leases.mjs';
import { effectiveShipmentEvents } from './shipments.mjs';

const TITLES = {
  shipment_label_stale:'Guía sin recogida conocida', shipment_no_update:'Envío sin actualización reciente',
  shipment_overdue:'Envío fuera de la fecha estimada', shipment_incident:'Novedad de envío',
  platform_not_updated:'Archivo de plataforma pendiente de actualizar', settlement_overdue:'Recaudo pendiente de liquidar',
  cash_below_minimum:'Cuenta por debajo del mínimo', cash_difference:'Diferencia en cierre de caja',
  cash_close_missing:'Cierre de caja pendiente', business_data_missing:'Datos por completar',
};
const STATUSES = ['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown'];
const HOURS = {shipment_label_stale:48,shipment_no_update:72,platform_not_updated:24};
const choose = (value, choices, label) => { if (!choices.includes(value)) fail(`${label}: opción no válida.`); return value; };
function plain(value, label) { if (!value || typeof value!=='object' || Array.isArray(value)) fail(`${label}: datos no válidos.`); return value; }
async function responsible(tx, value) {
  if (value == null || value === '') return null;
  const id=text(value,'Responsable',100,true);
  if (!await tx.db.get(`SELECT id FROM ${tx.t('people')} WHERE id=?`,[id])) fail('Responsable no encontrado.');
  return id;
}
function ruleData(input, old) {
  const thresholds={...(old.thresholds || {}),...plain(input.thresholds ?? {},'Umbrales')};
  const allowed=Object.hasOwn(HOURS,old.type)?['hours']:old.type==='settlement_overdue'?['days']:[];
  if (Object.keys(thresholds).some(key=>!allowed.includes(key))) fail('Umbral no permitido para esta regla.');
  for (const key of allowed) thresholds[key]=integer(thresholds[key] ?? (key==='hours'?HOURS[old.type]:7),'Umbral calendario',1,key==='hours'?87600:3650);
  const selectedStatuses=input.selectedStatuses ?? old.selectedStatuses ?? ['incident','return_in_transit'];
  if (!Array.isArray(selectedStatuses) || selectedStatuses.length>STATUSES.length || new Set(selectedStatuses).size!==selectedStatuses.length || selectedStatuses.some(status=>!STATUSES.includes(status))) fail('Estados de envío no válidos.');
  if (old.type==='shipment_incident' && !selectedStatuses.length) fail('Selecciona al menos un estado para la novedad.');
  return {thresholds,selectedStatuses,reminderHours:integer(input.reminderHours ?? old.reminderHours ?? 24,'Recordatorio en horas',1,87600)};
}
export async function listAlertRules(store) {
  return {records:(await store.db.all(`SELECT * FROM ${store.t('alert_rules')} ORDER BY type,scope_key,id`)).map(entity)};
}
export async function getAlertRule(store,id) {
  const row=entity(await store.db.get(`SELECT * FROM ${store.t('alert_rules')} WHERE id=?`,[text(id,'Regla',100,true)]));
  if (!row) fail('Regla no encontrada.',404);
  return row;
}
export async function saveAlertRule(store,input,actorId,id=null) {
  plain(input,'Regla'); id=text(id || input.id,'Regla',100,true);
  return runCommand(store,{scope:`alert-rule:${id}`,requestId:input.requestId,payload:input,actorId,affectsIndicators:false},async tx=>{
    const old=await getAlertRule(tx,id);
    if (!ALERT_TYPES.includes(old.type) || input.type!==undefined && input.type!==old.type || input.scopeKey!==undefined && input.scopeKey!==old.scopeKey) fail('El tipo y alcance de la regla no se pueden cambiar.');
    const enabled=input.enabled === undefined ? old.enabled : input.enabled;
    if (typeof enabled!=='boolean') fail('Activación de regla no válida.');
    const data={...ruleData(input,old),responsibleId:await responsible(tx,input.responsibleId===undefined?old.responsibleId:input.responsibleId)};
    await updateVersioned(tx,'alert_rules',id,input.version,{enabled:Number(enabled),data:JSON.stringify(data)});
    const next=await getAlertRule(tx,id);
    await audit(tx,{entityType:'alert_rule',entityId:id,actorId,previous:old,next,reason:text(input.reason || 'Configurar aviso','Motivo',2000,true)});
    return next;
  });
}
function actionFor(row) {
  if (row.target_order_id) return {label:row.order_number!=null?'Abrir pedido AN-'+String(row.order_number).padStart(6,'0'):'Abrir pedido',orderId:row.target_order_id};
  if (row.entity_type==='shipment') return {label:'Revisar envío',view:{section:'orders',tab:'shipments',record:row.entity_id}};
  if (row.entity_type==='source') return {label:'Importar archivo de esta cuenta',view:{section:'orders',tab:'imports',source:row.entity_id}};
  if (row.entity_type==='cash_account') return {label:'Revisar cuenta',view:{section:'cash',tab:'overview',account:row.entity_id,record:row.entity_id}};
  if (row.entity_type==='cash_closing') return {label:'Revisar cierre',view:{section:'cash',tab:'overview',...(row.target_account_id?{account:row.target_account_id}:{}),record:row.entity_id}};
  if (row.entity_type==='settlement') return {label:'Revisar liquidación',view:{section:'cash',tab:'settlements',record:row.entity_id}};
  if (row.entity_type==='expense') return {label:'Completar gasto',view:{section:'cash',tab:'expenses',record:row.entity_id}};
  return {label:'Revisar datos de la alerta',view:{section:'business',tab:'alerts',record:row.id}};
}
export function alertClientData(row) {
  const data=typeof row.data==='string'?JSON.parse(row.data):row.data || {};
  return {id:row.id,ruleId:row.rule_id,type:row.type,entityType:row.entity_type,entityId:row.entity_id,episode:row.episode,
    kind:row.type==='business_data_missing'?'data':'alert',state:row.state,severity:row.severity,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,
    responsibleId:row.responsible_id || null,responsibleName:row.responsible_name || null,version:row.version,
    title:typeof data.title==='string'?data.title:TITLES[row.type],reason:typeof data.reason==='string'?data.reason:'Esta alerta no tiene un motivo documentado; revisa su registro.',
    count:Number.isSafeInteger(data.count)?data.count:null,amountMinor:Number.isSafeInteger(data.amountMinor)?data.amountMinor:null,action:actionFor(row)};
}
function alertSelect(tx) {
  return `SELECT a.*,r.type,p.name AS responsible_name,COALESCE(s.order_id,c.order_id,CASE WHEN a.entity_type='order' THEN a.entity_id END) AS target_order_id,
    o.number AS order_number,cl.account_id AS target_account_id FROM ${tx.t('alerts')} a JOIN ${tx.t('alert_rules')} r ON r.id=a.rule_id
    LEFT JOIN ${tx.t('people')} p ON p.id=a.responsible_id
    LEFT JOIN ${tx.t('shipments')} s ON a.entity_type='shipment' AND s.id=a.entity_id
    LEFT JOIN ${tx.t('order_collections')} c ON a.entity_type='collection' AND c.id=a.entity_id
    LEFT JOIN ${tx.t('cash_closings')} cl ON a.entity_type='cash_closing' AND cl.id=a.entity_id
    LEFT JOIN ${tx.t('orders')} o ON o.id=COALESCE(s.order_id,c.order_id,CASE WHEN a.entity_type='order' THEN a.entity_id END)`;
}
export async function getAlert(store,id) {
  const row=await store.db.get(alertSelect(store)+' WHERE a.id=?',[text(id,'Alerta',100,true)]);
  if (!row) fail('Alerta no encontrada.',404);
  return alertClientData(row);
}
export async function pageAlerts(store,{state='active',severity,type,responsible:person,page=1}={}) {
  choose(state,['active','open','acknowledged','resolved','all'],'Estado');
  page=integer(Number(page),'Página',1,100000);
  const where=[],values=[];
  if (state==='active') where.push("a.state IN ('open','acknowledged')");
  else if (state!=='all') {where.push('a.state=?');values.push(state);}
  if (severity) {where.push('a.severity=?');values.push(choose(severity,['critical','warning','info'],'Severidad'));}
  if (type) {where.push('r.type=?');values.push(choose(type,ALERT_TYPES,'Tipo'));}
  if (person) {where.push('a.responsible_id=?');values.push(text(person,'Responsable',100,true));}
  const filter=where.length?' WHERE '+where.join(' AND '):'';
  return store.readSnapshot(async tx=>{
    const total=Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('alerts')} a JOIN ${tx.t('alert_rules')} r ON r.id=a.rule_id`+filter,values)).count);
    const rows=await tx.db.all(alertSelect(tx)+filter+" ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,a.first_seen_at,a.id LIMIT 20 OFFSET ?",[...values,(page-1)*20]);
    return {records:rows.map(alertClientData),total,page,pageSize:20};
  });
}
export async function updateAlert(store,input,actorId,id) {
  plain(input,'Alerta'); id=text(id || input.id,'Alerta',100,true);
  return runCommand(store,{scope:`alert:${id}`,requestId:input.requestId,payload:input,actorId,affectsIndicators:false},async tx=>{
    const old=entity(await tx.db.get(`SELECT * FROM ${tx.t('alerts')} WHERE id=?`,[id]));
    if (!old) fail('Alerta no encontrada.',404);
    if (input.state!==undefined && input.state!=='acknowledged') fail('Solo se permite marcar En atención; resolver depende de la condición real.');
    if (old.state==='resolved') fail('La alerta ya está resuelta; su episodio se conserva.',409);
    const assigning=Object.hasOwn(input,'responsibleId');
    if (input.state===undefined && !assigning) fail('Selecciona En atención o un responsable.');
    const nextResponsible=assigning?await responsible(tx,input.responsibleId):old.responsibleId;
    const raw=await tx.db.get(`SELECT data FROM ${tx.t('alerts')} WHERE id=?`,[id]);
    const data=JSON.parse(raw.data);
    // Evaluators must retain this explicit override, including an explicit unassignment.
    if (assigning) { data.responsibleOverride=true; data.responsibleOverrideId=nextResponsible; }
    await updateVersioned(tx,'alerts',id,input.version,{state:input.state || old.state,responsible_id:nextResponsible,data:JSON.stringify(data)});
    const next=await getAlert(tx,id);
    await audit(tx,{entityType:'alert',entityId:id,actorId,previous:old,next,reason:text(input.reason || (assigning?'Reasignar atención':'Marcar En atención'),'Motivo',2000,true)});
    return next;
  });
}

const HOUR_MS=3600000;
const FINAL=new Set(['delivered','returned','cancelled']);
const DISPATCHED=new Set(['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned']);
const decode=row=>entity(row);
const groupRows=(rows,key)=>{
  const groups=new Map();
  for (const row of rows) {const id=key(row);if (!groups.has(id)) groups.set(id,[]);groups.get(id).push(row);}
  return groups;
};
function safeAmount(value) {
  const amount=BigInt(value);
  if (amount<BigInt(Number.MIN_SAFE_INTEGER) || amount>BigInt(Number.MAX_SAFE_INTEGER)) fail('Saldo de alerta fuera del rango entero seguro.');
  return Number(amount);
}
// A civil date is an interval, not an observation at an invented midnight.
function observation(value,precision) {
  if (!value) return null;
  if (precision==='day') return {value,precision,from:Date.parse(`${value}T05:00:00.000Z`),until:Date.parse(`${addDays(value,1)}T05:00:00.000Z`)};
  if (precision==='instant') {const time=Date.parse(value);return {value,precision,from:time,until:time};}
  return {value,precision:'unknown',from:null,until:null};
}
function occurrenceDate(event) {
  return event.occurredAt ? observation(event.occurredAt,'instant') : event.occurredOn ? observation(event.occurredOn,'day') : null;
}
function statusObservation(value,shipment,context,source='excel') {
  const cut=context.cutHistory.get(`${shipment.id}:${value}`) || Object.values(shipment.sourceCuts || {}).find(cut=>cut.sourceAsOf===value);
  return cut ? observation(cut.value,cut.precision) : value ? observation(value,source==='manual'?'instant':'unknown') : null;
}
function eventObservation(event,shipment,context) {
  return newerObservation(occurrenceDate(event),statusObservation(event.sourceAsOf,shipment,context,event.source));
}
function newerObservation(a,b) {
  if (!a) return b;
  if (!b) return a;
  // Unknown precision must not turn a later dated observation into false certainty.
  const orderA=a.from ?? Date.parse(a.value),orderB=b.from ?? Date.parse(b.value);
  return orderB>orderA || orderB===orderA && a.precision==='unknown' ? b : a;
}
function elapsedStatus(value,hours,nowMs) {
  if (!value || value.from==null || value.from>nowMs) return 'unknown';
  const cutoff=nowMs-hours*HOUR_MS;
  return value.until<cutoff ? 'stale' : value.from>=cutoff ? 'fresh' : 'imprecise';
}
function sourceFreshness(sourceId,context,hours=24) {
  const cut=context.sourceCuts.get(sourceId) || null;
  return {status:elapsedStatus(cut,hours,context.nowMs),cut:cut ? {value:cut.value,precision:cut.precision} : null};
}
function sourceCaveat(shipment,context) {
  if (!shipment.sourceId) return '';
  const freshness=sourceFreshness(shipment.sourceId,context);
  return freshness.status==='stale' ? ' El archivo de esta cuenta también está desactualizado; confirma la situación con un reporte reciente.'
    : ['unknown','imprecise'].includes(freshness.status) ? ' La frescura del archivo no se conoce con precisión suficiente.' : '';
}
function incidentOccurrences(events,selected) {
  const result=[];
  let current=null,status='unknown';
  for (const event of events) {
    const allowed=!FINAL.has(status) || event.status===status || status==='delivered' && ['return_in_transit','returned'].includes(event.status);
    if (!allowed || event.status==='unknown' && FINAL.has(status)) continue;
    status=event.status;
    if (selected.has(status)) {
      if (!current) {current={key:event.id,start:event,end:null,latest:event};result.push(current);}
      current.latest=event;
    } else if (current) {current.end=event;current=null;}
  }
  return result;
}
async function alertFacts(store,now) {
  return store.readSnapshot(async tx=>{
    const rows=async table=>(await tx.db.all(`SELECT * FROM ${tx.t(table)}`)).map(decode);
    // A snapshot owns one dedicated client; issue its reads sequentially.
    const settings=decode(await tx.db.get(`SELECT * FROM ${tx.t('business_settings')} WHERE id=1`));
    const rules=await rows('alert_rules');
    const shipments=await rows('shipments');
    const events=await rows('shipment_events');
    const orders=(await tx.db.all(`SELECT id,data FROM ${tx.t('orders')}`)).map(decode);
    const accounts=await rows('cash_accounts');
    const closings=await rows('cash_closings');
    const collections=await rows('order_collections');
    const receipts=await rows('settlement_receipts');
    const expenses=await rows('expenses');
    const returns=await rows('order_returns');
    const balances=await tx.db.all(`SELECT account_id,COALESCE(SUM(amount_minor),0) AS balance FROM ${tx.t('cash_entries')} WHERE effective_on<=? GROUP BY account_id`,[bogotaDate(now)]);
    const revision=await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`);
    const existing=await tx.db.all(`SELECT rule_id,entity_type,entity_id FROM ${tx.t('alerts')} WHERE state IN ('open','acknowledged')`);
    const cutAudits=await tx.db.all(`SELECT entity_id,data FROM ${tx.t('business_audit')} WHERE entity_type='shipment_source_cut'`);
    const context={now,nowMs:Date.parse(now),today:bogotaDate(now),settings,rules,shipments,orders,accounts,closings,collections,receipts,expenses,returns,existing,
      revision:Number(revision.value),ordersById:new Map(orders.map(row=>[row.id,row])),shipmentsById:new Map(shipments.map(row=>[row.id,row])),
      shippingCostKnown:new Set(expenses.filter(row=>row.category==='shipping_out').map(row=>row.shipmentId)),
      eventsByShipment:groupRows(events,row=>row.shipmentId),balances:new Map(balances.map(row=>[row.account_id,safeAmount(row.balance)])),sourceCuts:new Map(),cutHistory:new Map()};
    for (const row of cutAudits) {
      const cut=JSON.parse(row.data).next;
      if (cut?.sourceAsOf && cut.value && ['day','instant'].includes(cut.precision)) {
        const key=`${row.entity_id}:${cut.sourceAsOf}`,old=context.cutHistory.get(key);
        // Two cuts sharing a normalized instant must retain the less precise date.
        if (!old || cut.precision==='day') context.cutHistory.set(key,cut);
      }
    }
    for (const shipment of shipments) for (const [sourceId,cut] of Object.entries(shipment.sourceCuts || {})) {
      const candidate=observation(cut.value,cut.precision);
      if (candidate && (candidate.from==null || candidate.from<=context.nowMs)) context.sourceCuts.set(sourceId,newerObservation(context.sourceCuts.get(sourceId),candidate));
    }
    return context;
  });
}
function alertConditions(context) {
  const conditions=new Map(ALERT_TYPES.map(type=>[type,new Map()]));
  const missing=new Map();
  const keyOf=(type,id)=>`${type}:${id}`;
  const add=(type,entityType,entityId,data,responsibleId=null,options={})=>{
    const key=keyOf(entityType,entityId),map=conditions.get(type);
    if (!map.has(key)) map.set(key,{entityType,entityId,responsibleId,occurrences:[]});
    map.get(key).occurrences.push({data:{title:TITLES[type],...data},active:true,...options});
  };
  const lack=(type,id,code,reason,responsibleId=null)=>{
    const key=keyOf(type,id);
    if (!missing.has(key)) missing.set(key,{type,id,responsibleId,reasons:new Map()});
    missing.get(key).reasons.set(code,reason);
  };
  const effective=new Map();
  const activeSources=new Map();
  for (const shipment of context.shipments) {
    const events=effectiveShipmentEvents(context.eventsByShipment.get(shipment.id) || []).filter(event=>{
      const at=event.occurredAt || (event.occurredOn ? `${event.occurredOn}T05:00:00.000Z` : event.sourceAsOf);
      return !at || Date.parse(at)<=context.nowMs;
    });
    effective.set(shipment.id,events);
    const order=context.ordersById.get(shipment.orderId),person=order?.sellerId || null;
    const active=!FINAL.has(shipment.status);
    if (!shipment.orderId) lack('shipment',shipment.id,'order_unlinked','Vincula este envío a su pedido; no se ha creado una venta ficticia.',person);
    if (shipment.status==='unknown') lack('shipment',shipment.id,'shipment_status_unknown','Revisa el estado externo desconocido del envío.',person);
    if (shipment.carrier && shipment.costStatus!=='known' && !context.shippingCostKnown.has(shipment.id)) {
      lack('shipment',shipment.id,'shipping_cost_unknown','Completa el costo real del transporte; un importe ausente no es cero.',person);
    }
    if (active && shipment.sourceId) {
      if (!activeSources.has(shipment.sourceId)) activeSources.set(shipment.sourceId,[]);
      activeSources.get(shipment.sourceId).push(shipment);
    }
    if (active) {
      const labels=events.filter(event=>event.status==='label_created');
      const dispatched=DISPATCHED.has(shipment.status) || events.some(event=>DISPATCHED.has(event.status));
      const label=labels[0],labelObservation=label ? occurrenceDate(label) : null;
      if (!dispatched && (label || shipment.status==='label_created')) {
        if (!labelObservation || labelObservation.precision==='unknown') lack('shipment',shipment.id,'label_date_unknown','Completa la fecha real de creación de la guía para evaluar la recogida.',person);
        else if (elapsedStatus(labelObservation,context.rules.find(rule=>rule.type==='shipment_label_stale')?.thresholds?.hours ?? 48,context.nowMs)==='imprecise') lack('shipment',shipment.id,'label_time_unknown','La fecha de creación no incluye hora: todavía no confirma un atraso por horas.',person);
        add('shipment_label_stale','shipment',shipment.id,{reason:'La guía supera el umbral calendario sin evidencia de recogida.',observation:labelObservation ? {value:labelObservation.value,precision:labelObservation.precision} : null},person,{test:rule=>elapsedStatus(labelObservation,rule.thresholds?.hours ?? 48,context.nowMs)==='stale'});
      }
      let latest=null;
      for (const event of events) latest=newerObservation(latest,eventObservation(event,shipment,context));
      // sourceCuts may come from a cost-only file. Only source_as_of is advanced
      // by an actual status observation (including an unchanged-status snapshot).
      latest=newerObservation(latest,statusObservation(shipment.sourceAsOf,shipment,context));
      if (!latest || latest.precision==='unknown') lack('shipment',shipment.id,'observation_date_unknown','Falta una fecha real de observación del envío; la fecha de carga no prueba un retraso.',person);
      else if (elapsedStatus(latest,context.rules.find(rule=>rule.type==='shipment_no_update')?.thresholds?.hours ?? 72,context.nowMs)==='imprecise') lack('shipment',shipment.id,'observation_time_unknown','La última observación solo tiene fecha, sin hora; no confirma todavía un atraso por horas.',person);
      add('shipment_no_update','shipment',shipment.id,{reason:'No hay una observación logística dentro del umbral calendario.'+sourceCaveat(shipment,context),observation:latest ? {value:latest.value,precision:latest.precision} : null},person,{test:rule=>elapsedStatus(latest,rule.thresholds?.hours ?? 72,context.nowMs)==='stale'});
      if (shipment.estimatedDeliveryOn && context.today>shipment.estimatedDeliveryOn) add('shipment_overdue','shipment',shipment.id,{reason:`La entrega estimada era ${shipment.estimatedDeliveryOn} y no hay resolución de entrega, devolución o cancelación.`+sourceCaveat(shipment,context),estimatedDeliveryOn:shipment.estimatedDeliveryOn},person);
    }
    const missingMilestone=['collected','delivered','returned'].some(status=>events.some(event=>event.status===status) && !events.some(event=>event.status===status && occurrenceDate(event)));
    const needsDispatchDate=order?.ruleSnapshot?.saleRecognition==='dispatched' || (order?.items || []).some(line=>line.productType==='gift' && line.unitPriceMinor===0);
    const dispatchDateMissing=needsDispatchDate && events.some(event=>DISPATCHED.has(event.status)) && !events.some(event=>event.status==='collected' && occurrenceDate(event));
    if (missingMilestone || dispatchDateMissing) lack('shipment',shipment.id,'event_date_unknown','Completa las fechas reales de despacho, entrega o retorno que requiere el cálculo; el corte del archivo no es la fecha del evento.',person);
  }
  for (const [sourceId,shipments] of activeSources) {
    const freshness=sourceFreshness(sourceId,context);
    if (['unknown','imprecise'].includes(freshness.status)) lack('source',sourceId,'source_cut_unknown',freshness.cut?.precision==='day'?'El corte del archivo solo tiene fecha, sin hora: no permite afirmar todavía un atraso por horas.':'Registra el corte real del archivo de esta cuenta; no se usa la fecha de subida como evidencia.');
    add('platform_not_updated','source',sourceId,{reason:'Esta cuenta tiene envíos activos y el corte de su archivo supera el umbral calendario.',count:shipments.length,sourceCut:freshness.cut},null,{test:rule=>sourceFreshness(sourceId,context,rule.thresholds?.hours ?? 24).status==='stale'});
  }
  const collections=context.collections.filter(row=>!row.occurredOn || row.occurredOn<=context.today);
  const reversedCollections=new Set(collections.map(row=>row.reversalOf).filter(Boolean));
  const reversedReceipts=new Set(context.receipts.filter(row=>row.receivedOn<=context.today).map(row=>row.reversalOf).filter(Boolean));
  const settled=new Map();
  for (const receipt of context.receipts) if (receipt.receivedOn<=context.today && !receipt.reversalOf && !reversedReceipts.has(receipt.id)) {
    for (const line of receipt.lines || []) settled.set(line.collectionId,(settled.get(line.collectionId) || 0n)+BigInt(line.grossMinor));
  }
  // A platform refund consumes that source's oldest unsettled receipts, never another account's pool.
  const pools=groupRows(collections.filter(row=>row.holder==='platform' && !row.reversalOf && !reversedCollections.has(row.id)),row=>{
    const shipment=context.shipmentsById.get(row.shipmentId);
    return `${row.orderId}:${row.sourceId || shipment?.sourceId || `platform:${row.platformId || shipment?.platformId || ''}`}`;
  });
  for (const pool of pools.values()) {
    let refunds=pool.filter(row=>row.kind==='refund').reduce((sum,row)=>sum+BigInt(row.amountMinor),0n);
    const receipts=pool.filter(row=>row.kind==='receipt').sort((a,b)=>(a.occurredOn || '9999').localeCompare(b.occurredOn || '9999') || a.id.localeCompare(b.id));
    for (const collection of receipts) {
      let pending=BigInt(collection.amountMinor)-(settled.get(collection.id) || 0n);
      if (pending<=0n) continue;
      const offset=refunds<pending?refunds:pending;refunds-=offset;pending-=offset;
      if (pending===0n) continue;
      const person=context.ordersById.get(collection.orderId)?.sellerId || null;
      if (!collection.occurredOn) lack('collection',collection.id,'collection_date_unknown','Completa la fecha real del recaudo antes de afirmar que la liquidación está vencida.',person);
      add('settlement_overdue','collection',collection.id,{reason:'Este recaudo confirmado sigue en plataforma, sin recepción conciliada tras el plazo calendario.',amountMinor:safeAmount(pending),occurredOn:collection.occurredOn},person,{test:rule=>!!collection.occurredOn && context.today>addDays(collection.occurredOn,rule.thresholds?.days ?? 7)});
    }
  }
  const latestClosings=new Map();
  for (const closing of context.closings) if (closing.closingOn<=context.today) {
    const key=`${closing.accountId}:${closing.closingOn}`,old=latestClosings.get(key);
    if (!old || closing.revision>old.revision) latestClosings.set(key,closing);
  }
  const closingsByAccount=groupRows([...latestClosings.values()],row=>row.accountId);
  for (const account of context.accounts) {
    if (!account.active || account.openingOn>context.today) continue;
    const balance=context.balances.get(account.id) ?? 0;
    if (account.minimumMinor!=null && balance<account.minimumMinor) add('cash_below_minimum','cash_account',account.id,{reason:'El saldo efectivo de la cuenta está por debajo del mínimo configurado.',amountMinor:balance,minimumMinor:account.minimumMinor},account.responsibleId);
    if (account.type!=='cash') continue;
    const closings=closingsByAccount.get(account.id) || [];
    for (const closing of closings) if (closing.state==='closed' && account.toleranceMinor!=null && Math.abs(closing.differenceMinor)>account.toleranceMinor) {
      add('cash_difference','cash_closing',closing.id,{reason:`El cierre del ${closing.closingOn} supera la tolerancia explícita; no se ajustó el saldo automáticamente.`,amountMinor:closing.differenceMinor,toleranceMinor:account.toleranceMinor,closingOn:closing.closingOn},account.responsibleId);
    }
    if (account.closingEnabled && account.closingTime) {
      const dueToday=Date.parse(`${context.today}T${account.closingTime}:00-05:00`)<context.nowMs;
      const dueOn=dueToday?context.today:addDays(context.today,-1);
      const closed=closings.filter(row=>row.state==='closed').sort((a,b)=>b.closingOn.localeCompare(a.closingOn))[0];
      const reopened=closings.filter(row=>row.state==='reopened' && row.closingOn<=dueOn).sort((a,b)=>a.closingOn.localeCompare(b.closingOn))[0];
      if (dueOn>=account.openingOn && (!closed || closed.closingOn<dueOn || reopened)) add('cash_close_missing','cash_account',account.id,{reason:reopened?`El cierre del ${reopened.closingOn} fue reabierto y requiere un nuevo cierre.`:`Ya venció la hora local de cierre (${account.closingTime}, Bogotá) del ${dueOn}.`,dueOn,closingTime:account.closingTime,reopenedClosingId:reopened?.id || null},account.responsibleId);
    }
  }
  for (const order of context.orders) {
    if ((order.items || []).some(line=>line.unitCostMinor==null || (line.components || []).some(component=>component.unitCostMinor==null))) lack('order',order.id,'product_cost_unknown','Completa los costos históricos del pedido; el resultado registrado sigue siendo parcial.',order.sellerId);
    if (!order.placedOn || order.policyReviewRequired || order.legacyPolicyReview || !order.ruleSnapshot) lack('order',order.id,'sale_policy_unknown','Confirma la fecha comercial y la política histórica para reconocer la venta.',order.sellerId);
    if (order.ruleSnapshot?.commission?.enabled && !order.sellerId && (order.items || []).some(line=>line.quantity*line.unitPriceMinor-line.discountMinor>0)) lack('order',order.id,'commission_seller_unknown','Asigna el vendedor que requiere la regla de comisión; el administrador que guarda no se usa como vendedor.');
    if (order.legacyFinancialReview?.required && !['resolved','reconciled'].includes(order.legacyFinancialReview.state)) lack('order',order.id,'legacy_payment_review','Concilia el pago histórico; no equivale a una entrada de caja.',order.sellerId);
  }
  for (const collection of collections) if (!collection.reversalOf && !reversedCollections.has(collection.id) && collection.holder==='legacy' && collection.requiresReconciliation!==false) lack('collection',collection.id,'legacy_payment_review','Concilia el cobro histórico sin inventar caja ni fecha de recaudo.',context.ordersById.get(collection.orderId)?.sellerId);
  for (const expense of context.expenses) if (!expense.incurredOn) lack('expense',expense.id,'expense_date_unknown','Completa la fecha real de ocurrencia del gasto; no se asigna al período de carga.',expense.personId || context.ordersById.get(expense.orderId)?.sellerId);
  for (const returned of context.returns) if ((returned.lines || []).some(line=>line.condition==='recoverable' && line.recoveredCostMinor==null)) lack('order',returned.orderId,'return_cost_unknown','Completa el costo histórico para conocer la recuperación de la devolución.',context.ordersById.get(returned.orderId)?.sellerId);
  for (const value of missing.values()) {
    const reasons=[...value.reasons].sort(([a],[b])=>a.localeCompare(b));
    add('business_data_missing',value.type,value.id,{reason:reasons.map(([,reason])=>reason).join(' '),count:reasons.length,missing:reasons.map(([code])=>code)},value.responsibleId);
  }
  return {conditions,effective};
}

async function persistAlertCondition(store,context,rule,condition,{lease,clock}) {
  return store.transaction(async tx=>{
    await tx.lockWrites();
    if (lease) await assertLease(tx,{...lease,now:clock()});
    const revision=Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
    const currentRule=await tx.db.get(`SELECT version FROM ${tx.t('alert_rules')} WHERE id=?`,[rule.id]);
    if (revision!==context.revision || currentRule?.version!==rule.version) return {stale:true};
    const rows=(await tx.db.all(`SELECT * FROM ${tx.t('alerts')} WHERE rule_id=? AND entity_type=? AND entity_id=? ORDER BY episode`,[rule.id,condition.entityType,condition.entityId])).map(decode);
    const result={evaluated:1,opened:0,updated:0,resolved:0};
    // A late evaluator must never roll back a more recent evaluator's observation.
    if (rows.some(row=>row.lastSeenAt>context.now)) return result;
    const wanted=condition.occurrences.filter(value=>!value.test || value.test(rule));
    const activeKeys=new Set(wanted.filter(value=>value.active).map(value=>value.key || 'condition'));
    const resolve=async (row,code)=>{
      if (row.state==='resolved') return;
      const data={...JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('alerts')} WHERE id=?`,[row.id])).data),resolvedAt:context.now,resolutionCode:code,
        resolutionReason:code==='rule_disabled'?'La regla fue desactivada; no confirma que el problema comercial se haya corregido.':'La condición dejó de estar confirmada por los hechos y la configuración actuales.'};
      await tx.db.run(`UPDATE ${tx.t('alerts')} SET state='resolved',last_seen_at=?,data=?,version=version+1,updated_at=? WHERE id=?`,[context.now,JSON.stringify(data),context.now,row.id]);
      row.state='resolved';result.resolved++;
    };
    for (const row of rows) if (!activeKeys.has(row.occurrenceKey || 'condition')) await resolve(row,rule.enabled?'condition_not_confirmed':'rule_disabled');
    for (const occurrence of wanted) {
      const occurrenceKey=occurrence.key || 'condition',matches=rows.filter(row=>(row.occurrenceKey || 'condition')===occurrenceKey);
      let row=matches.find(row=>row.state!=='resolved');
      if (!occurrence.active && matches.length) {for (const old of matches) await resolve(old,'condition_not_confirmed');continue;}
      const responsibleId=row?.responsibleOverride===true ? row.responsibleOverrideId ?? null : rule.responsibleId || condition.responsibleId || context.settings.alertDefaults?.responsibleId || null;
      const reminderHours=rule.reminderHours ?? context.settings.alertDefaults?.reminderHours ?? 24;
      const nextReminderAt=new Date(context.nowMs+reminderHours*HOUR_MS).toISOString();
      const evidence={...occurrence.data,occurrenceKey,severity:rule.type==='business_data_missing' || occurrence.data.status==='unknown'?'info':'warning'};
      if (!row) {
        const episode=(rows.at(-1)?.episode || 0)+1,id=newId();
        const data={...evidence,...(occurrence.active?{lastReminderAt:context.now,nextReminderAt,reminderCount:0}:{resolvedAt:context.now,resolutionCode:'condition_not_confirmed'})};
        await insertRow(tx,'alerts',{id,rule_id:rule.id,entity_type:condition.entityType,entity_id:condition.entityId,episode,state:occurrence.active?'open':'resolved',severity:evidence.severity,
          first_seen_at:context.now,last_seen_at:context.now,responsible_id:responsibleId,data:JSON.stringify(data),version:1,created_at:context.now,updated_at:context.now});
        rows.push({...data,id,episode,state:occurrence.active?'open':'resolved',responsibleId});result.opened++;
        if (!occurrence.active) result.resolved++;
        continue;
      }
      const raw=JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('alerts')} WHERE id=?`,[row.id])).data);
      const reminderDue=!raw.nextReminderAt || raw.nextReminderAt<=context.now;
      const changed=Object.entries(evidence).some(([key,value])=>canonicalJSON(raw[key] ?? null)!==canonicalJSON(value));
      if (changed || reminderDue || row.responsibleId!==responsibleId) {
        const data={...raw,...evidence,...(reminderDue?{lastReminderAt:context.now,nextReminderAt,reminderCount:(raw.reminderCount || 0)+1}:{})};
        await tx.db.run(`UPDATE ${tx.t('alerts')} SET severity=?,responsible_id=?,last_seen_at=?,data=?,version=version+1,updated_at=? WHERE id=?`,[evidence.severity,responsibleId,context.now,JSON.stringify(data),context.now,row.id]);
        result.updated++;
      }
    }
    if (lease) await assertLease(tx,{...lease,now:clock()});
    return result;
  });
}

/** Read projections outside write locks; serialize only each entity's episode changes. */
export async function evaluateAlerts(store,{now=new Date(),lease=null,clock=null}={}) {
  now=instant(now instanceof Date?now.toISOString():now);
  clock=clock || jobClock(now);
  const context=await alertFacts(store,now),{conditions,effective}=alertConditions(context);
  const result={evaluated:0,opened:0,updated:0,resolved:0,stale:false};
  for (const rule of context.rules) {
    const candidates=rule.enabled?new Map(conditions.get(rule.type)):new Map();
    if (rule.enabled && rule.type==='shipment_incident') for (const shipment of context.shipments) {
      const occurrences=incidentOccurrences(effective.get(shipment.id) || [],new Set(rule.selectedStatuses || ['incident','return_in_transit']));
      if (occurrences.length) candidates.set(`shipment:${shipment.id}`,{entityType:'shipment',entityId:shipment.id,responsibleId:context.ordersById.get(shipment.orderId)?.sellerId || null,
        occurrences:occurrences.map(value=>({key:value.key,active:!value.end,data:{title:TITLES.shipment_incident,reason:value.latest.detail || value.latest.rawStatus || 'El envío tiene un estado seleccionado como novedad en la regla.',
          startEventId:value.start.id,lastEventId:value.latest.id,endEventId:value.end?.id || null,status:value.latest.status}}))});
    }
    for (const row of context.existing) if (row.rule_id===rule.id && !candidates.has(`${row.entity_type}:${row.entity_id}`)) candidates.set(`${row.entity_type}:${row.entity_id}`,{entityType:row.entity_type,entityId:row.entity_id,responsibleId:null,occurrences:[]});
    for (const condition of candidates.values()) {
      const saved=await persistAlertCondition(store,context,rule,condition,{lease,clock});
      if (saved.stale) {result.stale=true;return result;}
      for (const field of ['evaluated','opened','updated','resolved']) result[field]+=saved[field];
    }
  }
  return result;
}
