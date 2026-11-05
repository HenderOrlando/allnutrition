'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import { Field } from './Fields';
import useDialog from './useDialog';
import AdvertisingCampaignEditor from './AdvertisingCampaignEditor';
import AdvertisingResults from './AdvertisingResults';
import SocialBrowserLogin from './SocialBrowserLogin';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const tabs = [{ id: 'campaigns', label: 'Publicaciones y pauta' }, { id: 'assets', label: 'Piezas' }, { id: 'results', label: 'Resultados' }, { id: 'connections', label: 'Conexiones' }];
const states = { draft: 'Borrador', ready: 'Preparada, sin gasto autorizado', scheduled: 'Programada', publishing: 'En preparación o publicación', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Falló', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Envío incierto: reconciliar', blocked: 'Bloqueada', connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador', uploading: 'Carga pendiente o en curso', processing: 'Procesando derivado', archived: 'Archivada', missing_file: 'Falta archivo privado restaurado' };
const objectives = { whatsapp: 'Consultas por WhatsApp', traffic: 'Clics al sitio web', reach: 'Alcance', engagement: 'Interacción' };
const methods = { api: 'API oficial', browser: 'Navegador / scraper' };
const capabilities = { facebookPublish: 'Publicar en Facebook', instagramPublish: 'Publicar en Instagram', adsPublish: 'Preparar y operar pauta', insights: 'Consultar resultados', whatsappAds: 'Pauta a WhatsApp vinculado' };
const pendingCampaign = row => ['publishing', 'in_review'].includes(row.state) || row.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review', 'uncertain'].includes(item.state));
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin fecha disponible';
const bytes = value => Number.isFinite(value) ? `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(value / 1048576)} MiB` : 'Sin dato';
function money(value, currency) {
  if (!Number.isSafeInteger(value) || !currency) return 'No disponible';
  try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency, currencyDisplay: 'code' }).format(value / 100); } catch { return `${value / 100} ${currency}`; }
}
function useRead(api, path, refresh, interval = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: false, fetchedAt: null, path: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); let active = true, timer;
    async function load() {
      if (!active) return;
      if (interval && document.hidden) { timer = setTimeout(load, interval); return; }
      setState(previous => ({ ...previous, loading: true }));
      try {
        const data = await api(path, { signal: controller.signal });
        if (active) setState({ data, error: '', loading: false, fetchedAt: new Date().toISOString(), path });
      } catch (cause) {
        if (active && cause.name !== 'AbortError') setState(previous => ({ ...previous, error: cause.message, loading: false }));
      }
      if (active && interval) timer = setTimeout(load, interval);
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, path, refresh, interval]);
  return state;
}
function ReadStatus({ state, onRetry, label }) {
  return <>{state.loading && <p role="status" className={styles.muted}>{state.data ? `Actualizando ${label}; se conserva la consulta de ${date(state.fetchedAt)}.` : `Cargando ${label}…`}</p>}{state.error && <div role="alert" className={styles.error}><p>{state.error}</p>{state.data && <p>Última consulta conservada: {date(state.fetchedAt)}. Puede estar desactualizada o corresponder a los filtros anteriores.</p>}<button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura</button></div>}</>;
}
function Pagination({ page, pages, total, onPage, disabled }) {
  return <nav className={styles.pagination} aria-label="Páginas del listado"><button type="button" className="button subtle" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Anterior</button><span>Página {page} de {pages}{total != null ? ` · ${total} registros` : ''}</span><button type="button" className="button subtle" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Siguiente</button></nav>;
}
function SelectField({ name, label, value, options, onChange }) {
  return <Field field={{ name, label, type: 'select', options }} value={value || ''} onChange={onChange}/>;
}
function useRequestIds() {
  const ids = useRef(new Map());
  return useCallback((key, payload) => {
    const fingerprint = JSON.stringify(payload), prior = ids.current.get(key);
    if (prior?.fingerprint === fingerprint) return prior.id;
    const id = crypto.randomUUID(); ids.current.set(key, { fingerprint, id }); return id;
  }, []);
}

