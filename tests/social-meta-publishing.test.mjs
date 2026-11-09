import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../lib/business/commands.mjs';
import { createMetaApiConnector, createMetaClient } from '../lib/social/meta.mjs';
import { initialMetaPublishingStep, initialMetaControlStep } from '../lib/social/meta-publishing.mjs';
import { createMetaPublishingProvider } from './social-meta-provider.mjs';

const NOW = Date.parse('2026-11-02T13:00:00Z');
const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300', adAccountId: 'act_400' };
async function fixture(t, { mode = 'paid', channel = 'meta_ads', kind = 'image', objective = 'traffic', currency = 'COP', provider = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'meta-publishing-'));
  const bytes = kind === 'image' ? Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1,255,217]) : Buffer.alloc(150000, 0x5a);
  const path = join(root, kind === 'image' ? 'derivative.jpg' : 'derivative.mp4');
  await writeFile(path, bytes);
  const handle = await open(path, 'r');
  t.after(async () => { await handle.close(); await rm(root, { recursive: true, force: true }); });
  const media = { handle, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: kind === 'image' ? 'image/jpeg' : 'video/mp4', kind, assetId: randomUUID(), key: 'unused-pinned-descriptor' };
  provider ||= createMetaPublishingProvider({ now: NOW }); provider.state.currency = currency;
  const runtime = { appId: '42', appSecret: 'synthetic-secret', publicBaseUrl: 'https://nutrition.example.test', keys: { media: Buffer.alloc(32, 7) } };
  const connection = { id: randomUUID(), integrationMethod: 'api', identities, state: 'connected' };
  const connector = createMetaApiConnector({ connection, credentials: { accessToken: 'synthetic-user', userId: '100', pageTokens: { 200: 'stale-do-not-use' } }, runtime, transport: { fetchImpl: provider.fetchImpl, now: NOW } });
  const platforms = mode === 'paid' ? ['facebook', 'instagram'] : [channel];
  const positions = platforms.map(platform => `${platform}_${kind === 'video' ? 'reels' : 'feed'}`);
  const targeting = { geo_locations: { countries: ['CO'], location_types: ['home', 'recent'] }, age_min: 18, age_max: 65, publisher_platforms: platforms, facebook_positions: [kind === 'video' ? 'facebook_reels' : 'feed'], instagram_positions: [kind === 'video' ? 'reels' : 'stream'], targeting_automation: { advantage_audience: 0 } };
  const spec = { name: 'Synthetic campaign', integrationMethod: 'api', connectionId: connection.id, assetId: media.assetId, assetHash: media.sha256, identities, mode, objective, platforms, caption: 'Pieza suministrada por el usuario', headline: 'Consultar producto', destinationUrl: 'https://nutrition.example.test/products', whatsappNumber: '+573001234567', whatsappGreeting: 'Hola, gracias por consultar este producto.', audience: { countries: ['CO'], regions: [], cities: [], interests: [], ageMin: 18, ageMax: 65, genders: [] }, placements: positions, budgetMinor: currency === 'COP' ? 5000000 : 5000, currency, publishAt: null, startAt: new Date(NOW + 300000).toISOString(), endAt: new Date(NOW + 86400000).toISOString(), observationDays: 7, targetCostMinor: null, aiDisclosure: false, timeZone: 'America/Bogota', targeting };
  const operation = { id: randomUUID(), deliveryId: randomUUID(), channel, state: 'prepared', specHash: hash(spec), remoteRefs: {}, progress: {}, step: initialMetaPublishingStep({ spec, kind, channel }) };
  const receipts = [];
  const beforeSend = async receipt => { assert.match(receipt.payloadHash, /^[a-f\d]{64}$/); receipts.push(receipt); };
  async function turn() {
    const before = provider.requests.filter(request => request.method === 'POST').length;
    const fences = receipts.length;
    const result = await connector.executeStep({ operation, spec, media, beforeSend });
    const posts = provider.requests.filter(request => request.method === 'POST').length - before;
    assert.ok(posts <= 1, 'one effect per durable turn'); assert.equal(receipts.length - fences, posts, 'each POST is fenced');
    operation.remoteRefs = { ...operation.remoteRefs, ...(result.remoteRefs || {}) };
    operation.progress = { ...(result.progress || {}) };
    if (result.nextStep) operation.step = result.nextStep;
    return result;
  }
  async function prepare() {
    for (let turnCount = 0; turnCount < 20; turnCount++) { const result = await turn(); if (result.state === 'ready' || result.state === 'published') return result; }
    assert.fail('protocol did not finish within its finite stage count');
  }
  async function control(action) {
    const requestId = randomUUID(); operation.step = initialMetaControlStep(action, requestId); operation.controlId = requestId; operation.progress = {}; operation.investmentAccepted = true;
    operation.preparedRefs = Object.fromEntries(['campaignId', 'adSetId', 'creativeId', 'adId', 'imageHash', 'videoId'].filter(key => operation.remoteRefs[key]).map(key => [key, operation.remoteRefs[key]]));
    const inspected = await connector.inspectDelivery({ delivery: { ...operation, id: operation.deliveryId, everActivated: true }, spec });
    operation.budgetConfirmation = { remainingMinor: inspected.evidence.budget?.remainingMinor, originalBudgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt };
    for (let turnCount = 0; turnCount < 6; turnCount++) { const result = await turn(); if (result.operationComplete !== false) return result; }
    assert.fail('control did not finish');
  }
  return { provider, connector, runtime, media, spec, operation, receipts, beforeSend, turn, prepare, control };
}

