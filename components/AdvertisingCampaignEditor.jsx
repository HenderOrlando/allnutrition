'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import { useAssistantForm } from './AssistantBridge.jsx';
import { socialPlacementMatches, unsupportedSocialDisclosure } from '../lib/social/piece-compatibility.mjs';
import AdvertisingGeneration from './AdvertisingGeneration';
import AdvertisingOfferPicker, { offerLabel, OfferSummary, readAdvertisingOffer } from './AdvertisingOfferPicker';
import { AUDIENCE_SOURCE, AudienceAssistant, MarketPicker, countryLabel } from './AdvertisingMarkets';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const STEPS = ['Definir publicación', 'Revisar y publicar'];
const INSTRUCTIONS = ['Elige el mensaje, las redes y la imagen o video. Puedes guardar aunque falten datos.', 'Resuelve lo pendiente, revisa la pieza y consulta una estimación. Aprobar no publica ni activa gasto.'];
const OBJECTIVES = { whatsapp: 'Consultas por WhatsApp', traffic: 'Clics al sitio web', reach: 'Alcance', engagement: 'Interacción' };
const OBJECTIVE_HELP = { whatsapp: 'Busca consultas por WhatsApp, no ventas confirmadas ni lectura de conversaciones.', traffic: 'Busca clics en el enlace, no visitas confirmadas ni ventas.', reach: 'Busca personas alcanzadas según lo informado por la red; no garantiza ventas.', engagement: 'Busca acciones sobre el contenido, no ventas confirmadas.' };
const CALLS_TO_ACTION = { whatsapp: 'Invita a consultar por WhatsApp', traffic: 'Invita a conocer los detalles en el sitio web', reach: 'Ayuda a que más personas descubran la marca', engagement: 'Invita a comentar sobre un detalle real' };
const NETWORKS = { facebook: 'Página de Facebook', instagram: 'Cuenta profesional de Instagram' };
const CONNECTION_STATES = { connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };
const IDENTITY_LABELS = { businessId: 'Negocio', pageId: 'Página de Facebook', instagramActorId: 'Cuenta de Instagram', adAccountId: 'Cuenta de anuncios' };
const STATES = { draft: 'Borrador', ready: 'Preparada sin gasto autorizado', scheduled: 'Programada', publishing: 'En proceso', partial: 'Publicación parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Fallida', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Por comprobar', blocked: 'Bloqueada', prepared: 'Intención registrada', sent: 'Enviada; falta confirmar', confirmed: 'Confirmada', retry_wait: 'En espera' };
const PLACEMENTS = { facebook_feed: 'Facebook · Feed', facebook_reels: 'Facebook · Reels', instagram_feed: 'Instagram · Feed', instagram_reels: 'Instagram · Reels' };
const METRICS = { impressions: 'Impresiones', reach: 'Alcance', linkClicks: 'Clics de enlace', conversations: 'Conversaciones', interactions: 'Interacciones', views: 'Visualizaciones', plays: 'Reproducciones' };
const METHODS = { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' };
const PENDING = ['prepared', 'sent', 'retry_wait'];
const stateLabel = value => STATES[value] || value || 'Sin estado';
const textValue = value => value == null ? 'Sin dato' : typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);
const errorText = error => error?.message || error?.reason || error?.error || textValue(error);
const number = value => value == null ? 'No disponible' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 4 }).format(value);
function money(value, currency) {
  if (!Number.isSafeInteger(value)) return 'No disponible';
  const absolute = BigInt(value < 0 ? -value : value);
  return `${currency || 'Moneda sin verificar'} ${value < 0 ? '-' : ''}${new Intl.NumberFormat('es-CO').format(absolute / 100n)}${absolute % 100n ? `,${String(absolute % 100n).padStart(2, '0')}` : ''}`;
}
function date(value, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin fecha';
  try { return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); } catch { return value; }
}
function localDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const proposedName = (mode, objective, offer) => `${offer ? offerLabel(offer) : mode === 'paid' ? 'Campaña de marca' : 'Post de marca'} · ${OBJECTIVES[objective]}`.slice(0, 200);
function initial(mode, objective, campaign = {}) {
  return {
    name: campaign.name ?? proposedName(mode, objective), connectionId: campaign.connectionId || null, assetId: campaign.assetId || null,
    mode: campaign.mode || mode, objective: campaign.objective || objective, platforms: campaign.platforms || [],
    caption: campaign.caption || '', headline: campaign.headline || '', destinationUrl: campaign.destinationUrl || '',
    whatsappNumber: campaign.whatsappNumber || '', whatsappGreeting: campaign.whatsappGreeting || '',
    marketCountries: campaign.marketCountries ?? [],
    audience: { countries: [], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [], ...campaign.audience },
    placements: campaign.placements || [], budgetMinor: campaign.budgetMinor ?? 0, targetCostMinor: campaign.targetCostMinor ?? null,
    publishAt: campaign.publishAt || null, startAt: campaign.startAt || null, endAt: campaign.endAt || null,
    offerRef: campaign.offerRef ?? null,
    observationDays: campaign.observationDays || 7, aiDisclosure: campaign.aiDisclosure ?? null
  };
}
function firstIncomplete(form, campaign) {
  if (!form.name || !form.connectionId || !form.platforms.length || !form.marketCountries.length || campaign.validation?.offerError || campaign.recommendationInstructions?.needsConfirmation ||
      !form.assetId || !form.caption.trim() || form.objective === 'traffic' && !form.destinationUrl || form.mode === 'paid' && form.objective === 'whatsapp' && (!form.whatsappNumber || !form.whatsappGreeting)) return 0;
  return 1;
}
function networkName(network, connection) {
  const page = connection?.resources?.pages?.find(item => item.id === connection?.identities?.pageId);
  return network === 'facebook' ? page?.name : page?.instagramName;
}
function destinationIssue(connection, mode, network, asset, disclosure, placements) {
  if (!connection) return 'Por comprobar · conecta una cuenta al revisar los destinos.';
  if (connection.state !== 'connected' || connection.readOnly || connection.authenticationMethod === 'token') return 'La cuenta no permite publicar. Conecta una cuenta activa con permisos de escritura.';
  if (connection.revalidationRequired) return 'Por comprobar · vuelve a verificar la cuenta en Configuración.';
  if (!(mode === 'paid' ? connection.capabilities?.adsPublish : connection.capabilities?.[network === 'facebook' ? 'facebookPublish' : 'instagramPublish'])) return 'Falta permiso de publicación. Revisa la cuenta en Configuración.';
  if (unsupportedSocialDisclosure({ method: connection.integrationMethod, mode, platforms: [network], assetKind: asset?.kind, disclosure })) return 'Esta vía de Meta no verifica la etiqueta de contenido generado. Elige expresamente otra vía compatible o cambia el archivo; no retires la declaración.';
  if (!asset || asset.state !== 'ready') return 'Por comprobar · elige una pieza lista para revisar.';
  if (disclosure == null) return 'Por comprobar · declara la procedencia de la pieza en esta revisión.';
  if (!placements.length) return 'Por comprobar · selecciona Feed o Reels compatible.';
  if (placements.some(placement => !socialPlacementMatches(placement, asset.kind, mode))) return 'La pieza no corresponde a esta ubicación. Elige un lugar compatible o cambia el archivo.';
  return null;
}
function Values({ rows }) {
  return <dl className="summary-values">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Sin dato'}</dd></div>)}</dl>;
}
function AssetPreview({ asset, onPreviewReady, historical = false }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const errorRef = useRef(null);
  useEffect(() => { if (failed) errorRef.current?.focus(); }, [failed]);
  if (!asset) return null;
  if (asset.state !== 'ready' && !(historical && asset.state === 'archived' && asset.derivativeSha256)) return <p className={styles.warning}>La pieza no tiene un archivo listo para publicar. Revisa el estado en Biblioteca o cambia el archivo.</p>;
  const src = `${ROOT}/assets/${asset.id}/content?variant=derivative`, name = asset.name || 'Pieza seleccionada';
  const fail = () => { setFailed(true); onPreviewReady?.(false); };
  return <figure className={styles.assetPreview}>
    {failed ? <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>No se pudo leer la vista previa privada. Comprueba tu sesión o cambia el archivo; el original no se usará como sustituto.</p><button type="button" className="button subtle" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Volver a cargar vista previa</button></div>
      : asset.kind === 'video' ? <video key={attempt} className={styles.previewVideo} controls preload="metadata" playsInline src={src} onLoadedMetadata={() => onPreviewReady?.(true)} onError={fail} aria-label={`Vista previa de la pieza: ${name}`}/>
      : <img key={attempt} className={styles.previewImage} src={src} onLoad={() => onPreviewReady?.(true)} onError={fail} alt={`Vista previa de la pieza: ${name}`}/>}
    <figcaption><strong>{name}</strong> · Archivo privado preparado para revisar. {asset.width && asset.height ? `${asset.width}×${asset.height}` : ''}</figcaption>
  </figure>;
}
function Configuration({ spec, connection, asset }) {
  const zone = spec.timeZone || (spec.mode === 'organic' ? 'America/Bogota' : connection?.timeZone);
  return <div className={styles.stack}>
    <Values rows={[
      ['Conexión', METHODS[spec.integrationMethod || connection?.integrationMethod] || 'Sin seleccionar'], ['Cuenta conectada', connection?.name || spec.connectionId || 'Sin seleccionar'],
      ['Destinos', (spec.platforms || []).map(platform => {
        const identity = (spec.identities || connection?.identities)?.[platform === 'facebook' ? 'pageId' : 'instagramId'];
        return [NETWORKS[platform], networkName(platform, connection), identity ? `ID ${identity}` : null].filter(Boolean).join(' · ');
      }).join(' / ') || 'Sin seleccionar'],
      ...(spec.mode === 'paid' ? [['Cuenta de anuncios', connection?.resources?.adAccounts?.find(value => value.id === (spec.identities || connection?.identities)?.adAccountId)?.name || (spec.identities || connection?.identities)?.adAccountId || 'Sin verificar']] : []),
      ['Tipo de publicación', spec.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'], ['Objetivo', OBJECTIVES[spec.objective]],
      ['Imagen o video preparado', asset?.name || 'Sin seleccionar'],
      ['Texto', spec.caption || 'Sin texto'], ['Título o llamada a la acción', spec.headline || 'Sin título'],
      ['Destino', spec.destinationUrl || spec.whatsappNumber || 'Sin destino'], ['Bienvenida', spec.whatsappGreeting || 'No aplica'],
      ['Mercados elegidos', spec.marketCountries?.length ? spec.marketCountries.map(countryLabel).join(', ') : 'Sin mercado confirmado'],
      ['Divulgación de IA', spec.aiDisclosure === null || spec.aiDisclosure === undefined ? 'Pendiente de declarar' : spec.aiDisclosure ? 'Sí contiene IA' : 'No contiene IA'],
      ['Ubicaciones', (spec.placements || []).map(key => PLACEMENTS[key] || key).join(' · ') || 'Sin seleccionar'],
      ['Inversión total', spec.mode === 'paid' ? money(spec.budgetMinor, spec.currency || connection?.currency) : 'Sin inversión'],
      ['Zona de publicación / cuenta', zone || 'Sin verificar'],
      ...(spec.mode === 'paid' ? [['Inicio en cuenta', date(spec.startAt, zone)], ['Fin en cuenta', date(spec.endAt, zone)], ...(zone && zone !== 'America/Bogota' ? [['Inicio en Bogotá', date(spec.startAt, 'America/Bogota')], ['Fin en Bogotá', date(spec.endAt, 'America/Bogota')]] : [])] : [['Publicación en Bogotá', spec.publishAt ? date(spec.publishAt, 'America/Bogota') : 'Cuando se procese en segundo plano'], ['Horizonte de observación', `${spec.observationDays} días; no borra la publicación`]]),
      ...(spec.targetCostMinor != null ? [['Meta de costo del usuario', money(spec.targetCostMinor, spec.currency || connection?.currency)]] : [])
    ]}/>
    {spec.mode === 'paid' && <div><h4>Audiencia aprobada / propuesta</h4><p>Edad {spec.audience?.ageMin}–{spec.audience?.ageMax} · Géneros: {spec.audience?.genders?.length ? spec.audience.genders.map(g => g === 1 ? 'Hombres' : 'Mujeres').join(', ') : 'Todos'}.</p><ul>{(spec.audience?.countries || []).map(code => <li key={code}>{countryLabel(code)} · país completo</li>)}{['regions', 'cities', 'interests'].flatMap(group => (spec.audience?.[group] || []).map(ref => <li key={ref.key}>{ref.label} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} {ref.context?.region || ''}{ref.context?.radius != null ? ` · radio ${ref.context.radius} ${ref.context.distanceUnit === 'mile' ? 'millas' : 'km'}` : ''} · {METHODS[ref.source]}</li>))}</ul><p className={styles.help}>Sin listas de clientes ni condiciones de salud. No se autorizan ampliaciones automáticas de edad, geografía o ubicaciones.</p></div>}
    <details className={styles.technicalDetails}><summary>Detalles técnicos de la configuración</summary><Values rows={[
      ['Identidades verificadas', Object.entries(spec.identities || connection?.identities || {}).map(([key, value]) => `${IDENTITY_LABELS[key] || key}: ${value}`).join(' · ') || 'Sin verificar'],
      ['ID de conexión', spec.connectionId || connection?.id], ['ID de pieza', spec.assetId || asset?.id], ['Hash del derivado', spec.assetHash || asset?.sha256 || 'No disponible'],
    ]}/></details>
  </div>;
}
function Forecast({ forecast }) {
  const audience = forecast?.audienceEstimate, ranges = Object.entries(forecast?.metricRanges || {}), manual = forecast?.manualScenario;
  return <div className={styles.stack}>
    <section className={styles.card}><h3>1. Audiencia potencial de Meta</h3><p>{audience?.status === 'reported' ? `${number(audience.lower)}–${number(audience.upper)}` : audience?.reason || 'Aún no se ha consultado una estimación para esta configuración.'}</p>{audience && <Values rows={[["Definición", audience.label || audience.definition], ['Horizonte informado por Meta', textValue(audience.horizon)], ['Fuente', audience.source], ['Consultado', date(audience.fetchedAt)], ['Versión', audience.apiVersion || audience.adapterVersion || 'No informada']]}/>}<p className={styles.help}>Tamaño potencial, alcance diario y entrega son conceptos distintos. No es alcance comprado ni una predicción de ventas.</p></section>
    <section className={styles.card}><h3>2. Rango histórico comparable</h3><p className={styles.help}>Mitad central de los resultados comparables; no es una probabilidad de éxito. La mediana es el valor central de esas muestras.</p>{ranges.length ? <div className={styles.tableWrap} role="region" aria-label="Rangos históricos comparables" tabIndex={0}><table className={styles.table}><caption>Resultados comparables, por métrica y red</caption><thead><tr><th scope="col">Métrica</th><th scope="col">Rango habitual (25 %–75 %)</th><th scope="col">Mediana (valor central)</th><th scope="col">Muestras</th></tr></thead><tbody>{ranges.map(([key, range]) => <tr key={key}><th scope="row">{METRICS[range.metric] || key} · {range.channel}</th><td>{number(range.lower)}–{number(range.upper)}</td><td>{number(range.median)}</td><td>{range.sampleCount}</td></tr>)}</tbody></table></div> : <p>Datos insuficientes: se necesitan al menos cinco publicaciones finalizadas comparables con cobertura, precisión y definición compatibles. No se inventa un rendimiento inicial.</p>}{forecast && <><p>{forecast.sampleCount ?? 0} publicaciones comparables utilizadas · {forecast.algorithmVersion} · {date(forecast.generatedAt)}</p>{forecast.unavailableReasons?.length > 0 && <details><summary>Datos faltantes por métrica</summary><ul>{forecast.unavailableReasons.map((item, i) => <li key={i}>{typeof item === 'string' ? item : `${item.metric}: ${item.sampleCount ?? 0} muestras; ${item.reason}`}</li>)}</ul></details>}<ul>{(forecast.assumptions || []).map(value => <li key={value}>{value}</li>)}</ul></>}</section>
    <section className={styles.card}><h3>3. Mi propia hipótesis</h3>{manual ? <><p>{METRICS[manual.metric?.split('.').at(-1)] || manual.metric}: {number(manual.lower)}–{number(manual.upper)}</p><p>{manual.basis}</p></> : <p>No se declaró una hipótesis manual.</p>}<p className={styles.help}>Hipótesis del usuario, no predicción del sistema, entrenamiento ni análisis visual de la imagen o video. No se inventa una mediana para este rango.</p></section>
  </div>;
}

