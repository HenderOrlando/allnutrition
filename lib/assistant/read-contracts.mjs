import { fail, integer, text } from '../validation-core.mjs';
import { schemas, settingsFields, contentStates, orderStates, paymentStates, shipmentStates } from '../schema.mjs';
import { BUSINESS_PERIODS, businessDate, instant } from '../business/dates.mjs';

export const ASSISTANT_REPORT_METRICS=Object.freeze('netProductSales shippingRevenue costOfGoods giftCost shippingCosts platformFees commissions fixedSalary bonuses advertisingExpenses operatingExpenses otherExpenses grossMargin contribution operatingResult cashAvailable onTimeDeliveries shipmentReturnRate recognizedOrders soldUnits giftUnits returnedUnits cancelledUnits customerCollections platformPending payrollEarned payrollPaid payrollOutstanding shipmentCount shippedOrders transitDays cashClosingDifference'.split(' '));
const domains=['catalog','orders','shipments','cash','reports','recommendations','business','alerts','imports','advertising','access','application'];
const groups=['products','sellers','accounts','payroll','shipments','returns','costs'];
const queryKeys={catalog:'kind id q status page productType',orders:'id page q status paymentStatus seller product platform source carrier issue lookup startDate endDateExclusive',shipments:'id page q status carrier orderId sourceId platformId issue startDate endDateExclusive eventStatus',cash:'kind resource asOf page personId startOn endOnExclusive bonusMinor discountMinor reason accountId closingOn record q startDate endDateExclusive account source status person category',reports:'period anchor filters snapshotId mode page metric issue startDate endDateExclusive compareTo',recommendations:'period anchor filters page startDate endDateExclusive',business:'resource id active source platform page',alerts:'kind id state severity type person page',imports:'id page source state q sheet rowNumber',advertising:'kind page q mode objective status network id campaignId deliveryId integrationMethod scope dimension asOf from to state',access:'page',application:'taskId page'};
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail(`${label} no válida.`);return value;}
function only(value,keys){for(const key of Object.keys(value))if(!keys.includes(key))fail(`Filtro no permitido: ${key}.`);}
export function validateAssistantSelect(value={mode:'auto'}) {
  if(value==null)value={mode:'auto'};
  object(value,'Selección');only(value,['mode','fields','metrics','group','sortBy','direction','limit','cursor']);
  const result={mode:value.mode??'auto'};
  if(!['auto','summary','records','detail','groups','compare'].includes(result.mode))fail('Modo de selección no válido.');
  for(const key of ['fields','metrics'])if(value[key]!==undefined){if(!Array.isArray(value[key])||!value[key].length||value[key].length>12)fail(`Selección de ${key} no válida.`);result[key]=value[key].map(item=>text(item,key,100,true));if(new Set(result[key]).size!==result[key].length)fail('Campos repetidos.');}
  if(result.metrics?.some(key=>!ASSISTANT_REPORT_METRICS.includes(key)))fail('Métrica no válida.');
  if(value.group!==undefined){if(result.mode!=='groups'||!groups.includes(value.group))fail('Grupo no válido.');result.group=value.group;}
  if(result.mode==='groups'&&!result.group)fail('Selecciona un grupo.');
  for(const key of ['sortBy','direction'])if(value[key]!==undefined){if(result.mode!=='groups')fail('El orden requiere un grupo.');result[key]=text(value[key],key,100,true);}
  if(result.direction&&!['asc','desc'].includes(result.direction))fail('Dirección no válida.');
  if(value.limit!==undefined)result.limit=value.limit===null?null:integer(value.limit,'Límite',1,20);
  if(value.cursor!==undefined)result.cursor=text(value.cursor,'Cursor',100,true);
  return result;
}
export function validateAssistantReadRequest(value) {
  object(value,'Lectura');only(value,['domain','query','select']);
  if(!domains.includes(value.domain))fail('Dominio de lectura no disponible.',422);
  const query=structuredClone(object(value.query===undefined?{}:value.query,'Consulta'));only(query,queryKeys[value.domain].split(' '));
  for(const [key,item] of Object.entries(query)){
    if(['filters','compareTo'].includes(key)){
      object(item,key);only(item,key==='filters'?['seller','product','platform','carrier','status','account','source']:['startDate','endDateExclusive']);
      for(const [partKey,part] of Object.entries(item))item[partKey]=text(part,key,150,true);
    }else if(key==='active'){if(typeof item!=='boolean')fail('Filtro activo no válido.');}
    else if(['page','rowNumber','bonusMinor','discountMinor'].includes(key))query[key]=integer(Number(item),key,key==='page'||key==='rowNumber'?1:0,key==='page'?1000000:key==='rowNumber'?10001:Number.MAX_SAFE_INTEGER);
    else if(item!==null)query[key]=text(item,key,key==='reason'?1000:key==='q'||key==='carrier'?200:150);
  }
  const select=validateAssistantSelect(value.select);
  if((select.mode==='groups'||select.mode==='compare'||select.metrics)&&value.domain!=='reports')fail('La selección requiere informes.');
  validateQueryBranch(value.domain,query,select);
  if(select.mode==='detail'&&!query.id&&!query.record&&!query.taskId&&!query.snapshotId&&!query.metric&&!['campaign','analysis','business-result','payroll-preview','closing-preview'].includes(query.kind)&&!(value.domain==='business'&&(!query.resource||['settings','storefront'].includes(query.resource)))&&!(value.domain==='cash'&&(!query.resource||query.resource==='overview')))fail('El detalle requiere una identidad inequívoca.');
  for(const field of select.fields||[])if(!assistantReadFields(value.domain,query,select).includes(field))fail(`Campo no aplicable: ${field}.`);
  if(select.mode==='groups'&&select.sortBy&&select.sortBy!=='id'&&!groupNumericFields[select.group].includes(select.sortBy))fail('Campo de orden no permitido.');
  if(['orders','shipments','reports','recommendations'].includes(value.domain)&&(query.startDate!=null||query.endDateExclusive!=null)){
    const start=businessDate(query.startDate),end=businessDate(query.endDateExclusive);
    if(start>=end)fail('El inicio del intervalo debe ser anterior al fin.');
    if(['reports','recommendations'].includes(value.domain)&&(query.period!==undefined||query.anchor!==undefined))fail('No mezcles intervalo y período.');
  }
  return {domain:value.domain,query:structuredClone(query),select};
}

