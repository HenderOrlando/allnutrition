import { fail, integer, text } from '../validation-core.mjs';
import { schemas, settingsFields, contentStates, orderStates, paymentStates } from '../schema.mjs';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { pageOrders } from '../business/orders.mjs';
import { pageShipments, getShipment, SHIPMENT_STATUSES } from '../business/shipments.mjs';
import { financeOverviewTx, financeQuery } from '../business/finance.mjs';
import { preparePayroll } from '../business/payroll.mjs';
import { getCashClosingPreview } from '../business/cash.mjs';
import { buildBusinessReportTx, buildBusinessRangeReportTx, reportDetails, listReportSnapshots, getReportSnapshot, normalizeReportQuery } from '../business/reports.mjs';
import { reportRequestQuery } from '../business/report-export.mjs';
import { dashboardComparisonTx, dashboardMetricComparisons } from '../business/dashboard.mjs';
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
import { BUSINESS_PERIODS, businessDate, bogotaDate, addDays } from '../business/dates.mjs';
import { createHash } from 'node:crypto';
import { ASSISTANT_LIMITS } from './limits.mjs';
import { validateAssistantReadRequest, ASSISTANT_REPORT_METRICS, assistantReadFields, baseFields, lineFields, eventFields, financialFields, resourceFields, agreementFields, alertFields, factFields, importFields, groupNumericFields } from './read-contracts.mjs';
export { validateAssistantReadRequest } from './read-contracts.mjs';

// Provider-facing documentation only; the domain readers remain the validators.
export const assistantBusinessQueryGuide = Object.freeze({
  select:'Proyección independiente: {mode:auto|summary|records|detail|groups|compare,fields?:string[1..12],metrics?:metric[1..12],group?:products|sellers|accounts|payroll|shipments|returns|costs,sortBy?:campo numérico autorizado,direction?:asc|desc,limit?:1..20|null,cursor?:cursor opaco emitido}. Auto=detalle con identidad, resumen en listas. Groups/compare solo informes; ordenar grupo completo antes de limit; id asc por defecto. Limit null recorre completo. Fragmentos con continuation y coordenadas summary.fragments; nunca confundir ejemplos con total.',
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
    list:'{kind?:catalogKind,q?:text100,status?:contentStatus,productType?:product|gift,page?}; default todos, incluidos draft.',
    detail:'{kind:catalogKind,id:id}.',
  },
  orders:{
    list:'{page?,q?:text100,status?:orderStatus,paymentStatus?:paymentStatus,seller?:id,product?:id,platform?:id,source?:id,carrier?:string150,issue?:incident|pending_settlement|missing_data|missing_cost|legacy_review,lookup?:identity,startDate?:date,endDateExclusive?:date}. Intervalo ambos o ninguno sobre placedOn; fechas ausentes en cobertura.',
    identity:'lookup:identity exige q=número AN-... o guía exacta; sin lookup búsqueda general.',
    detail:'{id:id}; incluye líneas/cobros/envíos, sin contacto.',
  },
  shipments:{
    list:'{page?,q?:text100,status?:shipmentStatus,carrier?:string200,orderId?:id,sourceId?:id,platformId?:id,issue?:orphan|incident|missing_data,startDate?:date,endDateExclusive?:date,eventStatus?:shipmentStatus}. Intervalo sobre eventos efectivos; status actual es distinto de eventStatus.',
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
    live:'{mode?:live,period?:period,anchor?:date,filters?:reportFilters,page?,metric?:metric,issue?:reportIssue,startDate?:date,endDateExclusive?:date,compareTo?:{startDate,endDateExclusive}}; rango ambos límites excluyente con period/anchor; compareTo solo comparación. Default live/month/hoy Bogotá.',
    snapshot:'{mode:snapshot,snapshotId:id,page?,metric?:metric,issue?:reportIssue}; corte guardado.',
    list:'{mode:list,period?:period,anchor?:date,filters?:reportFilters,page?}; sin selección todas las copias; anchor/filters seleccionan identidad (period default month).',
    reportFilters:'{seller?:id,product?:id,platform?:id,carrier?:string150,status?:orderStatus|shipmentStatus,account?:id,source?:id}.',
    issue:'Requiere metric correspondiente; comparison_elapsed SOLO live/días completos.',
  },
  recommendations:'{period?:period,anchor?:date,filters?:reportFilters,page?,startDate?:date,endDateExclusive?:date}; rango excluyente con period/anchor; ambos límites. Default month/hoy. reportFilters de reports. summary.notes=insuficiencia; stock/social son selecciones actuales, no totales del período.',
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
    list:'{kind?:campaigns,page?,q?:string200,mode?:organic|paid,objective?:objective,status?:campaignStatus,network?:facebook|instagram,from?:date,to?:date}; fecha de inicio campaña inclusiva, sin fecha se excluye; default campaigns.',
    detail:'{kind:campaign,id:UUID}.',
    results:'{kind:results,campaignId?:UUID,deliveryId?:UUID,integrationMethod?:api|browser,scope?:paid|organic|mixed,dimension?:aggregate|daily|placement|age_gender|country,asOf?:instant,page?,from?:date,to?:date,mode?:organic|paid,network?:facebook|instagram,objective?:objective,status?:campaignStatus}; filtros aplicados a campañas antes de paginar entregas; page hasta1000000; from/to inclusivos, from<=to; asOf default ahora. Página de entregas; alcance no sumable.',
    business:'{kind:business-result,campaignId:UUID,asOf?:instant}; default ahora.',
    analysis:'{kind:analysis,campaignId:UUID,asOf?:instant}; default ahora; persistido/freshness, nunca encola.',
    assets:'{kind:assets,page?,state?:uploading|processing|ready|failed|archived|missing_file}.',
    connections:'{kind:connections,page?}; solo estado.',
  },
  access:'{page?}; solo identificador/estado administrativo.',
  application:'{page?} lista tareas; {taskId:id} obtiene guía. taskId/step IDs SOLO devueltos por reader.',
});

const PAGE_SIZE = ASSISTANT_LIMITS.pageRecords;
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
const labels={title:'Nombre',name:'Nombre',number:'Número de pedido',status:'Estado',state:'Estado',price:'Precio',description:'Descripción',balanceMinor:'Saldo de cuenta',totalMinor:'Total acordado',dueMinor:'Saldo por cobrar',availableMinor:'Disponible consolidado'};
function evidenceFor(domain, records, view, {asOf=null,sourceCoverage=null,units={}}={}) {
  const evidence=[];
  for (const record of records) {
    const target=typeof view==='function'?view(record):view;
    const href=target===null?null:hrefFor(target);
    const cut=asOf || (domain==='shipments'?record.sourceAsOf:record.dataAsOf || record.updatedAt) || null;
    const walk=(value,path)=>{
      if (scalar(value)) {
        if (path.length>100 || /(?:^|\.)(?:id|version|href|actionLabel|evidenceIds)$/.test(path)) return;
        const key=path.split('.').at(-1),unit=units[path]||units[key]||(key.endsWith('Minor')?'minor':key==='price'?'COP':key==='value'||key==='knownValue'?record.unit||null:null);
        evidence.push(createAssistantEvidence({domain,entityId:record.id??record.campaignId??null,recordVersion:record.version??null,field:path,label:labels[key]||key,value,unit,formattedValue:unit==='minor'?money(value,record.currency||(domain==='advertising'?'moneda no informada':'COP')):unit==='COP'?pesos(value):unit==='bps'&&value!==null?`${value/100}%`:null,asOf:cut,asOfPrecision:precision(cut),coverage:sourceCoverage||(typeof record.complete==='boolean'?coverage(record):null),href}));
      } else if(Array.isArray(value)) value.forEach((item,index)=>walk(item,`${path}.${index}`));
      else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) walk(item,path?`${path}.${key}`:key);
    };
    walk(record,'');
  }
  return evidence;
}
function result(domain,records,summary,pagination,view,options={}) {
  const currentPage=pagination?.page??1,total=pagination && Object.hasOwn(pagination,'total')?pagination.total:records.length,pageSize=pagination?.pageSize??PAGE_SIZE;
  return {_view:view,_options:options,records,summary:{...summary,complete:summary.complete??true},pagination:{page:currentPage,pageSize,total,hasMore:pagination?.hasMore??(total===null?records.length===pageSize:currentPage*pageSize<total)},evidence:[]};
}
function setEvidence(output,evidence) {
  output.evidence=[...new Map(evidence.map(item=>[item.id,item])).values()];
  return output;
}
const distribution=(rows,key)=>rows.reduce((counts,row)=>{const value=row[key]??'unknown';counts[value]=(counts[value]||0)+1;return counts;},{});
function slice(rows,currentPage) { return rows.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE); }
function financialRecord(row) {
  const value=pick(row,financialFields);
  for(const key of ['lines','payments','activePayments','obligations','advances','carriedCredits','missingAccruals','receipts']) if(Array.isArray(row[key])) value[key]=row[key].map(item=>pick(item,[...financialFields,'collectionId','expenseId','quantity','allocatedMinor','availableMinor']));
  return value;
}

