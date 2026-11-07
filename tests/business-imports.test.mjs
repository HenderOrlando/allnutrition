import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { openStore } from '../lib/db/index.mjs';
import { businessOrderInput, createBusinessBasics, fixtureActor, requestId } from './business-fixtures.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { claimJob } from '../lib/business/job-leases.mjs';
import { createShipment, getShipment, recordShipmentEvent } from '../lib/business/shipments.mjs';
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

test('filas originales se localizan por hoja y fila exactas dentro de su importación',()=>fixture(async(store,f)=>{
  const names=[' Datos ','datos'];
  const config={formatVersion:2,sheets:names.map(sheetName=>configFor(fields,{sheetName}))};
  const workbook=prefix=>writeExcelSheets(names.map((name,index)=>({
    name,
    rows:[fields,fields.map(field=>basicRow({
      externalOrderId:`${prefix}-${index}`,externalShipmentId:`${prefix}-S-${index}`,
      tracking:`${prefix}-GUIA-${index}`,collectionExternalId:`${prefix}-C-${index}`,
      customerName:`${prefix} cliente ${index}`
    })[field]??'')]
  })));
  const batch=await preview(store,await upload(store,f,[],{bytes:workbook('PRIMERO'),config}));
  const second=await preview(store,await upload(store,f,[],{bytes:workbook('SEGUNDO'),config}));
  assert.notEqual(batch.id,second.id);
  assert.equal(batch.rows.total,2);
  const location={sheet:names[0],rowNumber:'2'};
  const located=await getImportBatch(store,batch.id,location);
  assert.equal(located.rows.total,1);
  const [row]=located.rows.records;
  assert.equal(row.sheet,names[0]);assert.equal(row.rowNumber,2);
  assert.equal(row.source[fields.indexOf('customerName')].value,'PRIMERO cliente 0');
  const matching=await getImportBatch(store,batch.id,{...location,state:row.state,q:'PRIMERO cliente 0'});
  assert.deepEqual(matching.rows.records,located.rows.records);
  const empty=async filters=>{
    const result=await getImportBatch(store,batch.id,filters);
    assert.equal(result.rows.total,0);assert.deepEqual(result.rows.records,[]);
  };
  await empty({...location,state:row.state==='applied'?'new':'applied'});
  await empty({...location,q:'SEGUNDO cliente 0'});
  await empty({...location,q:'PRIMERO cliente 1'});
  await empty({...location,rowNumber:3});
  await empty({...location,rowNumber:10001});
  await empty({...location,sheet:'Datos'});
  const otherSheet=await getImportBatch(store,batch.id,{sheet:names[1],rowNumber:2});
  assert.equal(otherSheet.rows.total,1);
  assert.equal(otherSheet.rows.records[0].source[fields.indexOf('customerName')].value,'PRIMERO cliente 1');
  for(const rowNumber of [null,''])assert.equal((await getImportBatch(store,batch.id,{rowNumber})).rows.total,2);
  await assert.rejects(()=>getImportBatch(store,batch.id,{rowNumber:2}),{status:400,message:'Elige una hoja para localizar la fila.'});
  for(const rowNumber of [0,10002])await assert.rejects(()=>getImportBatch(store,batch.id,{sheet:names[0],rowNumber}),{status:400});
}));

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
  assert.equal(done.config.sheets[0].reportAsOf,'2025-09-05');
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
  assert.equal(validateImportConfig({sheetName:'Datos',reportAsOf:'2025-09-05'}).sheets[0].reportAsOf,'2025-09-05');
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
  assert.equal(pending.preview.summary.valid,0);assert.ok(pending.preview.groups[0].errors.some(error=>error.code==='IMPORT_ORDER_INCOMPLETE'));await assert.rejects(()=>accept(store,pending),{status:409});assert.equal(await linkedOrder(store,f.source.id,'INCOMPLETE'),null);assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'shipments'),1);
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
  const inspection=batch.workbook.inspections.find(sheet=>sheet.sheetName==='Datos');assert.equal(inspection.headerRow,3);assert.deepEqual(inspection.rows.find(row=>row.rowNumber===3).cells.map(cell=>cell.value),fields);
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

test('hoja sin dimensiones con portada y encabezados repetidos permite inspección y revisión sin efectos financieros',()=>fixture(async(store,f)=>{
  const headers=['Guía','Estado','Estado','Transportadora'];
  const entries=unzipSync(writeExcelSheets([{name:'Datos',rows:[['Reporte sintético'],headers,...Array.from({length:30},(_,index)=>[`000${index}`,'Tránsito','Observación','Transportadora sintética'])]}]));
  entries['xl/worksheets/sheet1.xml']=strToU8(strFromU8(entries['xl/worksheets/sheet1.xml']).replace(/<dimension\b[^>]*\/>/g,''));
  const bytes=Buffer.from(zipSync(entries));
  const config=configFor([],{headerRow:2,purpose:'tracking',columns:headers.map((header,index)=>({index,header:header.toLowerCase(),destination:['tracking','rawStatus','','carrier'][index]}))});
  let batch=await upload(store,f,[],{bytes,config,resolutions:[]});
  assert.equal(batch.workbook.sheets[0].rowCount,32);assert.equal(batch.workbook.sheets[0].columnCount,4);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.error,null);assert.equal(batch.workbook.inspections.find(sheet=>sheet.sheetName==='Datos').headerRow,2);
  batch=await preview(store,batch);
  assert.equal(batch.preview.summary.valid,30);assert.equal(batch.rows.total,30);
  assert.ok(batch.preview.groups.every(group=>group.tasks.some(task=>task.type==='link_order')));
  assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,bytes);
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'cash_entries'),1);
}));

test('asignaciones que convergen en una columna fallan de forma durable y una corrección genera revisión fresca',()=>fixture(async(store,f)=>{
  const headers=['tracking','carrier'], rows=[{tracking:'000MAP',carrier:'Transportadora sintética'}], bytes=bytesFor(rows,headers), config=configFor(headers,{purpose:'tracking'});
  let batch=await preview(store,await upload(store,f,rows,{bytes,headers,config,resolutions:[]}));
  const oldHash=batch.preview.previewHash;
  const badConfig={...config,columns:[{index:0,header:'tracking',destination:'tracking'},{index:1,header:'tracking',destination:'externalShipmentId'}]};
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:badConfig},actor);
  batch=await preview(store,batch);
  assert.equal(batch.state,'review');assert.equal(batch.preview.summary.valid,0);
  const issue=batch.preview.groups.flatMap(group=>group.errors).find(error=>error.code==='IMPORT_COLUMN_COLLISION');
  assert.ok(issue);assert.equal(issue.category,'configuration');assert.equal(issue.sheet,'Datos');assert.equal(issue.rowNumber,1);assert.equal(issue.column,1);assert.equal(issue.field,'externalShipmentId');assert.ok(issue.action);
  assert.equal(batch.config.sheets[0].columns[1].destination,'externalShipmentId');
  assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,bytes);
  await assert.rejects(()=>commitImport(store,batch.id,{version:batch.version,previewHash:oldHash,requestId:requestId()},actor),{status:409});
  assert.equal((await processImportTurn(store,{batchId:batch.id})).processed,0);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config},actor);
  batch=await preview(store,batch);assert.equal(batch.error,null);assert.equal(batch.preview.summary.valid,1);
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'import_revisions'),0);
}));

