import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../lib/business/commands.mjs';
import { HEKA_ADAPTER_VERSION, normalizeHekaIdentity, normalizeHekaQuery, normalizeHekaSnapshot } from '../lib/shipping/heka.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';

const rejected = fn => assert.throws(fn, { status: 400 });
function rejectMutation(mutate) { const raw = hekaSnapshot(); mutate(raw); rejected(() => normalizeHekaSnapshot(raw)); }
function changeHeader(raw, change) { change(raw.packages[0].header); raw.packages[0].headerAfter = structuredClone(raw.packages[0].header); }

test('normalization preserves provider identity, signed cents, absent observations and unknown states', () => {
  const raw = hekaSnapshot(), snapshot = normalizeHekaSnapshot(raw);
  assert.equal(snapshot.adapterVersion, HEKA_ADAPTER_VERSION);
  assert.equal(snapshot.account.userId, 'fixture-user-001 ');
  assert.equal(snapshot.account.centerCost, '0007');
  assert.equal(snapshot.rowCount, 5);
  assert.deepEqual(raw, hekaSnapshot(), 'pure normalizer does not mutate input');
  const guide = snapshot.guides[0], pkg = snapshot.packages[0];
  assert.equal(guide.externalShipmentId, '000001 ');
  assert.equal(guide.tracking, '0000123');
  assert.equal(guide.insuredValueMinor, 0);
  assert.equal(guide.shippingInformationalMinor, null);
  assert.equal(guide.rawStatus, 'ESTADO_DESCONOCIDO');
  assert.equal(guide.rawShipmentStatus, 'FINALIZADA');
  assert.equal(Object.hasOwn(guide, 'eventDate'), false);
  assert.deepEqual(guide.updatedTimestampObserved, raw.guides[0].ultima_actualizacion);
  assert.equal(guide.reportAsOf, '2026-11-08T17:00:00.987Z');
  assert.deepEqual(pkg.headerTimestampObserved, raw.packages[0].header.fecha);
  assert.equal(pkg.settlementDate, '2026-11-08');
  assert.equal(Object.hasOwn(pkg, 'paidAt'), false);
  assert.equal(pkg.lines[0].paymentDateObserved, '2026-11-08');
  assert.equal(Object.hasOwn(pkg.lines[0], 'paidAt'), false);
  assert.equal(pkg.quantityInfo, 42, 'cantidad_pagos is not a verified row count');
  assert.equal(pkg.lines.length, 3);
  assert.equal(pkg.lines[0].documentId, '000001 ');
  assert.deepEqual(pkg.lines.map(line => line.netMinor), [9025, -500, -1500]);
  assert.equal(pkg.grossMinor, 10025);
  assert.equal(pkg.shippingMinor, 3000);
  assert.equal(pkg.commissionMinor, 300);
  assert.equal(pkg.netMinor, 7025, 'commission must not be subtracted twice');
  assert.equal(pkg.totalPaidMinor, pkg.netMinor);
  assert.equal(pkg.lines[1].tracking, pkg.lines[0].tracking);
  assert.equal(snapshot.pending.lines[0].grossMinor, 0);
  assert.equal(snapshot.pending.lines[0].paymentDateObserved, null);
  assert.equal(snapshot.pending.lines[0].netMinor, null);
  assert.equal(Object.hasOwn(pkg, 'id_user'), false);
});

test('empty complete server capture is distinct from a failed or cached read', () => {
  const empty = hekaSnapshot({ guides: [], packages: [], pending: { cutoff: '2026-11-09T00:00:00Z', lines: [] } });
  assert.equal(normalizeHekaSnapshot(empty).rowCount, 0);
  for (const source of ['cache', 'default', null]) rejectMutation(raw => { raw.source = source; });
  for (const complete of [false, null, 'true']) rejectMutation(raw => { raw.complete = complete; });
  rejectMutation(raw => { raw.adapterVersion = 'future'; });
  rejectMutation(raw => { raw.schemaVersion = 2; });
});

