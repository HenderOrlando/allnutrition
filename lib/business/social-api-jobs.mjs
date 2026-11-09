import { fail, integer } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { assertLease, audit, entity, hash, insertRow, newId, stamp, updateVersioned } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, updateJobProgressTx, withLeaseHeartbeat } from './job-leases.mjs';
import { openSocialAssetContent } from './social-media.mjs';
import { aggregateSocialCampaignState } from './social-jobs.mjs';
import { socialAccountNotBefore, deferSocialAccountTx } from './social-schedule.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { loadCredentials } from '../social/credentials.mjs';
import { loadSocialRuntime } from '../social/config.mjs';
import { initialMetaPublishingStep } from '../social/meta-publishing.mjs';
import { metaBudgetUnits } from '../social/meta.mjs';
import { socialErrorCode, socialPermalink, SOCIAL_ERROR_MESSAGES } from '../social/evidence.mjs';
import { socialMetricLifecycle, socialMetricsNextAt, socialStateReadDue, socialSyncNextAt, syncSocialDelivery } from './social-metrics.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^social:(delivery|sync):(.+)$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^\d{1,30}(?:_\d{1,30})?$/;
const BACKOFF = [60000, 300000, 900000, 3600000];
const ACTIVE_OPERATIONS = ['prepared', 'retry_wait', 'sent', 'uncertain'];
const STATES = ['preparing', 'ready', 'scheduled', 'publishing', 'published', 'in_review', 'active', 'paused', 'completed', 'failed'];
const IDENTITIES = ['userId', 'businessId', 'pageId', 'instagramId', 'adAccountId'];
const raw = row => JSON.parse(row?.data || '{}');
const after = (now, ms) => new Date(Date.parse(now) + ms).toISOString();
const root = operation => operation?.step?.split(':')[0];
const control = operation => ['activate', 'pause', 'resume'].includes(root(operation));
const pause = task => root(task.operation) === 'pause';
const reading = task => task.kind === 'sync' || ['sent', 'uncertain'].includes(task.operation?.state);
const partsOf = key => { const match = JOB.exec(key || ''); return match && UUID.test(match[2]) ? { kind: match[1], id: match[2] } : null; };
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const error = code => Object.assign(new Error(SOCIAL_ERROR_MESSAGES[code] || SOCIAL_ERROR_MESSAGES.PROVIDER_ERROR), { errorCode: code, status: 409 });
const requireThat = (value, code = 'SPEC_MISMATCH') => { if (!value) throw error(code); };
const jsonField = (store, alias, field) => store.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${field}')` : `${alias}.data::jsonb->>'${field}'`;
const due = store => `(${jsonField(store, 'j', 'nextRunAt')} IS NULL OR ${jsonField(store, 'j', 'nextRunAt')}<=?)`;
const sameIdentities = (a, b) => !!a?.userId && !!a?.businessId && IDENTITIES.every(key => (a[key] || null) === (b?.[key] || null));
const samePauseIdentity = (a, b) => !!a?.userId && !!a?.adAccountId && a.userId === b?.userId && a.adAccountId === b?.adAccountId;

