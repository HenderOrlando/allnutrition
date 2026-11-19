'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import { Field } from './Fields';
import AdvertisingCampaignEditor from './AdvertisingCampaignEditor';
import { useAssistantBridge } from './AssistantBridge.jsx';
import AdvertisingResults from './AdvertisingResults';
import AdvertisingGuide from './AdvertisingGuide';
import AdvertisingGeneration from './AdvertisingGeneration';
import AdvertisingAssetUpload from './AdvertisingAssetUpload';
import Icon from './Icons';
import useDialog from './useDialog';
import { countryLabel } from './AdvertisingMarkets';
import { offerLabel } from './AdvertisingOfferPicker';
import MetaAccountAnalysis from './MetaAccountAnalysis';
import AdvertisingMeasurement from './AdvertisingMeasurement';
import { readAdminView } from '@/lib/admin-view.mjs';
import styles from './AdvertisingWorkspace.module.css';
import library from './AdvertisingLibrary.module.css';

const ROOT = '/api/admin/social';
const tabs = [{ id: 'campaigns', label: 'Publicaciones y campañas' }, { id: 'assets', label: 'Biblioteca' }, { id: 'results', label: 'Resultados' }];
const journey = ['Pieza creativa', 'Tipo de publicación', 'Configuración y revisión'];
const states = { draft: 'Borrador', ready: 'Preparada', scheduled: 'Programada', publishing: 'En preparación o publicación', partial: 'Publicación parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Falló', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Envío incierto: comprobar estado en Meta sin reenviar', blocked: 'Bloqueada', connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };
const ASSET_STATES = { uploading: 'Carga pendiente o en curso', processing: 'Preparando imagen o video', ready: 'Lista para revisar', failed: 'No se pudo preparar', archived: 'Archivada', missing_file: 'Archivo no disponible' };
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

export default function AdvertisingWorkspace({ api, view, onViewChange, onStudioThread, onNavigate, onInteractionStateChange, onMutation, revision = 0, assistantOpenRequest, onAssistantOpenHandled }) {
  const tab = tabs.some(item => item.id === view.tab) ? view.tab : 'campaigns';
  const [refresh, setRefresh] = useState(0), [inventory, setInventory] = useState({ data: null, error: '', loading: false, fetchedAt: null });
  const [notice, setNotice] = useState('');
  const heading = useRef(null), queryPanel = useRef(null), interaction = useRef(new Map()), callbacks = useRef({}), mounted = useRef(true);
  callbacks.current = { onInteractionStateChange, onMutation, onViewChange, view };
  const assistantBridge = useAssistantBridge(), assistantOpenNotice = useRef('');
  const [assistantOpenContext, setAssistantOpenContext] = useState(null);
  useEffect(() => {
    const request = assistantOpenRequest, open = request?.open, destination = readAdminView(open?.view);
    setAssistantOpenContext(null);
    if (!request || open?.owner !== 'advertising' || destination.section !== 'advertising' || !['campaign-draft', 'asset-metadata', 'advertising-result-action'].includes(open.target)) return;
    const controller = new AbortController();
    const paths = { order: id => `/api/admin/orders/${encodeURIComponent(id)}`, expense: id => `/api/admin/finance/expenses?${new URLSearchParams({ record: id })}`, source: id => `/api/admin/business/sources/${encodeURIComponent(id)}`, platform: id => `/api/admin/business/platforms/${encodeURIComponent(id)}` };
    Promise.all(Object.entries(open.refs || {}).map(async ([role, ref]) => {
      if (!paths[role] || !ref?.id || ![role, `${role}s`].includes(ref.kind)) throw new Error('La referencia no pertenece a este formulario publicitario.');
      const record = await api(paths[role](ref.id), { signal: controller.signal });
      if (record.id !== ref.id || (record.version ?? null) !== ref.version) throw new Error('Un registro cambió. Vuelve a revisar la propuesta con sus datos actuales.');
      return [role, record];
    })).then(entries => { if (!controller.signal.aborted) setAssistantOpenContext({ requestId: request.requestId, refs: Object.fromEntries(entries) }); }).catch(cause => { if (!controller.signal.aborted) setNotice(cause.message); });
    return () => controller.abort();
  }, [api, assistantOpenRequest]);
  useEffect(() => {
    const request = assistantOpenRequest, open = request?.open;
    if (!request || assistantOpenContext?.requestId !== request.requestId) return;
    const destination = readAdminView(open.view), current = readAdminView({ ...view, section: 'advertising' });
    const expectedTab = { 'campaign-draft': 'campaigns', 'asset-metadata': 'assets', 'advertising-result-action': 'results' }[open.target];
    if (destination.tab !== expectedTab || tab !== expectedTab || (destination.record || null) !== (current.record || null)) return;
    if ([...interaction.current.values()].some(state => state.busy)) return;
    const form = assistantBridge.snapshot().find(item => item.target === open.target && item.entityId === (open.entityId ?? null) && !item.busy);
    if (form) { onAssistantOpenHandled?.(request.requestId); return; }
    if (open.target === 'advertising-result-action') {
      const text = 'Abre la acción concreta de Resultados y selecciona el registro real para revisar el motivo. Ali no elige vínculos ni confirma acciones por ti.';
      if (assistantOpenNotice.current !== `${request.requestId}:${text}`) { assistantOpenNotice.current = `${request.requestId}:${text}`; setNotice(text); }
    }
  }, [assistantOpenRequest, assistantOpenContext, assistantBridge, view, tab, onAssistantOpenHandled]);
  const report = useCallback((owner, state) => {
    interaction.current.set(owner, state);
    callbacks.current.onInteractionStateChange?.({ dirty: [...interaction.current.values()].some(item => item.dirty), busy: [...interaction.current.values()].some(item => item.busy) });
  }, []);
  const editorReport = useCallback(state => report('editor', state), [report]);
  const resultsReport = useCallback(state => report('results', state), [report]);
  const generationReport = useCallback(state => report('generation', state), [report]);
  const editorComposerReport = useCallback(state => report('editor-composer', state), [report]);
  const accountAnalysisReport = useCallback(state => report('account-analysis', state), [report]);
  const measurementReport = useCallback(state => report('measurement', state), [report]);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = event => { if ([...interaction.current.values()].some(item => item.dirty || item.busy)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); };
  }, []);
  const listVisible = tab !== 'campaigns' || !view.record;
  useEffect(() => { if (listVisible) heading.current?.focus({ preventScroll: true }); }, [tab, listVisible]);
  const invalidate = useCallback(async () => {
    if (mounted.current) setRefresh(value => value + 1);
    try { await callbacks.current.onMutation?.(); } catch (cause) { if (mounted.current) setNotice(`Operación guardada; actualización general pendiente. ${cause.message}`); }
  }, []);
  const updateLibraryAsset = useCallback(asset => {
    setInventory(previous => {
      const index = previous.data?.assets.findIndex(item => item.id === asset.id && item.version < asset.version) ?? -1;
      if (index < 0) return previous;
      const assets = previous.data.assets.slice();
      assets[index] = asset;
      return { ...previous, data: { ...previous.data, assets } };
    });
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
  const startStudio = () => change({ tab: 'campaigns', record: 'new', studio: null, mode: null, objective: null });
  const editorProps = { api, connections, requirements: connectionRead.data?.requirements, assets: inventory.data?.assets,
    onSaved: committed, onNavigate: navigate, onInteractionStateChange: editorReport, onComposerState: editorComposerReport, onMutation: invalidate, revision };
  const campaignFilters = [
    ['q', 'Búsqueda', view.q], ['mode', 'Tipo de publicación', { organic: 'Publicación sin inversión', paid: 'Anuncio pagado' }[view.mode]],
    ['status', 'Estado', states[view.status]], ['network', 'Red', { facebook: 'Facebook', instagram: 'Instagram' }[view.network]],
    ['objective', 'Objetivo', objectives[view.objective]]
  ].filter(([key]) => Boolean(view[key]));
  const clearCampaignFilters = () => { change({ q: null, mode: null, status: null, network: null, objective: null, record: null, page: 1 }); queryPanel.current?.querySelector('input[name="q"]')?.focus(); };
  const currentCampaignQuery = campaignRead.path === listPath;
  return <section className={`${styles.workspace} ${styles.advertising}`} aria-label="Publicidad en redes sociales">
    <header className="workspace-heading"><div><p className={styles.eyebrow}>Facebook e Instagram</p><h1 ref={heading} tabIndex={-1} data-admin-section-heading>Publicidad</h1></div>
      <button type="button" className="text-button" aria-controls="advertising-guide" onClick={() => {
        const guide = document.getElementById('advertising-guide');
        guide.open = true;
        guide.querySelector('summary')?.focus();
        guide.scrollIntoView({ block: 'start' });
      }}>Ver guía</button>
    </header>
    <WorkspaceTabs label="Vistas de publicidad" items={tabs} value={tab} onChange={value => change({ tab: value, record: null, resultsFocus: null, status: null, q: null })}/>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {tab === 'campaigns' && view.record ? <>
      <ReadStatus state={connectionRead} label="cuentas conectadas" onRetry={() => setRefresh(value => value + 1)}/><ReadStatus state={inventory} label="imágenes y videos privados" onRetry={() => setRefresh(value => value + 1)}/>
      {view.record === 'new' ? <NewPublication view={view} editorProps={editorProps} onThread={onStudioThread} onInteractionStateChange={generationReport}
        assisted={assistantOpenRequest?.open?.target === 'campaign-draft' && assistantOpenRequest.open.view?.record === 'new'}
        onOpenCampaign={id => change({ record: id, studio: null })} onBack={() => change({ record: 'new', studio: view.studio })}
        onExit={() => change({ record: null, studio: null })}/>
        : <AdvertisingCampaignEditor {...editorProps} campaignId={view.record}/>}
    </> : tab === 'campaigns' ? <>
      <section className={styles.startPanel} aria-labelledby="advertising-start-title">
        <div><p className={styles.eyebrow}>De la idea a los resultados</p><h2 id="advertising-start-title">Prepara tu próxima publicación</h2><p>No necesitas conectar Meta para empezar. Guarda un borrador, revísalo y decide más adelante si lo publicas.</p></div>
        <button type="button" className="button primary" onClick={startStudio}>Crear publicación o campaña</button>
        <ol aria-label="Recorrido de una publicación">
          <li><strong>1. Crea</strong><span>Usa el chat creativo, sube un archivo o empieza solo con tu idea.</span></li>
          <li><strong>2. Revisa</strong><span>Completa el mensaje y resuelve lo que falte antes de aprobar.</span></li>
          <li><strong>3. Aprende</strong><span>Abre los resultados, comprueba la evidencia y prepara una variante.</span></li>
        </ol>
      </section>
      <section ref={queryPanel} className={styles.queryPanel} aria-label="Buscar y filtrar publicaciones">
        <div className={styles.listTitle}><h2>Tus publicaciones y campañas</h2>{currentCampaignQuery && campaignRead.data && <span className={styles.badge}>{campaignRead.data.total} {campaignRead.data.total === 1 ? 'registro' : 'registros'}</span>}</div>
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
        <p className={styles.help}>Ordenadas por última actualización.</p>
      </section>
      <ReadStatus state={campaignRead} label="publicaciones" onRetry={() => setRefresh(value => value + 1)}/>
      {campaignRead.data && !currentCampaignQuery && <p role="status" className={styles.warning}>Resultados de la consulta anterior; actualizando filtros</p>}
      {campaignRead.data && <div inert={!currentCampaignQuery} aria-busy={campaignRead.loading}>
        <div className={styles.recordGrid}>{campaignRead.data.campaigns.map(campaign => <CampaignRow key={campaign.id} campaign={campaign} asset={inventory.data?.assets.find(item => item.id === campaign.assetId && item.state === 'ready')} onOpen={() => change({ record: campaign.id })} onResults={resultsFocus => change({ tab: 'results', record: campaign.id, resultsFocus: resultsFocus || null })}/>)}</div>
        {currentCampaignQuery && !campaignRead.loading && !campaignRead.error && !campaignRead.data.campaigns.length && <div className={`admin-empty ${styles.empty}`}>
          {campaignRead.data.total > 0 ? <><h2>Esta página no tiene publicaciones</h2><button type="button" className="button subtle" onClick={() => change({ page: 1 })}>Ir a la primera página</button></> : campaignFilters.length ? <><h2>No hay publicaciones con estos filtros</h2><button type="button" className="button subtle" onClick={clearCampaignFilters}>Limpiar filtros</button></> : <><h2>Aún no hay publicaciones</h2><p>Tus borradores y publicaciones aparecerán aquí. Si ya tienes una imagen o video guardado, puedes usarlo al crear.</p><button type="button" className="button subtle" onClick={() => change({ tab: 'assets', record: null })}>Ir a la biblioteca</button></>}
        </div>}
        {campaignRead.data.pages > 1 && <Pagination page={campaignRead.data.page} pages={campaignRead.data.pages} total={campaignRead.data.total} disabled={campaignRead.loading || !currentCampaignQuery} onPage={page => change({ page })}/>}
      </div>}
      <PrivatePieces api={api} onResume={id => change({ tab: 'campaigns', record: 'new', studio: id, mode: null, objective: null })}/>
    </> : tab === 'assets' ? <>
      <AssetsPanel api={api} view={view} inventory={inventory} change={change} report={report} onMutation={invalidate}
        onAssetChange={updateLibraryAsset} onStartStudio={startStudio} onRetry={() => setRefresh(value => value + 1)}
        assistedUpload={!view.record && assistantOpenRequest?.open?.target === 'asset-metadata' && assistantOpenContext?.requestId === assistantOpenRequest.requestId ? assistantOpenRequest.requestId : null}/>
      {!view.record && <details className={styles.guide}><summary>Historial de imágenes anterior al estudio</summary><LegacyGenerationHistory api={api}/></details>}
    </> : <>
      <AdvertisingResults api={api} campaignId={view.record && view.record !== 'new' ? view.record : null} view={view} onViewChange={onViewChange} onNavigate={navigate} onInteractionStateChange={resultsReport} onMutation={invalidate} revision={revision}/>
      {(!view.record || view.record === 'new') && <>
        <ReadStatus state={connectionRead} label="cuentas para análisis y medición" onRetry={() => setRefresh(value => value + 1)}/>
        <section className={styles.stack} aria-labelledby="social-account-measurement">
          <h2 id="social-account-measurement" tabIndex={-1}>Medición de la cuenta</h2>
          <AdvertisingMeasurement api={api} connections={connections} onInteractionStateChange={measurementReport} onMutation={invalidate}/>
          <MetaAccountAnalysis api={api} connections={connections} onInteractionStateChange={accountAnalysisReport} onMutation={invalidate}/>
        </section>
      </>}
    </>}
    <AdvertisingGuide key={tab} tab={tab} onConnections={() => onNavigate?.({ section: 'business', tab: 'social', record: null })}/>
  </section>;
}

function NewPublication({ view, editorProps, onThread, onInteractionStateChange, onOpenCampaign, onBack, onExit, assisted }) {
  const [selection, setSelection] = useState(undefined), [mode, setMode] = useState(null);
  const heading = useRef(null);
  useEffect(() => { if (selection !== undefined && !mode) heading.current?.focus(); }, [selection, mode]);
  useEffect(() => { if (assisted) setMode(value => value || view.mode || 'organic'); }, [assisted, view.mode]);
  function back() {
    if (onBack() === false) return;
    setMode(null); setSelection(undefined);
  }
  const stage = mode ? 2 : selection !== undefined ? 1 : 0;
  return <div className={styles.stack}>
    <ol className={styles.journey} aria-label="Etapas de creación">{journey.map((label, index) => <li key={label} aria-current={index === stage ? 'step' : undefined}><span aria-hidden="true">{index < stage ? '✓' : index + 1}</span>{label}</li>)}</ol>
    {mode ? <>
      <div className={styles.actions}><button type="button" className="text-button" onClick={back}>Volver al estudio</button></div>
      <AdvertisingCampaignEditor {...editorProps} campaignId="new" initialMode={mode} initialObjective={view.objective || 'engagement'} studioThread={selection || null} studioId={view.studio} onStudioThread={onThread}/>
    </> : selection !== undefined ? <section className={`${styles.card} ${styles.stack}`} aria-label="Elegir tipo de publicación">
      <header><p className={styles.eyebrow}>Elige una ruta</p><h2 ref={heading} tabIndex={-1}>¿Qué quieres publicar?</h2>
        <p>{selection?.selectedAsset ? <>Pieza elegida: <strong>{selection.selectedAsset.name}</strong>.</> : 'Puedes añadir una imagen o un video más adelante.'}</p>
      </header>
      <div className={styles.fieldGrid}>
        <button type="button" className={styles.modeChoice} aria-labelledby="ad-mode-organic" aria-describedby="ad-mode-organic-help" onClick={() => setMode('organic')}><strong id="ad-mode-organic">Publicación sin inversión</strong><small id="ad-mode-organic-help">Comparte contenido en Facebook o Instagram sin pagar por distribución.</small></button>
        <button type="button" className={styles.modeChoice} aria-labelledby="ad-mode-paid" aria-describedby="ad-mode-paid-help" onClick={() => setMode('paid')}><strong id="ad-mode-paid">Anuncio pagado</strong><small id="ad-mode-paid-help">Define público, fechas y presupuesto. Activar el gasto requiere otra confirmación.</small></button>
      </div>
      <div className={styles.actions}><button type="button" className="text-button" onClick={back}>Volver al estudio</button></div>
    </section> : <AdvertisingGeneration api={editorProps.api} assets={editorProps.assets} threadId={view.studio} onThreadCreated={thread => onThread?.(thread.id)}
      onUseAsset={(_asset, thread) => setSelection(thread)} onOpenCampaign={onOpenCampaign} onInteractionStateChange={onInteractionStateChange} onMutation={editorProps.onMutation}
      onSkip={() => { if (onBack() !== false) setSelection(null); }} onExit={onExit}/>}
  </div>;
}

function PrivatePieces({ api, onResume }) {
  const [paging, setPaging] = useState({ cursor: null, threads: [], nextCursor: null, error: '', loading: false });
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    const cursor = paging.cursor;
    setPaging(value => ({ ...value, loading: true, error: '' }));
    api(`${ROOT}/creative-threads${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`, { signal }).then(data => {
      if (!signal.aborted) setPaging(value => ({ ...value, threads: [...new Map([...value.threads, ...data.threads].map(item => [item.id, item])).values()], nextCursor: data.nextCursor, loading: false }));
    }, cause => { if (!signal.aborted) setPaging(value => ({ ...value, loading: false, error: cause.message })); });
    return () => controller.abort();
  }, [api, paging.cursor]);
  return <details className={styles.guide}><summary>Mis piezas en curso{paging.threads.length ? ` (${paging.threads.length}${paging.nextCursor ? '+' : ''})` : ''}</summary>
    {paging.loading && <p role="status">Buscando tus piezas en curso…</p>}
    {paging.error && <p role="alert">{paging.error}</p>}
    {!paging.loading && !paging.error && !paging.threads.length && <p>No hay piezas en curso sin borrador.</p>}
    {paging.threads.length > 0 && <ul className={styles.choiceList}>{paging.threads.map(thread => <li key={thread.id} className={styles.toolbar}>
      <div><strong>{thread.selectedAsset?.name || 'Pieza sin seleccionar'}</strong><p className={styles.help}>Última actividad: {date(thread.updatedAt)}</p></div>
      <button type="button" className="button subtle" onClick={() => onResume(thread.id)}>Reanudar pieza</button>
    </li>)}</ul>}
    {paging.nextCursor && <button type="button" className="button subtle" disabled={paging.loading} onClick={() => setPaging(value => ({ ...value, cursor: value.nextCursor }))}>Cargar más piezas</button>}
  </details>;
}

