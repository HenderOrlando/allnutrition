import { fail, integer } from '../validation-core.mjs';
import { entity, hash, insertRow, newId, stamp, assertLease, updateVersioned, audit } from './commands.mjs';
import { instant } from './dates.mjs';
import { MAX_MONEY_MINOR, roundRatio } from './money.mjs';
import { socialMeasurementQueryKey, socialErrorCode, SOCIAL_ERROR_MESSAGES } from '../social/evidence.mjs';
import { socialAccountNotBefore, deferSocialAccountTx } from './social-schedule.mjs';
import { queueSocialAnalysisTx } from './social-analysis-queue.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, MANUAL_INTERVAL = 15 * 60000;
const DIMENSIONS = ['aggregate', 'daily', 'placement', 'age_gender', 'country'];
const PENDING_STATES = ['ready', 'scheduled', 'preparing', 'publishing', 'in_review', 'uncertain'];
const FINAL_STATES = ['completed', 'cancelled', 'failed'];
const METRIC_UNITS = new Set(['count', 'minor_currency', 'ratio', 'percent', 'seconds', 'milliseconds']);
const STATUSES = new Set(['reported', 'estimated', 'unavailable', 'unsupported']);
const PRECISIONS = new Set(['exact', 'rounded', 'unknown']);
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{1,40}(?:_\d{1,40})?$/;
const raw = row => JSON.parse(row?.data || '{}');
const after = (now, milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString();
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const publicText = (value, maximum = 200) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const minimum = values => values.filter(Boolean).sort()[0] || null;
const maximum = values => values.filter(Boolean).sort().at(-1) || null;
function assert(value, code = 'SPEC_MISMATCH') { if (!value) throw Object.assign(new Error(SOCIAL_ERROR_MESSAGES[code] || code), { errorCode: code, status: 409 }); }
function day(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && validTime(value) && new Date(value).toISOString().slice(0, 10) === value);
  return value;
}
function dateParts(value, timeZone, withTime = false) {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}) }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  } catch { fail('La zona horaria de la cuenta no es válida.', 409); }
}
function dateInZone(value, timeZone) { const parts = dateParts(value, timeZone); return `${parts.year}-${parts.month}-${parts.day}`; }
function addCalendarDays(value, count) { return new Date(Date.parse(day(value)) + count * DAY).toISOString().slice(0, 10); }
function midnight(value, timeZone) {
  const target = Date.parse(`${day(value)}T00:00:00Z`); let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = dateParts(candidate, timeZone, true);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const corrected = candidate + target - observed;
    if (corrected === candidate) return new Date(candidate).toISOString();
    candidate = corrected;
  }
  fail('No se pudo comprobar el inicio del día en la zona de la cuenta.', 409);
}
function publicationAnchor(delivery, spec) {
  return delivery.publishedAt || delivery.metricSync?.publicationAt || spec.publishAt || delivery.approvedAt || delivery.createdAt || null;
}
export function socialMetricAnchor(delivery, spec) {
  if (spec.mode !== 'paid') return publicationAnchor(delivery, spec);
  const start = validTime(spec.startAt) ? spec.startAt : null, activated = validTime(delivery.activatedAt) ? delivery.activatedAt : null;
  return !start ? activated : !activated ? start : start > activated ? start : activated;
}
function remotelyMeasurable(delivery, spec) {
  if (spec.mode === 'paid') return delivery.everActivated === true && Boolean(delivery.remoteRefs?.adId || delivery.preparedRefs?.adId || delivery.remoteId);
  return Boolean(delivery.remoteId || delivery.remoteRefs?.mediaId || delivery.remoteRefs?.postId || delivery.remoteRefs?.videoId);
}
function blockedFor(connection, delivery) {
  const block = delivery.metricSync?.blocked;
  return block && block.connectionVersion === connection?.version && block.sessionEpoch === (connection?.sessionEpoch || 0);
}

export function socialMetricLifecycle(delivery, result, { operation = null, now = stamp() } = {}) {
  const change = {}, state = result.state;
  if (state === 'published' && !delivery.publishedAt && operation?.sentAt) {
    change.publishedAt = instant(operation.sentAt); change.publicationTimeSource = 'publication_request_sent_at';
  }
  if (FINAL_STATES.includes(state) && !delivery.finalizedAt) change.finalizedAt = instant(now);
  if (state === 'paused' && !delivery.pausedAt) change.pausedAt = instant(now);
  if (['active', 'scheduled', 'in_review'].includes(state) && delivery.pausedAt) {
    change.pausedAt = null;
    if (delivery.metricSync) change.metricSync = { ...delivery.metricSync, cycle: null, nextAt: null, retryAt: null, final28At: null };
  }
  return change;
}

