import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSocialRecommendations, evaluateSocialRecommendation, selectSocialComparableSamples } from '../lib/business/social-analysis.mjs';
import { buildSocialMetricQueries } from '../lib/business/social-metrics.mjs';
import { CUT, DAY, exactMetric, improvementInput, improvementCandidates, improvementMeasurement, financialEvidence, addFatigue, addPlacements, refreshRatios } from './social-improvements-fixture.mjs';

const rules = input => buildSocialRecommendations(input).recommendations.map(rec => rec.ruleKey);
const rec = (input, key) => buildSocialRecommendations(input).recommendations.find(value => value.ruleKey === key);
const has = (input, key) => rules(input).includes(key);
const current = input => input.measurements.find(m => ['cumulative', 'horizon'].includes(m.query.window) && m.dimension === 'aggregate');
function setValue(input, key, value) { current(input).values[key] = value; refreshRatios(current(input), input.spec.objective); }
const history = (input, candidates) => { input.samples = selectSocialComparableSamples(input.spec, candidates, { asOf: input.asOf }).samples; };
function postingInput({ best = 120, count = 5 } = {}) {
  const input = improvementInput({ mode: 'organic' });
  history(input, [...improvementCandidates(input.spec, { suffix: 'night', clicks: Array(5).fill(20), reaches: Array(5).fill(100), publishedAt: '2026-10-01T05:00:00.000Z' }),
    ...improvementCandidates(input.spec, { suffix: 'afternoon', clicks: Array(count).fill(20), reaches: Array(count).fill(best), publishedAt: '2026-10-02T17:00:00.000Z' })]);
  return input;
}

test('applicable rules retain plan order, typed evidence and five-card ceiling without mutating evidence', () => {
  const input = addPlacements(addFatigue(improvementInput({ business: financialEvidence() })));
  const before = structuredClone(input), result = buildSocialRecommendations(input);
  assert.deepEqual(result.recommendations.map(value => value.ruleKey), ['weak_link_ctr', 'possible_fatigue', 'placement_cost_gap', 'declared_return_gap']);
  assert.deepEqual(result.recommendations.map(value => value.priority), [2, 3, 4, 7]);
  assert.equal(result.recommendations[0].metricIds.includes(current(input).id), true);
  assert.deepEqual([...result.recommendations[0].sampleIds].sort(), input.samples.map(sample => sample.campaignId).sort());
  assert.equal(result.recommendations.length <= 5, true);
  for (const recommendation of result.recommendations) {
    assert.equal(recommendation.analysisVersion, 'social-improvements-v1');
    assert.equal(recommendation.evidenceHash, result.recommendations[0].evidenceHash);
    assert.equal(typeof recommendation.successCriterion.metric, 'string');
    assert.equal(recommendation.metricIds.every(id => [...input.measurements, ...input.samples.map(s => s.measurement)].some(m => m.id === id)), true);
    assert.equal(recommendation.sampleIds.every(id => input.samples.some(s => s.campaignId === id)), true);
  }
  assert.deepEqual(input, before);
});

test('weak CTR uses strict Q25, exact ratios, known zero and at least five comparable campaigns', () => {
  for (const [clicks, expected] of [[149, true], [150, false], [0, true], [149.5, true]]) {
    const input = improvementInput(); setValue(input, 'linkClicks', exactMetric(clicks));
    assert.equal(has(input, 'weak_link_ctr'), expected, `clicks=${clicks}`);
  }
  const input = improvementInput(); input.samples.pop();
  assert.equal(has(input, 'measurement_gap'), true); assert.equal(has(input, 'weak_link_ctr'), false);
  for (const value of [{ ...exactMetric(100), precision: 'rounded', status: 'estimated' }, { ...exactMetric(null), status: 'unavailable', precision: 'unknown' }, { ...exactMetric(100), sourceMetric: '' }]) {
    const unknown = improvementInput(); setValue(unknown, 'linkClicks', value);
    assert.equal(has(unknown, 'measurement_gap'), true); assert.equal(has(unknown, 'weak_link_ctr'), false);
  }
  const fractional = improvementInput(); setValue(fractional, 'linkClicks', { ...exactMetric(149.5), status: 'estimated' });
  assert.equal(has(fractional, 'weak_link_ctr'), true);
  const zeroInHistory = improvementInput();
  history(zeroInHistory, improvementCandidates(zeroInHistory.spec, { clicks: [0, 100, 150, 200, 250] }));
  setValue(zeroInHistory, 'linkClicks', exactMetric(50));
  assert.equal(has(zeroInHistory, 'weak_link_ctr'), true);
});

