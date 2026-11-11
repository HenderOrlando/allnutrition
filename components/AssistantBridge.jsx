'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { filterAssistantPatch, serializeAssistantDraft, serializeAssistantHumanAcknowledgements, validateAssistantSubmission, formatAssistantChangeValue } from '../lib/assistant/forms.mjs';
import { validateAssistantReceipt } from '../lib/assistant/contracts.mjs';

const BridgeContext = createContext(null);
const cleanIdentity = value => value == null ? null : String(value);
const cloneSnapshot = snapshot => snapshot ? { ...snapshot, values: structuredClone(snapshot.values) } : null;
const sameRecord = (left, right) => Boolean(left && right && left.formId === right.formId && left.target === right.target
  && left.entityId === right.entityId && left.recordVersion === right.recordVersion);
const sameSnapshot = (left, right, withGeneration = true) => sameRecord(left,right)
  && (!withGeneration || left.generation === right.generation);
const sameBinding = (binding, snapshot) => Boolean(binding && snapshot
  && binding.formId === snapshot.formId && binding.target === snapshot.target
  && (binding.entityId ?? null) === snapshot.entityId
  && (binding.recordVersion ?? null) === snapshot.recordVersion
  && binding.generation === snapshot.generation);
const formFingerprint = snapshot => JSON.stringify([snapshot.target,snapshot.entityId,snapshot.recordVersion,snapshot.values]);
function confirmAssistantDiff(proposal) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  const changes=[...(proposal.diff || []),...(proposal.humanDiff || [])].map(change => {
    const label=typeof change.label === 'string' && change.label.trim()
      ? change.label : String(change.field).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[._-]+/g,' ');
    return `${label}: ${formatAssistantChangeValue(change.field,change.before,proposal.moneyCurrency.before)} → ${formatAssistantChangeValue(change.field,change.after,proposal.moneyCurrency.after)}`;
  });
  if(proposal.moneyCurrency.before!==proposal.moneyCurrency.after)changes.unshift(`Moneda: ${proposal.moneyCurrency.before||'Sin verificar'} → ${proposal.moneyCurrency.after||'Sin verificar'}`);
  return window.confirm(`Revisa los cambios del formulario antes de guardar:\n\n${changes.join('\n')}`);
}

const NO_PROVIDER = Object.freeze({
  revision:0, snapshot:()=>[], registerOwner:()=>()=>{}, requestOpen:()=>null,
  handleProposalOpen:()=>{}, acknowledgeOpen:()=>{}, pendingOpen:null,
  getForm:()=>null, getActiveForm:()=>null, applyProposalToForm:()=>false,
  bindProposalToForm:()=>false, cancelProposalFromForm:async()=>({cancelled:false}), invalidateProposal:()=>{},
  registerForm:()=>()=>{}, updateForm:()=>{}, receipts:[], getAutomaticLock:()=>false,
  executeAutomaticProposal:async()=>({saved:false,reason:'unavailable'}),
  executeBoundProposal:async()=>{throw new Error('No está disponible el guardado asistido.');},
  reviseBoundProposal:async()=>{throw new Error('No hay una propuesta asistida activa.');},
  cancelBoundProposal:async()=>({cancelled:false}),
});