export function socialMetricsNextAt(delivery, spec, { now = stamp(), connection = null } = {}) {
  now = instant(now);
  if (!remotelyMeasurable(delivery, spec) || connection && (connection.state !== 'connected' || blockedFor(connection, delivery))) return null;
  const sync = delivery.metricSync || {}, anchor = socialMetricAnchor(delivery, spec);
  if (!validTime(anchor)) return null;
  if (spec.mode === 'paid' && anchor > now) return after(anchor, HOUR);
  if (sync.cycle) return sync.nextAt || now;
  const manual = delivery.metricsRequestedAt && delivery.metricsRequestedAt > (sync.lastAttemptAt || '')
    ? maximum([delivery.metricsRequestedAt, sync.lastAttemptAt ? after(sync.lastAttemptAt, MANUAL_INTERVAL) : null]) : null;
  if (manual) return manual;
  if (sync.retryAt) return sync.retryAt;
  const last = sync.lastCompletedAt || anchor;
  if (spec.mode === 'paid') {
    const end = delivery.finalizedAt || (delivery.state === 'paused' ? delivery.pausedAt : null);
    if (!end || Date.parse(now) <= Date.parse(end) + 7 * DAY) return after(last, HOUR);
    return sync.final28At ? null : after(end, 28 * DAY);
  }
  const observationDays = [7, 14, 28].includes(spec.observationDays) ? spec.observationDays : 7;
  if (Date.parse(now) <= Date.parse(anchor) + (observationDays + 2) * DAY) return after(last, 6 * HOUR);
  return sync.final28At ? null : after(anchor, 28 * DAY);
}
export function socialStateReadDue(delivery, now = stamp()) {
  if (delivery.stateReadRequestedAt && delivery.stateReadRequestedAt > (delivery.lastStateReadAt || '')) return true;
  if (!PENDING_STATES.includes(delivery.state)) return false;
  return !delivery.lastStateReadAt || after(delivery.lastStateReadAt, 300000) <= now;
}
export function socialSyncNextAt(delivery, spec, { now = stamp(), connection = null } = {}) {
  if (!spec) return null;
  const stateAt = delivery.stateReadRequestedAt && delivery.stateReadRequestedAt > (delivery.lastStateReadAt || '') ? now
    : PENDING_STATES.includes(delivery.state) ? after(delivery.lastStateReadAt || delivery.lastConfirmedAt || now, 300000) : null;
  return minimum([stateAt, socialMetricsNextAt(delivery, spec, { now, connection })]);
}
export function buildSocialMetricQueries(delivery, spec, { now = stamp() } = {}) {
  now = instant(now); const timeZone = spec.timeZone || (spec.mode === 'organic' ? 'UTC' : null);
  assert(publicText(timeZone, 100));
  const anchor = socialMetricAnchor(delivery, spec); if (!validTime(anchor) || spec.mode === 'paid' && anchor > now) return [];
  const start = dateInZone(anchor, timeZone), end = dateInZone(now, timeZone); if (start > end) return [];
  const make = (periodStart, dimension, window, periodType = 'range', horizon = null) => ({ periodStart, periodEnd: end, windowStart: midnight(periodStart, timeZone), windowEnd: now, timeZone, timeZoneSource: spec.timeZone ? 'account' : 'observation_utc', dimension, scope: spec.mode === 'paid' ? 'paid' : 'organic', periodType, window, ...(horizon ? { horizon } : {}) });
  if (spec.mode !== 'paid') {
    const age = Date.parse(now) - Date.parse(anchor), horizon = [7, 14, 28].find(value => age >= value * DAY && age <= (value + 1) * DAY) || null;
    return [{ ...make(start, 'aggregate', horizon ? 'horizon' : 'cumulative', 'lifetime', horizon), anchorAt: anchor, publicationTimeSource: delivery.publicationTimeSource || (spec.publishAt ? 'declared_schedule' : 'unknown') }];
  }
  const recent = maximum([start, addCalendarDays(end, -6)]), queries = [make(start, 'aggregate', 'cumulative')];
  if (recent !== start) queries.push(make(recent, 'aggregate', 'recent'));
  queries.push(make(recent, 'daily', 'recent'), ...['placement', 'age_gender', 'country'].map(dimension => make(start, dimension, 'cumulative')));
  // Frequency needs unique reach for each three-day interval; summing daily
  // reach would count the same people repeatedly. Exclude today's partial day.
  if (Date.parse(anchor) <= Date.parse(midnight(addCalendarDays(end, -6), timeZone))) {
    const complete = (offset, lastOffset, window) => ({ ...make(addCalendarDays(end, offset), 'aggregate', window), periodEnd: addCalendarDays(end, lastOffset), windowEnd: midnight(addCalendarDays(end, lastOffset + 1), timeZone) });
    queries.push(complete(-3, -1, 'recent_3d'), complete(-6, -4, 'previous_3d'));
  }
  return queries;
}

