import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin, login, logout } from '../lib/auth.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { assertAssistantSession, assertAssistantAccess, getAssistantSettings, invalidateAssistantCredential, loadAssistantRuntime, saveAssistantSettings } from '../lib/assistant/settings.mjs';
import { hashAssistantInput, reserveAssistantTurn, saveAssistantProposal } from '../lib/assistant/repository.mjs';
import { assistantRequest, resolveAssistantEndpoint } from '../lib/assistant/http.mjs';
import { assistantProviderContextBytes, createAssistantProvider, verifyAssistantProvider } from '../lib/assistant/provider.mjs';
import { startAssistantProviderFixture } from './assistant-provider-fixture.mjs';
import { createBusinessFixture } from './business-fixtures.mjs';
import { readAssistantBusiness } from '../lib/assistant/readers.mjs';
import { resolveAssistantModelResult } from '../lib/assistant/presentation.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ali-settings-'));
  const controlDirectory = `${directory}-control`;
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:', INTEGRATION_SECRETS_DIR: directory, SOCIAL_BROWSER_CONTROL_DIR: controlDirectory });
  await store.initialize();
  await createAdmin(store, 'ali-test@example.test', 'only-test-password');
  const user = await store.db.get("SELECT id FROM users WHERE email='ali-test@example.test'");
  const authenticated = await login(store, 'ali-test@example.test', 'only-test-password');
  const session = { user: { id: user.id }, csrf: authenticated.csrf, sessionTokenHash: createHash('sha256').update(authenticated.token).digest('hex') };
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); await rm(controlDirectory, { recursive: true, force: true }); });
  return { store, user, session, token: authenticated.token, directory, controlDirectory, keyring: createIntegrationKeyring({ directory, controlDirectory }) };
}
function settings(version, patch = {}) {
  return { requestId: randomUUID(), version, enabled: false, provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'model-a', allowPrivateNetwork: false, ...patch };
}

test('assistant settings expose no secret, detect authenticated tampering and missing key custody', async t => {
  const f = await fixture(t);
  const dto = await saveAssistantSettings(f.store, settings(0, { apiKey: 'sensitive-token' }), f.session, { keyring: f.keyring });
  assert.equal(dto.hasApiKey, true);
  assert.equal(JSON.stringify(dto).includes('sensitive-token'), false);
  assert.equal(JSON.stringify(await f.store.db.get('SELECT * FROM assistant_settings')).includes('sensitive-token'), false);
  assert.equal((await loadAssistantRuntime(f.store, { keyring: f.keyring })).apiKey, 'sensitive-token');
  await f.store.db.run("UPDATE assistant_settings SET api_key_ciphertext='dGFtcGVy'");
  await assert.rejects(loadAssistantRuntime(f.store, { keyring: f.keyring }), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  await f.store.db.run("UPDATE assistant_settings SET api_key_ciphertext=?", [(await f.store.db.get('SELECT api_key_ciphertext FROM assistant_settings')).api_key_ciphertext]);
});

test('assistant settings version conflicts serialize concurrent writes and losing key fails closed', async t => {
  const f = await fixture(t);
  await saveAssistantSettings(f.store, settings(0, { apiKey: 'key-a' }), f.session, { keyring: f.keyring });
  const results = await Promise.allSettled([
    saveAssistantSettings(f.store, settings(1, { model: 'model-b' }), f.session, { keyring: f.keyring }),
    saveAssistantSettings(f.store, settings(1, { model: 'model-c' }), f.session, { keyring: f.keyring }),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.status === 409 || x.status === 'rejected' && x.reason.message.includes('otra sesión')).length, 1);
  const row = await f.store.db.get('SELECT * FROM assistant_settings');
  assert.equal(row.enabled, 0);
  await f.store.db.run('DELETE FROM assistant_settings');
  // A ciphertext row requires the original key; it must never be regenerated.
  await f.store.db.run('INSERT INTO assistant_settings(id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,created_at,updated_at) VALUES(1,1,0,?,?,?,?,?,?,?)', [row.data, row.api_key_ciphertext, row.api_key_iv, row.api_key_tag, row.actor_id, row.created_at, row.updated_at]);
  await import('node:fs/promises').then(({ unlink }) => unlink(join(f.directory, 'assistant.key')));
  await assert.rejects(loadAssistantRuntime(f.store, { keyring: f.keyring }), { code: 'INTEGRATION_KEY_MISSING' });
});

test('borrar la clave invalida el turno en curso y la propuesta de su configuración', async t => {
  const f = await fixture(t);
  const configured = await saveAssistantSettings(f.store, settings(0, { apiKey: 'key-a' }), f.session, { keyring: f.keyring });
  const authenticated = await login(f.store, 'ali-test@example.test', 'only-test-password');
  const now = Date.now(), sessionTokenHash = createHash('sha256').update(authenticated.token).digest('hex');
  const reservation = await f.store.transaction(tx => reserveAssistantTurn(tx, {
    userId: f.user.id, requestId: 'credential-reset-turn', inputHash: hashAssistantInput({ message: 'consulta activa' }),
    configurationVersion: configured.version, sessionTokenHash, data: { message: 'consulta activa' },
    at: now, deadlineAt: now + 60_000,
  }));
  const proposal = await f.store.transaction(tx => saveAssistantProposal(tx, {
    userId: f.user.id, threadId: reservation.threadId, turnId: reservation.turn.id,
    configurationVersion: configured.version, at: now + 1,
    data: {
      configurationVersion: configured.version, target: 'record:products', entityId: null, recordVersion: null,
      formId: 'form-credential-reset', generation: 0, execution: 'prefill', patch: { title: 'Propuesta preparada' },
    },
  }));

  const cleared = await saveAssistantSettings(f.store, settings(configured.version, { clearApiKey: true }), f.session, { keyring: f.keyring });
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.hasApiKey, false);
  const turn = await f.store.db.get('SELECT state,data FROM assistant_turns WHERE id=?', [reservation.turn.id]);
  assert.equal(turn.state, 'cancelled');
  assert.equal(JSON.parse(turn.data).cancellation.reason, 'configuration_changed');
  const stale = await f.store.db.get('SELECT state,version FROM assistant_proposals WHERE id=?', [proposal.id]);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.version, proposal.version + 1);
});