export async function queueSocialApiJobTx(tx, { kind, id, nextRunAt = null }, { now = stamp() } = {}) {
  if (!['delivery', 'sync'].includes(kind) || !UUID.test(id || '')) fail('Trabajo social de API no válido.');
  now = instant(now); if (nextRunAt) nextRunAt = instant(nextRunAt);
  const key = `social:${kind}:${id}`, old = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (old?.state === 'running' && old.lease_until > now) return false;
  if (old?.state === 'queued' && (!raw(old).nextRunAt || nextRunAt && raw(old).nextRunAt <= nextRunAt)) return false;
  await queueJobTx(tx, key, { kind, id, nextRunAt }, { now });
  return true;
}
function currentOperation(delivery, operations) {
  const intent = delivery.controlIntent;
  const current = operations.find(operation => control(operation) && operation.controlId === intent?.id && root(operation) === intent.kind);
  if (current && ACTIVE_OPERATIONS.includes(current.state)) return current;
  // A newer control suppresses earlier writes forever, but never erases their
  // uncertain journal. Such records can still be inspected explicitly/by sync.
  const unresolved = operations.find(operation => ['sent', 'uncertain'].includes(operation.state));
  if (unresolved) return unresolved;
  if (intent) return null;
  return operations.find(operation => !control(operation) && ACTIVE_OPERATIONS.includes(operation.state)) || null;
}
async function loadTask(store, parts, { operationId = null } = {}) {
  const delivery = await get(store, 'social_deliveries', parts.id);
  if (!delivery) return null;
  const campaign = await get(store, 'social_campaigns', delivery.campaignId);
  const connection = campaign && await get(store, 'social_connections', campaign.connectionId);
  const revision = campaign && entity(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [campaign.id, delivery.revision]));
  const operations = (await store.db.all(`SELECT * FROM ${store.t('social_operations')} WHERE delivery_id=? ORDER BY created_at,id`, [delivery.id])).map(entity);
  const operation = operationId ? operations.find(value => value.id === operationId) : parts.kind === 'delivery' ? currentOperation(delivery, operations) : operations.find(value => ['sent', 'uncertain'].includes(value.state)) || null;
  const spec = revision?.spec, asset = spec?.assetId && await get(store, 'social_assets', spec.assetId);
  const credential = connection && await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  return { ...parts, delivery, campaign, connection, revision, spec, asset, operation, operations, credentialVersion: credential?.version ?? null };
}
function superseded(task) {
  const { operation, delivery } = task;
  if (control(operation)) return delivery.controlIntent?.id !== operation.controlId || delivery.controlIntent?.kind !== root(operation);
  return !!delivery.controlIntent || ['cancelled', 'completed'].includes(delivery.state);
}
function futureAt(task, now) {
  if (task.operation?.nextAttemptAt > now) return task.operation.nextAttemptAt;
  if (task.kind === 'sync') return task.delivery.nextSyncAt > now ? task.delivery.nextSyncAt : null;
  if (!reading(task) && task.spec?.mode === 'organic') {
    const when = task.spec.publishAt || task.revision?.approvedAt;
    if (when > now) return when;
  }
  return null;
}
function runnable(task, runtime, now) {
  if (!task?.connection || task.connection.integrationMethod !== 'api' || task.delivery.integrationMethod !== 'api') return false;
  if (task.kind === 'sync') return !!task.delivery.nextSyncAt && task.delivery.nextSyncAt <= now;
  if (!task.operation && (task.operations.length || !['queued', 'scheduled', 'preparing'].includes(task.delivery.state))) return false;
  if (task.operation && (!ACTIVE_OPERATIONS.includes(task.operation.state) || task.operation.nextAttemptAt > now || task.operation.state === 'uncertain' && !task.operation.nextAttemptAt)) return false;
  if (reading(task) || pause(task)) return true;
  if (!runtime.publishingEnabled || task.campaign.restoreHold || task.campaign.restore_hold || superseded(task)) return false;
  return true;
}
async function candidates(store, now) {
  return store.db.all(`SELECT j.key FROM ${store.t('job_runs')} j WHERE (j.key LIKE 'social:delivery:%' OR j.key LIKE 'social:sync:%') AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?)) AND ${due(store)} ORDER BY j.created_at,j.key`, [now, now]);
}
async function eligible(store, parts, env, now) {
  const task = await loadTask(store, parts);
  if (!runnable(task, await loadSocialRuntime(store, { env }), now) || futureAt(task, now)) return false;
  return await socialAccountNotBefore(store, task.connection, task.spec, { now }) ? null : task;
}
async function hasDue(store, env, now) {
  for (const row of await candidates(store, now)) { const parts = partsOf(row.key); if (parts && await eligible(store, parts, env, now)) return true; }
  return false;
}
async function claimDue(store, env, now) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    let first = null;
    for (const row of await candidates(tx, now)) {
      const parts = partsOf(row.key);
      const task = parts && await eligible(tx, parts, env, now);
      if (!task) continue;
      if (pause(task)) return claimJob({ transaction: fn => fn(tx) }, { key: row.key, now });
      first ||= row.key;
    }
    return first ? claimJob({ transaction: fn => fn(tx) }, { key: first, now }) : null;
  });
}
export async function prepareSocialApiJobs(store, { now = stamp(), env = process.env } = {}) {
  now = instant(now); let queued = 0;
  await store.transaction(async tx => {
    await tx.lockWrites();
    const runtime = await loadSocialRuntime(tx, { env });
    const rows = await tx.db.all(`SELECT d.id FROM ${tx.t('social_deliveries')} d JOIN ${tx.t('social_campaigns')} c ON c.id=d.campaign_id JOIN ${tx.t('social_connections')} n ON n.id=c.connection_id WHERE n.integration_method='api' AND ${jsonField(tx, 'd', 'integrationMethod')}='api' AND (d.state IN ('queued','scheduled','preparing') OR EXISTS (SELECT 1 FROM ${tx.t('social_operations')} o WHERE o.delivery_id=d.id AND o.state IN ('prepared','sent','retry_wait','uncertain') AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?)) OR (d.next_sync_at IS NOT NULL AND d.next_sync_at<=?)) ORDER BY d.updated_at,d.id`, [now, now]);
    for (const row of rows) {
      const task = await loadTask(tx, { kind: 'delivery', id: row.id });
      if (runnable(task, runtime, now)) {
        const notBefore = await socialAccountNotBefore(tx, task.connection, task.spec, { now });
        const future = futureAt(task, now);
        queued += Number(await queueSocialApiJobTx(tx, { kind: 'delivery', id: row.id, nextRunAt: notBefore && (!future || notBefore > future) ? notBefore : future }, { now }));
      }
      if (task.delivery.nextSyncAt && task.delivery.nextSyncAt <= now) {
        const notBefore = await socialAccountNotBefore(tx, task.connection, task.spec, { now });
        queued += Number(await queueSocialApiJobTx(tx, { kind: 'sync', id: row.id, nextRunAt: notBefore }, { now }));
      }
    }
  });
  return { queued, hasMore: await hasDue(store, env, now) };
}
async function fenced(store, lease, clock, fn) {
  return store.transaction(async tx => { await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() }); const result = await fn(tx); await assertLease(tx, { ...lease, now: clock() }); return result; });
}
async function aggregate(tx, campaign) {
  const state = aggregateSocialCampaignState(await tx.db.all(`SELECT state FROM ${tx.t('social_deliveries')} WHERE campaign_id=?`, [campaign.id]), campaign.mode);
  if (state && state !== campaign.state) await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state });
}
async function active(store, id) { return !!id && !!await store.db.get(`SELECT id FROM ${store.t('users')} WHERE id=? AND active=1`, [id]); }
function effectiveApprover(task) {
  const authorization = task.campaign.restoredAuthorization;
  if (!authorization) return task.revision.actorId;
  requireThat(authorization.specHash === task.revision.specHash && authorization.rightsAccepted === true && typeof authorization.actorId === 'string' && Number.isFinite(Date.parse(authorization.acceptedAt)) && Array.isArray(authorization.acceptedWarnings) && (task.revision.acceptedWarnings || []).every(warning => authorization.acceptedWarnings.includes(warning)), 'RESTORE_HOLD');
  return authorization.actorId;
}
function actingActor(task) { return !control(task.operation) && task.campaign.restoredAuthorization ? effectiveApprover(task) : task.operation.actorId; }
async function authorize(store, task, runtime, now, { sending = false, validation = null } = {}) {
  const { delivery, campaign, connection, revision, operation, spec, asset } = task;
  requireThat(connection?.integrationMethod === 'api' && delivery.integrationMethod === 'api');
  requireThat(campaign && revision && spec?.integrationMethod === 'api' && spec.connectionId === connection.id && campaign.connectionId === connection.id);
  requireThat(revision.specHash === hash(spec));
  requireThat((pause(task) ? samePauseIdentity : sameIdentities)(spec.identities, connection.identities), 'ACCOUNT_MISMATCH');
  requireThat(connection.state === 'connected' || pause(task) && connection.state === 'reconnect_required', 'SESSION_EXPIRED');
  if (operation) {
    requireThat(operation.integrationMethod === 'api' && operation.deliveryId === delivery.id && operation.campaignId === campaign.id && operation.channel === delivery.channel);
    requireThat(operation.operationKey === `delivery:${delivery.id}:${operation.step}` && operation.specHash === revision.specHash);
  }
  if (!sending) return;
  requireThat(operation && !superseded(task));
  requireThat(await active(store, actingActor(task)), 'PERMISSION_REQUIRED');
  if (operation.resolution?.kind === 'absent') requireThat(operation.resolution.acceptDuplicateRisk === true && Number.isFinite(Date.parse(operation.resolution.confirmedAt)) && await active(store, operation.resolution.actorId), 'PERMISSION_REQUIRED');
  if (validation) {
    requireThat(validation.state === 'connected' && (pause(task) ? samePauseIdentity : sameIdentities)(spec.identities, validation.identities), 'ACCOUNT_MISMATCH');
    const capability = spec.mode === 'paid' ? 'adsPublish' : delivery.channel === 'instagram' ? 'instagramPublish' : 'facebookPublish';
    if (!pause(task)) requireThat(validation.capabilities?.[capability] === true, 'PERMISSION_REQUIRED');
    if (spec.mode === 'paid' && spec.objective === 'whatsapp' && !pause(task)) requireThat(validation.capabilities.whatsappAds === true, 'PERMISSION_REQUIRED');
  }
  if (pause(task)) { requireThat(campaign.mode === 'paid' && ID.test(delivery.remoteId || delivery.remoteRefs?.campaignId || ''), 'ACCOUNT_MISMATCH'); return; }
  requireThat(runtime.publishingEnabled, 'PUBLISHING_DISABLED');
  requireThat(revision.configurationFingerprint === runtime.fingerprint && !connection.revalidationRequired, 'CONFIGURATION_CHANGED');
  requireThat(!campaign.restore_hold && !campaign.restoreHold, 'RESTORE_HOLD');
  requireThat(revision.rightsAccepted === true && await active(store, effectiveApprover(task)), 'PERMISSION_REQUIRED');
  requireThat(revision.forecast && revision.forecast.specHash === revision.specHash);
  requireThat(campaign.assetId === spec.assetId && asset?.state === 'ready' && asset.sha256 === spec.assetHash && asset.derivativeSha256 === spec.assetHash, 'MISSING_FILE');
  requireThat(spec.aiDisclosure !== true || spec.mode !== 'paid' && (delivery.channel !== 'facebook' || asset.kind === 'video'), 'PERMISSION_REQUIRED');
  requireThat(delivery.channel === 'meta_ads' ? spec.mode === 'paid' : spec.mode === 'organic' && spec.platforms.includes(delivery.channel));
  for (const key of Object.keys(spec)) if (Object.hasOwn(campaign, key) && !['identities'].includes(key)) requireThat(hash(campaign[key]) === hash(spec[key]));
  if (spec.mode === 'paid') {
    requireThat(spec.currency === connection.currency && spec.timeZone === connection.timeZone && Number.isSafeInteger(spec.budgetMinor) && spec.budgetMinor > 0);
    metaBudgetUnits(spec.budgetMinor, spec.currency);
    requireThat(Number.isFinite(Date.parse(spec.startAt)) && Date.parse(spec.endAt) > Date.parse(spec.startAt) && Date.parse(spec.endAt) - Date.parse(spec.startAt) <= 90 * 86400000);
    if (validation) requireThat(validation.currency === spec.currency && validation.timeZone === spec.timeZone);
    if (['activate', 'resume'].includes(root(operation))) {
      requireThat(operation.investmentAccepted === true && operation.preparedRefs && delivery.preparedRefs && hash(operation.preparedRefs) === hash(delivery.preparedRefs));
      const budget = operation.budgetConfirmation;
      requireThat(budget && Number.isSafeInteger(budget.remainingMinor) && budget.remainingMinor >= 0 && budget.remainingMinor <= spec.budgetMinor && budget.originalBudgetMinor === spec.budgetMinor && budget.currency === spec.currency && budget.startAt === spec.startAt && budget.endAt === spec.endAt);
      requireThat(Date.parse(spec.endAt) > Date.parse(now), 'SCHEDULE_MISSED');
      if (root(operation) === 'activate' && !delivery.everActivated) requireThat(Date.parse(now) - Date.parse(spec.startAt) <= 900000, 'SCHEDULE_MISSED');
    }
  } else {
    const when = spec.publishAt || revision.approvedAt;
    requireThat(Number.isFinite(Date.parse(when)) && now >= when && Date.parse(now) - Date.parse(when) <= 900000, 'SCHEDULE_MISSED');
  }
}
async function insertOperation(tx, task, step, now, extra = {}) {
  requireThat(typeof step === 'string' && /^[a-z][a-z0-9_:-]{0,120}$/.test(step));
  const prior = await tx.db.get(`SELECT id FROM ${tx.t('social_operations')} WHERE delivery_id=? AND step=?`, [task.delivery.id, step]);
  if (prior) return get(tx, 'social_operations', prior.id);
  const id = newId();
  await insertRow(tx, 'social_operations', { id, campaign_id: task.campaign.id, delivery_id: task.delivery.id, operation_key: `delivery:${task.delivery.id}:${step}`, step, state: 'prepared', next_attempt_at: null, data: JSON.stringify({ integrationMethod: 'api', configurationFingerprint: task.revision.configurationFingerprint, actorId: effectiveApprover(task), specHash: task.revision.specHash, channel: task.delivery.channel, ...extra }), version: 1, created_at: now, updated_at: now });
  return get(tx, 'social_operations', id);
}
function refs(value) {
  const result = {};
  for (const key of ['remoteId', 'campaignId', 'adSetId', 'creativeId', 'adId', 'photoId', 'postId', 'videoId', 'mediaId', 'containerId', 'uploadSessionId', 'imageHash']) {
    if (value?.[key] === undefined) continue;
    const format = key === 'imageHash' ? /^[a-f0-9]{32,64}$/i : ['remoteId', 'postId'].includes(key) ? ID : /^\d{1,30}$/;
    requireThat(typeof value[key] === 'string' && format.test(value[key])); result[key] = value[key];
  }
  if (value?.permalink) result.permalink = socialPermalink(value.permalink);
  return result;
}
function progress(value) {
  const result = {};
  for (const key of ['offset', 'endOffset']) if (value?.[key] !== undefined) {
    requireThat(Number.isSafeInteger(value[key]) && value[key] >= 0);
    result[key] = value[key];
  }
  if (value?.controlStage !== undefined) {
    requireThat(['ad', 'adset', 'campaign', 'confirm'].includes(value.controlStage));
    result.controlStage = value.controlStage;
  }
  return result;
}
function sanitize(result) {
  requireThat(['confirmed', 'pending', 'uncertain'].includes(result?.status));
  if (result.state != null) requireThat(STATES.includes(result.state));
  if (result.nextStep != null) requireThat(typeof result.nextStep === 'string' && /^[a-z][a-z0-9_:-]{0,120}$/.test(result.nextStep));
  const evidence = { adapterVersion: 'meta-api-v1', apiVersion: 'v26.0' }, remoteRefs = refs(result.remoteRefs);
  if (result.evidence?.source === 'operator_verified') evidence.source = 'operator_verified';
  for (const key of ['remoteRead', 'specVerified', 'deliveryStopped', 'endConfirmed', 'everActivated']) if (typeof result.evidence?.[key] === 'boolean') evidence[key] = result.evidence[key];
  for (const key of ['state', 'effectiveStatus', 'configuredStatus', 'reasonCode', 'phase', 'remoteState']) if (typeof result.evidence?.[key] === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(result.evidence[key])) evidence[key] = result.evidence[key];
  // Arbitrary error strings and provider payloads are intentionally not copied.
  if (Number.isSafeInteger(result.evidence?.providerCode)) evidence.providerCode = result.evidence.providerCode;
  if (result.evidence?.errorCode && Object.hasOwn(SOCIAL_ERROR_MESSAGES, result.evidence.errorCode)) { evidence.errorCode = result.evidence.errorCode; evidence.reason = SOCIAL_ERROR_MESSAGES[result.evidence.errorCode]; }
  if (result.evidence?.budget) {
    const budget = result.evidence.budget;
    requireThat(Number.isSafeInteger(budget.budgetMinor) && budget.budgetMinor >= 0 && (budget.remainingMinor === null || Number.isSafeInteger(budget.remainingMinor) && budget.remainingMinor >= 0 && budget.remainingMinor <= budget.budgetMinor) && /^[A-Z]{3}$/.test(budget.currency));
    evidence.budget = { budgetMinor: budget.budgetMinor, remainingMinor: budget.remainingMinor, currency: budget.currency, startAt: instant(budget.startAt), endAt: instant(budget.endAt) };
  }
  if (result.state === 'failed') {
    evidence.errorCode = 'PROVIDER_REJECTED'; evidence.reason = SOCIAL_ERROR_MESSAGES.PROVIDER_REJECTED;
    if (remoteRefs.adId) evidence.managerUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${remoteRefs.adId}`;
  }
  return { status: result.status, operationComplete: result.operationComplete !== false, state: result.state || null, remoteRefs, preparedRefs: result.preparedRefs ? refs(result.preparedRefs) : null, nextStep: result.nextStep || null, progress: progress(result.progress), retryAfter: Number.isFinite(result.retryAfter) && result.retryAfter >= 0 ? result.retryAfter : null, evidence };
}
function retryAt(now, attempt, retryAfter) { const delay = BACKOFF[attempt - 1]; return delay ? after(now, Math.max(delay, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)) : null; }
function nativeOperation(task) {
  const remoteRefs = { ...task.delivery.remoteRefs };
  if (task.spec.mode === 'paid' && !remoteRefs.campaignId && task.delivery.remoteId) remoteRefs.campaignId = task.delivery.remoteId;
  return { ...task.operation, deliveryId: task.delivery.id, channel: task.delivery.channel, remoteRefs, progress: task.operation.progress || {}, everActivated: task.delivery.everActivated === true };
}
async function persistResult(tx, task, result, now) {
  const { operation, delivery, campaign } = task;
  const stale = operation && superseded(task);
  const confirmed = result.status === 'confirmed', checkpoint = confirmed && !result.operationComplete;
  const complete = confirmed && result.operationComplete;
  const remoteRefs = { ...delivery.remoteRefs, ...result.remoteRefs };
  if (confirmed && result.state && task.spec.mode === 'paid' && !remoteRefs.remoteId && remoteRefs.campaignId) remoteRefs.remoteId = remoteRefs.campaignId;
  if (delivery.remoteId && result.remoteRefs.remoteId) requireThat(delivery.remoteId === result.remoteRefs.remoteId, 'ACCOUNT_MISMATCH');
  let state = delivery.state;
  if (!stale && confirmed && result.state) {
    if (['published', 'active', 'paused', 'ready', 'scheduled', 'in_review', 'completed', 'failed'].includes(result.state)) requireThat(result.evidence.remoteRead === true && (remoteRefs.remoteId || delivery.remoteId), 'OPERATION_UNCERTAIN');
    if (result.state === 'published') requireThat(remoteRefs.permalink, 'OPERATION_UNCERTAIN');
    state = result.state === 'ready' && delivery.everActivated ? 'paused' : result.state;
    if (result.state === 'paused' && operation?.cancelAfterPause === true || delivery.state === 'cancelled' && ['paused', 'ready'].includes(result.state)) state = 'cancelled';
  } else if (!stale && result.status === 'uncertain') state = 'uncertain';
  else if (!stale && result.status === 'pending' && !['active', 'paused', 'published'].includes(state)) state = 'preparing';
  const nextAttempt = stale ? null : result.status === 'pending' ? after(now, Math.max(300000, (result.retryAfter || 0) * 1000)) : result.status === 'uncertain' ? retryAt(now, (operation?.reconcileAttempts || 0) + 1, result.retryAfter) : checkpoint || result.nextStep ? now : null;
  const lastError = result.status === 'uncertain' ? { code: 'OPERATION_UNCERTAIN', message: SOCIAL_ERROR_MESSAGES.OPERATION_UNCERTAIN } : result.state === 'failed' ? { code: 'PROVIDER_REJECTED', message: SOCIAL_ERROR_MESSAGES.PROVIDER_REJECTED } : null;
  if (operation) {
    const receipts = operation.receipts || [];
    requireThat(Array.isArray(receipts));
    const receipt = confirmed ? { confirmedAt: now, payloadHash: operation.payloadHash || null, phase: operation.phase || null, operationComplete: result.operationComplete, remoteRefs: result.remoteRefs, progress: result.progress, evidence: result.evidence } : null;
    const data = { ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id])), result, progress: { ...operation.progress, ...result.progress }, ...(receipt ? { receipts: [...receipts, receipt], retryAttempts: 0 } : {}), reconcileAttempts: result.status === 'uncertain' ? (operation.reconcileAttempts || 0) + 1 : confirmed ? 0 : operation.reconcileAttempts || 0, lastError };
    await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state: complete ? 'confirmed' : checkpoint ? 'prepared' : result.status === 'pending' ? operation.state === 'sent' || operation.state === 'uncertain' ? 'sent' : 'prepared' : 'uncertain', next_attempt_at: nextAttempt, data: JSON.stringify(data) });
    await audit(tx, { entityType: 'social_operation', entityId: operation.id, actorId: operation.executedBy || operation.actorId, next: { step: operation.step, state: complete ? 'confirmed' : checkpoint ? 'prepared' : result.status, checkpoint }, source: 'scheduler', recordedAt: now });
    if (!stale && complete && result.nextStep) { requireThat(!control(operation)); await insertOperation(tx, task, result.nextStep, now, Object.keys(result.progress).length ? { progress: result.progress } : {}); }
  }
  // A confirmed campaign-stage checkpoint proves activation even if a newer
  // pause superseded its executor before the final aggregate read returned.
  const activationProved = confirmed && (result.state === 'active' || result.evidence.everActivated === true || ['activate', 'resume'].includes(root(operation)) && result.progress.controlStage === 'confirm');
  const everActivated = delivery.everActivated === true || activationProved;
  const data = {
    ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id])),
    remoteRefs,
    everActivated,
    ...(activationProved && !delivery.activatedAt ? { activatedAt: now } : {}),
    ...(confirmed && !stale ? { ...socialMetricLifecycle(delivery, { state }, { operation, now }), lastStateReadAt: now } : {}),
    ...(confirmed && !stale ? { lastConfirmedAt: now, ...(result.state ? { lastConfirmedState: state === 'cancelled' ? 'paused' : state } : {}) } : {}),
    ...(result.preparedRefs && !stale ? { preparedRefs: result.preparedRefs } : {}),
    ...(result.evidence.budget && !stale ? { budgetSnapshot: { ...result.evidence.budget, checkedAt: now } } : {}),
    ...(!stale ? { evidence: result.evidence, lastError, syncAttempts: 0 } : {})
  };
  const nextSync = stale ? delivery.nextSyncAt : operation && (nextAttempt || result.nextStep) ? null
    : socialSyncNextAt({ ...delivery, ...data, state, remoteId: remoteRefs.remoteId || delivery.remoteId, approvedAt: task.revision.approvedAt }, task.spec, { now, connection: task.connection });
  await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state, remote_id: remoteRefs.remoteId || delivery.remoteId, next_sync_at: nextSync, data: JSON.stringify(data) });
  await aggregate(tx, campaign);
  return { nextRunAt: nextAttempt, errorCode: lastError?.code || null };
}
function publicCode(caught) {
  if (caught?.errorCode && Object.hasOwn(SOCIAL_ERROR_MESSAGES, caught.errorCode)) return caught.errorCode;
  if (caught?.kind === 'reconnect_required' || caught?.code === 190) return 'SESSION_EXPIRED';
  return ({ permission: 'PERMISSION_REQUIRED', rate_limit: 'RATE_LIMITED', account_mismatch: 'ACCOUNT_MISMATCH', rejected: 'PROVIDER_REJECTED', aborted: 'TIMEOUT' })[caught?.kind] || socialErrorCode(caught);
}
async function persistFailure(tx, task, caught, now, { inspecting = false } = {}) {
  const { operation, delivery, campaign, connection } = task;
  if (operation?.state === 'confirmed') return { nextRunAt: null, errorCode: publicCode(caught) };
  const code = publicCode(caught), sent = ['sent', 'uncertain'].includes(operation?.state);
  const noEffect = caught?.effectAbsent === true || caught?.uncertain === false && ['rate_limit', 'unavailable', 'permission', 'rejected', 'reconnect_required'].includes(caught.kind);
  const uncertain = sent && (inspecting || !noEffect || operation.state === 'uncertain');
  const attempts = (operation ? operation.attempts || 0 : delivery.syncAttempts || 0) + (sent ? 0 : 1);
  const retryAttempts = (operation ? operation.retryAttempts || 0 : delivery.syncAttempts || 0) + 1;
  const reconcileAttempts = (operation?.reconcileAttempts || 0) + 1;
  const transient = ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR'].includes(code);
  const next = uncertain ? retryAt(now, reconcileAttempts, caught.retryAfter) : transient && (!sent || noEffect) ? retryAt(now, retryAttempts, caught.retryAfter) : null;
  const lastError = { code: uncertain ? 'OPERATION_UNCERTAIN' : code, message: SOCIAL_ERROR_MESSAGES[uncertain ? 'OPERATION_UNCERTAIN' : code] || SOCIAL_ERROR_MESSAGES.PROVIDER_ERROR, ...(Number.isSafeInteger(caught?.code) ? { providerCode: caught.code } : {}) };
  const held = ['PUBLISHING_DISABLED', 'RESTORE_HOLD'].includes(code) && !sent;
  if (operation) await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state: uncertain ? 'uncertain' : next || held ? 'retry_wait' : 'failed', next_attempt_at: next, data: JSON.stringify({ ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operation.id])), attempts, retryAttempts, ...(sent ? { reconcileAttempts } : {}), lastError }) });
  if (!operation || !superseded(task)) {
    await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state: uncertain ? 'uncertain' : next || held ? delivery.state : 'blocked', next_sync_at: operation ? null : next, data: JSON.stringify({ ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id])), syncAttempts: attempts, lastError }) });
    await aggregate(tx, campaign);
  }
  if (code === 'RATE_LIMITED') await deferSocialAccountTx(tx, connection, task.spec, next || after(now, Math.max(3600000, (caught.retryAfter || 0) * 1000)), { now });
  if (code === 'SESSION_EXPIRED' && connection.state !== 'disconnected') await updateVersioned(tx, 'social_connections', connection.id, connection.version, { state: 'reconnect_required' });
  return { nextRunAt: next, errorCode: lastError.code };
}
async function processMetrics(store, task, connector, { lease, clock, signal, heartbeat, env }) {
  let configurationEvidence = null;
  const cycle = task.delivery.metricSync?.cycle;
  if (!cycle || cycle.specHash !== task.revision.specHash || cycle.connectionVersion !== task.connection.version) {
    try {
      const proof = sanitize(await connector.inspectDelivery({ delivery: task.delivery, spec: task.spec, signal }));
      heartbeat.assertActive(); signal.throwIfAborted();
      if (proof.status === 'confirmed' && proof.evidence.remoteRead === true) {
        await fenced(store, lease, clock, async tx => {
          const fresh = await loadTask(tx, { kind: 'sync', id: task.delivery.id });
          requireThat(fresh && !fresh.operation && fresh.delivery.version === task.delivery.version && fresh.connection.version === task.connection.version && fresh.credentialVersion === task.credentialVersion, 'LEASE_LOST');
          await authorize(tx, fresh, await loadSocialRuntime(tx, { env }), clock());
          await persistResult(tx, fresh, proof, clock());
        });
        configurationEvidence = { verifiedAt: clock(), differences: [] };
      } else configurationEvidence = { verifiedAt: null, differences: ['publication_state_not_confirmed'] };
    } catch (caught) {
      const code = publicCode(caught);
      if (!['SPEC_MISMATCH', 'PERMISSION_REQUIRED', 'LAYOUT_CHANGED', 'PROVIDER_REJECTED'].includes(code) && caught.kind !== 'invalid_response') throw caught;
      configurationEvidence = { verifiedAt: null, differences: [`publication_configuration_not_verified:${caught.kind === 'invalid_response' ? 'invalid_response' : code}`] };
    }
  }
  return syncSocialDelivery(store, task.delivery.id, { now: clock(), clock, lease, connector, signal, configurationEvidence });
}

async function processJob(store, lease, parts, { now, env, transport }) {
  const clock = jobClock(now); let task, media = null, nextRunAt = null, errorCode = null, leaseWatch = null, committed = false, inspecting = false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(error('TIMEOUT')), 300000); timer.unref();
  try {
    await withLeaseHeartbeat(store, lease, async heartbeat => {
      leaseWatch = setInterval(() => { try { heartbeat.assertActive(); } catch { controller.abort(error('LEASE_LOST')); } }, 1000); leaseWatch.unref();
      task = await fenced(store, lease, clock, async tx => {
        const runtime = await loadSocialRuntime(tx, { env });
        const fresh = await loadTask(tx, parts); if (!fresh || !runnable(fresh, runtime, clock())) return null;
        fresh.runtime = runtime;
        if (parts.kind === 'delivery' && !fresh.operation) fresh.operation = await insertOperation(tx, fresh, initialMetaPublishingStep({ spec: fresh.spec, kind: fresh.asset?.kind, channel: fresh.delivery.channel }), clock());
        return fresh;
      });
      if (!task) return;
      const runtime = task.runtime;
      inspecting = reading(task);
      await authorize(store, task, await loadSocialRuntime(store, { env }), clock(), { sending: !reading(task) });
      const credentials = await loadCredentials(store, task.connection, runtime);
      const connector = await createSocialConnector({ connection: task.connection, credentials, runtime, transport: { fetchImpl: transport.fetchImpl, now: () => Date.parse(clock()) } });
      const metricsAt = parts.kind === 'sync' && !task.operation ? socialMetricsNextAt({ ...task.delivery, approvedAt: task.revision.approvedAt }, task.spec, { now: clock(), connection: task.connection }) : null;
      if (metricsAt && metricsAt <= clock() && !socialStateReadDue(task.delivery, clock())) {
        const outcome = await processMetrics(store, task, connector, { lease, clock, signal: controller.signal, heartbeat, env });
        committed = true; nextRunAt = outcome.nextRunAt; errorCode = outcome.errorCode;
        return;
      }
      const validation = !reading(task) ? await connector.validateConnection({ signal: controller.signal, ...(pause(task) ? { purpose: 'pause' } : {}) }) : null;
      if (!reading(task) && !pause(task)) {
        try { media = { ...await openSocialAssetContent(store, task.spec.assetId, { env }), assetId: task.asset.id, key: task.asset.derivativeKey }; requireThat(media.sha256 === task.spec.assetHash, 'MISSING_FILE'); }
        catch { throw error('MISSING_FILE'); }
      }
      const operationId = task.operation?.id;
      const beforeSend = async ({ payloadHash, phase }) => {
        requireThat(HASH.test(payloadHash || '') && typeof phase === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(phase));
        heartbeat.assertActive(); controller.signal.throwIfAborted();
        task = await fenced(store, lease, clock, async tx => {
          const fresh = await loadTask(tx, parts, { operationId }); requireThat(fresh?.operation);
          const currentRuntime = await loadSocialRuntime(tx, { env });
          await authorize(tx, fresh, currentRuntime, clock(), { sending: true, validation });
          if (!pause(fresh)) requireThat(currentRuntime.configurationVersion === runtime.configurationVersion, 'CONFIGURATION_CHANGED');
          requireThat(!['sent', 'uncertain', 'confirmed', 'failed'].includes(fresh.operation.state));
          requireThat(fresh.operation.version === task.operation.version && fresh.delivery.version === task.delivery.version && fresh.revision.specHash === task.revision.specHash && fresh.connection.version === task.connection.version && fresh.credentialVersion === task.credentialVersion && (pause(fresh) || fresh.asset?.version === task.asset?.version));
          const wait = await socialAccountNotBefore(tx, fresh.connection, fresh.spec, { now: clock() }); requireThat(!wait, 'RATE_LIMITED');
          const data = { ...raw(await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operationId])), payloadHash, phase, sentAt: clock(), attempts: (fresh.operation.attempts || 0) + 1, executedBy: actingActor(fresh) };
          await updateVersioned(tx, 'social_operations', operationId, fresh.operation.version, { state: 'sent', next_attempt_at: null, data: JSON.stringify(data) });
          fresh.operation = await get(tx, 'social_operations', operationId);
          await updateJobProgressTx(tx, lease, { operationId, phase: 'sent', nextRunAt: null }, { now: clock() });
          return fresh;
        });
      };
      const request = reading(task) ? connector.inspectDelivery({ delivery: { ...task.delivery, everActivated: task.delivery.everActivated === true }, operation: task.operation ? nativeOperation(task) : null, spec: task.spec, signal: controller.signal }) : connector.executeStep({ operation: nativeOperation(task), spec: task.spec, media, signal: controller.signal, beforeSend });
      let onAbort;
      const aborted = new Promise((resolve, reject) => { onAbort = () => reject(controller.signal.reason || error('TIMEOUT')); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
      let result;
      try { result = sanitize(await Promise.race([request, aborted])); }
      finally { controller.signal.removeEventListener('abort', onAbort); }
      heartbeat.assertActive(); controller.signal.throwIfAborted();
      const saved = await fenced(store, lease, clock, async tx => {
        const fresh = await loadTask(tx, parts, { operationId }); requireThat(fresh && (!operationId || fresh.operation?.id === operationId));
        requireThat(!operationId || fresh.operation.version === task.operation.version);
        await authorize(tx, fresh, await loadSocialRuntime(tx, { env }), clock());
        const outcome = await persistResult(tx, fresh, result, clock());
        await updateJobProgressTx(tx, lease, { phase: result.status, nextRunAt: outcome.nextRunAt }, { now: clock() });
        return outcome;
      });
      committed = true; nextRunAt = saved.nextRunAt; errorCode = saved.errorCode;
    }, { now });
  } catch (caught) {
    if (committed) { errorCode = 'LEASE_LOST'; nextRunAt = null; }
    else try {
      const outcome = await fenced(store, lease, clock, async tx => { const fresh = await loadTask(tx, parts, { operationId: task?.operation?.id }); return fresh ? persistFailure(tx, fresh, caught, clock(), { inspecting }) : { errorCode: publicCode(caught), nextRunAt: null }; });
      nextRunAt = outcome.nextRunAt; errorCode = outcome.errorCode;
    } catch (fence) { if (fence.status === 409) return { errorCode: 'LEASE_LOST' }; throw fence; }
  } finally { clearTimeout(timer); clearInterval(leaseWatch); if (media) await media.handle.close(); }
  try { await finishJob(store, lease, { state: nextRunAt ? 'queued' : errorCode ? 'failed' : 'succeeded', data: { nextRunAt }, errorCode, now: clock() }); }
  catch (caught) { if (caught.status === 409) return { errorCode: 'LEASE_LOST' }; throw caught; }
  return { errorCode };
}
export async function processSocialApiTurn(store, { now = stamp(), maxOperations = 5, env = process.env, transport = {} } = {}) {
  now = instant(now); maxOperations = integer(maxOperations, 'Etapas de API por turno', 1, 25);
  const clock = jobClock(now); let processed = 0, errorCode = null;
  await prepareSocialApiJobs(store, { now, env });
  while (processed < maxOperations) {
    const lease = await claimDue(store, env, clock()); if (!lease) break;
    const result = await processJob(store, lease, partsOf(lease.key), { now: clock(), env, transport });
    processed++; errorCode ||= result.errorCode;
    // Queue a returned nextStep only after the prior stage's IDs and receipt
    // committed, never by holding a transaction across the provider request.
    await prepareSocialApiJobs(store, { now: clock(), env });
  }
  return { processed, hasMore: await hasDue(store, env, clock()), errorCode };
}