async function withImportDatabaseFailure(store,method,error,run) {
  const original=store[method].bind(store);let injected=false;
  store[method]=fn=>original(tx=>{
    const get=tx.db.get.bind(tx.db);
    tx.db={...tx.db,get:async(sql,values)=>{
      if(!injected && sql.includes(tx.t('external_links'))){injected=true;throw error;}
      return get(sql,values);
    }};
    return fn(tx);
  });
  try {await run();assert.equal(injected,true);} finally {store[method]=original;}
}

test('excepción interna en preparación termina el trabajo, conserva datos y permite reintentar sin revisión falsa',()=>fixture(async(store,f)=>{
  let batch=await upload(store,f,[basicRow()]);
  const config=batch.config,original=(await downloadImportOriginal(store,batch.id)).bytes;
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  const failure=new TypeError('detalle interno que no se debe publicar');
  await withImportDatabaseFailure(store,'readSnapshot',failure,async()=>{
    await assert.rejects(()=>processImportTurn(store,{batchId:batch.id}),error=>error===failure);
  });
  batch=await getImportBatch(store,batch.id);
  assert.equal(batch.state,'review');assert.equal(batch.preview,null);assert.equal(batch.error.code,'IMPORT_INTERNAL');assert.equal(batch.error.category,'system');assert.ok(batch.error.action);
  assert.ok(!batch.error.message.includes('detalle interno'));assert.deepEqual(batch.config,config);assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,original);
  const job=await store.db.get(`SELECT state,error_code FROM ${store.t('job_runs')} WHERE key=?`,[`import:${batch.id}`]);
  assert.equal(job.state,'failed');assert.equal(job.error_code,'IMPORT_INTERNAL');
  assert.equal((await processImportTurn(store,{batchId:batch.id})).state,null);
  batch=await preview(store,batch);assert.equal(batch.error,null);assert.equal(batch.preview.summary.valid,1);
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('disponibilidad durante preparación reintenta el trabajo sin convertir el fallo en rechazo de filas',()=>fixture(async(store,f)=>{
  let batch=await upload(store,f,[basicRow()]);
  await requestImportPreview(store,batch.id,{version:batch.version,requestId:requestId()},actor);
  await withImportDatabaseFailure(store,'readSnapshot',Object.assign(new Error('servicio no disponible'),{status:503}),async()=>{
    const turn=await processImportTurn(store,{batchId:batch.id});assert.equal(turn.state,'queued');assert.equal(turn.hasMore,true);
  });
  batch=await getImportBatch(store,batch.id);assert.equal(batch.state,'previewing');assert.equal(batch.preview,null);assert.equal(batch.error,null);
  assert.equal((await store.db.get(`SELECT state,error_code FROM ${store.t('job_runs')} WHERE key=?`,[`import:${batch.id}`])).error_code,'IMPORT_UNAVAILABLE');
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.preview.summary.valid,1);assert.equal(batch.error,null);assert.equal(await tableCount(store,'orders'),0);
}));

test('disponibilidad real conserva revisión aceptada y grupos aplicados sin duplicarlos al reanudar',()=>fixture(async(store,f)=>{
  const rows=[1,2].map(n=>basicRow({externalOrderId:`DB-${n}`,externalShipmentId:`DB-S-${n}`,tracking:`000DB${n}`,collectionExternalId:`DB-C-${n}`}));
  let batch=await preview(store,await upload(store,f,rows));await accept(store,batch);
  await processImportTurn(store,{batchId:batch.id,maxGroups:1});batch=await getImportBatch(store,batch.id);
  const acceptedRevision=batch.acceptedRevision;assert.equal(await tableCount(store,'orders'),1);
  await withImportDatabaseFailure(store,'transaction',Object.assign(new Error('connection reset'),{code:'ECONNRESET'}),async()=>{
    assert.equal((await processImportTurn(store,{batchId:batch.id})).state,'queued');
  });
  batch=await getImportBatch(store,batch.id);assert.equal(batch.acceptedRevision,acceptedRevision);assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'import_revisions'),1);
  assert.equal((await processImportTurn(store,{batchId:batch.id})).state,'completed');
  assert.equal(await tableCount(store,'orders'),2);assert.equal(await tableCount(store,'order_collections'),2);assert.equal(await tableCount(store,'import_revisions'),1);
}));

test('errores de fecha e importe identifican celda y campo sin atribuir una causa no demostrada',()=>fixture(async(store,f)=>{
  const batch=await preview(store,await upload(store,f,[basicRow({placedOn:'31/12/2025',shippingOutCost:'no es importe'})]));
  assert.equal(batch.preview.summary.valid,0);
  for(const [code,field] of [['EXCEL_DATE','placedOn'],['EXCEL_MONEY','shippingOutCost']]){
    const error=batch.preview.groups[0].errors.find(error=>error.code===code);
    assert.equal(error.category,'system');assert.equal(error.sheet,'Datos');assert.equal(error.rowNumber,2);assert.equal(error.column,fields.indexOf(field)+1);assert.equal(error.field,field);assert.ok(error.action);
  }
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'expenses'),0);
}));

test('catálogo conserva el original y un encabezado inválido se corrige sin cargar otro archivo',()=>fixture(async(store,f)=>{
  const bytes=writeExcelSheets([{name:'Datos',rows:[[],['tracking','carrier'],['000RECOVER','Transportadora sintética']]}]);
  let batch=await createImportBatch(store,{sourceId:f.source.id,requestId:requestId()},actor);
  batch=await uploadImportFile(store,batch.id,{filename:'encabezados.xlsx',bytes,version:batch.version,requestId:requestId()},actor);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.state,'review');assert.equal(batch.preview,null);assert.equal(batch.error,null);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:configFor(['tracking','carrier'],{purpose:'tracking'})},actor);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  const issue=batch.workbook.errors.find(error=>error.code==='EXCEL_HEADER');assert.ok(issue);assert.equal(issue.sheet,'Datos');assert.equal(issue.rowNumber,1);
  assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,bytes);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:configFor(['tracking','carrier'],{headerRow:2,purpose:'tracking'})},actor);
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.error,null);assert.equal(batch.workbook.inspections.find(sheet=>sheet.sheetName==='Datos').headerRow,2);
  batch=await preview(store,batch);assert.equal(batch.preview.summary.valid,1);assert.equal(await tableCount(store,'shipments'),0);
}));

