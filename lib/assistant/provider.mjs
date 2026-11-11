import { assistantRequest } from './http.mjs';

const fail = code => { const error = new Error(code === 'ASSISTANT_MODEL_UNSUPPORTED' ? 'El modelo no admite funciones estructuradas.' : 'El proveedor no está disponible.'); error.code = code; error.status = code === 'ASSISTANT_UNAVAILABLE' ? 503 : 422; return error; };
const safeName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name);
function parseCalls(value, provider) {
  let raw;
  if (provider === 'openai') {
    if (!Array.isArray(value?.output) || value.status !== 'completed') throw fail('ASSISTANT_UNAVAILABLE');
    raw = value.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
  } else {
    const choice = value?.choices?.[0];
    if (!choice?.message || !['tool_calls','stop'].includes(choice.finish_reason)) throw fail('ASSISTANT_UNAVAILABLE');
    if (!Array.isArray(choice.message.tool_calls)) throw fail('ASSISTANT_MODEL_UNSUPPORTED');
    raw = choice.message.tool_calls.map(item => ({ id: item.id, name: item.function?.name, arguments: item.function?.arguments }));
  }
  const calls = raw.map(item => {
    let args; try { args = JSON.parse(item.arguments); } catch { throw fail('ASSISTANT_UNAVAILABLE'); }
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof item.id !== 'string' || !item.id || !safeName(item.name)) throw fail('ASSISTANT_UNAVAILABLE');
    return { ...item, arguments: args };
  });
  if (!calls.length) throw fail('ASSISTANT_MODEL_UNSUPPORTED');
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw fail('ASSISTANT_UNAVAILABLE');
  const finish = calls.some(call => call.name === 'finish_turn');
  if (finish && calls.length !== 1 || calls.some(call => call.name === 'prepare_change') && calls.length !== 1) throw fail('ASSISTANT_UNAVAILABLE');
  return { calls, finished: finish };
}
function functionTool(tool) {
  return { type: 'function', name: tool.name, description: tool.description || tool.name, parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false }, strict: tool.strict !== false };
}
function initialProviderState(context) {
  const content = JSON.stringify(context), instructions = context.instructions || '';
  return { instructions, input: [{ role: 'user', content }], messages: [{ role: 'system', content: instructions }, { role: 'user', content }] };
}
function providerRequestBody(runtime, { instructions, input, messages }, tools) {
  if (runtime.provider === 'openai') {
    // store:false requires explicit continuation: preserve reasoning and all
    // provider output items verbatim, including encrypted reasoning content.
    return JSON.stringify({ model: runtime.model, store: false, include: ['reasoning.encrypted_content'], instructions, input, tools: tools.map(functionTool), max_output_tokens: 4096 });
  }
  if (runtime.provider === 'openai-compatible') return JSON.stringify({ model: runtime.model, max_tokens: 4096, messages, tools: tools.map(tool => { const { type: _type, ...fn } = functionTool(tool); return { type: 'function', function: fn }; }), tool_choice: 'auto' });
  throw fail('ASSISTANT_UNAVAILABLE');
}
export function assistantProviderContextBytes(runtime, context, tools) {
  return Buffer.byteLength(providerRequestBody(runtime, initialProviderState(context), tools), 'utf8');
}
export function createAssistantProvider(runtime, { transport = assistantRequest } = {}) {
  const provider = runtime.provider;
  let input = [], messages = [], pendingCalls = null, started = false, finished = false, rounds = 0, instructions = '', retainedContext = null;
  const seen = new Set();
  return Object.freeze({
    async next({ context, results, tools, signal } = {}) {
      if (finished || ++rounds > 6 || !Array.isArray(tools) || !tools.length || tools.some(t => !safeName(t.name)) || new Set(tools.map(t => t.name)).size !== tools.length) throw fail('ASSISTANT_UNAVAILABLE');
      const continuing = started;
      if (!started) {
        if (!context || results != null) throw fail('ASSISTANT_UNAVAILABLE');
        started = true;
        retainedContext = { ...context, ...(Array.isArray(context.turns) ? { turns: [...context.turns] } : {}) };
        ({ instructions, input, messages } = initialProviderState(retainedContext));
      } else {
        if (context != null || !pendingCalls || !Array.isArray(results)) throw fail('ASSISTANT_UNAVAILABLE');
        const ids = results.map(item => item?.callId);
        if (ids.length !== pendingCalls.length || new Set(ids).size !== ids.length || pendingCalls.some(call => !ids.includes(call.id))) throw fail('ASSISTANT_UNAVAILABLE');
        if (provider === 'openai') input.push(...results.map(item => ({ type: 'function_call_output', call_id: item.callId, output: JSON.stringify(item.result) })));
        else messages.push(...results.map(item => ({ role: 'tool', tool_call_id: item.callId, content: JSON.stringify(item.result) })));
        pendingCalls = null;
      }
      let body = providerRequestBody(runtime, { instructions, input, messages }, tools);
      while (continuing && Buffer.byteLength(body, 'utf8') > 96 * 1024 && retainedContext.turns?.length) {
        retainedContext.turns.shift();
        const initial = initialProviderState(retainedContext);
        // Only the historical context item changes. All current calls, exact
        // tool outputs and Responses reasoning items remain in their sequence.
        input[0] = initial.input[0];
        messages[1] = initial.messages[1];
        body = providerRequestBody(runtime, { instructions, input, messages }, tools);
      }
      const endpoint = provider === 'openai' ? 'https://api.openai.com/v1/responses' : `${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`;
      if(Buffer.byteLength(body,'utf8')>96*1024)throw Object.assign(fail('ASSISTANT_UNAVAILABLE'),{contextLimit:true});
      let response;
      try { response = await transport(endpoint, { body, apiKey: runtime.apiKey, provider, allowPrivateNetwork: runtime.allowPrivateNetwork, signal }); }
      catch (error) { if (['ASSISTANT_CREDENTIAL_INVALID', 'ASSISTANT_UNAVAILABLE'].includes(error?.code)) throw error; throw fail('ASSISTANT_UNAVAILABLE'); }
      const parsed = parseCalls(response, provider);
      const names = new Set(tools.map(tool => tool.name));
      if (parsed.calls.some(call => !names.has(call.name) || seen.has(call.id))) throw fail('ASSISTANT_UNAVAILABLE');
      for (const call of parsed.calls) seen.add(call.id);
      if (provider === 'openai') input.push(...response.output);
      else messages.push({ role: 'assistant', ...(response.choices[0].message.content == null ? {} : { content: response.choices[0].message.content }), tool_calls: response.choices[0].message.tool_calls.map(call => ({ ...call, type: 'function' })) });
      pendingCalls = parsed.calls; finished = parsed.finished;
      return parsed;
    },
  });
}
export async function verifyAssistantProvider(runtime, { signal, transport = assistantRequest, beforeRequest = async () => {} } = {}) {
  const tools = [{ name: 'assistant_connection_check', description: 'Confirmar la conexión', parameters: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } }];
  const check = createAssistantProvider(runtime, { transport: async (url, request) => {
    const payload = JSON.parse(request.body);
    payload.tool_choice = runtime.provider === 'openai' ? { type: 'function', name: 'assistant_connection_check' } : { type: 'function', function: { name: 'assistant_connection_check' } };
    await beforeRequest();
    const result = await transport(url, { ...request, body: JSON.stringify(payload) });
    await beforeRequest();
    return result;
  } });
  const response = await check.next({ context: { instructions: 'Llama exactamente una vez a assistant_connection_check con {"ok":true}. No incluyas datos del negocio.' }, tools, signal });
  if (response.calls.length !== 1 || response.calls[0].name !== 'assistant_connection_check' || response.calls[0].arguments?.ok !== true || Object.keys(response.calls[0].arguments).length !== 1) throw fail('ASSISTANT_MODEL_UNSUPPORTED');
  if (runtime.provider === 'openai-compatible') {
    await beforeRequest();
    let rejected = false;
    try {
      await transport(`${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`, { body: JSON.stringify({ model: runtime.model, max_tokens: 16, messages: [{ role: 'user', content: 'Authentication check only.' }] }), provider: runtime.provider, allowPrivateNetwork: runtime.allowPrivateNetwork, signal });
    } catch (error) {
      if (error?.code === 'ASSISTANT_CREDENTIAL_INVALID') rejected = true;
      else throw error;
    }
    await beforeRequest();
    if (!rejected) throw fail('ASSISTANT_CREDENTIAL_INVALID');
  }
  return true;
}