test('strict allowlists reject raw storage, personal data and untyped fields at every level', () => {
  const targets = [raw => raw, raw => raw.query, raw => raw.account, raw => raw.guides[0], raw => raw.packages[0], raw => raw.packages[0].header, raw => raw.packages[0].headerAfter, raw => raw.packages[0].lines[0], raw => raw.pending, raw => raw.pending.lines[0]];
  for (const target of targets) rejectMutation(raw => { target(raw).unexpected = 'not allowed'; });
  rejected(() => normalizeHekaIdentity({ userId: 123, centerCost: '0007' }));
  rejected(() => normalizeHekaIdentity({ userId: 'a', centerCost: 'b', localStorage: {} }));
  rejectMutation(raw => { raw.guides[0].numeroGuia = 123; });
  rejectMutation(raw => { raw.packages[0].lines[0].documentId = ''; });
});

test('calendar range and pending cutoff validation are independent of host timezone', () => {
  const query = { queryId: 'query-1', from: '2026-01-01', to: '2026-01-31' };
  assert.equal(normalizeHekaQuery(query).tracking, '');
  for (const patch of [{ to: '2026-02-01' }, { to: '2025-12-31' }, { from: '2026-02-30' }, { from: '2026-1-01' }]) rejected(() => normalizeHekaQuery({ ...query, ...patch }));
  rejectMutation(raw => { raw.pending.cutoff = '2026-11-09T05:00:00Z'; });
  rejectMutation(raw => { raw.capturedAt = '2026-02-30T12:00:00Z'; });
  rejectMutation(raw => { raw.guides[0].ultima_actualizacion = 'yesterday'; });
  rejectMutation(raw => { raw.packages[0].lines[0].FECHA = '07-11-2026'; });
  rejectMutation(raw => { raw.packages[0].lines[0].fechaPago = '2026-11-08T02:00:00Z'; });
  const raw = hekaSnapshot();
  changeHeader(raw, header => { header.fecha = { seconds: 0, nanoseconds: 999999999 }; });
  assert.equal(normalizeHekaSnapshot(raw).packages[0].settlementDate, '2026-11-08');
});

test('observed timestamp components retain nanoseconds while report cutoff floors to milliseconds', () => {
  const raw = hekaSnapshot();
  raw.guides[0].ultima_actualizacion = { seconds: 253402300799, nanoseconds: 999999999 };
  const snapshot = normalizeHekaSnapshot(raw);
  assert.deepEqual(snapshot.guides[0].updatedTimestampObserved, { seconds: 253402300799, nanoseconds: 999999999 });
  assert.equal(snapshot.guides[0].reportAsOf, '9999-12-31T23:59:59.999Z', 'no floating-point rollover into the next second');
  raw.guides[0].ultima_actualizacion.nanoseconds = 999999998;
  const changed = normalizeHekaSnapshot(raw);
  assert.equal(changed.guides[0].reportAsOf, snapshot.guides[0].reportAsOf);
  assert.notEqual(hash(changed), hash(snapshot), 'submillisecond evidence participates in replay identity');
  const duplicate = structuredClone(raw.guides[0]);
  duplicate.ultima_actualizacion.nanoseconds -= 1;
  raw.guides.push(duplicate);
  rejected(() => normalizeHekaSnapshot(raw));
  raw.guides.pop();
  raw.guides[0].ultima_actualizacion = { seconds: 0, nanoseconds: 0 };
  assert.equal(normalizeHekaSnapshot(raw).guides[0].reportAsOf, '1970-01-01T00:00:00.000Z');
  raw.guides[0].ultima_actualizacion = null;
  assert.equal(normalizeHekaSnapshot(raw).guides[0].updatedTimestampObserved, null);
  assert.equal(normalizeHekaSnapshot(raw).guides[0].reportAsOf, null);
  delete raw.guides[0].ultima_actualizacion;
  assert.equal(normalizeHekaSnapshot(raw).guides[0].reportAsOf, null, 'absence is not epoch zero');
});

