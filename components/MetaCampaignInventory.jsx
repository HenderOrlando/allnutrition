import { useEffect, useRef, useState } from 'react';
import { MetaCampaignEconomics } from './AdvertisingEconomics';
import styles from './AdvertisingWorkspace.module.css';
import inventory from './MetaCampaignInventory.module.css';

const root = '/api/admin/social/meta-campaigns';
const pageSize = 10;
const columns = ['Campaña', 'Cuenta de origen', 'Estado según Meta', 'Última lectura de Meta', 'Métricas', 'Detalle'];
const statuses = { ACTIVE: 'Activa', PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada según Meta', IN_PROCESS: 'En proceso', WITH_ISSUES: 'Con incidencias', PENDING_REVIEW: 'Pendiente de revisión', DISAPPROVED: 'Rechazada', CAMPAIGN_PAUSED: 'Campaña pausada', ADSET_PAUSED: 'Conjunto pausado' };
const goals = { REACH: 'Alcance', IMPRESSIONS: 'Impresiones', LINK_CLICKS: 'Clics en el enlace', OFFSITE_CONVERSIONS: 'Conversiones fuera de Meta', LANDING_PAGE_VIEWS: 'Visitas a la página de destino', POST_ENGAGEMENT: 'Interacciones con la publicación' };
const active = new Set(['queued', 'running', 'waiting']);
const pending = new Set(['pending', 'incomplete', 'partial', 'denied', 'unavailable', 'accessible_partial']);
const labels = { impressions: 'Impresiones', clicks: 'Clics', reach: 'Alcance', spend: 'Gasto' };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Fecha no disponible';
const period = value => value?.since && value?.until ? `${value.since} – ${value.until}` : null;
const identity = item => `${item.ownerId}:${item.resourceId}`;
const title = item => `Campaña ${item.resourceId}`;
const reported = measurement => Object.values(measurement.values || {}).some(metric => metric?.value != null);

function status(configuration) {
  const value = configuration?.effective_status || configuration?.status;
  if (!value) return 'Estado no informado';
  return `${statuses[value] || value}${configuration.effective_status ? '' : ' (configurado)'}`;
}

function endpoint(view, page) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  for (const key of ['connection', 'account', 'metaCampaign', 'snapshot']) if (view[key]) params.set(key, view[key]);
  return `${root}?${params}`;
}

function useSavedRead(api, path, revision) {
  const [read, setRead] = useState(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setRead({ path, revision, attempt, data });
    }).catch(cause => {
      if (!controller.signal.aborted) setRead(previous => ({ path, revision, attempt, data: previous?.path === path ? previous.data : null, previous: previous?.data || previous?.previous, error: cause.message }));
    });
    return () => controller.abort();
  }, [api, path, revision, attempt]);
  const current = read?.path === path ? read : null;
  return { data: current?.data, previous: read?.data || read?.previous, error: current?.error, loading: current?.revision !== revision || current?.attempt !== attempt, retry: () => setAttempt(value => value + 1) };
}

function ReadFeedback({ read, label }) {
  if (read.loading) return <p role="status">{read.data ? 'Actualizando' : 'Cargando'} {label}…</p>;
  return read.error && <div role="alert" className={styles.error}><p>{read.error}</p>{read.data && <p>Se conserva la última lectura guardada de esta consulta.</p>}<button type="button" className="button subtle" onClick={read.retry}>Reintentar lectura</button></div>;
}

function Pages({ label, pagination, onPage, disabled }) {
  const { page, total, pageSize } = pagination;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1 && page === 1) return null;
  return <nav aria-label={label} className={styles.pagination}>
    <button className="button subtle" type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
    <span>Página {page} de {pages}</span>
    <button className="button subtle" type="button" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Siguiente</button>
  </nav>;
}

function MetricSummary({ item }) {
  const measurements = item.metrics.filter(reported);
  const partial = item.analysisState === 'partial' || pending.has(item.coverage?.state) || measurements.some(measurement => Object.keys(labels).some(key => measurement.values[key]?.value == null));
  const summary = measurements.length ? partial ? 'Métricas parciales' : 'Métricas disponibles' : item.object ? 'Configuración disponible · Sin métricas' : 'Sin datos';
  return <><strong>{summary}</strong>{!item.object && <small>Sin configuración consultada</small>}
    {measurements.map((measurement, index) => <div className={inventory.measurement} key={index}>
      {period(measurement.period) && <small>{period(measurement.period)}</small>}
      <dl>{Object.entries(labels).map(([key, label]) => {
        const metric = measurement.values[key];
        return <div key={key}><dt>{label}</dt><dd>{metric?.value == null ? 'Sin dato' : `${metric.value}${key === 'spend' ? ` ${measurement.currency || '(moneda no informada)'}` : ''}${metric.status === 'estimated' ? ' · Estimado' : ''}`}</dd></div>;
      })}</dl>
    </div>)}
  </>;
}

