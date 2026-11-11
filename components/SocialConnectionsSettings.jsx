'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from './Fields';
import useDialog from './useDialog';
import SocialBrowserLogin from './SocialBrowserLogin';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';

const states = { draft: 'Borrador', ready: 'Preparada, sin gasto autorizado', scheduled: 'Programada', publishing: 'En preparación o publicación', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Falló', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Envío incierto: comprobar estado en Meta sin reenviar', blocked: 'Bloqueada', connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };

const methods = { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' };
const capabilities = { facebookPublish: 'Publicar en Facebook', instagramPublish: 'Publicar en Instagram', adsPublish: 'Preparar y administrar anuncios pagados', insights: 'Consultar resultados', whatsappAds: 'Anuncios con WhatsApp vinculado' };
const DELETION_COUNT_LABELS = { campaigns: 'Publicaciones y anuncios', deliveries: 'Entregas a redes', operations: 'Operaciones', recommendations: 'Ideas de mejora', measurements: 'Capturas de resultados', forecasts: 'Estimaciones', revisions: 'Versiones aprobadas', orderLinks: 'Vínculos de pedidos', expenseLinks: 'Vínculos de gastos' };

const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin fecha disponible';

function useRead(api, path, refresh, interval = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: false, fetchedAt: null, path: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); let active = true, timer;
    async function load() {
      if (!active) return;
      if (interval && document.hidden) { timer = setTimeout(load, interval); return; }
      setState(previous => ({ ...previous, loading: true }));
      try {
        const data = await api(path, { signal: controller.signal });
        if (active) setState({ data, error: '', loading: false, fetchedAt: new Date().toISOString(), path });
      } catch (cause) {
        if (active && cause.name !== 'AbortError') setState(previous => ({ ...previous, error: cause.message, loading: false }));
      }
      if (active && interval) timer = setTimeout(load, interval);
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, path, refresh, interval]);
  return state;
}
function ReadStatus({ state, onRetry, label }) {
  const errorRef = useRef(null);
  useEffect(() => { if (state.error) errorRef.current?.focus(); }, [state.error]);
  return <>{state.loading && <p role="status" className={styles.muted}>{state.data ? `Actualizando ${label}; se conserva la consulta de ${date(state.fetchedAt)}.` : `Cargando ${label}…`}</p>}{state.error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{state.error}</p>{state.data && <p>Última consulta conservada: {date(state.fetchedAt)}. Puede estar desactualizada o corresponder a los filtros anteriores.</p>}<button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura</button></div>}</>;
}

function SelectField({ name, label, value, options, onChange }) {
  return <Field field={{ name, label, type: 'select', options }} value={value || ''} onChange={onChange}/>;
}
function useRequestIds() {
  const ids = useRef(new Map());
  return useCallback((key, payload) => {
    const fingerprint = JSON.stringify(payload), prior = ids.current.get(key);
    if (prior?.fingerprint === fingerprint) return prior.id;
    const id = crypto.randomUUID(); ids.current.set(key, { fingerprint, id }); return id;
  }, []);
}

