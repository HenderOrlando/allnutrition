// Official external reference: https://new.hekaentrega.co/api/docs (HTML manifest).
export const HEKA_ENVIRONMENTS = Object.freeze({ production: 'https://api.hekaentrega.co/api/v1', test: 'https://apidev.hekaentrega.co/api/v1' });
export const HEKA_CARRIERS = Object.freeze(['servientrega', 'interrapidisimo', 'heka', 'coordinadora', 'tcc', 'envia']);
export const HEKA_OBJECT_ID = /^[a-f0-9]{24}$/i;
export const HEKA_GUIDE_NUMBER = /^[a-z0-9-]{1,80}$/i;
export const HEKA_STATUS = /^[a-z0-9_-]{1,64}$/i;
export class HekaApiError extends Error {
  constructor(code, message, status = 422, options = {}) { super(message); this.code = code; this.status = status; this.definiteRejection = Boolean(options.definiteRejection); }
}
const invalid = label => { throw new HekaApiError('HEKA_INPUT', `${label}: dato de Heka no válido.`, 400); };
const contract = () => { throw new HekaApiError('HEKA_RESPONSE', 'Heka devolvió una respuesta incompleta o no documentada.', 502); };
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function hekaInputObject(value, keys, label) {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(label);
  return value;
}
const string = (max, pattern = null) => (v, k) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || pattern && !pattern.test(v.trim())) invalid(k);
  return v.trim();
};
const numeric = (min, max = Number.MAX_SAFE_INTEGER, whole = false) => (v, k) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || whole && !Number.isSafeInteger(v) || v < min || v > max) invalid(k);
  return v;
};
const choose = (...allowed) => (v, k) => { if (!allowed.includes(v)) invalid(k); return v; };
const boolean = (v,k) => { if (typeof v !== 'boolean') invalid(k); return v; };
const optional = check => (v,k) => v === undefined ? undefined : check(v,k);
const shape = (schema, label) => value => {
  hekaInputObject(value, Object.keys(schema), label);
  return Object.fromEntries(Object.entries(schema).flatMap(([k, fn]) => {
    const clean = fn(Object.hasOwn(value,k) ? value[k] : undefined, k);
    return clean === undefined ? [] : [[k,clean]];
  }));
};
const id = string(24, HEKA_OBJECT_ID), label = string(200), short = string(64), digits = string(32, /^\d+$/), dane = string(16, /^\d+$/), guideNumber = string(80, HEKA_GUIDE_NUMBER);
const iso = (v,k) => { const clean = string(40,/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))?$/)(v,k); if (!Number.isFinite(Date.parse(clean))) invalid(k); return clean; };
const phone = numeric(1000000, Number.MAX_SAFE_INTEGER, true), carrier = choose(...HEKA_CARRIERS), amount = numeric(0), size = numeric(Number.MIN_VALUE);
const paging = { page: optional(numeric(1,10000,true)), limit: optional(numeric(1,50,true)) };
const destinationType = choose(1,2), version = optional(choose('1','2'));
const shipment = { city_origin: dane, city_destination: dane, type_payment: choose(1,2,3), declared_value: amount, weight: size, height: size, long: size, width: size, withshipping_cost: boolean, collection_value: amount };
const client = shape({ name: label, address: string(500), phone, alternative_phone: optional(phone), type_document: optional(choose('CC','PS','CE','NIT','PPT','PEP','CD')), document: optional(digits), neighborhood: optional(label), locality: optional(label), email: optional(string(254,/^[^\s@]+@[^\s@]+\.[^\s@]+$/)), note_destination: optional(string(1000)) }, 'client');
const days = { start_date: optional(iso), end_date: optional(iso) };
const lookup = (schema, name, paired = false) => value => {
  const result = shape(schema,name)(value);
  if (paired && Boolean(result.start_date) !== Boolean(result.end_date) || result.start_date && result.end_date && Date.parse(result.start_date) > Date.parse(result.end_date)) invalid('Rango de fechas');
  return result;
};
const definitions = Object.freeze({
  check: { path: '/warehouse', input: shape({},'Verificación'), query: () => ({ limit: 1 }) },
  cities: { path: '/geolocation/city', input: shape({ label: optional(label), id: optional(id), dane: optional(dane), status: optional(short), ...paging },'Ciudad') },
  warehouses: { path: '/warehouse', input: lookup({ name: optional(label), city: optional(id), id: optional(id), status: optional(short), isnotstatus: optional(short), code: optional(short), search: optional(label), ...days, ...paging },'Bodega',true) },
  templates: { path: '/shipping/template', input: shape({ label: optional(label), id: optional(id) },'Plantilla') },
  quote: { path: '/shipping/quoter', method: 'POST', input: shape({ ...shipment, channel: optional(choose('hekaentrega','loggy24')), type: optional(destinationType), version, warehouse: optional(label), seller: optional(label) },'Cotización') },
  guides: { path: '/shipments/guide/v2/external', input: lookup({ id: optional(id), ...days, ...paging, distributor_id: optional(carrier), status: optional(short), status_novelty: optional(short), text: optional(label), paid: optional(short), reconciled: optional(short), collection: optional(short) },'Guías') },
  createGuide: { path: '/shipments/guide', method: 'POST', mutation: true, input: shape({ ...shipment, type: destinationType, distributor_id: carrier, collection_request: boolean, product: string(500), warehouse: id, in_order_form: boolean, client, quantity: optional(numeric(1)), note: optional(string(1000)), extra_info_product: optional(string(1000)), version },'Nueva guía') },
  clientHistory: { path: '/shipments/client-log', sensitive: true, input(value) {
    const clean = shape({ phone: optional(phone), document: optional(digits), ...paging },'Historial del cliente')(value);
    if (clean.phone === undefined && clean.document === undefined) invalid('Teléfono o documento');
    return clean;
  } },
  clientRating: { path: '/shipments/guide/client', sensitive: true, input: shape({ phone, limit: paging.limit },'Calificación del cliente') },
  novelties: { path: '/shipments/novelty', sellerOnly: true, input: shape({ id: optional(id), guide_number: optional(guideNumber), status_novelty: optional(choose('in_novelty','in_review','in_progress','resolved','in_claim')), label: optional(label), distributor_id: optional(carrier), ...paging },'Novedades') },
  solveNovelty: { path: '/shipments/novelty', method: 'PATCH', mutation: true, sellerOnly: true, input: shape({ id, solution: string(2000) },'Solución de novedad'), route: value => `/${value.id}`, body: value => ({ solution: value.solution }) },
  sticker: { path: '/documents/sticker', method: 'POST', sensitive: true, input(value) {
    const type = value?.type ?? 'document';
    if (type === 'document') return shape({ type: optional(choose('document')), id },'Documento')(value);
    return shape({ type: choose('guide'), guides(list) {
      if (!Array.isArray(list) || !list.length || list.length > 20 || new Set(list.map(x => typeof x === 'string' ? x.toLowerCase() : x)).size !== list.length) invalid('Guías del sticker');
      return list.map(item => id(item,'Guía del sticker'));
    } },'Sticker')(value);
  }, query: value => value.type === 'guide' ? { type: value.type } : { type: 'document', id: value.id }, body: value => value.type === 'guide' ? { guides: value.guides } : undefined }
});
export function hekaOperation(name, input) {
  if (!Object.hasOwn(definitions,name)) invalid('Operación');
  const definition = definitions[name];
  return { definition, input: definition.input(input ?? {}) };
}