function Filter({ label, all, value, choices, onChange }) {
  return <label className={inventory.filter}>{label}<select value={value || ''} onChange={event => onChange(event.target.value || null)}>
    <option value="">{all}</option>
    {value && !choices.some(choice => choice.id === value) && <option value={value}>{value}</option>}
    {choices.map(choice => <option value={choice.id} key={choice.id}>{choice.name ? `${choice.name} · ${choice.id}` : choice.id}</option>)}
  </select></label>;
}

function Cell({ index, children }) {
  return <td role="cell"><span className={inventory.cellLabel} aria-hidden="true">{columns[index]}</span>{children}</td>;
}

function List({ data, view, onChange, focusTarget, heading, loading }) {
  const table = useRef(null);
  useEffect(() => {
    if (!data || !focusTarget.current) return;
    const button = [...(table.current?.querySelectorAll('button[data-campaign]') || [])].find(node => node.dataset.campaign === focusTarget.current);
    (button || heading.current)?.focus();
    focusTarget.current = null;
  }, [data, focusTarget, heading]);
  const waiting = data.availability?.some(entry => active.has(entry.state));
  const accessIssue = data.availability?.some(entry => entry.coverage?.some(coverage => coverage.kind === 'ad_account' && (coverage.state === 'denied' || coverage.missing?.some(missing => missing.reason === 'permission'))));
  return <>
    {data.availability?.some(entry => ['failed', 'cancelled'].includes(entry.state)) && <p>Una lectura reciente no se completó. Solo se muestran datos guardados.</p>}
    <p><strong>{data.pagination.total} {data.pagination.total === 1 ? 'campaña' : 'campañas'}</strong></p>
    {waiting && <p>Hay una consulta en curso. Solo se muestran las lecturas ya guardadas.</p>}
    {accessIssue && <p>Hay datos que no se pudieron consultar por falta de permisos. El inventario guardado no demuestra acceso vigente.</p>}
    {data.items.length ? <div className={styles.tableWrap}><table role="table" ref={table} className={inventory.table} aria-label="Campañas consultadas en Meta">
      <thead role="rowgroup"><tr role="row">{columns.map(column => <th role="columnheader" scope="col" key={column}>{column}</th>)}</tr></thead>
      <tbody role="rowgroup">{data.items.map(item => <tr role="row" key={identity(item)}>
        <Cell index={0}><strong>{title(item)}</strong>{item.localCampaignId && <small>También creada en All Nutrition</small>}</Cell>
        <Cell index={1}>{item.accountName && <strong>{item.accountName}</strong>}<span>{item.ownerId}</span>{item.connectionName && <small>{item.connectionName}</small>}</Cell>
        <Cell index={2}>{status(item.object?.configuration)}</Cell>
        <Cell index={3}>{time(item.observedAt)}{(item.historical || item.snapshot.stale) && <small>Histórico guardado</small>}</Cell>
        <Cell index={4}><MetricSummary item={item}/></Cell>
        <Cell index={5}><button type="button" className="button subtle" data-campaign={identity(item)} aria-label={`Ver detalle: ${title(item)} · ${item.ownerId}`} onClick={() => onChange({ account: item.ownerId, metaCampaign: item.resourceId, allAccounts: view.account ? null : '1' })}>Ver detalle</button></Cell>
      </tr>)}</tbody>
    </table></div> : data.pagination.total ? <p>Esta página no tiene campañas. <button type="button" className="button subtle" onClick={() => onChange({ page: 1 })}>Ir a la primera página</button></p> : <p>{waiting ? 'Aún no hay campañas guardadas para estos filtros.' : accessIssue ? 'No hay campañas guardadas; no se pudo verificar el acceso a todos los recursos.' : 'No hay campañas guardadas para estos filtros.'}</p>}
    <Pages label="Páginas de campañas consultadas" pagination={data.pagination} onPage={page => onChange({ page })} disabled={loading}/>
  </>;
}

function AdSets({ api, view, revision, initial }) {
  const [page, setPage] = useState(1);
  const read = useSavedRead(api, page === 1 ? null : endpoint(view, page), revision);
  const data = page === 1 ? initial : read.data;
  return <details className={styles.guide}>
    <summary>Conjuntos de anuncios ({initial.pagination.total})</summary>
    {page > 1 && <ReadFeedback read={read} label="conjuntos de anuncios"/>}
    {data?.adsets.length ? <ul className={styles.choiceList}>{data.adsets.map(adset => <li key={adset.resourceId}>
      <strong>Conjunto {adset.resourceId}</strong> · {status(adset.configuration)}
      {adset.configuration?.optimization_goal && <div>Objetivo de optimización: {goals[adset.configuration.optimization_goal] || adset.configuration.optimization_goal}</div>}
      <div>Última lectura: {time(adset.observedAt)}</div>
    </li>)}</ul> : data && <p>No hay conjuntos guardados en esta lectura.</p>}
    {data && <Pages label="Páginas de conjuntos de anuncios" pagination={data.pagination} onPage={setPage} disabled={page > 1 && read.loading}/>}
  </details>;
}

