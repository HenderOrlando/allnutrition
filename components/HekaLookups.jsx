'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CARRIERS, HEKA_ID, NOVELTY_STATES, PAYMENT_TYPES, HekaCards, HekaField, HekaFields, HekaSearch, HekaValues, carrierLabel, fieldPayload, isHekaId } from './HekaForms';
import { HEKA_ROOT, hekaEnvironment, hekaOperation } from './HekaPanel';
import { HekaGuideOrderLink } from './HekaOrderLink';
import styles from './HekaPanel.module.css';

const field = (name, label, extra = {}) => ({ name, label, ...extra });
const id = (name, label) => field(name, label, { pattern: HEKA_ID });
const carrier = field('distributor_id', 'Transportadora', { options: CARRIERS });
const novelty = field('status_novelty', 'Estado de la novedad', { options: NOVELTY_STATES });
const dates = [field('start_date', 'Creada desde (Bogotá)', { type: 'date' }), field('end_date', 'Creada hasta (Bogotá)', { type: 'date' })];
const phone = field('phone', 'Teléfono del destinatario', { number: true, min: 1000000, step: 1 });
const person = item => [item?.name, item?.last_name].filter(Boolean).join(' ');

const GUIDE_FIELDS = [field('text', 'Número de guía, nombre o teléfono', { type: 'search', maxLength: 160 }), carrier];
const GUIDE_MORE = [id('id', 'ID de la guía Heka'), field('status', 'Estado de la guía en Heka', { maxLength: 60 }), novelty,
  ...dates, field('paid', 'Filtro de pago (valor Heka)', { maxLength: 60 }), field('reconciled', 'Filtro de conciliación (valor Heka)', { maxLength: 60 }), field('collection', 'Filtro de recaudo (valor Heka)', { maxLength: 60 })];
const ALL_GUIDE_FIELDS = [...GUIDE_FIELDS, ...GUIDE_MORE];
const GUIDE_COUNTS = [['all', 'Todas'], ...CARRIERS];
const MAX_STICKERS = 20;
const CITY_FIELDS = [field('label', 'Ciudad o departamento', { type: 'search', maxLength: 160 }), field('dane', 'Código DANE', { inputMode: 'numeric', pattern: '[0-9]+' })];
const CITY_MORE = [id('id', 'ID de ciudad Heka'), field('status', 'Estado de la ciudad en Heka', { maxLength: 60 })];
const WAREHOUSE_FIELDS = [field('name', 'Inicio del nombre', { type: 'search', maxLength: 160 }), field('search', 'Búsqueda libre de bodega', { type: 'search', maxLength: 160 })];
const WAREHOUSE_MORE = [id('id', 'ID de bodega Heka'), id('city', 'ID de ciudad Heka'), field('status', 'Estado de bodega en Heka', { maxLength: 60 }),
  field('isnotstatus', 'Excluir estado', { maxLength: 60 }), field('code', 'Código de transportadora', { maxLength: 100 }), ...dates];
const TEMPLATE_FIELDS = [field('label', 'Nombre de plantilla', { type: 'search', maxLength: 160 }), id('id', 'ID de plantilla Heka')];
const HISTORY_FIELDS = [phone, field('document', 'Documento del destinatario', { inputMode: 'numeric', pattern: '[0-9]+', maxLength: 32 })];

