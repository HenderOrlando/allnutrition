import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHeka, getHekaIdentity, HEKA_ADAPTER_VERSION, HEKA_LOGIN_URL, HEKA_PORTAL_URL } from '../desktop/providers/heka.mjs';
import { normalizeHekaSnapshot } from '../lib/shipping/heka.mjs';
import { hekaSnapshot } from './heka-fixtures.mjs';
import { createHekaSdkFixture, HEKA_CARRIERS } from './heka-sdk-fixture.mjs';

const clone = value => structuredClone(value);
const read = fixture => captureHeka(fixture.webContents, { query: fixture.query, account: fixture.account, deadline: Date.now() + 300000 });
const code = expected => error => error.code === expected && error.message === expected;
const emptySnapshot = () => hekaSnapshot({ guides: [], packages: [], pending: { cutoff: '2026-11-09T00:00:00.000Z', lines: [] } });
const sameWithoutCaptureTime = snapshot => ({ ...snapshot, capturedAt: '2026-11-09T12:00:00.000Z' });
const packageFilter = record => record.filters?.find(([field]) => field === 'idPaquetePago')?.[2];
const paidPath = carrier => `pagos/${carrier}/pagos`;

function repeatedGuides(count, source = hekaSnapshot().guides[0]) {
  return Array.from({ length: count }, (_, index) => ({ ...clone(source), documentId: `synthetic-guide-${String(index).padStart(5, '0')}`, id_heka: `synthetic-heka-${index}` }));
}

function secondPackage(snapshot) {
  const pkg = clone(snapshot.packages[0]);
  pkg.idPaquetePago = 'synthetic-package-two';
  pkg.lines = [clone(pkg.lines[0])];
  Object.assign(pkg.lines[0], { documentId: 'second-package-document', idPaquetePago: pkg.idPaquetePago, carrierCollection: 'ENVIA', TRANSPORTADORA: 'ENVIA', GUIA: '0000999' });
  Object.assign(pkg.header, { guiasPagadas: ['0000999'], total_pagado: pkg.lines[0]['TOTAL A PAGAR'], comision_heka: pkg.lines[0]['COMISION HEKA'] });
  pkg.headerAfter = clone(pkg.header);
  return pkg;
}

test('bundled adapter returns raw v1 accepted by the real server normalizer', async () => {
  const fixture = createHekaSdkFixture();
  assert.equal(HEKA_ADAPTER_VERSION, 'heka-classic-v1');
  assert.equal(HEKA_LOGIN_URL, 'https://www.hekaentrega.co/ingreso');
  assert.equal(HEKA_PORTAL_URL, 'https://admin.hekaentrega.co/plataforma2.html');
  assert.deepEqual(await getHekaIdentity(fixture.webContents), fixture.account);
  const raw = await read(fixture);
  const normalized = normalizeHekaSnapshot(raw);
  assert.deepEqual(sameWithoutCaptureTime(normalized), normalizeHekaSnapshot(fixture.snapshot));
  assert.equal(normalized.guides[0].rawStatus, 'ESTADO_DESCONOCIDO');
  assert.equal(normalized.guides[0].rawShipmentStatus, 'FINALIZADA');
  assert.equal(normalized.guides[0].insuredValueMinor, 0);
  assert.deepEqual(raw.guides[0].ultima_actualizacion, fixture.snapshot.guides[0].ultima_actualizacion);
  assert.deepEqual(normalized.guides[0].updatedTimestampObserved, raw.guides[0].ultima_actualizacion);
  assert.equal(normalized.guides[0].reportAsOf, '2026-11-08T17:00:00.987Z');
  assert.deepEqual(normalized.packages[0].headerTimestampObserved, raw.packages[0].header.fecha);
  assert.equal(normalized.packages[0].settlementDate, '2026-11-08');
  assert.ok(normalized.packages[0].lines.every(line => line.paymentDateObserved === '2026-11-08'));
  assert.equal(Object.hasOwn(raw.packages[0].header, 'fechaPago'), false);
  assert.equal(Object.hasOwn(normalized.packages[0], 'paidAt'), false);
  assert.ok(normalized.packages[0].lines.every(line => !Object.hasOwn(line, 'paidAt')));
  assert.equal(Object.hasOwn(normalized.pending.lines[0], 'paidAt'), false);
  assert.equal(normalized.packages[0].quantityInfo, 42);
  assert.equal(normalized.packages[0].netMinor, 7025);
  assert.equal(normalized.packages[0].commissionMinor, 300);
  assert.deepEqual(raw.packages[0].lines.map(line => line.documentId), ['000001 ', '000002', '000003']);
  assert.equal(raw.packages[0].lines[1].GUIA, raw.packages[0].lines[0].GUIA);
  assert.equal(raw.packages[0].lines[1]['TOTAL A PAGAR'], '-5.00');
  assert.equal(raw.packages[0].lines[2].RECAUDO, '0.00');
  assert.equal(raw.pending.lines[0].momentoParticularPago, null);
});

