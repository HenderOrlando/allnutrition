'use client';

import { useId } from 'react';
import styles from './WorkspaceTabs.module.css';

export default function WorkspaceTabs({ label, items, value, onChange, disabled = false }) {
  const selectId = useId();
  if (items.length < 2) return null;
  const hasSelection = items.some(item => item.id === value);

  return <nav className={styles.navigation} aria-label={label}>
    <div className={styles.buttons}>
      {items.map(item => <button type="button" className="button subtle" key={item.id}
        disabled={disabled} aria-current={item.id === value ? 'page' : undefined}
        onClick={() => onChange(item.id)}>{item.label}</button>)}
    </div>
    <div className={styles.mobile}>
      <label htmlFor={selectId}>{label}</label>
      <select id={selectId} value={hasSelection ? value : ''} disabled={disabled}
        onChange={event => onChange(event.target.value)}>
        {!hasSelection && <option value="" disabled>Selecciona una vista</option>}
        {items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </div>
  </nav>;
}
