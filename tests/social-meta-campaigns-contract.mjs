import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { hash, insertRow } from '../lib/business/commands.mjs';
import { getSavedMetaCampaigns } from '../lib/business/social-meta-campaigns.mjs';
import { connectionFence } from '../lib/business/social-account-projection.mjs';
import { listSocialCampaigns } from '../lib/business/social.mjs';

const ACTOR = 'meta-inventory-admin';
const OLD = '2026-10-16T10:00:00.000Z', NEW = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T10:00:10.000Z';
const ACC = 'act_501', OTHER = 'act_502', EXTERNAL = '9007199254740993';
const coverage = (resourceId, state, missing = []) => ({ kind: 'ad_account', resourceId, state, missing });

async function fixture(run) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  const add = (table, row) => insertRow(store, table, row);
  try {
    await add('users', { id: ACTOR, email: `${ACTOR}@example.test`, password: 'fixture-unused', active: 1 });
    async function connection(name, identities = {}) {
      const id = randomUUID();
      const data = { name, identities, resources: { adAccounts: [{ id: ACC, name: 'Cuenta A' }, { id: OTHER, name: 'Cuenta B' }] } };
      await add('social_connections', { id, state: 'connected', provider: 'meta', integration_method: 'api', data: JSON.stringify(data), version: 1, created_at: OLD, updated_at: OLD });
      await add('social_credentials', { connection_id: id, ciphertext: 'unused', iv: 'unused', auth_tag: 'unused', version: 1, updated_at: OLD });
      return { id, ...data };
    }
    async function snapshot(source, at, rows, { state = 'completed', coverageState = 'accessible_complete', updatedAt = at, missing = [] } = {}) {
      const id = randomUUID(), active = ['queued', 'running', 'waiting'].includes(state);
      const accounts = [ACC, OTHER];
      const data = { fence: connectionFence(source), configurationVersion: 0, credentialVersion: 1,
        period: { since: '2025-10-16', until: at.slice(0, 10) },
        coverage: Object.fromEntries(accounts.map(account => [`ad_account:${account}`, coverage(account, active ? 'pending' : coverageState, missing)])),
        resources: Object.fromEntries(accounts.map((account, index) => [`ad_account:${account}`, { id: account, kind: 'ad_account', currency: index ? 'USD' : 'COP' }])) };
      await add('social_account_analyses', { id, connection_id: source.id, actor_id: ACTOR, state, data: JSON.stringify(data), version: 1, created_at: at, updated_at: updatedAt });
      for (const { kind, resourceId, ...payload } of rows) {
        await add('social_account_analysis_items', { id: hash([id, kind, resourceId]), analysis_id: id, resource_kind: kind, resource_id: resourceId,
          data: JSON.stringify({ observedAt: at, ...payload }), created_at: updatedAt, updated_at: updatedAt });
      }
      return id;
    }
    async function own({ source, accountId = ACC, remoteId = null, delivery = {}, channel = 'meta_ads', step, result }) {
      const id = randomUUID(), deliveryId = randomUUID();
      const revision = 2, spec = { identities: { adAccountId: accountId } };
      await add('social_campaigns', { id, connection_id: source?.id || null, name: 'Campaña propia', mode: 'paid', objective: 'reach', state: 'draft', data: '{}', version: 1, created_at: OLD, updated_at: OLD });
      for (const [n, data] of [[1, { spec: { identities: { adAccountId: OTHER } } }], [revision, { spec }]]) {
        await add('social_revisions', { campaign_id: id, revision: n, spec_hash: hash(data.spec), approved_at: OLD, actor_id: ACTOR, data: JSON.stringify(data) });
      }
      await add('social_deliveries', { id: deliveryId, campaign_id: id, revision, remote_id: remoteId, channel, state: 'ready', data: JSON.stringify(delivery), version: 1, created_at: OLD, updated_at: OLD });
      if (result) await add('social_operations', { id: randomUUID(), campaign_id: id, delivery_id: deliveryId, operation_key: deliveryId + step,
        step, state: 'confirmed', data: JSON.stringify({ result }), version: 1, created_at: OLD, updated_at: OLD });
      return id;
    }
    const get = (query = {}, actor = ACTOR) => getSavedMetaCampaigns(store, query, actor);
    await run({ store, get, connection, snapshot, own });
  } finally { await store.close(); }
}

const campaign = (resourceId, accountId = ACC, configuration = { status: 'PAUSED' }) => ({ kind: 'campaigns', accountId, resourceId, configuration });
const adset = (resourceId, campaignId, accountId = ACC) => ({ kind: 'adsets', accountId, resourceId, configuration: { campaignId, optimization_goal: 'REACH', status: 'PAUSED' } });
const confirmed = campaignId => ({ remoteRefs: { campaignId }, lastConfirmedAt: OLD, evidence: { remoteRead: true } });
const paid = (resourceId, accountId = ACC, currency = 'COP', spend = '1000.25') => ({ kind: 'ads_campaign', accountId, resourceId, currency,
  period: { type: 'range', since: '2025-10-16', until: '2026-10-16' }, values: { impressions: { value: EXTERNAL }, spend: { value: spend }, reach: { value: null } } });