const bounded = (v, max = 500) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
const safeNumber = v => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const safeId = v => typeof v === 'string' && HEKA_OBJECT_ID.test(v) ? v : undefined;
const safeGuide = v => typeof v === 'string' && HEKA_GUIDE_NUMBER.test(v) ? v : undefined;
const safeStatus = v => typeof v === 'string' && HEKA_STATUS.test(v) ? v : undefined;
const safeCarrier = v => HEKA_CARRIERS.includes(v) ? v : undefined;
const safeMasked = v => typeof v === 'string' && v.includes('*') ? bounded(v,200) : undefined;
const fields = (value, rules) => {
  if (!record(value)) contract();
  return Object.fromEntries(Object.entries(rules).flatMap(([key, read]) => {
    const v = read(Object.hasOwn(value,key) ? value[key] : undefined);
    return v === undefined ? [] : [[key,v]];
  }));
};
const pager = value => fields(value,{ total:safeNumber, pages:safeNumber, page:safeNumber, nextPage:v=>v===null?null:safeNumber(v), previousPage:v=>v===null?null:safeNumber(v) });
function page(value, project, { single = false } = {}) {
  if (record(value) && Array.isArray(value.rows)) return { rows: value.rows.slice(0,50).map(project), pager: pager(value.pager) };
  if (single) return value === null ? null : project(value);
  return contract();
}
const guide = value => fields(value,{ _id:safeId, guide_number:safeGuide, distributor_id:safeCarrier, status:safeStatus });
const movement = value => fields(value,{ label:bounded, status:safeStatus, isNovelty:v=>typeof v==='boolean'?v:undefined, code:bounded, date:bounded });
const novelty = value => ({ ...guide(value), ...fields(value,{ status_novelty:safeStatus, city_origin:bounded, city_destination:bounded, movemens:v=>Array.isArray(v)?v.slice(0,50).map(movement):undefined, last_novelty:v=>v===null?null:record(v)?fields(v,{_id:safeId,message:bounded,last_status:safeStatus,code:bounded}):undefined, last_movemen:v=>v===null?null:record(v)?movement(v):undefined }) });
const rating = value => fields(value, { _id: v=>record(v)?fields(v,{name:safeMasked,document:safeMasked}):undefined, statuses:v=>record(v)?Object.fromEntries(Object.entries(v).filter(([k,n])=>HEKA_STATUS.test(k)&&safeNumber(n)!==undefined).slice(0,20)):undefined, total:safeNumber, returned:safeNumber, percentReturned:safeNumber, category:safeStatus });
// Quote response has no published schema. Only bounded numeric leaves under safe
// provider labels/indices are returned. No tariff or currency is inferred.
function numericQuote(value) {
  if (!record(value) && !Array.isArray(value)) contract();
  const entries = []; let budget = 250;
  function scan(node, path, depth) {
    if (--budget < 0 || depth > 5 || entries.length >= 60) return;
    if (typeof node === 'number' && Number.isFinite(node)) { entries.push({ path: path.join(' / '), value: node }); return; }
    if (Array.isArray(node)) for (let i=0; i<Math.min(node.length,25); i++) scan(node[i],[...path,`[${i+1}]`],depth+1);
    else if (record(node)) for (const [key,item] of Object.entries(node)) {
      if (budget <= 0 || entries.length >= 60) break;
      if (/^[a-z][a-z0-9_ -]{0,47}$/i.test(key) && !/(?:client|customer|phone|address|email|document|token|secret|apikey|password)/i.test(key)) scan(item,[...path,key],depth+1);
    }
  }
  scan(value,[],0);
  return { entries };
}
function pdf(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) contract();
  const bytes = Buffer.from(value,'base64');
  if (bytes.subarray(0,5).toString('ascii') !== '%PDF-' || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) contract();
  return bytes;
}
export function projectHekaResult(name, value, input) {
  switch (name) {
    case 'check': if (!record(value) && value !== null) contract(); return { verified:true };
    case 'cities': return page(value,row=>fields(row,{ _id:safeId,label:bounded,dane:bounded }));
    case 'warehouses': return page(value,row=>fields(row,{ _id:safeId,name:bounded,status:safeStatus }),{single:input.limit===1});
    case 'templates': if (!Array.isArray(value)) contract(); return value.slice(0,50).map(row=>fields(row,{ _id:safeId,label:bounded,city_destination:bounded,type_payment:safeNumber,declared_value:safeNumber,weight:safeNumber,height:safeNumber,long:safeNumber,width:safeNumber,withshipping_cost:v=>typeof v==='boolean'?v:undefined }));
    case 'quote': return numericQuote(value);
    case 'guides': return page(value,guide,{single:input.limit===1});
    case 'createGuide': {
      const result = guide(value);
      if (!result._id || !result.guide_number || result.distributor_id !== input.distributor_id || !result.status) contract();
      return result;
    }
    case 'clientHistory': return page(value,row=>fields(row,{ name:safeMasked,document:safeMasked,guide_number:safeGuide }),{single:input.limit===1});
    case 'clientRating': return value === null ? null : Array.isArray(value?.rows) ? page(value,rating) : rating(value);
    case 'novelties': return page(value,novelty,{single:input.limit===1});
    case 'solveNovelty': {
      const result = fields(value,{ _id:safeId,message:bounded,last_status:safeStatus,solution:v=>bounded(v,2000),updatedAt:bounded });
      if (result._id?.toLowerCase() !== input.id.toLowerCase() || result.solution !== input.solution || !result.updatedAt || !Number.isFinite(Date.parse(result.updatedAt))) contract();
      return result;
    }
    case 'sticker': return pdf(value);
    default: return contract();
  }
}