function ConnectionsIntro({ api, data, report, onMutation, onCreated }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), errorRef = useRef(null), controllers = useRef(new Set()), rid = useRequestIds();
  useEffect(() => { report('connection-create', { dirty: Boolean(name), busy }); }, [name, busy, report]);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); report('connection-create', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function connect(method) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); controllers.current.add(controller);
    try {
      if (method === 'api') {
        const result = await api(ROOT + '/oauth/start', { method: 'POST', body: JSON.stringify({}), signal: controller.signal });
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com' || url.username || url.password) throw new Error('El servidor devolvió una autorización no válida.');
        report('connection-create', { dirty: Boolean(name), busy: false });
        window.location.assign(url.href);
      } else {
        const payload = { integrationMethod: 'browser', name: name.trim() };
        const connection = await api(ROOT + '/connections', { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid('browser-create', payload) }), signal: controller.signal });
        setName(''); await onMutation(); report('connection-create', { dirty: false, busy: false }); onCreated(connection);
      }
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { controllers.current.delete(controller); locked.current = false; setBusy(false); }
  }
  return <><div className={styles.grid}>{['api', 'browser'].map(method => {
    const requirement = data?.requirements?.find(item => item.integrationMethod === method), available = requirement?.configured && requirement.enabled;
    return <article className={styles.card} key={method}><h2>{methods[method]}</h2>
      <p>{method === 'api' ? 'Autoriza tu negocio desde Facebook. No introduces la contraseña en este panel.' : 'Inicia sesión personalmente en un visor privado.'}</p>
      {method === 'browser' && <p className={styles.warning}>Requiere permiso previo de Meta para automatización. Los desafíos se resuelven personalmente; no se evaden. La sesión se conserva cifrada; no se guardan contraseñas, códigos de un solo uso ni capturas.</p>}
      {!requirement ? <p role="status">Consultando requisitos…</p> : <>
        <p>{available ? 'Esta opción está configurada y habilitada.' : 'Esta opción necesita configuración del administrador. Puedes guardar borradores mientras tanto.'}</p>
        {!requirement.enabled && <p className={styles.warning}>Esta opción está deshabilitada en las opciones guardadas.</p>}
        {!requirement.publishingEnabled && <p className={styles.warning}>Publicar, activar y reanudar está deshabilitado. Guardar un borrador local no autoriza gasto; una pausa segura sigue siendo posible con acceso válido.</p>}
        <details className={styles.technicalDetails}><summary>Información para el administrador</summary><p>Las dos vías tienen requisitos independientes; no hay sustitución automática si una falla.</p>{requirement.missing?.length > 0 && <p>Campos o requisitos faltantes: {requirement.missing.join(', ')}</p>}{requirement.invalid?.length > 0 && <p>Campos o requisitos inválidos: {requirement.invalid.join(', ')}</p>}{method === 'api' && <p>El token se conserva cifrado en servidor y tiene caducidad real.</p>}</details>
      </>}
      {method === 'browser' ? <form method="post" onSubmit={event => { event.preventDefault(); void connect(method); }}><Field field={{ name: 'browserName', label: 'Nombre de la conexión', required: true, max: 200 }} value={name} onChange={setName}/><button type="submit" className="button primary" disabled={busy || !available || !name.trim()}>Crear conexión y abrir acceso</button></form> : <button type="button" className="button primary" disabled={busy || !available} onClick={() => connect(method)}>Conectar con Facebook</button>}
    </article>;
  })}</div>
    {error && <p ref={errorRef} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
    {data && <aside className={styles.panel}><h2>Estado del acceso asistido</h2><p>Servicio de navegador: {{ available: 'Disponible', unavailable: 'No disponible', disabled: 'Deshabilitado', unconfigured: 'Sin configurar' }[data.browserRunner?.status] || data.browserRunner?.status || 'Sin dato'}</p><p>Procesamiento en segundo plano: {{ running: 'Operativo', never: 'Aún no se ha iniciado', stale: 'Sin actividad reciente', error: 'Error de procesamiento', clock_skew: 'Reloj por revisar' }[data.browserWorker?.status] || data.browserWorker?.status || 'Sin dato'}</p><p>Servicio disponible no significa sesión iniciada en Meta. Una caída no cambia las publicaciones a otra vía.</p><details className={styles.technicalDetails}><summary>Detalles técnicos del acceso</summary><p>Servicio: {data.browserRunner?.status || 'Sin dato'} · Comprobado: {date(data.browserRunner?.checkedAt)}</p><p>Procesamiento: {data.browserWorker?.status || 'Sin dato'} · Último heartbeat: {date(data.browserWorker?.lastHeartbeatAt)}</p>{data.browserWorker?.errorCode && <p>{data.browserWorker.errorCode}</p>}</details></aside>}
  </>;
}

