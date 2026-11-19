'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';
import accountStyles from './AdvertisingResults.module.css';

const OBJECTIVES = { reach: 'Alcance', engagement: 'Interacción', traffic: 'Tráfico', whatsapp: 'Consultas por WhatsApp', sales: 'Ventas' };
const SOURCES = { none: 'Solo métricas de Meta', meta_pixel: 'Píxel de Meta', dataset: 'Dataset de Meta', external: 'Otra fuente / UTM / registro externo' };
const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin comprobar';
const initial = config => ({ objective: config.objective, source: config.source, pixelId: config.pixelId || '', datasetId: config.datasetId || '', events: config.events || [], externalDescription: config.externalDescription || '' });

export default function AdvertisingMeasurement({ api, connections, onInteractionStateChange, onMutation }) {
  const [selected, setSelected] = useState(''), [data, setData] = useState(null), [form, setForm] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false), [reload, setReload] = useState(0);
  const request = useRef(null), locked = useRef(false), mounted = useRef(true), errorRef = useRef(null), callbacks = useRef({});
  callbacks.current = { onInteractionStateChange, onMutation };
  const connectionId = selected || connections.find(connection => connection.integrationMethod === 'api')?.id || '';
  const connection = connections.find(item => item.id === connectionId);
  useEffect(() => { callbacks.current.onInteractionStateChange?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setData(null); setForm(null); setError(''); setNotice(''); setDirty(false);
    if (!connectionId) return () => controller.abort();
    setBusy(true);
    api(`/api/admin/social/connections/${encodeURIComponent(connectionId)}/measurement`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setData(value); setForm(initial(value.config)); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, connectionId, reload]);
  function change(field, value) { setForm(previous => ({ ...previous, [field]: value })); setDirty(true); setNotice(''); }
  async function submit(action) {
    if (locked.current || !data || !form) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); request.current = controller;
    try {
      const value = await api(`/api/admin/social/connections/${encodeURIComponent(connectionId)}/measurement`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action, version: data.connectionVersion, requestId: crypto.randomUUID(), ...(action === 'save' ? { config: form } : {}) }) });
      if (!mounted.current || controller.signal.aborted) return;
      setData(value); setForm(initial(value.config)); setDirty(false);
      setNotice(action === 'save' ? 'Objetivo y medición guardados. Las propuestas deben interpretarse con estas fuentes; guardar no instala seguimiento ni envía eventos.' : 'Comprobación terminada. Acceso a una fuente no demuestra recepción de eventos ni compras.');
      await callbacks.current.onMutation?.();
    } catch (cause) { if (mounted.current && cause.name !== 'AbortError') setError(cause.message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className={`${styles.panel} ${accountStyles.accountPanel}`} aria-label="Objetivo y medición del negocio">
    <header className={accountStyles.stageTitle}><p className={styles.eyebrow}>Configuración de la cuenta</p><h3>Objetivo del negocio y medición</h3>
      <p>Elige qué mejorar antes de interpretar resultados. Clics, visitas, conversaciones y ventas son diferentes; no todos los objetivos necesitan píxel.</p>
    </header>
    <label className="field">Conexión para objetivo y medición<select value={connectionId} disabled={busy || dirty} onChange={event => setSelected(event.target.value)}><option value="">Selecciona una conexión</option>{connections.filter(item => item.integrationMethod === 'api').map(item => <option key={item.id} value={item.id}>{item.name || item.identities?.userName || item.id} · {item.authenticationMethod === 'token' ? 'Token de lectura' : 'OAuth'}</option>)}</select></label>
    {dirty && <p>Guarda o descarta estos cambios antes de elegir otra conexión.</p>}
    {!connectionId && <p>Conecta Meta por OAuth o token manual en Configuración → Redes sociales.</p>}
    {busy && <p role="status">Consultando o guardando medición…</p>}
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{error}</p><button type="button" className="button subtle" disabled={busy} onClick={() => { if (!dirty || window.confirm('¿Descartar los cambios y recargar la configuración vigente?')) setReload(value => value + 1); }}>Cargar configuración vigente</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {data && form && <>
      <section aria-labelledby="social-account-source-title" className={accountStyles.accountStatus}>
        <h4 id="social-account-source-title">Estado comprobado de la fuente</h4>
        <p><strong>{({ verified: 'Acceso y asociación comprobados', unverified: 'Sin comprobar', unavailable: 'No acreditado / no disponible' })[data.config.verification.status]}</strong> · {when(data.config.verification.checkedAt)}</p>
        <p>{data.config.verification.notice}</p>
        {data.config.verification.lastFiredAt && <p>Última actividad reportada: {when(data.config.verification.lastFiredAt)}. No identifica qué evento llegó.</p>}
        {!!data.sources?.length && <details><summary>Fuentes accesibles comprobadas ({data.sources.length})</summary><ul aria-label="Fuentes accesibles comprobadas">{data.sources.map(source => <li key={source.id}>{source.name || 'Fuente sin nombre'} · {source.id}{source.unavailable ? ' · No disponible' : ''}</li>)}</ul></details>}
        <div className={styles.actions}>
          <button type="button" className="button subtle" disabled={busy || dirty || connection?.state !== 'connected' || connection?.integrationMethod !== 'api'} onClick={() => void submit('verify')}>Comprobar fuente en Meta</button>
          <button type="button" className="button subtle" disabled={busy || dirty} onClick={() => setReload(value => value + 1)}>Recargar configuración</button>
        </div>
        <p className={styles.help}>Comprobar consulta el acceso en Meta. Recargar lee la configuración guardada; ninguna acción envía eventos.</p>
      </section>
      <form className={accountStyles.accountBlock} onSubmit={event => { event.preventDefault(); void submit('save'); }}>
        <fieldset disabled={busy || !connection} className={`${styles.fieldGrid} ${accountStyles.accountFieldset}`}>
          <legend>Configuración local</legend>
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
          <button type="submit" className="button primary" disabled={busy || !dirty}>Guardar objetivo y medición</button>
          <button type="button" className="button subtle" disabled={busy || !dirty} onClick={() => { setForm(initial(data.config)); setDirty(false); }}>Descartar cambios de medición</button>
        </div>
        <p className={styles.help}>Para instalación, consentimiento, pruebas y deduplicación de píxel/Conversions API, usa <a href="https://www.facebook.com/events_manager2/list" target="_blank" rel="noreferrer">Events Manager de Meta</a>. Esta pantalla no envía eventos, ni siquiera de prueba.</p>
      </form>
    </>}
  </section>;
}
