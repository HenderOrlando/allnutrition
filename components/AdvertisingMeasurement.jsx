'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';
import accountStyles from './AdvertisingResults.module.css';
import useDialog from './useDialog';

const OBJECTIVES = { reach: 'Alcance', engagement: 'Interacción', traffic: 'Tráfico', whatsapp: 'Consultas por WhatsApp', sales: 'Ventas' };
const SOURCES = { none: 'Solo métricas de Meta', meta_pixel: 'Píxel de Meta', dataset: 'Dataset de Meta', external: 'Otra fuente / UTM / registro externo' };
const EVENTS_MANAGER = 'https://www.facebook.com/events_manager2/list';
const READ_CONTROL = 'Conexión para objetivo y medición';
const DEFINE_CONTROL = 'Configuración local';
const SAVE_CONTROL = 'Guardar objetivo y medición';
const VERIFY_CONTROL = 'Comprobar fuente en Meta';
const MANAGER_CONTROL = 'Events Manager de Meta';
const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin comprobar';
const initial = config => ({ objective: config.objective, source: config.source, pixelId: config.pixelId || '', datasetId: config.datasetId || '', events: config.events || [], externalDescription: config.externalDescription || '' });

export default function AdvertisingMeasurement({ api, connections, connectionsPending, onInteractionStateChange, onMutation }) {
  const [selected, setSelected] = useState(''), [data, setData] = useState(null), [form, setForm] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const busy = loading || saving;
  const [dirty, setDirty] = useState(false), [reload, setReload] = useState(0);
  const [consent, setConsent] = useState(null);
  const dialog = useRef(null);
  const request = useRef(null), locked = useRef(false), mounted = useRef(true), errorRef = useRef(null), callbacks = useRef({});
  callbacks.current = { onInteractionStateChange, onMutation };
  const eligible = connections.filter(connection => connection.provider === 'meta' && connection.integrationMethod === 'api');
  const connection = selected ? eligible.find(item => item.id === selected) : eligible[0];
  const connectionId = connection?.id || '';
  const current = data?.connectionId === connectionId && form;
  const canVerify = Boolean(current && !dirty && !busy && connection.state === 'connected' && !connection.revalidationRequired
    && !connection.disconnectStatus && /^act_\d+$/.test(connection.identities?.adAccountId || '')
    && ['meta_pixel', 'dataset'].includes(data.config.source));
  const closeConsent = useDialog(dialog, { open: Boolean(consent), onClose: () => setConsent(null) });
  useEffect(() => { if (!selected && connectionId) setSelected(connectionId); }, [selected, connectionId]);
  // A passive read can be aborted; only edits and writes guard navigation.
  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy: saving }); }, [dirty, saving]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setData(null); setForm(null); setError(''); setNotice(''); setDirty(false);
    if (!connectionId) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    api(`/api/admin/social/connections/${encodeURIComponent(connectionId)}/measurement`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setData(value); setForm(initial(value.config)); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, connectionId, reload]);
  function change(field, value) { setForm(previous => ({ ...previous, [field]: value })); setDirty(true); setNotice(''); }
  async function submit(action) {
    if (locked.current || !current || busy || (action === 'save' ? !dirty : !canVerify)) return;
    locked.current = true; setSaving(true); setError(''); setNotice('');
    const controller = new AbortController(); request.current = controller;
    try {
      const value = await api(`/api/admin/social/connections/${encodeURIComponent(connectionId)}/measurement`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action, version: data.connectionVersion, requestId: crypto.randomUUID(), ...(action === 'save' ? { config: form } : {}) }) });
      if (!mounted.current || controller.signal.aborted) return;
      setData(value); setForm(initial(value.config)); setDirty(false);
      setNotice(action === 'save' ? 'Objetivo y medición guardados. Las propuestas deben interpretarse con estas fuentes; guardar no instala seguimiento ni envía eventos.' : 'Comprobación terminada. Acceso a una fuente no demuestra recepción de eventos ni compras.');
      await callbacks.current.onMutation?.();
    } catch (cause) { if (mounted.current && cause.name !== 'AbortError') setError(cause.message); }
    finally { locked.current = false; if (mounted.current) setSaving(false); }
  }
  return <section className={`${styles.panel} ${accountStyles.accountPanel}`} aria-label="Objetivo y medición del negocio">
    <header className={accountStyles.stageTitle}><p className={styles.eyebrow}>Configuración de la cuenta</p><h3>Objetivo del negocio y medición</h3>
      <p>Elige qué mejorar antes de interpretar resultados. Clics, visitas, conversaciones y ventas son diferentes; no todos los objetivos necesitan píxel.</p>
    </header>
    <label className="field">{READ_CONTROL}<select data-advisor-control={!dirty && eligible.length ? READ_CONTROL : undefined} value={connectionId} disabled={saving || dirty || !eligible.length} onChange={event => setSelected(event.target.value)}><option value="" disabled={Boolean(connectionId)}>Selecciona una conexión</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name || item.identities?.userName || item.id} · {item.authenticationMethod === 'token' ? 'Token de lectura' : 'OAuth'}</option>)}</select></label>
    {dirty && <p tabIndex={-1} data-advisor-control={READ_CONTROL}>Guarda o descarta estos cambios antes de elegir otra conexión. La configuración comprobada de la cuenta permanece visible.</p>}
    {!connectionId && !connectionsPending && <p tabIndex={-1} data-advisor-control={!eligible.length ? READ_CONTROL : undefined}>Selecciona una conexión Meta mediante OAuth o token manual. Puedes conectarla en Configuración → Redes sociales.</p>}
    {busy && <p role="status">Consultando o guardando medición…</p>}
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{error}</p><button type="button" className="button subtle" disabled={busy} onClick={() => { if (!dirty || window.confirm('¿Descartar los cambios y recargar la configuración vigente?')) setReload(value => value + 1); }}>Cargar configuración vigente</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {current && <>
      <section aria-labelledby="social-account-source-title" className={accountStyles.accountStatus}>
        <h4 id="social-account-source-title">Estado comprobado de la fuente</h4>
        <p><strong>{({ verified: 'Acceso y asociación comprobados', unverified: 'Sin comprobar', unavailable: 'No acreditado / no disponible' })[data.config.verification.status]}</strong> · {when(data.config.verification.checkedAt)}</p>
        <p>{data.config.verification.notice}</p>
        {data.config.verification.lastFiredAt && <p>Última actividad reportada: {when(data.config.verification.lastFiredAt)}. No identifica qué evento llegó.</p>}
        {!!data.sources?.length && <details><summary>Fuentes accesibles comprobadas ({data.sources.length})</summary><ul aria-label="Fuentes accesibles comprobadas">{data.sources.map(source => <li key={source.id}>{source.name || 'Fuente sin nombre'} · {source.id}{source.unavailable ? ' · No disponible' : ''}</li>)}</ul></details>}
        <div className={styles.actions}>
          <button type="button" className="button subtle" data-advisor-control={canVerify ? VERIFY_CONTROL : undefined} disabled={!canVerify} onClick={() => setConsent('verify')}>{VERIFY_CONTROL}</button>
          <button type="button" className="button subtle" disabled={busy || dirty} onClick={() => setReload(value => value + 1)}>Recargar configuración</button>
        </div>
        {!canVerify && !busy && <p tabIndex={-1} data-advisor-control={VERIFY_CONTROL} className={styles.help}>{dirty ? 'Guarda o descarta los cambios antes de comprobar la fuente.' : 'Para comprobar la fuente en Meta, guarda un píxel o dataset y elige una cuenta publicitaria API vigente.'}</p>}
        <p className={styles.help}>Comprobar consulta el acceso en Meta. Recargar lee la configuración guardada; ninguna acción envía eventos.</p>
      </section>
      <form className={accountStyles.accountBlock} onSubmit={event => { event.preventDefault(); void submit('save'); }}>
        <fieldset disabled={busy || !connection} className={`${styles.fieldGrid} ${accountStyles.accountFieldset}`}>
          <legend tabIndex={-1} data-advisor-control={DEFINE_CONTROL}>{DEFINE_CONTROL}</legend>
          <label className="field">Objetivo a mejorar<select value={form.objective} onChange={event => change('objective', event.target.value)}>{Object.entries(OBJECTIVES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label className="field">Fuente de medición<select value={form.source} onChange={event => change('source', event.target.value)}>{Object.entries(SOURCES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          {form.source === 'meta_pixel' && <label className="field">ID del píxel<input value={form.pixelId} inputMode="numeric" pattern="[0-9]+" maxLength={40} required onChange={event => change('pixelId', event.target.value)}/></label>}
          {form.source === 'dataset' && <label className="field">ID del dataset<input value={form.datasetId} inputMode="numeric" pattern="[0-9]+" maxLength={40} required onChange={event => change('datasetId', event.target.value)}/></label>}
          {form.source === 'external' && <label className="field">Fuente externa y método de identificación<textarea value={form.externalDescription} maxLength={1000} required placeholder="Ej.: UTM por campaña y registro agregado; no incluyas datos personales ni claves." onChange={event => change('externalDescription', event.target.value)}/></label>}
        </fieldset>
        <p>{data.requirements[form.objective]}</p>
        <fieldset disabled={busy} className={`${accountStyles.accountFieldset} ${accountStyles.accountBlock}`}>
          <legend>Eventos que se busca medir</legend>
          <p className={styles.help}>Eventos habituales: PageView/ViewContent para visitas, Contact/Lead para consultas y Purchase para compras. Declararlos aquí no los instala ni acredita que estén llegando.</p>
          {form.events.map((event, index) => <div className={`${styles.fieldGrid} ${accountStyles.eventRow}`} key={index}>
            <label className="field">Nombre del evento {index + 1}<input value={event.name} required maxLength={80} pattern="[A-Za-z][A-Za-z0-9_]*" onChange={value => change('events', form.events.map((item, position) => position === index ? { ...item, name: value.target.value } : item))}/></label>
            <label className="field">Objetivo del evento {index + 1}<select value={event.objective} onChange={value => change('events', form.events.map((item, position) => position === index ? { ...item, objective: value.target.value } : item))}>{Object.entries(OBJECTIVES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <button type="button" className="button subtle" onClick={() => change('events', form.events.filter((_, position) => position !== index))}>Quitar evento {index + 1}</button>
          </div>)}
          <div className={styles.actions}><button type="button" className="button subtle" disabled={form.events.length >= 20} onClick={() => change('events', [...form.events, { name: '', objective: form.objective }])}>Añadir evento</button></div>
        </fieldset>
        <p className={styles.warning}>{data.notice}</p>
        <div className={styles.actions}>
          <button type="submit" className="button primary" data-advisor-control={dirty ? SAVE_CONTROL : undefined} disabled={busy || !dirty}>{SAVE_CONTROL}</button>
          <button type="button" className="button subtle" disabled={busy || !dirty} onClick={() => { setForm(initial(data.config)); setDirty(false); }}>Descartar cambios de medición</button>
        </div>
        {!dirty && !busy && <p tabIndex={-1} data-advisor-control={SAVE_CONTROL} className={styles.help}>Cambia el objetivo, la fuente o los eventos para habilitar «Guardar objetivo y medición».</p>}
      </form>
    </>}
    <div className={styles.actions}>
      <button type="button" className="button subtle" data-advisor-control={MANAGER_CONTROL} onClick={() => setConsent('manager')}>{MANAGER_CONTROL}</button>
      <p className={styles.help}>Para instalación, consentimiento, pruebas y deduplicación de píxel/Conversions API. Esta pantalla no envía eventos, ni siquiera de prueba.</p>
    </div>
    {consent && <dialog ref={dialog} className={styles.dialog} aria-labelledby="measurement-consent-title" aria-describedby="measurement-consent-detail">
      <header className={styles.dialogHeader}><h2 id="measurement-consent-title">{consent === 'verify' ? VERIFY_CONTROL : 'Abrir Events Manager de Meta'}</h2></header>
      <p id="measurement-consent-detail">{consent === 'verify'
        ? <>Se consultará en Meta el acceso de {connection?.name || connectionId} · {connection?.identities?.adAccountId} a {SOURCES[data?.config.source]} {data?.config.pixelId || data?.config.datasetId}. Esto no cambia campañas, no instala seguimiento, no envía eventos ni confirma conversiones.</>
        : 'Saldrás de esta pantalla en una nueva pestaña. En Meta gestionas el consentimiento, la instalación, las pruebas y la deduplicación. Aquí no se confirma ningún cambio ni se envían eventos.'}</p>
      <div className={styles.actions}>
        <button type="button" className="button subtle" data-dialog-initial-focus onClick={closeConsent}>Cancelar</button>
        {consent === 'verify'
          ? <button type="button" className="button primary" disabled={!canVerify} onClick={() => { setConsent(null); void submit('verify'); }}>Autorizar consulta en Meta</button>
          : <a className="button primary" href={EVENTS_MANAGER} target="_blank" rel="noopener noreferrer" onClick={closeConsent}>Continuar a Events Manager de Meta</a>}
      </div>
    </dialog>}
  </section>;
}
