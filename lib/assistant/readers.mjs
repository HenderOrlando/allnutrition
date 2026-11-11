import { fail, integer, text } from '../validation-core.mjs';
import { schemas, settingsFields, contentStates, orderStates, paymentStates } from '../schema.mjs';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { pageOrders } from '../business/orders.mjs';
import { pageShipments, getShipment, SHIPMENT_STATUSES } from '../business/shipments.mjs';
import { financeOverviewTx, financeQuery } from '../business/finance.mjs';
import { preparePayroll } from '../business/payroll.mjs';
import { getCashClosingPreview } from '../business/cash.mjs';
import { buildBusinessReportTx, listReportSnapshots, getReportSnapshot, normalizeReportQuery } from '../business/reports.mjs';
import { reportClientData, liveReportClientData, reportRequestQuery } from '../business/report-export.mjs';
import { dashboardComparisonTx } from '../business/dashboard.mjs';
import { buildInsights, INSIGHT_ISSUES } from '../business/insights.mjs';
import { getBusinessSettings, listResources, getResource, ALERT_TYPES } from '../business/settings.mjs';
import { pageAlerts, getAlert, listAlertRules, getAlertRule } from '../business/alerts.mjs';
import { listImportBatches, getImportBatch } from '../business/imports.mjs';
import { listSocialCampaigns, getSocialCampaign, listSocialConnections, SOCIAL_OBJECTIVES, SOCIAL_CAMPAIGN_STATES } from '../business/social.mjs';
import { getSocialResults } from '../business/social-metrics.mjs';
import { getSocialBusinessResult } from '../business/social-links.mjs';
import { listSocialAssets } from '../business/social-media.mjs';
import { readSocialAnalysis } from '../business/social-analysis.mjs';
import { listAssistantGuideTasks, getAssistantGuide } from './guide.mjs';
import { createAssistantEvidence } from './evidence.mjs';
import { BUSINESS_PERIODS } from '../business/dates.mjs';

// Provider-facing documentation only; the domain readers remain the validators.
export const assistantBusinessQueryGuide = Object.freeze({
  syntax:'JSON objeto serializado como string; ?=opcional. Ramas excluyentes, ninguna clave extra. Solo lectura. Omitir filtros=todos salvo default indicado.',
  types:'id=string100 obtenido del reader; social=UUID; stringN/textN=maxN caracteres; date=YYYY-MM-DD; instant=ISO hora+zona; minor=entero>=0 centavos COP. page=entero1..100000 default1; listas20; q default vacío. No inventar datos ausentes.',
  enums:{
    catalogKind:Object.keys(schemas).join('|'),
    contentStatus:contentStates.map(row=>row.value).join('|'),
    orderStatus:orderStates.map(row=>row.value).join('|'),
    paymentStatus:paymentStates.map(row=>row.value).join('|'),
    shipmentStatus:SHIPMENT_STATUSES.join('|'),
    period:BUSINESS_PERIODS.join('|'),
    metric:'netProductSales|shippingRevenue|costOfGoods|giftCost|shippingCosts|platformFees|commissions|fixedSalary|bonuses|advertisingExpenses|operatingExpenses|otherExpenses|grossMargin|contribution|operatingResult|cashAvailable|onTimeDeliveries|shipmentReturnRate|recognizedOrders|soldUnits|giftUnits|returnedUnits|cancelledUnits|customerCollections|platformPending|payrollEarned|payrollPaid|payrollOutstanding|shipmentCount|shippedOrders|transitDays|cashClosingDifference',
    reportIssue:[...INSIGHT_ISSUES,'comparison_elapsed'].join('|'),
    alertType:ALERT_TYPES.join('|'),
    objective:SOCIAL_OBJECTIVES.join('|'),
    campaignStatus:SOCIAL_CAMPAIGN_STATES.join('|'),
  },
  catalog:{
    list:'{kind?:catalogKind,q?:text100,status?:contentStatus,page?}; default todos, incluidos draft.',
    detail:'{kind:catalogKind,id:id}.',
  },
  orders:{
    list:'{page?,q?:text100,status?:orderStatus,paymentStatus?:paymentStatus,seller?:id,product?:id,platform?:id,source?:id,carrier?:string150,issue?:incident|pending_settlement|missing_data|missing_cost|legacy_review,lookup?:identity}.',
    identity:'lookup:identity exige q=número AN-... o guía exacta; sin lookup búsqueda general.',
    detail:'{id:id}; incluye líneas/cobros/envíos, sin contacto.',
  },
  shipments:{
    list:'{page?,q?:text100,status?:shipmentStatus,carrier?:string200,orderId?:id,sourceId?:id,platformId?:id,issue?:orphan|incident|missing_data}.',
    detail:'{id:id}; eventos/corte guardados.',
  },
  cash:{
    overview:'{kind?:query,resource?:overview,asOf?:date,page?}; default overview/hoy Bogotá.',
    lists:'{kind?:query,resource:movements|settlements|expenses|payroll|closings,page?,q?:text100,startDate?:date,endDateExclusive?:date,...filtros}. Filtros SOLO por recurso: movements={account?:id}; settlements={source?:id,status?:text100}; expenses={person?:id,category?:text100}; payroll={person?:id,status?:text100}; closings={account?:id,status?:text100}. Fin excluyente.',
    detail:'{kind?:query,resource:movements|settlements|expenses|payroll|closings,record:id}.',
    payroll:'{kind:payroll-preview,personId:id,startOn:date,endOnExclusive:date,bonusMinor?:minor,discountMinor?:minor,reason?:string1000}; ajustes default0, motivo requerido si no0. Período existente devuelve ajustes guardados sin reaplicarlos.',
    closing:'{kind:closing-preview,accountId:id,closingOn:date}; exige cuenta cash, no bank.',
  },
  reports:{
    live:'{mode?:live,period?:period,anchor?:date,filters?:reportFilters,page?,metric?:metric,issue?:reportIssue}; default live/month/hoy Bogotá. Sin metric pagina métricas; con metric hechos.',
    snapshot:'{mode:snapshot,snapshotId:id,page?,metric?:metric,issue?:reportIssue}; corte guardado.',
    list:'{mode:list,period?:period,anchor?:date,filters?:reportFilters,page?}; sin selección todas las copias; anchor/filters seleccionan identidad (period default month).',
    reportFilters:'{seller?:id,product?:id,platform?:id,carrier?:string150,status?:orderStatus|shipmentStatus,account?:id,source?:id}.',
    issue:'Requiere metric correspondiente; comparison_elapsed SOLO live/días completos.',
  },
  recommendations:'{period?:period,anchor?:date,filters?:reportFilters,page?}; default month/hoy. reportFilters de reports. summary.notes=insuficiencia; stock/social son selecciones actuales, no totales del período.',
  business:{
    settings:'{resource?:settings} o {resource:storefront}; default settings=reglas, storefront=vitrina.',
    list:'{resource:people|platforms|sources|accounts|profiles,page?,active?:boolean,source?:id,platform?:id}; active NO profiles; source SOLO profiles; platform SOLO sources.',
    detail:'{resource:people|platforms|sources|accounts|profiles,id:id}; people incluye salaryAgreements/commissionOverrides.',
  },
  alerts:{
    list:'{kind?:alerts,state?:active|open|acknowledged|resolved|all,severity?:critical|warning|info,type?:alertType,person?:id,page?}; default alerts/active; person=responsable.',
    detail:'{kind?:alerts,id:id}.',
    rules:'{kind:rules,page?} o {kind:rules,id:id}.',
  },
  imports:{
    list:'{page?,source?:id,state?:uploaded|previewing|review|queued|applying|completed|completed_with_errors|failed|expired|cancelled}.',
    detail:'{id:id,page?,state?:pending|new|updated|unchanged|conflict|rejected|ready|skipped|applied,q?:text100,sheet?:string,rowNumber?:integer1..10001}; state=fila; rowNumber exige sheet exacta. Sin bytes.',
  },
  advertising:{
    list:'{kind?:campaigns,page?,q?:string200,mode?:organic|paid,objective?:objective,status?:campaignStatus,network?:facebook|instagram}; default campaigns.',
    detail:'{kind:campaign,id:UUID}.',
    results:'{kind:results,campaignId?:UUID,deliveryId?:UUID,integrationMethod?:api|browser,scope?:paid|organic|mixed,dimension?:aggregate|daily|placement|age_gender|country,asOf?:instant,page?,from?:date,to?:date}; page hasta1000000; from/to inclusivos, from<=to; asOf default ahora. Página de entregas; alcance no sumable.',
    business:'{kind:business-result,campaignId:UUID,asOf?:instant}; default ahora.',
    analysis:'{kind:analysis,campaignId:UUID,asOf?:instant}; default ahora; persistido/freshness, nunca encola.',
    assets:'{kind:assets,page?,state?:uploading|processing|ready|failed|archived|missing_file}.',
    connections:'{kind:connections,page?}; solo estado.',
  },
  access:'{page?}; solo identificador/estado administrativo.',
  application:'{page?} lista tareas; {taskId:id} obtiene guía. taskId/step IDs SOLO devueltos por reader.',
});

