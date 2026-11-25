'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { validateAssistantSettings, validateProposalDTO, validateTurnResult, validateAssistantTurnStatus, validateAssistantReadPage, validateAssistantReceipt } from '../lib/assistant/contracts.mjs';
import { assistantFieldLabel, formatAssistantChangeValue } from '../lib/assistant/forms.mjs';
import { useAssistantBridge } from './AssistantBridge.jsx';
import { AdvisorActionCard } from './AdvisorDirectory.jsx';
import AliIntentionPicker from './AliIntentionPicker.jsx';
import { adminLocationLabel } from './admin-tasks.mjs';
import { adminHref, readAdminView } from '../lib/admin-view.mjs';
import useDialog from './useDialog.js';
import styles from './AssistantConsole.module.css';

const fingerprint = value => JSON.stringify(value, function(key,item){return item && typeof item==='object' && !Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item;});
const phaseLabels={planning:'Preparar consulta',reading:'Consultar datos',analyzing:'Analizar',answering:'Responder',done:'Finalizado'};
const turnLabels={running:'En curso',completed:'Completado',failed:'Interrumpido',cancelled:'Detenido'};
const phases=['planning','reading','analyzing','answering'];
const threadURL=id=>`/api/admin/assistant/threads/${encodeURIComponent(id)}`;
const turnURL=id=>`/api/admin/assistant/turns/${encodeURIComponent(id)}`;
const dateLabel=new Intl.DateTimeFormat('es',{dateStyle:'short',timeStyle:'short'});
const formatDate=value=>value&&Number.isFinite(Date.parse(value))?dateLabel.format(new Date(value)):null;
const threadTitle=row=>row?.data?.title||row?.title||'Conversación';
const threadIdOf=value=>value?.thread?.id||value?.id||null;
const emptyScope=()=>({id:null,ready:true});
const waitForAdvance=()=>new Promise(resolve=>setTimeout(resolve,1000));
const uid = () => globalThis.crypto?.randomUUID?.() || `ali-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const quickStarts=[
  {label:'Revisar pendientes',message:'¿Qué tareas o seguimientos debería atender primero en esta sección?'},
  {label:'Recomendar próximos pasos',message:'Con lo que sabes de este negocio, ¿qué debería revisar o hacer después?'},
  {label:'Explicar esta sección',message:'Explícame qué puedo hacer aquí y cómo empezar.'},
];
const resultControls=new Map([
  ['assistant.read-records','registros consultados'],['assistant.sources','fuentes'],
  ['assistant.proposal-review','detalle de la propuesta'],['assistant.proposal-form','formulario de la propuesta'],
  ['assistant.proposal-apply','valores de la propuesta'],['assistant.proposal-rebase','revisión de la propuesta'],
  ['assistant.proposal-confirm','confirmación de la propuesta'],['assistant.proposal-cancel','cancelación de la propuesta'],
  ['assistant.receipt','comprobante guardado'],['assistant.thread-follow-up','objetivo y siguientes pasos'],
  ['assistant.answer-question','respuesta pendiente'],['assistant.extend-analysis','ampliación del análisis'],['assistant.context-destination','destino contextual'],
  ['assistant.continue-running','continuación del turno'],['assistant.stop-analysis','detención del turno'],
]);
const activeWorkControls=new Set(['assistant.continue-running','assistant.stop-analysis']);
const consoleControls=['assistant.open-console','assistant.suggested-message','assistant.ask','assistant.literal-draft'];
const topicLabels={catalog:'Catálogo',orders:'Pedidos',shipments:'Envíos',cash:'Caja',reports:'Informes',recommendations:'Recomendaciones',business:'Configuración',alerts:'Alertas',imports:'Importaciones',advertising:'Publicidad',access:'Accesos',application:'Uso de la aplicación'};
const rows = value => Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : Array.isArray(value?.threads) ? value.threads : [];
const displayValue = value => value == null ? 'Sin dato' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const bindingFor = form => form ? ({ formId:form.formId,target:form.target,entityId:form.entityId,recordVersion:form.recordVersion,generation:form.generation }) : null;
const historyCursor = value => value?.pagination?.before ?? value?.pagination?.nextBefore ?? value?.nextBefore ?? null;
const historyMore = value => Boolean(value?.pagination?.hasMore ?? value?.hasMore);
const proposalPending = proposal => ['prepared','applied'].includes(proposal?.state);
const advisorCommands = {
  'campaign-duplicate': { title:'Duplicar como borrador', confirm:'Confirmar duplicación', prompt:'¿Crear el borrador a partir de la campaña revisada?', review:'Revisa el origen y su versión. Se creará un borrador sin publicar ni activar gasto.' },
  'report-snapshot': { title:'Solicitar copia del informe', confirm:'Confirmar solicitud', prompt:'¿Solicitar la copia con el período y los filtros revisados?', review:'Confirma la consulta que se enviará. Recibir la solicitud aún no significa que la copia esté lista.' },
};
const isCopyRequest = receipt => receipt.operation==='request-copy';
const duplicateSourceBlocked = (proposal,form) => proposal.target==='campaign-duplicate'&&form.target==='campaign-draft'&&form.entityId===proposal.entityId&&(form.dirty||form.busy);
function internalView(href) {
  if (typeof href!=='string' || href.split('?',1)[0]!=='/admin' || /[#\\\u0000-\u0020\u007f]/.test(href)) return null;
  const params=new URLSearchParams(href.includes('?')?href.slice(href.indexOf('?')+1):'');
  const next=readAdminView(params);
  return !params.has('section') || params.get('section')===next.section ? next : null;
}
const safeHref = href => { const next=internalView(href); return next ? adminHref(next) : undefined; };

function publicTurns(value) {
  const turns = Array.isArray(value?.turns) ? value.turns : Array.isArray(value?.records) ? value.records : [];
  return turns.flatMap(turn => {
    const data=turn?.data || turn;
    const rawResult=data?.result || data?.publicResult || data?.response;
    const result=rawResult?.blocks ? validateTurnResult(rawResult) : null;
    const message=data?.message || data?.input?.message;
    const key=result?.turnId || turn.id;
    return [
      ...((message||turn.state) ? [{key:`turn-${key}-user`,turnId:key,role:'user',text:message,state:turn.state,startedAt:turn.startedAt,visitedPhases:turn.visitedPhases}] : []),
      ...(result ? [{key:`turn-${key}`,role:'assistant',result}] : []),
    ];
  });
}

export default function AssistantConsole({ api, view, onNavigate, onReminderRequest, advisorReady, onAdvisorTaskRequest, onAdvisorAction, onAdvisorDirectory, onAdvisorTasks, onAdvisorPreferences, advisorTaskId, onClearAdvisorTask, brandName, open = false, catalogConsoleRequest, onClose = () => {} }) {
  const bridge=useAssistantBridge();
  const [settings,setSettings]=useState(null), [threads,setThreads]=useState([]), [thread,setThread]=useState(null);
  const [settingsError,setSettingsError]=useState('');
  const [messages,setMessages]=useState([]), [message,setMessage]=useState(''), [answerText,setAnswerText]=useState(''), [answerOption,setAnswerOption]=useState('');
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const [openingAction,setOpeningAction]=useState(false);
  const [historyLoading,setHistoryLoading]=useState(false),[historyOpen,setHistoryOpen]=useState(true),[historyError,setHistoryError]=useState('');
  const [historyQuery,setHistoryQuery]=useState(''),[showArchived,setShowArchived]=useState(false);
  const [historyPage,setHistoryPage]=useState(1),[historyHasMore,setHistoryHasMore]=useState(false);
  const [turnsBefore,setTurnsBefore]=useState(null), [turnsHasMore,setTurnsHasMore]=useState(false);
  const [notice,setNotice]=useState('');
  const [readPage,setReadPage]=useState(null),[reading,setReading]=useState(false);
  const [,updateJobs]=useState(0);
  // A job owns its request IDs and controller, independently of which conversation is visible.
  const scopeRef=useRef(null),jobs=useRef(new Map()),openRef=useRef(open),mutations=useRef(new Set());
  if(!scopeRef.current)scopeRef.current=emptyScope();
  openRef.current=open;
  const seenReceipts=useRef(new Set()),executeAttempts=useRef(new Map()),rebaseAttempts=useRef(new Map());
  const listRequest=useRef(0),historyFilter=useRef({q:'',archived:false}),preserveScroll=useRef(null);
  const historyHeading=useRef(null),newConversationButton=useRef(null),deleteConversationButton=useRef(null),handledConsoleRequest=useRef(null);
  const consoleHeading=useRef(null),ideasGroup=useRef(null);
  const [controlFocus,setControlFocus]=useState(null),[ideasOpen,setIdeasOpen]=useState(false);
  const [intentionsOpen,setIntentionsOpen]=useState(false);
  const focusConversation=useRef(false);
  const messageRef=useRef(null),listRef=useRef(null),dialogRef=useRef(null),mounted=useRef(false),readRequest=useRef(0);
  useDialog(dialogRef,{open,busy:false,dirty:false,onClose});
  const job=jobs.current.get(scopeRef.current.id||scopeRef.current);
  let backgroundCount=0;
  for(const item of jobs.current.values())if(item!==job&&(item.busy||item.status?.state==='running'))backgroundCount+=1;
  const work=job?.status?.state==='running'?job.status:null;
  const sending=Boolean(job?.busy),stopping=Boolean(job?.stopping);
  const actionBusy=openingAction||sending||work?.state==='running';
  const activeForm=bridge.getActiveForm();
  const literalDraftAvailable=Boolean(activeForm?.entityId&&!activeForm.dirty&&!activeForm.busy&&(activeForm.target.startsWith('record:')||activeForm.target==='campaign-draft'));
  const selectedThreadId=threadIdOf(thread);
  const pendingOpen=bridge.pendingOpen;
  const contextualForm=pendingOpen?.formId?bridge.getForm(pendingOpen.formId):null;
  const canReturnToForm=Boolean(contextualForm&&contextualForm.target===pendingOpen.target&&contextualForm.entityId===pendingOpen.entityId&&contextualForm.recordVersion===pendingOpen.recordVersion);
  const threadData=thread?.thread?.data || thread?.data || {};
  const archived=Boolean(thread?.archived);
  const pendingQuestion=threadData.pendingQuestion || thread?.question || null;
  const composerDisabled=!settings?.enabled||sending||loading||stopping||Boolean(work)||archived||!scopeRef.current.ready||mutations.current.has(selectedThreadId);
  const workMemory=threadData.workMemory||{},followUps=Array.isArray(workMemory.followUps)?workMemory.followUps:[];

  const loadThreads=useCallback(async(page=1)=>{
    const request=++listRequest.current;
    const filter=historyFilter.current;
    const params=new URLSearchParams({page:String(page)});
    if(filter.q.trim())params.set('q',filter.q.trim());
    if(filter.archived)params.set('archived','1');
    setHistoryLoading(true);setHistoryError('');
    try{
      const value=await api(`/api/admin/assistant/threads?${params}`);
      if(!mounted.current||request!==listRequest.current||filter!==historyFilter.current)return;
      const meta=value.pagination||value;
      setThreads(current=>page===1?rows(value):[...current,...rows(value).filter(row=>!current.some(item=>item.id===row.id))]);
      setHistoryPage(meta.page||page);setHistoryHasMore(Boolean(meta.hasMore));
    }catch(cause){
      if(mounted.current&&request===listRequest.current&&filter===historyFilter.current)setHistoryError(cause.message||'No se pudo cargar el historial de Ali.');
    }finally{
      if(mounted.current&&request===listRequest.current&&filter===historyFilter.current)setHistoryLoading(false);
    }
  },[api]);
  const loadSettings=useCallback(async()=>{
    const value=await api('/api/admin/assistant/settings');
    if(mounted.current)setSettings(validateAssistantSettings(value));
  },[api]);
  useEffect(()=>{
    mounted.current=true;
    return()=>{
      mounted.current=false;
      for(const job of jobs.current.values()){job.controller?.abort();job.disposed=true;}
      jobs.current.clear();
    };
  },[]);
  useEffect(()=>{
    if(open)return;
    const scope=scopeRef.current;
    const item=jobs.current.get(scope.id||scope);
    // Closing detaches the visible pump; switching conversations leaves every pump running.
    if(item?.status?.state==='running')item.controller?.abort();
    else if(item?.busy&&!item.status)item.pauseAfterSubmit=true;
  },[open]);
  useEffect(()=>{
    if(!open)return;
    let live=true;
    const refresh=()=>void loadSettings().then(()=>{if(live)setSettingsError('');})
      .catch(cause=>{if(live)setSettingsError(cause.message||'No se pudo actualizar el estado de Ali.');});
    refresh();
    window.addEventListener('focus',refresh);
    return()=>{live=false;window.removeEventListener('focus',refresh);};
  },[open,loadSettings]);
  useEffect(()=>{
    if(!open)return;
    const timer=setTimeout(()=>void loadThreads(),historyQuery?250:0);
    const refresh=()=>void loadThreads();
    window.addEventListener('focus',refresh);
    return()=>{clearTimeout(timer);window.removeEventListener('focus',refresh);};
  },[open,historyQuery,showArchived,loadThreads]);
  useEffect(()=>{setAnswerText('');setAnswerOption('');},[pendingQuestion?.id]);
  useEffect(()=>{if(readPage)listRef.current?.querySelector('[data-testid=assistant-read-page] h3')?.focus({preventScroll:false});},[readPage]);
  useEffect(()=>{
    const list=listRef.current;
    if(!list)return;
    if(preserveScroll.current){list.scrollTop=list.scrollHeight-preserveScroll.current.height+preserveScroll.current.top;preserveScroll.current=null;}
    else {
      const target=list.querySelector('[data-testid=assistant-progress]')||[...list.querySelectorAll('[data-assistant-turn]')].at(-1);
      if(target)list.scrollTop=Math.max(0,target.getBoundingClientRect().top-list.getBoundingClientRect().top+list.scrollTop);
      else list.scrollTop=list.scrollHeight;
    }
  },[messages,sending]);
  useEffect(()=>{
    if(!open||composerDisabled)return;
    const focused=document.activeElement;
    if(!focusConversation.current&&dialogRef.current?.contains(focused)&&focused!==dialogRef.current&&!focused.hasAttribute('data-dialog-initial-focus'))return;
    focusConversation.current=false;
    const question=listRef.current?.querySelector('[data-assistant-question] input:not(:disabled)');
    if(question)question.focus();
    else messageRef.current?.focus({preventScroll:true});
  },[open,composerDisabled,pendingQuestion?.id,scopeRef.current]);
  useEffect(()=>{
    const proposalIds=new Set(messages.map(row=>row.result?.proposal?.id).filter(Boolean));
    const fresh=bridge.receipts.filter(({receipt})=>proposalIds.has(receipt.proposalId)&&!seenReceipts.current.has(receipt.id));
    if(!fresh.length)return;
    for(const {receipt} of fresh)seenReceipts.current.add(receipt.id);
    setMessages(current=>current.map(row=>{
      const response=fresh.find(item=>item.receipt.proposalId===row.result?.proposal?.id);
      return response?{...row,result:{...row.result,receipt:response.receipt,proposal:{...row.result.proposal,state:'executed'}}}:row;
    }));
    setNotice(isCopyRequest(fresh.at(-1).receipt)?'Solicitud recibida. Consulta su estado antes de dar la copia por lista.':'Cambio guardado. El comprobante está disponible en la conversación.');
    const scope=scopeRef.current;
    if(scope.id)void refreshThreadMetadata(scope);
  },[bridge.receipts,messages]);

  function isSelected(scope){return mounted.current&&scopeRef.current===scope;}
  function isShowing(id){return mounted.current&&scopeRef.current.ready&&scopeRef.current.id===id;}
  function jobChanged(){if(mounted.current)updateJobs(value=>value+1);}
  function resetSelection(scope){
    scopeRef.current=scope;readRequest.current+=1;preserveScroll.current=null;
    focusConversation.current=false;
    setThread(null);setMessages([]);setMessage('');setTurnsBefore(null);setTurnsHasMore(false);
    setReadPage(null);setReading(false);setOpeningAction(false);setAnswerText('');setAnswerOption('');setError('');setNotice('');setIntentionsOpen(false);
  }
  async function refreshThreadMetadata(scope){
    const request=(scope.metadataRequest||0)+1;
    scope.metadataRequest=request;
    try{
      const value=await api(threadURL(scope.id));
      if(!isSelected(scope)||!scope.ready||scope.metadataRequest!==request)return;
      setThread(current=>!isSelected(scope)||current?.version>value.version?current:value);
    }catch{/* History remains available for an explicit retry. */}
  }
  async function openThread(id){
    if(scopeRef.current.id!==id)onClearAdvisorTask?.();
    const scope={id,ready:false};
    resetSelection(scope);setHistoryOpen(false);setLoading(true);
    try{
      const value=await api(threadURL(id));
      if(!isSelected(scope))return;
      scope.ready=true;
      setThread(scope.archivePatch?.version>value.version?{...value,...scope.archivePatch}:value);
      setMessages(publicTurns(value));setTurnsBefore(historyCursor(value));setTurnsHasMore(historyMore(value));
      const active=value.turns?.find(turn=>turn.status&&turn.state==='running');
      let item=jobs.current.get(id);
      if(active&&(!item||(!item.busy&&active.id!==item.status?.turnId))){
        item={scope,status:validateAssistantTurnStatus(active.status),text:active.message,startedAt:active.startedAt};
        jobs.current.set(id,item);
      }
      if(item?.status){
        const saved=value.turns?.find(turn=>turn.id===item.status.turnId);
        if(saved&&saved.state!=='running'&&!item.busy&&!item.stopping)jobs.current.delete(id);
        else if(saved?.status&&saved.state==='running')publishStatus(item,validateAssistantTurnStatus(saved.status));
        if(!saved||saved.state==='running')applyTurnStatus(item,item.status);
      }
      focusConversation.current=!item?.busy&&item?.status?.state!=='running';
    }catch(cause){
      if(isSelected(scope)){setHistoryOpen(true);setError(cause.message||'No se pudo abrir la conversación.');}
    }finally{if(isSelected(scope))setLoading(false);}
  }
  async function loadOlderTurns(){
    const scope=scopeRef.current;
    if(!selectedThreadId||!turnsBefore||loading)return;
    setLoading(true);setError('');
    try{
      const value=await api(`${threadURL(scope.id)}?before=${encodeURIComponent(turnsBefore)}`);
      if(!isSelected(scope))return;
      const older=publicTurns(value);
      if(listRef.current)preserveScroll.current={height:listRef.current.scrollHeight,top:listRef.current.scrollTop};
      setMessages(current=>{const existing=new Set(current.map(row=>row.key));return [...older.filter(row=>!existing.has(row.key)),...current];});
      setTurnsBefore(historyCursor(value));setTurnsHasMore(historyMore(value));
    }catch(cause){if(isSelected(scope))setError(cause.message||'No se pudo cargar el historial anterior.');}
    finally{if(isSelected(scope))setLoading(false);}
  }
  const startThread=useCallback(()=>{
    onClearAdvisorTask?.();resetSelection(emptyScope());setHistoryOpen(false);setLoading(false);focusConversation.current=true;
  },[onClearAdvisorTask]);
  const goToConsoleControl=useCallback(id=>{
    if(id==='assistant.thread-new')startThread();
    focusConversation.current=false;
    if(id==='assistant.suggested-message')setIdeasOpen(true);
    if(id==='assistant.thread-list'||id==='assistant.thread-open')setHistoryOpen(true);
    setControlFocus(id);
  },[startThread]);
  useEffect(()=>{
    if(!open||!catalogConsoleRequest||handledConsoleRequest.current===catalogConsoleRequest.token)return;
    handledConsoleRequest.current=catalogConsoleRequest.token;
    goToConsoleControl(catalogConsoleRequest.id);
  },[open,catalogConsoleRequest,goToConsoleControl]);
  useEffect(()=>{
    if(!open||loading||!controlFocus)return;
    const resultLabel=resultControls.get(controlFocus);
    const matches=resultLabel&&dialogRef.current?.querySelectorAll(`[data-assistant-result-control="${controlFocus}"]:not(:disabled)`);
    const control=controlFocus==='assistant.open-console'?consoleHeading.current
      :controlFocus==='assistant.suggested-message'?ideasGroup.current
      :controlFocus==='assistant.ask'?(settings?.enabled?messageRef.current:null)
      :controlFocus==='assistant.literal-draft'?(settings?.enabled&&literalDraftAvailable?messageRef.current:null)
      :resultLabel?(matches?.length===1?matches[0]:null)
      :controlFocus==='assistant.thread-delete'?deleteConversationButton.current
      :controlFocus==='assistant.thread-new'?newConversationButton.current:historyHeading.current;
    (control||consoleHeading.current)?.focus();
    if(controlFocus==='assistant.literal-draft'){
      setNotice(control?'Escribe el campo y el texto exacto. Los cambios no descriptivos se revisan antes de guardar.':'Abre un borrador existente sin cambios y vuelve desde «Ayúdame con este formulario».');
    }else if(!control&&consoleControls.includes(controlFocus))setNotice('Habilita Ali para usar las ideas o enviar una consulta.');
    if(!control&&resultLabel)setNotice(`No hay un control inequívoco para «${resultLabel}». Abre la conversación exacta o usa el botón que corresponda en su tarjeta.`);
    if(!thread&&controlFocus==='assistant.thread-delete')setNotice('Abre la conversación exacta antes de borrarla.');
    setControlFocus(null);
  },[open,loading,controlFocus,thread,settings?.enabled,literalDraftAvailable]);
  function filterHistory(q,archived){
    historyFilter.current={q,archived};listRequest.current+=1;
    setThreads([]);setHistoryHasMore(false);setHistoryLoading(true);setHistoryError('');
    setHistoryQuery(q);setShowArchived(archived);
  }
  function threadBusy(id){
    const item=jobs.current.get(id);
    return mutations.current.has(id)||item?.busy||item?.stopping||item?.status?.state==='running';
  }
  async function mutateThread(item, archive){
    const {id,version}=item;
    if(!id||threadBusy(id)||(loading&&scopeRef.current.id===id))return;
    const deleting=archive===undefined;
    if(deleting&&!window.confirm(`¿Borrar «${threadTitle(item)}» y sus propuestas? Los cambios que ya guardaste en el negocio se conservan.`))return;
    const scope=scopeRef.current,filter=historyFilter.current;
    mutations.current.add(id);jobChanged();
    setError('');setHistoryError('');
    try{
      const value=await api(threadURL(id),{method:deleting?'DELETE':'PATCH',body:JSON.stringify(deleting?{version}:{version,archived:archive})});
      if(!mounted.current)return;
      if(deleting){
        jobs.current.delete(id);
        if(scopeRef.current.id===id){startThread();setHistoryOpen(true);}
      }else if(scopeRef.current.id===id){
        scopeRef.current.archivePatch=value;
        setThread(current=>threadIdOf(current)===id&&current.version<=value.version?{...current,...value}:current);
      }
      setThreads(current=>current.filter(row=>row.id!==id));
      void loadThreads();
    }catch(cause){
      const failure=cause.message||(deleting?'No se pudo borrar la conversación.':'No se pudo actualizar la conversación.');
      if(isSelected(scope)&&scope.id===id)setError(failure);
      else if(isSelected(scope)&&filter===historyFilter.current)setHistoryError(failure);
      if(cause.status===409&&isSelected(scope)&&scope.id===id)void refreshThreadMetadata(scope);
    }finally{mutations.current.delete(id);jobChanged();}
  }
  function contextNow(){
    const form=bridge.getActiveForm();
    return {view,selection:bridge.getSelection?.(view)??null,form:form?{formId:form.formId,target:form.target,entityId:form.entityId,recordVersion:form.recordVersion,generation:form.generation,values:form.values,dirty:form.dirty,busy:form.busy}:null};
  }
  function liveJob(item){
    return mounted.current&&!item.disposed&&jobs.current.get(item.scope.id||item.scope)===item;
  }
  function applyTurnStatus(item,status){
    if(!isShowing(status.threadId))return;
    const scope=scopeRef.current;
    setThread(current=>{
      if(!isSelected(scope)||current?.version>status.threadVersion||(current?.version===status.threadVersion&&!status.result))return current;
      const base=current||{id:status.threadId,data:{title:item.text?.slice(0,100)}};
      const result=status.result;
      return {...base,version:status.threadVersion,data:result?{...base.data,topic:result.topic,
        pendingQuestion:result.question||(item.request?.body.answer?null:base.data?.pendingQuestion),
        workMemory:{...base.data?.workMemory,followUps:result.followUps}}:base.data};
    });
    setMessages(current=>{
      if(!isSelected(scope))return current;
      const userKey=`turn-${status.turnId}-user`,resultKey=`turn-${status.turnId}`;
      const metadata={state:status.state,visitedPhases:status.visitedPhases};
      if(status.state==='running'&&current.some(row=>row.key===userKey))return current;
      let next=current.map(row=>row.key===userKey?{...row,...metadata}:row);
      if(item.text&&!next.some(row=>row.key===userKey)){
        next=[...next,{key:userKey,turnId:status.turnId,role:'user',text:item.text,startedAt:item.startedAt,...metadata}];
      }
      if(status.result&&!next.some(row=>row.key===resultKey)){
        const index=next.findIndex(row=>row.key===userKey);
        const row={key:resultKey,role:'assistant',result:status.result};
        if(index<0)next.push(row);
        else next.splice(index+1,0,row);
      }
      return next;
    });
  }
  function publishStatus(item,status){
    if(!liveJob(item)||item.scope.id!==status.threadId)return;
    const prior=item.status;
    if(prior&&(prior.turnId!==status.turnId||prior.state!=='running'||(status.state==='running'&&prior.revision>status.revision)))return;
    if(prior?.revision===status.revision&&prior.state===status.state)return;
    item.status=status;applyTurnStatus(item,status);jobChanged();
  }
  async function recoverStatus(item,signal){
    publishStatus(item,validateAssistantTurnStatus(await api(turnURL(item.status.turnId),{signal})));
  }
  async function finishJob(item){
    if(!liveJob(item)||item.status?.state==='running'||item.finished)return;
    item.finished=true;
    const result=item.status.result,proposal=result?.proposal;
    if(proposal?.execution==='automatic'&&proposalPending(proposal)&&!result.receipt&&item.request&&openRef.current){
      executeAttempts.current.set(proposal.id,{proposal,confirmation:null});
      try{
        const executed=await bridge.executeAutomaticProposal(proposal,item.request.initialForms);
        executeAttempts.current.delete(proposal.id);
        if(isSelected(item.scope)){
          if(!executed.saved)setNotice('El formulario cambió o necesita revisión. No se guardó automáticamente; revisa la propuesta.');
          else if(executed.postCommitError)setError('El cambio está guardado y tiene comprobante, pero no se pudo actualizar el editor. Recarga el registro antes de editar de nuevo.');
        }
      }catch(cause){
        if(isSelected(item.scope))setError(`${cause.message||'No se pudo recuperar el guardado.'} Si la conexión se interrumpió, recupera el comprobante antes de repetir el cambio.`);
      }
    }
    if(!liveJob(item))return;
    item.request=null;
    if(isShowing(item.scope.id))void refreshThreadMetadata(scopeRef.current);
    if(openRef.current){
      void loadThreads();
      void loadSettings().catch(()=>{});
    }
  }
  async function pump(item,{recover=false}={}){
    const controller=new AbortController();
    item.controller=controller;item.busy=true;jobChanged();
    const active=()=>liveJob(item)&&!item.stopping&&!controller.signal.aborted;
    try{
      if(recover)await recoverStatus(item,controller.signal);
      while(active()&&item.status.state==='running'){
        const {turnId,revision}=item.status;
        if(item.advance?.version!==revision)item.advance={version:revision,requestId:uid()};
        let polling=false;
        const timer=setInterval(()=>{
          if(!active()||polling)return;
          polling=true;
          void recoverStatus(item,controller.signal).catch(()=>{}).finally(()=>{polling=false;});
        },1000);
        try{
          const status=validateAssistantTurnStatus(await api(`${turnURL(turnId)}/advance`,{method:'POST',signal:controller.signal,body:JSON.stringify(item.advance)}));
          if(active())publishStatus(item,status);
        }catch(cause){
          if(!active())return;
          await recoverStatus(item,controller.signal);
          if(active()&&item.status.state==='running'&&item.status.revision===revision&&cause.status&&cause.status<500)throw cause;
        }finally{clearInterval(timer);}
        if(active()&&item.status.state==='running'&&item.status.revision===revision)await waitForAdvance();
      }
      if(active()&&item.status.state!=='running')await finishJob(item);
    }catch(cause){
      if(active()&&isShowing(item.scope.id))setError(cause.message||'No se pudo recuperar el avance. Puedes continuar desde el último avance guardado.');
    }finally{
      controller.abort();
      if(item.controller===controller){item.controller=null;item.busy=false;jobChanged();}
    }
  }
  async function sendTurn({text,answer=null,continueFromTurnId=null}={}){
    const scope=scopeRef.current;
    const selectedLabel=answer&&pendingQuestion?.id===answer.questionId?pendingQuestion.options?.find(option=>option.id===answer.optionId)?.label:null;
    const content=continueFromTurnId?'Completar análisis':String(answer?(text||answer.text||selectedLabel||'Respuesta a la pregunta'):(text??message)).trim();
    const prior=jobs.current.get(scope.id||scope);
    if(composerDisabled||threadBusy(scope.id)||prior?.busy||!content)return;
    const identity={threadId:scope.id,threadVersion:thread?.version??null};
    const body=continueFromTurnId?{...identity,continueFromTurnId}:{...identity,message:content,context:contextNow(),answer,...(advisorTaskId?{advisorTaskId}:{})};
    const key=fingerprint(body);
    const request=prior?.request?.key===key?prior.request:{key,body:{...body,requestId:uid()},initialForms:bridge.snapshot()};
    const controller=new AbortController();
    const item={scope,request,text:content,startedAt:new Date().toISOString(),busy:true,controller};
    jobs.current.set(scope.id||scope,item);jobChanged();setError('');setHistoryOpen(false);setIntentionsOpen(false);
    const submit=async()=>validateAssistantTurnStatus(await api('/api/admin/assistant/turns',{method:'POST',signal:controller.signal,body:JSON.stringify(request.body)}));
    try{
      let status;
      try{status=await submit();}
      catch(cause){if(!liveJob(item)||cause.status&&cause.status<500)throw cause;status=await submit();}
      if(!liveJob(item))return;
      if(scope.id===null){jobs.current.delete(scope);scope.id=status.threadId;jobs.current.set(scope.id,item);}
      if(status.threadId!==scope.id)throw new Error('La consulta no corresponde a esta conversación.');
      if(isSelected(scope)&&!answer&&!continueFromTurnId)setMessage('');
      publishStatus(item,status);
      if(openRef.current)void loadThreads();
      if(!item.pauseAfterSubmit||status.state!=='running')await pump(item);
    }catch(cause){
      if(isSelected(scope))setError(cause.message||'No se pudo iniciar la consulta. Reintenta para recuperar la misma solicitud.');
      else if(scope.id===null&&liveJob(item))jobs.current.delete(scope);
    }finally{
      if(item.controller===controller){item.controller=null;item.busy=false;jobChanged();}
    }
  }
  function continueWork(){
    const item=jobs.current.get(scopeRef.current.id);
    if(!item||item.busy||item.stopping||item.status?.state!=='running')return;
    setError('');void pump(item,{recover:true});
  }
  async function showRecords(result,cursor=null){
    const scope=scopeRef.current,request=++readRequest.current;
    const current=()=>isSelected(scope)&&readRequest.current===request;
    setReading(true);setError('');
    try{
      const page=validateAssistantReadPage(await api(`${turnURL(result.turnId)}/reads/all${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`));
      if(current())setReadPage({turnId:result.turnId,...page});
    }catch(cause){if(current())setError(cause.message||'No se pudieron recuperar los registros.');}
    finally{if(current())setReading(false);}
  }
  function submitMessage(event){event.preventDefault();void sendTurn();}
  function startSuggestedMessage(value){setMessage(value);messageRef.current?.focus({preventScroll:true});}
  function submitAnswer(event,question){
    event.preventDefault();
    const optionId=question.options?.some(option=>option.id===answerOption)?answerOption:null, text=question.allowText?answerText.trim() || null:null;
    if(!optionId&&!text)return;
    void sendTurn({text:'',answer:{questionId:question.id,optionId,text}});
  }
  async function cancelTurn(){
    const scope=scopeRef.current,item=jobs.current.get(scope.id);
    if(!item||item.stopping||item.status?.state!=='running')return;
    item.stopping=true;item.controller?.abort();jobChanged();setError('');
    item.stopRequestId??=uid();
    try{
      try{
        publishStatus(item,validateAssistantTurnStatus(await api(`${turnURL(item.status.turnId)}/cancel`,{method:'POST',body:JSON.stringify({requestId:item.stopRequestId})})));
      }catch(cause){
        await recoverStatus(item);
        if(item.status.state==='running')throw cause;
      }
      if(item.status.state!=='running')await finishJob(item);
    }catch(cause){if(isSelected(scope))setError(cause.message||'No se pudo detener; puedes reintentar.');}
    finally{item.stopping=false;jobChanged();}
  }
  function focusFollowUp(item,event){
    const target=item.kind==='question'?listRef.current?.querySelector('[data-assistant-question]'):[...(listRef.current?.querySelectorAll('[data-assistant-turn]')||[])].find(node=>node.dataset.assistantTurn===item.turnId);
    const control=target?.querySelector(item.kind==='question'?'input,button':'button');
    const plan=event.currentTarget.closest('details');
    if(plan)plan.open=false;
    (control||target)?.scrollIntoView({block:'center'});
    control?.focus({preventScroll:true});
  }
  async function cancelProposal(proposal){
    const scope=scopeRef.current;
    setLoading(true);setError('');
    try {
      const current=bridge.getActiveForm();
      const binding=bindingFor(current);
      const bound=Boolean(current && proposal.formId===current.formId && proposal.target===current.target
        && (proposal.entityId??null)===(current.entityId??null) && (proposal.recordVersion??null)===(current.recordVersion??null)
        && proposal.generation===current.generation);
      let outcome;
      if(bound) {
        const cancelled=await bridge.cancelProposalFromForm(current.formId,proposal,binding);
        if(cancelled?.receipt){if(isSelected(scope)){setNotice('Este cambio ya estaba guardado. Recupera su comprobante en el historial.');await openThread(scope.id);}return;}
        if(!cancelled?.cancelled)throw new Error('El formulario cambió y no se pudo cancelar la propuesta vinculada.');
        outcome=cancelled.result;
      } else {
        outcome=await bridge.cancelBoundProposal(proposal);
        if(outcome?.receipt || (outcome?.proposal || outcome)?.state==='executed'){if(isSelected(scope)){setNotice('Este cambio ya estaba guardado. Recupera su comprobante en el historial.');await openThread(scope.id);}return;}
      }
      const cancelledProposal=validateProposalDTO(outcome?.proposal || outcome);
      if(cancelledProposal.state!=='cancelled')throw new Error('No se confirmó la cancelación de la propuesta.');
      for(const form of bridge.snapshot())bridge.invalidateProposal(form.formId,proposal.id);
      if(!isSelected(scope))return;
      setMessages(current=>current.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:cancelledProposal}}:row));
      setThread(current=>{const base=current?.thread||current||{},memory=base.data?.workMemory||{};return{...base,data:{...base.data,workMemory:{...memory,followUps:(memory.followUps||[]).filter(item=>item.id!==`proposal:${proposal.id}`)}}};});
    }catch(cause){if(isSelected(scope))setError(cause.message||'No se pudo cancelar la propuesta.');}
    finally{if(isSelected(scope))setLoading(false);}
  }
  async function applyProposal(proposal) {
    const scope=scopeRef.current,current=bridge.getActiveForm();
    if(!current){setError('Abre el formulario correspondiente antes de aplicar la propuesta.');return;}
    const expected=bindingFor(current);
    if(current.busy || current.target!==proposal.target || (current.entityId??null)!==(proposal.entityId??null)
      || (proposal.recordVersion??null)!==(current.recordVersion??null)
      || (proposal.formId!=null && proposal.formId!==current.formId)
      || (proposal.generation!=null && proposal.generation!==current.generation)){
      setError('El formulario activo ya no coincide con el destino o la versión de esta propuesta.');return;
    }
    setLoading(true);setError('');
    try {
      if(current.dirty && !window.confirm('Este formulario tiene cambios sin guardar. ¿Revisaste el diff y quieres combinar estos valores con tu borrador?'))return;
      const result=await api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'apply',version:proposal.version,requestId:uid(),formBinding:expected})});
      if(!isSelected(scope))return;
      const linked=validateProposalDTO(result.proposal || result);
      if(!bridge.bindProposalToForm(current.formId,linked,expected)
        || !bridge.applyProposalToForm(current.formId,linked,expected))throw new Error('El formulario cambió mientras se aplicaba la propuesta. No se modificaron sus valores.');
      setMessages(old=>old.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:linked}}:row));
      onClose();
    }catch(cause){if(isSelected(scope))setError(cause.message||'No se pudo aplicar la propuesta.');}
    finally{if(isSelected(scope))setLoading(false);}
  }
  async function reviseProposal(proposal) {
    const scope=scopeRef.current,current=bridge.getActiveForm();
    if(!current || current.target!==proposal.target || (current.entityId??null)!==(proposal.entityId??null)){setError('Abre el formulario correspondiente para revisar la propuesta.');return;}
    setLoading(true);setError('');
    try {
      const binding=bindingFor(current),key=JSON.stringify([proposal.version,current]);
      let attempt=rebaseAttempts.current.get(proposal.id);
      if(!attempt||attempt.key!==key){attempt={key,requestId:uid()};rebaseAttempts.current.set(proposal.id,attempt);}
      const response=await api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'apply',version:proposal.version,requestId:attempt.requestId,formBinding:binding,formSnapshot:current})});
      const revised=validateProposalDTO(response.proposal,{formContext:{view,form:current}});
      rebaseAttempts.current.delete(proposal.id);
      if(!isSelected(scope))return;
      setMessages(old=>old.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:revised}}:row));
    }catch(cause){if(isSelected(scope))setError(cause.message||'No se pudo revisar la propuesta.');}
    finally{if(isSelected(scope))setLoading(false);}
  }
  function openProposal(proposal){
    bridge.handleProposalOpen({requestId:uid(),proposalId:proposal.id,recordVersion:proposal.recordVersion,open:proposal.open});
  }
  async function openAdvisorAction({id}){
    if(openingAction||actionBusy&&!activeWorkControls.has(id))return;
    if(consoleControls.includes(id)||resultControls.has(id)||['assistant.thread-list','assistant.thread-new','assistant.thread-open','assistant.thread-delete'].includes(id)){
      goToConsoleControl(id);
      return;
    }
    const scope=scopeRef.current;
    setOpeningAction(true);setError('');
    try {
      const opened=await onAdvisorAction({id});
      if(!isSelected(scope))return;
      if(opened)onClose();
      else setError('El control no se abrió. La conversación sigue disponible.');
    }catch{if(isSelected(scope))setError('No se pudo abrir el control. La conversación sigue disponible.');}
    finally{if(isSelected(scope))setOpeningAction(false);}
  }
  function guardedLink(event,href){
    event.preventDefault();
    const next=internalView(href);
    if(!next){setError('El destino no pertenece a una sección válida de la aplicación.');return;}
    if(onNavigate?.(next)===true)onClose();
  }
  async function executeProposal(proposal){
    if(composerDisabled)return;
    const scope=scopeRef.current;
    const forms=bridge.snapshot();
    if(forms.some(form=>duplicateSourceBlocked(proposal,form))){
      setError('La campaña de origen tiene cambios sin guardar o está ocupada. Revísala antes de duplicar.');return;
    }
    if(forms.some(form=>form.target===proposal.target && form.entityId===(proposal.entityId??null))){
      setError('Revisa y guarda desde el formulario abierto para conservar sus cambios y confirmaciones.');return;
    }
    const prior=executeAttempts.current.get(proposal.id);
    if(!prior && !window.confirm(`${advisorCommands[proposal.target]?.prompt||'¿Confirmar este cambio?'}\n\n${proposal.moneyCurrency.before!==proposal.moneyCurrency.after?`Moneda: ${proposal.moneyCurrency.before||'Sin verificar'} → ${proposal.moneyCurrency.after||'Sin verificar'}\n`:''}${[...(proposal.diff||[]),...(proposal.humanDiff||[])].map(item=>`${item.label||item.field}: ${formatAssistantChangeValue(item.field,item.before,proposal.moneyCurrency.before)} → ${formatAssistantChangeValue(item.field,item.after,proposal.moneyCurrency.after)}`).join('\n')}`))return;
    const confirmation=prior ? prior.confirmation : (proposal.execution==='automatic'?null:{proposalId:proposal.id,payloadHash:proposal.payloadHash});
    executeAttempts.current.set(proposal.id,{proposal,confirmation});
    setLoading(true);setError('');
    try{await bridge.executeUnboundProposal(prior?.proposal || proposal,confirmation);executeAttempts.current.delete(proposal.id);}
    catch(cause){if(isSelected(scope))setError(`${cause.message||'No se pudo recuperar el guardado.'} Puedes recuperar el resultado con la misma propuesta.`);}
    finally{if(isSelected(scope))setLoading(false);}
  }
  function renderResult(result,preview=false){
    const evidence=new Map((result.evidence||[]).map(item=>[item.id,item]));
    return <div className={styles.result} data-testid="assistant-result">
      {result.analysis&&<section className={styles.analysisScope} aria-label="Alcance consultado">
        <strong>{result.analysis.status==='partial'?'Respuesta parcial':result.analysis.status==='empty'?'Sin datos consultados':'Análisis completado'}</strong><p>Contexto de origen: {adminLocationLabel(result.analysis.scope.view||{section:'home'})}</p>{result.analysis.scope.datasets.map((dataset,index)=><p key={index}>{topicLabels[dataset.domain]||dataset.domain}{dataset.resource?` · ${dataset.resource}`:''}{dataset.recordId?` · Registro: ${dataset.recordId}`:''}{dataset.startDate?` · Desde ${dataset.startDate} hasta ${dataset.endDateExclusive} (exclusivo)`:''}{dataset.asOf?` · Corte: ${dataset.asOf}`:''}{dataset.filters&&Object.entries(dataset.filters).map(([key,value])=><span key={key}> · {key}: {displayValue(value)}</span>)}</p>)}{result.analysis.reason&&<p>{({quick_budget:'Se completó la revisión rápida. Queda trabajo por revisar.',work_budget:'Se alcanzó el presupuesto de esta ampliación.',user_stopped:'Análisis detenido. Esto es lo revisado.',provider_unavailable:'No se pudo completar la interpretación con el proveedor.',context_capacity:'Queda información por analizar.',invalid_answer:'No se pudo validar la interpretación.',no_progress:'No se obtuvo información nueva.',source_changed:'La fuente cambió durante la revisión.',interrupted:'La revisión se interrumpió.'})[result.analysis.reason]}</p>}{result.analysis.remaining.length>0&&<><strong>Pendiente de revisar</strong><ul>{result.analysis.remaining.map(item=><li key={item.id}>{item.label}</li>)}</ul></>}
        {!preview&&result.analysis.canContinue&&<button type="button" data-assistant-result-control="assistant.extend-analysis" disabled={composerDisabled} onClick={()=>void sendTurn({continueFromTurnId:result.turnId})}>{result.analysis.reason==='user_stopped'?'Retomar análisis':'Completar análisis'}</button>}
        {!preview&&result.analysis.scope.datasets.length>0&&<button type="button" data-assistant-result-control="assistant.read-records" disabled={reading} onClick={()=>void showRecords(result)}>Ver registros consultados</button>}
      </section>}
      {(result.blocks||[]).map((block,index)=><section className={styles.block} key={`${result.turnId}-block-${index}`}>
        {block.type==='analysis'&&<><strong>{block.kind==='interpretation'?'Interpretación de Ali':block.kind==='recommendation'?'Sugerencia':'Explicación'}</strong><p>{block.segments.map((segment,segmentIndex)=>{if(segment.type==='text')return <span key={segmentIndex}>{segment.text}</span>;const item=evidence.get(segment.evidenceId);return item?<button type="button" className={styles.evidenceReference} key={segmentIndex} onClick={event=>{const source=event.currentTarget.closest('[data-testid=assistant-result]')?.querySelector(`[data-source-id="${CSS.escape(item.id)}"]`);if(source){source.closest('details').open=true;source.focus();source.scrollIntoView({block:'nearest'});}}}>{segment.display==='label'?item.label:(item.formattedValue??displayValue(item.value))}</button>:null;})}</p></>}
        {block.type==='text'&&<p>{block.text}</p>}
        {block.type==='action'&&<AdvisorActionCard capability={{id:block.capabilityId,label:block.label,area:block.area,mode:block.mode,prerequisite:block.prerequisite}} onOpen={!preview&&onAdvisorAction?capability=>void openAdvisorAction(capability):null} disabled={openingAction||actionBusy&&!activeWorkControls.has(block.capabilityId)}/>}
        {block.type==='advisor_navigation'&&(block.destination==='tasks'?<>
          <p>Abre tus tareas guardadas y elige cuál quieres retomar.</p>
          {!preview&&onAdvisorTasks&&<button type="button" onClick={onAdvisorTasks}>Abrir Mis tareas</button>}
        </>:<>
          <p>Prueba otras palabras o selecciona un área en el directorio.</p>
          {!preview&&onAdvisorDirectory&&<button type="button" onClick={()=>onAdvisorDirectory({keepConsole:Boolean(work)})}>Buscar en el directorio</button>}
        </>)}
        {block.type==='fact'&&<><strong>{block.title}</strong><ul>{block.evidenceIds.map(id=>{const item=evidence.get(id);return item?<li key={id}>{item.label}: {item.formattedValue ?? displayValue(item.value)}{safeHref(item.href)&&<> · <a href={safeHref(item.href)}>{item.domain==='application'?'Abrir ayuda':'Abrir registro'}</a></>}</li>:null;})}</ul></>}
        {block.type==='recommendation'&&<><strong>{block.title}</strong><p>{block.reason}</p>{block.evidenceIds.map(id=>{const item=evidence.get(id);return item?<div className={styles.source} key={id}><span>{item.label}: {item.formattedValue ?? displayValue(item.value)}{item.asOf?` · Corte: ${item.asOf}`:''}{item.coverage.state!=='complete'?` · Cobertura ${item.coverage.state==='partial'?'parcial':'desconocida'}`:''}</span>{safeHref(item.href)&&<a href={safeHref(item.href)}>Fuente</a>}</div>:null;})}<a className={styles.actionLink} href={safeHref(block.href)}>{block.actionLabel}</a></>}
        {block.type==='guide'&&<><strong>{block.title}</strong><ol>{block.steps.map(step=><li key={step.id}>{step.text}</li>)}</ol><a href={safeHref(block.href)}>Ir a esta sección</a></>}
      </section>)}
      {result.evidence?.length>0&&<details className={styles.evidence}><summary data-assistant-result-control={preview?undefined:'assistant.sources'}>Fuentes ({result.evidence.length})</summary><ul>{result.evidence.map(item=><li key={item.id} data-source-id={item.id} tabIndex={-1}><span>{item.label}: {item.formattedValue ?? displayValue(item.value)}</span>{item.unit&&<small>Unidad: {item.unit}</small>}{item.asOf&&<small>Corte: {item.asOf}</small>}{item.coverage?.state!=='complete'&&<small>Cobertura {item.coverage?.state==='partial'?'parcial':'desconocida'}{item.coverage?.reasons?.length?`: ${item.coverage.reasons.join('; ')}`:''}</small>}{safeHref(item.href)&&<a href={safeHref(item.href)}>Abrir fuente</a>}</li>)}</ul></details>}
      {!preview&&result.proposal&&!result.receipt&&<ProposalCard proposal={result.proposal} onOpen={()=>openProposal(result.proposal)} onApply={()=>void applyProposal(result.proposal)} onRevise={()=>void reviseProposal(result.proposal)} onExecute={()=>void executeProposal(result.proposal)} onCancel={()=>void cancelProposal(result.proposal)} busy={composerDisabled||openingAction} activeForm={activeForm} sourceBlocked={result.proposal.target==='campaign-duplicate'&&bridge.snapshot().some(form=>duplicateSourceBlocked(result.proposal,form))}/>}
      {!preview&&result.receipt&&<ReceiptCard api={api} receipt={result.receipt} showDate/>}
    </div>;
  }
  return <dialog ref={dialogRef} className={styles.dialog} aria-label="Ali, asistente del negocio">
    <div className={styles.console} onClick={event=>{const link=event.target.closest?.('a[href]');if(link)guardedLink(event,link.getAttribute('href'));}}>
      <header className={styles.header}><div><span className={styles.eyebrow}>Ali</span><h2 ref={consoleHeading} tabIndex={-1}>{brandName?`Asistente de ${brandName}`:'Asistente del negocio'}</h2><p>{settings?.enabled?'Consulta con información de tu negocio.':'Configura y habilita Ali para iniciar una conversación.'}</p></div><button type="button" data-dialog-initial-focus className={styles.close} onClick={onClose} aria-label="Cerrar asistente">×</button></header>
      <div className={`${styles.threadTools} ${styles.conversationTools}`}>
        <button type="button" aria-expanded={historyOpen} aria-controls="ali-history" onClick={()=>historyOpen?setHistoryOpen(false):goToConsoleControl('assistant.thread-list')}>{thread?'‹ Conversaciones':'Conversaciones'}</button>
        <button ref={newConversationButton} type="button" onClick={startThread}>Nueva conversación</button>
      </div>
      {backgroundCount>0&&<p className={styles.contextLine} role="status">{backgroundCount===1?'1 consulta en otra conversación':`${backgroundCount} consultas en otras conversaciones`}</p>}
      {settingsError&&<p className={styles.contextLine} role="alert">{settingsError}</p>}
      <div className={styles.messages} ref={listRef} aria-live="off">
      {historyOpen&&<section id="ali-history" className={styles.history} aria-label="Conversaciones anteriores">
        <div className={styles.historyHead}>
          <h3 ref={historyHeading} tabIndex={-1}>Conversaciones</h3>
          <div className={styles.historyFilters} role="group" aria-label="Estado de las conversaciones">
            <button type="button" aria-pressed={!showArchived} onClick={()=>{if(showArchived)filterHistory(historyQuery,false);}}>Activas</button>
            <button type="button" aria-pressed={showArchived} onClick={()=>{if(!showArchived)filterHistory(historyQuery,true);}}>Archivadas</button>
          </div>
        </div>
        <label className={styles.visuallyHidden} htmlFor="ali-history-search">Buscar por título o mensaje</label>
        <input id="ali-history-search" type="search" className={styles.historySearch} maxLength={100}
          placeholder="Buscar por título o mensaje" value={historyQuery} onChange={event=>filterHistory(event.target.value,showArchived)}/>
        {historyLoading&&<p role="status">Cargando conversaciones…</p>}
        {historyError&&<p role="alert">{historyError} <button type="button" onClick={()=>void loadThreads()}>Reintentar</button></p>}
        {!historyLoading&&!historyError&&!threads.length&&<p>{historyQuery.trim()?'No se encontraron conversaciones.':showArchived?'No hay conversaciones archivadas.':'Todavía no hay conversaciones guardadas.'}</p>}
        {threads.map(row=>{
          const item=jobs.current.get(row.id),status=item?.status,title=row.title||item?.text?.slice(0,100)||threadTitle(row);
          return <div className={styles.threadRow} key={row.id}>
            <button type="button" aria-label={title} aria-current={selectedThreadId===row.id?true:undefined} onClick={()=>void openThread(row.id)}>
              <span>{title}</span>
              <small>{[status?.state==='running'?turnLabels.running:null,topicLabels[row.topic],formatDate(row.updatedAt)].filter(Boolean).join(' · ')}</small>
            </button>
            <button type="button" disabled={threadBusy(row.id)||(loading&&scopeRef.current.id===row.id)} onClick={()=>void mutateThread(row,!row.archived)}>{row.archived?'Restaurar':'Archivar'}</button>
            <button type="button" disabled={threadBusy(row.id)||(loading&&scopeRef.current.id===row.id)} aria-label="Borrar conversación" onClick={()=>void mutateThread(row)}>Borrar</button>
          </div>;
        })}
        {historyHasMore&&<button type="button" className={styles.moreThreads} disabled={historyLoading} onClick={()=>void loadThreads(historyPage+1)}>Ver conversaciones anteriores</button>}
      </section>}
      {loading&&!thread&&<p className={styles.contextLine} role="status">Cargando conversación…</p>}
      {thread&&<div className={styles.threadTools}>
        <strong>{threadTitle(thread)}{archived&&<small> · Archivada</small>}</strong>
        <button type="button" disabled={loading||threadBusy(selectedThreadId)} onClick={()=>void mutateThread(thread,!archived)}>{archived?'Restaurar':'Archivar'}</button>
        <button ref={deleteConversationButton} type="button" disabled={loading||threadBusy(selectedThreadId)} onClick={()=>void mutateThread(thread)}>Borrar</button>
      </div>}
      <p className={styles.contextLine}>Estás en: {adminLocationLabel(view || {section:'home'})}{threadData.topic&&<> · Estamos revisando: {topicLabels[threadData.topic] || 'Negocio'}</>}</p>
      {(settings?.enabled||onAdvisorDirectory||onAdvisorPreferences)&&<div className={`${styles.threadTools} ${styles.advisorTools}`} aria-label="Opciones de Ali">
        {onAdvisorDirectory&&<button type="button" disabled={openingAction} onClick={()=>onAdvisorDirectory({keepConsole:work?.state==='running'})}>¿Qué quieres hacer?</button>}
        {settings?.enabled&&!archived&&<button type="button" aria-expanded={intentionsOpen} aria-controls="ali-intentions" disabled={composerDisabled} onClick={()=>setIntentionsOpen(value=>!value)}>Solicitar una intención</button>}
        {onAdvisorPreferences&&<button type="button" disabled={actionBusy} onClick={onAdvisorPreferences}>Mis preferencias</button>}
      </div>}
      {intentionsOpen&&!archived&&<AliIntentionPicker api={api} disabled={composerDisabled} onPrepare={capability=>{setIntentionsOpen(false);startSuggestedMessage(capability.label);}}
        onOpen={onAdvisorAction?capability=>{setIntentionsOpen(false);void openAdvisorAction(capability);}:null}/>}
      {onReminderRequest&&<div className={`${styles.threadTools} ${styles.advisorTools}`} aria-label="Recordatorios personales">
        {advisorReady&&<button type="button" disabled={sending} onClick={()=>onReminderRequest('reminder')}>Recordarme</button>}
        <button type="button" disabled={sending} onClick={()=>onReminderRequest('reminders')}>Mis recordatorios</button>
      </div>}
      {(onAdvisorTaskRequest||onAdvisorTasks)&&<div className={`${styles.threadTools} ${styles.advisorTools}`} aria-label="Acompañamiento operativo">
        {advisorReady&&onAdvisorTaskRequest&&<button type="button" disabled={actionBusy} onClick={()=>onAdvisorTaskRequest('ship-order',activeForm?.target==='order'&&activeForm.entityId?{kind:'order',id:activeForm.entityId}:undefined)}>Empezar envío de un pedido</button>}
        {advisorReady&&onAdvisorTaskRequest&&<button type="button" disabled={actionBusy} onClick={()=>onAdvisorTaskRequest('close-cash')}>Empezar cierre de caja</button>}
        {onAdvisorTasks&&<button type="button" onClick={onAdvisorTasks}>Mis tareas</button>}
      </div>}
      {advisorTaskId&&<div className={styles.contextLine}><span>Tarea de envío seleccionada para este turno.</span><button type="button" disabled={sending} onClick={onClearAdvisorTask}>Quitar selección</button></div>}
      {thread&&(workMemory.goal||followUps.length>0)&&<details className={styles.workPlan} aria-label="Objetivo y siguientes pasos">
        <summary className={styles.workPlanHead} data-assistant-result-control="assistant.thread-follow-up"><strong>Objetivo y siguientes pasos</strong><span>{followUps.length?` · ${followUps.length} por revisar`:' · Sin seguimientos'}</span></summary>
        {workMemory.goal&&<p>{workMemory.goal}</p>}
        {followUps.length>0&&<ol className={styles.workPlanList}>{followUps.map(item=><li key={item.id}>{['action','task','receipt'].includes(item.kind)&&safeHref(item.href)?<a href={safeHref(item.href)}><span>{item.title}</span><small>{item.description}</small><em>{item.kind==='receipt'?'Guardado':'Sugerido'}</em></a>:<button type="button" onClick={event=>focusFollowUp(item,event)}><span>{item.title}</span><small>{item.description}</small><em>{item.state==='pending'?'Pendiente':'Sugerido'}</em></button>}</li>)}</ol>}
        <small className={styles.memoryNote}>Ali recuerda el objetivo y las respuestas de esta conversación. Verifica los datos actuales antes de actuar.</small>
      </details>}
      {pendingOpen&&<div className={styles.contextLine} role="status"><span>Solicitud contextual pendiente: {pendingOpen.target || pendingOpen.type || 'formulario'}.</span>
        {(canReturnToForm||pendingOpen.view)&&<button type="button" data-assistant-result-control="assistant.context-destination" disabled={actionBusy||contextualForm?.busy} onClick={()=>{
          if(!canReturnToForm&&onNavigate?.(pendingOpen.view)!==true)return;
          bridge.acknowledgeOpen(pendingOpen.requestId);
          onClose();
        }}>{canReturnToForm?'Volver al formulario':'Ir a la sección'}</button>}
        <button type="button" onClick={()=>bridge.acknowledgeOpen(pendingOpen.requestId)}>Descartar aviso</button>
      </div>}
      <div className={styles.messageBody}>
        {turnsHasMore&&<button type="button" className={styles.olderTurns} disabled={loading||!turnsBefore} onClick={()=>void loadOlderTurns()}>Cargar mensajes anteriores</button>}
        {!loading&&!messages.length&&<div className={styles.empty}><h3>¿Qué necesitas revisar?</h3><p>Puedo consultar información registrada y ayudarte con formularios. Los cambios descriptivos autorizados pueden guardarse si el formulario está limpio; los demás se revisan antes de confirmar.</p>{settings&&!settings.enabled&&<><p role="status">Ali está deshabilitado o no tiene una conexión lista.</p><button type="button" onClick={()=>onNavigate?.({section:'business',tab:'assistant'})}>Abrir configuración de Ali</button></>}</div>}
        {settings?.enabled&&!archived&&<div>
          {messages.length>0&&<button className="button subtle" type="button" aria-expanded={ideasOpen} aria-controls="ali-ideas" onClick={()=>setIdeasOpen(value=>!value)}>Ideas para empezar</button>}
          <div ref={ideasGroup} id="ali-ideas" role="group" className={styles.quickStarts} tabIndex={-1} hidden={messages.length>0&&!ideasOpen} aria-label="Ideas para empezar">
            {activeForm&&<button type="button" disabled={composerDisabled} onClick={()=>startSuggestedMessage('Ayúdame a completar este formulario con los datos disponibles; pregunta lo que falte.')}>Completar este formulario</button>}
            {quickStarts.map(item=><button type="button" key={item.label} disabled={composerDisabled} onClick={()=>startSuggestedMessage(item.message)}>{item.label}</button>)}
          </div>
        </div>}
        {messages.map(row=><article className={`${styles.message} ${row.role==='user'?styles.userMessage:styles.assistantMessage}`} key={row.key} data-assistant-turn={row.result?.turnId||undefined}>
          <span className={styles.speaker}>{row.role==='user'?'Tú':'Ali'}</span>
          {row.role==='user'?<>
            {row.text&&<p>{row.text}</p>}
            <div className={styles.turnMeta}>
              {row.state&&<strong>{turnLabels[row.state]}</strong>}
              {formatDate(row.startedAt)&&<time dateTime={row.startedAt}>{formatDate(row.startedAt)}</time>}
            </div>
            {row.state!=='running'&&row.visitedPhases?.length>0&&<details className={styles.phaseHistory}>
              <summary>Etapas registradas</summary>
              <ol>{row.visitedPhases.map(phase=><li key={phase}>{phaseLabels[phase]}</li>)}</ol>
            </details>}
          </>:renderResult(row.result)}
        </article>)}
        {pendingQuestion&&<form className={styles.question} data-assistant-question={pendingQuestion.id} onSubmit={event=>submitAnswer(event,pendingQuestion)}>
          <p id={`question-${pendingQuestion.id}`} data-assistant-result-control={!composerDisabled?'assistant.answer-question':undefined} tabIndex={-1}>{pendingQuestion.prompt}</p>
          {pendingQuestion.options?.length>0&&<div className={styles.options} role="group" aria-labelledby={`question-${pendingQuestion.id}`}>{pendingQuestion.options.map(option=><label key={option.id}><input type="radio" disabled={composerDisabled} name={`answer-${pendingQuestion.id}`} checked={answerOption===option.id} onChange={()=>{setAnswerOption(option.id);setAnswerText('');}}/>{option.label}</label>)}</div>}
          {pendingQuestion.allowText&&<input id={`answer-${pendingQuestion.id}`} aria-labelledby={`question-${pendingQuestion.id}`} disabled={composerDisabled} type={pendingQuestion.input} value={answerText} onChange={event=>{setAnswerText(event.target.value);setAnswerOption(null);}} placeholder="Escribe tu respuesta" maxLength={pendingQuestion.input==='text'?8000:undefined}/>}
          <button type="submit" disabled={composerDisabled||(!pendingQuestion.options?.some(option=>option.id===answerOption)&&(!pendingQuestion.allowText||!answerText.trim()))}>Responder</button>
        </form>}
        {work?.state==='running'&&<section className={styles.progress} data-testid="assistant-progress" aria-label="Progreso del análisis">
          <p role="status">{stopping?'Deteniendo…':`${phaseLabels[work.phase]}${sending?'':' · Avance guardado'}`}</p>
          <ol>{phases.map(phase=><li key={phase} aria-current={phase===work.phase?'step':undefined} data-visited={work.visitedPhases?.includes(phase)||undefined}>{phaseLabels[phase]}{phase!==work.phase&&work.visitedPhases?.includes(phase)&&<span className={styles.visuallyHidden}> (etapa registrada)</span>}</li>)}</ol>
          <p aria-live="off">Lecturas completadas: {work.progress.readsCompleted} · Registros revisados: {work.progress.recordsRead}{work.progress.recordsTotal!==null?` de ${work.progress.recordsTotal}`:''}{work.progress.currentLabel?` · ${work.progress.currentLabel}`:''}</p>
          {!sending&&<><button type="button" data-assistant-result-control="assistant.continue-running" disabled={stopping} onClick={()=>void continueWork()}>Continuar</button><button type="button" data-assistant-result-control="assistant.stop-analysis" disabled={stopping} onClick={()=>void cancelTurn()}>Responder con lo revisado</button></>}
          {work.preview&&renderResult(work.preview,true)}
        </section>}
        {readPage&&<section className={styles.readPage} data-testid="assistant-read-page" aria-label="Registros consultados">
          <h3 tabIndex={-1}>Registros consultados</h3>
          <ul>{readPage.records.map((record,index)=><li key={record.id||index}>{Object.entries(record).map(([key,value])=><p key={key}><strong>{key}: </strong>{displayValue(value)}</p>)}</li>)}</ul>
          <p>{readPage.retrieval.recordsRead} registros revisados{readPage.pagination.total!==null?` · Total: ${readPage.pagination.total}`:''}</p>
          {readPage.pagination.nextCursor&&<button type="button" disabled={reading} onClick={()=>void showRecords({turnId:readPage.turnId},readPage.pagination.nextCursor)}>Siguiente página</button>}
          <button type="button" onClick={()=>{readRequest.current+=1;setReading(false);setReadPage(null);}}>Cerrar registros</button>
        </section>}
      </div>
      </div>
      {notice&&<div className={styles.notice} role="status"><span>{notice}</span>{selectedThreadId&&<button type="button" disabled={loading||sending} onClick={()=>void openThread(selectedThreadId)}>Recuperar historial</button>}<button type="button" onClick={()=>setNotice('')}>Cerrar aviso</button></div>}
      {error&&<div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={()=>setError('')}>Cerrar aviso</button></div>}
      <p className={styles.privacyNotice}>Tu consulta, la memoria y los campos asistibles pueden enviarse al proveedor configurado. Evita datos sensibles.</p>
      {pendingQuestion&&!archived&&<p className={styles.contextLine}>Puedes dejar esta pregunta pendiente. <button type="button" onClick={startThread}>Empezar otra consulta</button></p>}
      {archived?<p className={styles.privacyNotice}>Restaura esta conversación para escribir un mensaje o realizar cambios.</p>:<form className={styles.composer} onSubmit={submitMessage}>
        <label className={styles.visuallyHidden} htmlFor="assistant-message">Mensaje para Ali</label>
        <textarea id="assistant-message" ref={messageRef} value={message} onChange={event=>setMessage(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} maxLength={8000} rows={2} placeholder="Escribe tu consulta…" disabled={composerDisabled}/>
        <div className={styles.composerActions}><span>Enter para enviar · Shift+Enter para una línea nueva</span><div>
          {work&&<button type="button" data-assistant-result-control={sending?'assistant.stop-analysis':undefined} disabled={stopping} onClick={()=>void cancelTurn()}>{stopping?'Deteniendo…':'Detener'}</button>}
          <button type="submit" disabled={composerDisabled||!message.trim()}>Enviar</button>
        </div></div>
      </form>}
    </div>
  </dialog>;
}

function ReceiptCard({api,receipt,showDate=false}) {
  const [checking,setChecking]=useState(false),[copyNotice,setCopyNotice]=useState('');
  const copyRequest=isCopyRequest(receipt);
  const label=copyRequest?'Solicitud recibida':receipt.target==='campaign-duplicate'?'Borrador creado':'Cambio guardado';
  async function checkCopy(){
    setChecking(true);setCopyNotice('');
    const unverified='Aún no se pudo comprobar una copia de esta solicitud. El comprobante de recepción se conserva.';
    try {
      const response=await api(`/api/admin/assistant/proposals/${encodeURIComponent(receipt.proposalId)}`);
      const confirmed=validateAssistantReceipt(response.receipt),status=response.reportStatus;
      if(confirmed?.id!==receipt.id||confirmed.jobKey!==receipt.jobKey||confirmed.queryKey!==receipt.queryKey||confirmed.runId!==receipt.runId
        ||status?.key!==receipt.jobKey||status.queryKey!==receipt.queryKey||status.runId!==receipt.runId) {
        setCopyNotice(unverified);return;
      }
      if(status.state==='succeeded'&&status.snapshotId&&Number.isSafeInteger(status.revision)&&status.revision>0&&status.finishedAt){
        setCopyNotice(status.unchanged?`La consulta conservó la misma copia, versión ${status.revision}.`:`Copia de esta consulta comprobada, versión ${status.revision}.`);
      } else setCopyNotice(({queued:'La solicitud sigue en cola; la copia aún no está comprobada.',running:'La solicitud se está procesando; la copia aún no está comprobada.',failed:'La solicitud falló. No se comprobó una copia de esta consulta.'})[status.state]||unverified);
    } catch {setCopyNotice(unverified);}
    finally {setChecking(false);}
  }
  return <section className={styles.receipt} tabIndex={-1} data-assistant-result-control="assistant.receipt" aria-label={copyRequest||receipt.target==='campaign-duplicate'?label:showDate?'Comprobante de cambio guardado':'Último comprobante guardado'}>
    <strong>{label}</strong><p>{receipt.summary}</p>{showDate&&<small>{receipt.committedAt}</small>}
    {copyRequest&&<><button type="button" disabled={checking} onClick={()=>void checkCopy()}>{checking?'Comprobando…':'Comprobar esta solicitud'}</button>{copyNotice&&<p role="status">{copyNotice}</p>}</>}
    {safeHref(receipt.href)&&<a href={safeHref(receipt.href)}>{copyRequest?'Consultar estado de la copia':'Abrir registro guardado'}</a>}
  </section>;
}

function ProposalCard({proposal,onOpen,onApply,onRevise,onExecute,onCancel,busy,activeForm,sourceBlocked}) {
  const sameIdentity=Boolean(activeForm && activeForm.target===proposal.target && (activeForm.entityId??null)===(proposal.entityId??null));
  const exact=Boolean(sameIdentity && (proposal.recordVersion??null)===(activeForm?.recordVersion??null) && (proposal.formId==null || proposal.formId===activeForm.formId) && (proposal.generation==null || proposal.generation===activeForm?.generation));
  const executable=['automatic','confirm'].includes(proposal.execution) && !proposal.missingFields?.length;
  const command=advisorCommands[proposal.target];
  return <section className={styles.proposal} tabIndex={-1} data-assistant-result-control={proposalPending(proposal)?'assistant.proposal-review':undefined} aria-label="Propuesta de cambio">
    <div className={styles.proposalHeader}><strong>Propuesta</strong><small>{proposal.state==='executed'?'Guardada':proposal.state==='cancelled'?'Cancelada':proposal.state==='stale'?'Requiere nueva revisión':proposal.state==='applied'?'Valores entregados; aún sin guardar':'Pendiente de revisión'}</small></div>
    <p>{command?command.title:`Destino: ${proposal.target}`}{proposal.entityId?` · ${proposal.entityId}`:''}</p>
    {proposal.moneyCurrency.before!==proposal.moneyCurrency.after&&<p>Moneda: {proposal.moneyCurrency.before||'Sin verificar'} → {proposal.moneyCurrency.after||'Sin verificar'}. No se convierten importes.</p>}
    {proposal.diff?.length>0?<ul className={styles.diff}>{proposal.diff.map((change,index)=><li key={`${change.field}-${index}`}><strong>{change.label||assistantFieldLabel(proposal.target,change.field)}</strong><del>{formatAssistantChangeValue(change.field,change.before,proposal.moneyCurrency.before)}</del><span aria-hidden="true">→</span><ins>{formatAssistantChangeValue(change.field,change.after,proposal.moneyCurrency.after)}</ins></li>)}</ul>:!command&&<p>No hay campos modificados.</p>}
    {proposal.humanDiff?.length>0&&<><strong>Controles y revisión humana</strong><ul className={styles.diff}>{proposal.humanDiff.map((change,index)=><li key={`human-${change.field}-${index}`}><strong>{change.label||assistantFieldLabel(proposal.target,change.field)}</strong><del>{formatAssistantChangeValue(change.field,change.before,proposal.moneyCurrency.before)}</del><span aria-hidden="true">→</span><ins>{formatAssistantChangeValue(change.field,change.after,proposal.moneyCurrency.after)}</ins></li>)}</ul></>}
    {proposal.missingFields?.length>0&&<p>Falta información: {proposal.missingFields.map(field=>assistantFieldLabel(proposal.target,field)).join(', ')}</p>}
    <div className={styles.proposalActions}><button type="button" data-assistant-result-control="assistant.proposal-form" onClick={onOpen} disabled={busy}>Revisar formulario</button>
      {proposalPending(proposal)&&<>
        {!command&&<><button type="button" data-assistant-result-control="assistant.proposal-apply" onClick={onApply} disabled={busy||!exact||activeForm?.busy}>Aplicar valores</button><button type="button" data-assistant-result-control="assistant.proposal-rebase" onClick={onRevise} disabled={busy||!sameIdentity||activeForm?.busy}>Actualizar revisión</button></>}
        {executable&&<button type="button" data-assistant-result-control="assistant.proposal-confirm" onClick={onExecute} disabled={busy||sameIdentity||sourceBlocked}>{command?.confirm||'Confirmar cambio / recuperar'}</button>}
        <button type="button" data-assistant-result-control="assistant.proposal-cancel" onClick={onCancel} disabled={busy}>Cancelar propuesta</button>
      </>}
    </div>
    {proposalPending(proposal)&&<small>{sourceBlocked?'La campaña de origen tiene cambios sin guardar o está ocupada.':command?.review||(sameIdentity?'Guarda desde el formulario para confirmar exactamente sus valores y controles humanos.':'Abre el formulario correcto para aplicar los valores sin guardar.')}</small>}
  </section>;
}
