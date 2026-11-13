import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { assistantRequest, resolveAssistantEndpoint } from '../lib/assistant/http.mjs';
import { assistantProviderContextBytes, createAssistantProvider, verifyAssistantProvider } from '../lib/assistant/provider.mjs';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const runtime = { provider: 'gemini', model: 'gemini-2.5-flash', authMethod: 'api-key', apiKey: 'synthetic-key' };
const oauth = { provider: 'gemini', model: runtime.model, authMethod: 'oauth', accessToken: 'synthetic-access', projectId: 'ali-project-123' };
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const context = { instructions: 'Usa herramientas y solo hechos verificados.', userMessage: 'Consulta el negocio.' };
const tools = [
  { name: 'read_business', parameters: { type: 'object', properties: { domain: { type: 'string', enum: ['cash', 'orders'] } }, required: ['domain'], additionalProperties: false } },
  { name: 'read_application', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'prepare_change', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'finish_turn', parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'], additionalProperties: false } },
];
const call = (name, args, id) => ({ functionCall: { name, args, ...(id == null ? {} : { id }) } });
const reply = parts => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
const finish = () => reply([call('finish_turn', { payload: '{}' })]);

// Exercise the real HTTP policy/header/parser path without opening a socket.
// DNS is independently fixed and the socket seam still receives its pinned lookup.
function wire({ status = 200, value = {}, raw, onRequest = () => {} } = {}) {
  return (url, options, receive) => {
    const request = new EventEmitter();
    request.destroy = () => request;
    request.end = body => {
      onRequest(url, options, body);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = status;
        receive(response);
        response.end(raw ?? JSON.stringify(value));
      });
    };
    return request;
  };
}
const send = (credentials, options = {}) => assistantRequest(endpoint, { ...credentials, body: '{}', env: {}, lookup: publicLookup, requestImpl: wire(), ...options });

test('Gemini uses mutually exclusive native APIKey and OAuth headers with a pinned TLS socket', async () => {
  for (const credentials of [runtime, oauth]) {
    let requests = 0, lookups = 0;
    await send(credentials, {
      lookup: async () => { lookups++; return publicLookup(); },
      requestImpl: wire({ onRequest: (url, options, body) => {
        requests++;
        assert.equal(url.href, endpoint);
        assert.equal(options.servername, 'generativelanguage.googleapis.com');
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.agent, false);
        assert.equal(body, '{}');
        options.lookup('generativelanguage.googleapis.com', { all: true }, (error, addresses) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
        });
        if (credentials.authMethod === 'oauth') {
          assert.equal(options.headers.authorization, 'Bearer synthetic-access');
          assert.equal(options.headers['x-goog-user-project'], 'ali-project-123');
          assert.equal(options.headers['x-goog-api-key'], undefined);
        } else {
          assert.equal(options.headers['x-goog-api-key'], 'synthetic-key');
          assert.equal(options.headers.authorization, undefined);
          assert.equal(options.headers['x-goog-user-project'], undefined);
        }
      } }),
    });
    assert.equal(requests, 1);
    assert.equal(lookups, 1);
  }
});

