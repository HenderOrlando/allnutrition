'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { adminAreas } from '../lib/admin-view.mjs';
import { adminLocationLabel } from './admin-tasks.mjs';
import useDialog from './useDialog.js';
import styles from './AdvisorDirectory.module.css';

const PAGE_SIZE = 5;
const EMPTY_SEARCH = { query: '', area: '', page: 1 };
const areaLabels = new Map(adminAreas.map(({ id, label }) => [id, label]));
const modeLabels = { read: 'Consulta', prepare: 'Preparación', confirm: 'Requiere confirmación', human: 'Paso manual' };

export function AdvisorActionCard({ capability, onOpen, disabled }) {
  const destination = capability.destination ? adminLocationLabel(capability.destination.view) : areaLabels.get(capability.area);
  return <article className={styles.card} aria-label={capability.label} data-testid="advisor-action" data-capability-id={capability.id}>
    <strong>{capability.label}</strong>
    <small>{destination} · {modeLabels[capability.mode]}</small>
    <p><b>Antes de empezar:</b> {capability.prerequisite}</p>
    {onOpen && <button type="button" disabled={disabled} onClick={() => onOpen(capability)} aria-label={`Abrir en el panel: ${capability.label}`}>Abrir en el panel</button>}
    {capability.proof && <details><summary>Cómo comprobarlo</summary><p>{capability.proof}</p></details>}
  </article>;
}

export default function AdvisorDirectory({ api, onAdvisorAction, open = false, onClose }) {
  const id = useId();
  const dialog = useRef(null);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('');
  const [search, setSearch] = useState(EMPTY_SEARCH);
  const [outcome, setOutcome] = useState(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const current = outcome?.search === search ? outcome : null;
  const result = current?.result;
  const close = useDialog(dialog, { open, onClose, busy: opening });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(search.page) });
    if (search.query) params.set('query', search.query);
    if (search.area) params.set('area', search.area);
    api(`/api/admin/assistant/actions?${params}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setOutcome({ search, result: data });
    }).catch(() => {
      if (!controller.signal.aborted) setOutcome({ search, error: 'No se pudo cargar el directorio. Puedes volver a buscar.' });
    });
    return () => controller.abort();
  }, [api, search, open]);

  function submit(event) {
    event.preventDefault();
    setOpenError('');
    setSearch({ query: query.trim(), area, page: 1 });
  }

  function selectArea(event) {
    const nextArea = event.target.value;
    setArea(nextArea);
    setOpenError('');
    setSearch({ query: query.trim(), area: nextArea, page: 1 });
  }

  async function openCapability(capability) {
    setOpening(true);
    setOpenError('');
    try {
      if (!await onAdvisorAction(capability)) setOpenError('El control no se abrió. Puedes seguir buscando o revisar el prerrequisito.');
    }
    catch { setOpenError('No se pudo abrir el control. Tu búsqueda sigue disponible.'); }
    finally { setOpening(false); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-heading`}><section className={styles.directory} data-testid="advisor-directory">
    <header>
      <div><h2 id={`${id}-heading`}>¿Qué quieres hacer?</h2>
        <p>Busca por lo que quieres lograr o elige un área. Abrir una opción no ejecuta la acción.</p>
      </div>
      <button type="button" onClick={close} disabled={opening} aria-label="Cerrar directorio">Cerrar</button>
    </header>
    <form className={styles.filters} onSubmit={submit}>
      <label>Buscar una acción<input data-dialog-initial-focus type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Por ejemplo, cerrar caja" /></label>
      <label>Área<select value={area} onChange={selectArea}>
        <option value="">Todas las áreas</option>
        {adminAreas.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <button type="submit">Buscar</button>
    </form>
    {!current && <p role="status">Buscando acciones…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {openError && <p role="alert">{openError}</p>}
    {result && (result.items.length ? <>
      <p role="status">{result.total === 1 ? '1 coincidencia' : `${result.total} coincidencias`}</p>
      <ul className={styles.list}>{result.items.map(capability => <li key={capability.id}><AdvisorActionCard capability={capability} onOpen={openCapability} disabled={opening} /></li>)}</ul>
    </> : <p role="status">No encontré coincidencias. Prueba con otras palabras o selecciona un área.</p>)}
    {result && (result.total > PAGE_SIZE || result.page > 1) && <nav className={styles.pagination} aria-label="Páginas del directorio de Ali">
      <button type="button" disabled={result.page <= 1} onClick={() => setSearch({ ...search, page: result.page - 1 })}>Anterior</button>
      <span>Página {result.page} de {Math.max(1, Math.ceil(result.total / PAGE_SIZE))}</span>
      <button type="button" disabled={result.page * PAGE_SIZE >= result.total} onClick={() => setSearch({ ...search, page: result.page + 1 })}>Siguiente</button>
    </nav>}
  </section></dialog>;
}