const providerRejection = (status, definition) => {
  const role = definition.sellerOnly ? 'vendedor (seller)' : 'vendedor (seller) o gestor (manager)';
  if (status===401 || status===403) return new HekaApiError('HEKA_ROLE_OR_KEY', `Heka rechazó el acceso. Comprueba la clave, el entorno, el rol ${role} y la propiedad del recurso.`,403,{definiteRejection:true});
  if (status===400) return new HekaApiError('HEKA_REJECTED','Heka rechazó los datos o el estado de la operación.',422,{definiteRejection:definition.sellerOnly});
  if (status===429) return new HekaApiError('HEKA_PROVIDER_LIMIT','Heka limitó las solicitudes temporalmente.',429);
  return new HekaApiError('HEKA_UPSTREAM','Heka no pudo completar la solicitud.',502);
};
async function responseJson(response,max) {
  if (Number(response.headers.get('content-length') || 0) > max || !response.body || !/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) contract();
  const reader = response.body.getReader(), buffers = [];
  let total = 0;
  while (true) {
    const {value,done} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); contract(); }
    buffers.push(Buffer.from(value.buffer,value.byteOffset,value.byteLength));
  }
  try { return JSON.parse(Buffer.concat(buffers,total).toString('utf8')); } catch { return contract(); }
}