test('releer muestras pendientes conserva la configuración ya guardada tras una inspección fallida',()=>fixture(async(store,f)=>{
  const headers=['tracking','carrier'],config=configFor(headers,{headerRow:2,purpose:'tracking'});
  const bytes=writeExcelSheets([{name:'Datos',rows:[['Portada'],headers,['000PENDING','Transportadora sintética']]}]);
  let batch=await upload(store,f,[],{bytes,headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]});
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  // Persisted batches from a failed inspection can have newer config than their samples.
  const saved=await store.db.get(`SELECT data FROM ${store.t('import_batches')} WHERE id=?`,[batch.id]);
  await store.db.run(`UPDATE ${store.t('import_batches')} SET state='failed',data=? WHERE id=?`,[
    JSON.stringify({...JSON.parse(saved.data),config,error:{code:'EXCEL_HEADER',message:'Inspección pendiente',category:'configuration'}}),batch.id
  ]);
  batch=await getImportBatch(store,batch.id);
  assert.equal(batch.config.sheets[0].headerRow,2);assert.equal(batch.workbook.inspections.find(sheet=>sheet.sheetName==='Datos').headerRow,1);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:batch.config},actor);
  assert.equal(batch.state,'uploaded');
  await processImportTurn(store,{batchId:batch.id});batch=await getImportBatch(store,batch.id);
  assert.equal(batch.error,null);assert.equal(batch.workbook.inspections.find(sheet=>sheet.sheetName==='Datos').headerRow,2);
  batch=await preview(store,batch);
  assert.equal(batch.preview.summary.valid,1);assert.equal(batch.rows.total,1);
  assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,bytes);
  assert.equal(await tableCount(store,'shipments'),0);
}));

test('cambiar fila de encabezados invalida las filas almacenadas y relee todas las filas del original',()=>fixture(async(store,f)=>{
  const headers=['tracking','carrier'],config=configFor(headers,{headerRow:3,purpose:'tracking'});
  const bytes=writeExcelSheets([{name:'Datos',rows:[headers,['000EARLY','Transportadora sintética'],headers,['000LATE','Transportadora sintética']]}]);
  let batch=await upload(store,f,[],{bytes,headers,config,resolutions:[]});
  await processImportTurn(store,{batchId:batch.id});batch=await preview(store,await getImportBatch(store,batch.id));
  assert.equal(batch.rows.total,1);
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),config:{...config,headerRow:1}},actor);
  await processImportTurn(store,{batchId:batch.id});batch=await preview(store,await getImportBatch(store,batch.id));
  assert.equal(batch.rows.total,3);assert.ok(batch.rows.records.some(row=>row.rowNumber===2));assert.ok(batch.rows.records.some(row=>row.rowNumber===4));
  assert.equal(await tableCount(store,'shipments'),0);assert.deepEqual((await downloadImportOriginal(store,batch.id)).bytes,bytes);
}));

test('hoja sin filas de datos no genera una revisión vacía aceptable',()=>fixture(async(store,f)=>{
  const headers=['tracking','carrier'];
  const batch=await preview(store,await upload(store,f,[],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,0);assert.equal(batch.preview.groups.length,0);await assert.rejects(()=>accept(store,batch),error=>[400,409].includes(error.status));
  assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'import_revisions'),0);
}));

const importedShipment = async store => {
  const row=await store.db.get(`SELECT * FROM ${store.t('shipments')} ORDER BY id LIMIT 1`);
  return row ? {...row,...JSON.parse(row.data)} : null;
};
const importedValue = (shipment,key,sourceId) => shipment.importedFields.find(field=>field.key===key && field.sourceId===sourceId);
const informationHeaders=['externalShipmentId','carrier','tracking','rawShipmentStatus','shippingType','shipmentNotes'];
const informationRow=(extra={})=>({externalShipmentId:'INFO-S',carrier:'Transportadora sintética',tracking:'000INFO',rawShipmentStatus:'PAGADA',shippingType:'CONVENCIONAL',shipmentNotes:'Observación original',...extra});

