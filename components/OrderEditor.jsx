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
import styles from './OrderExperience.module.css';

const blank = () => ({ requestId: crypto.randomUUID(), placedOn: bogotaDate(), cancellationOn:bogotaDate(), sellerId:null, customerName:'', phone:'', city:'', department:'', address:'', addressNotes:'', email:'', documentType:'', documentNumber:'', notes:'', status:'new', statusReason:'', deliveryMethod:'carrier', shippingChargeMinor:0, items:[] });
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

export default function OrderEditor({ record, all, api, onClose, onSaved, onReload, onInteractionStateChange }) {
  const [detail,setDetail]=useState(record), [form,setForm]=useState(()=>copyForm(record));
  const initial=useRef(JSON.stringify(form));
  const [busy,setBusy]=useState(false),[error,setError]=useState(null),[tab,setTab]=useState('agreement'),[people,setPeople]=useState([]),[peopleError,setPeopleError]=useState(''),[peopleRetry,setPeopleRetry]=useState(0),[peopleLoading,setPeopleLoading]=useState(true);
  const [shipment,setShipment]=useState(newShipment);
  const [shipmentInteractions,setShipmentInteractions]=useState({});
  const shipmentReporters=useRef(new Map());
  const [factsDirty,setFactsDirty]=useState(false),[invalidMoney,setInvalidMoney]=useState({});
  const [financialAction,setFinancialAction]=useState(null),[financialState,setFinancialState]=useState({dirty:false,busy:false});
  const reportFinancial=useCallback(state=>setFinancialState(state),[]);
  const dialog=useRef(null),errorSummary=useRef(null);
  const actionRequests=useRef(new Map());
  const agreementDirty=JSON.stringify(form)!==initial.current;
  const dirty=agreementDirty||factsDirty||Object.values(shipmentInteractions).some(state=>state.dirty)||financialState.dirty||Object.values(invalidMoney).some(Boolean);
  const interactionBusy=busy||financialState.busy;
  const close=useDialog(dialog,{busy:interactionBusy,dirty,onClose:()=>{onInteractionStateChange({dirty:false,busy:false});onClose();}});
  useEffect(()=>{onInteractionStateChange({dirty,busy:interactionBusy});},[dirty,interactionBusy,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange({dirty:false,busy:false}),[onInteractionStateChange]);
  useEffect(()=>{if(error)errorSummary.current?.focus();},[error]);
  useEffect(()=>{let active=true;setPeopleLoading(true);setPeopleError('');api('/api/admin/business/people').then(result=>{if(active)setPeople(result.records);}).catch(cause=>{if(active)setPeopleError(cause.message);}).finally(()=>{if(active)setPeopleLoading(false);});return()=>{active=false;};},[api,peopleRetry]);
  const products=all.products||[];
  const options=useMemo(()=>{
    const ownReservations=new Map((detail?.inventory?.products||[]).map(product=>[product.productId,product.reserved]));
    const forOrder=products.map(product=>({...product,stockReserved:Math.max(0,(product.stockReserved||0)-(ownReservations.get(product.id)||0))}));
    const byId=new Map(forOrder.map(product=>[product.id,product]));
    const enabled=p=>(p.orderable??p.status==='published')&&(p.productType!=='gift'||p.items?.every(component=>{const product=byId.get(component.productId);return product&&(product.orderable??product.status==='published');}));
    return [...forOrder.filter(enabled).map(p=>({...p,kind:'products',stockAvailable:stockAvailable(p,byId)})),...(all.combos||[]).filter(combo=>combo.status==='published'&&combo.items.every(component=>{const product=byId.get(component.productId);return product&&enabled(product);})).map(combo=>({...combo,kind:'combos',stockAvailable:stockAvailable(combo,byId)}))];
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
    e.preventDefault(); if(interactionBusy)return; setBusy(true);setError(null);let committed=false;
    try { const saved=await api(`/api/admin/orders${detail?.id?'/'+encodeURIComponent(detail.id):''}`,{method:detail?.id?'PUT':'POST',body:JSON.stringify(form)});committed=true;initial.current=JSON.stringify(copyForm(saved));await onSaved({kind:'orders',record:saved,operation:detail?.id?'update':'create'}); }
    catch(cause){setError(committed?new Error('Guardado; vista pendiente de actualizar. '+cause.message):cause);}finally{setBusy(false);}
  }
  async function mutate(path,body,method='POST'){
    if(interactionBusy)return;
    if(agreementDirty||Object.values(invalidMoney).some(Boolean)){setError(new Error('Guarda o descarta los cambios del acuerdo antes de registrar un hecho.'));return;}
    if(factsDirty&&path!=='/api/admin/business/shipments'&&!window.confirm('Hay una guía nueva sin guardar. ¿Descartarla para registrar esta acción?'))return;
    setBusy(true);setError(null);
    const operationKey=method+path+JSON.stringify(body);
    if(!actionRequests.current.has(operationKey))actionRequests.current.set(operationKey,crypto.randomUUID());
    let committed=false;
    try {
      await api(path,{method,body:JSON.stringify({...body,requestId:body.requestId||actionRequests.current.get(operationKey)})});committed=true;
      const saved=await api('/api/admin/orders/'+encodeURIComponent(detail.id));
      const next=copyForm(saved);initial.current=JSON.stringify(next);setForm(next);setDetail(saved);
      setFactsDirty(false);setInvalidMoney({});setShipment(newShipment());
      await onSaved({kind:'orders',record:saved,operation:'action',keepOpen:true});
      actionRequests.current.delete(operationKey);
      return true;
    }catch(cause){setError(committed?new Error('Guardado; vista pendiente de actualizar. '+cause.message):cause);}finally{setBusy(false);}
  }
  function openFinancial(action,context={}){
    if(interactionBusy)return;
    if(agreementDirty||Object.values(invalidMoney).some(Boolean)){setError(new Error('Guarda los cambios del acuerdo antes de continuar.'));return;}
    if((factsDirty||Object.values(shipmentInteractions).some(state=>state.dirty)||financialState.dirty)&&!window.confirm('Hay cambios sin guardar. ¿Descartarlos y abrir esta acción?'))return;
    setFactsDirty(false);setShipment(newShipment());setFinancialState({dirty:false,busy:false});setFinancialAction({action,context});
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
      {financialAction?<BusinessActionForm key={financialAction.action+':'+(financialAction.context.documentId||'')} action={financialAction.action} context={{order:detail,...financialAction.context}} api={api} onSaved={financialSaved} onCancel={cancelFinancial} onInteractionStateChange={reportFinancial}/>:<>
      <WorkspaceTabs label="Detalle del pedido" items={tabs} value={tab} onChange={changeTab} disabled={interactionBusy}/>
      {detail?.id&&tab==='agreement'&&<section className={styles.quickActions} aria-label="Operaciones del pedido"><p className={styles.sectionLabel}>Registrar un hecho</p><div className="admin-actions order-primary-actions"><button type="button" className="button primary" data-financial-action disabled={interactionBusy||detail.totalMinor===0} onClick={()=>openFinancial('collection')}>Registrar cobro</button><button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>changeTab('shipments')}>Actualizar envío</button><button type="button" className="button subtle" disabled={interactionBusy} onClick={()=>openFinancial('return')}>Registrar devolución</button></div><p className="small muted">El acuerdo, el movimiento de dinero y los eventos de envío se guardan por separado.</p></section>}
      {tab==='agreement'&&<form id="order-agreement" onSubmit={save} aria-busy={busy}><fieldset className="editor-fieldset" disabled={busy}>
        <section className="form-section"><h3>1. Destinatario y fecha</h3><p className="small muted">Datos para identificar y entregar el pedido. Los campos con * son obligatorios.</p><div className="product-form-grid">{input('customerName','Nombre del destinatario',{required:true,maxLength:150})}{input('phone','Celular',{required:true,type:'tel',maxLength:30})}{input('city','Ciudad',{required:true,maxLength:100})}{input('department','Departamento',{maxLength:100})}{input('address','Dirección exacta')}{input('placedOn','Fecha del pedido',{required:true,type:'date',disabled:frozen})}</div></section>
        <section className="form-section"><h3>2. Productos y valor acordado</h3><p className="small muted">Guardar reserva las unidades de todas las líneas y sus componentes. El servidor valida las existencias en conjunto; seleccionar aquí no reserva todavía.</p>{frozen&&<p className="hint">Acuerdo cerrado: cantidades, precios y flete se corrigen con una devolución o ajuste explícito, no editando el pedido.</p>}
          {!form.items.length&&<p className={styles.emptyPrompt}>Aún no agregas referencias. Usa «Agregar referencia» para elegir un producto, obsequio o combo.</p>}
          {form.items.map((line,index)=><div className={`form-section ${styles.itemCard}`} key={line.lineId}><h4>Línea {index+1}</h4>
            <label className="field">Referencia {index+1}<select name={`item-${index}`} required disabled={frozen} value={line.itemId?`${line.kind}:${line.itemId}`:''} onChange={e=>{const item=options.find(p=>`${p.kind}:${p.id}`===e.target.value);lineChange(index,{kind:item?.kind||'products',itemId:item?.id||'',title:item?.title||'',productType:item?.productType||'product',unitPriceMinor:(item?.price||0)*100,discountMinor:0});}}><option value="">Selecciona un producto</option>{line.itemId&&!options.some(p=>p.id===line.itemId&&p.kind===line.kind)&&<option value={`${line.kind}:${line.itemId}`}>{line.title} · Referencia histórica</option>}{options.map(p=><option key={p.kind+':'+p.id} value={p.kind+':'+p.id} disabled={(p.stockAvailable==null||p.stockAvailable===0)&&!(line.itemId===p.id&&line.kind===p.kind)}>{p.title} · {p.presentation||(p.kind==='combos'?'Combo':'Producto')}{p.productType==='gift'?' · Obsequio':''} · {p.stockAvailable==null?'Existencias sin contar':`${p.stockAvailable} disponibles para este pedido`}</option>)}</select></label>
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
        </section>
        <section className="form-section"><h3>3. Preparación</h3><label className="field">Estado comercial<select name="status" value={form.status} disabled={frozen} onChange={e=>set('status',e.target.value)}>{orderStates.filter(s=>s.value===form.status||['new','preparing','cancelled'].includes(s.value)).map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select></label>{form.status === 'cancelled' && <>{input('statusReason','Motivo de cancelación',{required:true})}{input('cancellationOn','Fecha de cancelación',{required:true,type:'date'})}</>}<p className="hint">El despacho y la entrega se registran como eventos en Envíos. Cancelar no inventa un reembolso.</p></section>
        <details className="form-section"><summary>Más detalles · referencias, documento y notas</summary><div className="product-form-grid">{input('addressNotes','Barrio y referencias')}{input('email','Correo del destinatario',{type:'email',maxLength:254})}{input('documentType','Tipo de documento',{maxLength:30})}{input('documentNumber','Número de documento',{maxLength:80})}</div><label className="field">Notas internas<textarea name="notes" value={form.notes||''} maxLength={3000} rows={3} onChange={e=>set('notes',e.target.value)}/></label></details>
      </fieldset></form>}
      {tab==='shipments'&&<section className="form-section"><h3>Envíos de este pedido</h3>{!(detail.shipments||[]).length&&<p>Aún no hay guías. La primera asigna todas las líneas por defecto.</p>}{(detail.shipments||[]).map(s=>{
        if(!shipmentReporters.current.has(s.id))shipmentReporters.current.set(s.id,state=>setShipmentInteractions(old=>({...old,[s.id]:state})));
        return <article key={s.id} className="form-section"><h4>{s.tracking||'Entrega sin guía'}</h4><ShipmentControls key={s.id+':'+s.version} shipment={s} orderLines={detail.items} siblings={detail.shipments||[]} onMutate={mutate} busy={busy} onInteractionStateChange={shipmentReporters.current.get(s.id)}/></article>;
      })}{detail.status!=='cancelled'&&<details className="form-section" onChangeCapture={()=>setFactsDirty(true)}><summary>Registrar guía o entrega local</summary><div className="product-form-grid"><label className="field">Transportadora<input maxLength={200} value={shipment.carrier} onChange={e=>setShipment({...shipment,carrier:e.target.value})}/></label><label className="field">Número de guía<input maxLength={200} value={shipment.tracking} onChange={e=>setShipment({...shipment,tracking:e.target.value})}/></label><label className="field">Entrega estimada<input type="date" value={shipment.estimatedDeliveryOn} onChange={e=>setShipment({...shipment,estimatedDeliveryOn:e.target.value})}/></label><label className="field">Reemplaza a<select value={shipment.replacesShipmentId} onChange={e=>setShipment({...shipment,replacesShipmentId:e.target.value,split:false,assignments:{}})}><option value="">Envío inicial o división</option>{(detail.shipments||[]).map(s=><option key={s.id} value={s.id}>{s.tracking||'Entrega sin guía'} · {s.carrier||'Local'}</option>)}</select></label></div>{!shipment.replacesShipmentId&&<label className="checkbox-field"><input type="checkbox" checked={shipment.split} onChange={e=>setShipment({...shipment,split:e.target.checked})}/>Dividir envío</label>}{shipment.split&&detail.items.map(l=><label className="field" key={l.lineId}>{l.title} (comprado: {l.quantity})<input type="number" min={0} max={l.quantity} step={1} value={shipment.assignments[l.lineId]??0} onChange={e=>setShipment({...shipment,assignments:{...shipment.assignments,[l.lineId]:Number(e.target.value)}})}/></label>)}<button className="button primary" type="button" disabled={busy} onClick={()=>mutate('/api/admin/business/shipments',{orderId:detail.id,carrier:shipment.carrier,tracking:shipment.tracking,estimatedDeliveryOn:shipment.estimatedDeliveryOn||null,replacesShipmentId:shipment.replacesShipmentId||null,...(shipment.split?{assignments:detail.items.map(l=>({lineId:l.lineId,quantity:shipment.assignments[l.lineId]||0})).filter(l=>l.quantity>0)}:{})})}>Registrar envío</button></details>}</section>}
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
    {!financialAction&&<footer className="editor-footer"><span role="status">{interactionBusy?'Guardando…':dirty?'Cambios sin guardar':number(detail)}</span><button type="button" className="button subtle" onClick={close} disabled={interactionBusy}>Cerrar</button>{tab==='agreement'&&<button className="button primary" type="submit" form="order-agreement" disabled={interactionBusy||Object.values(invalidMoney).some(Boolean)}>{detail?.id?'Guardar cambios':'Crear pedido'}<Icon name="check" size={16}/></button>}</footer>}
  </dialog>;
}
