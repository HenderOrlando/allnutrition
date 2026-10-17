import { schemas, contentStates, orderStates, paymentStates } from './schema.mjs';
import { BUSINESS_PERIODS, businessDate } from './business/dates.mjs';

export const adminSections = [
 {id:'home',area:'home',group:'Tu negocio',label:'Inicio',icon:'grid'},
 {id:'orders',area:'orders',group:'Tu negocio',label:'Pedidos',icon:'truck'},
 {id:'products',area:'products',group:'Productos',label:schemas.products.label,icon:'box'},
 {id:'cash',area:'cash',group:'Tu negocio',label:'Caja',icon:'box'},
 {id:'reports',area:'reports',group:'Tu negocio',label:'Informes',icon:'grid'},
 {id:'business',area:'business',group:'Configuración',label:'Configuración',icon:'sun'},
 ...[['combos','box'],['catalogs','grid']].map(([id,icon])=>({id,area:'products',group:'Productos',label:schemas[id].label,icon})),
 {id:'settings',area:'business',group:'Vitrina',label:'Contacto y redes',icon:'sun'},
 ...[['faqs','chat'],['messages','edit'],['shipping','truck']].map(([id,icon])=>({id,area:'business',group:'Vitrina',label:schemas[id].label,icon})),
 {id:'users',area:'business',group:'Configuración',label:'Usuarios',icon:'plus'}
];
export const adminAreas = adminSections.filter(section=>section.id===section.area);

const sectionIds = new Set(adminSections.map(section=>section.id));
const contentIds = new Set(Object.keys(schemas));
const publicationValues = new Set(contentStates.map(state=>state.value));
const orderValues = new Set(orderStates.map(state=>state.value));
const paymentValues = new Set(paymentStates.map(state=>state.value));
const tabs = {
 orders:['list','shipments','imports'], cash:['overview','movements','settlements','expenses','payroll'],
 business:['setup','people','accounts','platforms','rules','alerts'], reports:['overview','sales','shipping','returns','costs','payroll','cash']
};
const shipmentStates = ['label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown'];
const reportStates = new Set([...orderValues,...shipmentStates]);
const reportIssues = new Set(['missing','negative_contribution','positive_contribution','positive_products','positive_sellers','late_deliveries','shipping_returns','shipping_absorbed','costly_returns','comparison_elapsed']);
const orderIssues = new Set(['incident','pending_settlement','missing_data','missing_cost','legacy_review']);
const shipmentIssues = new Set(['orphan','incident','missing_data']);
const alertTypes = new Set(['shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing']);

function first(params, key) {
 const value = typeof params?.get === 'function' ? params.get(key) : params?.[key];
 return Array.isArray(value) ? value[0] : value;
}
function boundedPage(params) {
 const rawPage = first(params,'page');
 const page = typeof rawPage === 'number' ? rawPage : typeof rawPage === 'string' && /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
 return Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}
function identifier(value) {
 return typeof value === 'string' && value.trim() && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
}
function copyIdentifiers(view,params,keys) {
 for(const key of keys) {
  const value=identifier(first(params,key));
  if(value)view[key]=value;
 }
}
function copyCarrier(view,params) {
 const value=first(params,'carrier');
 if(typeof value==='string'&&value.trim()&&value.length<=150&&!/[\u0000-\u001f\u007f]/.test(value))view.carrier=value.trim();
}
function copyQuery(view,params) {
 const query=first(params,'q');
 view.q=typeof query==='string'?query.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,100):'';
}

export function readAdminView(params) {
 const candidate=first(params,'section');
 const section=sectionIds.has(candidate)?candidate:'home';
 const view={section,q:'',status:'',paymentStatus:'',page:1};
 const tab=first(params,'tab');
 if(tabs[section]?.includes(tab))view.tab=tab;
 if(['home','reports','cash'].includes(section)) {
  const period=first(params,'period'),anchor=first(params,'anchor');
  if(BUSINESS_PERIODS.includes(period))view.period=period;
  if(typeof anchor==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(anchor))try{view.anchor=businessDate(anchor);}catch{}
 }
 const status=first(params,'status'),issue=first(params,'issue');
 if(section==='home') {
  if(issue==='attention') {
   view.issue=issue;view.page=boundedPage(params);
   if(['critical','warning','info'].includes(status))view.status=status;
  }
  return view;
 }
 if(section==='reports') {
  if(reportIssues.has(issue))view.issue=issue;
  copyIdentifiers(view,params,['seller','product','platform','account','record']);
  copyCarrier(view,params);
  if(reportStates.has(status))view.status=status;
  view.page=boundedPage(params);
  return view;
 }
 if(section==='cash') {
  copyQuery(view,params);copyIdentifiers(view,params,['account','record','seller','platform']);
  const states=view.tab==='settlements'?['pending','partial','confirmed']:view.tab==='payroll'?['draft','confirmed','partial','paid']:[];
  if(states.includes(status))view.status=status;
  view.page=boundedPage(params);
  return view;
 }
 if(section==='business') {
  copyQuery(view,params);copyIdentifiers(view,params,['record']);
  if(view.tab==='alerts') {
   if(['active','open','acknowledged','resolved','all'].includes(status))view.status=status;
   if(alertTypes.has(issue))view.issue=issue;
  }
  view.page=boundedPage(params);
  return view;
 }
 if(section!=='orders'&&!contentIds.has(section)) {
  if(section==='users')copyIdentifiers(view,params,['record']);
  return view;
 }
 copyIdentifiers(view,params,['record']);copyQuery(view,params);
 if(section==='orders') {
  const orderTab=view.tab||'list';
  if(orderTab==='imports') {
   copyIdentifiers(view,params,['batch','source','platform']);
   if(['uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired'].includes(status))view.status=status;
  } else if(orderTab==='shipments') {
   copyIdentifiers(view,params,['source','platform']);copyCarrier(view,params);
   if(shipmentStates.includes(status))view.status=status;
   if(shipmentIssues.has(issue))view.issue=issue;
  } else {
   copyIdentifiers(view,params,['seller','platform','product']);copyCarrier(view,params);
   if(orderValues.has(status))view.status=status;
   const paymentStatus=first(params,'paymentStatus');
   if(paymentValues.has(paymentStatus))view.paymentStatus=paymentStatus;
   if(orderIssues.has(issue))view.issue=issue;
  }
  view.page=boundedPage(params);
 } else {
  if(publicationValues.has(status))view.status=status;
  const productType=first(params,'productType');
  if(section==='products'&&['product','gift'].includes(productType))view.productType=productType;
 }
 return view;
}

export function adminHref(view) {
 const normalized=readAdminView(view),params=new URLSearchParams();
 if(normalized.section!=='home')params.set('section',normalized.section);
 for(const key of ['q','status','paymentStatus'])if(normalized[key])params.set(key,normalized[key]);
 if(normalized.page!==1)params.set('page',String(normalized.page));
 for(const key of ['tab','period','anchor','seller','platform','source','carrier','account','product','productType','issue','record','batch']) {
  if(normalized[key])params.set(key,normalized[key]);
 }
 const query=params.toString();
 return query?`/admin?${query}`:'/admin';
}

export function adminReturnTo(candidate) {
 if(typeof candidate!=='string'||candidate.includes('\\')||/[\u0000-\u0020\u007f]/.test(candidate))return '/admin';
 // Check the literal path before URL parsing can normalize dot segments or encoded paths.
 if(candidate.split(/[?#]/,1)[0]!=='/admin')return '/admin';
 const url=new URL(candidate,'https://admin.invalid');
 return adminHref(readAdminView(url.searchParams));
}