test('dos Estado por posición conservan administración y seguimiento independientes sin cobrar',()=>fixture(async(store,f)=>{
  const headers=['Id','Guía','Estado','Transportadora','Estado'];
  const config=configFor([],{purpose:'tracking',headerRow:2,statusMap:{'Entrega Exitosa':'delivered'},columns:headers.map((header,index)=>({index,header:header.toLowerCase(),destination:['externalShipmentId','tracking','rawShipmentStatus','carrier','rawStatus'][index]}))});
  const bytes=writeExcelSheets([{name:'Datos',rows:[['Portada sintética'],headers,['TWO-STATES','000STATES','PAGADA','Transportadora sintética','Entrega Exitosa']]}]);
  const cashBefore=await tableCount(store,'cash_entries');
  let batch=await preview(store,await upload(store,f,[],{bytes,config,resolutions:[]}));
  assert.equal(batch.preview.summary.valid,1);
  const proposed=batch.preview.groups[0].units[0].shipments[0];
  assert.equal(proposed.importedFields.find(field=>field.key==='rawShipmentStatus').value,'PAGADA');
  assert.deepEqual(proposed.events.map(event=>[event.rawStatus,event.status]),[['Entrega Exitosa','delivered']]);
  batch=await finish(store,batch);assert.equal(batch.state,'completed');
  const shipment=await importedShipment(store), admin=importedValue(shipment,'rawShipmentStatus',f.source.id);
  assert.equal(shipment.status,'delivered');assert.equal(admin.value,'PAGADA');assert.equal(admin.columnIndex,2);assert.deepEqual(admin.rowNumbers,[3]);assert.equal(admin.batchId,batch.id);
  const events=await store.db.all(`SELECT * FROM ${store.t('shipment_events')}`);
  assert.equal(events.length,1);assert.equal(JSON.parse(events[0].data).rawStatus,'Entrega Exitosa');
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'cash_entries'),cashBefore);
  const updateHeaders=['externalShipmentId','rawShipmentStatus'];
  batch=await preview(store,await upload(store,f,[{externalShipmentId:'TWO-STATES',rawShipmentStatus:'FINALIZADA'}],{headers:updateHeaders,config:configFor(updateHeaders,{purpose:'tracking',reportAsOf:'2025-09-06'}),resolutions:[]}));
  assert.equal(batch.preview.summary.updated,1);
  batch=await finish(store,batch);assert.equal(batch.progress.updated,1);assert.equal(batch.rows.records[0].applied.state,'updated');
  assert.equal(importedValue(await importedShipment(store),'rawShipmentStatus',f.source.id).value,'FINALIZADA');
  assert.equal(await tableCount(store,'shipment_events'),1);assert.equal(await tableCount(store,'cash_entries'),cashBefore);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('estado administrativo conocido no reemplaza seguimiento desconocido ni genera evento por sí solo',()=>fixture(async(store,f)=>{
  const headers=[...informationHeaders,'rawStatus'];
  await finish(store,await preview(store,await upload(store,f,[informationRow({rawShipmentStatus:'ENTREGADA',rawStatus:'No catalogado'})],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]})));
  let shipment=await importedShipment(store);assert.equal(shipment.status,'unknown');assert.equal(importedValue(shipment,'rawShipmentStatus',f.source.id).value,'ENTREGADA');
  const event=await store.db.get(`SELECT * FROM ${store.t('shipment_events')}`);assert.equal(event.status,'unknown');assert.equal(JSON.parse(event.data).rawStatus,'No catalogado');
  await finish(store,await preview(store,await upload(store,f,[informationRow({externalShipmentId:'ADMIN-ONLY',tracking:'000ADMIN'})],{headers:informationHeaders,config:configFor(informationHeaders,{purpose:'tracking'}),resolutions:[]})));
  assert.equal(await tableCount(store,'shipments'),2);assert.equal(await tableCount(store,'shipment_events'),1);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('adicionales con encabezado repetido preservan texto y nombres seguros en perfil y reimportación',()=>fixture(async(store,f)=>{
  const headers=['Id','Guía','Transportadora',...Array(6).fill('Extra')], names=['status','__proto__','Decimal','Booleano','Código','HTML'];
  const columns=headers.map((header,index)=>index<3?{index,header:header.toLowerCase(),destination:['externalShipmentId','tracking','carrier'][index]}:{index,header:'extra',destination:'additionalField',fieldName:names[index-3]});
  const config=configFor([],{purpose:'tracking',columns}), values=['No es estado','Texto inocuo',12.5,true,'0000123','<b>Sin ejecutar</b>'];
  const bytes=writeExcelSheets([{name:'Datos',rows:[headers,['EXTRA-S','000EXTRA','Transportadora sintética',...values]]}]);
  const profile=await saveResource(store,'profiles',{requestId:requestId(),sourceId:f.source.id,name:'Adicionales posicionales',...config},actor);
  let batch=await preview(store,await upload(store,f,[],{bytes,config,profileId:profile.id,resolutions:[]}));
  assert.deepEqual(batch.config.sheets[0].columns.filter(column=>column.destination==='additionalField').map(column=>column.fieldName),names);
  await finish(store,batch);
  const original=(await importedShipment(store)).importedFields;
  for(const [index,name] of names.entries()){
    const field=original.find(field=>field.key===`additional:${name.toLocaleLowerCase('es')}`);
    assert.ok(field,name);assert.equal(typeof field.value,'string');assert.equal(field.columnIndex,index+3);assert.deepEqual(field.rowNumbers,[2]);
    if(typeof values[index]==='string')assert.equal(field.value,values[index]);
  }
  assert.equal(original.find(field=>field.key==='additional:booleano').value.toLowerCase(),'true');
  assert.equal(Number(original.find(field=>field.key==='additional:decimal').value.replace(',','.')),12.5);
  assert.equal((await importedShipment(store)).status,'unknown');assert.equal(await tableCount(store,'shipment_events'),0);assert.equal(await tableCount(store,'expenses'),0);
  batch=await preview(store,await upload(store,f,[],{bytes,config,profileId:profile.id,resolutions:[]}));
  assert.equal(batch.preview.summary.unchanged,1);await finish(store,batch);
  assert.deepEqual((await importedShipment(store)).importedFields,original);assert.equal(await tableCount(store,'shipments'),1);assert.equal(await tableCount(store,'orders'),0);
  const pending=await preview(store,await upload(store,f,[],{bytes,config,profileId:profile.id,resolutions:[]}));
  await saveResource(store,'profiles',{...profile,requestId:requestId(),columns:columns.map(column=>column.index===3?{...column,fieldName:'Otro estado'}:column)},actor,profile.id);
  await assert.rejects(()=>accept(store,pending),{status:409});
}));

test('metadatos repetidos contradictorios señalan ambas filas y no se pierden sin identidad de envío',()=>fixture(async(store,f)=>{
  for(const destination of ['shipmentNotes','additionalField']){
    const headers=['externalShipmentId','carrier','tracking','Dato'];
    const config=configFor([],{purpose:'tracking',columns:headers.map((header,index)=>({index,header:header.toLowerCase(),destination:index===3?destination:header,...(index===3&&destination==='additionalField'?{fieldName:'Observación'}:{})}))});
    const bytes=writeExcelSheets([{name:'Datos',rows:[headers,['REPEAT','Transportadora sintética','000REPEAT','Primero'],['REPEAT','Transportadora sintética','000REPEAT','Segundo']]}]);
    const batch=await preview(store,await upload(store,f,[],{bytes,config,resolutions:[]}));
    assert.equal(batch.preview.summary.valid,0);
    const issue=batch.preview.groups[0].errors.find(error=>error.code==='IMPORT_REPEATED_FIELD');assert.ok(issue);assert.deepEqual(issue.rowRefs,[{sheet:'Datos',rowNumber:2},{sheet:'Datos',rowNumber:3}]);
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  const headers=['externalOrderId','customerName','phone','city','placedOn','productExternalKey','quantity','unitPrice','shipmentNotes'];
  const batch=await preview(store,await upload(store,f,[basicRow({shipmentNotes:'No se debe descartar'})],{headers}));
  assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_SHIPMENT_IDENTITY'));
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'shipments'),0);
}));

test('autoridad informativa conserva procedencia, ignora cortes viejos y exige revisión para cortes iguales o ausentes',()=>fixture(async(store,f)=>{
  const run=async(value,cut)=>preview(store,await upload(store,f,[informationRow({shipmentNotes:value})],{headers:informationHeaders,config:configFor(informationHeaders,{purpose:'tracking',reportAsOf:cut}),resolutions:[]}));
  await finish(store,await run('Original','2025-09-05'));
  const first=importedValue(await importedShipment(store),'shipmentNotes',f.source.id);
  const bytes=writeExcelSheets([{name:'Datos',rows:[['Portada'],informationHeaders,informationHeaders.map(field=>informationRow({shipmentNotes:'Original'})[field])]}]);
  const same=await preview(store,await upload(store,f,[],{bytes,config:configFor(informationHeaders,{purpose:'tracking',headerRow:2}),resolutions:[]}));
  assert.equal(same.preview.summary.unchanged,1);await finish(store,same);
  assert.deepEqual(importedValue(await importedShipment(store),'shipmentNotes',f.source.id),first);
  const identical=await run('Original','2025-09-05');assert.equal(identical.preview.summary.unchanged,1);await finish(store,identical);
  assert.deepEqual(importedValue(await importedShipment(store),'shipmentNotes',f.source.id),first);
  let batch=await run('Posterior','2025-09-06');assert.equal(batch.preview.summary.updated,1);await finish(store,batch);
  const later=importedValue(await importedShipment(store),'shipmentNotes',f.source.id);assert.equal(later.value,'Posterior');assert.notEqual(later.batchId,first.batchId);
  batch=await run('Antiguo','2025-09-04');assert.equal(batch.preview.summary.valid,1);assert.ok(batch.preview.groups[0].warnings.length);await finish(store,batch);
  assert.deepEqual(importedValue(await importedShipment(store),'shipmentNotes',f.source.id),later);
  for(const cut of ['2025-09-06',null]){
    batch=await run('Revisado',cut);assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_METADATA_AUTHORITY'));
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  batch=await run('Revisado','2025-09-06');
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'review_authority',entityKey:batch.preview.groups[0].key,reason:'Corrección informativa confirmada contra el original'}]},actor);
  await finish(store,await preview(store,batch));assert.equal(importedValue(await importedShipment(store),'shipmentNotes',f.source.id).value,'Revisado');
  assert.equal(await tableCount(store,'shipment_events'),0);assert.equal(await tableCount(store,'orders'),0);
}));

