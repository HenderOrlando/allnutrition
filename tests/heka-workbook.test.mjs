import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { hash } from '../lib/business/commands.mjs';
import { validateImportConfig } from '../lib/business/imports.mjs';
import { createHekaWorkbook, normalizeHekaSnapshot, validateHekaImportOrigin } from '../lib/shipping/heka.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';

const XLSX = createRequire(import.meta.url)('xlsx');
function prepared(raw = hekaSnapshot()) {
  const snapshot = normalizeHekaSnapshot(raw), workbook = createHekaWorkbook(snapshot);
  const sheets = XLSX.read(workbook.bytes, { type: 'buffer' });
  const rows = name => XLSX.utils.sheet_to_json(sheets.Sheets[name], { header: 1, raw: true, defval: '' });
  const origin = { format: 'heka-import-v1', snapshotId: 'synthetic-capture', sourceHash: hash(snapshot),
    adapterVersion: snapshot.adapterVersion, schemaVersion: 1, sourceId: 'synthetic-source', capturedAt: snapshot.capturedAt,
    query: snapshot.query, accountFingerprint: hash(snapshot.account), fileHash: createHash('sha256').update(workbook.bytes).digest('hex'), ...workbook.manifest };
  return { snapshot, workbook, sheets, rows, origin };
}
function objects(rows) { return rows.slice(1).map(values => Object.fromEntries(rows[0].map((header, index) => [header, values[index]]))); }

test('workbook retains complete paid documents, signed observations and opaque IDs without financial mappings', () => {
  const { workbook, sheets, rows, origin } = prepared();
  assert.deepEqual(sheets.SheetNames, ['tracking', 'settlements']);
  assert.doesNotThrow(() => validateImportConfig(workbook.config));
  const tracking = objects(rows('tracking'))[0], paid = objects(rows('settlements'));
  assert.equal(tracking.externalShipmentId, '000001 ');
  assert.equal(tracking.tracking, '0000123'); assert.equal(tracking.documentId, 'fixture-guide-001 ');
  assert.equal(tracking.insuredValue, '0.00'); assert.equal(tracking.shippingInformational, '');
  assert.equal(tracking.rawShipmentStatus, 'FINALIZADA'); assert.equal(tracking.rawStatus, 'ESTADO_DESCONOCIDO');
  assert.equal(tracking.reportAsOf, '2026-11-08T17:00:00.987Z');
  assert.equal(tracking.updatedTimestampSecondsObserved, 1794157200);
  assert.equal(tracking.updatedTimestampNanosecondsObserved, 987654321);
  assert.equal(paid.length, 3);
  assert.deepEqual(paid.map(row => row.documentId), ['000001 ', '000002', '000003']);
  assert.deepEqual(paid.map(row => row.settlementGross), ['100.25', '100.25', '0.00']);
  assert.deepEqual(paid.map(row => row.settlementNet), ['70.25', '70.25', '70.25']);
  assert.deepEqual(paid.map(row => row['TOTAL A PAGAR']), ['90.25', '-5.00', '-15.00']);
  assert.deepEqual(paid.map(row => row['COMISION HEKA']), ['1.00', '1.00', '1.00']);
  assert.equal(paid[1].lineTimestamp, 1793977200000, 'full package includes document discovered outside query dates');
  assert.equal(paid[2].externalShipmentId, '', 'no free-reference matching');
  assert.equal(paid[0].settlementExternalId, 'fixture-package-01 ');
  assert.equal(paid[0].reference, '');
  assert.ok(paid.every(row => row.paymentDateObserved === '2026-11-08'));
  assert.ok(paid.every(row => !Object.hasOwn(row, 'paidAt')));
  assert.deepEqual(origin.trackingRows[0].updatedTimestampObserved, { seconds: 1794157200, nanoseconds: 987654321 });
  assert.deepEqual(origin.packages[0].headerTimestampObserved, { seconds: 1794150000, nanoseconds: 123456789 });
  assert.equal(Object.hasOwn(origin.packages[0], 'paidAt'), false);
  const destinations = workbook.config.sheets.flatMap(sheet => sheet.columns.map(column => column.destination));
  for (const forbidden of ['eventAt', 'placedOn', 'collectedAmount', 'collectionDate', 'shippingOutCost', 'shippingReturnCost', 'platformFee', 'insuranceCost', 'additionalField']) assert.equal(destinations.includes(forbidden), false);
  for (const header of ['updatedTimestampSecondsObserved', 'updatedTimestampNanosecondsObserved']) {
    assert.equal(workbook.config.sheets[0].columns.find(column => column.header === header.toLowerCase()).destination, 'ignore');
  }
  assert.equal(workbook.config.sheets[1].columns.find(column => column.header === 'paymentdateobserved').destination, 'ignore');
  assert.equal(JSON.stringify(rows('tracking')).includes('Sin dato'), false);
  assert.equal(JSON.stringify(rows('settlements')).includes('Sin dato'), false);
  assert.equal(origin.packages[0].quantityInfo, 42, 'quantity info is not interpreted as package row count');
  assert.equal(origin.packages[0].rows[1].netMinor, -500);
  assert.equal(origin.packages[0].rows[2].grossMinor, 0);
  assert.equal(origin.packages[0].rows[2].netMinor, -1500);
  assert.deepEqual(validateHekaImportOrigin(origin, { sourceId: origin.sourceId, fileHash: origin.fileHash }), origin);
  assert.equal(JSON.stringify(origin).includes('fixture-user'), false, 'only account fingerprint enters commercial provenance');
});

