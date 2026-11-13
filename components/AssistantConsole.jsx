'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { validateAssistantSettings, validateProposalDTO, validateTurnResult, validateAssistantTurnStatus, validateAssistantReadPage } from '../lib/assistant/contracts.mjs';
import { assistantFieldLabel, formatAssistantChangeValue } from '../lib/assistant/forms.mjs';
import { useAssistantBridge } from './AssistantBridge.jsx';
import { adminLocationLabel } from './admin-tasks.mjs';
import { adminHref, readAdminView } from '../lib/admin-view.mjs';
import useDialog from './useDialog.js';
import styles from './AssistantConsole.module.css';

const fingerprint = value => JSON.stringify(value, function(key,item){return item && typeof item==='object' && !Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item;});
const phaseLabels={planning:'Preparar consulta',reading:'Consultar datos',analyzing:'Analizar',answering:'Responder',done:'Finalizado'};
const uid = () => globalThis.crypto?.randomUUID?.() || `ali-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const quickStarts=[
  {label:'Revisar pendientes',message:'¿Qué tareas o seguimientos debería atender primero en esta sección?'},
  {label:'Recomendar próximos pasos',message:'Con lo que sabes de este negocio, ¿qué debería revisar o hacer después?'},
  {label:'Explicar esta sección',message:'Explícame qué puedo hacer aquí y cómo empezar.'},
];
const topicLabels={catalog:'Catálogo',orders:'Pedidos',shipments:'Envíos',cash:'Caja',reports:'Informes',recommendations:'Recomendaciones',business:'Configuración',alerts:'Alertas',imports:'Importaciones',advertising:'Publicidad',access:'Accesos',application:'Uso de la aplicación'};
const rows = value => Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : Array.isArray(value?.threads) ? value.threads : [];
const displayValue = value => value == null ? 'Sin dato' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const bindingFor = form => form ? ({ formId:form.formId,target:form.target,entityId:form.entityId,recordVersion:form.recordVersion,generation:form.generation }) : null;
const historyCursor = value => value?.pagination?.before ?? value?.pagination?.nextBefore ?? value?.nextBefore ?? null;
const historyMore = value => Boolean(value?.pagination?.hasMore ?? value?.hasMore);
const proposalPending = proposal => ['prepared','applied'].includes(proposal?.state);
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
    const key=result?.turnId || turn.id || uid();
    return [
      ...(message ? [{key:`turn-${key}-user`,role:'user',text:message}] : []),
      ...(result ? [{key:`turn-${key}`,role:'assistant',result}] : []),
    ];
  });
}

export default function AssistantConsole({ api, view, onNavigate, brandName, open = false, onClose = () => {} }) {
  const bridge=useAssistantBridge();
  const [settings,setSettings]=useState(null), [threads,setThreads]=useState([]), [thread,setThread]=useState(null);
  const [messages,setMessages]=useState([]), [message,setMessage]=useState(''), [answerText,setAnswerText]=useState(''), [answerOption,setAnswerOption]=useState('');
  const [loading,setLoading]=useState(false), [sending,setSending]=useState(false), [error,setError]=useState('');
  const [historyPage,setHistoryPage]=useState(1), [historyHasMore,setHistoryHasMore]=useState(false);
  const [turnsBefore,setTurnsBefore]=useState(null), [turnsHasMore,setTurnsHasMore]=useState(false);
  const [notice,setNotice]=useState('');
  const [work,setWork]=useState(null),[stopping,setStopping]=useState(false),[readPage,setReadPage]=useState(null),[reading,setReading]=useState(false);
  const workRef=useRef(null),pumpEpoch=useRef(0),openRef=useRef(open),advanceAttempt=useRef(null),stopAttempt=useRef(null);
  openRef.current=open;
  const seenReceipts=useRef(new Set()), automaticAttempts=useRef(new Set()), executeAttempts=useRef(new Map()), rebaseAttempts=useRef(new Map());
  const historyRequest=useRef(0), preserveScroll=useRef(null);
  const messageRef=useRef(null), listRef=useRef(null), dialogRef=useRef(null), requestRef=useRef(null), requestController=useRef(null), mounted=useRef(false);
  useDialog(dialogRef,{open,busy:false,dirty:false,onClose});
  const activeForm=bridge.getActiveForm();
  const selectedThreadId=thread?.thread?.id || thread?.id || null;
  const pendingOpen=bridge.pendingOpen;
  const threadData=thread?.thread?.data || thread?.data || {};
  const pendingQuestion=threadData.pendingQuestion || thread?.question || null;
  const workMemory=threadData.workMemory||{},followUps=Array.isArray(workMemory.followUps)?workMemory.followUps:[];

  const loadThreads=useCallback(async(page=1,append=false)=>{
    const value=await api(`/api/admin/assistant/threads?page=${page}`);
    setThreads(current=>append?[...current,...rows(value)]:rows(value));
    const meta=value.pagination || value;
    const currentPage=Number(meta.page||page), pageSize=Number(meta.pageSize||meta.limit||20), total=Number(meta.total||0);
    setHistoryPage(currentPage);
    setHistoryHasMore(typeof meta.hasMore==='boolean'?meta.hasMore:currentPage*pageSize<total);
  },[api]);
  const loadSettings=useCallback(async()=>{
    const value=await api('/api/admin/assistant/settings');
    setSettings(validateAssistantSettings(value));
  },[api]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>()=>{pumpEpoch.current+=1;requestController.current?.abort();},[]);
  useEffect(()=>{
    if(!open)return;
    let live=true;setLoading(true);setError('');
    Promise.all([loadSettings(),loadThreads()]).catch(cause=>{if(live)setError(cause.message || 'No se pudo cargar Ali.');}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[open,loadSettings,loadThreads]);
  useEffect(()=>{
    if(!open)return;
    const refreshOnFocus=()=>{void Promise.all([loadSettings(),loadThreads()]).catch(cause=>setError(cause.message || 'No se pudo actualizar el estado de Ali.'));};
    window.addEventListener('focus',refreshOnFocus);
    return()=>window.removeEventListener('focus',refreshOnFocus);
  },[open,loadSettings,loadThreads]);
  useEffect(()=>{
    if (!open || loading) return;
    const question=listRef.current?.querySelector('[data-assistant-question]');
    (question?.querySelector('input:not(:disabled),button:not(:disabled)') || messageRef.current)?.focus({preventScroll:true});
  },[open,loading,pendingQuestion?.id,settings?.enabled]);
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
    const fresh=bridge.receipts.filter(response=>!seenReceipts.current.has(response.receipt.id));
    if(!fresh.length)return;
    for(const response of fresh)seenReceipts.current.add(response.receipt.id);
    setMessages(current=>current.map(row=>{
      const response=fresh.find(item=>item.receipt.proposalId===row.result?.proposal?.id);
      return response?{...row,result:{...row.result,receipt:response.receipt,proposal:{...row.result.proposal,state:'executed'}}}:row;
    }));
    setNotice('Cambio guardado. El comprobante está disponible en la conversación.');
    if(selectedThreadId) void api(`/api/admin/assistant/threads/${encodeURIComponent(selectedThreadId)}`).then(value=>{
      setThread(current=>(current?.thread?.id||current?.id)===selectedThreadId?value:current);
    }).catch(()=>{});
    void loadThreads().catch(()=>{});
  },[bridge.receipts,selectedThreadId,api,loadThreads]);

  async function openThread(id) {
    pauseWork();setWork(null);workRef.current=null;setReadPage(null);
    const sequence=++historyRequest.current;
    setLoading(true);setError('');setNotice('');
    try {
      const value=await api(`/api/admin/assistant/threads/${encodeURIComponent(id)}`);
      if(sequence!==historyRequest.current)return;
      const history=publicTurns(value);
      setThread(value);setMessages(history);setTurnsBefore(historyCursor(value));setTurnsHasMore(historyMore(value));
      setAnswerText('');setAnswerOption('');
      const active=(value.turns||[]).find(turn=>turn.state==='running');
      if(active){const status=validateAssistantTurnStatus(await api(`/api/admin/assistant/turns/${encodeURIComponent(active.id)}`));if(sequence===historyRequest.current)publishStatus(status,{force:true});}
    } catch(cause) { setError(cause.message || 'No se pudo abrir la conversación.'); }
    finally { if(sequence===historyRequest.current)setLoading(false); }
  }
  async function loadOlderTurns(){
    if(!selectedThreadId || !turnsBefore || loading)return;
    const sequence=historyRequest.current;
    setLoading(true);setError('');
    try{
      const value=await api(`/api/admin/assistant/threads/${encodeURIComponent(selectedThreadId)}?before=${encodeURIComponent(turnsBefore)}`);
      if(sequence!==historyRequest.current)return;
      const older=publicTurns(value);
      if(listRef.current)preserveScroll.current={height:listRef.current.scrollHeight,top:listRef.current.scrollTop};
      setMessages(current=>{const existing=new Set(current.map(row=>row.key));return [...older.filter(row=>!existing.has(row.key)),...current];});
      setTurnsBefore(historyCursor(value));setTurnsHasMore(historyMore(value));
    }catch(cause){setError(cause.message || 'No se pudo cargar el historial anterior.');}
    finally{if(sequence===historyRequest.current)setLoading(false);}
  }
  function startThread(){
    pauseWork();setWork(null);workRef.current=null;setReadPage(null);
    historyRequest.current+=1;requestRef.current=null;setThread(null);setMessages([]);
    setTurnsBefore(null);setTurnsHasMore(false);setAnswerText('');setAnswerOption('');setError('');setNotice('');
  }
  async function deleteThread(item) {
    const identity=item?.thread || item;
    if(sending || !identity?.id || !window.confirm('¿Borrar esta conversación y sus propuestas?'))return;
    setLoading(true);setError('');
    try {
      await api(`/api/admin/assistant/threads/${encodeURIComponent(identity.id)}`,{method:'DELETE',body:JSON.stringify({version:identity.version})});
      if(selectedThreadId===identity.id)startThread();
      await loadThreads();
    } catch(cause){setError(cause.message || 'No se pudo borrar la conversación.');}
    finally{setLoading(false);}
  }
  async function loadOlderThreads(){
    setLoading(true);
    try { await loadThreads(historyPage+1,true); }
    catch(cause){setError(cause.message || 'No se pudieron cargar más conversaciones.');}
    finally{setLoading(false);}
  }
  function contextNow(){
    const form=bridge.getActiveForm();
    return {view,selection:bridge.getSelection?.(view)??null,form:form?{formId:form.formId,target:form.target,entityId:form.entityId,recordVersion:form.recordVersion,generation:form.generation,values:form.values,dirty:form.dirty,busy:form.busy}:null};
  }
  function pauseWork(){pumpEpoch.current+=1;requestController.current?.abort();setSending(false);}
  useEffect(()=>{if(!open)pauseWork();else if(workRef.current?.state==='running')void recoverStatus(workRef.current.turnId).catch(cause=>setError(cause.message));},[open]);
  function publishStatus(status,{epoch=pumpEpoch.current,force=false}={}){
    const prior=workRef.current;
    if(epoch!==pumpEpoch.current || (!force && prior?.turnId!==status.turnId))return null;
    if(prior?.turnId===status.turnId && (prior.revision>status.revision || (prior.state!=='running'&&status.state==='running')))return prior;
    workRef.current=status;setWork(status);
    setThread(current=>{const base=current?.thread||current||{};return {...base,id:status.threadId,version:status.threadVersion};});
    if(status.result){
      const result=validateTurnResult(status.result);
      setThread(current=>{const base=current?.thread||current||{};return {...base,id:result.threadId,version:result.threadVersion,data:{...base.data,pendingQuestion:result.question,workMemory:{...base.data?.workMemory,followUps:result.followUps||[]}}};});
      setMessages(current=>[...current.filter(row=>row.result?.turnId!==result.turnId),{key:`turn-${result.turnId}`,role:'assistant',result}]);
    }
    return status;
  }
  async function recoverStatus(id){
    const epoch=pumpEpoch.current;
    const status=validateAssistantTurnStatus(await api(`/api/admin/assistant/turns/${encodeURIComponent(id)}`));
    return publishStatus(status,{epoch});
  }
  async function pump(initial){
    const epoch=++pumpEpoch.current;let status=initial;
    setSending(true);setError('');
    try{
      while(status.state==='running' && openRef.current && epoch===pumpEpoch.current){
        if(document.hidden)break;
        const attempt=advanceAttempt.current?.turnId===status.turnId && advanceAttempt.current.version===status.revision?advanceAttempt.current:{turnId:status.turnId,version:status.revision,requestId:uid()};
        advanceAttempt.current=attempt;
        const controller=new AbortController();requestController.current=controller;
        let polling=false;
        const timer=setInterval(()=>{if(document.hidden||polling||epoch!==pumpEpoch.current)return;polling=true;void api(`/api/admin/assistant/turns/${encodeURIComponent(status.turnId)}`).then(value=>{if(epoch===pumpEpoch.current && workRef.current?.turnId===status.turnId)publishStatus(validateAssistantTurnStatus(value),{epoch});}).catch(()=>{}).finally(()=>{polling=false;});},1000);
        try{
          status=validateAssistantTurnStatus(await api(`/api/admin/assistant/turns/${encodeURIComponent(status.turnId)}/advance`,{method:'POST',signal:controller.signal,body:JSON.stringify({requestId:attempt.requestId,version:attempt.version})}));
        }catch(cause){
          if(epoch!==pumpEpoch.current)return;
          status=await recoverStatus(status.turnId);
          if(!status || epoch!==pumpEpoch.current)return;
          if(status.state==='running'){setNotice('Conexión interrumpida. Puedes continuar desde el avance guardado.');break;}
        }finally{clearInterval(timer);}
        if(epoch!==pumpEpoch.current)return;
        publishStatus(status);
        if(status.state==='running' && status.revision===attempt.version){
          setNotice('Hay otro avance en curso. Puedes recuperar su estado antes de continuar.');
          break;
        }
        if(status.revision!==attempt.version)advanceAttempt.current=null;
      }
      if(status.result && epoch===pumpEpoch.current){
        const result=status.result,expectedForms=requestRef.current?.initialForms||[];
      if(result.proposal?.execution==='automatic' && proposalPending(result.proposal) && !result.receipt && !requestController.current?.signal.aborted){
        const proposal=result.proposal;
        if(!automaticAttempts.current.has(proposal.id)){
          automaticAttempts.current.add(proposal.id);
          executeAttempts.current.set(proposal.id,{proposal,confirmation:null});
          try{
            const executed=await bridge.executeAutomaticProposal(proposal,expectedForms);
            if(!executed.saved){executeAttempts.current.delete(proposal.id);setNotice('El formulario cambió o necesita revisión. No se guardó automáticamente; revisa la propuesta.');}
            else {executeAttempts.current.delete(proposal.id);if(executed.postCommitError)setError('El cambio está guardado y tiene comprobante, pero no se pudo actualizar el editor. Recarga el registro antes de editar de nuevo.');}
          }catch(cause){
            setError(`${cause.message || 'No se pudo recuperar el guardado.'} Si la conexión se interrumpió, recupera el comprobante antes de repetir el cambio.`);
          }
        }
      }

        requestRef.current=null;setAnswerText('');setAnswerOption('');
        void Promise.all([loadThreads(),loadSettings()]).catch(()=>{});
      }
    }catch(cause){if(epoch===pumpEpoch.current)setError(cause.message||'No se pudo recuperar el avance.');}
    finally{if(epoch===pumpEpoch.current){requestController.current=null;setSending(false);}}
  }
  async function sendTurn({text,answer=null,continueFromTurnId=null}={}){
    const selectedLabel=answer&&pendingQuestion?.id===answer.questionId?pendingQuestion.options?.find(option=>option.id===answer.optionId)?.label:null;
    const content=continueFromTurnId?'Completar análisis':String(answer?(text||answer.text||selectedLabel||'Respuesta a la pregunta'):(text??message)).trim();
    if(!settings?.enabled||sending||loading||workRef.current?.state==='running'||!content)return;
    const body=continueFromTurnId?{threadId:selectedThreadId,threadVersion:thread?.thread?.version??thread?.version??null,continueFromTurnId}:{threadId:selectedThreadId,threadVersion:thread?.thread?.version??thread?.version??null,message:content,context:contextNow(),answer};
    const key=fingerprint(body),prior=requestRef.current;
    const input=prior?.fingerprint===key?prior.body:JSON.parse(fingerprint({requestId:uid(),...body}));
    requestRef.current={body:input,fingerprint:key,turnId:prior?.fingerprint===key?prior.turnId:null,initialForms:prior?.fingerprint===key?prior.initialForms:bridge.snapshot()};
    setSending(true);setError('');
    const epoch=pumpEpoch.current;
    try{
      let status;
      try{status=validateAssistantTurnStatus(await api('/api/admin/assistant/turns',{method:'POST',body:JSON.stringify(input)}));}
      catch(cause){
        if(epoch!==pumpEpoch.current || !openRef.current)return;
        if(prior?.body.requestId===input.requestId && prior.turnId)status=await recoverStatus(prior.turnId);
        else status=validateAssistantTurnStatus(await api('/api/admin/assistant/turns',{method:'POST',body:JSON.stringify(input)}));
      }
      if(!status)return;
      if(epoch!==pumpEpoch.current||!openRef.current)return;
      if(requestRef.current?.body.requestId===input.requestId)requestRef.current.turnId=status.turnId;
      setMessages(current=>current.some(row=>row.key===`turn-${status.turnId}-user`)?current:[...current,{key:`turn-${status.turnId}-user`,role:'user',text:content}]);
      if(!answer&&!continueFromTurnId)setMessage('');
      publishStatus(status,{epoch,force:true});await pump(status);
    }catch(cause){if(epoch===pumpEpoch.current){setError(cause.message||'No se pudo iniciar la consulta. Reintenta para recuperar la misma solicitud.');setSending(false);}}
  }
  async function continueWork(){
    if(!workRef.current||sending)return;
    try{const status=await recoverStatus(workRef.current.turnId);if(status)await pump(status);}catch(cause){setError(cause.message);setSending(false);}
  }
  async function showRecords(result,cursor=null){
    const history=historyRequest.current;setReading(true);setError('');
    try{const page=validateAssistantReadPage(await api(`/api/admin/assistant/turns/${encodeURIComponent(result.turnId)}/reads/all${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`));if(history===historyRequest.current)setReadPage({turnId:result.turnId,...page});}
    catch(cause){setError(cause.message||'No se pudieron recuperar los registros.');}finally{setReading(false);}
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
    const current=workRef.current;if(!current||stopping)return;
    setStopping(true);setError('');const epoch=++pumpEpoch.current;
    const requestId=stopAttempt.current?.turnId===current.turnId?stopAttempt.current.requestId:uid();stopAttempt.current={turnId:current.turnId,requestId};
    try{
      let status;
      try{status=validateAssistantTurnStatus(await api(`/api/admin/assistant/turns/${encodeURIComponent(current.turnId)}/cancel`,{method:'POST',body:JSON.stringify({requestId})}));}
      catch(cause){status=await recoverStatus(current.turnId);if(!status)return;if(status.state==='running')throw cause;}
      if(epoch!==pumpEpoch.current || workRef.current?.turnId!==current.turnId)return;
      pauseWork();publishStatus(status);stopAttempt.current=null;
    }catch(cause){if(epoch===pumpEpoch.current)setError(cause.message||'No se pudo detener; puedes reintentar.');}finally{setStopping(false);if(workRef.current?.turnId===current.turnId)setSending(false);}
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
    setError('');
    try {
      const current=bridge.getActiveForm();
      const binding=bindingFor(current);
      const bound=Boolean(current && proposal.formId===current.formId && proposal.target===current.target
        && (proposal.entityId??null)===(current.entityId??null) && (proposal.recordVersion??null)===(current.recordVersion??null)
        && proposal.generation===current.generation);
      let outcome;
      if(bound) {
        const cancelled=await bridge.cancelProposalFromForm(current.formId,proposal,binding);
        if(cancelled?.receipt){setNotice('Este cambio ya estaba guardado. Recupera su comprobante en el historial.');await openThread(selectedThreadId);return;}
        if(!cancelled?.cancelled)throw new Error('El formulario cambió y no se pudo cancelar la propuesta vinculada.');
        outcome=cancelled.result;
      } else {
        outcome=await bridge.cancelBoundProposal(proposal);
        if(outcome?.receipt || (outcome?.proposal || outcome)?.state==='executed'){setNotice('Este cambio ya estaba guardado. Recupera su comprobante en el historial.');await openThread(selectedThreadId);return;}
      }
      const cancelledProposal=validateProposalDTO(outcome?.proposal || outcome);
      if(cancelledProposal.state!=='cancelled')throw new Error('No se confirmó la cancelación de la propuesta.');
      for(const form of bridge.snapshot())bridge.invalidateProposal(form.formId,proposal.id);
      setMessages(current=>current.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:cancelledProposal}}:row));
      setThread(current=>{const base=current?.thread||current||{},memory=base.data?.workMemory||{};return{...base,data:{...base.data,workMemory:{...memory,followUps:(memory.followUps||[]).filter(item=>item.id!==`proposal:${proposal.id}`)}}};});
    }catch(cause){setError(cause.message || 'No se pudo cancelar la propuesta.');}
  }
  async function applyProposal(proposal) {
    const current=bridge.getActiveForm();
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
      const linked=validateProposalDTO(result.proposal || result);
      if(!bridge.bindProposalToForm(current.formId,linked,expected)
        || !bridge.applyProposalToForm(current.formId,linked,expected))throw new Error('El formulario cambió mientras se aplicaba la propuesta. No se modificaron sus valores.');
      setMessages(old=>old.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:linked}}:row));
      onClose();
    }catch(cause){setError(cause.message || 'No se pudo aplicar la propuesta.');}
    finally{setLoading(false);}
  }
  async function reviseProposal(proposal) {
    const current=bridge.getActiveForm();
    if(!current || current.target!==proposal.target || (current.entityId??null)!==(proposal.entityId??null)){setError('Abre el formulario correspondiente para revisar la propuesta.');return;}
    setLoading(true);setError('');
    try {
      const binding=bindingFor(current),key=JSON.stringify([proposal.version,current]);
      let attempt=rebaseAttempts.current.get(proposal.id);
      if(!attempt||attempt.key!==key){attempt={key,requestId:uid()};rebaseAttempts.current.set(proposal.id,attempt);}
      const response=await api(`/api/admin/assistant/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',body:JSON.stringify({decision:'apply',version:proposal.version,requestId:attempt.requestId,formBinding:binding,formSnapshot:current})});
      const revised=validateProposalDTO(response.proposal,{formContext:{view,form:current}});
      rebaseAttempts.current.delete(proposal.id);
      setMessages(old=>old.map(row=>row.result?.proposal?.id===proposal.id?{...row,result:{...row.result,proposal:revised}}:row));
    }catch(cause){setError(cause.message || 'No se pudo revisar la propuesta.');}
    finally{setLoading(false);}
  }
  function openProposal(proposal){
    bridge.handleProposalOpen({requestId:uid(),proposalId:proposal.id,open:proposal.open});
  }
  function guardedLink(event,href){
    event.preventDefault();
    const next=internalView(href);
    if(!next){setError('El destino no pertenece a una sección válida de la aplicación.');return;}
    if(onNavigate?.(next)===true)onClose();
  }
  async function executeProposal(proposal){
    if(loading||sending)return;
    if(bridge.snapshot().some(form=>form.target===proposal.target && form.entityId===(proposal.entityId??null))){
      setError('Revisa y guarda desde el formulario abierto para conservar sus cambios y confirmaciones.');return;
    }
    const prior=executeAttempts.current.get(proposal.id);
    if(!prior && !window.confirm(`¿Confirmar este cambio?\n\n${proposal.moneyCurrency.before!==proposal.moneyCurrency.after?`Moneda: ${proposal.moneyCurrency.before||'Sin verificar'} → ${proposal.moneyCurrency.after||'Sin verificar'}\n`:''}${[...(proposal.diff||[]),...(proposal.humanDiff||[])].map(item=>`${item.label||item.field}: ${formatAssistantChangeValue(item.field,item.before,proposal.moneyCurrency.before)} → ${formatAssistantChangeValue(item.field,item.after,proposal.moneyCurrency.after)}`).join('\n')}`))return;
    const confirmation=prior ? prior.confirmation : (proposal.execution==='automatic'?null:{proposalId:proposal.id,payloadHash:proposal.payloadHash});
    executeAttempts.current.set(proposal.id,{proposal,confirmation});
    setLoading(true);setError('');
    try{await bridge.executeUnboundProposal(prior?.proposal || proposal,confirmation);executeAttempts.current.delete(proposal.id);}
    catch(cause){setError(`${cause.message || 'No se pudo recuperar el guardado.'} Puedes recuperar el resultado con la misma propuesta.`);}
    finally{setLoading(false);}
  }
  function renderResult(result,preview=false){
    const evidence=new Map((result.evidence||[]).map(item=>[item.id,item]));
    return <div className={styles.result} data-testid="assistant-result">
      {result.analysis&&<section className={styles.analysisScope} aria-label="Alcance consultado"><strong>{result.analysis.status==='partial'?'Respuesta parcial':result.analysis.status==='empty'?'Sin datos consultados':'Análisis completado'}</strong><p>Contexto de origen: {adminLocationLabel(result.analysis.scope.view||{section:'home'})}</p>{result.analysis.scope.datasets.map((dataset,index)=><p key={index}>{topicLabels[dataset.domain]||dataset.domain}{dataset.resource?` · ${dataset.resource}`:''}{dataset.recordId?` · Registro: ${dataset.recordId}`:''}{dataset.startDate?` · Desde ${dataset.startDate} hasta ${dataset.endDateExclusive} (exclusivo)`:''}{dataset.asOf?` · Corte: ${dataset.asOf}`:''}{dataset.filters&&Object.entries(dataset.filters).map(([key,value])=><span key={key}> · {key}: {displayValue(value)}</span>)}</p>)}{result.analysis.reason&&<p>{({quick_budget:'Se completó la revisión rápida. Queda trabajo por revisar.',work_budget:'Se alcanzó el presupuesto de esta ampliación.',user_stopped:'Análisis detenido. Esto es lo revisado.',provider_unavailable:'No se pudo completar la interpretación con el proveedor.',context_capacity:'Queda información por analizar.',invalid_answer:'No se pudo validar la interpretación.',no_progress:'No se obtuvo información nueva.',source_changed:'La fuente cambió durante la revisión.',interrupted:'La revisión se interrumpió.'})[result.analysis.reason]}</p>}{result.analysis.remaining.length>0&&<><strong>Pendiente de revisar</strong><ul>{result.analysis.remaining.map(item=><li key={item.id}>{item.label}</li>)}</ul></>}{!preview&&result.analysis.canContinue&&<button type="button" disabled={sending||loading||work?.state==='running'} onClick={()=>void sendTurn({continueFromTurnId:result.turnId})}>{result.analysis.reason==='user_stopped'?'Retomar análisis':'Completar análisis'}</button>}{!preview&&result.analysis.scope.datasets.length>0&&<button type="button" disabled={reading} onClick={()=>void showRecords(result)}>Ver registros consultados</button>}</section>}
      {(result.blocks||[]).map((block,index)=><section className={styles.block} key={`${result.turnId}-block-${index}`}>
        {block.type==='analysis'&&<><strong>{block.kind==='interpretation'?'Interpretación de Ali':block.kind==='recommendation'?'Sugerencia':'Explicación'}</strong><p>{block.segments.map((segment,segmentIndex)=>{if(segment.type==='text')return <span key={segmentIndex}>{segment.text}</span>;const item=evidence.get(segment.evidenceId);return item?<button type="button" className={styles.evidenceReference} key={segmentIndex} onClick={event=>{const source=event.currentTarget.closest('[data-testid=assistant-result]')?.querySelector(`[data-source-id="${CSS.escape(item.id)}"]`);if(source){source.closest('details').open=true;source.focus();source.scrollIntoView({block:'nearest'});}}}>{segment.display==='label'?item.label:(item.formattedValue??displayValue(item.value))}</button>:null;})}</p></>}
        {block.type==='text'&&<p>{block.text}</p>}
        {block.type==='fact'&&<><strong>{block.title}</strong><ul>{block.evidenceIds.map(id=>{const item=evidence.get(id);return item?<li key={id}>{item.label}: {item.formattedValue ?? displayValue(item.value)}{safeHref(item.href)&&<> · <a href={safeHref(item.href)}>{item.domain==='application'?'Abrir ayuda':'Abrir registro'}</a></>}</li>:null;})}</ul></>}
        {block.type==='recommendation'&&<><strong>{block.title}</strong><p>{block.reason}</p>{block.evidenceIds.map(id=>{const item=evidence.get(id);return item?<div className={styles.source} key={id}><span>{item.label}: {item.formattedValue ?? displayValue(item.value)}</span>{safeHref(item.href)&&<a href={safeHref(item.href)}>Fuente</a>}</div>:null;})}<a className={styles.actionLink} href={safeHref(block.href)}>{block.actionLabel}</a></>}
        {block.type==='guide'&&<><strong>{block.title}</strong><ol>{block.steps.map(step=><li key={step.id}>{step.text}</li>)}</ol><a href={safeHref(block.href)}>Ir a esta sección</a></>}
      </section>)}
      {result.evidence?.length>0&&<details className={styles.evidence}><summary>Fuentes ({result.evidence.length})</summary><ul>{result.evidence.map(item=><li key={item.id} data-source-id={item.id} tabIndex={-1}><span>{item.label}: {item.formattedValue ?? displayValue(item.value)}</span>{item.unit&&<small>Unidad: {item.unit}</small>}{item.asOf&&<small>Corte: {item.asOf}</small>}{item.coverage?.state!=='complete'&&<small>Cobertura {item.coverage?.state==='partial'?'parcial':'desconocida'}{item.coverage?.reasons?.length?`: ${item.coverage.reasons.join('; ')}`:''}</small>}{safeHref(item.href)&&<a href={safeHref(item.href)}>Abrir fuente</a>}</li>)}</ul></details>}
      {!preview&&result.proposal&&!result.receipt&&<ProposalCard proposal={result.proposal} onOpen={()=>openProposal(result.proposal)} onApply={()=>void applyProposal(result.proposal)} onRevise={()=>void reviseProposal(result.proposal)} onExecute={()=>void executeProposal(result.proposal)} onCancel={()=>void cancelProposal(result.proposal)} busy={loading||sending||!settings?.enabled} activeForm={activeForm}/>}
      {!preview&&result.receipt&&<section className={styles.receipt} aria-label="Comprobante de cambio guardado"><strong>Cambio guardado</strong><p>{result.receipt.summary}</p><small>{result.receipt.committedAt}</small>{safeHref(result.receipt.href)&&<a href={safeHref(result.receipt.href)}>Abrir registro guardado</a>}</section>}
    </div>;
  }
  return <dialog ref={dialogRef} className={styles.dialog} aria-label="Ali, asistente del negocio">
    <div className={styles.console} onClick={event=>{const link=event.target.closest?.('a[href]');if(link)guardedLink(event,link.getAttribute('href'));}}>
      <header className={styles.header}><div><span className={styles.eyebrow}>Ali</span><h2>{brandName?`Asistente de ${brandName}`:'Asistente del negocio'}</h2><p>{settings?.enabled?'Consulta con información de tu negocio.':'Configura y habilita Ali para iniciar una conversación.'}</p></div><button type="button" data-dialog-initial-focus className={styles.close} onClick={onClose} aria-label="Cerrar asistente">×</button></header>
      {!thread&&<section className={styles.history} aria-label="Conversaciones anteriores"><div className={styles.historyHead}><h3>Conversaciones</h3><button type="button" disabled={loading} onClick={startThread}>Nueva conversación</button></div>{loading&&<p role="status">Cargando…</p>}{threads.map(item=>{const row=item.thread||item;return <div className={styles.threadRow} key={row.id}><button type="button" disabled={sending||loading} onClick={()=>void openThread(row.id)}><span>{row.data?.title || row.title || 'Conversación'}</span><small>{topicLabels[row.data?.topic || row.topic] || ''}</small></button><button type="button" disabled={sending||loading} aria-label="Borrar conversación" onClick={()=>void deleteThread(item)}>Borrar</button></div>;})}{historyHasMore&&<button type="button" disabled={sending||loading} onClick={()=>void loadOlderThreads()}>Ver conversaciones anteriores</button>}</section>}
      {thread&&<div className={styles.threadTools}><button type="button" disabled={loading} onClick={startThread}>‹ Conversaciones</button><strong>{threadData.title || 'Conversación'}</strong><button type="button" disabled={sending||loading} onClick={()=>void deleteThread(thread)}>Borrar</button></div>}
      <p className={styles.contextLine}>Estás en: {adminLocationLabel(view || {section:'home'})}{threadData.topic&&<> · Estamos revisando: {topicLabels[threadData.topic] || 'Negocio'}</>}</p>
      {thread&&(workMemory.goal||followUps.length>0)&&<details className={styles.workPlan} aria-label="Objetivo y siguientes pasos"><summary className={styles.workPlanHead}><strong>Objetivo y siguientes pasos</strong><span>{followUps.length?` · ${followUps.length} por revisar`:' · Sin seguimientos'}</span></summary>{workMemory.goal&&<p>{workMemory.goal}</p>}{followUps.length>0&&<ol className={styles.workPlanList}>{followUps.map(item=><li key={item.id}>{['action','task','receipt'].includes(item.kind)&&safeHref(item.href)?<a href={safeHref(item.href)}><span>{item.title}</span><small>{item.description}</small><em>{item.kind==='receipt'?'Guardado':'Sugerido'}</em></a>:<button type="button" onClick={event=>focusFollowUp(item,event)}><span>{item.title}</span><small>{item.description}</small><em>{item.state==='pending'?'Pendiente':'Sugerido'}</em></button>}</li>)}</ol>}<small className={styles.memoryNote}>Ali recuerda el objetivo y las respuestas de esta conversación. Verifica los datos actuales antes de actuar.</small></details>}
      {pendingOpen&&<div className={styles.contextLine} role="status"><span>Solicitud contextual pendiente: {pendingOpen.target || pendingOpen.type || 'formulario'}.</span>{pendingOpen.view&&<button type="button" onClick={()=>onNavigate?.(pendingOpen.view)}>Ir a la sección</button>}<button type="button" onClick={()=>bridge.acknowledgeOpen(pendingOpen.requestId)}>Descartar aviso</button></div>}
      <div className={styles.messages} ref={listRef} aria-live="off">
        {turnsHasMore&&<button type="button" className={styles.olderTurns} disabled={loading||sending||!turnsBefore} onClick={()=>void loadOlderTurns()}>Cargar mensajes anteriores</button>}
        {!messages.length&&<div className={styles.empty}><h3>¿Qué necesitas revisar?</h3><p>Puedo consultar información registrada y ayudarte con formularios. Los cambios descriptivos autorizados pueden guardarse si el formulario está limpio; los demás se revisan antes de confirmar.</p>{settings&&!settings.enabled&&<><p role="status">Ali está deshabilitado o no tiene una conexión lista.</p><button type="button" onClick={()=>onNavigate?.({section:'business',tab:'assistant'})}>Abrir configuración de Ali</button></>}{settings?.enabled&&<div className={styles.quickStarts} aria-label="Ideas para empezar">{activeForm&&<button type="button" onClick={()=>startSuggestedMessage('Ayúdame a completar este formulario con los datos disponibles; pregunta lo que falte.')}>Completar este formulario</button>}{quickStarts.map(item=><button type="button" key={item.label} onClick={()=>startSuggestedMessage(item.message)}>{item.label}</button>)}</div>}</div>}
        {messages.map(row=><article className={`${styles.message} ${row.role==='user'?styles.userMessage:styles.assistantMessage}`} key={row.key} data-assistant-turn={row.result?.turnId||undefined}><span className={styles.speaker}>{row.role==='user'?'Tú':'Ali'}</span>{row.role==='user'?<p>{row.text}</p>:renderResult(row.result)}</article>)}
        {pendingQuestion&&<form className={styles.question} data-assistant-question={pendingQuestion.id} onSubmit={event=>submitAnswer(event,pendingQuestion)}><label htmlFor={`answer-${pendingQuestion.id}`}>{pendingQuestion.prompt}</label>{pendingQuestion.options?.length>0&&<div className={styles.options}>{pendingQuestion.options.map(option=><label key={option.id}><input type="radio" disabled={!settings?.enabled||sending||loading||work?.state==='running'} name={`answer-${pendingQuestion.id}`} checked={answerOption===option.id} onChange={()=>{setAnswerOption(option.id);setAnswerText('');}}/>{option.label}</label>)}</div>}{pendingQuestion.allowText&&<input id={`answer-${pendingQuestion.id}`} disabled={!settings?.enabled||sending||loading||work?.state==='running'} type={pendingQuestion.input} value={answerText} onChange={event=>{setAnswerText(event.target.value);setAnswerOption(null);}} placeholder="Escribe tu respuesta" maxLength={pendingQuestion.input==='text'?8000:undefined}/>}<button type="submit" disabled={!settings?.enabled||sending||loading||(!pendingQuestion.options?.some(option=>option.id===answerOption)&&(!pendingQuestion.allowText||!answerText.trim()))}>Responder</button></form>}
        {work?.state==='running'&&<section className={styles.progress} data-testid="assistant-progress" aria-label="Progreso del análisis"><p role="status">{stopping?'Deteniendo…':phaseLabels[work.phase]}</p><ol>{['planning','reading','analyzing','answering'].map(phase=><li key={phase} aria-current={phase===work.phase?'step':undefined}>{phaseLabels[phase]}</li>)}</ol><p aria-live="off">Lecturas completadas: {work.progress.readsCompleted} · Registros revisados: {work.progress.recordsRead}{work.progress.recordsTotal!==null?` de ${work.progress.recordsTotal}`:''}{work.progress.currentLabel?` · ${work.progress.currentLabel}`:''}</p>{!sending&&<><button type="button" disabled={stopping} onClick={()=>void continueWork()}>Continuar</button><button type="button" disabled={stopping} onClick={()=>void cancelTurn()}>Responder con lo revisado</button></>}{work.preview&&renderResult(work.preview,true)}</section>}
        {readPage&&<section className={styles.readPage} data-testid="assistant-read-page" aria-label="Registros consultados"><h3 tabIndex={-1}>Registros consultados</h3><ul>{readPage.records.map((record,index)=><li key={record.id||index}>{Object.entries(record).map(([key,value])=><p key={key}><strong>{key}: </strong>{displayValue(value)}</p>)}</li>)}</ul><p>{readPage.retrieval.recordsRead} registros revisados{readPage.pagination.total!==null?` · Total: ${readPage.pagination.total}`:''}</p>{readPage.pagination.nextCursor&&<button type="button" disabled={reading} onClick={()=>void showRecords({turnId:readPage.turnId},readPage.pagination.nextCursor)}>Siguiente página</button>}<button type="button" onClick={()=>setReadPage(null)}>Cerrar registros</button></section>}
        {bridge.receipts.slice(-1).filter(response=>!messages.some(row=>row.result?.receipt?.id===response.receipt.id)).map(({receipt})=><section className={styles.receipt} key={receipt.id} aria-label="Último comprobante guardado"><strong>Cambio guardado</strong><p>{receipt.summary}</p>{safeHref(receipt.href)&&<a href={safeHref(receipt.href)}>Abrir registro guardado</a>}</section>)}
      </div>
      {notice&&<div className={styles.notice} role="status"><span>{notice}</span>{selectedThreadId&&<button type="button" disabled={loading||sending} onClick={()=>void openThread(selectedThreadId)}>Recuperar historial</button>}<button type="button" onClick={()=>setNotice('')}>Cerrar aviso</button></div>}
      {error&&<div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={()=>setError('')}>Cerrar aviso</button></div>}
      <p className={styles.privacyNotice}>Tu consulta, la memoria y los campos asistibles pueden enviarse al proveedor configurado. Evita datos sensibles.</p>
      <form className={styles.composer} onSubmit={submitMessage}><label className={styles.visuallyHidden} htmlFor="assistant-message">Mensaje para Ali</label><textarea id="assistant-message" ref={messageRef} value={message} onChange={event=>setMessage(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form?.requestSubmit();}}} maxLength={8000} rows={2} placeholder="Escribe tu consulta…" disabled={!settings?.enabled||sending||loading||work?.state==='running'}/><div className={styles.composerActions}><span>Enter para enviar · Shift+Enter para una línea nueva</span><div>{work?.state==='running'&&<button type="button" disabled={stopping} onClick={()=>void cancelTurn()}>{stopping?'Deteniendo…':'Detener'}</button>}<button type="submit" disabled={!settings?.enabled||sending||loading||!message.trim()}>Enviar</button></div></div></form>
    </div>
  </dialog>;
}

