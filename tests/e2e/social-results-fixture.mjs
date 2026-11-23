import { randomUUID } from 'node:crypto';
import { databaseConfig } from '../../lib/db/config.mjs';
import { openPostgres } from '../../lib/db/postgres.mjs';
import { Store } from '../../lib/store.mjs';
import { hash, insertRow } from '../../lib/business/commands.mjs';
import { SOCIAL_ANALYSIS_VERSION, buildSocialHistoricalForecast } from '../../lib/business/social-analysis.mjs';
import { socialMeasurementQueryKey } from '../../lib/social/evidence.mjs';
import { testDatabaseEnv } from '../postgres-fixture.mjs';
import { improvementMeasurement, exactMetric } from '../social-improvements-fixture.mjs';

const ROOT = '/api/admin/social';
// Catalog text is checked for phone numbers; keep fixture suffixes alphabetic.
export const catalogTag = marker => marker.slice(-8).replace(/\d/g, digit => 'ghijklmnop'[Number(digit)]);

export async function seedResults(f, { campaignEvidence = false } = {}) {
  const env = testDatabaseEnv(), host = new URL(env.DATABASE_URL).hostname;
  if (!['db', 'localhost', '127.0.0.1'].includes(host) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('La evidencia solo se instala en el fixture PostgreSQL local con TLS verificado.');
  const store = new Store(await openPostgres(databaseConfig(env)));
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test') throw new Error('La conexión real no corresponde al fixture allnutrition_test.');
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const now = new Date(), at = new Date(now - 1000).toISOString(), start = new Date(now - 8 * 86400000).toISOString();
    const connectionId = randomUUID(), assetId = randomUUID(), deliveryId = randomUUID(), forecastId = randomUUID();
    const identities = { userId: '100', businessId: '500', pageId: '200', ...(campaignEvidence ? { instagramId: '300' } : {}) };
    const name = `${f.marker} ${campaignEvidence ? 'post parcial' : 'post confirmado'}`;
    const common = { version: 1, created_at: start, updated_at: at };
    await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', data: JSON.stringify({ name: 'Cuenta de ensayo', identities, capabilities: { facebookPublish: true, ...(campaignEvidence ? { instagramPublish: true } : {}) } }), ...common });
    await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: 'a'.repeat(64), bytes: 100, data: JSON.stringify({ name: 'Pieza de ensayo', kind: 'image', derivativeSha256: 'a'.repeat(64) }), ...common });
    const tag = catalogTag(f.marker), product = await f.post('/api/admin/products', { title: `Oferta de prueba ${tag}`, slug: `prueba-${tag}`, status: 'draft', orderable: true, stockQuantity: 20, price: 25000, presentation: '500 g', flavor: 'Cacao' });
    const { offer } = await f.get(`${ROOT}/offers?kind=product&id=${product.id}`);
    const offerRef = { primary: { kind: 'product', id: product.id, factsHash: offer.factsHash }, gift: null };
    const draft = await f.post(`${ROOT}/campaigns`, { name, connectionId, assetId, offerRef, mode: 'organic', objective: 'engagement', caption: 'Texto actual de la publicación', marketCountries: ['MX'], platforms: campaignEvidence ? ['facebook', 'instagram'] : ['facebook'], placements: campaignEvidence ? ['facebook_feed', 'instagram_feed'] : ['facebook_feed'], aiDisclosure: false });
    const draftDetail = await f.campaign(draft.id);
    const fields = ['name','mode','objective','connectionId','assetId','caption','headline','destinationUrl','whatsappNumber','whatsappGreeting','marketCountries','platforms','placements','audience','budgetMinor','currency','publishAt','startAt','endAt','observationDays','targetCostMinor','aiDisclosure','integrationMethod','identities','timeZone'];
    const spec = { ...Object.fromEntries(fields.map(key => [key, draftDetail[key]]).filter(([, value]) => value !== undefined)), assetHash: 'a'.repeat(64), assetType: 'image', offerHash: draftDetail.offerHash };
    const approvedAt = campaignEvidence ? new Date(Date.parse(start) - 86400000).toISOString() : start;
    if (campaignEvidence) Object.assign(spec, { caption: 'Texto congelado en la aprobación', publishAt: new Date(Date.parse(start) - 3600000).toISOString() });
    const specHash = hash(spec), evidenceHash = hash([draft.id, at]), recommendationId = randomUUID();
    const forecast = { ...buildSocialHistoricalForecast(spec, [], { asOf: approvedAt }), specHash, generatedAt: approvedAt };
    await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: draft.id, spec_hash: specHash, generated_at: approvedAt, data: JSON.stringify(forecast) });
    await insertRow(store, 'social_revisions', { campaign_id: draft.id, revision: 1, spec_hash: specHash, approved_at: approvedAt, actor_id: actor.id, data: JSON.stringify({ spec, forecastId, forecast, rightsAccepted: true, ...(campaignEvidence ? { acceptedWarnings: ['organicDistribution'] } : {}), offerSnapshot: draftDetail.offerSnapshot }) });
    const object = BigInt(`0x${deliveryId.replaceAll('-', '')}`).toString().slice(0, 16), remoteId = `200_${object}`;
    const remoteRefs = { postId: remoteId, photoId: object, remoteId, permalink: `https://www.facebook.com/200/posts/${object}` };
    const delivery = { id: deliveryId, channel: 'facebook', remoteId, remoteRefs, integrationMethod: 'api', state: 'published', publishedAt: start, publicationTimeSource: 'publication_request_sent_at',
      ...(campaignEvidence ? { lastConfirmedState: 'published', lastConfirmedAt: new Date(Date.parse(start) + 600000).toISOString() } : {}) };
    await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: draft.id, revision: 1, channel: 'facebook', state: 'published', remote_id: remoteId, next_sync_at: null, data: JSON.stringify(delivery), ...common });
    await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: draft.id, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:publish`, step: 'publish', state: 'confirmed', next_attempt_at: null, data: JSON.stringify({ actorId: actor.id, specHash, chart: 'provider-controlled fixture', integrationMethod: 'api', channel: 'facebook', result: { evidence: { remoteRead: true } } }), ...common });
    if (campaignEvidence) {
      // A terminal local failure with no sync or queued operation cannot schedule a provider call.
      const secondId = randomUUID(), lastError = { message: 'No se pudo verificar la entrega de Instagram.' };
      await insertRow(store, 'social_deliveries', { id: secondId, campaign_id: draft.id, revision: 1, channel: 'instagram', state: 'failed', remote_id: null, next_sync_at: null, data: JSON.stringify({ integrationMethod: 'api', lastError }), ...common });
      await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: draft.id, delivery_id: secondId, operation_key: `delivery:${secondId}:publish`, step: 'publish', state: 'failed', next_attempt_at: null, data: JSON.stringify({ actorId: actor.id, specHash, integrationMethod: 'api', channel: 'instagram', lastError }), ...common });
    }
    const capture = improvementMeasurement(spec, delivery, { id: randomUUID(), now: at, values: { interactions: exactMetric(0, 'fixture_post_interactions') } });
    const { id: captureId, deliveryId: _delivery, fetchedAt, payloadHash: _hash, ...measurement } = capture;
    await insertRow(store, 'social_measurements', { id: captureId, delivery_id: deliveryId, query_key: socialMeasurementQueryKey(measurement), fetched_at: fetchedAt, payload_hash: hash(measurement), data: JSON.stringify(measurement) });
    const revision = Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);
    const row = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [draft.id]);
    const analysis = { analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash, businessRevision: revision, linkVersions: { orders: [], expenses: [] }, asOf: at, checkedAt: at, measurementCount: 1, recommendationIds: [recommendationId] };
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=?,state=?,updated_at=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), analysis }), campaignEvidence ? 'partial' : 'published', at, draft.id]);
    await insertRow(store, 'social_recommendations', { id: recommendationId, campaign_id: draft.id, evidence_hash: evidenceHash, rule_key: 'organic_response', state: 'suggested',
      data: JSON.stringify({ proposedChange: { type: 'copy', text: 'Probar una llamada a la acción más clara' }, primaryEvidence: { channel: 'facebook' }, observation: 'Respuesta por debajo de la referencia comparable.', successCriterion: { text: 'Aumentar interacciones al mismo horizonte.', metric: 'organicResponse', operator: 'gt', target: 0.1 }, sampleIds: [], metricIds: [captureId] }),
      version: 1, created_at: at, updated_at: at });
    await insertRow(store, 'social_recommendations', { id: randomUUID(), campaign_id: draft.id, evidence_hash: hash([draft.id, start]), rule_key: 'organic_response', state: 'evaluated',
      data: JSON.stringify({ proposedChange: { type: 'copy', text: 'Texto claro en la prueba anterior' }, primaryEvidence: { channel: 'facebook' }, observation: 'Prueba anterior para esta oferta.',
        successCriterion: { text: 'Aumentar interacciones al mismo horizonte.', metric: 'organicResponse', operator: 'gt', target: 0.1 }, conclusion: 'improved',
        evaluation: { complete: true, conclusion: 'improved', metric: 'organicResponse', parentValue: 0.08, childValue: 0.14, asOf: at } }), ...common });
    return { id: draft.id, name, recommendationId, connectionId, captureId };
  } finally { await store.close(); }
}
