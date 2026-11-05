import { MetaApiError } from './meta.mjs';
import { fail } from '../validation-core.mjs';
import { parseMoneyMinor } from '../business/money.mjs';

// Field/definition matrix checked against Meta's v26 references. Definitions are
// deliberately distinct across Ads, Instagram media, Facebook posts and Reels.
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights
// https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats
// https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md
// https://developers.facebook.com/docs/graph-api/reference/insights
// https://developers.facebook.com/docs/graph-api/reference/video/video_insights
const VERSION = 'v26.0';
const ID = /^\d+$/;
const POST_ID = /^\d+(?:_\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIMENSIONS = { aggregate: [], daily: [], placement: ['publisher_platform', 'platform_position'], age_gender: ['age', 'gender'], country: ['country'] };
const PAID = {
  spendMinor: ['spend', 'minor_currency'], impressions: ['impressions', 'count'], reach: ['reach', 'count', true],
  frequency: ['frequency', 'ratio', true], linkClicks: ['inline_link_clicks', 'count'],
  conversations: ['actions', 'count'], interactions: ['actions', 'count'],
  videoP25: ['video_p25_watched_actions', 'count'], videoP50: ['video_p50_watched_actions', 'count'],
  videoP75: ['video_p75_watched_actions', 'count'], videoP100: ['video_p100_watched_actions', 'count']
};
const IG = {
  views: ['views', 'count'], reach: ['reach', 'count', true], likes: ['likes', 'count'], comments: ['comments', 'count'],
  saves: ['saved', 'count'], shares: ['shares', 'count'], interactions: ['total_interactions', 'count']
};
const IG_REEL = { ...IG, averageWatchTime: ['ig_reels_avg_watch_time', 'milliseconds'], totalWatchTime: ['ig_reels_video_view_total_time', 'milliseconds'], skipRate: ['reels_skip_rate', 'percent', true] };
const FB = { views: ['post_media_view', 'count'], reach: ['post_total_media_view_unique', 'count', true], linkClicks: ['post_clicks_by_type', 'count'], reactions: ['post_reactions_by_type_total', 'count'] };
const FB_REEL = {
  plays: ['fb_reels_total_plays', 'count'], reach: ['post_impressions_unique', 'count', true],
  averageWatchTime: ['post_video_avg_time_watched', 'milliseconds'], comments: ['post_video_social_actions', 'count'],
  shares: ['post_video_social_actions', 'count'], reactions: ['post_video_likes_by_reaction_type', 'count']
};
const CONVERSATION = 'onsite_conversion.messaging_conversation_started_7d';
const META_FIELDS = ['ad_id', 'account_id', 'date_start', 'date_stop', 'account_currency'];
const REACTIONS = new Set(['like', 'love', 'wow', 'haha', 'sorry', 'anger', 'care', 'sad', 'angry']);
const unavailable = (sourceMetric, unit, reason = 'not_reported', status = 'unavailable') => ({ value: null, unit, sourceMetric, status, precision: 'unknown', displayValue: null, reason });
function numeric(raw, sourceMetric, unit = 'count', estimated = false) {
  if (raw === undefined || raw === null || raw === '') return unavailable(sourceMetric, unit);
  if (!(typeof raw === 'number' || typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw))) return unavailable(sourceMetric, unit, 'invalid_numeric_value');
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return unavailable(sourceMetric, unit, 'invalid_numeric_value');
  return { value, unit, sourceMetric, status: estimated ? 'estimated' : 'reported', precision: 'exact', displayValue: String(raw), reason: null };
}
function money(raw) {
  if (raw === null || raw === undefined || raw === '') return unavailable('spend', 'minor_currency');
  try {
    if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error();
    const value = parseMoneyMinor(raw, { decimalSeparator: '.', groupSeparator: '' });
    return { value, unit: 'minor_currency', sourceMetric: 'spend', status: 'reported', precision: 'exact', displayValue: raw, reason: null };
  } catch { return unavailable('spend', 'minor_currency', 'invalid_money_value'); }
}
function action(list, type, source = 'actions') {
  if (!Array.isArray(list)) return unavailable(`${source}.${type}`, 'count');
  const matches = list.filter(item => item?.action_type === type);
  return matches.length === 1 ? numeric(matches[0].value, `${source}.${type}`) : unavailable(`${source}.${type}`, 'count', matches.length ? 'ambiguous_action' : 'action_not_reported');
}
function scalar(result) {
  if (!result) return undefined;
  if (result.period && result.period !== 'lifetime') throw new MetaApiError('invalid_response');
  if (result.total_value && Object.hasOwn(result.total_value, 'value')) return result.total_value.value;
  return Array.isArray(result.values) && result.values.length === 1 ? result.values[0]?.value : undefined;
}
function reactionCount(raw, source) {
  if (typeof raw === 'number' || typeof raw === 'string') return numeric(raw, source);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable(source, 'count');
  const entries = Object.entries(raw);
  if (!entries.length || entries.some(([key, value]) => !REACTIONS.has(key.toLowerCase()) || numeric(value, source).value === null)) return unavailable(source, 'count', 'unrecognized_reaction_breakdown');
  return numeric(entries.reduce((total, [, value]) => total + Number(value), 0), `${source}.sum_reported_reaction_types`);
}
function validateQuery(query, paid) {
  const day = value => typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!query || !day(query.periodStart) || !day(query.periodEnd) || query.periodEnd < query.periodStart || !Object.hasOwn(DIMENSIONS, query.dimension)
    || !Number.isFinite(Date.parse(query.windowStart)) || !Number.isFinite(Date.parse(query.windowEnd)) || Date.parse(query.windowEnd) < Date.parse(query.windowStart)
    || typeof query.timeZone !== 'string' || query.scope !== (paid ? 'paid' : 'organic') || !['range', 'lifetime'].includes(query.periodType)) fail('Consulta de métricas Meta no válida.');
  if (paid && query.periodType !== 'range') fail('Ads Insights requiere un intervalo explícito.');
}
function snapshot(query, entity, scope, definition, currency = null) {
  return {
    integrationMethod: 'api', adapterVersion: 'meta-api-v1', apiVersion: VERSION, definitionVersion: `${definition}-v26-v1`,
    query: structuredClone(query), periodStart: query.windowStart, periodEnd: query.windowEnd, timeZone: query.timeZone,
    currency, scope, attributionSetting: null, actionReportTime: null, dimension: query.dimension, entity,
    values: {}, rows: [], coverage: { complete: true, rowCount: 0, reason: null }, evidence: { matrixVersion: 'meta-insights-v26-v1', providerDelayHours: 48 }
  };
}
const cacheKey = (group, dimension, field) => `${VERSION}:${group}:${dimension}:${field}`;
function metricValues(matrix, unsupported, group, dimension, convert) {
  return Object.fromEntries(Object.entries(matrix).map(([key, [field, unit, estimated]]) => [key,
    unsupported.has(cacheKey(group, dimension, field)) ? unavailable(field, unit, 'metric_not_supported', 'unsupported') : convert(key, field, unit, estimated)]));
}
function ownedId(value, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new MetaApiError('account_mismatch');
  return value;
}
function normalizeAttribution(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) return null;
  if (raw.some(item => !item || typeof item.event_type !== 'string' || !/^[A-Z_]{1,60}$/.test(item.event_type) || !Number.isSafeInteger(item.window_days) || item.window_days < 0 || item.window_days > 365)) return null;
  return raw.map(({ event_type, window_days }) => ({ event_type, window_days }));
}

