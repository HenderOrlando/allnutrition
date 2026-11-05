'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getImportColumnIssues, importFields, isImportFieldAllowed, normalizeImportFieldName } from '@/lib/schema.mjs';
import Icon from './Icons';
import useDialog from './useDialog';
import styles from './OrderExperience.module.css';

const definitions = new Map(importFields.map(field => [field.value, field]));
const categories = [...new Set(importFields.map(field => field.group))];
const types = { identifier: 'Identificador', text: 'Texto', money: 'Importe COP', date: 'Fecha', integer: 'Entero', enum: 'Opción', additional: 'Texto con nombre propio' };
const effects = { information: 'Informativo', commercial: 'Datos del pedido', logistics: 'Seguimiento', cost: 'Costo', collection: 'Recaudo', settlement: 'Liquidación', validation: 'Comprobación, no gasto' };
const scopeLabels = { order: 'Pedido', shipment: 'Envío', expense: 'Gasto' };
const filters = ['Todas', 'Sin asignar', 'Asignadas', 'Ignoradas', 'Con problemas'];
const insuranceHelp = 'Vacío: costo no informado. 0: sin cargo de seguro.';
const searchText = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();
const fieldSearch = new Map(importFields.map(field => [field.value, searchText(`${field.label} ${field.group} ${field.description} ${types[field.type]} ${effects[field.effect]}`)]));
const cellText = cell => cell == null ? '' : typeof cell === 'object' ? String(cell.text ?? cell.value ?? '') : String(cell);
function columnLetter(index) {
  let value = index + 1, letter = '';
  while (value > 0) { value--; letter = String.fromCharCode(65 + value % 26) + letter; value = Math.floor(value / 26); }
  return letter;
}
const assignmentState = mapping => !mapping?.destination ? 'Sin asignar' : mapping.destination === 'ignore' ? 'Ignoradas' : 'Asignadas';
const usesGroup = (field, layout) => field.scope === 'line' && layout === 'order_rows' || field.scope === 'expense_line' && layout === 'expense_columns';
const destinationKey = (field, group, layout) => `${usesGroup(field, layout) ? group : 0}:${field.value}`;

