import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { entity, hash, insertRow } from '../lib/business/commands.mjs';
import { saveSocialCampaign, socialCampaignAction, getSocialCampaign, getSocialOperation, queueSocialBrowserPreflight } from '../lib/business/social.mjs';
import { buildSocialSpec, buildSocialDraftSpec } from '../lib/business/social-spec.mjs';
import { getSocialOffer, listSocialOffers, resolveSocialOffer } from '../lib/business/social-offers.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { META_PERMISSIONS } from '../lib/social/config.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { processSocialApiTurn } from '../lib/business/social-api-jobs.mjs';
import { processSocialBrowserTurn } from '../lib/business/social-jobs.mjs';
import { createMetaPublishingProvider } from './social-meta-provider.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';
import { loadSocialRuntime } from '../lib/social/config.mjs';

const NOW = '2026-11-02T12:00:00.000Z';
const REQUESTED_AT = '2026-11-02T13:00:00.000Z';
const START = '2026-11-03T12:00:00.000Z', END = '2026-11-10T12:00:00.000Z';
const TOKEN = 'CAMPAIGN-SYNTHETIC-USER-TOKEN', PAGE_TOKEN = 'CAMPAIGN-SYNTHETIC-PAGE-TOKEN';
const editable = data => ({ data: JSON.stringify(data), version: 1, created_at: NOW, updated_at: NOW });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const get = async (store, table, id) => entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id]));
const rows = (store, table, campaignId) => store.db.all(`SELECT * FROM ${store.t(table)} WHERE campaign_id=?`, [campaignId]);
const socialJobs = store => store.db.all(`SELECT * FROM ${store.t('job_runs')} WHERE key LIKE 'social:%' ORDER BY key`);
const publicationInput = ({ revision, specHash }) => ({ revision, specHash, publishAccepted: true });
const fixtureUser = async store => {
  const id = randomUUID();
  await insertRow(store, 'users', { id, email: `${id}@example.test`, password: 'synthetic-not-used', active: 1 });
  return id;
};
async function assertUnqueued(store, campaignId) {
  assert.deepEqual(await rows(store, 'social_deliveries', campaignId), []);
  assert.deepEqual(await rows(store, 'social_operations', campaignId), []);
  assert.deepEqual(await socialJobs(store), []);
}
async function patchData(store, table, id, patch, { bump = false } = {}) {
  const row = await store.db.get(`SELECT data FROM ${store.t(table)} WHERE id=?`, [id]);
  await store.db.run(`UPDATE ${store.t(table)} SET data=?${bump ? ',version=version+1' : ''} WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), ...patch }), id]);
}
function syntheticProvider() {
  // Account state is independent of the submitted specification. Commands may
  // only read; worker tests use the stateful synthetic publishing provider.
  const remote = { currency: 'COP', pageTasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'], accountStatus: 1, permission: true, calls: [], beforeRead: null };
  remote.fetchImpl = async (href, init) => {
    const url = new URL(href), path = url.pathname.replace('/v26.0/', '');
    remote.calls.push(path);
    assert.equal(url.hostname, 'graph.facebook.com'); assert.equal(init.method, 'GET');
    if (remote.beforeRead) await remote.beforeRead(path);
    let data;
    if (path === 'debug_token') data = { data: { app_id: '42', type: 'USER', is_valid: true, user_id: '100', expires_at: Date.parse(NOW) / 1000 + 86400, data_access_expires_at: Date.parse(NOW) / 1000 + 172800, scopes: META_PERMISSIONS } };
    else if (path === 'me') data = { id: '100', name: 'Administrador sintético' };
    else if (path === 'me/permissions') data = { data: (remote.permission ? META_PERMISSIONS : []).map(permission => ({ permission, status: 'granted' })) };
    else if (path === 'me/accounts') data = { data: [{ id: '200', name: 'Página sintética', tasks: remote.pageTasks, access_token: PAGE_TOKEN, business: { id: '500', name: 'Negocio sintético' }, instagram_business_account: { id: '300', username: 'synthetic' }, whatsapp_number: '+573001234567' }] };
    else if (path === 'me/adaccounts') data = { data: [{ id: 'act_400', name: 'Cuenta sintética', currency: remote.currency, timezone_name: 'America/Bogota', account_status: remote.accountStatus, user_tasks: ['ADVERTISE', 'ANALYZE'], business: { id: '500', name: 'Negocio sintético' } }] };
    else if (path === '200') data = { id: '200', whatsapp_number: '+573001234567' };
    else if (path === 'act_400') data = { id: 'act_400', user_tasks: ['ADVERTISE', 'ANALYZE'], business: { id: '500' } };
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
  const actorId = await fixtureUser(store), connectionId = randomUUID(), assetId = randomUUID(), remote = syntheticProvider();
  const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: method === 'api' ? 'act_400' : '400' };
  const connectionData = { name: 'Conexión sintética', identities, currency: 'COP', timeZone: 'America/Bogota', sessionEpoch: 0, capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, insights: true, whatsappAds: true }, resources: { pages: [{ id: '200', instagramId: '300', whatsappNumber: '+573001234567', businessId: '500', tasks: ['CREATE_CONTENT', 'ADVERTISE', 'ANALYZE'] }], adAccounts: [{ id: identities.adAccountId, currency: 'COP', timeZone: 'America/Bogota', accountStatus: 1, businessId: '500', tasks: ['ADVERTISE', 'ANALYZE'] }] } };
  await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: method, state: 'connected', ...editable(connectionData) });
  await saveCredentials(store, connectionId, method === 'api' ? { accessToken: TOKEN, userId: '100', pageTokens: { 200: PAGE_TOKEN } } : { storageState: { cookies: [], origins: [] } }, { runtime: (await configureSocialTestRuntime(store, { env })).runtime });
  const bytes = await sharp({ create: { width: 540, height: 675, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const assetHash = createHash('sha256').update(bytes).digest('hex'), key = `${assetId}/derivative.jpg`;
  await mkdir(join(root, assetId), { mode: 0o700 }); await writeFile(join(root, key), bytes, { mode: 0o600 });
  await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: assetHash, bytes: bytes.length, ...editable({ name: 'Pieza aportada', kind: 'image', contentType: 'image/jpeg', derivativeKey: key, derivativeSha256: assetHash, derivativeBytes: bytes.length, derivativeContentType: 'image/jpeg', width: 540, height: 675, uploadFence: 'PRIVATE-UPLOAD-FENCE', processingFence: 'PRIVATE-PROCESSING-FENCE' }) });
  const configuration = { name: 'Campaña sintética', connectionId, assetId, mode, objective, platforms, caption: 'Texto escrito por el administrador', headline: '', destinationUrl: mode === 'paid' && objective === 'traffic' ? 'https://example.test/products' : '', whatsappNumber: objective === 'whatsapp' ? '+573001234567' : '', whatsappGreeting: objective === 'whatsapp' ? 'Quiero consultar sobre este producto' : '', audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, placements: platforms.map(platform => `${platform}_feed`), budgetMinor: mode === 'paid' ? 5000000 : 0, publishAt: null, startAt: mode === 'paid' ? START : null, endAt: mode === 'paid' ? END : null, observationDays: 7, aiDisclosure: false };
  configuration.marketCountries = ['CO'];
  const options = { env, now: NOW, transport: { fetchImpl: remote.fetchImpl } };
  const context = { store, env, actorId, connectionId, assetId, assetHash, configuration, options, remote, root };
  context.create = (extra = {}) => saveSocialCampaign(store, { ...configuration, ...extra, requestId: randomUUID() }, actorId, options);
  context.action = (campaign, action, extra = {}, { actorId: by = actorId, ...overrides } = {}) => socialCampaignAction(store, campaign.id, action, { version: campaign.version, requestId: randomUUID(), ...extra }, by, { ...options, ...overrides });
  context.publish = (approved, overrides) => context.action(approved, 'publish-organic', publicationInput(approved), overrides);
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
  ['una pendiente histórica conserva su audiencia, exige mercado explícito y duplica sólo la nueva configuración', async (store, t) => {
    const f = await setup(store, t, { mode: 'paid' });
    const original = await f.create();
    const row = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [original.id]);
    const { marketCountries: _market, audienceMode: _provenance, ...legacy } = JSON.parse(row.data);
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=? WHERE id=?`, [JSON.stringify(legacy), original.id]);
    const saved = await saveSocialCampaign(store, { id: original.id, version: original.version, requestId: randomUUID(), name: 'Edición anterior a elegir mercado' }, f.actorId, f.options);
    const incomplete = await f.build(saved.id);
    assert.equal(Object.hasOwn(incomplete.campaign, 'marketCountries'), false);
    assert.deepEqual(incomplete.campaign.audience, legacy.audience);
    const historicalForecast = await f.forecast(saved.id);
    await assert.rejects(f.action(saved, 'prepare-paid', f.approvalInput(historicalForecast)), /confirma al menos un país/);
    await assert.rejects(saveSocialCampaign(store, { id: saved.id, version: saved.version, requestId: randomUUID(), audienceMode: 'automatic' }, f.actorId, f.options), /desde el cliente/);
    const market = await saveSocialCampaign(store, { id: saved.id, version: saved.version, requestId: randomUUID(),
      marketCountries: ['PE', 'MX', 'MX'], audience: { countries: ['PE', 'MX'] } }, f.actorId, f.options);
    const next = await f.build(market.id);
    assert.notEqual(next.specHash, historicalForecast.specHash);
    assert.deepEqual(next.spec.marketCountries, ['MX', 'PE']);
    assert.equal(next.spec.currency, 'COP');
    assert.equal(next.spec.audienceMode, 'manual');
    const duplicate = await f.action(market, 'duplicate');
    const copy = await get(store, 'social_campaigns', duplicate.id);
    assert.deepEqual(copy.marketCountries, ['MX', 'PE']);
    assert.deepEqual(copy.audience, next.spec.audience);
    assert.equal(copy.audienceMode, 'manual');
    assert.equal(copy.startAt, null);
    await assertUnqueued(store, original.id);
  }],
  ['la oferta revisada conserva variante, composición y condición y congela la aprobación', async (store, t) => {
    const f = await setup(store, t);
    const product = (slug, flavor) => store.save('products', { slug, title: 'Proteína', status: 'draft', orderable: true, flavor, presentation: '500 g', stockQuantity: 10, price: 45000, sku: slug });
    const cacao = await product('qa-cacao', 'Cacao'), vainilla = await product('qa-vainilla', 'Vainilla');
    const combo = await store.save('combos', { slug: 'duo-qa', title: 'Dúo', status: 'draft', orderable: true, price: 73000, conditions: 'Presentación individual', items: [{ productId: cacao.id, quantity: 2 }] });
    const gift = await store.save('products', { slug: 'muestra-qa', title: 'Muestra', status: 'draft', productType: 'gift', price: 0, items: [{ productId: cacao.id, quantity: 1 }] });
    const page = await listSocialOffers(store, { query: 'proteína', kind: 'product', limit: 1 });
    assert.equal(page.nextOffset, 1);
    const second = await listSocialOffers(store, { query: 'proteína', kind: 'product', offset: page.nextOffset, limit: 1 });
    assert.deepEqual([...page.offers, ...second.offers].map(item => item.id), [cacao.id, vainilla.id].sort());
    assert.equal(second.nextOffset, null);
    assert.deepEqual((await listSocialOffers(store, { query: 'vAiNiLlA', kind: 'product' })).offers.map(item => item.id), [vainilla.id]);
    assert.deepEqual((await listSocialOffers(store, { query: 'DÚO', kind: 'combo' })).offers.map(item => item.id), [combo.id]);
    assert.deepEqual((await listSocialOffers(store, { query: '%_' })).offers, []);
    const [primary, extra] = await Promise.all([getSocialOffer(store, 'combo', combo.id), getSocialOffer(store, 'gift', gift.id)]);
    const offerRef = { primary: { id: combo.id, kind: 'combo', factsHash: primary.factsHash }, gift: { id: gift.id, factsHash: extra.factsHash, condition: 'Solo con Dúo' } };
    await patchData(store, 'records', cacao.id, { stockQuantity: 2, stockReserved: 0 }, { bump: true });
    assert.equal((await getSocialOffer(store, 'combo', combo.id)).selectable, true);
    assert.equal((await getSocialOffer(store, 'gift', gift.id)).selectable, true);
    await assert.rejects(() => resolveSocialOffer(store, offerRef), /compra y el obsequio juntos/);
    await patchData(store, 'records', cacao.id, { stockQuantity: 7, sku: 'SKU-OPERATIVO-NUEVO', unitCostMinor: 999 }, { bump: true });
    assert.equal((await getSocialOffer(store, 'combo', combo.id)).factsHash, primary.factsHash);
    assert.equal((await getSocialOffer(store, 'gift', gift.id)).factsHash, extra.factsHash);
    const incomplete = await f.create({ offerRef: { ...offerRef, gift: { ...offerRef.gift, condition: '' } } });
    const invalidDetail = await getSocialCampaign(store, incomplete.id, f.options);
    assert.match(invalidDetail.validation.offerError, /condición/i);
    const incompleteForecast = await f.forecast(incomplete.id);
    await assert.rejects(() => f.action(incomplete, 'approve-organic', f.approvalInput(incompleteForecast)), /condición/i);
    const campaign = await f.create({ offerRef });
    const edit = (record, changes) => saveSocialCampaign(store, { id: record.id, version: record.version, requestId: randomUUID(), ...changes }, f.actorId, f.options);
    const edited = await edit(campaign, { caption: 'Texto conservando la oferta' });
    const detail = await getSocialCampaign(store, edited.id, f.options);
    const snapshot = detail.offerSnapshot;
    assert.deepEqual(detail.offerRef, offerRef);
    assert.deepEqual(snapshot.primary.components, [{ id: cacao.id, title: 'Proteína', flavor: 'Cacao', presentation: '500 g', image: null, quantity: 2 }]);
    assert.deepEqual([snapshot.primary.price, snapshot.gift.price, snapshot.gift.condition], [73000, 0, 'Solo con Dúo']);
    assert.equal(detail.offerHash, hash(snapshot));
    const removed = await edit(await f.create({ offerRef }), { offerRef: null });
    assert.equal((await f.build(removed.id)).spec.offerHash, undefined);
    const reviewed = await f.forecast(edited.id);
    const changed = await edit(edited, { offerRef: { ...offerRef, gift: { ...offerRef.gift, condition: 'Solo este fin de semana con Dúo' } } });
    await assert.rejects(() => f.action(changed, 'approve-organic', f.approvalInput(reviewed)), { status: 409 });
    const pristine = await f.create({ offerRef }), forecast = await f.forecast(pristine.id);
    const approved = await f.action(pristine, 'approve-organic', f.approvalInput(forecast));
    const frozen = (await rows(store, 'social_revisions', approved.id))[0];
    assert.deepEqual(JSON.parse(frozen.data).offerSnapshot, snapshot);
    for (const patch of [{ price: 75000 }, { price: 73000, items: [{ productId: vainilla.id, quantity: 3 }] }]) {
      await patchData(store, 'records', combo.id, patch, { bump: true });
      await assert.rejects(() => f.action(changed, 'approve-organic', f.approvalInput(reviewed)), /ficha comercial/i);
      await assert.rejects(() => f.publish(approved), /ficha comercial/i);
      await assert.rejects(() => f.create({ offerRef }), { status: 409 });
    }
    assert.deepEqual(await rows(store, 'social_deliveries', changed.id), []);
    const inventory = await get(store, 'records', cacao.id);
    assert.equal(inventory.stockQuantity, 7);
    assert.equal(inventory.stockReserved, 0);
    const historical = await getSocialCampaign(store, approved.id);
    assert.match(historical.validation.offerError, /ficha comercial/i);
    assert.equal(historical.validation.specHash, null);
    assert.deepEqual(historical.revisions[0].offerSnapshot, snapshot);
    await assertUnqueued(store, approved.id);
    assert.deepEqual(f.remote.calls, []);
    const duplicate = await f.action(await f.action(approved, 'cancel'), 'duplicate');
    const copied = await getSocialCampaign(store, duplicate.id, f.options);
    assert.deepEqual(copied.offerSnapshot, snapshot);
    assert.match(copied.validation.offerError, /ficha comercial/i);
    assert.deepEqual(await rows(store, 'social_revisions', duplicate.id), []);
    assert.deepEqual((await rows(store, 'social_revisions', approved.id))[0], frozen);
  }],
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
  ['aprobar con publicación deshabilitada sólo congela una revisión y ningún consumidor tiene trabajo', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), input = { ...f.approvalInput(forecast), version: campaign.version, requestId: randomUUID() };
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const [first, replay] = await Promise.all([socialCampaignAction(store, campaign.id, 'approve-organic', input, f.actorId, f.options), socialCampaignAction(store, campaign.id, 'approve-organic', input, f.actorId, f.options)]);
    assert.deepEqual(first, replay);
    assert.deepEqual({ state: first.state, revision: first.revision, specHash: first.specHash, deliveryIds: first.deliveryIds, operationIds: first.operationIds, deliveries: first.deliveries }, { state: 'ready', revision: 1, specHash: forecast.specHash, deliveryIds: [], operationIds: [], deliveries: [] });
    const revisions = await rows(store, 'social_revisions', campaign.id);
    assert.equal(revisions.length, 1); assert.equal(revisions[0].actor_id, f.actorId); assert.equal(revisions[0].approved_at, NOW);
    const [audit] = await store.db.all(`SELECT actor_id, recorded_at FROM ${store.t('business_audit')} WHERE entity_type='social_campaign' AND entity_id=? AND recorded_at=?`, [campaign.id, NOW]);
    assert.equal(audit.actor_id, f.actorId);
    await assertUnqueued(store, campaign.id);
    await assert.rejects(() => f.action(first, 'approve-organic', f.approvalInput(forecast)), { status: 409 });
    await assert.rejects(() => f.action(first, 'analyze'), { status: 409 });
    await assert.rejects(() => saveSocialCampaign(store, { id: first.id, version: first.version, requestId: randomUUID(), caption: 'Cambiar después de aprobar' }, f.actorId, f.options), { status: 409 });
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } });
    assert.equal((await processSocialApiTurn(store, f.options)).processed, 0);
    assert.equal((await processSocialBrowserTurn(store, f.options)).processed, 0);
    await assertUnqueued(store, campaign.id);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['solicitudes distintas compiten por versión y sólo una aprobación vence', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const results = await Promise.allSettled([f.action(campaign, 'approve-organic', f.approvalInput(forecast)), f.action(campaign, 'approve-organic', f.approvalInput(forecast))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal((await rows(store, 'social_revisions', campaign.id)).length, 1);
    await assertUnqueued(store, campaign.id);
  }],
  ['una hora después se solicita publicación idempotente FB+IG con el reloj y actor del segundo paso', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const [revision] = await rows(store, 'social_revisions', campaign.id), requester = await fixtureUser(store);
    const input = { ...publicationInput(approved), version: approved.version, requestId: randomUUID() };
    const submit = (body, now = REQUESTED_AT) => socialCampaignAction(store, campaign.id, 'publish-organic', body, requester, { ...f.options, now });
    const requests = [input, { ...input, requestId: randomUUID() }];
    const results = await Promise.allSettled(requests.map(body => submit(body)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    const winner = results.findIndex(result => result.status === 'fulfilled'), receipt = results[winner].value;
    assert.equal(receipt.state, 'publishing'); assert.equal(receipt.revision, approved.revision); assert.equal(receipt.specHash, forecast.specHash);
    assert.deepEqual(receipt.operationIds, []);
    assert.deepEqual(receipt.deliveries.map(delivery => [delivery.channel, delivery.state]).sort(), [['facebook', 'queued'], ['instagram', 'queued']]);
    assert.equal(receipt.deliveryIds.length, 2);
    assert.ok(f.remote.calls.includes('debug_token'));
    const reads = [...f.remote.calls];
    const deliveries = (await rows(store, 'social_deliveries', campaign.id)).map(entity);
    assert.deepEqual(deliveries.map(delivery => delivery.id).sort(), [...receipt.deliveryIds].sort());
    for (const delivery of deliveries) {
      assert.equal(delivery.publishRequestedBy, requester); assert.equal(delivery.createdAt, REQUESTED_AT);
      assert.equal(delivery.specHash, forecast.specHash); assert.deepEqual(delivery.identities, forecast.spec.identities);
    }
    assert.deepEqual(await rows(store, 'social_operations', campaign.id), []);
    assert.deepEqual((await socialJobs(store)).map(job => [job.key, job.state]), [...receipt.deliveryIds].sort().map(id => [`social:delivery:${id}`, 'queued']));
    const remote = createMetaPublishingProvider({ now: Date.parse(REQUESTED_AT), pageToken: PAGE_TOKEN });
    const turn = await processSocialApiTurn(store, { ...f.options, now: REQUESTED_AT, maxOperations: 1, transport: { fetchImpl: remote.fetchImpl } });
    assert.equal(turn.processed, 1); assert.equal(turn.errorCode, null);
    assert.equal(remote.requests.filter(request => request.method === 'POST').length, 1);
    assert.deepEqual(await submit(requests[winner], '2026-11-02T14:00:00.000Z'), receipt);
    await assert.rejects(() => submit({ ...requests[winner], specHash: '0'.repeat(64) }), { status: 409 });
    assert.deepEqual(f.remote.calls, reads);
    const audit = await store.db.all(`SELECT actor_id, recorded_at, data FROM ${store.t('business_audit')} WHERE entity_type='social_campaign' AND entity_id=? AND recorded_at=?`, [campaign.id, REQUESTED_AT]);
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, requester);
    const recorded = JSON.parse(audit[0].data).next;
    assert.equal(recorded.revision, receipt.revision); assert.deepEqual(recorded.channels, forecast.spec.platforms);
    assert.deepEqual(recorded.deliveryIds, receipt.deliveryIds);
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), [revision]);
    assert.equal((await rows(store, 'social_deliveries', campaign.id)).length, 2);
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
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    assert.deepEqual(approved.deliveryIds, []);
    assert.equal((await f.publish(approved)).deliveryIds.length, 1);
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
  ['publicar exige aprobación vigente, revisión exacta y consentimiento; cancelar no encola', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    await assert.rejects(() => f.action(campaign, 'publish-organic', publicationInput({ revision: 1, specHash: forecast.specHash })), { status: 409 });
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast)), valid = publicationInput(approved);
    for (const patch of [{ revision: approved.revision + 1 }, { version: campaign.version }, { specHash: '0'.repeat(64) }]) {
      await assert.rejects(() => f.action(approved, 'publish-organic', { ...valid, ...patch }), { status: 409 });
    }
    await assert.rejects(() => f.action(approved, 'publish-organic', { revision: valid.revision, specHash: valid.specHash }));
    await assert.rejects(() => f.action(approved, 'publish-organic', { ...valid, publishAccepted: false }));
    await assert.rejects(() => f.action(approved, 'publish-organic', { ...valid, caption: 'Texto no aprobado' }));
    const [revision] = await rows(store, 'social_revisions', campaign.id);
    const cancelled = await f.action(approved, 'cancel');
    assert.equal(cancelled.state, 'cancelled');
    await assert.rejects(() => f.action(cancelled, 'publish-organic', valid), { status: 409 });
    const duplicate = await f.action(cancelled, 'duplicate');
    assert.equal(duplicate.state, 'draft');
    await assertUnqueued(store, approved.id);
    await assertUnqueued(store, duplicate.id);
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), [revision]);
    assert.deepEqual(await rows(store, 'social_revisions', duplicate.id), []);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['publicación deshabilitada, cuenta revocada o aprobación sin actor vigente bloquean la segunda solicitud', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    await assert.rejects(() => f.publish(approved), { status: 409 });
    assert.deepEqual(f.remote.calls, []);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: true } });
    f.remote.permission = false;
    await assert.rejects(() => f.publish(approved));
    assert.ok(f.remote.calls.includes('me/permissions'));
    f.remote.permission = true;
    f.remote.pageTasks = ['ANALYZE'];
    await assert.rejects(() => f.publish(approved), { status: 409 });
    f.remote.pageTasks = ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE'];
    await store.db.run(`UPDATE ${store.t('social_connections')} SET state='reconnect_required' WHERE id=?`, [f.connectionId]);
    await assert.rejects(() => f.publish(approved), { status: 409 });
    await store.db.run(`UPDATE ${store.t('social_connections')} SET state='connected' WHERE id=?`, [f.connectionId]);
    const other = await fixtureUser(store), valid = { ...publicationInput(approved), requestId: randomUUID(), version: approved.version };
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
    await assert.rejects(() => f.publish(approved), { status: 403 });
    await assert.rejects(() => socialCampaignAction(store, campaign.id, 'publish-organic', valid, other, f.options));
    await assertUnqueued(store, campaign.id);
    assert.equal((await get(store, 'social_campaigns', campaign.id)).state, 'ready');
  }],
  ['la pieza manipulada no se aprueba ni se publica después de congelar la revisión', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const other = await f.create(), otherForecast = await f.forecast(other.id);
    await writeFile(join(f.root, f.assetId, 'derivative.jpg'), 'tampered');
    await assert.rejects(() => f.action(other, 'approve-organic', f.approvalInput(otherForecast)), { status: 409 });
    await assert.rejects(() => f.publish(approved), { status: 409 });
    assert.deepEqual(await rows(store, 'social_revisions', other.id), []);
    await assertUnqueued(store, approved.id);
  }],
  ['una aprobación restaurada sin entregas no se reanuda ni autoriza envío', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id);
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    await patchData(store, 'social_campaigns', campaign.id, { restore_hold: true }, { bump: true });
    const held = { ...approved, version: approved.version + 1 };
    await assert.rejects(() => f.publish(held), { status: 409 });
    await assert.rejects(() => f.action(held, 'resume-restored', { specHash: approved.specHash, rightsAccepted: true, acceptedWarnings: forecast.acceptedWarnings }), /duplic/i);
    const duplicate = await f.action(held, 'duplicate');
    assert.equal(duplicate.state, 'draft'); assert.deepEqual(await rows(store, 'social_revisions', duplicate.id), []);
    await assertUnqueued(store, approved.id);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['una agenda vencida al solicitar no crea entregas ni permite envío tardío', async (store, t) => {
    const f = await setup(store, t), campaign = await f.create({ publishAt: START }), forecast = await f.forecast(campaign.id);
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast)), now = '2026-11-03T12:01:00.000Z';
    await assert.rejects(() => f.publish(approved, { now }), { status: 409, message: /ya pasó.*reprogram/i });
    assert.equal((await processSocialApiTurn(store, { ...f.options, now })).processed, 0);
    assert.equal((await get(store, 'social_campaigns', campaign.id)).state, 'ready');
    await assertUnqueued(store, campaign.id);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['una solicitud con agenda futura encola pero no envía antes de la fecha congelada', async (store, t) => {
    const f = await setup(store, t, { platforms: ['facebook'] }), campaign = await f.create({ publishAt: START }), forecast = await f.forecast(campaign.id);
    const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const receipt = await f.publish(approved, { now: REQUESTED_AT });
    assert.equal(receipt.state, 'scheduled');
    assert.deepEqual(receipt.deliveries, [{ id: receipt.deliveryIds[0], channel: 'facebook', state: 'scheduled' }]);
    const [job] = await socialJobs(store);
    assert.equal(JSON.parse(job.data).nextRunAt, START);
    const remote = createMetaPublishingProvider({ now: Date.parse(START), pageToken: PAGE_TOKEN }), transport = { fetchImpl: remote.fetchImpl };
    assert.equal((await processSocialApiTurn(store, { ...f.options, now: REQUESTED_AT, transport })).processed, 0);
    assert.deepEqual(remote.requests, []);
    assert.equal((await get(store, 'social_deliveries', receipt.deliveryIds[0])).remoteId, null);
    const turn = await processSocialApiTurn(store, { ...f.options, now: START, maxOperations: 1, transport });
    assert.equal(turn.processed, 1); assert.equal(turn.errorCode, null);
    assert.deepEqual(remote.requests.filter(request => request.method === 'POST').map(request => request.path), ['200/photos']);
  }],
  ['publicar revalida cuenta, pieza, campaña, credenciales y actor antes del commit', async (store, t) => {
    for (const target of ['social_connections', 'social_assets', 'social_campaigns', 'social_credentials', 'actor']) {
      const f = await setup(store, t), campaign = await f.create(), forecast = await f.forecast(campaign.id), entered = deferred(), release = deferred();
      const approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
      const [revision] = await rows(store, 'social_revisions', campaign.id);
      f.remote.beforeRead = async path => { if (path === 'debug_token') { entered.resolve(true); await release.promise; } };
      const publication = f.publish(approved);
      try {
        assert.equal(await Promise.race([entered.promise, publication]), true, 'La publicación debe comprobar la cuenta en vivo antes de persistir.');
        if (target === 'actor') await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`, [f.actorId]);
        else if (target === 'social_credentials') await store.db.run(`UPDATE ${store.t(target)} SET version=version+1 WHERE connection_id=?`, [f.connectionId]);
        else await store.db.run(`UPDATE ${store.t(target)} SET version=version+1 WHERE id=?`, [target === 'social_connections' ? f.connectionId : target === 'social_assets' ? f.assetId : campaign.id]);
      } finally { release.resolve(); }
      await assert.rejects(publication, { status: target === 'actor' ? 403 : 409 });
      await assertUnqueued(store, campaign.id);
      assert.deepEqual(await rows(store, 'social_revisions', campaign.id), [revision]);
    }
  }],
  ['navegador sólo encola con la segunda acción; cancelar revoca lease sin perder revisión ni actor', async (store, t) => {
    const f = await setup(store, t, { method: 'browser' }), campaign = await f.create({ publishAt: START }), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    await assertUnqueued(store, approved.id);
    const [revision] = await rows(store, 'social_revisions', campaign.id), requester = await fixtureUser(store);
    const published = await f.publish(approved, { now: REQUESTED_AT, actorId: requester });
    assert.equal(published.state, 'scheduled'); assert.equal(published.deliveryIds.length, 2); assert.equal(published.operationIds.length, 2);
    assert.deepEqual((await socialJobs(store)).map(job => [job.key, job.state, JSON.parse(job.data).nextRunAt]), [...published.deliveryIds].sort().map(id => [`social:browser:delivery:${id}`, 'queued', START]));
    for (const operation of (await rows(store, 'social_operations', campaign.id)).map(entity)) {
      assert.equal(operation.step, 'publish'); assert.equal(operation.state, 'prepared'); assert.equal(operation.nextAttemptAt, START);
      assert.equal(operation.actorId, requester);
      assert.ok(published.operationIds.includes(operation.id)); assert.ok(published.deliveryIds.includes(operation.deliveryId));
      assert.equal(operation.remoteDraftRef, undefined);
    }
    assert.equal((await processSocialBrowserTurn(store, { ...f.options, now: REQUESTED_AT })).processed, 0);
    const lease = await claimJob(store, { key: `social:browser:delivery:${published.deliveryIds[0]}`, now: START }); assert.ok(lease.token);
    await configureSocialTestRuntime(store, { env: f.env, settings: { publishingEnabled: false } });
    const cancelled = await f.action(published, 'cancel', {}, { now: START }); assert.equal(cancelled.state, 'cancelled');
    for (const job of await socialJobs(store)) { assert.equal(job.state, 'failed'); assert.equal(job.lease_token, null); }
    for (const id of published.deliveryIds) {
      const delivery = await get(store, 'social_deliveries', id);
      assert.equal(delivery.state, 'cancelled'); assert.equal(delivery.publishRequestedBy, requester); assert.equal(delivery.createdAt, REQUESTED_AT);
    }
    assert.ok((await rows(store, 'social_operations', campaign.id)).every(operation => operation.state === 'failed'));
    assert.deepEqual((await rows(store, 'social_revisions', campaign.id))[0], revision);
    assert.deepEqual(f.remote.calls, []);
  }],
  ['cancelar preserva la entrega publicada y nunca resuelve un envío incierto', async (store, t) => {
    const f = await setup(store, t, { method: 'browser' }), campaign = await f.create(), forecast = await f.forecast(campaign.id), approved = await f.action(campaign, 'approve-organic', f.approvalInput(forecast));
    const queued = await f.publish(approved);
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='sent' WHERE id=?`, [queued.operationIds[0]]);
    await assert.rejects(() => f.action(queued, 'cancel'), { status: 409 }); assert.equal((await get(store, 'social_campaigns', campaign.id)).state, 'publishing');
    await store.db.run(`UPDATE ${store.t('social_operations')} SET state='confirmed' WHERE id=?`, [queued.operationIds[0]]); await store.db.run(`UPDATE ${store.t('social_deliveries')} SET state='published',remote_id='999' WHERE id=?`, [queued.deliveryIds[0]]);
    const cancelled = await f.action(queued, 'cancel');
    assert.equal(cancelled.state, 'partial');
    const published = await get(store, 'social_deliveries', queued.deliveryIds[0]);
    assert.equal(published.state, 'published'); assert.equal(published.remoteId, '999'); assert.equal(published.publishRequestedBy, f.actorId);
    assert.equal((await get(store, 'social_deliveries', queued.deliveryIds[1])).state, 'cancelled');
    assert.deepEqual(f.remote.calls, []);
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
    assert.deepEqual(await rows(store, 'social_revisions', campaign.id), []);
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