test('paid image COP: one paused campaign/set/ad, exact lifetime units; two independent pause/resume cycles', async t => {
  const f = await fixture(t);
  const ready = await f.prepare(); assert.equal(ready.state, 'ready'); assert.equal(ready.evidence.remoteRead, true);
  const resources = [...f.provider.objects.values()];
  assert.equal(resources.filter(object => object.type === 'campaign').length, 1);
  assert.equal(resources.filter(object => object.type === 'adset').length, 1);
  assert.equal(resources.filter(object => object.type === 'ad').length, 1);
  assert.equal(resources.find(object => object.type === 'adset').lifetime_budget, 50000);
  assert.equal(f.provider.state.activationCount, 0);
  assert.ok(resources.filter(object => ['campaign', 'adset', 'ad'].includes(object.type)).every(object => object.status === 'PAUSED'));
  const activated = await f.control('activate'); assert.equal(activated.state, 'scheduled'); assert.equal(activated.evidence.everActivated, true);
  const activeWrites = f.provider.requests.filter(request => request.method === 'POST' && request.body.status === 'ACTIVE');
  assert.deepEqual(activeWrites.map(request => request.path), [f.operation.remoteRefs.adId, f.operation.remoteRefs.adSetId, f.operation.remoteRefs.campaignId]);
  for (let index = 0; index < 2; index++) { assert.equal((await f.control('pause')).state, 'paused'); assert.equal((await f.control('resume')).state, 'scheduled'); }
  assert.equal(f.provider.state.activationCount, 3);
  assert.equal(f.provider.objects.get(f.operation.remoteRefs.adSetId).lifetime_budget, 50000);
});

test('limited spend never authorizes an unapproved placement and remote exceptions block activation', async t => {
  const f = await fixture(t); const ready = await f.prepare();
  const set = f.provider.objects.get(ready.remoteRefs.adSetId);
  assert.equal(Object.values(set.placement_soft_opt_out).some(positions => positions.length > 0), false, 'no excluded placement may spend even 5%');
  set.placement_soft_opt_out = { facebook_positions: ['marketplace'] };
  await assert.rejects(() => f.control('activate'), error => error.errorCode === 'SPEC_MISMATCH');
  assert.equal(f.provider.state.activationCount, 0);
  assert.equal(f.provider.requests.some(request => request.method === 'POST' && request.body.status === 'ACTIVE'), false);
});

test('two campaigns can reuse the same owned image hash without invalidating or activating each other', async t => {
  const first = await fixture(t); const firstReady = await first.prepare();
  const second = await fixture(t, { provider: first.provider }); const secondReady = await second.prepare();
  assert.equal(firstReady.remoteRefs.imageHash, secondReady.remoteRefs.imageHash);
  assert.notEqual(firstReady.remoteRefs.campaignId, secondReady.remoteRefs.campaignId);
  const activated = await first.control('activate');
  assert.equal(activated.state, 'scheduled');
  assert.equal(first.provider.objects.get(firstReady.remoteRefs.campaignId).status, 'ACTIVE');
  assert.equal(first.provider.objects.get(secondReady.remoteRefs.campaignId).status, 'PAUSED');
});

