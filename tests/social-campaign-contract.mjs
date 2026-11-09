import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { saveSocialCampaign, socialCampaignAction, getSocialCampaign, getSocialOperation, queueSocialBrowserPreflight } from '../lib/business/social.mjs';
import { buildSocialSpec, buildSocialDraftSpec } from '../lib/business/social-spec.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { META_PERMISSIONS } from '../lib/social/config.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { loadSocialRuntime } from '../lib/social/config.mjs';

const NOW = '2026-11-02T12:00:00.000Z';
const START = '2026-11-03T12:00:00.000Z', END = '2026-11-10T12:00:00.000Z';
const TOKEN = 'CAMPAIGN-SYNTHETIC-USER-TOKEN', PAGE_TOKEN = 'CAMPAIGN-SYNTHETIC-PAGE-TOKEN';
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: NOW, updated_at: NOW });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const rows = (store, table, campaignId) => store.db.all(`SELECT * FROM ${store.t(table)} WHERE campaign_id=?`, [campaignId]);
async function patchData(store, table, id, patch, { bump = false } = {}) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?${bump ? ',version=version+1' : ''} WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...patch }), id]);
}
function syntheticProvider() {
  // Independent account state, not an echo of the submitted specification. Every
  // request must be an allowed read: stage4 cannot create a remote publication.
  const remote = { currency: 'COP', pageTasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'], accountStatus: 1, permission: true, calls: [], beforeRead: null };
  remote.fetchImpl = async (href, init) => {
    const url = new URL(href), path = url.pathname.replace('/v26.0/', '');
    assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(init.method, 'GET');
    remote.calls.push(path);
    if (remote.beforeRead) await remote.beforeRead(path);
    let data;
    if (path === 'debug_token') data = { data: { app_id: '42', type: 'USER', is_valid: true, user_id: '100', expires_at: Date.parse(NOW) / 1000 + 86400, data_access_expires_at: Date.parse(NOW) / 1000 + 172800, scopes: META_PERMISSIONS } };
    else if (path === 'me') data = { id: '100', name: 'Administrador sintético' };
    else if (path === 'me/permissions') data = { data: (remote.permission ? META_PERMISSIONS : []).map(permission => ({ permission, status: 'granted' })) };
    else if (path === 'me/accounts') data = { data: [{ id: '200', name: 'Página sintética', tasks: remote.pageTasks, access_token: PAGE_TOKEN, business: { id: '500', name: 'Negocio sintético' }, instagram_business_account: { id: '300', username: 'synthetic' }, whatsapp_number: '+573001234567' }] };
    else if (path === 'me/adaccounts') data = { data: [{ id: 'act_400', name: 'Cuenta sintética', currency: remote.currency, timezone_name: 'America/Bogota', account_status: remote.accountStatus, user_tasks: ['ADVERTISE'], business: { id: '500', name: 'Negocio sintético' } }] };
    else if (path === 'search') data = { data: url.searchParams.get('type') === 'adinterest' ? [{ id: '900', name: 'Deporte', path: ['Intereses', 'Deporte'] }] : [{ key: 'CO', name: 'Colombia', type: 'country', country_code: 'CO' }] };
    else assert.fail(`Lectura remota no prevista: ${path}`);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  return remote;
}
async function setup(store, t, { method = 'api', mode = 'organic', objective = 'reach', platforms = ['facebook', 'instagram'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'social-campaign-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { APP_URL: 'http://localhost:3310', META_APP_ID: '42', META_APP_SECRET: 'CAMPAIGN-SYNTHETIC-SECRET', META_LOGIN_CONFIG_ID: '43', SOCIAL_PUBLISHING_ENABLED: 'true', SOCIAL_BROWSER_ENABLED: 'true', SOCIAL_MEDIA_DIR: root };
  for (const key of ['SOCIAL_TOKEN_ENCRYPTION_KEY', 'SOCIAL_MEDIA_SIGNING_KEY', 'SOCIAL_BROWSER_CONTROL_KEY', 'SOCIAL_BROWSER_SESSION_KEY']) env[key] = randomBytes(32).toString('base64');
  await configureSocialTestRuntime(store, { env });
  const actorId = randomUUID(), connectionId = randomUUID(), assetId = randomUUID(), remote = syntheticProvider();
  await insertRow(store, 'users', { id: actorId, email: `${actorId}@example.test`, password: 'synthetic-not-used', active: 1 });
  const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: method === 'api' ? 'act_400' : '400' };
  const connectionData = { name: 'Conexión sintética', identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true }, resources: { pages: [{ id: '200', instagramId: '300', whatsappNumber: '+573001234567', businessId: '500', tasks: ['CREATE_CONTENT', 'ADVERTISE', 'ANALYZE'] }], adAccounts: [{ id: identities.adAccountId, currency: 'COP', timeZone: 'America/Bogota', accountStatus: 1, businessId: '500', tasks: ['ADVERTISE'] }] } };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: method, state: 'connected', ...editable(connectionData) });
  await saveCredentials(store, connectionId, method === 'api' ? { accessToken: TOKEN, userId: '100', pageTokens: { 200: PAGE_TOKEN } } : { storageState: { cookies: [], origins: [] } }, { runtime: (await configureSocialTestRuntime(store, { env })).runtime });
  const bytes = await sharp({ create: { width: 540, height: 675, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const assetHash = createHash('sha256').update(bytes).digest('hex'), key = `${assetId}/derivative.jpg`;
  await mkdir(join(root, assetId), { mode: 0o700 }); await writeFile(join(root, key), bytes, { mode: 0o600 });
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: assetHash, bytes: bytes.length, ...editable({ name: 'Pieza aportada', kind: 'image', contentType: 'image/jpeg', derivativeKey: key, derivativeSha256: assetHash, derivativeBytes: bytes.length, derivativeContentType: 'image/jpeg', width: 540, height: 675, uploadFence: 'PRIVATE-UPLOAD-FENCE', processingFence: 'PRIVATE-PROCESSING-FENCE' }) });
  const configuration = { name: 'Campaña sintética', connectionId, assetId, mode, objective, platforms, caption: 'Texto escrito por el administrador', headline: '', destinationUrl: mode === 'paid' && objective === 'traffic' ? 'https://example.test/products' : '', whatsappNumber: objective === 'whatsapp' ? '+573001234567' : '', whatsappGreeting: objective === 'whatsapp' ? 'Quiero consultar sobre este producto' : '', audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, placements: platforms.map(platform => `${platform}_feed`), budgetMinor: mode === 'paid' ? 5000000 : 0, publishAt: null, startAt: mode === 'paid' ? START : null, endAt: mode === 'paid' ? END : null, observationDays: 7, aiDisclosure: false };
  const options = { env, now: NOW, transport: { fetchImpl: remote.fetchImpl } };
  const context = { store, env, actorId, connectionId, assetId, assetHash, configuration, options, remote, root };
  context.create = (extra = {}) => saveSocialCampaign(store, { ...configuration, ...extra, requestId: randomUUID() }, actorId, options);
  context.action = (campaign, action, extra = {}) => socialCampaignAction(store, campaign.id, action, { version: campaign.version, requestId: randomUUID(), ...extra }, actorId, options);
  context.build = async id => {
    const campaign = await get(store, 'social_campaigns', id), connection = await get(store, 'social_connections', connectionId), asset = await get(store, 'social_assets', assetId);
    return { ...buildSocialSpec(campaign, { connection, asset, now: NOW }), campaign };
  };
  context.forecast = async id => {
    const built = await context.build(id), forecastId = randomUUID();
    const forecast = { algorithmVersion: 'social-history-v1', source: 'insufficient', specHash: built.specHash, generatedAt: NOW, sampleIds: [], sampleCount: 0, metricRanges: {}, budgetMinor: built.spec.budgetMinor, currency: built.spec.currency, horizon: built.spec.mode === 'organic' ? built.spec.observationDays : { startAt: built.spec.startAt, endAt: built.spec.endAt }, assumptions: [], unavailableReasons: ['Sin muestras comparables completas.'] };
    await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: id, spec_hash: built.specHash, generated_at: NOW, data: JSON.stringify(forecast) });
    return { ...built, forecastId, forecast, rightsAccepted: true, acceptedWarnings: built.warnings.map(warning => warning.key), investmentAccepted: true };
  };
  context.approvalInput = forecast => ({ specHash: forecast.specHash, forecastId: forecast.forecastId, rightsAccepted: true, acceptedWarnings: forecast.acceptedWarnings, investmentAccepted: true });
  return context;
}
async function validatedPreflight(f, campaign) {
  const configurationFingerprint = (await loadSocialRuntime(f.store, { env: f.env })).fingerprint;
  const built = await f.build(campaign.id), id = randomUUID(), ref = '800', mediaEvidence = { scope: ref, name: 'derivative.jpg', sha256: f.assetHash, remoteMediaId: '801' };
  const authorization = { actorId: f.actorId, acceptedAt: NOW, requestId: randomUUID() };
  const observedSpec = { identities: built.spec.identities, assetHash: f.assetHash, assetType: 'image', budgetMinor: built.spec.budgetMinor, caption: built.spec.caption, platforms: built.spec.platforms, placements: built.spec.placements };
  const preparedRefs = { remoteDraftRef: ref, adSetId: '802', creativeId: '803', adId: '804' };
  const result = { status: 'confirmed', state: 'ready', remoteRefs: preparedRefs, preparedRefs, observedSpec, evidence: { adapterVersion: 'meta-ui-v2', remoteRead: true, mediaEvidence } };
  await insertRow(f.store, 'social_operations', { id, campaign_id: campaign.id, delivery_id: null, operation_key: `preflight:${campaign.id}:${randomUUID()}`, step: 'validate', state: 'confirmed', next_attempt_at: null, ...editable({ integrationMethod: 'browser', configurationFingerprint, actorId: f.actorId, kind: 'validate', campaignVersion: campaign.version, specHash: built.specHash, spec: built.spec, remoteDraftRef: ref, acceptPrivateDraft: true, privateDraftAuthorization: authorization, result }) });
  // The stored fixture represents resultTx confirming the version owned by
  // its queued operation, then increasing the campaign version once.
  await patchData(f.store, 'social_campaigns', campaign.id, { preflight: { kind: 'validate', configurationFingerprint, operationId: id, specHash: built.specHash, remoteDraftRef: ref, preparedRefs, mediaEvidence, observedSpec, adapterVersion: 'meta-ui-v2', privateDraftAuthorization: authorization, checkedAt: NOW } }, { bump: true });
  return { campaign: await get(f.store, 'social_campaigns', campaign.id), operationId: id, ref, mediaEvidence };
}
const cases = [
  ['una preparación privada de otra app/secreto/callback exige verificar de nuevo aunque la cuenta se revalide', async (store, t) => {
    const f = await setup(store, t, { method: 'browser', mode: 'paid', objective: 'traffic' });
    const campaign = await f.create(), prepared = await validatedPreflight(f, campaign), forecast = await f.forecast(campaign.id);
    const { runtime } = await configureSocialTestRuntime(store, { env: f.env, settings: { publicBaseUrl: 'https://another-panel.example.test' } });
    await patchData(store, 'social_connections', f.connectionId, { configurationFingerprint: runtime.fingerprint, revalidationRequired: false });
    await assert.rejects(() => f.action(prepared.campaign, 'prepare-paid', f.approvalInput(forecast)), { status: 409 });
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
    assert.deepEqual(await rows(store, 'social_deliveries', campaign.id), []);
    assert.equal((await get(store, 'social_operations', prepared.operationId)).state, 'confirmed');
    const detail = await getSocialCampaign(store, campaign.id);
    assert.equal(detail.preflight.configurationFingerprint, undefined);
    assert.equal(detail.connection.configurationFingerprint, undefined);
  }],
  ['borrador incompleto e idempotencia no alteran indicadores ni permiten suplantar actor', async (store, t) => {
    const f = await setup(store, t), requestId = randomUUID(), input = { name: 'Borrador incompleto', requestId };
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    const [first, replay] = await Promise.all([saveSocialCampaign(store, input, f.actorId, f.options), saveSocialCampaign(store, input, f.actorId, f.options)]);
    assert.deepEqual(first, replay); assert.equal(first.state, 'draft');
    const detail = await getSocialCampaign(store, first.id); assert.equal(detail.connectionId, null); assert.equal(detail.assetId, null);
    await assert.rejects(() => saveSocialCampaign(store, { ...input, name: 'Otro contenido' }, f.actorId, f.options), { status: 409 });
    const other = randomUUID(); await insertRow(store, 'users', { id: other, email: `${other}@example.test`, password: 'synthetic', active: 1 });
    await assert.rejects(() => saveSocialCampaign(store, input, other, f.options), { status: 409 });
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
    await assert.rejects(() => saveSocialCampaign(store, { name: 'Referencias inválidas', connectionId: randomUUID(), requestId: randomUUID() }, f.actorId, f.options), { status: 404 });
  }],
  ['dos confirmaciones concurrentes congelan una única revisión y una entrega por red sin operaciones API inventadas', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), input = { ...f.approvalInput(forecast), version: campaign.version, requestId: randomUUID() };
    const [first, replay] = await Promise.all([socialCampaignAction(store, campaign.id, 'approve-organic', input, f.actorId, f.options), socialCampaignAction(store, campaign.id, 'approve-organic', input, f.actorId, f.options)]);
    assert.deepEqual(first, replay); assert.equal(first.state, 'publishing'); assert.equal(first.deliveryIds.length, 2);
    assert.equal((await rows(store, 'social_revisions', campaign.id)).length, 1); assert.equal((await rows(store, 'social_deliveries', campaign.id)).length, 2);
    await assert.rejects(() => f.action(first, 'approve-organic', f.approvalInput(forecast)), { status: 409 });
    await assert.rejects(() => saveSocialCampaign(store, { id: first.id, version: first.version, requestId: randomUUID(), caption: 'Cambiar mientras procesa' }, f.actorId, f.options), { status: 409 });
  }],
  ['solicitudes distintas compiten por versión y sólo una aprobación vence', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const results = await Promise.allSettled([f.action(campaign, 'approve-organic', f.approvalInput(forecast)), f.action(campaign, 'approve-organic', f.approvalInput(forecast))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal((await rows(store, 'social_revisions', campaign.id)).length, 1);
  }],
  ['revisión conserva copia inmutable de especificación y previsión aunque cambie el borrador original', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const original = (await rows(store, 'social_revisions', campaign.id))[0], revision = JSON.parse(original.data);
    assert.deepEqual(revision.spec, forecast.spec); assert.deepEqual(revision.forecast, forecast.forecast); assert.equal(original.spec_hash, hash(revision.spec)); assert.equal(original.actor_id, f.actorId);
    const cancelled = await f.action(approved, 'cancel'); await f.action(cancelled, 'duplicate');
    assert.deepEqual((await rows(store, 'social_revisions', campaign.id))[0], original);
  }],
  ['pauta de dos redes confirma un total y una sola entrega sin activar ni marcar ready', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', objective: 'traffic' }), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const result = await f.action(campaign, 'prepare-paid', f.approvalInput(forecast));
    const deliveries = (await rows(store, 'social_deliveries', campaign.id)).map(entity), revision = JSON.parse((await rows(store, 'social_revisions', campaign.id))[0].data);
    assert.equal(result.state, 'publishing'); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].channel, 'meta_ads'); assert.equal(deliveries[0].state, 'queued'); assert.equal(deliveries[0].remoteId, null);
    assert.equal(revision.spec.budgetMinor, 5000000); assert.deepEqual(revision.budgetConfirmation, { investmentAccepted: true, budgetMinor: 5000000, currency: 'COP', startAt: START, endAt: END });
  }],
  ['falta derechos, hash, previsión, advertencias o aceptación monetaria impide toda intención', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', objective: 'traffic' }), campaign = await f.create(), forecast = await f.forecast(campaign.id), valid = f.approvalInput(forecast);
    for (const patch of [{ rightsAccepted: false }, { specHash: '0'.repeat(64) }, { forecastId: randomUUID() }, { acceptedWarnings: ['no-fue-mostrada'] }, { investmentAccepted: false }]) await assert.rejects(() => f.action(campaign, 'prepare-paid', { ...valid, ...patch }));
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []); assert.deepEqual(await rows(store, 'social_deliveries', campaign.id), []);
    const other = await f.create(); await store.db.run(`UPDATE ${store.t('social_forecasts')} SET campaign_id=? WHERE id=?`, [other.id, forecast.forecastId]);
    await assert.rejects(() => f.action(campaign, 'prepare-paid', valid), { status: 409 });
  }],
  ['advertencias orgánicas de CTA Instagram requieren aceptación completa de sus keys', async (store, t) => {
    const f = await setup(store, t, { objective: 'traffic', platforms: ['instagram'] }), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    assert.ok(forecast.acceptedWarnings.length > 0);
    await assert.rejects(() => f.action(campaign, 'approve-organic', { ...f.approvalInput(forecast), acceptedWarnings: [] }), { status: 409 });
    assert.equal((await f.action(campaign, 'approve-organic', f.approvalInput(forecast))).deliveryIds.length, 1);
  }],
  ['editar invalida evidencia y previsión sin borrar snapshots históricos', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    await patchData(store, 'social_campaigns', campaign.id, { forecastId: forecast.forecastId, forecast: forecast.forecast, preflight: { remoteDraftRef: '700' } });
    const edited = await saveSocialCampaign(store, { id: campaign.id, version: campaign.version, requestId: randomUUID(), caption: 'Nueva configuración' }, f.actorId, f.options);
    const detail = await getSocialCampaign(store, edited.id); for (const key of ['forecastId', 'forecast', 'preflight']) assert.equal(detail[key], undefined);
    assert.equal(detail.forecasts.length, 1);
    await assert.rejects(() => f.action(edited, 'approve-organic', f.approvalInput(forecast)), { status: 409 });
  }],
  ['actor deshabilitado no guarda ni duplica ni confirma ni reproduce un request previo', async (store, t) => {
    const f = await setup(store, t), request = { ...f.configuration, requestId: randomUUID() }, campaign = await saveSocialCampaign(store, request, f.actorId, f.options), forecast = await f.forecast(campaign.id);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => saveSocialCampaign(store, request, f.actorId, f.options), { status: 403 });
    for (const action of ['duplicate', 'cancel', 'approve-organic']) await assert.rejects(() => f.action(campaign, action, action === 'approve-organic' ? f.approvalInput(forecast) : {}), { status: 403 });
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
  }],
  ['flag, capacidades remotas y derivado manipulado bloquean antes de persistir aprobación', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), confirmation = f.approvalInput(forecast);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } }); await assert.rejects(() => f.action(campaign, 'approve-organic', confirmation), { status: 409 }); assert.deepEqual(f.remote.calls, []);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } }); f.remote.pageTasks = ['ANALYZE']; await assert.rejects(() => f.action(campaign, 'approve-organic', confirmation), { status: 409 });
    f.remote.pageTasks = ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE']; await writeFile(join(f.root, f.assetId, 'derivative.jpg'), 'tampered');
    await assert.rejects(() => f.action(campaign, 'approve-organic', confirmation), { status: 409 }); assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
  }],
  ['comprobación fuera de transacción fija versiones de cuenta/pieza/campaña/credenciales y actor al commit', async (store, t) => {
    for (const target of ['social_connections', 'social_assets', 'social_campaigns', 'social_credentials', 'actor']) {
      const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), entered = deferred(), release = deferred();
      f.remote.beforeRead = async path => { if (path === 'debug_token') { entered.resolve(); await release.promise; } };
      const approval = f.action(campaign, 'approve-organic', f.approvalInput(forecast)), rejected = assert.rejects(approval, { status: target === 'actor' ? 403 : 409 });
      await entered.promise;
      if (target === 'actor') await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
      else if (target === 'social_credentials') await store.db.run(`UPDATE ${store.t(target)} SET version=version+1 WHERE connection_id=?`, [f.connectionId]);
      else await store.db.run(`UPDATE ${store.t(target)} SET version=version+1 WHERE id=?`, [target === 'social_connections' ? f.connectionId : target === 'social_assets' ? f.assetId : campaign.id]);
      release.resolve(); await rejected; assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
    }
  }],
  ['cancelación revoca lease del trabajo no enviado y conserva revisión y evidencia', async (store, t) => {
    const f = await setup(store, t, { method: 'browser' }), campaign = await f.create({ publishAt: START }), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const revision = (await rows(store, 'social_revisions', campaign.id))[0], lease = await claimJob(store, { key: `social:browser:delivery:${approved.deliveryIds[0]}`, now: NOW }); assert.ok(lease.token);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } }); const cancelled = await f.action(approved, 'cancel'); assert.equal(cancelled.state, 'cancelled');
    for (const id of approved.deliveryIds) { const job = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser:delivery:${id}`]); assert.equal(job.state, 'failed'); assert.equal(job.lease_token, null); assert.equal((await get(store, 'social_deliveries', id)).state, 'cancelled'); }
    assert.ok((await rows(store, 'social_operations', campaign.id)).every(operation => operation.state === 'failed')); assert.deepEqual((await rows(store, 'social_revisions', campaign.id))[0], revision);
  }],
  ['cancelar preserva la entrega publicada y nunca resuelve un envío incierto', async (store, t) => {
    const f = await setup(store, t, { method: 'browser' }), campaign = await f.create(), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='sent' WHERE id=?`, [approved.operationIds[0]]);
    await assert.rejects(() => f.action(approved, 'cancel'), { status: 409 }); assert.equal((await get(store, 'social_campaigns', campaign.id)).state, 'publishing');
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='confirmed' WHERE id=?`, [approved.operationIds[0]]); await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state='published',remote_id='999' WHERE id=?`, [approved.deliveryIds[0]]);
    const cancelled = await f.action(approved, 'cancel');
    assert.equal(cancelled.state, 'partial');
    const published = await get(store, 'social_deliveries', approved.deliveryIds[0]);
    assert.equal(published.state, 'published'); assert.equal(published.remoteId, '999');
    assert.equal((await get(store, 'social_deliveries', approved.deliveryIds[1])).state, 'cancelled');
  }],
  ['duplicar crea borrador limpio sin incrementar presupuesto ni copiar trabajos/aceptación/fechas/vínculos', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', objective: 'traffic' }), campaign = await f.create(), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'prepare-paid', f.approvalInput(forecast));
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } }); const duplicate = await f.action(approved, 'duplicate'), detail = await getSocialCampaign(store, duplicate.id);
    assert.equal(detail.state, 'draft'); assert.equal(detail.parentCampaignId, campaign.id); assert.equal(detail.budgetMinor, 5000000); assert.equal(detail.startAt, null); assert.equal(detail.endAt, null); assert.equal(detail.publishAt, null);
    for (const key of ['forecastId', 'forecast', 'preflight', 'rightsAccepted', 'acceptedWarnings', 'investmentAccepted', 'remoteRefs', 'preparedRefs']) assert.equal(detail[key], undefined);
    for (const table of ['social_revisions', 'social_deliveries', 'social_operations', 'social_order_links', 'social_expense_links']) assert.deepEqual(await rows(store, table, duplicate.id), []);
    const serialized = JSON.stringify(detail); for (const secret of ['PRIVATE-UPLOAD-FENCE', 'PRIVATE-PROCESSING-FENCE', TOKEN, PAGE_TOKEN, f.env.META_APP_SECRET]) assert.equal(serialized.includes(secret), false);
  }],
  ['duplicar tras seleccionar otra cuenta no convierte presupuesto COP a USD ni reutiliza su ámbito', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', objective: 'traffic' });
    const campaign = await f.create({ targetCostMinor: 100000, audience: { countries: ['CO'], interests: [{ key: 'api:interest:900', source: 'api', providerId: '900', label: 'Deporte', context: { type: 'interest', path: ['Intereses', 'Deporte'] } }] } });
    const forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'prepare-paid', f.approvalInput(forecast));
    const revision = (await rows(store, 'social_revisions', campaign.id))[0];
    const connection = await get(store, 'social_connections', f.connectionId);
    await patchData(store, 'social_connections', f.connectionId, {
      currency: 'USD', identities: { ...connection.identities, adAccountId: 'act_401' },
      resources: { ...connection.resources, adAccounts: [{ ...connection.resources.adAccounts[0], id: 'act_401', currency: 'USD' }] }
    }, { bump: true });
    const duplicate = await f.action(approved, 'duplicate'), detail = await getSocialCampaign(store, duplicate.id);
    assert.equal(detail.currency, 'USD');
    assert.equal(detail.budgetMinor, 0);
    assert.equal(detail.targetCostMinor, null);
    assert.deepEqual(detail.audience.interests, []);
    assert.deepEqual((await rows(store, 'social_revisions', campaign.id))[0], revision);
  }],
  ['browser paid adopta validate confirmado de la versión vigente sin recrear draft ni activar', async (store, t) => {
    const f = await setup(store, t, { method: 'browser', mode: 'paid', objective: 'traffic' }), initial = await f.create(), validated = await validatedPreflight(f, initial), forecast = await f.forecast(initial.id);
    for (const key of ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID']) delete f.env[key];
    const result = await f.action(validated.campaign, 'prepare-paid', f.approvalInput(forecast)), delivery = await get(store, 'social_deliveries', result.deliveryIds[0]), operation = await get(store, 'social_operations', result.operationIds[0]);
    assert.equal(result.deliveryIds.length, 1); assert.equal(result.state, 'publishing'); assert.equal(delivery.remoteRefs.remoteDraftRef, validated.ref); assert.equal(delivery.remoteId, null);
    assert.equal(operation.step, 'prepare-paid'); assert.equal(operation.state, 'prepared'); assert.equal(operation.remoteDraftRef, validated.ref); assert.deepEqual(operation.mediaEvidence, validated.mediaEvidence); assert.equal(operation.investmentAccepted, undefined);
    assert.deepEqual(f.remote.calls, []); assert.equal((await rows(store, 'social_operations', initial.id)).length, 2);
  }],
  ['browser paid rechaza preflight ausente, ajeno, antiguo, sin media o con prepare incierto', async (store, t) => {
    for (const fault of ['absent', 'version', 'hash', 'media', 'reference', 'uncertain', 'newerValidate']) {
      const f = await setup(store, t, { method: 'browser', mode: 'paid', objective: 'traffic' }), initial = await f.create(), validated = await validatedPreflight(f, initial), forecast = await f.forecast(initial.id);
      const current = await get(store, 'social_campaigns', initial.id);
      if (fault === 'absent') await patchData(store, 'social_campaigns', initial.id, { preflight: null });
      if (fault === 'version') await patchData(store, 'social_operations', validated.operationId, { campaignVersion: 0 });
      if (fault === 'hash') await patchData(store, 'social_operations', validated.operationId, { specHash: '0'.repeat(64) });
      if (fault === 'media') await patchData(store, 'social_campaigns', initial.id, { preflight: { ...current.preflight, mediaEvidence: { ...current.preflight.mediaEvidence, sha256: '0'.repeat(64) } } });
      if (fault === 'reference') await patchData(store, 'social_campaigns', initial.id, { preflight: { ...current.preflight, remoteDraftRef: '999' } });
      if (fault === 'uncertain') await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: initial.id, delivery_id: null, operation_key: `preflight:${initial.id}:${randomUUID()}`, step: 'prepare', state: 'uncertain', next_attempt_at: null, ...editable({ integrationMethod: 'browser', actorId: f.actorId, specHash: forecast.specHash, campaignVersion: current.version, acceptPrivateDraft: true }) });
      if (fault === 'newerValidate') await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: initial.id, delivery_id: null, operation_key: `preflight:${initial.id}:${randomUUID()}`, step: 'validate', state: 'failed', next_attempt_at: null, ...editable({ integrationMethod: 'browser', actorId: f.actorId, specHash: forecast.specHash, campaignVersion: current.version, remoteDraftRef: validated.ref }) });
      await assert.rejects(() => f.action(current, 'prepare-paid', f.approvalInput(forecast)), { status: 409 }); assert.deepEqual(await rows(store, 'social_revisions', initial.id), []);
    }
  }],
  ['referencias API se reconsultan y un contexto oficial alterado nunca se aprueba', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid', objective: 'traffic' });
    const interest = { key: 'api:interest:900', source: 'api', providerId: '900', label: 'Deporte', context: { type: 'interest', path: ['Intereses', 'Otra categoría'] } };
    const campaign = await f.create({ audience: { ...f.configuration.audience, interests: [interest] } }), forecast = await f.forecast(campaign.id);
    await assert.rejects(() => f.action(campaign, 'prepare-paid', f.approvalInput(forecast)));
    assert.ok(f.remote.calls.includes('search')); assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
    const edited = await saveSocialCampaign(store, { id: campaign.id, version: campaign.version, requestId: randomUUID(), audience: { ...f.configuration.audience, interests: [{ ...interest, context: { type: 'interest', path: ['Intereses', 'Deporte'] } }] } }, f.actorId, f.options);
    const currentForecast = await f.forecast(edited.id);
    assert.equal((await f.action(edited, 'prepare-paid', f.approvalInput(currentForecast))).deliveryIds.length, 1);
  }],
  ['preparar draft incompleto exige consentimiento, serializa solicitudes y no crea aprobación ni inversión', async (store, t) => {
    const f = await setup(store, t, { method: 'browser', mode: 'paid' });
    const created = await f.create({ assetId: null, platforms: [], placements: [], caption: '', headline: '', destinationUrl: '', budgetMinor: 0, startAt: null, endAt: null, aiDisclosure: null });
    const before = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`);
    const input = { version: created.version, requestId: randomUUID(), kind: 'prepare', acceptPrivateDraft: true };
    await assert.rejects(() => queueSocialBrowserPreflight(store, created.id, { ...input, acceptPrivateDraft: false }, f.actorId, f.options), { status: 400 });
    const [first, replay] = await Promise.all([queueSocialBrowserPreflight(store, created.id, input, f.actorId, f.options), queueSocialBrowserPreflight(store, created.id, input, f.actorId, f.options)]);
    assert.deepEqual(first, replay);
    await assert.rejects(() => queueSocialBrowserPreflight(store, created.id, { ...input, requestId: randomUUID() }, f.actorId, f.options), { status: 409 });
    await patchData(store, 'social_operations', first.operationId, { leaseToken: 'OPERATION-FENCE-CANARY' });
    const publicOperation = await getSocialOperation(store, first.operationId);
    assert.equal(publicOperation.state, 'prepared'); assert.equal(publicOperation.deliveryId, null);
    for (const value of [publicOperation, await getSocialCampaign(store, created.id)]) assert.equal(JSON.stringify(value).includes('OPERATION-FENCE-CANARY'), false);
    assert.equal((await rows(store, 'social_operations', created.id)).length, 1);
    assert.deepEqual(await rows(store, 'social_revisions', created.id), []); assert.deepEqual(await rows(store, 'social_deliveries', created.id), []);
    assert.deepEqual(await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`), before);
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='sent' WHERE id=?`, [first.operationId]);
    const current = await getSocialCampaign(store, created.id);
    await assert.rejects(() => queueSocialBrowserPreflight(store, created.id, { ...input, version: current.version, requestId: randomUUID() }, f.actorId, f.options), { status: 409 });
    await assert.rejects(() => saveSocialCampaign(store, { id: created.id, version: current.version, requestId: randomUUID(), caption: 'Cambio prematuro' }, f.actorId, f.options), { status: 409 });
    await f.action(current, 'reconcile');
    assert.equal((await rows(store, 'social_operations', created.id)).length, 1);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['editar invalida validate pero conserva el mismo draft privado y permite búsqueda readonly sin flag', async (store, t) => {
    const f = await setup(store, t, { method: 'browser', mode: 'paid' }), initial = await f.create(), validated = await validatedPreflight(f, initial);
    const saved = await saveSocialCampaign(store, { id: initial.id, version: validated.campaign.version, requestId: randomUUID(), caption: 'Propuesta corregida' }, f.actorId, f.options);
    const changed = await getSocialCampaign(store, saved.id);
    assert.equal(changed.preflight.remoteDraftRef, validated.ref);
    for (const key of ['observedSpec', 'preparedRefs', 'mediaEvidence', 'specHash', 'operationId']) assert.equal(changed.preflight[key], undefined);
    const forecast = await f.forecast(saved.id);
    await assert.rejects(() => f.action(saved, 'prepare-paid', f.approvalInput(forecast)), { status: 409 });
    await assert.rejects(() => queueSocialBrowserPreflight(store, saved.id, { version: saved.version, requestId: randomUUID(), kind: 'prepare', acceptPrivateDraft: true }, f.actorId, f.options), { status: 409 });
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const queued = await queueSocialBrowserPreflight(store, saved.id, { version: saved.version, requestId: randomUUID(), kind: 'targeting', query: { kind: 'location', q: 'Bogotá' } }, f.actorId, f.options);
    const operation = await get(store, 'social_operations', queued.operationId);
    assert.equal(operation.remoteDraftRef, validated.ref); assert.equal(operation.state, 'prepared');
    assert.deepEqual(await rows(store, 'social_revisions', saved.id), []); assert.deepEqual(f.remote.calls, []);
  }],
  ['borrador recuperado sólo se libera con derechos nuevos y retira trabajo antiguo sin ejecutarlo', async (store, t) => {
    const f = await setup(store, t, { method: 'browser', mode: 'paid' });
    const created = await f.create({ assetId: null, budgetMinor: 0, startAt: null, endAt: null, aiDisclosure: null });
    const pending = await queueSocialBrowserPreflight(store, created.id, { version: created.version, requestId: randomUUID(), kind: 'prepare', acceptPrivateDraft: true }, f.actorId, f.options);
    await patchData(store, 'social_campaigns', created.id, { restore_hold: true }, { bump: true }); await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const held = await getSocialCampaign(store, created.id), connection = await get(store, 'social_connections', f.connectionId), built = buildSocialDraftSpec(held, { connection });
    await assert.rejects(() => f.action(held, 'resume-restored', { specHash: built.specHash, rightsAccepted: false, acceptPrivateDraft: true }), { status: 409 });
    const accepted = await f.action(held, 'resume-restored', { specHash: built.specHash, rightsAccepted: true, acceptPrivateDraft: true });
    assert.equal(accepted.state, 'draft'); assert.equal(accepted.requestedState, 'draft_review');
    const restored = await getSocialCampaign(store, created.id);
    assert.equal(restored.restore_hold, false); assert.equal((await get(store, 'social_operations', pending.operationId)).state, 'failed');
    assert.deepEqual(restored.revisions, []); assert.deepEqual(restored.deliveries, []); assert.deepEqual(f.remote.calls, []);
    assert.equal((await store.db.get(`SELECT state FROM ${store.t('job_runs')} WHERE key=?`, [`social:browser:preflight:${pending.operationId}`])).state, 'failed');
  }]
];
export async function runSocialCampaignContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async context => {
    const store = await factory();
    try { await scenario(store, context); } finally { await store.close(); }
  });
}
