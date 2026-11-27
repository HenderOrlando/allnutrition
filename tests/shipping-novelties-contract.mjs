import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertRow } from '../lib/business/commands.mjs';
import { getHekaWebhookSettings, operateHeka, readHekaNoveltyPage, readHekaWebhookCredential, saveHekaSettings, saveHekaWebhookSettings } from '../lib/business/heka-api.mjs';
import { touchSchedulerHeartbeat } from '../lib/business/jobs.mjs';
import { listShippingNovelties,markShippingNoveltyRead,processShippingNoveltyTurn,processShippingWebhookTurn,shippingWebhookReady } from '../lib/business/shipping-novelties.mjs';
import { authenticateHekaWebhook, enqueueHekaWebhook } from '../lib/business/heka-webhook.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';

const BASIC_KEY = 'synthetic-only-heka-key';
const DATE = '2026-10-02T18:00:00.000Z';
const MINUTE = 60000, DAY = 86400000;
const WEBHOOK_SECRET = 'whsec_synthetic';
const noCall = () => { assert.fail('No debe salir una solicitud al proveedor'); };
const idOf = value => value.toString(16).padStart(24,'0');
const guide = (id,status='created') => ({_id:idOf(id),guide_number:`TEST-${id}`,distributor_id:'coordinadora',status});
const novelty = (id,status='in_novelty',message='Sin acceso al destino') => ({
  ...guide(id),status_novelty:status,
  last_novelty:{_id:idOf(1000+id),message,code:'01',solution:'solución privada descartada',comment:'comentario privado descartado'},
  client:{email:'private@example.test'},movemens:[{date:DATE,label:'Visita de prueba',status:'distribution'}],
});
const page = (rows,number=1,nextPage=null) => ({rows,pager:{page:number,nextPage,total:nextPage===null?rows.length:60}});
const json = (response,code=200) => Response.json({code,response},{status:code});
function signWebhook(timestamp,id='evt_one',delivery='dlv_one',guideId=1,event='guide.status_changed',secret=WEBHOOK_SECRET) {
  const raw=Buffer.from(` ${JSON.stringify({id,event,created_at:timestamp,data:{guide_id:idOf(guideId),status:'resolved',order_id:null}})}\n`);
  const signed=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
  const headers=new Headers({'X-Heka-Timestamp':timestamp,'X-Heka-Signature':`sha256=${signed}`,'X-Heka-Delivery':delivery,'X-Heka-Event':event});
  return {headers,raw};
}
async function enqueue(store,scope,clock,{id,delivery,guideId,event,secret}={}) {
  const {headers,raw}=signWebhook(clock(),id,delivery,guideId,event,secret);
  return enqueueHekaWebhook(store,scope,authenticateHekaWebhook(headers,raw,secret??WEBHOOK_SECRET,clock()),{now:clock()});
}
function verifyGuide(id,{status='created',open=null,resolved=null}={}) {
  return (url,init)=>{
    assert.equal(init.method,'GET');
    const query=Object.fromEntries(url.searchParams);
    if (url.pathname==='/api/v1/shipments/guide/v2/external') {
      assert.deepEqual(query,{id:idOf(id),limit:'1'});
      return json(guide(id,status));
    }
    assert.equal(url.pathname,'/api/v1/shipments/novelty');
    const isResolved=query.status_novelty==='resolved';
    assert.deepEqual(query,{id:idOf(id),limit:'1',...(isResolved?{status_novelty:'resolved'}:{})});
    return json(isResolved?resolved:open);
  };
}
const wait = () => Promise.withResolvers();
async function waitForTransport(entered,turn) {
  await Promise.race([entered.promise,turn.then(result=>assert.fail(`El turno terminó antes de consultar Heka: ${JSON.stringify(result)}`))]);
}

