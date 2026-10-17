'use client';
import { useState,useEffect,useCallback,useRef,useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { schemas,settingsFields,emptyRecord,contentStates } from '@/lib/schema.mjs';
import { adminSections,readAdminView,adminHref,adminReturnTo } from '@/lib/admin-view.mjs';
import { Field } from './Fields';
import RecordEditor from './RecordEditor';
import OrderEditor from './OrderEditor';
import Icon from './Icons';
import UserManagement from './UserManagement';
import AdminNavigation,{ AreaNavigation } from './AdminNavigation';
import AdminOverview from './AdminOverview';
import { ContentList } from './AdminLists';
import OrdersWorkspace from './OrdersWorkspace';
import ReportsWorkspace from './ReportsWorkspace';
import BusinessActionDialog from './BusinessActionDialog';
import CashWorkspace from './CashWorkspace';
import BusinessSettings from './BusinessSettings';
import ConfigurationNavigation from './ConfigurationNavigation';
import { adminTasks,isCurrentAdminTask } from './admin-tasks.mjs';
import configurationStyles from './ConfigurationExperience.module.css';
const contentKeys=Object.keys(schemas);
const initialResources=()=>Object.fromEntries(contentKeys.map(key=>[key,{records:null,loading:false,error:''}]));
const blankResource=()=>({data:null,loading:false,error:''});
const editorDependencies={products:['products','catalogs'],combos:['products','catalogs'],orders:['products','combos']};
const settingsGroups=[
 {key:'identity',title:'Identidad de la marca',action:'Editar identidad',description:'Nombre, eslogan y logo que se muestran en la vitrina.',fields:['brandName','tagline','logo']},
 {key:'contact',title:'Contacto y redes',action:'Editar contacto',description:'Canales públicos para conversar con tus clientes. No compartas contraseñas de tus redes.',fields:['whatsapp','whatsappTemplate','facebook','instagram','email','hours']},
 {key:'payment',title:'Información de pago',action:'Editar pagos',description:'Explica cómo pueden pagar tus clientes. Este texto no conecta pasarelas ni registra cobros.',fields:['paymentInfo']},
 {key:'publication',title:'Publicación de la vitrina',action:'Revisar publicación',description:'Decide si la web muestra los contenidos publicados o la página de preparación. Los cambios se aplican al guardar.',fields:['launchApproved','showNextStage']}
];
const settingsHelp={whatsapp:'Por ejemplo, 573001234567. Incluye el código de país, sin + ni espacios.',whatsappTemplate:'Escribe {producto} donde deba aparecer la referencia que consulta el cliente.',showNextStage:'Esta orientación solo aparece dentro del panel, no en la página pública.'};
const settingsFieldByName=new Map(settingsFields.map(field=>[field.name,{...field,description:settingsHelp[field.name]}]));
export default function Admin({csrf,user}) {
 const params=useSearchParams();
 const [view,setView]=useState(()=>readAdminView(params));
 const [resources,setResources]=useState(initialResources),[settingsResource,setSettingsResource]=useState(blankResource),[ordersResource,setOrdersResource]=useState(blankResource),[cashAction,setCashAction]=useState(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[query,setQueryInput]=useState(view.q),[editing,setEditing]=useState(null),[opening,setOpening]=useState(null),[busy,setBusy]=useState(false),[interaction,setInteraction]=useState({dirty:false,busy:false}),[userRevision,setUserRevision]=useState(0);
 const [workspaceInteraction,setWorkspaceInteraction]=useState({dirty:false,busy:false}),[businessRevision,setBusinessRevision]=useState(0),[workspaceEpoch,setWorkspaceEpoch]=useState(0);
 const accepted=useRef(view),settingsSnapshot=useRef(''),searchTimer=useRef(null),searchGeneration=useRef(0),navigationHandler=useRef(null),guardState=useRef(null),reads=useRef({}),inFlight=useRef({}),openingSequence=useRef(0),resourcesRef=useRef(resources);
 const auxiliaryProduct=useRef(null);
 const historyPosition=useRef(null),historyRestoring=useRef(false);
 const writeHistory=useCallback((href,{replace=false}={})=>{
  const previousState=window.history.state,stored=previousState?.allNutritionAdminIndex;
  const current=historyPosition.current??(Number.isSafeInteger(stored)?stored:0),next=replace?current:current+1;
  historyPosition.current=next;
  // Let Next synchronize the URL, then retain framework state even before its history patch mounts.
  window.history[replace?'replaceState':'pushState'](null,'',href);
  window.history.replaceState({...previousState,...window.history.state,allNutritionAdminIndex:next},'',href);
 },[]);
 const editorInteractionRef=useRef(interaction),workspaceInteractionRef=useRef(workspaceInteraction);
 const settings=settingsResource.data;
 const all=useMemo(()=>Object.fromEntries(contentKeys.filter(key=>resources[key].records!==null).map(key=>[key,resources[key].records])),[resources]);
 const setSettings=value=>setSettingsResource(previous=>({...previous,data:typeof value==='function'?value(previous.data):value}));
 const updateContent=useCallback((kind,patch)=>{const next={...resourcesRef.current,[kind]:{...resourcesRef.current[kind],...patch}};resourcesRef.current=next;setResources(next);},[]);
 const section=view.section;
 const sectionInfo=adminSections.find(item=>item.id===section),sectionLabel=sectionInfo?.label;
 const isConfiguration=sectionInfo?.area==='business',configurationTab=isConfiguration?view.tab:undefined;
 const configurationTask=isConfiguration?adminTasks.find(task=>isCurrentAdminTask(task,view)):null;
 const configurationHome=isConfiguration&&section==='business'&&(!view.tab||view.tab==='setup');
 const settingsDirty=Boolean(settings&&JSON.stringify(settings)!==settingsSnapshot.current);
 guardState.current={rootBusy:busy,settingsDirty:section==='settings'&&settingsDirty,busy:busy||editorInteractionRef.current.busy||workspaceInteractionRef.current.busy,dirty:editorInteractionRef.current.dirty||workspaceInteractionRef.current.dirty||(section==='settings'&&settingsDirty)};
 const syncGuard=useCallback(()=>{
  const state=guardState.current;
  state.busy=Boolean(state.rootBusy||editorInteractionRef.current.busy||workspaceInteractionRef.current.busy);
  state.dirty=Boolean(state.settingsDirty||editorInteractionRef.current.dirty||workspaceInteractionRef.current.dirty);
 },[]);
 const reportInteraction=useCallback(state=>{editorInteractionRef.current=state;setInteraction(state);syncGuard();},[syncGuard]);
 const reportWorkspaceInteraction=useCallback(state=>{workspaceInteractionRef.current=state;setWorkspaceInteraction(state);syncGuard();},[syncGuard]);
 const businessChanged=useCallback(()=>setBusinessRevision(value=>value+1),[]);
 const api=useCallback(async(path,options={})=>{
  const {responseType='json',...init}=options,headers=new Headers(init.headers);
  headers.set('x-csrf-token',csrf);
  if(typeof init.body==='string'&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch(path,{...init,cache:'no-store',headers});
  if(response.status===401){window.location.assign('/admin/login?next='+encodeURIComponent(adminReturnTo(window.location.pathname+window.location.search)));const cause=new Error('Sesión vencida.');cause.status=401;throw cause;}
  const isJSON=(response.headers.get('content-type')||'').includes('application/json');
  if(!response.ok){
   const data=isJSON?await response.json():null,cause=new Error(data?.error||'No se pudo completar la operación.');
   cause.status=response.status;throw cause;
  }
  if(responseType==='blob'){
   if(isJSON){const data=await response.json();throw new Error(data.error||'El servidor no devolvió el archivo esperado.');}
   return response.blob();
  }
  if(!isJSON)throw new Error('El servidor no devolvió una respuesta JSON válida.');
  return response.json();
 },[csrf]);
 const loadContent=useCallback((kind,afterSave=false)=>{
  const sequence=reads.current[kind]=(reads.current[kind]||0)+1;
  updateContent(kind,{loading:true,error:''});
  const pending=(async()=>{try{
   const data=await api('/api/admin/'+kind);
   if(sequence===reads.current[kind])updateContent(kind,{records:data.records,loading:false,error:''});
   return data.records;
  }catch(cause){
   if(sequence===reads.current[kind])updateContent(kind,{loading:false,error:afterSave?'El cambio se guardó, pero no pudimos actualizar esta vista. '+cause.message:cause.message});
   throw cause;
  }finally{if(inFlight.current[kind]===pending)delete inFlight.current[kind];}})();
  inFlight.current[kind]=pending;
  return pending;
 },[api,updateContent]);
 const loadSettings=useCallback(async()=>{
  const sequence=reads.current.settings=(reads.current.settings||0)+1;
  setSettingsResource(previous=>({...previous,loading:true,error:''}));
  try{const data=await api('/api/admin/settings');if(sequence===reads.current.settings){setSettingsResource({data,loading:false,error:''});settingsSnapshot.current=JSON.stringify(data);}}
  catch(cause){if(sequence===reads.current.settings)setSettingsResource(previous=>({...previous,loading:false,error:cause.message}));}
 },[api]);
 const loadOrders=useCallback(async(target,{afterSave=false,corrected=false}={})=>{
  const key='orders:list';
  const sequence=reads.current[key]=(reads.current[key]||0)+1;
  const update=patch=>setOrdersResource(previous=>({...previous,...patch}));
  update({loading:true,error:''});
  try{
   const q=new URLSearchParams({page:String(target.page||1),q:target.q||'',status:target.status||'',paymentStatus:target.paymentStatus||''});
   for(const key of ['seller','platform','source','carrier','account','product','issue'])if(target[key])q.set(key,target[key]);
   const data=await api('/api/admin/orders?'+q);
   if(sequence!==reads.current[key])return;
   const maximum=Math.max(1,Math.ceil(data.total/data.pageSize));
   if((target.page||1)>maximum&&!corrected){
    const next=readAdminView({...target,section:'orders',page:maximum});
    if(accepted.current.section==='orders'&&adminHref(accepted.current)===adminHref(target)){
     accepted.current=next;setView(next);setQueryInput(next.q);writeHistory(adminHref(next),{replace:true});
    }else void loadOrders(next,{afterSave,corrected:true});
    return;
   }
   if(sequence===reads.current[key])update({data,loading:false,error:''});
  }catch(cause){if(sequence===reads.current[key])update({loading:false,error:afterSave?'El cambio se guardó, pero no pudimos actualizar esta vista. '+cause.message:cause.message});}
 },[api,writeHistory]);
 useEffect(()=>{
  if(schemas[section])void loadContent(section).catch(()=>{});
  if(section==='settings')void loadSettings();
 },[section,loadContent,loadSettings]);
 useEffect(()=>{
  if(section==='orders'&&(!view.tab||view.tab==='list'))void loadOrders(view);
  return()=>{reads.current['orders:list']=(reads.current['orders:list']||0)+1;};
 },[section,view.tab,view.q,view.status,view.paymentStatus,view.page,view.seller,view.platform,view.source,view.carrier,view.account,view.product,view.issue,businessRevision,loadOrders]);
 function cancelSearch(){clearTimeout(searchTimer.current);searchGeneration.current++;}
 function allowExit(){
  if(guardState.current.busy){setError('Espera a que termine el guardado o la subida.');return false;}
  if(guardState.current.dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y continuar?'))return false;
  if(guardState.current.dirty){if(settingsSnapshot.current)setSettings(JSON.parse(settingsSnapshot.current));setUserRevision(n=>n+1);if(workspaceInteractionRef.current.dirty)setWorkspaceEpoch(n=>n+1);}
  setEditing(null);setCashAction(null);reportInteraction({dirty:false,busy:false});reportWorkspaceInteraction({dirty:false,busy:false});guardState.current={rootBusy:false,settingsDirty:false,dirty:false,busy:false};
  return true;
 }
 function acceptView(candidate,{replace=false,fromHistory=false,check=true}={}) {
  cancelSearch();
  const next=readAdminView(candidate),href=adminHref(next);
  if(check&&!allowExit())return false;
  openingSequence.current++;setOpening(null);
  accepted.current=next;setView(next);setQueryInput(next.q);setError('');setNotice('');
  if(!fromHistory)writeHistory(href,{replace});
  return true;
 }
 navigationHandler.current=()=>acceptView(new URLSearchParams(window.location.search),{fromHistory:true});
 useEffect(()=>{
  if(historyPosition.current===null)writeHistory(adminHref(accepted.current),{replace:true});
  const pop=event=>{
   if(historyRestoring.current){historyRestoring.current=false;event.stopImmediatePropagation();return;}
   const previous=historyPosition.current,target=event.state?.allNutritionAdminIndex;
   if(navigationHandler.current()){
    historyPosition.current=Number.isSafeInteger(target)?target:0;
    if(!Number.isSafeInteger(target)&&window.location.pathname==='/admin')writeHistory(adminHref(accepted.current),{replace:true});
   }else{
    event.stopImmediatePropagation();
    // Restore the traversed entry; replacing its URL would erase the previous destination.
    historyRestoring.current=true;
    window.history.go(Number.isSafeInteger(target)&&target!==previous?previous-target:1);
   }
  };
  window.addEventListener('popstate',pop,true);
  return()=>{window.removeEventListener('popstate',pop,true);clearTimeout(searchTimer.current);};
 },[writeHistory]);
 const paramString=params.toString();
 useEffect(()=>{
  if(historyRestoring.current)return;
  if(paramString!==new URLSearchParams(window.location.search).toString())return;
  const next=readAdminView(params),href=adminHref(next);
  if(href!==adminHref(accepted.current)){if(!navigationHandler.current())writeHistory(adminHref(accepted.current),{replace:true});}
  else if(window.location.pathname+window.location.search!==href)writeHistory(href,{replace:true});
 },[paramString,writeHistory]);
 useEffect(()=>{document.querySelector('[data-admin-section-heading]')?.focus();},[section,configurationTab]);
 useEffect(()=>{
  if(!configurationTask)return;
  const previous=document.title;
  document.title=(configurationHome?'Configuración':configurationTask.label+' · Configuración')+' | All Nutrition';
  return()=>{document.title=previous;};
 },[configurationTask,configurationHome]);
 useEffect(()=>{const unload=event=>{if(guardState.current.dirty||guardState.current.busy){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
 const navigate=key=>acceptView(typeof key==='string'?{section:key}:key);
 function setQuery(value){setQueryInput(value);cancelSearch();const generation=searchGeneration.current;searchTimer.current=setTimeout(()=>{if(searchGeneration.current===generation)acceptView({...accepted.current,q:value,page:1},{replace:true,check:false});},200);}
 function changeView(patch){
  if(Object.keys(patch).length===1&&Object.hasOwn(patch,'q')){setQuery(patch.q);return;}
  const resetsPage=query!==accepted.current.q||['q','status','paymentStatus','period','anchor','issue','tab','seller','platform','source','carrier','account','product','productType'].some(key=>Object.hasOwn(patch,key));
  acceptView({...accepted.current,q:query,...patch,...(resetsPage?{page:1}:{})});
 }
 async function openEditor(kind,record){
  if(!allowExit())return false;
  if(query!==accepted.current.q)acceptView({...accepted.current,q:query,page:1},{replace:true,check:false});
  else cancelSearch();
  const sequence=++openingSequence.current,origin=accepted.current.section;
  setOpening({kind,record,loading:true,error:''});
  try{
   await Promise.all((editorDependencies[kind]||[]).map(async key=>{
    if(kind!=='orders'&&resourcesRef.current[key].records!==null&&!resourcesRef.current[key].error)return;
    try{await (inFlight.current[key]||loadContent(key));}catch(cause){throw new Error('No pudimos cargar '+schemas[key].label.toLowerCase()+'. '+cause.message);}
   }));
   const detail=record?.id?await api('/api/admin/'+kind+'/'+encodeURIComponent(record.id)):record;
   if(sequence!==openingSequence.current||origin!==accepted.current.section)return false;
   if(!allowExit()){setOpening(null);return false;}
   setOpening(null);setEditing({kind,record:detail||(kind==='orders'?null:emptyRecord(kind)),revision:0});
   return true;
  }catch(cause){if(sequence===openingSequence.current&&origin===accepted.current.section)setOpening({kind,record,loading:false,error:cause.message});}
 }
 async function configureCash(){
  if(!allowExit())return;setBusy(true);setError('');
  try{const data=await api('/api/admin/business/accounts');setCashAction({action:'account-save',context:{account:data.records.find(account=>account.active)||null}});}
  catch(cause){setError(cause.message);}finally{setBusy(false);}
 }
 useEffect(()=>{
  if(view.record&&(schemas[section]||section==='orders'&&(!view.tab||view.tab==='list')))void openEditor(section,{id:view.record});
 },[section,view.tab,view.record]);
 async function createProductForImport(){
  if(!await openEditor('products',null))return null;
  return new Promise(resolve=>{auxiliaryProduct.current=resolve;});
 }
 async function saved({kind,record,operation,keepOpen=false}){
  if(!keepOpen){setEditing(null);reportInteraction({dirty:false,busy:false});}
  if(!keepOpen&&accepted.current.section===kind&&accepted.current.record)acceptView({...accepted.current,record:''},{replace:true,check:false});
  if(kind==='products'&&auxiliaryProduct.current){auxiliaryProduct.current(record);auxiliaryProduct.current=null;}
  businessChanged();
  if(kind==='orders'){
   setNotice('Pedido AN-'+String(record.number).padStart(6,'0')+' guardado');
   if(accepted.current.section==='orders')void loadOrders(accepted.current,{afterSave:true});
   await Promise.all(['products','combos'].map(key=>loadContent(key,true)));
  }else{
   setNotice(operation==='delete'?'Eliminado: '+record.title:'Guardado: '+record.title+' · '+contentStates.find(state=>state.value===record.status)?.label);
   if(accepted.current.section===kind)void loadContent(kind,true).catch(()=>{});
   else updateContent(kind,{records:null,loading:false,error:''});
  }
 }
 async function saveSettings(event){event.preventDefault();setBusy(true);setError('');try{const current=await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(settings)});setSettings(current);settingsSnapshot.current=JSON.stringify(current);setNotice('Configuración guardada.');}catch(cause){setError(cause.message);}finally{setBusy(false);}}
 function retry(key){if(key==='settings')void loadSettings();else void loadContent(key).catch(()=>{});}
 async function signOut(){if(!allowExit())return;setBusy(true);try{await api('/api/auth/logout',{method:'POST'});setBusy(false);guardState.current={dirty:false,busy:false};window.location.assign('/admin/login');}catch(cause){setError(cause.message);setBusy(false);}}
 const closeEditor=()=>{openingSequence.current++;setEditing(null);reportInteraction({dirty:false,busy:false});if(accepted.current.record&&(schemas[accepted.current.section]||accepted.current.section==='orders'&&(!accepted.current.tab||accepted.current.tab==='list')))acceptView({...accepted.current,record:''},{replace:true,check:false});if(auxiliaryProduct.current){auxiliaryProduct.current(null);auxiliaryProduct.current=null;}};
 async function reloadEditor(){
  if(!editing?.record?.id||guardState.current.busy)return false;
  if(guardState.current.dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y cargar la versión guardada?'))return false;
  const current=editing,sequence=++openingSequence.current;
  const record=await api('/api/admin/'+current.kind+'/'+encodeURIComponent(current.record.id));
  if(sequence!==openingSequence.current)return false;
  if(current.kind!=='orders'&&resourcesRef.current[current.kind].records!==null)updateContent(current.kind,{records:resourcesRef.current[current.kind].records.map(row=>row.id===record.id?record:row)});
  setEditing({...current,record,revision:current.revision+1});
  return true;
 }
 return <div className="admin-shell">
  <AdminNavigation view={view} user={user} onNavigate={navigate} onCreate={kind=>openEditor(kind,null)} onSignOut={signOut} interactionLocked={Boolean(editing)||Boolean(cashAction)||busy||interaction.busy||workspaceInteraction.busy}/>
  <div className={`admin-main${isConfiguration?' '+configurationStyles.viewport:''}`}><main className="admin-content" id="admin-workspace" tabIndex={-1}>
   {!['home','reports','cash'].includes(section)&&<div className="admin-heading"><div><p className="eyebrow">{isConfiguration?(configurationHome?'Administración':'Configuración'):'Mesa de trabajo'}</p><h1 tabIndex="-1" data-admin-section-heading>{configurationHome?'Configuración':section==='settings'?'Datos y publicación de la vitrina':configurationTask?.label||sectionLabel}</h1><p>{configurationHome?'Todo lo que necesitas para organizar el negocio, mantener tu vitrina y gestionar el acceso.':configurationTask?.description||schemas[section]?.help||(section==='orders'?'Pedidos, envíos y cobros acordados.':'Gestiona los datos de tu negocio.')}</p></div></div>}
   {error&&<div className="error alert" role="alert">{error}<button type="button" className="icon-button" aria-label="Cerrar error" onClick={()=>setError('')}><Icon name="close"/></button></div>}
   {notice&&<div className="success alert" role="status"><Icon name="check"/>{notice}<button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={()=>setNotice('')}><Icon name="close"/></button></div>}
   {opening&&<div className="admin-action-feedback" aria-busy={opening.loading}>{opening.loading?<p role="status">Preparando {opening.record?.title||opening.record?.customerName||'el editor'}…</p>:<div className="error" role="alert">{opening.error}<button type="button" className="text-button" onClick={()=>openEditor(opening.kind,opening.record)}>Reintentar apertura</button></div>}</div>}
   {isConfiguration?<ConfigurationNavigation view={view} onNavigate={navigate} interactionLocked={busy||interaction.busy||workspaceInteraction.busy}/>:<AreaNavigation view={view} onNavigate={navigate} interactionLocked={busy||interaction.busy||workspaceInteraction.busy}/>}
   {section==='home'&&<AdminOverview api={api} view={view} onViewChange={changeView} onCreateOrder={()=>openEditor('orders',null)} onImport={()=>navigate({section:'orders',tab:'imports'})} onCreateProduct={()=>openEditor('products',null)} onConfigureCash={configureCash} onNavigate={navigate} onOpenOrder={id=>openEditor('orders',{id})} revision={businessRevision}/>}
   {section==='settings'&&<div aria-busy={settingsResource.loading}>{settingsResource.loading&&<p role="status">{settings?'Actualizando…':'Cargando configuración…'}</p>}{!settings&&settingsResource.loading&&<div className="static-skeleton" aria-hidden="true"/>}{settingsResource.error&&<div className="error" role="alert">{settingsResource.error}<button type="button" className="text-button" onClick={()=>retry('settings')}>Reintentar</button></div>}</div>}
   {schemas[section]&&<ContentList kind={section} resource={resources[section]} view={{...view,q:query}} onViewChange={changeView} onCreate={kind=>openEditor(kind,null)} onEdit={openEditor} onRetry={()=>retry(section)}/>}
   {section==='orders'&&<OrdersWorkspace key={'orders:'+workspaceEpoch} api={api} resource={ordersResource} view={{...view,q:query}} onViewChange={changeView} onCreate={kind=>openEditor(kind,null)} onEdit={openEditor} onRetry={()=>loadOrders(accepted.current)} onInteractionStateChange={reportWorkspaceInteraction} onCreateProduct={createProductForImport} onMutation={businessChanged}/>}
   {section==='reports'&&<ReportsWorkspace key={'reports:'+workspaceEpoch} api={api} view={view} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision}/>}
   {section==='cash'&&<CashWorkspace key={'cash:'+workspaceEpoch} api={api} view={{...view,q:query}} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onNavigate={navigate} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision}/>}
   {section==='business'&&<BusinessSettings key={'business:'+workspaceEpoch} api={api} view={{...view,q:query}} onViewChange={changeView} onOpenOrder={id=>openEditor('orders',{id})} onNavigate={navigate} onInteractionStateChange={reportWorkspaceInteraction} onMutation={businessChanged} revision={businessRevision}/>}
   {section==='settings'&&settings&&<form className={`settings-form ${configurationStyles.vitrinaForm}`} onSubmit={saveSettings} aria-busy={busy} aria-describedby="vitrina-form-help">
    <div className={configurationStyles.formIntro}><div><strong>{settings.launchApproved?'Publicación seleccionada: vitrina visible':'Publicación seleccionada: modo preparación'}</strong><p id="vitrina-form-help">Revisa los datos y confirma con «Guardar configuración». No hay guardado automático.</p></div></div>
    <nav className={configurationStyles.formIndex} aria-label="Secciones de datos de la vitrina">{settingsGroups.map((group,index)=><button type="button" className="button subtle" key={group.key} onClick={()=>{const heading=document.getElementById(`settings-${group.key}`);heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start'});}}><span aria-hidden="true">{index+1}</span>{group.action}</button>)}</nav>
    <fieldset className="auth-fieldset" disabled={busy}>
     {settingsGroups.map(group=><section className="settings-group" key={group.key} aria-labelledby={`settings-${group.key}`}>
      <h2 id={`settings-${group.key}`} tabIndex={-1}>{group.title}</h2><p className={configurationStyles.groupDescription}>{group.description}</p>
      <div className="settings-fields">{group.fields.map(name=><div className={`settings-field settings-field--${name}`} key={name}><Field field={settingsFieldByName.get(name)} value={settings[name]} onChange={value=>setSettings(previous=>({...previous,[name]:value}))} all={all} api={api}/></div>)}</div>
      {group.key==='contact'&&<div className="whatsapp-preview" aria-labelledby="whatsapp-preview-title"><h3 id="whatsapp-preview-title">Mensaje de ejemplo</h3><p>{String(settings.whatsappTemplate||'').replaceAll('{producto}','producto de ejemplo')}</p><small>Solo es texto de ejemplo: no se envía ni responde automáticamente. {'{producto}'} se sustituye por la referencia al abrir la consulta en la vitrina.</small></div>}
      {group.key==='publication'&&<p className="small muted">Al guardar con «Publicar la vitrina» activado, la página pública mostrará los contenidos publicados y guardados. Desactivarlo vuelve a mostrar la preparación. No publica borradores, compra un dominio ni conecta pagos.</p>}
     </section>)}
     <div className="settings-save-bar"><span className="small" role="status">{busy?'Guardando configuración…':settingsDirty?'Cambios sin guardar':'Configuración al día'}</span><button type="submit" className="button primary">{busy?'Guardando…':'Guardar configuración'}<Icon name="check" size={16}/></button></div>
    </fieldset>
   </form>}
 {section==='users'&&<UserManagement key={userRevision} api={api} onInteractionStateChange={reportInteraction} />}
 </main></div>
 {editing&&editing.kind!=='orders'&&<RecordEditor key={editing.kind+':'+(editing.record.id||'new')+':'+editing.revision} kind={editing.kind} record={editing.record} all={all} api={api} onClose={closeEditor} onSaved={saved} onReload={reloadEditor} onInteractionStateChange={reportInteraction}/>}
 {editing?.kind==='orders'&&<OrderEditor key={(editing.record?.id||'new-order')+':'+editing.revision} record={editing.record} all={all} api={api} onClose={closeEditor} onSaved={saved} onReload={reloadEditor} onInteractionStateChange={reportInteraction}/>}
 {cashAction&&<BusinessActionDialog action={cashAction.action} context={cashAction.context} api={api} onClose={()=>{setCashAction(null);reportInteraction({dirty:false,busy:false});}} onSaved={record=>{setCashAction(null);reportInteraction({dirty:false,busy:false});businessChanged();setNotice('Cuenta '+record.name+' guardada.'+(record.warnings?.length?' '+record.warnings.join(' '):''));}} onInteractionStateChange={reportInteraction}/>}
 </div>;
}