test('assistant transport hides credentials and rejects redirects and timeouts', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/unauthorized') { res.writeHead(401); res.end('never-return-this'); }
    else if (req.url === '/slow') setTimeout(() => { res.end('{}'); }, 100);
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ authorization: req.headers.authorization })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const common = { provider: 'openai-compatible', allowPrivateNetwork: true, apiKey: 'never-return-this', env: {}, timeoutMs: 1000 };
  assert.deepEqual(await assistantRequest(`${base}/ok`, { ...common, body: '{}' }), { authorization: 'Bearer never-return-this' });
  await assert.rejects(assistantRequest(`${base}/redirect`, { ...common, body: '{}' }), error => error.code === 'ASSISTANT_UNAVAILABLE' && !error.message.includes('never-return-this'));
  await assert.rejects(assistantRequest(`${base}/unauthorized`, { ...common, body: '{}' }), error => error.code === 'ASSISTANT_CREDENTIAL_INVALID' && !error.message.includes('never-return-this'));
  await assert.rejects(assistantRequest(`${base}/slow`, { ...common, body: '{}', timeoutMs: 10 }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(assistantRequest('http://example.invalid/v1', { ...common, body: '{}' }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('compatible provider preserves the original context across tool results', async () => {
  const requests = [];
  const replies = [
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'read-1', function: { name: 'read_catalog', arguments: '{"query":"protein"}' } }] } }] },
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'finish-1', function: { name: 'finish_turn', arguments: '{"topic":"catalog"}' } }] } }] },
  ];
  const provider = createAssistantProvider({ provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'model-a', apiKey: 'key' }, {
    transport: async (_url, request) => { requests.push(JSON.parse(request.body)); return replies.shift(); },
  });
  const context = { instructions: 'Use only verified facts.', view: { section: 'products' }, message: 'Busca proteína' };
  const tools = [
    { name: 'read_catalog', strict: false, parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
    { name: 'finish_turn', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'], additionalProperties: false } },
  ];
  const first = await provider.next({ context, tools });
  assert.equal(first.calls[0].id, 'read-1');
  assert.equal(requests[0].tools[0].function.name, 'read_catalog');
  assert.equal(Object.hasOwn(requests[0].tools[0].function, 'type'), false);
  assert.equal(requests[0].tools[0].function.strict, false);
  await provider.next({ results: [{ callId: 'read-1', name: 'read_catalog', arguments: { query: 'protein' }, result: { records: [] } }], tools });
  assert.deepEqual(requests[1].messages, [
    { role: 'system', content: 'Use only verified facts.' },
    { role: 'user', content: JSON.stringify(context) },
    { role: 'assistant', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_catalog', arguments: '{"query":"protein"}' } }] },
    { role: 'tool', tool_call_id: 'read-1', content: JSON.stringify({ records: [] }) },
  ]);
});

const syntheticTools = [
  { name: 'read_business', parameters: { type: 'object', properties: { domain: { type: 'string' }, query: { type: 'string' } }, required: ['domain','query'], additionalProperties: false } },
  { name: 'read_application', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'finish_turn', parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'], additionalProperties: false } },
];
const localTransport = (url, options) => assistantRequest(url, { ...options, env: {} });
async function syntheticFixture(t) {
  const provider = await startAssistantProviderFixture();
  t.after(() => provider.close());
  return provider;
}

test('real compatible verification requires both a valid key and rejection of an anonymous probe', async t => {
  const fixture = await syntheticFixture(t);
  const runtime = { provider: 'openai-compatible', baseUrl: fixture.url, model: 'fixture-a', apiKey: fixture.key, allowPrivateNetwork: true };
  assert.equal(await verifyAssistantProvider(runtime, { transport: localTransport }), true);
  await assert.rejects(verifyAssistantProvider({ ...runtime, apiKey: 'wrong-key' }, { transport: localTransport }), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  fixture.configure('fixture-a', { anonymous: true });
  await assert.rejects(verifyAssistantProvider(runtime, { transport: localTransport }), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  fixture.configure('fixture-a', { noTools: true });
  await assert.rejects(verifyAssistantProvider(runtime, { transport: localTransport }), { code: 'ASSISTANT_MODEL_UNSUPPORTED' });
});

test('enabling is atomic, refuses an unverified candidate and stores only safe idempotency and audit projections', async t => {
  const f = await fixture(t), server = await syntheticFixture(t);
  const input = settings(0, { enabled: true, baseUrl: server.url, model: 'fixture-a', apiKey: 'secret-canary-invalid', allowPrivateNetwork: true });
  const options = { keyring: f.keyring, transport: localTransport };
  await assert.rejects(saveAssistantSettings(f.store, input, f.session, options), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  assert.equal((await getAssistantSettings(f.store)).version, 0);
  const accepted = { ...input, requestId: randomUUID(), apiKey: server.key };
  const saved = await saveAssistantSettings(f.store, accepted, f.session, options);
  assert.equal(saved.enabled, true);
  assert.equal(saved.connectionStatus, 'ready');
  const before = server.requests.length;
  assert.deepEqual(await saveAssistantSettings(f.store, accepted, f.session, options), saved);
  assert.equal(server.requests.length, before, 'an idempotent retry must not reconnect');
  await assert.rejects(saveAssistantSettings(f.store, { ...accepted, model: 'fixture-b' }, f.session, options), { code: 'ASSISTANT_CONFLICT' });
  const persisted = JSON.stringify({
    settings: await f.store.db.all('SELECT * FROM assistant_settings'),
    requests: await f.store.db.all("SELECT * FROM business_requests WHERE scope LIKE 'assistant:%'"),
    audit: await f.store.db.all("SELECT * FROM business_audit WHERE entity_type LIKE 'assistant:%'"),
  });
  assert.equal(persisted.includes(server.key), false);
  assert.equal(persisted.includes('secret-canary-invalid'), false);
  assert.equal(persisted.includes(f.session.csrf), false);
});

test('a settings verification loses safely to a newer revision and later runtime reads see the commit', async t => {
  const f = await fixture(t);
  await saveAssistantSettings(f.store, settings(0, { apiKey: 'key-a' }), f.session, { keyring: f.keyring });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = saveAssistantSettings(f.store, settings(1, { enabled: true, model: 'old-model' }), f.session, { keyring: f.keyring, verify: async () => { entered(); await gate; } });
  await started;
  const newer = await saveAssistantSettings(f.store, settings(1, { model: 'new-model' }), f.session, { keyring: f.keyring });
  release();
  await assert.rejects(pending, { code: 'ASSISTANT_CONFIG_CHANGED' });
  const live = await loadAssistantRuntime(f.store, { keyring: f.keyring });
  assert.equal(live.model, 'new-model');
  assert.equal(live.configurationVersion, newer.version);
  assert.equal(live.enabled, false);
});

test('logout during verification prevents a configuration commit and new sends', async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = saveAssistantSettings(f.store, settings(0, { enabled: true, apiKey: 'key-a' }), f.session, { keyring: f.keyring, verify: async () => { entered(); await gate; } });
  await started;
  await logout(f.store, f.token);
  release();
  await assert.rejects(pending, { code: 'ASSISTANT_AUTH_REQUIRED' });
  assert.equal((await getAssistantSettings(f.store)).version, 0);
  await assert.rejects(assertAssistantSession(f.store, f.session), { code: 'ASSISTANT_AUTH_REQUIRED' });
});

test('credential rejection invalidates only the still-current enabled revision', async t => {
  const f = await fixture(t), options = { keyring: f.keyring, verify: async () => true };
  const first = await saveAssistantSettings(f.store, settings(0, { enabled: true, apiKey: 'key-a' }), f.session, options);
  const second = await saveAssistantSettings(f.store, settings(first.version, { enabled: true, model: 'new-model' }), f.session, options);
  assert.equal(await invalidateAssistantCredential(f.store, first.version), false);
  assert.equal((await getAssistantSettings(f.store)).enabled, true);
  assert.equal(await invalidateAssistantCredential(f.store, second.version), true);
  const invalid = await getAssistantSettings(f.store);
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.hasApiKey, true);
  assert.equal(invalid.connectionStatus, 'invalid');
  await assert.rejects(assertAssistantAccess(f.store, f.session, second.version), { code: 'ASSISTANT_CONFIG_CHANGED' });
  assert.ok(await assertAssistantSession(f.store, f.session), 'disabled assistants must still allow history/settings access');
});

test('session guards use write-user-session lock order and reject expiration', async () => {
  const order = [];
  const session = { user: { id: 'user' }, sessionTokenHash: 'a'.repeat(64), csrf: 'csrf' };
  const tx = { provider: 'supabase', t: value => value, lockWrites: async () => order.push('write'), db: { get: async (sql, args) => {
    assert.match(sql, /FOR UPDATE$/);
    if (sql.includes('FROM users')) { order.push('user'); return { id: args[0], active: 1 }; }
    order.push('session'); return { expires: Date.now() + 10000, csrf: 'csrf' };
  } } };
  await assertAssistantSession(tx, session, { lock: true });
  assert.deepEqual(order, ['write','user','session']);
  tx.db.get = async sql => sql.includes('FROM users') ? { active: 1 } : { expires: Date.now() - 1, csrf: 'csrf' };
  await assert.rejects(assertAssistantSession(tx, session, { lock: true }), { code: 'ASSISTANT_AUTH_REQUIRED' });
});

test('expiration immediately before settings commit rolls back configuration and idempotency', async t => {
  const f = await fixture(t), realTransaction = f.store.transaction.bind(f.store);
  const store = Object.create(f.store);
  let injected = false;
  store.transaction = fn => realTransaction(async tx => {
    const guarded = Object.create(tx), db = Object.create(tx.db);
    db.run = async (sql, args) => {
      const result = await tx.db.run(sql, args);
      if (sql.startsWith(`INSERT INTO ${tx.t('business_requests')}(`)) {
        await tx.db.run(`UPDATE ${tx.t('sessions')} SET expires=0 WHERE token_hash=?`, [f.session.sessionTokenHash]);
        injected = true;
      }
      return result;
    };
    guarded.db = db;
    return fn(guarded);
  });
  await assert.rejects(saveAssistantSettings(store, settings(0, { apiKey: 'key-a' }), f.session, { keyring: f.keyring }), { code: 'ASSISTANT_AUTH_REQUIRED' });
  assert.equal(injected, true, 'the expiry barrier must run after idempotency insertion and before the final session guard');
  assert.equal((await getAssistantSettings(f.store)).version, 0);
  assert.equal((await f.store.db.all("SELECT * FROM business_requests WHERE scope='assistant:settings'")).length, 0);
});

test('Responses carries reasoning and exact outputs locally with store:false and exact result IDs', async () => {
  const requests = [], reasoning = { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: 'opaque-reasoning' };
  const call = { type: 'function_call', call_id: 'call-1', name: 'read_business', arguments: '{"domain":"cash","query":"{}"}' };
  const replies = [
    { status: 'completed', output: [reasoning, call] },
    { status: 'completed', output: [{ type: 'function_call', call_id: 'finish-1', name: 'finish_turn', arguments: '{"payload":"{}"}' }] },
  ];
  const provider = createAssistantProvider({ provider: 'openai', model: 'synthetic', apiKey: 'key' }, { transport: async (url, request) => { assert.equal(url, 'https://api.openai.com/v1/responses'); requests.push(JSON.parse(request.body)); return replies.shift(); } });
  await provider.next({ context: { instructions: 'server instructions', userMessage: 'Saldo' }, tools: syntheticTools });
  await provider.next({ results: [{ callId: 'call-1', result: { amount: 20 } }], tools: syntheticTools });
  assert.equal(requests[1].store, false);
  assert.equal(requests[1].instructions, 'server instructions');
  assert.equal(requests[1].previous_response_id, undefined);
  assert.deepEqual(requests[1].input.slice(1), [reasoning, call, { type: 'function_call_output', call_id: 'call-1', output: '{"amount":20}' }]);
  await assert.rejects(provider.next({ results: [], tools: syntheticTools }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('provider rejects duplicate, unknown, mixed final and mismatched continuation calls', async () => {
  const runtime = { provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'synthetic', apiKey: 'key' };
  const call = (id, name = 'read_business') => ({ id, type: 'function', function: { name, arguments: '{}' } });
  for (const calls of [[call('same'), call('same')], [call('unknown','external_network')], [call('finish','finish_turn'),call('read')]]) {
    const provider = createAssistantProvider(runtime, { transport: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls } }] }) });
    await assert.rejects(provider.next({ context: { instructions: 'closed' }, tools: syntheticTools }), { code: 'ASSISTANT_UNAVAILABLE' });
  }
  let sends = 0;
  const provider = createAssistantProvider(runtime, { transport: async () => { sends++; return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [call('read')] } }] }; } });
  await provider.next({ context: { instructions: 'closed' }, tools: syntheticTools });
  await assert.rejects(provider.next({ results: [{ callId: 'wrong', result: {} }], tools: syntheticTools }), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal(sends, 1);
});

