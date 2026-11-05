import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createWorkbookBusiness, createWorkbookRelations, workbookOnboardingSheets, workbookOnboardingConfig, fixtureActor as actor, requestId } from './business-fixtures.mjs';
import * as imports from '../lib/business/imports.mjs';
import { readExcel, writeExcelSheets } from '../lib/business/excel.mjs';
import { IMPORT_TABLES, importTableConfig, writePreparedImportWorkbook } from '../lib/business/import-templates.mjs';
import { importFields } from '../lib/schema.mjs';
import { buildBusinessReport, reportDetails } from '../lib/business/reports.mjs';
import { getShipment, createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { registerReturn } from '../lib/business/collections.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { getResource, saveResource } from '../lib/business/settings.mjs';
import { claimJob, finishJob, queueJobTx } from '../lib/business/job-leases.mjs';
import { assertLease } from '../lib/business/commands.mjs';
import { importData } from '../lib/import.mjs';

const year=2026;
const count=async(store,table)=>Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);
const config=()=>workbookOnboardingConfig({year});
const sheets=options=>workbookOnboardingSheets({year,...options});
const linkedOrder=async(store,f,key='ORDER-A')=>{
  const row=await store.db.get(`SELECT internal_id FROM ${store.t('external_links')} WHERE source_id=? AND entity_type='order' AND external_key=?`,[f.source.id,key]);
  return row?store.order(row.internal_id):null;
};
const linkedShipment=async(store,f,key='SHIP-A')=>{
  const row=await store.db.get(`SELECT internal_id FROM ${store.t('external_links')} WHERE source_id=? AND entity_type='shipment' AND external_key=?`,[f.source.id,key]);
  assert.ok(row,`Missing synthetic shipment ${key}`);return getShipment(store,row.internal_id);
};
async function stock(store,f,quantity,reserved=0){
  const product=await store.get('products',f.a.id);
  assert.equal(product.stockQuantity,quantity);assert.equal(product.stockReserved,reserved);
  assert.equal(product.stockAvailable,quantity-reserved);
}
async function noInventedMoney(store){
  for(const table of ['cash_accounts','cash_entries','expense_payments','order_collections','settlement_receipts','people','payroll_periods'])assert.equal(await count(store,table),0,table);
}
async function uploaded(store,f,{tables=sheets(),bytes=null,configuration=config(),resolutions=[],opening=true,profileId=null}={}){
  let batch=await imports.createImportBatch(store,{sourceId:f.source.id,profileId,requestId:requestId()},actor);
  batch=await imports.uploadImportFile(store,batch.id,{version:batch.version,filename:'negocio-sintetico.xlsx',bytes:bytes??writeExcelSheets(tables),requestId:requestId()},actor);
  await imports.processImportTurn(store,{batchId:batch.id});batch=await imports.getImportBatch(store,batch.id);
  assert.equal(batch.state,'review',JSON.stringify(batch.error));
  assert.equal(batch.workbook.sheets.length,tables.length);
  batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,config:configuration,resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},...resolutions],...(opening?{inventoryOpening:{on:f.openingOn,confirmed:true}}:{}),requestId:requestId()},actor);
  return batch;
}
async function preview(store,batch){
  await imports.requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  await imports.processImportTurn(store,{batchId:batch.id});
  const reviewed=await imports.getImportBatch(store,batch.id);
  assert.ok(reviewed.preview,JSON.stringify(reviewed.error));return reviewed;
}
const errors=batch=>batch.preview.groups.flatMap(group=>group.errors);
function valid(batch){assert.deepEqual(errors(batch),[]);assert.ok(batch.preview.summary.valid>0);}
async function accept(store,batch,extra={}){
  return imports.commitImport(store,batch.id,{version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false,requestId:requestId(),...extra},actor);
}
async function drain(store,batch){
  for(let turn=0;turn<100;turn++){
    await imports.processImportTurn(store,{batchId:batch.id});
    const current=await imports.getImportBatch(store,batch.id);
    if(!['queued','applying'].includes(current.state))return current;
  }
  throw new Error('Synthetic workbook exceeded its bounded group count.');
}
async function apply(store,batch){valid(batch);await accept(store,batch);const result=await drain(store,batch);assert.equal(result.state,'completed',JSON.stringify(result.rows.records));return result;}
async function resolve(store,batch,resolutions){
  return preview(store,await imports.updateImportBatch(store,batch.id,{version:batch.version,resolutions,requestId:requestId()},actor));
}
const expenseTables=(name,headers,rows)=>[{name,rows:[headers,...rows]}];
function expenseConfig(name,headers,extra={}){
  return {formatVersion:2,sheets:[{sheetName:name,enabled:true,headerRow:1,purpose:'expenses',layout:'expense_rows',dateFormat:'ISO',decimalSeparator:'.',groupSeparator:',',reportAsOf:'2026-10-03',identityMode:'provided',defaults:{expenseCategory:'operating'},columns:headers.map((destination,index)=>({index,header:destination.toLowerCase(),destination,group:0})),...extra}]};
}
const expenseHeaders=['expenseExternalId','expenseDate','expenseConcept','expenseAmount'];
const expenseRows=(amount=10000)=>[['EXP-1','2026-09-29','Gasto sintético',amount]];
async function expenses(store){return (await store.db.all(`SELECT * FROM ${store.t('expenses')} ORDER BY id`)).map(row=>({...row,data:JSON.parse(row.data)}));}

async function preparedTables(data){
  const bytes=writePreparedImportWorkbook(data),catalog=await readExcel(bytes,{filename:'preparado.xlsx',mode:'catalog'}),tables=[],configuration={formatVersion:2,sheets:[]};
  for(const sheet of catalog.sheets){
    const parsed=await readExcel(bytes,{filename:'preparado.xlsx',mode:'rows',sheetName:sheet.name,headerRow:1});
    const rows=parsed.rows.map(row=>row.cells.map(cell=>cell.value??''));
    tables.push({name:sheet.name,rows:[rows[0],...rows.slice(1).reverse()]});
    const definition=Object.values(IMPORT_TABLES).find(table=>table.name===sheet.name);
    const columns=rows[0].map(header=>({header,destination:definition?.columns.find(column=>column.header===header)?.destination??importFields.find(field=>field.label===header)?.value}));
    const sheetConfig=importTableConfig(sheet.name,{columns});
    if(sheetConfig.enabled){assert.ok(columns.every(column=>column.destination),`Unmapped prepared headers in ${sheet.name}`);sheetConfig.reportAsOf='2026-10-03';sheetConfig.statusMap={Entregado:'delivered',delivered:'delivered',Pendiente:'label_created',label_created:'label_created'};}
    configuration.sheets.push(sheetConfig);
  }
  return {tables:tables.reverse(),configuration};
}

