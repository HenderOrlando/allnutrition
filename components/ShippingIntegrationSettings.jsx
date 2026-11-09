'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { bogotaDate } from '@/lib/business/dates.mjs';
import { formatMoneyMinor } from '@/lib/business/money.mjs';
import styles from './ShippingIntegrationSettings.module.css';

const ROOT = '/api/admin/shipping';
const noop = () => {};
const money = value => value == null ? 'Sin dato' : formatMoneyMinor(value);
const observed = value => value == null || value === '' ? 'Sin dato' : String(value);
const date = value => value ? new Date(value).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) + ' (Bogotá)' : 'Sin registro';
const timestamp = value => value ? new Date(value.seconds * 1000).toISOString().replace('.000Z', '.' + String(value.nanoseconds).padStart(9, '0') + 'Z') : 'Sin dato';
const ERROR_LABELS = {
  login_required: 'Inicia sesión personalmente en Heka desde Electron. No es una desconexión del dispositivo.',
  challenge_required: 'Heka requiere una verificación personal. Resuélvela en la ventana oficial de Electron.',
  contract_changed: 'El portal o sus datos no coinciden con el contrato Heka compatible.',
  incomplete: 'La lectura está incompleta. No se creó una captura importable.',
  limit_exceeded: 'La lectura superó los límites. Reduce el intervalo o consulta una guía.',
  timeout: 'La consulta venció sin completarse. Puedes solicitar otra lectura.',
  provider_error: 'Heka no pudo completar la consulta. No se interpreta como un resultado vacío.',
  account_mismatch: 'La cuenta de Heka no coincide con la identidad confirmada. No se importaron datos.',
  revoked: 'El acceso del dispositivo fue revocado. La consulta no puede continuar.',
};
const STATE_LABELS = { awaiting_pairing: 'Pendiente de emparejamiento', awaiting_identity: 'Pendiente de iniciar sesión en Heka', confirmation_required: 'Confirma la cuenta y la fuente', connected: 'Identidad confirmada', login_required: 'Necesita iniciar sesión en Heka', revoked: 'Acceso revocado' };
const QUERY_LABELS = { queued: 'En cola; esperando Electron', running: 'Leyendo Heka; sin cambios en el negocio', completed: 'Lectura completada', succeeded: 'Lectura completada', failed: 'La lectura falló', cancelled: 'Consulta cancelada' };
const isActive = query => ['queued', 'running'].includes(query?.state);

function useRead(api, path, refresh, interval = 0) {
  const [state, setState] = useState({ data: null, error: '', loading: false, path: null });
  useEffect(() => {
    if (!path) return;
    let active = true, timer;
    const controller = new AbortController();
    async function load() {
      if (!active) return;
      if (interval && document.hidden) { timer = setTimeout(load, interval); return; }
      setState(previous => ({ ...previous, loading: true }));
      try {
        const data = await api(path, { signal: controller.signal });
        if (active) setState({ data, error: '', loading: false, path });
      } catch (cause) {
        if (active && cause.name !== 'AbortError') setState(previous => ({ ...previous, error: cause.message, loading: false }));
      }
      if (active && interval) timer = setTimeout(load, interval);
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [api, path, refresh, interval]);
  return { ...state, data: state.path === path ? state.data : null };
}

function ReadStatus({ state, label, onRetry }) {
  const ref = useRef(null);
  useEffect(() => { if (state.error) ref.current?.focus(); }, [state.error]);
  return <>{state.loading && !state.data && <p role="status">Cargando {label}…</p>}{state.error && <div role="alert" tabIndex={-1} ref={ref} className="error"><p>{state.error}</p>{state.data && <p>Se conservan datos anteriores; no confirman el estado actual.</p>}<button type="button" className="button subtle" onClick={onRetry}>Reintentar lectura de {label}</button></div>}</>;
}

function useRequestIds() {
  const ids = useRef(new Map());
  const requestId = (action, payload) => {
    const key = action + ':' + JSON.stringify(payload);
    if (!ids.current.has(key)) ids.current.set(key, crypto.randomUUID());
    return ids.current.get(key);
  };
  requestId.clear = (action, payload) => ids.current.delete(action + ':' + JSON.stringify(payload));
  return requestId;
}

function useOperation(api) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), mounted = useRef(true), requests = useRef(new Set());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const controller of requests.current) controller.abort(); };
  }, []);
  const execute = async work => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    const controller = new AbortController(); requests.current.add(controller);
    const request = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload), signal: controller.signal });
    try { await work(request, () => mounted.current); }
    catch (cause) { if (mounted.current && cause.name !== 'AbortError') setError(cause.message); }
    finally { requests.current.delete(controller); locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { busy, error, execute, setError };
}

