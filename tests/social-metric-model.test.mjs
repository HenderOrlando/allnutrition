import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocialMetric, socialMetricRatios, buildSocialMetricQueries, socialMetricsNextAt, socialMetricLifecycle } from '../lib/business/social-metrics.mjs';
import { socialMeasurementQueryKey } from '../lib/social/evidence.mjs';

const metric = (value, unit = 'count', patch = {}) => ({ value, unit, sourceMetric: 'fixture.reported', status: 'reported', precision: 'exact', displayValue: String(value), reason: null, ...patch });
const NOW = '2026-11-03T02:00:00.000Z';
const spec = { integrationMethod: 'api', mode: 'paid', objective: 'whatsapp', currency: 'COP', timeZone: 'America/Bogota', observationDays: 7, startAt: '2026-11-01T05:00:00.000Z' };
const active = { state: 'active', remoteId: '902', remoteRefs: { adId: '900' }, everActivated: true, activatedAt: spec.startAt };

test('ratios preserve cents and fractional estimates without confusing zero and missing denominators', () => {
  const values = { spendMinor: metric(10000000, 'minor_currency'), impressions: metric(4000), linkClicks: metric(100), conversations: metric(10.5, 'count', { status: 'estimated' }), reach: metric(1000, 'count', { status: 'estimated' }) };
  const ratios = socialMetricRatios(values, { objective: 'whatsapp' });
  assert.equal(ratios.ctrLinkPercent.value, 2.5); assert.equal(ratios.cpcLinkMinor.value, 100000); assert.equal(ratios.cpmMinor.value, 2500000);
  assert.equal(ratios.costPerConversationMinor.value, 952381); assert.equal(ratios.costPerConversationMinor.status, 'estimated'); assert.equal(ratios.frequency.value, 4);
  assert.equal(socialMetricRatios({ ...values, linkClicks: metric(0) }).cpcLinkMinor.value, null);
  assert.equal(socialMetricRatios({ ...values, linkClicks: metric(0) }).ctrLinkPercent.value, 0);
  assert.equal(socialMetricRatios({ ...values, linkClicks: undefined }).ctrLinkPercent.value, null);
  assert.equal(socialMetricRatios(values, { objective: 'traffic' }).costPerConversationMinor.status, 'unsupported');
});

test('rounded inputs, incomplete coverage and unsafe money cannot become exact costs', () => {
  const values = { spendMinor: metric(150000, 'minor_currency'), impressions: metric(1200, 'count', { status: 'estimated', precision: 'rounded', displayValue: '1,2 mil' }), linkClicks: metric(12) };
  assert.equal(socialMetricRatios(values).cpmMinor.value, null);
  assert.equal(socialMetricRatios(values, { complete: false }).cpcLinkMinor.value, null);
  for (const invalid of [metric(1.5, 'minor_currency'), metric(Infinity), metric(-1), metric(0, 'count', { sourceMetric: null }), metric(null, 'count', { reason: 'not_reported' }), metric(1200, 'count', { precision: 'rounded' })]) assert.throws(() => normalizeSocialMetric(invalid));
  const missing = normalizeSocialMetric({ value: null, unit: 'count', sourceMetric: 'fixture.reported', status: 'unavailable', precision: 'unknown', displayValue: '—', reason: 'not_reported' });
  assert.equal(missing.value, null); assert.equal(missing.displayValue, '—');
});

test('queries separate cumulative, recent, daily and each breakdown without summing people', () => {
  const queries = buildSocialMetricQueries(active, spec, { now: NOW });
  assert.equal(queries[0].periodStart, '2026-11-01'); assert.equal(queries[0].periodEnd, '2026-11-02'); assert.equal(queries[0].windowStart, '2026-11-01T05:00:00.000Z');
  const longer = buildSocialMetricQueries({ ...active, activatedAt: '2026-10-01T05:00:00.000Z' }, { ...spec, startAt: '2026-10-01T05:00:00.000Z' }, { now: NOW });
  assert.equal(longer[1].window, 'recent'); assert.equal(longer[1].periodStart, '2026-10-27');
});

test('three-day frequency windows exclude the partial day and keep unique reach intervals separate across DST', () => {
  const longer = { ...active, activatedAt: '2026-10-28T04:00:00.000Z' }, local = { ...spec, startAt: '2026-10-28T04:00:00.000Z', timeZone: 'America/New_York' }, now = '2026-11-03T12:00:00.000Z';
  const queries = buildSocialMetricQueries(longer, local, { now });
  const recent = queries.find(query => query.window === 'recent_3d'), prior = queries.find(query => query.window === 'previous_3d');
  assert.equal(recent.periodStart, '2026-10-31'); assert.equal(recent.periodEnd, '2026-11-02');
  assert.equal(recent.windowStart, '2026-10-31T04:00:00.000Z'); assert.equal(recent.windowEnd, '2026-11-03T05:00:00.000Z');
  assert.equal(prior.periodStart, '2026-10-28'); assert.equal(prior.periodEnd, '2026-10-30'); assert.equal(prior.windowEnd, recent.windowStart);
  const incompleteFirstDay = buildSocialMetricQueries({ ...longer, activatedAt: '2026-10-28T04:00:00.001Z' }, local, { now });
  assert.equal(incompleteFirstDay.some(query => query.window === 'recent_3d'), false);
});

