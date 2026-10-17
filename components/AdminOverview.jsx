'use client';
import { useEffect, useRef, useState } from 'react';
import { bogotaDate, addDays } from '@/lib/business/dates.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import PeriodPicker, { reportDateLabel } from './PeriodPicker';
import Icon from './Icons';
import { TaskDirectory } from './AdminNavigation';
import { adminTaskGroups } from './admin-tasks.mjs';

const ENDPOINT = '/api/admin/dashboard';
const SEVERITIES = { critical: 'Crítica', warning: 'Advertencia', info: 'Información' };
const AUTOMATION = { never: 'Sin ejecución registrada', running: 'Actualización automática activa', stale: 'Actualización automática detenida', error: 'La actualización automática informó un error', clock_skew: 'Reloj del proceso por revisar' };
const number = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });
function timestamp(value) {
  if (!value) return 'Sin dato';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return reportDateLabel(value);
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateTime.format(date) : 'Sin dato';
}
function sourceCutLabel(source){
  if(!source.sourceAsOf)return 'Sin dato';
  if(source.precision==='instant')return timestamp(source.sourceAsOf);
  return reportDateLabel(source.sourceDate||bogotaDate(source.sourceAsOf))+' · sin hora confirmada';
}
function valueLabel(value, unit) {
  if (value == null) return 'Sin dato';
  if (unit === 'minor') return formatMoneyMinor(value);
  if (unit === 'bps') return `${number.format(value / 100)} %`;
  return number.format(value);
}
function rangeLabel(bounds) {
  if (!bounds?.startDate || !bounds.endDateExclusive) return 'Sin rango disponible';
  return `${reportDateLabel(bounds.startDate)}–${reportDateLabel(addDays(bounds.endDateExclusive, -1))}`;
}
function Coverage({ metric }) {
  return <div className="home-coverage">
    <p>{metric.knownCount ?? 'Sin dato'} de {metric.eligibleCount ?? 'sin dato'} registros con datos{metric.excludedCount != null ? ` · ${metric.excludedCount} excluidos` : ''}</p>
    {(metric.exclusionReasons || []).length > 0 && <details><summary>Qué falta en esta cifra</summary><ul>{metric.exclusionReasons.map((reason, index) => <li key={index}>{typeof reason === 'string' ? reason : reason.label || reason.reason || 'Dato pendiente'}{reason?.count != null ? ` (${reason.count})` : ''}</li>)}</ul></details>}
  </div>;
}
function MetricCard({ title, metric, onDetails, onMissing }) {
  return <article className={`home-metric${metric.complete === false ? ' home-metric-partial' : ''}`}>
    <h2>{title}</h2>
    <p className="home-metric-value">{metric.value == null && metric.complete === false && metric.unit === 'minor' ? 'Por completar' : valueLabel(metric.value, metric.unit)}</p>
    {metric.complete === false && metric.knownValue != null && <p className="small">Subtotal conocido: <strong>{valueLabel(metric.knownValue, metric.unit)}</strong>; no es un resultado completo.</p>}
    {metric.unit === 'bps' && <p className="small">{metric.denominator ? `${metric.numerator} de ${metric.denominator} entregas elegibles` : 'Sin base de comparación'}</p>}
    <p className="small muted">{metric.unit === 'bps' ? 'Entregas efectivas dentro de la fecha estimada; requiere ambas fechas.' : title === 'Resultado operativo registrado' ? 'Ingresos y costos reconocidos, menos gastos registrados. No es utilidad neta después de impuestos.' : 'Productos reconocidos, netos de descuentos y créditos comerciales; no incluye flete ni equivale a cobros.'}</p>
    <Coverage metric={metric}/>
    <button type="button" className="text-button" onClick={onDetails}>Ver registros<span className="sr-only"> de {title.toLocaleLowerCase('es')}</span></button>
    {metric.complete === false && <button type="button" className="text-button" onClick={onMissing}>Completar datos<span className="sr-only"> de {title.toLocaleLowerCase('es')}</span></button>}
  </article>;
}
function InsightList({ title, items, onAction }) {
  if(!items.length)return null;
  return <section className="dashboard-card home-insights" aria-labelledby={title === 'Dónde mejorar' ? 'home-improvements' : 'home-successes'}>
    <h2 id={title === 'Dónde mejorar' ? 'home-improvements' : 'home-successes'}>{title}</h2>
    <ul>{items.slice(0, 3).map(item => <li key={item.id}>
      <h3>{item.title}</h3><p>{item.explanation}</p>
      {item.value != null && <p className="home-insight-value">{valueLabel(item.value, item.unit)}</p>}
      {item.evidence && <div className="small home-evidence">
        {item.evidence.currentValue != null && <p>Actual: {valueLabel(item.evidence.currentValue, item.unit)}{item.evidence.previousValue != null ? ` · Anterior: ${valueLabel(item.evidence.previousValue, item.unit)}` : ''}</p>}
        {item.evidence.numerator != null && item.evidence.denominator != null && <p>Base actual: {item.evidence.numerator} de {item.evidence.denominator}{item.evidence.previousDenominator != null ? ` · Anterior: ${item.evidence.previousNumerator} de ${item.evidence.previousDenominator}` : ''}</p>}
        {item.evidence.knownCount != null && item.evidence.eligibleCount != null && <p>Cobertura: {item.evidence.knownCount} de {item.evidence.eligibleCount} registros</p>}
        {item.evidence.startDate && item.evidence.endDateExclusive && <p>{rangeLabel(item.evidence)}</p>}
        {item.evidence.groups?.length > 0 && <ul aria-label="Grupos con contribución conocida">{item.evidence.groups.slice(0, 3).map(group => <li key={group.id}><strong>{group.label}</strong><p>Contribución: {valueLabel(group.contributionMinor, 'minor')} · {group.orderCount} pedidos · {group.units} unidades</p><p>Cobertura: {group.knownCount} de {group.eligibleCount} registros</p></li>)}</ul>}
      </div>}
      {item.action && <button type="button" className="text-button" onClick={() => onAction(item.action)}>{item.action.label}</button>}
    </li>)}</ul>
  </section>;
}
function EvidenceNotes({notes,onAction}){
  if(!notes.length)return null;
  const renderNote=note=><li key={note.id}><p>{note.text}</p>{note.action&&<button type="button" className="text-button" onClick={()=>onAction(note.action)}>{note.action.label}</button>}</li>;
  return <section className="home-evidence-notes" aria-label="Alcance de las observaciones"><h2>Qué falta para comparar</h2>
    <ul>{notes.slice(0,3).map(renderNote)}</ul>
    {notes.length>3&&<details><summary>Más criterios ({notes.length-3})</summary><ul>{notes.slice(3).map(renderNote)}</ul></details>}
  </section>;
}

