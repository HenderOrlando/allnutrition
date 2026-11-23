'use client';

import { useEffect, useState } from 'react';
import { HEKA_ID, HekaCards, HekaFields, HekaValues, carrierLabel } from './HekaForms';
import { hekaEnvironment } from './HekaPanel';
import { HekaGuideOrderLink } from './HekaOrderLink';

const STATES = { sending: 'En curso', succeeded: 'Confirmada por Heka', uncertain: 'Resultado incierto', rejected: 'Rechazada' };
const LABELS = { createGuide: 'Emisión de guía', solveNovelty: 'Solución de novedad' };
const displayDate = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
const date = value => value && Number.isFinite(new Date(value).getTime()) ? displayDate.format(new Date(value)) : undefined;
const guideFields = [
  { name: 'guideId', label: 'ID exacto de guía en Heka', pattern: HEKA_ID, required: true },
  { name: 'guideNumber', label: 'Número exacto de la guía', maxLength: 100, required: true },
];
const guideVerification = 'heka-uncertain-guide-verification', noveltyVerification = 'heka-uncertain-novelty-verification';
const canVerify = (mutation, config) => mutation.state === 'uncertain' && config.configured && mutation.environment === config.environment;

function HekaReceipt({ mutation }) {
  if (!mutation) return null;
  const { operation, state, environment, result, reconciledAt } = mutation;
  const create = operation === 'createGuide';
  return <>
    <h4>{LABELS[operation]} · {reconciledAt ? 'Verificada posteriormente' : STATES[state]}</h4>
    <HekaValues items={ [['Solicitud', mutation.requestId], ['Entorno', hekaEnvironment(environment)],
      ['Enviada (Bogotá)', date(mutation.createdAt)], ['Actualizada (Bogotá)', date(mutation.updatedAt)],
      ['Transportadora', carrierLabel(result?.distributor_id ?? mutation.carrier)],
      [create ? 'ID de guía Heka' : 'ID de novedad', result?._id], ['Número de guía', result?.guide_number],
      [create ? 'Estado informado por Heka' : 'Estado previo informado', create ? result?.status : result?.last_status],
      ['Código de respuesta', mutation.errorCode]] }/>
    {state === 'succeeded' && (create ? <p>{reconciledAt ? 'La guía fue verificada tras una asociación manual. Esto no prueba que la solicitud original la haya creado.' : 'Heka confirmó la emisión de la guía.'} La emisión no vincula un pedido automáticamente.</p>
      : <p>{reconciledAt ? 'Se verificó la solución existente en Heka.' : 'Heka aceptó la solución para revisión. Esto no confirma una resolución de la transportadora.'}</p>)}
    {state === 'sending' && <p>Espera y vuelve a consultar el historial. No se reenviará automáticamente.</p>}
    {state === 'uncertain' && <p>No vuelvas a enviar la operación. Comprueba qué quedó registrado en Heka y usa la verificación del historial.{create ? ' Otras emisiones en este entorno quedan bloqueadas hasta verificarla.' : ''}</p>}
  </>;
}

function JournalRow({ mutation, config, busy, onReview, linking, unique }) {
  const [values, setValues] = useState({});
  const create = mutation.operation === 'createGuide';
  const canReconcile = canVerify(mutation, config);
  function submit(event) {
    event.preventDefault();
    if (create && !values.guideNumber?.trim()) return;
    onReview(mutation, create ? { ...values, guideNumber: values.guideNumber.trim() } : {});
  }
  return <>
    <HekaReceipt mutation={mutation}/>
    {create && mutation.state === 'succeeded' && mutation.environment === config.environment && <HekaGuideOrderLink guide={mutation.result} busy={busy} linking={linking}/>}
    {mutation.state === 'uncertain' && (canReconcile ? <form aria-label={`Verificar solicitud ${mutation.requestId}`} tabIndex={unique?-1:undefined} data-advisor-control={unique?(create?guideVerification:noveltyVerification):undefined} onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <p>{create ? 'Primero localiza la guía correcta en «Guías» y coteja sus datos con los del envío. Verificar no emitirá otra guía.' : 'Comprueba si Heka ya registró la misma solución; esta acción no reenvía la solución.'} Usa la llave original de esta operación.</p>
        {create && <HekaFields fields={guideFields} values={values} onChange={(name, value) => setValues(current => ({ ...current, [name]: value }))}/>}
        <button type="submit" className="button subtle" disabled={create && !values.guideNumber?.trim()}>Revisar verificación</button>
      </fieldset>
    </form> : <p>Para verificar esta solicitud, debe estar conectada la llave original en su entorno.</p>)}
  </>;
}

export default function HekaJournal({ config, busy, readJournal, onReview, latest, linking, headingRef, advisorFocus }) {
  const [journal, setJournal] = useState(null);
  function refresh() { readJournal(setJournal); }
  useEffect(refresh, []);
  const known = journal ?? (latest ? [latest] : null);
  let guides = 0, novelties = 0;
  for (const mutation of known || []) if (canVerify(mutation, config)) {
    if (mutation.operation === 'createGuide') guides++;
    else if (mutation.operation === 'solveNovelty') novelties++;
  }
  const needsSelection = journal && (advisorFocus === guideVerification && guides !== 1 || advisorFocus === noveltyVerification && novelties !== 1);
  return <section className="settings-card" aria-label="Historial de operaciones Heka">
    <h3 ref={headingRef} tabIndex={-1} data-advisor-control={needsSelection?advisorFocus:undefined}>Historial de operaciones</h3>
    <p>Solicitudes recientes de emisión y solución. Este historial no conserva datos del destinatario ni el texto de la solución.</p>
    <button type="button" className="button subtle" disabled={busy} onClick={refresh}>Actualizar historial</button>
    {known?.length === 0 && <p>No hay operaciones registradas.</p>}
    {known?.length > 0 && <HekaCards rows={known.map(item => ({ ...item, _id: item.requestId }))}>{mutation => <JournalRow mutation={mutation} config={config} busy={busy} onReview={onReview} linking={linking} unique={(mutation.operation==='createGuide'?guides:novelties)===1}/>}</HekaCards>}
  </section>;
}
