import { MAX_MONEY_MINOR, formatMoneyMinor, roundRatio } from './money.mjs';

export const socialCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const moneyAmount = value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_MONEY_MINOR;

export function formatSocialMoneyMinor(value, currency) {
  if (!Number.isSafeInteger(value)) return null;
  return `${socialCurrency(currency) ? currency : 'Moneda no informada ·'} ${formatMoneyMinor(value, { currency: null })}`;
}

export function socialBreakEven({ budgetMinor, budgetCurrency, contributionMinor, contributionCurrency, organic = false }) {
  if (organic || budgetMinor === 0 && socialCurrency(budgetCurrency)) return { status: 'no_investment' };
  if (!moneyAmount(budgetMinor) || budgetMinor < 0) return { status: 'missing_budget' };
  if (!socialCurrency(budgetCurrency) || !socialCurrency(contributionCurrency) || budgetCurrency !== contributionCurrency) {
    return { status: 'incompatible_currency' };
  }
  if (!moneyAmount(contributionMinor)) return { status: 'missing_contribution' };
  if (contributionMinor <= 0) return { status: 'nonpositive_contribution' };
  const budget = BigInt(budgetMinor), contribution = BigInt(contributionMinor);
  return { status: 'estimated', sales: Number((budget + contribution - 1n) / contribution) };
}

export function selectSocialEconomicForecast(campaign, { draftEdited = false } = {}) {
  if (!campaign) return null;
  const approval = campaign.revisions?.at(-1);
  const spec = approval?.spec ?? campaign;
  const specHash = approval ? approval.specHash : campaign.validation?.specHash;
  const forecast = approval ? approval.forecastId && approval.forecast
    : !draftEdited && campaign.state === 'draft' && campaign.forecastId && campaign.forecasts?.find(item => item.id === campaign.forecastId);
  return forecast && specHash && forecast.specHash === specHash && forecast.budgetMinor === spec.budgetMinor && forecast.currency === spec.currency ? forecast : null;
}

export function socialPrimaryForecastRange(forecast, key) {
  const range = forecast?.metricRanges?.[key];
  return range?.source === 'history' && range.rangeKind === 'observed_quartiles' && range.sampleCount >= 5 &&
    [range.lower, range.median, range.upper].every(value => Number.isFinite(value) && value >= 0) &&
    range.lower <= range.median && range.median <= range.upper ? range : null;
}

// Metric quartiles arrive as JSON decimals (including exponent notation). Round
// the final ratio for display in minor units, not a floating-point intermediate.
function costForResult(budget, results) {
  if (!Number.isFinite(results) || results <= 0) return null;
  const [digits, exponent = '0'] = String(results).split('e');
  const [whole, fraction = ''] = digits.split('.');
  const power = Number(exponent) - fraction.length, denominator = BigInt(whole + fraction);
  const scaledBudget = budget * 10n ** BigInt(Math.max(-power, 0));
  const scaledResults = denominator * 10n ** BigInt(Math.max(power, 0));
  if (scaledBudget > BigInt(Number.MAX_SAFE_INTEGER) * scaledResults) return null;
  return roundRatio(scaledBudget, scaledResults);
}

export function socialExpectedCost(forecast, range) {
  if (!moneyAmount(forecast?.budgetMinor) || forecast.budgetMinor < 0 || !socialCurrency(forecast.currency)) return null;
  const budget = BigInt(forecast.budgetMinor);
  const medianMinor = costForResult(budget, range?.median);
  if (medianMinor === null) return null;
  const lowMinor = costForResult(budget, range.upper), highMinor = costForResult(budget, range.lower);
  return { medianMinor, interval: lowMinor === null || highMinor === null ? null : { lowMinor, highMinor } };
}

export function socialBusinessAmounts(business) {
  const summarize = (component, facts) => {
    if (!component) return null;
    if (component.complete === true) return { valueMinor: component.valueMinor, complete: true };
    const known = component.knownMinor != null && (component.knownMinor !== 0 || facts?.some(fact => fact.known === true && fact.value != null));
    return { valueMinor: known ? component.knownMinor : null, complete: false };
  };
  const after = business.contributionAfterAdvertising;
  return {
    orderCount: business.orders.length,
    sales: summarize(business.recognizedProductSales, business.facts?.netProductSales),
    contribution: summarize(business.knownContribution, business.facts?.contribution),
    // The accounting endpoint owns coverage, currency, and subtraction. Never
    // substitute a point-in-time Insights amount, registered expense or payment.
    afterAdvertising: after?.complete === true ? after.valueMinor : null,
  };
}
