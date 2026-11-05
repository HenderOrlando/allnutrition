import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMetaPublishingProvider } from './social-meta-provider.mjs';

const NOW = Date.parse('2026-11-03T05:00:00Z');
const clone = value => structuredClone(value);

// HTTP fixture with its own object ownership and performance records. No real
// Graph connection, spec echo, customer data, or persistence of credentials.
export async function createMetaMetricsProvider() {
  const publishing = createMetaPublishingProvider({ now: NOW });
  const state = {
    pageSize: 100, invalidMetrics: new Set(), metricError: null, secondPageError: null, currency: 'COP',
    attribution: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
    numericAdsEncoding: false, wrongOwner: false, wrongAdId: false, wrongDate: false, duplicateAggregate: false,
    metricDescriptions: {},
    hidePages: false, hideAdAccounts: false, adTasks: ['ANALYZE'], pageTasks: ['ANALYZE'],
    pageBusinessId: '500', adBusinessId: '500',
    permissions: publishing.state.permissions, spend: '100000.00', actions: [
      { action_type: 'onsite_conversion.messaging_first_reply', value: '999' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '10.5' },
      { action_type: 'post_engagement', value: '125.5' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '88' }
    ]
  };
  const calls = [];
  const nodes = new Map([
    ['900', { id: '900', account_id: '400', adset_id: '901', campaign_id: '902' }],
    ['901', { id: '901', account_id: '400', campaign_id: '902' }],
    ['310', { id: '310', owner: { id: '300' }, media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-11-01T05:00:00Z' }],
    ['311', { id: '311', owner: { id: '300' }, media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-11-01T05:00:00Z' }],
    ['200_400', { id: '200_400', from: { id: '200' }, created_time: '2026-11-01T05:00:00Z', comments: { data: [], summary: { total_count: 4 } }, shares: { count: 3 } }],
    ['410', { id: '410', from: { id: '200' }, created_time: '2026-11-01T05:00:00Z' }]
  ]);
  const instagram = { views: 1200, reach: 900.5, likes: 10, comments: 0, saved: 2, shares: 3, total_interactions: 15, ig_reels_avg_watch_time: 4021, ig_reels_video_view_total_time: 150000, reels_skip_rate: 12.5 };
  const facebook = { post_total_media_view_unique: 1000, post_clicks_by_type: { 'link clicks': 0, 'photo view': 30 }, post_reactions_by_type_total: { like: 10, love: 3 } };
  const reels = { fb_reels_total_plays: 5000, post_impressions_unique: 2500.5, post_video_avg_time_watched: 1250.5, post_video_social_actions: { comment: 5, share: 2 }, post_video_likes_by_reaction_type: { like: 10, love: 2 }, post_video_retention_graph: { 0: 100, 1: 75.5, 2: 50 } };
  function error(response, code, status = 400, message = 'Synthetic request rejected') {
    response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '120' });
    response.end(JSON.stringify({ error: { code, message, error_user_msg: 'SYNTHETIC-PRIVATE-DETAIL-CANARY' } }));
  }
  function send(response, data) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'https://graph.facebook.com');
      const path = url.pathname.replace(/^\/v26\.0\//, '');
      const params = Object.fromEntries([...url.searchParams].filter(([key]) => !['access_token', 'appsecret_proof'].includes(key)));
      calls.push({ path, params, method: request.method });
      if (request.method !== 'GET') return error(response, 100);
      publishing.state.permissions = state.permissions;
      publishing.state.currency = state.currency;
      if (publishing.state.tokenRevoked) return error(response, 190);
      const nodeId = path.split('/')[0];
      const metricRequest = /\/(insights|video_insights)$/.test(path);
      if (metricRequest) {
        const auth = request.headers.authorization;
        if (['200_400', '410'].includes(nodeId) && auth !== `Bearer ${publishing.state.pageToken}`) return error(response, 190);
        if (state.metricError) return error(response, state.metricError.code, state.metricError.status || 400, state.metricError.message);
        if (url.searchParams.has('after') && state.secondPageError) return error(response, state.secondPageError.code, state.secondPageError.status || 503);
        const fields = (url.searchParams.get(nodeId === '900' ? 'fields' : 'metric') || '').split(',');
        if (fields.some(field => state.invalidMetrics.has(field))) return error(response, 100, 400, nodeId === '900' ? '(#100) field is not valid for fields param' : '(#100) metric must be a valid insights metric');
        let rows;
        if (nodeId === '900') {
          if (params.action_report_time !== 'impression' || params.use_unified_attribution_setting !== 'true') return error(response, 100);
          const range = JSON.parse(params.time_range || '{}');
          if (range.since !== '2026-11-01' || range.until !== '2026-11-02') return error(response, 100);
          const base = { ad_id: state.wrongAdId ? '999' : '900', account_id: '400', account_currency: state.currency, date_start: state.wrongDate ? '2026-10-01' : '2026-11-01', date_stop: '2026-11-02', spend: state.spend, impressions: '4000', reach: '1000', frequency: '4', inline_link_clicks: '100', actions: clone(state.actions), video_p25_watched_actions: [{ action_type: 'video_view', value: '50' }], video_p50_watched_actions: [{ action_type: 'video_view', value: '40' }], video_p75_watched_actions: [{ action_type: 'video_view', value: '30' }], video_p100_watched_actions: [{ action_type: 'video_view', value: '20' }] };
          rows = params.time_increment === '1' ? [
            { ...base, date_stop: '2026-11-01', spend: '50000.00', reach: '800' },
            { ...base, date_start: '2026-11-02', spend: '50000.00', reach: '800' }
          ] : params.breakdowns === '["publisher_platform","platform_position"]' ? [
            { ...base, publisher_platform: 'facebook', platform_position: 'feed', spend: '75000.00' },
            { ...base, publisher_platform: 'instagram', platform_position: 'reels', spend: '25000.00' }
          ] : params.breakdowns === '["age","gender"]' ? [{ ...base, age: '25-34', gender: 'female' }]
            : params.breakdowns === '["country"]' ? [{ ...base, country: 'CO' }] : state.duplicateAggregate ? [base, clone(base)] : [base];
          rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key) || ['publisher_platform', 'platform_position', 'age', 'gender', 'country'].includes(key))));
        } else if (nodeId === '200_400' && fields.includes('post_media_view')) {
          if (params.breakdown !== 'is_from_ads') return error(response, 100);
          rows = [{ name: 'post_media_view', period: 'lifetime', total_value: { value: 2000, breakdowns: [{ dimension_keys: ['is_from_ads'], results: [{ dimension_values: [state.numericAdsEncoding ? '0' : false], value: 1200 }, { dimension_values: [state.numericAdsEncoding ? '1' : true], value: 800 }] }] } }];
        } else {
          const source = ['310', '311'].includes(nodeId) ? instagram : nodeId === '200_400' ? facebook : nodeId === '410' && path.endsWith('/video_insights') ? reels : null;
          if (!source || params.period !== 'lifetime' || params.since || params.until) return error(response, 100);
          rows = fields.filter(field => Object.hasOwn(source, field)).map(name => ({ name, period: 'lifetime', values: [{ value: clone(source[name]) }], ...(state.metricDescriptions[name] ? { description: state.metricDescriptions[name] } : {}) }));
        }
        const offset = Number(params.after || 0), end = offset + state.pageSize;
        const next = new URL(url); next.searchParams.delete('appsecret_proof'); next.searchParams.set('after', String(end));
        return send(response, { data: rows.slice(offset, end), ...(end < rows.length ? { paging: { next: next.href } } : {}) });
      }
      if (nodes.has(path)) {
        const node = clone(nodes.get(path));
        if (state.wrongOwner) { if (node.owner) node.owner.id = '999'; if (node.from) node.from.id = '999'; if (node.account_id) node.account_id = '999'; }
        if (path === '901') node.attribution_spec = clone(state.attribution);
        return send(response, node);
      }
      if (path === 'me/accounts' && state.hidePages || path === 'me/adaccounts' && state.hideAdAccounts) return send(response, { data: [] });
      const result = await publishing.fetchImpl(url.href, { method: 'GET', headers: request.headers });
      const body = await result.json();
      if (path === 'me/accounts' && Array.isArray(body.data)) for (const page of body.data) {
        page.tasks = clone(state.pageTasks); page.business = { id: state.pageBusinessId, name: 'Synthetic page business' };
      }
      if (path === 'me/adaccounts' && Array.isArray(body.data)) for (const account of body.data) {
        account.user_tasks = clone(state.adTasks); account.business = { id: state.adBusinessId, name: 'Synthetic ad business' };
      }
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(JSON.stringify(body));
    } catch { error(response, 100); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state, calls, instagram, facebook, reels, nodes, now: NOW,
    async fetchImpl(href, options) {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com') throw new Error('Real network forbidden');
      return fetch(`${origin}${url.pathname}${url.search}`, options);
    },
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}
