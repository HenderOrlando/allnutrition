import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { businessOrderInput, createBusinessBasics, fixtureActor, requestId } from './business-fixtures.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { createShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { getSettlement, saveSettlement } from '../lib/business/settlements.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch, uploadImportFile, updateImportBatch, requestImportPreview, getImportBatch, listImportBatches, commitImport, processImportTurn, downloadImportOriginal, exportImportErrors, expireImportFiles, validateImportConfig } from '../lib/business/imports.mjs';
import { buildBusinessReport } from '../lib/business/reports.mjs';

const actor = fixtureActor;
const tableCount = async (store,table) => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);
const fields = ['externalOrderId','externalShipmentId','carrier','tracking','customerName','phone','city','address','placedOn','productExternalKey','quantity','unitPrice','shippingCharge','rawStatus','eventAt','shippingOutCost','shippingOutCostDate','platformFee','platformFeeDate','collectedAmount','collectionDate','collectionExternalId','settlementExternalId','settlementDate','settlementGross','settlementNet'];
const basicRow = (extra = {}) => ({externalOrderId:'ORDER-001',externalShipmentId:'SHIP-001',carrier:'Transportadora sintética',tracking:'0000123456789',customerName:'Cliente sintético',phone:'3001234567',city:'Bogotá',address:'Dirección sintética',placedOn:'2025-09-01',productExternalKey:'SKU-A',quantity:1,unitPrice:'55.000',shippingCharge:'12.000',rawStatus:'Entregado',eventAt:'2025-09-03',shippingOutCost:'15.000',shippingOutCostDate:'2025-09-02',platformFee:'2.000',platformFeeDate:'2025-09-02',collectedAmount:'67.000',collectionDate:'2025-09-03',collectionExternalId:'COLLECTION-001',...extra});
const configFor = (headers = fields,extra = {}) => ({sheetName:'Datos',headerRow:1,dateFormat:'ISO',decimalSeparator:',',groupSeparator:'.',layout:'item_rows',purpose:'orders',columns:headers.map((field,index)=>({index,header:field.toLowerCase(),destination:field,group:0})),statusMap:{Entregado:'delivered',Recogido:'collected',Novedad:'incident',Tránsito:'in_transit'},oneOrderPerGuide:false,reportAsOf:'2025-09-05',...extra});
// The report exporter deliberately renders null as "Sin dato"; source fixtures
// must use genuinely blank cells, not that presentation label as imported data.
const bytesFor = (rows,headers = fields) => writeExcelSheets([{name:'Datos',rows:[headers,...rows.map(row=>headers.map(field=>row[field]??''))]}]);
async function fixture(fn) {
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {const f=await createBusinessBasics(store,{year:2025});await fn(store,f);} finally {await store.close();}
}
async function upload(store,f,rows,{headers=fields,config=configFor(headers),resolutions=[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id}],sourceId=f.source.id,bytes=bytesFor(rows,headers),profileId=null}={}) {
  let batch=await createImportBatch(store,{sourceId,profileId,requestId:requestId()},actor);
  batch=await uploadImportFile(store,batch.id,{filename:'sintetico.xlsx',bytes,version:batch.version,requestId:requestId()},actor);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.state,'review');assert.ok(batch.workbook.sheets.length);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config,resolutions},actor);
  return batch;
}
async function preview(store,batch) {
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  await processImportTurn(store,{batchId:batch.id});return getImportBatch(store,batch.id);
}
async function accept(store,batch,{includeValidOnly=false}={}) {
  assert.ok(batch.preview,batch.error?.message);
  return commitImport(store,batch.id,{version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly,requestId:requestId()},actor);
}
async function finish(store,batch,options={}) {
  await accept(store,batch,options);let result;
  do {result=await processImportTurn(store,{batchId:batch.id});}while(result.state==='queued');
  return getImportBatch(store,batch.id);
}
const linkedOrder = async (store,sourceId,key='ORDER-001') => {
  const link=await store.db.get(`SELECT internal_id FROM ${store.t('external_links')} WHERE source_id=? AND entity_type='order' AND external_key=?`,[sourceId,key]);
  return link ? store.order(link.internal_id) : null;
};

test('Excel agrupa líneas, toma flete una vez, declara liquidación sin caja y reimporta sin duplicar dinero',()=>fixture(async(store,f)=>{
  const rows=[basicRow({quantity:2,collectedAmount:'122.000',settlementExternalId:'SET-1',settlementDate:'2025-09-05',settlementGross:'122.000',settlementNet:'105.000'}),basicRow({productExternalKey:'GIFT',quantity:1,unitPrice:'0',collectedAmount:'122.000',settlementExternalId:'SET-1',settlementDate:'2025-09-05',settlementGross:'122.000',settlementNet:'105.000'})];
  const resolutions=[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},{action:'link_product',externalKey:'GIFT',internalId:f.gift.id}];
  let batch=await preview(store,await upload(store,f,rows,{resolutions}));
  assert.equal(batch.preview.summary.valid,1);assert.equal(batch.preview.groups[0].lines.length,2);
  batch=await finish(store,batch);assert.equal(batch.state,'completed');
  let order=await linkedOrder(store,f.source.id);assert.equal(order.totalMinor,12200000);assert.equal(order.shippingChargeMinor,1200000);assert.equal(order.items.length,2);
  assert.equal(order.paymentSummary.netCollectedMinor,12200000);assert.equal(order.paymentSummary.platformHeldMinor,12200000);
  assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'order_collections'),1);assert.equal(await tableCount(store,'expenses'),2);assert.equal(await tableCount(store,'settlements'),1);
  assert.equal(await tableCount(store,'settlement_receipts'),0);assert.equal(await tableCount(store,'cash_entries'),1);
  const counts={events:await tableCount(store,'shipment_events'),collections:await tableCount(store,'order_collections'),expenses:await tableCount(store,'expenses')};
  for(const repeated of [rows,[...rows].reverse()]) {
    const second=await preview(store,await upload(store,f,repeated));await finish(store,second);
    assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'shipment_events'),counts.events);assert.equal(await tableCount(store,'order_collections'),counts.collections);assert.equal(await tableCount(store,'expenses'),counts.expenses);assert.equal(await tableCount(store,'settlements'),1);
  }
  order=await linkedOrder(store,f.source.id);assert.equal(order.items.find(line=>line.itemId===f.a.id).quantity,2);
}));

