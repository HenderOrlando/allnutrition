'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { shipmentStates } from '@/lib/schema.mjs';
import useDialog from './useDialog';
import Icon from './Icons';
import { Field } from './Fields';
import styles from './OrderExperience.module.css';

const MAX_BYTES=10*1024*1024;
const ACTIVE_STATES=new Set(['uploaded','previewing','queued','applying']);
const LOCKED_STATES=new Set(['queued','applying']);
const FINAL_STATES=new Set(['completed','completed_with_errors','expired','cancelled']);
const LINE_FIELDS=new Set(['externalLineId','productExternalKey','quantity','unitPrice','lineDiscount']);
const DESTINATIONS=[
 ['Identidad',[['externalOrderId','ID externo del pedido'],['internalOrderNumber','Número AN del pedido'],['externalShipmentId','ID externo del envío'],['externalEventId','ID externo del evento']]],
 ['Envío',[['carrier','Transportadora'],['tracking','Guía'],['rawStatus','Estado externo'],['eventAt','Fecha del evento'],['reportAsOf','Fecha de corte del reporte'],['placedOn','Fecha del pedido'],['labelCreatedAt','Fecha de creación de guía'],['collectedAt','Fecha de recogida'],['estimatedDeliveryOn','Entrega estimada'],['deliveredAt','Fecha de entrega'],['returnAt','Fecha de retorno'],['eventDetail','Detalle del evento']]],
 ['Destinatario',[['customerName','Nombre del destinatario'],['phone','Teléfono'],['department','Departamento'],['city','Ciudad'],['address','Dirección'],['sellerExternalKey','ID externo del vendedor']]],
 ['Productos',[['externalLineId','ID externo de línea'],['productExternalKey','ID o referencia del producto'],['quantity','Cantidad'],['unitPrice','Precio unitario'],['lineDiscount','Descuento total de línea']]],
 ['Importes y cargos',[['shippingCharge','Flete cobrado al cliente'],['shippingOutCost','Costo de flete de ida'],['shippingOutCostDate','Fecha del costo de ida'],['shippingReturnCost','Costo de retorno'],['shippingReturnCostDate','Fecha del costo de retorno'],['platformFee','Cargo de plataforma'],['platformFeeDate','Fecha del cargo']]],
 ['Recaudos y liquidaciones',[['collectedAmount','Recaudo acumulado o importe de transacción'],['collectionDate','Fecha del recaudo'],['collectionExternalId','ID externo del recaudo'],['collectionReference','Referencia del recaudo'],['settlementExternalId','ID externo de liquidación'],['settlementDate','Fecha de liquidación'],['settlementGross','Bruto de liquidación'],['settlementNet','Neto de liquidación'],['settlementReference','Referencia de liquidación']]]
];
const STATE_LABELS={uploaded:'Archivo recibido',previewing:'Preparando revisión',review:'Por revisar',queued:'Importación en cola',applying:'Importando',completed:'Importación completada',completed_with_errors:'Completada con excepciones',failed:'Requiere corrección',expired:'Archivo vencido',cancelled:'Importación cancelada'};
const RESULT_LABELS={created:'Operaciones nuevas',updated:'Operaciones actualizadas',unchanged:'Sin cambios',conflict:'Conflictos',rejected:'Rechazados',applied:'Aplicados',new:'Nuevos',valid:'Válidos',invalid:'Con errores',omitted:'Omitidos',errors:'Con excepciones',groupsProcessed:'Grupos procesados',settlementsProcessed:'Liquidaciones procesadas',settlementsPending:'Liquidaciones pendientes de aplicación'};
const RESOLUTION_LABELS={link_product:'Vincular producto',link_person:'Vincular vendedor',link_order:'Vincular pedido',link_shipment:'Vincular envío',duplicate:'Marcar fila duplicada',additional_quantity:'Contar como cantidad adicional',status:'Asignar estado externo',review_policy:'Aprobar política histórica',review_authority:'Revisar autoridad o rectificación',accept_formulas:'Aceptar valores guardados de fórmulas',omit_group:'Omitir grupo completo',commercial_update:'Autorizar actualización comercial'};
const RESOLUTION_GROUPS=[
 {label:'Vincular registros',actions:['link_product','link_person','link_order','link_shipment']},
 {label:'Interpretar el archivo',actions:['status','duplicate','additional_quantity','accept_formulas']},
 {label:'Correcciones con motivo',actions:['review_policy','review_authority','commercial_update','omit_group']}
];
const GROUP_RESOLUTIONS=RESOLUTION_GROUPS.flatMap(group=>group.actions).filter(action=>action!=='accept_formulas');
const ROW_RESOLUTIONS=['link_product','link_person','link_order','duplicate','additional_quantity'];
const FILE_RESOLUTIONS=['accept_formulas'];
const STEP_GUIDANCE=[
 ['Elige el origen y el archivo','Selecciona la plataforma y la cuenta que exportó el Excel. Guardar el archivo todavía no importa pedidos ni movimientos.'],
 ['Prepara las columnas','Confirma hoja, fechas e importes; después asigna cada columna y los estados externos. La revisión mostrará qué puede aplicarse.'],
 ['Resuelve y vuelve a revisar','Revisa los grupos, conserva las filas fuente y prepara las resoluciones necesarias. Cada cambio exige una revisión nueva.'],
 ['Confirma y sigue el resultado','Antes de aplicar puedes volver a revisar. Una vez aceptado, el trabajo continúa en el servidor y puedes retomar este lote.']
];
const blankConfig=()=>({sheetName:'',headerRow:1,dateFormat:'DMY',decimalSeparator:',',groupSeparator:'.',layout:'item_rows',purpose:'orders',columns:[],statusMap:{},oneOrderPerGuide:false,reportAsOf:''});
const records=data=>Array.isArray(data)?data:data?.records||[];
const normalizedHeader=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase('es').replace(/\s+/g,' ');
const cellText=cell=>cell==null?'':typeof cell==='object'?String(cell.text??cell.value??''):String(cell);
const json=value=>JSON.stringify(value);
const requestId=()=>crypto.randomUUID();
const groupKey=group=>String(group.entityKey??group.key??group.groupKey??'');
function groupCaption(group){
 const orders=[...new Set((group.units||[]).map(unit=>unit.values?.internalOrderNumber?`AN-${unit.values.internalOrderNumber}`:unit.values?.externalOrderId).filter(Boolean))];
 if(orders.length)return `${orders.length===1?'Pedido':'Pedidos'} ${orders.join(', ')}`;
 const guides=[...new Set((group.units||[]).flatMap(unit=>unit.shipments||[]).map(shipment=>shipment.values?.tracking||shipment.values?.externalShipmentId).filter(Boolean))];
 return guides.length?`${guides.length===1?'Guía':'Guías'} ${guides.join(', ')}`:`Filas ${(group.rowNumbers||[]).join(', ')||'por revisar'}`;
}
const diagnosticValue=value=>typeof value==='string'||typeof value==='number'?String(value):'';
function diagnosticText(error){
 if(error==null)return '';
 return diagnosticValue(error)||diagnosticValue(error.message)||diagnosticValue(error.reason)||diagnosticValue(error.code)||'No se recibió un detalle legible del error.';
}
function diagnosticLocation(error){
 if(!error||typeof error!=='object')return '';
 return [['Hoja',error.sheet],['Fila',error.rowNumber],['Columna',error.column],['Campo',error.field]].map(([label,value])=>diagnosticValue(value)?`${label}: ${diagnosticValue(value)}`:'').filter(Boolean).join(' · ');
}
const messages=errors=>(Array.isArray(errors)?errors:errors?[errors]:[]).map(error=>[diagnosticText(error),diagnosticLocation(error),diagnosticValue(error?.action)].filter(Boolean).join(' · '));
function ImportDiagnostic({diagnostic,alertRef}){
 const category=diagnostic?.category,title=category==='file'?'Problema comprobado del archivo':category==='configuration'?'Revisa la configuración de extracción':'Problema del sistema o causa no determinada',location=diagnosticLocation(diagnostic),actions=Array.isArray(diagnostic?.actions)?diagnostic.actions.map(diagnosticValue).filter(Boolean):[diagnosticValue(diagnostic?.action)].filter(Boolean);
 return <section className="error" role="alert" tabIndex={-1} ref={alertRef} aria-label="Diagnóstico de importación"><h3>{title}</h3><p>{diagnosticText(diagnostic)}</p>{location&&<p>{location}</p>}{actions.map((action,index)=><p key={index}><strong>Qué hacer:</strong> {action}</p>)}{!actions.length&&<p>Conserva este lote y su original. Puedes salir del importador y retomarlo; comunica el código y el lote si necesitas soporte.{category!=='file'&&category!=='configuration'?' No se ha determinado que el archivo sea la causa.':''}</p>}{diagnostic?.code&&<p className="small">Código: {diagnosticValue(diagnostic.code)}{diagnosticValue(diagnostic.phase)?` · Fase: ${diagnosticValue(diagnostic.phase)}`:''}</p>}</section>;
}
const safeName=value=>String(value||'archivo.xlsx').replace(/[\\/\u0000-\u001f]/g,'_');
function profileConfig(profile){const {id,name,sourceId,version,createdAt,updatedAt,...data}=profile||{};return {...blankConfig(),...(profile?.profile||profile?.data||data)};}
function summaryItems(summary){return Object.entries(summary||{}).filter(([key,value])=>RESULT_LABELS[key]&&typeof value==='number');}
function serverGroups(batch){return batch?.preview?.groups||[];}
function cutoffDate(value){if(!value)return '';if(!value.includes('T'))return value;const instant=new Date(value);return Number.isNaN(instant.getTime())?'':new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant);}
function rowExternalKey(action,row){const values=row.normalized?.values||{};if(action==='link_product')return row.normalized?.lines?.[0]?.productExternalKey||'';if(action==='link_person')return values.sellerExternalKey||'';if(action==='link_order')return values.externalOrderId||'';if(action==='link_shipment')return values.externalShipmentId||values.tracking||'';return '';}

