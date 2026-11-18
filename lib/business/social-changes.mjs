import { entity, hash, insertRow, newId, updateVersioned, audit } from './commands.mjs';
import { fail, integer, text } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { loadSocialRuntime } from '../social/config.mjs';
import { socialPlacementMatches } from '../social/piece-compatibility.mjs';
import { readEffectiveSocialDelivery, isContentChange, openSocialOperation } from './social-effective.mjs';
import { queueJobTx } from './job-leases.mjs';
import { queueSocialAnalysisTx } from './social-analysis-queue.mjs';
import { assertSocialOfferCurrent } from './social-offers.mjs';
import { assertFreshSocialRecommendation } from './social-analysis.mjs';

const idPattern = /^[a-f0-9-]{36}$/i;
const get = async (tx, table, id) => entity(await tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`, [id]));
const raw = row => JSON.parse(row?.data || '{}');
const dataOf = async (tx, table, id) => raw(await tx.db.get(`SELECT data FROM ${tx.t(table)} WHERE id=?`, [id]));
const abort = message => fail(message, 409);
const VARIANTS = { copy: 'caption', creative: 'asset', placement: 'placement' };
const PLACEMENT_FIELDS = { facebook_feed: ['facebook', 'feed'], facebook_reels: ['facebook', 'facebook_reels'], instagram_feed: ['instagram', 'stream'], instagram_reels: ['instagram', 'reels'] };
const COMMERCIAL_FIELDS = ['name','connectionId','assetId','mode','objective','platforms','caption','headline','destinationUrl','whatsappNumber','whatsappGreeting','audience','placements','budgetMinor','currency','observationDays','targetCostMinor','aiDisclosure','publishAt','startAt','endAt','offerRef','offerHash'];
const restoreHold = value => Boolean(value?.restoreHold || value?.restore_hold);

export async function socialChangeEligibility(tx, campaign, recommendation, deliveries, { now, operations } = {}) {
  if (!deliveries.length || recommendation.state !== 'suggested') return [];
  const kind = VARIANTS[recommendation.proposedChange?.type], channel = recommendation.primaryEvidence?.channel;
  const journal = operations || (await tx.db.all(`SELECT * FROM ${tx.t('social_operations')} WHERE campaign_id=? ORDER BY created_at,id`, [campaign.id])).map(entity);
  const connection = await get(tx, 'social_connections', campaign.connectionId);
  return Promise.all(deliveries.filter(delivery => !channel || delivery.channel === channel).map(async delivery => {
    const item = { deliveryId: delivery.id, channel: delivery.channel, variable: kind || null, allowed: false };
    const reject = reason => ({ ...item, reason });
    if (!kind) return reject('La propuesta requiere medición, revisar costos o una nueva fecha; no edita esta pieza.');
    if (restoreHold(campaign) || restoreHold(connection) || connection?.state !== 'connected' || connection.disconnectPending || connection.revalidationRequired) return reject('Reconcilia o vuelve a verificar la cuenta antes de cambiar la pieza.');
    const browser = delivery.integrationMethod === 'browser';
    if (browser && (delivery.channel !== 'facebook' || kind !== 'caption' || delivery.evidence?.editCaptionAvailable !== true)) return reject('Esta superficie del navegador no muestra un control inequívoco para editar texto, con identidad y adjunto comprobables. Prepara una variante.');
    if (delivery.channel === 'instagram') return reject('La API de Instagram no permite sustituir aquí el texto ni la imagen publicados. Prepara una variante.');
    const own = journal.some(op => op.deliveryId === delivery.id && op.step === (delivery.channel === 'facebook' ? 'publish' : 'verify_prepared') && op.state === 'confirmed' && op.result?.evidence?.remoteRead === true && op.result.evidence.source !== 'operator_verified' && !op.result.evidence.contentVerifiedByAdministrator);
    if (!own || !delivery.remoteId) return reject('No consta que esta app publicara o preparara el objeto identificado.');
    if (journal.some(op => op.deliveryId === delivery.id && openSocialOperation(op))) return reject('Comprueba la operación pendiente antes de preparar otro cambio.');
    const revision = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [campaign.id, delivery.revision]));
    const effective = await readEffectiveSocialDelivery(tx, revision, delivery), { spec } = effective;
    if (spec.aiDisclosure !== false) return reject('Esta vía no acredita la etiqueta de divulgación para la pieza.');
    if (delivery.channel === 'facebook') {
      if (connection.capabilities?.facebookPublish !== true || kind !== 'caption' || !spec.placements.includes('facebook_feed') || !browser && (!delivery.remoteRefs?.photoId || delivery.remoteRefs.postId !== delivery.remoteId) || delivery.state !== 'published') return reject('Solo se admite el texto de un post propio de Feed de Facebook con adjunto confirmado.');
    } else if (delivery.channel === 'meta_ads') {
      if (connection.capabilities?.adsPublish !== true || !['paused', 'ready'].includes(delivery.state) || spec.endAt <= now || !delivery.preparedRefs || !delivery.remoteRefs?.adId || !delivery.remoteRefs?.adSetId || delivery.remoteRefs.campaignId !== delivery.remoteId) return reject('Solo se cambia una pauta propia, pausada, vigente y verificada; pausar es una acción separada.');
      const budget = delivery.budgetSnapshot;
      if (budget?.currency !== spec.currency || budget?.budgetMinor !== spec.budgetMinor || !Number.isSafeInteger(budget?.remainingMinor) || budget.startAt !== spec.startAt || budget.endAt !== spec.endAt || delivery.pausedAt && budget.checkedAt < delivery.pausedAt) return reject('Actualiza primero la lectura del saldo y las fechas de la pauta pausada.');
      if (kind === 'placement' && (spec.placements.length < 2 || !spec.placements.includes(recommendation.proposedChange.placement))) return reject('La ubicación debe ser un subconjunto de las autorizadas.');
    } else return reject('Esta red no admite el cambio en la vía elegida.');
    return { ...item, allowed: true, reason: null };
  }));
}

async function changeContext(tx, campaign, recommendation, deliveryId, now) {
  const delivery = await get(tx, 'social_deliveries', deliveryId);
  if (!delivery || delivery.campaignId !== campaign.id) fail('Entrega no encontrada en la publicación original.', 404);
  const [eligibility] = await socialChangeEligibility(tx, campaign, recommendation, [delivery], { now });
  if (!eligibility?.allowed) abort(eligibility?.reason || 'La evidencia corresponde a otra entrega.');
  const revision = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [campaign.id, delivery.revision]));
  return { delivery, revision, effective: await readEffectiveSocialDelivery(tx, revision, delivery), eligibility };
}

function placementSpec(spec, placement) {
  const [network, position] = PLACEMENT_FIELDS[placement] || [];
  if (!network || !spec.placements.includes(placement) || spec.placements.length < 2) abort('La ubicación no reduce las ubicaciones autorizadas.');
  const targeting = { ...spec.targeting, publisher_platforms: [network] };
  delete targeting.facebook_positions; delete targeting.instagram_positions;
  targeting[`${network}_positions`] = [position];
  return { ...spec, placements: [placement], targeting };
}

async function difference(tx, draft, recommendation, delivery, runtime) {
  const { baseSpec: spec, variable } = draft.changeBase;
  let proposed = spec, before, after;
  if (variable === 'caption') {
    before = spec.caption; after = text(draft.caption, 'Texto', 2200, true);
    proposed = { ...spec, caption: after };
  } else if (variable === 'placement') {
    before = spec.placements; after = [recommendation.proposedChange.placement];
    proposed = placementSpec(spec, after[0]);
  } else {
    before = { id: spec.assetId, sha256: spec.assetHash };
    const asset = await get(tx, 'social_assets', draft.assetId);
    if (!asset || asset.kind !== 'image' || asset.state !== 'ready' || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || asset.derivativeSha256 !== asset.sha256 ||
        asset.generation || asset.aiDisclosure === true || draft.aiDisclosure !== false) abort('Selecciona una imagen propia lista, sin divulgación requerida; esta vía no verifica la etiqueta. Usa otra variante para video o divulgación.');
    if (!spec.placements.every(placement => socialPlacementMatches(placement, asset.kind, spec.mode))) abort('La imagen no es compatible con las ubicaciones efectivas del anuncio.');
    after = { id: asset.id, sha256: asset.sha256 };
    proposed = { ...spec, assetId: asset.id, assetHash: asset.sha256, assetType: 'image' };
  }
  const budget = spec.mode === 'paid' ? delivery.budgetSnapshot : null;
  const unchanged = variable === 'asset' ? before.sha256 === after.sha256 : hash(before) === hash(after);
  const proposedHash = hash(proposed), diffHash = hash({ draftId: draft.id, draftVersion: draft.version, deliveryId: delivery.id, recommendationId: recommendation.id, evidenceHash: recommendation.evidenceHash, baseHash: draft.changeBase.baseHash, proposedHash, budget, configurationVersion: runtime.configurationVersion });
  return { before, after, budget, proposed, proposedHash, diffHash, unchanged };
}

export async function projectSocialChangeDraft(tx, draft, { env = process.env, now }) {
  if (draft.applicationMode !== 'same') return null;
  const base = draft.changeBase;
  const [recommendation, delivery, runtime, operation] = await Promise.all([get(tx, 'social_recommendations', draft.sourceRecommendationId), get(tx, 'social_deliveries', base.deliveryId), loadSocialRuntime(tx, { env }), draft.changeOperationId ? get(tx, 'social_operations', draft.changeOperationId) : null]);
  const dto = { recommendationId: draft.sourceRecommendationId, recommendationVersion: recommendation?.version ?? null, evidenceHash: recommendation?.evidenceHash ?? null,
    campaignId: draft.parentCampaignId, deliveryId: base.deliveryId, variable: base.variable, channel: delivery?.channel ?? null, operationId: operation?.id ?? null, operationState: operation?.state ?? null };
  if (!recommendation || !delivery) return { ...dto, eligibility: { allowed: false, reason: 'No se puede verificar la propuesta original.' } };
  const campaign = await get(tx, 'social_campaigns', draft.parentCampaignId);
  const [eligibility] = await socialChangeEligibility(tx, campaign, recommendation, [delivery], { now });
  try {
    const diff = await difference(tx, draft, recommendation, delivery, runtime);
    return { ...dto, before: diff.before, after: diff.after, budget: diff.budget, diffHash: diff.diffHash, unchanged: diff.unchanged,
      eligibility: operation || draft.state !== 'draft' ? { allowed: false, reason: 'La solicitud ya no es un borrador editable.' } : eligibility };
  } catch (error) {
    if (error.status !== 409 && error.status !== 400) throw error;
    return { ...dto, eligibility: { allowed: false, reason: error.message } };
  }
}

export function assertSocialChangeEdit(previous, config, input = {}) {
  if (previous.applicationMode !== 'same') return;
  if (previous.changeOperationId) abort('El cambio está en el journal; primero comprueba su estado.');
  const editable = previous.changeBase.variable === 'caption' ? ['caption'] : previous.changeBase.variable === 'asset' ? ['assetId', 'aiDisclosure'] : [];
  for (const key of COMMERCIAL_FIELDS) if (!editable.includes(key) && Object.hasOwn(input, key) && hash(config[key] ?? null) !== hash(previous[key] ?? null)) abort('Solo puedes editar la variable que se está probando.');
}

export async function handleSocialChangeTx(tx, { recommendation, campaign, action, input, actorId, now, env }) {
  const deliveryId = text(input.deliveryId, 'Entrega', 100, true);
  if (!idPattern.test(deliveryId)) fail('Entrega no válida.');
  const record = await dataOf(tx, 'social_recommendations', recommendation.id), linkedId = record.changeDrafts?.[deliveryId] || null;
  if (action === 'prepare-in-place') {
    const existing = linkedId && await get(tx, 'social_campaigns', linkedId);
    if (existing?.state === 'draft') return { id: existing.id, version: existing.version, state: 'draft' };
    const { revision, effective, eligibility } = await changeContext(tx, campaign, recommendation, deliveryId, now);
    const { spec } = effective, id = newId(), config = {};
    const campaignFields = await dataOf(tx, 'social_campaigns', campaign.id);
    for (const key of COMMERCIAL_FIELDS) if (spec[key] !== undefined) config[key] = spec[key];
    for (const key of ['offerRef', 'offerSnapshot', 'offerHash', 'connectionContext']) if (campaignFields[key] !== undefined) config[key] = campaignFields[key];
    Object.assign(config, { integrationMethod: spec.integrationMethod, identities: spec.identities, timeZone: spec.timeZone, parentCampaignId: campaign.id, applicationMode: 'same', sourceRecommendationId: recommendation.id,
      recommendationInstructions: { ruleKey: recommendation.ruleKey, changeType: recommendation.proposedChange.type, text: recommendation.proposedChange.text },
      changeBase: { deliveryId, revision: revision.revision, approvalHash: revision.specHash, baseSpec: spec, baseHash: effective.specHash, baseOperationId: effective.operationId, variable: eligibility.variable } });
    for (const key of ['name', 'connectionId', 'assetId', 'mode', 'objective']) delete config[key];
    await insertRow(tx, 'social_campaigns', { id, name: campaign.name, connection_id: spec.connectionId, asset_id: spec.assetId, mode: spec.mode, objective: spec.objective, state: 'draft', version: 1, data: JSON.stringify(config), created_at: now, updated_at: now });
    await updateVersioned(tx, 'social_recommendations', recommendation.id, recommendation.version, { data: JSON.stringify({ ...record, changeDrafts: { ...record.changeDrafts, [deliveryId]: id } }) });
    await audit(tx, { entityType: 'social_campaign', entityId: id, actorId, next: { campaignId: campaign.id, deliveryId, recommendationId: recommendation.id }, reason: 'Borrador de cambio exclusivamente local, sin gasto ni publicación.', recordedAt: now });
    return { id, version: 1, state: 'draft' };
  }
  const draftId = text(input.draftId, 'Borrador', 100, true), version = integer(input.draftVersion, 'Versión del borrador', 1, Number.MAX_SAFE_INTEGER);
  if (linkedId !== draftId) abort('El borrador no pertenece a esta propuesta y entrega.');
  const draft = await get(tx, 'social_campaigns', draftId), draftData = await dataOf(tx, 'social_campaigns', draftId);
  if (draft?.applicationMode !== 'same' || draft.state !== 'draft' || draft.version !== version || draft.changeBase.deliveryId !== deliveryId) abort('El borrador cambió; vuelve a revisarlo.');
  if (action === 'cancel-in-place') {
    const pending = draft.changeOperationId && await get(tx, 'social_operations', draft.changeOperationId);
    if (pending && (openSocialOperation(pending) || pending.state === 'confirmed')) abort('Una solicitud enviada o pendiente primero se comprueba en Meta.');
    const changeDrafts = { ...record.changeDrafts }; delete changeDrafts[deliveryId];
    await updateVersioned(tx, 'social_recommendations', recommendation.id, recommendation.version, { data: JSON.stringify({ ...record, changeDrafts }) });
    await updateVersioned(tx, 'social_campaigns', draftId, version, { state: 'cancelled' });
    return { id: draftId, version: version + 1, state: 'cancelled' };
  }
  if (draft.changeOperationId || input.rightsAccepted !== true || input.acknowledged !== true) abort('Confirma los derechos y el alcance exacto o comprueba la solicitud pendiente.');
  const { revision, effective, delivery } = await changeContext(tx, campaign, recommendation, deliveryId, now);
  const base = draft.changeBase;
  if (effective.specHash !== base.baseHash || effective.operationId !== base.baseOperationId || revision.specHash !== base.approvalHash) abort('La versión efectiva ya cambió; cancela y prepara otro borrador.');
  const runtime = await loadSocialRuntime(tx, { env });
  if (!runtime.publishingEnabled || revision.configurationFingerprint !== runtime.fingerprint || restoreHold(draft)) abort('La escritura no está autorizada; reconcilia y revalida la configuración.');
  if (delivery.integrationMethod === 'browser' && !runtime.browserEnabled) abort('El navegador autorizado no está disponible.');
  await assertSocialOfferCurrent(tx, draft);
  const diff = await difference(tx, draft, recommendation, delivery, runtime);
  if (diff.unchanged || diff.diffHash !== input.diffHash) abort('Revisa la diferencia actual; se necesita un cambio real.');
  const id = newId(), step = `amend:${id}`, stage = base.variable === 'asset' ? 'upload' : base.variable === 'caption' && campaign.mode === 'paid' ? 'creative' : 'update';
  const captures = (await tx.db.all(`SELECT id,fetched_at FROM ${tx.t('social_measurements')} WHERE delivery_id=? AND fetched_at<=? ORDER BY fetched_at DESC,id LIMIT 100`, [deliveryId, now]));
  const change = { draftId, draftVersion: version + 1, recommendationId: recommendation.id, recommendationVersion: recommendation.version, deliveryId, revision: base.revision,
    variable: base.variable, baseOperationId: base.baseOperationId, baseHash: base.baseHash, proposedHash: diff.proposedHash, spec: diff.proposed, diffHash: diff.diffHash, remoteId: delivery.remoteId,
    before: diff.before, after: diff.after, criterion: recommendation.successCriterion, budget: diff.budget, evidenceHash: recommendation.evidenceHash, baselineCaptures: captures,
    rightsAccepted: true, acknowledged: true, acceptedAt: now, expiresAt: new Date(Date.parse(now) + 15 * 60000).toISOString(), configurationVersion: runtime.configurationVersion };
  await insertRow(tx, 'social_operations', { id, campaign_id: campaign.id, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:${step}`, step, state: 'prepared', next_attempt_at: now,
    data: JSON.stringify({ integrationMethod: delivery.integrationMethod, configurationFingerprint: runtime.fingerprint, channel: delivery.channel, actorId, specHash: revision.specHash, effectiveSpecHash: base.baseHash, change, progress: { amendStage: stage } }), version: 1, created_at: now, updated_at: now });
  await updateVersioned(tx, 'social_campaigns', draftId, version, { data: JSON.stringify({ ...draftData, changeOperationId: id }) });
  const key = `${delivery.integrationMethod === 'browser' ? 'social:browser' : 'social'}:delivery:${deliveryId}`;
  const running = await tx.db.get(`SELECT state,lease_until FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (running?.state !== 'running' || running.lease_until <= now) await queueJobTx(tx, key, { kind: 'delivery', id: deliveryId, nextRunAt: now }, { now });
  await audit(tx, { entityType: 'social_operation', entityId: id, actorId, next: { step, deliveryId, baseHash: base.baseHash, proposedHash: diff.proposedHash, diffHash: diff.diffHash }, reason: 'Cambio explícito y limitado, pendiente de verificación remota; no autoriza reanudación.', recordedAt: now });
  return { id: draftId, operationId: id, deliveryId, version: version + 1, state: 'prepared' };
}

export async function requireSocialChangeAuthorized(tx, task, runtime, now) {
  const { operation, delivery, revision, campaign, effective, connection } = task, change = operation.change;
  const draft = change && await get(tx, 'social_campaigns', change.draftId), recommendation = change && await get(tx, 'social_recommendations', change.recommendationId);
  if (!change || change.remoteId !== delivery.remoteId || change.deliveryId !== delivery.id || change.revision !== revision.revision || change.baseHash !== effective.specHash || change.baseOperationId !== effective.operationId || !change.spec || hash(change.spec) !== change.proposedHash ||
    change.rightsAccepted !== true || change.acknowledged !== true || !change.expiresAt || instant(change.expiresAt) <= now || change.configurationVersion !== runtime.configurationVersion || operation.configurationFingerprint !== runtime.fingerprint ||
    !runtime.publishingEnabled || restoreHold(campaign) || restoreHold(draft) || restoreHold(connection) || connection.revalidationRequired || connection.disconnectPending ||
    draft?.version !== change.draftVersion || draft.changeOperationId !== operation.id || recommendation?.version !== change.recommendationVersion || recommendation.state !== 'suggested' || recommendation.campaignId !== campaign.id || recommendation.evidenceHash !== change.evidenceHash ||
    change.spec.aiDisclosure !== false || change.spec.mode === 'paid' && (!['paused', 'ready'].includes(delivery.state) || change.spec.endAt <= now) || change.spec.mode === 'organic' && delivery.state !== 'published') abort('La autorización o la versión efectiva del cambio ya no es válida.');
  await assertFreshSocialRecommendation(tx, recommendation, change.evidenceHash, now);
  await assertSocialOfferCurrent(tx, draft);
  const asset = await get(tx, 'social_assets', change.spec.assetId);
  if (asset?.state !== 'ready' || asset.sha256 !== change.spec.assetHash || asset.derivativeSha256 !== change.spec.assetHash) abort('La pieza del cambio no coincide con los bytes revisados.');
  return asset;
}

export async function confirmSocialChangeEffect(tx, task, result, now) {
  const { operation, delivery } = task, change = operation.change;
  if (!isContentChange(operation) || result.status !== 'confirmed' || !result.operationComplete || result.evidence.remoteRead !== true || result.evidence.specVerified !== true || result.remoteRefs.remoteId !== delivery.remoteId || change.baseOperationId !== task.effective.operationId) abort('El efecto remoto no está acreditado.');
  const recommendation = await get(tx, 'social_recommendations', change.recommendationId), data = await dataOf(tx, 'social_recommendations', change.recommendationId);
  if (recommendation?.state !== 'suggested' || recommendation.version !== change.recommendationVersion || recommendation.evidenceHash !== change.evidenceHash) abort('La recomendación no coincide con el cambio enviado; hay que reconciliar.');
  const transition = { from: operation.sentAt, through: now }, trial = { applicationMode: 'same', deliveryId: delivery.id, channel: delivery.channel,
    operationId: operation.id, draftId: change.draftId, baseOperationId: change.baseOperationId, transition, before: change.before, after: change.after, criterion: change.criterion,
    objective: change.spec.objective, mode: change.spec.mode, offerHash: change.spec.offerHash || null,
    platforms: change.spec.mode === 'paid' ? change.spec.targeting?.publisher_platforms || change.spec.platforms : [delivery.channel],
    expectedAt: change.spec.mode === 'paid' ? new Date(Math.min(Date.parse(change.spec.endAt) + 48 * 3600000, Date.parse(now) + 8 * 86400000)).toISOString() : now };
  const evaluation = change.spec.mode === 'organic' ? { complete: true, conclusion: 'inconclusive', reasons: ['lifetime_cannot_isolate_change'], metricIds: [], asOf: now } : null;
  await updateVersioned(tx, 'social_recommendations', recommendation.id, recommendation.version, { state: 'applied', data: JSON.stringify({ ...data, appliedAt: now, appliedBy: operation.actorId, trial, ...(evaluation ? { evaluation, conclusion: evaluation.conclusion } : {}) }) });
  await queueSocialAnalysisTx(tx, delivery.campaignId, { now, requestedBy: 'scheduler' });
  return { effectiveContentOperationId: operation.id, effectiveAssetId: change.spec.assetId, creativeName: ['asset', 'caption'].includes(change.variable) && change.spec.mode === 'paid' ? `social:${operation.id}:change-creative` : task.effective.creativeName, contentTransition: transition, lastContentChangedAt: now };
}
