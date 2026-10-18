import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { readExcel, normalizeExcelIdentifier, normalizeExcelMoney, normalizeExcelDate, writeExcelSheets } from '../lib/business/excel.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const cell = (value, extra = {}) => ({ type: typeof value === 'number' ? 'n' : 's', value, text: String(value ?? ''), formula: null, hasCachedValue: value !== null, ...extra });
function book(rows, { type = 'xlsx', sheetName = 'Pedidos', date1904 = false, edit } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  workbook.Workbook = { WBProps: { date1904 } };
  edit?.(workbook, workbook.Sheets[sheetName]);
  return XLSX.write(workbook, { type: 'buffer', bookType: type, compression: true });
}

for (const type of ['xlsx', 'xls', 'xlsb', 'xlsm']) {
  test(`${type}: preserves recipient, guide, exact freight and noninitial duplicate headers`, async () => {
    const bytes = book([
      ['Exportación sintética; no corresponde a encabezados verificados de HeKa'],
      ['Pedido', 'Guía', 'Valor', 'Valor', 'Cliente'],
      ['AN-0042', '0000123456789', '15.000,25', 2, 'Cliente de prueba'],
      [],
      ['AN-0043', '0000000000002', '0', 1, 'Otra persona'],
    ], { type });
    const parsed = await readExcel(bytes, { filename: `pedidos.${type}`, headerRow: 2, sheetName: 'Pedidos' });
    assert.equal(parsed.headerRow, 2);
    assert.equal(parsed.sheetName, 'Pedidos');
    assert.equal(parsed.rows.find(row => row.rowNumber === 2).cells[2].value, 'Valor');
    assert.equal(parsed.rows.find(row => row.rowNumber === 2).cells[3].value, 'Valor');
    const order = parsed.rows.find(row => row.rowNumber === 3).cells;
    assert.equal(normalizeExcelIdentifier(order[1], 'Guía'), '0000123456789');
    assert.equal(normalizeExcelMoney(order[2], { decimalSeparator: ',', groupSeparator: '.' }), 1500025);
    assert.equal(order[4].value, 'Cliente de prueba');
    assert.equal(parsed.rows.find(row => row.rowNumber === 5).cells[0].value, 'AN-0043');
    assert.equal(parsed.sheets[0].columnCount, 5);
    await assert.rejects(readExcel(bytes, { filename: `pedidos.${type}`, sheetName: 'No existe' }), { code: 'EXCEL_SHEET' });
  });
}

