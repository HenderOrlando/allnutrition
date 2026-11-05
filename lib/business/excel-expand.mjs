import { DOMParser, XMLSerializer, DOMImplementation } from '@xmldom/xmldom';
import { zipSync } from 'fflate';
import { posix } from 'node:path';
import { validateExcelZip } from './excel-zip.mjs';

export const OPERATION_HEADERS = Object.freeze(['ID GASTO','FECHA GASTO','CONCEPTO','VALOR','PROVEEDOR','REFERENCIA','NOTAS']);
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const EXTENDED = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
function fail(message, code = 'EXCEL_INVALID', status = 400) { throw Object.assign(new Error(message), { code, status }); }
function parse(bytes, label) {
  if (!bytes) fail(`Faltan los metadatos ${label}.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // This is a declaration rejection, never a rewrite of user XML. The parser
  // has no resolver; reject DTDs before parsing rather than trusting defaults.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('No se admiten declaraciones DOCTYPE ni entidades externas en el Excel.');
  let document;
  try { document = new DOMParser({ onError: () => { throw new Error('XML inválido'); } }).parseFromString(text, 'application/xml'); }
  catch { fail(`Los metadatos ${label} no contienen XML válido.`); }
  if (document.doctype || !document.documentElement) fail(`Los metadatos ${label} no son válidos.`);
  return document;
}
const nodes = (document, namespace, name) => Array.from(document.getElementsByTagNameNS(namespace, name));
const encode = document => Buffer.from(new XMLSerializer().serializeToString(document), 'utf8');
function element(document, namespace, name, attributes = {}) {
  const node = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
function partForRelationship(relationship) {
  if (!relationship || relationship.getAttribute('TargetMode') === 'External') fail('La relación de la hoja no es interna.');
  const target = relationship.getAttribute('Target');
  if (!target || target.includes('\\') || target.includes('?') || target.includes('#')) fail('La relación de la hoja no es válida.');
  const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join('xl', target));
  if (!path.startsWith('xl/') || path.includes('../')) fail('La relación de la hoja sale del libro.');
  return path;
}
function existingHeaders(entries, relationship) {
  const sheet = parse(entries[partForRelationship(relationship)], 'de la hoja de operación');
  let strings = null;
  const row = nodes(sheet, MAIN, 'row').find(item => item.getAttribute('r') === '1');
  if (!row) return [];
  const result = [];
  for (const cell of nodes(row, MAIN, 'c')) {
    const address = cell.getAttribute('r'), match = /^([A-Z]+)1$/.exec(address);
    if (!match) continue;
    let column = 0;
    for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
    const type = cell.getAttribute('t');
    let value;
    if (type === 'inlineStr') value = nodes(cell, MAIN, 't').map(text => text.textContent).join('');
    else {
      value = nodes(cell, MAIN, 'v')[0]?.textContent ?? '';
      if (type === 's') {
        strings ??= nodes(parse(entries['xl/sharedStrings.xml'], 'de textos compartidos'), MAIN, 'si').map(item => nodes(item, MAIN, 't').map(text => text.textContent).join(''));
        value = strings[Number(value)];
      }
    }
    result[column - 1] = value;
  }
  return result;
}
function operationWorksheet() {
  const document = new DOMImplementation().createDocument(MAIN, 'worksheet', null), root = document.documentElement;
  root.appendChild(element(document, MAIN, 'dimension', { ref: 'A1:G1' }));
  const data = root.appendChild(element(document, MAIN, 'sheetData'));
  const row = data.appendChild(element(document, MAIN, 'row', { r: 1 }));
  OPERATION_HEADERS.forEach((header, index) => {
    const cell = row.appendChild(element(document, MAIN, 'c', { r: `${String.fromCharCode(65 + index)}1`, t: 'inlineStr' }));
    const text = cell.appendChild(element(document, MAIN, 'is')).appendChild(element(document, MAIN, 't'));
    text.appendChild(document.createTextNode(header));
  });
  return encode(document);
}
function updateApp(entries, name) {
  if (!entries['docProps/app.xml']) return;
  const document = parse(entries['docProps/app.xml'], 'de propiedades');
  const pairs = nodes(document, EXTENDED, 'HeadingPairs')[0];
  const variants = pairs ? nodes(pairs, VT, 'variant') : [];
  let offset = 0, worksheetOffset = null, count = null, countNode = null;
  for (let index = 0; index + 1 < variants.length; index += 2) {
    const label = nodes(variants[index], VT, 'lpstr')[0]?.textContent;
    const number = nodes(variants[index + 1], VT, 'i4')[0];
    const value = Number(number?.textContent);
    if (!Number.isSafeInteger(value) || value < 0) fail('El conteo de propiedades del libro no es válido.');
    if (label === 'Worksheets') { worksheetOffset = offset; count = value; countNode = number; }
    offset += value;
  }
  if (countNode) countNode.textContent = String(count + 1);
  const titles = nodes(document, EXTENDED, 'TitlesOfParts')[0];
  const vector = titles && nodes(titles, VT, 'vector')[0];
  if (vector && worksheetOffset !== null) {
    const values = nodes(vector, VT, 'lpstr');
    const title = element(document, VT, 'vt:lpstr');
    title.appendChild(document.createTextNode(name));
    vector.insertBefore(title, values[worksheetOffset + count] ?? null);
    vector.setAttribute('size', String(values.length + 1));
  }
  if (countNode || vector && worksheetOffset !== null) entries['docProps/app.xml'] = encode(document);
}
export function expandWorkbook(bytes, { filename }) {
  if (!/\.xlsx$/i.test(filename)) fail('Descarga la plantilla XLSX separada para este formato.', 'EXCEL_EXPANSION_FORMAT', 415);
  const entries = validateExcelZip(bytes, 'xlsx', { retain: true });
  for (const [name, value] of Object.entries(entries)) {
    if (/\.(?:xml|rels)$/i.test(name) && /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value.toString('utf8'))) fail('No se admiten declaraciones DOCTYPE ni entidades externas en el Excel.');
  }
  const workbook = parse(entries['xl/workbook.xml'], 'del libro');
  const relationships = parse(entries['xl/_rels/workbook.xml.rels'], 'de relaciones');
  const content = parse(entries['[Content_Types].xml'], 'de tipos');
  if (workbook.documentElement.namespaceURI !== MAIN || relationships.documentElement.namespaceURI !== REL || content.documentElement.namespaceURI !== CONTENT) fail('Los namespaces del libro no son compatibles.');
  const sheets = nodes(workbook, MAIN, 'sheet'), links = nodes(relationships, REL, 'Relationship');
  if (sheets.length > 50) fail('El Excel supera el máximo de 50 hojas.', 'EXCEL_CONTENT_LIMIT', 413);
  const name = 'GASTOS OPERACION';
  const existing = sheets.find(sheet => sheet.getAttribute('name').toLocaleUpperCase('es') === name);
  if (existing) {
    const id = existing.getAttributeNS(OFFICE_REL, 'id');
    const headers = existingHeaders(entries, links.find(link => link.getAttribute('Id') === id));
    if (headers.length !== OPERATION_HEADERS.length || !OPERATION_HEADERS.every((header, index) => headers[index] === header)) fail('GASTOS OPERACION ya existe con otros encabezados. Configura esa hoja sin sobrescribirla.', 'EXCEL_OPERATION_SHEET_CONFLICT');
    return bytes;
  }
  if (sheets.length === 50) fail('Agregar operación superaría el máximo de 50 hojas.', 'EXCEL_CONTENT_LIMIT', 413);
  const sheetIds = new Set(sheets.map(sheet => sheet.getAttribute('sheetId'))), relationshipIds = new Set(links.map(link => link.getAttribute('Id')));
  let sheetId = 1, relationshipId = 1, partId = 1;
  while (sheetIds.has(String(sheetId))) sheetId++;
  while (relationshipIds.has(`rId${relationshipId}`)) relationshipId++;
  const registeredParts = new Set(nodes(content, CONTENT, 'Override').map(node => node.getAttribute('PartName')));
  const registeredTargets = new Set(links.filter(link => link.getAttribute('TargetMode') !== 'External').map(link => link.getAttribute('Target')));
  while (entries[`xl/worksheets/sheet${partId}.xml`] || registeredParts.has(`/xl/worksheets/sheet${partId}.xml`) || registeredTargets.has(`worksheets/sheet${partId}.xml`) || registeredTargets.has(`/xl/worksheets/sheet${partId}.xml`)) partId++;
  const part = `xl/worksheets/sheet${partId}.xml`, id = `rId${relationshipId}`;
  const container = nodes(workbook, MAIN, 'sheets')[0];
  if (!container) fail('El libro no contiene el registro de hojas.');
  const sheet = element(workbook, MAIN, 'sheet', { name, sheetId });
  sheet.setAttributeNS(OFFICE_REL, 'r:id', id);
  container.appendChild(sheet);
  relationships.documentElement.appendChild(element(relationships, REL, 'Relationship', { Id: id, Type: `${OFFICE_REL}/worksheet`, Target: `worksheets/sheet${partId}.xml` }));
  content.documentElement.appendChild(element(content, CONTENT, 'Override', { PartName: `/${part}`, ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' }));
  entries[part] = operationWorksheet();
  entries['xl/workbook.xml'] = encode(workbook);
  entries['xl/_rels/workbook.xml.rels'] = encode(relationships);
  entries['[Content_Types].xml'] = encode(content);
  updateApp(entries, name);
  const output = zipSync(entries, { level: 6 });
  if (output.byteLength > 10 * 1024 * 1024) fail('La copia ampliada supera 10 MiB. Descarga la plantilla separada.', 'EXCEL_FILE_LIMIT', 413);
  return output;
}