test('synthetic model switch changes tool workflow and gates allow deterministic in-flight races', async t => {
  const fixture = await syntheticFixture(t);
  async function run(model) {
    const provider = createAssistantProvider({ provider: 'openai-compatible', baseUrl: fixture.url, model, apiKey: fixture.key, allowPrivateNetwork: true }, { transport: localTransport });
    let response = await provider.next({ context: { userMessage: '¿Cuánto hay disponible en caja?' }, tools: syntheticTools });
    const names = [];
    while (!response.finished) {
      const call = response.calls[0]; names.push(call.name);
      response = await provider.next({ tools: syntheticTools, results: [{ callId: call.id, result: call.name === 'read_application' ? { taskId: 'cash', steps: [] } : { records: [], evidence: [] } }] });
    }
    names.push('finish_turn'); return names;
  }
  assert.deepEqual(await run('fixture-a'), ['read_business','finish_turn']);
  assert.deepEqual(await run('fixture-b'), ['read_application','read_business','finish_turn']);
  const gate = fixture.hold('fixture-a');
  const pending = run('fixture-a');
  await fixture.waitForGate(gate);
  // An authenticated control request observes the gate without unblocking it.
  const observed = await fetch(`${fixture.url.replace(/\/v1$/, '')}/__control`, { headers: { authorization: `Bearer ${fixture.key}` } }).then(res => res.json());
  assert.equal(observed.gates[0].id, gate);
  fixture.release(gate);
  assert.deepEqual(await pending, ['read_business','finish_turn']);
});

