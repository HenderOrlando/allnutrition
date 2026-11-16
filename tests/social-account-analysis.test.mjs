import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { encryptCredentials } from '../lib/social/credentials.mjs';
import { getSocialConnection } from '../lib/business/social.mjs';
import { createTokenSocialConnection } from '../lib/business/social-connections.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { metaHistoryPeriod, currentHistoryRules } from '../lib/social/meta-account-history.mjs';
import { queueMetaAccountAnalysisTx, processMetaAccountAnalysisTurn, getMetaAccountAnalysis, metaAccountAnalysisAction, buildMetaAccountProposals } from '../lib/business/social-account-analysis.mjs';

const NOW = '2026-11-16T12:00:00.000Z', ACTOR = 'social-fixture-admin';
const TOKEN = 'SYNTHETIC-HISTORY-TOKEN', PII = 'PERSON-AND-LEAD-CANARY';
const SCOPES = ['ads_read', 'pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights'];
async function fixture(fn, { method = 'token', noResources = false } = {}) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' }), env = {};
  try {
    const { runtime } = await configureSocialTestRuntime(store, { env });
    const id = randomUUID(), data = { name: 'Cuenta sintética', authenticationMethod: method, readOnly: method === 'token', identities: { userId: '101' }, resources: { pages: noResources ? [] : [{ id: '201', tasks: ['ANALYZE'], instagramId: '301' }], adAccounts: noResources ? [] : [{ id: 'act_501', currency: 'COP', timeZone: 'America/Bogota', tasks: ['ANALYZE'] }] }, sessionEpoch: 1, configurationFingerprint: runtime.fingerprint, revalidationRequired: false, capabilities: { insights: true } };
    await store.db.run(`INSERT INTO ${store.t('social_connections')}(id,provider,integration_method,state,data,version,created_at,updated_at) VALUES(?,'meta','api','connected',?,1,?,?)`, [id, JSON.stringify(data), NOW, NOW]);
    const connection = await getSocialConnection(store, id);
    const sealed = encryptCredentials(connection, { accessToken: TOKEN, userId: '101', pageTokens: { '201': 'SYNTHETIC-PAGE-TOKEN' } }, runtime);
    await store.db.run(`INSERT INTO ${store.t('social_credentials')}(connection_id,ciphertext,iv,auth_tag,version,updated_at) VALUES(?,?,?,?,1,?)`, [id, sealed.ciphertext, sealed.iv, sealed.auth_tag, NOW]);
    const remote = { calls: [], scopes: [...SCOPES], valid: true, rate: false, afterRead: null, campaignPages: true, organic: true, oldContent: false, denied: new Set(), declined: new Set() };
    const fetchImpl = async (input, init) => {
      const url = new URL(input), path = url.pathname.replace(/^\/v26\.0\//, '');
      remote.calls.push({ path, after: url.searchParams.get('after'), level: url.searchParams.get('level'), fields: url.searchParams.get('fields') });
      assert.equal(init.method, 'GET', 'history must never issue provider writes');
      const headers = { 'x-app-usage': JSON.stringify({ call_count: 12, total_cputime: 2, total_time: 3 }) };
      if (remote.denied.has(path)) return Response.json({ error: { code: 200, message: PII + TOKEN } }, { status: 403, headers });
      if (path === 'debug_token') return Response.json({ data: { app_id: runtime.appId, user_id: '101', type: 'USER', is_valid: remote.valid, expires_at: 2000000000, data_access_expires_at: 2000000000, scopes: remote.scopes } }, { headers });
      if (path === 'me') return Response.json({ id: '101', name: PII });
      if (path === 'me/permissions') return Response.json({ data: remote.scopes.map(permission => ({ permission, status: remote.declined.has(permission) ? 'declined' : 'granted' })) }, { headers });
      if (remote.rate) return Response.json({ error: { code: 4, message: PII + TOKEN } }, { status: 429, headers: { ...headers, 'retry-after': '120' } });
      if (path === 'me/accounts') return Response.json({ data: [{ id: '201', tasks: ['ANALYZE'], access_token: TOKEN, name: PII, instagram_business_account: { id: '301', username: PII } }, { id: '202', tasks: ['ANALYZE'], access_token: TOKEN }] }, { headers });
      if (path === 'me/adaccounts') return Response.json({ data: [{ id: 'act_501', currency: 'COP', timezone_name: 'America/Bogota', user_tasks: ['ANALYZE'], name: PII }, { id: 'act_502', currency: 'USD', timezone_name: 'America/New_York', user_tasks: ['ANALYZE'] }] }, { headers });
      if (path === '202') return Response.json({ id: '202', access_token: TOKEN });
      if (/^act_50[12]\/insights$/.test(path)) {
        const account = path.slice(4, 7), campaign = url.searchParams.get('level') === 'campaign', after = url.searchParams.get('after');
        const range = JSON.parse(url.searchParams.get('time_range'));
        assert.deepEqual(range, { since: '2025-11-16', until: '2026-11-16' });
        if (remote.afterRead) await remote.afterRead();
        const campaignId = account === '501' ? after ? '702' : '701' : after ? '712' : '711';
        return Response.json({ data: [{ account_id: account, account_currency: account === '501' ? 'COP' : 'USD', ...(campaign ? { campaign_id: campaignId } : {}), date_start: range.since, date_stop: range.until, impressions: '9007199254740993', clicks: '7', inline_link_clicks: '5', reach: '101', frequency: '1.234567890123456789', spend: '1000.25', actions: [{ action_type: 'post_engagement', value: '9' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }, { action_type: 'lead', value: PII }], person: PII, access_token: TOKEN }], ...(campaign && remote.campaignPages && !after ? { paging: { next: `https://graph.facebook.com/v26.0/${path}?access_token=${TOKEN}&after=SECOND`, cursors: { after: 'SECOND' } } } : {}) }, { headers });
      }
      if (/^act_50[12]\/campaigns$/.test(path)) return Response.json({ data: [{ id: path.startsWith('act_501') ? '701' : '711', name: PII, objective: 'OUTCOME_SALES', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '12345678901234567890', created_time: '2020-01-01T00:00:00Z', updated_time: NOW, access_token: TOKEN }] }, { headers });
      if (/^act_50[12]\/adsets$/.test(path)) return Response.json({ data: [{ id: path.startsWith('act_501') ? '801' : '811', campaign_id: path.startsWith('act_501') ? '701' : '711', status: 'ACTIVE', optimization_goal: 'OFFSITE_CONVERSIONS', targeting: { age_min: 18, age_max: 65, geo_locations: { countries: ['CO'], cities: [{ key: PII }] }, custom_audiences: [{ id: PII }], interests: [{ id: PII, name: PII }] }, promoted_object: { pixel_id: '901', custom_event_type: 'PURCHASE', phone_number: PII }, attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }], access_token: TOKEN }] }, { headers });
      if (path === '201/published_posts') return Response.json({ data: remote.organic ? [{ id: '201_401', created_time: remote.oldContent ? '2024-10-01T10:00:00Z' : '2026-10-01T10:00:00Z', status_type: 'added_photos', is_published: true, message: PII, from: { id: PII }, comments: { data: [{ id: PII }] } }] : [] }, { headers });
      if (path === '202/published_posts') return Response.json({ data: [] }, { headers });
      if (path === '301/media') return Response.json({ data: remote.organic ? [{ id: '601', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: remote.oldContent ? '2024-10-02T10:00:00Z' : '2026-10-02T10:00:00Z', caption: PII, owner: { id: PII } }] : [] }, { headers });
      if (path === '601') return Response.json({ id: '601', owner: '301', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: remote.oldContent ? '2024-10-02T10:00:00Z' : '2026-10-02T10:00:00Z' });
      if (path === '201_401') return Response.json(url.searchParams.get('fields').includes('comments') ? { id: '201_401', comments: { summary: { total_count: 3 }, data: [{ id: PII }] }, shares: { count: 2 } } : { id: '201_401', from: { id: '201', name: PII }, created_time: remote.oldContent ? '2024-10-01T10:00:00Z' : '2026-10-01T10:00:00Z' });
      if (path === '601/insights' || path === '201_401/insights') return Response.json({ data: (url.searchParams.get('metric') || '').split(',').map(name => ({ name, period: 'lifetime', values: [{ value: name === 'post_clicks_by_type' ? { 'link clicks': 2 } : name === 'post_reactions_by_type_total' ? { like: 3 } : 11 }], ...(name === 'post_media_view' ? { total_value: { value: 11, breakdowns: [{ dimension_keys: ['is_from_ads'], results: [{ dimension_values: [false], value: 8 }] }] } } : {}) })) }, { headers });
      throw new Error('Unexpected synthetic history path: ' + path);
    };
    const options = { now: NOW, env, transport: { fetchImpl } };
    const queue = (extra = {}) => store.transaction(async tx => { await tx.lockWrites(); return queueMetaAccountAnalysisTx(tx, await getSocialConnection(tx, id), ACTOR, { now: NOW, ...extra }); });
    const turn = (extra = {}) => processMetaAccountAnalysisTurn(store, { ...options, ...extra });
    const get = query => getMetaAccountAnalysis(store, id, query, ACTOR);
    const drain = async () => { for (let n = 0; n < 100; n++) { const result = await turn(); if (!result.hasMore) return get(); } assert.fail('fixture did not drain in bounded turns'); };
    await fn({ store, env, runtime, connection, id, remote, fetchImpl, options, queue, turn, get, drain });
  } finally { await store.close(); }
}