export default function AdvertisingWorkspace({ api, view, onViewChange, onNavigate, onInteractionStateChange, onMutation, revision = 0 }) {
  const tab = tabs.some(item => item.id === view.tab) ? view.tab : 'campaigns';
  const [refresh, setRefresh] = useState(0), [inventory, setInventory] = useState({ data: null, error: '', loading: false, fetchedAt: null });
  const [notice, setNotice] = useState(''), [login, setLogin] = useState(null), [dialog, setDialog] = useState(null), [pauseRequests, setPauseRequests] = useState([]);
  const heading = useRef(null), interaction = useRef(new Map()), callbacks = useRef({}), mounted = useRef(true);
  callbacks.current = { onInteractionStateChange, onMutation, onViewChange, view };
  const report = useCallback((owner, state) => {
    interaction.current.set(owner, state);
    callbacks.current.onInteractionStateChange?.({ dirty: [...interaction.current.values()].some(item => item.dirty), busy: [...interaction.current.values()].some(item => item.busy) });
  }, []);
  const editorReport = useCallback(state => report('editor', state), [report]);
  const resultsReport = useCallback(state => report('results', state), [report]);
  const loginReport = useCallback(state => report('login', state), [report]);
  const dialogReport = useCallback(state => report('dialog', state), [report]);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = event => { if ([...interaction.current.values()].some(item => item.dirty || item.busy)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [tab, view.record]);
  const invalidate = useCallback(async () => {
    if (mounted.current) setRefresh(value => value + 1);
    try { await callbacks.current.onMutation?.(); } catch (cause) { if (mounted.current) setNotice(`Operación guardada; actualización general pendiente. ${cause.message}`); }
  }, []);
  const refreshKey = `${revision}:${refresh}`;
  const connectionRead = useRead(api, ROOT + '/connections', refreshKey, tab === 'connections' ? 5000 : 0);
  const connections = connectionRead.data?.connections || [];
  const pendingAssets = inventory.data?.assets.some(item => ['uploading', 'processing'].includes(item.state));
  useEffect(() => {
    const controller = new AbortController(); let active = true, timer;
    async function load() {
      if (!active) return;
      if (pendingAssets && tab === 'assets' && document.hidden) { timer = setTimeout(load, 5000); return; }
      setInventory(previous => ({ ...previous, loading: true }));
      try {
        const assets = []; let snapshot, offset = 0;
        do {
          snapshot = await api(`${ROOT}/assets?limit=100&offset=${offset}`, { signal: controller.signal });
          assets.push(...snapshot.assets); offset += snapshot.assets.length;
        } while (snapshot.assets.length === 100 && active);
        if (active) setInventory({ data: { ...snapshot, assets }, error: '', loading: false, fetchedAt: new Date().toISOString() });
      } catch (cause) { if (active && cause.name !== 'AbortError') setInventory(previous => ({ ...previous, error: cause.message, loading: false })); }
      if (active && pendingAssets && tab === 'assets') timer = setTimeout(load, 5000);
    }
    void load(); return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, refreshKey, tab, Boolean(pendingAssets)]);
  const listParams = new URLSearchParams({ page: String(view.page || 1) });
  for (const key of ['q', 'mode', 'network', 'objective', 'status']) if (view[key]) listParams.set(key, view[key]);
  const listPath = tab === 'campaigns' && !view.record ? `${ROOT}/campaigns?${listParams}` : null;
  const [listPending, setListPending] = useState(false);
  const campaignRead = useRead(api, listPath, refreshKey, listPending ? 5000 : 0);
  useEffect(() => { setListPending(Boolean(campaignRead.data?.campaigns.some(pendingCampaign))); }, [campaignRead.data]);
  const change = patch => onViewChange({ ...patch, page: patch.page ?? 1 });
  const navigate = patch => onNavigate ? onNavigate({ section: 'advertising', ...patch }) : change(patch);
  const committed = useCallback(result => {
    // Only release this editor's interaction after its complete commit chain.
    // Other owners remain guarded by the parent navigation machinery.
    report('editor', { dirty: false, busy: false });
    // Only a newly assigned record needs canonical navigation; saving in place keeps Back intact.
    if (result?.id && (callbacks.current.view.record !== result.id || callbacks.current.view.tab !== 'campaigns')) callbacks.current.onViewChange({ tab: 'campaigns', record: result.id, page: 1 });
    setRefresh(value => value + 1);
  }, [report]);
  function connectionCompleted(result) {
    if (result.disconnectPending) {
      setPauseRequests(previous => [...previous.filter(item => item.connectionId !== dialog?.connection.id), { connectionId: dialog?.connection.id, name: dialog?.connection.name, receiptId: result.receiptId, operationIds: result.operationIds || [] }]);
      setNotice(result.warning || 'Pausas encoladas. La desconexión espera confirmación remota; aún no se confirma que el gasto se detuvo.');
    } else if (result.receiptId) setNotice(`Eliminación local completada. Recibo ${result.receiptId}. ${result.remoteSpendStopped ? 'Pausa remota confirmada.' : 'No se confirmó la detención del gasto en Meta.'}`);
    else setNotice(result.warning || 'Conexión actualizada. Las publicaciones remotas no se eliminan.');
    report('dialog', { dirty: false, busy: false }); setDialog(null); void invalidate();
  }
  const readyAssets = inventory.data?.assets.filter(item => item.state === 'ready') || [];
  return <section className={styles.workspace} aria-label="Publicidad en redes sociales">
    <header className="workspace-heading"><div><p className={styles.eyebrow}>Facebook e Instagram · Orgánico y pauta</p><h1 ref={heading} tabIndex={-1} data-admin-section-heading>Publicidad</h1></div>{tab === 'campaigns' && !view.record && <button type="button" className="button primary" onClick={() => change({ record: 'new' })}>Preparar publicación</button>}</header>
    <WorkspaceTabs label="Vistas de publicidad" items={tabs} value={tab} onChange={value => change({ tab: value, record: null, status: null, q: null })} disabled={Boolean(dialog || login)}/>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {tab === 'campaigns' && view.record ? <>
      <button type="button" className="button subtle" onClick={() => change({ record: null })}>Volver al listado</button>
      <ReadStatus state={connectionRead} label="conexiones" onRetry={() => setRefresh(value => value + 1)}/><ReadStatus state={inventory} label="piezas privadas" onRetry={() => setRefresh(value => value + 1)}/>
      <AdvertisingCampaignEditor api={api} campaignId={view.record} connections={connections} assets={readyAssets} initialMode={view.mode || 'organic'} initialObjective={view.objective || 'engagement'} onSaved={committed} onNavigate={navigate} onInteractionStateChange={editorReport} onMutation={invalidate} revision={revision}/>
    </> : tab === 'campaigns' ? <>
      <div className={styles.filterBar}>
        <Field field={{ name: 'q', label: 'Buscar publicación', max: 200 }} value={view.q || ''} onChange={value => change({ q: value || null })}/>
        <SelectField name="mode" label="Modalidad" value={view.mode} options={[{ value: '', label: 'Todas' }, { value: 'organic', label: 'Orgánica, sin inversión' }, { value: 'paid', label: 'Pauta pagada' }]} onChange={value => change({ mode: value || null })}/>
        <SelectField name="network" label="Red" value={view.network} options={[{ value: '', label: 'Todas' }, { value: 'facebook', label: 'Facebook' }, { value: 'instagram', label: 'Instagram' }]} onChange={value => change({ network: value || null })}/>
        <SelectField name="objective" label="Objetivo" value={view.objective} options={[{ value: '', label: 'Todos' }, ...Object.entries(objectives).map(([value, label]) => ({ value, label }))]} onChange={value => change({ objective: value || null })}/>
        <SelectField name="status" label="Estado" value={view.status} options={[{ value: '', label: 'Todos' }, ...['draft', 'ready', 'scheduled', 'publishing', 'partial', 'published', 'in_review', 'active', 'paused', 'completed', 'failed', 'needs_attention', 'cancelled'].map(value => ({ value, label: states[value] }))]} onChange={value => change({ status: value || null })}/>
        <button type="button" className="button subtle" onClick={() => change({ mode: null, network: null, objective: null, status: null, q: null })}>Limpiar filtros</button>
      </div>
      <ReadStatus state={campaignRead} label="publicaciones" onRetry={() => setRefresh(value => value + 1)}/>
      {campaignRead.data && <><div className={styles.stack}>{campaignRead.data.campaigns.map(campaign => <CampaignRow key={campaign.id} campaign={campaign} onOpen={() => change({ record: campaign.id })} onResults={() => change({ tab: 'results', record: campaign.id })}/>)}</div>
        {!campaignRead.data.campaigns.length && <div className={`admin-empty ${styles.empty}`}><h2>{campaignRead.data.total ? 'No hay registros en esta página' : 'Sin publicaciones para estos filtros'}</h2><p>Conecta una cuenta, sube una pieza propia y prepara un borrador. Nada se publica ni invierte automáticamente.</p><div className={styles.actions}>{!connections.some(item => item.state === 'connected') && <button type="button" className="button subtle" onClick={() => change({ tab: 'connections', record: null, status: null })}>Conectar redes</button>}{!readyAssets.length && <button type="button" className="button subtle" onClick={() => change({ tab: 'assets', record: null, status: null })}>Subir piezas</button>}<button type="button" className="button primary" onClick={() => change({ record: 'new' })}>Preparar publicación</button></div></div>}
        <Pagination page={campaignRead.data.page} pages={campaignRead.data.pages} total={campaignRead.data.total} disabled={campaignRead.loading} onPage={page => change({ page })}/></>}
    </> : tab === 'assets' ? <AssetsPanel api={api} view={view} inventory={inventory} change={change} report={report} onMutation={invalidate} onRetry={() => setRefresh(value => value + 1)}/> : tab === 'results' ? <AdvertisingResults api={api} campaignId={view.record && view.record !== 'new' ? view.record : null} view={view} onViewChange={onViewChange} onNavigate={navigate} onInteractionStateChange={resultsReport} onMutation={invalidate} revision={revision}/> : <>
      <ReadStatus state={connectionRead} label="conexiones y estado del consumidor" onRetry={() => setRefresh(value => value + 1)}/>
      <ConnectionsIntro api={api} data={connectionRead.data} report={report} onMutation={invalidate} onCreated={connection => { setLogin(connection); change({ record: connection.id }); }}/>
      <div className={styles.stack}>{connections.map(connection => <ConnectionCard key={connection.id} api={api} connection={connection} selected={view.record === connection.id} report={report} onMutation={invalidate} onLogin={() => { setLogin(connection); change({ record: connection.id }); }} onAction={action => setDialog({ connection, action })}/>)}</div>
      {connectionRead.data && !connections.length && <div className={`admin-empty ${styles.empty}`}><h2>Conecta tu negocio</h2><p>Elige una vía arriba. API y navegador tienen requisitos independientes; una no sustituye a la otra ante un error.</p></div>}
      {pauseRequests.map(item => { const connection = connections.find(value => value.id === item.connectionId), receipt = connectionRead.data?.deletionReceipts?.find(value => value.receiptId === item.receiptId); return <article key={item.connectionId} className={styles.notice}><h3>Solicitud de pausa y desconexión · {item.name || 'Conexión'}</h3><p>{receipt ? 'Eliminación local completada tras pausa remota confirmada.' : connection?.state === 'disconnected' ? 'Desconexión completada. Consulta la evidencia de las entregas para el último estado confirmado.' : 'Pendiente: no se afirma que los anuncios hayan dejado de gastar.'}</p>{item.receiptId && <p>Recibo solicitado: {item.receiptId}</p>}<p>Operaciones: {item.operationIds.join(', ') || 'Sin identificadores disponibles'}</p></article>; })}
      {!!connectionRead.data?.deletionReceipts?.length && <details className={styles.evidence}><summary>Recibos de eliminación local</summary>{connectionRead.data.deletionReceipts.map(receipt => <article key={receipt.receiptId}><h3>{receipt.receiptId}</h3><p>{date(receipt.deletedAt)} · {receipt.remoteSpendStopped ? 'Pausa remota confirmada' : 'Detención del gasto no confirmada'} · No se borró contenido en Meta</p><dl className="summary-values">{Object.entries(receipt.counts || {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></article>)}</details>}
    </>}
    {login && <SocialBrowserLogin api={api} connection={login} onClose={() => { report('login', { dirty: false, busy: false }); setLogin(null); }} onConnected={invalidate} onInteractionStateChange={loginReport}/>}
    {dialog && <ConnectionDialog api={api} connection={dialog.connection} action={dialog.action} onClose={() => { report('dialog', { dirty: false, busy: false }); setDialog(null); }} onComplete={connectionCompleted} report={dialogReport}/>}
  </section>;
}

function CampaignRow({ campaign, onOpen, onResults }) {
  const deliveries = campaign.deliveries || [];
  const syncDates = deliveries.map(item => item.metricSync?.lastCompletedAt).filter(Boolean).sort();
  const spendSummary = campaign.lastMeasurementSummary, spend = spendSummary?.spendMinor;
  const spendText = spend?.value != null && ['reported', 'estimated'].includes(spend.status)
    ? `${money(spend.value, spendSummary.currency)}${spend.precision !== 'exact' || spend.status === 'estimated' ? ' · Estimado / precisión no exacta' : ''}`
    : 'No disponible';
  return <article className={styles.card}><header className={styles.toolbar}><div><h2>{campaign.name}</h2><p>{methods[campaign.integrationMethod] || 'Sin vía seleccionada'} · {campaign.mode === 'paid' ? 'Pauta pagada' : 'Orgánica, sin inversión'} · {objectives[campaign.objective]}</p></div><span className={styles.badge}>{states[campaign.state] || campaign.state}</span></header>
    <p>{campaign.platforms?.map(value => value === 'facebook' ? 'Facebook' : 'Instagram').join(' · ') || 'Sin destinos elegidos'}</p>
    {campaign.restoreHold || campaign.restore_hold ? <p className={styles.warning}>Restaurada: bloqueada hasta reconexión y reanudación explícita con reconciliación.</p> : null}
    <dl className="summary-values"><div><dt>{campaign.mode === 'paid' ? 'Inicio / fin' : 'Publicación'}</dt><dd>{campaign.mode === 'paid' ? `${date(campaign.startAt)} / ${date(campaign.endAt)}` : campaign.publishAt ? date(campaign.publishAt) : 'Inmediata al aprobar y ejecutar'}</dd></div><div><dt>Gasto reportado</dt><dd>{spendText}{spendSummary && <small className={styles.muted}> · {spendSummary.complete ? 'Consulta completa' : 'Cobertura parcial'} · {date(spendSummary.fetchedAt)} · {methods[spendSummary.integrationMethod] || 'Fuente no informada'}</small>}</dd></div><div><dt>Última sincronización completa</dt><dd>{date(syncDates.at(-1))}</dd></div></dl>
    {deliveries.length > 0 && <ul className={styles.choiceList}>{deliveries.map(delivery => <li key={delivery.id}><strong>{delivery.channel === 'meta_ads' ? 'Pauta Meta · presupuesto único' : delivery.channel === 'facebook' ? 'Facebook' : 'Instagram'}</strong>: {states[delivery.state] || delivery.state}{delivery.lastConfirmedState && <span> · Último confirmado: {states[delivery.lastConfirmedState] || delivery.lastConfirmedState}</span>}<p className={styles.muted}>Próxima consulta: {date(delivery.nextSyncAt)}{delivery.metricSync?.lastError?.code ? ` · ${delivery.metricSync.lastError.code}` : ''}</p>{['queued', 'scheduled'].includes(delivery.state) && campaign.publishAt && Date.parse(campaign.publishAt) < Date.now() - 900000 && <p className={styles.warning}>Horario vencido por más de 15 minutos: requiere revisión; no se presenta como publicada.</p>}</li>)}</ul>}
    <div className={styles.actions}><button type="button" className="button primary" onClick={onOpen}>Abrir {campaign.state === 'draft' ? 'borrador' : 'publicación'}</button><button type="button" className="button subtle" onClick={onResults}>Ver resultados y evidencia</button></div>
  </article>;
}

function ConnectionsIntro({ api, data, report, onMutation, onCreated }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), controllers = useRef(new Set()), rid = useRequestIds();
  useEffect(() => { report('connection-create', { dirty: Boolean(name), busy }); }, [name, busy, report]);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); report('connection-create', { dirty: false, busy: false }); }, [report]);
  async function connect(method) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); controllers.current.add(controller);
    try {
      if (method === 'api') {
        const result = await api(ROOT + '/oauth/start', { method: 'POST', body: JSON.stringify({}), signal: controller.signal });
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com' || url.username || url.password) throw new Error('El servidor devolvió una autorización no válida.');
        report('connection-create', { dirty: Boolean(name), busy: false });
        window.location.assign(url.href);
      } else {
        const payload = { integrationMethod: 'browser', name: name.trim() };
        const connection = await api(ROOT + '/connections', { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid('browser-create', payload) }), signal: controller.signal });
        setName(''); await onMutation(); report('connection-create', { dirty: false, busy: false }); onCreated(connection);
      }
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { controllers.current.delete(controller); locked.current = false; setBusy(false); }
  }
  return <><div className={styles.grid}>{['api', 'browser'].map(method => { const requirement = data?.requirements?.find(item => item.integrationMethod === method), available = requirement?.configured && requirement.enabled; return <article className={styles.card} key={method}><h2>{methods[method]}</h2><p>{method === 'api' ? 'Autoriza mediante Facebook Login for Business. No se solicita contraseña en este panel; el token se cifra en servidor y tiene caducidad real.' : 'Acceso asistido con visor privado. Las cookies se conservan cifradas; no guardamos contraseña, OTP ni capturas. No necesita META_APP_* ni cambia automáticamente desde API.'}</p>{method === 'browser' && <p className={styles.warning}>Requiere permiso previo de Meta para automatización. Un desafío, sesión vencida o cambio de interfaz detiene operaciones; no se evade.</p>}{!requirement ? <p>Consultando requisitos…</p> : <><p>{available ? 'Configuración de esta vía disponible' : !requirement.enabled ? 'Vía deshabilitada en este despliegue' : 'Configuración incompleta o inválida'}</p>{requirement.missing?.length > 0 && <p>Falta configurar en servidor: {requirement.missing.join(', ')}</p>}{requirement.invalid?.length > 0 && <p>Revisar en servidor: {requirement.invalid.join(', ')}</p>}{!requirement.publishingEnabled && <p className={styles.warning}>Publicar, activar y reanudar está deshabilitado. Preparar un borrador local no autoriza gasto; una pausa segura sigue siendo posible con acceso válido.</p>}</>}{method === 'browser' ? <form method="post" onSubmit={event => { event.preventDefault(); void connect(method); }} ><Field field={{ name: 'browserName', label: 'Nombre de la conexión', required: true, max: 200 }} value={name} onChange={setName}/><button type="submit" className="button primary" disabled={busy || !available || !name.trim()}>Crear conexión y abrir acceso</button></form> : <button type="button" className="button primary" disabled={busy || !available} onClick={() => connect(method)}>Conectar API oficial</button>}</article>; })}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {data && <aside className={styles.panel}><h2>Salud del navegador independiente de la sesión Meta</h2><p>Runner privado: {{ available: 'Disponible', unavailable: 'No disponible', disabled: 'Deshabilitado', unconfigured: 'Sin configurar' }[data.browserRunner?.status] || 'Sin dato'} · Comprobado: {date(data.browserRunner?.checkedAt)}</p><p>Consumidor navegador: {{ running: 'Operativo', never: 'Sin primer heartbeat', stale: 'Heartbeat atrasado / worker caído', error: 'Error del worker', clock_skew: 'Desfase de reloj' }[data.browserWorker?.status] || 'Sin dato'} · Último heartbeat: {date(data.browserWorker?.lastHeartbeatAt)}</p>{data.browserWorker?.errorCode && <p>{data.browserWorker.errorCode}</p>}<p className={styles.muted}>Un worker sano no acredita sesión social vigente. Un runner caído no cambia la vía de una campaña API.</p></aside>}
  </>;
}

