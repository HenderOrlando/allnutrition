'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantForm, validateAdvisorTarget } from './AssistantBridge';
import { orderStates, shipmentStates } from '@/lib/schema.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import useDialog from './useDialog';
import Icon from './Icons';
import { BusinessActionForm } from './BusinessActionDialog';
import ImportedData from './ImportedData';
import ShippingFinance from './ShippingFinance';
import styles from './OrderExperience.module.css';

const stateLabel=value=>shipmentStates.find(state=>state.value===value)?.label||value;
const orderStateLabel=value=>orderStates.find(state=>state.value===value)?.label||'Estado no disponible';
const orderNumber=value=>value==null?'Sin pedido vinculado':`AN-${String(value).padStart(6,'0')}`;
const dayFormatter=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeZone:'UTC'});
const bogotaDayFormatter=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeZone:'America/Bogota'});
const instantFormatter=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Bogota'});
const dateLabel=(value,showTime=true)=>value?(/^\d{4}-\d{2}-\d{2}$/.test(value)?dayFormatter:showTime?instantFormatter:bogotaDayFormatter).format(new Date(value)):'Sin corte conocido';
const localInstant=value=>value?new Date(Date.parse(value)-5*60*60*1000).toISOString().slice(0,16):'';
const fromLocal=value=>value?new Date(value+'-05:00').toISOString():null;
const dispatched=new Set(['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned']);
const shipmentDispatched=shipment=>(shipment.events||[]).some(item=>dispatched.has(item.status)&&!(shipment.events||[]).some(other=>other.correctionOf===item.id));
const rows=data=>data?.records||[];
const metadataDraft=shipment=>({carrier:shipment.carrier||'',tracking:shipment.tracking||'',estimatedDeliveryOn:shipment.estimatedDeliveryOn||'',notes:shipment.notes||'',replacesShipmentId:shipment.replacesShipmentId||'',assignments:Object.fromEntries((shipment.assignments||[]).map(line=>[line.lineId,line.quantity])),reason:''});
const eventDraft=shipment=>({status:shipment.status,precision:'day',occurredOn:'',occurredAt:'',sourceAsOf:localInstant(new Date().toISOString()),reason:'',detail:'',correctionOf:''});
const sourceLabel=(shipment,sourceId)=>sourceId?(sourceId===shipment.sourceId&&shipment.sourceName?`${shipment.sourceName} · ${sourceId}`:`Fuente ${sourceId}`):'Sin fuente identificada';

function ImportedShipmentData({shipment}){
  const insurance=shipment.costObservations?.shipping_insurance;
  const insuranceStatus=shipment.costStatuses?.shipping_insurance;
  const insuranceObserved=insurance!=null||insuranceStatus!=null;
  const insuranceKnown=insurance?.amountMinor!=null;
  const insuranceComplete=insuranceStatus==='known'&&insuranceKnown&&!!insurance.chargeOn;
  return <section className="form-section">
    <h3>Datos importados del envío</h3>
    <p><strong>Estado logístico en All Nutrition:</strong> {stateLabel(shipment.status)}</p>
    <p className="hint">Información de solo lectura, conservada por fuente. El estado del envío en la plataforma es administrativo: no sustituye el seguimiento ni confirma una entrega o un cobro. Los datos de destinatario observados no modifican por sí solos el pedido.</p>
    <ImportedData record={shipment} title="Observaciones conservadas por fuente"/>
    <section>
      <h4>Seguro de envío</h4>
      <p className="hint">El valor asegurado / declarado es información; no es el costo del seguro ni un recaudo.</p>
      <dl>
        <dt>Costo del seguro</dt><dd>{!insuranceObserved?'Sin observación de costo (opcional)':insuranceKnown?`${formatMoneyMinor(insurance.amountMinor)} COP${insurance.amountMinor===0?' · Sin cargo de seguro':''}`:'Costo no informado'}</dd>
        <dt>Fecha del cargo del seguro</dt><dd>{insurance?.chargeOn?dateLabel(insurance.chargeOn,false):insuranceObserved?'Fecha no informada':'No informada · costo opcional sin observar'}</dd>
        <dt>Cobertura del costo</dt><dd>{!insuranceObserved?'No requerido: el costo del seguro no se ha informado.':insuranceComplete?'Completa: importe y fecha conocidos.':insuranceKnown&&!insurance?.chargeOn?'Incompleta: importe conocido, fecha del cargo pendiente.':'Incompleta: costo no informado o pendiente de confirmar.'}</dd>
      </dl>
      {insurance&&<p className="muted">Fuente del costo: {sourceLabel(shipment,insurance.sourceId)} · Origen: {insurance.source||'No informado'} · Corte (Bogotá): {dateLabel(insurance.sourceAsOf)}</p>}
      <p className="hint">Vacío: costo no informado. 0: sin cargo de seguro. Importar el costo no registra un pago. Los pagos y saldos se consultan y gestionan en el flujo financiero.</p>
    </section>
  </section>;
}