function ConnectionCard({ api, connection, selected, report, onMutation, onLogin, onAction }) {
  const currentIds = connection.identities || {}, initial = () => Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, currentIds[key] || '']));
  const [selection, setSelection] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selectionRef = useRef(selection), errorRef = useRef(null), baseline = useRef(JSON.stringify(initial())), locked = useRef(false), requests = useRef(new Set()), rid = useRequestIds(), owner = `connection:${connection.id}`;
  const dirty = JSON.stringify(selection) !== baseline.current;
  useEffect(() => {
    if (JSON.stringify(selectionRef.current) !== baseline.current) return;
    const next = Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, connection.identities?.[key] || '']));
    baseline.current = JSON.stringify(next); selectionRef.current = next; setSelection(next);
  }, [connection.version, connection.identities]);
  useEffect(() => { report(owner, { dirty, busy }); }, [owner, dirty, busy, report]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report(owner, { dirty: false, busy: false }); }, [owner, report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  function choose(key, value) {
    const next = { ...selection, [key]: value };
    if (key === 'pageId') next.instagramId = connection.resources?.pages?.find(item => item.id === value)?.instagramId || '';
    selectionRef.current = next; setSelection(next);
  }
  async function act(action) {
    if (locked.current) return;
    if (action === 'select-assets') {
      const account = connection.resources?.adAccounts?.find(item => item.id === selection.adAccountId);
      if (account?.currency !== connection.currency && !window.confirm(`Cambiar la cuenta cambia la moneda de ${connection.currency || 'sin seleccionar'} a ${account?.currency || 'sin moneda'}. Los borradores deben revalidarse y volver a ingresar el presupuesto, sin reinterpretar importes. ¿Continuar?`)) return;
      if (!window.confirm('Confirma los recursos profesionales seleccionados. Una conexión utilizada por una aprobación no puede cambiar de identidades; se necesita una nueva conexión.')) return;
    }
    locked.current = true; setBusy(true); setError(''); setNotice(''); const controller = new AbortController(); requests.current.add(controller);
    try {
      if (action === 'oauth') {
        const value = await api(ROOT + '/oauth/start', { method: 'POST', body: JSON.stringify({ connectionId: connection.id }), signal: controller.signal });
        const url = new URL(value.authorizationUrl); if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com' || url.username || url.password) throw new Error('URL de autorización no válida.');
        report(owner, { dirty, busy: false });
        window.location.assign(url.href); return;
      }
      const payload = { action, version: connection.version, ...(action === 'select-assets' ? { identities: Object.fromEntries(Object.entries(selection).map(([key, value]) => [key, value || null])) } : {}) };
      const result = await api(`${ROOT}/connections/${encodeURIComponent(connection.id)}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(action, payload) }), signal: controller.signal });
      if (action === 'select-assets') { const next = Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, result.identities?.[key] || ''])); baseline.current = JSON.stringify(next); selectionRef.current = next; setSelection(next); }
      setNotice(`Validación terminada: ${states[result.state] || result.state}. Sólo se habilitan las capacidades comprobadas.`); await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  const resources = connection.resources || {}, page = resources.pages?.find(item => item.id === selection.pageId);
  const resourceName = (group, id, fallback) => id ? resources[group]?.find(item => item.id === id)?.name || id : fallback;
  return <article className={styles.card} aria-label={connection.name || 'Conexión Meta'} aria-current={selected ? 'true' : undefined}><header className={styles.toolbar}><div><h2>{connection.name || 'Conexión Meta'}</h2><p>{methods[connection.integrationMethod]} · Versión {connection.version}</p></div><span className={styles.badge}>{states[connection.state] || connection.state}</span></header>
    <dl className="summary-values"><div><dt>Usuario verificado</dt><dd>{currentIds.userName || currentIds.userId || 'No verificado'}</dd></div><div><dt>Negocio</dt><dd>{resourceName('businesses', currentIds.businessId, 'Sin negocio')}</dd></div><div><dt>Página Facebook</dt><dd>{resourceName('pages', currentIds.pageId, 'Sin página')}</dd></div><div><dt>Instagram profesional</dt><dd>{currentIds.instagramId || 'Sin Instagram profesional'}</dd></div><div><dt>Cuenta de anuncios</dt><dd>{resourceName('adAccounts', currentIds.adAccountId, 'No seleccionada')} · {connection.currency || 'Sin moneda'} · {connection.timeZone || 'Sin zona verificada'}</dd></div><div><dt>Última validación / consulta</dt><dd>{date(connection.validatedAt)}</dd></div><div><dt>Caducidad informada</dt><dd>{connection.expiresAt ? date(connection.expiresAt) : 'No informada; no significa sesión perpetua'}</dd></div></dl>
    {connection.disconnectStatus && <div className={styles.warning} role="status"><p>{connection.disconnectStatus.state === 'needs_confirmation' ? 'Las cantidades o la autorización cambiaron. Revisa y confirma de nuevo la desconexión/eliminación.' : 'Pausas pendientes de confirmar antes de desconectar. Aún no se afirma que se detuvo el gasto.'}</p><p>Solicitada: {date(connection.disconnectStatus.requestedAt)}</p>{connection.disconnectStatus.receiptId && <p>Recibo solicitado: {connection.disconnectStatus.receiptId}</p>}{connection.disconnectStatus.state === 'needs_confirmation' && <button type="button" className="button subtle" disabled={busy || dirty} onClick={() => onAction(connection.disconnectStatus.action)}>Revisar y confirmar de nuevo</button>}</div>}
    <ul className={styles.choiceList}>{Object.entries(capabilities).map(([key, label]) => <li key={key}>{label}: <strong>{connection.state === 'connected' && connection.capabilities?.[key] ? 'Disponible' : 'No acreditada / no disponible'}</strong></li>)}</ul>
    {connection.resourceNotice && <p className={styles.notice}>{connection.resourceNotice}</p>}
    {connection.state === 'layout_changed' && <p className={styles.warning}>No se harán clics alternativos: se requiere corregir y revalidar la versión del adaptador.</p>}
    {connection.state === 'challenge_required' && <p className={styles.warning}>Completa el desafío personalmente en el visor; no hay evasión ni reintento de contraseña.</p>}
    <details className={styles.detail} open={dirty || undefined}><summary>Elegir página y cuenta de anuncios</summary><p>Selecciona únicamente recursos descubiertos por esta vía. No se aceptan identificadores escritos libremente ni cambios de recursos de una conexión aprobada.</p>
      <fieldset disabled={busy || connection.state !== 'connected'} className={styles.fieldGrid}><legend>Recursos profesionales</legend>
        <SelectField name={`business-${connection.id}`} label="Negocio" value={selection.businessId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.businesses || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('businessId', value)}/>
        <SelectField name={`page-${connection.id}`} label="Página Facebook" value={selection.pageId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.pages || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('pageId', value)}/>
        <SelectField name={`instagram-${connection.id}`} label="Instagram profesional vinculado" value={selection.instagramId} options={[{ value: '', label: 'Sin seleccionar' }, ...(page?.instagramId ? [{ value: page.instagramId, label: page.instagramId }] : [])]} onChange={value => choose('instagramId', value)}/>
        <SelectField name={`account-${connection.id}`} label="Cuenta de anuncios" value={selection.adAccountId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.adAccounts || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.currency || 'Sin moneda'} · ${item.timeZone || 'Sin zona'}` }))]} onChange={value => choose('adAccountId', value)}/>
      </fieldset><button type="button" className="button primary" disabled={busy || !dirty || connection.state !== 'connected'} onClick={() => act('select-assets')}>Confirmar y revalidar recursos</button>
    </details>
    <details className={styles.technicalDetails}><summary>Detalles técnicos</summary><p>Permisos concedidos: {connection.permissions?.join(', ') || 'No informados por esta vía'}</p><p>Adaptador: {connection.adapterVersion || 'Versión no informada'} · Formato: {connection.locale || 'No informado'}</p></details>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || dirty} onClick={() => act('validate')}>Comprobar conexión</button><button type="button" className="button subtle" disabled={busy || dirty} onClick={() => connection.integrationMethod === 'api' ? act('oauth') : onLogin()}>{connection.integrationMethod === 'api' ? 'Volver a iniciar sesión' : 'Abrir acceso asistido'}</button></div>
    <details className={styles.technicalDetails}><summary>Desconectar o eliminar datos locales</summary><div className={styles.actions}><button type="button" className="button subtle" disabled={busy || dirty || connection.state === 'disconnected'} onClick={() => onAction('disconnect')}>Desconectar cuenta</button><button type="button" className="button danger" disabled={busy || dirty} onClick={() => onAction('delete-platform-data')}>Eliminar datos locales…</button></div></details>
  </article>;
}