test('observed timestamp structures fail closed without accepting ISO aliases or coercions', () => {
  const invalidTimestamps = [
    '', 0, '2026-11-08T17:00:00Z', [], {}, { seconds: 0 }, { nanoseconds: 0 },
    { seconds: '0', nanoseconds: 0 }, { seconds: 0, nanoseconds: '0' },
    { seconds: -1, nanoseconds: 0 }, { seconds: 253402300800, nanoseconds: 0 },
    { seconds: Number.MAX_SAFE_INTEGER + 1, nanoseconds: 0 }, { seconds: 1.5, nanoseconds: 0 },
    { seconds: 0, nanoseconds: -1 }, { seconds: 0, nanoseconds: 1000000000 },
    { seconds: 0, nanoseconds: 0.5 }, { seconds: NaN, nanoseconds: 0 },
    { seconds: 0, nanoseconds: Infinity }, { seconds: 0, nanoseconds: 0, extra: true },
  ];
  for (const value of invalidTimestamps) rejectMutation(raw => { raw.guides[0].ultima_actualizacion = value; });
  rejectMutation(raw => { changeHeader(raw, header => { header.fecha = { seconds: 0, nanoseconds: '0' }; }); });
  rejectMutation(raw => { changeHeader(raw, header => { header.fechaPago = '2026-11-08'; }); });
});

test('header timestamp precision is immutable evidence, never the source of a payment day', () => {
  const raw = hekaSnapshot();
  changeHeader(raw, header => { header.fecha = { seconds: 0, nanoseconds: 123456789 }; });
  const first = normalizeHekaSnapshot(raw);
  assert.equal(first.packages[0].settlementDate, '2026-11-08');
  raw.packages[0].headerAfter.fecha.nanoseconds += 1;
  rejected(() => normalizeHekaSnapshot(raw));
  raw.packages[0].header.fecha.nanoseconds += 1;
  const changed = normalizeHekaSnapshot(raw);
  assert.notEqual(hash(first), hash(changed));
  assert.equal(changed.packages[0].settlementDate, '2026-11-08');
  changeHeader(raw, header => { delete header.fecha; });
  const absent = normalizeHekaSnapshot(raw).packages[0];
  assert.equal(absent.headerTimestampObserved, null);
  assert.equal(absent.settlementDate, '2026-11-08');
  changeHeader(raw, header => { header.fecha = null; });
  assert.equal(normalizeHekaSnapshot(raw).packages[0].settlementDate, '2026-11-08');
});

test('payment observations are calendar days only and full paid lines must agree without time inference', () => {
  const raw = hekaSnapshot();
  for (const line of raw.packages[0].lines) line.fechaPago = null;
  let pkg = normalizeHekaSnapshot(raw).packages[0];
  assert.equal(pkg.settlementDate, '2026-11-08', 'complete FECHA dates suffice when optional payment observations are absent');
  assert.ok(pkg.lines.every(line => line.paymentDateObserved === null && !Object.hasOwn(line, 'paidAt')));
  for (const line of raw.packages[0].lines) { line.FECHA = '01-01-2026'; line.fechaPago = '2026-01-01'; }
  pkg = normalizeHekaSnapshot(raw).packages[0];
  assert.equal(pkg.settlementDate, '2026-01-01');
  assert.ok(pkg.lines.every(line => line.paymentDateObserved === '2026-01-01'));
  rejectMutation(valueRaw => { valueRaw.packages[0].lines[0].fechaPago = '2026-11-07'; });
  for (const value of ['', '2026-1-01', '2026-02-30', '2026-11-08T00:00:00Z', '2026-11-08T00:00:00-05:00', 0]) {
    rejectMutation(valueRaw => { valueRaw.packages[0].lines[0].fechaPago = value; });
    rejectMutation(valueRaw => { valueRaw.pending.lines[0].fechaPago = value; });
  }
  rejectMutation(valueRaw => {
    valueRaw.packages[0].lines[0].FECHA = '07-11-2026';
    valueRaw.packages[0].lines[0].fechaPago = '2026-11-07';
  });
  rejectMutation(valueRaw => { valueRaw.packages[0].lines[0].FECHA = null; });
});