function ConnectionCard({ api, connection, selected, report, onMutation, onLogin, onAction }) {
  const currentIds = connection.identities || {}, initial = () => Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, currentIds[key] || '']));
  const [selection, setSelection] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selectionRef = useRef(selection), baseline = useRef(JSON.stringify(initial())), locked = useRef(false), requests = useRef(new Set()), rid = useRequestIds(), owner = `connection:${connection.id}`;
  const dirty = JSON.stringify(selection) !== baseline.current;
  useEffect(() => {
    if (JSON.stringify(selectionRef.current) !== baseline.current) return;
    const next = Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, connection.identities?.[key] || '']));
    baseline.current = JSON.stringify(next); selectionRef.current = next; setSelection(next);
  }, [connection.version, connection.identities]);
  useEffect(() => { report(owner, { dirty, busy }); }, [owner, dirty, busy, report]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report(owner, { dirty: false, busy: false }); }, [owner, report]);
  function choose(key, value) {
    const next = { ...selection, [key]: value };
    if (key === 'pageId') next.instagramId = connection.resources?.pages?.find(item => item.id === value)?.instagramId || '';
    selectionRef.current = next; setSelection(next);
  }
  async function act(action) {
    if (locked.current) return;
    if (action === 'select-assets') {
      const account = connection.resources?.adAccounts?.find(item => item.id === selection.adAccountId);
      if (account?.currency !== connection.currency && !window.confirm(`Cambiar la cuenta cambia la moneda de ${connection.currency || 'sin seleccionar'} a ${account?.currency || 'sin moneda'}. Los borradores deben revalidarse y volver a ingresar el presupuesto, sin reinterpretar importes. ¿Continuar?`)) return;
      if (!window.confirm('Confirma los recursos profesionales seleccionados. Una conexión utilizada por una aprobación no puede cambiar de identidades; se necesita una nueva conexión.')) return;
    }
    locked.current = true; setBusy(true); setError(''); setNotice(''); const controller = new AbortController(); requests.current.add(controller);
    try {
      if (action === 'oauth') {
        const value = await api(ROOT + '/oauth/start', { method: 'POST', body: JSON.stringify({ connectionId: connection.id }), signal: controller.signal });
        const url = new URL(value.authorizationUrl); if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com' || url.username || url.password) throw new Error('URL de autorización no válida.');
        report(owner, { dirty, busy: false });
        window.location.assign(url.href); return;
      }
      const payload = { action, version: connection.version, ...(action === 'select-assets' ? { identities: Object.fromEntries(Object.entries(selection).map(([key, value]) => [key, value || null])) } : {}) };
      const result = await api(`${ROOT}/connections/${encodeURIComponent(connection.id)}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(action, payload) }), signal: controller.signal });
      if (action === 'select-assets') { const next = Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, result.identities?.[key] || ''])); baseline.current = JSON.stringify(next); selectionRef.current = next; setSelection(next); }
      setNotice(`Validación terminada: ${states[result.state] || result.state}. Sólo se habilitan las capacidades comprobadas.`); await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  const resources = connection.resources || {}, page = resources.pages?.find(item => item.id === selection.pageId);
  return <article className={styles.card} aria-label={connection.name || 'Conexión Meta'} aria-current={selected ? 'true' : undefined}><header className={styles.toolbar}><div><h2>{connection.name || 'Conexión Meta'}</h2><p>{methods[connection.integrationMethod]} · Versión {connection.version}</p></div><span className={styles.badge}>{states[connection.state] || connection.state}</span></header>
    <dl className="summary-values"><div><dt>Usuario verificado</dt><dd>{currentIds.userName || currentIds.userId || 'No verificado'}</dd></div><div><dt>Negocio / página / Instagram</dt><dd>{currentIds.businessId || 'Sin negocio'} / {currentIds.pageId || 'Sin página'} / {currentIds.instagramId || 'Sin Instagram profesional'}</dd></div><div><dt>Cuenta publicitaria</dt><dd>{currentIds.adAccountId || 'No seleccionada'} · {connection.currency || 'Sin moneda'} · {connection.timeZone || 'Sin zona verificada'}</dd></div><div><dt>Última validación / consulta</dt><dd>{date(connection.validatedAt)}</dd></div><div><dt>Caducidad informada</dt><dd>{connection.expiresAt ? date(connection.expiresAt) : 'No informada; no significa sesión perpetua'}</dd></div></dl>
    {connection.disconnectStatus && <div className={styles.warning} role="status"><p>{connection.disconnectStatus.state === 'needs_confirmation' ? 'Las cantidades o la autorización cambiaron. Revisa y confirma de nuevo la desconexión/eliminación.' : 'Pausas pendientes de confirmar antes de desconectar. Aún no se afirma que se detuvo el gasto.'}</p><p>Solicitada: {date(connection.disconnectStatus.requestedAt)}</p>{connection.disconnectStatus.receiptId && <p>Recibo solicitado: {connection.disconnectStatus.receiptId}</p>}{connection.disconnectStatus.state === 'needs_confirmation' && <button type="button" className="button subtle" disabled={busy || dirty} onClick={() => onAction(connection.disconnectStatus.action)}>Revisar y confirmar de nuevo</button>}</div>}
    <ul className={styles.choiceList}>{Object.entries(capabilities).map(([key, label]) => <li key={key}>{label}: <strong>{connection.state === 'connected' && connection.capabilities?.[key] ? 'Disponible' : 'No acreditada / no disponible'}</strong></li>)}</ul>
    {connection.resourceNotice && <p className={styles.notice}>{connection.resourceNotice}</p>}
    {connection.state === 'layout_changed' && <p className={styles.warning}>No se harán clics alternativos: se requiere corregir y revalidar la versión del adaptador.</p>}
    {connection.state === 'challenge_required' && <p className={styles.warning}>Completa el desafío personalmente en el visor; no hay evasión ni reintento de contraseña.</p>}
    <details className={styles.detail} open={dirty || undefined}><summary>Recursos y permisos verificados</summary><p>Selecciona únicamente recursos descubiertos por esta vía. No se aceptan identificadores escritos libremente ni cambios de recursos de una conexión aprobada.</p>
      <fieldset disabled={busy || connection.state !== 'connected'} className={styles.fieldGrid}><legend>Recursos profesionales</legend>
        <SelectField name={`business-${connection.id}`} label="Negocio" value={selection.businessId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.businesses || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('businessId', value)}/>
        <SelectField name={`page-${connection.id}`} label="Página Facebook" value={selection.pageId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.pages || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('pageId', value)}/>
        <SelectField name={`instagram-${connection.id}`} label="Instagram profesional vinculado" value={selection.instagramId} options={[{ value: '', label: 'Sin seleccionar' }, ...(page?.instagramId ? [{ value: page.instagramId, label: page.instagramId }] : [])]} onChange={value => choose('instagramId', value)}/>
        <SelectField name={`account-${connection.id}`} label="Cuenta de anuncios" value={selection.adAccountId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.adAccounts || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.currency || 'Sin moneda'} · ${item.timeZone || 'Sin zona'}` }))]} onChange={value => choose('adAccountId', value)}/>
      </fieldset><p>Scopes concedidos: {connection.permissions?.join(', ') || 'No informados por esta vía'}</p><p>Adaptador: {connection.adapterVersion || 'Versión no informada'} · Formato: {connection.locale || 'No informado'}</p><button type="button" className="button primary" disabled={busy || !dirty || connection.state !== 'connected'} onClick={() => act('select-assets')}>Confirmar y revalidar recursos</button>
    </details>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || dirty} onClick={() => act('validate')}>Revalidar conexión</button><button type="button" className="button subtle" disabled={busy || dirty} onClick={() => connection.integrationMethod === 'api' ? act('oauth') : onLogin()}>{connection.integrationMethod === 'api' ? 'Reconectar por OAuth' : 'Abrir acceso asistido'}</button><button type="button" className="button subtle" disabled={busy || dirty || connection.state === 'disconnected'} onClick={() => onAction('disconnect')}>Desconectar…</button><button type="button" className="button danger" disabled={busy || dirty} onClick={() => onAction('delete-platform-data')}>Eliminar datos de plataforma…</button></div>
  </article>;
}

