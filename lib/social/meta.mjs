import { createHmac } from 'node:crypto';
import { AppError, fail } from '../validation-core.mjs';
import { META_API_HOSTS } from './config.mjs';
import { createMetaPublishingAdapter } from './meta-publishing.mjs';
import { createMetaMetricsAdapter } from './meta-metrics.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 1000;
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80004]);
const PERMISSION_CODES = new Set([10, 200, 294]);
const PROJECTIONS = Object.freeze({
  verify_page_business: 'business',
  verify_ad_account_business: 'business',
  verify_instagram: 'instagram_business_account',
  verify_whatsapp: 'whatsapp_number'
});
const stageHelp = Object.freeze({
  code_exchange: ['canje del código', 'En Meta for Developers → Facebook Login for Business, confirma que el ID guardado corresponde a la app, que la configuración usa Token de acceso de usuario y que el callback guardado coincide exactamente con la URI autorizada. Después reinicia la conexión.'],
  long_lived_exchange: ['canje de larga duración', 'En Facebook Login for Business → Configurations, elige Token de acceso de usuario (no Token de usuario del sistema), guarda su ID en Opciones de Meta y vuelve a autorizar.'],
  validation: ['validación de la conexión']
});
const operationHelp = Object.freeze({
  inspect_token: ['Inspeccionar token', 'Comprueba que el token pertenece al ID de app guardado y sigue vigente. Si usas OAuth, confirma que su configuración emite un Token de acceso de usuario.'],
  identify_user: ['Identificar usuario', 'Comprueba que el token identifica al mismo usuario de Meta que autorizó esta conexión. Para usar otro usuario, crea una conexión nueva.'],
  read_permissions: ['Leer permisos', 'Revisa qué permisos concedió Meta a la autorización actual. En OAuth, corrige la configuración de Facebook Login for Business y vuelve a autorizar; con token manual, crea una conexión nueva con un token que tenga los permisos requeridos.'],
  list_pages: ['Enumerar páginas', 'En Meta, verifica que el usuario puede administrar o tiene las tareas necesarias sobre la página y que la autorización incluye pages_show_list para ese recurso.'],
  list_ad_accounts: ['Enumerar cuentas de anuncios', 'En Configuración del negocio de Meta → Cuentas publicitarias, asigna al usuario la cuenta y las tareas necesarias; verifica que la autorización incluye ads_read o ads_management para esa cuenta.'],
  verify_page_business: ['Verificar empresa de la página', 'En Meta, confirma que la empresa es propietaria de la página y que el usuario es administrador de esa página. Para OAuth, revisa business_management sobre la empresa en la configuración de Facebook Login for Business (config_id).'],
  verify_ad_account_business: ['Verificar empresa de la cuenta publicitaria', 'En Configuración del negocio de Meta → Cuentas publicitarias, confirma la empresa propietaria de la cuenta y que el usuario tiene acceso a ella. Para publicar con OAuth, revisa business_management en la configuración de Facebook Login for Business (config_id).'],
  verify_business: ['Verificar empresa', 'Comprueba que la página y la cuenta publicitaria seleccionadas pertenecen a la empresa esperada. Para publicar con OAuth, confirma business_management para esa empresa en Facebook Login for Business (config_id).'],
  verify_instagram: ['Verificar Instagram', 'Vincula la cuenta profesional a la página, asigna al usuario las tareas de la página y concede instagram_basic y el permiso de publicación o estadísticas que necesitas.'],
  verify_whatsapp: ['Verificar WhatsApp', 'Para anuncios de WhatsApp, vincula y verifica el número en la página seleccionada y confirma que el usuario puede anunciar con ella.']
});
const validationOperations = new WeakMap();

export function metaValidationDiagnostic(error) {
  const operation = validationOperations.get(error);
  return operation ? { operation } : null;
}

export function describeMetaDiagnostic({ stage, operation, httpStatus, code, subcode }) {
  const step = Object.hasOwn(stageHelp, stage) ? stageHelp[stage] : null;
  const fields = step ? [`Etapa: ${step[0]}`] : [];
  const help = Object.hasOwn(operationHelp, operation) ? operationHelp[operation] : null;
  if (help) fields.push(`Operación: ${help[0]}`);
  if (Number.isSafeInteger(httpStatus)) fields.push(`HTTP de Meta: ${httpStatus}`);
  if (Number.isSafeInteger(code)) fields.push(`Código de Meta: ${code}`);
  if (Number.isSafeInteger(subcode)) fields.push(`Subcódigo de Meta: ${subcode}`);
  const action = help?.[1] || step?.[1];
  return `${fields.length ? `${fields.join(' · ')}.` : ''}${action ? ` ${action}` : ''}`.trim();
}

function validationFailure(operation, kind, original) {
  const error = new MetaApiError(kind, original);
  validationOperations.set(error, operation);
  return error;
}

