import { getOrder } from '../business/orders.mjs';
import { carrierKey, effectiveShipmentEvents } from '../business/shipments.mjs';
import { businessDate } from '../business/dates.mjs';
import { shipmentStates } from '../schema.mjs';
import { fail, text } from '../validation-core.mjs';
import { answerAdvisorCash, resolveAdvisorCash } from './advisor-cash.mjs';
import { answerAdvisorImport, resolveAdvisorImport } from './advisor-imports.mjs';
import { resolveAdvisorFollowUp } from './advisor-recommendations.mjs';

const SHIP_ORDER = 'orders.ship-order';
const CLOSE_CASH = 'cash.close-day';
const RESOLVE_IMPORT = 'imports.resolve-issues';
const FOLLOW_RECOMMENDATION = 'advisor.follow-recommendation';
const GUIDED = new Set([SHIP_ORDER, CLOSE_CASH, RESOLVE_IMPORT, FOLLOW_RECOMMENDATION]);
const CLOSED = new Set(['completed', 'cancelled']);
const orders = { section: 'orders', tab: 'list' };
const shipments = { section: 'orders', tab: 'shipments' };
const orderNumber = order => `AN-${String(order.number).padStart(6, '0')}`;
const eventOptions = shipmentStates.map(state => ({ id: state.value, label: state.label }));

function action(label, view, focus, selection = null) {
  return { label, capabilityId: SHIP_ORDER, view, focus, selection };
}
function orderAction(order, focus, label, values = {}) {
  return action(label, { ...orders, record: order.id }, focus, { kind: 'order', id: order.id, version: order.version, ...values });
}
function shipmentAction(shipment, focus, label, values = {}) {
  return action(label, { ...shipments, record: shipment.id }, focus, { kind: 'shipment', id: shipment.id, version: shipment.version, ...values });
}
function question(task, field, prompt, options) {
  return { id: `${task.id}:${field}`, field, prompt, type: options ? 'choice' : 'text', ...(options ? { options } : null) };
}
function at(task, data, status, step, message, details = {}) {
  return { ...task, status, step, data: { ...data, progress: { message, ...details } } };
}
function waitFor(task, data, step, message, field, prompt, { options, ...details } = {}) {
  return at(task, data, 'waiting_input', step, message, { ...details, question: question(task, field, prompt, options) });
}
function cleanClaim(value, field) {
  const normalized = text(value, field, 120, true);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) fail(`${field}: escribe un dato de una sola línea.`, 422);
  return normalized;
}
function available(order) {
  const replaced = new Set(order.shipments.map(shipment => shipment.replacesShipmentId).filter(Boolean));
  const assigned = new Map();
  for (const shipment of order.shipments) {
    if (shipment.status === 'cancelled' || replaced.has(shipment.id)) continue;
    for (const item of shipment.assignments || []) assigned.set(item.lineId, (assigned.get(item.lineId) || 0) + item.quantity);
  }
  return order.items.map(item => ({ id: item.lineId, title: item.title, quantity: Math.max(0, item.quantity - (assigned.get(item.lineId) || 0)) }));
}
async function matchShipments(tx, carrier, tracking) {
  const rows = await tx.db.all(`SELECT id,order_id AS "orderId",carrier,tracking,status,version,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM ${tx.t('shipments')} WHERE tracking=? ORDER BY created_at,id`, [tracking]);
  return rows.filter(row => row.carrier && carrierKey(row.carrier) === carrierKey(carrier));
}
function proofFor(data, shipment, label, target) {
  const proof = data.proof;
  const valid = proof?.entityId === shipment.id && proof.target === target && proof.recordVersion <= shipment.version;
  return { label, kind: valid ? 'receipt' : 'record', entityId: shipment.id, recordVersion: valid ? proof.recordVersion : shipment.version,
    committedAt: valid ? proof.committedAt : shipment.updatedAt };
}

