'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import PeriodPicker, { REPORT_PERIOD_LABELS, reportDateLabel } from './PeriodPicker';
import { addDays, bogotaDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './FinanceExperience.module.css';

const BASE = '/api/admin/reports';
const TABS = [['overview', 'Resumen'], ['sales', 'Ventas'], ['shipping', 'Envíos'], ['returns', 'Devoluciones'], ['costs', 'Costos'], ['payroll', 'Sueldos'], ['cash', 'Caja']];
const TAB_METRICS = {
  overview: ['netProductSales', 'operatingResult', 'contribution', 'cashAvailable', 'onTimeDeliveries', 'recognizedOrders'],
  sales: ['netProductSales', 'shippingRevenue', 'grossMargin', 'contribution', 'recognizedOrders', 'soldUnits', 'giftUnits'],
  shipping: ['shipmentCount', 'shippedOrders', 'onTimeDeliveries', 'shipmentReturnRate', 'transitDays', 'shippingCosts', 'platformFees'],
  returns: ['returnedUnits', 'cancelledUnits', 'shipmentReturnRate'],
  costs: ['costOfGoods', 'giftCost', 'shippingCosts', 'platformFees', 'commissions', 'fixedSalary', 'bonuses', 'otherExpenses', 'operatingResult'],
  payroll: ['payrollEarned', 'payrollPaid', 'payrollOutstanding', 'commissions', 'fixedSalary', 'bonuses'],
  cash: ['cashAvailable', 'customerCollections', 'platformPending', 'cashClosingDifference'],
};
const TAB_GUIDANCE = { overview: 'Una lectura conjunta de ventas, resultado, caja y entregas. Cada cifra permite consultar sus registros y exclusiones.', sales: 'Ventas reconocidas y composición por producto y vendedor históricos; no confundir con dinero cobrado.', shipping: 'Guías, fechas reales y cumplimiento de entregas. Los pedidos y los envíos se cuentan por separado.', returns: 'Devoluciones comerciales, cancelaciones y costos recuperados; los reembolsos de dinero son hechos separados.', costs: 'Costos y gastos devengados, sus pagos y saldos pendientes. La información desconocida no se convierte en cero.', payroll: 'Devengos, comisiones, anticipos y pagos por persona, sin duplicar costos.', cash: 'Saldos al corte y movimientos de cuentas. El dinero pendiente en plataforma se presenta por separado.' };
const METRICS = new Set(Object.values(TAB_METRICS).flat());
const FILTER_KEYS = ['seller', 'product', 'platform', 'carrier', 'status', 'account'];
const STATUSES = { new: 'Nuevo', preparing: 'Por preparar', sent: 'Enviado', label_created: 'Guía creada', collected: 'Recogido', in_transit: 'En tránsito', out_for_delivery: 'En reparto', delivered: 'Entregado', incident: 'Con novedad', return_in_transit: 'En devolución', returned: 'Devuelto', cancelled: 'Cancelado', unknown: 'Desconocido' };
const SNAPSHOT_STATES = { current: 'Vigente', superseded: 'Reemplazado por una revisión posterior', stale: 'Hay información nueva' };
const CATEGORIES = { shipping_out: 'Transporte de ida', shipping_return: 'Transporte de retorno', platform_fee: 'Cargo de plataforma', commission: 'Comisión', salary: 'Sueldo fijo', bonus: 'Bonificación', other: 'Otros gastos' };
const number = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });
const records = data => Array.isArray(data) ? data : data?.records || [];
const money = value => value == null ? 'Sin dato' : formatMoneyMinor(value);
function timestamp(value) { if (!value) return 'Sin dato'; const date = new Date(value); return Number.isFinite(date.getTime()) ? dateTime.format(date) : 'Sin dato'; }
function valueLabel(value, unit) {
  if (value == null) return 'Sin dato';
  if (unit === 'minor') return money(value);
  if (unit === 'bps') return `${number.format(value / 100)} %`;
  return `${number.format(value)}${unit === 'days' ? ' días' : ''}`;
}
function reasonLabel(reason) { return typeof reason === 'string' ? reason : reason?.label || reason?.reason || 'Dato pendiente de completar'; }
function queryParams(view) {
  const params = new URLSearchParams({ period: view.period || 'month', anchor: view.anchor || bogotaDate() });
  FILTER_KEYS.forEach(key => { if (view[key]) params.set(key, view[key]); });
  return params;
}
function PageControls({ data, onChange, disabled = false }) {
  if (!data || !data.total) return null;
  const page = data.page || 1, size = data.pageSize || 20;
  return <nav className="report-pagination" aria-label="Páginas de registros"><button className="button subtle" type="button" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>Anterior</button><span>{(page - 1) * size + 1}–{Math.min(page * size, data.total)} de {data.total} · Página {page}</span><button className="button subtle" type="button" disabled={disabled || page * size >= data.total} onClick={() => onChange(page + 1)}>Siguiente</button></nav>;
}
function DataTable({ caption, columns, data, onPage, loading }) {
  if (!data || !records(data).length) return <section className="report-group"><h3>{caption}</h3><p className="muted">No hay registros para esta página, período y filtros.</p><PageControls data={data} onChange={onPage} disabled={loading}/></section>;
  return <section className="report-group"><table className="report-table"><caption>{caption}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{records(data).map((row, index) => <tr key={row.id || index}>{columns.map(column => <td key={column.key} data-label={column.label}>{column.render ? column.render(row) : row[column.key] ?? 'Sin dato'}</td>)}</tr>)}</tbody></table><PageControls data={data} onChange={onPage} disabled={loading}/></section>;
}
function Coverage({ metric }) {
  return <div className="report-coverage"><strong className={styles.coverageLabel}>{metric.complete?'Cobertura completa':'Cobertura parcial'}</strong><span>{metric.knownCount ?? 0} de {metric.eligibleCount ?? 0} registros con datos · {metric.excludedCount ?? 0} excluidos</span>{(metric.exclusionReasons || []).length > 0 && <ul>{metric.exclusionReasons.map((reason, index) => <li key={index}>{reasonLabel(reason)}{reason?.count != null ? ` (${reason.count})` : ''}</li>)}</ul>}</div>;
}
function MetricCard({ metric, onDetails }) {
  return <article className={`report-metric${metric.complete ? '' : ' report-metric-partial'}`}><h3>{metric.label}</h3><p className="report-metric-value">{metric.value == null && metric.unit === 'minor' && !metric.complete ? 'Por completar' : valueLabel(metric.value, metric.unit)}</p>{!metric.complete && metric.knownValue != null && <p className="small">Subtotal conocido: <strong>{valueLabel(metric.knownValue, metric.unit)}</strong></p>}{metric.unit === 'bps' && <p className="small">{metric.denominator ? `${metric.numerator} de ${metric.denominator}` : 'Sin base de comparación'}</p>}<Coverage metric={metric}/><button className="text-button" type="button" onClick={onDetails}>Ver registros de {metric.label.toLocaleLowerCase('es')}</button></article>;
}

