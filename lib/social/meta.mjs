import { createHmac } from 'node:crypto';
import { AppError, fail } from '../validation-core.mjs';
import { META_API_HOSTS } from './config.mjs';
import { createMetaPublishingAdapter } from './meta-publishing.mjs';
import { createMetaMetricsAdapter } from './meta-metrics.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 1000;
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80004]);
const PERMISSION_CODES = new Set([10, 200, 294]);

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
function retryAfterSeconds(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
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
function apiFailure(response, data, mutation) {
  const code = Number.isSafeInteger(data?.error?.code) ? data.error.code : null;
  const subcode = Number.isSafeInteger(data?.error?.error_subcode) ? data.error.error_subcode : null;
  const kind = code === 190 ? 'reconnect_required' : PERMISSION_CODES.has(code) || response.status === 403 ? 'permission'
    : RATE_CODES.has(code) || response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'unavailable' : 'rejected';
  const error = new MetaApiError(kind, { code, subcode, httpStatus: response.status, retryAfter: retryAfterSeconds(response.headers.get('retry-after')), uncertain: mutation && response.status >= 500 });
  // Classify only explicit metric/field failures; never retain Meta's raw message.
  // A generic code 100 can mean a malformed object, date or breakdown, not a capability.
  const message = typeof data?.error?.message === 'string' ? data.error.message : '';
  if (code === 100 && kind === 'rejected' && /valid insights metric|invalid metric|metric[^.\n]{0,100}(?:invalid|not supported|must be one of)|(?:not valid|invalid)[^.\n]{0,100}fields (?:param|parameter)|nonexisting field[^.\n]{0,100}AdsInsights/i.test(message)) error.invalidMetric = true;
  return error;
}
function expiration(seconds, now) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds * 1000 <= now || !Number.isSafeInteger(seconds * 1000) || seconds * 1000 > 8640000000000000) throw new MetaApiError('reconnect_required');
  return new Date(seconds * 1000).toISOString();
}
function exchangedToken(data) {
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) throw new MetaApiError('invalid_response');
  const expires = Date.now() + data.expires_in * 1000;
  if (!Number.isSafeInteger(expires) || expires > 8640000000000000) throw new MetaApiError('invalid_response');
  return { accessToken: data.access_token, expiresAt: new Date(expires).toISOString() };
}

