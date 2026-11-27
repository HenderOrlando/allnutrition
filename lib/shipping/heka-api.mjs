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
const cityText = shape({ city: string(100), state: optional(string(100)) },'Ciudad y departamento');
const city = (value,key) => record(value) ? cityText(value) : dane(value,key);
const shipment = { city_origin: city, city_destination: city, type_payment: choose(1,2,3), declared_value: amount, weight: size, height: size, long: size, width: size, withshipping_cost: boolean, collection_value: amount };

// The center and the emission review use the same units and payment mapping.
export function hekaShipmentInput({ route, parcel, payment }) {
  const location = ({dane,city,state}) => dane || {city,...(state ? {state} : {})};
  return {
    city_origin:location(route.origin), city_destination:location(route.destination), type:route.deliveryType==='office'?2:1,
    type_payment:payment.collectionMinor>0?1:payment.payer==='recipient'?2:3,
    declared_value:payment.declaredMinor/100, collection_value:payment.collectionMinor/100, withshipping_cost:payment.includeShipping,
    weight:parcel.weightG/1000, height:parcel.heightMm/10, long:parcel.lengthMm/10, width:parcel.widthMm/10,
  };
}
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
const QUOTE_FIELDS = new Set(['distributor_id','service','total','amount','currency','deliveryTime','visual_flete','assured','transportCommission','transport_commission','visual_heka_commission','restrictions','options','coverage','available','success','status','error','errors','message','code']);
const CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));
const privateQuoteKey = /(?:client|customer|recipient|contact|phone|tel[eé]f|mobile|address|direcci[oó]n|email|correo|document|passport|credential|token|secret|key|password|account|cuenta|guide|gu[ií]a|track|postal|warehouse|seller|buyer|name|nombre|apellido|ubicaci[oó]n|location|latitude|longitude|signature)|(?:^|[_-])(?:id|identification|nit|cc|ip)(?:$|[_-])|^number$/i;
const quoteNumber = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER ? value : null;
const quoteCurrency = value => typeof value==='string' && /^[a-z]{3}$/i.test(value) && CURRENCY_CODES.has(value.toUpperCase()) ? value.toUpperCase() : null;
const quoteText = (value,max) => typeof value==='string' && value.trim() && value.length<=max && /^[\p{L}\p{M}\d .,()/%-]+$/u.test(value) && !/(?:\d[\s().-]*){7}|https?:|(?:cliente|destinatario|tel[eé]fono|correo|documento|direcci[oó]n)\s*:/i.test(value) ? value.trim() : null;

// Retain small numeric diagnostics, never arbitrary provider messages or raw
// quote payloads. The allow-listed fields must not reappear as unknown costs.
function quoteDetails(value) {
  const entries = []; let budget = 100;
  function scan(node,path,depth) {
    if (--budget<0 || depth>4 || entries.length>=12) return;
    if (typeof node==='number' && Math.abs(node)<1_000_000) { entries.push({path,value:node}); return; }
    if (Array.isArray(node)) {
      for (let i=0;i<Math.min(node.length,12);i++) scan(node[i],`${path} / [${i+1}]`,depth+1);
    } else if (record(node)) {
      for (const key in node) {
        if (--budget<0 || entries.length>=12) break;
        if (!Object.hasOwn(node,key) || QUOTE_FIELDS.has(key) || !/^[a-z][a-z0-9_-]{0,35}$/i.test(key) || privateQuoteKey.test(key.replace(/([a-z])([A-Z])/g,'$1_$2'))) continue;
        scan(node[key],path?`${path} / ${key}`:key,depth+1);
      }
    }
  }
  if (record(value)) scan(value,'',0);
  return entries;
}

function quoteDisposition(row,wrapped=false) {
  if (!record(row)) return 'error';
  const {status} = row;
  if (row.coverage===false || status==='no_coverage' || status==='out_of_coverage') return 'no_coverage';
  if (row.success===false || status==='error' || status==='rejected' || status==='failed' ||
      (Number.isInteger(row.code) && row.code>=400) || row.error ||
      (Array.isArray(row.errors) ? row.errors.length : row.errors)) return 'error';
  if (row.available===false) return 'no_coverage';
  if ((!wrapped || !row.options.length) && typeof row.message==='string' && row.message.trim()) return 'error';
  return null;
}

function projectQuote(value) {
  if (!record(value) && !Array.isArray(value)) contract();
  const wrapped = Array.isArray(value.options);
  if (wrapped) {
    const state = quoteDisposition(value,true);
    if (state) return {state,offers:[]};
  }
  const rows = wrapped ? value.options : Array.isArray(value) ? value : [value];
  const offers = [], details = wrapped ? quoteDetails(value) : [];
  let incompatible = false;
  for (let i=0;i<Math.min(rows.length,25);i++) {
    const row = rows[i];
    const disposition = quoteDisposition(row);
    if (disposition) { incompatible ||= disposition==='error'; continue; }
    const total = quoteNumber(row.total), amount = quoteNumber(row.amount);
    if (total===null && amount===null) {
      incompatible = true;
      if (details.length<12) details.push(...quoteDetails(row).slice(0,12-details.length));
      continue;
    }
    const carrier = safeCarrier(row.distributor_id) ?? null;
    const commission = quoteNumber(row.transportCommission), alternate = quoteNumber(row.transport_commission);
    const restrictions = [];
    for (const candidate of Array.isArray(row.restrictions) ? row.restrictions.slice(0,5) : [row.restrictions]) {
      const note = quoteText(candidate,140);
      if (note && !restrictions.includes(note)) restrictions.push(note);
    }
    offers.push({
      carrier, service:quoteText(row.service,80), total, amount,
      currency:quoteCurrency(row.currency ?? (wrapped ? value.currency : null)),
      days:Number.isInteger(row.deliveryTime) && row.deliveryTime>=0 && row.deliveryTime<=365 ? row.deliveryTime : null,
      base:quoteNumber(row.visual_flete), insurance:quoteNumber(row.assured),
      carrierCommission:commission!==null && alternate!==null && commission!==alternate ? null : commission ?? alternate,
      platformCommission:quoteNumber(row.visual_heka_commission), restrictions, details:quoteDetails(row), canEmit:carrier!==null,
    });
  }
  return {state:offers.length?'offers':incompatible?'error':'no_coverage',offers,...(details.length?{details}:{})};
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
    case 'quote': return projectQuote(value);
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