export function normalizeSocialMetric(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const metric = Object.fromEntries(['value', 'unit', 'sourceMetric', 'status', 'precision', 'displayValue', 'reason'].map(key => [key, value[key] ?? null]));
  assert(STATUSES.has(metric.status) && PRECISIONS.has(metric.precision) && METRIC_UNITS.has(metric.unit), 'LAYOUT_CHANGED');
  assert(metric.sourceMetric === null || publicText(metric.sourceMetric, 300), 'LAYOUT_CHANGED');
  assert(metric.displayValue === null || publicText(metric.displayValue, 300), 'LAYOUT_CHANGED');
  assert(metric.reason === null || publicText(metric.reason, 500), 'LAYOUT_CHANGED');
  if (metric.value === null) assert(['unavailable', 'unsupported'].includes(metric.status) && metric.reason, 'LAYOUT_CHANGED');
  else {
    assert(['reported', 'estimated'].includes(metric.status) && typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0 && metric.value <= Number.MAX_SAFE_INTEGER, 'LAYOUT_CHANGED');
    assert(metric.sourceMetric !== null, 'LAYOUT_CHANGED');
    if (metric.unit === 'minor_currency') assert(Number.isSafeInteger(metric.value) && metric.value <= MAX_MONEY_MINOR, 'LAYOUT_CHANGED');
    assert(metric.precision !== 'unknown' && (metric.precision !== 'rounded' || metric.status === 'estimated'), 'LAYOUT_CHANGED');
  }
  return metric;
}
function fraction(value) {
  const [base, exponentText = '0'] = String(value).toLowerCase().split('e'), exponent = Number(exponentText), [whole, decimals = ''] = base.split('.');
  const power = decimals.length - exponent, numerator = BigInt(whole + decimals);
  return power < 0 ? [numerator * 10n ** BigInt(-power), 1n] : [numerator, 10n ** BigInt(power)];
}
function derivedRatio(values, numeratorKey, denominatorKey, factor, unit, sourceMetric) {
  const numerator = values[numeratorKey], denominator = values[denominatorKey], dependencies = [numerator, denominator];
  const unavailable = reason => ({ value: null, unit, sourceMetric, status: 'unavailable', precision: 'unknown', displayValue: null, reason });
  if (dependencies.some(value => !value || value.value === null)) return unavailable('missing_denominator_or_numerator');
  if (dependencies.some(value => value.precision !== 'exact')) return unavailable('rounded_or_unknown_input');
  if (denominator.value === 0) return unavailable('zero_denominator');
  const [n, nd] = fraction(numerator.value), [d, dd] = fraction(denominator.value);
  try {
    const scale = unit === 'minor_currency' ? 1n : 100n;
    const value = roundRatio(n * dd * BigInt(factor) * scale, nd * d) / Number(scale);
    return { value, unit, sourceMetric, status: dependencies.some(entry => entry.status === 'estimated') ? 'estimated' : 'reported', precision: 'exact', displayValue: String(value), reason: null };
  } catch { return unavailable('ratio_out_of_range'); }
}
export function socialMetricRatios(values, { objective = null, complete = true } = {}) {
  const output = {
    ctrLinkPercent: derivedRatio(values, 'linkClicks', 'impressions', 100, 'percent', 'derived:linkClicks/impressions*100'),
    cpcLinkMinor: derivedRatio(values, 'spendMinor', 'linkClicks', 1, 'minor_currency', 'derived:spendMinor/linkClicks'),
    cpmMinor: derivedRatio(values, 'spendMinor', 'impressions', 1000, 'minor_currency', 'derived:spendMinor/impressions*1000'),
    frequency: derivedRatio(values, 'impressions', 'reach', 1, 'ratio', 'derived:impressions/reach')
  };
  output.costPerConversationMinor = objective === 'whatsapp'
    ? derivedRatio(values, 'spendMinor', 'conversations', 1, 'minor_currency', 'derived:spendMinor/conversations')
    : { value: null, unit: 'minor_currency', sourceMetric: null, status: 'unsupported', precision: 'unknown', displayValue: null, reason: 'objective_has_no_conversation_kpi' };
  if (!complete) for (const [key, value] of Object.entries(output)) output[key] = { ...value, value: null, status: 'unavailable', precision: 'unknown', displayValue: null, reason: 'incomplete_coverage' };
  return output;
}
function valuesOf(values) {
  assert(values && typeof values === 'object' && !Array.isArray(values), 'LAYOUT_CHANGED');
  const entries = Object.entries(values); assert(entries.length <= 100, 'LAYOUT_CHANGED');
  return Object.fromEntries(entries.map(([key, value]) => { assert(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key), 'LAYOUT_CHANGED'); return [key, normalizeSocialMetric(value)]; }));
}
function cleanEvidence(value = {}) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'LAYOUT_CHANGED');
  const output = {};
  for (const key of ['sourcePage', 'locale', 'extractHash', 'endpoint', 'publicationTimeSource', 'matrixVersion', 'adSetId', 'timeZoneSource', 'configurationVerifiedAt']) if (value[key] != null) {
    assert(publicText(value[key], key === 'sourcePage' ? 2048 : 300), 'LAYOUT_CHANGED'); output[key] = value[key];
  }
  if (output.sourcePage) {
    let url; try { url = new URL(output.sourcePage); } catch { assert(false, 'LAYOUT_CHANGED'); }
    assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'LAYOUT_CHANGED');
    url.search = ''; url.hash = ''; output.sourcePage = url.href;
  }
  if (output.extractHash) assert(/^[a-f0-9]{64}$/.test(output.extractHash), 'LAYOUT_CHANGED');
  for (const key of ['columnLabels', 'fields', 'unmappedActions', 'configurationDifferences']) if (value[key] != null) {
    assert(Array.isArray(value[key]) && value[key].length <= 200 && value[key].every(entry => publicText(entry, 300)), 'LAYOUT_CHANGED'); output[key] = [...value[key]];
  }
  if (value.columnDefinitions) {
    assert(Array.isArray(value.columnDefinitions) && value.columnDefinitions.length <= 200, 'LAYOUT_CHANGED');
    output.columnDefinitions = value.columnDefinitions.map(entry => {
      assert(publicText(entry?.label, 300) && publicText(entry.tooltip, 1000), 'LAYOUT_CHANGED');
      return { label: entry.label, tooltip: entry.tooltip };
    });
  }
  if (output.adSetId) assert(NUMERIC_ID.test(output.adSetId), 'LAYOUT_CHANGED');
  if (output.configurationVerifiedAt) output.configurationVerifiedAt = instant(output.configurationVerifiedAt);
  if (value.metricUnits) {
    assert(typeof value.metricUnits === 'object' && !Array.isArray(value.metricUnits) && Object.keys(value.metricUnits).length <= 100, 'LAYOUT_CHANGED');
    output.metricUnits = Object.fromEntries(Object.entries(value.metricUnits).map(([key, evidence]) => {
      assert(/^[a-zA-Z0-9_]{1,100}$/.test(key) && ['seconds', 'milliseconds'].includes(evidence?.unit) && evidence.source === 'metric.description', 'LAYOUT_CHANGED');
      return [key, { unit: evidence.unit, source: evidence.source }];
    }));
  }
  if (value.timeZoneMismatch) {
    assert(publicText(value.timeZoneMismatch.requested, 100) && publicText(value.timeZoneMismatch.reported, 100), 'LAYOUT_CHANGED');
    output.timeZoneMismatch = { requested: value.timeZoneMismatch.requested, reported: value.timeZoneMismatch.reported };
  }
  if (value.reportedPeriod) {
    const period = value.reportedPeriod;
    assert(publicText(period.timeZone, 100), 'LAYOUT_CHANGED');
    output.reportedPeriod = { periodStart: day(period.periodStart), periodEnd: day(period.periodEnd), timeZone: period.timeZone };
  }
  if (value.numberFormat) {
    const { decimalSeparator, groupSeparator } = value.numberFormat;
    assert(['.', ','].includes(decimalSeparator) && ['', '.', ',', ' ', '\u00a0', '\u202f', "'"].includes(groupSeparator) && groupSeparator !== decimalSeparator, 'LAYOUT_CHANGED');
    output.numberFormat = { decimalSeparator, groupSeparator };
  }
  if (typeof value.externalDOMVerified === 'boolean') output.externalDOMVerified = value.externalDOMVerified;
  return output;
}
function resultIdentity(data) {
  return hash({ integrationMethod: data.integrationMethod, adapterVersion: data.adapterVersion, apiVersion: data.apiVersion, definitionVersion: data.definitionVersion, entity: data.entity, timeZone: data.timeZone, timeZoneSource: data.query.timeZoneSource || null, currency: data.currency, scope: data.scope, dimension: data.dimension, attributionSetting: data.attributionSetting, actionReportTime: data.actionReportTime, periodType: data.query.periodType, window: data.query.window, horizon: data.query.horizon || null });
}
export function normalizeSocialMeasurement(value, { delivery, spec, query }) {
  assert(value && value.integrationMethod === spec.integrationMethod && value.query && hash(value.query) === hash(query), 'ACCOUNT_MISMATCH');
  assert(publicText(value.adapterVersion, 100) && publicText(value.definitionVersion, 150), 'LAYOUT_CHANGED');
  assert(value.integrationMethod === 'api' ? value.apiVersion === 'v26.0' : value.apiVersion === null, 'LAYOUT_CHANGED');
  const observedZoneMismatch = spec.mode === 'organic' && query.timeZoneSource === 'observation_utc' && value.coverage?.complete === false && value.coverage.reason === 'observation_time_zone_mismatch'
    && value.evidence?.timeZoneMismatch?.requested === query.timeZone && value.evidence.timeZoneMismatch.reported === value.timeZone;
  assert(instant(value.periodStart) === query.windowStart && instant(value.periodEnd) === query.windowEnd && (value.timeZone === query.timeZone || observedZoneMismatch) && value.dimension === query.dimension, 'SPEC_MISMATCH');
  assert(['paid', 'organic', 'mixed'].includes(value.scope) && (spec.mode !== 'paid' || value.scope === 'paid'), 'SPEC_MISMATCH');
  assert(value.currency == null || ['COP', 'USD'].includes(value.currency) && (spec.mode === 'organic' || value.currency === spec.currency), 'ACCOUNT_MISMATCH');
  const expectedIds = new Set([delivery.remoteId, ...Object.values(delivery.remoteRefs || {}), ...Object.values(delivery.preparedRefs || {})].filter(entry => typeof entry === 'string' && NUMERIC_ID.test(entry)));
  assert(value.entity && ['ad', 'campaign', 'post', 'media', 'video'].includes(value.entity.type) && expectedIds.has(value.entity.id), 'ACCOUNT_MISMATCH');
  if (spec.integrationMethod === 'api' && spec.mode === 'paid') assert(value.entity.type === 'ad' && value.entity.id === (delivery.remoteRefs?.adId || delivery.preparedRefs?.adId), 'ACCOUNT_MISMATCH');
  const attribution = value.attributionSetting ?? null;
  assert(attribution === null || publicText(attribution, 500) || Array.isArray(attribution) && attribution.length <= 20 && attribution.every(entry => entry && typeof entry.event_type === 'string' && /^[A-Z_]{1,60}$/.test(entry.event_type) && Number.isInteger(entry.window_days) && entry.window_days >= 0 && entry.window_days <= 365), 'LAYOUT_CHANGED');
  assert(value.actionReportTime === null || value.actionReportTime === 'impression', 'LAYOUT_CHANGED');
  const values = valuesOf(value.values), rows = value.rows || [], seen = new Set();
  assert(Array.isArray(rows) && rows.length <= 100000 && (query.dimension === 'aggregate' ? rows.length === 0 : Object.keys(values).length === 0), 'LAYOUT_CHANGED');
  const normalizedRows = rows.map(row => {
    const dimensions = {};
    assert(row && row.dimensions && typeof row.dimensions === 'object' && !Array.isArray(row.dimensions), 'LAYOUT_CHANGED');
    for (const [key, entry] of Object.entries(row.dimensions)) {
      assert(['date', 'publisherPlatform', 'placement', 'age', 'gender', 'country'].includes(key) && publicText(entry, 200), 'LAYOUT_CHANGED'); dimensions[key] = entry;
    }
    const start = day(row.periodStart), end = day(row.periodEnd);
    assert(start >= query.periodStart && end <= query.periodEnd && end >= start, 'SPEC_MISMATCH');
    if (query.dimension === 'daily') assert(start === end && dimensions.date === start, 'SPEC_MISMATCH');
    const key = hash({ dimensions, start, end }); assert(!seen.has(key), 'LAYOUT_CHANGED'); seen.add(key);
    return { dimensions, periodStart: start, periodEnd: end, values: valuesOf(row.values) };
  });
  assert(value.coverage && typeof value.coverage.complete === 'boolean' && Number.isSafeInteger(value.coverage.rowCount) && value.coverage.rowCount >= 0 && value.coverage.rowCount <= 100000, 'LAYOUT_CHANGED');
  assert(query.dimension === 'aggregate' || value.coverage.rowCount === rows.length, 'LAYOUT_CHANGED');
  const coverage = { complete: value.coverage.complete, rowCount: value.coverage.rowCount, reason: value.coverage.reason == null ? null : publicText(value.coverage.reason, 500) };
  assert(coverage.complete || coverage.reason, 'LAYOUT_CHANGED');
  const data = { integrationMethod: value.integrationMethod, adapterVersion: value.adapterVersion, apiVersion: value.apiVersion, definitionVersion: value.definitionVersion,
    query: structuredClone(query), periodStart: query.windowStart, periodEnd: query.windowEnd, timeZone: value.timeZone, currency: value.currency || null, scope: value.scope,
    attributionSetting: attribution === null ? null : structuredClone(attribution), actionReportTime: value.actionReportTime, dimension: query.dimension, entity: { type: value.entity.type, id: value.entity.id },
    values, rows: normalizedRows, coverage, evidence: cleanEvidence(value.evidence), ratios: query.dimension === 'aggregate' ? socialMetricRatios(values, { objective: spec.objective, complete: coverage.complete }) : {} };
  data.resultKey = resultIdentity(data);
  return data;
}