test('all SDK requests retain account ownership, and a discovered package reads all seven carriers outside the initial range', async () => {
  const fixture = createHekaSdkFixture();
  fixture.documents.set('usuarios/other-synthetic-user/guias/not-ours', clone(fixture.snapshot.guides[0]));
  const foreignLine = { ...clone(fixture.snapshot.packages[0].lines[0]), REMITENTE: 'other-synthetic-center' };
  fixture.documents.set('pagos/HEKA/pagos/foreign-document', foreignLine);
  fixture.documents.set('pendientePorPagar/foreign-pending', { ...clone(fixture.snapshot.pending.lines[0]), REMITENTE: 'other-synthetic-center', timeline: 1 });
  const raw = await read(fixture);
  assert.equal(raw.packages[0].lines.length, 3);
  assert.ok(raw.packages[0].lines.some(line => line.momentoParticularPago < Date.parse('2026-11-08T00:00:00-05:00')));
  for (const record of fixture.reads.filter(record => record.kind === 'query')) {
    assert.equal(record.limit, 500);
    if (record.path === fixture.guidePath) continue;
    assert.ok(record.filters.some(([field, operator, value]) => field === 'REMITENTE' && operator === '==' && value === fixture.account.centerCost));
  }
  const packageReads = fixture.reads.filter(record => packageFilter(record));
  assert.deepEqual(new Set(packageReads.map(record => record.path)), new Set(HEKA_CARRIERS.map(paidPath)));
  assert.ok(packageReads.every(record => !record.filters.some(([field]) => field === 'momentoParticularPago')));
  assert.equal(fixture.headerReads.get(`paquetePagos/${fixture.snapshot.packages[0].idPaquetePago}`), 2);
});

test('tracking filters never replace account scope or truncate a complete package', async () => {
  const fixture = createHekaSdkFixture();
  fixture.query.tracking = '0000123';
  const raw = await read(fixture);
  assert.equal(raw.guides.length, 1);
  assert.equal(raw.packages[0].lines.length, 3);
  assert.ok(raw.packages[0].lines.some(line => line.GUIA === '0000456'));
  for (const record of fixture.reads.filter(record => record.kind === 'query' && record.path.startsWith('pagos/'))) {
    assert.ok(record.filters.some(([field, operator, value]) => field === 'REMITENTE' && operator === '==' && value === fixture.account.centerCost));
    assert.equal(record.filters.some(([field]) => field === 'GUIA'), !packageFilter(record));
  }
  assert.doesNotThrow(() => normalizeHekaSnapshot(raw));
});

test('separate packages on one calendar date remain separate', async () => {
  const snapshot = hekaSnapshot();
  snapshot.packages.push(secondPackage(snapshot));
  const raw = await read(createHekaSdkFixture({ snapshot }));
  const result = normalizeHekaSnapshot(raw);
  assert.equal(result.packages.length, 2);
  assert.equal(result.packages[0].settlementDate, result.packages[1].settlementDate);
  assert.equal(result.rowCount, 6);
});

