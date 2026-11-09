import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { hash, insertRow } from '../lib/business/commands.mjs';
import { claimJob, finishJob, LEASE_MILLISECONDS } from '../lib/business/job-leases.mjs';
import { prepareShippingImport } from '../lib/business/shipping-imports.mjs';
import { createShippingConnection, createShippingPairing, pairShippingBridge, reportShippingIdentity, confirmShippingIdentity,
  listShippingConnections, requestShippingQuery, claimShippingQuery, completeShippingQuery, revokeShippingConnection } from '../lib/business/shipping-bridge.mjs';
import { getImportBatch, updateImportBatch, requestImportPreview, processImportTurn, commitImport, downloadImportOriginal } from '../lib/business/imports.mjs';
import { validateHekaImportOrigin } from '../lib/shipping/heka.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';
import { importData } from '../lib/import.mjs';

const NOW = '2026-11-09T12:00:00.000Z';
const options = { now: NOW };
const id = () => randomUUID();
const count = async (store, table) => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);
const noMoney = async store => {
  for (const table of ['orders', 'order_collections', 'expenses', 'expense_payments', 'cash_entries', 'settlement_receipts']) assert.equal(await count(store, table), 0, table);
};
const noBusiness = async store => { await noMoney(store); for (const table of ['shipments', 'shipment_events', 'settlements']) assert.equal(await count(store, table), 0, table); };
async function fixture(store) {
  const actorId = id(), sourceId = id(), platformId = id(), deviceId = id();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-unused', active: 1 });
  await insertRow(store, 'platforms', { id: platformId, name: 'Importación sintética', name_key: 'importación sintética', active: 1, version: 1, created_at: NOW, updated_at: NOW });
  await insertRow(store, 'platform_sources', { id: sourceId, platform_id: platformId, name: 'Cuenta sintética', active: 1, version: 1, created_at: NOW, updated_at: NOW });
  let connection = await createShippingConnection(store, { requestId: id(), sourceId }, actorId, options);
  const pairing = await createShippingPairing(store, connection.id, { requestId: id(), version: connection.version }, actorId, options);
  const paired = await pairShippingBridge(store, { code: pairing.code, deviceId }, options), auth = { bearer: paired.bearer };
  connection = await reportShippingIdentity(store, { deviceId, identity: hekaSnapshot().account }, auth, options);
  connection = await confirmShippingIdentity(store, connection.id, { requestId: id(), version: connection.version, sourceId, fingerprint: connection.identityFingerprint }, actorId, options);
  const f = { actorId, sourceId, platformId, connectionId: connection.id };
  f.capture = async (mutate = () => {}) => {
    connection = (await listShippingConnections(store, options)).connections.find(row => row.id === connection.id);
    await requestShippingQuery(store, connection.id, { requestId: id(), version: connection.version, from: '2026-11-08', to: '2026-11-08', tracking: '' }, actorId, options);
    const { job } = await claimShippingQuery(store, { deviceId }, auth, options);
    // jobClock advances during claim; derive the synthetic capture from that lease,
    // not the fixture's earlier clock origin.
    const capturedAt = new Date(Date.parse(job.lease.leaseUntil) - LEASE_MILLISECONDS).toISOString();
    const raw = hekaSnapshot({ query: job.query, capturedAt });
    mutate(raw);
    const accepted = await completeShippingQuery(store, job.queryId, { deviceId, lease: job.lease, snapshot: raw }, auth, { now: capturedAt });
    return accepted.snapshotId;
  };
  f.input = snapshotId => ({ requestId: id(), snapshotId, sourceId });
  f.prepare = (snapshotId, extra = {}, actor = actorId, target = store) => prepareShippingImport(target, { ...f.input(snapshotId), ...extra }, actor, options);
  f.revoke = async () => {
    connection = (await listShippingConnections(store, options)).connections.find(row => row.id === connection.id);
    return revokeShippingConnection(store, connection.id, { requestId: id(), version: connection.version }, actorId, options);
  };
  return f;
}
async function ready(store, f, snapshotId) {
  let result;
  for (let turn = 0; turn < 5; turn++) {
    result = await f.prepare(snapshotId);
    if (!result.preparing) return getImportBatch(store, result.batchId);
  }
  assert.fail('preparation did not reach review hand-off');
}
async function reviewed(store, batch) {
  for (let turn = 0; turn < 5; turn++) {
    batch = await getImportBatch(store, batch.id);
    if (batch.preview) return batch;
    await processImportTurn(store, { batchId: batch.id });
  }
  assert.fail('preview did not finish');
}
async function accept(store, batch, actorId) {
  batch = await reviewed(store, batch);
  assert.deepEqual(batch.preview.groups.flatMap(group => group.errors), [], 'complete packet is reviewable without fake collections/costs');
  batch = await commitImport(store, batch.id, { requestId: id(), version: batch.version, previewHash: batch.preview.previewHash }, actorId);
  for (let turn = 0; turn < 8 && ['queued', 'applying'].includes(batch.state); turn++) {
    await processImportTurn(store, { batchId: batch.id }); batch = await getImportBatch(store, batch.id);
  }
  return batch;
}
function cutAfterReservation(store) {
  const cut = Object.create(store);
  let once = true;
  cut.transaction = async fn => {
    const value = await store.transaction(fn);
    if (once && value?.file_bytes_base64) { once = false; throw new Error('synthetic connection lost after commit'); }
    return value;
  };
  return cut;
}
async function storedBatch(store, snapshotId) {
  const snapshot = await store.db.get(`SELECT import_batch_id FROM ${store.t('shipping_snapshots')} WHERE id=?`, [snapshotId]);
  return store.db.get(`SELECT * FROM ${store.t('import_batches')} WHERE id=?`, [snapshot.import_batch_id]);
}

