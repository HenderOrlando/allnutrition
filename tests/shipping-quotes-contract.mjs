import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, insertRow } from '../lib/business/commands.mjs';
import { saveHekaSettings } from '../lib/business/heka-api.mjs';
import { createShippingConnection } from '../lib/business/shipping-bridge.mjs';
import { listShippingQuoteConnections, quoteShipping } from '../lib/business/shipping-quotes.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';
import { hekaOperation, hekaShipmentInput, projectHekaResult } from '../lib/shipping/heka-api.mjs';

const key = 'only-synthetic-quote-test-key', warehouse = '68a70d2f53f7f441eff3d8f4';
const draft = {
  route:{origin:{dane:'11001000'},destination:{city:'Medellín',state:'Antioquia'},deliveryType:'office'},
  parcel:{weightG:1234,lengthMm:251,widthMm:200,heightMm:49},
  payment:{declaredMinor:2500123,collectionMinor:900013,payer:'recipient',includeShipping:true,collectionConfirmed:true},
  options:{heka:{warehouse,version:'2',channel:'hekaentrega',seller:'test-seller'}},
};
const expectedBody = {
  city_origin:'11001000',city_destination:{city:'Medellín',state:'Antioquia'},type:2,type_payment:1,
  declared_value:25001.23,collection_value:9000.13,withshipping_cost:true,
  weight:1.234,height:4.9,long:25.1,width:20,warehouse,version:'2',channel:'hekaentrega',seller:'test-seller',
};
const hekaResponse = payload => Response.json({code:200,response:payload});
const offer = input => ({
  carrier:null,service:null,total:null,amount:null,currency:null,days:null,base:null,insurance:null,
  carrierCommission:null,platformCommission:null,restrictions:[],details:[],canEmit:false,...input,
});

async function fixture(t,factory) {
  const store = await factory();
  const path = await mkdtemp(join(await realpath(tmpdir()),'shipping-quotes-'));
  t.after(async()=>{await store.close();await rm(path,{recursive:true,force:true});});
  const keyring = createIntegrationKeyring({directory:join(path,'keys'),controlDirectory:join(path,'control')});
  const id = randomUUID(), sessionTokenHash = randomUUID().replaceAll('-','').repeat(2), csrf = 'synthetic-csrf';
  await insertRow(store,'users',{id,email:`${id}@example.test`,password:'unused',active:1});
  await insertRow(store,'sessions',{token_hash:sessionTokenHash,user_id:id,expires:Date.now()+600000,csrf});
  const admin = {user:{id},sessionTokenHash,csrf};
  const configure = (version=0,environment='test')=>saveHekaSettings(store,{version,environment,apiKey:key},admin,{keyring});
  const call = (expectedConnections,transport,body={},adapters=[])=>quoteShipping(store,{scope:'all',expectedConnections,draft,...body},admin,{heka:{keyring,transport},adapters});
  return {store,admin,keyring,configure,call};
}

