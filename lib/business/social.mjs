import { fail, integer, text } from '../validation-core.mjs';
import { entity, hash, newId, stamp, insertRow, updateVersioned, runCommand, audit, assertLease } from './commands.mjs';
import { integrationRequirements, requireIntegration, socialConfig } from '../social/config.mjs';
import { schedulerHealth, queueJobTx } from './job-leases.mjs';
import { SOCIAL_ASSET_INTERNAL_FIELDS } from '../social/evidence.mjs';
import { SOCIAL_OBJECTIVE_CONFIG, normalizeSocialCampaignInput, buildSocialSpec, buildSocialDraftSpec, verifySocialApiTargeting } from './social-spec.mjs';
import { aggregateSocialCampaignState, queueSocialBrowserJobTx } from './social-jobs.mjs';
import { openSocialAssetContent } from './social-media.mjs';
import { decryptCredentials } from '../social/credentials.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { instant } from './dates.mjs';
import { queueSocialApiJobTx } from './social-api-jobs.mjs';
import { socialAccountNotBefore } from './social-schedule.mjs';
import { socialPermalink } from '../social/evidence.mjs';
import { withBrowserSession } from './social-browser.mjs';
import { queueSocialAnalysisTx } from './social-analysis-queue.mjs';
import { socialConnectionDTO } from './social-connections.mjs';

export const SOCIAL_CAMPAIGN_STATES = Object.freeze(['draft', 'ready', 'scheduled', 'publishing', 'partial', 'published', 'in_review', 'active', 'paused', 'completed', 'failed', 'needs_attention', 'cancelled']);
export const SOCIAL_OBJECTIVES = Object.freeze(Object.keys(SOCIAL_OBJECTIVE_CONFIG));
export async function getSocialConnection(store, id) {
  const connection = entity(await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id=?`, [text(id, 'Conexión', 100, true)]));
  if (!connection) fail('Conexión no encontrada.', 404);
  return connection;
}
export async function listSocialConnections(store, { now = new Date().toISOString(), env = process.env } = {}) {
  const connections = (await store.db.all(`SELECT * FROM ${store.t('social_connections')} ORDER BY created_at,id`)).map(entity);
  const heartbeat = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key='scheduler:social-browser:heartbeat'`);
  const deletionReceipts = (await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='social_deletion_receipt' ORDER BY recorded_at DESC,id LIMIT 20`)).map(row => rawData(row).next).filter(Boolean);
  return { connections, deletionReceipts, requirements: ['api', 'browser'].map(method => integrationRequirements(method, env)), browserWorker: schedulerHealth(heartbeat, now) };
}
export async function listSocialCampaigns(store, query = {}) {
  const page = integer(Number(query.page || 1), 'Página', 1, 1000000), filters = [], values = [];
  for (const [field, allowed] of [['mode', ['organic', 'paid']], ['objective', SOCIAL_OBJECTIVES], ['status', SOCIAL_CAMPAIGN_STATES]]) {
    if (!query[field]) continue;
    if (!allowed.includes(query[field])) fail(`Filtro ${field} no válido.`);
    filters.push(`${field === 'status' ? 'state' : field}=?`); values.push(query[field]);
  }
  if (query.q) { filters.push('LOWER(name) LIKE ?'); values.push(`%${text(query.q, 'Búsqueda', 200).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`); filters[filters.length - 1] += " ESCAPE '\\'"; }
  if (query.network) {
    if (!['facebook', 'instagram'].includes(query.network)) fail('Red no válida.');
    // Both engines support their own explicit JSON expression; the client never supplies SQL.
    filters.push(store.provider === 'sqlite'
      ? "EXISTS (SELECT 1 FROM json_each(social_campaigns.data,'$.platforms') WHERE value=?)"
      : "EXISTS (SELECT 1 FROM json_array_elements_text(social_campaigns.data::json->'platforms') AS network(value) WHERE value=?)");
    values.push(query.network);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const count = Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_campaigns')} ${where}`, values)).n);
  const campaigns = (await store.db.all(`SELECT * FROM ${store.t('social_campaigns')} ${where} ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?`, [...values, (page - 1) * 20])).map(entity);
  const summaries = new Map();
  if (campaigns.length) {
    const field = name => store.provider === 'sqlite' ? `json_extract(m.data,'$.${name}')` : `m.data::jsonb->>'${name}'`;
    const window = store.provider === 'sqlite' ? "json_extract(m.data,'$.query.window')" : "m.data::jsonb#>>'{query,window}'";
    const complete = store.provider === 'sqlite' ? "json_extract(m.data,'$.coverage.complete')=1" : "m.data::jsonb#>>'{coverage,complete}'='true'";
    const measured = await store.db.all(`SELECT * FROM (SELECT m.*,d.campaign_id AS measured_campaign_id,ROW_NUMBER() OVER (PARTITION BY d.campaign_id ORDER BY CASE WHEN ${complete} THEN 0 ELSE 1 END,m.fetched_at DESC,m.id DESC) AS metric_rank,MAX(m.fetched_at) OVER (PARTITION BY d.campaign_id) AS latest_fetched_at FROM ${store.t('social_measurements')} m JOIN ${store.t('social_deliveries')} d ON d.id=m.delivery_id WHERE d.campaign_id IN (${campaigns.map(() => '?').join(',')}) AND d.channel='meta_ads' AND ${field('dimension')}='aggregate' AND ${field('scope')}='paid' AND ${window}='cumulative') measured WHERE metric_rank=1`, campaigns.map(value => value.id));
    for (const row of measured) {
      const data = JSON.parse(row.data), newerPartial = row.latest_fetched_at > row.fetched_at;
      summaries.set(row.measured_campaign_id, { spendMinor: data.values?.spendMinor || null, currency: data.currency || null, scope: data.scope, complete: data.coverage?.complete === true && !newerPartial, fetchedAt: row.fetched_at, definitionVersion: data.definitionVersion || null, integrationMethod: data.integrationMethod, newerPartial });
    }
  }
  for (const campaign of campaigns) {
    campaign.deliveries = (await store.db.all(`SELECT id,channel,state,remote_id,next_sync_at,data,version,updated_at FROM ${store.t('social_deliveries')} WHERE campaign_id=? ORDER BY channel`, [campaign.id])).map(entity);
    campaign.integrationMethod = campaign.connectionId ? (await getSocialConnection(store, campaign.connectionId)).integrationMethod : null;
    campaign.lastMeasurementSummary = summaries.get(campaign.id) || null;
  }
  return { campaigns, page, pageSize: 20, total: count, pages: Math.max(1, Math.ceil(count / 20)) };
}
export async function getSocialCampaign(store, id) {
  const campaign = entity(await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [text(id, 'Campaña', 100, true)]));
  if (!campaign) fail('Campaña no encontrada.', 404);
  const [revisions, deliveries, operations, forecasts, recommendations] = await Promise.all([
    store.db.all(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? ORDER BY revision`, [id]),
    store.db.all(`SELECT * FROM ${store.t('social_deliveries')} WHERE campaign_id=? ORDER BY channel`, [id]),
    store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE campaign_id=? ORDER BY created_at,id`, [id]),
    store.db.all(`SELECT * FROM ${store.t('social_forecasts')} WHERE campaign_id=? ORDER BY generated_at DESC,id`, [id]),
    store.db.all(`SELECT * FROM ${store.t('social_recommendations')} WHERE campaign_id=? ORDER BY created_at,id`, [id])
  ]);
  const asset = campaign.assetId ? entity(await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [campaign.assetId])) : null;
  if (asset) for (const key of SOCIAL_ASSET_INTERNAL_FIELDS) delete asset[key];
  const connection = campaign.connectionId ? await getSocialConnection(store, campaign.connectionId) : null;
  const validation = { valid: false, specHash: null, draftSpecHash: null, warnings: [], errors: [] };
  try {
    validation.draftSpecHash = buildSocialDraftSpec(campaign, { connection, asset }).specHash;
    const built = buildSocialSpec(campaign, { connection, asset, now: stamp() });
    Object.assign(validation, { valid: true, specHash: built.specHash, warnings: built.warnings });
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    validation.errors.push(error.message);
  }
  return { ...campaign, connection: connection ? socialConnectionDTO(connection) : null, asset, validation,
    revisions: revisions.map(entity), deliveries: deliveries.map(entity), operations: operations.map(row => operationDTO(entity(row))), forecasts: forecasts.map(entity), recommendations: recommendations.map(entity) };
}

