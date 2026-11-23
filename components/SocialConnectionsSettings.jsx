'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantBridge } from './AssistantBridge';
import { Field } from './Fields';
import useDialog from './useDialog';
import SocialBrowserLogin from './SocialBrowserLogin';
import { ManualMetaConnection, MetaEvaluation, MetaAdvertisingRead } from './MetaConnectionReadOnly';
import { MetaConnectionData } from './MetaAccountAnalysis';
import styles from './AdvertisingWorkspace.module.css';
import connectionStyles from './SocialConnectionsSettings.module.css';

const ROOT = '/api/admin/social';

const states = { draft: 'Borrador', ready: 'Preparada, sin gasto autorizado', scheduled: 'Programada', publishing: 'En preparación o publicación', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión de Meta', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Falló', needs_attention: 'Requiere atención', cancelled: 'Cancelada', queued: 'En cola', preparing: 'Preparando', uncertain: 'Envío incierto: comprobar estado en Meta sin reenviar', blocked: 'Bloqueada', connected: 'Conectada', reconnect_required: 'Sesión vencida o revocada: reconectar', disconnected: 'Desconectada', login_required: 'Necesita iniciar sesión', login_in_progress: 'Acceso en curso; control exclusivo', challenge_required: 'Desafío pendiente: intervención humana', layout_changed: 'Interfaz incompatible: revalidar adaptador' };

