'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './AdvertisingWorkspace.module.css';

const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('es-CO') : 'Desconocido';
const expiry = (value, status) => status === 'not_scheduled' || value === 0 || value === '0' ? 'Sin vencimiento programado informado por Meta (0); puede revocarse' : status === 'unknown' || !value ? 'Desconocido' : date(value);

export function MetaEvaluation({ evaluation }) {
  const limits = evaluation?.limits;
  return <section aria-label="Evaluación de acceso Meta"><h3>Evaluación de acceso</h3>
    <p>Comprobada: {date(evaluation?.checkedAt)} · Tipo de token: {evaluation?.tokenType || 'Desconocido'}</p>
    <p>Vencimiento: {expiry(evaluation?.expiresAt, evaluation?.expirationStatus)}</p><p>Vencimiento del acceso a datos: {expiry(evaluation?.dataAccessExpiresAt)}</p>
    <h4>Permisos informados</h4>{evaluation?.permissions?.length ? <ul>{evaluation.permissions.map((permission, index) => <li key={`${permission.name}-${index}`}>{permission.name}: {({ granted: 'Concedido', declined: 'Rechazado', expired: 'Vencido', unknown: 'Desconocido' })[permission.status] || permission.status || 'Desconocido'}</li>)}</ul> : <p>Permisos desconocidos; no se presuponen concedidos.</p>}
    <h4>Límites y uso reportado</h4><p>Estado: {limits?.status === 'reported' ? 'Reportado por Meta' : 'Desconocido; Meta no informó límites'} · Observado: {date(limits?.observedAt)}</p>
    {limits?.usage?.map((usage, index) => <div key={index}><p>Fuente: {usage.source || 'Desconocida'} · Ámbito: {usage.scope || 'Desconocido'}</p><ul>{[['callCount', 'Uso de llamadas'], ['totalCpuTime', 'Uso de CPU'], ['totalTime', 'Uso de tiempo total']].map(([key, label]) => <li key={key}>{label}: {typeof usage[key] === 'number' ? `${usage[key]} % reportado` : 'Desconocido'}</li>)}</ul><p>Pausa estimada para recuperar acceso: {usage.estimatedTimeToRegainAccess == null ? 'Desconocida' : `${usage.estimatedTimeToRegainAccess} minutos reportados por Meta`}</p></div>)}
    <p>Retry-After informado: {limits?.retryAfter == null ? 'Desconocido' : `${limits.retryAfter} segundos reportados por Meta`}</p><p className={styles.warning}>Estos valores observados no garantizan cuota restante ni disponibilidad futura.</p>
    {!!evaluation?.restrictions?.length && <><h4>Restricciones</h4><ul>{evaluation.restrictions.map((restriction, index) => <li key={index}>{restriction}</li>)}</ul></>}
  </section>;
}

export function ManualMetaConnection({ api, requirement, report, onMutation }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const token = useRef(null), request = useRef(null), locked = useRef(false), retry = useRef(null), errorRef = useRef(null);
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => { report('manual-token', { dirty: Boolean(name || hasToken), busy }); }, [name, hasToken, busy, report]);
  useEffect(() => () => { request.current?.abort(); if (token.current) token.current.value = ''; retry.current = null; report('manual-token', { dirty: false, busy: false }); }, [report]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function submit(event) {
    event.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); request.current = controller;
    if (!retry.current) retry.current = crypto.randomUUID();
    try {
      await api('/api/admin/social/connections', { method: 'POST', signal: controller.signal, body: JSON.stringify({ integrationMethod: 'api', authenticationMethod: 'token', name: name.trim(), accessToken: token.current.value.trim(), requestId: retry.current }) });
      token.current.value = ''; setHasToken(false); setName(''); retry.current = null; setNotice('Token guardado de forma cifrada. Selecciona y valida la cuenta para consultar publicidad.'); await onMutation();
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); }
    finally { if (token.current) token.current.value = ''; setHasToken(false); locked.current = false; setBusy(false); }
  }
  const available = requirement?.configured && requirement.enabled;
  return <article id="meta-manual-connection" className={styles.card}><h2>Token de acceso manual · Solo lectura</h2><p>Usa un token de acceso vigente emitido para la misma app de Meta; no uses el secreto de app ni un token de página. Para consultar publicidad, el token necesita ads_read o ads_management y acceso de lectura a la cuenta publicitaria.</p><p>Este método no permite publicar, activar, pausar ni modificar anuncios. El token se conserva cifrado en el servidor y puede revocarse.</p>
    {!requirement ? <p>Consultando requisitos del token…</p> : <><p>{available ? 'Token manual configurado y habilitado.' : 'Token manual no disponible: requiere configuración o habilitación.'}</p>{!!requirement.missing?.length && <p>Requisitos faltantes: {requirement.missing.join(', ')}</p>}{!!requirement.invalid?.length && <p>Requisitos inválidos: {requirement.invalid.join(', ')}</p>}<p>Requiere App ID, App Secret y clave de cifrado de tokens; no requiere Login Config ID.</p></>}
    <form method="post" onSubmit={submit}><fieldset disabled={busy}><label>Nombre de la conexión<input name="manualMetaName" required maxLength={200} value={name} onChange={event => { setName(event.target.value); retry.current = null; }}/></label><label>Token de acceso<input ref={token} name="manualMetaToken" type="password" required autoComplete="off" spellCheck={false} onChange={event => { setHasToken(Boolean(event.target.value)); retry.current = null; }}/></label><button type="submit" className="button primary" disabled={!available || !name.trim() || !hasToken}>{busy ? 'Guardando…' : 'Conectar token de solo lectura'}</button></fieldset></form>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
  </article>;
}