const CONFIG_COLUMNS = ['name', 'connectionId', 'assetId', 'mode', 'objective'];
const DERIVED_FIELDS = ['identities', 'connectionContext'];
const IDENTITY_KEYS = ['userId', 'businessId', 'pageId', 'instagramId', 'adAccountId'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rawData = row => JSON.parse(row?.data || '{}');
function identifier(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label}: identificador no válido.`);
  return value;
}
function objectInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail('Datos de campaña no válidos.');
  return input;
}
function commandRequest(input) {
  objectInput(input);
  const requestId = text(input.requestId, 'Identificador de operación', 100, true);
  if (!/^[\w:-]{8,100}$/.test(requestId)) fail('Identificador de operación no válido.');
  return requestId;
}
async function requireActor(store, actorId) {
  actorId = text(actorId, 'Administrador', 100, true);
  if (!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador debe estar activo para realizar esta acción.', 403);
}
// Active actors are checked under the same write lock even on idempotent replays.
function actorCommands(store, actorId) {
  return { transaction: fn => store.transaction(async tx => {
    await tx.lockWrites();
    await requireActor(tx, actorId);
    return fn(tx);
  }) };
}
function expectVersion(campaign, version) {
  integer(version, 'Versión', 1, Number.MAX_SAFE_INTEGER);
  if (campaign.version !== version) fail('La campaña cambió en otra sesión. Recarga antes de continuar.', 409);
}
async function campaignRow(store, id) {
  const row = await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [id]);
  if (!row) fail('Campaña no encontrada.', 404);
  return row;
}
async function selectedAsset(store, id) {
  if (!id) return null;
  const asset = entity(await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [identifier(id, 'Pieza')]));
  if (!asset) fail('Pieza no encontrada.', 404);
  return asset;
}
function campaignFields(config) {
  const data = { ...config };
  for (const key of CONFIG_COLUMNS) delete data[key];
  return { name: config.name, connection_id: config.connectionId, asset_id: config.assetId, mode: config.mode, objective: config.objective, data: JSON.stringify(data) };
}
function resultOf(campaign, extra = {}) { return { id: campaign.id, version: campaign.version, state: campaign.state, ...extra }; }
async function cancelJobTx(tx, key, now) {
  const job = await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (!job) return;
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL,finished_at=?,error_code=NULL,data=?,version=version+1,updated_at=? WHERE key=?`, [now, JSON.stringify({ ...rawData(job), cancelledAt: now }), now, key]);
}
async function retirePreparedTx(tx, operations, now) {
  for (const operation of operations) {
    if (!['prepared', 'retry_wait'].includes(operation.state)) continue;
    await updateVersioned(tx, 'social_operations', operation.id, operation.version, {
      state: 'failed', next_attempt_at: null,
      data: JSON.stringify({ ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id])), cancelledAt: now })
    });
    if (!operation.deliveryId) await cancelJobTx(tx, `social:browser:preflight:${operation.id}`, now);
  }
}
async function campaignOperations(store, id) {
  return (await store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE campaign_id=? ORDER BY created_at,id`, [id])).map(entity);
}

export async function saveSocialCampaign(store, input, actorId, { env = process.env, now = stamp() } = {}) {
  const requestId = commandRequest(input);
  now = instant(now);
  const id = input.id == null ? null : identifier(input.id, 'Campaña');
  if (id) integer(input.version, 'Versión', 1, Number.MAX_SAFE_INTEGER);
  else if (input.version != null && input.version !== 0) fail('Una campaña nueva no tiene una versión previa.');
  const configuration = { ...input };
  for (const key of ['id', 'version', 'requestId']) delete configuration[key];
  // Derived identities/context are never accepted from a request.
  for (const key of DERIVED_FIELDS) if (Object.hasOwn(configuration, key)) fail(`No se puede aportar ${key} desde el cliente.`);
  return runCommand(actorCommands(store, actorId), {
    scope: id ? `social:campaign:save:${id}` : 'social:campaign:create', requestId, payload: input, actorId, affectsIndicators: false
  }, async tx => {
    const previousRow = id ? await campaignRow(tx, id) : null, previous = entity(previousRow);
    if (previous) {
      expectVersion(previous, input.version);
      if (previous.state !== 'draft') fail('Una campaña aprobada está congelada. Duplícala para corregir su configuración.', 409);
    }
    const connectionId = Object.hasOwn(configuration, 'connectionId') ? configuration.connectionId : previous?.connectionId;
    const assetId = Object.hasOwn(configuration, 'assetId') ? configuration.assetId : previous?.assetId;
    const connection = connectionId ? await getSocialConnection(tx, identifier(connectionId, 'Conexión')) : null;
    await selectedAsset(tx, assetId);
    const config = normalizeSocialCampaignInput(configuration, { previous, connection });
    text(config.name, 'Nombre', 200, true);
    const operations = previous ? await campaignOperations(tx, id) : [];
    if (operations.some(operation => ['sent', 'uncertain'].includes(operation.state))) fail('Resuelve la preparación remota incierta antes de editar el borrador.', 409);
    await retirePreparedTx(tx, operations, now);
    const key = id || newId(), fields = campaignFields(config), data = JSON.parse(fields.data);
    // Keep the recoverable private draft on the same account, never its approval,
    // observed configuration, forecast, or previously validated media.
    for (const field of ['parentCampaignId', 'sourceRecommendationId', 'recommendationInstructions', 'restore_hold', 'restoreHold']) if (previous?.[field] !== undefined) data[field] = previous[field];
    if (previous?.connectionContext === config.connectionContext && config.integrationMethod === 'browser' && /^\d{1,30}$/.test(previous.preflight?.remoteDraftRef || '')) {
      data.preflight = { remoteDraftRef: previous.preflight.remoteDraftRef, adapterVersion: 'meta-ui-v2', ...(previous.preflight.privateDraftAuthorization ? { privateDraftAuthorization: previous.preflight.privateDraftAuthorization } : {}) };
    }
    fields.data = JSON.stringify(data);
    if (previous) await updateVersioned(tx, 'social_campaigns', key, previous.version, fields);
    else await insertRow(tx, 'social_campaigns', { id: key, ...fields, state: 'draft', version: 1, created_at: now, updated_at: now });
    const next = entity(await campaignRow(tx, key));
    await audit(tx, { entityType: 'social_campaign', entityId: key, actorId, previous, next, reason: previous ? 'Edición de borrador; preparación y previsión invalidadas.' : 'Borrador creado.', recordedAt: now });
    return resultOf(next);
  });
}

function assertApprovalInput(input, built, mode) {
  if (input.rightsAccepted !== true) fail('Confirma los derechos sobre la pieza y su audio.');
  if (input.specHash !== built.specHash) fail('La confirmación no corresponde a la especificación actual.', 409);
  if (!Array.isArray(input.acceptedWarnings) || input.acceptedWarnings.some(key => typeof key !== 'string')) fail('Confirma explícitamente las advertencias del resumen.');
  const required = built.warnings.map(warning => warning.key).sort(), accepted = [...new Set(input.acceptedWarnings)].sort();
  if (hash(required) !== hash(accepted)) fail('Las advertencias aceptadas no corresponden al resumen actual.', 409);
  if (mode === 'paid' && input.investmentAccepted !== true) fail('Confirma el importe total, moneda y fechas mostrados. Esta preparación no autoriza activar gasto.');
  return accepted;
}
async function approvalForecast(store, campaignId, input, built) {
  const id = identifier(input.forecastId, 'Previsión');
  const row = await store.db.get(`SELECT * FROM ${store.t('social_forecasts')} WHERE id=?`, [id]);
  if (!row) fail('Previsión no encontrada.', 404);
  const forecast = rawData(row);
  if (row.campaign_id !== campaignId || row.spec_hash !== built.specHash || forecast.specHash !== built.specHash) fail('La previsión no corresponde a esta campaña y especificación.', 409);
  return { id, forecast, row };
}
function requirePublishing(method, env) {
  requireIntegration(method, env);
  if (!socialConfig(env).publishingEnabled) fail('La publicación social está deshabilitada en este despliegue.', 409);
}
function matchingIdentities(expected, actual) {
  return IDENTITY_KEYS.every(key => (expected?.[key] || null) === (actual?.[key] || null));
}
function assertLiveConnection(spec, validated) {
  if (validated?.state !== 'connected' || !matchingIdentities(spec.identities, validated.identities)) fail('La cuenta remota no coincide con la aprobación. Revalida la conexión.', 409);
  const capabilities = validated.capabilities || {};
  if (spec.mode === 'paid') {
    if (capabilities.adsPublish !== true || spec.objective === 'whatsapp' && capabilities.whatsappAds !== true) fail('La cuenta ya no permite el objetivo publicitario seleccionado.', 409);
    if (validated.currency !== spec.currency || validated.timeZone !== spec.timeZone) fail('La moneda o zona remota cambiaron. Revalida y guarda el borrador.', 409);
    if (spec.objective === 'whatsapp' && validated.resources?.pages?.find(page => page.id === spec.identities.pageId)?.whatsappNumber !== spec.whatsappNumber) fail('Cambió el número de WhatsApp vinculado a la página. Revalida la conexión y el borrador.', 409);
  } else if (spec.platforms.some(platform => capabilities[platform === 'facebook' ? 'facebookPublish' : 'instagramPublish'] !== true)) fail('La cuenta ya no permite publicar en todas las redes seleccionadas.', 409);
}
async function browserPreparation(store, campaign, built) {
  const operations = await campaignOperations(store, campaign.id);
  if (operations.some(operation => ['sent', 'uncertain'].includes(operation.state) || ['prepared', 'retry_wait'].includes(operation.state))) fail('La preparación privada tiene trabajo pendiente o incierto; resuélvelo antes de aprobar.', 409);
  const preflight = campaign.preflight;
  const operation = operations.find(value => value.id === preflight?.operationId);
  if (operations.some(value => value.id !== operation?.id && value.step === 'validate' && value.campaignVersion >= campaign.version)) fail('Una validación posterior no quedó confirmada. Revalida el borrador antes de aprobar.', 409);
  const evidence = preflight?.mediaEvidence, refs = preflight?.preparedRefs;
  if (preflight?.kind !== 'validate' || preflight.adapterVersion !== 'meta-ui-v2' || preflight.specHash !== built.specHash || !operation || operation.deliveryId || operation.step !== 'validate' || operation.state !== 'confirmed' ||
      !preflight.privateDraftAuthorization?.actorId || operation.acceptPrivateDraft !== true || hash(operation.privateDraftAuthorization || null) !== hash(preflight.privateDraftAuthorization) ||
      operation.campaignVersion !== campaign.version - 1 || operation.specHash !== built.specHash || !operation.spec || hash(operation.spec) !== built.specHash || operation.result?.status !== 'confirmed' ||
      !/^\d{1,30}$/.test(preflight.remoteDraftRef || '') || refs?.remoteDraftRef !== preflight.remoteDraftRef || operation.remoteDraftRef !== preflight.remoteDraftRef ||
      operation.result.remoteRefs?.remoteDraftRef !== preflight.remoteDraftRef || !preflight.observedSpec || !operation.result.observedSpec ||
      !evidence || evidence.scope !== preflight.remoteDraftRef || evidence.sha256 !== built.spec.assetHash ||
      !/^\d{1,30}$/.test(evidence.remoteMediaId || '') || typeof evidence.name !== 'string' || !evidence.name || evidence.name.length > 200 ||
      hash(operation.result.evidence?.mediaEvidence || null) !== hash(evidence) || hash(operation.result.observedSpec) !== hash(preflight.observedSpec) ||
      hash(operation.result.preparedRefs || null) !== hash(refs)) fail('Falta una validación privada confirmada, inequívoca y vigente para esta versión y pieza.', 409);
  return { remoteDraftRef: preflight.remoteDraftRef, preparedRefs: controlProofRefs(refs), mediaEvidence: { scope: evidence.scope, name: evidence.name, sha256: evidence.sha256, remoteMediaId: evidence.remoteMediaId } };
}
async function approvalSnapshot(tx, id, action, input, env, now) {
  const campaign = entity(await campaignRow(tx, id));
  expectVersion(campaign, input.version);
  if (campaign.state !== 'draft') fail('La campaña ya está aprobada o no es un borrador editable.', 409);
  if (campaign.mode !== (action === 'prepare-paid' ? 'paid' : 'organic')) fail('La acción no corresponde a la modalidad de la campaña.', 409);
  const connection = campaign.connectionId ? await getSocialConnection(tx, campaign.connectionId) : null;
  if (campaign.restore_hold || campaign.restoreHold || connection?.restore_hold || connection?.restoreHold) fail('La campaña restaurada requiere reconciliación antes de aprobar.', 409);
  const asset = await selectedAsset(tx, campaign.assetId);
  const built = buildSocialSpec(campaign, { connection, asset, now });
  await assertRecommendationApproval(tx, campaign, built.spec, input);
  requirePublishing(connection.integrationMethod, env);
  const acceptedWarnings = assertApprovalInput(input, built, campaign.mode);
  const forecast = await approvalForecast(tx, campaign.id, input, built);
  const preparation = campaign.mode === 'paid' && connection.integrationMethod === 'browser' ? await browserPreparation(tx, campaign, built) : null;
  const credentialRow = await tx.db.get(`SELECT * FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  if (!credentialRow) fail('La conexión necesita autenticación vigente.', 409);
  return { campaign, connection, asset, built, acceptedWarnings, forecast, preparation, credentialRow };
}

async function commitApproval(tx, snapshot, input, action, actorId, env, now) {
  const current = await approvalSnapshot(tx, snapshot.campaign.id, action, input, env, now);
  if (current.connection.version !== snapshot.connection.version || current.asset.version !== snapshot.asset.version ||
      current.credentialRow.version !== snapshot.credentialRow.version || current.built.specHash !== snapshot.built.specHash ||
      current.forecast.row.data !== snapshot.forecast.row.data || current.forecast.row.generated_at !== snapshot.forecast.row.generated_at ||
      hash(current.preparation) !== hash(snapshot.preparation)) fail('La cuenta, pieza o evidencia cambió durante la comprobación. Recarga y confirma de nuevo.', 409);
  const { campaign, connection, built, forecast, acceptedWarnings, preparation } = current, spec = built.spec;
  if (await tx.db.get(`SELECT revision FROM ${tx.t('social_revisions')} WHERE campaign_id=? LIMIT 1`, [campaign.id])) fail('Esta campaña ya tiene una aprobación inmutable. Duplícala para volver a aprobar.', 409);
  const revision = 1, data = {
    spec, forecastId: forecast.id, forecast: forecast.forecast, acceptedWarnings, rightsAccepted: true,
    ...(campaign.sourceRecommendationId ? { sourceRecommendationId: campaign.sourceRecommendationId, recommendationAccepted: true } : {}),
    ...(campaign.mode === 'paid' ? { budgetConfirmation: { investmentAccepted: true, budgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt } } : {})
  };
  await insertRow(tx, 'social_revisions', { campaign_id: campaign.id, revision, spec_hash: built.specHash, approved_at: now, actor_id: actorId, data: JSON.stringify(data) });
  const deliveries = [], operationIds = [];
  const nextRunAt = campaign.mode === 'organic' ? spec.publishAt || now : now;
  for (const channel of campaign.mode === 'paid' ? ['meta_ads'] : spec.platforms) {
    const id = newId(), state = campaign.mode === 'organic' && nextRunAt > now ? 'scheduled' : 'queued';
    const deliveryData = { integrationMethod: connection.integrationMethod, specHash: built.specHash, identities: spec.identities, ...(preparation ? { remoteRefs: { ...preparation.preparedRefs, remoteDraftRef: preparation.remoteDraftRef }, preparedRefs: preparation.preparedRefs, mediaEvidence: preparation.mediaEvidence } : {}) };
    await insertRow(tx, 'social_deliveries', { id, campaign_id: campaign.id, revision, channel, state, remote_id: null, next_sync_at: null, data: JSON.stringify(deliveryData), version: 1, created_at: now, updated_at: now });
    if (connection.integrationMethod === 'browser') {
      const operationId = newId(), step = campaign.mode === 'paid' ? 'prepare-paid' : 'publish';
      await insertRow(tx, 'social_operations', { id: operationId, campaign_id: campaign.id, delivery_id: id, operation_key: `delivery:${id}:${step}`, step, state: 'prepared', next_attempt_at: nextRunAt, data: JSON.stringify({ integrationMethod: 'browser', actorId, specHash: built.specHash, channel, ...(preparation || {}) }), version: 1, created_at: now, updated_at: now });
      operationIds.push(operationId);
      await queueSocialBrowserJobTx(tx, { kind: 'delivery', id, nextRunAt }, { now });
    } else await queueJobTx(tx, `social:delivery:${id}`, { kind: 'delivery', id, nextRunAt }, { now });
    deliveries.push({ id, channel, state });
  }
  const state = campaign.mode === 'organic' && nextRunAt > now ? 'scheduled' : 'publishing';
  const campaignData = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaign.id]));
  await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state, data: JSON.stringify({ ...campaignData, forecastId: forecast.id }) });
  const next = entity(await campaignRow(tx, campaign.id));
  await audit(tx, { entityType: 'social_campaign', entityId: campaign.id, actorId, previous: { state: campaign.state, version: campaign.version }, next: { state, revision, specHash: built.specHash, deliveryIds: deliveries.map(value => value.id) }, reason: campaign.mode === 'paid' ? 'Inversión exacta confirmada para preparación sin activación ni gasto.' : 'Publicación orgánica aprobada.', recordedAt: now });
  return resultOf(next, { revision, specHash: built.specHash, deliveryIds: deliveries.map(value => value.id), operationIds, deliveries });
}