export default function ImportColumnMapping({ config, headers, sampleRows, columnCount, disabled, onChangeColumn, onDiscardImport, discardLabel }) {
  const rootRef = useRef(null), filterRef = useRef(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('Todas'), [selector, setSelector] = useState(null), [focusIssue, setFocusIssue] = useState(false);
  const searchId = useId(), filterId = useId(), issuesId = useId();
  const columns = config.columns || [], byIndex = new Map(), issuesByIndex = new Map(), usage = new Map();
  for (const column of columns) {
    if (!byIndex.has(column.index)) byIndex.set(column.index, column);
    const definition = definitions.get(column.destination);
    if (definition && definition.type !== 'additional') {
      const key = destinationKey(definition, column.group ?? 0, config.layout);
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key).push(column.index);
    }
  }
  const issues = getImportColumnIssues(columns, config.layout, config.purpose);
  for (const issue of issues) for (const index of issue.indexes) {
    if (!issuesByIndex.has(index)) issuesByIndex.set(index, []);
    issuesByIndex.get(index).push(issue);
  }
  const rows = (sampleRows || []).filter(row => row.rowNumber > Number(config.headerRow)).slice(0, 3);
  const counts = { 'Sin asignar': 0, Asignadas: 0, Ignoradas: 0 };
  const search = searchText(query);
  const columnData = Array.from({ length: columnCount || 0 }, (_, index) => {
    const mapping = byIndex.get(index), header = cellText(headers?.[index]), letter = columnLetter(index), definition = definitions.get(mapping?.destination), state = assignmentState(mapping);
    counts[state]++;
    return { index, header, letter, mapping, definition, state, issues: issuesByIndex.get(index) || [], samples: rows.map(row => ({ rowNumber: row.rowNumber, value: cellText(row.cells?.[index]) })), search: searchText(`${letter} ${index + 1} ${header} ${definition?.label || ''} ${mapping?.fieldName || ''}`) };
  });
  const visible = columnData.filter(column => (!search || column.search.includes(search)) && (filter === 'Todas' || filter === 'Con problemas' && column.issues.length || filter === column.state));
  useEffect(() => {
    if (!focusIssue) return;
    const trigger = rootRef.current?.querySelector('[data-import-column-problem] [data-import-destination]:not(:disabled)');
    (trigger || filterRef.current)?.focus();
    setFocusIssue(false);
  }, [focusIssue, filter, query]);
  function showIssues(event) {
    if (event.target !== event.currentTarget || !issues.length) return;
    setQuery(''); setFilter('Con problemas'); setFocusIssue(true);
  }
  function ignoreUnassigned() {
    if (disabled) return;
    for (const column of columnData) if (column.state === 'Sin asignar') onChangeColumn(column.index, column.header, { destination: 'ignore', group: 0, fieldName: undefined });
  }
  function openSelector(column, trigger) {
    if (!disabled) setSelector({ ...column, trigger });
  }
  return <section ref={rootRef} className={styles.importMapping} aria-label="Asignación de columnas">
    <h3 className={styles.subheading}>Asignación de columnas</h3>
    <p>Compara el origen con su destino. Las columnas sin asignar no se importarán; ignorarlas es una decisión explícita. Los encabezados repetidos se conservan por posición.</p>
    <div className={styles.importMappingSummary} aria-live="polite">
      <strong>{counts.Asignadas} asignadas</strong><span>{counts['Sin asignar']} sin asignar</span><span>{counts.Ignoradas} ignoradas</span>
    </div>
    <div data-import-column-issues tabIndex={-1} onFocus={showIssues} className={issues.length ? styles.importMappingProblems : styles.importMappingNotice}>
      {issues.length ? <><strong>{issues.length} {issues.length === 1 ? 'problema de asignación' : 'problemas de asignación'}</strong><p>Cambia el destino, el grupo o el nombre adicional, o ignora la columna. Los problemas aparecen en todas las columnas afectadas.</p><button type="button" className="button subtle" onClick={() => { setQuery(''); setFilter('Con problemas'); setFocusIssue(true); }}>Ir al primer problema</button></> : 'Sin problemas de asignación de destinos.'}
    </div>
    <div className={styles.importMappingToolbar}>
      <label className="field" htmlFor={searchId}>Buscar columnas<input ref={filterRef} id={searchId} type="search" value={query} placeholder="Encabezado, A, número o destino" onChange={event => setQuery(event.target.value)} /></label>
      <label className="field" htmlFor={filterId}>Mostrar columnas<select id={filterId} value={filter} onChange={event => setFilter(event.target.value)}>{filters.map(value => <option key={value}>{value}</option>)}</select></label>
      <button type="button" className="button subtle" disabled={disabled || !counts['Sin asignar']} onClick={ignoreUnassigned}>Ignorar columnas sin asignar</button>
    </div>
    <p className="small muted" role="status">{visible.length} de {columnData.length} columnas visibles.</p>
    <div className={styles.importMappingHead} aria-hidden="true"><span>Origen</span><span>Muestras del archivo</span><span>Destino y efecto</span></div>
    <div className={styles.importMappingRows}>{visible.map(column => {
      const { index, header, letter, mapping, definition, state } = column;
      const changedHeader = mapping?.header !== undefined && mapping.header !== normalizeImportFieldName(header);
      return <article key={index} data-import-column={index} data-import-column-problem={column.issues.length ? '' : undefined} className={styles.importMappingRow}>
        <div className={styles.importMappingSource}><h4>{letter} · Columna {index + 1}</h4><strong>{header || 'Sin encabezado'}</strong>
          {changedHeader && <div className={styles.importMappingNotice}><p>El perfil esperaba «{mapping.header || 'sin encabezado'}». La revisión buscará encabezados únicos; si falta o está repetido, pedirá corregirlo.</p><button type="button" className="button subtle" disabled={disabled} onClick={() => onChangeColumn(index, header, {})}>Confirmar asignación en esta posición</button></div>}
        </div>
        <div className={styles.importMappingSamples}><span className={styles.importMappingZoneLabel}>Muestras</span>{column.samples.length ? column.samples.map(sample => <div key={sample.rowNumber} className={styles.importMappingSample}><small>Fila {sample.rowNumber}</small>{sample.value.length > 180 ? <details><summary>{sample.value.slice(0, 180)}… · Ver valor completo</summary><p>{sample.value}</p></details> : <p>{sample.value || '(vacío)'}</p>}</div>) : <p className="small muted">Sin filas de muestra después de este encabezado.</p>}</div>
        <div className={styles.importMappingDestination}>
          <button type="button" className={`button subtle ${styles.importMappingTrigger}`} aria-label={`Destino de columna ${index + 1}`} data-import-destination aria-haspopup="dialog" aria-invalid={column.issues.length ? true : undefined} aria-describedby={column.issues.length ? `${issuesId}-${index}` : undefined} disabled={disabled} onClick={event => openSelector(column, event.currentTarget)}><span>{state === 'Sin asignar' ? 'Sin asignar — no se importará' : state === 'Ignoradas' ? 'Ignorada' : definition?.label || 'Destino no válido'}{definition?.type === 'additional' && <small>{scopeLabels[definition.scope]} · {mapping.fieldName || 'Falta nombre adicional'}</small>}</span><Icon name="chevron" /></button>
          {definition && <><p className={styles.importMappingMetadata}>{types[definition.type]} · {effects[definition.effect]}</p><p className="small muted">{definition.description}</p>{definition.value === 'insuranceCost' && <p className="small">{insuranceHelp}</p>}</>}
          {definition && usesGroup(definition, config.layout) && <label className="field">{definition.scope === 'expense_line' ? 'Grupo de campaña' : 'Grupo de producto'}<input type="number" min={1} max={50} value={(mapping.group ?? 0) + 1} disabled={disabled} onChange={event => { const group = Number(event.target.value) - 1; if (Number.isInteger(group) && group >= 0 && group < 50) onChangeColumn(index, header, { group }); }} /><small>{definition.scope === 'expense_line' ? 'Cantidad y costo unitario de una campaña usan el mismo grupo. El total de control no genera otro gasto.' : 'Referencia, cantidad, precio y costo del mismo producto usan el mismo grupo.'}</small></label>}
          {column.issues.length > 0 && <ul id={`${issuesId}-${index}`} className={styles.importMappingIssueList}>{column.issues.map((issue, issueIndex) => <li key={`${issue.code}:${issueIndex}`}>{issue.message}</li>)}</ul>}
        </div>
      </article>;
    })}</div>
    {!columnData.length ? <p className={styles.emptyPrompt}>No se recibieron columnas de muestra. Selecciona hoja y encabezado y lee sus muestras antes de asignar.</p> : !visible.length && <div className={styles.emptyPrompt}><p>No hay columnas con esta búsqueda y filtro. Prueba otro encabezado, letra o destino.</p><button type="button" className="button subtle" onClick={() => { setQuery(''); setFilter('Todas'); filterRef.current?.focus(); }}>Mostrar todas las columnas</button></div>}
    {['orders','tracking','settlements'].includes(config.purpose || 'orders') && <details className={styles.importMappingInsurance}><summary>Seguro: valor declarado, costo y fecha son datos distintos</summary><dl>{importFields.filter(field => field.group === 'Seguro').map(field => <div key={field.value}><dt>{field.label}</dt><dd>{field.description}</dd></div>)}</dl><p>{insuranceHelp}</p><p>El costo del seguro es opcional. Importarlo no paga desde caja; los pagos se registran por separado.</p></details>}
    {selector && createPortal(<DestinationDialog key={selector.index} column={selector} config={config} columns={columns} usage={usage} disabled={disabled} onChangeColumn={onChangeColumn} onClose={() => setSelector(null)} fallbackRef={filterRef} onDiscardImport={onDiscardImport} discardLabel={discardLabel} />, rootRef.current?.closest('.admin-theme') || document.body)}
  </section>;
}

