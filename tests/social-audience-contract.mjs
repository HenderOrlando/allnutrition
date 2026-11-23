import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { actOnSocialAudience, getSocialAudience } from '../lib/business/social-audience.mjs';
import { entity, hash, insertRow, stamp } from '../lib/business/commands.mjs';
import { saveSocialCampaign } from '../lib/business/social.mjs';
import { saveCredentials } from '../lib/social/credentials.mjs';
import { configureSocialTestRuntime } from './social-runtime-fixture.mjs';

const CANARY = 'SYNTHETIC-PRIVATE-KEY-NOT-IN-MODEL-CONTEXT';
const SECRET_CAPTION = 'SYNTHETIC-DRAFT-CAPTION-NOT-IN-MODEL-CONTEXT';
const WHOLE = countries => ({ countries, regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] });
const answer = patch => ({ ageMin: 24, ageMax: 60, interests: [], grounding: ['objective', 'markets'], assumptions: ['no_prior_results'], ...patch });
const toolResult = args => ({ status: 'completed', output: [{ type: 'function_call', name: 'proponer_audiencia', call_id: 'synthetic-call-id', arguments: JSON.stringify(args) }] });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
async function actor(store) {
  const id = randomUUID(), sessionTokenHash = hash(randomUUID()), csrf = randomUUID();
  await insertRow(store, 'users', { id, email: `${id}@example.test`, password: 'fixture', active: 1 });
  await insertRow(store, 'sessions', { user_id: id, token_hash: sessionTokenHash, csrf, expires: Date.now() + 3600000 });
  return { user: { id }, csrf, sessionTokenHash };
}
async function fixture(store, { markets = ['MX'], method = null, enabled = true, audience = null } = {}) {
  const { env, keyring, runtime } = await configureSocialTestRuntime(store, { settings: { publishingEnabled: false } });
  const session = await actor(store), admin = session.user.id, now = stamp();
  const configure = (version, patch = {}) => saveAssistantSettings(store, { version, requestId: randomUUID(), enabled,
    provider: 'openai', model: 'synthetic-text', baseUrl: '', allowPrivateNetwork: false, apiKey: CANARY, ...patch }, session, { env, keyring, verify: async () => ({ ok: true }) });
  const settings = enabled ? await configure(0) : { version: 0 };
  const connectionId = method ? randomUUID() : null;
  const identities = { userId: '102', businessId: '501', pageId: '601', adAccountId: method === 'api' ? 'act_701' : '701' };
  if (method) await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: method, state: 'connected', version: 1, created_at: now, updated_at: now,
    data: JSON.stringify({ identities, currency: 'USD', timeZone: 'America/Mexico_City', capabilities: { adsPublish: true, insights: true }, sessionEpoch: 0 }) });
  if (method === 'api') await saveCredentials(store, connectionId, { accessToken: 'SYNTHETIC-PRIVATE-META-TOKEN', userId: identities.userId }, { runtime });
  const draft = await saveSocialCampaign(store, { requestId: randomUUID(), name: 'Campaña sintética', mode: 'paid', objective: 'reach', caption: SECRET_CAPTION,
    marketCountries: markets, audience: audience || WHOLE(markets), ...(method && { connectionId }) }, admin, { env, now });
  const remote = { assistantCalls: [], metaCalls: [], matches: [{ id: '880', name: 'Fitness', path: ['Deportes'] }], result: answer() };
  const assistantTransport = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.apiKey, CANARY);
    remote.assistantCalls.push(JSON.parse(options.body));
    if (remote.barrier) { remote.barrier.started.resolve(); await remote.barrier.release.promise; }
    if (remote.loseResponse) throw new Error(CANARY);
    return toolResult(remote.result);
  };
  const metaFetch = async (href, request) => {
    assert.equal(request.method, 'GET');
    const url = new URL(href), path = url.pathname.slice('/v26.0/'.length), scopes = ['ads_read'];
    assert.equal(url.hostname, 'graph.facebook.com'); remote.metaCalls.push(path);
    if (path === 'debug_token') return Response.json({ data: { is_valid: true, app_id: runtime.appId, user_id: identities.userId, type: 'USER', scopes,
      expires_at: Math.floor(Date.now() / 1000) + 1000, data_access_expires_at: Math.floor(Date.now() / 1000) + 1000 } });
    if (path === 'me') return Response.json({ id: identities.userId });
    if (path === 'me/permissions') return Response.json({ data: scopes.map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me/adaccounts') return Response.json({ data: [{ id: identities.adAccountId, currency: 'USD', timezone_name: 'America/Mexico_City', user_tasks: ['ANALYZE'] }] });
    if (path === identities.adAccountId) return Response.json({ id: identities.adAccountId, business: { id: identities.businessId } });
    if (path === 'search') { assert.equal(url.searchParams.get('q'), 'Fitness'); return Response.json({ data: remote.matches }); }
    assert.fail('La propuesta no puede consultar alcance ni modificar Meta.');
  };
  const options = { keyring, env, assistantTransport, metaFetch };
  const act = (data, who = session) => actOnSocialAudience(store, draft.id, data, who, options);
  const request = (overrides = {}) => ({ action: 'propose', version: draft.version, requestId: randomUUID(), settingsVersion: settings.version, mode: 'automatic', consent: true, ...overrides });
  const read = () => store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [draft.id]).then(entity);
  return { session, admin, now, env, runtime, connectionId, identities, settings, configure, draft, remote, act, request, read };
}

