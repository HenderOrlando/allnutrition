import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../lib/business/commands.mjs';
import { buildSocialHistoricalForecast, compareSocialForecast, socialHistoryQuartiles, selectSocialComparableSamples } from '../lib/business/social-analysis.mjs';
import { formatSocialMoneyMinor, selectSocialEconomicForecast, socialBreakEven, socialBusinessAmounts, socialExpectedCost, socialPrimaryForecastRange } from '../lib/business/social-economics.mjs';

// All accounts, deliveries and measurements in this file are synthetic.
const NOW = '2026-11-02T12:00:00.000Z', DAY = 86400000;
const at = days => new Date(Date.parse('2026-10-01T12:00:00.000Z') + days * DAY).toISOString();
export const metric = (value, sourceMetric = 'synthetic_link_clicks') => ({ value, unit: 'count', sourceMetric, status: 'reported', precision: 'exact', displayValue: String(value), reason: null });
export function modelSpec(extra = {}) {
  return { mode: 'paid', objective: 'traffic', integrationMethod: 'api', assetType: 'image', platforms: ['facebook'], placements: ['facebook_feed'],
    identities: { businessId: '500', pageId: '200', adAccountId: 'act_400' }, marketCountries: ['CO'], audience: { countries: ['CO'], ageMin: 18 },
    budgetMinor: 5000000, currency: 'COP', timeZone: 'America/Bogota', startAt: at(40), endAt: at(47), observationDays: 7, ...extra };
}
export function modelSample(index, value, extra = {}) {
  const spec = modelSpec({ startAt: at(0), endAt: at(7), ...extra }), id = `synthetic-campaign-${index}`, channel = spec.mode === 'paid' ? 'meta_ads' : spec.platforms[0];
  const delivery = { id: `synthetic-delivery-${index}`, campaignId: id, channel, state: spec.mode === 'paid' ? 'completed' : 'published',
    lastConfirmedState: 'completed', finalizedAt: at(7), publishedAt: at(0), publicationTimeSource: 'publication_request_sent_at' };
  const query = { dimension: 'aggregate', window: spec.mode === 'paid' ? 'cumulative' : 'horizon', periodType: spec.mode === 'paid' ? 'range' : 'lifetime',
    timeZoneSource: 'account', horizon: 7, anchorAt: at(0), publicationTimeSource: 'publication_request_sent_at' };
  const measurement = { id: `synthetic-measurement-${index}`, deliveryId: delivery.id, fetchedAt: at(7), periodStart: at(0), periodEnd: at(7),
    integrationMethod: spec.integrationMethod, adapterVersion: 'synthetic-api-v1', apiVersion: 'v26.0', definitionVersion: 'synthetic-definition-v1', dimension: 'aggregate', scope: spec.mode,
    currency: 'COP', timeZone: 'America/Bogota', attributionSetting: ['7d_click'], actionReportTime: 'impression', query, coverage: { complete: true }, evidence: {},
    values: { linkClicks: metric(value), reach: metric(value, 'synthetic_reach'), impressions: metric(4000, 'synthetic_impressions'), spendMinor: { ...metric(5000000, 'spend'), unit: 'minor_currency' } } };
  return { id, spec, specHash: hash(spec), deliveries: [delivery], measurements: [measurement] };
}
const cohort = (extra = {}) => [100, 150, 200, 250, 300].map((value, index) => modelSample(index, value, extra));
const forecast = (spec, samples) => ({ ...buildSocialHistoricalForecast(spec, samples, { asOf: NOW }), specHash: hash(spec) });