export default function ImportWizard({api,view,onViewChange,onInteractionStateChange,onCreateProduct,onMutation}){
 const errorRef=useRef(null),headingRef=useRef(null),currentBatch=useRef(null),loadSequence=useRef(0),sourceSequence=useRef(0),profileSequence=useRef(0),lookupSequence=useRef(0),mounted=useRef(true),baseline=useRef(''),lastNotification=useRef('');
 const prefillContext=useRef(''),diagnosticRef=useRef(null),requestBusy=useRef(false),requestedNew=useRef(false),listSequence=useRef(0);
 const cancellationRequested=useRef(false),pendingCreation=useRef(null),pendingOperation=useRef(null),operationAbort=useRef(null);
 const [batch,setBatch]=useState(null),[batches,setBatches]=useState(null),[platforms,setPlatforms]=useState([]),[sources,setSources]=useState([]),[profiles,setProfiles]=useState([]),[platformId,setPlatformId]=useState(''),[sourceId,setSourceId]=useState(''),[profileId,setProfileId]=useState(''),[platformName,setPlatformName]=useState(''),[sourceName,setSourceName]=useState(''),[advancedSource,setAdvancedSource]=useState(false),[profileName,setProfileName]=useState(''),[file,setFile]=useState(null),[config,setConfig]=useState(blankConfig),[resolutions,setResolutions]=useState([]),[step,setStep]=useState(1),[busy,setBusy]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[ready,setReady]=useState(false),[page,setPage]=useState(1),[rowState,setRowState]=useState(''),[includeValidOnly,setIncludeValidOnly]=useState(false),[resolver,setResolver]=useState(null),[lookup,setLookup]=useState([]),[lookupQuery,setLookupQuery]=useState(''),[lookupLoading,setLookupLoading]=useState(false),[rules,setRules]=useState([]),[statusDraft,setStatusDraft]=useState('');
 const [resourceRetry,setResourceRetry]=useState(0);
 const [groupPage,setGroupPage]=useState(1);
 const [newBatch,setNewBatch]=useState(!!(view?.source||view?.record));
 const cancelled=batch?.state==='cancelled',cancellation=batch?.cancellation;
 const locked=LOCKED_STATES.has(batch?.state),durable=locked||FINAL_STATES.has(batch?.state),draft=json({config,resolutions,profileId}),dirty=!cancelled&&(!!resolver||!!statusDraft||!!profileName||!!batch&&!locked&&draft!==baseline.current||!batch&&!!(file||platformName||sourceName));
 const diagnostic=batch?.error||batch?.progress?.error||(batch?.state==='failed'?(batch.progress?.message||{message:'El servidor no completó este lote.',category:'system'}):null);
 const listSource=view?.source||(view?.record?sourceId:'');
 const diagnosticKey=diagnostic?[diagnosticText(diagnostic),diagnosticLocation(diagnostic),diagnosticValue(diagnostic.code),diagnosticValue(diagnostic.phase)].join('|'):'';
 currentBatch.current=batch;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;requestBusy.current=false;loadSequence.current++;sourceSequence.current++;profileSequence.current++;lookupSequence.current++;};},[]);
 useEffect(()=>{onInteractionStateChange?.({dirty,busy:!!busy});},[dirty,busy,onInteractionStateChange]);
 useEffect(()=>()=>onInteractionStateChange?.({dirty:false,busy:false}),[onInteractionStateChange]);
 useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
 useEffect(()=>{if(diagnosticKey)diagnosticRef.current?.focus();},[diagnosticKey]);
 useEffect(()=>{headingRef.current?.focus();},[step]);
 useEffect(()=>{setGroupPage(1);},[batch?.preview?.previewHash]);
 const acceptBatch=useCallback((data,{hydrate=false}={})=>{
  if(!data?.id)return;
  const previous=currentBatch.current;
  if(previous?.id===data.id&&previous.version>data.version)return;
  const wasPreviewing=previous?.state==='previewing';
  setBatch(data);
  if(hydrate||data.state==='cancelled'||data.workbook&&!previous?.workbook){const next={...blankConfig(),...(data.config||{}),sheetName:data.config?.sheetName||data.workbook?.sheetName||''};setConfig(next);setResolutions(data.resolutions||[]);setProfileId(data.profileId||'');baseline.current=json({config:next,resolutions:data.resolutions||[],profileId:data.profileId||''});setPlatformId(data.platformId||'');setSourceId(data.sourceId||'');}
  if(data.state==='cancelled'){setFile(null);setResolver(null);setStatusDraft('');setProfileName('');}
  currentBatch.current=data;
  if(data.state==='queued'||data.state==='applying'||FINAL_STATES.has(data.state))setStep(4);
  else if(data.state==='review'&&data.preview?.previewHash)setStep(current=>hydrate||wasPreviewing?3:current);
  else if(data.fileHash||data.workbook)setStep(current=>hydrate||current===1||data.state==='previewing'||!data.preview?.previewHash?2:current);
 },[]);
 const loadLists=useCallback(async()=>{
  const sequence=++listSequence.current;
  if(view?.record&&!listSource)return;
  setLoading(true);setError('');
  try{const [platformData,batchData]=await Promise.all([api('/api/admin/business/platforms'),api('/api/admin/imports'+(listSource?'?'+new URLSearchParams({source:listSource}):''))]);if(!mounted.current||sequence!==listSequence.current)return;setPlatforms(records(platformData));setBatches(batchData);setReady(true);}
  catch(cause){if(mounted.current&&sequence===listSequence.current)setError(diagnosticText(cause));}finally{if(mounted.current&&sequence===listSequence.current)setLoading(false);}
 },[api,listSource,view?.record]);
 useEffect(()=>{void loadLists();return()=>{listSequence.current++;};},[loadLists]);
 const loadBatch=useCallback(async(id,{hydrate=false,targetPage=1,state=''}={})=>{
  const sequence=++loadSequence.current;setLoading(true);
  try{const data=await api(`/api/admin/imports/${encodeURIComponent(id)}?${new URLSearchParams({page:String(targetPage),state})}`);if(sequence!==loadSequence.current||!mounted.current)return;acceptBatch(data,{hydrate});setError('');return data;}
  catch(cause){if(sequence===loadSequence.current&&mounted.current)setError(cause.message);}
  finally{if(sequence===loadSequence.current&&mounted.current)setLoading(false);}
 },[api,acceptBatch]);
 useEffect(()=>{
  loadSequence.current++;setError('');setResolver(null);setStatusDraft('');setProfileName('');setIncludeValidOnly(false);setPage(1);setRowState('');
  if(view?.batch){if(currentBatch.current?.id!==view.batch){setBatch(null);void loadBatch(view.batch,{hydrate:true});}}
  else{setNewBatch(requestedNew.current||!!(view?.source||view?.record));requestedNew.current=false;setBatch(null);setConfig(blankConfig());setResolutions([]);setFile(null);setPlatformId('');setSourceId('');setProfileId('');setStep(1);baseline.current='';prefillContext.current='';}
 },[view?.batch,view?.source,view?.record,loadBatch]);
 useEffect(()=>{
  if(view?.batch)return;
  const context=json([view?.source||'',view?.record||'']);
  if(context!==prefillContext.current){
   prefillContext.current=context;setSourceId('');setPlatformId('');setProfileId('');setConfig(blankConfig());setResolutions([]);setFile(null);setPlatformName('');setSourceName('');setProfileName('');
  }
  if(!view?.source&&!view?.record)return;
  let active=true;
  async function prefill(){
   try{
    const profile=view.record?await api('/api/admin/business/profiles/'+encodeURIComponent(view.record)):null;
    if(view.source&&profile&&profile.sourceId!==view.source)throw new Error('El perfil no pertenece a la cuenta del enlace. Selecciona un perfil de esta cuenta.');
    const source=await api('/api/admin/business/sources/'+encodeURIComponent(view.source||profile.sourceId));
    if(!active||currentBatch.current)return;
    setPlatformId(source.platformId);setSourceId(source.id);setAdvancedSource(source.name!=='Principal');setProfileId(profile?.id||'');
    if(profile)setConfig(profileConfig(profile));
    setNotice(profile?'Cuenta y perfil del enlace seleccionados. Revisa el archivo antes de importar.':'Cuenta del enlace seleccionada. Elige el archivo de esta cuenta.');
   }catch(cause){if(active)setError(cause.message);}
  }
  void prefill();return()=>{active=false;};
 },[api,view?.source,view?.record,view?.batch,resourceRetry]);
 useEffect(()=>{if(!batch?.id||!ACTIVE_STATES.has(batch.state)||error||busy)return;const id=batch.id,timer=setTimeout(()=>{void loadBatch(id,{targetPage:page,state:rowState});},1500);return()=>clearTimeout(timer);},[batch,api,page,rowState,error,busy,loadBatch]);
 useEffect(()=>{
  if(!batch?.id||!FINAL_STATES.has(batch.state))return;const key=`${batch.id}:${batch.state}:${batch.version}`;if(lastNotification.current!==key){lastNotification.current=key;onMutation?.({type:'import',batchId:batch.id,state:batch.state});}
 },[batch,onMutation]);
 useEffect(()=>{
  const sequence=++sourceSequence.current;setSources([]);if(!platformId)return;
  api('/api/admin/business/sources?'+new URLSearchParams({platform:platformId})).then(data=>{if(sequence!==sourceSequence.current||!mounted.current)return;const rows=records(data);setSources(rows);setSourceId(current=>currentBatch.current?.sourceId|| (rows.some(row=>row.id===current)?current:rows.find(row=>row.active&&row.name==='Principal')?.id||''));}).catch(cause=>{if(sequence===sourceSequence.current)setError(cause.message);});
 },[platformId,api,resourceRetry]);
 useEffect(()=>{
  const sequence=++profileSequence.current;setProfiles([]);if(!sourceId)return;
  api('/api/admin/business/profiles?'+new URLSearchParams({source:sourceId})).then(data=>{if(sequence===profileSequence.current&&mounted.current)setProfiles(records(data));}).catch(cause=>{if(sequence===profileSequence.current)setError(cause.message);});
 },[sourceId,api,resourceRetry]);
 async function perform(label,fn){
  if(requestBusy.current||cancellationRequested.current)return;
  requestBusy.current=true;loadSequence.current++;setLoading(false);setBusy(label);setError('');setNotice('');
  const controller=new AbortController();operationAbort.current=controller;
  const pending=(async()=>{
   try{return await fn();}
   catch(cause){if(mounted.current&&!cancellationRequested.current)setError(diagnosticText(cause));}
   finally{requestBusy.current=false;if(operationAbort.current===controller)operationAbort.current=null;if(mounted.current&&!cancellationRequested.current)setBusy('');}
  })();
  pendingOperation.current=pending;
  try{return await pending;}finally{if(pendingOperation.current===pending)pendingOperation.current=null;}
 }
 async function discardImport(){
  if(cancellationRequested.current)return;
  const target=currentBatch.current,creation=pendingCreation.current,active=pendingOperation.current,controller=operationAbort.current;
  if(!target&&!creation){setFile(null);setNotice('Archivo descartado. No se enviaron datos para importar.');return;}
  if(target&&!target.canCancel)return;
  if(!window.confirm('¿Descartar el archivo y cancelar la importación? Se detendrá lo pendiente. Las operaciones ya confirmadas se conservan: no se deshacen pedidos, inventario ni cobros. Si ya terminó, el servidor rechazará la cancelación.'))return;
  cancellationRequested.current=true;loadSequence.current++;setLoading(false);setBusy('cancel');setError('');setNotice('');
  let id=target?.id,data=null,failure=null;
  try{
   try{
    if(!id)id=(await creation).id;
    controller?.abort();
    data=await api(`/api/admin/imports/${encodeURIComponent(id)}/cancel`,{method:'POST',body:json({requestId:requestId()})});
    if(data.state!=='cancelled')throw new Error('El servidor no confirmó la cancelación.');
   }catch(cause){failure=cause;}
   await active;
   if(!mounted.current)return;
   if(!failure){
    acceptBatch(data,{hydrate:true});setIncludeValidOnly(false);
    await loadLists();
    if(view?.batch!==id){
     onInteractionStateChange?.({busy:false,dirty:false});
     await new Promise(resolve=>requestAnimationFrame(resolve));
     if(mounted.current)onViewChange?.({batch:id,record:undefined});
    }
   }else{
    if(id)await loadBatch(id,{hydrate:true});
    if(mounted.current)setError(`No se pudo confirmar la cancelación. ${diagnosticText(failure)} Revisa el estado del lote antes de volver a intentarlo.`);
   }
  }finally{cancellationRequested.current=false;if(mounted.current)setBusy('');}
 }
 async function createResource(resource,name){return api('/api/admin/business/'+resource,{method:'POST',body:json({name,requestId:requestId(),...(resource==='sources'?{platformId}:{})})});}
 async function addPlatform(event){event.preventDefault();await perform('platform',async()=>{const created=await createResource('platforms',platformName);setPlatforms(old=>[...old,created]);setPlatformId(created.id);setSourceId('');setPlatformName('');setNotice('Plataforma creada. Se usará su cuenta Principal.');});}
 async function addSource(event){event.preventDefault();await perform('source',async()=>{const created=await createResource('sources',sourceName);setSources(old=>[...old,created]);setSourceId(created.id);setProfileId('');setSourceName('');setNotice('Cuenta creada: sus identidades serán independientes.');});}
 function selectProfile(id){setProfileId(id);const selected=profiles.find(profile=>profile.id===id);if(selected)setConfig(profileConfig(selected));}
 function chooseFile(event){const selected=event.target.files?.[0];event.target.value='';if(!selected)return;setError('');if(selected.size>MAX_BYTES){setError('El archivo supera el máximo de 10 MiB.');return;}if(!/\.(xlsx|xls|xlsb|xlsm)$/i.test(selected.name)){setError('Selecciona un archivo .xlsx, .xls, .xlsb o .xlsm.');return;}setFile(selected);}
 async function upload(event){event.preventDefault();let createdId=null,uploadedFile=false;
  await perform('upload',async()=>{
   if(!platformId||!sourceId)throw new Error('Selecciona una plataforma y una cuenta real.');if(!file)throw new Error('Selecciona el archivo Excel.');
   let target=batch;
   if(!target){const creation=api('/api/admin/imports',{method:'POST',signal:operationAbort.current?.signal,body:json({sourceId,profileId:profileId||undefined,requestId:requestId()})});pendingCreation.current=creation;try{target=await creation;}finally{if(pendingCreation.current===creation)pendingCreation.current=null;}createdId=target.id;acceptBatch(target,{hydrate:false});}
   if(cancellationRequested.current)return;
   if(target.fileHash)throw new Error('Los bytes de este lote son inmutables. Crea otro lote para otro archivo.');
   const uploaded=await api(`/api/admin/imports/${encodeURIComponent(target.id)}/file`,{method:'PUT',signal:operationAbort.current?.signal,headers:{'Content-Type':file.type||'application/octet-stream','x-filename':encodeURIComponent(file.name),'x-batch-version':String(target.version),'x-request-id':requestId()},body:file});
   if(cancellationRequested.current)return;
   acceptBatch(uploaded,{hydrate:true});uploadedFile=true;setFile(null);if(uploaded.state!=='cancelled')setNotice('Archivo guardado. El proceso del servidor leerá las hojas sin ejecutar fórmulas ni macros.');
  });
  if(createdId&&uploadedFile&&mounted.current&&!cancellationRequested.current&&currentBatch.current?.state!=='cancelled'){onInteractionStateChange?.({busy:false,dirty:false});await new Promise(resolve=>requestAnimationFrame(resolve));if(mounted.current)onViewChange?.({batch:createdId,record:undefined});}
 }
 async function saveDraft({nextConfig=config,nextResolutions=resolutions,nextProfileId=profileId}={}){
  const target=currentBatch.current;if(!target)throw new Error('Primero guarda el archivo.');
  const book=target.workbook,headerCells=book?.rows?.find(row=>row.rowNumber===Number(nextConfig.headerRow))?.cells||[];
  if(book?.sheetName===nextConfig.sheetName&&Number(book.headerRow)===Number(nextConfig.headerRow)){
   const width=Math.min(200,Math.max(headerCells.length,book.sheets?.find(sheet=>sheet.name===nextConfig.sheetName)?.columnCount||0));
   nextConfig={...nextConfig,columns:Array.from({length:width},(_,index)=>nextConfig.columns.find(column=>column.index===index)||{index,header:normalizedHeader(cellText(headerCells[index])),destination:'ignore',group:0})};
  }
  const base=target.resolutions||[],changes=nextResolutions.filter(item=>!base.some(saved=>json(saved)===json(item)));
  let result=target;
  for(let offset=0;offset<Math.max(1,changes.length);offset+=100){
   if(cancellationRequested.current)return null;
   result=await api(`/api/admin/imports/${encodeURIComponent(target.id)}`,{method:'PUT',signal:operationAbort.current?.signal,body:json({version:result.version,requestId:requestId(),config:nextConfig,profileId:nextProfileId||null,resolutions:changes.slice(offset,offset+100)})});
   if(cancellationRequested.current)return null;
  }
  const storedConfig={...blankConfig(),...(result.config||nextConfig)},storedResolutions=result.resolutions||nextResolutions,storedProfile=result.profileId||nextProfileId||'';
  acceptBatch(result);setConfig(storedConfig);setResolutions(storedResolutions);setProfileId(storedProfile);baseline.current=json({config:storedConfig,resolutions:storedResolutions,profileId:storedProfile});return result;
 }
 async function saveAndPreview(event){event?.preventDefault();await perform('preview',async()=>{if(batch?.state==='previewing')return;if(!config.sheetName)throw new Error('Selecciona una hoja para revisar.');if(!samplesCurrent)throw new Error('Lee las muestras de esta hoja y fila de encabezados antes de revisar.');if(!config.columns.some(column=>column.destination&&column.destination!=='ignore'))throw new Error('Asigna al menos una columna; las demás se ignorarán.');const saved=await saveDraft();if(!saved)return;const data=await api(`/api/admin/imports/${encodeURIComponent(saved.id)}/preview`,{method:'POST',signal:operationAbort.current?.signal,body:json({version:saved.version,requestId:requestId()})});if(cancellationRequested.current)return;acceptBatch(data);setIncludeValidOnly(false);});}
 async function saveProfile(event){event.preventDefault();await perform('profile',async()=>{if(!profileName.trim())throw new Error('Escribe un nombre para el perfil.');const saved=await saveDraft();if(!saved)return;const selected=profiles.find(profile=>profile.id===profileId),data=await api('/api/admin/business/profiles'+(selected?'/'+encodeURIComponent(selected.id):''),{method:selected?'PUT':'POST',body:json({name:profileName,sourceId,profile:saved.config,requestId:requestId(),...(selected?{version:selected.version}:{})})});if(cancellationRequested.current)return;setProfiles(old=>[...old.filter(profile=>profile.id!==data.id),data]);setProfileId(data.id);currentBatch.current=saved;await saveDraft({nextConfig:saved.config,nextProfileId:data.id});if(cancellationRequested.current)return;setProfileName('');setNotice('Perfil guardado para esta cuenta. Los alias se conservan por separado en el origen.');});}
 async function commit(){await perform('commit',async()=>{if(dirty)throw new Error('Guarda los cambios y genera una revisión nueva antes de importar.');if(!reviewReady)throw new Error('Espera una revisión completa y válida antes de importar.');const data=await api(`/api/admin/imports/${encodeURIComponent(batch.id)}/commit`,{method:'POST',signal:operationAbort.current?.signal,body:json({version:batch.version,previewHash:batch.preview.previewHash,includeValidOnly,requestId:requestId()})});if(cancellationRequested.current)return;acceptBatch(data);setStep(4);onMutation?.({type:'import',batchId:data.id,state:data.state});});}
 async function download(kind){await perform('download',async()=>{const blob=await api(`/api/admin/imports/${encodeURIComponent(batch.id)}/${kind}`,{responseType:'blob',signal:operationAbort.current?.signal});if(cancellationRequested.current)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');try{anchor.href=url;anchor.download=kind==='file'?safeName(batch.filename):safeName(`errores-${batch.id}.xlsx`);document.body.appendChild(anchor);anchor.click();anchor.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}});}
 function updateConfig(key,value){setConfig(old=>({...old,[key]:value}));setIncludeValidOnly(false);}
 function changeColumn(index,header,patch){setConfig(old=>{const columns=[...old.columns],position=columns.findIndex(column=>column.index===index),next={destination:'ignore',group:0,...(columns[position]||{}),index,header:normalizedHeader(header),...patch};if(!LINE_FIELDS.has(next.destination)||old.layout==='item_rows')next.group=0;if(position<0)columns.push(next);else columns[position]=next;return {...old,columns};});setIncludeValidOnly(false);}
 function addResolution(item){setResolutions(old=>[...old.filter(saved=>!(saved.action===item.action&&saved.entityKey===item.entityKey&&saved.rowNumber===item.rowNumber&&saved.externalKey===item.externalKey&&saved.sheet===item.sheet)),item]);setIncludeValidOnly(false);}
 async function openResolver(action,context={}){if(resolver&&!window.confirm('Hay una resolución sin guardar. ¿Descartarla?'))return;setError('');setResolver({action,entityKey:context.entityKey||groupKey(context),sheet:context.sheet||config.sheetName,rowNumber:context.rowNumber||context.rowNumbers?.[0]||'',externalKey:context.externalKey||'',internalId:'',value:['review_authority','commercial_update'].includes(action)?{}:'',reason:'',...context});setLookup([]);setLookupQuery('');if(action==='review_policy'){await perform('rules',async()=>{const data=await api('/api/admin/business/settings');setRules(data.rulesVersions||[]);});}}
 function closeResolver(){setResolver(null);}
 const searchLookup=useCallback(async(action,query)=>{
  const sequence=++lookupSequence.current;setLookupLoading(true);setError('');
  try{
   let found;
   if(action==='link_product'){const data=await Promise.all([api('/api/admin/products'),api('/api/admin/combos')]);found=data.flatMap(records);}
   else{let path;if(action==='link_person')path='/api/admin/business/people?active=1';else if(action==='link_order')path='/api/admin/orders?'+new URLSearchParams({q:query,page:'1',lookup:'identity'});else if(action==='link_shipment')path='/api/admin/business/shipments?'+new URLSearchParams({q:query,page:'1'});else return;found=records(await api(path));}
   if(sequence===lookupSequence.current)setLookup(found.filter(item=>!query||['link_order','link_shipment'].includes(action)||[item.title,item.name,item.sku,item.presentation].some(value=>String(value||'').toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')))));
  }
  catch(cause){if(sequence===lookupSequence.current)setError(cause.message);}finally{if(sequence===lookupSequence.current)setLookupLoading(false);}
 },[api]);
 useEffect(()=>{if(!resolver?.action?.startsWith('link_'))return;const timer=setTimeout(()=>{void searchLookup(resolver.action,lookupQuery);},250);return()=>{clearTimeout(timer);lookupSequence.current++;};},[resolver?.action,lookupQuery,searchLookup]);
 function applyResolution(event){
  event.preventDefault();const {action,entityKey,sheet,rowNumber,externalKey,internalId,value,reason}=resolver;
  let resolvedValue=value;
  if(action==='review_policy')resolvedValue={ruleVersionId:value};
  if(action==='accept_formulas')resolvedValue=true;
  if(action==='commercial_update'&&!Object.keys(value).length){setError('Selecciona al menos un dato comercial o completa las líneas.');return;}
  if(['duplicate','additional_quantity'].includes(action)&&!rowNumber){setError('Indica la fila exacta para resolver la repetición.');return;}
  addResolution({action,...(entityKey?{entityKey}:{}),...(sheet?{sheet}:{}),...(rowNumber?{rowNumber:Number(rowNumber)}:{}),...(externalKey?{externalKey}:{}),...(internalId?{internalId}:{}),...(resolvedValue!==''?{value:resolvedValue}:{}),...(reason?{reason}:{})});
  closeResolver();setNotice('Resolución preparada. Genera una revisión nueva para validar sus consecuencias.');
 }
 async function createProduct(){
  const context=await perform('create-product',async()=>{const saved=await saveDraft();if(!saved)return null;return {batchId:saved.id,sourceId:saved.sourceId,externalKey:resolver.externalKey,entityKey:resolver.entityKey,rowNumber:resolver.rowNumber,sheet:resolver.sheet};});
  if(!context)return;setResolver(null);onInteractionStateChange?.({busy:false,dirty:false});
  await new Promise(resolve=>requestAnimationFrame(resolve));
  if(view?.batch!==context.batchId){onViewChange?.({batch:context.batchId,record:undefined});await new Promise(resolve=>requestAnimationFrame(resolve));}
  try{const created=await onCreateProduct?.(context),product=created?.record||created;if(product?.id&&mounted.current){const {batchId,sourceId,...scope}=context,next=[...resolutions,{action:'link_product',...scope,internalId:product.id}];setResolutions(next);await perform('save',()=>saveDraft({nextResolutions:next}));}}
  catch(cause){if(mounted.current)setError(cause.message);}
 }
 const workbook=batch?.workbook,sheets=workbook?.sheets||[],samplesCurrent=!!workbook&&workbook.sheetName===config.sheetName&&Number(workbook.headerRow)===Number(config.headerRow),sampleRows=samplesCurrent?(workbook.rows||[]):[],selectedSheet=sheets.find(sheet=>sheet.name===config.sheetName),headerSample=sampleRows.find(row=>row.rowNumber===Number(config.headerRow)),headers=headerSample?.cells||[],sampleColumns=samplesCurrent?Math.min(200,Math.max(headers.length,selectedSheet?.columnCount||0,...sampleRows.map(row=>row.cells?.length||0))):0,groups=serverGroups(batch),summary=batch?.preview?.summary||batch?.summary||{},invalidGroups=groups.filter(group=>['conflict','rejected','invalid'].includes(group.state)||group.valid===false||group.errors?.length),invalidCount=Number(summary.conflict??0)+Number(summary.rejected??summary.invalid??0)||invalidGroups.length,validCount=Number(summary.valid??groups.length-invalidGroups.length),hasPreview=!!batch?.preview?.previewHash;
 const settlementsPending=Number(summary.settlementsPending||0),hasImportable=validCount>0||settlementsPending>0;
 const previewing=batch?.state==='previewing',reviewReady=batch?.state==='review'&&hasPreview&&!diagnostic;
 const showWizard=!!batch||newBatch;
 const groupPages=Math.max(1,Math.ceil(groups.length/20)),shownGroups=groups.slice((groupPage-1)*20,groupPage*20);
 const setResolverField=(key,value)=>setResolver(old=>({...old,[key]:value}));
 const select=(key,label,options)=><Field field={{name:key,label,type:'select',options:options.map(([value,label])=>({value,label}))}} value={config[key]} onChange={value=>updateConfig(key,value)}/>;
 const resume=id=>onViewChange?.({batch:id});
 const listPage=async next=>perform('batch-list',async()=>{const sequence=++listSequence.current,data=await api('/api/admin/imports?'+new URLSearchParams({page:String(next),source:listSource}));if(mounted.current&&sequence===listSequence.current)setBatches(data);});
 function startNewBatch(){setNewBatch(true);requestedNew.current=!!batch;if(batch)onViewChange?.({batch:'',record:undefined});}
 function retryRead(){setResourceRetry(value=>value+1);if(resolver?.action?.startsWith('link_'))void searchLookup(resolver.action,lookupQuery);if(batch)void loadBatch(batch.id,{targetPage:page,state:rowState});else if(view?.batch)void loadBatch(view.batch,{hydrate:true});else void loadLists();}
 return <section className={`admin-card ${styles.wizard}`} aria-label="Importar Excel">
  <header className="admin-heading"><div><p className="eyebrow">Importaciones · Excel</p><h2 ref={headingRef} tabIndex={-1}>Importar Excel</h2><p className="muted">Pedidos, seguimiento y liquidaciones de cualquier plataforma mediante columnas revisadas.</p></div><div className="admin-actions">{(batch||!newBatch)&&<button type="button" className="button subtle" disabled={!!busy} onClick={startNewBatch}>Nuevo lote</button>}{(batch?batch.canCancel:!!file)&&<button type="button" className="button subtle" disabled={busy==='cancel'} onClick={discardImport}>{busy==='cancel'?'Cancelando…':batch?.acceptedRevision?'Cancelar importación':'Descartar archivo'}</button>}</div></header>
  {showWizard&&!cancelled&&<><ol className={`order-progress ${styles.progress}`} aria-label="Pasos de importación">{['Archivo y origen','Columnas','Revisión','Importar'].map((label,index)=><li key={label} aria-current={step===index+1?'step':undefined} data-saved={step>index+1}><strong>{index+1}. {label}</strong>{step===index+1&&<span>Estás aquí</span>}</li>)}</ol>
  <div className={styles.stepGuide}><p className={styles.sectionLabel}>Paso {step} de 4</p><h3>{STEP_GUIDANCE[step-1][0]}</h3><p>{STEP_GUIDANCE[step-1][1]}</p></div></>}
  {error&&!resolver&&<div className="error" role="alert" tabIndex={-1} ref={errorRef}><p>{diagnosticText(error)}</p><button type="button" className="button subtle" disabled={!!busy} onClick={retryRead}>Reintentar lectura</button></div>}
  {notice&&<p role="status">{notice}</p>}
  {loading&&<p className="muted" role="status">Consultando datos del servidor…</p>}
  {batch&&<p className="small muted">Lote {batch.id} · {STATE_LABELS[batch.state]||batch.state}{batch.filename?` · ${batch.filename}`:''}</p>}
  {diagnostic&&<ImportDiagnostic diagnostic={diagnostic} alertRef={diagnosticRef}/>}
  {previewing&&<p role="status">Preparando revisión en el servidor. El archivo y la configuración están guardados. Puedes navegar o cerrar el panel y retomar este lote; la confirmación estará disponible solo cuando termine la revisión.</p>}
  {!diagnostic&&batch?.progress?.message&&<p role="status">{diagnosticText(batch.progress.message)}</p>}
  {batch?.progress?.settlementIssues?.length>0&&<section className="error" role="alert"><h3>{cancelled?'Excepciones conservadas de liquidaciones':'Liquidaciones por revisar'}</h3><p>{cancelled?'Este lote está cancelado; las excepciones se conservan como historial. Para corregirlas, crea un lote nuevo.':'Los pedidos ya aplicados no se repetirán. Corrige estos vínculos o documentos y genera una revisión nueva.'}</p><ul>{batch.progress.settlementIssues.map((issue,index)=><li key={diagnosticValue(issue.key)||index}>{diagnosticValue(issue.key)} · {messages([issue.error||issue]).join(' ')}</li>)}</ul></section>}
  {!batch&&view?.batch&&!loading&&!error&&<p role="status">Abriendo lote…</p>}
  {!batch&&!view?.batch&&batches&&<section aria-label="Importaciones guardadas"><h3>Importaciones guardadas</h3><p>Los lotes en curso conservan el archivo, las columnas guardadas y el progreso. También puedes consultar los resultados de lotes terminados o cancelados.</p>{records(batches).length?<ul className="history-timeline">{records(batches).map(item=><li key={item.id}><strong>{item.filename||'Sin archivo guardado'}</strong><p>{STATE_LABELS[item.state]||item.state} · {item.createdAt}</p><p className="small muted">Lote {item.id} · Cuenta {item.sourceId}</p><button type="button" className="button primary" disabled={!!busy} onClick={()=>resume(item.id)}>{FINAL_STATES.has(item.state)?'Ver resultado':'Retomar lote'}</button></li>)}</ul>:<p>No hay lotes guardados en esta lista. Usa Nuevo lote para seleccionar un archivo.</p>}<div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy||(batches.page||1)<=1} onClick={()=>listPage((batches.page||1)-1)}>Lotes anteriores</button><span>Página {batches.page||1}</span><button type="button" className="button subtle" disabled={!!busy||(batches.page||1)*(batches.pageSize||20)>=(batches.total||0)} onClick={()=>listPage((batches.page||1)+1)}>Más lotes</button></div></section>}
  {showWizard&&step===1&&(!view?.batch||batch)&&<>
   <form onSubmit={upload}>
    <fieldset disabled={!!busy||!!batch?.fileHash} className={`field ${styles.importGroup}`}><legend>1. Origen del archivo</legend>
     <label className="field">Plataforma<select required disabled={!!batch} value={platformId} onChange={event=>{setPlatformId(event.target.value);setSourceId('');setProfileId('');}}><option value="">Selecciona la plataforma</option>{platforms.map(platform=><option key={platform.id} disabled={!platform.active&&!batch} value={platform.id}>{platform.name}{platform.active?'':' · Archivada'}</option>)}</select></label>
     <p className="small muted">La plataforma es la empresa o servicio que exporta el archivo, no necesariamente la transportadora. No se suponen columnas ni estados de ninguna marca.</p>
     {platformId&&<p>Cuenta: <strong>{sources.find(source=>source.id===sourceId)?.name||'Cargando Principal…'}</strong></p>}
     {platformId&&<details open={advancedSource} onToggle={event=>setAdvancedSource(event.currentTarget.open)}><summary>Otra cuenta en esta plataforma</summary><p className="small muted">Usa otra cuenta solo si sus pedidos y recaudos tienen identidades independientes.</p>{sources.length>1&&<label className="field">Cuenta de origen<select disabled={!!batch} value={sourceId} onChange={event=>{setSourceId(event.target.value);setProfileId('');}}>{sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}</details>}
     {sourceId&&<label className="field">Perfil de columnas<select disabled={!!batch} value={profileId} onChange={event=>selectProfile(event.target.value)}><option value="">Configurar columnas para este archivo</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · versión {profile.version}</option>)}</select></label>}
     <h3 className={styles.subheading}>2. Archivo privado</h3>
     <label className="field">Archivo Excel<input type="file" accept=".xlsx,.xls,.xlsb,.xlsm" onChange={chooseFile} required={!file}/></label><p className="small muted">Máximo 10 MiB, 20 hojas, 200 columnas y 10.000 filas en la hoja seleccionada. El original queda privado y no se puede sustituir en este lote.</p>{file&&<p>{file.name} · {(file.size/1024/1024).toLocaleString('es-CO',{maximumFractionDigits:2})} MiB</p>}
    </fieldset><button className="button primary" disabled={!!busy||!ready||!sourceId||!file}>{busy==='upload'?'Guardando archivo…':'Guardar archivo y continuar'}</button>
   </form>
   {!batch&&<details><summary>Crear plataforma por nombre</summary><form onSubmit={addPlatform}><label className="field">Nombre de la plataforma<input required maxLength={150} value={platformName} onChange={event=>setPlatformName(event.target.value)}/></label><button className="button subtle" disabled={!!busy}>Crear plataforma y cuenta Principal</button></form></details>}
   {!batch&&platformId&&advancedSource&&<form onSubmit={addSource}><label className="field">Nombre de la otra cuenta<input required maxLength={150} value={sourceName} onChange={event=>setSourceName(event.target.value)}/></label><button className="button subtle" disabled={!!busy}>Crear cuenta independiente</button></form>}
  </>}
  {batch&&step===2&&<>
   {!workbook?<p role="status">{diagnostic?'No se pudo completar la lectura de las hojas. Consulta el diagnóstico de este lote; el original guardado sigue disponible.':'El servidor está leyendo las hojas. Puedes salir y retomar este lote después.'}</p>:<>
    <form onSubmit={saveAndPreview}>
     <fieldset disabled={!!busy||locked||previewing||batch.fileExpired} className={`field ${styles.importGroup}`}><legend>1. Cómo leer el archivo</legend><div className="form-grid">
      <label className="field">Hoja<select required value={config.sheetName} onChange={event=>updateConfig('sheetName',event.target.value)}><option value="">Selecciona la hoja</option>{sheets.map(sheet=><option key={sheet.name} value={sheet.name}>{sheet.name} · {sheet.rowCount} filas · {sheet.columnCount} columnas</option>)}</select></label>
      <label className="field">Fila de encabezados<input type="number" min={1} max={10000} required value={config.headerRow} onChange={event=>updateConfig('headerRow',Number(event.target.value))}/></label>
      {select('purpose','Qué contiene el archivo',[['orders','Pedidos y sus envíos'],['tracking','Solo seguimiento (no exige productos)'],['settlements','Liquidaciones declaradas (no ingresa dinero a caja)']])}
      <p className="small muted">Si el archivo contiene guías y estados, pero no identifica productos, cantidades y precios, usa Solo seguimiento para vincularlo con pedidos existentes. No se inventarán ventas ni productos.</p>
      {select('layout','Distribución de productos',[['item_rows','Una fila por producto; agrupar por pedido'],['order_rows','Una fila por pedido; varios grupos de columnas']])}
      {select('dateFormat','Orden explícito de las fechas',[['DMY','Día / mes / año'],['MDY','Mes / día / año'],['ISO','Año-mes-día (ISO)']])}
      {select('decimalSeparator','Separador decimal',[ [',','Coma (1234,50)'],['.','Punto (1234.50)'] ])}
      {select('groupSeparator','Separador de miles',[['.','Punto'],[',','Coma'],[' ','Espacio'],['','Sin separador']])}
      <label className="field">Fecha de corte del reporte, si no existe columna<input type="date" value={cutoffDate(config.reportAsOf)} onChange={event=>updateConfig('reportAsOf',event.target.value)}/><small className="muted">Corte al final de este día en Bogotá. Obligatorio para observar estados o costos sin fecha propia; no se usa la fecha de subida.</small></label>
     </div>
     <label className="checkbox-field"><input type="checkbox" checked={!!config.oneOrderPerGuide} onChange={event=>updateConfig('oneOrderPerGuide',event.target.checked)}/><span>Cada guía corresponde a un pedido: permitir crear pedidos sin ID externo, solo si todos los datos comerciales están completos.</span></label>
     {!samplesCurrent&&<p role="status">La hoja o el encabezado cambió. Lee sus muestras antes de asignar columnas.</p>}
     <button type="button" className="button subtle" disabled={!!busy||locked||!config.sheetName||samplesCurrent} onClick={()=>perform('samples',async()=>{await saveDraft();setNotice('Lectura de muestras solicitada al servidor.');})}>Leer muestras de esta hoja y encabezado</button>
     <h3 className={styles.subheading}>2. Asignación de columnas</h3><p>Asigna cada columna por su posición. Las columnas ignoradas no se importan. Los encabezados repetidos permanecen separados; no se aplican sugerencias automáticamente.</p>
     <div className={styles.columnGrid}>{Array.from({length:sampleColumns},(_,index)=>{
      const header=cellText(headers[index]),mapping=config.columns.find(column=>column.index===index),samples=sampleRows.filter(row=>row.rowNumber>Number(config.headerRow)).slice(0,3),changedHeader=mapping?.header!==undefined&&mapping.header!==normalizedHeader(header);
      return <fieldset className="order-line" key={index} style={{margin:0,minWidth:0}}>
       <legend>Columna {index+1} · {header||'Sin encabezado'}</legend>
       <p className="small muted">Muestras: {samples.length?samples.map(row=>`${row.rowNumber}: ${cellText(row.cells?.[index])||'(vacío)'}`).join(' · '):'Sin filas de muestra después de este encabezado.'}</p>
       {changedHeader&&<><p>El perfil esperaba «{mapping.header||'sin encabezado'}». La revisión volverá a buscar encabezados únicos; si falta o está repetido, pedirá corregirlo.</p><button type="button" className="button subtle" onClick={()=>changeColumn(index,header,{})}>Confirmar asignación en esta posición</button></>}
       <label className="field">Destino de columna {index+1}<select value={mapping?.destination||'ignore'} onChange={event=>changeColumn(index,header,{destination:event.target.value})}><option value="ignore">Ignorar explícitamente</option>{DESTINATIONS.map(([label,fields])=><optgroup label={label} key={label}>{fields.map(([value,label])=><option key={value} value={value}>{label}</option>)}</optgroup>)}</select></label>
       {config.layout==='order_rows'&&LINE_FIELDS.has(mapping?.destination)&&<label className="field">Grupo de producto<input type="number" min={1} max={50} value={(mapping?.group||0)+1} onChange={event=>changeColumn(index,header,{group:Number(event.target.value)-1})}/><small>Precio, cantidad y referencia del mismo producto deben usar el mismo grupo.</small></label>}
      </fieldset>;
     })}</div>
     {!sampleColumns&&<p>No se recibieron columnas de muestra. Selecciona hoja y encabezado, guarda y solicita revisión para leerlos en el servidor.</p>}
     <StatusMapping config={config} disabled={!!busy||locked} onChange={value=>updateConfig('statusMap',value)} statusDraft={statusDraft} setStatusDraft={setStatusDraft}/>
     </fieldset><div className="admin-actions"><button className="button primary" disabled={!!busy||locked||previewing||batch.fileExpired}>{busy==='preview'?'Solicitando revisión…':previewing?'Preparando revisión…':'Guardar columnas y revisar'}</button><button type="button" className="button subtle" disabled={!!busy||locked||previewing} onClick={()=>perform('save',async()=>{await saveDraft();setNotice('Configuración guardada.');})}>Guardar sin revisar</button>{hasPreview&&!previewing&&<button type="button" className="button subtle" onClick={()=>setStep(3)}>Volver a la revisión</button>}</div>
    </form>
    <details><summary>Guardar como perfil reutilizable de esta cuenta</summary><form onSubmit={saveProfile}><label className="field">Nombre del perfil<input required maxLength={150} value={profileName} onChange={event=>setProfileName(event.target.value)} placeholder={profiles.find(profile=>profile.id===profileId)?.name||'Nombre descriptivo'}/></label>{profileId&&<p>Se actualizará el perfil seleccionado. Otros lotes ya aceptados conservan su versión congelada.</p>}<button className="button subtle" disabled={!!busy||locked}>Guardar perfil</button>{profileId&&<button type="button" className="button subtle" disabled={!!busy||locked} onClick={()=>setProfileId('')}>Guardar como un perfil nuevo</button>}</form></details>
   </>}
  </>}
  {batch&&step===3&&<>
   {!hasPreview?<><p role="status">Todavía no hay una revisión completa. Conservamos el archivo y la configuración guardada.</p><button type="button" className="button subtle" disabled={!!busy} onClick={()=>setStep(2)}>Volver a columnas</button></>:previewing?<p role="status">La revisión anterior ya no permite confirmar mientras se prepara la nueva.</p>:<>
    <h3>Revisa grupos completos antes de importar</h3><p>Un pedido o envío se aplica completo. No se crean productos ficticios, ventas incompletas ni movimientos de caja por un estado de entrega.</p>
    {summaryItems(summary).length>0&&<dl className={`form-grid ${styles.summaryMetrics}`}>{summaryItems(summary).map(([key,value])=><div key={key}><dt>{RESULT_LABELS[key]}</dt><dd>{value}</dd></div>)}</dl>}
    {batch.preview?.warnings?.length>0&&<ul>{messages(batch.preview.warnings).map((message,index)=><li key={index}>{message}</li>)}</ul>}
    {workbook?.warnings?.length>0&&<details><summary>Advertencias del archivo</summary><ul>{messages(workbook.warnings).map((message,index)=><li key={index}>{message}</li>)}</ul></details>}
    <div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy||locked} onClick={()=>setStep(2)}>Cambiar columnas o estados</button><button type="button" className="button subtle" disabled={!!busy||locked||batch.fileExpired} onClick={saveAndPreview}>Guardar resoluciones y revisar de nuevo</button></div>
    <ResolutionActions actions={FILE_RESOLUTIONS} disabled={!!busy||locked} onResolve={()=>openResolver('accept_formulas')}/>
    {!groups.length&&<p>{settlementsPending>0?`Los pedidos ya están aplicados; quedan ${settlementsPending} liquidaciones para esta revisión.`:hasPreview?'La revisión no contiene grupos importables. Revisa la hoja y sus columnas.':'Todavía no hay una revisión. Configura las columnas y solicita revisarla.'}</p>}
    <div>{shownGroups.map((group,index)=><article className="order-line" key={groupKey(group)||index}><h4>{group.label || groupCaption(group)}</h4><p><strong>{RESULT_LABELS[group.state]||group.state||'Por revisar'}</strong>{group.orderNumber?` · AN-${group.orderNumber}`:''}{group.tracking?` · Guía ${group.tracking}`:''}</p>{group.rowNumbers&&<p className="small muted">Filas: {group.rowNumbers.join(', ')}</p>}{messages(group.errors).map((message,i)=><p className="error" key={i}>{message}</p>)}{messages(group.warnings).map((message,i)=><p key={i}>{message}</p>)}{group.reason&&<p>{group.reason}</p>}
     {group.tasks?.length>0&&<ul>{messages(group.tasks).map((task,i)=><li key={i}>{task}</li>)}</ul>}
     {group.lines?.length>0&&<ul>{group.lines.map((item,i)=><li key={i}>{item.productExternalKey||item.title||item.itemId||'Producto por resolver'} · cantidad {item.quantity} · {item.unitPriceMinor==null?'Precio sin resolver':`${(item.unitPriceMinor/100).toLocaleString('es-CO')} COP`}{item.discountMinor?` · descuento ${(item.discountMinor/100).toLocaleString('es-CO')} COP`:''}</li>)}</ul>}
     {(group.orderId||group.shipmentIds?.length>0)&&<details><summary>Destino identificado</summary>{group.orderId&&<p>Pedido: {group.orderId}</p>}{group.shipmentIds?.map(id=><p key={id}>Envío: {id}</p>)}</details>}
     {!locked&&group.state!=='applied'&&<details><summary>Resolver este grupo</summary><p className="small muted">Los vínculos se guardan para esta cuenta de plataforma, no por nombre de cliente ni teléfono.</p><ResolutionActions actions={GROUP_RESOLUTIONS} disabled={!!busy} onResolve={action=>openResolver(action,{entityKey:groupKey(group),sheet:group.sheet||config.sheetName,rowNumber:['duplicate','additional_quantity'].includes(action)?group.rowNumbers?.[0]||'':'',externalKey:group.externalKey||''})}/></details>}
    </article>)}</div>
    {groups.length>20&&<div className="admin-actions"><button type="button" className="button subtle" disabled={groupPage<=1} onClick={()=>setGroupPage(value=>value-1)}>Grupos anteriores</button><span>Grupos · página {groupPage} de {groupPages}</span><button type="button" className="button subtle" disabled={groupPage>=groupPages} onClick={()=>setGroupPage(value=>value+1)}>Más grupos</button></div>}
    {resolutions.length>0&&<details><summary>Resoluciones preparadas ({resolutions.length}){dirty?' · pendientes de validar':''}</summary><ul>{resolutions.map((resolution,index)=><li key={index}>{RESOLUTION_LABELS[resolution.action]||resolution.action} · {resolution.externalKey||resolution.entityKey||'Todo el lote'}{resolution.rowNumber?` · fila ${resolution.rowNumber}`:''}{resolution.reason?` · ${resolution.reason}`:''}</li>)}</ul></details>}
    <SourceRows batch={batch} page={page} rowState={rowState} busy={!!busy||loading} onFilter={state=>{setRowState(state);setPage(1);void loadBatch(batch.id,{targetPage:1,state});}} onPage={next=>{setPage(next);void loadBatch(batch.id,{targetPage:next,state:rowState});}} onResolve={(action,row)=>openResolver(action,{entityKey:row.entityKey||row.groupKey,sheet:row.sheet||config.sheetName,rowNumber:row.rowNumber,externalKey:rowExternalKey(action,row)})}/>
    {invalidCount>0&&<label className="checkbox-field"><input type="checkbox" checked={includeValidOnly} onChange={event=>setIncludeValidOnly(event.target.checked)} disabled={dirty||!!busy}/><span>Importar solo los {validCount} grupos válidos; omitir explícitamente {invalidCount} grupos con errores o conflictos. Ningún grupo se importa a medias.</span></label>}
    {dirty&&<p role="status">Hay cambios sin validar. Genera una nueva revisión antes de confirmar.</p>}
    <button type="button" className="button primary" disabled={!!busy||dirty||!reviewReady||!hasImportable||invalidCount>0&&!includeValidOnly||batch.fileExpired} onClick={()=>setStep(4)}>Continuar a confirmación</button>
   </>}
  </>}
  {batch&&step===4&&<>
   <h3>{durable?'Resultado y progreso':'Confirmar importación'}</h3>
   {!durable&&<><p>Se aplicará únicamente esta revisión: <strong>{batch.preview?.previewHash?.slice(0,16)||'Sin revisión'}</strong>. El archivo, las resoluciones y las versiones de destino quedan congelados al confirmar. La recepción de liquidaciones se confirma luego en Caja.</p>{includeValidOnly&&<p>Se omitirán {invalidCount} grupos completos; se seleccionaron {validCount} válidos.</p>}<div className="admin-actions"><button type="button" className="button subtle" disabled={!!busy} onClick={()=>setStep(3)}>Volver a revisar</button><button type="button" className="button primary" disabled={!!busy||dirty||!reviewReady||!hasImportable||invalidCount>0&&!includeValidOnly||batch.fileExpired} onClick={commit}>{busy==='commit'?'Aceptando importación…':'Confirmar e importar'}</button></div></>}
   {locked&&<><p role="status">{STATE_LABELS[batch.state]}. El trabajo quedó guardado; puedes navegar o cerrar el panel. Se reanudará sin repetir grupos aplicados.</p><progress aria-label="Operaciones procesadas" max={Number(batch.progress?.total)||1} value={Number(batch.progress?.processed??batch.progress?.applied)||0} style={{width:'100%'}}/><p>{batch.progress?.phase==='settlements'?'Vinculando declaraciones de liquidación':'Aplicando pedidos y envíos'} · {diagnosticValue(batch.progress?.processed??batch.progress?.applied)||'0'} de {diagnosticValue(batch.progress?.total)||'—'} operaciones.</p></>}
   {cancelled?<div role="status">
    <p><strong>Importación cancelada. Archivo descartado de este lote.</strong></p>
    <p>{cancellation?Number(cancellation.appliedGroups)+Number(cancellation.appliedSettlements)>0?`Grupos confirmados: ${cancellation.appliedGroups}. Liquidaciones confirmadas: ${cancellation.appliedSettlements}. Se conservan sus pedidos, inventario y cobros; cancelar no los revierte.`:'No se aplicaron operaciones de importación.':'Los hechos ya confirmados se conservan; cancelar no los revierte.'}</p>
    {batch.acceptedRevision&&cancellation&&<p>Pendientes detenidos — grupos: {cancellation.remainingGroups}; liquidaciones: {cancellation.remainingSettlements}.</p>}
    <p>Este lote no se reanudará; para otro archivo, crea un lote nuevo.</p>
   </div>:FINAL_STATES.has(batch.state)&&<p role="status">{STATE_LABELS[batch.state]}. Los hechos aplicados y las filas fuente se conservaron. Una importación terminada no se puede descartar ni cancelar.</p>}
   <dl className={`form-grid ${styles.summaryMetrics}`}>{summaryItems(batch.progress||batch.result||summary).map(([key,value])=><div key={key}><dt>{RESULT_LABELS[key]}</dt><dd>{value}</dd></div>)}</dl>
   {(batch.state==='failed'||batch.state==='completed_with_errors')&&<button type="button" className="button subtle" disabled={!!busy} onClick={()=>setStep(3)}>Revisar pendientes sin repetir aplicados</button>}
   <SourceRows batch={batch} page={page} rowState={rowState} busy={!!busy||loading} onFilter={state=>{setRowState(state);setPage(1);void loadBatch(batch.id,{targetPage:1,state});}} onPage={next=>{setPage(next);void loadBatch(batch.id,{targetPage:next,state:rowState});}}/>
  </>}
  {resolver&&!locked&&!cancelled&&<ResolutionDialog title={RESOLUTION_LABELS[resolver.action]} busy={!!busy} cancelling={busy==='cancel'} onCancelImport={batch?.canCancel?discardImport:undefined} cancelLabel={batch?.acceptedRevision?'Cancelar importación':'Descartar archivo'} onClose={closeResolver} onSubmit={applyResolution}>
   {error&&<div className="error" role="alert" tabIndex={-1} ref={errorRef}><p>{diagnosticText(error)}</p><button type="button" className="button subtle" disabled={!!busy} onClick={retryRead}>Reintentar lectura</button></div>}
   <fieldset className="field" disabled={!!busy}>
    {resolver.entityKey&&<p>Grupo: {resolver.entityKey}</p>}
    <div className="form-grid"><label className="field">Fila de origen (si aplica)<input type="number" min={1} max={10000} value={resolver.rowNumber||''} onChange={event=>setResolverField('rowNumber',event.target.value)}/></label>{['link_product','link_person','link_order','link_shipment','status'].includes(resolver.action)&&<label className="field">Identificador exacto del archivo{['link_product','link_person','status'].includes(resolver.action)?' *':''}<input required={['link_product','link_person','status'].includes(resolver.action)} maxLength={300} value={resolver.externalKey} onChange={event=>setResolverField('externalKey',event.target.value)}/><small className="muted">La clave externa (externalKey) debe respetar mayúsculas y ceros iniciales. Para estado, escribe el texto exacto de la celda.</small></label>}</div>
    {resolver.action.startsWith('link_')&&<><label className="field">Buscar registro real<input value={lookupQuery} maxLength={100} onChange={event=>setLookupQuery(event.target.value)} placeholder={resolver.action==='link_order'?'Número AN o búsqueda del listado':'Nombre o referencia'}/></label>{lookupLoading&&<p role="status">Buscando…</p>}<label className="field">Registro que se vinculará<select required value={resolver.internalId} onChange={event=>setResolverField('internalId',event.target.value)}><option value="">Selecciona un registro existente</option>{lookup.map(item=><option key={item.id} value={item.id}>{item.number?`AN-${String(item.number).padStart(6,'0')} · `:''}{item.title||item.name||item.tracking||item.id}{item.presentation?` · ${item.presentation}`:''}</option>)}</select></label>{!lookupLoading&&!lookup.length&&<p>No se encontraron registros. Cambia la búsqueda o crea un producto real sin perder el lote.</p>}{resolver.action==='link_product'&&onCreateProduct&&<button type="button" className="button subtle" disabled={!!busy||!resolver.externalKey} onClick={createProduct}>Guardar lote y crear producto</button>}</>}
    {resolver.action==='status'&&<label className="field">Estado en All Nutrition<select required value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}><option value="">Selecciona el significado confirmado</option>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select><small className="muted">Estado sin identificar conserva la observación sin cambiar las finanzas.</small></label>}
    {resolver.action==='review_policy'&&<><p>Usa una regla histórica explícita. No se toma la fecha de carga ni se cambia la configuración general.</p><label className="field">Versión de regla aprobada<select required value={resolver.value} onChange={event=>setResolverField('value',event.target.value)}><option value="">Selecciona una regla existente</option>{rules.map(rule=><option key={rule.id} value={rule.id}>{rule.effectiveOn} · {rule.saleRecognition} · {rule.id}</option>)}</select></label>{!rules.length&&<p>No hay reglas disponibles. Configura una regla real en Configuración y retoma este lote.</p>}</>}
    {resolver.action==='review_authority'&&<><p>Autorizar una corrección de fuente o importe exige motivo y nueva revisión de consecuencias. No se borran movimientos existentes.</p><label className="field">ID del evento original que se rectifica (si aplica)<input maxLength={100} value={resolver.value.correctionOf||''} onChange={event=>setResolverField('value',event.target.value?{...resolver.value,correctionOf:event.target.value}:Object.fromEntries(Object.entries(resolver.value).filter(([key])=>key!=='correctionOf')))}/></label><label className="checkbox-field"><input type="checkbox" checked={!!resolver.value.allowCredit} onChange={event=>setResolverField('value',event.target.checked?{...resolver.value,allowCredit:true}:Object.fromEntries(Object.entries(resolver.value).filter(([key])=>key!=='allowCredit')))}/><span>Autorizar explícitamente saldo a favor del cliente si el importe confirmado excede su deuda.</span></label></>}
    {resolver.action==='commercial_update'&&<CommercialResolution api={api} value={resolver.value} group={groups.find(group=>groupKey(group)===resolver.entityKey)} onChange={value=>setResolverField('value',value)}/>}
    {resolver.action==='accept_formulas'&&<label className="checkbox-field"><input required type="checkbox" checked={resolver.value===true} onChange={event=>setResolverField('value',event.target.checked)}/><span>He revisado las fórmulas y acepto sus valores guardados. No se ejecutan ni recalculan; una fórmula necesaria sin valor guardado sigue siendo un error.</span></label>}
    {['duplicate','additional_quantity'].includes(resolver.action)&&<p>{resolver.action==='duplicate'?'Se excluirá esta repetición de fila; no se descontará un producto distinto.':'Se contará esta fila como unidades adicionales reales; revisa la cantidad agrupada antes de confirmar.'}</p>}
    <label className="field">Motivo de la resolución<input required={['review_policy','review_authority','commercial_update','omit_group','duplicate','additional_quantity'].includes(resolver.action)} maxLength={2000} value={resolver.reason} onChange={event=>setResolverField('reason',event.target.value)}/></label>
   </fieldset>
  </ResolutionDialog>}
  {batch?.fileHash&&<footer className="admin-actions" style={{marginTop:24}}>{!batch.fileDiscarded&&(batch.fileExpired?<p>Archivo original vencido. Se conserva su hash y el historial aplicado.</p>:<button type="button" className="button subtle" disabled={!!busy} onClick={()=>download('file')}>Descargar original privado</button>)}<button type="button" className="button subtle" disabled={!!busy||!(hasPreview||cancelled&&batch.rows?.total>0)} onClick={()=>download('errors')}>Descargar filas rechazadas XLSX</button>{!batch.fileDiscarded&&<p className="small muted">Original: 7 días si abandonas el lote, 90 días después de finalizar. La expiración no borra pedidos ni importes.</p>}</footer>}
 </section>;
}

function ResolutionDialog({title,busy,cancelling,onCancelImport,cancelLabel,onClose,onSubmit,children}){
 const dialog=useRef(null),titleId=useId();
 const close=useDialog(dialog,{busy,dirty:true,onClose});
 return <dialog ref={dialog} className={`editor-drawer ${styles.editor}`} aria-labelledby={titleId}>
  <header><h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>{title}</h2><button className="icon-button" type="button" aria-label="Cerrar resolución" disabled={busy} onClick={close}><Icon name="close"/></button></header>
  <form onSubmit={onSubmit} aria-busy={busy}>
   <div className="drawer-body">{children}</div>
   <footer className="editor-footer"><span role="status">{cancelling?'Cancelando importación…':busy?'Procesando…':'Resolución sin guardar'}</span>{onCancelImport&&<button className="button subtle" type="button" disabled={cancelling} onClick={onCancelImport}>{cancelLabel}</button>}<button className="button subtle" type="button" disabled={busy} onClick={close}>Cancelar resolución</button><button className="button primary" disabled={busy}>Preparar resolución</button></footer>
  </form>
 </dialog>;
}

function ResolutionActions({actions,disabled,onResolve}){
 return <div className={styles.resolutionGroups}>{RESOLUTION_GROUPS.map(group=>{
  const available=group.actions.filter(action=>actions.includes(action));
  return available.length>0&&<fieldset key={group.label} className={styles.resolutionGroup} disabled={disabled}><legend>{group.label}</legend><div className="admin-actions">{available.map(action=><button key={action} className="button subtle" type="button" onClick={()=>onResolve(action)}>{RESOLUTION_LABELS[action]}</button>)}</div></fieldset>;
 })}</div>;
}

function StatusMapping({config,disabled,onChange,statusDraft,setStatusDraft}){
 return <details><summary>Equivalencias de estados externos</summary><p>Escribe el estado exacto del archivo y confirma su significado en All Nutrition. Un estado sin equivalencia queda como Estado sin identificar: conserva la observación y no cambia las finanzas.</p>{Object.entries(config.statusMap||{}).map(([external,status])=><div className="order-line" key={external}><p>Identificador exacto del archivo: <strong>{external}</strong></p><label className="field">Estado en All Nutrition<select value={status} disabled={disabled} onChange={event=>onChange({...config.statusMap,[external]:event.target.value})}>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="button subtle" disabled={disabled} onClick={()=>onChange(Object.fromEntries(Object.entries(config.statusMap).filter(([key])=>key!==external)))}>Quitar equivalencia</button></div>)}<label className="field">Identificador exacto del archivo<input maxLength={300} value={statusDraft} disabled={disabled} onChange={event=>setStatusDraft(event.target.value)}/><small className="muted">Estado externo: copia el texto exacto de la celda; esta clave se guarda en statusMap.</small></label><button className="button subtle" type="button" disabled={disabled||!statusDraft.trim()} onClick={()=>{onChange({...config.statusMap,[statusDraft.trim()]:'unknown'});setStatusDraft('');}}>Añadir para revisar (sin identificar)</button></details>;
}
function SourceRows({batch,page,rowState,busy,onFilter,onPage,onResolve}){
 const rows=batch?.rows;if(!rows)return null;const list=records(rows),maxPage=Math.max(1,Math.ceil((rows.total||0)/(rows.pageSize||20)));
 return <details>
  <summary>Filas fuente y motivos ({rows.total||0})</summary>
  <label className="field">Filtrar filas<select value={rowState} disabled={busy} onChange={event=>onFilter(event.target.value)}><option value="">Todas</option>{['rejected','conflict','valid','applied','unchanged','omitted'].map(state=><option key={state} value={state}>{RESULT_LABELS[state]||state}</option>)}</select></label>
  {!list.length?<p>No hay filas para este filtro.</p>:list.map((row,index)=>{
   const cells=Array.isArray(row.source)?row.source:row.cells||row.source?.cells||[],tasks=row.task||row.tasks||[];
   return <article className="order-line" key={`${row.sheet}:${row.rowNumber}:${index}`}>
    <h4>{row.sheet} · fila {row.rowNumber}</h4><p>{RESULT_LABELS[row.state]||row.state} · {row.entityKey||row.groupKey}</p>
    {messages(row.errors).map((message,i)=><p className="error" key={i}>{message}</p>)}
    {messages(tasks).map((message,i)=><p key={i}>{message}</p>)}
    {row.reason&&<p>{row.reason}</p>}
    {cells.length>0&&<details><summary>Valores originales por posición</summary><dl>{cells.map((cell,i)=><div key={i}><dt>Columna {i+1}</dt><dd style={{marginLeft:0,overflowWrap:'anywhere'}}>{cellText(cell)||'(vacío)'}</dd></div>)}</dl></details>}
    {row.normalized?.lines?.length>0&&<details><summary>Productos normalizados de esta fila</summary><ul>{row.normalized.lines.map((line,i)=><li key={i}>{line.productExternalKey||line.itemId||'Sin vínculo'} · cantidad {line.quantity??'sin dato'} · {line.unitPriceMinor==null?'precio sin dato':`${(line.unitPriceMinor/100).toLocaleString('es-CO')} COP`}</li>)}</ul></details>}
    {onResolve&&row.state!=='applied'&&<ResolutionActions actions={ROW_RESOLUTIONS} disabled={busy} onResolve={action=>onResolve(action,row)}/>}
   </article>;
  })}
  <div className="admin-actions"><button type="button" className="button subtle" disabled={busy||page<=1} onClick={()=>onPage(page-1)}>Anterior</button><span>Página {page} de {maxPage}</span><button type="button" className="button subtle" disabled={busy||page>=maxPage} onClick={()=>onPage(page+1)}>Siguiente</button></div>
 </details>;
}

function CommercialResolution({api,value,group,onChange}){
 const [products,setProducts]=useState([]),[people,setPeople]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setError('');Promise.all([api('/api/admin/products'),api('/api/admin/combos'),api('/api/admin/business/people?active=1')]).then(([productData,comboData,personData])=>{if(active){setProducts([...records(productData).map(item=>({...item,kind:'products'})),...records(comboData).map(item=>({...item,kind:'combos'}))]);setPeople(records(personData));}}).catch(cause=>{if(active)setError(cause.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,attempt]);
 const set=(key,next)=>onChange({...value,[key]:next}),remove=key=>onChange(Object.fromEntries(Object.entries(value).filter(([field])=>field!==key))),has=key=>Object.hasOwn(value,key);
 const lineChange=(index,patch)=>set('items',(value.items||[]).map((line,i)=>i===index?{...line,...patch}:line));
 return <section aria-label="Datos comerciales explícitos">
  <p>Completa productos escritos como texto libre o autoriza datos comerciales concretos. Solo se envían los campos marcados; no se usan precios actuales del catálogo ni se cambian costos de productos.</p>
  <p className="small muted">Actualizar un pedido ya despachado no permite reescribir el acuerdo económico. El servidor comprueba su versión y estado en la nueva revisión.</p>
  {loading&&<p role="status">Cargando productos y vendedores reales…</p>}
  {error&&<div role="alert"><p className="error">{error}</p><button type="button" className="button subtle" onClick={()=>setAttempt(old=>old+1)}>Reintentar registros</button></div>}
  <div className="form-grid">{[['customerName','Nombre del destinatario'],['phone','Teléfono'],['department','Departamento'],['city','Ciudad'],['address','Dirección'],['placedOn','Fecha comercial del pedido']].map(([key,label])=><div key={key}><label className="checkbox-field"><input type="checkbox" checked={has(key)} onChange={event=>event.target.checked?set(key,''):remove(key)}/><span>Completar o cambiar {label.toLocaleLowerCase('es')}</span></label>{has(key)&&<label className="field">{label}<input type={key==='placedOn'?'date':'text'} required value={value[key]||''} maxLength={300} onChange={event=>set(key,event.target.value)}/></label>}</div>)}</div>
  <label className="checkbox-field"><input type="checkbox" checked={has('sellerId')} onChange={event=>event.target.checked?set('sellerId',null):remove('sellerId')}/><span>Asignar vendedor explícitamente</span></label>
  {has('sellerId')&&<label className="field">Vendedor<select value={value.sellerId||''} onChange={event=>set('sellerId',event.target.value||null)}><option value="">Sin vendedor</option>{people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>}
  <label className="checkbox-field"><input type="checkbox" checked={has('shippingChargeMinor')} onChange={event=>event.target.checked?set('shippingChargeMinor',null):remove('shippingChargeMinor')}/><span>Completar o cambiar flete cobrado al cliente</span></label>
  {has('shippingChargeMinor')&&<Field field={{name:'commercialShipping',label:'Flete cobrado COP',type:'moneyOptionalMinor',required:true}} value={value.shippingChargeMinor} onChange={amount=>set('shippingChargeMinor',amount)}/>}
  <label className="checkbox-field"><input type="checkbox" checked={has('items')} onChange={event=>event.target.checked?set('items',[{kind:'products',itemId:'',quantity:1,unitPriceMinor:null,discountMinor:0}]):remove('items')}/><span>Completar las líneas del pedido (lista completa revisada)</span></label>
  {has('items')&&<><p>Incluye todas las líneas que debe conservar el pedido, no solo las que faltaban. Precio y descuento son importes explícitos de este acuerdo.</p>{(value.items||[]).map((line,index)=><fieldset className="order-line" key={index}><legend>Línea {index+1}</legend><label className="field">Producto, obsequio o combo real<select required value={`${line.kind}:${line.itemId}`} onChange={event=>{const selected=products.find(product=>`${product.kind}:${product.id}`===event.target.value);lineChange(index,{kind:selected?.kind||'products',itemId:selected?.id||''});}}><option value={`${line.kind}:`}>Selecciona un registro</option>{products.map(product=><option key={`${product.kind}:${product.id}`} value={`${product.kind}:${product.id}`}>{product.title} · {product.presentation||product.kind}</option>)}</select></label><label className="field">Cantidad<input type="number" required min={1} max={999} step={1} value={line.quantity} onChange={event=>lineChange(index,{quantity:Number(event.target.value)})}/></label><div className="form-grid"><Field field={{name:`commercialPrice${index}`,label:'Precio unitario COP',type:'moneyOptionalMinor',required:true}} value={line.unitPriceMinor} onChange={amount=>lineChange(index,{unitPriceMinor:amount})}/><Field field={{name:`commercialDiscount${index}`,label:'Descuento total de línea COP',type:'moneyOptionalMinor',required:true}} value={line.discountMinor} onChange={amount=>lineChange(index,{discountMinor:amount})}/></div><details><summary>Conservar ID de línea existente</summary><label className="field">ID de línea (solo al corregir una línea existente)<input maxLength={100} value={line.lineId||''} onChange={event=>{const {lineId,...other}=line;lineChange(index,event.target.value?{lineId:event.target.value}:{...other,lineId:undefined});}}/></label></details><button type="button" className="button subtle" disabled={value.items.length===1} onClick={()=>set('items',value.items.filter((_,i)=>i!==index))}>Quitar línea {index+1}</button></fieldset>)}<button type="button" className="button subtle" onClick={()=>set('items',[...value.items,{kind:'products',itemId:'',quantity:1,unitPriceMinor:null,discountMinor:0}])}>Agregar línea real</button></>}
  <details>
    <summary>Distribuir cantidades entre guías (avanzado)</summary>
    <p>Úsalo cuando las filas no expliquen qué productos viajan en cada guía. No crea otra venta. Primero revisa las líneas para obtener sus identificadores estables.</p>
    <label className="checkbox-field"><input type="checkbox" checked={has('shipmentAssignments')} onChange={event=>event.target.checked?set('shipmentAssignments',[]):remove('shipmentAssignments')}/><span>Asignar explícitamente las cantidades por envío</span></label>
    {has('shipmentAssignments')&&<ShipmentAssignmentsResolution group={group} value={value.shipmentAssignments} onChange={next=>set('shipmentAssignments',next)}/>}
  </details>
 </section>;
}

function ShipmentAssignmentsResolution({group,value=[],onChange}){
 const lines=group?.lines||[];
 const guides=[...new Map((group?.units||[]).flatMap(unit=>unit.shipments||[]).map(shipment=>{
  const data=shipment.values||shipment;
  return [json([data.externalShipmentId||'',data.tracking||'']),{externalShipmentId:data.externalShipmentId||'',tracking:data.tracking||''}];
 })).values()];
 const change=(index,patch)=>onChange(value.map((shipment,i)=>i===index?{...shipment,...patch}:shipment));
 const quantity=(index,lineId,count)=>change(index,{assignments:[...(value[index].assignments||[]).filter(line=>line.lineId!==lineId),...(count>0?[{lineId,quantity:count}]:[])]});
 return <div>
  {!lines.length&&<p className="hint">Genera una revisión con las líneas comerciales completas antes de asignar cantidades a guías.</p>}
  {value.map((shipment,index)=><fieldset className="order-line" key={index}>
    <legend>Envío {index+1}</legend>
    {guides.length>0&&<label className="field">Guía observada en este grupo
      <select value={guides.findIndex(guide=>guide.externalShipmentId===shipment.externalShipmentId&&guide.tracking===shipment.tracking)} onChange={event=>{const guide=guides[Number(event.target.value)];if(guide)change(index,guide);}}>
        <option value={-1}>Escribir identificación exacta</option>
        {guides.map((guide,i)=><option key={i} value={i}>{guide.tracking||guide.externalShipmentId}</option>)}
      </select>
    </label>}
    <div className="form-grid">
      <label className="field">ID externo del envío (si existe)<input maxLength={300} value={shipment.externalShipmentId||''} onChange={event=>change(index,{externalShipmentId:event.target.value})}/></label>
      <label className="field">Guía exacta<input required={!shipment.externalShipmentId} maxLength={150} value={shipment.tracking||''} onChange={event=>change(index,{tracking:event.target.value})}/></label>
    </div>
    {lines.map(line=><label className="field" key={line.lineId}>{line.title||line.productExternalKey||line.itemId} · línea {line.lineId}
      <input type="number" min={0} max={Number.isInteger(line.quantity)?line.quantity:999} step={1} value={(shipment.assignments||[]).find(item=>item.lineId===line.lineId)?.quantity||0} onChange={event=>quantity(index,line.lineId,Number(event.target.value))}/>
    </label>)}
    <button type="button" className="button subtle" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>Quitar envío {index+1}</button>
  </fieldset>)}
  <button type="button" className="button subtle" disabled={!lines.length} onClick={()=>onChange([...value,{externalShipmentId:'',tracking:'',assignments:[]}])}>Agregar asignación de guía</button>
  <ul aria-live="polite">{lines.map(line=>{
    const assigned=value.reduce((sum,shipment)=>sum+(shipment.assignments||[]).filter(item=>item.lineId===line.lineId).reduce((sum,item)=>sum+item.quantity,0),0);
    return <li className={assigned>line.quantity?'error':undefined} key={line.lineId}>{line.title||line.productExternalKey||line.itemId}: {assigned} de {line.quantity} unidades asignadas{assigned>line.quantity?' · excede lo comprado':''}</li>;
  })}</ul>
 </div>;
}