test('account ownership and complete unchanged package evidence are mandatory', () => {
  rejectMutation(raw => { raw.packages[0].headerAfter.total_pagado = '0'; });
  rejectMutation(raw => { changeHeader(raw, header => { header.id_user = 'different'; }); });
  rejectMutation(raw => { changeHeader(raw, header => { header.centro_de_costo = 'different'; }); });
  rejectMutation(raw => { raw.packages[0].lines[0].REMITENTE = 'different'; });
  rejectMutation(raw => { raw.pending.lines[0].REMITENTE = 'different'; });
  rejectMutation(raw => { raw.packages[0].lines[0].idPaquetePago = 'other-package'; });
  rejectMutation(raw => { raw.pending.lines[0].idPaquetePago = 'paid-package'; });
  rejectMutation(raw => { raw.packages[0].lines.pop(); });
  rejectMutation(raw => { raw.packages[0].lines = []; });
  rejectMutation(raw => { changeHeader(raw, header => { header.guiasPagadas = ['0000123', '0000456']; }); });
  rejectMutation(raw => { raw.packages[0].lines[0].carrierCollection = 'OTHER'; });
});

test('canonical exact amounts reject ambiguous locale, precision, missing paid values and discrepancies', () => {
  for (const amount of ['1,00', '1.000,00', '1e2', '1.001', 'NaN', Infinity, 0.1 + 0.2, null, '', '100000000000.01']) rejectMutation(raw => { raw.packages[0].lines[0].RECAUDO = amount; });
  rejectMutation(raw => { raw.guides[0].seguro = '-0.01'; });
  rejectMutation(raw => { raw.guides[0].valor = '-1'; });
  rejectMutation(raw => { raw.packages[0].lines[0]['TOTAL A PAGAR'] = '89.25'; });
  rejectMutation(raw => { changeHeader(raw, header => { header.total_pagado = '70.24'; }); });
  rejectMutation(raw => { changeHeader(raw, header => { header.comision_heka = '2.99'; }); });
  const raw = hekaSnapshot();
  raw.guides[0].valor = 100.25;
  raw.guides[0].seguro = 0;
  assert.equal(normalizeHekaSnapshot(raw).guides[0].expectedCollectionMinor, 10025);
});

test('reordered provider arrays hash identically and exact duplicate SDK documents deduplicate', () => {
  const original = hekaSnapshot();
  const reordered = hekaSnapshot();
  reordered.packages[0].lines.reverse();
  changeHeader(reordered, header => { header.guiasPagadas.reverse(); });
  reordered.packages[0].lines.push(structuredClone(reordered.packages[0].lines[0]));
  reordered.guides.push(structuredClone(reordered.guides[0]));
  assert.equal(hash(normalizeHekaSnapshot(original)), hash(normalizeHekaSnapshot(reordered)));
  rejectMutation(raw => { const duplicate = structuredClone(raw.packages[0].lines[0]); duplicate.referencia = 'conflicting'; raw.packages[0].lines.push(duplicate); });
  rejectMutation(raw => { const duplicate = structuredClone(raw.guides[0]); duplicate.estado = 'different'; raw.guides.push(duplicate); });
  rejectMutation(raw => { raw.packages.push(structuredClone(raw.packages[0])); });
});

test('row and byte limits fail closed without a truncated successful result', () => {
  rejectMutation(raw => { raw.guides = Array.from({ length: 10_001 }, () => structuredClone(raw.guides[0])); });
  rejectMutation(raw => { raw.guides[0].referencia = 'x'.repeat(10 * 1024 * 1024); });
  const raw = hekaSnapshot({ packages: [], pending: { cutoff: '2026-11-09T00:00:00Z', lines: [] } });
  const guide = raw.guides[0];
  raw.guides = Array.from({ length: 10_000 }, (_, index) => ({ ...guide, documentId: `guide-${index}` }));
  assert.equal(normalizeHekaSnapshot(raw).rowCount, 10_000);
});