function option(value,allowed,label){if(value!==undefined&&!allowed.includes(value))fail(`${label}: opción no válida.`);}
function detail(query,key,extra=[]){if(query[key]!=null)only(query,[key,...extra]);}
function validateQueryBranch(domain,query,select){
  if(query.period!==undefined)option(query.period,BUSINESS_PERIODS,'Período');
  for(const key of ['startDate','endDateExclusive','anchor','from','to','startOn','endOnExclusive','closingOn'])if(query[key]!=null)businessDate(query[key]);
  if(query.compareTo){only(query.compareTo,['startDate','endDateExclusive']);const start=businessDate(query.compareTo.startDate),end=businessDate(query.compareTo.endDateExclusive);if(start>=end)fail('Intervalo de comparación no válido.');if(select.mode!=='compare'||query.startDate==null)fail('compareTo requiere comparación de intervalos.');}
  if(query.from&&query.to&&query.from>query.to)fail('Intervalo no válido.');
  if(query.filters?.status!==undefined)option(query.filters.status,[...orderStates,...shipmentStates].map(item=>item.value),'Estado');
  if(domain==='catalog'){
    option(query.kind,Object.keys(schemas),'Tipo de catálogo');option(query.status,contentStates.map(item=>item.value),'Estado');option(query.productType,['product','gift'],'Tipo de producto');
    if(query.productType!==undefined&&query.kind!=='products')fail('El tipo requiere productos.');
    detail(query,'id',['kind']);if(query.id&&!query.kind)fail('Selecciona el tipo del registro.');
  }else if(domain==='orders'){
    detail(query,'id');option(query.status,orderStates.map(item=>item.value),'Estado');option(query.paymentStatus,paymentStates.map(item=>item.value),'Cobro');option(query.lookup,['identity'],'Búsqueda');
    option(query.issue,['incident','pending_settlement','missing_data','missing_cost','legacy_review'],'Incidencia');
    if(query.lookup&&!query.q)fail('Escribe la identidad del pedido.');
  }else if(domain==='shipments'){
    detail(query,'id');option(query.status,shipmentStates.map(item=>item.value),'Estado');option(query.eventStatus,shipmentStates.map(item=>item.value),'Evento');option(query.issue,['orphan','incident','missing_data'],'Incidencia');
    if(query.eventStatus!==undefined&&query.startDate==null)fail('El estado de evento requiere intervalo.');
  }else if(domain==='reports'){
    option(query.mode,['live','snapshot','list'],'Modo');
    option(query.metric,ASSISTANT_REPORT_METRICS,'Métrica');
    if(query.issue&&!query.metric)fail('Selecciona una métrica.');
    if(query.mode==='snapshot'){only(query,['mode','snapshotId','page','metric','issue']);if(!query.snapshotId)fail('Selecciona un informe guardado.');if(select.mode==='compare'||query.issue==='comparison_elapsed')fail('La comparación requiere un informe en vivo.');}
    else if(query.mode==='list'){only(query,['mode','period','anchor','filters','page']);if(['groups','compare'].includes(select.mode)||select.metrics)fail('La lista de copias no admite métricas ni grupos.');}
    else if(query.snapshotId!==undefined)fail('El informe en vivo no admite snapshotId.');
  }else if(domain==='business'){
    const resource=query.resource||'settings';option(resource,['settings','storefront','people','platforms','sources','accounts','profiles'],'Recurso');
    if(['settings','storefront'].includes(resource))only(query,['resource']);else detail(query,'id',['resource']);
    if(query.source!==undefined&&resource!=='profiles'||query.platform!==undefined&&resource!=='sources'||query.active!==undefined&&resource==='profiles')fail('Filtro no válido para este recurso.');
  }else if(domain==='cash'){
    if(query.kind==='payroll-preview')only(query,['kind','personId','startOn','endOnExclusive','bonusMinor','discountMinor','reason']);
    else if(query.kind==='closing-preview')only(query,['kind','accountId','closingOn']);
    else{
      option(query.kind,['query'],'Consulta');const resource=query.resource||'overview';
      const filters={overview:['asOf'],movements:['account'],settlements:['source','status'],expenses:['person','category'],payroll:['person','status'],closings:['account','status']};
      option(resource,Object.keys(filters),'Recurso');
      only(query,['kind','resource','page',...(resource==='overview'?filters.overview:['record','q','startDate','endDateExclusive',...filters[resource]])]);
      if(query.record)only(query,['kind','resource','record',...(resource==='closings'?['account']:[])]);
      if(query.asOf!=null)businessDate(query.asOf);
    }
  }else if(domain==='alerts'){
    const kind=query.kind||'alerts';option(kind,['alerts','rules'],'Consulta');
    if(kind==='rules')only(query,['kind','id','page']);
    detail(query,'id',['kind']);
    option(query.state,['active','open','acknowledged','resolved','all'],'Estado');option(query.severity,['critical','warning','info'],'Severidad');
  }else if(domain==='imports'){
    if(query.id){only(query,['id','page','state','q','sheet','rowNumber']);if(query.rowNumber!=null&&!query.sheet)fail('La fila requiere una hoja.');}
    else only(query,['page','source','state']);
  }else if(domain==='advertising'){
    const kind=query.kind||'campaigns';
    const keys={campaigns:['page','q','mode','objective','status','network','from','to'],campaign:['id'],results:['campaignId','deliveryId','integrationMethod','scope','dimension','asOf','page','from','to','mode','network','objective','status'],'business-result':['campaignId','asOf'],analysis:['campaignId','asOf'],assets:['page','state'],connections:['page']};
    option(kind,Object.keys(keys),'Consulta');only(query,['kind',...keys[kind]]);
    option(query.mode,['organic','paid'],'Modo');option(query.network,['facebook','instagram'],'Red');option(query.integrationMethod,['api','browser'],'Origen');option(query.scope,['paid','organic','mixed'],'Alcance');option(query.dimension,['aggregate','daily','placement','age_gender','country'],'Dimensión');
    if(query.asOf!=null)instant(query.asOf);
  }else if(domain==='application')detail(query,'taskId');
}

