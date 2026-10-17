import test from 'node:test';
import assert from 'node:assert/strict';
import { openSQLite } from '../lib/db/sqlite.mjs';
import { Store } from '../lib/store.mjs';
import { migrateBusinessV3 } from '../lib/db/migrations.mjs';
import { snapshotCatalogItem, completeOrderCosts } from '../lib/business/catalog.mjs';
import { validateRecord } from '../lib/validation.mjs';
import { emptyRecord } from '../lib/schema.mjs';

const product = (slug,extra={}) => ({title:slug,slug,status:'draft',stockQuantity:10000,price:100,image:'',presentation:'Unidad',...extra});
async function fixture(t) {
  const store = new Store(await openSQLite(':memory:'));
  t.after(()=>store.close());
  await store.initialize(); await migrateBusinessV3(store);
  return store;
}
test('optional minor cost preserves blank, unknown and explicit zero',()=>{
  assert.equal(validateRecord('products',product('a',{unitCostMinor:''})).unitCostMinor,null);
  assert.equal(emptyRecord('products').unitCostMinor,null);
  assert.equal(emptyRecord('products').costEffectiveOn,null);
  assert.equal(emptyRecord('products').productType,'product');
  assert.deepEqual(emptyRecord('products').items,[]);
  assert.equal(validateRecord('products',product('a',{unitCostMinor:0})).unitCostMinor,0);
  assert.equal(validateRecord('products',product('a')).orderable,false);
});
test('historical component costs are resolved by date without changing prior snapshots',async t=>{
  const store = await fixture(t);
  let a = await store.save('products',product('a',{orderable:true,unitCostMinor:2300,costEffectiveOn:'2026-08-01'}));
  const b = await store.save('products',product('b',{orderable:true}));
  const gift = await store.save('products',product('gift',{productType:'gift',price:0,items:[{productId:a.id,quantity:2},{productId:b.id,quantity:1}]}));
  const missing = await snapshotCatalogItem(store,'products',gift.id,'2026-09-01');
  assert.equal(missing.unitCostMinor,null);
  const before = await snapshotCatalogItem(store,'products',a.id,'2026-09-01');
  a = await store.save('products',{...a,unitCostMinor:3000,costEffectiveOn:'2026-10-01'},a.id,a.version);
  assert.equal(before.unitCostMinor,2300);
  assert.equal((await snapshotCatalogItem(store,'products',a.id,'2026-09-01')).unitCostMinor,2300);
  assert.equal((await snapshotCatalogItem(store,'products',a.id,'2026-10-01')).unitCostMinor,3000);
  assert.equal((await snapshotCatalogItem(store,'products',a.id,'2026-07-01')).unitCostMinor,null);
  await assert.rejects(store.save('products',{...a,items:[{productId:a.id,quantity:1}]}));
});
test('SKU, component restrictions, unavailable components and public privacy',async t=>{
  const store = await fixture(t);
  const a = await store.save('products',product('a',{status:'published',image:'/brand/logo.jpg',sku:'ABC',stockQuantity:0,unitCostMinor:0,costEffectiveOn:'2026-01-01'}));
  await assert.rejects(store.save('products',product('duplicate',{sku:'ABC'})));
  const gift = await store.save('products',product('gift',{productType:'gift',price:0,items:[{productId:a.id,quantity:2}]}));
  assert.equal(gift.orderable,true);
  assert.equal((await snapshotCatalogItem(store,'products',gift.id,'2026-09-01')).unitCostMinor,0);
  await assert.rejects(store.save('products',product('nested',{productType:'gift',items:[{productId:gift.id,quantity:1}]})));
  await assert.rejects(store.remove('products',a.id,a.version));
  const publicProduct = (await store.publicData()).products[0];
  for (const key of ['sku','unitCostMinor','costEffectiveOn','orderable','productType','items','stockQuantity','stockReserved','stockAvailable']) assert.equal(Object.hasOwn(publicProduct,key),false);
  assert.equal(publicProduct.price,100);
  await store.save('products',{...a,orderable:false},a.id,a.version);
  await assert.rejects(snapshotCatalogItem(store,'products',gift.id,'2026-09-01'));
  assert.equal((await snapshotCatalogItem(store,'products',gift.id,'2026-09-01',{allowUnavailable:true})).unitCostMinor,0);
});

test('cost completion preserves agreement and updates recoveries atomically and idempotently',async t=>{
  const store = await fixture(t), at = '2026-09-01T12:00:00.000Z';
  const data = {placedOn:'2026-09-01',status:'delivered',recognition:{on:'2026-09-03'},subtotalMinor:10000,shippingChargeMinor:0,totalMinor:10000,items:[{lineId:'line-a',kind:'products',productType:'product',itemId:'historical',quantity:2,unitPriceMinor:5000,discountMinor:0,unitCostMinor:null,components:[]}]};
  await store.db.run('INSERT INTO orders(id,number,data,created_at,updated_at) VALUES(?,?,?,?,?)',['order-a',1,JSON.stringify(data),at,at]);
  await store.db.run('INSERT INTO order_returns(id,order_id,occurred_on,reason,kind,recorded_at,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',['return-a','order-a','2026-10-02','Retorno','return',at,JSON.stringify({shippingCreditMinor:0,lines:[{lineId:'line-a',quantity:1,salesCreditMinor:5000,condition:'recoverable',recoveredCostMinor:null}]}),at,at]);
  const input = {orderId:'order-a',version:1,requestId:'cost-fix-0001',reason:'Completar costo histórico',lineCosts:[{lineId:'line-a',unitCostMinor:2300}]};
  const result = await completeOrderCosts(store,input,'admin');
  assert.equal(result.items[0].unitCostMinor,2300);
  assert.equal(result.totalMinor,10000);
  assert.equal(result.items[0].unitPriceMinor,5000);
  assert.equal(JSON.parse((await store.db.get('SELECT data FROM order_returns WHERE id=?',['return-a'])).data).lines[0].recoveredCostMinor,2300);
  assert.deepEqual(await completeOrderCosts(store,input,'admin'),result);
  await assert.rejects(completeOrderCosts(store,{...input,requestId:'cost-fix-0002'},'admin'));
});