function GuideResults({ guides, busy, onStickers, linking, unique, selected, onSelect }) {
  return <>
    <div className="admin-actions">
      <p tabIndex={-1} data-advisor-control="heka-guide-label-selection">Selecciona las guías que quieres incluir. Prepararlas no descarga el PDF.</p>
      <button type="button" className="button subtle" disabled={busy || !selected.length} onClick={() => onStickers(selected)}>Preparar etiquetas seleccionadas ({selected.length})</button>
      {selected.length > 0 && <button type="button" className="button subtle" disabled={busy} onClick={() => onSelect([])}>Limpiar selección</button>}
    </div>
    {selected.length === MAX_STICKERS && <p role="status">Seleccionaste el máximo de {MAX_STICKERS} guías. Quita una selección para añadir otra.</p>}
    <HekaCards rows={guides}>{guide => <>
      <h4>Guía {guide.guide_number ?? 'sin número informado'}</h4>
      <HekaValues items={[
        ['ID Heka', guide._id], ['Transportadora', carrierLabel(guide.distributor_id)], ['Estado informado por Heka', guide.status],
      ]}/>
      {isHekaId(guide._id) && <label className="checkbox-field"><input type="checkbox" checked={selected.includes(guide._id.toLowerCase())}
        disabled={busy || selected.length === MAX_STICKERS && !selected.includes(guide._id.toLowerCase())}
        onChange={event => {
          const id = guide._id.toLowerCase(), checked = event.target.checked;
          onSelect(current => checked ? current.length < MAX_STICKERS && !current.includes(id) ? [...current, id] : current : current.filter(value => value !== id));
        }}/>Incluir guía {guide.guide_number ?? guide._id} en etiquetas</label>}
      <HekaGuideOrderLink guide={guide} busy={busy} linking={linking} unique={unique}/>
    </>}</HekaCards>
  </>;
}

function useGuideRead(read, attempt = 0) {
  const [settled, setSettled] = useState(null);
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController(), { signal } = controller;
    async function load() {
      // Avoid dispatching the effect discarded by React's setup/cleanup replay.
      await Promise.resolve();
      if (signal.aborted) return;
      try {
        const data = await read(signal);
        if (!signal.aborted) setSettled({ read, attempt, data });
      } catch (error) {
        if (!signal.aborted) setSettled({ read, attempt, error: error.message });
      }
    }
    void load();
    return () => controller.abort();
  }, [read, attempt]);
  const current = settled?.read === read && settled.attempt === attempt;
  return { pending: Boolean(read && !current), data: settled?.data, error: current ? settled.error : null };
}

const validPage = page => Number.isSafeInteger(page) && page > 0;