function ReportFilters({ api, view, onChange, options, readOnly = false }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError('');
    Promise.all([api('/api/admin/business/people'), api('/api/admin/products'), api('/api/admin/combos'), api('/api/admin/business/platforms'), api('/api/admin/business/accounts')]).then(([people, products, combos, platforms, accounts]) => {
      if (active) setData({ seller: records(people), product: [...records(products), ...records(combos).map(row => ({ ...row, reportCombo: true }))], platform: records(platforms), account: records(accounts) });
    }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, open, attempt]);
  const activeFilters = FILTER_KEYS.filter(key => view[key]);
  function choices(key) {
    let rows = data?.[key] || [];
    return rows.map(row => ({ value: row.id, label: `${row.name || row.title}${row.presentation ? ` · ${row.presentation}` : ''}${row.reportCombo ? ' (combo)' : ''}${row.active === false ? ' (archivado)' : ''}` }));
  }
  function select(key, label, values) {
    const options = [{ value: '', label: 'Todos' }, ...values];
    if (view[key] && !options.some(option => option.value === view[key])) options.push({ value: view[key], label: `Selección guardada (${view[key]})` });
    return <Field key={key} field={{ name: `${id}-${key}`, label, type: 'select', options }} value={view[key] || ''} onChange={value => onChange?.({ [key]: value })}/>;
  }
  return <details className="report-filters" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{readOnly ? 'Filtros de esta revisión (solo lectura)' : 'Filtros compartidos'}{activeFilters.length ? ` (${activeFilters.length} activos)` : ''}</summary><p className="small muted">Se aplican según el registro: el estado comercial filtra ventas; el estado de la guía filtra envíos. Cuenta solo aplica a caja y pagos. Los nombres del selector son actuales; la agrupación del informe conserva los nombres históricos.</p>{loading && <p role="status">Cargando opciones reales…</p>}{error && <p className="error" role="alert">{error} <button className="text-button" type="button" onClick={() => setAttempt(value => value + 1)}>Reintentar opciones</button></p>}{data && <fieldset className="report-filter-grid" disabled={readOnly}><legend>Criterios de selección</legend>{select('seller', 'Vendedor', choices('seller'))}{select('product', 'Producto u obsequio / combo', choices('product'))}{select('platform', 'Plataforma', choices('platform'))}{select('account', 'Cuenta de caja o banco', choices('account'))}{select('carrier', 'Transportadora', options?.carriers || [])}{select('status', 'Estado (según registro)', (options?.statuses || []).map(option => ({ ...option, label: STATUSES[option.value] || option.label })))}</fieldset>}{!readOnly && activeFilters.length > 0 && <button className="text-button" type="button" onClick={() => onChange(Object.fromEntries(FILTER_KEYS.map(key => [key, ''])))}>Limpiar filtros</button>}</details>;
}

