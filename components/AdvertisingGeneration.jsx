'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social/generation';
const PAGE_SIZE = 12;
const OBJECTIVES = { reach: 'Llegar a más personas', engagement: 'Invitar a interactuar', traffic: 'Llevar visitas al sitio web', whatsapp: 'Conseguir consultas por WhatsApp' };
const BUSINESS_OBJECTIVES = { sales: 'Ventas', traffic: 'Visitas', leads: 'Contactos', whatsapp: 'Consultas por WhatsApp', reach: 'Alcance', engagement: 'Interacciones', awareness: 'Reconocimiento' };
const PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram' };
const PLACEMENTS = { facebook_feed: 'Facebook Feed', facebook_reels: 'Facebook Reels', instagram_feed: 'Instagram Feed', instagram_reels: 'Instagram Reels' };
const CONSENT = { version: 2, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true };
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const isPending = job => ['queued', 'sending'].includes(job.state) || job.asset?.state === 'processing';
const sourceId = source => `${source.kind}:${source.id}`;
const sourceTitle = source => `${source.kind === 'product' ? 'Producto' : 'Biblioteca'}: ${identity({ ...source.facts, title: source.title })}`;
const sameAlignment = (left, right) => Boolean(left && right && left.mode === right.mode && left.objective === right.objective && (left.offerHash ?? null) === (right.offerHash ?? null));
const BASE_LABEL = 'Imagen a modificar';
const identity = item => [item.title, item.presentation, item.flavor].filter(Boolean).join(' · ');
const narrowViewport = () => window.matchMedia('(max-width: 600px)');
const subscribeViewport = listener => {
  const viewport = narrowViewport();
  viewport.addEventListener('change', listener);
  return () => viewport.removeEventListener('change', listener);
};
const isNarrow = () => narrowViewport().matches;
const isServerNarrow = () => false;

function OfferFacts({ item, label }) {
  if (!item) return null;
  return <div>
    <h5>{label}: {identity(item)}</h5>
    {item.brand && <p>Marca: {item.brand}</p>}
    <p>Precio: {item.priceCOP == null ? 'No informado' : COP.format(item.priceCOP)}</p>
    {item.condition && <p><strong>Condición del obsequio:</strong> {item.condition}</p>}
    {item.conditions && <p><strong>Condiciones de la oferta:</strong> {item.conditions}</p>}
    {item.components.length > 0 && <ul aria-label={`Componentes de ${label.toLowerCase()}`}>
      {item.components.map((component, index) => <li key={index}>{component.quantity} × {identity(component)}{component.brand ? ` · ${component.brand}` : ''}</li>)}
    </ul>}
    {item.productInfo && <p>Información de etiqueta: {item.productInfo}</p>}
    {item.description && <p>{item.description}</p>}
  </div>;
}