test('paid video USD uses resumable advideos, uploads byte-for-byte then prepares without spending', async t => {
  const f = await fixture(t, { kind: 'video', currency: 'USD' });
  const ready = await f.prepare(); assert.equal(ready.state, 'ready');
  const upload = f.provider.uploads.get(ready.remoteRefs.videoId);
  assert.equal(upload.offset, f.media.size); assert.equal(upload.sha256, f.media.sha256);
  assert.equal(f.provider.objects.get(ready.remoteRefs.adSetId).lifetime_budget, 5000);
  assert.equal(f.provider.state.activationCount, 0);
  const creative = f.provider.objects.get(ready.remoteRefs.creativeId);
  assert.equal(creative.object_story_spec.video_data.video_id, ready.remoteRefs.videoId);
});

for (const objective of ['whatsapp', 'reach', 'engagement']) test(`paid ${objective} keeps the approved objective and real creative`, async t => {
  const f = await fixture(t, { objective }); const result = await f.prepare();
  const set = f.provider.objects.get(result.remoteRefs.adSetId), creative = f.provider.objects.get(result.remoteRefs.creativeId);
  assert.equal(set.optimization_goal, { whatsapp: 'CONVERSATIONS', reach: 'REACH', engagement: 'POST_ENGAGEMENT' }[objective]);
  assert.equal(creative.object_story_spec.link_data.image_hash, result.remoteRefs.imageHash);
  if (objective === 'whatsapp') { assert.equal(set.destination_type, 'WHATSAPP'); const data = creative.object_story_spec.link_data; assert.equal(data.call_to_action.type, 'WHATSAPP_MESSAGE'); assert.equal(JSON.parse(data.page_welcome_message).text_format.message.text, f.spec.whatsappGreeting); }
  assert.equal(f.provider.state.activationCount, 0);
});

for (const channel of ['facebook', 'instagram']) for (const kind of ['image', 'video']) test(`organic ${channel} ${kind} confirms owned published object, not upload success`, async t => {
  const f = await fixture(t, { mode: 'organic', channel, kind });
  const result = await f.prepare(); assert.equal(result.state, 'published'); assert.equal(result.evidence.remoteRead, true);
  const object = f.provider.objects.get(result.remoteRefs.remoteId);
  assert.ok(object && (object.is_published || object.published || object.type === 'media'));
  assert.ok(result.remoteRefs.permalink.startsWith(`https://www.${channel}.com/`));
  const before = f.provider.requests.filter(request => request.method === 'POST').length;
  assert.equal((await f.connector.inspectDelivery({ delivery: { ...f.operation, id: f.operation.deliveryId }, spec: f.spec })).state, 'published');
  assert.equal(f.provider.requests.filter(request => request.method === 'POST').length, before);
});

test('lost campaign response reconciles by unique delivery UUID and never creates a second campaign', async t => {
  const f = await fixture(t); await f.turn(); assert.equal(f.operation.step, 'create_campaign');
  f.provider.state.loseResponse = { path: 'act_400/campaigns', times: 1 };
  await assert.rejects(f.turn, error => error.uncertain === true);
  const result = await f.connector.inspectDelivery({ delivery: f.operation, operation: { ...f.operation, state: 'uncertain' }, spec: f.spec });
  assert.equal(result.status, 'confirmed'); assert.equal(result.nextStep, 'create_adset');
  assert.equal([...f.provider.objects.values()].filter(object => object.type === 'campaign').length, 1);
  assert.equal(f.provider.requests.filter(request => request.method === 'POST' && request.path === 'act_400/campaigns').length, 1);
});