test('celdas opcionales vacías no inventan dinero ni identidades y "Sin dato" sigue siendo texto real',()=>fixture(async(store,f)=>{
  const row=basicRow({externalOrderId:'Sin dato',productExternalKey:'Sin dato',shippingCharge:'0',shippingOutCost:null,shippingOutCostDate:null,platformFee:null,platformFeeDate:null,collectedAmount:null,collectionDate:null,collectionExternalId:null});
  const batch=await preview(store,await upload(store,f,[row],{resolutions:[{action:'link_product',externalKey:'Sin dato',internalId:f.a.id}]}));
  assert.equal(batch.preview.summary.valid,1);
  const values=batch.rows.records[0].normalized.values;
  assert.equal(values.externalOrderId,'Sin dato');assert.equal(values.shippingCharge,0);
  for(const field of ['shippingOutCost','shippingOutCostDate','platformFee','platformFeeDate','collectedAmount','collectionDate','collectionExternalId','settlementExternalId','settlementDate','settlementGross','settlementNet'])assert.equal(values[field]??null,null,field);
  await finish(store,batch);
  const order=await linkedOrder(store,f.source.id,'Sin dato');assert.equal(order.totalMinor,5500000);assert.equal(order.paymentSummary.netCollectedMinor,0);
  assert.equal(await tableCount(store,'expenses'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'settlements'),0);assert.equal(await tableCount(store,'cash_entries'),1);
  const headers=['settlementExternalId','settlementDate','settlementGross','settlementNet'];
  await finish(store,await preview(store,await upload(store,f,[{settlementExternalId:'Sin dato',settlementNet:'0'}],{headers,config:configFor(headers,{purpose:'settlements'}),resolutions:[]})));
  const statement=await getSettlement(store,(await store.db.get(`SELECT id FROM ${store.t('settlements')}`)).id);
  assert.equal(statement.netMinor,0);assert.equal(statement.reportedOn,null);assert.equal(statement.unresolvedLines[0].grossMinor,null);assert.equal(await tableCount(store,'cash_entries'),1);
  const bad=await preview(store,await upload(store,f,[basicRow({shippingOutCost:'Sin dato'})]));
  assert.equal(bad.preview.summary.valid,0);assert.ok(bad.preview.groups[0].errors.some(error=>error.field==='shippingOutCost'));
}));

test('múltiples grupos de producto order_rows conservan encabezados repetidos por posición',()=>fixture(async(store,f)=>{
  const headers=['Pedido','Envío','Transportadora','Guía','Nombre','Teléfono','Ciudad','Fecha','SKU','Cantidad','Precio','SKU','Cantidad','Precio'];
  const destinations=['externalOrderId','externalShipmentId','carrier','tracking','customerName','phone','city','placedOn','productExternalKey','quantity','unitPrice','productExternalKey','quantity','unitPrice'];
  const bytes=writeExcelSheets([{name:'Datos',rows:[headers,['MULTI','MULTI-S','Transportadora','000001','Persona','3001234567','Bogotá','2025-09-01','SKU-A',2,'55.000','GIFT',1,'0']]}]);
  const config=configFor([],{layout:'order_rows',reportAsOf:'2025-09-01',columns:headers.map((header,index)=>({index,header:header.toLowerCase(),destination:destinations[index],group:index>=11?1:0}))});
  const batch=await preview(store,await upload(store,f,[],{bytes,config,resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},{action:'link_product',externalKey:'GIFT',internalId:f.gift.id}]}));
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  const order=await linkedOrder(store,f.source.id,'MULTI');assert.equal(order.items.length,2);assert.equal(order.totalMinor,11000000);
}));

test('perfiles distintos comparten identidad de fuente y cuentas distintas aíslan IDs y alias',()=>fixture(async(store,f)=>{
  const profile1=await saveResource(store,'profiles',{requestId:requestId(),sourceId:f.source.id,name:'Perfil uno',...configFor()},actor);
  const profile2=await saveResource(store,'profiles',{requestId:requestId(),sourceId:f.source.id,name:'Perfil dos',...configFor()},actor);
  await finish(store,await preview(store,await upload(store,f,[basicRow()],{profileId:profile1.id})));
  await finish(store,await preview(store,await upload(store,f,[basicRow()],{profileId:profile2.id})));
  assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'order_collections'),1);
  const source2=await saveResource(store,'sources',{requestId:requestId(),platformId:f.platform.id,name:'Otra cuenta'},actor);
  const second=await preview(store,await upload(store,f,[basicRow({tracking:'000099999',unitPrice:'10.000',collectedAmount:'22.000'})],{sourceId:source2.id,resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.b.id}]}));
  await finish(store,second);
  assert.equal(await tableCount(store,'orders'),2);assert.equal(await tableCount(store,'order_collections'),2);
  assert.equal((await linkedOrder(store,source2.id)).items[0].itemId,f.b.id);assert.equal((await linkedOrder(store,f.source.id)).items[0].itemId,f.a.id);
}));

