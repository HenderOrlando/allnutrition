'use client';

import { useState } from 'react';
import { CARRIERS, HEKA_ID, NOVELTY_STATES, PAYMENT_TYPES, HekaCards, HekaField, HekaSearch, HekaValues, carrierLabel, isHekaId, noveltyLabel } from './HekaForms';
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
const CITY_FIELDS = [field('label', 'Ciudad o departamento', { type: 'search', maxLength: 160 }), field('dane', 'Código DANE', { inputMode: 'numeric', pattern: '[0-9]+' })];
const CITY_MORE = [id('id', 'ID de ciudad Heka'), field('status', 'Estado de la ciudad en Heka', { maxLength: 60 })];
const WAREHOUSE_FIELDS = [field('name', 'Inicio del nombre', { type: 'search', maxLength: 160 }), field('search', 'Búsqueda libre de bodega', { type: 'search', maxLength: 160 })];
const WAREHOUSE_MORE = [id('id', 'ID de bodega Heka'), id('city', 'ID de ciudad Heka'), field('status', 'Estado de bodega en Heka', { maxLength: 60 }),
  field('isnotstatus', 'Excluir estado', { maxLength: 60 }), field('code', 'Código de transportadora', { maxLength: 100 }), ...dates];
const TEMPLATE_FIELDS = [field('label', 'Nombre de plantilla', { type: 'search', maxLength: 160 }), id('id', 'ID de plantilla Heka')];
const NOVELTY_FIELDS = [field('guide_number', 'Número de guía', { maxLength: 100 }), novelty, carrier];
const NOVELTY_MORE = [id('id', 'ID de la guía Heka'), field('label', 'Etiqueta exacta de la guía', { maxLength: 160 })];
const HISTORY_FIELDS = [phone, field('document', 'Documento del destinatario', { inputMode: 'numeric', pattern: '[0-9]+', maxLength: 32 })];

function GuideResults({ guides, busy, onStickers, linking, unique }) {
  const [selected, setSelected] = useState([]);
  const guidesAvailable = guides.filter(guide => isHekaId(guide._id));
  function toggle(id, active) { setSelected(current => active ? [...current, id] : current.filter(value => value !== id)); }
  return <>
    {guidesAvailable.length > 0 && <div className="admin-actions"><p tabIndex={-1} data-advisor-control="heka-guide-label-selection">Selecciona las guías que quieres incluir. Prepararlas no descarga el PDF.</p><button type="button" className="button subtle" disabled={busy || !selected.length} onClick={() => onStickers(selected)}>Preparar etiquetas seleccionadas ({selected.length})</button></div>}
    <HekaCards rows={guides}>{guide => <>
      <h4>Guía {guide.guide_number ?? 'sin número informado'}</h4>
      <HekaValues items={[
        ['ID Heka', guide._id], ['Transportadora', carrierLabel(guide.distributor_id)], ['Estado informado por Heka', guide.status],
      ]}/>
      {isHekaId(guide._id) && <label className="checkbox-field"><input type="checkbox" checked={selected.includes(guide._id)} disabled={busy} onChange={event => toggle(guide._id, event.target.checked)}/>Incluir guía {guide.guide_number ?? guide._id} en etiquetas</label>}
      <HekaGuideOrderLink guide={guide} busy={busy} linking={linking} unique={unique}/>
    </>}</HekaCards>
  </>;
}

export function HekaGuides({ busy, perform, onStickers, linking }) {
  return <HekaSearch title="Buscar guías" operation="guides" advisorControl="heka-guide-search" fields={GUIDE_FIELDS} more={GUIDE_MORE} busy={busy} perform={perform}
    intro="Consulta el estado registrado por Heka. Pago, conciliación y recaudo son filtros de búsqueda, no acciones financieras. Esta consulta no actualiza pedidos locales ni ofrece un historial de rastreo independiente.">
    {(rows, unique) => <GuideResults guides={rows} busy={busy} onStickers={onStickers} linking={linking} unique={unique}/>}
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
    <HekaSearch title="Listar bodegas" operation="warehouses" advisorControl="heka-warehouse-search" fields={WAREHOUSE_FIELDS} more={WAREHOUSE_MORE} busy={busy} perform={perform}>
      {(rows, unique) => <HekaCards rows={rows}>{warehouse => <>
        <h4>{warehouse.name ?? 'Bodega sin nombre informado'}</h4>
        <HekaValues items={ [['ID de bodega', warehouse._id], ['Estado', warehouse.status]] }/>
        {isHekaId(warehouse._id) && <button type="button" className="button subtle" data-advisor-control={unique?'heka-copy-warehouse':undefined} disabled={busy} onClick={() => onWarehouse(warehouse._id)}>Usar bodega para el envío</button>}
      </>}</HekaCards>}
    </HekaSearch>
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

function NoveltyCard({ guide, busy, review, unique }) {
  const [solution, setSolution] = useState('');
  const last = guide.last_novelty, canSolve = isHekaId(guide._id) && isHekaId(last?._id) && ['in_novelty', 'in_review'].includes(guide.status_novelty);
  function submit(event) {
    event.preventDefault();
    if (solution.trim()) review('solveNovelty', { id: last._id, guideId: guide._id, solution: solution.trim() }, { guide: guide.guide_number, message: last.message, replacing: guide.status_novelty === 'in_review' });
  }
  return <>
    <h4>Guía {guide.guide_number ?? 'sin número informado'}</h4>
    <HekaValues items={ [['Transportadora', carrierLabel(guide.distributor_id)], ['Estado de la novedad', noveltyLabel(guide.status_novelty)],
      ['Motivo informado por Heka', last?.message], ['ID de novedad', last?._id], ['Origen', guide.city_origin], ['Destino', guide.city_destination]] }/>
    {guide.movemens?.length > 0 && <details className={styles.details}><summary>Movimientos informados por Heka</summary><ol>
      {guide.movemens.map((movement, index) => <li key={index}>{[movement.date, movement.label, movement.status, movement.code].filter(Boolean).join(' · ')}</li>)}
    </ol></details>}
    {canSolve && <form aria-label={`Solucionar novedad: ${guide.guide_number ?? last._id}`} onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <HekaField name="solution" type="textarea" label="Solución para Heka" data-advisor-control={unique?'heka-novelty-review':undefined} maxLength={2000} required value={solution} onChange={(_, value) => setSolution(value.replaceAll(/[\r\n\t]/g, ' '))}/>
        <button type="submit" className="button subtle" disabled={!solution.trim()}>Revisar solución</button>
      </fieldset>
    </form>}
  </>;
}

export function HekaNovelties({ busy, perform, review }) {
  return <HekaSearch title="Consultar novedades" operation="novelties" advisorControl="heka-novelty-search" fields={NOVELTY_FIELDS} more={NOVELTY_MORE} busy={busy} perform={perform}
    intro="Se requiere una llave de una cuenta seller. Heka solo acepta soluciones en novedad o en revisión. Una solución aprobada por la API pasa a revisión, no queda resuelta automáticamente.">
    {(rows, unique) => <HekaCards rows={rows}>{guide => <NoveltyCard guide={guide} busy={busy} review={review} unique={unique}/>}</HekaCards>}
  </HekaSearch>;
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