function ConnectionDialog({ api, connection, action, onClose, onComplete, report }) {
  const deleting = action === 'delete-platform-data', ref = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [pause, setPause] = useState(true), [warningAccepted, setWarningAccepted] = useState(false), [retry, setRetry] = useState(0);
  const close = useDialog(ref, { busy, dirty: confirm || warningAccepted || !pause, onClose });
  useEffect(() => { report({ busy, dirty: confirm || warningAccepted || !pause }); }, [busy, confirm, warningAccepted, pause, report]);
  useEffect(() => {
    if (!deleting) return;
    const controller = new AbortController(); requests.current.add(controller); setError('');
    api(`${ROOT}/connections/${connection.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'preview-delete-platform-data' }), signal: controller.signal }).then(setPreview).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => { controller.abort(); requests.current.delete(controller); };
  }, [api, connection.id, deleting, retry]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report({ busy: false, dirty: false }); }, [report]);
  async function submit(event) {
    event.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const payload = { action, version: connection.version, pauseAndDisconnect: pause, acceptActiveAdsWarning: !pause && warningAccepted, ...(deleting ? { confirmDelete: confirm, confirmCounts: preview?.counts } : {}) };
      const result = await api(`${ROOT}/connections/${connection.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(action, payload) }), signal: controller.signal });
      report({ dirty: false, busy: false }); onComplete(result);
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog}`} aria-labelledby="social-connection-action-title"><form method="post" onSubmit={submit} ><header className={styles.dialogHeader}><h2 id="social-connection-action-title">{deleting ? 'Eliminar datos locales de plataforma' : 'Desconectar cuenta'} · {connection.name || methods[connection.integrationMethod]}</h2></header><div className={styles.dialogBody}>
    <p>Se cancelará el trabajo no enviado y se retirará la autenticación. No se borran publicaciones en Meta. Un envío incierto debe reconciliarse, no publicarse otra vez.</p>
    {deleting && <><p>Se eliminarán campañas, revisiones, mediciones, previsiones, mejoras y sus vínculos. Los pedidos, gastos, pagos y piezas subidas permanecen. Esto no despublica ni garantiza detener anuncios remotos.</p>{preview ? <dl className="summary-values">{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <p role="status">Consultando cantidades actuales…</p>}<label className={styles.checkRow}><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={busy || !preview}/>Confirmo eliminar definitivamente estas cantidades de datos locales.</label></>}
    <label className={styles.checkRow}><input type="checkbox" checked={pause} onChange={event => setPause(event.target.checked)} disabled={busy} data-dialog-initial-focus/>Pausar anuncios y comprobar su estado antes de desconectar{deleting ? ' y eliminar' : ''}.</label>
    <p className={styles.muted}>Por navegador, esta acción puede quedar pendiente del consumidor. Se conserva la custodia hasta confirmar las pausas. Si faltan permisos, detén los anuncios directamente en Meta.</p>
    {!pause && <label className={styles.checkRow}><input type="checkbox" checked={warningAccepted} onChange={event => setWarningAccepted(event.target.checked)} disabled={busy}/>Acepto que pueden seguir gastando y que debo detenerlos directamente en Meta; la desconexión local no confirma una pausa.</label>}
    {error && <div className={styles.error} role="alert"><p>{error}</p>{deleting && <button type="button" className="button subtle" disabled={busy} onClick={() => { setConfirm(false); setPreview(null); setRetry(value => value + 1); }}>Revisar cantidades otra vez</button>}</div>}
    </div><footer className={styles.actions}><button type="button" className="button subtle" disabled={busy} onClick={close}>Cancelar</button><button type="submit" className={`button ${deleting ? 'danger' : 'primary'}`} disabled={busy || (deleting && (!preview || !confirm)) || (!pause && !warningAccepted)}>{busy ? 'Registrando solicitud…' : pause ? `Pausar y ${deleting ? 'eliminar datos' : 'desconectar'}` : deleting ? 'Eliminar sólo datos locales' : 'Desconectar sin afirmar pausa'}</button></footer></form></dialog>;
}

function AssetsPanel({ api, view, inventory, change, report, onMutation, onRetry }) {
  const [file, setFile] = useState(null), [name, setName] = useState(''), [busy, setBusy] = useState(false), [phase, setPhase] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [slot, setSlot] = useState(null);
  const input = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const assets = inventory.data?.assets || [], stateFilter = ['uploading', 'processing', 'ready', 'failed', 'archived', 'missing_file'].includes(view.status) ? view.status : '';
  const filtered = assets.filter(asset => !stateFilter || asset.state === stateFilter), page = Number(view.page || 1), pages = Math.max(1, Math.ceil(filtered.length / 20));
  const selected = view.record ? assets.find(asset => asset.id === view.record) : null, quota = inventory.data?.quota;
  const fileSelection = useRef(null);
  useEffect(() => { report('assets', { dirty: Boolean(file || name), busy }); }, [file, name, busy, report]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report('assets', { dirty: false, busy: false }); }, [report]);
  function pick(value) {
    fileSelection.current = value ? crypto.randomUUID() : null;
    setError(''); setSlot(null); setFile(value); setName(value?.name || '');
    if (!value) return;
    const image = ['image/jpeg', 'image/png', 'image/webp'].includes(value.type), video = ['video/mp4', 'video/quicktime'].includes(value.type);
    if ((!image && !video) || value.size <= 0 || value.size > (image ? 10 : 250) * 1048576) setError('Archivo no admitido. Usa JPEG/PNG/WebP de hasta 10 MiB o MP4/MOV de hasta 250 MiB; no se admite un archivo vacío.');
  }
  async function upload(event) {
    event.preventDefault(); if (locked.current || !file) return; locked.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const payload = { name: name.trim(), contentType: file.type, expectedBytes: file.size };
      const image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), video = ['video/mp4', 'video/quicktime'].includes(file.type);
      if ((!image && !video) || file.size <= 0 || file.size > (image ? 10 : 250) * 1048576) throw new Error('El tipo o tamaño del archivo no cumple los límites indicados. El servidor comprobará además su contenido real.');
      if (!payload.name) throw new Error('Escribe el nombre de la pieza.');
      setPhase('Reservando espacio privado para original y derivado…');
      const reserved = slot || await api(ROOT + '/assets', { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid('reserve', { ...payload, selectionId: fileSelection.current, fileName: file.name, lastModified: file.lastModified }) }), signal: controller.signal });
      setSlot(reserved); setPhase('Enviando archivo original; aún no es publicable…');
      const uploaded = await api(`${ROOT}/assets/${reserved.id}/content`, { method: 'PUT', body: file, headers: { 'content-type': file.type, 'x-asset-version': String(reserved.version), 'x-request-id': rid(`upload:${reserved.id}`, { version: reserved.version, size: file.size, type: file.type }) }, signal: controller.signal });
      if (!['processing', 'ready'].includes(uploaded.state)) throw new Error(uploaded.diagnostic?.message || `La pieza está en estado ${states[uploaded.state] || uploaded.state}. Selecciona una carga nueva si el original no fue recibido íntegro.`);
      setFile(null); setName(''); setSlot(null); if (input.current) input.current.value = '';
      report('assets', { dirty: false, busy: false }); setNotice('Original recibido. Procesamiento encolado; no será publicable hasta verificar el derivado normalizado.');
      await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') { setError(`No se confirmó la carga completa. Revisa el estado guardado antes de reenviar; una carga interrumpida requiere una nueva pieza. ${cause.message}`); onRetry(); } }
    finally { requests.current.delete(controller); locked.current = false; setBusy(false); setPhase(''); }
  }
  async function action(asset, actionName) {
    if (locked.current) return;
    if (actionName === 'archive' && !window.confirm(`¿Archivar «${asset.name}»? No se borran archivos ni historia, no se libera espacio ocupado y no se modifica contenido publicado. Una entrega pendiente puede impedirlo.`)) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); requests.current.add(controller);
    try {
      const payload = { action: actionName, version: asset.version };
      await api(`${ROOT}/assets/${asset.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`${actionName}:${asset.id}`, payload) }), signal: controller.signal });
      setNotice(actionName === 'archive' ? 'Pieza archivada; conserva archivos e historia.' : 'Procesamiento encolado. Espera un derivado verificado antes de publicar.'); await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  function renderAsset(asset, detail = false) {
    return <article className={styles.card} key={asset.id}><header className={styles.toolbar}><div><h2>{asset.name}</h2><p>{asset.kind === 'video' ? 'Video' : 'Imagen'} · {states[asset.state] || asset.state}</p></div>{!detail && <button type="button" className="button subtle" disabled={busy} onClick={() => change({ record: asset.id, page })}>Ver pieza</button>}</header>
      <p>Registrada: {date(asset.createdAt)} · Original: {bytes(asset.originalBytes ?? asset.expectedBytes)} · Derivado: {bytes(asset.derivativeBytes)}</p>
      {asset.diagnostic && <p className={styles.warning}>{asset.diagnostic.message || asset.diagnostic.code}</p>}
      {asset.state === 'uploading' && <p>Reserva de carga hasta {date(asset.uploadExpiresAt)}. Si la carga quedó incompleta, espera su diagnóstico o registra una nueva pieza; no se supone que el archivo existe.</p>}
      {asset.state === 'processing' && <p role="status">El worker está preparando y verificando el archivo. Esta pieza todavía no puede aprobarse.</p>}
      {asset.state === 'missing_file' && <p className={styles.warning}>Falta el archivo del volumen privado. Restaura el volumen y solicita comprobación de SHA-256 al administrador del despliegue; reconectar Meta no restaura archivos. La historia se conserva y no puede republicarse.</p>}
      {detail && ['ready', 'archived'].includes(asset.state) && asset.derivativeSha256 && <div className={styles.assetPreview}>{asset.kind === 'video' ? <video className={styles.previewVideo} controls preload="metadata" playsInline src={`${ROOT}/assets/${asset.id}/content?variant=derivative`} aria-label={`Vista previa privada de ${asset.name}`} onError={() => setError('No se pudo leer el derivado privado. Comprueba sesión y restauración/verificación del volumen; no se considera publicable un archivo ausente.')}/> : <img className={styles.previewImage} src={`${ROOT}/assets/${asset.id}/content?variant=derivative`} alt={`Derivado normalizado de ${asset.name}`} onError={() => setError('No se pudo leer la vista previa privada. Comprueba sesión y restauración/verificación del volumen.')}/>}</div>}
      {detail && <dl className="summary-values"><div><dt>Archivo aprobado</dt><dd>{asset.derivativeContentType || 'Sin derivado'} · {asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Dimensiones no informadas'}</dd></div><div><dt>SHA-256 del derivado</dt><dd className={styles.evidence}>{asset.derivativeSha256 || 'Todavía no verificado'}</dd></div></dl>}
      <div className={styles.actions}>{asset.state === 'failed' && asset.originalSha256 && asset.originalBytes > 0 && <button type="button" className="button primary" disabled={busy} onClick={() => action(asset, 'retry-processing')}>Reintentar procesamiento</button>}{['ready', 'failed'].includes(asset.state) && <button type="button" className="button subtle" disabled={busy} onClick={() => action(asset, 'archive')}>Archivar con confirmación</button>}</div>
    </article>;
  }
  return <><section className={styles.panel}><h2>Subir una pieza ya creada</h2><p>Almacenamiento privado, independiente del catálogo. No se genera, recorta ni edita la pieza. El original no se publica; la aprobación usa el derivado que verás en la vista previa.</p><ul className={styles.choiceList}><li>Imagen JPEG/PNG/WebP: hasta 10 MiB, un fotograma y 40 megapíxeles. Proporción de 4:5 a 1,91:1 y ancho mínimo de 320 px; se normaliza a JPEG sRGB sin ampliar y hasta 1440 px.</li><li>Video MP4/MOV: hasta 250 MiB, vertical 9:16, mínimo 540 × 960 y entre 3 y 90 segundos. Derivado real H.264/AAC a 30 fps, hasta 1080 × 1920; no se inventa audio ni se recorta.</li></ul>
    {quota && <dl className="summary-values"><div><dt>Cuota privada</dt><dd>{bytes(quota.limitBytes)}</dd></div><div><dt>Ocupado</dt><dd>{bytes(quota.usedBytes)}</dd></div><div><dt>Reservado para cargas concurrentes</dt><dd>{bytes(quota.reservedBytes)}</dd></div><div><dt>Disponible</dt><dd>{bytes(quota.availableBytes)}</dd></div></dl>}
    <form method="post" onSubmit={upload} ><fieldset disabled={busy} className={styles.fieldGrid}><legend>Archivo propio</legend><label className="field">Pieza<input ref={input} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mov" onChange={event => pick(event.target.files?.[0] || null)}/></label><Field field={{ name: 'assetName', label: 'Nombre de la pieza', required: true, max: 200 }} value={name} onChange={value => { setName(value); setSlot(null); }}/></fieldset>{file && <p>{file.name} · {bytes(file.size)} · Los bytes se envían directamente desde el archivo, sin cargar el video completo en memoria.</p>}<div className={styles.actions}><button type="submit" className="button primary" disabled={busy || !file || !name.trim()}>{busy ? 'Carga en curso…' : slot ? 'Consultar/reintentar misma carga' : 'Reservar y subir pieza'}</button>{file && <button type="button" className="button subtle" disabled={busy} onClick={() => { setFile(null); setName(''); setSlot(null); if (input.current) input.current.value = ''; }}>Descartar selección local</button>}</div></form>
    {phase && <p role="status">{phase}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}</section>
    <ReadStatus state={inventory} label="piezas y cuota" onRetry={onRetry}/>
    {view.record && <section className={styles.detail}><button type="button" className="button subtle" disabled={busy} onClick={() => change({ record: null, page })}>Cerrar pieza</button>{selected ? renderAsset(selected, true) : !inventory.loading && <p role="status">La pieza no aparece en la lectura actual. Reintenta la consulta; no se sustituye por otro archivo.</p>}</section>}
    <div className={styles.filterBar}><SelectField name="assetState" label="Estado de pieza" value={stateFilter} options={[{ value: '', label: 'Todos' }, ...['uploading', 'processing', 'ready', 'failed', 'archived', 'missing_file'].map(value => ({ value, label: states[value] }))]} onChange={value => change({ status: value || null, record: null })}/></div>
    <div className={styles.stack}>{filtered.slice((page - 1) * 20, page * 20).map(asset => renderAsset(asset))}</div>
    {!inventory.loading && !filtered.length && <div className={`admin-empty ${styles.empty}`}><h2>Sin piezas para este estado</h2><p>Sube arriba una imagen o video propios con los requisitos indicados. Ninguna pieza de ejemplo se añade automáticamente.</p></div>}
    <Pagination page={page} pages={pages} total={filtered.length} disabled={busy || inventory.loading} onPage={value => change({ page: value, record: null })}/>
  </>;
}