async function validationStep(operation, run) {
  try { return await run(); }
  catch (error) {
    if (error instanceof MetaApiError) validationOperations.set(error, operation);
    throw error;
  }
}
const permissionName = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value);
const usageNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function reportedUsage(headers) {
  const usage = [];
  for (const source of ['x-app-usage', 'x-page-usage', 'x-business-use-case-usage']) {
    const raw = headers.get(source);
    if (!raw || raw.length > 32768) continue;
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    function add(value, scope) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const entry = {
        source, scope, callCount: usageNumber(value.call_count), totalCpuTime: usageNumber(value.total_cputime),
        totalTime: usageNumber(value.total_time), estimatedTimeToRegainAccess: usageNumber(value.estimated_time_to_regain_access)
      };
      if (Object.values(entry).slice(2).some(value => value !== null)) usage.push(entry);
    }
    if (source !== 'x-business-use-case-usage') add(data, source === 'x-app-usage' ? 'app' : 'page');
    else for (const [scope, rows] of Object.entries(data)) {
      if (!/^\d{1,40}$/.test(scope) || !Array.isArray(rows)) continue;
      for (const row of rows.slice(0, 100)) add(row, scope);
    }
  }
  return usage;
}

export class MetaApiError extends AppError {
  constructor(kind, { code = null, subcode = null, httpStatus = null, retryAfter = null, uncertain = false } = {}) {
    const messages = {
      reconnect_required: 'La autorización de Meta caducó o fue revocada. Reconecta la cuenta.',
      permission: 'Meta no permite esta operación con los permisos actuales.',
      rate_limit: 'Meta limitó las solicitudes. Espera antes de volver a consultar.',
      unavailable: 'Meta no está disponible para esta consulta.',
      rejected: 'Meta rechazó la solicitud. Revisa la configuración de la operación.',
      unsafe_url: 'Meta devolvió un destino no permitido.',
      invalid_response: 'La respuesta de Meta no pudo verificarse.',
      transport: 'No se pudo completar la comunicación con Meta.',
      aborted: 'La comunicación con Meta fue cancelada.',
      account_mismatch: 'La identidad o el recurso no pertenece a la conexión seleccionada.'
    };
    super(messages[kind] || messages.rejected, kind === 'rate_limit' ? 429 : kind === 'transport' || kind === 'unavailable' ? 502 : 409);
    this.name = 'MetaApiError';
    this.kind = kind;
    this.code = code;
    this.subcode = subcode;
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
    this.uncertain = uncertain;
    this.retryable = !uncertain && ['rate_limit', 'unavailable', 'transport'].includes(kind);
  }
}

function safeUrl(value, graphVersion) {
  let url;
  try {
    const input = value instanceof URL ? value.href : String(value);
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith('//') ? input : `https://graph.facebook.com/${graphVersion}/${input.replace(/^\//, '')}`);
  } catch { throw new MetaApiError('unsafe_url'); }
  if (url.protocol !== 'https:' || !META_API_HOSTS.includes(url.hostname) || url.username || url.password || url.port || url.hash) throw new MetaApiError('unsafe_url');
  // Meta embeds credentials in pagination URLs. Never forward those URL credentials.
  url.searchParams.delete('access_token');
  url.searchParams.delete('appsecret_proof');
  return url;
}
function addParams(target, values) {
  for (const [key, value] of Object.entries(values || {})) {
    if (value == null) continue;
    if (['access_token', 'appsecret_proof'].includes(key)) fail('Las credenciales de Meta solo se aceptan en el transporte de servidor.');
    target.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
}
function retryAfterSeconds(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}
async function readResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MetaApiError('invalid_response');
  }
  if (!response.body) throw new MetaApiError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MetaApiError('invalid_response');
      }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MetaApiError('invalid_response');
    return data;
  } finally { reader.releaseLock(); }
}
function apiFailure(response, details, mutation, limits, optionalProjection) {
  const code = Number.isSafeInteger(details?.code) ? details.code : null;
  const subcode = Number.isSafeInteger(details?.error_subcode) ? details.error_subcode : null;
  const kind = code === 190 ? 'reconnect_required' : PERMISSION_CODES.has(code) || response.status === 403 ? 'permission'
    : RATE_CODES.has(code) || response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'unavailable' : 'rejected';
  const error = new MetaApiError(kind, { code, subcode, httpStatus: response.status, retryAfter: limits?.retryAfter ?? retryAfterSeconds(response.headers.get('retry-after')), uncertain: mutation && response.status >= 500 });
  if (limits) error.limits = limits;
  // Classify only explicit metric/field failures; never retain Meta's raw message.
  // A generic code 100 can mean a malformed object, date or breakdown, not a capability.
  const message = typeof details?.message === 'string' ? details.message : '';
  if (code === 100 && kind === 'rejected' && /valid insights metric|invalid metric|metric[^.\n]{0,100}(?:invalid|not supported|must be one of)|(?:not valid|invalid)[^.\n]{0,100}fields (?:param|parameter)|nonexisting field[^.\n]{0,100}AdsInsights/i.test(message)) error.invalidMetric = true;
  // Match an explicit field rejection only on a request dedicated to that field.
  // In particular, a bare (#100), bad appsecret_proof or a bad object must still fail.
  const field = Object.hasOwn(PROJECTIONS, optionalProjection) ? PROJECTIONS[optionalProjection] : null;
  if (field && !mutation && [400, 403].includes(response.status) && (code === 100 || kind === 'permission') &&
      ['rejected', 'permission'].includes(kind) && !/appsecret[_ ]proof|access token|oauth token|signature/i.test(message)) {
    const named = `(?:['"\`(]${field}['"\`)]|\\b${field}\\b)`;
    const scope = field === 'business' ? 'business_management' : field === 'instagram_business_account' ? 'instagram_basic' : field;
    if (new RegExp(`(?:nonexisting|unknown|unsupported|invalid|unavailable)\\s+field\\s+${named}|${named}[^.\\n]{0,110}(?:not accessible|not available|not supported|requires|only accessible|cannot be accessed)|(?:permission|access)[^.\\n]{0,110}(?:denied|requires|required)[^.\\n]{0,110}\\b(?:${field}|${scope})\\b|(?:requires|missing|must have)[^.\\n]{0,110}\\b${scope}\\b`, 'i').test(message)) error.optionalFieldDenied = true;
  }
  return error;
}
function expiration(seconds, now) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 <= now || !Number.isSafeInteger(seconds * 1000) || seconds * 1000 > 8640000000000000) throw new MetaApiError('reconnect_required');
  return new Date(seconds * 1000).toISOString();
}
function tokenExpiration(seconds, now) {
  if (seconds == null) return { value: null, status: 'unknown' };
  if (seconds === 0) return { value: null, status: 'not_scheduled' };
  return { value: expiration(seconds, now), status: 'reported' };
}
function exchangedToken(data) {
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) throw new MetaApiError('invalid_response');
  const expires = Date.now() + data.expires_in * 1000;
  if (!Number.isSafeInteger(expires) || expires > 8640000000000000) throw new MetaApiError('invalid_response');
  return { accessToken: data.access_token, expiresAt: new Date(expires).toISOString() };
}