const methods = { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' };
const capabilities = { facebookPublish: 'Publicar en Facebook', instagramPublish: 'Publicar en Instagram', adsPublish: 'Preparar y administrar anuncios pagados', insights: 'Consultar resultados', whatsappAds: 'Anuncios con WhatsApp vinculado' };
const DELETION_COUNT_LABELS = { campaigns: 'Publicaciones y anuncios', deliveries: 'Entregas a redes', operations: 'Operaciones', recommendations: 'Ideas de mejora', measurements: 'Capturas de resultados', forecasts: 'Estimaciones', revisions: 'Versiones aprobadas', orderLinks: 'Vínculos de pedidos', expenseLinks: 'Vínculos de gastos', accountAnalyses: 'Análisis de cuentas', accountAnalysisItems: 'Registros analizados de Meta' };

const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Sin fecha disponible';
const isToken = connection => connection.authenticationMethod === 'token' || connection.readOnly;
const hasExpired = connection => typeof connection.expiresAt === 'string' && /^\d{4}-/.test(connection.expiresAt) && Date.parse(connection.expiresAt) <= Date.now();
const methodLabel = connection => isToken(connection) ? 'Token manual · Solo lectura' : methods[connection.integrationMethod];
const fieldLabels = { publicBaseUrl: 'Origen público del panel', appId: 'ID de app de Meta', appSecret: 'Secreto de app de Meta', loginConfigId: 'ID de configuración de inicio de sesión' };
const requirementLabel = key => fieldLabels[key] || 'Custodia del servidor (solicita revisión al administrador técnico)';
const requirementIssues = requirement => [...new Set([...(requirement?.missing || []), ...(requirement?.invalid || [])].map(requirementLabel))];
const steps = ['Preparar la aplicación', 'Conectar con Facebook', 'Elegir recursos y comprobar acceso'];

function connectionName(connection, connections) {
  const nameOf = item => item.name?.trim() || item.resources?.pages?.find(page => page.id === item.identities?.pageId)?.name || item.resources?.adAccounts?.find(account => account.id === item.identities?.adAccountId)?.name || item.identities?.userName;
  const name = nameOf(connection);
  return !name || connections.some(item => item.id !== connection.id && nameOf(item)?.toLocaleLowerCase('es') === name.toLocaleLowerCase('es')) ? `${name || 'Conexión Meta'} · ${connection.id.slice(0, 8)}` : name;
}

function connectionState(connection) {
  if (connection.disconnectStatus?.state === 'waiting_for_pause') return 'Pausa pendiente antes de desconectar';
  if (connection.disconnectStatus?.state === 'needs_confirmation') return 'Requiere confirmar la desconexión o eliminación';
  if (connection.revalidationRequired && connection.state === 'connected') return 'Requiere verificación';
  if (connection.state === 'connected' && hasExpired(connection)) return 'Sesión vencida: reconectar';
  return states[connection.state] || 'Estado no informado';
}

function useRead(api, path, refresh, interval = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: true, fetchedAt: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); let active = true, timer;
    async function load() {
      if (!active) return;
      if (interval && document.hidden) { timer = setTimeout(load, interval); return; }
      if (!interval) setState(previous => ({ ...previous, loading: true }));
      try {
        const data = await api(path, { signal: controller.signal });
        if (active) setState({ data, error: '', loading: false, fetchedAt: new Date().toISOString() });
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
  return <>{state.loading && !state.data && <p role="status" className={styles.muted}>Cargando {label}…</p>}{state.error && <div role="alert" className={styles.error}><p>{state.error}</p>{state.data && <p>Última consulta conservada: {date(state.fetchedAt)}. Puede estar desactualizada.</p>}<button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura</button></div>}</>;
}

function SelectField({ name, label, value, options, onChange, advisorControl }) {
  return <Field field={{ name, label, type: 'select', options, advisorControl }} value={value || ''} onChange={onChange}/>;
}
function useRequestIds() {
  const ids = useRef(new Map());
  return useCallback((key, payload) => {
    const fingerprint = JSON.stringify(payload), prior = ids.current.get(key);
    if (prior?.fingerprint === fingerprint) return prior.id;
    const id = crypto.randomUUID(); ids.current.set(key, { fingerprint, id }); return id;
  }, []);
}

function BrowserHealth({ data }) {
  const service = data.browserRunner, worker = data.browserWorker;
  return <details className={styles.detail} data-advisor-disclosure>
    <summary>Estado del acceso asistido</summary>
    <p>Servicio de navegador: {{ available: 'Disponible', unavailable: 'No disponible', disabled: 'Deshabilitado', unconfigured: 'Sin configurar' }[service?.status] || service?.status || 'Sin dato'}</p>
    <p>Procesamiento en segundo plano: {{ running: 'Operativo', never: 'Aún no se ha iniciado', stale: 'Sin actividad reciente', error: 'Error de procesamiento', clock_skew: 'Reloj por revisar' }[worker?.status] || worker?.status || 'Sin dato'}</p>
    <p>Servicio disponible no significa sesión iniciada en Meta. Una caída no cambia las publicaciones a otra vía.</p>
    <details className={styles.technicalDetails}><summary data-advisor-control="meta-browser-health-detail">Detalles técnicos del acceso</summary>
      <p>Servicio: {service?.status || 'Sin dato'} · Comprobado: {date(service?.checkedAt)}</p>
      <p>Procesamiento: {worker?.status || 'Sin dato'} · Último heartbeat: {date(worker?.lastHeartbeatAt)}</p>
      {worker?.errorCode && <p>{worker.errorCode}</p>}
    </details>
  </details>;
}

function ConnectionsIntro({ api, data, report, onMutation, onCreated, onConfigure, manualFirst, blocked }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), errorRef = useRef(null), controllers = useRef(new Set()), rid = useRequestIds();
  useEffect(() => { report('connection-create', { dirty: Boolean(name), busy }); }, [name, busy, report]);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); report('connection-create', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function connect(method) {
    if (locked.current || blocked) return; locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); controllers.current.add(controller);
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
        setName(''); void onMutation(); report('connection-create', { dirty: false, busy: false }); onCreated(connection);
      }
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { controllers.current.delete(controller); locked.current = false; setBusy(false); }
  }
  const oauth = data?.requirements?.find(item => item.integrationMethod === 'api');
  const browser = data?.requirements?.find(item => item.integrationMethod === 'browser');
  const prepared = oauth?.configured && oauth.enabled;
  const browserAvailable = browser?.configured && browser.enabled && !blocked;
  return <>
    <div className={styles.startPanel}>
      <div><h2>Conecta tu cuenta de Meta</h2><ul>
        <li>Usuario de Facebook con acceso a la página.</li>
        <li>Si usas Instagram, una cuenta profesional vinculada a esa página.</li>
        <li>Si trabajas con anuncios, acceso a la cuenta publicitaria.</li>
      </ul></div>
      <ol className={styles.journey}>{steps.map((step, index) => <li key={step} aria-current={index === (prepared ? 1 : 0) ? 'step' : undefined}><span>{index + 1}</span>{step}</li>)}</ol>
    </div>
    <article className={styles.card}>
      <h3>{prepared ? 'Autoriza tu cuenta' : 'Prepara la aplicación de Meta'}</h3>
      <p>En Meta for Developers → Facebook Login for Business → Configurations, selecciona <strong>Token de acceso de usuario</strong>, no de usuario del sistema. Guarda el ID de configuración y registra el callback exacto indicado en Opciones de Meta.</p>
      <p>Autoriza con el usuario de Facebook que puede acceder a tus recursos. No introduces su contraseña aquí. Si solo quieres consultar, deja la publicación apagada.</p>
      {!!requirementIssues(oauth).length && <p>Por revisar: {requirementIssues(oauth).join(' · ')}.</p>}
      {oauth && !oauth.publishingEnabled && <p className={styles.warning}>Publicar, activar y reanudar está deshabilitado. Guardar un borrador local no autoriza gasto; una pausa segura sigue siendo posible con acceso válido.</p>}
      <div className={styles.actions}>
        {!prepared && <button type="button" className="button primary" onClick={() => onConfigure(oauth)}>Configurar la aplicación</button>}
        <button type="button" className="button primary" data-advisor-control="meta-oauth-connect-control" disabled={busy || blocked || !prepared} onClick={() => connect('api')}>Conectar con Facebook</button>
      </div>
    </article>
    <details className={styles.detail} open={manualFirst || undefined} data-advisor-disclosure>
      <summary>Otras formas de conexión</summary>
      <div role="group" aria-label="Registro de token de solo lectura" tabIndex={-1} data-advisor-control="meta-manual-token-form">
        <ManualMetaConnection api={api} requirement={data?.tokenRequirement} issues={requirementIssues(data?.tokenRequirement)} report={report} onMutation={onMutation} onCreated={onCreated}/>
      </div>
      <article className={styles.card}><h3>Acceso asistido por navegador</h3>
        <p>Inicia sesión personalmente en un visor privado. Esta vía requiere autorización independiente de Meta; no sustituye automáticamente a la API.</p>
        <p className={styles.warning}>Los desafíos se resuelven personalmente. La sesión se conserva cifrada; no se guardan contraseñas, códigos de un solo uso ni capturas.</p>
        {!!requirementIssues(browser).length && <p>Por revisar: {requirementIssues(browser).join(' · ')}.</p>}
        <form method="post" onSubmit={event => { event.preventDefault(); void connect('browser'); }}><Field field={{ name: 'browserName', label: 'Nombre de la conexión', advisorControl: 'meta-browser-connection-create', required: true, max: 200 }} value={name} onChange={setName}/><button type="submit" className="button primary" disabled={busy || !browserAvailable || !name.trim()}>Crear conexión y abrir acceso</button></form>
      </article>
      {error && <p ref={errorRef} tabIndex={-1} className={styles.error} role="alert">{error}</p>}
    </details>
  </>;
}

