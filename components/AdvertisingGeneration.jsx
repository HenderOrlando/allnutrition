'use client';

import { useEffect, useId, useRef, useState } from 'react';
import AdvertisingAssetUpload from './AdvertisingAssetUpload';
import styles from './AdvertisingWorkspace.module.css';
import studio from './AdvertisingGeneration.module.css';
import useDialog from './useDialog';

const ROOT = '/api/admin/social/generation';
const THREADS = '/api/admin/social/creative-threads';
const EXAMPLES = ['Muestra el producto sobre un fondo claro con espacio para el texto.', 'Crea un fondo sencillo con los colores de la marca.', 'Aclara el fondo y conserva la etiqueta.'];
const PAGE_SIZE = 12;
const OBJECTIVES = { reach: 'Llegar a más personas', engagement: 'Invitar a interactuar', traffic: 'Llevar visitas al sitio web', whatsapp: 'Conseguir consultas por WhatsApp' };
const BUSINESS_OBJECTIVES = { sales: 'Ventas', traffic: 'Visitas', leads: 'Contactos', whatsapp: 'Consultas por WhatsApp', reach: 'Alcance', engagement: 'Interacciones', awareness: 'Reconocimiento' };
const PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram' };
const PLACEMENTS = { facebook_feed: 'Facebook Feed', facebook_reels: 'Facebook Reels', instagram_feed: 'Instagram Feed', instagram_reels: 'Instagram Reels' };
const CONSENT = { version: 2, cost: true, externalProcessing: true, noCustomerData: true, humanReview: true };
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const isPending = job => ['queued', 'sending'].includes(job.state) || job.asset?.state === 'processing';
const sourceId = source => `${source.kind}:${source.id}`;
const isAdditionalSource = (source, baseId) => source.kind !== 'asset' || source.id !== baseId;
const sourceTitle = source => `${source.kind === 'product' ? 'Producto' : 'Biblioteca'}: ${identity({ ...source.facts, title: source.title })}`;
const pendingAsset = asset => ['uploading', 'processing'].includes(asset?.state);
const editable = asset => asset?.kind === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType) && (asset.state === 'ready' || asset.diagnostic?.code === 'IMAGE_GEOMETRY');
const BASE_LABEL = 'Imagen a modificar';
const identity = item => [item.title, item.presentation, item.flavor].filter(Boolean).join(' · ');
const jobStatus = job => job.state === 'uncertain' ? 'Envío incierto' : job.state === 'queued' ? 'En cola' : job.state === 'sending' || pendingAsset(job.asset) ? 'Preparando archivo' : job.asset?.state === 'ready' ? 'Lista' : 'Falló';
const mergeTurns = (previous, incoming) => [...new Map([...previous, ...incoming].map(turn => [turn.id, turn])).values()]
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

function OfferFacts({ item, label }) {
  if (!item) return null;
  return <div>
    <h6>{label}: {identity(item)}</h6>
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
  return <section className={studio.contextCard} aria-label="Datos de marca y campaña">
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
        <strong>{BASE_LABEL}{baseName ? `: ${baseName}` : ''} · Versión {baseAsset.version}</strong>
        <img className={styles.previewImage} src={baseAsset.previewUrl} alt={BASE_LABEL} onError={onPreviewError} />
        {baseAsset.state !== 'ready' && <p className={styles.warning}>Solo se puede conservar como referencia: el original no está listo para publicar.</p>}
      </div>}
      {automaticSources.map(source => <div className={styles.assetPreview} key={source.thumbnailUrl}>
        <img className={styles.previewImage} src={source.thumbnailUrl} alt="" onError={onPreviewError} width={96} height={96} />
        <span>{source.labels.join(' · ')}</span>
      </div>)}
    </div>}
    {campaign && !automaticSources.some(source => source.labels.some(label => label.startsWith('Oferta principal:'))) && offer && <p className={styles.help}>Si falta una foto de una referencia, se usará texto sin simular su envase.</p>}
  </section>;
}