test('Gemini fences the exact official host and generateContent path before DNS or credentials reach a socket', async () => {
  let sockets = 0, lookups = 0;
  const options = { ...oauth, body: '{}', env: {}, allowPrivateNetwork: true, lookup: async () => { lookups++; return publicLookup(); }, requestImpl: wire({ onRequest: () => { sockets++; } }) };
  for (const url of [
    'https://attacker.example/v1beta/models/gemini-2.5-flash:generateContent',
    endpoint.replace('googleapis.com', 'googleapis.com.attacker.example'),
    endpoint.replace('https:', 'http:'), endpoint.replace('.com/', '.com:444/'),
    `${endpoint}?key=secret`, `${endpoint}#fragment`, endpoint.replace('https://', 'https://user:pass@'),
    endpoint.replace(':generateContent', ':streamGenerateContent'),
    endpoint.replace('gemini-2.5-flash', '%2e%2e'), endpoint.replace('/models/', '/private/../models/'),
    endpoint.replace('gemini-2.5-flash', 'gemini%2fother'),
  ]) await assert.rejects(assistantRequest(url, options), { code: 'ASSISTANT_UNAVAILABLE' });
  assert.equal(sockets, 0);
  assert.equal(lookups, 0);
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '168.63.129.16']) {
    await assert.rejects(resolveAssistantEndpoint(endpoint, { ...options, lookup: async () => [{ address, family: 4 }] }), { code: 'ASSISTANT_UNAVAILABLE' });
  }
  await assert.rejects(resolveAssistantEndpoint(endpoint, { ...options, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('Gemini refuses missing, mixed and header-injection credentials before opening a socket', async () => {
  let sockets = 0;
  for (const credentials of [
    { ...oauth, projectId: undefined }, { ...oauth, projectId: 'invalid/project' }, { ...oauth, projectId: 'ali-project\n' },
    { ...oauth, apiKey: 'also-a-key' }, { ...oauth, accessToken: '' },
    { ...oauth, accessToken: 'bad\r\nheader' }, { ...oauth, accessToken: 'x'.repeat(8193) },
    { ...runtime, apiKey: undefined }, { ...runtime, accessToken: 'also-a-token' },
    { ...runtime, authMethod: 'unknown' },
  ]) await assert.rejects(send(credentials, { requestImpl: wire({ onRequest: () => { sockets++; } }) }), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
  assert.equal(sockets, 0);
  assert.deepEqual(await send({ ...oauth, projectId: '123456789012' }), {});
  assert.deepEqual(await send({ ...oauth, accessToken: 'x'.repeat(8192) }), {});
});

test('Gemini denied access is sanitized and transport response, redirects and time limits remain bounded', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(send(oauth, { requestImpl: wire({ status, raw: 'synthetic-access provider diagnostic' }) }), error => error.code === 'ASSISTANT_CREDENTIAL_INVALID' && !error.message.includes('synthetic-access') && !error.message.includes('diagnostic'));
  }
  for (const status of [302, 400, 429, 500]) await assert.rejects(send(runtime, { requestImpl: wire({ status }) }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(send(oauth, { requestImpl: wire({ raw: 'not-json' }) }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(send(oauth, { requestImpl: wire({ value: { large: 'x'.repeat(256) } }), maxResponseBytes: 32 }), { code: 'ASSISTANT_UNAVAILABLE' });
  await assert.rejects(send(oauth, { lookup: () => new Promise(() => {}), timeoutMs: 5 }), { code: 'ASSISTANT_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(send(oauth, { signal: controller.signal }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('Gemini performs actual native multi-round calls and preserves complete signed model contents', async () => {
  const firstContent = { role: 'model', parts: [
    { text: 'Razono sobre los datos.', thought: true, thoughtSignature: 'signed-thought' },
    { ...call('read_business', { domain: 'cash' }), thoughtSignature: 'signed-first-call' },
    call('read_application', { taskId: 'cash-review' }, 'native-application'),
    { text: 'Revisaré ambas fuentes.', thoughtSignature: 'signed-trailing-text' },
  ] };
  const secondContent = { role: 'model', parts: [{ ...call('read_business', { domain: 'orders' }), thoughtSignature: 'signed-round-two' }] };
  const responses = [{ candidates: [{ finishReason: 'STOP', content: firstContent }] }, { candidates: [{ finishReason: 'STOP', content: secondContent }] }, finish()];
  const sent = [];
  const provider = createAssistantProvider({ ...oauth, baseUrl: 'https://attacker.example/private' }, { transport: async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.apiKey, undefined);
    assert.equal(options.accessToken, 'synthetic-access');
    assert.equal(options.projectId, 'ali-project-123');
    sent.push(JSON.parse(options.body));
    return assistantRequest(url, { ...options, env: {}, lookup: publicLookup, requestImpl: wire({ value: responses.shift() }) });
  } });
  const first = await provider.next({ context, tools });
  assert.equal(first.calls.length, 2);
  assert.equal(first.calls[1].id, 'native-application');
  assert.deepEqual(first.calls[0].arguments, { domain: 'cash' });
  assert.deepEqual(sent[0].systemInstruction, { parts: [{ text: context.instructions }] });
  assert.deepEqual(sent[0].contents, [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }]);
  assert.deepEqual(sent[0].toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(sent[0].tools[0].functionDeclarations[0].parametersJsonSchema, tools[0].parameters);
  assert.equal(sent[0].tools[0].functionDeclarations[0].parameters, undefined);
  const second = await provider.next({ tools, results: [
    { callId: first.calls[1].id, name: 'read_application', result: { task: 'cash-review' } },
    { callId: first.calls[0].id, name: 'read_business', result: { amount: 100 } },
  ] });
  assert.notEqual(second.calls[0].id, first.calls[0].id);
  assert.deepEqual(sent[1].contents[1], firstContent);
  assert.deepEqual(sent[1].contents[2], { role: 'user', parts: [
    { functionResponse: { name: 'read_business', response: { amount: 100 } } },
    { functionResponse: { name: 'read_application', id: 'native-application', response: { task: 'cash-review' } } },
  ] });
  const last = await provider.next({ tools, results: [{ callId: second.calls[0].id, result: { orders: [] } }] });
  assert.equal(last.finished, true);
  assert.deepEqual(sent[2].contents[1], firstContent);
  assert.deepEqual(sent[2].contents[3], secondContent);
  assert.deepEqual(sent[2].contents[4], { role: 'user', parts: [{ functionResponse: { name: 'read_business', response: { orders: [] } } }] });
  await assert.rejects(provider.next({ tools, results: [] }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('Gemini validates model names locally and never accepts user-controlled endpoints', async () => {
  let requests = 0;
  for (const model of ['', '../secret', 'models/gemini', 'gemini?key=x', 'gemini:other', 'gemini%2fother', 'gemini\n', 'x'.repeat(129), null]) {
    const candidate = createAssistantProvider({ ...runtime, model }, { transport: async () => { requests++; return finish(); } });
    await assert.rejects(candidate.next({ context, tools }), { code: 'ASSISTANT_MODEL_UNSUPPORTED' });
  }
  assert.equal(requests, 0);
});

test('Gemini rejects unsupported output and malformed, unknown, duplicate and mixed tool calls', async () => {
  const malformed = [
    {}, { candidates: [] }, { candidates: [reply([]).candidates[0], reply([]).candidates[0]] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [call('read_business', { domain: 'cash' })] } }] },
    { candidates: [{ finishReason: 'STOP', content: { role: 'user', parts: [call('read_business', { domain: 'cash' })] } }] },
    reply([null]), reply([{ functionCall: null }]), reply([{ functionCall: { name: 'read_business', args: 'not-an-object' } }]),
    reply([call('read_business', { domain: 'cash' }, '')]),
    reply([call('external_network', {})]), reply([call('read_business', { domain: 'unknown' })]),
    reply([call('read_business', { domain: 'cash', unexpected: true })]), reply([call('read_business', {})]),
    reply([call('read_business', { domain: 'cash' }, 'same'), call('read_application', { taskId: 'cash' }, 'same')]),
    reply([call('finish_turn', { payload: '{}' }), call('read_business', { domain: 'cash' })]),
    reply([call('prepare_change', {}), call('read_business', { domain: 'cash' })]),
  ];
  for (const value of malformed) {
    const provider = createAssistantProvider(runtime, { transport: async () => value });
    await assert.rejects(provider.next({ context, tools }), { code: 'ASSISTANT_UNAVAILABLE' });
  }
  for (const value of [reply([]), reply([{ text: 'Plain text is not an Ali result.' }]), reply([{ executableCode: { code: 'unsafe' } }])]) {
    const provider = createAssistantProvider(runtime, { transport: async () => value });
    await assert.rejects(provider.next({ context, tools }), { code: 'ASSISTANT_MODEL_UNSUPPORTED' });
  }
});

test('Gemini locally validates const, nullable unions and local JSON Schema refs without rewriting declarations', async () => {
  const schema = { type: 'object', $defs: { source: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, properties: { ok: { type: 'boolean', const: true }, sources: { type: 'array', items: { $ref: '#/$defs/source' } } }, required: ['ok', 'sources'], additionalProperties: false };
  const schemaTools = [{ name: 'inspect_sources', parameters: schema }];
  for (const [args, valid] of [[{ ok: true, sources: ['source', null] }, true], [{ ok: false, sources: [] }, false], [{ ok: true, sources: [42] }, false]]) {
    const provider = createAssistantProvider(runtime, { transport: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).tools[0].functionDeclarations[0].parametersJsonSchema, schema);
      return reply([call('inspect_sources', args)]);
    } });
    if (valid) assert.deepEqual((await provider.next({ context, tools: schemaTools })).calls[0].arguments, args);
    else await assert.rejects(provider.next({ context, tools: schemaTools }), { code: 'ASSISTANT_UNAVAILABLE' });
  }
});

test('Gemini connection verification forces exactly assistant_connection_check and requires its exact result', async () => {
  for (const credentials of [runtime, oauth]) {
    let requests = 0, guards = 0;
    assert.equal(await verifyAssistantProvider(credentials, { beforeRequest: async () => { guards++; }, transport: async (url, options) => {
      requests++;
      assert.equal(url, endpoint);
      const body = JSON.parse(options.body);
      assert.equal(body.tool_choice, undefined);
      assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['assistant_connection_check'] } });
      assert.equal(body.tools[0].functionDeclarations.length, 1);
      return reply([call('assistant_connection_check', { ok: true })]);
    } }), true);
    assert.equal(requests, 1, 'native Google verification must not send an anonymous key probe');
    assert.equal(guards, 2);
  }
  for (const parts of [[call('assistant_connection_check', { ok: true }), call('assistant_connection_check', { ok: true })], [{ text: 'connected' }]]) {
    await assert.rejects(verifyAssistantProvider(runtime, { transport: async () => reply(parts) }), { code: 'ASSISTANT_MODEL_UNSUPPORTED' });
  }
  for (const parts of [[call('assistant_connection_check', { ok: false })], [call('assistant_connection_check', { ok: true, extra: true })], [call('another_check', { ok: true })]]) {
    await assert.rejects(verifyAssistantProvider(runtime, { transport: async () => reply(parts) }), { code: 'ASSISTANT_UNAVAILABLE' });
  }
});

test('Gemini rejects mismatched continuation IDs or names and repeated native IDs', async () => {
  for (const result of [{ callId: 'wrong', result: {} }, { callId: 'native-id', name: 'read_application', result: {} }, { callId: 'native-id', result: [] }]) {
    let sends = 0;
    const provider = createAssistantProvider(runtime, { transport: async () => { sends++; return reply([call('read_business', { domain: 'cash' }, 'native-id')]); } });
    await provider.next({ context, tools });
    await assert.rejects(provider.next({ tools, results: [result] }), { code: 'ASSISTANT_UNAVAILABLE' });
    assert.equal(sends, 1);
  }
  const provider = createAssistantProvider(runtime, { transport: async () => reply([call('read_business', { domain: 'cash' }, 'native-id')]) });
  await provider.next({ context, tools });
  await assert.rejects(provider.next({ tools, results: [{ callId: 'native-id', result: {} }] }), { code: 'ASSISTANT_UNAVAILABLE' });
});

test('Gemini context sizing and continuation pruning preserve signed parts and current tool outputs', async () => {
  const initial = { ...context, turns: Array.from({ length: 14 }, (_, index) => ({ turnId: `old-${index}`, message: '🧾'.repeat(1800) })) };
  while (assistantProviderContextBytes(runtime, initial, tools) > 88 * 1024) initial.turns.shift();
  assert.ok(initial.turns.length);
  const baseline = structuredClone(initial), sent = [];
  const signed = { role: 'model', parts: [{ ...call('read_business', { domain: 'cash' }), thoughtSignature: 'retained-signature' }] };
  const provider = createAssistantProvider(runtime, { transport: async (_url, options) => {
    assert.ok(Buffer.byteLength(options.body) <= 96 * 1024);
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? { candidates: [{ finishReason: 'STOP', content: signed }] } : finish();
  } });
  const first = await provider.next({ context: initial, tools });
  assert.equal(assistantProviderContextBytes(runtime, initial, tools), Buffer.byteLength(JSON.stringify(sent[0])));
  const result = { detail: '🧾'.repeat(6000) };
  await provider.next({ tools, results: [{ callId: first.calls[0].id, result }] });
  const retained = JSON.parse(sent[1].contents[0].parts[0].text);
  assert.ok(retained.turns.length < baseline.turns.length);
  assert.deepEqual(retained.turns, baseline.turns.slice(baseline.turns.length - retained.turns.length));
  assert.deepEqual(initial, baseline);
  assert.deepEqual(sent[1].contents[1], signed);
  assert.deepEqual(sent[1].contents[2].parts[0].functionResponse.response, result);
});

test('existing OpenAI and compatible keys remain Bearer headers and compatible verification keeps the anonymous probe', async () => {
  for (const [provider, url] of [['openai', 'https://api.openai.com/v1/responses'], ['openai-compatible', 'https://provider.example/chat/completions']]) {
    await assistantRequest(url, { provider, apiKey: 'existing-key', body: '{}', env: {}, lookup: publicLookup, requestImpl: wire({ onRequest: (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer existing-key');
      assert.equal(options.headers['x-goog-api-key'], undefined);
      assert.equal(options.headers['x-goog-user-project'], undefined);
    } }) });
  }
  const sent = [];
  assert.equal(await verifyAssistantProvider({ provider: 'openai-compatible', baseUrl: 'https://provider.example/v1', model: 'synthetic', apiKey: 'existing-key' }, { transport: async (_url, options) => {
    sent.push(options);
    if (!options.apiKey) throw Object.assign(new Error('denied'), { code: 'ASSISTANT_CREDENTIAL_INVALID' });
    return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'check', function: { name: 'assistant_connection_check', arguments: '{"ok":true}' } }] } }] };
  } }), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].apiKey, 'existing-key');
  assert.equal(sent[1].apiKey, undefined);
});