// The only evidence used here comes from versioned, native business records.
// The operator's answers identify intended facts; they are never proof of a save.
export async function resolveAdvisorStep(tx, session, task, options) {
  if (task.capabilityId === RESOLVE_IMPORT) return resolveAdvisorImport(tx, session, task);
  if (task.status === 'cancelled') return task;
  if (task.capabilityId === FOLLOW_RECOMMENDATION) return resolveAdvisorFollowUp(tx, session, task, options);
  if (task.capabilityId === CLOSE_CASH) return resolveAdvisorCash(tx, session, task);
  if (task.capabilityId !== SHIP_ORDER) return task;
  const data = { ...task.data, shipment: { ...task.data.shipment } };
  if (data.proposal) {
    const proposal = await tx.db.get(`SELECT state FROM ${tx.t('assistant_proposals')} WHERE id=? AND user_id=?`, [data.proposal.id, session.user.id]);
    if (!['prepared', 'applied'].includes(proposal?.state)) delete data.proposal;
  }
  const state = data.shipment;
  if (!state.orderId && data.sourceRef?.kind === 'order') state.orderId = data.sourceRef.id;
  if (!state.orderId) return waitFor(task, data, 'pick-order', 'Primero identifiquemos el pedido. No se ha creado ni vinculado una guía.', 'orderNumber', '¿Cuál es el número AN del pedido?', {
    action: action('Abrir el formulario de un pedido nuevo', { ...orders, record: 'new' }, 'order-create'),
  });
  const order = await getOrder(tx, state.orderId, { history: Boolean(state.observedEvent) });
  if (!order) return at(task, data, 'blocked', 'missing-order', 'El pedido ya no está disponible. No se modificó ningún envío.', {
    action: action('Buscar en pedidos', orders, 'order-search'),
  });
  const lines = available(order);
  const known = [{ label: 'Pedido', value: orderNumber(order) }, ...lines.slice(0, 12).map(line => ({ label: line.title || 'Artículo', value: `${line.quantity} por asignar` }))];
  if (lines.length > 12) known.push({ label: 'Líneas adicionales', value: `${lines.length - 12} en el pedido` });
  if (order.shipments.length) known.push({ label: 'Guías ya ligadas', value: order.shipments.slice(0, 8).map(shipment => shipment.tracking || 'Sin número').join(', ') });
  if (state.tracking) known.push({ label: 'Guía elegida', value: state.tracking });
  if (state.carrier) known.push({ label: 'Transportadora', value: state.carrier });
  const compare = orderAction(order, 'order-compare', 'Abrir pedido y comparar');
  if (order.status === 'cancelled') return at(task, data, 'blocked', 'cancelled-order', 'El pedido está cancelado. No se puede vincular otra guía.', { known, action: compare });

  if (state.eventStatus && !state.observedEvent) return waitFor(task, data, 'ask-event-date', 'Ya tengo el estado que observaste. Falta la fecha del hecho, no la de hoy por defecto.', 'eventDate', '¿Qué fecha observaste? Usa AAAA-MM-DD.', { known });
  if (state.askEvent && !state.eventStatus) return waitFor(task, data, 'ask-event-status', 'Solo se registra un hecho que observaste. Elige el estado; abrir el control no lo guarda.', 'eventStatus', '¿Qué estado observaste?', {
    known, options: [{ id: 'none', label: 'No registrar evento' }, ...eventOptions],
  });
  const matches = state.carrier && state.tracking ? await matchShipments(tx, state.carrier, state.tracking) : [];
  const pinned = state.shipmentId ? matches.find(item => item.id === state.shipmentId) : null;
  const linked = pinned?.orderId === order.id ? pinned : !state.shipmentId && matches.length === 1 && matches[0].orderId === order.id ? matches[0] : null;
  if (linked && linked.status !== 'cancelled') {
    state.shipmentId = linked.id;
    state.shipmentVersion = linked.version;
    if (state.observedEvent) {
      const requested = state.observedEvent;
      const shipment = order.shipments.find(item => item.id === linked.id);
      const recorded = effectiveShipmentEvents(shipment?.events || []).some(event => event.status === requested.status && event.occurredOn === requested.occurredOn && event.recordedAt >= task.createdAt);
      if (!recorded) return at(task, data, 'waiting_human', 'review-event', 'La guía ya consta vinculada. Revisa el hecho observado en el control de eventos; no se ha registrado por abrirlo.', {
        known, action: shipmentAction(linked, 'shipment-event', 'Revisar evento observado'),
      });
      return at(task, data, 'completed', 'done', 'El pedido tiene la guía vinculada y consta el evento que pediste registrar.', {
        known, proof: proofFor(data, linked, 'Vínculo y evento verificados', 'shipment-event'), action: shipmentAction(linked, 'shipment-detail', 'Ver envío guardado'),
      });
    }
    const target = data.proof?.target === 'business-action:link-shipment' ? 'business-action:link-shipment' : 'shipment-create';
    const proof = proofFor(data, linked, 'Guía vinculada al pedido', target);
    return at(task, data, 'completed', 'done', proof.kind === 'receipt' ? 'La guía quedó vinculada al pedido. Conservé el comprobante.' : 'Esta guía ya consta vinculada al pedido. No volví a guardarla.', {
      known, proof, action: shipmentAction(linked, 'shipment-detail', 'Ver envío guardado'),
    });
  }
  if (task.status === 'completed') return at(task, data, 'blocked', 'proof-changed', 'El vínculo que constaba ya no se puede comprobar. Revisa el pedido antes de continuar.', { known, action: compare });
  if (state.orderVersion && order.version !== state.orderVersion) {
    delete data.proposal;
    return waitFor(task, data, 'compare-order', 'El pedido cambió desde la revisión anterior. Conservé la guía que indicaste, no la asignación anterior.', 'reviewOrder', '¿Ya revisaste la versión actual del pedido?', {
      known, action: compare, options: [{ id: String(order.version), label: 'Sí, usar esta versión del pedido' }, { id: 'change-order', label: 'Corregir el pedido' }],
    });
  }
  state.orderVersion = order.version;
  if (!state.tracking) return waitFor(task, data, 'ask-tracking', 'Ya tengo el pedido. Ahora necesito identificar la guía, sin registrar aún un envío.', 'tracking', '¿Cuál es el número de la guía?', { known });
  if (!state.carrier) return waitFor(task, data, 'ask-carrier', 'Ya tengo el pedido y el número de guía. Falta saber qué transportadora la emitió.', 'carrier', '¿Cuál es la transportadora?', { known });
  if (matches.length > 1 && !pinned) return waitFor(task, data, 'pick-shipment', 'Hay más de una ficha con ese número y transportadora. Elige la ficha exacta.', 'shipmentId', '¿Qué ficha de envío corresponde?', {
    known, options: matches.slice(0, 20).map(item => ({ id: item.id, label: `${item.tracking} · ${item.createdAt.slice(0, 10)} · ${item.id.slice(0, 8)}` })),
  });
  const shipment = pinned || matches[0];
  if (shipment?.orderId || shipment?.status === 'cancelled' || state.shipmentId && !shipment) {
    delete data.proposal;
    return at(task, data, 'blocked', 'shipment-conflict', shipment?.orderId ? 'La guía ya corresponde a otro pedido. No se puede reasignar.' : 'La guía seleccionada ya no está disponible para vincular.', { known, action: compare });
  }
  if (!lines.some(line => line.quantity > 0)) return at(task, data, 'blocked', 'no-quantity', 'No quedan unidades elegibles para otra guía. Revisa las asignaciones del pedido.', { known, action: compare });
  const optional = { editTracking: question(task, 'tracking', 'Corregir el número de guía'), editCarrier: question(task, 'carrier', 'Corregir la transportadora'),
    ...(state.observedEvent ? null : { observe: question(task, 'askEvent', 'Agregar un evento observado', [{ id: 'yes', label: 'Registrar un hecho que observé' }]) }) };
  if (shipment) {
    if (state.shipmentVersion && state.shipmentVersion !== shipment.version) {
      delete data.proposal;
      return waitFor(task, data, 'compare-shipment', 'La guía cambió mientras la revisabas. No se utilizará la versión anterior.', 'reviewShipment', '¿Ya revisaste la versión actual de la guía?', {
        known, action: shipmentAction(shipment, 'shipment-detail', 'Abrir envío y comparar'), options: [{ id: String(shipment.version), label: 'Sí, usar esta versión de la guía' }],
      });
    }
    state.shipmentId = shipment.id;
    state.shipmentVersion = shipment.version;
    return at(task, data, 'waiting_human', 'review-link', 'La guía ya existe sin pedido. Revisa las cantidades y confirma el vínculo en el formulario.', {
      known, ...optional, action: shipmentAction(shipment, 'shipment-link-order', 'Revisar vínculo con el pedido', { orderId: order.id, orderVersion: order.version }),
    });
  }
  return at(task, data, 'waiting_human', 'review-create', 'No hay una ficha guardada para esa guía. Revisa el envío nuevo y las cantidades antes de confirmar.', {
    known, ...optional, action: orderAction(order, 'order-shipment-create', 'Revisar envío en el pedido', { tracking: state.tracking, carrier: state.carrier }),
  });
}

