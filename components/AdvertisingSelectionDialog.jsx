'use client';

import { useEffect, useId, useRef, useState } from 'react';
import useDialog from './useDialog';
import styles from './AdvertisingSelectionDialog.module.css';

const fold = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');

export default function AdvertisingSelectionDialog({ triggerId, title, triggerLabel, value, onChange, options, emptySummary = 'Sin seleccionar', disabled = false, searchLabel, emptyResults = 'No hay opciones disponibles.', children }) {
  const id = useId();
  const trigger = useRef(null), dialog = useRef(null), list = useRef(null);
  const [draft, setDraft] = useState(null), [query, setQuery] = useState('');
  const open = draft !== null && !disabled;
  const close = useDialog(dialog, { open, onClose: () => setDraft(null) });
  useEffect(() => { if (disabled) setDraft(null); }, [disabled]);

  function start() {
    // Some browsers do not focus a button clicked with a pointer.
    trigger.current.focus({ preventScroll: true });
    setQuery('');
    setDraft(value);
  }
  function apply() {
    if (draft.length !== value.length || draft.some(item => !value.includes(item))) onChange(draft);
    close();
  }
  function changeQuery(event) {
    setQuery(event.target.value);
    list.current.scrollTop = 0;
  }
  function handleKeyDown(event) {
    // Search Enter must not submit the campaign form. Escape discards even in a search field.
    if (event.key === 'Enter' && event.target.localName !== 'button') event.preventDefault();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  const match = open && fold(query.trim());
  const visible = match ? options.filter(({ label }) => fold(label).includes(match)) : options;
  return <fieldset className={styles.field}>
    <legend>{title}</legend>
    {children}
    <p id={`${id}-summary`} className={styles.summary}>{value.length ? value.map(item => {
      const option = options.find(entry => entry.value === item);
      return option?.summaryLabel ?? option?.label ?? item;
    }).join(', ') : emptySummary}</p>
    <button ref={trigger} id={triggerId} type="button" className="button subtle" aria-haspopup="dialog" aria-controls={`${id}-dialog`} aria-describedby={`${id}-summary`} disabled={disabled} onClick={start}>{triggerLabel}</button>
    <dialog ref={dialog} id={`${id}-dialog`} className={styles.dialog} aria-labelledby={`${id}-title`} onKeyDown={handleKeyDown}>
      {open && <><header className={styles.header}>
        <h2 id={`${id}-title`} tabIndex={-1} data-dialog-initial-focus>{title}</h2>
        {searchLabel && <label className="field">{searchLabel}<input type="search" autoComplete="off" maxLength={64} value={query} onChange={changeQuery} aria-controls={`${id}-options`}/></label>}
      </header>
      <div className={styles.body} ref={list}>
        <ul id={`${id}-options`} className={styles.options} role="list">{visible.map(option => {
          const selected = draft.includes(option.value);
          return <li key={option.value}><label className={styles.option}>
            <input type="checkbox" checked={selected} disabled={option.disabled && !selected} onChange={event => {
              const checked = event.target.checked;
              setDraft(current => checked ? [...current, option.value] : current.filter(item => item !== option.value));
            }}/><span>{option.label}</span>
          </label></li>;
        })}</ul>
        {!visible.length && <p role="status" className={styles.empty}>{emptyResults}</p>}
      </div>
      <footer className={styles.footer}>
        <p role="status">Seleccionados: {draft.length}</p>
        <div className={styles.actions}>
          <button type="button" className="button subtle" onClick={close}>Cancelar</button>
          <button type="button" className="button primary" onClick={apply}>Aplicar</button>
        </div>
      </footer></>}
    </dialog>
  </fieldset>;
}