test('saved Meta inventory counts 26 campaigns and 44 paged children without duplicating a canonically linked campaign', () => fixture(async ({ store, get, connection, snapshot, own }) => {
  const source = await connection('Primera cuenta', { adAccountId: OTHER }), duplicate = await connection('Segunda cuenta');
  const campaignIds = Array.from({ length: 26 }, (_, i) => String(701 + i));
  const configuration = campaignIds.map(id => campaign(id));
  const children = Array.from({ length: 44 }, (_, i) => adset(String(i + 801), campaignIds[Math.floor(i / 2)]));
  await snapshot(source, OLD, [...configuration, ...children, adset('999', '1001'), { ...paid(ACC), kind: 'ads_account' }]);
  await snapshot(duplicate, NEW, [campaign('725', '501')], { updatedAt: LATER });
  const local = await own({ source, accountId: '501', remoteId: '725', delivery: confirmed('725') });
  const pages = await Promise.all(['1', '2', '3', '4'].map(page => get({ page, pageSize: '10' })));
  assert.deepEqual(pages.map(value => [value.pagination.total, value.items.length]), [[26, 10], [26, 10], [26, 6], [26, 0]]);
  const items = pages.flatMap(value => value.items);
  assert.equal(new Set(items.map(item => item.resourceId)).size, 26);
  assert.ok(items.every(item => item.object && !item.metrics.length));
  assert.deepEqual(items.filter(item => item.localCampaignId).map(item => [item.resourceId, item.localCampaignId, item.connectionId, item.observedAt, item.snapshot.updatedAt]), [['725', local, duplicate.id, NEW, LATER]]);
  assert.deepEqual(pages[0].accounts, [{ id: ACC, name: 'Cuenta A' }]);
  const details = await Promise.all(items.map(item => get({ account: item.ownerId, metaCampaign: item.resourceId, pageSize: '1' })));
  assert.equal(details.reduce((sum, detail) => sum + detail.pagination.total, 0), 44);
  const secondChildPage = await get({ account: ACC, metaCampaign: '701', pageSize: '1', page: '2' });
  assert.equal(secondChildPage.adsets[0].resourceId, '802');
  assert.deepEqual(secondChildPage.pagination, { total: 2, page: 2, pageSize: 1 });
  const owned = (await listSocialCampaigns(store)).campaigns.find(campaign => campaign.id === local);
  assert.deepEqual(owned.metaCampaign, { accountId: ACC, resourceId: '725', observedAt: NEW, connectionId: duplicate.id, snapshotId: items[0].snapshot.id });
  assert.equal((await get({ connection: source.id })).pagination.total, 26);
}));

test('exact snapshot membership, partial coverage, decimal reports and historical state never combine readings or accounts', () => fixture(async ({ store, get, connection, snapshot, own }) => {
  const source = await connection('Principal'), other = await connection('Externa');
  const first = await snapshot(source, OLD, [campaign(EXTERNAL, ACC, { lifetime_budget: '100000', status: 'ACTIVE' }), paid(EXTERNAL), campaign('702'), adset('801', EXTERNAL), adset('wrong-account', EXTERNAL, OTHER)]);
  const later = await snapshot(source, NEW, [campaign(EXTERNAL), paid('703', ACC, 'COP', '0'), adset('802', EXTERNAL)], { state: 'partial', coverageState: 'partial', missing: [{ stage: 'ads_campaign', reason: 'permission' }], updatedAt: LATER });
  const otherSnapshot = await snapshot(other, OLD, [campaign(EXTERNAL, OTHER), paid(EXTERNAL, OTHER, 'USD', '7.00')]);
  const local = await own({ source, remoteId: EXTERNAL, delivery: confirmed(EXTERNAL) });
  const rows = (await get()).items;
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.resourceId === '702').historical, true);
  const zero = rows.find(row => row.resourceId === '703');
  assert.equal(zero.object, null);
  assert.equal(zero.metrics[0].values.spend.value, '0');
  const detail = await get({ account: ACC, metaCampaign: EXTERNAL, connection: source.id });
  assert.equal(detail.item.snapshot.id, later);
  assert.equal(detail.item.observedAt, NEW);
  assert.equal(detail.item.historical, false);
  assert.equal(detail.item.snapshot.stale, false);
  assert.equal(detail.item.analysisState, 'partial');
  assert.equal(detail.item.coverage.missing[0].stage, 'ads_campaign');
  assert.equal(detail.item.object.configuration.status, 'PAUSED');
  assert.deepEqual(detail.item.metrics, []);
  assert.equal(detail.item.observedBudgetMinor, null);
  assert.equal(detail.item.localCampaignId, local);
  assert.deepEqual(detail.adsets.map(row => row.resourceId), ['802']);
  assert.deepEqual(detail.snapshots.map(row => [row.snapshot.id, row.metrics.length]), [[later, 0], [first, 1]]);
  const older = await get({ account: ACC, metaCampaign: EXTERNAL, connection: source.id, snapshot: first });
  assert.equal(older.item.historical, true);
  assert.equal(older.item.accountCurrency, 'COP');
  assert.equal(older.item.observedBudgetMinor, 10_000_000);
  assert.equal(older.item.metrics[0].values.impressions.value, EXTERNAL);
  assert.equal(older.item.metrics[0].values.spend.value, '1000.25');
  assert.equal(older.item.metrics[0].values.reach.value, null);
  assert.deepEqual(older.adsets.map(row => row.resourceId), ['801']);
  const opposite = await get({ account: OTHER, metaCampaign: EXTERNAL });
  assert.equal(opposite.item.localCampaignId, null);
  assert.equal(opposite.item.metrics[0].currency, 'USD');
  await assert.rejects(get({ account: ACC, metaCampaign: EXTERNAL, connection: other.id, snapshot: first }), { status: 404 });
  await assert.rejects(get({ account: ACC, metaCampaign: EXTERNAL, connection: source.id, snapshot: otherSnapshot }), { status: 404 });
  await assert.rejects(get({ account: OTHER, metaCampaign: EXTERNAL, connection: source.id, snapshot: first }), { status: 404 });
  await assert.rejects(get({ account: ACC, metaCampaign: '702', connection: source.id, snapshot: later }), { status: 404 });
  await store.db.run(`UPDATE ${store.t('social_connections')} SET state='disconnected' WHERE id=?`, [source.id]);
  assert.equal((await get({ connection: source.id })).items[0].snapshot.stale, true);
  await store.db.run(`DELETE FROM ${store.t('social_account_analyses')} WHERE connection_id=?`, [source.id]);
  assert.deepEqual((await get({ connection: source.id })).items, []);
  assert.equal((await listSocialCampaigns(store)).campaigns.find(row => row.id === local).metaCampaign, null);
}));

