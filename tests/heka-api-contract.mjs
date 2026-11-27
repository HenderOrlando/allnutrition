import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
import { migrateHekaApiV15 } from '../lib/db/migrations.mjs';
import { getHekaSettings, listHekaMutations, operateHeka, saveHekaSettings } from '../lib/business/heka-api.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { importData } from '../lib/import.mjs';
import { getShipment, recordShipmentEvent, saveShipment } from '../lib/business/shipments.mjs';

const KEY = 'official-synthetic-key-not-a-credential';
const GUIDE_ID = '68ad416c3c792ac4658caf48', GUIDE_NO = '2400549638853', NOVELTY_ID = '66f1a2b3c4d5e6f7a8b9c0d1', WAREHOUSE = '68a70d2f53f7f441eff3d8f4';
const CARE = 'PRIVATE CLIENT ADDRESS IN SOLUTION';
const guide = { _id:GUIDE_ID,guide_number:GUIDE_NO,distributor_id:'coordinadora',status:'created' };
const quote = { city_origin:'11001000',city_destination:'05001000',type_payment:3,declared_value:25000,weight:3,height:5,long:5,width:5,withshipping_cost:false,collection_value:0 };
const shipment = { ...quote,type:1,distributor_id:'coordinadora',quantity:1,product:'Anillo',warehouse:WAREHOUSE,client:{ name:'Private Client',address:'Private Address',phone:3133060972,document:'123456' },in_order_form:false,collection_request:false };
const json = (response, code=200, status=code) => Response.json({code,response},{status});
const page = rows => ({rows,pager:{total:rows.length,pages:1,page:1,nextPage:null,previousPage:null}});
const pdf = Buffer.from('%PDF-1.7\n%test\n%%EOF\n');

async function session(store) {
  const actor = randomUUID(), token = 'b'.repeat(64), csrf = 'synthetic-csrf';
  await insertRow(store,'users',{id:actor,email:`${actor}@example.test`,password:'unused',active:1});
  await insertRow(store,'sessions',{token_hash:token,user_id:actor,expires:Date.now()+600000,csrf});
  return {user:{id:actor},sessionTokenHash:token,csrf};
}
async function setup(t,factory) {
  const dir = await mkdtemp(join(await realpath(tmpdir()),'heka-api-'));
  const directory = join(dir,'secrets'), keyring = createIntegrationKeyring({directory,controlDirectory:join(dir,'control')});
  const store = await factory();
  t.after(async () => { await store.close(); await rm(dir,{recursive:true,force:true}); });
  const admin = await session(store), options = {keyring};
  const configure = (version=0,environment='test',apiKey=KEY) => saveHekaSettings(store,{version,environment,apiKey},admin,options);
  const call = (operation,input,transport,body={}) => operateHeka(store,{operation,input,environment:'test',version:1,...body},admin,{...options,transport});
  return {store,dir,directory,keyring,admin,options,configure,call};
}
function upstream(path, method, result, {query = '',body,production=false}={}) {
  return (url,init) => {
    assert.equal(url.href,`https://${production?'api':'apidev'}.hekaentrega.co/api/v1${path}${query}`);
    assert.equal(init.method,method);
    assert.equal(init.headers['api-key'],KEY);
    assert.equal(init.headers.Authorization,undefined);
    assert.equal(init.redirect,'error');
    assert.equal(init.cache,'no-store');
    assert.deepEqual(init.body===undefined?undefined:JSON.parse(init.body),body);
    return json(result);
  };
}
const uncalled = () => { assert.fail('No debe salir una solicitud a Heka'); };

