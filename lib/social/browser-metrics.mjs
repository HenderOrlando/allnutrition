import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { readExcel, normalizeExcelText, normalizeExcelIdentifier, normalizeExcelDate, normalizeExcelMoney } from '../business/excel.mjs';
import { MAX_MONEY_MINOR } from '../business/money.mjs';

// Native definitions deliberately do not claim equivalence with Graph API fields.
export const BROWSER_METRIC_DEFINITION_VERSION = 'meta-ui-performance-v1';
const MAX_BYTES = 10 * 1024 * 1024;
const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
export class BrowserMetricExportError extends Error {
  constructor(reason, errorCode = 'LAYOUT_CHANGED') {
    super(reason); this.name = 'BrowserMetricExportError'; this.reason = reason; this.errorCode = errorCode;
  }
}
function invalid(reason, errorCode = 'LAYOUT_CHANGED') { throw new BrowserMetricExportError(reason, errorCode); }
const schema = [
  ['id', /^(Ad ID|Campaign ID|Content ID|Media ID|Video ID|ID del anuncio|ID de la campaña|ID del contenido|ID del video)$/i],
  ['periodStart', /^(Reporting starts|Inicio del informe)$/i], ['periodEnd', /^(Reporting ends|Fin del informe)$/i],
  ['publisherPlatform', /^(Publisher platform|Plataforma de publicación)$/i], ['placement', /^(Placement|Ubicación)$/i],
  ['age', /^(Age|Edad)$/i], ['gender', /^(Gender|Género)$/i], ['country', /^(Country|País)$/i],
  ['scope', /^(Metric scope|Ámbito de las métricas)$/i],
  ['spendMinor', /^(Amount spent|Importe gastado)$/i, 'minor_currency'],
  ['impressions', /^(Impressions|Impresiones)$/i, 'count'], ['reach', /^(Reach|Alcance)$/i, 'count'],
  ['frequency', /^(Frequency|Frecuencia)$/i, 'ratio'], ['linkClicks', /^(Link clicks|Clics en el enlace)$/i, 'count'],
  ['conversations', /^(WhatsApp conversations started|Conversaciones de WhatsApp iniciadas)$/i, 'count'],
  ['interactions', /^(Post engagements|Interacciones con la publicación|Content interactions|Interacciones con el contenido)$/i, 'count'],
  ['views', /^(Views|Visualizaciones)$/i, 'count'], ['plays', /^(Plays|Reproducciones)$/i, 'count'],
  ['likes', /^(Likes|Me gusta)$/i, 'count'], ['comments', /^(Comments|Comentarios)$/i, 'count'],
  ['shares', /^(Shares|Veces compartido)$/i, 'count'], ['saves', /^(Saves|Guardados)$/i, 'count'],
  ['reactions', /^(Reactions|Reacciones)$/i, 'count'],
  ['videoP25', /^(Video plays at 25%|Reproducciones de video al 25%)$/i, 'count'],
  ['videoP50', /^(Video plays at 50%|Reproducciones de video al 50%)$/i, 'count'],
  ['videoP75', /^(Video plays at 75%|Reproducciones de video al 75%)$/i, 'count'],
  ['videoP100', /^(Video plays at 100%|Reproducciones de video al 100%)$/i, 'count'],
  ['averageWatchTime', /^(Average watch time \(seconds\)|Tiempo promedio de reproducción \(segundos\))$/i, 'seconds'],
  ['totalWatchTime', /^(Total watch time \(seconds\)|Tiempo total de reproducción \(segundos\))$/i, 'seconds'],
  ['averageWatchTime', /^(Average watch time \(milliseconds\)|Tiempo promedio de reproducción \(milisegundos\))$/i, 'milliseconds'],
  ['totalWatchTime', /^(Total watch time \(milliseconds\)|Tiempo total de reproducción \(milisegundos\))$/i, 'milliseconds'],
  ['skipRate', /^(Skip rate \(percent\)|Porcentaje de omisiones)$/i, 'percent']
];
const scopeNames = { Paid: 'paid', Pagado: 'paid', Organic: 'organic', Orgánico: 'organic', Mixed: 'mixed', Mixto: 'mixed', paid: 'paid', organic: 'organic', mixed: 'mixed' };
export function browserMetricScope(value) { return scopeNames[clean(value)] || null; }
function formatOf(format) {
  if (format == null) return null;
  if (!['.', ','].includes(format.decimalSeparator) || !['', '.', ',', ' ', '\u00a0', '\u202f', "'"].includes(format.groupSeparator) || format.decimalSeparator === format.groupSeparator) invalid('invalid_number_format');
  return { decimalSeparator: format.decimalSeparator, groupSeparator: format.groupSeparator };
}
const cellOf = value => value && typeof value === 'object' && 'value' in value ? value : { value, text: String(value ?? ''), type: typeof value === 'number' ? 'n' : 's', formula: null };
function mappedColumns(headers) {
  const result = [];
  for (const [key, expression, unit] of schema) {
    const matches = headers.flatMap((label, index) => expression.test(label) ? [index] : []);
    if (matches.length > 1 && key !== 'id') invalid('ambiguous_columns');
    if (matches.length && result.some(column => column.key === key)) invalid('ambiguous_metric_definition');
    for (const index of matches) result.push({ key, index, label: headers[index], unit });
  }
  if (!['id', 'periodStart', 'periodEnd'].every(key => result.some(column => column.key === key)) || !result.some(column => column.unit)) invalid('performance_headers_required');
  return result;
}
function decimal(text, format) {
  const parts = text.split(format.decimalSeparator);
  if (parts.length > 2 || parts.length === 2 && !/^\d+$/.test(parts[1])) return null;
  const groups = format.groupSeparator ? parts[0].split(format.groupSeparator) : [parts[0]];
  if (!/^\d+$/.test(groups[0]) || groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(value => !/^\d{3}$/.test(value)))) return null;
  return Number(`${groups.join('')}${parts.length === 2 ? `.${parts[1]}` : ''}`);
}
function metric(cell, column, numberFormat) {
  const displayValue = String(cell.text ?? cell.value ?? '').trim() || null;
  const result = { value: null, unit: column.unit, sourceMetric: column.label, status: 'unavailable', precision: 'unknown', displayValue, reason: 'not_reported' };
  if (cell.type === 'e' || cell.value == null || /^(?:|—|-|–|N\/A|Error|Hidden|Oculto)$/i.test(clean(cell.value))) return result;
  const numeric = typeof cell.value === 'number';
  let format = numeric ? { decimalSeparator: '.', groupSeparator: '' } : numberFormat;
  if (!format) return { ...result, reason: 'number_format_unverified' };
  let text = String(cell.value).trim();
  if (/^[ \u00a0\u202f]$/.test(format.groupSeparator)) {
    text = text.replace(/[\u00a0\u202f]/g, ' ');
    format = { ...format, groupSeparator: ' ' };
  }
  const rounded = text.match(/^([\d.,]+)\s*(mil|K|M)$/i);
  let value;
  if (rounded) {
    const base = decimal(rounded[1], format);
    if (base === null) invalid('ambiguous_number');
    value = base * (/^m$/i.test(rounded[2]) ? 1000000 : 1000) * (column.unit === 'minor_currency' ? 100 : 1);
  } else if (column.unit === 'minor_currency') {
    try { value = normalizeExcelMoney(numeric ? cell : { ...cell, value: text }, format, column.label); } catch { invalid('ambiguous_money'); }
  } else value = numeric ? cell.value : decimal(text, format);
  if (value === null) return { ...result, reason: 'unrecognized_number' };
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || column.unit === 'minor_currency' && (!Number.isSafeInteger(value) || value > MAX_MONEY_MINOR)) invalid('metric_out_of_range');
  return { ...result, value, status: rounded ? 'estimated' : 'reported', precision: rounded ? 'rounded' : 'exact', reason: null };
}

