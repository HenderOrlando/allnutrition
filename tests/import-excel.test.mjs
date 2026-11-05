import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { readExcel, expandExcelWorkbook, normalizeExcelIdentifier, normalizeExcelText, normalizeExcelMoney, normalizeExcelDate, writeExcelSheets } from '../lib/business/excel.mjs';
import { getImportColumnIssues, normalizeImportFieldName } from '../lib/schema.mjs';
import { validateImportConfig, decodeImportRevision } from '../lib/business/imports.mjs';
import { suggestSheetImport } from '../lib/business/import-presets.mjs';

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
    assert.deepEqual(parsed.rows.find(row=>row.rowNumber===2).cells.map(cell=>cell.value),['Guía','Estado','Estado','Costo']);
    if(mode==='inspect')assert.equal(parsed.rows[0].rowNumber,2);
    if(mode==='rows')assert.deepEqual(parsed.rows.filter(row=>row.rowNumber>2).map(row=>row.cells.map(cell=>cell.value)),data.slice(2));
  }
});

test('blank and absent header rows are configuration errors rather than empty inspections', async () => {
  const bytes = book([['Portada'],[],['Guía'],['0001']]);
  for (const mode of ['inspect','rows']) {
    await assert.rejects(readExcel(bytes, { filename: 'encabezados.xlsx', headerRow: 2, mode, sheetName: 'Pedidos' }),{code:'EXCEL_HEADER'});
    await assert.rejects(readExcel(bytes, { filename: 'encabezados.xlsx', headerRow: 5, mode, sheetName: 'Pedidos' }),{code:'EXCEL_HEADER'});
  }
});

test('column order stays positional and ignored empty cells stay null', async () => {
  const result = await readExcel(book([['Guía', 'Pedido', 'Vacío', 'Cliente'], ['0001', 'AN-7', null, 'Persona']]), { filename: 'orden.xlsx', sheetName: 'Pedidos' });
  assert.deepEqual(result.rows[0].cells.map(item => item.value), ['Guía', 'Pedido', 'Vacío', 'Cliente']);
  assert.equal(result.rows[1].cells[2].value, null);
  assert.equal(normalizeExcelMoney(result.rows[1].cells[2]), null);
});