async function duplicateCampaign(tx, campaign, actorId, now, recommendation = null) {
  const connection = campaign.connectionId ? await getSocialConnection(tx, campaign.connectionId) : null;
  // Project only the canonical configuration, never flatten remote evidence,
  // revision acceptance, jobs or business links into a new draft.
  const configuration = {};
  for (const key of ['name', 'connectionId', 'assetId', 'mode', 'objective', 'platforms', 'caption', 'headline', 'destinationUrl', 'whatsappNumber', 'whatsappGreeting', 'audience', 'placements', 'budgetMinor', 'currency', 'observationDays', 'targetCostMinor', 'aiDisclosure']) if (campaign[key] !== undefined) configuration[key] = campaign[key];
  const change = recommendation?.proposedChange;
  if (change?.type === 'copy') configuration.caption = '';
  if (change?.type === 'creative') configuration.assetId = null;
  if (change?.type === 'placement') {
    if (!['facebook_feed', 'facebook_reels', 'instagram_feed', 'instagram_reels'].includes(change.placement)) fail('La ubicación propuesta ya no es compatible.', 409);
    configuration.placements = [change.placement]; configuration.platforms = [change.placement.startsWith('facebook_') ? 'facebook' : 'instagram'];
  }
  const config = normalizeSocialCampaignInput({ ...configuration, publishAt: null, startAt: null, endAt: null }, { previous: campaign, connection });
  const fields = campaignFields(config), data = JSON.parse(fields.data), id = newId();
  data.parentCampaignId = campaign.id;
  if (recommendation) {
    data.sourceRecommendationId = recommendation.id;
    data.recommendationInstructions = { ruleKey: recommendation.ruleKey, text: change.text, changeType: change.type, needsConfirmation: true,
      ...(change.placement ? { proposedPlacement: change.placement } : {}), ...(change.postingWindow ? { postingWindow: change.postingWindow } : {}) };
  }
  await insertRow(tx, 'social_campaigns', { id, ...fields, data: JSON.stringify(data), state: 'draft', version: 1, created_at: now, updated_at: now });
  const next = entity(await campaignRow(tx, id));
  await audit(tx, { entityType: 'social_campaign', entityId: id, actorId, next, reason: 'Duplicación explícita sin fechas, previsión, aceptación ni referencias remotas.', recordedAt: now });
  return resultOf(next);
}
async function cancelCampaign(tx, campaign, actorId, now) {
  if (campaign.state === 'cancelled') fail('La campaña ya está cancelada.', 409);
  if (!campaign.connectionId || !campaign.assetId) fail('El borrador incompleto no tiene una publicación local que cancelar.', 409);
  const deliveries = (await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')} WHERE campaign_id=? ORDER BY id`, [campaign.id])).map(entity);
  const operations = await campaignOperations(tx, campaign.id);
  if (operations.some(operation => ['sent', 'uncertain'].includes(operation.state)) || deliveries.some(delivery => delivery.state === 'uncertain')) fail('Resuelve primero el efecto enviado o incierto. Cancelar localmente no lo deshace en Meta.', 409);
  const pending = deliveries.filter(delivery => !delivery.remoteId && ['queued', 'preparing', 'ready', 'scheduled', 'blocked', 'failed'].includes(delivery.state));
  if (deliveries.length && !pending.length) fail('No hay trabajo local no enviado que cancelar; el contenido publicado no se borra.', 409);
  const ids = new Set(pending.map(delivery => delivery.id));
  if (operations.some(operation => ids.has(operation.deliveryId) && operation.state === 'confirmed' && (operation.step === 'publish' || /^(activate|resume):/.test(operation.step)))) fail('La publicación pudo confirmarse; reconcilia antes de cancelar.', 409);
  await retirePreparedTx(tx, operations.filter(operation => !operation.deliveryId || ids.has(operation.deliveryId)), now);
  for (const delivery of pending) {
    await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state: 'cancelled', next_sync_at: null });
    for (const key of [`social:delivery:${delivery.id}`, `social:sync:${delivery.id}`, `social:browser:delivery:${delivery.id}`, `social:browser:sync:${delivery.id}`]) await cancelJobTx(tx, key, now);
  }
  for (const operation of operations.filter(operation => !operation.deliveryId)) await cancelJobTx(tx, `social:browser:preflight:${operation.id}`, now);
  const states = deliveries.map(delivery => ids.has(delivery.id) ? { state: 'cancelled' } : delivery);
  const state = aggregateSocialCampaignState(states, campaign.mode) || 'cancelled';
  await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state });
  const next = entity(await campaignRow(tx, campaign.id));
  await audit(tx, { entityType: 'social_campaign', entityId: campaign.id, actorId, previous: { state: campaign.state }, next: { state, cancelledDeliveryIds: [...ids] }, reason: 'Trabajo local pendiente cancelado; publicaciones y evidencia conservadas. No se modificó ningún objeto en Meta.', recordedAt: now });
  return resultOf(next, { deliveryIds: [...ids] });
}