test('type7 preserves exact cent projections and interpolated decimal counts', () => {
  assert.deepEqual(socialHistoryQuartiles([100, 150, 200, 250, 300]), { lower: 150, median: 200, upper: 250 });
  assert.deepEqual(socialHistoryQuartiles([[3, 100], [6, 100], [9, 100], [12, 100], [15, 100]], { budgetMinor: 100 }), { lower: 6, median: 9, upper: 12 });
  assert.deepEqual(socialHistoryQuartiles([0, 0.1, 0.2, 0.3, 0.4, 0.5]), { lower: 0.125, median: 0.25, upper: 0.375 });
});
test('five final campaigns yield quartiles, retain zero, and never count one campaign twice', () => {
  const spec = modelSpec(), samples = cohort(), value = forecast(spec, samples);
  assert.equal(value.metricRanges.linkClicks.lower, 150); assert.equal(value.metricRanges.linkClicks.median, 200); assert.equal(value.metricRanges.linkClicks.upper, 250);
  assert.equal(value.metricRanges.linkClicks.sampleCount, 5);
  samples[0].measurements[0].values.linkClicks = metric(0);
  assert.equal(forecast(spec, samples).metricRanges.linkClicks.samples.find(row => row.campaignId === samples[0].id).value, 0);
  assert.equal(forecast(spec, [...samples, samples[0]]).sampleCount, 5);
  assert.equal(forecast(spec, samples.slice(1)).metricRanges.linkClicks, undefined);
});

test('break-even uses the exact ceiling in the same currency, without treating an absent budget as zero', () => {
  const cop = { budgetCurrency: 'COP', contributionCurrency: 'COP' };
  assert.deepEqual(socialBreakEven({ ...cop, budgetMinor: 10000000, contributionMinor: 2500000 }), { status: 'estimated', sales: 4 });
  assert.deepEqual(socialBreakEven({ ...cop, budgetMinor: 10000000, contributionMinor: 3000000 }), { status: 'estimated', sales: 4 });
  assert.deepEqual(socialBreakEven({ budgetCurrency: 'USD', contributionCurrency: 'USD', budgetMinor: 101, contributionMinor: 100 }), { status: 'estimated', sales: 2 });
  for (const contributionMinor of [0, -2000000]) {
    assert.equal(socialBreakEven({ ...cop, budgetMinor: 10000000, contributionMinor }).status, 'nonpositive_contribution');
  }
  assert.equal(socialBreakEven({ ...cop, budgetMinor: null, contributionMinor: 2000000 }).status, 'missing_budget');
  assert.equal(socialBreakEven({ ...cop, budgetMinor: 10000000, contributionMinor: null }).status, 'missing_contribution');
  assert.equal(socialBreakEven({ ...cop, contributionCurrency: 'USD', budgetMinor: 10000000, contributionMinor: 2000000 }).status, 'incompatible_currency');
  assert.equal(socialBreakEven({ budgetMinor: 0 }).status, 'incompatible_currency');
  assert.equal(socialBreakEven({ ...cop, budgetMinor: 0 }).status, 'no_investment');
  assert.equal(socialBreakEven({ organic: true }).status, 'no_investment');
});

test('estimated cost follows only the forecast budget and positive primary quartiles', () => {
  const spec = modelSpec();
  const saved = { ...forecast(spec, cohort()), id: 'forecast-1', budgetMinor: spec.budgetMinor, currency: spec.currency };
  const draft = { ...spec, state: 'draft', forecastId: saved.id, validation: { specHash: saved.specHash }, forecasts: [saved] };
  const selected = selectSocialEconomicForecast(draft);
  const range = socialPrimaryForecastRange(selected, 'linkClicks');
  assert.equal(range.sampleCount, 5);
  const expected = socialExpectedCost(selected, range);
  assert.deepEqual(expected, { medianMinor: 25000, interval: { lowMinor: 20000, highMinor: 33333 } });
  assert.equal(formatSocialMoneyMinor(expected.medianMinor, selected.currency), 'COP 250');
  assert.deepEqual(socialExpectedCost(selected, { lower: 0, median: 200, upper: 250 }), { medianMinor: 25000, interval: null });
  assert.equal(socialExpectedCost(selected, { lower: 0, median: 0, upper: 250 }), null);
  assert.equal(socialExpectedCost({ ...selected, budgetMinor: 3 }, { lower: 0.125, median: 0.25, upper: 0.375 }).medianMinor, 12);
  assert.equal(selectSocialEconomicForecast(draft, { draftEdited: true }), null);
  assert.equal(selectSocialEconomicForecast({ ...draft, forecastId: 'another' }), null);
  assert.equal(selectSocialEconomicForecast({ ...draft, validation: { specHash: 'changed' } }), null);
  assert.equal(selectSocialEconomicForecast({ ...draft, budgetMinor: spec.budgetMinor * 2 }), null);
  const approved = { ...draft, state: 'active', budgetMinor: spec.budgetMinor * 2, revisions: [{ spec, specHash: saved.specHash, forecastId: saved.id, forecast: saved }] };
  assert.equal(selectSocialEconomicForecast(approved), saved);

  const four = { ...forecast(spec, cohort().slice(1)), budgetMinor: spec.budgetMinor, currency: spec.currency,
    manualScenario: { metric: 'linkClicks', lower: 100, upper: 300, basis: 'Hipótesis sintética' } };
  assert.equal(socialPrimaryForecastRange(four, 'linkClicks'), null);
  assert.equal(socialExpectedCost(four, socialPrimaryForecastRange(four, 'linkClicks')), null);
});

