import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash, insertRow } from '../lib/business/commands.mjs';
import { normalizeHekaSnapshot } from '../lib/shipping/heka.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';
import {
  listShippingConnections, createShippingConnection, createShippingPairing, pairShippingBridge,
  reportShippingIdentity, confirmShippingIdentity, revokeShippingConnection, requestShippingQuery,
  getShippingQuery, claimShippingQuery, heartbeatShippingQuery, completeShippingQuery,
  failShippingQuery, getShippingSnapshot, expireShippingSnapshots,
} from '../lib/business/shipping-bridge.mjs';

const NOW = '2026-11-09T12:00:00.000Z';
const id = () => randomUUID();
const at = ms => ({ now: new Date(Date.parse(NOW) + ms).toISOString() });
const rejected = (promise, statuses = [400, 401, 403, 404, 409, 410]) => assert.rejects(promise, error => statuses.includes(error.status));
async function businessFingerprint(store) {
  const rows = {};
  for (const table of ['orders', 'shipments', 'shipment_events', 'order_collections', 'settlements', 'settlement_receipts', 'cash_entries', 'expenses', 'expense_payments', 'import_batches', 'counters']) rows[table] = (await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`)).map(row => ({ ...row }));
  return hash(rows);
}
async function fixture(store, { identity = hekaSnapshot().account, ready = true } = {}) {
  const actorId = id(), platformId = id(), sourceId = id(), deviceId = id();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  await insertRow(store, 'platforms', { id: platformId, name: 'Proveedor de ensayo', name_key: platformId, active: 1, version: 1, created_at: NOW, updated_at: NOW });
  await insertRow(store, 'platform_sources', { id: sourceId, platform_id: platformId, name: 'Fuente de ensayo', active: 1, version: 1, created_at: NOW, updated_at: NOW });
  const f = { store, actorId, platformId, sourceId, deviceId, identity, connection: await createShippingConnection(store, { requestId: id(), sourceId }, actorId, at(0)) };
  f.refresh = async () => { f.connection = (await listShippingConnections(store, at(0))).connections.find(row => row.id === f.connection.id); return f.connection; };
  f.pairing = async (extra = {}, options = at(0)) => createShippingPairing(store, f.connection.id, { requestId: id(), version: f.connection.version, ...extra }, actorId, options);
  f.pair = async (device = f.deviceId, options = at(0)) => {
    const pairing = await f.pairing({}, options);
    const paired = await pairShippingBridge(store, { code: pairing.code, deviceId: device }, options);
    f.deviceId = device; f.auth = { bearer: paired.bearer }; await f.refresh(); return paired;
  };
  f.report = async (value = identity, options = at(0)) => {
    f.connection = await reportShippingIdentity(store, { deviceId: f.deviceId, identity: value }, f.auth, options); return f.connection;
  };
  f.confirm = async (extra = {}) => {
    f.connection = await confirmShippingIdentity(store, f.connection.id, { requestId: id(), version: f.connection.version, fingerprint: f.connection.identityFingerprint, sourceId, ...extra }, actorId, at(0)); return f.connection;
  };
  f.request = (extra = {}, options = at(0)) => requestShippingQuery(store, f.connection.id, { requestId: id(), version: f.connection.version, from: '2026-11-08', to: '2026-11-08', tracking: '', ...extra }, actorId, options);
  f.claim = (options = at(0)) => claimShippingQuery(store, { deviceId: f.deviceId }, f.auth, options);
  f.job = async () => { await f.request(); return (await f.claim()).job; };
  f.raw = (job, extra = {}) => hekaSnapshot({ query: job.query, account: identity, capturedAt: at(1000).now, ...extra });
  f.complete = (job, raw = f.raw(job), options = at(2000)) => completeShippingQuery(store, job.queryId, { deviceId: f.deviceId, lease: job.lease, snapshot: raw }, f.auth, options);
  f.heartbeat = (job = null, options = at(30000)) => heartbeatShippingQuery(store, { deviceId: f.deviceId, ...(job ? { queryId: job.queryId, lease: job.lease } : {}) }, f.auth, options);
  f.revoke = async () => { f.connection = await revokeShippingConnection(store, f.connection.id, { requestId: id(), version: f.connection.version }, actorId, at(10000)); return f.connection; };
  if (ready) { await f.pair(); await f.report(); await f.confirm(); }
  return f;
}

const cases = [
  ['pairing is one-use, five-minute, hashed custody and one-time secret response', async store => {
    const f = await fixture(store, { ready: false }), requestId = id();
    const pairing = await f.pairing({ requestId });
    assert.match(pairing.code, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(pairing.expiresAt) >= Date.parse(at(300000).now));
    assert.ok(Date.parse(pairing.expiresAt) < Date.parse(at(301000).now));
    const rows = await store.db.all(`SELECT * FROM ${store.t('shipping_pairings')}`);
    assert.equal(rows[0].hash, hash(pairing.code)); assert.equal(JSON.stringify(rows).includes(pairing.code), false);
    await rejected(() => f.pairing({ requestId }), [409]);
    const paired = await pairShippingBridge(store, { code: pairing.code, deviceId: f.deviceId }, at(1000));
    assert.match(paired.bearer, /^[A-Za-z0-9_-]{43}$/);
    await rejected(() => pairShippingBridge(store, { code: pairing.code, deviceId: id() }, at(1001)), [401]);
    const credentials = await store.db.all(`SELECT * FROM ${store.t('shipping_bridge_credentials')}`);
    assert.equal(credentials[0].bearer_hash, hash(paired.bearer));
    const requests = JSON.stringify(await store.db.all(`SELECT * FROM ${store.t('business_requests')}`));
    const audit = JSON.stringify(await store.db.all(`SELECT * FROM ${store.t('business_audit')}`));
    for (const value of [pairing.code, paired.bearer]) { assert.equal(requests.includes(value), false); assert.equal(audit.includes(value), false); }
    await f.refresh(); const expired = await f.pairing();
    await rejected(() => pairShippingBridge(store, { code: expired.code, deviceId: id() }, at(301000)), [401]);
  }],
  ['identity requires explicit fingerprint and source confirmation; idle device remains connected', async store => {
    const f = await fixture(store, { ready: false }); await f.pair();
    assert.deepEqual(await f.claim(), { job: null });
    assert.equal((await f.heartbeat()).state, 'awaiting_identity');
    await f.report(); await rejected(() => f.request(), [409]);
    await rejected(() => f.confirm({ sourceId: id() }), [409]);
    await rejected(() => f.confirm({ fingerprint: hash('not-current') }), [409]);
    await f.confirm(); assert.equal(f.connection.state, 'connected');
    assert.equal((await listShippingConnections(store, at(61000))).connections[0].deviceStatus, 'disconnected');
    await f.heartbeat(null, at(61000));
    assert.equal((await listShippingConnections(store, at(62000))).connections[0].deviceStatus, 'connected');
  }],
  ['one source binding and one confirmed Heka identity cannot be reassigned', async store => {
    const f = await fixture(store);
    await rejected(() => createShippingConnection(store, { sourceId: f.sourceId, requestId: id() }, f.actorId, at(0)), [409]);
    const other = await fixture(store, { ready: false }); await other.pair(); await other.report();
    await rejected(() => other.confirm(), [409]);
    await rejected(() => f.report({ ...f.identity, userId: 'different-synthetic-user' }), [409]);
    assert.deepEqual((await f.refresh()).confirmedIdentity, f.identity);
  }],
  ['one active query and competing claims issue one typed lease with no executable payload', async store => {
    const f = await fixture(store); const query = await f.request();
    await rejected(() => f.request(), [409]);
    const results = await Promise.all([f.claim(), f.claim()]);
    assert.equal(results.filter(value => value.job).length, 1);
    const job = results.find(value => value.job).job;
    assert.deepEqual(Object.keys(job).sort(), ['account', 'adapterVersion', 'connectionId', 'lease', 'query', 'queryId'].sort());
    assert.deepEqual(job.query, { queryId: query.queryId, from: '2026-11-08', to: '2026-11-08', tracking: '' });
    assert.deepEqual(job.account, f.identity); assert.equal(job.adapterVersion, 'heka-classic-v1');
    const duration = Date.parse(job.lease.leaseUntil) - Date.parse(NOW); assert.ok(duration >= 120000 && duration < 121000);
    await rejected(() => claimShippingQuery(store, { deviceId: id() }, f.auth, at(0)), [401]);
    const renewed = await f.heartbeat(job); assert.equal(renewed.state, 'running');
    assert.ok(renewed.lease.leaseUntil > job.lease.leaseUntil);
  }],
  ['another source bearer cannot report progress or complete the query', async store => {
    const f = await fixture(store), job = await f.job();
    const other = await fixture(store, { identity: { userId: 'other-synthetic-user', centerCost: '0008' } });
    await rejected(() => heartbeatShippingQuery(store, { deviceId: other.deviceId, queryId: job.queryId, lease: job.lease }, other.auth, at(1000)), [403, 404]);
    await rejected(() => completeShippingQuery(store, job.queryId, { deviceId: other.deviceId, lease: job.lease, snapshot: f.raw(job) }, other.auth, at(2000)), [403, 404]);
    assert.equal((await getShippingQuery(store, job.queryId, at(2000))).state, 'running');
  }],
  ['re-pair revokes previous device and jobs while preserving the pinned account', async store => {
    const f = await fixture(store), job = await f.job(), oldDevice = f.deviceId, oldAuth = f.auth, oldEpoch = f.connection.epoch;
    await f.pair(id(), at(3000));
    assert.ok(f.connection.epoch > oldEpoch); assert.deepEqual(f.connection.confirmedIdentity, f.identity);
    await rejected(() => claimShippingQuery(store, { deviceId: oldDevice }, oldAuth, at(4000)), [401]);
    await rejected(() => completeShippingQuery(store, job.queryId, { deviceId: oldDevice, lease: job.lease, snapshot: f.raw(job) }, oldAuth, at(4000)), [401]);
    assert.equal((await getShippingQuery(store, job.queryId, at(4000))).errorCode, 'revoked');
    assert.deepEqual(await f.claim(at(4000)), { job: null });
    await rejected(() => f.report({ ...f.identity, centerCost: '9999' }), [409]);
    await f.report(); assert.equal(f.connection.state, 'connected');
    const next = await f.request({}, at(5000)); assert.notEqual(next.queryId, job.queryId);
  }],
  ['inactive authorized actor, source or platform blocks writes and accepted result replay', async store => {
    const f = await fixture(store), job = await f.job(), accepted = await f.complete(job);
    for (const [table, key] of [['users', f.actorId], ['platform_sources', f.sourceId], ['platforms', f.platformId]]) {
      await store.db.run(`UPDATE ${store.t(table)} SET active=0 WHERE id=?`, [key]);
      await rejected(() => f.complete(job), [403]); await rejected(() => f.heartbeat(), [403]);
      await rejected(() => getShippingSnapshot(store, accepted.snapshotId, at(3000)), [403]);
      await store.db.run(`UPDATE ${store.t(table)} SET active=1 WHERE id=?`, [key]);
    }
    assert.deepEqual(await f.complete(job), accepted);
  }],
  ['administrative idempotent replay rechecks active source and actor', async store => {
    const f = await fixture(store), input = { requestId: id(), version: f.connection.version, from: '2026-11-08', to: '2026-11-08' };
    const query = await requestShippingQuery(store, f.connection.id, input, f.actorId, at(0));
    assert.deepEqual(await requestShippingQuery(store, f.connection.id, input, f.actorId, at(0)), query);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await rejected(() => requestShippingQuery(store, f.connection.id, input, f.actorId, at(0)), [403]);
    await store.db.run(`UPDATE ${store.t('users')} SET active=1 WHERE id=?`, [f.actorId]);
    await f.pair(id());
    await rejected(() => requestShippingQuery(store, f.connection.id, input, f.actorId, at(0)), [409]);
  }],
  ['revocation during reading fences heartbeat, completion and previously accepted replay', async store => {
    const f = await fixture(store), job = await f.job(); await f.revoke();
    await rejected(() => f.complete(job), [401, 403]); await rejected(() => f.heartbeat(job), [401, 403]);
    assert.equal((await getShippingQuery(store, job.queryId, at(11000))).state, 'failed');
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('shipping_snapshots')}`)).length, 0);
    const other = await fixture(store, { identity: { userId: 'revocation-test-user', centerCost: '0009' } });
    const second = await other.job();
    const raw = hekaSnapshot({ query: second.query, account: other.identity, capturedAt: at(1000).now, packages: [], guides: [], pending: { cutoff: '2026-11-09T00:00:00.000Z', lines: [] } });
    await other.complete(second, raw); await other.revoke(); await rejected(() => other.complete(second, raw), [401, 403]);
  }],
  ['lease expiry rejects completion and stale token after reclaim; five-minute read is a hard limit', async store => {
    const f = await fixture(store), job = await f.job();
    await rejected(() => f.complete(job, f.raw(job), at(121000)), [409]);
    const reclaimed = (await f.claim(at(122000))).job; assert.notEqual(reclaimed.lease.token, job.lease.token);
    await rejected(() => f.complete(job, f.raw(job), at(123000)), [409]);
    await f.heartbeat(reclaimed, at(220000));
    const timedOut = await f.heartbeat(reclaimed, at(301000));
    assert.equal(timedOut.errorCode, 'timeout');
    await rejected(() => f.complete(reclaimed, f.raw(reclaimed), at(302000)), [409]);
    assert.equal((await getShippingQuery(store, job.queryId, at(303000))).errorCode, 'timeout');
  }],
  ['unattended queue expires at thirty minutes without issuing work', async store => {
    const f = await fixture(store), query = await f.request();
    assert.deepEqual(await f.claim(at(1801000)), { job: null });
    const progress = await getShippingQuery(store, query.queryId, at(1802000));
    assert.equal(progress.state, 'failed'); assert.equal(progress.errorCode, 'timeout');
    const next = await f.request({}, at(1803000)); assert.notEqual(next.queryId, query.queryId);
  }],
  ['complete is canonical server-hash idempotent beyond lease and immutable on payload conflict', async store => {
    const f = await fixture(store), before = await businessFingerprint(store), job = await f.job(), raw = f.raw(job);
    const accepted = await f.complete(job, raw);
    assert.equal(accepted.payloadHash, hash(normalizeHekaSnapshot(raw)));
    const reordered = structuredClone(raw); reordered.packages[0].lines.reverse();
    assert.deepEqual(await f.complete(job, reordered, at(600000)), accepted);
    const withoutLease = { deviceId: f.deviceId, snapshot: reordered };
    assert.deepEqual(await completeShippingQuery(store, job.queryId, withoutLease, f.auth, at(610000)), accepted);
    const changed = structuredClone(raw); changed.guides[0].referencia = 'observación sintética distinta';
    await rejected(() => f.complete(job, changed, at(620000)), [409]);
    const saved = await getShippingSnapshot(store, accepted.snapshotId, at(630000));
    assert.deepEqual(saved.snapshot, normalizeHekaSnapshot(raw)); assert.equal(saved.payloadHash, accepted.payloadHash);
    assert.equal(saved.snapshot.packages[0].lines.some(line => line.netMinor < 0), true);
    assert.equal(saved.importBatchId, null);
    assert.equal((await getShippingQuery(store, job.queryId, at(630000))).snapshotId, saved.id);
    assert.equal(await businessFingerprint(store), before);
    assert.equal((await store.db.all(`SELECT id FROM ${store.t('shipping_snapshots')}`)).length, 1);
  }],
  ['capture must match account/query and reject partial, cache and oversized observations', async store => {
    const f = await fixture(store), job = await f.job();
    for (const extra of [{ complete: false }, { source: 'cache' }, { query: { ...job.query, queryId: id() } }, { account: { ...f.identity, userId: 'different-synthetic-user' } }]) await rejected(() => f.complete(job, f.raw(job, extra)), [400, 409]);
    const invalid = f.raw(job); invalid.guides[0].address = 'forbidden-synthetic-field';
    await rejected(() => f.complete(job, invalid), [400]);
    const tooMany = f.raw(job); tooMany.guides = Array.from({ length: 10001 }, (_, index) => ({ ...tooMany.guides[0], documentId: `synthetic-row-${index}` }));
    await rejected(() => f.complete(job, tooMany), [400]);
    assert.equal((await store.db.all(`SELECT id FROM ${store.t('shipping_snapshots')}`)).length, 0);
    await f.complete(job);
  }],
  ['fixed failure codes do not persist provider text and login requires a new personal session', async store => {
    const f = await fixture(store), job = await f.job();
    const fail = (errorCode, extra = {}) => failShippingQuery(store, job.queryId, { deviceId: f.deviceId, lease: job.lease, errorCode, ...extra }, f.auth, at(1000));
    await rejected(() => fail('arbitrary-provider-text'), [400]);
    const result = await fail('login_required', { error: 'must-not-persist-synthetic-provider-text' });
    assert.equal(result.errorCode, 'login_required'); await f.refresh(); assert.equal(f.connection.state, 'login_required');
    assert.deepEqual(await f.claim(), { job: null }); await rejected(() => f.request(), [409]);
    assert.equal(JSON.stringify(await store.db.all(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [job.lease.key])).includes('must-not-persist'), false);
    await f.report(); assert.equal(f.connection.state, 'connected');
  }],
  ['internal custody, queries and snapshots are excluded from commercial backups', async store => {
    const f = await fixture(store), job = await f.job(), accepted = await f.complete(job), bundle = await store.exportData();
    const serialized = JSON.stringify(bundle);
    for (const value of [f.auth.bearer, hash(f.auth.bearer), accepted.payloadHash, job.queryId, f.identity.userId]) assert.equal(serialized.includes(value), false);
    for (const table of ['shipping_connections', 'shipping_pairings', 'shipping_bridge_credentials', 'shipping_snapshots']) assert.equal(Object.hasOwn(bundle.business, table), false);
    assert.equal(bundle.business.business_requests.some(row => row.scope.startsWith('shipping:')), false);
  }],
  ['snapshots expire after seven days and expiry maintenance is idempotent', async store => {
    const f = await fixture(store), job = await f.job(), accepted = await f.complete(job);
    const snapshot = await getShippingSnapshot(store, accepted.snapshotId, at(3000));
    assert.ok(Date.parse(snapshot.expiresAt) - Date.parse(at(2000).now) >= 7 * 86400000);
    const expiredAt = { now: new Date(Date.parse(snapshot.expiresAt) + 1).toISOString() };
    await rejected(() => getShippingSnapshot(store, accepted.snapshotId, expiredAt), [410]);
    assert.deepEqual(await expireShippingSnapshots(store, expiredAt), { expired: 1, hasMore: false });
    assert.deepEqual(await expireShippingSnapshots(store, expiredAt), { expired: 0, hasMore: false });
    await rejected(() => getShippingSnapshot(store, accepted.snapshotId, expiredAt), [404]);
    assert.equal((await getShippingQuery(store, job.queryId, expiredAt)).state, 'succeeded');
  }],
];

export async function runShippingBridgeContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory();
    try { await scenario(store); } finally { await store.close(); }
  });
}
