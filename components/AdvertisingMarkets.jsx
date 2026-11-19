'use client';

import { useEffect, useRef, useState } from 'react';
import { SOCIAL_COUNTRY_CODES } from '../lib/social/market-countries.mjs';
import AdvertisingSelectionDialog from './AdvertisingSelectionDialog';
import styles from './AdvertisingWorkspace.module.css';

const names = new Intl.DisplayNames(['es'], { type: 'region' });
export const countryLabel = code => `${names.of(code) || code} (${code})`;
const countryOptions = SOCIAL_COUNTRY_CODES.map(value => ({ value, label: countryLabel(value) })).sort((a, b) => a.label.localeCompare(b.label, 'es'));
export const AUDIENCE_SOURCE = { automatic: 'Definida con IA', manual: 'Definida manualmente', broad: 'Público amplio elegido por el operador' };

export function MarketPicker({ value, onChange, paid, historical, triggerId, disabled }) {
  return <AdvertisingSelectionDialog triggerId={triggerId} title="¿En qué país o países quieres publicar?" triggerLabel="Elegir mercados"
    options={countryOptions} value={value} onChange={selection => onChange([...selection].sort())} disabled={disabled}
    emptySummary="Ningún país elegido" searchLabel="Buscar país" emptyResults="No hay países que coincidan con la búsqueda.">
    {historical && <p className={styles.warning}>Este borrador anterior no tiene mercado confirmado. La segmentación guardada no demuestra que alguien haya elegido esos países.</p>}
    <p className={styles.help}>{paid ? 'El mercado elegido limita los países que se pueden comprar. En audiencia puedes cubrir cada uno como país completo o como zonas verificadas, sin solapar.' : 'El mercado orienta el mensaje y el análisis. No restringe ni garantiza la distribución de un post en Meta.'}</p>
  </AdvertisingSelectionDialog>;
}

const statusLabels = {
  reserved: 'Consultando al proveedor. Todavía no se guardó una audiencia.', applied: 'Audiencia guardada en este borrador.',
  proposed: 'Propuesta disponible. Elige únicamente los cambios que quieres aplicar.', needs_selection: 'Una o más sugerencias no tienen una coincidencia inequívoca. Nada se aplicó.',
  failed: 'No se obtuvo una propuesta válida.', uncertain: 'Envío incierto: no se reenviará.', stale: 'Esta propuesta ya no corresponde al borrador vigente.'
};
const ageText = pair => Array.isArray(pair) ? `${pair[0]}–${pair[1]} años` : 'No informado';
const candidateLabel = item => [item.label, item.context?.path?.join(' / ') || item.context?.scope].filter(Boolean).join(' · ');

function SharedAudienceData({ value }) {
  return <div className={styles.stack} aria-label="Datos que se enviarán">
    <strong>Datos que se compartirán</strong>
    <p>Objetivo: {{ reach: 'Alcance', engagement: 'Interacción', traffic: 'Clics al sitio web', whatsapp: 'Consultas por WhatsApp' }[value.objective]} · Mercados: {value.markets.map(countryLabel).join(', ')}</p>
    <p>{value.offer?.primary ? `Oferta pública: ${[value.offer.primary.title, value.offer.primary.presentation, value.offer.primary.flavor].filter(Boolean).join(' · ')}${value.offer.gift ? ` · Obsequio: ${[value.offer.gift.title, value.offer.gift.presentation, value.offer.gift.flavor].filter(Boolean).join(' · ')}` : ''}` : 'Sin hechos de oferta pública para este envío.'}</p>
    {value.currentAudience && <div><p>Selección actual:</p><ul>
      <li>Países completos: {value.currentAudience.countries.map(countryLabel).join(', ') || 'Ninguno'}</li>
      {[...value.currentAudience.regions, ...value.currentAudience.cities].map((zone, index) => <li key={index}>{zone.label || 'Zona verificada'} · {countryLabel(zone.country)}{zone.radius ? ` · Radio ${zone.radius} ${zone.distanceUnit === 'mile' ? 'mi' : 'km'}` : ''}</li>)}
      <li>Edad: {ageText([value.currentAudience.ageMin, value.currentAudience.ageMax])}</li>
      <li>Intereses: {value.currentAudience.interests.join(', ') || 'No se compartirán nombres'}.{value.currentAudience.otherInterests ? ` Otros intereses no compartidos: ${value.currentAudience.otherInterests}.` : ''}</li>
      {value.currentAudience.otherZones > 0 && <li>Otras zonas no compartidas: {value.currentAudience.otherZones}</li>}
    </ul></div>}
  </div>;
}