const newOrderFields=['addressNotes','email','documentType','documentNumber','orderNotes','deliveryMethod'];
const newOrderValues={addressNotes:'Barrio sintético, portería',email:'persona@example.test',documentType:'CC',documentNumber:'000012345',orderNotes:'Nota comercial importada',deliveryMethod:'local'};
const orderInformationHeaders=['externalOrderId','externalShipmentId','carrier','tracking','customerName','phone','department','city','address','placedOn','productExternalKey','quantity','unitPrice',...newOrderFields];
test('campos comerciales nuevos crean pedido y requieren autorización motivada para editar uno existente',()=>fixture(async(store,f)=>{
  const row=basicRow({...newOrderValues,department:'Cundinamarca'});
  let batch=await preview(store,await upload(store,f,[row],{headers:orderInformationHeaders}));
  assert.equal(batch.preview.summary.valid,1);assert.equal(batch.preview.groups[0].units[0].values.email,newOrderValues.email);
  await finish(store,batch);let order=await linkedOrder(store,f.source.id);
  for(const [key,value] of Object.entries(newOrderValues))assert.equal(order[key==='orderNotes'?'notes':key],value);
  const changed={...newOrderValues,email:'actualizada@example.test',addressNotes:'Nueva referencia',orderNotes:'Nota autorizada',deliveryMethod:'pickup'};
  batch=await preview(store,await upload(store,f,[{...row,...changed}],{headers:orderInformationHeaders,config:configFor(orderInformationHeaders,{reportAsOf:'2025-09-06'})}));
  await assert.rejects(()=>accept(store,batch),{status:409});order=await linkedOrder(store,f.source.id);assert.equal(order.email,newOrderValues.email);assert.equal(order.notes,newOrderValues.orderNotes);assert.equal(order.deliveryMethod,'local');
  batch=await preview(store,await upload(store,f,[{...row,...changed}],{headers:orderInformationHeaders,config:configFor(orderInformationHeaders,{reportAsOf:'2025-09-07'})}));
  const resolution={action:'commercial_update',entityKey:batch.preview.groups[0].key,value:{email:changed.email,addressNotes:changed.addressNotes,notes:changed.orderNotes,deliveryMethod:changed.deliveryMethod}};
  await assert.rejects(()=>updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[resolution]},actor),{status:400});
  batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{...resolution,reason:'Destinatario confirmó los nuevos datos comerciales'}]},actor);
  await finish(store,await preview(store,batch));order=await linkedOrder(store,f.source.id);
  assert.equal(order.email,changed.email);assert.equal(order.addressNotes,changed.addressNotes);assert.equal(order.notes,changed.orderNotes);assert.equal(order.deliveryMethod,'pickup');assert.equal(await tableCount(store,'orders'),1);
}));

test('correo, documento incompleto y modalidad inválidos producen diagnósticos legibles sin crear pedido',()=>fixture(async(store,f)=>{
  for(const extra of [{email:'correo-inválido'},{documentType:'',documentNumber:'000012345'},{deliveryMethod:'PAGO CONTRAENTREGA'}]){
    const batch=await preview(store,await upload(store,f,[basicRow({...newOrderValues,...extra})],{headers:orderInformationHeaders}));
    assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>typeof error.message==='string'&&error.message.length>0));
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  assert.equal(await tableCount(store,'orders'),0);assert.equal(await tableCount(store,'shipments'),0);
}));

test('destinatario observado de guía huérfana persiste sin crear ni sobrescribir pedido al vincular',()=>fixture(async(store,f)=>{
  const headers=['externalShipmentId','carrier','tracking','customerName','phone','department','city','address','addressNotes','email','documentType','documentNumber'];
  const row=informationRow({...newOrderValues,customerName:'Destinatario observado',phone:'3007654321',department:'Antioquia',city:'Medellín',address:'Dirección observada'});
  await finish(store,await preview(store,await upload(store,f,[row],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]})));
  assert.equal(await tableCount(store,'orders'),0);
  let shipment=await importedShipment(store);const original=shipment.importedFields;
  for(const key of headers.slice(3))assert.equal(importedValue(shipment,key,f.source.id).value,row[key]);
  const order=await store.saveOrder(businessOrderInput(f.a,{year:2025}),actor);
  let batch=await preview(store,await upload(store,f,[row],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[{action:'link_order',internalId:order.id,reason:'Vínculo verificado de la guía huérfana'}]}));
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  shipment=await importedShipment(store);assert.equal(shipment.order_id,order.id);assert.deepEqual(shipment.importedFields,original);
  const after=await store.order(order.id);
  for(const key of ['customerName','phone','department','city','address','addressNotes','email','documentType','documentNumber'])assert.equal(after[key],order[key]);
  assert.equal(await tableCount(store,'orders'),1);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('información sin corte inicial, vacíos, cero y fuentes independientes mantienen autoridad separada',()=>fixture(async(store,f)=>{
  const headers=['externalShipmentId','carrier','tracking','shipmentNotes','insuredValue','expectedCollection'];
  const row={externalShipmentId:'OBS-S',carrier:'Transportadora sintética',tracking:'000OBS',shipmentNotes:'Primer valor sin corte',insuredValue:'0',expectedCollection:'55.000'};
  const config=configFor(headers,{purpose:'tracking',reportAsOf:null});
  let batch=await preview(store,await upload(store,f,[row],{headers,config,resolutions:[]}));assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  const first=await importedShipment(store);
  assert.equal(importedValue(first,'shipmentNotes',f.source.id).sourceAsOf,null);
  assert.equal(importedValue(first,'insuredValue',f.source.id).value,0);
  assert.equal(importedValue(first,'expectedCollection',f.source.id).value,5500000);
  batch=await preview(store,await upload(store,f,[{...row,shipmentNotes:'',insuredValue:'',expectedCollection:''}],{headers,config,resolutions:[]}));
  assert.equal(batch.preview.summary.unchanged,1);await finish(store,batch);assert.deepEqual((await importedShipment(store)).importedFields,first.importedFields);
  batch=await preview(store,await upload(store,f,[{...row,shipmentNotes:'Otro sin corte'}],{headers,config,resolutions:[]}));
  assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_METADATA_AUTHORITY'));
  const other=await saveResource(store,'sources',{requestId:requestId(),platformId:f.platform.id,name:'Fuente informativa independiente'},actor);
  batch=await preview(store,await upload(store,f,[{...row,externalShipmentId:'OTHER-OBS',shipmentNotes:'Valor de otra fuente'}],{headers,config,sourceId:other.id,resolutions:[{action:'link_shipment',externalKey:'OTHER-OBS',internalId:first.id,reason:'Ambas fuentes describen la misma guía'}]}));
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  const after=await importedShipment(store);
  assert.equal(importedValue(after,'shipmentNotes',f.source.id).value,'Primer valor sin corte');
  assert.equal(importedValue(after,'shipmentNotes',other.id).value,'Valor de otra fuente');
  assert.equal(await tableCount(store,'shipments'),1);assert.equal(await tableCount(store,'shipment_events'),0);assert.equal(await tableCount(store,'expenses'),0);assert.equal(await tableCount(store,'order_collections'),0);
}));