test('calendar year uses calendar months and clamps leap days, never 365-day subtraction', () => {
  assert.equal(metaHistoryPeriod('2024-02-29T12:00:00Z').since, '2023-02-28');
  assert.equal(metaHistoryPeriod('2025-03-01T12:00:00Z').since, '2024-03-01');
  assert.equal(metaHistoryPeriod('2024-03-01T12:00:00Z').since, '2023-03-01');
  assert.equal(metaHistoryPeriod(NOW).precision, 'calendar_day_current_day_partial');
  assert.throws(() => metaHistoryPeriod('invalid'));
});

test('automatic queue contract is transaction-local, uses real actor and coalesces semantic fences', () => fixture(async ({ store, queue, get, remote, id }) => {
  const first = await queue(), second = await queue();
  assert.equal(first.id, second.id); assert.equal(remote.calls.length, 0);
  const report = await get();
  assert.equal(report.analysis.state, 'queued'); assert.equal(report.analysis.progress.total, null);
  assert.equal(report.analysis.progress.resources, 3);
  const row = await store.db.get(`SELECT actor_id FROM ${store.t('social_account_analyses')} WHERE id=?`, [first.id]);
  assert.equal(row.actor_id, ACTOR);
  const connectionRow = await store.db.get(`SELECT data FROM ${store.t('social_connections')} WHERE id=?`, [id]);
  const data = JSON.parse(connectionRow.data); data.measurementConfig = { objective: 'traffic' };
  await store.db.run(`UPDATE ${store.t('social_connections')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify(data), id]);
  assert.equal((await queue()).id, first.id, 'measurement-only update cannot repeat historical provider reads');
  await assert.rejects(store.transaction(tx => queueMetaAccountAnalysisTx(tx, { id, provider: 'meta', integrationMethod: 'api', state: 'connected' }, 'not-a-real-user', { now: NOW })), /autorizado/);
}));

test('token connection hook queues analysis automatically without reading history inside connect', () => fixture(async ({ store, env, fetchImpl, remote }) => {
  const before = remote.calls.length;
  const connection = await createTokenSocialConnection(store, { integrationMethod: 'api', authenticationMethod: 'token', name: 'Auto historial', accessToken: TOKEN, requestId: randomUUID() }, ACTOR, { env, fetchImpl, now: NOW });
  const row = await store.db.get(`SELECT * FROM ${store.t('social_account_analyses')} WHERE connection_id=?`, [connection.id]);
  assert.ok(row); assert.equal(row.actor_id, ACTOR);
  assert.equal(remote.calls.slice(before).some(call => /\/insights$|\/campaigns$|\/published_posts$/.test(call.path)), false);
}));

test('all discovered resources, not selection, persist cursors and paginated evidence without PII', () => fixture(async ({ store, queue, turn, get, drain, remote, id }) => {
  await queue(); await turn();
  const pending = await get(); assert.equal(pending.analysis.progress.total, null);
  const report = await drain();
  assert.equal(report.analysis.state, 'completed');
  assert.equal(report.analysis.progress.resources, 5);
  assert.equal(report.analysis.progress.completed, report.analysis.progress.total);
  assert.ok(report.pagination.total > 10);
  assert.ok(remote.calls.some(call => call.path === 'act_502/insights'));
  assert.ok(remote.calls.some(call => call.path === '202/published_posts'));
  assert.ok(remote.calls.some(call => call.path === '301/media'));
  assert.ok(remote.calls.some(call => call.level === 'campaign' && call.after === 'SECOND'));
  const pages = await Promise.all([get({ page: 1, pageSize: 2 }), get({ page: 2, pageSize: 2 })]);
  assert.equal(pages[0].items.length, 2); assert.equal(pages[1].items.length, 2);
  assert.notEqual(pages[0].items[0].id, pages[1].items[0].id);
  const saved = await store.db.all(`SELECT * FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=?`, [report.analysis.id]);
  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes(TOKEN)); assert.ok(!serialized.includes(PII));
  const state = await store.db.get(`SELECT data FROM ${store.t('social_account_analyses')} WHERE id=?`, [report.analysis.id]);
  assert.ok(!state.data.includes('access_token')); assert.ok(!state.data.includes(TOKEN));
  const paid = saved.map(row => ({ ...JSON.parse(row.data), kind: row.resource_kind })).find(row => row.kind === 'ads_account');
  assert.equal(paid.values.impressions.value, '9007199254740993');
  assert.equal(paid.values.frequency.value, '1.234567890123456789');
  assert.equal(paid.values.spend.value, '1000.25');
  assert.equal(paid.period.type, 'range');
  assert.ok(saved.some(row => row.resource_kind === 'organic_metrics' && JSON.parse(row.data).period.type === 'lifetime'));
  assert.equal(report.analysis.rules.historical.status, 'unverifiable');
  assert.ok(report.proposals.every(proposal => proposal.evidence.every(evidence => saved.some(item => item.id === evidence.itemId))));
  const jobs = await store.db.all(`SELECT state FROM ${store.t('job_runs')} WHERE key=?`, ['social:account-analysis:' + report.analysis.id]);
  assert.equal(jobs[0].state, 'succeeded');
  const calls = remote.calls.length;
  const connectionRow = await store.db.get(`SELECT data FROM ${store.t('social_connections')} WHERE id=?`, [id]);
  const data = JSON.parse(connectionRow.data); data.measurementConfig = { objective: 'sales', source: 'none' };
  await store.db.run(`UPDATE ${store.t('social_connections')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify(data), id]);
  const sales = await get(); assert.equal(sales.objective, 'sales'); assert.equal(sales.proposals[0].type, 'measurement'); assert.equal(remote.calls.length, calls);
}));

