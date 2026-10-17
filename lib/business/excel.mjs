import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { AppError } from '../validation-core.mjs';
import { parseMoneyMinor } from './money.mjs';

const require = createRequire(import.meta.url);
const MAX_BYTES = 10 * 1024 * 1024;

function invalid(message, code = 'EXCEL_INVALID', status = 400) {
  const error = new AppError(message, status);
  error.code = code;
  return error;
}

export async function readExcel(bytes, { filename, sheetName = null, headerRow = 1, mode = 'rows' } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw invalid('Selecciona un archivo Excel que no esté vacío.');
  if (bytes.byteLength > MAX_BYTES) throw invalid('El archivo supera el máximo de 10 MiB.', 'EXCEL_FILE_LIMIT', 413);
  if (typeof filename !== 'string' || !/\.(xlsx|xls|xlsb|xlsm)$/i.test(filename)) throw invalid('Usa un archivo .xlsx, .xls, .xlsb o .xlsm.', 'EXCEL_FORMAT', 415);
  if (!['rows', 'inspect'].includes(mode) || !Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 10000
    || (sheetName !== null && (typeof sheetName !== 'string' || sheetName.length > 100))) throw invalid('La hoja, fila de encabezados o modo no son válidos.');
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(resolve(process.cwd(), 'lib/business/excel-worker.mjs'), {
      workerData: { bytes, filename, sheetName, headerRow, mode },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
      execArgv: [],
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolveResult(result);
    };
    const timer = setTimeout(() => finish(invalid('El archivo tardó más de 30 segundos. Reduce el tamaño de la hoja.', 'EXCEL_TIMEOUT', 413)), 30000);
    worker.once('message', message => finish(message.error ? invalid(message.error.message, message.error.code, message.error.status) : null, message.result));
    worker.once('error', error => finish(invalid(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? 'El archivo excede la memoria permitida. Reduce el tamaño de la hoja.' : 'No se pudo leer el archivo Excel; comprueba que no esté dañado.',
    error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'EXCEL_MEMORY_LIMIT' : 'EXCEL_INVALID', error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 413 : 400)));
    worker.once('exit', () => { if (!settled) finish(invalid('La lectura de Excel se interrumpió. Comprueba el archivo.', 'EXCEL_INVALID')); });
  });
}

function valueOf(cell, label) {
  if (cell?.formula && !cell.hasCachedValue) throw invalid(`${label}: la fórmula no tiene un resultado guardado. Abre y guarda el archivo con sus valores calculados.`, 'EXCEL_FORMULA_NO_CACHE');
  if (cell?.type === 'e') throw invalid(`${label}: la celda contiene un error de Excel.`);
  return cell?.value ?? null;
}

export function normalizeExcelIdentifier(cell, label = 'Identificador') {
  const value = valueOf(cell, label);
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${label}: Excel perdió precisión; usa una celda de texto con el identificador original.`, 'EXCEL_IDENTIFIER_PRECISION');
    const formatted = String(cell.text ?? value).trim();
    if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(formatted)) throw invalid(`${label}: no se admite notación científica. Guarda el identificador como texto.`, 'EXCEL_IDENTIFIER_PRECISION');
    return /^\d+$/.test(formatted) ? formatted : String(value);
  }
  if (typeof value !== 'string') throw invalid(`${label}: se esperaba un identificador de texto.`);
  const text = value.trim();
  if (/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)[eE][+-]?\d+$/.test(text)) throw invalid(`${label}: no se admite notación científica.`, 'EXCEL_IDENTIFIER_PRECISION');
  return text || null;
}

export function normalizeExcelMoney(cell, format = {}, label = 'Importe') {
  const value = valueOf(cell, label);
  if (value === null || value === '') return null;
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw invalid('La celda numérica perdió precisión.');
      // Numeric Excel cells have no locale separators. Do not use displayed rounded text.
      return parseMoneyMinor(String(value), { decimalSeparator: '.', groupSeparator: '' });
    }
    if (typeof value !== 'string') throw invalid('Se esperaba un importe.');
    return parseMoneyMinor(value, format);
  } catch (error) { throw invalid(`${label}: ${error.message}`, 'EXCEL_MONEY'); }
}

function calendarDate(year, month, day, label) {
  const result = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${result}T00:00:00Z`);
  if (year < 1 || year > 9999 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result) throw invalid(`${label}: fecha no válida.`, 'EXCEL_DATE');
  return result;
}

