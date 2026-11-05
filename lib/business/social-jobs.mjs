import { openSocialMediaFile } from '../social/media-files.mjs';
import { fail, integer } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { assertLease, audit, entity, hash, stamp, updateVersioned } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, updateJobProgressTx, withLeaseHeartbeat } from './job-leases.mjs';
import { withBrowserSession } from './social-browser.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { socialConfig } from '../social/config.mjs';
import { socialErrorCode, socialPermalink, SOCIAL_ERROR_MESSAGES } from '../social/evidence.mjs';
import { processSocialAssetTurn } from './social-media.mjs';
import { prepareSocialApiJobs, processSocialApiTurn } from './social-api-jobs.mjs';
import { deferSocialAccountTx, socialAccountNotBefore } from './social-schedule.mjs';
import { socialMetricLifecycle, socialMetricsNextAt, socialStateReadDue, socialSyncNextAt, syncSocialDelivery } from './social-metrics.mjs';

const PREFIX = 'social:browser:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^social:browser:(delivery|sync|preflight):(.+)$/;
const BACKOFF = [60000, 300000, 900000, 3600000];
const STEP_TIMEOUT = 300000;
const IDENTITIES = ['userId', 'businessId', 'pageId', 'instagramId', 'adAccountId'];
const SPEC_FIELDS = ['identities', 'caption', 'headline', 'destinationUrl', 'whatsappNumber', 'whatsappGreeting', 'aiDisclosure', 'enhancements', 'assetHash', 'assetType', 'objective', 'budgetMinor', 'currency', 'timeZone', 'startAt', 'endAt', 'audience', 'placements', 'platforms', 'budgetType', 'budgetLevel', 'expansion', 'automaticPlacements', 'taxesAndFees', 'campaignCount', 'adSetCount', 'adCount', 'referenceContext'];
const rawData = row => JSON.parse(row?.data || '{}');
const after = (now, ms) => new Date(Date.parse(now) + ms).toISOString();
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const error = code => Object.assign(new Error(SOCIAL_ERROR_MESSAGES[code] || code), { errorCode: code, status: 409 });
const assert = (condition, code = 'SPEC_MISMATCH') => { if (!condition) throw error(code); };
const baseStep = operation => operation?.step?.split(':')[0];
const isPause = operation => baseStep(operation) === 'pause';
const isRead = task => task.kind === 'sync' || ['sent', 'uncertain'].includes(task.operation?.state) || task.operation?.resolution?.kind === 'link';
const isControl = operation => ['activate', 'pause', 'resume'].includes(baseStep(operation));
const isTargeting = task => task.kind === 'preflight' && task.operation?.step === 'targeting';
const activeStates = ['prepared', 'sent', 'retry_wait', 'uncertain'];
const samePauseIdentity = (expected, actual) => !!expected?.userId && !!expected?.adAccountId && expected.userId === actual?.userId && expected.adAccountId === actual?.adAccountId;
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const jsonField = (store, alias, name) => store.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${name}')` : `${alias}.data::jsonb->>'${name}'`;
const dueJob = store => `(${jsonField(store, 'j', 'nextRunAt')} IS NULL OR ${jsonField(store, 'j', 'nextRunAt')}<=?)`;
function jobParts(key) {
  const match = JOB.exec(key || '');
  return match && UUID.test(match[2]) ? { kind: match[1], id: match[2] } : null;
}

// This helper queues only code-owned job kinds and identifiers. Credentials,
// specification, actor inputs and provider responses never enter job progress.
export async function queueSocialBrowserJobTx(tx, { kind, id, nextRunAt = null }, { now = stamp() } = {}) {
  if (!['delivery', 'sync', 'preflight'].includes(kind) || !UUID.test(id || '')) fail('Trabajo social de navegador no válido.');
  now = instant(now); if (nextRunAt) nextRunAt = instant(nextRunAt);
  const key = `${PREFIX}${kind}:${id}`;
  const old = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (old?.state === 'running' && old.lease_until > now) return false;
  if (old?.state === 'queued') {
    if ((rawData(old).nextRunAt || null) === nextRunAt) return false;
    // The deadline follows the current durable intention, not a superseded
    // activation's polling delay. Eligibility still enforces account cooldowns
    // and operation deadlines, including for manual queue requests.
    await tx.db.run(`UPDATE ${tx.t('job_runs')} SET data=?,updated_at=?,version=version+1 WHERE key=? AND state='queued' AND version=?`, [JSON.stringify({ ...rawData(old), kind, id, nextRunAt }), now, key, old.version]);
    return true;
  }
  await queueJobTx(tx, key, { kind, id, nextRunAt }, { now });
  return true;
}

// Preparation never opens a browser, and can run in the ordinary consumer.
// Indexed domain deadlines select work; JSON is used only for the job's deadline
// and the immutable method pin, with an explicit expression for each engine.
export async function prepareSocialBrowserJobs(store, { now = stamp(), env = process.env } = {}) {
  now = instant(now); let queued = 0;
  await store.transaction(async tx => {
    await tx.lockWrites();
    const rows = await tx.db.all(`SELECT o.id,o.delivery_id FROM ${tx.t('social_operations')} o JOIN ${tx.t('social_campaigns')} c ON c.id=o.campaign_id JOIN ${tx.t('social_connections')} n ON n.id=c.connection_id WHERE n.integration_method='browser' AND ${jsonField(tx, 'o', 'integrationMethod')}='browser' AND o.state IN ('prepared','sent','retry_wait','uncertain') ORDER BY o.created_at,o.id`);
    const seen = new Set();
    for (const row of rows) {
      const parts = { kind: row.delivery_id ? 'delivery' : 'preflight', id: row.delivery_id || row.id };
      const key = `${parts.kind}:${parts.id}`; if (seen.has(key)) continue; seen.add(key);
      const task = await loadTask(tx, parts, now);
      if (!runnable(task, env, now)) continue;
      const cooldown = await accountDeadline(tx, task, now), future = futureAt(task, now);
      queued += Number(await queueSocialBrowserJobTx(tx, { ...parts, nextRunAt: cooldown && (!future || cooldown > future) ? cooldown : future }, { now }));
    }
    const deliveries = await tx.db.all(`SELECT d.id FROM ${tx.t('social_deliveries')} d JOIN ${tx.t('social_campaigns')} c ON c.id=d.campaign_id JOIN ${tx.t('social_connections')} n ON n.id=c.connection_id WHERE n.integration_method='browser' AND ${jsonField(tx, 'd', 'integrationMethod')}='browser' AND d.next_sync_at IS NOT NULL AND d.next_sync_at<=? ORDER BY d.next_sync_at,d.id`, [now]);
    for (const row of deliveries) {
      const parts = { kind: 'sync', id: row.id }, task = await loadTask(tx, parts, now);
      if (runnable(task, env, now)) queued += Number(await queueSocialBrowserJobTx(tx, { ...parts, nextRunAt: await accountDeadline(tx, task, now) }, { now }));
    }
  });
  return { queued, hasMore: await hasDueJob(store, env, now) };
}
async function candidates(store, now) {
  return store.db.all(`SELECT j.key FROM ${store.t('job_runs')} j WHERE j.key LIKE 'social:browser:%' AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?)) AND ${dueJob(store)} ORDER BY j.created_at,j.key`, [now, now]);
}
async function eligible(store, parts, env, now) {
  const task = await loadTask(store, parts, now);
  return runnable(task, env, now) && !futureAt(task, now) && !await accountDeadline(store, task, now) ? task : null;
}
async function hasDueJob(store, env, now) {
  for (const row of await candidates(store, now)) { const parts = jobParts(row.key); if (parts && await eligible(store, parts, env, now)) return true; }
  return false;
}
async function claimDue(store, env, now) {
  return store.transaction(async tx => {
    await tx.lockWrites(); let first = null;
    for (const row of await candidates(tx, now)) {
      const parts = jobParts(row.key), task = parts && await eligible(tx, parts, env, now);
      if (!task) continue;
      if (isPause(task.operation)) return claimJob({ transaction: fn => fn(tx) }, { key: row.key, now });
      first ||= row.key;
    }
    return first ? claimJob({ transaction: fn => fn(tx) }, { key: first, now }) : null;
  });
}