test('lost FB publication response recovers by known attachment identity; IG stays uncertain until operator verifies owned ID', async t => {
  const fb = await fixture(t, { mode: 'organic', channel: 'facebook' }); await fb.turn();
  fb.provider.state.loseResponse = { path: '200/feed', times: 1 };
  await assert.rejects(fb.turn, error => error.uncertain);
  const recovered = await fb.connector.inspectDelivery({ delivery: fb.operation, operation: { ...fb.operation, state: 'uncertain' }, spec: fb.spec });
  assert.equal(recovered.state, 'published'); assert.equal([...fb.provider.objects.values()].filter(object => object.type === 'post').length, 1);
  const ig = await fixture(t, { mode: 'organic', channel: 'instagram' }); await ig.turn(); await ig.turn();
  ig.provider.state.loseResponse = { path: '300/media_publish', times: 1 };
  await assert.rejects(ig.turn, error => error.uncertain);
  const ambiguous = await ig.connector.inspectDelivery({ delivery: ig.operation, operation: { ...ig.operation, state: 'uncertain' }, spec: ig.spec });
  assert.equal(ambiguous.status, 'uncertain');
  const media = [...ig.provider.objects.values()].find(object => object.type === 'media');
  await assert.rejects(ig.connector.verifyRemoteLink({ delivery: { ...ig.operation, id: ig.operation.deliveryId }, spec: ig.spec, permalink: media.permalink }), error => error.errorCode === 'SPEC_MISMATCH');
  const linked = await ig.connector.verifyRemoteLink({ delivery: { ...ig.operation, id: ig.operation.deliveryId }, spec: ig.spec, permalink: media.permalink, acceptContentVerification: true });
  assert.equal(linked.state, 'published'); assert.equal(linked.evidence.source, 'operator_verified');
  assert.equal([...ig.provider.objects.values()].filter(object => object.type === 'media').length, 1);
});

test('interrupted video resumes the same upload from the remotely confirmed offset', async t => {
  const f = await fixture(t, { mode: 'organic', channel: 'facebook', kind: 'video' }); await f.turn(); const originalId = f.operation.remoteRefs.videoId;
  f.provider.state.partialUploadBytes = 50002;
  await assert.rejects(f.turn, error => error.uncertain);
  const receipt = await f.connector.inspectDelivery({ delivery: f.operation, operation: { ...f.operation, state: 'uncertain' }, spec: f.spec });
  assert.equal(receipt.operationComplete, false); assert.equal(receipt.progress.offset, 50002);
  f.operation.progress = receipt.progress;
  await f.turn();
  assert.equal(f.provider.uploads.size, 1); assert.equal(f.operation.remoteRefs.videoId, originalId);
  assert.equal(f.provider.uploads.get(originalId).sha256, f.media.sha256);
  assert.deepEqual(f.provider.requests.filter(request => request.path.startsWith('video-upload/')).map(request => request.offset), [0, 50002]);
});

test('lost activation checkpoint reconciles only that child and the campaign stays paused until last', async t => {
  const f = await fixture(t); await f.prepare();
  const requestId = randomUUID(); Object.assign(f.operation, { step: initialMetaControlStep('activate', requestId), controlId: requestId, investmentAccepted: true, preparedRefs: Object.fromEntries(['campaignId', 'adSetId', 'creativeId', 'adId', 'imageHash'].map(key => [key, f.operation.remoteRefs[key]])) });
  f.provider.state.loseResponse = { path: f.operation.remoteRefs.adId, times: 1 };
  await assert.rejects(f.turn, error => error.uncertain);
  const recovered = await f.connector.inspectDelivery({ delivery: f.operation, operation: { ...f.operation, state: 'uncertain' }, spec: f.spec });
  assert.equal(recovered.operationComplete, false); assert.equal(recovered.progress.controlStage, 'adset');
  assert.equal(f.provider.objects.get(f.operation.remoteRefs.campaignId).status, 'PAUSED');
  assert.equal(f.provider.requests.filter(request => request.method === 'POST' && request.path === f.operation.remoteRefs.adId).length, 1);
});

