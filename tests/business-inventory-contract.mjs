import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { registerReturn } from '../lib/business/collections.mjs';

const actor='inventory-contract-admin';
const requestId=()=>randomUUID();
const productData=(stockQuantity,extra={})=>({title:'Producto contado',slug:`inventory-${requestId()}`,status:'published',image:'/brand/creatina-vital-force.jpg',presentation:'Unidad',orderable:true,price:100,stockQuantity,unitCostMinor:3000,costEffectiveOn:'2026-01-01',...extra});
const product=(store,stockQuantity,extra={})=>store.save('products',productData(stockQuantity,extra));
const line=(item,quantity=1,kind='products')=>({lineId:requestId(),kind,itemId:item.id,quantity,unitPriceMinor:item.price*100,discountMinor:0});
const orderInput=(items,extra={})=>({requestId:requestId(),customerName:'Cliente de inventario',phone:'3001234567',department:'Bogotá',city:'Bogotá',address:'Dirección de inventario',placedOn:'2026-09-01',status:'new',deliveryMethod:'carrier',shippingChargeMinor:0,items,...extra});
const order=(store,items)=>store.saveOrder(orderInput(items),actor);
const shipment=(store,orderId,extra={})=>createShipment(store,{requestId:requestId(),orderId,...extra},actor);
const event=(store,current,status,extra={})=>recordShipmentEvent(store,current.id,{requestId:requestId(),version:current.version,status,occurredOn:'2026-09-02',...extra},actor);
async function balance(store,item,quantity,reserved) {
  const current=await store.get('products',item.id);
  assert.equal(current.stockQuantity,quantity,'Existencias físicas');
  assert.equal(current.stockReserved,reserved,'Unidades reservadas');
  assert.equal(current.stockAvailable,quantity===null?null:quantity-reserved,'Unidades disponibles');
  return current;
}
async function returned(store,current,quantity,condition='recoverable') {
  return registerReturn(store,{requestId:requestId(),orderId:current.id,version:current.version,occurredOn:'2026-09-03',reason:'Devolución de inventario aprobada',shippingCreditMinor:0,lines:[{lineId:current.items[0].lineId,quantity,condition}]},actor);
}
async function count(store,table) {return Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);}
async function cancel(store,current) {
  return store.saveOrder({...current,status:'cancelled',cancellationOn:'2026-09-03',statusReason:'Cancelación antes del despacho'},actor,current.id,current.version);
}

