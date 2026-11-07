'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import useDialog from './useDialog';
import Icon from './Icons';
import { bogotaDate, businessDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor, MAX_MONEY_MINOR } from '@/lib/business/money.mjs';
import styles from './FinanceExperience.module.css';
import OrderLineCosts from './OrderLineCosts';
import {cashStateLabels,expenseCategoryLabels,cashMovementLabels} from './finance-labels.mjs';

const titles={collection:'Registrar cobro',refund:'Registrar reembolso',return:'Registrar devolución','complete-costs':'Completar o corregir costos','resolve-legacy-payment':'Conciliar pago histórico',expense:'Registrar gasto','expense-recovery':'Recuperar sobrepago','pay-expense':'Pagar gasto',income:'Registrar ingreso',advance:'Registrar anticipo',transfer:'Transferir','cash-close':'Cerrar caja','cash-reopen':'Reabrir cierre','cash-reverse':'Revertir movimiento','document-reverse':'Revertir documento','settlement-save':'Registrar liquidación','settlement-confirm':'Confirmar recepción','payroll-prepare':'Preparar sueldo','payroll-confirm':'Confirmar sueldo','payroll-pay':'Pagar sueldo','link-shipment':'Vincular pedido'};
titles['account-save']='Configurar cuenta';
const actionGuidance={
  'account-save':'Identifica la cuenta y su responsable. La apertura requiere un saldo confirmado, incluso cero; no se reescribe al editar.',
  expense:'Registra la obligación. Dejar pendiente no mueve dinero; registrar y pagar ahora añade la salida completa solo si lo eliges.',
  income:'Registra dinero recibido no ligado a una venta. Para cobrar una venta, abre el pedido.',
  transfer:'Mueve dinero entre dos cuentas propias distintas. Registra salida y entrada, sin cambiar el total ni crear una venta o gasto.',
  advance:'Registra una salida real para una persona; se aplicará a su remuneración sin volver a generar gasto.',
  'pay-expense':'Registra únicamente el dinero que salió: puedes pagar el saldo completo o un abono, con su cuenta y fecha reales.',
  'expense-recovery':'Registra el dinero recuperado del proveedor como una entrada. Agota el crédito sin reducir el gasto por segunda vez.',
  'cash-close':'Cuenta el efectivo real y compara el saldo de la cuenta y fecha elegidas. Guardar conserva la diferencia; no ajusta dinero.',
  'cash-reopen':'Reabre con un motivo para corregir fechas alcanzadas. Primero debes reabrir los cierres posteriores; se conservan las revisiones.',
  'cash-reverse':'Añade la contrapartida completa con fecha y motivo; no borra el movimiento original.',
  'document-reverse':'Revierte el documento vinculado completo y sus aplicaciones. No permite borrar un asiento aislado ni una venta.',
  'settlement-save':'Declara y vincula los soportes. Registrar la liquidación no confirma dinero recibido.',
  'settlement-confirm':'Confirma solo el bruto, retenciones y neto de este recibo. Puedes registrar una recepción parcial; un neto cero no mueve dinero y uno negativo registra salida.',
  'payroll-prepare':'Selecciona persona y período, revisa los devengos y después confirma. El pago es una acción separada.',
  'payroll-confirm':'Revisa las obligaciones antes de confirmar. Esta acción devenga; no registra un pago.',
  'payroll-pay':'Revisa créditos y anticipos ya considerados. Registra solo el pago nuevo que sale de la cuenta, sin descontar dos veces el anticipo.'
};
const actionExamples={
  expense:'Gasto de 20.000 COP, abono de 5.000 COP y pendiente de 15.000 COP: guarda pendiente y luego usa Pagar saldo o abono.',
  income:'Un aporte del propietario de 50.000 COP aumenta la cuenta elegida, no las ventas.',
  transfer:'Trasladar 30.000 COP de Caja a Banco registra −30.000 y +30.000 COP; el total no cambia.',
  'pay-expense':'Un gasto pendiente de 20.000 COP con un abono de 5.000 COP deja 15.000 COP pendientes.',
  'expense-recovery':'Si pagaste 5.000 COP por un gasto corregido a 3.000 COP, recuperar los 2.000 COP de crédito registra una entrada real.',
  'cash-close':'Esperado 95.000 COP y contado 94.000 COP: faltante de 1.000 COP, sin ajuste automático.',
  'cash-reopen':'Reabre el cierre del viernes antes del jueves si ambos bloquean una corrección del jueves.',
  'cash-reverse':'Revertir un traslado recupera ambas caras; la entrada y salida originales siguen en la historia.',
  'document-reverse':'Un recibo de plataforma y sus retenciones se revierten como un documento, no como un depósito aislado.',
  'settlement-save':'122.000 COP brutos − 17.000 COP retenidos = 105.000 COP netos declarados, todavía sin recepción.',
  'settlement-confirm':'Confirmar 105.000 COP recibidos de los 105.000 COP declarados registra la recepción real.',
  'payroll-prepare':'100.000 COP ganados − 20.000 COP de anticipo = 80.000 COP de pago nuevo. El corte del 1 de octubre no incluye ese día.',
  'payroll-confirm':'Confirmar una obligación de 100.000 COP no retira dinero; pagar es otro paso.',
  'payroll-pay':'Después de aplicar un anticipo de 20.000 COP a 100.000 COP ganados, el pago nuevo es de 80.000 COP.'
};
const display=value=>value==null?'Sin dato':Number.isSafeInteger(value)&&Math.abs(value)<=MAX_MONEY_MINOR?formatMoneyMinor(value):'Revisa el importe';
const active=rows=>{const reversed=new Set(rows.filter(r=>r.reversalOf).map(r=>r.reversalOf));return rows.filter(r=>!r.reversalOf&&!reversed.has(r.id));};
const validMoney=value=>Number.isSafeInteger(value)&&Math.abs(value)<=MAX_MONEY_MINOR;
const validDate=value=>{try{return businessDate(value);}catch{return null;}};
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
  const contextualAccount=account?.active&&(action!=='cash-close'||account.type==='cash')?account.id:null;
  return {orderId:expense?.id?expense.orderId:order?.id,version:action==='document-reverse'?(context.documentVersion??1):action==='link-shipment'?(shipment?.version??1):expense?.version||order?.version||settlement?.version||payroll?.version||closing?.version||account?.version||1,
    occurredOn:today,effectiveOn:today,receivedOn:today,incurredOn:expense?.id?expense.incurredOn:context.expenseOnly?null:today,closingOn:today,
    amountMinor:action==='expense'?expense?.amountMinor??null:action==='collection'?order?.paymentSummary?.outstandingMinor??null:action==='refund'?order?.paymentSummary?.refundDueMinor??null:action==='pay-expense'?expense?.outstandingMinor??null:action==='expense-recovery'?expense?.creditMinor??null:action==='payroll-pay'?payroll?.amountToPayMinor??null:null,
    accountId:action==='expense'?null:contextualAccount,expensePaymentMode:'pending',holder:'business',shipmentId:shipment?.id||expense?.shipmentId||null,method:'Transferencia',reference:'',reason:'',concept:action==='income'?'owner_funding':expense?.concept||'',description:'',supplier:expense?.supplier||'',category:expense?.category||'other',allowCredit:false,
    expenseId:expense?.id,sourceKey:expense?.sourceKey,reviewConfirmed:false,settlementId:settlement?.id,payrollId:payroll?.id,personId:payroll?.personId||expense?.personId||null,startOn:payroll?.startOn||today.slice(0,8)+'01',endOnExclusive:payroll?.endOnExclusive||'',
    closingId:closing?.id,cashEntryId:entry?.id,documentId:context.documentId||entry?.sourceId||'',documentType:context.documentType||'collection',
    fromAccountId:account?.active?account.id:null,toAccountId:null,countedMinor:null,shippingCreditMinor:0,mode:'opening_balance',
    inventoryOpeningIncluded:'',
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
  const fieldId=useId(),expenseAccountSuggestion=useRef(null);
  const [selectionNotice,setSelectionNotice]=useState('');
  const [closingPreview,setClosingPreview]=useState({key:'',status:'idle',value:null,error:''}),[closingRetry,setClosingRetry]=useState(0);
  const closingSequence=useRef(0),closingErrorRef=useRef(null);
  const closingKey=JSON.stringify([form.accountId,form.closingOn]);
  const closingCurrent=closingPreview.key===closingKey&&closingPreview.status==='ready'?closingPreview.value:null;
  const countedValid=validMoney(form.countedMinor)&&form.countedMinor>=0&&!invalid.countedMinor;
  const differenceCandidate=closingCurrent&&countedValid?form.countedMinor-closingCurrent.expectedMinor:null;
  const closingDifference=validMoney(differenceCandidate)?differenceCandidate:null;
  const closingReady=!!closingCurrent&&countedValid&&closingDifference!==null;
  const expenseEdit=action==='expense'&&!!context.expense?.id;
  const expenseOnly=action==='expense'&&context.expenseOnly===true;
  const expenseReview=action==='expense'&&Boolean(context.expense?.sourceAsOf||context.expense?.importIdentity||expenseOnly&&!context.expense?.id&&context.shipment?.costObservations?.shipping_out?.sourceAsOf);
  const dirty=JSON.stringify(form)!==baseline.current||Object.values(invalid).some(Boolean);
  useEffect(()=>{onInteractionStateChange({busy,dirty});},[busy,dirty,onInteractionStateChange]);
  useEffect(()=>()=>onInteractionStateChange({busy:false,dirty:false}),[onInteractionStateChange]);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  async function load(){
    const seq=++sequence.current;setError('');
    try {
      const needsAccounts=!expenseOnly&&!['return','complete-costs','link-shipment','account-save'].includes(action),needsPeople=!expenseOnly&&['expense','advance','payroll-prepare','payroll-confirm','account-save'].includes(action),needsSources=action==='settlement-save';
      const [accountData,settings,personData,sourceData,platformData]=await Promise.all([needsAccounts?api('/api/admin/business/accounts'):null,needsAccounts?api('/api/admin/business/settings'):null,needsPeople?api('/api/admin/business/people'):null,needsSources?api('/api/admin/business/sources'):null,needsSources?api('/api/admin/business/platforms'):null]);
      if(seq!==sequence.current)return;
      setAccounts(accountData?.records||[]);setPeople(personData?.records||[]);setSources((sourceData?.records||[]).map(source=>({...source,platformName:platformData?.records?.find(platform=>platform.id===source.platformId)?.name||'Plataforma no disponible'})));
      const rows=accountData?.records||[],defaultId=['collection','income','settlement-confirm','expense-recovery'].includes(action)?settings?.defaultReceiptAccountId:settings?.defaultPaymentAccountId;
      const eligible=a=>a.active&&(action!=='cash-close'||a.type==='cash');
      const suggested=rows.find(a=>a.id===context.account?.id&&eligible(a))||rows.find(a=>a.id===defaultId&&eligible(a));
      if(action==='expense')expenseAccountSuggestion.current=suggested?.id||null;
      else if(suggested){
        const key=action==='transfer'?'fromAccountId':'accountId';
        setForm(old=>{if(old[key])return old;baseline.current=JSON.stringify({...JSON.parse(baseline.current),[key]:suggested.id});return {...old,[key]:suggested.id};});
      }
      setLoaded(true);
    }catch(cause){if(seq===sequence.current)setError(cause.message);}
  }
  useEffect(()=>{void load();return()=>{sequence.current++;};},[action,api]);
  useEffect(()=>{
    if(action!=='cash-close')return;
    const current=++closingSequence.current;
    if(!form.accountId||!validDate(form.closingOn)){setClosingPreview({key:closingKey,status:'idle',value:null,error:''});return;}
    setClosingPreview({key:closingKey,status:'loading',value:null,error:''});
    const params=new URLSearchParams({preview:'1',account:form.accountId,closingOn:form.closingOn});
    api('/api/admin/finance/closings?'+params).then(value=>{
      if(current===closingSequence.current)setClosingPreview({key:closingKey,status:'ready',value,error:''});
    }).catch(cause=>{
      if(current===closingSequence.current)setClosingPreview({key:closingKey,status:'error',value:null,error:cause.message});
    });
    return()=>{closingSequence.current++;};
  },[action,api,closingKey,closingRetry]);
  useEffect(()=>{if(closingPreview.key===closingKey&&closingPreview.error)closingErrorRef.current?.focus();},[closingPreview.error,closingPreview.key,closingKey]);
  const set=(key,value)=>{
    if(key==='sourceId'&&form.lines.length){setError('Quita los cobros vinculados antes de cambiar la cuenta de plataforma.');return;}
    if(action==='cash-close'&&['accountId','closingOn'].includes(key)){closingSequence.current++;setClosingPreview({key:'',status:'idle',value:null,error:''});}
    if(key==='fromAccountId'&&value===form.toAccountId)setSelectionNotice('El destino coincidía con el nuevo origen. Elige otra cuenta de destino.');
    else if(key==='fromAccountId'||key==='toAccountId')setSelectionNotice('');
    setForm(old=>({...old,[key]:value,
      ...(key==='expensePaymentMode'&&value==='pay_now'&&!old.accountId?{accountId:expenseAccountSuggestion.current}:{}),
      ...(key==='fromAccountId'&&value===old.toAccountId?{toAccountId:null}:{}),
      ...(key==='type'&&value!=='cash'?{closingEnabled:false,closingTime:null}:{})
    }));setPreview(null);
  };
  const input=(key,title,{required=false,type='text',nullable=false,disabled=false,description=''}={})=>{
    const id=`${fieldId}-${key}`,help=`${id}-help`;
    return <div className="field" key={key}><label htmlFor={id}>{title}{required?' *':''}</label><input id={id} type={type} name={key} value={form[key]??''} required={required} disabled={disabled} aria-describedby={help} maxLength={key==='reason'?2000:300} onInvalid={e=>e.currentTarget.setAttribute('aria-invalid','true')} onInput={e=>{if(e.currentTarget.validity.valid)e.currentTarget.removeAttribute('aria-invalid');}} onChange={e=>set(key,nullable&&!e.target.value?null:e.target.value)}/><small id={help} className="muted field-description">{required?'Obligatorio.':'Opcional.'} {description}</small></div>;
  };
  const amount=(key,title,value=form[key],onChange=value=>set(key,value),{required=true,signed=false}={})=><ActionMoneyField key={key} field={{name:key,label:title,type:'moneyOptionalMinor',required,signed,description:`${required?'Obligatorio.':'Opcional.'} Pesos COP. Punto para miles, coma para centavos; vacío no es cero. No se redondean importes.`}} value={value} onChange={onChange} onDraftInvalid={value=>setInvalid(old=>({...old,[key]:value}))}/>;
  const select=(key,title,options,{required=true,disabled=false,description=''}={})=>{
    const id=`${fieldId}-${key}`,help=`${id}-help`;
    return <div className="field" key={key}><label htmlFor={id}>{title}{required?' *':''}</label><select id={id} name={key} value={form[key]??''} required={required} disabled={disabled} aria-describedby={help} onInvalid={e=>e.currentTarget.setAttribute('aria-invalid','true')} onChange={e=>{e.currentTarget.removeAttribute('aria-invalid');set(key,e.target.value||null);}}><option value="">Selecciona una opción</option>{options.map(([id,name])=><option value={id} key={id}>{name}</option>)}</select><small id={help} className="muted field-description">{required?'Obligatorio.':'Opcional.'} {description}</small></div>;
  };
  const accountSelect=(key='accountId',title='Cuenta',required=true)=>{
    const options=accounts.filter(a=>a.active&&(action!=='cash-close'||a.type==='cash')&&(key!=='toAccountId'||a.id!==form.fromAccountId));
    return <div>{select(key,title,options.map(a=>[a.id,a.name]),{required,description:key==='fromAccountId'?'Cuenta de donde salió el dinero.':key==='toAccountId'?'Cuenta propia distinta que recibió el dinero.':'Selecciona el lugar real donde entró o salió el dinero.'})}{!options.length&&<p className={styles.queryHelp}>{key==='toAccountId'&&accounts.some(a=>a.active)?'No hay otra cuenta activa distinta del origen.':'No hay cuentas activas elegibles.'} Cancela este formulario y crea o reactiva una cuenta en Configuración → Cuentas; después vuelve a registrar el hecho.</p>}</div>;
  };
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
      expense:'expenseId version category amountMinor incurredOn concept supplier personId orderId shipmentId sourceKey accountId effectiveOn reference reason reviewConfirmed',
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
    if(action==='return'&&context.order?.inventoryOpening&&(!form.occurredOn||form.occurredOn===context.order.inventoryOpening.on)&&form.inventoryOpeningIncluded!=='')out.inventoryOpeningIncluded=form.inventoryOpeningIncluded==='true';
    if(action==='link-shipment')out.assignments=form.assignments.filter(l=>l.quantity>0);
    if(action==='complete-costs')out.lineCosts=form.lineCosts.filter(l=>l.selected).map(({selected,...line})=>line);
    if(action==='settlement-confirm')out.lines=form.lines.filter(l=>l.grossMinor!==0||l.deductions.some(d=>d.amountMinor!==0));
    if(action==='settlement-save'||action==='settlement-confirm')out.lines=out.lines.map(l=>({collectionId:l.collectionId,grossMinor:l.grossMinor,deductions:l.deductions.filter(d=>d.amountMinor!==0).map(d=>({expenseId:d.expenseId,amountMinor:d.amountMinor}))}));
    if(action==='expense'&&(expenseOnly||expenseEdit||form.expensePaymentMode==='pending')){delete out.accountId;delete out.effectiveOn;delete out.reference;}
    if(action==='resolve-legacy-payment'&&out.mode==='opening_balance'){delete out.accountId;delete out.occurredOn;delete out.effectiveOn;}
    if(action==='account-save'&&context.account?.id)delete out.openingBalanceMinor;
    return out;
  }
  async function submit(event){
    event.preventDefault();if(busy||action==='cash-close'&&!closingReady||(action==='link-shipment'&&!context.order?.id))return;setBusy(true);setError('');
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
  const settlementAmountsValid=form.lines.every(l=>validMoney(l.grossMinor)&&(l.deductions||[]).every(d=>validMoney(d.amountMinor)))&&!Object.values(invalid).some(Boolean);
  const net=settlementAmountsValid?form.lines.reduce((sum,l)=>sum+l.grossMinor-(l.deductions||[]).reduce((s,d)=>s+d.amountMinor,0),0):null;
  const payingExpense=action==='expense'&&!expenseOnly&&!expenseEdit&&form.expensePaymentMode==='pay_now';
  const amountValid=validMoney(form.amountMinor)&&!invalid.amountMinor;
  const reviewEffect=action==='expense'?(expenseEdit?'Corrige la obligación sin mover dinero ni repetir pagos; los sobrepagos quedan como crédito.':payingExpense?'Registra la obligación y el pago completo: sale dinero de la cuenta elegida.':'Registra el gasto pendiente; no se mueve dinero.'):{
    income:'Entra dinero sin registrar una venta.',transfer:'Sale de la cuenta de origen y entra en la de destino; el total entre cuentas no cambia.',advance:'Sale dinero como anticipo, sin generar otra vez el gasto.','pay-expense':'Sale el importe indicado y se aplica al saldo del gasto.','expense-recovery':'Entra el dinero recuperado sin reducir otra vez el gasto.','settlement-save':'Guarda una declaración; no recibe ni paga dinero.','settlement-confirm':net===null?'Completa los importes para revisar el efecto del recibo.':net>0?'Registra una entrada por el neto confirmado.':net<0?'Registra una salida por el neto confirmado.':'Neto cero: no registra movimiento de dinero.','payroll-prepare':'Primero prepara la revisión; confirmar registra la obligación, no el pago.','payroll-confirm':'Confirma la obligación; no paga ni retira dinero.','payroll-pay':'Sale únicamente el pago nuevo, tras créditos y anticipos revisados.','cash-reopen':'Reabre con motivo, conserva el cierre original y permite una nueva revisión.','cash-reverse':'Añade la contrapartida completa sin borrar el original.','document-reverse':'Revierte el documento y sus aplicaciones completos; conserva la historia.'
  }[action];
  const reviewAccount=id=>accounts.find(a=>a.id===id)?.name;
  const reviewDate=action==='expense'&&!payingExpense?form.incurredOn:action==='settlement-save'?form.reportedOn:action==='settlement-confirm'?form.receivedOn:form.effectiveOn;
  return <form onSubmit={submit} aria-busy={busy} className={`business-action-form ${styles.actionForm}`}>
    {expenseOnly&&<h3>{context.expense?.id?'Corregir':'Registrar'} flete / costo de envío</h3>}
    {error&&<div ref={errorRef} tabIndex={-1} className="error" role="alert">{error}{!loaded&&<button type="button" className="text-button" onClick={load}>Reintentar</button>}</div>}
    {!loaded&&!error&&<p role="status">Cargando datos de la acción…</p>}
    <fieldset className="editor-fieldset" disabled={busy||!loaded}>
      {actionGuidance[action]&&<p className={styles.formGuide}>{expenseOnly?'Registra solo el costo de la transportadora. No cambia el total del cliente ni mueve caja. Los pagos anteriores se conservan y se gestionan por separado.':action==='expense'&&context.expense?.id?'Corrige el gasto con un motivo. Sus pagos anteriores se conservan; un sobrepago permanece como crédito para recuperar.':actionGuidance[action]}</p>}
      {actionExamples[action]&&<details><summary>Ver ejemplo de esta operación</summary><p><strong>Ejemplo ficticio:</strong> {actionExamples[action]}</p></details>}
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
        {order?.inventoryOpening&&(!form.occurredOn||form.occurredOn===order.inventoryOpening.on)&&<label className="field">Relación con el conteo físico del {order.inventoryOpening.on}<select required value={form.inventoryOpeningIncluded} onChange={e=>set('inventoryOpeningIncluded',e.target.value)}><option value="">Confirma cuándo ocurrió</option><option value="false">Posterior al conteo</option><option value="true">Ya estaba reflejado en el conteo</option></select></label>}
        {(order?.items||[]).map(line=>{const item=form.lines.find(l=>l.lineId===line.lineId);return <section className="form-section" key={line.lineId}><h4>{line.title}</h4><p>Comprado: {line.quantity}. El servidor calcula el crédito acumulado y evita devolver dos veces las unidades.</p><div className="product-form-grid"><label className="field">Cantidad a devolver<input type="number" min={0} max={line.quantity} step={1} value={item.quantity} onChange={e=>set('lines',form.lines.map(l=>l.lineId===line.lineId?{...l,quantity:Number(e.target.value)}:l))}/></label><label className="field">Condición<select value={item.condition} onChange={e=>set('lines',form.lines.map(l=>l.lineId===line.lineId?{...l,condition:e.target.value}:l))}><option value="recoverable">Mercancía recuperable</option><option value="non_recoverable">No recuperable</option></select></label></div></section>;})}
        {amount('shippingCreditMinor','Flete cobrado que se acredita (COP)')}<p className="hint">La devolución comercial no mueve caja. Registra el reembolso por separado cuando ocurra.</p>
      </>}
      {action==='complete-costs'&&<>
        {reason()}<p className="hint">Corrige snapshots históricos, recuperaciones y pérdidas vinculadas. No cambia el precio, las ventas ni la caja.</p>
        <OrderLineCosts items={order.items} value={form.lineCosts} onChange={value=>set('lineCosts',value)} renderAmount={amount}/>
      </>}
      {action==='resolve-legacy-payment'&&<>
        <p className="hint">Conserva la historia sin inventar un depósito por el antiguo estado Pagado. Elige una sola alternativa.</p>
        {select('mode','Conciliación',[['opening_balance','Ya incluido en saldo inicial'],['cash_movement','Registrar movimiento real ahora']])}
        {form.mode==='cash_movement'&&<>{input('occurredOn','Fecha real del movimiento',{type:'date',required:true})}{accountSelect()}{input('method','Método',{required:true})}{input('reference','Referencia',{required:true})}</>}{reason()}
        {order?.legacyFinancialReview?.reason==='ambiguous_refund'&&<div className="product-form-grid">{amount('receiptAmountMinor','Cobro histórico comprobado (COP)')}{amount('refundAmountMinor','Reembolso histórico comprobado (COP)')}{input('receiptOn','Fecha del cobro histórico',{required:true,type:'date'})}{input('refundOn','Fecha del reembolso histórico',{required:true,type:'date'})}</div>}
      </>}
      {['expense','pay-expense','expense-recovery','income','advance','transfer'].includes(action)&&<>
        {expenseEdit&&!order?.shipments?.length&&<p>Envío vinculado: {form.shipmentId?'Se conserva el envío ya asociado; consulta su identificación desde el pedido.':'Sin envío asociado.'} La categoría y el envío no se cambian al corregir.</p>}
        {action==='expense'&&<fieldset className={styles.fieldGroup}><legend>Datos del gasto</legend><div className="product-form-grid">{select('category','Categoría',['advertising','operating','other','shipping_out','shipping_return','shipping_insurance','platform_fee'].map(id=>[id,expenseCategoryLabels[id]]),{disabled:expenseOnly||Boolean(context.expense?.id)})}{input('concept','Concepto',{required:true})}{input('supplier','Proveedor (opcional)')}{input('incurredOn','Fecha del gasto',{type:'date',nullable:true})}{Boolean(order?.shipments?.length)&&select('shipmentId','Envío vinculado',order.shipments.map(s=>[s.id,s.tracking||'Entrega local']),{required:false,disabled:expenseOnly||Boolean(context.expense?.id)})}</div></fieldset>}
        {action==='expense'&&(context.expense?.id||expenseReview)&&<>{reason()}<p>La corrección conserva pagos anteriores; un sobrepago queda como crédito para recuperar, no como ingreso ficticio.</p></>}
        {expenseReview&&<label className="checkbox-field"><input type="checkbox" name="reviewConfirmed" required checked={form.reviewConfirmed} onChange={event=>set('reviewConfirmed',event.target.checked)}/>Confirmo la corrección del costo importado después de revisar su soporte.</label>}
        {action==='expense'&&!context.expense?.id&&!expenseOnly&&<details><summary>Responsable opcional del gasto</summary>{personSelect(false)}</details>}
        {action==='income'&&<>{select('concept','Concepto',['owner_funding','other_non_sale'].map(id=>[id,cashMovementLabels[id]]))}{input('description','Descripción',{required:true})}<p className="hint">Este ingreso aumenta caja, nunca ventas.</p></>}
        {action==='advance'&&<>{personSelect()}{input('concept','Concepto del anticipo',{required:true})}<p className="hint">El anticipo reduce deuda de sueldo al aplicarse; no vuelve a generar gasto.</p></>}
        <fieldset className={styles.fieldGroup}><legend>{expenseOnly?'Costo del envío':action==='expense'?'Importe del gasto':'Movimiento de dinero'}</legend><div className="product-form-grid">
          {amount('amountMinor','Importe (COP)')}
          {action!=='expense'&&<>{input('effectiveOn','Fecha del movimiento',{required:true,type:'date',description:'Usa la fecha en que ocurrió el movimiento, no la fecha de digitación.'})}{action==='transfer'?<>{accountSelect('fromAccountId','Desde')}{accountSelect('toAccountId','Hacia')}{input('concept','Concepto',{required:true,description:'Describe por qué trasladas dinero entre tus cuentas.'})}</>:accountSelect()}{input('reference','Referencia',{description:'Soporte o dato que permite reconocer el movimiento.'})}</>}
        </div>{selectionNotice&&<p role="status">{selectionNotice}</p>}</fieldset>
        {action==='expense'&&!expenseOnly&&!expenseEdit&&<fieldset className={styles.fieldGroup} aria-describedby={`${fieldId}-expense-payment-help`}><legend>¿Ya salió el dinero?</legend>
          <div className={styles.paymentChoices}>
            <label htmlFor={`${fieldId}-pending`}><input id={`${fieldId}-pending`} type="radio" name="expensePaymentMode" value="pending" checked={form.expensePaymentMode==='pending'} onChange={()=>set('expensePaymentMode','pending')}/>Dejar pendiente</label>
            <label htmlFor={`${fieldId}-pay-now`}><input id={`${fieldId}-pay-now`} type="radio" name="expensePaymentMode" value="pay_now" checked={form.expensePaymentMode==='pay_now'} disabled={!accounts.some(a=>a.active)} onChange={()=>set('expensePaymentMode','pay_now')}/>Registrar y pagar ahora</label>
          </div><p id={`${fieldId}-expense-payment-help`} className={styles.queryHelp}>Dejar pendiente no mueve dinero. Pagar ahora registra el pago completo; para un abono, guarda pendiente y después usa «Pagar saldo o abono». La fecha del gasto y la del pago son hechos distintos.</p>
          {!accounts.some(a=>a.active)&&<p>No hay cuenta activa para pagar. Puedes guardar pendiente, o cancelar y crear/reactivar una cuenta en Configuración → Cuentas.</p>}
          {payingExpense&&<div className="product-form-grid">{accountSelect('accountId','Cuenta de pago')}{input('effectiveOn','Fecha del pago',{required:true,type:'date',description:'Fecha real en que salió el dinero.'})}{input('reference','Referencia',{description:'Soporte del pago completo; opcional.'})}</div>}
        </fieldset>}
        {expenseEdit&&<section className="form-section"><h3>Historial de pagos</h3>{(context.expense.payments||context.expense.activePayments||[]).map(payment=><p key={payment.id}>{payment.effectiveOn||'Fecha del documento'} · {display(payment.amountMinor)} · {cashMovementLabels[payment.kind]||'Movimiento registrado'}{payment.reversalOf?' · Reversión':''}</p>)}{!(context.expense.payments||context.expense.activePayments||[]).length&&<p>Este gasto no tiene pagos registrados.</p>}</section>}
        {action==='expense-recovery'&&<><p>Crédito disponible del proveedor: {display(context.expense?.creditMinor)}. Recuperarlo no reduce el gasto por segunda vez.</p>{reason()}</>}
        {action==='pay-expense'&&<p>Saldo del gasto: {display(context.expense?.outstandingMinor)}.</p>}
      </>}
      {action==='cash-close'&&<>
        <section className={styles.closingStep}><h3>1. Cuenta y fecha</h3><div className="product-form-grid">{accountSelect()}{input('closingOn','Fecha de cierre',{required:true,type:'date',description:'El esperado se consulta para esta cuenta al terminar la fecha elegida, en Bogotá.'})}</div></section>
        <section className={styles.closingStep}><h3>2. Dinero contado</h3>{amount('countedMinor','Dinero contado (COP)')}<p className={styles.queryHelp}>Cuenta el efectivo real. Si no hay efectivo, escribe 0; dejar vacío no equivale a cero.</p></section>
        <section className={`${styles.closingStep} ${styles.closingComparison}`} aria-busy={!!form.accountId&&!!validDate(form.closingOn)&&closingPreview.status!=='error'&&!closingCurrent}>
          <h3>3. Comparación</h3>
          {!form.accountId||!validDate(form.closingOn)?<p>Selecciona cuenta y fecha para consultar el saldo esperado.</p>:closingPreview.key===closingKey&&closingPreview.status==='error'?<div role="alert" tabIndex={-1} ref={closingErrorRef} className="error"><p>{closingPreview.error}</p><button type="button" className="button subtle" onClick={()=>{closingSequence.current++;setClosingPreview({key:closingKey,status:'loading',value:null,error:''});setClosingRetry(value=>value+1);}}>Reintentar consulta</button><p>Conserva tu conteo: puedes corregir cuenta o fecha sin registrar ningún cierre.</p></div>:!closingCurrent?<p role="status">Consultando saldo esperado para esta cuenta y fecha…</p>:<>
            <dl className={styles.closingAmounts}><div><dt>Esperado al {closingCurrent.closingOn}</dt><dd>{display(closingCurrent.expectedMinor)}</dd></div><div><dt>Contado</dt><dd>{countedValid?display(form.countedMinor):'Escribe el conteo real'}</dd></div></dl>
            <p role="status" className={styles.closingDifference}>{closingDifference===null?(countedValid?'La diferencia excede el límite monetario; revisa los importes.':'La diferencia se calcula al escribir un conteo válido.'):closingDifference<0?'Faltante de '+display(-closingDifference):closingDifference>0?'Sobrante de '+display(closingDifference):'Sin diferencia'}</p>
          </>}
          <h4>Al guardar</h4><p>El saldo se vuelve a comprobar al guardar. Cerrar conserva la diferencia, no ajusta el dinero. Las fechas alcanzadas quedan bloqueadas hasta reabrir con motivo.</p>
        </section>
      </>}
      {action==='cash-reopen'&&<><p>Reabrir conserva el cierre original. El siguiente cierre tendrá una revisión nueva.</p>{reason()}</>}
      {['cash-reverse','document-reverse'].includes(action)&&<><p className="hint">La reversión añade el movimiento contrario y conserva el original. Las dependencias activas deben deshacerse primero; no se borra una venta.</p>{input('effectiveOn','Fecha de reversión',{required:true,type:'date'})}{reason()}</>}
      {action==='settlement-confirm'&&<>
        <p>Declarado neto: {display(context.settlement?.netMinor)}. Confirma solo el dinero efectivamente recibido o retenido, no el estado de entrega.</p>
        <div className="product-form-grid">{input('receivedOn','Fecha de recepción',{required:true,type:'date'})}{accountSelect('accountId','Cuenta de recepción',net!==0)}{input('externalKey','Referencia única del recibo')}</div>
        {form.lines.map((line,index)=><section className="form-section" key={line.collectionId}><h4>{line.label||`Cobro vinculado ${index+1}`}</h4>{amount('gross-'+index,'Bruto asignado (COP)',line.grossMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,grossMinor:value}:l)))}{line.deductions.map((deduction,j)=>amount('deduction-'+index+'-'+j,`${deduction.label||'Retención / recuperación '+(j+1)} (COP)`,deduction.amountMinor,value=>set('lines',form.lines.map((l,i)=>i===index?{...l,deductions:l.deductions.map((d,k)=>k===j?{...d,amountMinor:value}:d)}:l)),{signed:true}))}</section>)}
        <p><strong>Neto de este recibo: {display(net)}</strong></p><p className="hint">Bruto menos retenciones = neto. Neto cero no genera movimiento; neto negativo registra salida real. Retenciones pagan los gastos existentes, no crean otro gasto.</p>
      </>}
      {action==='settlement-save'&&<>
        {!sources.some(s=>s.active)&&<p>No hay una cuenta de plataforma activa. Cancela y ve a Configuración → Plataformas para crearla o reactivarla antes de declarar.</p>}
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
        <div className="product-form-grid">{personSelect()}{input('startOn','Inicio del período',{required:true,type:'date'})}{input('endOnExclusive','Fecha de corte (este día no se incluye)',{required:true,type:'date'})}{amount('bonusMinor','Bonificación (COP)')}{amount('discountMinor','Descuento interno (COP)')}</div>{form.discountMinor>0&&reason()}
        <p className="hint">Para incluir septiembre completo, usa el 1 de septiembre como inicio y el 1 de octubre como fecha de corte.</p>
        <p className="hint">Control interno, no liquidación laboral legal ni nómina electrónica. Los anticipos no duplican costo; créditos de comisión se compensan antes de pagar.</p>
        {preview&&<section className="form-section" aria-live="polite"><h4>Revisión del período · {cashStateLabels[preview.state]||'Estado no disponible'}</h4><dl className="summary-values">{[['Devengado','earnedMinor'],['Obligaciones pendientes','outstandingMinor'],['Créditos del período','creditMinor'],['Créditos disponibles anteriores','availableCreditMinor'],['Anticipos disponibles','advanceAvailableMinor'],['Anticipos a aplicar','advanceToApplyMinor'],['Anticipos aplicados','advanceAppliedMinor'],['Pago nuevo propuesto','amountToPayMinor']].filter(([,key])=>preview[key]!=null).map(([title,key])=><div key={key}><dt>{title}</dt><dd>{display(preview[key])}</dd></div>)}</dl><p>Días por materializar: {preview.missingDayCount??0}. Confirmar registra devengos una sola vez; pagar es una acción separada.</p>{(preview.obligations||[]).map(e=><p key={e.id}>{expenseCategoryLabels[e.category]||e.concept||'Gasto registrado'} · {display(e.amountMinor)}</p>)}{(preview.carriedCredits||[]).map(e=><p key={e.id}>Crédito {expenseCategoryLabels[e.category]||'Gasto registrado'} · {display(e.creditMinor)}</p>)}<button className="button primary" type="button" onClick={confirmPrepared}>Confirmar período revisado</button></section>}
      </>}
      {action==='payroll-pay'&&<><p>Pago nuevo tras créditos y anticipos: {display(context.payroll?.amountToPayMinor)}. Obligaciones pendientes: {display(context.payroll?.outstandingMinor)}; anticipos disponibles: {display(context.payroll?.advanceAvailableMinor)}.</p><div className="product-form-grid">{amount('amountMinor','Pago nuevo (COP)')}{accountSelect()}{input('effectiveOn','Fecha del pago',{required:true,type:'date'})}{input('reference','Referencia')}</div></>}
      {action==='link-shipment'&&<><p>{context.order?.id?`Pedido seleccionado: AN-${context.order.number}`:'Selecciona primero un pedido conocido en la búsqueda.'}</p>{context.order?.id&&<fieldset><legend>Unidades de este envío</legend><p>Asigna solo las unidades de esta guía. El servidor comprueba las cantidades acumuladas entre envíos activos.</p>{context.order.items.map(l=><label className="field" key={l.lineId}>{l.title} · Compradas {l.quantity}<input type="number" min="0" max={l.quantity} step="1" value={form.assignments.find(a=>a.lineId===l.lineId)?.quantity??0} onChange={e=>set('assignments',form.assignments.map(a=>a.lineId===l.lineId?{...a,quantity:Number(e.target.value)}:a))}/></label>)}</fieldset>}{reason()}<p>No se vincula por similitud de nombre o teléfono.</p></>}
      {reviewEffect&&<section className={styles.saveReview} aria-label="Al guardar"><h3>Al guardar</h3>
        <dl>
          {action==='transfer'?<>{reviewAccount(form.fromAccountId)&&<div><dt>Desde</dt><dd>{reviewAccount(form.fromAccountId)}</dd></div>}{reviewAccount(form.toAccountId)&&<div><dt>Hacia</dt><dd>{reviewAccount(form.toAccountId)}</dd></div>}</>:((action!=='expense'||payingExpense)&&reviewAccount(form.accountId))&&<div><dt>Cuenta</dt><dd>{reviewAccount(form.accountId)}</dd></div>}
          {validDate(reviewDate)&&<div><dt>{action==='expense'&&!payingExpense?'Fecha del gasto':'Fecha'}</dt><dd>{reviewDate}</dd></div>}
          {amountValid&&<div><dt>Importe</dt><dd>{display(form.amountMinor)}</dd></div>}
          {['settlement-save','settlement-confirm'].includes(action)&&settlementAmountsValid&&validMoney(net)&&<div><dt>Neto de las líneas revisadas</dt><dd>{display(net)}</dd></div>}
          {action==='settlement-save'&&validMoney(form.netMinor)&&!invalid.netMinor&&<div><dt>Neto declarado</dt><dd>{display(form.netMinor)}</dd></div>}
          {['payroll-prepare','payroll-confirm'].includes(action)&&<><div><dt>Persona</dt><dd>{people.find(p=>p.id===form.personId)?.name||'Selecciona una persona'}</dd></div>{validDate(form.startOn)&&validDate(form.endOnExclusive)&&<div><dt>Período</dt><dd>{form.startOn} hasta {form.endOnExclusive} (corte no incluido)</dd></div>}{preview?.amountToPayMinor!=null&&<div><dt>Pago nuevo revisado, todavía sin pagar</dt><dd>{display(preview.amountToPayMinor)}</dd></div>}</>}
        </dl><p>{reviewEffect}</p><p className={styles.queryHelp}>Revisa el hecho y sus soportes. No se proyectan saldos futuros con el saldo actual.</p>
      </section>}
    </fieldset>
    <footer className="editor-footer"><span role="status">{busy?'Guardando…':dirty?'Cambios sin guardar':''}</span>{onCancel&&<button type="button" className="button subtle" disabled={busy} onClick={onCancel}>{configuration?'Cancelar edición':'Cancelar'}</button>}<button className="button primary" type="submit" disabled={busy||!loaded||Object.values(invalid).some(Boolean)||action==='cash-close'&&!closingReady||(action==='link-shipment'&&!context.order?.id)}>{expenseOnly?'Guardar costo de envío':action==='expense'?(expenseEdit?'Guardar corrección del gasto':payingExpense?'Registrar gasto y pago':'Guardar gasto pendiente'):configuration&&action==='account-save'?(context.account?.id?'Guardar cuenta':'Crear cuenta'):action==='payroll-prepare'?'Revisar período':titles[action]||'Guardar'}</button></footer>
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
  return <dialog ref={ref} className={`editor-drawer ${styles.actionDialog}`} aria-labelledby="business-action-title"><header><div><p className="eyebrow">Operación del negocio</p><h2 id="business-action-title" tabIndex={-1} data-dialog-initial-focus>{configuration&&action==='account-save'?(context.account?.id?'Editar cuenta':'Crear cuenta'):titles[action]}</h2></div><button type="button" className="icon-button" onClick={close} disabled={interaction.busy} aria-label="Cerrar formulario"><Icon name="close"/></button></header><div className="drawer-body"><BusinessActionForm action={action} context={context} api={api} onSaved={onSaved} onCancel={close} onInteractionStateChange={report} configuration={configuration}/></div></dialog>;
}