export default function AdvertisingCampaignEditor(props) {
  return <CampaignEditor key={props.campaignId || 'new'} {...props}/>;
}
function CampaignEditor({ api, campaignId = null, connections = [], requirements = [], assets = [], initialMode = 'organic', initialObjective = 'engagement', studioThread = null, studioId = null, onStudioThread, onSaved, onNavigate, onInteractionStateChange, onComposerState, onMutation, revision = 0 }) {
  const existing = campaignId && campaignId !== 'new' ? campaignId : null;
  const studioAsset = studioThread?.selectedAsset ?? null;
  const [campaign, setCampaign] = useState(null), [form, setForm] = useState(() => initial(initialMode, initialObjective, studioAsset ? { assetId: studioAsset.id, aiDisclosure: studioAsset.aiDisclosure === true ? true : null } : {}));
  const [step, setStep] = useState(0), [loading, setLoading] = useState(Boolean(existing)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState({}), [retry, setRetry] = useState(0), [forecastChoice, setForecastChoice] = useState(null);
  const [rights, setRights] = useState(false), [warningsAccepted, setWarningsAccepted] = useState([]), [investment, setInvestment] = useState(false), [recommendationAccepted, setRecommendationAccepted] = useState(false);
  const [privateConsent, setPrivateConsent] = useState(false), [search, setSearch] = useState(''), [searchKind, setSearchKind] = useState('location'), [candidates, setCandidates] = useState([]), [country, setCountry] = useState('');
  const [audienceChoice, setAudienceChoice] = useState(null), [audienceBusy, setAudienceBusy] = useState(false);
  const [manualEnabled, setManualEnabled] = useState(false), [manual, setManual] = useState({ metric: '', lower: '', upper: '', basis: '' });
  const [action, setAction] = useState(null), [actionForm, setActionForm] = useState({}), [operationId, setOperationId] = useState(null), [operation, setOperation] = useState(null);
  const [offers, setOffers] = useState(null), [offerPicker, setOfferPicker] = useState(null), [refreshedOffer, setRefreshedOffer] = useState(null);
  const [selectedAsset, setSelectedAsset] = useState(studioAsset);
  const [threadSelection, setThreadSelection] = useState(studioThread);
  const [openedStudio, setOpenedStudio] = useState(studioThread?.id ?? studioId);
  const [composer, setComposer] = useState(false), [imageInstructions, setImageInstructions] = useState('');
  const [learning, setLearning] = useState(null);
  const baseline = useRef(JSON.stringify(form)), current = useRef(null), requests = useRef(new Set()), rids = useRef(new Map()), sequence = useRef(0), locked = useRef(false);
  const heading = useRef(null), errorRef = useRef(null), actionHeading = useRef(null), nextRef = useRef(null), focusTarget = useRef(null), callbacks = useRef({}), id = useId();
  const saveDraftRef = useRef(null), focusSaveAfterSelection = useRef(false);
  callbacks.current = { onSaved, onNavigate, onInteractionStateChange, onMutation };
  const formDirty = JSON.stringify(form) !== baseline.current || Object.values(invalid).some(Boolean);
  const confirmDirty = rights || investment || recommendationAccepted || warningsAccepted.length > 0 || privateConsent || manualEnabled;
  const dirty = formDirty || confirmDirty || Boolean(action) || Boolean(imageInstructions);
  const frozen = Boolean(campaign && (campaign.state !== 'draft' || campaign.revisions?.length));
  const sameDraft = campaign?.applicationMode === 'same' ? campaign.changeDraft : null;
  const uncertain = campaign?.operations?.some(item => ['sent', 'uncertain'].includes(item.state));
  const preflightPending = campaign?.operations?.some(item => !item.deliveryId && PENDING.includes(item.state));
  const pending = uncertain || preflightPending || campaign?.operations?.some(item => PENDING.includes(item.state)) || campaign?.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review'].includes(item.state));
  const assistant = useAssistantForm({
    target: 'campaign-draft', entityId: campaign?.id || existing || null, recordVersion: campaign?.version ?? null,
    enabled: campaign?.applicationMode !== 'same',
    values: form, dirty, busy: busy || loading || audienceBusy,
    referenceChoices: { connectionId: connections.map(item => item.id), assetId: assets.filter(item => item.state === 'ready').map(item => item.id) },
    applyPatch: patch => {
      if (frozen || uncertain || preflightPending) throw new Error('Este borrador no se puede editar hasta resolver su operación o revisión pendiente.');
      for (const key of ['mode', 'connectionId', 'platforms', 'assetId']) {
        if (!Object.hasOwn(patch, key)) continue;
        if (key === 'mode') changeMode(patch[key]);
        else if (key === 'connectionId') selectConnection(patch[key]);
        else if (key === 'platforms') changePlatforms(patch[key]);
        else changeAsset(patch[key]);
      }
      for (const [key, value] of Object.entries(patch)) {
        if (['mode', 'connectionId', 'platforms', 'assetId'].includes(key)) continue;
        set(key, value);
      }
    },
    acceptAutomaticResult: campaign?.state === 'draft' && !frozen && !uncertain && !preflightPending ? async ({ result }) => {
      try { await hydrateCommittedDraft(result); }
      catch (cause) { setError(`El cambio se guardó; no se pudo actualizar el borrador. ${cause.message}`); throw cause; }
    } : undefined,
  });
  current.current = { formDirty, campaign, form, busy };
  const connection = connections.find(item => item.id === form.connectionId) || (campaign?.connection?.id === form.connectionId ? campaign.connection : null);
  const readOnlyConnection = connection?.readOnly || connection?.authenticationMethod === 'token';
  const canWriteConnection = connection?.state === 'connected' && !readOnlyConnection && (form.mode === 'paid' ? connection?.capabilities?.adsPublish : form.platforms?.every(platform => connection?.capabilities?.[platform === 'instagram' ? 'instagramPublish' : 'facebookPublish']));
  const audienceMode = audienceChoice ?? campaign?.audienceMode;
  const coveredMarkets = new Set([...form.audience.countries, ...[...form.audience.regions, ...form.audience.cities].map(ref => ref.context.countryCode)]);
  const outsideMarket = [...coveredMarkets].filter(code => !form.marketCountries.includes(code));
  const missingMarket = form.marketCountries.filter(code => !coveredMarkets.has(code));
  const coveredExactly = form.mode !== 'paid' || !outsideMarket.length && !missingMarket.length;
  const needsWriteAccess = name => ['prepare-paid', 'approve-organic', 'publish-organic', 'activate-paid', 'resume', 'resume-restored'].includes(name);
  const inventoriedAsset = assets.find(item => item.id === form.assetId);
  const asset = selectedAsset?.id === form.assetId && (!inventoriedAsset || selectedAsset.version > inventoriedAsset.version) ? selectedAsset : inventoriedAsset || (campaign?.asset?.id === form.assetId ? campaign.asset : null);
  const approved = campaign?.revisions?.at(-1), forecast = frozen ? approved?.forecast : forecastChoice || campaign?.forecasts?.find(item => item.id === campaign.forecastId);
  const validation = campaign?.validation, warningList = validation?.warnings || [];
  const hasCurrentForecast = Boolean(forecast?.id && !formDirty);
  const spec = frozen ? approved?.spec || campaign : { ...form, audienceMode: formDirty ? undefined : campaign?.audienceMode, integrationMethod: connection?.integrationMethod, currency: connection?.currency, timeZone: form.mode === 'paid' ? connection?.timeZone : 'America/Bogota' };
  const hold = campaign?.restore_hold || campaign?.restoreHold;
  const withoutDeliveries = campaign?.mode === 'organic' && !campaign.deliveries?.length;
  const awaitingPublication = withoutDeliveries && campaign.state === 'ready' && Boolean(approved);
  const publicationRequirements = requirements.find(item => item.integrationMethod === spec?.integrationMethod);
  const publicationSettingsIssue = publicationRequirements && (!publicationRequirements.enabled ? 'Habilita el acceso asistido por navegador para usar esta vía.' :
    !publicationRequirements.configured ? 'Completa las opciones de Meta que aparecen como pendientes.' :
    !publicationRequirements.publishingEnabled ? 'Habilita la publicación en las opciones de Meta.' : null);
  const expiredPublication = spec?.publishAt && Date.parse(spec.publishAt) <= Date.now();
  const canPublish = awaitingPublication && !hold && !campaign.operations?.length && !expiredPublication && canWriteConnection &&
    !connection.disconnectStatus && !connection.revalidationRequired &&
    validation?.specHash === approved.specHash && publicationRequirements?.enabled &&
    publicationRequirements.configured && publicationRequirements.publishingEnabled;
  const paidDelivery = campaign?.deliveries?.find(item => item.channel === 'meta_ads');
  const budget = paidDelivery?.budgetSnapshot;
  const checkedSaldo = budget && Number.isSafeInteger(budget.remainingMinor) && budget.remainingMinor >= 0 && budget.remainingMinor <= spec.budgetMinor &&
    budget.budgetMinor === spec.budgetMinor && budget.currency === spec.currency && budget.startAt === spec.startAt && budget.endAt === spec.endAt;
  const paidAwaiting = campaign?.mode === 'paid' && campaign.state === 'ready';
  const activationAllowed = paidAwaiting && checkedSaldo && paidDelivery?.preparedRefs && !hold && !pending && canWriteConnection &&
    Date.parse(spec.endAt) > Date.now() && publicationRequirements?.enabled && publicationRequirements.configured && publicationRequirements.publishingEnabled;
  const confirmedResults = campaign?.deliveries?.some(delivery => delivery.remoteId && delivery.lastConfirmedAt &&
    (campaign.mode === 'paid' ? ['active', 'completed'].includes(delivery.lastConfirmedState) : delivery.lastConfirmedState === 'published' || delivery.state === 'published'));
  const needsReconcile = uncertain || ['needs_attention', 'partial', 'failed'].includes(campaign?.state) || paidAwaiting && !pending && !checkedSaldo;
  const publishLabel = spec?.publishAt ? 'Programar' : 'Publicar';
  const instruction = campaign?.recommendationInstructions;
  const primary = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' }[form.objective];
  const manualMetrics = form.mode === 'paid' ? [primary] : form.objective === 'whatsapp' ? [] : form.platforms.filter(network => !(network === 'instagram' && primary === 'linkClicks')).map(network => `${network}.${primary}`);
  const offerIsSaved = JSON.stringify(form.offerRef) === JSON.stringify(campaign?.offerRef ?? null);
  const offerProblem = offerIsSaved ? validation?.offerError : null;
  const displayedOffers = { primary: offers?.primary, gift: offers?.gift ? { ...offers.gift, condition: form.offerRef?.gift?.condition } : null };
  const currentAlignment = { mode: form.mode, objective: form.objective, offerHash: offerIsSaved ? campaign?.offerHash ?? null : null };
  const contextualMatch = item => !item?.alignment || !offerProblem && offerIsSaved && item.alignment.mode === form.mode && item.alignment.objective === form.objective && item.alignment.offerHash === currentAlignment.offerHash;

  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy: busy || audienceBusy || assistant.assistantBusy }); }, [dirty, busy, audienceBusy, assistant.assistantBusy]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (loading || busy || error) return;
    if (focusTarget.current === 'step') {
      heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' });
      focusTarget.current = null;
    } else if (focusTarget.current) { findRequirement(focusTarget.current)?.focus(); focusTarget.current = null; }
    else if (awaitingPublication || paidAwaiting || confirmedResults || needsReconcile) (nextRef.current || heading.current)?.focus();
    else heading.current?.focus();
  }, [step, loading, busy, awaitingPublication, campaign?.state, activationAllowed, confirmedResults, needsReconcile]);
  useEffect(() => { if (action) actionHeading.current?.focus(); }, [action]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); }, []);
  const learningChannel = form.mode === 'paid' && form.platforms.length ? 'meta_ads' : form.platforms.length === 1 ? form.platforms[0] : null;
  const learningHash = offerIsSaved ? campaign?.offerHash : null;
  useEffect(() => {
    setLearning(null);
    if (step !== 0 || !learningHash || !learningChannel || offerProblem || sameDraft) return;
    const controller = new AbortController();
    api(`${ROOT}/learnings?${new URLSearchParams({ offerHash: learningHash, mode: form.mode, objective: form.objective, channel: learningChannel })}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setLearning(result.learnings?.find(item => item.idea) || null);
    }).catch(() => {});
    return () => controller.abort();
  }, [api, form.mode, form.objective, learningChannel, learningHash, offerProblem, sameDraft, step]);

  async function request(path, options = {}) {
    const controller = new AbortController(); requests.current.add(controller);
    try { return await api(path, { ...options, signal: controller.signal }); } finally { requests.current.delete(controller); }
  }
  function rid(scope, payload) {
    const key = `${scope}:${JSON.stringify(payload)}`;
    if (!rids.current.has(key)) rids.current.set(key, crypto.randomUUID());
    return rids.current.get(key);
  }
  function completeRid(scope, payload) { rids.current.delete(`${scope}:${JSON.stringify(payload)}`); }
  function resetAcceptance() { setRights(false); setInvestment(false); setWarningsAccepted([]); setRecommendationAccepted(false); }
  function applyDetail(data, { replace = false, openStep = false } = {}) {
    setCampaign(data);
    if (replace || !current.current.formDirty) {
      const next = initial(initialMode, initialObjective, data); baseline.current = JSON.stringify(next); setForm(next); setInvalid({});
      setOffers(data.offerSnapshot ?? null);
      if (openStep) setStep(data.state === 'draft' ? firstIncomplete(next, data) : 2);
    }
    if (data.preflight?.operationId) setOperationId(data.preflight.operationId);
    if (data.preflight?.candidates) setCandidates(data.preflight.candidates);
  }
  async function loadDetail(target = current.current.campaign?.id || existing, options = {}) {
    if (!target) return null;
    const seq = ++sequence.current;
    const data = await request(`${ROOT}/campaigns/${encodeURIComponent(target)}`);
    if (seq !== sequence.current) return null;
    applyDetail(data, options); return data;
  }
  useEffect(() => {
    if (!existing || current.current.formDirty || locked.current || assistant.assistantBusy && !loading) return;
    let active = true; setLoading(true);
    loadDetail(existing, { openStep: !current.current.campaign }).catch(cause => { if (active && cause.name !== 'AbortError') setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; sequence.current++; };
  }, [api, existing, revision, retry]);
  useEffect(() => {
    if (!pending || !campaign?.id) return;
    let active = true, timer;
    const poll = async () => {
      if (!active) return;
      if (document.visibilityState === 'hidden' || locked.current || assistant.assistantBusy) { timer = setTimeout(poll, 5000); return; }
      try {
        if (operationId) { const value = await request(`${ROOT}/operations/${encodeURIComponent(operationId)}`); if (active) { setOperation(value); if (value.result?.candidates) setCandidates(value.result.candidates); } }
        if (active) await loadDetail();
      } catch (cause) { if (active && cause.name !== 'AbortError') setError(`No se pudo actualizar el progreso; se conserva la última evidencia. ${cause.message}`); }
      if (active) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => { active = false; clearTimeout(timer); };
  }, [api, campaign?.id, pending, operationId]);

  function set(key, value) {
    setForm(previous => ({ ...previous, [key]: value, ...(key === 'objective' && previous.name === proposedName(previous.mode, previous.objective, offers?.primary) ? { name: proposedName(previous.mode, value, offers?.primary) } : {}) })); setForecastChoice(null); resetAcceptance();
  }
  function setAudience(key, value) {
    setForm(previous => ({ ...previous, audience: { ...previous.audience, [key]: value } })); setForecastChoice(null); resetAcceptance();
  }
  function changeMarkets(value) {
    setCountry(''); setCandidates([]); set('marketCountries', value);
    setNotice('Mercado actualizado. Revisa la segmentación existente; no se amplió ninguna zona automáticamente.');
  }
  function selectConnection(value) {
    const next = connections.find(item => item.id === value), currencyChanged = connection?.currency !== next?.currency;
    setForm(previous => ({ ...previous, connectionId: value || null, audience: { ...previous.audience, regions: [], cities: [], interests: [] }, ...(currencyChanged ? { budgetMinor: 0, targetCostMinor: null } : {}) }));
    setCandidates([]); setOperation(null); setOperationId(null); setForecastChoice(null); setPrivateConsent(false); resetAcceptance();
    setNotice(currencyChanged ? 'Cambió la moneda: vuelve a ingresar y aceptar el presupuesto. Se retiraron referencias de la cuenta anterior.' : 'Las referencias y la preparación deben validarse para esta cuenta; no se trasladan objetos remotos.');
  }
  function changeMode(value) {
    setForm(previous => ({ ...previous, mode: value, ...(previous.name === proposedName(previous.mode, previous.objective, offers?.primary) ? { name: proposedName(value, previous.objective, offers?.primary) } : {}), budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null, publishAt: null, placements: [] })); setForecastChoice(null); resetAcceptance();
  }
  function changePlatforms(value) {
    setForm(previous => ({ ...previous, platforms: value, placements: previous.placements.filter(key => value.some(network => key.startsWith(`${network}_`))) })); setForecastChoice(null); resetAcceptance();
  }
  function changeAsset(value) {
    const selected = assets.find(item => item.id === value);
    if (value && (!selected || selected.state !== 'ready' || !contextualMatch(selected))) throw new Error('Elige una pieza lista y compatible en el estudio.');
    setThreadSelection(null); setSelectedAsset(selected || null);
    setForm(previous => ({ ...previous, assetId: value || null, aiDisclosure: selected?.aiDisclosure === true ? true : null }));
    setForecastChoice(null); resetAcceptance();
  }
  function useImage(result, thread) {
    if (result.state !== 'ready' || !contextualMatch(result) || sameDraft && (result.kind !== 'image' || result.aiDisclosure)) {
      setError('Esta pieza no está lista o no corresponde a esta oferta, objetivo o vía. Elige otro archivo o ajusta la pieza con los datos vigentes.');
      return;
    }
    if (!sameDraft) {
      setThreadSelection(thread);
      focusSaveAfterSelection.current = true;
    }
    setSelectedAsset(result);
    setForm(previous => ({ ...previous, assetId: result.id, aiDisclosure: result.aiDisclosure === true ? true : null }));
    setForecastChoice(null); resetAcceptance();
    setComposer(false); setImageInstructions('');
    setNotice('Pieza elegida para este borrador. Guarda para conservarla; no se ha publicado.');
  }
  function reading(action) {
    const controller = new AbortController(); requests.current.add(controller);
    return action({ signal: controller.signal }).finally(() => requests.current.delete(controller));
  }
  function choosePrimary(item) {
    const previous = form.offerRef, same = item?.id === previous?.primary.id && item?.kind === previous?.primary.kind;
    setOffers(item ? { primary: item, gift: same ? offers?.gift : null } : null);
    setForm(value => ({ ...value, name: !value.name.trim() || value.name === proposedName(value.mode, value.objective, offers?.primary) ? proposedName(value.mode, value.objective, item) : value.name,
      offerRef: item ? { primary: { id: item.id, kind: item.kind, factsHash: item.factsHash }, gift: same ? previous?.gift ?? null : null } : null }));
    setRefreshedOffer(null); setOfferPicker(null); resetAcceptance();
    setNotice(!same && previous?.gift ? 'Cambió la referencia principal. Se retiró el obsequio y su condición; vuelve a elegirlos para esta compra.' : '');
  }
  function chooseGift(item) {
    if (!form.offerRef) return;
    setOffers(previous => ({ ...previous, gift: item }));
    set('offerRef', { ...form.offerRef, gift: item ? { id: item.id, factsHash: item.factsHash, condition: item.id === form.offerRef.gift?.id ? form.offerRef.gift.condition : '' } : null });
    setRefreshedOffer(null); setOfferPicker(null);
  }
  function readLatestOffer() {
    return task(async () => {
      const ref = form.offerRef;
      const [primary, gift] = await reading(options => Promise.all([readAdvertisingOffer(api, ref.primary, options), ref.gift ? readAdvertisingOffer(api, { id: ref.gift.id, kind: 'gift' }, options) : null]));
      if (!primary.selectable || gift && !gift.selectable) throw new Error('La oferta o el obsequio ya no están disponibles; cambia la referencia o quítala.');
      setRefreshedOffer({ primary, gift: gift ? { ...gift, condition: ref.gift.condition } : null });
    });
  }
  function acceptRefreshedOffer() {
    const { primary, gift } = refreshedOffer;
    setOffers(refreshedOffer);
    set('offerRef', { primary: { id: primary.id, kind: primary.kind, factsHash: primary.factsHash }, gift: gift ? { id: gift.id, factsHash: gift.factsHash, condition: gift.condition } : null });
    setRefreshedOffer(null); setNotice('Aceptaste la ficha comercial actual. Guarda para actualizar el borrador.');
  }
  async function changeSameAction(action) {
    return task(async () => {
      const payload = { action, version: sameDraft.recommendationVersion, evidenceHash: sameDraft.evidenceHash, draftId: campaign.id, draftVersion: campaign.version, deliveryId: sameDraft.deliveryId,
        ...(action === 'confirm-in-place' ? { diffHash: sameDraft.diffHash, rightsAccepted: rights, acknowledged: recommendationAccepted } : {}) };
      await request(`${ROOT}/recommendations/${sameDraft.recommendationId}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(action, payload) }) });
      resetAcceptance(); await notifyMutation();
      callbacks.current.onNavigate?.({ tab: 'results', record: campaign.parentCampaignId, resultsFocus: 'recommendations' });
    });
  }
  function submissionFields() {
    if (sameDraft?.variable === 'caption') return { caption: form.caption };
    if (sameDraft?.variable === 'asset') return { assetId: form.assetId, aiDisclosure: form.aiDisclosure };
    return form;
  }
  async function task(fn) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { return await fn(); } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { locked.current = false; setBusy(false); }
  }
  async function notifyMutation() {
    try { await callbacks.current.onMutation?.(); } catch (cause) { setNotice(`La operación se guardó; la vista general está pendiente de actualizar. ${cause.message}`); }
  }
  function assertSaveableDraft() {
    if (!form.name.trim()) throw new Error('Escribe un nombre para poder guardar y retomar este borrador.');
    if (Object.values(invalid).some(Boolean)) throw new Error('Corrige el formato de los importes antes de guardar.');
  }
  async function hydrateCommittedDraft(result) {
    const target = current.current.campaign?.id || existing;
    if (!result?.id || target && result.id !== target || !Number.isSafeInteger(result.version)) throw new Error('No se recibió el borrador guardado para actualizar este editor.');
    const data = await loadDetail(result.id, { replace: true });
    if (!data) throw new Error('La lectura del borrador fue reemplazada por otra actualización. Recarga los datos guardados.');
    setForecastChoice(null); resetAcceptance(); setNotice('Borrador guardado. No se publicó ni se autorizó gasto.');
    setThreadSelection(null);
    await notifyMutation();
    return data;
  }
  async function persist() {
    assertSaveableDraft();
    const target = campaign?.id || existing;
    if (target && !formDirty && !threadSelection) return campaign;
    const payload = { ...submissionFields(), version: target ? campaign?.version : 0,
      ...(threadSelection ? { threadId: threadSelection.id, threadVersion: threadSelection.version } : {}) };
    const body = { ...payload, requestId: rid(`save:${target || 'new'}`, payload) };
    const result = await request(`${ROOT}/campaigns${target ? `/${encodeURIComponent(target)}` : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    return hydrateCommittedDraft(result);
  }
  async function save(event) {
    event?.preventDefault();
    if (assistant.assistantBusy || busy || loading) return false;
    setError('');
    try {
      assertSaveableDraft();
      if (sameDraft || threadSelection) {
        const saved = await task(() => persist());
        if (saved && !sameDraft) await callbacks.current.onSaved?.(saved);
        return Boolean(saved);
      }
      let savedUnassisted = false;
      const result = await assistant.submitAssisted({
        payload: { ...form, version: campaign?.version ?? 0 },
        saveUnassisted: async () => {
          savedUnassisted = true;
          return await task(() => persist()) || false;
        },
        onCommitted: async result => {
          const saved = savedUnassisted ? result : await hydrateCommittedDraft(result);
          await callbacks.current.onSaved?.(saved);
        },
      });
      if (result.postCommitError) setError(`Borrador guardado; no se actualizó la vista. ${result.postCommitError.message || ''}`);
      if (result.reason === 'changed') setError('El borrador cambió mientras se guardaba. Revisa los valores e inténtalo de nuevo.');
      return result.saved && !result.postCommitError;
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); return false; }
  }
  async function refreshAudience(version) {
    const saved = await loadDetail(campaign.id, { replace: true });
    if (!saved || saved.version < version) throw new Error('Se guardó la audiencia; vuelve a cargar el borrador para verificar su versión.');
    setForecastChoice(null); resetAcceptance(); await notifyMutation();
  }
  async function preflight(kind) {
    await task(async () => {
      if (kind === 'prepare' && !privateConsent) throw new Error('Acepta expresamente crear un borrador privado en Meta, sin publicar ni gastar.');
      const saved = await persist();
      const payload = { kind, version: saved.version, ...(kind === 'prepare' ? { acceptPrivateDraft: true } : {}), ...(kind === 'targeting' ? { query: { kind: searchKind, q: search.trim() } } : {}) };
      const result = await request(`${ROOT}/campaigns/${saved.id}/browser-preflight`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`preflight:${saved.id}`, payload) }) });
      setOperationId(result.operationId); setOperation({ id: result.operationId, step: kind, state: result.state, nextAttemptAt: result.nextRunAt }); setPrivateConsent(false); resetAcceptance();
      await loadDetail(saved.id); completeRid(`preflight:${saved.id}`, payload); setNotice('Preparación privada encolada. El borrador remoto no demuestra publicación ni actividad.'); await notifyMutation(); callbacks.current.onSaved?.({ ...saved, version: result.version });
    });
  }
  async function searchAudience(event) {
    event.preventDefault();
    if (search.trim().length < 2) { setError('Escribe al menos dos caracteres para buscar candidatos oficiales.'); return; }
    if (connection?.integrationMethod === 'browser') { await preflight('targeting'); return; }
    await task(async () => {
      if (!connection?.id) throw new Error('Selecciona una conexión oficial de Meta (API) vigente.');
      const result = await request(`${ROOT}/targeting?${new URLSearchParams({ kind: searchKind, q: search.trim(), connection: connection.id })}`);
      setCandidates(result.candidates || []); setNotice(result.candidates?.length ? 'Selecciona un candidato por su jerarquía verificada.' : 'La cuenta no devolvió candidatos para esa búsqueda.');
    });
  }
  function addReference(ref) {
    const type = ref.context?.type, group = { interest: 'interests', region: 'regions', city: 'cities' }[type];
    if (!group || ref.source !== connection?.integrationMethod) { setError('El candidato no tiene tipo o fuente compatible verificable.'); return; }
    if (form.audience[group].some(item => item.key === ref.key)) return;
    if (group !== 'interests') {
      const code = ref.context.countryCode;
      if (!form.marketCountries.includes(code)) { setError('La zona no pertenece a los mercados confirmados. No se ampliará el mercado al seleccionarla.'); return; }
      const overlappingRegion = type === 'city' && form.audience.regions.some(item => item.context.countryCode === code && (item.providerId && item.providerId === ref.context.regionId || item.context.region === ref.context.region));
      const overlappingCity = type === 'region' && form.audience.cities.some(item => item.context.countryCode === code && (ref.providerId && ref.providerId === item.context.regionId || ref.context.region === item.context.region));
      if (form.audience.countries.includes(code) || overlappingRegion || overlappingCity) { setError('Retira primero el país completo o la región/ciudad superpuesta. No se ampliará ni reemplazará tu ámbito automáticamente.'); return; }
    }
    setAudience(group, [...form.audience[group], ref]);
  }
  function addCountry() {
    if (!form.marketCountries.includes(country) || form.audience.countries.includes(country)) return;
    if ([...form.audience.regions, ...form.audience.cities].some(ref => ref.context.countryCode === country)) { setError('Retira primero las regiones/ciudades de ese país para no superponer ámbitos.'); return; }
    setAudience('countries', [...form.audience.countries, country]); setCountry('');
  }
  async function estimate() {
    await task(async () => {
      if (!form.marketCountries.length || !coveredExactly) throw new Error('Confirma los mercados y su cobertura antes de estimar.');
      const saved = await persist();
      let scenario = null;
      if (manualEnabled) {
        if (!manualMetrics.includes(manual.metric) || manual.lower.trim() === '' || manual.upper.trim() === '' || !manual.basis.trim()) throw new Error('Completa métrica, límites y fundamento del escenario declarado.');
        const lower = Number(manual.lower), upper = Number(manual.upper);
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper < lower) throw new Error('Los límites deben ser finitos, no negativos y estar ordenados.');
        scenario = { metric: manual.metric, lower, upper, basis: manual.basis.trim() };
      }
      const payload = { version: saved.version, manualScenario: scenario };
      const result = await request(`${ROOT}/campaigns/${saved.id}/forecast`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`forecast:${saved.id}`, payload) }) });
      setManualEnabled(false); setForecastChoice(result); resetAcceptance(); await loadDetail(saved.id); completeRid(`forecast:${saved.id}`, payload); setNotice('Estimación guardada para esta configuración. Revisa sus ausencias y confirma por separado.'); await notifyMutation(); callbacks.current.onSaved?.(saved);
    });
  }
  async function campaignAction(name, fields = {}) {
    await task(async () => {
      if (needsWriteAccess(name) && !canWriteConnection) throw new Error('La conexión activa no acredita permisos de escritura. Un token manual es de solo lectura.');
      if (name === 'publish-organic' && (!canPublish || loading || fields.publishAccepted !== true || fields.version !== campaign.version)) throw new Error('La revisión ya no está disponible para publicar. Recarga y revisa la configuración.');
      if (name === 'pause' && (readOnlyConnection || connection?.state !== 'connected')) throw new Error('La conexión de solo lectura o inactiva no puede pausar anuncios. Detén el gasto directamente en Meta.');
      if (!campaign?.id) throw new Error('Guarda primero el borrador.');
      if (formDirty) throw new Error('Guarda los cambios antes de operar sobre la configuración del servidor.');
      const payload = { action: name, version: campaign.version, ...fields };
      const result = await request(`${ROOT}/campaigns/${campaign.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`action:${campaign.id}`, payload) }) });
      resetAcceptance(); setAction(null); setActionForm({}); setPrivateConsent(false);
      if (result.operationId) setOperationId(result.operationId);
      setNotice(name === 'approve-organic' ? 'Revisión aprobada sin publicar. Todavía no se ha solicitado ninguna entrega.' : name === 'duplicate' ? 'Nuevo borrador creado, sin aprobación ni gasto.' : name === 'cancel' && result.state === 'cancelled' ? 'Trabajo local cancelado. No se borraron publicaciones en Meta.' : 'Solicitud registrada. El estado remoto sólo cambia cuando se confirme; encolar no significa publicar ni pausar.');
      if (name === 'duplicate') { await notifyMutation(); callbacks.current.onSaved?.(result); return; }
      await loadDetail(campaign.id, { replace: true }); completeRid(`action:${campaign.id}`, payload); await notifyMutation();
    });
  }
  function approve() {
    if (!forecast?.id || !forecast.specHash || forecast.specHash !== validation?.specHash || !validation?.valid || formDirty || !rights || form.mode === 'paid' && !investment || warningList.some(item => !warningsAccepted.includes(item.key)) || instruction?.needsConfirmation && !recommendationAccepted) { setError('Guarda y estima la configuración actual; acepta derechos, advertencias y las confirmaciones requeridas.'); return; }
    void campaignAction(form.mode === 'paid' ? 'prepare-paid' : 'approve-organic', { rightsAccepted: true, acceptedWarnings: warningList.map(item => item.key), specHash: forecast.specHash, forecastId: forecast.id, ...(form.mode === 'paid' ? { investmentAccepted: true } : {}), ...(instruction?.needsConfirmation ? { recommendationAccepted: true } : {}) });
  }
  function openAction(name, operationValue = null) {
    if (name === 'publish-organic' && !canPublish) return;
    if (name === 'activate-paid' && !activationAllowed || name === 'resume' && !checkedSaldo) { setError('Comprueba en Meta el saldo y las fechas antes de autorizar.'); return; }
    if (needsWriteAccess(name) && !canWriteConnection) { setError('Esta acción requiere una conexión activa con permisos de escritura; el token manual solo permite lectura.'); return; }
    if (name === 'pause' && (readOnlyConnection || connection?.state !== 'connected')) { setError('Esta conexión no puede pausar anuncios; detén el gasto directamente en Meta.'); return; }
    setAction({ name, operation: operationValue, version: campaign.version, ...(name === 'publish-organic' ? { approved, connection: campaign.connection, asset: campaign.asset } : {}) });
    setActionForm({ reason: '', rightsAccepted: false, investmentAccepted: false, publishAccepted: false, acceptDuplicateRisk: false, confirmAbsence: false, acceptContentVerification: false, acceptPrivateDraft: false, acceptedWarnings: [], remainingBudgetMinor: checkedSaldo ? budget.remainingMinor : null, remoteId: '', permalink: '' });
  }
  async function submitAction(event) {
    event.preventDefault(); const name = action.name, fields = {}, delivery = campaign.deliveries?.find(item => item.channel === 'meta_ads');
    if (name === 'publish-organic') Object.assign(fields, { version: action.version, revision: action.approved.revision, specHash: action.approved.specHash, publishAccepted: actionForm.publishAccepted });
    if (['pause', 'cancel'].includes(name)) fields.reason = actionForm.reason;
    if (['activate-paid', 'resume'].includes(name)) {
      if (action.version !== campaign.version || !checkedSaldo || actionForm.remainingBudgetMinor !== budget.remainingMinor) { setError('La evidencia de saldo cambió. Cierra el diálogo y vuelve a comprobar en Meta.'); return; }
      Object.assign(fields, { version: action.version, specHash: approved?.specHash, preparedRefs: delivery?.preparedRefs, investmentAccepted: actionForm.investmentAccepted, remainingBudgetMinor: actionForm.remainingBudgetMinor });
    }
    if (name === 'resume-restored') Object.assign(fields, { specHash: approved?.specHash || validation?.draftSpecHash || validation?.specHash, rightsAccepted: actionForm.rightsAccepted, acceptedWarnings: actionForm.acceptedWarnings, investmentAccepted: actionForm.investmentAccepted, remainingBudgetMinor: actionForm.remainingBudgetMinor, acceptDuplicateRisk: actionForm.acceptDuplicateRisk, acceptPrivateDraft: actionForm.acceptPrivateDraft });
    if (['link-remote', 'confirm-absent'].includes(name)) {
      const op = action.operation;
      Object.assign(fields, { operationId: op.id, ...(op.deliveryId ? { deliveryId: op.deliveryId } : {}), specHash: op.specHash || approved?.specHash, reason: actionForm.reason });
      if (name === 'link-remote') Object.assign(fields, { remoteId: actionForm.remoteId, permalink: actionForm.permalink, acceptContentVerification: actionForm.acceptContentVerification });
      else Object.assign(fields, { confirmAbsence: actionForm.confirmAbsence, acceptDuplicateRisk: actionForm.acceptDuplicateRisk });
    }
    await campaignAction(name, fields);
  }
  const field = (key, label, options = {}) => <Field field={{ name: key, label, ...options }} value={form[key]} onChange={value => key === 'mode' ? changeMode(value) : set(key, key === 'observationDays' ? Number(value) : value)}/>;
  const check = (label, value, change, disabled = false) => <label key={label} className={styles.checkRow}><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => change(event.target.checked)}/><span>{label}</span></label>;
  const amount = (key, label) => <Field key={`${key}:${connection?.currency || 'none'}`} field={{ name: key, label, type: 'moneyOptionalMinor', description: `Importe en ${connection?.currency || 'moneda de cuenta sin verificar'}. Punto para miles y coma para centavos. COP exige pesos enteros; USD permite centavos. No se redondea.` }} value={form[key]} onChange={value => set(key, key === 'budgetMinor' ? value ?? 0 : value)} onDraftInvalid={value => setInvalid(previous => ({ ...previous, [key]: value }))}/>;
  const dateInput = (key, label) => <label className="field">{label}<input name={key} type="datetime-local" aria-describedby={`${id}-${key}-help`} value={localDate(form[key])} onChange={event => { const value = event.target.value; set(key, value ? new Date(value).toISOString() : null); }}/><small id={`${id}-${key}-help`} className={styles.help}>{form[key] ? `En ${form.mode === 'paid' ? connection?.timeZone || 'zona de cuenta sin verificar' : 'America/Bogota'}: ${date(form[key], form.mode === 'paid' ? connection?.timeZone : 'America/Bogota')}. Bogotá: ${date(form[key], 'America/Bogota')}.` : 'Sin fecha registrada.'}</small></label>;
  const formLocked = busy || audienceBusy || loading || frozen || uncertain || preflightPending || assistant.assistantBusy;
  useEffect(() => {
    if (!focusSaveAfterSelection.current || composer || formLocked || !saveDraftRef.current) return;
    focusSaveAfterSelection.current = false;
    saveDraftRef.current.focus();
  }, [composer, formLocked]);
  const stepChange = (value, target = 'step') => { if (value !== step) focusTarget.current = target; setStep(value); setError(''); };
  function findRequirement(key) {
    return document.getElementById(`${id}-${key}`) || document.getElementById(`${id}-definition`)?.querySelector(`[name="${key}"]`);
  }
  function editRequirement(key) {
    if (key === 'settings') { goToConnection(); return; }
    if (key === 'connect') { goToConnection(null); return; }
    if (key === 'asset') setComposer(true);
    if (step === 0) findRequirement(key)?.focus();
    else stepChange(0, key);
  }
  function goToConnection(record = connection?.id || null) {
    callbacks.current.onNavigate?.({ section: 'business', tab: 'social', record });
  }
  const disclosure = asset?.aiDisclosure === true ? true : form.aiDisclosure;
  const disclosureIssue = (item, platforms) => Boolean(asset && unsupportedSocialDisclosure({ method: item?.integrationMethod, mode: form.mode, platforms, assetKind: asset.kind, disclosure }));
  const hasAsset = asset?.state === 'ready' && contextualMatch(asset);
  const missingPermissions = form.mode === 'paid' ? !connection?.capabilities?.adsPublish : form.platforms.filter(platform => !connection?.capabilities?.[platform === 'facebook' ? 'facebookPublish' : 'instagramPublish']).map(platform => NETWORKS[platform]).join(' e ');
  const accountIssue = !connection ? (connections.length ? 'Selecciona una cuenta de Facebook o Instagram.' : 'Todavía no hay cuentas conectadas.') :
    readOnlyConnection ? 'La cuenta elegida es de solo lectura. No puede publicar ni preparar anuncios.' :
    connection.state !== 'connected' || connection.revalidationRequired || connection.disconnectStatus ? 'La cuenta seleccionada no está lista para publicar. Comprueba su acceso y sus recursos.' :
    missingPermissions ? (form.mode === 'paid' ? 'La cuenta elegida no tiene permiso para preparar anuncios.' : `Falta permiso para publicar en: ${missingPermissions}.`) : null;
  const reviewIssues = !frozen && step === 1 ? [
    !form.name.trim() && ['Escribe un nombre para encontrar el borrador.', 'Editar nombre', 'name'],
    offerProblem && [offerProblem, 'Revisar oferta', 'offer'],
    form.offerRef?.gift && !form.offerRef.gift.condition.trim() && ['Indica qué compra da derecho al obsequio.', 'Escribir condición', 'giftCondition'],
    !form.marketCountries.length && ['Falta confirmar el mercado: elige al menos un país.', 'Elegir mercados', 'markets'],
    accountIssue && [accountIssue, connection ? 'Cambiar cuenta' : connections.length ? 'Elegir cuenta' : 'Conectar en Redes sociales', connections.length || connection ? 'connection' : 'connect'],
    !form.platforms.length && ['Elige Facebook, Instagram o ambas redes.', 'Elegir redes', 'networks'],
    !hasAsset && ['Selecciona una imagen o un video listo y que corresponda a esta publicación.', 'Abrir estudio visual', 'asset'],
    hasAsset && disclosureIssue(connection, form.platforms) && ['Esta conexión no puede verificar la etiqueta de IA para la pieza. Elige una conexión compatible o cambia el archivo; no retires la declaración.', 'Revisar compatibilidad de la cuenta', 'connection'],
    hasAsset && disclosure == null && ['Indica si la pieza contiene contenido generado con IA.', 'Declarar uso de IA', 'disclosure'],
    form.marketCountries.length > 0 && !coveredExactly && ['El público debe cubrir exactamente los países elegidos, sin incluir otros.', 'Revisar audiencia', 'audience'],
    hasAsset && (form.platforms.some(net => !form.placements.some(value => value.startsWith(`${net}_`))) ||
      form.placements.some(value => !socialPlacementMatches(value, asset.kind, form.mode))) && ['Elige un lugar compatible en cada red: por ejemplo, una foto en el Feed.', 'Elegir ubicaciones', 'placements'],
    form.mode === 'paid' && form.objective === 'traffic' && !form.destinationUrl && ['Añade el enlace al que llevará el anuncio.', 'Editar enlace', 'destinationUrl'],
    form.mode === 'paid' && form.objective === 'whatsapp' && !form.whatsappNumber && ['Escribe el número de WhatsApp vinculado a tu página.', 'Editar número', 'whatsappNumber'],
    form.mode === 'paid' && form.objective === 'whatsapp' && !form.whatsappGreeting.trim() && ['Escribe el mensaje de bienvenida de WhatsApp.', 'Editar bienvenida', 'whatsappGreeting'],
    form.mode === 'paid' && connection && (!['COP', 'USD'].includes(connection.currency) || !connection.timeZone) && ['Verifica la moneda y la zona horaria de la cuenta de anuncios.', 'Ir a la cuenta en Redes sociales', 'settings'],
    form.mode === 'paid' && (form.budgetMinor <= 0 || invalid.budgetMinor || connection?.currency === 'COP' && form.budgetMinor % 100 !== 0) && ['Escribe un presupuesto total válido, no diario.', 'Editar presupuesto', 'budgetMinor'],
    form.mode === 'paid' && (!form.startAt || Date.parse(form.startAt) <= Date.now()) && ['Elige una fecha de inicio futura.', 'Editar inicio', 'startAt'],
    form.mode === 'paid' && (!form.endAt || form.startAt && (Date.parse(form.endAt) <= Date.parse(form.startAt) || Date.parse(form.endAt) - Date.parse(form.startAt) > 90 * 86400000)) && ['Elige una fecha de fin posterior al inicio, dentro de 90 días.', 'Editar fin', 'endAt'],
    form.mode === 'organic' && form.publishAt && Date.parse(form.publishAt) <= Date.now() && ['Elige una fecha futura o déjala vacía para publicar sin programar.', 'Editar fecha de publicación', 'publishAt']
  ].filter(Boolean) : [];
  const reviewIssue = reviewIssues.length > 0;
  function blockAssistantInteraction(event) {
    if (!assistant.assistantBusy) return;
    event.preventDefault(); event.stopPropagation();
  }
  const offerSummary = displayedOffers.primary ? <><OfferSummary item={displayedOffers.primary}/><OfferSummary item={displayedOffers.gift} gift/></> : <p>Publicación de marca, sin producto.</p>;
  const declaration = <label className="field">¿La imagen o video contiene contenido generado con IA?<select id={`${id}-disclosure`} name="aiDisclosure" disabled={asset?.aiDisclosure === true} value={asset?.aiDisclosure === true ? 'true' : form.aiDisclosure === null ? '' : String(form.aiDisclosure)} onChange={event => set('aiDisclosure', event.target.value === '' ? null : event.target.value === 'true')}><option value="">Declara explícitamente</option><option value="false">No</option><option value="true">Sí; requiere divulgación verificable en la vía elegida</option></select></label>;
  const locations = networks => Object.entries(PLACEMENTS).filter(([key]) => networks.some(network => key.startsWith(`${network}_`)) &&
    (form.placements.includes(key) || socialPlacementMatches(key, asset?.kind, form.mode)))
    .map(([key, label]) => check(label, form.placements.includes(key), checked => set('placements', checked ? [...form.placements, key] : form.placements.filter(value => value !== key))));
  const imageChoices = <div className={styles.actions}><button id={`${id}-asset`} type="button" className="button subtle" disabled={formLocked} aria-expanded={composer} onClick={() => setComposer(value => !value)}>{composer ? 'Cerrar estudio visual' : 'Abrir estudio visual'}</button></div>;
  const imageComposer = composer && <AdvertisingGeneration api={api} campaignId={campaign?.id ?? null} campaignVersion={campaign?.version ?? null} threadId={openedStudio ?? studioId} baseAsset={asset}
    onThreadCreated={thread => { setOpenedStudio(thread.id); if (!campaign) onStudioThread?.(thread.id); }}
    assets={assets} active={step === 0 || Boolean(sameDraft)} instructions={imageInstructions} onInstructionsChange={setImageInstructions}
    contextDirty={Boolean(campaign && formDirty)} onRefreshContext={() => save()} onUseAsset={useImage}
    allowGeneration={!sameDraft} allowPublishAsset={item => contextualMatch(item) && (!sameDraft || item.kind === 'image' && !item.aiDisclosure)}
    onInteractionStateChange={onComposerState} onMutation={onMutation}/>;
  const sameOpen = sameDraft && !frozen && !sameDraft.operationId;
  if (campaign?.applicationMode === 'same') return <section className={styles.detail} aria-busy={busy}>
    <header className={styles.heading}><h2>Cambiar esta {campaign.mode === 'paid' ? 'campaña' : 'publicación'}</h2><button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ tab: 'results', record: campaign.parentCampaignId, resultsFocus: 'recommendations' })}>Volver a rendimiento</button></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {sameDraft && <><p>Solo cambia {sameDraft.variable === 'caption' ? 'el texto' : sameDraft.variable === 'asset' ? 'la imagen' : 'la ubicación'} en {sameDraft.channel === 'meta_ads' ? 'el mismo anuncio de Meta' : NETWORKS[sameDraft.channel] || sameDraft.channel}. Se conservan identidad, presupuesto y fechas; no se reactiva gasto.</p>
      {sameDraft.budget && <Values rows={[['Total original', money(sameDraft.budget.totalMinor ?? sameDraft.budget.budgetMinor, sameDraft.budget.currency)], ['Saldo verificado', money(sameDraft.budget.remainingMinor, sameDraft.budget.currency)], ['Fechas', `${date(sameDraft.budget.startAt)} – ${date(sameDraft.budget.endAt)}`]]}/>}
      <div className={styles.summaryGrid}><div className={styles.card}><h3>Actual</h3><p>{textValue(sameDraft.before)}</p></div><div className={styles.card}><h3>Propuesta guardada</h3><p>{textValue(sameDraft.after)}</p></div></div>
      {sameDraft.eligibility?.allowed === false && <p role="alert">{sameDraft.eligibility.reason || 'No se puede enviar este cambio con la evidencia actual.'}</p>}
      {sameDraft.operationId && <p role="status">Operación: {stateLabel(sameDraft.operationState)}. La propuesta solo se aplica cuando se comprueba en Meta.</p>}
      {sameOpen && <><form method="post" onSubmit={save} className={styles.stack}>
        {sameDraft.variable === 'caption' && field('caption', 'Texto propuesto', { type: 'textarea', max: 2200 })}
        {sameDraft.variable === 'asset' && <><p>Esta vía solo admite una foto propia lista y sin etiqueta de divulgación. Para probar una pieza generada, vuelve a la propuesta y elige crear una variante con una vía compatible.</p>{imageChoices}<AssetPreview key={asset?.id || 'none'} asset={asset}/>{declaration}</>}
        {sameDraft.variable === 'placement' ? <p>Solo se puede confirmar el subconjunto mostrado. No aumenta ni reemplaza el público.</p> : <button type="submit" className="button subtle" disabled={formLocked || !formDirty}>Guardar borrador de cambio</button>}
      </form>{imageComposer}<fieldset disabled={formLocked || formDirty || !sameDraft.eligibility?.allowed || !sameDraft.diffHash || sameDraft.unchanged}>
        <legend>Confirmar solo esta diferencia</legend>{check('Confirmo los derechos y la declaración de procedencia de la pieza.', rights, setRights)}
        {check('Revisé el antes y el después y autorizo exclusivamente este cambio, sin activar inversión.', recommendationAccepted, setRecommendationAccepted)}
        <button type="button" className="button primary" disabled={!rights || !recommendationAccepted} onClick={() => changeSameAction('confirm-in-place')}>Confirmar cambio en esta pieza</button>
      </fieldset><button type="button" className="button subtle" disabled={busy} onClick={() => changeSameAction('cancel-in-place')}>Cancelar borrador de cambio</button></>}
    </>}
  </section>;

  return <section className={styles.detail} aria-busy={busy || loading || assistant.assistantBusy} onClickCapture={blockAssistantInteraction} onChangeCapture={blockAssistantInteraction} onSubmitCapture={blockAssistantInteraction}>
    <fieldset className={`editor-fieldset ${styles.stack}`} disabled={assistant.assistantBusy}>
    <header className={styles.heading}><div><p className={styles.eyebrow}>{frozen ? 'Configuración aprobada · Solo lectura' : form.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'}</p><h2 ref={frozen ? heading : undefined} tabIndex={-1}>{campaign?.name || 'Nueva publicación'}</h2><span className={styles.badge}>{awaitingPublication ? 'Aprobada, pendiente de publicar' : stateLabel(campaign?.state || 'draft')}</span></div><div className={`${styles.actions} ${styles.editorTools}`}><button type="button" className="text-button" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'campaigns', record: null })}>Volver a publicaciones</button>{!frozen && <button type="button" className="text-button" disabled={assistant.assistantBusy || loading} onClick={assistant.openAssistant}>Ayúdame con este borrador</button>}</div></header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}<div className={styles.actions}>{existing && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => setRetry(value => value + 1)}>Recargar datos guardados</button>}<button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'business', tab: 'social', record: connection?.id || null })}>Revisar conexión</button></div>{formDirty && <p>Tus cambios locales se conservaron; no se reemplazan al actualizar.</p>}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {loading && <p role="status">{campaign ? 'Actualizando datos guardados…' : 'Cargando publicación…'}</p>}
    {hold && <p className={styles.warning}>Bloqueo de restauración: reconectar no autoriza reenvíos. Comprueba el estado en Meta sin reenviar y acepta explícitamente la recuperación. Restaurar la base de datos no detiene anuncios activos.</p>}
    {instruction && <aside className={styles.notice}><h3>Prueba propuesta para la próxima publicación</h3><p>{instruction.text}</p>{instruction.before != null && <p>Actual: {textValue(instruction.before)}</p>}{instruction.postingWindow && <p>Franja sugerida: {textValue(instruction.postingWindow)}. Elige tú una fecha; no se programa automáticamente.</p>}<p>Confirma un cambio real del tipo propuesto. La variante no transfiere comentarios, enlace ni métricas del original.</p></aside>}
    {!frozen && <nav aria-label="Pasos de preparación" className={styles.steps}>{STEPS.map((label, index) => <button type="button" key={label} className={`${styles.stepButton} ${step === index ? styles.stepActive : ''}`} aria-current={step === index ? 'step' : undefined} disabled={formLocked} onClick={() => stepChange(index)}>{index + 1}. {label}</button>)}</nav>}
    {!frozen && <div className={styles.stepIntro}><h3 id={`${id}-step`} ref={heading} tabIndex={-1}>Paso {step + 1} de 2 · {STEPS[step]}</h3><p>{INSTRUCTIONS[step]}</p></div>}

    {!frozen && <form method="post" onSubmit={save} className={styles.stack}>
      <fieldset disabled={formLocked} className="editor-fieldset" aria-labelledby={`${id}-step`}>
        {step === 0 && <div className={styles.stack} id={`${id}-definition`}>
          <fieldset><legend>Tipo de publicidad</legend><div className={styles.fieldGrid}>
            <label className={styles.checkRow}><input type="radio" name="mode" value="organic" checked={form.mode === 'organic'} onChange={() => changeMode('organic')}/><span><strong>Publicación sin inversión</strong><br/>Comparte en tus redes sin pagar por difusión.</span></label>
            <label className={styles.checkRow}><input type="radio" name="mode" value="paid" checked={form.mode === 'paid'} onChange={() => changeMode('paid')}/><span><strong>Anuncio pagado</strong><br/>Elige a quién llegar y cuánto invertir en total.</span></label>
          </div></fieldset>
          <label className="field">Objetivo comercial<select name="objective" aria-describedby={`${id}-objective-help`} value={form.objective} onChange={event => set('objective', event.target.value)}>{Object.entries(OBJECTIVES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><p id={`${id}-objective-help`} className={styles.help}>{OBJECTIVE_HELP[form.objective]}</p>
          <section className={`${styles.card} ${styles.stack}`} aria-labelledby={`${id}-offer`}>
            <h4 id={`${id}-offer`} tabIndex={-1}>Oferta</h4>{offerSummary}
            <div className={styles.actions}>
              <button type="button" className="button subtle" onClick={() => setOfferPicker(value => value === 'primary' ? null : 'primary')}>{form.offerRef ? 'Cambiar oferta' : 'Elegir oferta del catálogo'}</button>
              <button type="button" className="button subtle" aria-pressed={!form.offerRef} onClick={() => choosePrimary(null)}>Publicación de marca, sin producto</button>
              {form.offerRef && form.offerRef.primary.kind !== 'gift' && <button type="button" className="button subtle" onClick={() => setOfferPicker(value => value === 'gift' ? null : 'gift')}>{form.offerRef.gift ? 'Cambiar obsequio' : 'Añadir un obsequio'}</button>}
              {form.offerRef?.gift && <button type="button" className="button subtle" onClick={() => chooseGift(null)}>Quitar obsequio</button>}
            </div>
            {offerPicker && <AdvertisingOfferPicker key={offerPicker} api={api} giftOnly={offerPicker === 'gift'} selected={offerPicker === 'gift' ? offers?.gift : offers?.primary} onSelect={offerPicker === 'gift' ? chooseGift : choosePrimary} onClose={() => setOfferPicker(null)}/>}
            {form.offerRef?.gift && <label className="field">¿Para qué compra aplica el obsequio?<textarea name="giftCondition" value={form.offerRef.gift.condition} maxLength={500} onChange={event => { setRefreshedOffer(null); set('offerRef', { ...form.offerRef, gift: { ...form.offerRef.gift, condition: event.target.value } }); }}/><small className={styles.help}>Escribe la condición exacta. No se deducen descuentos, cantidades mínimas ni fechas.</small></label>}
            {offerProblem && <p role="alert">{offerProblem}</p>}
            {form.offerRef && <button type="button" className="button subtle" onClick={readLatestOffer}>Volver a leer la ficha</button>}
            {refreshedOffer && <section className={styles.card}><h4>Ficha actual del catálogo</h4><OfferSummary item={refreshedOffer.primary}/><OfferSummary item={refreshedOffer.gift} gift/><button type="button" className="button primary" onClick={acceptRefreshedOffer}>Aceptar la ficha actual</button></section>}
          </section>
          {learning?.idea?.text && <aside className={styles.notice}>
            <h4>Qué aprendimos de una oferta igual</h4>
            <p>{learning.conclusion === 'improved' ? 'El cambio anterior mejoró según el criterio de esa prueba.' : 'El cambio anterior no alcanzó el criterio de esa prueba.'}</p>
            {learning.period?.from && <p className={styles.help}>Período: {date(learning.period.from)}{learning.period.to && ` – ${date(learning.period.to)}`}</p>}
            <p>{learning.idea.text}</p>
            <div className={styles.actions}>
              <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ tab: 'results', record: learning.campaignId, resultsFocus: 'learnings' })}>Ver la prueba</button>
              <button type="button" className="button subtle" onClick={() => {
                const next = [imageInstructions, learning.idea.text].filter(Boolean).join('\n');
                if (next.length > 4000) { setError('Acorta las indicaciones para añadir la idea completa.'); return; }
                setImageInstructions(next); setComposer(true); setNotice('Se añadió una orientación editable; no se cambió el texto ni la configuración.');
              }}>Usar esta idea</button>
            </div>
          </aside>}
          {field('name', 'Nombre de la publicación', { required: true, max: 200, description: 'Nombre interno para encontrar el borrador después.' })}
          <section className={`${styles.card} ${styles.stack}`} aria-label="Cuenta y redes"><h4>Cuenta y redes</h4>
            <label className="field">Cuenta conectada<select id={`${id}-connection`} name="connectionId" value={form.connectionId || ''} onChange={event => selectConnection(event.target.value)}><option value="">Selecciona una cuenta conectada</option>{connections.map(item => <option key={item.id} value={item.id} disabled={item.id !== form.connectionId && disclosureIssue(item, form.platforms)}>{item.name || 'Cuenta Meta'} · {METHODS[item.integrationMethod] || item.integrationMethod} · {CONNECTION_STATES[item.state] || item.state}{disclosureIssue(item, form.platforms) ? ' · No verifica la etiqueta de IA' : ''}</option>)}{form.connectionId && !connections.some(item => item.id === form.connectionId) && <option value={form.connectionId}>Cuenta guardada · revisar disponibilidad</option>}</select></label>
            <fieldset><legend>Redes donde saldrá</legend><div id={`${id}-networks`} tabIndex={-1}>{Object.keys(NETWORKS).map(network => {
              const unsupported = Boolean(connection && disclosureIssue(connection, [network]));
              return check(`${NETWORKS[network]}${networkName(network, connection) ? ` · ${networkName(network, connection)}` : ''}${unsupported ? ' · No verifica la etiqueta de IA' : ''}`, form.platforms.includes(network), enabled => changePlatforms(enabled ? [...form.platforms, network] : form.platforms.filter(value => value !== network)), unsupported && !form.platforms.includes(network));
            })}</div></fieldset>
            {accountIssue && <p className={styles.warning}>{accountIssue}</p>}
            <p className={styles.help}>Si sales a Redes sociales, guarda primero los cambios que quieras conservar. No se cambiará de cuenta ni de método automáticamente.</p>
            <div className={styles.actions}>
              <button type="button" className="button subtle" onClick={() => goToConnection()}>{connection ? 'Revisar esta cuenta en Redes sociales' : 'Conectar cuenta en Redes sociales'}</button>
            </div>
          </section>
          <MarketPicker value={form.marketCountries} onChange={changeMarkets} paid={form.mode === 'paid'} historical={Boolean(campaign && !Object.hasOwn(campaign, 'marketCountries'))} inputId={`${id}-markets`}/>
          <p><strong>{OBJECTIVES[form.objective]}</strong> · {CALLS_TO_ACTION[form.objective]}</p>
          {asset && <><h4>Pieza elegida</h4><AssetPreview key={asset.id} asset={asset}/>{!contextualMatch(asset) && <p role="alert">Esta imagen corresponde a otra oferta u objetivo. Cambia el archivo.</p>}</>}
          {asset && form.offerRef && !asset.alignment && <p className={styles.warning}>Esta pieza se preparó sin la ficha de la oferta. Comprueba que represente el producto, su presentación y el obsequio correctos; puedes ajustarla con los datos vigentes desde el estudio.</p>}
          {imageChoices}
          {field('caption', 'Texto que acompaña la imagen o video', { type: 'textarea', max: 2200 })}{field('headline', 'Título o llamada a la acción', { max: 40, description: 'Ejemplo ficticio: Conoce más' })}
          <details className={styles.technicalDetails}><summary>Requisitos del archivo</summary><p>Fotos fijas JPEG/PNG/WebP hasta 10 MiB, proporción 4:5 a 1,91:1 y ancho mínimo 320 px. Videos MP4/MOV hasta 250 MiB, verticales 9:16, mínimo 540×960 y duración de 3–90 segundos. Subir y normalizar un archivo no solicita una imagen nueva.</p></details>
          {form.objective === 'traffic' && field('destinationUrl', 'URL de destino', { type: 'url', max: 2048 })}
          {form.objective === 'whatsapp' && <>{field('whatsappNumber', form.mode === 'paid' ? 'WhatsApp vinculado a la página (formato internacional +)' : 'Número de WhatsApp para el texto (opcional)', { max: 16 })}{form.mode === 'paid' && <>{field('whatsappGreeting', 'Bienvenida explícita de WhatsApp', { type: 'textarea', max: 1024 })}<p>El número debe coincidir con el recurso verificado en Meta.</p></>}</>}
          {imageInstructions && !composer && <label className="field">Orientación editable para la próxima imagen<textarea maxLength={4000} value={imageInstructions} onChange={event => setImageInstructions(event.target.value)}/></label>}
          {form.mode === 'organic' && form.platforms.includes('instagram') && ['traffic', 'whatsapp'].includes(form.objective) && <p className={styles.warning}>En Instagram sin inversión, los enlaces del texto no son llamadas a la acción clicables. No se promete medir consultas o tráfico por publicación.</p>}
          {form.platforms.length > 0 && <fieldset id={`${id}-placements`} tabIndex={-1}><legend>Ubicaciones</legend>{locations(form.platforms)}<p className={styles.help}>Fotos en Feed y videos orgánicos en Reels.</p></fieldset>}
          {declaration}
          {form.mode === 'paid' && form.marketCountries.length > 0 && <section className={`${styles.card} ${styles.stack}`} id={`${id}-audience`} tabIndex={-1} aria-label="Audiencia de la campaña">
            <h4>¿Cómo quieres definir la audiencia?</h4>
            {campaign?.audienceMode && <p>Audiencia guardada: {AUDIENCE_SOURCE[campaign.audienceMode]}{formDirty ? ' · cambios locales aún no guardados' : ''}.</p>}
            <div className={styles.actions}>{[['automatic', 'Definir con IA'], ['manual', 'Definir yo'], ['broad', 'Sin personalizar']].map(([value, label]) => <button type="button" className="button subtle" key={value} aria-pressed={audienceMode === value} onClick={() => setAudienceChoice(value)}>{label}</button>)}</div>
            {outsideMarket.length > 0 && <p className={styles.warning}>Quita o corrige las referencias fuera del mercado: {outsideMarket.map(countryLabel).join(', ')}. No se descartaron ni ampliaron automáticamente.</p>}
            {missingMarket.length > 0 && <p className={styles.help}>Falta cubrir: {missingMarket.map(countryLabel).join(', ')}.</p>}
          </section>}
          {form.mode === 'paid' && form.marketCountries.length > 0 && audienceMode === 'manual' && <details className={styles.technicalDetails} open><summary>Segmentación manual</summary>
            <p>Mayores de 18 años. Sin datos de clientes, públicos personalizados ni condiciones de salud. No superpongas país completo con sus regiones/ciudades ni una región con sus ciudades.</p>
            <label className="field">País completo<select name="country" value={country} onChange={event => setCountry(event.target.value)}><option value="">Selecciona un país del mercado</option>{form.marketCountries.map(code => <option key={code} value={code}>{countryLabel(code)}</option>)}</select></label><button type="button" className="button subtle" disabled={!country} onClick={addCountry}>Añadir país completo</button>
            <ul>{form.audience.countries.map(code => <li key={code}>{countryLabel(code)} <button type="button" className="text-button" onClick={() => setAudience('countries', form.audience.countries.filter(value => value !== code))}>Quitar país {code}</button></li>)}</ul>
            <div className={styles.fieldGrid}><Field field={{ name: 'ageMin', label: 'Edad mínima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMin} onChange={value => setAudience('ageMin', value)}/><Field field={{ name: 'ageMax', label: 'Edad máxima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMax} onChange={value => setAudience('ageMax', value)}/></div>
            <fieldset><legend>Géneros (ninguno seleccionado = todos)</legend>{[[1, 'Hombres'], [2, 'Mujeres']].map(([value, label]) => check(label, form.audience.genders.includes(value), checked => setAudience('genders', checked ? [...form.audience.genders, value] : form.audience.genders.filter(item => item !== value))))}</fieldset>
            {['regions', 'cities', 'interests'].map(group => <section key={group}><h4>{{ regions: 'Regiones verificadas', cities: 'Ciudades y radio explícito', interests: 'Intereses verificados' }[group]}</h4>{!form.audience[group].length && <p className={styles.muted}>Sin selección.</p>}{form.audience[group].map(ref => <div className={styles.card} key={ref.key}><p>{ref.label} · {ref.context.countryCode || ref.context.scope || ref.context.path?.join(' / ')} · {ref.context.region || ''}</p>{group === 'cities' && <div className={styles.fieldGrid}><label className="field">Radio explícito<input type="number" min={ref.context.distanceUnit === 'mile' ? 10 : 17} max={ref.context.distanceUnit === 'mile' ? 50 : 80} step="1" value={ref.context.radius ?? ''} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, radius: event.target.value === '' ? undefined : Number(event.target.value), distanceUnit: item.context.distanceUnit || 'kilometer' } } : item))}/></label><label className="field">Unidad<select value={ref.context.distanceUnit || 'kilometer'} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, distanceUnit: event.target.value, radius: undefined } } : item))}><option value="kilometer">Kilómetros (17–80)</option><option value="mile">Millas (10–50)</option></select></label></div>}<button type="button" className="text-button" onClick={() => setAudience(group, form.audience[group].filter(item => item.key !== ref.key))}>Quitar {ref.label}</button></div>)}</section>)}
            <p className={styles.help}>Busca y selecciona referencias oficiales debajo de este formulario. Un nombre escrito no se convierte en ID. Los candidatos nativos quedan ligados al negocio y deben coincidir inequívocamente al reabrir.</p>
          </details>}
          <p className={styles.help}>Introduce las horas en la zona de tu dispositivo ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Debajo de cada fecha verás su equivalente en Bogotá y, si es un anuncio pagado, en la zona de la cuenta.</p>
          {form.mode === 'paid' ? <>
            <Values rows={[["Moneda de la cuenta", connection?.currency || 'Selecciona una cuenta con moneda verificada'], ['Zona horaria de la cuenta', connection?.timeZone || 'Sin verificar']]}/>
            <div className={styles.fieldGrid}>{amount('budgetMinor', 'Presupuesto total (no diario)')}{dateInput('startAt', 'Inicio (hora del dispositivo)')}{dateInput('endAt', 'Fin (hora del dispositivo)')}</div>
            <details className={styles.technicalDetails} open={form.targetCostMinor != null || Boolean(invalid.targetCostMinor)}><summary>Opciones de inversión</summary>{amount('targetCostMinor', 'Meta opcional de costo por resultado (del usuario)')}</details>
            <p>Un conjunto y un anuncio comparten un único total, incluso con dos redes. Inicio futuro, fin posterior, máximo 90 días. No se acepta presupuesto diario abierto. Impuestos/cargos pueden ser adicionales.</p>
            {connection?.currency === 'COP' && form.budgetMinor % 100 !== 0 && <p role="alert" className={styles.error}>COP exige un total de pesos enteros representable por Meta. Corrige los centavos; no se redondeará.</p>}
            <p className={styles.help}>Guardar y preparar no activan anuncios pagados. La activación y cada reanudación requieren una aceptación separada del restante real y las fechas originales.</p>
          </> : <>{dateInput('publishAt', 'Publicación programada opcional (hora del dispositivo)')}<p>Aprobar no publica ni programa entregas. Si después autorizas publicar, se usará la fecha elegida o, si está vacía, se enviará cuando se procese en segundo plano. La agenda no garantiza una ejecución puntual.</p><details className={styles.technicalDetails}><summary>Opciones de seguimiento</summary>{field('observationDays', 'Horizonte de observación', { type: 'select', options: [7, 14, 28].map(value => ({ value, label: `${value} días` })) })}<p>Es el tiempo para observar resultados. No borra la publicación ni garantiza entrega.</p></details></>}
        </div>}
        {step === 1 && <div className={styles.stack}>
          {reviewIssue ? <section className={`${styles.warning} ${styles.stack}`} aria-labelledby={`${id}-review-issues`}>
            <h4 id={`${id}-review-issues`}>Qué falta antes de aprobar</h4>
            <p>Puedes resolverlo ahora o guardar un borrador y continuar después.</p>
            <ul className={styles.requirements}>{reviewIssues.map(([reason, label, key]) => <li key={label}><span>{reason}</span><button type="button" className="text-button" onClick={() => editRequirement(key)}>{label}</button></li>)}</ul>
          </section> : validation?.errors?.length > 0 && !formDirty && <div className={styles.warning}><h4>Qué falta en el borrador guardado</h4><ul>{validation.errors.map((item, index) => <li key={index}>{errorText(item)}</li>)}</ul><button type="button" className="button subtle" onClick={() => stepChange(0)}>Editar definición</button></div>}
          <h4>Vista previa de la pieza y la oferta</h4>{offerSummary}
          {!form.platforms.length && <p className={styles.warning}>Por comprobar: elige la cuenta y la red o redes de destino.</p>}
          <div className={styles.summaryGrid}>{form.platforms.map(network => {
            const placed = form.placements.filter(key => key.startsWith(`${network}_`)), issue = destinationIssue(connection, form.mode, network, asset, disclosure, placed);
            return <article className={styles.card} key={network}><h5>{NETWORKS[network]} · {networkName(network, connection) || 'Sin nombre verificado'}</h5>
              <p>{issue || 'Disponible para revisión'}</p><p className={styles.help}>Vista orientativa · {placed.map(key => PLACEMENTS[key]).join(', ') || 'Sin ubicación'} · {CALLS_TO_ACTION[form.objective]}</p>
              <AssetPreview key={`${network}:${asset?.id || 'none'}`} asset={asset}/><p>{form.caption || 'Texto pendiente'}</p>
            </article>;
          })}</div>
          <details className={styles.technicalDetails} open={!reviewIssue}><summary>Configuración que vas a revisar · {formDirty ? 'Cambios sin guardar' : 'Guardada'}</summary><Configuration spec={spec} connection={connection} asset={asset}/></details>
        </div>}
      </fieldset>
      <div className={styles.actions}>{step === 0 && <button type="button" className="button primary" disabled={formLocked} onClick={() => stepChange(1)}>Continuar a revisión</button>}<button ref={saveDraftRef} type="submit" className={step === 1 && reviewIssue ? 'button primary' : 'button subtle'} disabled={formLocked || !form.name.trim()}>Guardar borrador</button>{step > 0 && <button type="button" className="button subtle" disabled={formLocked} onClick={() => stepChange(0)}>Editar definición</button>}</div>
      <p className={styles.help}>Guardar borrador no publica ni autoriza gasto.</p>
    </form>}
    {!frozen && imageComposer}

    {!frozen && form.mode === 'paid' && form.marketCountries.length > 0 && step === 0 && audienceMode === 'manual' && <section className={styles.panel}><h3>Búsqueda oficial de audiencia</h3>
      {connection?.integrationMethod === 'browser' && <p>Primero prepara un borrador privado en Meta; la búsqueda no usa Graph API ni publica.</p>}
      <form method="post" onSubmit={searchAudience} className={styles.stack}><fieldset disabled={formLocked || !connection}><legend>Búsqueda oficial</legend><div className={styles.fieldGrid}><label className="field">Tipo<select name="kind" value={searchKind} onChange={event => { setSearchKind(event.target.value); setCandidates([]); }}><option value="location">Región o ciudad</option><option value="interest">Interés</option></select></label><label className="field">Buscar por nombre<input name="q" type="search" maxLength={100} minLength={2} value={search} onChange={event => setSearch(event.target.value)}/></label></div><button type="submit" className="button subtle" disabled={search.trim().length < 2 || connection?.integrationMethod === 'browser' && !campaign?.preflight?.remoteDraftRef}>Buscar candidatos verificados</button></fieldset></form>
      <ul className={styles.choiceList}>{candidates.map(ref => <li key={ref.key}><span>{ref.label} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} · {ref.context?.region || ''}</span><button type="button" className="button subtle" disabled={formLocked || Boolean(ref.context?.countryCode && !form.marketCountries.includes(ref.context.countryCode))} onClick={() => addReference(ref)}>Seleccionar {ref.label}</button></li>)}</ul>
    </section>}
    {!frozen && step === 0 && form.mode === 'paid' && form.marketCountries.length > 0 && audienceMode && <section className={styles.panel}>
      {audienceMode === 'manual' && !coveredExactly ? <p>Completa la cobertura exacta de tus mercados antes de pedir recomendaciones.</p> :
        <AudienceAssistant key={audienceMode} api={api} campaign={campaign} mode={audienceMode} editPending={formDirty || Boolean(threadSelection)} disabled={formLocked}
          onSave={() => save()} onApplied={refreshAudience} onBusy={setAudienceBusy}/>}
    </section>}

    {!frozen && connection?.integrationMethod === 'browser' && form.mode === 'paid' && form.marketCountries.length > 0 && (step === 1 || audienceMode === 'manual') && <section className={styles.panel}>
      <h3>Preparación privada en Meta · acceso asistido por navegador</h3><p>Puede guardar un borrador privado en Meta sin publicar ni activar inversión. Cualquier edición invalida el resumen efectivo anterior.</p>
      {publicationSettingsIssue && (campaign?.preflight?.kind !== 'validate' || formDirty) && <div className={styles.warning}><p>{publicationSettingsIssue}</p><button type="button" className="button subtle" onClick={() => goToConnection(null)}>Abrir opciones de Meta en Redes sociales</button></div>}
      {!campaign?.preflight?.remoteDraftRef && check('Acepto crear un borrador privado recuperable, sin publicación ni gasto.', privateConsent, setPrivateConsent, busy)}
      <div className={styles.actions}>{!campaign?.preflight?.remoteDraftRef ? <button type="button" className={step === 1 && !reviewIssue ? 'button primary' : 'button subtle'} disabled={formLocked || hold || Boolean(publicationSettingsIssue) || !privateConsent || !form.name.trim()} onClick={() => preflight('prepare')}>Guardar y preparar borrador privado</button> : step === 1 && (campaign?.preflight?.kind !== 'validate' || formDirty) && <button type="button" className="button primary" disabled={formLocked || hold || Boolean(publicationSettingsIssue) || reviewIssue} onClick={() => preflight('validate')}>Guardar y validar el mismo borrador</button>}</div>
      {campaign?.preflight?.remoteDraftRef && <details className={styles.technicalDetails}><summary>Detalles del borrador privado</summary><p>Referencia recuperable: {campaign.preflight.remoteDraftRef} · {campaign.preflight.adapterVersion} · comprobada {date(campaign.preflight.checkedAt)}.</p></details>}
      {campaign?.preflight?.observedSpec && <details><summary>Resumen efectivo leído en Meta antes de aprobar</summary><Configuration spec={campaign.preflight.observedSpec} connection={connection} asset={asset}/></details>}
      {campaign?.preflight?.kind === 'validate' && <p className={styles.notice}>La validación conserva la misma configuración e imagen. Es un borrador, no un anuncio activo.</p>}
    </section>}

    {!frozen && step === 1 && !reviewIssue && (form.mode !== 'paid' || connection?.integrationMethod !== 'browser' || campaign?.preflight?.kind === 'validate' && !formDirty) && <section className={styles.stack} aria-labelledby={`${id}-forecast`}>
      <h3 id={`${id}-forecast`}>Consulta una estimación</h3>
      <form method="post" onSubmit={event => { event.preventDefault(); void estimate(); }} className={styles.panel}>
        <fieldset disabled={busy || loading || preflightPending || uncertain || hold}><legend>Estimación para la configuración guardada</legend>
          <details className={styles.technicalDetails} open={manualEnabled}><summary>Agregar mi propia hipótesis</summary>
            {check('Quiero incluir mi hipótesis opcional; no es una predicción del sistema.', manualEnabled, setManualEnabled)}
            <fieldset disabled={!manualEnabled}><legend>Mi hipótesis para esta estimación</legend><div className={styles.fieldGrid}>
              <label className="field">Métrica primaria<select name="manualMetric" value={manual.metric} onChange={event => setManual(previous => ({ ...previous, metric: event.target.value }))}><option value="">Selecciona una métrica compatible</option>{manualMetrics.map(key => <option key={key} value={key}>{key.includes('.') ? `${key.split('.')[0]} · ` : ''}{METRICS[key.split('.').at(-1)]}</option>)}</select></label>
              <label className="field">Límite inferior<input name="manualLower" type="number" min="0" step="any" value={manual.lower} onChange={event => setManual(previous => ({ ...previous, lower: event.target.value }))}/></label>
              <label className="field">Límite superior<input name="manualUpper" type="number" min="0" step="any" value={manual.upper} onChange={event => setManual(previous => ({ ...previous, upper: event.target.value }))}/></label>
              <label className="field">Fundamento explícito<textarea name="manualBasis" maxLength={2000} value={manual.basis} onChange={event => setManual(previous => ({ ...previous, basis: event.target.value }))}/></label>
              {!manualMetrics.length && <p>No hay una métrica primaria automática compatible con este objetivo sin inversión.</p>}
            </div></fieldset>
          </details>
          <button type="submit" className={hasCurrentForecast ? 'button subtle' : 'button primary'} disabled={!form.name.trim()}>{hasCurrentForecast ? 'Actualizar estimación' : 'Guardar y obtener estimación'}</button>
        </fieldset>
      </form>
      <Forecast forecast={formDirty ? null : forecast}/>
      {hasCurrentForecast && <section className={styles.panel}><h3>Decide si lo apruebas</h3>
        {!canWriteConnection && <p className={styles.warning}>Aprobación no disponible: selecciona una conexión activa con capacidades de publicación acreditadas. Un token manual es de solo lectura.</p>}
        {form.mode === 'paid' && publicationSettingsIssue && <div className={styles.warning}><p>{publicationSettingsIssue}</p><button type="button" className="button subtle" onClick={() => goToConnection(null)}>Abrir opciones de Meta en Redes sociales</button></div>}
        <p className={styles.notice}>{form.mode === 'paid' ? 'Esta aprobación solo prepara el anuncio. Activar gasto requiere otra confirmación.' : 'Esta aprobación congela la revisión sin publicar ni encolar entregas. Publicar requiere una confirmación aparte en Administrar publicación.'}</p>
        <fieldset disabled={!canWriteConnection || (form.mode === 'paid' && Boolean(publicationSettingsIssue)) || busy || formDirty || !forecast?.id || !validation?.valid || hold || preflightPending || uncertain}><legend>Autorización de la revisión</legend>
          {check('Confirmo derechos sobre la imagen o video y su audio, y que revisé el archivo preparado para publicar (derivado).', rights, setRights)}
          {warningList.map(item => <div key={item.key}>{check(item.message, warningsAccepted.includes(item.key), checked => setWarningsAccepted(previous => checked ? [...previous, item.key] : previous.filter(key => key !== item.key)))}</div>)}
          {instruction?.needsConfirmation && check('Aporté o edité el cambio solicitado, revisé la instrucción de la recomendación y acepto esta prueba sin aumentar el presupuesto.', recommendationAccepted, setRecommendationAccepted)}
          {form.mode === 'paid' && check(`Confirmo ${money(form.budgetMinor, connection?.currency)} como presupuesto TOTAL y las fechas mostradas. Sólo autorizo preparar, NO activar gasto.`, investment, setInvestment)}
          <details className={styles.technicalDetails}><summary>Identificadores de la autorización exacta</summary><p>Especificación: {forecast?.specHash || 'Primero obtén una estimación'} · estimación: {forecast?.id || 'Sin estimación'}.</p></details>
          <button type="button" className="button primary" disabled={!rights || warningList.some(item => !warningsAccepted.includes(item.key)) || form.mode === 'paid' && !investment || instruction?.needsConfirmation && !recommendationAccepted || connection?.integrationMethod === 'browser' && form.mode === 'paid' && campaign?.preflight?.kind !== 'validate'} onClick={approve}>{form.mode === 'paid' ? 'Preparar sin activar' : 'Aprobar sin publicar'}</button>
        </fieldset>
        {!validation?.valid && <p className={styles.help}>Completa los requisitos de validación del servidor antes de aprobar; guardar un borrador incompleto sigue disponible.</p>}
      </section>}
    </section>}

    {frozen && <section className={styles.panel}><h3>Configuración aprobada · Solo lectura</h3><p>Versión aprobada {approved?.revision}. El método y esta revisión no se editan.</p><OfferSummary item={approved?.offerSnapshot?.primary}/><OfferSummary item={approved?.offerSnapshot?.gift} gift/><Configuration spec={spec} connection={campaign.connection} asset={campaign.asset}/><AssetPreview key={campaign.asset?.id || 'none'} asset={campaign.asset} historical/><details><summary>Estimación conservada al aprobar</summary><Forecast forecast={approved?.forecast}/></details></section>}

    {campaign && <section className={styles.panel}><h3>Administrar publicación</h3>
      {campaign.mode === 'paid' && campaign.state === 'ready' && <p className={styles.notice}>{connection?.integrationMethod === 'browser' ? 'Borrador privado de Meta sin entrega.' : 'Objetos preparados en pausa, sin gasto autorizado.'} Preparada no significa activa; falta autorización expresa.</p>}
      {awaitingPublication && <p className={styles.notice}>Sin entregas. {hold ? 'La revisión restaurada no se puede reanudar. Duplica, vuelve a validar y aprueba el nuevo borrador.' : expiredPublication ? 'La fecha aprobada ya pasó. Duplica el borrador, reprograma y vuelve a aprobar.' : canPublish ? 'Publicar requiere autorizar el envío de esta revisión.' : publicationSettingsIssue || accountIssue || 'Para publicar, verifica el acceso a la cuenta y que la pieza siga correspondiendo a la revisión aprobada.'}</p>}
      {paidAwaiting && publicationSettingsIssue && <p className={styles.warning}>{publicationSettingsIssue} La inversión no está autorizada.</p>}
      {hold && frozen && withoutDeliveries && !awaitingPublication && <p className={styles.warning}>No hay un envío que reanudar. Duplica, vuelve a validar y aprueba el nuevo borrador.</p>}
      {!action && <div className={styles.actions}>
        {needsReconcile ? <button ref={nextRef} type="button" className="button primary" disabled={busy || formDirty || !connection} onClick={() => campaignAction('reconcile')}>Comprobar en Meta sin reenviar</button>
          : canPublish ? <button ref={nextRef} type="button" className="button primary" disabled={busy || loading} onClick={() => openAction('publish-organic')}>{publishLabel}</button>
          : activationAllowed ? <button ref={nextRef} type="button" className="button primary" disabled={busy || loading} onClick={() => openAction('activate-paid')}>Autorizar inversión</button>
          : confirmedResults ? <button ref={nextRef} type="button" className="button primary" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'results', record: campaign.id })}>Ver resultados</button>
          : (awaitingPublication && !hold && !expiredPublication || paidAwaiting && publicationSettingsIssue) ? <button ref={nextRef} type="button" className="button primary" onClick={() => publicationSettingsIssue ? goToConnection(null) : goToConnection()}>{publicationSettingsIssue ? 'Abrir opciones de Meta en Redes sociales' : 'Verificar conexión'}</button> : null}
      </div>}
      <div className={styles.actions}>
        <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('duplicate')}>Duplicar en nuevo borrador</button>
        {needsReconcile && confirmedResults && <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'results', record: campaign.id })}>Ver resultados</button>}
        {!needsReconcile && campaign.deliveries?.length > 0 && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile')}>Comprobar en Meta sin reenviar</button>}
        {!['cancelled', 'completed'].includes(campaign.state) && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('cancel')}>Cancelar trabajo / detener anuncios</button>}
        {campaign.mode === 'paid' && campaign.deliveries?.some(item => item.remoteId || item.remoteRefs?.campaignId) && <button type="button" className="button subtle" disabled={busy || readOnlyConnection || connection?.state !== 'connected'} onClick={() => openAction('pause')}>Pausar para detener gasto</button>}
        <fieldset disabled={!canWriteConnection} className={styles.connectionFieldset}><legend>Acciones con permisos de escritura</legend>
        {campaign.state === 'paused' && campaign.mode === 'paid' && <button type="button" className="button subtle" disabled={busy || hold || !checkedSaldo} onClick={() => openAction('resume')}>Revisar y autorizar reanudación</button>}
        {hold && !(frozen && withoutDeliveries) && <button type="button" className="button subtle" disabled={busy || formDirty || uncertain} onClick={() => openAction('resume-restored')}>Revisar recuperación explícita</button>}
        </fieldset>
      </div>
      <p className={styles.help}>Sin acceso vigente no se puede afirmar pausa: detén los anuncios directamente en Meta. La pausa segura no depende de una imagen o video disponible ni de habilitar nuevas publicaciones.</p>
    </section>}

    {action && <section className={styles.panel} role="dialog" aria-labelledby={`${id}-action-title`}><h3 id={`${id}-action-title`} ref={actionHeading} tabIndex={-1}>{{ 'publish-organic': `${publishLabel} revisión aprobada`, 'activate-paid': 'Autorizar inversión', resume: 'Autorizar reanudación', pause: 'Solicitar pausa remota', cancel: 'Cancelar trabajo o pausar anuncios emitidos', 'resume-restored': 'Comprobar estado en Meta y aceptar recuperación', 'link-remote': 'Vincular un objeto remoto existente', 'confirm-absent': 'Confirmar ausencia y riesgo antes de reintentar' }[action.name]}</h3><form method="post" onSubmit={submitAction}><fieldset disabled={busy}><legend>Confirmación explícita de la acción</legend>
      {action.name === 'publish-organic' && <><Configuration spec={action.approved.spec} connection={action.connection} asset={action.asset}/><AssetPreview asset={action.asset} historical/>{check('Confirmo que quiero publicar esta revisión en los destinos y con el horario indicados.', actionForm.publishAccepted, value => setActionForm(previous => ({ ...previous, publishAccepted: value })))}</>}
      {['activate-paid', 'resume', 'resume-restored'].includes(action.name) && <>
        <Values rows={[['Total original', money(spec.budgetMinor, spec.currency)], ['Desde', date(spec.startAt, spec.timeZone)], ['Hasta', date(spec.endAt, spec.timeZone)], ['Zona de cuenta', spec.timeZone]]}/>
        {campaign.mode === 'paid' && <>
          <Values rows={[['Presupuesto restante verificado en Meta', money(actionForm.remainingBudgetMinor, spec.currency)], ['Lectura presupuestaria', date(budget?.checkedAt, spec.timeZone)]]}/>
          {!Number.isSafeInteger(actionForm.remainingBudgetMinor) && <p>Antes de reanudar una entrega con gasto, comprueba su saldo en Meta sin reenviar.</p>}
          {check('Acepto expresamente el presupuesto restante indicado, la moneda y las fechas originales, sin aumentar total ni extender fin.', actionForm.investmentAccepted, value => setActionForm(previous => ({ ...previous, investmentAccepted: value })))}
        </>}
        <p>La solicitud solo encola una operación. Meta todavía debe confirmar la activación o reanudación.</p>
      </>}
      {action.name === 'resume-restored' && <>{check('Confirmo los derechos actuales sobre la imagen o video y su audio, y la revisión recuperada.', actionForm.rightsAccepted, value => setActionForm(previous => ({ ...previous, rightsAccepted: value })))}{(approved?.acceptedWarnings || []).map(key => <div key={key}>{check(warningList.find(item => item.key === key)?.message || key, actionForm.acceptedWarnings?.includes(key), value => setActionForm(previous => ({ ...previous, acceptedWarnings: value ? [...previous.acceptedWarnings, key] : previous.acceptedWarnings.filter(item => item !== key) })))}</div>)}{check('Acepto el riesgo de duplicación sólo para entregas sin ID remoto verificable. Las operaciones inciertas deben resolverse antes.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}{connection?.integrationMethod === 'browser' && campaign.mode === 'paid' && !approved && check('Acepto volver a preparar el borrador privado sin gasto; deberá aprobarse de nuevo antes de publicar.', actionForm.acceptPrivateDraft, value => setActionForm(previous => ({ ...previous, acceptPrivateDraft: value })))}</>}
      {['link-remote', 'confirm-absent'].includes(action.name) && <><p>Operación {action.operation.id} · {action.operation.step}. No se identifica una publicación sólo por texto/fecha.</p>{action.name === 'link-remote' ? <><Field field={{ name: 'remoteId', label: 'ID remoto existente', max: 100 }} value={actionForm.remoteId} onChange={value => setActionForm(previous => ({ ...previous, remoteId: value }))}/><Field field={{ name: 'permalink', label: 'Enlace permanente existente', type: 'url', max: 2048 }} value={actionForm.permalink} onChange={value => setActionForm(previous => ({ ...previous, permalink: value }))}/>{check('Verifiqué la cuenta, imagen o video, texto y contenido del objeto indicado; autorizo su comprobación remota.', actionForm.acceptContentVerification, value => setActionForm(previous => ({ ...previous, acceptContentVerification: value })))}</> : <>{check('Comprobé expresamente que el efecto remoto está ausente.', actionForm.confirmAbsence, value => setActionForm(previous => ({ ...previous, confirmAbsence: value })))}{check('Acepto el riesgo de duplicación al reintentar; Meta no garantiza ejecutar una sola vez.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}</>}</>}
      {['pause', 'cancel', 'link-remote', 'confirm-absent'].includes(action.name) && <Field field={{ name: 'reason', label: 'Motivo de la acción', type: 'textarea', max: 1000, required: ['link-remote', 'confirm-absent'].includes(action.name) }} value={actionForm.reason} onChange={value => setActionForm(previous => ({ ...previous, reason: value }))}/>}
      {action.name === 'cancel' && <p>Cancelar una agenda no enviada es local. Un anuncio emitido requiere pausa remota confirmada. El contenido publicado y su evidencia no se borran; un borrador privado en Meta puede permanecer sin ejecutor.</p>}
      <div className={styles.actions}><button type="submit" className="button primary" disabled={action.name === 'publish-organic' && (!actionForm.publishAccepted || !canPublish || loading || action.version !== campaign.version) || ['activate-paid', 'resume'].includes(action.name) && (!actionForm.investmentAccepted || !Number.isSafeInteger(actionForm.remainingBudgetMinor)) || action.name === 'resume-restored' && (!actionForm.rightsAccepted || (approved?.acceptedWarnings || []).some(key => !actionForm.acceptedWarnings?.includes(key)) || campaign.mode === 'paid' && approved && !actionForm.investmentAccepted) || action.name === 'link-remote' && (!actionForm.acceptContentVerification || !actionForm.remoteId && !actionForm.permalink) || action.name === 'confirm-absent' && (!actionForm.confirmAbsence || !actionForm.acceptDuplicateRisk)}>{action.name === 'publish-organic' ? spec.publishAt ? 'Confirmar programación' : 'Confirmar publicación' : 'Confirmar solicitud'}</button><button type="button" className="button subtle" onClick={() => setAction(null)}>Volver sin ejecutar</button></div>
    </fieldset></form></section>}

    {operation && <p role="status" className={styles.notice}>Operación {operation.step || operation.kind} · {stateLabel(operation.state)} · {operation.id}{operation.nextAttemptAt ? ` · próxima ejecución ${date(operation.nextAttemptAt)}` : ''}{operation.lastError ? ` · ${errorText(operation.lastError)}` : ''}. El progreso se consulta localmente, no son nuevas llamadas a Meta.</p>}
    {campaign?.deliveries?.length > 0 && <section className={styles.panel}>
      <h3>{campaign.mode === 'paid' ? 'Estado del anuncio en Meta' : 'Estado por destino'}</h3>
      {campaign.state === 'partial' && <p className={styles.warning}>Publicación parcial. Cada red se confirma por separado; no reenvíes la confirmada.</p>}
      {campaign.deliveries.map(delivery => <article key={delivery.id} className={styles.card}>
        <h4>{delivery.channel === 'meta_ads' ? 'Un anuncio, un presupuesto total' : NETWORKS[delivery.channel] || delivery.channel} · {stateLabel(delivery.state)}</h4>
        {delivery.channel === 'meta_ads' && <p>Lugares autorizados: {spec.placements?.map(key => PLACEMENTS[key]).join(' · ') || 'No disponibles'}. Esto no indica dónde se observó distribución; consúltala en rendimiento.</p>}
        <Values rows={[['Vía elegida', METHODS[delivery.integrationMethod || connection?.integrationMethod]], ['Último estado confirmado', stateLabel(delivery.lastConfirmedState)], ['Confirmación remota', date(delivery.lastConfirmedAt)]]}/>
        {delivery.lastError && <p className={styles.warning}>{errorText(delivery.lastError)}</p>}
        {delivery.state === 'uncertain' && <p className={styles.warning}>Comprueba el estado en Meta antes de volver a operar; no vuelvas a enviar esta entrega.</p>}
        {delivery.remoteRefs?.permalink && /^https:\/\//.test(delivery.remoteRefs.permalink) && <a href={delivery.remoteRefs.permalink} target="_blank" rel="noopener noreferrer">Ver en Meta</a>}
        {['scheduled', 'queued'].includes(delivery.state) && (spec.publishAt || spec.startAt) && Date.parse(spec.publishAt || spec.startAt) < Date.now() && <p className={styles.warning}>La hora prevista pasó sin confirmación. Si el atraso previo al envío supera 15 minutos, programa una nueva fecha en otro borrador.</p>}
        <details className={styles.technicalDetails}><summary>Evidencia y próximas lecturas</summary><Values rows={[['ID remoto', delivery.remoteId || 'No confirmado'], ['Siguiente consulta', date(delivery.nextSyncAt)], ['Último intento de resultados', date(delivery.metricSync?.lastAttemptAt)]]}/></details>
      </article>)}
    </section>}
    {campaign?.operations?.length > 0 && <details className={styles.technicalDetails} open={Boolean(uncertain)}><summary>Historial técnico de operaciones y recuperación</summary><p>Una respuesta perdida no autoriza otro clic de publicación. Primero comprueba el estado en Meta sin reenviar la intención original; si no existe una identificación inequívoca, usa una resolución explícita.</p>{campaign.operations.map(op => <article key={op.id} className={styles.card}><h4>{op.step} · {stateLabel(op.state)}</h4><p>{op.id} · {METHODS[op.integrationMethod]} · actualizado {date(op.updatedAt)} · próximo intento {date(op.nextAttemptAt)}</p>{op.lastError && <p className={styles.warning}>{errorText(op.lastError)}</p>}{['sent', 'uncertain'].includes(op.state) && <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile', op.deliveryId ? { deliveryId: op.deliveryId } : {})}>Comprobar estado en Meta sin reenviar esta intención</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('link-remote', op)}>Vincular ID o enlace permanente existente</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('confirm-absent', op)}>Confirmar ausencia y riesgo</button></div>}</article>)}</details>}
    </fieldset>
  </section>;
}