export function createMetaClient({ accessToken = '', appSecret, graphVersion = 'v26.0', fetchImpl = fetch, readOnly = false, now = Date.now }) {
  if (typeof appSecret !== 'string' || !appSecret) fail('Configura el secreto de la aplicación Meta.', 409);
  if (graphVersion !== 'v26.0') fail('La versión Meta no tiene una matriz de capacidades verificada.', 409);
  const clock = () => typeof now === 'function' ? now() : now;
  let limits = { status: 'unknown', observedAt: null, usage: [], retryAfter: null };
  function captureUsage(response) {
    const usage = reportedUsage(response.headers);
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after'), clock());
    if (!usage.length && retryAfter === null) return;
    const sources = new Set(usage.map(row => row.source));
    limits = {
      status: 'reported', observedAt: new Date(clock()).toISOString(),
      usage: [...limits.usage.filter(row => !sources.has(row.source)), ...usage],
      retryAfter
    };
  }
  const usageSnapshot = () => ({ ...limits, usage: limits.usage.map(row => ({ ...row })) });
  async function request(path, { method = 'GET', params = {}, body = {}, rawBody, uploadHeaders = {}, signal: externalSignal, accessToken: token = accessToken, optionalProjection } = {}) {
    const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(rawBody === undefined ? 30000 : 240000)]) : AbortSignal.timeout(rawBody === undefined ? 30000 : 240000);
    method = method.toUpperCase();
    if (!['GET', 'POST', 'DELETE'].includes(method)) fail('Método Meta no permitido.');
    const mutation = method !== 'GET';
    if (readOnly && mutation) throw new MetaApiError('permission');
    let url = safeUrl(path, graphVersion);
    addParams(url.searchParams, params);
    const headers = { Accept: 'application/json' };
    const form = new URLSearchParams();
    if (rawBody !== undefined) {
      if (!mutation || !(rawBody instanceof Uint8Array || typeof rawBody?.getReader === 'function' || typeof rawBody?.[Symbol.asyncIterator] === 'function')) fail('La carga Meta requiere bytes o un stream.');
      headers['Content-Type'] = 'application/octet-stream';
      for (const [key, value] of Object.entries(uploadHeaders)) {
        const lower = key.toLowerCase(), contentType = lower === 'content-type';
        if (!['offset', 'file_size', 'content-length', 'content-type'].includes(lower) || typeof value !== 'string' || (contentType ? !/^(?:application\/octet-stream|multipart\/form-data; boundary=[A-Za-z0-9-]{16,80})$/.test(value) : !/^\d+$/.test(value))) fail('Cabecera de carga Meta no válida.');
        headers[contentType ? 'Content-Type' : lower] = value;
      }
    } else if (mutation) {
      addParams(form, body);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (token) {
      if (typeof token !== 'string' || /[\r\n]/.test(token)) fail('Credencial Meta no válida.', 409);
      headers.Authorization = `${rawBody === undefined ? 'Bearer' : 'OAuth'} ${token}`;
      const proof = createHmac('sha256', appSecret).update(token).digest('hex');
      (mutation && rawBody === undefined ? form : url.searchParams).set('appsecret_proof', proof);
    }
    for (let redirects = 0; ; redirects++) {
      if (signal?.aborted) throw new MetaApiError('aborted');
      let response;
      try {
        const stream = rawBody !== undefined && (typeof rawBody?.getReader === 'function' || typeof rawBody?.[Symbol.asyncIterator] === 'function');
        response = await fetchImpl(url.href, { method, headers, body: rawBody ?? (mutation ? form.toString() : undefined), ...(stream ? { duplex: 'half' } : {}), redirect: 'manual', signal });
      } catch { throw new MetaApiError(signal?.aborted ? 'aborted' : 'transport', { uncertain: mutation }); }
      captureUsage(response);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        let next;
        try {
          const location = response.headers.get('location');
          if (!location) throw new MetaApiError('unsafe_url');
          next = safeUrl(new URL(location, url), graphVersion);
        }
        catch { throw new MetaApiError('unsafe_url', { uncertain: mutation }); }
        // Never replay a write after a redirect, even to a permitted host.
        if (mutation || redirects >= 3) throw new MetaApiError('invalid_response', { uncertain: mutation });
        if (headers.Authorization) next.searchParams.set('appsecret_proof', createHmac('sha256', appSecret).update(token).digest('hex'));
        url = next;
        continue;
      }
      let data;
      try { data = await readResponse(response); }
      catch {
        if (signal.aborted) throw new MetaApiError('aborted', { httpStatus: response.status, uncertain: mutation });
        if (!response.ok) throw apiFailure(response, null, mutation, usageSnapshot());
        throw new MetaApiError('invalid_response', { httpStatus: response.status, uncertain: mutation });
      }
      // /debug_token can report an error under its data wrapper even with HTTP 200.
      const reportedError = data.error || (path === 'debug_token' ? data.data?.error : null);
      if (!response.ok || reportedError) throw apiFailure(response, reportedError, mutation, usageSnapshot(), optionalProjection);
      return data;
    }
  }
  const get = (path, params = {}, options = {}) => request(path, { ...options, method: 'GET', params });
  const post = (path, body = {}, options = {}) => request(path, { ...options, method: 'POST', body });
  async function pages(path, params = {}, options = {}) {
    const rows = [], seen = new Set();
    let next = path;
    for (let page = 0; page < MAX_PAGES; page++) {
      const key = safeUrl(next, graphVersion).href;
      if (seen.has(key)) throw new MetaApiError('invalid_response');
      seen.add(key);
      const result = await get(next, page ? {} : params, options);
      if (!Array.isArray(result.data)) throw new MetaApiError('invalid_response');
      if (rows.length + result.data.length > 100000) throw new MetaApiError('invalid_response');
      for (const row of result.data) rows.push(row);
      options.onPage?.(result.data);
      if (!result.paging?.next) return rows;
      if (typeof result.paging.next !== 'string') throw new MetaApiError('invalid_response');
      next = safeUrl(result.paging.next, graphVersion).href;
    }
    throw new MetaApiError('invalid_response');
  }
  return {
    request, get, post, pages, usageSnapshot,
    upload(path, { body, headers = {}, signal, accessToken: token = accessToken } = {}) {
      if (body === undefined) fail('Faltan los bytes de carga Meta.');
      return request(path, { method: 'POST', rawBody: body, uploadHeaders: headers, signal, accessToken: token });
    },
    async exchangeCode({ code, appId, redirectUri, signal }) {
      if (!code || !appId || !redirectUri) fail('Faltan datos para completar OAuth.');
      return exchangedToken(await get('oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }, { signal, accessToken: '' }));
    },
    async exchangeLongLivedToken({ accessToken: shortToken, appId, signal }) {
      if (!shortToken || !appId) fail('Faltan datos para completar OAuth.');
      return exchangedToken(await get('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken }, { signal, accessToken: '' }));
    },
    async debugToken({ accessToken: inspectedToken = accessToken, appId, expectedUserId, signal, now = clock(), authenticationMethod = 'oauth' }) {
      if (!inspectedToken || !appId) throw new MetaApiError('reconnect_required');
      const { data } = await get('debug_token', { input_token: inspectedToken }, { signal, accessToken: `${appId}|${appSecret}` });
      const manual = authenticationMethod === 'token';
      if (!data || data.is_valid !== true || String(data.app_id) !== String(appId) || !(manual ? ['USER', 'SYSTEM_USER'].includes(data.type) : data.type === 'USER') || !validId(data.user_id)) throw new MetaApiError('reconnect_required');
      if (expectedUserId && String(data.user_id) !== String(expectedUserId)) throw new MetaApiError('account_mismatch');
      const expires = manual ? tokenExpiration(data.expires_at, now) : { value: expiration(data.expires_at, now), status: 'reported' };
      const dataAccess = manual ? tokenExpiration(data.data_access_expires_at, now) : { value: expiration(data.data_access_expires_at, now), status: 'reported' };
      return {
        userId: String(data.user_id), tokenType: data.type, expiresAt: expires.value, dataAccessExpiresAt: dataAccess.value, expirationStatus: expires.status,
        permissions: Array.isArray(data.scopes) ? data.scopes.filter(permissionName) : [],
        granularScopes: Array.isArray(data.granular_scopes) ? data.granular_scopes.filter(item => permissionName(item?.scope)).map(item => ({
          scope: item.scope, restricted: Array.isArray(item.target_ids),
          targetIds: Array.isArray(item.target_ids) ? item.target_ids.filter(value => typeof value === 'string' && /^(?:act_)?\d+$/.test(value)).map(value => value.replace(/^act_/, '')) : []
        })) : []
      };
    }
  };
}

// Meta's documented currency offsets, not ISO decimal exponents. Add currencies only
// after checking the Marketing API currency reference; an unknown currency is blocked.
export const META_CURRENCY_OFFSETS = Object.freeze({ COP: 1, USD: 100 });
export function metaBudgetUnits(budgetMinor, currency) {
  const offset = META_CURRENCY_OFFSETS[currency];
  if (!offset) fail('La moneda no tiene un offset Meta verificado.');
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) fail('El presupuesto debe ser un entero seguro no negativo.');
  const value = BigInt(budgetMinor) * BigInt(offset);
  if (value % 100n !== 0n || value / 100n > BigInt(Number.MAX_SAFE_INTEGER)) fail('El presupuesto no es representable exactamente en Meta.');
  return Number(value / 100n);
}

const validId = value => typeof value === 'string' && /^\d+$/.test(value);
const id = value => validId(value) ? value : null;
const accountId = value => typeof value === 'string' && /^(?:act_)?\d+$/.test(value) ? `act_${value.replace(/^act_/, '')}` : null;
const name = value => typeof value === 'string' ? value.slice(0, 300) : '';
const PAGE_FIELDS = 'id,name,tasks,access_token';
const ACCOUNT_FIELDS = 'id,name,currency,timezone_name,account_status,user_tasks';
const BUSINESS_FIELDS = 'id,business{id,name}';
const INSTAGRAM_FIELDS = 'id,instagram_business_account{id,username}';
const WHATSAPP_FIELDS = 'id,whatsapp_number';

export function createMetaApiConnector({ connection, credentials, runtime, transport = {} }) {
  if (!runtime) fail('Falta la configuración social de ejecución.', 409);
  const appId = runtime.appId;
  const authenticationMethod = connection.data?.authenticationMethod === 'token' ? 'token' : 'oauth';
  const readOnly = authenticationMethod === 'token' || connection.data?.readOnly === true;
  const client = createMetaClient({ accessToken: credentials.accessToken, appSecret: runtime.appSecret, graphVersion: 'v26.0', fetchImpl: transport.fetchImpl, readOnly, now: transport.now ?? Date.now });
  const selected = connection.data?.identities ?? connection.identities ?? {};
  const clock = () => typeof transport.now === 'function' ? transport.now() : transport.now ?? Date.now();
  let freshPageTokens = {};
  async function validateConnection({ signal, purpose = readOnly ? 'read' : 'publish', channel = null, includeInstagram = false, whatsappAds = false, requirePinned = false } = {}) {
    if (!['publish', 'read', 'pause', 'insights'].includes(purpose) || channel !== null && !['meta_ads', 'facebook', 'instagram'].includes(channel) || purpose === 'insights' && !channel) fail('Propósito de validación Meta no permitido.');
    if (readOnly && ['publish', 'pause'].includes(purpose)) throw new MetaApiError('permission');
    const debug = await validationStep('inspect_token', () => client.debugToken({ appId, expectedUserId: selected.userId || credentials.userId, signal, now: clock(), authenticationMethod }));
    const user = await validationStep('identify_user', async () => {
      const row = await client.get('me', { fields: 'id,name' }, { signal });
      if (id(row.id) !== debug.userId) throw new MetaApiError('account_mismatch');
      return row;
    });
    const grantedRows = await validationStep('read_permissions', () => client.pages('me/permissions', {}, { signal }));
    const permissionStatuses = new Map(debug.permissions.map(scope => [scope, 'unknown']));
    for (const row of grantedRows) {
      if (!permissionName(row?.permission) || !['granted', 'declined', 'expired'].includes(row.status)) continue;
      const status = row.status === 'granted' && !debug.permissions.includes(row.permission) ? 'unknown' : row.status;
      const previous = permissionStatuses.get(row.permission);
      if (previous !== 'declined' && previous !== 'expired') permissionStatuses.set(row.permission, status);
    }
    const granted = new Set([...permissionStatuses].filter(([, status]) => status === 'granted').map(([scope]) => scope));
    function permission(scope, targets = []) {
      if (!granted.has(scope)) return false;
      const granular = debug.granularScopes.filter(item => item.scope === scope);
      return !granular.length || granular.some(item => !item.restricted || targets.some(target => item.targetIds.includes(target.replace(/^act_/, ''))));
    }
    const restrictions = [];
    const note = (operation, error) => {
      const detail = describeMetaDiagnostic({ operation, httpStatus: error?.httpStatus, code: error?.code, subcode: error?.subcode });
      if (!restrictions.includes(detail)) restrictions.push(detail);
    };
    function evaluation(capabilities) {
      const messages = [...restrictions];
      if (readOnly) messages.push('Conexión de solo lectura: no permite publicar, modificar, pausar ni revocar permisos remotos.');
      for (const [scope, status] of permissionStatuses) {
        if (status !== 'granted') messages.push(`Permiso ${scope}: ${status === 'declined' ? 'rechazado' : status === 'expired' ? 'vencido' : 'no confirmado'}.`);
      }
      if (!granted.has('ads_read') && !granted.has('ads_management')) messages.push('La consulta publicitaria requiere ads_read o ads_management confirmado.');
      if (!capabilities.insights) messages.push('Sin consulta de métricas habilitada: selecciona un recurso con tareas y permisos granulares de lectura confirmados.');
      if (!readOnly && !capabilities.facebookPublish && !capabilities.instagramPublish && !capabilities.adsPublish) messages.push('La publicación requiere recursos, tareas y permisos confirmados.');
      return {
        checkedAt: new Date(clock()).toISOString(), tokenType: debug.tokenType,
        expiresAt: debug.expiresAt, dataAccessExpiresAt: debug.dataAccessExpiresAt, expirationStatus: debug.expirationStatus,
        permissions: [...permissionStatuses].map(([name, status]) => ({ name, status })),
        limits: client.usageSnapshot(), restrictions: messages
      };
    }
    if (purpose === 'pause') {
      const selectedAccount = accountId(selected.adAccountId);
      if (!selectedAccount || !permission('ads_management', [selectedAccount])) throw validationFailure('list_ad_accounts', 'permission');
      const account = await validationStep('list_ad_accounts', () => client.get(selectedAccount, { fields: 'id,user_tasks' }, { signal }));
      if (accountId(account.id) !== selectedAccount) throw validationFailure('list_ad_accounts', 'account_mismatch');
      const tasks = Array.isArray(account.user_tasks) ? account.user_tasks.filter(task => ['ADVERTISE', 'MANAGE'].includes(task)) : [];
      if (!tasks.length) throw validationFailure('list_ad_accounts', 'permission');
      return {
        state: 'connected', identities: { userId: debug.userId, adAccountId: selectedAccount }, resources: { businesses: [], pages: [], adAccounts: [{ id: selectedAccount, tasks }] },
        capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: true, insights: false, whatsappAds: false },
        currency: null, timeZone: null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted],
        evaluation: evaluation({ insights: false, adsPublish: true })
      };
    }
    const measuring = purpose === 'insights';
    const discovery = !channel, readsPages = channel !== 'meta_ads' || !measuring;
    const readsAds = discovery || channel === 'meta_ads';
    const pageAllowed = granted.has('pages_show_list');
    const accountAllowed = granted.has('ads_read') || granted.has('ads_management');
    const pageRows = readsPages && pageAllowed
      ? await validationStep('list_pages', () => client.pages('me/accounts', { fields: measuring ? channel === 'instagram' ? 'id,tasks' : 'id,tasks,access_token' : PAGE_FIELDS, limit: 100 }, { signal })) : [];
    const accountRows = readsAds && accountAllowed
      ? await validationStep('list_ad_accounts', () => client.pages('me/adaccounts', { fields: measuring ? 'id,currency,timezone_name,user_tasks' : ACCOUNT_FIELDS, limit: 100 }, { signal })) : [];
    const businesses = new Map(), pageTokens = {};
    const pages = new Map(pageRows.filter(row => id(row?.id)).map(row => {
      if (typeof row.access_token === 'string' && row.access_token) pageTokens[row.id] = row.access_token;
      return [row.id, { id: row.id, name: name(row.name), tasks: Array.isArray(row.tasks) ? row.tasks.filter(task => ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE', 'MANAGE', 'MODERATE', 'MESSAGING'].includes(task)) : [], businessId: null, instagramId: null, whatsappNumber: null }];
    }));
    const adAccounts = new Map(accountRows.filter(row => accountId(row?.id)).map(row => {
      const key = accountId(row.id);
      return [key, { id: key, name: name(row.name), currency: /^[A-Z]{3}$/.test(row.currency) ? row.currency : null, timeZone: name(row.timezone_name) || null, accountStatus: Number.isSafeInteger(row.account_status) ? row.account_status : null, tasks: Array.isArray(row.user_tasks) ? row.user_tasks.filter(task => ['ADVERTISE', 'ANALYZE', 'AA_ANALYZE', 'MANAGE', 'DRAFT'].includes(task)) : [], businessId: null }];
    }));
    const page = readsPages ? pages.get(selected.pageId) : null;
    const adAccount = readsAds ? adAccounts.get(accountId(selected.adAccountId)) : null;
    function checkBase(operation, resource, pinned, allowed, needed) {
      if (needed && !resource || pinned && !resource && (allowed || requirePinned)) throw validationFailure(operation, !allowed ? 'permission' : 'account_mismatch');
      if (!allowed) note(operation);
    }
    if (readsPages) checkBase('list_pages', page, selected.pageId, pageAllowed, !discovery);
    if (readsAds) checkBase('list_ad_accounts', adAccount, selected.adAccountId, accountAllowed, !discovery);

    async function optional(operation, run) {
      try { return { value: await validationStep(operation, run) }; }
      catch (error) {
        if (!error.optionalFieldDenied) throw error;
        note(operation, error);
        return { error };
      }
    }
    async function enrich(operation, fields, edge, resources, pinned, normalize, apply, bulk = discovery) {
      if (bulk && resources.size) {
        const result = await optional(operation, () => client.pages(edge, { fields, limit: 100 }, { signal, optionalProjection: operation }));
        let verified = false;
        for (const row of result.value || []) {
          const resource = resources.get(normalize(row?.id));
          if (!resource) continue;
          apply(resource, row);
          if (resource === pinned) verified = true;
        }
        if (!pinned || verified) return result.error;
        // Collection fields may fail because of another resource. Only fall back
        // to a point read for a selection already checked in the base collection.
      }
      if (!pinned) return null;
      const result = await optional(operation, async () => {
        const row = await client.get(pinned.id, { fields }, { signal, optionalProjection: operation });
        if (normalize(row.id) !== pinned.id) throw new MetaApiError('account_mismatch');
        return row;
      });
      if (result.value) apply(pinned, result.value);
      return result.error;
    }
    function saveBusiness(resource, row, scoped) {
      const owner = id(row.business?.id);
      if (!owner || scoped && !permission('business_management', [resource.id, owner])) return;
      resource.businessId = owner;
      businesses.set(owner, { id: owner, name: name(row.business.name) });
    }
    const checkBusiness = !measuring || Boolean(selected.businessId);
    const canCheckBusiness = granted.has('business_management');
    const pageBusinessError = checkBusiness && canCheckBusiness && await enrich('verify_page_business', BUSINESS_FIELDS, 'me/accounts', pages, page, id, (resource, row) => saveBusiness(resource, row, true));
    // The AdAccount owner can also be read for metrics with ads_read. This is
    // insufficient for publication, which requires the selected Page owner too.
    const accountBusinessError = checkBusiness && (canCheckBusiness || measuring && adAccount) && await enrich('verify_ad_account_business', BUSINESS_FIELDS, 'me/adaccounts', adAccounts, adAccount, accountId, (resource, row) => saveBusiness(resource, row, !measuring));
    for (const [operation, resource, failure] of [['verify_page_business', page, pageBusinessError], ['verify_ad_account_business', adAccount, accountBusinessError]]) {
      if (!resource || !checkBusiness) continue;
      if (resource.businessId && selected.businessId && resource.businessId !== selected.businessId) throw validationFailure(operation, 'account_mismatch');
      if (!resource.businessId) {
        if (!failure) note(operation);
        if (selected.businessId && (requirePinned || !discovery)) throw validationFailure(operation, 'permission', failure || undefined);
      }
    }
    if (selected.businessId && !businesses.has(selected.businessId) && (requirePinned || !page && !adAccount)) {
      throw validationFailure('verify_business', businesses.size ? 'account_mismatch' : 'permission');
    }
    if (page?.businessId && adAccount?.businessId && page.businessId !== adAccount.businessId) throw validationFailure('verify_business', 'account_mismatch');
    if (!readOnly && checkBusiness && (pages.size || adAccounts.size) && !businesses.size && !pageBusinessError && !accountBusinessError) note('verify_business');

    const needsInstagram = channel === 'instagram' || channel === 'meta_ads' && includeInstagram;
    if (discovery || needsInstagram) {
      const instagramError = granted.has('instagram_basic') && await enrich('verify_instagram', INSTAGRAM_FIELDS, 'me/accounts', pages, page, id, (resource, row) => {
        const instagramId = id(row.instagram_business_account?.id);
        if (!instagramId || !permission('instagram_basic', [resource.id, instagramId])) return;
        resource.instagramId = instagramId;
        const username = name(row.instagram_business_account.username);
        if (username) resource.instagramName = username;
      });
      if (page?.instagramId && selected.instagramId && page.instagramId !== selected.instagramId) throw validationFailure('verify_instagram', 'account_mismatch');
      if (!page?.instagramId && (needsInstagram || selected.instagramId && requirePinned)) throw validationFailure('verify_instagram', 'permission', instagramError || undefined);
      if (pages.size && !granted.has('instagram_basic') || selected.instagramId && !page?.instagramId && !instagramError) note('verify_instagram');
    }
    const pagePermission = scope => permission(scope, [page?.id, ...(scope.startsWith('instagram_') ? [page?.instagramId] : [])].filter(Boolean));
    const task = required => Boolean(page && pagePermission('pages_show_list') && (page.tasks.includes(required) || page.tasks.includes('MANAGE')));
    if (measuring) {
      const allowed = channel === 'meta_ads'
        ? adAccount.tasks.some(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE'].includes(value)) && (permission('ads_read', [adAccount.id]) || permission('ads_management', [adAccount.id]))
        : task('ANALYZE') && pagePermission('pages_read_engagement') && (channel === 'instagram'
          ? pagePermission('instagram_basic') && pagePermission('instagram_manage_insights')
          : Boolean(pageTokens[page.id]) && pagePermission('read_insights'));
      if (!allowed) throw validationFailure(channel === 'meta_ads' ? 'list_ad_accounts' : channel === 'instagram' ? 'verify_instagram' : 'read_permissions', 'permission');
      const resource = channel === 'meta_ads' ? adAccount : page;
      const identities = { userId: user.id, ...(resource.businessId ? { businessId: resource.businessId } : {}),
        ...(channel === 'meta_ads' ? { adAccountId: adAccount.id } : { pageId: page.id, ...(channel === 'instagram' ? { instagramId: page.instagramId } : {}) }) };
      freshPageTokens = pageTokens;
      return {
        state: 'connected', identities, resources: { businesses: [...businesses.values()], pages: [...pages.values()], adAccounts: [...adAccounts.values()] },
        capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false },
        currency: adAccount?.currency ?? null, timeZone: adAccount?.timeZone ?? null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted],
        evaluation: evaluation({ insights: true })
      };
    }
    const facebookPublish = !readOnly && Boolean(page?.businessId && pageTokens[page.id] && task('CREATE_CONTENT') && pagePermission('pages_manage_posts') && pagePermission('pages_read_engagement'));
    const instagramPublish = !readOnly && Boolean(page?.businessId && pageTokens[page.id] && page.instagramId && task('CREATE_CONTENT') && pagePermission('instagram_basic') && pagePermission('instagram_content_publish'));
    const enabledAccount = Boolean(adAccount?.accountStatus === 1 && adAccount.currency && adAccount.timeZone);
    const adsPublish = !readOnly && Boolean(enabledAccount && adAccount.tasks.some(task => ['ADVERTISE', 'MANAGE'].includes(task)) && page?.businessId && page.businessId === adAccount.businessId && task('ADVERTISE') && pagePermission('pages_manage_ads') && permission('ads_management', [adAccount.id]));
    if (adsPublish && (discovery || whatsappAds)) {
      const failure = await enrich('verify_whatsapp', WHATSAPP_FIELDS, 'me/accounts', pages, page, id, (resource, row) => {
        if (typeof row.whatsapp_number === 'string' && /^\+\d{7,15}$/.test(row.whatsapp_number)) resource.whatsappNumber = row.whatsapp_number;
      }, false);
      if (!page.whatsappNumber && !failure) note('verify_whatsapp');
    }
    const adsInsights = Boolean(adAccount?.tasks.some(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE'].includes(value)) && (permission('ads_read', [adAccount.id]) || permission('ads_management', [adAccount.id])));
    const pageInsights = Boolean(page && task('ANALYZE') && pagePermission('pages_read_engagement') && (pageTokens[page.id] && pagePermission('read_insights') || page.instagramId && pagePermission('instagram_basic') && pagePermission('instagram_manage_insights')));
    const insights = adsInsights || pageInsights;
    const identities = { userId: user.id, userName: name(user.name) };
    const businessId = selected.businessId || page?.businessId || adAccount?.businessId;
    if (businessId) identities.businessId = businessId;
    if (page || discovery && selected.pageId) identities.pageId = page?.id || selected.pageId;
    if (needsInstagram && page?.instagramId || discovery && selected.instagramId) identities.instagramId = page?.instagramId || selected.instagramId;
    if (adAccount || discovery && selected.adAccountId) identities.adAccountId = adAccount?.id || selected.adAccountId;
    freshPageTokens = pageTokens;
    return {
      state: 'connected', identities, resources: { businesses: [...businesses.values()], pages: [...pages.values()], adAccounts: [...adAccounts.values()] },
      capabilities: { facebookPublish, instagramPublish, adsPublish, insights, whatsappAds: Boolean(adsPublish && page.whatsappNumber) },
      currency: adAccount?.currency ?? null, timeZone: adAccount?.timeZone ?? null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted],
      evaluation: evaluation({ insights, facebookPublish, instagramPublish, adsPublish }),
      credentials: { accessToken: credentials.accessToken, userId: debug.userId, expiresAt: debug.expiresAt, dataAccessExpiresAt: debug.dataAccessExpiresAt, pageTokens }
    };
  }
  async function searchTargeting({ kind, q, signal }) {
    if (!['location', 'interest'].includes(kind) || typeof q !== 'string' || !q.trim() || q.length > 200) fail('Búsqueda de segmentación no válida.');
    await validateConnection({ signal, purpose: 'insights', channel: 'meta_ads' });
    const params = kind === 'location' ? { type: 'adgeolocation', location_types: ['country', 'region', 'city'], q: q.trim(), limit: 100 } : { type: 'adinterest', q: q.trim(), limit: 100 };
    const rows = await client.pages('search', params, { signal });
    return rows.filter(row => kind === 'interest' ? id(row.id) : typeof row.key === 'string' && row.key && ['country', 'region', 'city'].includes(row.type)).map(row => ({
      key: `api:${kind}:${kind === 'interest' ? row.id : row.key}`, source: 'api', providerId: kind === 'interest' ? row.id : row.key,
      label: name(row.name), context: kind === 'location' ? { type: row.type, countryCode: name(row.country_code), region: name(row.region), regionId: id(row.region_id) } : { type: 'interest', path: Array.isArray(row.path) ? row.path.map(name) : [] }
    }));
  }
  async function estimateAudience({ spec, signal }) {
    const status = await validateConnection({ signal, purpose: 'insights', channel: 'meta_ads' });
    // spec.targeting is the normalized, server-validated Marketing API targeting spec.
    if (!spec?.targeting || typeof spec.targeting !== 'object' || Array.isArray(spec.targeting)) fail('Falta una segmentación validada.');
    const result = await client.get(`${status.identities.adAccountId}/reachestimate`, { targeting_spec: spec.targeting }, { signal });
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    const lower = data?.users_lower_bound, upper = data?.users_upper_bound;
    const available = Number.isFinite(lower) && Number.isFinite(upper) && lower >= 0 && upper >= lower && data?.estimate_ready !== false;
    return { status: available ? 'reported' : 'unavailable', lower: available ? lower : null, upper: available ? upper : null, source: 'meta_reachestimate', definition: 'potential_audience', reason: available ? null : 'Meta no ofrece estimación para esta audiencia.', fetchedAt: new Date(clock()).toISOString(), apiVersion: 'v26.0' };
  }
  const publishing = createMetaPublishingAdapter({ client, selected, validateConnection, pageToken: pageId => freshPageTokens[pageId], runtime, clock });
  const metrics = createMetaMetricsAdapter({ client, selected, validateConnection, pageToken: pageId => freshPageTokens[pageId] });
  return {
    validateConnection, estimateAudience, searchTargeting, usageSnapshot: client.usageSnapshot,
    async executeStep(options) {
      if (readOnly) throw new MetaApiError('permission');
      return publishing.executeStep(options);
    },
    inspectDelivery: publishing.inspectDelivery, verifyRemoteLink: publishing.verifyRemoteLink, fetchMeasurements: metrics.fetchMeasurements,
    async disconnect({ signal } = {}) {
      if (readOnly) throw new MetaApiError('permission');
      const result = await client.request('me/permissions', { method: 'DELETE', signal });
      if (result.success !== true) throw new MetaApiError('invalid_response');
      return { revoked: true };
    }
  };
}