export default function ReportsWorkspace({ api, view, onViewChange, onOpenOrder, onInteractionStateChange, onMutation, revision }) {
  const [mode, setMode] = useState(view.record && !METRICS.has(view.record) ? 'saved' : 'live');
  const [savedMetric, setSavedMetric] = useState(''), [resource, setResource] = useState({}), [retry, setRetry] = useState(0), [busy, setBusy] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(null), [pollError, setPollError] = useState(''), [pollRetry, setPollRetry] = useState(0);
  const headingRef = useRef(null), detailRef = useRef(null), errorRef = useRef(null), opener = useRef(null), request = useRef(null), mounted = useRef(true), filterOptions = useRef(null), failedAction = useRef('');
  const period = view.period || 'month', anchor = view.anchor || bogotaDate(), tab = TABS.some(([key]) => key === view.tab) ? view.tab : 'overview', page = view.page || 1;
  const params = queryParams(view), query = params.toString();
  const snapshotId = view.record && !METRICS.has(view.record) ? view.record : '';
  const metricKey = snapshotId ? savedMetric : METRICS.has(view.record) ? view.record : '';
  const activeMode = snapshotId ? 'saved' : mode;
  const detailParams=new URLSearchParams({page:String(page),...(metricKey?{metric:metricKey}:{}),...(view.issue&&metricKey?{issue:view.issue}:{})});
  const endpoint = snapshotId ? `${BASE}/${encodeURIComponent(snapshotId)}?${detailParams}` : `${BASE}?${query}&mode=${activeMode}&${detailParams}`;
  const data = resource.key === endpoint ? resource.data : null;
  const loading = resource.key !== endpoint || resource.loading;
  const error = resource.key === endpoint ? resource.error : '';
  const report = activeMode === 'live' || snapshotId ? data : null;
  const detailMetric=report?.details?.metricSummary||report?.metrics?.[metricKey];
  if (data?.filterOptions) filterOptions.current = data.filterOptions;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onInteractionStateChange?.({ busy: !!busy, dirty: false }); return () => onInteractionStateChange?.({ busy: false, dirty: false }); }, [busy, onInteractionStateChange]);
  useEffect(() => {
    let active = true;
    setResource(old => ({ key: endpoint, data: old.key === endpoint ? old.data : null, loading: true, error: '' }));
    api(endpoint).then(result => { if (active) setResource({ key: endpoint, data: result, loading: false, error: '' }); }).catch(cause => { if (active) setResource(old => ({ ...old, loading: false, error: cause.message })); });
    return () => { active = false; };
  }, [api, endpoint, retry, revision]);
  useEffect(() => {
    if (activeMode === 'saved' && !snapshotId && data?.job && ['queued', 'running'].includes(data.job.state)) {
      setPending(current => current || { jobKey: data.job.key, query, period, anchorDate: anchor });
    }
  }, [activeMode, snapshotId, data, query, period, anchor]);
  useEffect(() => { if (actionError || error || pollError) errorRef.current?.focus({ preventScroll: true }); }, [actionError, error, pollError]);
  useEffect(() => { if (metricKey && !loading) detailRef.current?.focus({ preventScroll: true }); }, [metricKey, loading]);
  useEffect(() => {
    if (!pending || pollError) return;
    let active = true, timer;
    async function poll() {
      try {
        const result = await api(`${BASE}?${pending.query}&mode=saved&page=1`);
        if (!active) return;
        if (result.job?.key === pending.jobKey && result.job.state === 'failed') { setPollError('No se pudo generar el informe. Revisa el estado del trabajo y vuelve a solicitarlo.'); return; }
        if (result.job?.key === pending.jobKey && result.job.state === 'succeeded') {
          setPending(null); setNotice('El proceso del servidor terminó. Consulta el informe guardado; si los hechos no cambiaron, se conserva la misma revisión.'); setRetry(value => value + 1); return;
        }
        timer = setTimeout(poll, 4000);
      } catch (cause) { if (active) setPollError(cause.message); }
    }
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [api, pending, pollError, pollRetry]);
  function change(patch) { setSavedMetric(''); setActionError(''); onViewChange({ ...patch, page: 1, record: '',issue:'' }); }
  function openDetails(key,issue='') { opener.current = document.activeElement; if (snapshotId) { setSavedMetric(key); onViewChange({ page: 1,issue }); } else onViewChange({ record: key, page: 1,issue }); }
  function closeDetails() { if (snapshotId) { setSavedMetric(''); onViewChange({ page: 1,issue:'' }); } else onViewChange({ record: '', page: 1,issue:'' }); requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); else headingRef.current?.focus(); }); }
  function switchMode(next) { setMode(next); change({}); }
  async function generate() {
    if (busy) return;
    setBusy('save'); failedAction.current = 'save'; setActionError(''); setNotice('');
    if (!request.current || request.current.query !== query) request.current = { query, requestId: crypto.randomUUID() };
    try {
      const result = await api(BASE, { method: 'POST', body: JSON.stringify({ period, anchorDate: anchor, filters: Object.fromEntries(FILTER_KEYS.filter(key => view[key]).map(key => [key, view[key]])), requestId: request.current.requestId }) });
      if (!mounted.current) return;
      setPending({ ...result, query }); setPollError(''); setNotice('Solicitud aceptada. El proceso automático del servidor generará el informe; puedes seguir trabajando.'); request.current = null;
      onMutation?.({ type: 'report', state: result.state, jobKey: result.jobKey });
    } catch (cause) { if (mounted.current) setActionError(cause.message); } finally { if (mounted.current) setBusy(''); }
  }
  async function download() {
    if (busy) return;
    setBusy('download'); failedAction.current = 'download'; setActionError('');
    try {
      const blob = await api(`${BASE}/export?${snapshotId ? new URLSearchParams({ snapshot: snapshotId }) : query}`, { responseType: 'blob' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      try { link.href = url; link.download = `informe-${snapshotId ? `revision-${report?.snapshot?.revision || ''}` : period}-${report?.bounds?.startDate || anchor}.xlsx`; document.body.appendChild(link); link.click(); link.remove(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (cause) { if (mounted.current) setActionError(cause.message); } finally { if (mounted.current) setBusy(''); }
  }
  function orderLink(row) { const number=row.orderNumber == null?'':`AN-${String(row.orderNumber).padStart(6,'0')}`;return row.orderId ? <button className="text-button" type="button" aria-label={`Abrir pedido${number?' '+number:''}`} onClick={() => onOpenOrder(row.orderId)}>{number||'Abrir pedido'}</button> : 'Sin pedido vinculado'; }
  const amountColumn = (key, label) => ({ key, label, render: row => money(row[key]) });
  const partialAmountColumn = (key, knownKey, label) => ({ key, label, render: row => row[key] == null || row.complete === false ? <>Por completar{row[knownKey] != null && <><br/><small>Subtotal conocido: {money(row[knownKey])}</small></>}</> : money(row[key]) });
  const dateColumn = (key, label) => ({ key, label, render: row => reportDateLabel(row[key]) });
  const orderColumn = { key: 'orderId', label: 'Pedido', render: orderLink };
  const contributionColumn = { key: 'contributionMinor', label: 'Contribución conocida', render: row => <>{money(row.contributionMinor)}{!row.complete && <><br/><small>Parcial · subtotal conocido {money(row.knownContributionMinor)} · {row.knownCount ?? 0}/{row.eligibleCount ?? 0} registros</small></>}</> };
  const groupTable = (key, caption, columns) => <DataTable key={key} caption={caption} columns={columns} data={report?.groups?.[key]} onPage={next => onViewChange({ page: next })} loading={loading}/>;
  return <section className={`reports-workspace ${styles.workspace}`} aria-label="Informes del negocio" onKeyDown={event => { if (event.key === 'Escape' && metricKey) { event.preventDefault(); event.stopPropagation(); closeDetails(); } }}>
    <header className="admin-heading"><div><h1 ref={headingRef} tabIndex={-1} data-admin-section-heading>Informes</h1><p className="small muted">Cifras registradas y su cobertura · COP</p></div><div className="admin-actions"><button className="button subtle" type="button" title={metricKey?'Exporta el informe completo, no solo el detalle abierto.':undefined} disabled={!!busy || !report || loading} onClick={download}>{busy === 'download' ? 'Descargando…' : 'Exportar XLSX'}</button><button className="button primary" type="button" disabled={!!busy || !!pending || !!snapshotId} onClick={generate}>{busy === 'save' ? 'Solicitando…' : 'Guardar informe'}</button></div></header>
    <section className={styles.queryPanel} aria-label="Consulta del informe"><div className="report-mode" role="group" aria-label="Origen del informe"><button className={`button ${activeMode === 'live' ? 'primary' : 'subtle'}`} type="button" aria-pressed={activeMode === 'live'} onClick={() => switchMode('live')}>En vivo</button><button className={`button ${activeMode === 'saved' ? 'primary' : 'subtle'}`} type="button" aria-pressed={activeMode === 'saved'} onClick={() => switchMode('saved')}>Guardados</button></div><p className={styles.queryHelp}>{snapshotId?'Revisión histórica: las cifras, los hechos y los filtros son de solo lectura.':activeMode==='saved'?'Consulta revisiones inmutables del período. Guardar informe solicita al servidor una revisión; no modifica los hechos.':'Consulta los hechos registrados para el período y filtros elegidos, sin guardar una revisión.'} Exportar XLSX descarga el informe completo, con detalle y definiciones.</p>
    {!snapshotId && <><PeriodPicker period={period} anchor={anchor} onChange={({ period, anchor }) => change({ period, anchor })}/><ReportFilters api={api} view={view} onChange={change} options={filterOptions.current}/></>}</section>
    {(actionError || error || pollError) && <div className="report-feedback error" role="alert" ref={errorRef} tabIndex={-1}>{actionError && <p>{actionError} <button className="text-button" type="button" disabled={!!busy} onClick={failedAction.current === 'download' ? download : generate}>Reintentar {failedAction.current === 'download' ? 'descarga' : 'solicitud'}</button></p>}{error && <p>{error} <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>Reintentar carga</button></p>}{pollError && <p>{pollError} <button className="text-button" type="button" onClick={() => { setPollError(''); setPollRetry(value => value + 1); }}>Consultar trabajo de nuevo</button><button className="text-button" type="button" onClick={() => { setPending(null); setPollError(''); setNotice('Puedes volver a solicitar la generación; no se han modificado las cifras guardadas.'); }}>Volver a solicitar</button></p>}</div>}
    {notice && <p className="report-feedback" role="status">{notice}</p>}
    {pending && <p className="report-feedback" role="status">Generación pendiente del proceso automático: {REPORT_PERIOD_LABELS[pending.period || period]} · {reportDateLabel(pending.anchorDate || anchor)}. No se calcula en este navegador. <button className="text-button" type="button" onClick={() => switchMode('saved')}>Consultar guardados</button></p>}
    {loading && <p role="status">{data ? 'Actualizando; se muestran los datos de la consulta anterior hasta completar la lectura.' : 'Cargando informe…'}</p>}
    {activeMode === 'saved' && !snapshotId && data && <><p className="muted">Cada revisión conserva sus cifras y sus registros originales. Actualizar crea una revisión nueva solo si cambiaron los hechos.</p><DataTable caption="Informes guardados" data={data} loading={loading} onPage={next => onViewChange({ page: next })} columns={[{ key: 'period', label: 'Período', render: row => <button type="button" className="text-button" onClick={() => { setSavedMetric(''); onViewChange({ record: row.id, page: 1 }); }}>{REPORT_PERIOD_LABELS[row.period] || row.period} · {reportDateLabel(row.startOn)} al {reportDateLabel(addDays(row.endOnExclusive, -1))}</button> }, { key: 'revision', label: 'Revisión' }, { key: 'state', label: 'Estado', render: row => SNAPSHOT_STATES[row.state] || 'Sin estado' }, { key: 'generatedAt', label: 'Generado (Bogotá)', render: row => timestamp(row.generatedAt) }, { key: 'coverage', label: 'Cobertura', render: row => row.coverage?.pending?.length ? <ul>{row.coverage.pending.map((item, index) => <li key={index}>{item.label} ({item.count})</li>)}</ul> : 'Sin pendientes informados' }]}/></>}
    {report && <>
      {snapshotId && <div className="report-feedback"><button type="button" className="text-button" onClick={() => { setMode('saved'); setSavedMetric(''); onViewChange({ record: '', page: 1 }); }}>Volver a informes guardados</button><h3>Informe guardado · Revisión {report.snapshot?.revision}</h3><p>{SNAPSHOT_STATES[report.snapshot?.state] || 'Informe histórico'} · Cifras y hechos inmutables.</p>{report.snapshot?.staleSince && <p>Información nueva desde {timestamp(report.snapshot.staleSince)}.</p>}<button type="button" className="text-button" onClick={() => { setMode('live'); change({ period: report.query.period, anchor: report.query.anchorDate, ...Object.fromEntries(FILTER_KEYS.map(key => [key, report.query.filters?.[key] || ''])) }); }}>Consultar este período en vivo para actualizar</button></div>}
      {snapshotId && <ReportFilters key={snapshotId} api={api} view={report.query.filters || {}} options={report.filterOptions} readOnly/>}
      <div className="report-dates">{snapshotId&&<strong>{reportDateLabel(report.bounds.startDate)} al {reportDateLabel(addDays(report.bounds.endDateExclusive, -1))}</strong>}<span>{report.closed ? 'Período cerrado' : 'Período abierto'}</span><span>Corte de datos: {timestamp(report.dataAsOf)} · Bogotá</span></div>
      {report.empty && <div className="report-feedback"><h3>No hay hechos para esta consulta</h3><p>Prueba otro período o revisa los filtros. Los registros sin fechas o costos se muestran como pendientes; no se inventan ventas ni ganancias.</p></div>}
      {(report.coverage?.pending || []).length > 0 && <details className="report-pending"><summary>Datos por completar ({report.coverage.pending.length} conceptos)</summary><ul>{report.coverage.pending.map((item, index) => <li key={`${item.code}-${index}`}>{item.label}: <strong>{item.count}</strong>{item.detailsQuery?.metric && <button type="button" className="text-button" onClick={() => openDetails(item.detailsQuery.metric,'missing')}>Ver registros pendientes</button>}</li>)}</ul></details>}
      <nav className="report-tabs" aria-label="Áreas del informe">{TABS.map(([key, label]) => <button type="button" key={key} className={`button ${tab === key ? 'primary' : 'subtle'}`} aria-current={tab === key ? 'page' : undefined} onClick={() => { setSavedMetric(''); onViewChange({ tab: key, page: 1, record: snapshotId || '',issue:'' }); }}>{label}</button>)}</nav>
      {!metricKey && <>
        <header className={styles.contextHeading}><h2>{TABS.find(([key])=>key===tab)?.[1]} · lectura del período</h2><p>{TAB_GUIDANCE[tab]}</p></header>
        <div className="report-metrics">{TAB_METRICS[tab].filter(key => report.metrics?.[key]).map(key => <MetricCard key={key} metric={report.metrics[key]} onDetails={() => openDetails(key)}/>)}</div>
        {tab === 'sales' && ['products', 'sellers'].map(key => groupTable(key, key === 'products' ? 'Por producto histórico' : 'Por vendedor histórico', [{ key: 'label', label: key === 'products' ? 'Producto' : 'Vendedor' }, { key: 'orderCount', label: 'Pedidos' }, { key: 'units', label: 'Unidades' }, amountColumn('netSalesMinor', 'Venta neta de productos'), contributionColumn]))}
        {tab === 'shipping' && groupTable('shipments', 'Guías y fechas reales (los pedidos se cuentan por separado)', [orderColumn, { key: 'tracking', label: 'Guía', render: row => row.tracking || 'Sin guía' }, { key: 'carrier', label: 'Transportadora' }, { key: 'status', label: 'Estado', render: row => STATUSES[row.status] || row.status }, dateColumn('labelCreatedOn', 'Creación'), dateColumn('collectedOn', 'Recogida'), dateColumn('deliveredOn', 'Entrega'), dateColumn('returnedOn', 'Retorno'), dateColumn('estimatedDeliveryOn', 'Estimada'), { key: 'transitDays', label: 'Tránsito', render: row => valueLabel(row.transitDays, 'days') }])}
        {tab === 'returns' && groupTable('returns', 'Devoluciones y cancelaciones comerciales (no reembolsos)', [orderColumn, dateColumn('occurredOn', 'Fecha'), { key: 'reason', label: 'Motivo' }, { key: 'quantity', label: 'Unidades' }, amountColumn('salesCreditMinor', 'Crédito productos'), amountColumn('shippingCreditMinor', 'Crédito flete'), amountColumn('recoveredCostMinor', 'Costo recuperado')])}
        {tab === 'costs' && groupTable('costs', 'Gastos registrados; las fechas desconocidas permanecen pendientes', [{ key: 'label', label: 'Concepto' }, { key: 'category', label: 'Categoría', render: row => CATEGORIES[row.category] || row.category }, orderColumn, dateColumn('occurredOn', 'Ocurrencia'), amountColumn('amountMinor', 'Devengado'), amountColumn('paidMinor', 'Pagado'), amountColumn('outstandingMinor', 'Pendiente'), amountColumn('creditMinor', 'Crédito por conciliar')])}
        {tab === 'payroll' && <><p className="small muted">El devengo ya está incluido en el resultado una sola vez. Pagos y anticipos afectan caja y deuda, no generan otro costo.</p>{groupTable('payroll', 'Devengos, pagos y saldos por persona', [{ key: 'label', label: 'Persona' }, partialAmountColumn('earnedMinor', 'knownEarnedMinor', 'Devengado'), amountColumn('paidMinor', 'Pagado'), partialAmountColumn('outstandingMinor', 'knownOutstandingMinor', 'Pendiente'), amountColumn('advanceMinor', 'Anticipos'), amountColumn('creditMinor', 'Crédito por compensar')])}</>}
        {tab === 'cash' && <><p className="small muted">Saldo al corte del informe, no necesariamente disponible ahora. El recaudo retenido en plataforma se informa aparte. Aperturas y transferencias no son ventas.</p>{groupTable('accounts', 'Saldos y movimientos por cuenta', [{ key: 'label', label: 'Cuenta' }, amountColumn('openingMinor', 'Saldo al inicio'), amountColumn('openingEntriesMinor', 'Aperturas del período'), amountColumn('inflowMinor', 'Entradas'), amountColumn('outflowMinor', 'Salidas'), amountColumn('transferMinor', 'Transferencias netas'), amountColumn('balanceMinor', 'Saldo al corte')])}</>}
      </>}
      {metricKey && <section className="report-detail" aria-label="Registros exactos de la métrica">
        <div className="admin-heading"><h3 ref={detailRef} tabIndex={-1}>{detailMetric?.label || 'Registros de cobertura'}</h3><button type="button" className="button subtle" onClick={closeDetails}>Cerrar detalle</button></div>
        {detailMetric && <><p><strong>Total: {valueLabel(detailMetric.value, detailMetric.unit)}</strong></p>{!detailMetric.complete && detailMetric.knownValue != null && <p>Subtotal conocido: {valueLabel(detailMetric.knownValue, detailMetric.unit)} · Cifra parcial</p>}<Coverage metric={detailMetric}/></>}
        {report.details?.bounds&&<p className="small"><strong>Tramo comparado: {reportDateLabel(report.details.bounds.startDate)} al {reportDateLabel(addDays(report.details.bounds.endDateExclusive,-1))}</strong>. El día abierto no entra en esta comparación.</p>}
        <p className="small muted">{view.issue?'Subconjunto exacto de la observación seleccionada; mismos filtros.':'Mismos filtros y fechas del informe. Incluye los registros excluidos y su motivo.'} Hasta 20 registros por página. La exportación conserva el informe completo.</p>
        {report.details ? <DataTable caption="Registros que explican la cifra" data={report.details} loading={loading} onPage={next => onViewChange({ page: next })} columns={[{ key: 'label', label: 'Registro' }, orderColumn, { key: 'tracking', label: 'Guía', render: row => row.tracking || 'No aplica' }, dateColumn('occurredOn', 'Fecha del hecho'), { key: 'value', label: 'Importe / valor', render: row => valueLabel(row.value, row.unit) }, { key: 'reason', label: 'Cobertura', render: row => row.known === false ? `Excluido: ${row.reason || 'Dato desconocido'}` : row.reason || 'Incluido' }]}/> : loading ? <p role="status">Cargando registros…</p> : <p className="error" role="alert">No se recibieron los registros de esta métrica. <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>Reintentar detalle</button></p>}
      </section>}
      <details className="report-sources"><summary>Cortes y últimas importaciones por plataforma</summary>{report.lastImportAt?.length ? <ul>{report.lastImportAt.map(source => <li key={source.sourceId || source.platformId}><strong>{source.platformName} · {source.sourceName}</strong><br/>Corte del origen: {source.precision === 'instant' ? timestamp(source.sourceAsOf) : source.sourceAsOf ? `${reportDateLabel(source.sourceDate || bogotaDate(source.sourceAsOf))} · sin hora confirmada` : 'Sin dato'}<br/>Importado: {timestamp(source.importedAt)} (Bogotá)</li>)}</ul> : <p className="muted">No hay importaciones de plataforma registradas. Las operaciones manuales no tienen un corte de archivo ficticio.</p>}</details>
      <details className="report-definitions"><summary>Definiciones, criterios y reglas del informe</summary>
        <p className="small muted">Calculado: {timestamp(report.generatedAt)} · Fechas comerciales America/Bogota, inicio incluido y fin excluido. La exportación incluye Resumen, Detalle y Definiciones. Sin dato no equivale a cero.</p>
        <p className="small muted">El resultado operativo registrado no es utilidad neta después de impuestos. El acumulado de un pedido puede incluir hechos de otros períodos.</p>
        <dl>{(report.definitions || []).map((definition, index) => <div key={definition.key || index}><dt>{definition.label}</dt><dd>{definition.formula}</dd>{definition.criteria && <dd>{Array.isArray(definition.criteria) ? definition.criteria.join(' · ') : definition.criteria}</dd>}</div>)}</dl>
      </details>
    </>}
  </section>;
}