function BriefDetails({ context, baseName, onPreviewError }) {
  const { brief: { brand, campaign, offer, general }, baseAsset, automaticSources } = context;
  const secondary = general.catalogs.length || general.hours || general.messages.some(item => item.title || item.text) || general.shipping.some(item => item.area || item.timing);
  return <div className={`${styles.card} ${styles.stack}`}>
    <h4>Datos y fotos para preparar la imagen</h4>
    {brand.name || brand.tagline ? <p><strong>Identidad de marca:</strong> {[brand.name, brand.tagline].filter(Boolean).join(' · ')}</p> : null}
    {campaign && <div>
      <p><strong>Objetivo:</strong> {OBJECTIVES[campaign.objective]}</p>
      <p><strong>Acción y dirección visual:</strong> {campaign.direction}</p>
      <p>{campaign.mode === 'paid' ? 'Campaña pagada' : 'Publicación sin inversión'} · {campaign.platforms.length ? campaign.platforms.map(key => PLATFORMS[key]).join(', ') : 'Redes por definir'}{campaign.placements.length ? ` · ${campaign.placements.map(key => PLACEMENTS[key]).join(', ')}` : ''}</p>
      {campaign.destination && <p>Destino: {campaign.destination.type === 'whatsapp' ? 'WhatsApp' : campaign.destination.domain || 'Sitio web por definir'}</p>}
      {campaign.instagramOrganic && <p>En Instagram sin inversión, no se promete un enlace clicable en el texto.</p>}
      {campaign.businessObjective && <p>Meta secundaria del negocio: {BUSINESS_OBJECTIVES[campaign.businessObjective] || campaign.businessObjective}. No reemplaza el objetivo de la pieza.</p>}
      {campaign.headline && <p>Título de apoyo: {campaign.headline}</p>}
      {campaign.caption && <p>Texto de apoyo: {campaign.caption}</p>}
      {campaign.recommendation && <p>Orientación de la prueba: {campaign.recommendation}</p>}
    </div>}
    {offer ? <div className={styles.summaryGrid}>
      <OfferFacts item={offer.primary} label="Oferta principal" />
      <OfferFacts item={offer.gift} label="Obsequio adicional" />
    </div> : campaign && <p>Publicación de marca, sin oferta de catálogo.</p>}
    {secondary ? <details className={styles.technicalDetails}>
      <summary>Contexto general de la vitrina</summary>
      <p>Estos datos son de apoyo; no son condiciones de esta oferta. Los datos de apoyo se incluyen si hay espacio.</p>
      {general.catalogs.length > 0 && <p>Catálogos publicados: {general.catalogs.join(', ')}</p>}
      {general.hours && <p>Horario general: {general.hours}</p>}
      {general.messages.filter(item => item.title || item.text).map((item, index) => <p key={`message:${index}`}>{[item.title, item.text].filter(Boolean).join(' · ')}</p>)}
      {general.shipping.filter(item => item.area || item.timing).map((item, index) => <p key={`shipping:${index}`}>Envíos: {[item.area, item.timing].filter(Boolean).join(' · ')}</p>)}
    </details> : null}
    {(baseAsset || automaticSources.length > 0) && <div className={styles.summaryGrid}>
      {baseAsset && <div className={styles.assetPreview}>
        <strong>{BASE_LABEL}{baseName ? `: ${baseName}` : ''}</strong>
        <img className={styles.previewImage} src={baseAsset.previewUrl} alt={BASE_LABEL} onError={onPreviewError} />
        {baseAsset.state !== 'ready' && <p className={styles.warning}>Solo se puede conservar como referencia: el original no está listo para publicar.</p>}
      </div>}
      {automaticSources.map(source => <div className={styles.assetPreview} key={source.thumbnailUrl}>
        <img className={styles.previewImage} src={source.thumbnailUrl} alt="" onError={onPreviewError} width={96} height={96} />
        <span>{source.labels.join(' · ')}</span>
      </div>)}
    </div>}
    {campaign && !automaticSources.some(source => source.labels.some(label => label.startsWith('Oferta principal:'))) && offer && <p className={styles.help}>Si falta una foto de una referencia, se usará texto sin simular su envase.</p>}
  </div>;
}

