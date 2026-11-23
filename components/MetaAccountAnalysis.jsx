'use client';

import { useEffect, useRef, useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import styles from './AdvertisingWorkspace.module.css';
import accountStyles from './AdvertisingResults.module.css';
import useDialog from './useDialog';

const ROOT = '/api/admin/social/connections';
const objectives = { reach: 'Alcance', engagement: 'Interacción', traffic: 'Tráfico', whatsapp: 'WhatsApp', sales: 'Ventas' };
const states = { queued: 'En cola', running: 'Consultando', waiting: 'Esperando límite de Meta / reintento', completed: 'Lecturas terminadas', partial: 'Lecturas terminadas con faltantes', cancelled: 'Cancelado', failed: 'Requiere atención' };
const coverageStates = { pending: 'Pendiente', running: 'En curso', accessible_complete: 'Lectura accesible terminada (no garantiza historia completa)', partial: 'Parcial', denied: 'Permiso denegado', unavailable: 'No disponible' };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin fecha';

const activeStates = new Set(['queued', 'running', 'waiting']);

function useAccountAnalysis({ api, connectionId, objective, content, revision, onInteractionStateChange, onMutation }) {
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false);
  const [read, setRead] = useState(null), [actionError, setActionError] = useState(null);
  const lock = useRef(false), mutations = useRef(new Set());
  const query = new URLSearchParams({ page, pageSize: content ? 10 : 20, ...(content ? { content } : {}) });
  const path = connectionId && `${ROOT}/${encodeURIComponent(connectionId)}/analysis?${query}`;
  const key = `${path}:${objective}`;
  const visible = read?.key === key ? read : null;
  useEffect(() => { onInteractionStateChange?.({ dirty: false, busy }); }, [busy, onInteractionStateChange]);
  useEffect(() => () => {
    for (const controller of mutations.current) controller.abort();
    onInteractionStateChange?.({ dirty: false, busy: false });
  }, [onInteractionStateChange]);
  useEffect(() => { setActionError(null); }, [key]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); let active = true, timer, failures = 0;
    async function load() {
      if (!active) return;
      if (document.hidden) { timer = setTimeout(load, 5000); return; }
      setRead(previous => ({ ...(previous?.key === key ? previous : { report: null, error: '' }), key, loading: true }));
      let next = null;
      try {
        next = await api(path, { signal: controller.signal });
        if (active) { setRead({ key, report: next, error: '', loading: false }); failures = 0; }
      } catch (cause) {
        if (active && cause.name !== 'AbortError') {
          setRead(previous => ({ key, report: previous?.key === key ? previous.report : null, error: cause.message, loading: false }));
          failures++;
        }
      }
      if (active && (!next || activeStates.has(next.analysis?.state))) {
        const retryAt = Date.parse(next?.analysis?.retryAt || '');
        timer = setTimeout(load, failures ? Math.min(60000, 5000 * 2 ** Math.min(failures, 4)) : Number.isFinite(retryAt) ? Math.max(5000, Math.min(60000, retryAt - Date.now())) : 5000);
      }
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, path, key, refresh, revision]);
  async function act(action) {
    if (!connectionId || lock.current) return;
    lock.current = true; setBusy(true); setActionError(null);
    const controller = new AbortController(); mutations.current.add(controller);
    try {
      const next = await api(`${ROOT}/${encodeURIComponent(connectionId)}/analysis`, { method: 'POST', body: JSON.stringify({ action }), signal: controller.signal });
      if (page === 1 && !content) setRead({ key, report: next, error: '', loading: false });
      setPage(1); setRefresh(value => value + 1); await onMutation?.();
    } catch (cause) { if (cause.name !== 'AbortError') setActionError({ key, message: cause.message }); }
    finally { mutations.current.delete(controller); lock.current = false; setBusy(false); }
  }
  const report = visible?.report, analysis = report?.analysis;
  return { report, analysis, page, setPage, act, busy, active: activeStates.has(analysis?.state),
    loading: Boolean(path) && (!visible || visible.loading), readError: visible?.error, actionError: actionError?.key === key ? actionError.message : '',
    retry: () => setRefresh(value => value + 1) };
}