function StudioPreview({ asset, original, onUse, onFresh, disabled, publishable }) {
  const [comparison, setComparison] = useState(false), [expanded, setExpanded] = useState(false);
  const [reviewed, setReviewed] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  if (!asset) return <div className={studio.previewEmpty}>
    <strong>Aún no hay una pieza</strong>
    <p className={styles.help}>Aquí podrás revisar la imagen o el video antes de usarlo.</p>
  </div>;
  const originalAsset = comparison ? original || asset : null;
  const url = originalAsset?.originalUrl ?? asset.previewUrl ?? (editable(asset) ? asset.originalUrl : null);
  const image = originalAsset ? originalAsset.kind === 'image' || originalAsset.contentType === 'image/gif' : asset.kind === 'image';
  const alt = comparison || asset.state !== 'ready' ? 'Archivo original' : 'Archivo preparado para publicar';
  const mediaProps = { src: url, onError: () => setError(true) };
  function observed() { if (!comparison && asset.state === 'ready') setReviewed(true); setError(false); }
  return <div className={styles.stack}>
    <strong>{asset.name}</strong>
    {url && <figure className={expanded ? studio.previewExpanded : studio.previewMedia}>
      {image ? <img key={`${url}:${retry}`} className={styles.previewImage} {...mediaProps} alt={alt} onLoad={observed}/>
        : <video key={`${url}:${retry}`} className={styles.previewVideo} {...mediaProps} controls playsInline preload="metadata" aria-label={alt} onLoadedMetadata={observed}/>}
      <figcaption className={styles.help}>{alt}</figcaption>
    </figure>}
    {pendingAsset(asset) && <p role="status">Preparando archivo; todavía no está listo para usar.</p>}
    {asset.state === 'failed' && <p className={styles.warning}>{editable(asset) ? 'Solo para ajustar: esta foto no se puede publicar tal cual.' : 'Falló la preparación del archivo.'} {asset.diagnostic?.message}</p>}
    {asset.state === 'ready' && !publishable && <p className={styles.warning}>Esta pieza no corresponde a la oferta, objetivo o vía actual; elige otro archivo o ajústala con los datos vigentes.</p>}
    {asset.aiDisclosure && <p className={styles.help}>Generada con IA. Revisa producto, texto, derechos y divulgación antes de publicar.</p>}
    {error && <div role="alert">No se pudo comprobar el archivo. <button type="button" className="button subtle" onClick={() => setRetry(value => value + 1)}>Volver a comprobar</button></div>}
    <div className={styles.actions}>
      {url && <button type="button" className={`button subtle ${studio.expandPreview}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Reducir vista previa' : 'Ampliar vista previa'}</button>}
      {asset.state === 'ready' && (original?.originalUrl || asset.originalUrl) && <button type="button" className="button subtle" aria-pressed={comparison} onClick={() => setComparison(value => !value)}>{comparison ? 'Volver al archivo preparado' : 'Comparar con el original'}</button>}
      {asset.state === 'ready' && onUse && <button type="button" className="button primary" data-advisor-control="ad-studio-use-asset" disabled={disabled || comparison || !reviewed || error || !publishable} onClick={() => onUse(asset)}>Usar esta pieza y continuar</button>}
      {onFresh && <button type="button" className="button subtle" disabled={disabled} onClick={onFresh}>Crear otra pieza sin usar este archivo</button>}
    </div>
  </div>;
}

function ReferenceDialog({ api, baseId, items, id, limit, onApply, onClose }) {
  const dialogRef = useRef(null), dialogHeading = useRef(null), close = useDialog(dialogRef, { onClose });
  const [draft, setDraft] = useState(items);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [page, setPage] = useState(null);
  const visible = draft.filter(item => isAdditionalSource(item, baseId));
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    const timer = setTimeout(() => {
      api(`${ROOT}/sources?${new URLSearchParams({ query, offset: String(offset), limit: String(PAGE_SIZE) })}`, { signal }).then(data => {
        if (!signal.aborted) setPage({ data });
      }, cause => { if (!signal.aborted) setPage({ error: cause.message }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, query, offset]);
  const results = page?.data?.sources.filter(item => isAdditionalSource(item, baseId));
  function navigate(nextQuery, nextOffset) {
    setPage(null); setQuery(nextQuery); setOffset(nextOffset);
  }
  return <dialog id={id} ref={dialogRef} className={studio.referenceDialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
    <header className={studio.dialogHeader}>
      <h3 ref={dialogHeading} id={`${id}-title`} tabIndex={-1} data-dialog-initial-focus>Referencias opcionales: biblioteca y productos</h3>
      <p id={`${id}-description`} className={styles.help}>Elige hasta {limit} fotos locales adicionales. Se añaden al aplicar; no se descargan enlaces externos.</p>
    </header>
    <div className={studio.dialogBody}>
      <label className="field">Buscar fotos de referencia<input data-advisor-control="ad-studio-search-references" type="search" value={query} maxLength={100} onChange={event => navigate(event.target.value, 0)}/></label>
      {visible.length > 0 && <ul role="list" className={studio.referenceSelection} aria-label="Selección provisional">{visible.map(item => <li key={sourceId(item)}>
        <span>{sourceTitle(item)} · Versión {item.version}</span>
        <button type="button" className="button subtle" aria-label={`Quitar ${sourceTitle(item)}`} onClick={() => {
          dialogHeading.current?.focus({ preventScroll: true });
          setDraft(draft.filter(value => value !== item));
        }}>Quitar</button>
      </li>)}</ul>}
      {!page && <p role="status">Buscando fotos de referencia…</p>}
      {page?.error && <p role="alert">{page.error}</p>}
      {results?.length === 0 && <p role="status">No hay fotos de referencia en esta página.</p>}
      {results?.length > 0 && <ul role="list" className={studio.referenceResults} aria-label="Fotos de referencia disponibles">{results.map(item => {
        const picked = visible.find(value => sourceId(value) === sourceId(item)), sameVersion = picked?.version === item.version;
        return <li key={sourceId(item)}><label className={studio.referenceOption}>
          <input type="checkbox" checked={sameVersion} disabled={!picked && visible.length >= limit}
            onChange={() => setDraft(sameVersion ? draft.filter(value => value !== picked) : [...draft.filter(value => value !== picked), item])}/>
          <img src={item.thumbnailUrl} alt="" width={56} height={56} className={studio.thumbnail}/><span>{sourceTitle(item)} · Versión {item.version}</span>
        </label></li>;
      })}</ul>}
      <div className={styles.actions}>
        <button type="button" className="button subtle" disabled={!offset} onClick={() => navigate(query, Math.max(0, offset - PAGE_SIZE))}>Fuentes anteriores</button>
        <button type="button" className="button subtle" disabled={!page?.data?.hasMore} onClick={() => navigate(query, page.data.nextOffset)}>Más fuentes</button>
      </div>
    </div>
    <footer className={studio.dialogFooter}>
      <p role="status" className={styles.help}>{visible.length} de {limit} fotos seleccionadas.</p>
      <div className={studio.dialogActions}>
        <button type="button" className="button subtle" onClick={close}>Cancelar</button>
        <button type="button" className="button primary" data-advisor-control="ad-studio-choose-references" disabled={visible.length > limit} onClick={() => onApply(draft)}>Aplicar referencias</button>
      </div>
    </footer>
  </dialog>;
}

function ReferencePicker({ api, baseId, items, limit, onChange, catalogFocus }) {
  const [open, setOpen] = useState(false), trigger = useRef(null), id = useId();
  const visible = items.filter(item => isAdditionalSource(item, baseId));
  useEffect(() => {
    if (!catalogFocus || open) return;
    const frame = requestAnimationFrame(() => {
      trigger.current?.focus({ preventScroll: true });
      setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [catalogFocus, open]);
  function apply(draft) {
    const unchanged = draft.length === items.length && draft.every(item => items.some(value => sourceId(value) === sourceId(item) && value.version === item.version));
    if (!unchanged) onChange(draft);
    setOpen(false);
  }
  return <div className={studio.references}>
    <div className={studio.referenceAccess}>
      <button ref={trigger} type="button" className="button subtle" aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-expanded={open} onClick={event => {
        event.currentTarget.focus({ preventScroll: true }); setOpen(true);
      }}>Referencias opcionales: biblioteca y productos</button>
      <p className={styles.help}>{visible.length ? `${visible.length} de ${limit} fotos añadidas de la biblioteca o de Productos` : 'Sin fotos elegidas de la biblioteca o de Productos'}</p>
    </div>
    {visible.length > 0 && <ul role="list" className={studio.appliedReferences} aria-label="Fotos seleccionadas para el envío">{visible.map(item => <li key={sourceId(item)}>
      <img src={item.thumbnailUrl} alt="" width={48} height={48} className={studio.thumbnail}/><span>{sourceTitle(item)} · Versión {item.version}</span>
    </li>)}</ul>}
    {open && <ReferenceDialog api={api} baseId={baseId} items={items} id={id} limit={limit} onApply={apply} onClose={() => setOpen(false)}/>}
  </div>;
}

function CreativeContextDialog({ id, busy, dirty, onClose, children }) {
  const dialog = useRef(null);
  const close = useDialog(dialog, { busy, dirty, onClose });
  return <dialog ref={dialog} id={id} className={`${studio.referenceDialog} ${studio.contextDialog}`} aria-labelledby={`${id}-title`}>
    <header className={studio.dialogHeader}>
      <p className={studio.directoryLabel}>Mesa de trabajo de Ali</p>
      <h3 id={`${id}-title`} tabIndex={-1} data-dialog-initial-focus data-advisor-control="ad-studio-review-inputs">Datos y fotos para preparar imagen</h3>
      <p className={styles.help}>Revisa el material del próximo turno. Abrir este panel no envía nada a OpenAI.</p>
    </header>
    <div className={studio.dialogBody}>{children}</div>
    <footer className={studio.dialogFooter}>
      <div className={studio.dialogActions}><button type="button" className="button primary" disabled={busy} onClick={close}>Volver al chat</button></div>
    </footer>
  </dialog>;
}

function AliMessage({ children }) {
  return <div className={studio.aliMessage}>
    <span className={studio.avatar} aria-hidden="true">A</span>
    <div className={studio.turnStatus}><strong>Ali</strong>{children}</div>
  </div>;
}

function turnReply(turn) {
  if (turn.asset?.state === 'ready') return 'Ya tengo una versión para ti. Revísala y dime qué quieres cambiar.';
  if (turn.state === 'queued') return 'Recibí tu mensaje. Prepararé la pieza en cuanto le toque a este turno.';
  if (isPending(turn)) return 'Estoy preparando tu pieza. Cuando esté lista, podrás verla aquí.';
  if (turn.state === 'uncertain') return 'No pude confirmar si se completó el envío. Revisa este turno antes de volver a intentarlo.';
  return 'No pude preparar la pieza en este turno. Puedes revisar lo que pasó y escribir otro ajuste.';
}

export default function AdvertisingGeneration({ api, campaignId = null, campaignVersion = null, threadId = null, baseAsset = null, assets = [],
  onThreadCreated, onUseAsset, onOpenCampaign, onRefreshContext, onSkip, onExit, contextDirty = false, onInteractionStateChange, onMutation,
  active = true, instructions, onInstructionsChange, allowGeneration = true, allowPublishAsset, advisorStudioEntry = false, catalogRequest }) {
  const skipInitialHeading = useRef(advisorStudioEntry || Boolean(catalogRequest));
  const [localPrompt, setLocalPrompt] = useState(''), prompt = instructions ?? localPrompt;
  const [format, setFormat] = useState('png'), [frames, setFrames] = useState(9), [duration, setDuration] = useState(400);
  const [thread, setThread] = useState(null), [turns, setTurns] = useState([]), [cursor, setCursor] = useState(null);
  const [focused, setFocused] = useState(null), [choice, setChoice] = useState(null), [uploadState, setUploadState] = useState(null);
  const [contextOpen, setContextOpen] = useState(null), [referenceSelection, setReferenceSelection] = useState({});
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(Boolean(threadId || campaignId)), [olderBusy, setOlderBusy] = useState(false);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0), [briefRefresh, setBriefRefresh] = useState(0), [review, setReview] = useState(null), [availability, setAvailability] = useState(null);
  const [consent, setConsent] = useState(null), [failedPreview, setFailedPreview] = useState(null), [sources, setSources] = useState([]);
  const request = useRef(null), writer = useRef(false), creation = useRef(null), creationId = useRef(null), currentThread = useRef(null), olderLoaded = useRef(false);
  const mounted = useRef(false), callbacks = useRef(null), errorRef = useRef(null), composerRef = useRef(null), studioRef = useRef(null), headingRef = useRef(null), previewHeading = useRef(null), id = useId();
  const transcriptRef = useRef(null), chatHeadingRef = useRef(null);
  const contextTrigger = useRef(null);
  callbacks.current = { onThreadCreated, onInteractionStateChange };
  const activeThreadId = threadId || thread?.id;
  const linked = thread?.campaignId && thread.campaignId !== campaignId ? thread.campaignId : null;
  const variants = new Map();
  for (const asset of [baseAsset, ...(thread?.attachments || []), ...turns.toReversed().map(turn => turn.asset), thread?.selectedAsset]) {
    if (asset && (!variants.has(asset.id) || variants.get(asset.id).version <= asset.version)) variants.set(asset.id, asset);
  }
  const focusedAsset = focused === false ? null : variants.get(focused || thread?.selectedAsset?.id || baseAsset?.id || [...variants.keys()].findLast(key => !Object.hasOwn(referenceSelection, key))) ?? null;
  const base = editable(focusedAsset) ? focusedAsset : null, baseId = base?.id ?? null;
  const original = variants.get(turns.find(turn => turn.asset?.id === focusedAsset?.id)?.baseAssetId);
  const hasProgress = Boolean(turns.length || thread?.attachments?.length);
  const latestTurn = turns[0];
  const scopeReady = !loading && !readError && !linked;
  const catalogFocus = catalogRequest?.focus;
  const catalogReferences = !campaignId && ['ad-studio-search-references', 'ad-studio-choose-references'].includes(catalogFocus) ? catalogRequest.id : null;
  const briefKey = JSON.stringify([campaignId, campaignVersion, baseId, base?.version, briefRefresh]);
  const context = review?.key === briefKey ? review.data : null;
  const briefMatches = context?.campaignId === campaignId && context?.campaignVersion === campaignVersion &&
    (context.baseAsset?.id ?? null) === baseId && (!base || context.baseAsset.version === base.version && (base.state !== 'ready' || context.baseAsset.sha256 === base.sha256));
  const referenceLimit = base ? 3 : 4;
  const attachedPhotos = Object.keys(referenceSelection).filter(key => key !== baseId).map(key => variants.get(key)).filter(Boolean);
  const uploadedReferences = attachedPhotos.filter(asset => referenceSelection[asset.id]);
  const pickedSources = sources.filter(source => isAdditionalSource(source, baseId) && !(source.kind === 'asset' && referenceSelection[source.id]));
  const selectedSources = [...pickedSources, ...uploadedReferences.map(asset => ({ kind: 'asset', id: asset.id, version: asset.version }))];
  const referencesReady = uploadedReferences.every(asset => asset.state === 'ready');
  const requestedFormat = base ? 'png' : format, gifMs = frames * duration;
  const validFormat = requestedFormat !== 'gif' || (Number.isInteger(Number(frames)) && frames >= 2 && frames <= 16 && duration >= 20 && duration <= 2000 && duration % 10 === 0 && gifMs >= 3000 && gifMs <= 32000);
  const canConsent = scopeReady && allowGeneration && availability?.available && !contextDirty && briefMatches && failedPreview !== briefKey && (!focusedAsset || base) &&
    prompt.trim() && validFormat && referencesReady && selectedSources.length <= referenceLimit;
  const payload = canConsent ? {
    campaignId, campaignVersion, briefHash: context.briefHash, baseAsset: base ? { id: baseId, version: base.version, sha256: context.baseAsset.sha256 } : null,
    configurationVersion: availability.configurationVersion, prompt, format: requestedFormat,
    ...(requestedFormat === 'gif' ? { frameCount: Number(frames), frameDurationMs: Number(duration) } : {}),
    sources: campaignId ? [] : selectedSources.map(({ kind, id, version }) => ({ kind, id, version })), consent: CONSENT,
  } : null;
  const payloadKey = payload ? JSON.stringify([thread?.version ?? 1, payload]) : null, checked = Boolean(payloadKey && consent === payloadKey);
  const dirty = Boolean(prompt || sources.length || checked || uploadState?.dirty), locked = busy || Boolean(uploadState?.busy);
  function remember(next) {
    if (currentThread.current?.id === next.id && currentThread.current.version > next.version) return;
    currentThread.current = next; setThread(next);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); };
  }, []);
  useEffect(() => {
    callbacks.current.onInteractionStateChange?.(active ? { dirty, busy: locked } : { dirty: false, busy: false });
  }, [active, dirty, locked]);
  useEffect(() => { if (active && error) errorRef.current?.focus(); }, [active, error]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (active && transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [active, latestTurn?.id]);
  useEffect(() => {
    if (!active) return;
    if (skipInitialHeading.current) {
      skipInitialHeading.current = false;
      return;
    }
    // Let the enclosing workspace finish the route's focus handoff first.
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      headingRef.current?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!active || !allowGeneration || !scopeReady || locked || !(catalogReferences || catalogFocus === 'ad-studio-review-inputs')) return;
    contextTrigger.current?.focus({ preventScroll: true });
    setContextOpen(mode => mode || 'review');
  }, [active, allowGeneration, catalogFocus, catalogReferences, locked, scopeReady]);
  useEffect(() => {
    if (!active || !window.visualViewport) return;
    const viewport = window.visualViewport, studio = studioRef.current;
    const update = () => {
      const inset = viewport.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      studio?.style.setProperty('--studio-keyboard', `${Math.round(inset)}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, [active]);
  useEffect(() => {
    if (!active || !allowGeneration) return;
    const controller = new AbortController(), { signal } = controller;
    api(`${ROOT}?availabilityOnly=1`, { signal }).then(value => { if (!signal.aborted) setAvailability(value); },
      cause => { if (!signal.aborted) setAvailability({ reason: `No se pudo comprobar el servicio de imágenes. ${cause.message}` }); });
    return () => controller.abort();
  }, [active, allowGeneration, api, briefRefresh]);
  useEffect(() => {
    if (!active || !activeThreadId && !campaignId) return;
    const controller = new AbortController(), { signal } = controller;
    let timer, target = activeThreadId;
    if (target && currentThread.current && currentThread.current.id !== target) {
      currentThread.current = null; olderLoaded.current = false; setThread(null); setTurns([]); setCursor(null); setFocused(null);
      setReferenceSelection({}); setSources([]); setConsent(null); setContextOpen(null); request.current = null;
    }
    setLoading(!currentThread.current);
    async function read() {
      if (document.hidden) { timer = setTimeout(read, 3500); return; }
      try {
        if (!target) target = (await api(`${THREADS}?${new URLSearchParams({ campaignId })}`, { signal })).threads[0]?.id;
        if (!target || signal.aborted) return;
        const data = await api(`${THREADS}/${target}`, { signal });
        if (signal.aborted) return;
        remember(data.thread); setTurns(previous => mergeTurns(previous, data.turns));
        if (!olderLoaded.current) setCursor(data.nextCursor);
        if (data.turns.some(isPending) || data.thread.attachments.some(pendingAsset)) timer = setTimeout(read, 3500);
        setReadError('');
      } catch (cause) { if (!signal.aborted) setReadError(cause.message); }
      finally { if (!signal.aborted) setLoading(false); }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, api, activeThreadId, campaignId, refresh]);
  useEffect(() => {
    if (!active || !allowGeneration || contextDirty || !scopeReady || focusedAsset && !baseId || !campaignId && !availability?.available) return;
    const controller = new AbortController(), params = new URLSearchParams();
    if (campaignId) params.set('campaignId', campaignId);
    if (baseId) params.set('baseAssetId', baseId);
    api(`${ROOT}/brief${params.size ? `?${params}` : ''}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setReview({ key: briefKey, data });
    }, cause => { if (!controller.signal.aborted) setReview({ key: briefKey, error: cause.message }); });
    return () => controller.abort();
  }, [active, allowGeneration, availability?.available, api, briefKey, campaignId, baseId, focusedAsset?.id, scopeReady, contextDirty]);

  function change(setter, value) { setter(value); setConsent(null); request.current = null; }
  function setPrompt(value) { change(onInstructionsChange || setLocalPrompt, value); }
  function inspect(assetId, focusPreview = false) {
    change(setFocused, assetId); setNotice('');
    if (focusPreview) previewHeading.current?.focus();
  }
  async function ensureThread() {
    if (currentThread.current) return currentThread.current;
    if (activeThreadId) throw new Error('Vuelve a cargar la pieza en curso antes de continuar.');
    if (!creation.current) {
      creationId.current ??= crypto.randomUUID();
      creation.current = api(THREADS, { method: 'POST', body: JSON.stringify({ requestId: creationId.current, campaignId }) })
        .then(value => {
          if (mounted.current) { remember(value); callbacks.current.onThreadCreated?.(value); }
          return value;
        }).finally(() => { creation.current = null; });
    }
    return creation.current;
  }
  async function task(fn) {
    if (writer.current) return null;
    writer.current = true; setBusy(true); setError('');
    try { return await fn(); }
    catch (cause) {
      if (mounted.current) {
        if (cause.status === 409) { setRefresh(value => value + 1); refreshBrief(); }
        setError(cause.message);
      }
      return null;
    } finally { writer.current = false; if (mounted.current) setBusy(false); }
  }
  async function updateAttachment(action, asset, focus = true) {
    const current = await ensureThread();
    const result = await api(`${THREADS}/${current.id}`, { method: 'PATCH', body: JSON.stringify({ action, version: current.version, assetId: asset.id, assetVersion: asset.version }) });
    if (mounted.current) {
      remember(result);
      if (focus) inspect(asset.id);
      setRefresh(value => value + 1);
    }
    return result;
  }
  async function attach(action, asset) {
    const next = await task(() => updateAttachment(action, asset));
    if (next && mounted.current) {
      if (action === 'select' && next.selectedAsset) onUseAsset?.(next.selectedAsset, next);
      else if (action === 'attach') previewHeading.current?.focus();
    }
  }
  async function reserveAttachment(asset, reference = false) {
    try {
      if (!currentThread.current?.attachments.some(entry => entry.id === asset.id)) await updateAttachment('attach', asset, !reference);
      if (reference && mounted.current) {
        setReferenceSelection(selection => selection[asset.id] ? selection : { ...selection, [asset.id]: true });
        setConsent(null); request.current = null;
      }
    } catch (cause) { if (cause.status === 409) setRefresh(value => value + 1); throw cause; }
  }
  async function submit() {
    if (!checked || !payload) return;
    await task(async () => {
      const current = await ensureThread();
      if (current.version !== (thread?.version ?? 1)) { setConsent(null); throw new Error('La pieza en curso cambió. Revisa y vuelve a autorizar.'); }
      if (request.current?.key !== payloadKey) request.current = { key: payloadKey, id: crypto.randomUUID() };
      const job = await api(ROOT, { method: 'POST', body: JSON.stringify({ ...payload, requestId: request.current.id, threadId: current.id, threadVersion: current.version }) });
      if (!mounted.current) return;
      setTurns(previous => mergeTurns(previous, [{ ...job, prompt: prompt.trim() }])); setPrompt(''); setSources([]); setFocused(null);
      setNotice('Turno registrado. Nada se ha publicado.'); setRefresh(value => value + 1);
    });
  }
  async function readOlder() {
    if (!cursor || olderBusy || !activeThreadId) return;
    setOlderBusy(true); setError('');
    try {
      const data = await api(`${THREADS}/${activeThreadId}?${new URLSearchParams({ cursor })}`);
      if (mounted.current) { olderLoaded.current = true; setTurns(previous => mergeTurns(data.turns, previous)); setCursor(data.nextCursor); }
    } catch (cause) { if (mounted.current) setError(cause.message); }
    finally { if (mounted.current) setOlderBusy(false); }
  }
  function refreshBrief() { setConsent(null); setBriefRefresh(value => value + 1); }
  const refreshAll = () => { setRefresh(value => value + 1); refreshBrief(); };
  const library = assets.filter(asset => asset.state === 'ready' || editable(asset));
  const pieceVariants = [...variants.values()].filter(asset => asset.id === baseId || !Object.hasOwn(referenceSelection, asset.id));
  const brief = briefMatches && !contextDirty && <BriefDetails key={briefKey} context={context} baseName={base?.name} onPreviewError={() => setFailedPreview(briefKey)}/>;
  const updateUpload = () => setRefresh(value => value + 1);
  function completeContextUpload() {
    document.getElementById(`${id}-context-title`)?.focus({ preventScroll: true });
    updateUpload(); setContextOpen('review');
  }
  const canAttachPhoto = !locked && scopeReady && choice !== 'upload' && (Boolean(campaignId) || selectedSources.length < referenceLimit);
  function openContext(event, mode) {
    event.currentTarget.focus({ preventScroll: true });
    setContextOpen(mode);
  }
  return <section ref={studioRef} className={studio.root} hidden={!active} aria-label="Estudio visual" aria-busy={loading}>
    {active && contextOpen && <CreativeContextDialog id={`${id}-context`} busy={locked} dirty={Boolean(uploadState?.dirty)} onClose={() => setContextOpen(null)}>
      <p className={availability?.available ? styles.help : styles.warning}>
        {availability?.available ? 'Servicio de imágenes de OpenAI disponible.' : availability?.reason || 'Comprobando disponibilidad de imágenes…'}
      </p>
      <section className={studio.contextCard} aria-label="Fotos para este turno">
        <div className={studio.contextTitle}><h4>Fotos para este turno</h4>{!campaignId && <span>{selectedSources.length} {selectedSources.length === 1 ? 'adicional' : 'adicionales'}</span>}</div>
        {!campaignId && attachedPhotos.length > 0 && <ul role="list" className={studio.appliedReferences} aria-label="Fotos adjuntas en el chat">{attachedPhotos.map(asset => <li key={asset.id} className={studio.uploadedReference}>
          {asset.previewUrl && <img className={studio.thumbnail} src={asset.previewUrl} alt="" width={56} height={56} />}
          <div><strong>{asset.name} · Versión {asset.version}</strong><p>{!referenceSelection[asset.id] ? 'No se enviará' : asset.state === 'ready' ? 'Referencia para el próximo envío' : pendingAsset(asset) ? 'Preparando referencia…' : 'No se puede enviar. Quita esta foto o adjunta otra.'}</p></div>
          <button type="button" className="button subtle" aria-label={`${referenceSelection[asset.id] ? 'Quitar' : 'Incluir'} ${asset.name}`} disabled={locked || !referenceSelection[asset.id] && (asset.state !== 'ready' || selectedSources.length >= referenceLimit)}
            onClick={() => change(setReferenceSelection, { ...referenceSelection, [asset.id]: !referenceSelection[asset.id] })}>{referenceSelection[asset.id] ? 'Quitar' : 'Incluir'}</button>
        </li>)}</ul>}
        {!campaignId && <ReferencePicker api={api} baseId={baseId} items={pickedSources} limit={Math.max(0, referenceLimit - uploadedReferences.length)} onChange={value => change(setSources, value)} catalogFocus={catalogReferences}/>}
        <p className={styles.help}>{campaignId ? 'En este borrador se incluyen las fotos de la oferta y la imagen a modificar. Una carga nueva cambia la imagen a modificar.' : 'Adjunta una foto para orientar el resultado sin sustituir la imagen a modificar. Solo se envía al autorizar el turno.'}</p>
        {contextOpen === 'upload' ? <AdvertisingAssetUpload api={api} onBeforeUpload={ensureThread} onAssetReserved={asset => reserveAttachment(asset, !campaignId)}
          onAsset={completeContextUpload} onMutation={onMutation} onInteractionStateChange={setUploadState} accept="image/jpeg,image/png,image/webp"
          submitLabel="Adjuntar al turno" disabled={busy || !scopeReady}/>
          : <button type="button" className="button subtle" disabled={!canAttachPhoto} onClick={() => setContextOpen('upload')}>Adjuntar foto</button>}
      </section>
      {brief || <p className={styles.help}>{contextDirty ? 'Guarda el borrador para actualizar los datos de la pieza.' : 'Los datos verificados se mostrarán cuando estén disponibles.'}</p>}
    </CreativeContextDialog>}
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>Preparar la imagen o video</p><h2 ref={headingRef} tabIndex={-1} data-advisor-control="Estudio visual">Estudio visual</h2></div>
      {onExit && <button type="button" className="text-button" disabled={locked} onClick={onExit}>Volver a publicaciones</button>}
    </header>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}
    {readError && <div role="alert" className={styles.error}><p>{readError}</p><button type="button" className="button subtle" data-advisor-control={hasProgress ? 'ad-studio-progress' : undefined} onClick={refreshAll}>Volver a cargar el estudio</button></div>}
    {linked ? <div className={styles.notice}><p>Esta pieza ya tiene un borrador.</p><button type="button" className="button primary" onClick={() => onOpenCampaign?.(linked)}>Continuar borrador</button></div> : <>
      <section className={studio.fileAccess} aria-label="Añadir una pieza">
        <div className={studio.fileBar}>
          <h3>Usar un archivo que ya tienes</h3>
          <div className={studio.fileActions}>
            <button type="button" className="button subtle" data-advisor-control="ad-studio-upload" disabled={locked || !scopeReady} aria-expanded={choice === 'upload'} aria-controls={choice === 'upload' ? `${id}-file-options` : undefined} onClick={() => setChoice(value => value === 'upload' ? null : 'upload')}>Adjuntar foto o video</button>
            <button type="button" className="button subtle" data-advisor-control={choice==='library'?undefined:'ad-studio-choose-library'} disabled={locked || !scopeReady} aria-expanded={choice === 'library'} aria-controls={choice === 'library' ? `${id}-file-options` : undefined} onClick={() => setChoice(value => value === 'library' ? null : 'library')}>Elegir de biblioteca</button>
            {onSkip && <button type="button" className="text-button" data-advisor-control="ad-campaign-skip" disabled={locked || !scopeReady} onClick={onSkip}>Definir primero, sin imagen aún</button>}
          </div>
        </div>
        {choice && <div id={`${id}-file-options`} className={studio.fileOptions}>
          {choice === 'upload' ? <AdvertisingAssetUpload api={api} onBeforeUpload={ensureThread} onAssetReserved={asset => reserveAttachment(asset)} onAsset={updateUpload}
            onMutation={onMutation} onInteractionStateChange={setUploadState} disabled={busy || !scopeReady}/>
            : <label className="field">Archivo de biblioteca<select data-advisor-control="ad-studio-choose-library" value="" disabled={locked || !scopeReady} onChange={event => {
              const asset = library.find(item => item.id === event.target.value);
              if (asset) void attach('attach', asset);
            }}><option value="">Selecciona una imagen o video</option>{library.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.kind === 'video' ? 'Video' : 'Imagen'}{asset.state !== 'ready' ? ' · Solo para ajustar' : ''}</option>)}</select></label>}
          {choice === 'library' && !library.length && <p className={styles.help}>Todavía no hay archivos disponibles. Puedes adjuntar uno aquí{onSkip ? ' o continuar sin imagen' : ''}.</p>}
        </div>}
      </section>
      <div className={studio.columns}>
        <section className={studio.chat} aria-labelledby={`${id}-chat`}>
          <header className={studio.chatTop}>
            <div className={studio.chatIdentity}><span className={studio.avatar} aria-hidden="true">A</span><div>
              <p className={studio.directoryLabel}>Ali · Estudio visual</p>
              <h3 id={`${id}-chat`} ref={chatHeadingRef} tabIndex={-1}>Chat creativo</h3>
            </div></div>
            <p className={styles.help}>Un espacio privado para probar ideas. Nada se publica desde aquí.</p>
          </header>
          <div className={studio.history}>
            {loading && <p role="status">Cargando tu conversación…</p>}
            {!turns.length && !loading && <AliMessage><p>{allowGeneration ? 'Hola, soy Ali. Cuéntame qué tienes en mente para tu pieza. Podemos empezar con una idea o con una foto.' : 'Aquí podrás revisar la conversación y sus piezas.'}</p></AliMessage>}
            {cursor && <button type="button" className="button subtle" disabled={olderBusy} onClick={readOlder}>Cargar turnos anteriores</button>}
            {turns.length > 0 && <ol role="list" ref={transcriptRef} className={studio.turns} tabIndex={0} aria-label="Turnos del chat">{turns.toReversed().map(turn => <li key={turn.id}>
              <div className={studio.userMessage}><strong>Tú</strong><p>{turn.prompt}</p></div>
              <AliMessage><p>{turnReply(turn)}</p>
                {(turn.asset?.diagnostic?.message || turn.notice) && <p className={styles.help}>{turn.asset?.diagnostic?.message || turn.notice}</p>}
                {turn.asset && <button type="button" className="button subtle" disabled={locked} onClick={() => inspect(turn.asset.id, true)}>Ver {turn.asset.state === 'ready' ? 'variante' : 'archivo'} · {turn.asset.name}</button>}
              </AliMessage>
            </li>)}</ol>}
            <span className={styles.visuallyHidden} role="status">{latestTurn ? `Último turno: ${jobStatus(latestTurn)}` : ''}</span>
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            {hasProgress && !readError && <button type="button" className="button subtle" data-advisor-control="ad-studio-progress" onClick={refreshAll}>Actualizar progreso</button>}
          </div>
          {allowGeneration && <section className={studio.composer} aria-label="Compositor">
            <h4 className={studio.directoryLabel}>{base ? 'Siguiente ajuste' : 'Nueva idea'}</h4>
            {!availability && <p role="status">Comprobando disponibilidad de imágenes…</p>}
            {availability && !availability.available && <p className={styles.warning}>{availability.reason}</p>}
            {contextDirty && <p>Hay cambios sin guardar. <button type="button" className="button subtle" disabled={locked} onClick={() => void task(async () => { if (await onRefreshContext?.()) refreshBrief(); })}>Guardar borrador y volver a revisar</button></p>}
            {focusedAsset && !base && <p className={styles.warning}>Este archivo no admite ajustes por indicaciones. Puedes usarlo si está listo o elegir otra foto fija.</p>}
            {!contextDirty && review?.key === briefKey && review.error && <p role="alert">{review.error} <button type="button" className="button subtle" onClick={refreshBrief}>Volver a revisar los datos</button></p>}
            {context && !briefMatches && <p role="alert">Cambió el borrador o el archivo. <button type="button" className="button subtle" onClick={refreshAll}>Volver a revisar</button></p>}
            {failedPreview === briefKey && <p role="alert">No se pudo ver una foto de referencia. <button type="button" className="button subtle" onClick={refreshBrief}>Volver a comprobar</button></p>}
            {availability?.available ? <fieldset disabled={locked || !scopeReady} className={styles.connectionFieldset}>
              <legend className={styles.visuallyHidden}>{base ? 'Indica qué quieres cambiar' : 'Cuéntanos qué quieres ver'}</legend>
              <div className={studio.composerFields}>
                <label htmlFor={`${id}-prompt`} className={studio.promptLabel}>Escríbele a Ali</label>
                <textarea className={studio.prompt} id={`${id}-prompt`} ref={composerRef} data-advisor-control="ad-studio-prepare-creative" rows={3} maxLength={4000} value={prompt} placeholder={base ? '¿Qué quieres ajustar?' : 'Describe cómo imaginas la pieza…'} aria-describedby={`${id}-consent`} onChange={event => setPrompt(event.target.value)}
                  onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && checked) { event.preventDefault(); void submit(); } }}/>
                <div className={studio.examples} role="group" aria-label="Ejemplos de indicaciones">{(base ? EXAMPLES.slice(-1) : EXAMPLES.slice(0, 2)).map(example => <button type="button" className="button subtle" key={example} onClick={() => {
                  setPrompt(example); composerRef.current?.focus();
                }}>{example}</button>)}</div>
                {!base && <details className={styles.technicalDetails}><summary>Opciones de formato</summary>
                  <label className="field">Formato<select value={format} onChange={event => change(setFormat, event.target.value)}><option value="png">Imagen PNG cuadrada</option><option value="gif">GIF animado vertical</option></select></label>
                  {format === 'gif' && <div className={styles.fieldGrid}>
                    <label className="field">Fotogramas (2–16)<input type="number" min={2} max={16} value={frames} onChange={event => change(setFrames, event.target.value)}/></label>
                    <label className="field">Milisegundos por fotograma<input type="number" min={20} max={2000} step={10} value={duration} onChange={event => change(setDuration, event.target.value)}/></label>
                    <p className={styles.help}>Duración: {(gifMs / 1000).toFixed(2)} segundos. Debe estar entre 3 y 32 segundos. Se conserva el GIF y se prepara un MP4 vertical.</p>
                  </div>}
                </details>}
                <div className={studio.contextActions}>
                  <button ref={contextTrigger} type="button" className="button subtle" aria-haspopup="dialog" aria-controls={contextOpen ? `${id}-context` : undefined} onClick={event => openContext(event, 'review')}>Datos y fotos para preparar imagen</button>
                  <button type="button" className="button subtle" aria-haspopup="dialog" disabled={!canAttachPhoto} onClick={event => openContext(event, 'upload')}>Adjuntar foto</button>
                  {selectedSources.length > 0 && <p role="status">{selectedSources.length} {selectedSources.length === 1 ? 'foto adicional' : 'fotos adicionales'}{!referencesReady && ' · Falta preparar una referencia'}</p>}
                </div>
                <label id={`${id}-consent`} className={styles.checkRow}><input type="checkbox" data-advisor-control={base ? 'ad-studio-consent-adjust' : 'ad-studio-consent-new'} disabled={!canConsent} checked={checked} onChange={event => setConsent(event.target.checked ? payloadKey : null)}/>
                  <span>Autorizo el envío a <strong>OpenAI</strong> de mis indicaciones, los datos y las fotos mostradas, con un posible cargo variable sin tope garantizado. No contienen datos de clientes ni información personal. Revisaré el resultado y los derechos. Nada se publica automáticamente.</span>
                </label>
                {!checked && <p className={styles.help}>{!prompt.trim() ? 'Escribe una idea o usa un ejemplo para empezar.' : !validFormat ? 'Corrige la duración y los fotogramas en Opciones de formato.' : canConsent ? 'Revisa lo que se enviará antes de marcar la autorización.' : 'Aún no se puede autorizar. Revisa los datos y los avisos de esta imagen.'}</p>}
                <button type="button" className="button primary" disabled={!checked || locked} onClick={submit}>{busy ? 'Registrando turno…' : base ? 'Enviar ajuste' : 'Enviar idea'}</button>
              </div>
            </fieldset> : <button ref={contextTrigger} type="button" className="button subtle" aria-haspopup="dialog" onClick={event => openContext(event, 'review')}>Datos y fotos para preparar imagen</button>}
          </section>}
        </section>
        <section className={`${studio.preview} ${styles.card} ${styles.stack}`} aria-labelledby={`${id}-preview`}>
          <header><h3 id={`${id}-preview`} ref={previewHeading} tabIndex={-1}>Tu pieza</h3><p className={styles.help}>Vista previa y variantes</p></header>
          {thread?.selectionChanged && <p className={styles.warning}>La pieza seleccionada cambió. Vuelve a revisar la versión actual.</p>}
          <StudioPreview key={`${focusedAsset?.id}:${focusedAsset?.version}`} asset={focusedAsset} original={original} disabled={locked || !scopeReady}
            onUse={onUseAsset && (asset => void attach('select', asset))} publishable={!allowPublishAsset || Boolean(focusedAsset && allowPublishAsset(focusedAsset))}
            onFresh={allowGeneration && focusedAsset ? () => { inspect(false); (composerRef.current || chatHeadingRef.current)?.focus(); } : null}/>
          {pieceVariants.length > 0 && <details className={styles.technicalDetails} open={pieceVariants.length < 4}><summary data-advisor-control="ad-studio-review-assets">Original y variantes ({pieceVariants.length})</summary>
            <ul className={styles.choiceList}>{pieceVariants.map((asset, index) => <li key={asset.id}>
              <button type="button" className="button subtle" aria-pressed={focusedAsset?.id === asset.id} disabled={locked} onClick={() => inspect(asset.id, true)}>
                {index === 0 ? 'Original' : `Variante ${index}`} · {asset.name}{asset.state !== 'ready' && editable(asset) ? ' · Solo para ajustar' : ''}
              </button>
            </li>)}</ul>
          </details>}
        </section>
      </div>
    </>}
  </section>;
}
