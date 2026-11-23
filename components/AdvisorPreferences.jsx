'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { adminAreas } from '../lib/admin-view.mjs';
import useDialog from './useDialog';
import styles from './AdvisorPreferences.module.css';

const PATH = '/api/admin/assistant/preferences';
const DEFAULT_VALUES = { focusArea: null, detail: 'guided', showAnnouncements: true };
const changed = (a, b) => a.focusArea !== b.focusArea || a.detail !== b.detail || a.showAnnouncements !== b.showAnnouncements;

export default function AdvisorPreferences({ open, ...props }) {
  return open ? <PreferencesDialog {...props} /> : null;
}

function PreferencesDialog({ onClose, api, onSaved, onInteractionStateChange }) {
  const titleId = useId(), descriptionId = useId(), announcementsId = useId();
  const dialog = useRef(null), mutation = useRef(null);
  const interaction = useRef(onInteractionStateChange);
  interaction.current = onInteractionStateChange;
  const [saved, setSaved] = useState(null), [draft, setDraft] = useState(null);
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  const dirty = Boolean(draft && changed(draft, saved));
  const close = useDialog(dialog, { dirty, busy, onClose });

  useEffect(() => {
    const controller = new AbortController();
    api(PATH, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      setSaved(data);
      setDraft(data);
    }).catch(() => {
      if (!controller.signal.aborted) setError('No pude cargar tus preferencias. Puedes intentar de nuevo.');
    });
    return () => controller.abort();
  }, [api, retry]);

  useEffect(() => { interaction.current?.({ dirty, busy }); }, [dirty, busy]);
  useEffect(() => () => {
    mutation.current?.abort();
    interaction.current?.({ dirty: false, busy: false });
  }, []);

  useEffect(() => {
    const node = dialog.current;
    if (!busy && (notice || error) && node && !node.contains(document.activeElement)) {
      node.querySelector('[data-preferences-feedback]')?.focus();
    }
  }, [busy, notice, error]);

  function edit(field, value) {
    setDraft(current => ({ ...current, [field]: value }));
    setNotice('');
    setError('');
  }

  async function save(values, restoring = false) {
    if (!saved || mutation.current || conflict) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setNotice('Guardando tus preferencias…');
    setError('');
    let next;
    try {
      next = await api(PATH, {
        method: 'PUT', signal: controller.signal, body: JSON.stringify({ ...values, version: saved.version }),
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setNotice('');
      if (cause.status === 409 && cause.current) {
        setConflict(cause.current);
        setError('Tus preferencias cambiaron. No apliqué tu borrador; revisa lo guardado antes de intentarlo de nuevo.');
      } else {
        setError(dirty ? 'No pude confirmar el guardado. Tus cambios siguen aquí.' : 'No pude confirmar el guardado.');
      }
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
    if (controller.signal.aborted || !next) return;
    setSaved(next);
    setDraft(next);
    setNotice(restoring ? 'Restableciste los valores iniciales de tus preferencias.' : 'Tus preferencias se guardaron para otras conversaciones.');
    onSaved?.(next);
  }

  function loadSaved() {
    setSaved(conflict);
    setDraft(conflict);
    setConflict(null);
    setError('');
    setNotice('Cargaste las preferencias guardadas. Ya puedes editarlas.');
  }

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header className={styles.header}>
        <h2 id={titleId} tabIndex={-1} data-dialog-initial-focus>Mis preferencias</h2>
        <button type="button" className="button subtle" onClick={close} disabled={busy}>Cerrar</button>
      </header>
      <div className={styles.body}>
        <p id={descriptionId}>Elige cómo quieres que Ali te acompañe en el panel y en otras conversaciones. Esto solo aplica a tu cuenta y no cambia tus permisos.</p>
        {error && <p className={styles.feedback} role="alert" tabIndex={-1} data-preferences-feedback>{error}</p>}
        {!draft && (error
          ? <div><button type="button" className="button subtle" onClick={() => { setError(''); setRetry(value => value + 1); }}>Volver a intentar</button></div>
          : <p role="status">Cargando tus preferencias…</p>)}
        {draft && (
          <form className={styles.form} aria-busy={busy} onSubmit={event => { event.preventDefault(); if (dirty) void save(draft); }}>
            <fieldset className={styles.fields} disabled={busy || Boolean(conflict)}>
              <label className={styles.select}>
                <span>Área de interés</span>
                <select value={draft.focusArea ?? ''} onChange={event => edit('focusArea', event.target.value || null)}>
                  <option value="">Sin área preferida</option>
                  {adminAreas.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <fieldset className={styles.detail}>
                <legend>Nivel de detalle</legend>
                <label><input type="radio" name="advisor-detail" value="brief" checked={draft.detail === 'brief'} onChange={() => edit('detail', 'brief')} /> Breve</label>
                <label><input type="radio" name="advisor-detail" value="guided" checked={draft.detail === 'guided'} onChange={() => edit('detail', 'guided')} /> Guiado</label>
              </fieldset>
              <div>
                <label><input type="checkbox" aria-describedby={announcementsId} checked={draft.showAnnouncements} onChange={event => edit('showAnnouncements', event.target.checked)} /> Mostrar avisos informativos de Ali</label>
                <p id={announcementsId} className={styles.hint}>No oculta las alertas del negocio ni los recordatorios que pediste.</p>
              </div>
            </fieldset>
            {!conflict && <div className={styles.actions}>
              <button type="submit" className="button" disabled={busy || !dirty}>Recordar para otras conversaciones</button>
              <button type="button" className="button subtle" onClick={() => void save(DEFAULT_VALUES, true)} disabled={busy || !dirty && !changed(saved, DEFAULT_VALUES)}>Restablecer y olvidar</button>
            </div>}
          </form>
        )}
        {conflict && <div className={styles.feedback}>
          <p><strong>Guardado en tu cuenta:</strong> {adminAreas.find(({ id }) => id === conflict.focusArea)?.label ?? 'Sin área preferida'} · {conflict.detail === 'brief' ? 'Breve' : 'Guiado'} · Avisos {conflict.showAnnouncements ? 'visibles' : 'ocultos'}</p>
          <p>Si cargas lo guardado, descartarás el borrador que ves en el formulario.</p>
          <button type="button" className="button subtle" onClick={loadSaved}>Cargar lo guardado</button>
        </div>}
        <div className={styles.status} role="status" tabIndex={-1} data-preferences-feedback>{notice}</div>
      </div>
    </dialog>
  );
}
