import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createBrowserRuntime, isPublicBrowserAddress } from '../lib/social/browser-runtime.mjs';
import { createBrowserClient, browserSignature } from '../lib/social/browser-client.mjs';
import { hash } from '../lib/business/commands.mjs';
import { createMetaBrowserConnector } from '../lib/social/meta-browser.mjs';
import { createSocialBrowserProvider } from './social-browser-provider.mjs';

const identities = Object.freeze({ userId: '101', businessId: '202', pageId: '303', instagramId: '404', adAccountId: '505' });
const hasCode = expected => error => error.errorCode === expected;
function session(connectionId = 'connection-1', epoch = 0) {
  return { connectionId, sessionEpoch: epoch, lease: { key: `social:browser-lock:${connectionId}`, token: randomBytes(24).toString('base64url'), leaseUntil: new Date(Date.now() + 120000).toISOString() } };
}
async function environment(t, { maxContexts = 2, now = Date.now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'social-browser-')), provider = await createSocialBrowserProvider(), controlKey = randomBytes(32);
  const bytes = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#c44122' } }).jpeg().toBuffer();
  const assetId = randomUUID();
  await mkdir(join(root, assetId));
  await writeFile(join(root, assetId, 'derivative.jpg'), bytes);
  const media = { assetId, key: `${assetId}/derivative.jpg`, sha256: createHash('sha256').update(bytes).digest('hex') };
  let runtime, server, url;
  async function start() {
    runtime = await createBrowserRuntime({ chromium, controlKey, mediaRoot: root, allowedOrigins: [provider.origin], maxContexts, now });
    server = createServer((req, res) => { void runtime.handle(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    return createBrowserClient({ baseUrl: url, controlKey });
  }
  async function stop() { await runtime?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
  t.after(async () => { await stop(); await provider.close(); await rm(root, { recursive: true, force: true }); });
  const client = await start();
  return { provider, client, media, root, controlKey, get url() { return url; }, async restart() { await stop(); return start(); } };
}
async function login(client, boundSession, { challenge = false } = {}) {
  const bound = client.forSession(boundSession);
  await bound.open({ payload: { purpose: 'login' } });
  assert.equal((await bound.inspect({ payload: { kind: 'connection' } })).data.state, 'login_required');
  let sequence = 0;
  const send = input => bound.input({ payload: { sequence: ++sequence, input } });
  await send({ kind: 'type', text: 'admin@example.test' });
  await send({ kind: 'key', key: 'Tab' });
  await send({ kind: 'type', text: 'password-canary-2fa' });
  await send({ kind: 'key', key: 'Enter' });
  if (challenge) {
    assert.equal((await bound.inspect({ payload: { kind: 'connection' } })).data.state, 'challenge_required');
    await send({ kind: 'type', text: '654321' });
    await send({ kind: 'key', key: 'Enter' });
  }
  const observed = await bound.inspect({ payload: { kind: 'connection', expectedIdentities: identities } });
  assert.equal(observed.status, 'confirmed');
  return { bound, sequence, observed };
}
function paidSpec(media) {
  return { integrationMethod: 'browser', connectionId: 'connection-1', assetId: media.assetId, assetHash: media.sha256, assetType: 'image', identities: { ...identities }, mode: 'paid', objective: 'traffic', platforms: ['facebook', 'instagram'], caption: 'Independent creative for a controlled UI exercise', headline: 'Nutrition', destinationUrl: 'https://example.test/product', whatsappNumber: '', whatsappGreeting: '', audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [] }, placements: ['facebook_feed', 'instagram_feed'], budgetMinor: 5000000, currency: 'COP', publishAt: null, startAt: '2030-01-01T14:00:00.000Z', endAt: '2030-01-08T14:00:00.000Z', observationDays: 7, aiDisclosure: false, timeZone: 'America/Bogota' };
}
function operation(step, spec, extra = {}) { return { id: randomBytes(16).toString('hex'), state: 'sent', step, specHash: hash(spec), ...extra }; }
function budgetConfirmation(spec, remainingMinor = 5000000) {
  return { remainingMinor, originalBudgetMinor: spec.budgetMinor, currency: spec.currency, startAt: spec.startAt, endAt: spec.endAt };
}
async function prepare(bound, spec, media) {
  const prepared = await bound.preflight({ payload: { operation: operation('prepare', spec, { acceptPrivateDraft: true }), spec, expectedIdentities: identities } });
  const ref = prepared.data.remoteDraftRef;
  const validated = await bound.preflight({ payload: { operation: operation('validate', spec, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec, media, expectedIdentities: identities } });
  assert.equal(validated.data.observedSpec.budgetMinor, spec.budgetMinor);
  const deliveryId = randomUUID();
  const adopted = await bound.execute({ payload: { operation: operation('prepare-paid', spec, { deliveryId, remoteDraftRef: ref, preparedRefs: validated.data.preparedRefs, mediaEvidence: validated.data.evidence.mediaEvidence }), spec, expectedIdentities: identities } });
  assert.equal(adopted.data.state, 'ready');
  return { ref, deliveryId, preparedRefs: adopted.data.preparedRefs, mediaEvidence: adopted.data.evidence.mediaEvidence };
}

// All browsers in this file are real sandboxed Chromium. Factory injection
// replaces the complete production allowlist, so these tests cannot reach Meta.
test('login asistido, desafío, sesión reutilizable y expiración real de cookie', async t => {
  const env = await environment(t), control = session();
  env.provider.state.challenge = true;
  const { bound, sequence, observed } = await login(env.client, control, { challenge: true });
  assert.deepEqual(observed.data.identities, identities);
  assert.equal(observed.data.capabilities.adsPublish, true);
  assert.equal(observed.data.resources.pages[0].id, '303');
  assert.notEqual(observed.data.resources.pages[0].id, 'page-dom');
  await assert.rejects(bound.input({ payload: { sequence: sequence + 1, input: { kind: 'key', key: 'Enter' } } }), hasCode('AUTH_FAILED'));
  const jpeg = await bound.frame(); assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
  const saved = (await bound.exportState()).data.storageState;
  assert.ok(saved.cookies.some(cookie => cookie.name === 'fixture_session'));
  assert.ok(!JSON.stringify(observed).includes('password-canary'));
  await bound.close();
  const restarted = (await env.restart()).forSession(control);
  await restarted.open({ payload: { purpose: 'worker', storageState: { ...saved, origins: [...saved.origins, { origin: 'https://evil.example', localStorage: [{ name: 'secret', value: 'drop-me' }], indexedDB: ['drop'] }] }, expectedIdentities: identities } });
  assert.equal((await restarted.inspect({ payload: { kind: 'connection', expectedIdentities: identities } })).data.state, 'connected');
  assert.ok(!(await restarted.exportState()).data.storageState.origins.some(item => item.origin.includes('evil')));
  await restarted.close(); env.provider.state.challenge = true;
  await restarted.open({ payload: { purpose: 'worker', storageState: saved } });
  await assert.rejects(restarted.inspect({ payload: { kind: 'connection' } }), hasCode('CHALLENGE_REQUIRED'));
  await restarted.close(); env.provider.state.challenge = false;
  env.provider.expireSessions();
  await restarted.open({ payload: { purpose: 'worker', storageState: saved } });
  await assert.rejects(restarted.inspect({ payload: { kind: 'connection', expectedIdentities: identities } }), hasCode('SESSION_EXPIRED'));
});

test('HMAC inválido, nonce repetido, desfase y límites no ejecutan comandos', async t => {
  const env = await environment(t), control = session();
  const body = JSON.stringify({ command: 'open', ...control, payload: { purpose: 'login' } });
  const time = String(Date.now()), nonce = randomBytes(32).toString('base64url');
  const headers = { 'content-type': 'application/json', 'x-social-time': time, 'x-social-nonce': nonce, 'x-social-signature': browserSignature(env.controlKey, 'POST', '/control', time, nonce, body) };
  const send = headers => fetch(`${env.url}/control`, { method: 'POST', headers, body });
  assert.equal((await send({ ...headers, 'x-social-signature': '0'.repeat(64) })).status, 401);
  assert.equal((await send(headers)).status, 200);
  assert.equal((await send(headers)).status, 401);
  assert.equal((await send({ ...headers, 'x-social-time': String(Date.now() - 31000), 'x-social-nonce': randomBytes(32).toString('base64url') })).status, 401);
  assert.equal((await fetch(`${env.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken-json' })).status, 401);
  assert.deepEqual(await (await fetch(`${env.url}/health`)).json(), { available: true });
  assert.equal((await fetch(`${env.url}/evaluate`, { method: 'POST', body: 'alert(1)' })).status, 404);
  await assert.rejects(env.client.forSession(control).input({ payload: { sequence: 1, input: { kind: 'key', key: 'Control+L' } } }), hasCode('AUTH_FAILED'));
  await assert.rejects(env.client.forSession(control).input({ payload: { sequence: 1, input: { kind: 'click', x: 1280, y: 0 } } }), hasCode('AUTH_FAILED'));
  const large = JSON.stringify({ command: 'input', ...control, payload: { sequence: 1, input: { kind: 'type', text: 'x'.repeat(4096) } } }), largeNonce = randomBytes(32).toString('base64url'), largeTime = String(Date.now());
  const limited = await fetch(`${env.url}/control`, { method: 'POST', body: large, headers: { 'content-type': 'application/json', 'x-social-time': largeTime, 'x-social-nonce': largeNonce, 'x-social-signature': browserSignature(env.controlKey, 'POST', '/control', largeTime, largeNonce, large) } });
  assert.equal(limited.status, 401);
});

test('lease y epoch cercan contextos, entrada se deduplica y nunca desaloja dueño activo', async t => {
  const env = await environment(t, { maxContexts: 1 }), first = session(), bound = env.client.forSession(first);
  await bound.open({ payload: { purpose: 'login' } });
  const payload = { sequence: 1, input: { kind: 'type', text: 'admin@' } };
  await bound.input({ payload });
  assert.equal((await bound.input({ payload })).data.duplicate, true);
  await assert.rejects(bound.input({ payload: { sequence: 1, input: { kind: 'type', text: 'different' } } }), hasCode('AUTH_FAILED'));
  await assert.rejects(env.client.forSession(session()).frame(), hasCode('LEASE_LOST'));
  await assert.rejects(env.client.forSession(session('other')).open({ payload: { purpose: 'login' } }), hasCode('BROWSER_BUSY'));
  const newer = { ...first, sessionEpoch: 1, lease: { ...first.lease, token: randomBytes(24).toString('base64url') } };
  await env.client.forSession(newer).open({ payload: { purpose: 'login' } });
  await assert.rejects(bound.frame(), hasCode('LEASE_LOST'));
  await assert.rejects(env.client.forSession({ ...newer, lease: { ...newer.lease, leaseUntil: new Date(Date.now() - 1).toISOString() } }).renew(), hasCode('LEASE_LOST'));
  await env.client.forSession(newer).close();
  await env.client.forSession(session('other')).open({ payload: { purpose: 'login' } });
});

test('identidad ajena, idioma no admitido y redirects privados bloquean sin fallback', async t => {
  let privateVisits = 0;
  const privateTarget = createServer((request, response) => { privateVisits++; response.end('forbidden'); });
  await new Promise(resolve => privateTarget.listen(0, '127.0.0.1', resolve));
  t.after(async () => { privateTarget.closeAllConnections(); await new Promise(resolve => privateTarget.close(resolve)); });
  const env = await environment(t), control = session(), { bound } = await login(env.client, control);
  const saved = (await bound.exportState()).data.storageState;
  await assert.rejects(bound.inspect({ payload: { kind: 'connection', expectedIdentities: { userId: '999' } } }), hasCode('ACCOUNT_MISMATCH'));
  await assert.rejects(bound.exportState(), hasCode('ACCOUNT_MISMATCH'));
  await bound.close(); env.provider.state.locale = 'fr';
  await bound.open({ payload: { purpose: 'worker', storageState: saved } });
  await assert.rejects(bound.inspect({ payload: { kind: 'connection' } }), hasCode('LAYOUT_CHANGED'));
  await bound.close(); env.provider.state.locale = 'en'; env.provider.state.privateRedirect = `http://127.0.0.1:${privateTarget.address().port}/metadata`;
  await assert.rejects(bound.open({ payload: { purpose: 'worker', storageState: saved } }), hasCode('AUTH_FAILED'));
  assert.equal(privateVisits, 0);
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.100.100.200', '::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) assert.equal(isPublicBrowserAddress(address), false, address);
  assert.equal(isPublicBrowserAddress('1.1.1.1'), true);
});

test('draft independiente, cambios remotos bloqueados, activación, pausa y reanudación confirmadas', async t => {
  const previous = process.env.SOCIAL_PUBLISHING_ENABLED; process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_PUBLISHING_ENABLED; else process.env.SOCIAL_PUBLISHING_ENABLED = previous; });
  const env = await environment(t), control = session(), spec = paidSpec(env.media);
  let { bound } = await login(env.client, control);
  const { ref, deliveryId, preparedRefs, mediaEvidence } = await prepare(bound, spec, env.media);
  const saved = (await bound.exportState()).data.storageState;
  bound = (await env.restart()).forSession(control);
  await bound.open({ payload: { purpose: 'worker', storageState: saved } });
  const nativeDraft = await bound.inspect({ payload: { kind: 'delivery', delivery: { id: deliveryId, state: 'ready', remoteRefs: preparedRefs, preparedRefs, mediaEvidence }, spec, expectedIdentities: identities } });
  assert.equal(nativeDraft.data.state, 'ready');
  assert.equal(nativeDraft.data.remoteRefs.remoteDraftRef, ref);
  const remote = env.provider.objects.get(ref);
  assert.equal(remote.state, 'Draft'); assert.equal(remote.config.budget, '50000.00'); assert.equal(env.provider.state.activationCount, 0);
  assert.equal(remote.config.media.sha256, env.media.sha256);
  assert.equal(remote.name, `All Nutrition ${deliveryId}`); assert.equal(env.provider.objects.size, 1);
  assert.equal(preparedRefs.adSetId, remote.adSetId); assert.equal(preparedRefs.adId, remote.adId);
  const activation = () => ({ operation: operation('activate:request-1', spec, { deliveryId, remoteDraftRef: ref, preparedRefs, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec), data: { mediaEvidence } }), spec, expectedIdentities: identities });
  env.provider.state.forceBudget = '50001.00';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.state.activationCount, 0); env.provider.state.forceBudget = null;
  env.provider.state.forceObjective = 'reach';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.state.activationCount, 0); env.provider.state.forceObjective = null;
  env.provider.state.omit = 'headline';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('LAYOUT_CHANGED'));
  assert.equal(env.provider.state.activationCount, 0); env.provider.state.omit = null;
  env.provider.state.adAccountId = '999';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('ACCOUNT_MISMATCH'));
  assert.equal(env.provider.state.activationCount, 0); env.provider.state.adAccountId = identities.adAccountId;
  remote.config.placements = ['facebook_feed'];
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  remote.config.placements = [...spec.placements];
  remote.config.budgetType = 'daily';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  remote.config.budgetType = 'lifetime';
  remote.config.expansion = true;
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  remote.config.expansion = false;
  const originalAdSet = remote.adSetId; remote.adSetId = '777777';
  await assert.rejects(bound.execute({ payload: activation() }), hasCode('SPEC_MISMATCH'));
  remote.adSetId = originalAdSet;
  const activated = await bound.execute({ payload: activation() });
  assert.equal(activated.data.state, 'active'); assert.equal(env.provider.state.activationCount, 1);
  const delivery = { remoteId: activated.data.remoteRefs.remoteId, mediaEvidence: activated.data.evidence.mediaEvidence };
  await bound.close();
  bound = (await env.restart()).forSession(control);
  await bound.open({ payload: { purpose: 'worker', storageState: saved } });
  assert.equal((await bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } })).data.state, 'active');
  const paused = await bound.execute({ payload: { operation: operation('pause:1', spec, { remoteId: delivery.remoteId }), delivery, spec, expectedIdentities: identities } });
  assert.equal(paused.data.state, 'paused');
  assert.equal((await bound.execute({ payload: { operation: operation('resume:1', spec, { remoteId: delivery.remoteId, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), delivery, spec, expectedIdentities: identities } })).data.state, 'active');
  assert.equal((await bound.execute({ payload: { operation: operation('pause:2', spec, { remoteId: delivery.remoteId }), delivery, spec, expectedIdentities: identities } })).data.state, 'paused');
  assert.equal(env.provider.state.pauseCount, 2); assert.equal(env.provider.state.resumeCount, 1);
  assert.equal((await bound.execute({ payload: { operation: operation('resume:2', spec, { remoteId: delivery.remoteId, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), delivery, spec, expectedIdentities: identities } })).data.state, 'active');
  assert.equal((await bound.execute({ payload: { operation: operation('pause:final', spec, { remoteId: delivery.remoteId }), delivery, spec, expectedIdentities: identities } })).data.state, 'paused');
  assert.equal(env.provider.state.pauseCount, 3); assert.equal(env.provider.state.resumeCount, 2);
  env.provider.state.exportRows = 3;
  const metricQuery = { periodStart: '2026-10-01', periodEnd: '2026-10-31', windowStart: '2026-10-01T05:00:00.000Z', windowEnd: '2026-11-01T04:59:59.999Z', timeZone: 'America/Bogota', scope: 'paid', periodType: 'range', dimension: 'daily' };
  const measurement = (await bound.measure({ payload: { delivery, spec, expectedIdentities: identities, query: metricQuery } })).data.snapshots[0];
  assert.equal(measurement.coverage.complete, true); assert.equal(measurement.coverage.rowCount, 3);
  assert.equal(measurement.rows[0].values.spendMinor.value, 10000000);
  assert.equal(measurement.rows[0].values.impressions.value, 4000);
  assert.equal(measurement.rows[0].values.reach.value, 3000);
  assert.equal(measurement.apiVersion, null); assert.equal(measurement.integrationMethod, 'browser');
  env.provider.state.exportAvailable = false;
  const paginated = (await bound.measure({ payload: { delivery, spec, expectedIdentities: identities, query: metricQuery } })).data.snapshots[0];
  assert.equal(paginated.coverage.complete, true); assert.equal(paginated.coverage.rowCount, 3);
  assert.deepEqual(paginated.rows.map(row => row.periodStart), ['2026-10-01', '2026-10-02', '2026-10-03']);
  const unavailable = (await bound.measure({ payload: { delivery, spec, expectedIdentities: identities, query: { ...metricQuery, dimension: 'country' } } })).data.snapshots[0];
  assert.equal(unavailable.coverage.status, 'unsupported'); assert.deepEqual(unavailable.values, {});
  const stateForPause = (await bound.exportState()).data.storageState;
  await bound.close(); process.env.SOCIAL_PUBLISHING_ENABLED = 'false';
  await bound.open({ payload: { purpose: 'worker', storageState: stateForPause } });
  remote.state = 'Active';
  assert.equal((await bound.execute({ payload: { operation: operation('pause:3', spec, { remoteId: delivery.remoteId }), delivery, spec: null, expectedIdentities: identities } })).data.state, 'paused');
  await assert.rejects(bound.execute({ payload: { operation: operation('resume:2', spec, { remoteId: delivery.remoteId }), delivery, spec, expectedIdentities: identities } }), hasCode('PUBLISHING_DISABLED'));
});

