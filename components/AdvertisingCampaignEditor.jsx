'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Field } from './Fields';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const STEPS = ['Vía, cuenta y objetivo', 'Pieza y texto', 'Audiencia y ubicaciones', 'Inversión y fechas', 'Estimación y confirmación'];
const OBJECTIVES = { whatsapp: 'Consultas por WhatsApp', traffic: 'Tráfico a la web (clics de enlace)', reach: 'Alcance', engagement: 'Interacción' };
const STATES = { draft: 'Borrador', ready: 'Preparada sin gasto autorizado', scheduled: 'Programada', publishing: 'En proceso', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Fallida', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Efecto incierto', blocked: 'Bloqueada', prepared: 'Intención registrada', sent: 'Enviada; falta confirmar', confirmed: 'Confirmada', retry_wait: 'En espera' };
const PLACEMENTS = { facebook_feed: 'Facebook · Feed', facebook_reels: 'Facebook · Reels', instagram_feed: 'Instagram · Feed', instagram_reels: 'Instagram · Reels' };
const METRICS = { impressions: 'Impresiones', reach: 'Alcance', linkClicks: 'Clics de enlace', conversations: 'Conversaciones', interactions: 'Interacciones', views: 'Visualizaciones', plays: 'Reproducciones' };
const METHODS = { api: 'API oficial', browser: 'Navegador / scraper' };
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
  if (!asset) return null;
  if (asset.state !== 'ready') return <p className={styles.warning}>La pieza está en estado {asset.state}; no hay un derivado listo verificable. Restaura o revisa el archivo en Piezas antes de publicar; su historia se conserva.</p>;
  const src = `${ROOT}/assets/${asset.id}/content?variant=derivative`;
  return <figure className={styles.assetPreview}>{failed ? <div role="alert" className={styles.error}><p>No se pudo cargar el derivado privado. Revisa la sesión y el archivo en Piezas; no se sustituirá por el original ni por otro medio.</p><button type="button" className="button subtle" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Volver a cargar vista previa</button></div> : asset.kind === 'video' ? <video key={attempt} className={styles.previewVideo} controls preload="metadata" src={src} onError={() => setFailed(true)}/> : <img key={attempt} className={styles.previewImage} src={src} onError={() => setFailed(true)} alt={`Derivado normalizado: ${asset.name || asset.originalName || 'pieza seleccionada'}`}/>}<figcaption>Derivado privado que se aprueba, no el original. {asset.width && asset.height ? `${asset.width}×${asset.height}` : ''}</figcaption></figure>;
}
function Configuration({ spec, connection, asset }) {
  const zone = spec.timeZone || (spec.mode === 'organic' ? 'America/Bogota' : connection?.timeZone);
  return <div className={styles.stack}>
    <Values rows={[
      ['Vía', METHODS[spec.integrationMethod || connection?.integrationMethod] || 'Sin seleccionar'], ['Cuenta', connection?.name || spec.connectionId || 'Sin seleccionar'],
      ['Identidades verificadas', Object.entries(spec.identities || connection?.identities || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'Sin verificar'],
      ['Modalidad', spec.mode === 'paid' ? 'Pauta pagada' : 'Publicación orgánica'], ['Objetivo', OBJECTIVES[spec.objective]],
      ['Redes', (spec.platforms || []).join(' · ') || 'Sin seleccionar'], ['Pieza normalizada', asset?.name || asset?.originalName || spec.assetId || 'Sin seleccionar'],
      ['Hash del derivado', spec.assetHash || asset?.sha256 || 'No disponible'], ['Texto', spec.caption || 'Sin texto'], ['Título', spec.headline || 'Sin título'],
      ['Destino', spec.destinationUrl || spec.whatsappNumber || 'Sin destino'], ['Bienvenida', spec.whatsappGreeting || 'No aplica'],
      ['Divulgación de IA', spec.aiDisclosure === null || spec.aiDisclosure === undefined ? 'Pendiente de declarar' : spec.aiDisclosure ? 'Sí contiene IA' : 'No contiene IA'],
      ['Ubicaciones', (spec.placements || []).map(key => PLACEMENTS[key] || key).join(' · ') || 'Sin seleccionar'],
      ['Inversión total', spec.mode === 'paid' ? money(spec.budgetMinor, spec.currency || connection?.currency) : 'Sin inversión'],
      ['Zona de publicación / cuenta', zone || 'Sin verificar'],
      ...(spec.mode === 'paid' ? [['Inicio en cuenta', date(spec.startAt, zone)], ['Fin en cuenta', date(spec.endAt, zone)], ...(zone && zone !== 'America/Bogota' ? [['Inicio en Bogotá', date(spec.startAt, 'America/Bogota')], ['Fin en Bogotá', date(spec.endAt, 'America/Bogota')]] : [])] : [['Publicación en Bogotá', spec.publishAt ? date(spec.publishAt, 'America/Bogota') : 'Inmediata al ejecutar el worker'], ['Horizonte de observación', `${spec.observationDays} días; no borra la publicación`]]),
      ...(spec.targetCostMinor != null ? [['Meta de costo del usuario', money(spec.targetCostMinor, spec.currency || connection?.currency)]] : [])
    ]}/>
    {spec.mode === 'paid' && <div><h4>Audiencia aprobada / propuesta</h4><p>Edad {spec.audience?.ageMin}–{spec.audience?.ageMax} · Géneros: {spec.audience?.genders?.length ? spec.audience.genders.map(g => g === 1 ? 'Hombres' : 'Mujeres').join(', ') : 'Todos'}.</p><ul>{(spec.audience?.countries || []).map(code => <li key={code}>{countryLabel(code)} · país completo</li>)}{['regions', 'cities', 'interests'].flatMap(group => (spec.audience?.[group] || []).map(ref => <li key={ref.key}>{ref.label} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} {ref.context?.region || ''}{ref.context?.radius != null ? ` · radio ${ref.context.radius} ${ref.context.distanceUnit === 'mile' ? 'millas' : 'km'}` : ''} · {METHODS[ref.source]}</li>))}</ul><p className={styles.help}>Sin listas de clientes ni condiciones de salud. No se autorizan ampliaciones automáticas de edad, geografía o ubicaciones.</p></div>}
  </div>;
}
function Forecast({ forecast }) {
  const audience = forecast?.audienceEstimate, ranges = Object.entries(forecast?.metricRanges || {}), manual = forecast?.manualScenario;
  return <div className={styles.stack}>
    <section className={styles.card}><h3>1. Audiencia potencial de Meta</h3><p>{audience?.status === 'reported' ? `${number(audience.lower)}–${number(audience.upper)}` : audience?.reason || 'Aún no se ha consultado una estimación para esta configuración.'}</p>{audience && <Values rows={[["Definición", audience.label || audience.definition], ['Horizonte informado por Meta', textValue(audience.horizon)], ['Fuente', audience.source], ['Consultado', date(audience.fetchedAt)], ['Versión', audience.apiVersion || audience.adapterVersion || 'No informada']]}/>}<p className={styles.help}>Tamaño potencial, alcance diario y entrega son conceptos distintos. No es alcance comprado ni una predicción de ventas.</p></section>
    <section className={styles.card}><h3>2. Rango histórico comparable</h3>{ranges.length ? <div className={styles.tableWrap}><table className={styles.table}><caption>Cuartiles de publicaciones comparables, por métrica y red</caption><thead><tr><th scope="col">Métrica</th><th scope="col">Q25–Q75</th><th scope="col">Mediana</th><th scope="col">Muestras</th></tr></thead><tbody>{ranges.map(([key, range]) => <tr key={key}><th scope="row">{METRICS[range.metric] || key} · {range.channel}</th><td>{number(range.lower)}–{number(range.upper)}</td><td>{number(range.median)}</td><td>{range.sampleCount}</td></tr>)}</tbody></table></div> : <p>Datos insuficientes: se necesitan al menos cinco campañas finalizadas comparables con cobertura, precisión y definición compatibles. No se inventa un rendimiento inicial.</p>}{forecast && <><p>{forecast.sampleCount ?? 0} campañas comparables utilizadas · {forecast.algorithmVersion} · {date(forecast.generatedAt)}</p>{forecast.unavailableReasons?.length > 0 && <details><summary>Datos faltantes por métrica</summary><ul>{forecast.unavailableReasons.map((item, i) => <li key={i}>{typeof item === 'string' ? item : `${item.metric}: ${item.sampleCount ?? 0} muestras; ${item.reason}`}</li>)}</ul></details>}<ul>{(forecast.assumptions || []).map(value => <li key={value}>{value}</li>)}</ul></>}</section>
    <section className={styles.card}><h3>3. Escenario declarado por el administrador</h3>{manual ? <><p>{METRICS[manual.metric?.split('.').at(-1)] || manual.metric}: {number(manual.lower)}–{number(manual.upper)}</p><p>{manual.basis}</p></> : <p>No se declaró un escenario manual.</p>}<p className={styles.help}>Hipótesis del usuario, no predicción del sistema, entrenamiento ni análisis visual de la pieza. No se inventa una mediana para este rango.</p></section>
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
  current.current = { formDirty, campaign, form, busy };
  const connection = connections.find(item => item.id === form.connectionId) || (campaign?.connection?.id === form.connectionId ? campaign.connection : null);
  const asset = assets.find(item => item.id === form.assetId) || (campaign?.asset?.id === form.assetId ? campaign.asset : null);
  const frozen = Boolean(campaign && (campaign.state !== 'draft' || campaign.revisions?.length));
  const uncertain = campaign?.operations?.some(item => ['sent', 'uncertain'].includes(item.state));
  const preflightPending = campaign?.operations?.some(item => !item.deliveryId && PENDING.includes(item.state));
  const pending = uncertain || preflightPending || campaign?.operations?.some(item => PENDING.includes(item.state)) || campaign?.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review'].includes(item.state));
  const approved = campaign?.revisions?.at(-1), forecast = frozen ? approved?.forecast : forecastChoice || campaign?.forecasts?.find(item => item.id === campaign.forecastId);
  const validation = campaign?.validation, warningList = validation?.warnings || [];
  const spec = frozen ? approved?.spec || campaign : validation?.spec || { ...form, integrationMethod: connection?.integrationMethod, currency: connection?.currency, timeZone: form.mode === 'paid' ? connection?.timeZone : 'America/Bogota' };
  const hold = campaign?.restore_hold || campaign?.restoreHold;
  const instruction = campaign?.recommendationInstructions;
  const primary = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' }[form.objective];
  const manualMetrics = form.mode === 'paid' ? [primary] : form.objective === 'whatsapp' ? [] : form.platforms.filter(network => !(network === 'instagram' && primary === 'linkClicks')).map(network => `${network}.${primary}`);

  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => () => { sequence.current++; for (const controller of requests.current) controller.abort(); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); }, []);
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
    if (!existing || current.current.formDirty || locked.current) return;
    let active = true; setLoading(true);
    loadDetail(existing, { openStep: !current.current.campaign }).catch(cause => { if (active && cause.name !== 'AbortError') setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; sequence.current++; };
  }, [api, existing, revision, retry]);
  useEffect(() => {
    if (!pending || !campaign?.id) return;
    let active = true, timer;
    const poll = async () => {
      if (!active) return;
      if (document.visibilityState === 'hidden' || locked.current) { timer = setTimeout(poll, 5000); return; }
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
  function setAudience(key, value) { set('audience', { ...form.audience, [key]: value }); }
  function selectConnection(value) {
    const next = connections.find(item => item.id === value), currencyChanged = connection?.currency !== next?.currency;
    setForm(previous => ({ ...previous, connectionId: value || null, audience: { ...previous.audience, regions: [], cities: [], interests: [] }, ...(currencyChanged ? { budgetMinor: 0, targetCostMinor: null } : {}) }));
    setCandidates([]); setOperation(null); setOperationId(null); setForecastChoice(null); setPrivateConsent(false); resetAcceptance();
    setNotice(currencyChanged ? 'Cambió la moneda: vuelve a ingresar y aceptar el presupuesto. Se retiraron referencias de la cuenta anterior.' : 'Las referencias y la preparación deben validarse para esta cuenta; no se trasladan objetos remotos.');
  }
  function changeMode(value) {
    setForm(previous => ({ ...previous, mode: value, budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null, publishAt: null, placements: [] })); setForecastChoice(null); resetAcceptance();
  }
  function changeAsset(value) {
    const selected = assets.find(item => item.id === value);
    setForm(previous => ({ ...previous, assetId: value || null, placements: previous.placements.filter(key => selected?.kind === 'image' ? key.endsWith('_feed') : previous.mode === 'organic' ? key.endsWith('_reels') : true) })); setForecastChoice(null); resetAcceptance();
  }
  async function task(fn) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await fn(); } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { locked.current = false; setBusy(false); }
  }
  async function notifyMutation() {
    try { await callbacks.current.onMutation?.(); } catch (cause) { setNotice(`La operación se guardó; la vista general está pendiente de actualizar. ${cause.message}`); }
  }
  async function persist() {
    if (!form.name.trim()) throw new Error('Escribe un nombre para poder guardar y retomar este borrador.');
    if (Object.values(invalid).some(Boolean)) throw new Error('Corrige el formato de los importes antes de guardar.');
    const target = campaign?.id || existing;
    if (target && !formDirty) return campaign;
    const payload = { ...form, version: target ? campaign?.version : 0 };
    const body = { ...payload, requestId: rid(`save:${target || 'new'}`, payload) };
    const result = await request(`${ROOT}/campaigns${target ? `/${encodeURIComponent(target)}` : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    // Mark the successfully committed form clean before refreshing its normalized representation.
    baseline.current = JSON.stringify(form); current.current.formDirty = false;
    const data = await loadDetail(result.id, { replace: true });
    setForecastChoice(null); resetAcceptance(); setNotice('Borrador guardado. No se publicó ni se autorizó gasto.');
    await notifyMutation();
    return data || { ...campaign, ...result };
  }
  async function save(event) { event?.preventDefault(); await task(async () => { const result = await persist(); callbacks.current.onSaved?.(result); }); }
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
      if (!connection?.id) throw new Error('Selecciona una conexión API vigente.');
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
  const dateInput = (key, label) => <label className="field">{label}<input name={key} type="datetime-local" value={localDate(form[key])} onChange={event => { const value = event.target.value; set(key, value ? new Date(value).toISOString() : null); }}/><small className={styles.help}>{form[key] ? `En ${form.mode === 'paid' ? connection?.timeZone || 'zona de cuenta sin verificar' : 'America/Bogota'}: ${date(form[key], form.mode === 'paid' ? connection?.timeZone : 'America/Bogota')}. Bogotá: ${date(form[key], 'America/Bogota')}.` : 'Sin fecha registrada.'}</small></label>;
  const formLocked = busy || loading || frozen || uncertain || preflightPending;
  const stepChange = value => { setStep(value); setError(''); };

  return <section className={styles.detail} aria-busy={busy || loading}>
    <header className={styles.heading}><div><p className={styles.eyebrow}>{frozen ? 'Configuración aprobada e inmutable' : 'Preparar una publicación'}</p><h2 ref={heading} tabIndex={-1}>{campaign?.name || 'Nueva publicación'} · {stateLabel(campaign?.state || 'draft')}</h2></div><button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'campaigns', record: null })}>Volver a campañas</button></header>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}<div className={styles.actions}>{existing && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => setRetry(value => value + 1)}>Recargar datos guardados</button>}<button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'connections', record: connection?.id || null })}>Revisar conexión</button></div>{formDirty && <p>Tus cambios locales se conservaron; no se reemplazan al actualizar.</p>}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {loading && <p role="status">{campaign ? 'Actualizando datos guardados…' : 'Cargando publicación…'}</p>}
    {hold && <p className={styles.warning}>Bloqueo de restauración: reconectar no autoriza reenvíos. Reconcilia los efectos remotos y acepta explícitamente la recuperación. Restaurar la base de datos no detiene anuncios activos.</p>}
    {instruction && <aside className={styles.notice}><h3>Prueba propuesta para la próxima publicación</h3><p>{instruction.text}</p>{instruction.postingWindow && <p>Franja sugerida: {textValue(instruction.postingWindow)}. Elige tú una fecha; no se programa automáticamente.</p>}<p>Campaña de origen: {campaign.parentCampaignId}. Conserva el monto aprobado; aporta la pieza o edita el texto solicitado antes de confirmar.</p></aside>}
    {!frozen && <nav aria-label="Pasos de preparación" className={styles.steps}>{STEPS.map((label, index) => <button type="button" key={label} className={`${styles.stepButton} ${step === index ? styles.stepActive : ''}`} aria-current={step === index ? 'step' : undefined} disabled={busy} onClick={() => stepChange(index)}>{index + 1}. {label}</button>)}</nav>}

    {!frozen && <form method="post" onSubmit={save} className={styles.stack}>
      <fieldset disabled={formLocked} className="editor-fieldset"><legend>{step + 1}. {STEPS[step]}</legend>
        {step === 0 && <div className={styles.stack}>
          <div className={styles.fieldGrid}>{field('name', 'Nombre de la publicación', { required: true, max: 200 })}<label className="field">Vía y cuenta<select name="connectionId" value={form.connectionId || ''} onChange={event => selectConnection(event.target.value)}><option value="">Selecciona una conexión</option>{connections.map(item => <option key={item.id} value={item.id}>{METHODS[item.integrationMethod]} · {item.name || item.identities?.pageId || item.id} · {item.state}</option>)}{form.connectionId && !connections.some(item => item.id === form.connectionId) && <option value={form.connectionId}>{campaign?.connection?.name || 'Conexión guardada'} · revisar disponibilidad</option>}</select></label>{field('mode', 'Modalidad', { type: 'select', options: [{ value: 'organic', label: 'Orgánico · sin inversión' }, { value: 'paid', label: 'Pauta pagada · total con inicio y fin' }] })}</div>
          <p className={styles.help}>La vía queda congelada al aprobar. No existe cambio automático entre API y navegador. Para cambiarla después, duplica en borrador sin reutilizar objetos remotos.</p>
          {form.mode === 'paid' && (form.startAt || form.publishAt) && <p className={styles.help}>Al cambiar modalidad se deben revisar inversión y agenda.</p>}
          <label className="field">Objetivo comercial<select name="objective" value={form.objective} onChange={event => set('objective', event.target.value)}>{Object.entries(OBJECTIVES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><p className={styles.help}>Alcance e interacción son prioridades distintas: elige una. Tráfico mide clics, no visitas confirmadas. No hay píxel, seguimiento automático de ventas ni lectura de conversaciones.</p>
          <fieldset><legend>Redes</legend>{['facebook', 'instagram'].map(network => check(network === 'facebook' ? 'Facebook · página' : 'Instagram · cuenta profesional', form.platforms.includes(network), enabled => { setForm(previous => ({ ...previous, platforms: enabled ? [...previous.platforms, network] : previous.platforms.filter(value => value !== network), placements: enabled ? previous.placements : previous.placements.filter(key => !key.startsWith(`${network}_`)) })); resetAcceptance(); setForecastChoice(null); }))}</fieldset>
          {connection && <Values rows={[["Vía elegida", METHODS[connection.integrationMethod]], ['Estado de conexión', connection.state], ['Moneda de cuenta', connection.currency || 'Sin verificar'], ['Zona de cuenta', connection.timeZone || 'Sin verificar'], ['Capacidades verificadas', Object.entries(connection.capabilities || {}).filter(([, value]) => value === true).map(([key]) => key).join(' · ') || 'Ninguna acreditada']]}/>}
          {!connections.length && <div className="admin-empty"><h3>Primero conecta una cuenta</h3><p>Puedes guardar el nombre del borrador y retomar después. Cada vía tiene requisitos y autenticación independientes.</p></div>}
          <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'connections', record: null })}>Ir a conexiones (guarda antes si quieres retomar)</button>
        </div>}
        {step === 1 && <div className={styles.stack}>
          <p>Imágenes JPEG/PNG/WebP, hasta 10 MiB, sin animación; derivado JPEG, relación 4:5 a 1,91:1, ancho mínimo 320. Video MP4/MOV hasta 250 MiB, vertical 9:16, mínimo 540×960 y 3–90 segundos. No se recorta ni genera la pieza.</p>
          <label className="field">Pieza lista para publicar<select name="assetId" value={form.assetId || ''} onChange={event => changeAsset(event.target.value)}><option value="">Selecciona un derivado listo</option>{assets.filter(item => item.state === 'ready').map(item => <option key={item.id} value={item.id}>{item.name || item.originalName || item.id} · {item.kind === 'video' ? 'Video' : 'Imagen'}</option>)}{form.assetId && !assets.some(item => item.id === form.assetId && item.state === 'ready') && <option value={form.assetId}>Pieza guardada no disponible · {asset?.state || 'revisar'}</option>}</select></label>
          <AssetPreview key={asset?.id || 'none'} asset={asset}/>
          {!assets.some(item => item.state === 'ready') && <p className={styles.empty}>No hay piezas listas. Guarda el borrador y sube una pieza compatible; el procesamiento ocurre fuera del navegador.</p>}
          <button type="button" className="button subtle" onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'assets', record: null })}>Subir o revisar piezas (guarda antes)</button>
          {field('caption', 'Texto que acompaña la pieza', { type: 'textarea', max: 2200 })}{field('headline', 'Título / CTA', { max: 40 })}
          {form.objective === 'traffic' && field('destinationUrl', 'URL de destino', { type: 'url', max: 2048 })}
          {form.objective === 'whatsapp' && <>{field('whatsappNumber', 'WhatsApp vinculado a la página (formato internacional +)', { max: 16 })}{field('whatsappGreeting', 'Bienvenida explícita de WhatsApp', { type: 'textarea', max: 1024 })}<p className={styles.help}>El número debe coincidir con el recurso verificado en Meta. El teléfono de la vitrina no acredita capacidad de pauta.</p></>}
          <label className="field">¿La pieza contiene contenido generado con IA?<select name="aiDisclosure" value={form.aiDisclosure === null ? '' : String(form.aiDisclosure)} onChange={event => set('aiDisclosure', event.target.value === '' ? null : event.target.value === 'true')}><option value="">Declara explícitamente</option><option value="false">No</option><option value="true">Sí; requiere divulgación verificable en la vía elegida</option></select></label>
          {form.mode === 'organic' && form.platforms.includes('instagram') && ['traffic', 'whatsapp'].includes(form.objective) && <p className={styles.warning}>En Instagram orgánico, los enlaces del texto no son CTA clicables. No se promete medir consultas o tráfico por publicación.</p>}
        </div>}
        {step === 2 && <div className={styles.stack}>
          {form.mode === 'organic' ? <p className={styles.notice}>Orgánico no compra audiencia. Se distribuye públicamente según la página/cuenta y la red; no se garantiza segmentación ni alcance.</p> : <>
            <p>Mayores de 18 años. Sin datos de clientes, públicos personalizados ni condiciones de salud. No superpongas país completo con sus regiones/ciudades ni una región con sus ciudades.</p>
            <label className="field">País completo<select name="country" value={country} onChange={event => setCountry(event.target.value)}><option value="">Selecciona un país ISO</option>{COUNTRIES.map(code => <option key={code} value={code}>{countryLabel(code)}</option>)}</select></label><button type="button" className="button subtle" disabled={!country} onClick={addCountry}>Añadir país completo</button>
            <ul>{form.audience.countries.map(code => <li key={code}>{countryLabel(code)} <button type="button" className="text-button" onClick={() => setAudience('countries', form.audience.countries.filter(value => value !== code))}>Quitar país {code}</button></li>)}</ul>
            <div className={styles.fieldGrid}><Field field={{ name: 'ageMin', label: 'Edad mínima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMin} onChange={value => setAudience('ageMin', value)}/><Field field={{ name: 'ageMax', label: 'Edad máxima (18–65)', type: 'number', min: 18 }} value={form.audience.ageMax} onChange={value => setAudience('ageMax', value)}/></div>
            <fieldset><legend>Géneros (ninguno seleccionado = todos)</legend>{[[1, 'Hombres'], [2, 'Mujeres']].map(([value, label]) => check(label, form.audience.genders.includes(value), checked => setAudience('genders', checked ? [...form.audience.genders, value] : form.audience.genders.filter(item => item !== value))))}</fieldset>
            {['regions', 'cities', 'interests'].map(group => <section key={group}><h4>{{ regions: 'Regiones verificadas', cities: 'Ciudades y radio explícito', interests: 'Intereses verificados' }[group]}</h4>{!form.audience[group].length && <p className={styles.muted}>Sin selección.</p>}{form.audience[group].map(ref => <div className={styles.card} key={ref.key}><p>{ref.label} · {ref.context.countryCode || ref.context.scope || ref.context.path?.join(' / ')} · {ref.context.region || ''}</p>{group === 'cities' && <div className={styles.fieldGrid}><label className="field">Radio explícito<input type="number" min={ref.context.distanceUnit === 'mile' ? 10 : 17} max={ref.context.distanceUnit === 'mile' ? 50 : 80} step="1" value={ref.context.radius ?? ''} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, radius: event.target.value === '' ? undefined : Number(event.target.value), distanceUnit: item.context.distanceUnit || 'kilometer' } } : item))}/></label><label className="field">Unidad<select value={ref.context.distanceUnit || 'kilometer'} onChange={event => setAudience(group, form.audience[group].map(item => item.key === ref.key ? { ...item, context: { ...item.context, distanceUnit: event.target.value, radius: undefined } } : item))}><option value="kilometer">Kilómetros (17–80)</option><option value="mile">Millas (10–50)</option></select></label></div>}<button type="button" className="text-button" onClick={() => setAudience(group, form.audience[group].filter(item => item.key !== ref.key))}>Quitar {ref.label}</button></div>)}</section>)}
            <p className={styles.help}>Busca y selecciona referencias oficiales debajo de este formulario. Un nombre escrito no se convierte en ID. Los candidatos nativos quedan ligados al negocio y deben coincidir inequívocamente al reabrir.</p>
          </>}
          <fieldset><legend>Ubicaciones explícitas compatibles</legend>{Object.entries(PLACEMENTS).filter(([key]) => form.platforms.some(network => key.startsWith(`${network}_`)) && (asset?.kind === 'image' ? key.endsWith('_feed') : asset?.kind === 'video' && form.mode === 'organic' ? key.endsWith('_reels') : true)).map(([key, label]) => check(label, form.placements.includes(key), checked => set('placements', checked ? [...form.placements, key] : form.placements.filter(value => value !== key))))}</fieldset><p className={styles.help}>Una imagen sólo en feed; video orgánico en Reels (Instagram también comparte al feed). No Stories, carrusel, Messenger, Audience Network ni WhatsApp Status.</p>
        </div>}
        {step === 3 && <div className={styles.stack}>
          <p className={styles.notice}>Los controles de fecha y hora usan la zona del dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Debajo se muestra su equivalencia real en la cuenta y Bogotá. Se guardan instantes UTC, no horas locales disfrazadas de UTC.</p>
          {form.mode === 'paid' ? <><Values rows={[["Moneda no editable", connection?.currency || 'Selecciona cuenta con moneda verificada'], ['Zona de cuenta', connection?.timeZone || 'Sin verificar']]}/><div className={styles.fieldGrid}>{amount('budgetMinor', 'Presupuesto TOTAL de campaña')}{amount('targetCostMinor', 'Meta opcional de costo por resultado (del usuario)')}{dateInput('startAt', 'Inicio (hora del dispositivo)')}{dateInput('endAt', 'Fin (hora del dispositivo)')}</div><p>Un conjunto y un anuncio comparten un único total, incluso con dos redes. Inicio futuro, fin posterior, máximo 90 días. No se acepta presupuesto diario abierto. Impuestos/cargos pueden ser adicionales.</p>{connection?.currency === 'COP' && form.budgetMinor % 100 !== 0 && <p role="alert" className={styles.error}>COP exige un total de pesos enteros representable por Meta. Corrige los centavos; no se redondeará.</p>}<p className={styles.help}>Guardar y preparar NO activan pauta. La activación y cada reanudación requieren una aceptación separada del restante real y las fechas originales.</p></> : <>{dateInput('publishAt', 'Publicación programada opcional (hora del dispositivo)')}<p>Vacío = publicar cuando el worker procese la aprobación. La agenda es local; cerrar el panel no cancela el trabajo. Un atraso superior a 15 minutos exige intervención, no publicar una promoción vencida.</p>{field('observationDays', 'Horizonte de observación', { type: 'select', options: [7, 14, 28].map(value => ({ value, label: `${value} días` })) })}<p>Sin inversión ni promesa de entrega. El horizonte evalúa resultados; no borra contenido.</p></>}
        </div>}
        {step === 4 && <div className={styles.stack}><h3>Resumen de la configuración {formDirty ? 'local sin guardar' : 'guardada'}</h3><Configuration spec={formDirty ? { ...form, currency: connection?.currency, integrationMethod: connection?.integrationMethod } : spec} connection={connection} asset={asset}/>{validation?.errors?.length > 0 && <div className={styles.warning}><h3>Requisitos pendientes del servidor</h3><ul>{validation.errors.map((item, index) => <li key={index}>{errorText(item)}</li>)}</ul></div>}<p>No se analiza visualmente la pieza ni se garantizan resultados. Primero guarda, valida la preparación nativa si aplica y estima; después acepta la versión exacta.</p></div>}
      </fieldset>
      <div className={styles.actions}>{step > 0 && <button type="button" className="button subtle" disabled={busy} onClick={() => stepChange(step - 1)}>Anterior</button>}<button type="submit" className="button subtle" disabled={formLocked || !form.name.trim()}>Guardar borrador incompleto</button>{step < 4 && <button type="button" className="button primary" disabled={busy} onClick={() => stepChange(step + 1)}>Continuar</button>}</div>
    </form>}

    {!frozen && form.mode === 'paid' && step === 2 && <section className={styles.panel}><h3>Buscar audiencia por {METHODS[connection?.integrationMethod] || 'vía seleccionada'}</h3>{connection?.integrationMethod === 'browser' && <p>La búsqueda usa un borrador privado previamente consentido. Prepáralo debajo; no se utiliza Graph API ni se publica para obtener candidatos.</p>}<form method="post" onSubmit={searchAudience} className={styles.stack}><fieldset disabled={busy || loading || preflightPending || uncertain || !connection}><legend>Búsqueda oficial</legend><div className={styles.fieldGrid}><label className="field">Tipo<select name="kind" value={searchKind} onChange={event => { setSearchKind(event.target.value); setCandidates([]); }}><option value="location">Región o ciudad</option><option value="interest">Interés</option></select></label><label className="field">Buscar por nombre<input name="q" type="search" maxLength={100} minLength={2} value={search} onChange={event => setSearch(event.target.value)}/></label></div><button type="submit" className="button subtle" disabled={search.trim().length < 2 || connection?.integrationMethod === 'browser' && !campaign?.preflight?.remoteDraftRef}>Buscar candidatos verificados</button></fieldset></form><ul className={styles.choiceList}>{candidates.map(ref => <li key={ref.key}><span>{ref.label} · {ref.context?.type} · {ref.context?.countryCode || ref.context?.scope || ref.context?.path?.join(' / ')} · {ref.context?.region || ''}</span><button type="button" className="button subtle" disabled={formLocked} onClick={() => addReference(ref)}>Seleccionar {ref.label}</button></li>)}</ul></section>}

    {!frozen && connection?.integrationMethod === 'browser' && form.mode === 'paid' && <section className={styles.panel}><h3>Preparación privada en Meta · navegador</h3><p>Puede guardar un borrador nativo en Ads Manager. No publica ni activa inversión; no autoriza sustituir pieza, objetivo, presupuesto o ubicaciones. Cualquier edición invalida el resumen efectivo anterior.</p>{!campaign?.preflight?.remoteDraftRef && check('Acepto crear un borrador privado recuperable, sin publicación ni gasto.', privateConsent, setPrivateConsent, busy)}<div className={styles.actions}>{!campaign?.preflight?.remoteDraftRef ? <button type="button" className="button subtle" disabled={busy || preflightPending || uncertain || hold || !privateConsent || !form.name.trim()} onClick={() => preflight('prepare')}>Guardar y preparar borrador privado</button> : <button type="button" className="button subtle" disabled={busy || preflightPending || uncertain || hold} onClick={() => preflight('validate')}>Guardar y validar el mismo borrador</button>}</div>{campaign?.preflight?.remoteDraftRef && <p>Referencia recuperable: {campaign.preflight.remoteDraftRef} · {campaign.preflight.adapterVersion} · comprobada {date(campaign.preflight.checkedAt)}.</p>}{campaign?.preflight?.observedSpec && <details><summary>Resumen efectivo leído en Meta antes de aprobar</summary><Configuration spec={campaign.preflight.observedSpec} connection={connection} asset={asset}/></details>}{campaign?.preflight?.kind === 'validate' && <p className={styles.notice}>La validación privada debe conservar exactamente la misma configuración y pieza al aprobar. Es un borrador, no una pauta activa.</p>}</section>}

    {!frozen && step === 4 && <section className={styles.stack} aria-labelledby={`${id}-forecast`}><h3 id={`${id}-forecast`}>Estimar sin inventar resultados</h3><form method="post" onSubmit={event => { event.preventDefault(); void estimate(); }} className={styles.panel}><fieldset disabled={busy || loading || preflightPending || uncertain || hold}><legend>Estimación para la configuración guardada</legend>{check('Quiero agregar un escenario declarado opcional (no es una predicción del sistema).', manualEnabled, setManualEnabled)}{manualEnabled && <div className={styles.fieldGrid}><label className="field">Métrica primaria<select name="manualMetric" value={manual.metric} onChange={event => setManual(previous => ({ ...previous, metric: event.target.value }))}><option value="">Selecciona una métrica compatible</option>{manualMetrics.map(key => <option key={key} value={key}>{key.includes('.') ? `${key.split('.')[0]} · ` : ''}{METRICS[key.split('.').at(-1)]}</option>)}</select></label><label className="field">Límite inferior<input name="manualLower" type="number" min="0" step="any" value={manual.lower} onChange={event => setManual(previous => ({ ...previous, lower: event.target.value }))}/></label><label className="field">Límite superior<input name="manualUpper" type="number" min="0" step="any" value={manual.upper} onChange={event => setManual(previous => ({ ...previous, upper: event.target.value }))}/></label><label className="field">Fundamento explícito<textarea name="manualBasis" maxLength={2000} value={manual.basis} onChange={event => setManual(previous => ({ ...previous, basis: event.target.value }))}/></label>{!manualMetrics.length && <p>No hay una métrica primaria automática compatible con este objetivo orgánico.</p>}</div>}<button type="submit" className="button subtle" disabled={!form.name.trim()}>Guardar y obtener estimación</button></fieldset></form><Forecast forecast={formDirty ? null : forecast}/><section className={styles.panel}><h3>Confirmación exacta</h3>{formDirty && <p className={styles.warning}>Hay cambios sin guardar. La previsión anterior no autoriza esta configuración.</p>}<fieldset disabled={busy || formDirty || !forecast?.id || !validation?.valid || hold || preflightPending || uncertain}><legend>Autorización de la revisión</legend>{check('Confirmo derechos sobre la pieza y su audio, y que revisé el derivado normalizado.', rights, setRights)}{warningList.map(item => <div key={item.key}>{check(item.message, warningsAccepted.includes(item.key), checked => setWarningsAccepted(previous => checked ? [...previous, item.key] : previous.filter(key => key !== item.key)))}</div>)}{instruction?.needsConfirmation && check('Aporté o edité el cambio solicitado, revisé la instrucción de la recomendación y acepto esta prueba sin aumentar el presupuesto.', recommendationAccepted, setRecommendationAccepted)}{form.mode === 'paid' && check(`Confirmo ${money(form.budgetMinor, connection?.currency)} como presupuesto TOTAL y las fechas mostradas. Sólo autorizo preparar, NO activar gasto.`, investment, setInvestment)}<p className={styles.help}>Especificación: {forecast?.specHash || 'Primero obtén una estimación'} · previsión: {forecast?.id || 'Sin previsión'}.</p><button type="button" className="button primary" disabled={!rights || warningList.some(item => !warningsAccepted.includes(item.key)) || form.mode === 'paid' && !investment || instruction?.needsConfirmation && !recommendationAccepted || connection?.integrationMethod === 'browser' && form.mode === 'paid' && campaign?.preflight?.kind !== 'validate'} onClick={approve}>{form.mode === 'paid' ? 'Aprobar y preparar sin gasto' : form.publishAt ? 'Aprobar publicación programada' : 'Aprobar publicación orgánica'}</button></fieldset>{!validation?.valid && <p className={styles.help}>Completa los requisitos de validación del servidor antes de aprobar; guardar un borrador incompleto sigue disponible.</p>}</section></section>}

    {frozen && <section className={styles.panel}><h3>Revisión aprobada · {approved?.revision}</h3><p>Vía y configuración congeladas. Para corregirlas, cancela lo aún no enviado y duplica en borrador. No se edita una revisión pendiente.</p><Configuration spec={spec} connection={campaign.connection} asset={campaign.asset}/><AssetPreview key={campaign.asset?.id || 'none'} asset={campaign.asset}/><details><summary>Estimación conservada al aprobar</summary><Forecast forecast={approved?.forecast}/></details></section>}

    {campaign && <section className={styles.panel}><h3>Operación y recuperación</h3>{campaign.state === 'ready' && <p className={styles.notice}>{connection?.integrationMethod === 'browser' ? 'Borrador nativo de Meta sin entrega.' : 'Objetos preparados en PAUSED.'} Preparada no significa activa; falta autorización expresa.</p>}<div className={styles.actions}><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('duplicate')}>Duplicar en nuevo borrador</button>{campaign.deliveries?.length > 0 || uncertain ? <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile')}>Reconciliar estado remoto sin reenviar</button> : null}{campaign.deliveries?.length > 0 && <><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('sync')}>Solicitar métricas (mínimo 15 min)</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('analyze')}>Solicitar análisis</button><button type="button" className="button subtle" disabled={busy} onClick={() => callbacks.current.onNavigate?.({ section: 'advertising', tab: 'results', record: campaign.id })}>Ver resultados y evidencia</button></>}{!['cancelled', 'completed'].includes(campaign.state) && <button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('cancel')}>Cancelar trabajo / detener pauta</button>}{campaign.mode === 'paid' && campaign.deliveries?.some(item => item.remoteId || item.remoteRefs?.campaignId) && <button type="button" className="button subtle" disabled={busy} onClick={() => openAction('pause')}>Pausar para detener gasto</button>}{campaign.state === 'ready' && campaign.mode === 'paid' && <button type="button" className="button primary" disabled={busy || hold} onClick={() => openAction('activate-paid')}>Revisar y autorizar activación</button>}{campaign.state === 'paused' && campaign.mode === 'paid' && <button type="button" className="button primary" disabled={busy || hold} onClick={() => openAction('resume')}>Revisar y autorizar reanudación</button>}{hold && <button type="button" className="button subtle" disabled={busy || formDirty || uncertain} onClick={() => openAction('resume-restored')}>Revisar recuperación explícita</button>}</div><p className={styles.help}>Sin acceso vigente no se puede afirmar pausa: detén la pauta directamente en Meta. La pausa segura no depende de una pieza disponible ni de habilitar nuevas publicaciones.</p></section>}

    {action && <section className={styles.panel}><h3 ref={actionHeading} tabIndex={-1}>{{ 'activate-paid': 'Autorizar gasto por primera vez', resume: 'Autorizar reanudación', pause: 'Solicitar pausa remota', cancel: 'Cancelar trabajo o pausar pauta emitida', 'resume-restored': 'Reconciliar y aceptar recuperación', 'link-remote': 'Vincular un objeto remoto existente', 'confirm-absent': 'Confirmar ausencia y riesgo antes de reintentar' }[action.name]}</h3><form method="post" onSubmit={submitAction}><fieldset disabled={busy}><legend>Confirmación explícita de la acción</legend>
      {['activate-paid', 'resume', 'resume-restored'].includes(action.name) && <><Values rows={[["Total original", money(spec.budgetMinor, spec.currency || connection?.currency)], ['Inicio original en cuenta', date(spec.startAt, spec.timeZone || connection?.timeZone)], ['Fin original en cuenta', date(spec.endAt, spec.timeZone || connection?.timeZone)]]}/>{campaign.mode === 'paid' && <><Field field={{ name: 'remainingBudgetMinor', label: `Presupuesto restante observado en Meta (${spec.currency || connection?.currency || 'sin moneda'})`, type: 'moneyOptionalMinor', description: 'Punto para miles y coma para centavos. Se comprobará contra una lectura remota; no se deduce del gasto local ni se amplía el total.' }} value={actionForm.remainingBudgetMinor} onChange={value => setActionForm(previous => ({ ...previous, remainingBudgetMinor: value }))} onDraftInvalid={value => setInvalid(previous => ({ ...previous, controlRemaining: value }))}/><p>Última lectura presupuestaria: {date(campaign.deliveries?.find(item => item.channel === 'meta_ads')?.budgetSnapshot?.checkedAt)}. Si falta o cambió, reconcilia y vuelve a revisar.</p>{check('Acepto expresamente el presupuesto restante indicado, la moneda y las fechas originales, sin aumentar total ni extender fin.', actionForm.investmentAccepted, value => setActionForm(previous => ({ ...previous, investmentAccepted: value })))}</>}<p>La solicitud encola una operación; no confirma que Meta haya activado o reanudado. Se vuelve a verificar identidad, referencias y configuración antes de enviar.</p></>}
      {action.name === 'resume-restored' && <>{check('Confirmo los derechos actuales sobre la pieza/audio y la revisión recuperada.', actionForm.rightsAccepted, value => setActionForm(previous => ({ ...previous, rightsAccepted: value })))}{(approved?.acceptedWarnings || []).map(key => <div key={key}>{check(warningList.find(item => item.key === key)?.message || key, actionForm.acceptedWarnings?.includes(key), value => setActionForm(previous => ({ ...previous, acceptedWarnings: value ? [...previous.acceptedWarnings, key] : previous.acceptedWarnings.filter(item => item !== key) })))}</div>)}{check('Acepto el riesgo de duplicación sólo para entregas sin ID remoto verificable. Las operaciones inciertas deben resolverse antes.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}{connection?.integrationMethod === 'browser' && campaign.mode === 'paid' && !approved && check('Acepto volver a preparar el borrador privado sin gasto; deberá aprobarse de nuevo antes de publicar.', actionForm.acceptPrivateDraft, value => setActionForm(previous => ({ ...previous, acceptPrivateDraft: value })))}</>}
      {['link-remote', 'confirm-absent'].includes(action.name) && <><p>Operación {action.operation.id} · {action.operation.step}. No se identifica una publicación sólo por texto/fecha.</p>{action.name === 'link-remote' ? <><Field field={{ name: 'remoteId', label: 'ID remoto existente', max: 100 }} value={actionForm.remoteId} onChange={value => setActionForm(previous => ({ ...previous, remoteId: value }))}/><Field field={{ name: 'permalink', label: 'Permalink existente', type: 'url', max: 2048 }} value={actionForm.permalink} onChange={value => setActionForm(previous => ({ ...previous, permalink: value }))}/>{check('Verifiqué la cuenta, pieza, texto y contenido del objeto indicado; autorizo su comprobación remota.', actionForm.acceptContentVerification, value => setActionForm(previous => ({ ...previous, acceptContentVerification: value })))}</> : <>{check('Comprobé expresamente que el efecto remoto está ausente.', actionForm.confirmAbsence, value => setActionForm(previous => ({ ...previous, confirmAbsence: value })))}{check('Acepto el riesgo de duplicación al reintentar; no existe garantía exactly-once en Meta.', actionForm.acceptDuplicateRisk, value => setActionForm(previous => ({ ...previous, acceptDuplicateRisk: value })))}</>}</>}
      {['pause', 'cancel', 'link-remote', 'confirm-absent'].includes(action.name) && <Field field={{ name: 'reason', label: 'Motivo de la acción', type: 'textarea', max: 1000, required: ['link-remote', 'confirm-absent'].includes(action.name) }} value={actionForm.reason} onChange={value => setActionForm(previous => ({ ...previous, reason: value }))}/>}
      {action.name === 'cancel' && <p>Cancelar una agenda no enviada es local. Una pauta emitida requiere pausa remota confirmada. El contenido publicado y su evidencia no se borran; un borrador nativo puede permanecer sin ejecutor.</p>}
      <div className={styles.actions}><button type="submit" className="button primary" disabled={Boolean(invalid.controlRemaining) || ['activate-paid', 'resume'].includes(action.name) && (!actionForm.investmentAccepted || !Number.isSafeInteger(actionForm.remainingBudgetMinor)) || action.name === 'resume-restored' && (!actionForm.rightsAccepted || (approved?.acceptedWarnings || []).some(key => !actionForm.acceptedWarnings?.includes(key)) || campaign.mode === 'paid' && approved && !actionForm.investmentAccepted) || action.name === 'link-remote' && (!actionForm.acceptContentVerification || !actionForm.remoteId && !actionForm.permalink) || action.name === 'confirm-absent' && (!actionForm.confirmAbsence || !actionForm.acceptDuplicateRisk)}>Confirmar solicitud</button><button type="button" className="button subtle" onClick={() => { setAction(null); setInvalid(previous => ({ ...previous, controlRemaining: false })); }}>Volver sin ejecutar</button></div>
    </fieldset></form></section>}

    {operation && <p role="status" className={styles.notice}>Operación {operation.step || operation.kind} · {stateLabel(operation.state)} · {operation.id}{operation.nextAttemptAt ? ` · próxima ejecución ${date(operation.nextAttemptAt)}` : ''}{operation.lastError ? ` · ${errorText(operation.lastError)}` : ''}. El progreso se consulta localmente, no son nuevas llamadas a Meta.</p>}
    {campaign?.deliveries?.length > 0 && <section className={styles.panel}><h3>Estado por destino</h3>{campaign.deliveries.map(delivery => <article key={delivery.id} className={styles.card}><h4>{delivery.channel} · {stateLabel(delivery.state)}</h4><Values rows={[["Vía", METHODS[delivery.integrationMethod || connection?.integrationMethod]], ['Último estado confirmado', stateLabel(delivery.lastConfirmedState)], ['Confirmación remota', date(delivery.lastConfirmedAt)], ['Siguiente consulta', date(delivery.nextSyncAt)], ['Último intento de métricas', date(delivery.metricSync?.lastAttemptAt)], ['ID remoto', delivery.remoteId || 'No confirmado']]}/>{delivery.lastError && <p className={styles.warning}>{errorText(delivery.lastError)}</p>}{delivery.remoteRefs?.permalink && /^https:\/\//.test(delivery.remoteRefs.permalink) && <a href={delivery.remoteRefs.permalink} target="_blank" rel="noopener noreferrer">Ver publicación confirmada en Meta</a>}{['scheduled', 'queued'].includes(delivery.state) && (spec.publishAt || spec.startAt) && Date.parse(spec.publishAt || spec.startAt) < Date.now() && <p className={styles.warning}>La hora prevista ya pasó; aún no consta confirmación. El worker puede estar atrasado. Si supera 15 minutos antes del envío, requiere reprogramar mediante un nuevo borrador.</p>}</article>)}</section>}
    {campaign?.operations?.length > 0 && <section className={styles.panel}><h3>Historial de operaciones y recuperación</h3><p>Una respuesta perdida no autoriza otro clic de publicación. Primero reconcilia la intención original; si no existe una identificación inequívoca, usa una resolución explícita.</p>{campaign.operations.map(op => <article key={op.id} className={styles.card}><h4>{op.step} · {stateLabel(op.state)}</h4><p>{op.id} · {METHODS[op.integrationMethod]} · actualizado {date(op.updatedAt)} · próximo intento {date(op.nextAttemptAt)}</p>{op.lastError && <p className={styles.warning}>{errorText(op.lastError)}</p>}{['sent', 'uncertain'].includes(op.state) && <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => campaignAction('reconcile', op.deliveryId ? { deliveryId: op.deliveryId } : {})}>Reconciliar esta intención sin reenviar</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('link-remote', op)}>Vincular ID / permalink existente</button><button type="button" className="button subtle" disabled={busy || formDirty} onClick={() => openAction('confirm-absent', op)}>Confirmar ausencia y riesgo</button></div>}</article>)}</section>}
  </section>;
}
