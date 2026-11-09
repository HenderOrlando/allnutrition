import { fail, integer, text } from '../validation-core.mjs';
import { entity, hash, insertRow, newId, stamp, runCommand, audit, assertLease } from './commands.mjs';
import { instant } from './dates.mjs';
import { buildSocialSpec, verifySocialApiTargeting } from './social-spec.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { decryptCredentials } from '../social/credentials.mjs';
import { loadSocialRuntime } from '../social/config.mjs';
import { socialMetricAnchor, socialMetricRatios, buildSocialMetricQueries } from './social-metrics.mjs';
import { getSocialBusinessResultTx } from './social-links.mjs';
import { queueSocialAnalysisTx } from './social-analysis-queue.mjs';
import { jobClock } from './job-leases.mjs';

export const SOCIAL_HISTORY_VERSION = 'social-history-v1';
const DAY = 86400000;
const METRICS = ['impressions', 'reach', 'linkClicks', 'conversations', 'interactions', 'views', 'plays'];
const raw = row => JSON.parse(row?.data || '{}');
const get = async (tx, table, id) => entity(await tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`, [id]));
const exact = value => value && ['reported', 'estimated'].includes(value.status) && value.precision === 'exact' && typeof value.sourceMetric === 'string' && value.sourceMetric.length > 0 && typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && value.value <= Number.MAX_SAFE_INTEGER;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function identifier(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('Identificador de campaña no válido.');
  return value;
}
async function requireActor(tx, actorId, lease, asOf) {
  if (actorId === 'scheduler') {
    if (!lease || lease.key !== `social:analysis:${lease.campaignId}`) fail('El análisis automático requiere su lease de campaña.', 403);
    await assertLease(tx, { ...lease, now: asOf });
  } else if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [text(actorId, 'Administrador', 100, true)])) fail('El administrador debe estar activo.', 403);
}
function actorStore(store, actorId, lease, asOf) {
  return { transaction: fn => store.transaction(async tx => {
    await tx.lockWrites(); await requireActor(tx, actorId, lease, asOf); return fn(tx);
  }) };
}
function fraction(value) {
  const [base, exp = '0'] = String(value).toLowerCase().split('e');
  const [whole, decimals = ''] = base.split('.'), power = decimals.length - Number(exp), n = BigInt(whole + decimals);
  return power < 0 ? [n * 10n ** BigInt(-power), 1n] : [n, 10n ** BigInt(power)];
}
const multiply = ([a, b], [c, d]) => [a * c, b * d];
const divide = ([a, b], [c, d]) => [a * d, b * c];
const rationalNumber = ([n, d]) => Number(n) / Number(d);
function quantile(values, quarter) {
  const sorted = [...values].sort(([a, b], [c, d]) => a * d < c * b ? -1 : a * d > c * b ? 1 : 0);
  const position = (sorted.length - 1) * quarter, lower = Math.floor(position / 4), weight = BigInt(position % 4);
  const [a, b] = sorted[lower], [c, d] = sorted[Math.min(lower + 1, sorted.length - 1)];
  return [a * d * (4n - weight) + c * b * weight, b * d * 4n];
}
// Decimal counts and cent amounts remain rational until the final presentation.
export function socialHistoryQuartiles(values, { budgetMinor = null } = {}) {
  if (!values.length) fail('No hay muestras para calcular cuartiles.');
  if (budgetMinor !== null) integer(budgetMinor, 'Presupuesto', 0, Number.MAX_SAFE_INTEGER);
  for (const value of values) {
    const entries = Array.isArray(value) ? value : [value];
    if (entries.some(entry => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > Number.MAX_SAFE_INTEGER) ||
      Array.isArray(value) && (value.length !== 2 || value[1] <= 0)) fail('Muestra histórica no válida.');
  }
  const fractions = values.map(value => Array.isArray(value) ? divide(fraction(value[0]), fraction(value[1])) : fraction(value));
  const q = [1, 2, 3].map(part => multiply(quantile(fractions, part), fraction(budgetMinor ?? 1)));
  const lower = budgetMinor === null ? rationalNumber(q[0]) : Number(q[0][0] / q[0][1]);
  const upper = budgetMinor === null ? rationalNumber(q[2]) : Number((q[2][0] + q[2][1] - 1n) / q[2][1]);
  const median = rationalNumber(q[1]);
  if ([lower, median, upper].some(value => !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER)) return null;
  return { lower, median, upper };
}
function duration(spec) { return Date.parse(spec.endAt) - Date.parse(spec.startAt); }
function accountKey(spec) {
  const ids = spec.identities || {};
  return hash({ businessId: ids.businessId || null, pageId: ids.pageId || null, instagramId: spec.platforms?.includes('instagram') ? ids.instagramId || null : null, adAccountId: spec.mode === 'paid' ? ids.adAccountId || null : null });
}
function comparableSpec(proposal, sample) {
  if (!sample || !sample.identities?.businessId || !sample.identities.pageId || !['image', 'video'].includes(sample.assetType) || !Array.isArray(sample.platforms) || !Array.isArray(sample.placements)) return false;
  if (['integrationMethod', 'mode', 'objective', 'assetType', 'currency', 'timeZone'].some(key => proposal[key] !== sample[key]) || accountKey(proposal) !== accountKey(sample)) return false;
  if (hash(proposal.platforms) !== hash(sample.platforms) || hash(proposal.placements) !== hash(sample.placements)) return false;
  if (proposal.mode === 'organic') return proposal.observationDays === sample.observationDays;
  const p = duration(proposal), s = duration(sample);
  if (!(p > 0 && s >= p / 2 && s <= p * 2 && Number.isSafeInteger(sample.budgetMinor) && sample.budgetMinor > 0)) return false;
  const sampleDaily = BigInt(sample.budgetMinor) * BigInt(p), proposedDaily = BigInt(proposal.budgetMinor) * BigInt(s);
  return sampleDaily * 2n >= proposedDaily && sampleDaily <= proposedDaily * 2n && hash(proposal.audience) === hash(sample.audience);
}
function completeMeasurement(measurement, spec) {
  return measurement.coverage?.complete === true && measurement.dimension === 'aggregate' && measurement.query?.dimension === 'aggregate' &&
    measurement.scope === spec.mode && measurement.integrationMethod === spec.integrationMethod && Boolean(measurement.definitionVersion) &&
    Boolean(measurement.adapterVersion) && measurement.timeZone === (spec.timeZone || 'UTC') &&
    (spec.timeZone || measurement.query.timeZoneSource === 'observation_utc') && time(measurement.periodStart) && time(measurement.periodEnd) &&
    (!measurement.evidence?.configurationDifferences?.length) && (spec.mode !== 'paid' || measurement.currency === spec.currency &&
      measurement.attributionSetting != null && measurement.actionReportTime != null);
}
function finalDelivery(delivery, spec) {
  return spec.mode === 'organic' ? delivery.state === 'published' && time(delivery.publishedAt) :
    delivery.state === 'completed' && delivery.lastConfirmedState === 'completed' && time(delivery.finalizedAt);
}
function selectMeasurement(delivery, spec, measurements, asOf, { final = true } = {}) {
  const rows = measurements.filter(row => row.deliveryId === delivery.id && row.fetchedAt <= asOf).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id));
  if (spec.mode === 'organic') {
    if (!time(delivery.publishedAt) || !['publication_request_sent_at', 'remote_published_at'].includes(delivery.publicationTimeSource)) return null;
    const horizon = spec.observationDays, anchor = Date.parse(delivery.publishedAt), start = anchor + horizon * DAY;
    return rows.find(row => completeMeasurement(row, spec) && row.query.window === 'horizon' && row.query.periodType === 'lifetime' && row.query.horizon === horizon &&
      row.query.anchorAt === delivery.publishedAt && row.query.publicationTimeSource === delivery.publicationTimeSource &&
      Date.parse(row.periodEnd) >= start && Date.parse(row.periodEnd) <= start + DAY && Date.parse(row.fetchedAt) >= start && Date.parse(row.fetchedAt) <= start + DAY) || null;
  }
  return rows.filter(row => completeMeasurement(row, spec) && row.query.window === 'cumulative' && row.query.periodType === 'range' &&
    Date.parse(row.periodStart) <= Date.parse(socialMetricAnchor(delivery, spec)) && Date.parse(socialMetricAnchor(delivery, spec)) - Date.parse(row.periodStart) < DAY &&
    (!final || Date.parse(row.periodEnd) >= Date.parse(spec.endAt))).at(-1) || null;
}
function definition(measurement, metric, channel) {
  return { metric, channel, unit: measurement.values[metric].unit, sourceMetric: measurement.values[metric].sourceMetric,
    scope: measurement.scope, definitionVersion: measurement.definitionVersion, integrationMethod: measurement.integrationMethod,
    adapterVersion: measurement.adapterVersion, apiVersion: measurement.apiVersion ?? null, attributionSetting: measurement.attributionSetting ?? null,
    actionReportTime: measurement.actionReportTime ?? null, currency: measurement.currency ?? null, timeZone: measurement.timeZone,
    periodType: measurement.query.periodType, timeZoneSource: measurement.query.timeZoneSource || null };
}
function metricAllowed(spec, channel, metric) {
  if (metric === 'conversations') return spec.mode === 'paid' && spec.objective === 'whatsapp';
  if (spec.mode === 'organic' && channel === 'instagram' && metric === 'linkClicks') return false;
  return true;
}
export function selectSocialComparableSamples(spec, candidates, { asOf = stamp(), excludeCampaignId = null } = {}) {
  const samples = [], exclusions = [], cut = Date.parse(asOf) - 90 * DAY, seen = new Set();
  for (const sample of candidates) {
    const reject = (reason, channel = null) => exclusions.push({ campaignId: sample.id, channel, reason });
    if (sample.id === excludeCampaignId) continue;
    if (!comparableSpec(spec, sample.spec) || sample.specHash !== hash(sample.spec)) { reject('incompatible_specification'); continue; }
    if (spec.mode === 'paid' && sample.deliveries.length !== 1) { reject('ambiguous_paid_delivery'); continue; }
    for (const delivery of sample.deliveries) {
      if (!finalDelivery(delivery, sample.spec)) { reject('unconfirmed_finality', delivery.channel); continue; }
      const finished = spec.mode === 'paid' ? delivery.finalizedAt : delivery.publishedAt;
      const published = spec.mode === 'paid' ? sample.spec.startAt : delivery.publishedAt;
      if (!time(published) || Date.parse(published) < cut || Date.parse(finished) < cut || finished > asOf) { reject('outside_ninety_day_window', delivery.channel); continue; }
      if (sample.measurements.some(row => row.deliveryId === delivery.id && row.fetchedAt <= asOf && row.evidence?.configurationDifferences?.length)) { reject('external_configuration_change', delivery.channel); continue; }
      const measurement = selectMeasurement(delivery, sample.spec, sample.measurements, asOf);
      if (!measurement) { reject('missing_complete_approved_window', delivery.channel); continue; }
      if (spec.mode === 'paid' && (!exact(measurement.values.impressions) || measurement.values.impressions.value < 1000 || !exact(measurement.values.spendMinor) || !Number.isSafeInteger(measurement.values.spendMinor.value) || measurement.values.spendMinor.value <= 0)) { reject('insufficient_exact_impressions_or_spend', delivery.channel); continue; }
      const key = `${sample.id}:${delivery.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({ campaignId: sample.id, spec: sample.spec, specHash: sample.specHash, channel: delivery.channel, delivery, measurement,
        measurementId: measurement.id, values: measurement.values, ratios: measurement.ratios || {}, currency: measurement.currency,
        definitionVersion: measurement.definitionVersion, attributionSetting: measurement.attributionSetting,
        publishedAt: delivery.publishedAt || null, horizon: spec.mode === 'paid' ? { startAt: sample.spec.startAt, endAt: sample.spec.endAt } : sample.spec.observationDays,
        captureAgeMilliseconds: spec.mode === 'organic' ? Date.parse(measurement.periodEnd) - Date.parse(delivery.publishedAt) : null,
        providerDelayHours: measurement.evidence?.providerDelayHours ?? 48 });
    }
  }
  return { samples, exclusions };
}
export function buildSocialHistoricalForecast(spec, samples, { asOf = stamp() } = {}) {
  const buckets = new Map();
  for (const sample of selectSocialComparableSamples(spec, samples, { asOf }).samples) {
    const { measurement, channel } = sample;
    for (const metric of METRICS) {
      const value = measurement.values[metric];
      if (!metricAllowed(spec, channel, metric) || !exact(value)) continue;
      const key = spec.mode === 'paid' ? metric : `${channel}.${metric}`, def = definition(measurement, metric, channel), bucketKey = `${key}:${hash(def)}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, { key, def, samples: new Map() });
      buckets.get(bucketKey).samples.set(sample.campaignId, { campaignId: sample.campaignId, measurementId: measurement.id, value: value.value, spendMinor: measurement.values.spendMinor?.value,
        fetchedAt: measurement.fetchedAt, captureAgeMilliseconds: sample.captureAgeMilliseconds, providerDelayHours: sample.providerDelayHours });
    }
  }
  const metricRanges = {}, unavailableReasons = [], counts = {};
  for (const bucket of [...buckets.values()].sort((a, b) => b.samples.size - a.samples.size || hash(a.def).localeCompare(hash(b.def)))) {
    counts[bucket.key] = Math.max(counts[bucket.key] || 0, bucket.samples.size);
    if (bucket.samples.size < 5 || metricRanges[bucket.key]) continue;
    const entries = [...bucket.samples.values()], quartiles = socialHistoryQuartiles(entries.map(entry => spec.mode === 'paid' ? [entry.value, entry.spendMinor] : entry.value), { budgetMinor: spec.mode === 'paid' ? spec.budgetMinor : null });
    if (!quartiles) continue;
    metricRanges[bucket.key] = { ...quartiles, ...bucket.def, horizon: spec.mode === 'paid' ? { startAt: spec.startAt, endAt: spec.endAt } : spec.observationDays,
      sampleIds: entries.map(entry => entry.campaignId).sort(), sampleCount: entries.length, samples: entries, rangeKind: 'observed_quartiles', source: 'history' };
  }
  for (const metric of METRICS) for (const channel of spec.mode === 'paid' ? ['meta_ads'] : spec.platforms) {
    if (!metricAllowed(spec, channel, metric)) continue;
    const key = spec.mode === 'paid' ? metric : `${channel}.${metric}`;
    if (!metricRanges[key]) unavailableReasons.push({ metric: key, reason: 'fewer_than_five_comparable_complete_campaigns', sampleCount: counts[key] || 0 });
  }
  const sampleIds = [...new Set(Object.values(metricRanges).flatMap(range => range.sampleIds))].sort();
  return { metricRanges, sampleIds, sampleCount: sampleIds.length, unavailableReasons };
}
function manualScenario(spec, input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['metric', 'lower', 'upper', 'basis'].includes(key))) fail('Escenario declarado no válido.');
  const primary = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' }[spec.objective];
  const keys = spec.mode === 'paid' ? [primary] : spec.platforms.filter(channel => metricAllowed(spec, channel, primary)).map(channel => `${channel}.${primary}`);
  const metric = keys.includes(input.metric) ? input.metric : keys.length === 1 && keys[0].endsWith(`.${input.metric}`) ? keys[0] : null;
  if (!metric || spec.mode === 'organic' && spec.objective === 'whatsapp' || !Number.isFinite(input.lower) || !Number.isFinite(input.upper) || input.lower < 0 || input.upper < input.lower || input.upper > Number.MAX_SAFE_INTEGER) fail('El escenario requiere una métrica primaria compatible y límites finitos no negativos.');
  return { metric, lower: input.lower, upper: input.upper, basis: text(input.basis, 'Fundamento del escenario', 2000, true), source: 'manual' };
}
async function proposal(tx, id, version, now) {
  const campaign = await get(tx, 'social_campaigns', id); if (!campaign) fail('Campaña no encontrada.', 404);
  if (campaign.state !== 'draft' || campaign.version !== version) fail('La previsión requiere la versión actual del borrador.', 409);
  const connection = await get(tx, 'social_connections', campaign.connectionId), asset = await get(tx, 'social_assets', campaign.assetId);
  const built = buildSocialSpec(campaign, { connection, asset, now });
  const credential = connection ? await tx.db.get(`SELECT * FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]) : null;
  return { campaign, connection, asset, credential, ...built };
}
function proposalFence(value) {
  return hash({ campaignVersion: value.campaign.version, specHash: value.specHash, connectionVersion: value.connection.version, assetVersion: value.asset.version,
    sessionEpoch: value.connection.sessionEpoch || 0, credentialVersion: value.credential?.version ?? null, credentialUpdatedAt: value.credential?.updated_at ?? null, preflight: value.campaign.preflight || null });
}
async function samplesTx(tx, asOf) {
  const cut = new Date(Date.parse(asOf) - 90 * DAY).toISOString();
  const revisions = (await tx.db.all(`SELECT * FROM ${tx.t('social_revisions')} ORDER BY campaign_id,revision`)).map(entity);
  const deliveries = (await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')}`)).map(entity);
  const measurements = (await tx.db.all(`SELECT * FROM ${tx.t('social_measurements')} WHERE fetched_at>=? AND fetched_at<=? ORDER BY fetched_at,id`, [cut, asOf])).map(entity);
  const byRevision = new Map(revisions.map(revision => [`${revision.campaignId}:${revision.revision}`, { id: revision.campaignId, spec: revision.spec, specHash: revision.specHash, deliveries: [], measurements: [] }]));
  const byDelivery = new Map();
  for (const delivery of deliveries) {
    const sample = byRevision.get(`${delivery.campaignId}:${delivery.revision}`);
    if (sample) { sample.deliveries.push(delivery); byDelivery.set(delivery.id, sample); }
  }
  for (const measurement of measurements) byDelivery.get(measurement.deliveryId)?.measurements.push(measurement);
  return [...byRevision.values()];
}
// The caller supplies an existing coherent readSnapshot/transaction; this helper
// does not open a nested transaction or make any provider requests.
export async function readSocialComparableSamplesTx(tx, spec, { asOf, excludeCampaignId = null } = {}) {
  asOf = instant(asOf, 'Corte del historial');
  return selectSocialComparableSamples(spec, await samplesTx(tx, asOf), { asOf, excludeCampaignId });
}
function audienceValue(value, { source, fetchedAt, specHash }) {
  const available = value?.status === 'reported' && Number.isFinite(value.lower) && value.lower >= 0 && Number.isFinite(value.upper) && value.upper >= value.lower;
  const result = { status: available ? 'reported' : 'unavailable', lower: available ? value.lower : null, upper: available ? value.upper : null,
    source, definition: value?.definition || 'potential_audience', label: value?.label ?? null, horizon: value?.horizon ?? null, displayValue: value?.displayValue ?? null,
    fetchedAt: value?.fetchedAt || fetchedAt, specHash, apiVersion: value?.apiVersion ?? null, adapterVersion: value?.adapterVersion ?? null,
    reason: available ? null : 'Meta no ofrece estimación para esta audiencia.' };
  return { ...result, evidenceHash: hash(result) };
}
async function audienceFor(tx, snapshot, now) {
  const preflight = snapshot.campaign.preflight;
  const operation = preflight?.operationId ? await get(tx, 'social_operations', preflight.operationId) : null;
  if (preflight?.kind !== 'validate' || preflight.specHash !== snapshot.specHash || !time(preflight.checkedAt) ||
    operation?.state !== 'confirmed' || operation.step !== 'validate' || operation.deliveryId || operation.campaignVersion !== snapshot.campaign.version - 1 ||
    operation.specHash !== snapshot.specHash || hash(operation.spec || null) !== snapshot.specHash || operation.result?.status !== 'confirmed' ||
    hash(operation.result.audienceEstimate || null) !== hash(preflight.audienceEstimate || null)) return audienceValue(null, { source: 'meta_ui', fetchedAt: now, specHash: snapshot.specHash });
  return audienceValue(preflight.audienceEstimate, { source: 'meta_ui', fetchedAt: preflight.checkedAt, specHash: snapshot.specHash });
}
export async function estimateSocialCampaign(store, campaignId, { version, requestId, manualScenario: scenario = null, env = process.env, transport = {}, now = stamp() }, actorId) {
  const runtime = await loadSocialRuntime(store, { env });
  campaignId = identifier(campaignId); integer(version, 'Versión', 1, Number.MAX_SAFE_INTEGER); now = instant(now);
  requestId = text(requestId, 'Identificador de operación', 100, true);
  if (!/^[\w:-]{8,100}$/.test(requestId)) fail('Identificador de operación no válido.');
  const scope = `social:forecast:${campaignId}`, payload = { campaignId, version, manualScenario: scenario };
  if (actorId === 'scheduler') fail('La estimación requiere un administrador vigente.', 403);
  const guarded = actorStore(store, actorId, null, now);
  const prior = await guarded.transaction(async tx => {
    const row = await tx.db.get(`SELECT * FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, requestId]);
    if (row && (row.actor_id !== actorId || row.payload_hash !== hash(payload))) fail('La solicitud ya tiene otros datos.', 409);
    return row ? JSON.parse(row.result_json) : null;
  });
  if (prior) return prior;
  const snapshot = await store.readSnapshot(async tx => {
    const value = await proposal(tx, campaignId, version, now);
    return { ...value, history: buildSocialHistoricalForecast(value.spec, await samplesTx(tx, now), { asOf: now }), browserAudience: value.spec.integrationMethod === 'browser' ? await audienceFor(tx, value, now) : null };
  });
  const manual = manualScenario(snapshot.spec, scenario);
  let audienceEstimate = audienceValue(null, { source: snapshot.spec.integrationMethod === 'api' ? 'meta_reachestimate' : 'meta_ui', fetchedAt: now, specHash: snapshot.specHash });
  if (snapshot.spec.mode === 'paid') {
    if (snapshot.spec.integrationMethod === 'browser') audienceEstimate = snapshot.browserAudience;
    else {
      const credentials = decryptCredentials(snapshot.connection, snapshot.credential, runtime);
      const connector = await createSocialConnector({ connection: snapshot.connection, credentials, runtime, transport: { fetchImpl: transport.fetchImpl, now: Date.parse(now) } });
      await verifySocialApiTargeting(snapshot.spec, { connector });
      audienceEstimate = audienceValue(await connector.estimateAudience({ spec: snapshot.spec }), { source: 'meta_reachestimate', fetchedAt: now, specHash: snapshot.specHash });
    }
  } else audienceEstimate.reason = 'Orgánico no compra audiencia ni dispone de este pronóstico de pauta.';
  const forecast = { algorithmVersion: SOCIAL_HISTORY_VERSION, source: Object.keys(snapshot.history.metricRanges).length ? 'history' : manual ? 'manual' : 'insufficient',
    ...snapshot.history, specHash: snapshot.specHash, budgetMinor: snapshot.spec.budgetMinor, currency: snapshot.spec.currency,
    horizon: snapshot.spec.mode === 'paid' ? { startAt: snapshot.spec.startAt, endAt: snapshot.spec.endAt } : snapshot.spec.observationDays,
    assumptions: ['Cuartiles observados, no intervalos de confianza ni garantías de entrega.', snapshot.spec.mode === 'paid' ? 'Extrapolación proporcional dentro de inversión diaria y duración comparables.' : 'Resultados por red al horizonte fijado; no se suman personas entre redes.', 'No se analiza visualmente la pieza. El proveedor puede retrasar datos hasta 48 horas.'],
    generatedAt: now, audienceEstimate, manualScenario: manual };
  return runCommand(guarded, { scope, requestId, payload, actorId, affectsIndicators: false }, async tx => {
    if ((await loadSocialRuntime(tx, { env })).configurationVersion !== runtime.configurationVersion) fail('La configuración social cambió durante la estimación. Vuelve a verificar.', 409);
    const current = await proposal(tx, campaignId, version, now);
    if (proposalFence(current) !== proposalFence(snapshot)) fail('La configuración, cuenta, pieza o autenticación cambió durante la estimación.', 409);
    const id = newId();
    await insertRow(tx, 'social_forecasts', { id, campaign_id: campaignId, spec_hash: snapshot.specHash, generated_at: now, data: JSON.stringify(forecast) });
    // Technical evidence must not advance the configuration version: browser
    // preflight is pinned to that version and every ordinary edit clears this ID.
    await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET data=? WHERE id=? AND version=?`, [JSON.stringify({ ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId])), forecastId: id }), campaignId, version]);
    await audit(tx, { entityType: 'social_forecast', entityId: id, actorId, next: { campaignId, specHash: snapshot.specHash, source: forecast.source, sampleIds: forecast.sampleIds }, recordedAt: now });
    return { id, campaignId, version, ...forecast };
  });
}