// Shared by the protected workbook/CSV path and visible-table path. Unknown
// columns (names, comments, contacts, generic Results) never leave this function.
export function normalizeBrowserMetricTable({ columns, rows, locale, expectedScope, numberFormat = null, expectedRemoteId = null, query = null, date1904 = false }) {
  if (!/^(?:es|en)(?:-|$)/i.test(locale || '')) invalid('unknown_ui_language');
  const format = formatOf(numberFormat);
  if (!Array.isArray(columns) || columns.length > 200 || !Array.isArray(rows) || rows.length > 100000) invalid('export_content_limit');
  const headers = columns.map(value => clean(normalizeExcelText(cellOf(value), 'Columna', 200))), mapped = mappedColumns(headers);
  for (const column of mapped) if (cellOf(columns[column.index]).formula) invalid('mapped_formula');
  const safeColumns = mapped.map(({ label }) => label), seen = new Set();
  let actualScope = expectedScope || null;
  const normalizedRows = rows.map(raw => {
    if (!Array.isArray(raw) || raw.length > 200) invalid('export_content_limit');
    const cells = Object.fromEntries(mapped.map(column => {
      const cell = cellOf(raw[column.index]);
      if (cell.formula || typeof cell.value === 'string' && /^\s*=/.test(cell.value)) invalid('mapped_formula');
      return [column.key, cell];
    }));
    let ids;
    try { ids = mapped.filter(column => column.key === 'id').map(column => normalizeExcelIdentifier(cellOf(raw[column.index]))); }
    catch { invalid('identifier_precision_lost'); }
    if (ids.some(id => !/^\d{1,30}$/.test(id || ''))) invalid('invalid_remote_id', 'ACCOUNT_MISMATCH');
    const candidates = expectedRemoteId == null ? ids : ids.filter(id => id === String(expectedRemoteId));
    if (candidates.length !== 1) invalid('foreign_remote_id', 'ACCOUNT_MISMATCH');
    const id = candidates[0];
    let periodStart, periodEnd;
    try { periodStart = normalizeExcelDate(cells.periodStart, { date1904, dateFormat: 'ISO' }).occurredOn; periodEnd = normalizeExcelDate(cells.periodEnd, { date1904, dateFormat: 'ISO' }).occurredOn; } catch { invalid('invalid_reporting_period', 'SPEC_MISMATCH'); }
    if (periodStart > periodEnd || query && (query.dimension === 'daily' ? periodStart !== periodEnd || periodStart < query.periodStart || periodEnd > query.periodEnd : periodStart !== query.periodStart || periodEnd !== query.periodEnd)) invalid('reporting_period_mismatch', 'SPEC_MISMATCH');
    if (cells.scope) {
      const scope = browserMetricScope(cells.scope.value);
      if (!scope || expectedScope && scope !== expectedScope && scope !== 'mixed' || actualScope && actualScope !== scope && actualScope !== expectedScope) invalid('scope_mismatch', 'SPEC_MISMATCH');
      actualScope = scope;
    }
    const dimensions = {};
    for (const key of ['publisherPlatform', 'placement', 'age', 'gender', 'country']) if (cells[key]) {
      const value = clean(normalizeExcelText(cells[key], key, 100));
      if (!value || /https?:|@|[<>]/i.test(value)) invalid('invalid_dimension');
      dimensions[key] = value;
    }
    if (query?.dimension === 'daily') dimensions.date = periodStart;
    const required = { placement: ['publisherPlatform', 'placement'], age_gender: ['age', 'gender'], country: ['country'] }[query?.dimension] || [];
    if (required.some(key => !dimensions[key])) invalid('missing_dimension');
    const identity = JSON.stringify([id, periodStart, periodEnd, dimensions]);
    if (seen.has(identity)) invalid('duplicate_reporting_row', 'SPEC_MISMATCH');
    seen.add(identity);
    const values = Object.fromEntries(mapped.filter(column => column.unit).map(column => [column.key, metric(cells[column.key], column, format)]));
    return { id, periodStart, periodEnd, dimensions, values };
  });
  if (query?.dimension === 'aggregate' && normalizedRows.length > 1) invalid('ambiguous_aggregate', 'SPEC_MISMATCH');
  const extractHash = createHash('sha256').update(JSON.stringify({ columns: safeColumns, rows: normalizedRows })).digest('hex');
  return { columns: safeColumns, rows: normalizedRows, locale, numberFormat: format, scope: actualScope, extractHash };
}