test('commercial summary shows the server result once and never upgrades a partial subtotal', () => {
  // Same recognized sales after returns, contribution, and committed spend as the finance contract.
  const full = valueMinor => ({ valueMinor, knownMinor: valueMinor, complete: true, currency: 'COP' });
  const partial = knownMinor => ({ valueMinor: null, knownMinor, complete: false, currency: 'COP' });
  const business = { orders: [{ id: 'order' }], recognizedProductSales: full(40000000), knownContribution: full(30800000),
    metaSpend: full(10000000), registeredAdvertising: full(4500000), advertisingPayments: full(2500000), contributionAfterAdvertising: full(20800000) };
  const summarized = socialBusinessAmounts(business);
  assert.deepEqual(summarized, { orderCount: 1, sales: { valueMinor: 40000000, complete: true },
    contribution: { valueMinor: 30800000, complete: true }, afterAdvertising: 20800000 });
  assert.deepEqual([summarized.sales.valueMinor, summarized.contribution.valueMinor, business.metaSpend.valueMinor, summarized.afterAdvertising]
    .map(value => formatSocialMoneyMinor(value, 'COP')), ['COP 400.000', 'COP 308.000', 'COP 100.000', 'COP 208.000']);
  const usdSpend = { ...full(10000), currency: 'USD' };
  const mixed = socialBusinessAmounts({ ...business, metaSpend: usdSpend, contributionAfterAdvertising: partial(null) });
  assert.equal(formatSocialMoneyMinor(usdSpend.valueMinor, usdSpend.currency), 'USD 100');
  assert.equal(formatSocialMoneyMinor(mixed.contribution.valueMinor, 'COP'), 'COP 308.000');
  assert.equal(formatSocialMoneyMinor(mixed.afterAdvertising, 'COP'), null);
  const incomplete = socialBusinessAmounts({ ...business, knownContribution: partial(12000000), contributionAfterAdvertising: partial(2000000) });
  assert.deepEqual(incomplete.contribution, { valueMinor: 12000000, complete: false });
  assert.equal(incomplete.afterAdvertising, null);
  assert.equal(socialBusinessAmounts({ ...business, metaSpend: { ...partial(10000000), newerPartial: true }, contributionAfterAdvertising: partial(20800000) }).afterAdvertising, null);
  const unlinked = socialBusinessAmounts({ orders: [], recognizedProductSales: partial(0), knownContribution: partial(0) });
  assert.equal(unlinked.orderCount, 0);
  assert.deepEqual(unlinked.sales, { valueMinor: null, complete: false });
});