function ConnectionCard({ api, connection, title, heading, requirement, runner, freshnessBlocked, operationsBlocked, report, onMutation, onLogin, onAction, onNewToken, onNavigate }) {
  const currentIds = connection.identities || {}, initial = () => Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, currentIds[key] || '']));
  const [selection, setSelection] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selectionRef = useRef(selection), errorRef = useRef(null), baseline = useRef(JSON.stringify(initial())), locked = useRef(false), requests = useRef(new Set()), rid = useRequestIds(), owner = `connection:${connection.id}`;
  const resources = connection.resources || {};
  const availableResources = Boolean(resources.pages?.length || resources.adAccounts?.length);
  const needsSelection = connection.state === 'connected' && !currentIds.pageId && !currentIds.adAccountId && availableResources;
  const autoSelect = useRef(needsSelection);
  const analysisReport = useCallback(state => report(`analysis:${owner}`, state), [owner, report]);
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
    if (locked.current || operationsBlocked || freshnessBlocked) return;
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
      if (action === 'select-assets' && result.state === 'connected') { const next = Object.fromEntries(['businessId', 'pageId', 'instagramId', 'adAccountId'].map(key => [key, result.identities?.[key] || ''])); baseline.current = JSON.stringify(next); selectionRef.current = next; setSelection(next); }
      setNotice(result.state === 'reconnect_required' ? 'Meta no confirmó el acceso vigente. Sigue la indicación de esta ficha y revisa la evaluación de acceso.' : `Comprobación de Meta: ${states[result.state] || result.state}.`); await onMutation(result);
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { requests.current.delete(controller); locked.current = false; setBusy(false); }
  }
  const page = resources.pages?.find(item => item.id === selection.pageId);
  const resourceName = (group, id, fallback) => id ? resources[group]?.find(item => item.id === id)?.name || id : fallback;
  const tokenOnly = isToken(connection), browser = connection.integrationMethod === 'browser';
  const disconnected = connection.state === 'disconnected', pending = Boolean(connection.disconnectStatus);
  const loginInProgress = connection.state === 'login_in_progress';
  const enabled = requirement?.configured && requirement.enabled;
  const expired = hasExpired(connection);
  const reconnect = connection.state === 'reconnect_required' || (connection.state === 'connected' && expired && !connection.revalidationRequired);
  const access = connection.state === 'connected' && !connection.revalidationRequired && !pending && !expired;
  const actionBlocked = busy || operationsBlocked || freshnessBlocked;
  const valid = !disconnected && !pending && !reconnect && !loginInProgress && enabled;
  const canAuthorize = !pending && !loginInProgress && !tokenOnly;
  const authLabel = browser ? 'Abrir acceso asistido' : 'Volver a autorizar con Facebook';
  const authorize = () => browser ? onLogin() : act('oauth');
  const authorizer = canAuthorize && <button type="button" className={`button ${reconnect ? 'primary' : 'subtle'}`} data-advisor-control={browser ? 'meta-existing-browser-connection-open' : 'meta-oauth-reauthorize-control'} disabled={actionBlocked || dirty || !enabled || (browser && runner?.status !== 'available')} onClick={authorize}>{authLabel}</button>;
  const nextStep = pending ? 'Revisa la solicitud de desconexión o eliminación.'
    : disconnected ? 'Puedes consultar el histórico guardado o administrar los datos locales. Las credenciales fueron retiradas.'
      : reconnect ? tokenOnly ? 'Conecta un token vigente de la misma aplicación y vuelve a elegir la cuenta publicitaria.' : browser ? 'Abre el visor para iniciar sesión personalmente.' : 'Autoriza de nuevo con el mismo usuario de Facebook y luego verifica la conexión.'
        : connection.revalidationRequired ? 'Verifica la conexión antes de usar sus permisos.'
          : loginInProgress ? 'Ya existe un acceso en curso. Completa o cierra ese visor antes de abrir otro.'
            : needsSelection ? 'Elige los recursos profesionales y comprueba su acceso.'
              : connection.state === 'login_required' && browser ? 'Abre el visor para iniciar sesión personalmente.' : 'Consulta el historial o verifica el acceso antes de trabajar con los recursos.';
  const instagram = resources.pages?.find(item => item.instagramId === currentIds.instagramId);
  const metricsAvailable = access && !actionBlocked && !dirty && enabled && currentIds.adAccountId && connection.capabilities?.insights === true
    && connection.evaluation?.permissions?.some(item => ['ads_read', 'ads_management'].includes(item.name) && item.status === 'granted');
  return <article className={`${styles.card} ${connectionStyles.connection}`} aria-label={title} data-meta-connection-id={connection.id}><header className={styles.toolbar}><div><h2 ref={heading} tabIndex={-1}>{title}</h2><p>{methodLabel(connection)}</p></div><span className={styles.badge}>{connectionState(connection)}</span></header>
    <div>
      <h3>Siguiente paso</h3><p>{nextStep}</p>
      {!enabled && <p className={styles.warning}>Esta vía no está configurada o habilitada. Revisa Opciones de Meta.</p>}
      {browser && runner?.status !== 'available' && <p className={styles.warning}>El visor no está disponible en esta comprobación. Estado: {runner?.status === 'disabled' ? 'deshabilitado' : runner?.status === 'unconfigured' ? 'sin configurar' : 'servicio no disponible'}. Los permisos anteriores se muestran con la fecha de su última comprobación.</p>}
      {connection.state === 'layout_changed' && <p className={styles.warning}>Revisa la versión del adaptador y vuelve a verificar la conexión. No se harán clics alternativos.</p>}
      {connection.state === 'challenge_required' && <p className={styles.warning}>Abre el visor para completar personalmente el desafío.</p>}
      <div className={styles.actions}>{reconnect && !tokenOnly && authorizer}{tokenOnly && reconnect && !pending && <button type="button" className="button primary" onClick={onNewToken}>Conectar un token nuevo</button>}
        {valid && connection.revalidationRequired && <button type="button" className="button primary" data-advisor-control="meta-connection-validate-control" disabled={actionBlocked || dirty} onClick={() => act('validate')}>Verificar conexión</button>}
        {browser && !reconnect && ['login_required', 'challenge_required'].includes(connection.state) && authorizer}
      </div>
    </div>
    {pending && <div className={styles.warning} role="status" tabIndex={-1} data-advisor-control="meta-current-disconnection-status"><p>{connection.disconnectStatus.state === 'needs_confirmation' ? 'Las cantidades o la autorización cambiaron. Revisa y confirma de nuevo la acción solicitada.' : 'Pausas pendientes de confirmar antes de desconectar. Aún no se afirma que se detuvo el gasto.'}</p><p>Solicitada: {date(connection.disconnectStatus.requestedAt)}</p>{connection.disconnectStatus.receiptId && <p>Recibo solicitado: {connection.disconnectStatus.receiptId}</p>}{connection.disconnectStatus.state === 'needs_confirmation' && <button type="button" className="button subtle" data-meta-confirm-action={connection.disconnectStatus.action} disabled={actionBlocked || dirty} onClick={() => onAction(connection.disconnectStatus.action)}>Revisar y confirmar de nuevo</button>}</div>}
    {browser ? <section className={styles.panel} aria-label="Datos consultados"><h3>Datos consultados</h3><p>Esta vía no ofrece el histórico de publicaciones y campañas de la API. Conserva los recursos informados y la última verificación indicada abajo.</p></section> : <>
      <MetaConnectionData api={api} connection={connection} blocked={actionBlocked || dirty || !enabled || expired} onInteractionStateChange={analysisReport} onMutation={onMutation} onNavigate={onNavigate}/>
      <div tabIndex={metricsAvailable ? -1 : undefined} data-advisor-control={metricsAvailable ? 'meta-account-live-metrics-form' : undefined}>
        <MetaAdvertisingRead api={api} connection={connection} report={report} blocked={actionBlocked || dirty || !enabled || expired}/>
      </div>
    </>}
    <div className={styles.actions} aria-label="Acciones de Publicidad">
      {!browser && <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'advertising', tab: 'campaigns', source: 'meta', connection: connection.id })}>Ver campañas consultadas en Publicidad</button>}
      <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'advertising', tab: 'campaigns', record: 'new' })}>Preparar publicación o campaña</button>
      <button type="button" className="button subtle" onClick={() => onNavigate({ section: 'advertising', tab: 'campaigns' })}>Ver publicaciones del panel</button>
    </div>
    <h3>Recursos seleccionados</h3>
    <dl className="summary-values">
      <div><dt>Usuario verificado</dt><dd>{currentIds.userName || currentIds.userId || 'No verificado'}</dd></div>
      <div><dt>Negocio</dt><dd>{resourceName('businesses', currentIds.businessId, 'Sin negocio')}</dd></div>
      <div><dt>Página Facebook</dt><dd>{resourceName('pages', currentIds.pageId, 'Sin página')}</dd></div>
      <div><dt>Instagram profesional</dt><dd>{currentIds.instagramId ? instagram?.instagramName || currentIds.instagramId : 'Sin Instagram profesional'}</dd></div>
      <div><dt>Cuenta de anuncios</dt><dd>{resourceName('adAccounts', currentIds.adAccountId, 'No seleccionada')} · {connection.currency || 'Sin moneda'} · {connection.timeZone || 'Sin zona verificada'}</dd></div>
      <div><dt>Última verificación</dt><dd>{date(connection.validatedAt)}</dd></div>
    </dl>
    {currentIds.pageId && !currentIds.instagramId && <p>Instagram no está seleccionado. Puedes usar la página de Facebook sin Instagram; si necesitas Instagram, revisa que la cuenta sea profesional y esté vinculada en Meta.</p>}
    {currentIds.pageId && !currentIds.adAccountId && <p>No has seleccionado una cuenta publicitaria. No es necesaria para consultar el contenido orgánico de Facebook.</p>}
    {!availableResources && <p>No se descubrieron páginas ni cuentas publicitarias. Revisa los permisos y el acceso a los recursos con el mismo usuario en Meta; luego vuelve a autorizar o verifica la conexión.</p>}
    {connection.resourceNotice && <p className={styles.notice}>{connection.resourceNotice}</p>}
    <section><h3>Qué puedes hacer</h3><ul className={styles.choiceList}>{Object.entries(capabilities).filter(([key]) => key !== 'whatsappAds' || connection.capabilities?.whatsappAds || currentIds.whatsappId).map(([key, label]) => {
      const permitted = access && enabled && connection.capabilities?.[key] === true && (!tokenOnly || key === 'insights');
      return <li key={key}>{label}: <strong>{!permitted ? 'No acreditada / no disponible' : freshnessBlocked ? 'Último permiso comprobado; actualización pendiente' : key === 'insights' ? 'Consulta acreditada' : requirement.publishingEnabled ? 'Permiso comprobado' : 'Permiso comprobado · Publicación deshabilitada en el panel'}</strong></li>;
    })}</ul><p>La consulta acreditada no garantiza métricas de todas las redes. Leer el histórico local y preparar borradores no exige habilitar la publicación.</p></section>
    <h3>Administrar conexión</h3>
    <div className={styles.actions}>
      {valid && !connection.revalidationRequired && <button type="button" className="button subtle" data-advisor-control="meta-connection-validate-control" disabled={actionBlocked || dirty} onClick={() => act('validate')}>Verificar conexión</button>}
      {!reconnect && !(browser && ['login_required', 'challenge_required'].includes(connection.state)) && authorizer}
    </div>
    <details className={styles.detail} open={autoSelect.current || undefined} data-advisor-disclosure><summary>Seleccionar página y cuenta</summary><p>La página sirve para contenido orgánico de Facebook. Instagram debe ser profesional y estar vinculado a esa página. Para anuncios elige una cuenta publicitaria. Solo se admiten recursos descubiertos; las identidades de una conexión aprobada no se pueden cambiar.</p>
      <fieldset disabled={actionBlocked || pending || !enabled || !availableResources || connection.state !== 'connected'} className={styles.fieldGrid}><legend>Recursos profesionales</legend>
        <SelectField name={`business-${connection.id}`} label="Negocio" advisorControl="meta-connection-resource-picker" value={selection.businessId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.businesses || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('businessId', value)}/>
        <SelectField name={`page-${connection.id}`} label="Página Facebook" value={selection.pageId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.pages || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.id}` }))]} onChange={value => choose('pageId', value)}/>
        <SelectField name={`instagram-${connection.id}`} label="Instagram profesional vinculado" value={selection.instagramId} options={[{ value: '', label: 'Sin seleccionar' }, ...(page?.instagramId ? [{ value: page.instagramId, label: page.instagramName || page.instagramId }] : [])]} onChange={value => choose('instagramId', value)}/>
        <SelectField name={`account-${connection.id}`} label="Cuenta de anuncios" value={selection.adAccountId} options={[{ value: '', label: 'Sin seleccionar' }, ...(resources.adAccounts || []).map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.currency || 'Sin moneda'} · ${item.timeZone || 'Sin zona'}` }))]} onChange={value => choose('adAccountId', value)}/>
      </fieldset><button type="button" className="button primary" disabled={actionBlocked || pending || !enabled || !dirty || connection.state !== 'connected'} onClick={() => act('select-assets')}>Confirmar y revalidar recursos</button>
    </details>
    <details className={styles.technicalDetails} data-advisor-disclosure><summary>Detalles técnicos</summary><p tabIndex={-1} data-advisor-control="meta-connection-permissions-detail">ID de conexión: {connection.id} · Versión {connection.version}</p><p>Permisos concedidos: {connection.permissions?.join(', ') || 'No informados por esta vía'}</p><p>Caducidad informada: {connection.expiresAt ? date(connection.expiresAt) : 'No informada; no significa sesión perpetua'}</p><p>Adaptador: {connection.adapterVersion || 'Versión no informada'} · Formato: {connection.locale || 'No informado'}</p>{!browser && <MetaEvaluation evaluation={connection.evaluation}/>}</details>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <details className={styles.technicalDetails}><summary>Desconectar o eliminar datos locales</summary><div className={styles.actions}><button type="button" className="button subtle" data-advisor-control="meta-disconnect-review" disabled={actionBlocked || dirty || disconnected || pending} onClick={() => onAction('disconnect')}>Desconectar cuenta</button><button type="button" className="button danger" data-advisor-control="meta-delete-review" disabled={actionBlocked || dirty || pending} onClick={() => onAction('delete-platform-data')}>Eliminar datos locales…</button></div></details>
  </article>;
}

