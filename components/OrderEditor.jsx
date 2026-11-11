'use client';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { orderStates, paymentStates } from '@/lib/schema.mjs';
import { formatMoneyMinor as copFormatter, MAX_MONEY_MINOR } from '@/lib/business/money.mjs';
import { bogotaDate } from '@/lib/business/dates.mjs';
import { stockAvailable } from '@/lib/inventory.mjs';
import { Field } from './Fields';
import Icon from './Icons';
import useDialog from './useDialog';
import { BusinessActionForm } from './BusinessActionDialog';
import { ShipmentControls } from './ShipmentsWorkspace';
import WorkspaceTabs from './WorkspaceTabs';
import ImportedData from './ImportedData';
import styles from './OrderExperience.module.css';
import { useAssistantForm } from './AssistantBridge';

const blank = () => ({ requestId: crypto.randomUUID(), placedOn: bogotaDate(), cancellationOn:bogotaDate(), sellerId:null, customerName:'', phone:'', city:'', department:'', address:'', addressNotes:'', email:'', documentType:'', documentNumber:'', marketingCampaign:'', notes:'', status:'new', statusReason:'', deliveryMethod:'carrier', shippingChargeMinor:0, items:[] });
const newShipment=()=>({carrier:'',tracking:'',estimatedDeliveryOn:'',split:false,assignments:{},replacesShipmentId:''});
const label=(options,value)=>options.find(s=>s.value===value)?.label||value;
const number=record=>record?.number ? `AN-${String(record.number).padStart(6,'0')}` : 'Nuevo pedido';
const displayMinor=value=>value==null?'Por completar':Number.isSafeInteger(value)&&Math.abs(value)<=MAX_MONEY_MINOR?copFormatter(value):'Importe fuera de rango: revisa cantidades y valores';
const copyForm=record=>{
  const base=blank();if(!record)return base;
  return {...Object.fromEntries(Object.keys(base).map(key=>[key,Object.hasOwn(record,key)?record[key]:base[key]])),id:record.id,version:record.version,items:record.items.map(({lineId,kind,itemId,quantity,unitPriceMinor,discountMinor,title,productType})=>({lineId,kind,itemId,quantity,unitPriceMinor,discountMinor,title,productType}))};
};

const detailTabs=[{id:'agreement',label:'Acuerdo'},{id:'shipments',label:'Envíos'},{id:'collections',label:'Cobros'},{id:'profit',label:'Rentabilidad'}];
const newOrderTabs=[{id:'agreement',label:'Destinatario y productos'}];