test('cohort excludes mismatched configuration and incomplete or rounded definitions per metric', () => {
  const mutations = [
    sample => { sample.spec.audience.ageMin = 21; }, sample => { sample.spec.identities.businessId = '999'; },
    sample => { sample.spec.assetType = 'video'; }, sample => { sample.spec.placements = ['facebook_reels']; },
    sample => { sample.spec.budgetMinor = 100; }, sample => { sample.spec.integrationMethod = 'browser'; },
    sample => { sample.deliveries[0].lastConfirmedState = 'active'; }, sample => { sample.deliveries[0].finalizedAt = null; },
    sample => { sample.measurements[0].scope = 'mixed'; }, sample => { sample.measurements[0].coverage.complete = false; },
    sample => { sample.measurements[0].definitionVersion = 'different'; }, sample => { sample.measurements[0].attributionSetting = null; },
    sample => { sample.measurements[0].values.linkClicks = { ...metric(150), precision: 'rounded' }; },
    sample => { sample.measurements[0].values.linkClicks = { ...metric(null), status: 'unavailable', precision: 'unknown' }; },
    sample => { sample.measurements[0].evidence.configurationDifferences = ['budget']; },
    sample => { sample.measurements[0].values.impressions = metric(999); }, sample => { sample.measurements[0].values.spendMinor.value = 0; },
    sample => { sample.measurements[0].query.window = 'recent'; }, sample => { sample.measurements[0].dimension = 'daily'; },
    sample => { sample.measurements[0].periodEnd = at(6); }, sample => { sample.deliveries[0].finalizedAt = '2026-01-01T12:00:00.000Z'; }
  ];
  for (const mutate of mutations) {
    const samples = cohort(); mutate(samples[0]); samples[0].specHash = hash(samples[0].spec);
    assert.equal(forecast(modelSpec(), samples).metricRanges.linkClicks, undefined, String(mutate));
  }
});
test('new cohorts require the same confirmed market set; historical specs and approved forecast reads are unchanged', () => {
  const spec = modelSpec(), old = modelSample('historical', 125), different = modelSample('other-market', 125, { marketCountries: ['MX'] });
  delete old.spec.marketCountries;
  old.specHash = hash(old.spec);
  const oldHash = old.specHash, oldJSON = JSON.stringify(old);
  const selection = selectSocialComparableSamples(spec, [old, different, modelSample('same', 150)], { asOf: NOW });
  assert.deepEqual(selection.samples.map(sample => sample.campaignId), ['synthetic-campaign-same']);
  assert.deepEqual(selection.exclusions.map(item => item.reason), ['incompatible_specification', 'incompatible_specification']);
  assert.equal(selectSocialComparableSamples(old.spec, [old], { asOf: NOW }).samples.length, 0);
  const approved = forecast(modelSpec({ startAt: at(0), endAt: at(7) }), cohort());
  approved.specHash = oldHash;
  assert.equal(compareSocialForecast(old.spec, approved, old.deliveries, old.measurements, { asOf: NOW }).find(row => row.metric === 'linkClicks').reported.value, 125);
  assert.equal(JSON.stringify(old), oldJSON);
});
test('organic uses first full horizon capture and keeps networks separate without money extrapolation', () => {
  const extra = { mode: 'organic', objective: 'reach', budgetMinor: 0, platforms: ['facebook'], placements: ['facebook_feed'] }, spec = modelSpec(extra), samples = cohort(extra);
  for (const sample of samples) {
    const first = sample.measurements[0];
    sample.measurements.push({ ...structuredClone(first), id: first.id + '-late', fetchedAt: at(8.1), periodEnd: at(8.1), values: { reach: metric(999999, 'synthetic_reach') } });
    sample.measurements.push({ ...structuredClone(first), id: first.id + '-within', fetchedAt: at(7.5), periodEnd: at(7.5), values: { reach: metric(999, 'synthetic_reach') } });
  }
  const result = forecast(spec, samples), range = result.metricRanges['facebook.reach'];
  assert.equal(range.median, 200); assert.equal(range.samples[0].captureAgeMilliseconds, 7 * DAY); assert.equal(result.metricRanges.reach, undefined);
  samples[0].measurements[0].coverage.complete = false;
  assert.equal(forecast(spec, samples).metricRanges['facebook.reach'].samples.find(row => row.campaignId === samples[0].id).value, 999);
  samples[0].measurements = samples[0].measurements.filter(row => row.id.endsWith('-late'));
  assert.equal(forecast(spec, samples).metricRanges['facebook.reach'], undefined);
});
test('comparison uses approved final horizon and zero medians never produce percentages', () => {
  const spec = modelSpec({ startAt: at(0), endAt: at(7) }), samples = cohort(), approved = forecast(spec, samples), sample = modelSample('actual', 100);
  const comparisons = compareSocialForecast(spec, approved, sample.deliveries, sample.measurements, { asOf: NOW });
  const clicks = comparisons.find(row => row.metric === 'linkClicks');
  assert.equal(clicks.status, 'below'); assert.equal(clicks.differenceAbsolute, -100); assert.equal(clicks.differencePercent, -50);
  sample.deliveries[0].state = 'active';
  assert.equal(compareSocialForecast(spec, approved, sample.deliveries, sample.measurements, { asOf: NOW }).find(row => row.metric === 'linkClicks').status, 'in_progress');
  sample.deliveries[0].state = 'completed'; approved.metricRanges.linkClicks = { ...approved.metricRanges.linkClicks, lower: 0, median: 0, upper: 0 };
  const zero = compareSocialForecast(spec, approved, sample.deliveries, sample.measurements, { asOf: NOW }).find(row => row.metric === 'linkClicks');
  assert.equal(zero.differenceAbsolute, 100); assert.equal(zero.differencePercent, null);
  sample.measurements[0].currency = 'USD';
  assert.equal(compareSocialForecast(spec, approved, sample.deliveries, sample.measurements, { asOf: NOW }).find(row => row.metric === 'linkClicks').status, 'not_comparable');
});
test('organic analysis never substitutes lifetime months later and exposes capture age', () => {
  const extra = { mode: 'organic', objective: 'reach', budgetMinor: 0, platforms: ['facebook'], placements: ['facebook_feed'] }, spec = modelSpec(extra), samples = cohort(extra), approved = forecast(spec, samples), actual = modelSample('actual', 100, extra);
  actual.measurements.push({ ...structuredClone(actual.measurements[0]), id: 'months-later', fetchedAt: at(30), periodEnd: at(30), values: { reach: metric(10000, 'synthetic_reach') } });
  const result = compareSocialForecast(spec, approved, actual.deliveries, actual.measurements, { asOf: NOW }).find(row => row.metric === 'reach');
  assert.equal(result.reported.value, 100); assert.equal(result.captureAgeMilliseconds, DAY * 7);
  actual.measurements.shift();
  assert.equal(compareSocialForecast(spec, approved, actual.deliveries, actual.measurements, { asOf: NOW }).find(row => row.metric === 'reach').status, 'not_comparable');
});
test('14 and 28 day organic cohorts require their own first-day window', () => {
  for (const horizon of [14, 28]) {
    const extra = { mode: 'organic', objective: 'reach', budgetMinor: 0, platforms: ['facebook'], placements: ['facebook_feed'], observationDays: horizon };
    const spec = modelSpec(extra), samples = cohort(extra);
    for (const sample of samples) {
      const row = sample.measurements[0];
      row.query.horizon = horizon; row.periodEnd = at(horizon); row.fetchedAt = at(horizon);
    }
    assert.equal(forecast(spec, samples).metricRanges['facebook.reach'].median, 200);
    samples[0].measurements[0].query.horizon = 7;
    assert.equal(forecast(spec, samples).metricRanges['facebook.reach'], undefined);
  }
});
test('dual organic networks retain independent ranges and read-only cohort evidence', () => {
  const extra = { mode: 'organic', objective: 'reach', budgetMinor: 0, platforms: ['facebook', 'instagram'], placements: ['facebook_feed', 'instagram_feed'] };
  const spec = modelSpec(extra), samples = cohort(extra);
  for (const sample of samples) {
    const delivery = { ...sample.deliveries[0], id: sample.deliveries[0].id + '-ig', channel: 'instagram' };
    sample.deliveries.push(delivery);
    sample.measurements.push({ ...structuredClone(sample.measurements[0]), id: sample.measurements[0].id + '-ig', deliveryId: delivery.id, values: { reach: metric(500, 'synthetic_instagram_reach') } });
  }
  const result = forecast(spec, samples);
  assert.equal(result.metricRanges['facebook.reach'].median, 200); assert.equal(result.metricRanges['instagram.reach'].median, 500);
  assert.equal(result.metricRanges.reach, undefined); assert.equal(result.sampleCount, 5);
  const selected = selectSocialComparableSamples(spec, samples, { asOf: NOW, excludeCampaignId: samples[0].id });
  assert.equal(selected.samples.length, 8); assert.equal(selected.samples[0].measurementId, samples[1].measurements[0].id);
  assert.deepEqual(selected.samples[0].values, samples[1].measurements[0].values);
  const invalid = structuredClone(samples[0]); invalid.measurements[0].evidence.configurationDifferences = ['budget'];
  assert.equal(selectSocialComparableSamples(spec, [invalid], { asOf: NOW }).exclusions[0].reason, 'external_configuration_change');
});