test('seguimiento incompleto conserva envío sin venta, fechas desconocidas y estado externo visible',()=>fixture(async(store,f)=>{
  const headers=['externalShipmentId','carrier','tracking','rawStatus'];
  const batch=await preview(store,await upload(store,f,[{externalShipmentId:'UNLINKED',carrier:'Transportadora',tracking:'000012',rawStatus:'Estado sin equivalencia'}],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,1);assert.equal(batch.preview.groups[0].tasks[0].type,'link_order');
  const done=await finish(store,batch);assert.equal(done.state,'completed');assert.equal(await tableCount(store,'orders'),0);
  const shipment=await store.db.get(`SELECT * FROM ${store.t('shipments')}`), event=await store.db.get(`SELECT * FROM ${store.t('shipment_events')}`);
  assert.equal(shipment.order_id,null);assert.equal(shipment.status,'unknown');assert.equal(event.occurred_at,null);assert.equal(event.occurred_on,null);assert.ok(event.source_as_of);assert.equal(JSON.parse(event.data).rawStatus,'Estado sin equivalencia');
  assert.equal(done.config.reportAsOf,'2025-09-05');
  const report=await buildBusinessReport(store,{period:'month',anchorDate:'2025-09-01',asOf:'2025-09-05T17:00:00.000Z'});
  const source=report.lastImportAt.find(item=>item.sourceId===f.source.id);
  assert.equal(source.precision,'day');assert.equal(source.sourceDate,'2025-09-05');
  assert.ok(source.importedAt>'2025-09-05T17:00:00.000Z','La carga tardía conserva su instante real, no el corte financiero histórico.');
  assert.equal(report.metrics.transitDays.value,null);
}));

test('filas idénticas requieren decidir duplicado o cantidad adicional; flete contradictorio bloquea grupo entero',()=>fixture(async(store,f)=>{
  const row=basicRow({collectedAmount:null,collectionDate:null,collectionExternalId:null});
  let batch=await preview(store,await upload(store,f,[row,row]));assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_DUPLICATE_ROW'));
  await assert.rejects(()=>accept(store,batch),{status:409});
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'additional_quantity',sheet:'Datos',rowNumber:3}]},actor);batch=await preview(store,batch);await finish(store,batch);
  assert.equal((await linkedOrder(store,f.source.id)).items[0].quantity,2);
  const conflict=await preview(store,await upload(store,f,[basicRow({externalOrderId:'CONFLICT',externalShipmentId:'CONFLICT-S',tracking:'000077',shippingCharge:'10.000'}),basicRow({externalOrderId:'CONFLICT',externalShipmentId:'CONFLICT-S',tracking:'000077',productExternalKey:'SKU-B',shippingCharge:'12.000'})],{resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},{action:'link_product',externalKey:'SKU-B',internalId:f.b.id}]}));
  assert.equal(conflict.preview.summary.valid,0);assert.ok(conflict.preview.groups[0].errors.some(error=>error.code==='IMPORT_REPEATED_FIELD'));assert.equal(await linkedOrder(store,f.source.id,'CONFLICT'),null);
}));

test('versión destino entre preview y apply produce conflicto sin escritura ni alias parcial',()=>fixture(async(store,f)=>{
  const batch=await preview(store,await upload(store,f,[basicRow()]));await accept(store,batch);
  const a=await store.get('products',f.a.id);await store.save('products',{...a,title:'Producto corregido'},a.id,a.version,actor);
  const result=await processImportTurn(store,{batchId:batch.id});assert.equal(result.state,'completed_with_errors');
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'external_links'),0);
  const current=await getImportBatch(store,batch.id);assert.equal(current.rows.records[0].state,'conflict');
}));

test('valid-only importa únicamente grupos completos y un fallo financiero revierte venta, costos y contador',()=>fixture(async(store,f)=>{
  const good=basicRow({collectedAmount:null,collectionExternalId:null,collectionDate:null});
  const bad=basicRow({externalOrderId:'BAD',externalShipmentId:'BAD-S',tracking:'000089',productExternalKey:'NO-LINK'});
  const batch=await preview(store,await upload(store,f,[good,bad]));assert.equal(batch.preview.summary.valid,1);assert.equal(batch.preview.summary.rejected,1);
  await assert.rejects(()=>accept(store,batch),{status:409});const done=await finish(store,batch,{includeValidOnly:true});assert.equal(done.state,'completed_with_errors');assert.equal(await tableCount(store,'orders'),1);assert.equal(await linkedOrder(store,f.source.id,'BAD'),null);
  const beforeOrders=Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`)).value), beforeRevision=Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);
  const failing=await preview(store,await upload(store,f,[basicRow({externalOrderId:'OVER',externalShipmentId:'OVER-S',tracking:'000090',collectedAmount:'999.000',collectionExternalId:'OVER-C'})]));
  await accept(store,failing);await processImportTurn(store,{batchId:failing.id});
  assert.equal(await linkedOrder(store,f.source.id,'OVER'),null);assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'expenses'),2);
  assert.equal(Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`)).value),beforeOrders);
  assert.ok(Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value)>=beforeRevision);
  const commands=await store.db.all(`SELECT scope FROM ${store.t('business_requests')} WHERE scope LIKE ?`,[`import:${failing.id}:group:%`]);assert.equal(commands.length,0);
}));