function ShipmentCreateAssistant({detail,shipment,setShipment,orderLines,busy,dirty,onDirty,onInteractionStateChange,onMutate,onCommitted,assistantOpenRequest,onAssistantOpenHandled}) {
  const section=useRef(null);
  const [error,setError]=useState('');
  const assistant=useAssistantForm({
    target:'shipment-create',entityId:detail.id,recordVersion:detail.version,values:shipment,dirty,busy,
    referenceChoices:{assignments:Object.fromEntries(orderLines.map(line=>[line.lineId,Number(line.quantity)])),replacesShipmentId:(detail.shipments||[]).map(item=>item.id)},
    applyPatch:patch=>{setShipment(old=>({...old,...patch}));onDirty();},
  });
  const controlBusy=busy||assistant.assistantBusy;
  // Report only this form's lock; echoing inherited busy deadlocks sibling shipments.
  const localBusy=assistant.assistantBusy;
  useEffect(()=>{onInteractionStateChange({dirty,busy:localBusy});},[dirty,localBusy,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange({dirty:false,busy:false}),[onInteractionStateChange]);
  useEffect(()=>{
    const request=assistantOpenRequest;
    if(request?.open?.target!=='shipment-create'||request.open.entityId!==detail.id||request.open.refs?.order?.id!==detail.id||request.open.refs.order.version!==detail.version||busy)return;
    if(section.current)section.current.open=true;
    onAssistantOpenHandled?.(request.requestId);
  },[assistantOpenRequest,detail.id,detail.version,busy,assistant.formId,onAssistantOpenHandled]);
  async function submit(e){
    e.preventDefault();if(controlBusy)return;setError('');
    const payload={orderId:detail.id,carrier:shipment.carrier,tracking:shipment.tracking,estimatedDeliveryOn:shipment.estimatedDeliveryOn||null,replacesShipmentId:shipment.replacesShipmentId||null,...(shipment.split?{assignments:orderLines.map(line=>({lineId:line.lineId,quantity:shipment.assignments[line.lineId]||0})).filter(line=>line.quantity>0)}:{})};
    try{
      const response=await assistant.submitAssisted({payload,saveUnassisted:body=>onMutate('/api/admin/business/shipments',body),onCommitted});
      if(response.postCommitError)setError('Guardado; vista pendiente de actualizar. '+response.postCommitError.message);
      else if(response.reason==='changed')setError('El envío cambió. Revisa los datos antes de guardar.');
    }catch(cause){setError(cause.message);}
  }
  return <details ref={section} className="form-section">
    <summary>Registrar guía o entrega local</summary>
    <button type="button" className="button subtle" disabled={controlBusy} onClick={assistant.openAssistant}>Ayúdame a preparar este envío</button>
    {error&&<p role="alert" className="error">{error}</p>}
    <form onSubmit={submit} onChangeCapture={onDirty}><fieldset className="editor-fieldset" disabled={controlBusy}><div className="product-form-grid">
      <label className="field">Transportadora<input maxLength={200} value={shipment.carrier} onChange={e=>setShipment({...shipment,carrier:e.target.value})}/></label>
      <label className="field">Número de guía<input maxLength={200} value={shipment.tracking} onChange={e=>setShipment({...shipment,tracking:e.target.value})}/></label>
      <label className="field">Entrega estimada<input type="date" value={shipment.estimatedDeliveryOn} onChange={e=>setShipment({...shipment,estimatedDeliveryOn:e.target.value})}/></label>
      <label className="field">Reemplaza a<select value={shipment.replacesShipmentId} onChange={e=>setShipment({...shipment,replacesShipmentId:e.target.value,split:false,assignments:{}})}><option value="">Envío inicial o división</option>{(detail.shipments||[]).map(item=><option key={item.id} value={item.id}>{item.tracking||'Entrega sin guía'} · {item.carrier||'Local'}</option>)}</select></label>
    </div>
    {!shipment.replacesShipmentId&&<label className="checkbox-field"><input type="checkbox" checked={shipment.split} onChange={e=>setShipment({...shipment,split:e.target.checked})}/>Dividir envío</label>}
    {shipment.split&&orderLines.map(line=><label className="field" key={line.lineId}>{line.title} (comprado: {line.quantity})<input type="number" min={0} max={line.quantity} step={1} value={shipment.assignments[line.lineId]??0} onChange={e=>setShipment({...shipment,assignments:{...shipment.assignments,[line.lineId]:Number(e.target.value)}})}/></label>)}
    <button className="button primary" type="submit" disabled={controlBusy}>Registrar envío</button></fieldset></form>
  </details>;
}
export default function OrderEditor({ record, all, api, onClose, onSaved, onReload, onInteractionStateChange, assistantOpenRequest, onAssistantOpenHandled }) {
  const [detail,setDetail]=useState(record), [form,setForm]=useState(()=>copyForm(record));
  const initial=useRef(JSON.stringify(form));
  const [busy,setBusy]=useState(false),[error,setError]=useState(null),[tab,setTab]=useState('agreement'),[people,setPeople]=useState([]),[peopleError,setPeopleError]=useState(''),[peopleRetry,setPeopleRetry]=useState(0),[peopleLoading,setPeopleLoading]=useState(true);
  const [shipment,setShipment]=useState(newShipment);
  const [shipmentInteractions,setShipmentInteractions]=useState({});
  const shipmentReporters=useRef(new Map());
  const shipmentCreateReporter=useCallback(state=>setShipmentInteractions(old=>({...old,create:state})),[]);
  const [factsDirty,setFactsDirty]=useState(false),[invalidMoney,setInvalidMoney]=useState({});
  const [financialAction,setFinancialAction]=useState(null),[financialState,setFinancialState]=useState({dirty:false,busy:false});
  const [readyAssistantRequest,setReadyAssistantRequest]=useState(null);
  const assistantOpenLive=useRef(null);
  const reportFinancial=useCallback(state=>setFinancialState(state),[]);
  const dialog=useRef(null),errorSummary=useRef(null);
  const actionRequests=useRef(new Map());
  const agreementDirty=JSON.stringify(form)!==initial.current;
  const dirty=agreementDirty||factsDirty||Object.values(shipmentInteractions).some(state=>state.dirty)||financialState.dirty||Object.values(invalidMoney).some(Boolean);
  const formBusy=busy||financialState.busy||Object.values(shipmentInteractions).some(state=>state.busy);
  const assistant=useAssistantForm({target:'order',entityId:detail?.id||null,recordVersion:detail?.version??null,values:form,dirty:agreementDirty,busy:formBusy,referenceChoices:{'items.itemId':{products:(all.products||[]).map(item=>item.id),combos:(all.combos||[]).map(item=>item.id)}},applyPatch:patch=>setForm(old=>({...old,...patch}))});
  const interactionBusy=formBusy||assistant.assistantBusy;
  const childParentBusy=busy||financialState.busy||assistant.assistantBusy;
  const shipmentBusyFor=key=>childParentBusy||Object.entries(shipmentInteractions).some(([id,state])=>id!==key&&state.busy);
  assistantOpenLive.current={dirty,busy:interactionBusy,version:detail?.version,id:detail?.id,generation:assistant.generation};
  const close=useDialog(dialog,{busy:interactionBusy,dirty,onClose:()=>{onInteractionStateChange({dirty:false,busy:false});onClose();}});
  useEffect(()=>{onInteractionStateChange({dirty,busy:interactionBusy});},[dirty,interactionBusy,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange({dirty:false,busy:false}),[onInteractionStateChange]);
  useEffect(()=>{if(error)errorSummary.current?.focus();},[error]);
  useEffect(()=>{let active=true;setPeopleLoading(true);setPeopleError('');api('/api/admin/business/people').then(result=>{if(active)setPeople(result.records);}).catch(cause=>{if(active)setPeopleError(cause.message);}).finally(()=>{if(active)setPeopleLoading(false);});return()=>{active=false;};},[api,peopleRetry]);
  useEffect(()=>{
    const request=assistantOpenRequest,open=request?.open;
    if(!request){setReadyAssistantRequest(null);return;}
    if(readyAssistantRequest?.requestId===request.requestId||!open||!['admin','order-editor'].includes(open.owner))return;
    const action=open.target?.startsWith('business-action:')?open.target.slice('business-action:'.length):null;
    if(!['order','shipment-create'].includes(open.target)&&!['collection','refund','return','complete-costs','resolve-legacy-payment','expense','link-shipment','document-reverse'].includes(action))return;
    if(interactionBusy)return;
    if(open.target==='order'&&!detail?.id&&open.entityId==null){
      setReadyAssistantRequest(request);onAssistantOpenHandled?.(request.requestId);return;
    }
    const orderRef=open.refs?.order;
    if(!orderRef||orderRef.id!==detail?.id)return;
    if(['order','shipment-create'].includes(open.target)&&open.entityId!==orderRef.id){setError(new Error('La propuesta no corresponde a este pedido.'));return;}
    if(open.target!=='order'&&dirty){setError(new Error('Guarda o descarta los cambios actuales antes de abrir la propuesta de Ali.'));return;}
    let active=true;
    const before=assistantOpenLive.current;
    (async()=>{
      try{
        const order=await api('/api/admin/orders/'+encodeURIComponent(orderRef.id));
        if(order.id!==orderRef.id||order.version!==orderRef.version||order.version!==before.version)throw new Error('El pedido cambió. Revisa la propuesta con los datos actuales.');
        const context={order};
        for(const [role,ref] of Object.entries(open.refs||{})){
          if(role==='order')continue;
          let value;
          if(role==='shipment')value=await api('/api/admin/business/shipments/'+encodeURIComponent(ref.id));
          else if(role==='expense')value=(order.expenses||[]).find(item=>item.id===ref.id);
          else if(['account','person','platform','source'].includes(role)){
            const resource={account:'accounts',person:'people',platform:'platforms',source:'sources'}[role];
            value=await api(`/api/admin/business/${resource}/${encodeURIComponent(ref.id)}`);
          }else if(role==='document'){
            if(!['collection','refund'].includes(ref.documentType))throw new Error('Este documento debe abrirse desde su espacio financiero.');
            value=(order.collections||[]).find(item=>item.id===ref.id&&(ref.documentType==='refund'?item.kind==='refund':['receipt','collection'].includes(item.kind)));
          }else throw new Error('La referencia no corresponde a una operación de este pedido.');
          if(!value||value.id!==ref.id||(ref.version!=null&&value.version!==ref.version))throw new Error('Una referencia cambió. Revisa la propuesta con los datos actuales.');
          if(role==='expense'&&value.orderId&&value.orderId!==order.id)throw new Error('El gasto no pertenece al pedido.');
          if(role==='shipment'&&action!=='link-shipment'&&value.orderId!==order.id)throw new Error('El envío no pertenece al pedido.');
          if(role==='document')Object.assign(context,{documentId:value.id,documentType:ref.documentType,documentVersion:value.version??1});
          else context[role]=value;
        }
        if(action==='link-shipment'&&!context.shipment)throw new Error('Falta el envío real que se vinculará.');
        const current=assistantOpenLive.current;
        if(!active||current.busy||current.id!==before.id||current.version!==before.version||current.generation!==before.generation||(open.target!=='order'&&current.dirty))return;
        if(open.target==='order'){
          if((tab!=='agreement'||financialAction)&&current.dirty)throw new Error('Conserva los cambios actuales antes de volver al acuerdo.');
          setFinancialAction(null);setFinancialState({dirty:false,busy:false});setTab('agreement');setReadyAssistantRequest(request);onAssistantOpenHandled?.(request.requestId);
        }else if(open.target==='shipment-create'){
          if(order.status==='cancelled')throw new Error('El pedido está cancelado y no admite un nuevo envío.');
          setFinancialAction(null);setTab('shipments');setReadyAssistantRequest(request);
        }else{
          openFinancial(action,context,request.requestId);setReadyAssistantRequest(request);
        }
      }catch(cause){if(active)setError(cause);}
    })();
    return()=>{active=false;};
  },[assistantOpenRequest,readyAssistantRequest?.requestId,api,detail?.id,detail?.version,dirty,interactionBusy,assistant.generation,tab,financialAction,onAssistantOpenHandled]);
  const financialRegistered=useCallback(binding=>{
    const request=readyAssistantRequest,open=request?.open;
    if(!request||request.requestId!==assistantOpenRequest?.requestId||binding.target!==open.target||(binding.entityId??null)!==(open.entityId??null))return;
    const ref=open.target==='business-action:link-shipment'?open.refs?.shipment:open.refs?.expense||open.refs?.order;
    if(open.entityId!=null&&ref?.version!=null&&binding.recordVersion!==ref.version)return;
    onAssistantOpenHandled?.(request.requestId);
  },[readyAssistantRequest,assistantOpenRequest?.requestId,onAssistantOpenHandled]);
  const products=all.products||[];
  const shippingExpenses=(detail?.expenses||[]).filter(expense=>expense.category==='shipping_out');
  const shipmentsWithoutFreight=(detail?.shipments||[]).filter(shipment=>!shippingExpenses.some(expense=>expense.shipmentId===shipment.id));
  const options=useMemo(()=>{
    const ownReservations=new Map((detail?.inventory?.products||[]).map(product=>[product.productId,product.reserved]));
    const forOrder=products.map(product=>({...product,stockReserved:Math.max(0,(product.stockReserved||0)-(ownReservations.get(product.id)||0))}));
    const byId=new Map(forOrder.map(product=>[product.id,product]));
    const enabled=p=>(p.orderable??p.status==='published')&&(p.productType!=='gift'||p.items?.every(component=>{const product=byId.get(component.productId);return product&&(product.orderable??product.status==='published');}));
    return [...forOrder.filter(enabled).map(p=>({...p,kind:'products',stockAvailable:stockAvailable(p,byId)})),...(all.combos||[]).filter(combo=>(combo.orderable??combo.status==='published')&&combo.price>0&&combo.items?.length&&combo.items.every(component=>{const product=byId.get(component.productId);return product&&product.productType!=='gift'&&enabled(product);})).map(combo=>({...combo,kind:'combos',stockAvailable:stockAvailable(combo,byId)}))];
  },[products,all.combos,detail?.inventory]);
  const frozen=Boolean(detail?.id&&(detail.economicLocked||['sent','delivered','returned','cancelled'].includes(detail.status)));
  const subtotalMinor=form.items.some(line=>line.unitPriceMinor==null||line.discountMinor==null)||Object.values(invalidMoney).some(Boolean)?null:form.items.reduce((sum,line)=>sum+line.quantity*line.unitPriceMinor-line.discountMinor,0);
  const totalMinor=subtotalMinor==null||form.shippingChargeMinor==null?null:subtotalMinor+form.shippingChargeMinor;
  const set=(key,value)=>setForm(old=>({...old,[key]:value}));
  const lineChange=(index,patch)=>setForm(old=>({...old,items:old.items.map((l,i)=>i===index?{...l,...patch}:l)}));
  function removeLine(index){
    set('items',form.items.filter((_,position)=>position!==index));
    setInvalidMoney(old=>Object.fromEntries(Object.entries(old).flatMap(([key,value])=>{
      const match=/^(price|discount)-(\d+)$/.exec(key);
      if(!match)return [[key,value]];
      const position=Number(match[2]);
      return position===index?[]:[[(position>index?`${match[1]}-${position-1}`:key),value]];
    })));
  }
  const input=(name,title,{required=false,type='text',disabled=false,maxLength=500}={})=><label className="field" key={name}>{title}{required?' *':''}<input name={name} type={type} value={form[name]??''} required={required} disabled={disabled} maxLength={maxLength} onChange={e=>set(name,e.target.value||null)}/></label>;
  const amount=(name,title,value,onChange,disabled=false,required=true)=><fieldset className="editor-fieldset" disabled={disabled}><Field field={{name,label:title,type:'moneyOptionalMinor',required}} value={value} onChange={onChange} onDraftInvalid={invalid=>setInvalidMoney(old=>({...old,[name]:invalid}))}/></fieldset>;
  async function save(e){
    e.preventDefault(); if(interactionBusy)return;
    setError(null);
    try{
      const result=await assistant.submitAssisted({payload:form,saveUnassisted:async payload=>{
        setBusy(true);
        try{return await api(`/api/admin/orders${detail?.id?'/'+encodeURIComponent(detail.id):''}`,{method:detail?.id?'PUT':'POST',body:JSON.stringify(payload)});}
        finally{setBusy(false);}
      },onCommitted:async saved=>{
        const next=copyForm(saved);initial.current=JSON.stringify(next);setForm(next);setDetail(saved);
        await onSaved({kind:'orders',record:saved,operation:detail?.id?'update':'create'});
      }});
      if(result.postCommitError)setError(new Error('Guardado; vista pendiente de actualizar. '+(result.postCommitError.message||'')));
      if(result.reason==='changed')setError(new Error('El acuerdo cambió mientras se guardaba. Revisa los valores e inténtalo de nuevo.'));
    }catch(cause){setError(cause);}
  }
  async function mutate(path,body,method='POST'){
    if(agreementDirty||Object.values(invalidMoney).some(Boolean))throw new Error('Guarda o descarta los cambios del acuerdo antes de registrar un hecho.');
    setBusy(true);setError(null);
    const operationKey=method+path+JSON.stringify(body);
    if(!actionRequests.current.has(operationKey))actionRequests.current.set(operationKey,crypto.randomUUID());
    try{
      const result=await api(path,{method,body:JSON.stringify({...body,requestId:body.requestId||actionRequests.current.get(operationKey)})});
      return result;
    }finally{setBusy(false);}
  }
  async function shipmentSaved(){
    const saved=await api('/api/admin/orders/'+encodeURIComponent(detail.id)),next=copyForm(saved);
    initial.current=JSON.stringify(next);setForm(next);setDetail(saved);setInvalidMoney({});
    await onSaved({kind:'orders',record:saved,operation:'action',keepOpen:true});
    actionRequests.current.clear();
  }
  async function shipmentCreated(){
    setFactsDirty(false);setShipment(newShipment());await shipmentSaved();
  }
  function openFinancial(action,context={},requestId=null){
    if(interactionBusy)return;
    if(agreementDirty||Object.values(invalidMoney).some(Boolean)){setError(new Error('Guarda los cambios del acuerdo antes de continuar.'));return;}
    if((factsDirty||Object.values(shipmentInteractions).some(state=>state.dirty)||financialState.dirty)&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y abrir esta acción?'))return;
    setFactsDirty(false);setShipment(newShipment());setFinancialState({dirty:false,busy:false});setFinancialAction({action,context,requestId});
  }
  function openShippingExpense(expense=null,shipment=null){
    openFinancial('expense',{expenseOnly:true,shipment,expense:expense||{
      category:'shipping_out',concept:'Flete / costo de envío',shipmentId:shipment?.id||null,
      sourceKey:shipment?undefined:`order:${detail.id}:shipping_out`
    }});
  }
  function cancelFinancial(){
    if(financialState.busy)return;
    if(financialState.dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos?'))return;
    setFinancialAction(null);setFinancialState({dirty:false,busy:false});
    requestAnimationFrame(()=>dialog.current?.querySelector('[data-financial-action]')?.focus());
  }
  async function financialSaved(){
    const saved=await api('/api/admin/orders/'+encodeURIComponent(detail.id)),next=copyForm(saved);
    initial.current=JSON.stringify(next);setForm(next);setDetail(saved);setFactsDirty(false);
    setFinancialAction(null);setFinancialState({dirty:false,busy:false});
    await onSaved({kind:'orders',record:saved,operation:'action',keepOpen:true});
  }
  const tabs=detail?.id?detailTabs:newOrderTabs;
  function changeTab(next){
    if(interactionBusy||next===tab)return;
    if(dirty&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y cambiar de sección?'))return;
    if(dirty){setForm(JSON.parse(initial.current));setFactsDirty(false);setInvalidMoney({});setShipmentInteractions({});setShipment(newShipment());}
    setFinancialAction(null);setFinancialState({dirty:false,busy:false});setTab(next);
  }
  return <dialog ref={dialog} className={`editor-drawer ${styles.editor}`} aria-labelledby="order-title">
    <header><div><p className="eyebrow">Pedidos · {detail?.id?'Detalle y operaciones':'Captura manual'}</p><h2 id="order-title" tabIndex={-1} data-dialog-initial-focus>{number(detail)}</h2><p>{detail?.id?'Acuerdo, envíos y movimientos del pedido':'Por crear · completa el destinatario y las referencias'}</p></div><button type="button" className="icon-button" aria-label="Cerrar pedido" disabled={interactionBusy} onClick={close}><Icon name="close"/></button></header>
    <div className="drawer-body">
      {error&&<div ref={errorSummary} tabIndex={-1} className="error" role="alert">{error.message}{error.status===409&&<button type="button" className="text-button" onClick={onReload}>Cargar versión guardada</button>}</div>}
      {financialAction?<BusinessActionForm key={[financialAction.action,financialAction.context.documentId||financialAction.context.expense?.id||financialAction.context.shipment?.id||'',financialAction.requestId||''].join(':')} action={financialAction.action} context={{order:detail,...financialAction.context}} api={api} onSaved={financialSaved} onCancel={cancelFinancial} onInteractionStateChange={reportFinancial} onAssistantRegistered={financialRegistered}/>:<>
      <WorkspaceTabs label="Detalle del pedido" items={tabs} value={tab} onChange={changeTab} disabled={interactionBusy}/>
      {detail?.id&&<p><strong>Campaña de origen:</strong> <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{detail.marketingCampaign||'Sin campaña informada'}</span></p>}
      {detail?.id&&tab==='agreement'&&<section className={styles.quickActions} aria-label="Operaciones del pedido"><p className={styles.sectionLabel}>Registrar un hecho</p><div className="admin-actions order-primary-actions"><button type="button" className="button primary" data-financial-action disabled={interactionBusy||detail.totalMinor===0} onClick={()=>openFinancial('collection')}>Registrar cobro</button><button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>changeTab('shipments')}>Actualizar envío</button><button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>openFinancial('return')}>Registrar devolución</button></div><p className="small muted">El acuerdo, el movimiento de dinero y los eventos de envío se guardan por separado.</p></section>}
      {tab==='agreement'&&<form id="order-agreement" onSubmit={save} aria-busy={interactionBusy}><fieldset className="editor-fieldset" disabled={interactionBusy}>
        <section className="form-section"><h3>1. Destinatario y fecha</h3><p className="small muted">Datos para identificar y entregar el pedido. Los campos con * son obligatorios.</p><div className="product-form-grid">{input('customerName','Nombre del destinatario',{required:true,maxLength:150})}{input('phone','Celular',{required:true,type:'tel',maxLength:30})}{input('city','Ciudad',{required:true,maxLength:100})}{input('department','Departamento',{maxLength:100})}{input('address','Dirección exacta')}{input('placedOn','Fecha del pedido',{required:true,type:'date',disabled:frozen})}</div></section>
        <section className="form-section"><h3>2. Productos y valor acordado</h3><p className="small muted">Guardar registra las reservas de todas las líneas y sus componentes. Las referencias sin conteo permiten registrar sin inventar existencias; un saldo contado en cero bloquea nuevas ventas. El servidor valida los saldos conocidos en conjunto.</p>{frozen&&<p className="hint">Acuerdo cerrado: cantidades, precios y cobros al cliente no se editan directamente. El costo de envío se puede completar o corregir abajo, sin cambiar el acuerdo.</p>}
          {!form.items.length&&<p className={styles.emptyPrompt}>Aún no agregas referencias. Usa «Agregar referencia» para elegir un producto, obsequio o combo.</p>}
          {form.items.map((line,index)=><div className={`form-section ${styles.itemCard}`} key={line.lineId}><h4>Línea {index+1}</h4>
            <label className="field">Referencia {index+1}<select name={`item-${index}`} required disabled={frozen} value={line.itemId?`${line.kind}:${line.itemId}`:''} onChange={e=>{const item=options.find(p=>`${p.kind}:${p.id}`===e.target.value);lineChange(index,{kind:item?.kind||'products',itemId:item?.id||'',title:item?.title||'',productType:item?.productType||'product',unitPriceMinor:(item?.price||0)*100,discountMinor:0});}}><option value="">Selecciona un producto</option>{line.itemId&&!options.some(p=>p.id===line.itemId&&p.kind===line.kind)&&<option value={`${line.kind}:${line.itemId}`}>{line.title} · Referencia histórica</option>}{options.map(p=><option key={p.kind+':'+p.id} value={p.kind+':'+p.id} disabled={p.stockAvailable===0&&!(line.itemId===p.id&&line.kind===p.kind)}>{p.title} · {p.presentation||(p.kind==='combos'?'Combo':'Producto')}{p.productType==='gift'?' · Obsequio':''} · {p.stockAvailable==null?'Sin conteo · permite registrar':`${p.stockAvailable} disponibles para este pedido`}</option>)}</select></label>
            <div className="product-form-grid"><label className="field">Cantidad {index+1}<input name={`quantity-${index}`} type="number" min={1} max={999} step={1} required disabled={frozen} value={line.quantity} onChange={e=>lineChange(index,{quantity:Number(e.target.value)})}/></label>{amount(`price-${index}`,`Precio unitario ${index+1} (COP)`,line.unitPriceMinor,value=>lineChange(index,{unitPriceMinor:value}),frozen)}{amount(`discount-${index}`,`Descuento total línea ${index+1} (COP)`,line.discountMinor,value=>lineChange(index,{discountMinor:value}),frozen)}</div>
            <p>Importe: {displayMinor(line.unitPriceMinor==null||line.discountMinor==null||invalidMoney[`price-${index}`]||invalidMoney[`discount-${index}`]?null:line.quantity*line.unitPriceMinor-line.discountMinor)}</p>
            {!frozen&&<button type="button" className="text-button" onClick={()=>removeLine(index)}>Quitar línea {index+1}</button>}
          </div>)}
          {!frozen&&<button type="button" className="button subtle" onClick={()=>set('items',[...form.items,{lineId:crypto.randomUUID(),kind:'products',itemId:'',quantity:1,unitPriceMinor:0,discountMinor:0}])}>Agregar referencia</button>}
          <h4 className={styles.subheading}>Entrega y flete del acuerdo</h4>
          <div className="product-form-grid">{amount('shippingChargeMinor','Flete cobrado al cliente (COP)',form.shippingChargeMinor,value=>set('shippingChargeMinor',value),frozen)}<label className="field">Modalidad<select name="deliveryMethod" value={form.deliveryMethod} disabled={frozen} onChange={e=>set('deliveryMethod',e.target.value)}><option value="carrier">Transportadora</option><option value="local">Entrega local</option><option value="pickup">Recogida presencial</option></select></label></div>
          <p className={styles.agreementTotal}><span>Total acordado</span><strong>{displayMinor(totalMinor)}</strong>{totalMinor===0&&<small>Sin cobro</small>}</p><p className="small muted">El flete cobrado no es el gasto real de transporte. Costos y totales se resuelven en el servidor.</p>
          <label className="field">Vendedor (opcional)<select name="sellerId" value={form.sellerId||''} disabled={frozen||peopleLoading} onChange={e=>set('sellerId',e.target.value||null)}><option value="">Sin asignar</option>{form.sellerId&&!people.some(person=>person.id===form.sellerId)&&<option value={form.sellerId}>{detail?.sellerSnapshot?.name||'Vendedor guardado'}</option>}{people.map(person=><option key={person.id} value={person.id}>{person.name}{person.active?'':' · Archivado'}</option>)}</select></label>
          {peopleLoading&&<p role="status">Cargando vendedores…</p>}{peopleError&&<p className="error" role="alert">{peopleError}<button type="button" className="text-button" onClick={()=>setPeopleRetry(value=>value+1)}>Reintentar vendedores</button></p>}
          {input('marketingCampaign','Campaña de origen (opcional)',{maxLength:200})}
          <p className="hint">Atribución comercial del pedido; no registra publicidad, gastos ni pagos.</p>
        </section>
        {detail?.id&&<section className="form-section" aria-labelledby="order-shipping-costs-title">
          <h3 id="order-shipping-costs-title">Flete / costo de envío</h3>
          <p className="small muted">Costo de la transportadora, incluido el importado. Se puede corregir aunque el pedido esté entregado. No se suma otra vez al total del cliente ni registra un pago.</p>
          {shippingExpenses.map(expense=>{
            const linkedShipment=detail.shipments.find(shipment=>shipment.id===expense.shipmentId);
            return <article className="form-section" key={expense.id}>
              <h4>{linkedShipment?.tracking?`Guía ${linkedShipment.tracking}`:expense.concept||'Costo del pedido'}</h4>
              <p><strong>{displayMinor(expense.amountMinor)}</strong> · {expense.incurredOn||'Fecha del costo pendiente'}</p>
              <button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>openShippingExpense(expense,linkedShipment)}>Corregir costo de envío</button>
            </article>;
          })}
          {!shippingExpenses.length&&<p>No hay un costo de envío registrado.</p>}
          <div className="admin-actions">
            {shipmentsWithoutFreight.map(shipment=><button type="button" className="button subtle" key={shipment.id} disabled={interactionBusy} onClick={()=>openShippingExpense(null,shipment)}>Registrar costo de envío{shipment.tracking?` · ${shipment.tracking}`:''}</button>)}
            {!detail.shipments.length&&!shippingExpenses.length&&<button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>openShippingExpense()}>Registrar costo de envío</button>}
          </div>
        </section>}
        <section className="form-section"><h3>3. Preparación</h3><label className="field">Estado comercial<select name="status" value={form.status} disabled={frozen} onChange={e=>set('status',e.target.value)}>{orderStates.filter(s=>s.value===form.status||['new','preparing','cancelled'].includes(s.value)).map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>{form.status === 'cancelled' && <>{input('statusReason','Motivo de cancelación',{required:true})}{input('cancellationOn','Fecha de cancelación',{required:true,type:'date'})}</>}<p className="hint">El despacho y la entrega se registran como eventos en Envíos. Cancelar no inventa un reembolso.</p></section>
        <details className="form-section"><summary>Más detalles · referencias, documento y notas</summary><div className="product-form-grid">{input('addressNotes','Barrio y referencias')}{input('email','Correo del destinatario',{type:'email',maxLength:254})}{input('documentType','Tipo de documento',{maxLength:30})}{input('documentNumber','Número de documento',{maxLength:80})}</div><label className="field">Notas internas<textarea name="notes" value={form.notes||''} maxLength={3000} rows={3} onChange={e=>set('notes',e.target.value)}/></label></details>
        {detail?.id&&<ImportedData record={detail} title="Datos importados del pedido"/>}
      </fieldset></form>}
      {tab==='shipments'&&<section className="form-section"><h3>Envíos de este pedido</h3>{!(detail.shipments||[]).length&&<p>Aún no hay guías. La primera asigna todas las líneas por defecto.</p>}{(detail.shipments||[]).map(s=>{
        if(!shipmentReporters.current.has(s.id))shipmentReporters.current.set(s.id,state=>setShipmentInteractions(old=>({...old,[s.id]:state})));
        return <article key={s.id} className="form-section"><h4>{s.tracking||'Entrega sin guía'}</h4><ShipmentControls key={s.id} shipment={s} inventoryOpening={detail.inventoryOpening} orderLines={detail.items} siblings={detail.shipments||[]} onMutate={mutate} onCommitted={shipmentSaved} busy={shipmentBusyFor(s.id)} onInteractionStateChange={shipmentReporters.current.get(s.id)}/></article>;
      })}{detail.status!=='cancelled'&&<ShipmentCreateAssistant detail={detail} shipment={shipment} setShipment={setShipment} orderLines={detail.items} busy={shipmentBusyFor('create')||agreementDirty} dirty={factsDirty} onDirty={()=>setFactsDirty(true)} onInteractionStateChange={shipmentCreateReporter} onMutate={mutate} onCommitted={shipmentCreated} assistantOpenRequest={readyAssistantRequest} onAssistantOpenHandled={onAssistantOpenHandled}/>}</section>}
      {tab==='collections'&&<section className="form-section"><h3>Cobros y devoluciones de dinero</h3>
        <p>Estado: {label(paymentStates,detail.paymentSummary?.status)}</p>
        <dl className="summary-values">{[['Cobrado neto','netCollectedMinor'],['Saldo del cliente','outstandingMinor'],['Saldo a favor / por reembolsar','refundDueMinor']].map(([title,key])=><div key={key}><dt>{title}</dt><dd>{displayMinor(detail.paymentSummary?.[key])}</dd></div>)}</dl>
        <div className="admin-actions"><button type="button" data-financial-action className="button primary" disabled={detail.totalMinor===0} onClick={()=>openFinancial('collection')}>Registrar cobro</button><button type="button" className="button subtle" disabled={!detail.paymentSummary?.netCollectedMinor} onClick={()=>openFinancial('refund')}>Registrar reembolso</button>{detail.paymentSummary?.legacyReview&&<button type="button" className="button subtle" onClick={()=>openFinancial('resolve-legacy-payment')}>Conciliar pago histórico</button>}</div>
        <h4 className={styles.subheading}>Movimientos registrados</h4>
        {!(detail.collections||[]).length&&<p className={styles.emptyPrompt}>No hay cobros ni reembolsos registrados en este pedido.</p>}
        <ul className="order-financial-facts">{(detail.collections||[]).map(c=>{const reversed=(detail.collections||[]).some(other=>other.reversalOf===c.id),canReverse=['receipt','refund'].includes(c.kind)&&!c.reversalOf&&!reversed&&c.holder!=='legacy';return <li key={c.id}><span>{({receipt:'Cobro',refund:'Reembolso',reversal:'Reversión'}[c.kind])||c.kind} · {displayMinor(c.amountMinor)} · {c.occurredOn||'Fecha pendiente'} · {({business:'Negocio',platform:'Plataforma',legacy:'Histórico por conciliar'}[c.holder])||c.holder}{reversed?' · Revertido':''}</span>{canReverse&&<button type="button" className="button subtle" onClick={()=>openFinancial('document-reverse',{documentType:c.kind==='refund'?'refund':'collection',documentId:c.id,documentVersion:c.version??1})}>Revertir {c.kind==='refund'?'reembolso':'cobro'}</button>}</li>;})}</ul>
        <p className="hint">Los cobros son hechos separados del acuerdo. Un recaudo de plataforma no es dinero disponible en el banco.</p>
      </section>}
      {tab==='profit'&&<section className="form-section"><h3>Acumulado del pedido</h3>
        <p>Reconocimiento: {detail.recognition?.on||'Pendiente de fecha / regla'}</p><p>Costos históricos: {detail.items.every(l=>l.unitCostMinor!=null)?displayMinor(detail.items.reduce((s,l)=>s+l.unitCostMinor*l.quantity,0)):'Por completar'}</p>
        <p>Contribución: {detail.financialSummary?.complete&&detail.financialSummary?.contributionMinor!=null?displayMinor(detail.financialSummary.contributionMinor):'Por completar'}</p>
        <div className="admin-actions"><button type="button" data-financial-action className="button primary" onClick={()=>openFinancial('return')}>Registrar devolución</button><button type="button" className="button subtle" onClick={()=>openFinancial('complete-costs')}>Completar o corregir costos</button><button type="button" className="button subtle" onClick={()=>openFinancial('expense')}>Registrar gasto del pedido</button></div>
        <h4 className={styles.subheading}>Devoluciones y cancelaciones registradas</h4>
        {!(detail.returns||[]).length&&<p className={styles.emptyPrompt}>No hay devoluciones ni cancelaciones registradas.</p>}
        <ul>{(detail.returns||[]).map(r=><li key={r.id}>{r.kind==='cancellation'?'Cancelación':'Devolución'} · {r.occurredOn} · {r.reason}</li>)}</ul>
        <details><summary>Historial</summary><ol className="history-timeline">{(detail.history||[]).map((h,i)=><li key={h.id||i}>{h.createdAt} · {h.reason||h.nextStatus||'Actualización'} · {h.actorEmail||h.actorId}</li>)}</ol></details>
      </section>}
      </>}
    </div>
    {!financialAction&&<footer className="editor-footer"><span role="status">{interactionBusy?'Guardando…':dirty?'Cambios sin guardar':number(detail)}</span><button type="button" className="button subtle" onClick={assistant.openAssistant} disabled={interactionBusy}>Ayúdame con este formulario</button><button type="button" className="button subtle" onClick={close} disabled={interactionBusy}>Cerrar</button>{tab==='agreement'&&<button className="button primary" type="submit" form="order-agreement" disabled={interactionBusy||Object.values(invalidMoney).some(Boolean)}>{detail?.id?'Guardar cambios':'Crear pedido'}<Icon name="check" size={16}/></button>}</footer>}
  </dialog>;
}