async function user(store,active=1) {
  const id = randomUUID(), sessionTokenHash = id.replaceAll('-','').repeat(2), csrf='synthetic-csrf';
  await insertRow(store,'users',{id,email:`${id}@example.test`,password:'unused',active});
  await insertRow(store,'sessions',{token_hash:sessionTokenHash,user_id:id,expires:Date.now()+600000,csrf});
  return {user:{id},sessionTokenHash,csrf};
}
async function device(store,id,userId,environment='test',disabledAt=null) {
  await insertRow(store,'shipping_push_subscriptions',{id,user_id:userId,environment,endpoint_hash:String(id).padStart(64,'0'),
    ciphertext:'opaque',iv:'opaque',auth_tag:'opaque',created_at:DATE,updated_at:DATE,disabled_at:disabledAt});
}
async function fixture(t,factory) {
  const root = await mkdtemp(join(await realpath(tmpdir()),'heka-novelties-'));
  const keyring = createIntegrationKeyring({directory:join(root,'key'),controlDirectory:join(root,'control')});
  t.after(() => rm(root,{recursive:true,force:true}));
  const store = await factory();
  t.after(() => store.close());
  const admin = await user(store);
  let now = DATE;
  return {
    store,admin,keyring,clock:() => now,
    advance(ms) { now = new Date(Date.parse(now)+ms).toISOString(); },
    configure(version,environment='test',clear=false) { return saveHekaSettings(store,clear?{version}:{version,environment,apiKey:BASIC_KEY},admin,{keyring,clear}); },
    turn(transport=noCall) { return processShippingNoveltyTurn(store,{clock:()=>now,keyring,transport}); },
    webhook(transport=noCall,ring=keyring) { return processShippingWebhookTurn(store,{clock:()=>now,keyring:ring,transport}); },
    sync() { return store.db.get(`SELECT * FROM ${store.t('shipping_novelty_sync')} WHERE environment='test' AND generation=1`); },
    inbox(options={},actor=admin) { return listShippingNovelties(store,actor.user.id,{...options,now}); },
    mark(eventId,actor=admin) { return markShippingNoveltyRead(store,actor.user.id,{eventId},{now}); },
    async installWebhook(secret=WEBHOOK_SECRET) {
      const {environment,generation,revision}=await getHekaWebhookSettings(store);
      return saveHekaWebhookSettings(store,{environment,generation,revision,secret},admin,{keyring});
    },
    heartbeat() { return touchSchedulerHeartbeat(store,{now:new Date(Date.parse(now)-1000).toISOString()}); },
  };
}
function transport(sequence,result,{number=1,environment='test',code=200}={}) {
  return (url,init) => {
    const resource=sequence==='guides'?'guide/v2/external':'novelty';
    assert.equal(`${url.origin}${url.pathname}`,`https://${environment==='test'?'apidev':'api'}.hekaentrega.co/api/v1/shipments/${resource}`);
    assert.deepEqual(Object.fromEntries(url.searchParams),{page:String(number),limit:'50',...(sequence==='resolved'?{status_novelty:'resolved'}:{})});
    assert.equal(init.method,'GET');
    assert.equal(init.headers['api-key'],BASIC_KEY);
    assert.equal(init.body,undefined);
    return json(result,code);
  };
}