test('texto informativo incompatible señala fila y columna, conserva original y no permite mutaciones',()=>fixture(async(store,f)=>{
  const headers=['externalShipmentId','shipmentNotes'], original='x'.repeat(4001);
  const batch=await preview(store,await upload(store,f,[{externalShipmentId:'TEXT-LIMIT',shipmentNotes:original}],{headers,config:configFor(headers,{purpose:'tracking'}),resolutions:[]}));
  assert.equal(batch.preview.summary.valid,0);
  const error=batch.rows.records[0].errors.find(error=>error.code==='EXCEL_TEXT_LIMIT');
  assert.equal(error.category,'configuration');assert.equal(error.rowNumber,2);assert.equal(error.column,2);assert.equal(error.field,'shipmentNotes');
  assert.equal(batch.rows.records[0].source[1].value,original);
  await assert.rejects(()=>accept(store,batch),{status:409});
  assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'orders'),0);
  assert.equal(await tableCount(store,'shipment_events'),0);assert.equal(await tableCount(store,'expenses'),0);
}));

const insuranceHeaders=['externalShipmentId','carrier','tracking','rawStatus','eventAt','shippingOutCost','shippingOutCostDate','insuranceCost','insuranceCostDate'];
const insuranceUpdateHeaders=['externalShipmentId','carrier','tracking','insuranceCost','insuranceCostDate'];
const insuranceRow=(extra={})=>({externalShipmentId:'INSURANCE-EDGE',carrier:'Transportadora sintética',tracking:'000INSURANCE',rawStatus:'Recogido',eventAt:'2025-09-02',shippingOutCost:'0',shippingOutCostDate:'2025-09-02',insuranceCost:null,insuranceCostDate:null,...extra});
const insuranceQuery={period:'month',anchorDate:'2025-09-01',asOf:'2025-10-01T05:00:00.000Z'};
const insuranceExpenses=store=>store.db.all(`SELECT * FROM ${store.t('expenses')} WHERE category=? ORDER BY id`,['shipping_insurance']);
const insuranceShipment=async store=>getShipment(store,(await store.db.get(`SELECT id FROM ${store.t('shipments')} WHERE external_id=?`,['INSURANCE-EDGE'])).id);
const insurancePreview=(store,f,row,{headers=insuranceHeaders,cut='2025-09-05',...extra}={})=>upload(store,f,[row],{headers,config:configFor(headers,{purpose:'tracking',reportAsOf:cut}),resolutions:[],...extra}).then(batch=>preview(store,batch));

test('importar seguro distingue columna ausente, celda vacía, cero y fecha de cargo pendiente',()=>fixture(async(store,f)=>{
  const absentHeaders=insuranceHeaders.filter(field=>!field.startsWith('insurance'));
  await finish(store,await insurancePreview(store,f,insuranceRow(),{headers:absentHeaders}));
  let shipment=await insuranceShipment(store);
  assert.equal(Object.hasOwn(shipment.costStatuses,'shipping_insurance'),false);
  assert.equal(Object.hasOwn(shipment.costObservations,'shipping_insurance'),false);
  assert.equal(shipment.costStatus,'known');
  const before=await buildBusinessReport(store,insuranceQuery);assert.equal(before.metrics.shippingCosts.complete,true);
  const cashBefore=await tableCount(store,'cash_entries'),paymentsBefore=await tableCount(store,'expense_payments');
  let batch=await insurancePreview(store,f,insuranceRow(),{headers:insuranceUpdateHeaders,cut:'2025-09-06'});
  assert.equal(batch.preview.summary.updated,1);await finish(store,batch);
  shipment=await insuranceShipment(store);
  assert.equal(shipment.costStatuses.shipping_insurance,'unknown');assert.equal(shipment.costStatus,'unknown');
  assert.equal(shipment.costObservations.shipping_insurance.amountMinor,null);assert.equal(shipment.costObservations.shipping_insurance.chargeOn,null);
  assert.equal(shipment.costObservations.shipping_insurance.sourceId,f.source.id);
  assert.equal((await insuranceExpenses(store)).length,0);
  assert.equal((await buildBusinessReport(store,insuranceQuery)).metrics.shippingCosts.complete,false);
  await finish(store,await insurancePreview(store,f,insuranceRow({insuranceCost:'0',insuranceCostDate:'2025-09-02'}),{cut:'2025-09-07'}));
  shipment=await insuranceShipment(store);
  assert.equal(shipment.costStatuses.shipping_insurance,'known');assert.equal(shipment.costStatus,'known');
  assert.equal(shipment.costObservations.shipping_insurance.amountMinor,0);
  let expenses=await insuranceExpenses(store);assert.equal(expenses.length,1);assert.equal(expenses[0].amount_minor,0);
  const zeroId=expenses[0].id;
  assert.equal((await buildBusinessReport(store,insuranceQuery)).metrics.shippingCosts.complete,true);
  await finish(store,await insurancePreview(store,f,insuranceRow({insuranceCost:'1.000'}),{cut:'2025-09-08'}));
  expenses=await insuranceExpenses(store);assert.equal(expenses.length,1);assert.equal(expenses[0].id,zeroId);
  assert.equal(expenses[0].amount_minor,100000);assert.equal(expenses[0].incurred_on,null);
  assert.equal(JSON.parse(expenses[0].data).chargeOn,null);assert.equal(JSON.parse(expenses[0].data).dateSource,'charge_date');
  const pending=await buildBusinessReport(store,insuranceQuery);
  assert.equal(pending.metrics.shippingCosts.complete,false);assert.equal(pending.metrics.shippingCosts.knownValue,before.metrics.shippingCosts.value);
  assert.ok(pending.facts.shippingCosts.some(fact=>fact.expenseId===zeroId&&fact.reason==='expense_date_unknown'&&fact.occurredOn===null));
  assert.equal(await tableCount(store,'cash_entries'),cashBefore);assert.equal(await tableCount(store,'expense_payments'),paymentsBefore);
  assert.equal(await tableCount(store,'order_collections'),0);
}));