test('ambiguous or unverified references fail closed; a verified preparation proves the identity only', () => fixture(async ({ store, get, connection, snapshot, own }) => {
  const source = await connection('Principal');
  await snapshot(source, NEW, ['701', '702', '703', '704', '705', '706'].map(id => campaign(id)));
  const first = await own({ remoteId: '701', delivery: confirmed('701') });
  const conflict = await own({ remoteId: '701', delivery: confirmed('701') });
  await own({ remoteId: '702', delivery: { remoteRefs: { adSetId: '702', remoteDraftRef: '702' }, preparedRefs: { remoteDraftRef: '702' } } });
  await own({ delivery: { remoteRefs: { campaignId: '703' } } });
  await own({ remoteId: '704', delivery: confirmed('704'), channel: 'facebook' });
  await own({ remoteId: '705', accountId: null, delivery: confirmed('705') });
  const prepared = await own({ delivery: { preparedRefs: { campaignId: '706' } }, step: 'verify_prepared', result: { status: 'confirmed', preparedRefs: { campaignId: '706' }, evidence: { remoteRead: true } } });
  const rows = (await get()).items;
  assert.deepEqual(rows.filter(row => row.localCampaignId).map(row => [row.resourceId, row.localCampaignId]), [['706', prepared]]);
  const locals = (await listSocialCampaigns(store)).campaigns;
  assert.equal(locals.find(row => row.id === first).metaCampaign, null);
  assert.equal(locals.find(row => row.id === conflict).metaCampaign, null);
  assert.equal(locals.find(row => row.id === prepared).lastMeasurementSummary, null);
  assert.equal(locals.find(row => row.id === prepared).metaCampaign.resourceId, '706');
}));

test('inventory filters are bounded and validated; queued and denied reads remain distinct from saved rows', () => fixture(async ({ get, connection, snapshot }) => {
  const source = await connection('Pendiente'), denied = await connection('Sin permiso');
  await snapshot(source, NEW, [], { state: 'queued' });
  await snapshot(denied, NEW, [], { state: 'partial', coverageState: 'denied', missing: [{ stage: 'ads_campaign', reason: 'permission' }] });
  for (const query of [{ pageSize: '51' }, { page: '0' }, { page: '1e2' }, { connection: 'invalid' }, { account: '501' }, { metaCampaign: '701' }, { account: ACC, metaCampaign: '701', snapshot: randomUUID() }, { record: randomUUID() }, new URLSearchParams('page=1&page=2')]) {
    await assert.rejects(get(query), { status: 400 });
  }
  await assert.rejects(get({}, 'not-an-active-admin'), { status: 403 });
  const waiting = await get({ connection: source.id });
  assert.equal(waiting.pagination.total, 0);
  assert.deepEqual(waiting.availability.map(row => row.state), ['queued']);
  const unavailable = await get({ connection: denied.id, account: ACC });
  assert.equal(unavailable.pagination.total, 0);
  assert.deepEqual(unavailable.availability[0].coverage, [coverage(ACC, 'denied', [{ stage: 'ads_campaign', reason: 'permission' }])]);
}));