test('query calendar, paid document date, observed guide cutoff and wallet UTC cutoff remain distinct', () => {
  const raw = hekaSnapshot();
  raw.query.from = '2026-11-07'; raw.query.to = '2026-11-09';
  raw.pending.cutoff = '2026-11-10T00:00:00.000Z';
  const { rows, origin, sheets } = prepared(raw);
  assert.equal(objects(rows('settlements'))[0].settlementDate, '2026-11-08');
  assert.equal(objects(rows('tracking'))[0].reportAsOf, '2026-11-08T17:00:00.987Z');
  assert.equal(origin.query.from, '2026-11-07'); assert.equal(origin.query.to, '2026-11-09');
  assert.equal(JSON.stringify(origin).includes(raw.pending.cutoff), false);
  assert.deepEqual(sheets.SheetNames, ['tracking', 'settlements']);
});

test('immutable workbook provenance preserves precise timestamps without inventing payment times', () => {
  const raw = hekaSnapshot();
  raw.guides[0].ultima_actualizacion = { seconds: 253402300799, nanoseconds: 999999999 };
  raw.packages[0].header.fecha = { seconds: 0, nanoseconds: 123456789 };
  raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
  raw.packages[0].lines[1].fechaPago = null;
  const first = prepared(raw), guide = objects(first.rows('tracking'))[0], paid = objects(first.rows('settlements'));
  assert.equal(guide.reportAsOf, '9999-12-31T23:59:59.999Z');
  assert.equal(guide.updatedTimestampSecondsObserved, 253402300799);
  assert.equal(guide.updatedTimestampNanosecondsObserved, 999999999);
  assert.deepEqual(first.origin.trackingRows[0].updatedTimestampObserved, { seconds: 253402300799, nanoseconds: 999999999 });
  assert.deepEqual(first.origin.packages[0].headerTimestampObserved, { seconds: 0, nanoseconds: 123456789 });
  assert.ok(paid.every(row => row.settlementDate === '2026-11-08'));
  assert.deepEqual(paid.map(row => row.paymentDateObserved), ['2026-11-08', '', '2026-11-08']);
  assert.deepEqual(validateHekaImportOrigin(JSON.parse(JSON.stringify(first.origin))), first.origin);
  raw.guides[0].ultima_actualizacion.nanoseconds -= 1;
  const changed = prepared(raw);
  assert.equal(objects(changed.rows('tracking'))[0].reportAsOf, guide.reportAsOf);
  assert.notEqual(changed.origin.sourceHash, first.origin.sourceHash);
  assert.notEqual(changed.origin.fileHash, first.origin.fileHash, 'ignored original precision remains in the immutable Excel bytes');
  raw.packages[0].header.fecha = null;
  raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
  const absent = prepared(raw);
  assert.equal(absent.origin.packages[0].headerTimestampObserved, null);
  assert.equal(absent.origin.packages[0].settlementDate, '2026-11-08');
  raw.guides[0].ultima_actualizacion = { seconds: 0, nanoseconds: 0 };
  const zero = prepared(raw), epoch = objects(zero.rows('tracking'))[0];
  assert.equal(epoch.updatedTimestampSecondsObserved, 0);
  assert.equal(epoch.updatedTimestampNanosecondsObserved, 0);
  assert.equal(epoch.reportAsOf, '1970-01-01T00:00:00.000Z');
});

test('guide lookup and repeated gross use the exact importer identity normalization, without ambiguous matches', () => {
  const raw = hekaSnapshot();
  raw.packages[0].lines[1].TRANSPORTADORA = ' ｓｅｒｖｉｅｎｔｒｅｇａ  ';
  raw.packages[0].lines[1].GUIA = ' 0000123 ';
  raw.packages[0].header.guiasPagadas[1] = ' 0000123 ';
  raw.packages[0].headerAfter = structuredClone(raw.packages[0].header);
  let value = prepared(raw), paid = objects(value.rows('settlements'));
  assert.equal(paid[1].externalShipmentId, '000001 ');
  assert.equal(paid[0].settlementGross, '100.25'); assert.equal(paid[1].settlementGross, '100.25');
  raw.guides.push({ ...raw.guides[0], documentId: 'other-guide', id_heka: 'other-shipment', transportadora: ' servientrega ' });
  value = prepared(raw); paid = objects(value.rows('settlements'));
  assert.equal(paid[0].externalShipmentId, ''); assert.equal(paid[1].externalShipmentId, '');
  assert.equal(paid[0].settlementGross, '100.25'); assert.equal(paid[1].settlementGross, '100.25');
});

