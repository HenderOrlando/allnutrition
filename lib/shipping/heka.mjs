import { fail } from '../validation-core.mjs';
import { MAX_MONEY_MINOR, parseMoneyMinor } from '../business/money.mjs';
import { writeExcelSheets } from '../business/excel.mjs';

export const HEKA_ADAPTER_VERSION = 'heka-classic-v1';
const MAX_ROWS = 10_000;
const MAX_BYTES = 10 * 1024 * 1024;
const CARRIERS = new Set(['SERVIENTREGA', 'ENVIA', 'TCC', 'INTERRAPIDISIMO', 'COORDINADORA', 'REFERIDOS', 'HEKA']);
const GUIDE_FIELDS = ['documentId', 'id_heka', 'numeroGuia', 'transportadora', 'estado', 'estadoTransportadora', 'referencia', 'ultima_actualizacion', 'fecha', 'timeline', 'seguro', 'valor', 'costo_envio', 'type'];
const HEADER_FIELDS = ['id_user', 'centro_de_costo', 'guiasPagadas', 'fecha', 'total_pagado', 'comision_heka', 'cantidad_pagos', 'timeline'];
const LINE_FIELDS = ['documentId', 'carrierCollection', 'idPaquetePago', 'REMITENTE', 'TRANSPORTADORA', 'GUIA', 'FECHA', 'fechaPago', 'momentoParticularPago', 'RECAUDO', 'ENVÍO TOTAL', 'COMISION HEKA', 'TOTAL A PAGAR', 'referencia'];
const invalid = () => fail('Lectura Heka inválida o incompleta.');
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (Object.keys(value).some(key => !fields.includes(key))) invalid();
  return value;
}
function string(value, max = 256, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  // Provider identifiers are opaque: neither trim nor coerce numbers.
  return value;
}
function list(value) { if (!Array.isArray(value)) invalid(); return value; }
function integer(value, optional = false) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid();
  date(value.slice(0, 10));
  const time = Date.parse(value);
  if (!Number.isFinite(time) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid();
  return new Date(time).toISOString();
}
function timestamp(value, optional = false) {
  if (optional && value == null) return null;
  integer(value);
  if (!Number.isFinite(new Date(value).getTime()) || value > 253402300799999) invalid();
  return value;
}
function observedTimestamp(value, optional = true) {
  if (value === null || optional && value === undefined) return null;
  object(value, ['seconds', 'nanoseconds']);
  if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.seconds) || value.seconds < 0 || value.seconds > 253402300799
    || !Number.isSafeInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds > 999999999) invalid();
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}
function observedTimestampIso(value) {
  return value === null ? null : new Date(value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000)).toISOString();
}
function money(value, optional = false, nonnegative = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    value = String(value);
  }
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) invalid();
  const result = parseMoneyMinor(value, { decimalSeparator: '.', groupSeparator: '' });
  if (nonnegative && result < 0) invalid();
  return result;
}
function safeSum(values) {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) invalid();
  return Number(sum);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => JSON.stringify(canonical(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const lineKey = line => JSON.stringify([line.carrierCollection, line.documentId]);
const sortLines = lines => lines.sort((a, b) => compare(a.carrierCollection, b.carrierCollection) || compare(a.documentId, b.documentId));
function unique(values, key) {
  const seen = new Map();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id) && fingerprint(seen.get(id)) !== fingerprint(value)) invalid();
    seen.set(id, value);
  }
  return [...seen.values()];
}
function paidDate(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{2}-\d{2}-\d{4}$/.test(value)) invalid();
  return date(`${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`);
}

export function normalizeHekaIdentity(identity) {
  object(identity, ['userId', 'centerCost']);
  return { userId: string(identity.userId), centerCost: string(identity.centerCost) };
}

export function normalizeHekaQuery(query) {
  object(query, ['queryId', 'from', 'to', 'tracking']);
  const from = date(query.from), to = date(query.to);
  const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (span < 0 || span > 30 * 86400000) invalid();
  return { queryId: string(query.queryId), from, to, tracking: string(query.tracking, 256, true) ?? '' };
}