test('an early activation confirmation cannot request metrics before the approved scheduled start', () => {
  const delivery = { ...active, state: 'scheduled', activatedAt: '2026-11-02T12:00:00.000Z' }, scheduled = { ...spec, startAt: '2026-11-04T12:00:00.000Z' };
  assert.deepEqual(buildSocialMetricQueries(delivery, scheduled, { now: NOW }), []);
  assert.equal(socialMetricsNextAt(delivery, scheduled, { now: NOW }), '2026-11-04T13:00:00.000Z');
  assert.equal(buildSocialMetricQueries(delivery, scheduled, { now: '2026-11-04T13:00:00.000Z' })[0].periodStart, '2026-11-04');
});

test('account midnight respects DST and an organic observation UTC is not a claimed account time zone', () => {
  const queries = buildSocialMetricQueries({ ...active, activatedAt: '2026-03-09T04:00:00.000Z' }, { ...spec, startAt: '2026-03-09T04:00:00.000Z', timeZone: 'America/New_York' }, { now: '2026-03-10T03:00:00.000Z' });
  assert.equal(queries[0].windowStart, '2026-03-09T04:00:00.000Z');
  const organic = buildSocialMetricQueries({ state: 'published', remoteId: '310', publishedAt: '2026-11-01T05:00:00.000Z', publicationTimeSource: 'provider_reported' }, { ...spec, mode: 'organic', timeZone: null }, { now: NOW });
  assert.equal(organic[0].timeZone, 'UTC'); assert.equal(organic[0].timeZoneSource, 'observation_utc'); assert.equal(organic[0].periodType, 'lifetime');
  assert.equal(organic[0].publicationTimeSource, 'provider_reported');
});

test('organic horizon captures retain actual capture age rather than labeling a months-old lifetime as seven days', () => {
  const delivery = { state: 'published', remoteId: '310', publishedAt: '2026-11-01T05:00:00.000Z' }, organic = { ...spec, mode: 'organic' };
  assert.equal(buildSocialMetricQueries(delivery, organic, { now: '2026-11-08T05:00:00.000Z' })[0].horizon, 7);
  assert.equal(buildSocialMetricQueries(delivery, organic, { now: '2026-11-10T05:00:00.000Z' })[0].horizon, undefined);
  assert.equal(buildSocialMetricQueries(delivery, organic, { now: '2027-01-01T05:00:00.000Z' })[0].horizon, undefined);
});

test('cadence keeps ready drafts without metrics, final seven-day rereads and a single final twenty-eight-day capture', () => {
  assert.equal(socialMetricsNextAt({ ...active, state: 'ready', everActivated: false }, spec, { now: NOW }), null);
  const ended = { ...active, state: 'completed', finalizedAt: '2026-11-02T05:00:00.000Z', metricSync: { lastCompletedAt: NOW } };
  assert.equal(socialMetricsNextAt(ended, spec, { now: NOW }), '2026-11-03T03:00:00.000Z');
  assert.equal(socialMetricsNextAt(ended, spec, { now: '2026-11-10T05:00:00.000Z' }), '2026-11-30T05:00:00.000Z');
  assert.equal(socialMetricsNextAt({ ...ended, metricSync: { ...ended.metricSync, final28At: '2026-11-30T05:00:00.000Z' } }, spec, { now: '2026-12-01T05:00:00.000Z' }), null);
  assert.equal(socialMetricLifecycle(active, { state: 'active' }, { now: '2027-01-01T00:00:00.000Z' }).finalizedAt, undefined);
});

test('query identity separates a changed definition without rewriting historical measurement identities', () => {
  const base = { integrationMethod: 'api', adapterVersion: 'meta-api-v1', apiVersion: 'v26.0', query: { since: '2026-11-01' }, periodStart: spec.startAt, periodEnd: NOW, timeZone: spec.timeZone, scope: 'paid', attributionSetting: null, actionReportTime: 'impression', dimension: 'aggregate' };
  const first = socialMeasurementQueryKey({ ...base, definitionVersion: 'definition-one', entity: { type: 'ad', id: '900' } });
  const changed = socialMeasurementQueryKey({ ...base, definitionVersion: 'definition-two', entity: { type: 'ad', id: '900' } });
  assert.notEqual(first, changed); assert.notEqual(first, socialMeasurementQueryKey(base));
});

test('reanudar tras la captura de pausa no cancela la captura final de una pausa posterior', () => {
  const old = { ...active, state: 'paused', pausedAt: '2026-09-01T05:00:00.000Z', metricSync: { lastCompletedAt: '2026-09-29T05:00:00.000Z', final28At: '2026-09-29T05:00:00.000Z' } };
  const resumed = { ...old, ...socialMetricLifecycle(old, { state: 'active' }, { now: NOW }), state: 'active' };
  const pausedAgain = { ...resumed, ...socialMetricLifecycle(resumed, { state: 'paused' }, { now: NOW }), state: 'paused' };
  assert.equal(socialMetricsNextAt(pausedAgain, spec, { now: '2026-11-11T02:00:00.000Z' }), '2026-12-01T02:00:00.000Z');
});
