'use client';
import {useEffect,useRef,useState} from 'react';
import ImportedData from './ImportedData';
import BusinessActionDialog from './BusinessActionDialog';
import CashGuide from './CashGuide';
import PeriodPicker from './PeriodPicker';
import WorkspaceTabs from './WorkspaceTabs';
import {bogotaDate,periodBounds} from '@/lib/business/dates.mjs';
import {formatMoneyMinor} from '@/lib/business/money.mjs';
import {cashStateLabels as stateLabel,expenseCategoryLabels as category,cashMovementLabels} from './finance-labels.mjs';
import styles from './FinanceExperience.module.css';
const tabs={overview:'Resumen y cuentas',movements:'Movimientos',settlements:'Liquidaciones',expenses:'Gastos y pagos',payroll:'Sueldos y anticipos'};
const tabItems=Object.entries(tabs).map(([id,label])=>({id,label}));
const operations=[['expense','Registrar gasto'],['income','Registrar ingreso'],['transfer','Transferir'],['cash-close','Cerrar caja']];
const money=value=>value==null?'Sin dato':formatMoneyMinor(value);
const guidance={
  movements:['Movimientos de dinero','Por fecha real; el período no modifica el disponible actual.'],
  settlements:['Liquidaciones de plataforma','Por fecha de declaración; pendiente no es disponible.'],
  expenses:['Gastos y pagos','Por fecha del gasto: devengado no equivale a pagado.'],
  payroll:['Sueldos, comisiones y anticipos','Por período trabajado: confirmar devenga; pagar mueve caja.']
};
function Values({rows}){return <dl className="summary-values">{rows.filter(([,value])=>value!==undefined).map(([title,value])=><div key={title}><dt>{title}</dt><dd>{typeof value==='number'?money(value):value??'Sin dato'}</dd></div>)}</dl>;}
const movementTitle=row=>!cashMovementLabels[row.kind]?'Movimiento registrado':['income','owner_funding','other_non_sale'].includes(row.kind)&&['owner_funding','other_non_sale'].includes(row.concept)?cashMovementLabels[row.concept]:!row.concept||row.concept===row.kind?cashMovementLabels[row.kind]:row.concept;
const movementFlow=row=>row.amountMinor===0&&row.kind==='opening'?'Apertura · '+money(0):row.amountMinor==null?'Importe sin dato':`${row.amountMinor<0?'Salida −':'Entrada +'}${money(Math.abs(row.amountMinor))}`;
const catalogName=row=>row.name+(row.active?'':' (archivado)');
const closingDifference=value=>value==null?'Diferencia sin dato':value<0?'Faltante de '+money(-value):value>0?'Sobrante de '+money(value):'Sin diferencia';
function ClosingValues({closing}){return <><Values rows={[['Esperado',closing.expectedMinor],['Contado',closing.countedMinor]]}/><p><strong>{closingDifference(closing.differenceMinor)}</strong></p></>;}
function resultText(name,result,context){
  if(name==='expense')return result.amountMinor==null?'Costo registrado sin importe confirmado; no se movió dinero.':context.expense?.id?'Gasto corregido; se conservó el historial de pagos, sin otro movimiento de dinero.':result.paidMinor>0?'Gasto y pago registrados. Pendiente: '+money(result.outstandingMinor)+'.':'Gasto pendiente registrado; no se movió dinero.';
  return {'account-save':'Cuenta guardada. Apertura y movimientos históricos conservados.',income:'Ingreso no comercial registrado; no aumenta las ventas.',transfer:'Transferencia registrada: salida y entrada entre cuentas propias, sin cambio del total.','cash-close':'Cierre registrado con la comparación devuelta al guardar; no ajusta el dinero.','cash-reopen':'Cierre reabierto con motivo; su historia se conserva.','pay-expense':'Pago registrado. Pendiente del gasto: '+money(result.expense?.outstandingMinor)+'.','expense-recovery':'Recuperación registrada; entra dinero sin reducir otra vez el gasto.',advance:'Anticipo registrado; salida real que se considera al revisar el sueldo.','settlement-save':'Declaración guardada; no confirma recepción de dinero.','settlement-confirm':'Recepción registrada. Neto de este recibo: '+money(result.receipt?.netMinor)+'.','payroll-prepare':'Sueldo confirmado como obligación; no registra un pago.','payroll-confirm':'Sueldo confirmado como obligación; no registra un pago.','payroll-pay':'Pago de sueldo registrado.','cash-reverse':'Reversión registrada; el original se conserva.','document-reverse':'Documento revertido completo; se conserva la historia.'}[name]||'Operación registrada.';
}
export default function CashWorkspace({api,view,onViewChange,onOpenOrder,onNavigate,onInteractionStateChange,onMutation,revision}){
  const tab=view.tab||'overview',period=view.period||'month',anchor=view.anchor||bogotaDate();
  const [data,setData]=useState(null),[overview,setOverview]=useState(null),[detail,setDetail]=useState(null),[closings,setClosings]=useState(null),[closingPage,setClosingPage]=useState(1),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[action,setAction]=useState(null),[notice,setNotice]=useState('');
  const [catalogs,setCatalogs]=useState({people:[],sources:[]}),[dataKey,setDataKey]=useState('');
  const seq=useRef(0),interaction=useRef({busy:false,dirty:false});
  const headingRef=useRef(null),accountHeadingRef=useRef(null),detailHeadingRef=useRef(null),accountOpener=useRef(null),detailOpener=useRef(null),accountReturn=useRef(null),skipFocusRecord=useRef(null),pendingFocus=useRef(null),operationsRef=useRef(null);
  const pendingReturn=useRef(null);
  const bounds=periodBounds(period,anchor),record=view.record;
  const queryKey=JSON.stringify([tab,record,view.account,view.q,view.page,view.status,view.seller,view.source,view.category,bounds.startDate,bounds.endDateExclusive,revision,retry,closingPage]);
  const isLoading=loading||dataKey!==queryKey,ready=!isLoading&&!error;
  const change=patch=>onViewChange({...patch,page:patch.page??1});
  const openAction=(name,context={})=>{if(interaction.current.busy)return;if(operationsRef.current?.open){const fromMenu=operationsRef.current.contains(document.activeElement);operationsRef.current.open=false;if(fromMenu)operationsRef.current.querySelector('summary')?.focus();}setAction({name,context});};
  const report=useRef(state=>{interaction.current=state;}).current;
  const parentInteraction=useRef(onInteractionStateChange);parentInteraction.current=onInteractionStateChange;
  const reportInteraction=useRef(state=>{report(state);parentInteraction.current?.(state);}).current;
  useEffect(()=>{setAction(null);},[tab,period,anchor,record,view.account,view.page,view.q,view.status,view.seller,view.source,view.category]);
  useEffect(()=>{pendingFocus.current=record&&record!==skipFocusRecord.current?{tab,record,ready:false}:null;},[tab,record]);
  useEffect(()=>{
    const current=++seq.current;setLoading(true);setError('');setDetail(null);
    const params=new URLSearchParams({page:String(view.page||1),q:view.q||'',startDate:bounds.startDate,endDateExclusive:bounds.endDateExclusive});
    if(tab==='movements'&&view.account)params.set('account',view.account);
    if(['expenses','payroll'].includes(tab)&&view.seller)params.set('person',view.seller);
    if(tab==='settlements'&&view.source)params.set('source',view.source);
    if(view.status)params.set('status',view.status);
    if(tab==='expenses'&&view.category)params.set('category',view.category);
    const overviewRequest=tab==='overview'?api('/api/admin/finance/overview'):api('/api/admin/business/accounts').then(value=>({accounts:value.records||[]}));
    const listRequest=tab==='overview'?Promise.resolve(null):api('/api/admin/finance/'+tab+'?'+params);
    const detailRequest=record?(tab==='overview'&&record===view.account?Promise.resolve(null):api('/api/admin/finance/'+(tab==='overview'?'closings':tab)+'?'+new URLSearchParams({record}))):Promise.resolve(null);
    const closeParams=new URLSearchParams({page:String(closingPage)});if(view.account)closeParams.set('account',view.account);
    Promise.all([overviewRequest,listRequest,detailRequest,tab==='overview'&&view.account?api('/api/admin/finance/closings?'+closeParams):null,
      ['expenses','payroll'].includes(tab)?api('/api/admin/business/people'):null,
      tab==='settlements'?api('/api/admin/business/sources'):null,
      tab==='settlements'?api('/api/admin/business/platforms'):null
    ]).then(([summary,list,item,closed,people,sources,platforms])=>{
      if(current!==seq.current)return;
      setOverview(summary);setData(list);setDetail(item);setClosings(closed);
      setCatalogs({people:people?.records||[],sources:(sources?.records||[]).map(source=>({...source,name:[platforms?.records?.find(p=>p.id===source.platformId)?.name||'Plataforma no disponible',source.name].join(' · ')}))});
      setDataKey(queryKey);
      if(pendingFocus.current?.tab===tab&&pendingFocus.current.record===record)pendingFocus.current.ready=true;
    }).catch(cause=>{if(current===seq.current){setError(cause.message);setDataKey(queryKey);}}).finally(()=>{if(current===seq.current)setLoading(false);});
    return()=>{seq.current++;};
  },[api,queryKey]);
  async function saved(result){
    const {name,context}=action;
    setAction(null);setNotice({name,result,text:resultText(name,result,context)});
    try{await onMutation?.();setRetry(x=>x+1);}catch(cause){setNotice(old=>({...old,refreshError:cause.message}));}
  }
  const account=overview?.accounts?.find(a=>a.id===view.account);
  const accountDetail=tab==='overview'&&!!record&&!!account;
  function openAccount(id){skipFocusRecord.current=null;accountOpener.current=document.activeElement;accountReturn.current={account:view.account||null,page:view.page||1};setClosingPage(1);change({account:id,record:id,page:view.page||1});}
  function openDetail(id){skipFocusRecord.current=null;detailOpener.current=document.activeElement;change({record:id,page:view.page||1});}
  function closeDetail(){
    if(interaction.current.busy||action)return;
    const closingDetail=tab==='overview'&&record!==view.account;
    const trigger=closingDetail||tab!=='overview'?detailOpener.current:accountOpener.current;
    pendingReturn.current={kind:closingDetail||tab!=='overview'?'record':'account',id:closingDetail||tab!=='overview'?record:view.account};
    skipFocusRecord.current=tab==='overview'&&closingDetail?view.account:null;
    if(tab==='overview'&&!closingDetail)onViewChange({account:accountReturn.current?accountReturn.current.account:view.account||null,record:null,page:accountReturn.current?.page||view.page||1});
    else onViewChange({record:skipFocusRecord.current,page:view.page||1});
    requestAnimationFrame(()=>{if(trigger?.isConnected)trigger.focus();});
  }
  useEffect(()=>{
    const target=pendingFocus.current;
    if(!ready||!target?.ready||target.tab!==tab||target.record!==record)return;
    const heading=detail?.id===record?detailHeadingRef.current:accountDetail&&record===account.id?accountHeadingRef.current:null;
    if(heading){pendingFocus.current=null;heading.focus();}
  },[ready,tab,record,detail?.id,accountDetail,account?.id]);
  useEffect(()=>{
    if(!ready||!pendingReturn.current)return;
    const {kind,id}=pendingReturn.current;pendingReturn.current=null;
    const target=document.querySelector(`[data-cash-${kind}="${CSS.escape(id||'')}"]`);
    (target||headingRef.current)?.focus();
  },[ready]);
  function handleKeyDown(event){if(event.key!=='Escape'||event.defaultPrevented||!record||action||interaction.current.busy||event.target.closest('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;event.preventDefault();event.stopPropagation();closeDetail();}
  const documentReverse=(documentType,documentId,documentVersion=1)=>openAction('document-reverse',{documentType,documentId,documentVersion});
  const pageButtons=(list,current,onPage)=><div className="cash-pagination"><button type="button" className="button subtle" disabled={loading||current<=1} onClick={()=>onPage(current-1)}>Anterior</button><span>Página {current} · {list.total} registros</span><button type="button" className="button subtle" disabled={loading||current*20>=list.total} onClick={()=>onPage(current+1)}>Siguiente</button></div>;
  const filterDefinitions=[
    ['q','Búsqueda',view.q],
    ...(tab==='movements'?[['account','Cuenta',view.account&&(overview?.accounts?.find(a=>a.id===view.account)?catalogName(overview.accounts.find(a=>a.id===view.account)):'Registro no disponible')]]:[]),
    ...(tab==='expenses'?[['category','Categoría',category[view.category]]]:[]),
    ...(['expenses','payroll'].includes(tab)?[['seller',tab==='expenses'?'Persona responsable':'Persona',view.seller&&(catalogs.people.find(p=>p.id===view.seller)?catalogName(catalogs.people.find(p=>p.id===view.seller)):'Registro no disponible')]]:[]),
    ...(tab==='settlements'?[['source','Cuenta de plataforma',view.source&&(catalogs.sources.find(s=>s.id===view.source)?catalogName(catalogs.sources.find(s=>s.id===view.source)):'Registro no disponible')]]:[]),
    ...(['settlements','payroll'].includes(tab)?[['status','Estado',stateLabel[view.status]]]:[])
  ].filter(([, ,value])=>value);
  const activeFilters=filterDefinitions.length;
  const clearFilters=()=>change({q:null,account:null,status:null,seller:null,source:null,category:null,record:null});
  const filterSelect=(key,title,options,all='Todas')=><label className="field">{title}<select value={view[key]||''} onChange={e=>change({[key]:e.target.value||null,record:null})}><option value="">{all}</option>{view[key]&&!options.some(([id])=>id===view[key])&&<option value={view[key]}>Registro no disponible</option>}{options.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>;
  const ownAction=tab==='expenses'?['expense','Registrar gasto']:tab==='settlements'?['settlement-save','Registrar liquidación']:tab==='payroll'?['payroll-prepare','Preparar período']:['income','Registrar ingreso'];
  const activeAccounts=ready?(overview?.accounts||[]).filter(a=>a.active):[];
  const operationReason=id=>id==='expense'||id==='settlement-save'||id==='payroll-prepare'?'':!ready?'Espera la consulta de cuentas; si falla, usa Reintentar.':id==='transfer'&&activeAccounts.length<2?'Necesitas dos cuentas activas distintas.':id==='cash-close'&&!activeAccounts.some(a=>a.type==='cash')?'Necesitas una cuenta activa de efectivo para contar y cerrar.':!activeAccounts.length?'Crea o reactiva una cuenta para registrar dinero.':'';
  const actionButton=(id,title,primary=false,explanation=null)=>{
    const reason=operationReason(id),suggested=account?.active&&(id!=='cash-close'||account.type==='cash')?account:undefined;
    return <div className={styles.dailyAction} key={id}><button type="button" className={`button ${primary?'primary':'subtle'}`} disabled={!!reason} onClick={()=>openAction(id,{account:suggested})}>{title}</button>{explanation&&<p>{explanation}</p>}{reason&&<p className={styles.requirement}>{reason}</p>}{id==='income'&&<p>Para cobrar una venta, <button type="button" className="text-button" onClick={()=>onNavigate?.({section:'orders',tab:'list'})}>abre el pedido</button>.</p>}</div>;
  };
  const dailyActions=<section aria-label="Acciones del día" className={styles.dailySection}><h2>Acciones del día</h2><div className={styles.dailyActions}>{operations.map(([id,title],index)=>actionButton(id,title,index===0,{expense:'Registra la obligación; pagar es una elección aparte.',income:'Aportes u otros ingresos, no ventas.',transfer:'Traslada dinero entre cuentas propias.', 'cash-close':'Cuenta el efectivo y conserva la diferencia.'}[id]))}</div></section>;
  const accountCard=a=><article className="cash-card" key={a.id}><h3>{a.name}</h3><p>{a.active?'Activa':'Archivada'} · {{cash:'Efectivo',bank:'Banco',wallet:'Billetera'}[a.type]}</p><strong>{money(a.balanceMinor)}</strong><p>Responsable: {a.responsibleName||'Sin asignar'}</p>{a.balanceMinor<0&&<p className={styles.requirement}>Saldo negativo</p>}{a.minimumMinor!=null&&a.balanceMinor<a.minimumMinor&&<p className={styles.requirement}>Por debajo del mínimo</p>}{!a.active&&a.balanceMinor!==0&&<p>El total registrado incluye el saldo de esta cuenta archivada.</p>}<button type="button" className="button subtle" data-cash-account={a.id} onClick={()=>openAccount(a.id)}>Abrir cuenta</button></article>;
  return <section className={`cash-workspace ${styles.workspace} ${styles.cashWorkspace}`} aria-busy={isLoading} onKeyDown={handleKeyDown}>
    <header className="workspace-heading"><div><p className="eyebrow">Dinero y obligaciones</p><h1 ref={headingRef} tabIndex={-1} data-admin-section-heading>Caja</h1><p>Organiza el dinero real, los pagos y lo que queda pendiente.</p></div><button type="button" className="button subtle" onClick={()=>onNavigate?.({section:'business',tab:'accounts'})}>Configurar cuentas</button></header>
    <WorkspaceTabs label="Vistas de caja" items={tabItems} value={tab} disabled={!!action} onChange={id=>change({tab:id,record:null,status:null})}/>
    {guidance[tab]&&<header className={styles.contextHeading}><h2>{guidance[tab][0]}</h2><p>{guidance[tab][1]}</p></header>}
    <CashGuide tab={tab} onNavigate={onNavigate} disabled={!!action}/>
    {notice&&<div role="status" className={styles.savedResult}><p>{notice.text}</p>{notice.name==='cash-close'&&<><ClosingValues closing={notice.result}/><button type="button" className="button subtle" onClick={()=>change({tab:'overview',account:notice.result.accountId,record:notice.result.id,status:null})}>Ver cierre</button></>}{notice.result.warnings?.map((warning,index)=><p key={index}>{warning}</p>)}{(notice.refreshError||error)&&<p>La operación sí quedó registrada; la vista está pendiente de actualizar. {notice.refreshError}</p>}</div>}
    {error&&<div role="alert" className="error">{error}<button type="button" className="button subtle" onClick={()=>setRetry(x=>x+1)}>Reintentar</button></div>}
    {isLoading&&<p role="status">Cargando caja para esta consulta…</p>}
    {tab==='overview'?<>
      {ready&&overview&&<section aria-label="Resumen financiero" className={styles.financialSummary}>
        <div className={styles.available}><h2>Disponible en cuentas</h2><strong>{money(overview.availableMinor)}</strong><p>Saldo registrado al {overview.asOf}, Bogotá. No es la ganancia del negocio.</p></div>
        <div className={styles.obligations}>
          <article><h3>Por recibir de plataforma</h3><strong>{money(overview.platformPendingMinor)}</strong><button type="button" className="text-button" onClick={()=>change({tab:'settlements',record:null,status:null})}>Consultar liquidaciones</button></article>
          <article><h3>Gastos por pagar</h3><strong>{money(overview.expensesOutstandingMinor)}</strong><p>Incluye {money(overview.payrollOutstandingMinor)} de sueldos.</p><button type="button" className="text-button" onClick={()=>change({tab:'expenses',record:null,status:null})}>Consultar gastos</button><button type="button" className="text-button" onClick={()=>change({tab:'payroll',record:null,status:null})}>Consultar sueldos</button></article>
          <article><h3>Créditos por recuperar</h3><strong>{money(overview.expenseCreditsMinor)}</strong><p>Saldo a favor por recuperar o compensar.</p><button type="button" className="text-button" onClick={()=>change({tab:'expenses',record:null,status:null})}>Revisar créditos en gastos</button></article>
        </div><p className={styles.queryHelp}>Los listados dependen del período que se abre; no prometen un desglose exacto de estos pendientes actuales.</p>
        {overview.unassignedDateExpenses>0&&<p>Hay {overview.unassignedDateExpenses} gastos sin fecha. No entran en listados por fecha; puedes abrirlos desde sus vínculos de detalle, sin asignarles un período ficticio.</p>}
      </section>}
      {dailyActions}
      <section aria-label="Cuentas"><header className="workspace-heading"><div><h2>Cuentas</h2><p>Una cuenta por cada lugar donde está el dinero.</p></div><div className="cash-actions"><button type="button" className={`button ${ready&&!overview?.accounts.length?'primary':'subtle'}`} onClick={()=>openAction('account-save')}>Crear cuenta</button><button type="button" className="button subtle" onClick={()=>onNavigate?.({section:'business',tab:'setup'})}>Configuración guiada</button></div></header>
      {ready&&overview&&<>
        {!overview.accounts.length&&<div className="admin-empty"><h3>Configura tu primera cuenta</h3><p>Registra una apertura real, incluso cero, y una persona responsable sin credenciales. Mientras tanto puedes registrar gastos pendientes.</p></div>}
        <div className="cash-account-grid">{overview.accounts.filter(a=>a.active).map(accountCard)}</div>
        {overview.accounts.some(a=>!a.active)&&<details className={styles.archivedAccounts} key={view.account||'archived'} open={account&&!account.active?true:undefined}><summary>Cuentas archivadas</summary><p>Se conserva su historia y su saldo en el total registrado. Configura una cuenta para reactivarla.</p><div className="cash-account-grid">{overview.accounts.filter(a=>!a.active).map(accountCard)}</div></details>}
      </>}
      </section>
      {ready&&accountDetail&&<section className="cash-detail"><header><h2 ref={accountHeadingRef} tabIndex={-1}>{account.name}</h2>{!detail&&<button type="button" className="button subtle" onClick={closeDetail}>Cerrar detalle</button>}</header><Values rows={[["Saldo actual",account.balanceMinor],["Apertura",account.openingOn],["Saldo mínimo",account.minimumMinor]]}/>{!account.active&&<p>Cuenta archivada: consulta su historia o configúrala para reactivarla. No admite movimientos nuevos.</p>}<div className="cash-actions"><button type="button" className="button subtle" onClick={()=>openAction('account-save',{account})}>Configurar cuenta</button><button type="button" className="button subtle" onClick={()=>change({tab:'movements',record:null})}>Ver movimientos</button>{account.type==='cash'&&account.active&&<button type="button" className="button subtle" onClick={()=>openAction('cash-close',{account})}>Cerrar esta caja</button>}</div>
        {account.type==='cash'&&<><h3>Cierres históricos</h3>{closings?.records.map(c=><article className="cash-row" key={c.id}><div><h4>{c.closingOn} · Revisión {c.revision} · {stateLabel[c.state]}</h4><ClosingValues closing={c}/></div><button type="button" className="button subtle" data-cash-record={c.id} onClick={()=>openDetail(c.id)}>Ver cierre</button></article>)}{closings&&!closings.records.length&&<p>No hay cierres registrados para esta cuenta.</p>}{closings&&closings.total>0&&pageButtons(closings,closingPage,setClosingPage)}</>}
      </section>}
      {ready&&detail&&<section className="cash-detail"><header><h2 ref={detailHeadingRef} tabIndex={-1}>Cierre del {detail.closingOn}</h2><button type="button" className="button subtle" onClick={closeDetail}>Cerrar detalle</button></header><p>Revisión {detail.revision} · {stateLabel[detail.state]}</p><ClosingValues closing={detail}/>{detail.state==='closed'&&<button type="button" className="button subtle" onClick={()=>openAction('cash-reopen',{closing:detail})}>Reabrir cierre con motivo</button>}</section>}
    </>:<>
      {tab==='movements'?dailyActions:<div className={styles.operationBar} aria-label="Acciones de caja">
        {actionButton(ownAction[0],ownAction[1],true)}
        {tab==='payroll'&&actionButton('advance','Registrar anticipo')}
        <details ref={operationsRef} className={styles.operationMenu}><summary className="button subtle">Otras operaciones</summary><div>{operations.filter(([id])=>id!==ownAction[0]).map(([id,title])=>actionButton(id,title))}</div></details>
      </div>}
      <PeriodPicker period={period} anchor={anchor} onChange={patch=>change({...patch,record:null})}/>
      <div className={styles.cashSearchFilters}>
        <label className="field">Buscar<input value={view.q||''} maxLength={100} onChange={e=>change({q:e.target.value,record:null})}/></label>
        <details className={styles.cashFilterMenu}><summary>Filtros{activeFilters?` (${activeFilters} activos)`:''}</summary><div className="cash-filters">
          {tab==='movements'&&filterSelect('account','Cuenta',(overview?.accounts||[]).map(a=>[a.id,catalogName(a)]))}
          {tab==='expenses'&&filterSelect('category','Categoría',Object.entries(category))}
          {['expenses','payroll'].includes(tab)&&filterSelect('seller',tab==='expenses'?'Persona responsable':'Persona',catalogs.people.map(p=>[p.id,catalogName(p)]),'Todas')}
          {tab==='settlements'&&filterSelect('source','Cuenta de plataforma',catalogs.sources.map(s=>[s.id,catalogName(s)]))}
          {['settlements','payroll'].includes(tab)&&<label className="field">Estado<select value={view.status||''} onChange={e=>change({status:e.target.value||null,record:null})}><option value="">Todos</option>{(tab==='settlements'?['pending','partial','confirmed']:['draft','confirmed','partial','paid']).map(s=><option value={s} key={s}>{stateLabel[s]}</option>)}</select></label>}
        </div></details>
      </div>
      {!!activeFilters&&<div className="active-filters" aria-label="Filtros activos">{filterDefinitions.map(([key,label,value])=><button type="button" key={key} className="filter-chip" aria-label={`Quitar filtro: ${label}: ${value}`} onClick={()=>change({[key]:null,record:null})}>{label}: {value} <span aria-hidden="true">×</span></button>)}<button type="button" className="text-button" onClick={clearFilters}>Limpiar filtros</button></div>}
      <div aria-busy={isLoading}>
      {ready&&data&&<><div className="cash-records" aria-label={tabs[tab]}>{data.records.map(row=><article className="cash-row" key={row.id}><div>
        <h3>{tab==='movements'?movementTitle(row):row.concept||row.personName||row.sourceName||category[row.category]||tabs[tab]}</h3>
        <p>{row.effectiveOn||row.reportedOn||row.incurredOn||row.startOn||'Fecha desconocida'}{row.endOnExclusive?' a '+row.endOnExclusive+' (fecha de corte no incluida)':''} · {stateLabel[row.state]||(tab==='movements'?cashMovementLabels[row.kind]||'Movimiento registrado':category[row.category])}</p>
        {tab==='movements'?<><p>{row.accountName||'Cuenta no disponible'} · {row.reference||'Sin referencia'}</p><p>{movementFlow(row)}</p>{row.kind==='transfer'&&<p>Traslado entre cuentas propias: no cambia el total entre cuentas.</p>}</>:tab==='expenses'?<p>Importe {money(row.amountMinor)} · Pagado {money(row.paidMinor)} · Pendiente {money(row.outstandingMinor)}{row.creditMinor>0?' · Crédito '+money(row.creditMinor):''}</p>:tab==='settlements'?<p>Declarado {money(row.netMinor)} · Recibido {money(row.receivedNetMinor)} · Pendiente {money(row.outstandingNetMinor)}</p>:<Values rows={[['Devengado',row.earnedMinor],['Importe',row.amountMinor],['Pendiente',row.outstandingMinor],['Pago nuevo propuesto',row.amountToPayMinor]]}/>}
        {tab==='expenses'&&row.personName&&<p>Persona responsable: {row.personName}</p>}
      </div><button type="button" className="button subtle" data-cash-record={row.id} onClick={()=>openDetail(row.id)}>Ver detalle</button></article>)}</div>
        {!data.records.length&&<div className="admin-empty"><h2>No hay registros para esta consulta</h2><p>Período: {bounds.startDate} hasta {bounds.endDateExclusive} (corte no incluido). Una consulta vacía no significa que nunca hubo operaciones.</p>{data.total>0?<button type="button" className="button primary" onClick={()=>change({page:1,record:null})}>Ir a la primera página</button>:actionButton(ownAction[0],ownAction[1],true)}{activeFilters>0&&<button type="button" className="button subtle" onClick={clearFilters}>Limpiar filtros de esta consulta</button>}</div>}
        {data.total>0&&pageButtons(data,view.page||1,page=>change({page,record:null}))}
      </>}
      {ready&&detail&&<section className="cash-detail"><header><h2 ref={detailHeadingRef} tabIndex={-1}>Detalle · {tab==='movements'?movementTitle(detail):detail.concept||detail.startOn||detail.externalId||tabs[tab]}</h2><button type="button" className="button subtle" onClick={closeDetail}>Cerrar detalle</button></header><Values rows={[["Importe",detail.amountMinor],["Pagado",detail.paidMinor],["Estado",stateLabel[detail.state]],["Pendiente",detail.outstandingMinor],["Crédito",detail.creditMinor],["Neto declarado",detail.netMinor],["Neto recibido",detail.receivedNetMinor],["Neto por recibir",detail.remainingNetMinor],["Devengado",detail.earnedMinor],["Compensado",detail.offsetMinor],["Anticipos aplicados",detail.advanceAppliedMinor],["Anticipos disponibles",detail.advanceAvailableMinor],["Créditos anteriores disponibles",detail.availableCreditMinor],["Pago nuevo propuesto",detail.amountToPayMinor]]}/>{detail.orderId&&<button type="button" className="button subtle" onClick={()=>onOpenOrder?.(detail.orderId)}>Abrir pedido vinculado</button>}
        {tab==='movements'&&<><p>{detail.effectiveOn} · {detail.reference||'Sin referencia'} · {detail.reason||detail.description}</p>{detail.reversalOf||detail.reversed?<p>Movimiento revertido o de reversión; se conserva la historia.</p>:detail.documentType?<button type="button" className="button subtle" onClick={()=>documentReverse(detail.documentType,detail.documentId,detail.documentVersion)}>Revertir documento vinculado</button>:['income','adjustment','transfer'].includes(detail.kind)&&<button type="button" className="button subtle" onClick={()=>openAction('cash-reverse',{entry:detail})}>Revertir movimiento completo</button>}</>}
        {tab==='expenses'&&!['salary','commission','bonus'].includes(detail.category)&&<button type="button" className="button subtle" onClick={()=>openAction('expense',{expense:detail})}>Corregir importe o fecha con motivo</button>}
        {tab==='expenses'&&<ImportedData record={detail} title="Datos importados del gasto" description="Información de origen; registrar el gasto no confirma un pago."/>}
        {tab==='movements'&&!detail.reversalOf&&!detail.reversed&&['owner_funding','other_non_sale'].includes(detail.kind)&&<button type="button" className="button subtle" onClick={()=>openAction('cash-reverse',{entry:detail})}>Revertir ingreso no comercial</button>}
        {tab==='expenses'&&<><div className="cash-actions">{detail.outstandingMinor>0&&!['salary','commission','bonus'].includes(detail.category)&&<button type="button" className="button primary" onClick={()=>openAction('pay-expense',{expense:detail})}>Pagar saldo o abono</button>}{detail.creditMinor>0&&<button type="button" className="button subtle" onClick={()=>openAction('expense-recovery',{expense:detail})}>Recuperar sobrepago</button>}</div>{detail.activePayments?.map(p=><article key={p.id} className="cash-row"><span>{p.effectiveOn||'Fecha del documento'} · {money(p.amountMinor)} · {cashMovementLabels[p.kind]||'Movimiento registrado'}</span>{p.settlementReceiptId?<button type="button" className="button subtle" onClick={()=>documentReverse('settlement_receipt',p.settlementReceiptId)}>Revertir recibo de liquidación</button>:!p.payrollId&&!p.advance&&<button type="button" className="button subtle" onClick={()=>documentReverse('expense_payment',p.id)}>Revertir pago</button>}</article>)}</>}
        {tab==='settlements'&&<>
          <div className="cash-actions">{detail.remainingLines?.length>0&&<button type="button" className="button primary" onClick={()=>openAction('settlement-confirm',{settlement:detail})}>Confirmar recepción o abono</button>}<button type="button" className="button subtle" onClick={()=>openAction('settlement-save',{settlement:detail})}>Completar o corregir declaración</button>{detail.receipts?.some(r=>!r.reversalOf&&!detail.receipts.some(x=>x.reversalOf===r.id))&&<button type="button" className="button subtle" onClick={()=>documentReverse('settlement',detail.id,detail.version)}>Revertir liquidación completa</button>}</div>
          {detail.reconciliationRequired&&<p role="status">Requiere conciliación: completa los soportes; una diferencia no se convierte automáticamente en gasto.</p>}
          {detail.unresolvedLines?.map((l,i)=><p key={i}>Referencia pendiente: {l.tracking||l.externalOrderId||l.reference||'Sin vínculo'} · {money(l.grossMinor)}</p>)}
          {detail.receipts?.map(receipt=><article key={receipt.id} className="cash-row"><div><h3>{receipt.reversalOf?'Reversión':detail.receipts.some(x=>x.reversalOf===receipt.id)?'Recibo revertido':'Recepción'} · {receipt.receivedOn}</h3><p>Neto: {money(receipt.netMinor)}</p>
            {receipt.lines?.map(line=><section key={line.collectionId}><h4>{detail.lines?.find(l=>l.collectionId===line.collectionId)?.label||'Cobro vinculado'}</h4><p>Bruto asignado: {money(line.grossMinor)}</p>{line.deductions?.length>0&&<><p>Retenciones y recuperaciones aplicadas a gastos existentes:</p><ul>{line.deductions.map(deduction=><li key={deduction.expenseId}>{detail.lines?.find(l=>l.collectionId===line.collectionId)?.deductions?.find(d=>d.expenseId===deduction.expenseId)?.label||'Retención / recuperación'} · {money(deduction.amountMinor)}</li>)}</ul></>}</section>)}
          </div>{!receipt.reversalOf&&!detail.receipts.some(x=>x.reversalOf===receipt.id)&&<button type="button" className="button subtle" onClick={()=>documentReverse('settlement_receipt',receipt.id)}>Revertir este recibo</button>}</article>)}
        </>}
        {tab==='payroll'&&<><div className="cash-actions">{detail.state==='draft'&&<button type="button" className="button primary" onClick={()=>openAction('payroll-confirm',{payroll:detail})}>Confirmar período</button>}{detail.state!=='draft'&&detail.outstandingMinor>0&&<button type="button" className="button primary" onClick={()=>openAction('payroll-pay',{payroll:detail})}>Pagar saldo o abono</button>}</div><h3>Obligaciones registradas</h3>{detail.obligations?.map(e=><p key={e.id}>{category[e.category]||e.concept} · {e.incurredOn||'Sin fecha'} · {money(e.amountMinor)} · Saldo {money(e.outstandingMinor)} · Crédito {money(e.creditMinor)}</p>)}{detail.carriedCredits?.map(e=><p key={e.id}>Crédito anterior {category[e.category]} · {money(e.creditMinor)}</p>)}{detail.advances?.map(a=><p key={a.id}>Anticipo del {a.effectiveOn} · Disponible {money(a.availableMinor)}</p>)}{detail.activePayments?.map(p=><article className="cash-row" key={p.id}><span>Pago {p.effectiveOn} · {money(-p.amountMinor)}</span><button type="button" className="button subtle" onClick={()=>documentReverse('payroll_payment',p.sourceId,detail.version)}>Revertir pago y aplicaciones</button></article>)}{!detail.activePayments?.length&&(detail.activeOffsets?.length>0||detail.advanceAppliedMinor>0)&&<button type="button" className="button subtle" onClick={()=>documentReverse('payroll_payment',detail.id,detail.version)}>Revertir compensaciones y anticipos sin caja nueva</button>}</>}
      </section>}
      </div>
      <p className={styles.queryHelp}>Este listado usa las fechas del hecho; los registros sin fecha no entran en el período. {tab==='payroll'?'Control interno de remuneración, no nómina legal.':''}</p>
    </>}
    {action&&<BusinessActionDialog key={action.name} action={action.name} context={action.context} api={api} onClose={()=>setAction(null)} onSaved={saved} onInteractionStateChange={reportInteraction}/>}
  </section>;
}
