import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertRow } from '../lib/business/commands.mjs';
import { countHekaGuides, operateHeka, saveHekaSettings } from '../lib/business/heka-api.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { HEKA_CARRIERS } from '../lib/shipping/heka-api.mjs';

const key = 'synthetic-guide-count-key';
const config = { environment: 'production', version: 1 };
const path = '/api/v1/shipments/guide/v2/external';
const ids = ['all', ...HEKA_CARRIERS];
const reply = (response, status = 200) => Response.json({ code:status, response },{ status });
const result = total => ({ rows:[{ _id:'68ad416c3c792ac4658caf48', client:{ name:'Non-exported fixture' } }], pager:{ total } });

async function setup(t,factory) {
  const directory = await mkdtemp(join(await realpath(tmpdir()),'guide-count-contract-'));
  const keyring = createIntegrationKeyring({ directory:join(directory,'keys'), controlDirectory:join(directory,'control') });
  t.after(() => rm(directory,{ recursive:true, force:true }));
  const store = await factory();
  t.after(() => store.close());
  const id = randomUUID(), token = 'b'.repeat(64), csrf = 'guide-count-contract';
  await insertRow(store,'users',{ id, email:`${id}@example.test`, password:'unused', active:1 });
  await insertRow(store,'sessions',{ token_hash:token, user_id:id, expires:Date.now()+600000, csrf });
  const session = { user:{ id }, sessionTokenHash:token, csrf };
  const configure = (version, environment) => saveHekaSettings(store,{ version, environment, apiKey:key },session,{ keyring });
  await configure(0,config.environment);
  return { store, session, configure, keyring, count:(transport,body=config) => countHekaGuides(store,body,session,{keyring,transport}) };
}

export async function runShippingGuideContracts(t,factory) {
  await t.test('totales por cuenta en pares, sin inferir cifras, exportar filas ni perder éxitos parciales',{ timeout:15000 },async t => {
    const { count } = await setup(t,factory);
    const firstPair = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
    t.after(release.resolve);
    let inFlight = 0, peak = 0;
    const expected = { all:41, servientrega:29, interrapidisimo:9, heka:0, coordinadora:null, tcc:null, envia:5 };
    const reading = count(async (url,init) => {
      const carrier = url.searchParams.get('distributor_id') ?? 'all';
      calls.push({ carrier, url, method:init.method, body:init.body, key:init.headers['api-key'] });
      inFlight++;
      peak = Math.max(peak,inFlight);
      try {
        if (calls.length <= 2) {
          if (calls.length === 2) firstPair.resolve();
          await release.promise;
        }
        if (carrier === 'tcc') return reply({ message:'Private provider detail' },503);
        if (carrier === 'coordinadora') return reply(result(undefined));
        return reply(result(expected[carrier]));
      } finally { inFlight--; }
    });
    await firstPair.promise;
    assert.equal(inFlight,2);
    release.resolve();
    assert.deepEqual(await reading,{ totals:expected });
    assert.equal(peak,2);
    assert.deepEqual(calls.map(call => call.carrier).sort(),ids.toSorted());
    for (const call of calls) {
      assert.equal(call.url.origin,'https://api.hekaentrega.co');
      assert.equal(call.url.pathname,path);
      assert.deepEqual(Object.fromEntries(call.url.searchParams),{ page:'1', limit:'2', ...(call.carrier==='all'?{}:{distributor_id:call.carrier}) });
      assert.equal(call.method,'GET');
      assert.equal(call.body,undefined);
      assert.equal(call.key,key);
    }
  });

  await t.test('la cuota es compartida con el listado y los ámbitos inválidos no salen a Heka',async t => {
    const { count, store, session, keyring } = await setup(t,factory);
    let sent = 0;
    const transport = () => { sent++; return reply(result(41)); };
    await assert.rejects(count(transport,{ ...config, version:0 }),{ code:'HEKA_CONFIG_CHANGED' });
    await assert.rejects(count(transport,{ ...config, environment:'test' }),{ code:'HEKA_CONFIG_CHANGED' });
    await assert.rejects(count(transport,{ ...config, limit:1 }),{ code:'HEKA_INPUT' });
    await assert.rejects(countHekaGuides(store,config,null,{keyring,transport}),{ code:'HEKA_SESSION' });
    assert.equal(sent,0);
    await insertRow(store,'attempts',{ key:'heka-api:read', count:59, reset_at:Date.now()+60000 });
    await operateHeka(store,{ ...config, operation:'guides', input:{ page:1, limit:20 } },session,{keyring,transport});
    assert.deepEqual(await count(transport),{ totals:Object.fromEntries(ids.map(id=>[id,null])) });
    assert.equal(sent,1);
  });

  await t.test('un cambio de configuración durante una consulta descarta todo el resumen',{ timeout:15000 },async t => {
    const { configure, count } = await setup(t,factory);
    const firstPair = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(release.resolve);
    let sent = 0;
    const reading = assert.rejects(count(async () => {
      if (++sent === 2) firstPair.resolve();
      await release.promise;
      return reply(result(41));
    }),{ code:'HEKA_CONFIG_CHANGED' });
    await firstPair.promise;
    try { await configure(1,'test'); } finally { release.resolve(); }
    await reading;
    assert.equal(sent,2);
  });

  await t.test('cancelar la lectura no inicia más pares de consultas',{ timeout:15000 },async t => {
    const { store, session, keyring } = await setup(t,factory);
    const controller = new AbortController(), firstPair = Promise.withResolvers();
    let sent = 0;
    const reason = new Error('Solicitud de totales cancelada');
    t.after(() => controller.abort(reason));
    const reading = assert.rejects(countHekaGuides(store,config,session,{keyring,signal:controller.signal,transport:(_url,{signal}) => {
      if (++sent === 2) firstPair.resolve();
      return new Promise((_,reject) => signal.addEventListener('abort',() => reject(signal.reason),{ once:true }));
    }}),error => error === reason);
    await firstPair.promise;
    controller.abort(reason);
    await reading;
    assert.equal(sent,2);
  });
}