function Detail({ api, view, revision, onChange, onBack, onOpenLocal }) {
  const heading = useRef(null);
  const read = useSavedRead(api, endpoint(view, 1), revision);
  const menu = useSavedRead(api, view.allConnections ? endpoint({ ...view, connection: null, snapshot: null }, 1) : null, revision);
  const data = read.data || read.previous;
  const item = data?.item;
  const snapshots = menu.data?.snapshots || data?.snapshots || [];
  const earlier = snapshots.find(entry => entry.metrics.some(reported));
  const select = entry => onChange({ connection: entry.connectionId, snapshot: entry.snapshot.id, allConnections: !view.connection || view.allConnections ? '1' : null });
  useEffect(() => { heading.current?.focus(); }, []);
  return <>
    <div className={styles.actions}><button type="button" className="button subtle" onClick={onBack}>Volver a campañas consultadas</button></div>
    <h2 ref={heading} tabIndex={-1}>Campaña {view.metaCampaign}</h2>
    <ReadFeedback read={read} label="lectura guardada"/>
    {item && <div hidden={!read.data}><div className={styles.stack}>
      <section className={`${styles.card} ${styles.stack}`} aria-label="Datos guardados de Meta">
        <p><strong>Cuenta de origen:</strong> {item.accountName ? `${item.accountName} · ` : ''}{item.ownerId}</p>
        <p><strong>Conexión:</strong> {item.connectionName || item.connectionId}</p>
        <p><strong>Estado según Meta:</strong> {status(item.object?.configuration)}</p>
        <p><strong>Última lectura de Meta:</strong> {time(item.observedAt)}</p>
        {(item.historical || item.snapshot.stale) && <p>Histórico guardado: no acredita estado ni permisos vigentes.</p>}
        {item.localCampaignId ? <div className={styles.actions}><span>También creada en All Nutrition</span><button type="button" className="button subtle" onClick={() => onOpenLocal(item.localCampaignId)}>Abrir ficha propia</button></div> : <p>Vínculo no comprobado</p>}
        <label className={inventory.filter}>Lectura guardada<select value={item.snapshot.id} onChange={event => {
          const chosen = snapshots.find(entry => entry.snapshot.id === event.target.value);
          if (chosen) select(chosen);
        }}>
          {snapshots.map(entry => <option key={entry.snapshot.id} value={entry.snapshot.id}>{time(entry.observedAt)} · {period(entry.metrics.find(reported)?.period || entry.period) || 'Período no informado'} · {entry.ownerId} · {entry.connectionName || entry.connectionId} · {entry.metrics.some(reported) ? 'Con métricas' : 'Sin métricas'}</option>)}
        </select></label>
        {view.allConnections && menu.error && <ReadFeedback read={menu} label="lecturas de otras conexiones"/>}
        {!item.metrics.some(reported) && <p>Sin métricas en esta lectura</p>}
        {!item.metrics.some(reported) && earlier && <div className={styles.actions}>
          <button type="button" className="button subtle" onClick={() => select(earlier)}>Ver métricas de la lectura del {time(earlier.observedAt)}</button>
        </div>}
      </section>
      <AdSets key={item.snapshot.id} api={api} view={{ ...view, connection: item.connectionId, snapshot: item.snapshot.id }} revision={revision} initial={data}/>
      <MetaCampaignEconomics api={api} item={item}/>
    </div></div>}
  </>;
}

export default function MetaCampaignInventory({ api, view, onChange, onOpenLocal, revision }) {
  const focusTarget = useRef(null), heading = useRef(null);
  const detail = Boolean(view.metaCampaign);
  const key = detail ? `${view.account}:${view.metaCampaign}` : null;
  const list = useSavedRead(api, detail ? null : endpoint(view, view.page), revision);
  useEffect(() => {
    if (key) focusTarget.current = key;
    else if (!focusTarget.current) heading.current?.focus({ preventScroll: true });
  }, [key]);
  if (detail) return <section className={styles.stack} aria-label="Detalle de campaña consultada">
    <Detail key={key} api={api} view={view} revision={revision} onChange={onChange} onOpenLocal={onOpenLocal} onBack={() => onChange({
      account: view.allAccounts ? null : view.account, connection: view.allConnections ? null : view.connection,
      metaCampaign: null, snapshot: null, allAccounts: null, allConnections: null
    })}/>
  </section>;
  return <section className={styles.stack} aria-labelledby="meta-campaign-inventory">
    <h2 ref={heading} id="meta-campaign-inventory" tabIndex={-1}>Campañas consultadas en Meta</h2>
    <p>Lecturas guardadas de solo lectura. No se consulta a Meta al abrir esta vista.</p>
    <div className={inventory.filters}>
      <Filter label="Conexión de origen" all="Todas las conexiones" value={view.connection} choices={list.data?.connections || list.previous?.connections || []} onChange={connection => onChange({ connection, account: null, page: 1 })}/>
      <Filter label="Cuenta publicitaria" all="Todas las cuentas" value={view.account} choices={list.data?.accounts || []} onChange={account => onChange({ account, page: 1 })}/>
    </div>
    <ReadFeedback read={list} label="campañas consultadas"/>
    {list.data && <List data={list.data} view={view} onChange={onChange} focusTarget={focusTarget} heading={heading} loading={list.loading}/>}
  </section>;
}