test('500-document pagination uses document snapshot cursors with stable ties for guides, paid discovery, complete packages and wallet', async () => {
  const snapshot = hekaSnapshot();
  snapshot.guides = repeatedGuides(1001);
  const pkg = snapshot.packages[0];
  pkg.lines = Array.from({ length: 1001 }, (_, index) => ({ ...clone(pkg.lines[0]), documentId: `synthetic-paid-${String(index).padStart(5, '0')}`, GUIA: `000${index}`, RECAUDO: '1.01', 'ENVÍO TOTAL': '0.01', 'TOTAL A PAGAR': '1.00', 'COMISION HEKA': '0.01' }));
  Object.assign(pkg.header, { guiasPagadas: pkg.lines.map(line => line.GUIA), total_pagado: '1001.00', comision_heka: '10.01' });
  pkg.headerAfter = clone(pkg.header);
  snapshot.pending.lines = Array.from({ length: 501 }, (_, index) => ({ ...clone(snapshot.pending.lines[0]), documentId: `synthetic-pending-${String(index).padStart(5, '0')}`, GUIA: `009${index}` }));
  const fixture = createHekaSdkFixture({ snapshot });
  const result = normalizeHekaSnapshot(await read(fixture));
  assert.equal(result.guides.length, 1001);
  assert.equal(result.packages[0].lines.length, 1001);
  assert.equal(result.pending.lines.length, 501);
  assert.equal(result.rowCount, 2503);
  const groups = [
    record => record.path === fixture.guidePath,
    record => record.path === paidPath('SERVIENTREGA') && !packageFilter(record),
    record => record.path === paidPath('SERVIENTREGA') && packageFilter(record),
    record => record.path === 'pendientePorPagar',
  ];
  for (const [index, select] of groups.entries()) {
    const records = fixture.reads.filter(record => record.kind === 'query' && select(record));
    assert.equal(records.length, index === 3 ? 2 : 3);
    assert.equal(records[0].cursor, null);
    assert.ok(records.slice(1).every(record => typeof record.cursor === 'string'));
    assert.equal(new Set(records.slice(1).map(record => record.cursor)).size, records.length - 1);
  }
});

