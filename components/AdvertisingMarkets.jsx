'use client';

import { useEffect, useRef, useState } from 'react';
import { SOCIAL_COUNTRY_CODES } from '../lib/social/market-countries.mjs';
import AdvertisingSelectionDialog from './AdvertisingSelectionDialog';
import styles from './AdvertisingWorkspace.module.css';

const names = new Intl.DisplayNames(['es'], { type: 'region' });
export const countryLabel = code => `${names.of(code) || code} (${code})`;
const countryOptions = SOCIAL_COUNTRY_CODES.map(value => ({ value, label: countryLabel(value) })).sort((a, b) => a.label.localeCompare(b.label, 'es'));
export const AUDIENCE_SOURCE = { automatic: 'Definida con IA', manual: 'Definida manualmente', broad: 'Público amplio elegido por el operador' };

export function MarketPicker({ value, onChange, paid, historical, triggerId, disabled, advisorControl }) {
  return <AdvertisingSelectionDialog triggerId={triggerId} title="¿En qué país o países quieres publicar?" triggerLabel="Elegir mercados" advisorControl={advisorControl}
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

function SharedAudienceData({ value, advisorControl }) {
  return <div className={styles.stack} aria-label="Datos que se enviarán" tabIndex={-1} data-advisor-control={advisorControl}>
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

export function AudienceAssistant({ api, campaign, mode, active, editPending, disabled, advisorControl, audienceAction, onSave, onApplied, onBusy }) {
  const [setup, setSetup] = useState(null), [attempt, setAttempt] = useState(null), [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [consent, setConsent] = useState(null), [useAge, setUseAge] = useState(false), [useScope, setUseScope] = useState(false), [picks, setPicks] = useState({});
  const commandIds = useRef(new Map()), readLock = useRef(false), mounted = useRef(false), current = useRef(null), errorRef = useRef(null);
  current.current = { onApplied, onBusy, version: campaign?.version };
  const url = campaign?.id && `/api/admin/social/campaigns/${encodeURIComponent(campaign.id)}/audience`;
  const version = campaign?.version, configured = setup?.mode === mode && setup?.data?.version === version ? setup.data : null;
  const proposal = result?.mode === mode ? result.proposal : null, currentResult = result?.version === version;
  const availableProposal = proposal && currentResult && ['proposed', 'needs_selection'].includes(result.status);
  const currentAttempt = attempt?.version === version ? attempt : null;
  const statusId = currentAttempt?.requestId || (currentResult && result?.requestId);
  const canRecover = Boolean(statusId && (currentAttempt || ['reserved', 'uncertain'].includes(result?.status)));
  const consentKey = configured && `${mode}:${configured.version}:${configured.provider.version}`;
  const waitingForProposal = Boolean(currentAttempt?.action === 'propose' || currentResult && ['reserved', 'uncertain', 'proposed', 'needs_selection'].includes(result?.status));
  const proposeFocus = audienceAction === (mode === 'manual' ? 'ad-campaign-propose-manual-audience-improvements' : 'ad-campaign-propose-ai-audience') ? audienceAction : undefined;
  const readFocus = audienceAction === 'ad-campaign-read-audience-request' ? audienceAction : undefined;
  const applyFocus = audienceAction === 'ad-campaign-apply-audience-differences' ? audienceAction : undefined;
  const broadFocus = audienceAction === 'ad-campaign-apply-broad-audience' ? audienceAction : undefined;
  const setupError = setup?.mode === mode && setup.version === version ? setup.error : null;
  const aids = mode === 'automatic' || mode === 'manual';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; current.current.onBusy?.(false); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!active || !aids || !url || editPending) return;
    const controller = new AbortController(), { signal } = controller;
    api(`${url}?${new URLSearchParams({ mode })}`, { signal }).then(data => {
      if (signal.aborted) return;
      setSetup({ mode, data });
      if (data.latestRequest) setResult(previous => previous?.mode === mode && (previous.version > data.latestRequest.version ||
        previous.version === data.latestRequest.version && previous.proposal && data.latestRequest.status !== 'stale') ? previous : data.latestRequest);
    }, cause => { if (!signal.aborted) setSetup({ mode, version, error: cause.message }); });
    return () => controller.abort();
  }, [active, api, aids, url, mode, version, editPending, refresh]);
  useEffect(() => { setUseAge(false); setUseScope(false); setPicks({}); }, [result?.proposalId, version]);
  useEffect(() => {
    if (!active || editPending || !canRecover || result?.status !== 'reserved' || !url) return;
    const timer = setTimeout(() => { void recover(); }, 2500);
    return () => clearTimeout(timer);
  }, [active, editPending, canRecover, result, statusId, url]);

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
    if (readLock.current || !canRecover) return;
    readLock.current = true; setBusy(true);
    current.current.onBusy?.(true);
    try { await accept(await api(`${url}?${new URLSearchParams({ requestId: statusId })}`)); setError(''); }
    catch (cause) { if (mounted.current) setError(cause.message); }
    finally { readLock.current = false; if (mounted.current) { setBusy(false); current.current.onBusy?.(false); } }
  }
  const options = proposal?.interests.filter(item => item.candidates.length) || [];
  const chosen = options.flatMap(({ index }) => picks[index] ? [{ index, key: picks[index] }] : []);
  const ageChanged = proposal && proposal.age.before.some((value, index) => value !== proposal.age.after[index]);
  const locked = disabled || busy || editPending;
  const canApply = availableProposal && !locked && !currentAttempt &&
    (proposal.scope ? useScope : useAge || chosen.length > 0);
  const canPropose = !locked && !waitingForProposal && !currentAttempt && consentKey && consent === consentKey;
  const canBroad = !locked && !currentAttempt && campaign?.audienceMode !== 'broad';
  const waitingForSetup = aids && !configured && !setupError;
  if (!url || editPending) return <p className={styles.notice} tabIndex={-1} data-advisor-control={audienceAction || advisorControl}>Guarda los mercados, la oferta y la segmentación actual antes de pedir una propuesta o elegir público amplio. <button type="button" className="button subtle" disabled={disabled} onClick={onSave}>Guardar borrador</button></p>;
  return <div className={styles.stack} aria-label="Decisión de audiencia" aria-busy={busy}>
    {error && <p role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
    {waitingForSetup && <p role="status">Comprobando proveedor y datos para el consentimiento…</p>}
    {setupError && <p role="alert" tabIndex={-1} data-advisor-control={proposeFocus || advisorControl}>{setupError} <button type="button" className="button subtle" onClick={() => { setSetup(null); setRefresh(value => value + 1); }}>Volver a comprobar</button></p>}
    {aids && configured && !configured.provider.available && <p className={styles.warning} tabIndex={-1} data-advisor-control={proposeFocus || advisorControl}>Ali no está disponible. Puedes definir la audiencia tú o continuar sin personalizar.</p>}
    {aids && configured && !configured.marketConfirmed && <p className={styles.warning} tabIndex={-1} data-advisor-control={proposeFocus || advisorControl}>Confirma y guarda los mercados antes de autorizar esta consulta.</p>}
    {aids && configured?.provider.available && configured.marketConfirmed && <details className={styles.technicalDetails} data-advisor-disclosure open={!result || result.status === 'reserved'}>
      <summary>{mode === 'manual' ? 'Recomiéndame mejoras' : 'Revisar datos y definir con IA'}</summary>
      <p><strong>Proveedor de texto:</strong> {configured.provider.name} · {configured.provider.model}</p>
      <SharedAudienceData value={configured.sharedData} advisorControl={advisorControl}/>
      <label className={styles.checkRow}><input type="checkbox" data-advisor-control={!locked && !waitingForProposal && !currentAttempt && !canPropose ? proposeFocus : undefined} checked={consent === consentKey} disabled={locked || waitingForProposal || Boolean(currentAttempt)} onChange={event => setConsent(event.target.checked ? consentKey : null)}/><span>Autorizo esta consulta. {configured.consentNotice}</span></label>
      <button type="button" className="button primary" data-advisor-control={canPropose ? proposeFocus : undefined} disabled={!canPropose} onClick={() => perform({ action: 'propose', version, mode, settingsVersion: configured.provider.version, consent: true })}>{mode === 'manual' ? 'Solicitar recomendaciones' : 'Solicitar audiencia con IA'}</button>
    </details>}
    {proposeFocus && configured?.provider.available && configured.marketConfirmed && (waitingForProposal || currentAttempt || locked) && <p tabIndex={-1} data-advisor-control={proposeFocus}>No se abrirá otra consulta. Revisa la solicitud o la propuesta vigente antes de continuar.</p>}
    {mode === 'broad' && <><p tabIndex={!canBroad ? -1 : undefined} data-advisor-control={!canBroad && !currentAttempt ? broadFocus : undefined}>{campaign.audienceMode === 'broad' ? 'El público amplio ya está guardado para estos mercados.' : `Adultos de 18–65 en ${campaign.marketCountries.map(countryLabel).join(', ')}, sin intereses ni otros filtros.`} No se enviarán datos a un proveedor externo.</p>
      {broadFocus && currentAttempt && <p tabIndex={-1} data-advisor-control={broadFocus}>Comprueba la solicitud anterior antes de confirmar otra acción.</p>}
      <button type="button" className="button primary" data-advisor-control={canBroad ? broadFocus : undefined} disabled={!canBroad} onClick={() => perform({ action: 'broad', version })}>Usar público amplio sin IA</button></>}
    {result?.mode === mode && <p role="status">{!currentResult && proposal ? 'La versión cambió; esta propuesta ya no modifica el borrador.' : statusLabels[result.status]} {result.notice}</p>}
    {canRecover ? <button type="button" className="button subtle" data-advisor-control={!busy ? readFocus : undefined} disabled={busy} onClick={recover}>Comprobar solicitud sin reenviar</button>
      : readFocus && !waitingForSetup && <p tabIndex={-1} data-advisor-control={readFocus}>No hay una solicitud pendiente o incierta en este modo y versión del borrador.</p>}
    {proposal && currentResult && !['stale', 'uncertain'].includes(result.status) && <section className={`${styles.card} ${styles.stack}`} aria-label="Propuesta de audiencia">
      <h4>{result.status === 'applied' ? 'Audiencia guardada: razones y límites' : 'Antes y después propuestos'}</h4>
      <p>Edad: {ageText(proposal.age.before)} → {ageText(proposal.age.after)}. {proposal.explanation}</p>
      {availableProposal && proposal.scope && <label className={styles.checkRow}><input type="checkbox" data-advisor-control={!useScope && !locked && !currentAttempt ? applyFocus : undefined} disabled={locked || Boolean(currentAttempt)} checked={useScope} onChange={event => setUseScope(event.target.checked)}/>Usar los mercados confirmados como países completos: {proposal.scope.countries.map(countryLabel).join(', ')}. Reemplaza solo los países, regiones y ciudades de la selección anterior.</label>}
      {availableProposal && ageChanged && <label className={styles.checkRow}><input type="checkbox" data-advisor-control={!canApply && !proposal.scope && !locked && !currentAttempt ? applyFocus : undefined} disabled={locked || Boolean(currentAttempt)} checked={useAge} onChange={event => setUseAge(event.target.checked)}/>Aplicar el cambio de edad</label>}
      {proposal.interests.map(item => <div key={item.index}><p><strong>{item.label}</strong> · {item.status === 'verified' ? 'Verificado' : item.status === 'ambiguous' ? 'Coincidencias ambiguas' : 'Sin coincidencia verificable'}</p>
        {availableProposal && item.candidates.length > 0 && <label className="field">Candidato para {item.label}<select aria-label={`Candidato para ${item.label}`}
          data-advisor-control={!canApply && !proposal.scope && !ageChanged && options[0] === item && !locked && !currentAttempt ? applyFocus : undefined}
          disabled={locked || Boolean(currentAttempt)} value={picks[item.index] || ''} onChange={event => setPicks(previous => ({ ...previous, [item.index]: event.target.value }))}>
          <option value="">No aplicar este interés</option>{item.candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidateLabel(candidate)}</option>)}
        </select></label>}
      </div>)}
      <ul>{[...proposal.grounding.map(item => item.text), ...proposal.assumptions, ...proposal.limitations].map((item, index) => <li key={index}>{item}</li>)}</ul>
      {result.status === 'needs_selection' && <p>Solo se guardarán los cambios seleccionados. No se agregarán intereses sin una referencia elegida.</p>}
      {availableProposal && (proposal.scope || ageChanged || options.length > 0) && <button type="button" className="button primary" data-advisor-control={canApply ? applyFocus : undefined} disabled={!canApply} onClick={() => perform({ action: 'apply', version, proposalId: result.proposalId, selectedChanges: { ...(proposal.scope && { scope: useScope }), age: useAge, interests: chosen } })}>Aplicar solo diferencias elegidas</button>}
      {availableProposal && !proposal.scope && !ageChanged && !options.length && <p tabIndex={-1} data-advisor-control={applyFocus}>La propuesta no contiene diferencias verificables que puedas aplicar.</p>}
    </section>}
    {applyFocus && !waitingForSetup && (!availableProposal || (locked || currentAttempt) && (proposal.scope || ageChanged || options.length > 0)) && <p tabIndex={-1} data-advisor-control={applyFocus}>{currentAttempt ? 'Comprueba la solicitud anterior antes de aplicar diferencias.' : 'Necesitas una propuesta vigente para este modo y versión antes de aplicar diferencias.'}</p>}
  </div>;
}
