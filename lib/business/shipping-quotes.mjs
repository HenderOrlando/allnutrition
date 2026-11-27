import { getHekaSettings, operateHeka } from './heka-api.mjs';
import { HekaApiError, hekaOperation, hekaShipmentInput } from '../shipping/heka-api.mjs';
import { PACK_FIELDS, parcelValues, routeValues, shippingObject, shippingPaymentValues } from '../shipping/center-values.mjs';
import { AppError, integer } from '../validation-core.mjs';

const ENVIRONMENTS = ['test','production'];
const CONFIG_CHANGED = 'SHIPPING_QUOTE_CONFIG_CHANGED';
const error = (code,message,status=400) => Object.assign(new AppError(message,status),{code});
const changed = () => error(CONFIG_CHANGED,'Cambió la configuración de las plataformas. Revisa las conexiones y el entorno antes de cotizar.',409);
const invalid = label => error('SHIPPING_QUOTE_INPUT',`${label}: opción no válida.`);
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const optionId = /^[a-z\d_-]{1,200}$/i;

const hekaQuoteAdapter = {
  id:'heka', label:'Heka',
  async connection(store) {
    const {configured,environment,version} = await getHekaSettings(store);
    return configured ? {environment,version} : null;
  },
  prepare(draft,options) {
    shippingObject(options,['warehouse','version','channel','seller'],'Opciones de Heka');
    if (draft.payment.payer==='sender' && draft.payment.includeShipping) {
      throw error('SHIPPING_QUOTE_INPUT','Si el remitente paga el envío, no sumes el flete al recaudo.');
    }
    const input = hekaShipmentInput(draft);
    for (const key of ['warehouse','version','channel','seller']) {
      const value = options[key];
      if (value == null || value==='') continue;
      if ((key==='warehouse' || key==='seller') && (typeof value!=='string' || !optionId.test(value.trim()))) throw invalid(key==='warehouse'?'Bodega de Heka':'Vendedor de Heka');
      input[key] = value;
    }
    return hekaOperation('quote',input).input;
  },
  async quote(store,{environment,version},input,session,{signal,heka}) {
    const {data:{result}} = await operateHeka(store,{operation:'quote',environment,version,input},session,{...heka,signal});
    return result.state==='error' ? {...result,errorCode:'HEKA_RESPONSE'} : result;
  },
};

function adapterRegistry(additional) {
  return new Map([hekaQuoteAdapter,...additional].map(adapter=>[adapter.id,adapter]));
}

async function configuredConnections(store,registry) {
  const rows = await Promise.all(Array.from(registry.values(),async adapter => {
    const settings = await adapter.connection(store);
    return settings ? {id:adapter.id,label:adapter.label,environment:settings.environment,version:settings.version} : null;
  }));
  return rows.filter(Boolean);
}

export async function listShippingQuoteConnections(store,{adapters=[]}={}) {
  return {connections:await configuredConnections(store,adapterRegistry(adapters))};
}

function expectedVersions(raw) {
  if (!Array.isArray(raw) || raw.length>32) throw invalid('Conexiones esperadas');
  const expected = new Map();
  for (const item of raw) {
    shippingObject(item,['id','environment','version','label'],'Conexión esperada');
    if (typeof item.id!=='string' || !idPattern.test(item.id) || !ENVIRONMENTS.includes(item.environment) || expected.has(item.id)) throw invalid('Conexión esperada');
    expected.set(item.id,{environment:item.environment,version:integer(item.version,'Versión de conexión',1,2147483647)});
  }
  return expected;
}

function selectedConnections(connections,{scope,environment,connectionId},checkingAgain=false) {
  const selected = connections.filter(connection=>(!environment || connection.environment===environment) && (scope==='all' || connection.id===connectionId));
  if (!environment && scope==='all' && new Set(selected.map(connection=>connection.environment)).size>1) {
    if (checkingAgain) throw changed();
    throw error('SHIPPING_QUOTE_ENVIRONMENT_REQUIRED','Elige Pruebas o Producción antes de cotizar en todas las plataformas.');
  }
  if (scope==='one' && selected.length!==1) throw changed();
  return selected;
}