test('Bogota inclusive day boundaries and independent UTC wallet cutoff do not depend on the host timezone', async () => {
  const previous = process.env.TZ;
  try {
    const results = [];
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      const snapshot = emptySnapshot();
      const fixture = createHekaSdkFixture({ snapshot });
      const baseGuide = hekaSnapshot().guides[0];
      const lower = Date.parse('2026-11-08T05:00:00.000Z');
      const upper = Date.parse('2026-11-09T05:00:00.000Z');
      for (const [id, timeline] of [['before', lower - 1], ['start', lower], ['last', upper - 1], ['after', upper]]) {
        fixture.documents.set(`${fixture.guidePath}/${id}`, { ...clone(baseGuide), timeline, numeroGuia: id });
      }
      const pending = hekaSnapshot().pending.lines[0];
      const cutoff = Date.parse('2026-11-09T00:00:00.000Z');
      for (const [id, timeline] of [['wallet-last', cutoff - 1], ['wallet-cutoff', cutoff], ['wallet-after', cutoff + 1]]) {
        fixture.documents.set(`pendientePorPagar/${id}`, { ...clone(pending), timeline, GUIA: id });
      }
      const raw = await read(fixture);
      assert.deepEqual(raw.guides.map(guide => guide.documentId), ['last', 'start']);
      assert.deepEqual(raw.pending.lines.map(line => line.documentId), ['wallet-last', 'wallet-cutoff']);
      assert.equal(raw.pending.cutoff, '2026-11-09T00:00:00.000Z');
      results.push(sameWithoutCaptureTime(normalizeHekaSnapshot(raw)));
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('day-only payment observations stay exact across host timezones while the header timestamp is unrelated', async () => {
  const previous = process.env.TZ;
  try {
    const results = [];
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      const snapshot = hekaSnapshot();
      snapshot.packages[0].header.fecha = { seconds: 0, nanoseconds: 999999999 };
      const raw = await read(createHekaSdkFixture({ snapshot }));
      const result = normalizeHekaSnapshot(raw);
      assert.ok(raw.packages[0].lines.every(line => line.fechaPago === '2026-11-08'));
      assert.equal(result.packages[0].settlementDate, '2026-11-08');
      assert.deepEqual(result.packages[0].headerTimestampObserved, { seconds: 0, nanoseconds: 999999999 });
      assert.ok(result.packages[0].lines.every(line => line.paymentDateObserved === '2026-11-08' && line.paidDate === '2026-11-08'));
      results.push(sameWithoutCaptureTime(result));
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('missing observational dates and amounts remain missing instead of becoming events or zero', async () => {
  const snapshot = hekaSnapshot();
  Object.assign(snapshot.guides[0], { ultima_actualizacion: null, fecha: '', seguro: null, valor: '', costo_envio: null });
  for (const line of snapshot.packages[0].lines) line.fechaPago = null;
  delete snapshot.packages[0].header.fecha;
  const result = normalizeHekaSnapshot(await read(createHekaSdkFixture({ snapshot })));
  assert.equal(result.guides[0].reportAsOf, null);
  assert.equal(result.guides[0].updatedTimestampObserved, null);
  assert.equal(result.packages[0].headerTimestampObserved, null);
  assert.equal(result.packages[0].settlementDate, '2026-11-08');
  assert.equal(result.guides[0].creationDateRaw, null);
  assert.equal(result.guides[0].insuredValueMinor, null);
  assert.equal(result.guides[0].expectedCollectionMinor, null);
  assert.ok(result.packages[0].lines.every(line => line.paymentDateObserved === null));
  assert.equal(result.pending.lines[0].shippingMinor, null);
});

for (const [seconds, nanoseconds, expectedIso] of [
  [0, 0, '1970-01-01T00:00:00.000Z'],
  [1794157200, 999999999, '2026-11-08T17:00:00.999Z'],
  [253402300799, 999999999, '9999-12-31T23:59:59.999Z'],
]) {
  test(`timestamp ${seconds}/${nanoseconds} preserves components without rounding into another second`, async () => {
    const snapshot = hekaSnapshot();
    const observed = { seconds, nanoseconds };
    snapshot.guides[0].ultima_actualizacion = clone(observed);
    snapshot.packages[0].header.fecha = clone(observed);
    const raw = await read(createHekaSdkFixture({ snapshot }));
    const result = normalizeHekaSnapshot(raw);
    assert.deepEqual(raw.guides[0].ultima_actualizacion, observed);
    assert.deepEqual(raw.packages[0].header.fecha, observed);
    assert.deepEqual(raw.packages[0].headerAfter.fecha, observed);
    assert.deepEqual(result.guides[0].updatedTimestampObserved, observed);
    assert.equal(result.guides[0].reportAsOf, expectedIso);
    assert.deepEqual(result.packages[0].headerTimestampObserved, observed);
    assert.equal(result.packages[0].settlementDate, '2026-11-08');
  });
}

test('absent observations are nullable, never derived from creation or capture times', async () => {
  const snapshot = hekaSnapshot();
  delete snapshot.guides[0].ultima_actualizacion;
  snapshot.packages[0].header.fecha = null;
  for (const line of snapshot.packages[0].lines) delete line.fechaPago;
  delete snapshot.pending.lines[0].fechaPago;
  const raw = await read(createHekaSdkFixture({ snapshot }));
  const result = normalizeHekaSnapshot(raw);
  assert.equal(raw.guides[0].ultima_actualizacion, null);
  assert.equal(raw.packages[0].header.fecha, null);
  assert.equal(result.guides[0].reportAsOf, null);
  assert.equal(result.guides[0].updatedTimestampObserved, null);
  assert.equal(result.packages[0].headerTimestampObserved, null);
  assert.ok(result.packages[0].lines.every(line => line.paymentDateObserved === null));
  assert.equal(result.pending.lines[0].paymentDateObserved, null);
  assert.equal(result.packages[0].settlementDate, '2026-11-08');
});

for (const [name, value] of [
  ['ISO fallback', '2026-11-08T17:00:00.000Z'],
  ['millisecond fallback', 1794157200000],
  ['empty string', ''],
  ['unknown object', { milliseconds: 1794157200000 }],
  ['missing nanoseconds', { seconds: 1794157200 }],
  ['missing seconds', { nanoseconds: 0 }],
  ['unknown key', { seconds: 1794157200, nanoseconds: 0, extra: true }],
  ['array', [1794157200, 0]],
  ['negative seconds', { seconds: -1, nanoseconds: 0 }],
  ['fractional seconds', { seconds: 1794157200.5, nanoseconds: 0 }],
  ['unsafe seconds', { seconds: Number.MAX_SAFE_INTEGER + 1, nanoseconds: 0 }],
  ['out-of-range seconds', { seconds: 253402300800, nanoseconds: 0 }],
  ['string seconds', { seconds: '1794157200', nanoseconds: 0 }],
  ['nonfinite seconds', { seconds: Infinity, nanoseconds: 0 }],
  ['negative nanoseconds', { seconds: 1794157200, nanoseconds: -1 }],
  ['fractional nanoseconds', { seconds: 1794157200, nanoseconds: 0.5 }],
  ['overflow nanoseconds', { seconds: 1794157200, nanoseconds: 1000000000 }],
  ['string nanoseconds', { seconds: 1794157200, nanoseconds: '0' }],
  ['nonfinite nanoseconds', { seconds: 1794157200, nanoseconds: NaN }],
]) {
  test(`observed timestamp rejects ${name} rather than guessing a representation`, async () => {
    const snapshot = hekaSnapshot();
    snapshot.guides[0].ultima_actualizacion = clone(value);
    await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
  });
}

test('header timestamp validates its own structure before accepting a complete package', async () => {
  const snapshot = hekaSnapshot();
  snapshot.packages[0].header.fecha = { seconds: 0, nanoseconds: 1000000000 };
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
});

for (const [name, value] of [
  ['an ISO instant', '2026-11-08T15:00:00.000Z'],
  ['an invalid calendar day', '2026-02-30'],
  ['an unpadded day', '2026-11-8'],
  ['a timestamp object', { seconds: 1794150000, nanoseconds: 0 }],
  ['a numeric timestamp', 1794150000000],
  ['an empty string', ''],
]) {
  test(`payment observation rejects ${name} without supplying an invented time`, async () => {
    const snapshot = hekaSnapshot();
    snapshot.packages[0].lines[0].fechaPago = clone(value);
    await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
  });
}

test('an invalid pending payment observation is not silently discarded as missing', async () => {
  const snapshot = hekaSnapshot();
  snapshot.pending.lines[0].fechaPago = '2026-11-08T15:00:00.000Z';
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
});

test('valid paid observation on a different day from FECHA invalidates the package', async () => {
  const snapshot = hekaSnapshot();
  snapshot.packages[0].lines[0].fechaPago = '2026-11-09';
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('incomplete'));
});

test('complete package FECHA must be unanimous even when all optional payment observations are absent', async () => {
  const snapshot = hekaSnapshot();
  for (const line of snapshot.packages[0].lines) line.fechaPago = null;
  snapshot.packages[0].lines[1].FECHA = '07-11-2026';
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('incomplete'));
});

test('plain component objects produce the same observations as native SDK Timestamp instances', async () => {
  const fixture = createHekaSdkFixture({ onGet() {
    return { mutate(snapshot) {
      for (const doc of snapshot.docs ?? [snapshot]) {
        if (typeof doc.data !== 'function') continue;
        const original = doc.data;
        doc.data = () => {
          const data = original();
          for (const key of ['ultima_actualizacion', 'fecha']) {
            if (data[key] && typeof data[key] === 'object') data[key] = { seconds: data[key].seconds, nanoseconds: data[key].nanoseconds };
          }
          return data;
        };
      }
    } };
  } });
  const result = normalizeHekaSnapshot(await read(fixture));
  assert.deepEqual(sameWithoutCaptureTime(result), normalizeHekaSnapshot(fixture.snapshot));
});

for (const value of ['8-11-2026', '31-02-2026', '2026-11-08']) {
  test(`paid FECHA rejects ${value} instead of deriving its day from another observation`, async () => {
    const snapshot = hekaSnapshot();
    snapshot.packages[0].lines[0].FECHA = value;
    await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
  });
}

test('zero net, signed decimals and repeated tracking adjustments survive exact reconciliation', async () => {
  const snapshot = hekaSnapshot();
  const pkg = snapshot.packages[0];
  Object.assign(pkg.lines[0], { RECAUDO: '0.30', 'ENVÍO TOTAL': '0.20', 'TOTAL A PAGAR': '0.10', 'COMISION HEKA': '0.01' });
  Object.assign(pkg.lines[1], { RECAUDO: '0', 'ENVÍO TOTAL': '0.10', 'TOTAL A PAGAR': '-0.10', 'COMISION HEKA': '0.01' });
  Object.assign(pkg.lines[2], { RECAUDO: '0.10', 'ENVÍO TOTAL': '0.10', 'TOTAL A PAGAR': '0', 'COMISION HEKA': '0.01' });
  Object.assign(pkg.header, { total_pagado: '0', comision_heka: '0.03' });
  const result = normalizeHekaSnapshot(await read(createHekaSdkFixture({ snapshot })));
  assert.equal(result.packages[0].netMinor, 0);
  assert.equal(result.packages[0].commissionMinor, 3);
  assert.deepEqual(result.packages[0].lines.map(line => line.netMinor), [10, -10, 0]);
});

test('provider-only customer, bank, receipt and token fields never enter the wire snapshot', async () => {
  const fixture = createHekaSdkFixture();
  for (const data of fixture.documents.values()) Object.assign(data, { nombreD: 'synthetic-private-marker', direccionD: 'synthetic-private-marker', comprobante_bancario: 'synthetic-private-marker', accessToken: 'synthetic-private-marker', datos_bancarios: { synthetic: 'synthetic-private-marker' } });
  const raw = await read(fixture);
  assert.equal(JSON.stringify(raw).includes('synthetic-private-marker'), false);
  assert.deepEqual(await getHekaIdentity(fixture.webContents), fixture.account);
  assert.doesNotThrow(() => normalizeHekaSnapshot(raw));
});

for (const field of ['id_user', 'centro_de_costo']) {
  test(`package owner mismatch on ${field} fails closed`, async () => {
    const snapshot = hekaSnapshot();
    snapshot.packages[0].header[field] = 'other-synthetic-owner';
    await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('account_mismatch'));
  });
}

test('pinned account mismatch prevents the first provider query', async () => {
  const fixture = createHekaSdkFixture();
  fixture.account = { ...fixture.account, centerCost: 'other-synthetic-center' };
  await assert.rejects(read(fixture), code('account_mismatch'));
  assert.equal(fixture.reads.length, 0);
});

for (const moment of ['first query', 'final query']) {
  test(`identity changes during ${moment} cannot return a successful capture`, async () => {
    const fixture = createHekaSdkFixture({ onGet({ record, context }) {
      if (moment === 'first query' || record.path === 'pendientePorPagar') context.localStorage.user_id = 'different-synthetic-user';
    } });
    await assert.rejects(read(fixture), code('account_mismatch'));
    if (moment === 'first query') assert.equal(fixture.reads.length, 1);
  });
}

for (const field of ['total_pagado', 'guiasPagadas', 'cantidad_pagos']) {
  test(`header ${field} change during capture invalidates the entire result`, async () => {
    const fixture = createHekaSdkFixture({ onGet({ record, documents }) {
      if (record.kind === 'document' && record.count === 2) {
        const header = documents.get(record.path);
        if (field === 'guiasPagadas') header[field].reverse();
        else header[field] = field === 'cantidad_pagos' ? 43 : '70.26';
      }
    } });
    await assert.rejects(read(fixture), code('incomplete'));
  });
}

test('even a changed raw header representation is detected on reread', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record, documents }) {
    if (record.kind === 'document' && record.count === 2) documents.get(record.path).comision_heka = 3;
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});

test('a header nanosecond change within the same millisecond invalidates the complete capture', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record, documents }) {
    if (record.kind === 'document' && record.count === 2) documents.get(record.path).fecha.nanoseconds += 1;
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});