export const baseFields=['id','version','createdAt','updatedAt'];
export const lineFields=['lineId','itemId','kind','title','presentation','quantity','unitPriceMinor','discountMinor','unitCostMinor','totalMinor'];
export const eventFields=['id','version','status','occurredOn','occurredAt','sourceAsOf','correctionOf','reason'];
export const financialFields=[...baseFields,'accountId','personId','sourceId','orderId','shipmentId','state','kind','category','concept','name','effectiveOn','occurredOn','reportedOn','incurredOn','startOn','endOnExclusive','closingOn','amountMinor','balanceMinor','netMinor','grossMinor','earnedMinor','paidMinor','offsetMinor','bonusMinor','discountMinor','reason','outstandingMinor','outstandingNetMinor','receivedNetMinor','creditMinor','availableCreditMinor','advanceAvailableMinor','advanceToApplyMinor','advanceAppliedMinor','amountToPayMinor','expectedMinor','countedMinor','differenceMinor','missingDayCount','accountName','personName','sourceName','reversalOf','documentType','documentId','documentVersion'];
export const resourceFields={people:[...baseFields,'name','active','role','seller','responsible'],platforms:[...baseFields,'name','active','type'],sources:[...baseFields,'name','platformId','active'],accounts:[...baseFields,'name','type','active','responsibleId','openingOn','openingBalanceMinor'],profiles:[...baseFields,'name','sourceId','formatVersion']};
export const agreementFields=['id','enabled','effectiveOn','effectiveFrom','effectiveTo','amountPerPeriodMinor','frequency','payDayOffset','rateBps','fixedMinor','basis','earnWhen','mode'];
export const alertFields=[...baseFields,'ruleId','type','entityType','entityId','state','severity','firstSeenAt','lastSeenAt','responsibleId','responsibleName','title','reason','count','amountMinor'];
export const factFields=['id','metric','orderId','orderNumber','shipmentId','productId','sellerId','personId','accountId','expenseId','sourceId','platformId','label','title','kind','category','occurredOn','occurredAt','sourceAsOf','estimatedDeliveryOn','value','unit','known','reason','quantity','units','amountMinor','contributionMinor','knownCount','eligibleCount'];
export const importFields=[...baseFields,'state','sourceId','platformId','profileId','profileVersion','completedAt','expiresAt','fileExpired','fileDiscarded','acceptedRevision'];
export const groupNumericFields={products:['units','netSalesMinor','knownContributionMinor','contributionMinor','orderCount','eligibleCount','knownCount'],sellers:['units','netSalesMinor','knownContributionMinor','contributionMinor','orderCount','eligibleCount','knownCount'],accounts:['openingMinor','openingEntriesMinor','inflowMinor','outflowMinor','transferMinor','balanceMinor'],payroll:['earnedMinor','paidMinor','outstandingMinor','advanceMinor','creditMinor','knownEarnedMinor','knownOutstandingMinor'],shipments:['orderNumber','transitDays'],returns:['orderNumber','quantity','salesCreditMinor','shippingCreditMinor','recoveredCostMinor'],costs:['amountMinor','paidMinor','outstandingMinor','creditMinor','orderNumber']};

