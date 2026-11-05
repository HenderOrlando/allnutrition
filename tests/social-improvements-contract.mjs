import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash, insertRow } from '../lib/business/commands.mjs';
import { analyzeSocialCampaign, prepareSocialAnalysisRequest, getSocialAnalysis, buildSocialHistoricalForecast, readSocialComparableSamplesTx } from '../lib/business/social-analysis.mjs';
import { processSocialAnalysisTurn } from '../lib/business/social-analysis-jobs.mjs';
import { queueSocialAnalysisTx } from '../lib/business/social-analysis-queue.mjs';
import { claimJob, finishJob } from '../lib/business/job-leases.mjs';
import { socialCampaignAction, socialRecommendationAction, saveSocialCampaign } from '../lib/business/social.mjs';
import { saveSocialLink, getSocialBusinessResult } from '../lib/business/social-links.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { buildSocialSpec } from '../lib/business/social-spec.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { createBusinessBasics, businessOrderInput } from './business-fixtures.mjs';
import { CUT, CLOCK, exactMetric, createImprovementStoreFixture, commercialFingerprint, row, patchData, editable, improvementDelivery, improvementMeasurement } from './social-improvements-fixture.mjs';

const id = () => randomUUID();
const jobRow = (store, cid) => store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:analysis:${cid}`]);
const analysisAudits = (store, cid) => store.db.all(`SELECT * FROM ${store.t('business_audit')} WHERE entity_type='social_analysis' AND entity_id=? ORDER BY id`, [cid]);
const storedRecommendations = (store, cid) => store.db.all(`SELECT * FROM ${store.t('social_recommendations')} WHERE campaign_id=? ORDER BY id`, [cid]);
const prepare = f => prepareSocialAnalysisRequest(f.store, f.campaignId, { asOf: CUT });
async function analyze(f, extra = {}, actorId = f.actorId) {
  const request = await prepare(f);
  return analyzeSocialCampaign(f.store, f.campaignId, { asOf: CUT, requestId: request.requestId, expectedEvidenceHash: request.evidenceHash, ...extra }, actorId);
}
async function recommendation(f, ruleKey = 'weak_link_ctr') {
  await analyze(f);
  const value = (await getSocialAnalysis(f.store, f.campaignId, { asOf: CUT })).recommendations.find(rec => rec.ruleKey === ruleKey);
  assert.equal(value?.ruleKey, ruleKey);
  return value;
}
async function queue(store, campaignId, options) {
  return store.transaction(async tx => { await tx.lockWrites(); return queueSocialAnalysisTx(tx, campaignId, options); });
}
async function createRecognizedOrder(f, basics) {
  const order = await f.store.saveOrder(businessOrderInput(basics.a, { year: 2026, sellerId: null, shippingChargeMinor: 0,
    items: [{ lineId: id(), kind: 'products', itemId: basics.a.id, quantity: 1, unitPriceMinor: 3000000, discountMinor: 0 }] }), f.actorId);
  let shipment = await createShipment(f.store, { requestId: id(), orderId: order.id, carrier: 'Transportadora sintética', tracking: id() }, f.actorId);
  shipment = await recordShipmentEvent(f.store, shipment.id, { requestId: id(), version: shipment.version, status: 'collected', occurredOn: '2026-09-02' }, f.actorId);
  await recordShipmentEvent(f.store, shipment.id, { requestId: id(), version: shipment.version, status: 'delivered', occurredOn: '2026-09-03' }, f.actorId);
  await recordExpense(f.store, { requestId: id(), category: 'shipping_out', amountMinor: 0, incurredOn: '2026-09-02', shipmentId: shipment.id, orderId: order.id, concept: 'Flete expresamente cero del ensayo' }, f.actorId);
  await recordCollection(f.store, { requestId: id(), orderId: order.id, version: (await f.store.order(order.id)).version,
    holder: 'business', accountId: basics.account.id, occurredOn: '2026-09-04', amountMinor: 3000000, method: 'Transferencia sintética', reference: id() }, f.actorId);
  await saveSocialLink(f.store, { kind: 'order', recordId: order.id, campaignId: f.campaignId, version: 0, requestId: id(), reason: 'Origen declarado del ensayo' }, f.actorId);
  return order;
}

const cases = [
  ['identity is deterministic per coherent evidence and cutoff; replay does not duplicate evaluation or affect commerce', async store => {
    const f = await createImprovementStoreFixture(store), firstRequest = await prepare(f), before = await commercialFingerprint(store);
    assert.deepEqual(await prepare(f), firstRequest);
    const result = await analyze(f);
    const recs = await storedRecommendations(store, f.campaignId), audits = await analysisAudits(store, f.campaignId);
    assert.equal(result.evidenceHash, firstRequest.evidenceHash);
    assert.deepEqual(await analyze(f), result);
    const distinctRequest = await analyze(f, { requestId: id() });
    assert.equal(distinctRequest.evidenceHash, result.evidenceHash);
    assert.deepEqual(await storedRecommendations(store, f.campaignId), recs);
    assert.deepEqual(await analysisAudits(store, f.campaignId), audits);
    assert.equal((await row(store, 'social_campaigns', f.campaignId)).version, f.campaign.version);
    assert.equal(await commercialFingerprint(store), before);
    const revision = await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=1`, [f.campaignId]);
    assert.deepEqual(JSON.parse(revision.data).forecast, f.forecast);
    const laterCut = await prepareSocialAnalysisRequest(store, f.campaignId, { asOf: '2026-11-02T12:01:00.000Z' });
    assert.notEqual(laterCut.requestId, firstRequest.requestId);
  }],
  ['unapproved forecasts do not rewrite approved evidence; a new measurement fences an older prepared request', async store => {
    const f = await createImprovementStoreFixture(store), request = await prepare(f);
    const otherSpec = { ...f.spec, budgetMinor: f.spec.budgetMinor + 100000 }, otherHash = hash(otherSpec), otherId = id();
    const otherForecast = { ...buildSocialHistoricalForecast(otherSpec, [], { asOf: CUT }), id: otherId, specHash: otherHash, generatedAt: CUT };
    await insertRow(store, 'social_forecasts', { id: otherId, campaign_id: f.campaignId, spec_hash: otherHash, generated_at: CUT, data: JSON.stringify(otherForecast) });
    assert.deepEqual(await prepare(f), request);
    const changed = await f.addMeasurement({ fetchedAt: CUT, values: { linkClicks: exactMetric(120) } });
    const next = await prepare(f); assert.notEqual(next.evidenceHash, request.evidenceHash); assert.notEqual(next.requestId, request.requestId);
    await assert.rejects(() => analyzeSocialCampaign(store, f.campaignId, { asOf: CUT, requestId: request.requestId, expectedEvidenceHash: request.evidenceHash }, f.actorId), { status: 409 });
    assert.deepEqual(await storedRecommendations(store, f.campaignId), []);
    const result = await analyze(f);
    assert.equal(result.evidenceHash, next.evidenceHash);
    assert.equal(result.forecastId, f.forecastId);
    assert.equal(result.recommendations.find(rec => rec.ruleKey === 'weak_link_ctr').metricIds.includes(changed.id), true);
    await assert.rejects(() => analyze(f, { asOf: '2026-11-02T12:01:00.000Z', requestId: next.requestId }), { status: 409 });
  }],
  ['unrelated business revision marks commercial evidence stale once, then checks the same evidence without duplicate cards', async store => {
    const f = await createImprovementStoreFixture(store), initial = await analyze(f), recs = await storedRecommendations(store, f.campaignId), audits = await analysisAudits(store, f.campaignId);
    await recordExpense(store, { requestId: id(), category: 'operating', amountMinor: 12345, incurredOn: '2026-09-15', concept: 'Gasto ajeno a esta campaña' }, f.actorId);
    const first = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal(first.commercialStale, true); assert.equal(first.stale, true); assert.notEqual(first.status, 'current');
    const queued = await jobRow(store, f.campaignId), generation = JSON.parse(queued.data).generation;
    const second = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal(second.commercialStale, true); assert.equal(JSON.parse((await jobRow(store, f.campaignId)).data).generation, generation);
    const before = await commercialFingerprint(store);
    await processSocialAnalysisTurn(store, { now: CLOCK, maxCampaigns: 1 });
    const finished = await jobRow(store, f.campaignId), refreshed = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal(finished.state, 'succeeded'); assert.equal(finished.lease_token, null);
    assert.equal(refreshed.status, 'current'); assert.equal(refreshed.commercialStale, false); assert.equal(refreshed.evidenceHash, initial.evidenceHash);
    assert.deepEqual(await storedRecommendations(store, f.campaignId), recs); assert.deepEqual(await analysisAudits(store, f.campaignId), audits);
    assert.equal(await commercialFingerprint(store), before);
    // The next unrelated revision replays the scheduler's own request, not the
    // initial administrator request; freshness must advance without evaluation.
    await recordExpense(store, { requestId: id(), category: 'operating', amountMinor: 23456, incurredOn: '2026-09-16', concept: 'Segundo gasto ajeno a esta campaña' }, f.actorId);
    assert.equal((await getSocialAnalysis(store, f.campaignId, { asOf: CUT })).commercialStale, true);
    const replayBefore = await commercialFingerprint(store);
    await processSocialAnalysisTurn(store, { now: CLOCK, maxCampaigns: 1 });
    const replayed = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal((await jobRow(store, f.campaignId)).state, 'succeeded');
    assert.equal(replayed.status, 'current'); assert.equal(replayed.commercialStale, false);
    assert.equal(replayed.evidenceHash, initial.evidenceHash);
    assert.deepEqual(await storedRecommendations(store, f.campaignId), recs);
    assert.deepEqual(await analysisAudits(store, f.campaignId), audits);
    assert.equal(await commercialFingerprint(store), replayBefore);
  }],
  ['a generation arriving during running analysis survives the atomic finish and keeps its own cutoff', async store => {
    const f = await createImprovementStoreFixture(store), first = await queue(store, f.campaignId, { now: CLOCK, asOf: CUT, requestedBy: f.actorId });
    const lease = await claimJob(store, { key: first.key, now: CLOCK });
    const nextCut = '2026-11-02T12:01:00.000Z';
    await queue(store, f.campaignId, { now: '2026-11-20T12:00:01.000Z', asOf: nextCut, requestedBy: f.actorId });
    const running = await jobRow(store, f.campaignId);
    assert.equal(running.state, 'running'); assert.equal(running.lease_token, lease.token); assert.equal(running.lease_until, lease.leaseUntil);
    assert.equal(JSON.parse(running.data).generation, first.generation + 1);
    await finishJob(store, lease, { now: '2026-11-20T12:00:02.000Z', expectedGeneration: first.generation });
    const pending = await jobRow(store, f.campaignId);
    assert.equal(pending.state, 'queued'); assert.equal(pending.lease_token, null); assert.equal(JSON.parse(pending.data).asOf, nextCut);
    const nextLease = await claimJob(store, { key: first.key, now: '2026-11-20T12:00:03.000Z' });
    assert.notEqual(nextLease.token, lease.token); assert.equal(nextLease.generation, first.generation + 1); assert.equal(nextLease.asOf, nextCut);
    await assert.rejects(() => finishJob(store, lease, { now: '2026-11-20T12:00:04.000Z', expectedGeneration: first.generation }), { status: 409 });
  }],
  ['scheduler fencing uses the live lease clock, not a historical financial cutoff or another campaign lock', async store => {
    const f = await createImprovementStoreFixture(store);
    await assert.rejects(() => analyze(f, {}, 'scheduler'), { status: 403 });
    const q = await queue(store, f.campaignId, { now: CLOCK, asOf: CUT, requestedBy: f.actorId });
    const lease = await claimJob(store, { key: q.key, now: CLOCK });
    const result = await analyze(f, { lease: { ...lease, now: CLOCK }, requestId: id() }, 'scheduler');
    assert.equal(result.asOf, CUT);
    await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_until=? WHERE key=?`, ['2026-11-20T11:59:59.000Z', lease.key]);
    await assert.rejects(() => analyze(f, { lease: { ...lease, now: CLOCK }, requestId: id() }, 'scheduler'), { status: 409 });
    const other = await queue(store, id(), { now: CLOCK, asOf: CUT, requestedBy: f.actorId });
    const otherLease = await claimJob(store, { key: other.key, now: CLOCK });
    await assert.rejects(() => analyze(f, { lease: { ...otherLease, now: CLOCK }, requestId: id() }, 'scheduler'), { status: 403 });
  }],
  ['manual analyze enqueues the shared durable work without synchronous evaluation and replay does not add a generation', async store => {
    const f = await createImprovementStoreFixture(store), input = { version: f.campaign.version, requestId: id() };
    await socialCampaignAction(store, f.campaignId, 'analyze', input, f.actorId, { now: CUT });
    const first = await jobRow(store, f.campaignId), data = JSON.parse(first.data);
    assert.equal(first.state, 'queued'); assert.equal(data.id, f.campaignId); assert.equal(data.kind, 'analysis'); assert.equal(data.requestedBy, f.actorId); assert.equal(data.asOf, CUT);
    assert.deepEqual(await storedRecommendations(store, f.campaignId), []);
    await socialCampaignAction(store, f.campaignId, 'analyze', input, f.actorId, { now: CUT });
    assert.equal(JSON.parse((await jobRow(store, f.campaignId)).data).generation, data.generation);
    const before = await commercialFingerprint(store);
    await processSocialAnalysisTurn(store, { now: CLOCK, maxCampaigns: 1 });
    const analysis = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal((await jobRow(store, f.campaignId)).state, 'succeeded'); assert.equal(analysis.asOf, CUT);
    assert.equal(analysis.recommendations.find(rec => rec.ruleKey === 'weak_link_ctr').state, 'suggested');
    const audit = await analysisAudits(store, f.campaignId); assert.equal(audit.at(-1).actor_id, 'scheduler');
    assert.equal(await commercialFingerprint(store), before);
  }],
  ['inactive actors cannot calculate or replay analysis or recommendation decisions', async store => {
    const f = await createImprovementStoreFixture(store), request = await prepare(f); await analyze(f);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    for (const requestId of [request.requestId, id()]) await assert.rejects(() => analyze(f, { requestId }), { status: 403 });
    await assert.rejects(() => socialCampaignAction(store, f.campaignId, 'analyze', { version: f.campaign.version, requestId: id() }, f.actorId, { now: CUT }), { status: 403 });
  }],
  ['dismiss is versioned, reasoned, actor-bound and idempotent without touching the underlying evidence', async store => {
    const f = await createImprovementStoreFixture(store), rec = await recommendation(f), before = await commercialFingerprint(store);
    const input = { version: rec.version, requestId: id(), reason: 'La prueba propuesta ya se planificó por otra vía' };
    await assert.rejects(() => socialRecommendationAction(store, rec.id, 'dismiss', { ...input, reason: '' }, f.actorId, { now: CUT }), { status: 400 });
    await assert.rejects(() => socialRecommendationAction(store, rec.id, 'dismiss', { ...input, version: rec.version + 1 }, f.actorId, { now: CUT }), { status: 409 });
    const dismissed = await socialRecommendationAction(store, rec.id, 'dismiss', input, f.actorId, { now: CUT });
    const saved = await row(store, 'social_recommendations', rec.id);
    assert.equal(saved.state, 'dismissed'); assert.equal(saved.version, rec.version + 1); assert.equal(saved.evidenceHash, rec.evidenceHash);
    assert.deepEqual(await socialRecommendationAction(store, rec.id, 'dismiss', input, f.actorId, { now: CUT }), dismissed);
    await assert.rejects(() => socialRecommendationAction(store, rec.id, 'dismiss', { ...input, reason: 'Otra razón con el mismo identificador' }, f.actorId, { now: CUT }), { status: 409 });
    await assert.rejects(() => socialRecommendationAction(store, rec.id, 'dismiss', { ...input, requestId: id() }, f.actorId, { now: CUT }), { status: 409 });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => socialRecommendationAction(store, rec.id, 'dismiss', input, f.actorId, { now: CUT }), { status: 403 });
    assert.equal(await commercialFingerprint(store), before);
  }],
  ['applying copy or creative recommendations creates a clean draft atomically, with the same budget and explicit user work', async store => {
    let basics;
    for (const [ruleKey, changeType] of [['weak_link_ctr', 'copy'], ['possible_fatigue', 'creative']]) {
      const f = await createImprovementStoreFixture(store);
      basics ||= await createBusinessBasics(store, { actorId: f.actorId, year: 2026, reportsStartOn: '2026-09-01', withPlatform: false });
      const order = await store.saveOrder(businessOrderInput(basics.a, { year: 2026, shippingChargeMinor: 0 }), f.actorId);
      const expense = await recordExpense(store, { requestId: id(), category: 'advertising', amountMinor: 100000, incurredOn: '2026-09-04', concept: 'Documento fuente que no debe copiarse al nuevo borrador' }, f.actorId);
      for (const [kind, recordId] of [['order', order.id], ['expense', expense.id]]) {
        await saveSocialLink(store, { kind, recordId, campaignId: f.campaignId, version: 0, requestId: id(), reason: 'Asociación que pertenece exclusivamente al padre' }, f.actorId);
      }
      if (changeType === 'creative') {
        await f.addMeasurement({ window: 'previous_3d', values: { impressions: exactMetric(2000, 'fixture_impressions'), reach: exactMetric(1000, 'fixture_reach'), linkClicks: exactMetric(20) } });
        await f.addMeasurement({ window: 'recent_3d', values: { impressions: exactMetric(2000, 'fixture_impressions'), reach: exactMetric(500, 'fixture_reach'), linkClicks: exactMetric(16) } });
      }
      const rec = await recommendation(f, ruleKey), input = { version: rec.version, requestId: id() };
      assert.equal(rec.proposedChange.type, changeType);
      await patchData(store, 'social_campaigns', f.campaignId, { forecastId: f.forecastId, remoteRefs: { campaignId: '600' }, preparedRefs: { adId: '601' }, preflight: { remoteDraftRef: '900' }, acceptance: { investmentAccepted: true }, rightsAccepted: true });
      const before = await commercialFingerprint(store);
      const originalLinks = await store.db.all(`SELECT * FROM ${store.t('social_order_links')} WHERE campaign_id=? ORDER BY order_id`, [f.campaignId]);
      const originalExpenses = await store.db.all(`SELECT * FROM ${store.t('social_expense_links')} WHERE campaign_id=? ORDER BY expense_id`, [f.campaignId]);
      const created = await socialRecommendationAction(store, rec.id, 'duplicate-from-recommendation', input, f.actorId, { now: CLOCK });
      assert.deepEqual(await socialRecommendationAction(store, rec.id, 'duplicate-from-recommendation', input, f.actorId, { now: CLOCK }), created);
      const child = await row(store, 'social_campaigns', created.id);
      assert.notEqual(child.id, f.campaignId); assert.equal(child.state, 'draft'); assert.equal(child.version, 1);
      assert.equal(child.parentCampaignId, f.campaignId); assert.equal(child.sourceRecommendationId, rec.id);
      assert.equal(child.budgetMinor, f.spec.budgetMinor); assert.equal(child.currency, f.spec.currency);
      assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_order_links')} WHERE campaign_id=? ORDER BY order_id`, [f.campaignId]), originalLinks);
      assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_expense_links')} WHERE campaign_id=? ORDER BY expense_id`, [f.campaignId]), originalExpenses);
      for (const key of ['publishAt', 'startAt', 'endAt']) assert.equal(child[key], null);
      for (const key of ['forecastId', 'forecast', 'remoteRefs', 'preparedRefs', 'preflight', 'acceptance', 'rightsAccepted']) assert.equal(child[key], undefined, key);
      if (changeType === 'copy') assert.equal(child.caption, ''); else assert.equal(child.assetId, null);
      assert.equal(child.recommendationInstructions.needsConfirmation, true);
      assert.equal(child.recommendationInstructions.ruleKey, ruleKey);
      assert.equal(child.recommendationInstructions.changeType, changeType);
      assert.equal((await row(store, 'social_recommendations', rec.id)).state, 'applied');
      for (const [table, column] of [['social_revisions', 'campaign_id'], ['social_deliveries', 'campaign_id'], ['social_operations', 'campaign_id'], ['social_forecasts', 'campaign_id'], ['social_order_links', 'campaign_id'], ['social_expense_links', 'campaign_id']]) {
        assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t(table)} WHERE ${column}=?`, [child.id]), [], table);
      }
      const jobs = await store.db.all(`SELECT * FROM ${store.t('job_runs')}`);
      assert.equal(jobs.some(job => JSON.parse(job.data).id === child.id), false);
      await assert.rejects(() => socialRecommendationAction(store, rec.id, 'duplicate-from-recommendation', { ...input, requestId: id() }, f.actorId, { now: CLOCK }), { status: 409 });
      assert.equal(await commercialFingerprint(store), before);
      // All normal approval inputs are valid. These two refusals isolate the
      // recipe/acknowledgment guard before any media/provider work is allowed.
      const env = { APP_URL: 'https://example.test', META_APP_ID: '42', META_APP_SECRET: 'SYNTHETIC-IMPROVEMENTS-SECRET', META_LOGIN_CONFIG_ID: 'synthetic-login',
        META_GRAPH_VERSION: 'v26.0', SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SOCIAL_MEDIA_SIGNING_KEY: randomBytes(32).toString('base64') };
      await saveCredentials(store, f.connectionId, { accessToken: 'SYNTHETIC-IMPROVEMENTS-TOKEN', userId: '100' }, { env });
      let saved = await saveSocialCampaign(store, { id: child.id, version: child.version, requestId: id(), caption: f.spec.caption, assetId: f.assetId,
        startAt: '2026-11-21T05:00:00.000Z', endAt: '2026-11-28T05:00:00.000Z' }, f.actorId, { now: CLOCK });
      const approval = async recommendationAccepted => {
        const current = await row(store, 'social_campaigns', child.id);
        const built = buildSocialSpec(current, { connection: await row(store, 'social_connections', f.connectionId), asset: await row(store, 'social_assets', current.assetId), now: CLOCK });
        const forecastId = id(), forecast = { ...buildSocialHistoricalForecast(built.spec, [], { asOf: CLOCK }), specHash: built.specHash };
        await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: child.id, spec_hash: built.specHash, generated_at: CLOCK, data: JSON.stringify(forecast) });
        return socialCampaignAction(store, child.id, 'prepare-paid', { version: saved.version, requestId: id(), specHash: built.specHash, forecastId,
          rightsAccepted: true, investmentAccepted: true, acceptedWarnings: built.warnings.map(warning => warning.key), ...(recommendationAccepted ? { recommendationAccepted: true } : {}) }, f.actorId, { now: CLOCK, env });
      };
      await assert.rejects(() => approval(true), { status: 400 });
      const edited = changeType === 'copy' ? { caption: 'Texto y llamada a la acción nuevos aportados por el usuario' } : { assetId: id() };
      if (changeType === 'creative') await insertRow(store, 'social_assets', { id: edited.assetId, state: 'ready', sha256: 'b'.repeat(64), bytes: 100,
        ...editable({ name: 'Otra pieza aportada', kind: 'image', derivativeSha256: 'b'.repeat(64) }) });
      saved = await saveSocialCampaign(store, { id: child.id, version: saved.version, requestId: id(), ...edited }, f.actorId, { now: CLOCK });
      await assert.rejects(() => approval(false), { status: 400 });
      assert.equal((await row(store, 'social_campaigns', child.id)).state, 'draft');
      assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE campaign_id=?`, [child.id]), []);
      assert.equal(await commercialFingerprint(store), before);
    }
  }],
  ['a confirmed child completes its stored evaluation without calling greater spend and raw volume an improvement', async store => {
    const f = await createImprovementStoreFixture(store), rec = await recommendation(f);
    const child = await socialRecommendationAction(store, rec.id, 'duplicate-from-recommendation', { version: rec.version, requestId: id() }, f.actorId, { now: CUT });
    await saveSocialCampaign(store, { id: child.id, version: child.version, requestId: id(), caption: 'Texto diferente aportado para esta observación',
      budgetMinor: f.spec.budgetMinor * 2, startAt: '2026-11-03T05:00:00.000Z', endAt: '2026-11-10T05:00:00.000Z' }, f.actorId, { now: CUT });
    const cut = '2026-11-10T12:00:00.000Z', current = await row(store, 'social_campaigns', child.id);
    const built = buildSocialSpec(current, { connection: await row(store, 'social_connections', f.connectionId), asset: await row(store, 'social_assets', f.assetId), now: CUT });
    const { samples } = await store.readSnapshot(tx => readSocialComparableSamplesTx(tx, built.spec, { asOf: cut, excludeCampaignId: child.id }));
    const candidates = samples.map(sample => ({ id: sample.campaignId, spec: sample.spec, specHash: sample.specHash, deliveries: [sample.delivery], measurements: [sample.measurement] }));
    const forecastId = id(), forecast = { ...buildSocialHistoricalForecast(built.spec, candidates, { asOf: cut }), specHash: built.specHash };
    await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: child.id, spec_hash: built.specHash, generated_at: CUT, data: JSON.stringify(forecast) });
    await insertRow(store, 'social_revisions', { campaign_id: child.id, revision: 1, spec_hash: built.specHash, approved_at: CUT, actor_id: f.actorId,
      data: JSON.stringify({ spec: built.spec, forecastId, forecast, recommendationAccepted: true }) });
    const delivery = improvementDelivery(built.spec, { id: id(), campaignId: child.id, remoteId: '800', remoteRefs: { campaignId: '800', adId: '801' } });
    await insertRow(store, 'social_deliveries', { id: delivery.id, campaign_id: child.id, revision: 1, channel: 'meta_ads', state: 'completed', remote_id: '800', next_sync_at: null, ...editable(delivery) });
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='completed' WHERE id=?`, [child.id]);
    const measurement = improvementMeasurement(built.spec, delivery, { id: id(), now: cut, values: { impressions: exactMetric(20000, 'fixture_impressions'),
      linkClicks: exactMetric(200), spendMinor: exactMetric(10000000, 'fixture_spend', 'minor_currency') } });
    const { id: measurementId, deliveryId, fetchedAt, payloadHash, ...payload } = measurement;
    await insertRow(store, 'social_measurements', { id: measurementId, delivery_id: deliveryId, query_key: hash(payload.query), fetched_at: fetchedAt, payload_hash: payloadHash, data: JSON.stringify(payload) });
    const request = await prepareSocialAnalysisRequest(store, child.id, { asOf: cut }), before = await commercialFingerprint(store);
    await analyzeSocialCampaign(store, child.id, { asOf: cut, requestId: request.requestId, expectedEvidenceHash: request.evidenceHash }, f.actorId);
    const evaluated = await row(store, 'social_recommendations', rec.id);
    assert.equal(evaluated.state, 'evaluated');
    assert.notEqual(evaluated.evaluation.conclusion, 'improved');
    const persisted = await storedRecommendations(store, f.campaignId);
    await analyzeSocialCampaign(store, child.id, { asOf: cut, requestId: request.requestId, expectedEvidenceHash: request.evidenceHash }, f.actorId);
    assert.deepEqual(await storedRecommendations(store, f.campaignId), persisted);
    assert.equal(await commercialFingerprint(store), before);
  }],
  ['financial facts and link versions change evidence; incomplete financial coverage never masks a valid metric recommendation', async store => {
    const f = await createImprovementStoreFixture(store), basics = await createBusinessBasics(store, { actorId: f.actorId, year: 2026, reportsStartOn: '2026-09-01', withPlatform: false });
    const orders = [];
    for (let i = 0; i < 5; i++) orders.push(await createRecognizedOrder(f, basics));
    const business = await getSocialBusinessResult(store, f.campaignId, { asOf: CUT });
    assert.equal(business.orders.length, 5); assert.equal(business.coverage.complete, true); assert.equal(business.contributionAfterAdvertising.valueMinor < 0, true);
    const before = await commercialFingerprint(store), initial = await analyze(f);
    assert.equal(initial.recommendations.some(rec => rec.ruleKey === 'declared_return_gap'), true);
    assert.equal(initial.recommendations.some(rec => rec.ruleKey === 'weak_link_ctr'), true);
    assert.equal(await commercialFingerprint(store), before);
    const firstRequest = await prepare(f);
    await saveSocialLink(store, { kind: 'order', recordId: orders[0].id, campaignId: f.campaignId, version: 1, requestId: id(), reason: 'Se rectifica el motivo conservando la asociación declarada' }, f.actorId);
    const versionChange = await prepare(f); assert.notEqual(versionChange.evidenceHash, firstRequest.evidenceHash);
    const order = await store.order(orders[0].id);
    await patchData(store, 'orders', order.id, { items: order.items.map(item => ({ ...item, unitCostMinor: null })) });
    const factChange = await prepare(f); assert.notEqual(factChange.evidenceHash, versionChange.evidenceHash);
    const incomplete = await getSocialBusinessResult(store, f.campaignId, { asOf: CUT });
    assert.equal(incomplete.knownContribution.complete, false);
    const next = await analyze(f);
    assert.equal(next.recommendations.some(rec => rec.ruleKey === 'declared_return_gap'), false);
    assert.equal(next.recommendations.some(rec => rec.ruleKey === 'weak_link_ctr'), true);
    const displayed = await getSocialAnalysis(store, f.campaignId, { asOf: CUT });
    assert.equal(displayed.recommendations.some(rec => rec.ruleKey === 'declared_return_gap' && rec.evidenceHash === firstRequest.evidenceHash), false);
  }]
];

export async function runSocialImprovementContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory();
    try { await scenario(store); } finally { await store.close(); }
  });
}