export function compareSocialForecast(spec, forecast, deliveries, measurements, { asOf = stamp() } = {}) {
  const comparisons = [];
  for (const [key, range] of Object.entries(forecast.metricRanges || {})) {
    const metric = range.metric || key, delivery = deliveries.find(value => value.channel === range.channel);
    const reasons = [], final = delivery && finalDelivery(delivery, spec);
    const measurement = delivery ? selectMeasurement(delivery, spec, measurements, asOf, { final: spec.mode !== 'paid' || final }) : null;
    const reported = measurement?.values?.[metric] || null;
    if (!delivery) reasons.push('missing_delivery');
    if (spec.mode === 'paid' && delivery && ['failed', 'cancelled', 'uncertain', 'blocked'].includes(delivery.state)) reasons.push('unconfirmed_or_incomplete_delivery_window');
    if (!measurement) reasons.push(spec.mode === 'organic' ? 'no_complete_capture_at_approved_horizon' : 'no_complete_cumulative_measurement');
    if (measurement && (!exact(reported) || hash(definition(measurement, metric, delivery.channel)) !== hash(Object.fromEntries(Object.keys(definition(measurement, metric, delivery.channel)).map(name => [name, range[name] ?? null]))))) reasons.push('metric_definition_scope_currency_or_attribution_mismatch');
    if (spec.mode === 'organic' ? range.horizon !== spec.observationDays : hash(range.horizon) !== hash({ startAt: spec.startAt, endAt: spec.endAt })) reasons.push('approved_horizon_mismatch');
    if (forecast.specHash !== hash(spec)) reasons.push('approved_specification_mismatch');
    const changed = measurements.some(value => value.deliveryId === delivery?.id && value.fetchedAt <= asOf && value.evidence?.configurationDifferences?.length);
    if (changed) reasons.push('external_configuration_change');
    const status = reasons.length ? 'not_comparable' : spec.mode === 'paid' && !final ? 'in_progress' : reported.value < range.lower ? 'below' : reported.value > range.upper ? 'above' : 'within';
    const comparable = !reasons.length && status !== 'in_progress', differenceAbsolute = comparable ? reported.value - range.median : null;
    comparisons.push({ metric, channel: range.channel, forecastRange: range, reported, differenceAbsolute,
      differencePercent: comparable && range.median !== 0 ? differenceAbsolute / range.median * 100 : null, status, reasons,
      measurementIds: measurement ? [measurement.id] : [], fetchedAt: measurement?.fetchedAt || null,
      periodStart: measurement?.periodStart || null, periodEnd: measurement?.periodEnd || null,
      captureAgeMilliseconds: measurement && spec.mode === 'organic' ? Date.parse(measurement.periodEnd) - Date.parse(delivery.publishedAt) : null,
      spendMinor: measurement?.values?.spendMinor || null });
  }
  return comparisons;
}
export async function analyzeSocialCampaign(store, campaignId, { asOf, requestId, lease = null, expectedEvidenceHash = null }, actorId) {
  campaignId = identifier(campaignId); asOf = instant(asOf, 'Corte de análisis');
  if (expectedEvidenceHash !== null && !/^[a-f0-9]{64}$/.test(expectedEvidenceHash)) fail('La evidencia esperada no es válida.');
  if (lease) lease = { ...lease, campaignId, now: lease.now || stamp() };
  const guarded = actorStore(store, actorId, lease, lease?.now || stamp());
  const clock = lease ? jobClock(lease.now) : stamp;
  let performed = false;
  const result = await runCommand(guarded, { scope: `social:analysis:${campaignId}${actorId === 'scheduler' ? ':scheduler' : ''}`, requestId, payload: { campaignId, asOf }, actorId, lease, affectsIndicators: false }, async tx => {
    performed = true;
    const input = await analysisInputTx(tx, campaignId, asOf);
    if (expectedEvidenceHash && expectedEvidenceHash !== input.evidenceHash) throw Object.assign(new Error('La evidencia cambió antes de guardar el análisis.'), { status: 409, analysisCode: 'EVIDENCE_CHANGED' });
    const currentData = raw(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId])), previous = currentData.analysis;
    const recommendationRows = async ids => {
      const result = [];
      for (const id of ids || []) { const value = await get(tx, 'social_recommendations', id); if (value) result.push(value); }
      return result;
    };
    if (previous?.analysisVersion === SOCIAL_ANALYSIS_VERSION && previous.evidenceHash === input.evidenceHash) {
      const checked = { ...previous, checkedAt: asOf, businessRevision: input.business.businessRevision };
      await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET data=? WHERE id=?`, [JSON.stringify({ ...currentData, analysis: checked }), campaignId]);
      return { ...checked, recommendations: await recommendationRows(checked.recommendationIds) };
    }
    const recommendationIds = [];
    for (const proposal of input.rules.recommendations) {
      const existing = await tx.db.get(`SELECT id FROM ${tx.t('social_recommendations')} WHERE campaign_id=? AND evidence_hash=? AND rule_key=?`, [campaignId, input.evidenceHash, proposal.ruleKey]);
      const id = existing?.id || newId();
      if (!existing) {
        const data = { ...proposal, evidenceHash: input.evidenceHash, businessRevision: input.business.businessRevision };
        await insertRow(tx, 'social_recommendations', { id, campaign_id: campaignId, evidence_hash: input.evidenceHash, rule_key: proposal.ruleKey, state: 'suggested', data: JSON.stringify(data), version: 1, created_at: asOf, updated_at: asOf });
      }
      recommendationIds.push(id);
    }
    const analysis = { campaignId, specHash: input.revision.specHash, forecastId: input.revision.forecastId, asOf, checkedAt: asOf, evaluatedAt: asOf,
      algorithmVersion: SOCIAL_HISTORY_VERSION, analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash: input.evidenceHash, comparisons: input.comparisons,
      unavailableReasons: input.revision.forecast.unavailableReasons || [], source: input.revision.forecast.source, manualScenario: input.revision.forecast.manualScenario || null,
      businessRevision: input.business.businessRevision, factHash: input.business.factHash, linkVersions: input.business.linkVersions,
      recommendationIds, observationComplete: input.rules.observationComplete, gaps: input.rules.gaps, primary: input.rules.primary,
      message: !recommendationIds.length && input.rules.observationComplete ? 'No hay evidencia de una mejora específica; prueba cambiar una sola variable, sin ampliar el monto.' : null,
      ...(input.parentEvaluation ? { evaluation: { recommendationId: input.parentEvaluation.recommendation.id, ...input.parentEvaluation.result } } : {}) };
    if (input.parentEvaluation?.result.complete) {
      const { recommendation, result } = input.parentEvaluation, row = await tx.db.get(`SELECT data FROM ${tx.t('social_recommendations')} WHERE id=?`, [recommendation.id]);
      const data = { ...raw(row), conclusion: result.conclusion, evaluation: { ...result, childCampaignId: campaignId, evidenceHash: input.evidenceHash } };
      const changed = await tx.db.run(`UPDATE ${tx.t('social_recommendations')} SET state='evaluated',data=?,version=version+1,updated_at=? WHERE id=? AND version=?`, [JSON.stringify(data), asOf, recommendation.id, recommendation.version]);
      if (!changed.changes) fail('La recomendación cambió durante su evaluación.', 409);
      await audit(tx, { entityType: 'social_recommendation', entityId: recommendation.id, actorId, previous: recommendation, next: { state: 'evaluated', ...data }, recordedAt: asOf, source: actorId === 'scheduler' ? 'scheduler' : 'manual' });
    }
    await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET data=? WHERE id=?`, [JSON.stringify({ ...currentData, analysis }), campaignId]);
    await audit(tx, { entityType: 'social_analysis', entityId: campaignId, actorId, next: { analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash: input.evidenceHash, forecastId: input.revision.forecastId, asOf, recommendationIds }, recordedAt: asOf, source: actorId === 'scheduler' ? 'scheduler' : 'manual' });
    return { ...analysis, recommendations: await recommendationRows(recommendationIds) };
  });
  if (!performed && expectedEvidenceHash) {
    await guarded.transaction(async tx => {
      await tx.lockWrites();
      if (lease) await assertLease(tx, { ...lease, now: clock() });
      const input = await analysisInputTx(tx, campaignId, asOf);
      if (input.evidenceHash !== expectedEvidenceHash) throw Object.assign(new Error('La evidencia cambió antes de comprobar el análisis guardado.'), { status: 409, analysisCode: 'EVIDENCE_CHANGED' });
      const currentData = raw(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId]));
      const { recommendations: _recommendations, ...analysis } = result;
      await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET data=? WHERE id=?`, [JSON.stringify({ ...currentData, analysis: { ...analysis, checkedAt: asOf, businessRevision: input.business.businessRevision } }), campaignId]);
      if (lease) await assertLease(tx, { ...lease, now: clock() });
    });
  }
  return result;
}

export const SOCIAL_ANALYSIS_VERSION = 'social-improvements-v1';
const PRIMARY = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' };
const RULE_ORDER = ['measurement_gap', 'weak_link_ctr', 'possible_fatigue', 'placement_cost_gap', 'organic_response', 'posting_window', 'declared_return_gap'];
const count = (measurement, metric) => exact(measurement?.values?.[metric]) && measurement.values[metric].unit === 'count' ? measurement.values[metric].value : null;
const rationalCompare = ([a, b], [c, d]) => a * d < c * b ? -1 : a * d > c * b ? 1 : 0;
const quotient = (numerator, denominator) => denominator > 0 ? divide(fraction(numerator), fraction(denominator)) : null;
function localParts(value, timeZone) {
  if (!time(value) || !timeZone) return null;
  try { return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value])); }
  catch { return null; }
}
function completeDays(anchor, asOf, timeZone) {
  const start = localParts(anchor, timeZone), end = localParts(asOf, timeZone);
  if (!start || !end) return null;
  const date = parts => `${parts.year}-${parts.month}-${parts.day}`;
  const partialStart = start.hour !== '00' || start.minute !== '00' || start.second !== '00' || new Date(anchor).getUTCMilliseconds() !== 0;
  return Math.max(0, Math.round((Date.parse(date(end)) - Date.parse(date(start))) / DAY) - Number(partialStart));
}
function rate(measurement, numerator, denominator) {
  const n = count(measurement, numerator), d = count(measurement, denominator);
  return n !== null && d !== null ? quotient(n, d) : null;
}
function cost(measurement, metric) {
  const spend = measurement?.values?.spendMinor, result = count(measurement, metric);
  return exact(spend) && spend.unit === 'minor_currency' && result !== null && result > 0 ? quotient(spend.value, result) : null;
}
function metricSignature(measurement, fields) {
  return hash({ integrationMethod: measurement.integrationMethod, adapterVersion: measurement.adapterVersion, apiVersion: measurement.apiVersion ?? null,
    definitionVersion: measurement.definitionVersion, scope: measurement.scope, currency: measurement.currency ?? null, timeZone: measurement.timeZone,
    timeZoneSource: measurement.query?.timeZoneSource ?? null, attributionSetting: measurement.attributionSetting ?? null, actionReportTime: measurement.actionReportTime ?? null,
    periodType: measurement.query?.periodType, horizon: measurement.query?.horizon ?? null,
    fields: fields.map(key => [key, measurement.values?.[key]?.unit ?? null, measurement.values?.[key]?.sourceMetric ?? null]) });
}
function usableSnapshot(measurement, spec, dimension = 'aggregate') {
  return measurement?.coverage?.complete === true && measurement.scope === spec.mode && measurement.integrationMethod === spec.integrationMethod &&
    measurement.dimension === dimension && Boolean(measurement.definitionVersion) && !measurement.evidence?.configurationDifferences?.length &&
    (spec.mode !== 'paid' || measurement.currency === spec.currency);
}
function latestWindow(delivery, spec, measurements, asOf, window, dimension = 'aggregate') {
  const rows = measurements.filter(value => value.deliveryId === delivery.id && value.fetchedAt <= asOf && value.dimension === dimension && value.query?.window === window)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id.localeCompare(a.id));
  const selected = rows.find(value => usableSnapshot(value, spec, dimension)) || null;
  return { measurement: selected, latest: rows[0] || null, newerPartial: Boolean(selected && rows[0] !== selected) };
}
function staleMeasurement(measurement, delivery, spec, asOf) {
  if (!measurement) return true;
  if (spec.mode === 'paid') return delivery.state === 'active' && Date.parse(asOf) - Date.parse(measurement.fetchedAt) > 2 * 3600000;
  const anchor = delivery.publishedAt;
  return time(anchor) && Date.parse(asOf) <= Date.parse(anchor) + (spec.observationDays + 2) * DAY && Date.parse(asOf) - Date.parse(measurement.fetchedAt) > 12 * 3600000;
}
function comparableRates(samples, current, fields, valueOf, channel) {
  if (!current) return [];
  const signature = metricSignature(current, fields), seen = new Set(), result = [];
  for (const sample of samples) {
    const measurement = sample.measurement;
    if (sample.channel !== channel || !measurement?.coverage?.complete || measurement.scope !== current.scope || measurement.evidence?.configurationDifferences?.length ||
      measurement.query?.window !== current.query?.window || current.scope === 'organic' && sample.horizon !== current.query?.horizon ||
      current.scope === 'paid' && (count(measurement, 'impressions') < 1000 || !exact(measurement.values?.spendMinor) || measurement.values.spendMinor.unit !== 'minor_currency' || measurement.values.spendMinor.value <= 0) ||
      metricSignature(measurement, fields) !== signature || seen.has(sample.campaignId)) continue;
    const value = valueOf(measurement); if (value === null) continue;
    seen.add(sample.campaignId); result.push({ sample, value });
  }
  return result;
}
function placementKey(dimensions) {
  const network = dimensions?.publisherPlatform?.toLowerCase(), label = dimensions?.placement?.toLowerCase().replace(/^(facebook|instagram)[ _-]+/, '').replace(/[ -]+/g, '_');
  return network === 'facebook' ? ({ feed: 'facebook_feed', facebook_reels: 'facebook_reels', reels: 'facebook_reels' })[label] || null
    : network === 'instagram' ? ({ feed: 'instagram_feed', stream: 'instagram_feed', reels: 'instagram_reels' })[label] || null : null;
}

export function buildSocialRecommendations({ campaign, spec, deliveries = [], measurements = [], samples = [], business = null, asOf, evidenceHash = null }) {
  asOf = instant(asOf);
  const recommendations = [], gaps = [], primary = PRIMARY[spec.objective] || null;
  const identity = evidenceHash || hash({ analysisVersion: SOCIAL_ANALYSIS_VERSION, specHash: hash(spec), measurements: measurements.map(value => [value.id, value.payloadHash || null]),
    samples: samples.map(value => [value.campaignId, value.measurementId]), facts: business?.factHash || null });
  const add = (ruleKey, observation, hypothesis, proposedChange, successCriterion, metricIds = [], sampleIds = [], primaryEvidence = null, limitations = []) => {
    recommendations.push({ ruleKey, analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash: identity, metricIds: [...new Set(metricIds)].sort(), sampleIds: [...new Set(sampleIds)].sort(),
      observation, hypothesis, proposedChange, successCriterion, primaryEvidence, limitations: ['Una observación no demuestra causalidad ni garantiza resultados.', ...limitations], priority: RULE_ORDER.indexOf(ruleKey) + 1 });
  };
  if (!deliveries.length) gaps.push('missing_delivery');
  let observationComplete = deliveries.length > 0;
  for (const delivery of deliveries) {
    const selected = spec.mode === 'paid' ? latestWindow(delivery, spec, measurements, asOf, 'cumulative') : { measurement: selectMeasurement(delivery, spec, measurements, asOf), newerPartial: false };
    const measurement = selected.measurement, fresh = measurement && !staleMeasurement(measurement, delivery, spec, asOf) && !selected.newerPartial;
    const days = spec.mode === 'paid' ? completeDays(socialMetricAnchor(delivery, spec), asOf, spec.timeZone) : null;
    const reached = spec.mode === 'paid' ? days !== null && days >= 3 : time(delivery.publishedAt) && Date.parse(asOf) >= Date.parse(delivery.publishedAt) + spec.observationDays * DAY;
    const impressions = count(measurement, 'impressions'), reach = count(measurement, 'reach'), primaryValue = primary ? count(measurement, primary) : null;
    const eligible = Boolean(fresh && reached && primaryValue !== null && (spec.mode !== 'paid' || impressions !== null && impressions >= 1000));
    observationComplete &&= spec.mode === 'paid' ? finalDelivery(delivery, spec) && delivery.finalizedAt <= asOf : Boolean(reached && measurement);
    if (!measurement) gaps.push(`${delivery.channel}:complete_primary_capture_unavailable`);
    else if (!fresh) gaps.push(`${delivery.channel}:${selected.newerPartial ? 'newer_capture_incomplete' : 'stale_metrics'}`);
    if (!reached) gaps.push(`${delivery.channel}:${spec.mode === 'paid' ? 'fewer_than_three_complete_days' : 'organic_horizon_not_reached'}`);
    if (primaryValue === null) gaps.push(`${delivery.channel}:primary_kpi_unavailable`);
    if (spec.mode === 'paid' && (impressions === null || impressions < 1000)) gaps.push(`${delivery.channel}:fewer_than_one_thousand_impressions`);
    const primaryHistory = comparableRates(samples, measurement, primary ? [primary] : [], value => {
      const result = count(value, primary); return result === null ? null : fraction(result);
    }, delivery.channel);
    if (primaryHistory.length < 5) gaps.push(`${delivery.channel}:fewer_than_five_primary_comparables`);
    if (spec.mode === 'paid') {
      if (['traffic', 'whatsapp'].includes(spec.objective)) {
        const current = measurement && rate(measurement, 'linkClicks', 'impressions'), history = comparableRates(samples, measurement, ['linkClicks', 'impressions'], value => rate(value, 'linkClicks', 'impressions'), delivery.channel);
        if (!current) gaps.push(`${delivery.channel}:link_ctr_unavailable`);
        if (history.length < 5) gaps.push(`${delivery.channel}:fewer_than_five_link_ctr_comparables`);
        if (eligible && current && history.length >= 5 && rationalCompare(current, quantile(history.map(value => value.value), 1)) < 0) {
          const median = rationalNumber(quantile(history.map(value => value.value), 2)) * 100, actual = rationalNumber(current) * 100, primaryCost = cost(measurement, primary);
          add('weak_link_ctr', `CTR de enlace ${actual}% por debajo del cuartil inferior comparable.`, 'Otro texto o llamada a la acción podría mejorar la respuesta; no se conoce la causa.',
            { type: 'copy', text: 'Aporta otro texto/CTA o una pieza nueva; conserva audiencia, objetivo y monto.' },
            { text: 'Superar la mediana histórica de CTR al mismo horizonte sin empeorar el costo por resultado.', metric: 'ctrLinkPercent', operator: 'gt', target: median, maxCostPerResultMinor: primaryCost ? rationalNumber(primaryCost) : null },
            [measurement.id], history.map(value => value.sample.campaignId), { metric: 'ctrLinkPercent', value: actual, historicalMedian: median, costPerResultMinor: primaryCost ? rationalNumber(primaryCost) : null });
        }
      }
      const recent = latestWindow(delivery, spec, measurements, asOf, 'recent_3d'), prior = latestWindow(delivery, spec, measurements, asOf, 'previous_3d');
      if (eligible && days >= 6 && recent.measurement && prior.measurement && !recent.newerPartial && !prior.newerPartial) {
        const a = recent.measurement, b = prior.measurement, ctrA = rate(a, 'linkClicks', 'impressions'), ctrB = rate(b, 'linkClicks', 'impressions'), frequency = rate(a, 'impressions', 'reach');
        const expected = buildSocialMetricQueries(delivery, spec, { now: asOf });
        const matches = (value, window) => {
          const query = expected.find(entry => entry.window === window);
          return query && ['periodStart', 'periodEnd', 'windowStart', 'windowEnd'].every(key => value.query?.[key] === query[key]);
        };
        const matching = matches(a, 'recent_3d') && matches(b, 'previous_3d') && b.query.windowEnd === a.query.windowStart &&
          metricSignature(a, ['linkClicks', 'impressions', 'reach']) === metricSignature(b, ['linkClicks', 'impressions', 'reach']);
        if (matching && count(a, 'impressions') >= 1000 && count(b, 'impressions') >= 1000 && ctrA && ctrB && frequency &&
          rationalCompare(frequency, fraction(3)) > 0 && rationalCompare(ctrA, multiply(ctrB, [4n, 5n])) <= 0) {
          add('possible_fatigue', 'La frecuencia agregada de los últimos tres días supera 3 y su CTR no supera el 80% de los tres anteriores.',
            'La pieza podría estar perdiendo respuesta; la frecuencia es una señal, no un diagnóstico.',
            { type: 'creative', text: 'Aporta otra pieza en una publicación nueva manteniendo monto, público y objetivo.' },
            { text: 'Recuperar CTR al mismo horizonte sin empeorar costo por resultado.', metric: 'ctrLinkPercent', operator: 'gt', target: rationalNumber(ctrA) * 100 },
            [a.id, b.id], [], { metric: 'ctrLinkPercent', value: rationalNumber(ctrA) * 100, frequency: rationalNumber(frequency), window: 'recent_3d' });
        }
      }
      const placement = latestWindow(delivery, spec, measurements, asOf, 'cumulative', 'placement');
      if (eligible && primary !== 'reach' && placement.measurement && !placement.newerPartial) {
        const snapshot = placement.measurement, choices = [];
        for (const row of snapshot.rows || []) {
          const key = placementKey(row.dimensions), value = { ...snapshot, values: row.values }, results = count(value, primary), price = cost(value, primary);
          if (key && spec.placements.includes(key) && results !== null && results >= 20 && price) choices.push({ key, row, price, results });
        }
        choices.sort((a, b) => rationalCompare(a.price, b.price) || a.key.localeCompare(b.key));
        let pair = null;
        for (const best of choices) {
          const other = choices.find(value => value.key !== best.key && value.row.periodStart === best.row.periodStart && value.row.periodEnd === best.row.periodEnd &&
            metricSignature({ ...snapshot, values: best.row.values }, [primary, 'spendMinor']) === metricSignature({ ...snapshot, values: value.row.values }, [primary, 'spendMinor']) &&
            rationalCompare(best.price, multiply(value.price, [4n, 5n])) <= 0 && rationalCompare(best.price, value.price) < 0);
          if (other) { pair = [best, other]; break; }
        }
        if (pair) {
          const [best, other] = pair;
          add('placement_cost_gap', `${best.key} tiene costo por resultado no mayor al 80% de ${other.key}, con al menos 20 resultados en cada ubicación.`,
            'Una prueba concentrada en la ubicación observada podría conservar eficiencia; no es un A/B aleatorio.',
            { type: 'placement', placement: best.key, text: `Probar sólo ${best.key}, con el mismo presupuesto total y objetivo.` },
            { text: 'Mejorar costo y conservar volumen por inversión al mismo horizonte.', metric: 'costPerPrimaryResultMinor', operator: 'lt', target: rationalNumber(cost(measurement, primary) || other.price), minimumResults: 20 },
            [snapshot.id, measurement.id], [], { metric: 'costPerPrimaryResultMinor', value: rationalNumber(cost(measurement, primary) || other.price), primaryMetric: primary, placement: best.key });
        }
      }
    } else {
      const response = measurement && rate(measurement, 'interactions', 'reach'), history = comparableRates(samples, measurement, ['interactions', 'reach'], value => rate(value, 'interactions', 'reach'), delivery.channel);
      if (reach === null || reach < 100) gaps.push(`${delivery.channel}:fewer_than_one_hundred_organic_reach`);
      if (!response) gaps.push(`${delivery.channel}:organic_response_unavailable`);
      if (history.length < 5) gaps.push(`${delivery.channel}:fewer_than_five_organic_response_comparables`);
      if (eligible && reach >= 100 && response && history.length >= 5 && rationalCompare(response, quantile(history.map(value => value.value), 1)) < 0) {
        const median = rationalNumber(quantile(history.map(value => value.value), 2));
        add('organic_response', 'La tasa de interacciones por alcance orgánico está por debajo del cuartil inferior comparable.',
          'Una llamada a la acción más clara podría mejorar la respuesta observada.',
          { type: 'copy', text: 'Aporta un texto con llamada a la acción más clara, sin añadir inversión.' },
          { text: 'Superar la mediana de respuesta orgánica al mismo horizonte.', metric: 'organicResponse', operator: 'gt', target: median },
          [measurement.id], history.map(value => value.sample.campaignId), { metric: 'organicResponse', value: rationalNumber(response), channel: delivery.channel, historicalMedian: median });
      }
      if (eligible && reach >= 100 && spec.timeZone) {
        const compatible = comparableRates(samples, measurement, ['reach'], value => { const result = count(value, 'reach'); return result === null ? null : fraction(result); }, delivery.channel);
        const bands = new Map();
        for (const entry of compatible) {
          const parts = localParts(entry.sample.publishedAt || entry.sample.delivery?.publishedAt, spec.timeZone); if (!parts) continue;
          const band = Math.floor(Number(parts.hour) / 6) * 6;
          if (!bands.has(band)) bands.set(band, []); bands.get(band).push(entry);
        }
        const candidates = [...bands].filter(([, entries]) => entries.length >= 5).map(([band, entries]) => ({ band, entries, median: quantile(entries.map(value => value.value), 2) }))
          .sort((a, b) => -rationalCompare(a.median, b.median) || a.band - b.band);
        const best = candidates[0], other = best && candidates.find(value => value.band !== best.band && rationalCompare(best.median, value.median) > 0 && rationalCompare(best.median, multiply(value.median, [6n, 5n])) >= 0);
        if (best && other) add('posting_window', 'Dos franjas con al menos cinco publicaciones comparables muestran una mediana de alcance al menos 20% mayor en una de ellas.',
          'El horario se correlaciona con el alcance observado; no garantiza entrega.',
          { type: 'posting_window', postingWindow: { startHour: best.band, endHour: best.band + 6, timeZone: spec.timeZone }, text: `Probar la franja ${String(best.band).padStart(2, '0')}–${String(best.band + 6).padStart(2, '0')} en ${spec.timeZone}; elige tú la fecha.` },
          { text: 'Mejorar alcance por red al mismo horizonte, en la franja propuesta.', metric: 'reach', operator: 'gt', target: reach },
          [measurement.id], [...best.entries, ...other.entries].map(value => value.sample.campaignId), { metric: 'reach', value: reach, channel: delivery.channel, observedBandMedian: rationalNumber(best.median) },
          ['La relación es observacional, no una asignación aleatoria de horarios.']);
      }
    }
  }
  if (business?.coverage?.complete === true && business.orders?.length >= 5 && business.contributionAfterAdvertising?.complete === true && business.contributionAfterAdvertising.valueMinor < 0) {
    add('declared_return_gap', 'La contribución conocida después de pauta es negativa con al menos cinco pedidos vinculados y cobertura financiera completa.',
      'Conviene revisar oferta, costos y calidad de consultas antes de escalar; no se atribuye la pérdida a la pieza.',
      { type: 'offer_costs', text: 'Revisa oferta/costos y calidad de consultas antes de preparar otra campaña; conserva el monto.' },
      { text: 'Mejorar contribución conocida sin ampliar presupuesto ni gasto.', metric: 'contributionAfterAdvertisingMinor', operator: 'gt', target: business.contributionAfterAdvertising.valueMinor },
      business.metaSpend?.measurementIds || [], [], { metric: 'contributionAfterAdvertisingMinor', value: business.contributionAfterAdvertising.valueMinor, businessRevision: business.businessRevision });
  }
  if (gaps.length) add('measurement_gap', 'Faltan datos comparables o una observación suficiente para algunas decisiones.', 'Completar la medición puede permitir una prueba informada, no garantiza un mejor resultado.',
    { type: 'measurement', text: 'Revisa las causas, reconecta o sincroniza cuando corresponda y mantén sólo una prueba con monto aprobado.' },
    { text: 'Obtener el KPI requerido con ámbito, precisión, cobertura y horizonte compatibles.', metric: primary || 'measurementCoverage', operator: 'complete' },
    measurements.filter(value => value.dimension === 'aggregate').map(value => value.id), [], { metric: primary, missing: [...new Set(gaps)].sort() }, [...new Set(gaps)].sort());
  const unique = new Map();
  for (const recommendation of recommendations.sort((a, b) => a.priority - b.priority)) if (!unique.has(recommendation.ruleKey)) unique.set(recommendation.ruleKey, recommendation);
  return { recommendations: [...unique.values()].slice(0, 5), gaps: [...new Set(gaps)].sort(), observationComplete, primary };
}

function evidenceMeasurements(spec, deliveries, measurements, asOf) {
  const selected = new Map();
  for (const delivery of deliveries) {
    if (spec.mode === 'organic') {
      const first = selectMeasurement(delivery, spec, measurements, asOf);
      const candidate = first || measurements.filter(value => value.deliveryId === delivery.id && value.dimension === 'aggregate' && value.fetchedAt <= asOf).at(-1);
      if (candidate) selected.set(candidate.id, candidate);
    } else for (const [window, dimension] of [['cumulative', 'aggregate'], ['recent_3d', 'aggregate'], ['previous_3d', 'aggregate'], ['cumulative', 'placement']]) {
      const result = latestWindow(delivery, spec, measurements, asOf, window, dimension);
      if (result.measurement) selected.set(result.measurement.id, result.measurement);
      if (result.latest) selected.set(result.latest.id, result.latest);
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function completedObservation(input, asOf) {
  return input.deliveries.length > 0 && input.deliveries.every(delivery => input.spec.mode === 'paid'
    ? ['completed', 'failed', 'cancelled'].includes(delivery.state) && time(delivery.finalizedAt) && delivery.finalizedAt <= asOf
    : time(delivery.publishedAt) && Date.parse(asOf) >= Date.parse(delivery.publishedAt) + input.spec.observationDays * DAY);
}
function evaluationCapture(input, channel, baseline, asOf) {
  const delivery = input.deliveries.find(value => value.channel === channel); if (!delivery) return null;
  if (input.spec.mode === 'organic') return selectMeasurement(delivery, input.spec, input.measurements, asOf);
  const parentAnchor = baseline?.anchor, childAnchor = socialMetricAnchor(delivery, input.spec);
  if (!time(parentAnchor) || !time(childAnchor) || !baseline.measurement) return null;
  const target = Date.parse(childAnchor) + Date.parse(baseline.measurement.periodEnd) - Date.parse(parentAnchor);
  return input.measurements.filter(value => value.deliveryId === delivery.id && usableSnapshot(value, input.spec) && value.query?.window === baseline.measurement.query.window &&
    value.fetchedAt <= asOf && Date.parse(value.periodEnd) >= target && Date.parse(value.periodEnd) <= target + DAY)
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id))[0] || null;
}
export function evaluateSocialRecommendation(recommendation, { parent, child, asOf }) {
  asOf = instant(asOf);
  const result = { complete: completedObservation(child, asOf), conclusion: 'inconclusive', metric: recommendation.successCriterion?.metric || null, parentValue: null, childValue: null, reasons: [], asOf, metricIds: [] };
  if (!result.complete) { result.reasons.push('observation_not_finished'); return result; }
  if (parent.spec.mode !== child.spec.mode || parent.spec.objective !== child.spec.objective || parent.spec.integrationMethod !== child.spec.integrationMethod || parent.spec.currency !== child.spec.currency ||
    parent.spec.timeZone !== child.spec.timeZone || hash(parent.spec.audience || null) !== hash(child.spec.audience || null) ||
    recommendation.proposedChange?.type !== 'placement' && (hash(parent.spec.platforms || []) !== hash(child.spec.platforms || []) || hash(parent.spec.placements || []) !== hash(child.spec.placements || [])) ||
    (parent.spec.mode === 'paid' ? duration(parent.spec) !== duration(child.spec) || child.spec.budgetMinor > parent.spec.budgetMinor : parent.spec.observationDays !== child.spec.observationDays)) {
    result.reasons.push('incompatible_horizon_configuration_or_budget'); return result;
  }
  if (recommendation.ruleKey === 'declared_return_gap') {
    const a = parent.business, b = child.business;
    if (!a?.coverage?.complete || !b?.coverage?.complete || b.orders?.length < 5 || a.metaSpend?.currency !== 'COP' || b.metaSpend?.currency !== 'COP' ||
      !a.contributionAfterAdvertising?.complete || !b.contributionAfterAdvertising?.complete || b.metaSpend.valueMinor > a.metaSpend.valueMinor) {
      result.reasons.push('incomplete_finance_or_greater_spend'); return result;
    }
    result.parentValue = recommendation.primaryEvidence?.value ?? a.contributionAfterAdvertising.valueMinor;
    result.childValue = b.contributionAfterAdvertising.valueMinor;
    result.metricIds = b.metaSpend.measurementIds;
  } else {
    const channel = recommendation.primaryEvidence?.channel || (parent.spec.mode === 'paid' ? 'meta_ads' : parent.spec.platforms[0]);
    const parentDelivery = parent.deliveries.find(value => value.channel === channel), primary = PRIMARY[parent.spec.objective];
    const referenced = new Set(recommendation.metricIds || []);
    const a = parent.measurements.filter(value => referenced.has(value.id) && value.dimension === 'aggregate' && value.deliveryId === parentDelivery?.id &&
      (recommendation.primaryEvidence?.window ? value.query?.window === recommendation.primaryEvidence.window : true))
      .sort((x, y) => y.fetchedAt.localeCompare(x.fetchedAt))[0] || (parentDelivery ? selectMeasurement(parentDelivery, parent.spec, parent.measurements, asOf, { final: false }) : null);
    const b = evaluationCapture(child, channel, { measurement: a, anchor: parentDelivery ? socialMetricAnchor(parentDelivery, parent.spec) : null }, asOf);
    const fields = result.metric === 'ctrLinkPercent' ? ['linkClicks', 'impressions'] : result.metric === 'organicResponse' ? ['interactions', 'reach']
      : result.metric === 'costPerPrimaryResultMinor' ? [primary, 'spendMinor'] : [result.metric];
    if (!a || !b || !usableSnapshot(a, parent.spec) || metricSignature(a, fields) !== metricSignature(b, fields)) { result.reasons.push('compatible_definition_scope_and_capture_unavailable'); return result; }
    const value = measurement => result.metric === 'ctrLinkPercent' ? rate(measurement, 'linkClicks', 'impressions')
      : result.metric === 'organicResponse' ? rate(measurement, 'interactions', 'reach')
      : result.metric === 'costPerPrimaryResultMinor' ? cost(measurement, primary) : count(measurement, result.metric) === null ? null : fraction(count(measurement, result.metric));
    const before = value(a), after = value(b);
    if (!before || !after) { result.reasons.push('primary_kpi_unavailable'); return result; }
    const scale = result.metric === 'ctrLinkPercent' ? 100 : 1;
    result.parentValue = recommendation.primaryEvidence?.value ?? rationalNumber(before) * scale; result.childValue = rationalNumber(after) * scale; result.metricIds = [b.id];
    if (recommendation.ruleKey === 'measurement_gap') { result.reasons.push('baseline_kpi_unavailable'); return result; }
    if (recommendation.ruleKey === 'posting_window') {
      const window = recommendation.proposedChange?.postingWindow, published = child.deliveries.find(value => value.channel === channel)?.publishedAt, parts = localParts(published, window?.timeZone);
      if (!parts || Number(parts.hour) < window.startHour || Number(parts.hour) >= window.endHour) { result.reasons.push('suggested_posting_window_not_tested'); return result; }
    }
    if (recommendation.ruleKey === 'placement_cost_gap' && (child.spec.placements?.length !== 1 || child.spec.placements[0] !== recommendation.proposedChange.placement)) {
      result.reasons.push('suggested_placement_not_tested'); return result;
    }
    if (child.spec.mode === 'paid') {
      const afterCost = cost(b, primary), beforeCost = cost(a, primary);
      if (!afterCost || !beforeCost) { result.reasons.push('result_cost_unavailable'); return result; }
      if (recommendation.successCriterion?.maxCostPerResultMinor != null && rationalCompare(afterCost, fraction(recommendation.successCriterion.maxCostPerResultMinor)) > 0 ||
        recommendation.ruleKey === 'possible_fatigue' && rationalCompare(afterCost, beforeCost) > 0) {
        result.conclusion = 'not_improved'; result.reasons.push('result_cost_worse'); return result;
      }
      if (recommendation.successCriterion?.minimumResults && count(b, primary) < recommendation.successCriterion.minimumResults) { result.conclusion = 'not_improved'; result.reasons.push('insufficient_result_volume'); return result; }
    }
  }
  const criterion = recommendation.successCriterion || {}, target = criterion.target;
  if (result.parentValue === null || result.childValue === null || !Number.isFinite(target)) { result.reasons.push('success_criterion_unavailable'); return result; }
  const lowerBetter = result.metric === 'costPerPrimaryResultMinor', favorable = lowerBetter ? result.childValue < result.parentValue : result.childValue > result.parentValue;
  const success = criterion.operator === 'gt' ? result.childValue > target : criterion.operator === 'gte' ? result.childValue >= target
    : criterion.operator === 'lt' ? result.childValue < target : criterion.operator === 'lte' ? result.childValue <= target : false;
  result.conclusion = favorable && success ? 'improved' : 'not_improved';
  return result;
}
async function analysisInputTx(tx, campaignId, asOf, includeParent = true) {
  const campaign = await get(tx, 'social_campaigns', campaignId); if (!campaign) fail('Campaña no encontrada.', 404);
  const revision = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_revisions')} WHERE campaign_id=? ORDER BY revision DESC LIMIT 1`, [campaignId]));
  if (!revision?.spec || !revision.forecast || !revision.forecastId) throw Object.assign(new Error('El análisis requiere una previsión aprobada e inmutable.'), { status: 409, analysisCode: 'APPROVED_FORECAST_REQUIRED' });
  const spec = revision.spec, deliveries = (await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')} WHERE campaign_id=? AND revision=?`, [campaignId, revision.revision])).map(entity);
  const rawMeasurements = (await tx.db.all(`SELECT m.* FROM ${tx.t('social_measurements')} m JOIN ${tx.t('social_deliveries')} d ON d.id=m.delivery_id WHERE d.campaign_id=? AND d.revision=? AND m.fetched_at<=? ORDER BY m.fetched_at,m.id`, [campaignId, revision.revision, asOf])).map(entity);
  const measurements = evidenceMeasurements(spec, deliveries, rawMeasurements, asOf), history = await readSocialComparableSamplesTx(tx, spec, { asOf, excludeCampaignId: campaignId });
  const business = await getSocialBusinessResultTx(tx, campaignId, { asOf }), input = { campaign, revision, spec, deliveries, measurements, samples: history.samples, business, asOf };
  const rules = buildSocialRecommendations(input), comparisons = compareSocialForecast(spec, revision.forecast, deliveries, rawMeasurements, { asOf });
  let parentEvaluation = null, parentEvidenceHash = null;
  if (includeParent && campaign.sourceRecommendationId && campaign.parentCampaignId) {
    const recommendation = await get(tx, 'social_recommendations', campaign.sourceRecommendationId);
    if (recommendation?.campaignId === campaign.parentCampaignId && recommendation.childCampaignId === campaignId) {
      const parent = await analysisInputTx(tx, campaign.parentCampaignId, asOf, false);
      parentEvidenceHash = parent.evidenceHash;
      parentEvaluation = { recommendation, result: evaluateSocialRecommendation(recommendation, { parent, child: { ...input, measurements: rawMeasurements }, asOf }) };
    }
  }
  const evidenceHash = hash({ analysisVersion: SOCIAL_ANALYSIS_VERSION, approved: { specHash: revision.specHash, forecastId: revision.forecastId, forecast: revision.forecast },
    measurements: measurements.map(value => [value.id, value.payloadHash]), samples: history.samples.map(value => [value.campaignId, value.measurementId, value.measurement.payloadHash || null]).sort(),
    deliveries: deliveries.map(value => ({ id: value.id, state: value.state, lastConfirmedState: value.lastConfirmedState || null, publishedAt: value.publishedAt || null, activatedAt: value.activatedAt || null, finalizedAt: value.finalizedAt || null })),
    linkVersions: business.linkVersions, factHash: business.factHash, parentEvidenceHash, targetCostMinor: campaign.targetCostMinor ?? null,
    gaps: rules.gaps, observationComplete: rules.observationComplete, decisions: rules.recommendations.map(value => ({ ruleKey: value.ruleKey, primaryEvidence: value.primaryEvidence, proposedChange: value.proposedChange, successCriterion: value.successCriterion })) });
  return { ...input, rawMeasurements, history, rules, comparisons, evidenceHash, parentEvaluation };
}
export async function prepareSocialAnalysisRequest(store, campaignId, { asOf = stamp() } = {}) {
  campaignId = identifier(campaignId); asOf = instant(asOf);
  const input = await store.readSnapshot(tx => analysisInputTx(tx, campaignId, asOf));
  return { campaignId, asOf, evidenceHash: input.evidenceHash, requestId: hash({ campaignId, asOf, evidenceHash: input.evidenceHash }) };
}