test('seguro inválido localiza importe y fecha sin crear envío, gasto ni movimiento financiero',()=>fixture(async(store,f)=>{
  const cashBefore=await tableCount(store,'cash_entries');
  for(const [field,value,code] of [['insuranceCost','prima desconocida','EXCEL_MONEY'],['insuranceCostDate','fecha desconocida','EXCEL_DATE']]){
    const batch=await insurancePreview(store,f,insuranceRow({insuranceCost:'1.000',insuranceCostDate:'2025-09-02',[field]:value}));
    assert.equal(batch.preview.summary.valid,0);
    const issue=batch.preview.groups[0].errors.find(error=>error.code===code&&error.field===field);
    assert.ok(issue);assert.equal(issue.sheet,'Datos');assert.equal(issue.rowNumber,2);assert.equal(issue.column,insuranceHeaders.indexOf(field)+1);
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  assert.equal(await tableCount(store,'shipments'),0);assert.equal(await tableCount(store,'expenses'),0);
  assert.equal(await tableCount(store,'expense_payments'),0);assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'cash_entries'),cashBefore);
}));

test('seguro conocido ignora vacío posterior y corte antiguo; discrepancias de importe o fecha exigen confirmación motivada',()=>fixture(async(store,f)=>{
  await finish(store,await insurancePreview(store,f,insuranceRow({insuranceCost:'1.000',insuranceCostDate:'2025-09-02'})));
  const originalExpense=(await insuranceExpenses(store))[0],originalObservation=(await insuranceShipment(store)).costObservations.shipping_insurance;
  let batch=await insurancePreview(store,f,insuranceRow(),{headers:insuranceUpdateHeaders,cut:'2025-09-06'});
  assert.equal(batch.preview.summary.unchanged,1);await finish(store,batch);
  assert.deepEqual((await insuranceExpenses(store))[0],originalExpense);
  assert.deepEqual((await insuranceShipment(store)).costObservations.shipping_insurance,originalObservation);
  batch=await insurancePreview(store,f,insuranceRow({insuranceCost:'900',insuranceCostDate:'2025-09-01'}),{headers:insuranceUpdateHeaders,cut:'2025-09-04'});
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  assert.deepEqual((await insuranceExpenses(store))[0],originalExpense);
  assert.deepEqual((await insuranceShipment(store)).costObservations.shipping_insurance,originalObservation);
  for(const changed of [{insuranceCost:'1.500',insuranceCostDate:'2025-09-02'},{insuranceCost:'1.500',insuranceCostDate:'2025-09-03'}]){
    batch=await insurancePreview(store,f,insuranceRow(changed),{headers:insuranceUpdateHeaders});
    assert.equal(batch.preview.summary.valid,0);
    assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_COST_AUTHORITY'&&error.field==='insuranceCost'));
    await assert.rejects(()=>accept(store,batch),{status:409});
    const entityKey=batch.preview.groups[0].key;
    await assert.rejects(()=>updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'review_authority',entityKey}]},actor),{status:400});
    batch=await updateImportBatch(store,batch.id,{version:batch.version,requestId:requestId(),resolutions:[{action:'review_authority',entityKey,reason:'Prima y fecha verificadas con el documento original'}]},actor);
    batch=await preview(store,batch);assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
    const expense=(await insuranceExpenses(store))[0];
    assert.equal(expense.id,originalExpense.id);assert.equal(expense.amount_minor,150000);assert.equal(expense.incurred_on,changed.insuranceCostDate);
    assert.equal(JSON.parse(expense.data).chargeOn,changed.insuranceCostDate);
  }
  assert.equal((await insuranceExpenses(store)).length,1);assert.equal(await tableCount(store,'expense_payments'),0);
}));