test('formatted numeric identifiers preserve explicit zeros but unsafe or scientific identifiers fail', async () => {
  const result = await readExcel(book([['Guía'], [12345]], { edit: (_, sheet) => { sheet.A2.z = '0000000000000'; } }), { filename: 'ceros.xlsx', sheetName: 'Pedidos' });
  assert.equal(normalizeExcelIdentifier(result.rows[1].cells[0]), '0000000012345');
  assert.throws(() => normalizeExcelIdentifier(cell(9007199254740992)), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.throws(() => normalizeExcelIdentifier(cell(123456789012, { text: '1.23457E+11' })), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.throws(() => normalizeExcelIdentifier(cell('1E+18')), { code: 'EXCEL_IDENTIFIER_PRECISION' });
  assert.equal(normalizeExcelIdentifier(cell('aB-000123')), 'aB-000123');
});

test('informative text preserves displayed decimals, booleans, zeros and HTML without evaluating formulas', async () => {
  const bytes = book([['Decimal','Booleano','Código','Texto'],[12.5,true,'0000123','<b>información</b>']], {edit:(_,sheet)=>{sheet.A2.z='0.00';}});
  const parsed = await readExcel(bytes, { filename: 'informacion.xlsx', sheetName: 'Pedidos' });
  assert.deepEqual(parsed.rows[1].cells.map(value=>normalizeExcelText(value)),['12.50','TRUE','0000123','<b>información</b>']);
  assert.equal(normalizeExcelText(cell(false,{type:'b',text:'FALSE'})),'FALSE');
  assert.equal(normalizeExcelText(cell(null)),null);
  assert.equal(normalizeExcelText(cell('  ')),null);
  assert.equal(normalizeExcelText(cell(' texto con espacios ')),' texto con espacios ');
  assert.equal(normalizeExcelText(cell('resultado',{formula:'1+1',hasCachedValue:true})),'resultado');
  assert.throws(()=>normalizeExcelText(cell(null,{formula:'1+1',hasCachedValue:false})),{code:'EXCEL_FORMULA_NO_CACHE'});
});

test('text length boundaries reject incompatible destinations without silently truncating the original', () => {
  const original=cell('x'.repeat(4001));
  assert.equal(normalizeExcelText(cell('x'.repeat(4000))).length,4000);
  assert.throws(()=>normalizeExcelText(original,'Dato adicional',4000),{code:'EXCEL_TEXT_LIMIT',status:400});
  assert.equal(original.value.length,4001);
  assert.throws(()=>normalizeExcelText(cell('123456'),'Campo corto',5),{code:'EXCEL_TEXT_LIMIT'});
});

test('column configuration separates canonical destinations, product groups and normalized additional names', () => {
  const column=(index,destination,extra={})=>({index,header:'Extra',destination,group:0,...extra});
  assert.equal(normalizeImportFieldName('  ＣＥＮＴＲＯ \t de  Envío '),'centro de envío');
  const columns=[column(0,'additionalField',{fieldName:'Estado'}),column(1,'additionalField',{fieldName:'__proto__'}),column(2,'rawStatus')];
  assert.deepEqual(getImportColumnIssues(columns,'item_rows'),[]);
  assert.deepEqual(validateImportConfig({sheetName:'Datos',columns}).sheets[0].columns.map(value=>value.fieldName),['Estado','__proto__',undefined]);
  for(const [bad,code] of [
    [[column(0,'no-existe')],'IMPORT_COLUMN_DESTINATION'],
    [[column(0,'tracking'),column(1,'tracking')],'IMPORT_COLUMN_DUPLICATE'],
    [[column(0,'additionalField',{fieldName:'  '})],'IMPORT_ADDITIONAL_NAME'],
    [[column(0,'additionalField',{fieldName:' Centro  de envío '}),column(1,'additionalField',{fieldName:'ＣＥＮＴＲＯ de envío'})],'IMPORT_ADDITIONAL_DUPLICATE'],
    [[column(0,'additionalField',{fieldName:'Largo'.repeat(21)})],'IMPORT_ADDITIONAL_NAME'],
    [[column(0,'additionalField',{fieldName:'Nombre',group:1})],'IMPORT_COLUMN_DESTINATION']
  ]) assert.throws(()=>validateImportConfig({sheetName:'Datos',columns:bad}),{code,status:400});
  const products=[column(0,'quantity'),column(1,'quantity',{group:1})];
  assert.deepEqual(getImportColumnIssues(products,'order_rows'),[]);
  assert.equal(getImportColumnIssues(products,'item_rows')[0].code,'IMPORT_COLUMN_DESTINATION');
  assert.deepEqual(getImportColumnIssues([column(0,'tracking'),column(1,'tracking'),column(2,'tracking')])[0].indexes,[0,1,2]);
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
  const result = await readExcel(bytes, { filename: 'epoch.xlsx', sheetName: 'Pedidos' });
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
  const parsed = await readExcel(bytes, { filename: 'formulas.xlsx', sheetName: 'Pedidos' });
  assert.ok(parsed.warnings.some(warning => warning.code === 'EXCEL_FORMULA_CACHED' && warning.row === 2 && warning.column === 1));
  assert.ok(parsed.warnings.some(warning => warning.code === 'EXCEL_FORMULA_NO_CACHE' && warning.row === 2 && warning.column === 2));
  const values = parsed.rows.find(row => row.rowNumber === 2).cells;
  assert.equal(normalizeExcelMoney(values[0]), 12200000);
  for (const normalize of [normalizeExcelMoney, normalizeExcelIdentifier, normalizeExcelDate]) assert.throws(() => normalize(values[1]), { code: 'EXCEL_FORMULA_NO_CACHE' });
});

test('inspection explicitly returns samples, while rows mode keeps the complete sheet', async () => {
  const bytes = book([['Pedido'], ...Array.from({ length: 35 }, (_, index) => [`AN-${index}`])]);
  const inspected = await readExcel(bytes, { filename: 'muestras.xlsx', mode: 'inspect', sheetName: 'Pedidos' });
  assert.equal(inspected.samplesOnly, true);
  assert.equal(inspected.sampleLimit, 20);
  assert.equal(inspected.sheets[0].rowCount, 36);
  assert.equal(inspected.rows.filter(row => row.rowNumber > 1).length, 20);
  const complete = await readExcel(bytes, { filename: 'muestras.xlsx', sheetName: 'Pedidos' });
  assert.equal(complete.rows.length, 36);
  assert.equal(complete.rows.at(-1).cells[0].value, 'AN-34');
  assert.equal(complete.samplesOnly, undefined);
});

test('duplicate rows are preserved for explicit business review, never silently deduplicated', async () => {
  const parsed = await readExcel(book([['Pedido', 'Producto', 'Cantidad'], ['AN-1', 'A', 2], ['AN-1', 'A', 2]]), { filename: 'duplicadas.xlsx', sheetName: 'Pedidos' });
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[1].cells, parsed.rows[2].cells);
  assert.equal(parsed.rows[2].rowNumber, 3);
});

test('extension, signature, empty, oversized and truncated files fail actionably', async () => {
  const bytes = book([['Pedido'], ['AN-1']]);
  await assert.rejects(readExcel(bytes, { filename: 'tabla.csv', sheetName: 'Pedidos' }), { status: 415 });
  await assert.rejects(readExcel(bytes, { filename: 'tabla.xls', sheetName: 'Pedidos' }), { status: 415 });
  await assert.rejects(readExcel(book([['A']], { type: 'xls' }), { filename: 'tabla.xlsx', sheetName: 'Pedidos' }), { status: 415 });
  await assert.rejects(readExcel(Buffer.from('not an Excel file'), { filename: 'tabla.xlsx', sheetName: 'Pedidos' }), { status: 415 });
  await assert.rejects(readExcel(Buffer.alloc(0), { filename: 'tabla.xlsx', sheetName: 'Pedidos' }), { status: 400 });
  await assert.rejects(readExcel(Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'tabla.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_FILE_LIMIT', status: 413 });
  await assert.rejects(readExcel(bytes.subarray(0, bytes.length - 15), { filename: 'tabla.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_INVALID', status: 400 });
  await assert.rejects(readExcel(bytes, { filename: 'tabla.xlsm', sheetName: 'Pedidos' }), { status: 415 });
});

test('selected sheet dimensions and workbook sheet count are bounded before full parsing', async () => {
  for (const ref of ['A1:GS2', 'A1:A10001']) {
    const bytes = book([['Pedido']], { edit: (_, sheet) => { sheet['!ref'] = ref; } });
    await assert.rejects(readExcel(bytes, { filename: 'grande.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  }
  const manySheets = count => book([['A']], { edit: workbook => {
    for (let index = 1; index < count; index++) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['B']]), `Hoja${index}`);
  } });
  assert.equal((await readExcel(manySheets(50), { filename: 'hojas.xlsx', mode: 'catalog' })).sheets.length,50);
  await assert.rejects(readExcel(manySheets(51), { filename: 'hojas.xlsx', mode: 'catalog' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  await assert.rejects(readExcel(book([['A']]), { filename: 'fila.xlsx', headerRow: 2, sheetName: 'Pedidos' }), { code: 'EXCEL_HEADER' });
});

test('a large unselected sheet does not truncate or replace the selected commercial sheet', async () => {
  const bytes = book([['Pedido'], ['AN-9']], { edit: workbook => {
    const other = XLSX.utils.aoa_to_sheet([['A']]);
    other['!ref'] = 'A1:A10001';
    XLSX.utils.book_append_sheet(workbook, other, 'Otra');
  } });
  const parsed = await readExcel(bytes, { filename: 'seleccion.xlsx', sheetName: 'Pedidos' });
  assert.equal(parsed.rows[1].cells[0].value, 'AN-9');
});

test('streaming ZIP validation counts actual output, not a lying uncompressed-size header', async () => {
  const bytes = Buffer.from(zipSync({ 'bomb.bin': new Uint8Array(33 * 1024 * 1024) }, { level: 9 }));
  // Lie in both local and central size headers. Emitted bytes must still stop at 32 MiB.
  bytes.writeUInt32LE(1, 22);
  const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
  bytes.writeUInt32LE(1, central + 24);
  await assert.rejects(readExcel(bytes, { filename: 'bomb.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
});

test('streaming ZIP validation enforces aggregate output, entry count, compression and integrity', async () => {
  const contents = {};
  for (let index = 0; index < 5; index++) contents[`part${index}`] = new Uint8Array(26 * 1024 * 1024);
  await assert.rejects(readExcel(zipSync(contents, { level: 9 }), { filename: 'aggregate.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  const entries = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`entry${index}`, new Uint8Array(0)]));
  await assert.rejects(readExcel(zipSync(entries), { filename: 'entries.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_CONTENT_LIMIT', status: 413 });
  const unsupported = Buffer.from(zipSync({ 'test.txt': strToU8('test') }));
  unsupported.writeUInt16LE(99, 8);
  unsupported.writeUInt16LE(99, unsupported.indexOf(Buffer.from('504b0102', 'hex')) + 10);
  await assert.rejects(readExcel(unsupported, { filename: 'method.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_FORMAT', status: 415 });
  const damaged = Buffer.from(zipSync({ 'test.txt': strToU8('test') }, { level: 0 }));
  damaged[30 + Buffer.byteLength('test.txt')] ^= 1;
  await assert.rejects(readExcel(damaged, { filename: 'damaged.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_INVALID', status: 400, message: /CRC incorrecto/ });
  const protectedZip = Buffer.from(zipSync({ 'test.txt': strToU8('test') }));
  const central = protectedZip.indexOf(Buffer.from('504b0102', 'hex'));
  protectedZip.writeUInt16LE(protectedZip.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(readExcel(protectedZip, { filename: 'password.xlsx', sheetName: 'Pedidos' }), { code: 'EXCEL_PROTECTED' });
});

test('compressed ZIP callback failures preserve integrity and metadata-limit errors', async () => {
  const compressed = Buffer.from(zipSync({ 'test.txt': strToU8('compressible text '.repeat(1000)) }, { level: 9 }));
  const central = compressed.indexOf(Buffer.from('504b0102', 'hex'));
  const wrongSize = Buffer.from(compressed);
  wrongSize.writeUInt32LE(1, 22);
  wrongSize.writeUInt32LE(1, central + 24);
  await assert.rejects(readExcel(wrongSize, { filename: 'size.xlsx', sheetName: 'Pedidos' }), {
    code: 'EXCEL_INVALID', status: 400, message: /tamaño o CRC incorrecto/,
  });
  const wrongCrc = Buffer.from(compressed);
  wrongCrc.writeUInt32LE(0, 14);
  wrongCrc.writeUInt32LE(0, central + 16);
  await assert.rejects(readExcel(wrongCrc, { filename: 'crc.xlsx', sheetName: 'Pedidos' }), {
    code: 'EXCEL_INVALID', status: 400, message: /tamaño o CRC incorrecto/,
  });
  const metadata = zipSync({ '[Content_Types].xml': new Uint8Array(1024 * 1024 + 1) }, { level: 9 });
  await assert.rejects(readExcel(metadata, { filename: 'metadata.xlsx', sheetName: 'Pedidos' }), {
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

test('catalog finds tables after an empty cover without selecting or counting transactions', async () => {
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,{},'REVISION');
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['Resumen informativo'],[],['FECHA','CAMPAÑA','VALOR','VALOR'],['2026-09-01','Campaña sintética',0,2000]]),'Publicidad');
  const later={A60:{t:'s',v:'ID PEDIDO'},A61:{t:'s',v:'ORDER-LATE'},'!ref':'A1:A61'};
  XLSX.utils.book_append_sheet(workbook,later,'Encabezado posterior');
  for(let index=3;index<21;index++)XLSX.utils.book_append_sheet(workbook,{},`Historia ${index}`);
  const bytes=XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true});
  const catalog=await readExcel(bytes,{filename:'libro-21.xlsx',mode:'catalog'});
  assert.equal(catalog.sheets.length,21);
  assert.equal(catalog.sheetName,undefined);
  assert.equal(catalog.sheets[0].empty,true);
  const table=catalog.sheets.find(sheet=>sheet.name==='Publicidad');
  const header=table.headerCandidates.find(candidate=>candidate.rowNumber===3);
  assert.deepEqual(header.headers,['FECHA','CAMPAÑA','VALOR','VALOR']);
  assert.deepEqual(header.columns.slice(2).map(column=>column.columnIndex),[2,3]);
  const unsampled=catalog.sheets.find(sheet=>sheet.name==='Encabezado posterior');
  assert.notEqual(unsampled.empty,true);
  assert.equal(unsampled.headerCandidates.some(candidate=>candidate.rowNumber===60),false);
  const chosen=await readExcel(bytes,{filename:'libro-21.xlsx',sheetName:'Encabezado posterior',headerRow:60,mode:'rows'});
  assert.equal(chosen.rows.find(row=>row.rowNumber===61).cells[0].value,'ORDER-LATE');
});

test('catalog preserves an oversized unselected sheet for a localized selection error', async () => {
  const bytes=book([['ID PEDIDO'],['ORDER-VALID']],{edit:workbook=>{
    XLSX.utils.book_append_sheet(workbook,{'!ref':'A1:A10001',A1:{t:'s',v:'ID'},A10001:{t:'s',v:'OUTSIDE'}},'Fuera del límite');
  }});
  const catalog=await readExcel(bytes,{filename:'localizado.xlsx',mode:'catalog'});
  assert.equal(catalog.sheets.find(sheet=>sheet.name==='Fuera del límite').rowCount,10001);
  assert.equal((await readExcel(bytes,{filename:'localizado.xlsx',sheetName:'Pedidos'})).rows[1].cells[0].value,'ORDER-VALID');
  await assert.rejects(readExcel(bytes,{filename:'localizado.xlsx',sheetName:'Fuera del límite'}),{code:'EXCEL_CONTENT_LIMIT'});
});

test('expanded XLSX preserves all existing nonmetadata parts, caches, formulas and styles', async () => {
  const original=book([['Campaña & origen','TOTAL'],['Campaña sintética',20000]],{edit:(workbook,sheet)=>{
    sheet.B2={t:'n',v:20000,f:'10*2000',z:'#,##0.00'};
    for(let index=1;index<20;index++)XLSX.utils.book_append_sheet(workbook,{},`Historia ${index}`);
  }});
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const originalHash=digest(original),before=unzipSync(original);
  const expanded=await expandExcelWorkbook(original,{filename:'sintetico.xlsx'});
  assert.equal(digest(original),originalHash);
  const after=unzipSync(expanded);
  const editable=new Set(['xl/workbook.xml','xl/_rels/workbook.xml.rels','[Content_Types].xml','docProps/app.xml']);
  for(const [name,bytes] of Object.entries(before))if(!editable.has(name))assert.equal(digest(after[name]),digest(bytes),name);
  const catalog=await readExcel(expanded,{filename:'sintetico - con operacion.xlsx',mode:'catalog'});
  assert.equal(catalog.sheets.length,21);
  const originalSheet=await readExcel(expanded,{filename:'ampliado.xlsx',sheetName:'Pedidos'});
  assert.equal(originalSheet.rows[1].cells[1].formula,'10*2000');
  assert.equal(originalSheet.rows[1].cells[1].value,20000);
  const operation=await readExcel(expanded,{filename:'ampliado.xlsx',sheetName:'GASTOS OPERACION'});
  assert.deepEqual(operation.rows[0].cells.map(cell=>cell.value),['ID GASTO','FECHA GASTO','CONCEPTO','VALOR','PROVEEDOR','REFERENCIA','NOTAS']);
  assert.equal(operation.rows.length,1);
  assert.equal(digest(await expandExcelWorkbook(expanded,{filename:'ampliado.xlsx'})),digest(expanded));
});

test('expansion refuses a conflicting operation table and never converts macro/binary formats', async () => {
  const collision=book([['Nombre','Monto']],{sheetName:'gastos operacion'});
  await assert.rejects(expandExcelWorkbook(collision,{filename:'conflicto.xlsx'}),{code:'EXCEL_OPERATION_SHEET_CONFLICT'});
  for(const type of ['xls','xlsb','xlsm'])await assert.rejects(expandExcelWorkbook(book([['Dato']],{type}),{filename:`original.${type}`}),{status:415});
});

test('v2 profiles preserve exact sheet names and exclude only explicitly disabled sheets',()=>{
 const flat={sheetName:'SEPTIEMBRE ',purpose:'tracking',columns:[{index:0,header:'Guía',destination:'tracking'}]};
 const frozen=structuredClone(flat);
 const canonical=validateImportConfig(flat);
 assert.equal(canonical.formatVersion,2);
 assert.equal(canonical.sheets[0].sheetName,'SEPTIEMBRE ');
 assert.deepEqual(flat,frozen);
 const sheets=Array.from({length:50},(_,index)=>({sheetName:`Hoja ${index}`,enabled:index!==0,columns:[]}));
 assert.equal(validateImportConfig({formatVersion:2,sheets}).sheets.filter(sheet=>sheet.enabled).length,49);
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[...sheets,{sheetName:'Hoja 51'}]}),{status:400});
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[sheets[0],sheets[0]]}),{status:400});
});

test('v2 conserva ignoradas y pendientes distintas y el adaptador antiguo no reescribe revisiones aceptadas',()=>{
  const columns=[{index:0,header:'Guía',destination:'tracking'},{index:1,header:'Resumen',destination:'ignore'},{index:2,header:'Por confirmar',destination:''}];
  const config={formatVersion:2,sheets:[{sheetName:'Datos ',purpose:'tracking',columns}]},before=structuredClone(config);
  const canonical=validateImportConfig(config);
  assert.deepEqual(canonical.sheets[0].columns.map(column=>column.destination),['tracking','ignore','']);
  assert.deepEqual(validateImportConfig(canonical).sheets[0].columns.map(column=>column.destination),['tracking','ignore','']);
  assert.deepEqual(config,before);
  const flat={sheetName:'Datos ',purpose:'tracking',columns:[columns[0],{...columns[1],destination:''}]};
  const revision={config:flat,groups:[{key:'clave-aceptada',sheet:'Datos ',rowNumbers:[2],rows:[{sheet:'Datos ',rowNumber:2,values:{}}],units:[]}],selection:['clave-aceptada'],resolutions:[],previewHash:'hash-de-la-revision-aceptada'};
  const bytes=JSON.stringify(revision),digest=createHash('sha256').update(bytes).digest('hex');
  const decoded=decodeImportRevision(revision);
  assert.equal(decoded.config.sheets[0].columns[1].destination,'ignore');
  assert.equal(decoded.groups[0].key,'clave-aceptada');assert.deepEqual(decoded.selection,revision.selection);assert.equal(decoded.previewHash,revision.previewHash);
  assert.equal(JSON.stringify(revision),bytes);assert.equal(createHash('sha256').update(JSON.stringify(revision)).digest('hex'),digest);
});

test('expense groups and defaults cannot leak financial destinations into commercial sheets',()=>{
 const column=(index,destination,group=0)=>({index,header:`Columna ${index}`,destination,group});
 const expense={sheetName:'Publicidad',purpose:'expenses',layout:'expense_columns',expenseGroupNames:{0:'Campaña A',1:'Campaña B'},columns:[column(0,'expenseQuantity'),column(1,'expenseUnitCost'),column(2,'expenseQuantity',1),column(3,'expenseUnitCost',1),column(4,'expenseControlTotal')]};
 assert.equal(validateImportConfig({formatVersion:2,sheets:[expense]}).sheets[0].columns[2].group,1);
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...expense,columns:[...expense.columns,column(5,'expenseQuantity',1)]}]}),{code:'IMPORT_COLUMN_DUPLICATE'});
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...expense,expenseGroupNames:{0:'Campaña A',1:' ＣＡＭＰＡÑA  A '}}]}),{status:400});
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{sheetName:'Ventas',purpose:'orders',columns:[column(0,'expenseAmount')]}]}),{code:'IMPORT_COLUMN_DESTINATION'});
 assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...expense,columns:[column(0,'unitPrice')]}]}),{code:'IMPORT_COLUMN_DESTINATION'});
 for(const invalid of [{defaults:{expenseAmount:100}},{defaults:{expenseConcept:{formula:'1+1'}}},{identityMode:'generated',purpose:'tracking',layout:'item_rows',expenseGroupNames:{},columns:[]}]){
  assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...expense,...invalid}]}),{status:400});
 }
});

