import { createHash } from 'node:crypto';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { validateEvidence } from './contracts.mjs';

const scalar = value => value == null || ['string','number','boolean'].includes(typeof value);
const stableId = fact => `ev_${createHash('sha256').update(JSON.stringify(fact)).digest('hex').slice(0,32)}`;
const canonicalHref = candidate => {
  if (typeof candidate === 'string') {
    const url = new URL(candidate, 'https://assistant.invalid');
    if (url.origin !== 'https://assistant.invalid' || url.pathname !== '/admin') return null;
    return adminHref(readAdminView(url.searchParams));
  }
  return adminHref(readAdminView(candidate));
};

/** Build a public citation from a reader-owned fact, never from model supplied data. */
export function createAssistantEvidence({ domain, entityId = null, recordVersion = null, field, label, value, unit = null, formattedValue = null, asOf = null, asOfPrecision = 'unknown', coverage = null, href = null }) {
  if (!scalar(value)) throw new TypeError('La evidencia debe ser un valor escalar.');
  const normalizedHref = href == null ? null : canonicalHref(href);
  const sourceCoverage = coverage || { state: value == null ? 'unknown' : 'complete', knownCount: null, eligibleCount: null, excludedCount: null, reasons: [] };
  const truncated = typeof value === 'string' && value.length > 2000;
  const projectedValue = truncated ? value.slice(0, 2000) : value;
  const projectedCoverage = truncated ? { ...sourceCoverage, state:'partial', reasons:[...new Set([...sourceCoverage.reasons, 'field_truncated'])].slice(0,30) } : sourceCoverage;
  const display = formattedValue ?? (projectedValue == null ? null : String(projectedValue));
  const precision = asOf == null ? 'unknown' : asOfPrecision;
  const fact = { domain, entityId, recordVersion, field, value:projectedValue, asOf, asOfPrecision:precision, coverage:projectedCoverage };
  return validateEvidence({
    id: stableId({ ...fact, unit, formattedValue:display }), ...fact, label, unit,
    formattedValue:display === '' ? 'Sin dato' : typeof display === 'string' ? display.slice(0,1000) : display, href: normalizedHref,
  });
}

export function createAssistantEvidenceForRecords(domain, records, fields, { hrefFor = () => null, asOf = null, asOfPrecision = 'unknown', coverage = null } = {}) {
  const evidence = [];
  for (const record of records) for (const field of fields) {
    if (!Object.hasOwn(record, field.key)) continue;
    const value = record[field.key];
    if (!scalar(value)) continue;
    evidence.push(createAssistantEvidence({ domain, entityId: record.id ?? null, recordVersion: record.version ?? null, field: field.key, label: field.label, value, unit: field.unit || null, formattedValue: field.format ? field.format(value) : null, asOf: typeof asOf === 'function' ? asOf(record) : asOf, asOfPrecision, coverage, href: hrefFor(record) }));
  }
  return evidence;
}

export function assertKnownAssistantEvidence(ids, evidence) {
  const known = new Set(evidence.map(item => item.id));
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !known.has(id))) {
    const error = new Error('La respuesta cita evidencia que no pertenece a esta lectura.');
    error.code = 'ASSISTANT_SCOPE_DENIED';
    throw error;
  }
  return ids;
}