export async function runShippingNoveltiesContracts(t,factory) {
  await t.test('signed webhooks isolate environments, deduplicate and verify exact guides before notifying',async t=>{
    const f=await fixture(t,factory),{store,clock,keyring}=f;
    await f.configure(0);
    const secret=WEBHOOK_SECRET;
    const disabled=await getHekaWebhookSettings(store);
    assert.equal(await readHekaWebhookCredential(store,'test',{keyring}),null);
    await f.turn(transport('open',page([])));
    const input={environment:disabled.environment,generation:disabled.generation,revision:null,secret};
    const active=await saveHekaWebhookSettings(store,input,f.admin,{keyring});
    const credential=await readHekaWebhookCredential(store,'test',{keyring});
    assert.equal(credential.secret,secret);
    assert.equal(await readHekaWebhookCredential(store,'production',{keyring}),null);
    assert.ok(!JSON.stringify(await store.db.get(`SELECT * FROM ${store.t('heka_api_settings')}`)).includes(secret));
    assert.ok(!JSON.stringify(await store.exportData()).includes('webhook_ciphertext'));
    await assert.rejects(saveHekaWebhookSettings(store,input,f.admin,{keyring}),{code:'HEKA_WEBHOOK_CHANGED'});
    const envelope=(id,delivery,guideId)=>signWebhook(clock(),id,delivery,guideId);
    const {headers,raw}=envelope();
    assert.throws(()=>authenticateHekaWebhook(headers,raw.subarray(1),secret,clock()),{status:401});
    assert.throws(()=>authenticateHekaWebhook(headers,raw,secret,'2026-10-02T20:00:00.000Z'),{status:401});
    const signed=authenticateHekaWebhook(headers,raw,secret,clock());
    const accept=(scope,item)=>enqueueHekaWebhook(store,scope,item,{now:clock()});
    await assert.rejects(accept({...active,environment:'production'},signed),{status:409});
    assert.deepEqual((await Promise.all([accept(active,signed),accept(active,signed)])).sort(),[false,true]);
    for(const alias of [envelope('evt_one','dlv_new'),envelope('evt_new','dlv_one')]){
      assert.equal(await accept(active,authenticateHekaWebhook(alias.headers,alias.raw,secret,clock())),false);
    }
    const turn=provider=>processShippingWebhookTurn(store,{clock,keyring,transport:provider});
    assert.equal(await shippingWebhookReady(store,clock()),false);
    assert.equal((await turn(noCall)).processed,0);
    await f.turn(transport('resolved',page([])));
    assert.equal((await f.turn()).processed,0);
    assert.equal(await shippingWebhookReady(store,clock()),true);
    const calls=[];
    const checked=await turn((url,{method})=>{
      assert.equal(method,'GET');
      if (url.pathname==='/api/v1/shipments/guide/v2/external') {
        assert.deepEqual(Object.fromEntries(url.searchParams),{id:idOf(1),limit:'1'});
        return json(guide(1,'distribution'));
      }
      assert.equal(url.pathname,'/api/v1/shipments/novelty');
      const query=Object.fromEntries(url.searchParams);
      calls.push(query);
      return json(query.status_novelty==='resolved'?null:novelty(1));
    });
    assert.deepEqual(calls,[{id:idOf(1),limit:'1'},{id:idOf(1),limit:'1',status_novelty:'resolved'}]);
    assert.deepEqual(checked,{processed:1,events:1});
    assert.equal((await f.inbox()).sync.cadence,'webhook_daily');
    assert.equal((await f.sync()).webhook_verified_revision,active.revision);
    const rows=await store.db.all(`SELECT guide_id,state FROM ${store.t('shipping_novelties')}`);
    assert.deepEqual(rows.map(({guide_id,state})=>[guide_id,state]),[[idOf(1),'pending']]);
    assert.deepEqual(await turn(noCall),{processed:0,events:0});
    assert.equal((await f.turn()).processed,0);
    const next=envelope('evt_two','dlv_two');
    const incoming=authenticateHekaWebhook(next.headers,next.raw,secret,clock());
    assert.ok(await accept(active,incoming));
    const {environment,generation,revision}=active;
    await saveHekaWebhookSettings(store,{environment,generation,revision},f.admin,{clear:true,keyring});
    assert.equal(await readHekaWebhookCredential(store,'test',{keyring}),null);
    assert.equal((await f.inbox()).sync.cadence,'polling');
    assert.equal(await shippingWebhookReady(store,clock()),false);
    await assert.rejects(accept(active,incoming),{status:409});
    f.advance(60000);
    assert.equal((await f.turn(transport('open',page([novelty(3)])))).events,1);
    const reactivated=await saveHekaWebhookSettings(store,{environment,generation,revision:null,secret},f.admin,{keyring});
    assert.notEqual(reactivated.revision,revision);
    await f.configure(1,'production');
    assert.equal(await readHekaWebhookCredential(store,'test',{keyring}),null);
    assert.equal(await shippingWebhookReady(store,clock()),false);
  });
  await t.test('real verified guide events permit the daily sweep; omitted guide status and both novelty sequences are recovered without commercial writes',async t=>{
    const f=await fixture(t,factory), {store,clock}=f;
    await f.configure(0);
    const active=await f.installWebhook();
    const old=novelty(4);
    await f.turn(transport('open',page([old])));
    await f.turn(transport('resolved',page([])));
    assert.equal(await enqueue(store,active,clock,{event:'webhook.test'}),false);
    assert.equal(await shippingWebhookReady(store,clock()),false);
    assert.equal((await f.inbox()).sync.cadence,'polling');
    assert.equal((await f.sync()).guide_next_at,null);
    f.advance(DAY);
    assert.equal((await f.turn(transport('open',page([old])))).processed,1);
    await f.turn(transport('resolved',page([])));
    await enqueue(store,active,clock);
    assert.deepEqual(await f.webhook(verifyGuide(1)),{processed:1,events:0});
    const verifiedAt=Date.parse(clock());
    assert.equal((await f.inbox()).sync.cadence,'webhook_daily');
    assert.equal((await f.sync()).webhook_verified_at,clock());
    assert.equal((await f.sync()).next_at,new Date(verifiedAt+DAY).toISOString());
    f.advance(MINUTE);
    await f.heartbeat();
    assert.equal((await f.inbox()).sync.status,'current');
    assert.deepEqual(await f.turn(),{processed:0,events:0,nextAt:new Date(verifiedAt+DAY).toISOString()});

    const tables=['orders','shipments','order_events','shipment_events','heka_api_order_links','heka_api_mutations','expenses','order_collections','cash_entries'];
    const facts=()=>Promise.all(tables.map(table=>store.db.all(`SELECT * FROM ${store.t(table)}`)));
    const before=await facts();
    f.advance(DAY-MINUTE);
    const omitted=novelty(3);
    assert.equal((await f.turn(transport('open',page([omitted],1,2)))).events,1);
    assert.equal((await f.turn(transport('resolved',page([{...old,status_novelty:'resolved'}])))).events,1);
    const finished={...guide(1,'finished'),client:{email:'not-to-be-stored@example.test'},collection_value:12345};
    assert.equal((await f.turn(transport('guides',page([finished],1,2)))).processed,1);
    assert.equal(Number((await f.sync()).guide_page),2);
    f.advance(10000);
    assert.equal((await f.turn(transport('open',page([omitted,novelty(5,'in_review')],2),{number:2}))).events,1);
    assert.equal((await f.turn(transport('guides',page([guide(2,'distribution')],2),{number:2}))).processed,1);
    assert.equal(Number((await f.sync()).guide_page),1);
    const observations=()=>store.db.all(`SELECT * FROM ${store.t('shipping_guide_observations')} ORDER BY guide_id`);
    const cached=await observations();
    assert.deepEqual(cached.map(row=>[row.guide_id,row.guide_number,row.carrier,row.provider_status]),
      [[idOf(1),'TEST-1','coordinadora','finished'],[idOf(2),'TEST-2','coordinadora','distribution']]);
    assert.doesNotMatch(JSON.stringify(cached),/not-to-be-stored|12345/);
    assert.ok(!Object.hasOwn((await store.exportData()).business,'shipping_guide_observations'));

    const rows=(await f.inbox()).rows;
    assert.deepEqual(rows.map(row=>[row.guide._id,row.state]).sort(),[[idOf(3),'pending'],[idOf(4),'resolved'],[idOf(5),'review']]);
    assert.equal((await f.inbox({summary:true})).unreadCount,3);
    const dailyAt=new Date(verifiedAt+2*DAY+10000).toISOString();
    const scheduled=await f.sync();
    assert.equal(scheduled.next_at,dailyAt);
    assert.equal(scheduled.guide_next_at,dailyAt);
    // The scheduler also wakes for a quiet webhook's earlier proof expiry.
    assert.deepEqual(await f.turn(),{processed:0,events:0,nextAt:new Date(verifiedAt+2*DAY).toISOString()});
    assert.deepEqual(await facts(),before);

    await enqueue(store,active,clock,{id:'evt_refresh',delivery:'dlv_refresh',event:'guide.movements_added'});
    assert.equal((await f.webhook(verifyGuide(1,{status:'finished'}))).processed,1);
    assert.equal((await f.sync()).next_at,dailyAt,'webhook activity never delays the scheduled sweep');
    assert.equal((await f.sync()).guide_next_at,dailyAt);
    assert.deepEqual(await f.turn(),{processed:0,events:0,nextAt:dailyAt});
    await enqueue(store,active,clock,{id:'evt_mismatch',delivery:'dlv_mismatch',guideId:6,event:'guide.created'});
    assert.equal((await f.webhook(verifyGuide(6,{open:novelty(7)}))).errorCode,'HEKA_NO_EVIDENCE');
    assert.equal((await f.sync()).webhook_verified_revision,null);
    assert.equal((await f.inbox()).sync.cadence,'polling');
    assert.deepEqual((await observations()).map(row=>row.guide_id),[idOf(1),idOf(2)],'failed verification cannot create a guide observation');
    f.advance(MINUTE-1);
    assert.equal((await f.turn()).errorCode,undefined);
    f.advance(1);
    assert.equal((await f.turn(transport('open',page([novelty(6)])))).events,1);
    assert.deepEqual(await facts(),before);
  });

  await t.test('a rotated revision cannot keep or refresh verified cadence, even with a signed event in flight',async t=>{
    const f=await fixture(t,factory),{store,clock}=f;
    await f.configure(0);
    const first=await f.installWebhook();
    await f.turn(transport('open',page([])));
    await f.turn(transport('resolved',page([])));
    await enqueue(store,first,clock);
    assert.equal((await f.webhook(verifyGuide(1))).processed,1);
    await enqueue(store,first,clock,{id:'evt_late',delivery:'dlv_late'});
    const entered=wait(), release=wait();
    let calls=0;
    const late=f.webhook(async (url,init)=>{
      calls++;
      entered.resolve();
      await release.promise;
      return verifyGuide(1,{status:'finished'})(url,init);
    });
    await waitForTransport(entered,late);
    let second;
    try {
      second=await f.installWebhook('whsec_synthetic_rotated');
      assert.notEqual(first.revision,second.revision);
      assert.equal((await f.inbox()).sync.cadence,'polling');
      assert.equal(await shippingWebhookReady(store,clock()),false);
    } finally { release.resolve(); }
    assert.deepEqual(await late,{processed:0,events:0});
    assert.equal(calls,1);
    assert.equal((await f.sync()).webhook_verified_revision,null);
    assert.equal((await store.db.get(`SELECT provider_status FROM ${store.t('shipping_guide_observations')}`)).provider_status,'created');
    assert.equal((await f.turn(transport('open',page([novelty(2)])))).events,1);
    await f.turn(transport('resolved',page([])));
    await enqueue(store,second,clock,{id:'evt_current',delivery:'dlv_current',secret:'whsec_synthetic_rotated'});
    assert.equal((await f.webhook(verifyGuide(1))).processed,1);
    assert.equal((await f.sync()).webhook_verified_revision,second.revision);
  });

  for(const reason of ['quiet expiry','unreadable webhook custody']) {
    await t.test(`verified cadence returns to minute polling on ${reason}`,async t=>{
      const f=await fixture(t,factory),{store,clock}=f;
      await f.configure(0);
      const active=await f.installWebhook();
      await f.turn(transport('open',page([])));
      await f.turn(transport('resolved',page([])));
      await enqueue(store,active,clock);
      await f.webhook(verifyGuide(1));
      assert.equal((await f.inbox()).sync.cadence,'webhook_daily');
      if(reason==='quiet expiry') {
        f.advance(2*DAY-1);
        assert.equal((await f.inbox()).sync.cadence,'webhook_daily');
        f.advance(1);
      } else {
        await store.db.run(`UPDATE ${store.t('heka_api_settings')} SET webhook_auth_tag='unreadable' WHERE id=1`);
      }
      assert.equal((await f.turn(transport('open',page([novelty(2)])))).events,1);
      assert.equal((await f.inbox()).sync.cadence,'polling');
      assert.equal((await f.sync()).webhook_verified_revision,null);
    });
  }

  await t.test('production inbox exposes only a matching, explicit local shipment link',async t=>{
    const f=await fixture(t,factory),{store,admin}=f;
    const orderId=randomUUID(), shipmentId=randomUUID();
    await insertRow(store,'orders',{id:orderId,number:1,data:'{}',created_at:DATE,updated_at:DATE});
    await insertRow(store,'shipments',{id:shipmentId,order_id:orderId,carrier:'Coordinadora',tracking:'TEST-1',status:'unknown',created_at:DATE,updated_at:DATE});
    await insertRow(store,'heka_api_order_links',{guide_id:idOf(1),carrier:'coordinadora',guide_number:'TEST-1',order_id:orderId,shipment_id:shipmentId,
      local_carrier:'Coordinadora',provider_status:'created',actor_id:admin.user.id,linked_at:DATE});
    await f.configure(0,'production');
    const exact=novelty(1);
    const matchNumberOnly={...novelty(2),guide_number:exact.guide_number};
    const missingCarrier={...exact,distributor_id:undefined,last_novelty:{_id:idOf(1003)}};
    const wrongNumber={...exact,guide_number:'TEST-4',last_novelty:{_id:idOf(1004)}};
    await f.turn(transport('open',page([exact,matchNumberOnly,missingCarrier,wrongNumber]),{environment:'production'}));
    const linked=(await f.inbox()).rows.filter(row=>row.shipmentId);
    assert.deepEqual(linked.map(row=>[row.guide.last_novelty._id,row.shipmentId]),[[exact.last_novelty._id,shipmentId]]);
    assert.equal((await store.db.get(`SELECT status FROM ${store.t('shipments')} WHERE id=?`,[shipmentId])).status,'unknown');
    assert.deepEqual(await store.db.all(`SELECT id FROM ${store.t('shipment_events')}`),[]);
    await f.configure(1,'test');
    await f.turn(transport('open',page([exact])));
    assert.equal((await f.inbox()).rows[0].shipmentId,undefined);
  });
  await t.test('novelties alternate and silently backfill; exact changes enqueue once and reads are scoped to their user',async t => {
    const f = await fixture(t,factory), {store,admin} = f;
    const second = await user(store), inactive = await user(store,0);
    await device(store,'1',admin.user.id);
    await device(store,'2',second.user.id,'production');
    await device(store,'3',second.user.id,'test',DATE);
    await device(store,'4',inactive.user.id);
    await f.configure(0);
    await f.heartbeat();
    const first = novelty(1), historic = novelty(2,'resolved');
    const others = Array.from({length:22},(_,index) => novelty(index+20));
    assert.equal((await f.turn(transport('open',page([first],1,2)))).events,0);
    assert.equal((await f.inbox()).sync.status,'initializing');
    assert.equal((await f.turn(transport('resolved',page([historic])))).events,0);
    f.advance(9999);
    assert.equal((await f.turn()).processed,0);
    f.advance(1);
    assert.equal((await f.turn(transport('open',page([first,...others],2),{number:2}))).events,0);
    assert.equal((await f.turn(transport('resolved',page([historic])))).events,0);
    const baseline = await f.inbox({summary:true});
    assert.equal(baseline.sync.status,'current');
    assert.equal(baseline.latestEventId,null);
    const pageOne = await f.inbox(), pageTwo = await f.inbox({page:2});
    assert.equal(pageOne.pager.total,24);
    assert.equal(pageOne.rows.length,20);
    assert.equal(pageTwo.rows.length,4);
    assert.equal(pageOne.pager.nextPage,2);
    assert.equal(pageTwo.pager.previousPage,1);
    assert.doesNotMatch(JSON.stringify([pageOne,pageTwo]),/private@example|solución privada|comentario privado/);
    assert.equal((await f.inbox({state:'resolved'})).rows.length,1);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('shipping_push_deliveries')}`),[]);

    f.advance(60000);
    const gate=wait(), entered=wait(), newRow=novelty(3);
    const firstTurn = f.turn(async (url,init) => { entered.resolve(); await gate.promise; return transport('open',page([newRow,newRow,first],1,2))(url,init); });
    await waitForTransport(entered,firstTurn);
    try { assert.deepEqual(await f.turn(),{processed:0,events:0,nextAt:new Date(Date.parse(f.clock())+45000).toISOString()}); }
    finally { gate.resolve(); }
    assert.equal((await firstTurn).events,1);
    const fresh = await f.inbox({summary:true});
    assert.ok(fresh.latestEventId);
    assert.equal(fresh.unreadCount,1);
    assert.equal((await f.inbox({summary:true},second)).unreadCount,1);
    assert.equal((await f.turn(transport('resolved',page([historic])))).events,0);
    f.advance(10000);
    assert.equal((await f.turn(transport('open',page([newRow,first],2),{number:2}))).events,0,'an overlap after baseline does not duplicate an event');
    assert.equal((await f.turn(transport('resolved',page([historic])))).events,0);
    assert.equal((await f.inbox({summary:true})).latestEventId,fresh.latestEventId);

    f.advance(60000);
    const reordered = {last_novelty:{...newRow.last_novelty,message:`  ${newRow.last_novelty.message}  `}, ...Object.fromEntries(Object.entries(newRow).filter(([key])=>key!=='last_novelty')),
      movemens:[{date:'2026-10-02T18:01:00.000Z',label:'Nuevo movimiento sin cambio de novedad'}]};
    assert.equal((await f.turn(transport('open',page([reordered],1,2)))).events,0);
    assert.equal((await f.turn(transport('resolved',page([historic])))).events,0);
    f.advance(10000);
    const review = {...newRow,status_novelty:'in_review',last_novelty:{_id:newRow.last_novelty._id}};
    assert.equal((await f.turn(transport('open',page([review,review],2),{number:2}))).events,1);
    const inReview = (await f.inbox({state:'review'})).rows[0];
    assert.equal(inReview.revision,2);
    assert.equal(inReview.guide.last_novelty.message,newRow.last_novelty.message);
    assert.notEqual(inReview.eventId,fresh.latestEventId);
    assert.equal((await f.inbox({summary:true})).latestEventId,inReview.eventId);
    assert.equal((await f.turn(transport('resolved',page([historic,{...newRow,status_novelty:'resolved'}])))).events,1);
    const resolvedRows = (await f.inbox({state:'resolved'})).rows;
    const resolved = resolvedRows.find(row=>row.guide._id===newRow._id);
    assert.equal(resolved.revision,3);
    assert.equal(resolved.unreadCount,3);
    assert.equal((await f.inbox({summary:true})).latestEventId,resolved.eventId);
    const target=await f.inbox({eventId:inReview.eventId});
    assert.equal(target.pager.total,1);
    assert.deepEqual(target.rows.map(row=>[row.guide._id,row.eventId,row.state]),[[newRow._id,inReview.eventId,'resolved']]);
    assert.equal(target.rows[0].unreadCount,2,'an older target does not count newer revisions as its own');
    assert.deepEqual((await f.inbox({eventId:randomUUID()})).rows,[]);
    assert.throws(()=>f.inbox({eventId:'not-an-event'}),{status:400});
    await f.mark(inReview.eventId);
    await f.mark(inReview.eventId);
    assert.equal((await f.inbox({eventId:inReview.eventId})).rows[0].unreadCount,0);
    assert.equal((await f.inbox({summary:true})).unreadCount,1,'a later revision remains unread');
    assert.equal((await f.inbox({summary:true},second)).unreadCount,3);
    await f.mark(resolved.eventId);
    assert.equal((await f.inbox({summary:true})).unreadCount,0);
    const deliveries = await store.db.all(`SELECT event_id,subscription_id,state,attempts FROM ${store.t('shipping_push_deliveries')}`);
    assert.equal(deliveries.length,3);
    assert.equal(new Set(deliveries.map(row=>row.event_id)).size,3);
    assert.ok(deliveries.every(row=>row.subscription_id==='1' && row.state==='pending' && Number(row.attempts)===0));
    f.advance(60000);
    assert.equal((await f.turn(transport('open',page([review])))).events,0,'a stale open page cannot undo a confirmed resolution');
    assert.equal((await f.inbox({state:'resolved'})).rows.length,2);
    assert.equal((await f.inbox({state:'pending'})).pager.total,23,'disappearance never means resolution');
  });

  await t.test('bad responses preserve history and back off; reserve interactive reads and reject a missing fence',async t => {
    const f = await fixture(t,factory), {store,admin,keyring,clock} = f;
    assert.equal((await f.inbox({summary:true})).sync.status,'disconnected');
    assert.equal((await f.turn()).nextAt,null);
    await f.configure(0);
    const lease = {environment:'test',generation:1,sequence:'open',page:1,leaseId:randomUUID()};
    await assert.rejects(readHekaNoveltyPage(store,lease,{transport:noCall,keyring,clock}),{code:'HEKA_NOVELTY_LEASE_LOST'});
    await f.heartbeat();
    await f.turn(transport('open',page([novelty(1)])));
    await f.turn(transport('resolved',page([])));
    f.advance(60000);
    const forbidden = await f.turn(transport('open',{message:'dato externo privado'},{code:403}));
    const lastSuccess = (await f.inbox()).sync.lastSuccessAt;
    assert.equal(lastSuccess,DATE);
    assert.equal(forbidden.errorCode,'HEKA_ROLE_OR_KEY');
    assert.equal((await f.inbox()).sync.status,'forbidden');
    f.advance(299999);
    assert.equal((await f.turn()).nextAt,forbidden.nextAt);
    f.advance(1);
    const limited = await f.turn(transport('resolved',{message:'dato externo privado'},{code:429}));
    assert.equal(limited.errorCode,'HEKA_PROVIDER_LIMIT');
    assert.equal((await f.inbox()).sync.status,'rate_limited');
    f.advance(119999);
    assert.equal((await f.turn()).nextAt,limited.nextAt);
    f.advance(1);
    await store.db.run(`UPDATE ${store.t('attempts')} SET count=48,reset_at=? WHERE key='heka-api:read'`,[Date.now()+3600000]);
    assert.equal((await f.turn()).errorCode,'HEKA_LOCAL_LIMIT');
    assert.equal(Number((await store.db.get(`SELECT count FROM ${store.t('attempts')} WHERE key='heka-api:read'`)).count),48);
    await operateHeka(store,{operation:'check',input:{},environment:'test',version:1},admin,{keyring,transport:(url,init)=>{
      assert.equal(url.pathname,'/api/v1/warehouse'); assert.equal(init.method,'GET'); return json(null);
    }});
    assert.equal(Number((await store.db.get(`SELECT count FROM ${store.t('attempts')} WHERE key='heka-api:read'`)).count),49);
    await store.db.run(`DELETE FROM ${store.t('attempts')} WHERE key='heka-api:read'`);
    f.advance(60000);
    const malformed = await f.turn(transport('resolved',{rows:[novelty(9,'resolved')],pager:{page:2,total:1,nextPage:null}}));
    assert.equal(malformed.errorCode,'HEKA_RESPONSE');
    const inbox = await f.inbox();
    assert.equal(inbox.sync.status,'unavailable');
    assert.equal(inbox.sync.schedulerStatus,'stale');
    assert.equal(inbox.sync.lastSuccessAt,lastSuccess);
    assert.equal(inbox.rows.length,1);
    assert.equal(inbox.rows[0].state,'pending');
    assert.doesNotMatch(JSON.stringify(inbox),/dato externo privado/);
    f.advance(60000);
    await f.turn(transport('open',page([])));
    assert.equal((await f.inbox()).sync.status,'scheduler_unavailable');
  });

  await t.test('a lost lease or settings generation cannot commit; disconnect shows only its own last valid scope',async t => {
    const f = await fixture(t,factory);
    await f.configure(0);
    const oldGate=wait(), oldEntered=wait();
    const expired=f.turn(async (url,init)=>{ oldEntered.resolve(); await oldGate.promise; return transport('open',page([novelty(2)]))(url,init); });
    await waitForTransport(oldEntered,expired);
    f.advance(46000);
    try { await f.turn(transport('open',page([novelty(3)]))); }
    finally { oldGate.resolve(); }
    assert.equal((await expired).errorCode,'HEKA_NOVELTY_LEASE_LOST');
    assert.deepEqual((await f.inbox()).rows.map(row=>row.guide._id),[idOf(3)]);
    await f.turn(transport('resolved',page([])));
    f.advance(60000);
    assert.equal((await f.turn(transport('open',page([novelty(6)])))).events,1);
    const oldEvent = (await f.inbox({summary:true})).latestEventId;

    const switchGate=wait(), switchEntered=wait();
    const switched=f.turn(async (url,init)=>{ switchEntered.resolve(); await switchGate.promise; return transport('resolved',page([novelty(4,'resolved')]))(url,init); });
    await waitForTransport(switchEntered,switched);
    try { await f.configure(1,'production'); }
    finally { switchGate.resolve(); }
    assert.equal((await switched).errorCode,'HEKA_CONFIG_CHANGED');
    assert.deepEqual((await f.inbox()).rows,[]);
    assert.equal((await f.inbox()).sync.environment,'production');
    assert.deepEqual((await f.inbox({eventId:oldEvent})).rows,[]);
    const history = await f.store.db.all(`SELECT environment,guide_id FROM ${f.store.t('shipping_novelties')} ORDER BY guide_id`);
    assert.deepEqual(history.map(row=>[row.environment,row.guide_id]),[['test',idOf(3)],['test',idOf(6)]]);
    await assert.rejects(f.mark(oldEvent),{status:404});
    await f.turn(transport('open',page([novelty(5)]),{environment:'production'}));
    await f.configure(2,'production',true);
    assert.equal((await f.inbox()).sync.status,'disconnected');
    assert.deepEqual((await f.inbox()).rows.map(row=>row.guide._id),[idOf(5)]);
    assert.equal((await f.turn()).nextAt,null);
    await f.configure(3,'production');
    await f.configure(4,'production',true);
    assert.deepEqual((await f.inbox()).rows,[],'an unsynced new credential must not expose the older account');
    await assert.rejects(f.mark(randomUUID()),{status:404});
  });
}