export default function MetaAccountAnalysis({ api, connections = [], onInteractionStateChange, onMutation }) {
  const eligible = connections.filter(connection => connection.provider === 'meta' && connection.integrationMethod === 'api');
  const [selected, setSelected] = useState(''), [consent, setConsent] = useState(null);
  const connection = selected ? eligible.find(item => item.id === selected) : eligible.length === 1 ? eligible[0] : null;
  const connectionId = connection?.id || '', objective = connection?.measurementConfig?.objective || 'reach';
  const { report, analysis, page, setPage, act, busy, active, loading, readError, actionError, retry } = useAccountAnalysis({ api, connectionId, objective, onInteractionStateChange, onMutation });
  const progress = analysis?.progress, error = readError || actionError, errorRef = useRef(null);
  const dialog = useRef(null);
  const closeConsent = useDialog(dialog, { open: Boolean(consent), onClose: () => setConsent(null) });
  const canRefresh = Boolean(report && !readError && !busy && !active && connection?.state === 'connected' && !connection.revalidationRequired && !connection.disconnectStatus);
  const canCancel = Boolean(active && !readError && !busy);
  const rules = analysis?.rules.current ?? [];
  const consentCurrent = consent?.connectionId === connectionId && consent.analysisId === (analysis?.id ?? null);
  const requestConsent = action => setConsent({ action, connectionId, analysisId: analysis?.id ?? null });
  const confirmConsent = () => {
    if (!consentCurrent || !(consent.action === 'refresh' ? canRefresh : canCancel)) return;
    setConsent(null);
    void act(consent.action);
  };
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  return <section className={`${styles.panel} ${accountStyles.accountPanel}`} aria-label="Análisis histórico de las cuentas Meta"
    data-account-analysis-connection={connectionId || undefined} data-account-analysis-state={connectionId ? (readError ? 'error' : analysis?.state || (report ? 'missing' : 'loading')) : undefined}>
    <header className={accountStyles.stageTitle}><p className={styles.eyebrow}>Lectura de la cuenta</p><h3>Análisis histórico y contenido actual</h3>
      <p>Examina los recursos profesionales accesibles de los últimos 12 meses calendario y su configuración actual. El análisis no publica ni cambia anuncios.</p>
    </header>
    {!eligible.length ? <p tabIndex={-1} data-advisor-control="ad-account-analysis-connection">Conecta Meta mediante OAuth o token manual para iniciar el análisis de solo lectura.</p> : <>
      <label className="field">Conexión<select data-advisor-control="ad-account-analysis-connection" value={connectionId} disabled={busy} onChange={event => { setSelected(event.target.value); setPage(1); }}>
        <option value="" disabled>Elige la conexión Meta exacta</option>
        {eligible.map(item => <option key={item.id} value={item.id}>{item.name || item.id}{item.authenticationMethod === 'token' || item.readOnly ? ' · Token / solo lectura' : ' · OAuth'}</option>)}
      </select></label>
    </>}
    {connection && <>
      <p>Objetivo configurado: <strong>{objectives[report?.objective || objective] || 'Alcance'}</strong>. Se lee de la medición de esta conexión; cambiar el objetivo reevalúa propuestas locales sin repetir las consultas del año.</p>
      {(report?.readOnly || connection?.authenticationMethod === 'token' || connection?.readOnly) && <p className={styles.notice}>Token manual · Solo lectura. Este panel no activa ni publica contenido.</p>}
      {loading && <p role="status">{report ? 'Actualizando estado local…' : 'Consultando análisis guardado…'}</p>}
      {!loading && !analysis && !error && <p>Aún no existe un análisis guardado para esta conexión.</p>}
      <div className={accountStyles.refreshActions}>
        <div className={accountStyles.operation}>
          <button type="button" className="button subtle" data-advisor-control={canRefresh ? 'ad-account-analysis-refresh' : undefined} disabled={!canRefresh} onClick={() => requestConsent('refresh')}>{analysis ? 'Actualizar análisis desde Meta' : 'Iniciar análisis desde Meta'}</button>
          <p className={styles.help}>Solicita una nueva lectura de los recursos accesibles. Está sujeta a permisos y límites de Meta.</p>
          {report && !busy && !readError && !canRefresh && <p tabIndex={-1} data-advisor-control="ad-account-analysis-refresh">{active ? 'Ya hay una lectura histórica en curso para esta conexión.' : 'Reconecta o valida esta cuenta antes de iniciar otra lectura histórica.'}</p>}
          {active && <button type="button" className="button subtle" data-advisor-control={canCancel ? 'ad-account-analysis-cancel' : undefined} disabled={!canCancel} onClick={() => requestConsent('cancel')}>Cancelar lectura local</button>}
          {report && !active && !busy && !readError && <p tabIndex={-1} data-advisor-control="ad-account-analysis-cancel">No hay una lectura histórica en curso para esta conexión.</p>}
        </div>
        <div className={accountStyles.operation}>
          <button type="button" className="button subtle" disabled={busy || loading} onClick={retry}>Reintentar estado local</button>
          <p className={styles.help}>Consulta el estado guardado aquí. No inicia un nuevo análisis en Meta.</p>
        </div>
      </div>
      {report && !analysis && !readError && <p tabIndex={-1} data-advisor-control="ad-account-analysis-rule-source">Esta conexión aún no tiene una lectura guardada con fuentes de Meta.</p>}
      {analysis && <>
        <div className={accountStyles.accountStatus}>
          <h4>Estado de la lectura</h4>
          <p role="status"><strong>{states[analysis.state] || analysis.state}</strong> · Captura {date(analysis.updatedAt)}</p>
          <p>Período solicitado: {analysis.period.since} – {analysis.period.until}. El día actual es parcial; Ads usa la zona de cada cuenta. Las métricas orgánicas abarcan la vida del contenido accesible, no solo el año.</p>
          {analysis.stale && <p className={styles.warning}>El acceso, la configuración o los recursos cambiaron. Los datos son históricos locales; actualiza el análisis con una conexión válida. No se proponen optimizaciones sobre esta captura.</p>}
          <p>Fase: {progress.phase}. Unidades completadas: {progress.completed}{progress.total === null ? ' · Total abierto mientras existan cursores o tareas por descubrir' : ` de ${progress.total}`}.</p>
          {progress.total !== null && progress.total > 0 && <progress max={progress.total} value={progress.completed} aria-label="Unidades de lectura completadas"/>}
          <p>{progress.resources} recursos · {progress.pages} páginas/unidades de datos consultadas · {progress.objects} objetos guardados · {progress.pendingKnownUnits} unidades conocidas pendientes.</p>
          <p className={styles.muted}>{progress.notice}</p>
          {analysis.retryAt && <p>Próximo reintento no antes de {date(analysis.retryAt)}. Se respeta el tiempo de espera de Meta.</p>}
          {analysis.error && <p className={styles.warning}>{analysis.error.notice} ({analysis.error.code})</p>}
        </div>
        <details className={`${styles.technicalDetails} ${accountStyles.disclosure}`}><summary>Cobertura y faltantes</summary>
          <p>Permisos confirmados en la última lectura: {analysis.permissions?.join(', ') || 'Sin permisos confirmados todavía'}. Ads requiere ads_read o ads_management y tareas de análisis; Facebook requiere pages_read_engagement y read_insights para métricas; Instagram requiere instagram_basic, instagram_manage_insights y pages_read_engagement. Descubrir páginas requiere pages_show_list.</p>
          <ul>{analysis.coverage.map((item, index) => <li key={`${item.kind}:${item.resourceId || 'discovery'}:${index}`}><strong>{item.kind} {item.resourceId || '· Descubrimiento'}: {coverageStates[item.state] || item.state}</strong>{item.notice && <p>{item.notice}</p>}{item.missing?.length > 0 && <ul>{item.missing.map((missing, i) => <li key={i}>{missing.stage || 'Acceso'}: {missing.reason} · {missing.count || 1} incidencias{missing.sampleObjectIds?.length ? ` · Muestra: ${missing.sampleObjectIds.join(', ')}` : ''}</li>)}</ul>}</li>)}</ul>
        </details>
        <details className={`${styles.technicalDetails} ${accountStyles.disclosure}`} data-advisor-disclosure>
          <summary data-advisor-control={rules.length > 1 ? 'ad-account-analysis-rule-source' : undefined}>Reglas actuales, evidencia y límites históricos</summary>
          <p>Fuentes revisadas: {analysis.rules.sourceReviewedAt}. Captura: {date(analysis.rules.observedAt)}. API {analysis.rules.apiVersion}; no constituye certificación legal ni aprobación de Meta.</p>
          {rules.length > 1 && <p>Elige la fuente de la regla exacta que quieres revisar. El enlace abre Meta en otra pestaña.</p>}
          {rules.length ? <ul>{rules.map(rule => <li key={rule.id}>{rule.rule} <a aria-label={`Fuente Meta: ${rule.rule}`} data-advisor-control={rules.length === 1 ? 'ad-account-analysis-rule-source' : undefined} href={rule.source} target="_blank" rel="noopener noreferrer">Fuente Meta</a></li>)}</ul>
            : <p tabIndex={-1} data-advisor-control="ad-account-analysis-rule-source">La lectura guardada no contiene fuentes de reglas vigentes.</p>}
          <p><strong>Histórico: no verificable.</strong> {analysis.rules.historical.notice}</p>
          <ul>{analysis.rules.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
        </details>
        <h4>Propuestas revisables por objetivo</h4>
        {!report.proposals.length && <p>No hay propuestas respaldadas por este análisis para el objetivo seleccionado.</p>}
        {report.proposals.map(proposal => <article key={proposal.id} className={`${styles.card} ${accountStyles.learningCard}`}><h5>{proposal.title}</h5><p>{proposal.change}</p>
          <ul>{proposal.evidence.map((evidence, index) => <li key={`${evidence.itemId}:${index}`}>Evidencia {evidence.itemId} · {evidence.metric}: {evidence.result.value ?? 'No disponible'} {evidence.result.unit} · {evidence.result.status} · Periodo {evidence.period.type === 'range' ? `${evidence.period.since} – ${evidence.period.until}` : 'Lifetime'} · {evidence.scope}</li>)}</ul>
          <p>Comparables: {proposal.comparables.length ? proposal.comparables.join(', ') : 'Sin comparable compatible; no se declara ganador.'}</p>
          <details><summary>Configuración actual correspondiente ({proposal.configurationCoverage?.matched || 0} capturas revisadas)</summary>
            <p>{proposal.configurationCoverage?.notice}</p>
            {(proposal.configurationEvidence || []).map(snapshot => <article key={snapshot.itemId}><p>Evidencia {snapshot.itemId} · {snapshot.resourceKind} {snapshot.resourceId} · Capturada {date(snapshot.observedAt)} · Configuración actual, no histórica.</p><pre>{JSON.stringify(snapshot.configuration, null, 2)}</pre></article>)}
            <p>Histórico: no verificable. {proposal.historicalConfiguration?.notice}</p>
          </details>
          <details><summary>Reglas aplicables y fuentes</summary><ul>{(proposal.applicableRules || []).map(rule => <li key={rule.id}>{rule.rule} · Fuente revisada {rule.sourceReviewedAt || analysis.rules.sourceReviewedAt}: <a href={rule.source} target="_blank" rel="noreferrer">Meta</a></li>)}</ul></details>
          <ul>{proposal.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
        </article>)}
        <p className={styles.muted}>{report.evidenceCoverage?.notice} Resultados examinados: {report.evidenceCoverage?.examined || 0} de {report.evidenceCoverage?.total || 0}; pertinentes para este objetivo: {report.evidenceCoverage?.qualifying || 0}. Configuraciones actuales examinadas: {report.evidenceCoverage?.configurations?.examined || 0} de {report.evidenceCoverage?.configurations?.total || 0}.{report.evidenceCoverage?.complete === false ? ' La captura cambió durante la consulta: vuelve a consultar.' : ''}</p>
        <details className={`${styles.technicalDetails} ${accountStyles.disclosure}`}><summary>Objetos y capturas guardadas ({report.pagination.total})</summary>
          {report.items.map(item => <article key={item.id} className={styles.card}><h5>{item.resourceKind} · {item.resourceId}</h5><p>Evidencia {item.id} · {date(item.observedAt)}</p><pre>{JSON.stringify({ period: item.period, configuration: item.configuration, dimensions: item.dimensions, values: item.values, coverage: item.coverage, metricsAvailability: item.metricsAvailability }, null, 2)}</pre></article>)}
          <nav className={accountStyles.pagination} aria-label="Páginas del análisis"><button type="button" className="button subtle" disabled={busy || loading || page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page} de {Math.max(1, Math.ceil(report.pagination.total / report.pagination.pageSize))}</span><button type="button" className="button subtle" disabled={busy || loading || page * report.pagination.pageSize >= report.pagination.total} onClick={() => setPage(value => value + 1)}>Siguiente</button></nav>
        </details>
      </>}
    </>}
    {consent && <dialog ref={dialog} className={`admin-dialog ${styles.dialog}`} aria-labelledby="account-analysis-consent-title" aria-describedby="account-analysis-consent-detail">
      <header className={styles.dialogHeader}><h2 id="account-analysis-consent-title">{consent.action === 'refresh' ? 'Autorizar una nueva lectura histórica' : 'Confirmar cancelación de la lectura local'}</h2></header>
      <p id="account-analysis-consent-detail">{consent.action === 'refresh'
        ? <>Cuenta: <strong>{connection?.name || consent.connectionId}</strong>. Se encolará una lectura de los recursos accesibles de Meta. No se publicará ni se cambiarán anuncios o permisos.</>
        : <>Cuenta: <strong>{connection?.name || consent.connectionId}</strong>. Se detendrá la lectura local {consent.analysisId}. No se modificarán publicaciones, accesos ni medición en Meta.</>}</p>
      <div className={styles.actions}>
        <button type="button" className="button subtle" data-dialog-initial-focus onClick={closeConsent}>Volver sin cambios</button>
        <button type="button" className="button primary" disabled={!consentCurrent || !(consent.action === 'refresh' ? canRefresh : canCancel)} onClick={confirmConsent}>{consent.action === 'refresh' ? 'Autorizar consulta histórica a Meta' : 'Confirmar cancelación local'}</button>
      </div>
    </dialog>}
    {error && <p ref={errorRef} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
  </section>;
}

const contentNames = { all: 'Todo', facebook: 'Facebook', instagram: 'Instagram', campaigns: 'Campañas' };
const contentTabs = Object.entries(contentNames).map(([id, label]) => ({ id, label }));
const coverageNames = { facebook: 'Facebook', instagram: 'Instagram', ad_account: 'Publicidad', discovery_facebook: 'Páginas e Instagram', discovery_ads: 'Cuentas publicitarias' };
const metricNames = {
  impressions: 'Impresiones', clicks: 'Clics totales', inline_link_clicks: 'Clics en enlace', reach: 'Alcance', spend: 'Gasto',
  frequency: 'Frecuencia', ctr: 'Tasa de clics', cpc: 'Costo por clic', cpm: 'Costo por mil impresiones',
  post_engagement: 'Interacciones con la publicación', link_click: 'Acciones de clic en enlace',
  'onsite_conversion.messaging_conversation_started_7d': 'Conversaciones iniciadas reportadas por Meta',
  'offsite_conversion.fb_pixel_purchase': 'Compras atribuidas al píxel por Meta', omni_purchase: 'Compras atribuidas por Meta',
  views: 'Visualizaciones', plays: 'Reproducciones', interactions: 'Interacciones', reactions: 'Reacciones',
  likes: 'Me gusta', comments: 'Comentarios', saves: 'Guardados', shares: 'Compartidos', linkClicks: 'Clics en enlace',
  averageWatchTime: 'Tiempo medio de reproducción', totalWatchTime: 'Tiempo total de reproducción', skipRate: 'Tasa de omisión'
};
const paidPrimary = ['impressions', 'clicks', 'reach', 'spend'];
const organicPrimary = ['views', 'plays', 'reach', 'interactions', 'reactions', 'likes'];
const scopes = { organic: 'Orgánico', mixed: 'Mixto (orgánico y pagado)', paid: 'Pauta' };
const formats = { IMAGE: 'Imagen', VIDEO: 'Video', CAROUSEL_ALBUM: 'Carrusel', REELS: 'Reel', reel: 'Reel', photo: 'Foto', video: 'Video', added_photos: 'Foto', added_video: 'Video', shared_story: 'Contenido compartido' };
const campaignStates = { ACTIVE: 'Activa', PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada', IN_PROCESS: 'En procesamiento', WITH_ISSUES: 'Con incidencias' };
const campaignObjectives = { OUTCOME_AWARENESS: 'Reconocimiento', OUTCOME_TRAFFIC: 'Tráfico', OUTCOME_ENGAGEMENT: 'Interacción', OUTCOME_LEADS: 'Clientes potenciales', OUTCOME_APP_PROMOTION: 'Promoción de la aplicación', OUTCOME_SALES: 'Ventas' };

function ownerName(connection, { kind, ownerId }) {
  const pages = connection.resources?.pages || [];
  if (kind === 'instagram') return pages.find(page => page.instagramId === ownerId)?.instagramName || ownerId;
  const resources = kind === 'campaigns' ? connection.resources?.adAccounts : pages;
  return resources?.find(resource => resource.id === ownerId)?.name || ownerId;
}

function MetricList({ entries, reading }) {
  return <dl className="summary-values" data-connection-metrics>{entries.map(([key, entry]) => {
    const unit = entry.unit === 'account_currency_decimal' || key === 'cpc' || key === 'cpm' ? reading.currency || 'moneda no informada'
      : key === 'ctr' || entry.unit === 'percent' ? '%' : entry.unit === 'milliseconds' ? 'ms' : key === 'frequency' ? 'veces por persona alcanzada' : '';
    return <div key={key}><dt>{metricNames[key]}</dt><dd>{entry.value == null ? 'Sin dato' : `${entry.value}${unit ? ` ${unit}` : ''}`}{entry.status === 'estimated' ? ' · Estimado' : ''}</dd></div>;
  })}</dl>;
}

function ContentRow({ item, connection, snapshot, onNavigate }) {
  const { kind, resourceId, ownerId, object, metrics } = item;
  const paid = kind === 'campaigns', config = object?.configuration || {};
  const title = paid ? `Campaña ${resourceId}` : `${contentNames[kind]} · Publicación ${resourceId}`;
  const format = config.productType === 'REELS' ? config.productType : config.mediaType || config.statusType || config.assetType;
  const state = config.effective_status || config.status;
  const primary = paid ? paidPrimary : organicPrimary;
  const availability = { denied: 'No se concedió permiso para leer sus métricas.', unavailable: 'Meta no devolvió métricas para este contenido.', unavailable_media_type: 'No se dispone de métricas para este formato.', pending: 'Las métricas aún no se han consultado.', partial: 'Lectura de métricas parcial.' };
  return <article className={styles.card}>
    <h4>{title}</h4>
    <p>{paid ? 'Cuenta publicitaria' : kind === 'instagram' ? 'Cuenta de Instagram' : 'Página de Facebook'}: {ownerName(connection, item)}{ownerName(connection, item) !== ownerId ? ` · ${ownerId}` : ''}</p>
    {paid ? <p>{object ? <>Configuración actual observada: {state ? `${campaignStates[state] || state}${config.effective_status ? '' : ' (configurado)'}` : 'Estado no informado'}{config.objective && ` · Objetivo: ${campaignObjectives[config.objective] || config.objective}`}</> : 'Sin configuración consultada'}</p>
      : <p>Publicada: {date(object?.period?.publishedAt)}{format ? ` · Formato: ${formats[format] || format}` : ''}</p>}
    {availability[object?.metricsAvailability] && <p>{availability[object.metricsAvailability]}</p>}
    {!metrics.length && <p>{paid && object ? 'Configuración disponible · Sin métricas' : 'Sin métricas en esta captura'}</p>}
    {metrics.map((reading, index) => {
      const values = reading.values || {};
      const first = primary.filter(key => values[key]).map(key => [key, values[key]]);
      const other = Object.entries(values).filter(([key]) => metricNames[key] && !primary.includes(key));
      const period = reading.period || {};
      return <div key={reading.id || index}>
        <p><strong>{scopes[reading.scope] || 'Ámbito no informado'}</strong> · {period.type === 'lifetime' ? 'Desde que se publicó' : period.type === 'range' ? `${period.since} a ${period.until}` : 'Período no informado'}{paid && reading.currency && ` · ${reading.currency}`}</p>
        <MetricList entries={first} reading={reading}/>
        <details className={styles.technicalDetails}><summary>Ver detalle</summary>
          <p>Observado: {date(reading.observedAt)}{period.timeZone && period.timeZone !== 'provider_account_timezone' ? ` · Zona: ${period.timeZone}` : ''}. {reading.coverage?.complete === false ? 'Cobertura parcial. ' : ''}Las cifras corresponden solo a este ámbito y período.</p>
          {!!other.length && <MetricList entries={other} reading={reading}/>}
        </details>
      </div>;
    })}
    {paid && /^act_\d+$/.test(ownerId) && /^\d+$/.test(resourceId) && snapshot?.id && <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'advertising', tab: 'campaigns', source: 'meta', connection: connection.id, account: ownerId, metaCampaign: resourceId, snapshot: snapshot.id, allAccounts: '1' })}>Ver en Publicidad</button>}
  </article>;
}

export function MetaConnectionData({ api, connection, blocked, onInteractionStateChange, onMutation, onNavigate }) {
  const [content, setContent] = useState('all');
  const { report, analysis, page, setPage, act, busy, active, loading, readError, actionError, retry } = useAccountAnalysis({ api, connectionId: connection.id, content, revision: connection.version, onInteractionStateChange, onMutation });
  const snapshot = report?.snapshot, coverage = analysis?.coverage || [], pagination = report?.pagination;
  const relevant = coverage.filter(item => content === 'all' || (content === 'campaigns' ? ['ad_account', 'discovery_ads'].includes(item.kind) : item.kind === content || item.kind === 'discovery_facebook'));
  const denied = relevant.some(item => item.state === 'denied');
  const partial = analysis?.state === 'partial' || relevant.some(item => ['partial', 'unavailable'].includes(item.state));
  const pages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;
  const refreshAllowed = !blocked && !busy && !active && !loading && !readError && connection.state === 'connected' && !connection.revalidationRequired && !connection.disconnectStatus;
  return <section className={styles.panel} aria-label="Datos consultados">
    <h3>Datos consultados</h3>
    <p>Recursos accesibles para esta conexión. La consulta puede abarcar más recursos que los seleccionados para publicar.</p>
    <div className={styles.actions}>
      <button type="button" className="button subtle" disabled={!refreshAllowed} onClick={() => act('refresh')}>{analysis ? 'Actualizar desde Meta' : 'Consultar desde Meta'}</button>
      {active && <button type="button" className="button subtle" disabled={blocked || busy} onClick={() => act('cancel')}>Cancelar lectura local</button>}
      <button type="button" className="button subtle" disabled={busy || loading} onClick={retry}>Reintentar lectura</button>
    </div>
    {loading && !report && <p role="status">Cargando datos guardados…</p>}
    {readError && <p role="alert" className={styles.error}>{readError}{report && ` Última lectura conservada: ${date(snapshot?.updatedAt || analysis?.updatedAt)}.`}</p>}
    {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
    {analysis && <p><strong>{states[analysis.state] || analysis.state}</strong> · Última consulta: {date(analysis.updatedAt)}{active && ` · Unidades completadas: ${analysis.progress?.completed ?? 0}`}{analysis.retryAt && ` · Próximo reintento: ${date(analysis.retryAt)}`}</p>}
    {snapshot && snapshot.id !== analysis?.id && <p className={styles.notice}>Actualizando; se muestra la consulta anterior · {date(snapshot.updatedAt)}</p>}
    {(snapshot?.stale || analysis?.stale || (snapshot && connection.state !== 'connected')) && <p className={styles.warning}>Histórico guardado. No acredita acceso vigente.</p>}
    {partial && <p className={styles.warning}>Cobertura parcial: no se devolvieron todos los datos solicitados.</p>}
    {denied && <p className={styles.warning}>Meta no concedió permiso para uno o más recursos de esta vista.</p>}
    {analysis?.error?.notice && <p className={styles.warning}>{analysis.error.notice}</p>}
    {!!relevant.length && <details className={styles.technicalDetails}><summary>Cobertura de la última consulta</summary><ul>{relevant.map((item, index) => <li key={index}>{coverageNames[item.kind] || item.kind}{item.resourceId ? ` · ${item.resourceId}` : ''}: {coverageStates[item.state] || item.state}</li>)}</ul></details>}
    <WorkspaceTabs label="Contenido consultado" items={contentTabs} value={content} disabled={busy} onChange={value => { if (value !== content) { setPage(1); setContent(value); } }}/>
    {report && !analysis && <p>Aún no existe una captura guardada para esta conexión.</p>}
    {analysis && !report.items.length && <p>{active ? 'Todavía no hay filas para este contenido.' : denied ? 'No hay filas para esta vista con los permisos consultados.' : ['failed', 'cancelled'].includes(analysis.state) ? 'La lectura terminó sin guardar filas para esta vista.' : 'Consulta completada sin filas para esta vista.'}</p>}
    <div className={styles.stack}>{report?.items.map(item => <ContentRow key={`${item.kind}:${item.ownerId}:${item.resourceId}`} item={item} connection={connection} snapshot={snapshot} onNavigate={onNavigate}/>)}</div>
    {pagination && (pages > 1 || page > 1) && <nav className={styles.actions} aria-label="Páginas de datos consultados">
      <button type="button" className="button subtle" disabled={busy || loading || page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
      <span>Página {page} de {pages} · {pagination.total} objetos</span>
      <button type="button" className="button subtle" disabled={busy || loading || page >= pages} onClick={() => setPage(page + 1)}>Siguiente</button>
    </nav>}
  </section>;
}