async function commercialState(store) {
  const rows = {};
  for (const table of ['orders','shipments','shipment_events','order_collections','cash_entries','expenses','records','shipping_preparations','heka_api_mutations','heka_api_order_links','business_requests','business_audit']) {
    const key = table==='heka_api_order_links'?'guide_id':table==='business_requests'?'scope,request_id':'id';
    rows[table] = (await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY ${key}`)).map(row=>({...row}));
  }
  return hash(rows);
}

export async function runShippingQuoteContracts(t,factory) {
  await t.test('solo se cotiza con una conexión oficial, sin crear envíos ni modificar datos comerciales',async t=>{
    const {store,admin,keyring,configure,call} = await fixture(t,factory);
    const platformId = randomUUID(), sourceId = randomUUID(), now = '2026-11-26T12:00:00.000Z';
    await insertRow(store,'platforms',{id:platformId,name:'Plataforma comercial',name_key:platformId,active:1,version:1,created_at:now,updated_at:now});
    await insertRow(store,'platform_sources',{id:sourceId,platform_id:platformId,name:'Fuente de ensayo',active:1,version:1,created_at:now,updated_at:now});
    await createShippingConnection(store,{requestId:randomUUID(),sourceId},admin.user.id,{now});
    const sent = [];
    let payload = [{distributor_id:'heka',total:0,deliveryTime:0,assured:0}];
    const transport = (url,init)=>{
      sent.push([url.href,init.method,init.headers['api-key'],JSON.parse(init.body)]);
      return payload instanceof Response ? payload : hekaResponse(payload);
    };
    assert.deepEqual(await listShippingQuoteConnections(store),{connections:[]});
    assert.deepEqual((await call([],transport)).providers,[]);
    assert.equal(sent.length,0);
    await configure();
    const {connections} = await listShippingQuoteConnections(store);
    assert.deepEqual(connections,[{id:'heka',label:'Heka',environment:'test',version:1}]);
    const before = await commercialState(store);
    await assert.rejects(()=>call([],transport),{status:409,code:'SHIPPING_QUOTE_CONFIG_CHANGED'});
    await assert.rejects(()=>call(connections,transport,{scope:'one',connectionId:'heka',environment:'production'}),{status:409});
    await assert.rejects(()=>call(connections,transport,{draft:{...draft,recipient:{name:'No enviar',phone:'3133060972'}}}),{status:400});
    await assert.rejects(()=>call(connections,transport,{draft:{...draft,options:{heka:{seller:'private@example.test'}}}}),{status:400});
    await assert.rejects(()=>call(connections,transport,{draft:{...draft,route:{...draft.route,destination:{city:'Ambigua'}}}}),{status:400,message:/municipio y su departamento/});
    await assert.rejects(()=>quoteShipping(store,{scope:'all',expectedConnections:connections,draft},{...admin,csrf:'not-the-session'},{heka:{keyring,transport}}),{code:'HEKA_SESSION'});
    assert.equal(sent.length,0);
    const result = await call(connections,transport);
    assert.ok(Number.isFinite(Date.parse(result.quotedAt)));
    assert.deepEqual(result.providers,[{...connections[0],state:'offers',offers:[offer({carrier:'heka',total:0,days:0,insurance:0,canEmit:true})]}]);
    assert.deepEqual(sent,[['https://apidev.hekaentrega.co/api/v1/shipping/quoter','POST',key,expectedBody]]);
    payload = {options:[]};
    assert.deepEqual((await call(connections,transport)).providers,[{...connections[0],state:'no_coverage',offers:[]}]);
    payload = Response.json({code:403,response:{message:'detalle privado de la cuenta'}},{status:403});
    assert.deepEqual((await call(connections,transport)).providers,[{...connections[0],state:'error',offers:[],errorCode:'HEKA_ROLE_OR_KEY'}]);
    assert.equal(await commercialState(store),before);
  });

  await t.test('dos plataformas: selección exclusiva, fallos independientes y entornos separados',async t=>{
    const {store,configure,call} = await fixture(t,factory);
    await configure();
    const sent = [];
    let environment = 'test', secondaryTimeout = true;
    const transport = (url,init)=>{
      sent.push({id:'heka',input:JSON.parse(init.body)});
      return hekaResponse([{distributor_id:'coordinadora',total:12300,currency:'COP',deliveryTime:3}]);
    };
    const second = {
      id:'synthetic',label:'Cotizador del contrato',connection:async()=>({environment,version:5}),
      prepare:({route,parcel,payment},options)=>({route,parcel,payment,options}),
      async quote(_store,_connection,input) {
        sent.push({id:'synthetic',input});
        if (secondaryTimeout) throw new DOMException('detalle no publicable','TimeoutError');
        return {state:'offers',offers:[offer({total:10,currency:'USD',days:4})]};
      },
    };
    const adapters = [second];
    const {connections} = await listShippingQuoteConnections(store,{adapters});
    assert.deepEqual(connections.map(c=>c.id),['heka','synthetic']);
    const multiDraft = {...draft,options:{...draft.options,synthetic:{rate:'fallback'}}};
    await assert.rejects(()=>call([connections[0],{...connections[1],version:4}],transport,{draft:multiDraft},adapters),{status:409});
    assert.equal(sent.length,0);
    const mixed = (await call(connections,transport,{draft:multiDraft},adapters)).providers;
    assert.deepEqual(mixed,[
      {...connections[0],state:'offers',offers:[offer({carrier:'coordinadora',total:12300,currency:'COP',days:3,canEmit:true})]},
      {...connections[1],state:'error',offers:[],errorCode:'SHIPPING_QUOTE_TIMEOUT'},
    ]);
    assert.deepEqual(sent.find(row=>row.id==='heka').input,expectedBody);
    const {collectionConfirmed,...payment} = draft.payment;
    assert.deepEqual(sent.find(row=>row.id==='synthetic').input,{
      route:{...draft.route,origin:{dane:'11001000',city:'',state:''},destination:{dane:null,city:'Medellín',state:'Antioquia'}},
      parcel:draft.parcel,payment,options:{rate:'fallback'},
    });
    assert.equal(sent.length,2);
    sent.length = 0;
    const failedSingle = await call([connections[1]],transport,{scope:'one',connectionId:'synthetic',draft:multiDraft},adapters);
    assert.equal(failedSingle.providers[0].state,'error');
    assert.deepEqual(sent.map(row=>row.id),['synthetic']);
    secondaryTimeout = false;
    const currencies = (await call(connections,transport,{draft:multiDraft},adapters)).providers.flatMap(row=>row.offers.map(item=>item.currency));
    assert.deepEqual(currencies,['COP','USD']);
    environment = 'production';
    sent.length = 0;
    const latest = (await listShippingQuoteConnections(store,{adapters})).connections;
    await assert.rejects(()=>call(latest,transport,{draft:multiDraft},adapters),{code:'SHIPPING_QUOTE_ENVIRONMENT_REQUIRED'});
    assert.equal(sent.length,0);
    assert.deepEqual((await call([latest[0]],transport,{environment:'test',draft:multiDraft},adapters)).providers.map(row=>row.id),['heka']);
    assert.deepEqual(sent.map(row=>row.id),['heka']);
  });

  await t.test('una respuesta de la configuración reemplazada no se puede ofrecer',async t=>{
    const {store,configure,call} = await fixture(t,factory);
    await configure();
    const {connections} = await listShippingQuoteConnections(store);
    let attempts = 0;
    await assert.rejects(()=>call(connections,async url=>{
      assert.equal(url.origin,'https://apidev.hekaentrega.co');
      attempts++;
      await configure(1,'production');
      return hekaResponse([{distributor_id:'heka',total:12000,currency:'COP'}]);
    }),{status:409,code:'SHIPPING_QUOTE_CONFIG_CHANGED'});
    await assert.rejects(()=>call(connections,()=>{attempts++;return hekaResponse([]);}),{status:409});
    assert.equal(attempts,1);
  });

  await t.test('proyección por campos permitidos: totales, importes, restricciones y ausencias no se confunden',()=>{
    const result = projectHekaResult('quote',[
      {distributor_id:'coordinadora',service:'Terrestre',total:0,currency:'usd',deliveryTime:2,visual_flete:0,assured:240,
        transportCommission:300,transport_commission:300,visual_heka_commission:50,restrictions:['Solo entrega en oficina','private@example.test'],
        extra:{observedNumber:42,clientName:77,document:12345,guide_number:1234,apiKey:1234,phone:3133060972}},
      {distributor_id:'envia',total:12000,currency:'$',deliveryTime:366,transportCommission:1,transport_commission:2},
      {distributor_id:'carrier-no-verificada',total:25000,currency:'COP',deliveryTime:0,transport_commission:170},
      {distributor_id:'tcc',total:0,available:false},
      {distributor_id:'servientrega',total:0,error:{message:'campo privado'}},
      {distributor_id:'heka',total:0,message:'La cotización no se pudo calcular'},
      {distributor_id:'interrapidisimo',total:-1,amount:'1',assured:0},
    ]);
    assert.deepEqual(result,{state:'offers',offers:[
      offer({carrier:'coordinadora',service:'Terrestre',total:0,currency:'USD',days:2,base:0,insurance:240,carrierCommission:300,platformCommission:50,restrictions:['Solo entrega en oficina'],details:[{path:'extra / observedNumber',value:42}],canEmit:true}),
      offer({carrier:'envia',total:12000,canEmit:true}),
      offer({total:25000,currency:'COP',days:0,carrierCommission:170}),
    ]});
    assert.deepEqual(projectHekaResult('quote',{options:[{amount:12750}]}),{state:'offers',offers:[offer({amount:12750})]});
    assert.deepEqual(projectHekaResult('quote',[{total:0,coverage:false}]),{state:'no_coverage',offers:[]});
    assert.deepEqual(projectHekaResult('quote',{options:[{total:0}],success:false}),{state:'error',offers:[]});
    assert.deepEqual(projectHekaResult('quote',{subtotal:100,customer:{phone:3133060972}}),{state:'error',offers:[],details:[{path:'subtotal',value:100}]});
  });

  await t.test('DANE y localidad por texto se pueden combinar para cotizar y preparar emisión',()=>{
    const input = hekaShipmentInput(draft);
    assert.deepEqual(hekaOperation('quote',input).input,input);
    const create = {...input,distributor_id:'coordinadora',warehouse,product:'Bulto sintético',client:{name:'Prueba',address:'Dirección sintética',phone:3000000000},collection_request:false,in_order_form:false};
    assert.deepEqual(hekaOperation('createGuide',create).input,create);
    assert.deepEqual(hekaOperation('createGuide',{...create,city_origin:{city:'Medellín'}}).input.city_origin,{city:'Medellín'});
    for (const operation of ['quote','createGuide']) {
      const data = operation==='quote' ? input : create;
      assert.throws(()=>hekaOperation(operation,{...data,city_destination:{city:'Medellín',state:'Antioquia',address:'Nunca se envía'}}),{code:'HEKA_INPUT'});
      assert.throws(()=>hekaOperation(operation,{...data,city_origin:{state:'Antioquia'}}),{code:'HEKA_INPUT'});
    }
  });
}