test('empty optional guide fields stay empty, zero paid data stays real, and pending never becomes a sheet', () => {
  const raw = hekaSnapshot();
  raw.guides[0].ultima_actualizacion = null; raw.guides[0].timeline = null;
  raw.guides[0].estadoTransportadora = ''; raw.guides[0].estado = '';
  const { rows } = prepared(raw), guide = objects(rows('tracking'))[0];
  assert.equal(guide.reportAsOf, ''); assert.equal(guide.createdAtObserved, ''); assert.equal(guide.createdTimeline, '');
  assert.equal(guide.updatedTimestampSecondsObserved, ''); assert.equal(guide.updatedTimestampNanosecondsObserved, '');
  const zero = hekaSnapshot({ guides: [] });
  zero.packages[0].lines = [zero.packages[0].lines[2]];
  Object.assign(zero.packages[0].lines[0], { RECAUDO: '0', 'ENVÍO TOTAL': '0', 'COMISION HEKA': '0', 'TOTAL A PAGAR': '0' });
  Object.assign(zero.packages[0].header, { guiasPagadas: ['0000456'], total_pagado: '0', comision_heka: '0' });
  zero.packages[0].headerAfter = structuredClone(zero.packages[0].header);
  const result = prepared(zero), paid = objects(result.rows('settlements'))[0];
  assert.equal(paid.settlementGross, '0.00'); assert.equal(paid.settlementNet, '0.00');
  assert.equal(paid['TOTAL A PAGAR'], '0.00');
  assert.deepEqual(result.workbook.config.sheets.map(sheet => sheet.enabled), [false, true]);
  assert.throws(() => createHekaWorkbook(normalizeHekaSnapshot(hekaSnapshot({ guides: [], packages: [] }))));
});

test('different original package IDs that collapse in Excel are rejected rather than merged', () => {
  const raw = hekaSnapshot(), other = structuredClone(raw.packages[0]);
  other.idPaquetePago = other.idPaquetePago.trim();
  other.lines = other.lines.map(line => ({ ...line, documentId: `other-${line.documentId}`, idPaquetePago: other.idPaquetePago }));
  raw.packages.push(other);
  const normalized = normalizeHekaSnapshot(raw);
  assert.throws(() => createHekaWorkbook(normalized));
});

test('commercial provenance rejects forged sums, partial manifests, duplicate documents, changed source and hidden fields', () => {
  const { origin } = prepared();
  for (const mutate of [
    value => { value.sourceHash = value.sourceHash.toUpperCase(); },
    value => { value.query.from = '2026-02-30'; },
    value => { value.query.to = '2026-12-10'; },
    value => { value.query.code = 'not-allowed'; },
    value => { value.storage = {}; },
    value => { value.packages[0].rows[0].token = 'forbidden'; },
    value => { value.packages[0].quantityInfo = undefined; },
    value => { value.packages[0].netMinor -= 300; },
    value => { value.packages[0].rows[0].netMinor -= 100; },
    value => { value.packages[0].declaredTracking.pop(); },
    value => { value.packages[0].rows.pop(); },
    value => { value.packages[0].rows[1].documentId = value.packages[0].rows[0].documentId; },
    value => { value.packages[0].rows[1].rowNumber = value.packages[0].rows[0].rowNumber; },
    value => { value.packages[0].rows[1].rowNumber = 10002; },
    value => { value.packages[0].rows[0].externalShipmentId = 'guessed-shipment'; },
    value => { value.packages[0].settlementDate = '2026-11-09'; },
    value => { value.packages[0].rows[0].paymentDateObserved = '2026-11-09'; },
    value => { value.packages[0].rows[0].paymentDateObserved = '2026-11-08T00:00:00Z'; },
    value => { value.packages[0].rows[0].paidDate = '2026-11-09'; },
    value => { value.packages[0].rows[0].paidAt = '2026-11-08T00:00:00Z'; },
    value => { value.packages[0].paidAt = '2026-11-08T00:00:00Z'; },
    value => { delete value.packages[0].headerTimestampObserved; },
    value => { value.packages[0].headerTimestampObserved.nanoseconds = 1000000000; },
    value => { value.packages[0].headerTimestampObserved = '2026-11-08T00:00:00Z'; },
    value => { delete value.trackingRows[0].updatedTimestampObserved; },
    value => { value.trackingRows[0].updatedTimestampObserved.seconds = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.trackingRows[0].updatedTimestampObserved.extra = true; },
    value => { value.trackingRows[0].sheet = 'orders'; },
  ]) { const changed = structuredClone(origin); mutate(changed); assert.throws(() => validateHekaImportOrigin(changed)); }
  assert.throws(() => validateHekaImportOrigin(origin, { sourceId: 'different-source' }));
  assert.throws(() => validateHekaImportOrigin(origin, { fileHash: '1'.repeat(64) }));
  assert.deepEqual(validateHekaImportOrigin(JSON.parse(JSON.stringify(origin))), origin);
});

test('last allowed data row remains addressable in restored package provenance', () => {
  const { origin } = prepared();
  origin.packages[0].rows[2].rowNumber = 10001;
  assert.equal(validateHekaImportOrigin(origin).packages[0].rows[2].rowNumber, 10001);
});