async function analysisStatusTx(tx, campaignId, asOf, now) {
  const campaign = await get(tx, 'social_campaigns', campaignId); if (!campaign) fail('Campaña no encontrada.', 404);
  const analysis = campaign.analysis || null, businessRevision = Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
  const orders = await tx.db.all(`SELECT order_id AS record_id,version FROM ${tx.t('social_order_links')} WHERE campaign_id=? ORDER BY order_id`, [campaignId]);
  const expenses = await tx.db.all(`SELECT expense_id AS record_id,version FROM ${tx.t('social_expense_links')} WHERE campaign_id=? ORDER BY expense_id`, [campaignId]);
  const links = { orders: orders.map(row => [row.record_id, row.version]), expenses: expenses.map(row => [row.record_id, row.version]) };
  const previousLinks = { orders: (analysis?.linkVersions?.orders || []).map(row => [row.recordId, row.version]).sort(), expenses: (analysis?.linkVersions?.expenses || []).map(row => [row.recordId, row.version]).sort() };
  const commercialStale = Boolean(analysis && (analysis.businessRevision !== businessRevision || hash(links) !== hash(previousLinks)));
  const latest = await tx.db.get(`SELECT m.id,m.fetched_at FROM ${tx.t('social_measurements')} m JOIN ${tx.t('social_deliveries')} d ON d.id=m.delivery_id WHERE d.campaign_id=? AND m.fetched_at<=? ORDER BY m.fetched_at DESC,m.id DESC LIMIT 1`, [campaignId, asOf]);
  const metricStale = Boolean(analysis && latest && latest.fetched_at > (analysis.checkedAt || analysis.asOf)), cutTooNew = Boolean(analysis && analysis.asOf > asOf);
  const stale = Boolean(analysis && (commercialStale || metricStale || cutTooNew || analysis.analysisVersion !== SOCIAL_ANALYSIS_VERSION));
  const jobRow = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [`social:analysis:${campaignId}`]), jobData = raw(jobRow);
  const job = jobRow ? { key: jobRow.key, state: jobRow.state, nextRunAt: jobData.nextRunAt || null, generation: jobData.generation || 0, errorCode: jobRow.error_code, lastProcessedGeneration: jobData.lastProcessedGeneration || null, leaseExpired: jobRow.state === 'running' && jobRow.lease_until <= now } : null;
  const recommendations = [];
  for (const id of analysis?.recommendationIds || []) { const value = await get(tx, 'social_recommendations', id); if (value) recommendations.push(value); }
  const pending = job && ['queued', 'running'].includes(job.state);
  const status = stale ? 'stale' : pending ? 'pending' : analysis ? 'current' : 'unavailable';
  const staleKey = hash({ analysisVersion: SOCIAL_ANALYSIS_VERSION, businessRevision, links, measurementId: latest?.id || null, cutoff: cutTooNew ? asOf.slice(0, 10) : null });
  return { analysis, businessRevision, commercialStale, metricStale, stale, status, job, jobData, recommendations, staleKey };
}
export async function getSocialAnalysis(store, campaignId, { asOf = stamp() } = {}) {
  campaignId = identifier(campaignId); asOf = instant(asOf); const now = stamp();
  let status = await store.readSnapshot(tx => analysisStatusTx(tx, campaignId, asOf, now));
  if (status.stale && status.jobData.staleKey !== status.staleKey) {
    await store.transaction(async tx => {
      await tx.lockWrites();
      const current = await analysisStatusTx(tx, campaignId, asOf, now);
      if (current.stale && current.jobData.staleKey !== current.staleKey) await queueSocialAnalysisTx(tx, campaignId, { now, asOf, requestedBy: 'scheduler', businessRevision: current.businessRevision, staleKey: current.staleKey });
    });
    status = await store.readSnapshot(tx => analysisStatusTx(tx, campaignId, asOf, now));
  }
  return { ...(status.analysis || { campaignId, asOf, comparisons: [], recommendationIds: [], source: null }), status: status.status, stale: status.stale,
    commercialStale: status.commercialStale, metricStale: status.metricStale, job: status.job, recommendations: status.recommendations };
}
