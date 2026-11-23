'use client';

import { useState } from 'react';
import styles from './HekaPanel.module.css';

export const CARRIERS = [
  ['servientrega', 'Servientrega'], ['interrapidisimo', 'Inter Rapidísimo'], ['heka', 'Heka'],
  ['coordinadora', 'Coordinadora'], ['tcc', 'TCC'], ['envia', 'Envía'],
];
export const PAYMENT_TYPES = [['1', 'Contraentrega'], ['2', 'Pago en destino'], ['3', 'Convencional']];
export const DESTINATION_TYPES = [['1', 'Dirección'], ['2', 'Oficina']];
export const NOVELTY_STATES = [['in_novelty', 'En novedad'], ['in_review', 'En revisión'], ['in_progress', 'En gestión'], ['resolved', 'Resuelta'], ['in_claim', 'En reclamación']];
export const HEKA_ID = '[0-9a-fA-F]{24}';
export const isHekaId = id => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id);
export const carrierLabel = value => CARRIERS.find(([id]) => id === value)?.[1] || value;
export const noveltyLabel = value => NOVELTY_STATES.find(([id]) => id === value)?.[1] || value;

export function HekaField({ name, label, value = '', onChange, options, type = 'text', required = false, number = false, ...attributes }) {
  return <label className={type === 'checkbox' ? 'checkbox-field' : 'field'}>
    {type !== 'checkbox' && label}
    {options ? <select name={name} value={value} required={required} onChange={event => onChange(name, event.target.value)} {...attributes}>
      <option value="">{required ? 'Selecciona una opción' : 'Sin especificar'}</option>
      {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
    </select> : type === 'textarea' ? <textarea name={name} value={value} required={required} onChange={event => onChange(name, event.target.value)} {...attributes}/>
      : type === 'checkbox' ? <input name={name} type="checkbox" checked={Boolean(value)} onChange={event => onChange(name, event.target.checked)} {...attributes}/>
        : <input name={name} type={number ? 'number' : type} value={value} required={required} onChange={event => onChange(name, event.target.value)} {...attributes}/>}
    {type === 'checkbox' && label}
  </label>;
}

export function HekaFields({ fields, values, onChange }) {
  return <div className="product-form-grid">{fields.map(field => <HekaField key={field.name} {...field} value={values[field.name]} onChange={onChange}/>)}</div>;
}

export function fieldPayload(fields, values) {
  const payload = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'checkbox') payload[field.name] = Boolean(value);
    else if (value != null && String(value).trim() !== '') {
      if (field.type === 'date') payload[field.name] = `${value}${field.name === 'end_date' ? 'T23:59:59.999' : 'T00:00:00.000'}-05:00`;
      else payload[field.name] = field.number ? Number(value) : String(value).replaceAll(/[\r\n\t]/g, ' ').trim();
    }
  }
  return payload;
}

export function HekaValues({ items }) {
  const shown = items.filter(([, value]) => value != null && value !== '');
  return shown.length ? <dl className={styles.values}>{shown.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'boolean' ? (value ? 'Sí' : 'No') : String(value)}</dd></div>)}</dl> : null;
}

export function HekaCards({ rows, children }) {
  return <ul className={styles.cards}>{rows.map((row, index) => <li className={`settings-subform ${styles.card}`} key={row._id ?? index}>{children(row, index)}</li>)}</ul>;
}

export function HekaSearch({ title, operation, fields, more = [], page = true, busy, perform, empty = 'Heka no devolvió resultados.', intro, children, advisorControl }) {
  const [values, setValues] = useState({}), [found, setFound] = useState(null), [submitted, setSubmitted] = useState(null), [validation, setValidation] = useState('');
  function query(input) {
    setFound(null); setSubmitted(input);
    perform(operation, input, result => setFound({ result }));
  }
  function submit(event) {
    event.preventDefault();
    const input = fieldPayload([...fields, ...more], values);
    if (input.start_date && input.end_date && values.start_date > values.end_date) {
      setValidation('La fecha inicial no puede ser posterior a la final.'); return;
    }
    if (operation === 'warehouses' && Boolean(input.start_date) !== Boolean(input.end_date)) {
      setValidation('Para filtrar bodegas por fecha, indica ambos extremos.'); return;
    }
    if (operation === 'clientHistory' && !input.document && !input.phone) {
      setValidation('Indica el teléfono o el documento del destinatario.'); return;
    }
    setValidation('');
    query({ ...input, ...(page ? { page: 1 } : {}) });
  }
  const update = (key, value) => { setValues(current => ({ ...current, [key]: value })); setValidation(''); };
  const rows = Array.isArray(found?.result) ? found.result : (found?.result?.rows ?? []), pager = found?.result?.pager;
  const advanced = more.map(field => ({ ...field, ...(field.name === 'end_date' ? { min: values.start_date || undefined } : {}) }));
  return <section className="settings-card" aria-label={title}>
    <h3 tabIndex={advisorControl ? -1 : undefined} data-advisor-control={advisorControl}>{title}</h3>
    {intro && <p>{intro}</p>}
    <form aria-label={title} onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <HekaFields fields={fields} values={values} onChange={update}/>
        {advanced.length > 0 && <details className={styles.details}><summary>Más filtros</summary><HekaFields fields={advanced} values={values} onChange={update}/></details>}
        {validation && <p className="error" role="alert">{validation}</p>}
        <button type="submit" className="button primary">{title}</button>
      </fieldset>
    </form>
    {found && <div className={styles.results} aria-live="polite">
      {!rows.length ? <p>{empty}</p> : children(rows, (pager?.total ?? rows.length) === 1 && rows.length === 1)}
      {pager && <nav className="admin-actions" aria-label={`Páginas: ${title}`}>
        <button type="button" className="button subtle" disabled={busy || !pager.previousPage} onClick={() => query({ ...submitted, page: pager.previousPage })}>Anterior</button>
        <span>Página {pager.page} de {Math.max(pager.pages, 1)} · {pager.total} resultados</span>
        <button type="button" className="button subtle" disabled={busy || !pager.nextPage} onClick={() => query({ ...submitted, page: pager.nextPage })}>Siguiente</button>
      </nav>}
    </div>}
  </section>;
}