export function assistantReadFields(domain,query,select){
  const shared=[...baseFields];
  if(domain==='advertising'){
    const fields={campaigns:[...shared,'name','state','mode','objective','budgetMinor','currency','platforms'],campaign:[...shared,'name','state','mode','objective','caption','headline','budgetMinor','currency','startAt','endAt','assetId','connectionId','platforms','deliveries'],results:['id','deliveryId','fetchedAt','currency','scope','dimension','integrationMethod','stale','newerPartial','selectedReason','definitionVersion','values','rows','coverage'],'business-result':['id','campaignId','value','valueMinor','knownMinor','currency','complete','knownCount','eligibleCount','excludedCount','reasons'],analysis:['campaignId','asOf','checkedAt','status','stale','commercialStale','metricStale','businessRevision','analysisVersion','observationComplete','primary','message','gaps','comparisons','recommendations'],assets:[...shared,'name','kind','state','contentType','width','height','durationSeconds','errorCode'],connections:[...shared,'state','integrationMethod','name','platform','connectedAt','disconnectedAt']};
    return fields[query.kind||'campaigns']||[];
  }
  if(domain==='application')return ['id','taskId','title','description','action','href','location','group','steps'];
  if(domain==='reports'&&query.mode==='list')return ['id','period','startOn','endOnExclusive','revision','generatedAt','state','staleSince','dataRevision','coverage'];
  if(domain==='alerts'&&query.kind==='rules')return [...shared,'type','enabled','responsibleId','scopeKey','reminderHours','selectedStatuses','thresholds'];
  if(domain==='cash'&&(!query.kind||query.kind==='query')&&(!query.resource||query.resource==='overview'))return [...shared,'name','type','active','responsibleId','responsibleName','balanceMinor','availableMinor'];
  const fields={catalog:[...shared,...(query.kind?[query.kind]:Object.keys(schemas)).flatMap(kind=>(schemas[kind]?.fields||[]).filter(field=>field.type!=='image').map(field=>field.name)),'kind','stockReserved','stockAvailable','availability','catalogIds','items'],orders:[...shared,'number','status','placedOn','totalMinor','sellerId','shippingMinor','shippingChargeMinor','paymentState','collectedMinor','dueMinor','shipments',...(query.id?['items','collections','returns','expenses','financialSummary','paymentSummary']:[])],shipments:[...shared,'orderId','orderNumber','platformId','platformName','sourceId','sourceName','status','carrier','tracking','estimatedDeliveryOn','sourceAsOf','knownEventOn','knownEventAt','costStatus',...(query.id?['events','assignments','orderLines']:[])],cash:[...financialFields,'lines','payments','activePayments','obligations','advances','carriedCredits','missingAccruals','receipts','type','active','responsibleId','responsibleName'],business:query.resource==='settings'||!query.resource?[...shared,'currency','timeZone','setupCompleted','reportsStartOn','reportGenerationTime','defaultReceiptAccountId','defaultPaymentAccountId','reportPeriods','rulesVersions','alertDefaults']:query.resource==='storefront'?['version',...settingsFields.map(field=>field.name)]:[...(resourceFields[query.resource]||[]),...(query.resource==='people'&&query.id?['salaryAgreements','commissionOverrides']:[]),...(query.resource==='profiles'?['sheets']:[])],alerts:[...alertFields,'action','enabled','scopeKey','reminderHours','selectedStatuses','thresholds'],imports:query.id?['id','sheet','rowNumber','state','entityType','errors']:importFields,access:['id','active'],recommendations:['id','category','title','reason','value','unit','actionLabel','href','evidenceIds'],reports:select.mode==='groups'?['id','kind','label','complete',...groupNumericFields[select.group],'personId','accountId','orderId','orderNumber','occurredOn','reason','category','breakdown','closing','shipmentId','tracking','carrier','status','sourceId','sourceAsOf','labelCreatedOn','collectedOn','deliveredOn','returnedOn','estimatedDeliveryOn']:query.metric?factFields:['id','label','value','unit','complete','knownValue','knownCount','eligibleCount','excludedCount','exclusionReasons','metric','current','previous','comparison']};
  return fields[domain]||[];
}