function LegacyGenerationHistory({ api }) {
  const read = useRead(api, `${ROOT}/generation`, 0);
  return <div className={styles.stack}><ReadStatus state={read} label="historial anterior"/>
    {read.data && (read.data.jobs.length ? <ul className={styles.choiceList}>{read.data.jobs.map(job => <li key={job.id}>
      <strong>{job.asset?.name || `Solicitud ${job.format?.toUpperCase() || 'de imagen'}`}</strong><p>{date(job.createdAt)} · {job.notice}</p>
      {job.asset?.originalUrl && <a href={job.asset.originalUrl}>Ver original</a>}
    </li>)}</ul> : <p>No hay solicitudes anteriores.</p>)}
  </div>;
}

function CampaignRow({ campaign, asset, onOpen, onResults }) {
  const deliveries = campaign.deliveries || [];
  const awaitingPublication = campaign.mode === 'organic' && campaign.state === 'ready' && !deliveries.length;
  const confirmed = deliveries.some(delivery => delivery.remoteId && delivery.lastConfirmedAt &&
    (campaign.mode === 'paid' ? ['active', 'completed'].includes(delivery.lastConfirmedState) : delivery.state === 'published' || delivery.lastConfirmedState === 'published'));
  const needsCheck = ['partial', 'needs_attention', 'failed'].includes(campaign.state) || deliveries.some(item => item.state === 'uncertain');
  const next = campaign.state === 'draft' ? 'Continuar borrador' : needsCheck ? 'Comprobar en Meta sin reenviar' :
    awaitingPublication ? campaign.publishAt ? 'Revisar programación' : 'Revisar publicación' :
    campaign.state === 'ready' && campaign.mode === 'paid' ? 'Revisar inversión' : confirmed ? 'Ver resultados' : 'Ver progreso';
  const status = awaitingPublication ? 'Aprobada, pendiente de publicar' : campaign.mode === 'paid' && campaign.state === 'ready' ? 'Preparada, sin gasto autorizado' : states[campaign.state] || campaign.state;
  const syncDates = deliveries.map(item => item.metricSync?.lastCompletedAt).filter(Boolean).sort();
  const spendSummary = campaign.lastMeasurementSummary, spend = spendSummary?.spendMinor;
  const spendText = spend?.value != null && ['reported', 'estimated'].includes(spend.status)
    ? `${money(spend.value, spendSummary.currency)}${spend.precision !== 'exact' || spend.status === 'estimated' ? ' · Estimado / precisión no exacta' : ''}`
    : 'No disponible';
  return <article className={`${styles.card} ${styles.stack} ${styles.campaignCard}`}><header className={styles.heading}><h3>{campaign.name}</h3><span className={styles.badge}>{status}</span></header>
    <div className={styles.campaignSummary}>
      {(asset?.kind === 'image' || campaign.offerSnapshot?.primary?.image) && <img className={styles.cardThumb} width={72} height={72} loading="lazy" src={asset?.kind === 'image' ? asset.previewUrl : campaign.offerSnapshot.primary.image} alt=""/>}
      <div><p><strong>{campaign.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'}</strong> · {objectives[campaign.objective]}</p>
        <p>{campaign.platforms?.map(value => value === 'facebook' ? 'Facebook' : 'Instagram').join(' · ') || 'Sin redes elegidas'} · {campaign.marketCountries?.map(countryLabel).join(', ') || 'Sin países elegidos'}</p>
        {campaign.offerSnapshot?.primary && <p>{offerLabel(campaign.offerSnapshot.primary)}</p>}
      </div>
    </div>
    {(campaign.restoreHold || campaign.restore_hold) && <p className={styles.warning}>{campaign.mode === 'organic' && !deliveries.length ? 'Restaurada sin entrega: duplica, vuelve a validar y aprueba el nuevo borrador.' : 'Restaurada: bloqueada hasta reconexión, comprobación de estado en Meta sin reenviar y reanudación explícita.'}</p>}
    {deliveries.length > 0 && <ul className={styles.choiceList}>{deliveries.map(delivery => <li key={delivery.id}><strong>{delivery.channel === 'meta_ads' ? 'Anuncio Meta · presupuesto único' : delivery.channel === 'facebook' ? 'Facebook' : 'Instagram'}</strong>: {states[delivery.state] || delivery.state}{delivery.lastConfirmedState && <span> · Último confirmado: {states[delivery.lastConfirmedState] || delivery.lastConfirmedState}</span>}{delivery.state === 'uncertain' && <p className={styles.warning}>Envío incierto: comprueba el estado en Meta sin reenviar.</p>}{['queued', 'scheduled'].includes(delivery.state) && campaign.publishAt && Date.parse(campaign.publishAt) < Date.now() - 900000 && <p className={styles.warning}>Horario vencido por más de 15 minutos: requiere revisión; no se presenta como publicada.</p>}</li>)}</ul>}
    {(deliveries.length > 0 || campaign.publishAt || campaign.startAt || campaign.endAt) && <details className={styles.technicalDetails}><summary>Fechas y seguimiento</summary>
      <dl className="summary-values"><div><dt>{campaign.mode === 'paid' ? 'Inicio / fin' : 'Publicación'}</dt><dd>{campaign.mode === 'paid' ? `${date(campaign.startAt)} / ${date(campaign.endAt)}` : campaign.publishAt ? date(campaign.publishAt) : 'Al autorizar la publicación y procesar la solicitud'}</dd></div>{campaign.mode === 'paid' && deliveries.length > 0 && <div><dt>Gasto reportado</dt><dd>{spendText}{spendSummary && <small className={styles.muted}> · {spendSummary.complete ? 'Consulta completa' : 'Cobertura parcial'} · {date(spendSummary.fetchedAt)} · {methods[spendSummary.integrationMethod] || 'Fuente no informada'}</small>}</dd></div>}{deliveries.length > 0 && <div><dt>Última consulta completa</dt><dd>{date(syncDates.at(-1))}</dd></div>}</dl>
      <p>{methods[campaign.integrationMethod] || 'Sin conexión seleccionada'}</p>{deliveries.map(delivery => <p key={delivery.id}>{delivery.channel} · Próxima consulta: {date(delivery.nextSyncAt)}{delivery.metricSync?.lastError?.code ? ` · ${delivery.metricSync.lastError.code}` : ''}</p>)}
    </details>}
    <div className={styles.actions}>
      <button type="button" className="button primary" onClick={next === 'Ver resultados' ? () => onResults() : onOpen}>{next}</button>
      {next === 'Ver resultados' && <button type="button" className="button subtle" onClick={onOpen}>Abrir ficha</button>}
      {needsCheck && confirmed && <button type="button" className="button subtle" onClick={() => onResults()}>Ver resultados</button>}
      {deliveries.length > 0 && campaign.improvementState && <button type="button" className="button subtle" onClick={() => onResults(campaign.improvementState === 'suggested' ? 'recommendations' : 'learnings')}>{{ suggested: 'Mejora disponible · Ver propuesta', observing: 'Prueba en curso', concluded: 'Ya hay una conclusión' }[campaign.improvementState]}</button>}
    </div>
  </article>;
}


function AssetsPanel({ api, view, inventory, change, report, onMutation, onAssetChange, onStartStudio, onRetry, assistedUpload }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadInteraction, setUploadInteraction] = useState({ dirty: false, busy: false });
  const [archive, setArchive] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [notice, setNotice] = useState(null);
  const operation = useRef(null), rid = useRequestIds();
  const searchPanel = useRef(null), gallery = useRef(null), listHeading = useRef(null), detailHeading = useRef(null);
  const previousRecord = useRef(null);
  const uploadReport = useCallback(state => {
    setUploadInteraction(state);
    report('assets-upload', state);
  }, [report]);
  const assets = inventory.data?.assets || [], stateFilter = Object.hasOwn(ASSET_STATES, view.status || '') ? view.status : '';
  const query = (view.q || '').trim().toLocaleLowerCase('es');
  const record = view.record || null;
  const filtered = record ? [] : assets.filter(asset => (!stateFilter || asset.state === stateFilter) && (!query || [asset.name, asset.originalName].some(value => (value || '').trim().toLocaleLowerCase('es').includes(query))));
  const page = Number(view.page || 1), pages = Math.max(1, Math.ceil(filtered.length / 20)), visible = filtered.slice((page - 1) * 20, page * 20);
  const selected = record ? assets.find(asset => asset.id === record) : null;
  const selectedId = selected?.id;
  const activeFilters = [[view.q && 'q', 'Búsqueda', view.q], [stateFilter && 'status', 'Estado', ASSET_STATES[stateFilter]]].filter(([key]) => key);
  const readStatus = <ReadStatus state={inventory} label="imágenes, videos y espacio disponible" onRetry={onRetry}/>;
  useEffect(() => () => { operation.current?.abort(); report('assets', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (assistedUpload) setUploadOpen(true); }, [assistedUpload]);
  useEffect(() => {
    const prior = previousRecord.current;
    previousRecord.current = record;
    if (record !== prior) {
      setArchive(null);
      setUploadOpen(false);
    }
    if (!record && !prior) return;
    const frame = requestAnimationFrame(() => {
      if (record) detailHeading.current?.focus();
      else {
        const button = gallery.current?.querySelector(`[data-library-record="${CSS.escape(prior)}"]`);
        (button || listHeading.current)?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [record, selectedId]);

  const openUpload = event => {
    event.currentTarget.focus({ preventScroll: true });
    setUploadOpen(true);
  };
  const focusSearch = () => searchPanel.current?.querySelector('input[name="assetQuery"]')?.focus();
  function clearFilters() {
    if (change({ q: null, status: null, record: null, page: 1 }) !== false) focusSearch();
  }
  function openArchive(asset, event) {
    event.currentTarget.focus({ preventScroll: true });
    setError(null);
    setArchive(asset);
  }
  async function action(asset, actionName) {
    if (operation.current) return;
    const controller = new AbortController(), { signal } = controller;
    operation.current = controller; setBusy(true); setError(null); setNotice(null);
    report('assets', { dirty: false, busy: true });
    try {
      const payload = { action: actionName, version: asset.version };
      const result = await api(`${ROOT}/assets/${encodeURIComponent(asset.id)}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`${actionName}:${asset.id}`, payload) }), signal });
      if (signal.aborted) return;
      onAssetChange(result);
      const archived = actionName === 'archive';
      setNotice({ id: asset.id, message: archived ? 'Archivo archivado. Se conservan los archivos y el historial; no se libera espacio.' : 'Procesamiento encolado. Espera a que el archivo esté listo para revisar.' });
      if (archived) setArchive(null);
      requestAnimationFrame(() => detailHeading.current?.focus());
      await onMutation();
    } catch (cause) {
      if (!signal.aborted) setError({ id: asset.id, action: actionName, message: cause.message });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!signal.aborted) { setBusy(false); report('assets', { dirty: false, busy: false }); }
    }
  }
  const actionError = name => error && error.id === record && error.action === name ? error.message : '';
  const actionNotice = notice && (!record || notice.id === record) && <p role="status" className={styles.notice}>{notice.message}</p>;

  return <>
    {record ? <section className={library.detail} aria-label="Ficha del archivo">
      <button type="button" className={`text-button ${library.back}`} disabled={busy} onClick={() => change({ record: null, page })}><Icon name="arrow" size={18}/>Volver a la biblioteca</button>
      {readStatus}
      {actionNotice}
      {selected ? <AssetDetails key={selected.id} asset={selected} heading={detailHeading} busy={busy}
        error={actionError('retry-processing')} onRetryProcessing={() => action(selected, 'retry-processing')}
        onArchive={event => openArchive(selected, event)} onStartStudio={onStartStudio} onUpload={openUpload}/>
        : <div className={`admin-empty ${styles.empty}`}><h2 ref={detailHeading} tabIndex={-1}>Archivo de la biblioteca</h2>
          {inventory.data && !inventory.loading && !inventory.error && <><p role="status">El archivo no aparece en la lectura actual. Reintenta la consulta; no se sustituye por otro archivo.</p>
            <button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura</button></>}
        </div>}
    </section> : <>
      <section className={library.heading} aria-labelledby="advertising-library-title">
        <div><h2 id="advertising-library-title">Biblioteca privada</h2><p>Guarda imágenes y videos para tus publicaciones. Subir un archivo no lo publica.</p></div>
        <div className={styles.actions}><button type="button" className="button primary" aria-haspopup="dialog" onClick={openUpload}><Icon name="plus" size={18}/>Subir archivo privado</button>
          <button type="button" className="button subtle" onClick={onStartStudio}>Crear imagen en el estudio</button></div>
      </section>
      <section ref={searchPanel} className={library.filters} aria-label="Buscar y filtrar imágenes y videos">
        <div className={library.filterFields}>
          <Field field={{ name: 'assetQuery', label: 'Buscar imagen o video', max: 100 }} value={view.q || ''} onChange={value => change({ q: value || null, page: 1 })}/>
          <SelectField name="assetState" label="Estado del archivo" value={stateFilter} options={[{ value: '', label: 'Todos' }, ...Object.entries(ASSET_STATES).map(([value, label]) => ({ value, label }))]} onChange={value => change({ status: value || null, page: 1 })}/>
        </div>
        {activeFilters.length > 0 && <div className="active-filters" aria-label="Filtros de imágenes y videos">
          {activeFilters.map(([key, label, value]) => <button key={key} type="button" className="filter-chip" aria-label={`Quitar filtro: ${label}: ${value}`} onClick={() => {
            if (change({ [key]: null, page: 1 }) !== false) focusSearch();
          }}>{label}: {value} <span aria-hidden="true">×</span></button>)}
          <button type="button" className="text-button" onClick={clearFilters}>Limpiar filtros</button>
        </div>}
      </section>
      {readStatus}
      {actionNotice}
      <section ref={gallery} className={library.gallery} aria-labelledby="advertising-library-gallery">
        <div className={library.galleryHeading}><h2 ref={listHeading} tabIndex={-1} id="advertising-library-gallery">Imágenes y videos guardados</h2>
          {inventory.data && <span className={styles.badge}>{filtered.length} {filtered.length === 1 ? 'archivo' : 'archivos'}</span>}</div>
        {visible.length > 0 && <div className={library.grid}>{visible.map(asset => <AssetCard key={asset.id} asset={asset} onOpen={() => change({ record: asset.id, page })}/>)}</div>}
        {inventory.data && !inventory.loading && !inventory.error && !visible.length && <div className={`admin-empty ${styles.empty}`}>
          {filtered.length ? <><h3>Esta página no tiene archivos</h3><button type="button" className="button subtle" onClick={() => change({ page: 1 })}>Ir a la primera página</button></>
            : activeFilters.length ? <h3>No hay imágenes o videos con estos filtros</h3>
            : <><h3>Aún no hay imágenes ni videos</h3><p>Sube tu primer archivo privado o crea una imagen en el estudio.</p></>}
        </div>}
        {pages > 1 && <Pagination page={page} pages={pages} total={filtered.length} disabled={inventory.loading} onPage={value => change({ page: value, record: null })}/>}
      </section>
    </>}
    {uploadOpen && <AssetUploadDialog api={api} quota={inventory.data?.quota} interaction={uploadInteraction} onInteractionStateChange={uploadReport}
      onMutation={onMutation} onClose={() => setUploadOpen(false)}/>}
    {archive && archive.id === record && <AssetArchiveDialog asset={archive} busy={busy} error={actionError('archive')}
      onClose={() => setArchive(null)} onConfirm={() => action(archive, 'archive')}/>}
  </>;
}

const assetKind = asset => asset.kind === 'video' ? 'Video' : 'Imagen';
function AssetState({ asset }) {
  return <span className={library.state} data-state={asset.state}>{ASSET_STATES[asset.state] || asset.state}</span>;
}

function AssetPreview({ asset, detail = false, onFailure }) {
  const [failed, setFailed] = useState(false);
  const playable = ['ready', 'archived'].includes(asset.state) && asset.derivativeSha256;
  const video = asset.kind === 'video';
  let media;
  if (playable && !failed && (!video || detail)) {
    const url = `${ROOT}/assets/${encodeURIComponent(asset.id)}/content?variant=derivative`;
    const fail = () => { setFailed(true); onFailure?.(asset.version); };
    media = video ? <video controls preload="metadata" playsInline src={url} aria-label={`Vista previa privada de ${asset.name}`} onError={fail}/>
      : <img src={url} alt={detail ? `Derivado normalizado de ${asset.name}` : ''} loading={detail ? undefined : 'lazy'} onError={fail}/>;
  } else {
    media = <div className={library.placeholder}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2"/>{video ? <path d="m10 8 6 4-6 4Z"/> : <><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-4 3 3 4-5 6 6"/></>}
      </svg>
      <span>{!detail && !failed && video && playable ? 'Vista previa en la ficha' : 'Sin vista previa'}</span>
    </div>;
  }
  return <div className={detail ? library.detailPreview : library.thumbnail}>
    {media}
    {detail && failed && <p role="alert" className={library.previewError}>No se pudo leer la vista previa privada. Comprueba la sesión y que el volumen esté restaurado y verificado antes de usar este archivo.</p>}
  </div>;
}

function AssetCard({ asset, onOpen }) {
  const title = `advertising-library-asset-${asset.id}`;
  return <article className={library.card}>
    <AssetPreview key={asset.version} asset={asset}/>
    <div className={library.cardBody}><p className={styles.help}>{assetKind(asset)}</p><h3 id={title}>{asset.name}</h3><AssetState asset={asset}/>
      <button type="button" className="button subtle" data-library-record={asset.id} aria-describedby={title} onClick={onOpen}>Ver archivo</button></div>
  </article>;
}

function AssetDetails({ asset, heading, busy, error, onRetryProcessing, onArchive, onStartStudio, onUpload }) {
  const [failedPreviewVersion, setFailedPreviewVersion] = useState(null);
  const canReview = asset.state === 'ready' && asset.derivativeSha256 && failedPreviewVersion !== asset.version;
  const canRetry = asset.state === 'failed' && asset.originalSha256 && asset.originalBytes > 0;
  const canArchive = ['ready', 'failed'].includes(asset.state);
  const nextStep = {
    ready: canReview ? 'Revisa la vista previa antes de usarla. Al preparar una publicación en el estudio, elige este archivo desde la biblioteca.' : 'Comprueba la vista previa privada antes de usar el archivo en una publicación.',
    uploading: `La reserva vence el ${date(asset.uploadExpiresAt)}. Si la carga se interrumpió, espera el diagnóstico o sube un archivo nuevo. La reserva no confirma que el archivo se haya recibido.`,
    processing: 'Espera a que termine la preparación y verificación en segundo plano. Todavía no puedes usar el archivo.',
    failed: canRetry ? 'El original está guardado. Reintenta el procesamiento o sube una versión corregida.' : 'No hay un original que se pueda volver a procesar. Corrige el archivo y súbelo de nuevo.',
    archived: 'La historia se conserva. Ya no puedes seleccionar este archivo para nuevas publicaciones.',
    missing_file: 'Pide al administrador que restaure el volumen privado y compruebe la huella SHA-256. Reconectar Meta no restaura archivos. La historia se conserva y no se puede republicar.',
  }[asset.state];
  return <article className={library.detailCard}>
    <header className={library.detailHeader}><div><p className={styles.help}>{assetKind(asset)} en la biblioteca privada</p><h2 ref={heading} tabIndex={-1}>{asset.name}</h2></div><AssetState asset={asset}/></header>
    <div className={library.detailLayout}>
      <AssetPreview key={asset.version} asset={asset} detail onFailure={setFailedPreviewVersion}/>
      <div className={library.nextStep}>
        <h3>Próximo paso</h3>
        <p role={['uploading', 'processing'].includes(asset.state) ? 'status' : undefined}>{nextStep}</p>
        {asset.reviewRequired && <p>Comprueba producto, etiquetas, texto y derechos al revisar la pieza. No se publica automáticamente.</p>}
        {asset.diagnostic && <p className={styles.warning}>{asset.diagnostic.message || asset.diagnostic.code}</p>}
        <AssetActionError error={error}/>
        {canReview && <button type="button" className="button primary" onClick={onStartStudio}>Ir al estudio</button>}
        {canRetry && <button type="button" className="button primary" disabled={busy} onClick={onRetryProcessing}>{busy ? 'Enviando solicitud…' : 'Reintentar procesamiento'}</button>}
        {asset.state === 'failed' && <button type="button" className={`button ${canRetry ? 'subtle' : 'primary'}`} disabled={busy} aria-haspopup="dialog" onClick={onUpload}>Subir archivo privado</button>}
      </div>
    </div>
    <details className={styles.technicalDetails}><summary>Detalles técnicos del archivo</summary>
      <dl className="summary-values">
        <div><dt>Registrado</dt><dd>{date(asset.createdAt)}</dd></div>
        <div><dt>Original</dt><dd>{bytes(asset.originalBytes ?? asset.expectedBytes)} · {asset.originalName || 'Nombre no informado'}</dd></div>
        <div><dt>Archivo preparado (derivado)</dt><dd>{asset.derivativeContentType || 'Todavía no disponible'} · {bytes(asset.derivativeBytes)} · {asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Dimensiones no informadas'}{asset.durationSeconds != null ? ` · ${asset.durationSeconds} s` : ''}</dd></div>
        <div><dt>SHA-256 del original</dt><dd>{asset.originalSha256 || 'Todavía no verificado'}</dd></div>
        <div><dt>SHA-256 del derivado</dt><dd>{asset.derivativeSha256 || 'Todavía no verificado'}</dd></div>
      </dl>
      {asset.contentType === 'image/gif' && asset.originalSha256 && <p><a href={`${ROOT}/assets/${encodeURIComponent(asset.id)}/content?variant=original`} target="_blank" rel="noreferrer">Ver o guardar GIF animado original</a> · La publicación utiliza el MP4 preparado, que debes revisar.</p>}
    </details>
    {canArchive && <footer className={library.detailFooter}><button type="button" className="button subtle" disabled={busy} aria-haspopup="dialog" onClick={onArchive}>Archivar archivo</button></footer>}
  </article>;
}

function AssetActionError({ error }) {
  const ref = useRef(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  return error ? <p ref={ref} tabIndex={-1} role="alert" className={styles.error}>{error}</p> : null;
}

function AssetUploadDialog({ api, quota, interaction, onInteractionStateChange, onMutation, onClose }) {
  const ref = useRef(null);
  const close = useDialog(ref, { ...interaction, onClose });
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog} ${library.uploadDialog}`} aria-labelledby="advertising-library-upload" aria-describedby="advertising-library-upload-description">
    <header className={styles.dialogHeader}><h2 id="advertising-library-upload" tabIndex={-1} data-dialog-initial-focus>Subir archivo privado</h2>
      <button type="button" className="button subtle" disabled={interaction.busy} onClick={close}>Cerrar carga</button></header>
    <div className={`${styles.dialogBody} ${library.uploadBody}`}>
      <p id="advertising-library-upload-description">Elige un archivo propio. Espera el estado «Lista para revisar» antes de usarlo.</p>
      <AdvertisingAssetUpload api={api} onInteractionStateChange={onInteractionStateChange} onMutation={onMutation} compact/>
      {quota && <details className={styles.technicalDetails}><summary>Espacio privado: {bytes(quota.availableBytes)} disponibles</summary>
        <p>{bytes(quota.usedBytes)} ocupados · {bytes(quota.reservedBytes)} reservados para cargas · {bytes(quota.limitBytes)} de cuota total</p></details>}
    </div>
  </dialog>;
}

function AssetArchiveDialog({ asset, busy, error, onClose, onConfirm }) {
  const ref = useRef(null);
  const close = useDialog(ref, { busy, onClose });
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog} ${library.archiveDialog}`} aria-labelledby="advertising-library-archive" aria-describedby="advertising-library-archive-description">
    <header className={styles.dialogHeader}><h2 id="advertising-library-archive">¿Archivar «{asset.name}»?</h2></header>
    <div className={styles.dialogBody}>
      <p id="advertising-library-archive-description">Ya no podrás elegir este archivo para nuevas publicaciones. No se borran los archivos ni su historial, no se libera espacio y no se modifica contenido publicado. Una entrega pendiente puede impedir el archivo.</p>
      {busy && <p role="status">Archivando archivo…</p>}
      <AssetActionError error={error}/>
    </div>
    <footer className={`${styles.dialogFooter} ${styles.actions} ${library.archiveActions}`}>
      <button type="button" className="button subtle" data-dialog-initial-focus disabled={busy} onClick={close}>Cancelar</button>
      <button type="button" className="button primary" disabled={busy} onClick={onConfirm}>Sí, archivar archivo</button>
    </footer>
  </dialog>;
}