test('ruta de medio, symlink y SHA adulterado no suben archivos ni publican', async t => {
  const previous = process.env.SOCIAL_PUBLISHING_ENABLED; process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_PUBLISHING_ENABLED; else process.env.SOCIAL_PUBLISHING_ENABLED = previous; });
  const env = await environment(t), { bound } = await login(env.client, session()), spec = paidSpec(env.media);
  const prepared = await bound.preflight({ payload: { operation: operation('prepare', spec, { acceptPrivateDraft: true }), spec, expectedIdentities: identities } }), ref = prepared.data.remoteDraftRef;
  for (const key of ['../creative.jpg', '/etc/passwd', `${env.media.assetId}/original.jpg`]) await assert.rejects(bound.preflight({ payload: { operation: operation('validate', spec, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec, media: { ...env.media, key }, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  const otherId = randomUUID(), linked = { ...env.media, assetId: otherId, key: `${otherId}/derivative.jpg` }, linkedSpec = { ...spec, assetId: otherId };
  await mkdir(join(env.root, otherId));
  await symlink(join(env.root, env.media.key), join(env.root, linked.key));
  await assert.rejects(bound.preflight({ payload: { operation: operation('validate', linkedSpec, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec: linkedSpec, media: linked, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  const tampered = { ...env.media, sha256: '0'.repeat(64) }, alteredSpec = { ...spec, assetHash: tampered.sha256 };
  await assert.rejects(bound.preflight({ payload: { operation: operation('validate', alteredSpec, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec: alteredSpec, media: tampered, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.uploads.size, 0); assert.equal(env.provider.state.activationCount, 0);
});

test('publicación aplicada con respuesta perdida queda incierta y lectura no repite publicación', async t => {
  const previous = process.env.SOCIAL_PUBLISHING_ENABLED; process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_PUBLISHING_ENABLED; else process.env.SOCIAL_PUBLISHING_ENABLED = previous; });
  const env = await environment(t), control = session(), { bound } = await login(env.client, control);
  const spec = { ...paidSpec(env.media), mode: 'organic', platforms: ['facebook', 'instagram'], budgetMinor: null };
  const saved = (await bound.exportState()).data.storageState;
  env.provider.state.losePublish = true;
  await assert.rejects(bound.execute({ payload: { operation: operation('publish', spec, { channel: 'facebook' }), spec, media: env.media, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  assert.equal(env.provider.state.publishCount, 1); assert.equal(env.provider.objects.size, 1);
  const object = [...env.provider.objects.values()][0]; assert.equal(object.state, 'Published');
  assert.deepEqual(object.config.platforms, ['facebook']);
  const restarted = (await env.restart()).forSession(control);
  await restarted.open({ payload: { purpose: 'worker', storageState: saved } });
  const inspected = await restarted.inspect({ payload: { kind: 'delivery', delivery: { remoteId: object.id }, expectedIdentities: identities } });
  assert.equal(inspected.data.state, 'published'); assert.ok(inspected.data.remoteRefs.permalink);
  env.provider.state.permalink = 'https://www.facebook.com.evil.test/posts/9001';
  await assert.rejects(restarted.inspect({ payload: { kind: 'delivery', delivery: { remoteId: object.id }, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.state.publishCount, 1);
});

test('popup fuera del origen aislado se bloquea sin visitar el destino', async t => {
  let visits = 0;
  const outside = createServer((req, res) => { visits++; res.end('forbidden'); });
  await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
  t.after(async () => { outside.closeAllConnections(); await new Promise(resolve => outside.close(resolve)); });
  const env = await environment(t), bound = env.client.forSession(session());
  env.provider.state.popupUrl = `http://127.0.0.1:${outside.address().port}/private`;
  await bound.open({ payload: { purpose: 'login' } });
  for (let sequence = 1; sequence <= 3; sequence++) await bound.input({ payload: { sequence, input: { kind: 'key', key: 'Tab' } } });
  await assert.rejects(bound.input({ payload: { sequence: 4, input: { kind: 'key', key: 'Enter' } } }), hasCode('AUTH_FAILED'));
  assert.equal(visits, 0);
});

function enablePublishing(t) {
  const previous = process.env.SOCIAL_PUBLISHING_ENABLED;
  process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.SOCIAL_PUBLISHING_ENABLED; else process.env.SOCIAL_PUBLISHING_ENABLED = previous; });
}

test('preflight parcial recuperable y vínculo standalone son lecturas sin crear otro borrador', async t => {
  enablePublishing(t);
  const env = await environment(t), control = session(), { bound } = await login(env.client, control);
  const spec = { ...paidSpec(env.media), assetId: null, assetType: null, assetHash: null, budgetMinor: 0, startAt: null, endAt: null };
  const intention = operation('prepare', spec, { acceptPrivateDraft: true });
  const stored = (await bound.exportState()).data.storageState;
  env.provider.state.loseSave = true;
  await assert.rejects(bound.preflight({ payload: { operation: intention, spec, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  assert.equal(env.provider.objects.size, 1);
  const remote = [...env.provider.objects.values()][0];
  assert.equal(remote.name, `All Nutrition ${intention.id}`); assert.equal(remote.state, 'Draft');
  env.provider.state.loseSave = false;
  const client = await env.restart(), connector = createMetaBrowserConnector({ client: client.forSession(control), connection: { id: control.connectionId, integrationMethod: 'browser', identities }, credentials: { storageState: stored } });
  const recovered = await connector.inspectDelivery({ delivery: null, operation: intention, spec });
  assert.equal(recovered.remoteRefs.remoteDraftRef, remote.id); assert.equal(recovered.evidence.remoteRead, true);
  const linked = await connector.verifyRemoteLink({ delivery: null, operation: intention, spec, remoteId: remote.id, acceptContentVerification: true });
  assert.equal(linked.state, 'ready'); assert.equal(linked.evidence.everActivated, false);
  await connector.disconnect();
  process.env.SOCIAL_PUBLISHING_ENABLED = 'false';
  const searched = await connector.preflight({ operation: operation('targeting', spec, { acceptPrivateDraft: true, remoteDraftRef: remote.id }), spec, query: { kind: 'location', q: 'Bogotá' } });
  assert.equal(searched.candidates[0].context.region, 'Bogotá D.C.');
  assert.equal(remote.config.budget, '0.00'); assert.equal(env.provider.objects.size, 1);
  remote.name = 'A different technical reference';
  await assert.rejects(connector.verifyRemoteLink({ delivery: null, operation: intention, spec, remoteId: remote.id, acceptContentVerification: true }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.objects.size, 1); assert.equal(env.provider.state.activationCount, 0);
});

test('pérdida antes del marcador sólo permite vínculo humano de draft privado sin nombre', async t => {
  enablePublishing(t);
  const env = await environment(t), control = session(), { bound } = await login(env.client, control);
  const spec = { ...paidSpec(env.media), assetId: null, assetType: null, assetHash: null, budgetMinor: 0, startAt: null, endAt: null }, intention = operation('prepare', spec, { acceptPrivateDraft: true });
  const stored = (await bound.exportState()).data.storageState;
  env.provider.state.loseCreate = true;
  await assert.rejects(bound.preflight({ payload: { operation: intention, spec, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  env.provider.state.loseCreate = false;
  // Chromium can retry a failed form navigation below the application click.
  // An unmarked result stays ambiguous; neither inspection nor manual linking
  // may add another effect.
  const createdDrafts = env.provider.objects.size, remote = [...env.provider.objects.values()][0];
  assert.equal(remote.name, ''); assert.equal(remote.state, 'Draft');
  const connector = createMetaBrowserConnector({ client: (await env.restart()).forSession(control), connection: { id: control.connectionId, integrationMethod: 'browser', identities }, credentials: { storageState: stored } });
  assert.equal((await connector.inspectDelivery({ delivery: null, operation: intention, spec })).status, 'uncertain');
  await assert.rejects(connector.verifyRemoteLink({ delivery: null, operation: intention, spec, remoteId: remote.id }), hasCode('SPEC_MISMATCH'));
  const linked = await connector.verifyRemoteLink({ delivery: null, operation: intention, spec, remoteId: remote.id, acceptContentVerification: true });
  assert.equal(linked.remoteRefs.remoteDraftRef, remote.id); assert.equal(linked.state, 'ready');
  assert.equal(env.provider.objects.size, createdDrafts); assert.equal(env.provider.state.activationCount, 0);
});

test('geografía observada conserva jerarquía independiente, radio e intereses; cambios bloquean adopción', async t => {
  enablePublishing(t);
  const env = await environment(t), { bound } = await login(env.client, session()), initial = paidSpec(env.media);
  const draft = await bound.preflight({ payload: { operation: operation('prepare', initial, { acceptPrivateDraft: true }), spec: initial, expectedIdentities: identities } }), ref = draft.data.remoteDraftRef;
  async function candidates(kind, q) {
    return (await bound.preflight({ payload: { operation: operation('targeting', initial, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec: initial, query: { kind, q }, expectedIdentities: identities } })).data.candidates;
  }
  const [region] = await candidates('location', 'Antioquia'), [city] = await candidates('location', 'Bogotá'), [interest] = await candidates('interest', 'Fitness');
  assert.deepEqual(region.context, { type: 'region', countryCode: 'CO', region: 'Antioquia', scope: 'Colombia / departments' });
  assert.deepEqual(city.context, { type: 'city', countryCode: 'CO', region: 'Bogotá D.C.', scope: 'Colombia / Bogotá D.C. / cities' });
  assert.equal(interest.context.countryCode, null);
  const configuredCity = { ...city, context: { ...city.context, radius: 25, distanceUnit: 'kilometer' } };
  const spec = { ...initial, audience: { ...initial.audience, countries: [], regions: [region], cities: [configuredCity], interests: [interest] } };
  const validation = await bound.preflight({ payload: { operation: operation('validate', spec, { acceptPrivateDraft: true, remoteDraftRef: ref }), spec, media: env.media, expectedIdentities: identities } });
  assert.deepEqual(validation.data.observedSpec.audience.cities, [configuredCity]);
  const remote = env.provider.objects.get(ref);
  assert.equal(remote.config.cities[0].context.radius, 25);
  assert.equal(remote.config.regions[0].context.region, 'Antioquia');
  assert.equal(remote.config.budget, '50000.00');
  const adoption = () => ({ operation: operation('prepare-paid', spec, { deliveryId: randomUUID(), remoteDraftRef: ref, preparedRefs: validation.data.preparedRefs, mediaEvidence: validation.data.evidence.mediaEvidence }), spec, expectedIdentities: identities });
  remote.config.cities[0].context.radius = 26;
  await assert.rejects(bound.execute({ payload: adoption() }), hasCode('SPEC_MISMATCH'));
  remote.config.cities[0].context.radius = 25;
  remote.config.cities[0].context.region = 'A different department';
  await assert.rejects(bound.execute({ payload: adoption() }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.objects.size, 1); assert.equal(env.provider.state.activationCount, 0);
});

test('cuatro objetivos, bienvenida WhatsApp y formato real permanecen en el mismo draft privado', async t => {
  enablePublishing(t);
  const appKeys = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'], previousKeys = Object.fromEntries(appKeys.map(key => [key, process.env[key]]));
  for (const key of appKeys) delete process.env[key];
  t.after(() => { for (const key of appKeys) if (previousKeys[key] === undefined) delete process.env[key]; else process.env[key] = previousKeys[key]; });
  const env = await environment(t), { bound } = await login(env.client, session());
  for (const objective of ['traffic', 'whatsapp', 'reach', 'engagement']) {
    const spec = { ...paidSpec(env.media), objective, aiDisclosure: objective === 'engagement', ...(objective === 'whatsapp' ? { destinationUrl: '', whatsappNumber: '+573001112233', whatsappGreeting: 'Hola, gracias por escribirnos. ¿Cómo podemos ayudarte?' } : {}) };
    const prepared = await prepare(bound, spec, env.media), remote = env.provider.objects.get(prepared.ref);
    assert.equal(remote.config.objective, objective); assert.equal(remote.everActivated, false);
    assert.equal(remote.config.whatsappGreeting, spec.whatsappGreeting);
    assert.equal(remote.config.aiDisclosure, spec.aiDisclosure);
    assert.equal(remote.config.media.sha256, env.media.sha256); assert.equal(remote.config.media.format, 'Image');
    assert.equal(prepared.mediaEvidence.remoteMediaId, remote.config.media.id);
    if (objective === 'whatsapp') {
      remote.config.whatsappGreeting = 'Changed by another editor';
      await assert.rejects(bound.inspect({ payload: { kind: 'delivery', operation: operation('prepare-paid', spec, { deliveryId: prepared.deliveryId, remoteDraftRef: prepared.ref, mediaEvidence: prepared.mediaEvidence }), spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
    }
  }
  assert.equal(env.provider.objects.size, 4); assert.equal(env.provider.state.activationCount, 0);
});

test('activación perdida se reconcilia sin publicar de nuevo y no confunde paused con ready', async t => {
  enablePublishing(t);
  const env = await environment(t), control = session(), { bound } = await login(env.client, control), spec = paidSpec(env.media);
  const prepared = await prepare(bound, spec, env.media), stored = (await bound.exportState()).data.storageState;
  const activate = operation('activate:lost-response', spec, { ...prepared, remoteDraftRef: prepared.ref, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) });
  const beforeActivation = await bound.inspect({ payload: { kind: 'delivery', operation: { ...activate, state: 'prepared' }, spec, expectedIdentities: identities } });
  assert.equal(beforeActivation.status, 'confirmed'); assert.equal(beforeActivation.data.state, 'ready'); assert.equal(beforeActivation.data.evidence.everActivated, false);
  env.provider.state.losePublish = true;
  await assert.rejects(bound.execute({ payload: { operation: activate, spec, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  assert.equal(env.provider.state.activationCount, 1);
  const restarted = (await env.restart()).forSession(control);
  await restarted.open({ payload: { purpose: 'worker', storageState: stored } });
  const observed = await restarted.inspect({ payload: { kind: 'delivery', operation: activate, spec, expectedIdentities: identities } });
  assert.equal(observed.data.state, 'active'); assert.equal(observed.data.evidence.everActivated, true);
  assert.equal(env.provider.state.activationCount, 1); assert.equal(env.provider.objects.size, 1);
  const remote = env.provider.objects.get(prepared.ref); remote.state = 'Paused';
  const paused = await restarted.inspect({ payload: { kind: 'delivery', delivery: { remoteId: remote.id, mediaEvidence: observed.data.evidence.mediaEvidence }, spec, expectedIdentities: identities } });
  assert.equal(paused.data.state, 'paused'); assert.equal(paused.data.evidence.everActivated, true);
  remote.state = 'Draft';
  await assert.rejects(restarted.inspect({ payload: { kind: 'delivery', operation: operation('prepare-paid', spec, { remoteDraftRef: remote.id, mediaEvidence: prepared.mediaEvidence }), spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
});

test('pausa mínima y exportación de sesión no dependen de Page, Instagram, pieza ni flag', async t => {
  enablePublishing(t);
  const env = await environment(t), control = session(), { bound } = await login(env.client, control), spec = paidSpec(env.media);
  const prepared = await prepare(bound, spec, env.media), stored = (await bound.exportState()).data.storageState;
  await bound.execute({ payload: { operation: operation('activate:initial', spec, { ...prepared, remoteDraftRef: prepared.ref, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), spec, expectedIdentities: identities } });
  await bound.close(); process.env.SOCIAL_PUBLISHING_ENABLED = 'false';
  await rm(join(env.root, env.media.key));
  env.provider.state.pageId = null; env.provider.state.instagramId = null;
  env.provider.state.omit = 'budget';
  env.provider.state.hidePauseMetadata = true;
  const connector = createMetaBrowserConnector({ client: bound, connection: { id: control.connectionId, integrationMethod: 'browser', identities }, credentials: { storageState: stored } });
  const checked = await connector.validateConnection({ purpose: 'pause' });
  assert.deepEqual(checked.identities, { userId: identities.userId, adAccountId: identities.adAccountId });
  const paused = await connector.executeStep({ operation: operation('pause:stop-spend', spec, { remoteId: prepared.ref }), spec: null, purpose: 'pause' });
  assert.equal(paused.state, 'paused'); assert.equal(paused.evidence.remoteRead, true);
  assert.equal(env.provider.objects.get(prepared.ref).config.budget, '50000.00');
  assert.equal(paused.evidence.budget, undefined);
  const exported = (await bound.exportState({ payload: { purpose: 'pause' } })).data.storageState;
  await bound.close();
  const restarted = (await env.restart()).forSession(control), resumed = createMetaBrowserConnector({ client: restarted, connection: { id: control.connectionId, integrationMethod: 'browser', identities }, credentials: { storageState: exported } });
  assert.deepEqual((await resumed.validateConnection({ purpose: 'pause' })).identities, { userId: identities.userId, adAccountId: identities.adAccountId });
  await restarted.close();
  const linkedPause = await resumed.verifyRemoteLink({ delivery: { remoteId: prepared.ref, channel: 'meta_ads' }, operation: operation('pause:manual-read', spec), spec, remoteId: prepared.ref, acceptContentVerification: true });
  assert.equal(linkedPause.state, 'paused'); assert.equal(linkedPause.evidence.remoteRead, true);
  env.provider.state.adAccountId = '999';
  await assert.rejects(resumed.inspectDelivery({ delivery: { remoteId: prepared.ref }, operation: operation('pause:inspect', spec), spec: null, purpose: 'pause' }), hasCode('ACCOUNT_MISMATCH'));
});

test('vínculo manual confirma canal, contenido y permalink por lectura sin SHA ficticio ni publicación', async t => {
  enablePublishing(t);
  const env = await environment(t), control = session(), { bound } = await login(env.client, control);
  const spec = { ...paidSpec(env.media), mode: 'organic', platforms: ['facebook', 'instagram'], budgetMinor: 0 };
  const intention = operation('publish', spec, { channel: 'instagram' }), saved = (await bound.exportState()).data.storageState;
  env.provider.state.losePublish = true;
  await assert.rejects(bound.execute({ payload: { operation: intention, spec, media: env.media, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  const remote = [...env.provider.objects.values()][0];
  const client = (await env.restart()).forSession(control);
  const connector = createMetaBrowserConnector({ client, connection: { id: control.connectionId, integrationMethod: 'browser', identities }, credentials: { storageState: saved } });
  const permalink = `https://www.instagram.com/p/${remote.id}/`, delivery = { id: randomUUID(), channel: 'instagram' };
  await assert.rejects(connector.verifyRemoteLink({ delivery, operation: intention, spec, remoteId: remote.id }), hasCode('SPEC_MISMATCH'));
  const linked = await connector.verifyRemoteLink({ delivery, operation: intention, spec, permalink, acceptContentVerification: true });
  assert.equal(linked.state, 'published'); assert.equal(linked.remoteRefs.remoteId, remote.id); assert.equal(linked.remoteRefs.permalink, permalink);
  assert.equal(linked.observedSpec.assetHash, null); assert.equal(linked.evidence.contentVerifiedByAdministrator, true);
  const resolution = { kind: 'link', acceptContentVerification: true, specHash: hash(spec), refs: linked.remoteRefs };
  const reread = await connector.inspectDelivery({ delivery, operation: { ...intention, resolution }, spec });
  assert.equal(reread.state, 'published');
  remote.config.caption = 'Another post text';
  await assert.rejects(connector.verifyRemoteLink({ delivery, operation: intention, spec, remoteId: remote.id, acceptContentVerification: true }), hasCode('SPEC_MISMATCH'));
  remote.config.caption = spec.caption; remote.channel = 'facebook';
  await assert.rejects(connector.verifyRemoteLink({ delivery, operation: intention, spec, remoteId: remote.id, acceptContentVerification: true }), hasCode('ACCOUNT_MISMATCH'));
  assert.equal(env.provider.state.publishCount, 1); assert.equal(env.provider.objects.size, 1);
});

test('controles rechazan mejoras, recorte, IA y estructura externas sin activar; restante desconocido no autoriza resume', async t => {
  enablePublishing(t);
  const env = await environment(t), { bound } = await login(env.client, session()), spec = paidSpec(env.media), prepared = await prepare(bound, spec, env.media);
  const remote = env.provider.objects.get(prepared.ref);
  const activate = () => ({ operation: operation('activate:exact', spec, { ...prepared, remoteDraftRef: prepared.ref, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), spec, expectedIdentities: identities });
  for (const [key, value] of [['enhancements', true], ['crop', 'square'], ['automaticMusic', true], ['geoExpansion', true], ['aiDisclosure', true], ['cta', 'none']]) {
    const original = remote.config[key]; remote.config[key] = value;
    await assert.rejects(bound.execute({ payload: activate() }), hasCode('SPEC_MISMATCH'));
    remote.config[key] = original;
    assert.equal(env.provider.state.activationCount, 0);
  }
  env.provider.state.adSetCount = 2;
  await assert.rejects(bound.execute({ payload: activate() }), hasCode('SPEC_MISMATCH'));
  env.provider.state.adSetCount = 1;
  env.provider.state.publishState = 'Scheduled';
  const scheduled = await bound.execute({ payload: activate() });
  assert.equal(scheduled.data.state, 'scheduled'); assert.equal(scheduled.data.evidence.everActivated, true);
  const delivery = { remoteId: scheduled.data.remoteRefs.remoteId, mediaEvidence: scheduled.data.evidence.mediaEvidence };
  await bound.execute({ payload: { operation: operation('pause:one', spec, { remoteId: delivery.remoteId }), delivery, spec: null, expectedIdentities: identities } });
  env.provider.state.remainingBudget = null;
  const snapshot = await bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } });
  assert.equal(snapshot.data.evidence.budget.remainingMinor, null);
  await assert.rejects(bound.execute({ payload: { operation: operation('resume:unknown', spec, { remoteId: delivery.remoteId, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), delivery, spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  env.provider.state.remainingBudget = '41000.00';
  await assert.rejects(bound.execute({ payload: { operation: operation('resume:stale', spec, { remoteId: delivery.remoteId, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) }), delivery, spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  env.provider.state.publishState = 'Active';
  assert.equal((await bound.execute({ payload: { operation: operation('resume:accepted', spec, { remoteId: delivery.remoteId, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec, 4100000) }), delivery, spec, expectedIdentities: identities } })).data.state, 'active');
  assert.equal(remote.config.budget, '50000.00'); assert.equal(remote.config.endAt, spec.endAt);
  remote.state = 'Completed';
  await assert.rejects(bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  remote.ended = true;
  assert.equal((await bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } })).data.state, 'completed');
  remote.state = 'Rejected';
  const rejected = await bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } });
  assert.equal(rejected.data.state, 'failed'); assert.match(rejected.data.evidence.reason, /review rejected/i);
});

test('pérdida del lease tras publicar conserva efecto incierto y pausa encuentra UUID sin remoteId', async t => {
  enablePublishing(t);
  let clockOffset = 0;
  const env = await environment(t, { now: () => Date.now() + clockOffset }), control = session(), { bound } = await login(env.client, control), spec = paidSpec(env.media);
  const prepared = await prepare(bound, spec, env.media), saved = (await bound.exportState()).data.storageState;
  const activate = operation('activate:lease-lost', spec, { ...prepared, remoteDraftRef: prepared.ref, investmentAccepted: true, budgetConfirmation: budgetConfirmation(spec) });
  env.provider.state.afterPublish = () => { clockOffset = 180000; };
  await assert.rejects(bound.execute({ payload: { operation: activate, spec, expectedIdentities: identities } }), hasCode('OPERATION_UNCERTAIN'));
  assert.equal(env.provider.state.activationCount, 1); assert.equal(env.provider.objects.size, 1);
  clockOffset = 0; env.provider.state.afterPublish = null;
  const freshControl = session(control.connectionId, 1), fresh = env.client.forSession(freshControl);
  await fresh.open({ payload: { purpose: 'worker', storageState: saved, validationPurpose: 'pause', expectedIdentities: identities } });
  const paused = await fresh.execute({ payload: { operation: operation('pause:resolve-uuid', spec, { deliveryId: prepared.deliveryId, remoteDraftRef: prepared.ref }), spec: null, expectedIdentities: identities } });
  assert.equal(paused.data.state, 'paused'); assert.equal(paused.data.remoteRefs.remoteId, prepared.ref);
  assert.equal(env.provider.state.pauseCount, 1); assert.equal(env.provider.state.activationCount, 1);
});

test('pausa de draft privado queda pendiente y aliases de activación no generan publicación', async t => {
  enablePublishing(t);
  const env = await environment(t), { bound } = await login(env.client, session()), spec = paidSpec(env.media), prepared = await prepare(bound, spec, env.media);
  const pending = await bound.execute({ payload: { operation: operation('pause:private-only', spec, { deliveryId: prepared.deliveryId, remoteDraftRef: prepared.ref }), spec: null, expectedIdentities: identities } });
  assert.equal(pending.status, 'pending'); assert.equal(pending.data.evidence.everActivated, false);
  assert.equal(pending.data.state, undefined); assert.equal(env.provider.state.pauseCount, 0);
  for (const alias of ['activate-paid', 'activate_paid', 'activate', 'prepare_paid', 'cancel']) await assert.rejects(bound.execute({ payload: { operation: operation(alias, spec, { remoteDraftRef: prepared.ref }), spec, expectedIdentities: identities } }), hasCode('SPEC_MISMATCH'));
  assert.equal(env.provider.state.activationCount, 0); assert.equal(env.provider.objects.size, 1);
});

test('Reel real por cada canal confirma medio, ID y permalink desde lista sin repetir el canal exitoso', async t => {
  enablePublishing(t);
  const env = await environment(t), { bound } = await login(env.client, session());
  const assetId = randomUUID(), key = `${assetId}/derivative.mp4`, file = join(env.root, key);
  await mkdir(join(env.root, assetId));
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:r=30', '-t', '3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg fixture failed: ${diagnostic}`)));
  });
  const bytes = await readFile(file), media = { assetId, key, sha256: createHash('sha256').update(bytes).digest('hex') };
  const spec = { ...paidSpec(media), mode: 'organic', assetType: 'video', budgetMinor: 0, platforms: ['facebook', 'instagram'], placements: ['facebook_reels', 'instagram_reels'] };
  const results = [];
  for (const channel of ['facebook', 'instagram']) {
    const result = await bound.execute({ payload: { operation: operation('publish', spec, { channel }), spec, media, expectedIdentities: identities } });
    assert.equal(result.data.state, 'published'); assert.equal(result.data.evidence.remoteRead, true);
    assert.equal(result.data.observedSpec.assetType, 'video'); assert.equal(result.data.observedSpec.contentFormat, 'reel');
    const remote = env.provider.objects.get(result.data.remoteRefs.remoteId);
    assert.equal(remote.config.media.sha256, media.sha256); assert.equal(remote.config.media.format, 'Video');
    assert.deepEqual(remote.config.platforms, [channel]); assert.equal(remote.config.publishingSchedule, 'now');
    assert.match(result.data.remoteRefs.permalink, channel === 'facebook' ? /^https:\/\/www\.facebook\.com\// : /^https:\/\/www\.instagram\.com\//);
    results.push({ channel, remoteId: result.data.remoteRefs.remoteId, mediaEvidence: result.data.evidence.mediaEvidence });
  }
  for (const delivery of results) assert.equal((await bound.inspect({ payload: { kind: 'delivery', delivery, spec, expectedIdentities: identities } })).data.state, 'published');
  assert.equal(env.provider.state.publishCount, 2); assert.equal(env.provider.objects.size, 2);
});
