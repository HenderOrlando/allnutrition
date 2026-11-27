'use client';

import { useState } from 'react';
import { CARRIERS, DESTINATION_TYPES, HekaField, HekaFields, HekaValues, HEKA_ID, PAYMENT_TYPES, fieldPayload } from './HekaForms';

const field = (name, label, extra = {}) => ({ name, label, ...extra });
const amount = (name, label) => field(name, label, { number: true, min: 0, step: 'any', required: true });
const dimension = (name, label) => field(name, label, { number: true, min: 0, step: 'any', required: true });
const checkbox = (name, label) => field(name, label, { type: 'checkbox' });
const VERSION = [['1', '1'], ['2', '2 · Blindar devolución']];
const SHARED = [
  field('city_origin', 'Origen'),
  field('city_destination', 'Destino'),
  field('type', 'Tipo de entrega', { required: true, options: DESTINATION_TYPES, number: true }),
  field('type_payment', 'Tipo de pago', { required: true, options: PAYMENT_TYPES, number: true }),
  amount('declared_value', 'Valor declarado'), amount('collection_value', 'Valor a recaudar'),
  dimension('weight', 'Peso'), dimension('height', 'Alto'), dimension('long', 'Largo'), dimension('width', 'Ancho'),
  field('warehouse', 'ID de bodega Heka', { maxLength: 200 }), field('version', 'Versión de tarifa', { options: VERSION }),
];
const SHIPPING = checkbox('withshipping_cost', 'Sumar el costo del envío al recaudo');
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
  field('note_destination', 'Indicaciones para la entrega', { type: 'textarea', maxLength: 1000, 'aria-label':'Indicaciones para la entrega' }),
];

export const EMPTY_FREIGHT = { type: '1', type_payment: '3', collection_value: '0', withshipping_cost: false };

const displayValue = value => value && typeof value==='object' ? [value.city,value.state].filter(Boolean).join(', ') : value;
function displayFields(fields, input) {
  return fields.map(({ name, label, options }) => [label, options?.find(([value]) => value === String(input[name]))?.[1] ?? displayValue(input[name])]);
}

export function GuideReview({ input }) {
  return <>
    <h3>Envío y paquete</h3>
    <HekaValues items={displayFields([...SHARED, SHIPPING, ...GUIDE, ...GUIDE_OPTIONS], input)}/>
    <h3>Destinatario</h3>
    <HekaValues items={displayFields(CLIENT, input.client)}/>
  </>;
}

function CityFields({field,value,onChange}) {
  const place=typeof value==='object'&&value!==null?value:{};
  return <>
    <HekaField label={`Código DANE de ${field.label.toLowerCase()}`} name={field.name} inputMode="numeric" pattern="[0-9]+" maxLength={16} value={typeof value==='string'?value:''} onChange={onChange}/>
    <HekaField label={`Municipio de ${field.label.toLowerCase()}`} name={`${field.name}_city`} maxLength={100} value={place.city??''} onChange={(_,city)=>onChange(field.name,{...place,city})}/>
    <HekaField label={`Departamento de ${field.label.toLowerCase()}`} name={`${field.name}_state`} maxLength={100} value={place.state??''} onChange={(_,state)=>onChange(field.name,{...place,state})}/>
  </>;
}

export default function HekaFreight({ draft, onDraft, client, onClient, busy, review, onBack, environment }) {
  const [validation, setValidation] = useState('');
  const shared = SHARED.slice(2).map(item => item.name === 'warehouse' ? { ...item, required: true, pattern: HEKA_ID, maxLength: 24 } : item);
  const update = (name, value) => { setValidation(''); onDraft(name, value); };
  function submit(event) {
    event.preventDefault(); setValidation('');
    const input = fieldPayload([...shared, SHIPPING, ...GUIDE, ...GUIDE_OPTIONS], draft);
    for (const {name,label} of SHARED.slice(0,2)) {
      const value=draft[name];
      if(typeof value==='string'&&/^\d{1,16}$/.test(value)) input[name]=value;
      else if(value?.city?.trim()&&value?.state?.trim()) input[name]={city:value.city.trim(),state:value.state.trim()};
      else {setValidation(`${label}: indica un DANE o el municipio y departamento.`);return;}
    }
    if (['weight', 'height', 'long', 'width'].some(key => !(input[key] > 0))) {
      setValidation('El peso y las tres dimensiones deben ser mayores que cero.'); return;
    }
    input.client = fieldPayload(CLIENT, client);
    if (!input.product || !input.client.name || !input.client.address) {
      setValidation('Completa la descripción, el nombre y la dirección con texto válido.'); return;
    }
    review('createGuide', input);
  }
  return <section className="settings-card" aria-label="Emitir guía en Heka">
    <h3>Emitir guía en Heka</h3>
    <button type="button" className="button subtle" onClick={onBack} disabled={busy}>Volver a preparar o cotizar</button>
    <p>La emisión crea una guía en Heka; no registra ni vincula un envío en All Nutrition.</p>
    {environment==='test'&&<p className="hint">Pruebas: escribe un destinatario ficticio. No se copian contactos reales desde la preparación.</p>}
    <form aria-label="Datos para emitir guía" onSubmit={submit}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <h4>Ruta, paquete y cobro</h4>
        <div className="product-form-grid">{SHARED.slice(0,2).map(field=><CityFields key={field.name} field={field} value={draft[field.name]} onChange={update}/>)}</div>
        <HekaFields fields={shared} values={draft} onChange={update}/>
        <HekaFields fields={[SHIPPING]} values={draft} onChange={update}/>
        <h4>Datos de la guía</h4>
        <HekaFields fields={GUIDE} values={draft} onChange={update}/>
        <HekaFields fields={GUIDE_OPTIONS} values={draft} onChange={update}/>
        <h4>Datos del destinatario</h4>
        <HekaFields fields={CLIENT} values={client} onChange={onClient}/>
        {validation && <p className="error" role="alert">{validation}</p>}
        <button type="submit" className="button primary" data-advisor-control="heka-guide-review">Revisar antes de emitir</button>
      </fieldset>
    </form>
  </section>;
}