test('OAuth and manual token perform the same read-only history operations', async () => {
  const paths = [];
  for (const method of ['oauth', 'token']) await fixture(async ({ queue, drain, remote }) => { await queue(); const report = await drain(); assert.equal(report.analysis.state, 'completed'); paths.push(remote.calls.map(call => `${call.path}:${call.level}:${call.after}`)); }, { method });
  assert.deepEqual(paths[0], paths[1]);
});

test('pagination survives expired worker lease and does not duplicate items on restart', () => fixture(async ({ store, queue, turn, get, drain }) => {
  const queued = await queue();
  await turn();
  const lease = await claimJob(store, { key: 'social:account-analysis:' + queued.id, now: NOW });
  assert.ok(lease);
  const next = new Date(Date.parse(NOW) + 121000).toISOString();
  await turn({ now: next });
  const report = await drain();
  assert.ok(['completed', 'queued'].includes(report.analysis.state));
  const rows = await store.db.all(`SELECT resource_kind,resource_id FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=?`, [queued.id]);
  assert.equal(new Set(rows.map(row => `${row.resource_kind}:${row.resource_id}`)).size, rows.length);
  assert.ok((await get()).analysis.progress.completed > 0);
}));

test('429 persists Retry-After, usage, cursor and blocks early retries without leaking messages', () => fixture(async ({ store, queue, turn, get, remote }) => {
  await queue(); remote.rate = true;
  const first = await turn(), report = await get();
  assert.equal(first.hasMore, false); assert.equal(report.analysis.state, 'waiting');
  assert.equal(report.analysis.error.code, 'rate_limit');
  assert.ok(Date.parse(report.analysis.retryAt) >= Date.parse(NOW) + 120000);
  assert.equal(report.analysis.limits.usage[0].callCount, 12);
  const calls = remote.calls.length;
  assert.deepEqual(await turn(), { processed: 0, hasMore: false }); assert.equal(remote.calls.length, calls);
  const saved = await store.db.get(`SELECT data FROM ${store.t('social_account_analyses')} WHERE id=?`, [report.analysis.id]);
  assert.ok(!saved.data.includes(TOKEN)); assert.ok(!saved.data.includes(PII));
  remote.rate = false;
  await turn({ now: new Date(Date.parse(report.analysis.retryAt) + 1000).toISOString() });
  assert.notEqual((await get()).analysis.state, 'waiting');
}));