test('sample definitions, attribution, source and completeness cannot be pooled into a fifth CTR benchmark', () => {
  const mutations = [s => { s.measurement.definitionVersion = 'other-definition'; }, s => { s.measurement.values.linkClicks.sourceMetric = 'other_click_definition'; },
    s => { s.measurement.attributionSetting = null; }, s => { s.measurement.integrationMethod = 'browser'; }, s => { s.measurement.scope = 'mixed'; },
    s => { s.measurement.coverage.complete = false; }, s => { s.measurement.values.linkClicks.precision = 'rounded'; },
    s => { s.measurement.query.window = 'recent_3d'; }, s => { s.measurement.values.impressions.value = 999; }];
  for (const mutate of mutations) {
    const input = improvementInput(); mutate(input.samples[0]);
    assert.equal(has(input, 'weak_link_ctr'), false, String(mutate));
  }
});

test('measurement gaps suppress only dependent recommendations, not verified placement evidence', () => {
  const input = addPlacements(improvementInput()); input.samples = [];
  assert.deepEqual(rules(input), ['measurement_gap', 'placement_cost_gap']);
  setValue(input, 'impressions', exactMetric(999, 'fixture_impressions'));
  assert.deepEqual(rules(input), ['measurement_gap']);
  setValue(input, 'impressions', exactMetric(1000, 'fixture_impressions'));
  assert.equal(has(input, 'placement_cost_gap'), true);
});

test('paid minimum age counts complete account-calendar days across DST, not 72 elapsed hours', () => {
  const input = improvementInput({ spec: { startAt: '2026-10-30T04:00:00.000Z', endAt: '2026-11-06T05:00:00.000Z', timeZone: 'America/New_York' } });
  input.deliveries[0].state = 'active'; input.deliveries[0].lastConfirmedState = 'active';
  for (const [asOf, expected] of [['2026-11-02T04:59:59.000Z', false], ['2026-11-02T05:00:00.000Z', true]]) {
    input.asOf = asOf;
    input.measurements = [improvementMeasurement(input.spec, input.deliveries[0], { now: asOf })];
    assert.equal(has(input, 'weak_link_ctr'), expected, asOf);
  }
});

test('an early confirmed activation does not age a future scheduled campaign', () => {
  const input = improvementInput({ spec: { startAt: '2026-11-03T05:00:00.000Z', endAt: '2026-11-10T05:00:00.000Z' } });
  input.deliveries[0].activatedAt = '2026-10-20T05:00:00.000Z';
  input.measurements = [];
  assert.deepEqual(buildSocialMetricQueries(input.deliveries[0], input.spec, { now: CUT }), []);
  assert.equal(has(input, 'measurement_gap'), true); assert.equal(has(input, 'weak_link_ctr'), false);
});

