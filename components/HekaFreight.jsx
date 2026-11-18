'use client';

import { useState } from 'react';
import { CARRIERS, DESTINATION_TYPES, HekaFields, HekaValues, HEKA_ID, PAYMENT_TYPES, fieldPayload } from './HekaForms';
import styles from './HekaPanel.module.css';

const field = (name, label, extra = {}) => ({ name, label, ...extra });
const amount = (name, label) => field(name, label, { number: true, min: 0, step: 'any', required: true });
const dimension = (name, label) => field(name, label, { number: true, min: 0, step: 'any', required: true });
const checkbox = (name, label) => field(name, label, { type: 'checkbox' });
const VERSION = [['1', '1'], ['2', '2 · Blindar devolución']];
const SHARED = [
  field('city_origin', 'Código DANE de origen', { required: true, inputMode: 'numeric', pattern: '[0-9]+', maxLength: 16 }),
  field('city_destination', 'Código DANE de destino', { required: true, inputMode: 'numeric', pattern: '[0-9]+', maxLength: 16 }),
  field('type', 'Tipo de entrega', { required: true, options: DESTINATION_TYPES, number: true }),
  field('type_payment', 'Tipo de pago', { required: true, options: PAYMENT_TYPES, number: true }),
  amount('declared_value', 'Valor declarado'), amount('collection_value', 'Valor a recaudar'),
  dimension('weight', 'Peso'), dimension('height', 'Alto'), dimension('long', 'Largo'), dimension('width', 'Ancho'),
  field('warehouse', 'ID de bodega Heka', { maxLength: 200 }), field('version', 'Versión de tarifa', { options: VERSION }),
];
const SHIPPING = checkbox('withshipping_cost', 'Sumar el costo del envío al recaudo');
const QUOTE = [field('channel', 'Canal', { options: [['hekaentrega', 'Heka Entrega'], ['loggy24', 'Loggy24']] }), field('seller', 'ID del vendedor', { maxLength: 200 })];
const GUIDE = [
  field('distributor_id', 'Transportadora', { required: true, options: CARRIERS }),
  field('product', 'Descripción del producto', { required: true, maxLength: 500 }),
  field('quantity', 'Cantidad', { number: true, min: 1, step: 'any' }),
  field('extra_info_product', 'Información adicional del producto', { maxLength: 1000 }),
  field('note', 'Nota interna', { type: 'textarea', maxLength: 1000 }),
];
const GUIDE_OPTIONS = [checkbox('collection_request', 'Solicitar recolección en la bodega'), checkbox('in_order_form', 'Marcar origen como formulario de pedido (in_order_form)')];
const CLIENT = [
  field('name', 'Nombre del destinatario', { required: true, maxLength: 200 }),
  field('address', 'Dirección del destinatario', { required: true, maxLength: 500 }),
  field('phone', 'Teléfono del destinatario', { required: true, number: true, min: 1000000, step: 1 }),
  field('alternative_phone', 'Teléfono alterno', { number: true, min: 1000000, step: 1 }),
  field('type_document', 'Tipo de documento', { options: ['CC', 'PS', 'CE', 'NIT', 'PPT', 'PEP', 'CD'].map(value => [value, value]) }),
  field('document', 'Documento', { inputMode: 'numeric', pattern: '[0-9]+', maxLength: 32 }),
  field('neighborhood', 'Barrio', { maxLength: 200 }), field('locality', 'Localidad', { maxLength: 200 }),
  field('email', 'Correo del destinatario', { type: 'email', maxLength: 254 }),
  field('note_destination', 'Indicaciones para la entrega', { type: 'textarea', maxLength: 1000 }),
];

export const EMPTY_FREIGHT = { type: '1', type_payment: '3', collection_value: '0', withshipping_cost: false };
export const TEMPLATE_FIELDS = [
  'city_destination', 'type_payment', 'declared_value', 'weight', 'height', 'long', 'width', 'withshipping_cost',
];

function displayFields(fields, input) {
  return fields.map(({ name, label, options }) => [label, options?.find(([value]) => value === String(input[name]))?.[1] ?? input[name]]);
}

