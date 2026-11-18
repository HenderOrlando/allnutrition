'use client';

import { useEffect, useRef, useState } from 'react';
import useDialog from './useDialog';
import styles from './HekaPanel.module.css';

export const HEKA_ROOT = '/api/admin/shipping/heka';
export const hekaEnvironment = value => value === 'production' ? 'Producción' : 'Pruebas';

export function useHekaRequest(api) {
  const current = useRef(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => () => { current.current?.abort(); current.current = null; }, []);
  async function run(work) {
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError('');
    try {
      await work((path, options) => api(path, { ...options, signal: controller.signal }), controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message);
    } finally {
      if (current.current === controller) {
        current.current = null;
        setBusy(false);
      }
    }
  }
  return { busy, error, setError, run };
}

export function hekaOperation(request, { environment, version }, operation, input, confirmation = {}) {
  return request(`${HEKA_ROOT}/operate`, {
    method: 'POST', body: JSON.stringify({ operation, input, environment, version, ...confirmation }),
    ...(operation === 'sticker' ? { responseType: 'blob' } : {}),
  });
}

export function useHekaInteraction(callback, dirty, busy) {
  const report = useRef(callback);
  report.current = callback;
  useEffect(() => { report.current?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => () => report.current?.({ dirty: false, busy: false }), []);
}

export function HekaAlert({ error }) {
  const ref = useRef(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  return error ? <p className="error" role="alert" ref={ref} tabIndex={-1}>{error}</p> : null;
}

export function HekaEnvironment({ environment }) {
  return <p className={`${styles.environment} ${environment === 'production' ? styles.production : ''}`}><strong>Entorno Heka: {hekaEnvironment(environment)}.</strong>{environment === 'production' ? ' Las acciones confirmadas operan en la cuenta real.' : ' Usa datos de prueba, no datos de clientes reales.'}</p>;
}

export function HekaConfirmation({ title, children, busy, error, onClose, onConfirm, action, acknowledgement, disabled = false, confirmationKey = 'intent' }) {
  const ref = useRef(null), [confirmedKey, setConfirmedKey] = useState(null);
  const confirmed = confirmedKey === confirmationKey;
  const close = useDialog(ref, { busy, onClose });
  return <dialog ref={ref} className={`editor-drawer ${styles.confirmation}`} aria-labelledby="heka-confirm-title" aria-busy={busy}>
    <header><h2 id="heka-confirm-title" tabIndex={-1} data-dialog-initial-focus>{title}</h2></header>
    <div className="drawer-body">
      {children}
      {acknowledgement && <label className="checkbox-field"><input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={event => setConfirmedKey(event.target.checked ? confirmationKey : null)}/>{acknowledgement}</label>}
      <HekaAlert error={error}/>
      {busy && <p role="status">Enviando solicitud…</p>}
    </div>
    <footer className="editor-footer"><button type="button" className="button subtle" disabled={busy} onClick={close}>Volver sin enviar</button><button type="button" className="button primary" disabled={busy || disabled || Boolean(acknowledgement && !confirmed)} onClick={onConfirm}>{action}</button></footer>
  </dialog>;
}