function GuideBrowser({ api, config, active, enabled, busy, onStickers, linking }) {
  const { environment, version } = config;
  const [opened, setOpened] = useState(false);
  const [values, setValues] = useState({}), [validation, setValidation] = useState('');
  const [query, setQuery] = useState({ filters: {}, page: 1 });
  const [countAttempt, setCountAttempt] = useState(0), [selected, setSelected] = useState([]);
  const heading = useRef(null);
  const advanced = GUIDE_MORE.map(field => field.name === 'end_date' ? { ...field, min: values.start_date || undefined } : field);
  useEffect(() => { if (active && enabled) setOpened(true); }, [active, enabled]);

  const loadPage = useCallback(signal => hekaOperation((path, options) => api(path, { ...options, signal }),
    { environment, version }, 'guides', { ...query.filters, page: query.page, limit: 20 }), [api, environment, version, query]);
  const loadCounts = useCallback(signal => api(`${HEKA_ROOT}/counts`, {
    method: 'POST', body: JSON.stringify({ environment, version }), signal,
  }), [api, environment, version]);
  const list = useGuideRead(opened ? loadPage : null);
  const counts = useGuideRead(opened ? loadCounts : null, countAttempt);
  const pager = list.data?.result?.pager, rows = list.data?.result?.rows ?? [];
  const filtered = Object.keys(query.filters).length > 0, appliedCarrier = query.filters.distributor_id || 'all';
  const filteredEmpty = opened && !list.pending && !list.error && filtered && !rows.length && !(pager?.total > 0);
  const totals = counts.data?.totals;
  const unavailable = counts.error || GUIDE_COUNTS.some(([id]) => totals?.[id] == null);

  function start(filters) {
    setValidation('');
    setOpened(true);
    setQuery({ filters, page: 1 });
  }
  function submit(event) {
    event.preventDefault();
    const filters = fieldPayload(ALL_GUIDE_FIELDS, values);
    if (filters.start_date && filters.end_date && values.start_date > values.end_date) {
      setValidation('La fecha inicial no puede ser posterior a la final.');
      return;
    }
    start(filters);
  }
  function update(name, value) {
    setValues(current => ({ ...current, [name]: value }));
    setValidation('');
  }
  function clear() { setValues({}); start({}); }
  function chooseCarrier(id) {
    const filters = { ...query.filters };
    if (id === 'all') delete filters.distributor_id;
    else filters.distributor_id = id;
    update('distributor_id', filters.distributor_id ?? '');
    start(filters);
  }
  const turn = page => setQuery(current => ({ ...current, page }));

  return <section hidden={!active} className="settings-card" aria-label="Buscar guías">
    <h3 ref={heading} tabIndex={-1} data-advisor-control="heka-guide-search">Buscar guías</h3>
    <p>Consulta el estado registrado por Heka. Pago, conciliación y recaudo son filtros de búsqueda; consultar no actualiza pedidos locales.</p>
    {!opened && <>
      <p tabIndex={-1} data-advisor-control="heka-guide-label-selection">Abre las guías para seleccionar las que quieres incluir en las etiquetas.</p>
      <button type="button" className="button primary" disabled={busy} onClick={() => { setOpened(true); heading.current?.focus(); }}>Abrir guías</button>
    </>}
    {opened && <section className="settings-subform" aria-label="Guías por transportadora">
      <h4>Guías por transportadora</h4>
      <p>Totales de esta cuenta Heka · {hekaEnvironment(environment)}. No cambian al buscar o paginar.</p>
      <div className="admin-actions" role="group" aria-label="Filtrar por transportadora">
        {GUIDE_COUNTS.map(([id, label]) => <button key={id} type="button" className={`button ${appliedCarrier === id ? 'primary' : 'subtle'}`}
          aria-pressed={appliedCarrier === id} disabled={busy} onClick={() => chooseCarrier(id)}>
          {label} · {counts.pending && !totals ? 'Consultando…' : totals?.[id] ?? 'No disponible'}{appliedCarrier === id && ' · Activa'}
        </button>)}
      </div>
      <p role="status">{counts.pending ? totals ? 'Actualizando totales…' : 'Consultando totales de la cuenta…' :
        unavailable ? 'Hay totales no disponibles.' : 'Totales de la cuenta disponibles.'}</p>
      {counts.error && <p className="error" role="alert">{counts.error}</p>}
      <button type="button" className="button subtle" disabled={counts.pending} onClick={() => setCountAttempt(current => current + 1)}>
        {unavailable && !counts.pending ? 'Reintentar totales' : 'Actualizar totales'}
      </button>
    </section>}
    <form aria-label="Buscar guías" onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <HekaFields fields={GUIDE_FIELDS} values={values} onChange={update}/>
        <details className={styles.details}><summary>Más filtros</summary><HekaFields fields={advanced} values={values} onChange={update}/></details>
        {validation && <p className="error" role="alert">{validation}</p>}
        <div className="admin-actions">
          <button type="submit" className={`button ${opened ? 'primary' : 'subtle'}`}>Buscar guías</button>
          {!filteredEmpty && (filtered || Object.values(values).some(value => value)) && <button type="button" className="button subtle" onClick={clear}>Limpiar filtros</button>}
        </div>
      </fieldset>
    </form>
    {opened && <div className={styles.results}>
      <div role="status">{list.pending ? 'Consultando guías…' : list.error ? '' :
        !rows.length ? pager?.total > 0 ? 'No hay guías en esta página.' : filtered ? 'Ninguna guía coincide.' : 'Todavía no hay guías.' :
        `${rows.length} ${rows.length === 1 ? 'guía en esta página' : 'guías en esta página'}.`}
      </div>
      {filteredEmpty && <button type="button" className="button subtle" disabled={busy} onClick={clear}>Limpiar filtros</button>}
      {list.error && <div className="admin-actions">
        <p className="error" role="alert">{list.error}</p>
        <button type="button" className="button subtle" disabled={busy} onClick={() => turn(query.page)}>Reintentar consulta</button>
      </div>}
      <GuideResults guides={list.pending || list.error ? [] : rows} busy={busy} onStickers={onStickers} linking={linking}
        unique={pager?.total === 1 && rows.length === 1} selected={selected} onSelect={setSelected}/>
      {pager && <nav className="admin-actions" aria-label="Páginas: Buscar guías">
        <button type="button" className="button subtle" disabled={busy || list.pending || Boolean(list.error) || !validPage(pager.previousPage)}
          onClick={() => turn(pager.previousPage)}>Anterior</button>
        <span aria-live="polite">{list.pending ? `Consultando página ${query.page}…` :
          `Página ${pager.page ?? query.page}${Number.isSafeInteger(pager.pages) ? ` de ${Math.max(pager.pages, 1)}` : ''}${Number.isSafeInteger(pager.total) ? ` · ${pager.total} resultados` : ''}`}</span>
        <button type="button" className="button subtle" disabled={busy || list.pending || Boolean(list.error) || !validPage(pager.nextPage)}
          onClick={() => turn(pager.nextPage)}>Siguiente</button>
      </nav>}
    </div>}
  </section>;
}