test('external budget/targeting changes block activation, but a safe pause needs neither media nor original budget', async t => {
  const f = await fixture(t); await f.prepare();
  f.provider.objects.get(f.operation.remoteRefs.adSetId).lifetime_budget += 1;
  const before = f.provider.requests.filter(request => request.method === 'POST').length;
  await assert.rejects(f.control('activate'), error => error.errorCode === 'SPEC_MISMATCH');
  assert.equal(f.provider.requests.filter(request => request.method === 'POST').length, before);
  const requestId = randomUUID();
  const result = await f.connector.executeStep({ operation: { ...f.operation, step: initialMetaControlStep('pause', requestId), controlId: requestId }, spec: { identities }, media: null, beforeSend: f.beforeSend });
  assert.equal(result.state, 'paused'); assert.equal(f.provider.state.activationCount, 0);
});

test('unknown remaining budget cannot be accepted as the original total; review rejection is not delivering', async t => {
  const f = await fixture(t); await f.prepare();
  f.provider.objects.get(f.operation.remoteRefs.adSetId).budget_remaining = null;
  const requestId = randomUUID();
  const operation = { ...f.operation, step: initialMetaControlStep('resume', requestId), controlId: requestId, investmentAccepted: true, preparedRefs: Object.fromEntries(['campaignId', 'adSetId', 'creativeId', 'adId', 'imageHash'].map(key => [key, f.operation.remoteRefs[key]])), budgetConfirmation: { remainingMinor: f.spec.budgetMinor, originalBudgetMinor: f.spec.budgetMinor, currency: 'COP', startAt: f.spec.startAt, endAt: f.spec.endAt } };
  await assert.rejects(f.connector.executeStep({ operation, spec: f.spec, beforeSend: f.beforeSend }), error => error.errorCode === 'SPEC_MISMATCH');
  f.provider.state.rejectAds = true;
  const result = await f.connector.inspectDelivery({ delivery: { ...f.operation, id: f.operation.deliveryId }, spec: f.spec });
  assert.equal(result.state, 'failed'); assert.equal(result.evidence.remoteState, 'DISAPPROVED'); assert.ok(!result.evidence.reason.includes('<'));
});

