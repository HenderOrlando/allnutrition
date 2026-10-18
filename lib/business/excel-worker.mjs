import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import { Unzip, UnzipInflate } from 'fflate';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const MiB = 1024 * 1024;
function reject(message, code = 'EXCEL_INVALID', status = 400, location = undefined) {
  throw Object.assign(new Error(message), { code, status, location });
}
function limit(message) { reject(message, 'EXCEL_CONTENT_LIMIT', 413); }

// Validate the central directory as well as emitted bytes. Header sizes alone do
// not constrain decompression, and an absent EOCD must not accept a partial ZIP.
function zipDirectory(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) reject('El contenedor Excel está truncado o dañado.');
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2048) limit('El archivo contiene más de 2048 entradas ZIP.');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) reject('No se admiten archivos Excel ZIP divididos.');
  const start = bytes.readUInt32LE(end + 16);
  if (start + bytes.readUInt32LE(end + 12) !== end) reject('El directorio del archivo Excel está dañado.');
  const entries = new Map();
  let position = start;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) reject('El directorio ZIP está truncado.');
    const flags = bytes.readUInt16LE(position + 8);
    const compression = bytes.readUInt16LE(position + 10);
    if (flags & 1) reject('El Excel está cifrado. Guarda una copia sin contraseña.', 'EXCEL_PROTECTED');
    if (![0, 8].includes(compression)) reject('El archivo usa un método ZIP no admitido.', 'EXCEL_FORMAT', 415);
    const nameLength = bytes.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    if (next > end) reject('El directorio ZIP está truncado.');
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    if (entries.has(name)) reject('El archivo contiene entradas ZIP repetidas.');
    const offset = bytes.readUInt32LE(position + 42);
    const compressed = bytes.readUInt32LE(position + 20);
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50
      || bytes.readUInt16LE(offset + 8) !== compression || bytes.readUInt16LE(offset + 6) & 1) reject('La cabecera ZIP no es válida.');
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (dataStart + compressed > start || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name) reject('El contenido ZIP está truncado o dañado.');
    entries.set(name, { size: bytes.readUInt32LE(position + 24), crc: bytes.readUInt32LE(position + 16), compression });
    position = next;
  }
  if (position !== end) reject('El directorio ZIP no coincide con el archivo.');
  return entries;
}

