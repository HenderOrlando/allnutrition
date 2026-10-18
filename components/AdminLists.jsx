'use client';
import {schemas,contentStates,orderStates,paymentStates,shipmentStates,money} from '@/lib/schema.mjs';
import Icon from './Icons';
import ImageByUrl from './ImageByUrl';
import {formatMoneyMinor} from '@/lib/business/money.mjs';

const label=(states,value)=>states.find(state=>state.value===value)?.label||value;
const orderNumber=record=>`AN-${String(record.number).padStart(6,'0')}`;
const issueLabels={incident:'Con novedad',pending_settlement:'Pendiente de liquidar',missing_data:'Faltan datos',missing_cost:'Faltan costos',legacy_review:'Pago histórico por conciliar'};
const orderFilterKeys=['q','status','paymentStatus','issue','seller','platform','carrier','product'];
function Feedback({loaded,loading,error,onRetry}) {
 return <div className="list-feedback">
  {loading&&<p role="status">{loaded?'Actualizando… Los registros anteriores siguen visibles.':'Cargando registros…'}</p>}
  {!loaded&&loading&&<div className="static-skeleton" aria-hidden="true"/>}
  {error&&<div className="error" role="alert">{error}<button type="button" className="text-button" onClick={onRetry}>Reintentar</button></div>}
  {loaded&&error&&<p role="status">Se muestran los registros de la última carga correcta; la vista está pendiente de actualizar.</p>}
 </div>;
}
function ActiveFilters({view,onClear,onRemove,orders=false}) {
 const filters=[
  ['q',view.q?`Búsqueda: ${view.q}`:''],
  ['status',view.status?`${orders?'Pedido':'Publicación'}: ${label(orders?orderStates:contentStates,view.status)}`:''],
  ['paymentStatus',view.paymentStatus?`Cobro: ${label(paymentStates,view.paymentStatus)}`:''],
  ['productType',view.productType?`Tipo: ${view.productType==='gift'?'Obsequios':'Productos'}`:''],
  ['issue',view.issue?`Atención: ${issueLabels[view.issue]||view.issue}`:''],
  ...(orders?[
   ['seller',view.seller?'Vendedor seleccionado':''],
   ['platform',view.platform?'Plataforma seleccionada':''],
   ['carrier',view.carrier?`Transportadora: ${view.carrier}`:''],
   ['product',view.product?'Producto seleccionado':'']
  ]:[])
 ].filter(([,title])=>title);
 return filters.length>0&&<div className="active-filters" aria-label="Filtros activos">
  {filters.map(([key,title])=><button type="button" className="pill filter-chip" key={key} aria-label={`Quitar filtro: ${title}`} onClick={()=>onRemove(key)}><span>{title}</span><Icon name="close" size={16}/></button>)}
  <button type="button" className="text-button" onClick={onClear}>Limpiar filtros</button>
 </div>;
}
function ContentIdentity({record}) {
 return <div className="row-identity"><ImageByUrl src={record.image} alt="" width={56} height={64}/><div><strong>{record.title}</strong><small>{record.presentation||`/${record.slug}`}</small></div></div>;
}
function InventoryLabel({record}) {
 return <span className="small">{record.productType==='gift'?`${record.stockAvailable??'Sin conteo de'} posibles con sus componentes`:record.stockQuantity==null?`Sin contar · ${record.stockReserved||0} reservadas`:`${record.stockQuantity} físicas · ${record.stockReserved||0} reservadas · ${record.stockAvailable} disponibles`}</span>;
}
function OrderLabels({record}) {
 const shipping=[...new Set((record.shipments||[]).map(shipment=>shipment.status))];
 const payment=record.paymentSummary;
 return <div className="order-state-summary">
  <span className={`pill ${record.status}`}>{label(orderStates,record.status)}</span>
  <span>Envíos: {shipping.length?shipping.map(status=>label(shipmentStates,status)).join(' · '):'Sin envío registrado'}{record.deliverySummary?.partial?' · Entrega parcial':''}</span>
  <span>Cobro: {label(paymentStates,payment?.status)||'Sin dato'}</span>
  {payment?.outstandingMinor>0&&<small>Pendiente: {formatMoneyMinor(payment.outstandingMinor)}</small>}
  {payment?.refundDueMinor>0&&<small>A reembolsar: {formatMoneyMinor(payment.refundDueMinor)}</small>}
  <div className="state-pair">
   {payment?.legacyReview&&<span className="pill">Pago histórico por conciliar</span>}
   {record.financialSummary?.complete===false&&<span className="pill">Faltan costos</span>}
   {payment?.platformHeldMinor>0&&<span className="pill">Pendiente de liquidar</span>}
  </div>
 </div>;
}
export function ContentList({kind,resource,view,onViewChange,onCreate,onEdit,onRetry}) {
 const schema=schemas[kind],loaded=resource.records!==null,priced=['products','combos'].includes(kind);
 const filtered=Boolean(view.q||view.status||view.productType);
 const noMatches=filtered&&resource.records?.length>0;
 const query=view.q.toLocaleLowerCase('es');
 const rows=loaded?resource.records.filter(record=>(!view.status||record.status===view.status)&&(!view.productType||(record.productType||'product')===view.productType)&&[record.title,record.presentation,record.sku,record.slug].some(value=>String(value||'').toLocaleLowerCase('es').includes(query))):[];
 const clear=()=>onViewChange({q:'',status:'',productType:undefined,page:1});
 const edit=record=><button type="button" className="button subtle" aria-label={`Editar ${record.title}`} onClick={()=>onEdit(kind,record)}>Editar<Icon name="edit" size={16}/></button>;
 return <section className="data-card" aria-busy={resource.loading}>
  {loaded&&<header className="content-list-summary"><div><h2>{schema.label}</h2><p>{resource.records.length} registros guardados · {resource.records.filter(record=>record.status==='published').length} publicados · {resource.records.filter(record=>record.status==='draft').length} borradores</p></div>{filtered&&<span className="pill">{rows.length} coincidencias</span>}</header>}
  <div className="list-toolbar">
   <label className="tool-field" htmlFor={`search-${kind}`}>Buscar por nombre, presentación o referencia<span className="search-box"><Icon name="search" size={18}/><input id={`search-${kind}`} name="q" type="text" maxLength={100} placeholder={`Nombre, presentación o referencia de ${schema.singular}`} value={view.q} onChange={event=>onViewChange({q:event.target.value})}/></span></label>
   <label className="tool-field" htmlFor={`status-${kind}`}>Filtrar por publicación<select id={`status-${kind}`} name="status" value={view.status} onChange={event=>onViewChange({status:event.target.value,page:1})}><option value="">Todas las publicaciones</option>{contentStates.map(state=><option key={state.value} value={state.value}>{state.label}</option>)}</select></label>
   {kind==='products'&&<label className="tool-field" htmlFor="products-type">Tipo de producto<select id="products-type" name="productType" value={view.productType||''} onChange={event=>onViewChange({productType:event.target.value||undefined,page:1})}><option value="">Todos los tipos</option><option value="product">Productos</option><option value="gift">Obsequios</option></select></label>}
   <button type="button" className="button primary" onClick={()=>onCreate(kind)}><Icon name="plus"/>Crear {schema.singular}</button>
  </div>
  <ActiveFilters view={view} onClear={clear} onRemove={key=>onViewChange({[key]:key==='productType'?undefined:'',page:1})}/>
  <Feedback loaded={loaded} {...resource} onRetry={onRetry}/>
  {loaded&&rows.length>0&&<>
   <div className="list-table"><table><caption className="sr-only">{schema.label}: contenido guardado, publicación y {priced?'precio':'orden de aparición'}</caption><thead><tr><th scope="col">Contenido</th><th scope="col">Publicación</th><th scope="col">{priced?'Precio':'Orden'}</th>{kind==='products'&&<th scope="col">Inventario</th>}<th scope="col">Acción</th></tr></thead><tbody>{rows.map(record=><tr key={record.id}><td><ContentIdentity record={record}/></td><td><span className={`pill ${record.status}`}>{label(contentStates,record.status)}</span></td><td>{priced?money(record.price):record.sort}</td>{kind==='products'&&<td><InventoryLabel record={record}/></td>}<td>{edit(record)}</td></tr>)}</tbody></table></div>
   <ul className="list-cards">{rows.map(record=><li className="record-card" key={record.id}><ContentIdentity record={record}/><div className="record-card-meta"><span className={`pill ${record.status}`}>{label(contentStates,record.status)}</span><strong>{priced?money(record.price):`Orden: ${record.sort}`}</strong></div>{kind==='products'&&<InventoryLabel record={record}/>} {edit(record)}</li>)}</ul>
   <div className="table-footer">{rows.length} registros{filtered?` de ${resource.records.length}`:''} · Los cambios se realizan al abrir y guardar la ficha.</div>
  </>}
  {loaded&&!resource.error&&rows.length===0&&<div className="empty-card"><Icon name="box" size={32}/><h3>{noMatches?'No hay coincidencias':`Crea tu primer ${schema.singular}`}</h3>{noMatches?<p>Prueba otra búsqueda o usa «Limpiar filtros» arriba para ver más fichas.</p>:<p>Usa «Crear {schema.singular}» en la barra para guardar una ficha como borrador y publicarla cuando esté lista.</p>}</div>}
 </section>;
}
export function OrdersList({resource,view,onViewChange,onCreate,onEdit,onRetry}) {
 const data=resource.data,activeCount=orderFilterKeys.filter(key=>Boolean(view[key])).length,filtered=activeCount>0;
 const clear=()=>onViewChange({...Object.fromEntries(orderFilterKeys.map(key=>[key,''])),page:1});
 const filter=patch=>onViewChange({...patch,page:1});
 const open=record=><button type="button" className="button subtle" aria-label={`Abrir pedido ${orderNumber(record)}`} onClick={()=>onEdit('orders',record)}>Abrir<Icon name="chevron" size={16}/></button>;
 const maximum=data?Math.max(1,Math.ceil(data.total/data.pageSize)):1;
 const start=data?.total?(data.page-1)*data.pageSize+1:0;
 const end=data?Math.min(data.page*data.pageSize,data.total):0;
 return <section className="data-card orders-list" aria-busy={resource.loading}>
  <div className="list-toolbar">
   <label className="tool-field search-tool" htmlFor="orders-query">Buscar pedidos<span className="search-box"><Icon name="search" size={18}/><input id="orders-query" name="q" type="text" maxLength={100} placeholder="Destinatario, guía o número AN-000001" value={view.q} onChange={event=>filter({q:event.target.value})}/></span></label>
   <button type="button" className="button primary" onClick={()=>onCreate('orders')}><Icon name="plus"/>Nuevo pedido</button>
  </div>
  <details className="order-advanced-filters">
   <summary>Filtros de pedidos{activeCount>0?` · ${activeCount} ${activeCount===1?'activo':'activos'}`:''}</summary>
   <div className="order-filter-chips" role="group" aria-label="Atajos de pedidos">
    <button type="button" className="button subtle" aria-pressed={view.status==='new'&&!view.issue} onClick={()=>filter({status:'new',issue:''})}>Por preparar · nuevos</button>
    {Object.entries(issueLabels).map(([issue,title])=><button type="button" className="button subtle" key={issue} aria-pressed={view.issue===issue} onClick={()=>filter({issue,status:''})}>{title}</button>)}
   </div>
   <div className="order-filter-fields">
    <label className="tool-field" htmlFor="orders-status">Estado del pedido<select id="orders-status" name="status" value={view.status} onChange={event=>filter({status:event.target.value})}><option value="">Todos los pedidos</option>{orderStates.map(state=><option key={state.value} value={state.value}>{state.label}</option>)}</select></label>
    <label className="tool-field" htmlFor="orders-payment">Estado de cobro<select id="orders-payment" name="paymentStatus" value={view.paymentStatus} onChange={event=>filter({paymentStatus:event.target.value})}><option value="">Todos los cobros</option>{paymentStates.map(state=><option key={state.value} value={state.value}>{state.label}</option>)}</select></label>
    <label className="tool-field" htmlFor="orders-carrier">Transportadora exacta<input id="orders-carrier" name="carrier" maxLength={150} value={view.carrier||''} onChange={event=>filter({carrier:event.target.value})}/></label>
   </div>
  </details>
  <ActiveFilters view={view} orders onClear={clear} onRemove={key=>filter({[key]:''})}/>
  <p className="list-manual-note small">Registro manual: no lee conversaciones ni confirma pagos o entregas automáticamente.</p>
  <Feedback loaded={data!==null} loading={resource.loading} error={resource.error} onRetry={onRetry}/>
  {data&&data.records.length>0&&<>
   <div className="list-table"><table><caption className="sr-only">Pedidos guardados: destinatario, envíos, cobro, alertas y total acordado</caption><thead><tr><th scope="col">Pedido</th><th scope="col">Destinatario</th><th scope="col">Envíos y cobro</th><th scope="col">Total</th><th scope="col">Acción</th></tr></thead><tbody>{data.records.map(record=><tr key={record.id}><td><strong>{orderNumber(record)}</strong><small>{record.placedOn||'Fecha pendiente'}</small></td><td><strong>{record.customerName}</strong><small>{record.city}</small></td><td><OrderLabels record={record}/></td><td>{formatMoneyMinor(record.totalMinor)}</td><td>{open(record)}</td></tr>)}</tbody></table></div>
   <ul className="list-cards">{data.records.map(record=><li className="record-card order-card" key={record.id}><div className="record-card-meta"><strong>{orderNumber(record)}</strong><span className="small muted">{record.placedOn||'Fecha pendiente'}</span></div><h2>{record.customerName}</h2><p>{record.city}</p><OrderLabels record={record}/><div className="record-card-meta"><strong>{formatMoneyMinor(record.totalMinor)}</strong>{open(record)}</div></li>)}</ul>
  </>}
  {data&&!resource.error&&data.total===0&&<div className="empty-card"><Icon name="truck" size={32}/><h3>{filtered?'No hay coincidencias':'Registra tu primer pedido acordado'}</h3>{filtered?<p>Prueba otra búsqueda o usa «Limpiar filtros» arriba para ver más pedidos.</p>:<p>Usa «Nuevo pedido» en la barra para registrar lo acordado con el comprador. Una consulta no crea un pedido.</p>}</div>}
  {data&&data.records.length>0&&<div className="table-footer"><span>{start}–{end} de {data.total}</span><div><span>Página {data.page} de {maximum}</span><button type="button" className="button subtle" disabled={resource.loading||data.page<=1} onClick={()=>onViewChange({page:data.page-1})}>Anterior</button><button type="button" className="button subtle" disabled={resource.loading||data.page>=maximum} onClick={()=>onViewChange({page:data.page+1})}>Siguiente</button></div></div>}
 </section>;
}