export async function socialCampaignAction(store, id, action, input, actorId, { env = process.env, now = stamp(), transport = {} } = {}) {
  id = identifier(id, 'Campaña');
  const requestId = commandRequest(input);
  integer(input.version, 'Versión', 1, Number.MAX_SAFE_INTEGER);
  now = instant(now);
  const actionFields = {
    'approve-organic': ['rightsAccepted', 'acceptedWarnings', 'specHash', 'forecastId', 'investmentAccepted', 'recommendationAccepted'],
    'prepare-paid': ['rightsAccepted', 'acceptedWarnings', 'specHash', 'forecastId', 'investmentAccepted', 'recommendationAccepted'],
    duplicate: [], cancel: ['reason'], pause: ['reason'],
    'activate-paid': ['specHash', 'preparedRefs', 'investmentAccepted', 'remainingBudgetMinor'],
    resume: ['specHash', 'preparedRefs', 'investmentAccepted', 'remainingBudgetMinor'],
    reconcile: ['deliveryId'], sync: ['deliveryId'], analyze: ['asOf'],
    'link-remote': ['deliveryId', 'operationId', 'specHash', 'remoteId', 'permalink', 'acceptContentVerification', 'reason'],
    'confirm-absent': ['deliveryId', 'operationId', 'specHash', 'confirmAbsence', 'acceptDuplicateRisk', 'reason'],
    'resume-restored': ['specHash', 'rightsAccepted', 'acceptedWarnings', 'investmentAccepted', 'remainingBudgetMinor', 'acceptDuplicateRisk', 'acceptPrivateDraft']
  };
  if (!Object.hasOwn(actionFields, action)) fail('Acción de campaña no válida.');
  const allowed = new Set(['version', 'requestId', ...actionFields[action]]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Campo de acción no permitido: ${key}.`);
  const command = { scope: `social:campaign:${action}:${id}`, requestId, payload: { id, action, input }, actorId, affectsIndicators: false };
  if (action === 'analyze') return runCommand(actorCommands(store, actorId), command, async tx => {
    const campaign = entity(await campaignRow(tx, id)); expectVersion(campaign, input.version);
    if (!await tx.db.get(`SELECT campaign_id FROM ${tx.t('social_revisions')} WHERE campaign_id=? LIMIT 1`, [id])) fail('Aprueba una propuesta antes de analizar sus resultados.', 409);
    const analysisJob = await queueSocialAnalysisTx(tx, id, { now, asOf: input.asOf ? instant(input.asOf) : now, requestedBy: actorId });
    const job = await tx.db.get(`SELECT state FROM ${tx.t('job_runs')} WHERE key=?`, [analysisJob.key]);
    return resultOf(campaign, { requestedState: 'analyzing', analysisJob: { ...analysisJob, state: job.state } });
  });
  if (!['approve-organic', 'prepare-paid', 'duplicate'].includes(action)) {
    return controlCampaignAction(store, { id, action, input, actorId, command, env, now, transport });
  }
  let snapshot = null;
  if (['approve-organic', 'prepare-paid'].includes(action)) {
    const read = await store.transaction(async tx => {
      await tx.lockWrites(); await requireActor(tx, actorId);
      const prior = await tx.db.get(`SELECT * FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [command.scope, requestId]);
      if (prior) {
        if (prior.actor_id !== actorId || prior.payload_hash !== hash(command.payload)) fail('La operación ya se recibió con otro administrador o datos distintos.', 409);
        return { replay: JSON.parse(prior.result_json) };
      }
      return { snapshot: await approvalSnapshot(tx, id, action, input, env, now) };
    });
    if (read.replay) return read.replay;
    snapshot = read.snapshot;
    const file = await openSocialAssetContent(store, snapshot.asset.id, { env });
    try {
      if (file.sha256 !== snapshot.built.spec.assetHash) fail('La pieza privada cambió desde su aprobación.', 409);
    } finally { await file.handle.close(); }
    if (snapshot.connection.integrationMethod === 'api') {
      const credentials = decryptCredentials(snapshot.connection, snapshot.credentialRow, env);
      const connector = await createSocialConnector({ connection: snapshot.connection, credentials, transport: { ...transport, appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, graphVersion: env.META_GRAPH_VERSION || 'v26.0', now: Date.parse(now) } });
      assertLiveConnection(snapshot.built.spec, await connector.validateConnection({}));
      await verifySocialApiTargeting(snapshot.built.spec, { connector });
    }
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    if (snapshot) return commitApproval(tx, snapshot, input, action, actorId, env, now);
    const campaign = entity(await campaignRow(tx, id));
    expectVersion(campaign, input.version);
    return duplicateCampaign(tx, campaign, actorId, now);
  });
}