test('trabajo durable reanuda tras abandono de lease y no reaplica grupos ya confirmados',()=>fixture(async(store,f)=>{
  const rows=[1,2,3].map(n=>basicRow({externalOrderId:`RESUME-${n}`,externalShipmentId:`RESUME-S-${n}`,tracking:`0000${n}`,collectionExternalId:`RESUME-C-${n}`}));
  const batch=await preview(store,await upload(store,f,rows));await accept(store,batch);
  const first=await processImportTurn(store,{batchId:batch.id,maxGroups:1});assert.equal(first.state,'queued');assert.equal(first.processed,1);assert.equal(first.hasMore,true);assert.equal(await tableCount(store,'orders'),1);
  const now=new Date().toISOString(), abandoned=await claimJob(store,{key:`import:${batch.id}`,now});assert.ok(abandoned);
  const whileLeased=await processImportTurn(store,{batchId:batch.id,now});assert.equal(whileLeased.processed,0);
  const recovered=await processImportTurn(store,{batchId:batch.id,now:new Date(Date.parse(now)+121000).toISOString()});assert.equal(recovered.state,'completed');assert.equal(await tableCount(store,'orders'),3);assert.equal(await tableCount(store,'order_collections'),3);
  await processImportTurn(store,{batchId:batch.id});assert.equal(await tableCount(store,'orders'),3);assert.equal(await tableCount(store,'order_collections'),3);
}));

test('revisión aceptada congela resoluciones y bytes; dos commits concurrentes no encolan dos versiones',()=>fixture(async(store,f)=>{
  const batch=await preview(store,await upload(store,f,[basicRow()]));
  const input={version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly:false,requestId:randomUUID()};
  const results=await Promise.all([commitImport(store,batch.id,input,actor),commitImport(store,batch.id,input,actor)]);assert.equal(results[0].acceptedRevision,results[1].acceptedRevision);
  const queued=await getImportBatch(store,batch.id);
  await assert.rejects(()=>updateImportBatch(store,batch.id,{version:queued.version,requestId:requestId(),resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.b.id}]},actor),{status:409});
  await assert.rejects(()=>uploadImportFile(store,batch.id,{version:queued.version,requestId:requestId(),filename:'otro.xlsx',bytes:bytesFor([basicRow({unitPrice:'1'})])},actor),{status:409});
  assert.equal(await tableCount(store,'import_revisions'),1);await processImportTurn(store,{batchId:batch.id});assert.equal((await linkedOrder(store,f.source.id)).items[0].itemId,f.a.id);
  const original=await downloadImportOriginal(store,batch.id);assert.equal(createHash('sha256').update(original.bytes).digest('hex'),batch.fileHash);
  const dto=await getImportBatch(store,batch.id);assert.equal('fileBytesBase64' in dto,false);assert.equal('bytes' in dto,false);
}));

test('cortes antiguos no pisan costos ni entrega y corte igual discrepante exige autoridad',()=>fixture(async(store,f)=>{
  await finish(store,await preview(store,await upload(store,f,[basicRow()])));
  const headers=['externalOrderId','externalShipmentId','carrier','tracking','rawStatus','eventAt','shippingOutCost','shippingOutCostDate'];
  const old=basicRow({rawStatus:'Recogido',eventAt:'2025-09-02',shippingOutCost:'9.000'});
  await finish(store,await preview(store,await upload(store,f,[old],{headers,config:configFor(headers,{purpose:'tracking',reportAsOf:'2025-09-04'}),resolutions:[]})));
  const order=await linkedOrder(store,f.source.id);assert.equal(order.shipments[0].status,'delivered');assert.equal(order.expenses.find(expense=>expense.category==='shipping_out').amountMinor,1500000);
  const conflict=await preview(store,await upload(store,f,[old],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));
  assert.ok(conflict.preview.groups[0].errors.some(error=>error.code==='IMPORT_COST_AUTHORITY'));
  const unknownHeaders=['externalShipmentId','carrier','tracking','rawStatus'];
  await finish(store,await preview(store,await upload(store,f,[{externalShipmentId:'SHIP-001',carrier:'Transportadora sintética',tracking:'0000123456789',rawStatus:'No catalogado'}],{headers:unknownHeaders,config:configFor(unknownHeaders,{purpose:'tracking',reportAsOf:'2025-09-06'}),resolutions:[]})));
  const after=await linkedOrder(store,f.source.id);assert.equal(after.shipments[0].status,'delivered');assert.ok(after.shipments[0].events.some(event=>event.status==='unknown'));
}));

test('snapshots de recaudo crean solo diferencia positiva y rechazan disminuciones sin reembolsos inventados',()=>fixture(async(store,f)=>{
  const row=basicRow({collectedAmount:'20.000',collectionExternalId:null});
  await finish(store,await preview(store,await upload(store,f,[row])));
  for(const [cut,amount] of [['2025-09-06','50.000'],['2025-09-07','67.000'],['2025-09-08','67.000']])await finish(store,await preview(store,await upload(store,f,[{...row,collectedAmount:amount}],{config:configFor(fields,{reportAsOf:cut})})));
  const order=await linkedOrder(store,f.source.id);assert.equal(order.paymentSummary.netCollectedMinor,6700000);assert.equal(await tableCount(store,'order_collections'),3);
  const lower=await preview(store,await upload(store,f,[{...row,collectedAmount:'40.000'}],{config:configFor(fields,{reportAsOf:'2025-09-09'})}));
  assert.ok(lower.preview.groups[0].errors.some(error=>error.code==='IMPORT_COLLECTION_RECTIFICATION'));assert.equal(await tableCount(store,'order_collections'),3);
}));

