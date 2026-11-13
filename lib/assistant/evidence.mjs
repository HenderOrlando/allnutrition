import { createHash } from 'node:crypto';
import { adminHref, readAdminView } from '../admin-view.mjs';
import { validateEvidence } from './contracts.mjs';
import { moneyMinor, roundRatio, formatMoneyMinor } from '../business/money.mjs';

const invalidQuery = message => { throw Object.assign(new Error(message), { code:'invalid_query', status:422 }); };

const scalar = value => value == null || ['string','number','boolean'].includes(typeof value);
const prefix = (value, length) => {
  const result = value.slice(0,length);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0,-1) : result;
};
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
  const projectedValue = truncated ? prefix(value, 2000) : value;
  const projectedCoverage = truncated ? { ...sourceCoverage, state:'partial', reasons:[...new Set([...sourceCoverage.reasons, 'field_truncated'])].slice(0,30) } : sourceCoverage;
  const display = formattedValue ?? (projectedValue == null ? null : String(projectedValue));
  const precision = asOf == null ? 'unknown' : asOfPrecision;
  const fact = { domain, entityId, recordVersion, field, value:projectedValue, asOf, asOfPrecision:precision, coverage:projectedCoverage };
  return validateEvidence({
    id: stableId({ ...fact, unit, formattedValue:display }), ...fact, label, unit,
    formattedValue:display === '' ? 'Sin dato' : typeof display === 'string' ? prefix(display,1000) : display, href: normalizedHref,
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

/** Exact, source-bound arithmetic. The returned lineage is not action authority. */
export function deriveAssistantFact({operation,left,right,leftSource,rightSource}) {
  if (!['difference','ratio_bps'].includes(operation)) invalidQuery('Operación no permitida.');
  if (!left || !right || left.domain !== right.domain || left.unit !== right.unit || !left.unit
    || !Number.isSafeInteger(left.value) || !Number.isSafeInteger(right.value)) invalidQuery('Los operandos deben ser enteros conocidos de un mismo dominio y unidad.');
  for (const source of [leftSource,rightSource]) {
    if (!source || !Object.hasOwn(source,'currency') || !Object.hasOwn(source,'interval')
      || typeof source.semantic !== 'string' || !source.semantic || typeof source.sourceStamp !== 'string' || !source.sourceStamp) invalidQuery('Faltan metadatos de origen del cálculo.');
    if (source.currency !== null && (typeof source.currency !== 'string' || !/^[A-Z]{3}$/.test(source.currency))) invalidQuery('Moneda de origen no válida.');
  }
  if (leftSource.currency !== rightSource.currency || operation === 'difference' && leftSource.semantic !== rightSource.semantic
    || /minor|COP/.test(left.unit) && !leftSource.currency) invalidQuery('Monedas o semánticas incompatibles.');
  const intervalKey = interval => {
    if (interval === null) return 'current';
    if (!interval || typeof interval !== 'object' || typeof interval.startDate !== 'string' || typeof interval.endDateExclusive !== 'string') invalidQuery('Intervalo de origen no válido.');
    return JSON.stringify([interval.startDate,interval.endDateExclusive,interval.closed ?? null,interval.asOf ?? null]);
  };
  if (intervalKey(leftSource.interval) !== intervalKey(rightSource.interval)) invalidQuery('Usa la comparación del dominio para intervalos distintos.');
  if (leftSource.interval?.closed !== true && leftSource.sourceStamp !== rightSource.sourceStamp && left.asOf !== right.asOf) invalidQuery('Los cortes de los operandos no son comparables.');
  const a = BigInt(left.value), b = BigInt(right.value);
  let value = null;
  if (operation === 'difference') {
    const difference = a - b;
    if (difference < BigInt(Number.MIN_SAFE_INTEGER) || difference > BigInt(Number.MAX_SAFE_INTEGER)) invalidQuery('Diferencia fuera del rango entero seguro.');
    value = Number(difference);
    if (/minor|COP/.test(left.unit)) moneyMinor(value, 'Diferencia', {signed:true});
  } else if (b !== 0n) value = roundRatio(b < 0n ? -a * 10000n : a * 10000n, b < 0n ? -b : b);
  const reasons = [...new Set([...left.coverage.reasons,...right.coverage.reasons,...(value === null ? ['no_comparison_base'] : [])])];
  const complete = value !== null && left.coverage.state === 'complete' && right.coverage.state === 'complete';
  const unit = operation === 'ratio_bps' ? 'bps' : left.unit;
  const evidence = createAssistantEvidence({
    domain:left.domain, field:`derived:${operation}`, label:operation === 'difference' ? 'Diferencia calculada' : 'Razón calculada',
    value, unit, formattedValue:value === null ? null : unit === 'bps' ? `${value / 100}%` : /minor/.test(unit) ? formatMoneyMinor(value,{currency:leftSource.currency}) : String(value),
    asOf:left.asOf === right.asOf ? left.asOf : null,
    asOfPrecision:left.asOf === right.asOf ? left.asOfPrecision : 'unknown',
    coverage:{state:value === null ? 'unknown' : complete ? 'complete' : 'partial',knownCount:value === null ? 0 : 1,eligibleCount:1,excludedCount:0,reasons},
  });
  return {
    evidence,
    metadata:{...leftSource, semantic:`derived:${operation}:${leftSource.semantic}`,
      sourceStamp:stableId({operation,left:left.id,right:right.id,leftSource,rightSource}),
      derivedFrom:[left.id,right.id], actionAuthority:false},
  };
}