test('monthly gift mapping remains explicit and separate from sold quantity and campaign',()=>{
 const headers=['ESTADO','FECHA','NOMBRE Y APELLIDO','PRODUCTO','CANTIDAD','PRECIO VENTA UND','OBSEQUIO','PAUTA'];
 const proposed=suggestSheetImport({name:'MES',empty:false,headerCandidates:[{rowNumber:1,columns:headers.map((header,columnIndex)=>({header,columnIndex,samples:[]}))}]});
 assert.equal(proposed.config.columns.find(column=>column.header==='OBSEQUIO').destination,'giftProductExternalKey');
 assert.equal(proposed.config.columns.find(column=>column.header==='PAUTA').destination,'marketingCampaign');
 assert.equal(proposed.config.defaults.giftQuantity,undefined);
 const gift={sheetName:'VENTAS',purpose:'orders',layout:'order_rows',columns:[{index:0,header:'Producto',destination:'productExternalKey',group:0},{index:1,header:'Obsequio',destination:'giftProductExternalKey',group:0},{index:2,header:'Cantidad obsequio',destination:'giftQuantity',group:0}],defaults:{giftQuantity:1}};
 assert.equal(validateImportConfig({formatVersion:2,sheets:[gift]}).sheets[0].defaults.giftQuantity,1);
 for(const purpose of ['tracking','settlements','expenses'])assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...gift,purpose,layout:purpose==='expenses'?'expense_rows':'order_rows',defaults:{}}]}),{code:'IMPORT_COLUMN_DESTINATION'});
 for(const quantity of [0,-1,1.5,1000,'1'])assert.throws(()=>validateImportConfig({formatVersion:2,sheets:[{...gift,defaults:{giftQuantity:quantity}}]}),{status:400});
});