function ReadyPreview({ asset, original, adjusting, onUse, disabled, compact, onOriginalError }) {
  const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const toggleComparison = original && compact;
  return <div className={styles.stack}>
    {toggleComparison && <div className={styles.actions} role="group" aria-label="Comparar original y variante">
      <button type="button" className="button subtle" aria-pressed={showOriginal} onClick={() => setShowOriginal(true)}>Antes · Original</button>
      <button type="button" className="button subtle" aria-pressed={!showOriginal} onClick={() => setShowOriginal(false)}>Después · Variante</button>
    </div>}
    <div className={original && !compact ? styles.summaryGrid : styles.assetPreview}>
      {original && <div hidden={toggleComparison && !showOriginal}><div className={styles.assetPreview}>
        <strong>Antes · Imagen original</strong><img className={styles.previewImage} src={original.previewUrl} alt="Imagen original antes del ajuste" onError={onOriginalError} />
      </div></div>}
      <div hidden={toggleComparison && showOriginal}><div className={styles.assetPreview}>
        <strong>{original ? 'Después · Variante' : 'Vista previa de la pieza'}</strong>
        {failed ? <div role="alert" className={styles.error}><p>No se pudo leer la vista previa privada de la pieza.</p><button type="button" className="button subtle" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Volver a cargar vista previa</button></div>
          : asset.kind === 'video' ? <video key={attempt} className={styles.previewVideo} src={asset.previewUrl} controls preload="metadata" playsInline onLoadedMetadata={() => setLoaded(true)} onError={() => { setLoaded(false); setFailed(true); }} aria-label="Vista previa de la pieza" />
            : <img key={attempt} className={styles.previewImage} src={asset.previewUrl} alt={original ? 'Vista previa de la variante' : 'Vista previa de la pieza'} onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setFailed(true); }} />}
      </div></div>
    </div>
    {onUse && <div className={styles.actions}><button type="button" className="button primary" disabled={disabled || !loaded || failed} onClick={() => onUse(asset)}>{adjusting ? 'Usar la variante' : 'Usar esta imagen'}</button></div>}
  </div>;
}

function Job({ job, contextual, alignment, original, adjusting, onUseAsset, busy, compact, onOriginalError }) {
  const { asset, state } = job;
  const ready = state === 'succeeded' && asset?.state === 'ready' && Boolean(asset.previewUrl);
  const aligned = !contextual || sameAlignment(asset?.alignment, alignment);
  const label = ready ? 'Lista para revisar'
    : isPending(job) ? 'Preparando imagen'
      : state === 'blocked' ? 'No enviada' : state === 'uncertain' ? 'Envío incierto: posible cargo'
        : asset?.state === 'archived' ? 'Imagen archivada' : 'No se pudo preparar la imagen';
  return <article className={styles.card}>
    <strong>{label} · {job.format.toUpperCase()}</strong>
    {state === 'queued' && <p>En cola; todavía no se ha enviado.</p>}
    {state === 'blocked' && <p>{job.notice}</p>}
    {state === 'uncertain' && <p>El envío pudo generar un cargo, pero no hay un resultado confirmado. No se repetirá automáticamente. Comprueba el consumo antes de autorizar otra solicitud.</p>}
    <p className={styles.help}>Solicitada: {new Date(job.createdAt).toLocaleString('es-CO')}</p>
    {asset?.diagnostic && <p role="alert" className={styles.warning}>{asset.diagnostic.message}</p>}
    {ready && <>
      {contextual && !aligned && <p className={styles.warning}>Esta imagen corresponde a otra oferta u objetivo, o no se puede confirmar su correspondencia actual. Se conserva en la biblioteca.</p>}
      <ReadyPreview key={`${asset.id}:${asset.version}`} asset={asset} original={original} adjusting={adjusting} onUse={onUseAsset} disabled={!aligned || busy || adjusting && !original} compact={compact} onOriginalError={onOriginalError} />
      <p className={styles.help}>Revisa el producto, la etiqueta, el texto, las afirmaciones y los derechos. No se ha publicado.</p>
    </>}
    {asset?.originalUrl && asset.state !== 'missing_file' && <p><a href={asset.originalUrl} target="_blank" rel="noreferrer">Ver o descargar original {job.format.toUpperCase()}</a></p>}
  </article>;
}