export function aggregateSocialCampaignState(deliveries, mode) {
  const states = deliveries.map(value => typeof value === 'string' ? value : value.state);
  if (!states.length) return null;
  if (mode === 'paid') return ({ queued: 'publishing', preparing: 'publishing', uncertain: 'needs_attention', blocked: 'needs_attention' })[states[0]] || states[0];
  if (states.every(state => state === 'published')) return 'published';
  if (states.some(state => state === 'published')) return 'partial';
  if (states.every(state => state === 'cancelled')) return 'cancelled';
  if (states.every(state => state === 'failed')) return 'failed';
  if (states.some(state => ['failed', 'blocked', 'uncertain'].includes(state))) return 'needs_attention';
  if (states.some(state => ['queued', 'preparing', 'publishing', 'in_review'].includes(state))) return 'publishing';
  return 'scheduled';
}
async function aggregateTx(tx, campaign) {
  const rows = await tx.db.all(`SELECT state FROM ${tx.t('social_deliveries')} WHERE campaign_id=?`, [campaign.id]);
  const state = aggregateSocialCampaignState(rows, campaign.mode);
  if (state && state !== campaign.state) await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state });
}
async function writeFenced(store, lease, clock, browser, fn, { allowAborted = false } = {}) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    const fence = async () => {
      await assertLease(tx, { ...lease, now: clock() });
      if (browser) {
        assert(allowAborted || !browser.signal.aborted, 'LEASE_LOST');
        await assertLease(tx, { ...browser.lease, now: clock() });
        const row = await tx.db.get(`SELECT integration_method,state,data FROM ${tx.t('social_connections')} WHERE id=?`, [browser.connection.id]);
        assert(row && row.integration_method === 'browser' && row.state !== 'disconnected' && (rawData(row).sessionEpoch || 0) === browser.sessionEpoch, 'LEASE_LOST');
      }
    };
    await fence(); const result = await fn(tx); await fence(); return result;
  });
}
function currentOperation(delivery, operations) {
  const current = operations.find(value => isControl(value) && value.controlId === delivery.controlIntent?.id && baseStep(value) === delivery.controlIntent?.kind);
  if (current && activeStates.includes(current.state)) return current;
  const unresolved = operations.find(value => ['sent', 'uncertain'].includes(value.state));
  if (unresolved) return unresolved;
  return delivery.controlIntent ? null : operations.find(value => !isControl(value) && activeStates.includes(value.state)) || null;
}
function superseded(task) {
  if (!task.delivery || !task.operation) return false;
  if (isControl(task.operation)) return task.operation.controlId !== task.delivery.controlIntent?.id || baseStep(task.operation) !== task.delivery.controlIntent?.kind;
  return !!task.delivery.controlIntent || ['cancelled', 'completed'].includes(task.delivery.state);
}
async function loadTask(store, parts, now, operationId = null) {
  let operation = null, delivery = null, operations = [];
  if (parts.kind === 'preflight') operation = entity(await store.db.get(`SELECT * FROM ${store.t('social_operations')} WHERE id=? AND delivery_id IS NULL`, [parts.id]));
  else {
    delivery = await get(store, 'social_deliveries', parts.id); if (!delivery) return null;
    operations = (await store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE delivery_id=? ORDER BY created_at,id`, [delivery.id])).map(entity);
    operation = operationId ? operations.find(value => value.id === operationId) : parts.kind === 'delivery' ? currentOperation(delivery, operations) : operations.find(value => ['sent', 'uncertain'].includes(value.state)) || null;
  }
  if (parts.kind !== 'sync' && !operation) return null;
  const campaign = await get(store, 'social_campaigns', operation?.campaignId || delivery.campaignId);
  if (!campaign) return null;
  const connection = await get(store, 'social_connections', campaign.connectionId);
  const revision = delivery ? entity(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [campaign.id, delivery.revision])) : null;
  const spec = delivery ? revision?.spec : operation.spec;
  const asset = spec?.assetId ? await get(store, 'social_assets', spec.assetId) : null;
  return { ...parts, operation, delivery, campaign, connection, revision, spec, asset };
}
function runnable(task, env, now) {
  if (!task?.connection || task.connection.integrationMethod !== 'browser' || task.delivery && task.delivery.integrationMethod !== 'browser') return false;
  if (!socialConfig(env).browserEnabled) return false;
  if (task.connection.state !== 'connected' && !(isPause(task.operation) && ['layout_changed', 'reconnect_required'].includes(task.connection.state))) return false;
  if (task.kind === 'sync' && (!task.delivery.nextSyncAt || task.delivery.nextSyncAt > now)) return false;
  if (task.operation && (!activeStates.includes(task.operation.state) || task.operation.state === 'uncertain' && !task.operation.nextAttemptAt)) return false;
  if (isRead(task)) return true;
  if (superseded(task)) return false;
  return isPause(task.operation) || isTargeting(task) || socialConfig(env).publishingEnabled && !task.campaign.restoreHold && !task.campaign.restore_hold && !task.connection.disconnectPending;
}
function futureAt(task, now) {
  if (task.operation?.nextAttemptAt > now) return task.operation.nextAttemptAt;
  if (!isRead(task) && task.spec?.mode === 'organic') {
    const due = task.spec.publishAt || task.revision?.approvedAt;
    if (due > now) return due;
  }
  return null;
}
async function accountDeadline(store, task, now) {
  const spec = isPause(task.operation) ? { integrationMethod: 'browser', mode: 'paid', identities: task.connection.identities } : task.spec;
  try { return await socialAccountNotBefore(store, task.connection, spec, { now }); }
  catch (caught) { if (caught.status === 409) return null; throw caught; }
}
async function activeActor(store, id) {
  return !!id && !!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE id=? AND active=1`, [id]);
}
function identitiesMatch(expected, actual) {
  return !!expected?.userId && !!expected?.businessId && IDENTITIES.every(key => (expected[key] || null) === (actual?.[key] || null));
}
function effectiveApprover(task) {
  const authorization = task.campaign.restoredAuthorization;
  if (!authorization) return task.revision?.actorId;
  assert(authorization.specHash === task.revision?.specHash && authorization.rightsAccepted === true && typeof authorization.actorId === 'string' && Number.isFinite(Date.parse(authorization.acceptedAt)) && Array.isArray(authorization.acceptedWarnings) && (task.revision.acceptedWarnings || []).every(warning => authorization.acceptedWarnings.includes(warning)), 'RESTORE_HOLD');
  return authorization.actorId;
}
function actingActor(task) {
  if (task.operation?.resolution?.kind === 'absent') return task.operation.resolution.actorId;
  return !isControl(task.operation) && task.revision && task.campaign.restoredAuthorization ? effectiveApprover(task) : task.operation?.actorId;
}
async function authorizeTask(store, task, env, now, { sending = false, validation = null } = {}) {
  const { campaign, connection, delivery, operation, revision, spec, asset } = task;
  assert(connection?.integrationMethod === 'browser');
  if (delivery) assert(delivery.integrationMethod === 'browser');
  if (operation) {
    assert(operation.integrationMethod === 'browser' && operation.campaignId === campaign.id && (!delivery || operation.deliveryId === delivery.id && operation.channel === delivery.channel));
    assert(delivery ? operation.operationKey === `delivery:${delivery.id}:${operation.step}` : new RegExp(`^preflight:${campaign.id}:[\\w:-]{8,100}$`).test(operation.operationKey));
    assert(delivery ? /^(prepare-paid|publish|(?:activate|pause|resume):[\w:-]{8,100})$/.test(operation.step) : ['prepare', 'targeting', 'validate'].includes(operation.step));
  }
  const pausing = isPause(operation);
  if (pausing) {
    assert(campaign.mode === 'paid' && /^\d{1,30}$/.test(delivery?.remoteId || delivery?.remoteRefs?.campaignId || delivery?.remoteRefs?.remoteDraftRef || delivery?.preparedRefs?.remoteDraftRef || operation.remoteDraftRef || ''), 'ACCOUNT_MISMATCH');
    assert(samePauseIdentity(operation.expectedIdentities || delivery.identities || spec?.identities || connection.identities, connection.identities), 'ACCOUNT_MISMATCH');
    assert(['connected', 'layout_changed', 'reconnect_required'].includes(connection.state), 'SESSION_EXPIRED');
    assert(await activeActor(store, actingActor(task)), 'PERMISSION_REQUIRED');
    if (validation) assert(validation.state === 'connected' && samePauseIdentity(connection.identities, validation.identities), 'ACCOUNT_MISMATCH');
    if (sending) assert(!superseded(task));
    return;
  }
  assert(spec?.integrationMethod === 'browser' && spec.connectionId === connection.id && campaign.connectionId === connection.id);
  if (revision) assert(revision.specHash === hash(spec));
  if (operation) assert(operation.specHash === hash(spec));
  assert(identitiesMatch(spec.identities, connection.identities), 'ACCOUNT_MISMATCH');
  assert(connection.state === 'connected', ({ challenge_required: 'CHALLENGE_REQUIRED', layout_changed: 'LAYOUT_CHANGED' })[connection.state] || 'SESSION_EXPIRED');
  if (!sending) return;
  assert(operation && !superseded(task));
  assert(await activeActor(store, actingActor(task)), 'PERMISSION_REQUIRED');
  if (operation.resolution?.kind === 'absent') assert(operation.resolution.acceptDuplicateRisk === true && Number.isFinite(Date.parse(operation.resolution.confirmedAt)), 'PERMISSION_REQUIRED');
  if (!isTargeting(task)) {
    assert(!connection.disconnectPending, 'PERMISSION_REQUIRED');
    assert(!campaign.restoreHold && !campaign.restore_hold, 'RESTORE_HOLD');
    assert(socialConfig(env).publishingEnabled, 'PUBLISHING_DISABLED');
  }
  const capability = spec.mode === 'paid' ? 'adsPublish' : delivery?.channel === 'instagram' ? 'instagramPublish' : 'facebookPublish';
  const observedConnection = validation || connection;
  assert(identitiesMatch(connection.identities, observedConnection.identities), 'ACCOUNT_MISMATCH');
  assert(observedConnection.capabilities?.[capability] === true && (spec.objective !== 'whatsapp' || spec.mode !== 'paid' || observedConnection.capabilities?.whatsappAds === true), 'PERMISSION_REQUIRED');
  if (delivery) {
    assert(revision && revision.rightsAccepted === true && await activeActor(store, effectiveApprover(task)), 'PERMISSION_REQUIRED');
    assert(revision.forecast?.specHash === revision.specHash);
    assert(campaign.assetId === spec.assetId);
    assert(delivery.channel === 'meta_ads' ? spec.mode === 'paid' : spec.mode === 'organic' && spec.platforms?.includes(delivery.channel));
    for (const key of Object.keys(spec)) if (Object.hasOwn(campaign, key) && key !== 'identities') assert(hash(campaign[key]) === hash(spec[key]));
  } else {
    assert(campaign.state === 'draft' && campaign.mode === 'paid' && spec.mode === 'paid');
    assert(Number.isSafeInteger(operation.campaignVersion) && operation.campaignVersion === campaign.version);
    assert(operation.kind === undefined || operation.kind === operation.step);
    const consent = operation.privateDraftAuthorization;
    assert(operation.acceptPrivateDraft === true && consent?.actorId && Number.isFinite(Date.parse(consent.acceptedAt)) && typeof consent.requestId === 'string');
    if (operation.step === 'prepare') assert(consent.actorId === operation.actorId && (!campaign.preflight?.remoteDraftRef || operation.resolution?.kind === 'absent'));
    else assert(operation.remoteDraftRef && operation.remoteDraftRef === campaign.preflight?.remoteDraftRef && hash(consent) === hash(campaign.preflight?.privateDraftAuthorization));
  }
  if (!delivery && operation.step !== 'validate') return;
  assert(asset?.state === 'ready' && asset.sha256 === spec.assetHash && asset.derivativeSha256 === spec.assetHash && asset.id === spec.assetId && asset.kind === spec.assetType, 'MISSING_FILE');
  if (spec.mode === 'paid') {
    assert(Number.isSafeInteger(spec.budgetMinor) && spec.budgetMinor > 0 && spec.currency === observedConnection.currency && spec.timeZone === observedConnection.timeZone);
    assert(Number.isFinite(Date.parse(spec.startAt)) && Date.parse(spec.endAt) > Date.parse(spec.startAt) && Date.parse(spec.endAt) - Date.parse(spec.startAt) <= 90 * 86400000);
    if (['activate', 'resume'].includes(baseStep(operation))) {
      assert(Date.parse(spec.endAt) > Date.parse(now), 'SCHEDULE_MISSED');
      assert(operation.investmentAccepted === true && operation.preparedRefs && delivery.preparedRefs && hash(operation.preparedRefs) === hash(delivery.preparedRefs));
      const budget = operation.budgetConfirmation;
      assert(budget && Number.isSafeInteger(budget.remainingMinor) && budget.remainingMinor >= 0 && budget.remainingMinor <= spec.budgetMinor && budget.originalBudgetMinor === spec.budgetMinor && budget.currency === spec.currency && budget.startAt === spec.startAt && budget.endAt === spec.endAt);
    }
    if (baseStep(operation) === 'activate' && !delivery.everActivated) assert(Date.parse(now) - Date.parse(spec.startAt) <= 900000, 'SCHEDULE_MISSED');
    if (operation.step === 'prepare-paid') assert(operation.remoteDraftRef && operation.remoteDraftRef === campaign.preflight?.remoteDraftRef && campaign.preflight?.specHash === revision.specHash);
  } else {
    const due = spec.publishAt || revision.approvedAt;
    assert(Number.isFinite(Date.parse(due)) && Date.parse(now) >= Date.parse(due) && Date.parse(now) - Date.parse(due) <= 900000, 'SCHEDULE_MISSED');
  }
}
async function verifiedMedia(task, env) {
  if (isPause(task.operation) || isRead(task) || !task.asset || task.kind === 'preflight' && task.operation.step !== 'validate') return null;
  const id = task.asset.id;
  assert(UUID.test(id) && ['image', 'video'].includes(task.asset.kind), 'MISSING_FILE');
  const key = `${id}/derivative.${task.asset.kind === 'video' ? 'mp4' : 'jpg'}`;
  try {
    const file = await openSocialMediaFile(key, { env, expectedSha256: task.spec.assetHash, expectedBytes: task.asset.derivativeBytes });
    await file.handle.close();
  } catch { throw error('MISSING_FILE'); }
  return { assetId: id, key, sha256: task.spec.assetHash };
}
function safeText(value, max = 500) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null; }
function remoteRefs(value) {
  const result = {};
  for (const key of ['remoteDraftRef', 'remoteId', 'campaignId', 'adSetId', 'creativeId', 'adId']) if (value?.[key] !== undefined && value[key] !== null) { assert(typeof value[key] === 'string' && /^\d{1,30}$/.test(value[key])); result[key] = value[key]; }
  if (value?.permalink) result.permalink = socialPermalink(value.permalink);
  return result;
}
function mediaEvidence(value) {
  if (!value) return null;
  assert(/^\d{1,30}$/.test(value.scope || '') && /^\d{1,30}$/.test(value.remoteMediaId || '') && /^[a-f0-9]{64}$/.test(value.sha256 || '') && safeText(value.name, 200));
  return pick(value, ['scope', 'name', 'sha256', 'remoteMediaId']);
}
const normalizeText = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
function browserReference(value, businessId, type = null) {
  assert(value?.source === 'browser' && value.providerId === null && /^[a-f0-9]{64}$/.test(value.key || '') && safeText(value.label, 200), 'LAYOUT_CHANGED');
  const context = value.context;
  assert(context && typeof context === 'object' && !Array.isArray(context) && ['country', 'region', 'city', 'interest'].includes(context.type) && (!type || context.type === type) && safeText(context.scope, 200), 'LAYOUT_CHANGED');
  assert(context.type === 'interest' ? context.countryCode === null && context.region === null : /^[A-Z]{2}$/.test(context.countryCode || '') && (context.type === 'country' ? context.region === null : !!safeText(context.region, 200)), 'LAYOUT_CHANGED');
  const base = { type: context.type, countryCode: context.countryCode, region: context.region === null ? null : normalizeText(context.region), scope: normalizeText(context.scope) };
  const label = normalizeText(value.label);
  assert(label && base.scope && value.key === hash({ label, context: base, businessId }), 'LAYOUT_CHANGED');
  const output = { ...base };
  if (context.radius !== undefined || context.distanceUnit !== undefined) {
    assert(context.type === 'city' && Number.isFinite(context.radius) && (context.distanceUnit === 'kilometer' && context.radius >= 17 && context.radius <= 80 || context.distanceUnit === 'mile' && context.radius >= 10 && context.radius <= 50), 'LAYOUT_CHANGED');
    output.radius = context.radius; output.distanceUnit = context.distanceUnit;
  }
  return { key: value.key, source: 'browser', providerId: null, label, context: output };
}
function sanitizeObserved(value) {
  if (!value) return null;
  const result = pick(value, SPEC_FIELDS);
  result.identities = pick(value.identities, IDENTITIES);
  assert(Object.values(result.identities).every(entry => entry === null || typeof entry === 'string' && /^\d{1,30}$/.test(entry)), 'LAYOUT_CHANGED');
  if (value.audience) result.audience = Object.fromEntries(['countries', 'regions', 'cities', 'genders', 'interests', 'ageMin', 'ageMax'].filter(key => value.audience[key] !== undefined).map(key => {
    const entry = value.audience[key];
    if (['ageMin', 'ageMax'].includes(key)) { assert(Number.isInteger(entry), 'LAYOUT_CHANGED'); return [key, entry]; }
    assert(Array.isArray(entry) && entry.length <= 200, 'LAYOUT_CHANGED');
    if (['regions', 'cities', 'interests'].includes(key)) return [key, entry.map(item => browserReference(item, value.identities?.businessId, ({ regions: 'region', cities: 'city', interests: 'interest' })[key]))];
    assert(entry.every(item => typeof item === 'string' && safeText(item, 200)), 'LAYOUT_CHANGED');
    return [key, entry];
  }));
  assert(Object.entries(result).every(([key, entry]) => ['identities', 'audience'].includes(key) || ['assetHash', 'assetType'].includes(key) && entry === null || ['string', 'number', 'boolean'].includes(typeof entry) || Array.isArray(entry) && entry.length <= 10 && entry.every(item => typeof item === 'string')), 'LAYOUT_CHANGED');
  assert(Buffer.byteLength(JSON.stringify(result)) <= 20000, 'LAYOUT_CHANGED');
  return result;
}
function compareObserved(task, result) {
  if (result.status !== 'confirmed' || result.state === 'failed' || isPause(task.operation) || task.kind === 'preflight' && task.operation.step !== 'validate') return;
  const spec = task.spec, observed = result.observedSpec;
  assert(observed && identitiesMatch(spec.identities, observed.identities));
  for (const key of ['caption', 'headline', 'destinationUrl', 'whatsappNumber']) assert(normalizeText(spec[key]) === observed[key]);
  if (spec.mode === 'paid' && spec.objective === 'whatsapp') assert(normalizeText(spec.whatsappGreeting) && normalizeText(spec.whatsappGreeting) === observed.whatsappGreeting);
  const verifiedByHuman = task.operation?.resolution?.kind === 'link' && task.operation.resolution.acceptContentVerification === true;
  assert((spec.assetHash === observed.assetHash || verifiedByHuman && result.evidence.contentVerifiedByAdministrator === true) && ['image', 'video'].includes(spec.assetType) && spec.assetType === observed.assetType && Boolean(spec.aiDisclosure) === observed.aiDisclosure && observed.enhancements !== true);
  if (spec.mode === 'organic') {
    assert(hash([task.delivery.channel]) === hash(observed.platforms));
    return;
  }
  for (const key of ['objective', 'budgetMinor', 'currency', 'timeZone']) assert(spec[key] === observed[key]);
  for (const key of ['startAt', 'endAt']) assert(new Date(spec[key]).toISOString() === observed[key]);
  assert(observed.budgetType === 'lifetime' && /^(Ad set|Conjunto de anuncios)$/.test(observed.budgetLevel || ''));
  assert(observed.expansion === false && observed.automaticPlacements === false && observed.campaignCount === 1 && observed.adSetCount === 1 && observed.adCount === 1);
  assert(hash(spec.placements) === hash(observed.placements));
  for (const key of ['ageMin', 'ageMax']) assert(spec.audience?.[key] === observed.audience?.[key]);
  for (const key of ['countries', 'regions', 'cities', 'genders', 'interests']) {
    const canonical = values => values.map(value => typeof value === 'string' ? normalizeText(value) : browserReference(value, spec.identities.businessId)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert(hash(canonical(spec.audience?.[key] || [])) === hash(canonical(observed.audience?.[key] || [])));
  }
}
function sanitizeResult(result, task) {
  assert(['confirmed', 'pending', 'blocked', 'uncertain'].includes(result?.status), 'LAYOUT_CHANGED');
  const refs = remoteRefs({ ...result.remoteRefs, ...(result.remoteDraftRef ? { remoteDraftRef: result.remoteDraftRef } : {}) });
  const state = ['ready', 'scheduled', 'publishing', 'published', 'in_review', 'active', 'paused', 'completed', 'failed'].includes(result.state) ? result.state : null;
  const observedSpec = sanitizeObserved(result.observedSpec);
  // This whitelist is intentional: browser output must not persist frames,
  // storageState, HTML, signed URLs, or arbitrary provider error strings.
  const evidence = { adapterVersion: 'meta-ui-v2', remoteRead: result.evidence?.remoteRead === true, ...(state ? { state } : {}) };
  if (typeof result.evidence?.everActivated === 'boolean') evidence.everActivated = result.evidence.everActivated;
  if (result.evidence?.contentVerifiedByAdministrator === true) evidence.contentVerifiedByAdministrator = true;
  if (result.evidence?.budget) {
    const budget = result.evidence.budget;
    assert(Number.isSafeInteger(budget.budgetMinor) && budget.budgetMinor > 0 && (budget.remainingMinor === null || Number.isSafeInteger(budget.remainingMinor) && budget.remainingMinor >= 0 && budget.remainingMinor <= budget.budgetMinor) && /^[A-Z]{3}$/.test(budget.currency || '') && Number.isFinite(Date.parse(budget.startAt)) && Date.parse(budget.endAt) > Date.parse(budget.startAt), 'LAYOUT_CHANGED');
    evidence.budget = pick(budget, ['budgetMinor', 'remainingMinor', 'currency', 'startAt', 'endAt']);
  }
  if (state === 'failed' && safeText(result.evidence?.reason)) evidence.reason = result.evidence.reason;
  if (result.evidence?.mediaEvidence) evidence.mediaEvidence = mediaEvidence(result.evidence.mediaEvidence);
  const candidates = (result.candidates || []).map(value => browserReference(value, task.connection.identities?.businessId));
  assert(candidates.length <= 200);
  let audienceEstimate = null;
  if (result.audienceEstimate) {
    const value = result.audienceEstimate;
    audienceEstimate = { source: 'meta_ui', definition: safeText(value.definition, 100), displayValue: safeText(value.displayValue, 300), label: safeText(value.label, 100), horizon: safeText(value.horizon, 100), adapterVersion: 'meta-ui-v2',
      status: value.status === 'reported' && Number.isFinite(value.lower) && value.lower >= 0 && Number.isFinite(value.upper) && value.upper >= value.lower ? 'reported' : 'unavailable', lower: null, upper: null };
    if (audienceEstimate.status === 'reported') { audienceEstimate.lower = value.lower; audienceEstimate.upper = value.upper; }
  }
  return { status: result.status, state, remoteRefs: refs, observedSpec, evidence, candidates, audienceEstimate, ...(result.preparedRefs ? { preparedRefs: remoteRefs(result.preparedRefs) } : {}) };
}
function nativeOperation(operation, delivery, connection) {
  if (!operation) return null;
  const acceptPrivateDraft = operation.acceptPrivateDraft === true;
  const resolution = operation.resolution?.kind === 'link' ? operation.resolution : null;
  const refs = resolution?.refs || {};
  const draftRef = refs.remoteDraftRef || operation.remoteDraftRef || delivery?.remoteRefs?.remoteDraftRef || delivery?.preparedRefs?.remoteDraftRef || null;
  const data = { ...pick(operation, ['preparedRefs', 'investmentAccepted', 'specHash', 'budgetConfirmation', 'resolution', 'controlId', 'privateDraftAuthorization']), remoteDraftRef: draftRef, acceptPrivateDraft, mediaEvidence: operation.mediaEvidence || delivery?.mediaEvidence || null };
  return { ...operation, acceptPrivateDraft, remoteId: refs.remoteId || delivery?.remoteId || delivery?.remoteRefs?.campaignId || operation.remoteId || null, remoteDraftRef: draftRef, channel: delivery?.channel || operation.channel, expectedIdentities: connection?.identities, data };
}
function inspectableDelivery(task) {
  const { delivery, operation } = task;
  if (!delivery) return null;
  const refs = operation?.resolution?.kind === 'link' ? operation.resolution.refs || {} : {};
  const draftRef = refs.remoteDraftRef || delivery.remoteRefs?.remoteDraftRef || delivery.preparedRefs?.remoteDraftRef || operation?.remoteDraftRef || null;
  return { ...delivery, operationId: operation?.id || null, operationStep: operation?.step || null, remoteId: refs.remoteId || delivery.remoteId || delivery.remoteRefs?.campaignId || null, remoteDraftRef: draftRef, mediaEvidence: delivery.mediaEvidence || operation?.mediaEvidence || null, data: { mediaEvidence: delivery.mediaEvidence || operation?.mediaEvidence || null, remoteDraftRef: draftRef } };
}
function retryAt(now, attempts, retryAfter = null) {
  const delay = BACKOFF[attempts - 1];
  if (!delay) return null;
  const requested = typeof retryAfter === 'number' ? after(now, retryAfter * 1000) : retryAfter;
  return requested && Number.isFinite(Date.parse(requested)) && requested > after(now, delay) ? requested : after(now, delay);
}
async function resultTx(tx, task, result, now, { reading = false } = {}) {
  const { operation, delivery, campaign } = task;
  if (operation && ['confirmed', 'failed'].includes(operation.state)) return { nextRunAt: null, errorCode: null };
  const stale = delivery ? superseded(task) : campaign.state !== 'draft' || campaign.version !== operation.campaignVersion;
  let confirmed = result.status === 'confirmed';
  if (confirmed) assert(result.evidence.remoteRead === true, 'OPERATION_UNCERTAIN');
  if (!delivery) {
    if (confirmed && operation.step !== 'prepare') assert(result.remoteRefs.remoteDraftRef === operation.remoteDraftRef);
    if (confirmed) {
      const ref = result.remoteRefs.remoteDraftRef;
      assert(ref, 'OPERATION_UNCERTAIN');
      const previous = campaign.preflight || {};
      let preflight;
      if (stale) {
        // A changed proposal keeps its private draft only in the same account
        // context. A late response from a previous connection stays journal-only.
        const sameContext = task.spec.connectionId === campaign.connectionId && task.connection?.integrationMethod === 'browser' && identitiesMatch(task.spec.identities, task.connection.identities) && task.spec.currency === task.connection.currency && task.spec.timeZone === task.connection.timeZone;
        if (sameContext) preflight = { ...previous, remoteDraftRef: previous.remoteDraftRef || ref, acceptPrivateDraft: true, privateDraftAuthorization: previous.privateDraftAuthorization || operation.privateDraftAuthorization, adapterVersion: 'meta-ui-v2' };
        confirmed = false;
      } else {
        preflight = { ...(previous.specHash === operation.specHash ? previous : {}), acceptPrivateDraft: operation.acceptPrivateDraft === true || previous.acceptPrivateDraft === true, privateDraftAuthorization: previous.privateDraftAuthorization || operation.privateDraftAuthorization,
          kind: operation.step, specHash: operation.specHash, operationId: operation.id, remoteDraftRef: ref, adapterVersion: 'meta-ui-v2', checkedAt: now,
          ...(result.observedSpec ? { observedSpec: result.observedSpec } : {}), ...(result.preparedRefs ? { preparedRefs: result.preparedRefs } : {}),
          ...(result.evidence.mediaEvidence ? { mediaEvidence: result.evidence.mediaEvidence } : previous.mediaEvidence ? { mediaEvidence: previous.mediaEvidence } : {}),
          ...(operation.step === 'targeting' ? { candidates: result.candidates } : previous.candidates ? { candidates: previous.candidates } : {}),
          ...(result.audienceEstimate ? { audienceEstimate: result.audienceEstimate } : {}) };
        if (operation.step === 'validate') assert(preflight.preparedRefs?.remoteDraftRef === ref && preflight.mediaEvidence?.sha256 === task.spec.assetHash && result.observedSpec);
      }
      if (preflight) await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { data: JSON.stringify({ ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaign.id])), preflight }) });
    }
  }
  if (delivery && confirmed) {
    assert(result.state, 'LAYOUT_CHANGED');
    if (delivery.remoteId && result.remoteRefs.remoteId) assert(delivery.remoteId === result.remoteRefs.remoteId, 'ACCOUNT_MISMATCH');
    if (operation) {
      const expected = ({ publish: ['published'], 'prepare-paid': ['ready'], activate: ['active', 'scheduled', 'in_review', 'failed'], pause: ['paused'], resume: ['active', 'scheduled', 'in_review', 'failed'] })[baseStep(operation)];
      confirmed = expected?.includes(result.state) === true;
    }
    if (confirmed) {
      if (result.state === 'published') assert(result.remoteRefs.remoteId && result.remoteRefs.permalink, 'OPERATION_UNCERTAIN');
      if (['active', 'paused', 'scheduled', 'in_review', 'completed'].includes(result.state)) assert(result.remoteRefs.remoteId || delivery.remoteId, 'OPERATION_UNCERTAIN');
      if (campaign.mode === 'paid' && result.state !== 'failed' && !isPause(operation)) assert(result.evidence.budget && typeof result.evidence.everActivated === 'boolean', 'OPERATION_UNCERTAIN');
      if (result.state === 'ready') {
        assert(result.remoteRefs.remoteDraftRef && result.evidence.everActivated === false && delivery.everActivated !== true, 'SPEC_MISMATCH');
        assert(result.preparedRefs?.remoteDraftRef === result.remoteRefs.remoteDraftRef && (result.evidence.mediaEvidence || operation?.mediaEvidence || delivery.mediaEvidence)?.sha256 === task.spec.assetHash, 'OPERATION_UNCERTAIN');
      }
    }
  }
  const pending = result.status === 'pending';
  const nextAttempt = stale ? null : pending ? after(now, 300000) : !confirmed && reading ? retryAt(now, (operation?.reconcileAttempts || 0) + 1) : !confirmed && result.status !== 'blocked' ? after(now, 60000) : null;
  const lastError = confirmed ? result.state === 'failed' ? { code: 'PROVIDER_REJECTED', message: SOCIAL_ERROR_MESSAGES.PROVIDER_REJECTED } : null : { code: stale || result.status === 'blocked' ? 'SPEC_MISMATCH' : 'OPERATION_UNCERTAIN', message: SOCIAL_ERROR_MESSAGES[stale || result.status === 'blocked' ? 'SPEC_MISMATCH' : 'OPERATION_UNCERTAIN'] };
  if (operation) {
    const receipts = operation.receipts || [];
    assert(Array.isArray(receipts));
    const data = { ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id])), result,
      ...(result.evidence.remoteRead ? { receipts: [...receipts, { checkedAt: now, remoteRefs: result.remoteRefs, evidence: result.evidence, state: result.state, superseded: stale }] } : {}),
      ...(result.preparedRefs ? { preparedRefs: result.preparedRefs } : {}), ...(result.evidence.mediaEvidence ? { mediaEvidence: result.evidence.mediaEvidence } : {}),
      ...(reading || result.status === 'uncertain' ? { reconcileAttempts: confirmed ? 0 : (operation.reconcileAttempts || 0) + 1 } : {}), lastError };
    const state = confirmed ? 'confirmed' : pending ? 'sent' : result.status === 'blocked' && !['sent', 'uncertain'].includes(operation.state) ? 'failed' : 'uncertain';
    await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state, next_attempt_at: nextAttempt, data: JSON.stringify(data) });
    await audit(tx, { entityType: 'social_operation', entityId: operation.id, actorId: operation.executedBy || operation.actorId, next: { state, step: operation.step }, source: 'scheduler', recordedAt: now });
  }
  if (delivery) {
    const refs = { ...delivery.remoteRefs, ...result.remoteRefs };
    const activationProved = result.evidence.remoteRead && (result.evidence.everActivated === true || result.state === 'active');
    const everActivated = delivery.everActivated === true || activationProved;
    let state = delivery.state;
    if (!stale) {
      if (confirmed) state = result.state;
      else if (!pending) state = result.status === 'blocked' ? 'blocked' : 'uncertain';
      if (confirmed && result.state === 'paused' && operation?.cancelAfterPause === true) state = 'cancelled';
      if (!operation && state === 'ready' && everActivated) state = 'paused';
    }
    const durableMedia = result.evidence.mediaEvidence || operation?.mediaEvidence || delivery.mediaEvidence;
    const data = { ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id])), remoteRefs: refs, everActivated,
      ...(activationProved && !delivery.activatedAt ? { activatedAt: now } : {}),
      ...(confirmed && !stale ? { ...socialMetricLifecycle(delivery, { state }, { operation, now }), lastStateReadAt: now } : {}),
      ...(!stale ? { lastError, evidence: result.evidence, syncAttempts: 0,
        ...(confirmed ? { lastConfirmedAt: now, lastConfirmedState: state === 'cancelled' ? 'paused' : state } : {}),
        ...(result.evidence.budget ? { budgetSnapshot: { ...result.evidence.budget, checkedAt: now } } : {}),
        ...(result.preparedRefs ? { preparedRefs: result.preparedRefs } : {}), ...(durableMedia ? { mediaEvidence: durableMedia } : {}) } : {}) };
    const nextSync = stale ? delivery.nextSyncAt : operation && nextAttempt || ['blocked', 'uncertain'].includes(state) ? null
      : socialSyncNextAt({ ...delivery, ...data, state, remoteId: refs.remoteId || delivery.remoteId, approvedAt: task.revision.approvedAt }, task.spec, { now, connection: task.connection });
    await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state, remote_id: refs.remoteId || delivery.remoteId, next_sync_at: nextSync, data: JSON.stringify(data) });
    await aggregateTx(tx, campaign);
  }
  return { nextRunAt: nextAttempt, errorCode: lastError?.code || null };
}
async function failureTx(tx, task, caught, now, sent) {
  const code = socialErrorCode(caught), { operation, delivery, campaign } = task;
  if (operation?.state === 'confirmed') return { code, nextRunAt: null };
  const explicitNoEffect = caught.effectAbsent === true && caught.uncertain !== true;
  const uncertain = operation && (operation.state === 'uncertain' || operation.state === 'sent' && (sent ? !explicitNoEffect : true));
  const stale = superseded(task);
  const attempts = (operation?.attempts || delivery?.syncAttempts || 0) + (sent ? 0 : 1);
  const retryAttempts = (operation?.retryAttempts || delivery?.syncAttempts || 0) + 1;
  const transient = ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR', 'BROWSER_BUSY'].includes(code) && (!sent || explicitNoEffect) && !uncertain;
  const next = stale ? null : uncertain ? retryAt(now, (operation.reconcileAttempts || 0) + 1, caught.retryAfter) : transient ? retryAt(now, retryAttempts, caught.retryAfter) : null;
  const lastError = { code: uncertain ? 'OPERATION_UNCERTAIN' : code, message: SOCIAL_ERROR_MESSAGES[uncertain ? 'OPERATION_UNCERTAIN' : code],
    ...(isPause(operation) ? { action: 'Pausa el anuncio directamente en Meta si no se puede verificar aquí; no se ha confirmado que dejó de gastar.' } : {}) };
  if (operation) await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state: uncertain ? 'uncertain' : next ? 'retry_wait' : 'failed', next_attempt_at: next, data: JSON.stringify({ ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id])), attempts, retryAttempts, ...(isRead(task) ? { reconcileAttempts: (operation.reconcileAttempts || 0) + 1 } : {}), lastError }) });
  if (delivery && !stale) {
    await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state: uncertain ? 'uncertain' : next ? delivery.state : 'blocked', next_sync_at: operation ? null : next, data: JSON.stringify({ ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id])), syncAttempts: attempts, lastError }) });
    await aggregateTx(tx, campaign);
  }
  if (code === 'RATE_LIMITED') await deferSocialAccountTx(tx, task.connection, isPause(operation) ? { integrationMethod: 'browser', mode: 'paid', identities: task.connection.identities } : task.spec, next || retryAt(now, 4, caught.retryAfter), { now });
  return { code: lastError.code, nextRunAt: next };
}