function normalizeLine(raw, account, packageId = null) {
  object(raw, LINE_FIELDS);
  if (!CARRIERS.has(raw.carrierCollection) || raw.REMITENTE !== account.centerCost) invalid();
  if (packageId ? raw.idPaquetePago !== packageId : raw.idPaquetePago != null && raw.idPaquetePago !== '') invalid();
  const optional = packageId === null;
  const result = {
    documentId: string(raw.documentId), carrierCollection: raw.carrierCollection,
    tracking: string(raw.GUIA), carrier: string(raw.TRANSPORTADORA), reference: string(raw.referencia, 1000, true),
    paidDate: paidDate(raw.FECHA, optional), paymentDateObserved: raw.fechaPago == null ? null : date(raw.fechaPago),
    lineTimestamp: timestamp(raw.momentoParticularPago, optional),
    grossMinor: money(raw.RECAUDO, optional), shippingMinor: money(raw['ENVÍO TOTAL'], optional),
    commissionMinor: money(raw['COMISION HEKA'], optional), netMinor: money(raw['TOTAL A PAGAR'], optional),
  };
  if (result.paymentDateObserved !== null && result.paidDate !== null && result.paymentDateObserved !== result.paidDate) invalid();
  if (result.grossMinor !== null && result.shippingMinor !== null && result.netMinor !== null
    && BigInt(result.netMinor) !== BigInt(result.grossMinor) - BigInt(result.shippingMinor)) invalid();
  return result;
}
function normalizePackage(raw, account) {
  object(raw, ['idPaquetePago', 'header', 'headerAfter', 'lines']);
  const id = string(raw.idPaquetePago);
  const header = object(raw.header, HEADER_FIELDS);
  object(raw.headerAfter, HEADER_FIELDS);
  if (fingerprint(header) !== fingerprint(raw.headerAfter) || header.id_user !== account.userId || header.centro_de_costo !== account.centerCost) invalid();
  const headerTimestampObserved = observedTimestamp(header.fecha);
  const declaredTracking = list(header.guiasPagadas).map(value => string(value)).sort(compare);
  const lines = sortLines(unique(list(raw.lines).map(line => normalizeLine(line, account, id)), lineKey));
  const settlementDate = lines[0]?.paidDate;
  if (!lines.length || lines.some(line => line.paidDate !== settlementDate)) invalid();
  if (fingerprint(declaredTracking) !== fingerprint(lines.map(line => line.tracking).sort(compare))) invalid();
  const totalPaidMinor = money(header.total_pagado), commissionMinor = money(header.comision_heka);
  const grossMinor = safeSum(lines.map(line => line.grossMinor));
  const shippingMinor = safeSum(lines.map(line => line.shippingMinor));
  const netMinor = safeSum(lines.map(line => line.netMinor));
  if (netMinor !== totalPaidMinor || safeSum(lines.map(line => line.commissionMinor)) !== commissionMinor) invalid();
  return { id, headerTimestampObserved, settlementDate, totalPaidMinor, commissionMinor,
    quantityInfo: integer(header.cantidad_pagos, true), creationTimeline: timestamp(header.timeline, true),
    declaredTracking, grossMinor, shippingMinor, netMinor, lines };
}
function normalizeGuide(raw) {
  object(raw, GUIDE_FIELDS);
  const createdTimeline = timestamp(raw.timeline, true);
  const updatedTimestampObserved = observedTimestamp(raw.ultima_actualizacion);
  return {
    documentId: string(raw.documentId), externalShipmentId: string(raw.id_heka), tracking: string(raw.numeroGuia),
    carrier: string(raw.transportadora), rawStatus: string(raw.estadoTransportadora, 256, true),
    rawShipmentStatus: string(raw.estado, 256, true), shipmentReference: string(raw.referencia, 1000, true),
    updatedTimestampObserved, reportAsOf: observedTimestampIso(updatedTimestampObserved),
    createdAtObserved: createdTimeline === null ? null : new Date(createdTimeline).toISOString(), createdTimeline,
    insuredValueMinor: money(raw.seguro, true, true), expectedCollectionMinor: money(raw.valor, true, true),
    shippingInformationalMinor: money(raw.costo_envio, true), serviceType: string(raw.type, 256, true),
    creationDateRaw: string(raw.fecha, 256, true),
  };
}