test('fatigue requires strict frequency >3 and inclusive CTR decline <=80%, each interval >=1000 impressions', () => {
  for (const [reach, clicks, impressions, expected] of [[500, 16, 2000, true], [500, 16.01, 2000, false], [1000, 16, 2000, false], [250, 8, 1000, true], [249, 7.992, 999, false]]) {
    const input = addFatigue(improvementInput()), recent = input.measurements.find(m => m.query.window === 'recent_3d');
    recent.values.reach = exactMetric(reach, 'fixture_reach'); recent.values.linkClicks = exactMetric(clicks); recent.values.impressions = exactMetric(impressions, 'fixture_impressions'); refreshRatios(recent);
    assert.equal(has(input, 'possible_fatigue'), expected, JSON.stringify({ reach, clicks, impressions }));
  }
  const atThree = addFatigue(improvementInput()), recent = atThree.measurements.find(m => m.query.window === 'recent_3d');
  recent.values.impressions = exactMetric(3000, 'fixture_impressions'); recent.values.reach = exactMetric(1000, 'fixture_reach'); recent.values.linkClicks = exactMetric(24); refreshRatios(recent);
  assert.equal(has(atThree, 'possible_fatigue'), false);
});

test('fatigue uses unique three-day aggregates, never sums daily reach or mismatched periods', () => {
  const input = addFatigue(improvementInput());
  const query = buildSocialMetricQueries(input.deliveries[0], input.spec, { now: CUT }).find(q => q.dimension === 'daily');
  const rows = ['2026-10-30', '2026-10-31', '2026-11-01'].map(date => ({ periodStart: date, periodEnd: date, dimensions: { date },
    values: { impressions: exactMetric(1000, 'fixture_impressions'), reach: exactMetric(1000, 'fixture_reach'), linkClicks: exactMetric(8) } }));
  input.measurements.push(improvementMeasurement(input.spec, input.deliveries[0], { dimension: 'daily', window: 'recent', query, rows }));
  assert.equal(has(input, 'possible_fatigue'), true);
  const noAggregate = structuredClone(input); noAggregate.measurements = noAggregate.measurements.filter(m => m.query.window !== 'recent_3d');
  assert.equal(has(noAggregate, 'possible_fatigue'), false);
  for (const mutate of [m => { m.coverage.complete = false; }, m => { m.scope = 'mixed'; }, m => { m.definitionVersion = 'different'; },
    m => { m.query.windowEnd = '2026-11-01T05:00:00.000Z'; m.periodEnd = m.query.windowEnd; }, m => { m.evidence.configurationDifferences = ['audience']; }]) {
    const changed = structuredClone(input); mutate(changed.measurements.find(m => m.query.window === 'recent_3d'));
    assert.equal(has(changed, 'possible_fatigue'), false, String(mutate));
  }
});

test('fatigue cannot use six elapsed days that contain fewer than six complete local days', () => {
  const input = improvementInput({ spec: { startAt: '2026-10-27T00:00:00.000Z', endAt: '2026-11-03T00:00:00.000Z' } });
  input.asOf = '2026-11-02T00:00:00.000Z';
  input.measurements = [improvementMeasurement(input.spec, input.deliveries[0], { now: input.asOf })];
  assert.equal(buildSocialMetricQueries(input.deliveries[0], input.spec, { now: input.asOf }).some(q => q.window === 'recent_3d'), false);
  assert.equal(has(input, 'possible_fatigue'), false);
});

test('placement cost uses exact primary results, inclusive twenty/80% boundaries and never unique reach', () => {
  for (const objective of ['traffic', 'whatsapp', 'engagement']) {
    const input = addPlacements(improvementInput({ objective }), { results: 20, best: 800000, other: 1000000 });
    const recommendation = rec(input, 'placement_cost_gap');
    assert.equal(recommendation.proposedChange.type, 'placement');
    assert.equal(has(addPlacements(improvementInput({ objective }), { results: 19 }), 'placement_cost_gap'), false);
    assert.equal(has(addPlacements(improvementInput({ objective }), { best: 800001 }), 'placement_cost_gap'), false);
  }
  assert.equal(has(addPlacements(improvementInput({ objective: 'reach' })), 'placement_cost_gap'), false);
  const rounded = addPlacements(improvementInput()); rounded.measurements.find(m => m.dimension === 'placement').rows[0].values.linkClicks.precision = 'rounded';
  assert.equal(has(rounded, 'placement_cost_gap'), false);
  for (const mutate of [m => { m.coverage.complete = false; }, m => { m.rows[0].values.spendMinor.precision = 'rounded'; },
    m => { m.rows[1].periodStart = '2026-10-27'; }, m => { m.rows[1].values.linkClicks.sourceMetric = 'different_click_definition'; }]) {
    const input = addPlacements(improvementInput()); mutate(input.measurements.find(m => m.dimension === 'placement'));
    assert.equal(has(input, 'placement_cost_gap'), false, String(mutate));
  }
});