async function processJob(store, lease, parts, { now, env, transport }) {
  const clock = jobClock(now);
  let task = null, errorCode = null, nextRunAt = null, browserEntered = false;
  await withLeaseHeartbeat(store, lease, async heartbeat => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(error('TIMEOUT')), STEP_TIMEOUT); timer.unref();
    try {
      task = await writeFenced(store, lease, clock, null, tx => loadTask(tx, parts, clock()));
      if (!task) return;
      nextRunAt = await accountDeadline(store, task, clock()) || futureAt(task, clock());
      if (nextRunAt) return;
      const reading = isRead(task), purpose = isPause(task.operation) ? 'pause' : 'worker';
      await authorizeTask(store, task, env, clock(), { sending: !reading });
      await withBrowserSession(store, task.connection.id, { owner: `social-worker:${lease.key}`, purpose, env, client: transport?.browserClient, fetchImpl: transport?.fetchImpl, now: clock(), signal: controller.signal,
        check: async () => { heartbeat.assertActive(); await assertLease(store, { ...lease, now: clock() }); } }, async browser => {
        browserEntered = true; let sent = false;
        const run = async request => {
          let abort;
          const stopped = new Promise((resolve, reject) => {
            abort = () => reject(controller.signal.aborted ? error('TIMEOUT') : error('LEASE_LOST'));
            if (browser.signal.aborted) abort(); else browser.signal.addEventListener('abort', abort, { once: true });
          });
          try { return await Promise.race([request, stopped]); }
          finally { browser.signal.removeEventListener('abort', abort); }
        };
        try {
          const connector = await createSocialConnector({ connection: browser.connection, credentials: browser.credentials, transport: { browserClient: browser.client } });
          const metricsAt = task.kind === 'sync' && !task.operation ? socialMetricsNextAt({ ...task.delivery, approvedAt: task.revision.approvedAt }, task.spec, { now: clock(), connection: task.connection }) : null;
          if (metricsAt && metricsAt <= clock() && !socialStateReadDue(task.delivery, clock())) {
            let configurationEvidence = null;
            const cycle = task.delivery.metricSync?.cycle;
            if (!cycle || cycle.specHash !== task.revision.specHash || cycle.connectionVersion !== task.connection.version) {
              try {
                const proof = sanitizeResult(await run(connector.inspectDelivery({ delivery: inspectableDelivery(task), spec: task.spec, signal: browser.signal })), task);
                compareObserved(task, proof); await browser.assertActive(); heartbeat.assertActive();
                if (proof.status === 'confirmed' && proof.evidence.remoteRead === true) {
                  await writeFenced(store, lease, clock, browser, async tx => {
                    const fresh = await loadTask(tx, parts, clock());
                    assert(fresh && !fresh.operation && fresh.delivery.version === task.delivery.version && fresh.connection.version === task.connection.version, 'LEASE_LOST');
                    await authorizeTask(tx, fresh, env, clock());
                    await resultTx(tx, fresh, proof, clock(), { reading: true });
                  });
                  configurationEvidence = { verifiedAt: clock(), differences: [] };
                } else configurationEvidence = { verifiedAt: null, differences: ['publication_state_not_confirmed'] };
              } catch (caught) {
                const code = socialErrorCode(caught);
                if (!['SPEC_MISMATCH', 'PERMISSION_REQUIRED', 'LAYOUT_CHANGED', 'PROVIDER_REJECTED'].includes(code)) throw caught;
                configurationEvidence = { verifiedAt: null, differences: [`publication_configuration_not_verified:${code}`] };
              }
            }
            const outcome = await syncSocialDelivery(store, task.delivery.id, { now: clock(), clock, lease, browserSession: browser, connector, signal: browser.signal, configurationEvidence });
            nextRunAt = outcome.nextRunAt; errorCode = outcome.errorCode;
            return;
          }
          const media = await verifiedMedia(task, env);
          const validation = !reading ? await run(connector.validateConnection({ purpose, signal: browser.signal })) : null;
          if (!reading && ['activate', 'resume'].includes(baseStep(task.operation))) {
            // Re-read the original total, remaining amount and end before marking
            // a new effect. An unknown/changed remaining amount is not consent.
            const snapshot = sanitizeResult(await run(connector.inspectDelivery({ delivery: inspectableDelivery(task), operation: nativeOperation(task.operation, task.delivery, task.connection), spec: task.spec, signal: browser.signal })), task);
            assert(snapshot.status === 'confirmed' && snapshot.evidence.remoteRead === true);
            compareObserved(task, snapshot);
            const budget = snapshot.evidence.budget, accepted = task.operation.budgetConfirmation;
            assert(budget && accepted && budget.budgetMinor === accepted.originalBudgetMinor && budget.remainingMinor === accepted.remainingMinor && budget.currency === accepted.currency && budget.startAt === accepted.startAt && budget.endAt === accepted.endAt);
            assert(snapshot.state === (baseStep(task.operation) === 'resume' ? 'paused' : 'ready'));
          }
          task = await writeFenced(store, lease, clock, browser, async tx => {
            const fresh = await loadTask(tx, parts, clock(), task.operation?.id); assert(fresh);
            assert(fresh.operation?.id === task.operation?.id && fresh.revision?.specHash === task.revision?.specHash);
            const credential = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [fresh.connection.id]);
            assert(credential?.version === browser.credentialVersion, 'LEASE_LOST');
            await authorizeTask(tx, fresh, env, clock(), { sending: !reading, validation });
            if (!reading) {
              assert(!['sent', 'uncertain'].includes(fresh.operation.state));
              const data = { ...rawData(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [fresh.operation.id])), attempts: (fresh.operation.attempts || 0) + 1, sentAt: clock(), executedBy: actingActor(fresh) };
              await updateVersioned(tx, 'social_operations', fresh.operation.id, fresh.operation.version, { state: 'sent', data: JSON.stringify(data), next_attempt_at: null });
              fresh.operation = await get(tx, 'social_operations', fresh.operation.id);
              await updateJobProgressTx(tx, lease, { operationId: fresh.operation.id, phase: 'sent', nextRunAt: null }, { now: clock() });
            }
            return fresh;
          });
          sent = !reading;
          const operation = nativeOperation(task.operation, task.delivery, task.connection);
          const request = reading ? connector.inspectDelivery({ delivery: inspectableDelivery(task), operation, purpose, spec: isPause(task.operation) ? null : task.spec, signal: browser.signal })
            : task.kind === 'preflight' ? connector.preflight({ operation, spec: task.spec, query: task.operation.query, media, signal: browser.signal })
              : connector.executeStep({ operation, purpose, spec: isPause(task.operation) ? null : task.spec, media, signal: browser.signal });
          const result = sanitizeResult(await run(request), task); compareObserved(task, result);
          await browser.assertActive(); heartbeat.assertActive();
          await writeFenced(store, lease, clock, browser, async tx => {
            const fresh = await loadTask(tx, parts, clock(), task.operation?.id); assert(fresh);
            assert(fresh.operation?.id === task.operation?.id && fresh.revision?.specHash === task.revision?.specHash);
            const saved = await resultTx(tx, fresh, result, clock(), { reading });
            nextRunAt = saved.nextRunAt; errorCode = saved.errorCode;
            await updateJobProgressTx(tx, lease, { phase: result.status, nextRunAt }, { now: clock() });
          });
        } catch (caught) {
          // A lost lease leaves sent intact; only inspection can settle its effect.
          try {
            const failure = await writeFenced(store, lease, clock, browser, async tx => {
              const fresh = await loadTask(tx, parts, clock(), task.operation?.id);
              return fresh ? failureTx(tx, fresh, caught, clock(), sent) : { code: socialErrorCode(caught), nextRunAt: null };
            }, { allowAborted: true });
            errorCode = failure.code; nextRunAt = failure.nextRunAt;
          } catch (fence) { errorCode = 'LEASE_LOST'; throw fence; }
          throw caught;
        }
      });
    } catch (caught) {
      errorCode ||= socialErrorCode(caught);
      if (!browserEntered && task) {
        const lock = await store.db.get(`SELECT state,lease_until FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser-lock:${task.connection.id}`]);
        if (caught.status === 409 && !caught.errorCode && lock?.state === 'running' && lock.lease_until > clock()) {
          errorCode = 'BROWSER_BUSY'; nextRunAt = after(clock(), 60000);
          await writeFenced(store, lease, clock, null, async tx => {
            if (task.operation) {
              const current = await get(tx, 'social_operations', task.operation.id);
              if (current && activeStates.includes(current.state)) await updateVersioned(tx, 'social_operations', current.id, current.version, { next_attempt_at: nextRunAt });
            } else if (task.delivery) {
              const current = await get(tx, 'social_deliveries', task.delivery.id);
              if (current) await updateVersioned(tx, 'social_deliveries', current.id, current.version, { next_sync_at: nextRunAt });
            }
          });
        }
        else {
          const failure = await writeFenced(store, lease, clock, null, async tx => {
            const fresh = await loadTask(tx, parts, clock(), task.operation?.id); return fresh ? failureTx(tx, fresh, caught, clock(), false) : { code: errorCode, nextRunAt: null };
          });
          errorCode = failure.code; nextRunAt = failure.nextRunAt;
        }
      }
    } finally { clearTimeout(timer); }
  }, { now });
  try { await finishJob(store, lease, { state: nextRunAt ? 'queued' : errorCode ? 'failed' : 'succeeded', data: { nextRunAt }, errorCode, now: clock() }); }
  catch (caught) { if (caught.status === 409) return { errorCode: 'LEASE_LOST' }; throw caught; }
  return { errorCode };
}

