import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { emptyRecord } from '../lib/schema.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { getBusinessSettings, saveBusinessSettings, saveResource, listResources } from '../lib/business/settings.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollection, registerReturn, recordRefund } from '../lib/business/collections.mjs';
import { recordExpense, payExpense } from '../lib/business/expenses.mjs';
import { saveSettlement, confirmSettlement } from '../lib/business/settlements.mjs';
import { confirmPayroll, payPayroll } from '../lib/business/payroll.mjs';
export const requestId=()=>randomUUID();
export const fixtureActor='business-fixture-admin';
export function completedFixtureYear(now=new Date()) {const today=bogotaDate(now);return Number(today.slice(0,4))-(today.slice(5)<'10-03'?1:0);}
export const businessOrderInput=(product,{year=completedFixtureYear(),...extra}={})=>({requestId:requestId(),placedOn:`${year}-09-01`,customerName:'Destinatario sintético',phone:'3001234567',city:'Bogotá',department:'Bogotá',address:'Dirección sintética',status:'preparing',sellerId:null,deliveryMethod:'carrier',shippingChargeMinor:1200000,items:[{lineId:requestId(),kind:'products',itemId:product.id,quantity:1,unitPriceMinor:product.price*100,discountMinor:0}],...extra});
export async function createBusinessBasics(store,{year=completedFixtureYear(),actorId=fixtureActor,reportsStartOn=bogotaDate(),withPlatform=true}={}) {
  const person=await saveResource(store,'people',{requestId:requestId(),name:'Vendedor V',salaryAgreements:[{id:'salary-september',enabled:true,amountPerPeriodMinor:1000000,frequency:'monthly',effectiveFrom:`${year}-09-01`,effectiveTo:`${year}-09-30`,payDayOffset:0}]},actorId);
  const settings=await getBusinessSettings(store);
  await saveBusinessSettings(store,{...settings,requestId:requestId(),reportsStartOn,rulesVersions:[{id:'rules-september',effectiveOn:`${year}-09-01`,saleRecognition:'delivered',commission:{enabled:true,mode:'percent',rateBps:500,fixedMinor:0,basis:'net_products',earnWhen:'business_received'},shippingExpenseDate:'dispatch_date',returnExpenseDate:'charge_date',platformFeeExpenseDate:'charge_date'}]},actorId);
  const account=await saveAccount(store,{requestId:requestId(),name:'Banco sintético',type:'bank',openingOn:`${year}-09-01`,openingBalanceMinor:10000000,responsibleId:person.id},actorId);
  const a=await store.save('products',{...emptyRecord('products'),title:'Producto A',slug:'fixture-product-a',status:'published',image:'/brand/creatina-vital-force.jpg',presentation:'Unidad A',price:55000,stockQuantity:10000,unitCostMinor:2300000,costEffectiveOn:`${year}-08-01`},null,null,actorId);
  const b=await store.save('products',{...emptyRecord('products'),title:'Producto B',slug:'fixture-product-b',status:'published',image:'/brand/creatina-vital-force.jpg',presentation:'Unidad B',price:10000,stockQuantity:10000,unitCostMinor:300000,costEffectiveOn:`${year}-08-01`},null,null,actorId);
  const gift=await store.save('products',{...emptyRecord('products'),title:'Obsequio G',slug:'fixture-gift-g',productType:'gift',orderable:true,price:0,items:[{productId:b.id,quantity:2}]},null,null,actorId);
  const platform=withPlatform?await saveResource(store,'platforms',{requestId:requestId(),name:'HeKa Entrega'},actorId):null;
  const source=platform?(await listResources(store,'sources',{platform:platform.id}))[0]:null;
  return {year,actorId,person,account,a,b,gift,platform,source};
}
export async function createBusinessFixture(store,options={}) {
  const fixture=await createBusinessBasics(store,options),{year,actorId,person,a,gift,source,platform}=fixture;
  const order=await store.saveOrder(businessOrderInput(a,{year,sellerId:person.id,items:[{lineId:requestId(),kind:'products',itemId:a.id,quantity:2,unitPriceMinor:5500000,discountMinor:0},{lineId:requestId(),kind:'products',itemId:gift.id,quantity:1,unitPriceMinor:0,discountMinor:0}]}),actorId);
  let shipment=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:platform.id,sourceId:source.id,externalId:'SHIP-P',carrier:'Transportadora sintética',tracking:'0000123456789',estimatedDeliveryOn:`${year}-09-04`},actorId);
  shipment=await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'collected',occurredOn:`${year}-09-02`,externalKey:'EVENT-COLLECTED'},actorId);
  shipment=await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'delivered',occurredOn:`${year}-09-03`,externalKey:'EVENT-DELIVERED'},actorId);
  const collection=await recordCollection(store,{requestId:requestId(),orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,sourceId:source.id,externalKey:'COLLECTION-P',holder:'platform',amountMinor:12200000,occurredOn:`${year}-09-03`,method:'Contraentrega',reference:'RECAUDO-SINTÉTICO-P'},actorId);
  const shippingExpense=await recordExpense(store,{requestId:requestId(),category:'shipping_out',amountMinor:1500000,incurredOn:`${year}-09-02`,shipmentId:shipment.id,orderId:order.id,concept:'Flete de ida sintético'},actorId);
  const platformExpense=await recordExpense(store,{requestId:requestId(),category:'platform_fee',amountMinor:200000,incurredOn:`${year}-09-02`,shipmentId:shipment.id,orderId:order.id,concept:'Cargo de plataforma sintético'},actorId);
  const settlement=await saveSettlement(store,{requestId:requestId(),sourceId:source.id,externalKey:'SETTLEMENT-P',reportedOn:`${year}-09-05`,netMinor:10500000,lines:[{collectionId:collection.id,grossMinor:12200000,deductions:[{expenseId:shippingExpense.id,amountMinor:1500000},{expenseId:platformExpense.id,amountMinor:200000}]}]},actorId);
  Object.assign(fixture,{orderId:order.id,shipmentId:shipment.id,collectionId:collection.id,shippingExpenseId:shippingExpense.id,platformExpenseId:platformExpense.id,settlement});
  if(options.settle||options.pay)await settleBusinessFixture(store,fixture);
  if(options.pay)await payBusinessFixture(store,fixture);
  return fixture;
}
export async function settleBusinessFixture(store,fixture) {
  const {settlement,account,actorId,year}=fixture;
  const result=await confirmSettlement(store,{requestId:requestId(),settlementId:settlement.id,version:settlement.version,receivedOn:`${year}-09-05`,accountId:account.id,externalKey:'RECEIPT-P',lines:settlement.lines},actorId);
  fixture.settlement=result.settlement;fixture.receipt=result.receipt;return result;
}
export async function payBusinessFixture(store,fixture) {
  const {person,actorId,year,account}=fixture;
  const payroll=await confirmPayroll(store,{requestId:requestId(),personId:person.id,startOn:`${year}-09-01`,endOnExclusive:`${year}-10-01`,bonusMinor:0,discountMinor:0},actorId);
  const result=await payPayroll(store,{requestId:requestId(),payrollId:payroll.id,version:payroll.version,amountMinor:1550000,accountId:account.id,effectiveOn:`${year}-09-30`},actorId);
  fixture.payroll=result;return result;
}
export async function returnBusinessFixture(store,fixture,{refund=false}={}) {
  const {year,actorId,orderId,shipmentId,account}=fixture,order=await store.order(orderId);
  const returned=await registerReturn(store,{requestId:requestId(),orderId,version:order.version,occurredOn:`${year}-10-02`,reason:'Devolución sintética de una unidad A',shippingCreditMinor:0,lines:[{lineId:order.items.find(l=>l.itemId===fixture.a.id).lineId,quantity:1,condition:'recoverable'}]},actorId);
  const expense=await recordExpense(store,{requestId:requestId(),category:'shipping_return',amountMinor:700000,incurredOn:`${year}-10-02`,orderId,shipmentId,concept:'Flete de retorno sintético'},actorId);
  fixture.returned=returned;fixture.returnExpense=expense;
  if(refund){await recordRefund(store,{requestId:requestId(),orderId,version:(await store.order(orderId)).version,amountMinor:5500000,holder:'business',accountId:account.id,occurredOn:`${year}-10-03`,method:'Transferencia',reference:'REEMBOLSO-SINTÉTICO-P',reason:'Reembolso tras devolución comercial'},actorId);await payExpense(store,{requestId:requestId(),expenseId:expense.id,version:expense.version,amountMinor:700000,accountId:account.id,effectiveOn:`${year}-10-03`},actorId);}
  return {returned,expense};
}