function OperationError({ error }) {
  const ref = useRef(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  return error ? <p ref={ref} role="alert" tabIndex={-1} className="error">{error}</p> : null;
}

function CreateConnection({ api, sources, platforms, connections, report, onSaved, onViewChange, onNavigate }) {
  const [sourceId, setSourceId] = useState('');
  const operation = useOperation(api), rid = useRequestIds();
  useEffect(() => { report('create', { busy: operation.busy, dirty: Boolean(sourceId) }); }, [report, operation.busy, sourceId]);
  useEffect(() => () => report('create', { busy: false, dirty: false }), [report]);
  const available = sources.filter(source => source.active && platforms.some(platform => platform.id === source.platformId && platform.active) && !connections.some(connection => connection.sourceId === source.id));
  async function submit(event) {
    event.preventDefault();
    await operation.execute(async (post, active) => {
      const payload = { sourceId };
      const connection = await post(ROOT + '/connections', { ...payload, requestId: rid('create', payload) });
      if (!active()) return;
      setSourceId(''); report('create', { dirty: false, busy: false });
      onViewChange?.({ record: connection.id, page: 1 }); await onSaved();
    });
  }
  return <section className="settings-card"><h3>Conectar una fuente comercial con Heka</h3><p>La cuenta se fija a una fuente existente. No se asocia por teléfono, nombre ni referencia de pedido. Otra cuenta Heka necesita otra fuente.</p><form aria-label="Conectar fuente con Heka" onSubmit={submit}>
    <label className="field">Fuente comercial<select value={sourceId} disabled={operation.busy} required onChange={event => setSourceId(event.target.value)}><option value="">Elige una fuente activa</option>{available.map(source => <option key={source.id} value={source.id}>{platforms.find(platform => platform.id === source.platformId)?.name} · {source.name}</option>)}</select></label>
    {!available.length && <p>No hay fuentes activas sin conexión. Las conexiones revocadas se vuelven a emparejar sin cambiar su identidad.</p>}
    <div className="admin-actions"><button type="submit" className="button primary" disabled={operation.busy || !sourceId}>Conectar fuente con Heka</button><button type="button" className="button subtle" disabled={operation.busy || Boolean(sourceId)} onClick={() => onNavigate?.({ section: 'business', tab: 'platforms' })}>Administrar fuentes comerciales</button>{sourceId && <button type="button" className="text-button" disabled={operation.busy} onClick={() => setSourceId('')}>Descartar selección de fuente</button>}</div>
  </form><OperationError error={operation.error}/></section>;
}

function QueryProgress({ query }) {
  if (!query) return <p>Aún no se ha solicitado una lectura.</p>;
  return <section aria-label="Progreso de consulta"><h4>Última consulta</h4><p role="status">{QUERY_LABELS[query.state] || query.state} · Consulta <code>{query.queryId}</code></p>{query.query && <p>{query.query.from} a {query.query.to} (calendario Bogotá){query.query.tracking ? ` · Guía ${query.query.tracking}` : ' · Todas las guías del rango'}</p>}<p>Solicitada: {date(query.createdAt)} · Inicio: {date(query.startedAt)} · Fin: {date(query.finishedAt)}</p>{query.errorCode && <p role="alert" className="error">{ERROR_LABELS[query.errorCode] || 'No se pudo completar la lectura. No hay un resultado vacío confirmado.'}</p>}</section>;
}

function PaidLines({ lines, caption }) {
  return <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0}><table className={styles.table}><caption>{caption}</caption><thead><tr>{['ID original de línea', 'Colección', 'Transportadora', 'Guía', 'Referencia', 'Fecha publicada', 'Fecha de pago observada (sin hora)', 'Momento de línea', 'Recaudo bruto', 'Envío total', 'Comisión informada', 'Neto firmado'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{lines.map(line => <tr key={line.carrierCollection + ':' + line.documentId}><td><code className={styles.identifier}>{line.documentId}</code></td><td>{line.carrierCollection}</td><td>{observed(line.carrier)}</td><td><code className={styles.identifier}>{line.tracking}</code></td><td>{observed(line.reference)}</td><td>{observed(line.paidDate)}</td><td>{observed(line.paymentDateObserved)}</td><td>{observed(line.lineTimestamp)}</td><td>{money(line.grossMinor)}</td><td>{money(line.shippingMinor)}</td><td>{money(line.commissionMinor)}</td><td>{money(line.netMinor)}</td></tr>)}</tbody></table></div>;
}

function CaptureResults({ capture }) {
  const snapshot = capture.snapshot;
  return <section className="settings-subform" aria-label="Resultados de Heka"><h3>Última captura completa</h3><p>Capturada: {date(capture.capturedAt)} · Disponible hasta: {date(capture.expiresAt)}</p><p>Rango de guías y pagos: {snapshot.query.from} a {snapshot.query.to} (calendario America/Bogota){snapshot.query.tracking ? ` · Guía ${snapshot.query.tracking}` : ''}.</p><details><summary>Trazabilidad de la captura</summary><p>Captura <code>{capture.id}</code> · Consulta <code>{capture.queryId}</code></p><p>Hash de origen: <code>{capture.payloadHash}</code></p><p>Adaptador: {snapshot.adapterVersion} · Esquema: {snapshot.schemaVersion} · Fuente: servidor · Filas: {snapshot.rowCount}</p></details>
    {!snapshot.guides.length && !snapshot.packages.length && !snapshot.pending.lines.length && <p role="status">Lectura completa sin resultados. Heka respondió correctamente; no es un error ni una sesión vencida.</p>}
    <section aria-label="Guías observadas"><h4>Guías observadas ({snapshot.guides.length})</h4><p>Estados y fechas informativos: no implican entrega, venta ni recaudo. El corte de actualización no es una fecha de evento.</p>{!snapshot.guides.length ? <p>No hay guías en esta lectura.</p> : <div className={styles.scroll} role="region" aria-label="Detalle de guías" tabIndex={0}><table className={styles.table}><caption>Guías originales de la captura</caption><thead><tr>{['ID documento', 'ID Heka', 'Guía', 'Transportadora', 'Estado transportadora', 'Estado administrativo', 'Referencia', 'Corte observado', 'Fecha de creación publicada', 'Timeline de creación', 'Seguro informativo', 'Recaudo esperado', 'Envío informativo', 'Servicio'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{snapshot.guides.map(guide => <tr key={guide.documentId}><td><code className={styles.identifier}>{guide.documentId}</code></td><td><code className={styles.identifier}>{guide.externalShipmentId}</code></td><td><code className={styles.identifier}>{guide.tracking}</code></td><td>{observed(guide.carrier)}</td><td>{observed(guide.rawStatus)}</td><td>{observed(guide.rawShipmentStatus)}</td><td>{observed(guide.shipmentReference)}</td><td>{date(guide.reportAsOf)}</td><td>{observed(guide.creationDateRaw)}</td><td>{observed(guide.createdTimeline)}</td><td>{money(guide.insuredValueMinor)}</td><td>{money(guide.expectedCollectionMinor)}</td><td>{money(guide.shippingInformationalMinor)}</td><td>{observed(guide.serviceType)}</td></tr>)}</tbody></table></div>}</section>
    <section aria-label="Paquetes pagados"><h4>Paquetes pagados ({snapshot.packages.length})</h4><p>Declaraciones del proveedor, no recepción bancaria. Se conservan todas las líneas y ajustes, incluso fuera del filtro inicial. El neto ya descuenta envío total; no se resta otra vez la comisión informada.</p>{!snapshot.packages.length && <p>No hay paquetes pagados en esta lectura.</p>}{snapshot.packages.map(packet => <article className="settings-subform" key={packet.id} aria-label={'Paquete ' + packet.id}><h5>Paquete <code className={styles.identifier}>{packet.id}</code></h5><p>Fecha de liquidación declarada: {packet.settlementDate} (sin hora)</p><p>Marca temporal de cabecera (informativa; no prueba de pago): {timestamp(packet.headerTimestampObserved)}</p><dl className="summary-values"><div><dt>Bruto</dt><dd>{money(packet.grossMinor)}</dd></div><div><dt>Envío total</dt><dd>{money(packet.shippingMinor)}</dd></div><div><dt>Comisión informada</dt><dd>{money(packet.commissionMinor)}</dd></div><div><dt>Neto firmado</dt><dd>{money(packet.netMinor)}</dd></div></dl><p>Líneas completas: {packet.lines.length} · cantidad_pagos (informativo): {observed(packet.quantityInfo)} · Timeline de cabecera: {observed(packet.creationTimeline)}</p><details><summary>Guías declaradas por la cabecera (incluye repeticiones)</summary><ul>{packet.declaredTracking.map((tracking, index) => <li key={index}><code className={styles.identifier}>{tracking}</code></li>)}</ul></details><PaidLines lines={packet.lines} caption={'Líneas originales del paquete ' + packet.id}/></article>)}</section>
    <section aria-label="Pendientes de billetera"><h4>Pendientes de billetera ({snapshot.pending.lines.length})</h4><p>Corte de billetera independiente (UTC): <time dateTime={snapshot.pending.cutoff}>{snapshot.pending.cutoff}</time>. No es el rango de pagos de Bogotá. Los pendientes son informativos y no generan liquidaciones.</p>{snapshot.pending.lines.length ? <PaidLines lines={snapshot.pending.lines} caption="Líneas pendientes de billetera"/> : <p>No hay pendientes en esta lectura.</p>}</section>
  </section>;
}

function PrepareImport({ api, capture, report, onNavigate, onSaved }) {
  const [preparation, setPreparation] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const requestId = useRef(crypto.randomUUID()), callbacks = useRef({ onNavigate, onSaved }), working = useRef(false);
  callbacks.current = { onNavigate, onSaved };
  const started = Boolean(preparation);
  const busy = Boolean(preparation && !error && preparation.preparing !== false);
  useEffect(() => { report('prepare:' + capture.id, { busy, dirty: false }); }, [report, capture.id, busy]);
  useEffect(() => () => report('prepare:' + capture.id, { busy: false, dirty: false }), [report, capture.id]);
  useEffect(() => {
    if (!started || error) return;
    let active = true, timer;
    const controller = new AbortController();
    async function resume() {
      if (!active) return;
      if (document.hidden) { timer = setTimeout(resume, 2000); return; }
      working.current = true;
      try {
        const result = await api(ROOT + '/imports', { method: 'POST', signal: controller.signal, body: JSON.stringify({ requestId: requestId.current, snapshotId: capture.id, sourceId: capture.sourceId }) });
        if (!active) return;
        if (result.preparing) { setPreparation(result); timer = setTimeout(resume, 2000); }
        else {
          report('prepare:' + capture.id, { busy: false, dirty: false });
          setPreparation(result);
          try { await callbacks.current.onSaved(); } catch { /* The immutable batch is ready even if the surrounding view cannot refresh. */ }
          if (active) callbacks.current.onNavigate?.({ section: 'orders', tab: 'imports', batch: result.batchId, source: result.sourceId });
        }
      } catch (cause) { if (active && cause.name !== 'AbortError') setError(cause.message); }
      finally { working.current = false; }
    }
    void resume();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
    // The same immutable request is resumed, not restarted when progress changes.
  }, [api, capture.id, capture.sourceId, started, error, retry, report]);
  const importable = capture.snapshot.guides.length > 0 || capture.snapshot.packages.length > 0;
  return <section aria-label="Preparar revisión de importación"><h4>Revisar antes de importar</h4><p>Se prepara toda la captura en un único archivo inmutable con la fuente fijada. En revisión puedes excluir un paquete entero, nunca una parte de sus líneas. No se aceptan cambios ni se confirma dinero automáticamente.</p>{preparation && <p role="status">{error ? 'Preparación pausada; conserva el mismo lote al reintentar.' : 'Preparando archivo e inspección…'}{preparation.batchId ? ` Lote ${preparation.batchId} · ${preparation.state}.` : ''}</p>}<OperationError error={error}/><button type="button" className="button primary" disabled={busy || !importable} onClick={() => { if (working.current) return; setError(''); setPreparation(previous => previous || { state: 'preparing' }); setRetry(value => value + 1); }}>{error ? 'Reanudar preparación de importación' : capture.importBatchId ? 'Abrir revisión de importación' : 'Preparar importación completa'}</button>{!importable && <p>Esta captura no tiene guías ni paquetes pagados para importar.</p>}</section>;
}

function Connection({ api, connection, report, onSaved, onNavigate, refresh, origin, selected }) {
  const initialRange = useRef({ from: bogotaDate(), to: bogotaDate(), tracking: '' });
  const [range, setRange] = useState(initialRange.current), [baseline, setBaseline] = useState(JSON.stringify(initialRange.current)), [pair, setPair] = useState(null), [now, setNow] = useState(Date.now()), [accepted, setAccepted] = useState(''), [localQuery, setLocalQuery] = useState(null);
  const operation = useOperation(api), rid = useRequestIds(), heading = useRef(null), pairRef = useRef(null);
  const identityKey = connection.sourceId + ':' + connection.identityFingerprint;
  const dirty = JSON.stringify(range) !== baseline || Boolean(accepted) || Boolean(pair);
  const queryId = localQuery?.queryId || connection.latestQuery?.queryId;
  const queryRead = useRead(api, queryId ? ROOT + '/queries/' + encodeURIComponent(queryId) : null, refresh, 5000);
  const progress = queryRead.data || (connection.latestQuery?.queryId === queryId ? connection.latestQuery : null) || localQuery;
  const snapshotId = progress?.snapshotId || connection.latestSnapshotId;
  const snapshotRead = useRead(api, snapshotId ? ROOT + '/snapshots/' + encodeURIComponent(snapshotId) : null, refresh);
  const capture = snapshotRead.data && Date.parse(snapshotRead.data.expiresAt) > Date.now() ? snapshotRead.data : null;
  useEffect(() => {
    if (localQuery && connection.latestQuery?.queryId === localQuery.queryId) setLocalQuery(null);
  }, [localQuery, connection.latestQuery?.queryId]);
  useEffect(() => { if (selected) heading.current?.focus({ preventScroll: true }); }, [selected]);
  useEffect(() => { report(connection.id, { busy: operation.busy, dirty }); }, [report, connection.id, operation.busy, dirty]);
  useEffect(() => () => report(connection.id, { busy: false, dirty: false }), [report, connection.id]);
  useEffect(() => { if (pair) pairRef.current?.focus(); }, [pair]);
  useEffect(() => {
    if (!pair) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair]);
  useEffect(() => { if (pair && (Date.parse(pair.expiresAt) <= now || (connection.deviceId && connection.state !== 'awaiting_pairing' && connection.version > pair.version))) setPair(null); }, [pair, now, connection.deviceId, connection.state, connection.version]);
  useEffect(() => { setAccepted(''); }, [identityKey]);
  const path = ROOT + '/connections/' + encodeURIComponent(connection.id);
  async function action(name, payload = {}) {
    await operation.execute(async (post, active) => {
      const input = { version: connection.version, ...payload };
      // A pairing code is returned only once, so a new click always requests a new code.
      const result = await post(path + '/' + name, { ...input, requestId: name === 'pairing' ? crypto.randomUUID() : rid(name, input) });
      if (!active()) return;
      if (name === 'pairing') { setNow(Date.now()); setPair({ ...result, version: connection.version }); }
      if (name === 'identity') setAccepted('');
      if (name === 'revoke') { setPair(null); setAccepted(''); }
      await onSaved();
    });
  }
  async function submitQuery(event) {
    event.preventDefault();
    const from = Date.parse(range.from + 'T00:00:00Z'), to = Date.parse(range.to + 'T00:00:00Z');
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || (to - from) / 86400000 + 1 > 31) { operation.setError('Elige un intervalo válido de máximo 31 días calendario, con la fecha final igual o posterior a la inicial.'); return; }
    await operation.execute(async (post, active) => {
      const input = { version: connection.version, ...range };
      const result = await post(path + '/queries', { ...input, requestId: rid('query', input) });
      if (!active()) return;
      rid.clear('query', input);
      setLocalQuery({ ...result, query: { ...range } }); setBaseline(JSON.stringify(range)); await onSaved();
    });
  }
  const canQuery = connection.state === 'connected' && Boolean(connection.confirmedIdentity);
  return <article className="settings-card" data-shipping-connection={connection.id} aria-label={connection.platformName + ' · ' + connection.sourceName}>
    <h3 ref={heading} tabIndex={-1}>{connection.platformName} · {connection.sourceName}</h3><p>Heka · {STATE_LABELS[connection.state] || connection.state} · Versión {connection.version}</p><p>{connection.deviceStatus === 'connected' ? 'Electron conectado' : 'Electron desconectado'} · Último contacto: {date(connection.lastSeenAt)}</p>{connection.deviceId && <p>Dispositivo: <code>{connection.deviceId}</code></p>}{connection.deviceStatus !== 'connected' && <p>Más de 60 segundos sin contacto se muestra como desconectado; no implica credenciales Heka incorrectas. Mantén Electron abierto para consultar.</p>}{connection.state === 'login_required' && <p role="status">{ERROR_LABELS.login_required}</p>}
    {connection.confirmedIdentity && <section aria-label="Cuenta Heka confirmada"><h4>Cuenta Heka confirmada</h4><p>Usuario <code className={styles.identifier}>{connection.confirmedIdentity.userId}</code> · Centro de costo <code className={styles.identifier}>{connection.confirmedIdentity.centerCost}</code></p><p>Reemparejar conserva esta identidad y no reasigna datos históricos.</p></section>}
    <div className="admin-actions"><button type="button" className="button subtle" disabled={operation.busy || Boolean(pair)} onClick={() => action('pairing')}>{connection.deviceId || connection.state === 'revoked' ? 'Reemparejar Electron' : 'Generar código de emparejamiento'}</button>{connection.state !== 'revoked' && <button type="button" className="button danger" disabled={operation.busy} onClick={() => { if (window.confirm('¿Revocar el acceso de Electron a esta fuente? Se invalidarán los códigos y las consultas pendientes. Las capturas históricas y los lotes se conservan.')) void action('revoke'); }}>Revocar acceso de Electron</button>}</div>
    {pair && <section ref={pairRef} tabIndex={-1} aria-label="Código de emparejamiento" className="settings-subform"><h4>Código de un solo uso</h4><p>En Electron verifica el origen <strong>{origin}</strong> y esta fuente antes de vincular. El código dura cinco minutos y solo se muestra en esta pantalla; no se guarda en el navegador.</p><output aria-label="Código para Electron" data-testid="shipping-pairing-code" className={styles.secret}>{pair.code}</output><p>Vence: {date(pair.expiresAt)} · Restan {Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 1000))} segundos.</p><button type="button" className="button subtle" onClick={() => setPair(null)}>Ocultar código</button></section>}
    {connection.candidateIdentity && !connection.confirmedIdentity && <section aria-label="Confirmar identidad Heka" className="settings-subform"><h4>Confirma explícitamente fuente y cuenta</h4><p>Fuente: <strong>{connection.platformName} · {connection.sourceName}</strong></p><p>Cuenta candidata: usuario <code className={styles.identifier}>{connection.candidateIdentity.userId}</code> · Centro de costo <code className={styles.identifier}>{connection.candidateIdentity.centerCost}</code></p><p>Huella de identidad: <code>{connection.identityFingerprint}</code></p><label><input type="checkbox" checked={accepted === identityKey} disabled={operation.busy} onChange={event => setAccepted(event.target.checked ? identityKey : '')}/>Confirmo que esta cuenta Heka corresponde a esta fuente comercial.</label><div className="admin-actions"><button type="button" className="button primary" disabled={operation.busy || accepted !== identityKey} onClick={() => action('identity', { fingerprint: connection.identityFingerprint, sourceId: connection.sourceId })}>Confirmar fuente y cuenta Heka</button></div></section>}
    <form aria-label="Consultar Heka" onSubmit={submitQuery}><h4>Consultar guías y liquidaciones (solo lectura)</h4><fieldset disabled={operation.busy || !canQuery || isActive(progress)}><legend>Rango de guías y pagos: máximo 31 días, calendario Bogotá</legend><div className="product-form-grid"><label className="field">Desde<input type="date" required value={range.from} onChange={event => setRange(previous => ({ ...previous, from: event.target.value }))}/></label><label className="field">Hasta<input type="date" required min={range.from} value={range.to} onChange={event => setRange(previous => ({ ...previous, to: event.target.value }))}/></label><label className="field">Guía (opcional)<input value={range.tracking} maxLength={200} onChange={event => setRange(previous => ({ ...previous, tracking: event.target.value }))}/></label></div><button type="submit" className="button primary">Consultar Heka</button>{JSON.stringify(range) !== baseline && <button type="button" className="button subtle" onClick={() => setRange(JSON.parse(baseline))}>Descartar cambios de consulta</button>}</fieldset>{!canQuery && <p>Empareja Electron, inicia sesión personalmente y confirma la cuenta antes de consultar.</p>}</form>
    <OperationError error={operation.error}/>
    <ReadStatus state={queryRead} label="progreso" onRetry={onSaved}/>
    <QueryProgress query={progress}/>
    <ReadStatus state={snapshotRead} label="captura" onRetry={onSaved}/>
    {capture && <>
      {progress && capture.queryId !== progress.queryId && <p role="status">Estos resultados son de una captura anterior. La última consulta no los ha sustituido; consulta su progreso o error por separado.</p>}
      <CaptureResults capture={capture}/>
      <PrepareImport key={capture.id} api={api} capture={capture} report={report} onSaved={onSaved} onNavigate={onNavigate}/>
    </>}
  </article>;
}

export default function ShippingIntegrationSettings({ api, view, onViewChange, onNavigate, onInteractionStateChange = noop, onMutation = noop, revision = 0 }) {
  const [refresh, setRefresh] = useState(0), [origin, setOrigin] = useState(''), [notice, setNotice] = useState('');
  const heading = useRef(null), interaction = useRef(new Map()), callbacks = useRef({ onInteractionStateChange, onMutation }), mounted = useRef(true);
  callbacks.current = { onInteractionStateChange, onMutation };
  const report = useCallback((owner, state) => {
    interaction.current.set(owner, state);
    callbacks.current.onInteractionStateChange({ dirty: [...interaction.current.values()].some(item => item.dirty), busy: [...interaction.current.values()].some(item => item.busy) });
  }, []);
  useEffect(() => {
    mounted.current = true; setOrigin(window.location.origin); heading.current?.focus({ preventScroll: true });
    const beforeUnload = event => { if ([...interaction.current.values()].some(item => item.dirty || item.busy)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onInteractionStateChange({ dirty: false, busy: false }); };
  }, []);
  const saved = useCallback(async () => {
    if (mounted.current) setRefresh(value => value + 1);
    try { await callbacks.current.onMutation(); } catch (cause) { if (mounted.current) setNotice('Operación guardada; actualización general pendiente. ' + cause.message); }
  }, []);
  const refreshKey = revision + ':' + refresh;
  const connections = useRead(api, ROOT + '/connections', refreshKey, 5000);
  const sources = useRead(api, '/api/admin/business/sources', refreshKey);
  const platforms = useRead(api, '/api/admin/business/platforms', refreshKey);
  const retry = () => setRefresh(value => value + 1);
  return <section className="business-settings" aria-label="Proveedores de envíos"><header className="workspace-heading"><div><h2 ref={heading} tabIndex={-1}>Proveedores de envíos</h2><p>Heka clásico · Solo consulta. No crea ni anula guías, solicita pagos ni modifica bancos. Leer y preparar importación no cambia el negocio.</p><p>Origen real de este panel: <strong>{origin || 'Consultando origen…'}</strong></p>{origin && !origin.startsWith('https:') && <p className="error" role="alert">El bridge requiere un origen HTTPS del panel. Este origen no es HTTPS.</p>}</div></header>{notice && <p role="status">{notice}</p>}<ReadStatus state={connections} label="conexiones" onRetry={retry}/><ReadStatus state={sources} label="fuentes" onRetry={retry}/><ReadStatus state={platforms} label="plataformas" onRetry={retry}/>
    {connections.data && sources.data && platforms.data && <CreateConnection api={api} sources={sources.data.records} platforms={platforms.data.records} connections={connections.data.connections} report={report} onSaved={saved} onViewChange={onViewChange} onNavigate={onNavigate}/>}
    {connections.data && !connections.data.connections.length && <p>No hay conexiones Heka. Elige una fuente comercial para comenzar.</p>}
    {connections.data?.connections.map(connection => <Connection key={connection.id} api={api} connection={connection} report={report} onSaved={saved} onNavigate={onNavigate} refresh={refreshKey} origin={origin} selected={view.record === connection.id}/>)}
  </section>;
}