function assertVersions(selected,expected) {
  if (selected.length!==expected.size || selected.some(({id,environment,version})=>expected.get(id)?.environment!==environment || expected.get(id)?.version!==version)) throw changed();
}

function quoteDraft(input,registry) {
  shippingObject(input,['route','parcel','payment','options'],'Borrador de cotización');
  const route = routeValues(input.route);
  for (const [label,item] of [['Origen',route.origin],['Destino',route.destination]]) {
    if (!item.dane && !(item.city && item.state)) throw error('SHIPPING_QUOTE_INPUT',`${label}: indica un código DANE o el municipio y su departamento.`);
  }
  const parcel = parcelValues(input.parcel ?? {});
  for (const {key,label} of PACK_FIELDS) if (parcel[key]===null) throw error('SHIPPING_QUOTE_INPUT',`Bulto: completa ${label.toLowerCase()}.`);
  const {declaredMinor,collectionMinor,payer,includeShipping} = shippingPaymentValues(input.payment);
  if (declaredMinor===null || collectionMinor===null) throw error('SHIPPING_QUOTE_INPUT','Indica el valor declarado y el recaudo (puede ser cero).');
  return {
    route,parcel,payment:{declaredMinor,collectionMinor,payer,includeShipping},
    options:shippingObject(input.options ?? {},Array.from(registry.keys()),'Opciones de plataforma'),
  };
}

function failureCode(cause) {
  if (cause instanceof HekaApiError) return cause.code;
  if (cause?.code?.startsWith?.('INTEGRATION_')) return 'HEKA_CUSTODY';
  if (cause?.name==='TimeoutError') return 'SHIPPING_QUOTE_TIMEOUT';
  return 'SHIPPING_QUOTE_PROVIDER';
}

export async function quoteShipping(store,body,session,{adapters=[],signal,heka}={}) {
  shippingObject(body,['scope','connectionId','environment','expectedConnections','draft'],'Cotización');
  const {scope,connectionId,environment} = body;
  if (!['all','one'].includes(scope) || (scope==='one' ? typeof connectionId!=='string' || !idPattern.test(connectionId) : connectionId!==undefined)) throw invalid('Ámbito de cotización');
  if (environment!==undefined && !ENVIRONMENTS.includes(environment)) throw invalid('Entorno de cotización');
  const expected = expectedVersions(body.expectedConnections);
  const registry = adapterRegistry(adapters);
  const {options,...draft} = quoteDraft(body.draft,registry);
  const selected = selectedConnections(await configuredConnections(store,registry),body);
  assertVersions(selected,expected);
  const jobs = selected.map(connection=>{
    const adapter = registry.get(connection.id);
    return {connection,adapter,input:adapter.prepare(draft,options[connection.id] ?? {})};
  });

  const providers = new Array(jobs.length);
  let next = 0;
  async function lane() {
    while (next<jobs.length && !signal?.aborted) {
      const index = next++, {connection,adapter,input} = jobs[index];
      try {
        const {state,offers,errorCode,details} = await adapter.quote(store,connection,input,session,{signal,heka});
        providers[index] = {...connection,state,offers,...(errorCode?{errorCode}:{}),...(details?.length?{details}:{})};
      } catch (cause) {
        if (cause instanceof HekaApiError && cause.code==='HEKA_SESSION') throw cause;
        providers[index] = {...connection,state:'error',offers:[],errorCode:failureCode(cause)};
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(2,jobs.length)},lane));
  signal?.throwIfAborted();
  if (providers.some(provider=>provider.errorCode==='HEKA_CONFIG_CHANGED' || provider.errorCode===CONFIG_CHANGED)) throw changed();
  if (jobs.length) assertVersions(selectedConnections(await configuredConnections(store,registry),body,true),expected);
  return {quotedAt:new Date().toISOString(),providers};
}
