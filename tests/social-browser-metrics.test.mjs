import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseBrowserMetricExport, normalizeBrowserMetricTable } from '../lib/social/browser-metrics.mjs';

const format = { decimalSeparator: '.', groupSeparator: ',' };
const query = { periodStart: '2026-10-01', periodEnd: '2026-10-31', dimension: 'aggregate' };
const headers = ['Campaign ID', 'Reporting starts', 'Reporting ends', 'Amount spent', 'Reach', 'Comments'];
const row = ['9001', '2026-10-01', '2026-10-31', '100,000.25', '3,000', '0'];
const options = { filename: 'performance.csv', locale: 'en', expectedScope: 'paid', numberFormat: format, expectedRemoteId: '9001', query };
const csv = (rows, separator = ',') => Buffer.from('\uFEFF' + rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(separator)).join('\r\n'));
function workbook(rows, change) {
  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet(rows);
  change?.(sheet); XLSX.utils.book_append_sheet(book, sheet, 'Performance');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
}
const reason = expected => error => error.reason === expected;

test('CSV UTF8 con BOM, comillas, saltos y separadores explícitos conserva dinero exacto y excluye datos de personas', async () => {
  const columns = [...headers, 'Customer name', 'Comment text', 'Results'];
  const values = [...row, 'Private, "person"', 'Private\ncomment', '55'];
  const parsed = await parseBrowserMetricExport(csv([columns, values]), options);
  assert.equal(parsed.rows[0].values.spendMinor.value, 10000025);
  assert.equal(parsed.rows[0].values.comments.value, 0);
  assert.equal(parsed.rows[0].values.comments.status, 'reported');
  assert.deepEqual(parsed.columns, headers);
  assert.equal(JSON.stringify(parsed).includes('Private'), false);
  assert.equal(Object.hasOwn(parsed.rows[0].values, 'conversations'), false);
  const esRow = [...row]; esRow[3] = '100.000,25'; esRow[4] = '3.000';
  const spanish = await parseBrowserMetricExport(csv([headers, esRow], ';'), { ...options, locale: 'es', numberFormat: { decimalSeparator: ',', groupSeparator: '.' } });
  assert.equal(spanish.rows[0].values.spendMinor.value, 10000025);
  assert.equal(spanish.rows[0].values.reach.value, 3000);
});

test('ausencia, cero, formatos no comprobados y contadores redondeados son distintos', async () => {
  const rounded = [...row]; rounded[4] = '1,2 mil'; rounded[5] = '—'; rounded[3] = '0';
  const parsed = await parseBrowserMetricExport(csv([headers, rounded], ';'), { ...options, locale: 'es', numberFormat: { decimalSeparator: ',', groupSeparator: '.' } });
  assert.deepEqual(parsed.rows[0].values.reach, { value: 1200, unit: 'count', sourceMetric: 'Reach', status: 'estimated', precision: 'rounded', displayValue: '1,2 mil', reason: null });
  assert.equal(parsed.rows[0].values.comments.value, null);
  assert.equal(parsed.rows[0].values.spendMinor.value, 0);
  const unknown = await parseBrowserMetricExport(csv([headers, row]), { ...options, numberFormat: null });
  assert.equal(unknown.rows[0].values.spendMinor.value, null);
  assert.equal(unknown.rows[0].values.spendMinor.displayValue, '100,000.25');
  assert.equal(unknown.rows[0].values.reach.reason, 'number_format_unverified');
  const ambiguous = [...row]; ambiguous[3] = '1,234';
  await assert.rejects(parseBrowserMetricExport(csv([headers, ambiguous], ';'), { ...options, numberFormat: { decimalSeparator: ',', groupSeparator: '.' } }), reason('ambiguous_money'));
});