export function AudienceAssistant({ api, campaign, mode, editPending, disabled, onSave, onApplied, onBusy }) {
  const [setup, setSetup] = useState(null), [attempt, setAttempt] = useState(null), [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [consent, setConsent] = useState(null), [useAge, setUseAge] = useState(false), [picks, setPicks] = useState({});
  const commandIds = useRef(new Map()), readLock = useRef(false), mounted = useRef(false), current = useRef(null), errorRef = useRef(null);
  current.current = { onApplied, onBusy, version: campaign?.version };
  const url = campaign?.id && `/api/admin/social/campaigns/${encodeURIComponent(campaign.id)}/audience`;
  const version = campaign?.version, configured = setup?.mode === mode && setup?.data?.version === version ? setup.data : null;
  const proposal = result?.proposal, currentResult = result?.version === version;
  const availableProposal = proposal && currentResult && ['proposed', 'needs_selection'].includes(result.status);
  const statusId = attempt?.requestId || result?.requestId;
  const consentKey = configured && `${mode}:${configured.version}:${configured.provider.version}`;
  const waitingForProposal = attempt?.action === 'propose' || currentResult && ['reserved', 'uncertain', 'proposed', 'needs_selection'].includes(result?.status);
  const aids = mode === 'automatic' || mode === 'manual';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; current.current.onBusy?.(false); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!aids || !url || editPending) return;
    const controller = new AbortController(), { signal } = controller;
    api(`${url}?${new URLSearchParams({ mode })}`, { signal }).then(data => {
      if (signal.aborted) return;
      setSetup({ mode, data });
      if (data.latestRequest) setResult(previous => previous?.mode === mode && (previous.version > data.latestRequest.version ||
        previous.version === data.latestRequest.version && previous.proposal) ? previous : data.latestRequest);
    }, cause => { if (!signal.aborted) setSetup({ mode, version, error: cause.message }); });
    return () => controller.abort();
  }, [api, aids, url, mode, version, editPending, refresh]);
  useEffect(() => { setUseAge(false); setPicks({}); }, [result?.proposalId]);
  useEffect(() => {
    if (result?.status !== 'reserved' || !statusId || !url) return;
    const timer = setTimeout(() => { void recover(); }, 2500);
    return () => clearTimeout(timer);
  }, [result, statusId, url]);

  async function accept(value) {
    if (!mounted.current) return;
    setResult(value); setAttempt(null);
    if (value.status !== 'reserved') setConsent(null);
    if (value.status === 'applied' && current.current.version !== value.version) await current.current.onApplied(value.version);
  }
  async function perform(payload) {
    if (readLock.current) return;
    const key = JSON.stringify(payload);
    if (!commandIds.current.has(key)) commandIds.current.set(key, crypto.randomUUID());
    const body = { ...payload, requestId: commandIds.current.get(key) };
    readLock.current = true; setBusy(true); setError(''); setAttempt(body);
    current.current.onBusy?.(true);
    if (payload.action !== 'apply') setResult(null);
    try {
      await accept(await api(url, { method: 'POST', body: JSON.stringify(body) }));
      commandIds.current.delete(key);
    } catch (cause) {
      if (!mounted.current) return;
      if (Number.isInteger(cause.status) && cause.status < 500) { setAttempt(null); setConsent(null); setRefresh(value => value + 1); }
      setError(`${cause.message} ${payload.action === 'propose' ? 'Si la respuesta se perdió, comprueba la solicitud sin volver a enviarla.' : 'Comprueba la solicitud antes de confirmar otra acción.'}`);
    } finally {
      readLock.current = false;
      if (mounted.current) { setBusy(false); current.current.onBusy?.(false); }
    }
  }
  async function recover() {
    if (readLock.current || !statusId) return;
    readLock.current = true; setBusy(true);
    current.current.onBusy?.(true);
    try { await accept(await api(`${url}?${new URLSearchParams({ requestId: statusId })}`)); setError(''); }
    catch (cause) { if (mounted.current) setError(cause.message); }
    finally { readLock.current = false; if (mounted.current) { setBusy(false); current.current.onBusy?.(false); } }
  }
  const chosen = Object.entries(picks).filter(([, key]) => key).map(([index, key]) => ({ index: Number(index), key }));
  const locked = disabled || busy || editPending;
  if (!url || editPending) return <p className={styles.notice}>Guarda los mercados, la oferta y la segmentación actual antes de pedir una propuesta o elegir público amplio. <button type="button" className="button subtle" disabled={disabled} onClick={onSave}>Guardar borrador</button></p>;
  return <div className={styles.stack} aria-label="Decisión de audiencia" aria-busy={busy}>
    {error && <p role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
    {aids && !configured && !setup?.error && <p role="status">Comprobando proveedor y datos para el consentimiento…</p>}
    {aids && setup?.mode === mode && setup.error && <p role="alert">{setup.error} <button type="button" className="button subtle" onClick={() => setRefresh(value => value + 1)}>Volver a comprobar</button></p>}
    {aids && configured && !configured.provider.available && <p className={styles.warning}>Ali no está disponible. Puedes definir la audiencia tú o continuar sin personalizar.</p>}
    {aids && configured?.provider.available && configured.marketConfirmed && <details className={styles.technicalDetails} open={!result || result.status === 'reserved'}>
      <summary>{mode === 'manual' ? 'Recomiéndame mejoras' : 'Revisar datos y definir con IA'}</summary>
      <p><strong>Proveedor de texto:</strong> {configured.provider.name} · {configured.provider.model}</p>
      <SharedAudienceData value={configured.sharedData}/>
      <label className={styles.checkRow}><input type="checkbox" checked={consent === consentKey} disabled={locked || waitingForProposal} onChange={event => setConsent(event.target.checked ? consentKey : null)}/><span>Autorizo esta consulta. {configured.consentNotice}</span></label>
      <button type="button" className="button primary" disabled={locked || !consentKey || consent !== consentKey || waitingForProposal} onClick={() => perform({ action: 'propose', version, mode, settingsVersion: configured.provider.version, consent: true })}>{mode === 'manual' ? 'Solicitar recomendaciones' : 'Solicitar audiencia con IA'}</button>
    </details>}
    {mode === 'broad' && <><p>Adultos de 18–65 en todos los países elegidos, sin intereses ni otros filtros. Es tu decisión; no se enviarán datos a un proveedor externo.</p>
      <button type="button" className="button primary" disabled={locked || campaign.audienceMode === 'broad'} onClick={() => perform({ action: 'broad', version })}>Usar público amplio sin IA</button></>}
    {result?.mode === mode && <p role="status">{!currentResult && proposal ? 'La versión cambió; esta propuesta ya no modifica el borrador.' : statusLabels[result.status]} {result.notice}</p>}
    {statusId && (attempt || result?.status === 'reserved' || result?.status === 'uncertain') && <button type="button" className="button subtle" disabled={busy} onClick={recover}>Comprobar solicitud sin reenviar</button>}
    {result?.mode === mode && proposal && currentResult && !['stale', 'uncertain'].includes(result.status) && <section className={`${styles.card} ${styles.stack}`} aria-label="Propuesta de audiencia">
      <h4>{result.status === 'applied' ? 'Audiencia guardada: razones y límites' : 'Antes y después propuestos'}</h4>
      <p>Edad: {ageText(proposal.age.before)} → {ageText(proposal.age.after)}. {proposal.explanation}</p>
      {availableProposal && <label className={styles.checkRow}><input type="checkbox" disabled={locked} checked={useAge} onChange={event => setUseAge(event.target.checked)}/>Aplicar el cambio de edad</label>}
      {proposal.interests.map(item => <div key={item.index}><p><strong>{item.label}</strong> · {item.status === 'verified' ? 'Verificado' : item.status === 'ambiguous' ? 'Coincidencias ambiguas' : 'Sin coincidencia verificable'}</p>
        {availableProposal && item.candidates.length > 0 && <label className="field">Candidato para {item.label}<select disabled={locked} value={picks[item.index] || ''} onChange={event => setPicks(previous => ({ ...previous, [item.index]: event.target.value }))}><option value="">No aplicar este interés</option>{item.candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidateLabel(candidate)}</option>)}</select></label>}
      </div>)}
      <ul>{[...proposal.grounding.map(item => item.text), ...proposal.assumptions, ...proposal.limitations].map((item, index) => <li key={index}>{item}</li>)}</ul>
      {result.status === 'needs_selection' && <p>Si no quieres resolver los intereses, elige «Sin personalizar» para usar público amplio expresamente.</p>}
      {availableProposal && <button type="button" className="button primary" disabled={locked || (!useAge && !chosen.length)} onClick={() => perform({ action: 'apply', version, proposalId: result.proposalId, selectedChanges: { age: useAge, interests: chosen } })}>Aplicar solo diferencias elegidas</button>}
    </section>}
  </div>;
}