test('endpoint policy rejects metadata, reserved, rebinding answers and self-origin aliases', async () => {
  const options = { provider: 'openai-compatible', allowPrivateNetwork: true, env: {} };
  for (const address of ['169.254.169.254','100.100.100.200','168.63.129.16','0.0.0.0','224.0.0.1','192.0.2.1','::','fe80::1','ff02::1','fd00:ec2::254','::ffff:127.0.0.1']) {
    await assert.rejects(resolveAssistantEndpoint(`https://[${address}]/v1`.replace(`[${address}]`, address.includes(':') ? `[${address}]` : address), options), { code: 'ASSISTANT_UNAVAILABLE' });
  }
  await assert.rejects(resolveAssistantEndpoint('https://provider.example/v1', { ...options, lookup: async () => [{ address: '8.8.8.8', family: 4 },{ address: '169.254.169.254', family: 4 }] }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(resolveAssistantEndpoint('https://provider.example/v1', { ...options, env: { APP_URL: 'https://own.example' }, lookup: async () => [{ address: '10.0.0.3', family: 4 }] }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(resolveAssistantEndpoint('http://127.0.0.1:4444/v1', { ...options, env: { APP_URL: 'http://localhost:4444' } }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(resolveAssistantEndpoint('http://10.0.0.1/v1', options), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(resolveAssistantEndpoint('https://127.0.0.1/v1', { ...options, allowPrivateNetwork: false }), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal((await resolveAssistantEndpoint('https://10.0.0.1/v1', options)).addresses[0].address, '10.0.0.1');
});

test('transport pins each socket, bounds DNS and payloads, and honors cancellation', async t => {
  let requests = 0, lookups = 0;
  const server = http.createServer((req, res) => { requests++; if (req.url === '/big') res.end(JSON.stringify({ big: 'x'.repeat(2048) })); else res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://pinned.example:${server.address().port}`;
  const options = { provider: 'openai-compatible', allowPrivateNetwork: true, env: {}, apiKey: 'synthetic', body: '{}', lookup: async () => { lookups++; return [{ address: lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }]; } };
  assert.deepEqual(await assistantRequest(`${url}/ok`, options), {});
  assert.equal(lookups, 1, 'the socket must not perform a second DNS lookup');
  await assert.rejects(assistantRequest(`${url}/ok`, options), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal(requests, 1);
  await assert.rejects(assistantRequest(`${url}/ok`, { ...options, timeoutMs: 5, lookup: () => new Promise(() => {}) }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(assistantRequest(`${url}/ok`, { ...options, body: 'x'.repeat(1024 * 1024 + 1) }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(assistantRequest(`http://127.0.0.1:${server.address().port}/big`, { ...options, maxResponseBytes: 100 }), { code: 'ASSISTANT_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(assistantRequest(`${url}/ok`, { ...options, signal: controller.signal }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('disabled configuration drafts need no credential and origin changes cannot reuse a saved key', async t => {
  const f = await fixture(t);
  const draft = await saveAssistantSettings(f.store, settings(0, { model: '', baseUrl: '' }), f.session, { keyring: f.keyring });
  assert.equal(draft.enabled, false);
  assert.equal(draft.hasApiKey, false);
  await assert.rejects(saveAssistantSettings(f.store, settings(draft.version, { enabled: true }), f.session, { keyring: f.keyring }), { status: 422 });
  const keyed = await saveAssistantSettings(f.store, settings(draft.version, { apiKey: 'canary-key' }), f.session, { keyring: f.keyring });
  await assert.rejects(saveAssistantSettings(f.store, settings(keyed.version, { baseUrl: 'https://other.example/v1' }), f.session, { keyring: f.keyring }), { status: 409 });
  const sameOrigin = await saveAssistantSettings(f.store, settings(keyed.version, { baseUrl: 'https://provider.example/v2' }), f.session, { keyring: f.keyring });
  assert.equal(sameOrigin.hasApiKey, true);
});

test('transient and malformed verification failures do not disable the committed credential', async t => {
  const f = await fixture(t), server = await syntheticFixture(t);
  const options = { keyring: f.keyring, transport: localTransport };
  const first = await saveAssistantSettings(f.store, settings(0, { enabled: true, baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true }), f.session, options);
  for (const behavior of [{ status: 429 }, { status: 500 }, { malformed: true }]) {
    server.configure('fixture-b', behavior);
    await assert.rejects(saveAssistantSettings(f.store, settings(first.version, { enabled: true, baseUrl: server.url, model: 'fixture-b', allowPrivateNetwork: true }), f.session, options), { code: 'ASSISTANT_UNAVAILABLE' });
    const live = await getAssistantSettings(f.store);
    assert.equal(live.version, first.version);
    assert.equal(live.enabled, true);
    assert.equal(live.model, 'fixture-a');
  }
});

test('a held old provider rejection cannot invalidate a newly committed provider model', async t => {
  const f = await fixture(t), server = await syntheticFixture(t);
  const options = { keyring: f.keyring, transport: localTransport };
  const first = await saveAssistantSettings(f.store, settings(0, { enabled: true, baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true }), f.session, options);
  server.configure('fixture-a', { status: 401 });
  const gate = server.hold('fixture-a');
  const old = createAssistantProvider(await loadAssistantRuntime(f.store, { keyring: f.keyring }), { transport: localTransport });
  const pending = old.next({ context: { userMessage: 'Saldo de caja' }, tools: syntheticTools });
  const rejection = assert.rejects(pending, { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  await server.waitForGate(gate);
  const next = await saveAssistantSettings(f.store, settings(first.version, { enabled: true, baseUrl: server.url, model: 'fixture-b', allowPrivateNetwork: true }), f.session, options);
  server.release(gate);
  await rejection;
  assert.equal(await invalidateAssistantCredential(f.store, first.version), false);
  const runtime = await loadAssistantRuntime(f.store, { keyring: f.keyring });
  assert.equal(runtime.model, 'fixture-b');
  assert.equal(runtime.configurationVersion, next.version);
  assert.equal(runtime.enabled, true);
});

test('the fixture emits source-bound literal edits and closed finish selectors', async t => {
  const server = await syntheticFixture(t);
  const provider = createAssistantProvider({ provider: 'openai-compatible', baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true }, { transport: localTransport });
  const message = 'Actualiza la descripción a «Texto literal QA»';
  const tools = [...syntheticTools, { name: 'prepare_change', parameters: { type: 'object', properties: { target: { type: 'string' }, entityId: { type: ['string','null'] }, patch: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'object' } }, intent: { type: 'string' } }, required: ['target','entityId','patch','sourceRefs','intent'], additionalProperties: false } }];
  const first = await provider.next({ context: { turnId: 'synthetic-turn-id', userMessage: message, pageContext: { form: { target: 'record:products', entityId: 'synthetic-product-id', values: { description: 'Original' } } } }, tools });
  const call = first.calls[0];
  assert.equal(call.name, 'prepare_change');
  assert.equal(JSON.parse(call.arguments.patch).description, 'Texto literal QA');
  const [source] = call.arguments.sourceRefs;
  assert.equal(source.field, 'description');
  assert.equal(source.turnId, 'synthetic-turn-id');
  assert.equal(message.slice(source.start, source.end), 'Texto literal QA');
  const final = await provider.next({ results: [{ callId: call.id, result: { proposalId: 'synthetic-proposal-id' } }], tools });
  const output = JSON.parse(final.calls[0].arguments.payload);
  assert.deepEqual(output.blocks, [{ type: 'text', templateId: 'acknowledged', slots: {} }]);
  assert.equal(output.proposalId, 'synthetic-proposal-id');
});

test('provider never exceeds six network rounds or repeats a call identifier', async () => {
  let requests = 0;
  const runtime = { provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'synthetic', apiKey: 'key' };
  const provider = createAssistantProvider(runtime, { transport: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${++requests}`, type: 'function', function: { name: 'read_business', arguments: '{}' } }] } }] }) });
  let response = await provider.next({ context: { instructions: 'bounded' }, tools: syntheticTools });
  for (let round = 1; round < 6; round++) response = await provider.next({ results: [{ callId: response.calls[0].id, result: {} }], tools: syntheticTools });
  await assert.rejects(provider.next({ results: [{ callId: response.calls[0].id, result: {} }], tools: syntheticTools }), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal(requests, 6);
  let repeatedRequests = 0;
  const duplicate = createAssistantProvider(runtime, { transport: async () => { repeatedRequests++; return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'same-call', type: 'function', function: { name: 'read_business', arguments: '{}' } }] } }] }; } });
  const first = await duplicate.next({ context: { instructions: 'bounded' }, tools: syntheticTools });
  await assert.rejects(duplicate.next({ results: [{ callId: first.calls[0].id, result: {} }], tools: syntheticTools }), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal(repeatedRequests, 2);
});

test('fixture binds nested money and dates to the raw current source message without currency arithmetic', async t => {
  const server = await syntheticFixture(t);
  const runtime = { provider: 'openai-compatible', baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
  const tools = [...syntheticTools, { name: 'prepare_change', parameters: { type: 'object', properties: { target: { type: 'string' }, entityId: { type: ['string','null'] }, patch: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'object' } }, intent: { type: 'string' } }, required: ['target','entityId','patch','sourceRefs','intent'], additionalProperties: false } }];
  const sourceMessage = 'Completa 🧾 {"target":"order","patch":{"customerName":"Cliente QA","placedOn":"2026-11-10","shippingChargeMinor":"1.234,50","items":[{"unitPriceMinor":"50.000,00","discountMinor":0}],"notes":null}}';
  const provider = createAssistantProvider(runtime, { transport: localTransport });
  const response = await provider.next({ context: { turnId: 'economic-turn', sourceMessage, userMessage: 'Authenticated wrapper unrelated to raw offsets' }, tools });
  const prepared = response.calls[0];
  assert.equal(prepared.name, 'prepare_change');
  const patch = JSON.parse(prepared.arguments.patch);
  assert.equal(patch.shippingChargeMinor, '1.234,50');
  assert.equal(patch.items[0].unitPriceMinor, '50.000,00');
  assert.equal(patch.items[0].discountMinor, '0');
  assert.equal(patch.notes, null);
  for (const [field, literal] of [['placedOn','2026-11-10'],['shippingChargeMinor','1.234,50'],['items.0.unitPriceMinor','50.000,00'],['items.0.discountMinor','0']]) {
    const ref = prepared.arguments.sourceRefs.find(item => item.field === field);
    assert.equal(ref.turnId, 'economic-turn');
    assert.equal(sourceMessage.slice(ref.start, ref.end), literal);
  }
  const missing = createAssistantProvider(runtime, { transport: localTransport });
  const question = await missing.next({ context: { sourceMessage, userMessage: 'Same data but no authenticated turn source' }, tools });
  assert.equal(question.calls[0].name, 'finish_turn');
  assert.deepEqual(JSON.parse(question.calls[0].arguments.payload).question, { kind: 'missing_field', target: 'order', field: 'placedOn' });
});

test('fixture resumes an order question using only server-allowed earlier literal sources', async t => {
  const server = await syntheticFixture(t);
  const runtime = { provider: 'openai-compatible', baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
  const tools = [...syntheticTools, { name: 'prepare_change', parameters: { type: 'object', properties: { target: { type: 'string' }, entityId: { type: ['string','null'] }, patch: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'object' } }, intent: { type: 'string' } }, required: ['target','entityId','patch','sourceRefs','intent'], additionalProperties: false } }];
  const originalMessage = 'Crea pedido 🧾 {"target":"order","patch":{"placedOn":"2026-11-10","shippingChargeMinor":"1.234,50","items":[{"itemId":"real-product","kind":"products","quantity":1,"unitPriceMinor":"50.000,00","discountMinor":0}],"notes":null}}';
  const initial = createAssistantProvider(runtime, { transport: localTransport });
  const question = await initial.next({ context: { turnId: 'original-turn', sourceMessage: originalMessage, userMessage: originalMessage }, tools });
  assert.deepEqual(JSON.parse(question.calls[0].arguments.payload).question, { kind: 'missing_field', target: 'order', field: 'customerName' });
  const sourceMessage = 'Cliente Continuidad QA';
  const context = {
    turnId: 'answer-turn', sourceMessage, userMessage: `Respuesta a «Nombre del cliente»: ${sourceMessage}`,
    answer: { questionId: 'server-question', kind: 'missing_field', target: 'order', field: 'customerName', value: sourceMessage },
    allowedInputTurnIds: ['original-turn'],
    turns: [
      { turnId: 'original-turn', message: originalMessage },
      { turnId: 'unrelated-turn', message: '{"target":"order","patch":{"placedOn":"1999-01-01","shippingChargeMinor":"999.999,00"}}' },
    ],
  };
  const continuation = createAssistantProvider(runtime, { transport: localTransport });
  const response = await continuation.next({ context, tools });
  const prepared = response.calls[0];
  assert.equal(prepared.name, 'prepare_change');
  const patch = JSON.parse(prepared.arguments.patch);
  assert.equal(patch.customerName, sourceMessage);
  assert.equal(patch.shippingChargeMinor, '1.234,50');
  assert.equal(patch.items[0].unitPriceMinor, '50.000,00');
  assert.equal(patch.items[0].discountMinor, '0');
  assert.equal(patch.notes, null);
  for (const [field, literal] of [['placedOn','2026-11-10'],['shippingChargeMinor','1.234,50'],['items.0.unitPriceMinor','50.000,00'],['items.0.discountMinor','0']]) {
    const ref = prepared.arguments.sourceRefs.find(item => item.field === field);
    assert.equal(ref.turnId, 'original-turn');
    assert.equal(originalMessage.slice(ref.start, ref.end), literal);
  }
  const nameRef = prepared.arguments.sourceRefs.find(item => item.field === 'customerName');
  assert.equal(nameRef.turnId, 'answer-turn');
  assert.equal(sourceMessage.slice(nameRef.start, nameRef.end), patch.customerName);
  assert.equal(prepared.arguments.intent, 'prefill', 'historical inputs never request automatic authorization');
  const finished = await continuation.next({ results: [{ callId: prepared.id, result: { proposalId: 'confirmed-order-draft' } }], tools });
  const final = JSON.parse(finished.calls[0].arguments.payload);
  assert.equal(final.topic, 'orders');
  assert.equal(final.proposalId, 'confirmed-order-draft');
  for (const allowedInputTurnIds of [[], ['another-thread-turn']]) {
    const denied = createAssistantProvider(runtime, { transport: localTransport });
    const rejected = await denied.next({ context: { ...context, turns: context.turns.slice(0,1), allowedInputTurnIds }, tools });
    assert.equal(rejected.calls[0].name, 'finish_turn');
    assert.deepEqual(JSON.parse(rejected.calls[0].arguments.payload).question, { kind: 'missing_field', target: 'order', field: 'placedOn' });
  }
  const forgedAnswer = createAssistantProvider(runtime, { transport: localTransport });
  const forged = await forgedAnswer.next({ context: { ...context, answer: null }, tools });
  assert.equal(forged.calls[0].name, 'finish_turn');
  assert.equal(JSON.parse(forged.calls[0].arguments.payload).question.kind, 'missing_field');
});

test('fixture uses shared economic classification for salary agreement validity dates', async t => {
  const server = await syntheticFixture(t);
  const runtime = { provider: 'openai-compatible', baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
  const tools = [...syntheticTools, { name: 'prepare_change', parameters: { type: 'object', properties: { target: { type: 'string' }, entityId: { type: ['string','null'] }, patch: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'object' } }, intent: { type: 'string' } }, required: ['target','entityId','patch','sourceRefs','intent'], additionalProperties: false } }];
  const sourceMessage = '{"target":"settings:person","entityId":"person-qa","patch":{"salaryAgreements":[{"id":"existing-salary-row","amountPerPeriodMinor":"1.500.000,00","effectiveFrom":"2026-11-01","effectiveTo":"2026-11-30"}]}}';
  const provider = createAssistantProvider(runtime, { transport: localTransport });
  const response = await provider.next({ context: { turnId: 'salary-source-turn', sourceMessage, userMessage: sourceMessage }, tools });
  const call = response.calls[0];
  assert.equal(call.name, 'prepare_change');
  for (const [field, literal] of [['salaryAgreements.0.amountPerPeriodMinor','1.500.000,00'],['salaryAgreements.0.effectiveFrom','2026-11-01'],['salaryAgreements.0.effectiveTo','2026-11-30']]) {
    const ref = call.arguments.sourceRefs.find(item => item.field === field);
    assert.equal(ref.turnId, 'salary-source-turn');
    assert.equal(sourceMessage.slice(ref.start, ref.end), literal);
  }
  assert.equal(call.arguments.sourceRefs.some(ref => ref.field === 'salaryAgreements.0.id'), false);
});

test('fixture selects recommendations from real report evidence and supports natural recommendation requests', async t => {
  const f = await fixture(t), server = await syntheticFixture(t);
  await createBusinessFixture(f.store, { actorId: f.user.id, year: 2026, reportsStartOn: '2026-09-01' });
  const query = { period: 'month', anchor: '2026-09-01', filters: {} };
  const read = await readAssistantBusiness(f.store, f.session, { domain: 'recommendations', query });
  assert.ok(read.records.some(record => record.evidenceIds?.length && record.href && record.reason), 'synthetic transport costs exceeding the recorded shipping charge must yield a real business insight');
  const runtime = { provider: 'openai-compatible', baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
  for (const prompt of ['Recomienda mejoras en caja', 'Recomiéndame mejoras del negocio', 'Consulta recomendaciones del negocio']) {
    const provider = createAssistantProvider(runtime, { transport: localTransport });
    const message = `${prompt} ${JSON.stringify({ query })}`;
    const first = await provider.next({ context: { userMessage: message, sourceMessage: message }, tools: syntheticTools });
    const call = first.calls[0];
    assert.equal(call.name, 'read_business');
    assert.equal(call.arguments.domain, 'recommendations');
    assert.deepEqual(JSON.parse(call.arguments.query), query);
    const finished = await provider.next({ results: [{ callId: call.id, result: read }], tools: syntheticTools });
    const selected = JSON.parse(finished.calls[0].arguments.payload);
    const block = selected.blocks.find(item => item.type === 'recommendation');
    assert.ok(block);
    const actual = read.records.find(item => item.id === block.recommendationId);
    assert.ok(actual);
    const resolved = resolveAssistantModelResult(selected, { evidence: new Map(read.evidence.map(item => [item.id, item])), recommendations: new Map(read.records.map(item => [item.id, item])), guides: new Map(), message });
    assert.deepEqual(resolved.blocks[0], { type: 'recommendation', id: actual.id, title: actual.title, reason: actual.reason, actionLabel: actual.actionLabel, href: actual.href, evidenceIds: actual.evidenceIds });
  }
  const noEvidence = createAssistantProvider(runtime, { transport: localTransport });
  const first = await noEvidence.next({ context: { userMessage: 'Recomiéndame mejoras' }, tools: syntheticTools });
  const finished = await noEvidence.next({ results: [{ callId: first.calls[0].id, result: { records: [], evidence: [] } }], tools: syntheticTools });
  assert.deepEqual(JSON.parse(finished.calls[0].arguments.payload).blocks, [{ type: 'text', templateId: 'missing_data', slots: {} }]);
});

test('initial wire sizing includes tools and Unicode escaping before oldest full turns are trimmed', async t => {
  const server = await syntheticFixture(t);
  const tools = syntheticTools.map(tool => ({ ...tool, description: `${tool.name}: ${'Guía de consulta 🧾 y parámetros "exactos". '.repeat(120)}` }));
  for (const protocol of ['openai-compatible', 'openai']) {
    const runtime = { provider: protocol, baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
    const context = {
      instructions: 'Solo datos comprobados 🧾',
      userMessage: '¿Cuánto hay disponible en caja?',
      pendingQuestion: { id: 'keep-pending-question', prompt: 'Dato todavía pendiente' },
      memory: { goal: 'Mantener la tarea y su pregunta' },
      turns: Array.from({ length: 20 }, (_, index) => ({ turnId: `historic-${index}`, message: `Turno ${index}: ${'🧾"\\\n'.repeat(1000)}` })),
    };
    const original = structuredClone(context), pending = context.pendingQuestion;
    const bytesBefore = assistantProviderContextBytes(runtime, context, tools);
    assert.ok(bytesBefore > 96 * 1024);
    assert.deepEqual(context, original, 'the sizing helper must not mutate caller memory');
    const before = server.requests.length;
    const oversized = createAssistantProvider(runtime, { transport: async () => { assert.fail('an oversized initial request must never reach transport'); } });
    await assert.rejects(oversized.next({ context, tools }), error => error.code === 'ASSISTANT_UNAVAILABLE' && error.contextLimit === true);
    assert.equal(server.requests.length, before);
    while (context.turns.length && assistantProviderContextBytes(runtime, context, tools) > 96 * 1024) context.turns.shift();
    assert.ok(context.turns.length > 0 && context.turns.length < original.turns.length);
    assert.equal(context.pendingQuestion, pending);
    assert.deepEqual(context.turns, original.turns.slice(-context.turns.length));
    let deliveredBytes;
    const provider = createAssistantProvider(runtime, { transport: async (url, request) => {
      deliveredBytes = Buffer.byteLength(request.body, 'utf8');
      assert.equal(deliveredBytes, assistantProviderContextBytes(runtime, context, tools));
      assert.equal(request.body.includes(server.key), false);
      // Responses retains its official runtime destination. Only this test's
      // injected transport maps the protocol onto our authenticated local socket.
      if (protocol === 'openai') {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        return localTransport(`${server.url}/responses`, { ...request, provider: 'openai-compatible', allowPrivateNetwork: true });
      }
      return localTransport(url, request);
    } });
    const first = await provider.next({ context, tools });
    assert.equal(first.calls[0].name, 'read_business');
    assert.ok(deliveredBytes <= 96 * 1024);
    assert.equal(Buffer.byteLength(JSON.stringify(server.requests.at(-1).body), 'utf8'), deliveredBytes);
  }
});

test('continuation prunes only oldest full history turns while preserving current tool outputs and reasoning', async t => {
  const server = await syntheticFixture(t);
  for (const protocol of ['openai-compatible', 'openai']) {
    const runtime = { provider: protocol, baseUrl: server.url, model: 'fixture-a', apiKey: server.key, allowPrivateNetwork: true };
    const context = {
      instructions: 'No omitas preguntas ni resultados de herramientas.',
      userMessage: '¿Cuánto hay disponible en caja?',
      pendingQuestion: { id: 'pending-current', prompt: 'Pregunta que debe conservarse' },
      memory: { goal: 'Trabajo actual', confirmedInputs: [{ value: 'Entrada explícita' }] },
      turns: Array.from({ length: 20 }, (_, index) => ({ turnId: `old-${index}`, message: `${index}: ${'🧾"\\\n'.repeat(700)}` })),
    };
    while (assistantProviderContextBytes(runtime, context, syntheticTools) > 88 * 1024) context.turns.shift();
    assert.ok(context.turns.length);
    const baseline = structuredClone(context), sent = [];
    const provider = createAssistantProvider(runtime, { transport: async (url, request) => {
      assert.ok(Buffer.byteLength(request.body, 'utf8') <= 96 * 1024);
      sent.push(JSON.parse(request.body));
      return protocol === 'openai'
        ? localTransport(`${server.url}/responses`, { ...request, provider: 'openai-compatible', allowPrivateNetwork: true })
        : localTransport(url, request);
    } });
    const first = await provider.next({ context, tools: syntheticTools });
    const call = first.calls[0], result = { records: [], evidence: [], summary: { boundedToolDetail: '🧾'.repeat(6000) } };
    const finished = await provider.next({ results: [{ callId: call.id, result }], tools: syntheticTools });
    assert.equal(finished.finished, true);
    assert.equal(sent.length, 2, 'history trimming must happen before sending, not by retrying network calls');
    assert.deepEqual(context, baseline, 'provider-owned history trimming must not mutate caller context');
    const body = sent[1];
    const retained = JSON.parse(protocol === 'openai' ? body.input[0].content : body.messages[1].content);
    assert.ok(retained.turns.length < baseline.turns.length);
    assert.deepEqual(retained.turns, baseline.turns.slice(baseline.turns.length - retained.turns.length));
    assert.deepEqual(retained.pendingQuestion, baseline.pendingQuestion);
    assert.deepEqual(retained.memory, baseline.memory);
    assert.equal(retained.userMessage, baseline.userMessage);
    if (protocol === 'openai') {
      const output = body.input.find(item => item.type === 'function_call_output');
      assert.equal(output.call_id, call.id);
      assert.equal(output.output, JSON.stringify(result));
      assert.ok(body.input.some(item => item.type === 'function_call' && item.call_id === call.id));
      assert.ok(body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'synthetic-fixture-a'));
    } else {
      const output = body.messages.find(item => item.role === 'tool');
      assert.equal(output.tool_call_id, call.id);
      assert.equal(output.content, JSON.stringify(result));
      assert.ok(body.messages.some(item => item.role === 'assistant' && item.tool_calls.some(item => item.id === call.id)));
    }
  }
});
