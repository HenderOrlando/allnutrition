'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import { Field } from './Fields';
import AdvertisingCampaignEditor from './AdvertisingCampaignEditor';
import AdvertisingResults from './AdvertisingResults';
import AdvertisingGuide from './AdvertisingGuide';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const tabs = [{ id: 'campaigns', label: 'Publicaciones' }, { id: 'assets', label: 'Imágenes y videos' }, { id: 'results', label: 'Resultados' }];
const states = { draft: 'Borrador', ready: 'Preparada, sin gasto autorizado', scheduled: 'Programada', publishing: 'En preparación o publicación', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Falló', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Envío incierto: comprobar estado en Meta sin reenviar', blocked: 'Bloqueada', connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };
const ASSET_STATES = { uploading: 'Carga pendiente o en curso', processing: 'Preparando archivo', ready: 'Lista para usar', failed: 'No se pudo preparar', archived: 'Archivada', missing_file: 'Archivo no disponible' };
const objectives = { whatsapp: 'Consultas por WhatsApp', traffic: 'Clics al sitio web', reach: 'Alcance', engagement: 'Interacción' };
const methods = { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' };
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
  const errorRef = useRef(null);
  useEffect(() => { if (state.error) errorRef.current?.focus(); }, [state.error]);
  return <>{state.loading && <p role="status" className={styles.muted}>{state.data ? `Actualizando ${label}; se conserva la consulta de ${date(state.fetchedAt)}.` : `Cargando ${label}…`}</p>}{state.error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{state.error}</p>{state.data && <p>Última consulta conservada: {date(state.fetchedAt)}. Puede estar desactualizada o corresponder a los filtros anteriores.</p>}<button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura</button></div>}</>;
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
  const [notice, setNotice] = useState('');
  const heading = useRef(null), queryPanel = useRef(null), interaction = useRef(new Map()), callbacks = useRef({}), mounted = useRef(true);
  callbacks.current = { onInteractionStateChange, onMutation, onViewChange, view };
  const report = useCallback((owner, state) => {
    interaction.current.set(owner, state);
    callbacks.current.onInteractionStateChange?.({ dirty: [...interaction.current.values()].some(item => item.dirty), busy: [...interaction.current.values()].some(item => item.busy) });
  }, []);
  const editorReport = useCallback(state => report('editor', state), [report]);
  const resultsReport = useCallback(state => report('results', state), [report]);
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
  const connectionRead = useRead(api, ROOT + '/connections', refreshKey);
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
  const readyAssets = inventory.data?.assets.filter(item => item.state === 'ready') || [];
  const campaignFilters = [
    ['q', 'Búsqueda', view.q], ['mode', 'Tipo de publicación', { organic: 'Publicación sin inversión', paid: 'Anuncio pagado' }[view.mode]],
    ['status', 'Estado', states[view.status]], ['network', 'Red', { facebook: 'Facebook', instagram: 'Instagram' }[view.network]],
    ['objective', 'Objetivo', objectives[view.objective]]
  ].filter(([key]) => Boolean(view[key]));
  const clearCampaignFilters = () => { change({ q: null, mode: null, status: null, network: null, objective: null, record: null, page: 1 }); queryPanel.current?.querySelector('input[name="q"]')?.focus(); };
  const currentCampaignQuery = campaignRead.path === listPath;
  return <section className={styles.workspace} aria-label="Publicidad en redes sociales">
    <header className="workspace-heading"><div><p className={styles.eyebrow}>Facebook e Instagram</p><h1 ref={heading} tabIndex={-1} data-admin-section-heading>Publicidad</h1><p>Prepara publicaciones, organiza tus imágenes y videos y revisa sus resultados. Tú decides qué se publica y cuándo autorizas inversión.</p></div>{tab === 'campaigns' && !view.record && <button type="button" className="button primary" onClick={() => change({ record: 'new' })}>Crear publicación</button>}</header>
    <AdvertisingGuide key={tab} tab={tab}/>
    <WorkspaceTabs label="Vistas de publicidad" items={tabs} value={tab} onChange={value => change({ tab: value, record: null, status: null, q: null })}/>
    <p className={styles.taskIntro}>{{ campaigns: 'Guarda ideas como borradores y retómalas después. Guardar no publica ni autoriza gasto.', assets: 'Sube archivos propios, espera a que estén listos y revisa su vista previa antes de usarlos.', results: 'Revisa qué informó cada red y qué datos faltan. Los resultados de Meta y los registros de tu negocio son distintos.' }[tab]}</p>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {tab === 'campaigns' && view.record ? <>
      <ReadStatus state={connectionRead} label="cuentas conectadas" onRetry={() => setRefresh(value => value + 1)}/><ReadStatus state={inventory} label="imágenes y videos privados" onRetry={() => setRefresh(value => value + 1)}/>
      <AdvertisingCampaignEditor api={api} campaignId={view.record} connections={connections} assets={readyAssets} initialMode={view.mode || 'organic'} initialObjective={view.objective || 'engagement'} onSaved={committed} onNavigate={navigate} onInteractionStateChange={editorReport} onMutation={invalidate} revision={revision}/>
    </> : tab === 'campaigns' ? <>
      <section ref={queryPanel} className={styles.queryPanel} aria-label="Buscar y filtrar publicaciones">
        <div className={styles.filterBar}>
          <Field field={{ name: 'q', label: 'Buscar publicación', max: 100 }} value={view.q || ''} onChange={value => change({ q: value || null })}/>
          <SelectField name="mode" label="Tipo de publicación" value={view.mode} options={[{ value: '', label: 'Todas' }, { value: 'organic', label: 'Publicación sin inversión' }, { value: 'paid', label: 'Anuncio pagado' }]} onChange={value => change({ mode: value || null })}/>
          <SelectField name="status" label="Estado" value={view.status} options={[{ value: '', label: 'Todos' }, ...['draft', 'ready', 'scheduled', 'publishing', 'partial', 'published', 'in_review', 'active', 'paused', 'completed', 'failed', 'needs_attention', 'cancelled'].map(value => ({ value, label: states[value] }))]} onChange={value => change({ status: value || null })}/>
        </div>
        <details className={styles.filterDetails}><summary>Más filtros</summary><div className={styles.fieldGrid}>
          <SelectField name="network" label="Red" value={view.network} options={[{ value: '', label: 'Todas' }, { value: 'facebook', label: 'Facebook' }, { value: 'instagram', label: 'Instagram' }]} onChange={value => change({ network: value || null })}/>
          <SelectField name="objective" label="Objetivo" value={view.objective} options={[{ value: '', label: 'Todos' }, ...Object.entries(objectives).map(([value, label]) => ({ value, label }))]} onChange={value => change({ objective: value || null })}/>
        </div></details>
        {campaignFilters.length ? <div className="active-filters" aria-label="Filtros activos">{campaignFilters.map(([key, label, value]) => <button key={key} type="button" className="filter-chip" aria-label={`Quitar filtro: ${label}: ${value}`} onClick={() => { change({ [key]: null, page: 1 }); queryPanel.current?.querySelector('input[name="q"]')?.focus(); }}>{label}: {value} <span aria-hidden="true">×</span></button>)}<button type="button" className="text-button" onClick={clearCampaignFilters}>Limpiar filtros</button></div> : <p className={styles.help}>Se muestran todas las publicaciones</p>}
        <p className={styles.help}>Últimas actualizadas primero</p>
      </section>
      <ReadStatus state={campaignRead} label="publicaciones" onRetry={() => setRefresh(value => value + 1)}/>
      {campaignRead.data && !currentCampaignQuery && <p role="status" className={styles.warning}>Resultados de la consulta anterior; actualizando filtros</p>}
      {campaignRead.data && <div inert={!currentCampaignQuery} aria-busy={campaignRead.loading}>
        <div className={styles.stack}>{campaignRead.data.campaigns.map(campaign => <CampaignRow key={campaign.id} campaign={campaign} onOpen={() => change({ record: campaign.id })} onResults={() => change({ tab: 'results', record: campaign.id })}/>)}</div>
        {currentCampaignQuery && !campaignRead.loading && !campaignRead.error && !campaignRead.data.campaigns.length && <div className={`admin-empty ${styles.empty}`}>
          {campaignRead.data.total > 0 ? <><h2>Esta página no tiene publicaciones</h2><button type="button" className="button subtle" onClick={() => change({ page: 1 })}>Ir a la primera página</button></> : campaignFilters.length ? <><h2>No hay publicaciones con estos filtros</h2><button type="button" className="button subtle" onClick={clearCampaignFilters}>Limpiar filtros</button></> : <><h2>Empieza con un borrador</h2><p>Solo necesitas un nombre; puedes añadir la cuenta y el archivo después.</p><div className={styles.actions}><button type="button" className="button primary" onClick={() => change({ record: 'new' })}>Crear publicación</button><button type="button" className="button subtle" onClick={() => change({ tab: 'assets', record: null })}>Imágenes y videos</button><button type="button" className="button subtle" onClick={() => navigate({ section: 'business', tab: 'social', record: null })}>Configurar redes sociales</button></div></>}
        </div>}
        <Pagination page={campaignRead.data.page} pages={campaignRead.data.pages} total={campaignRead.data.total} disabled={campaignRead.loading || !currentCampaignQuery} onPage={page => change({ page })}/>
      </div>}
    </> : tab === 'assets' ? <AssetsPanel api={api} view={view} inventory={inventory} change={change} report={report} onMutation={invalidate} onRetry={() => setRefresh(value => value + 1)}/> : <AdvertisingResults api={api} campaignId={view.record && view.record !== 'new' ? view.record : null} view={view} onViewChange={onViewChange} onNavigate={navigate} onInteractionStateChange={resultsReport} onMutation={invalidate} revision={revision}/>}
  </section>;
}