export function HekaGuides({ config, active = true, enabled = false, ...props }) {
  if (!config?.configured) return null;
  return <GuideBrowser key={`${config.environment}:${config.version}`} config={config} active={active} enabled={enabled} {...props}/>;
}

export function HekaWarehouseLookup({busy,perform,onWarehouse,advisor=false}) {
  return <HekaSearch title="Listar bodegas" operation="warehouses" advisorControl={advisor?'heka-warehouse-search':undefined} fields={WAREHOUSE_FIELDS} more={WAREHOUSE_MORE} busy={busy} perform={perform}>
    {(rows, unique) => <HekaCards rows={rows}>{warehouse => <>
      <h4>{warehouse.name ?? 'Bodega sin nombre informado'}</h4>
      <HekaValues items={ [['ID de bodega', warehouse._id], ['Estado', warehouse.status]] }/>
      {isHekaId(warehouse._id) && <button type="button" className="button subtle" data-advisor-control={advisor&&unique?'heka-copy-warehouse':undefined} disabled={busy} onClick={() => onWarehouse(warehouse)}>Usar bodega para el envío</button>}
    </>}</HekaCards>}
  </HekaSearch>;
}

export function HekaLookups({ busy, perform, onCity, onWarehouse, onTemplate }) {
  return <>
    <HekaSearch title="Buscar ciudades" operation="cities" advisorControl="heka-city-search" fields={CITY_FIELDS} more={CITY_MORE} busy={busy} perform={perform}>
      {(rows, unique) => <HekaCards rows={rows}>{city => <>
        <h4>{city.label ?? 'Ciudad sin nombre informado'}</h4>
        <HekaValues items={ [['Código DANE', city.dane], ['ID Heka', city._id]] }/>
        {city.dane && <div className="admin-actions"><button type="button" className="button subtle" data-advisor-control={unique?'heka-copy-origin-city':undefined} disabled={busy} onClick={() => onCity('city_origin', city.dane)}>Usar como origen</button><button type="button" className="button subtle" data-advisor-control={unique?'heka-copy-destination-city':undefined} disabled={busy} onClick={() => onCity('city_destination', city.dane)}>Usar como destino</button></div>}
      </>}</HekaCards>}
    </HekaSearch>
    <HekaWarehouseLookup busy={busy} perform={perform} onWarehouse={warehouse=>onWarehouse(warehouse._id)} advisor/>
    <HekaSearch title="Consultar plantillas" operation="templates" advisorControl="heka-template-search" fields={TEMPLATE_FIELDS} page={false} busy={busy} perform={perform}>
      {(rows, unique) => <HekaCards rows={rows}>{template => <>
        <h4>{template.label ?? 'Plantilla sin nombre informado'}</h4>
        <HekaValues items={ [['ID de plantilla', template._id], ['Código DANE de destino', template.city_destination], ['Tipo de pago', PAYMENT_TYPES.find(([value]) => value === String(template.type_payment))?.[1]],
          ['Valor declarado', template.declared_value], ['Peso', template.weight], ['Alto', template.height], ['Largo', template.long], ['Ancho', template.width], ['Sumar costo del envío', template.withshipping_cost]] }/>
        <button type="button" className="button subtle" data-advisor-control={unique?'heka-apply-template':undefined} disabled={busy} onClick={() => onTemplate(template)}>Aplicar a los datos de envío</button>
      </>}</HekaCards>}
    </HekaSearch>
  </>;
}