const cases = [
  ['one or several markets reserve a single text call and only explicit differences save the draft', async store => {
    for (const markets of [['MX'], ['MX', 'PE']]) {
      const f = await fixture(store, { markets, enabled: false });
      const settings = await f.configure((await store.db.get(`SELECT version FROM ${store.t('assistant_settings')} WHERE id=1`))?.version || 0, { enabled: true });
      const consent = await getSocialAudience(store, f.draft.id, f.session);
      assert.equal(consent.provider.available, true); assert.equal(consent.marketConfirmed, true);
      assert.deepEqual(consent.sharedData.markets, markets);
      f.remote.barrier = { started: deferred(), release: deferred() };
      const input = f.request({ settingsVersion: settings.version }), pending = f.act(input);
      await Promise.race([f.remote.barrier.started.promise, pending.then(() => assert.fail('No se esperó respuesta del proveedor'))]);
      try {
        const duplicate = await f.act(input);
        assert.equal(duplicate.status, 'reserved');
        assert.equal((await getSocialAudience(store, f.draft.id, f.session, { requestId: input.requestId })).status, 'reserved');
        await assert.rejects(f.act({ ...input, requestId: randomUUID() }), { status: 409 });
        assert.equal((await f.read()).version, f.draft.version);
      } finally { f.remote.barrier.release.resolve(); }
      const outcome = await pending;
      assert.equal(outcome.status, 'proposed'); assert.deepEqual(await f.act(input), outcome); assert.equal(f.remote.assistantCalls.length, 1);
      assert.deepEqual((await getSocialAudience(store, f.draft.id, f.session)).latestRequest, outcome);
      assert.equal((await f.read()).version, f.draft.version);
      const applied = await f.act({ action: 'apply', version: f.draft.version, requestId: randomUUID(), proposalId: outcome.proposalId,
        selectedChanges: { age: true, interests: [] } });
      assert.equal(applied.status, 'applied');
      const stored = await f.read();
      assert.deepEqual(stored.marketCountries, markets); assert.deepEqual(stored.audience.countries, markets);
      assert.equal(stored.audienceMode, 'automatic'); assert.equal(stored.audience.ageMin, 24); assert.equal(stored.version, f.draft.version + 1);
      const packet = f.remote.assistantCalls[0], data = JSON.parse(packet.input[0].content);
      assert.deepEqual(packet.tools.map(tool => tool.name), ['proponer_audiencia']);
      assert.deepEqual(data.markets, markets); assert.equal(data.currentAudience, null);
      for (const secret of [CANARY, SECRET_CAPTION, f.admin, f.draft.id, f.session.sessionTokenHash]) assert.ok(!JSON.stringify(packet).includes(secret));
    }
    assert.deepEqual(await store.db.all(`SELECT id FROM ${store.t('social_deliveries')}`), []);
  }],
  ['automatic scope and age need separate choices; verified no-ops cannot create a draft version', async store => {
    const f = await fixture(store, { markets: ['MX', 'PE'], audience: { ...WHOLE(['MX']), ageMin: 22, genders: [2] } });
    const proposed = await f.act(f.request());
    assert.equal(proposed.status, 'proposed');
    assert.deepEqual(proposed.proposal.scope, { countries: ['MX', 'PE'] });
    assert.deepEqual(proposed.proposal.age, { before: [22, 65], after: [24, 60] });
    const apply = { action: 'apply', version: f.draft.version, requestId: randomUUID(), proposalId: proposed.proposalId, selectedChanges: { age: true, interests: [] } };
    await assert.rejects(f.act(apply), { status: 400 });
    assert.equal((await f.read()).version, f.draft.version);
    await f.act({ ...apply, selectedChanges: { scope: true, age: false, interests: [] } });
    assert.deepEqual((await f.read()).audience, { ...WHOLE(['MX', 'PE']), ageMin: 22, genders: [2] });
    f.remote.result = answer({ ageMin: 22, ageMax: 65 });
    const unchanged = await f.act(f.request({ version: f.draft.version + 1 }));
    const noChanges = { ...apply, version: f.draft.version + 1, requestId: randomUUID(), proposalId: unchanged.proposalId };
    await assert.rejects(f.act(noChanges), /edad guardada/);
    await assert.rejects(f.act({ ...noChanges, selectedChanges: { age: false, interests: [] } }), /al menos una diferencia/);
    assert.equal((await f.read()).version, f.draft.version + 1);
  }],
  ['missing markets block consent, and explicit broad uses the exact markets without an AI configuration', async store => {
    const empty = await fixture(store, { markets: [], enabled: false });
    assert.equal((await getSocialAudience(store, empty.draft.id, empty.session)).marketConfirmed, false);
    await assert.rejects(empty.act(empty.request({ settingsVersion: 1 })), { status: 409 });
    await assert.rejects(empty.act({ action: 'broad', version: empty.draft.version, requestId: randomUUID() }), { status: 409 });
    assert.equal(empty.remote.assistantCalls.length, 0);
    const broad = await fixture(store, { markets: ['MX', 'PE'], enabled: false });
    const input = { action: 'broad', version: broad.draft.version, requestId: randomUUID() };
    const result = await broad.act(input);
    assert.deepEqual(await broad.act(input), result);
    assert.deepEqual((await broad.read()).audience, WHOLE(['MX', 'PE']));
    assert.equal((await broad.read()).audienceMode, 'broad');
    assert.equal(broad.remote.assistantCalls.length, 0);
  }],
  ['manual applies selected differences only and preserves verified city and radius', async store => {
    const city = { key: 'api:location:871', source: 'api', providerId: '871', label: 'Guadalajara', context: { type: 'city', countryCode: 'MX', region: 'Jalisco', regionId: '872', radius: 20, distanceUnit: 'kilometer' } };
    const f = await fixture(store, { method: 'api', audience: { ...WHOLE([]), cities: [city], ageMin: 20 } });
    const before = await f.read();
    f.remote.result = answer({ interests: ['Fitness'], grounding: ['currentAudience', 'markets'] });
    const input = f.request({ mode: 'manual' }), proposed = await f.act(input), other = await actor(store);
    const shared = JSON.parse(f.remote.assistantCalls[0].input[0].content);
    assert.deepEqual(shared.currentAudience.cities, [{ country: 'MX', label: 'Guadalajara', radius: 20, distanceUnit: 'kilometer' }]);
    assert.ok(!JSON.stringify(shared).includes(f.connectionId)); assert.ok(!JSON.stringify(shared).includes(city.key));
    assert.equal(proposed.status, 'proposed'); assert.equal((await f.read()).version, before.version);
    assert.equal(proposed.proposal.interests[0].status, 'verified');
    assert.equal(f.remote.metaCalls.filter(path => path === 'search').length, 1);
    const apply = { action: 'apply', version: before.version, requestId: randomUUID(), proposalId: proposed.proposalId, selectedChanges: { age: false, interests: [{ index: 0, key: 'api:interest:880' }] } };
    await assert.rejects(f.act(apply, other), { status: 409 });
    await assert.rejects(getSocialAudience(store, f.draft.id, other, { requestId: input.requestId }), { status: 404 });
    await assert.rejects(f.act({ ...apply, selectedChanges: { age: false, interests: [{ index: 0, key: 'api:interest:999' }] } }), { status: 400 });
    const saved = await f.act(apply); assert.deepEqual(await f.act(apply), saved);
    const after = await f.read();
    assert.deepEqual(after.audience.countries, []); assert.deepEqual(after.audience.cities, before.audience.cities);
    assert.equal(after.audience.ageMin, 20); assert.equal(after.audience.ageMax, 65); assert.equal(after.audience.interests[0].providerId, '880');
    assert.equal(after.audienceMode, 'manual'); assert.equal(f.remote.assistantCalls.length, 1);
    await assert.rejects(f.act({ ...apply, requestId: randomUUID() }), { status: 409 });
  }],
  ['ambiguous names cannot be silently substituted in automatic mode; an explicit verified choice succeeds', async store => {
    const f = await fixture(store, { method: 'api', markets: ['MX', 'PE'] });
    f.remote.result = answer({ interests: ['Fitness'] });
    f.remote.matches.push({ id: '881', name: 'Fitness', path: ['Otra taxonomía'] }, { id: '882', name: 'Fitness y salud', path: [] });
    const result = await f.act(f.request());
    assert.equal(result.status, 'needs_selection'); assert.equal((await f.read()).version, f.draft.version);
    assert.deepEqual(result.proposal.interests[0].candidates.map(item => item.providerId), ['880', '881']);
    const input = { action: 'apply', version: f.draft.version, requestId: randomUUID(), proposalId: result.proposalId, selectedChanges: { age: false, interests: [] } };
    await assert.rejects(f.act(input), { status: 400 });
    const saved = await f.act({ ...input, selectedChanges: { age: false, interests: [{ index: 0, key: 'api:interest:881' }] } });
    assert.equal(saved.status, 'applied'); assert.equal((await f.read()).audience.interests[0].providerId, '881');
    assert.equal((await f.read()).audience.ageMin, 18);
  }],
  ['browser accepts only candidates from the confirmed authorized native draft', async store => {
    const f = await fixture(store, { method: 'browser' });
    f.remote.result = answer({ interests: ['Fitness'] });
    assert.equal((await f.act(f.request())).status, 'needs_selection');
    const operationId = randomUUID(), remoteDraftRef = '6351', specHash = hash('synthetic native draft'), configurationFingerprint = f.runtime.fingerprint;
    const context = { type: 'interest', countryCode: null, region: null, scope: 'Taxonomía Deportes' }, label = 'Fitness';
    const key = hash({ label, context, businessId: f.identities.businessId });
    await insertRow(store, 'social_operations', { id: operationId, campaign_id: f.draft.id, delivery_id: null,
      operation_key: `preflight:${f.draft.id}:${operationId}`, step: 'targeting', state: 'confirmed', next_attempt_at: null, version: 1, created_at: f.now, updated_at: f.now,
      data: JSON.stringify({ remoteDraftRef, specHash, configurationFingerprint, query: { kind: 'interest', q: label } }) });
    const draft = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [f.draft.id]);
    const proof = { kind: 'targeting', configurationFingerprint, specHash, operationId, remoteDraftRef, privateDraftAuthorization: { acceptedAt: f.now, actorId: f.admin },
      candidates: [{ source: 'browser', providerId: null, label, key, context }] };
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=?,version=version+1 WHERE id=?`, [JSON.stringify({ ...JSON.parse(draft.data), preflight: proof }), f.draft.id]);
    const result = await f.act(f.request({ version: f.draft.version + 1 }));
    assert.equal(result.status, 'proposed'); assert.equal((await f.read()).audience.interests.length, 0);
    await f.act({ action: 'apply', version: result.version, requestId: randomUUID(), proposalId: result.proposalId,
      selectedChanges: { age: false, interests: [{ index: 0, key }] } });
    assert.equal((await f.read()).audience.interests[0].key, key);
    assert.equal(f.remote.metaCalls.length, 0);
  }],
  ['invalid market/age/medical proposals, unknown acknowledgement and unavailability never change the draft', async store => {
    const f = await fixture(store);
    for (const invalid of [answer({ ageMin: 17 }), answer({ interests: ['Diabetes'] }), answer({ country: 'US' }), answer({ grounding: ['offer'] }), answer({ estimatedSales: 999 })]) {
      f.remote.result = invalid;
      const result = await f.act(f.request()); assert.equal(result.status, 'failed'); assert.match(result.notice, /no era válida/);
      assert.equal((await f.read()).version, f.draft.version);
    }
    f.remote.loseResponse = true;
    const uncertain = f.request(), result = await f.act(uncertain);
    assert.equal(result.status, 'uncertain'); assert.ok(!JSON.stringify(result).includes(CANARY));
    assert.deepEqual(await f.act(uncertain), result);
    await assert.rejects(f.act(f.request()), { status: 409 });
    assert.equal(f.remote.assistantCalls.length, 6);
    await f.act({ action: 'broad', version: f.draft.version, requestId: randomUUID() });
    const settings = await f.configure(f.settings.version, { enabled: false });
    await assert.rejects(f.act(f.request({ version: f.draft.version + 1, settingsVersion: settings.version })), { status: 422 });
    assert.equal(f.remote.assistantCalls.length, 6);
  }],
  ['late text response cannot overwrite edits, settings replacement or a revoked session', async store => {
    for (const changed of ['draft', 'provider', 'session']) {
      const f = await fixture(store, { enabled: false });
      const settings = await f.configure((await store.db.get(`SELECT version FROM ${store.t('assistant_settings')} WHERE id=1`))?.version || 0, { enabled: true });
      f.remote.barrier = { started: deferred(), release: deferred() };
      const result = f.act(f.request({ settingsVersion: settings.version }));
      await Promise.race([f.remote.barrier.started.promise, result.then(() => assert.fail('No se esperó respuesta del proveedor'))]);
      try {
        if (changed === 'draft') await saveSocialCampaign(store, { id: f.draft.id, version: f.draft.version, requestId: randomUUID(), caption: 'El operador editó este borrador' }, f.admin, { env: f.env });
        if (changed === 'provider') await f.configure(settings.version, { model: 'new-model', enabled: true });
        if (changed === 'session') await store.db.run(`DELETE FROM ${store.t('sessions')} WHERE token_hash=?`, [f.session.sessionTokenHash]);
      } finally { f.remote.barrier.release.resolve(); }
      assert.equal((await result).status, 'stale');
      assert.equal((await f.read()).audience.ageMin, 18);
      assert.equal(f.remote.assistantCalls.length, 1);
    }
  }]
];

export async function runSocialAudienceContracts(t, factory) {
  for (const [name, scenario] of cases) await t.test(name, async () => {
    const store = await factory();
    try { await scenario(store); } finally { await store.close(); }
  });
}