function failDatabaseWrite(store, shouldFail) {
  const failing = Object.create(store);
  failing.transaction = fn => store.transaction(tx => {
    const nested = Object.create(tx), db = Object.create(tx.db);
    db.run = async (sql, params) => {
      if (shouldFail(sql, params)) throw new Error('synthetic persistence interruption');
      return tx.db.run(sql, params);
    };
    nested.db = db;
    return fn(nested);
  });
  return failing;
}

const cases = [
  ['preparation reserves exactly one original and batch across lost responses, competing requests and different admins', async store => {
    const f = await fixture(store), snapshotId = await f.capture(), otherActor = id();
    await insertRow(store, 'users', { id: otherActor, email: `${otherActor}@example.test`, password: 'synthetic-unused', active: 1 });
    await assert.rejects(() => f.prepare(snapshotId, {}, f.actorId, cutAfterReservation(store)), /connection lost/);
    const original = await storedBatch(store, snapshotId);
    assert.ok(original.file_bytes_base64); assert.equal(await count(store, 'import_batches'), 1);
    const responses = await Promise.all([f.prepare(snapshotId), f.prepare(snapshotId, {}, otherActor)]);
    assert.ok(responses.every(result => result.batchId === original.id));
    const batch = await ready(store, f, snapshotId);
    assert.equal(batch.id, original.id); assert.equal(batch.state, 'previewing');
    const after = await storedBatch(store, snapshotId);
    assert.equal(after.file_bytes_base64, original.file_bytes_base64); assert.equal(after.file_hash, original.file_hash);
    assert.equal(await count(store, 'import_batches'), 1); await noBusiness(store);
    assert.equal((await f.prepare(snapshotId)).preparing, false);
    const stillQueued = await store.db.get(`SELECT data,state FROM ${store.t('job_runs')} WHERE key=?`, [`import:${batch.id}`]);
    assert.equal(JSON.parse(stillQueued.data).phase, 'preview'); assert.equal(stillQueued.state, 'queued', 'retry did not consume preview');
  }],
  ['a failed upload leaves no orphan and a failed preview reservation rolls back mappings for safe cross-admin resume', async store => {
    const f = await fixture(store), snapshotId = await f.capture();
    const uploadFailure = failDatabaseWrite(store, sql => sql.startsWith('UPDATE ') && sql.includes('file_bytes_base64'));
    await assert.rejects(() => f.prepare(snapshotId, {}, f.actorId, uploadFailure), /persistence interruption/);
    assert.equal(await count(store, 'import_batches'), 0);
    assert.equal((await store.db.get(`SELECT import_batch_id FROM ${store.t('shipping_snapshots')} WHERE id=?`, [snapshotId])).import_batch_id, null);
    await assert.rejects(() => f.prepare(snapshotId, {}, f.actorId, cutAfterReservation(store)), /connection lost/);
    const original = await storedBatch(store, snapshotId);
    const previewFailure = failDatabaseWrite(store, (sql, params) => sql.startsWith('INSERT ') && sql.includes('business_requests') && params?.[0]?.startsWith('import:preview:'));
    await assert.rejects(() => f.prepare(snapshotId, {}, f.actorId, previewFailure), /persistence interruption/);
    const interrupted = await storedBatch(store, snapshotId);
    assert.equal(interrupted.file_bytes_base64, original.file_bytes_base64);
    const otherActor = id();
    await insertRow(store, 'users', { id: otherActor, email: `${otherActor}@example.test`, password: 'synthetic-unused', active: 1 });
    const resumed = await f.prepare(snapshotId, {}, otherActor);
    assert.equal(resumed.preparing, false); assert.equal(resumed.batchId, original.id);
    assert.equal(await count(store, 'import_batches'), 1); await noBusiness(store);
  }],
  ['scheduler-owned inspection returns preparing and retries resume inspection, mapping and preview without changing the original', async store => {
    const f = await fixture(store), snapshotId = await f.capture();
    await assert.rejects(() => f.prepare(snapshotId, {}, f.actorId, cutAfterReservation(store)), /connection lost/);
    const original = await storedBatch(store, snapshotId), lease = await claimJob(store, { key: `import:${original.id}` });
    assert.equal(lease.phase, 'inspect');
    const waiting = await f.prepare(snapshotId);
    assert.equal(waiting.batchId, original.id); assert.equal(waiting.preparing, true); await noBusiness(store);
    await finishJob(store, lease, { state: 'queued' });
    const batch = await ready(store, f, snapshotId);
    assert.equal(batch.id, original.id); assert.equal(batch.config.sheets.filter(sheet => sheet.enabled).length, 2);
    assert.equal(batch.config.sheets[0].columns.find(column => column.destination === 'externalShipmentId').index, 0);
    assert.equal((await storedBatch(store, snapshotId)).file_bytes_base64, original.file_bytes_base64);
    await noBusiness(store);
  }],
  ['ready retries preserve human mappings/resolutions and cannot consume an accepted application job', async store => {
    const f = await fixture(store), snapshotId = await f.capture();
    let batch = await reviewed(store, await ready(store, f, snapshotId));
    const config = structuredClone(batch.config); config.sheets[0].statusMap = { 'NUEVO ESTADO': 'unknown' };
    batch = await updateImportBatch(store, batch.id, { requestId: id(), version: batch.version, config,
      resolutions: [{ action: 'review_authority', reason: 'Revisión humana sintética', value: {} }] }, f.actorId);
    const version = batch.version, saved = hash({ config: batch.config, resolutions: batch.resolutions });
    await f.prepare(snapshotId);
    batch = await getImportBatch(store, batch.id);
    assert.equal(batch.version, version); assert.equal(hash({ config: batch.config, resolutions: batch.resolutions }), saved);
    await requestImportPreview(store, batch.id, { requestId: id(), version: batch.version }, f.actorId);
    batch = await reviewed(store, batch);
    const accepted = await commitImport(store, batch.id, { requestId: id(), version: batch.version, previewHash: batch.preview.previewHash }, f.actorId);
    await f.prepare(snapshotId);
    assert.equal((await getImportBatch(store, batch.id)).state, 'queued');
    assert.equal((await processImportTurn(store, { batchId: batch.id, expectedPhase: 'inspect' })).processed, 0);
    assert.equal((await getImportBatch(store, batch.id)).version, accepted.version);
    await noBusiness(store);
  }],
  ['preparation rechecks current and authorized actors, source, platform, identity, source selection and snapshot expiry on retries', async store => {
    const f = await fixture(store), snapshotId = await f.capture(); await ready(store, f, snapshotId);
    for (const [table, key] of [['users', f.actorId], ['platform_sources', f.sourceId], ['platforms', f.platformId]]) {
      await store.db.run(`UPDATE ${store.t(table)} SET active=0 WHERE id=?`, [key]);
      await assert.rejects(() => f.prepare(snapshotId), { status: 403 });
      await store.db.run(`UPDATE ${store.t(table)} SET active=1 WHERE id=?`, [key]);
    }
    await assert.rejects(() => f.prepare(snapshotId, { sourceId: id() }), { status: 409 });
    await assert.rejects(() => f.prepare(snapshotId, {}, id()), { status: 403 });
    await assert.rejects(() => prepareShippingImport(store, f.input(snapshotId), f.actorId, { now: '2026-11-17T12:00:00.000Z' }), { status: 410 });
    // Authorized historical captures remain usable when only device custody was revoked.
    await f.revoke(); assert.equal((await f.prepare(snapshotId)).preparing, false);
    await noBusiness(store);
  }],
  ['pending-only successful capture cannot create a misleading empty import', async store => {
    const f = await fixture(store), snapshotId = await f.capture(raw => { raw.guides = []; raw.packages = []; });
    await assert.rejects(() => f.prepare(snapshotId), { status: 400 });
    assert.equal(await count(store, 'import_batches'), 0); await noBusiness(store);
  }],
  ['explicit acceptance retains complete unresolved declaration, signed returns and original manifest but never creates money', async store => {
    const f = await fixture(store), snapshotId = await f.capture();
    let batch = await reviewed(store, await ready(store, f, snapshotId)); await noBusiness(store);
    const origin = batch.shippingOrigin;
    assert.equal(origin.packages[0].id, 'fixture-package-01 ');
    assert.equal(origin.packages[0].rows.length, 3);
    assert.deepEqual(origin.packages[0].rows.map(row => row.netMinor), [9025, -500, -1500]);
    assert.equal(origin.packages[0].rows[2].grossMinor, 0);
    assert.deepEqual(origin.trackingRows[0].updatedTimestampObserved, { seconds: 1794157200, nanoseconds: 987654321 });
    assert.deepEqual(origin.packages[0].headerTimestampObserved, { seconds: 1794150000, nanoseconds: 123456789 });
    assert.ok(origin.packages[0].rows.every(row => row.paymentDateObserved === '2026-11-08' && !Object.hasOwn(row, 'paidAt')));
    assert.equal(Object.hasOwn(origin.packages[0], 'paidAt'), false);
    assert.deepEqual(origin.query, { queryId: origin.query.queryId, from: '2026-11-08', to: '2026-11-08', tracking: '' });
    batch = await accept(store, batch, f.actorId);
    assert.equal(batch.state, 'completed'); assert.equal(await count(store, 'settlements'), 1);
    const declaration = await store.db.get(`SELECT * FROM ${store.t('settlements')}`), data = JSON.parse(declaration.data);
    assert.equal(Number(declaration.net_minor), 7025, 'published net already includes shipping; informational commission is not subtracted again');
    assert.equal(declaration.state, 'pending'); assert.equal(data.reconciliationRequired, true);
    assert.equal(data.lines.length, 0); assert.ok(data.unresolvedLines.length >= 2);
    assert.equal(data.unresolvedLines.reduce((sum, line) => sum + line.grossMinor, 0), 10025, 'same-guide adjustments do not lose or double gross');
    assert.ok(data.unresolvedLines.some(line => line.grossMinor === 0 && line.tracking === '0000456'));
    const revision = await store.db.get(`SELECT data FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=?`, [batch.id, batch.acceptedRevision]);
    assert.deepEqual(JSON.parse(revision.data).shippingOrigin, origin);
    const original = await downloadImportOriginal(store, batch.id);
    assert.equal(createHash('sha256').update(original.bytes).digest('hex'), origin.fileHash);
    const exported = await store.exportData(), commercial = exported.business;
    assert.deepEqual(JSON.parse(commercial.import_batches.find(row => row.id === batch.id).data).shippingOrigin, origin);
    assert.deepEqual(JSON.parse(commercial.import_revisions.find(row => row.batch_id === batch.id).data).shippingOrigin, origin);
    assert.equal(Object.hasOwn(commercial, 'shipping_snapshots'), false);
    assert.deepEqual(validateHekaImportOrigin(origin, { sourceId: batch.sourceId, fileHash: batch.fileHash }), origin);
    assert.equal((await store.db.all(`SELECT * FROM ${store.t('shipment_events')}`)).some(row => row.occurred_at || row.occurred_on), false, 'creation/capture is not an event date');
    assert.equal((await store.db.all(`SELECT status FROM ${store.t('shipments')}`)).some(row => ['delivered', 'returned'].includes(row.status)), false, 'FINALIZADA is administrative, not delivery evidence');
    await noMoney(store);
  }],
  ['zero-net settlement remains an explicit unreconciled declaration, never an absent amount', async store => {
    const f = await fixture(store), snapshotId = await f.capture(raw => {
      raw.guides = [];
      raw.packages[0].lines = [raw.packages[0].lines[2]];
      Object.assign(raw.packages[0].lines[0], { RECAUDO: '0', 'ENVÍO TOTAL': '0', 'COMISION HEKA': '0', 'TOTAL A PAGAR': '0' });
      Object.assign(raw.packages[0].header, { guiasPagadas: ['0000456'], total_pagado: '0', comision_heka: '0' });
      raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
    });
    const batch = await accept(store, await ready(store, f, snapshotId), f.actorId);
    assert.equal(batch.state, 'completed');
    const row = await store.db.get(`SELECT net_minor,data FROM ${store.t('settlements')}`);
    assert.equal(Number(row.net_minor), 0);
    const declaration = JSON.parse(row.data);
    assert.equal(declaration.reconciliationRequired, true);
    assert.equal(declaration.unresolvedLines[0].grossMinor, 0);
    assert.equal(declaration.unresolvedLines[0].netMinor, 0);
    await noMoney(store);
  }],
  ['new capture and reordered package documents do not duplicate shipments, declarations or money', async store => {
    const f = await fixture(store), first = await f.capture();
    await accept(store, await ready(store, f, first), f.actorId);
    const beforeShipments = await count(store, 'shipments');
    const second = await f.capture(raw => {
      raw.guides[0].ultima_actualizacion.nanoseconds -= 1;
      raw.packages[0].header.fecha.nanoseconds += 1;
      raw.packages[0].lines.reverse(); raw.packages[0].header.guiasPagadas.reverse();
      raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
    });
    const batch = await accept(store, await ready(store, f, second), f.actorId);
    assert.equal(batch.state, 'completed'); assert.equal(await count(store, 'import_batches'), 2);
    assert.equal(await count(store, 'shipments'), beforeShipments); assert.equal(await count(store, 'settlements'), 1);
    assert.equal(Number((await store.db.get(`SELECT net_minor FROM ${store.t('settlements')}`)).net_minor), 7025);
    assert.deepEqual(batch.shippingOrigin.trackingRows[0].updatedTimestampObserved, { seconds: 1794157200, nanoseconds: 987654320 });
    assert.deepEqual(batch.shippingOrigin.packages[0].headerTimestampObserved, { seconds: 1794150000, nanoseconds: 123456790 });
    await noMoney(store);
  }],
  ['a corrected known packet cannot silently overwrite the accepted declaration and explicit authority permits correction', async store => {
    const f = await fixture(store); await accept(store, await ready(store, f, await f.capture()), f.actorId);
    const corrected = raw => {
      raw.packages[0].lines[0]['ENVÍO TOTAL'] = '11.00'; raw.packages[0].lines[0]['TOTAL A PAGAR'] = '89.25';
      raw.packages[0].header.total_pagado = '69.25'; raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
    };
    let batch = await reviewed(store, await ready(store, f, await f.capture(corrected)));
    try {
      await commitImport(store, batch.id, { requestId: id(), version: batch.version, previewHash: batch.preview.previewHash }, f.actorId);
      for (let turn = 0; turn < 8; turn++) { const value = await getImportBatch(store, batch.id); if (!['queued', 'applying'].includes(value.state)) break; await processImportTurn(store, { batchId: batch.id }); }
    } catch (error) { assert.equal(error.status, 409); }
    assert.equal(Number((await store.db.get(`SELECT net_minor FROM ${store.t('settlements')}`)).net_minor), 7025);
    batch = await reviewed(store, await ready(store, f, await f.capture(corrected)));
    batch = await updateImportBatch(store, batch.id, { requestId: id(), version: batch.version,
      resolutions: [{ action: 'review_authority', reason: 'Corrección del paquete contrastada con sus documentos originales', value: {} }] }, f.actorId);
    await requestImportPreview(store, batch.id, { requestId: id(), version: batch.version }, f.actorId);
    batch = await accept(store, batch, f.actorId);
    assert.equal(batch.state, 'completed'); assert.equal(await count(store, 'settlements'), 1);
    assert.equal(Number((await store.db.get(`SELECT net_minor FROM ${store.t('settlements')}`)).net_minor), 6925);
    await noMoney(store);
  }],
  ['commercial backup restores immutable Heka origin and accepted declarations without any bridge snapshot or device', async (store, factory) => {
    const f = await fixture(store), snapshotId = await f.capture(raw => {
      raw.guides[0].ultima_actualizacion = { seconds: 1794157200, nanoseconds: 999999999 };
      raw.packages[0].header.fecha = { seconds: 0, nanoseconds: 123456789 };
      raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
      raw.packages[0].lines[1].fechaPago = null;
    });
    const batch = await accept(store, await ready(store, f, snapshotId), f.actorId);
    const bundle = await store.exportData(), origin = batch.shippingOrigin;
    const original = await downloadImportOriginal(store, batch.id), target = await factory();
    try {
      for (const corrupt of [
        value => { value.accountFingerprint = 'not-a-fingerprint'; },
        value => { value.fileHash = '1'.repeat(64); },
        value => { value.packages[0].rows.pop(); },
        value => { value.packages[0].rows[0].token = 'forbidden'; },
        value => { value.trackingRows[0].updatedTimestampObserved.nanoseconds = 1000000000; },
        value => { value.packages[0].headerTimestampObserved = '1970-01-01T00:00:00.123Z'; },
        value => { value.packages[0].rows[0].paymentDateObserved = '2026-11-08T00:00:00Z'; },
        value => { value.packages[0].rows[0].paidAt = '2026-11-08T00:00:00Z'; },
      ]) {
        const changed = structuredClone(bundle), row = changed.business.import_batches.find(value => value.id === batch.id), data = JSON.parse(row.data);
        corrupt(data.shippingOrigin); row.data = JSON.stringify(data);
        await assert.rejects(() => importData(target, changed));
        assert.equal(await count(target, 'import_batches'), 0, 'invalid origin does not partially restore business');
      }
      await importData(target, bundle);
      const restored = await getImportBatch(target, batch.id), retained = await downloadImportOriginal(target, batch.id);
      assert.deepEqual(restored.shippingOrigin, origin); assert.deepEqual(retained.bytes, original.bytes);
      assert.deepEqual(restored.shippingOrigin.trackingRows[0].updatedTimestampObserved, { seconds: 1794157200, nanoseconds: 999999999 });
      assert.deepEqual(restored.shippingOrigin.packages[0].headerTimestampObserved, { seconds: 0, nanoseconds: 123456789 });
      assert.equal(restored.shippingOrigin.packages[0].settlementDate, '2026-11-08');
      assert.deepEqual(restored.shippingOrigin.packages[0].rows.map(row => row.paymentDateObserved), ['2026-11-08', null, '2026-11-08']);
      const revision = await target.db.get(`SELECT data FROM ${target.t('import_revisions')} WHERE batch_id=? AND revision=?`, [batch.id, batch.acceptedRevision]);
      assert.deepEqual(JSON.parse(revision.data).shippingOrigin, origin);
      assert.equal(await count(target, 'shipping_snapshots'), 0); assert.equal(await count(target, 'shipping_connections'), 0);
      const declaration = await target.db.get(`SELECT net_minor,data FROM ${target.t('settlements')}`);
      assert.equal(Number(declaration.net_minor), 7025); assert.equal(JSON.parse(declaration.data).reconciliationRequired, true);
      await noMoney(target);
    } finally { await target.close(); }
  }],
];

export async function runHekaImportContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    let store = await factory();
    // A reset-only PostgreSQL factory needs the source closed before replacement.
    const replacementFactory = async () => {
      const source = store;
      store = null;
      await source.close();
      return factory();
    };
    try { await scenario(store, replacementFactory); } finally { if (store) await store.close(); }
  });
}