export function normalizeHekaSnapshot(payload) {
  // Measure the entire wire input before selecting any fields. Never silently truncate.
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { invalid(); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) invalid();
  object(payload, ['schemaVersion', 'adapterVersion', 'query', 'account', 'capturedAt', 'source', 'complete', 'guides', 'packages', 'pending']);
  if (payload.schemaVersion !== 1 || payload.adapterVersion !== HEKA_ADAPTER_VERSION || payload.source !== 'server' || payload.complete !== true) invalid();
  const query = normalizeHekaQuery(payload.query), account = normalizeHekaIdentity(payload.account);
  const rawGuides = list(payload.guides), rawPackages = list(payload.packages);
  object(payload.pending, ['cutoff', 'lines']);
  const rawPending = list(payload.pending.lines);
  let rawCount = rawGuides.length + rawPending.length;
  if (rawPackages.length > MAX_ROWS) invalid();
  for (const entry of rawPackages) { object(entry, ['idPaquetePago', 'header', 'headerAfter', 'lines']); rawCount += list(entry.lines).length; }
  if (rawCount > MAX_ROWS) invalid();
  const guides = unique(rawGuides.map(normalizeGuide), guide => guide.documentId).sort((a, b) => compare(a.documentId, b.documentId));
  const packages = rawPackages.map(entry => normalizePackage(entry, account)).sort((a, b) => compare(a.id, b.id));
  if (new Set(packages.map(entry => entry.id)).size !== packages.length) invalid();
  const allPaidKeys = packages.flatMap(entry => entry.lines.map(lineKey));
  const paidKeys = new Set(allPaidKeys);
  if (paidKeys.size !== allPaidKeys.length) invalid();
  const pendingLines = sortLines(unique(rawPending.map(line => normalizeLine(line, account)), lineKey));
  if (pendingLines.some(line => paidKeys.has(lineKey(line)))) invalid();
  const cutoff = instant(payload.pending.cutoff);
  if (cutoff !== new Date(Date.parse(`${query.to}T00:00:00Z`) + 86400000).toISOString()) invalid();
  return { schemaVersion: 1, adapterVersion: HEKA_ADAPTER_VERSION, query, account,
    capturedAt: instant(payload.capturedAt), source: 'server', complete: true, guides, packages,
    pending: { cutoff, lines: pendingLines }, rowCount: guides.length + allPaidKeys.length + pendingLines.length };
}

