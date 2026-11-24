'use client';

import { useEffect, useState } from 'react';
import { AdvisorActionCard } from './AdvisorDirectory.jsx';
import styles from './AssistantConsole.module.css';

const PAGE_SIZE = 5;

export default function AliIntentionPicker({ api, disabled, onPrepare, onOpen }) {
  const [search, setSearch] = useState({ query: '', page: 1 });
  const [answer, setAnswer] = useState(null);
  const { query, page } = search;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ query: query.trim(), page: String(page) });
      void api(`/api/admin/assistant/actions?${params}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setAnswer({ search, result }); })
        .catch(cause => { if (!controller.signal.aborted) setAnswer({ search, error: cause.message || 'No se pudieron cargar las intenciones.' }); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, search, query, page]);

  const current = answer?.search === search ? answer : null;
  return <section id="ali-intentions" className={styles.intentions} aria-labelledby="ali-intentions-heading">
    <h3 id="ali-intentions-heading">Intenciones disponibles</h3>
    <p>Prepara un texto editable. Nada se envía hasta que pulses «Enviar».</p>
    <label className={styles.visuallyHidden} htmlFor="ali-intention-search">Buscar intenciones</label>
    <input id="ali-intention-search" type="search" maxLength={200} placeholder="Buscar intenciones" className={styles.historySearch}
      value={query} onChange={event => setSearch({ query: event.target.value, page: 1 })}/>
    {!current && <p role="status">Buscando intenciones…</p>}
    {current?.error && <p role="alert">{current.error} <button type="button" onClick={() => setSearch({ query, page })}>Reintentar</button></p>}
    {current?.result?.items.length === 0 && <p>No se encontraron intenciones.</p>}
    {current?.result?.items.map(capability => <div className={styles.intentionRow} key={capability.id}>
      <AdvisorActionCard capability={capability} onOpen={onOpen} disabled={disabled}/>
      <button type="button" disabled={disabled} aria-label={`Preparar consulta: ${capability.label}`} onClick={() => onPrepare(capability)}>Preparar consulta</button>
    </div>)}
    {current?.result && <div className={styles.historyFilters}>
      {page > 1 && <button type="button" onClick={() => setSearch({ query, page: page - 1 })}>Página anterior</button>}
      {page * PAGE_SIZE < current.result.total && <button type="button" onClick={() => setSearch({ query, page: page + 1 })}>Página siguiente</button>}
    </div>}
  </section>;
}