export async function runWorkbookImportContracts(t,factory){
  const fixture=async fn=>{const store=await factory();try{return await fn(store,await createWorkbookBusiness(store,{year}));}finally{await store.close();}};
  await t.test('libro completo crea pedidos reales, conserva campaña y costo y produce 57000/22000 COP sin caja',()=>fixture(async(store,f)=>{
    let batch=await preview(store,await uploaded(store,f));valid(batch);
    assert.ok(batch.preview.groups.some(group=>group.rowRefs.some(ref=>ref.sheet==='VENTAS')&&group.rowRefs.some(ref=>ref.sheet==='ENVIOS')));
    await apply(store,batch);
    const order=await linkedOrder(store,f),shipment=await linkedShipment(store,f);
    assert.equal(order.totalMinor,11000000);assert.equal(order.items.length,1);assert.equal(order.items[0].quantity,2);
    assert.equal(order.items[0].unitCostMinor,2000000);assert.equal(order.marketingCampaign,'CAMP-7');
    assert.equal(shipment.orderId,order.id);assert.equal(shipment.status,'delivered');
    assert.ok(shipment.events.some(event=>event.occurredOn==='2026-09-30'));
    assert.equal(order.inventoryOpening.on,f.openingOn);assert.equal(order.inventory.version,2);
    assert.equal((await store.get('products',f.a.id)).unitCostMinor,2300000);
    await stock(store,f,10);await noInventedMoney(store);
    const actual=await expenses(store);
    const totals=Object.fromEntries(['advertising','operating','shipping_out','shipping_insurance'].map(category=>[category,actual.filter(row=>row.category===category).reduce((sum,row)=>sum+Number(row.amount_minor),0)]));
    assert.deepEqual(totals,{advertising:2500000,operating:1000000,shipping_out:1200000,shipping_insurance:100000});
    for(const expense of actual.filter(row=>['advertising','operating'].includes(row.category))){assert.ok(expense.source_key.startsWith('excel-expense:'));assert.ok(expense.data.importIdentity.externalId);assert.equal(expense.order_id,null);assert.equal(expense.shipment_id,null);}
    const report=await buildBusinessReport(store,{period:'month',anchorDate:'2026-09-01',asOf:'2026-10-03T17:00:00.000Z'});
    for(const [metric,value] of Object.entries({netProductSales:11000000,costOfGoods:4000000,shippingCosts:1300000,advertisingExpenses:2500000,operatingExpenses:1000000,contribution:5700000,operatingResult:2200000}))assert.equal(report.metrics[metric].value,value,metric);
    const details=reportDetails(report,{metric:'operatingResult',pageSize:null}).records;
    assert.equal(details.filter(row=>row.known).reduce((sum,row)=>sum+row.value,0),2200000);
  }));

  await t.test('productos pendientes sobreviven al guardado, paginación y reapertura sin habilitar una revisión inválida',()=>fixture(async(store,f)=>{
    const base=sheets({shipments:[],advertising:[],operating:[]}).find(sheet=>sheet.name==='VENTAS');
    const sales=Array.from({length:55},(_,index)=>[`PENDING-${index}`,'LINE',`${year}-09-28`,'Cliente sintético','3001234567','Bogotá','Dirección sintética','SKU-PENDING',1,55000,20000,'']);
    const tables=[{...base,rows:[base.rows[0],...sales]},{name:'OTRAS VENTAS',rows:[base.rows[0],['LAST','LINE',`${year}-09-28`,'Cliente sintético','3001234567','Bogotá','Dirección sintética','SKU-LAST',1,55000,20000,'']]}];
    const sheet=config().sheets.find(sheet=>sheet.sheetName==='VENTAS'),configuration={formatVersion:2,sheets:[sheet,{...sheet,sheetName:'OTRAS VENTAS'}]};
    let batch=await preview(store,await uploaded(store,f,{tables,configuration}));
    const expected=[{externalKey:'SKU-LAST',count:1},{externalKey:'SKU-PENDING',count:55}],sorted=value=>[...value].sort((a,b)=>a.externalKey.localeCompare(b.externalKey));
    assert.deepEqual(sorted(batch.pendingProductLinks),expected);
    const oldHash=batch.preview.previewHash;
    batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,resolutions:[{action:'link_product',externalKey:'SKU-PENDING',sheet:'VENTAS',rowNumber:2,internalId:f.a.id}],requestId:requestId()},actor);
    assert.equal(batch.preview,null);
    assert.deepEqual(sorted(batch.pendingProductLinks),[{externalKey:'SKU-LAST',count:1},{externalKey:'SKU-PENDING',count:54}]);
    await assert.rejects(()=>imports.commitImport(store,batch.id,{version:batch.version,previewHash:oldHash,requestId:requestId()},actor),{status:409});
    batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,resolutions:[{action:'link_product',externalKey:'SKU-PENDING',internalId:f.a.id}],requestId:requestId()},actor);
    const resumed=await imports.getImportBatch(store,batch.id,{page:2,q:'sin coincidencias'});
    assert.deepEqual(resumed.pendingProductLinks,[{externalKey:'SKU-LAST',count:1}]);
    assert.equal(resumed.rows.total,0);
    batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,resolutions:[{action:'link_product',externalKey:'SKU-LAST',internalId:f.a.id}],requestId:requestId()},actor);
    assert.deepEqual(batch.pendingProductLinks,[]);
    assert.equal(await count(store,'orders'),0);
    assert.equal(batch.acceptedRevision,null);
  }));

  await t.test('combo privado y obsequio del Excel crean líneas reales, reservan componentes y reimportan sin duplicar',()=>fixture(async(store,f)=>{
    const physical=await store.get('products',f.a.id);
    await store.save('products',{...physical,status:'draft',orderable:true},physical.id,physical.version,actor);
    const combo=await store.save('combos',{title:'Combo privado sintético',slug:'combo-importado-privado',status:'draft',orderable:true,price:55000,items:[{productId:f.a.id,quantity:2}]},null,null,actor);
    const gift=await store.save('products',{title:'Obsequio privado sintético',slug:'obsequio-importado-privado',status:'draft',productType:'gift',orderable:true,price:0,items:[{productId:f.a.id,quantity:1}]},null,null,actor);
    const fields=['externalOrderId','externalLineId','placedOn','customerName','phone','city','productExternalKey','quantity','unitPrice','giftProductExternalKey','giftQuantity'];
    const tables=[{name:'VENTAS',rows:[fields,['ORDER-GIFT','LINE-COMBO','2026-09-28','Persona sintética','3001234567','Bogotá','COMBO-PRIVADO',2,55000,'REGALO-PRIVADO',2]]}];
    const configuration={formatVersion:2,sheets:[{...config().sheets.find(sheet=>sheet.sheetName==='VENTAS'),layout:'order_rows',columns:fields.map((destination,index)=>({index,header:destination.toLowerCase(),destination,group:0}))}]};
    const resolutions=[{action:'link_product',externalKey:'COMBO-PRIVADO',internalId:combo.id},{action:'link_product',externalKey:'REGALO-PRIVADO',internalId:gift.id}];
    const original=await preview(store,await uploaded(store,f,{tables,configuration,resolutions}));valid(original);
    const prepared=await preparedTables((await imports.getImportPrepared(store,original.id)).data);
    await apply(store,original);
    const order=await linkedOrder(store,f,'ORDER-GIFT');
    assert.equal(order.items.length,2);assert.equal(order.totalMinor,11000000);
    const sale=order.items.find(line=>line.itemId===combo.id),free=order.items.find(line=>line.itemId===gift.id);
    assert.equal(sale.kind,'combos');assert.equal(sale.quantity,2);assert.equal(sale.components[0].quantity,2);
    assert.equal(free.productType,'gift');assert.equal(free.quantity,2);assert.equal(free.unitPriceMinor,0);assert.equal(free.unitCostMinor,2300000);
    await stock(store,f,10,6);await noInventedMoney(store);
    assert.deepEqual((await store.publicData()).products,[]);assert.deepEqual((await store.publicData()).combos,[]);
    await apply(store,await preview(store,await uploaded(store,f,{tables,configuration,resolutions})));
    const preparedLinks=[...resolutions,{action:'link_product',externalKey:f.a.id,internalId:f.a.id},{action:'link_product',externalKey:combo.id,internalId:combo.id},{action:'link_product',externalKey:gift.id,internalId:gift.id}];
    await apply(store,await preview(store,await uploaded(store,f,{...prepared,resolutions:preparedLinks})));
    const repeated=await linkedOrder(store,f,'ORDER-GIFT');
    assert.equal(repeated.id,order.id);assert.deepEqual(repeated.items.map(line=>line.lineId).sort(),order.items.map(line=>line.lineId).sort());
    assert.equal(await count(store,'orders'),1);await stock(store,f,10,6);await noInventedMoney(store);
    const bundle=await store.exportData(),restored=await factory();try{await importData(restored,bundle);await stock(restored,f,10,6);assert.equal((await restored.get('combos',combo.id)).orderable,true);assert.equal((await linkedOrder(restored,f,'ORDER-GIFT')).items.find(line=>line.itemId===gift.id).unitPriceMinor,0);assert.deepEqual((await restored.publicData()).combos,[]);}finally{await restored.close();}
  }));

  await t.test('obsequios requieren vínculo de tipo regalo y cantidad explícita, sin tapar celdas vacías',()=>fixture(async(store,f)=>{
    const gift=await store.save('products',{title:'Regalo sintético',slug:'regalo-con-cantidad',status:'draft',productType:'gift',orderable:true,price:0,items:[{productId:f.a.id,quantity:1}]},null,null,actor);
    const fields=['externalOrderId','placedOn','customerName','phone','city','productExternalKey','quantity','unitPrice','giftProductExternalKey'];
    const sale=['ORDER-Q','2026-09-28','Persona sintética','3001234567','Bogotá','SKU-A',1,55000,'REGALO'];
    const configuration={formatVersion:2,sheets:[{...config().sheets.find(sheet=>sheet.sheetName==='VENTAS'),layout:'order_rows',columns:fields.map((destination,index)=>({index,header:destination.toLowerCase(),destination,group:0}))}]};
    let batch=await preview(store,await uploaded(store,f,{tables:[{name:'VENTAS',rows:[fields,sale]}],configuration}));
    assert.deepEqual(batch.pendingProductLinks,[{externalKey:'REGALO',count:1,giftOnly:true}]);
    batch=await resolve(store,batch,[{action:'link_product',externalKey:'REGALO',internalId:f.a.id}]);
    assert.ok(errors(batch).some(error=>error.code==='IMPORT_GIFT_LINK'));await assert.rejects(()=>accept(store,batch),{status:409});
    batch=await resolve(store,batch,[{action:'link_product',externalKey:'REGALO',internalId:gift.id}]);
    assert.ok(errors(batch).some(error=>error.code==='IMPORT_GIFT_QUANTITY'));await assert.rejects(()=>accept(store,batch),{status:409});
    configuration.sheets[0].defaults={giftQuantity:2};
    batch=await preview(store,await imports.updateImportBatch(store,batch.id,{version:batch.version,config:configuration,requestId:requestId()},actor));valid(batch);
    const mapped={...configuration,sheets:[{...configuration.sheets[0],columns:[...configuration.sheets[0].columns,{index:9,header:'giftquantity',destination:'giftQuantity',group:0}]}]};
    const links=[{action:'link_product',externalKey:'REGALO',internalId:gift.id}];
    for(const quantity of ['',0,-1,1.5]){
      const invalid=await preview(store,await uploaded(store,f,{tables:[{name:'VENTAS',rows:[[...fields,'giftQuantity'],[...sale,quantity]]}],configuration:mapped,resolutions:links}));
      assert.ok(errors(invalid).length,`Cantidad ${quantity} no puede convertirse en un regalo`);await assert.rejects(()=>accept(store,invalid),{status:409});
    }
    await apply(store,batch);await stock(store,f,10,3);
    const order=await linkedOrder(store,f,'ORDER-Q');assert.equal(order.items.find(line=>line.itemId===gift.id).quantity,2);assert.equal(order.totalMinor,5500000);
    assert.equal(await count(store,'orders'),1);await noInventedMoney(store);
  }));

  await t.test('pendiente reserva tres, devolución física posterior recupera uno y despacho consume tres',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f,{tables:sheets({pending:true})})));
    await stock(store,f,10,3);
    const order=await linkedOrder(store,f);
    await registerReturn(store,{requestId:requestId(),orderId:order.id,version:order.version,occurredOn:'2026-10-02',reason:'Unidad recuperada después del conteo',shippingCreditMinor:0,lines:[{lineId:order.items[0].lineId,quantity:1,condition:'recoverable'}]},actor);
    await stock(store,f,11,3);
    const shipment=await linkedShipment(store,f,'SHIP-B');
    await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'collected',occurredOn:'2026-10-03',externalKey:'B-POST-OPENING'},actor);
    await stock(store,f,8,0);await noInventedMoney(store);
  }));

  await t.test('rectificar entrega histórica a pendiente no reintegra existencias que nunca se descontaron',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f)));
    const shipment=await linkedShipment(store,f),event=shipment.events.find(event=>event.status==='delivered');
    await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'label_created',occurredOn:'2026-09-30',correctionOf:event.id,reason:'La entrega histórica era un estado equivocado',externalKey:'CORRECT-HISTORICAL'},actor);
    await stock(store,f,10,2);
    const order=await linkedOrder(store,f);assert.equal(order.inventory.openingProducts.find(row=>row.productId===f.a.id)?.consumed??0,0);
  }));

  for(const included of [true,false])await t.test(`salida del día del conteo requiere clasificación y conserva ${included}`,()=>fixture(async(store,f)=>{
    const tables=sheets();tables.find(sheet=>sheet.name==='ENVIOS').rows[1][5]=f.openingOn;
    let batch=await preview(store,await uploaded(store,f,{tables}));
    const issue=errors(batch).find(error=>error.code==='IMPORT_OPENING_CLASSIFICATION');assert.ok(issue);
    await assert.rejects(()=>accept(store,batch),{status:409});
    batch=await resolve(store,batch,[{action:'opening_observation',sheet:'ENVIOS',rowNumber:2,externalKey:issue.externalKey,value:included,reason:'Confirmado contra conteo físico sintético'}]);
    await apply(store,batch);await stock(store,f,included?10:8);
    const order=await linkedOrder(store,f);assert.ok(order.inventoryOpening.eventClassifications.some(item=>item.included===included));
    const second=await preview(store,await uploaded(store,f,{tables}));await apply(store,second);await stock(store,f,included?10:8);
    assert.deepEqual((await linkedOrder(store,f)).inventoryOpening,order.inventoryOpening);
  }));

  await t.test('instantánea sin fecha no usa el corte como fecha física ni acepta clasificación ausente',()=>fixture(async(store,f)=>{
    const tables=sheets();tables.find(sheet=>sheet.name==='ENVIOS').rows[1][5]='';
    let batch=await preview(store,await uploaded(store,f,{tables}));
    const issue=errors(batch).find(error=>error.code==='IMPORT_OPENING_CLASSIFICATION');assert.ok(issue);
    batch=await resolve(store,batch,[{action:'opening_observation',sheet:'ENVIOS',rowNumber:2,externalKey:issue.externalKey,value:true,reason:'Hecho ya incluido en el conteo'}]);
    await apply(store,batch);await stock(store,f,10);
    const shipment=await linkedShipment(store,f);assert.equal(shipment.events.find(event=>event.status==='delivered').occurredOn,null);
  }));

  await t.test('corrección que cruza apertura cambia solo el consumo posterior y una frontera ambigua se revierte',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f)));
    let shipment=await linkedShipment(store,f),event=shipment.events.find(event=>event.status==='delivered');
    shipment=await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'delivered',occurredOn:'2026-10-02',correctionOf:event.id,reason:'Fecha real posterior al conteo',externalKey:'CROSS-CUT'},actor);
    await stock(store,f,8);
    const corrected=shipment.events.find(candidate=>candidate.correctionOf===event.id),before=shipment;
    await assert.rejects(()=>recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'delivered',occurredOn:f.openingOn,correctionOf:corrected.id,reason:'Fecha ambigua sin decisión',externalKey:'AMBIGUOUS-CUT'},actor),{status:409});
    assert.equal((await getShipment(store,shipment.id)).version,before.version);await stock(store,f,8);
  }));

  await t.test('devolución del día del conteo distingue inclusión de devolución posterior y nunca crea stock de unidades pendientes',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f,{tables:sheets({pending:true})})));
    let order=await linkedOrder(store,f);
    await assert.rejects(()=>registerReturn(store,{requestId:requestId(),orderId:order.id,version:order.version,occurredOn:f.openingOn,reason:'Clasificación requerida',shippingCreditMinor:0,lines:[{lineId:order.items[0].lineId,quantity:1,condition:'recoverable'}]},actor),{status:409});
    await registerReturn(store,{requestId:requestId(),orderId:order.id,version:order.version,occurredOn:f.openingOn,inventoryOpeningIncluded:true,reason:'Ya figuraba en conteo físico',shippingCreditMinor:0,lines:[{lineId:order.items[0].lineId,quantity:1,condition:'recoverable'}]},actor);
    await stock(store,f,10,3);
    order=await linkedOrder(store,f);
    await registerReturn(store,{requestId:requestId(),orderId:order.id,version:order.version,occurredOn:f.openingOn,inventoryOpeningIncluded:false,reason:'Recibida después de contar',shippingCreditMinor:0,lines:[{lineId:order.items[0].lineId,quantity:1,condition:'recoverable'}]},actor);
    await stock(store,f,11,3);
    order=await linkedOrder(store,f,'ORDER-B');
    await registerReturn(store,{requestId:requestId(),orderId:order.id,version:order.version,occurredOn:'2026-10-02',reason:'Anular unidad nunca despachada',shippingCreditMinor:0,lines:[{lineId:order.items[0].lineId,quantity:1,condition:'recoverable'}]},actor);
    await stock(store,f,11,2);
  }));

  await t.test('reordenar hojas y filas conserva IDs, costos, gastos y stock sin duplicar hechos',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f,{tables:sheets({pending:true})})));
    const order=await linkedOrder(store,f),shipment=await linkedShipment(store,f),before=await expenses(store),events=await count(store,'shipment_events');
    const tables=sheets({pending:true}).reverse().map(sheet=>({...sheet,rows:sheet.rows.length?[sheet.rows[0],...sheet.rows.slice(1).reverse()]:[]}));
    await apply(store,await preview(store,await uploaded(store,f,{tables})));
    assert.equal((await linkedOrder(store,f)).id,order.id);assert.equal((await linkedShipment(store,f)).id,shipment.id);
    assert.deepEqual(await expenses(store),before);assert.equal(await count(store,'shipment_events'),events);await stock(store,f,10,3);await noInventedMoney(store);
  }));

  for(const amount of [0,12.34])await t.test(`gasto largo conserva importe exacto ${amount} sin pago automático`,()=>fixture(async(store,f)=>{
    const batch=await preview(store,await uploaded(store,f,{tables:expenseTables('GASTOS',expenseHeaders,expenseRows(amount)),configuration:expenseConfig('GASTOS',expenseHeaders)}));
    await apply(store,batch);const [expense]=await expenses(store);
    assert.equal(Number(expense.amount_minor),Math.round(amount*100));assert.equal(expense.category,'operating');assert.equal(expense.incurred_on,'2026-09-29');
    await noInventedMoney(store);await stock(store,f,10);
  }));

  for(const amount of ['',-1])await t.test(`importe ${JSON.stringify(amount)} no se convierte en cero ni crea gasto`,()=>fixture(async(store,f)=>{
    const batch=await preview(store,await uploaded(store,f,{tables:expenseTables('GASTOS',expenseHeaders,expenseRows(amount)),configuration:expenseConfig('GASTOS',expenseHeaders)}));
    assert.ok(errors(batch).length);await assert.rejects(()=>accept(store,batch),{status:409});assert.equal(await count(store,'expenses'),0);await noInventedMoney(store);
  }));

  for(const [label,quantity,cost,total] of [['control discrepante',10,2000,24999],['operando ausente','',2000,5000],['cantidad fraccional',0.5,2000,6000]])await t.test(`publicidad bloquea toda la fila: ${label}`,()=>fixture(async(store,f)=>{
    const tables=sheets({sales:[],shipments:[],operating:[],advertising:[['BAD-DAY','2026-09-29',quantity,cost,5,1000,total]]});
    const batch=await preview(store,await uploaded(store,f,{tables}));
    assert.ok(errors(batch).length);if(label==='control discrepante')assert.ok(errors(batch).some(error=>error.code==='IMPORT_EXPENSE_TOTAL'));
    await assert.rejects(()=>accept(store,batch),{status:409});assert.equal(await count(store,'expenses'),0);
  }));

  await t.test('cero explícito ancho es gasto conocido; grupo vacío se omite y el total no crea otro gasto',()=>fixture(async(store,f)=>{
    const tables=sheets({sales:[],shipments:[],operating:[],advertising:[['ZERO-DAY','2026-09-29',0,2000,'','',0]]});
    await apply(store,await preview(store,await uploaded(store,f,{tables})));const actual=await expenses(store);
    assert.equal(actual.length,1);assert.equal(actual[0].category,'advertising');assert.equal(Number(actual[0].amount_minor),0);assert.equal(actual[0].data.importIdentity.generated,false);
  }));

  await t.test('categoría del archivo requiere equivalencia explícita y valores fijos no rellenan una celda mapeada vacía',()=>fixture(async(store,f)=>{
    const headers=[...expenseHeaders,'expenseCategory'],tables=expenseTables('GASTOS',headers,[[...expenseRows()[0],'Operación local']]);
    let configuration=expenseConfig('GASTOS',headers);
    let batch=await preview(store,await uploaded(store,f,{tables,configuration}));assert.ok(errors(batch).length);
    configuration.sheets[0].expenseCategoryMap={'Operación local':'operating'};
    batch=await preview(store,await imports.updateImportBatch(store,batch.id,{version:batch.version,config:configuration,requestId:requestId()},actor));
    await apply(store,batch);assert.equal((await expenses(store))[0].category,'operating');
    const empty=expenseTables('GASTOS',headers,[['EXP-EMPTY','2026-09-29','Sin categoría',10,'']]);
    batch=await preview(store,await uploaded(store,f,{tables:empty,configuration}));assert.ok(errors(batch).length);
  }));

  await t.test('reimportar gasto idéntico conserva ID y un cambio al mismo corte requiere revisión con motivo',()=>fixture(async(store,f)=>{
    const options={tables:expenseTables('GASTOS',expenseHeaders,expenseRows()),configuration:expenseConfig('GASTOS',expenseHeaders)};
    await apply(store,await preview(store,await uploaded(store,f,options)));const original=(await expenses(store))[0];
    await apply(store,await preview(store,await uploaded(store,f,options)));assert.deepEqual((await expenses(store))[0],original);
    let batch=await preview(store,await uploaded(store,f,{...options,tables:expenseTables('GASTOS',expenseHeaders,expenseRows(15000))}));
    assert.ok(errors(batch).some(error=>/AUTHORITY|CONFLICT/.test(error.code)));await assert.rejects(()=>accept(store,batch),{status:409});
    const group=batch.preview.groups[0];batch=await resolve(store,batch,[{action:'review_authority',entityKey:group.key,reason:'Importe corregido confirmado',value:{}}]);
    await apply(store,batch);const corrected=(await expenses(store))[0];assert.equal(corrected.id,original.id);assert.equal(Number(corrected.amount_minor),1500000);assert.equal(corrected.source_key,original.source_key);
    await noInventedMoney(store);
  }));

  await t.test('corte anterior no borra importe vigente y carrera de gasto revierte todos los subgastos de una fila',()=>fixture(async(store,f)=>{
    const tables=sheets({sales:[],shipments:[],operating:[]});
    await apply(store,await preview(store,await uploaded(store,f,{tables})));const original=await expenses(store);
    const older=config();older.sheets.forEach(sheet=>{sheet.reportAsOf='2026-10-02';});
    const changed=sheets({sales:[],shipments:[],operating:[],advertising:[['AD-DAY','2026-09-29',20,2000,5,1000,45000]]});
    await apply(store,await preview(store,await uploaded(store,f,{tables:changed,configuration:older})));assert.deepEqual(await expenses(store),original);
    const newer=config();newer.sheets.forEach(sheet=>{sheet.reportAsOf='2026-10-04';});
    let batch=await preview(store,await uploaded(store,f,{tables:changed,configuration:newer}));
    assert.ok(errors(batch).some(error=>error.code==='IMPORT_EXPENSE_AUTHORITY'));await assert.rejects(()=>accept(store,batch),{status:409});
    batch=await resolve(store,batch,[{action:'review_authority',sheet:'PUBLICIDAD',rowNumber:2,reason:'Importe posterior confirmado antes de verificar la carrera',value:{}}]);valid(batch);await accept(store,batch);
    const first=original[0];await recordExpense(store,{requestId:requestId(),id:first.id,version:first.version,category:first.category,amountMinor:Number(first.amount_minor)+100,incurredOn:first.incurred_on,reason:'Corrección concurrente explícita',reviewConfirmed:true},actor);
    const raced=await expenses(store),result=await drain(store,batch);assert.equal(result.state,'completed_with_errors');assert.deepEqual(await expenses(store),raced);await noInventedMoney(store);
  }));

  await t.test('cell_value completa teléfono sin crear huérfanos, conserva original e invalida revisión anterior',()=>fixture(async(store,f)=>{
    const tables=sheets();tables.find(sheet=>sheet.name==='VENTAS').rows[1][4]='';
    let batch=await preview(store,await uploaded(store,f,{tables}));assert.ok(errors(batch).length);assert.equal(await count(store,'orders'),0);assert.equal(await count(store,'shipments'),0);
    const oldHash=batch.preview.previewHash;
    batch=await resolve(store,batch,[{action:'cell_value',sheet:'VENTAS',rowNumber:2,columnIndex:4,value:'3001112233',reason:'Contacto sintético confirmado'}]);
    valid(batch);assert.notEqual(batch.preview.previewHash,oldHash);
    await assert.rejects(()=>imports.commitImport(store,batch.id,{version:batch.version,previewHash:oldHash,requestId:requestId()},actor),{status:409});
    const original=await imports.downloadImportOriginal(store,batch.id);assert.ok(original.bytes.length);
    await apply(store,batch);assert.equal((await linkedOrder(store,f)).phone,'3001112233');await noInventedMoney(store);
  }));

  await t.test('cell_value enviado desde un grupo público se aplica por hoja, fila y columna antes de agrupar',()=>fixture(async(store,f)=>{
    const tables=sheets();tables.find(sheet=>sheet.name==='VENTAS').rows[1][4]='';
    let batch=await preview(store,await uploaded(store,f,{tables}));
    const group=batch.preview.groups.find(group=>group.rowRefs.some(ref=>ref.sheet==='VENTAS' && ref.rowNumber===2));
    assert.ok(group);assert.ok(group.rowRefs.some(ref=>ref.sheet==='ENVIOS'));
    assert.ok(group.lines.length);assert.equal(group.errors.some(error=>error.code==='IMPORT_LINE_COST'),false);
    const lineIds=group.lines.map(line=>line.lineId);
    const oldHash=batch.preview.previewHash;
    const amounts=value=>value.preview.groups.filter(group=>group.kind==='expenses').flatMap(group=>group.expenses.map(expense=>[expense.externalId,expense.input.amountMinor])).sort((a,b)=>a[0].localeCompare(b[0]));
    const originalAmounts=amounts(batch);
    const cell={action:'cell_value',sheet:'VENTAS',rowNumber:2,columnIndex:4};
    batch=await resolve(store,batch,[{...cell,entityKey:group.key,value:'3001112233',reason:'Contacto confirmado desde la fila visible del grupo'}]);
    valid(batch);assert.notEqual(batch.preview.previewHash,oldHash);assert.deepEqual(amounts(batch),originalAmounts);
    assert.deepEqual(batch.preview.groups.find(value=>value.key===group.key).lines.map(line=>line.lineId),lineIds);
    const stored=batch.resolutions.find(resolution=>resolution.action==='cell_value');
    assert.equal(Object.hasOwn(stored,'entityKey'),false);
    let row=batch.rows.records.find(row=>row.sheet==='VENTAS' && row.rowNumber===2);
    assert.equal(row.normalized.values.phone,'3001112233');assert.equal(row.source[4]?.value ?? '','');
    batch=await resolve(store,batch,[{...cell,entityKey:'group:contexto-anterior',externalKey:'contexto-de-entidad',value:'3002223344',reason:'Contacto corregido en la misma celda con otro contexto de revisión'}]);
    valid(batch);assert.equal(batch.resolutions.filter(resolution=>resolution.action==='cell_value').length,1);
    row=batch.rows.records.find(row=>row.sheet==='VENTAS' && row.rowNumber===2);
    assert.equal(row.normalized.values.phone,'3002223344');assert.equal(row.source[4]?.value ?? '','');
    batch=await resolve(store,batch,[{...cell,entityKey:group.key,remove:true}]);
    assert.ok(errors(batch).some(error=>error.code==='IMPORT_ORDER_INCOMPLETE'));assert.equal(batch.resolutions.filter(resolution=>resolution.action==='cell_value').length,0);
    batch=await resolve(store,batch,[{...cell,entityKey:group.key,value:'3002223344',reason:'Contacto final confirmado sin cambiar el archivo original'}]);
    const original=await imports.downloadImportOriginal(store,batch.id);
    const parsed=await readExcel(original.bytes,{filename:original.filename,mode:'rows',sheetName:'VENTAS',headerRow:1});
    assert.equal(parsed.rows.find(row=>row.rowNumber===2).cells[4]?.value ?? '','');
    await apply(store,batch);assert.equal((await linkedOrder(store,f)).phone,'3002223344');
    const audits=(await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='import_cell' AND entity_id=?`,[batch.id])).map(row=>JSON.parse(row.data));
    assert.ok(audits.some(audit=>audit.next.sheet==='VENTAS' && audit.next.rowNumber===2 && audit.next.columnIndex===4 && audit.next.value==='3002223344' && audit.reason==='Contacto final confirmado sin cambiar el archivo original'));
    await noInventedMoney(store);
  }));

  await t.test('line_costs usa IDs de líneas preparadas, no cambia catálogo y rechaza línea ajena',()=>fixture(async(store,f)=>{
    const tables=sheets();tables.find(sheet=>sheet.name==='VENTAS').rows[1][10]='';
    let batch=await preview(store,await uploaded(store,f,{tables}));
    const group=batch.preview.groups.find(group=>group.lines.length),lineId=group.lines[0].lineId;assert.ok(lineId);
    batch=await resolve(store,batch,[{action:'line_costs',entityKey:group.key,externalKey:'ORDER-A',value:{lineCosts:[{lineId:'foreign-line',unitCostMinor:2000000}]},reason:'Costo de otra línea no autorizado'}]);assert.ok(errors(batch).length);
    batch=await resolve(store,batch,[{action:'line_costs',entityKey:group.key,externalKey:'ORDER-A',value:{lineCosts:[{lineId,unitCostMinor:2000000}]},reason:'Costo histórico confirmado'}]);
    await apply(store,batch);assert.equal((await linkedOrder(store,f)).items[0].unitCostMinor,2000000);assert.equal((await store.get('products',f.a.id)).unitCostMinor,2300000);
  }));

  await t.test('modificar producto tras aceptar revierte pedido, guía, costos y alias del grupo',()=>fixture(async(store,f)=>{
    const batch=await preview(store,await uploaded(store,f));valid(batch);await accept(store,batch);
    const product=await store.get('products',f.a.id);await store.save('products',{...product,title:'Producto modificado concurrentemente'},product.id,product.version,actor);
    const result=await drain(store,batch);assert.equal(result.state,'completed_with_errors');assert.equal(await linkedOrder(store,f),null);assert.equal(await count(store,'shipments'),0);
    assert.equal((await expenses(store)).filter(row=>row.order_id||row.shipment_id).length,0);await stock(store,f,10);await noInventedMoney(store);
  }));

  await t.test('lease real impide doble worker, reanuda por turnos y cancelar preserva solo operaciones confirmadas',()=>fixture(async(store,f)=>{
    const batch=await preview(store,await uploaded(store,f,{tables:sheets({pending:true})}));valid(batch);await accept(store,batch);
    const now=new Date().toISOString(),lease=await claimJob(store,{key:`import:${batch.id}`,now});assert.ok(lease);
    assert.equal((await imports.processImportTurn(store,{batchId:batch.id,now})).processed,0);
    await store.db.run(`UPDATE ${store.t('job_runs')} SET lease_until=? WHERE key=?`,['2000-01-01T00:00:00.000Z',lease.key]);
    await imports.processImportTurn(store,{batchId:batch.id,maxGroups:1});
    const facts=await count(store,'orders'),paid=await expenses(store);assert.ok(facts+paid.length>0);
    await imports.cancelImportBatch(store,batch.id,{requestId:requestId()},actor);
    assert.equal((await imports.processImportTurn(store,{batchId:batch.id})).processed,0);
    assert.equal(await count(store,'orders'),facts);assert.deepEqual(await expenses(store),paid);await noInventedMoney(store);
  }));

  await t.test('guardar y revisar durante una inspección activa conserva correcciones y revoca solo el lector anterior',()=>fixture(async(store,f)=>{
    let batch=await uploaded(store,f);
    const key=`import:${batch.id}`,started=Promise.withResolvers(),resume=Promise.withResolvers(),get=store.db.get.bind(store.db);
    let paused=false,outcome;
    store.db.get=async(sql,values)=>{
      const row=await get(sql,values);
      if(!paused&&sql.includes(store.t('import_batches'))){paused=true;started.resolve();await resume.promise;}
      return row;
    };
    const reader=imports.processImportTurn(store,{batchId:batch.id});
    const deadline=setTimeout(()=>started.reject(new Error('La inspección no llegó a leer el lote.')),10000);
    try{
      await started.promise;clearTimeout(deadline);
      const first=await get(`SELECT lease_token FROM ${store.t('job_runs')} WHERE key=?`,[key]);
      batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,config:batch.config,resolutions:[{action:'cell_value',sheet:'VENTAS',rowNumber:2,columnIndex:4,value:'3007654321',reason:'Celular sintético confirmado mientras se leían las muestras'}],requestId:requestId()},actor);
      await assert.rejects(()=>assertLease(store,{key,token:first.lease_token}),{status:409});
      const second=await claimJob(store,{key});assert.ok(second);
      await imports.requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
      await assert.rejects(()=>assertLease(store,{key,token:second.token}),{status:409});
    }finally{
      clearTimeout(deadline);store.db.get=get;resume.resolve();outcome=await reader;
    }
    assert.equal(outcome.state,'previewing');assert.equal(outcome.hasMore,true);
    await imports.processImportTurn(store,{batchId:batch.id});batch=await imports.getImportBatch(store,batch.id);valid(batch);
    await accept(store,batch);
    const applying=await claimJob(store,{key}),intent=JSON.parse((await get(`SELECT data FROM ${store.t('job_runs')} WHERE key=?`,[key])).data);
    await assert.rejects(()=>store.transaction(async tx=>{await tx.lockWrites();await queueJobTx(tx,key,intent,{replaceRunningPhase:'inspect'});}),{status:409});
    await assertLease(store,{key,token:applying.token});
    await finishJob(store,applying,{state:'queued'});
    assert.equal((await drain(store,batch)).state,'completed');
    assert.equal((await linkedOrder(store,f)).phone,'3007654321');
    assert.equal(await count(store,'orders'),1);assert.equal(await count(store,'shipments'),1);assert.equal(await count(store,'expenses'),5);
    await stock(store,f,10);await noInventedMoney(store);
  }));

  await t.test('perfil se congela al aceptar: editarlo entre turnos no bloquea operaciones restantes',()=>fixture(async(store,f)=>{
    const profile=await saveResource(store,'profiles',{requestId:requestId(),sourceId:f.source.id,name:'Perfil sintético v2',...config()},actor);
    const batch=await preview(store,await uploaded(store,f,{profileId:profile.id,tables:sheets({pending:true})}));valid(batch);await accept(store,batch);
    await imports.processImportTurn(store,{batchId:batch.id,maxGroups:1});
    await saveResource(store,'profiles',{requestId:requestId(),version:profile.version,sourceId:f.source.id,name:'Perfil editado después de aceptar',...config()},actor,profile.id);
    const done=await drain(store,batch);assert.equal(done.state,'completed');assert.ok(await linkedOrder(store,f));assert.ok(await linkedOrder(store,f,'ORDER-B'));await stock(store,f,10,3);
  }));

  await t.test('respaldo de revisión pendiente reanuda mismos hechos y rechaza apertura manipulada antes de escribir',async()=>{
    const source=await factory();let target;
    try{
      const f=await createWorkbookBusiness(source,{year});const batch=await preview(source,await uploaded(source,f,{tables:sheets({pending:true})}));valid(batch);await accept(source,batch);
      await imports.processImportTurn(source,{batchId:batch.id,maxGroups:1});
      const bundle=await source.exportData();target=await factory();await importData(target,bundle);
      await stock(target,f,10,(await linkedOrder(target,f,'ORDER-B'))?3:0);
      assert.equal((await drain(target,batch)).state,'completed');await stock(target,f,10,3);await noInventedMoney(target);
      assert.equal((await linkedOrder(target,f)).marketingCampaign,'CAMP-7');
      const restored=await target.exportData();
      const stable=value=>{const copy=structuredClone(value);delete copy.exportedAt;return copy;};
      const mutations=[
        copy=>copy.orders.find(order=>order.inventoryOpening).inventoryOpening.eventClassifications.push({eventId:'foreign-event',included:true,confirmedBy:actor,confirmedAt:new Date().toISOString(),reason:'Referencia manipulada'}),
        copy=>copy.orders.find(order=>order.inventoryOpening).inventory.openingProducts.push({productId:'foreign-product',consumed:1}),
        copy=>{copy.business.expenses.find(expense=>expense.source_key?.startsWith('excel-expense:')).source_key+='tampered';},
        copy=>{const expense=copy.business.expenses.find(expense=>expense.source_key?.startsWith('excel-expense:')),data=JSON.parse(expense.data);data.importIdentity.externalId='another-expense';expense.data=JSON.stringify(data);},
        copy=>{const revision=copy.business.import_revisions.find(row=>row.batch_id===batch.id),data=JSON.parse(revision.data);data.groups[0].rowRefs=[{sheet:'foreign-sheet',rowNumber:2}];revision.data=JSON.stringify(data);},
        copy=>{copy.orders.find(order=>order.inventoryOpening).inventoryOpening.sourceId='foreign-source';}
      ];
      for(const mutate of mutations){const bad=structuredClone(restored);mutate(bad);await assert.rejects(()=>importData(target,bad));assert.deepEqual(stable(await target.exportData()),stable(restored));await stock(target,f,10,3);}
    }finally{await source.close();await target?.close();}
  });

  await t.test('preparado previo conserva las asignaciones efectivas de una única guía y reimporta sin duplicar líneas',()=>fixture(async(store,f)=>{
    const tables=sheets(),sales=tables.find(sheet=>sheet.name==='VENTAS').rows,second=[...sales[1]];
    sales[1][8]=1;second[1]='LINE-B';second[8]=1;sales.push(second);
    const original=await preview(store,await uploaded(store,f,{tables}));valid(original);
    const prepared=await imports.getImportPrepared(store,original.id),download=await preparedTables(prepared.data);
    const allocations=download.tables.find(sheet=>sheet.name==='ASIGNACIONES').rows.slice(1).sort((a,b)=>a[2].localeCompare(b[2]));
    assert.deepEqual(allocations,[['ORDER-A','SHIP-A','LINE-A',1],['ORDER-A','SHIP-A','LINE-B',1]]);
    assert.equal(await count(store,'orders'),0);assert.equal(await count(store,'expenses'),0);
    await apply(store,await preview(store,await uploaded(store,f,{...download,resolutions:[{action:'link_product',externalKey:f.a.id,internalId:f.a.id}]})));
    const first=await linkedOrder(store,f),shipment=await linkedShipment(store,f),expenseIds=(await expenses(store)).map(row=>row.id);
    assert.deepEqual(shipment.assignments.map(line=>[line.lineId,line.quantity]).sort(),first.items.map(line=>[line.lineId,1]).sort());
    assert.deepEqual(first.items.map(line=>[line.externalLineId,line.quantity,line.unitCostMinor]).sort(),[['LINE-A',1,2000000],['LINE-B',1,2000000]]);
    const reimported=await preview(store,await uploaded(store,f,{tables})),existingDownload=await preparedTables((await imports.getImportPrepared(store,reimported.id)).data);
    assert.deepEqual(existingDownload.tables.find(sheet=>sheet.name==='ASIGNACIONES').rows.slice(1).sort((a,b)=>a[2].localeCompare(b[2])),allocations);
    await apply(store,reimported);
    assert.equal((await linkedOrder(store,f)).id,first.id);assert.equal((await linkedShipment(store,f)).id,shipment.id);
    assert.deepEqual((await linkedShipment(store,f)).events.map(event=>event.id).sort(),shipment.events.map(event=>event.id).sort());
    assert.deepEqual((await expenses(store)).map(row=>row.id),expenseIds);assert.equal(await count(store,'orders'),1);assert.equal(await count(store,'shipments'),1);
    await stock(store,f,10);await noInventedMoney(store);
  }));

  await t.test('preparado idéntico tras el original conserva procedencia y exige autoridad solo para datos discrepantes',()=>fixture(async(store,f)=>{
    const original=await preview(store,await uploaded(store,f)),download=await preparedTables((await imports.getImportPrepared(store,original.id)).data);
    await apply(store,original);
    const before=await expenses(store),order=await linkedOrder(store,f),shipment=await linkedShipment(store,f),resolutions=[{action:'link_product',externalKey:f.a.id,internalId:f.a.id}];
    await apply(store,await preview(store,await uploaded(store,f,{...download,resolutions})));
    assert.deepEqual(await expenses(store),before);
    assert.equal((await linkedOrder(store,f)).id,order.id);assert.equal((await linkedShipment(store,f)).id,shipment.id);
    assert.deepEqual((await linkedShipment(store,f)).events.map(event=>event.id).sort(),shipment.events.map(event=>event.id).sort());
    const expenseSheet=download.tables.find(sheet=>sheet.name==='GASTOS'),campaignColumn=expenseSheet.rows[0].indexOf('CAMPAÑA'),categoryColumn=expenseSheet.rows[0].indexOf('CATEGORIA');
    const campaignRow=expenseSheet.rows.slice(1).find(row=>row[categoryColumn]==='advertising'),campaign=campaignRow[campaignColumn];
    campaignRow[campaignColumn]='Campaña discrepante no autorizada';
    let rejected=await preview(store,await uploaded(store,f,{...download,resolutions}));
    assert.ok(errors(rejected).some(error=>error.code==='IMPORT_EXPENSE_AUTHORITY'));await assert.rejects(()=>accept(store,rejected),{status:409});
    assert.deepEqual(await expenses(store),before);
    campaignRow[campaignColumn]=campaign;
    const observations=download.tables.find(sheet=>sheet.name==='OBSERVACIONES').rows,quantity=observations.slice(1).find(row=>row[0]==='expense'&&row[4]==='integer');
    quantity[5]+=1;
    rejected=await preview(store,await uploaded(store,f,{...download,resolutions}));
    assert.ok(errors(rejected).some(error=>error.code==='IMPORT_METADATA_AUTHORITY'));await assert.rejects(()=>accept(store,rejected),{status:409});
    assert.deepEqual(await expenses(store),before);await stock(store,f,10);await noInventedMoney(store);
  }));

  await t.test('preparado antes de aplicar conserva líneas distintas, repartos, componentes y observaciones al reordenar y repetir',()=>fixture(async(store,f)=>{
    const relation=await createWorkbookRelations(store,f);
    const original=await preview(store,await uploaded(store,f,relation));valid(original);
    assert.equal(await count(store,'orders'),0);assert.equal(await count(store,'expenses'),0);
    const prepared=await imports.getImportPrepared(store,original.id),download=await preparedTables(prepared.data);
    const componentSheet=download.tables.find(sheet=>sheet.name==='COSTOS COMPONENTES');assert.ok(componentSheet.rows.length>1);
    const resolutions=[...relation.resolutions,{action:'link_product',externalKey:f.a.id,internalId:f.a.id}];
    await apply(store,await preview(store,await uploaded(store,f,{...download,resolutions})));
    let order=await linkedOrder(store,f),a=await linkedShipment(store,f),b=await linkedShipment(store,f,'SHIP-B');
    assert.equal(order.items.length,3);assert.equal(order.marketingCampaign,'CAMP-7');
    const byExternal=new Map(order.items.map(line=>[line.externalLineId,line]));
    assert.equal(byExternal.get('LINE-A').unitPriceMinor,5500000);assert.equal(byExternal.get('LINE-A').unitCostMinor,2000000);
    assert.equal(byExternal.get('LINE-B').unitPriceMinor,5400000);assert.equal(byExternal.get('LINE-B').unitCostMinor,2100000);
    assert.equal(byExternal.get('LINE-C').components[0].productId,f.a.id);assert.equal(byExternal.get('LINE-C').components[0].unitCostMinor,1900000);
    assert.equal(byExternal.get('LINE-C').unitCostMinor,3800000);
    assert.deepEqual(a.assignments.map(line=>({lineId:line.lineId,quantity:line.quantity})),[{lineId:byExternal.get('LINE-A').lineId,quantity:1}]);
    assert.deepEqual(new Set(b.assignments.map(line=>line.lineId)),new Set([byExternal.get('LINE-B').lineId,byExternal.get('LINE-C').lineId]));
    const point=order.importedFields.find(field=>field.key==='additional:puntos');assert.equal(point.value,0);assert.equal(point.valueType,'integer');
    assert.equal(point.sheet,'OBSERVACIONES');assert.equal(point.declaredOrigin.sheet,'Venta previa');assert.equal(point.declaredOrigin.rowNumber,8);
    assert.equal(a.importedFields.find(field=>field.key==='additional:seguimiento').value,'Sin interpretar como pago');
    const actual=await expenses(store),op=actual.find(expense=>expense.category==='operating');
    assert.equal(op.data.importedFields.find(field=>field.key==='additional:centavos').value,12345);
    assert.deepEqual(new Set(actual.map(expense=>expense.category)),new Set(['advertising','operating','other','shipping_out','shipping_insurance']));
    const identity={orderId:order.id,a:a.id,b:b.id,lines:order.items.map(line=>line.lineId).sort(),expenses:actual.map(expense=>expense.id).sort()};
    const events=await count(store,'shipment_events');
    await apply(store,await preview(store,await uploaded(store,f,{...download,resolutions})));
    order=await linkedOrder(store,f);a=await linkedShipment(store,f);b=await linkedShipment(store,f,'SHIP-B');
    assert.deepEqual({orderId:order.id,a:a.id,b:b.id,lines:order.items.map(line=>line.lineId).sort(),expenses:(await expenses(store)).map(expense=>expense.id).sort()},identity);
    assert.equal(await count(store,'shipment_events'),events);await stock(store,f,10);await noInventedMoney(store);
    await apply(store,await preview(store,original));assert.equal((await linkedOrder(store,f)).id,identity.orderId);await stock(store,f,10);
  }));

  await t.test('reenvío posterior a entrega histórica descuenta su salida real y no otra vez la original',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f)));
    const order=await linkedOrder(store,f),original=await linkedShipment(store,f);
    const resend=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:f.platform.id,sourceId:f.source.id,externalId:'RESEND-A',carrier:'Transportadora sintética',tracking:'SYNTHETIC-RESEND-A',replacesShipmentId:original.id,assignments:[{lineId:order.items[0].lineId,quantity:2}]},actor);
    await stock(store,f,10,2);
    await recordShipmentEvent(store,resend.id,{requestId:requestId(),version:resend.version,status:'collected',occurredOn:'2026-10-02',externalKey:'RESEND-A-OUT'},actor);
    await stock(store,f,8);await noInventedMoney(store);
  }));

  await t.test('reserva agregada insuficiente bloquea la operación sin stock ficticio ni pedido parcial',()=>fixture(async(store,f)=>{
    const tables=sheets({pending:true});tables.find(sheet=>sheet.name==='VENTAS').rows[2][8]=11;
    const batch=await preview(store,await uploaded(store,f,{tables}));
    assert.ok(errors(batch).length);await assert.rejects(()=>accept(store,batch),{status:409});
    assert.equal(await count(store,'orders'),0);assert.equal(await count(store,'shipments'),0);await stock(store,f,10);
  }));

  await t.test('identidades generadas no usan posición ni teléfono y duplicados requieren independencia confirmada',()=>fixture(async(store,f)=>{
    const headers=['placedOn','customerName','phone','city','productExternalKey','quantity','unitPrice'];
    const row=['2026-09-28','Persona sintética','3001234567','Bogotá','SKU-A',1,55000];
    const configuration={formatVersion:2,sheets:[{sheetName:'SIN IDS',enabled:true,headerRow:1,purpose:'orders',layout:'order_rows',identityMode:'generated',dateFormat:'ISO',decimalSeparator:'.',groupSeparator:',',reportAsOf:'2026-10-03',columns:headers.map((destination,index)=>({index,header:destination.toLowerCase(),destination,group:0}))}]};
    const tables=[{name:'SIN IDS',rows:[headers,row,row]}];
    let batch=await preview(store,await uploaded(store,f,{tables,configuration}));
    assert.ok(errors(batch).some(error=>/DUPLICATE/.test(error.code)));
    const independent=randomUUID();
    batch=await resolve(store,batch,[{action:'independent_record',sheet:'SIN IDS',rowNumber:3,value:independent}]);
    await apply(store,batch);assert.equal(await count(store,'orders'),2);await stock(store,f,10,2);
    const ids=(await store.orders()).map(order=>order.id).sort();
    const repeat=await preview(store,await uploaded(store,f,{tables,configuration,resolutions:[{action:'independent_record',sheet:'SIN IDS',rowNumber:3,value:independent}]}));
    await apply(store,repeat);assert.deepEqual((await store.orders()).map(order=>order.id).sort(),ids);await stock(store,f,10,2);
    const modified=[{name:'SIN IDS',rows:[headers,[...row.slice(0,5),2,55000]]}];
    const correction=await preview(store,await uploaded(store,f,{tables:modified,configuration}));assert.ok(errors(correction).length);assert.equal(await count(store,'orders'),2);
  }));

  await t.test('hoja de publicidad duplicada queda en revisión y no suma campañas por repetición',()=>fixture(async(store,f)=>{
    const tables=sheets({sales:[],shipments:[],operating:[]}),copy=structuredClone(tables.find(sheet=>sheet.name==='PUBLICIDAD'));copy.name='COPIA PAUTA';tables.push(copy);
    const configuration=config(),duplicate=structuredClone(configuration.sheets.find(sheet=>sheet.sheetName==='PUBLICIDAD'));duplicate.sheetName=copy.name;configuration.sheets.push(duplicate);
    const batch=await preview(store,await uploaded(store,f,{tables,configuration}));
    assert.ok(errors(batch).some(error=>/DUPLICATE|CONFLICT/.test(error.code)));await assert.rejects(()=>accept(store,batch),{status:409});assert.equal(await count(store,'expenses'),0);
  }));

  await t.test('gasto sin ID cambiado exige vínculo explícito a la misma fuente y conserva identidad original',()=>fixture(async(store,f)=>{
    const configuration=expenseConfig('GASTOS',expenseHeaders,{identityMode:'generated'});
    const rows=expenseRows();rows[0][0]='';
    await apply(store,await preview(store,await uploaded(store,f,{configuration,tables:expenseTables('GASTOS',expenseHeaders,rows)})));
    const [original]=await expenses(store);assert.equal(original.data.importIdentity.generated,true);
    const changed=structuredClone(rows);changed[0][3]=12000;
    let batch=await preview(store,await uploaded(store,f,{configuration,tables:expenseTables('GASTOS',expenseHeaders,changed)}));assert.ok(errors(batch).length);
    batch=await resolve(store,batch,[{action:'link_expense',sheet:'GASTOS',rowNumber:2,internalId:original.id,reason:'Corrección del mismo comprobante sintético'}]);
    batch=await resolve(store,batch,[{action:'review_authority',entityKey:batch.preview.groups[0].key,reason:'Nuevo importe comprobado explícitamente',value:{}}]);
    await apply(store,batch);const actual=await expenses(store);
    assert.equal(actual.length,1);assert.equal(actual[0].id,original.id);assert.equal(actual[0].source_key,original.source_key);
    assert.equal(actual[0].data.importIdentity.externalId,original.data.importIdentity.externalId);assert.equal(Number(actual[0].amount_minor),1200000);await noInventedMoney(store);
  }));

  await t.test('resoluciones de costos existentes requieren motivo y una reimportación idéntica no vuelve a corregir',()=>fixture(async(store,f)=>{
    await apply(store,await preview(store,await uploaded(store,f)));let order=await linkedOrder(store,f);
    const tables=sheets();tables.find(sheet=>sheet.name==='VENTAS').rows[1][10]=21000;
    let batch=await preview(store,await uploaded(store,f,{tables}));assert.ok(errors(batch).length);
    const group=batch.preview.groups.find(group=>group.lines.length);
    batch=await resolve(store,batch,[{action:'line_costs',entityKey:group.key,externalKey:'ORDER-A',value:{lineCosts:[{lineId:order.items[0].lineId,unitCostMinor:2100000}]}}]);assert.ok(errors(batch).length);
    batch=await resolve(store,batch,[{action:'line_costs',entityKey:group.key,externalKey:'ORDER-A',value:{lineCosts:[{lineId:order.items[0].lineId,unitCostMinor:2100000}]},reason:'Costo histórico rectificado con soporte'}]);
    await apply(store,batch);order=await linkedOrder(store,f);assert.equal(order.items[0].unitCostMinor,2100000);
    const version=order.version;
    await apply(store,await preview(store,await uploaded(store,f,{tables})));assert.equal((await linkedOrder(store,f)).version,version);
    assert.equal((await store.get('products',f.a.id)).unitCostMinor,2300000);await stock(store,f,10);
  }));
  await t.test('v2 guarda exclusiones expresas, bloquea columnas pendientes y conserva la decisión en perfil y respaldo',context=>fixture(async(store,f)=>{
    const restoredStores=[];context.after(async()=>{for(const restored of restoredStores)await restored.close();});
    const restoreFresh=async bundle=>{const restored=await factory();restoredStores.push(restored);await importData(restored,bundle);return restored;};
    const XLSX=createRequire(import.meta.url)('xlsx'),name='GASTOS',headers=[...expenseHeaders,'Resumen excluido','Destino pendiente'];
    const configuration=expenseConfig(name,expenseHeaders);
    configuration.sheets[0].columns.push({index:4,header:'resumen excluido',destination:'ignore',group:0},{index:5,header:'destino pendiente',destination:'',group:0});
    const workbook=XLSX.utils.book_new(),data=XLSX.utils.aoa_to_sheet([headers,[...expenseRows()[0],null,'Dato que todavía debe confirmarse']]);
    data.E2={t:'e',v:7,f:'1/0'};data['!ref']='A1:F2';XLSX.utils.book_append_sheet(workbook,data,name);
    const bytes=XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true}),tables=[{name,rows:[]}];
    const profile=await saveResource(store,'profiles',{name:'Gastos con exclusión explícita',sourceId:f.source.id,profile:configuration,requestId:requestId()},actor);
    let saved=await getResource(store,'profiles',profile.id);
    assert.deepEqual(saved.sheets[0].columns.slice(-2).map(column=>column.destination),['ignore','']);
    let batch=await uploaded(store,f,{tables,bytes,configuration:{formatVersion:2,sheets:saved.sheets},profileId:profile.id,opening:false});
    await assert.rejects(()=>imports.requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor),error=>error.code==='IMPORT_COLUMN_PENDING' && error.status===400 && error.location.sheet===name && error.location.columnIndex===5);
    assert.equal(await count(store,'expenses'),0);
    store=await restoreFresh(await store.exportData());
    saved=await getResource(store,'profiles',profile.id);batch=await imports.getImportBatch(store,batch.id);
    assert.deepEqual(saved.sheets[0].columns.slice(-2).map(column=>column.destination),['ignore','']);
    assert.deepEqual(batch.config.sheets[0].columns.slice(-2).map(column=>column.destination),['ignore','']);
    const confirmed={formatVersion:2,sheets:structuredClone(saved.sheets)};confirmed.sheets[0].columns[5].destination='ignore';
    await saveResource(store,'profiles',{name:saved.name,sourceId:f.source.id,version:saved.version,profile:confirmed,requestId:requestId()},actor,profile.id);
    batch=await imports.updateImportBatch(store,batch.id,{version:batch.version,profileId:profile.id,config:confirmed,requestId:requestId()},actor);
    batch=await preview(store,batch);valid(batch);
    assert.deepEqual(batch.config.sheets[0].columns.slice(-2).map(column=>column.destination),['ignore','ignore']);
    assert.equal(errors(batch).some(error=>/FORMULA|CACHE/.test(error.code)),false);
    await apply(store,batch);const original=(await expenses(store))[0];assert.equal(Number(original.amount_minor),1000000);
    const accepted=await store.db.get(`SELECT data,preview_hash FROM ${store.t('import_revisions')} WHERE batch_id=?`,[batch.id]);
    store=await restoreFresh(await store.exportData());
    assert.deepEqual(await store.db.get(`SELECT data,preview_hash FROM ${store.t('import_revisions')} WHERE batch_id=?`,[batch.id]),accepted);
    saved=await getResource(store,'profiles',profile.id);assert.deepEqual(saved.sheets[0].columns.slice(-2).map(column=>column.destination),['ignore','ignore']);
    await apply(store,await preview(store,await uploaded(store,f,{tables,bytes,configuration:{formatVersion:2,sheets:saved.sheets},profileId:profile.id,opening:false})));
    assert.deepEqual((await expenses(store))[0],original);await noInventedMoney(store);
  }));

  await t.test('fórmulas usadas conservan autorización por hoja al restaurar y una caché ausente no se autoriza',context=>fixture(async(store,f)=>{
    const restoredStores=[];context.after(async()=>{for(const restored of restoredStores)await restored.close();});
    const restoreFresh=async bundle=>{const restored=await factory();restoredStores.push(restored);await importData(restored,bundle);return restored;};
    const XLSX=createRequire(import.meta.url)('xlsx'),headers=expenseHeaders;
    const configuration={formatVersion:2,sheets:['Fórmulas A','Fórmulas B'].map(name=>expenseConfig(name,headers).sheets[0])};
    const workbook=XLSX.utils.book_new();
    for(const [index,sheet] of configuration.sheets.entries()){
      const data=XLSX.utils.aoa_to_sheet([headers,[`FORMULA-${index}`,'2026-09-29','Gasto calculado sintético',10*(index+1)]]);
      data.D2={t:'n',v:10*(index+1),f:`5*${2*(index+1)}`};
      data.E2={t:'e',v:7,f:'1/0'};data['!ref']='A1:E2';
      XLSX.utils.book_append_sheet(workbook,data,sheet.sheetName);
    }
    const tables=configuration.sheets.map(sheet=>({name:sheet.sheetName,rows:[]}));
    let batch=await preview(store,await uploaded(store,f,{tables,bytes:XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true}),configuration,opening:false}));
    assert.ok(errors(batch).every(error=>error.code==='IMPORT_FORMULA_ACCEPTANCE'));await assert.rejects(()=>accept(store,batch),{status:409});
    batch=await resolve(store,batch,[{action:'accept_formulas',sheet:'Fórmulas A',externalKey:'expenseAmount',value:true}]);
    assert.ok(batch.preview.groups.find(group=>group.rowRefs[0].sheet==='Fórmulas B').errors.some(error=>error.code==='IMPORT_FORMULA_ACCEPTANCE'));
    assert.equal(batch.preview.groups.find(group=>group.rowRefs[0].sheet==='Fórmulas A').errors.length,0);
    const bundle=await store.exportData(),restored=await factory();restoredStores.push(restored);
    for(const patch of [{sheet:''},{sheet:{}},{rowNumber:0},{rowNumber:10002},{rowNumber:3}]){
      const invalid=structuredClone(bundle),row=invalid.business.import_batches.find(row=>row.id===batch.id),data=JSON.parse(row.data);
      Object.assign(data.resolutions.find(resolution=>resolution.action==='accept_formulas'),patch);row.data=JSON.stringify(data);
      await assert.rejects(()=>importData(restored,invalid),{status:400});
    }
    await importData(restored,bundle);store=restored;
    batch=await preview(store,await imports.getImportBatch(store,batch.id));
    assert.equal(batch.preview.groups.find(group=>group.rowRefs[0].sheet==='Fórmulas A').errors.length,0);
    assert.ok(batch.preview.groups.find(group=>group.rowRefs[0].sheet==='Fórmulas B').errors.some(error=>error.code==='IMPORT_FORMULA_ACCEPTANCE'));
    await assert.rejects(()=>accept(store,batch),{status:409});await noInventedMoney(store);
    batch=await resolve(store,batch,[{action:'accept_formulas',sheet:'Fórmulas B',externalKey:'expenseAmount',value:true}]);await apply(store,batch);
    assert.deepEqual((await expenses(store)).map(row=>Number(row.amount_minor)).sort((a,b)=>a-b),[1000,2000]);await noInventedMoney(store);
    store=await restoreFresh(await store.exportData());
    assert.deepEqual((await expenses(store)).map(row=>Number(row.amount_minor)).sort((a,b)=>a-b),[1000,2000]);await noInventedMoney(store);
    workbook.Sheets['Fórmulas B'].D2={t:'z',f:'10*2'};
    const missing=await preview(store,await uploaded(store,f,{tables,bytes:XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true}),configuration,opening:false,resolutions:[{action:'accept_formulas',value:true}]}));
    assert.ok(errors(missing).some(error=>error.code==='EXCEL_FORMULA_NO_CACHE'));await assert.rejects(()=>accept(store,missing),{status:409});
  }));
}