export const BUSINESS_WORKBOOK_COLUMNS=[
  ['Pedido externo','externalOrderId'],['Guía','tracking'],['Transportadora','carrier'],['Estado','rawStatus'],['Fecha pedido','placedOn'],
  ['Destinatario','customerName'],['Celular','phone'],['Departamento','department'],['Ciudad','city'],['Dirección','address'],['Vendedor externo','sellerExternalKey'],
  ['Línea externa','externalLineId'],['Producto externo','productExternalKey'],['Cantidad','quantity'],['Precio unitario COP','unitPrice'],['Descuento línea COP','lineDiscount'],
  ['Flete cobrado COP','shippingCharge'],['Flete ida COP','shippingOutCost'],['Fecha cargo ida','shippingOutCostDate'],['Cargo plataforma COP','platformFee'],['Fecha cargo plataforma','platformFeeDate'],
  ['Recaudo COP','collectedAmount'],['Fecha recaudo','collectionDate'],['ID recaudo','collectionExternalId'],['Referencia recaudo','collectionReference'],
  ['ID liquidación','settlementExternalId'],['Fecha liquidación','settlementDate'],['Bruto liquidación COP','settlementGross'],['Neto liquidación COP','settlementNet'],['Referencia liquidación','settlementReference'],
  ['Recogida','collectedAt'],['Entrega','deliveredAt'],['Entrega estimada','estimatedDeliveryOn'],['Corte','reportAsOf']
];
export function businessWorkbookProfile(){
  return {sheetName:'Pedidos sintéticos',headerRow:1,dateFormat:'ISO',decimalSeparator:',',groupSeparator:'.',layout:'item_rows',purpose:'orders',oneOrderPerGuide:false,statusMap:{'Entregado sintético':'delivered'},columns:BUSINESS_WORKBOOK_COLUMNS.map(([header,destination],index)=>({index,header,destination,group:0}))};
}
export function businessWorkbookRows(year=completedFixtureYear()){
  const row=(product,line,quantity,price)=>({
    externalOrderId:'ORDER-P',tracking:'0000123456789',carrier:'Transportadora sintética',rawStatus:'Entregado sintético',placedOn:`${year}-09-01`,
    customerName:'Destinatario sintético',phone:'3001234567',department:'Bogotá',city:'Bogotá',address:'Dirección sintética',sellerExternalKey:'SELLER-V',
    externalLineId:line,productExternalKey:product,quantity,unitPrice:price,lineDiscount:'0',shippingCharge:'12.000',shippingOutCost:'15.000',shippingOutCostDate:`${year}-09-02`,
    platformFee:'2.000',platformFeeDate:`${year}-09-02`,collectedAmount:'122.000',collectionDate:`${year}-09-03`,collectionExternalId:'COLLECTION-P',collectionReference:'RECAUDO-SINTÉTICO-P',
    settlementExternalId:'SETTLEMENT-P',settlementDate:`${year}-09-05`,settlementGross:'122.000',settlementNet:'105.000',settlementReference:'LIQUIDACIÓN-SINTÉTICA-P',
    collectedAt:`${year}-09-02`,deliveredAt:`${year}-09-03`,estimatedDeliveryOn:`${year}-09-04`,reportAsOf:`${year}-09-05`
  });
  return [row('PRODUCT-A','LINE-A',2,'55.000'),row('GIFT-G','LINE-G',1,'0')];
}
export function createBusinessWorkbooks(directory,{year=completedFixtureYear()}={}){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const headers=BUSINESS_WORKBOOK_COLUMNS.map(([title])=>title),rows=businessWorkbookRows(year).map(row=>BUSINESS_WORKBOOK_COLUMNS.map(([,field])=>row[field]??null));
  const main=join(directory,'pedidos-sinteticos.xlsx'),reordered=join(directory,'pedidos-sinteticos-reordenados.xlsx');
  writeFileSync(main,writeExcelSheets([{name:'Pedidos sintéticos',rows:[headers,...rows]}]),{mode:0o600});
  writeFileSync(reordered,writeExcelSheets([{name:'Pedidos sintéticos',rows:[headers,...rows.toReversed()]}]),{mode:0o600});
  return {main,reordered,profile:businessWorkbookProfile(),year};
}