export function createMetaClient({ accessToken = '', appSecret, graphVersion = 'v26.0', fetchImpl = fetch }) {
  if (typeof appSecret !== 'string' || !appSecret) fail('Configura META_APP_SECRET.', 409);
  if (graphVersion !== 'v26.0') fail('La versión Meta no tiene una matriz de capacidades verificada.', 409);
  async function request(path, { method = 'GET', params = {}, body = {}, rawBody, uploadHeaders = {}, signal: externalSignal, accessToken: token = accessToken } = {}) {
    const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(rawBody === undefined ? 30000 : 240000)]) : AbortSignal.timeout(rawBody === undefined ? 30000 : 240000);
    method = method.toUpperCase();
    if (!['GET', 'POST', 'DELETE'].includes(method)) fail('Método Meta no permitido.');
    const mutation = method !== 'GET';
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
        if (!response.ok) throw apiFailure(response, {}, mutation);
        throw new MetaApiError('invalid_response', { httpStatus: response.status, uncertain: mutation });
      }
      if (!response.ok || data.error) throw apiFailure(response, data, mutation);
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
    request, get, post, pages,
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
    async debugToken({ accessToken: inspectedToken = accessToken, appId, expectedUserId, signal, now = Date.now() }) {
      if (!inspectedToken || !appId) throw new MetaApiError('reconnect_required');
      const { data } = await get('debug_token', { input_token: inspectedToken }, { signal, accessToken: `${appId}|${appSecret}` });
      if (!data || data.is_valid !== true || String(data.app_id) !== String(appId) || data.type !== 'USER' || !validId(data.user_id)) throw new MetaApiError('reconnect_required');
      if (expectedUserId && String(data.user_id) !== String(expectedUserId)) throw new MetaApiError('account_mismatch');
      return {
        userId: String(data.user_id), expiresAt: expiration(data.expires_at, now), dataAccessExpiresAt: expiration(data.data_access_expires_at, now),
        permissions: Array.isArray(data.scopes) ? data.scopes.filter(value => typeof value === 'string') : [],
        granularScopes: Array.isArray(data.granular_scopes) ? data.granular_scopes.filter(item => typeof item?.scope === 'string').map(item => ({ scope: item.scope, targetIds: Array.isArray(item.target_ids) ? item.target_ids.filter(validId).map(String) : [] })) : []
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
const mismatch = () => { throw new MetaApiError('account_mismatch'); };

export function createMetaApiConnector({ connection, credentials, transport = {} }) {
  const appId = transport.appId ?? process.env.META_APP_ID;
  const client = createMetaClient({ accessToken: credentials.accessToken, appSecret: transport.appSecret ?? process.env.META_APP_SECRET, graphVersion: transport.graphVersion ?? process.env.META_GRAPH_VERSION ?? 'v26.0', fetchImpl: transport.fetchImpl });
  const selected = connection.data?.identities ?? connection.identities ?? {};
  const clock = () => typeof transport.now === 'function' ? transport.now() : transport.now ?? Date.now();
  let freshPageTokens = {};
  async function optionalPages(path, params, signal, required = false) {
    try { return await client.pages(path, params, { signal }); }
    catch (error) { if (!required && error instanceof MetaApiError && error.kind === 'permission') return []; throw error; }
  }
  async function validateConnection({ signal, purpose = 'publish', channel = null } = {}) {
    if (!['publish', 'pause', 'insights'].includes(purpose) || purpose === 'insights' && !['meta_ads', 'facebook', 'instagram'].includes(channel)) fail('Propósito de validación Meta no permitido.');
    const debug = await client.debugToken({ appId, expectedUserId: selected.userId || credentials.userId, signal, now: clock() });
    const user = await client.get('me', { fields: 'id,name' }, { signal });
    if (id(user.id) !== debug.userId) mismatch();
    const grantedRows = await client.pages('me/permissions', {}, { signal });
    const granted = new Set(grantedRows.filter(row => row?.status === 'granted').map(row => row.permission).filter(permission => debug.permissions.includes(permission)));
    if (purpose === 'pause') {
      const selectedAccount = accountId(selected.adAccountId);
      if (!selectedAccount || !granted.has('ads_management')) throw new MetaApiError('permission');
      const scope = debug.granularScopes.find(item => item.scope === 'ads_management');
      if (scope?.targetIds.length && !scope.targetIds.includes(selectedAccount) && !scope.targetIds.includes(selectedAccount.replace(/^act_/, ''))) throw new MetaApiError('permission');
      const account = await client.get(selectedAccount, { fields: 'id,name,currency,timezone_name,account_status,user_tasks,business{id,name}' }, { signal });
      if (accountId(account.id) !== selectedAccount) mismatch();
      const tasks = Array.isArray(account.user_tasks) ? account.user_tasks.filter(task => ['ADVERTISE', 'MANAGE'].includes(task)) : [];
      if (!tasks.length) throw new MetaApiError('permission');
      const identities = { userId: debug.userId, adAccountId: selectedAccount };
      const businessId = id(account.business?.id);
      if (businessId) identities.businessId = businessId;
      return {
        state: 'connected', identities, resources: { businesses: businessId ? [{ id: businessId, name: name(account.business?.name) }] : [], pages: [], adAccounts: [{ id: selectedAccount, tasks, businessId, accountStatus: account.account_status }] },
        capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: true, insights: false, whatsappAds: false },
        currency: /^[A-Z]{3}$/.test(account.currency) ? account.currency : null, timeZone: name(account.timezone_name) || null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted]
      };
    }
    const measuring = purpose === 'insights';
    const pageRows = measuring && channel === 'meta_ads' ? [] : await optionalPages('me/accounts', {
      fields: measuring ? `id,name,tasks,access_token,business{id,name}${channel === 'instagram' ? ',instagram_business_account{id,username}' : ''}` : 'id,name,tasks,access_token,business{id,name},instagram_business_account{id,username},whatsapp_number', limit: 100
    }, signal, measuring);
    const accountRows = measuring && channel !== 'meta_ads' ? [] : await optionalPages('me/adaccounts', { fields: 'id,name,currency,timezone_name,account_status,user_tasks,business{id,name}', limit: 100 }, signal, measuring);
    const businesses = new Map(), pageTokens = {};
    function business(resource) {
      if (!id(resource?.id)) return null;
      businesses.set(resource.id, { id: resource.id, name: name(resource.name) });
      return resource.id;
    }
    const pages = pageRows.filter(row => id(row?.id)).map(row => {
      if (typeof row.access_token === 'string' && row.access_token) pageTokens[row.id] = row.access_token;
      return { id: row.id, name: name(row.name), tasks: Array.isArray(row.tasks) ? row.tasks.filter(task => ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE', 'MANAGE', 'MODERATE', 'MESSAGING'].includes(task)) : [], businessId: business(row.business), instagramId: id(row.instagram_business_account?.id), whatsappNumber: typeof row.whatsapp_number === 'string' ? row.whatsapp_number.slice(0, 50) : null };
    });
    const adAccounts = accountRows.filter(row => accountId(row?.id)).map(row => ({ id: accountId(row.id), name: name(row.name), currency: /^[A-Z]{3}$/.test(row.currency) ? row.currency : null, timeZone: name(row.timezone_name) || null, accountStatus: Number.isSafeInteger(row.account_status) ? row.account_status : null, tasks: Array.isArray(row.user_tasks) ? row.user_tasks.filter(task => ['ADVERTISE', 'ANALYZE', 'AA_ANALYZE', 'MANAGE', 'DRAFT'].includes(task)) : [], businessId: business(row.business) }));
    const page = selected.pageId && (!measuring || channel !== 'meta_ads') ? pages.find(row => row.id === selected.pageId) : null;
    const adAccount = selected.adAccountId && (!measuring || channel === 'meta_ads') ? adAccounts.find(row => row.id === accountId(selected.adAccountId)) : null;
    if (measuring) {
      if (channel === 'meta_ads' ? !adAccount : !page) mismatch();
      if (channel === 'instagram' && (!selected.instagramId || page.instagramId !== selected.instagramId)) mismatch();
    } else {
      if (selected.pageId && !page || selected.adAccountId && !adAccount || selected.businessId && !businesses.has(selected.businessId)) mismatch();
      if (selected.instagramId && (!page || page.instagramId !== selected.instagramId)) mismatch();
      if (selected.businessId && (page && page.businessId !== selected.businessId || adAccount && adAccount.businessId !== selected.businessId)) mismatch();
      if (page?.businessId && adAccount?.businessId && page.businessId !== adAccount.businessId) mismatch();
    }
    function permission(scope, targets = []) {
      if (!granted.has(scope)) return false;
      const granular = debug.granularScopes.find(item => item.scope === scope);
      return !granular?.targetIds.length || !targets.length || targets.some(target => granular.targetIds.includes(target?.replace(/^act_/, '')) || granular.targetIds.includes(target));
    }
    const pagePermission = scope => permission(scope, [page?.id, page?.instagramId].filter(Boolean));
    const task = required => Boolean(page?.tasks.includes(required) || page?.tasks.includes('MANAGE'));
    if (measuring) {
      const allowed = channel === 'meta_ads'
        ? adAccount.tasks.some(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE'].includes(value)) && (permission('ads_read', [adAccount.id]) || permission('ads_management', [adAccount.id]))
        : task('ANALYZE') && pagePermission('pages_read_engagement') && (channel === 'instagram'
          ? pagePermission('instagram_basic') && pagePermission('instagram_manage_insights')
          : Boolean(pageTokens[page.id]) && pagePermission('read_insights'));
      if (!allowed) throw new MetaApiError('permission');
      const resource = channel === 'meta_ads' ? adAccount : page;
      const identities = { userId: user.id, ...(resource.businessId ? { businessId: resource.businessId } : {}),
        ...(channel === 'meta_ads' ? { adAccountId: adAccount.id } : { pageId: page.id, ...(channel === 'instagram' ? { instagramId: page.instagramId } : {}) }) };
      freshPageTokens = pageTokens;
      return {
        state: 'connected', identities, resources: { businesses: [...businesses.values()], pages, adAccounts },
        capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: true, whatsappAds: false },
        currency: adAccount?.currency ?? null, timeZone: adAccount?.timeZone ?? null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted]
      };
    }
    const facebookPublish = Boolean(pageTokens[page?.id] && task('CREATE_CONTENT') && pagePermission('pages_manage_posts') && pagePermission('pages_read_engagement'));
    const instagramPublish = Boolean(pageTokens[page?.id] && page?.instagramId && task('CREATE_CONTENT') && pagePermission('instagram_basic') && pagePermission('instagram_content_publish'));
    const enabledAccount = Boolean(adAccount?.accountStatus === 1 && adAccount.currency && adAccount.timeZone);
    const adsPublish = Boolean(enabledAccount && adAccount.tasks.some(task => ['ADVERTISE', 'MANAGE'].includes(task)) && page && task('ADVERTISE') && pagePermission('pages_manage_ads') && permission('ads_management', [adAccount.id]));
    const insights = Boolean(page && task('ANALYZE') && (pagePermission('read_insights') || page?.instagramId && pagePermission('instagram_manage_insights')) || enabledAccount && permission('ads_read', [adAccount.id]));
    const identities = { userId: user.id, userName: name(user.name) };
    const businessId = selected.businessId || page?.businessId || adAccount?.businessId;
    if (businessId) identities.businessId = businessId;
    if (page) identities.pageId = page.id;
    if (page?.instagramId) identities.instagramId = page.instagramId;
    if (adAccount) identities.adAccountId = adAccount.id;
    freshPageTokens = pageTokens;
    return {
      state: 'connected', identities, resources: { businesses: [...businesses.values()], pages, adAccounts },
      capabilities: { facebookPublish, instagramPublish, adsPublish, insights, whatsappAds: Boolean(adsPublish && page.whatsappNumber) },
      currency: adAccount?.currency ?? null, timeZone: adAccount?.timeZone ?? null, expiresAt: debug.expiresAt, validatedAt: new Date(clock()).toISOString(), permissions: [...granted],
      credentials: { accessToken: credentials.accessToken, userId: debug.userId, expiresAt: debug.expiresAt, dataAccessExpiresAt: debug.dataAccessExpiresAt, pageTokens }
    };
  }
  async function searchTargeting({ kind, q, signal }) {
    if (!['location', 'interest'].includes(kind) || typeof q !== 'string' || !q.trim() || q.length > 200) fail('Búsqueda de segmentación no válida.');
    const status = await validateConnection({ signal });
    if (!status.identities.adAccountId || !status.permissions.some(scope => ['ads_read', 'ads_management'].includes(scope))) throw new MetaApiError('permission');
    const params = kind === 'location' ? { type: 'adgeolocation', location_types: ['country', 'region', 'city'], q: q.trim(), limit: 100 } : { type: 'adinterest', q: q.trim(), limit: 100 };
    const rows = await client.pages('search', params, { signal });
    return rows.filter(row => kind === 'interest' ? id(row.id) : typeof row.key === 'string' && row.key && ['country', 'region', 'city'].includes(row.type)).map(row => ({
      key: `api:${kind}:${kind === 'interest' ? row.id : row.key}`, source: 'api', providerId: kind === 'interest' ? row.id : row.key,
      label: name(row.name), context: kind === 'location' ? { type: row.type, countryCode: name(row.country_code), region: name(row.region), regionId: id(row.region_id) } : { type: 'interest', path: Array.isArray(row.path) ? row.path.map(name) : [] }
    }));
  }
  async function estimateAudience({ spec, signal }) {
    const status = await validateConnection({ signal });
    if (!status.identities.adAccountId || !status.permissions.some(scope => ['ads_read', 'ads_management'].includes(scope))) throw new MetaApiError('permission');
    // spec.targeting is the normalized, server-validated Marketing API targeting spec.
    if (!spec?.targeting || typeof spec.targeting !== 'object' || Array.isArray(spec.targeting)) fail('Falta una segmentación validada.');
    const result = await client.get(`${status.identities.adAccountId}/reachestimate`, { targeting_spec: spec.targeting }, { signal });
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    const lower = data?.users_lower_bound, upper = data?.users_upper_bound;
    const available = Number.isFinite(lower) && Number.isFinite(upper) && lower >= 0 && upper >= lower && data?.estimate_ready !== false;
    return { status: available ? 'reported' : 'unavailable', lower: available ? lower : null, upper: available ? upper : null, source: 'meta_reachestimate', definition: 'potential_audience', reason: available ? null : 'Meta no ofrece estimación para esta audiencia.', fetchedAt: new Date(clock()).toISOString(), apiVersion: 'v26.0' };
  }
  const publishing = createMetaPublishingAdapter({ client, selected, validateConnection, pageToken: pageId => freshPageTokens[pageId], env: transport.env ?? process.env, clock });
  const metrics = createMetaMetricsAdapter({ client, selected, validateConnection, pageToken: pageId => freshPageTokens[pageId] });
  return {
    validateConnection, estimateAudience, searchTargeting, executeStep: publishing.executeStep, inspectDelivery: publishing.inspectDelivery, verifyRemoteLink: publishing.verifyRemoteLink, fetchMeasurements: metrics.fetchMeasurements,
    async disconnect({ signal } = {}) {
      const result = await client.request('me/permissions', { method: 'DELETE', signal });
      if (result.success !== true) throw new MetaApiError('invalid_response');
      return { revoked: true };
    }
  };
}