test('a failed beforeSend fence sends nothing; rate limits and unsafe upload destinations stay sanitized', async t => {
  const f = await fixture(t);
  await assert.rejects(f.connector.executeStep({ operation: f.operation, spec: f.spec, media: f.media, beforeSend: async () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.equal(f.provider.requests.filter(request => request.method === 'POST').length, 0);
  f.provider.state.rateLimit = { path: 'me/accounts', times: 1, retryAfter: 120 };
  await assert.rejects(f.turn, error => error.kind === 'rate_limit' && error.retryAfter === 120 && !error.uncertain);
  const client = createMetaClient({ accessToken: 'canary-secret', appSecret: 'canary-app-secret', fetchImpl: async () => { assert.fail('unsafe URL reached transport'); } });
  await assert.rejects(client.get('https://127.0.0.1/private'), error => error.kind === 'unsafe_url');
  assert.ok(!JSON.stringify(f.provider.requests).includes('synthetic-user'));
  assert.ok(!JSON.stringify(f.receipts).includes('signature='));
});

test('effective placement expansion and external identity changes cannot activate the approved configuration', async t => {
  const f = await fixture(t); await f.prepare();
  f.provider.state.effectivePlacements = { publisher_platforms: ['facebook', 'instagram', 'audience_network'] };
  await assert.rejects(f.control('activate'), error => error.errorCode === 'SPEC_MISMATCH');
  assert.equal(f.provider.state.activationCount, 0);
  f.provider.state.effectivePlacements = null;
  f.provider.objects.get(f.operation.remoteRefs.creativeId).object_story_spec.page_id = '999';
  await assert.rejects(f.control('activate'), error => error.errorCode === 'SPEC_MISMATCH');
  assert.equal(f.provider.state.activationCount, 0);
});

test('manual verification follows all owned pages and refuses a foreign object; ambiguous UUID creation stays uncertain', async t => {
  const f = await fixture(t, { mode: 'organic', channel: 'instagram' });
  f.provider.state.pageSize = 1;
  f.provider.objects.set('9001', { id: '9001', type: 'media', owner: '300', caption: 'Otro contenido', media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/9001/' });
  const result = await f.prepare();
  const linked = await f.connector.verifyRemoteLink({ delivery: { ...f.operation, id: f.operation.deliveryId }, spec: f.spec, permalink: result.remoteRefs.permalink, acceptContentVerification: true });
  assert.equal(linked.remoteRefs.mediaId, result.remoteRefs.mediaId);
  f.provider.objects.set('9002', { id: '9002', type: 'media', owner: '999', caption: f.spec.caption, media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/9002/' });
  await assert.rejects(f.connector.verifyRemoteLink({ delivery: { ...f.operation, id: f.operation.deliveryId }, spec: f.spec, remoteId: '9002', acceptContentVerification: true }), error => error.errorCode === 'SPEC_MISMATCH');
  const paid = await fixture(t); await paid.turn();
  paid.provider.state.loseResponse = { path: 'act_400/campaigns', times: 1 };
  await assert.rejects(paid.turn, error => error.uncertain);
  const campaign = [...paid.provider.objects.values()].find(object => object.type === 'campaign');
  paid.provider.objects.set('9003', { ...structuredClone(campaign), id: '9003' });
  const ambiguous = await paid.connector.inspectDelivery({ delivery: paid.operation, operation: { ...paid.operation, state: 'uncertain' }, spec: paid.spec });
  assert.equal(ambiguous.status, 'uncertain');
  assert.equal(paid.provider.requests.filter(request => request.method === 'POST' && request.path === 'act_400/campaigns').length, 1);
});

test('unsupported AI disclosure is blocked locally; documented IG disclosure creates a container without persisting its signed URL', async t => {
  const paid = await fixture(t); paid.spec.aiDisclosure = true; paid.operation.specHash = hash(paid.spec);
  await assert.rejects(paid.turn, error => error.errorCode === 'PERMISSION_REQUIRED');
  assert.equal(paid.provider.requests.filter(request => request.method === 'POST').length, 0);
  const fb = await fixture(t, { mode: 'organic', channel: 'facebook' }); fb.spec.aiDisclosure = true; fb.operation.specHash = hash(fb.spec);
  await assert.rejects(fb.turn, error => error.errorCode === 'PERMISSION_REQUIRED');
  const ig = await fixture(t, { mode: 'organic', channel: 'instagram' }); ig.spec.aiDisclosure = true; ig.operation.specHash = hash(ig.spec);
  await ig.prepare();
  assert.equal(ig.provider.requests.find(request => request.path === '300/media').body.is_ai_generated, true);
  assert.equal(JSON.stringify(ig.receipts).includes('signature='), false);
  assert.equal(JSON.stringify([...ig.provider.objects.values()]).includes('signature='), false);
});

test('external abort propagates and a possibly sent POST remains uncertain without exposing provider data', async () => {
  const controller = new AbortController();
  const client = createMetaClient({ accessToken: 'abort-token-canary', appSecret: 'abort-secret-canary', fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      controller.abort();
    });
  } });
  await assert.rejects(client.post('200/feed', { message: 'Already approved' }, { signal: controller.signal }), error => error.kind === 'aborted' && error.uncertain && !error.message.includes('canary'));
});

test('pausing uses only current user/ad-account access even after Page permissions and creation availability disappear', async t => {
  const f = await fixture(t); await f.prepare();
  f.provider.state.hidePages = true; f.provider.state.permissions = ['ads_management']; f.provider.state.accountStatus = 2;
  const start = f.provider.requests.length;
  const status = await f.connector.validateConnection({ purpose: 'pause' });
  assert.equal(status.identities.userId, '100'); assert.equal(status.identities.adAccountId, 'act_400'); assert.equal(status.identities.pageId, undefined);
  const requestId = 'pause:no-pages-available';
  const paused = await f.connector.executeStep({ operation: { ...f.operation, step: initialMetaControlStep('pause', requestId), controlId: requestId }, spec: { identities: { userId: '100', adAccountId: 'act_400' } }, beforeSend: f.beforeSend });
  assert.equal(paused.state, 'paused'); assert.equal(paused.evidence.remoteRead, true);
  assert.equal(f.provider.requests.slice(start).some(request => ['me/accounts', 'me/adaccounts'].includes(request.path)), false);
});

test('organic operations use freshly discovered Page tokens and never persist them in receipts', async t => {
  const f = await fixture(t, { mode: 'organic', channel: 'facebook' });
  f.provider.state.pageToken = 'synthetic-rotated-page-canary';
  const result = await f.prepare(); assert.equal(result.state, 'published');
  assert.equal(JSON.stringify({ result, receipts: f.receipts, requests: f.provider.requests }).includes(f.provider.state.pageToken), false);
});

test('paid advideos resumes only a durably confirmed chunk cursor; a lost chunk receipt is uncertain', async t => {
  const f = await fixture(t, { kind: 'video' }); f.provider.state.chunkSize = 50002;
  await f.turn();
  const original = { ...f.operation.remoteRefs };
  assert.deepEqual(f.operation.progress, { offset: 0, endOffset: 50002 });
  const first = await f.turn();
  assert.equal(first.operationComplete, false); assert.deepEqual(first.progress, { offset: 50002, endOffset: 100004 });
  const restoredOperation = structuredClone(f.operation);
  const restarted = createMetaApiConnector({ connection: { id: f.spec.connectionId, identities }, credentials: { accessToken: 'synthetic-user', userId: '100' }, runtime: f.runtime, transport: { now: NOW, fetchImpl: f.provider.fetchImpl } });
  const resumed = await restarted.executeStep({ operation: restoredOperation, spec: f.spec, media: f.media, beforeSend: f.beforeSend });
  assert.equal(resumed.progress.offset, 100004); assert.equal(resumed.remoteRefs.uploadSessionId, original.uploadSessionId);
  f.operation.progress = resumed.progress;
  const ready = await f.prepare(); assert.equal(ready.state, 'ready');
  assert.equal(f.provider.uploads.size, 1); assert.equal(f.provider.uploads.get(original.videoId).sha256, f.media.sha256);
  const transfers = f.provider.requests.filter(request => request.path === 'act_400/advideos' && request.body.upload_phase === 'transfer');
  assert.deepEqual(transfers.map(request => Number(request.body.start_offset)), [0, 50002, 100004]);
  const lost = await fixture(t, { kind: 'video' }); lost.provider.state.chunkSize = 50002;
  await lost.turn(); lost.provider.state.loseResponse = { path: 'act_400/advideos', times: 1 };
  await assert.rejects(lost.turn, error => error.uncertain);
  const result = await lost.connector.inspectDelivery({ delivery: lost.operation, operation: { ...lost.operation, state: 'uncertain' }, spec: lost.spec });
  assert.equal(result.status, 'uncertain');
  assert.equal(lost.provider.requests.filter(request => request.path === 'act_400/advideos' && request.body.upload_phase === 'transfer').length, 1);
  assert.equal(lost.provider.uploads.get(lost.operation.remoteRefs.videoId).offset, 50002);
});

test('manual partial campaign linking is read-only and its durable resolution continues the original creation step', async t => {
  const f = await fixture(t); await f.turn();
  f.provider.state.loseResponse = { path: 'act_400/campaigns', times: 1 };
  await assert.rejects(f.turn, error => error.uncertain);
  const campaign = [...f.provider.objects.values()].find(object => object.type === 'campaign');
  const pendingOperation = { ...f.operation, state: 'uncertain' };
  const posts = f.provider.requests.filter(request => request.method === 'POST').length;
  const verified = await f.connector.verifyRemoteLink({ delivery: { ...f.operation, id: f.operation.deliveryId }, operation: pendingOperation, spec: f.spec, remoteId: campaign.id, acceptContentVerification: true });
  assert.equal(verified.state, undefined); assert.equal(verified.nextStep, 'create_adset'); assert.equal(verified.evidence.source, 'operator_verified');
  assert.equal(f.provider.requests.filter(request => request.method === 'POST').length, posts);
  const recovered = await f.connector.inspectDelivery({ delivery: { ...f.operation, remoteRefs: verified.remoteRefs }, operation: { ...pendingOperation, remoteRefs: verified.remoteRefs, resolution: { kind: 'link', acceptedContentVerification: true, specHash: f.operation.specHash } }, spec: f.spec });
  assert.equal(recovered.status, 'confirmed'); assert.equal(recovered.nextStep, 'create_adset');
  assert.equal(f.provider.requests.filter(request => request.method === 'POST').length, posts);
});
