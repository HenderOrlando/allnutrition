import { readAdminView, adminHref } from '../admin-view.mjs';
import { bogotaDate, periodBounds } from '../business/dates.mjs';
import { fail, text, integer } from '../validation-core.mjs';
import { ASSISTANT_REPORT_METRICS } from './read-contracts.mjs';

// Closed public projection: no component drafts, file contents or integration values.
const metrics = new Set(ASSISTANT_REPORT_METRICS);
const issues = new Set('missing negative_contribution positive_contribution positive_products positive_sellers late_deliveries shipping_returns shipping_absorbed costly_returns comparison_elapsed'.split(' '));
const rowStates = new Set('pending new updated unchanged conflict rejected ready skipped applied'.split(' '));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined && value[key] !== null && value[key] !== '').map(key => [key,value[key]]));
const nullableText = (value, label, max = 100) => value == null ? null : text(value,label,max,true);
function only(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Selección de Ali no válida.');
}
export function validateAssistantSelection(candidate, selection) {
  if (selection == null) return null;
  const view = readAdminView(candidate || {});
  if (selection.kind === 'report') {
    only(selection,['kind','snapshotId','metric','issue']);
    if (view.section !== 'reports') fail('La selección no corresponde al informe visible.');
    const snapshotId = nullableText(selection.snapshotId,'Informe'), metric = nullableText(selection.metric,'Métrica'), issue = nullableText(selection.issue,'Incidencia');
    if (metric && !metrics.has(metric) || issue && (!issues.has(issue) || !metric)) fail('Métrica o incidencia no válida.');
    const expectedSnapshot = view.record && !metrics.has(view.record) ? view.record : null;
    if (snapshotId !== expectedSnapshot || !snapshotId && metric !== (metrics.has(view.record) ? view.record : null) || issue !== (metric ? view.issue || null : null) || snapshotId && issue === 'comparison_elapsed') fail('La selección no corresponde al informe visible.');
    return {kind:'report',snapshotId,metric,issue};
  }
  if (selection.kind === 'import') {
    only(selection,['kind','batchId','sheet','rowNumber','state','q','page']);
    const batchId = text(selection.batchId,'Lote',100,true), sheet = nullableText(selection.sheet,'Hoja',200), state = nullableText(selection.state,'Estado');
    const rowNumber = selection.rowNumber == null ? null : integer(selection.rowNumber,'Fila',1,10001);
    if (view.section !== 'orders' || view.tab !== 'imports' || view.batch === 'new' || batchId !== view.batch || rowNumber !== null && !sheet || state && !rowStates.has(state)) fail('La selección no corresponde al lote visible.');
    return {kind:'import',batchId,sheet,rowNumber,state,q:text(selection.q ?? '', 'Búsqueda',100),page:integer(selection.page,'Página',1,100000)};
  }
  if (selection.kind === 'cash-closings') {
    only(selection,['kind','accountId','page','recordId']);
    const accountId = text(selection.accountId,'Cuenta',100,true), recordId = nullableText(selection.recordId,'Cierre');
    if (view.section !== 'cash' || (view.tab || 'overview') !== 'overview' || accountId !== view.account || recordId !== (view.record && view.record !== accountId ? view.record : null)) fail('La selección no corresponde a la cuenta visible.');
    return {kind:'cash-closings',accountId,page:integer(selection.page,'Página',1,100000),recordId};
  }
  fail('Selección de Ali no válida.');
}