export function GuideReview({ input }) {
  return <>
    <h3>Envío y paquete</h3>
    <HekaValues items={displayFields([...SHARED, SHIPPING, ...GUIDE, ...GUIDE_OPTIONS], input)}/>
    <h3>Destinatario</h3>
    <HekaValues items={displayFields(CLIENT, input.client)}/>
  </>;
}

export default function HekaFreight({ mode, setMode, draft, onDraft, client, onClient, busy, perform, review }) {
  const [quote, setQuote] = useState(null), [validation, setValidation] = useState('');
  const create = mode === 'create';
  const shared = create ? SHARED.map(item => item.name === 'warehouse' ? { ...item, required: true, pattern: HEKA_ID, maxLength: 24 } : item) : SHARED;
  const update = (name, value) => { setQuote(null); setValidation(''); onDraft(name, value); };
  function submit(event) {
    event.preventDefault(); setValidation('');
    const input = fieldPayload([...shared, SHIPPING, ...(create ? [...GUIDE, ...GUIDE_OPTIONS] : QUOTE)], draft);
    if (['weight', 'height', 'long', 'width'].some(key => !(input[key] > 0))) {
      setValidation('El peso y las tres dimensiones deben ser mayores que cero.'); return;
    }
    if (!create) {
      setQuote(null); perform('quote', input, result => setQuote({ result }));
      return;
    }
    input.client = fieldPayload(CLIENT, client);
    if (!input.product || !input.client.name || !input.client.address) {
      setValidation('Completa la descripción, el nombre y la dirección con texto válido.'); return;
    }
    review('createGuide', input);
  }
  return <section className="settings-card" aria-label="Cotizar o emitir guía">
    <h3>Cotizar o emitir guía</h3>
    <div className="admin-actions" role="group" aria-label="Acción de despacho">
      <button type="button" className={`button ${!create ? 'primary' : 'subtle'}`} aria-pressed={!create} disabled={busy} onClick={() => { setMode('quote'); setValidation(''); }}>Cotizar envío</button>
      <button type="button" className={`button ${create ? 'primary' : 'subtle'}`} aria-pressed={create} disabled={busy} onClick={() => { setMode('create'); setValidation(''); }}>Emitir guía</button>
    </div>
    <p>{create ? 'La emisión crea una guía en Heka; no registra ni vincula un envío en All Nutrition.' : 'Cotizar no crea una guía. Heka devuelve el resultado para los datos indicados.'} Puedes consultar códigos DANE, bodegas y plantillas en «Datos de envío» y copiar sus valores a este formulario.</p>
    <form aria-label={create ? 'Datos para emitir guía' : 'Datos para cotizar'} onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <h4>Ruta, paquete y cobro</h4>
        <HekaFields fields={shared} values={draft} onChange={update}/>
        <HekaFields fields={[SHIPPING]} values={draft} onChange={update}/>
        {create ? <>
          <h4>Datos de la guía</h4>
          <HekaFields fields={GUIDE} values={draft} onChange={update}/>
          <HekaFields fields={GUIDE_OPTIONS} values={draft} onChange={update}/>
          <h4>Datos del destinatario</h4>
          <HekaFields fields={CLIENT} values={client} onChange={onClient}/>
        </> : <details className={styles.details}><summary>Contexto adicional de cotización</summary><HekaFields fields={QUOTE} values={draft} onChange={update}/></details>}
        {validation && <p className="error" role="alert">{validation}</p>}
        <button type="submit" className="button primary">{create ? 'Revisar antes de emitir' : 'Solicitar cotización'}</button>
      </fieldset>
    </form>
    {!create && quote && <section className="settings-subform" aria-label="Respuesta de cotización" aria-live="polite">
      <h4>Respuesta de Heka</h4>
      {quote.result?.entries?.length ? <><p>Heka no documenta el significado ni la moneda de estos valores. No representan un cargo confirmado.</p><HekaValues items={quote.result.entries.map(({ path, value }) => [path, value])}/></> : <p>Heka no devolvió valores numéricos de cotización para mostrar.</p>}
    </section>}
  </section>;
}