function CampaignRow({ campaign, onOpen, onResults }) {
  const deliveries = campaign.deliveries || [];
  const syncDates = deliveries.map(item => item.metricSync?.lastCompletedAt).filter(Boolean).sort();
  const spendSummary = campaign.lastMeasurementSummary, spend = spendSummary?.spendMinor;
  const spendText = spend?.value != null && ['reported', 'estimated'].includes(spend.status)
    ? `${money(spend.value, spendSummary.currency)}${spend.precision !== 'exact' || spend.status === 'estimated' ? ' · Estimado / precisión no exacta' : ''}`
    : 'No disponible';
  return <article className={styles.card}><header className={styles.toolbar}><h2>{campaign.name}</h2><span className={styles.badge}>{states[campaign.state] || campaign.state}</span></header>
    <p>{campaign.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'} · {objectives[campaign.objective]} · {campaign.platforms?.map(value => value === 'facebook' ? 'Facebook' : 'Instagram').join(' · ') || 'Sin destinos elegidos'}</p>
    <dl className="summary-values"><div><dt>{campaign.mode === 'paid' ? 'Inicio / fin' : 'Publicación'}</dt><dd>{campaign.mode === 'paid' ? `${date(campaign.startAt)} / ${date(campaign.endAt)}` : campaign.publishAt ? date(campaign.publishAt) : 'Al aprobar y procesar la solicitud'}</dd></div>{campaign.mode === 'paid' && <div><dt>Gasto reportado</dt><dd>{spendText}{spendSummary && <small className={styles.muted}> · {spendSummary.complete ? 'Consulta completa' : 'Cobertura parcial'} · {date(spendSummary.fetchedAt)} · {methods[spendSummary.integrationMethod] || 'Fuente no informada'}</small>}</dd></div>}<div><dt>Última consulta completa</dt><dd>{date(syncDates.at(-1))}</dd></div></dl>
    {campaign.restoreHold || campaign.restore_hold ? <p className={styles.warning}>Restaurada: bloqueada hasta reconexión, comprobación de estado en Meta sin reenviar y reanudación explícita.</p> : null}
    {deliveries.length > 0 && <ul className={styles.choiceList}>{deliveries.map(delivery => <li key={delivery.id}><strong>{delivery.channel === 'meta_ads' ? 'Anuncio Meta · presupuesto único' : delivery.channel === 'facebook' ? 'Facebook' : 'Instagram'}</strong>: {states[delivery.state] || delivery.state}{delivery.lastConfirmedState && <span> · Último confirmado: {states[delivery.lastConfirmedState] || delivery.lastConfirmedState}</span>}{delivery.state === 'uncertain' && <p className={styles.warning}>Envío incierto: comprueba el estado en Meta sin reenviar.</p>}{['queued', 'scheduled'].includes(delivery.state) && campaign.publishAt && Date.parse(campaign.publishAt) < Date.now() - 900000 && <p className={styles.warning}>Horario vencido por más de 15 minutos: requiere revisión; no se presenta como publicada.</p>}</li>)}</ul>}
    <details className={styles.technicalDetails}><summary>Detalles del seguimiento</summary><p>{methods[campaign.integrationMethod] || 'Sin conexión seleccionada'}</p>{deliveries.map(delivery => <p key={delivery.id}>{delivery.channel} · Próxima consulta: {date(delivery.nextSyncAt)}{delivery.metricSync?.lastError?.code ? ` · ${delivery.metricSync.lastError.code}` : ''}</p>)}</details>
    <div className={styles.actions}><button type="button" className="button primary" onClick={onOpen}>Abrir {campaign.state === 'draft' ? 'borrador' : 'publicación'}</button><button type="button" className="button subtle" aria-label={`Ver resultados: ${campaign.name}`} onClick={onResults}>Ver resultados</button></div>
  </article>;
}


function AssetsPanel({ api, view, inventory, change, report, onMutation, onRetry }) {
  const [file, setFile] = useState(null), [name, setName] = useState(''), [busy, setBusy] = useState(false), [phase, setPhase] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [slot, setSlot] = useState(null);
  const input = useRef(null), searchPanel = useRef(null), listHeading = useRef(null), errorRef = useRef(null), archiveFocus = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const assets = inventory.data?.assets || [], stateFilter = Object.hasOwn(ASSET_STATES, view.status || '') ? view.status : '';
  const query = (view.q || '').trim().toLocaleLowerCase('es');
  const filtered = assets.filter(asset => (!stateFilter || asset.state === stateFilter) && (!query || [asset.name, asset.originalName].some(value => (value || '').trim().toLocaleLowerCase('es').includes(query))));
  const page = Number(view.page || 1), pages = Math.max(1, Math.ceil(filtered.length / 20)), visible = filtered.slice((page - 1) * 20, page * 20);
  const selected = view.record ? assets.find(asset => asset.id === view.record) : null, quota = inventory.data?.quota;
  const fileSelection = useRef(null);
  useEffect(() => { report('assets', { dirty: Boolean(file || name), busy }); }, [file, name, busy, report]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report('assets', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!archiveFocus.current || inventory.loading) return;
    if (assets.find(asset => asset.id === archiveFocus.current)?.state !== 'archived') return;
    if (!filtered.some(asset => asset.id === archiveFocus.current)) listHeading.current?.focus();
    archiveFocus.current = null;
  }, [inventory.data, inventory.loading, query, stateFilter]);
  const focusSearch = () => requestAnimationFrame(() => searchPanel.current?.querySelector('input[name="assetQuery"]')?.focus());
  const clearFilters = () => { change({ q: null, status: null, record: null, page: 1 }); focusSearch(); };
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
      if (!payload.name) throw new Error('Escribe un nombre para encontrar el archivo después.');
      setPhase('Reservando espacio privado para el original y el archivo preparado para publicar (derivado)…');
      const reserved = slot || await api(ROOT + '/assets', { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid('reserve', { ...payload, selectionId: fileSelection.current, fileName: file.name, lastModified: file.lastModified }) }), signal: controller.signal });
      setSlot(reserved); setPhase('Enviando archivo original; aún no es publicable…');
      const uploaded = await api(`${ROOT}/assets/${reserved.id}/content`, { method: 'PUT', body: file, headers: { 'content-type': file.type, 'x-asset-version': String(reserved.version), 'x-request-id': rid(`upload:${reserved.id}`, { version: reserved.version, size: file.size, type: file.type }) }, signal: controller.signal });
      if (!['processing', 'ready'].includes(uploaded.state)) throw new Error(uploaded.diagnostic?.message || `El archivo está en estado ${ASSET_STATES[uploaded.state] || uploaded.state}. Selecciona una carga nueva si el original no fue recibido íntegro.`);
      setFile(null); setName(''); setSlot(null); if (input.current) input.current.value = '';
      report('assets', { dirty: false, busy: false }); setNotice('Original recibido. Procesamiento en segundo plano encolado; no estará listo para usar hasta verificar el archivo preparado para publicar (derivado).');
      await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') { setError(`No se confirmó la carga completa. Revisa el estado guardado antes de reenviar; una carga interrumpida requiere un nuevo archivo. ${cause.message}`); onRetry(); } }
    finally { requests.current.delete(controller); locked.current = false; setBusy(false); setPhase(''); }
  }
  async function action(asset, actionName) {
    if (locked.current) return;
    if (actionName === 'archive' && !window.confirm(`¿Archivar «${asset.name}»? No se borran archivos ni historia, no se libera espacio ocupado y no se modifica contenido publicado. Una entrega pendiente puede impedirlo.`)) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); requests.current.add(controller);
    try {
      const payload = { action: actionName, version: asset.version };
      await api(`${ROOT}/assets/${asset.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`${actionName}:${asset.id}`, payload) }), signal: controller.signal });
      if (actionName === 'archive') archiveFocus.current = asset.id;
      setNotice(actionName === 'archive' ? 'Archivo archivado; conserva archivos e historia y no libera espacio.' : 'Procesamiento encolado. Espera un archivo preparado y verificado antes de publicar.'); await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  function renderAsset(asset, detail = false) {
    return <article className={styles.card} key={asset.id}><header className={styles.toolbar}><div><h2>{asset.name}</h2><p>{asset.kind === 'video' ? 'Video' : 'Imagen'} · {ASSET_STATES[asset.state] || asset.state}</p></div>{!detail && <button type="button" className="button subtle" disabled={busy} onClick={() => change({ record: asset.id, page })}>Ver archivo</button>}</header>
      <p>Registrada: {date(asset.createdAt)}</p>
      {asset.diagnostic && <p className={styles.warning}>{asset.diagnostic.message || asset.diagnostic.code}</p>}
      {asset.state === 'uploading' && <p role="status">Reserva de carga hasta {date(asset.uploadExpiresAt)}. Si la carga quedó incompleta, espera su diagnóstico o registra un nuevo archivo; la reserva no acredita que el archivo exista.</p>}
      {asset.state === 'processing' && <p role="status">El procesamiento en segundo plano está preparando y verificando el archivo. Todavía no está listo para usar.</p>}
      {asset.state === 'missing_file' && <p className={styles.warning}>Falta el archivo del volumen privado. Restaura el volumen y solicita comprobación de SHA-256 al administrador del despliegue; reconectar Meta no restaura archivos. La historia se conserva y no puede republicarse.</p>}
      {detail && ['ready', 'archived'].includes(asset.state) && asset.derivativeSha256 && <div className={styles.assetPreview}>{asset.kind === 'video' ? <video className={styles.previewVideo} controls preload="metadata" playsInline src={`${ROOT}/assets/${asset.id}/content?variant=derivative`} aria-label={`Vista previa privada de ${asset.name}`} onError={() => setError('No se pudo leer el derivado privado. Comprueba sesión y restauración/verificación del volumen; no se considera publicable un archivo ausente.')}/> : <img className={styles.previewImage} src={`${ROOT}/assets/${asset.id}/content?variant=derivative`} alt={`Derivado normalizado de ${asset.name}`} onError={() => setError('No se pudo leer la vista previa privada. Comprueba sesión y restauración/verificación del volumen.')}/>}</div>}
      {detail && <dl className="summary-values"><div><dt>Archivo preparado</dt><dd>{asset.derivativeContentType || 'Todavía no disponible'} · {asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Dimensiones no informadas'}{asset.durationSeconds != null ? ` · ${asset.durationSeconds} s` : ''}</dd></div></dl>}
      <details className={styles.technicalDetails}><summary>Detalles del archivo</summary><dl className="summary-values"><div><dt>Original</dt><dd>{bytes(asset.originalBytes ?? asset.expectedBytes)} · {asset.originalName || 'Nombre no informado'}</dd></div><div><dt>Archivo preparado (derivado)</dt><dd>{bytes(asset.derivativeBytes)}</dd></div><div><dt>SHA-256 del original</dt><dd>{asset.originalSha256 || 'Todavía no verificado'}</dd></div><div><dt>SHA-256 del derivado</dt><dd>{asset.derivativeSha256 || 'Todavía no verificado'}</dd></div></dl></details>
      <div className={styles.actions}>{asset.state === 'failed' && asset.originalSha256 && asset.originalBytes > 0 && <button type="button" className="button primary" disabled={busy} onClick={() => action(asset, 'retry-processing')}>Reintentar procesamiento</button>}{['ready', 'failed'].includes(asset.state) && <button type="button" className="button subtle" disabled={busy} onClick={() => action(asset, 'archive')}>Archivar con confirmación</button>}</div>
    </article>;
  }
  return <><section className={styles.panel}><h2>Subir imágenes y videos</h2><p>Archivos propios en almacenamiento privado, independiente del catálogo. No se generan, recortan ni editan. El original recibido no equivale a un archivo listo para usar; revisa la vista previa del archivo preparado para publicar (derivado).</p>
    <ul><li>Imágenes JPEG/PNG/WebP hasta 10 MiB, no animadas, proporción 4:5–1,91:1 y ancho mínimo 320 px.</li><li>Videos MP4/MOV hasta 250 MiB, verticales 9:16, mínimo 540 × 960 y 3–90 segundos.</li></ul>
    <details className={styles.technicalDetails}><summary>Detalles de formatos y preparación</summary><p>Imágenes: un fotograma, hasta 40 megapíxeles; conversión a JPEG sRGB, sin ampliar y hasta 1440 px. Videos: archivo preparado H.264/AAC a 30 fps, hasta 1080 × 1920; no se inventa audio ni se recorta.</p>{quota && <p>Reservado para cargas: {bytes(quota.reservedBytes)} · Cuota total: {bytes(quota.limitBytes)}</p>}</details>
    {quota && <p>Espacio disponible: <strong>{bytes(quota.availableBytes)}</strong> · Ocupado: <strong>{bytes(quota.usedBytes)}</strong></p>}
    <form method="post" onSubmit={upload}><fieldset disabled={busy} className={styles.fieldGrid}><legend>Archivo propio</legend><label className="field">Archivo de imagen o video<input ref={input} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mov" onChange={event => pick(event.target.files?.[0] || null)}/></label><Field field={{ name: 'assetName', label: 'Nombre para encontrarlo después', required: true, max: 200 }} value={name} onChange={value => { setName(value); setSlot(null); }}/></fieldset>{file && <p>{file.name} · {bytes(file.size)} · Se envía directamente desde el archivo, sin cargar el video completo en memoria.</p>}<div className={styles.actions}><button type="submit" className="button primary" disabled={busy || !file || !name.trim()}>{busy ? 'Carga en curso…' : slot ? 'Revisar o reintentar esta carga' : 'Subir archivo'}</button>{file && <button type="button" className="button subtle" disabled={busy} onClick={() => { setFile(null); setName(''); setSlot(null); if (input.current) input.current.value = ''; }}>Descartar selección local</button>}</div></form>
    {phase && <p role="status">{phase}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}</section>
    <ReadStatus state={inventory} label="imágenes, videos y espacio disponible" onRetry={onRetry}/>
    <section ref={searchPanel} className={styles.queryPanel} aria-label="Buscar y filtrar imágenes y videos"><div className={styles.filterBar}>
      <Field field={{ name: 'assetQuery', label: 'Buscar imagen o video', max: 100 }} value={view.q || ''} onChange={value => change({ q: value || null, page: 1 })}/>
      <SelectField name="assetState" label="Estado del archivo" value={stateFilter} options={[{ value: '', label: 'Todos' }, ...Object.entries(ASSET_STATES).map(([value, label]) => ({ value, label }))]} onChange={value => change({ status: value || null, page: 1 })}/>
    </div>{(view.q || stateFilter) ? <div className="active-filters" aria-label="Filtros de imágenes y videos">{[[view.q && 'q', 'Búsqueda', view.q], [stateFilter && 'status', 'Estado', ASSET_STATES[stateFilter]]].filter(([key]) => key).map(([key, label, value]) => <button key={key} type="button" className="filter-chip" aria-label={`Quitar filtro: ${label}: ${value}`} onClick={() => { change({ [key]: null, page: 1 }); focusSearch(); }}>{label}: {value} <span aria-hidden="true">×</span></button>)}<button type="button" className="text-button" onClick={clearFilters}>Limpiar filtros</button></div> : <p className={styles.help}>Se muestran todas las imágenes y videos</p>}</section>
    {view.record && <section className={styles.detail}><button type="button" className="button subtle" disabled={busy} onClick={() => change({ record: null, page })}>Cerrar archivo</button>{selected ? renderAsset(selected, true) : inventory.data && !inventory.loading && !inventory.error && <p role="status">El archivo no aparece en la lectura actual. Reintenta la consulta; no se sustituye por otro archivo.</p>}</section>}
    <section className={styles.stack} aria-label="Biblioteca de imágenes y videos"><h2 ref={listHeading} tabIndex={-1}>Imágenes y videos guardados</h2>{visible.map(asset => renderAsset(asset))}</section>
    {inventory.data && !inventory.loading && !inventory.error && !visible.length && <div className={`admin-empty ${styles.empty}`}>{filtered.length ? <><h2>Esta página no tiene archivos</h2><button type="button" className="button subtle" onClick={() => change({ page: 1 })}>Ir a la primera página</button></> : (view.q || stateFilter) ? <><h2>No hay imágenes o videos con estos filtros</h2><button type="button" className="button subtle" onClick={clearFilters}>Limpiar filtros</button></> : <><h2>Aún no hay imágenes ni videos</h2><p>Elige un archivo propio con los requisitos indicados.</p><button type="button" className="button primary" onClick={() => input.current?.focus()}>Elegir archivo</button></>}</div>}
    <Pagination page={page} pages={pages} total={filtered.length} disabled={busy || inventory.loading} onPage={value => change({ page: value, record: null })}/>
  </>;
}
