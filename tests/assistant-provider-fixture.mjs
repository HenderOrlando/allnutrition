import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assistantEconomicFieldKind } from '../lib/assistant/forms.mjs';

const FIXTURE_KEY = 'assistant-fixture-only';
const MODELS = new Set(['fixture-a', 'fixture-b']);
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const authorized = (req, key) => {
  const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

function jsonSourceFields(message) {
  const start = message.indexOf('{'), end = message.lastIndexOf('}');
  if (start < 0 || end < start) return [];
  const json = message.slice(start, end + 1);
  if (!parse(json)) return [];
  const tokens = [...json.matchAll(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g)];
  const fields = []; let cursor = 0;
  function visit(path) {
    const token = tokens[cursor++];
    if (!token) return;
    if (token[0] === '{') {
      while (tokens[cursor]?.[0] !== '}') {
        const key = parse(tokens[cursor++]?.[0]);
        cursor++; visit([...path, key]);
        if (tokens[cursor]?.[0] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    if (token[0] === '[') {
      let index = 0;
      while (tokens[cursor]?.[0] !== ']') {
        visit([...path, index++]);
        if (tokens[cursor]?.[0] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    const quoted = token[0].startsWith('"');
    fields.push({ path, value: parse(token[0]), start: start + token.index + (quoted ? 1 : 0), end: start + token.index + token[0].length - (quoted ? 1 : 0) });
  }
  visit([]); return fields;
}
function contextFrom(body, responses) {
  const messages = responses ? body.input : body.messages;
  if (typeof messages === 'string') return parse(messages) || {};
  for (const message of messages || []) {
    if (message.role !== 'user') continue;
    const context = parse(message.content);
    if (context?.userMessage || context?.instructions) return context;
  }
  return {};
}
function toolHistory(body, responses) {
  if (responses) {
    const calls = new Map((body.input || []).filter(item => item.type === 'function_call').map(item => [item.call_id, item]));
    return (body.input || []).filter(item => item.type === 'function_call_output').map(item => ({ name: calls.get(item.call_id)?.name, args: parse(calls.get(item.call_id)?.arguments), result: parse(item.output) }));
  }
  const calls = new Map((body.messages || []).flatMap(item => item.tool_calls || []).map(item => [item.id, item.function]));
  return (body.messages || []).filter(item => item.role === 'tool').map(item => ({ name: calls.get(item.tool_call_id)?.name, args: parse(calls.get(item.tool_call_id)?.arguments), result: parse(item.content) }));
}
function workflow(body, responses) {
  const context = contextFrom(body, responses), history = toolHistory(body, responses);
  const tools = new Map((body.tools || []).map(tool => { const fn = tool.function || tool; return [fn.name, fn]; }));
  function call(name, args) {
    const properties = tools.get(name)?.parameters?.properties || {};
    for (const key of ['query','patch','payload']) if (args[key] != null && properties[key]?.type === 'string') args[key] = JSON.stringify(args[key]);
    return { name, args };
  }
  if (tools.has('assistant_connection_check')) return call('assistant_connection_check', { ok: true });
  const message = context.userMessage || context.message || '', lower = message.toLocaleLowerCase('es');
  const sourceMessage = context.sourceMessage ?? message;
  const explicit = parse(sourceMessage.match(/\{[\s\S]*\}/)?.[0]) || {};
  const form = context.pageContext?.form || context.context?.form || context.form;
  const literalRefs = (field, literal) => {
    const turnId = context.turnId || context.currentTurnId;
    if (!turnId || !literal) return [];
    const start = sourceMessage.indexOf(literal[1]);
    return start < 0 ? [] : [{ field, turnId, start, end: start + literal[1].length }];
  };
  const lastRead = [...history].reverse().find(item => item.name === 'read_business');
  const prepared = history.find(item => item.name === 'prepare_change');
  const finish = (topic, blocks, question = null) => call('finish_turn', { payload: { topic, blocks, question, proposalId: prepared?.result?.proposalId || prepared?.result?.proposal?.id || prepared?.result?.id || null } });
  const text = templateId => ({ type: 'text', templateId, slots: {} });
  if (/noticia|clima|whatsapp|publica(?:r|ción| la)|nutrici[oó]n|banco externo/.test(lower)) return finish('application', [text('scope_limit')]);
  // B deliberately performs an extra real tool round. This makes switching
  // models observable in captured protocol, not merely in a greeting.
  if (body.model === 'fixture-b' && !history.some(item => item.name === 'read_application')) return call('read_application', { taskId: 'cash' });
  if (prepared) {
    const target = prepared.args?.target || prepared.result?.target || '';
    const topic = target === 'order' || target === 'shipment-create' ? 'orders' : target.startsWith('business-action:') ? 'cash' : target.startsWith('shipment-') ? 'shipments' : target.startsWith('settings:') || target.startsWith('onboarding:') ? 'business' : target.startsWith('import-') ? 'imports' : target === 'campaign-draft' || target === 'asset-metadata' || target.startsWith('advertising-') ? 'advertising' : 'catalog';
    return finish(topic, [text('acknowledged')]);
  }
  if (explicit.patch && (explicit.target || form?.target)) {
    const target = explicit.target || form.target;
    if (target === 'order' && !explicit.patch.customerName && !form?.values?.customerName) return finish('orders', [text('missing_data')], { kind: 'missing_field', target, field: 'customerName' });
    const turnId = context.turnId || context.currentTurnId, sourceRefs = [...(explicit.sourceRefs || [])];
    const economic = jsonSourceFields(sourceMessage).filter(item => item.path[0] === 'patch' && assistantEconomicFieldKind(String(item.path.at(-1))));
    for (const item of economic) {
      const field = item.path.slice(1).join('.');
      if (item.value === null || item.value === '') continue;
      const existingSource = sourceRefs.find(ref => ref?.field === field);
      if (existingSource?.evidenceId) {
        const evidence = history.flatMap(read => read.result?.evidence || []).find(fact => fact.id === existingSource.evidenceId && fact.field === (existingSource.sourceField || field));
        if (!evidence && !lastRead && explicit.domain) return call('read_business', { domain: explicit.domain, query: explicit.query || {} });
        if (!evidence || evidence.value !== item.value) return finish('application', [text('missing_data')], { kind: 'missing_field', target, field: String(item.path[1]) });
        continue;
      }
      if (typeof item.value === 'string' && sourceMessage.slice(item.start, item.end) !== item.value || !turnId || item.start >= item.end) return finish('application', [text('missing_data')], { kind: 'missing_field', target, field: String(item.path[1]) });
      if (!existingSource) sourceRefs.push({ field, turnId, start: item.start, end: item.end });
      // User money stays text; only the server parses currency and minor units.
      if (assistantEconomicFieldKind(String(item.path.at(-1))) === 'money') {
        let parent = explicit.patch;
        for (const key of item.path.slice(1, -1)) parent = parent[key];
        parent[item.path.at(-1)] = sourceMessage.slice(item.start, item.end);
      }
    }
    return call('prepare_change', { target, entityId: explicit.entityId ?? form?.entityId ?? null, patch: explicit.patch, sourceRefs, intent: explicit.intent || 'prefill' });
  }
  // Only the server's private pending-question chain can make earlier user
  // literals usable. Conversation text alone never grants this authority.
  const allowedInputTurnIds = new Set(context.allowedInputTurnIds || []);
  const isOrderInput = turn => parse(turn.message?.match(/\{[\s\S]*\}/)?.[0])?.target === 'order';
  const previousOrderTurn = (context.turns || []).find(turn => allowedInputTurnIds.has(turn.turnId) && isOrderInput(turn))
    || [...(context.turns || [])].reverse().find(isOrderInput);
  const previousOrderMessage = previousOrderTurn?.message;
  const previousOrder = parse(previousOrderMessage?.match(/\{[\s\S]*\}/)?.[0]);
  if (previousOrder?.patch && (context.answer || /respuesta a/i.test(message)) && !previousOrder.patch.customerName) {
    const economic = jsonSourceFields(previousOrderMessage).filter(item => item.path[0] === 'patch' && item.value !== null && item.value !== '' && assistantEconomicFieldKind(String(item.path.at(-1))));
    const sourceTurnId = previousOrderTurn.turnId;
    const currentTurnId = context.turnId || context.currentTurnId;
    const answer = context.answer;
    const authenticatedAnswer = answer?.kind === 'missing_field' && answer.target === 'order' && answer.field === 'customerName';
    if (!authenticatedAnswer || !sourceTurnId || !allowedInputTurnIds.has(sourceTurnId)) return finish('orders', [text('missing_data')], { kind: 'missing_field', target: 'order', field: economic.length ? String(economic[0].path[1]) : 'customerName' });
    const customerName = typeof answer.value === 'string' ? answer.value.trim() : '';
    const customerStart = sourceMessage.indexOf(customerName);
    if (!customerName || !currentTurnId || customerStart < 0) return finish('orders', [text('missing_data')], { kind: 'missing_field', target: 'order', field: 'customerName' });
    const sourceRefs = [{ field: 'customerName', turnId: currentTurnId, start: customerStart, end: customerStart + customerName.length }];
    for (const item of economic) {
      const field = item.path.slice(1).join('.');
      const literal = previousOrderMessage.slice(item.start, item.end);
      if (typeof item.value === 'string' && literal !== item.value) return finish('orders', [text('missing_data')], { kind: 'missing_field', target: 'order', field: String(item.path[1]) });
      sourceRefs.push({ field, turnId: sourceTurnId, start: item.start, end: item.end });
      if (assistantEconomicFieldKind(String(item.path.at(-1))) === 'money') {
        let parent = previousOrder.patch;
        for (const key of item.path.slice(1, -1)) parent = parent[key];
        parent[item.path.at(-1)] = literal;
      }
    }
    return call('prepare_change', { target: 'order', entityId: previousOrder.entityId ?? null, patch: { ...previousOrder.patch, customerName }, sourceRefs, intent: 'prefill' });
  }
  if (form && /completa|rellena|cambia|actualiza|corrige|guarda|agrega|a[ñn]ade|pon|nombre|descripci[oó]n|motivo/.test(lower)) {
    const literal = message.match(/[«“"]([^»”"]+)[»”"]/), values = form.values || {};
    const field = /descripci[oó]n/.test(lower) ? 'description' : /motivo|raz[oó]n/.test(lower) ? 'reason' : /nombre/.test(lower) ? (Object.hasOwn(values, 'name') ? 'name' : 'title') : Object.hasOwn(values, 'description') ? 'description' : Object.hasOwn(values, 'reason') ? 'reason' : 'name';
    if (!literal) return finish('application', [text('missing_data')], { kind: 'missing_field', target: form.target, field });
    return call('prepare_change', { target: form.target, entityId: form.entityId ?? null, patch: { [field]: literal[1] }, sourceRefs: literalRefs(field, literal), intent: /^(guarda|actualiza|cambia|corrige|a[ñn]ade|agrega)\b/i.test(message) ? 'save' : 'prefill' });
  }
  if (/descripci[oó]n/.test(lower) && /actualiza|guarda|cambia|corrige/.test(lower)) {
    if (!lastRead) return call('read_business', { domain: 'catalog', query: { kind: 'products', status: 'draft' } });
    const records = lastRead.result?.records || [], literal = message.match(/[«“"]([^»”"]+)[»”"]/);
    const named = records.filter(row => lower.includes((row.title || '').toLocaleLowerCase('es'))), row = named.length === 1 ? named[0] : records.length === 1 ? records[0] : null;
    if (row && literal) return call('prepare_change', { target: 'record:products', entityId: row.id, patch: { description: literal[1] }, sourceRefs: literalRefs('description', literal), intent: 'save' });
    return finish('catalog', [text('choose_record')], records.length >= 2 ? { kind: 'choose_entity', candidateEvidenceIds: (lastRead.result?.evidence || []).filter(item => item.field === 'title').slice(0,4).map(item => item.id) } : { kind: 'missing_field', target: 'record:products', field: 'description' });
  }
  if (/crea(?:r)? (?:un )?pedido|nuevo pedido/.test(lower)) return finish('orders', [text('missing_data')], { kind: 'missing_field', target: 'order', field: 'customerName' });
  const domain = explicit.domain || (/recom(?:end|iend|iénd)/.test(lower) ? 'recommendations' : /caja|saldo|disponible|transferencia|ingreso/.test(lower) ? 'cash' : /pedido/.test(lower) ? 'orders' : /env[ií]o/.test(lower) ? 'shipments' : /producto|cat[aá]logo/.test(lower) ? 'catalog' : 'application');
  if (domain === 'application') {
    const guide = history.find(item => item.name === 'read_application');
    if (!guide) return call('read_application', { taskId: explicit.taskId || 'cash' });
    const taskId = guide.result?.taskId || guide.result?.id || guide.args?.taskId;
    return finish('application', [{ type: 'guide', taskId, stepIds: [] }]);
  }
  if (!lastRead) return call('read_business', { domain, query: explicit.query || {} });
  if (lastRead.args?.domain === 'recommendations') {
    const evidence = new Map((lastRead.result?.evidence || []).map(item => [item.id, item]));
    const recommendation = (lastRead.result?.records || []).find(item =>
      typeof item.id === 'string' && item.id && typeof item.title === 'string' && item.title && typeof item.reason === 'string' && item.reason
      && typeof item.href === 'string' && item.href.startsWith('/admin') && typeof item.actionLabel === 'string' && item.actionLabel
      && Array.isArray(item.evidenceIds) && item.evidenceIds.length
      && item.evidenceIds.every(id => evidence.get(id)?.domain === 'recommendations' && evidence.get(id)?.entityId === item.id));
    if (recommendation) return finish('recommendations', [{ type: 'recommendation', recommendationId: recommendation.id }]);
  }
  const evidenceIds = (lastRead.result?.evidence || []).slice(0,8).map(item => item.id);
  return finish(lastRead.args?.domain || domain, evidenceIds.length ? [{ type: 'fact', evidenceIds }] : [text('missing_data')]);
}

/** Synthetic-only local server. Control requests always require the fixture key. */
export async function startAssistantProviderFixture({ port = 0, key = FIXTURE_KEY } = {}) {
  const requests = [], gates = new Map(), behaviors = new Map();
  const behaviorFor = model => ({ ...(behaviors.get('*') || {}), ...(behaviors.get(model) || {}) });
  const hold = (model = '*') => {
    const id = randomUUID(); let release, onEntered;
    const promise = new Promise(resolve => { release = resolve; });
    const enteredPromise = new Promise(resolve => { onEntered = resolve; });
    gates.set(id, { id, model, promise, release, entered: 0, enteredPromise, onEntered }); return id;
  };
  const release = id => { const gate = gates.get(id); if (gate) { gate.release(); gates.delete(id); return true; } return false; };
  const server = http.createServer(async (req, res) => {
    try {
      const control = req.url === '/__control';
      if (control && !authorized(req, key)) return json(res, 401, { error: 'fixture authentication required' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(res, 413, { error: 'fixture request limit' }); chunks.push(chunk); }
      const body = chunks.length ? parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid JSON' });
      if (control) {
        if (req.method === 'GET') return json(res, 200, { requests, gates: [...gates.values()].map(({ id, model, entered }) => ({ id, model, entered })) });
        if (body.action === 'hold') return json(res, 200, { id: hold(body.model || '*') });
        if (body.action === 'release') return json(res, 200, { released: release(body.id) });
        if (body.action === 'wait') {
          const gate = gates.get(body.id);
          if (!gate) return json(res, 404, { error: 'unknown gate' });
          await gate.enteredPromise;
          return json(res, 200, { id: gate.id, entered: gate.entered });
        }
        if (body.action === 'configure') { behaviors.set(body.model || '*', body.behavior || {}); return json(res, 200, { configured: true }); }
        if (body.action === 'reset') { for (const id of gates.keys()) release(id); behaviors.clear(); requests.length = 0; return json(res, 200, { reset: true }); }
        return json(res, 422, { error: 'unknown control' });
      }
      const responses = req.url === '/v1/responses';
      if (req.method !== 'POST' || ![ '/v1/responses', '/v1/chat/completions' ].includes(req.url)) return json(res, 404, { error: 'unknown endpoint' });
      const behavior = behaviorFor(body.model), authenticated = authorized(req, key);
      if (!authenticated && !behavior.anonymous) return json(res, 401, { error: 'fixture authentication required' });
      if (!MODELS.has(body.model)) return json(res, 422, { error: 'unsupported fixture model' });
      const connectionCheck = (body.tools || []).some(tool => (tool.function || tool).name === 'assistant_connection_check');
      const record = { id: randomUUID(), model: body.model, protocol: responses ? 'responses' : 'chat', authenticated, connectionCheck, tools: (body.tools || []).map(tool => (tool.function || tool).name), body };
      requests.push(record);
      if (!connectionCheck && body.tools?.length) for (const gate of gates.values()) if (gate.model === '*' || gate.model === body.model) { gate.entered++; gate.onEntered(); await gate.promise; }
      if (res.destroyed) return;
      if (behavior.status) return json(res, behavior.status, { error: 'synthetic provider error' });
      if (behavior.malformed) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{invalid'); }
      if (behavior.oversized) return json(res, 200, { padding: 'x'.repeat(1024 * 1024) });
      if (behavior.noTools) return json(res, 200, responses ? { id: randomUUID(), status: 'completed', output: [{ type: 'message', content: [] }] } : { choices: [{ finish_reason: 'stop', message: { content: 'No tools.' } }] });
      if (!body.tools?.length) return json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'Synthetic authentication probe.' } }] });
      const selected = workflow(body, responses), id = `call_${randomUUID()}`;
      if (behavior.unknownTool) selected.name = 'external_network';
      const functionCall = responses ? { type: 'function_call', id: `fc_${randomUUID()}`, call_id: id, name: selected.name, arguments: JSON.stringify(selected.args), status: 'completed' } : { id, type: 'function', function: { name: selected.name, arguments: JSON.stringify(selected.args) } };
      if (responses) return json(res, 200, { id: `resp_${randomUUID()}`, status: 'completed', output: [{ id: `rs_${randomUUID()}`, type: 'reasoning', summary: [], encrypted_content: `synthetic-${body.model}` }, functionCall, ...(behavior.duplicate ? [functionCall] : [])] });
      return json(res, 200, { id: `chat_${randomUUID()}`, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [functionCall, ...(behavior.duplicate ? [functionCall] : [])] } }] });
    } catch { if (!res.headersSent) json(res, 500, { error: 'synthetic fixture failure' }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, key, requests, hold, release, waitForGate: async id => { const gate = gates.get(id); if (!gate) throw new Error('Unknown fixture gate'); await gate.enteredPromise; return gate.entered; }, configure: (model, behavior) => behaviors.set(model, behavior), close: async () => { for (const id of gates.keys()) release(id); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--port'), port = index < 0 ? 3339 : Number(process.argv[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port 1..65535');
  const fixture = await startAssistantProviderFixture({ port });
  console.log(JSON.stringify({ url: fixture.url, models: [...MODELS], control: '/__control' }));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