export default function AdminOverview({ api, view, onViewChange, onCreateOrder, onImport, onCreateProduct, onConfigureCash, onNavigate, onOpenOrder, revision }) {
  const [resource, setResource] = useState({ key: '', data: null, loading: true, error: '' });
  const [retry, setRetry] = useState(0), [healthOpen, setHealthOpen] = useState(false);
  const sequence = useRef(0), errorRef = useRef(null), healthRef = useRef(null);
  const period = view.period || 'month', anchor = view.anchor || bogotaDate();
  const allAttention = view.issue === 'attention', page = view.page || 1;
  const params = new URLSearchParams({ period, anchor });
  if (allAttention) {
    params.set('issue', 'attention'); params.set('page', String(page));
    if (SEVERITIES[view.status]) params.set('status', view.status);
  }
  const endpoint = `${ENDPOINT}?${params}`;
  const data = resource.key === endpoint ? resource.data : null;
  const loading = resource.key !== endpoint || resource.loading;
  const error = resource.key === endpoint ? resource.error : '';
  useEffect(() => {
    const current = ++sequence.current;
    setResource(old => ({ key: endpoint, data: old.key === endpoint ? old.data : null, loading: true, error: '' }));
    api(endpoint).then(result => {
      if (sequence.current === current) setResource({ key: endpoint, data: result, loading: false, error: '' });
    }).catch(cause => {
      if (sequence.current === current) setResource(old => ({ ...old, loading: false, error: cause.message || 'No se pudo cargar el negocio.' }));
    });
    return () => { if (sequence.current === current) sequence.current++; };
  }, [api, endpoint, retry, revision]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);
  function change(patch) { onViewChange({ ...patch, page: 1 }); }
  function metricView(metric, missing = false) {
    onNavigate({ section: 'reports', tab: metric === 'onTimeDeliveries' ? 'shipping' : metric === 'operatingResult' ? 'costs' : 'sales', period, anchor, record: metric, ...(missing ? { issue: 'missing' } : {}) });
  }
  function action(action) {
    if (action.automation) {
      setHealthOpen(true);
      healthRef.current?.focus();
    } else if (action.orderId) onOpenOrder(action.orderId);
    else if (action.view) onNavigate(action.view);
  }
  const attention = data?.attention;
  const comparison = data?.insights?.comparison || data?.comparison;
  return <div className="home-workspace">
    <header className="admin-heading home-heading"><div><h1 tabIndex="-1" data-admin-section-heading>Tu negocio</h1>{data && <p className="small muted">Actualizado: {timestamp(data.generatedAt)} · Bogotá</p>}</div><div className="admin-actions"><button type="button" className="button primary" onClick={onCreateOrder}><Icon name="plus"/>Nuevo pedido</button><button type="button" className="button subtle" onClick={onImport}>Importar Excel</button></div></header>
    <details className="home-task-directory">
      <summary><span><strong>Todas las tareas</strong><small>Encuentra lo que necesitas por área, sin recorrer menús.</small></span><span className="task-directory-count">{adminTaskGroups.length} áreas</span></summary>
      <TaskDirectory view={view} onNavigate={onNavigate} />
    </details>
    <PeriodPicker period={period} anchor={anchor} onChange={change}/>
    <div aria-live="polite" aria-atomic="true">{loading && <p className="home-feedback" role="status">{data ? 'Actualizando. Los datos anteriores siguen visibles y pueden haber cambiado.' : 'Cargando datos del negocio…'}</p>}</div>
    {error && <div ref={errorRef} tabIndex="-1" className="home-feedback error" role="alert"><p>{error}</p>{data && <p>Datos anteriores; no se pudo confirmar su actualización.</p>}<button type="button" className="button subtle" onClick={() => setRetry(value => value + 1)}>Reintentar</button></div>}
    {!data && loading && <div className="static-skeleton" aria-hidden="true"/>}
    {data && <>
      {!allAttention && (data.empty ? <section className="dashboard-card home-empty" aria-labelledby="home-empty-heading"><h2 id="home-empty-heading">Empieza con registros reales</h2><p>Aún no hay actividad de negocio para mostrar cifras. Crea tus productos, importa pedidos o configura una cuenta con su saldo inicial.</p><div className="home-empty-actions"><button type="button" className="button primary" onClick={onCreateProduct}>Crear producto</button><button type="button" className="button subtle" onClick={onImport}>Importar Excel</button><button type="button" className="button subtle" onClick={onConfigureCash}>Configurar caja</button></div></section> : <section className="home-metrics" aria-label="Cifras del negocio" aria-busy={loading}>
        <MetricCard title="Ventas netas del período" metric={data.metrics.netProductSales} onDetails={() => metricView('netProductSales')} onMissing={() => metricView('netProductSales', true)}/>
        <MetricCard title="Resultado operativo registrado" metric={data.metrics.operatingResult} onDetails={() => metricView('operatingResult')} onMissing={() => metricView('operatingResult', true)}/>
        <article className="home-metric"><h2>Disponible ahora en caja/cuentas</h2><p className="home-metric-value">{valueLabel(data.cash.availableMinor, 'minor')}</p><p className="small">Fuera del período elegido · Al {timestamp(data.cash.asOf)}</p><p className="small muted">{data.cash.accountsCount} cuentas. No incluye recaudo retenido en plataforma.</p><button type="button" className="text-button" onClick={() => onNavigate({ section: 'reports', tab: 'cash', period: 'month', anchor: bogotaDate(), record: 'cashAvailable' })}>Ver movimientos del saldo</button>{data.cash.accountsCount === 0 && <button type="button" className="text-button" onClick={onConfigureCash}>Configurar caja</button>}</article>
        <MetricCard title="Entregas a tiempo" metric={data.metrics.onTimeDeliveries} onDetails={() => metricView('onTimeDeliveries')} onMissing={() => metricView('onTimeDeliveries', true)}/>
      </section>)}
      <section className="dashboard-card home-attention" aria-labelledby="home-attention-heading" aria-busy={loading}>
        <div className="home-section-heading"><h2 id="home-attention-heading">{allAttention ? 'Toda la atención pendiente' : 'Requiere atención'}</h2>{!allAttention && attention.total > 0 && <button type="button" className="text-button" onClick={() => change({ issue: 'attention', status: '' })}>Ver todas ({attention.total})</button>}</div>
        {allAttention && <div className="home-attention-controls"><label>Severidad<select value={SEVERITIES[view.status] ? view.status : ''} onChange={event => change({ status: event.target.value })}><option value="">Todas</option>{Object.entries(SEVERITIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{view.status && <button type="button" className="text-button" onClick={() => change({ status: '' })}>Limpiar filtro</button>}<button type="button" className="text-button" onClick={() => change({ issue: '', status: '' })}>Volver al resumen</button></div>}
        {attention.records.length ? <ul className="home-task-list">{(allAttention ? attention.records : attention.records.slice(0, 5)).map(task => <li key={task.id} className={`home-task home-task-${task.severity}`}>
          <div>
            <span className="home-task-severity">{SEVERITIES[task.severity] || task.severity}{task.kind === 'data' ? ' · Datos por completar' : ''}</span>
            <h3>{task.title}</h3><p>{task.reason}</p>
            {(task.count != null || task.amountMinor != null) && <p className="small">{task.count != null ? `${number.format(task.count)} registros` : ''}{task.count != null && task.amountMinor != null ? ' · ' : ''}{task.amountMinor != null ? formatMoneyMinor(task.amountMinor) : ''}</p>}
            <p className="small muted">Responsable: {task.responsibleName || 'Sin asignar'} · Desde {timestamp(task.firstSeenAt)}{task.state === 'acknowledged' ? ' · En atención' : ''}</p>
          </div>
          {task.action && <button type="button" className="button subtle" onClick={() => action(task.action)}>{task.action.label}</button>}
        </li>)}</ul> : <p>No hay tareas registradas{view.status ? ' con esta severidad' : ''}. La cobertura y el estado automático se muestran por separado; esto no confirma que todos los datos estén completos.</p>}
        {allAttention && attention.total > 0 && <nav className="home-pagination" aria-label="Páginas de atención"><button type="button" className="button subtle" disabled={loading || attention.page <= 1} onClick={() => onViewChange({ page: attention.page - 1 })}>Anterior</button><span>Página {attention.page} · {attention.total} tareas</span><button type="button" className="button subtle" disabled={loading || attention.page * attention.pageSize >= attention.total} onClick={() => onViewChange({ page: attention.page + 1 })}>Siguiente</button></nav>}
      </section>
      <details className="home-automation" open={healthOpen} onToggle={event => setHealthOpen(event.currentTarget.open)}><summary ref={healthRef}>{AUTOMATION[data.automation.status] || 'Estado automático desconocido'}</summary><dl><div><dt>Última señal del proceso</dt><dd>{timestamp(data.automation.lastHeartbeatAt)}</dd></div><div><dt>Comprobado</dt><dd>{timestamp(data.automation.checkedAt)}</dd></div><div><dt>Límite sin señal</dt><dd>{data.automation.staleAfterSeconds} segundos</dd></div>{data.automation.errorCode && <div><dt>Código registrado</dt><dd>{data.automation.errorCode}</dd></div>}</dl><p className="small">Esta señal acredita la actividad del proceso, no la frescura de los archivos de transporte. No inicia ni repara el servicio desde el navegador.</p>{data.sourceFreshness.length > 0 && <ul className="home-source-list">{data.sourceFreshness.map(source => <li key={source.sourceId}><strong>{source.platformName} · {source.sourceName}</strong><span>Corte de datos: {sourceCutLabel(source)}</span><span>Última importación: {timestamp(source.importedAt)}</span></li>)}</ul>}</details>
      {!allAttention && <>
        {!data.empty&&<>
        <section className="home-comparison" aria-label="Base de comparación"><h2>Lectura del período</h2>{comparison ? <><p><strong>{comparison.equivalent ? comparison.mode === 'elapsed' ? 'Mismo tramo de días completados' : 'Períodos completos equivalentes' : 'Comparación no equivalente'}</strong>{comparison.reason ? ` · ${comparison.reason}` : ''}</p>{comparison.currentBounds && <p className="small">Actual: {rangeLabel(comparison.currentBounds)}{comparison.previousBounds ? ` · Anterior: ${rangeLabel(comparison.previousBounds)}` : ''}</p>}</> : <p>No hay una comparación disponible para este corte.</p>}<p className="small muted">Datos al {timestamp(data.dataAsOf)}. Las tarjetas incluyen la actividad actual; una comparación abierta excluye el día sin completar.</p></section>
        {(data.insights.improvements.length>0||data.insights.successes.length>0)&&<div className="home-insight-columns"><InsightList title="Dónde mejorar" items={data.insights.improvements} onAction={action}/><InsightList title="Qué está funcionando" items={data.insights.successes} onAction={action}/></div>}
        <EvidenceNotes notes={data.insights.notes} onAction={action}/>
        </>}
        <details className="home-vitrina"><summary>Mi vitrina · {data.vitrina.launchApproved ? 'Publicación habilitada' : 'En preparación'}</summary><ul>{data.vitrina.counts.map(item => <li key={item.kind}><span>{item.label}: {item.total} registros · {item.drafts} borradores</span><button type="button" className="text-button" onClick={() => onNavigate({ section: item.kind, ...(item.drafts ? { status: 'draft' } : {}) })}>Revisar<span className="sr-only"> {item.label}</span></button></li>)}</ul>{data.vitrina.pending.length > 0 && <><h3>Contenido pendiente</h3><ul>{data.vitrina.pending.map(item => <li key={`${item.kind}:${item.id}`}><span>{item.title}</span><button type="button" className="text-button" onClick={() => onNavigate({ section: item.kind, record: item.id })}>Abrir<span className="sr-only"> {item.title}</span></button></li>)}</ul></>}<button type="button" className="text-button" onClick={() => onNavigate({ section: 'settings' })}>Revisar publicación</button></details>
      </>}
    </>}
  </div>;
}