function DestinationDialog({ column, config, columns, usage, disabled, onChangeColumn, onClose, fallbackRef, onDiscardImport, discardLabel }) {
  const ref = useRef(null), inputRef = useRef(null), resultsRef = useRef(null), nameRef = useRef(null);
  const titleId = useId(), searchId = useId(), categoryId = useId(), groupId = useId(), nameId = useId(), helpId = useId(), nameErrorId = useId();
  const additionalOptions = importFields.filter(field => field.type === 'additional' && isImportFieldAllowed(field.value, config.purpose || 'orders'));
  const defaultAdditional = config.purpose === 'expenses' ? 'expenseAdditionalField' : config.purpose === 'orders' ? 'orderAdditionalField' : 'additionalField';
  const [query, setQuery] = useState(''), [category, setCategory] = useState(''), [group, setGroup] = useState(column.definition && usesGroup(column.definition, config.layout) ? column.mapping?.group ?? 0 : 0), [additional, setAdditional] = useState(column.definition?.type === 'additional'), [additionalDestination, setAdditionalDestination] = useState(column.definition?.type === 'additional' ? column.definition.value : defaultAdditional), [fieldName, setFieldName] = useState(column.mapping?.fieldName ?? column.header);
  function dismiss(afterClose) {
    ref.current?.close();
    onClose();
    requestAnimationFrame(() => {
      const trigger = column.trigger;
      if (trigger?.isConnected && !trigger.matches(':disabled') && trigger.getClientRects().length) trigger.focus();
      else fallbackRef.current?.focus();
      afterClose?.();
    });
  }
  const close = useDialog(ref, { busy: false, dirty: false, onClose: () => dismiss() });
  const search = searchText(query);
  const results = importFields.filter(field => field.type !== 'additional' && isImportFieldAllowed(field.value, config.purpose || 'orders') && (!category || field.group === category) && (!search || fieldSearch.get(field.value).includes(search)));
  const grouped = new Map();
  for (const field of results) { if (!grouped.has(field.group)) grouped.set(field.group, []); grouped.get(field.group).push(field); }
  const candidate = { index: column.index, header: column.header, destination: additionalDestination, group: 0, fieldName };
  const additionalIssues = getImportColumnIssues([...columns.filter(item => item.index !== column.index), candidate], config.layout, config.purpose).filter(issue => issue.indexes.includes(column.index) && ['IMPORT_ADDITIONAL_NAME', 'IMPORT_ADDITIONAL_DUPLICATE', 'IMPORT_COLUMN_DESTINATION'].includes(issue.code));
  function assignedElsewhere(field) {
    return (usage.get(destinationKey(field, group, config.layout)) || []).filter(index => index !== column.index);
  }
  function select(field) {
    if (disabled || assignedElsewhere(field).length) return;
    onChangeColumn(column.index, column.header, { destination: field.value, group: usesGroup(field, config.layout) ? group : 0, fieldName: undefined });
    dismiss();
  }
  function enabledResults() { return resultsRef.current?.querySelectorAll('button:not(:disabled)') || []; }
  function focusResult(button) { button?.focus(); button?.scrollIntoView({ block: 'nearest' }); }
  function inputKeyDown(event) {
    if (event.nativeEvent.isComposing) return;
    const buttons = enabledResults();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusResult(buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (search && buttons.length) buttons[0].click();
    }
  }
  function resultKeyDown(event) {
    if (event.nativeEvent.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const button = event.target.closest('button'), buttons = enabledResults(), index = Array.prototype.indexOf.call(buttons, button);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) inputRef.current?.focus();
    else focusResult(buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowUp' ? index - 1 : Math.min(index + 1, buttons.length - 1)]);
  }
  function dialogKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Tab') {
      const buttons = ref.current.querySelectorAll('button:not(:disabled)');
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.target === (event.shiftKey ? first : last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    } else if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') event.preventDefault();
  }
  return <dialog ref={ref} className={styles.importDestinationDialog} aria-labelledby={titleId} onKeyDown={dialogKeyDown}>
    <header><h2 id={titleId}>Asignar columna {column.letter} · {column.header || 'Sin encabezado'}</h2><button type="button" className="icon-button" aria-label="Cerrar selector de destino" onClick={close}><Icon name="close" /></button></header>
    <div className={styles.importDestinationBody}>
      <div className={styles.importDestinationFilters}>
        <label className="field" htmlFor={searchId}>Buscar destino<input ref={inputRef} id={searchId} type="search" data-dialog-initial-focus autoComplete="off" value={query} aria-describedby={helpId} onKeyDown={inputKeyDown} onChange={event => setQuery(event.target.value)} /></label>
        <label className="field" htmlFor={categoryId}>Categoría<select id={categoryId} value={category} onChange={event => setCategory(event.target.value)}><option value="">Todas las categorías</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <p id={helpId} className="small muted">Flechas, Inicio/Fin y Enter recorren y seleccionan resultados. Esc cierra sin cambiar la asignación. Se muestran los destinos compatibles con los datos de esta hoja; las observaciones y los totales de comprobación no crean movimientos de dinero.</p>
      {['order_rows','expense_columns'].includes(config.layout) && <label className="field" htmlFor={groupId}>{config.layout === 'expense_columns' ? 'Grupo de campaña para el destino' : 'Grupo de producto para el destino'}<select id={groupId} value={group} disabled={disabled} onChange={event => setGroup(Number(event.target.value))}>{Array.from({ length: 50 }, (_, index) => <option key={index} value={index}>Grupo {index + 1}</option>)}</select><small>Elige el grupo antes de seleccionar {config.layout === 'expense_columns' ? 'cantidad o costo unitario de publicidad' : 'un campo de producto'}. Los demás destinos no usan grupo.</small></label>}
      <section className={styles.importDestinationPinned} aria-label="Opciones siempre disponibles">
        <button type="button" className="button subtle" disabled={disabled} onClick={() => { if (!disabled) { onChangeColumn(column.index, column.header, { destination: 'ignore', group: 0, fieldName: undefined }); dismiss(); } }}>Ignorar esta columna</button>
        {additionalOptions.length > 0 && <><button type="button" className="button subtle" aria-label="Conservar como campo adicional" aria-expanded={additional} disabled={disabled} onClick={() => { setAdditional(true); requestAnimationFrame(() => nameRef.current?.focus()); }}>Conservar como campo adicional</button>
        <p className="small muted">{types.additional} · {effects.information}. Elige si acompaña al pedido, al envío o al gasto; no cambia sus importes.</p></>}
        {additional && additionalOptions.length > 0 && <div className={styles.importAdditionalEditor}>
          <label className="field">Ámbito del dato adicional<select value={additionalDestination} disabled={disabled} onChange={event => setAdditionalDestination(event.target.value)}>{additionalOptions.map(field => <option key={field.value} value={field.value}>{scopeLabels[field.scope]}</option>)}</select></label>
          <label className="field" htmlFor={nameId}>Nombre del campo adicional<input ref={nameRef} id={nameId} type="text" maxLength={100} value={fieldName} disabled={disabled} aria-invalid={additionalIssues.length ? true : undefined} aria-describedby={additionalIssues.length ? nameErrorId : undefined} onChange={event => setFieldName(event.target.value)} /></label>
          {additionalIssues.length > 0 && <div id={nameErrorId} role="status">{additionalIssues.map(issue => <p key={issue.code}>{issue.message}</p>)}</div>}
          <button type="button" className="button primary" disabled={disabled || additionalIssues.length > 0} onClick={() => { if (!disabled && !additionalIssues.length) { onChangeColumn(column.index, column.header, { destination: additionalDestination, group: 0, fieldName: fieldName.trim() }); dismiss(); } }}>Usar campo adicional</button>
        </div>}
      </section>
      <p className="small muted" role="status">{results.length} destinos encontrados. Ignorar y conservar un campo adicional siempre están disponibles.</p>
      <div ref={resultsRef} className={styles.importDestinationResults} onKeyDown={resultKeyDown}>{[...grouped].map(([label, fields]) => <section key={label} aria-label={label}><h3>{label}</h3>{label === 'Seguro' && <p className="small">{insuranceHelp} El valor declarado no es el costo; la fecha corresponde al cargo.</p>}{fields.map(field => {
        const assigned = assignedElsewhere(field);
        return <button type="button" key={field.value} aria-label={field.label} className={styles.importDestinationOption} disabled={disabled || assigned.length > 0} onClick={() => select(field)}><strong>{field.label}</strong><span>{types[field.type]} · {effects[field.effect]}</span><span>{field.description}</span>{field.options && <small>Valores: {field.options.map(option => `${option.value} (${option.label})`).join(', ')}.</small>}{assigned.length > 0 && <small>Asignado a {assigned.map(index => `${columnLetter(index)} · columna ${index + 1}`).join(', ')}. Libera esa asignación{field.scope === 'line' && config.layout === 'order_rows' ? ' o elige otro grupo de producto' : ''}.</small>}</button>;
      })}</section>)}{!results.length && <p className={styles.emptyPrompt}>No encontramos destinos con esta búsqueda y categoría. Prueba otro nombre o selecciona Todas las categorías; también puedes conservar un campo adicional.</p>}</div>
    </div>
    <footer><button type="button" className="button subtle" onClick={close}>Cerrar sin cambiar</button>{onDiscardImport && <button type="button" className="button subtle" disabled={disabled} onClick={() => { if (!disabled) dismiss(onDiscardImport); }}>{discardLabel || 'Descartar archivo'}</button>}</footer>
  </dialog>;
}