async function readControlSnapshot(tx, id, input) {
  const campaign = entity(await campaignRow(tx, id)); expectVersion(campaign, input.version);
  const connection = campaign.connectionId ? await getSocialConnection(tx, campaign.connectionId) : null;
  const deliveries = (await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')} WHERE campaign_id=? ORDER BY channel,id`, [id])).map(entity);
  const selected = input.deliveryId ? deliveries.filter(delivery => delivery.id === identifier(input.deliveryId, 'Entrega')) : deliveries;
  if (input.deliveryId && !selected.length) fail('La entrega no pertenece a esta campaña.', 404);
  const revisions = (await tx.db.all(`SELECT * FROM ${tx.t('social_revisions')} WHERE campaign_id=? ORDER BY revision`, [id])).map(entity);
  const operations = await campaignOperations(tx, id);
  const credentialRow = connection ? await tx.db.get(`SELECT * FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]) : null;
  return { campaign, connection, deliveries, selected, revisions, operations, credentialRow };
}
function controlRevision(snapshot, delivery) {
  const revision = snapshot.revisions.find(value => value.revision === delivery.revision);
  if (!revision?.spec || revision.specHash !== hash(revision.spec)) fail('La revisión aprobada no puede verificarse.', 409);
  return revision;
}
function controlDelivery(snapshot, input) {
  if (snapshot.selected.length !== 1) fail('Selecciona una entrega inequívoca para esta operación.', 409);
  const delivery = snapshot.selected[0];
  if (input.deliveryId && input.deliveryId !== delivery.id) fail('La entrega cambió.', 409);
  return delivery;
}
function hasPaidRemote(delivery) { return Boolean(delivery?.remoteId || delivery?.integrationMethod === 'api' && delivery?.remoteRefs?.campaignId); }
function hasPaidReference(delivery) { return hasPaidRemote(delivery) || delivery?.integrationMethod === 'browser' && /^\d{1,30}$/.test(delivery.remoteRefs?.remoteDraftRef || delivery.preparedRefs?.remoteDraftRef || ''); }
function controlProofRefs(value = {}) {
  const result = {};
  for (const key of ['remoteDraftRef', 'remoteId', 'campaignId', 'adSetId', 'creativeId', 'adId', 'videoId', 'photoId', 'containerId', 'mediaId', 'postId', 'uploadSessionId']) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'string' || !/^\d{1,40}(?:_\d{1,40})?$/.test(value[key])) fail('La referencia remota no puede verificarse.', 409);
    result[key] = value[key];
  }
  if (value.imageHash != null) {
    if (typeof value.imageHash !== 'string' || !/^[a-f0-9]{32,64}$/i.test(value.imageHash)) fail('El hash de imagen Meta no puede verificarse.', 409);
    result.imageHash = value.imageHash;
  }
  if (value.permalink) result.permalink = socialPermalink(value.permalink);
  return result;
}
async function controlRead(store, command, actorId, loader) {
  return store.transaction(async tx => {
    await tx.lockWrites(); await requireActor(tx, actorId);
    const prior = await tx.db.get(`SELECT * FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [command.scope, command.requestId]);
    if (prior) {
      if (prior.actor_id !== actorId || prior.payload_hash !== hash(command.payload)) fail('La operación ya se recibió con otro administrador o datos distintos.', 409);
      return { replay: JSON.parse(prior.result_json) };
    }
    return { snapshot: await loader(tx) };
  });
}
async function unchangedControl(tx, snapshot, input) {
  if (snapshot.controlBrowser) await assertLease(tx, { ...snapshot.controlBrowser.lease, now: snapshot.controlBrowser.clock() });
  const current = await readControlSnapshot(tx, snapshot.campaign.id, input);
  if (current.connection?.version !== snapshot.connection?.version || current.credentialRow?.version !== snapshot.credentialRow?.version ||
      current.selected.length !== snapshot.selected.length || current.selected.some(delivery => snapshot.selected.find(value => value.id === delivery.id)?.version !== delivery.version)) {
    fail('La cuenta o entrega cambió durante la verificación. Recarga y confirma de nuevo.', 409);
  }
  return current;
}
async function requireControlEffect(store, snapshot, delivery, env, now, { restoring = false } = {}) {
  const revision = controlRevision(snapshot, delivery), spec = revision.spec, campaign = snapshot.campaign;
  requirePublishing(snapshot.connection.integrationMethod, env);
  if (snapshot.connection.disconnectPending) fail('La conexión está deteniendo anuncios para desconectarse; no admite nueva inversión ni publicación.', 409);
  if (!restoring && (campaign.restore_hold || campaign.restoreHold)) fail('Primero reconcilia y acepta la recuperación de esta campaña.', 409);
  const accepted = campaign.restoredAuthorization;
  const approver = accepted?.specHash === revision.specHash && accepted.rightsAccepted === true ? accepted.actorId : revision.actorId;
  await requireActor(store, approver);
  if (revision.rightsAccepted !== true || snapshot.connection.id !== spec.connectionId || campaign.assetId !== spec.assetId || campaign.connectionId !== spec.connectionId) fail('La aprobación o su pieza cambió.', 409);
  const asset = await selectedAsset(store, spec.assetId);
  if (asset?.state !== 'ready' || asset.sha256 !== spec.assetHash || spec.assetType && asset.kind !== spec.assetType) fail('Restaura y verifica la pieza aprobada antes de continuar.', 409);
  const file = await openSocialAssetContent(store, asset.id, { env });
  try { if (file.sha256 !== spec.assetHash) fail('La pieza no coincide con la aprobación.', 409); }
  finally { await file.handle.close(); }
  if (spec.mode === 'paid') {
    if (!Number.isSafeInteger(spec.budgetMinor) || spec.budgetMinor <= 0 || spec.currency !== snapshot.connection.currency || spec.timeZone !== snapshot.connection.timeZone || !spec.endAt || spec.endAt <= now) fail('El presupuesto, moneda o período aprobado ya no permite continuar.', 409);
  } else {
    const due = spec.publishAt || revision.approvedAt;
    if (Date.parse(now) - Date.parse(due) > 900000) fail('La publicación pasó hace más de quince minutos. Duplica y reprograma.', 409);
  }
  return { revision, spec, assetVersion: asset.version };
}
async function controlConnector(snapshot, { env, now, transport, pause = false }) {
  const { connection, credentialRow } = snapshot;
  if (!connection || !['api', 'browser'].includes(connection.integrationMethod)) fail('La operación debe ejecutarse por la vía elegida y su consumidor autorizado.', 409);
  requireIntegration(connection.integrationMethod, env);
  if (!credentialRow || !pause && connection.state !== 'connected') fail('Falta acceso vigente. Reconecta la cuenta o detén el gasto directamente en Meta; no se ha confirmado una pausa.', 409);
  let connector;
  if (connection.integrationMethod === 'browser') {
    if (!snapshot.controlBrowser) fail('La lectura nativa necesita el dueño exclusivo del navegador.', 409);
    await snapshot.controlBrowser.assertActive();
    connector = await createSocialConnector({ connection, credentials: snapshot.controlBrowser.credentials, transport: { browserClient: snapshot.controlBrowser.client } });
  } else {
    const credentials = decryptCredentials(connection, credentialRow, env);
    connector = await createSocialConnector({ connection, credentials, transport: { ...transport, env, appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, graphVersion: env.META_GRAPH_VERSION || 'v26.0', now: Date.parse(now) } });
  }
  const validated = await connector.validateConnection({ purpose: pause ? 'pause' : 'publish', signal: AbortSignal.timeout(30000) });
  if (pause) {
    if (validated?.state !== 'connected' || validated.identities?.userId !== connection.identities?.userId ||
        String(validated.identities?.adAccountId || '').replace(/^act_/, '') !== String(connection.identities?.adAccountId || '').replace(/^act_/, '')) fail('La cuenta autorizada no coincide con la campaña que debe pausarse.', 409);
  } else {
    const delivery = snapshot.selected[0];
    if (delivery) assertLiveConnection(controlRevision(snapshot, delivery).spec, validated);
  }
  return connector;
}
function requireRemoteRead(result) {
  if (result?.status !== 'confirmed' || result.evidence?.remoteRead !== true) fail('No se obtuvo una confirmación remota inequívoca. Reconcilia o verifica el objeto directamente en Meta.', 409);
}
function requireBudgetConfirmation(input, revision, delivery, proof) {
  if (input.investmentAccepted !== true || input.specHash !== revision.specHash || !input.preparedRefs || !delivery.preparedRefs || hash(input.preparedRefs) !== hash(delivery.preparedRefs)) fail('Confirma de nuevo la inversión, especificación y referencias preparadas.', 409);
  if (proof.preparedRefs && hash(proof.preparedRefs) !== hash(delivery.preparedRefs)) fail('Las referencias preparadas cambiaron en Meta.', 409);
  const budget = proof.evidence?.budget, spec = revision.spec;
  if (!budget || budget.budgetMinor !== spec.budgetMinor || budget.currency !== spec.currency || budget.startAt !== spec.startAt || budget.endAt !== spec.endAt ||
      !Number.isSafeInteger(budget.remainingMinor) || budget.remainingMinor < 0 || budget.remainingMinor > spec.budgetMinor || input.remainingBudgetMinor !== budget.remainingMinor) {
    fail('El importe restante o las fechas originales no coinciden con la confirmación. Actualiza el resumen; no se aumentó ni extendió la inversión.', 409);
  }
  return { remainingMinor: budget.remainingMinor, currency: spec.currency, originalBudgetMinor: spec.budgetMinor, startAt: spec.startAt, endAt: spec.endAt, checkedAt: proof.evidence.checkedAt || null };
}
function queueMethodJobTx(tx, method, job, options) {
  if (method === 'browser') return queueSocialBrowserJobTx(tx, job, options);
  if (method === 'api') return queueSocialApiJobTx(tx, job, options);
  fail('La vía de la operación no puede verificarse.', 409);
}
async function queueControlTx(tx, snapshot, { input, actorId, action, now, budgetConfirmation = null, nextRunAt = now }) {
  const delivery = controlDelivery(snapshot, input), campaign = snapshot.campaign;
  const kind = action === 'activate-paid' ? 'activate' : action === 'cancel' ? 'pause' : action;
  const step = `${kind}:${input.requestId}`, id = newId(), revision = controlRevision(snapshot, delivery);
  const controlIntent = { id: input.requestId, kind, actorId, requestedAt: now };
  const deliveryData = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id]));
  await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { data: JSON.stringify({ ...deliveryData, controlIntent }) });
  await insertRow(tx, 'social_operations', { id, campaign_id: campaign.id, delivery_id: delivery.id, operation_key: `delivery:${delivery.id}:${step}`, step, state: 'prepared', next_attempt_at: nextRunAt,
    data: JSON.stringify({ integrationMethod: snapshot.connection.integrationMethod, actorId, specHash: revision.specHash, channel: delivery.channel, controlId: input.requestId,
      investmentAccepted: kind === 'activate' || kind === 'resume', preparedRefs: delivery.preparedRefs || null,
      ...(budgetConfirmation ? { budgetConfirmation } : {}), ...(action === 'cancel' ? { cancelAfterPause: true } : {}),
      ...(snapshot.connection.integrationMethod === 'api' ? { progress: { controlStage: kind === 'pause' ? 'campaign' : 'ad' } } : { remoteDraftRef: delivery.remoteRefs?.remoteDraftRef || delivery.preparedRefs?.remoteDraftRef || null, mediaEvidence: delivery.mediaEvidence || null }) }),
    version: 1, created_at: now, updated_at: now });
  await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'delivery', id: delivery.id, nextRunAt }, { now });
  const nextState = ['activate', 'resume'].includes(kind) ? 'publishing' : campaign.state;
  await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state: nextState });
  await audit(tx, { entityType: 'social_operation', entityId: id, actorId, next: { state: 'prepared', step, deliveryId: delivery.id, requestedState: action === 'cancel' ? 'cancelled' : kind }, reason: text(input.reason, 'Motivo', 1000) || 'Control explícito encolado; falta confirmación remota.', recordedAt: now });
  return resultOf(entity(await campaignRow(tx, campaign.id)), { operationId: id, operationIds: [id], deliveryIds: [delivery.id], requestedState: action === 'cancel' ? 'cancelled' : kind, nextRunAt });
}
async function queueCampaignReads(tx, snapshot, { input, actorId, action, now }) {
  if (!snapshot.selected.length) {
    const pending = snapshot.operations.filter(operation => !operation.deliveryId && ['sent', 'uncertain'].includes(operation.state));
    if (snapshot.connection?.integrationMethod !== 'browser' || !pending.length) fail('No hay entregas ni preparación incierta que consultar.', 409);
    for (const operation of pending) {
      await updateVersioned(tx, 'social_operations', operation.id, operation.version, { next_attempt_at: now });
      await queueSocialBrowserJobTx(tx, { kind: 'preflight', id: operation.id, nextRunAt: now }, { now });
    }
    await audit(tx, { entityType: 'social_campaign', entityId: snapshot.campaign.id, actorId, next: { requested: action, operationIds: pending.map(operation => operation.id) }, reason: 'Reconciliación de lectura de borrador privado; no se repite su creación.', recordedAt: now });
    return resultOf(snapshot.campaign, { operationIds: pending.map(operation => operation.id), requestedState: 'reading' });
  }
  if (!['api', 'browser'].includes(snapshot.connection?.integrationMethod)) fail('Esta lectura pertenece al consumidor de la vía elegida.', 409);
  const operationIds = [];
  for (const delivery of snapshot.selected) {
    const pending = action === 'reconcile' ? snapshot.operations.filter(operation => operation.deliveryId === delivery.id && ['sent', 'uncertain'].includes(operation.state)) : [];
    for (const operation of pending) {
      await updateVersioned(tx, 'social_operations', operation.id, operation.version, { next_attempt_at: now });
      operationIds.push(operation.id);
    }
    if (pending.length) await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'delivery', id: delivery.id, nextRunAt: now }, { now });
    else {
      const data = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id]));
      let nextRunAt = now;
      if (action === 'sync') {
        const block = delivery.metricSync?.blocked;
        if (block && block.connectionVersion === snapshot.connection.version && block.sessionEpoch === (snapshot.connection.sessionEpoch || 0)) fail('Revalida la conexión antes de consultar métricas bloqueadas.', 409);
        const last = [delivery.metricsRequestedAt, delivery.metricSync?.lastAttemptAt].filter(Boolean).sort().at(-1);
        if (last && Date.parse(now) - Date.parse(last) < 15 * 60000) fail(`La siguiente consulta manual estará disponible a partir de ${new Date(Date.parse(last) + 15 * 60000).toISOString()}.`, 429);
        data.metricsRequestedAt = now;
      } else data.stateReadRequestedAt = now;
      const revision = controlRevision(snapshot, delivery);
      const cooldown = await socialAccountNotBefore(tx, snapshot.connection, revision.spec, { now });
      if (cooldown) nextRunAt = cooldown;
      await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { next_sync_at: nextRunAt, data: JSON.stringify(data) });
      await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'sync', id: delivery.id, nextRunAt }, { now });
    }
  }
  await audit(tx, { entityType: 'social_campaign', entityId: snapshot.campaign.id, actorId, next: { requested: action, deliveryIds: snapshot.selected.map(delivery => delivery.id) }, reason: 'Lectura local encolada sin afirmar un nuevo estado remoto.', recordedAt: now });
  return resultOf(snapshot.campaign, { deliveryIds: snapshot.selected.map(delivery => delivery.id), operationIds, requestedState: 'reading' });
}
async function resolveCampaignOperation(store, snapshot, args) {
  const { input, actorId, action, command, env, now, transport } = args;
  const delivery = controlDelivery(snapshot, input), revision = controlRevision(snapshot, delivery);
  const operation = snapshot.operations.find(value => value.id === identifier(input.operationId, 'Operación') && value.deliveryId === delivery.id);
  if (!operation || !['sent', 'uncertain'].includes(operation.state)) fail('Selecciona la operación enviada o incierta que debe reconciliarse.', 409);
  if (input.specHash !== revision.specHash) fail('La resolución no corresponde a esta especificación.', 409);
  const reason = text(input.reason, 'Motivo de resolución', 1000, true);
  const notBefore = await socialAccountNotBefore(store, snapshot.connection, revision.spec, { now });
  if (notBefore) fail(`Meta mantiene una espera por cuenta hasta ${notBefore}. La resolución no evade ese límite.`, 429);
  const connector = await controlConnector(snapshot, { env, now, transport, pause: operation.step.startsWith('pause:') });
  let verified;
  if (action === 'link-remote') {
    if (input.acceptContentVerification !== true || !input.remoteId && !input.permalink) fail('Verifica expresamente cuenta, pieza y texto, e indica un ID o permalink existente.');
    verified = await connector.verifyRemoteLink({ delivery, operation, spec: revision.spec, remoteId: input.remoteId, permalink: input.permalink, acceptContentVerification: true, signal: AbortSignal.timeout(30000) });
    requireRemoteRead(verified);
  } else {
    if (input.confirmAbsence !== true || input.acceptDuplicateRisk !== true) fail('Confirma la ausencia y acepta explícitamente el riesgo de duplicación; no se promete exactly-once.');
    if (!snapshot.campaign.restore_hold && !snapshot.campaign.restoreHold) await requireControlEffect(store, snapshot, delivery, env, now);
    if (operation.controlId && operation.controlId !== delivery.controlIntent?.id) fail('El control fue sustituido por una intención posterior; no se reactivará el anterior.', 409);
    verified = await connector.inspectDelivery({ delivery, operation, spec: revision.spec, signal: AbortSignal.timeout(30000) });
    if (verified?.status === 'confirmed' || verified?.evidence?.candidateIds?.length) fail('Se encontró un efecto o coincidencias posibles. Vincula o reconcilia; no se reenviará como si estuviera ausente.', 409);
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    const current = await unchangedControl(tx, snapshot, input), fresh = current.operations.find(value => value.id === operation.id);
    if (!fresh || fresh.version !== operation.version || !['sent', 'uncertain'].includes(fresh.state)) fail('La operación cambió durante la resolución.', 409);
    const resolution = { kind: action === 'link-remote' ? 'link' : 'absent', actorId, previousActorId: operation.actorId, reason, specHash: revision.specHash,
      ...(action === 'link-remote' ? { acceptContentVerification: true, linkedAt: now } : { acceptDuplicateRisk: true, confirmedAt: now }) };
    const old = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id]));
    await updateVersioned(tx, 'social_operations', operation.id, fresh.version, { state: action === 'link-remote' ? fresh.state : 'prepared', next_attempt_at: now,
      data: JSON.stringify({ ...old, ...(action === 'confirm-absent' ? { actorId, attempts: 0, retryAttempts: 0 } : {}), resolution, resolutions: [...(old.resolutions || []), resolution] }) });
    if (action === 'link-remote') {
      const data = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id]));
      const refs = { ...(delivery.remoteRefs || {}), ...controlProofRefs(verified.remoteRefs) };
      const remoteId = refs.remoteId || refs.mediaId || refs.postId || refs.campaignId;
      if (remoteId && await tx.db.get(`SELECT id FROM ${tx.t('social_deliveries')} WHERE channel=? AND remote_id=? AND id<>? LIMIT 1`, [delivery.channel, remoteId, delivery.id])) fail('Ese objeto ya pertenece a otra entrega local.', 409);
      await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { data: JSON.stringify({ ...data, remoteRefs: refs, manualResolution: resolution }) });
    }
    await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'delivery', id: delivery.id, nextRunAt: now }, { now });
    await audit(tx, { entityType: 'social_operation', entityId: operation.id, actorId, previous: { state: fresh.state }, next: { state: action === 'link-remote' ? fresh.state : 'prepared', resolution }, reason, recordedAt: now });
    return resultOf(current.campaign, { operationId: operation.id, deliveryIds: [delivery.id], requestedState: 'reconciling' });
  });
}
async function resumeRestoredCampaign(store, snapshot, args) {
  const { input, actorId, command, env, now, transport } = args, campaign = snapshot.campaign;
  if (!campaign.restore_hold && !campaign.restoreHold) fail('Esta campaña no está bloqueada por recuperación.', 409);
  if (campaign.state === 'draft' && !snapshot.revisions.length) return resumeRestoredDraft(store, snapshot, args);
  if (!snapshot.deliveries.length || snapshot.operations.some(operation => ['sent', 'uncertain'].includes(operation.state))) fail('Primero resuelve cada efecto enviado o incierto; reconectar no basta.', 409);
  const first = snapshot.deliveries[0], revision = controlRevision(snapshot, first);
  if (!Array.isArray(input.acceptedWarnings) || input.acceptedWarnings.some(key => typeof key !== 'string')) fail('Acepta las advertencias originales de la revisión.');
  if (input.specHash !== revision.specHash || input.rightsAccepted !== true || hash([...new Set(input.acceptedWarnings)].sort()) !== hash([...(revision.acceptedWarnings || [])].sort())) fail('Acepta expresamente la revisión, sus derechos y advertencias originales.', 409);
  const authorization = { actorId, specHash: revision.specHash, rightsAccepted: true, acceptedWarnings: revision.acceptedWarnings || [], acceptedAt: now };
  const acceptedSnapshot = { ...snapshot, campaign: { ...campaign, restoredAuthorization: authorization } };
  const connector = await controlConnector(snapshot, { env, now, transport });
  for (const delivery of snapshot.deliveries) {
    const selectedRevision = controlRevision(snapshot, delivery);
    if (selectedRevision.specHash !== revision.specHash) fail('Las entregas requieren revisar revisiones separadas.', 409);
    if (delivery.remoteId || delivery.remoteRefs?.campaignId || delivery.remoteRefs?.mediaId || delivery.remoteRefs?.postId) {
      const result = await connector.inspectDelivery({ delivery, spec: selectedRevision.spec, signal: AbortSignal.timeout(30000) });
      requireRemoteRead(result);
      if (campaign.mode === 'paid' && !['completed', 'cancelled'].includes(delivery.state)) {
        if (input.investmentAccepted !== true || result.evidence?.budget?.remainingMinor !== input.remainingBudgetMinor) fail('Confirma el presupuesto restante y fechas originales antes de liberar la recuperación.', 409);
      }
    } else {
      if (input.acceptDuplicateRisk !== true) fail('No hay ID remoto para comprobar ausencia. Acepta el riesgo explícitamente o duplica sin reactivar esta campaña.', 409);
      await requireControlEffect(store, acceptedSnapshot, delivery, env, now, { restoring: true });
    }
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    const current = await unchangedControl(tx, snapshot, input);
    const data = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaign.id]));
    await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { data: JSON.stringify({ ...data, restore_hold: false, restoreHold: false, restoredAuthorization: authorization }) });
    for (const delivery of current.deliveries) {
      const pending = current.operations.filter(operation => operation.deliveryId === delivery.id && ['prepared', 'retry_wait'].includes(operation.state));
      if (pending.length || ['queued', 'preparing', 'scheduled'].includes(delivery.state) && !delivery.remoteId) await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'delivery', id: delivery.id, nextRunAt: pending[0]?.nextAttemptAt || revision.spec.publishAt || now }, { now });
      else {
        await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { next_sync_at: now });
        await queueMethodJobTx(tx, snapshot.connection.integrationMethod, { kind: 'sync', id: delivery.id, nextRunAt: now }, { now });
      }
    }
    await audit(tx, { entityType: 'social_campaign', entityId: campaign.id, actorId, next: { restoreHold: false, authorization }, reason: 'Reconciliación y aceptación explícita de recuperación, sin cambiar la especificación ni activar gasto.', recordedAt: now });
    return resultOf(entity(await campaignRow(tx, campaign.id)), { deliveryIds: current.deliveries.map(delivery => delivery.id), requestedState: 'reading' });
  });
}
async function withControlSession(store, snapshot, { action, actorId, env, now, transport, input }, fn) {
  const readsNative = ['activate-paid', 'resume', 'link-remote', 'confirm-absent', 'resume-restored'].includes(action);
  if (snapshot.connection?.integrationMethod !== 'browser' || !readsNative || action === 'resume-restored' && snapshot.campaign.state === 'draft' && !snapshot.revisions.length) return fn();
  requireIntegration('browser', env);
  const resolvingPause = snapshot.operations.find(operation => operation.id === input.operationId)?.step?.startsWith('pause:') === true;
  return withBrowserSession(store, snapshot.connection.id, {
    owner: `social-control:${snapshot.campaign.id}`, env, now, ...(resolvingPause ? { purpose: 'pause' } : {}),
    client: transport.browserClient, fetchImpl: transport.fetchImpl,
    check: () => requireActor(store, actorId)
  }, async browser => {
    if (browser.connection.version !== snapshot.connection.version || browser.credentialVersion !== snapshot.credentialRow?.version) fail('La conexión cambió antes de la lectura nativa. Recarga y confirma de nuevo.', 409);
    snapshot.controlBrowser = browser;
    return fn();
  });
}
function issuedPaidControl(snapshot) {
  return snapshot.deliveries.some(delivery => delivery.everActivated) || snapshot.operations.some(operation => /^(activate|resume):/.test(operation.step) && ['sent', 'uncertain'].includes(operation.state));
}
async function controlCampaignAction(store, args) {
  const { id, input, actorId, action, command, env, now, transport } = args;
  const read = await controlRead(store, command, actorId, tx => readControlSnapshot(tx, id, input));
  if (read.replay) return read.replay;
  const snapshot = read.snapshot;
  return withControlSession(store, snapshot, args, () => performCampaignControl(store, snapshot, args));
}
async function performCampaignControl(store, snapshot, args) {
  const { input, actorId, action, command, env, now, transport } = args;
  if (action === 'cancel' && (snapshot.campaign.mode !== 'paid' || !snapshot.deliveries.some(hasPaidRemote) && !issuedPaidControl(snapshot))) {
    return runCommand(actorCommands(store, actorId), command, async tx => {
      const current = await unchangedControl(tx, snapshot, input);
      return cancelCampaign(tx, current.campaign, actorId, now);
    });
  }
  if (['reconcile', 'sync'].includes(action)) return runCommand(actorCommands(store, actorId), command, async tx => queueCampaignReads(tx, await unchangedControl(tx, snapshot, input), args));
  if (['link-remote', 'confirm-absent'].includes(action)) {
    const operation = snapshot.operations.find(value => value.id === input.operationId);
    if (operation && !operation.deliveryId && snapshot.connection?.integrationMethod === 'browser') return resolveBrowserPreflight(store, snapshot, operation, args);
    return resolveCampaignOperation(store, snapshot, args);
  }
  if (action === 'resume-restored') return resumeRestoredCampaign(store, snapshot, args);
  const delivery = controlDelivery(snapshot, input), revision = controlRevision(snapshot, delivery), pause = ['pause', 'cancel'].includes(action);
  if (snapshot.campaign.mode !== 'paid' || delivery.channel !== 'meta_ads' || !hasPaidReference(delivery)) fail('Este control requiere una campaña o borrador pagado remoto conocido; no borra publicaciones.', 409);
  if (action === 'activate-paid' && (delivery.state !== 'ready' || delivery.everActivated)) fail('Sólo se activa por primera vez una preparación confirmada sin gasto previo.', 409);
  if (action === 'resume' && delivery.state !== 'paused') fail('Sólo se reanuda una campaña pausada y confirmada.', 409);
  let effect = null;
  if (!pause) {
    effect = await requireControlEffect(store, snapshot, delivery, env, now);
    if (action === 'activate-paid' && Date.parse(now) - Date.parse(revision.spec.startAt) > 900000) fail('El inicio aprobado pasó hace más de quince minutos. Duplica y reprograma.', 409);
  }
  const notBefore = await socialAccountNotBefore(store, snapshot.connection, revision.spec, { now });
  if (notBefore && !pause) fail(`Meta mantiene una espera por cuenta hasta ${notBefore}. Actualizar no evade el límite.`, 429);
  let budgetConfirmation = null;
  if (pause) {
    requireIntegration(snapshot.connection.integrationMethod, env);
    if (!snapshot.credentialRow) fail('Falta acceso al proveedor; detén el gasto directamente en Meta. No se ha confirmado una pausa.', 409);
  } else if (!notBefore) {
    const connector = await controlConnector(snapshot, { env, now, transport });
    const proof = await connector.inspectDelivery({ delivery, spec: revision.spec, signal: AbortSignal.timeout(30000) });
    requireRemoteRead(proof);
    budgetConfirmation = requireBudgetConfirmation(input, revision, delivery, proof);
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    const current = await unchangedControl(tx, snapshot, input);
    if (effect) {
      const asset = await selectedAsset(tx, effect.spec.assetId);
      if (asset.version !== effect.assetVersion || asset.sha256 !== effect.spec.assetHash || asset.state !== 'ready') fail('La pieza cambió durante la confirmación.', 409);
    }
    return queueControlTx(tx, current, { ...args, budgetConfirmation, nextRunAt: notBefore || now });
  });
}

