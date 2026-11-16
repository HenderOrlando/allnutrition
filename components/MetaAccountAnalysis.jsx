'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social/connections';
const objectives = { reach: 'Alcance', engagement: 'Interacción', traffic: 'Tráfico', whatsapp: 'WhatsApp', sales: 'Ventas' };
const states = { queued: 'En cola', running: 'Consultando', waiting: 'Esperando límite de Meta / reintento', completed: 'Lecturas terminadas', partial: 'Lecturas terminadas con faltantes', cancelled: 'Cancelado', failed: 'Requiere atención' };
const coverageStates = { pending: 'Pendiente', running: 'En curso', accessible_complete: 'Lectura accesible terminada (no garantiza historia completa)', partial: 'Parcial', denied: 'Permiso denegado', unavailable: 'No disponible' };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin fecha';

export default function MetaAccountAnalysis({ api, connections = [], onInteractionStateChange, onMutation }) {
  const eligible = connections.filter(connection => connection.provider === 'meta' && connection.integrationMethod === 'api');
  const [selected, setSelected] = useState(''), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const connectionId = eligible.some(connection => connection.id === selected) ? selected : eligible[0]?.id || '';
  const connection = eligible.find(item => item.id === connectionId);
  const [report, setReport] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), mutations = useRef(new Set()), errorRef = useRef(null);
  const objective = connection?.measurementConfig?.objective || 'reach';
  useEffect(() => { onInteractionStateChange?.({ dirty: false, busy }); }, [busy, onInteractionStateChange]);
  useEffect(() => () => {
    for (const controller of mutations.current) controller.abort();
    onInteractionStateChange?.({ dirty: false, busy: false });
  }, [onInteractionStateChange]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    setReport(null); setError('');
    if (!connectionId) return;
    const controller = new AbortController(); let active = true, timer, failures = 0;
    async function load() {
      if (!active) return;
      if (document.hidden) { timer = setTimeout(load, 5000); return; }
      setLoading(true);
      let next = null;
      try {
        next = await api(`${ROOT}/${encodeURIComponent(connectionId)}/analysis?page=${page}&pageSize=20`, { signal: controller.signal });
        if (active) { setReport(next); setError(''); failures = 0; }
      } catch (cause) { if (active && cause.name !== 'AbortError') { setError(cause.message); failures++; } }
      finally { if (active) setLoading(false); }
      if (active && (!next || ['queued', 'running', 'waiting'].includes(next.analysis?.state))) {
        const retryAt = Date.parse(next?.analysis?.retryAt || '');
        timer = setTimeout(load, failures ? Math.min(60000, 5000 * 2 ** Math.min(failures, 4)) : Number.isFinite(retryAt) ? Math.max(5000, Math.min(60000, retryAt - Date.now())) : 5000);
      }
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, connectionId, page, refresh, objective]);
  async function act(action) {
    if (!connectionId || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    const controller = new AbortController(); mutations.current.add(controller);
    try {
      await api(`${ROOT}/${encodeURIComponent(connectionId)}/analysis`, { method: 'POST', body: JSON.stringify({ action }), signal: controller.signal });
      setPage(1); setRefresh(value => value + 1); await onMutation?.();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); }
    finally { mutations.current.delete(controller); lock.current = false; setBusy(false); }
  }
  const analysis = report?.analysis, progress = analysis?.progress, active = ['queued', 'running', 'waiting'].includes(analysis?.state);
  return <section className={styles.panel} aria-label="Análisis histórico de las cuentas Meta">
    <h2>Análisis histórico y contenido actual</h2>
    <p>Consulta automática de todos los recursos profesionales accesibles, no solo los seleccionados. Últimos 12 meses calendario y configuración actual, con capturas fechadas. Nunca publica ni cambia anuncios.</p>
    {!eligible.length ? <p>Conecta Meta mediante OAuth o token manual para iniciar el análisis de solo lectura.</p> : <>
      <label>Conexión <select value={connectionId} disabled={busy} onChange={event => { setSelected(event.target.value); setPage(1); }}>
        {eligible.map(item => <option key={item.id} value={item.id}>{item.name || item.id}{item.authenticationMethod === 'token' || item.readOnly ? ' · Token / solo lectura' : ' · OAuth'}</option>)}
      </select></label>
      <p>Objetivo configurado: <strong>{objectives[report?.objective || objective] || 'Alcance'}</strong>. Se lee de la medición de esta conexión; cambiar el objetivo reevalúa propuestas locales sin repetir las consultas del año.</p>
      {(report?.readOnly || connection?.authenticationMethod === 'token' || connection?.readOnly) && <p className={styles.notice}>Token manual · Solo lectura. Este panel no activa ni publica contenido.</p>}
      {loading && <p role="status">{report ? 'Actualizando estado local…' : 'Consultando análisis guardado…'}</p>}
      {!loading && !analysis && !error && <p>Aún no existe un análisis guardado para esta conexión.</p>}
      {analysis && <>
        <p role="status"><strong>{states[analysis.state] || analysis.state}</strong> · Captura {date(analysis.updatedAt)}</p>
        <p>Periodo solicitado: {analysis.period.since} – {analysis.period.until}. El día actual es parcial; Ads usa la zona de cada cuenta. Las métricas orgánicas son lifetime del contenido accesible, no métricas del año.</p>
        {analysis.stale && <p className={styles.warning}>El acceso, la configuración o los recursos cambiaron. Los datos son históricos locales; actualiza el análisis con una conexión válida. No se proponen optimizaciones sobre esta captura.</p>}
        <p>Fase: {progress.phase}. Unidades completadas: {progress.completed}{progress.total === null ? ' · Total abierto mientras existan cursores o tareas por descubrir' : ` de ${progress.total}`}.</p>
        {progress.total !== null && progress.total > 0 && <progress max={progress.total} value={progress.completed} aria-label="Unidades de lectura completadas"/>}
        <p>{progress.resources} recursos · {progress.pages} páginas/unidades de datos consultadas · {progress.objects} objetos guardados · {progress.pendingKnownUnits} unidades conocidas pendientes.</p>
        <p className={styles.muted}>{progress.notice}</p>
        {analysis.retryAt && <p>Próximo reintento no antes de {date(analysis.retryAt)}. Se respeta el tiempo de espera de Meta.</p>}
        {analysis.error && <p className={styles.warning}>{analysis.error.notice} ({analysis.error.code})</p>}
        <p>Permisos confirmados en la última lectura: {analysis.permissions?.join(', ') || 'Sin permisos confirmados todavía'}. Ads requiere ads_read o ads_management y tareas de análisis; Facebook requiere pages_read_engagement y read_insights para métricas; Instagram requiere instagram_basic, instagram_manage_insights y pages_read_engagement. Descubrir páginas requiere pages_show_list.</p>
        <details className={styles.detail} open><summary>Cobertura y faltantes</summary>
          <ul>{analysis.coverage.map((item, index) => <li key={`${item.kind}:${item.resourceId || 'discovery'}:${index}`}><strong>{item.kind} {item.resourceId || '· Descubrimiento'}: {coverageStates[item.state] || item.state}</strong>{item.notice && <p>{item.notice}</p>}{item.missing?.length > 0 && <ul>{item.missing.map((missing, i) => <li key={i}>{missing.stage || 'Acceso'}: {missing.reason} · {missing.count || 1} incidencias{missing.sampleObjectIds?.length ? ` · Muestra: ${missing.sampleObjectIds.join(', ')}` : ''}</li>)}</ul>}</li>)}</ul>
        </details>
        <details className={styles.detail}><summary>Reglas actuales, evidencia y límites históricos</summary>
          <p>Fuentes revisadas: {analysis.rules.sourceReviewedAt}. Captura: {date(analysis.rules.observedAt)}. API {analysis.rules.apiVersion}; no constituye certificación legal ni aprobación de Meta.</p>
          <ul>{analysis.rules.current.map(rule => <li key={rule.id}>{rule.rule} <a href={rule.source} target="_blank" rel="noreferrer">Fuente Meta</a></li>)}</ul>
          <p><strong>Histórico: no verificable.</strong> {analysis.rules.historical.notice}</p>
          <ul>{analysis.rules.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
        </details>
        <h3>Propuestas revisables por objetivo</h3>
        {report.proposals.map(proposal => <article key={proposal.id} className={styles.card}><h4>{proposal.title}</h4><p>{proposal.change}</p>
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
        <details className={styles.detail}><summary>Objetos y capturas guardadas ({report.pagination.total})</summary>
          {report.items.map(item => <article key={item.id} className={styles.card}><h4>{item.resourceKind} · {item.resourceId}</h4><p>Evidencia {item.id} · {date(item.observedAt)}</p><pre>{JSON.stringify({ period: item.period, configuration: item.configuration, dimensions: item.dimensions, values: item.values, coverage: item.coverage, metricsAvailability: item.metricsAvailability }, null, 2)}</pre></article>)}
          <nav aria-label="Páginas del análisis"><button type="button" className="button subtle" disabled={busy || loading || page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button><span> Página {page} de {Math.max(1, Math.ceil(report.pagination.total / report.pagination.pageSize))} </span><button type="button" className="button subtle" disabled={busy || loading || page * report.pagination.pageSize >= report.pagination.total} onClick={() => setPage(value => value + 1)}>Siguiente</button></nav>
        </details>
      </>}
      <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || active || connection?.state !== 'connected' || connection?.revalidationRequired} onClick={() => act('refresh')}>{analysis ? 'Actualizar análisis desde Meta' : 'Iniciar análisis desde Meta'}</button>{active && <button type="button" className="button subtle" disabled={busy} onClick={() => act('cancel')}>Cancelar lectura local</button>}<button type="button" className="button subtle" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>Reintentar estado local</button></div>
    </>}
    {error && <p ref={errorRef} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
  </section>;
}
