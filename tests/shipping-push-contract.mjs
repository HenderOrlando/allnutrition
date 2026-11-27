import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logout } from '../lib/auth.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { saveHekaSettings } from '../lib/business/heka-api.mjs';
import { changeShippingPushDevice, getShippingPushStatus, processShippingPushTurn, shippingPushOrigin } from '../lib/business/shipping-push.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { resolveShippingPushEndpoint, shippingPushEndpoint } from '../lib/shipping/push-transport.mjs';

const origin = 'https://admin.example.com';
const env = { APP_URL:origin };
const now = '2026-10-01T12:00:00.000Z';
const scope = { environment:'test',version:1 };
const publicDns = async () => [{ address:'142.250.217.138',family:4 }];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function browserSubscription() {
  const pair = createECDH('prime256v1');
  return { endpoint:`https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys:{ p256dh:pair.generateKeys('base64url'),auth:randomBytes(16).toString('base64url') } };
}

async function fixture(t, factory) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'shipping-push-contract-'));
  const keyring = createIntegrationKeyring({ directory:join(directory,'keys'),controlDirectory:join(directory,'control') });
  t.after(() => rm(directory,{ recursive:true,force:true }));
  const store = await factory();
  t.after(() => store.close());
  const apiOptions = { origin,env,keyring,lookup:publicDns };
  async function account() {
    const id = randomUUID(), token = randomBytes(32).toString('hex'), csrf = randomUUID();
    const session = { user:{ id },sessionTokenHash:sha256(token),csrf };
    await insertRow(store,'users',{ id,email:`${id}@example.test`,password:'unused',active:1 });
    await insertRow(store,'sessions',{ token_hash:session.sessionTokenHash,user_id:id,expires:Date.now()+600000,csrf });
    return { session,token,id };
  }
  const owner = await account();
  const configure = (version, environment, clear = false) => saveHekaSettings(store,clear?{ version }:{ version,environment,apiKey:'synthetic-push-contract' },owner.session,{ keyring,clear });
  await configure(0, 'test');
  const prepare = (by = owner) => changeShippingPushDevice(store,{ action:'prepare',...scope },by.session,null,apiOptions);
  async function subscribe(by = owner, subscription = browserSubscription(), options = apiOptions) {
    const { data:{ publicKey },device } = await prepare(by);
    const result = await changeShippingPushDevice(store,{ action:'subscribe',...scope,publicKey,subscription },by.session,device,options);
    assert.equal(result.device,device);
    return result;
  }
  async function event({ environment='test',generation=1, devices=[] } = {}) {
    const e = { connection_id:'heka',environment,generation };
    const id = randomUUID(), guideId = randomUUID(), noveltyId = randomUUID();
    await store.transaction(async tx => {
      await tx.db.run(`INSERT INTO ${tx.t('shipping_novelty_sync')}(connection_id,environment,generation,next_sequence,next_at) VALUES(?,?,?,'open',?) ON CONFLICT DO NOTHING`, [e.connection_id,environment,generation,now]);
      await insertRow(tx,'shipping_novelties',{ ...e,guide_id:guideId,novelty_id:noveltyId,state:'pending',revision:1,fingerprint:sha256(id),data:'{}',updated_at:now });
      await insertRow(tx,'shipping_novelty_events',{ ...e,id,guide_id:guideId,novelty_id:noveltyId,revision:1,created_at:now });
      for (const device of devices) await insertRow(tx,'shipping_push_deliveries',{ event_id:id,subscription_id:device,state:'pending',attempts:0,next_at:now });
    });
    return id;
  }
  const delivery = (event, device) => store.db.get(`SELECT * FROM ${store.t('shipping_push_deliveries')} WHERE event_id=? AND subscription_id=?`, [event,device]);
  const turn = (send, when=now, options={}) => processShippingPushTurn(store,{ now:when,env,keyring,lookup:publicDns,send,...options });
  return { store,owner,account,keyring,directory,prepare,configure,subscribe,event,delivery,turn,apiOptions };
}

export async function runShippingPushContracts(t, factory) {
  await t.test('una VAPID estable y cifrada; solo servicios HTTPS y direcciones públicas', async t => {
    const { store,owner,directory,keyring,prepare,subscribe,apiOptions } = await fixture(t,factory);
    const [a,b] = await Promise.all([prepare(),prepare()]);
    assert.equal(a.data.publicKey,b.data.publicKey);
    assert.equal(Buffer.from(a.data.publicKey,'base64url').length,65);
    assert.equal(shippingPushOrigin({ APP_URL:'https://localhost:8443' },'production'),null);
    assert.equal(shippingPushOrigin({ APP_URL:'https://localhost:8443' },'test'),'https://localhost:8443');
    assert.equal(shippingPushOrigin({ APP_URL:'http://example.com' },'test'),null);
    for (const spoofed of ['http://fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com@invalid.example/x','https://fcm.googleapis.com.invalid.example/fcm/send/x','https://fcm.googleapis.com:444/fcm/send/x','https://fcm.googleapis.com/fcm/send/x#abc','https://fcm.googleapis.com/fcm/send/%2e%2e/x']) {
      assert.throws(() => shippingPushEndpoint(spoofed), { status:400 });
    }
    const sub = browserSubscription();
    await assert.rejects(resolveShippingPushEndpoint(sub.endpoint, async () => [...await publicDns(), { address:'127.0.0.1',family:4 }]), { status:400 });
    await assert.rejects(subscribe(owner,sub,{ ...apiOptions,origin:'https://other.example.com' }), { status:403 });
    const { device } = await subscribe(owner,sub);
    const stored = await store.db.get(`SELECT * FROM ${store.t('shipping_push_subscriptions')} WHERE id=?`, [device]);
    assert.equal(stored.endpoint_hash,sha256(sub.endpoint));
    assert.ok(!JSON.stringify(stored).includes(sub.endpoint) && !JSON.stringify(stored).includes(sub.keys.auth));
    assert.deepEqual(await getShippingPushStatus(store,owner.id,device,{ env }), { available:true,environment:'test',deviceEnvironment:'test' });
    assert.equal((await keyring.read('shipping-push',{ required:true })).length,32);
    await rm(join(directory,'keys','shipping-push.key'));
    await assert.rejects(prepare(), { code:'INTEGRATION_KEY_MISSING' });
    assert.equal(await keyring.read('shipping-push'),null);
  });

  await t.test('la cola conserva leases y etiquetas estables; limita reintentos y retira endpoints 410', { timeout:15000 }, async t => {
    const { store,subscribe,event,delivery,turn } = await fixture(t,factory);
    const { device } = await subscribe();
    const id = await event({ devices:[device] });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(release.resolve);
    const tags = [];
    const first = turn(async (_sub,payload,options) => {
      const message = JSON.parse(payload);
      assert.deepEqual(Object.keys(message).sort(),['environment','eventId','tag']);
      assert.equal(message.eventId,id);
      assert.equal(message.environment,'test');
      assert.equal(options.topic,message.tag);
      tags.push(message.tag);
      entered.resolve();
      await release.promise;
      return { statusCode:429,retryAfter:'120' };
    });
    await Promise.race([entered.promise,first.then(() => assert.fail('No se inició la entrega bajo lease'))]);
    const failSend = () => assert.fail('El lease o la desconexión debe bloquear el envío');
    assert.ok((await turn(failSend)).nextAt > now);
    release.resolve();
    const retry = await first;
    assert.ok(retry.nextAt >= '2026-10-01T12:02:00.000Z');
    assert.equal((await delivery(id,device)).attempts,1);
    const queued = await event({ devices:[device] });
    const queuedAt = '2026-10-01T12:05:00.000Z';
    await store.db.run(`UPDATE ${store.t('shipping_push_deliveries')} SET next_at=? WHERE event_id=?`, [queuedAt,queued]);
    await turn(async (_sub,payload) => { tags.push(JSON.parse(payload).tag); return { statusCode:410 }; }, '2026-10-01T12:04:00.000Z');
    assert.equal(tags[0],tags[1]);
    assert.equal((await delivery(id,device)).state,'discarded');
    assert.equal((await delivery(queued,device)).state,'discarded');
    assert.ok((await store.db.get(`SELECT disabled_at FROM ${store.t('shipping_push_subscriptions')} WHERE id=?`,[device])).disabled_at);
    assert.equal((await turn(failSend,queuedAt)).nextAt,null);
  });

  await t.test('el cierre de sesión desactiva solo su dispositivo; cambios de cuenta o entorno frenan envíos', async t => {
    const { store,owner,account,configure,subscribe,event,delivery,turn } = await fixture(t,factory);
    const other = await account();
    const [a,b,c] = await Promise.all([subscribe(),subscribe(),subscribe(other)]);
    const eventId = await event({ devices:[a.device,b.device,c.device] });
    const foreign = await event({ environment:'production',devices:[b.device] });
    let calls = 0;
    const send = async () => { calls++; return { statusCode:201 }; };
    await logout(store,owner.token,a.device);
    await logout(store,other.token,b.device);
    await store.db.run(`UPDATE ${store.t('users')} SET active=0 WHERE id=?`,[other.id]);
    await turn(send);
    assert.equal(calls,1);
    assert.equal((await delivery(eventId,a.device)).state,'discarded');
    assert.equal((await delivery(eventId,b.device)).state,'sent');
    assert.equal((await delivery(eventId,c.device)).state,'discarded');
    assert.equal((await delivery(foreign,b.device)).state,'discarded');
    assert.deepEqual((await getShippingPushStatus(store,owner.id,b.device,{ env })).deviceEnvironment,'test');
    const pending = await event({ devices:[b.device] });
    const actorToken = randomBytes(32).toString('hex');
    await insertRow(store,'sessions',{ token_hash:sha256(actorToken),user_id:owner.id,expires:Date.now()+600000,csrf:owner.session.csrf });
    owner.session.sessionTokenHash = sha256(actorToken);
    await configure(1,'test',true);
    await turn(send);
    assert.equal(calls,1);
    assert.equal((await delivery(pending,b.device)).state,'discarded');
    assert.equal((await store.db.get(`SELECT id FROM ${store.t('shipping_novelty_events')} WHERE id=?`,[pending])).id,pending);
  });

  await t.test('no sale a red cuando cambia la configuración mientras se valida el destino',{ timeout:15000 },async t => {
    const { configure,subscribe,event,delivery,turn } = await fixture(t,factory);
    const { device } = await subscribe();
    const id = await event({ devices:[device] });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(release.resolve);
    let calls = 0;
    const sending = turn(async () => { calls++; return { statusCode:201 }; }, now, { lookup:async () => {
      entered.resolve();
      await release.promise;
      return publicDns();
    } });
    await Promise.race([entered.promise,sending.then(() => assert.fail('No se llegó a la validación de DNS'))]);
    await configure(1,'production');
    release.resolve();
    await sending;
    assert.equal(calls,0);
    assert.equal((await delivery(id,device)).state,'discarded');
  });

  await t.test('solo las fallas transitorias vuelven a la cola y el quinto intento es terminal',async t => {
    const { subscribe,event,delivery,turn } = await fixture(t,factory);
    const { device } = await subscribe();
    const id = await event({ devices:[device] });
    let next = now, calls = 0;
    for (let attempt=1; attempt<=5; attempt++) {
      ({ nextAt:next } = await turn(async () => { calls++; return { statusCode:503 }; },next));
      const row = await delivery(id,device);
      assert.equal(row.attempts,attempt);
      assert.equal(row.state,attempt<5?'pending':'discarded');
    }
    assert.equal(next,null);
    assert.equal(calls,5);
    const redirect = await event({ devices:[device] });
    const result = await turn(async () => ({ statusCode:302 }));
    assert.equal(result.nextAt,null);
    assert.equal((await delivery(redirect,device)).state,'discarded');
  });
}