test('missing scopes and permission denial retain explicit Facebook and Instagram coverage', () => fixture(async ({ queue, drain, remote }) => {
  remote.scopes = ['ads_read']; remote.organic = false;
  await queue(); const report = await drain();
  assert.equal(report.analysis.state, 'partial');
  assert.ok(report.analysis.coverage.some(item => item.kind === 'facebook' && item.state === 'denied'));
  assert.ok(report.analysis.coverage.some(item => item.kind === 'instagram' && item.state === 'denied'));
  assert.equal(remote.calls.some(call => call.path === '301/media'), false);
  assert.ok(report.analysis.coverage.some(item => item.missing.some(missing => missing.reason === 'permission')));
}));

test('revoked credential stops reads and marks the connection reconnect_required', () => fixture(async ({ store, queue, turn, get, remote, id }) => {
  await queue(); remote.valid = false;
  await turn(); const report = await get();
  assert.equal(report.analysis.state, 'failed'); assert.equal(report.analysis.error.code, 'reconnect_required');
  assert.equal((await getSocialConnection(store, id)).state, 'reconnect_required');
  assert.equal(remote.calls.some(call => call.path === 'me/accounts'), false);
  assert.ok(!JSON.stringify(report).includes(TOKEN));
}));

test('cancel and refresh revoke old leases; response after credential/epoch changes is fenced', () => fixture(async ({ store, queue, turn, get, remote, id }) => {
  const first = await queue();
  await metaAccountAnalysisAction(store, id, { action: 'cancel' }, ACTOR, { now: NOW });
  assert.equal((await get()).analysis.state, 'cancelled');
  assert.equal((await turn()).processed, 0);
  await metaAccountAnalysisAction(store, id, { action: 'refresh' }, ACTOR, { now: NOW });
  assert.notEqual((await get()).analysis.id, first.id);
  for (let n = 0; n < 30 && !remote.calls.some(call => call.path.endsWith('/insights')); n++) {
    remote.afterRead = async () => {
      await store.db.run(`UPDATE ${store.t('social_credentials')} SET version=version+1 WHERE connection_id=?`, [id]);
    };
    await turn();
  }
  const report = await get();
  assert.equal(report.analysis.state, 'cancelled');
  assert.equal(report.analysis.error.code, 'authorization_or_configuration_changed');
  const paid = await store.db.all(`SELECT id FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=? AND resource_kind IN ('ads_account','ads_campaign')`, [report.analysis.id]);
  assert.equal(paid.length, 0, 'obsolete response must not be persisted');
}));

