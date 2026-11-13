import { assistantRequest } from './http.mjs';
import { isDeepStrictEqual } from 'node:util';
import { ASSISTANT_LIMITS } from './limits.mjs';

const fail = code => { const error = new Error(code === 'ASSISTANT_MODEL_UNSUPPORTED' ? 'El modelo no admite funciones estructuradas.' : 'El proveedor no está disponible.'); error.code = code; error.status = code === 'ASSISTANT_UNAVAILABLE' ? 503 : 422; return error; };
const safeName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyParameters = { type: 'object', properties: {}, additionalProperties: false };
function geminiEndpoint(model) {
  if (typeof model !== 'string' || model.trim() !== model || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) throw fail('ASSISTANT_MODEL_UNSUPPORTED');
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
// Validate the JSON Schema vocabulary used by Ali's closed tool declarations,
// independently of the provider's constrained decoding. Local refs stay local.
function validGeminiArguments(value, schema, root = schema, depth = 0) {
  if (depth > 32 || !object(schema)) return false;
  if (schema.$ref != null) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return false;
    let target = root;
    for (const key of schema.$ref.slice(2).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!object(target) || !Object.hasOwn(target, key)) return false;
      target = target[key];
    }
    if (!validGeminiArguments(value, target, root, depth + 1)) return false;
  }
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const) || schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) return false;
  if (schema.anyOf && !schema.anyOf.some(item => validGeminiArguments(value, item, root, depth + 1))) return false;
  if (schema.oneOf && schema.oneOf.filter(item => validGeminiArguments(value, item, root, depth + 1)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(item => validGeminiArguments(value, item, root, depth + 1))) return false;
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some(type => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) return false;
  if (object(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) {
        if (!validGeminiArguments(item, schema.properties[key], root, depth + 1)) return false;
      } else if (schema.additionalProperties === false || object(schema.additionalProperties) && !validGeminiArguments(item, schema.additionalProperties, root, depth + 1)) return false;
    }
  }
  if (Array.isArray(value) && (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems || schema.items && !value.every(item => validGeminiArguments(item, schema.items, root, depth + 1)))) return false;
  if (typeof value === 'string' && (schema.minLength != null && [...value].length < schema.minLength || schema.maxLength != null && [...value].length > schema.maxLength || schema.pattern != null && !new RegExp(schema.pattern, 'u').test(value))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum)) return false;
  return true;
}
function parseGeminiCalls(value, tools, round, seen) {
  if (!Array.isArray(value?.candidates) || value.candidates.length !== 1) throw fail('ASSISTANT_UNAVAILABLE');
  const candidate = value.candidates[0], content = candidate?.content;
  if (candidate?.finishReason !== 'STOP' || !object(content) || content.role !== 'model' || !Array.isArray(content.parts)) throw fail('ASSISTANT_UNAVAILABLE');
  const native = [];
  for (const part of content.parts) {
    if (!object(part) || part.text != null && typeof part.text !== 'string' || part.thought != null && typeof part.thought !== 'boolean' || part.thoughtSignature != null && typeof part.thoughtSignature !== 'string') throw fail('ASSISTANT_UNAVAILABLE');
    if (Object.hasOwn(part, 'functionCall')) {
      const call = part.functionCall;
      if (!object(call) || !safeName(call.name) || call.id != null && (typeof call.id !== 'string' || !call.id || call.id.length > 512) || call.args != null && !object(call.args) || part.text != null) throw fail('ASSISTANT_UNAVAILABLE');
      if (Object.hasOwn(call, 'args') && !object(call.args)) throw fail('ASSISTANT_UNAVAILABLE');
      native.push(call);
    } else if (typeof part.text !== 'string') throw fail('ASSISTANT_MODEL_UNSUPPORTED');
  }
  if (!native.length) throw fail('ASSISTANT_MODEL_UNSUPPORTED');
  const occupied = new Set([...seen, ...native.map(call => call.id).filter(id => id != null)]);
  const calls = native.map((call, index) => {
    const tool = tools.find(tool => tool.name === call.name), args = call.args ?? {};
    if (!tool || !validGeminiArguments(args, tool.parameters || emptyParameters)) throw fail('ASSISTANT_UNAVAILABLE');
    let id = call.id;
    if (id == null) {
      id = `gemini-local:${round}:${index}`;
      while (occupied.has(id)) id += ':local';
      occupied.add(id);
    }
    return { id, name: call.name, arguments: args };
  });
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw fail('ASSISTANT_UNAVAILABLE');
  const finished = calls.some(call => call.name === 'finish_turn');
  if ((finished || calls.some(call => call.name === 'prepare_change')) && calls.length !== 1) throw fail('ASSISTANT_UNAVAILABLE');
  return { calls, finished, native };
}
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
  return { instructions, input: [{ role: 'user', content }], messages: [{ role: 'system', content: instructions }, { role: 'user', content }], contents: [{ role: 'user', parts: [{ text: content }] }] };
}
function providerRequestBody(runtime, { instructions, input, messages, contents }, tools) {
  if (runtime.provider === 'openai') {
    // store:false requires explicit continuation: preserve reasoning and all
    // provider output items verbatim, including encrypted reasoning content.
    return JSON.stringify({ model: runtime.model, store: false, include: ['reasoning.encrypted_content'], instructions, input, tools: tools.map(functionTool), max_output_tokens: 4096 });
  }
  if (runtime.provider === 'openai-compatible') return JSON.stringify({ model: runtime.model, max_tokens: 4096, messages, tools: tools.map(tool => { const { type: _type, ...fn } = functionTool(tool); return { type: 'function', function: fn }; }), tool_choice: 'auto' });
  if (runtime.provider === 'gemini') {
    geminiEndpoint(runtime.model);
    return JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] }, contents,
      tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description || tool.name, parametersJsonSchema: tool.parameters || emptyParameters })) }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { candidateCount: 1, maxOutputTokens: 4096 },
    });
  }
  throw fail('ASSISTANT_UNAVAILABLE');
}
export function assistantProviderContextBytes(runtime, context, tools) {
  return Buffer.byteLength(providerRequestBody(runtime, initialProviderState(context), tools), 'utf8');
}
export function createAssistantProvider(runtime, { transport = assistantRequest, limits = {} } = {}) {
  const provider = runtime.provider;
  const maxRequests = limits.maxRequests ?? ASSISTANT_LIMITS.extended.modelRequests;
  const maxContextBytes = Math.min(limits.maxContextBytes ?? ASSISTANT_LIMITS.providerBodyBytes, ASSISTANT_LIMITS.providerBodyBytes);
  const timeoutMs = Math.min(limits.timeoutMs ?? ASSISTANT_LIMITS.extended.providerMs, ASSISTANT_LIMITS.extended.providerMs);
  let input = [], messages = [], contents = [], pendingCalls = null, pendingNative = null, started = false, finished = false, rounds = 0, instructions = '', retainedContext = null;
  const seen = new Set();
  return Object.freeze({
    async next({ context, results, tools, signal } = {}) {
      if (finished || ++rounds > maxRequests || !Array.isArray(tools) || !tools.length || tools.some(t => !safeName(t.name)) || new Set(tools.map(t => t.name)).size !== tools.length) throw fail('ASSISTANT_UNAVAILABLE');
      if (!started) {
        if (!context || results != null) throw fail('ASSISTANT_UNAVAILABLE');
        started = true;
        retainedContext = { ...context, ...(Array.isArray(context.turns) ? { turns: [...context.turns] } : {}) };
        ({ instructions, input, messages, contents } = initialProviderState(retainedContext));
      } else {
        if (context != null || !pendingCalls || !Array.isArray(results)) throw fail('ASSISTANT_UNAVAILABLE');
        const ids = results.map(item => item?.callId);
        if (ids.length !== pendingCalls.length || new Set(ids).size !== ids.length || pendingCalls.some(call => !ids.includes(call.id))) throw fail('ASSISTANT_UNAVAILABLE');
        if (provider === 'openai') input.push(...results.map(item => ({ type: 'function_call_output', call_id: item.callId, output: JSON.stringify(item.result) })));
        else if (provider === 'gemini') {
          contents.push({ role: 'user', parts: pendingCalls.map((call, index) => {
            const item = results.find(item => item.callId === call.id), native = pendingNative[index];
            if (item.name != null && item.name !== call.name || !object(item.result)) throw fail('ASSISTANT_UNAVAILABLE');
            return { functionResponse: { name: call.name, ...(native.id == null ? {} : { id: native.id }), response: item.result } };
          }) });
          pendingNative = null;
        } else messages.push(...results.map(item => ({ role: 'tool', tool_call_id: item.callId, content: JSON.stringify(item.result) })));
        pendingCalls = null;
      }
      let body = providerRequestBody(runtime, { instructions, input, messages, contents }, tools);
      while (Buffer.byteLength(body, 'utf8') > maxContextBytes && retainedContext.turns?.length) {
        retainedContext.turns.shift();
        const initial = initialProviderState(retainedContext);
        // Only the historical context item changes. All current calls, exact
        // tool outputs and Responses reasoning items remain in their sequence.
        input[0] = initial.input[0];
        messages[1] = initial.messages[1];
        contents[0] = initial.contents[0];
        body = providerRequestBody(runtime, { instructions, input, messages, contents }, tools);
      }
      const endpoint = provider === 'gemini' ? geminiEndpoint(runtime.model) : provider === 'openai' ? 'https://api.openai.com/v1/responses' : `${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`;
      if(Buffer.byteLength(body,'utf8')>maxContextBytes)throw Object.assign(fail('ASSISTANT_UNAVAILABLE'),{contextLimit:true,reason:'context_capacity'});
      let response;
      try {
        response = await transport(endpoint, {
          body, apiKey: runtime.apiKey, provider, allowPrivateNetwork: runtime.allowPrivateNetwork, signal, timeoutMs,
          ...(provider === 'gemini' ? { authMethod: runtime.authMethod || 'api-key', accessToken: runtime.accessToken, projectId: runtime.projectId } : {}),
        });
      }
      catch (error) { if (['ASSISTANT_CREDENTIAL_INVALID', 'ASSISTANT_UNAVAILABLE'].includes(error?.code)) throw error; throw fail('ASSISTANT_UNAVAILABLE'); }
      let parsed;
      try { parsed = provider === 'gemini' ? parseGeminiCalls(response, tools, rounds, seen) : parseCalls(response, provider); }
      catch (error) { if (error.code === 'ASSISTANT_UNAVAILABLE') error.invalidAnswer = true; throw error; }
      const names = new Set(tools.map(tool => tool.name));
      if (parsed.calls.some(call => !names.has(call.name) || seen.has(call.id))) throw Object.assign(fail('ASSISTANT_UNAVAILABLE'), { invalidAnswer:true });
      for (const call of parsed.calls) seen.add(call.id);
      if (provider === 'openai') input.push(...response.output);
      else if (provider === 'gemini') {
        // Preserve the entire model Content, including thought signatures and
        // non-call parts, without rewriting IDs or merging signed parts.
        contents.push(response.candidates[0].content);
        pendingNative = parsed.native;
      } else messages.push({ role: 'assistant', ...(response.choices[0].message.content == null ? {} : { content: response.choices[0].message.content }), tool_calls: response.choices[0].message.tool_calls.map(call => ({ ...call, type: 'function' })) });
      pendingCalls = parsed.calls; finished = parsed.finished;
      return { calls: parsed.calls, finished };
    },
  });
}
export async function verifyAssistantProvider(runtime, { signal, transport = assistantRequest, beforeRequest = async () => {} } = {}) {
  const tools = [{ name: 'assistant_connection_check', description: 'Confirmar la conexión', parameters: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } }];
  const check = createAssistantProvider(runtime, { transport: async (url, request) => {
    const payload = JSON.parse(request.body);
    if (runtime.provider === 'gemini') payload.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['assistant_connection_check'] } };
    else payload.tool_choice = runtime.provider === 'openai' ? { type: 'function', name: 'assistant_connection_check' } : { type: 'function', function: { name: 'assistant_connection_check' } };
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