for (const kind of ['query', 'document', 'query document']) {
  for (const property of ['fromCache', 'hasPendingWrites']) {
    test(`${kind} metadata ${property} forbids partial/cache success`, async () => {
      const fixture = createHekaSdkFixture({ onGet({ record }) {
        if (kind === 'document' ? record.kind !== 'document' : record.kind !== 'query') return;
        return { mutate(snapshot) {
          const target = kind === 'query document' ? snapshot.docs[0] : snapshot;
          if (target) target.metadata[property] = true;
        } };
      } });
      await assert.rejects(read(fixture), code('incomplete'));
    });
  }
}

test('missing server metadata is not assumed to be server data', async () => {
  const fixture = createHekaSdkFixture({ onGet: () => ({ mutate(snapshot) { delete snapshot.metadata; } }) });
  await assert.rejects(read(fixture), code('incomplete'));
});

test('a partial query response with inconsistent document count is rejected', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record }) {
    if (record.kind === 'query') return { mutate(snapshot) { snapshot.size++; } };
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});

test('account center changes after the final wallet read invalidate the capture', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record, context }) {
    if (record.path === 'pendientePorPagar') context.datos_usuario.centro_de_costo = 'different-synthetic-center';
  } });
  await assert.rejects(read(fixture), code('account_mismatch'));
});