test('incidente, tránsito, incidente conserva episodios; repetir mismo corte no añade evento',()=>fixture(async(store,f)=>{
  const headers=['externalShipmentId','carrier','tracking','rawStatus'];
  for(const [date,status] of [['2025-09-01','Novedad'],['2025-09-02','Tránsito'],['2025-09-03','Novedad'],['2025-09-03','Novedad']]){
    const row={externalShipmentId:'EPISODE',carrier:'Transportadora',tracking:'000EP',rawStatus:status};
    await finish(store,await preview(store,await upload(store,f,[row],{headers,config:configFor(headers,{purpose:'tracking',reportAsOf:date}),resolutions:[]})));
  }
  assert.equal(await tableCount(store,'shipment_events'),3);assert.equal(await tableCount(store,'orders'),0);
  const events=await store.db.all(`SELECT status,occurred_at,occurred_on FROM ${store.t('shipment_events')}`);assert.equal(events.filter(event=>event.status==='incident').length,2);assert.ok(events.every(event=>event.occurred_at===null && event.occurred_on===null));
}));

test('la misma guía en otra fuente exige vínculo explícito, nunca se fusiona por cliente',()=>fixture(async(store,f)=>{
  await finish(store,await preview(store,await upload(store,f,[basicRow()])));
  const source=await saveResource(store,'sources',{requestId:requestId(),platformId:f.platform.id,name:'Cuenta dos'},actor), headers=['externalShipmentId','carrier','tracking','rawStatus'];
  const row={externalShipmentId:'SHIP-OTHER',carrier:'Transportadora sintética',tracking:'0000123456789',rawStatus:'Entregado'};
  let batch=await preview(store,await upload(store,f,[row],{sourceId:source.id,headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));assert.equal(batch.preview.summary.valid,0);assert.equal(await tableCount(store,'shipments'),1);
  const existing=(await linkedOrder(store,f.source.id)).shipments[0];
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'link_shipment',externalKey:'SHIP-OTHER',internalId:existing.id,reason:'Misma guía revisada explícitamente'}]},actor);batch=await preview(store,batch);await finish(store,batch);
  assert.equal(await tableCount(store,'shipments'),1);assert.equal(await tableCount(store,'orders'),1);
}));

test('retención borra solo bytes y exporta excepciones XLSX conservando hechos y revisiones',()=>fixture(async(store,f)=>{
  const batch=await preview(store,await upload(store,f,[basicRow()]));await finish(store,batch);
  const before=await getImportBatch(store,batch.id), expires=new Date(Date.parse(before.expiresAt)+1).toISOString();
  await expireImportFiles(store,{now:expires});const expired=await getImportBatch(store,batch.id);
  assert.equal(expired.fileExpired,true);assert.equal(expired.state,'completed');assert.equal(expired.rows.records[0].state,'applied');assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'import_revisions'),1);
  await assert.rejects(()=>downloadImportOriginal(store,batch.id),{status:404});
  const bad=await preview(store,await upload(store,f,[basicRow({externalOrderId:'ERROR',externalShipmentId:'ERR-S',tracking:'000ERR',productExternalKey:'=UNTRUSTED()'})],{resolutions:[]}));
  const bytes=await exportImportErrors(store,bad.id);assert.ok(bytes instanceof Uint8Array);assert.equal(Buffer.from(bytes).subarray(0,2).toString(),'PK');
  const list=await listImportBatches(store,{page:1});assert.equal(list.pageSize,20);assert.equal(list.total,2);assert.ok(list.records.every(row=>!Object.hasOwn(row,'fileBytesBase64')));
}));

test('validación pura rechaza destinos ejecutables, separadores iguales y grupos no permitidos',()=>{
  assert.throws(()=>validateImportConfig({columns:[{index:0,header:'x',destination:'SELECT * FROM orders'}]}));
  assert.throws(()=>validateImportConfig({decimalSeparator:',',groupSeparator:','}));
  assert.throws(()=>validateImportConfig({columns:[{index:0,header:'x',destination:'carrier',group:1}]}));
  assert.throws(()=>validateImportConfig({columns:[{index:0,header:'x',destination:'carrier'},{index:0,header:'y',destination:'tracking'}]}));
  assert.equal(validateImportConfig({reportAsOf:'2025-09-05'}).reportAsOf,'2025-09-05');
});

