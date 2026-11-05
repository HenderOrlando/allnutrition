import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validateExcelZip } from './excel-zip.mjs';
import { expandWorkbook } from './excel-expand.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const MiB = 1024 * 1024;
function reject(message, code = 'EXCEL_INVALID', status = 400, location = undefined) {
  throw Object.assign(new Error(message), { code, status, location });
}
function limit(message, location) { reject(message, 'EXCEL_CONTENT_LIMIT', 413, location); }
function comparisonRanges(sheet, { rowCount, columnCount }) {
  if (rowCount < 32 || columnCount < 11) return [];
  const hash = createHash('sha256');
  for (let row = 0; row < 32; row++) for (let column = 0; column < 11; column++) {
    const cell = sheet[XLSX.utils.encode_cell({ r:row, c:column })];
    hash.update(JSON.stringify([cell?.t ?? 'z', cell?.v ?? null, cell?.f ?? null]));
    hash.update('\n');
  }
  return [{ range:'A1:K32', hash:hash.digest('hex') }];
}
function dimensions(sheet) {
  const ref = sheet?.['!fullref'] ?? sheet?.['!ref'];
  if (!ref) return { rowCount: 0, columnCount: 0 };
  let range;
  try { range = XLSX.utils.decode_range(ref); } catch { reject('El rango de la hoja no es válido.'); }
  if (![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger) || range.e.r < range.s.r || range.e.c < range.s.c) reject('El rango de la hoja no es válido.');
  return { rowCount: range.e.r + 1, columnCount: range.e.c + 1 };
}
function checkDimensions({ rowCount, columnCount }, sheet, maxRows) {
  if (rowCount > maxRows) limit(`La hoja seleccionada supera ${maxRows} filas. Divide la tabla antes de importarla.`, { sheet });
  if (columnCount > 200) limit('La hoja seleccionada supera 200 columnas.', { sheet });
}
function contentDimensions(sheet) {
  let rowCount = 0, columnCount = 0, hasData = false;
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const position = XLSX.utils.decode_cell(address), cell = sheet[address];
    rowCount = Math.max(rowCount, position.r + 1);
    columnCount = Math.max(columnCount, position.c + 1);
    if (cell.f || cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') hasData = true;
  }
  const declared = dimensions(sheet);
  return { rowCount: Math.max(rowCount, declared.rowCount), columnCount: Math.max(columnCount, declared.columnCount), hasData };
}
function cellValue(cell) {
  const formula = typeof cell?.f === 'string' ? cell.f : null;
  const hasCachedValue = cell?.v !== undefined && cell.v !== null && cell.t !== 'z';
  return { type: cell?.t ?? 'z', value: hasCachedValue ? cell.v : null,
    text: hasCachedValue ? String(cell.w ?? XLSX.utils.format_cell(cell)) : '', formula, hasCachedValue };
}
function headerCandidates(sheet, width) {
  const candidates = [];
  for (let row = 0; row < 50; row++) {
    const cells = Array.from({ length: Math.min(width, 200) }, (_, column) => cellValue(sheet[XLSX.utils.encode_cell({ r: row, c: column })]));
    const meaningful = cells.filter(cell => cell.value !== null && String(cell.value).trim());
    if (!meaningful.length || meaningful.filter(cell => typeof cell.value === 'string').length < Math.ceil(meaningful.length / 2)) continue;
    const columns = cells.map((cell, columnIndex) => {
      const samples = [];
      for (let r = row + 1; r <= Math.min(row + 5, 9999); r++) {
        const sample = cellValue(sheet[XLSX.utils.encode_cell({ r, c: columnIndex })]);
        if (sample.value !== null || sample.formula) samples.push({ ...sample, value: typeof sample.value === 'string' ? sample.value.slice(0, 200) : sample.value, text: sample.text.slice(0, 200), formula: sample.formula ? true : null });
      }
      return { columnIndex, header: cell.text.slice(0, 200), types: [...new Set(samples.map(sample => sample.type))], samples };
    });
    candidates.push({ rowNumber: row + 1, headers: columns.map(column => column.header), columns, score: meaningful.length });
  }
  return candidates.sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber).slice(0, 5);
}
function selectedRows(sheet, selected, headerRow, mode, sheets, date1904, maxRows) {
  if (sheet['!protect']) reject('La hoja está protegida. Guarda una copia sin protección.', 'EXCEL_PROTECTED', 400, { sheet: selected });
  const actual = contentDimensions(sheet);
  checkDimensions(actual, selected, maxRows);
  if (headerRow > actual.rowCount) reject('La fila de encabezados está fuera de la hoja.', 'EXCEL_HEADER', 400, { sheet: selected, rowNumber: headerRow });
  const rowsByNumber = new Map(), warnings = [];
  for (const [address, original] of Object.entries(sheet)) {
    if (address.startsWith('!')) continue;
    const position = XLSX.utils.decode_cell(address), rowNumber = position.r + 1;
    if (rowNumber < headerRow || mode === 'inspect' && rowNumber > headerRow + 20) continue;
    if (!rowsByNumber.has(rowNumber)) rowsByNumber.set(rowNumber, []);
    const cell = cellValue(original);
    rowsByNumber.get(rowNumber)[position.c] = cell;
    if (cell.formula) warnings.push({ code: cell.hasCachedValue ? 'EXCEL_FORMULA_CACHED' : 'EXCEL_FORMULA_NO_CACHE',
      message: cell.hasCachedValue ? 'Se usará el resultado guardado de una fórmula; debes aceptar esta advertencia.' : 'La fórmula no tiene resultado guardado; no puede usarse en un campo necesario.',
      sheet: selected, row: rowNumber, column: position.c + 1 });
  }
  const rows = [...rowsByNumber].sort(([a], [b]) => a - b).map(([rowNumber, cells]) => ({ rowNumber,
    cells: Array.from({ length: actual.columnCount }, (_, index) => cells[index] ?? cellValue(null)) }));
  const header = rows.find(row => row.rowNumber === headerRow);
  if (!header?.cells.some(cell => cell.formula || cell.value != null && String(cell.value).trim() !== '')) reject('La fila de encabezados está vacía. Selecciona la fila que contiene los nombres de las columnas.', 'EXCEL_HEADER', 400, { sheet: selected, rowNumber: headerRow });
  return { sheets, sheetName: selected, headerRow, date1904, rows, warnings,
    ...(mode === 'inspect' ? { samplesOnly: true, sampleLimit: 20 } : {}) };
}
function parse({ bytes: input, filename, sheetName, headerRow, mode, selections, maxRows = 10000 }) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > 10 * MiB) limit('El archivo supera 10 MiB.');
  const extension = filename.split('.').at(-1).toLowerCase();
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const compound = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (extension === 'xls' ? !compound : !zip) reject(compound && extension !== 'xls'
    ? 'El Excel parece cifrado o su extensión no coincide. Guarda una copia sin contraseña.'
    : 'La firma del archivo no corresponde a su extensión Excel.', 'EXCEL_FORMAT', 415);
  if (mode === 'expand') return expandWorkbook(bytes, { filename });
  if (zip) validateExcelZip(bytes, extension);
  const options = { type: 'buffer', cellFormula: true, cellText: true, cellNF: true, cellDates: false, sheetStubs: true, WTF: true, bookVBA: false, bookDeps: false, bookFiles: false };
  const metadata = XLSX.read(bytes, { ...options, bookSheets: true, bookProps: true });
  if (!metadata.SheetNames?.length) reject('El Excel no contiene hojas de cálculo.');
  if (metadata.SheetNames.length > 50) limit('El Excel supera el máximo de 50 hojas.');
  const sheets = metadata.SheetNames.map(name => ({ name, rowCount: null, columnCount: null, empty: null, headerCandidates: [] }));
  const selected = selections ?? (mode === 'catalog' ? metadata.SheetNames.map(name => ({ sheetName: name, headerRow: 1 })) : [{ sheetName, headerRow }]);
  const results = [];
  let selectedRowsCount = 0;
  for (let index = 0; index < selected.length; index++) {
    const selection = selected[index], name = selection.sheetName;
    if (!metadata.SheetNames.includes(name)) reject('La hoja seleccionada no existe. Selecciona una hoja del archivo.', 'EXCEL_SHEET', 400, { sheet: name });
    // A full single-sheet read also checks real cells outside declared !ref and
    // proves emptiness; a fifty-row empty sample alone cannot do so.
    let workbook, sheet, actual;
    const descriptor = sheets.find(item => item.name === name);
    try {
      workbook = XLSX.read(bytes, { ...options, sheets: [name] });
      sheet = workbook.Sheets[name];
      actual = contentDimensions(sheet);
    } catch (error) {
      if (mode !== 'catalog') {
        error.location ??= { sheet:name };
        throw error;
      }
      descriptor.error = { code:error.code || 'EXCEL_SHEET', message:error.status ? error.message : 'Esta hoja requiere revisión manual antes de importarla.', location:{ sheet:name } };
      results.push({ date1904:false });
      parentPort.postMessage({ progress:{ sheetName:name, index:index + 1, total:selected.length } });
      continue;
    }
    Object.assign(descriptor, { rowCount:actual.rowCount, columnCount:actual.columnCount, empty:!actual.hasData,
      headerCandidates:mode === 'catalog' ? headerCandidates(sheet,actual.columnCount) : [],
      ...(mode === 'catalog' ? { comparisonRanges:comparisonRanges(sheet,actual) } : {}) });
    const date1904 = !!workbook.Workbook?.WBProps?.date1904;
    if (mode !== 'catalog') {
      selectedRowsCount += Math.max(0, actual.rowCount - selection.headerRow);
      if (selectedRowsCount > Math.max(50000, maxRows - 1)) limit('Las hojas seleccionadas superan el límite de filas por libro.');
      results.push(selectedRows(sheet, name, selection.headerRow, mode, sheets, date1904, maxRows));
    }
    parentPort.postMessage({ progress: { sheetName: name, index: index + 1, total: selected.length } });
    if (mode === 'catalog') results.push({ date1904 });
  }
  if (mode === 'catalog') return { sheets, date1904: results[0]?.date1904 ?? false };
  return selections ? results : results[0];
}
try { parentPort.postMessage({ result: parse(workerData) }); }
catch (error) {
  const protectedFile = /password|encrypt|protected/i.test(error.message);
  parentPort.postMessage({ error: { message: error.status ? error.message : protectedFile
    ? 'El Excel está protegido. Guarda una copia sin contraseña.' : 'No se pudo leer el Excel. Comprueba que esté completo y no esté dañado.',
  code: error.status ? error.code : protectedFile ? 'EXCEL_PROTECTED' : 'EXCEL_INVALID', status: error.status ?? 400, location: error.location } });
}