test('a server row with the wrong account is not trusted merely because the query was scoped', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record }) {
    if (record.path !== paidPath('SERVIENTREGA')) return;
    return { mutate(snapshot) {
      if (!snapshot.docs.length) return;
      const original = snapshot.docs[0].data;
      snapshot.docs[0].data = () => ({ ...original(), REMITENTE: 'different-synthetic-center' });
    } };
  } });
  await assert.rejects(read(fixture), code('account_mismatch'));
});

test('paid and pending SDK identities cannot overlap in an accepted wire result', async () => {
  const snapshot = hekaSnapshot();
  Object.assign(snapshot.pending.lines[0], { documentId: '000001 ', carrierCollection: 'SERVIENTREGA', TRANSPORTADORA: 'SERVIENTREGA' });
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('incomplete'));
});

test('safe individual decimals cannot overflow the server aggregate minor-unit contract', async () => {
  const snapshot = hekaSnapshot();
  for (const line of snapshot.packages[0].lines) Object.assign(line, { RECAUDO: '45035996273704.96', 'ENVÍO TOTAL': '45035996273704.96', 'TOTAL A PAGAR': '0', 'COMISION HEKA': '0' });
  Object.assign(snapshot.packages[0].header, { total_pagado: '0', comision_heka: '0' });
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('incomplete'));
});