const PAGE_SIZE = 20;
const scalar = value => value === null || ['string','number','boolean'].includes(typeof value);
const pick = (row, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(row || {},key) && scalar(row[key])).map(key => [key,row[key]]));
const page = value => integer(Number(value ?? 1), 'Página', 1, 100000);
const id = (value, label = 'Registro') => text(value,label,100,true);
const hrefFor = view => adminHref(readAdminView(view));
const precision = value => !value ? 'unknown' : /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : 'instant';
function queryObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('Consulta del asistente no válida.');
  return value;
}
function only(query, allowed) {
  for (const key of Object.keys(query)) if (!allowed.includes(key)) fail(`Filtro no permitido: ${key}.`);
}
function exclusiveDetail(query, key, extra = []) { if (query[key] != null) only(query,[key,...extra]); }
function choice(value, allowed, label) { if (value !== undefined && !allowed.includes(value)) fail(`${label}: opción no válida.`); }
function money(value,currency='COP') {
  if (value == null) return null;
  if (!Number.isSafeInteger(value)) return `${(value/100).toLocaleString('es-CO',{maximumFractionDigits:6})} ${currency}`;
  const amount=BigInt(value),absolute=amount<0n?-amount:amount;
  return `${amount<0n?'-':''}${(absolute/100n).toLocaleString('es-CO')},${String(absolute%100n).padStart(2,'0')} ${currency}`;
}
const pesos = value => value == null ? null : `${Number(value).toLocaleString('es-CO',{maximumFractionDigits:0})} COP`;
const reasons = values => (values || []).map(value => typeof value === 'string' ? value : value.label || value.reason || value.code || 'dato_excluido');
function coverage(value = {}) {
  return {state:value.complete === true ? 'complete' : value.complete === false ? 'partial' : 'unknown',knownCount:value.knownCount ?? null,eligibleCount:value.eligibleCount ?? null,excludedCount:value.excludedCount ?? null,reasons:reasons(value.exclusionReasons || value.reasons).slice(0,30).map(value=>value.slice(0,300))};
}
// Existing readers can compose over the already-open snapshot, but cannot open
// transactions, enqueue jobs, or reach the underlying writer through this facade.
function snapshotFacade(tx) {
  const db = {get:(...args)=>tx.db.get(...args),all:(...args)=>tx.db.all(...args)};
  const facade = {provider:tx.provider,db,t:(...args)=>tx.t(...args),readSnapshot:fn=>fn(facade)};
  for (const method of ['get','list','order','settings']) if (typeof tx[method] === 'function') facade[method]=tx[method].bind(tx);
  return facade;
}
// Bound oversized stored fields/collections before they enter the model. The
// summary records every cut; no partial selection is described as the universe.
function bounded(value, path, cuts) {
  if (typeof value === 'string') { if (value.length>2000) {cuts.push(path);return value.slice(0,2000);} return value; }
  if (Array.isArray(value)) { if (value.length>20) cuts.push(path);return value.slice(0,20).map((item,index)=>bounded(item,`${path}.${index}`,cuts)); }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,bounded(item,`${path}.${key}`,cuts)]));
  return value;
}
const labels={title:'Nombre',name:'Nombre',number:'Número de pedido',status:'Estado',state:'Estado',price:'Precio',description:'Descripción',balanceMinor:'Saldo de cuenta',totalMinor:'Total acordado',dueMinor:'Saldo por cobrar',availableMinor:'Disponible consolidado'};
function evidenceFor(domain, records, view, {asOf=null,sourceCoverage=null,truncatedFields=[],units={}}={}) {
  const evidence=[];
  for (const [index,record] of records.entries()) {
    const href=hrefFor(typeof view==='function'?view(record):view);
    const cut=asOf || (domain==='shipments'?record.sourceAsOf:record.dataAsOf || record.updatedAt) || null;
    const walk=(value,path)=>{
      if (scalar(value)) {
        if (path.length>100 || /(?:^|\.)(?:id|version|href|actionLabel|evidenceIds)$/.test(path)) return;
        const key=path.split('.').at(-1),unit=units[path]||units[key]||(key.endsWith('Minor')?'minor':key==='price'?'COP':null);
        const truncated=truncatedFields.includes(`records.${index}.${path}`);
        const fieldCoverage=truncated?{...(sourceCoverage||coverage()),state:'partial',reasons:[...(sourceCoverage?.reasons||[]),'field_truncated']}:sourceCoverage;
        evidence.push(createAssistantEvidence({domain,entityId:record.id??record.campaignId??null,recordVersion:record.version??null,field:path,label:labels[key]||key,value,unit,formattedValue:unit==='minor'?money(value,record.currency||(domain==='advertising'?'moneda no informada':'COP')):unit==='COP'?pesos(value):unit==='bps'&&value!==null?`${value/100}%`:null,asOf:cut,asOfPrecision:precision(cut),coverage:fieldCoverage,href}));
      } else if(Array.isArray(value)) value.forEach((item,index)=>walk(item,`${path}.${index}`));
      else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) walk(item,path?`${path}.${key}`:key);
    };
    walk(record,'');
  }
  return evidence;
}
function result(domain, rawRecords, summary, pagination, view, options={}) {
  const cuts=[],records=bounded(rawRecords,'records',cuts),safeSummary=bounded(summary,'summary',cuts);
  const currentPage=pagination?.page??1,total=pagination && Object.hasOwn(pagination,'total')?pagination.total:records.length,pageSize=pagination?.pageSize??PAGE_SIZE;
  const evidence=evidenceFor(domain,records,view,{...options,truncatedFields:cuts});
  const evidenceTruncated=Math.max(0,evidence.length-200);
  return {records,summary:{...safeSummary,complete:cuts.length===0&&!evidenceTruncated&&(summary.complete??true)&&total!==null&&total<=records.length,truncatedFields:cuts,evidenceTruncated},pagination:{page:currentPage,pageSize,total,hasMore:pagination?.hasMore??(total===null?records.length===pageSize:currentPage*pageSize<total)},evidence:evidence.slice(0,200)};
}
function setEvidence(output,evidence,limit=200) {
  const byId=new Map(evidence.map(item=>[item.id,item]));
  const primary=output.records.flatMap(row=>row.evidenceIds?.length?[byId.get(row.evidenceIds.at(-1))].filter(Boolean):[]);
  const unique=[...new Map([...primary,...byId.values()].map(item=>[item.id,item])).values()];
  output.evidence=unique.slice(0,limit);
  const known=new Set(output.evidence.map(item=>item.id));
  for(const row of output.records)if(row.evidenceIds)row.evidenceIds=row.evidenceIds.filter(id=>known.has(id));
  output.summary.evidenceTruncated=Math.max(0,unique.length-limit);
  if(output.summary.evidenceTruncated)output.summary.complete=false;
  return output;
}
function slice(rows,currentPage) { return rows.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE); }
const baseFields=['id','version','createdAt','updatedAt'];
const lineFields=['lineId','itemId','kind','title','presentation','quantity','unitPriceMinor','discountMinor','unitCostMinor','totalMinor'];
const eventFields=['id','version','status','occurredOn','occurredAt','sourceAsOf','correctionOf','reason'];
const financialFields=[...baseFields,'accountId','personId','sourceId','orderId','shipmentId','state','kind','category','concept','name','effectiveOn','occurredOn','reportedOn','incurredOn','startOn','endOnExclusive','closingOn','amountMinor','balanceMinor','netMinor','grossMinor','earnedMinor','paidMinor','offsetMinor','bonusMinor','discountMinor','reason','outstandingMinor','outstandingNetMinor','receivedNetMinor','creditMinor','availableCreditMinor','advanceAvailableMinor','advanceToApplyMinor','advanceAppliedMinor','amountToPayMinor','expectedMinor','countedMinor','differenceMinor','missingDayCount','accountName','personName','sourceName','reversalOf','documentType','documentId','documentVersion'];
function financialRecord(row) {
  const value=pick(row,financialFields);
  for(const key of ['lines','payments','activePayments','obligations','advances','carriedCredits','missingAccruals','receipts']) if(Array.isArray(row[key])) value[key]=row[key].map(item=>pick(item,[...financialFields,'collectionId','expenseId','quantity','allocatedMinor','availableMinor']));
  return value;
}

