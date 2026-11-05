import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { queueJobTx } from '../lib/business/job-leases.mjs';
import { aggregateSocialCampaignState, prepareSocialBrowserJobs, processSocialBrowserTurn, queueSocialBrowserJobTx } from '../lib/business/social-jobs.mjs';
import { socialAccountNotBefore } from '../lib/business/social-schedule.mjs';
import { withBrowserSession } from '../lib/business/social-browser.mjs';
import { runBusinessJobs } from '../lib/business/jobs.mjs';
import { saveResource, getBusinessSettings, saveBusinessSettings } from '../lib/business/settings.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { BrowserControlError } from '../lib/social/browser-client.mjs';
import { socialConnection, socialTestEnv } from './social-contract.mjs';
import { socialConnectionAction, previewSocialConnectionDeletion } from '../lib/business/social-connections.mjs';
import { getSocialConnection, listSocialConnections } from '../lib/business/social.mjs';

const NOW = '2030-01-01T14:00:00.000Z';
const ids = { userId: '101', businessId: '202', pageId: '303', instagramId: '404', adAccountId: '505' };
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: NOW, updated_at: NOW });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cookieState = { cookies: [{ name: 'auth', value: 'WORKER-COOKIE-CANARY', domain: '.facebook.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
const installations = new WeakMap();
const clocks = new WeakMap();
const city = (region = 'Bogotá D.C.', radius = 17) => {
  const context = { type: 'city', countryCode: 'CO', region, scope: 'Colombia / Distrito / Ciudad' }, label = 'Bogotá';
  return { key: hash({ label, context, businessId: ids.businessId }), source: 'browser', providerId: null, label, context: { ...context, radius, distanceUnit: 'kilometer' } };
};
async function patch(store, table, id, fields) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...fields }), id]);
}