function validateZip(bytes, extension) {
  const directory = zipDirectory(bytes);
  let total = 0;
  let count = 0;
  let completed = 0;
  let contentTypes = '';
  const observed = new Set();
  let failure = null;
  const stop = (file, message, code = 'EXCEL_INVALID', status = 400) => {
    failure ??= Object.assign(new Error(message), { code, status });
    file.terminate();
  };
  const unzip = new Unzip(file => {
    if (failure) { file.terminate(); return; }
    if (++count > 2048) { stop(file, 'El archivo contiene más de 2048 entradas ZIP.', 'EXCEL_CONTENT_LIMIT', 413); return; }
    const entry = directory.get(file.name);
    if (!entry || observed.has(file.name) || entry.compression !== file.compression) {
      stop(file, 'Las entradas ZIP no coinciden con el directorio.'); return;
    }
    observed.add(file.name);
    if (![0, 8].includes(file.compression)) { stop(file, 'El archivo usa un método ZIP no admitido.', 'EXCEL_FORMAT', 415); return; }
    let emitted = 0;
    let checksum = 0;
    const parts = [];
    file.ondata = (error, chunk, final) => {
      // UnzipInflate catches exceptions from ondata and calls it again as an
      // inflater error. Keep the original failure outside that callback instead.
      if (failure) return;
      if (error) { stop(file, 'No se pudo descomprimir el Excel; puede estar dañado.'); return; }
      emitted += chunk.length;
      total += chunk.length;
      if (emitted > 32 * MiB) { stop(file, 'Una entrada del Excel supera 32 MiB descomprimidos.', 'EXCEL_CONTENT_LIMIT', 413); return; }
      if (total > 128 * MiB) { stop(file, 'El Excel supera 128 MiB descomprimidos.', 'EXCEL_CONTENT_LIMIT', 413); return; }
      checksum = crc32(chunk, checksum);
      if (file.name === '[Content_Types].xml') {
        if (emitted > MiB) { stop(file, 'Los metadatos del Excel son demasiado grandes.', 'EXCEL_CONTENT_LIMIT', 413); return; }
        parts.push(Buffer.from(chunk));
      }
      if (final) {
        if (emitted !== entry.size || checksum !== entry.crc) { stop(file, 'El contenido Excel está dañado (tamaño o CRC incorrecto).'); return; }
        completed++;
        if (parts.length) contentTypes = Buffer.concat(parts).toString('utf8');
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    try {
      unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    } catch (error) {
      throw failure ?? error;
    }
    // No further compressed input is consumed after a budget/integrity failure.
    if (failure) throw failure;
  }
  if (completed !== directory.size) reject('El Excel está truncado; faltan entradas ZIP.');
  const binary = directory.has('xl/workbook.bin');
  const xml = directory.has('xl/workbook.xml');
  const macro = /application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml/.test(contentTypes);
  if (!contentTypes || (extension === 'xlsb' ? !binary : !xml) || (extension === 'xlsm' && !macro)
    || (extension === 'xlsx' && (macro || directory.has('xl/vbaProject.bin')))) reject('La extensión no corresponde al contenido Excel. Guarda el archivo con su extensión original.', 'EXCEL_FORMAT', 415);
}

function dimensions(sheet) {
  const ref = sheet?.['!fullref'] ?? sheet?.['!ref'];
  if (!ref) return { rowCount: 0, columnCount: 0 };
  let range;
  try { range = XLSX.utils.decode_range(ref); } catch { reject('El rango de la hoja no es válido.'); }
  if (![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger) || range.e.r < range.s.r || range.e.c < range.s.c) reject('El rango de la hoja no es válido.');
  return { rowCount: range.e.r + 1, columnCount: range.e.c + 1 };
}
function checkDimensions({ rowCount, columnCount }) {
  if (rowCount > 10000) limit('La hoja seleccionada supera 10000 filas. Divide la tabla antes de importarla.');
  if (columnCount > 200) limit('La hoja seleccionada supera 200 columnas.');
}

function parse({ bytes: input, filename, sheetName, headerRow, mode }) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > 10 * MiB) limit('El archivo supera 10 MiB.');
  const extension = filename.split('.').at(-1).toLowerCase();
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const compound = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (extension === 'xls' ? !compound : !zip) reject(compound && extension !== 'xls'
    ? 'El Excel parece cifrado o su extensión no coincide. Guarda una copia sin contraseña.'
    : 'La firma del archivo no corresponde a su extensión Excel.', 'EXCEL_FORMAT', 415);
  if (zip) validateZip(bytes, extension);
  const options = { type: 'buffer', cellFormula: true, cellText: true, cellNF: true, cellDates: false, sheetStubs: true, WTF: true, bookVBA: false, bookDeps: false, bookFiles: false };
  const metadata = XLSX.read(bytes, { ...options, sheetRows: 1 });
  if (!metadata.SheetNames.length) reject('El Excel no contiene hojas de cálculo.');
  if (metadata.SheetNames.length > 20) limit('El Excel supera el máximo de 20 hojas.');
  const selected = sheetName ?? metadata.SheetNames[0];
  if (!metadata.SheetNames.includes(selected)) reject('La hoja seleccionada no existe. Selecciona una hoja del archivo.', 'EXCEL_SHEET', 400, {sheet:selected});
  const sheets = metadata.SheetNames.map(name => ({ name, ...dimensions(metadata.Sheets[name]) }));
  checkDimensions(sheets.find(sheet => sheet.name === selected));
  // Without a worksheet dimension, SheetJS derives !ref only from the sampled
  // rows and supplies no !fullref. That is not evidence the sheet ends at row 1.
  // Read the selected sheet fully in that case; worker memory/time limits still
  // apply, and inspection returns only the requested samples below.
  const sampled = mode === 'inspect' && metadata.Sheets[selected]['!fullref'];
  const workbook = XLSX.read(bytes, { ...options, sheets: [selected], ...(sampled ? { sheetRows: headerRow + 20 } : {}) });
  const sheet = workbook.Sheets[selected];
  if (sheet['!protect']) reject('La hoja está protegida. Guarda una copia sin protección.', 'EXCEL_PROTECTED');
  checkDimensions(dimensions(sheet));
  Object.assign(sheets.find(item => item.name === selected), dimensions(sheet));
  if (headerRow > dimensions(sheet).rowCount) reject('La fila de encabezados está fuera de la hoja.', 'EXCEL_HEADER', 400, {sheet:selected,rowNumber:headerRow});
  const rowsByNumber = new Map();
  const warnings = [];
  let maxRow = 0;
  let maxColumn = 0;
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!')) continue;
    const position = XLSX.utils.decode_cell(address);
    maxRow = Math.max(maxRow, position.r + 1);
    maxColumn = Math.max(maxColumn, position.c + 1);
    checkDimensions({ rowCount: maxRow, columnCount: maxColumn });
    if (mode === 'inspect' && (position.r + 1 < headerRow || position.r + 1 > headerRow + 20)) continue;
    if (!rowsByNumber.has(position.r + 1)) rowsByNumber.set(position.r + 1, []);
    const formula = typeof cell.f === 'string' ? cell.f : null;
    const hasCachedValue = cell.v !== undefined && cell.v !== null && cell.t !== 'z';
    rowsByNumber.get(position.r + 1)[position.c] = {
      type: cell.t ?? 'z', value: hasCachedValue ? cell.v : null,
      text: hasCachedValue ? String(cell.w ?? XLSX.utils.format_cell(cell)) : '', formula, hasCachedValue,
    };
    if (formula) warnings.push({ code: hasCachedValue ? 'EXCEL_FORMULA_CACHED' : 'EXCEL_FORMULA_NO_CACHE',
      message: hasCachedValue ? 'Se usará el resultado guardado de una fórmula; debes aceptar esta advertencia.' : 'La fórmula no tiene resultado guardado; no puede usarse en un campo necesario.',
      sheet: selected, row: position.r + 1, column: position.c + 1 });
  }
  const width = Math.max(maxColumn, sheets.find(item => item.name === selected).columnCount);
  const rows = [...rowsByNumber].sort(([a], [b]) => a - b).map(([rowNumber, cells]) => ({ rowNumber,
    cells: Array.from({ length: width }, (_, index) => cells[index] ?? { type: 'z', value: null, text: '', formula: null, hasCachedValue: false }),
  }));
  const header = rows.find(row => row.rowNumber === headerRow);
  if (!header?.cells.some(cell => cell.formula || cell.value != null && String(cell.value).trim() !== '')) reject('La fila de encabezados está vacía. Selecciona la fila que contiene los nombres de las columnas.', 'EXCEL_HEADER', 400, {sheet:selected,rowNumber:headerRow});
  return { sheets, sheetName: selected, headerRow, date1904: !!workbook.Workbook?.WBProps?.date1904, rows, warnings,
    ...(mode === 'inspect' ? { samplesOnly: true, sampleLimit: 20 } : {}) };
}

try { parentPort.postMessage({ result: parse(workerData) }); }
catch (error) {
  const protectedFile = /password|encrypt|protected/i.test(error.message);
  parentPort.postMessage({ error: { message: error.status ? error.message : protectedFile
    ? 'El Excel está protegido. Guarda una copia sin contraseña.' : 'No se pudo leer el Excel. Comprueba que esté completo y no esté dañado.',
  code: error.status ? error.code : protectedFile ? 'EXCEL_PROTECTED' : 'EXCEL_INVALID', status: error.status ?? 400, location: error.location } });
}