// Shared inline controls: a shipment never opens another dialog inside an order.
export function ShipmentControls({shipment,inventoryOpening=shipment.inventoryOpening,orderLines=[],siblings=[],onMutate,onCommitted,busy,onInteractionStateChange,assistantOpenRequest,onAssistantOpenHandled,eventStatusRef,metadataFocus}){
  const [metadata,setMetadata]=useState(()=>metadataDraft(shipment));
  const [event,setEvent]=useState(()=>eventDraft(shipment));
  const [changes,setChanges]=useState({metadata:false,event:false});
  const [saveError,setSaveError]=useState('');
  const seenVersion=useRef(shipment.version);
  const metadataSection=useRef(null);
  const changed=changes.metadata||changes.event;
  const locked=shipmentDispatched(shipment),identityLocked=locked||shipment.hekaIdentityProtected;
  const superseded=new Set((shipment.events||[]).map(item=>item.correctionOf).filter(Boolean));
  useEffect(()=>()=>onInteractionStateChange?.({dirty:false,busy:false}),[onInteractionStateChange]);
  const eventDay=event.precision==='day'?event.occurredOn:event.precision==='instant'?event.occurredAt.slice(0,10):'';
  const needsOpeningClassification=!!inventoryOpening&&(!eventDay||eventDay===inventoryOpening.on);
  const setMeta=(key,value)=>{setChanges(old=>({...old,metadata:true}));setMetadata(old=>({...old,[key]:value}));};
  const setFact=(key,value)=>{setChanges(old=>({...old,event:true}));setEvent(old=>({...old,[key]:value}));};
  const metadataAssistant=useAssistantForm({target:'shipment-metadata',entityId:shipment.id,recordVersion:shipment.version,values:metadata,dirty:changes.metadata,busy,referenceChoices:{assignments:Object.fromEntries(orderLines.map(line=>[line.lineId,Number(line.quantity)]))},applyPatch:patch=>{
    const editable=Object.fromEntries(Object.entries(patch).filter(([key])=>locked?['notes','reason'].includes(key):!identityLocked||!['carrier','tracking'].includes(key)));
    if(!Object.keys(editable).length)return;
    setChanges(old=>({...old,metadata:true}));setMetadata(old=>({...old,...editable}));
  }});
  const eventAssistant=useAssistantForm({target:'shipment-event',entityId:shipment.id,recordVersion:shipment.version,values:Object.fromEntries(Object.entries(event).filter(([key])=>!['status','inventoryOpeningIncluded','correctionOf'].includes(key))),dirty:changes.event,busy,applyPatch:patch=>{setChanges(old=>({...old,event:true}));setEvent(old=>({...old,...patch,status:event.status,inventoryOpeningIncluded:event.inventoryOpeningIncluded,correctionOf:event.correctionOf}));}});
  const controlBusy=busy||metadataAssistant.assistantBusy||eventAssistant.assistantBusy;
  // The parent already owns inherited busy; only local operations travel back up.
  const localBusy=metadataAssistant.assistantBusy||eventAssistant.assistantBusy;
  useEffect(()=>{onInteractionStateChange?.({dirty:changed,busy:localBusy});},[changed,localBusy,onInteractionStateChange]);
  useEffect(()=>{
    if(seenVersion.current===shipment.version)return;
    seenVersion.current=shipment.version;
    if(!changes.metadata)setMetadata(metadataDraft(shipment));
    if(!changes.event)setEvent(eventDraft(shipment));
  },[shipment,changes.metadata,changes.event]);
  useEffect(()=>{
    const request=assistantOpenRequest,open=request?.open;
    if(!request||busy||open?.entityId!==shipment.id||open.refs?.shipment?.id!==shipment.id||open.refs.shipment.version!==shipment.version)return;
    if(open.target==='shipment-metadata'&&metadataSection.current)metadataSection.current.open=true;
    if(open.target==='shipment-metadata'||open.target==='shipment-event')onAssistantOpenHandled?.(request.requestId);
  },[assistantOpenRequest,shipment.id,shipment.version,busy,metadataAssistant.formId,eventAssistant.formId,onAssistantOpenHandled]);
  async function submitShipment(kind,e){
    e.preventDefault();if(controlBusy)return;
    setSaveError('');
    const isEvent=kind==='event',{assignments,...fields}=metadata;
    const payload=isEvent
      ? {version:shipment.version,status:event.status,occurredOn:event.precision==='day'?event.occurredOn||null:null,occurredAt:event.precision==='instant'?fromLocal(event.occurredAt):null,sourceAsOf:fromLocal(event.sourceAsOf),reason:event.reason,detail:event.detail,correctionOf:event.correctionOf||null,source:'manual',...(needsOpeningClassification&&event.inventoryOpeningIncluded?{inventoryOpeningIncluded:event.inventoryOpeningIncluded==='true'}:{})}
      : locked
        ? {version:shipment.version,notes:metadata.notes,reason:metadata.reason}
        : {...fields,version:shipment.version,...(shipment.orderId?{assignments:orderLines.map(line=>({lineId:line.lineId,quantity:assignments[line.lineId]||0})).filter(line=>line.quantity>0)}:{})};
    try{
      const response=await (isEvent?eventAssistant:metadataAssistant).submitAssisted({
        payload,
        saveUnassisted:body=>onMutate(`/api/admin/business/shipments/${encodeURIComponent(shipment.id)}${isEvent?'/events':''}`,body,isEvent?'POST':'PUT'),
        onCommitted:async saved=>{
          setChanges(old=>({...old,[kind]:false}));
          if(isEvent)setEvent(eventDraft(saved));else setMetadata(metadataDraft(saved));
          await onCommitted?.(saved);
        },
      });
      if(response.postCommitError)setSaveError('Guardado; vista pendiente de actualizar. '+response.postCommitError.message);
      else if(response.reason==='changed')setSaveError('El formulario cambió. Revisa los datos antes de guardar.');
    }catch(cause){setSaveError(cause.message);}
  }
  return <div className={`shipment-controls ${styles.shipmentControls}`}>
    {saveError&&<p role="alert" className="error">{saveError}</p>}
    <ImportedShipmentData shipment={shipment}/>
    <section className="form-section"><h3>Registrar estado y fecha</h3><p className="hint">Registra solo el hecho observado. No crea pedidos ni registra cobros. Una entrega puede reconocer una venta según la regla guardada. Si no sabes cuándo ocurrió, declara la fecha como desconocida.</p>
      <button type="button" className="button subtle" onClick={()=>eventAssistant.openAssistant()} disabled={controlBusy}>Ayúdame con este formulario</button>
      <form onSubmit={e=>submitShipment('event',e)}>
        <fieldset className="editor-fieldset" disabled={controlBusy}><div className="product-form-grid">
          <label className="field">Estado observado<select ref={eventStatusRef} data-advisor-control="shipment-event-state" value={event.status} onChange={e=>setFact('status',e.target.value)}>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field">Precisión de la fecha<select value={event.precision} onChange={e=>setFact('precision',e.target.value)}><option value="day">Conozco el día</option><option value="instant">Conozco día y hora</option><option value="unknown">Fecha desconocida</option></select></label>
          {event.precision==='day'&&<label className="field">Fecha real del evento<input required type="date" value={event.occurredOn} onChange={e=>setFact('occurredOn',e.target.value)}/></label>}
          {event.precision==='instant'&&<label className="field">Fecha y hora real (Bogotá)<input required type="datetime-local" value={event.occurredAt} onChange={e=>setFact('occurredAt',e.target.value)}/></label>}
          <label className="field">Corte de esta observación (Bogotá)<input required type="datetime-local" value={event.sourceAsOf} onChange={e=>setFact('sourceAsOf',e.target.value)}/></label>
          {needsOpeningClassification&&<label className="field">Relación con el conteo físico del {inventoryOpening.on}<select data-advisor-control="shipment-event-opening" required value={event.inventoryOpeningIncluded||''} onChange={e=>setFact('inventoryOpeningIncluded',e.target.value)}><option value="">Confirma cuándo ocurrió</option><option value="false">Posterior al conteo</option><option value="true">Ya estaba reflejado en el conteo</option></select></label>}
        </div>
        <h4 className={styles.subheading}>Contexto y correcciones</h4>
        <details data-advisor-disclosure><summary>Rectificar un evento anterior</summary><label className="field">Hecho que no ocurrió o cuya fecha / estado era incorrecto<select data-advisor-control={(shipment.events||[]).some(item=>!superseded.has(item.id))?'shipment-event-correction':undefined} value={event.correctionOf} onChange={e=>setFact('correctionOf',e.target.value)}><option value="">Nuevo hecho, sin rectificación</option>{(shipment.events||[]).filter(item=>!superseded.has(item.id)).map(item=><option key={item.id} value={item.id}>{stateLabel(item.status)} · {item.occurredOn||(item.occurredAt?dateLabel(item.occurredAt):'Fecha desconocida')}</option>)}</select></label></details>
        {event.correctionOf&&<p className="error">Rectifica la historia y recalcula reconocimiento, costos y comisiones de las fechas afectadas. Puede abrir un crédito por comisión ya pagada; no mueve dinero de caja. No uses esta opción para una devolución real posterior.</p>}
        <label className="field">Motivo{event.correctionOf?' *':''}<input required={!!event.correctionOf} maxLength={2000} value={event.reason} onChange={e=>setFact('reason',e.target.value)}/></label><label className="field">Detalle del evento<textarea maxLength={4000} value={event.detail} onChange={e=>setFact('detail',e.target.value)}/></label>
        <button className="button primary" type="submit" disabled={controlBusy}>Guardar evento</button></fieldset>
      </form>
    </section>
    <details ref={metadataSection} className="form-section"><summary>{locked?'Corregir notas del envío':'Guía, notas y distribución de cantidades'}</summary>
      <p className="hint">{locked?'Después del despacho solo puedes corregir las notas con un motivo. Se conservan la guía, las cantidades y los eventos.':shipment.hekaIdentityProtected?'La transportadora y el número de la guía oficial Heka no se pueden cambiar aquí. Los otros cambios son locales.':'Edita solo los datos comprobados antes del despacho. Guardar aquí no registra un evento ni consulta a la transportadora.'}</p>
      <button type="button" className="button subtle" onClick={()=>metadataAssistant.openAssistant()} disabled={controlBusy}>Ayúdame con este formulario</button>
      <form onSubmit={e=>submitShipment('metadata',e)}>
        <fieldset className="editor-fieldset" disabled={controlBusy}><div className="product-form-grid">
          <label className="field">Transportadora<input ref={!identityLocked?metadataFocus:undefined} disabled={identityLocked} maxLength={200} value={metadata.carrier} onChange={e=>setMeta('carrier',e.target.value)}/></label>
          <label className="field">Guía<input disabled={identityLocked} maxLength={200} value={metadata.tracking} onChange={e=>setMeta('tracking',e.target.value)}/></label>
          <label className="field">Entrega estimada<input disabled={locked} type="date" value={metadata.estimatedDeliveryOn} onChange={e=>setMeta('estimatedDeliveryOn',e.target.value)}/></label>
        {!!siblings.length&&<label className="field">Guía sustituida<select disabled={locked} value={metadata.replacesShipmentId} onChange={e=>{const original=siblings.find(item=>item.id===e.target.value);setChanges(old=>({...old,metadata:true}));setMetadata(old=>({...old,replacesShipmentId:e.target.value,...(original?{assignments:Object.fromEntries((original.assignments||[]).map(line=>[line.lineId,line.quantity]))}:{})}));}}><option value="">Sin sustitución</option>{siblings.filter(item=>item.id!==shipment.id).map(item=><option key={item.id} value={item.id}>{item.tracking||'Entrega sin guía'} · {stateLabel(item.status)}</option>)}</select></label>}</div>
        {orderLines.map(line=><label className="field" key={line.lineId}>{line.title} · {line.presentation||'Unidad'} (comprado: {line.quantity})<input disabled={locked||!!metadata.replacesShipmentId} type="number" min={0} max={line.quantity} step={1} value={metadata.assignments[line.lineId]??0} onChange={e=>setMeta('assignments',{...metadata.assignments,[line.lineId]:Number(e.target.value)})}/></label>)}
        <label className="field">Notas<textarea ref={locked?metadataFocus:undefined} maxLength={4000} value={metadata.notes} onChange={e=>setMeta('notes',e.target.value)}/></label>
        <label className="field">Motivo de corrección<input required={locked} maxLength={2000} value={metadata.reason} onChange={e=>setMeta('reason',e.target.value)}/></label>
        <button type="submit" className="button subtle">{locked?'Guardar corrección de notas':'Guardar guía y notas'}</button></fieldset>
      </form>
    </details>
    <details className="form-section"><summary>Historial de eventos ({shipment.events?.length||0})</summary><ol className="history-timeline">{(shipment.events||[]).map(item=><li key={item.id}>{stateLabel(item.status)} · {item.occurredOn?dateLabel(item.occurredOn,false):(item.occurredAt?dateLabel(item.occurredAt):'Fecha desconocida')}{superseded.has(item.id)?' · Rectificado':''}{item.correctionOf?' · Rectificación':''}{item.reason?' · '+item.reason:''}{item.detail?' · '+item.detail:''}{item.rawStatus&&<p style={{whiteSpace:'pre-wrap'}}><strong>Estado de entrega / seguimiento en el origen:</strong> {item.rawStatus}</p>}<small className="muted">Corte (día): {dateLabel(item.sourceAsOf,false)} · Registrado: {dateLabel(item.recordedAt)}</small></li>)}</ol></details>
  </div>;
}