test('un acumulado posterior a un cobro conocido crea solo diferencia y transacciones distintas conservan sus referencias',()=>fixture(async(store,f)=>{
  const order=await store.saveOrder(businessOrderInput(f.a,{year:2025}),actor);
  const shipment=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:f.platform.id,sourceId:f.source.id,externalId:'SHIP-001',carrier:'Transportadora sintética',tracking:'0000123456789'},actor);
  await recordCollection(store,{requestId:requestId(),orderId:order.id,version:(await store.order(order.id)).version,shipmentId:shipment.id,sourceId:f.source.id,holder:'platform',externalKey:'PREVIOUS-EVENT',amountMinor:2000000,occurredOn:'2025-09-03',method:'Recaudo',reference:'Abono previo'},actor);
  const headers=['externalShipmentId','carrier','tracking','collectedAmount','collectionDate'];
  await finish(store,await preview(store,await upload(store,f,[basicRow({collectedAmount:'50.000'})],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]})));
  assert.equal((await store.order(order.id)).paymentSummary.netCollectedMinor,5000000);
  const facts=await store.db.all(`SELECT amount_minor FROM ${store.t('order_collections')} ORDER BY amount_minor`);assert.deepEqual(facts.map(row=>Number(row.amount_minor)),[2000000,3000000]);
  const eventHeaders=[...headers,'collectionExternalId'];
  const rows=[basicRow({collectedAmount:'10.000',collectionDate:'2025-09-06',collectionExternalId:'NEXT-1'}),basicRow({collectedAmount:'7.000',collectionDate:'2025-09-06',collectionExternalId:'NEXT-2'})];
  const batch=await preview(store,await upload(store,f,rows,{headers:eventHeaders,config:configFor(eventHeaders,{purpose:'tracking',reportAsOf:'2025-09-07'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);assert.equal((await store.order(order.id)).paymentSummary.netCollectedMinor,6700000);assert.equal(await tableCount(store,'order_collections'),4);
}));

test('rectificar entrega muestra evento real y recalcula reconocimiento sin mover caja',()=>fixture(async(store,f)=>{
  const order=await store.saveOrder(businessOrderInput(f.a,{year:2025}),actor);
  let shipment=await createShipment(store,{requestId:requestId(),orderId:order.id,platformId:f.platform.id,sourceId:f.source.id,externalId:'FALSE-DELIVERY',carrier:'Transportadora',tracking:'000FALSE'},actor);
  shipment=await recordShipmentEvent(store,shipment.id,{requestId:requestId(),version:shipment.version,status:'delivered',occurredOn:'2025-09-03',externalKey:'FALSE-EVENT'},actor);
  assert.equal((await store.order(order.id)).recognition.on,'2025-09-03');
  const headers=['externalShipmentId','carrier','tracking','rawStatus','eventAt'];
  let batch=await preview(store,await upload(store,f,[{externalShipmentId:'FALSE-DELIVERY',carrier:'Transportadora',tracking:'000FALSE',rawStatus:'Tránsito',eventAt:'2025-09-04'}],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,0);const task=batch.preview.groups[0].tasks.find(task=>task.eventId);assert.equal(task.eventId,shipment.events[0].id);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'review_authority',entityKey:batch.preview.groups[0].key,value:{correctionOf:task.eventId},reason:'La plataforma rectificó una entrega que no ocurrió'}]},actor);
  await finish(store,await preview(store,batch));const corrected=await store.order(order.id);assert.equal(corrected.recognition,null);assert.equal(corrected.shipments[0].status,'in_transit');assert.equal(await tableCount(store,'cash_entries'),1);
}));

test('política histórica requiere aprobación y precio ausente no produce media venta',()=>fixture(async(store,f)=>{
  let batch=await preview(store,await upload(store,f,[basicRow({placedOn:'2020-09-01',collectedAmount:null,collectionExternalId:null,collectionDate:null})]));assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_POLICY_REQUIRED'));
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'review_policy',entityKey:batch.preview.groups[0].key,value:{ruleVersionId:'rules-september'},reason:'Política histórica revisada expresamente'}]},actor);
  await finish(store,await preview(store,batch));assert.equal((await linkedOrder(store,f.source.id)).policyReviewRequired,false);
  const headers=['externalOrderId','externalShipmentId','carrier','tracking','customerName','phone','city','placedOn','productExternalKey','quantity','unitPrice'];
  const incomplete=[basicRow({externalOrderId:'INCOMPLETE',externalShipmentId:'INC-S',tracking:'000INC'}),basicRow({externalOrderId:'INCOMPLETE',externalShipmentId:'INC-S',tracking:'000INC',productExternalKey:'SKU-B',unitPrice:null})];
  const pending=await preview(store,await upload(store,f,incomplete,{headers,resolutions:[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},{action:'link_product',externalKey:'SKU-B',internalId:f.b.id}]}));
  assert.equal(pending.preview.summary.valid,1);await finish(store,pending);assert.equal(await linkedOrder(store,f.source.id,'INCOMPLETE'),null);assert.equal(await tableCount(store,'orders'),1);
}));