// A turn performs bounded stages, never a browser polling loop. The ordinary
// accounting worker only prepares these keys and cannot claim browser contexts.
export async function processSocialBrowserTurn(store, { now = stamp(), maxOperations = 1, env = process.env, transport = null } = {}) {
  now = instant(now); maxOperations = integer(maxOperations, 'Etapas de navegador por turno', 1, 25);
  const clock = jobClock(now);
  await prepareSocialBrowserJobs(store, { now, env });
  let processed = 0, errorCode = null;
  while (processed < maxOperations) {
    const lease = await claimDue(store, env, clock()); if (!lease) break;
    const parts = jobParts(lease.key);
    try {
      const result = await processJob(store, lease, parts, { now: clock(), env, transport });
      errorCode ||= result.errorCode;
    } catch (caught) {
      errorCode ||= caught.status === 409 ? 'LEASE_LOST' : socialErrorCode(caught);
      try { await finishJob(store, lease, { state: 'failed', errorCode, now: clock() }); }
      catch (fence) { if (fence.status !== 409) throw fence; }
    }
    processed++;
  }
  await prepareSocialBrowserJobs(store, { now: clock(), env });
  const { finalizeSocialBrowserDisconnects } = await import('./social-connections.mjs');
  await finalizeSocialBrowserDisconnects(store, { now: clock() });
  return { processed, errorCode, hasMore: await hasDueJob(store, env, clock()) };
}

export async function processSocialTurn(store, { now = stamp(), maxOperations = 5, env = process.env, transport = {} } = {}) {
  now = instant(now); integer(maxOperations, 'Máximo de operaciones sociales', 1, 100);
  const clock = jobClock(now);
  const browserPreparation = await prepareSocialBrowserJobs(store, { now: clock(), env });
  const assets = await processSocialAssetTurn(store, { now: clock(), maxAssets: 1, env });
  const remaining = maxOperations - assets.processed;
  const api = remaining > 0
    ? await processSocialApiTurn(store, { now: clock(), maxOperations: remaining, env, transport })
    : { processed: 0, errorCode: null, hasMore: (await prepareSocialApiJobs(store, { now: clock(), env })).hasMore };
  // The separate browser process owns that backlog; it must never keep the
  // ordinary payroll/import consumer spinning while its runner is unavailable.
  return { assets, api, browserPreparation, processed: assets.processed + api.processed,
    errorCode: assets.errorCode || api.errorCode || null, hasMore: assets.hasMore || api.hasMore };
}