function ShipmentDialog({id,api,onClose,onOpenOrder,onQuote,onMutation,onInteractionStateChange,assistantOpenRequest,onAssistantOpenHandled,advisorTargetRequest,onAdvisorTargetHandled}){
  const dialog=useRef(null),errorRef=useRef(null),sequence=useRef(0),selectionSequence=useRef(0),requests=useRef(new Map());
  const detailHeading=useRef(null),eventStatus=useRef(null),metadataFocus=useRef(null),lookupInput=useRef(null),linkHeading=useRef(null),advisorHandled=useRef(null);
  const [readyAdvisorTarget,setReadyAdvisorTarget]=useState(null);
  const [shipment,setShipment]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[controls,setControls]=useState({dirty:false,busy:false}),[linking,setLinking]=useState(false),[financial,setFinancial]=useState({dirty:false,busy:false});
  const [query,setQuery]=useState(''),[page,setPage]=useState(1),[candidates,setCandidates]=useState(null),[selected,setSelected]=useState(null),[lookupLoading,setLookupLoading]=useState(false),[lookupError,setLookupError]=useState(''),[lookupRetry,setLookupRetry]=useState(0);
  const [selectionLoading,setSelectionLoading]=useState(false),[controlsEpoch,setControlsEpoch]=useState(0);
  const dirty=controls.dirty||financial.dirty,working=busy||financial.busy,interactionBusy=working||controls.busy;
  const advisorLive=useRef(null);
  advisorLive.current={requestId:advisorTargetRequest?.id,blocked:dirty||interactionBusy||loading||selectionLoading,shipment};
  const close=useDialog(dialog,{dirty,busy:interactionBusy,onClose:finishClose});
  const reportControls=useCallback(state=>setControls(state),[]),reportFinancial=useCallback(state=>setFinancial(state),[]);
  useEffect(()=>{onInteractionStateChange?.({dirty,busy:interactionBusy});},[dirty,interactionBusy,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange?.({dirty:false,busy:false}),[onInteractionStateChange]);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  const load=useCallback(async()=>{const token=++sequence.current;setLoading(true);setError('');try{const value=await api('/api/admin/business/shipments/'+encodeURIComponent(id));if(token===sequence.current){setShipment(value);return true;}}catch(cause){if(token===sequence.current)setError(cause.message);}finally{if(token===sequence.current)setLoading(false);}return false;},[api,id]);
  useEffect(()=>{
    const requestId=advisorTargetRequest?.id,target=validateAdvisorTarget(advisorTargetRequest);
    if(!requestId||advisorHandled.current===requestId||readyAdvisorTarget?.id===requestId||target?.view.tab!=='shipments'||target.view.record!==id||loading)return;
    const fail=message=>{
      advisorHandled.current=requestId;
      setError(message);onAdvisorTargetHandled?.(requestId,message);
    };
    if(dirty||interactionBusy||selectionLoading){fail('Conserva los cambios del envío antes de abrir la acción de Ali.');return;}
    if(!shipment){fail('No se pudo verificar el envío solicitado.');return;}
    const stillClean=()=>{
      const live=advisorLive.current;
      return live.requestId===requestId&&!live.blocked&&live.shipment===shipment;
    };
    let active=true;
    const ref=target.selection;
    (async()=>{
      try{
        const current=await api('/api/admin/business/shipments/'+encodeURIComponent(ref.id));
        if(!active||!stillClean())return;
        if(current.id!==ref.id||current.version!==ref.version||shipment.id!==ref.id||shipment.version!==ref.version)throw new Error('El envío cambió. Carga los datos actuales antes de continuar.');
        let order;
        const linkingTarget=target.focus==='shipment-link-order',lookupTarget=target.focus==='shipment-order-lookup';
        if((linkingTarget||lookupTarget)&&current.orderId)throw new Error('Esta guía ya tiene un pedido vinculado. Abre ese pedido para revisarlo.');
        if(target.focus==='shipment-metadata'){
          if(shipmentDispatched(current))throw new Error('La guía ya fue despachada. Solo puedes corregir las notas con un motivo.');
          if(current.hekaIdentityProtected){
            if(!shipment.hekaIdentityProtected)setShipment(current);
            throw new Error('La identidad de la guía oficial Heka está protegida y no puede modificarse.');
          }
        }
        if(target.focus==='shipment-notes-correction'&&!shipmentDispatched(current))throw new Error('Esta guía aún no fue despachada. Edita sus notas en «Guía, notas y distribución de cantidades».');
        if(linkingTarget&&ref.orderId){
          order=await api('/api/admin/orders/'+encodeURIComponent(ref.orderId));
          if(order.id!==ref.orderId||order.version!==ref.orderVersion)throw new Error('El pedido cambió. Revisa su versión actual antes de vincular.');
          if(order.status==='cancelled')throw new Error('El pedido está cancelado y no admite una vinculación.');
        }
        if(!active||!stillClean())return;
        if(linkingTarget||lookupTarget){
          setQuery(order?orderNumber(order.number):'');setPage(1);setCandidates(null);setSelected(order||null);
          setLookupLoading(Boolean(order));setLookupError('');setLinking(lookupTarget?'lookup':'link');
        }else if(target.focus!=='shipment-detail'){
          setShipment(current);setLinking(false);setSelected(null);
        }
        setReadyAdvisorTarget({...target,id:requestId});
      }catch(cause){if(active&&stillClean())fail(cause.message);}
    })();
    return()=>{active=false;};
  },[advisorTargetRequest,readyAdvisorTarget?.id,id,loading,shipment,dirty,interactionBusy,selectionLoading,api,onAdvisorTargetHandled]);
  useEffect(()=>{
    const request=readyAdvisorTarget;
    if(!request||request.id!==advisorTargetRequest?.id||advisorHandled.current===request.id)return;
    const editingMetadata=['shipment-metadata','shipment-notes-correction'].includes(request.focus);
    const node=editingMetadata?metadataFocus.current
      :request.focus==='shipment-order-lookup'?lookupInput.current
      :request.focus==='shipment-link-order'?linkHeading.current
      :request.focus==='shipment-event'?eventStatus.current:detailHeading.current;
    const ref=request.selection;
    if(!node||dirty||interactionBusy||loading||shipment?.version!==ref.version
      ||(ref.orderId&&(selected?.id!==ref.orderId||selected.version!==ref.orderVersion))){
      const message='El envío o su borrador cambiaron. Revisa los datos antes de continuar.';
      advisorHandled.current=request.id;
      setError(message);onAdvisorTargetHandled?.(request.id,message);return;
    }
    advisorHandled.current=request.id;
    if(editingMetadata)node.closest('details').open=true;
    node.focus();
    onAdvisorTargetHandled?.(request.id,document.activeElement===node?undefined:'No se pudo enfocar el control del envío.');
  },[readyAdvisorTarget,advisorTargetRequest?.id,dirty,interactionBusy,loading,shipment,selected,onAdvisorTargetHandled]);
  useEffect(()=>{void load();return()=>{sequence.current++;selectionSequence.current++;};},[load]);
  useEffect(()=>{
    const request=assistantOpenRequest,ref=request?.open?.refs?.shipment;
    if(!request||loading||!shipment||ref?.id!==shipment.id)return;
    if(ref.version!==shipment.version){setError('El envío cambió. Revisa la propuesta con los datos actuales.');return;}
    if(linking){
      if(dirty||interactionBusy){setError('Conserva o termina la vinculación actual antes de abrir la propuesta.');return;}
      setLinking(false);setSelected(null);
    }
  },[assistantOpenRequest,shipment,loading,linking,dirty,interactionBusy]);
  const lookupOpen=Boolean(linking);
  useEffect(()=>{
    const exact=query.trim();
    if(!lookupOpen||!exact)return;
    let active=true;
    const timer=setTimeout(async()=>{
      try{
        const result=await api('/api/admin/orders?'+new URLSearchParams({q:exact,page:String(page),lookup:'identity'}));
        if(active)setCandidates(result);
      }catch(cause){if(active)setLookupError(cause.message);}
      finally{if(active)setLookupLoading(false);}
    },250);
    return()=>{active=false;clearTimeout(timer);};
  },[api,query,page,lookupOpen,lookupRetry]);
  useEffect(()=>{
    if(linking==='lookup')lookupInput.current?.focus();
    else if(linking==='link')linkHeading.current?.focus();
  },[linking]);
  function searchOrders(value,nextPage=1){
    setCandidates(null);setSelected(null);setLookupError('');setLookupLoading(Boolean(value.trim()));
    setQuery(value);setPage(nextPage);setLookupRetry(retry=>retry+1);
  }
  async function selectOrder(order){
    const token=++selectionSequence.current;
    setSelected(null);setSelectionLoading(true);setLookupError('');
    try{
      const detail=await api('/api/admin/orders/'+encodeURIComponent(order.id));
      if(detail.id!==order.id||detail.version!==order.version)throw new Error('El pedido cambió durante la búsqueda. Vuelve a consultar su identidad antes de seleccionarlo.');
      if(detail.status==='cancelled'&&linking==='link')throw new Error('El pedido cancelado no admite una vinculación.');
      if(token===selectionSequence.current)setSelected(detail);
    }catch(cause){if(token===selectionSequence.current)setLookupError(cause.message);}
    finally{if(token===selectionSequence.current)setSelectionLoading(false);}
  }
  async function mutate(path,body,method='POST'){
    setBusy(true);setError('');setNotice('');
    const key=method+path+JSON.stringify(body);if(!requests.current.has(key))requests.current.set(key,crypto.randomUUID());
    try{
      const result=await api(path,{method,body:JSON.stringify({...body,requestId:requests.current.get(key)})});
      return result;
    }finally{setBusy(false);}
  }
  async function shipmentSaved(){
    onMutation?.({type:'shipment',shipmentId:id});
    if(!await load())throw new Error('Reintenta la lectura antes de continuar.');
    requests.current.clear();
    setNotice('Envío actualizado.');
  }
  function startLink(mode){
    if(interactionBusy||loading)return;
    if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos para buscar el pedido?'))return;
    setControls({dirty:false,busy:false});searchOrders('');setLinking(mode);
  }
  function cancelLink(){
    if(financial.busy||selectionLoading)return;
    if(financial.dirty&&!window.confirm('¿Descartar los cambios de vinculación?'))return;
    setLinking(false);searchOrders('');setFinancial({dirty:false,busy:false});
  }
  async function linked(){
    onMutation?.({type:'shipment',shipmentId:id});
    setLinking(false);searchOrders('');setFinancial({dirty:false,busy:false});
    if(await load())setNotice('Guía vinculada al pedido.');
    else setError('Guardado; vista pendiente de actualizar. Reintenta la lectura del envío.');
  }
  async function finishClose(){setControls({dirty:false,busy:false});setFinancial({dirty:false,busy:false});onInteractionStateChange?.({dirty:false,busy:false});await new Promise(resolve=>requestAnimationFrame(resolve));onClose();}
  async function openOrder(){if(interactionBusy)return;if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y abrir el pedido?'))return;const orderId=shipment.orderId;dialog.current?.close();await finishClose();await new Promise(resolve=>requestAnimationFrame(resolve));onOpenOrder(orderId);}
  async function retryRead(){if(interactionBusy)return;if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos para recargar?'))return;if(await load())setControlsEpoch(value=>value+1);}
  const fileCut=shipment?.sourceCuts?.[shipment.sourceId];
  const otherObservation=shipment?.sourceAsOf&&(!fileCut||Date.parse(fileCut.sourceAsOf)!==Date.parse(shipment.sourceAsOf));
  return <dialog ref={dialog} className={`editor-drawer ${styles.editor}`} aria-labelledby="shipment-title" aria-busy={interactionBusy}
    data-shipment-id={!loading?shipment?.id:undefined} data-shipment-version={!loading?shipment?.version:undefined}>
    <header><div><p className="eyebrow">Envíos · Seguimiento y vinculación</p><h2 id="shipment-title" ref={detailHeading} data-dialog-initial-focus data-advisor-control={shipment&&!loading&&!error&&!dirty?'shipment-detail':undefined} tabIndex={-1}>{shipment?.tracking||'Detalle del envío'}</h2></div><button className="icon-button" type="button" aria-label="Cerrar envío" disabled={interactionBusy} onClick={close}><Icon name="close"/></button></header><div className="drawer-body">
    {error&&<div role="alert" className="error" ref={errorRef} tabIndex={-1}>{error}<button className="button subtle" type="button" disabled={interactionBusy} onClick={retryRead}>Reintentar lectura</button></div>}{notice&&<p role="status">{notice}</p>}{loading&&<p role="status">{shipment?'Actualizando; se muestran datos anteriores.':'Cargando envío…'}</p>}
    {shipment&&<><section className={styles.observation} aria-label="Origen del envío"><p className={styles.sectionLabel}>Origen del envío</p><p>{shipment.carrier||'Sin transportadora'} · {shipment.platformName||'Origen manual / histórico'}{shipment.sourceName?' / '+shipment.sourceName:''}</p>
    <p>Corte del archivo de esta cuenta: {fileCut?(fileCut.precision==='day'?`${fileCut.value} · Sin hora informada`:dateLabel(fileCut.value)):'Sin corte de archivo verificable'}</p></section>
    {otherObservation&&<p>Observación más reciente (día): {dateLabel(shipment.sourceAsOf,false)}</p>}
    <div className="admin-actions">{shipment.orderId?<button type="button" className="button subtle" disabled={interactionBusy} onClick={openOrder}>Abrir {orderNumber(shipment.orderNumber)}</button>:!linking&&<>
      <button className="button subtle" type="button" disabled={interactionBusy||loading} onClick={()=>startLink('lookup')}>Identificar el pedido</button>
      <button className="button primary" type="button" disabled={interactionBusy||loading} onClick={()=>startLink('link')}>Vincular pedido conocido</button>
    </>}{(shipment.preparationId||['unknown','label_created'].includes(shipment.status))&&<button className="button subtle" type="button" disabled={interactionBusy||loading} onClick={()=>onQuote(shipment.id)}>{shipment.preparationId?'Abrir preparación guardada':'Cotizar este envío'}</button>}</div>
    {!linking&&!loading&&shipment.hekaIdentityProtected&&shipment.orderId&&<ShippingFinance key={shipment.id} api={api} shipmentId={shipment.id} busy={interactionBusy||controls.dirty}
      onInteractionStateChange={reportFinancial} onSaved={()=>{onMutation?.({type:'finance',orderId:shipment.orderId,shipmentId:id});setNotice('Operación de Caja registrada.');}}/>}
    {linking?<section className="form-section" aria-labelledby="shipment-order-heading">
      <h3 id="shipment-order-heading" ref={linkHeading} tabIndex={-1}>{linking==='lookup'?'Identificar el pedido de esta guía':'Vincular esta guía con un pedido existente'}</h3>
      <p>{linking==='lookup'?'Consultar un pedido y sus líneas no vincula la guía.':'Elige tú el pedido y confirma qué unidades corresponden a esta guía. No se crea otro pedido ni se registra un cobro.'}</p>
      <label className="field">Número AN o guía exacta<input ref={lookupInput} type="search" maxLength={100} value={query} disabled={financial.dirty||financial.busy||selectionLoading} aria-describedby="shipment-lookup-help" onChange={e=>searchOrders(e.target.value)}/></label>
      <p className="hint" id="shipment-lookup-help">Escribe el número AN exacto o el número de otra guía ya vinculada. No se busca por nombre ni por teléfono.</p>
      {lookupError&&<p className="error" role="alert">{lookupError} <button className="text-button" type="button" onClick={()=>searchOrders(query,page)}>Reintentar búsqueda</button></p>}
      {(lookupLoading||selectionLoading)&&<p role="status">{selectionLoading?'Cargando líneas del pedido…':'Buscando pedidos…'}</p>}
      {!lookupLoading&&!!candidates?.records.length&&<>
        <ul className="shipment-candidates" aria-label="Pedidos que coinciden con la identidad">{candidates.records.map(order=><li key={order.id}><button type="button" className={`button ${selected?.id===order.id?'primary':'subtle'}`} disabled={financial.dirty||financial.busy||selectionLoading||linking==='link'&&order.status==='cancelled'} aria-pressed={selected?.id===order.id} onClick={()=>selectOrder(order)}>{orderNumber(order.number)} · {order.placedOn||'Fecha pendiente'} · {orderStateLabel(order.status)}</button></li>)}</ul>
        {candidates.total>candidates.pageSize&&<nav className="admin-actions" aria-label="Páginas de pedidos coincidentes"><button className="button subtle" type="button" disabled={page===1||financial.dirty||financial.busy||selectionLoading} onClick={()=>searchOrders(query,page-1)}>Anteriores</button><span>Página {page}</span><button className="button subtle" type="button" disabled={page*candidates.pageSize>=candidates.total||financial.dirty||financial.busy||selectionLoading} onClick={()=>searchOrders(query,page+1)}>Siguientes</button></nav>}
      </>}
      {!lookupLoading&&candidates&&!candidates.records.length&&<p role="status">No hay pedidos con esa identidad. Revisa el número exacto; no se creará una venta nueva.</p>}
      {selected&&linking==='lookup'&&<section aria-label={`Líneas de ${orderNumber(selected.number)}`}>
        <h4>{orderNumber(selected.number)}</h4>
        <ul>{selected.items.map(line=><li key={line.lineId}>{line.title} · {line.presentation||'Unidad'} · {line.quantity} {line.quantity===1?'unidad':'unidades'}</li>)}</ul>
        {selected.status==='cancelled'?<p>Este pedido está cancelado y no se puede vincular.</p>:<button className="button subtle" type="button" onClick={()=>setLinking('link')}>Preparar vinculación</button>}
      </section>}
      {selected&&linking==='link'?<BusinessActionForm key={`${selected.id}:${selected.version}:${shipment.version}`} action="link-shipment" context={{shipment,order:selected,requireExplicitAssignments:true}} api={api} onSaved={linked} onCancel={cancelLink} onInteractionStateChange={reportFinancial}/>:<button className="button subtle" type="button" disabled={selectionLoading} onClick={cancelLink}>{linking==='lookup'?'Volver al envío':'Cancelar vinculación'}</button>}
    </section>:<ShipmentControls key={shipment.id+':'+controlsEpoch} shipment={shipment} orderLines={shipment.orderLines} siblings={shipment.relatedShipments||[]} onMutate={mutate} onCommitted={shipmentSaved} busy={working||loading} onInteractionStateChange={reportControls} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={onAssistantOpenHandled} eventStatusRef={eventStatus} metadataFocus={metadataFocus}/>}</>}
  </div><footer className="editor-footer"><span role="status">{working?'Guardando…':controls.busy?'Aplicando asistencia…':dirty?'Cambios sin guardar':''}</span><button className="button subtle" type="button" disabled={interactionBusy} onClick={close}>Cerrar</button></footer></dialog>;
}

export default function ShipmentsWorkspace({api,view,onViewChange,onNavigate,onEdit,onInteractionStateChange,onMutation,assistantOpenRequest,onAssistantOpenHandled,advisorTargetRequest,onAdvisorTargetHandled}){
  const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[platforms,setPlatforms]=useState([]),[sources,setSources]=useState([]),[selectorError,setSelectorError]=useState(''),[selectorRetry,setSelectorRetry]=useState(0);
  const sequence=useRef(0),q=view.q||'',status=view.status||'',platform=view.platform||'',source=view.source||'',carrier=view.carrier||'',issue=view.issue||'',page=view.page||1;
  const [dialogState,setDialogState]=useState({dirty:false,busy:false}),[readyAssistantRequest,setReadyAssistantRequest]=useState(null);
  const dialogLive=useRef(null);
  dialogLive.current={...dialogState,record:view.record};
  const reportDialog=useCallback(state=>{setDialogState(state);onInteractionStateChange?.(state);},[onInteractionStateChange]);
  useEffect(()=>{
    const request=assistantOpenRequest,open=request?.open;
    if(!request){setReadyAssistantRequest(null);return;}
    if(open?.owner!=='shipments'||!['shipment-metadata','shipment-event'].includes(open.target)||readyAssistantRequest?.requestId===request.requestId)return;
    const ref=open.refs?.shipment;
    if(!ref||open.entityId!==ref.id){setError('La propuesta no identifica un envío real.');return;}
    if(dialogState.busy)return;
    if(view.record&&view.record!==ref.id&&dialogState.dirty){setError('Guarda o descarta los cambios del envío actual antes de abrir otro.');return;}
    let active=true;
    (async()=>{
      try{
        const shipment=await api('/api/admin/business/shipments/'+encodeURIComponent(ref.id));
        if(shipment.id!==ref.id||shipment.version!==ref.version)throw new Error('El envío cambió. Revisa la propuesta con los datos actuales.');
        for(const [role,reference] of Object.entries(open.refs)){
          if(role==='shipment')continue;
          if(role!=='order'||shipment.orderId!==reference.id)throw new Error('La referencia no corresponde a este envío.');
          const order=await api('/api/admin/orders/'+encodeURIComponent(reference.id));
          if(order.id!==reference.id||(reference.version!=null&&order.version!==reference.version))throw new Error('El pedido cambió. Revisa la propuesta con los datos actuales.');
        }
        const live=dialogLive.current;
        if(!active||live.busy||(live.record&&live.record!==ref.id&&live.dirty))return;
        if(live.record!==ref.id)await onViewChange({record:ref.id});
        if(active)setReadyAssistantRequest(request);
      }catch(cause){if(active)setError(cause.message);}
    })();
    return()=>{active=false;};
  },[assistantOpenRequest,readyAssistantRequest?.requestId,api,view.record,dialogState.dirty,dialogState.busy,onViewChange]);
  const params=new URLSearchParams(Object.entries({q,status,platform,source,carrier,issue,page:String(page)}).filter(([,value])=>value)).toString();
  useEffect(()=>{const token=++sequence.current;setLoading(true);setError('');api('/api/admin/business/shipments?'+params).then(value=>{if(token===sequence.current)setData(value);}).catch(cause=>{if(token===sequence.current)setError(cause.message);}).finally(()=>{if(token===sequence.current)setLoading(false);});return()=>{sequence.current++;};},[api,params,retry]);
  useEffect(()=>{let active=true;setSelectorError('');Promise.all([api('/api/admin/business/platforms'),api('/api/admin/business/sources')]).then(([p,s])=>{if(active){setPlatforms(rows(p));setSources(rows(s));}}).catch(cause=>{if(active)setSelectorError(cause.message);});return()=>{active=false;};},[api,selectorRetry]);
  const filter=patch=>onViewChange({...patch,page:1,record:undefined});
  const changed=event=>{onMutation?.(event);setRetry(value=>value+1);};
  const filtered=!!(q||status||platform||source||carrier||issue),filterCount=[status,platform,source,carrier,issue].filter(Boolean).length;
  return <section className={`shipments-workspace ${styles.shipments}`} aria-label="Seguimiento de envíos"><header className={styles.taskHeading}><div><h2 tabIndex={-1} data-advisor-control={data&&!loading?'shipment-results':undefined}>Seguimiento de envíos</h2><p>Registros locales: vincula al pedido y registra lo observado. Las guías del proveedor se consultan en el Centro de envíos.</p></div><div className="admin-actions"><button className="button subtle" type="button" onClick={()=>onNavigate({section:'orders',tab:'heka'})}>Abrir Centro de envíos</button><button className="button primary" type="button" onClick={()=>onViewChange({tab:'imports',record:undefined,batch:'new',q:'',status:'',issue:'',carrier:'',platform:'',source:'',page:1})}>Importar seguimiento</button></div></header>
    <label className="field">Buscar guía o número AN<input type="search" data-advisor-control="shipment-query" value={q} maxLength={100} onChange={e=>filter({q:e.target.value})}/></label>
    <details className="form-section" data-advisor-disclosure>
      <summary>Filtros de envíos{filterCount?` (${filterCount} activos)`:''}</summary>
      <div className={`admin-actions ${styles.priorityFilters}`} role="group" aria-label="Prioridades de envíos">{[
        ['orphan','Vincular pedido','shipment-unlinked-filter'],
        ['incident','Con novedad','shipment-incident-filter'],
        ['missing_data','Faltan datos','shipment-incomplete-filter'],
      ].map(([key,title,control])=><button type="button" key={key} className={`button ${issue===key?'primary':'subtle'}`} data-advisor-control={control} aria-pressed={issue===key} onClick={()=>filter({issue:issue===key?'':key})}>{title}</button>)}</div>
      <div className="product-form-grid">
        <label className="field">Estado<select data-advisor-control="shipment-status-filter" value={status} onChange={e=>filter({status:e.target.value})}><option value="">Todos</option>{shipmentStates.map(({value,label})=><option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">Plataforma<select data-advisor-control="shipment-origin-filter" value={platform} onChange={e=>filter({platform:e.target.value,source:''})}><option value="">Todas</option>{platforms.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field">Cuenta de plataforma<select value={source} onChange={e=>filter({source:e.target.value})}><option value="">Todas</option>{sources.filter(item=>!platform||item.platformId===platform).map(item=><option key={item.id} value={item.id}>{platforms.find(p=>p.id===item.platformId)?.name} / {item.name}</option>)}</select></label>
        <label className="field">Transportadora exacta<input data-advisor-control="shipment-carrier-filter" value={carrier} maxLength={100} onChange={e=>filter({carrier:e.target.value})}/></label>
      </div>
    </details>
    {selectorError&&<p role="alert" className="error">{selectorError}<button type="button" className="text-button" onClick={()=>setSelectorRetry(value=>value+1)}>Reintentar opciones</button></p>}
    {(q||status||platform||source||carrier||issue)&&<div className="shipment-active-filters"><p>Filtros activos: {[q&&`Búsqueda: ${q}`,status&&stateLabel(status),platform&&(platforms.find(item=>item.id===platform)?.name||'Plataforma seleccionada'),source&&(sources.find(item=>item.id===source)?.name||'Cuenta seleccionada'),carrier,issue&&({orphan:'Sin pedido',incident:'Con novedad',missing_data:'Faltan datos'}[issue])].filter(Boolean).join(' · ')}</p><button className="button subtle" type="button" data-advisor-control="shipment-active-filters" onClick={()=>filter({q:'',status:'',platform:'',source:'',carrier:'',issue:''})}>Limpiar filtros</button></div>}
    {error&&<p className="error" role="alert">{error}<button className="button subtle" type="button" onClick={()=>setRetry(value=>value+1)}>Reintentar</button></p>}{loading&&<p role="status">{data?'Actualizando; los envíos visibles son datos anteriores.':'Cargando envíos…'}</p>}
    {!loading&&!error&&data&&!data.records.length&&<div className="admin-card"><h3>{data.total>0?'Esta página ya no tiene envíos':filtered?'No hay envíos con estos filtros':'Todavía no hay envíos'}</h3><p>{data.total>0?'Vuelve a la página anterior con «Anteriores» para consultar los envíos restantes.':filtered?'Ajusta la búsqueda o limpia los filtros para ver otros envíos.':'Usa «Importar seguimiento» o registra una guía desde un pedido. Un envío sin pedido puede vincularse después, sin inventar ventas.'}</p></div>}
    <div className="shipment-list" aria-label="Envíos" aria-busy={loading}>{(data?.records||[]).map(item=><article className="admin-card shipment-card" key={item.id}><header><h2>{item.tracking||item.externalId||'Entrega sin guía'}</h2><span>{stateLabel(item.status)}</span></header><p>{orderNumber(item.orderNumber)} · {item.carrier||'Sin transportadora'}</p><p>{item.platformName||'Manual / histórico'}{item.sourceName?' / '+item.sourceName:''}</p><p className="muted">{item.knownEventOn||item.knownEventAt?'Hay eventos con fecha conocida':'Fecha de evento pendiente'} · Observación (día): {dateLabel(item.sourceAsOf,false)}</p><button type="button" className="button subtle" onClick={()=>onViewChange({record:item.id})}>{item.orderId?'Ver envío':'Revisar y vincular'}</button></article>)}</div>
    {data?.total>0&&<nav className="admin-actions" aria-label="Páginas de envíos"><button type="button" className="button subtle" disabled={page<=1||loading} onClick={()=>onViewChange({page:page-1})}>Anteriores</button><span role="status">Página {page} de {Math.max(1,Math.ceil(data.total/data.pageSize))} · {data.total} envíos</span><button type="button" className="button subtle" disabled={page*data.pageSize>=data.total||loading} onClick={()=>onViewChange({page:page+1})}>Siguientes</button></nav>}
    {view.record&&<ShipmentDialog key={view.record} id={view.record} api={api} onClose={()=>onViewChange({record:undefined})} onOpenOrder={id=>onEdit('orders',{id})} onQuote={shipmentId=>onNavigate({section:'orders',tab:'heka',panel:'freight',shipmentId})} onMutation={changed} onInteractionStateChange={reportDialog} assistantOpenRequest={readyAssistantRequest?.requestId===assistantOpenRequest?.requestId?readyAssistantRequest:null} onAssistantOpenHandled={onAssistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled}/>}
  </section>;
}