test('missing package header fails instead of yielding an empty or partial package', async () => {
  const fixture = createHekaSdkFixture();
  fixture.documents.delete(`paquetePagos/${fixture.snapshot.packages[0].idPaquetePago}`);
  await assert.rejects(read(fixture), code('incomplete'));
});

test('a package header disappearing on reread fails', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record, documents }) {
    if (record.kind === 'document' && record.count === 2) documents.delete(record.path);
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});

test('a missing paid line fails the declared tracking multiset, including repeated tracking', async () => {
  const fixture = createHekaSdkFixture();
  fixture.documents.delete('pagos/SERVIENTREGA/pagos/000002');
  await assert.rejects(read(fixture), code('incomplete'));
});

test('a discovered line disappearing even with an edited header cannot silently disappear', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record, documents }) {
    if (record.kind === 'document' && record.count === 1) {
      documents.delete('pagos/SERVIENTREGA/pagos/000001 ');
      const header = documents.get(record.path);
      header.guiasPagadas.shift();
      header.total_pagado = '-20.00';
      header.comision_heka = '2.00';
    }
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});

test('failure of any carrier in complete-package traversal fails the whole capture', async () => {
  const fixture = createHekaSdkFixture({ onGet({ record }) {
    if (record.path === paidPath('HEKA') && packageFilter(record)) return { error: Object.assign(new Error('synthetic provider detail must not escape'), { code: 'unavailable' }) };
  } });
  await assert.rejects(read(fixture), code('provider_error'));
});

test('permission expiry becomes login_required without exposing the SDK error', async () => {
  const fixture = createHekaSdkFixture({ onGet: () => ({ error: Object.assign(new Error('synthetic sensitive error'), { code: 'permission-denied' }) }) });
  await assert.rejects(read(fixture), code('login_required'));
});

for (const mutation of ['line net', 'header net', 'commission', 'paid date', 'tracking count']) {
  test(`inconsistent ${mutation} is rejected without compensating or fabricating data`, async () => {
    const snapshot = hekaSnapshot();
    const pkg = snapshot.packages[0];
    if (mutation === 'line net') pkg.lines[0]['TOTAL A PAGAR'] = '90.24';
    if (mutation === 'header net') pkg.header.total_pagado = '70.24';
    if (mutation === 'commission') pkg.header.comision_heka = '2.99';
    if (mutation === 'paid date') pkg.lines[1].FECHA = '07-11-2026';
    if (mutation === 'tracking count') pkg.header.guiasPagadas.pop();
    await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('incomplete'));
  });
}

test('changed line schema or locale money fails closed rather than guessing separators', async () => {
  const snapshot = hekaSnapshot();
  snapshot.packages[0].lines[0].RECAUDO = '100,25';
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
});

test('changed guide identifiers are not invented or converted from numbers', async () => {
  const snapshot = hekaSnapshot();
  snapshot.guides[0].id_heka = 123;
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('contract_changed'));
});

test('an empty server result is valid but is not substituted for any failed read', async () => {
  const result = normalizeHekaSnapshot(await read(createHekaSdkFixture({ snapshot: emptySnapshot() })));
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.packages, []);
});

test('more than 10000 rows fails, never returns a truncated success', async () => {
  const snapshot = emptySnapshot();
  snapshot.guides = repeatedGuides(10001);
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('limit_exceeded'));
});

test('the row limit is combined across guide, paid and pending sections', async () => {
  const snapshot = hekaSnapshot();
  snapshot.guides = repeatedGuides(9997);
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('limit_exceeded'));
});

test('the 10 MiB limit measures UTF-8 bytes rather than characters', async () => {
  const snapshot = emptySnapshot();
  snapshot.guides = repeatedGuides(1800).map(guide => ({ ...guide, id_heka: '界'.repeat(256), numeroGuia: '界'.repeat(256), transportadora: '界'.repeat(256), estado: '界'.repeat(256), estadoTransportadora: '界'.repeat(256), referencia: '界'.repeat(1000), fecha: '界'.repeat(256), type: '界'.repeat(256) }));
  await assert.rejects(read(createHekaSdkFixture({ snapshot })), code('limit_exceeded'));
});

test('31-day ranges are accepted, 32-day ranges fail before queries', async () => {
  const fixture = createHekaSdkFixture({ snapshot: emptySnapshot() });
  fixture.query = { ...fixture.query, from: '2026-10-10', to: '2026-11-09' };
  assert.equal((await read(fixture)).query.from, '2026-10-10');
  const invalid = createHekaSdkFixture({ snapshot: emptySnapshot() });
  invalid.query = { ...invalid.query, from: '2026-10-09', to: '2026-11-09' };
  await assert.rejects(read(invalid), code('limit_exceeded'));
  assert.equal(invalid.reads.length, 0);
});