test('proposals use objective-specific evidence and never infer verified sales from current pixel or attribution', () => {
  const item = { id: 'evidence-1', resourceId: '701', accountId: 'act_501', period: { type: 'range', since: '2025-11-16', until: '2026-11-16' }, dimensions: { level: 'campaign' }, scope: 'paid', currency: 'COP', values: Object.fromEntries(['reach', 'post_engagement', 'inline_link_clicks', 'onsite_conversion.messaging_conversation_started_7d', 'offsite_conversion.fb_pixel_purchase'].map(name => [name, { value: '2', unit: 'count', status: 'reported' }])) };
  for (const objective of ['reach', 'engagement', 'traffic', 'whatsapp']) {
    const proposals = buildMetaAccountProposals({ measurementConfig: { objective } }, [item]);
    assert.equal(proposals[0].objective, objective); assert.equal(proposals[0].type, 'reviewable_experiment');
    assert.equal(proposals[0].evidence[0].itemId, item.id);
  }
  for (const config of [{ objective: 'sales', source: 'none' }, { objective: 'sales', source: 'external', verification: { status: 'verified' }, events: [{ name: 'Purchase', objective: 'sales' }] }, { objective: 'sales', source: 'meta_pixel', pixelId: '901', verification: { status: 'verified' }, events: [{ name: 'Purchase', objective: 'sales' }] }]) {
    const proposals = buildMetaAccountProposals({ measurementConfig: config }, [item]);
    assert.equal(proposals[0].type, 'measurement');
    assert.ok(proposals[0].limitations.some(notice => notice.includes('causalidad')));
  }
  const verified = {
    state: 'connected', sessionEpoch: 1, configurationFingerprint: 'fixture-config', identities: { adAccountId: 'act_501' },
    measurementConfig: { objective: 'sales', source: 'meta_pixel', pixelId: '901', events: [{ name: 'Purchase', objective: 'sales' }], verification: { status: 'verified', accountId: 'act_501', sourceId: '901', sessionEpoch: 1, configurationFingerprint: 'fixture-config' } }
  };
  assert.match(buildMetaAccountProposals(verified, [item])[0].change, /histórico agregado/);
  for (const changed of [{ identities: { adAccountId: 'act_502' } }, { sessionEpoch: 2 }, { configurationFingerprint: 'changed' }, { state: 'disconnected' }, { revalidationRequired: true }]) {
    const proposal = buildMetaAccountProposals({ ...verified, ...changed }, [item])[0];
    assert.equal(proposal.objective, 'sales');
    assert.equal(proposal.type, 'measurement');
    assert.match(proposal.change, /Configura y verifica/);
  }
  assert.equal(buildMetaAccountProposals({}, [])[0].type, 'measurement');
  assert.equal(currentHistoryRules(NOW).historical.status, 'unverifiable');
});