// A remote service with its own IDs, drafts, journal and budget. It never returns
// a request's spec as observed state: the connector must read this independent
// store, and changes or missing effects remain visible across worker restarts.
function provider(base) {
  const end = new Date(Date.parse(base) + 7 * 86400000).toISOString();
  const remote = { objects: new Map(), byOperation: new Map(), sessions: new Map(), writes: 0, reads: 0, drafts: 0, activations: 0, pauses: 0, resumes: 0, nextId: 700,
    beforeWrite: null, afterWrite: null, beforeInspect: null, inspectError: null, loseResponse: false, expired: false, pending: false, injectedEvidence: null };
  remote.seed = ({ id = String(++remote.nextId), mode = 'paid', state = 'ready', channel = 'meta_ads', assetHash = null, operationId = null } = {}) => {
    const object = { id, mode, state, channel, assetHash, caption: 'Controlled post', headline: 'Nutrition', destinationUrl: 'https://example.test/product', whatsappNumber: '', whatsappGreeting: '', objective: 'traffic',
      identities: { ...ids }, budgetMinor: 5000000, remainingMinor: state === 'ready' ? 5000000 : 4300000, currency: 'COP', timeZone: 'America/Bogota', startAt: base, endAt: end,
      audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, placements: ['facebook_feed', 'instagram_feed'], everActivated: ['active', 'paused', 'scheduled', 'in_review', 'completed'].includes(state) };
    remote.objects.set(id, object); if (operationId) remote.byOperation.set(operationId, id); return object;
  };
  const check = options => { if (remote.expired) throw new BrowserControlError('SESSION_EXPIRED'); assert.equal(remote.sessions.get(options.connectionId)?.token, options.lease.token); };
  const observed = object => ({ identities: object.identities, caption: object.caption, headline: object.headline, destinationUrl: object.destinationUrl, whatsappNumber: object.whatsappNumber, whatsappGreeting: object.whatsappGreeting,
    aiDisclosure: false, enhancements: false, assetHash: object.assetHash, assetType: 'image', ...(object.mode === 'paid' ? { objective: object.objective, budgetMinor: object.budgetMinor, currency: object.currency, timeZone: object.timeZone, startAt: object.startAt, endAt: object.endAt,
      budgetType: 'lifetime', budgetLevel: 'Ad set', expansion: false, automaticPlacements: false, campaignCount: 1, adSetCount: 1, adCount: 1, taxesAndFees: 'Not included', audience: object.audience, placements: object.placements } : { platforms: [object.channel] }) });
  const response = object => ({ status: remote.pending ? 'pending' : 'confirmed', data: { state: object.state,
    remoteRefs: { remoteDraftRef: object.id, ...(object.state !== 'ready' ? { remoteId: object.id } : {}), ...(object.state === 'published' ? { permalink: `https://www.${object.channel === 'instagram' ? 'instagram' : 'facebook'}.com/${object.id}` } : {}) },
    ...(object.mode === 'paid' ? { preparedRefs: { remoteDraftRef: object.id } } : {}), observedSpec: observed(object),
    evidence: { remoteRead: true, everActivated: object.everActivated, ...(object.mode === 'paid' ? { budget: { budgetMinor: object.budgetMinor, remainingMinor: object.remainingMinor, currency: object.currency, startAt: object.startAt, endAt: object.endAt } } : {}),
      ...(object.assetHash ? { mediaEvidence: { scope: object.id, name: 'derivative.jpg', sha256: object.assetHash, remoteMediaId: '998' } } : {}), ...(remote.injectedEvidence || {}) } } });
  const lose = () => { if (remote.loseResponse) { remote.loseResponse = false; throw Object.assign(new Error('network-secret-must-not-persist'), { code: 'ECONNRESET' }); } };
  remote.client = {
    async open(options) { if (remote.expired) throw new BrowserControlError('SESSION_EXPIRED'); remote.sessions.set(options.connectionId, { token: options.lease.token, purpose: options.payload?.purpose }); return { status: 'confirmed', data: {} }; },
    async renew(options) { check(options); return { status: 'confirmed', data: {} }; },
    async close(options) { if (remote.sessions.get(options.connectionId)?.token === options.lease.token) remote.sessions.delete(options.connectionId); return { status: 'confirmed', data: {} }; },
    async exportState(options) { check(options); return { status: 'confirmed', data: { storageState: cookieState } }; },
    async execute(options) {
      check(options); const { operation, spec, media } = options.payload; assert.equal(operation.state, 'sent');
      if (remote.beforeWrite) await remote.beforeWrite(options);
      const step = operation.step.split(':')[0]; let object;
      if (step === 'publish') {
        assert.ok(['facebook', 'instagram'].includes(operation.channel)); assert.equal(spec.caption, 'Controlled post'); assert.ok(media.sha256);
        object = remote.seed({ mode: 'organic', channel: operation.channel, assetHash: media.sha256, state: 'published', operationId: operation.id });
      } else {
        object = remote.objects.get(operation.remoteId || operation.remoteDraftRef); assert.ok(object, 'El objeto remoto debe existir antes de operar');
        if (step === 'prepare-paid') assert.equal(object.state, 'ready');
        else if (step === 'activate') { assert.equal(object.state, 'ready'); object.state = 'active'; object.everActivated = true; object.remainingMinor = 4300000; remote.activations++; }
        else if (step === 'pause') { assert.equal(spec, null); object.state = 'paused'; object.everActivated = true; remote.pauses++; }
        else if (step === 'resume') { assert.equal(object.state, 'paused'); object.state = 'active'; object.everActivated = true; remote.resumes++; }
        else assert.fail(`Etapa inesperada: ${step}`);
        remote.byOperation.set(operation.id, object.id);
      }
      remote.writes++; const result = response(object); if (step === 'pause') result.data.observedSpec = null;
      if (remote.afterWrite) await remote.afterWrite(options, object); lose(); return result;
    },
    async inspect(options) {
      check(options); const { kind, delivery, operation, purpose } = options.payload;
      if (kind === 'connection') return { status: 'confirmed', data: { state: 'connected', identities: purpose === 'pause' ? { userId: ids.userId, adAccountId: ids.adAccountId } : { ...ids }, currency: 'COP', timeZone: 'America/Bogota', capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, whatsappAds: true } } };
      remote.reads++; if (remote.beforeInspect) await remote.beforeInspect(options); if (remote.inspectError) throw remote.inspectError;
      const refs = operation?.resolution?.refs || operation?.data?.resolution?.refs || {};
      const object = remote.objects.get(refs.remoteId || refs.remoteDraftRef || delivery?.remoteId || delivery?.remoteDraftRef || operation?.remoteId || operation?.remoteDraftRef || remote.byOperation.get(operation?.id || delivery?.operationId));
      if (!object) return { status: 'uncertain', data: {} };
      const result = response(object);
      if (operation?.step?.startsWith('pause:')) result.data.observedSpec = null;
      if (!delivery && operation?.step === 'prepare') { result.data.observedSpec = null; delete result.data.state; }
      return result;
    },
    async preflight(options) {
      check(options); const { operation, media } = options.payload; assert.equal(operation.state, 'sent');
      if (remote.beforeWrite) await remote.beforeWrite(options);
      let object = remote.objects.get(operation.remoteDraftRef);
      if (operation.step === 'prepare') { assert.equal(operation.acceptPrivateDraft, true); object = remote.seed({ operationId: operation.id }); remote.drafts++; remote.writes++; }
      assert.ok(object);
      let result;
      if (operation.step === 'targeting') result = { status: 'confirmed', data: { remoteRefs: { remoteDraftRef: object.id }, candidates: [city()], evidence: { remoteRead: true } } };
      else if (operation.step === 'prepare') result = { status: 'confirmed', data: { remoteRefs: { remoteDraftRef: object.id }, evidence: { remoteRead: true } } };
      else { assert.equal(operation.step, 'validate'); object.assetHash = media.sha256; remote.writes++; result = response(object); }
      if (remote.afterWrite) await remote.afterWrite(options, object); lose(); return result;
    }
  };
  return remote;
}
async function setup(store, t, { mode = 'organic', withDelivery = true, platforms = ['facebook'], remote = null } = {}) {
  if (!installations.has(store)) {
    const root = await mkdtemp(join(tmpdir(), 'social-browser-job-contract-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    installations.set(store, { root, env: { ...socialTestEnv(), SOCIAL_BROWSER_ENABLED: 'true', SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_MEDIA_DIR: root } });
    clocks.set(store, { now: Date.parse(NOW) - 1000 });
  }
  const { root, env: deploymentEnv } = installations.get(store), env = { ...deploymentEnv }, clock = clocks.get(store);
  const base = new Date(clock.now + 1000).toISOString(), at = milliseconds => new Date(Date.parse(base) + milliseconds).toISOString();
  const actorId = randomUUID(), approverId = randomUUID();
  for (const id of [actorId, approverId]) await insertRow(store, 'users', { id, email: `${id}@example.test`, password: 'unused-synthetic', active: 1 });
  const connection = await socialConnection(store, { method: 'browser', data: { identities: ids, currency: 'COP', timeZone: 'America/Bogota', capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true } } });
  await saveCredentials(store, connection.id, { storageState: cookieState }, { env });
  const assetId = randomUUID(), bytes = await sharp({ create: { width: 540, height: 675, channels: 3, background: '#336699' } }).jpeg().toBuffer(), assetHash = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(root, assetId)); await writeFile(join(root, assetId, 'derivative.jpg'), bytes);
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: assetHash, bytes: bytes.length, ...editable({ kind: 'image', derivativeSha256: assetHash, derivativeBytes: bytes.length }) });
  const spec = { integrationMethod: 'browser', connectionId: connection.id, assetId, assetHash, identities: { ...ids }, mode, objective: 'traffic', platforms: mode === 'organic' ? platforms : ['facebook', 'instagram'], caption: 'Controlled post', headline: 'Nutrition', destinationUrl: 'https://example.test/product', whatsappNumber: '', whatsappGreeting: '', audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, placements: mode === 'organic' ? platforms.map(channel => `${channel}_feed`) : ['facebook_feed', 'instagram_feed'], budgetMinor: mode === 'paid' ? 5000000 : null, currency: 'COP', publishAt: null, startAt: mode === 'paid' ? base : null, endAt: mode === 'paid' ? at(7 * 86400000) : null, observationDays: 7, aiDisclosure: false, timeZone: 'America/Bogota' };
  spec.assetType = 'image';
  const campaignId = randomUUID(); remote ||= provider(base);
  await insertRow(store, 'social_campaigns', { id: campaignId, connection_id: connection.id, asset_id: assetId, name: 'Campaña aislada del worker', mode, objective: 'traffic', state: withDelivery ? 'publishing' : 'draft', ...editable(spec) });
  const revision = () => ({ spec, rightsAccepted: true, acceptedWarnings: [], forecast: { specHash: hash(spec), source: 'insufficient', metricRanges: {} } });
  if (withDelivery) await insertRow(store, 'social_revisions', { campaign_id: campaignId, revision: 1, spec_hash: hash(spec), approved_at: base, actor_id: approverId, data: JSON.stringify(revision()) });
  const f = { store, env, root, base, at, actorId, approverId, connection, assetId, assetHash, spec, campaignId, remote, transport: { browserClient: remote.client } };
  f.now = () => new Date(clock.now).toISOString();
  f.turn = (options = {}) => { clock.now = options.now ? Date.parse(options.now) : clock.now + 1000; return processSocialBrowserTurn(store, { env, transport: f.transport, ...options, now: f.now() }); };
  f.patch = (table, id, fields) => patch(store, table, id, fields);
  f.refreshSpec = async () => { await patch(store, 'social_campaigns', campaignId, spec); await store.db.run(`UPDATE ${store.t('social_revisions')} SET spec_hash=?,data=? WHERE campaign_id=?`, [hash(spec), JSON.stringify(revision()), campaignId]); };
  f.delivery = async ({ state = 'queued', remoteId = null, data = {}, channel = mode === 'paid' ? 'meta_ads' : platforms[0] } = {}) => {
    const id = randomUUID(); await insertRow(store, 'social_deliveries', { id, campaign_id: campaignId, revision: 1, channel, state, remote_id: remoteId, next_sync_at: null, ...editable({ integrationMethod: 'browser', remoteRefs: {}, ...data }) }); return get(store, 'social_deliveries', id);
  };
  f.operation = async (delivery, step = mode === 'paid' ? 'prepare-paid' : 'publish', extra = {}) => {
    const id = randomUUID(), kind = step.split(':')[0], current = delivery && await get(store, 'social_deliveries', delivery.id), campaign = await get(store, 'social_campaigns', campaignId);
    const controlId = ['activate', 'pause', 'resume'].includes(kind) ? step.slice(kind.length + 1) : null;
    const consent = campaign.preflight?.privateDraftAuthorization || { actorId, acceptedAt: base, requestId: randomUUID() };
    await insertRow(store, 'social_operations', { id, campaign_id: campaignId, delivery_id: delivery?.id || null, operation_key: delivery ? `delivery:${delivery.id}:${step}` : `preflight:${campaignId}:${randomUUID()}`, step, state: 'prepared', next_attempt_at: null,
      ...editable({ integrationMethod: 'browser', actorId, specHash: hash(spec), ...(delivery ? { channel: delivery.channel } : { campaignVersion: campaign.version, spec, kind, acceptPrivateDraft: true, privateDraftAuthorization: consent }),
        ...(controlId ? { controlId, investmentAccepted: kind !== 'pause', preparedRefs: current.preparedRefs, remoteDraftRef: current.remoteRefs?.remoteDraftRef || current.preparedRefs?.remoteDraftRef,
          budgetConfirmation: { remainingMinor: current.budgetSnapshot?.remainingMinor, originalBudgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt } } : {}), ...extra }) });
    if (controlId) await patch(store, 'social_deliveries', delivery.id, { controlIntent: { id: controlId, kind, actorId: extra.actorId || actorId, requestedAt: f.now() } });
    return get(store, 'social_operations', id);
  };
  f.control = (kind, extra = {}) => f.operation(f.firstDelivery, `${kind}:${randomUUID()}`, extra);
  f.seedPaid = async (state = 'ready') => {
    const object = remote.seed({ assetHash, state });
    await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state=?,remote_id=? WHERE id=?`, [state, state === 'ready' ? null : object.id, f.firstDelivery.id]);
    await patch(store, 'social_deliveries', f.firstDelivery.id, { preparedRefs: { remoteDraftRef: object.id }, remoteRefs: { remoteDraftRef: object.id }, everActivated: object.everActivated, mediaEvidence: { scope: object.id, name: 'derivative.jpg', sha256: assetHash, remoteMediaId: '998' } });
    await patch(store, 'social_deliveries', f.firstDelivery.id, { budgetSnapshot: { budgetMinor: object.budgetMinor, remainingMinor: object.remainingMinor, currency: object.currency, startAt: object.startAt, endAt: object.endAt, checkedAt: f.now() } });
    return object;
  };
  f.sync = async (now = f.now()) => { await store.db.run(`UPDATE ${store.t('social_deliveries')} SET next_sync_at=? WHERE id=?`, [now, f.firstDelivery.id]); return f.turn({ now }); };
  if (withDelivery) f.firstDelivery = await f.delivery();
  return f;
}

const cases = [
  ['reclama sólo UUID ejecutables, conserva locks/colas ajenas y no cambia finanzas', async (store, t) => {
    const f = await setup(store, t); await f.operation(f.firstDelivery);
    const untouched = ['import:worker-contract', `social:delivery:${randomUUID()}`, `social:browser-lock:${randomUUID()}`, `social:browser:lock:${randomUUID()}`, 'social:browser:delivery:not-a-uuid', `social:browser:other:${randomUUID()}`];
    for (const key of untouched) await store.transaction(tx => queueJobTx(tx, key, { marker: key }, { now: f.base }));
    const before = await store.db.all(`SELECT * FROM ${store.t('job_runs')} ORDER BY key`), revision = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    assert.equal((await f.turn()).processed, 1); assert.equal((await f.turn()).hasMore, false); assert.equal(f.remote.writes, 1);
    for (const row of before) assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [row.key]), row);
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), revision);
    for (const table of ['orders', 'expenses', 'expense_payments', 'cash_entries', 'order_collections']) assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n), 0);
  }],
  ['dos redes de la misma revisión confirman sin usar versión agregada como fence', async (store, t) => {
    const f = await setup(store, t, { platforms: ['facebook', 'instagram'] });
    const instagram = await f.delivery({ channel: 'instagram' }); await f.operation(f.firstDelivery); await f.operation(instagram);
    f.remote.afterWrite = () => store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='partial',version=version+1 WHERE id=?`, [f.campaignId]);
    assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_campaigns', f.campaignId)).state, 'partial');
    f.remote.afterWrite = null;
    assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_campaigns', f.campaignId)).state, 'published');
    assert.equal(f.remote.writes, 2); assert.deepEqual([...f.remote.objects.values()].map(object => object.channel).sort(), ['facebook', 'instagram']);
    assert.equal((await f.turn()).processed, 0);
  }],
  ['agenda futura y flags/hold no generan spin ni consumen intenciones', async (store, t) => {
    const f = await setup(store, t); f.spec.publishAt = f.at(300000); await f.refreshSpec(); const operation = await f.operation(f.firstDelivery);
    assert.equal((await f.turn()).processed, 0); assert.equal((await f.turn()).hasMore, false); assert.equal(f.remote.writes, 0);
    f.env.SOCIAL_PUBLISHING_ENABLED = 'false'; assert.equal((await f.turn({ now: f.at(301000) })).processed, 0);
    assert.equal((await get(store, 'social_operations', operation.id)).state, 'prepared');
    f.env.SOCIAL_PUBLISHING_ENABLED = 'true'; await f.patch('social_campaigns', f.campaignId, { restore_hold: true });
    assert.equal((await f.turn()).hasMore, false); await f.patch('social_campaigns', f.campaignId, { restore_hold: false });
    assert.equal((await f.turn()).errorCode, null); assert.equal(f.remote.writes, 1);
  }],
  ['respuesta perdida se reconcilia por journal y no vuelve a publicar', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery); f.remote.loseResponse = true;
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN'); assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain');
    assert.equal((await f.turn()).processed, 0); assert.equal(f.remote.objects.size, 1);
    assert.equal((await f.turn({ now: f.at(61000) })).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
    assert.equal(f.remote.writes, 1); assert.equal(f.remote.reads, 1);
  }],
  ['perder lease después del efecto deja sent y reiniciar sólo inspecciona', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery);
    f.remote.afterWrite = () => store.db.run(`UPDATE ${store.t('job_runs')} SET lease_token=? WHERE key=?`, [randomUUID(), `social:browser-lock:${f.connection.id}`]);
    assert.equal((await f.turn()).errorCode, 'LEASE_LOST'); assert.equal((await get(store, 'social_operations', operation.id)).state, 'sent');
    f.remote.afterWrite = null; await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_until=? WHERE key=?`, [f.base, `social:browser-lock:${f.connection.id}`]);
    assert.equal((await f.turn({ now: f.at(121000) })).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed'); assert.equal(f.remote.writes, 1);
  }],
  ['timeout posterior al efecto deja incertidumbre y la siguiente etapa sólo lee', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery), entered = deferred();
    f.remote.afterWrite = async () => { entered.resolve(); await new Promise(() => {}); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.turn(); await entered.promise; t.mock.timers.tick(300000);
    const result = await pending; assert.ok(result.errorCode); assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain'); assert.equal(f.remote.writes, 1);
    f.remote.afterWrite = null; t.mock.timers.reset();
    assert.equal((await f.turn({ now: f.at(61000) })).errorCode, null); assert.equal(f.remote.writes, 1);
  }],
  ['aprobador, actor, derechos, forecast, archivo y fecha bloquean antes de mutar', async (store, t) => {
    for (const fault of ['approver', 'actor', 'rights', 'forecast', 'file', 'late']) {
      const f = await setup(store, t), operation = await f.operation(f.firstDelivery);
      if (fault === 'approver' || fault === 'actor') await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [fault === 'actor' ? f.actorId : f.approverId]);
      if (fault === 'rights' || fault === 'forecast') await store.db.run(`UPDATE ${store.t('social_revisions')} SET data=? WHERE campaign_id=?`, [JSON.stringify({ spec: f.spec, rightsAccepted: fault !== 'rights', ...(fault !== 'forecast' ? { forecast: { specHash: hash(f.spec) } } : {}) }), f.campaignId]);
      if (fault === 'file') await writeFile(join(f.root, f.assetId, 'derivative.jpg'), 'altered');
      assert.ok((await f.turn({ ...(fault === 'late' ? { now: f.at(901000) } : {}) })).errorCode);
      assert.equal(f.remote.writes, 0); assert.equal((await get(store, 'social_operations', operation.id)).state, 'failed');
    }
  }],
  ['autorización restaurada ejecuta con actor efectivo y deja revisión histórica intacta', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery), revision = await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=?`, [f.campaignId]);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
    await f.patch('social_campaigns', f.campaignId, { restoredAuthorization: { actorId: f.actorId, specHash: hash(f.spec), rightsAccepted: true, acceptedWarnings: [], acceptedAt: f.base } });
    assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).executedBy, f.actorId);
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_revisions')} WHERE campaign_id=?`, [f.campaignId]), revision);
  }],
  ['pausa mínima funciona con estado reparable, sin Page/IG, spec, pieza, forecast ni flag', async (store, t) => {
    for (const state of ['layout_changed', 'reconnect_required']) {
      const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid('active');
      f.remote.injectedEvidence = { everActivated: undefined, budget: undefined };
      await store.db.run(`UPDATE ${store.t('social_assets')} SET state='missing_file' WHERE id=?`, [f.assetId]);
      await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.approverId]);
      await store.db.run(`UPDATE ${store.t('social_revisions')} SET data='{}' WHERE campaign_id=?`, [f.campaignId]);
      await f.patch('social_connections', f.connection.id, { identities: { userId: ids.userId, adAccountId: ids.adAccountId } });
      await store.db.run(`UPDATE ${store.t('social_connections')} SET state=? WHERE id=?`, [state, f.connection.id]);
      await f.patch('social_campaigns', f.campaignId, { restore_hold: true }); f.env.SOCIAL_PUBLISHING_ENABLED = 'false';
      const operation = await f.control('pause', { cancelAfterPause: true });
      assert.equal((await f.turn()).errorCode, null); assert.equal(object.state, 'paused');
      const delivery = await get(store, 'social_deliveries', f.firstDelivery.id);
      assert.equal(delivery.state, 'cancelled'); assert.equal(delivery.lastConfirmedState, 'paused'); assert.equal(delivery.everActivated, true);
      assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
    }
  }],
  ['pausa sin acceso no afirma éxito y explica detener gasto en Meta', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid('active'); await f.control('pause'); f.remote.expired = true;
    assert.ok((await f.turn()).errorCode); assert.equal(object.state, 'active');
    const delivery = await get(store, 'social_deliveries', f.firstDelivery.id); assert.notEqual(delivery.state, 'paused'); assert.match(delivery.lastError.action, /Meta/);
  }],
  ['pausa por draftRef exacto detiene activación enviada aun sin remoteId ni presupuesto visible', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid();
    object.state = 'active'; object.everActivated = true;
    f.remote.injectedEvidence = { budget: undefined };
    await f.control('pause');
    assert.equal((await f.turn()).errorCode, null); const delivery = await get(store, 'social_deliveries', f.firstDelivery.id);
    assert.equal(object.state, 'paused'); assert.equal(delivery.state, 'paused'); assert.equal(delivery.remoteId, object.id); assert.equal(delivery.budgetSnapshot.remainingMinor, 5000000);
    assert.equal(delivery.lastConfirmedState, 'paused'); assert.equal(delivery.everActivated, true);
  }],
  ['actor actual deshabilitado no puede enviar una pausa', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid('active'); await f.control('pause');
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    assert.equal((await f.turn()).errorCode, 'PERMISSION_REQUIRED'); assert.equal(object.state, 'active'); assert.equal(f.remote.pauses, 0);
  }],
  ['activar y dos ciclos pausa/reanudación conservan total/fin y journal distinto', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid();
    const operations = [];
    for (const kind of ['activate', 'pause', 'resume', 'pause', 'resume', 'pause']) {
      const operation = await f.control(kind); operations.push(operation.id);
      assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
      assert.equal(object.state, kind === 'pause' ? 'paused' : 'active');
    }
    const delivery = await get(store, 'social_deliveries', f.firstDelivery.id);
    assert.equal(new Set(operations).size, 6); assert.equal(f.remote.activations, 1); assert.equal(f.remote.resumes, 2); assert.equal(f.remote.pauses, 3);
    assert.equal(delivery.budgetSnapshot.budgetMinor, 5000000); assert.equal(delivery.budgetSnapshot.endAt, f.spec.endAt); assert.equal(delivery.everActivated, true);
  }],
  ['cambio remoto de total, restante, fin, cuenta u objetivo impide el efecto', async (store, t) => {
    for (const fault of ['budgetMinor', 'remainingMinor', 'endAt', 'account', 'objective']) {
      const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid(); await f.control('activate');
      if (fault === 'account') object.identities = { ...ids, adAccountId: '999' };
      else object[fault] = ({ budgetMinor: 5000100, remainingMinor: null, endAt: f.at(8 * 86400000), objective: 'reach' })[fault];
      assert.ok((await f.turn()).errorCode); assert.equal(f.remote.activations, 0); assert.equal(object.state, 'ready');
    }
  }],
  ['control actual suprime escrituras viejas y preserva resultado tardío sin pisar pausa', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid(), old = await f.control('activate');
    let pause;
    f.remote.afterWrite = async () => { pause = await f.control('pause'); await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state='paused' WHERE id=?`, [f.firstDelivery.id]); };
    assert.equal((await f.turn()).errorCode, null); f.remote.afterWrite = null;
    let delivery = await get(store, 'social_deliveries', f.firstDelivery.id); assert.equal(delivery.state, 'paused'); assert.equal(delivery.everActivated, true);
    assert.equal((await get(store, 'social_operations', old.id)).state, 'confirmed'); assert.ok((await get(store, 'social_operations', old.id)).receipts[0].superseded);
    assert.equal((await f.turn()).errorCode, null); assert.equal(object.state, 'paused'); assert.equal((await get(store, 'social_operations', pause.id)).state, 'confirmed');
    const abandoned = await f.control('resume'); const current = await f.control('pause');
    assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_operations', current.id)).state, 'confirmed');
    assert.equal((await get(store, 'social_operations', abandoned.id)).state, 'prepared'); assert.equal((await f.turn()).processed, 0); assert.equal(f.remote.resumes, 0);
    delivery = await get(store, 'social_deliveries', f.firstDelivery.id); assert.equal(delivery.lastConfirmedState, 'paused');
  }],
  ['pausa actual desplaza espera de activación enviada sin borrar su journal', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }), object = await f.seedPaid(), activation = await f.control('activate');
    f.remote.beforeWrite = () => { f.remote.pending = true; }; assert.equal((await f.turn()).hasMore, false);
    assert.equal((await get(store, 'social_operations', activation.id)).state, 'sent'); assert.equal(object.state, 'active');
    f.remote.beforeWrite = null; f.remote.pending = false; const pause = await f.control('pause');
    assert.equal((await f.turn()).errorCode, null); assert.equal(object.state, 'paused'); assert.equal((await get(store, 'social_operations', pause.id)).state, 'confirmed');
    const delivery = await get(store, 'social_deliveries', f.firstDelivery.id); assert.equal(delivery.state, 'paused'); assert.equal(delivery.everActivated, true);
    assert.equal((await get(store, 'social_operations', activation.id)).state, 'sent');
    await f.turn({ now: f.at(301000) });
    assert.equal((await get(store, 'social_deliveries', delivery.id)).state, 'paused'); assert.equal(f.remote.activations, 1); assert.equal(f.remote.pauses, 1);
  }],
  ['preflight parcial, búsqueda, validación y adopción usan un solo draft y medio durable', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false });
    const partial = { ...f.spec, assetId: null, assetHash: null, assetType: null, budgetMinor: null, startAt: null, endAt: null };
    const prepare = await f.operation(null, 'prepare', { spec: partial, specHash: hash(partial) }); assert.equal((await f.turn()).errorCode, null);
    let campaign = await get(store, 'social_campaigns', f.campaignId); const ref = campaign.preflight.remoteDraftRef, authorization = campaign.preflight.privateDraftAuthorization;
    assert.equal(f.remote.drafts, 1); assert.equal((await get(store, 'social_operations', prepare.id)).state, 'confirmed'); assert.equal(campaign.version, 2);
    f.env.SOCIAL_PUBLISHING_ENABLED = 'false';
    await f.operation(null, 'targeting', { remoteDraftRef: ref, query: { kind: 'location', q: 'Bogotá' } }); assert.equal((await f.turn()).errorCode, null);
    f.env.SOCIAL_PUBLISHING_ENABLED = 'true';
    campaign = await get(store, 'social_campaigns', f.campaignId); assert.deepEqual(campaign.preflight.candidates, [city()]); assert.deepEqual(campaign.preflight.privateDraftAuthorization, authorization);
    await f.operation(null, 'validate', { remoteDraftRef: ref }); assert.equal((await f.turn()).errorCode, null);
    campaign = await get(store, 'social_campaigns', f.campaignId); assert.equal(campaign.preflight.mediaEvidence.sha256, f.assetHash); assert.equal(campaign.preflight.adapterVersion, 'meta-ui-v2');
    await insertRow(store, 'social_revisions', { campaign_id: f.campaignId, revision: 1, spec_hash: hash(f.spec), approved_at: f.base, actor_id: f.approverId, data: JSON.stringify({ spec: f.spec, rightsAccepted: true, forecast: { specHash: hash(f.spec) } }) });
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='publishing' WHERE id=?`, [f.campaignId]);
    const delivery = await f.delivery(); await f.operation(delivery, 'prepare-paid', { remoteDraftRef: ref, mediaEvidence: campaign.preflight.mediaEvidence });
    assert.equal((await f.turn()).errorCode, null); const adopted = await get(store, 'social_deliveries', delivery.id);
    assert.equal(adopted.state, 'ready'); assert.equal(adopted.preparedRefs.remoteDraftRef, ref); assert.equal(adopted.mediaEvidence.sha256, f.assetHash); assert.equal(f.remote.drafts, 1); assert.equal(f.remote.activations, 0);
  }],
  ['otra request prepare no duplica un draft privado ya recuperable', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false }); await f.operation(null, 'prepare'); assert.equal((await f.turn()).errorCode, null);
    const duplicate = await f.operation(null, 'prepare'); assert.equal((await f.turn()).errorCode, 'SPEC_MISMATCH');
    assert.equal((await get(store, 'social_operations', duplicate.id)).state, 'failed'); assert.equal(f.remote.drafts, 1); assert.equal(f.remote.activations, 0);
  }],
  ['autosave con respuesta perdida se inspecciona standalone y no crea otro draft', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false }), operation = await f.operation(null, 'prepare'); f.remote.loseResponse = true;
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN'); assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain');
    assert.equal((await f.turn({ now: f.at(61000) })).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
    assert.equal((await get(store, 'social_campaigns', f.campaignId)).preflight.remoteDraftRef, '701'); assert.equal(f.remote.drafts, 1); assert.equal(f.remote.reads, 1);
  }],
  ['edición durante autosave preserva draft/consent pero nunca adopta validación vieja', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false }), operation = await f.operation(null, 'prepare');
    f.remote.afterWrite = () => f.patch('social_campaigns', f.campaignId, { caption: 'Changed while provider was busy' });
    assert.equal((await f.turn()).errorCode, 'SPEC_MISMATCH'); const campaign = await get(store, 'social_campaigns', f.campaignId);
    assert.equal(campaign.caption, 'Changed while provider was busy'); assert.equal(campaign.preflight.remoteDraftRef, '701'); assert.ok(campaign.preflight.privateDraftAuthorization); assert.equal(campaign.preflight.observedSpec, undefined);
    assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain'); assert.equal((await f.turn()).processed, 0); assert.equal(f.remote.drafts, 1);
  }],
  ['cambiar conexión durante autosave conserva sólo journal de la cuenta anterior', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false }), operation = await f.operation(null, 'prepare');
    const other = await socialConnection(store, { method: 'browser', data: { identities: { ...ids, adAccountId: '606' }, currency: 'COP', timeZone: 'America/Bogota', capabilities: { adsPublish: true } } });
    f.remote.afterWrite = async () => {
      await store.db.run(`UPDATE ${store.t('social_campaigns')} SET connection_id=? WHERE id=?`, [other.id, f.campaignId]);
      await f.patch('social_campaigns', f.campaignId, { connectionId: other.id });
    };
    assert.equal((await f.turn()).errorCode, 'SPEC_MISMATCH');
    assert.equal((await get(store, 'social_campaigns', f.campaignId)).preflight, undefined);
    const saved = await get(store, 'social_operations', operation.id); assert.equal(saved.state, 'uncertain'); assert.equal(saved.result.remoteRefs.remoteDraftRef, '701'); assert.equal(f.remote.drafts, 1);
  }],
  ['geografía estructurada compara jerarquía y radio, no sólo label', async (store, t) => {
    for (const mismatch of ['region', 'radius']) {
      const f = await setup(store, t, { mode: 'paid' }); f.spec.audience = { ...f.spec.audience, countries: [], cities: [city()] }; await f.refreshSpec();
      const object = await f.seedPaid(); object.audience = { ...f.spec.audience, cities: [mismatch === 'region' ? city('Otra región') : city('Bogotá D.C.', 30)] };
      await f.control('activate'); assert.ok((await f.turn()).errorCode); assert.equal(f.remote.activations, 0);
    }
  }],
  ['Retry-After compartido entre conexiones de misma cuenta no se evade con sync manual', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.seedPaid('active');
    const other = await setup(store, t, { mode: 'paid', remote: f.remote }); await other.seedPaid('active');
    f.remote.inspectError = Object.assign(new BrowserControlError('RATE_LIMITED'), { retryAfter: 600 });
    assert.equal((await f.sync(f.base)).errorCode, 'RATE_LIMITED');
    const deadline = await socialAccountNotBefore(store, other.connection, other.spec, { now: f.base }); assert.ok(deadline >= f.at(600000));
    await store.db.run(`UPDATE ${store.t('social_deliveries')} SET next_sync_at=? WHERE id=?`, [f.base, other.firstDelivery.id]);
    const reads = f.remote.reads, beforeDeadline = new Date(Date.parse(deadline) - 5000).toISOString();
    assert.equal((await other.turn({ now: beforeDeadline })).processed, 0); assert.equal((await other.turn({ now: beforeDeadline })).hasMore, false); assert.equal(f.remote.reads, reads);
    f.remote.inspectError = null; assert.equal((await other.turn({ now: new Date(Date.parse(deadline) + 1000).toISOString(), maxOperations: 2 })).errorCode, null); assert.ok(f.remote.reads > reads);
  }],
  ['resolución link conserva uncertain hasta inspector y no ejecuta un segundo efecto', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery); f.remote.loseResponse = true; await f.turn();
    const object = [...f.remote.objects.values()][0];
    await f.patch('social_operations', operation.id, { resolution: { kind: 'link', actorId: f.actorId, confirmedAt: f.base, acceptContentVerification: true, refs: { remoteId: object.id, permalink: `https://www.facebook.com/${object.id}` } } });
    assert.equal((await get(store, 'social_operations', operation.id)).state, 'uncertain');
    await store.db.run(`UPDATE ${store.t('social_operations')} SET next_attempt_at=? WHERE id=?`, [f.base, operation.id]);
    assert.equal((await f.turn({ now: f.at(61000) })).errorCode, null); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed'); assert.equal(f.remote.writes, 1);
  }],
  ['ausencia explícita usa actor nuevo y conserva historia de incertidumbre', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery), actor = randomUUID();
    f.remote.beforeWrite = () => { throw new Error('connection-lost-before-provider-effect'); };
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN'); assert.equal(f.remote.objects.size, 0);
    const uncertain = await get(store, 'social_operations', operation.id), previous = { state: uncertain.state, actorId: uncertain.actorId, sentAt: uncertain.sentAt, lastError: uncertain.lastError };
    f.remote.beforeWrite = null;
    await insertRow(store, 'users', { id: actor, email: `${actor}@example.test`, password: 'unused', active: 1 });
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await f.patch('social_operations', operation.id, { resolution: { kind: 'absent', actorId: actor, confirmedAt: f.now(), acceptDuplicateRisk: true }, resolutionHistory: [previous] });
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='prepared',next_attempt_at=NULL WHERE id=?`, [operation.id]);
    assert.equal((await f.turn({ now: f.at(61000) })).errorCode, null); const saved = await get(store, 'social_operations', operation.id);
    assert.equal(saved.executedBy, actor); assert.deepEqual(saved.resolutionHistory, [previous]); assert.equal(saved.actorId, f.actorId); assert.equal(f.remote.writes, 1);
  }],
  ['link de preflight standalone sólo se confirma mediante lectura del draft exacto', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', withDelivery: false }), operation = await f.operation(null, 'prepare'), object = f.remote.seed();
    await f.patch('social_operations', operation.id, { resolution: { kind: 'link', actorId: f.actorId, confirmedAt: f.base, refs: { remoteDraftRef: object.id } } });
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='uncertain',next_attempt_at=? WHERE id=?`, [f.base, operation.id]);
    assert.equal((await f.turn()).errorCode, null); assert.equal((await get(store, 'social_campaigns', f.campaignId)).preflight.remoteDraftRef, object.id);
    assert.equal(f.remote.writes, 0); assert.equal(f.remote.reads, 1); assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
  }],
  ['pending y sync sólo leen estado confirmado, sin métricas inventadas ni fin por reloj', async (store, t) => {
    const f = await setup(store, t), operation = await f.operation(f.firstDelivery); f.remote.pending = true;
    assert.equal((await f.turn()).hasMore, false); assert.equal((await get(store, 'social_operations', operation.id)).state, 'sent'); f.remote.pending = false;
    assert.equal((await f.turn({ now: f.at(301000) })).errorCode, null); assert.equal(f.remote.writes, 1);
    await store.db.run(`UPDATE ${store.t('social_deliveries')} SET next_sync_at=NULL WHERE id=?`, [f.firstDelivery.id]);
    const paid = await setup(store, t, { mode: 'paid' }), object = await paid.seedPaid('active');
    assert.equal((await paid.sync(paid.at(8 * 86400000))).errorCode, null); assert.equal(object.state, 'active'); assert.equal((await get(store, 'social_deliveries', paid.firstDelivery.id)).state, 'active');
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_measurements')}`), []);
  }],
  ['session callback conserva su return y CAS/epoch impiden cookie tardía', async (store, t) => {
    const f = await setup(store, t), original = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [f.connection.id]);
    const value = await withBrowserSession(store, f.connection.id, { owner: 'contract-return', env: f.env, client: f.remote.client, now: f.base }, async session => { await session.client.open({ payload: { purpose: 'worker' } }); return { receipt: 'owned-by-callback' }; });
    assert.deepEqual(value, { receipt: 'owned-by-callback' });
    const saved = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [f.connection.id]); assert.equal(saved.version, original.version + 1);
    await assert.rejects(() => withBrowserSession(store, f.connection.id, { owner: 'contract-epoch', env: f.env, client: f.remote.client, now: f.at(1000) }, async session => {
      await session.client.open({ payload: { purpose: 'worker' } }); await f.patch('social_connections', f.connection.id, { sessionEpoch: 1 }); return 'late';
    }), error => error.errorCode === 'LEASE_LOST');
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [f.connection.id]), saved);
  }],
  ['CAS de credenciales impide sobrescribir una rotación ajena dentro de la misma época', async (store, t) => {
    const f = await setup(store, t); let foreign;
    await assert.rejects(() => withBrowserSession(store, f.connection.id, { owner: 'contract-cas', env: f.env, client: f.remote.client, now: f.base }, async session => {
      await session.client.open({ payload: { purpose: 'worker' } });
      await saveCredentials(store, f.connection.id, { storageState: { ...cookieState, cookies: cookieState.cookies.map(cookie => ({ ...cookie, value: 'ROTATED-SESSION' })) } }, { env: f.env, expectedVersion: session.credentialVersion });
      foreign = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [f.connection.id]); return 'stale-cookie-export';
    }), { status: 409 });
    assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [f.connection.id]), foreign);
  }],
  ['caducidad, desafío y layout bloquean nuevas operaciones sin bucle de login', async (store, t) => {
    for (const [code, state] of [['SESSION_EXPIRED', 'reconnect_required'], ['CHALLENGE_REQUIRED', 'challenge_required'], ['LAYOUT_CHANGED', 'layout_changed']]) {
      const f = await setup(store, t); await f.operation(f.firstDelivery); let entries = 0;
      f.remote.beforeWrite = () => { entries++; throw Object.assign(new BrowserControlError(code), { effectAbsent: true }); };
      assert.ok((await f.turn()).errorCode); assert.equal((await get(store, 'social_connections', f.connection.id)).state, state);
      assert.equal((await f.turn({ now: f.at(61000) })).hasMore, false); assert.equal(entries, 1); assert.equal(f.remote.writes, 0);
    }
  }],
  ['evidencia saneada no persiste cookies, HTML, frames ni secretos de transporte', async (store, t) => {
    const f = await setup(store, t); await f.operation(f.firstDelivery);
    f.remote.injectedEvidence = { html: 'HTML-SECRET-CANARY', storageState: cookieState, frame: 'FRAME-SECRET-CANARY', accessToken: 'TOKEN-SECRET-CANARY' };
    assert.equal((await f.turn()).errorCode, null);
    for (const table of ['social_operations', 'social_deliveries', 'social_campaigns', 'job_runs', 'business_audit']) {
      const text = JSON.stringify(await store.db.all(`SELECT data FROM ${store.t(table)}`));
      for (const canary of ['HTML-SECRET-CANARY', 'FRAME-SECRET-CANARY', 'TOKEN-SECRET-CANARY', 'WORKER-COOKIE-CANARY']) assert.ok(!text.includes(canary), `${table}: ${canary}`);
    }
  }],
  ['ocupación conserva dueño y espera durable sin robar sesión', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.seedPaid('active'); await f.control('pause');
    const entered = deferred(), release = deferred(); f.remote.beforeWrite = async () => { entered.resolve(); await release.promise; };
    const running = f.turn(); await entered.promise;
    try {
      const lock = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser-lock:${f.connection.id}`]);
      await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state='draft' WHERE id=?`, [f.campaignId]); const preflight = await f.operation(null, 'prepare');
      const other = await f.turn(); assert.equal(other.errorCode, 'BROWSER_BUSY'); assert.equal(other.hasMore, false);
      assert.equal((await store.db.get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`, [lock.key])).lease_token, lock.lease_token);
      assert.equal((await get(store, 'social_operations', preflight.id)).state, 'prepared');
    } finally { release.resolve(); await running; }
    assert.equal(f.remote.pauses, 1); assert.equal(f.remote.drafts, 0);
  }],
  ['navegador lento no bloquea turno contable ni mantiene transacción abierta', async (store, t) => {
    const f = await setup(store, t), entered = deferred(), release = deferred();
    const settings = await getBusinessSettings(store); await saveBusinessSettings(store, { ...settings, reportsStartOn: '2030-01-01', requestId: randomUUID() }, f.actorId);
    await saveResource(store, 'people', { name: 'Empleado independiente', requestId: randomUUID(), salaryAgreements: [{ id: 'worker-isolation', enabled: true, amountPerPeriodMinor: 3100, frequency: 'monthly', effectiveFrom: '2029-12-30', effectiveTo: '2029-12-31', payDayOffset: 0 }] }, f.actorId);
    await f.operation(f.firstDelivery); f.remote.beforeWrite = async () => { entered.resolve(); await release.promise; };
    const running = f.turn(); await entered.promise;
    try {
      const normal = await Promise.race([runBusinessJobs(store, { now: f.base }), new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('El turno contable quedó esperando navegador')), 2000); timer.unref(); })]);
      assert.ok(normal.payroll.created > 0); assert.equal(f.remote.writes, 0); assert.equal(normal.social.hasMore, false);
    } finally { release.resolve(); await running; }
  }],
  ['agregación conserva parcial y validación rechaza claves no autorizadas', async (store, t) => {
    assert.equal(aggregateSocialCampaignState(['published', 'failed'], 'organic'), 'partial'); assert.equal(aggregateSocialCampaignState(['failed', 'queued'], 'organic'), 'needs_attention');
    const f = await setup(store, t); await f.operation(f.firstDelivery);
    await assert.rejects(() => store.transaction(tx => queueSocialBrowserJobTx(tx, { kind: 'browser-lock', id: randomUUID() }, { now: f.base })), { status: 400 });
    await assert.rejects(() => store.transaction(tx => queueSocialBrowserJobTx(tx, { kind: 'delivery', id: '../not-an-id' }, { now: f.base })), { status: 400 });
    assert.equal((await prepareSocialBrowserJobs(store, { now: f.base, env: f.env })).hasMore, true); assert.equal(f.remote.sessions.size, 0);
  }],
  ['desconectar espera prueba de pausa perdida y conserva custodia hasta la lectura del worker separado', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); const remote = await f.seedPaid('active');
    f.env.SOCIAL_PUBLISHING_ENABLED = 'false'; f.remote.loseResponse = true;
    const current = await getSocialConnection(store, f.connection.id), input = { version: current.version, requestId: randomUUID(), pauseAndDisconnect: true };
    const queued = await socialConnectionAction(store, current.id, 'disconnect', input, f.actorId, { env: f.env });
    assert.equal(queued.disconnectPending, true); assert.equal(queued.remoteSpendStopped, false); assert.equal(f.remote.pauses, 0);
    assert.equal((await getSocialConnection(store, current.id)).state, 'connected');
    assert.equal((await f.turn()).errorCode, 'OPERATION_UNCERTAIN');
    assert.equal(remote.state, 'paused'); assert.equal((await getSocialConnection(store, current.id)).state, 'connected');
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_credentials')} WHERE connection_id=?`, [current.id])).n), 1);
    const operation = await get(store, 'social_operations', queued.operationIds[0]);
    await f.turn({ now: operation.nextAttemptAt });
    const disconnected = await getSocialConnection(store, current.id);
    assert.equal(disconnected.state, 'disconnected'); assert.equal(disconnected.disconnectPending, undefined);
    assert.equal((await get(store, 'social_deliveries', f.firstDelivery.id)).state, 'paused');
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_credentials')} WHERE connection_id=?`, [current.id])).n), 0);
    assert.equal((await get(store, 'social_operations', operation.id)).state, 'confirmed');
    assert.equal(f.remote.pauses, 1);
  }],
  ['borrado tras pausa no elimina evidencia nueva sin reconsentimiento y conserva su recibo', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' }); await f.seedPaid('active');
    const counts = (await previewSocialConnectionDeletion(store, f.connection.id)).counts, current = await getSocialConnection(store, f.connection.id);
    const queued = await socialConnectionAction(store, current.id, 'delete-platform-data', { version: current.version, requestId: randomUUID(), confirmDelete: true, confirmCounts: counts, pauseAndDisconnect: true }, f.actorId, { env: f.env });
    f.remote.afterWrite = async () => {
      await insertRow(store, 'social_measurements', { id: randomUUID(), delivery_id: f.firstDelivery.id, query_key: 'new-evidence-during-disconnect', fetched_at: f.now(), payload_hash: hash('new-evidence'), data: '{}' });
      f.remote.afterWrite = null;
    };
    assert.equal((await f.turn()).errorCode, null);
    const held = await getSocialConnection(store, current.id);
    assert.equal(held.state, 'connected'); assert.equal(held.disconnectPending.state, 'needs_confirmation');
    assert.equal(held.disconnectPending.errorCode, 'SPEC_MISMATCH');
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_measurements')}`)).n), 1);
    const confirmedCounts = (await previewSocialConnectionDeletion(store, current.id)).counts;
    const deleted = await socialConnectionAction(store, current.id, 'delete-platform-data', { version: held.version, requestId: randomUUID(), confirmDelete: true, confirmCounts: confirmedCounts, pauseAndDisconnect: true }, f.actorId, { env: f.env });
    assert.equal(deleted.receiptId, queued.receiptId); assert.equal(deleted.remoteSpendStopped, true);
    await assert.rejects(() => getSocialConnection(store, current.id), { status: 404 });
    assert.equal((await get(store, 'social_assets', f.assetId)).state, 'ready');
    assert.equal((await listSocialConnections(store, { env: f.env })).deletionReceipts.some(receipt => receipt.receiptId === queued.receiptId), true);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('orders')}`)).n), 0);
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('expenses')}`)).n), 0);
  }]
];

export async function runSocialBrowserJobContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async context => {
    const store = await factory();
    try { await scenario(store, context); } finally { await store.close(); }
  });
}