async function catalog(tx, query) {
  only(query,['kind','id','q','status','page','productType']);
  choice(query.productType,['product','gift'],'Tipo de producto');
  if(query.productType!==undefined&&query.kind!=='products')fail('El tipo requiere productos.');
  choice(query.status,contentStates.map(state=>state.value),'Estado de contenido');
  if(query.id) {only(query,['kind','id']);if(!query.kind)fail('Selecciona el tipo del registro.');}
  const kinds=query.kind?[query.kind]:Object.keys(schemas);
  if(kinds.some(kind=>!Object.hasOwn(schemas,kind)))fail('Tipo de catálogo no válido.');
  const p=page(query.page),q=text(query.q??'','Búsqueda',100).toLocaleLowerCase('es'),rows=[];
  for(const kind of kinds) {
    const source=query.id?[await tx.get(kind,id(query.id))].filter(Boolean):await tx.list(kind);
    for(const row of source) {
      if(query.status && row.status!==query.status)continue;
      if(query.productType && (row.productType||'product')!==query.productType)continue;
      const record={...pick(row,[...baseFields,...schemas[kind].fields.filter(field=>field.type!=='image').map(field=>field.name),'stockReserved','stockAvailable','availability']),kind};
      if(row.catalogIds)record.catalogIds=row.catalogIds.filter(value=>typeof value==='string');
      if(row.items)record.items=row.items.map(item=>pick(item,['productId','quantity','unitCostMinor']));
      if(!q || JSON.stringify(record).toLocaleLowerCase('es').includes(q)) rows.push(record);
    }
  }
  rows.sort((a,b)=>(a.title||'').localeCompare(b.title||'','es')||a.id.localeCompare(b.id));
  return {...result('catalog',rows,{count:rows.length,states:distribution(rows,'status'),types:distribution(rows,'productType'),stock:{known:rows.filter(row=>row.stockQuantity!=null).length,unknown:rows.filter(row=>row.stockQuantity==null&&row.kind==='products').length}},{page:p,total:rows.length},row=>({section:row.kind,record:row.id})),_allRecords:true};
}
async function orders(tx,query) {
  only(query,['id','page','q','status','paymentStatus','seller','product','platform','source','carrier','issue','lookup','startDate','endDateExclusive']);
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
      if(row.financialSummary)record.financialSummary={...pick(row.financialSummary,['label','netProductsMinor','shippingRevenueMinor','knownCostOfGoodsMinor','knownGiftCostMinor','costOfGoodsMinor','giftCostMinor','expenseMinor','knownContributionMinor','contributionMinor','knownResultMinor','resultMinor','complete','unknownShippingCost']),unknownCostLineIds:row.financialSummary.unknownCostLineIds||[]};
      if(row.paymentSummary)record.paymentSummary=pick(row.paymentSummary,['status','netCollectedMinor','outstandingMinor','legacyReview','platformHeldMinor','commercialDueMinor']);
      record.items=(row.items||[]).map(item=>({...pick(item,lineFields),components:(item.components||[]).map(component=>pick(component,['productId','title','quantity','unitCostMinor']))}));
      for(const key of ['collections','returns','expenses'])if(row[key])record[key]=row[key].map(financialRecord);
    }
    return record;
  });
  return result('orders',records,{count:data.total??records.length,unlocatedDates:data.unlocatedDates??0},{...data,total:data.total??records.length},row=>({section:'orders',record:row.id}));
}
async function shipments(tx,query) {
  only(query,['id','page','q','status','carrier','orderId','sourceId','platformId','issue','startDate','endDateExclusive','eventStatus']);exclusiveDetail(query,'id');
  const data=query.id?{records:[await getShipment(tx,id(query.id))],page:1}:await pageShipments(tx,{...query,page:page(query.page)});
  const records=data.records.map(row=>{
    const value=pick(row,[...baseFields,'orderId','orderNumber','platformId','platformName','sourceId','sourceName','status','carrier','tracking','estimatedDeliveryOn','sourceAsOf','knownEventOn','knownEventAt','costStatus']);
    if(query.id){value.events=(row.events||[]).map(item=>pick(item,eventFields));value.assignments=(row.assignments||[]).map(item=>pick(item,['lineId','quantity']));value.orderLines=(row.orderLines||[]).map(item=>pick(item,['lineId','title','presentation','quantity']));}
    return value;
  });
  return result('shipments',records,{count:data.total??records.length,unlocatedDates:data.unlocatedDates??0},{...data,total:data.total??records.length},row=>({section:'orders',tab:'shipments',record:row.id}));
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
    const overview=await financeOverviewTx(tx,{asOf:query.asOf||bogotaDate(tx._assistantNow)}),p=page(query.page);
    const records=slice(overview.accounts,p).map(row=>pick(row,[...baseFields,'name','type','active','responsibleId','responsibleName','balanceMinor']));
    const summary=pick(overview,['asOf','availableMinor','platformPendingMinor','expensesOutstandingMinor','expenseCreditsMinor','payrollOutstandingMinor','unassignedDateExpenses']);
    const output=result('cash',records,{...summary,count:overview.accounts.length},{page:p,total:overview.accounts.length},row=>({section:'cash',tab:'overview',account:row.id}),{asOf:overview.asOf});
    for(const key of ['availableMinor','platformPendingMinor','expensesOutstandingMinor','expenseCreditsMinor','payrollOutstandingMinor'])output.evidence.push(createAssistantEvidence({domain:'cash',field:key,label:labels[key]||key,value:overview[key],unit:'minor',formattedValue:money(overview[key]),asOf:overview.asOf,asOfPrecision:'date',href:hrefFor({section:'cash',tab:'overview'})}));
    return setEvidence(output,output.evidence);
  }
  const filters={movements:['account'],settlements:['source','status'],expenses:['person','category'],payroll:['person','status'],closings:['account','status']}[resource];
  only(query,['kind','resource','page','record','q','startDate','endDateExclusive',...filters]);
  if(query.record)only(query,['kind','resource','record',...(resource==='closings'?['account']:[])]);
  const {kind,resource:ignored,...input}=query;
  const {account,...detailInput}=input;
  const data=await financeQuery(tx,resource,{...(query.record?detailInput:input),page:page(query.page)}),rows=data.records||[data];
  if(query.record&&account&&rows.some(row=>row.accountId!==account))fail('El cierre no pertenece a la cuenta visible.');
  return result('cash',rows.map(financialRecord),{count:data.total??rows.length},{page:data.page??1,total:data.total??rows.length,pageSize:data.pageSize??20},row=>({section:'cash',tab:resource,record:row.id}));
}
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
  return result('alerts',records,{count:data.total??records.length,unlocatedDates:data.unlocatedDates??0},{...data,total:data.total??records.length},{section:'business',tab:'alerts'});
}
function reportQuery(query,asOf) {
  const filters=query.filters===undefined?{}:queryObject(query.filters);only(filters,['seller','product','platform','carrier','status','account','source']);
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries({period:query.period,anchor:query.anchor||(asOf?bogotaDate(asOf):undefined),...filters})) if(value!==undefined&&value!==null)params.set(key,text(value,key,150));
  return normalizeReportQuery({...reportRequestQuery(params),...(asOf?{asOf}:{})});
}
function reportView(projection,query) {return {section:'reports',period:projection.query.period,anchor:projection.query.anchorDate,...projection.query.filters,...(projection.snapshot?{mode:'saved',record:projection.snapshot.id}:query.metric?{record:query.metric}:{}),...(query.issue?{issue:query.issue}:{})};}
async function loadAssistantReport(tx,query) {
  return query.startDate!==undefined||query.endDateExclusive!==undefined
    ? buildBusinessRangeReportTx(tx,{startDate:query.startDate,endDateExclusive:query.endDateExclusive,filters:query.filters||{},asOf:tx._assistantNow})
    : buildBusinessReportTx(tx,reportQuery(query,tx._assistantNow));
}
async function reports(tx,query,session,select={mode:'auto'}) {
  only(query,['period','anchor','filters','snapshotId','mode','page','metric','issue','startDate','endDateExclusive','compareTo']);choice(query.mode,['live','snapshot','list'],'Modo de informe');
  if(query.issue&&!query.metric)fail('Selecciona una métrica para este detalle.');
  if(query.compareTo&&select.mode!=='compare')fail('compareTo requiere comparación.');
  const p=page(query.page),mode=query.mode||'live';
  if(mode==='list') {
    only(query,['mode','period','anchor','filters','page']);
    const normalized=reportQuery(query,tx._assistantNow),data=await listReportSnapshots(tx,{page:p,...(query.period?{period:normalized.period}:{}),...(query.anchor?{anchorDate:normalized.anchorDate}:{}),filters:normalized.filters});
    return result('reports',data.records.map(row=>({...pick(row,['id','period','startOn','endOnExclusive','revision','generatedAt','state','staleSince','dataRevision']),coverage:row.coverage})),{count:data.total},{page:data.page,total:data.total,pageSize:data.pageSize},row=>({section:'reports',mode:'saved',record:row.id}));
  }
  let report;
  if(mode==='snapshot') {
    only(query,['mode','snapshotId','page','metric','issue']);
    if(query.issue==='comparison_elapsed'||select.mode==='compare')fail('La comparación requiere un informe en vivo.');
    report=await getReportSnapshot(tx,id(query.snapshotId,'Informe'));
  }else{
    if(query.snapshotId!==undefined)fail('Un informe en vivo no admite snapshotId.');
    report=await loadAssistantReport(tx,query);
  }
  const groupMetrics=select.mode==='groups'?(['products','sellers'].includes(select.group)?(['contributionMinor','knownContributionMinor'].includes(select.sortBy)?['contribution']:['netProductSales','soldUnits']):{accounts:['cashAvailable'],payroll:['payrollEarned','payrollPaid','payrollOutstanding'],shipments:['shipmentCount','onTimeDeliveries','shipmentReturnRate','transitDays'],returns:['returnedUnits'],costs:['operatingResult']}[select.group]):null;
  const keys=select.metrics||groupMetrics||(query.metric?[query.metric]:ASSISTANT_REPORT_METRICS);
  if(keys.some(key=>!Object.hasOwn(report.metrics,key)))fail('Métrica no válida.');
  const view=report.query.period==='range'?null:reportView(report,query);
  let records,evidence=[],details=null,comparison=null;
  const metricRecord=(key,value)=>({id:key,...pick(value,['label','value','unit','complete','knownValue','knownCount','eligibleCount','excludedCount']),exclusionReasons:reasons(value.exclusionReasons)});
  if(select.mode==='groups') {
    const group=report.groups[select.group];
    const numeric=groupNumericFields[select.group];
    const sortBy=select.sortBy||'id',direction=select.direction||'asc';
    if(sortBy!=='id'&&!numeric.includes(sortBy))fail('Campo de orden no permitido.');
    records=group.map(row=>({...row})).sort((a,b)=>{if(a[sortBy]==null||b[sortBy]==null)return a[sortBy]==null?(b[sortBy]==null?String(a.id).localeCompare(String(b.id)):1):-1;const order=sortBy==='id'?String(a.id).localeCompare(String(b.id)):a[sortBy]-b[sortBy];return (direction==='desc'?-order:order)||String(a.id).localeCompare(String(b.id));});
  }else if(select.mode==='compare'){
    comparison=await dashboardComparisonTx(tx,report,{previousRange:query.compareTo||null});
    const comparisons=dashboardMetricComparisons(comparison);
    records=keys.map(key=>({id:key,metric:key,label:report.metrics[key].label,unit:report.metrics[key].unit,current:pick(comparison.currentReport.metrics[key],['value','knownValue','complete','knownCount','eligibleCount','excludedCount']),previous:pick(comparison.report.metrics[key],['value','knownValue','complete','knownCount','eligibleCount','excludedCount']),comparison:pick(comparisons[key],['difference','changeBps','reason'])}));

  }else if(query.metric){
    let detailsReport=report;
    if(query.issue==='comparison_elapsed'){if(!report.closed&&bogotaDate(report.query.asOf)<=report.bounds.startDate)fail('Todavía no hay días completos para este detalle.');detailsReport=(await dashboardComparisonTx(tx,report)).currentReport;}
    details=reportDetails(detailsReport,{metric:query.metric,issue:query.issue==='comparison_elapsed'?null:query.issue,pageSize:null});
    if(query.issue==='comparison_elapsed'){details.metricSummary={...detailsReport.metrics[query.metric],label:detailsReport.metrics[query.metric].label+' · días completos'};details.bounds=detailsReport.bounds;}
    records=details.records.map(row=>pick(row,factFields));
  }else records=keys.map(key=>metricRecord(key,report.metrics[key]));
  if(select.mode!=='groups'&&select.mode!=='compare')evidence=keys.map(key=>{const metric=report.metrics[key];return createAssistantEvidence({domain:'reports',entityId:report.snapshot?.id||null,recordVersion:report.snapshot?.revision??null,field:`metric:${key}`,label:metric.label,value:metric.value,unit:metric.unit,formattedValue:metric.unit==='minor'?money(metric.value):metric.unit==='bps'&&metric.value!==null?`${metric.value/100}%`:null,asOf:report.dataAsOf,asOfPrecision:precision(report.dataAsOf),coverage:coverage(metric),href:view===null?null:hrefFor(view)});});
  const summary={period:report.query.period,bounds:report.bounds,dataAsOf:report.dataAsOf,dataRevision:report.dataRevision,snapshot:report.snapshot||null,coverage:{...report.coverage,pending:report.coverage.pending.filter(row=>keys.includes(row.metric))},definitions:report.definitions.filter(row=>keys.includes(row.key)).map(row=>pick(row,['key','label','unit','formula'])),criteria:report.definitions[0]?.criteria||[],detailSummary:details?.metricSummary||null,detailBounds:details?.bounds||null,...(comparison?{comparison:{equivalent:comparison.equivalent,mode:comparison.mode,currentBounds:comparison.currentBounds,previousBounds:comparison.previousBounds,reason:comparison.reason}}:{})};
  const output=result('reports',records,summary,{total:records.length,page:1,pageSize:20},view,{asOf:report.dataAsOf});
  output._allRecords=true;output._sourceStamp=`${report.queryKey}:${report.factHash}:${report.dataRevision}${comparison?`:${comparison.report.factHash}:${comparison.currentReport.factHash}`:""}`;
  output._dataset={domain:'reports',resource:select.mode==='groups'?select.group:select.mode==='compare'?'comparison':query.metric?'facts':'metrics',recordId:report.snapshot?.id||query.metric||null,filters:report.query.filters,startDate:report.bounds.startDate,endDateExclusive:report.bounds.endDateExclusive,asOf:report.dataAsOf};
  output._interval={startDate:report.bounds.startDate,endDateExclusive:report.bounds.endDateExclusive,closed:report.closed};
  if(comparison)output._comparisonIntervals={current:{startDate:comparison.currentBounds.startDate,endDateExclusive:comparison.currentBounds.endDateExclusive,closed:comparison.currentReport.closed},previous:{startDate:comparison.previousBounds.startDate,endDateExclusive:comparison.previousBounds.endDateExclusive,closed:comparison.report.closed}};
  if(select.mode==='compare')output.evidence=records.flatMap(row=>['current.value','previous.value','comparison.difference','comparison.changeBps'].map(field=>{const [branch,key]=field.split('.'),value=row[branch][key],metric=branch==='previous'?comparison.report.metrics[row.id]:comparison.currentReport.metrics[row.id],unit=key==='changeBps'?'bps':row.unit;return createAssistantEvidence({domain:'reports',entityId:row.id,field,label:`${row.label} · ${branch}`,value,unit,formattedValue:unit==='minor'?money(value):null,asOf:report.dataAsOf,asOfPrecision:'instant',coverage:coverage(metric),href:view===null?null:hrefFor(view)});}));
  if(evidence.length)output.evidence=[...evidence,...(query.metric?output.evidence:[])];
  return output;
}
async function recommendations(tx,query) {
  only(query,['period','anchor','filters','page','startDate','endDateExclusive']);
  const report=await loadAssistantReport(tx,query),comparison=await dashboardComparisonTx(tx,report),insights=buildInsights(report,comparison);
  const rows=[...insights.improvements.map(row=>({...row,category:'improvement'})),...insights.successes.map(row=>({...row,category:'success'}))];
  const stock=await collectServicePages(p=>pageAlerts(tx,{type:'stock_low',state:'active',page:p}),'records');
  for(const alert of stock.records) {
    const product=alert.entityType==='product'?await tx.get('products',alert.entityId):null;
    rows.push({id:`stock:${alert.id}`,category:'stock',title:'Revisar alerta de existencias',explanation:alert.reason,value:alert.count,unit:'count',evidence:{...pick(alert,['state','lastSeenAt','count']),...pick(product,['stockQuantity','stockReserved','stockAvailable'])},action:alert.action});
  }
  // Persisted social recommendations only: this path never calls the getter that
  // schedules stale analysis. All campaign pages contribute to the selection.
  const campaigns=await collectServicePages(p=>listSocialCampaigns(tx,{page:p}),'campaigns');let staleSocial=0;
  for(const campaign of campaigns.campaigns) {
    const analysis=await readSocialAnalysis(tx,campaign.id,{asOf:report.dataAsOf});
    if(analysis.status!=='current'){if(analysis.stale)staleSocial++;continue;}
    for(const item of analysis.recommendations)if(item.state==='suggested')rows.push({id:`social:${item.id}`,category:'advertising',title:socialTitles[item.ruleKey]||'Revisar evidencia publicitaria',explanation:[item.observation,item.hypothesis,item.proposedChange?.text].filter(Boolean).join(' '),value:item.primaryEvidence?.value??null,unit:item.primaryEvidence?.metric?.endsWith('Minor')?'minor':null,currency:campaign.currency||'moneda no informada',evidence:{...pick(item.primaryEvidence,['value','historicalMedian','costPerResultMinor','businessRevision']),missingDataReasons:item.primaryEvidence?.missing||[]},action:{label:'Revisar campaña',view:{section:'advertising',tab:'campaigns',record:campaign.id}}});
  }
  const p=page(query.page),selected=rows,records=[],evidence=[];
  for(const item of selected) {
    const view=report.query.period==='range'&&(!item.action?.view||item.action.view.section==='reports')?null:item.action?.view||{section:'reports',period:report.query.period,anchor:report.query.anchorDate};
    const record={id:item.id,category:item.category,title:item.title||item.text,reason:item.explanation||item.text||'',value:item.value??null,unit:item.unit??null,actionLabel:item.action?.label||'Revisar informe',href:view===null?null:hrefFor(view)};
    const current=item.action?.view?.issue==='comparison_elapsed'?comparison.currentReport:report;
    const metric=item.action?.view?.record;
    const source=metric&&current?.metrics?.[metric];
    const values={...pick(item.evidence,['currentValue','previousValue','difference','changeBps','knownCount','eligibleCount','previousKnownCount','previousEligibleCount','numerator','denominator','previousNumerator','previousDenominator','startDate','endDateExclusive','previousStartDate','previousEndDateExclusive','historicalMedian','costPerResultMinor','state','lastSeenAt','count','stockQuantity','stockReserved','stockAvailable']),...(source?{metricValue:source.value,knownSubtotal:source.knownValue,metricComplete:source.complete,knownCount:source.knownCount,eligibleCount:source.eligibleCount,excludedCount:source.excludedCount}:{}),...(item.evidence?.missingDataReasons?.length?{missingDataReasons:item.evidence.missingDataReasons}:{})};
    if(!Object.keys(values).length&&record.value===null)continue;
    const refs=evidenceFor('recommendations',[{id:item.id,currency:item.currency||'COP',...values}],view,{asOf:report.dataAsOf,sourceCoverage:source?coverage(source):coverage(),units:{currentValue:item.unit,previousValue:item.unit,difference:item.unit,metricValue:source?.unit,knownSubtotal:source?.unit,changeBps:'bps'}});
    if(record.value!==null)refs.push(createAssistantEvidence({domain:'recommendations',entityId:item.id,field:'value',label:record.title,value:record.value,unit:record.unit,formattedValue:record.unit==='minor'?money(record.value,item.currency||'COP'):null,asOf:report.dataAsOf,asOfPrecision:'instant',coverage:source?coverage(source):coverage(),href:record.href}));
    record.evidenceIds=refs.map(ref=>ref.id);records.push(record);evidence.push(...refs);
  }
  const output=result('recommendations',records,{count:rows.length,notes:insights.notes.map(row=>pick(row,['id','text'])),comparison:insights.comparison,stockAlertsTotal:stock.total,socialCampaignsTotal:campaigns.total,socialCampaignsRead:campaigns.campaigns.length,staleSocialAnalyses:staleSocial,supplementalScope:{stock:'current_active_alerts',advertising:'current_persisted_analyses'},complete:true},{page:p,total:rows.length},{section:'reports'});
  output._allRecords=true;
  output._dataset={domain:'recommendations',resource:'period-report-and-current-signals',recordId:null,filters:report.query.filters,startDate:report.bounds.startDate,endDateExclusive:report.bounds.endDateExclusive,asOf:report.dataAsOf};
  output._interval={startDate:report.bounds.startDate,endDateExclusive:report.bounds.endDateExclusive,closed:report.closed};
  output._sourceStamp=sourceHash({report:report.factHash,revision:report.dataRevision,stock:stock.records,campaigns:campaigns.campaigns.map(row=>pick(row,['id','version','updatedAt'])),records:rows});
  return setEvidence(output,evidence);
}
function importSheets(sheets=[]) {
  return sheets.map(sheet=>({...pick(sheet,['sheetName','enabled','headerRow','dateFormat','decimalSeparator','groupSeparator','purpose','layout','oneOrderPerGuide','reportAsOf','identityMode']),columns:(sheet.columns||[]).map(column=>pick(column,['index','header','destination','group','fieldName'])),statusMappings:Object.entries(sheet.statusMap||{}).map(([source,status])=>({source,status})),defaults:pick(sheet.defaults,['expenseCategory','expenseConcept','expenseCampaign','deliveryMethod','carrier','giftQuantity']),expenseGroups:Object.entries(sheet.expenseGroupNames||{}).map(([group,name])=>({group,name})),expenseCategories:Object.entries(sheet.expenseCategoryMap||{}).map(([source,category])=>({source,category}))}));
}
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
    only(query,['kind','page','q','mode','objective','status','network','from','to']);
    const {kind:ignored,from,to,...filters}=query;
    let data;
    if(from!==undefined||to!==undefined){if(from!==undefined)businessDate(from);if(to!==undefined)businessDate(to);if(from&&to&&from>to)fail('Intervalo no válido.');const all=await collectServicePages(p=>listSocialCampaigns(tx,{...filters,page:p}),'campaigns');const selected=all.campaigns.filter(row=>{if(!row.startAt)return false;const date=bogotaDate(row.startAt);return (!from||date>=from)&&(!to||date<=to);});data={campaigns:slice(selected,page(query.page)),total:selected.length,page:page(query.page),pageSize:20};}else data=await listSocialCampaigns(tx,{...filters,page:page(query.page)});
    const records=data.campaigns.map(row=>({...pick(row,[...baseFields,'name','state','mode','objective','budgetMinor','currency']),platforms:row.platforms||[]}));
    return result('advertising',records,{count:data.total},{page:data.page,total:data.total,pageSize:data.pageSize},row=>({section:'advertising',tab:'campaigns',record:row.id}));
  }
  if(kind==='campaign') {
    only(query,['kind','id']);const row=await getSocialCampaign(tx,id(query.id));
    const record={...pick(row,[...baseFields,'name','state','mode','objective','caption','headline','budgetMinor','currency','startAt','endAt','assetId','connectionId']),platforms:row.platforms||[],deliveries:(row.deliveries||[]).map(item=>pick(item,[...baseFields,'channel','state','lastConfirmedState','publishedAt','activatedAt']))};
    return result('advertising',[record],{count:1},{total:1},{section:'advertising',tab:'campaigns',record:row.id});
  }
  if(kind==='analysis') {
    only(query,['kind','campaignId','asOf']);const analysis=await readSocialAnalysis(tx,id(query.campaignId),{asOf:query.asOf||tx._assistantNow});
    return result('advertising',[socialAnalysisRecord(analysis)],{status:analysis.status,stale:analysis.stale,complete:analysis.status==='current'},{total:1},{section:'advertising',tab:'campaigns',record:query.campaignId},{asOf:analysis.asOf,sourceCoverage:coverage({complete:analysis.status==='current',reasons:analysis.stale?['analysis_stale']:[]})});
  }
  if(kind==='business-result') {
    only(query,['kind','campaignId','asOf']);const data=await getSocialBusinessResult(tx,id(query.campaignId),{asOf:query.asOf||tx._assistantNow});
    const records=['recognizedProductSales','knownContribution','collections','metaSpend','registeredAdvertising','advertisingPayments','declaredReturn','contributionAfterAdvertising'].map(key=>({id:key,campaignId:data.campaignId,...pick(data[key],['value','valueMinor','knownMinor','currency','complete','knownCount','eligibleCount','excludedCount']),reasons:reasons(data[key]?.reasons)}));
    const output=result('advertising',records,{asOf:data.asOf,businessRevision:data.businessRevision,coverage:data.coverage,attribution:data.attribution,complete:data.coverage.complete},{total:records.length},{section:'advertising',tab:'results',record:data.campaignId},{asOf:data.asOf});
    return setEvidence(output,records.flatMap(row=>evidenceFor('advertising',[row],{section:'advertising',tab:'results',record:data.campaignId},{asOf:data.asOf,sourceCoverage:coverage(row)})));
  }
  if(kind==='results') {
    only(query,['kind','campaignId','deliveryId','integrationMethod','scope','dimension','asOf','page','from','to','mode','network','objective','status']);const {kind:ignored,...filters}=query,data=await filteredSocialResults(tx,{...filters,asOf:filters.asOf||tx._assistantNow});
    const metricValues=values=>Object.fromEntries(Object.entries(values||{}).map(([key,value])=>[key,pick(value,['value','unit','status','precision','reason','displayValue'])]));
    const records=data.measurements.map(row=>({...pick(row,['id','deliveryId','fetchedAt','currency','scope','dimension','integrationMethod','stale','newerPartial','selectedReason','definitionVersion']),values:metricValues(row.values),rows:(row.rows||[]).map(item=>({...pick(item,['periodStart','periodEnd']),dimensions:pick(item.dimensions,['publisherPlatform','placement','age','gender','country']),values:metricValues(item.values)})),coverage:{...pick(row.coverage,['complete','knownCount','eligibleCount','excludedCount']),reasons:reasons(row.coverage?.reasons || (row.coverage?.reason?[row.coverage.reason]:[]))}}));
    const output=result('advertising',records,{selection:data.selection,paginationUnit:'deliveries',deliveryCount:data.total,measurementCount:records.length,asOf:data.asOf,reachTotal:null,reachTotalReason:data.reachTotalReason,providerDelayHours:data.providerDelayHours,complete:false},{page:data.page,total:data.total,pageSize:20,hasMore:data.page<data.pages},{section:'advertising',tab:'results',record:query.campaignId});
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

const readers={catalog,orders,shipments,cash,reports,recommendations,business,alerts,imports,advertising,access,application};
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const sourceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stripClock=value=>Array.isArray(value)?value.map(stripClock):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['generatedAt','consultedAt','checkedAt','asOf','dataAsOf'].includes(key)).map(([key,item])=>[key,stripClock(item)])):value;
async function collectServicePages(load,key) {
  let first=await load(1),rows=[...(first[key]||[])],p=1;
  while(first.total==null?((first[key]||[]).length===20):p*20<first.total){
    const next=await load(++p);rows.push(...(next[key]||[]));
    if(!(next[key]||[]).length)break;
    first={...first,[key]:next[key]};
  }
  return {...first,[key]:rows};
}
async function filteredSocialResults(tx,query) {
  const {mode,network,objective,status,...filters}=query;
  if([mode,network,objective,status].every(value=>value===undefined))return getSocialResults(tx,filters);
  const campaigns=await collectServicePages(p=>listSocialCampaigns(tx,{mode,network,objective,status,page:p}),'campaigns');
  const selected=campaigns.campaigns.filter(row=>!query.campaignId||row.id===query.campaignId),deliveries=[],measurements=[];
  let base={selection:{from:query.from||null,to:query.to||null},providerDelayHours:48,reachTotalReason:'not_deduplicable_between_deliveries'};
  for(const campaign of selected){
    const first=await getSocialResults(tx,{...filters,campaignId:campaign.id,page:1});base=first;
    deliveries.push(...first.deliveries);measurements.push(...first.measurements);
    for(let page=2;(page-1)*20<first.total;page++){const next=await getSocialResults(tx,{...filters,campaignId:campaign.id,page});deliveries.push(...next.deliveries);measurements.push(...next.measurements);}
  }
  const page=Number(query.page||1),chosen=slice(deliveries,page),ids=new Set(chosen.map(row=>row.id));
  return {...base,deliveries:chosen,measurements:measurements.filter(row=>ids.has(row.deliveryId)),page,total:deliveries.length,pages:Math.max(1,Math.ceil(deliveries.length/20))};
}
async function readSelection(tx,session,request) {
  const {domain,query,select}=request,first=await readers[domain](tx,query,session,select);
  if(first._allRecords)return first;
  const records=[...first.records],evidence=[...first.evidence];
  // Enumerate inside this one snapshot. Counts/aggregates never describe just examples.
  const initial=first.pagination.page;
  if(initial>1){const preceding=await readers[domain](tx,{...query,page:1},session,select);records.unshift(...preceding.records);evidence.unshift(...preceding.evidence);for(let p=2;p<initial;p++){const prior=await readers[domain](tx,{...query,page:p},session,select);records.splice((p-1)*20,0,...prior.records);evidence.push(...prior.evidence);}}
  let current=first,p=initial;
  while(current.pagination.hasMore){current=await readers[domain](tx,{...query,page:++p},session,select);records.push(...current.records);evidence.push(...current.evidence);if(!current.records.length)break;}
  const summary={...first.summary};
  if(domain==='orders')Object.assign(summary,{states:distribution(records,'status'),paymentStates:distribution(records,'paymentState'),totalMinor:exactSum(records,'totalMinor'),collectedMinor:exactSum(records,'collectedMinor'),dueMinor:exactSum(records,'dueMinor'),legacyReview:records.filter(row=>row.paymentState==='legacy_review').length});
  if(domain==='shipments')Object.assign(summary,{states:distribution(records,'status'),carriers:distribution(records,'carrier'),incidents:records.filter(row=>['incident','return_in_transit'].includes(row.status)).length});
  if(['business','alerts','imports','advertising','access'].includes(domain))summary.states=distribution(records,domain==='access'?'active':domain==='business'?'active':'state');
  return {...first,...(domain==='advertising'&&query.kind==='results'?{_recordsTotal:records.length}:{}),records,evidence:[...new Map(evidence.map(item=>[item.id,item])).values()],summary};
}
function exactSum(rows,key){if(rows.some(row=>!Number.isSafeInteger(row[key])))return null;const total=rows.reduce((n,row)=>n+BigInt(row[key]),0n);if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))fail('Total fuera de rango seguro.');return Number(total);}
function projectSelection(request,source){
  const {domain,query,select}=request,allowed=assistantReadFields(domain,query,select);
  for(const field of select.fields||[])if(!allowed.includes(field))fail(`Campo no aplicable: ${field}.`);
  let mode=select.mode==='auto'?(query.id||query.record||query.taskId||query.snapshotId||['campaign','analysis','business-result'].includes(query.kind)||query.kind?.endsWith('preview')||domain==='business'&&(!query.resource||['settings','storefront'].includes(query.resource))?'detail':query.metric?'records':'summary'):select.mode;
  let records=source.records;
  const start=query.page?(Number(query.page)-1)*20:0;
  if(mode==='summary'&&domain!=='reports'){
    const examples=select.limit===null?records.length:select.limit??1;
    const exampleFields=['id','version','kind','title','name','number','status','state','active','productType','price','totalMinor','paymentState','collectedMinor','dueMinor','carrier','tracking','category','reason','value','unit','actionLabel','href','evidenceIds'];
    records=records.slice(start,start+examples).map(row=>Object.fromEntries(Object.entries(row).filter(([key,value])=>select.fields?['id','version',...select.fields].includes(key):exampleFields.includes(key)&&(scalar(value)||key==='evidenceIds'))));
  }else if(select.limit!=null)records=records.slice(start,start+select.limit);
  else if(start)records=records.slice(start);
  if(domain==='reports'&&select.mode==='groups'&&select.sortBy&&!select.fields){const fields=['id','kind','label',...(['products','sellers'].includes(select.group)?['units']:[]),select.sortBy,...(['contributionMinor','knownContributionMinor'].includes(select.sortBy)?['complete','knownCount','eligibleCount']:[])];records=records.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>fields.includes(key))));}
  if(domain==='recommendations')records=records.map(row=>{if(!row.evidenceIds)return row;const primary=source.evidence.filter(item=>row.evidenceIds.includes(item.id)&&['value','currentValue','previousValue','difference','changeBps'].includes(item.field));const chosen=primary.length?primary.slice(-4):source.evidence.filter(item=>row.evidenceIds.includes(item.id)).slice(-4);return {...row,evidenceIds:chosen.map(item=>item.id)};});
  if(select.fields)records=records.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>['id','version',...select.fields].includes(key))));
  return {mode,records};
}
// A fragment preserves full fields whenever possible. Only oversized fields are
// split, with explicit source coordinates; strings split on Unicode code points.
const needsFieldFragments=value=>typeof value==='string'?(value.length>2000||bytes(value)>1800):Array.isArray(value)?value.length>20||value.some(needsFieldFragments):value&&typeof value==='object'?Object.values(value).some(needsFieldFragments):false;
function* valuePieces(value,path='',force=false){
  if(typeof value==='string'&&(value.length>2000||bytes(value)>1800)){let offset=0,part='';for(const character of value){if(part.length+character.length>1800||bytes(part+character)>1800){yield {value:part,locations:[{path,offset,total:value.length}]};offset+=part.length;part='';}part+=character;}if(part)yield {value:part,locations:[{path,offset,total:value.length}]};return;}
  const safeShape=item=>typeof item==='string'?item.length<=2000:Array.isArray(item)?item.length<=20&&item.every(safeShape):item&&typeof item==='object'?Object.values(item).every(safeShape):true;
  const leaves=item=>item&&typeof item==='object'?Object.values(item).reduce((n,child)=>n+leaves(child),0):1;
  if(!force&&bytes(value)<=2400&&safeShape(value)&&leaves(value)<=4){yield {value,locations:[]};return;}
  if(Array.isArray(value)){
    for(let offset=0;offset<value.length;offset++)for(const piece of valuePieces(value[offset],`${path}.${offset}`))yield {value:[piece.value],locations:[{path,offset,total:value.length},...piece.locations]};
  }else if(value&&typeof value==='object'){
    for(const [key,item] of Object.entries(value)){if(force&&['id','version'].includes(key)&&Object.keys(value).length>2)continue;for(const piece of valuePieces(item,path?`${path}.${key}`:key))yield {value:{[key]:piece.value},locations:piece.locations};}
  }else yield {value,locations:[]};
}
function originalField(field,locations){
  let result=field;
  for(const location of locations.filter(item=>item.total!=null&&item.path&& !/^\d+$/.test(item.path))){const prefix=`${location.path}.0`;if(result===prefix||result.startsWith(`${prefix}.`))result=`${location.path}.${location.offset}${result.slice(prefix.length)}`;}
  return result;
}
function prioritizeRecord(record){const order=['id','version','title','name','number','status','unitCostMinor','stockQuantity','price','totalMinor','collectedMinor','dueMinor'];return Object.fromEntries(Object.entries(record).sort(([a],[b])=>(order.includes(a)?order.indexOf(a):100)-(order.includes(b)?order.indexOf(b):100)));}
function fragmentEvidence(request,record,locations,source){
  const {domain}=request,entityId=record.id??record.campaignId??null;
  let refs;
  if(domain==='application'&&record.taskId)refs=source.evidence.filter(item=>item.entityId===record.taskId);
  else if(domain==='advertising'&&request.query.kind==='results'&&(record.values||record.rows)){refs=[];const captures=[{prefix:'metric',values:record.values||{}},...(record.rows||[]).map((row,index)=>({prefix:originalField(`rows.${index}`,locations),values:row.values||{}}))];for(const capture of captures)for(const [metric,value] of Object.entries(capture.values)){if(!Object.hasOwn(value,'value'))continue;const field=`${capture.prefix}:${metric}`,origin=source.evidence.find(item=>item.entityId===entityId&&item.field===field);if(origin)refs.push(origin);}}
  else if(domain==='reports'&&request.select.mode==='compare'&&record.id)refs=source.evidence.filter(item=>item.entityId===record.id);
  else if(record.evidenceIds)refs=source.evidence.filter(item=>record.evidenceIds.includes(item.id));
  else if(domain==='reports'&&record.id&&Object.hasOwn(record,'value')&&source.evidence.some(item=>item.field===`metric:${record.id}`))refs=source.evidence.filter(item=>item.field===`metric:${record.id}`);
  else {
    refs=evidenceFor(domain,[record],null).map(item=>{
      const field=originalField(item.field,locations),origin=source._evidenceByField?.get(`${entityId}:${field}`);
      const originalRecord=source._recordsById?.get(entityId)||record,target=typeof source._view==='function'?source._view(originalRecord):source._view;
      const href=origin?.href??(target===null?null:hrefFor(target));
      const asOf=origin?.asOf||source._options?.asOf||(domain==='shipments'?originalRecord.sourceAsOf:originalRecord.dataAsOf||originalRecord.updatedAt)||null;
      const groupCoverage=request.select.mode==='groups'&&['products','sellers'].includes(request.select.group)?(['contributionMinor','knownContributionMinor'].includes(field)?coverage(originalRecord):{state:'complete',knownCount:null,eligibleCount:null,excludedCount:null,reasons:[]}):null;
      const sourceCoverage=origin?.coverage||source._options?.sourceCoverage||groupCoverage||(typeof originalRecord.complete==='boolean'?coverage(originalRecord):null)||item.coverage;
      const unit=origin?.unit||item.unit||(['value','knownValue'].includes(field)?originalRecord.unit:null)||(['units','quantity','orderCount'].includes(field)?'count':null);
      const textPiece=locations.find(location=>location.path===field);
      const dataCoverage=textPiece?{...sourceCoverage,state:textPiece.offset+String(item.value).length<textPiece.total?'partial':'complete',reasons:textPiece.offset+String(item.value).length<textPiece.total?['unread_fields']:[]}:sourceCoverage;
      return createAssistantEvidence({...origin,...item,field,label:origin?.label||item.label,href,asOf,asOfPrecision:precision(asOf),unit,formattedValue:typeof item.value==='string'?null:origin?.formattedValue||(unit==='minor'?money(item.value,originalRecord.currency||(domain==='advertising'?'moneda no informada':'COP')):item.formattedValue),coverage:dataCoverage});
    });
  }
  return refs;
}
function fragmentSelection(request,source,projected,sourceStamp,consultedAt,queryClock){
  const {domain,query,select}=request;
  const coreSummary=['bounds','snapshot','comparison','detailBounds','detailSummary','adjustments','requestedAdjustments','states','types','stock','paymentStates','carriers'];
  const baseSummary=Object.fromEntries(Object.entries(source.summary).filter(([key,value])=>(scalar(value)&&bytes(value)<500)||(coreSummary.includes(key)&&bytes(value)<2000)));
  const units=[];
  const scalarSummary=Object.fromEntries(Object.entries(baseSummary).filter(([key,value])=>(typeof value==='number'||value===null&&/(?:Minor|Total|Count|count)$/.test(key))&&!['dataRevision','evidenceTruncated'].includes(key)));
  const summaryEvidence=Object.entries(scalarSummary).map(([key,value])=>{const existing=source.evidence.find(item=>item.entityId===null&&item.field===key);return existing||createAssistantEvidence({domain,field:`summary:${key}`,label:labels[key]||key,value,unit:key.endsWith('Minor')?'minor':key==='count'?'count':null,formattedValue:key.endsWith('Minor')?money(value):null,href:source._view&&typeof source._view!=='function'?hrefFor(source._view):null});});
  const nestedCounts=evidenceFor(domain,[pick(baseSummary,['stock','states','types','paymentStates','carriers'])],null).map(item=>createAssistantEvidence({...item,field:`summary:${item.field}`,unit:'count'}));
  for(const evidence of nestedCounts)units.push({summary:{},records:[],evidence:[evidence],locations:[],recordIndex:null});
  for(const evidence of (query.metric?source.evidence.filter(item=>item.field===`metric:${query.metric}`):[]))units.push({summary:{},records:[],evidence:[evidence],locations:[],recordIndex:null});
  for(const evidence of summaryEvidence)units.push({summary:{},records:[],evidence:[evidence],locations:[],recordIndex:null});
  const summaryRest=Object.fromEntries(Object.entries(source.summary).filter(([key])=>!Object.hasOwn(baseSummary,key)));
  for(const [recordIndex,record] of projected.records.entries()){
    const fullRefs=fragmentEvidence(request,record,[],source);
    if(bytes({record,evidence:fullRefs})<=7000&&!needsFieldFragments(record))units.push({summary:{},records:[record],evidence:fullRefs,locations:[],recordIndex});
    else for(const piece of valuePieces(prioritizeRecord(record),'',true)){
      const row={...pick(record,['id','version']),...piece.value};
      units.push({summary:{},records:[row],evidence:fragmentEvidence(request,row,piece.locations,source),locations:piece.locations,recordIndex});
    }
  }
  if(Object.keys(summaryRest).length) {
    if(bytes(summaryRest)<=6000&&!needsFieldFragments(summaryRest))units.push({summary:summaryRest,records:[],evidence:[],locations:[],recordIndex:null});
    else for(const piece of valuePieces(summaryRest))if(Object.keys(piece.value).length)units.push({summary:piece.value,records:[],evidence:[],locations:piece.locations,recordIndex:null});
  }
  // Summary-only scalar facts (e.g. current cash available) remain citable.
  const used=new Set(units.flatMap(unit=>unit.evidence.map(item=>item.id)));
  const summaryFacts=source.evidence.filter(item=>!used.has(item.id)&&(domain==='recommendations'||!source.records.some(row=>(row.id??row.campaignId??null)===item.entityId))&&!(domain==='reports'&&!query.metric&&select.fields&&!select.fields.includes('value')&&item.field.startsWith('metric:')));
  for(const evidence of summaryFacts)units.push({summary:{},records:[],evidence:[evidence],locations:[],recordIndex:null});
  if(!units.length)units.push({summary:{},records:[],evidence:[],locations:[],recordIndex:null});
  const fragments=[];
  const selection=projected.mode==='summary'?'summary':projected.mode==='detail'?'detail':select.limit!=null?'sample':'all';
  const interval=source._interval||(query.startDate?{startDate:query.startDate,endDateExclusive:query.endDateExclusive,closed:query.endDateExclusive<=consultedAt.slice(0,10)}:null);
  const make=(unit,index,hasMore)=>{
    const evidence=[...new Map(unit.evidence.map(item=>[item.id,item])).values()];
    const metadata=Object.fromEntries(evidence.map(item=>{const record=source.records.find(row=>row.id===item.entityId)||unit.records.find(row=>row.id===item.entityId)||unit.records[0];const semantic=item.field.startsWith('metric:')?item.field.slice(7):domain==='reports'&&record?.id?query.metric||record.id:`${domain}:${item.field}`;const evidenceInterval=domain==='reports'&&select.mode==='compare'?(item.field.startsWith('previous.')?source._comparisonIntervals.previous:item.field.startsWith('current.')?source._comparisonIntervals.current:interval):interval;return [item.id,{currency:['minor','COP','minor_currency'].includes(item.unit)?record?.currency|| (domain==='advertising'?null:'COP'):null,interval:evidenceInterval,semantic,sourceStamp}];}));
    const unknown=source.summary.unlocatedDates>0||evidence.some(item=>item.value===null||item.coverage?.state!=='complete'&&!(item.coverage?.state==='partial'&&item.coverage.reasons.length>0&&item.coverage.reasons.every(reason=>['unread_fields','field_truncated'].includes(reason))));
    const sourceStale=Boolean(source.summary.stale||source.summary.snapshot&&source.summary.snapshot.state!=='current');
    return {records:unit.records,summary:{...baseSummary,...unit.summary,...(unit.coordinates?.length?{fragments:unit.coordinates}:{} )},pagination:{page:index+1,pageSize:20,total:source.pagination.total,hasMore},evidence,retrieval:{complete:!hasMore,selection,recordsRead:new Set(unit.coordinates?.filter(item=>item.recordIndex!==null).map(item=>item.recordIndex)).size||unit.records.length,recordsTotal:source._recordsTotal??source.pagination.total,sourceStamp,consultedAt,reasons:[...(hasMore?['unread_pages']:[]),...(hasMore&&unit.locations.length?['unread_fields']:[]),...(unknown?['unknown_data']:[]),...(sourceStale?['stale_source']:[])]},continuation:hasMore?{cursor:null,label:`Continuar lectura de ${domain}`,remainingRecords:source.pagination.total===null?null:Math.max(0,projected.records.length-(unit.lastRecord??-1)-1)}:null,_continuation:hasMore?{domain,query,select,state:{fragmentIndex:index+1,restarts:0,asOf:queryClock},sourceStamp}:null,_evidenceMetadata:metadata,_dataset:datasetFor(request,source,sourceStamp)};
  };
  let packed={summary:{},records:[],evidence:[],locations:[],coordinates:[]};
  for(const unit of units){
    const mergeable=unit.records.length&&packed.records.length&&unit.recordIndex===packed.coordinates.at(-1)?.recordIndex&&!Object.keys(unit.records[0]).some(key=>!['id','version'].includes(key)&&Object.hasOwn(packed.records.at(-1),key));
    const records=mergeable?[...packed.records.slice(0,-1),{...packed.records.at(-1),...unit.records[0]}]:[...packed.records,...unit.records];
    const coordinates={recordIndex:unit.recordIndex,recordPosition:unit.records.length?(mergeable?records.length-1:packed.records.length):null,paths:unit.locations};
    const candidate={summary:{...packed.summary,...unit.summary},records,evidence:[...packed.evidence,...unit.evidence],locations:[...packed.locations,...unit.locations],coordinates:[...packed.coordinates,coordinates],lastRecord:unit.recordIndex??packed.lastRecord};
    const overlaps=Object.keys(unit.summary).some(key=>Object.hasOwn(packed.summary,key));
    if(packed.coordinates.length&&(overlaps||candidate.records.length>PAGE_SIZE||bytes(make(candidate,fragments.length,true))>ASSISTANT_LIMITS.readFragmentBytes-1024)){
      fragments.push(packed);packed={...unit,coordinates:[{...coordinates,recordPosition:unit.records.length?0:null}],lastRecord:unit.recordIndex};
    }else packed=candidate;
  }
  if(packed.coordinates.length)fragments.push(packed);
  const seen=new Set();
  return fragments.map((unit,index)=>{const output=make(unit,index,index<fragments.length-1);const fresh=new Set(unit.coordinates.map(item=>item.recordIndex).filter(value=>value!==null&&!seen.has(value)));output.retrieval.recordsRead=fresh.size;for(const recordIndex of fresh)seen.add(recordIndex);if(bytes(output)>ASSISTANT_LIMITS.readFragmentBytes)fail('Un campo autorizado excede el tamaño del fragmento.');return output;});
}
function datasetFor(request,source,sourceStamp){
  if(source._dataset)return {...source._dataset,sourceStamp};
  const {domain,query}=request;
  const allowed={catalog:['kind','q','status','productType'],orders:['q','status','paymentStatus','seller','product','platform','source','carrier','issue','lookup'],shipments:['q','status','carrier','orderId','sourceId','platformId','issue','eventStatus'],cash:['account','person','source','status','category'],reports:['seller','product','platform','source','carrier','status','metric','issue'],recommendations:['seller','product','platform','source','carrier','status'],business:['active','source','platform'],alerts:['state','severity','type','person'],imports:['source','state','sheet','rowNumber','q'],advertising:['q','state','campaignId','mode','network','objective','integrationMethod','scope','dimension','from','to','status','deliveryId'],access:[],application:[]};
  const filters=Object.fromEntries(Object.entries(query).filter(([key,value])=>allowed[domain].includes(key)&&scalar(value)));
  return {domain,resource:query.resource||query.kind||(domain==='catalog'?query.kind||'catalog':domain==='orders'?'orders':domain==='shipments'?'shipments':null),recordId:query.id||query.record||query.taskId||query.campaignId||null,filters,startDate:query.startDate||query.startOn||query.from||null,endDateExclusive:query.endDateExclusive||query.endOnExclusive||(query.to?addDays(query.to,1):null),asOf:query.asOf||source.summary.asOf||source.summary.dataAsOf||null,sourceStamp};
}
function requireSession(session){if(!session?.user?.id){const error=new Error('Se requiere una sesión administrativa.');error.code='ASSISTANT_AUTH_REQUIRED';throw error;}}
async function readRequest(store,session,request,descriptor=null){
  return store.readSnapshot(async raw=>{
    const tx=snapshotFacade(raw),queryClock=descriptor?.state?.asOf||new Date().toISOString();
    tx._assistantNow=queryClock;
    const source=await readSelection(tx,session,request);
    source._evidenceByField=new Map(source.evidence.map(item=>[`${item.entityId}:${item.field}`,item]));
    source._recordsById=new Map(source.records.map(row=>[row.id??row.campaignId??null,row]));
    const stamp=source._sourceStamp||sourceHash({domain:request.domain,query:request.query,records:stripClock(source.records),summary:stripClock(source.summary)});
    const projected=projectSelection(request,source),fragments=fragmentSelection(request,source,projected,stamp,new Date().toISOString(),queryClock);
    if(descriptor&&descriptor.sourceStamp!==stamp){
      const restarted=descriptor.state?.restarts||0,output=fragments[0];
      output.retrieval.complete=false;output.retrieval.reasons=[...new Set([...output.retrieval.reasons,'source_changed'])];
      if(restarted){output.continuation=null;output._continuation=null;}
      else {output.continuation={cursor:null,label:'Reiniciar lectura porque cambió la fuente',remainingRecords:source.pagination.total};output._continuation={...request,state:{fragmentIndex:0,restarts:1,asOf:queryClock},sourceStamp:stamp};}
      return output;
    }
    const index=descriptor?.state?.fragmentIndex||0,output=fragments[index];
    if(!output)fail('La continuación ya no pertenece a esta selección.');
    if(output._continuation)output._continuation.state.restarts=descriptor?.state?.restarts||0;
    return output;
  });
}
/** One coherent, write-incapable snapshot; public cursors require a workspace. */
export async function readAssistantBusiness(store,session,input={}){
  requireSession(session);
  const request=validateAssistantReadRequest(input);
  if(request.select.cursor)fail('El cursor requiere un trabajo autorizado.');
  return readRequest(store,session,request);
}
/** Engine-only descriptors are loaded from a workspace owned by this session. */
export async function resumeAssistantBusinessRead(store,session,descriptor){
  requireSession(session);
  queryObject(descriptor);
  const request=validateAssistantReadRequest({domain:descriptor.domain,query:descriptor.query,select:descriptor.select});
  if(request.select.cursor||!descriptor.sourceStamp||!Number.isSafeInteger(descriptor.state?.fragmentIndex)||descriptor.state.fragmentIndex<0)fail('Descriptor de continuación no válido.');
  return readRequest(store,session,request,descriptor);
}