test('XLSX protegido conserva números intrínsecos sin idioma, decimales de conteos y rechaza fórmula o ID sin precisión', async () => {
  const numeric = [...row]; numeric[3] = 100000.25; numeric[4] = 3000.125;
  const parsed = await parseBrowserMetricExport(workbook([headers, numeric]), { ...options, filename: 'performance.xlsx', numberFormat: null });
  assert.equal(parsed.rows[0].values.spendMinor.value, 10000025);
  assert.equal(parsed.rows[0].values.reach.value, 3000.125);
  assert.equal(parsed.rows[0].values.reach.precision, 'exact');
  await assert.rejects(parseBrowserMetricExport(workbook([headers, numeric], sheet => { sheet.D2 = { t: 'n', v: 10, f: '5+5' }; }), { ...options, filename: 'performance.xlsx' }), reason('mapped_formula'));
  await assert.rejects(parseBrowserMetricExport(workbook([headers, numeric], sheet => { sheet.A2 = { t: 'n', v: 9007199254740992 }; }), { ...options, filename: 'performance.xlsx' }), reason('identifier_precision_lost'));
  const foreign = [...row]; foreign[0] = '9002';
  await assert.rejects(parseBrowserMetricExport(csv([headers, foreign]), options), reason('foreign_remote_id'));
  const formula = [...row]; formula[3] = '=SUM(1,2)';
  await assert.rejects(parseBrowserMetricExport(csv([headers, formula]), options), reason('mapped_formula'));
  const additional = await parseBrowserMetricExport(workbook([[...headers, 'Ad ID', 'Private column'], [...numeric, '9007199254740993', 'not retained']], sheet => { sheet.H2 = { t: 'n', v: 1, f: '1+0' }; }), { ...options, filename: 'performance.xlsx' });
  assert.equal(additional.rows[0].id, '9001');
  assert.equal(additional.rows[0].values.spendMinor.value, 10000025);
  assert.equal(JSON.stringify(additional).includes('not retained'), false);
});

test('períodos, agregado ambiguo, dimensiones independientes y alcance mixto no se agregan', async () => {
  const period = [...row]; period[1] = '2026-09-01';
  await assert.rejects(parseBrowserMetricExport(csv([headers, period]), options), reason('reporting_period_mismatch'));
  await assert.rejects(parseBrowserMetricExport(csv([headers, row, row]), options), reason('duplicate_reporting_row'));
  const columns = [...headers, 'Publisher platform', 'Placement', 'Metric scope'];
  const first = [...row, 'facebook', 'feed', 'Mixed'], second = [...row, 'instagram', 'reels', 'Mixed'];
  const parsed = await parseBrowserMetricExport(csv([columns, first, second]), { ...options, expectedScope: 'organic', query: { ...query, dimension: 'placement' } });
  assert.equal(parsed.scope, 'mixed');
  assert.deepEqual(parsed.rows.map(row => row.values.reach.value), [3000, 3000]);
  assert.deepEqual(parsed.rows.map(row => row.dimensions.placement), ['feed', 'reels']);
  await assert.rejects(parseBrowserMetricExport(csv([headers, row]), { ...options, query: { ...query, dimension: 'country' } }), reason('missing_dimension'));
});

test('límites reales de bytes, filas, columnas y encoding fallan sin truncar', async () => {
  await assert.rejects(parseBrowserMetricExport(Buffer.alloc(10 * 1024 * 1024 + 1), options), reason('export_byte_limit'));
  await assert.rejects(parseBrowserMetricExport(Buffer.from([0xff, 0xfe, 0x00, 0x43]), options), reason('export_utf8_required'));
  const columns = [...headers, ...Array.from({ length: 195 }, (_, index) => `Other ${index}`)];
  await assert.rejects(parseBrowserMetricExport(csv([columns, row]), options), reason('export_content_limit'));
  const many = [headers.join(','), ...Array.from({ length: 100001 }, () => '9001,2026-10-01,2026-10-31,0,0,0')].join('\n');
  await assert.rejects(parseBrowserMetricExport(Buffer.from(many), options), reason('export_content_limit'));
  const sheetRows = Array.from({ length: 10000 }, (_, index) => {
    const day = new Date(Date.UTC(1990, 0, 1 + index)).toISOString().slice(0, 10);
    return ['9001', day, day, 0, index, 0];
  });
  const parsed = await parseBrowserMetricExport(workbook([headers, ...sheetRows]), { ...options, filename: 'performance.xlsx', query: null });
  assert.equal(parsed.rows.length, 10000);
});

test('las tablas conservan fracciones de conteos y rechazan columnas dimensionales incompletas', () => {
  const parsed = normalizeBrowserMetricTable({ columns: headers, rows: [[...row.slice(0, 4), '1.2345', '']], locale: 'en', numberFormat: format, expectedRemoteId: '9001', query });
  assert.equal(parsed.rows[0].values.reach.value, 1.2345);
  assert.equal(parsed.rows[0].values.comments.value, null);
});