export function resolveAssistantScope(context, {now = new Date()} = {}) {
  const view = readAdminView(context?.view || {}), selection = validateAssistantSelection(view,context?.selection);
  const reads = [], guideTaskIds = [];
  const add = (domain,query,select = {mode:'auto'}) => reads.push({domain,query,select});
  const period = {period:view.period || 'month',anchor:view.anchor || bogotaDate(now)};
  const list = keys => ({...pick(view,keys),page:view.page});
  const filters = pick(view,['seller','product','platform','carrier','status','account','source']);
  if (view.section === 'home') {
    if (view.issue === 'attention') add('alerts',{...list([]),...view.status ? {severity:view.status} : {}});
    else add('recommendations',period);
  } else if (['products','combos','catalogs','faqs','messages','shipping'].includes(view.section)) {
    add('catalog',view.record && view.record !== 'new' ? {kind:view.section,id:view.record} : {kind:view.section,...list(['q','status','productType'])});
  } else if (view.section === 'orders') {
    if (view.tab === 'imports') add('imports',selection ? {id:selection.batchId,...pick(selection,['sheet','rowNumber','state','q','page'])} : view.batch && view.batch !== 'new' ? {id:view.batch,page:1} : {...list(['source']),...view.status ? {state:view.status} : {}});
    else if (view.tab === 'shipments') add('shipments',view.record && view.record !== 'new' ? {id:view.record} : {...list(['q','status','carrier','issue']),...view.source ? {sourceId:view.source} : {},...view.platform ? {platformId:view.platform} : {}});
    else add('orders',view.record && view.record !== 'new' ? {id:view.record} : list(['q','status','paymentStatus','seller','product','platform','carrier','issue']));
  } else if (view.section === 'cash') {
    const tab = view.tab || 'overview';
    if (tab === 'overview') {
      add('cash',{resource:'overview'});
      if (view.account) add('cash',selection?.recordId || view.record && view.record !== view.account ? {resource:'closings',record:selection?.recordId || view.record,account:view.account} : {resource:'closings',account:view.account,page:selection?.page || 1});
    } else if (view.record) add('cash',{resource:tab,record:view.record});
    else {
      const {startDate,endDateExclusive} = periodBounds(period.period,period.anchor);
      add('cash',{resource:tab,startDate,endDateExclusive,...list(['q',...({movements:['account'],settlements:['source','status'],expenses:['category'],payroll:['status']}[tab] || [])]),...view.seller && ['expenses','payroll'].includes(tab) ? {person:view.seller} : {}});
    }
  } else if (view.section === 'reports') {
    const snapshotId = selection?.snapshotId || (view.record && !metrics.has(view.record) ? view.record : null);
    const metric = selection?.metric || (metrics.has(view.record) ? view.record : null);
    add('reports',snapshotId ? {mode:'snapshot',snapshotId,page:view.page,...metric ? {metric,...pick(view,['issue'])} : {}} : {mode:!metric && view.mode === 'saved' ? 'list' : 'live',...period,filters,page:view.page,...metric ? {metric,...pick(view,['issue'])} : {}});
  } else if (view.section === 'advertising') {
    const tab = view.tab || 'campaigns';
    add('advertising',tab === 'results' ? {kind:'results',...list(['integrationMethod','scope','dimension','from','to','mode','network','objective','status']),...view.record && view.record !== 'new' ? {campaignId:view.record} : {}} : tab === 'assets' ? {kind:'assets',page:view.page,...view.status ? {state:view.status} : {}} : view.record && view.record !== 'new' ? {kind:'campaign',id:view.record} : {kind:'campaigns',...list(['q','mode','network','objective','status','from','to'])});
  } else if (view.section === 'business') {
    const tab = view.tab || 'setup';
    if (tab === 'alerts') add('alerts',view.record ? {id:view.record} : {page:view.page,...view.status ? {state:view.status} : {},...view.issue ? {type:view.issue} : {}});
    else if (['people','accounts','platforms'].includes(tab)) add('business',{resource:tab,...view.record && view.record !== 'new' ? {id:view.record} : {page:view.page}});
    else if (tab === 'rules') add('alerts',{kind:'rules',...view.record ? {id:view.record} : {page:view.page}});
    else if (tab === 'social') add('advertising',{kind:'connections',page:1});
    else if (!['shipping','assistant'].includes(tab)) add('business',{resource:'settings'});
  } else if (view.section === 'settings') add('business',{resource:'storefront'});
  else if (view.section === 'users') add('access',{page:view.page});
  if (view.section === 'business' && ['social','shipping','assistant'].includes(view.tab)) guideTaskIds.push(view.tab === 'shipping' ? 'shipping-integrations' : view.tab);
  return {view,selection,reads,guideTaskIds,href:adminHref(view)};
}