async function loadTarget(store, deliveryId) {
  const delivery = entity(await store.db.get(`SELECT * FROM ${store.t('social_deliveries')} WHERE id=?`, [deliveryId]));
  if (!delivery) fail('Entrega social no encontrada.', 404);
  const campaign = entity(await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [delivery.campaignId]));
  const revision = entity(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [delivery.campaignId, delivery.revision]));
  const connection = campaign && entity(await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id=?`, [campaign.connectionId]));
  assert(revision?.spec && revision.specHash === hash(revision.spec) && connection && connection.integrationMethod === revision.spec.integrationMethod && delivery.integrationMethod === connection.integrationMethod);
  assert(revision.spec.connectionId === connection.id && campaign.connectionId === connection.id, 'ACCOUNT_MISMATCH');
  const credential = await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  const asset = revision.spec.assetId ? entity(await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [revision.spec.assetId])) : null;
  return { delivery: { ...delivery, approvedAt: revision.approvedAt, assetType: revision.spec.assetType || asset?.kind || null }, campaign, revision, spec: revision.spec, connection, credentialVersion: credential?.version || 0 };
}
async function writeTarget(store, expected, options, fn) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const now = options.clock();
    if (options.lease) await assertLease(tx, { ...options.lease, now });
    if (options.browserSession) await assertLease(tx, { ...options.browserSession.lease, now });
    const current = await loadTarget(tx, expected.delivery.id);
    assert(current.revision.specHash === expected.revision.specHash && current.delivery.version === expected.delivery.version && current.connection.id === expected.connection.id && current.connection.version === expected.connection.version && (current.connection.sessionEpoch || 0) === (expected.connection.sessionEpoch || 0) && current.credentialVersion === expected.credentialVersion && current.connection.state === 'connected', 'LEASE_LOST');
    return fn(tx, current, now);
  });
}
function metricsError(caught) {
  return ({ permission: 'PERMISSION_REQUIRED', reconnect_required: 'SESSION_EXPIRED', rate_limit: 'RATE_LIMITED', account_mismatch: 'ACCOUNT_MISMATCH', invalid_response: 'LAYOUT_CHANGED', aborted: 'TIMEOUT' })[caught?.kind] || socialErrorCode(caught);
}

// One read query per turn. The cursor is local metadata, not a second scheduler.
export async function syncSocialDelivery(store, deliveryId, { now = stamp(), lease = null, connector, signal, browserSession = null, clock = null, configurationEvidence = null } = {}) {
  if (!IDENTIFIER.test(deliveryId || '')) fail('Entrega social no válida.');
  now = instant(now); clock ||= () => now;
  assert(connector && typeof connector.fetchMeasurements === 'function', 'PERMISSION_REQUIRED');
  let target = await loadTarget(store, deliveryId);
  const nextAt = socialMetricsNextAt(target.delivery, target.spec, { now, connection: target.connection });
  if (!nextAt || nextAt > now) return { processed: 0, snapshotIds: [], nextRunAt: nextAt, errorCode: null };
  const cooldown = await socialAccountNotBefore(store, target.connection, target.spec, { now });
  if (cooldown) return { processed: 0, snapshotIds: [], nextRunAt: cooldown, errorCode: null };
  const options = { lease, browserSession, clock }, sync = target.delivery.metricSync || {};
  let cycle = sync.cycle;
  const sameProfile = cycle && cycle.specHash === target.revision.specHash && cycle.connectionVersion === target.connection.version && cycle.sessionEpoch === (target.connection.sessionEpoch || 0);
  if (!sameProfile) {
    const queries = buildSocialMetricQueries(target.delivery, target.spec, { now });
    if (!queries.length) return { processed: 0, snapshotIds: [], nextRunAt: after(now, HOUR), errorCode: null };
    const proof = configurationEvidence || { verifiedAt: null, differences: ['configuration_not_verified'] };
    assert(proof.verifiedAt === null || validTime(proof.verifiedAt), 'LAYOUT_CHANGED');
    assert(Array.isArray(proof.differences) && proof.differences.every(value => publicText(value, 200)), 'LAYOUT_CHANGED');
    cycle = { id: newId(), startedAt: now, specHash: target.revision.specHash, connectionVersion: target.connection.version, sessionEpoch: target.connection.sessionEpoch || 0, queries, index: 0, configurationEvidence: proof };
    target = await writeTarget(store, target, options, async (tx, current, at) => {
      const metadata = raw(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [deliveryId]));
      await updateVersioned(tx, 'social_deliveries', deliveryId, current.delivery.version, { data: JSON.stringify({ ...metadata, metricSync: { ...metadata.metricSync, cycle, nextAt: at, retryAt: null } }) });
      return loadTarget(tx, deliveryId);
    });
  }
  const query = cycle.queries[cycle.index]; assert(query, 'LAYOUT_CHANGED');
  try {
    signal?.throwIfAborted(); await browserSession?.assertActive();
    const cached = target.delivery.metricSync || {}, profileValid = cached.connectionVersion === target.connection.version && cached.sessionEpoch === (target.connection.sessionEpoch || 0);
    const packet = await connector.fetchMeasurements({ delivery: target.delivery, spec: target.spec, query, knownUnsupported: profileValid ? cached.unsupportedMetrics || [] : [], signal });
    signal?.throwIfAborted(); await browserSession?.assertActive();
    assert(Array.isArray(packet?.snapshots) && packet.snapshots.length > 0 && packet.snapshots.length <= 10 && Array.isArray(packet.unsupportedMetrics), 'LAYOUT_CHANGED');
    const snapshots = packet.snapshots.map(value => normalizeSocialMeasurement({ ...value, evidence: { ...value.evidence,
      configurationDifferences: [...new Set([...(value.evidence?.configurationDifferences || []), ...(cycle.configurationEvidence?.differences || ['configuration_not_verified'])])],
      ...(cycle.configurationEvidence?.verifiedAt ? { configurationVerifiedAt: cycle.configurationEvidence.verifiedAt } : {}) } }, { ...target, query }));
    const unsupported = [...new Set([...(profileValid ? cached.unsupportedMetrics || [] : []), ...packet.unsupportedMetrics])];
    assert(unsupported.length <= 200 && unsupported.every(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value)), 'LAYOUT_CHANGED');
    return await writeTarget(store, target, options, async (tx, current, at) => {
      const snapshotIds = []; let changed = Boolean(cycle.changed);
      for (const data of snapshots) {
        const payloadHash = hash(data), queryKey = socialMeasurementQueryKey(data);
        const existing = await tx.db.get(`SELECT id FROM ${tx.t('social_measurements')} WHERE delivery_id=? AND query_key=? AND fetched_at=? AND payload_hash=?`, [deliveryId, queryKey, at, payloadHash]);
        const id = existing?.id || newId();
        if (!existing) { await insertRow(tx, 'social_measurements', { id, delivery_id: deliveryId, query_key: queryKey, fetched_at: at, payload_hash: payloadHash, data: JSON.stringify(data) }); changed = true; }
        snapshotIds.push(id);
      }
      const metadata = raw(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [deliveryId]));
      const completeCycle = cycle.index + 1 === cycle.queries.length, end = current.delivery.finalizedAt || (current.delivery.state === 'paused' ? current.delivery.pausedAt : null), anchor = current.spec.mode === 'paid' ? end : publicationAnchor(current.delivery, current.spec);
      const final28 = completeCycle && validTime(anchor) && Date.parse(at) >= Date.parse(anchor) + 28 * DAY && (current.spec.mode !== 'paid' || Boolean(end));
      const metricSync = { ...metadata.metricSync, cycle: completeCycle ? null : { ...cycle, changed, index: cycle.index + 1 }, nextAt: completeCycle ? null : at, retryAt: null, blocked: null,
        connectionVersion: current.connection.version, sessionEpoch: current.connection.sessionEpoch || 0, unsupportedMetrics: unsupported, attempts: 0, lastAttemptAt: at, lastError: null,
        ...(snapshots.some(value => value.coverage.complete) ? { lastSuccessAt: at } : {}), ...(completeCycle ? { lastCompletedAt: at } : {}), ...(final28 ? { final28At: at } : {}) };
      const updated = { ...current.delivery, metricSync };
      const nextRunAt = socialSyncNextAt(updated, current.spec, { now: at, connection: current.connection });
      await updateVersioned(tx, 'social_deliveries', deliveryId, current.delivery.version, { next_sync_at: nextRunAt, data: JSON.stringify({ ...metadata, metricSync }) });
      if (completeCycle && changed) await queueSocialAnalysisTx(tx, current.delivery.campaignId, { now: at, requestedBy: 'scheduler' });
      return { processed: 1, snapshotIds, nextRunAt, errorCode: null };
    });
  } catch (caught) {
    const code = metricsError(caught); if (code === 'LEASE_LOST') throw caught;
    return writeTarget(store, target, options, async (tx, current, at) => {
      const metadata = raw(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [deliveryId])), previous = metadata.metricSync || {}, attempts = (previous.attempts || 0) + 1;
      const blocked = ['PERMISSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_MISMATCH', 'LAYOUT_CHANGED', 'CHALLENGE_REQUIRED', 'AUTH_FAILED'].includes(code);
      const delay = [60000, 300000, 900000, 3600000][Math.min(attempts - 1, 3)], retryAt = blocked ? null : after(at, Math.max(delay, Number.isFinite(caught.retryAfter) ? caught.retryAfter * 1000 : 0));
      const metricSync = { ...previous, cycle, nextAt: retryAt, retryAt, lastAttemptAt: at, attempts, lastError: { code, message: SOCIAL_ERROR_MESSAGES[code] },
        blocked: blocked ? { code, connectionVersion: current.connection.version, sessionEpoch: current.connection.sessionEpoch || 0 } : null };
      if (code === 'RATE_LIMITED') await deferSocialAccountTx(tx, current.connection, current.spec, retryAt, { now: at });
      const state = code === 'SESSION_EXPIRED' || code === 'ACCOUNT_MISMATCH' ? 'reconnect_required'
        : current.connection.integrationMethod === 'browser' ? ({ LAYOUT_CHANGED: 'layout_changed', CHALLENGE_REQUIRED: 'challenge_required' })[code] : null;
      if (state) {
        await updateVersioned(tx, 'social_connections', current.connection.id, current.connection.version, { state });
        await audit(tx, { entityType: 'social_connection', entityId: current.connection.id, actorId: 'scheduler:social-metrics', next: { state, code }, reason: 'Lectura de métricas detenida; se conserva la última evidencia.', recordedAt: at, source: 'scheduler' });
      }
      const nextRunAt = state ? null : socialSyncNextAt({ ...current.delivery, metricSync }, current.spec, { now: at, connection: current.connection });
      await updateVersioned(tx, 'social_deliveries', deliveryId, current.delivery.version, { next_sync_at: nextRunAt, data: JSON.stringify({ ...metadata, metricSync }) });
      return { processed: 1, snapshotIds: [], nextRunAt, errorCode: code };
    });
  }
}

export async function getSocialResults(store, query = {}) {
  const allowed = new Set(['campaignId', 'deliveryId', 'integrationMethod', 'scope', 'dimension', 'asOf', 'page', 'from', 'to']);
  for (const key of Object.keys(query)) if (!allowed.has(key)) fail('Filtro de resultados no válido.');
  const asOf = query.asOf ? instant(query.asOf) : stamp(), page = integer(Number(query.page || 1), 'Página', 1, 1000000);
  for (const key of ['from', 'to']) if (query[key] !== undefined && (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !validTime(query[key]) || new Date(query[key]).toISOString().slice(0, 10) !== query[key])) fail('Fecha de resultados no válida.');
  if (query.from && query.to && query.from > query.to) fail('El inicio del período debe ser anterior o igual al fin.');
  const selection = { from: query.from || null, to: query.to || null };
  for (const key of ['campaignId', 'deliveryId']) if (query[key] && !IDENTIFIER.test(query[key])) fail('Identificador social no válido.');
  if (query.integrationMethod && !['api', 'browser'].includes(query.integrationMethod) || query.scope && !['paid', 'organic', 'mixed'].includes(query.scope) || query.dimension && !DIMENSIONS.includes(query.dimension)) fail('Filtro de resultados no válido.');
  return store.readSnapshot(async tx => {
    const filters = [], parameters = [];
    if (query.campaignId) { filters.push('d.campaign_id=?'); parameters.push(query.campaignId); }
    if (query.deliveryId) { filters.push('d.id=?'); parameters.push(query.deliveryId); }
    const field = (alias, name) => tx.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${name}')` : `${alias}.data::jsonb#>>'{${name.split('.').join(',')}}'`;
    const measurementFilters = ['m.fetched_at<=?'], measurementArgs = [asOf];
    if (query.scope) { measurementFilters.push(`${field('m', 'scope')}=?`); measurementArgs.push(query.scope); }
    if (query.dimension) { measurementFilters.push(`${field('m', 'dimension')}=?`); measurementArgs.push(query.dimension); }
    if (query.from || query.to) {
      const contained = [], daily = [], periodArgs = [], dailyArgs = [];
      const rowField = name => tx.provider === 'sqlite' ? `json_extract(social_row.value,'$.${name}')` : `social_row.value->>'${name}'`;
      for (const [key, name, operator] of [['from', 'periodStart', '>='], ['to', 'periodEnd', '<=']]) if (query[key]) {
        contained.push(`${field('m', `query.${name}`)}${operator}?`); periodArgs.push(query[key]);
        daily.push(`${rowField(name)}${operator}?`); dailyArgs.push(query[key]);
      }
      const rowSource = tx.provider === 'sqlite' ? "json_each(m.data,'$.rows')" : "jsonb_array_elements(m.data::jsonb->'rows')";
      measurementFilters.push(`((${field('m', 'dimension')}<>'daily' AND ${contained.join(' AND ')}) OR (${field('m', 'dimension')}='daily' AND EXISTS (SELECT 1 FROM ${rowSource} AS social_row WHERE ${daily.join(' AND ')})))`);
      measurementArgs.push(...periodArgs, ...dailyArgs);
    }
    if (query.integrationMethod) { filters.push(`${field('d', 'integrationMethod')}=?`); parameters.push(query.integrationMethod); }
    if (query.from || query.to || query.scope || query.dimension) {
      filters.push(`EXISTS (SELECT 1 FROM ${tx.t('social_measurements')} m WHERE m.delivery_id=d.id AND ${measurementFilters.join(' AND ')})`);
      parameters.push(...measurementArgs);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('social_deliveries')} d ${where}`, parameters)).n);
    const deliveries = (await tx.db.all(`SELECT d.*,r.data AS social_revision_data,r.approved_at AS social_approved_at FROM ${tx.t('social_deliveries')} d JOIN ${tx.t('social_revisions')} r ON r.campaign_id=d.campaign_id AND r.revision=d.revision ${where} ORDER BY d.created_at DESC,d.id LIMIT 20 OFFSET ?`, [...parameters, (page - 1) * 20])).map(row => ({ ...entity(row), metricSpec: raw({ data: row.social_revision_data }).spec, approvedAt: row.social_approved_at }));
    const ids = deliveries.map(value => value.id);
    const empty = { deliveries: [], measurements: [], groups: [], selection, page, pages: Math.max(1, Math.ceil(total / 20)), total, asOf, providerDelayHours: 48, reachTotal: null, reachTotalReason: 'not_deduplicable_between_deliveries' };
    if (!ids.length) return empty;
    const snapshotFilters = [`m.delivery_id IN (${ids.map(() => '?').join(',')})`, ...measurementFilters], args = [...ids, ...measurementArgs];
    const resultKey = `COALESCE(${field('m', 'resultKey')},m.query_key)`, complete = tx.provider === 'sqlite' ? "json_extract(m.data,'$.coverage.complete')=1" : "m.data::jsonb#>>'{coverage,complete}'='true'";
    const newest = onlyComplete => tx.db.all(`SELECT * FROM (SELECT m.*,ROW_NUMBER() OVER (PARTITION BY m.delivery_id,${resultKey} ORDER BY m.fetched_at DESC,m.id DESC) AS social_rank FROM ${tx.t('social_measurements')} m WHERE ${snapshotFilters.join(' AND ')}${onlyComplete ? ` AND ${complete}` : ''}) ranked WHERE social_rank=1`, args);
    const [latest, completed] = await Promise.all([newest(false), newest(true)]), completeByKey = new Map(completed.map(row => [`${row.delivery_id}:${raw(row).resultKey || row.query_key}`, row]));
    const measurements = latest.map(row => {
      const data = raw(row), selected = completeByKey.get(`${row.delivery_id}:${data.resultKey || row.query_key}`) || row, selectedData = raw(selected), delivery = deliveries.find(value => value.id === row.delivery_id);
      const rows = selectedData.dimension === 'daily' && (query.from || query.to)
        ? selectedData.rows.filter(value => (!query.from || value.periodStart >= query.from) && (!query.to || value.periodEnd <= query.to)) : selectedData.rows;
      const staleAfter = delivery.channel === 'meta_ads' ? 2 * HOUR : 12 * HOUR;
      const anchor = publicationAnchor(delivery, delivery.metricSpec);
      const freshnessExpected = delivery.channel === 'meta_ads' ? delivery.state === 'active'
        : validTime(anchor) && Date.parse(asOf) <= Date.parse(anchor) + ((delivery.metricSpec.observationDays || 7) + 2) * DAY;
      return { id: selected.id, deliveryId: selected.delivery_id, queryKey: selected.query_key, fetchedAt: selected.fetched_at, ...selectedData,
        rows, selection: { ...selection, appliedTo: selectedData.dimension === 'daily' ? 'rows' : 'capture', originalPeriodStart: selectedData.query?.periodStart, originalPeriodEnd: selectedData.query?.periodEnd, originalRowCount: selectedData.rows?.length || 0, selectedRowCount: rows?.length || 0, originalCoverage: selectedData.coverage },
        stale: freshnessExpected && Date.parse(asOf) - Date.parse(selected.fetched_at) > staleAfter, freshnessExpected, ageMilliseconds: Date.parse(asOf) - Date.parse(selected.fetched_at), providerDelayHours: 48,
        comparableDefinition: Boolean(selectedData.definitionVersion), latestAttempt: { id: row.id, fetchedAt: row.fetched_at, periodStart: data.periodStart, periodEnd: data.periodEnd, coverage: data.coverage },
        newerPartial: row.id !== selected.id, selectedReason: row.id !== selected.id ? 'last_complete_capture' : data.coverage?.complete ? 'latest_complete_capture' : 'no_complete_capture' };
    });
    const groups = new Map();
    if (!query.campaignId) for (const measurement of measurements) {
      const delivery = deliveries.find(value => value.id === measurement.deliveryId);
      const descriptor = { currency: measurement.currency || null, mode: delivery.metricSpec.mode, scope: measurement.scope, network: delivery.channel, integrationMethod: measurement.integrationMethod };
      const key = JSON.stringify(descriptor);
      if (!groups.has(key)) groups.set(key, { ...descriptor, deliveryIds: [], measurementIds: [], reachTotal: null, reachTotalReason: 'not_deduplicable_between_deliveries' });
      const group = groups.get(key);
      if (!group.deliveryIds.includes(delivery.id)) group.deliveryIds.push(delivery.id);
      group.measurementIds.push(measurement.id);
    }
    return { ...empty, deliveries: deliveries.map(value => ({ id: value.id, campaignId: value.campaignId, channel: value.channel, state: value.state, lastConfirmedState: value.lastConfirmedState || null, metricSync: value.metricSync || null, nextSyncAt: value.nextSyncAt, integrationMethod: value.integrationMethod })), measurements, groups: [...groups.values()] };
  });
}