test('dimensionless worksheets retain real dimensions and noninitial headers during inspection and preview', async () => {
  const data = [['Exportación sintética'], ['Guía','Estado','Estado','Costo'], ...Array.from({length:40},(_,index)=>[`000${index}`,'Tránsito','Observación','15.000'])];
  const entries = unzipSync(book(data));
  entries['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(entries['xl/worksheets/sheet1.xml']).replace(/<dimension\b[^>]*\/>/g,''));
  const bytes = Buffer.from(zipSync(entries));
  const metadata = XLSX.read(bytes,{type:'buffer',sheetRows:1}).Sheets.Pedidos;
  assert.equal(metadata['!ref'],'A1');
  assert.equal(metadata['!fullref'],undefined);
  for (const mode of ['inspect','rows']) {
    const parsed = await readExcel(bytes,{filename:'sin-dimensiones.xlsx',sheetName:'Pedidos',headerRow:2,mode});
    assert.deepEqual(parsed.sheets,[{name:'Pedidos',rowCount:42,columnCount:4}]);
    assert.deepEqual(parsed.rows.find(row=>row.rowNumber===2).cells.map(cell=>cell.value),['Guía','Estado','Estado','Costo']);
    if(mode==='inspect')assert.equal(parsed.rows[0].rowNumber,2);
    assert.equal(parsed.rows.length,mode==='inspect'?21:42);
    if(mode==='rows')assert.equal(parsed.rows.at(-1).rowNumber,42);
  }
});

test('blank and absent header rows are configuration errors rather than empty inspections', async () => {
  const bytes = book([['Portada'],[],['Guía'],['0001']]);
  for (const mode of ['inspect','rows']) {
    await assert.rejects(readExcel(bytes,{filename:'encabezados.xlsx',headerRow:2,mode}),{code:'EXCEL_HEADER'});
    await assert.rejects(readExcel(bytes,{filename:'encabezados.xlsx',headerRow:5,mode}),{code:'EXCEL_HEADER'});
  }
});

test('column order stays positional and ignored empty cells stay null', async () => {
  const result = await readExcel(book([['Guía', 'Pedido', 'Vacío', 'Cliente'], ['0001', 'AN-7', null, 'Persona']]), { filename: 'orden.xlsx' });
  assert.deepEqual(result.rows[0].cells.map(item => item.value), ['Guía', 'Pedido', 'Vacío', 'Cliente']);
  assert.equal(result.rows[1].cells[2].value, null);
  assert.equal(normalizeExcelMoney(result.rows[1].cells[2]), null);
});

test('formatted numeric identifiers preserve explicit zeros but unsafe or scientific identifiers fail', async () => {
  const result = await readExcel(book([['Guía'], [12345]], { edit: (_, sheet) => { sheet.A2.z = '0000000000000'; } }), { filename: 'ceros.xlsx' });
  assert.equal(normalizeExcelIdentifier(result.rows[1].cells[0]), '0000000012345');
  assert.throws(() => normalizeExcelIdentifier(cell(9007199254740992)), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.throws(() => normalizeExcelIdentifier(cell(123456789012, { text: '1.23457E+11' })), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.throws(() => normalizeExcelIdentifier(cell('1E+18')), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.equal(normalizeExcelIdentifier(cell('aB-000123')), 'aB-000123');
});

test('money is exact, never silently rounds, and distinguishes null from zero', () => {
  const format = { decimalSeparator: ',', groupSeparator: '.' };
  assert.equal(normalizeExcelMoney(cell('122.000,01'), format), 12200001);
  assert.equal(normalizeExcelMoney(cell('0'), format), 0);
  assert.equal(normalizeExcelMoney(cell(null), format), null);
  assert.equal(normalizeExcelMoney(cell(17.25), format), 1725);
  assert.equal(normalizeExcelMoney(cell('-2.750,00'), format), -275000);
  assert.equal(normalizeExcelMoney(cell('122,000.01'), { decimalSeparator: '.', groupSeparator: ',' }), 12200001);
  for (const value of ['1,001', '1.22,00', '1e5', 'COP 15.000']) assert.throws(() => normalizeExcelMoney(cell(value), format), { code: 'EXCEL_MONEY' });
  assert.throws(() => normalizeExcelMoney(cell(1.001)), { code: 'EXCEL_MONEY' });
});

test('dates use the real 1900/1904 epochs, reject false leap day, and keep day precision', async () => {
  assert.deepEqual(normalizeExcelDate(cell(1)), { occurredOn: '1900-01-01', occurredAt: null, precision: 'day' });
  assert.equal(normalizeExcelDate(cell(59)).occurredOn, '1900-02-28');
  assert.equal(normalizeExcelDate(cell(61)).occurredOn, '1900-03-01');
  assert.throws(() => normalizeExcelDate(cell(60)), { code: 'EXCEL_DATE' });
  assert.throws(() => normalizeExcelDate(cell(60.5)), { code: 'EXCEL_DATE' });
  assert.equal(normalizeExcelDate(cell(0), { date1904: true }).occurredOn, '1904-01-01');
  assert.deepEqual(normalizeExcelDate(cell(1.5)), { occurredOn: '1900-01-01', occurredAt: '1900-01-01T17:00:00.000Z', precision: 'instant' });
  const bytes = book([['Fecha'], [0]], { date1904: true, edit: (_, sheet) => { sheet.A2.z = 'yyyy-mm-dd'; } });
  const result = await readExcel(bytes, { filename: 'epoch.xlsx' });
  assert.equal(result.date1904, true);
  assert.equal(normalizeExcelDate(result.rows[1].cells[0], result).occurredOn, '1904-01-01');
});

test('explicit date formats and Bogotá boundaries never invent an upload date', () => {
  assert.deepEqual(normalizeExcelDate(cell('03/09/2026'), { dateFormat: 'DMY' }), { occurredOn: '2026-09-03', occurredAt: null, precision: 'day' });
  assert.equal(normalizeExcelDate(cell('03/09/2026'), { dateFormat: 'MDY' }).occurredOn, '2026-03-09');
  assert.equal(normalizeExcelDate(cell('2026-11-01T04:59:59Z')).occurredOn, '2026-10-31');
  assert.equal(normalizeExcelDate(cell('2026-11-01T05:00:00Z')).occurredOn, '2026-11-01');
  assert.equal(normalizeExcelDate(cell('03/09/2026 08:30'), { dateFormat: 'DMY' }).occurredAt, '2026-09-03T13:30:00.000Z');
  assert.equal(normalizeExcelDate(cell('')), null);
  for (const value of ['31/02/2026', '29/02/1900', '03/09/2026']) assert.throws(() => normalizeExcelDate(cell(value)), { code: 'EXCEL_DATE' });
  assert.throws(() => normalizeExcelDate(cell('2026-02-30')), { code: 'EXCEL_DATE' });
  assert.throws(() => normalizeExcelDate(cell('2026-01-01T25:00Z')), { code: 'EXCEL_DATE' });
});

test('formulas are never evaluated: cached values warn and missing required caches fail', async () => {
  const bytes = book([['Importe', 'Otro'], [122000, null]], { edit: (_, sheet) => {
    sheet.A2 = { t: 'n', v: 122000, f: '61000*2' };
    sheet.B2 = { t: 'z', f: 'SUM(1,2)' };
    sheet['!ref'] = 'A1:B2';
  } });
  const parsed = await readExcel(bytes, { filename: 'formulas.xlsx' });
  assert.ok(parsed.warnings.some(warning => warning.code === 'EXCEL_FORMULA_CACHED' && warning.row === 2 && warning.column === 1));
  assert.ok(parsed.warnings.some(warning => warning.code === 'EXCEL_FORMULA_NO_CACHE' && warning.row === 2 && warning.column === 2));
  const values = parsed.rows.find(row => row.rowNumber === 2).cells;
  assert.equal(normalizeExcelMoney(values[0]), 12200000);
  for (const normalize of [normalizeExcelMoney, normalizeExcelIdentifier, normalizeExcelDate]) assert.throws(() => normalize(values[1]), { code: 'EXCEL_FORMULA_NO_CACHE' });
});

test('inspection explicitly returns samples, while rows mode keeps the complete sheet', async () => {
  const bytes = book([['Pedido'], ...Array.from({ length: 35 }, (_, index) => [`AN-${index}`])]);
  const inspected = await readExcel(bytes, { filename: 'muestras.xlsx', mode: 'inspect' });
  assert.equal(inspected.samplesOnly, true);
  assert.equal(inspected.sampleLimit, 20);
  assert.equal(inspected.sheets[0].rowCount, 36);
  assert.equal(inspected.rows.filter(row => row.rowNumber > 1).length, 20);
  const complete = await readExcel(bytes, { filename: 'muestras.xlsx' });
  assert.equal(complete.rows.length, 36);
  assert.equal(complete.rows.at(-1).cells[0].value, 'AN-34');
  assert.equal(complete.samplesOnly, undefined);
});

test('duplicate rows are preserved for explicit business review, never silently deduplicated', async () => {
  const parsed = await readExcel(book([['Pedido', 'Producto', 'Cantidad'], ['AN-1', 'A', 2], ['AN-1', 'A', 2]]), { filename: 'duplicadas.xlsx' });
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[1].cells, parsed.rows[2].cells);
  assert.equal(parsed.rows[2].rowNumber, 3);
});

test('extension, signature, empty, oversized and truncated files fail actionably', async () => {
  const bytes = book([['Pedido'], ['AN-1']]);
  await assert.rejects(readExcel(bytes, { filename: 'tabla.csv' }), { status: 415 });
  await assert.rejects(readExcel(bytes, { filename: 'tabla.xls' }), { status: 415 });
  await assert.rejects(readExcel(book([['A']], { type: 'xls' }), { filename: 'tabla.xlsx' }), { status: 415 });
  await assert.rejects(readExcel(Buffer.from('not an Excel file'), { filename: 'tabla.xlsx' }), { status: 415 });
  await assert.rejects(readExcel(Buffer.alloc(0), { filename: 'tabla.xlsx' }), { status: 400 });
  await assert.rejects(readExcel(Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'tabla.xlsx' }), { code: 'EXCEL_FILE_LIMIT', status: 413 });
  await assert.rejects(readExcel(bytes.subarray(0, bytes.length - 15), { filename: 'tabla.xlsx' }), { code: 'EXCEL_INVALID', status: 400 });
  await assert.rejects(readExcel(bytes, { filename: 'tabla.xlsm' }), { status: 415 });
});

test('selected sheet dimensions and workbook sheet count are bounded before full parsing', async () => {
  for (const ref of ['A1:GS2', 'A1:A10001']) {
    const bytes = book([['Pedido']], { edit: (_, sheet) => { sheet['!ref'] = ref; } });
    await assert.rejects(readExcel(bytes, { filename: 'grande.xlsx' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  }
  const bytes = book([['A']], { edit: workbook => {
    for (let index = 1; index <= 20; index++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['B']]), `Hoja${index}`);
  } });
  await assert.rejects(readExcel(bytes, { filename: 'hojas.xlsx' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  await assert.rejects(readExcel(book([['A']]), { filename: 'fila.xlsx', headerRow: 2 }), { code: 'EXCEL_HEADER' });
});

test('a large unselected sheet does not truncate or replace the selected commercial sheet', async () => {
  const bytes = book([['Pedido'], ['AN-9']], { edit: workbook => {
    const other = XLSX.utils.aoa_to_sheet([['A']]);
    other['!ref'] = 'A1:A10001';
    XLSX.utils.book_append_sheet(workbook, other, 'Otra');
  } });
  const parsed = await readExcel(bytes, { filename: 'seleccion.xlsx', sheetName: 'Pedidos' });
  assert.equal(parsed.rows[1].cells[0].value, 'AN-9');
  assert.equal(parsed.sheets.find(sheet => sheet.name === 'Otra').rowCount, 10001);
});

test('streaming ZIP validation counts actual output, not a lying uncompressed-size header', async () => {
  const bytes = Buffer.from(zipSync({ 'bomb.bin': new Uint8Array(33 * 1024 * 1024) }, { level: 9 }));
  // Lie in both local and central size headers. Emitted bytes must still stop at 32 MiB.
  bytes.writeUInt32LE(1, 22);
  const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bytes.writeUInt32LE(1, central + 24);
  await assert.rejects(readExcel(bytes, { filename: 'bomb.xlsx' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
});

test('streaming ZIP validation enforces aggregate output, entry count, compression and integrity', async () => {
  const contents = {};
  for (let index = 0; index < 5; index++) contents[`part${index}`] = new Uint8Array(26 * 1024 * 1024);
  await assert.rejects(readExcel(zipSync(contents, { level: 9 }), { filename: 'aggregate.xlsx' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  const entries = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`entry${index}`, new Uint8Array(0)]));
  await assert.rejects(readExcel(zipSync(entries), { filename: 'entries.xlsx' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  const unsupported = Buffer.from(zipSync({ 'test.txt': strToU8('test') }));
  unsupported.writeUInt16LE(99, 8);
  unsupported.writeUInt16LE(99, unsupported.indexOf(Buffer.from('504b0102', 'hex')) + 10);
  await assert.rejects(readExcel(unsupported, { filename: 'method.xlsx' }), { code: 'EXCEL_FORMAT', status: 415 });
  const damaged = Buffer.from(zipSync({ 'test.txt': strToU8('test') }, { level: 0 }));
  damaged[30 + Buffer.byteLength('test.txt')] ^= 1;
  await assert.rejects(readExcel(damaged, { filename: 'damaged.xlsx' }), { code: 'EXCEL_INVALID', status: 400, message: /CRC incorrecto/ });
  const protectedZip = Buffer.from(zipSync({ 'test.txt': strToU8('test') }));
  const central = protectedZip.indexOf(Buffer.from('504b0102', 'hex'));
  protectedZip.writeUInt16LE(protectedZip.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(readExcel(protectedZip, { filename: 'password.xlsx' }), { code: 'EXCEL_PROTECTED' });
});

test('compressed ZIP callback failures preserve integrity and metadata-limit errors', async () => {
  const compressed = Buffer.from(zipSync({ 'test.txt': strToU8('compressible text '.repeat(1000)) }, { level: 9 }));
  const central = compressed.indexOf(Buffer.from('504b0102', 'hex'));
  const wrongSize = Buffer.from(compressed);
  wrongSize.writeUInt32LE(1, 22);
  wrongSize.writeUInt32LE(1, central + 24);
  await assert.rejects(readExcel(wrongSize, { filename: 'size.xlsx' }), {
    code: 'EXCEL_INVALID', status: 400, message: /tamaño o CRC incorrecto/,
  });
  const wrongCrc = Buffer.from(compressed);
  wrongCrc.writeUInt32LE(0, 14);
  wrongCrc.writeUInt32LE(0, central + 16);
  await assert.rejects(readExcel(wrongCrc, { filename: 'crc.xlsx' }), {
    code: 'EXCEL_INVALID', status: 400, message: /tamaño o CRC incorrecto/,
  });
  const metadata = zipSync({ '[Content_Types].xml': new Uint8Array(1024 * 1024 + 1) }, { level: 9 });
  await assert.rejects(readExcel(metadata, { filename: 'metadata.xlsx' }), {
    code: 'EXCEL_CONTENT_LIMIT', status: 413, message: /metadatos/,
  });
});

test('exported external strings remain literal cells, null means Sin dato, numbers remain numeric', () => {
  const bytes = writeExcelSheets([{ name: 'Detalle', rows: [['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', null, 1500025, false]] }]);
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  const sheet = workbook.Sheets.Detalle;
  for (const address of ['A1', 'B1', 'C1', 'D1', 'E1']) {
    assert.equal(sheet[address].t, 's');
    assert.equal(sheet[address].f, undefined);
  }
  assert.equal(sheet.A1.v, '=1+1');
  assert.equal(sheet.E1.v, 'Sin dato');
  assert.equal(sheet.F1.v, 1500025);
  assert.equal(sheet.G1.v, false);
});
