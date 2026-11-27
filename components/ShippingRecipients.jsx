'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RECIPIENT_FIELDS, recipientValues } from '../lib/shipping/center-values.mjs';
import { useHekaInteraction } from './HekaPanel';
import useDialog from './useDialog';
import styles from './HekaPanel.module.css';

const ROOT = '/api/admin/shipping/recipients';
const SOURCES = { order: 'De un pedido', saved: 'Guardado en Envíos' };
const REQUIRED = new Set(['customerName', 'city', 'address', 'phone']);
const EMPTY_FILTERS = { page: 1, query: '', source: '' };
const EMPTY_RECIPIENT = Object.fromEntries(RECIPIENT_FIELDS.map(([key]) => [key, '']));
const EMPTY_INTERACTION = { dirty: false, busy: false };
const fieldValue = (recipient, key) => typeof recipient?.[key] === 'string' ? recipient[key].trim() : '';
const detailUrl = id => `${ROOT}/${encodeURIComponent(id)}`;

function recipientChanges(current, next) {
  if (!RECIPIENT_FIELDS.some(([key]) => fieldValue(current, key))) return [];
  return RECIPIENT_FIELDS.flatMap(([key, label]) => {
    const before = fieldValue(current, key), after = fieldValue(next, key);
    return before === after ? [] : [{ key, label, before, after }];
  });
}

function RecipientReview({ changes, onClose, onConfirm }) {
  const ref = useRef(null), title = useId();
  const close = useDialog(ref, { onClose });
  return <dialog ref={ref} className={`editor-drawer ${styles.confirmation}`} aria-labelledby={title}>
    <header><h2 id={title} tabIndex={-1} data-dialog-initial-focus>Revisar cambio de destinatario</h2></header>
    <div className="drawer-body">
      <p>La agenda no se modifica. Revisa los campos que cambiarán en el borrador de este envío:</p>
      <dl className={styles.values}>{changes.map(({ key, label, before, after }) => <div key={key}>
        <dt>{label}</dt><dd>Actual: {before || 'Sin dato'}</dd><dd>Nuevo: {after || 'Sin dato'}</dd>
      </div>)}</dl>
    </div>
    <footer className="editor-footer">
      <button type="button" className="button subtle" onClick={close}>Conservar el destinatario actual</button>
      <button type="button" className="button primary" onClick={onConfirm}>Aplicar al borrador</button>
    </footer>
  </dialog>;
}

function RecipientEditor({ api, record, onClose, onSaved, onInteractionStateChange }) {
  const ref = useRef(null), title = useId(), saving = useRef(false);
  const original = record?.recipient ?? EMPTY_RECIPIENT;
  const [draft, setDraft] = useState(original), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const dirty = RECIPIENT_FIELDS.some(([key]) => draft[key] !== original[key]);
  const close = useDialog(ref, { dirty, busy, onClose });
  useHekaInteraction(onInteractionStateChange, dirty, busy);

  const updateField = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    if (saving.current) return;
    setError(null);
    saving.current = true;
    setBusy(true);
    try {
      const recipient = recipientValues(draft, { complete: true });
      await api(record ? detailUrl(record.id) : ROOT, {
        method: record ? 'PUT' : 'POST',
        body: JSON.stringify({ recipient, ...(record ? { version: record.version } : {}) }),
      });
      onSaved();
    } catch (cause) { setError({ message: cause.message, conflict: cause.status === 409 }); }
    finally { saving.current = false; setBusy(false); }
  }

  return <dialog ref={ref} className={`editor-drawer ${styles.confirmation}`} aria-labelledby={title} aria-busy={busy}>
    <header><h2 id={title} tabIndex={-1} data-dialog-initial-focus>{record ? 'Editar destinatario guardado' : 'Nuevo destinatario'}</h2></header>
    <form onSubmit={submit} autoComplete="off">
      <div className="drawer-body">
        <p>Esta ficha se guarda en la agenda de Envíos. No modifica pedidos ni borradores.</p>
        <fieldset className="editor-fieldset" disabled={busy}>
          <div className="form-grid">{RECIPIENT_FIELDS.map(([key, label, max]) => <label className="field" key={key}>
            {label}{REQUIRED.has(key) ? ' (obligatorio)' : ''}
            {key === 'addressNotes'
              ? <textarea rows={2} maxLength={max} value={draft[key]} onChange={event => updateField(key, event.target.value)}/>
              : <input type={key === 'phone' ? 'tel' : key === 'email' ? 'email' : 'text'} required={REQUIRED.has(key)} maxLength={max} value={draft[key]} onChange={event => updateField(key, event.target.value)}/>}
          </label>)}</div>
        </fieldset>
        {error && <p className="error" role="alert">{error.message}{error.conflict && ' Tus cambios siguen en el formulario. Antes de intentar de nuevo, abre la ficha vigente desde la agenda.'}</p>}
      </div>
      <footer className="editor-footer">
        <span role="status">{busy ? 'Guardando ficha…' : dirty ? 'Cambios sin guardar' : ''}</span>
        <button type="button" className="button subtle" disabled={busy} onClick={close}>Cancelar</button>
        <button type="submit" className="button primary" disabled={busy || !dirty}>Guardar ficha</button>
      </footer>
    </form>
  </dialog>;
}