test('incluso seguro vacío requiere corte y fuente titular antes de registrar observación',()=>fixture(async(store,f)=>{
  const bareHeaders=['externalShipmentId','carrier','tracking'];
  await finish(store,await insurancePreview(store,f,insuranceRow(),{headers:bareHeaders,cut:null}));
  const shipment=await insuranceShipment(store),cashBefore=await tableCount(store,'cash_entries');
  const headers=[...bareHeaders,'insuranceCost','insuranceCostDate'];
  for(const insuranceCost of [null,'0','1.000']){
    let batch=await insurancePreview(store,f,insuranceRow({insuranceCost,insuranceCostDate:'2025-09-02'}),{headers,cut:null});
    assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_CUTOFF_REQUIRED'));
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  const other=await saveResource(store,'sources',{requestId:requestId(),platformId:f.platform.id,name:'Fuente no titular del seguro'},actor);
  for(const insuranceCost of [null,'0','1.000']){
    const batch=await insurancePreview(store,f,insuranceRow({externalShipmentId:'OTHER-INSURANCE',insuranceCost}),{headers,sourceId:other.id,resolutions:[{action:'link_shipment',externalKey:'OTHER-INSURANCE',internalId:shipment.id,reason:'Vínculo de seguimiento sin transferir autoridad financiera'}]});
    assert.equal(batch.preview.summary.valid,0);assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_SOURCE_AUTHORITY'));
    await assert.rejects(()=>accept(store,batch),{status:409});
  }
  assert.deepEqual((await getShipment(store,shipment.id)).costObservations,shipment.costObservations);
  assert.equal((await insuranceExpenses(store)).length,0);assert.equal(await tableCount(store,'shipments'),1);
  assert.equal(await tableCount(store,'cash_entries'),cashBefore);
}));

test('primas repetidas por producto se registran una vez y valores contradictorios bloquean el grupo completo',()=>fixture(async(store,f)=>{
  const headers=[...fields,'insuranceCost','insuranceCostDate'];
  const rows=[basicRow({insuranceCost:'1.000',insuranceCostDate:'2025-09-02'}),basicRow({productExternalKey:'GIFT',unitPrice:'0',insuranceCost:'1.000',insuranceCostDate:'2025-09-02'})];
  const resolutions=[{action:'link_product',externalKey:'SKU-A',internalId:f.a.id},{action:'link_product',externalKey:'GIFT',internalId:f.gift.id}];
  let batch=await preview(store,await upload(store,f,rows,{headers,resolutions}));
  assert.equal(batch.preview.summary.valid,1);await finish(store,batch);
  const original=(await insuranceExpenses(store))[0];assert.ok(original);assert.equal(original.amount_minor,100000);
  for(const repeated of [rows,[...rows].reverse()]){
    batch=await preview(store,await upload(store,f,repeated,{headers,resolutions}));assert.equal(batch.preview.summary.unchanged,1);await finish(store,batch);
    assert.deepEqual(await insuranceExpenses(store),[original]);
  }
  batch=await preview(store,await upload(store,f,[rows[0],{...rows[1],insuranceCost:'2.000'}],{headers,resolutions}));
  assert.equal(batch.preview.summary.valid,0);
  const issue=batch.preview.groups[0].errors.find(error=>error.code==='IMPORT_REPEATED_FIELD'&&error.field==='insuranceCost');
  assert.ok(issue);assert.deepEqual(issue.rowRefs,[{sheet:'Datos',rowNumber:2},{sheet:'Datos',rowNumber:3}]);
  await assert.rejects(()=>accept(store,batch),{status:409});
  assert.deepEqual(await insuranceExpenses(store),[original]);assert.equal(await tableCount(store,'orders'),1);
}));

test('reanudación usa la señal de seguro congelada por envío y revisiones antiguas sin señal no crean observaciones',()=>fixture(async(store,f)=>{
  const rows=[insuranceRow(),insuranceRow({externalShipmentId:'INSURANCE-RESUME',tracking:'000INSURANCE2',insuranceCost:'0',insuranceCostDate:'2025-09-02'})];
  let batch=await preview(store,await upload(store,f,rows,{headers:insuranceHeaders,config:configFor(insuranceHeaders,{purpose:'tracking'}),resolutions:[]}));
  await accept(store,batch);
  let frozenRow=await store.db.get(`SELECT revision,data FROM ${store.t('import_revisions')} WHERE batch_id=?`,[batch.id]);
  const frozen=JSON.parse(frozenRow.data);
  assert.equal(frozen.groups.length,2);
  for(const group of frozen.groups)assert.equal(group.units[0].shipments[0].insuranceCostMapped,true);
  const first=await processImportTurn(store,{batchId:batch.id,maxGroups:1});assert.equal(first.state,'queued');assert.equal(first.processed,1);
  assert.equal((await processImportTurn(store,{batchId:batch.id})).state,'completed');
  assert.equal((await insuranceShipment(store)).costStatuses.shipping_insurance,'unknown');
  const zero=await store.db.get(`SELECT id FROM ${store.t('shipments')} WHERE external_id=?`,['INSURANCE-RESUME']);
  assert.equal((await getShipment(store,zero.id)).costObservations.shipping_insurance.amountMinor,0);
  assert.equal((await insuranceExpenses(store)).length,1);
  const headers=insuranceHeaders.filter(field=>!field.startsWith('insurance'));
  batch=await insurancePreview(store,f,insuranceRow({externalShipmentId:'LEGACY-NO-INSURANCE',tracking:'000LEGACY'}),{headers});
  await accept(store,batch);
  frozenRow=await store.db.get(`SELECT revision,data FROM ${store.t('import_revisions')} WHERE batch_id=?`,[batch.id]);
  const legacy=JSON.parse(frozenRow.data);
  const observed=legacy.groups[0].units[0].shipments[0];assert.equal(observed.insuranceCostMapped,false);
  // Model an already-accepted pre-insurance revision; its absent signal must not
  // acquire a new unknown-cost requirement when a newer worker resumes it.
  delete observed.insuranceCostMapped;
  await store.db.run(`UPDATE ${store.t('import_revisions')} SET data=? WHERE batch_id=? AND revision=?`,[JSON.stringify(legacy),batch.id,frozenRow.revision]);
  assert.equal((await processImportTurn(store,{batchId:batch.id})).state,'completed');
  const legacyShipment=await store.db.get(`SELECT id FROM ${store.t('shipments')} WHERE external_id=?`,['LEGACY-NO-INSURANCE']);
  const after=await getShipment(store,legacyShipment.id);
  assert.equal(Object.hasOwn(after.costStatuses,'shipping_insurance'),false);
  assert.equal(Object.hasOwn(after.costObservations,'shipping_insurance'),false);assert.equal(after.costStatus,'known');
  assert.equal((await insuranceExpenses(store)).length,1);
}));

test('importación permite conteos ausentes y descuenta solo saldos conocidos sin duplicar al reimportar',()=>fixture(async(store,f)=>{
  const template=await store.get('products',f.a.id),b=await store.get('products',f.b.id);
  const a=await store.save('products',{...template,slug:'uncounted-import-a',stockQuantity:null},null,null,actor);
  await store.save('products',{...b,stockQuantity:5},b.id,b.version,actor);
  const rows=[
    basicRow({collectedAmount:'',collectionDate:'',collectionExternalId:''}),
    basicRow({externalOrderId:'COUNTED-2',externalShipmentId:'COUNTED-S2',tracking:'000COUNTED2',productExternalKey:'SKU-B',quantity:2,unitPrice:'10.000',collectedAmount:'',collectionDate:'',collectionExternalId:''})
  ];
  const resolutions=[{action:'link_product',externalKey:'SKU-A',internalId:a.id},{action:'link_product',externalKey:'SKU-B',internalId:b.id}];
  let batch=await preview(store,await upload(store,f,rows,{resolutions}));
  assert.equal(batch.preview.summary.valid,2);assert.equal(batch.preview.summary.rejected,0);
  const cashBefore=await tableCount(store,'cash_entries');
  batch=await finish(store,batch);assert.equal(batch.state,'completed');
  const assertBalances=async()=>{
    const unknown=await store.get('products',a.id),known=await store.get('products',b.id);
    assert.equal(unknown.stockQuantity,null);assert.equal(unknown.stockReserved,0);
    assert.equal(known.stockQuantity,3);assert.equal(known.stockReserved,0);
    assert.equal(await tableCount(store,'order_collections'),0);assert.equal(await tableCount(store,'cash_entries'),cashBefore);
  };
  await assertBalances();
  assert.equal((await linkedOrder(store,f.source.id)).inventory.products[0].consumed,1);
  const repeated=await preview(store,await upload(store,f,rows,{resolutions}));
  assert.equal(repeated.preview.summary.valid,2);await finish(store,repeated);
  assert.equal(await tableCount(store,'orders'),2);assert.equal(await tableCount(store,'shipments'),2);
  await assertBalances();
}));

test('importación con conteo cero se bloquea hasta guardar existencias reales y revisar de nuevo',()=>fixture(async(store,f)=>{
  const a=await store.get('products',f.a.id);
  await store.save('products',{...a,stockQuantity:0},a.id,a.version,actor);
  let batch=await preview(store,await upload(store,f,[basicRow({collectedAmount:'',collectionDate:'',collectionExternalId:''})]));
  assert.equal(batch.preview.summary.valid,0);
  assert.ok(batch.preview.groups[0].errors.some(error=>error.code==='IMPORT_INVENTORY'));
  await assert.rejects(()=>accept(store,batch),{status:409});assert.equal(await tableCount(store,'orders'),0);
  const counted=await store.get('products',a.id);
  await store.save('products',{...counted,stockQuantity:3},counted.id,counted.version,actor);
  batch=await preview(store,batch);assert.equal(batch.preview.summary.valid,1);
  batch=await finish(store,batch);assert.equal(batch.state,'completed');
  assert.equal((await store.get('products',a.id)).stockQuantity,2);
  assert.equal(await tableCount(store,'orders'),1);
}));
