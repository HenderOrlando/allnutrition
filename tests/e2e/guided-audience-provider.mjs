// Run inside the dedicated compiled web fixture. The port is never exposed outside its container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { openStore } from '../../lib/db/index.mjs';
import { getAssistantSettings, saveAssistantSettings } from '../../lib/assistant/settings.mjs';

const [action, origin] = process.argv.slice(2);
const endpoint = 'http://127.0.0.1:3339/v1', model = 'guided-audience-synthetic', key = 'synthetic-audience-fixture-never-use-externally';
assert.match(origin || '', /^https:\/\/localhost:\d+$/);
assert.equal(process.env.APP_URL, origin);
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, 'db');
assert.equal(database.pathname, '/allnutrition_test');
assert.equal(process.env.DB_SSL, 'verify');
assert.ok(process.env.DB_CA_CERT_FILE || process.env.DB_CA_CERT);
const store = await openStore();
try {
  assert.deepEqual(await store.db.get('SELECT current_database() AS name, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'), { name: 'allnutrition_test', ssl: true });
  assert.equal(await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`), null);
  if (action !== 'serve') {
    assert.ok(['configure', 'disable'].includes(action));
    const admin = await store.db.get(`SELECT u.id,s.token_hash,s.csrf FROM ${store.t('users')} u JOIN ${store.t('sessions')} s ON s.user_id=u.id WHERE u.email='e2e@example.test' AND active=1 AND s.expires>? ORDER BY s.expires DESC LIMIT 1`, [Date.now()]);
    assert.ok(admin);
    await saveAssistantSettings(store, { version: (await getAssistantSettings(store)).version, requestId: randomUUID(), enabled: action === 'configure', provider: 'openai-compatible',
      baseUrl: endpoint, model, allowPrivateNetwork: true, apiKey: key }, { user: { id: admin.id }, csrf: admin.csrf, sessionTokenHash: admin.token_hash });
  }
} finally { await store.close(); }

if (action === 'serve') createServer(async (req, res) => {
  function reply(status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return reply(404, { error: 'Unrecognized fixture request' });
  if (req.headers.authorization !== `Bearer ${key}`) return reply(401, { error: 'Invalid fixture credentials' });
  try {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 24000) return reply(413, { error: 'Fixture request too large' }); }
    const input = JSON.parse(raw);
    assert.equal(input.model, model);
    const names = input.tools.map(tool => tool.function.name);
    let tool, args;
    if (names.length === 1 && names[0] === 'assistant_connection_check') {
      tool = 'assistant_connection_check';
      args = { ok: true };
    } else {
      assert.deepEqual(names, ['proponer_audiencia']);
      tool = 'proponer_audiencia';
      const manual = input.tools[0].function.parameters.properties.grounding.items.enum.includes('currentAudience');
      const facts = JSON.parse(input.messages.find(message => message.role === 'user').content);
      assert.deepEqual(facts.markets, ['MX', 'PE']);
      args = { ageMin: 23, ageMax: 55, interests: manual ? ['Fitness'] : [], grounding: manual ? ['objective', 'markets', 'currentAudience'] : ['objective', 'markets'], assumptions: ['no_prior_results'] };
    }
    return reply(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } }] });
  } catch {
    return reply(400, { error: 'Unexpected fixture request' });
  }
}).listen(3339, '127.0.0.1');