export function AssistantBridgeProvider({ children, onOpenAssistant, onProposalOpen, reviseProposal, cancelProposal, executeProposal, onReceipt }) {
  const forms = useRef(new Map());
  const owners = useRef(new Map());
  const activeFormId = useRef(null);
  const proposalHandlers = useRef({});
  proposalHandlers.current = { reviseProposal, cancelProposal, executeProposal, onReceipt };
  const automaticLocks = useRef(new Set());
  const receiptStore = useRef(new Map());
  const requestSequence = useRef(0);
  const [revision, setRevision] = useState(0);
  const [pendingOpen, setPendingOpen] = useState(null);
  const publish = useCallback(() => setRevision(value => value + 1), []);

  const snapshot = useCallback(() => [...forms.current.values()].filter(entry=>entry.enabled!==false).map(entry => cloneSnapshot(entry.publicSnapshot)), []);
  const getForm = useCallback(formId => { const entry=forms.current.get(formId);return entry?.enabled!==false?cloneSnapshot(entry?.publicSnapshot):null; }, []);
  const getActiveForm = useCallback(() => {
    const entry=forms.current.get(activeFormId.current);
    return cloneSnapshot((entry?.enabled!==false && entry?.publicSnapshot) || [...forms.current.values()].filter(item=>item.enabled!==false).at(-1)?.publicSnapshot || null);
  }, []);
  const registerOwner = useCallback((owner, handler) => {
    if (!owner || typeof handler !== 'function') return () => {};
    owners.current.set(owner, handler);
    return () => { if (owners.current.get(owner) === handler) owners.current.delete(owner); };
  }, []);
  const requestOpen = useCallback(request => {
    const normalized = { ...request, requestId: request?.requestId || `assistant-open-${++requestSequence.current}` };
    if (normalized.formId && forms.current.has(normalized.formId)) activeFormId.current = normalized.formId;
    setPendingOpen(normalized);
    onOpenAssistant?.(normalized);
    const handler = normalized.owner && owners.current.get(normalized.owner);
    if (handler) handler(normalized);
    return normalized.requestId;
  }, [onOpenAssistant]);
  const handleProposalOpen = useCallback(request => {
    onProposalOpen?.(request);
    const handler = request?.open?.owner && owners.current.get(request.open.owner);
    if (handler) handler(request);
  }, [onProposalOpen]);
  const acknowledgeOpen = useCallback(requestId => setPendingOpen(current => current?.requestId === requestId ? null : current), []);
  const reviseBoundProposal = useCallback((proposal, payload, binding, humanAcknowledgements, requestId) => {
    const handler = proposalHandlers.current.reviseProposal;
    if (typeof handler !== 'function') throw new Error('No está disponible la revisión de propuestas asistidas.');
    return handler({ proposal, payload, formBinding: binding, humanAcknowledgements, requestId });
  }, []);
  const executeBoundProposal = useCallback(async (proposal, confirmation) => {
    const handler=proposalHandlers.current.executeProposal;
    if (typeof handler !== 'function') throw new Error('No está disponible el guardado asistido.');
    const value=await handler(proposal,confirmation);
    const receipt=validateAssistantReceipt(value?.receipt);
    if (!receipt || receipt.proposalId!==proposal.id || receipt.target!==proposal.target || !Object.hasOwn(value,'result')) {
      throw new Error('No se recibió un comprobante válido. Recupera la propuesta antes de volver a guardar.');
    }
    const response={result:value.result,receipt};
    if (!receiptStore.current.has(response.receipt.id)) {
      receiptStore.current.set(response.receipt.id,response);
      publish();
      try { await proposalHandlers.current.onReceipt?.(response); } catch { /* The durable receipt remains available. */ }
    }
    return response;
  }, [publish]);
  const lockKey = (target,entityId) => JSON.stringify([target,entityId ?? null]);
  const getAutomaticLock = useCallback((target,entityId) => automaticLocks.current.has(lockKey(target,entityId)), []);
  const executeUnboundProposal = useCallback(async (proposal,confirmation) => {
    const key=lockKey(proposal.target,proposal.entityId);
    if (automaticLocks.current.has(key) || [...forms.current.values()].some(entry=>entry.enabled!==false
      && entry.publicSnapshot?.target===proposal.target && entry.publicSnapshot.entityId===(proposal.entityId??null))) {
      throw new Error('El formulario está abierto. Guarda desde él para conservar sus valores y confirmaciones.');
    }
    automaticLocks.current.add(key);
    publish();
    try { return await executeBoundProposal(proposal,confirmation); }
    finally {
      automaticLocks.current.delete(key);
      for(const entry of forms.current.values()) {
        if(entry.publicSnapshot?.target===proposal.target && entry.publicSnapshot.entityId===(proposal.entityId??null))entry.publish();
      }
      publish();
    }
  }, [executeBoundProposal,publish]);
  const executeAutomaticProposal = useCallback(async (proposal, expectedForms = []) => {
    if (proposal.execution!=='automatic' || !['prepared','applied'].includes(proposal.state)) return {saved:false,reason:'review'};
    const key=lockKey(proposal.target,proposal.entityId);
    const matching=[...forms.current.values()].filter(entry=>entry.enabled!==false && entry.publicSnapshot?.target===proposal.target
      && entry.publicSnapshot.entityId===(proposal.entityId ?? null));
    if(proposal.formId!=null && !matching.some(entry=>entry.formId===proposal.formId))return {saved:false,reason:'changed'};
    if (automaticLocks.current.has(key) || matching.some(entry=>{
      const current=entry.publicSnapshot;
      const expected=expectedForms.find(form=>form.formId===current.formId);
      return current.dirty || current.busy || entry.locked || typeof entry.acceptAutomaticResult!=='function'
        || !sameSnapshot(expected,current) || current.recordVersion!==proposal.recordVersion
        || (proposal.formId!=null && !sameBinding(proposal,current));
    })) return {saved:false,reason:'changed'};
    // No await may separate these checks from the local edit lock.
    automaticLocks.current.add(key);
    for (const entry of matching) { entry.locked=true; entry.publicSnapshot={...entry.publicSnapshot,busy:true}; }
    publish();
    try {
      const response=await executeBoundProposal(proposal,null);
      let postCommitError=null;
      for (const entry of forms.current.values()) {
        const current=entry.publicSnapshot;
        if (entry.enabled===false || current?.target!==proposal.target || current.entityId!==(proposal.entityId??null)
          || current.dirty || current.recordVersion!==proposal.recordVersion || typeof entry.acceptAutomaticResult!=='function'
          || entry.committedIds.has(response.receipt.id)) continue;
        entry.committedIds.add(response.receipt.id);
        try { await entry.acceptAutomaticResult(response); } catch (cause) { postCommitError=cause; }
        if (entry.assistedProposal?.id===proposal.id) {
          entry.assistedProposal=null;entry.assistedBinding=null;entry.pendingRevision=null;entry.executionAttempt=null;
        }
      }
      return {saved:true,...response,postCommitError};
    } finally {
      automaticLocks.current.delete(key);
      for (const entry of matching) { entry.locked=false; entry.publish(); }
      publish();
    }
  }, [executeBoundProposal,publish]);
  const cancelBoundProposal = useCallback(async proposal => {
    const handler = proposalHandlers.current.cancelProposal;
    if (typeof handler !== 'function') throw new Error('No está disponible la cancelación de propuestas asistidas.');
    const response=await handler({ proposal });
    if(response?.receipt || response?.state==='executed' || response?.proposal?.state==='executed')return response;
    if((response?.proposal || response)?.state!=='cancelled')throw new Error('No se confirmó la cancelación de la propuesta.');
    return response;
  }, []);
  const applyProposalToForm = useCallback((formId, proposal, expected) => {
    const entry=forms.current.get(formId), current=cloneSnapshot(entry?.publicSnapshot);
    if (!entry || !current || activeFormId.current!==formId || !sameBinding(expected,current)
      || !sameBinding(proposal,current) || entry.busy) return false;
    return entry.applyProposal?.(proposal,expected) === true;
  }, []);
  const bindProposalToForm = useCallback((formId, proposal, expected) => {
    const entry=forms.current.get(formId), current=cloneSnapshot(entry?.publicSnapshot);
    if (!entry || !current || activeFormId.current!==formId || !sameBinding(expected,current)
      || !sameBinding(proposal,current) || entry.busy) return false;
    return entry.bindProposal?.(proposal,expected) === true;
  }, []);
  const cancelProposalFromForm = useCallback((formId, proposal, expected) => {
    const entry=forms.current.get(formId), current=cloneSnapshot(entry?.publicSnapshot);
    if (!entry || !current || activeFormId.current!==formId || !sameBinding(expected,current)
      || !sameBinding(proposal,current) || entry.busy) return Promise.resolve({cancelled:false,reason:'changed'});
    return entry.cancelProposal?.(proposal,expected) || Promise.resolve({cancelled:false,reason:'unavailable'});
  }, []);
  const invalidateProposal = useCallback((formId,proposalId=null) => {
    const entry=forms.current.get(formId);
    if(!proposalId || entry?.assistedProposal?.id===proposalId || entry?.pendingRevision?.proposal?.id===proposalId)entry?.invalidateProposal?.();
  }, []);
  const registerForm = useCallback(entry => {
    forms.current.set(entry.formId, entry);
    activeFormId.current=entry.formId;
    publish();
    return () => { if (forms.current.get(entry.formId) === entry) { forms.current.delete(entry.formId); if(activeFormId.current===entry.formId)activeFormId.current=[...forms.current.keys()].at(-1)||null; publish(); } };
  }, [publish]);
  const updateForm = useCallback(entry => {
    if (forms.current.get(entry.formId) === entry) publish();
  }, [publish]);
  const value = useMemo(() => ({ revision, snapshot, registerOwner, requestOpen, handleProposalOpen,
    acknowledgeOpen, pendingOpen, getForm, getActiveForm, applyProposalToForm, bindProposalToForm,
    cancelProposalFromForm, invalidateProposal, registerForm, updateForm, reviseBoundProposal, cancelBoundProposal,
    executeBoundProposal, executeUnboundProposal, executeAutomaticProposal, getAutomaticLock, receipts:[...receiptStore.current.values()] }),
  [revision, snapshot, registerOwner, requestOpen, handleProposalOpen, acknowledgeOpen, pendingOpen,
    getForm, getActiveForm, applyProposalToForm, bindProposalToForm, cancelProposalFromForm, invalidateProposal,
    registerForm, updateForm, reviseBoundProposal, cancelBoundProposal, executeBoundProposal, executeUnboundProposal, executeAutomaticProposal, getAutomaticLock]);
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useAssistantBridge() {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('useAssistantBridge debe usarse dentro de AssistantBridgeProvider.');
  return bridge;
}

export function useAssistantForm({ target, entityId = null, recordVersion = null, values = {}, dirty = false, busy = false, applyPatch, acceptAutomaticResult, referenceChoices = null, enabled = true, generationKey = null }) {
  const contextBridge = useContext(BridgeContext);
  const bridge = contextBridge || NO_PROVIDER;
  const connected = Boolean(contextBridge);
  const { registerForm, updateForm, getForm, requestOpen, reviseBoundProposal, cancelBoundProposal, executeBoundProposal } = bridge;
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = globalThis.crypto?.randomUUID?.() || `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const generation = useRef(0);
  const previous = useRef(null);
  const callbacks = useRef({ applyPatch, busy, acceptAutomaticResult });
  callbacks.current = { applyPatch, busy, acceptAutomaticResult };
  const formId = idRef.current;
  const safeValues = serializeAssistantDraft(target, values);
  const currentSnapshot = {
    formId, target, entityId:cleanIdentity(entityId), recordVersion:recordVersion ?? null,
    generation:generation.current, values:safeValues, dirty:Boolean(dirty), busy:Boolean(busy || bridge.getAutomaticLock(target,cleanIdentity(entityId))),
  };
  const fingerprint = JSON.stringify([formFingerprint(currentSnapshot),generationKey]);
  if (previous.current && previous.current.fingerprint !== fingerprint) generation.current += 1;
  currentSnapshot.generation = generation.current;
  previous.current = { fingerprint, target, entityId:currentSnapshot.entityId, recordVersion:currentSnapshot.recordVersion };
  const registryEntry = useRef(null);
  if (!registryEntry.current) registryEntry.current = {
    formId, locked:false, pendingRevision:null, assistedProposal:null, assistedBinding:null,
    pendingApply:null, committedIds:new Set(), executionAttempt:null, revisionAttempt:null, publish:()=>{}, publicSnapshot:null,
  };
  const entry = registryEntry.current;
  entry.enabled=enabled;
  entry.acceptAutomaticResult=typeof acceptAutomaticResult==='function' ? response=>callbacks.current.acceptAutomaticResult(response) : null;
  // Publish the render snapshot synchronously: a response cannot observe the previous effect's values.
  entry.publicSnapshot=cloneSnapshot({...currentSnapshot,busy:currentSnapshot.busy || entry.locked});
  entry.renderSnapshot=cloneSnapshot(currentSnapshot);

  // Form edits invalidate a pending reviewed diff, but keep the proposal attached to the same
  // record so submitAssisted can ask the server to revise it against the new generation.
  if (entry.assistedBinding && !sameRecord(entry.assistedBinding,currentSnapshot)) {
    const sameEntity=entry.assistedBinding.formId===currentSnapshot.formId
      && entry.assistedBinding.target===currentSnapshot.target && entry.assistedBinding.entityId===currentSnapshot.entityId;
    if(!sameEntity) {
      entry.assistedProposal=null;
      entry.assistedBinding=null;
      entry.revisionAttempt=null;
      entry.executionAttempt=null;
    }
    // A sibling save may advance the version without discarding this draft. Keep its
    // proposal attached so a later submit cannot silently become an unassisted save.
    entry.pendingRevision=null;
    entry.pendingApply=null;
    if(!entry.executionAttempt)entry.locked=false;
  } else if (entry.assistedBinding && entry.assistedBinding.generation !== currentSnapshot.generation && !entry.pendingApply) {
    entry.pendingRevision = null;
    entry.assistedBinding = { ...entry.assistedBinding, generation:currentSnapshot.generation };
  }
  if (entry.pendingApply && sameRecord(entry.pendingApply.binding,currentSnapshot)
    && currentSnapshot.generation!==entry.pendingApply.binding.generation) {
    entry.assistedProposal = entry.pendingApply.proposal;
    entry.assistedBinding = { ...currentSnapshot };
    entry.pendingRevision = null;
    entry.pendingApply = null;
    entry.locked = false;
  }
  entry.publicSnapshot=cloneSnapshot({...currentSnapshot,busy:currentSnapshot.busy || entry.locked});

  const publishEntry = useCallback(() => {
    const item = registryEntry.current;
    if (!item) return;
    const live = {
      formId, target, entityId:cleanIdentity(entityId), recordVersion:recordVersion ?? null,
      generation:generation.current, values:safeValues,
      dirty:Boolean(dirty), busy:Boolean(busy || item.locked || bridge.getAutomaticLock(target,cleanIdentity(entityId))),
    };
    item.target=live.target;
    item.entityId=live.entityId;
    item.recordVersion=live.recordVersion;
    item.generation=live.generation;
    item.values=live.values;
    item.dirty=live.dirty;
    item.busy=live.busy;
    item.publicSnapshot=cloneSnapshot(live);
    updateForm(item);
  }, [updateForm,target,entityId,recordVersion,fingerprint,dirty,busy,formId]);
  entry.publish = publishEntry;
  useEffect(() => {
    if(!enabled)return;
    const item=registryEntry.current;
    item.target=currentSnapshot.target; item.entityId=currentSnapshot.entityId;
    item.recordVersion=currentSnapshot.recordVersion; item.generation=currentSnapshot.generation;
    item.values=structuredClone(currentSnapshot.values); item.dirty=currentSnapshot.dirty; item.busy=currentSnapshot.busy;
    item.publicSnapshot=cloneSnapshot(currentSnapshot);
    return registerForm(item);
  }, [registerForm,formId,enabled]);
  useEffect(() => { publishEntry(); }, [publishEntry]);

  const localSnapshot = () => ({...entry.renderSnapshot,busy:Boolean(entry.renderSnapshot.busy || entry.locked)});
  const readCurrent = () => connected ? getForm(formId) : localSnapshot();
  const openAssistant = useCallback(extra => enabled ? requestOpen({
    ...(extra || {}), type:'form-help', formId, target, entityId:cleanIdentity(entityId),
    recordVersion:recordVersion ?? null, generation:generation.current,
  }) : null, [requestOpen,formId,target,entityId,recordVersion,enabled]);

  const bindProposal = useCallback(proposal => {
    const current=readCurrent();
    if (!proposal || !current || current.busy || !sameSnapshot(current,localSnapshot())
      || !sameBinding(proposal,current)) return false;
    entry.assistedProposal=proposal;
    entry.assistedBinding={...current};
    entry.pendingRevision=null;
    return true;
  }, [formId,target,entityId,recordVersion,generation.current]);

  const applyProposal = useCallback(({ patch, proposal, expected, onConflict } = {}) => {
    const current=readCurrent();
    if (!current || !entry || entry.locked || busy || current.busy || !sameSnapshot(current,localSnapshot())
      || !sameBinding(expected,current) || !sameBinding(proposal,current)) {
      onConflict?.(current);
      return false;
    }
    if (typeof callbacks.current.applyPatch !== 'function') return false;
    let normalized;
    try {
      normalized=filterAssistantPatch(target,patch,referenceChoices
        ? {baseline:current.values,referenceChoices,allowResolvedReferences:true}
        : {allowUnresolvedReferences:true,allowResolvedReferences:true});
    } catch (error) {
      onConflict?.(current,error);
      return false;
    }
    const expectedValues={...current.values,...normalized};
    const expectedSnapshot={...current,values:expectedValues};
    entry.locked=true;
    entry.pendingApply={proposal,binding:{...current},expectedFingerprint:formFingerprint(expectedSnapshot)};
    entry.publicSnapshot=cloneSnapshot({...current,busy:true});
    updateForm(entry);
    try {
      entry.applyingPatch=true;
      const applied=callbacks.current.applyPatch(normalized);
      if(applied===false)throw new Error('El formulario no aceptó los valores propuestos.');
      entry.applyingPatch=false;
      if (entry.pendingApply && formFingerprint(current) === entry.pendingApply.expectedFingerprint) {
        entry.assistedProposal=proposal;
        entry.assistedBinding={...current};
        entry.pendingRevision=null;
        entry.pendingApply=null;
        entry.locked=false;
        entry.publish();
      }
      return true;
    } catch (error) {
      entry.applyingPatch=false;
      entry.pendingApply=null;
      entry.locked=false;
      entry.publish();
      onConflict?.(current,error);
      return false;
    }
  }, [formId,target,entityId,recordVersion,busy,updateForm,referenceChoices]);

  const cancelAssisted = useCallback(async () => {
    const proposal=entry.pendingRevision?.proposal || entry.assistedProposal;
    if (!proposal) return {cancelled:false};
    if (entry.locked) return {cancelled:false,reason:'busy'};
    const current=readCurrent();
    if (!current || current.busy || !sameRecord(entry.assistedBinding,current)) return {cancelled:false,reason:'changed'};
    entry.locked=true;
    entry.publicSnapshot=cloneSnapshot({...current,busy:true});
    updateForm(entry);
    try {
      const result=await cancelBoundProposal(proposal);
      if(result?.receipt)return {cancelled:false,receipt:result.receipt,result:result.result};
      if(result?.state==='executed' || result?.proposal?.state==='executed')return {cancelled:false,reason:'executed'};
      if (entry.assistedProposal?.id === proposal.id || entry.pendingRevision?.proposal?.id === proposal.id) {
        entry.assistedProposal=null;
        entry.assistedBinding=null;
        entry.pendingRevision=null;
      }
      return {cancelled:true,result};
    } finally {
      entry.locked=false;
      entry.publish();
    }
  }, [cancelBoundProposal,updateForm,formId,target,entityId,recordVersion]);
  entry.applyProposal = (proposal, expected) => applyProposal({ patch:proposal.patch, proposal, expected });
  entry.bindProposal = (proposal, expected) => {
    const current=readCurrent();
    if (!current || !sameSnapshot(current,localSnapshot()) || !sameBinding(expected,current) || !sameBinding(proposal,current) || current.busy) return false;
    entry.assistedProposal=proposal;
    entry.assistedBinding={...current};
    entry.pendingRevision=null;
    return true;
  };
  entry.cancelProposal = async (proposal, expected) => {
    const current=readCurrent();
    if (!current || entry.locked || !sameSnapshot(current,localSnapshot()) || !sameBinding(expected,current)
      || !sameBinding(proposal,current) || current.busy) return {cancelled:false,reason:'changed'};
    entry.locked=true;
    entry.publicSnapshot=cloneSnapshot({...current,busy:true});
    updateForm(entry);
    try {
      const result=await cancelBoundProposal(proposal);
      if(result?.receipt)return {cancelled:false,receipt:result.receipt,result:result.result};
      if(result?.state==='executed' || result?.proposal?.state==='executed')return {cancelled:false,reason:'executed'};
      if(entry.assistedProposal?.id===proposal.id || entry.pendingRevision?.proposal?.id===proposal.id) {
        entry.assistedProposal=null;entry.assistedBinding=null;entry.pendingRevision=null;entry.pendingApply=null;
      }
      return {cancelled:true,result};
    } finally { entry.locked=false;entry.publish(); }
  };
  entry.invalidateProposal = () => {
    entry.assistedProposal=null;
    entry.assistedBinding=null;
    entry.pendingRevision=null;
    entry.pendingApply=null;
    entry.publish();
  };

  const submitAssisted = useCallback(async ({ payload, saveUnassisted, onCommitted } = {}) => {
    const current=readCurrent();
    if (!current || entry.locked || current.busy || !sameSnapshot(current,localSnapshot())) return {saved:false,reason:'changed'};
    const proposal=entry.pendingRevision?.proposal || entry.assistedProposal;
    const humanOnly=target.startsWith('import-') || target.startsWith('onboarding:') || ['asset-metadata','advertising-result-action','business-action:payroll-prepare'].includes(target)
      || proposal?.execution==='human-only';
    if (proposal && !humanOnly && !entry.executionAttempt && (!sameRecord(proposal,current) || !sameRecord(entry.assistedBinding,current))) {
      throw new Error('El registro cambió desde la propuesta. Conservamos tu borrador: solicita una propuesta nueva sobre la versión actual antes de guardar.');
    }
    const binding={formId,target,entityId:cleanIdentity(entityId),recordVersion:recordVersion ?? null,generation:current.generation};
    entry.locked=true;
    entry.publicSnapshot=cloneSnapshot({...current,busy:true});
    updateForm(entry);
    const stillBound = () => {
      const latest=readCurrent();
      return latest && sameSnapshot(latest,binding) && !callbacks.current.busy && !entry.pendingApply;
    };
    const committed = async response => {
      let postCommitError=null;
      if (!entry.committedIds.has(response.receipt.id)) {
        entry.committedIds.add(response.receipt.id);
        if(entry.executionAttempt && !sameSnapshot(entry.executionAttempt.binding,binding)) {
          postCommitError=new Error('El cambio anterior ya estaba guardado. Conservamos el borrador actual sin sustituirlo por ese resultado.');
        } else {
          try { await onCommitted?.(response.result); } catch (cause) { postCommitError=cause; }
        }
      }
      entry.assistedProposal=null; entry.assistedBinding=null; entry.pendingRevision=null; entry.executionAttempt=null; entry.revisionAttempt=null;
      return {saved:true,...response,postCommitError};
    };
    try {
      if (!proposal || humanOnly) {
        if (typeof saveUnassisted!=='function') throw new TypeError('saveUnassisted es obligatorio.');
        const result=await saveUnassisted(payload);
        if (result===false) return {saved:false,result};
        let postCommitError=null;
        try { await onCommitted?.(result); } catch (cause) { postCommitError=cause; }
        return {saved:true,result,postCommitError};
      }
      // A lost execute response must recover the identical execution, never revise or save twice.
      if (entry.executionAttempt) {
        const attempt=entry.executionAttempt;
        return await committed(await executeBoundProposal(attempt.proposal,attempt.confirmation));
      }
      const normalizedPayload=validateAssistantSubmission(target,payload || {});
      const humanAcknowledgements=serializeAssistantHumanAcknowledgements(target,payload || {});
      const fingerprint=JSON.stringify([normalizedPayload,humanAcknowledgements]);
      let revision=null;
      const priorRevision=entry.revisionAttempt;
      if(priorRevision){
        revision=await reviseBoundProposal(priorRevision.proposal,priorRevision.payload,priorRevision.binding,priorRevision.humanAcknowledgements,priorRevision.requestId);
        if(!revision?.proposal || typeof revision.unchanged!=='boolean')throw new Error('No se pudo recuperar la revisión anterior.');
        entry.revisionAttempt=null;
        entry.assistedProposal=revision.proposal;
        if(!stillBound())return {saved:false,reason:'changed'};
        if(priorRevision.fingerprint!==fingerprint || !sameSnapshot(priorRevision.binding,binding))revision=null;
      }
      if(!revision){
        const attempt={
          proposal:entry.assistedProposal || proposal,payload:normalizedPayload,binding,humanAcknowledgements,fingerprint,
          requestId:globalThis.crypto?.randomUUID?.() || `revision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
        entry.revisionAttempt=attempt;
        revision=await reviseBoundProposal(attempt.proposal,attempt.payload,attempt.binding,attempt.humanAcknowledgements,attempt.requestId);
        if(!revision?.proposal || typeof revision.unchanged!=='boolean')throw new Error('La respuesta de revisión de la propuesta es inválida.');
        entry.revisionAttempt=null;
        entry.assistedProposal=revision.proposal;
      }
      if (!stillBound()) return {saved:false,reason:'changed'};
      if (!revision?.proposal || typeof revision.unchanged!=='boolean' || !sameBinding(revision.proposal,binding)) {
        throw new Error('La respuesta de revisión de la propuesta es inválida.');
      }
      const next=revision.proposal;
      entry.assistedProposal=next; entry.assistedBinding={...binding};
      const pending=entry.pendingRevision;
      const needsReview=!revision.unchanged || Boolean(pending && pending.fingerprint===fingerprint);
      if (needsReview) {
        entry.pendingRevision={proposal:next,fingerprint,binding:{...binding}};
        if (!confirmAssistantDiff(next)) return {saved:false,needsConfirmation:true,proposal:next,diff:next.diff};
        if (!stillBound() || entry.pendingRevision.proposal.payloadHash!==next.payloadHash) return {saved:false,reason:'changed'};
      }
      if (!stillBound()) return {saved:false,reason:'changed'};
      const confirmation={proposalId:next.id,payloadHash:next.payloadHash};
      entry.executionAttempt={proposal:next,confirmation,binding,fingerprint};
      return await committed(await executeBoundProposal(next,confirmation));
    } finally {
      entry.locked=false;
      entry.publish();
    }
  }, [formId,target,entityId,recordVersion,connected,updateForm,reviseBoundProposal,executeBoundProposal]);


  return {
    formId, generation:generation.current, openAssistant, bindProposal, applyProposal, cancelAssisted,
    get assistantBusy(){return Boolean((entry.locked && !entry.applyingPatch) || bridge.getAutomaticLock(entry.renderSnapshot.target,entry.renderSnapshot.entityId));},
    submitAssisted,
  };
}