export async function runHekaApiContracts(t,factory) {
  await t.test('v15 y custodia privada; la sesión y la versión cercan toda consulta antes de enviar',async t=>{
    const {store,dir,directory,admin,options,configure,call} = await setup(t,factory);
    assert.deepEqual(await migrateHekaApiV15(store),{migrated:false,version:15});
    assert.deepEqual(await getHekaSettings(store),{configured:false,environment:'test',version:0});
    assert.deepEqual(await readdir(dir),[]);
    await assert.rejects(()=>configure(0,'https://example.test'),{code:'HEKA_INPUT'});
    await assert.rejects(()=>operateHeka(store,{operation:'check',input:{},environment:'test',version:0},{...admin,sessionTokenHash:'a'.repeat(64)},{...options,transport:uncalled}),{code:'HEKA_SESSION'});
    assert.deepEqual(await configure(),{configured:true,environment:'test',version:1});
    const stored = await store.db.get(`SELECT * FROM ${store.t('heka_api_settings')}`);
    assert.ok(stored.ciphertext && !JSON.stringify(stored).includes(KEY));
    assert.equal((await stat(directory)).mode&0o777,0o700);
    const path = join(directory,'heka.key'), file = await stat(path);
    assert.equal(file.mode&0o777,0o600);
    assert.equal(file.size,32);
    await assert.rejects(()=>call('check',{},uncalled,{environment:'production'}),{code:'HEKA_CONFIG_CHANGED'});
    await assert.rejects(()=>call('check',{},uncalled,{version:0}),{code:'HEKA_CONFIG_CHANGED'});
    const checked = await call('check',{},upstream('/warehouse','GET',null,{query:'?limit=1'}));
    assert.deepEqual(checked.data.result,{verified:true});
    await chmod(path,0o644);
    await assert.rejects(()=>call('check',{},uncalled),{code:'INTEGRATION_KEY_UNSAFE'});
    await unlink(path);
    await assert.rejects(()=>configure(1),{code:'INTEGRATION_KEY_MISSING'});
    assert.deepEqual(await saveHekaSettings(store,{version:1},admin,{...options,clear:true}),{configured:false,environment:'test',version:2});
  });

  await t.test('rutas, parámetros oficiales y proyecciones de lectura limitadas',async t=>{
    const {configure,call} = await setup(t,factory);
    await configure();
    const checks = [
      ['cities',{label:'Bogotá & Norte'},'/geolocation/city','GET','?label=Bogot%C3%A1+%26+Norte',page([{_id:GUIDE_ID,label:'Bogotá',dane:'11001000',secret:KEY}]),result=>assert.equal(result.rows[0].dane,'11001000')],
      ['warehouses',{status:'active'},'/warehouse','GET','?status=active',page([{_id:WAREHOUSE,name:'Bodega',status:'active'}]),result=>assert.equal(result.rows[0]._id,WAREHOUSE)],
      ['templates',{},'/shipping/template','GET','',[{_id:GUIDE_ID,label:'Bodega',weight:3}],result=>assert.equal(result[0].weight,3)],
      ['quote',quote,'/shipping/quoter','POST','',{unknown:{observedNumber:4500,phone:3133060972,token:KEY}},result=>assert.deepEqual(result,{state:'error',offers:[],details:[{path:'unknown / observedNumber',value:4500}]})],
      ['guides',{text:GUIDE_NO},'/shipments/guide/v2/external','GET',`?text=${GUIDE_NO}`,page([{...guide,client:{name:'Private Client'}}]),result=>assert.deepEqual(result.rows[0],guide)],
      ['clientHistory',{phone:3133060972},'/shipments/client-log','GET','?phone=3133060972',page([{name:'N*** C***',document:'***345',phone:3133060972,guide_number:GUIDE_NO}]),result=>assert.deepEqual(result.rows[0],{name:'N*** C***',document:'***345',guide_number:GUIDE_NO})],
      ['clientRating',{phone:3133060972,limit:1},'/shipments/guide/client','GET','?phone=3133060972&limit=1',null,result=>assert.equal(result,null)],
      ['novelties',{guide_number:GUIDE_NO},'/shipments/novelty','GET',`?guide_number=${GUIDE_NO}`,page([{...guide,client:{email:'private@example.test'},movemens:[{label:'Novedad',status:'distribution'}],last_novelty:{_id:NOVELTY_ID,solution:CARE}}]),result=>assert.deepEqual(result.rows[0].last_novelty,{_id:NOVELTY_ID})],
    ];
    for (const [name,input,path,method,query,response,verify] of checks) {
      const result = (await call(name,input,upstream(path,method,response,{query,body:method==='POST'?input:undefined}))).data.result;
      verify(result);
      assert.doesNotMatch(JSON.stringify(result),/synthetic-key|Private Client|private@example|PRIVATE CLIENT/);
    }
    const batch = {type:'guide',guides:[GUIDE_ID,WAREHOUSE]};
    assert.deepEqual((await call('sticker',batch,upstream('/documents/sticker','POST',pdf.toString('base64'),{query:'?type=guide',body:{guides:batch.guides}}))).pdf,pdf);
    assert.deepEqual((await call('sticker',{type:'document',id:GUIDE_ID},upstream('/documents/sticker','POST',pdf.toString('base64'),{query:`?type=document&id=${GUIDE_ID}`}))).pdf,pdf);
    await assert.rejects(()=>call('sticker',batch,upstream('/documents/sticker','POST',Buffer.from('<html>oops</html>').toString('base64'),{query:'?type=guide',body:{guides:batch.guides}})),{code:'HEKA_RESPONSE'});
    await assert.rejects(()=>call('cancel',{},uncalled),{code:'HEKA_INPUT'});
    await assert.rejects(()=>call('clientHistory',{},uncalled),{code:'HEKA_INPUT'});
    await assert.rejects(()=>call('guides',{limit:51},uncalled),{code:'HEKA_INPUT'});
    await assert.rejects(()=>call('warehouses',{start_date:'2026-09-27'},uncalled),{code:'HEKA_INPUT'});
    await assert.rejects(()=>call('novelties',{},()=>json({message:`provider private ${KEY}`},403)),error=>error.status===403 && error.code==='HEKA_ROLE_OR_KEY' && /seller/.test(error.message) && !error.message.includes(KEY));
  });

  await t.test('creación con UUID y una sola llamada concurrente; incertidumbre sobrevive copia y exige evidencia',async t=>{
    const {store,keyring,admin,options,configure,call} = await setup(t,factory);
    await configure();
    const requestId = randomUUID(), body = {requestId,confirm:true};
    await assert.rejects(()=>call('createGuide',shipment,uncalled,{requestId}),{code:'HEKA_CONFIRM_REQUIRED'});
    let entered, release;
    const waiting = new Promise(resolve=>{entered=resolve;}), resumed = new Promise(resolve=>{release=resolve;});
    const first = call('createGuide',shipment,async (url,init)=>{
      upstream('/shipments/guide','POST',guide,{body:shipment})(url,init);
      entered(); await resumed; throw new Error(`private provider error ${KEY}`);
    },body);
    try {
      await Promise.race([waiting,first.then(()=>assert.fail('No llegó al proveedor'))]);
      assert.equal((await call('createGuide',shipment,uncalled,body)).data.mutation.state,'sending');
      await assert.rejects(()=>call('createGuide',shipment,uncalled,{...body,requestId:randomUUID()}),{code:'HEKA_RECONCILE_REQUIRED'});
      await assert.rejects(()=>configure(1,'production'),{code:'HEKA_WRITE_IN_PROGRESS'});
      const bundle = await store.exportData(), evidence = bundle.hekaEvidence.mutations[0];
      assert.equal(evidence.state,'uncertain');
      assert.equal(evidence.id,requestId);
      assert.doesNotMatch(JSON.stringify(bundle),/Private Client|Private Address|3133060972|synthetic-key|ciphertext|lease_until/);
      const restore = await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
      try {
        const restoredAdmin = await session(restore);
        await importData(restore,bundle);
        assert.deepEqual(await getHekaSettings(restore),{configured:false,environment:'test',version:0});
        assert.equal((await listHekaMutations(restore)).mutations[0].state,'uncertain');
        assert.deepEqual(await restore.db.all(`SELECT * FROM ${restore.t('job_runs')} WHERE key LIKE 'heka-api:%'`),[]);
        await saveHekaSettings(restore,{version:0,environment:'test',apiKey:KEY},restoredAdmin,{keyring});
        await assert.rejects(()=>operateHeka(restore,{...body,requestId:randomUUID(),operation:'createGuide',input:shipment,environment:'test',version:1},restoredAdmin,{keyring,transport:uncalled}),{code:'HEKA_RECONCILE_REQUIRED'});
        await assert.rejects(()=>importData(restore,bundle),/vacío/);
      } finally { await restore.close(); }
    } finally { release(); }
    const failed = await first;
    assert.equal(failed.status,202); assert.equal(failed.data.mutation.state,'uncertain');
    assert.equal((await call('createGuide',shipment,uncalled,body)).data.mutation.state,'uncertain');
    const reconcile = {requestId,guideId:GUIDE_ID,guideNumber:GUIDE_NO};
    await assert.rejects(()=>call('reconcile',reconcile,uncalled),{code:'HEKA_CONFIRM_REQUIRED'});
    await assert.rejects(()=>call('reconcile',reconcile,upstream('/shipments/guide/v2/external','GET',{...guide,guide_number:'012'},{query:`?id=${GUIDE_ID}&limit=1&distributor_id=coordinadora`}),{confirm:true}),{code:'HEKA_NO_EVIDENCE'});
    await configure(1,'test','rotated-fake-key');
    await assert.rejects(()=>call('reconcile',reconcile,uncalled,{confirm:true,version:2}),{code:'HEKA_RECONCILE_KEY'});
    await saveHekaSettings(store,{version:2},admin,{...options,clear:true});
    assert.equal((await listHekaMutations(store)).mutations[0].state,'uncertain');
    await configure(3);
    const recovered = await call('reconcile',reconcile,upstream('/shipments/guide/v2/external','GET',page([guide]),{query:`?id=${GUIDE_ID}&limit=1&distributor_id=coordinadora`}),{confirm:true,version:4});
    assert.equal(recovered.status,200); assert.deepEqual(recovered.data.result,guide); assert.ok(recovered.data.mutation.reconciledAt);
    assert.equal((await call('createGuide',shipment,uncalled,{...body,version:4})).data.mutation.state,'succeeded');
    await assert.rejects(()=>call('createGuide',{...shipment,quantity:2},uncalled,{...body,version:4}),{code:'HEKA_REQUEST_CONFLICT'});
  });

  await t.test('novedades usan rol vendedor, ID de novedad, verificación de guía y solución comprometida',async t=>{
    const {store,configure,call} = await setup(t,factory);
    await configure();
    const body = {requestId:randomUUID(),confirm:true}, lookup = `?id=${GUIDE_ID}&limit=1`;
    const action = {guideId:GUIDE_ID,id:NOVELTY_ID,solution:CARE};
    const nov = {...guide,status_novelty:'in_novelty',last_novelty:{_id:NOVELTY_ID,solution:null,last_status:'distribution'}};
    const attempt = await call('solveNovelty',action,(url,init)=>{
      if (init.method==='GET') return upstream('/shipments/novelty','GET',nov,{query:lookup})(url,init);
      upstream(`/shipments/novelty/${NOVELTY_ID}`,'PATCH',null,{body:{solution:CARE}})(url,init);
      return json({message:CARE},503);
    },body);
    assert.equal(attempt.data.mutation.state,'uncertain');
    assert.doesNotMatch(JSON.stringify(await store.exportData()),/PRIVATE CLIENT/);
    const read = solution => upstream('/shipments/novelty','GET',{...nov,status_novelty:'in_review',last_novelty:{...nov.last_novelty,solution}},{query:lookup});
    await assert.rejects(()=>call('reconcile',{requestId:body.requestId},read('otra solución'),{confirm:true}),{code:'HEKA_NO_EVIDENCE'});
    const recovery = await call('reconcile',{requestId:body.requestId},read(CARE),{confirm:true});
    assert.equal(recovery.status,200); assert.equal(recovery.data.mutation.state,'succeeded');
    assert.doesNotMatch(JSON.stringify(await listHekaMutations(store)),/PRIVATE CLIENT/);
  });

  await t.test('guía oficial confirmada se vincula una sola vez y el estado remoto no mueve caja ni entrega',async t=>{
    const {store,admin,configure,call} = await setup(t,factory);
    const actor = admin.user.id;
    const product = await store.save('products',{title:'Producto Heka',slug:'producto-heka',status:'draft',orderable:true,presentation:'Unidad',price:100,stockQuantity:20,unitCostMinor:3000,costEffectiveOn:'2026-01-01'});
    const createOrder = () => store.saveOrder({requestId:randomUUID(),customerName:'Prueba logística',phone:'3000000000',city:'Bogotá',department:'Bogotá',address:'Dirección de prueba',placedOn:'2026-09-01',status:'new',deliveryMethod:'carrier',shippingChargeMinor:1000,items:[{lineId:'line-a',kind:'products',itemId:product.id,quantity:1,unitPriceMinor:10000,discountMinor:0}]},actor);
    const order = await createOrder(), other = await createOrder();
    const num = value=>Number(value.number);
    const input = {orderNumber:num(order),guideId:GUIDE_ID,guideNumber:GUIDE_NO,carrier:guide.distributor_id};
    const body = {requestId:randomUUID(),confirm:true,environment:'production'};
    await assert.rejects(()=>call('linkGuide',input,uncalled,{...body,environment:'test'}),{code:'HEKA_LINK_PRODUCTION'});
    await configure(0,'production');
    await assert.rejects(()=>call('linkGuide',input,uncalled,{...body,confirm:false}),{code:'HEKA_CONFIRM_REQUIRED'});
    const create = await call('createGuide',shipment,upstream('/shipments/guide','POST',guide,{body:shipment,production:true}),{...body,requestId:randomUUID()});
    assert.deepEqual(create.data.result,guide);
    const counts = async () => Promise.all(['cash_entries','order_collections','settlement_receipts','expenses','shipment_events'].map(table=>store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`).then(row=>Number(row.n))));
    const baseline = await counts();
    const query = `?id=${GUIDE_ID}&limit=1&distributor_id=coordinadora`;
    const lookup = result => upstream('/shipments/guide/v2/external','GET',result,{query,production:true});
    await assert.rejects(()=>call('linkGuide',input,lookup({...guide,guide_number:'different'}),body),{code:'HEKA_NO_EVIDENCE'});
    const missingCarrier = {_id:GUIDE_ID,guide_number:GUIDE_NO,status:'finished'};
    const wrongCarrierQuery = `?id=${GUIDE_ID}&limit=1&distributor_id=tcc`;
    await assert.rejects(()=>call('linkGuide',{...input,carrier:'tcc'},upstream('/shipments/guide/v2/external','GET',missingCarrier,{query:wrongCarrierQuery,production:true}),body),{code:'HEKA_NO_EVIDENCE'});
    await assert.rejects(()=>call('linkGuide',input,lookup({...missingCarrier,distributor_id:'tcc'}),body),{code:'HEKA_NO_EVIDENCE'});
    const otherId = '68ad416c3c792ac4658caf49';
    await assert.rejects(()=>call('linkGuide',{...input,guideId:otherId},upstream('/shipments/guide/v2/external','GET',{...missingCarrier,_id:otherId},{query:`?id=${otherId}&limit=1&distributor_id=coordinadora`,production:true}),body),{code:'HEKA_NO_EVIDENCE'});
    const {result:linked} = (await call('linkGuide',input,lookup(missingCarrier),body)).data;
    assert.equal(linked.orderId,order.id);
    assert.equal(linked.providerStatus,'finished');
    const physical = await getShipment(store,linked.shipmentId);
    assert.equal(physical.status,'unknown');
    assert.equal(physical.tracking,GUIDE_NO);
    assert.deepEqual(physical.events,[]);
    assert.deepEqual(await counts(),baseline);
    assert.equal((await store.order(order.id)).status,'new');
    assert.deepEqual((await call('linkGuide',input,lookup({...guide,status:'finished'}),body)).data.result,linked);
    await assert.rejects(()=>call('linkGuide',{...input,orderNumber:num(other)},lookup(guide),{...body,requestId:randomUUID()}),{code:'HEKA_GUIDE_LINKED'});
    await assert.rejects(()=>saveShipment(store,{requestId:randomUUID(),version:physical.version,tracking:'changed'},actor,physical.id),/inmutable/);
    const search = await call('guides',{id:GUIDE_ID},upstream('/shipments/guide/v2/external','GET',page([{...guide,status:'novelty'}]),{query:`?id=${GUIDE_ID}`,production:true}),{environment:'production'});
    assert.equal(search.data.result.rows[0].localLink.providerStatus,'novelty');
    assert.equal(search.data.result.rows[0].localLink.shipmentId,physical.id);
    const savedReceipt = (await listHekaMutations(store)).mutations.find(row=>row.requestId===create.data.mutation.requestId);
    assert.equal(savedReceipt.result.localLink.shipmentId,physical.id);
    assert.equal(savedReceipt.result.localLink.providerStatus,'created');
    assert.equal((await getShipment(store,physical.id)).status,'unknown');
    const explicit = await recordShipmentEvent(store,physical.id,{requestId:randomUUID(),version:physical.version,status:'in_transit',occurredOn:'2026-09-02',rawStatus:'in_transit',detail:'Evento confirmado por el operador'},actor);
    assert.equal(explicit.status,'in_transit');
    assert.deepEqual((await counts()).slice(0,4),baseline.slice(0,4));
    const bundle = await store.exportData();
    assert.ok(bundle.business.business_audit.some(row=>row.entity_type==='heka_guide_link' && row.entity_id===GUIDE_ID));
    assert.equal(bundle.hekaEvidence.orderLinks[0].shipment_id,physical.id);
    assert.equal(bundle.hekaEvidence.orderLinks[0].provider_status,'finished');
    const restored = await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
    try {
      const malformed = structuredClone(bundle);
      malformed.hekaEvidence.orderLinks[0].order_id = other.id;
      await assert.rejects(()=>importData(restored,malformed),/evidencia de envíos de Heka/);
      await importData(restored,bundle);
      assert.deepEqual((await restored.exportData()).hekaEvidence,bundle.hekaEvidence);
      assert.equal((await getShipment(restored,physical.id)).status,'in_transit');
    } finally { await restored.close(); }
  });

  await t.test('cuotas compartidas y fallo seguro sin reintento HTTP de escritura',async t=>{
    const {configure,call} = await setup(t,factory);
    await configure();
    let sent=0;
    for (let i=0;i<10;i++) await call('clientRating',{phone:3133060972},()=>{sent++;return json(null);});
    await assert.rejects(()=>call('clientRating',{phone:3133060972},uncalled),{code:'HEKA_LOCAL_LIMIT'});
    assert.equal(sent,10);
    const body={requestId:randomUUID(),confirm:true};
    let attempts=0;
    const rejection=await call('createGuide',shipment,()=>{attempts++;return json({message:'private'},403);},body);
    assert.equal(rejection.status,403); assert.equal(rejection.data.mutation.state,'rejected');
    assert.equal((await call('createGuide',shipment,uncalled,body)).data.mutation.state,'rejected');
    assert.equal(attempts,1);
  });
}