function ProposalCard({proposal,onOpen,onApply,onRevise,onExecute,onCancel,busy,activeForm}) {
  const sameIdentity=Boolean(activeForm && activeForm.target===proposal.target && (activeForm.entityId??null)===(proposal.entityId??null));
  const exact=Boolean(sameIdentity && (proposal.recordVersion??null)===(activeForm?.recordVersion??null) && (proposal.formId==null || proposal.formId===activeForm.formId) && (proposal.generation==null || proposal.generation===activeForm?.generation));
  const executable=['automatic','confirm'].includes(proposal.execution) && !proposal.missingFields?.length;
  return <section className={styles.proposal} aria-label="Propuesta de cambio">
    <div className={styles.proposalHeader}><strong>Propuesta</strong><small>{proposal.state==='executed'?'Guardada':proposal.state==='cancelled'?'Cancelada':proposal.state==='stale'?'Requiere nueva revisión':proposal.state==='applied'?'Valores entregados; aún sin guardar':'Pendiente de revisión'}</small></div>
    <p>Destino: {proposal.target}{proposal.entityId?` · ${proposal.entityId}`:''}</p>
    {proposal.moneyCurrency.before!==proposal.moneyCurrency.after&&<p>Moneda: {proposal.moneyCurrency.before||'Sin verificar'} → {proposal.moneyCurrency.after||'Sin verificar'}. No se convierten importes.</p>}
    {proposal.diff?.length>0?<ul className={styles.diff}>{proposal.diff.map((change,index)=><li key={`${change.field}-${index}`}><strong>{change.label||assistantFieldLabel(proposal.target,change.field)}</strong><del>{formatAssistantChangeValue(change.field,change.before,proposal.moneyCurrency.before)}</del><span aria-hidden="true">→</span><ins>{formatAssistantChangeValue(change.field,change.after,proposal.moneyCurrency.after)}</ins></li>)}</ul>:<p>No hay campos modificados.</p>}
    {proposal.humanDiff?.length>0&&<><strong>Controles y revisión humana</strong><ul className={styles.diff}>{proposal.humanDiff.map((change,index)=><li key={`human-${change.field}-${index}`}><strong>{change.label||assistantFieldLabel(proposal.target,change.field)}</strong><del>{formatAssistantChangeValue(change.field,change.before,proposal.moneyCurrency.before)}</del><span aria-hidden="true">→</span><ins>{formatAssistantChangeValue(change.field,change.after,proposal.moneyCurrency.after)}</ins></li>)}</ul></>}
    {proposal.missingFields?.length>0&&<p>Falta información: {proposal.missingFields.map(field=>assistantFieldLabel(proposal.target,field)).join(', ')}</p>}
    <div className={styles.proposalActions}><button type="button" onClick={onOpen} disabled={busy}>Revisar formulario</button>
      {proposalPending(proposal)&&<><button type="button" onClick={onApply} disabled={busy||!exact||activeForm?.busy}>Aplicar valores</button><button type="button" onClick={onRevise} disabled={busy||!sameIdentity||activeForm?.busy}>Actualizar revisión</button>{executable&&<button type="button" onClick={onExecute} disabled={busy||sameIdentity}>Confirmar cambio / recuperar</button>}<button type="button" onClick={onCancel} disabled={busy}>Cancelar propuesta</button></>}
    </div>
    {proposalPending(proposal)&&<small>{sameIdentity?'Guarda desde el formulario para confirmar exactamente sus valores y controles humanos.':'Abre el formulario correcto para aplicar los valores sin guardar.'}</small>}
  </section>;
}