export async function parseBrowserMetricExport(bytes, { filename, locale, expectedScope, numberFormat = null, expectedRemoteId = null, query = null } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) invalid('export_byte_limit');
  if (typeof filename !== 'string' || !/\.(csv|xlsx)$/i.test(filename)) invalid('export_format');
  let columns, rows, date1904 = false;
  if (/\.xlsx$/i.test(filename)) {
    const catalog = await readExcel(bytes, { filename, mode: 'catalog' });
    if (catalog.sheets.length !== 1) invalid('ambiguous_export_sheet');
    const selected = await readExcel(bytes, { filename, sheetName: catalog.sheets[0].name, headerRow: 1, maxRows: 100001 });
    columns = selected.rows.find(row => row.rowNumber === 1)?.cells;
    rows = selected.rows.filter(row => row.rowNumber > 1).map(row => row.cells);
    date1904 = selected.date1904;
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { invalid('export_utf8_required'); }
    if (text.includes('\u0000')) invalid('export_utf8_required');
    const candidates = [];
    for (const separator of [',', ';']) {
      const book = XLSX.read(text, { type: 'string', raw: true, FS: separator, cellHTML: false, cellFormula: true });
      if (book.SheetNames.length !== 1) continue;
      const sheet = book.Sheets[book.SheetNames[0]], range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
      const headers = Array.from({ length: Math.min(range.e.c + 1, 201) }, (_, c) => clean(sheet[XLSX.utils.encode_cell({ r: 0, c })]?.v));
      try { mappedColumns(headers); } catch { continue; }
      if (range.e.r > 100000 || range.e.c >= 200) invalid('export_content_limit');
      const matrix = Array.from({ length: range.e.r + 1 }, (_, r) => Array.from({ length: range.e.c + 1 }, (_, c) => {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        return { value: cell?.v ?? null, text: cell?.w ?? String(cell?.v ?? ''), type: cell?.t ?? 'z', formula: cell?.f ?? null };
      }));
      candidates.push(matrix);
    }
    if (candidates.length !== 1) invalid('ambiguous_csv_separator');
    [columns, ...rows] = candidates[0];
  }
  return normalizeBrowserMetricTable({ columns, rows, locale, expectedScope, numberFormat, expectedRemoteId, query, date1904 });
}