function ConnectionDialog({ api, connection, action, onClose, onComplete, report }) {
  const deleting = action === 'delete-platform-data', ref = useRef(null), errorRef = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [pause, setPause] = useState(true), [warningAccepted, setWarningAccepted] = useState(false), [retry, setRetry] = useState(0);
  const close = useDialog(ref, { busy, dirty: confirm || warningAccepted || !pause, onClose });
  useEffect(() => { report({ busy, dirty: confirm || warningAccepted || !pause }); }, [busy, confirm, warningAccepted, pause, report]);
  useEffect(() => {
    if (!deleting) return;
    const controller = new AbortController(); requests.current.add(controller); setError('');
    api(`${ROOT}/connections/${connection.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'preview-delete-platform-data' }), signal: controller.signal }).then(setPreview).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => { controller.abort(); requests.current.delete(controller); };
  }, [api, connection.id, deleting, retry]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report({ busy: false, dirty: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function submit(event) {
    event.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const payload = { action, version: connection.version, pauseAndDisconnect: pause, acceptActiveAdsWarning: !pause && warningAccepted, ...(deleting ? { confirmDelete: confirm, confirmCounts: preview?.counts } : {}) };
      const result = await api(`${ROOT}/connections/${connection.id}/actions`, { method: 'POST', body: JSON.stringify({ ...payload, requestId: rid(action, payload) }), signal: controller.signal });
      report({ dirty: false, busy: false }); onComplete(result);
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog}`} aria-labelledby="social-connection-action-title"><form method="post" onSubmit={submit} ><header className={styles.dialogHeader}><h2 id="social-connection-action-title">{deleting ? 'Eliminar datos locales de plataforma' : 'Desconectar cuenta'} · {connection.name || methods[connection.integrationMethod]}</h2></header><div className={styles.dialogBody}>
    <p>Se cancelará el trabajo no enviado y se retirará la autenticación. No se borran publicaciones en Meta. Ante un envío incierto, hay que comprobar el estado en Meta sin reenviar.</p>
    {deleting && <><p>Se eliminarán publicaciones y anuncios, versiones aprobadas, capturas de resultados, estimaciones, ideas de mejora y sus vínculos. Los pedidos, gastos, pagos e imágenes y videos subidos permanecen. Esto no despublica ni garantiza detener anuncios remotos.</p>{preview ? <dl className="summary-values">{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{DELETION_COUNT_LABELS[key] || key}</dt><dd>{value}</dd></div>)}</dl> : <p role="status">Consultando cantidades actuales…</p>}<label className={styles.checkRow}><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={busy || !preview}/>Confirmo eliminar definitivamente estas cantidades de datos locales.</label></>}
    <label className={styles.checkRow}><input type="checkbox" checked={pause} onChange={event => setPause(event.target.checked)} disabled={busy} data-dialog-initial-focus/>Pausar anuncios y comprobar su estado antes de desconectar{deleting ? ' y eliminar' : ''}.</label>
    <p className={styles.muted}>Por navegador, esta acción puede quedar pendiente del consumidor. Se conserva la custodia hasta confirmar las pausas. Si faltan permisos, detén los anuncios directamente en Meta.</p>
    {!pause && <label className={styles.checkRow}><input type="checkbox" checked={warningAccepted} onChange={event => setWarningAccepted(event.target.checked)} disabled={busy}/>Acepto que pueden seguir gastando y que debo detenerlos directamente en Meta; la desconexión local no confirma una pausa.</label>}
    {error && <div ref={errorRef} tabIndex={-1} className={styles.error} role="alert"><p>{error}</p>{deleting && <button type="button" className="button subtle" disabled={busy} onClick={() => { setConfirm(false); setPreview(null); setRetry(value => value + 1); }}>Revisar cantidades otra vez</button>}</div>}
    </div><footer className={styles.actions}><button type="button" className="button subtle" disabled={busy} onClick={close}>Cancelar</button><button type="submit" className={`button ${deleting ? 'danger' : 'primary'}`} disabled={busy || (deleting && (!preview || !confirm)) || (!pause && !warningAccepted)}>{busy ? 'Registrando solicitud…' : pause ? `Pausar y ${deleting ? 'eliminar datos' : 'desconectar'}` : deleting ? 'Eliminar sólo datos locales' : 'Desconectar sin afirmar pausa'}</button></footer></form></dialog>;
}

export default function SocialConnectionsSettings({ api, view, onViewChange, onInteractionStateChange, onMutation, revision = 0 }) {
  const [refresh, setRefresh] = useState(0), [notice, setNotice] = useState(''), [login, setLogin] = useState(null), [dialog, setDialog] = useState(null), [pauseRequests, setPauseRequests] = useState([]), [settingsLocked, setSettingsLocked] = useState(false);
  const heading = useRef(null), interaction = useRef(new Map()), callbacks = useRef({}), mounted = useRef(true);
  callbacks.current = { onInteractionStateChange, onMutation };
  const report = useCallback((owner, state) => {
    interaction.current.set(owner, state);
    if (owner === 'settings') setSettingsLocked(Boolean(state.dirty || state.busy));
    callbacks.current.onInteractionStateChange?.({ dirty: [...interaction.current.values()].some(item => item.dirty), busy: [...interaction.current.values()].some(item => item.busy) });
  }, []);
  const loginReport = useCallback(state => report('login', state), [report]);
  const dialogReport = useCallback(state => report('dialog', state), [report]);
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = event => { if ([...interaction.current.values()].some(item => item.dirty || item.busy)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onInteractionStateChange?.({ dirty: false, busy: false }); };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const invalidate = useCallback(async () => {
    if (mounted.current) setRefresh(value => value + 1);
    try { await callbacks.current.onMutation?.(); } catch (cause) { if (mounted.current) setNotice('Operación guardada; actualización general pendiente. ' + cause.message); }
  }, []);
  const refreshKey = revision + ':' + refresh;
  const connectionRead = useRead(api, ROOT + '/connections', refreshKey, 5000);
  const settingsRead = useRead(api, ROOT + '/settings', refreshKey);
  const connections = connectionRead.data?.connections || [];
  const change = patch => onViewChange({ ...patch, page: 1 });
  function connectionCompleted(result) {
    if (result.disconnectPending) {
      setPauseRequests(previous => [...previous.filter(item => item.connectionId !== dialog?.connection.id), { connectionId: dialog?.connection.id, name: dialog?.connection.name, receiptId: result.receiptId, operationIds: result.operationIds || [] }]);
      setNotice(result.warning || 'Pausas encoladas. La desconexión espera confirmación remota; aún no se confirma que el gasto se detuvo.');
    } else if (result.receiptId) setNotice(`Eliminación local completada. Recibo ${result.receiptId}. ${result.remoteSpendStopped ? 'Pausa remota confirmada.' : 'No se confirmó la detención del gasto en Meta.'}`);
    else setNotice(result.warning || 'Conexión actualizada. Las publicaciones remotas no se eliminan.');
    report('dialog', { dirty: false, busy: false }); setDialog(null); void invalidate();
  }
  return <section className={styles.workspace} aria-label="Configuración de redes sociales">
    <header className="workspace-heading"><div><p className={styles.eyebrow}>Facebook e Instagram</p><h2 ref={heading} tabIndex={-1}>Conexiones y publicación en Meta</h2><p>Configura Meta y administra las cuentas conectadas. Guardar opciones o conectar no publica ni activa anuncios.</p></div></header>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <ReadStatus state={settingsRead} label="opciones de Meta" onRetry={() => setRefresh(value => value + 1)}/>
    {settingsRead.data && <SocialSettingsForm api={api} settings={settingsRead.data} report={report} onSaved={invalidate} disabled={Boolean(dialog || login)}/>}
    {settingsLocked && <p className={styles.help}>Guarda o descarta las opciones antes de administrar las cuentas.</p>}
    <fieldset className={styles.connectionFieldset} disabled={Boolean(dialog || login || settingsLocked)} inert={Boolean(dialog || login)}><legend>Cuentas conectadas</legend>
      <ReadStatus state={connectionRead} label="conexiones y estado del consumidor" onRetry={() => setRefresh(value => value + 1)}/>
      <ConnectionsIntro api={api} data={connectionRead.data} report={report} onMutation={invalidate} onCreated={connection => { setLogin(connection); change({ record: connection.id }); }}/>
      <div className={styles.stack}>{connections.map(connection => <ConnectionCard key={connection.id} api={api} connection={connection} selected={view.record === connection.id} report={report} onMutation={invalidate} onLogin={() => { setLogin(connection); change({ record: connection.id }); }} onAction={action => setDialog({ connection, action })}/>)}</div>
      {connectionRead.data && !connections.length && <div className={`admin-empty ${styles.empty}`}><h2>Conecta tu negocio</h2><p>Elige una vía arriba. API y navegador tienen requisitos independientes; una no sustituye a la otra ante un error.</p></div>}
      {pauseRequests.map(item => { const connection = connections.find(value => value.id === item.connectionId), receipt = connectionRead.data?.deletionReceipts?.find(value => value.receiptId === item.receiptId); return <article key={item.connectionId} className={styles.notice}><h3>Solicitud de pausa y desconexión · {item.name || 'Conexión'}</h3><p>{receipt ? 'Eliminación local completada tras pausa remota confirmada.' : connection?.state === 'disconnected' ? 'Desconexión completada. Consulta la evidencia de las entregas para el último estado confirmado.' : 'Pendiente: no se afirma que los anuncios hayan dejado de gastar.'}</p>{item.receiptId && <p>Recibo solicitado: {item.receiptId}</p>}<p>Operaciones: {item.operationIds.join(', ') || 'Sin identificadores disponibles'}</p></article>; })}
      {!!connectionRead.data?.deletionReceipts?.length && <details className={styles.evidence}><summary>Recibos de eliminación local</summary>{connectionRead.data.deletionReceipts.map(receipt => <article key={receipt.receiptId}><h3>{receipt.receiptId}</h3><p>{date(receipt.deletedAt)} · {receipt.remoteSpendStopped ? 'Pausa remota confirmada' : 'Detención del gasto no confirmada'} · No se borró contenido en Meta</p><dl className="summary-values">{Object.entries(receipt.counts || {}).map(([key, value]) => <div key={key}><dt>{DELETION_COUNT_LABELS[key] || key}</dt><dd>{value}</dd></div>)}</dl></article>)}</details>}
    </fieldset>
    {login && <SocialBrowserLogin api={api} connection={login} onClose={() => { report('login', { dirty: false, busy: false }); setLogin(null); }} onConnected={invalidate} onInteractionStateChange={loginReport}/>}
    {dialog && <ConnectionDialog api={api} connection={dialog.connection} action={dialog.action} onClose={() => { report('dialog', { dirty: false, busy: false }); setDialog(null); }} onComplete={connectionCompleted} report={dialogReport}/>}
  </section>;
}

function settingsForm(settings) {
  return { version: settings.version, publicBaseUrl: settings.publicBaseUrl || window.location.origin, appId: settings.appId || '', loginConfigId: settings.loginConfigId || '', publishingEnabled: Boolean(settings.publishingEnabled), browserEnabled: Boolean(settings.browserEnabled), appSecret: '' };
}

function SocialSettingsForm({ api, settings, report, onSaved, disabled }) {
  const [form, setForm] = useState(() => settingsForm(settings)), [saved, setSaved] = useState(settings), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [notice, setNotice] = useState('');
  const baseline = useRef(JSON.stringify(form)), current = useRef(form), savedVersion = useRef(settings.version), errorRef = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const dirty = JSON.stringify(form) !== baseline.current;
  useEffect(() => {
    // A delayed refresh of an acknowledged version must not replace a newer local edit.
    if (settings.version <= savedVersion.current || JSON.stringify(current.current) !== baseline.current) return;
    const next = settingsForm(settings);
    savedVersion.current = settings.version; baseline.current = JSON.stringify(next); current.current = next; setForm(next); setSaved(settings);
  }, [settings]);
  useEffect(() => { report('settings', { dirty, busy }); }, [dirty, busy, report]);
  useEffect(() => () => { for (const controller of requests.current) controller.abort(); report('settings', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const set = (key, value) => { const next = { ...current.current, [key]: value }; current.current = next; setForm(next); setNotice(''); };
  async function submit(event) {
    event.preventDefault(); if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const { appSecret, ...options } = form, payload = { ...options, ...(appSecret ? { appSecret } : {}) };
      const result = await api(ROOT + '/settings', { method: 'PUT', body: JSON.stringify({ ...payload, requestId: rid('settings-save', payload) }), signal: controller.signal });
      const next = settingsForm(result);
      savedVersion.current = result.version; baseline.current = JSON.stringify(next); current.current = next; setForm(next); setSaved(result); setConflict(false);
      report('settings', { dirty: false, busy: true }); setNotice('Opciones guardadas. Los procesos en marcha usarán esta configuración en su próxima operación. No se publicó ni activó ningún anuncio.');
      await onSaved();
    } catch (cause) {
      if (cause.name !== 'AbortError') { setConflict(cause.status === 409); setError(cause.message); }
    } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  async function reload() {
    if (locked.current || (dirty && !window.confirm('¿Descartar los cambios de opciones y cargar la configuración vigente?'))) return;
    locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const result = await api(ROOT + '/settings', { signal: controller.signal }), next = settingsForm(result);
      savedVersion.current = result.version; baseline.current = JSON.stringify(next); current.current = next; setForm(next); setSaved(result); setConflict(false); setNotice('Configuración vigente cargada. Revisa los valores antes de guardar.');
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); }
    finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  return <form className={styles.panel} onSubmit={submit} aria-label="Opciones de Meta" aria-busy={busy}>
    <h2>Opciones de Meta</h2>
    <p>Los cambios se aplican sin reiniciar. Cambiar app, secreto u origen exige volver a verificar las preparaciones pendientes. Para cambiar de app, desconecta antes las cuentas API.</p>
    <fieldset disabled={busy || disabled} className={styles.connectionFieldset}><legend>Configuración de publicación</legend>
      <div className={styles.fieldGrid}>
        <label className="field">Origen público del panel<input name="publicBaseUrl" type="url" maxLength={2048} required value={form.publicBaseUrl} onChange={event => set('publicBaseUrl', event.target.value)} aria-describedby="social-origin-help"/></label>
        <label className="field">ID de app de Meta<input name="appId" maxLength={100} value={form.appId} onChange={event => set('appId', event.target.value)} autoComplete="off"/></label>
        <label className="field">ID de configuración de inicio de sesión<input name="loginConfigId" maxLength={100} value={form.loginConfigId} onChange={event => set('loginConfigId', event.target.value)} autoComplete="off"/></label>
        <label className="field">Secreto de app de Meta<input name="appSecret" type="password" maxLength={4096} value={form.appSecret} onChange={event => set('appSecret', event.target.value)} autoComplete="new-password" aria-describedby="social-secret-help"/></label>
      </div>
      <p id="social-origin-help" className={styles.help}>Usa el origen HTTPS autorizado del panel, sin ruta. Solo se permite HTTP en loopback de desarrollo.</p>
      <p id="social-secret-help" className={styles.help}>{saved.hasAppSecret ? 'Hay un secreto guardado; nunca se muestra. Deja el campo vacío para conservarlo.' : 'No hay secreto guardado.'} Cambiar la app requiere introducir un secreto nuevo.</p>
      <label className={styles.checkRow}><input name="publishingEnabled" type="checkbox" checked={form.publishingEnabled} onChange={event => set('publishingEnabled', event.target.checked)}/>Habilitar publicación y activación</label>
      <label className={styles.checkRow}><input name="browserEnabled" type="checkbox" checked={form.browserEnabled} onChange={event => set('browserEnabled', event.target.checked)}/>Habilitar acceso asistido por navegador</label>
      <p className={styles.warning}>Deshabilitar impide nuevos envíos; no confirma detener gasto remoto ni revierte operaciones ya autorizadas. La lectura, conciliación y pausa segura siguen disponibles con acceso válido.</p>
      <dl className="summary-values"><div><dt>Callback de Meta guardado</dt><dd>{saved.callbackUrl || 'Guarda el origen para obtener la URL.'}</dd></div><div><dt>URL de eliminación de datos guardada</dt><dd>{saved.dataDeletionUrl || 'Guarda el origen para obtener la URL.'}</dd></div></dl>
    </fieldset>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{error}</p>{conflict && <p>Se conservan tus cambios. Carga la versión vigente y revísala; no se sobrescribe automáticamente.</p>}<button type="button" className="button subtle" disabled={busy || disabled} onClick={reload}>Cargar configuración vigente</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div className={styles.actions}><span role="status">{busy ? 'Guardando o consultando opciones…' : dirty ? 'Cambios sin guardar' : `Versión guardada: ${saved.version}`}</span><button type="submit" className="button primary" disabled={busy || disabled || (!dirty && saved.version !== 0)}>Guardar opciones de Meta</button><button type="button" className="button subtle" disabled={busy || disabled || !dirty} onClick={reload}>Descartar cambios de opciones</button></div>
  </form>;
}