const OPERATION_FIELDS = ['id', 'campaignId', 'deliveryId', 'step', 'state', 'nextAttemptAt', 'version', 'createdAt', 'updatedAt', 'integrationMethod', 'kind', 'actorId', 'campaignVersion', 'specHash', 'spec', 'remoteDraftRef', 'preparedRefs', 'query', 'result', 'lastError', 'attempts', 'reconcileAttempts', 'retryAttempts', 'resolution', 'resolutions', 'sentAt', 'progress', 'receipts', 'mediaEvidence'];
function operationDTO(operation) {
  return Object.fromEntries(OPERATION_FIELDS.filter(key => operation[key] !== undefined).map(key => [key, operation[key]]));
}
export async function getSocialOperation(store, id) {
  const operation = entity(await store.db.get(`SELECT * FROM ${store.t('social_operations')} WHERE id=?`, [identifier(id, 'Operación')]));
  if (!operation) fail('Operación social no encontrada.', 404);
  const result = operationDTO(operation);
  if (operation.deliveryId) {
    const delivery = entity(await store.db.get(`SELECT * FROM ${store.t('social_deliveries')} WHERE id=?`, [operation.deliveryId]));
    if (delivery) result.delivery = { id: delivery.id, state: delivery.state, lastConfirmedState: delivery.lastConfirmedState || null, lastConfirmedAt: delivery.lastConfirmedAt || null, remoteId: delivery.remoteId, remoteRefs: delivery.remoteRefs || {} };
  }
  return result;
}
function browserDraftReference(preflight) {
  return /^\d{1,30}$/.test(preflight?.remoteDraftRef || '') ? preflight.remoteDraftRef : null;
}
export async function queueSocialBrowserPreflight(store, id, input, actorId, { env = process.env, now = stamp() } = {}) {
  id = identifier(id, 'Campaña');
  const requestId = commandRequest(input), kind = input.kind;
  integer(input.version, 'Versión', 1, Number.MAX_SAFE_INTEGER);
  if (!['prepare', 'targeting', 'validate'].includes(kind) || Object.keys(input).some(key => !['kind', 'version', 'requestId', 'query', 'acceptPrivateDraft'].includes(key))) fail('Preparación privada no válida.');
  let query = null;
  if (kind === 'targeting') {
    objectInput(input.query);
    if (!['location', 'interest'].includes(input.query.kind) || Object.keys(input.query).some(key => !['kind', 'q'].includes(key))) fail('Búsqueda de segmentación no válida.');
    query = { kind: input.query.kind, q: text(input.query.q, 'Búsqueda', 200, true) };
  } else if (input.query != null) fail('Sólo una búsqueda admite query.');
  if (input.acceptPrivateDraft !== undefined && typeof input.acceptPrivateDraft !== 'boolean') fail('Confirma expresamente el borrador privado.');
  now = instant(now);
  return runCommand(actorCommands(store, actorId), { scope: `social:campaign:browser-preflight:${id}`, requestId, payload: input, actorId, affectsIndicators: false }, async tx => {
    const campaign = entity(await campaignRow(tx, id)); expectVersion(campaign, input.version);
    if (campaign.state !== 'draft' || campaign.mode !== 'paid' || !campaign.connectionId) fail('Sólo un borrador pagado puede prepararse en la interfaz nativa.', 409);
    const connection = await getSocialConnection(tx, campaign.connectionId);
    if (connection.integrationMethod !== 'browser') fail('La campaña no utiliza el navegador.', 409);
    if (connection.capabilities?.adsPublish !== true) fail('La cuenta no permite preparar pauta.', 409);
    if (kind === 'targeting') requireIntegration('browser', env); else requirePublishing('browser', env);
    if (kind !== 'targeting' && (campaign.restore_hold || campaign.restoreHold || connection.restore_hold)) fail('Reconcilia y acepta primero la recuperación del borrador.', 409);
    if (kind !== 'targeting' && connection.disconnectPending) fail('La conexión está completando su desconexión; no se modificará el borrador.', 409);
    const operations = await campaignOperations(tx, id);
    if (operations.some(operation => !operation.deliveryId && ['sent', 'uncertain'].includes(operation.state))) fail('Resuelve la preparación enviada o incierta antes de crear o editar otro borrador remoto.', 409);
    const reference = browserDraftReference(campaign.preflight);
    if (kind === 'prepare' && reference) fail('El borrador privado ya existe. Reutilízalo para buscar o validar; no se creará otro.', 409);
    if (kind !== 'prepare' && !reference) fail('Primero prepara un borrador privado recuperable.', 409);
    const previousAuthorization = campaign.preflight?.privateDraftAuthorization;
    if (kind === 'prepare' && input.acceptPrivateDraft !== true || kind !== 'prepare' && (!previousAuthorization?.actorId || !previousAuthorization.acceptedAt || input.acceptPrivateDraft === false)) fail('Acepta la creación y preparación del borrador privado sin gasto.');
    const authorization = kind === 'prepare' ? { actorId, acceptedAt: now, requestId } : previousAuthorization;
    const asset = await selectedAsset(tx, campaign.assetId);
    const built = kind === 'validate' ? buildSocialSpec(campaign, { connection, asset, now }) : buildSocialDraftSpec(campaign, { connection, asset });
    await retirePreparedTx(tx, operations.filter(operation => !operation.deliveryId), now);
    const operationId = newId(), campaignVersion = campaign.version + 1;
    const notBefore = await socialAccountNotBefore(tx, connection, built.spec, { now }), nextRunAt = notBefore || now;
    const data = { integrationMethod: 'browser', kind, actorId, campaignVersion, specHash: built.specHash, spec: built.spec, acceptPrivateDraft: true, privateDraftAuthorization: authorization, ...(reference ? { remoteDraftRef: reference } : {}), ...(query ? { query } : {}) };
    await insertRow(tx, 'social_operations', { id: operationId, campaign_id: id, delivery_id: null, operation_key: `preflight:${id}:${requestId}`, step: kind, state: 'prepared', next_attempt_at: nextRunAt, data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
    const preflight = { kind: 'pending', operationId, specHash: built.specHash, remoteDraftRef: reference, adapterVersion: 'meta-ui-v2', privateDraftAuthorization: authorization };
    await updateVersioned(tx, 'social_campaigns', id, campaign.version, { data: JSON.stringify({ ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [id])), preflight }) });
    await queueSocialBrowserJobTx(tx, { kind: 'preflight', id: operationId, nextRunAt }, { now });
    await audit(tx, { entityType: 'social_operation', entityId: operationId, actorId, next: { kind, state: 'prepared', campaignId: id, specHash: built.specHash, remoteDraftRef: reference }, reason: kind === 'prepare' ? 'Creación de borrador privado aceptada explícitamente; no autoriza inversión ni publicación.' : 'Preparación del mismo borrador nativo, sin activar ni publicar.', recordedAt: now });
    return { operationId, state: 'prepared', campaignId: id, version: campaignVersion, nextRunAt };
  });
}