export function HekaCustomers({ busy, perform }) {
  const [values, setValues] = useState({}), [rating, setRating] = useState(null);
  function rate(event) {
    event.preventDefault(); setRating(null);
    perform('clientRating', { phone: Number(values.phone), limit: 1 }, result => setRating({ result }));
  }
  return <>
    <HekaSearch title="Consultar historial de destinatario" operation="clientHistory" advisorControl="heka-recipient-history-form" fields={HISTORY_FIELDS} busy={busy} perform={perform}
      intro="Usa un teléfono o documento autorizado para consultar guías previas. Heka puede enmascarar datos.">
      {rows => <HekaCards rows={rows}>{row => <><h4>Guía {row.guide_number ?? 'sin número informado'}</h4><HekaValues items={ [['Destinatario', person(row)], ['Documento', row.document]] }/></>}</HekaCards>}
    </HekaSearch>
    <section className="settings-card" aria-label="Calificación del destinatario">
      <h3 tabIndex={-1} data-advisor-control="heka-recipient-rating-form">Calificación del destinatario</h3>
      <form aria-label="Consultar calificación del destinatario" onSubmit={rate}>
        <fieldset className="editor-fieldset" disabled={busy}>
          <HekaField {...phone} required value={values.phone} onChange={(name, value) => setValues({ [name]: value })}/>
          <button type="submit" className="button primary">Consultar calificación</button>
        </fieldset>
      </form>
      {rating && <div aria-live="polite" className={styles.results}>{rating.result == null ? <p>Heka no tiene guías registradas para este teléfono.</p> : <>
        <HekaValues items={ [['Destinatario', person(rating.result._id)], ['Documento', rating.result._id?.document],
          ['Calificación Heka', rating.result.category], ['Total de guías', rating.result.total], ['Devoluciones', rating.result.returned],
          ['Porcentaje devuelto', rating.result.percentReturned], ['Finalizadas', rating.result.statuses?.finished]] }/>
      </>}</div>}
    </section>
  </>;
}

export function HekaStickers({ busy, perform, ids, onIds, mode, onMode, documentId, onDocumentId }) {
  const [validation, setValidation] = useState(null), [downloadedMode, setDownloadedMode] = useState(null);
  function download(event) {
    event.preventDefault(); setValidation(null); setDownloadedMode(null);
    const guides = mode === 'guide' ? [...new Set(ids.trim().toLowerCase().split(/[\s,]+/))] : null;
    if (guides && (!guides.every(isHekaId) || guides.length > 20)) {
      setValidation('Ingresa de 1 a 20 IDs de guía Heka de 24 caracteres hexadecimales.'); return;
    }
    perform('sticker', mode === 'guide' ? { type: mode, guides } : { type: mode, id: documentId }, blob => {
      if (blob.type !== 'application/pdf' || !blob.size) throw new Error('Heka no devolvió un PDF válido.');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      try { link.href = url; link.download = 'etiquetas-heka.pdf'; document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setDownloadedMode(mode);
    });
  }
  return <section className="settings-card" aria-label="Etiquetas PDF de Heka">
    <h3>Etiquetas PDF</h3>
    <p>El PDF puede agrupar hasta 20 guías de tu cuenta si comparten transportadora y tipo de pago. Usa los IDs internos de Heka, no los números de guía. También puedes consultar un documento guardado por ID.</p>
    <form aria-label="Generar etiquetas PDF" onSubmit={download}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <HekaField name="type" label="Origen de etiquetas" options={ [['guide', 'Guías'], ['document', 'Documento guardado']] } required value={mode} onChange={(_, value) => { onMode(value); setValidation(null); setDownloadedMode(null); }}/>
        {mode === 'guide' ? <HekaField name="guides" type="textarea" label="IDs de guías Heka" data-advisor-control="heka-guide-label-download" required maxLength={1500} value={ids} onChange={(_, value) => onIds(value)}/>
          : <HekaField name="id" label="ID de documento Heka" data-advisor-control="heka-saved-label-download" required pattern={HEKA_ID} value={documentId} onChange={(_, value) => onDocumentId(value)}/>}
        {mode==='guide' && validation && <p role="alert" className="error">{validation}</p>}
        <button type="submit" className="button primary">Descargar etiquetas PDF</button>
      </fieldset>
    </form>
    {downloadedMode===mode && <p role="status">Se inició la descarga del PDF de Heka.</p>}
  </section>;
}