export function MetaAdvertisingRead({ api, connection, report, blocked }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today), [to, setTo] = useState(today), [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null), generation = useRef(0), locked = useRef(false), errorRef = useRef(null);
  const accountId = connection.identities?.adAccountId;
  const confirmed = connection.evaluation?.permissions?.some(item => ['ads_read', 'ads_management'].includes(item.name) && item.status === 'granted');
  const eligible = connection.state === 'connected' && !connection.revalidationRequired && !connection.disconnectStatus && Boolean(accountId) && confirmed && connection.capabilities?.insights === true;
  const identity = JSON.stringify([connection.id, accountId, connection.state, connection.revalidationRequired, connection.disconnectStatus, connection.readOnly, connection.capabilities?.insights, connection.evaluation?.permissions, blocked]);
  useEffect(() => { generation.current++; request.current?.abort(); locked.current = false; setBusy(false); setResult(null); setError(''); return () => { generation.current++; request.current?.abort(); }; }, [identity]);
  const owner = `advertising-read:${connection.id}`;
  useEffect(() => { report(owner, { dirty: Boolean(result && (from !== result.from || to !== result.to)), busy }); }, [report, owner, from, to, result, busy]);
  useEffect(() => () => report(owner, { dirty: false, busy: false }), [report, owner]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function query(event) {
    event.preventDefault(); if (locked.current || !eligible || blocked) return;
    locked.current = true; const current = ++generation.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(null); setError('');
    try {
      const data = await api(`/api/admin/social/connections/${encodeURIComponent(connection.id)}/advertising?${new URLSearchParams({ from, to })}`, { signal: controller.signal });
      if (generation.current === current) {
        if (data.accountId !== accountId || data.from !== from || data.to !== to) throw new Error('La respuesta no corresponde a la cuenta y período solicitados.');
        setResult({ ...data, identity });
      }
    } catch (cause) { if (generation.current === current && cause.name !== 'AbortError') setError(cause.message); }
    finally { if (generation.current === current) { locked.current = false; setBusy(false); } }
  }
  const visible = result?.identity === identity ? result : null;
  return <section aria-label="Consulta de publicidad"><h3>Publicidad y métricas · solo lectura</h3><p>Cuenta seleccionada: {accountId || 'Ninguna'}. Consulta explícita, sin actualización automática de Meta.</p>{!eligible && <p className={styles.warning}>Se necesita conexión activa, cuenta seleccionada y permiso ads_read o ads_management confirmado.</p>}{blocked && <p>Guarda los cambios de recursos antes de consultar.</p>}
    <form onSubmit={query}><fieldset disabled={busy || blocked || !eligible}><label>Desde<input type="date" required value={from} max={to} onChange={event => setFrom(event.target.value)}/></label><label>Hasta<input type="date" required min={from} value={to} onChange={event => setTo(event.target.value)}/></label><button type="submit" className="button subtle">Consultar publicidad</button></fieldset></form>
    {busy && <p role="status">Consultando publicidad…</p>}{error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>{error}</p>}
    {visible && <><p>Período aplicado: {visible.from} a {visible.to} · Cuenta: {visible.accountId} · Moneda: {visible.currency || 'Desconocida'} · Consultado: {date(visible.fetchedAt)}</p>{(from !== visible.from || to !== visible.to) && <p>El formulario cambió; las filas corresponden únicamente al período aplicado indicado.</p>}<p>Gasto en unidades mayores de la moneda informada por Meta, sin conversión. El alcance no se suma. «Sin dato» no equivale a cero.</p><div style={{ overflowX: 'auto' }}><table><thead><tr>{['Campaña', 'Impresiones', 'Clics', 'Alcance', 'Gasto'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{(visible.rows || []).map((row, index) => <tr key={`${row.campaignId}-${index}`}><th scope="row">{row.campaignName || row.campaignId || 'Sin nombre'}</th>{['impressions', 'clicks', 'reach', 'spend'].map(key => <td key={key}>{row[key] ?? 'Sin dato'}</td>)}</tr>)}</tbody></table></div>{!visible.rows?.length && <p>No hay campañas reportadas para este período.</p>}<MetaEvaluation evaluation={visible.evaluation}/></>}
  </section>;
}
