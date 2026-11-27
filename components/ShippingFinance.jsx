'use client';

import { useEffect, useRef, useState } from 'react';
import { BusinessActionForm } from './BusinessActionDialog';
import { formatMoneyMinor } from '../lib/business/money.mjs';

export default function ShippingFinance({api,shipmentId,busy,onInteractionStateChange,onSaved}) {
  const [attempt,setAttempt]=useState(0),[state,setState]=useState(null),[action,setAction]=useState(null);
  const title=useRef(null),launch=useRef(null);
  useEffect(()=>{
    const abort=new AbortController();
    api(`/api/admin/business/shipments/${encodeURIComponent(shipmentId)}/finance`,{signal:abort.signal}).then(data=>{
      if(!abort.signal.aborted)setState({data,attempt});
    }).catch(error=>{
      if(!abort.signal.aborted)setState({error:error.message,attempt});
    });
    return ()=>abort.abort();
  },[api,shipmentId,attempt]);
  useEffect(()=>{if(action)title.current?.focus();},[action]);
  function open(event,name,label,context) {
    launch.current=event.currentTarget;
    setAction({name,label,context});
  }
  function cancel() {
    setAction(null);
    requestAnimationFrame(()=>launch.current?.focus());
  }
  function saved(result) {
    setAction(null);setAttempt(value=>value+1);
    onSaved?.(result);
  }
  const current=state?.attempt===attempt?state:null, data=current?.data;
  return <section className="form-section" aria-label="Caja de este envío">
    <h3 ref={title} tabIndex={-1}>{action?.label??'Caja de este envío'}</h3>
    <p>Solo registra dinero efectivamente recibido o pagado. Una novedad o un estado de entrega no registra movimientos en Caja.</p>
    {!current&&<p role="status">Buscando documentos vinculados…</p>}
    {current?.error&&<p role="alert" className="error">{current.error} <button type="button" className="text-button" disabled={busy} onClick={()=>setAttempt(value=>value+1)}>Reintentar</button></p>}
    {data&&<div hidden={Boolean(action)}>
      {data.order&&<button type="button" className="button subtle" disabled={busy} onClick={event=>open(event,'collection','Registrar cobro recibido directamente',{order:data.order,shipment:data.shipment,shippingReceipt:true})}>Registrar cobro recibido directamente</button>}
      {data.settlements.map(settlement=><div key={settlement.id} className="admin-actions"><span>{settlement.label||'Liquidación sin referencia'}</span><button type="button" className="button subtle" disabled={busy} onClick={event=>open(event,'settlement-confirm','Confirmar recepción de liquidación',{settlement,shippingReceipt:true})}>Confirmar recepción de liquidación</button></div>)}
      {data.expenses.map(expense=><div key={expense.id} className="admin-actions"><span>{expense.concept||expense.category} · {formatMoneyMinor(expense.outstandingMinor)} pendiente</span><button type="button" className="button subtle" disabled={busy} onClick={event=>open(event,'pay-expense','Registrar pago de gasto vinculado',{expense,shippingReceipt:true})}>Registrar pago de gasto vinculado</button></div>)}
      {!data.order&&!data.settlements.length&&!data.expenses.length&&<p>No hay cobros pendientes ni documentos de Caja elegibles para esta guía.</p>}
    </div>}
    {action&&<BusinessActionForm action={action.name} context={action.context} api={api} onSaved={saved} onCancel={cancel} onInteractionStateChange={onInteractionStateChange}/>}
  </section>;
}