export default function AdvertisingGeneration({ api, campaignId = null, campaignVersion = null, baseAsset = null, onUseAsset, onPreserveBase, onRefreshContext,
  contextDirty = false, currentAlignment, onInteractionStateChange, onMutation, sourceRevision = 0, active = true, instructions, onInstructionsChange }) {
  const [localPrompt, setLocalPrompt] = useState(''), prompt = instructions ?? localPrompt;
  const [format, setFormat] = useState('png'), [frameCount, setFrameCount] = useState(9), [frameDurationMs, setFrameDurationMs] = useState(400);
  const [consent, setConsent] = useState(null), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(''), [requestNotice, setRequestNotice] = useState('');
  const [progress, setProgress] = useState(null), [listRevision, setListRevision] = useState(0);
  const [review, setReview] = useState(null), [briefRevision, setBriefRevision] = useState(0), [failedPreviewKey, setFailedPreviewKey] = useState(null);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [page, setPage] = useState(null), [sourceRevisionLocal, setSourceRevisionLocal] = useState(0);
  const [selected, setSelected] = useState([]), [sourceLimitError, setSourceLimitError] = useState('');
  const request = useRef(null), mutation = useRef(null), refreshLock = useRef(false), observed = useRef(new Map()), errorRef = useRef(null);
  const pendingRead = useRef(null);
  const compact = useSyncExternalStore(subscribeViewport, isNarrow, isServerNarrow);
  const callbacks = useRef({ onInteractionStateChange, onMutation });
  callbacks.current = { onInteractionStateChange, onMutation };
  const baseId = baseAsset?.id ?? null, adjusting = Boolean(baseId), contextual = Boolean(campaignId), requestedFormat = adjusting ? 'png' : format;
  const briefIdentity = JSON.stringify([campaignId, campaignVersion, baseId, baseAsset?.version]);
  const briefKey = `${briefIdentity}:${briefRevision}`;
  const sourceKey = JSON.stringify([query, offset, sourceRevision, sourceRevisionLocal]);
  const progressRead = progress?.campaignId === campaignId ? progress : null;
  const availability = progressRead?.data?.availability;
  const jobs = progressRead?.data?.jobs;
  const briefRead = review?.key === briefKey ? review : null;
  const context = briefRead?.data;
  const alignment = currentAlignment === undefined ? context?.alignment : currentAlignment;
  const alignmentKey = alignment ? JSON.stringify([alignment.mode, alignment.objective, alignment.offerHash ?? null]) : null;
  const briefMatches = Boolean(context && context.campaignId === campaignId && context.campaignVersion === campaignVersion
    && (context.baseAsset?.id ?? null) === baseId && (!adjusting || baseAsset.version == null || context.baseAsset.version === baseAsset.version)
    && (!contextual || sameAlignment(context.alignment, alignment)));
  const sourceRead = page?.key === sourceKey ? page : null;
  const sources = sourceRead?.data?.sources || [];
  const usableSources = selected.filter(source => source.kind !== 'asset' || source.id !== baseId);
  const sourceLimit = adjusting ? 3 : 4;
  const staleSource = usableSources.some(source => sources.some(current => sourceId(current) === sourceId(source) && current.version !== source.version));
  const previewFailed = failedPreviewKey === briefKey;
  const promptRequired = !contextual || adjusting;
  const frames = Number(frameCount), duration = Number(frameDurationMs), gifMs = frames * duration;
  const validFormat = requestedFormat !== 'gif' || (Number.isInteger(frames) && frames >= 2 && frames <= 16 && duration >= 20 && duration <= 2000 && duration % 10 === 0 && gifMs >= 3000 && gifMs <= 32000);
  const canConsent = Boolean(active && !contextDirty && briefMatches && !previewFailed && !refreshing && availability?.available && !progressRead?.error
    && (!promptRequired || prompt.trim()) && validFormat && (contextual || !staleSource && usableSources.length <= sourceLimit));
  const payload = canConsent ? {
    campaignId, campaignVersion, briefHash: context.briefHash,
    baseAsset: adjusting ? { id: context.baseAsset.id, version: context.baseAsset.version, sha256: context.baseAsset.sha256 } : null,
    configurationVersion: availability.configurationVersion, prompt, format: requestedFormat,
    ...(requestedFormat === 'gif' ? { frameCount: frames, frameDurationMs: duration } : {}),
    sources: contextual ? [] : usableSources.map(({ kind, id, version }) => ({ kind, id, version })), consent: CONSENT,
  } : null;
  const payloadKey = payload ? JSON.stringify(payload) : null;
  const checked = Boolean(payloadKey && consent === payloadKey);
  const dirty = Boolean(prompt || selected.length || consent || format !== 'png');
  const currentFence = useRef(null);
  currentFence.current = { briefKey, contextDirty, alignmentKey, prompt };

  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy: busy || refreshing }); }, [dirty, busy, refreshing]);
  useEffect(() => () => { mutation.current?.abort(); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); }, []);
  useEffect(() => { if (active && error) errorRef.current?.focus(); }, [active, error]);
  useEffect(() => {
    setConsent(null);
    request.current = null;
  }, [briefIdentity, contextDirty, currentAlignment?.mode, currentAlignment?.objective, currentAlignment?.offerHash, availability?.configurationVersion]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(), { signal } = controller, params = new URLSearchParams();
    if (campaignId) params.set('campaignId', campaignId);
    const path = campaignId ? `${ROOT}?${params}` : ROOT;
    let timer, pending = pendingRead.current?.campaignId === campaignId && pendingRead.current.pending;
    async function readProgress() {
      if (signal.aborted) return;
      if (document.hidden) { timer = setTimeout(readProgress, 5000); return; }
      try {
        const data = await api(path, { signal });
        if (signal.aborted) return;
        pending = data.jobs.some(isPending);
        pendingRead.current = { campaignId, pending };
        let newlyReady = false;
        for (const job of data.jobs) {
          const ready = job.asset?.state === 'ready';
          if (ready && observed.current.get(job.id) === false) newlyReady = true;
          observed.current.set(job.id, ready);
        }
        setProgress({ campaignId, data, error: '' });
        if (newlyReady) void notifyMutation();
      } catch (cause) {
        if (!signal.aborted) setProgress(previous => ({ campaignId, data: previous?.campaignId === campaignId ? previous.data : null, error: cause.message }));
      }
      if (pending && !signal.aborted) timer = setTimeout(readProgress, 5000);
    }
    void readProgress();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, api, campaignId, listRevision]);
  useEffect(() => {
    if (!active || contextDirty) return;
    const controller = new AbortController(), params = new URLSearchParams();
    if (campaignId) params.set('campaignId', campaignId);
    if (baseId) params.set('baseAssetId', baseId);
    api(`${ROOT}/brief${params.size ? `?${params}` : ''}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setReview({ key: briefKey, data, error: '' });
    }, cause => {
      if (!controller.signal.aborted) setReview({ key: briefKey, data: null, error: cause.message });
    });
    return () => controller.abort();
  }, [active, api, briefKey, campaignId, baseId, contextDirty]);
  useEffect(() => {
    if (!active || contextual) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(`${ROOT}/sources?${new URLSearchParams({ query, offset: String(offset), limit: String(PAGE_SIZE) })}`, { signal: controller.signal }).then(data => {
        if (!controller.signal.aborted) setPage({ key: sourceKey, data, error: '' });
      }, cause => {
        if (!controller.signal.aborted) setPage({ key: sourceKey, data: null, error: cause.message });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, api, contextual, query, offset, sourceKey]);

  async function notifyMutation() {
    try { await callbacks.current.onMutation?.(); } catch (cause) {
      setRequestNotice(`La solicitud se conserva, pero no se pudo actualizar la biblioteca. ${cause.message}`);
    }
  }
  function changed(setter, value) {
    setter(value); setConsent(null); request.current = null; setError(''); setRequestNotice('');
  }
  function toggle(source) {
    const prior = selected.find(item => sourceId(item) === sourceId(source));
    if (!prior && usableSources.length >= sourceLimit) { setSourceLimitError(`Selecciona como máximo ${sourceLimit} referencias adicionales.`); return; }
    setSourceLimitError('');
    const next = prior && prior.version === source.version ? selected.filter(item => item !== prior)
      : prior ? selected.map(item => item === prior ? source : item) : [...selected, source];
    changed(setSelected, next);
  }
  function reload() {
    setConsent(null);
    setBriefRevision(value => value + 1); setListRevision(value => value + 1); setSourceRevisionLocal(value => value + 1);
  }
  async function refreshContext() {
    if (refreshLock.current || busy) return;
    refreshLock.current = true; setRefreshing(true); setError('');
    try {
      if (onRefreshContext && await onRefreshContext() === false) return;
      reload();
    } catch (cause) { setError(cause.message); }
    finally { refreshLock.current = false; setRefreshing(false); }
  }
  async function submit() {
    if (mutation.current || refreshLock.current || !checked || !payload) return;
    if (request.current?.key !== payloadKey) request.current = { key: payloadKey, id: crypto.randomUUID() };
    const controller = new AbortController(), { signal } = controller;
    const requestId = request.current.id;
    mutation.current = controller; setBusy(true); setError(''); setRequestNotice('');
    const stillCurrent = () => {
      const live = currentFence.current;
      return !signal.aborted && !live.contextDirty && live.briefKey === briefKey && live.alignmentKey === alignmentKey && live.prompt === prompt;
    };
    try {
      const job = await api(ROOT, { method: 'POST', body: JSON.stringify({ ...payload, requestId }), signal });
      if (signal.aborted) return;
      observed.current.set(job.id, job.asset?.state === 'ready');
      if (isPending(job)) pendingRead.current = { campaignId, pending: true };
      if (stillCurrent()) {
        request.current = null; setConsent(null);
        (onInstructionsChange || setLocalPrompt)(''); setSelected([]);
        setRequestNotice('Solicitud registrada. Revisa su progreso; todavía no hay nada publicado.');
      }
      setListRevision(value => value + 1);
      void notifyMutation();
    } catch (cause) {
      if (!stillCurrent()) return;
      if (cause.status === 409) {
        request.current = null;
        reload();
        setError(`${cause.message} Se conservaron tus indicaciones. Revisa los datos y autoriza de nuevo.`);
      } else {
        setError(`${cause.message} Si la respuesta se perdió, enviar las mismas indicaciones y datos conserva el identificador y no duplica la solicitud.`);
      }
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  const visibleJobs = jobs?.filter(job => (!contextual || job.campaignId === campaignId) && (!adjusting || job.baseAssetId === baseId));
  const reportPreviewFailure = () => setFailedPreviewKey(briefKey);
  return <div hidden={!active}><section className={`${styles.card} ${styles.stack}`} aria-label={adjusting ? 'Ajustar con indicaciones' : 'Crear imagen'}>
    <h3>{adjusting ? 'Ajustar con indicaciones' : 'Crear imagen'}</h3>
    <p className={styles.help}>{adjusting ? 'La imagen original se conserva. El ajuste crea otro archivo y no cambia los hechos del catálogo.' : 'Prepara una pieza para revisar. Abrir esta sección no crea una solicitud ni publica nada.'}</p>
    {!progressRead && <p role="status">Comprobando disponibilidad y solicitudes…</p>}
    {progressRead?.error && <p role="alert" className={styles.error}>{progressRead.error} Vuelve a comprobar con «Actualizar progreso».</p>}
    {availability && !availability.available && <p className={styles.warning}>{availability.reason || 'El servicio de imágenes no está disponible. Puedes subir una imagen o elegirla de biblioteca.'}</p>}
    {!contextDirty && !briefRead && <p role="status">Preparando los datos para revisar…</p>}
    {contextDirty && <p className={styles.warning} role="status">Hay cambios sin guardar. Guarda el borrador y vuelve a revisar los datos; tus indicaciones se conservarán.</p>}
    {!contextDirty && briefRead?.error && <p role="alert" className={styles.error}>{briefRead.error}{adjusting && ' Si la foto no se puede ajustar, elige otra imagen.'}</p>}
    {!contextDirty && context && !briefMatches && <p role="alert" className={styles.warning}>Cambió el borrador o la imagen a modificar. Vuelve a revisar los datos antes de autorizar.</p>}
    {previewFailed && <p role="alert" className={styles.warning}>No se pudo ver una foto de referencia. Vuelve a comprobar los datos o elige otra imagen antes de autorizar.</p>}
    <div className={styles.actions}>
      {(contextDirty || briefRead?.error || context && !briefMatches || previewFailed) && <button type="button" className="button subtle" disabled={busy || refreshing || contextDirty && !onRefreshContext}
        onClick={contextDirty || context && !briefMatches ? refreshContext : reload}>{refreshing ? 'Actualizando el borrador…' : contextDirty ? 'Guardar borrador y volver a revisar' : 'Volver a revisar los datos'}</button>}
      {adjusting && onPreserveBase && <button type="button" className="button subtle" disabled={busy || refreshing} onClick={() => onPreserveBase(baseAsset)}>Conservar original</button>}
    </div>
    {briefMatches && !contextDirty && <BriefDetails key={briefKey} context={context} baseName={baseAsset?.name} onPreviewError={reportPreviewFailure} />}
    <fieldset className={styles.connectionFieldset} disabled={busy || refreshing}>
      <legend>Indicaciones de la pieza</legend>
      <label className="field">Indicaciones para esta imagen{!promptRequired && ' (opcionales)'}
        <textarea rows={4} maxLength={4000} aria-required={promptRequired} value={prompt}
          onChange={event => changed(onInstructionsChange || setLocalPrompt, event.target.value)}
          placeholder={adjusting ? 'Aclara el fondo, conserva la etiqueta y la condición del obsequio.' : 'Por ejemplo: fondo azul, con espacio alrededor del producto.'} />
      </label>
      {adjusting && <p className={styles.help}>¿Qué quieres cambiar? Describe el estilo o el encuadre, sin cambiar etiquetas, precio, obsequios ni condiciones.</p>}
      {!adjusting && <details className={styles.technicalDetails}><summary>Opciones de formato</summary>
        <label className="field">Formato<select value={format} onChange={event => changed(setFormat, event.target.value)}><option value="png">Imagen PNG cuadrada</option><option value="gif">GIF animado vertical</option></select></label>
        {format === 'gif' && <div className={styles.fieldGrid}>
          <label className="field">Fotogramas (2–16)<input type="number" min={2} max={16} value={frameCount} onChange={event => changed(setFrameCount, event.target.value)} /></label>
          <label className="field">Milisegundos por fotograma (20–2000, múltiplos de 10)<input type="number" min={20} max={2000} step={10} value={frameDurationMs} onChange={event => changed(setFrameDurationMs, event.target.value)} /></label>
          <p className={styles.help}>Duración: {(gifMs / 1000).toFixed(2)} segundos. Debe estar entre 3 y 32 segundos. Se conserva el GIF y se prepara un MP4 vertical sin recorte para revisar.</p>
        </div>}
      </details>}
      {!contextual && <div className={styles.stack}>
        <h4>Referencias opcionales: biblioteca y productos</h4>
        <p className={styles.help}>Puedes trabajar sin fotos. Elige hasta {sourceLimit} referencias {adjusting ? 'además de la imagen a modificar' : 'locales'}; no se descargan enlaces externos.</p>
        <label className="field">Buscar fuentes<input value={query} maxLength={100} onChange={event => { setQuery(event.target.value); setOffset(0); }} /></label>
        {!sourceRead && <p role="status">Buscando fotos de referencia…</p>}
        {sourceRead?.error && <div role="alert" className={styles.error}><p>{sourceRead.error}</p><button type="button" className="button subtle" onClick={() => setSourceRevisionLocal(value => value + 1)}>Reintentar búsqueda</button></div>}
        {(sourceLimitError || usableSources.length > sourceLimit) && <p role="alert">{sourceLimitError || `Retira referencias hasta conservar un máximo de ${sourceLimit}.`}</p>}
        {staleSource && <p role="alert" className={styles.warning}>Una referencia cambió. Elige su versión actual o retírala antes de autorizar.</p>}
        {usableSources.length > 0 && <ul className={styles.choiceList} aria-label="Fuentes seleccionadas">{usableSources.map(source => <li key={sourceId(source)} className={styles.assetPreview}>
          <span>{sourceTitle(source)}</span><img src={source.thumbnailUrl} alt="" width={72} height={72} className={styles.previewImage} />
          <div><button type="button" className="button subtle" onClick={() => toggle(source)} aria-label={`Quitar ${sourceTitle(source)}`}>Quitar</button></div>
        </li>)}</ul>}
        <div className={styles.summaryGrid}>{sources.filter(source => source.kind !== 'asset' || source.id !== baseId).map(source => <label className={styles.checkRow} key={sourceId(source)}>
          <input type="checkbox" checked={usableSources.some(item => sourceId(item) === sourceId(source) && item.version === source.version)} onChange={() => toggle(source)} />
          <img src={source.thumbnailUrl} alt="" width={72} height={72} className={styles.previewImage} />
          <span>{sourceTitle(source)}</span>
        </label>)}</div>
        {sourceRead?.data && sources.length === 0 && <p>No hay fotos locales listas para esta búsqueda.</p>}
        <div className={styles.actions}><button type="button" className="button subtle" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Fuentes anteriores</button>
          <button type="button" className="button subtle" disabled={!sourceRead?.data?.hasMore} onClick={() => setOffset(sourceRead.data.nextOffset)}>Más fuentes</button></div>
      </div>}
      <label className={styles.checkRow}><input type="checkbox" disabled={!canConsent} checked={checked} onChange={event => setConsent(event.target.checked ? payloadKey : null)} />
        <span>Autorizo el envío a <strong>OpenAI</strong> de las indicaciones, datos y fotos que se muestran y un posible cargo variable sin tope garantizado. Confirmo que no contienen datos de clientes ni información personal. Revisaré producto, texto, afirmaciones y derechos antes de publicar. Nada se publica automáticamente.</span>
      </label>
      <div className={styles.actions}><button type="button" className="button primary" disabled={!checked || busy} onClick={submit}>{busy ? 'Registrando solicitud…' : adjusting ? 'Solicitar ajuste con posible cargo' : 'Solicitar imagen con posible cargo'}</button></div>
    </fieldset>
    {requestNotice && <p role="status" className={styles.notice}>{requestNotice}</p>}
    {error && <p role="alert" className={styles.error} tabIndex={-1} ref={errorRef}>{error}</p>}
    <h4>Solicitudes recientes</h4>
    <div className={styles.actions}><button type="button" className="button subtle" disabled={busy} onClick={() => setListRevision(value => value + 1)}>Actualizar progreso</button></div>
    <div className={styles.stack} aria-live="polite">
      {visibleJobs && visibleJobs.length === 0 && <p>No hay solicitudes para mostrar.</p>}
      {visibleJobs?.map(job => <Job key={job.id} job={job} contextual={contextual} alignment={alignment} adjusting={adjusting} compact={compact} onOriginalError={reportPreviewFailure}
        original={adjusting && briefMatches && !previewFailed ? context.baseAsset : null} onUseAsset={onUseAsset} busy={busy || refreshing} />)}
    </div>
  </section></div>;
}