export function createMetaMetricsAdapter({ client, selected, validateConnection, pageToken }) {
  async function collect(path, params, options) {
    const rows = [];
    try {
      await client.pages(path, params, { ...options, onPage: page => { for (const row of page) rows.push(row); } });
      return { rows, complete: true, reason: null };
    } catch (error) {
      // Authorization, account throttling and unsafe continuations must reach the
      // worker. Only an interrupted read with usable pages can become partial.
      if (rows.length && error instanceof MetaApiError && ['transport', 'unavailable', 'invalid_response'].includes(error.kind)) return { rows, complete: false, reason: `pagination_${error.kind}` };
      throw error;
    }
  }
  async function capabilities(path, fields, params, options, group, dimension, unsupported, ads = false) {
    const active = fields.filter(field => !unsupported.has(cacheKey(group, dimension, field)));
    if (!active.length) return { rows: [], complete: true, reason: null };
    const request = selectedFields => collect(path, { ...params, [ads ? 'fields' : 'metric']: (ads ? [...META_FIELDS, ...selectedFields] : selectedFields).join(',') }, options);
    try { return await request(active); }
    catch (error) {
      if (!(error instanceof MetaApiError) || error.invalidMetric !== true) throw error;
      // Verify the Ads query without optional metrics before interpreting a field
      // error. A generic 100 is never caught here, even for a single metric.
      if (ads) await request([]);
      const parts = [];
      for (const field of active) {
        try { parts.push(await request([field])); }
        catch (singleError) {
          if (!(singleError instanceof MetaApiError) || singleError.invalidMetric !== true) throw singleError;
          unsupported.add(cacheKey(group, dimension, field));
        }
      }
      if (!ads) return { rows: parts.flatMap(part => part.rows), complete: parts.every(part => part.complete), reason: parts.find(part => !part.complete)?.reason ?? null };
      const merged = new Map();
      for (const part of parts) {
        const seen = new Set();
        for (const row of part.rows) {
          const key = JSON.stringify([row.ad_id, row.account_id, row.date_start, row.date_stop, ...DIMENSIONS[dimension].map(field => row[field])]);
          if (seen.has(key)) throw new MetaApiError('invalid_response');
          seen.add(key);
          if (!merged.has(key)) merged.set(key, { ...row });
          else {
            const previous = merged.get(key);
            if (previous.account_currency !== row.account_currency) throw new MetaApiError('invalid_response');
            Object.assign(previous, row);
          }
        }
      }
      return { rows: [...merged.values()], complete: parts.every(part => part.complete), reason: parts.find(part => !part.complete)?.reason ?? null };
    }
  }
  async function context(spec, channel, query, signal) {
    const status = await validateConnection({ signal, purpose: 'insights', channel });
    for (const key of ['userId', ...(spec.identities?.businessId ? ['businessId'] : []), channel === 'meta_ads' ? 'adAccountId' : 'pageId', ...(channel === 'instagram' ? ['instagramId'] : [])]) {
      if (!spec.identities?.[key] || spec.identities[key] !== selected[key] || spec.identities[key] !== status.identities[key]) throw new MetaApiError('account_mismatch');
    }
    const permissions = new Set(status.permissions);
    const required = channel === 'meta_ads' ? [] : channel === 'instagram' ? ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'] : ['read_insights', 'pages_read_engagement'];
    const page = status.resources.pages.find(item => item.id === spec.identities.pageId);
    if (required.some(permission => !permissions.has(permission)) || channel === 'meta_ads' && !['ads_read', 'ads_management'].some(permission => permissions.has(permission))
      || channel === 'facebook' && !page?.tasks.some(task => ['ANALYZE', 'MANAGE'].includes(task))) throw new MetaApiError('permission');
    if (channel === 'meta_ads' && (status.currency !== spec.currency || status.timeZone !== query.timeZone || spec.timeZone !== query.timeZone)) throw new MetaApiError('account_mismatch');
    const token = channel === 'facebook' ? pageToken(spec.identities.pageId) : null;
    if (channel === 'facebook' && !token) throw new MetaApiError('permission');
    return { signal, ...(token ? { accessToken: token } : {}) };
  }
  function paidRow(row, query, adId, account) {
    if (row.ad_id !== adId || row.account_id !== account.replace(/^act_/, '')) throw new MetaApiError('account_mismatch');
    if (!DAY.test(row.date_start || '') || !DAY.test(row.date_stop || '') || row.date_start < query.periodStart || row.date_stop > query.periodEnd || row.date_stop < row.date_start
      || query.dimension === 'daily' && row.date_start !== row.date_stop || query.dimension !== 'daily' && (row.date_start !== query.periodStart || row.date_stop !== query.periodEnd)) throw new MetaApiError('invalid_response');
    const validDimension = {
      publisher_platform: value => ['facebook', 'instagram', 'audience_network', 'messenger', 'threads', 'whatsapp'].includes(value),
      platform_position: value => typeof value === 'string' && /^[a-z_]{1,60}$/.test(value),
      age: value => typeof value === 'string' && /^(?:\d{2}-\d{2}|\d{2}\+|unknown)$/.test(value),
      gender: value => ['male', 'female', 'unknown'].includes(value),
      country: value => typeof value === 'string' && /^(?:[A-Z]{2}|unknown)$/.test(value)
    };
    for (const field of DIMENSIONS[query.dimension]) if (!validDimension[field](row[field])) throw new MetaApiError('invalid_response');
  }
  async function paid(delivery, spec, query, unsupported, options) {
    const refs = { ...delivery.preparedRefs, ...delivery.remoteRefs };
    const adId = ownedId(refs.adId);
    const ad = await client.get(adId, { fields: 'id,account_id,adset_id,campaign_id' }, options);
    if (ad.id !== adId || ad.account_id !== spec.identities.adAccountId.replace(/^act_/, '') || refs.adSetId && ad.adset_id !== refs.adSetId || refs.campaignId && ad.campaign_id !== refs.campaignId) throw new MetaApiError('account_mismatch');
    const adsetId = ownedId(ad.adset_id);
    const adset = await client.get(adsetId, { fields: 'id,account_id,campaign_id,attribution_spec' }, options);
    if (adset.id !== adsetId || adset.account_id !== ad.account_id || adset.campaign_id !== ad.campaign_id) throw new MetaApiError('account_mismatch');
    const attribution = normalizeAttribution(adset.attribution_spec);
    const params = { time_range: { since: query.periodStart, until: query.periodEnd }, time_increment: query.dimension === 'daily' ? 1 : 'all_days', action_report_time: 'impression', use_unified_attribution_setting: true, limit: 100, ...(DIMENSIONS[query.dimension].length ? { breakdowns: DIMENSIONS[query.dimension] } : {}) };
    const group = 'ads';
    const result = await capabilities(`${adId}/insights`, [...new Set(Object.values(PAID).map(([field]) => field))], params, options, group, query.dimension, unsupported, true);
    const out = snapshot(query, { type: 'ad', id: adId }, 'paid', 'meta-ads-impression-unified', ['COP', 'USD'].includes(spec.currency) ? spec.currency : null);
    out.attributionSetting = attribution; out.actionReportTime = 'impression';
    out.evidence.adSetId = adsetId;
    for (const row of result.rows) {
      paidRow(row, query, adId, spec.identities.adAccountId);
      if (row.account_currency !== spec.currency) throw new MetaApiError('account_mismatch');
    }
    const values = row => metricValues(PAID, unsupported, group, query.dimension, (key, field, unit, estimated) => {
      if (key === 'spendMinor') return out.currency ? money(row?.spend) : unavailable(field, unit, 'currency_not_supported');
      if (key === 'conversations') return spec.objective !== 'whatsapp' ? unavailable(`actions.${CONVERSATION}`, unit, 'not_whatsapp_objective', 'unsupported') : !attribution ? unavailable(`actions.${CONVERSATION}`, unit, 'attribution_not_reported') : action(row?.actions, CONVERSATION);
      if (key === 'interactions') return action(row?.actions, 'post_engagement');
      if (key.startsWith('videoP')) return action(row?.[field], 'video_view', field);
      return numeric(row?.[field], field, unit, estimated);
    });
    if (query.dimension === 'aggregate') out.values = result.rows.length <= 1 ? values(result.rows[0]) : Object.fromEntries(Object.entries(PAID).map(([key, [field, unit]]) => [key, unavailable(field, unit, 'ambiguous_aggregate')]));
    else out.rows = result.rows.map(row => ({ dimensions: query.dimension === 'daily' ? { date: row.date_start } : Object.fromEntries(DIMENSIONS[query.dimension].map(field => [{ publisher_platform: 'publisherPlatform', platform_position: 'placement' }[field] || field, row[field]])), periodStart: row.date_start, periodEnd: row.date_stop, values: values(row) }));
    const complete = result.complete && result.rows.length > 0 && Boolean(attribution) && (query.dimension !== 'aggregate' || result.rows.length === 1);
    out.coverage = { complete, rowCount: result.rows.length, reason: result.reason || (!result.rows.length ? 'not_reported' : !attribution ? 'attribution_not_reported' : query.dimension === 'aggregate' && result.rows.length !== 1 ? 'ambiguous_aggregate' : null) };
    return [out];
  }
  async function organic(delivery, spec, query, unsupported, options) {
    const refs = { ...delivery.preparedRefs, ...delivery.remoteRefs };
    const instagram = delivery.channel === 'instagram';
    const kind = spec.assetType ?? delivery.assetType;
    if (!['image', 'video'].includes(kind)) fail('Falta el tipo verificado de pieza para consultar insights.');
    const reel = kind === 'video';
    const remoteId = instagram ? ownedId(refs.mediaId || delivery.remoteId) : reel ? ownedId(refs.videoId || delivery.remoteId) : ownedId(refs.postId || delivery.remoteId, POST_ID);
    const entity = { type: instagram ? 'media' : reel ? 'video' : 'post', id: remoteId };
    const group = `${instagram ? 'instagram' : 'facebook'}:${kind}`;
    let object;
    if (instagram) {
      object = await client.get(remoteId, { fields: 'id,owner,media_type,media_product_type,timestamp' }, options);
      if (object.id !== remoteId || (typeof object.owner === 'string' ? object.owner : object.owner?.id) !== spec.identities.instagramId) throw new MetaApiError('account_mismatch');
      if (object.media_type !== (reel ? 'VIDEO' : 'IMAGE') || object.media_product_type !== (reel ? 'REELS' : 'FEED')) throw new MetaApiError('invalid_response');
    } else {
      object = await client.get(remoteId, { fields: 'id,from,created_time' }, options);
      if (object.id !== remoteId || object.from?.id !== spec.identities.pageId) throw new MetaApiError('account_mismatch');
    }
    const matrix = instagram ? reel ? IG_REEL : IG : reel ? FB_REEL : FB;
    const out = snapshot(query, entity, instagram ? 'organic' : 'mixed', `meta-${group.replace(':', '-')}-lifetime`);
    const publication = instagram ? object.timestamp : object.created_time;
    if (typeof publication === 'string' && Number.isFinite(Date.parse(publication))) out.evidence.publication = { at: new Date(publication).toISOString(), source: instagram ? 'media.timestamp' : 'created_time' };
    out.evidence.actualPeriod = 'lifetime';
    if (query.dimension !== 'aggregate' || query.periodType !== 'lifetime') {
      out.coverage = { complete: false, rowCount: 0, reason: 'organic_lifetime_aggregate_only' };
      if (query.dimension === 'aggregate') out.values = Object.fromEntries(Object.entries(matrix).map(([key, [field, unit]]) => [key, unavailable(field, unit, 'organic_lifetime_aggregate_only', 'unsupported')]));
      return [out];
    }
    const path = `${remoteId}/${!instagram && reel ? 'video_insights' : 'insights'}`;
    const fields = [...new Set(Object.values(matrix).map(([field]) => field)), ...(!instagram && reel ? ['post_video_retention_graph'] : [])];
    // post_media_view's optional breakdown is incompatible with the other post
    // metrics. Keep that request independent of reach/reactions/clicks.
    const result = await capabilities(path, fields.filter(field => instagram || reel || field !== 'post_media_view'), { period: 'lifetime' }, options, group, query.dimension, unsupported);
    const byName = new Map();
    for (const row of result.rows) {
      if (!fields.includes(row?.name) || byName.has(row.name)) throw new MetaApiError('invalid_response');
      byName.set(row.name, row);
    }
    out.values = metricValues(matrix, unsupported, group, query.dimension, (key, field, unit, estimated) => {
      const raw = scalar(byName.get(field));
      // The static v26 reference omits IG raw watch-time units. A returned
      // metric definition can establish them; absent/ambiguous definitions
      // remain unavailable. Never convert the raw value or guess from magnitude.
      if (instagram && ['averageWatchTime', 'totalWatchTime'].includes(key)) {
        const description = byName.get(field)?.description;
        const definition = typeof description === 'string' && description.length <= 4000 ? description : '';
        const millis = /\b(?:milliseconds|milisegundos)\b/i.test(definition);
        const seconds = /\b(?:seconds|segundos)\b/i.test(definition);
        if (millis === seconds) return unavailable(field, unit, 'unit_not_documented');
        const reportedUnit = millis ? 'milliseconds' : 'seconds';
        out.evidence.metricUnits = { ...out.evidence.metricUnits, [field]: { unit: reportedUnit, source: 'metric.description' } };
        return numeric(raw, field, reportedUnit);
      }
      if (key === 'reactions') return reactionCount(raw, field);
      if (!instagram && reel && ['comments', 'shares'].includes(key)) return numeric(raw?.[key === 'comments' ? 'comment' : 'share'], `${field}.${key === 'comments' ? 'comment' : 'share'}`);
      if (!instagram && key === 'linkClicks') return numeric(raw?.['link clicks'], `${field}.link clicks`);
      return numeric(raw, field, unit, estimated);
    });
    out.coverage = { complete: result.complete && result.rows.length > 0, rowCount: result.rows.length, reason: result.reason || (!result.rows.length ? 'not_reported' : null) };
    if (!instagram && reel) {
      const graph = scalar(byName.get('post_video_retention_graph'));
      if (graph && typeof graph === 'object' && !Array.isArray(graph)) {
        const entries = Object.entries(graph);
        if (entries.length <= 1000 && entries.every(([segment, value]) => /^\d+(?:\.\d+)?$/.test(segment) && segment.length <= 20 && numeric(value, 'post_video_retention_graph', 'percent').value !== null)) {
          for (const [segment, value] of entries) out.values[`videoRetentionAt${segment.replace('.', '_')}`] = numeric(value, `post_video_retention_graph.segment=${segment}`, 'percent');
        }
      }
    }
    if (instagram || reel) return [out];
    const views = await capabilities(path, ['post_media_view'], { period: 'lifetime', breakdown: 'is_from_ads' }, options, group, query.dimension, unsupported);
    if (views.rows.length > 1 || views.rows.some(row => row.name !== 'post_media_view')) throw new MetaApiError('invalid_response');
    const viewResult = views.rows[0];
    out.values.views = unsupported.has(cacheKey(group, query.dimension, 'post_media_view')) ? unavailable('post_media_view', 'count', 'metric_not_supported', 'unsupported') : numeric(scalar(viewResult), 'post_media_view');
    const counters = await client.get(remoteId, { fields: 'id,comments.limit(0).summary(true),shares' }, options);
    if (counters.id !== remoteId) throw new MetaApiError('account_mismatch');
    out.values.comments = numeric(counters.comments?.summary?.total_count, 'post.comments.summary.total_count');
    out.values.shares = numeric(counters.shares?.count, 'post.shares.count');
    out.coverage = { complete: out.coverage.complete && views.complete, rowCount: result.rows.length + views.rows.length, reason: result.reason || views.reason || out.coverage.reason };
    const organicOut = snapshot(query, entity, 'organic', 'meta-facebook-image-is-from-ads-lifetime');
    organicOut.evidence = { ...out.evidence };
    const breakdowns = viewResult?.total_value?.breakdowns;
    const breakdown = Array.isArray(breakdowns) ? breakdowns.find(item => Array.isArray(item.dimension_keys) && item.dimension_keys.length === 1 && item.dimension_keys[0] === 'is_from_ads') : null;
    const matches = Array.isArray(breakdown?.results) ? breakdown.results.filter(item => item.dimension_values?.length === 1 && (item.dimension_values[0] === false || item.dimension_values[0] === 'false')) : [];
    // The v26 reference lists is_from_ads but does not define a numeric 0/1
    // encoding. Never infer that encoding (or sum the two populations).
    organicOut.values.views = unsupported.has(cacheKey(group, query.dimension, 'post_media_view'))
      ? unavailable('post_media_view.is_from_ads=false', 'count', 'metric_not_supported', 'unsupported')
      : matches.length === 1 ? numeric(matches[0].value, 'post_media_view.is_from_ads=false') : unavailable('post_media_view.is_from_ads=false', 'count', 'organic_breakdown_not_verified');
    organicOut.coverage = { complete: views.complete && organicOut.values.views.value !== null, rowCount: matches.length, reason: views.reason || organicOut.values.views.reason };
    return [organicOut, out];
  }
  return {
    async fetchMeasurements({ delivery, spec, query, knownUnsupported = [], signal }) {
      if (!delivery || !spec || !['meta_ads', 'instagram', 'facebook'].includes(delivery.channel) || spec.integrationMethod && spec.integrationMethod !== 'api') fail('La entrega no tiene una vía API válida.');
      const isPaid = delivery.channel === 'meta_ads';
      if (spec.mode !== (isPaid ? 'paid' : 'organic')) fail('La modalidad de la entrega no coincide con su revisión.');
      validateQuery(query, isPaid);
      const unsupported = new Set(knownUnsupported.filter(value => typeof value === 'string' && /^v26\.0:(ads|instagram:(image|video)|facebook:(image|video)):(aggregate|daily|placement|age_gender|country):[a-z0-9_]+$/.test(value)));
      const options = await context(spec, delivery.channel, query, signal);
      const snapshots = isPaid ? await paid(delivery, spec, query, unsupported, options) : await organic(delivery, spec, query, unsupported, options);
      return { snapshots, unsupportedMetrics: [...unsupported].sort() };
    }
  };
}