async function resolveBrowserPreflight(store, snapshot, operation, args) {
  const { input, actorId, action, command, env, now, transport } = args, campaign = snapshot.campaign, spec = operation.spec;
  if (campaign.state !== 'draft' || campaign.mode !== 'paid' || !['prepare', 'targeting', 'validate'].includes(operation.step) || !['sent', 'uncertain'].includes(operation.state)) fail('Selecciona una preparación privada enviada o incierta.', 409);
  if (!spec || operation.integrationMethod !== 'browser' || operation.specHash !== hash(spec) || input.specHash !== operation.specHash || spec.connectionId !== snapshot.connection.id || !matchingIdentities(spec.identities, snapshot.connection.identities)) fail('La preparación no coincide con la propuesta y cuenta originales.', 409);
  const reason = text(input.reason, 'Motivo de resolución', 1000, true);
  const notBefore = await socialAccountNotBefore(store, snapshot.connection, spec, { now });
  if (notBefore) fail(`Meta mantiene una espera por cuenta hasta ${notBefore}. La resolución no evade ese límite.`, 429);
  const connector = await controlConnector(snapshot, { env, now, transport });
  let verified;
  if (action === 'link-remote') {
    if (input.acceptContentVerification !== true || !input.remoteId && !input.permalink) fail('Verifica expresamente el borrador, cuenta y contenido antes de vincular su ID.');
    verified = await connector.verifyRemoteLink({ delivery: null, operation, spec, remoteId: input.remoteId, permalink: input.permalink, acceptContentVerification: true, signal: AbortSignal.timeout(30000) });
    requireRemoteRead(verified);
    if (!browserDraftReference(verified.remoteRefs)) fail('El objeto verificado no es un borrador privado recuperable.', 409);
  } else {
    if (input.confirmAbsence !== true || input.acceptDuplicateRisk !== true) fail('Confirma ausencia y riesgo de duplicación; no se promete exactly-once.');
    if (!campaign.restore_hold && !campaign.restoreHold && operation.step !== 'targeting') requirePublishing('browser', env);
    verified = await connector.inspectDelivery({ delivery: null, operation, spec, signal: AbortSignal.timeout(30000) });
    if (verified?.status === 'confirmed' || verified?.evidence?.candidateIds?.length) fail('Existe un borrador o coincidencias posibles. Vincula o reconcilia antes de crear otro.', 409);
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    const current = await unchangedControl(tx, snapshot, input), fresh = current.operations.find(value => value.id === operation.id);
    if (!fresh || fresh.version !== operation.version || !['sent', 'uncertain'].includes(fresh.state)) fail('La preparación cambió durante la resolución.', 409);
    const resolution = { kind: action === 'link-remote' ? 'link' : 'absent', actorId, previousActorId: operation.actorId, reason, specHash: operation.specHash,
      ...(action === 'link-remote' ? { acceptContentVerification: true, linkedAt: now } : { acceptDuplicateRisk: true, confirmedAt: now }) };
    const old = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id]));
    const reference = action === 'link-remote' ? browserDraftReference(verified.remoteRefs) : operation.remoteDraftRef || null;
    const authorization = action === 'confirm-absent' ? { actorId, acceptedAt: now, requestId: input.requestId } : old.privateDraftAuthorization;
    await updateVersioned(tx, 'social_operations', operation.id, fresh.version, { state: action === 'link-remote' ? fresh.state : 'prepared', next_attempt_at: now,
      data: JSON.stringify({ ...old, campaignVersion: current.campaign.version, ...(reference ? { remoteDraftRef: reference } : {}), ...(authorization ? { privateDraftAuthorization: authorization } : {}), ...(action === 'confirm-absent' ? { actorId, attempts: 0, retryAttempts: 0 } : {}), resolution, resolutions: [...(old.resolutions || []), resolution] }) });
    await queueSocialBrowserJobTx(tx, { kind: 'preflight', id: operation.id, nextRunAt: now }, { now });
    await audit(tx, { entityType: 'social_operation', entityId: operation.id, actorId, previous: { state: fresh.state }, next: { state: action === 'link-remote' ? fresh.state : 'prepared', resolution, remoteDraftRef: reference }, reason, recordedAt: now });
    return resultOf(current.campaign, { operationId: operation.id, operationIds: [operation.id], requestedState: 'reconciling' });
  });
}

