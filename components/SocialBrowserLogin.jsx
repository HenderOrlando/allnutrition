'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import useDialog from './useDialog';
import styles from './AdvertisingWorkspace.module.css';

const navigationKeys = new Set(['Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);
export default function SocialBrowserLogin({ api, connection, onClose, onConnected, onInteractionStateChange }) {
  const dialog = useRef(null), canvas = useRef(null), control = useRef(null), mounted = useRef(true), commandQueue = useRef(Promise.resolve()), sequence = useRef(0);
  const reporter = useRef(onInteractionStateChange); reporter.current = onInteractionStateChange;
  const [session, setSession] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [inputEnabled, setInputEnabled] = useState(true);
  const endpoint = `/api/admin/social/connections/${encodeURIComponent(connection.id)}/browser/actions`;
  const action = useCallback((name, input = {}, options = {}) => api(endpoint, { method: 'POST', body: JSON.stringify({ action: name, ...input }), ...options }), [api, endpoint]);
  // The runner owns one exclusive page: frames, keys, and final verification must not overlap.
  const enqueue = useCallback(run => {
    const request = commandQueue.current.then(run);
    commandQueue.current = request.then(() => undefined, () => undefined);
    return request;
  }, []);
  const stop = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { if (control.current) await action('cancel-login', { controlId: control.current.controlId }); control.current = null; onClose(); }
    catch (cause) { setError(`No se pudo confirmar el cierre. El control vencerá si no se renueva. ${cause.message}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  useDialog(dialog, { busy, dirty: false, onClose: stop });
  useEffect(() => { reporter.current?.({ dirty: false, busy }); }, [busy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = control.current; control.current = null;
      if (active) void action('cancel-login', { controlId: active.controlId }).catch(() => {});
      const node = canvas.current; node?.getContext('2d')?.clearRect(0, 0, 1280, 800);
      reporter.current?.({ dirty: false, busy: false });
    };
  }, [action]);
  useEffect(() => {
    if (!session?.controlId) return;
    let stopped = false, timer; const abort = new AbortController();
    const frame = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const blob = await enqueue(() => stopped || !mounted.current || control.current?.controlId !== session.controlId ? null : action('read-frame', { controlId: session.controlId }, { responseType: 'blob', signal: abort.signal }));
          if (!blob || stopped) return;
          const image = await createImageBitmap(blob);
          try { if (!stopped) canvas.current?.getContext('2d')?.drawImage(image, 0, 0, 1280, 800); } finally { image.close(); }
        } catch (cause) { if (!stopped) { setError(cause.message); setInputEnabled(false); return; } }
      }
      if (!stopped) timer = setTimeout(frame, 1000);
    };
    void frame();
    return () => { stopped = true; clearTimeout(timer); abort.abort(); };
  }, [session?.controlId, action, enqueue]);
  async function start() {
    setBusy(true); setError('');
    try {
      const value = await action('start-login');
      control.current = value; sequence.current = 0; setSession(value); setInputEnabled(true);
      setNotice('Haz clic en el campo de Meta y escribe o pega directamente en el visor.');
      requestAnimationFrame(() => canvas.current?.focus());
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  function send(input) {
    const current = control.current;
    if (!current || !inputEnabled || busy) return;
    const next = ++sequence.current;
    void enqueue(async () => {
      if (!mounted.current || control.current?.controlId !== current.controlId) return;
      const result = await action('send-input', { controlId: current.controlId, sequence: next, input });
      if (mounted.current && ['authenticated', 'connected', 'completed'].includes(result.state)) { setInputEnabled(false); setNotice('Identidad detectada. Verifica y guarda la sesión; el visor no permite publicar ni invertir.'); }
    }).catch(cause => { if (mounted.current) { setError(cause.message); setInputEnabled(false); } });
  }
  function position(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1279, Math.max(0, Math.floor((event.clientX - bounds.left) * 1280 / bounds.width))), y: Math.min(799, Math.max(0, Math.floor((event.clientY - bounds.top) * 800 / bounds.height))) };
  }
  function keyboard(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.current?.querySelector('footer button')?.focus();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1) { event.preventDefault(); send({ kind: 'type', text: event.key }); }
    else if (navigationKeys.has(event.key)) { event.preventDefault(); send({ kind: 'key', key: event.key, shift: event.shiftKey }); }
  }
  async function finish() {
    setBusy(true); setError('');
    try {
      const result = await enqueue(() => action('finish-login', { controlId: control.current?.controlId }));
      if (['challenge_required', 'login_in_progress', 'login_required'].includes(result.state)) { setNotice('Completa el acceso o desafío de Meta en el visor y verifica otra vez.'); setInputEnabled(true); return; }
      if (result.state !== 'connected') throw new Error('Meta todavía no confirmó una identidad autenticada. Mantén el control y revisa el estado.');
      control.current = null; setSession(null); await onConnected?.(result); onClose();
    } catch (cause) { setError(cause.message); } finally { if (mounted.current) setBusy(false); }
  }
  return <dialog ref={dialog} className={`admin-dialog ${styles.browserDialog}`} aria-labelledby="social-browser-login-title">
    <header className="dialog-heading"><div><h2 id="social-browser-login-title">Conectar mediante navegador</h2><p>{connection.name || 'Facebook e Instagram'} · Sesión privada asistida</p></div><button type="button" className="button subtle" onClick={stop} disabled={busy}>Cerrar</button></header>
    <p>Meta puede pedir contraseña, 2FA o un desafío dentro del visor. No se guardan contraseñas, códigos ni imágenes de esta pantalla. Las cookies y el almacenamiento permitido se conservan cifrados; pueden vencer o ser revocados.</p>
    <p className="hint">Esta vía requiere permiso previo de Meta para automatización fuera de API. Nunca resuelve CAPTCHA o restricciones por evasión. Solo puedes manejar el acceso: publicar o invertir exige la confirmación separada del módulo.</p>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!session ? <button type="button" className="button primary" data-dialog-initial-focus onClick={start} disabled={busy}>{busy ? 'Abriendo acceso…' : 'Abrir acceso privado'}</button> : <>
      <p className="small muted">Control exclusivo hasta {new Date(session.expiresAt).toLocaleString('es-CO')}. Si cierras el visor, se detiene este control sin cerrar la sesión social ya guardada.</p>
      <div className={styles.browserViewport}><canvas ref={canvas} width={1280} height={800} tabIndex={0} role="application" aria-label="Visor privado de Meta: haz clic y escribe; Tab cambia de campo, Escape vuelve al diálogo" onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.focus(); send({ kind: 'click', ...position(event) }); }} onKeyDown={keyboard} onPaste={event => { event.preventDefault(); const value = event.clipboardData.getData('text'); if (value.length > 1000) { setError('Pega hasta 1000 caracteres por entrada.'); return; } send({ kind: 'type', text: value }); }} onWheel={event => send({ kind: 'scroll', deltaX: Math.round(Math.max(-1600, Math.min(1600, event.deltaX))), deltaY: Math.round(Math.max(-1600, Math.min(1600, event.deltaY))) })} onContextMenu={event => event.preventDefault()}/></div>
      <p className="small muted">Vista de 1280 × 800 reducida al espacio disponible. Tab cambia de campo en Meta; Escape devuelve el foco a los controles de este diálogo. El contenido remoto es una imagen, sin HTML de Meta ni cookies administrativas.</p>
      <footer className="dialog-actions"><button type="button" className="button primary" onClick={finish} disabled={busy}>{busy ? 'Verificando…' : 'Verificar y guardar sesión'}</button><button type="button" className="button subtle" onClick={stop} disabled={busy}>Cancelar acceso</button></footer>
    </>}
  </dialog>;
}