async function catalog(tx, query) {
  only(query,['kind','id','q','status','page']);
  choice(query.status,contentStates.map(state=>state.value),'Estado de contenido');
  if(query.id) {only(query,['kind','id']);if(!query.kind)fail('Selecciona el tipo del registro.');}
  const kinds=query.kind?[query.kind]:Object.keys(schemas);
  if(kinds.some(kind=>!Object.hasOwn(schemas,kind)))fail('Tipo de catálogo no válido.');
  const p=page(query.page),q=text(query.q??'','Búsqueda',100).toLocaleLowerCase('es'),rows=[];
  for(const kind of kinds) {
    const source=query.id?[await tx.get(kind,id(query.id))].filter(Boolean):await tx.list(kind);
    for(const row of source) {
      if(query.status && row.status!==query.status)continue;
      const record={...pick(row,[...baseFields,...schemas[kind].fields.filter(field=>field.type!=='image').map(field=>field.name),'stockReserved','stockAvailable','availability']),kind};
      if(row.catalogIds)record.catalogIds=row.catalogIds.filter(value=>typeof value==='string');
      if(row.items)record.items=row.items.map(item=>pick(item,['productId','quantity','unitCostMinor']));
      if(!q || JSON.stringify(record).toLocaleLowerCase('es').includes(q)) rows.push(record);
    }
  }
  rows.sort((a,b)=>(a.title||'').localeCompare(b.title||'','es')||a.id.localeCompare(b.id));
  return result('catalog',slice(rows,p),{count:rows.length},{page:p,total:rows.length},row=>({section:row.kind,record:row.id}));
}
async function orders(tx,query) {
  only(query,['id','page','q','status','paymentStatus','seller','product','platform','source','carrier','issue','lookup']);
  exclusiveDetail(query,'id');
  choice(query.status,orderStates.map(state=>state.value),'Estado de pedido');
  choice(query.paymentStatus,paymentStates.map(state=>state.value),'Estado de cobro');
  choice(query.lookup,['identity'],'Búsqueda');
  if(query.lookup && !text(query.q??'','Identidad',100))fail('Escribe el número del pedido o la guía exacta.');
  const data=query.id?{records:[await tx.order(id(query.id))].filter(Boolean),page:1,pageSize:20}:await pageOrders(tx,{...query,page:page(query.page)});
  const records=data.records.map(row=>{
    const record=pick(row,[...baseFields,'number','status','placedOn','totalMinor','sellerId','shippingMinor','shippingChargeMinor']);
    record.paymentState=row.paymentSummary?.status??null;
    record.collectedMinor=row.paymentSummary?.netCollectedMinor??null;
    record.dueMinor=row.paymentSummary?.outstandingMinor??null;
    record.shipments=(row.shipments||[]).map(item=>pick(item,[...baseFields,'orderId','status','carrier','tracking','platformId','sourceId']));
    if(query.id) {
      record.items=(row.items||[]).map(item=>({...pick(item,lineFields),components:(item.components||[]).map(component=>pick(component,['productId','title','quantity','unitCostMinor']))}));
      for(const key of ['collections','returns','expenses'])if(row[key])record[key]=row[key].map(financialRecord);
    }
    return record;
  });
  return result('orders',records,{count:data.total??records.length},{...data,total:data.total??records.length},row=>({section:'orders',record:row.id}));
}
async function shipments(tx,query) {
  only(query,['id','page','q','status','carrier','orderId','sourceId','platformId','issue']);exclusiveDetail(query,'id');
  const data=query.id?{records:[await getShipment(tx,id(query.id))],page:1}:await pageShipments(tx,{...query,page:page(query.page)});
  const records=data.records.map(row=>{
    const value=pick(row,[...baseFields,'orderId','orderNumber','platformId','platformName','sourceId','sourceName','status','carrier','tracking','estimatedDeliveryOn','sourceAsOf','knownEventOn','knownEventAt','costStatus']);
    if(query.id){value.events=(row.events||[]).map(item=>pick(item,eventFields));value.assignments=(row.assignments||[]).map(item=>pick(item,['lineId','quantity']));value.orderLines=(row.orderLines||[]).map(item=>pick(item,['lineId','title','presentation','quantity']));}
    return value;
  });
  return result('shipments',records,{count:data.total??records.length},{...data,total:data.total??records.length},row=>({section:'orders',tab:'shipments',record:row.id}));
}
async function cash(tx,query,session) {
  if(query.kind==='payroll-preview') {
    only(query,['kind','personId','startOn','endOnExclusive','bonusMinor','discountMinor','reason']);
    const input={personId:id(query.personId,'Persona'),startOn:query.startOn,endOnExclusive:query.endOnExclusive};
    const bonusMinor=integer(query.bonusMinor??0,'Bonificación',0),discountMinor=integer(query.discountMinor??0,'Descuento',0),reason=text(query.reason??'','Motivo',1000);
    const preview=await preparePayroll(tx,{...input,bonusMinor,discountMinor,reason},session.user.id);
    return result('cash',[financialRecord(preview)],{preview:true,committable:false,requestedAdjustments:{bonusMinor,discountMinor,reason},adjustmentsIncluded:true,adjustments:{bonusMinor:preview.bonusMinor??0,discountMinor:preview.discountMinor??0,reason:preview.reason??''},existingPeriod:preview.id!==null},{total:1},{section:'cash',tab:'payroll'});
  }
  if(query.kind==='closing-preview') {
    only(query,['kind','accountId','closingOn']);
    const preview=await getCashClosingPreview(tx,{accountId:query.accountId,closingOn:query.closingOn});
    return result('cash',[financialRecord(preview)],{preview:true,committable:false},{total:1},{section:'cash',tab:'overview',account:preview.accountId},{asOf:preview.closingOn});
  }
  choice(query.kind,['query'],'Consulta de caja');
  const resource=query.resource||'overview';
  choice(resource,['overview','movements','settlements','expenses','payroll','closings'],'Recurso de caja');
  if(resource==='overview') {
    only(query,['kind','resource','asOf','page']);
    const overview=await financeOverviewTx(tx,query.asOf?{asOf:query.asOf}:{}),p=page(query.page);
    const records=slice(overview.accounts,p).map(row=>pick(row,[...baseFields,'name','type','active','responsibleId','responsibleName','balanceMinor']));
    const summary=pick(overview,['asOf','availableMinor','platformPendingMinor','expensesOutstandingMinor','expenseCreditsMinor','payrollOutstandingMinor','unassignedDateExpenses']);
    const output=result('cash',records,{...summary,count:overview.accounts.length},{page:p,total:overview.accounts.length},row=>({section:'cash',tab:'overview',account:row.id}),{asOf:overview.asOf});
    for(const key of ['availableMinor','platformPendingMinor','expensesOutstandingMinor','expenseCreditsMinor','payrollOutstandingMinor'])output.evidence.push(createAssistantEvidence({domain:'cash',field:key,label:labels[key]||key,value:overview[key],unit:'minor',formattedValue:money(overview[key]),asOf:overview.asOf,asOfPrecision:'date',href:hrefFor({section:'cash',tab:'overview'})}));
    return setEvidence(output,output.evidence);
  }
  const filters={movements:['account'],settlements:['source','status'],expenses:['person','category'],payroll:['person','status'],closings:['account','status']}[resource];
  only(query,['kind','resource','page','record','q','startDate','endDateExclusive',...filters]);
  if(query.record)only(query,['kind','resource','record']);
  const {kind,resource:ignored,...input}=query;
  const data=await financeQuery(tx,resource,{...input,page:page(query.page)}),rows=data.records||[data];
  return result('cash',rows.map(financialRecord),{count:data.total??rows.length},{page:data.page??1,total:data.total??rows.length,pageSize:data.pageSize??20},row=>({section:'cash',tab:resource,record:row.id}));
}
const resourceFields={people:[...baseFields,'name','active','role','seller','responsible'],platforms:[...baseFields,'name','active','type'],sources:[...baseFields,'name','platformId','active'],accounts:[...baseFields,'name','type','active','responsibleId','openingOn','openingBalanceMinor'],profiles:[...baseFields,'name','sourceId','formatVersion']};
const agreementFields=['id','enabled','effectiveOn','effectiveFrom','effectiveTo','amountPerPeriodMinor','frequency','payDayOffset','rateBps','fixedMinor','basis','earnWhen','mode'];
function businessSettings(row) {
  if(!row)return null;
  return {...pick(row,[...baseFields,'currency','timeZone','setupCompleted','reportsStartOn','reportGenerationTime','defaultReceiptAccountId','defaultPaymentAccountId']),id:String(row.id),reportPeriods:row.reportPeriods||[],rulesVersions:(row.rulesVersions||[]).map(rule=>({...pick(rule,['id','effectiveOn','saleRecognition','shippingExpenseDate','returnExpenseDate','platformFeeExpenseDate']),commission:pick(rule.commission,agreementFields)})),alertDefaults:pick(row.alertDefaults,['responsibleId'])};
}
async function business(tx,query) {
  only(query,['resource','id','active','source','platform','page']);
  const resource=query.resource||'settings',p=page(query.page);
  if(resource==='settings'||resource==='storefront') {
    only(query,['resource']);
    const record=resource==='settings'?businessSettings(await getBusinessSettings(tx)):pick(await tx.settings(),['version',...settingsFields.map(field=>field.name)]);
    return result('business',record?[record]:[],{count:record?1:0},{total:record?1:0},{section:resource==='settings'?'business':'settings',...(resource==='settings'?{tab:'setup'}:{})});
  }
  if(!Object.hasOwn(resourceFields,resource))fail('Recurso de negocio no disponible.');
  if(query.active!==undefined&&typeof query.active!=='boolean')fail('Filtro activo no válido.');
  if(query.source!==undefined&&resource!=='profiles'||query.platform!==undefined&&resource!=='sources'||query.active!==undefined&&resource==='profiles')fail('Filtro no válido para este recurso.');
  if(query.id)only(query,['resource','id']);
  let rows=query.id?[await getResource(tx,resource,id(query.id))].filter(Boolean):await listResources(tx,resource,{source:query.source? id(query.source):undefined,platform:query.platform?id(query.platform):undefined,active:query.active===true});
  if(query.active===false)rows=rows.filter(row=>row.active===false);
  const records=slice(rows,p).map(row=>{
    const value=pick(row,resourceFields[resource]);
    if(resource==='people'&&query.id)for(const key of ['salaryAgreements','commissionOverrides'])value[key]=(row[key]||[]).map(item=>pick(item,agreementFields));
    if(resource==='profiles')value.sheets=importSheets(row.sheets);
    return value;
  });
  return result('business',records,{count:rows.length},{page:p,total:rows.length},row=>({section:'business',tab:resource==='profiles'||resource==='sources'?'platforms':resource,record:row.id}));
}
const alertFields=[...baseFields,'ruleId','type','entityType','entityId','state','severity','firstSeenAt','lastSeenAt','responsibleId','responsibleName','title','reason','count','amountMinor'];
async function alerts(tx,query) {
  const kind=query.kind||'alerts';choice(kind,['alerts','rules'],'Consulta de alertas');
  if(kind==='rules') {
    only(query,['kind','id','page']);exclusiveDetail(query,'id',['kind']);
    const rows=query.id?[await getAlertRule(tx,id(query.id))]:(await listAlertRules(tx)).records,p=page(query.page);
    const records=slice(rows,p).map(row=>({...pick(row,[...baseFields,'type','enabled','responsibleId','scopeKey','reminderHours']),selectedStatuses:row.selectedStatuses||[],thresholds:pick(row.thresholds,['amount','unit','hours','days'])}));
    return result('alerts',records,{count:rows.length},{page:p,total:rows.length},{section:'business',tab:'alerts'});
  }
  only(query,['kind','id','state','severity','type','person','page']);exclusiveDetail(query,'id',['kind']);
  const data=query.id?{records:[await getAlert(tx,id(query.id))],page:1}:await pageAlerts(tx,{state:query.state,severity:query.severity,type:query.type,responsible:query.person,page:page(query.page)});
  const records=data.records.map(row=>({...pick(row,alertFields),action:row.action?{label:row.action.label,href:row.action.view?hrefFor(row.action.view):row.action.orderId?hrefFor({section:'orders',record:row.action.orderId}):null}:null}));
  return result('alerts',records,{count:data.total??records.length},{...data,total:data.total??records.length},{section:'business',tab:'alerts'});
}
function reportQuery(query) {
  const filters=query.filters===undefined?{}:queryObject(query.filters);only(filters,['seller','product','platform','carrier','status','account','source']);
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries({period:query.period,anchor:query.anchor,...filters})) if(value!==undefined&&value!==null)params.set(key,text(value,key,150));
  return normalizeReportQuery(reportRequestQuery(params));
}
const factFields=['id','metric','orderId','orderNumber','shipmentId','productId','sellerId','personId','accountId','expenseId','sourceId','platformId','label','title','kind','category','occurredOn','occurredAt','sourceAsOf','estimatedDeliveryOn','value','unit','known','reason','quantity','units','amountMinor','contributionMinor','knownCount','eligibleCount'];
function reportView(projection,query) {return {section:'reports',period:projection.query.period,anchor:projection.query.anchorDate,...projection.query.filters,...(projection.snapshot?{mode:'saved',record:projection.snapshot.id}:query.metric?{record:query.metric}:{}),...(query.issue?{issue:query.issue}:{})};}
async function reports(tx,query) {
  only(query,['period','anchor','filters','snapshotId','mode','page','metric','issue']);choice(query.mode,['live','snapshot','list'],'Modo de informe');
  if(query.issue&&!query.metric)fail('Selecciona una métrica para este detalle.');
  const p=page(query.page),mode=query.mode||'live';
  let projection;
  if(mode==='list') {
    only(query,['mode','period','anchor','filters','page']);
    const normalized=reportQuery(query),data=await listReportSnapshots(tx,{page:p,...(query.period?{period:normalized.period}:{}),...(query.anchor?{anchorDate:normalized.anchorDate}:{}),filters:normalized.filters});
    return result('reports',data.records.map(row=>({...pick(row,['id','period','startOn','endOnExclusive','revision','generatedAt','state','staleSince','dataRevision']),coverage:row.coverage})),{count:data.total},{page:data.page,total:data.total,pageSize:data.pageSize},row=>({section:'reports',mode:'saved',record:row.id}));
  }
  if(mode==='snapshot') {
    only(query,['mode','snapshotId','page','metric','issue']);
    const report=await getReportSnapshot(tx,id(query.snapshotId,'Informe'));
    if(query.issue==='comparison_elapsed')fail('El tramo comparado requiere un informe en vivo.');
    projection=reportClientData(report,{page:p,metric:query.metric||null,issue:query.issue||null});
  } else {
    if(query.snapshotId!==undefined)fail('Un informe en vivo no admite snapshotId.');
    projection=await liveReportClientData(tx,reportQuery(query),{page:p,metric:query.metric||null,issue:query.issue||null});
  }
  const metrics=Object.entries(projection.metrics).map(([key,value])=>({id:key,...pick(value,['label','value','unit','complete','knownValue','knownCount','eligibleCount','excludedCount']),exclusionReasons:reasons(value.exclusionReasons)}));
  const view=reportView(projection,query),cuts=[];
  const records=query.metric?projection.details.records.map(row=>pick(row,factFields)):slice(metrics,p);
  const output=result('reports',records,{period:projection.query.period,bounds:projection.bounds,dataAsOf:projection.dataAsOf,dataRevision:projection.dataRevision,snapshot:projection.snapshot||null,coverage:projection.coverage,complete:metrics.every(metric=>metric.complete),metrics,detailSummary:projection.details?.metricSummary||null,detailBounds:projection.details?.bounds||null},query.metric?projection.details:{total:metrics.length,page:p,pageSize:20},view,{asOf:projection.dataAsOf});
  const evidence=metrics.map(metric=>createAssistantEvidence({domain:'reports',entityId:projection.snapshot?.id||null,recordVersion:projection.snapshot?.revision??null,field:`metric:${metric.id}`,label:metric.label,value:metric.value,unit:metric.unit,formattedValue:metric.unit==='minor'?money(metric.value):metric.unit==='bps'&&metric.value!==null?`${metric.value/100}%`:null,asOf:projection.dataAsOf,asOfPrecision:precision(projection.dataAsOf),coverage:coverage(metric),href:hrefFor(view)}));
  if(query.metric)evidence.push(...evidenceFor('reports',bounded(records,'details',cuts),view,{asOf:projection.dataAsOf,sourceCoverage:coverage(projection.details.metricSummary||projection.metrics[query.metric])}));
  return setEvidence(output,evidence);
}
async function recommendations(tx,query) {
  only(query,['period','anchor','filters','page']);
  const report=await buildBusinessReportTx(tx,reportQuery(query)),comparison=await dashboardComparisonTx(tx,report),insights=buildInsights(report,comparison);
  const rows=[...insights.improvements.map(row=>({...row,category:'improvement'})),...insights.successes.map(row=>({...row,category:'success'}))];
  const stock=await pageAlerts(tx,{type:'stock_low',state:'active',page:1});
  for(const alert of stock.records) {
    const product=alert.entityType==='product'?await tx.get('products',alert.entityId):null;
    rows.push({id:`stock:${alert.id}`,category:'stock',title:'Revisar alerta de existencias',explanation:alert.reason,value:alert.count,unit:'count',evidence:{...pick(alert,['state','lastSeenAt','count']),...pick(product,['stockQuantity','stockReserved','stockAvailable'])},action:alert.action});
  }
  // Persisted social recommendations only: this path never calls the getter that
  // schedules stale analysis. A page is explicitly a bounded selection.
  const campaigns=await listSocialCampaigns(tx,{page:1});let staleSocial=0;
  for(const campaign of campaigns.campaigns) {
    const analysis=await readSocialAnalysis(tx,campaign.id,{asOf:report.dataAsOf});
    if(analysis.status!=='current'){if(analysis.stale)staleSocial++;continue;}
    for(const item of analysis.recommendations)if(item.state==='suggested')rows.push({id:`social:${item.id}`,category:'advertising',title:socialTitles[item.ruleKey]||'Revisar evidencia publicitaria',explanation:[item.observation,item.hypothesis,item.proposedChange?.text].filter(Boolean).join(' '),value:item.primaryEvidence?.value??null,unit:item.primaryEvidence?.metric?.endsWith('Minor')?'minor':null,currency:campaign.currency||'moneda no informada',evidence:{...pick(item.primaryEvidence,['value','historicalMedian','costPerResultMinor','businessRevision']),missingDataReasons:item.primaryEvidence?.missing||[]},action:{label:'Revisar campaña',view:{section:'advertising',tab:'campaigns',record:campaign.id}}});
  }
  const p=page(query.page),selected=slice(rows,p),records=[],evidence=[];
  for(const item of selected) {
    const view=item.action?.view||{section:'reports',period:report.query.period,anchor:report.query.anchorDate};
    const record={id:item.id,category:item.category,title:item.title||item.text,reason:item.explanation||item.text||'',value:item.value??null,unit:item.unit??null,actionLabel:item.action?.label||'Revisar informe',href:hrefFor(view)};
    const current=item.action?.view?.issue==='comparison_elapsed'?comparison.currentReport:report;
    const metric=item.action?.view?.record;
    const source=metric&&current?.metrics?.[metric];
    const values={...pick(item.evidence,['currentValue','previousValue','difference','changeBps','knownCount','eligibleCount','previousKnownCount','previousEligibleCount','numerator','denominator','previousNumerator','previousDenominator','startDate','endDateExclusive','previousStartDate','previousEndDateExclusive','historicalMedian','costPerResultMinor','state','lastSeenAt','count','stockQuantity','stockReserved','stockAvailable']),...(source?{metricValue:source.value,knownSubtotal:source.knownValue,metricComplete:source.complete,knownCount:source.knownCount,eligibleCount:source.eligibleCount,excludedCount:source.excludedCount}:{}),...(item.evidence?.missingDataReasons?.length?{missingDataReasons:item.evidence.missingDataReasons.slice(0,20)}:{})};
    if(!Object.keys(values).length&&record.value===null)continue;
    const refs=evidenceFor('recommendations',[{id:item.id,currency:item.currency||'COP',...values}],view,{asOf:report.dataAsOf,sourceCoverage:source?coverage(source):coverage(),units:{currentValue:item.unit,previousValue:item.unit,difference:item.unit,metricValue:source?.unit,knownSubtotal:source?.unit,changeBps:'bps'}});
    if(record.value!==null)refs.push(createAssistantEvidence({domain:'recommendations',entityId:item.id,field:'value',label:record.title,value:record.value,unit:record.unit,formattedValue:record.unit==='minor'?money(record.value,item.currency||'COP'):null,asOf:report.dataAsOf,asOfPrecision:'instant',coverage:source?coverage(source):coverage(),href:record.href}));
    record.evidenceIds=refs.map(ref=>ref.id);records.push(record);evidence.push(...refs);
  }
  const output=result('recommendations',records,{count:rows.length,notes:insights.notes.map(row=>pick(row,['id','text'])),comparison:insights.comparison,stockAlertsTotal:stock.total,socialCampaignsTotal:campaigns.total,socialCampaignsRead:campaigns.campaigns.length,staleSocialAnalyses:staleSocial,supplementalScope:{stock:'current_active_alerts',advertising:'current_persisted_analyses'},complete:rows.length<=20&&stock.total<=20&&campaigns.total<=20},{page:p,total:rows.length},{section:'reports'});
  return setEvidence(output,evidence,500);
}
function importSheets(sheets=[]) {
  return sheets.map(sheet=>({...pick(sheet,['sheetName','enabled','headerRow','dateFormat','decimalSeparator','groupSeparator','purpose','layout','oneOrderPerGuide','reportAsOf','identityMode']),columns:(sheet.columns||[]).map(column=>pick(column,['index','header','destination','group','fieldName'])),statusMappings:Object.entries(sheet.statusMap||{}).map(([source,status])=>({source,status})),defaults:pick(sheet.defaults,['expenseCategory','expenseConcept','expenseCampaign','deliveryMethod','carrier','giftQuantity']),expenseGroups:Object.entries(sheet.expenseGroupNames||{}).map(([group,name])=>({group,name})),expenseCategories:Object.entries(sheet.expenseCategoryMap||{}).map(([source,category])=>({source,category}))}));
}
const importFields=[...baseFields,'state','sourceId','platformId','profileId','profileVersion','completedAt','expiresAt','fileExpired','fileDiscarded','acceptedRevision'];
async function imports(tx,query) {
  only(query,['id','page','source','state','q','sheet','rowNumber']);
  if(query.id) {
    only(query,['id','page','state','q','sheet','rowNumber']);
    const {id:batchId,...filters}=query,batch=await getImportBatch(tx,id(batchId),filters);
    const rows=batch.rows.records.map(row=>({...pick(row,['id','sheet','rowNumber','state','entityType']),errors:(row.errors||[]).map(error=>pick(error,['code','message','category','action','field','column']))}));
    const output=result('imports',rows,{batch:pick(batch,importFields),config:{formatVersion:2,sheets:importSheets(batch.config?.sheets)},resolutions:(batch.resolutions||[]).map(row=>pick(row,['action','sheet','rowNumber','columnIndex','reason'])),progress:pick(batch.progress,['phase','processed','total','created','updated','unchanged','errors','omitted']),preview:pick(batch.preview,['previewHash','total','ready','conflicts','rejected','new','updated','unchanged']),error:pick(batch.error,['code','message','category','action']),count:batch.rows.total},batch.rows,{section:'orders',tab:'imports',batch:batch.id});
    const summaryRecord={...output.summary.batch,config:output.summary.config,progress:output.summary.progress,preview:output.summary.preview,error:output.summary.error,resolutions:output.summary.resolutions};
    return setEvidence(output,[...output.evidence,...evidenceFor('imports',[summaryRecord],{section:'orders',tab:'imports',batch:batch.id})]);
  }
  only(query,['page','source','state']);
  const data=await listImportBatches(tx,{...query,page:page(query.page)});
  return result('imports',data.records.map(row=>pick(row,importFields)),{count:data.total},{page:data.page,total:data.total,pageSize:data.pageSize},row=>({section:'orders',tab:'imports',batch:row.id}));
}
const socialTitles={measurement_gap:'Completar la medición',weak_link_ctr:'Revisar respuesta al enlace',possible_fatigue:'Revisar posible fatiga',placement_cost_gap:'Comparar ubicaciones',organic_response:'Revisar respuesta orgánica',posting_window:'Revisar franja de publicación',declared_return_gap:'Revisar contribución después de pauta'};
function socialAnalysisRecord(value) {
  return {...pick(value,['campaignId','asOf','checkedAt','status','stale','commercialStale','metricStale','businessRevision','analysisVersion','observationComplete','primary','message']),gaps:value.gaps||[],comparisons:(value.comparisons||[]).map(row=>({...pick(row,['channel','metric','status','differenceAbsolute','differencePercent','fetchedAt','periodStart','periodEnd']),reasons:row.reasons||[],reported:pick(row.reported,['value','unit','status','precision','reason']),forecastRange:pick(row.forecastRange,['lower','upper','median','metric','channel','sampleCount'])})),recommendations:(value.recommendations||[]).map(row=>({...pick(row,[...baseFields,'ruleKey','observation','hypothesis','state']),title:socialTitles[row.ruleKey]||'Revisar evidencia publicitaria',proposedChange:pick(row.proposedChange,['type','text']),successCriterion:pick(row.successCriterion,['text','metric','operator','target','maxCostPerResultMinor']),primaryEvidence:pick(row.primaryEvidence,['metric','value','historicalMedian','costPerResultMinor','businessRevision']),limitations:row.limitations||[]}))};
}
async function advertising(tx,query) {
  const kind=query.kind||'campaigns';choice(kind,['campaigns','campaign','results','business-result','analysis','assets','connections'],'Consulta de publicidad');
  if(kind==='campaigns') {
    only(query,['kind','page','q','mode','objective','status','network']);
    const {kind:ignored,...filters}=query,data=await listSocialCampaigns(tx,{...filters,page:page(query.page)});
    const records=data.campaigns.map(row=>({...pick(row,[...baseFields,'name','state','mode','objective','budgetMinor','currency']),platforms:row.platforms||[]}));
    return result('advertising',records,{count:data.total},{page:data.page,total:data.total,pageSize:data.pageSize},row=>({section:'advertising',tab:'campaigns',record:row.id}));
  }
  if(kind==='campaign') {
    only(query,['kind','id']);const row=await getSocialCampaign(tx,id(query.id));
    const record={...pick(row,[...baseFields,'name','state','mode','objective','caption','headline','budgetMinor','currency','startAt','endAt','assetId','connectionId']),platforms:row.platforms||[],deliveries:(row.deliveries||[]).map(item=>pick(item,[...baseFields,'channel','state','lastConfirmedState','publishedAt','activatedAt']))};
    return result('advertising',[record],{count:1},{total:1},{section:'advertising',tab:'campaigns',record:row.id});
  }
  if(kind==='analysis') {
    only(query,['kind','campaignId','asOf']);const analysis=await readSocialAnalysis(tx,id(query.campaignId),query.asOf?{asOf:query.asOf}:{});
    return result('advertising',[socialAnalysisRecord(analysis)],{status:analysis.status,stale:analysis.stale,complete:analysis.status==='current'},{total:1},{section:'advertising',tab:'campaigns',record:query.campaignId},{asOf:analysis.asOf,sourceCoverage:coverage({complete:analysis.status==='current',reasons:analysis.stale?['analysis_stale']:[]})});
  }
  if(kind==='business-result') {
    only(query,['kind','campaignId','asOf']);const data=await getSocialBusinessResult(tx,id(query.campaignId),query.asOf?{asOf:query.asOf}:{});
    const records=['recognizedProductSales','knownContribution','collections','metaSpend','registeredAdvertising','advertisingPayments','declaredReturn','contributionAfterAdvertising'].map(key=>({id:key,campaignId:data.campaignId,...pick(data[key],['value','valueMinor','knownMinor','currency','complete','knownCount','eligibleCount','excludedCount']),reasons:reasons(data[key]?.reasons)}));
    const output=result('advertising',records,{asOf:data.asOf,businessRevision:data.businessRevision,coverage:data.coverage,attribution:data.attribution,complete:data.coverage.complete},{total:records.length},{section:'advertising',tab:'results',record:data.campaignId},{asOf:data.asOf});
    return setEvidence(output,records.flatMap(row=>evidenceFor('advertising',[row],{section:'advertising',tab:'results',record:data.campaignId},{asOf:data.asOf,sourceCoverage:coverage(row)})));
  }
  if(kind==='results') {
    only(query,['kind','campaignId','deliveryId','integrationMethod','scope','dimension','asOf','page','from','to']);const {kind:ignored,...filters}=query,data=await getSocialResults(tx,filters);
    const metricValues=values=>Object.fromEntries(Object.entries(values||{}).map(([key,value])=>[key,pick(value,['value','unit','status','precision','reason','displayValue'])]));
    const records=data.measurements.map(row=>({...pick(row,['id','deliveryId','fetchedAt','currency','scope','dimension','integrationMethod','stale','newerPartial','selectedReason','definitionVersion']),values:metricValues(row.values),rows:(row.rows||[]).map(item=>({...pick(item,['periodStart','periodEnd']),dimensions:pick(item.dimensions,['publisherPlatform','placement','age','gender','country']),values:metricValues(item.values)})),coverage:{...pick(row.coverage,['complete','knownCount','eligibleCount','excludedCount']),reasons:reasons(row.coverage?.reasons || (row.coverage?.reason?[row.coverage.reason]:[]))}}));
    const output=result('advertising',records,{selection:data.selection,paginationUnit:'deliveries',deliveryCount:data.total,measurementCount:records.length,reachTotal:null,reachTotalReason:data.reachTotalReason,providerDelayHours:data.providerDelayHours,complete:false},{page:data.page,total:data.total,pageSize:20,hasMore:data.page<data.pages},{section:'advertising',tab:'results',record:query.campaignId});
    const evidence=[];
    for(const record of output.records) {
      const captures=[{prefix:'metric',values:record.values},...record.rows.map((row,index)=>({prefix:`rows.${index}`,values:row.values}))];
      for(const capture of captures)for(const [metric,value] of Object.entries(capture.values))evidence.push(createAssistantEvidence({domain:'advertising',entityId:record.id,field:`${capture.prefix}:${metric}`,label:metric,value:value.value??null,unit:value.unit??null,formattedValue:value.unit==='minor_currency'?money(value.value,record.currency||'moneda no informada'):value.displayValue??null,asOf:record.fetchedAt,asOfPrecision:precision(record.fetchedAt),coverage:coverage({complete:record.coverage.complete===true&&!record.stale&&!record.newerPartial&&value.value!=null,reasons:[...record.coverage.reasons,...(record.stale?['measurement_stale']:[]),...(record.newerPartial?['newer_partial_capture']:[]),...(value.reason?[value.reason]:[])]}),href:hrefFor({section:'advertising',tab:'results',record:query.campaignId})}));
    }
    return setEvidence(output,evidence);
  }
  if(kind==='assets') {
    only(query,['kind','page','state']);const p=page(query.page),data=await listSocialAssets(tx,{limit:20,offset:(p-1)*20,...(query.state!==undefined?{state:query.state}:{})});
    const records=data.assets.map(row=>pick(row,[...baseFields,'name','kind','state','contentType','width','height','durationSeconds','errorCode']));
    return result('advertising',records,{complete:false},{page:p,total:null},{section:'advertising',tab:'assets'});
  }
  only(query,['kind','page']);const p=page(query.page),data=await listSocialConnections(tx),rows=data.connections.map(row=>pick(row,[...baseFields,'state','integrationMethod','name','platform','connectedAt','disconnectedAt']));
  return result('advertising',slice(rows,p),{count:rows.length},{page:p,total:rows.length},{section:'business',tab:'social'});
}
async function access(tx,query) {
  only(query,['page']);const p=page(query.page),rows=await tx.db.all(`SELECT id,active FROM ${tx.t('users')} ORDER BY id LIMIT 20 OFFSET ?`,[(p-1)*20]);
  const total=Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('users')}`)).count);
  return result('access',rows.map(row=>({id:row.id,active:Boolean(row.active)})),{count:total},{page:p,total},{section:'users'});
}
async function application(tx,query) {
  only(query,['taskId','page']);exclusiveDetail(query,'taskId');
  const rows=query.taskId?[getAssistantGuide(id(query.taskId,'Tarea'))].filter(Boolean):listAssistantGuideTasks(),p=page(query.page);
  if(query.taskId&&!rows.length)fail('Tarea de la aplicación no disponible.');
  const output=result('application',slice(rows,p),{count:rows.length},{page:p,total:rows.length},row=>readAdminView(new URL(row.href,'https://assistant.invalid').searchParams));
  output.evidence=output.records.map(row=>createAssistantEvidence({domain:'application',entityId:row.taskId,field:'title',label:'Tarea de la aplicación',value:row.title,href:row.href}));
  return output;
}

/** One coherent, write-incapable snapshot; caller revalidates session/config per tool. */
export async function readAssistantBusiness(store,session,{domain,query={}}={}) {
  if(!session?.user?.id){const error=new Error('Se requiere una sesión administrativa.');error.code='ASSISTANT_AUTH_REQUIRED';throw error;}
  queryObject(query);
  const readers={catalog,orders,shipments,cash,reports,recommendations,business,alerts,imports,advertising,access,application};
  if(!Object.hasOwn(readers,domain))fail('Dominio de lectura no disponible.',422);
  return store.readSnapshot(tx=>readers[domain](snapshotFacade(tx),query,session));
}