// One outbound attempt: HTTP POST/PATCH mutations never share a retrying transport.
export async function requestHeka({ environment, apiKey }, name, operation, { signal, transport = globalThis.fetch, project = true } = {}) {
  const {definition,input} = operation;
  if (!Object.hasOwn(HEKA_ENVIRONMENTS,environment)) invalid('Entorno');
  const method = definition.method || 'GET';
  const query = definition.query?.(input) ?? (method==='GET' ? input : {});
  const url = new URL(`${HEKA_ENVIRONMENTS[environment]}${definition.path}${definition.route?.(input) ?? ''}`);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key,value);
  const data = method==='GET' ? undefined : definition.body ? definition.body(input) : input;
  const headers = { accept:'application/json', 'api-key':apiKey, ...(data===undefined ? {} : {'content-type':'application/json'}) };
  const timeout = AbortSignal.timeout(15000), active = signal ? AbortSignal.any([signal,timeout]) : timeout;
  try {
    const response = await transport(url,{method,headers,body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',redirect:'error',signal:active});
    const envelope = await responseJson(response,name==='sticker' ? 12*1024*1024 : 1024*1024);
    if (!record(envelope) || !Number.isInteger(envelope.code) || !Object.hasOwn(envelope,'response')) contract();
    if (response.ok && envelope.code===200) return project ? projectHekaResult(name,envelope.response,input) : envelope.response;
    if (record(envelope.response) && typeof envelope.response.message==='string' && (response.ok || response.status===envelope.code)) throw providerRejection(envelope.code,definition);
    contract();
  } catch (error) {
    if (error instanceof HekaApiError) throw error;
    throw new HekaApiError('HEKA_TRANSPORT','No se obtuvo respuesta verificable de Heka.',502);
  }
}