const TRACKING_ORIGIN_FIELDS = ['sheet', 'rowNumber', 'documentId', 'externalShipmentId', 'tracking', 'carrier', 'updatedTimestampObserved'];
const PAID_ORIGIN_FIELDS = ['sheet', 'rowNumber', 'documentId', 'carrierCollection', 'externalShipmentId', 'tracking', 'carrier', 'reference', 'paidDate', 'paymentDateObserved', 'lineTimestamp', 'grossMinor', 'shippingMinor', 'commissionMinor', 'netMinor'];
const PACKAGE_ORIGIN_FIELDS = ['id', 'headerTimestampObserved', 'settlementDate', 'grossMinor', 'shippingMinor', 'commissionMinor', 'netMinor', 'quantityInfo', 'creationTimeline', 'declaredTracking', 'rows'];
const ORIGIN_FIELDS = ['format', 'snapshotId', 'sourceHash', 'adapterVersion', 'schemaVersion', 'sourceId', 'capturedAt', 'query', 'accountFingerprint', 'fileHash', 'trackingRows', 'packages'];
const carrierIdentity = value => value.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
const guideIdentity = row => JSON.stringify([carrierIdentity(row.carrier), row.tracking.trim()]);
const shipmentIdentity = row => row.externalShipmentId ? `shipment:${row.externalShipmentId.trim()}` : `guide:${guideIdentity(row)}`;
const exactFields = (value, fields) => {
  object(value, fields);
  if (fields.some(field => !Object.hasOwn(value, field))) invalid();
};
function minor(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MONEY_MINOR) invalid();
  return value;
}
function decimalMinor(value) {
  if (value === null) return '';
  minor(value);
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function guideMatches(rows) {
  const matches = new Map();
  for (const row of rows) {
    const key = guideIdentity(row);
    if (!matches.has(key)) matches.set(key, row.externalShipmentId);
    else matches.set(key, null);
  }
  return matches;
}

// Self-contained commercial provenance: restoration never depends on an expiring bridge row.
export function validateHekaImportOrigin(origin, { sourceId, fileHash } = {}) {
  exactFields(origin, ORIGIN_FIELDS);
  if (origin.format !== 'heka-import-v1' || origin.schemaVersion !== 1 || origin.adapterVersion !== HEKA_ADAPTER_VERSION) invalid();
  string(origin.snapshotId, 100); string(origin.sourceId, 100);
  if (sourceId !== undefined && sourceId !== origin.sourceId || fileHash !== undefined && fileHash !== origin.fileHash) invalid();
  for (const key of ['sourceHash', 'accountFingerprint', 'fileHash']) if (!/^[a-f0-9]{64}$/.test(origin[key]) || typeof origin[key] !== 'string') invalid();
  instant(origin.capturedAt);
  exactFields(origin.query, ['queryId', 'from', 'to', 'tracking']);
  normalizeHekaQuery(origin.query);
  if (typeof origin.query.tracking !== 'string') invalid();
  const trackingRows = list(origin.trackingRows), packages = list(origin.packages);
  if (trackingRows.length + packages.length > MAX_ROWS) invalid();
  let count = trackingRows.length;
  const rowRefs = new Set(), guideDocuments = new Set(), paidDocuments = new Set(), packageIds = new Set();
  const rowRef = (row, sheet) => {
    if (row.sheet !== sheet || !Number.isInteger(row.rowNumber) || row.rowNumber < 2 || row.rowNumber > MAX_ROWS + 1) invalid();
    const key = `${sheet}:${row.rowNumber}`;
    if (rowRefs.has(key)) invalid();
    rowRefs.add(key);
    string(row.documentId); string(row.tracking); string(row.carrier);
  };
  for (const row of trackingRows) {
    exactFields(row, TRACKING_ORIGIN_FIELDS); rowRef(row, 'tracking'); string(row.externalShipmentId);
    observedTimestamp(row.updatedTimestampObserved, false);
    if (guideDocuments.has(row.documentId)) invalid();
    guideDocuments.add(row.documentId);
  }
  const matches = guideMatches(trackingRows);
  for (const entry of packages) {
    exactFields(entry, PACKAGE_ORIGIN_FIELDS);
    string(entry.id);
    if (packageIds.has(entry.id.trim())) invalid();
    packageIds.add(entry.id.trim());
    const settlementDate = date(entry.settlementDate);
    observedTimestamp(entry.headerTimestampObserved, false);
    if (entry.quantityInfo !== null) integer(entry.quantityInfo);
    if (entry.creationTimeline !== null) timestamp(entry.creationTimeline);
    for (const key of ['grossMinor', 'shippingMinor', 'commissionMinor', 'netMinor']) minor(entry[key]);
    const rows = list(entry.rows), declared = list(entry.declaredTracking).map(value => string(value));
    count += rows.length;
    if (!rows.length || count > MAX_ROWS || declared.length !== rows.length) invalid();
    for (const row of rows) {
      exactFields(row, PAID_ORIGIN_FIELDS); rowRef(row, 'settlements');
      if (!CARRIERS.has(row.carrierCollection)) invalid();
      const documentKey = lineKey(row);
      if (paidDocuments.has(documentKey)) invalid();
      paidDocuments.add(documentKey);
      if (row.externalShipmentId !== null) string(row.externalShipmentId);
      if (row.externalShipmentId !== (matches.get(guideIdentity(row)) ?? null)) invalid();
      if (row.reference !== null) string(row.reference, 1000);
      if (date(row.paidDate) !== settlementDate) invalid();
      if (row.paymentDateObserved !== null && date(row.paymentDateObserved) !== settlementDate) invalid();
      timestamp(row.lineTimestamp);
      for (const key of ['grossMinor', 'shippingMinor', 'commissionMinor', 'netMinor']) minor(row[key]);
      if (BigInt(row.netMinor) !== BigInt(row.grossMinor) - BigInt(row.shippingMinor)) invalid();
    }
    if (fingerprint([...declared].sort(compare)) !== fingerprint(rows.map(row => row.tracking).sort(compare))) invalid();
    for (const key of ['grossMinor', 'shippingMinor', 'commissionMinor', 'netMinor']) if (safeSum(rows.map(row => row[key])) !== entry[key]) invalid();
  }
  if (!count || Buffer.byteLength(JSON.stringify(origin), 'utf8') > MAX_BYTES) invalid();
  return structuredClone(origin);
}

const TRACKING_COLUMNS = [
  ['externalShipmentId', 'externalShipmentId'], ['tracking', 'tracking'], ['carrier', 'carrier'],
  ['rawStatus', 'rawStatus'], ['rawShipmentStatus', 'rawShipmentStatus'], ['shipmentReference', 'shipmentReference'],
  ['reportAsOf', 'reportAsOf'], ['insuredValue', 'insuredValue'], ['expectedCollection', 'expectedCollection'],
  ['documentId', 'ignore'], ['createdAtObserved', 'ignore'], ['createdTimeline', 'ignore'], ['creationDateRaw', 'ignore'],
  ['shippingInformational', 'ignore'], ['serviceType', 'ignore'],
  ['updatedTimestampSecondsObserved', 'ignore'], ['updatedTimestampNanosecondsObserved', 'ignore'],
];
const SETTLEMENT_COLUMNS = [
  ['externalShipmentId', 'externalShipmentId'], ['tracking', 'tracking'], ['carrier', 'carrier'],
  ['settlementExternalId', 'settlementExternalId'], ['settlementDate', 'settlementDate'],
  ['settlementGross', 'settlementGross'], ['settlementNet', 'settlementNet'],
  ['documentId', 'ignore'], ['carrierCollection', 'ignore'], ['reference', 'ignore'], ['paidDate', 'ignore'],
  ['paymentDateObserved', 'ignore'], ['lineTimestamp', 'ignore'], ['RECAUDO', 'ignore'], ['ENVÍO TOTAL', 'ignore'],
  ['COMISION HEKA', 'ignore'], ['TOTAL A PAGAR', 'ignore'],
];
const sheetConfig = (sheetName, definitions, enabled) => ({
  sheetName, enabled, headerRow: 1, purpose: sheetName, layout: 'item_rows',
  dateFormat: 'ISO', decimalSeparator: '.', groupSeparator: '',
  columns: definitions.map(([header, destination], index) => ({ index, header: carrierIdentity(header), destination })),
});

export function createHekaWorkbook(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.adapterVersion !== HEKA_ADAPTER_VERSION || snapshot.complete !== true || snapshot.source !== 'server') invalid();
  const trackingRows = snapshot.guides.map((guide, index) => ({
    sheet: 'tracking', rowNumber: index + 2, documentId: guide.documentId,
    externalShipmentId: guide.externalShipmentId, tracking: guide.tracking, carrier: guide.carrier,
    updatedTimestampObserved: guide.updatedTimestampObserved,
  }));
  const matches = guideMatches(trackingRows);
  let paidRowNumber = 2;
  const packages = snapshot.packages.map(entry => ({
    ...Object.fromEntries(PACKAGE_ORIGIN_FIELDS.filter(key => key !== 'rows').map(key => [key, entry[key]])),
    rows: entry.lines.map(line => ({
      sheet: 'settlements', rowNumber: paidRowNumber++, ...line,
      externalShipmentId: matches.get(guideIdentity(line)) ?? null,
    })),
  }));
  // Reuse the restore validator before writing any immutable file (including canonical ID collisions).
  validateHekaImportOrigin({
    format: 'heka-import-v1', snapshotId: 'workbook', sourceHash: '0'.repeat(64), adapterVersion: HEKA_ADAPTER_VERSION,
    schemaVersion: 1, sourceId: 'workbook', capturedAt: snapshot.capturedAt, query: snapshot.query,
    accountFingerprint: '0'.repeat(64), fileHash: '0'.repeat(64), trackingRows, packages,
  });
  const tracking = [TRACKING_COLUMNS.map(([header]) => header), ...snapshot.guides.map(guide => [
    guide.externalShipmentId, guide.tracking, guide.carrier, guide.rawStatus, guide.rawShipmentStatus, guide.shipmentReference,
    guide.reportAsOf, decimalMinor(guide.insuredValueMinor), decimalMinor(guide.expectedCollectionMinor),
    guide.documentId, guide.createdAtObserved, guide.createdTimeline, guide.creationDateRaw,
    decimalMinor(guide.shippingInformationalMinor), guide.serviceType,
    guide.updatedTimestampObserved?.seconds, guide.updatedTimestampObserved?.nanoseconds,
  ].map(value => value ?? ''))];
  const settlements = [SETTLEMENT_COLUMNS.map(([header]) => header)];
  for (const entry of packages) {
    const grossByShipment = new Map();
    for (const row of entry.rows) {
      const key = shipmentIdentity(row);
      grossByShipment.set(key, (grossByShipment.get(key) ?? 0n) + BigInt(row.grossMinor));
    }
    for (const row of entry.rows) settlements.push([
      row.externalShipmentId ?? '', row.tracking, row.carrier, entry.id, entry.settlementDate,
      decimalMinor(Number(grossByShipment.get(shipmentIdentity(row)))), decimalMinor(entry.netMinor),
      row.documentId, row.carrierCollection, row.reference ?? '', row.paidDate, row.paymentDateObserved ?? '', row.lineTimestamp ?? '',
      decimalMinor(row.grossMinor), decimalMinor(row.shippingMinor), decimalMinor(row.commissionMinor), decimalMinor(row.netMinor),
    ]);
  }
  return {
    bytes: writeExcelSheets([{ name: 'tracking', rows: tracking }, { name: 'settlements', rows: settlements }]),
    config: { formatVersion: 2, sheets: [
      sheetConfig('tracking', TRACKING_COLUMNS, trackingRows.length > 0),
      sheetConfig('settlements', SETTLEMENT_COLUMNS, packages.length > 0),
    ] },
    manifest: { trackingRows, packages },
  };
}