test('current content and campaigns older than the year remain visible with explicit lifetime precision', () => fixture(async ({ queue, drain, get, remote }) => {
  remote.oldContent = true;
  await queue(); await drain();
  const report = await get({ pageSize: 50 });
  const current = report.items.filter(item => ['facebook_post', 'instagram_media'].includes(item.resourceKind));
  assert.equal(current.length, 2);
  assert.ok(current.every(item => item.period.publishedWithinRequestedYear === false));
  assert.ok(report.items.some(item => item.resourceKind === 'campaigns' && item.configuration.created_time === '2020-01-01T00:00:00.000Z'));
  assert.ok(report.items.filter(item => item.resourceKind === 'organic_metrics').every(item => item.period.type === 'lifetime' && item.period.publishedAt.startsWith('2024-')));
}));

test('live declined permissions and provider-denied pages are explicit, not empty successful metrics', () => fixture(async ({ queue, drain, remote }) => {
  remote.declined.add('ads_read'); remote.denied.add('201/published_posts');
  await queue(); const report = await drain();
  assert.equal(report.analysis.state, 'partial');
  assert.equal(remote.calls.some(call => /^act_.*\/insights$/.test(call.path)), false);
  assert.ok(report.analysis.coverage.some(item => item.resourceId === '201' && item.state === 'denied'));
  assert.ok(report.analysis.coverage.some(item => item.resourceId === '301' && item.state === 'accessible_complete'));
  assert.ok(report.analysis.coverage.some(item => item.kind === 'ad_account' && item.missing.some(entry => entry.reason === 'permission')));
}));