export async function answerAdvisorStep(tx, session, task, input) {
  const current = await resolveAdvisorStep(tx, session, task);
  const { progress } = current.data;
  const pending = [progress?.question, progress?.editTracking, progress?.editCarrier, progress?.observe].find(item => item && item.id === input.questionId && item.field === input.field);
  if (current.step !== input.step || !pending) fail('La pregunta o el paso cambiaron. Revisa la tarea guardada.', 409);
  const value = cleanClaim(input.value, 'Respuesta');
  if (pending.options && !pending.options.some(item => item.id === value)) {
    fail('La opción no corresponde a la pregunta vigente. Vuelve a consultar la tarea.', current.capabilityId === RESOLVE_IMPORT ? 409 : 422);
  }
  if (current.capabilityId === CLOSE_CASH) return answerAdvisorCash(tx, session, current, { ...input, value });
  if (current.capabilityId === RESOLVE_IMPORT) return answerAdvisorImport(tx, session, current, { ...input, value });
  const data = { ...current.data, shipment: { ...current.data.shipment } }, state = data.shipment;
  switch (input.field) {
    case 'orderNumber': {
      const match = /^(?:AN-)?([0-9]{1,12})$/i.exec(value), number = match && Number(match[1]);
      if (!number) fail('Escribe el número exacto del pedido, por ejemplo AN-000123.', 422);
      const order = await tx.db.get(`SELECT id FROM ${tx.t('orders')} WHERE number=?`, [number]);
      if (!order) fail('No encontré ese número. Revísalo o abre el formulario de un pedido nuevo.', 404);
      state.orderId = order.id;
      data.sourceRef = { kind: 'order', id: order.id };
      break;
    }
    case 'tracking':
    case 'carrier':
      if (state[input.field] !== value) {
        delete state.shipmentId;
        delete state.shipmentVersion;
        delete data.proposal;
      }
      state[input.field] = value;
      break;
    case 'shipmentId': state.shipmentId = value; break;
    case 'reviewOrder':
      if (value === 'change-order') {
        delete data.sourceRef;
        data.shipment = {};
      } else state.orderVersion = Number(value);
      delete data.proposal;
      break;
    case 'reviewShipment': state.shipmentVersion = Number(value); delete data.proposal; break;
    case 'askEvent': state.askEvent = true; delete data.proposal; break;
    case 'eventStatus':
      if (value === 'none') { delete state.askEvent; delete state.eventStatus; }
      else state.eventStatus = value;
      break;
    case 'eventDate':
      state.observedEvent = { status: state.eventStatus, occurredOn: businessDate(value, 'Fecha del evento') };
      delete state.askEvent;
      delete state.eventStatus;
      break;
    default: fail('Respuesta no válida para esta tarea.', 422);
  }
  return resolveAdvisorStep(tx, session, { ...current, data });
}

export function advisorTaskStorage({ capabilityId, data }) {
  if (!data.progress) return data;
  const { progress: { known, ...progress }, ...stored } = data;
  return { ...stored, progress: capabilityId === SHIP_ORDER ? progress : { message: progress.message } };
}

export function canAdvanceAdvisorTask(task) {
  return GUIDED.has(task.capabilityId) && !CLOSED.has(task.status);
}