test('organic response uses strict comparable Q25, same horizon and exact reach >=100', () => {
  for (const [reach, interactions, expected] of [[100, 14, true], [100, 15, false], [99, 1, false], [100, 0, true]]) {
    const input = improvementInput({ mode: 'organic' }); setValue(input, 'reach', exactMetric(reach, 'fixture_reach')); setValue(input, 'interactions', exactMetric(interactions, 'fixture_post_interactions'));
    assert.equal(has(input, 'organic_response'), expected, `${reach}/${interactions}`);
  }
  for (const mutate of [i => { current(i).scope = 'mixed'; }, i => { current(i).values.reach.precision = 'rounded'; }, i => { current(i).query.horizon = 14; },
    i => { i.asOf = '2026-11-01T12:00:00.000Z'; }, i => { i.samples.pop(); }]) {
    const input = improvementInput({ mode: 'organic' }); mutate(input);
    assert.equal(has(input, 'organic_response'), false, String(mutate));
  }
});

test('posting windows require five per band, local time and inclusive 120% median; networks stay separate', () => {
  const input = postingInput();
  assert.deepEqual(rules(input), ['organic_response', 'posting_window']);
  const recommendation = rec(input, 'posting_window');
  assert.equal(recommendation.proposedChange.type, 'posting_window');
  assert.equal(has(postingInput({ best: 119 }), 'posting_window'), false);
  assert.equal(has(postingInput({ count: 4 }), 'posting_window'), false);
  const unknownZone = postingInput(); unknownZone.spec.timeZone = null;
  assert.equal(has(unknownZone, 'posting_window'), false);
  const mixedNetworks = postingInput();
  for (const sample of mixedNetworks.samples.filter(s => s.campaignId.includes('afternoon'))) sample.channel = 'instagram';
  assert.equal(has(mixedNetworks, 'posting_window'), false);
  const otherHorizon = postingInput(); otherHorizon.samples.find(s => s.campaignId.includes('afternoon')).horizon = 14;
  assert.equal(has(otherHorizon, 'posting_window'), false);
  for (const [firstAt, secondAt, expected] of [['2026-10-01T05:00:00.000Z', '2026-10-02T10:00:00.000Z', false], ['2026-10-01T09:00:00.000Z', '2026-10-02T11:00:00.000Z', true]]) {
    const localBands = improvementInput({ mode: 'organic' });
    history(localBands, [...improvementCandidates(localBands.spec, { suffix: 'first', clicks: Array(5).fill(20), reaches: Array(5).fill(100), publishedAt: firstAt }),
      ...improvementCandidates(localBands.spec, { suffix: 'second', clicks: Array(5).fill(20), reaches: Array(5).fill(120), publishedAt: secondAt })]);
    assert.equal(has(localBands, 'posting_window'), expected, `${firstAt}/${secondAt} in America/Bogota`);
  }
});

test('financial rule needs five declared orders, complete COP coverage and strictly negative contribution', () => {
  for (const [orderCount, contributionMinor, complete, currency, expected] of [[5, 4999999, true, 'COP', true], [5, 5000000, true, 'COP', false], [4, 4000000, true, 'COP', false], [5, 4000000, false, 'COP', false], [5, 4000000, true, 'USD', false]]) {
    const input = improvementInput({ business: financialEvidence({ orderCount, contributionMinor, complete, currency }) });
    assert.equal(has(input, 'declared_return_gap'), expected, JSON.stringify({ orderCount, contributionMinor, complete, currency }));
    assert.equal(has(input, 'weak_link_ctr'), true, 'financial gaps must not hide verified CTR evidence');
  }
});

