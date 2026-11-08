'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import PeriodPicker, { REPORT_PERIOD_LABELS, reportDateLabel } from './PeriodPicker';
import WorkspaceTabs from './WorkspaceTabs';
import ReportsGuide from './ReportsGuide';
import { orderStates, shipmentStates } from '@/lib/schema.mjs';
import { addDays, bogotaDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './FinanceExperience.module.css';

const BASE = '/api/admin/reports';
const TABS = [['overview', 'Resumen'], ['sales', 'Ventas'], ['shipping', 'Envíos'], ['returns', 'Devoluciones'], ['costs', 'Costos'], ['payroll', 'Sueldos'], ['cash', 'Caja']];
const tabItems = TABS.map(([id, label]) => ({ id, label }));
const TAB_METRICS = {
  overview: ['netProductSales', 'operatingResult', 'contribution', 'cashAvailable', 'onTimeDeliveries', 'recognizedOrders'],
  sales: ['netProductSales', 'shippingRevenue', 'grossMargin', 'contribution', 'recognizedOrders', 'soldUnits', 'giftUnits'],
  shipping: ['shipmentCount', 'shippedOrders', 'onTimeDeliveries', 'shipmentReturnRate', 'transitDays', 'shippingCosts', 'platformFees'],
  returns: ['returnedUnits', 'cancelledUnits', 'shipmentReturnRate'],
  costs: ['costOfGoods', 'giftCost', 'shippingCosts', 'platformFees', 'commissions', 'fixedSalary', 'bonuses', 'advertisingExpenses', 'operatingExpenses', 'otherExpenses', 'operatingResult'],
  payroll: ['payrollEarned', 'payrollPaid', 'payrollOutstanding', 'commissions', 'fixedSalary', 'bonuses'],
  cash: ['cashAvailable', 'customerCollections', 'platformPending', 'cashClosingDifference'],
};
const TAB_GUIDANCE = {
  overview: 'Revisa ventas, resultado, dinero en cuentas y entregas. Son cifras distintas: vender no significa haber cobrado.',
  sales: 'Consulta las ventas que cuentan según la regla de cada pedido y cómo se reparten por producto y vendedor. No son necesariamente cobros recibidos.',
  shipping: 'Revisa guías, fechas y entregas. Un pedido puede tener varios envíos; las entregas sin fechas suficientes quedan pendientes de evaluar.',
  returns: 'Consulta productos devueltos o cancelados y costos recuperados. Devolver mercancía y devolver dinero son operaciones distintas.',
  costs: 'Revisa cuánto se ha generado en costos y gastos, cuánto se pagó y qué falta por pagar. Un costo desconocido no es cero.',
  payroll: 'Distingue lo generado por sueldos y comisiones, lo pagado y lo pendiente. Un pago no genera un segundo gasto.',
  cash: 'Consulta el dinero registrado en cuentas a la fecha de corte. El dinero retenido por plataformas se muestra aparte; este saldo puede ser distinto del disponible ahora.',
};
const METRICS = new Set(Object.values(TAB_METRICS).flat());
const METRIC_HELP = {
  recognizedOrders: 'Pedidos que cuentan como venta según su regla histórica; no significa que estén cobrados',
  grossMargin: 'Ventas netas de productos menos el costo de esos productos',
  contribution: 'Lo que queda después de productos, obsequios, transporte, cargos de plataforma y comisiones; todavía faltan otros gastos',
  operatingResult: 'Resultado de los ingresos y gastos registrados. No es el dinero disponible ni la utilidad final después de impuestos',
  payrollEarned: 'Obligaciones generadas por sueldos, comisiones y bonificaciones, aunque no se hayan pagado',
  payrollOutstanding: 'Lo generado que queda por pagar al corte, después de pagos y compensaciones',
};
const FILTER_KEYS = ['seller', 'product', 'platform', 'carrier', 'status', 'account'];
const FILTER_LABELS = { seller: 'Vendedor', product: 'Producto u obsequio / combo', platform: 'Plataforma', carrier: 'Transportadora', status: 'Estado', account: 'Cuenta de caja o banco' };
const STATUSES = Object.fromEntries([...orderStates, ...shipmentStates].map(({ value, label }) => [value, label]));
const SNAPSHOT_STATES = { current: 'Última versión guardada', superseded: 'Versión anterior', stale: 'Hay datos nuevos' };
const CATEGORIES = { shipping_out: 'Transporte de ida', shipping_return: 'Transporte de retorno', shipping_insurance: 'Seguro de envío', platform_fee: 'Cargo de plataforma', commission: 'Comisión', salary: 'Sueldo fijo', bonus: 'Bonificación', advertising:'Publicidad', operating:'Operación', other: 'Otros gastos' };
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
function DataTable({ caption, columns, data, onPage, loading, emptyState }) {
  if (!data || !records(data).length) return <section className="report-group"><h3>{caption}</h3>{emptyState ?? <><p className="muted">No hay registros para esta página, período y filtros.</p><PageControls data={data} onChange={onPage} disabled={loading}/></>}</section>;
  return <section className="report-group"><table className="report-table"><caption>{caption}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{records(data).map((row, index) => <tr key={row.id || index}>{columns.map(column => <td key={column.key} data-label={column.label}>{column.render ? column.render(row) : row[column.key] ?? 'Sin dato'}</td>)}</tr>)}</tbody></table><PageControls data={data} onChange={onPage} disabled={loading}/></section>;
}
function Coverage({ metric, showReasons = false }) {
  const reasons = metric.exclusionReasons || [];
  const list = reasons.length > 0 && <ul>{reasons.map((reason, index) => <li key={index}>{reasonLabel(reason)}{reason?.count != null ? ` (${reason.count})` : ''}</li>)}</ul>;
  return <div className="report-coverage">
    <strong className={styles.coverageLabel}>{!metric.eligibleCount ? 'Sin registros para calcular' : metric.complete ? 'Datos completos para estos registros' : 'Faltan datos para completar esta cifra'}</strong>
    <span>{metric.knownCount ?? 0} de {metric.eligibleCount ?? 0} registros con datos · {metric.excludedCount ?? 0} excluidos</span>
    {list && (showReasons ? list : <details><summary>Por qué faltan datos</summary>{list}</details>)}
  </div>;
}
function MetricCard({ metricKey, metric, onDetails }) {
  return <article className={`report-metric${metric.complete ? '' : ' report-metric-partial'}`}>
    <h3>{metric.label}</h3>
    {METRIC_HELP[metricKey] && <p className="small muted">{METRIC_HELP[metricKey]}</p>}
    <p className="report-metric-value">{metric.value == null && metric.unit === 'minor' && !metric.complete ? 'Por completar' : valueLabel(metric.value, metric.unit)}</p>
    {!metric.complete && metric.knownValue != null && <p className="small">Subtotal conocido: <strong>{valueLabel(metric.knownValue, metric.unit)}</strong></p>}
    {metric.unit === 'bps' && <p className="small">{metric.denominator ? `${metric.numerator} de ${metric.denominator}` : 'Sin base de comparación'}</p>}
    <Coverage metric={metric}/>
    <button className="text-button" type="button" aria-label={`Ver registros de ${metric.label}`} data-report-detail-trigger={`metric:${metricKey}`} onClick={onDetails}>Ver registros</button>
  </article>;
}

function ReportFilters({ api, view, onChange, options, readOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const id = useId(), summaryRef = useRef(null), errorRef = useRef(null), restoreFocus = useRef(false);
  const activeFilters = FILTER_KEYS.filter(key => view[key]), needed = open || activeFilters.length > 0;
  const selection = FILTER_KEYS.map(key => view[key] || '').join('\n');
  useEffect(() => {
    if (!needed || data) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError('');
    Promise.all([api('/api/admin/business/people'), api('/api/admin/products'), api('/api/admin/combos'), api('/api/admin/business/platforms'), api('/api/admin/business/accounts')]).then(([people, products, combos, platforms, accounts]) => {
      if (active) setData({ seller: records(people), product: [...records(products), ...records(combos).map(row => ({ ...row, reportCombo: true }))], platform: records(platforms), account: records(accounts) });
    }).catch(cause => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, needed, data, attempt]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);
  useEffect(() => {
    if (restoreFocus.current) { restoreFocus.current = false; summaryRef.current?.focus(); }
  }, [selection]);
  function choices(key) {
    if (key === 'carrier') return options?.carriers || [];
    if (key === 'status') return (options?.statuses || []).map(option => ({ ...option, label: STATUSES[option.value] || option.label }));
    return (data?.[key] || []).map(row => ({ value: row.id, label: `${row.name || row.title}${row.presentation ? ` · ${row.presentation}` : ''}${row.reportCombo ? ' (combo)' : ''}${row.active === false ? ' (archivado)' : ''}` }));
  }
  function selectedLabel(key) {
    const found = choices(key).find(option => option.value === view[key]);
    if (found) return found.label;
    if (key === 'status' && STATUSES[view[key]]) return STATUSES[view[key]];
    return (key === 'carrier' || key === 'status' ? options : data) ? 'Registro no disponible' : 'Selección aplicada';
  }
  function update(patch, focus = false) {
    if (disabled || readOnly) return;
    restoreFocus.current = focus;
    onChange(patch);
  }
  function select(key) {
    const values = [{ value: '', label: 'Todos' }, ...choices(key)];
    if (view[key] && !values.some(option => option.value === view[key])) values.push({ value: view[key], label: `${selectedLabel(key)} (${view[key]})` });
    return <Field key={key} field={{ name: `${id}-${key}`, label: FILTER_LABELS[key], type: 'select', options: values }} value={view[key] || ''} onChange={value => update({ [key]: value })}/>;
  }
  return <div>
    <details className="report-filters" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary ref={summaryRef}>{readOnly ? 'Filtros de esta copia' : 'Filtrar resultados'}{activeFilters.length ? ` (${activeFilters.length} activos)` : ''}</summary>
      {readOnly ? <p className="small muted">Estos filtros pertenecen a la copia. Los nombres de referencia pueden ser actuales; las cifras y agrupaciones conservan su historia</p> : <>
        <fieldset className="report-filter-grid" disabled={disabled}><legend>Criterios de selección</legend>{FILTER_KEYS.map(select)}</fieldset>
        <p className="small muted">Vendedor/producto limitan pedidos y costos vinculados; plataforma/transportadora limitan envíos y pedidos vinculados; cuenta solo afecta caja y pagos, no ventas; estado se aplica según sea pedido o guía.</p>
      </>}
    </details>
    {activeFilters.length ? <div className="active-filters" aria-label={readOnly ? 'Filtros de esta copia' : 'Filtros activos'}>{activeFilters.map(key => readOnly
      ? <span className="filter-chip" key={key}>{FILTER_LABELS[key]}: {selectedLabel(key)}</span>
      : <button type="button" className="filter-chip" key={key} disabled={disabled} aria-label={`Quitar filtro: ${FILTER_LABELS[key]}: ${selectedLabel(key)}`} onClick={() => update({ [key]: '' }, true)}>{FILTER_LABELS[key]}: {selectedLabel(key)} <span aria-hidden="true">×</span></button>)}
      {!readOnly && <button className="text-button" type="button" disabled={disabled} onClick={() => update(Object.fromEntries(FILTER_KEYS.map(key => [key, ''])), true)}>Limpiar filtros</button>}
    </div> : <p className="small muted">Sin filtros: se consulta todo el período</p>}
    {loading && <p role="status">Cargando opciones reales…</p>}
    {error && <p className="error" role="alert" ref={errorRef} tabIndex={-1}>{error} <button className="text-button" type="button" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>Reintentar opciones</button></p>}
  </div>;
}

export default function ReportsWorkspace({ api, view, onViewChange, onOpenOrder, onInteractionStateChange, onMutation, revision }) {
  const [savedMetric, setSavedMetric] = useState(''), [resource, setResource] = useState({}), [retry, setRetry] = useState(0), [busy, setBusy] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(null), [pollError, setPollError] = useState(''), [pollRetry, setPollRetry] = useState(0);
  const [completedRequest, setCompletedRequest] = useState(null);
  const headingRef = useRef(null), resultsRef = useRef(null), detailRef = useRef(null), errorRef = useRef(null), opener = useRef(null), restoreDetailFocus = useRef(false), request = useRef(null), mounted = useRef(true), filterOptions = useRef(null), failedAction = useRef('');
  const period = view.period || 'month', anchor = view.anchor || bogotaDate(), tab = TABS.some(([key]) => key === view.tab) ? view.tab : 'overview', page = view.page || 1;
  const params = queryParams(view), query = params.toString();
  const snapshotId = view.record && !METRICS.has(view.record) ? view.record : '';
  const metricKey = snapshotId ? savedMetric : METRICS.has(view.record) ? view.record : '';
  const activeMode = snapshotId ? 'saved' : metricKey ? 'live' : view.mode === 'saved' ? 'saved' : 'live';
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
    if (!restoreDetailFocus.current || metricKey || loading || error || !report) return;
    restoreDetailFocus.current = false;
    const trigger = [...document.querySelectorAll('[data-report-detail-trigger]')].find(element => element.dataset.reportDetailTrigger === opener.current);
    if (trigger) {
      const disclosure = trigger.closest('details');
      if (disclosure) disclosure.open = true;
      trigger.focus();
    } else resultsRef.current?.focus();
  }, [metricKey, loading, error, report]);
  useEffect(() => {
    if (!pending || pollError) return;
    let active = true, timer;
    async function poll() {
      try {
        const result = await api(`${BASE}?${pending.query}&mode=saved&page=1`);
        if (!active) return;
        if (result.job?.key === pending.jobKey && result.job.state === 'failed') { setPollError('No se pudo preparar la copia. Consulta el estado otra vez o revisa las copias guardadas.'); return; }
        if (result.job?.key === pending.jobKey && result.job.state === 'succeeded') {
          setCompletedRequest({ query: pending.query, period: pending.period, anchorDate: pending.anchorDate }); setPending(null); setNotice('La preparación terminó. Revisa Informes guardados; si los datos no cambiaron, se conserva la misma versión'); setRetry(value => value + 1); return;
        }
        timer = setTimeout(poll, 4000);
      } catch (cause) { if (active) setPollError(cause.message); }
    }
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [api, pending, pollError, pollRetry]);
  function change(patch) { restoreDetailFocus.current = false; opener.current = null; setSavedMetric(''); setActionError(''); onViewChange({ ...patch, page: 1, record: '',issue:'' }); }
  function openDetails(key,issue='') { opener.current = document.activeElement?.getAttribute('data-report-detail-trigger') || null; if (snapshotId) { setSavedMetric(key); onViewChange({ page: 1,issue }); } else onViewChange({ mode: '', record: key, page: 1,issue }); }
  function closeDetails() { restoreDetailFocus.current = true; if (snapshotId) { setSavedMetric(''); onViewChange({ page: 1,issue:'' }); } else onViewChange({ mode: '', record: '', page: 1,issue:'' }); }
  function switchMode(next) { change({ mode: next === 'saved' ? 'saved' : '' }); }
  function showSnapshotQuery(nextMode) {
    if (!report || (nextMode === 'live' && report.query.filters?.source)) return;
    change({ period: report.query.period, anchor: report.query.anchorDate, ...Object.fromEntries(FILTER_KEYS.map(key => [key, report.query.filters?.[key] || ''])), mode: nextMode === 'saved' ? 'saved' : '' });
    if (report.query.filters?.source) setNotice('El listado conserva el período y los filtros disponibles, pero no incluye el filtro de origen de esta copia.');
  }
  function openSavedQuery(savedQuery) {
    const saved = new URLSearchParams(savedQuery);
    change({ period: saved.get('period'), anchor: saved.get('anchor'), ...Object.fromEntries(FILTER_KEYS.map(key => [key, saved.get(key) || ''])), mode: 'saved' });
  }
  async function generate() {
    if (busy || pending || snapshotId || activeMode !== 'live' || loading || error || !report) return;
    setBusy('save'); failedAction.current = 'save'; setActionError(''); setNotice('');
    if (!request.current || request.current.query !== query) request.current = { query, requestId: crypto.randomUUID() };
    try {
      const result = await api(BASE, { method: 'POST', body: JSON.stringify({ period, anchorDate: anchor, filters: Object.fromEntries(FILTER_KEYS.filter(key => view[key]).map(key => [key, view[key]])), requestId: request.current.requestId }) });
      if (!mounted.current) return;
      setPending({ ...result, query, period, anchorDate: anchor }); setCompletedRequest(null); setPollError(''); setNotice('Solicitud recibida. La copia todavía se está preparando; puedes seguir consultando'); request.current = null;
      onMutation?.({ type: 'report', state: result.state, jobKey: result.jobKey });
    } catch (cause) { if (mounted.current) setActionError(cause.message); } finally { if (mounted.current) setBusy(''); }
  }
  async function download() {
    if (busy || !report || loading || error) return;
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
  return <section className={`reports-workspace ${styles.workspace} ${styles.reportsWorkspace}`} aria-label="Informes del negocio" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && metricKey && !busy && !event.target.closest('input,textarea,select,[contenteditable="true"]') && !document.querySelector('dialog[open]')) { event.preventDefault(); event.stopPropagation(); closeDetails(); } }}>
    <header className="admin-heading"><div><h1 ref={headingRef} tabIndex={-1} data-admin-section-heading>Informes</h1><p>Consulta cómo va tu negocio, revisa los datos pendientes y conserva copias para consultarlas después</p></div></header>
    <ReportsGuide mode={activeMode} isSnapshot={Boolean(snapshotId)}/>
    <section className={styles.queryPanel} aria-label="Consulta del informe">
      <h2>Consulta del informe</h2>
      <div className="report-mode" role="group" aria-label="Origen del informe"><span>Origen del informe</span><button className="button subtle" type="button" aria-pressed={activeMode==='live'} disabled={!!busy || !!snapshotId && (!report || !!report.query.filters?.source)} onClick={()=>snapshotId ? showSnapshotQuery('live') : switchMode('live')}>Datos actuales</button><button className="button subtle" type="button" aria-pressed={activeMode==='saved'} disabled={!!busy} onClick={()=>snapshotId && report ? showSnapshotQuery('saved') : switchMode('saved')}>Informes guardados</button></div>
      <p className={styles.queryHelp}>{snapshotId ? 'Estás consultando una copia de solo lectura.' : activeMode === 'saved' ? 'Busca copias preparadas para el período y los filtros elegidos.' : 'Consulta los datos registrados sin guardar una copia ni cambiar el negocio.'}</p>
      {(activeMode==='live'||snapshotId)&&<WorkspaceTabs label="Áreas del informe" items={tabItems} value={tab} disabled={!!busy} onChange={tab=>{setSavedMetric('');onViewChange({tab,page:1,record:snapshotId||'',issue:'',mode:snapshotId?'saved':''});}}/>}
      {!snapshotId&&<><PeriodPicker period={period} anchor={anchor} disabled={!!busy} onChange={({period,anchor})=>change({period,anchor})}/><p className={styles.queryHelp}>Elige una fecha dentro del período que quieres consultar</p></>}
      {snapshotId&&report&&<p className={styles.queryHelp}><strong>Período guardado: {reportDateLabel(report.bounds.startDate)} al {reportDateLabel(addDays(report.bounds.endDateExclusive, -1))}</strong></p>}
      {!snapshotId&&<ReportFilters api={api} view={view} onChange={change} options={filterOptions.current} disabled={!!busy}/>}
      {snapshotId&&report&&<ReportFilters key={snapshotId} api={api} view={report.query.filters||{}} options={report.filterOptions} readOnly disabled={!!busy}/>}
      {snapshotId && report?.query.filters?.source && <p className={styles.queryHelp}>Origen de plataforma: {report.query.filters.source} (filtro de esta copia). Esta copia usa un filtro de origen que no se puede editar aquí; puedes consultarla y descargarla.</p>}
      {snapshotId && error && <button className="text-button" type="button" onClick={() => switchMode('saved')}>Volver a informes guardados</button>}
      {(activeMode === 'live' || snapshotId) && <div className={styles.operationBar}>
        {!snapshotId && <button className="button primary" type="button" disabled={!!busy || !!pending || !report || loading || !!error} onClick={generate}>{busy === 'save' ? 'Solicitando copia…' : pending ? 'Copia en preparación' : 'Guardar copia'}</button>}
        <button className={`button ${snapshotId ? 'primary' : 'subtle'}`} type="button" disabled={!!busy || !report || loading || !!error} onClick={download}>{busy === 'download' ? 'Descargando…' : 'Descargar Excel'}</button>
        {snapshotId && <><button className="button subtle" type="button" disabled={!!busy || !report || !!report.query.filters?.source} onClick={() => showSnapshotQuery('live')}>Ver datos actuales de este período</button>{report && <button className="text-button" type="button" disabled={!!busy} onClick={() => showSnapshotQuery('saved')}>Volver a informes guardados</button>}</>}
      </div>}
      {(activeMode === 'live' || snapshotId) && <p className={styles.queryHelp}>{snapshotId ? 'Descargar crea un archivo Excel con todas las áreas de esta versión, no solo el detalle visible. Importes en COP.' : 'Guardar conserva una copia en el panel. Descargar crea un archivo Excel. Ambas acciones incluyen todas las áreas del período y filtros elegidos'}</p>}
    </section>
    {(actionError || error || pollError) && <div className="report-feedback error" role="alert" ref={errorRef} tabIndex={-1}>
      {actionError && <p>{actionError} <button className="text-button" type="button" disabled={!!busy || !report || loading || !!error || failedAction.current === 'save' && !!pending} onClick={failedAction.current === 'download' ? download : generate}>Reintentar {failedAction.current === 'download' ? 'descarga' : 'solicitud'}</button></p>}
      {error && <p>{error} <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>Reintentar carga</button></p>}
      {pollError && <><p>{pollError}</p><button className="text-button" type="button" onClick={() => { setPollError(''); setPollRetry(value => value + 1); }}>Consultar estado otra vez</button><button className="text-button" type="button" onClick={() => { setPending(null); setPollError(''); setNotice('Cerrar este aviso no cancela la preparación en el servidor. Revisa las copias guardadas antes de volver a solicitar'); }}>Cerrar seguimiento</button><p>Cerrar este aviso no cancela la preparación en el servidor. Revisa las copias guardadas antes de volver a solicitar</p></>}
    </div>}
    {notice && <p className="report-feedback" role="status">{notice}</p>}
    {pending && <p className="report-feedback" role="status">Copia en preparación · {REPORT_PERIOD_LABELS[pending.period]} · {reportDateLabel(pending.anchorDate)}. Puedes seguir consultando. <button className="text-button" type="button" disabled={!!busy} onClick={() => openSavedQuery(pending.query)}>Ver estado del guardado</button></p>}
    {completedRequest && <p className="report-feedback" role="status">Consulta preparada: {REPORT_PERIOD_LABELS[completedRequest.period]} · {reportDateLabel(completedRequest.anchorDate)}. <button className="text-button" type="button" disabled={!!busy} onClick={() => openSavedQuery(completedRequest.query)}>Ver copias de esta consulta</button></p>}
    {loading && <p role="status">{data ? 'Actualizando esta consulta…' : 'Cargando informe…'}</p>}
    {activeMode === 'saved' && !snapshotId && data && <>
      <p className="muted">Copias de este período y estos filtros, de la más reciente a la más antigua. Cada versión conserva las cifras que tenía al prepararse</p>
      <DataTable caption="Informes guardados" data={data} loading={loading} onPage={next => onViewChange({ page: next })}
        emptyState={data.total > 0 ? <><p>Esta página no contiene copias. Hay versiones en otras páginas de esta consulta.</p><button className="button subtle" type="button" disabled={loading || !!busy} onClick={() => onViewChange({ page: 1 })}>Ir a la primera página</button></> : <><h4>No hay copias guardadas para este período y estos filtros</h4><p>Cambia el período o quita filtros para buscar otras copias. También puedes consultar este período y guardar una copia.</p><button className="button subtle" type="button" disabled={!!busy} onClick={() => switchMode('live')}>Consultar este período</button></>}
        columns={[
          { key: 'period', label: 'Período', render: row => <>{REPORT_PERIOD_LABELS[row.period] || row.period} · {reportDateLabel(row.startOn)} al {reportDateLabel(addDays(row.endOnExclusive, -1))}</> },
          { key: 'revision', label: 'Versión', render: row => `Versión ${row.revision}` },
          { key: 'generatedAt', label: 'Preparada el (Bogotá)', render: row => timestamp(row.generatedAt) },
          { key: 'state', label: 'Estado', render: row => SNAPSHOT_STATES[row.state] || 'Sin estado' },
          { key: 'coverage', label: 'Datos pendientes', render: row => row.coverage?.pending?.length ? <ul>{row.coverage.pending.map((item, index) => <li key={index}>{item.label} ({item.count})</li>)}</ul> : 'Sin pendientes informados' },
          { key: 'open', label: 'Consultar', render: row => <button type="button" className="text-button" disabled={loading || !!busy} aria-label={`Abrir versión ${row.revision}: ${reportDateLabel(row.startOn)} al ${reportDateLabel(addDays(row.endOnExclusive, -1))}`} onClick={() => { setSavedMetric(''); setActionError(''); onViewChange({ mode: 'saved', record: row.id, page: 1, issue: '' }); }}>Abrir versión {row.revision}</button> },
        ]}/>
    </>}
    {report && <>
      {snapshotId && <div className="report-feedback"><h3>Copia guardada · Versión {report.snapshot?.revision}</h3><p>{SNAPSHOT_STATES[report.snapshot?.state] || 'Informe histórico'} · Solo lectura: conserva las cifras y los registros originales.</p>{report.snapshot?.staleSince && <p>Hay datos nuevos desde {timestamp(report.snapshot.staleSince)} · hora de Bogotá. Puedes consultarlos con «Ver datos actuales de este período».</p>}</div>}
      {report.empty && <div className="report-feedback"><h3>No hay registros para esta consulta</h3><p>Prueba otro período o revisa los filtros. Los registros sin fechas o costos se muestran como pendientes; no se inventan ventas ni ganancias.</p>{!snapshotId && <div className={styles.operationBar}>{FILTER_KEYS.some(key => view[key]) && <button className="button subtle" type="button" disabled={!!busy} onClick={() => change(Object.fromEntries(FILTER_KEYS.map(key => [key, ''])))}>Quitar filtros de esta consulta</button>}<button className="button subtle" type="button" disabled={!!busy} onClick={() => change({ period: 'month', anchor: bogotaDate() })}>Consultar este mes</button></div>}</div>}
      <header className={styles.contextHeading}><h2 ref={resultsRef} tabIndex={-1}>{TABS.find(([key])=>key===tab)?.[1]} · {reportDateLabel(report.bounds.startDate)} al {reportDateLabel(addDays(report.bounds.endDateExclusive, -1))}</h2><p>{TAB_GUIDANCE[tab]}</p><div className="report-dates"><span>Datos hasta {timestamp(report.dataAsOf)} · hora de Bogotá</span><span>{report.closed ? 'Período terminado' : 'Período en curso'}</span></div></header>
      {!metricKey && (report.coverage?.pending || []).length > 0 && <details className="report-pending"><summary>Datos por completar ({report.coverage.pending.length} conceptos)</summary><p>Estas cifras pueden estar incompletas. Abre un concepto para revisar sus registros</p><ul>{report.coverage.pending.map((item, index) => <li key={`${item.code}-${index}`}>{item.label}: <strong>{item.count}</strong>{item.detailsQuery?.metric && <button type="button" className="text-button" data-report-detail-trigger={`pending:${item.code}:${item.detailsQuery.metric}:${index}`} onClick={() => openDetails(item.detailsQuery.metric,'missing')}>Ver registros pendientes</button>}</li>)}</ul></details>}
      {!metricKey && <>
        <div className="report-metrics">{TAB_METRICS[tab].filter(key => report.metrics?.[key]).map(key => <MetricCard key={key} metricKey={key} metric={report.metrics[key]} onDetails={() => openDetails(key)}/>)}</div>
        {tab === 'sales' && ['products', 'sellers'].map(key => groupTable(key, key === 'products' ? 'Por producto histórico' : 'Por vendedor histórico', [{ key: 'label', label: key === 'products' ? 'Producto' : 'Vendedor' }, { key: 'orderCount', label: 'Pedidos' }, { key: 'units', label: 'Unidades' }, amountColumn('netSalesMinor', 'Venta neta de productos'), contributionColumn]))}
        {tab === 'shipping' && groupTable('shipments', 'Guías y fechas reales (los pedidos se cuentan por separado)', [orderColumn, { key: 'tracking', label: 'Guía', render: row => row.tracking || 'Sin guía' }, { key: 'carrier', label: 'Transportadora' }, { key: 'status', label: 'Estado', render: row => STATUSES[row.status] || row.status }, dateColumn('labelCreatedOn', 'Creación'), dateColumn('collectedOn', 'Recogida'), dateColumn('deliveredOn', 'Entrega'), dateColumn('returnedOn', 'Retorno'), dateColumn('estimatedDeliveryOn', 'Estimada'), { key: 'transitDays', label: 'Tránsito', render: row => valueLabel(row.transitDays, 'days') }])}
        {tab === 'returns' && groupTable('returns', 'Devoluciones y cancelaciones comerciales (no reembolsos)', [orderColumn, dateColumn('occurredOn', 'Fecha'), { key: 'reason', label: 'Motivo' }, { key: 'quantity', label: 'Unidades' }, amountColumn('salesCreditMinor', 'Crédito productos'), amountColumn('shippingCreditMinor', 'Crédito flete'), amountColumn('recoveredCostMinor', 'Costo recuperado')])}
        {tab === 'costs' && groupTable('costs', 'Gastos registrados; las fechas desconocidas permanecen pendientes', [{ key: 'label', label: 'Concepto' }, { key: 'category', label: 'Categoría', render: row => CATEGORIES[row.category] || row.category }, orderColumn, dateColumn('occurredOn', 'Ocurrencia'), amountColumn('amountMinor', 'Devengado'), amountColumn('paidMinor', 'Pagado'), amountColumn('outstandingMinor', 'Pendiente'), amountColumn('creditMinor', 'Crédito por conciliar')])}
        {tab === 'payroll' && <><p className="small muted">El devengo ya está incluido en el resultado una sola vez. Pagos y anticipos afectan caja y deuda, no generan otro costo.</p>{groupTable('payroll', 'Devengos, pagos y saldos por persona', [{ key: 'label', label: 'Persona' }, partialAmountColumn('earnedMinor', 'knownEarnedMinor', 'Devengado'), amountColumn('paidMinor', 'Pagado'), partialAmountColumn('outstandingMinor', 'knownOutstandingMinor', 'Pendiente'), amountColumn('advanceMinor', 'Anticipos'), amountColumn('creditMinor', 'Crédito por compensar')])}</>}
        {tab === 'cash' && <><p className="small muted">Saldo al corte del informe, no necesariamente disponible ahora. El recaudo retenido en plataforma se informa aparte. Aperturas y transferencias no son ventas.</p>{groupTable('accounts', 'Saldos y movimientos por cuenta', [{ key: 'label', label: 'Cuenta' }, amountColumn('openingMinor', 'Saldo al inicio'), amountColumn('openingEntriesMinor', 'Aperturas del período'), amountColumn('inflowMinor', 'Entradas'), amountColumn('outflowMinor', 'Salidas'), amountColumn('transferMinor', 'Transferencias netas'), amountColumn('balanceMinor', 'Saldo al corte')])}</>}
      </>}
      {metricKey && <section className="report-detail" aria-label="Registros exactos de la métrica">
        <div className="admin-heading"><h3 ref={detailRef} tabIndex={-1}>{detailMetric?.label || 'Registros de cobertura'}</h3><button type="button" className="button subtle" onClick={closeDetails}>Cerrar detalle</button></div>
        {METRIC_HELP[metricKey] && <p>{METRIC_HELP[metricKey]}</p>}
        {detailMetric && <><p><strong>Total: {valueLabel(detailMetric.value, detailMetric.unit)}</strong></p>{!detailMetric.complete && detailMetric.knownValue != null && <p>Subtotal conocido: {valueLabel(detailMetric.knownValue, detailMetric.unit)} · Cifra parcial</p>}{detailMetric.unit === 'bps' && <p>{detailMetric.denominator ? `${detailMetric.numerator} de ${detailMetric.denominator}` : 'Sin base de comparación'}</p>}<Coverage metric={detailMetric} showReasons/></>}
        {report.details?.bounds&&<p className="small"><strong>Tramo comparado: {reportDateLabel(report.details.bounds.startDate)} al {reportDateLabel(addDays(report.details.bounds.endDateExclusive,-1))}</strong>. El día abierto no entra en esta comparación.</p>}
        <p className="small muted">{view.issue?'Subconjunto exacto de la observación seleccionada; mismos filtros.':'Mismos filtros y fechas del informe. Incluye los registros excluidos y su motivo.'} Hasta 20 registros por página. La exportación conserva el informe completo.</p>
        {report.details ? <DataTable caption="Registros que explican la cifra" data={report.details} loading={loading} onPage={next => onViewChange({ page: next })} columns={[{ key: 'label', label: 'Registro' }, orderColumn, { key: 'tracking', label: 'Guía', render: row => row.tracking || 'No aplica' }, dateColumn('occurredOn', 'Fecha del hecho'), { key: 'value', label: 'Importe / valor', render: row => valueLabel(row.value, row.unit) }, { key: 'reason', label: 'Cobertura', render: row => row.known === false ? `Excluido: ${row.reason || 'Dato desconocido'}` : row.reason || 'Incluido' }]}/> : loading ? <p role="status">Cargando registros…</p> : <p className="error" role="alert">No se recibieron los registros de esta métrica. <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>Reintentar detalle</button></p>}
      </section>}
      <details className="report-sources"><summary>Cortes y últimas importaciones por plataforma</summary>{report.lastImportAt?.length ? <ul>{report.lastImportAt.map(source => <li key={source.sourceId || source.platformId}><strong>{source.platformName} · {source.sourceName}</strong><br/>Corte del origen: {source.precision === 'instant' ? timestamp(source.sourceAsOf) : source.sourceAsOf ? `${reportDateLabel(source.sourceDate || bogotaDate(source.sourceAsOf))} · sin hora confirmada` : 'Sin dato'}<br/>Importado: {timestamp(source.importedAt)} (Bogotá)</li>)}</ul> : <p className="muted">No hay importaciones de plataforma registradas. Las operaciones manuales no tienen un corte de archivo ficticio.</p>}</details>
      <details className="report-definitions"><summary>Definiciones, criterios y reglas del informe</summary>
        {!snapshotId&&activeMode!=='saved'&&tab==='costs'&&<p>Resultado operativo = contribución − sueldo fijo − bonificaciones − publicidad − operación − otros gastos. Publicidad y operación se reconocen por fecha del gasto; no se descuentan otra vez de la contribución ni se confunden con pagos de caja.</p>}
        <p className="small muted">Calculado: {timestamp(report.generatedAt)} · Fechas comerciales America/Bogota, inicio incluido y fin excluido. La exportación incluye Resumen, Detalle y Definiciones. Sin dato no equivale a cero.</p>
        <p className="small muted">El resultado operativo registrado no es utilidad neta después de impuestos. El acumulado de un pedido puede incluir hechos de otros períodos.</p>
        <dl>{(report.definitions || []).map((definition, index) => <div key={definition.key || index}><dt>{definition.label}</dt><dd>{definition.formula}</dd>{definition.criteria && <dd>{Array.isArray(definition.criteria) ? definition.criteria.join(' · ') : definition.criteria}</dd>}</div>)}</dl>
      </details>
    </>}
  </section>;
}