function ConnectionDialog({ api, connection, action, onClose, onComplete, report }) {
  const deleting = action === 'delete-platform-data', ref = useRef(null), errorRef = useRef(null), requests = useRef(new Set()), locked = useRef(false), rid = useRequestIds();
  const assistant = useAssistantBridge(), reviewKind = deleting ? 'delete' : 'disconnect';
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
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog}`} aria-labelledby="social-connection-action-title" data-meta-connection-id={connection.id} data-meta-action={action}><form method="post" onSubmit={submit} ><header className={styles.dialogHeader}><h2 id="social-connection-action-title">{deleting ? 'Eliminar datos locales de plataforma' : 'Desconectar cuenta'} · {connection.name || methods[connection.integrationMethod]}</h2></header><div className={styles.dialogBody}>
    <p>Se cancelará el trabajo no enviado y se retirará la autenticación. No se borran publicaciones en Meta. Ante un envío incierto, hay que comprobar el estado en Meta sin reenviar.</p>
    {deleting && <><p>Se eliminarán publicaciones y anuncios, versiones aprobadas, capturas de resultados, estimaciones, ideas de mejora y sus vínculos. Los pedidos, gastos, pagos e imágenes y videos subidos permanecen. Esto no despublica ni garantiza detener anuncios remotos.</p>{preview ? <dl className="summary-values" tabIndex={-1} data-advisor-control="meta-delete-data-counts">{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{DELETION_COUNT_LABELS[key] || key}</dt><dd>{value}</dd></div>)}</dl> : <p role="status">Consultando cantidades actuales…</p>}<label className={styles.checkRow}><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={busy || !preview}/>Confirmo eliminar definitivamente estas cantidades de datos locales.</label></>}
    <label className={styles.checkRow}><input type="checkbox" checked={pause} onChange={event => setPause(event.target.checked)} disabled={busy} data-dialog-initial-focus data-advisor-control={`meta-${reviewKind}-with-pause-confirmation`}/>Pausar anuncios y comprobar su estado antes de desconectar{deleting ? ' y eliminar' : ''}.</label>
    <p className={styles.muted}>Por navegador, esta acción puede quedar pendiente del consumidor. Se conserva la custodia hasta confirmar las pausas. Si faltan permisos, detén los anuncios directamente en Meta.</p>
    {pause
      ? <p tabIndex={-1} data-advisor-control={`meta-${reviewKind}-local-confirmation`}>Si decides continuar sin una pausa verificada, desmarca la opción de pausar y revisa la advertencia antes de confirmar.</p>
      : <label className={styles.checkRow}><input type="checkbox" checked={warningAccepted} onChange={event => setWarningAccepted(event.target.checked)} disabled={busy} data-advisor-control={`meta-${reviewKind}-local-confirmation`}/>Acepto que pueden seguir gastando y que debo detenerlos directamente en Meta; la desconexión local no confirma una pausa.</label>}
    {error && <div ref={errorRef} tabIndex={-1} className={styles.error} role="alert"><p>{error}</p>{deleting && <button type="button" className="button subtle" disabled={busy} onClick={() => { setConfirm(false); setPreview(null); setRetry(value => value + 1); }}>Revisar cantidades otra vez</button>}</div>}
    </div><footer className={styles.actions}><button type="button" className="button subtle" disabled={busy} onClick={() => assistant.requestOpen()}>Ali: revisar este control</button><button type="button" className="button subtle" disabled={busy} onClick={close}>Cancelar</button><button type="submit" className={`button ${deleting ? 'danger' : 'primary'}`} disabled={busy || (deleting && (!preview || !confirm)) || (!pause && !warningAccepted)}>{busy ? 'Registrando solicitud…' : pause ? `Pausar y ${deleting ? 'eliminar datos' : 'desconectar'}` : deleting ? 'Eliminar sólo datos locales' : 'Desconectar sin afirmar pausa'}</button></footer></form></dialog>;
}

export default function SocialConnectionsSettings({ api, view, onViewChange, onNavigate, onInteractionStateChange, onMutation, revision = 0, socialCatalogRequest }) {
  const [refresh, setRefresh] = useState(0), [connectionRetry, setConnectionRetry] = useState(0), [settingsRetry, setSettingsRetry] = useState(0);
  const [notice, setNotice] = useState(''), [login, setLogin] = useState(null), [dialog, setDialog] = useState(null), [pauseRequests, setPauseRequests] = useState([]);
  const [acknowledged, setAcknowledged] = useState(null), [manualFirst, setManualFirst] = useState(false);
  const [locks, setLocks] = useState({});
  const heading = useRef(null), options = useRef(null), optionsSummary = useRef(null), interaction = useRef(new Map()), callbacks = useRef({}), mounted = useRef(true);
  const pendingDelete = useRef(null), configureTarget = useRef(null);
  callbacks.current = { onInteractionStateChange, onMutation };
  const report = useCallback((owner, state) => {
    if (state.dirty || state.busy) interaction.current.set(owner, state);
    else interaction.current.delete(owner);
    setLocks(previous => {
      const next = state.busy ? 'busy' : state.dirty ? 'dirty' : '';
      if ((previous[owner] || '') === next) return previous;
      const values = { ...previous };
      if (next) values[owner] = next;
      else delete values[owner];
      return values;
    });
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
  const invalidate = useCallback(async () => {
    if (mounted.current) setRefresh(value => value + 1);
    try { await callbacks.current.onMutation?.(); } catch (cause) { if (mounted.current) setNotice('Operación guardada; actualización general pendiente. ' + cause.message); }
  }, []);
  const refreshKey = revision + ':' + refresh;
  const connectionRead = useRead(api, ROOT + '/connections', `${refreshKey}:${connectionRetry}`, 5000);
  const settingsRead = useRead(api, ROOT + '/settings', `${refreshKey}:${settingsRetry}`);
  const connections = connectionRead.data?.connections || [];
  const record = view.record;
  const serverConnection = connections.find(item => item.id === record);
  const connection = acknowledged && acknowledged.id === record && (!serverConnection || serverConnection.version < acknowledged.version) ? acknowledged : serverConnection;
  const adding = record === 'new' || (!record && connectionRead.data && !connections.length);
  const listing = !record && connectionRead.data && connections.length > 0;
  const missing = record && record !== 'new' && connectionRead.data && !connectionRead.error && !connection;
  const destination = connection?.id || (adding ? 'new' : listing ? 'list' : missing ? `missing:${record}` : '');
  const requirement = connection && (isToken(connection) ? connectionRead.data?.tokenRequirement : connectionRead.data?.requirements?.find(item => item.integrationMethod === connection.integrationMethod));
  const freshnessBlocked = Boolean(connectionRead.error || settingsRead.error);
  const settingsLocked = Boolean(locks.settings), modalOpen = Boolean(dialog || login);
  const otherThan = owner => Object.keys(locks).some(key => key !== owner);
  const change = value => onViewChange({ record: value, page: 1 });
  const changeRecord = useRef(change);
  changeRecord.current = change;
  const receipts = connectionRead.data?.deletionReceipts;
  useEffect(() => { if (destination) heading.current?.focus({ preventScroll: true }); }, [destination]);
  useEffect(() => {
    if (!acknowledged) return;
    const persisted = connections.find(item => item.id === acknowledged.id);
    if (persisted?.version >= acknowledged.version) setAcknowledged(null);
  }, [connectionRead.data, acknowledged, connections]);
  useEffect(() => {
    const status = connection?.disconnectStatus;
    if (status?.action === 'delete-platform-data' && status.receiptId) pendingDelete.current = { connectionId: connection.id, receiptId: status.receiptId };
    const pending = pendingDelete.current;
    const receipt = pending && pending.connectionId === record && receipts?.find(item => item.receiptId === pending.receiptId);
    if (receipt && changeRecord.current(null) !== false) {
      pendingDelete.current = null;
      setNotice(`Eliminación local completada. Recibo ${receipt.receiptId}.`);
    }
  }, [connection, receipts, record]);
  useEffect(() => {
    const action = socialCatalogRequest?.socialAction;
    if (!action || !connection || socialCatalogRequest.view.record !== connection.id || modalOpen || freshnessBlocked || Object.keys(locks).length) return;
    if (action === 'browser-login' && connection.integrationMethod === 'browser' && connectionRead.data?.browserRunner?.status === 'available') setLogin(connection);
    if (action === 'disconnect' || action === 'delete-platform-data') setDialog({ connection, action });
  }, [socialCatalogRequest, connection, modalOpen, freshnessBlocked, locks, connectionRead.data?.browserRunner?.status]);
  function focusConfiguration() {
    if (!options.current) return;
    const form = options.current.querySelector('form');
    const input = configureTarget.current && form?.elements.namedItem(configureTarget.current);
    (input || optionsSummary.current)?.focus();
    if (form) configureTarget.current = null;
  }
  useEffect(() => { if (settingsRead.data && configureTarget.current != null) focusConfiguration(); }, [settingsRead.data]);
  function configure(requirement) {
    configureTarget.current = [...(requirement?.invalid || []), ...(requirement?.missing || [])].find(key => fieldLabels[key]) || '';
    options.current.open = true;
    focusConfiguration();
  }
  function startNew(manual = false) {
    if (change('new') !== false) setManualFirst(manual);
  }
  function created(connection) {
    setAcknowledged(connection);
    if (change(connection.id) !== false && connection.integrationMethod === 'browser' && connectionRead.data?.browserRunner?.status === 'available') setLogin(connection);
  }
  function renderRows(items) {
    return <ul className={connectionStyles.rows}>{items.map(item => {
      const name = connectionName(item, connections);
      return <li key={item.id} className={styles.card}>
        <div><h3>{name}</h3><p>{methodLabel(item)}</p></div>
        <span className={styles.badge}>{connectionState(item)}</span>
        <button type="button" className="button subtle" aria-label={`Administrar ${name}`} onClick={() => change(item.id)}>Administrar</button>
      </li>;
    })}</ul>;
  }
  function connectionCompleted(result) {
    if (result.disconnectPending) {
      setPauseRequests(previous => [...previous.filter(item => item.connectionId !== dialog?.connection.id), { connectionId: dialog?.connection.id, name: dialog?.connection.name, receiptId: result.receiptId, operationIds: result.operationIds || [] }]);
      setNotice(result.warning || 'Pausas encoladas. La desconexión espera confirmación remota; aún no se confirma que el gasto se detuvo.');
    } else if (result.receiptId) setNotice(`Eliminación local completada. Recibo ${result.receiptId}. ${result.remoteSpendStopped ? 'Pausa remota confirmada.' : 'No se confirmó la detención del gasto en Meta.'}`);
    else setNotice(result.warning || 'Conexión actualizada. Las publicaciones remotas no se eliminan.');
    report('dialog', { dirty: false, busy: false }); setDialog(null);
    if (result.connection) setAcknowledged(result.connection);
    if (result.receiptId && !result.disconnectPending) change(null);
    void invalidate();
  }
  const disconnected = listing ? connections.filter(item => item.state === 'disconnected') : [];
  return <section className={`${styles.workspace} ${connectionStyles.socialConnections}`} aria-label="Configuración de redes sociales" tabIndex={-1} data-advisor-control="meta-settings-overview">
    <div className={styles.stack}>
      {!connection && <header className="workspace-heading"><div><p className={styles.eyebrow}>Facebook e Instagram</p><h2 ref={heading} tabIndex={-1}>{adding ? 'Alta guiada de Meta' : listing ? 'Tus conexiones' : missing ? 'No se encontró esta conexión' : 'Conexiones y publicación en Meta'}</h2><p>Guardar opciones o conectar no publica ni activa anuncios.</p></div></header>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <ReadStatus state={connectionRead} label="conexiones" onRetry={() => setConnectionRetry(value => value + 1)}/>
      {listing && <>
        <div className={styles.actions}><button type="button" className="button primary" onClick={() => startNew()}>Conectar otra cuenta</button></div>
        {renderRows(connections.filter(item => item.state !== 'disconnected'))}
        {!!disconnected.length && <details className={styles.detail}><summary>Desconectadas ({disconnected.length})</summary>{renderRows(disconnected)}</details>}
      </>}
      {(Boolean(record) || connection) && <div className={styles.actions}><button type="button" className="button subtle" onClick={() => change(null)}>Ver mis conexiones</button></div>}
      {adding && <fieldset className={styles.connectionFieldset} disabled={settingsLocked || freshnessBlocked || modalOpen}><legend className={connectionStyles.visuallyHidden}>Alta de una conexión</legend>
        <ConnectionsIntro api={api} data={connectionRead.data} report={report} onMutation={invalidate} onCreated={created} onConfigure={configure} manualFirst={manualFirst} blocked={settingsLocked || freshnessBlocked} />
      </fieldset>}
      {connection && <ConnectionCard key={connection.id} api={api} connection={connection} title={connectionName(connection, connections)} heading={heading} requirement={requirement} runner={connectionRead.data?.browserRunner} freshnessBlocked={freshnessBlocked}
        operationsBlocked={otherThan(`connection:${connection.id}`)} report={report} onMutation={result => { if (result?.id) setAcknowledged(result); return invalidate(); }}
        onLogin={() => setLogin(connection)} onAction={action => setDialog({ connection, action })} onNewToken={() => startNew(true)} onNavigate={onNavigate}/>}
      <details className={styles.detail} ref={options} data-advisor-disclosure>
        <summary ref={optionsSummary}>Opciones de Meta</summary>
        <ReadStatus state={settingsRead} label="opciones de Meta" onRetry={() => setSettingsRetry(value => value + 1)}/>
        {settingsRead.data && <SocialSettingsForm api={api} settings={settingsRead.data} report={report} onSaved={invalidate} disabled={otherThan('settings') || modalOpen}/>}
      </details>
      {connectionRead.data && <BrowserHealth data={connectionRead.data}/>}
      {settingsLocked && <p className={styles.help}>Guarda o descarta las opciones antes de administrar las cuentas.</p>}
      {pauseRequests.map(item => { const connection = connections.find(value => value.id === item.connectionId), receipt = connectionRead.data?.deletionReceipts?.find(value => value.receiptId === item.receiptId); return <article key={item.connectionId} className={styles.notice}><h3>Solicitud de pausa y desconexión · {item.name || 'Conexión'}</h3><p>{receipt ? 'Eliminación local completada tras pausa remota confirmada.' : connection?.state === 'disconnected' ? 'Desconexión completada. Consulta la evidencia de las entregas para el último estado confirmado.' : 'Pendiente: no se afirma que los anuncios hayan dejado de gastar.'}</p>{item.receiptId && <p>Recibo solicitado: {item.receiptId}</p>}<p>Operaciones: {item.operationIds.join(', ') || 'Sin identificadores disponibles'}</p></article>; })}
      {!!receipts?.length && <details className={styles.evidence} data-advisor-disclosure><summary>Recibos de eliminación local</summary><h3 tabIndex={-1} data-advisor-control="meta-disconnection-and-deletion-receipts">Evidencia de eliminación local</h3>{receipts.map(receipt => <article key={receipt.receiptId}><h3>{receipt.receiptId}</h3><p>{date(receipt.deletedAt)} · {receipt.remoteSpendStopped ? 'Pausa remota confirmada' : 'Detención del gasto no confirmada'} · No se borró contenido en Meta</p><dl className="summary-values">{Object.entries(receipt.counts || {}).map(([key, value]) => <div key={key}><dt>{DELETION_COUNT_LABELS[key] || key}</dt><dd>{value}</dd></div>)}</dl></article>)}</details>}
    </div>
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
  async function copyUrl(value) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('URL copiada.');
    } catch {
      setNotice('No se pudo usar el portapapeles. Selecciona el texto de la URL y cópialo manualmente.');
    }
  }
  return <form className={styles.panel} method="post" onSubmit={submit} aria-label="Opciones de Meta" aria-busy={busy}>
    <h3 tabIndex={-1} data-advisor-control="meta-app-options-form">Configurar la aplicación</h3>
    <p>Los cambios se aplican sin reiniciar. Cambiar app, secreto u origen exige volver a verificar las preparaciones pendientes. Para cambiar de app, desconecta antes las cuentas API.</p>
    <fieldset disabled={busy || disabled} className={styles.connectionFieldset}><legend>Configuración de la aplicación Meta</legend>
      <div className={styles.fieldGrid}>
        <label className="field">Origen público del panel<input name="publicBaseUrl" type="url" maxLength={2048} required value={form.publicBaseUrl} onChange={event => set('publicBaseUrl', event.target.value)} aria-describedby="social-origin-help"/><span id="social-origin-help" className={styles.help}>Copia el origen HTTPS de la barra de direcciones del panel autorizado, sin ruta. Solo se permite HTTP en loopback de desarrollo.</span></label>
        <label className="field">ID de app de Meta<input name="appId" maxLength={100} value={form.appId} onChange={event => set('appId', event.target.value)} autoComplete="off" aria-describedby="social-app-help"/><span id="social-app-help" className={styles.help}>Meta for Developers → tu aplicación → Configuración de la app → Básica → ID de la app.</span></label>
        <label className="field">ID de configuración de inicio de sesión<input name="loginConfigId" maxLength={100} value={form.loginConfigId} onChange={event => set('loginConfigId', event.target.value)} autoComplete="off" aria-describedby="social-login-config-help"/><span id="social-login-config-help" className={styles.help}>Facebook Login for Business → Configurations → configuración con Token de acceso de usuario. El token manual no usa este ID.</span></label>
        <label className="field">Secreto de app de Meta<input name="appSecret" type="password" maxLength={4096} value={form.appSecret} onChange={event => set('appSecret', event.target.value)} autoComplete="new-password" aria-describedby="social-secret-help"/><span id="social-secret-help" className={styles.help}>Meta for Developers → tu aplicación → Configuración de la app → Básica → Clave secreta de la app. {saved.hasAppSecret ? 'Hay un secreto guardado; deja el campo vacío para conservarlo.' : 'No hay secreto guardado.'} Cambiar la app requiere uno nuevo.</span></label>
      </div>
      <label className={styles.checkRow}><input name="publishingEnabled" type="checkbox" data-advisor-control="meta-publishing-enable-control" checked={form.publishingEnabled} onChange={event => set('publishingEnabled', event.target.checked)}/>Habilitar publicación y activación</label>
      <label className={styles.checkRow}><input name="browserEnabled" type="checkbox" data-advisor-control="meta-browser-enable-control" checked={form.browserEnabled} onChange={event => set('browserEnabled', event.target.checked)}/>Habilitar acceso asistido por navegador</label>
      <p className={styles.warning}>La publicación es opcional y global. No es necesaria para consultar. Deshabilitarla impide nuevos envíos, no confirma detener gasto remoto ni revierte operaciones ya autorizadas.</p>
      <p className={styles.help}>Las claves de custodia se administran en el servidor; no hay que copiarlas ni pegarlas aquí.</p>
      <dl className="summary-values">{[
        ['Callback de Meta guardado', saved.callbackUrl, 'URI de redirección de OAuth válida en Facebook Login for Business', 'Copiar URL de callback'],
        ['URL de eliminación de datos guardada', saved.dataDeletionUrl, 'URL de devolución de llamada para la eliminación de datos en la configuración básica de la app', 'Copiar URL de eliminación']
      ].map(([label, value, location, copy]) => <div key={label}>
        <dt>{label}</dt><dd><p>{location}.</p><p>{value || 'Guarda el origen para obtener la URL.'}</p>{value && <button type="button" className="button subtle" onClick={() => copyUrl(value)}>{copy}</button>}</dd>
      </div>)}</dl>
    </fieldset>
    {error && <div ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><p>{error}</p>{conflict && <p>Se conservan tus cambios. Carga la versión vigente y revísala; no se sobrescribe automáticamente.</p>}<button type="button" className="button subtle" disabled={busy || disabled} onClick={reload}>Cargar configuración vigente</button></div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div className={styles.actions}><span role="status">{busy ? 'Guardando o consultando opciones…' : dirty ? 'Cambios sin guardar' : `Versión guardada: ${saved.version}`}</span><button type="submit" className="button primary" disabled={busy || disabled || (!dirty && saved.version !== 0)}>Guardar opciones de Meta</button><button type="button" className="button subtle" disabled={busy || disabled || !dirty} onClick={reload}>Descartar cambios de opciones</button></div>
  </form>;
}