test('liquidación sin cobros vinculados queda declarada pendiente, sin venta, caja o recibo ficticios',()=>fixture(async(store,f)=>{
  const headers=['settlementExternalId','settlementDate','settlementGross','settlementNet','settlementReference'];
  const rows=[{settlementExternalId:'UNRESOLVED-SET',settlementDate:'2025-09-05',settlementGross:'122.000',settlementNet:'105.000',settlementReference:'Declaración pendiente sintética'}];
  const batch=await preview(store,await upload(store,f,rows,{headers,config:configFor(headers,{purpose:'settlements'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,1);const done=await finish(store,batch);assert.equal(done.state,'completed');
  const row=await store.db.get(`SELECT * FROM ${store.t('settlements')}`), data=JSON.parse(row.data);
  assert.equal(row.state,'pending');assert.equal(Number(row.net_minor),10500000);assert.equal(data.reconciliationRequired,true);assert.equal(data.unresolvedLines.length,1);
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'settlement_receipts'),0);assert.equal(await tableCount(store,'cash_entries'),1);
  await finish(store,await preview(store,await upload(store,f,rows,{headers,config:configFor(headers,{purpose:'settlements'}),resolutions:[]})));assert.equal(await tableCount(store,'settlements'),1);
}));

test('envoltura inválida falla antes de encolar y el archivo corrupto queda fallido durable sin comercio',()=>fixture(async(store,f)=>{
  let batch=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},actor);
  await assert.rejects(()=>uploadImportFile(store,batch.id,{version:batch.version,requestId:requestId(),filename:'datos.xlsx',bytes:Buffer.from('no es Excel')},actor),{status:415});
  await assert.rejects(()=>uploadImportFile(store,batch.id,{version:batch.version,requestId:requestId(),filename:'datos.xlsx',bytes:Buffer.alloc(10*1024*1024+1)},actor),{status:413});
  assert.equal(await tableCount(store,'job_runs'),0);
  batch=await uploadImportFile(store,batch.id,{version:batch.version,requestId:requestId(),filename:'datos.xlsx',bytes:Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0])},actor);await processImportTurn(store,{batchId:batch.id});
  const failed=await getImportBatch(store,batch.id);assert.equal(failed.state,'failed');assert.ok(failed.error.message);assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('dos guías particionan unidades sin duplicar venta y distribución ambigua se revisa explícitamente',()=>fixture(async(store,f)=>{
  const headers=['externalOrderId','externalShipmentId','carrier','tracking','customerName','phone','city','placedOn','productExternalKey','quantity','unitPrice','shippingCharge','externalLineId'];
  const rows=[basicRow({externalShipmentId:'SPLIT-1',tracking:'000SPLIT1',quantity:2,externalLineId:'LINE-1'}),basicRow({externalShipmentId:'SPLIT-2',tracking:'000SPLIT2',quantity:2,externalLineId:'LINE-1'})];
  let batch=await preview(store,await upload(store,f,rows,{headers}));
  assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_SHIPMENT_ASSIGNMENTS'));
  const lineId=batch.preview.groups[0].lines[0].lineId;
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'commercial_update',entityKey:batch.preview.groups[0].key,reason:'Cada guía lleva una de las dos unidades acordadas',value:{shipmentAssignments:[{externalShipmentId:'SPLIT-1',assignments:[{lineId,quantity:1}]},{externalShipmentId:'SPLIT-2',assignments:[{lineId,quantity:1}]}]}}]},actor);
  const ready=await preview(store,batch);assert.equal(ready.preview.summary.valid,1);await finish(store,ready);
  const order=await linkedOrder(store,f.source.id);assert.equal(order.totalMinor,12200000);assert.equal(order.items[0].quantity,2);assert.equal(order.shipments.length,2);assert.deepEqual(order.shipments.map(shipment=>shipment.assignments[0].quantity),[1,1]);
  await finish(store,await preview(store,await upload(store,f,[...rows].reverse(),{headers})));assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'shipments'),2);
}));

test('encabezados únicos reordenados se resuelven por nombre y perfil modificado exige revisión nueva',()=>fixture(async(store,f)=>{
  const row=basicRow();
  await finish(store,await preview(store,await upload(store,f,[row])));
  const reversed=[...fields].reverse(), reordered=await preview(store,await upload(store,f,[row],{headers:reversed,config:configFor(fields)}));
  assert.equal(reordered.preview.summary.valid,1);assert.equal(reordered.preview.summary.unchanged,1);await finish(store,reordered);assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'order_collections'),1);
  const profile=await saveResource(store,'profiles',{requestId:requestId(),sourceId:f.source.id,name:'Perfil versionado',...configFor()},actor);
  const pending=await preview(store,await upload(store,f,[basicRow({externalOrderId:'PROFILE-CHANGE',externalShipmentId:'PROFILE-S',tracking:'000PROFILE',collectionExternalId:'PROFILE-C'})],{profileId:profile.id}));
  await saveResource(store,'profiles',{...profile,name:'Perfil corregido',requestId:requestId()},actor,profile.id);
  await assert.rejects(()=>accept(store,pending),{status:409});assert.equal(await linkedOrder(store,f.source.id,'PROFILE-CHANGE'),null);
}));

test('cambiar hoja y encabezado vuelve a inspeccionar muestras de forma durable',()=>fixture(async(store,f)=>{
  const bytes=writeExcelSheets([{name:'Inicio',rows:[['Solo portada']]},{name:'Datos',rows:[['Exportación sintética'],[],fields,...[basicRow()].map(row=>fields.map(field=>row[field]??''))]}]);
  let batch=await upload(store,f,[],{bytes,config:configFor(fields,{headerRow:3})});
  assert.equal(batch.state,'uploaded');await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.workbook.sheetName,'Datos');assert.equal(batch.workbook.headerRow,3);assert.ok(batch.workbook.rows.some(row=>row.rowNumber===3));
  await finish(store,await preview(store,batch));assert.equal((await linkedOrder(store,f.source.id)).totalMinor,6700000);
}));