export default function ShippingRecipients({ api, onUse, currentRecipient, onInteractionStateChange }) {
  const root = useRef(null), listId = useId(), detailRequest = useRef(null), latest = useRef(null);
  latest.current = { currentRecipient, onUse };
  const [query, setQuery] = useState(''), [filters, setFilters] = useState(EMPTY_FILTERS);
  const [pageResult, setPageResult] = useState(null), [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null), [editing, setEditing] = useState(EMPTY_INTERACTION);
  const currentPage = pageResult?.filters === filters ? pageResult : null;
  const refreshing = currentPage?.revision !== revision;
  const data = currentPage?.data;
  const changes = dialog?.kind === 'review' ? recipientChanges(currentRecipient, dialog.recipient) : [];
  useHekaInteraction(onInteractionStateChange, editing.dirty, editing.busy);

  useEffect(() => {
    const controller = new AbortController();
    const body = JSON.stringify({ page: filters.page, ...(filters.query ? { query: filters.query } : {}), ...(filters.source ? { source: filters.source } : {}) });
    api(`${ROOT}/list`, { method: 'POST', body, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setPageResult({ filters, revision, data: result });
    }).catch(cause => {
      if (!controller.signal.aborted) setPageResult({ filters, revision, error: cause.message });
    });
    return () => controller.abort();
  }, [api, filters, revision]);
  useEffect(() => () => detailRequest.current?.abort(), []);

  function applyFilters(next) {
    if (detailRequest.current) return;
    setError('');
    setNotice('');
    setFilters(next);
  }

  async function openRecord(id, kind, trigger) {
    if (detailRequest.current || refreshing) return;
    const controller = new AbortController();
    detailRequest.current = controller;
    setError('');
    setNotice('');
    setPending(true);
    try {
      const record = await api(detailUrl(id), { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (kind === 'edit') {
        trigger.focus({ preventScroll: true });
        setDialog({ kind, record });
      } else if (recipientChanges(latest.current.currentRecipient, record.recipient).length) {
        trigger.focus({ preventScroll: true });
        setDialog({ kind: 'review', recipient: record.recipient });
      } else {
        latest.current.onUse?.(record.recipient);
        setNotice('Destinatario aplicado al borrador.');
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
    finally {
      if (!controller.signal.aborted) setPending(false);
      detailRequest.current = null;
    }
  }

  function saveComplete() {
    setDialog(null);
    setRevision(value => value + 1);
    setNotice('Ficha guardada en Envíos.');
  }

  function applyRecipient() {
    onUse?.(dialog.recipient);
    setDialog(null);
    setNotice('Destinatario aplicado al borrador.');
  }

  return <section ref={root} className={`settings-card ${styles.workspace}`} aria-labelledby={`${listId}-title`}>
    <h3 id={`${listId}-title`}>Agenda de destinatarios</h3>
    <p>Elige una dirección de un pedido o de las fichas guardadas en Envíos.</p>
    <div className="form-grid">
      <label className="field">Buscar destinatario
        <input type="search" autoComplete="off" maxLength={100} value={query} disabled={pending} placeholder="Nombre, municipio, dirección o teléfono" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            applyFilters({ ...filters, page: 1, query: query.trim() });
          }
        }}/>
      </label>
      <label className="field">Origen de la dirección
        <select value={filters.source} disabled={pending} onChange={event => applyFilters({ page: 1, query: query.trim(), source: event.target.value })}>
          <option value="">Todos los orígenes</option>
          {Object.entries(SOURCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
    <div className="admin-actions">
      <button type="button" className="button subtle" disabled={pending} onClick={() => applyFilters({ ...filters, page: 1, query: query.trim() })}>Buscar</button>
      {(query || filters.query || filters.source) && <button type="button" className="button ghost" disabled={pending} onClick={() => { setQuery(''); applyFilters(EMPTY_FILTERS); }}>Limpiar filtros</button>}
      <button type="button" className="button subtle" aria-disabled={pending} onClick={() => {
        if (!detailRequest.current) { setError(''); setNotice(''); setDialog({ kind: 'edit' }); }
      }}>Nuevo destinatario</button>
    </div>
    {(error || currentPage?.error) && <div className="error" role="alert">
      <p>{error || currentPage.error}</p>
      {currentPage?.error && <button type="button" className="button subtle" onClick={() => setRevision(value => value + 1)}>Reintentar carga</button>}
    </div>}
    <p role="status">{pending ? 'Leyendo los datos del destinatario…' : refreshing ? 'Cargando agenda…' : notice}</p>
    {data && <>
      {!data.records.length && <p role="status">{data.total ? 'No hay registros en esta página.' : filters.query || filters.source ? 'Ningún destinatario coincide con los filtros.' : 'Todavía no hay destinatarios en la agenda.'}</p>}
      {data.records.length > 0 && <ul className={styles.cards} aria-label="Destinatarios" aria-busy={refreshing}>
        {data.records.map((row, index) => <li key={row.id} className={`settings-card ${styles.card}`}>
          <div id={`${listId}-${index}`}>
            <h4>{row.name}</h4>
            <p>{[row.city, row.department].filter(Boolean).join(' · ') || 'Municipio no informado'}<br/>{[row.address, row.addressNotes].filter(Boolean).join(' · ') || 'Dirección no informada'}</p>
            <p>{row.phoneEnding ? `Teléfono termina en ${row.phoneEnding} · ` : ''}{SOURCES[row.source]}</p>
          </div>
          <div className="admin-actions">
            {onUse && <button type="button" className="button subtle" aria-disabled={pending || refreshing} aria-describedby={`${listId}-${index}`} onClick={event => openRecord(row.id, 'use', event.currentTarget)}>Usar para este envío</button>}
            {row.source === 'saved' && <button type="button" className="button ghost" aria-disabled={pending || refreshing} aria-describedby={`${listId}-${index}`} onClick={event => openRecord(row.id, 'edit', event.currentTarget)}>Editar ficha</button>}
          </div>
        </li>)}
      </ul>}
      {(filters.page > 1 || data.total > data.pageSize) && <nav className="cash-pagination" aria-label="Páginas de destinatarios">
        <button type="button" className="button subtle" disabled={filters.page === 1 || pending || refreshing} onClick={() => applyFilters({ ...filters, page: filters.page - 1 })}>Anterior</button>
        <span role="status">Página {filters.page} · {data.total} {data.total === 1 ? 'destinatario' : 'destinatarios'}</span>
        <button type="button" className="button subtle" disabled={filters.page * data.pageSize >= data.total || pending || refreshing} onClick={() => applyFilters({ ...filters, page: filters.page + 1 })}>Siguiente</button>
      </nav>}
    </>}
    {dialog && createPortal(dialog.kind === 'edit'
      ? <RecipientEditor api={api} record={dialog.record} onClose={() => setDialog(null)} onSaved={saveComplete} onInteractionStateChange={setEditing}/>
      : <RecipientReview changes={changes} onClose={() => setDialog(null)} onConfirm={applyRecipient}/>, root.current?.closest('.admin-theme') || document.body)}
  </section>;
}