test('invalid calendar dates are not normalized into an adjacent month', async () => {
  const fixture = createHekaSdkFixture();
  fixture.query.from = '2026-02-30';
  await assert.rejects(read(fixture), code('contract_changed'));
  assert.equal(fixture.reads.length, 0);
});

test('arbitrary job properties are not accepted as script, URL or file work', async () => {
  const fixture = createHekaSdkFixture();
  fixture.query.script = 'throw new Error("not executed")';
  await assert.rejects(read(fixture), code('contract_changed'));
  assert.equal(fixture.reads.length, 0);
});

for (const [name, options, expected] of [
  ['official login', { location: { origin: 'https://www.hekaentrega.co', pathname: '/ingreso' } }, 'login_required'],
  ['modern portal', { location: { pathname: '/plataforma.html' } }, 'contract_changed'],
  ['foreign host', { location: { origin: 'https://synthetic.example' } }, 'contract_changed'],
  ['unsupported SDK', { sdkVersion: '9.0.0' }, 'contract_changed'],
  ['challenge', { location: { pathname: '/challenge' } }, 'challenge_required'],
]) {
  test(`${name} blocks reads with ${expected}`, async () => {
    const fixture = createHekaSdkFixture(options);
    await assert.rejects(read(fixture), code(expected));
    assert.equal(fixture.reads.length, 0);
  });
}

test('visible challenge in the classic page blocks identity and data reads', async () => {
  const fixture = createHekaSdkFixture();
  fixture.context.document.querySelectorAll = () => [{ getClientRects: () => [{}] }];
  await assert.rejects(getHekaIdentity(fixture.webContents), code('challenge_required'));
  assert.equal(fixture.reads.length, 0);
});

test('missing session identity requires login without reading unrelated storage', async () => {
  const fixture = createHekaSdkFixture();
  fixture.context.datos_usuario.centro_de_costo = '';
  await assert.rejects(getHekaIdentity(fixture.webContents), code('login_required'));
  assert.equal(fixture.reads.length, 0);
});

test('expired deadline and an already-aborted signal prevent page execution', async () => {
  const fixture = createHekaSdkFixture();
  await assert.rejects(captureHeka(fixture.webContents, { query: fixture.query, account: fixture.account, deadline: Date.now() - 1 }), code('timeout'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureHeka(fixture.webContents, { query: fixture.query, account: fixture.account, signal: controller.signal }), code('timeout'));
  assert.equal(fixture.executions.length, 0);
});

test('deadline is rechecked after each server response and before any next query', async () => {
  let expire;
  const fixture = createHekaSdkFixture({ onGet() { expire(); } });
  const nativeNow = fixture.context.Date.now;
  let now = nativeNow();
  // Give this page its own Date subclass rather than changing the process clock.
  fixture.context.Date = class extends Date { static now() { return now; } };
  expire = () => { now += 1000; };
  await assert.rejects(captureHeka(fixture.webContents, { query: fixture.query, account: fixture.account, deadline: now + 500 }), code('timeout'));
  assert.equal(fixture.reads.length, 1);
});

test('abort during an outstanding SDK read prevents all subsequent queries', async () => {
  const controller = new AbortController();
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const fixture = createHekaSdkFixture({ async onGet() { reached(); await blocked; } });
  const result = captureHeka(fixture.webContents, { query: fixture.query, account: fixture.account, signal: controller.signal });
  const rejection = assert.rejects(result, code('timeout'));
  await entered;
  controller.abort();
  await rejection;
  release();
  // Drain the resumed provider read; do not depend on wall-clock sleep.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.reads.length, 1);
  assert.equal(fixture.context.__selleneitorHekaReads, undefined);
});

test('overlapping/duplicate cursor pages fail instead of counting or silently truncating a moving result', async () => {
  const snapshot = emptySnapshot();
  snapshot.guides = repeatedGuides(501);
  let saved;
  const fixture = createHekaSdkFixture({ snapshot, onGet({ record }) {
    if (record.path !== fixture.guidePath) return;
    return { mutate(response) {
      if (!record.cursor) saved = response.docs[0];
      else { response.docs.push(saved); response.size++; }
    } };
  } });
  await assert.rejects(read(fixture), code('incomplete'));
});
