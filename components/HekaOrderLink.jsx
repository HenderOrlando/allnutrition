'use client';

import { HekaValues, carrierLabel, isHekaId } from './HekaForms';

export const orderLabel = number => `AN-${String(number).padStart(6, '0')}`;
export const parseOrderNumber = value => {
  const token = /^(?:AN-)?([0-9]+)$/i.exec(value.trim());
  const number = token && Number(token[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export function HekaGuideOrderLink({ guide, linking, busy, unique }) {
  if (!linking || !isHekaId(guide?._id) || !guide.guide_number) return null;
  const linked = linking.records[guide._id] ?? guide.localLink;
  return linked ? <div className="admin-actions"><span>Vinculada al pedido {orderLabel(linked.orderNumber)}.</span><button className="button subtle" type="button" data-advisor-control={unique?'heka-linked-shipment':undefined} disabled={busy} onClick={() => linking.open(linked)}>Abrir envío local</button></div>
    : guide.distributor_id ? <button type="button" className="button subtle" data-advisor-control={unique?'heka-link-guide-start':undefined} disabled={busy} onClick={() => linking.select(guide)}>Vincular guía a un pedido</button> : null;
}

export function HekaLinkOrderReview({ guide, orderNumber, onOrderNumber, order, onLookup, busy }) {
  return <>
    <p>La guía se registrará como envío local del pedido elegido. Esta acción no crea ni altera una guía en Heka ni registra recogida, entrega, cobro o movimiento de caja.</p>
    <HekaValues items={ [['Guía Heka', guide.guide_number], ['Transportadora', carrierLabel(guide.distributor_id)], ['Estado informado por Heka', guide.status]] }/>
    <form aria-label="Buscar pedido por número exacto" onSubmit={onLookup}>
      <fieldset className="editor-fieldset" disabled={busy}>
        <label className="field">Número exacto del pedido All Nutrition<input data-advisor-control="heka-order-lookup" required maxLength={20} value={orderNumber} onChange={event => onOrderNumber(event.target.value)} placeholder="AN-000123"/></label>
        <button type="submit" className="button subtle" disabled={!parseOrderNumber(orderNumber)}>Buscar pedido exacto</button>
      </fieldset>
    </form>
    {order && <section className="settings-subform" aria-label="Pedido local encontrado">
      <h3>Pedido {orderLabel(order.number)}</h3>
      <HekaValues items={ [['Cliente del pedido', order.customerName], ['Ciudad del pedido', order.city]] }/>
      <p>Comprueba que la guía seleccionada corresponde a este pedido; no se asocia por nombre ni teléfono.</p>
    </section>}
  </>;
}