export const businessInventoryContracts=[
  ['la última unidad solo admite un pedido concurrente y el perdedor revierte todo',async store=>{
    const a=await product(store,1);
    const results=await Promise.allSettled([order(store,[line(a)]),order(store,[line(a)])]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    await balance(store,a,1,1);
    assert.equal((await store.publicData()).products.find(item=>item.id===a.id).availability,'soldout');
    assert.equal(await count(store,'orders'),1);
    const winner=results.find(result=>result.status==='fulfilled').value;
    assert.equal(winner.number,1);
    await cancel(store,await store.order(winner.id));
    await balance(store,a,1,0);
    assert.equal((await store.publicData()).products.find(item=>item.id===a.id).availability,'available');
    const next=await order(store,[line(a)]);
    assert.equal(next.number,2,'El intento rechazado no consume número de pedido');
    assert.equal(await count(store,'cash_entries'),0);
  }],
  ['producto, combo y regalo agregan demanda compartida antes de reservar atómicamente',async store=>{
    const a=await product(store,6),b=await product(store,2);
    const combo=await store.save('combos',{title:'Combo contado',slug:'combo-contado',status:'published',price:250,items:[{productId:a.id,quantity:2},{productId:b.id,quantity:1}]});
    const gift=await product(store,null,{title:'Regalo',productType:'gift',price:0,unitCostMinor:null,items:[{productId:a.id,quantity:3}]});
    const items=[line(a,2),line(combo,1,'combos'),line(gift)];
    await assert.rejects(order(store,items));
    await balance(store,a,6,0);await balance(store,b,2,0);
    assert.equal(await count(store,'orders'),0);
    items[0].quantity=1;
    const saved=await order(store,items);
    assert.equal(saved.number,1);
    await balance(store,a,6,6);await balance(store,b,2,1);
    const giftRecord=await store.get('products',gift.id);
    assert.equal(giftRecord.stockQuantity,null,'El regalo no tiene existencias físicas propias');
    assert.equal(giftRecord.stockReserved,0);
    await cancel(store,await store.order(saved.id));
    await balance(store,a,6,0);await balance(store,b,2,0);
  }],
  ['editar aumenta, reduce y cambia reservas; un exceso revierte pedido y todos los productos',async store=>{
    const a=await product(store,5),b=await product(store,1);
    let current=await order(store,[line(a,2)]);
    await balance(store,a,5,2);
    current=await store.saveOrder({...current,items:[{...current.items[0],quantity:4}]},actor,current.id,current.version);
    await balance(store,a,5,4);
    const before=await store.order(current.id),beforeA=await store.get('products',a.id),beforeB=await store.get('products',b.id);
    await assert.rejects(store.saveOrder({...before,items:[{...before.items[0],quantity:5},line(b,2)]},actor,before.id,before.version));
    assert.deepEqual(await store.order(before.id),before);
    assert.deepEqual(await store.get('products',a.id),beforeA);
    assert.deepEqual(await store.get('products',b.id),beforeB);
    current=await store.saveOrder({...before,items:[line(b)]},actor,before.id,before.version);
    await balance(store,a,5,0);await balance(store,b,1,1);
    const cancelled=await cancel(store,current);
    await balance(store,b,1,0);
    await store.saveOrder({...cancelled,notes:'Una nota después de cancelar'},actor,cancelled.id,cancelled.version);
    await balance(store,b,1,0);
  }],
  ['las reservas invalidan ediciones obsoletas de catálogo y el contador reservado es del servidor',async store=>{
    const a=await product(store,3);
    await order(store,[line(a)]);
    const reserved=await balance(store,a,3,1);
    assert.ok(reserved.version>a.version);
    await assert.rejects(store.save('products',{...a,title:'Edición obsoleta'},a.id,a.version),{status:409});
    await store.save('products',{...reserved,title:'Edición vigente',stockReserved:0},a.id,reserved.version);
    await balance(store,a,3,1);
  }],
  ['despachar parcialmente descuenta solo la asignación y los reintentos no vuelven a consumir',async store=>{
    const a=await product(store,5),payload=orderInput([line(a,4)]);
    const current=await store.saveOrder(payload,actor);
    assert.equal((await store.saveOrder(payload,actor)).id,current.id);
    await balance(store,a,5,4);
    const createInput={requestId:requestId(),orderId:current.id,assignments:[{lineId:current.items[0].lineId,quantity:2}]};
    let first=await createShipment(store,createInput,actor);
    assert.equal((await createShipment(store,createInput,actor)).id,first.id);
    await balance(store,a,5,4);
    const dispatchInput={requestId:requestId(),version:first.version,status:'collected',occurredOn:'2026-09-02',externalKey:'INVENTORY-DISPATCH'};
    first=await recordShipmentEvent(store,first.id,dispatchInput,actor);
    await balance(store,a,3,2);
    await recordShipmentEvent(store,first.id,dispatchInput,actor);
    await recordShipmentEvent(store,first.id,{...dispatchInput,requestId:requestId()},actor);
    await balance(store,a,3,2);
    await event(store,first,'delivered',{occurredOn:'2026-09-03'});
    await balance(store,a,3,2);
    const second=await shipment(store,current.id,{assignments:[{lineId:current.items[0].lineId,quantity:2}]});
    await event(store,second,'collected');
    await balance(store,a,1,0);
    assert.equal(await count(store,'cash_entries'),0);
  }],
  ['devoluciones recuperables restauran solo unidades emitidas y liberan las no despachadas',async store=>{
    const a=await product(store,5),current=await order(store,[line(a,4)]);
    let partial=await shipment(store,current.id,{assignments:[{lineId:current.items[0].lineId,quantity:2}]});
    partial=await event(store,partial,'collected');
    await balance(store,a,3,2);
    const input={requestId:requestId(),orderId:current.id,version:(await store.order(current.id)).version,occurredOn:'2026-09-03',reason:'Recuperación de unidades emitidas y cancelación de pendientes',shippingCreditMinor:0,lines:[{lineId:current.items[0].lineId,quantity:3,condition:'recoverable'}]};
    const result=await registerReturn(store,input,actor);
    await balance(store,a,5,1);
    await registerReturn(store,input,actor);
    await balance(store,a,5,1);
    await returned(store,result.order,1,'non_recoverable');
    await balance(store,a,4,0);
    assert.equal(await count(store,'cash_entries'),0);
  }],
  ['una devolución irrecuperable despachada no descuenta dos veces y una pendiente sí consume',async store=>{
    const a=await product(store,3),current=await order(store,[line(a,2)]);
    const partial=await shipment(store,current.id,{assignments:[{lineId:current.items[0].lineId,quantity:1}]});
    await event(store,partial,'collected');
    await balance(store,a,2,1);
    const first=await returned(store,await store.order(current.id),1,'non_recoverable');
    await balance(store,a,2,1);
    await returned(store,first.order,1,'non_recoverable');
    await balance(store,a,1,0);
  }],
  ['existencias desconocidas y cero se distinguen públicamente pero ninguna permite vender',async store=>{
    const unknown=await product(store,null),zero=await product(store,0);
    await balance(store,unknown,null,0);await balance(store,zero,0,0);
    const publicProducts=(await store.publicData()).products;
    assert.equal(publicProducts.find(item=>item.id===unknown.id).availability,'consult');
    assert.equal(publicProducts.find(item=>item.id===zero.id).availability,'soldout');
    for(const item of publicProducts)for(const key of ['stockQuantity','stockReserved','stockAvailable'])assert.equal(Object.hasOwn(item,key),false);
    await assert.rejects(order(store,[line(unknown)]));await assert.rejects(order(store,[line(zero)]));
    assert.equal(await count(store,'orders'),0);
    const counted=await store.save('products',{...unknown,stockQuantity:1},unknown.id,unknown.version);
    await order(store,[line(counted)]);
    await balance(store,counted,1,1);
  }],
  ['despacho y devolución usan la composición histórica aunque cambie el combo y el regalo',async store=>{
    const a=await product(store,10),b=await product(store,10);
    const combo=await store.save('combos',{title:'Combo histórico',slug:'combo-historico',status:'published',price:200,items:[{productId:a.id,quantity:2}]});
    const gift=await product(store,null,{productType:'gift',price:0,unitCostMinor:null,items:[{productId:a.id,quantity:3}]});
    let current=await order(store,[line(combo,1,'combos'),line(gift)]);
    await balance(store,a,10,5);await balance(store,b,10,0);
    await store.save('combos',{...combo,items:[{productId:b.id,quantity:4}]},combo.id,combo.version);
    const actualGift=await store.get('products',gift.id);
    await store.save('products',{...actualGift,items:[{productId:b.id,quantity:2}]},gift.id,actualGift.version);
    current=await store.saveOrder({...current,notes:'Conservar composición histórica'},actor,current.id,current.version);
    await balance(store,a,10,5);await balance(store,b,10,0);
    const sent=await shipment(store,current.id);
    await event(store,sent,'collected');
    await balance(store,a,5,0);await balance(store,b,10,0);
    current=await store.order(current.id);
    await registerReturn(store,{requestId:requestId(),orderId:current.id,version:current.version,occurredOn:'2026-09-03',reason:'Recuperar composición histórica',shippingCreditMinor:0,lines:current.items.map(item=>({lineId:item.lineId,quantity:1,condition:'recoverable'}))},actor);
    await balance(store,a,10,0);await balance(store,b,10,0);
  }],
  ['corregir un despacho revierte su consumo y volver a confirmarlo lo aplica una sola vez',async store=>{
    const a=await product(store,2),current=await order(store,[line(a)]);
    let sent=await shipment(store,current.id);
    sent=await event(store,sent,'collected');
    await balance(store,a,1,0);
    const original=sent.events.find(item=>item.status==='collected');
    sent=await event(store,sent,'unknown',{correctionOf:original.id,reason:'La recogida no ocurrió'});
    await balance(store,a,2,1);
    const correction=sent.events.find(item=>item.correctionOf===original.id);
    sent=await event(store,sent,'collected',{correctionOf:correction.id,reason:'Recogida real comprobada'});
    await balance(store,a,1,0);
    const restored=sent.events.find(item=>item.correctionOf===correction.id);
    await event(store,sent,'collected',{correctionOf:restored.id,reason:'Solo corregir fecha',occurredOn:'2026-09-03'});
    await balance(store,a,1,0);
    assert.equal(await count(store,'cash_entries'),0);
  }],
  ['un reenvío reserva y consume unidades adicionales sin borrar el primer despacho',async store=>{
    const a=await product(store,2),current=await order(store,[line(a)]);
    let original=await shipment(store,current.id);
    original=await event(store,original,'collected');
    await balance(store,a,1,0);
    const replacementInput={requestId:requestId(),orderId:current.id,replacesShipmentId:original.id};
    let replacement=await createShipment(store,replacementInput,actor);
    await balance(store,a,1,1);
    await createShipment(store,replacementInput,actor);
    await balance(store,a,1,1);
    replacement=await event(store,replacement,'collected');
    await balance(store,a,0,0);
    await assert.rejects(shipment(store,current.id,{replacesShipmentId:replacement.id}));
    await balance(store,a,0,0);
    assert.equal((await store.order(current.id)).shipments.length,2);
    assert.equal(await count(store,'cash_entries'),0);
  }],
  ['una devolución pendiente no absorbe el consumo de un despacho posterior ni permite reenviar unidades cerradas',async store=>{
    const a=await product(store,5),current=await order(store,[line(a,3)]);
    await returned(store,current,1,'recoverable');
    await balance(store,a,5,2);
    let first=await shipment(store,current.id,{assignments:[{lineId:current.items[0].lineId,quantity:1}]});
    first=await event(store,first,'collected');
    await balance(store,a,4,1);
    const excessive=await shipment(store,current.id,{assignments:[{lineId:current.items[0].lineId,quantity:2}]});
    await assert.rejects(event(store,excessive,'collected'),{status:409});
    await balance(store,a,4,1);
    assert.equal((await store.order(current.id)).shipments.find(item=>item.id===excessive.id).events.length,0);
  }],
];