async function insertEvidenceFixture(store, analysisId, { id, kind = 'ads_campaign', resourceId, ...data }) {
  await store.db.run(`INSERT INTO ${store.t('social_account_analysis_items')}(id,analysis_id,resource_kind,resource_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, [id, analysisId, kind, resourceId, JSON.stringify(data), NOW, NOW]);
}
const yearlyEvidence = (index, value, accountId = 'act_501') => ({
  id: `metric-${String(index).padStart(4, '0')}`, resourceId: String(1000 + index), accountId,
  observedAt: NOW, period: { type: 'range', since: '2025-11-16', until: '2026-11-16' },
  dimensions: { level: 'campaign', breakdowns: [] }, scope: 'paid', currency: 'COP',
  values: { reach: { value, sourceMetric: 'reach', unit: 'count', status: value === null ? 'unavailable' : 'estimated' } }
});

test('all evidence beyond 200 rows is examined in bounded pages and late useful data cites current rules and configuration', () => fixture(async ({ store, queue, get, remote }) => {
  const queued = await queue();
  for (let index = 0; index < 230; index++) await insertEvidenceFixture(store, queued.id, yearlyEvidence(index, index === 229 ? '17' : null));
  await insertEvidenceFixture(store, queued.id, { id: 'configuration-campaign', kind: 'campaigns', resourceId: '1229', accountId: 'act_501', observedAt: NOW, source: 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/', period: { type: 'current_snapshot', at: NOW }, configuration: { objective: 'OUTCOME_AWARENESS', status: 'ACTIVE', daily_budget: '12345678901234567890' } });
  await insertEvidenceFixture(store, queued.id, { id: 'configuration-adset', kind: 'adsets', resourceId: '2229', accountId: 'act_501', observedAt: NOW, source: 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/', period: { type: 'current_snapshot', at: NOW }, configuration: { campaignId: '1229', status: 'PAUSED', optimization_goal: 'REACH', targeting: { age_min: 18 }, daily_budget: '98765432109876543210' } });
  await store.db.run(`UPDATE ${store.t('social_account_analyses')} SET state='completed',version=version+1 WHERE id=?`, [queued.id]);
  const originalAll = store.db.all.bind(store.db), pageLengths = [];
  store.db.all = async (sql, params) => {
    const rows = await originalAll(sql, params);
    if (sql.includes('AND id>? ORDER BY id')) { assert.match(sql, /LIMIT 100$/); pageLengths.push(rows.length); }
    return rows;
  };
  let report;
  try { report = await get(); } finally { store.db.all = originalAll; }
  assert.equal(remote.calls.length, 0, 'reevaluation must never repeat provider reads');
  assert.equal(report.evidenceCoverage.examined, 230);
  assert.equal(report.evidenceCoverage.total, 230);
  assert.equal(report.evidenceCoverage.qualifying, 1);
  assert.equal(report.evidenceCoverage.complete, true);
  assert.equal(report.evidenceCoverage.configurations.examined, 2);
  assert.ok(pageLengths.filter(length => length === 100).length >= 2);
  assert.equal(report.proposals[0].evidence[0].itemId, 'metric-0229');
  assert.ok(!report.items.some(item => item.id === 'metric-0229'), 'proposal source may be outside the UI page');
  const proposal = report.proposals[0];
  assert.equal(proposal.configurationCoverage.matched, 2);
  assert.deepEqual(proposal.configurationEvidence.map(item => item.itemId).sort(), ['configuration-adset', 'configuration-campaign']);
  assert.ok(proposal.configurationEvidence.every(item => item.observedAt === NOW));
  assert.equal(proposal.configurationEvidence.find(item => item.resourceKind === 'adsets').configuration.daily_budget, '98765432109876543210');
  assert.equal(proposal.historicalConfiguration.status, 'unverifiable');
  assert.ok(proposal.applicableRules.every(rule => rule.source && rule.observedAt && rule.sourceReviewedAt));
  assert.ok(!Object.hasOwn(report, 'evidenceSample'));
}));

test('a comparable after multiple evidence pages is retained even after three canonical proposals are selected', () => fixture(async ({ store, queue, get }) => {
  const queued = await queue();
  for (let index = 0; index < 240; index++) {
    const qualifying = index < 3 || index === 239;
    const accountId = index === 1 ? 'act_502' : index === 2 ? 'act_503' : 'act_501';
    await insertEvidenceFixture(store, queued.id, yearlyEvidence(index, qualifying ? '12' : null, accountId));
  }
  await store.db.run(`UPDATE ${store.t('social_account_analyses')} SET state='completed',version=version+1 WHERE id=?`, [queued.id]);
  const report = await get();
  assert.equal(report.evidenceCoverage.examined, 240);
  assert.equal(report.evidenceCoverage.total, 240);
  assert.equal(report.evidenceCoverage.qualifying, 4);
  assert.equal(report.proposals.length, 3);
  const first = report.proposals.find(proposal => proposal.evidence[0].itemId === 'metric-0000');
  assert.deepEqual(first.comparables, ['metric-0239']);
  assert.equal(first.evidence[1].itemId, 'metric-0239');
  assert.ok(!first.limitations.some(notice => notice.includes('No existe comparable')));
}));
