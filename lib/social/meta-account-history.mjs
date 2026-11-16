import { createHash } from 'node:crypto';
import { createMetaClient, MetaApiError } from './meta.mjs';
import { createMetaMetricsAdapter } from './meta-metrics.mjs';

export const HISTORY_PAGE_SIZE = 25;
export const HISTORY_SOURCES = Object.freeze({
  ads: 'https://developers.facebook.com/docs/marketing-api/insights',
  adsets: 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/',
  posts: 'https://developers.facebook.com/docs/graph-api/reference/page/published_posts/',
  instagram: 'https://developers.facebook.com/docs/instagram-api/reference/ig-media/insights/',
  health: 'https://transparency.meta.com/policies/ad-standards/restricted-goods-services/health-wellness/',
  terms: 'https://developers.facebook.com/terms/'
});
const remoteId = value => typeof value === 'string' && /^(?:act_)?\d+(?:_\d+)?$/.test(value) ? value : null;
const enumValue = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const exactDecimal = value => (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && value.length <= 100) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ? String(value) : null;
export function metaHistoryPeriod(now) {
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new TypeError('Fecha de análisis no válida.');
  const year = end.getUTCFullYear() - 1, month = end.getUTCMonth();
  const day = Math.min(end.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return { since: new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10), until: end.toISOString().slice(0, 10), observedAt: end.toISOString(), precision: 'calendar_day_current_day_partial', calendar: 'UTC dates; Ads reports in each account time zone' };
}
export function currentHistoryRules(now) {
  return {
    observedAt: now, sourceReviewedAt: '2026-11-16', apiVersion: 'v26.0',
    current: [
      { id: 'health', source: HISTORY_SOURCES.health, rule: 'Revisar claims de salud, atributos sensibles y restricciones de edad aplicables a cada producto; no prometer curas ni resultados garantizados.' },
      { id: 'targeting', source: HISTORY_SOURCES.adsets, rule: 'No usar audiencias o conversiones que sugieran salud u otra información sensible. La segmentación guardada es una instantánea actual, no evidencia histórica.' },
      { id: 'permissions', source: HISTORY_SOURCES.terms, rule: 'Acceso limitado por permisos, tareas y revisión de la aplicación; ninguna propuesta concede permisos ni modifica Meta.' },
      { id: 'measurement', source: HISTORY_SOURCES.ads, rule: 'Configurar y verificar medición antes de optimizar ventas. Las conversiones atribuidas por Meta no demuestran causalidad.' },
      { id: 'review', source: HISTORY_SOURCES.terms, rule: 'Contenido generado con IA requiere revisión humana y comprobación de las políticas vigentes antes de cualquier publicación. Esta es una salvaguarda local, no una aprobación de Meta.' }
    ],
    historical: { status: 'unverifiable', notice: 'No se recupera un historial oficial completo de reglas, segmentación, presupuestos ni políticas anteriores. Las configuraciones actuales no prueban qué reglas rigieron en los últimos 12 meses.' },
    limits: ['Facebook puede devolver aproximadamente 600 publicaciones clasificadas por año; agotar cursores no garantiza inventario histórico completo.', 'Contenido borrado, Stories vencidas, recursos no concedidos y reglas históricas no recuperables no son verificables.', 'Instagram devuelve métricas lifetime del contenido accesible; no equivalen al rendimiento dentro del año. Vacío no significa cero; puede haber 48 horas de demora.', 'Reach no se suma entre campañas, objetos, periodos ni plataformas.', 'Se excluyen textos libres, personas, comentarios individuales, leads, audiencias personalizadas y teléfonos. La segmentación se conserva solo como resumen no identificable.']
  };
}
export function initialHistoryTasks() { return [{ kind: 'discover_pages', resourceId: 'me' }, { kind: 'discover_ads', resourceId: 'me' }]; }
export function resourceHistoryTasks(kind, resourceId, pageId = null) {
  if (kind === 'ad_account') return ['ads_account', 'ads_campaign', 'campaigns', 'adsets'].map(task => ({ kind: task, resourceId }));
  return [{ kind: kind === 'facebook' ? 'posts' : 'media', resourceId, ...(pageId ? { pageId } : {}) }];
}
function configuration(row) {
  const out = {};
  for (const field of ['objective', 'status', 'effective_status', 'bid_strategy', 'optimization_goal', 'billing_event', 'destination_type', 'buying_type']) if (enumValue(row[field])) out[field] = row[field];
  for (const field of ['daily_budget', 'lifetime_budget', 'budget_remaining', 'bid_amount', 'spend_cap']) if (exactDecimal(row[field]) !== null) out[field] = exactDecimal(row[field]);
  for (const field of ['created_time', 'updated_time', 'start_time', 'stop_time', 'end_time']) if (date(row[field])) out[field] = date(row[field]);
  if (remoteId(row.campaign_id)) out.campaignId = row.campaign_id;
  if (row.targeting && typeof row.targeting === 'object') {
    out.targeting = { precision: 'privacy_filtered_current_snapshot', omitted: 'custom audiences, interests, exclusions, identities and fine geography' };
    for (const key of ['age_min', 'age_max']) if (Number.isSafeInteger(row.targeting[key]) && row.targeting[key] >= 13 && row.targeting[key] <= 100) out.targeting[key] = row.targeting[key];
    if (Array.isArray(row.targeting.geo_locations?.countries)) out.targeting.countries = row.targeting.geo_locations.countries.filter(value => typeof value === 'string' && /^[A-Z]{2}$/.test(value)).slice(0, 250);
    if (Array.isArray(row.targeting.publisher_platforms)) out.targeting.publisherPlatforms = row.targeting.publisher_platforms.filter(value => ['facebook', 'instagram', 'messenger', 'audience_network', 'threads', 'whatsapp'].includes(value));
  }
  if (Array.isArray(row.attribution_spec)) out.attribution = row.attribution_spec.filter(value => enumValue(value?.event_type) && Number.isSafeInteger(value.window_days) && value.window_days >= 0 && value.window_days <= 365).map(value => ({ eventType: value.event_type, windowDays: value.window_days }));
  if (row.promoted_object) out.promotedObject = { pixelId: remoteId(row.promoted_object.pixel_id), event: enumValue(row.promoted_object.custom_event_type) };
  return out;
}
const metric = (value, name, unit = 'count', estimated = false) => ({ value: exactDecimal(value), sourceMetric: name, unit, precision: 'provider_decimal_string', status: exactDecimal(value) === null ? 'unavailable' : estimated ? 'estimated' : 'reported' });
function paidItem(row, task, period, now) {
  if (!remoteId(row.account_id) || row.account_id.replace(/^act_/, '') !== task.resourceId.replace(/^act_/, '')) throw new MetaApiError('account_mismatch');
  if (task.kind === 'ads_campaign' && !remoteId(row.campaign_id)) throw new MetaApiError('invalid_response');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date_start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.date_stop || '') || row.date_start < period.since || row.date_stop > period.until || row.date_stop < row.date_start) throw new MetaApiError('invalid_response');
  const values = {};
  for (const name of ['impressions', 'clicks', 'inline_link_clicks', 'reach', 'frequency', 'ctr', 'cpc', 'cpm', 'spend']) values[name] = metric(row[name], name, name === 'spend' ? 'account_currency_decimal' : ['frequency', 'ctr', 'cpc', 'cpm'].includes(name) ? 'provider_ratio' : 'count', name === 'reach' || name === 'frequency');
  const allowedActions = ['post_engagement', 'link_click', 'onsite_conversion.messaging_conversation_started_7d', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];
  for (const action of allowedActions) {
    const rows = Array.isArray(row.actions) ? row.actions.filter(value => value?.action_type === action) : [];
    values[action] = metric(rows.length === 1 ? rows[0].value : null, `actions.${action}`);
  }
  return { kind: task.kind, resourceId: task.kind === 'ads_campaign' ? row.campaign_id : task.resourceId, data: { source: HISTORY_SOURCES.ads, accountId: task.resourceId, observedAt: now, period: { type: 'range', since: row.date_start, until: row.date_stop, requested: period, timeZone: task.timeZone || 'provider_account_timezone' }, dimensions: { level: task.kind === 'ads_campaign' ? 'campaign' : 'account', breakdowns: [] }, scope: 'paid', currency: /^[A-Z]{3}$/.test(row.account_currency || '') ? row.account_currency : null, values, attribution: 'provider_reported_default_not_causal', historicalRules: 'unverifiable' } };
}
function continuation(result, task) {
  if (!result.paging?.next) return null;
  // Persist only the opaque cursor, never paging URLs (which may contain tokens).
  const after = result.paging?.cursors?.after;
  if (typeof after !== 'string' || !/^[A-Za-z0-9_+\/=:-]{1,4096}$/.test(after) || after === task.after) throw new MetaApiError('invalid_response');
  const cursorHash = createCursorHash(after);
  if ((task.cursorHashes || []).includes(cursorHash) || (task.cursorHashes || []).length >= 1000) throw new MetaApiError('invalid_response');
  return { ...task, after, cursorHashes: [...(task.cursorHashes || []), cursorHash] };
}
// Cursor digests bound loop detection without retaining all continuation URLs.
const createCursorHash = value => createHash('sha256').update(value).digest('hex');
export function createMetaAccountHistoryReader({ connection, credentials, runtime, transport = {}, now }) {
  const rawClient = createMetaClient({ accessToken: credentials.accessToken, appSecret: runtime.appSecret, graphVersion: runtime.graphVersion, fetchImpl: transport.fetchImpl, readOnly: true, now: () => Date.parse(now) });
  let pageCount = 0;
  const client = { ...rawClient, async get(...args) {
    const result = await rawClient.get(...args);
    if (Array.isArray(result.data)) pageCount++;
    return result;
  } };
  const getPageToken = async pageId => {
    if (credentials.pageTokens?.[pageId]) return credentials.pageTokens[pageId];
    const page = await client.get(pageId, { fields: 'id,access_token' });
    if (page.id !== pageId || typeof page.access_token !== 'string' || !page.access_token) throw new MetaApiError('permission');
    return page.access_token;
  };
  return {
    usageSnapshot: client.usageSnapshot,
    async validate() {
      const debug = await client.debugToken({ appId: runtime.appId, expectedUserId: connection.identities?.userId || credentials.userId, authenticationMethod: connection.authenticationMethod === 'token' ? 'token' : 'oauth', now: Date.parse(now) });
      const granted = await client.get('me/permissions', { limit: 100 });
      if (!Array.isArray(granted.data) || granted.data.length > 100 || granted.paging?.next) throw new MetaApiError('invalid_response');
      const statuses = new Map();
      for (const row of granted.data) {
        if (typeof row.permission !== 'string' || !['granted', 'declined', 'expired'].includes(row.status)) continue;
        if (!['declined', 'expired'].includes(statuses.get(row.permission))) statuses.set(row.permission, row.status);
      }
      return { ...debug, permissions: debug.permissions.filter(scope => statuses.get(scope) === 'granted') };
    },
    async read(task, period, debug) {
      pageCount = 0;
      const limits = client.usageSnapshot();
      const regainSeconds = Math.max(0, ...limits.usage.map(value => (value.estimatedTimeToRegainAccess || 0) * 60));
      if (limits.retryAfter > 0 || regainSeconds > 0) throw new MetaApiError('rate_limit', { retryAfter: Math.max(limits.retryAfter || 0, regainSeconds) });
      const scopes = new Set(debug.permissions), options = {}, params = { limit: HISTORY_PAGE_SIZE, ...(task.after ? { after: task.after } : {}) };
      let path;
      const requireScopes = (...required) => {
        if (required.some(scope => !scopes.has(scope))) throw new MetaApiError('permission');
        if (task.kind.startsWith('discover_')) return;
        const targets = [task.resourceId, task.pageId, task.ownerId].filter(Boolean).map(value => value.replace(/^act_/, ''));
        for (const scope of required) {
          const restrictions = debug.granularScopes.filter(value => value.scope === scope);
          if (restrictions.length && !restrictions.some(value => !value.restricted || targets.some(target => value.targetIds.includes(target)))) throw new MetaApiError('permission');
        }
      };
      if (task.kind === 'discover_pages') { requireScopes('pages_show_list'); path = 'me/accounts'; params.fields = 'id,tasks,instagram_business_account{id}'; }
      else if (task.kind === 'discover_ads') { if (!scopes.has('ads_read') && !scopes.has('ads_management')) throw new MetaApiError('permission'); path = 'me/adaccounts'; params.fields = 'id,currency,timezone_name,user_tasks'; }
      else if (task.kind.startsWith('ads_') || ['campaigns', 'adsets'].includes(task.kind)) {
        requireScopes(scopes.has('ads_read') ? 'ads_read' : 'ads_management');
        if (task.kind.startsWith('ads_') && !(task.resourceTasks || []).some(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE'].includes(value))) throw new MetaApiError('permission');
        path = `${task.resourceId}/${task.kind.startsWith('ads_') ? 'insights' : task.kind}`;
        if (task.kind.startsWith('ads_')) Object.assign(params, { level: task.kind === 'ads_account' ? 'account' : 'campaign', time_range: JSON.stringify({ since: period.since, until: period.until }), fields: 'account_id,account_currency,campaign_id,date_start,date_stop,impressions,clicks,inline_link_clicks,reach,frequency,ctr,cpc,cpm,spend,actions' });
        else params.fields = task.kind === 'campaigns' ? 'id,objective,status,effective_status,buying_type,bid_strategy,daily_budget,lifetime_budget,budget_remaining,spend_cap,created_time,updated_time,start_time,stop_time' : 'id,campaign_id,status,effective_status,bid_strategy,optimization_goal,billing_event,destination_type,daily_budget,lifetime_budget,budget_remaining,bid_amount,targeting,attribution_spec,promoted_object,created_time,updated_time,start_time,end_time';
      } else if (task.kind === 'posts') {
        requireScopes('pages_read_engagement'); path = `${task.resourceId}/published_posts`; params.fields = 'id,created_time,status_type,is_published,attachments{media_type,target{id}}';
        options.accessToken = await getPageToken(task.resourceId);
      } else if (task.kind === 'media') {
        requireScopes('instagram_basic', 'pages_read_engagement'); path = `${task.resourceId}/media`; params.fields = 'id,media_type,media_product_type,timestamp';
      } else if (task.kind === 'organic_metrics') {
        const instagram = task.channel === 'instagram';
        requireScopes(...(instagram ? ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'] : ['read_insights', 'pages_read_engagement']));
        if (!(task.resourceTasks || []).some(value => ['ANALYZE', 'MANAGE'].includes(value))) throw new MetaApiError('permission');
        const token = instagram ? null : await getPageToken(task.pageId);
        // Reuse the versioned v26 metric matrix. One media object is one bounded
        // work unit; prevent a provider continuation from loading a full history.
        const boundedClient = { ...client, async pages(path, params, options) {
          const result = await client.get(path, { ...params, limit: 100 }, options);
          if (!Array.isArray(result.data) || result.data.length > 100 || result.paging?.next) throw new MetaApiError('invalid_response');
          options?.onPage?.(result.data); return result.data;
        } };
        const identities = { userId: debug.userId, pageId: task.pageId, ...(instagram ? { instagramId: task.ownerId } : {}) };
        const adapter = createMetaMetricsAdapter({ client: boundedClient, selected: identities, pageToken: () => token, validateConnection: async () => ({ identities, permissions: debug.permissions, resources: { pages: [{ id: task.pageId, tasks: task.resourceTasks || [] }] } }) });
        const query = { periodStart: period.since, periodEnd: period.until, windowStart: period.since + 'T00:00:00.000Z', windowEnd: period.observedAt, dimension: 'aggregate', timeZone: 'UTC', scope: 'organic', periodType: 'lifetime' };
        const result = await adapter.fetchMeasurements({ delivery: { channel: task.channel, remoteId: task.resourceId, remoteRefs: task.videoId ? { videoId: task.videoId } : {} }, spec: { mode: 'organic', integrationMethod: 'api', assetType: task.assetType, identities }, query });
        const items = result.snapshots.map((snapshot, index) => ({
          kind: 'organic_metrics', resourceId: `${task.channel}:${task.resourceId}:${index}`,
          data: {
            source: instagram ? HISTORY_SOURCES.instagram : HISTORY_SOURCES.posts, ownerId: task.ownerId,
            contentId: task.resourceId, observedAt: now,
            period: { type: 'lifetime', publishedAt: snapshot.evidence.publication?.at || null, requestedContentWindow: period },
            dimensions: { level: 'content', channel: task.channel, assetType: task.assetType, breakdowns: [] }, scope: snapshot.scope,
            values: Object.fromEntries(Object.entries(snapshot.values).map(([key, value]) => [key, {
              value: value.displayValue ?? (value.value === null ? null : String(value.value)), sourceMetric: value.sourceMetric,
              status: value.status, precision: value.precision, unit: value.unit, reason: value.reason
            }])),
            coverage: snapshot.coverage, historicalRules: 'unverifiable'
          }
        }));
        return { items, resources: [], tasks: [], next: null, pages: pageCount, missing: result.snapshots.filter(snapshot => !snapshot.coverage.complete).map(snapshot => snapshot.coverage.reason || 'metrics_partial') };
      } else throw new MetaApiError('invalid_response');
      const result = await client.get(path, params, options);
      if (!Array.isArray(result.data) || result.data.length > 100) throw new MetaApiError('invalid_response');
      const out = { items: [], resources: [], tasks: [], next: continuation(result, task), missing: [], pages: pageCount };
      for (const row of result.data) {
        if (task.kind === 'discover_pages' || task.kind === 'discover_ads') {
          if (!remoteId(row.id)) throw new MetaApiError('invalid_response');
          const account = task.kind === 'discover_ads';
          out.resources.push({ kind: account ? 'ad_account' : 'facebook', id: account ? `act_${row.id.replace(/^act_/, '')}` : row.id, ...(account ? { currency: /^[A-Z]{3}$/.test(row.currency || '') ? row.currency : null, timeZone: typeof row.timezone_name === 'string' && /^[A-Za-z_\-/+]{1,100}$/.test(row.timezone_name) ? row.timezone_name : null } : {}), tasks: (account ? row.user_tasks : row.tasks)?.filter(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE', 'ADVERTISE'].includes(value)) || [] });
          if (!account && remoteId(row.instagram_business_account?.id)) out.resources.push({ kind: 'instagram', id: row.instagram_business_account.id, pageId: row.id, tasks: Array.isArray(row.tasks) ? row.tasks.filter(value => ['ANALYZE', 'MANAGE'].includes(value)) : [] });
          continue;
        }
        if (task.kind.startsWith('ads_')) { out.items.push(paidItem(row, task, period, now)); continue; }
        if (!remoteId(row.id)) throw new MetaApiError('invalid_response');
        if (['campaigns', 'adsets'].includes(task.kind)) {
          out.items.push({ kind: task.kind, resourceId: row.id, data: { accountId: task.resourceId, source: HISTORY_SOURCES.adsets, observedAt: now, period: { type: 'current_snapshot', at: now }, configuration: configuration(row), historicalRules: 'unverifiable' } }); continue;
        }
        const publishedAt = date(task.kind === 'posts' ? row.created_time : row.timestamp);
        if (!publishedAt) throw new MetaApiError('invalid_response');
        if (publishedAt > period.observedAt) continue;
        const instagram = task.kind === 'media', channel = instagram ? 'instagram' : 'facebook';
        const video = instagram ? row.media_type === 'VIDEO' && row.media_product_type === 'REELS' : row.status_type === 'added_video';
        const attachment = row.attachments?.data?.find(value => value.media_type === 'video' && remoteId(value.target?.id));
        const supported = instagram ? row.media_type === 'IMAGE' && row.media_product_type === 'FEED' || video : !video || Boolean(attachment);
        out.items.push({ kind: instagram ? 'instagram_media' : 'facebook_post', resourceId: row.id, data: { ownerId: task.resourceId, source: instagram ? HISTORY_SOURCES.instagram : HISTORY_SOURCES.posts, observedAt: now, period: { type: 'current_snapshot', publishedAt, publishedWithinRequestedYear: publishedAt.slice(0, 10) >= period.since }, configuration: { mediaType: enumValue(row.media_type), productType: enumValue(row.media_product_type), statusType: typeof row.status_type === 'string' && /^[a-z_]{1,60}$/.test(row.status_type) ? row.status_type : null, published: instagram ? null : row.is_published === true }, metricsAvailability: supported ? 'pending' : 'unavailable_media_type', historicalRules: 'unverifiable' } });
        if (!supported) out.missing.push('media_type_metrics_unavailable');
        if (supported) out.tasks.push({ kind: 'organic_metrics', resourceId: row.id, ownerId: task.resourceId, pageId: instagram ? task.pageId : task.resourceId, channel, assetType: video ? 'video' : 'image', ...(attachment ? { videoId: attachment.target.id } : {}) });
      }
      return out;
    }
  };
}