test('un estado de cuenta compartido no fusiona pedidos: 25 grupos por turno y liquidación posterior reanudable',()=>fixture(async(store,f)=>{
  const rows=Array.from({length:30},(_,index)=>basicRow({externalOrderId:`BULK-${index}`,externalShipmentId:`BULK-S-${index}`,tracking:`000BULK${index}`,collectionExternalId:`BULK-C-${index}`,settlementExternalId:'STATEMENT-30',settlementDate:'2025-09-05',settlementGross:'67.000',settlementNet:'1.500.000'}));
  let batch=await preview(store,await upload(store,f,rows));assert.equal(batch.preview.summary.valid,30);await accept(store,batch);
  let turn=await processImportTurn(store,{batchId:batch.id});assert.equal(turn.processed,25);assert.equal(turn.hasMore,true);assert.equal(await tableCount(store,'orders'),25);assert.equal(await tableCount(store,'settlements'),0);
  turn=await processImportTurn(store,{batchId:batch.id});assert.equal(turn.state,'completed');assert.equal(turn.processed,6);assert.equal(await tableCount(store,'orders'),30);assert.equal(await tableCount(store,'order_collections'),30);assert.equal(await tableCount(store,'settlements'),1);assert.equal(await tableCount(store,'settlement_receipts'),0);
  const declaration=await store.db.get(`SELECT * FROM ${store.t('settlements')}`);assert.equal(Number(declaration.net_minor),150000000);assert.equal(JSON.parse(declaration.data).lines.length,30);
  batch=await preview(store,await upload(store,f,[...rows].reverse()));await finish(store,batch);
  assert.equal(await tableCount(store,'orders'),30);assert.equal(await tableCount(store,'order_collections'),30);assert.equal(await tableCount(store,'settlements'),1);assert.equal(await tableCount(store,'expenses'),60);assert.equal(await tableCount(store,'cash_entries'),1);
}));

test('valid-only conserva declaración completa con referencias omitidas y luego resuelve sin reaplicar grupos',()=>fixture(async(store,f)=>{
  const shared={settlementExternalId:'PARTIAL-STATEMENT',settlementDate:'2025-09-05',settlementGross:'67.000',settlementNet:'100.000'};
  const rows=[basicRow(shared),basicRow({...shared,externalOrderId:'PENDING-2',externalShipmentId:'PENDING-S-2',tracking:'000PENDING2',collectionExternalId:'PENDING-C-2',productExternalKey:'NEEDS-LINK'})];
  let batch=await preview(store,await upload(store,f,rows));assert.equal(batch.preview.summary.valid,1);await finish(store,batch,{includeValidOnly:true});
  let row=await store.db.get(`SELECT * FROM ${store.t('settlements')}`), declaration=await getSettlement(store,row.id);
  assert.equal(declaration.unresolvedLines.length,1);assert.equal(declaration.declaredGrossMinor,13400000);assert.equal(declaration.netMinor,10000000);assert.equal(declaration.reconciliationRequired,true);assert.equal(await tableCount(store,'orders'),1);
  batch=await getImportBatch(store,batch.id);batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'link_product',externalKey:'NEEDS-LINK',internalId:f.a.id}]},actor);
  batch=await preview(store,batch);assert.equal(batch.preview.summary.applied,1);assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  declaration=await getSettlement(store,row.id);assert.equal(declaration.unresolvedLines.length,0);assert.equal(declaration.lines.length,2);assert.equal(declaration.reconciliationRequired,false);assert.equal(await tableCount(store,'orders'),2);assert.equal(await tableCount(store,'order_collections'),2);assert.equal(await tableCount(store,'settlements'),1);assert.equal(await tableCount(store,'settlement_receipts'),0);
}));

test('conflicto de declaración admite revisión de solo documentos sin repetir cobros aplicados',()=>fixture(async(store,f)=>{
  const batch=await preview(store,await upload(store,f,[basicRow({settlementExternalId:'DOCUMENT-RACE',settlementDate:'2025-09-05',settlementGross:'67.000',settlementNet:'50.000'})]));await accept(store,batch);
  const first=await processImportTurn(store,{batchId:batch.id,maxGroups:1});assert.equal(first.state,'queued');assert.equal(await tableCount(store,'settlements'),0);
  const order=await linkedOrder(store,f.source.id), collection=order.collections[0];
  await saveSettlement(store,{requestId:requestId(),sourceId:f.source.id,externalKey:'DOCUMENT-RACE',reportedOn:'2025-09-05',netMinor:5000000,lines:[{collectionId:collection.id,grossMinor:6700000,deductions:order.expenses.map(expense=>({expenseId:expense.id,amountMinor:expense.amountMinor}))}]},actor);
  await processImportTurn(store,{batchId:batch.id});let current=await getImportBatch(store,batch.id);assert.equal(current.state,'completed_with_errors');assert.equal(current.progress.settlementIssues.length,1);assert.equal(current.rows.records[0].state,'applied');
  current=await preview(store,current);assert.equal(current.preview.summary.valid,0);assert.equal(current.preview.summary.settlementsPending,1);await finish(store,current);
  current=await getImportBatch(store,batch.id);assert.equal(current.state,'completed');assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'order_collections'),1);assert.equal(await tableCount(store,'settlements'),1);assert.equal(await tableCount(store,'import_revisions'),2);
}));

test('recaudo conocido sin fecha queda en cobertura pendiente, no fabrica caja ni antigüedad',()=>fixture(async(store,f)=>{
  const row=basicRow({collectionDate:null,collectionExternalId:null});
  const batch=await preview(store,await upload(store,f,[row]));assert.equal(batch.preview.summary.valid,1);assert.ok(batch.preview.groups[0].tasks.some(task=>task.type==='collection_date'));
  await finish(store,batch);const order=await linkedOrder(store,f.source.id), collection=order.collections[0];
  assert.equal(collection.amountMinor,6700000);assert.equal(collection.occurredOn,null);assert.equal(collection.requiresDateReview,true);assert.equal(collection.cashEntryId,null);assert.equal(await tableCount(store,'cash_entries'),1);assert.equal(await tableCount(store,'commission_entries'),0);
  await finish(store,await preview(store,await upload(store,f,[row])));assert.equal(await tableCount(store,'order_collections'),1);
}));