async function resumeRestoredDraft(store, snapshot, { input, actorId, command, env, now }) {
  if (snapshot.deliveries.length || snapshot.operations.some(operation => ['sent', 'uncertain'].includes(operation.state))) fail('Resuelve primero cada efecto incierto del borrador recuperado.', 409);
  const connection = snapshot.connection;
  if (!connection || connection.state !== 'connected') fail('Reconecta y verifica la cuenta del borrador.', 409);
  requireIntegration(connection.integrationMethod, env);
  const asset = await selectedAsset(store, snapshot.campaign.assetId);
  const built = buildSocialDraftSpec(snapshot.campaign, { connection, asset });
  if (input.specHash !== built.specHash || input.rightsAccepted !== true) fail('Confirma la propuesta recuperada y los derechos actuales; este paso no publica ni activa inversión.', 409);
  if (connection.integrationMethod === 'browser' && snapshot.campaign.mode === 'paid' && input.acceptPrivateDraft !== true) fail('Acepta expresamente volver a preparar el borrador privado sin gasto.');
  if (asset) {
    if (asset.state !== 'ready' || asset.sha256 !== built.spec.assetHash) fail('Restaura y verifica la pieza antes de liberar el borrador.', 409);
    const file = await openSocialAssetContent(store, asset.id, { env });
    try { if (file.sha256 !== built.spec.assetHash) fail('La pieza recuperada no coincide.', 409); }
    finally { await file.handle.close(); }
  }
  return runCommand(actorCommands(store, actorId), command, async tx => {
    const current = await unchangedControl(tx, snapshot, input);
    const currentAsset = await selectedAsset(tx, snapshot.campaign.assetId);
    if (currentAsset?.version !== asset?.version) fail('La pieza cambió durante la revisión.', 409);
    await retirePreparedTx(tx, current.operations, now);
    const data = rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [current.campaign.id]));
    const reference = browserDraftReference(data.preflight), authorization = { actorId, acceptedAt: now, requestId: input.requestId };
    delete data.forecastId;
    delete data.preflight;
    if (reference) data.preflight = { remoteDraftRef: reference, adapterVersion: 'meta-ui-v2', privateDraftAuthorization: authorization };
    data.restore_hold = false; data.restoreHold = false;
    data.restoredAuthorization = { actorId, specHash: built.specHash, rightsAccepted: true, acceptedWarnings: [], acceptedAt: now };
    await updateVersioned(tx, 'social_campaigns', current.campaign.id, current.campaign.version, { data: JSON.stringify(data) });
    await audit(tx, { entityType: 'social_campaign', entityId: current.campaign.id, actorId, next: { restoreHold: false, remoteDraftRef: reference }, reason: 'Borrador recuperado aceptado sin reanudar trabajos, publicar ni activar; requiere preparación y aprobación nuevas.', recordedAt: now });
    return resultOf(entity(await campaignRow(tx, current.campaign.id)), { requestedState: 'draft_review' });
  });
}

async function assertRecommendationApproval(tx, campaign, spec, input) {
  if (!campaign.sourceRecommendationId) return;
  if (input.recommendationAccepted !== true) fail('Confirma la modificación propuesta antes de aprobar esta publicación.');
  const recommendation = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_recommendations')} WHERE id=?`, [campaign.sourceRecommendationId]));
  if (!recommendation || recommendation.campaignId !== campaign.parentCampaignId || recommendation.childCampaignId !== campaign.id) fail('La recomendación de origen ya no coincide con este borrador.', 409);
  const revision = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_revisions')} WHERE campaign_id=? ORDER BY revision DESC LIMIT 1`, [campaign.parentCampaignId]));
  if (!revision?.spec) fail('No está disponible la configuración aprobada de origen.', 409);
  const before = revision.spec, change = recommendation.proposedChange;
  if (change?.type === 'copy' && !['caption', 'headline', 'destinationUrl', 'whatsappGreeting'].some(key => spec[key] !== before[key]) && spec.assetHash === before.assetHash) fail('Aporta o edita realmente el texto/CTA o una pieza diferente antes de confirmar.');
  if (change?.type === 'creative' && spec.assetHash === before.assetHash) fail('Aporta una pieza con contenido diferente para esta prueba.');
  if (change?.type === 'placement' && (spec.placements.length !== 1 || spec.placements[0] !== change.placement)) fail('Confirma una prueba de la ubicación propuesta, sin añadir otras.');
  if (change?.type === 'posting_window') {
    const window = change.postingWindow;
    const hour = spec.publishAt && window?.timeZone ? Number(new Intl.DateTimeFormat('en-CA', { timeZone: window.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(spec.publishAt))) : null;
    if (hour === null || hour < window.startHour || hour >= window.endHour) fail('Elige una fecha dentro de la franja sugerida y confírmala.');
  }
}
export async function socialRecommendationAction(store, id, action, input, actorId, { now = stamp() } = {}) {
  id = identifier(id, 'Recomendación'); now = instant(now);
  if (!['dismiss', 'duplicate-from-recommendation'].includes(action) || !input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['version', 'requestId', 'reason'].includes(key))) fail('Acción de recomendación no válida.');
  const requestId = commandRequest(input), version = integer(input.version, 'Versión de recomendación', 1, Number.MAX_SAFE_INTEGER);
  const reason = text(input.reason, 'Motivo', 500, action === 'dismiss');
  return runCommand(actorCommands(store, actorId), { scope: `social:recommendation:${id}:${action}`, requestId, payload: { id, action, version, reason }, actorId, affectsIndicators: false }, async tx => {
    const row = await tx.db.get(`SELECT * FROM ${tx.t('social_recommendations')} WHERE id=?`, [id]), recommendation = entity(row);
    if (!recommendation) fail('Recomendación no encontrada.', 404);
    expectVersion(recommendation, version);
    if (recommendation.state !== 'suggested') fail('Esta propuesta ya fue aplicada, descartada o evaluada.', 409);
    const campaign = entity(await campaignRow(tx, recommendation.campaignId));
    if (campaign.analysis?.evidenceHash !== recommendation.evidenceHash) fail('La propuesta es anterior a la evaluación actual. Revisa la evidencia antes de aplicar.', 409);
    if (recommendation.ruleKey === 'declared_return_gap') {
      const revision = Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
      if (recommendation.businessRevision !== revision) fail('La evaluación comercial está obsoleta. Solicita un análisis actualizado.', 409);
    }
    const previous = recommendation;
    let result = { id, version: version + 1, state: 'dismissed' }, data = rawData(row), state = 'dismissed';
    if (action === 'duplicate-from-recommendation') {
      if (!recommendation.proposedChange || !['measurement', 'copy', 'creative', 'placement', 'posting_window', 'offer_costs'].includes(recommendation.proposedChange.type)) fail('No está disponible una modificación válida para preparar.', 409);
      result = await duplicateCampaign(tx, campaign, actorId, now, recommendation);
      data = { ...data, childCampaignId: result.id, appliedAt: now, appliedBy: actorId }; state = 'applied';
    } else data = { ...data, dismissedAt: now, dismissedBy: actorId, dismissalReason: reason };
    await updateVersioned(tx, 'social_recommendations', id, version, { state, data: JSON.stringify(data) });
    await audit(tx, { entityType: 'social_recommendation', entityId: id, actorId, previous, next: { ...data, state }, reason: reason || 'Aplicar a un próximo borrador sin publicar ni autorizar gasto.', recordedAt: now });
    return result;
  });
}