function bogotaOn(instant) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

export function normalizeExcelDate(cell, { date1904 = false, dateFormat = 'ISO' } = {}, label = 'Fecha') {
  const value = valueOf(cell, label);
  if (value === null || value === '') return null;
  if (!['DMY', 'MDY', 'ISO'].includes(dateFormat)) throw invalid(`${label}: elige DMY, MDY o ISO.`, 'EXCEL_DATE');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 2958465 || (!date1904 && Math.floor(value) === 60)) throw invalid(`${label}: fecha serial no válida (Excel 1900 incluye un 29 de febrero inexistente).`, 'EXCEL_DATE');
    const day = Math.floor(value);
    const base = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
    const milliseconds = base + (day - (!date1904 && day > 60 ? 1 : 0)) * 86400000;
    if (new Date(milliseconds).getUTCFullYear() > 9999) throw invalid(`${label}: fecha fuera del rango permitido.`, 'EXCEL_DATE');
    const occurredOn = new Date(milliseconds).toISOString().slice(0, 10);
    if (value === day) return { occurredOn, occurredAt: null, precision: 'day' };
    // Excel wall-clock timestamps have no timezone: interpret them in Bogotá, never the host timezone.
    const occurredAt = new Date(milliseconds + Math.round((value - day) * 86400000) + 5 * 3600000).toISOString();
    return { occurredOn: bogotaOn(new Date(occurredAt)), occurredAt, precision: 'instant' };
  }
  if (typeof value !== 'string') throw invalid(`${label}: se esperaba una fecha.`, 'EXCEL_DATE');
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(input);
  const local = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?$/.exec(input);
  let year, month, day, hours, minutes, seconds, fraction, zone;
  if (iso) [, year, month, day, hours, minutes, seconds, fraction, zone] = iso;
  else if (local && dateFormat !== 'ISO') {
    const [, first, second, y, h, m, s, f] = local;
    [year, month, day, hours, minutes, seconds, fraction] = [y, dateFormat === 'DMY' ? second : first, dateFormat === 'DMY' ? first : second, h, m, s, f];
  } else throw invalid(`${label}: usa el formato ${dateFormat} seleccionado.`, 'EXCEL_DATE');
  const occurredOn = calendarDate(Number(year), Number(month), Number(day), label);
  if (hours === undefined) return { occurredOn, occurredAt: null, precision: 'day' };
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds ?? 0) > 59 || (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) throw invalid(`${label}: hora no válida.`, 'EXCEL_DATE');
  const instant = new Date(`${occurredOn}T${hours}:${minutes}:${seconds ?? '00'}${fraction ?? ''}${zone ?? '-05:00'}`);
  if (!Number.isFinite(instant.getTime())) throw invalid(`${label}: fecha no válida.`, 'EXCEL_DATE');
  return { occurredOn: bogotaOn(instant), occurredAt: instant.toISOString(), precision: 'instant' };
}

export function writeExcelSheets(sheets) {
  const XLSX = require('xlsx');
  const workbook = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const values = rows.map(row => row.map(value => value === null || value === undefined ? { t: 's', v: 'Sin dato' }
      : typeof value === 'number' && Number.isFinite(value) ? { t: 'n', v: value }
        : typeof value === 'boolean' ? { t: 'b', v: value } : { t: 's', v: String(value) }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(values), name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}