test('complete observation without a triggered rule returns no fabricated improvement', () => {
  const input = improvementInput(); setValue(input, 'linkClicks', exactMetric(200));
  const result = buildSocialRecommendations(input);
  assert.equal(result.observationComplete, true); assert.deepEqual(result.recommendations, []);
  for (const [fetchedAt, expectedGap] of [['2026-11-02T09:59:59.000Z', true], ['2026-11-02T10:00:00.000Z', false]]) {
    const stale = improvementInput(); stale.deliveries[0].state = 'active';
    stale.measurements = [improvementMeasurement(stale.spec, stale.deliveries[0], { now: fetchedAt })];
    assert.equal(has(stale, 'measurement_gap'), expectedGap, fetchedAt);
  }
});

function evaluationPair() {
  const input = improvementInput(), recommendation = rec(input, 'weak_link_ctr');
  const parent = { spec: input.spec, deliveries: input.deliveries, measurements: input.measurements, business: input.business };
  const child = structuredClone(parent);
  child.spec.startAt = '2026-11-03T05:00:00.000Z'; child.spec.endAt = '2026-11-10T05:00:00.000Z'; child.spec.caption = 'Texto cambiado por el usuario';
  child.deliveries[0].activatedAt = child.spec.startAt; child.deliveries[0].finalizedAt = child.spec.endAt;
  child.measurements = [improvementMeasurement(child.spec, child.deliveries[0], { now: '2026-11-10T12:00:00.000Z', values: { linkClicks: exactMetric(250) } })];
  return { recommendation, parent, child, asOf: '2026-11-10T12:00:00.000Z' };
}
test('child evaluation requires the KPI direction and original success criterion, not merely more volume', () => {
  const p = evaluationPair(), result = evaluateSocialRecommendation(p.recommendation, p);
  assert.equal(result.complete, true); assert.equal(result.conclusion, 'improved');
  const belowCriterion = evaluationPair(); belowCriterion.child.measurements[0].values.linkClicks = exactMetric(180); refreshRatios(belowCriterion.child.measurements[0]);
  assert.equal(evaluateSocialRecommendation(belowCriterion.recommendation, belowCriterion).conclusion, 'not_improved');
  const moreSpend = evaluationPair(); moreSpend.child.spec.budgetMinor *= 2;
  const m = moreSpend.child.measurements[0]; m.values.impressions.value *= 3; m.values.linkClicks.value *= 2; m.values.spendMinor.value *= 3; refreshRatios(m);
  assert.notEqual(evaluateSocialRecommendation(moreSpend.recommendation, moreSpend).conclusion, 'improved');
});

test('child evaluation blocks before horizon and resolves unknown or incompatible completed evidence inconclusively', () => {
  const early = evaluationPair(); early.asOf = '2026-11-09T12:00:00.000Z'; early.child.deliveries[0].state = 'active';
  assert.equal(evaluateSocialRecommendation(early.recommendation, early).complete, false);
  for (const mutate of [p => { p.child.measurements[0].scope = 'mixed'; }, p => { p.child.measurements[0].values.linkClicks.precision = 'rounded'; },
    p => { p.child.measurements[0].attributionSetting = null; }, p => { p.child.spec.integrationMethod = 'browser'; },
    p => { p.child.measurements[0].definitionVersion = 'other'; }, p => { p.child.spec.audience.ageMin = 25; },
    p => { p.child.spec.currency = 'USD'; }, p => { p.child.spec.endAt = new Date(Date.parse(p.child.spec.endAt) + DAY).toISOString(); }]) {
    const p = evaluationPair(); mutate(p); p.asOf = '2026-11-12T12:00:00.000Z';
    const result = evaluateSocialRecommendation(p.recommendation, p);
    assert.equal(result.complete, true); assert.equal(result.conclusion, 'inconclusive', String(mutate));
  }
});
