'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import { useAssistantForm } from './AssistantBridge.jsx';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const ORGANIC_STEPS = ['Cuenta y objetivo', 'Imagen o video y texto', 'Dónde se verá', 'Cuándo publicar', 'Revisar y aprobar'];
const PAID_STEPS = ['Cuenta y objetivo', 'Imagen o video y texto', 'A quién y dónde mostrar', 'Inversión y fechas', 'Revisar y aprobar'];
const ORGANIC_INSTRUCTIONS = ['Pon un nombre y elige qué quieres conseguir', 'Elige tu archivo y escribe el mensaje', 'Elige dónde se mostrará', 'Decide cuándo publicar', 'Revisa antes de autorizar'];
const PAID_INSTRUCTIONS = ['Pon un nombre y elige qué quieres conseguir', 'Elige tu archivo y escribe el mensaje', 'Elige a quién y dónde mostrar el anuncio', 'Define el total y las fechas', 'Revisa antes de autorizar'];
const OBJECTIVES = { whatsapp: 'Consultas por WhatsApp', traffic: 'Clics al sitio web', reach: 'Alcance', engagement: 'Interacción' };
const OBJECTIVE_HELP = { whatsapp: 'Busca consultas por WhatsApp, no ventas confirmadas ni lectura de conversaciones.', traffic: 'Busca clics en el enlace, no visitas confirmadas ni ventas.', reach: 'Busca personas alcanzadas según lo informado por la red; no garantiza ventas.', engagement: 'Busca acciones sobre el contenido, no ventas confirmadas.' };
const CONNECTION_STATES = { connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };
const IDENTITY_LABELS = { businessId: 'Negocio', pageId: 'Página de Facebook', instagramActorId: 'Cuenta de Instagram', adAccountId: 'Cuenta de anuncios' };
const STATES = { draft: 'Borrador', ready: 'Preparada sin gasto autorizado', scheduled: 'Programada', publishing: 'En proceso', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Fallida', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Efecto incierto', blocked: 'Bloqueada', prepared: 'Intención registrada', sent: 'Enviada; falta confirmar', confirmed: 'Confirmada', retry_wait: 'En espera' };
const PLACEMENTS = { facebook_feed: 'Facebook · Feed', facebook_reels: 'Facebook · Reels', instagram_feed: 'Instagram · Feed', instagram_reels: 'Instagram · Reels' };
const METRICS = { impressions: 'Impresiones', reach: 'Alcance', linkClicks: 'Clics de enlace', conversations: 'Conversaciones', interactions: 'Interacciones', views: 'Visualizaciones', plays: 'Reproducciones' };
const METHODS = { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' };
const PENDING = ['prepared', 'sent', 'retry_wait'];
const COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const countryNames = new Intl.DisplayNames(['es'], { type: 'region' });
const countryLabel = code => `${countryNames.of(code) || code} (${code})`;
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
function initial(mode, objective, campaign = {}) {
  return {
    name: campaign.name || '', connectionId: campaign.connectionId || null, assetId: campaign.assetId || null,
    mode: campaign.mode || mode, objective: campaign.objective || objective, platforms: campaign.platforms || [],
    caption: campaign.caption || '', headline: campaign.headline || '', destinationUrl: campaign.destinationUrl || '',
    whatsappNumber: campaign.whatsappNumber || '', whatsappGreeting: campaign.whatsappGreeting || '',
    audience: { countries: ['CO'], regions: [], cities: [], ageMin: 18, ageMax: 65, genders: [], interests: [], ...campaign.audience },
    placements: campaign.placements || [], budgetMinor: campaign.budgetMinor ?? 0, targetCostMinor: campaign.targetCostMinor ?? null,
    publishAt: campaign.publishAt || null, startAt: campaign.startAt || null, endAt: campaign.endAt || null,
    observationDays: campaign.observationDays || 7, aiDisclosure: campaign.aiDisclosure ?? null
  };
}
function firstIncomplete(form, instruction = null) {
  if (!form.name || !form.connectionId || !form.platforms.length) return 0;
  if (!form.assetId || form.aiDisclosure === null || instruction?.changeType === 'copy' && !form.caption.trim() || form.mode === 'paid' && (form.objective === 'traffic' && !form.destinationUrl || form.objective === 'whatsapp' && (!form.whatsappNumber || !form.whatsappGreeting))) return 1;
  if (!form.placements.length || form.mode === 'paid' && ![...form.audience.countries, ...form.audience.regions, ...form.audience.cities].length) return 2;
  if (form.mode === 'paid' && (!form.budgetMinor || !form.startAt || !form.endAt) || instruction?.changeType === 'posting_window' && !form.publishAt) return 3;
  return 4;
}
function Values({ rows }) {
  return <dl className="summary-values">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Sin dato'}</dd></div>)}</dl>;
}
function AssetPreview({ asset }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const errorRef = useRef(null);
  useEffect(() => { if (failed) errorRef.current?.focus(); }, [failed]);
  if (!asset) return null;
  if (asset.state !== 'ready') return <p className={styles.warning}>La imagen o video está en estado {asset.state}; no hay un archivo preparado para publicar (derivado) verificable. Restaura o revisa el archivo en Imágenes y videos antes de publicar; su historia se conserva.</p>;
  const src = `${ROOT}/assets/${asset.id}/content?variant=derivative`;
  return <figure className={styles.assetPreview}>{failed ? <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>No se pudo cargar el archivo privado preparado para publicar (derivado). Revisa la sesión y el archivo en Imágenes y videos; no se sustituirá por el original ni por otro archivo.</p><button type="button" className="button subtle" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Volver a cargar vista previa</button></div> : asset.kind === 'video' ? <video key={attempt} className={styles.previewVideo} controls preload="metadata" src={src} onError={() => setFailed(true)}/> : <img key={attempt} className={styles.previewImage} src={src} onError={() => setFailed(true)} alt={`Archivo preparado para publicar: ${asset.name || asset.originalName || 'imagen seleccionada'}`}/>}<figcaption><strong>{asset.name || asset.originalName || 'Imagen o video seleccionado'}</strong> · Archivo privado preparado para publicar (derivado) que se aprueba, no el original. {asset.width && asset.height ? `${asset.width}×${asset.height}` : ''}</figcaption></figure>;
}
function Configuration({ spec, connection, asset }) {
  const zone = spec.timeZone || (spec.mode === 'organic' ? 'America/Bogota' : connection?.timeZone);
  return <div className={styles.stack}>
    <Values rows={[
      ['Conexión', METHODS[spec.integrationMethod || connection?.integrationMethod] || 'Sin seleccionar'], ['Cuenta conectada', connection?.name || spec.connectionId || 'Sin seleccionar'],
      ['Destinos e identidades verificados', Object.entries(spec.identities || connection?.identities || {}).map(([key, value]) => `${IDENTITY_LABELS[key] || key}: ${value}`).join(' · ') || 'Sin verificar'],
      ['Tipo de publicación', spec.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'], ['Objetivo', OBJECTIVES[spec.objective]],
      ['Redes', (spec.platforms || []).join(' · ') || 'Sin seleccionar'], ['Imagen o video preparado', asset?.name || asset?.originalName || spec.assetId || 'Sin seleccionar'],
      ['Texto', spec.caption || 'Sin texto'], ['Título o llamada a la acción', spec.headline || 'Sin título'],
      ['Destino', spec.destinationUrl || spec.whatsappNumber || 'Sin destino'], ['Bienvenida', spec.whatsappGreeting || 'No aplica'],
      ['Divulgación de IA', spec.aiDisclosure === null || spec.aiDisclosure === undefined ? 'Pendiente de declarar' : spec.aiDisclosure ? 'Sí contiene IA' : 'No contiene IA'],
      ['Ubicaciones', (spec.placements || []).map(key => PLACEMENTS[key] || key).join(' · ') || 'Sin seleccionar'],
      ['Inversión total', spec.mode === 'paid' ? money(spec.budgetMinor, spec.currency || connection?.currency) : 'Sin inversión'],
      ['Zona de publicación / cuenta', zone || 'Sin verificar'],
      ...(spec.mode === 'paid' ? [['Inicio en cuenta', date(spec.startAt, zone)], ['Fin en cuenta', date(spec.endAt, zone)], ...(zone && zone !== 'America/Bogota' ? [['Inicio en Bogotá', date(spec.startAt, 'America/Bogota')], ['Fin en Bogotá', date(spec.endAt, 'America/Bogota')]] : [])] : [['Publicación en Bogotá', spec.publishAt ? date(spec.publishAt, 'America/Bogota') : 'Cuando se procese en segundo plano'], ['Horizonte de observación', `${spec.observationDays} días; no borra la publicación`]]),
      ...(spec.targetCostMinor != null ? [['Meta de costo del usuario', money(spec.targetCostMinor, spec.currency || connection?.currency)]] : [])
    ]}/>
    {spec.mode === 'paid' && <div><h4>Audiencia aprobada / propuesta</h4><p>Edad {spec.audience?.ageMin}–{spec.audience?.ageMax} · Géneros: {spec.audience?.genders?.length ? spec.audience.genders.map(g => g === 1 ? 'Hombres' : 'Mujeres').join(', ') : 'Todos'}.</p><ul>{(spec.audience?.countries || []).map(code => <li key={code}>{countryLabel(code)} · país completo</li>)}{['regions', 'cities', 'interests'].flatMap(group => (spec.audience?.[group] || []).map(ref => <li key={ref.key}>{ref.label} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} {ref.context?.region || ''}{ref.context?.radius != null ? ` · radio ${ref.context.radius} ${ref.context.distanceUnit === 'mile' ? 'millas' : 'km'}` : ''} · {METHODS[ref.source]}</li>))}</ul><p className={styles.help}>Sin listas de clientes ni condiciones de salud. No se autorizan ampliaciones automáticas de edad, geografía o ubicaciones.</p></div>}
    <details className={styles.technicalDetails}><summary>Detalles técnicos de la configuración</summary><Values rows={[['ID de conexión', spec.connectionId || connection?.id], ['ID de imagen o video', spec.assetId || asset?.id], ['Hash del derivado (archivo preparado para publicar)', spec.assetHash || asset?.sha256 || 'No disponible']]}/></details>
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
function CampaignEditor({ api, campaignId = null, connections = [], assets = [], initialMode = 'organic', initialObjective = 'engagement', onSaved, onNavigate, onInteractionStateChange, onMutation, revision = 0 }) {
  const existing = campaignId && campaignId !== 'new' ? campaignId : null;
  const [campaign, setCampaign] = useState(null), [form, setForm] = useState(() => initial(initialMode, initialObjective));
  const [step, setStep] = useState(0), [loading, setLoading] = useState(Boolean(existing)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState({}), [retry, setRetry] = useState(0), [forecastChoice, setForecastChoice] = useState(null);
  const [rights, setRights] = useState(false), [warningsAccepted, setWarningsAccepted] = useState([]), [investment, setInvestment] = useState(false), [recommendationAccepted, setRecommendationAccepted] = useState(false);
  const [privateConsent, setPrivateConsent] = useState(false), [search, setSearch] = useState(''), [searchKind, setSearchKind] = useState('location'), [candidates, setCandidates] = useState([]), [country, setCountry] = useState('');
  const [manualEnabled, setManualEnabled] = useState(false), [manual, setManual] = useState({ metric: '', lower: '', upper: '', basis: '' });
  const [action, setAction] = useState(null), [actionForm, setActionForm] = useState({}), [operationId, setOperationId] = useState(null), [operation, setOperation] = useState(null);
  const baseline = useRef(JSON.stringify(form)), current = useRef(null), requests = useRef(new Set()), rids = useRef(new Map()), sequence = useRef(0), locked = useRef(false);
  const heading = useRef(null), errorRef = useRef(null), actionHeading = useRef(null), callbacks = useRef({}), id = useId();
  callbacks.current = { onSaved, onNavigate, onInteractionStateChange, onMutation };
  const formDirty = JSON.stringify(form) !== baseline.current || Object.entries(invalid).some(([key, value]) => key !== 'controlRemaining' && value);
  const confirmDirty = rights || investment || recommendationAccepted || warningsAccepted.length > 0 || privateConsent || manualEnabled;
  const dirty = formDirty || confirmDirty || Boolean(action);
  const frozen = Boolean(campaign && (campaign.state !== 'draft' || campaign.revisions?.length));
  const uncertain = campaign?.operations?.some(item => ['sent', 'uncertain'].includes(item.state));
  const preflightPending = campaign?.operations?.some(item => !item.deliveryId && PENDING.includes(item.state));
  const pending = uncertain || preflightPending || campaign?.operations?.some(item => PENDING.includes(item.state)) || campaign?.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review'].includes(item.state));
  const assistant = useAssistantForm({
    target: 'campaign-draft', entityId: campaign?.id || existing || null, recordVersion: campaign?.version ?? null,
    values: form, dirty, busy: busy || loading,
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
        if (key === 'audience') {
          for (const [field, entry] of Object.entries(value)) setAudience(field, entry);
        } else set(key, value);
      }
    },
    acceptAutomaticResult: campaign?.state === 'draft' && !frozen && !uncertain && !preflightPending ? async ({ result }) => {
      try { await hydrateCommittedDraft(result); }
      catch (cause) { setError(`El cambio se guardó; no se pudo actualizar el borrador. ${cause.message}`); throw cause; }
    } : undefined,
  });
  current.current = { formDirty, campaign, form, busy };
  const connection = connections.find(item => item.id === form.connectionId) || (campaign?.connection?.id === form.connectionId ? campaign.connection : null);
  const asset = assets.find(item => item.id === form.assetId) || (campaign?.asset?.id === form.assetId ? campaign.asset : null);
  const approved = campaign?.revisions?.at(-1), forecast = frozen ? approved?.forecast : forecastChoice || campaign?.forecasts?.find(item => item.id === campaign.forecastId);
  const validation = campaign?.validation, warningList = validation?.warnings || [];
  const spec = frozen ? approved?.spec || campaign : validation?.spec || { ...form, integrationMethod: connection?.integrationMethod, currency: connection?.currency, timeZone: form.mode === 'paid' ? connection?.timeZone : 'America/Bogota' };
  const hold = campaign?.restore_hold || campaign?.restoreHold;
  const instruction = campaign?.recommendationInstructions;
  const primary = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' }[form.objective];
  const manualMetrics = form.mode === 'paid' ? [primary] : form.objective === 'whatsapp' ? [] : form.platforms.filter(network => !(network === 'instagram' && primary === 'linkClicks')).map(network => `${network}.${primary}`);
  const steps = form.mode === 'paid' ? PAID_STEPS : ORGANIC_STEPS;
  const instructions = form.mode === 'paid' ? PAID_INSTRUCTIONS : ORGANIC_INSTRUCTIONS;

  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy:busy||assistant.assistantBusy }); }, [dirty, busy, assistant.assistantBusy]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => { if (action) actionHeading.current?.focus(); }, [action]);

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
      if (openStep) setStep(data.state === 'draft' ? firstIncomplete(next, data.recommendationInstructions) : 4);
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
    setForm(previous => ({ ...previous, [key]: value })); setForecastChoice(null); resetAcceptance();
  }
  function setAudience(key, value) {
    setForm(previous => ({ ...previous, audience: { ...previous.audience, [key]: value } })); setForecastChoice(null); resetAcceptance();
  }
  function selectConnection(value) {
    const next = connections.find(item => item.id === value), currencyChanged = connection?.currency !== next?.currency;
    setForm(previous => ({ ...previous, connectionId: value || null, audience: { ...previous.audience, regions: [], cities: [], interests: [] }, ...(currencyChanged ? { budgetMinor: 0, targetCostMinor: null } : {}) }));
    setCandidates([]); setOperation(null); setOperationId(null); setForecastChoice(null); setPrivateConsent(false); resetAcceptance();
    setNotice(currencyChanged ? 'Cambió la moneda: vuelve a ingresar y aceptar el presupuesto. Se retiraron referencias de la cuenta anterior.' : 'Las referencias y la preparación deben validarse para esta cuenta; no se trasladan objetos remotos.');
  }
  function changeMode(value) {
    setForm(previous => ({ ...previous, mode: value, budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null, publishAt: null, placements: [] })); setForecastChoice(null); resetAcceptance();
  }
  function changePlatforms(value) {
    setForm(previous => ({ ...previous, platforms: value, placements: previous.placements.filter(key => value.some(network => key.startsWith(`${network}_`))) })); setForecastChoice(null); resetAcceptance();
  }
  function changeAsset(value) {
    const selected = assets.find(item => item.id === value);
    setForm(previous => ({ ...previous, assetId: value || null, placements: previous.placements.filter(key => selected?.kind === 'image' ? key.endsWith('_feed') : previous.mode === 'organic' ? key.endsWith('_reels') : true) })); setForecastChoice(null); resetAcceptance();
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
    await notifyMutation();
    return data;
  }
  async function persist() {
    assertSaveableDraft();
    const target = campaign?.id || existing;
    if (target && !formDirty) return campaign;
    const payload = { ...form, version: target ? campaign?.version : 0 };
    const body = { ...payload, requestId: rid(`save:${target || 'new'}`, payload) };
    const result = await request(`${ROOT}/campaigns${target ? `/${encodeURIComponent(target)}` : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    return hydrateCommittedDraft(result);
  }
  async function save(event) {
    event?.preventDefault();
    if (assistant.assistantBusy || busy || loading) return;
    setError('');
    try {
      assertSaveableDraft();
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
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); }
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
      const overlappingRegion = type === 'city' && form.audience.regions.some(item => item.context.countryCode === code && (item.providerId && item.providerId === ref.context.regionId || item.context.region === ref.context.region));
      const overlappingCity = type === 'region' && form.audience.cities.some(item => item.context.countryCode === code && (ref.providerId && ref.providerId === item.context.regionId || ref.context.region === item.context.region));
      if (form.audience.countries.includes(code) || overlappingRegion || overlappingCity) { setError('Retira primero el país completo o la región/ciudad superpuesta. No se ampliará ni reemplazará tu ámbito automáticamente.'); return; }
    }
    setAudience(group, [...form.audience[group], ref]);
  }
  function addCountry() {
    if (!country || form.audience.countries.includes(country)) return;
    if ([...form.audience.regions, ...form.audience.cities].some(ref => ref.context.countryCode === country)) { setError('Retira primero las regiones/ciudades de ese país para no superponer ámbitos.'); return; }
    setAudience('countries', [...form.audience.countries, country]); setCountry('');
  }
  async function estimate() {
    await task(async () => {
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
      if (!campaign?.id) throw new Error('Guarda primero el borrador.');
      if (formDirty) throw new Error('Guarda los cambios antes de operar sobre la configuración del servidor.');
      const payload = { action: name, version: campaign.version, ...fields };
      const result = await request(`${ROOT}/campaigns/${campaign.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(`action:${campaign.id}`, payload) }) });
      resetAcceptance(); setAction(null); setActionForm({}); setPrivateConsent(false);
      if (result.operationId) setOperationId(result.operationId);
      setNotice(name === 'duplicate' ? 'Nuevo borrador creado, sin aprobación ni gasto.' : name === 'cancel' && result.state === 'cancelled' ? 'Trabajo local cancelado. No se borraron publicaciones en Meta.' : 'Solicitud registrada. El estado remoto sólo cambia cuando se confirme; encolar no significa publicar ni pausar.');
      if (name === 'duplicate') { await notifyMutation(); callbacks.current.onSaved?.(result); return; }
      await loadDetail(campaign.id, { replace: true }); completeRid(`action:${campaign.id}`, payload); await notifyMutation();
    });
  }
  function approve() {
    if (!forecast?.id || !forecast.specHash || forecast.specHash !== validation?.specHash || !validation?.valid || formDirty || !rights || form.mode === 'paid' && !investment || warningList.some(item => !warningsAccepted.includes(item.key)) || instruction?.needsConfirmation && !recommendationAccepted) { setError('Guarda y estima la configuración actual; acepta derechos, advertencias y las confirmaciones requeridas.'); return; }
    void campaignAction(form.mode === 'paid' ? 'prepare-paid' : 'approve-organic', { rightsAccepted: true, acceptedWarnings: warningList.map(item => item.key), specHash: forecast.specHash, forecastId: forecast.id, ...(form.mode === 'paid' ? { investmentAccepted: true } : {}), ...(instruction?.needsConfirmation ? { recommendationAccepted: true } : {}) });
  }
  function openAction(name, operationValue = null) {
    const delivery = campaign?.deliveries?.find(item => item.channel === 'meta_ads'), budget = delivery?.budgetSnapshot;
    setInvalid(previous => ({ ...previous, controlRemaining: false }));
    setAction({ name, operation: operationValue }); setActionForm({ reason: '', rightsAccepted: false, investmentAccepted: false, acceptDuplicateRisk: false, confirmAbsence: false, acceptContentVerification: false, acceptPrivateDraft: false, acceptedWarnings: [], remainingBudgetMinor: Number.isSafeInteger(budget?.remainingMinor) ? budget.remainingMinor : null, remoteId: '', permalink: '' });
  }
  async function submitAction(event) {
    event.preventDefault(); const name = action.name, fields = {}, delivery = campaign.deliveries?.find(item => item.channel === 'meta_ads');
    if (['pause', 'cancel'].includes(name)) fields.reason = actionForm.reason;
    if (['activate-paid', 'resume'].includes(name)) Object.assign(fields, { specHash: approved?.specHash, preparedRefs: delivery?.preparedRefs, investmentAccepted: actionForm.investmentAccepted, remainingBudgetMinor: actionForm.remainingBudgetMinor });
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
  const formLocked = busy || loading || frozen || uncertain || preflightPending || assistant.assistantBusy;
  const stepChange = value => { setStep(value); setError(''); };
  function blockAssistantInteraction(event) {
    if (!assistant.assistantBusy) return;
    event.preventDefault(); event.stopPropagation();
  }

  return <section className={styles.detail} aria-busy={busy || loading || assistant.assistantBusy} onClickCapture={blockAssistantInteraction} onChangeCapture={blockAssistantInteraction} onSubmitCapture={blockAssistantInteraction}>
    <fieldset className={`editor-fieldset ${styles.stack}`} disabled={assistant.assistantBusy}>
    <header className={styles.heading}><div><p className={styles.eyebrow}>{frozen ? 'Configuración aprobada · Solo lectura' : 'Preparar una publicación'}</p><h2 ref={frozen ? heading : undefined} tabIndex={-1}>{campaign?.name || 'Nueva publicación'} · {stateLabel(campaign?.state || 'draft')}</h2></div><div>{!frozen && <button type="button" className="button subtle" disabled={assistant.assistantBusy || loading} onClick={assistant.openAssistant}>Ayúdame con este borrador</button>} <button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'campaigns', record: null })}>Volver a publicaciones</button></div></header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}<div className={styles.actions}>{existing && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => setRetry(value => value + 1)}>Recargar datos guardados</button>}<button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'business', tab: 'social', record: connection?.id || null })}>Revisar conexión</button></div>{formDirty && <p>Tus cambios locales se conservaron; no se reemplazan al actualizar.</p>}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {loading && <p role="status">{campaign ? 'Actualizando datos guardados…' : 'Cargando publicación…'}</p>}
    {hold && <p className={styles.warning}>Bloqueo de restauración: reconectar no autoriza reenvíos. Comprueba el estado en Meta sin reenviar y acepta explícitamente la recuperación. Restaurar la base de datos no detiene anuncios activos.</p>}
    {instruction && <aside className={styles.notice}><h3>Prueba propuesta para la próxima publicación</h3><p>{instruction.text}</p>{instruction.postingWindow && <p>Franja sugerida: {textValue(instruction.postingWindow)}. Elige tú una fecha; no se programa automáticamente.</p>}<p>Publicación de origen: {campaign.parentCampaignId}. Conserva el monto aprobado; aporta la imagen o video o edita el texto solicitado antes de confirmar.</p></aside>}
    {!frozen && <nav aria-label="Pasos de preparación" className={styles.steps}>{steps.map((label, index) => <button type="button" key={label} className={`${styles.stepButton} ${step === index ? styles.stepActive : ''}`} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => stepChange(index)}>{index + 1}. {label}</button>)}</nav>}
    {!frozen && <div className={styles.stepIntro}><h3 ref={heading} tabIndex={-1}>Paso {step + 1} de 5 · {steps[step]}</h3><p>{instructions[step]}</p></div>}

    {!frozen && <form method="post" onSubmit={save} className={styles.stack}>
      <fieldset disabled={formLocked || assistant.assistantBusy} className="editor-fieldset"><legend>{steps[step]}</legend>
        {step === 0 && <div className={styles.stack}>
          <p className={styles.help}>Puedes empezar solo con un nombre y guardar el borrador.</p>
          <div className={styles.fieldGrid}>
            {field('name', 'Nombre de la publicación', { required: true, max: 200, description: 'Para encontrarlo después. Ejemplo ficticio: Creatina · noviembre · Instagram' })}
            <label className="field">Cuenta conectada<select name="connectionId" value={form.connectionId || ''} onChange={event => selectConnection(event.target.value)}><option value="">Selecciona una cuenta conectada</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name || item.identities?.pageId || item.id} · {METHODS[item.integrationMethod] || item.integrationMethod} · {CONNECTION_STATES[item.state] || item.state}</option>)}{form.connectionId && !connections.some(item => item.id === form.connectionId) && <option value={form.connectionId}>{campaign?.connection?.name || 'Cuenta guardada'} · revisar disponibilidad</option>}</select></label>
            {field('mode', 'Tipo de publicación', { type: 'select', options: [{ value: 'organic', label: 'Publicación sin inversión' }, { value: 'paid', label: 'Anuncio pagado' }], description: 'Sin inversión: aprobar autoriza publicar sin comprar distribución. Anuncio pagado: preparar no activa gasto; invertir requiere otra confirmación.' })}
          </div>
          <p className={styles.help}>El método de conexión queda fijo al aprobar. No existe cambio automático entre la conexión oficial de Meta (API) y el acceso asistido por navegador. Para cambiarlo después, duplica en borrador sin reutilizar objetos remotos.</p>
          {form.mode === 'paid' && (form.startAt || form.publishAt) && <p className={styles.help}>Al cambiar modalidad se deben revisar inversión y agenda.</p>}
          <label className="field">Objetivo comercial<select name="objective" aria-describedby={`${id}-objective-help`} value={form.objective} onChange={event => set('objective', event.target.value)}>{Object.entries(OBJECTIVES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><p id={`${id}-objective-help`} className={styles.help}>{OBJECTIVE_HELP[form.objective]} No hay píxel ni seguimiento automático de ventas.</p>
          <fieldset><legend>Redes</legend>{['facebook', 'instagram'].map(network => check(network === 'facebook' ? 'Facebook · página' : 'Instagram · cuenta profesional', form.platforms.includes(network), enabled => changePlatforms(enabled ? [...form.platforms, network] : form.platforms.filter(value => value !== network))))}</fieldset>
          {connection && <Values rows={[['Cuenta conectada', connection.name || connection.id], ["Método elegido", METHODS[connection.integrationMethod] || connection.integrationMethod], ['Estado de conexión', CONNECTION_STATES[connection.state] || connection.state], ['Moneda de cuenta', connection.currency || 'Sin verificar'], ['Zona de cuenta', connection.timeZone || 'Sin verificar'], ['Capacidades verificadas', Object.entries(connection.capabilities || {}).filter(([, value]) => value === true).map(([key]) => ({ facebookPublish: 'Publicar en Facebook', instagramPublish: 'Publicar en Instagram', adsPublish: 'Preparar y operar anuncios pagados', insights: 'Consultar resultados', whatsappAds: 'Anuncios a WhatsApp vinculado' }[key] || key)).join(' · ') || 'Ninguna acreditada']]}/>}
          {!connections.length && <div className="admin-empty"><h3>Puedes conectar la cuenta después</h3><p>Guarda el nombre del borrador y retómalo cuando tengas una cuenta disponible. Cada método tiene requisitos y autenticación independientes.</p></div>}
          <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ section: 'business', tab: 'social', record: null })}>Ir a Redes sociales en Configuración (guarda antes si quieres retomar)</button>
        </div>}
        {step === 1 && <div className={styles.stack}>
          <label className="field">Imagen o video listo para usar<select name="assetId" value={form.assetId || ''} aria-describedby={`${id}-asset-requirements`} onChange={event => changeAsset(event.target.value)}><option value="">Selecciona un archivo preparado para publicar</option>{assets.filter(item => item.state === 'ready').map(item => <option key={item.id} value={item.id}>{item.name || item.originalName || item.id} · {item.kind === 'video' ? 'Video' : 'Imagen'}</option>)}{form.assetId && !assets.some(item => item.id === form.assetId && item.state === 'ready') && <option value={form.assetId}>Imagen o video guardado no disponible · {asset?.state || 'revisar'}</option>}</select></label>
          <AssetPreview key={asset?.id || 'none'} asset={asset}/>
          {field('caption', 'Texto que acompaña la imagen o video', { type: 'textarea', max: 2200 })}{field('headline', 'Título o llamada a la acción', { max: 40, description: 'Ejemplo ficticio: Conoce más' })}
          <p id={`${id}-asset-requirements`} className={styles.help}>Imágenes JPEG/PNG/WebP hasta 10 MiB, sin animación, proporción 4:5 a 1,91:1 y ancho mínimo 320 px. Videos MP4/MOV hasta 250 MiB, verticales 9:16, mínimo 540×960 y duración de 3–90 segundos.</p>
          <details className={styles.technicalDetails}><summary>Requisitos del archivo</summary><p>Imágenes de hasta 40 megapíxeles: se preparan como JPEG sRGB, sin ampliar y hasta 1440 px. Videos: se preparan como MP4 H.264, audio AAC cuando existe, 30 fotogramas por segundo y hasta 1080×1920 px y 25 Mbps. No se recorta ni genera la imagen o video. Revisa el archivo preparado para publicar (derivado) en la vista previa.</p></details>
          {!assets.some(item => item.state === 'ready') && <p className={styles.empty}>No hay imágenes o videos listos. Guarda el borrador y sube un archivo compatible; se prepara mediante procesamiento en segundo plano.</p>}
          <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'assets', record: null })}>Subir o revisar imágenes y videos (guarda antes)</button>
          {form.objective === 'traffic' && field('destinationUrl', 'URL de destino', { type: 'url', max: 2048 })}
          {form.objective === 'whatsapp' && <>{field('whatsappNumber', 'WhatsApp vinculado a la página (formato internacional +)', { max: 16 })}{field('whatsappGreeting', 'Bienvenida explícita de WhatsApp', { type: 'textarea', max: 1024 })}<p className={styles.help}>El número debe coincidir con el recurso verificado en Meta. El teléfono de la vitrina no acredita capacidad de pauta.</p></>}
          <label className="field">¿La imagen o video contiene contenido generado con IA?<select name="aiDisclosure" value={form.aiDisclosure === null ? '' : String(form.aiDisclosure)} onChange={event => set('aiDisclosure', event.target.value === '' ? null : event.target.value === 'true')}><option value="">Declara explícitamente</option><option value="false">No</option><option value="true">Sí; requiere divulgación verificable en el método elegido</option></select></label>
          {form.mode === 'organic' && form.platforms.includes('instagram') && ['traffic', 'whatsapp'].includes(form.objective) && <p className={styles.warning}>En Instagram sin inversión, los enlaces del texto no son llamadas a la acción clicables. No se promete medir consultas o tráfico por publicación.</p>}
        </div>}
        {step === 2 && <div className={styles.stack}>
          {form.mode === 'organic' ? <p className={styles.notice}>Una publicación sin inversión no compra audiencia. Se distribuye públicamente según la página/cuenta y la red; no se garantiza segmentación ni alcance.</p> : <>
            <p>Mayores de 18 años. Sin datos de clientes, públicos personalizados ni condiciones de salud. No superpongas país completo con sus regiones/ciudades ni una región con sus ciudades.</p>
            <label className="field">País completo<select name="country" value={country} onChange={event => setCountry(event.target.value)}><option value="">Selecciona un país ISO</option>{COUNTRIES.map(code => <option key={code} value={code}>{countryLabel(code)}</option>)}</select></label><button type="button" className="button subtle" disabled={!country} onClick={addCountry}>Añadir país completo</button>
            <ul>{form.audience.countries.map(code => <li key={code}>{countryLabel(code)} <button type="button" className="text-button" onClick={() => setAudience('countries', form.audience.countries.filter(value => value !== code))}>Quitar país {code}</button></li>)}</ul>
            <div className={styles.fieldGrid}><Field field={{ name: 'ageMin', label: 'Edad mínima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMin} onChange={value => setAudience('ageMin', value)}/><Field field={{ name: 'ageMax', label: 'Edad máxima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMax} onChange={value => setAudience('ageMax', value)}/></div>
            <fieldset><legend>Géneros (ninguno seleccionado = todos)</legend>{[[1, 'Hombres'], [2, 'Mujeres']].map(([value, label]) => check(label, form.audience.genders.includes(value), checked => setAudience('genders', checked ? [...form.audience.genders, value] : form.audience.genders.filter(item => item !== value))))}</fieldset>
            {['regions', 'cities', 'interests'].map(group => <section key={group}><h4>{{ regions: 'Regiones verificadas', cities: 'Ciudades y radio explícito', interests: 'Intereses verificados' }[group]}</h4>{!form.audience[group].length && <p className={styles.muted}>Sin selección.</p>}{form.audience[group].map(ref => <div className={styles.card} key={ref.key}><p>{ref.label} · {ref.context.countryCode || ref.context.scope || ref.context.path?.join(' / ')} · {ref.context.region || ''}</p>{group === 'cities' && <div className={styles.fieldGrid}><label className="field">Radio explícito<input type="number" min={ref.context.distanceUnit === 'mile' ? 10 : 17} max={ref.context.distanceUnit === 'mile' ? 50 : 80} step="1" value={ref.context.radius ?? ''} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, radius: event.target.value === '' ? undefined : Number(event.target.value), distanceUnit: item.context.distanceUnit || 'kilometer' } } : item))}/></label><label className="field">Unidad<select value={ref.context.distanceUnit || 'kilometer'} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, distanceUnit: event.target.value, radius: undefined } } : item))}><option value="kilometer">Kilómetros (17–80)</option><option value="mile">Millas (10–50)</option></select></label></div>}<button type="button" className="text-button" onClick={() => setAudience(group, form.audience[group].filter(item => item.key !== ref.key))}>Quitar {ref.label}</button></div>)}</section>)}
            <p className={styles.help}>Busca y selecciona referencias oficiales debajo de este formulario. Un nombre escrito no se convierte en ID. Los candidatos nativos quedan ligados al negocio y deben coincidir inequívocamente al reabrir.</p>
          </>}
          <p id={`${id}-placements-help`} className={styles.help}>Ubicaciones son los lugares donde aparece el contenido dentro de una red, como Feed o Reels; no son ciudades.</p>
          <fieldset aria-describedby={`${id}-placements-help`}><legend>Ubicaciones compatibles</legend>{Object.entries(PLACEMENTS).filter(([key]) => form.platforms.some(network => key.startsWith(`${network}_`)) && (asset?.kind === 'image' ? key.endsWith('_feed') : asset?.kind === 'video' && form.mode === 'organic' ? key.endsWith('_reels') : true)).map(([key, label]) => check(label, form.placements.includes(key), checked => set('placements', checked ? [...form.placements, key] : form.placements.filter(value => value !== key))))}</fieldset><p className={styles.help}>Una imagen sólo en Feed; video sin inversión en Reels (Instagram también comparte al Feed). No Stories, carrusel, Messenger, Audience Network ni WhatsApp Status.</p>
        </div>}
        {step === 3 && <div className={styles.stack}>
          <p className={styles.notice}>Los controles de fecha y hora usan la zona del dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Debajo se muestra su equivalencia real en la cuenta y Bogotá. Se guardan instantes UTC, no horas locales disfrazadas de UTC.</p>
          {form.mode === 'paid' ? <>
            <Values rows={[["Moneda no editable", connection?.currency || 'Selecciona cuenta con moneda verificada'], ['Zona de cuenta', connection?.timeZone || 'Sin verificar']]}/>
            <div className={styles.fieldGrid}>{amount('budgetMinor', 'Presupuesto total (no diario)')}{dateInput('startAt', 'Inicio (hora del dispositivo)')}{dateInput('endAt', 'Fin (hora del dispositivo)')}</div>
            <details className={styles.technicalDetails} open={form.targetCostMinor != null || Boolean(invalid.targetCostMinor)}><summary>Opciones de inversión</summary>{amount('targetCostMinor', 'Meta opcional de costo por resultado (del usuario)')}</details>
            <p>Un conjunto y un anuncio comparten un único total, incluso con dos redes. Inicio futuro, fin posterior, máximo 90 días. No se acepta presupuesto diario abierto. Impuestos/cargos pueden ser adicionales.</p>
            {connection?.currency === 'COP' && form.budgetMinor % 100 !== 0 && <p role="alert" className={styles.error}>COP exige un total de pesos enteros representable por Meta. Corrige los centavos; no se redondeará.</p>}
            <p className={styles.help}>Guardar y preparar no activan anuncios pagados. La activación y cada reanudación requieren una aceptación separada del restante real y las fechas originales.</p>
          </> : <>{dateInput('publishAt', 'Publicación programada opcional (hora del dispositivo)')}<p>Aprobar autoriza publicar en la fecha elegida o, si está vacía, cuando el procesamiento en segundo plano atienda la solicitud. Programar no garantiza una ejecución puntual. La agenda es local; cerrar el panel no cancela el trabajo. Un atraso superior a 15 minutos exige intervención, no publicar una promoción vencida.</p>{field('observationDays', 'Horizonte de observación', { type: 'select', options: [7, 14, 28].map(value => ({ value, label: `${value} días` })) })}<p>Sin inversión ni promesa de entrega. El horizonte evalúa resultados; no borra contenido.</p></>}
        </div>}
        {step === 4 && <div className={styles.stack}><h3>1. Revisa lo que preparaste</h3><p>Configuración {formDirty ? 'local sin guardar' : 'guardada'}.</p><Configuration spec={formDirty ? { ...form, currency: connection?.currency, integrationMethod: connection?.integrationMethod } : spec} connection={connection} asset={asset}/>{validation?.errors?.length > 0 && <div className={styles.warning}><h3>Requisitos pendientes del servidor</h3><ul>{validation.errors.map((item, index) => <li key={index}>{errorText(item)}</li>)}</ul></div>}<p>No se analiza visualmente la imagen o video ni se garantizan resultados. Primero guarda, valida la preparación privada en Meta si aplica y estima; después acepta la versión exacta.</p></div>}
      </fieldset>
      <div className={styles.actions}>{step > 0 && <button type="button" className="button subtle" disabled={busy} onClick={() => stepChange(step - 1)}>Anterior</button>}<button type="submit" className="button subtle" disabled={formLocked || !form.name.trim()}>Guardar borrador</button>{step < 4 && <button type="button" className="button primary" disabled={busy} onClick={() => stepChange(step + 1)}>Continuar</button>}</div>
      <p className={styles.help}>Guardar borrador no publica ni autoriza gasto. Continuar no guarda; tus datos se conservan al cambiar de paso.</p>
    </form>}

    {!frozen && form.mode === 'paid' && step === 2 && <section className={styles.panel}><h3>Buscar audiencia por {METHODS[connection?.integrationMethod] || 'vía seleccionada'}</h3>{connection?.integrationMethod === 'browser' && <p>La búsqueda usa un borrador privado previamente consentido. Prepáralo debajo; no se utiliza Graph API ni se publica para obtener candidatos.</p>}<form method="post" onSubmit={searchAudience} className={styles.stack}><fieldset disabled={busy || loading || preflightPending || uncertain || !connection}><legend>Búsqueda oficial</legend><div className={styles.fieldGrid}><label className="field">Tipo<select name="kind" value={searchKind} onChange={event => { setSearchKind(event.target.value); setCandidates([]); }}><option value="location">Región o ciudad</option><option value="interest">Interés</option></select></label><label className="field">Buscar por nombre<input name="q" type="search" maxLength={100} minLength={2} value={search} onChange={event => setSearch(event.target.value)}/></label></div><button type="submit" className="button subtle" disabled={search.trim().length < 2 || connection?.integrationMethod === 'browser' && !campaign?.preflight?.remoteDraftRef}>Buscar candidatos verificados</button></fieldset></form><ul className={styles.choiceList}>{candidates.map(ref => <li key={ref.key}><span>{ref.label} · {ref.context?.type} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} · {ref.context?.region || ''}</span><button type="button" className="button subtle" disabled={formLocked} onClick={() => addReference(ref)}>Seleccionar {ref.label}</button></li>)}</ul></section>}

    {!frozen && connection?.integrationMethod === 'browser' && form.mode === 'paid' && <section className={styles.panel}><h3>Preparación privada en Meta · acceso asistido por navegador</h3><p>Puede guardar un borrador privado en el administrador de anuncios de Meta. No publica ni activa inversión; no autoriza sustituir imagen o video, objetivo, presupuesto o ubicaciones. Cualquier edición invalida el resumen efectivo anterior.</p>{!campaign?.preflight?.remoteDraftRef && check('Acepto crear un borrador privado recuperable, sin publicación ni gasto.', privateConsent, setPrivateConsent, busy)}<div className={styles.actions}>{!campaign?.preflight?.remoteDraftRef ? <button type="button" className="button subtle" disabled={busy || preflightPending || uncertain || hold || !privateConsent || !form.name.trim()} onClick={() => preflight('prepare')}>Guardar y preparar borrador privado</button> : <button type="button" className="button subtle" disabled={busy || preflightPending || uncertain || hold} onClick={() => preflight('validate')}>Guardar y validar el mismo borrador</button>}</div>{campaign?.preflight?.remoteDraftRef && <details className={styles.technicalDetails}><summary>Detalles del borrador privado</summary><p>Referencia recuperable: {campaign.preflight.remoteDraftRef} · {campaign.preflight.adapterVersion} · comprobada {date(campaign.preflight.checkedAt)}.</p></details>}{campaign?.preflight?.observedSpec && <details><summary>Resumen efectivo leído en Meta antes de aprobar</summary><Configuration spec={campaign.preflight.observedSpec} connection={connection} asset={asset}/></details>}{campaign?.preflight?.kind === 'validate' && <p className={styles.notice}>La validación privada debe conservar exactamente la misma configuración e imagen o video al aprobar. Es un borrador, no un anuncio activo.</p>}</section>}

    {!frozen && step === 4 && <section className={styles.stack} aria-labelledby={`${id}-forecast`}>
      <h3 id={`${id}-forecast`}>2. Consulta una estimación</h3>
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
          <button type="submit" className="button subtle" disabled={!form.name.trim()}>Guardar y obtener estimación</button>
        </fieldset>
      </form>
      <Forecast forecast={formDirty ? null : forecast}/>
      <section className={styles.panel}><h3>3. Decide si lo apruebas</h3>
        <p className={styles.notice}>{form.mode === 'paid' ? 'Esta aprobación solo prepara el anuncio. Activar gasto requiere otra confirmación.' : 'Aprobar autoriza publicar en la fecha elegida o cuando se procese la solicitud. Guardar borrador no publica.'}</p>
        {formDirty && <p className={styles.warning}>Hay cambios sin guardar. La estimación anterior no autoriza esta configuración.</p>}
        <fieldset disabled={busy || formDirty || !forecast?.id || !validation?.valid || hold || preflightPending || uncertain}><legend>Autorización de la revisión</legend>
          {check('Confirmo derechos sobre la imagen o video y su audio, y que revisé el archivo preparado para publicar (derivado).', rights, setRights)}
          {warningList.map(item => <div key={item.key}>{check(item.message, warningsAccepted.includes(item.key), checked => setWarningsAccepted(previous => checked ? [...previous, item.key] : previous.filter(key => key !== item.key)))}</div>)}
          {instruction?.needsConfirmation && check('Aporté o edité el cambio solicitado, revisé la instrucción de la recomendación y acepto esta prueba sin aumentar el presupuesto.', recommendationAccepted, setRecommendationAccepted)}
          {form.mode === 'paid' && check(`Confirmo ${money(form.budgetMinor, connection?.currency)} como presupuesto TOTAL y las fechas mostradas. Sólo autorizo preparar, NO activar gasto.`, investment, setInvestment)}
          <details className={styles.technicalDetails}><summary>Identificadores de la autorización exacta</summary><p>Especificación: {forecast?.specHash || 'Primero obtén una estimación'} · estimación: {forecast?.id || 'Sin estimación'}.</p></details>
          <button type="button" className="button primary" disabled={!rights || warningList.some(item => !warningsAccepted.includes(item.key)) || form.mode === 'paid' && !investment || instruction?.needsConfirmation && !recommendationAccepted || connection?.integrationMethod === 'browser' && form.mode === 'paid' && campaign?.preflight?.kind !== 'validate'} onClick={approve}>{form.mode === 'paid' ? 'Aprobar y preparar sin gasto' : form.publishAt ? 'Aprobar publicación programada' : 'Aprobar publicación sin inversión'}</button>
        </fieldset>
        {!validation?.valid && <p className={styles.help}>Completa los requisitos de validación del servidor antes de aprobar; guardar un borrador incompleto sigue disponible.</p>}
      </section>
    </section>}

    {frozen && <section className={styles.panel}><h3>Configuración aprobada · Solo lectura</h3><p>Versión aprobada {approved?.revision}. El método de conexión y la configuración no se pueden editar. Para corregirlos, cancela lo aún no enviado y usa «Duplicar en nuevo borrador». No se edita una revisión pendiente.</p><Configuration spec={spec} connection={campaign.connection} asset={campaign.asset}/><AssetPreview key={campaign.asset?.id || 'none'} asset={campaign.asset}/><details><summary>Estimación conservada al aprobar</summary><Forecast forecast={approved?.forecast}/></details></section>}

    {campaign && <section className={styles.panel}><h3>Administrar publicación</h3>
      {campaign.state === 'ready' && <p className={styles.notice}>{connection?.integrationMethod === 'browser' ? 'Borrador privado de Meta sin entrega.' : 'Objetos preparados en pausa, sin gasto autorizado.'} Preparada no significa activa; falta autorización expresa.</p>}
      <div className={styles.actions}>
        <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('duplicate')}>Duplicar en nuevo borrador</button>
        {campaign.deliveries?.length > 0 || uncertain ? <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile')}>Comprobar estado en Meta sin reenviar</button> : null}
        {campaign.deliveries?.length > 0 && <><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('sync')}>Pedir actualización a Meta (mínimo 15 min)</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('analyze')}>Solicitar ideas de mejora</button><button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'results', record: campaign.id })}>Ver resultados</button></>}
        {!['cancelled', 'completed'].includes(campaign.state) && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('cancel')}>Cancelar trabajo / detener anuncios</button>}
        {campaign.mode === 'paid' && campaign.deliveries?.some(item => item.remoteId || item.remoteRefs?.campaignId) && <button type="button" className="button subtle" disabled={busy} onClick={() => openAction('pause')}>Pausar para detener gasto</button>}
        {campaign.state === 'ready' && campaign.mode === 'paid' && <button type="button" className="button primary" disabled={busy || hold} onClick={() => openAction('activate-paid')}>Revisar y autorizar activación</button>}
        {campaign.state === 'paused' && campaign.mode === 'paid' && <button type="button" className="button primary" disabled={busy || hold} onClick={() => openAction('resume')}>Revisar y autorizar reanudación</button>}
        {hold && <button type="button" className="button subtle" disabled={busy || formDirty || uncertain} onClick={() => openAction('resume-restored')}>Revisar recuperación explícita</button>}
      </div>
      <p className={styles.help}>Sin acceso vigente no se puede afirmar pausa: detén los anuncios directamente en Meta. La pausa segura no depende de una imagen o video disponible ni de habilitar nuevas publicaciones.</p>
    </section>}

    {action && <section className={styles.panel}><h3 ref={actionHeading} tabIndex={-1}>{{ 'activate-paid': 'Autorizar gasto por primera vez', resume: 'Autorizar reanudación', pause: 'Solicitar pausa remota', cancel: 'Cancelar trabajo o pausar anuncios emitidos', 'resume-restored': 'Comprobar estado en Meta y aceptar recuperación', 'link-remote': 'Vincular un objeto remoto existente', 'confirm-absent': 'Confirmar ausencia y riesgo antes de reintentar' }[action.name]}</h3><form method="post" onSubmit={submitAction}><fieldset disabled={busy}><legend>Confirmación explícita de la acción</legend>
      {['activate-paid', 'resume', 'resume-restored'].includes(action.name) && <><Values rows={[["Total original", money(spec.budgetMinor, spec.currency || connection?.currency)], ['Inicio original en cuenta', date(spec.startAt, spec.timeZone || connection?.timeZone)], ['Fin original en cuenta', date(spec.endAt, spec.timeZone || connection?.timeZone)]]}/>{campaign.mode === 'paid' && <><Field field={{ name: 'remainingBudgetMinor', label: `Presupuesto restante observado en Meta (${spec.currency || connection?.currency || 'sin moneda'})`, type: 'moneyOptionalMinor', description: 'Punto para miles y coma para centavos. Se comprobará contra una lectura remota; no se deduce del gasto local ni se amplía el total.' }} value={actionForm.remainingBudgetMinor} onChange={value => setActionForm(previous => ({ ...previous, remainingBudgetMinor: value }))} onDraftInvalid={value => setInvalid(previous => ({ ...previous, controlRemaining: value }))}/><p>Última lectura presupuestaria: {date(campaign.deliveries?.find(item => item.channel === 'meta_ads')?.budgetSnapshot?.checkedAt)}. Si falta o cambió, comprueba el estado en Meta sin reenviar y vuelve a revisar.</p>{check('Acepto expresamente el presupuesto restante indicado, la moneda y las fechas originales, sin aumentar total ni extender fin.', actionForm.investmentAccepted, value => setActionForm(previous => ({ ...previous, investmentAccepted: value })))}</>}<p>La solicitud encola una operación; no confirma que Meta haya activado o reanudado. Se vuelve a verificar identidad, referencias y configuración antes de enviar.</p></>}
      {action.name === 'resume-restored' && <>{check('Confirmo los derechos actuales sobre la imagen o video y su audio, y la revisión recuperada.', actionForm.rightsAccepted, value => setActionForm(previous => ({ ...previous, rightsAccepted: value })))}{(approved?.acceptedWarnings || []).map(key => <div key={key}>{check(warningList.find(item => item.key === key)?.message || key, actionForm.acceptedWarnings?.includes(key), value => setActionForm(previous => ({ ...previous, acceptedWarnings: value ? [...previous.acceptedWarnings, key] : previous.acceptedWarnings.filter(item => item !== key) })))}</div>)}{check('Acepto el riesgo de duplicación sólo para entregas sin ID remoto verificable. Las operaciones inciertas deben resolverse antes.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}{connection?.integrationMethod === 'browser' && campaign.mode === 'paid' && !approved && check('Acepto volver a preparar el borrador privado sin gasto; deberá aprobarse de nuevo antes de publicar.', actionForm.acceptPrivateDraft, value => setActionForm(previous => ({ ...previous, acceptPrivateDraft: value })))}</>}
      {['link-remote', 'confirm-absent'].includes(action.name) && <><p>Operación {action.operation.id} · {action.operation.step}. No se identifica una publicación sólo por texto/fecha.</p>{action.name === 'link-remote' ? <><Field field={{ name: 'remoteId', label: 'ID remoto existente', max: 100 }} value={actionForm.remoteId} onChange={value => setActionForm(previous => ({ ...previous, remoteId: value }))}/><Field field={{ name: 'permalink', label: 'Enlace permanente existente', type: 'url', max: 2048 }} value={actionForm.permalink} onChange={value => setActionForm(previous => ({ ...previous, permalink: value }))}/>{check('Verifiqué la cuenta, imagen o video, texto y contenido del objeto indicado; autorizo su comprobación remota.', actionForm.acceptContentVerification, value => setActionForm(previous => ({ ...previous, acceptContentVerification: value })))}</> : <>{check('Comprobé expresamente que el efecto remoto está ausente.', actionForm.confirmAbsence, value => setActionForm(previous => ({ ...previous, confirmAbsence: value })))}{check('Acepto el riesgo de duplicación al reintentar; Meta no garantiza ejecutar una sola vez.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}</>}</>}
      {['pause', 'cancel', 'link-remote', 'confirm-absent'].includes(action.name) && <Field field={{ name: 'reason', label: 'Motivo de la acción', type: 'textarea', max: 1000, required: ['link-remote', 'confirm-absent'].includes(action.name) }} value={actionForm.reason} onChange={value => setActionForm(previous => ({ ...previous, reason: value }))}/>}
      {action.name === 'cancel' && <p>Cancelar una agenda no enviada es local. Un anuncio emitido requiere pausa remota confirmada. El contenido publicado y su evidencia no se borran; un borrador privado en Meta puede permanecer sin ejecutor.</p>}
      <div className={styles.actions}><button type="submit" className="button primary" disabled={Boolean(invalid.controlRemaining) || ['activate-paid', 'resume'].includes(action.name) && (!actionForm.investmentAccepted || !Number.isSafeInteger(actionForm.remainingBudgetMinor)) || action.name === 'resume-restored' && (!actionForm.rightsAccepted || (approved?.acceptedWarnings || []).some(key => !actionForm.acceptedWarnings?.includes(key)) || campaign.mode === 'paid' && approved && !actionForm.investmentAccepted) || action.name === 'link-remote' && (!actionForm.acceptContentVerification || !actionForm.remoteId && !actionForm.permalink) || action.name === 'confirm-absent' && (!actionForm.confirmAbsence || !actionForm.acceptDuplicateRisk)}>Confirmar solicitud</button><button type="button" className="button subtle" onClick={() => { setAction(null); setInvalid(previous => ({ ...previous, controlRemaining: false })); }}>Volver sin ejecutar</button></div>
    </fieldset></form></section>}

    {operation && <p role="status" className={styles.notice}>Operación {operation.step || operation.kind} · {stateLabel(operation.state)} · {operation.id}{operation.nextAttemptAt ? ` · próxima ejecución ${date(operation.nextAttemptAt)}` : ''}{operation.lastError ? ` · ${errorText(operation.lastError)}` : ''}. El progreso se consulta localmente, no son nuevas llamadas a Meta.</p>}
    {campaign?.deliveries?.length > 0 && <section className={styles.panel}><h3>Estado por destino</h3>{campaign.deliveries.map(delivery => <article key={delivery.id} className={styles.card}><h4>{delivery.channel} · {stateLabel(delivery.state)}</h4><Values rows={[["Conexión", METHODS[delivery.integrationMethod || connection?.integrationMethod]], ['Último estado confirmado', stateLabel(delivery.lastConfirmedState)], ['Confirmación remota', date(delivery.lastConfirmedAt)], ['Siguiente consulta', date(delivery.nextSyncAt)], ['Último intento de resultados', date(delivery.metricSync?.lastAttemptAt)], ['ID remoto', delivery.remoteId || 'No confirmado']]}/>{delivery.lastError && <p className={styles.warning}>{errorText(delivery.lastError)}</p>}{delivery.remoteRefs?.permalink && /^https:\/\//.test(delivery.remoteRefs.permalink) && <a href={delivery.remoteRefs.permalink} target="_blank" rel="noopener noreferrer">Ver publicación confirmada en Meta</a>}{['scheduled', 'queued'].includes(delivery.state) && (spec.publishAt || spec.startAt) && Date.parse(spec.publishAt || spec.startAt) < Date.now() && <p className={styles.warning}>La hora prevista ya pasó; aún no consta confirmación. El procesamiento en segundo plano puede estar atrasado. Si supera 15 minutos antes del envío, requiere reprogramar mediante un nuevo borrador.</p>}</article>)}</section>}
    {campaign?.operations?.length > 0 && <details className={styles.technicalDetails} open={Boolean(uncertain)}><summary>Historial técnico de operaciones y recuperación</summary><p>Una respuesta perdida no autoriza otro clic de publicación. Primero comprueba el estado en Meta sin reenviar la intención original; si no existe una identificación inequívoca, usa una resolución explícita.</p>{campaign.operations.map(op => <article key={op.id} className={styles.card}><h4>{op.step} · {stateLabel(op.state)}</h4><p>{op.id} · {METHODS[op.integrationMethod]} · actualizado {date(op.updatedAt)} · próximo intento {date(op.nextAttemptAt)}</p>{op.lastError && <p className={styles.warning}>{errorText(op.lastError)}</p>}{['sent', 'uncertain'].includes(op.state) && <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile', op.deliveryId ? { deliveryId: op.deliveryId } : {})}>Comprobar estado en Meta sin reenviar esta intención</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('link-remote', op)}>Vincular ID o enlace permanente existente</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('confirm-absent', op)}>Confirmar ausencia y riesgo</button></div>}</article>)}</details>}
    </fieldset>
  </section>;
}
