'use client';
import { useEffect, useRef, useState } from 'react';
import { Field } from './Fields';
import useDialog from './useDialog';
import { bogotaDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor, MAX_MONEY_MINOR } from '@/lib/business/money.mjs';
import styles from './FinanceExperience.module.css';

const titles={collection:'Registrar cobro',refund:'Registrar reembolso',return:'Registrar devolución','complete-costs':'Completar o corregir costos','resolve-legacy-payment':'Conciliar pago histórico',expense:'Registrar gasto','expense-recovery':'Recuperar sobrepago','pay-expense':'Pagar gasto',income:'Registrar ingreso',advance:'Registrar anticipo',transfer:'Transferir','cash-close':'Cerrar caja','cash-reopen':'Reabrir cierre','cash-reverse':'Revertir movimiento','document-reverse':'Revertir documento','settlement-save':'Registrar liquidación','settlement-confirm':'Confirmar recepción','payroll-prepare':'Preparar sueldo','payroll-confirm':'Confirmar sueldo','payroll-pay':'Pagar sueldo','link-shipment':'Vincular pedido'};
titles['account-save']='Configurar cuenta';
const actionGuidance={ 'account-save':'Identifica la cuenta y su responsable. La apertura requiere un saldo confirmado; no se reescribe al editar.',expense:'Registra primero la obligación. Elegir una cuenta de pago añade una salida real; sin cuenta, el gasto queda pendiente.',income:'Registra dinero recibido no ligado a una venta. Revisa cuenta, importe y fecha antes de guardar.',transfer:'Mueve dinero entre dos cuentas del negocio. La transferencia no es una venta ni un gasto.',advance:'Registra una salida real para una persona; se aplicará a su remuneración sin volver a generar gasto.','cash-close':'Compara el dinero contado con el saldo registrado. Guardar el cierre conserva la diferencia y no ajusta el saldo.','settlement-save':'Declara y vincula los soportes. Registrar la liquidación no confirma todavía dinero recibido.','settlement-confirm':'Confirma solo el bruto, retenciones y neto de este recibo. Puedes registrar una recepción parcial.','payroll-prepare':'1. Selecciona persona y período. 2. Revisa los devengos calculados. 3. Confirma el período; el pago se registra por separado.','payroll-confirm':'Revisa el período y las obligaciones antes de confirmar. Esta acción devenga; no registra un pago.'};
const display=value=>value==null?'Sin dato':Number.isSafeInteger(value)&&Math.abs(value)<=MAX_MONEY_MINOR?formatMoneyMinor(value):'Revisa el importe';
const active=rows=>{const reversed=new Set(rows.filter(r=>r.reversalOf).map(r=>r.reversalOf));return rows.filter(r=>!r.reversalOf&&!reversed.has(r.id));};
function ActionMoneyField(props){
  const callback=useRef(props.onDraftInvalid);callback.current=props.onDraftInvalid;
  useEffect(()=>()=>callback.current(false),[]);
  return <Field {...props}/>;
}
function remainingSettlement(settlement){
  const receipts=active(settlement?.receipts||[]);
  return (settlement?.lines||[]).map(line=>({collectionId:line.collectionId,label:line.label,grossMinor:line.grossMinor-receipts.reduce((s,r)=>s+(r.lines||[]).filter(l=>l.collectionId===line.collectionId).reduce((s,l)=>s+l.grossMinor,0),0),deductions:(line.deductions||[]).map(d=>({expenseId:d.expenseId,label:d.label,amountMinor:d.amountMinor-receipts.reduce((s,r)=>s+(r.lines||[]).filter(l=>l.collectionId===line.collectionId).flatMap(l=>l.deductions||[]).filter(x=>x.expenseId===d.expenseId).reduce((s,x)=>s+x.amountMinor,0),0)}))}));
}
function initial(action,context){
  const {order,expense,settlement,payroll,account,closing,entry,shipment}=context,today=bogotaDate();
  return {orderId:order?.id,version:action==='document-reverse'?(context.documentVersion??1):action==='link-shipment'?(shipment?.version??1):order?.version||expense?.version||settlement?.version||payroll?.version||closing?.version||account?.version||1,
    occurredOn:today,effectiveOn:today,receivedOn:today,incurredOn:expense?expense.incurredOn:today,closingOn:today,
    amountMinor:action==='expense'?expense?.amountMinor??null:action==='collection'?order?.paymentSummary?.outstandingMinor??null:action==='refund'?order?.paymentSummary?.refundDueMinor??null:action==='pay-expense'?expense?.outstandingMinor??null:action==='expense-recovery'?expense?.creditMinor??null:action==='payroll-pay'?payroll?.amountToPayMinor??null:null,
    accountId:account?.id||null,holder:'business',shipmentId:shipment?.id||expense?.shipmentId||null,method:'Transferencia',reference:'',reason:'',concept:action==='income'?'owner_funding':expense?.concept||'',description:'',supplier:expense?.supplier||'',category:expense?.category||'other',allowCredit:false,
    expenseId:expense?.id,settlementId:settlement?.id,payrollId:payroll?.id,personId:payroll?.personId||expense?.personId||null,startOn:payroll?.startOn||today.slice(0,8)+'01',endOnExclusive:payroll?.endOnExclusive||'',
    closingId:closing?.id,cashEntryId:entry?.id,documentId:context.documentId||entry?.sourceId||'',documentType:context.documentType||'collection',
    fromAccountId:account?.id||null,toAccountId:null,countedMinor:null,shippingCreditMinor:0,mode:'opening_balance',
    lines:action==='settlement-confirm'?remainingSettlement(settlement):action==='settlement-save'?(settlement?.lines||[]):action==='return'?(order?.items||[]).map(l=>({lineId:l.lineId,quantity:0,condition:'recoverable'})):[],
    assignments:(order?.items||[]).map(l=>({lineId:l.lineId,quantity:order?.shipments?.length?0:l.quantity})),
    lineCosts:(order?.items||[]).map(l=>({lineId:l.lineId,selected:l.unitCostMinor==null,unitCostMinor:l.unitCostMinor,components:l.components?.map(c=>({productId:c.productId,unitCostMinor:c.unitCostMinor}))||[]})),
    receiptAmountMinor:null,refundAmountMinor:null,receiptOn:'',refundOn:'',sourceId:settlement?.sourceId||null,externalKey:settlement?.externalId||'',reportedOn:settlement?.reportedOn||today,netMinor:settlement?.netMinor??null,
    bonusMinor:0,discountMinor:0,name:account?.name||'',type:account?.type||'cash',active:account?.active??true,
    responsibleId:account?.responsibleId||null,newPersonName:'',openingOn:account?.openingOn||today,
    openingBalanceMinor:null,minimumMinor:account?.minimumMinor??null,closingEnabled:account?.closingEnabled??false,
    closingTime:account?.closingTime??null,toleranceMinor:account?.toleranceMinor??0};
}
export function BusinessActionForm({action,context={},api,onSaved,onCancel,onInteractionStateChange=()=>{},configuration=false}){
  const [form,setForm]=useState(()=>initial(action,context)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[accounts,setAccounts]=useState([]),[people,setPeople]=useState([]),[sources,setSources]=useState([]),[preview,setPreview]=useState(null),[invalid,setInvalid]=useState({});
  const requestId=useRef(crypto.randomUUID()),baseline=useRef(JSON.stringify(form)),errorRef=useRef(null),sequence=useRef(0);
  const lastPayload=useRef(null),confirmRequest=useRef({key:null,id:crypto.randomUUID()});
  const personRequestId=useRef(crypto.randomUUID());
  const personName=useRef(null);
  const dirty=JSON.stringify(form)!==baseline.current||Object.values(invalid).some(Boolean);
  useEffect(()=>{onInteractionStateChange({busy,dirty});},[busy,dirty,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange({busy:false,dirty:false}),[onInteractionStateChange]);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  async function load(){
    const seq=++sequence.current;setError('');
    try {
      const needsAccounts=!['return','complete-costs','link-shipment','account-save'].includes(action),needsPeople=['expense','advance','payroll-prepare','payroll-confirm','account-save'].includes(action),needsSources=action==='settlement-save';
      const [accountData,settings,personData,sourceData]=await Promise.all([needsAccounts?api('/api/admin/business/accounts'):null,needsAccounts?api('/api/admin/business/settings'):null,needsPeople?api('/api/admin/business/people'):null,needsSources?api('/api/admin/business/sources'):null]);
      if(seq!==sequence.current)return;
      setAccounts(accountData?.records||[]);setPeople(personData?.records||[]);setSources(sourceData?.records||[]);
      const accountId=['collection','income','settlement-confirm','expense-recovery'].includes(action)?settings?.defaultReceiptAccountId:settings?.defaultPaymentAccountId;
      if(accountId&&!(action==='expense'&&context.expense?.id))setForm(old=>{if(old.accountId)return old;baseline.current=JSON.stringify({...JSON.parse(baseline.current),accountId});return {...old,accountId};});
      setLoaded(true);
    }catch(cause){if(seq===sequence.current)setError(cause.message);}
  }
  useEffect(()=>{void load();return()=>{sequence.current++;};},[action,api]);
  const set=(key,value)=>{if(key==='sourceId'&&form.lines.length){setError('Quita los cobros vinculados antes de cambiar la cuenta de plataforma.');return;}setForm(old=>({...old,[key]:value,...(key==='type'&&value!=='cash'?{closingEnabled:false,closingTime:null}:{})}));setPreview(null);};
  const input=(key,title,{required=false,type='text',nullable=false,disabled=false}={})=><label className="field" key={key}>{title}{required?' *':''}<input type={type} name={key} value={form[key]??''} required={required} disabled={disabled} maxLength={key==='reason'?2000:300} onChange={e=>set(key,nullable&&!e.target.value?null:e.target.value)}/></label>;
  const amount=(key,title,value=form[key],onChange=value=>set(key,value),{required=true,signed=false}={})=><ActionMoneyField key={key} field={{name:key,label:title,type:'moneyOptionalMinor',required,signed,description:'Pesos COP. Punto para miles, coma para centavos; no se redondean importes.'}} value={value} onChange={onChange} onDraftInvalid={value=>setInvalid(old=>({...old,[key]:value}))}/>;
  const select=(key,title,options,{required=true}={})=><label className="field" key={key}>{title}{required?' *':''}<select name={key} value={form[key]??''} required={required} onChange={e=>set(key,e.target.value||null)}><option value="">Selecciona una opción</option>{options.map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label>;
  const accountSelect=(key='accountId',title='Cuenta',required=true)=>select(key,title,accounts.filter(a=>(a.active||a.id===form[key])&&(action!=='cash-close'||a.type==='cash')).map(a=>[a.id,a.name]),{required});
  const personSelect=(required=true)=><>{select('personId','Persona responsable',people.filter(p=>p.active||p.id===form.personId).map(p=>[p.id,p.name]),{required})}<details><summary>Crear persona sin acceso al panel</summary>{input('newPersonName','Nombre de la persona nueva')}<button type="button" className="button subtle" disabled={busy||!form.newPersonName.trim()} onClick={()=>createResponsible('personId')}>Crear persona</button></details></>;
  const reason=()=>input('reason','Motivo',{required:true});
  async function createResponsible(key='responsibleId'){
    if(busy||!form.newPersonName.trim())return;setBusy(true);setError('');
    try{
      if(personName.current!==null&&personName.current!==form.newPersonName.trim())personRequestId.current=crypto.randomUUID();personName.current=form.newPersonName.trim();
      const person=await api('/api/admin/business/people',{method:'POST',body:JSON.stringify({requestId:personRequestId.current,name:form.newPersonName.trim(),active:true})});
      personRequestId.current=crypto.randomUUID();setPeople(old=>[...old.filter(p=>p.id!==person.id),person]);
      setForm(old=>({...old,[key]:person.id,newPersonName:''}));
    }catch(cause){setError(cause.message);}finally{setBusy(false);}
  }
  function payload(){
    const fields={
      'account-save':'version name type active responsibleId openingOn openingBalanceMinor minimumMinor closingEnabled closingTime toleranceMinor reason',
      collection:'orderId version amountMinor occurredOn holder accountId shipmentId method reference allowCredit',
      refund:'orderId version amountMinor occurredOn holder accountId shipmentId method reference reason',
      return:'orderId version occurredOn reason shippingCreditMinor lines',
      'complete-costs':'orderId version reason',
      'resolve-legacy-payment':'orderId version mode accountId occurredOn method reference reason receiptAmountMinor refundAmountMinor receiptOn refundOn',
      expense:'expenseId version category amountMinor incurredOn concept supplier personId orderId shipmentId accountId effectiveOn reference reason',
      'pay-expense':'expenseId version amountMinor accountId effectiveOn reference',
      'expense-recovery':'expenseId version amountMinor accountId effectiveOn reason reference',
      income:'accountId effectiveOn amountMinor concept description reference',
      advance:'personId accountId effectiveOn amountMinor concept reference',
      transfer:'fromAccountId toAccountId effectiveOn amountMinor concept reference',
      'cash-close':'accountId closingOn countedMinor',
      'cash-reopen':'closingId version reason',
      'cash-reverse':'cashEntryId effectiveOn reason',
      'document-reverse':'documentType documentId version effectiveOn reason',
      'settlement-save':'settlementId version sourceId externalKey reportedOn netMinor lines reason',
      'settlement-confirm':'settlementId version receivedOn accountId externalKey lines reason',
      'payroll-prepare':'personId startOn endOnExclusive bonusMinor discountMinor reason',
      'payroll-confirm':'payrollId version personId startOn endOnExclusive bonusMinor discountMinor reason',
      'payroll-pay':'payrollId version amountMinor accountId effectiveOn reference',
      'link-shipment':'shipmentId orderId version reason assignments'
    }[action].split(' ');
    const out={...Object.fromEntries(fields.filter(key=>form[key]!==undefined).map(key=>[key,form[key]])),requestId:requestId.current};
    for(const key of ['accountId','shipmentId','personId','expenseId','settlementId','payrollId','externalKey'])if(out[key]==null||out[key]==='')delete out[key];
    if(action==='return')out.lines=form.lines.filter(l=>l.quantity>0);
    if(action==='link-shipment')out.assignments=form.assignments.filter(l=>l.quantity>0);
    if(action==='complete-costs')out.lineCosts=form.lineCosts.filter(l=>l.selected).map(({selected,...line})=>line);
    if(action==='settlement-confirm')out.lines=form.lines.filter(l=>l.grossMinor!==0||l.deductions.some(d=>d.amountMinor!==0));
    if(action==='settlement-save'||action==='settlement-confirm')out.lines=out.lines.map(l=>({collectionId:l.collectionId,grossMinor:l.grossMinor,deductions:l.deductions.filter(d=>d.amountMinor!==0).map(d=>({expenseId:d.expenseId,amountMinor:d.amountMinor}))}));
    if(action==='expense'&&!out.accountId)delete out.effectiveOn;
    if(action==='resolve-legacy-payment'&&out.mode==='opening_balance'){delete out.accountId;delete out.occurredOn;delete out.effectiveOn;}
    if(action==='account-save'&&context.account?.id)delete out.openingBalanceMinor;
    return out;
  }
  async function submit(event){
    event.preventDefault();if(busy||(action==='link-shipment'&&!context.order?.id))return;setBusy(true);setError('');
    let committed=false;
    try {
      const accountEdit=action==='account-save'&&context.account?.id;
      const path=action==='account-save'?'/api/admin/business/accounts'+(accountEdit?'/'+encodeURIComponent(context.account.id):''):'/api/admin/business/actions/'+action;
      const body=payload(),key=JSON.stringify({...body,requestId:undefined});if(lastPayload.current!==null&&lastPayload.current!==key)requestId.current=crypto.randomUUID();lastPayload.current=key;body.requestId=requestId.current;
      const response=await api(path,{method:accountEdit?'PUT':'POST',body:JSON.stringify(body)});
      if(action==='payroll-prepare'){setPreview(response);return;}
      committed=true;baseline.current=JSON.stringify(form);await onSaved(response);
    }catch(cause){setError(committed?'Guardado; vista pendiente de actualizar. '+cause.message:cause.message);}finally{setBusy(false);}
  }
  async function confirmPrepared(){
    if(busy||!preview)return;setBusy(true);setError('');
    let committed=false;
    try {const body={...payload(),payrollId:preview.id||preview.payrollId,version:preview.version||form.version};const key=JSON.stringify({...body,requestId:undefined});if(confirmRequest.current.key!==key)confirmRequest.current={key,id:crypto.randomUUID()};body.requestId=confirmRequest.current.id;const response=await api('/api/admin/business/actions/payroll-confirm',{method:'POST',body:JSON.stringify(body)});committed=true;baseline.current=JSON.stringify(form);await onSaved(response);}catch(cause){setError(committed?'Guardado; vista pendiente de actualizar. '+cause.message:cause.message);}finally{setBusy(false);}
  }
  const order=context.order;
  const net=form.lines.reduce((sum,l)=>sum+(l.grossMinor||0)-(l.deductions||[]).reduce((s,d)=>s+(d.amountMinor||0),0),0);
  return <form onSubmit={submit} aria-busy={busy} className={`business-action-form ${styles.actionForm}`}>
    {error&&<div ref={errorRef} tabIndex={-1} className="error" role="alert">{error}{!loaded&&<button type="button" className="text-button" onClick={load}>Reintentar</button>}</div>}
    {!loaded&&!error&&<p role="status">Cargando datos de la acción…</p>}
    <fieldset className="editor-fieldset" disabled={busy||!loaded}>
      {actionGuidance[action]&&<p className={styles.formGuide}>{action==='expense'&&context.expense?.id?'Corrige el gasto con un motivo. Sus pagos anteriores se conservan; un sobrepago permanece como crédito para recuperar.':actionGuidance[action]}</p>}
      {action==='account-save'&&<>
        <div className="product-form-grid">{input('name','Nombre de cuenta',{required:true})}
          {context.account?.id?<p className="hint">Tipo: {{cash:'Caja en efectivo',bank:'Banco',wallet:'Billetera'}[form.type]}. La apertura y su saldo inicial no se reescriben.</p>:select('type','Tipo de cuenta',[['cash','Caja en efectivo'],['bank','Banco'],['wallet','Billetera']])}
          {select('responsibleId','Persona responsable',people.filter(p=>p.active||p.id===form.responsibleId).map(p=>[p.id,p.name]))}
          {input('openingOn','Fecha de apertura',{required:true,type:'date',disabled:Boolean(context.account?.id)})}
          {!context.account?.id&&amount('openingBalanceMinor','Saldo inicial confirmado (COP)',form.openingBalanceMinor,value=>set('openingBalanceMinor',value),{signed:true})}
        </div>
        <details><summary>Crear responsable sin acceso al panel</summary><p className="hint">No requiere contraseña ni correo.</p>{input('newPersonName','Nombre del responsable nuevo')}<button type="button" className="button subtle" disabled={busy||!form.newPersonName.trim()} onClick={()=>createResponsible()}>Crear responsable</button></details>
        <details><summary>Mínimo y cierre de efectivo</summary>
          {amount('minimumMinor','Saldo mínimo opcional (COP)',form.minimumMinor,value=>set('minimumMinor',value),{required:false,signed:true})}
          {form.type==='cash'&&<><label className="checkbox-field"><input type="checkbox" checked={form.closingEnabled} onChange={e=>set('closingEnabled',e.target.checked)}/>Exigir cierre diario de esta caja</label>
            {form.closingEnabled&&<div className="product-form-grid">{input('closingTime','Hora de cierre en Bogotá',{required:true,type:'time',nullable:true})}{amount('toleranceMinor','Tolerancia de diferencia (COP)')}</div>}
          </>}
        </details>
        {context.account?.id&&<label className="checkbox-field"><input type="checkbox" checked={form.active} onChange={e=>set('active',e.target.checked)}/>Cuenta activa para nuevos movimientos</label>}
      </>}
      {(action==='collection'||action==='refund')&&<>
        <p className="hint">{action==='collection'?'Saldo del cliente: '+display(order?.paymentSummary?.outstandingMinor):'Saldo a favor: '+display(order?.paymentSummary?.refundDueMinor)}. El recaudo en plataforma no entra en la cuenta bancaria hasta confirmar una liquidación.</p>
        <div className="product-form-grid">{amount('amountMinor','Importe (COP)')}{input('occurredOn','Fecha real',{required:true,type:'date'})}{select('holder',action==='refund'?'Origen del reembolso':'Quién recibió el dinero',[['business','El negocio'],['platform','La plataforma']])}
          {form.holder==='business'?accountSelect():select('shipmentId','Envío de plataforma',(order?.shipments||[]).filter(s=>s.sourceId).map(s=>[s.id,s.tracking||s.id]))}
          {input('method','Método',{required:true})}{input('reference','Referencia',{required:true})}
        </div>
        {action==='refund'?reason():<details><summary>Saldo a favor explícito</summary><label className="checkbox-field"><input type="checkbox" checked={form.allowCredit} onChange={e=>set('allowCredit',e.target.checked)}/>Permitir cobro superior al saldo, dejando saldo a favor visible</label></details>}
      </>}
      {action==='return'&&<>
        {input('occurredOn','Fecha de devolución',{required:true,type:'date'})}{reason()}
        {(order?.items||[]).map(line=>{const item=form.lines.find(l=>l.lineId===line.lineId);return <section className="form-section" key={line.lineId}><h4>{line.title}</h4><p>Comprado: {line.quantity}. El servidor calcula el crédito acumulado y evita devolver dos veces las unidades.</p><div className="product-form-grid"><label className="field">Cantidad a devolver<input type="number" min={0} max={line.quantity} step={1} value={item.quantity} onChange={e=>set('lines',form.lines.map(l=>l.lineId===line.lineId?{...l,quantity:Number(e.target.value)}:l))}/></label><label className="field">Condición<select value={item.condition} onChange={e=>set('lines',form.lines.map(l=>l.lineId===line.lineId?{...l,condition:e.target.value}:l))}><option value="recoverable">Mercancía recuperable</option><option value="non_recoverable">No recuperable</option></select></label></div></section>;})}
        {amount('shippingCreditMinor','Flete cobrado que se acredita (COP)')}<p className="hint">La devolución comercial no mueve caja. Registra el reembolso por separado cuando ocurra.</p>
      </>}
      {action==='complete-costs'&&<>
        {reason()}<p className="hint">Corrige snapshots históricos, recuperaciones y pérdidas vinculadas. No cambia el precio, las ventas ni la caja.</p>
        {form.lineCosts.map((line,index)=><section className="form-section" key={line.lineId}><label className="checkbox-field"><input type="checkbox" checked={line.selected} onChange={e=>set('lineCosts',form.lineCosts.map((l,i)=>i===index?{...l,selected:e.target.checked}:l))}/>{order.items.find(l=>l.lineId===line.lineId)?.title}</label>{line.selected&&(line.components.length?line.components.map((component,j)=>amount('component-'+index+'-'+j,order.items[index].components[j].title,component.unitCostMinor,value=>set('lineCosts',form.lineCosts.map((l,i)=>i===index?{...l,components:l.components.map((c,k)=>k===j?{...c,unitCostMinor:value}:c)}:l)))):amount('cost-'+index,'Costo unitario histórico (COP)',line.unitCostMinor,value=>set('lineCosts',form.lineCosts.map((l,i)=>i===index?{...l,unitCostMinor:value}:l))))}</section>)}
      </>}
      {action==='resolve-legacy-payment'&&<>
        <p className="hint">Conserva la historia sin inventar un depósito por el antiguo estado Pagado. Elige una sola alternativa.</p>
        {select('mode','Conciliación',[['opening_balance','Ya incluido en saldo inicial'],['cash_movement','Registrar movimiento real ahora']])}
        {form.mode==='cash_movement'&&<>{input('occurredOn','Fecha real del movimiento',{type:'date',required:true})}{accountSelect()}{input('method','Método',{required:true})}{input('reference','Referencia',{required:true})}</>}{reason()}
        {order?.legacyFinancialReview?.reason==='ambiguous_refund'&&<div className="product-form-grid">{amount('receiptAmountMinor','Cobro histórico comprobado (COP)')}{amount('refundAmountMinor','Reembolso histórico comprobado (COP)')}{input('receiptOn','Fecha del cobro histórico',{required:true,type:'date'})}{input('refundOn','Fecha del reembolso histórico',{required:true,type:'date'})}</div>}
      </>}
      {['expense','pay-expense','expense-recovery','income','advance','transfer'].includes(action)&&<>
        {action==='expense'&&<fieldset className={styles.fieldGroup}><legend>Datos del gasto</legend><div className="product-form-grid">{select('category','Categoría',[['other','Otro gasto'],['shipping_out','Flete de ida'],['shipping_return','Flete de retorno'],['platform_fee','Cargo de plataforma']])}{input('concept','Concepto',{required:true})}{input('supplier','Proveedor (opcional)')}{<>{input('incurredOn','Fecha del gasto',{type:'date',nullable:true})}{Boolean(order?.shipments?.length)&&select('shipmentId','Envío vinculado',order.shipments.map(s=>[s.id,s.tracking||'Entrega local']),{required:false})}</>}</div></fieldset>}
        {action==='expense'&&context.expense?.id&&<>{reason()}<p>La corrección conserva pagos anteriores; un sobrepago queda como crédito para recuperar, no como ingreso ficticio.</p></>}
        {action==='expense'&&!context.expense?.id&&<details><summary>Responsable opcional del gasto</summary>{personSelect(false)}</details>}
        {action==='income'&&<>{select('concept','Concepto',[['owner_funding','Aporte del propietario'],['other_non_sale','Otro ingreso no ligado a venta']])}{input('description','Descripción',{required:true})}<p className="hint">Este ingreso aumenta caja, nunca ventas.</p></>}
        {action==='advance'&&<>{personSelect()}{input('concept','Concepto del anticipo',{required:true})}<p className="hint">El anticipo reduce deuda de sueldo al aplicarse; no vuelve a generar gasto.</p></>}
        <fieldset className={styles.fieldGroup}><legend>{action==='expense'?'Importe y pago opcional':'Movimiento de dinero'}</legend>{action==='expense'&&<p className={styles.queryHelp}>{context.expense?.id?'La corrección mantiene el historial de pagos y sus créditos.':'Sin cuenta de pago no se mueve caja. La fecha del gasto y la fecha del pago representan hechos distintos.'}</p>}<div className="product-form-grid">{amount('amountMinor','Importe (COP)')}{input('effectiveOn',action==='expense'?'Fecha del pago, si pagas ahora':'Fecha del movimiento',{required:action!=='expense'||Boolean(form.accountId),type:'date'})}{action==='transfer'?<>{accountSelect('fromAccountId','Desde')}{accountSelect('toAccountId','Hacia')}{input('concept','Concepto',{required:true})}</>:accountSelect('accountId',action==='expense'?'Pagar ahora desde (opcional)':'Cuenta',action!=='expense')}{input('reference','Referencia')}</div></fieldset>
        {action==='expense-recovery'&&<><p>Crédito disponible del proveedor: {display(context.expense?.creditMinor)}. Recuperarlo no reduce el gasto por segunda vez.</p>{reason()}</>}
        {action==='pay-expense'&&<p>Saldo del gasto: {display(context.expense?.outstandingMinor)}.</p>}
      </>}
      {action==='cash-close'&&<><p>Saldo esperado: {display(context.account?.balanceMinor)}. El cierre guarda la diferencia; no ajusta el saldo.</p>{accountSelect()}{input('closingOn','Fecha de cierre',{required:true,type:'date'})}{amount('countedMinor','Dinero contado (COP)')}</>}
      {action==='cash-reopen'&&<><p>Reabrir conserva el cierre original. El siguiente cierre tendrá una revisión nueva.</p>{reason()}</>}
      {['cash-reverse','document-reverse'].includes(action)&&<><p className="hint">La reversión añade el movimiento contrario y conserva el original. Las dependencias activas deben deshacerse primero; no se borra una venta.</p>{input('effectiveOn','Fecha de reversión',{required:true,type:'date'})}{reason()}</>}
      {action==='settlement-confirm'&&<>
        <p>Declarado neto: {display(context.settlement?.netMinor)}. Confirma solo el dinero efectivamente recibido o retenido, no el estado de entrega.</p>
        <div className="product-form-grid">{input('receivedOn','Fecha de recepción',{required:true,type:'date'})}{accountSelect('accountId','Cuenta de recepción',net!==0)}{input('externalKey','Referencia única del recibo')}</div>
        {form.lines.map((line,index)=><section className="form-section" key={line.collectionId}><h4>{line.label||`Cobro vinculado ${index+1}`}</h4>{amount('gross-'+index,'Bruto asignado (COP)',line.grossMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,grossMinor:value}:l)))}{line.deductions.map((deduction,j)=>amount('deduction-'+index+'-'+j,`${deduction.label||'Retención / recuperación '+(j+1)} (COP)`,deduction.amountMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,deductions:l.deductions.map((d,k)=>k===j?{...d,amountMinor:value}:d)}:l)),{signed:true}))}</section>)}
        <p><strong>Neto de este recibo: {display(net)}</strong></p><p className="hint">Bruto menos retenciones = neto. Neto cero no genera movimiento; neto negativo registra salida real. Retenciones pagan los gastos existentes, no crean otro gasto.</p>
      </>}
      {action==='settlement-save'&&<>
        {select('sourceId','Cuenta de plataforma',sources.filter(s=>s.active||s.id===form.sourceId).map(s=>[s.id,[s.platformName,s.name].filter(Boolean).join(' · ')]))}{input('reportedOn','Fecha declarada',{type:'date',nullable:true})}{input('externalKey','Referencia de liquidación',{required:true})}
        <p>Vincula cobros y gastos existentes. Una diferencia sin soporte queda pendiente, no se inventa un gasto para cuadrarla.</p>
        {form.lines.length>0&&<p className="hint">Conserva la cuenta de plataforma de los cobros elegidos. Si cambias de cuenta, quita primero sus líneas.</p>}
        {form.lines.map((line,index)=><section className="form-section" key={line.collectionId}>
          <h4>{line.label||`Cobro vinculado ${index+1}`}</h4>
          {amount('declared-gross-'+index,'Bruto declarado (COP)',line.grossMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,grossMinor:value}:l)))}
          {line.deductions.map((d,j)=><div key={d.expenseId}><p>{d.label||`Gasto vinculado ${j+1}`}</p>{amount('declared-deduction-'+index+'-'+j,'Retención positiva / recuperación negativa (COP)',d.amountMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,deductions:l.deductions.map((x,k)=>k===j?{...x,amountMinor:value}:x)}:l)),{signed:true})}<button type="button" className="text-button" onClick={()=>set('lines',form.lines.map((l,i)=>i===index?{...l,deductions:l.deductions.filter((_,k)=>k!==j)}:l))}>Quitar gasto</button></div>)}
          <FinanceCandidatePicker api={api} type="expenses" source={form.sourceId} collection={line.collectionId} excluded={line.deductions.map(d=>d.expenseId)} onSelect={row=>set('lines',form.lines.map((l,i)=>i===index?{...l,deductions:[...l.deductions,{expenseId:row.id,amountMinor:row.availableMinor,label:candidateLabel(row)}]}:l))}/>
          <button type="button" className="text-button" onClick={()=>set('lines',form.lines.filter((_,i)=>i!==index))}>Quitar cobro y sus gastos</button>
        </section>)}
        <FinanceCandidatePicker api={api} type="collections" source={form.sourceId} excluded={form.lines.map(l=>l.collectionId)} onSelect={row=>set('lines',[...form.lines,{collectionId:row.id,grossMinor:row.availableGrossMinor,deductions:[],label:candidateLabel(row)}])}/>
        {context.settlement?.id&&reason()}
        {amount('netMinor','Neto declarado (COP)',form.netMinor,value=>set('netMinor',value),{signed:true})}
        <p>Neto de líneas vinculadas: {display(net)}</p>
      </>}
      {['payroll-prepare','payroll-confirm'].includes(action)&&<>
        <div className="product-form-grid">{personSelect()}{input('startOn','Inicio del período',{required:true,type:'date'})}{input('endOnExclusive','Fin exclusivo del período',{required:true,type:'date'})}{amount('bonusMinor','Bonificación (COP)')}{amount('discountMinor','Descuento interno (COP)')}</div>{form.discountMinor>0&&reason()}
        <p className="hint">Control interno, no liquidación laboral legal ni nómina electrónica. Los anticipos no duplican costo; créditos de comisión se compensan antes de pagar.</p>
        {preview&&<section className="form-section" aria-live="polite"><h4>Revisión del período · {preview.state}</h4><dl className="summary-values">{[['Devengado','earnedMinor'],['Obligaciones pendientes','outstandingMinor'],['Créditos del período','creditMinor'],['Créditos disponibles anteriores','availableCreditMinor'],['Anticipos disponibles','advanceAvailableMinor'],['Anticipos a aplicar','advanceToApplyMinor'],['Anticipos aplicados','advanceAppliedMinor'],['Pago nuevo propuesto','amountToPayMinor']].filter(([,key])=>preview[key]!=null).map(([title,key])=><div key={key}><dt>{title}</dt><dd>{display(preview[key])}</dd></div>)}</dl><p>Días por materializar: {preview.missingDayCount??0}. Confirmar registra devengos una sola vez; pagar es una acción separada.</p>{(preview.obligations||[]).map(e=><p key={e.id}>{e.category||e.concept} · {display(e.amountMinor)}</p>)}{(preview.carriedCredits||[]).map(e=><p key={e.id}>Crédito {e.category} · {display(e.creditMinor)}</p>)}<button className="button primary" type="button" onClick={confirmPrepared}>Confirmar período revisado</button></section>}
      </>}
      {action==='payroll-pay'&&<><p>Pago nuevo tras créditos y anticipos: {display(context.payroll?.amountToPayMinor)}. Obligaciones pendientes: {display(context.payroll?.outstandingMinor)}; anticipos disponibles: {display(context.payroll?.advanceAvailableMinor)}.</p><div className="product-form-grid">{amount('amountMinor','Pago nuevo (COP)')}{accountSelect()}{input('effectiveOn','Fecha del pago',{required:true,type:'date'})}{input('reference','Referencia')}</div></>}
      {action==='link-shipment'&&<><p>{context.order?.id?`Pedido seleccionado: AN-${context.order.number}`:'Selecciona primero un pedido conocido en la búsqueda.'}</p>{context.order?.id&&<fieldset><legend>Unidades de este envío</legend><p>Asigna solo las unidades de esta guía. El servidor comprueba las cantidades acumuladas entre envíos activos.</p>{context.order.items.map(l=><label className="field" key={l.lineId}>{l.title} · Compradas {l.quantity}<input type="number" min="0" max={l.quantity} step="1" value={form.assignments.find(a=>a.lineId===l.lineId)?.quantity??0} onChange={e=>set('assignments',form.assignments.map(a=>a.lineId===l.lineId?{...a,quantity:Number(e.target.value)}:a))}/></label>)}</fieldset>}{reason()}<p>No se vincula por similitud de nombre o teléfono.</p></>}
    </fieldset>
    <footer className="editor-footer"><span role="status">{busy?'Guardando…':dirty?'Cambios sin guardar':''}</span>{onCancel&&<button type="button" className="button subtle" disabled={busy} onClick={onCancel}>{configuration?'Cancelar edición':'Cancelar'}</button>}<button className="button primary" type="submit" disabled={busy||!loaded||Object.values(invalid).some(Boolean)||(action==='link-shipment'&&!context.order?.id)}>{configuration&&action==='account-save'?(context.account?.id?'Guardar cuenta':'Crear cuenta'):action==='payroll-prepare'?'Revisar período':titles[action]||'Guardar'}</button></footer>
  </form>;
}
function candidateLabel(row){return [row.orderNumber?`AN-${row.orderNumber}`:'Sin pedido',row.tracking||row.concept||row.category,row.date||'Fecha desconocida'].filter(Boolean).join(' · ');}
function FinanceCandidatePicker({api,type,source,collection,excluded,onSelect}){
  const [q,setQ]=useState(''),[page,setPage]=useState(1),[data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0),[expanded,setExpanded]=useState(false),seq=useRef(0);
  useEffect(()=>{const current=++seq.current;setData(null);if(!source||!expanded)return;setLoading(true);setError('');const params=new URLSearchParams({candidates:type,source,page:String(page),q});if(collection)params.set('collection',collection);api('/api/admin/finance/settlements?'+params).then(value=>{if(current===seq.current)setData(value);}).catch(cause=>{if(current===seq.current)setError(cause.message);}).finally(()=>{if(current===seq.current)setLoading(false);});return()=>{seq.current++;};},[api,type,source,collection,q,page,retry,expanded]);
  return <details className="finance-candidates" onToggle={e=>setExpanded(e.currentTarget.open)}><summary>{type==='collections'?'Buscar y añadir cobro':'Buscar y añadir gasto o crédito'}</summary>{!source?<p>Elige una cuenta de plataforma.</p>:<><label className="field">Buscar por pedido, guía o concepto<input value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} maxLength={100}/></label>{loading&&<p role="status">Actualizando candidatos…</p>}{error&&<p role="alert">{error}<button type="button" onClick={()=>setRetry(x=>x+1)}>Reintentar</button></p>}{data&&<><ul>{data.records.map(row=><li key={row.id}><span>{candidateLabel(row)} · Disponible: {display(row.availableGrossMinor??row.availableMinor)}</span><button type="button" className="button subtle" disabled={loading||excluded.includes(row.id)} onClick={()=>onSelect(row)}>{excluded.includes(row.id)?'Vinculado':'Añadir'}</button></li>)}</ul>{!data.records.length&&<p>No hay registros elegibles para esta búsqueda.</p>}<div className="cash-pagination"><button type="button" disabled={loading||page===1} onClick={()=>setPage(p=>p-1)}>Anterior</button><span>Página {page} · {data.total} registros</span><button type="button" disabled={loading||page*20>=data.total} onClick={()=>setPage(p=>p+1)}>Siguiente</button></div></>}</>}</details>;
}
export default function BusinessActionDialog({action,context,api,onClose,onSaved,onInteractionStateChange=()=>{},configuration=false}){
  const ref=useRef(null),[interaction,setInteraction]=useState({busy:false,dirty:false});
  const close=useDialog(ref,{...interaction,onClose});
  const callback=useRef(onInteractionStateChange);callback.current=onInteractionStateChange;
  const report=useRef(state=>{setInteraction(state);callback.current(state);}).current;
  return <dialog ref={ref} className={`editor-drawer ${styles.actionDialog}`} aria-labelledby="business-action-title"><header><h2 id="business-action-title" tabIndex={-1} data-dialog-initial-focus>{configuration&&action==='account-save'?(context.account?.id?'Editar cuenta':'Crear cuenta'):titles[action]}</h2><button type="button" className="button subtle" onClick={close} disabled={interaction.busy}>{configuration?'Cerrar formulario':'Cerrar'}</button></header><div className="drawer-body"><BusinessActionForm action={action} context={context} api={api} onSaved={onSaved} onCancel={close} onInteractionStateChange={report} configuration={configuration}/></div></dialog>;
}
