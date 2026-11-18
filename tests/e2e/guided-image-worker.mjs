// Invoked over stdin inside the compiled web container of the isolated test
// project. The regular scheduler stays off; provider traffic stays in memory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openStore } from './lib/db/index.mjs';
import { getAssistantSettings, saveAssistantSettings } from './lib/assistant/settings.mjs';
import { getSocialGeneration, processSocialGenerationTurn } from './lib/business/social-generation.mjs';
import { getSocialAsset, processSocialAssetTurn } from './lib/business/social-media.mjs';

const [action, id, origin] = process.argv.slice(2);
assert.match(origin || '', /^https:\/\/localhost:\d+$/);
assert.equal(process.env.APP_URL, origin);
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, 'db');
assert.equal(database.pathname, '/allnutrition_test');
assert.equal(process.env.DB_SSL, 'verify');
const store = await openStore();
try {
  assert.equal((await store.db.get('SELECT current_database() AS name')).name, 'allnutrition_test');
  assert.equal(await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`), null, 'La instancia de imágenes debe tener el scheduler ordinario detenido desde su arranque.');
  const admin = await store.db.get(`SELECT u.id,s.token_hash,s.csrf FROM ${store.t('users')} u JOIN ${store.t('sessions')} s ON s.user_id=u.id WHERE u.email='e2e@example.test' AND active=1 AND s.expires>? ORDER BY s.expires DESC LIMIT 1`, [Date.now()]);
  assert.ok(admin, 'La sesión de navegación real debe estar abierta.');
  if (action === 'configure') {
    await saveAssistantSettings(store, {
      version: (await getAssistantSettings(store)).version, requestId: randomUUID(), enabled: true, provider: 'openai', baseUrl: '', model: 'gpt-chat-synthetic-unchanged', allowPrivateNetwork: false, apiKey: 'e2e-synthetic-never-sent-to-provider',
    }, { user: { id: admin.id }, csrf: admin.csrf, sessionTokenHash: admin.token_hash }, { verify: async () => ({ ok: true }) });
  } else {
    assert.match(id, /^[a-f0-9-]{36}$/);
    if (action === 'asset') {
      assert.equal((await getSocialAsset(store, id)).state, 'processing');
      await processSocialAssetTurn(store);
    } else {
      assert.equal(action, 'generation');
      assert.equal((await getSocialGeneration(store, id, admin.id)).state, 'queued');
      assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_generation_jobs')} WHERE state='queued'`)).n), 1);
      const png = await sharp({ create: { width: 512, height: 640, channels: 3, background: '#365eae' } }).png().toBuffer();
      let posts = 0;
      await processSocialGenerationTurn(store, { transport: async (url, input) => {
        assert.match(url, /^https:\/\/api\.openai\.com\/v1\/images\/(edits|generations)$/);
        assert.equal(input.method, 'POST');
        posts++;
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      } });
      assert.equal(posts, 1);
      const pending = await getSocialGeneration(store, id, admin.id);
      assert.equal(pending.state, 'succeeded');
      assert.equal(pending.asset.state, 'processing');
      await processSocialAssetTurn(store);
      assert.equal((await getSocialGeneration(store, id, admin.id)).asset.state, 'ready');
    }
  }
} finally { await store.close(); }
