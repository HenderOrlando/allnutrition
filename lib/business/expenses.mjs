import { fail, text, integer } from '../validation-core.mjs';
import { businessDate, bogotaDate, instant } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { entity, runCommand, insertRow, updateVersioned, audit, bumpRevision, newId, stamp, hash } from './commands.mjs';
import { postCashEntryTx, reverseLinkedCashTx } from './cash.mjs';
import { effectiveShipmentEvents } from './shipments.mjs';

const CATEGORIES = ['shipping_out','shipping_return','platform_fee','commission','salary','bonus','other'];
const LOGISTICS = ['shipping_out','shipping_return','platform_fee'];
const expenseDataKeys = ['id','category','amountMinor','incurredOn','personId','orderId','shipmentId','sourceKey','version','recordedAt','createdAt','updatedAt','paidMinor','offsetMinor','outstandingMinor','creditMinor'];
const metadata = row => Object.fromEntries(Object.entries(row).filter(([key]) => !expenseDataKeys.includes(key)));
const signed = value => moneyMinor(value, 'Importe', { signed:true });
const rowById = async (tx, table, id) => entity(await tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`, [id]));

export async function expenseBalanceTx(tx, expenseId) {
  const expense = await rowById(tx, 'expenses', expenseId);
  if (!expense) fail('Gasto no encontrado.', 404);
  const payments = await tx.db.all(`SELECT amount_minor FROM ${tx.t('expense_payments')} WHERE expense_id=?`, [expenseId]);
  const offsets = await tx.db.all(`SELECT o.* FROM ${tx.t('payroll_offsets')} o WHERE (o.debit_expense_id=? OR o.credit_expense_id=?) AND o.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ${tx.t('payroll_offsets')} r WHERE r.reversal_of=o.id)`, [expenseId, expenseId]);
  const paidMinor = signed(Number(payments.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n)));
  const offsetMinor = signed(Number(offsets.reduce((sum, row) => sum + BigInt(row.debit_expense_id === expenseId ? row.amount_minor : -row.amount_minor), 0n)));
  const remaining = signed(expense.amountMinor - paidMinor - offsetMinor);
  return { paidMinor, offsetMinor, outstandingMinor:Math.max(0, remaining), creditMinor:Math.max(0, -remaining) };
}

async function expenseDetail(tx, id) { return { ...await rowById(tx, 'expenses', id), ...await expenseBalanceTx(tx, id) }; }

async function logisticsDate(tx, input, shipment, order, old) {
  const originalDate = Object.hasOwn(input, 'incurredOn') ? businessDate(input.incurredOn, 'Fecha del cargo', { nullable:true }) : old && Object.hasOwn(old, 'chargeOn') ? old.chargeOn : old?.incurredOn ?? null;
  const rule = order?.ruleSnapshot;
  const dateSource = old?.dateSource || (input.category === 'shipping_out' ? rule?.shippingExpenseDate : input.category === 'shipping_return' ? rule?.returnExpenseDate : rule?.platformFeeExpenseDate) || 'charge_date';
  if (dateSource === 'charge_date') return { incurredOn:originalDate, chargeOn:originalDate, dateSource };
  if (dateSource === 'settlement_date') {
    const payments = await tx.db.all(`SELECT r.received_on FROM ${tx.t('expense_payments')} p JOIN ${tx.t('settlement_receipts')} r ON r.id=p.settlement_receipt_id WHERE p.expense_id=? AND p.amount_minor>0 AND p.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ${tx.t('expense_payments')} x WHERE x.reversal_of=p.id) AND r.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ${tx.t('settlement_receipts')} x WHERE x.reversal_of=r.id) ORDER BY r.received_on,r.id`, [old?.id || '']);
    return { incurredOn:payments[0]?.received_on || null, chargeOn:originalDate, dateSource };
  }
  const events = shipment ? effectiveShipmentEvents((await tx.db.all(`SELECT * FROM ${tx.t('shipment_events')} WHERE shipment_id=?`, [shipment.id])).map(entity)) : [];
  const dates = events.filter(event => event.status === (dateSource === 'dispatch_date' ? 'collected' : 'returned')).map(event => event.occurredOn || (event.occurredAt ? bogotaDate(event.occurredAt) : null)).filter(Boolean).sort();
  return { incurredOn:dates[0] || null, chargeOn:originalDate, dateSource };
}

async function markShipmentCost(tx, shipment, category, known, actorId, reason, observation) {
  if (!shipment || !LOGISTICS.includes(category)) return;
  const previous = await rowById(tx, 'shipments', shipment.id);
  const data = JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('shipments')} WHERE id=?`, [shipment.id])).data);
  const costStatuses = { ...(data.costStatuses || {}), [category]:known ? 'known' : 'unknown' };
  const costObservations = { ...(data.costObservations || {}), [category]:observation };
  // The outbound charge is required; other concepts only become required when observed.
  const costStatus = costStatuses.shipping_out === 'known' && Object.values(costStatuses).every(value => value === 'known') ? 'known' : 'unknown';
  if (hash(data.costStatuses || {}) === hash(costStatuses) && data.costStatus === costStatus && hash(data.costObservations || {}) === hash(costObservations)) return;
  await updateVersioned(tx, 'shipments', shipment.id, previous.version, { data:JSON.stringify({ ...data, costStatuses, costStatus, costObservations }) });
  await audit(tx, { entityType:'shipment', entityId:shipment.id, actorId, previous, next:await rowById(tx, 'shipments', shipment.id), reason, source:'expense' });
  await bumpRevision(tx);
}

export async function recordExpenseTx(tx, input, actorId, { internal = false } = {}) {
  const expenseId = input.id || input.expenseId;
  let old = expenseId ? await rowById(tx, 'expenses', expenseId) : null;
  if (expenseId && !old) fail('Gasto no encontrado.', 404);
  const category = input.category || old?.category;
  if (!CATEGORIES.includes(category) || (!internal && ['salary','commission','bonus'].includes(category))) fail('Esta categoría se registra desde sueldos y comisiones.');
  const shipmentId = input.shipmentId ?? old?.shipmentId ?? null;
  const shipment = shipmentId ? await rowById(tx, 'shipments', shipmentId) : null;
  if (shipmentId && !shipment) fail('Envío no encontrado.', 404);
  const orderId = input.orderId ?? old?.orderId ?? shipment?.orderId ?? null;
  const orderRow = orderId ? await tx.db.get(`SELECT * FROM ${tx.t('orders')} WHERE id=?`, [orderId]) : null;
  if (orderId && !orderRow) fail('Pedido no encontrado.', 404);
  if (shipment?.orderId && orderId !== shipment.orderId) fail('El gasto y el envío pertenecen a pedidos distintos.', 409);
  const order = orderRow ? { ...JSON.parse(orderRow.data), id:orderRow.id } : null;
  const personId = input.personId ?? old?.personId ?? null;
  if (personId && !await rowById(tx, 'people', personId)) fail('Persona no encontrada.', 404);
  const sourceKey = text(input.sourceKey ?? old?.sourceKey ?? (shipment && LOGISTICS.includes(category) ? `${shipment.id}:${category}` : ''), 'Identidad del gasto', 300) || null;
  if (sourceKey) {
    const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE source_key=?`, [sourceKey]));
    if (existing && old && existing.id !== old.id) fail('Ese concepto ya está registrado.', 409);
    old = old || existing;
  }
  if (old && (old.category !== category || old.shipmentId !== shipmentId || old.orderId !== orderId || old.personId !== personId || old.sourceKey !== sourceKey)) fail('No se puede cambiar la identidad de un gasto registrado.', 409);
  if (expenseId) {
    integer(input.version, 'Versión del gasto', 1);
    if (input.version !== old.version) fail('El gasto cambió. Recarga antes de corregir.', 409);
  }
  const amountMinor = input.amountMinor == null ? null : moneyMinor(input.amountMinor, 'Gasto', { signed:internal });
  if (amountMinor != null && amountMinor < 0 && (!sourceKey || !input.originalExpenseId || !await rowById(tx, 'expenses', input.originalExpenseId))) fail('El ajuste requiere gasto de origen.');
  const source = text(input.source ?? old?.source ?? 'manual', 'Fuente', 100, true);
  const sourceId = input.sourceId ?? old?.sourceId ?? shipment?.sourceId ?? null;
  if (sourceId && !await rowById(tx, 'platform_sources', sourceId)) fail('Fuente no encontrada.', 404);
  if (shipment?.sourceId && sourceId !== shipment.sourceId) fail('La fuente no corresponde al envío.', 409);
  const sourceAsOf = input.sourceAsOf == null ? null : instant(input.sourceAsOf, 'Fecha de corte');
  if (source !== 'manual' && !sourceAsOf) fail('El costo importado requiere fecha de corte.');
  const reason = text(input.reason, 'Motivo', 1000);
  const dates = LOGISTICS.includes(category) ? await logisticsDate(tx, { ...input, category }, shipment, order, old) : { incurredOn:Object.hasOwn(input, 'incurredOn') ? businessDate(input.incurredOn, 'Fecha del gasto', { nullable:true }) : old?.incurredOn ?? null, dateSource:'charge_date' };
  const snapshot = { amountMinor, chargeOn:Object.hasOwn(dates, 'chargeOn') ? dates.chargeOn : dates.incurredOn };
  const observation = { ...snapshot, source, sourceId, sourceAsOf };
  const priorObservation = shipment?.costObservations?.[category];
  if (!old && priorObservation) {
    if (source === priorObservation.source && sourceId === priorObservation.sourceId && sourceAsOf && priorObservation.sourceAsOf && sourceAsOf < priorObservation.sourceAsOf) {
      await audit(tx, { entityType:'expense_observation', entityId:shipment.id, actorId, previous:priorObservation, next:observation, reason:'Observación anterior sin sustituir costo', source });
      return { id:null, category, shipmentId, orderId, amountMinor:null, costStatus:'unknown', observationIgnored:true };
    }
    const conflictingCut = sourceAsOf && sourceAsOf === priorObservation.sourceAsOf && hash(snapshot) !== hash({ amountMinor:priorObservation.amountMinor, chargeOn:priorObservation.chargeOn });
    if ((source !== priorObservation.source || sourceId !== priorObservation.sourceId || conflictingCut) && (!reason || input.reviewConfirmed !== true)) fail('Revisa y confirma la autoridad del costo previamente observado.', 409);
  }
  const previousSnapshot = old ? { amountMinor:old.amountMinor, chargeOn:Object.hasOwn(old, 'chargeOn') ? old.chargeOn : old.incurredOn } : null;
  if (old && source === old.source && sourceId === (old.sourceId ?? shipment?.sourceId ?? null) && sourceAsOf && old.sourceAsOf && sourceAsOf < old.sourceAsOf) {
    await audit(tx, { entityType:'expense_observation', entityId:old.id, actorId, previous:previousSnapshot, next:{ ...snapshot, sourceAsOf }, reason:'Observación anterior sin sustituir costo', source });
    return { ...await expenseDetail(tx, old.id), observationIgnored:true };
  }
  if (old && hash(snapshot) === hash(previousSnapshot) && source === (old.source || 'manual') && sourceId === (old.sourceId ?? shipment?.sourceId ?? null) && dates.incurredOn === old.incurredOn && (!sourceAsOf || sourceAsOf === old.sourceAsOf) && (input.concept == null || input.concept === old.concept) && (input.supplier == null || input.supplier === old.supplier) && !input.accountId) return expenseDetail(tx, old.id);
  if (old) {
    integer(input.version, 'Versión del gasto', 1);
    if (input.version !== old.version) fail('El gasto cambió. Recarga antes de corregir.', 409);
    if (!reason) fail('La corrección requiere motivo.');
    const conflict = source !== (old.source || 'manual') || sourceId !== (old.sourceId ?? shipment?.sourceId ?? null) || (sourceAsOf && sourceAsOf === old.sourceAsOf && hash(snapshot) !== hash(previousSnapshot));
    if (conflict && input.reviewConfirmed !== true) fail('La fuente o el corte discrepa. Revisa y confirma explícitamente la corrección.', 409);
  }
  if (amountMinor === null) {
    if (!shipment || !LOGISTICS.includes(category)) fail('Registra un importe de gasto explícito; solo costos logísticos pueden quedar desconocidos.');
    if (old) fail('Un costo conocido no se borra con una observación vacía.', 409);
    await markShipmentCost(tx, shipment, category, false, actorId, reason || 'Costo desconocido', observation);
    return { id:null, category, shipmentId, orderId, amountMinor:null, incurredOn:dates.incurredOn, costStatus:'unknown' };
  }
  const id = old?.id || newId(), now = stamp();
  const data = { ...(old ? metadata(old) : {}), concept:text(input.concept ?? old?.concept, 'Concepto', 500), supplier:text(input.supplier ?? old?.supplier, 'Proveedor', 200), ...dates, source, sourceId, sourceAsOf, originalExpenseId:input.originalExpenseId ?? old?.originalExpenseId ?? null };
  delete data.incurredOn;
  const fields = { category, amount_minor:amountMinor, incurred_on:dates.incurredOn, person_id:personId, order_id:orderId, shipment_id:shipmentId, source_key:sourceKey, data:JSON.stringify(data) };
  if (old) await updateVersioned(tx, 'expenses', id, input.version, fields);
  else await insertRow(tx, 'expenses', { id, ...fields, version:1, recorded_at:now, created_at:now, updated_at:now });
  await markShipmentCost(tx, shipment, category, true, actorId, reason || 'Costo informado', observation);
  await audit(tx, { entityType:'expense', entityId:id, actorId, previous:old, next:await rowById(tx, 'expenses', id), reason:reason || 'Registrar gasto', source });
  await bumpRevision(tx, [old?.incurredOn, dates.incurredOn]);
  const payable = (await expenseBalanceTx(tx, id)).outstandingMinor;
  if (input.accountId && input.payImmediately !== false && payable > 0) await payExpenseTx(tx, { expenseId:id, amountMinor:payable, accountId:input.accountId, effectiveOn:input.effectiveOn, reference:input.reference, concept:input.concept }, actorId);
  return expenseDetail(tx, id);
}

export async function payExpenseTx(tx, input, actorId) {
  const expense = await rowById(tx, 'expenses', input.expenseId);
  if (!expense) fail('Gasto no encontrado.', 404);
  if (input.version != null && input.version !== expense.version) fail('El gasto cambió. Recarga antes de pagar.', 409);
  if (['salary','commission','bonus'].includes(expense.category)) fail('Paga esta obligación desde sueldos.');
  const amountMinor = moneyMinor(input.amountMinor, 'Pago');
  if (!amountMinor || amountMinor > (await expenseBalanceTx(tx, expense.id)).outstandingMinor) fail('El pago supera el saldo pendiente.', 409);
  const id = newId();
  const cash = await postCashEntryTx(tx, { accountId:input.accountId, effectiveOn:input.effectiveOn, amountMinor:-amountMinor, kind:'expense_payment', sourceType:'expense_payment', sourceId:id, data:{ expenseId:expense.id, concept:text(input.concept || expense.concept || 'Pago de gasto', 'Concepto', 500), reference:text(input.reference, 'Referencia', 300) } }, actorId);
  await insertRow(tx, 'expense_payments', { id, expense_id:expense.id, kind:'payment', cash_entry_id:cash.id, settlement_receipt_id:null, amount_minor:amountMinor, reversal_of:null, recorded_at:stamp(), data:JSON.stringify({ effectiveOn:cash.effectiveOn }) });
  await audit(tx, { entityType:'expense_payment', entityId:id, actorId, next:{ expenseId:expense.id, amountMinor, cashEntryId:cash.id } });
  await bumpRevision(tx, [cash.effectiveOn]);
  return { payment:await rowById(tx, 'expense_payments', id), expense:await expenseDetail(tx, expense.id) };
}

export async function recordExpenseRecoveryTx(tx, input, actorId) {
  const expense = await rowById(tx, 'expenses', input.expenseId);
  if (!expense) fail('Gasto no encontrado.', 404);
  if (input.version != null && input.version !== expense.version) fail('El gasto cambió. Recarga antes de recuperar el crédito.', 409);
  if (expense.amountMinor < 0 || ['salary','commission','bonus'].includes(expense.category)) fail('Este crédito se concilia desde sueldos.');
  const amountMinor = moneyMinor(input.amountMinor, 'Recuperación');
  const reason = text(input.reason, 'Motivo', 1000, true);
  if (!amountMinor || amountMinor > (await expenseBalanceTx(tx, expense.id)).creditMinor) fail('La recuperación supera el crédito disponible.', 409);
  const id = newId();
  const cash = await postCashEntryTx(tx, { accountId:input.accountId, effectiveOn:input.effectiveOn, amountMinor, kind:'recovery', sourceType:'expense_payment', sourceId:id, data:{ expenseId:expense.id, reason, reference:text(input.reference, 'Referencia', 300), concept:'Recuperación de sobrepago' } }, actorId);
  await insertRow(tx, 'expense_payments', { id, expense_id:expense.id, kind:'recovery', cash_entry_id:cash.id, settlement_receipt_id:null, amount_minor:-amountMinor, reversal_of:null, recorded_at:stamp(), data:JSON.stringify({ reason, effectiveOn:cash.effectiveOn }) });
  await audit(tx, { entityType:'expense_payment', entityId:id, actorId, next:{ expenseId:expense.id, amountMinor:-amountMinor, cashEntryId:cash.id }, reason });
  await bumpRevision(tx, [cash.effectiveOn]);
  return { payment:await rowById(tx, 'expense_payments', id), expense:await expenseDetail(tx, expense.id) };
}

export async function reverseExpensePaymentTx(tx, paymentId, { effectiveOn, reason, actorId }) {
  const payment = await rowById(tx, 'expense_payments', paymentId);
  if (!payment) fail('Pago no encontrado.', 404);
  reason = text(reason, 'Motivo', 1000, true);
  if (payment.reversalOf || await tx.db.get(`SELECT id FROM ${tx.t('expense_payments')} WHERE reversal_of=?`, [paymentId])) fail('El pago ya está reversado.', 409);
  if (payment.settlementReceiptId) fail(`Revierte primero el recibo de liquidación ${payment.settlementReceiptId}.`, 409);
  if (payment.payrollId || payment.payrollPaymentId || payment.advance) fail(`Revierte el pago de sueldo o anticipo ${payment.payrollPaymentId || payment.cashEntryId}.`, 409);
  const balance = await expenseBalanceTx(tx, payment.expenseId);
  if (payment.amountMinor > 0 && balance.paidMinor < payment.amountMinor) fail('Revierte primero las recuperaciones o compensaciones dependientes de este pago.', 409);
  const cash = await reverseLinkedCashTx(tx, payment.cashEntryId, effectiveOn, reason, actorId);
  const id = newId();
  await insertRow(tx, 'expense_payments', { id, expense_id:payment.expenseId, kind:'reversal', cash_entry_id:cash.id, settlement_receipt_id:null, amount_minor:-payment.amountMinor, reversal_of:payment.id, recorded_at:stamp(), data:JSON.stringify({ reason, effectiveOn:cash.effectiveOn }) });
  await audit(tx, { entityType:'expense_payment', entityId:id, actorId, previous:payment, next:await rowById(tx, 'expense_payments', id), reason });
  await bumpRevision(tx, [cash.effectiveOn]);
  return { payment:await rowById(tx, 'expense_payments', id), expense:await expenseDetail(tx, payment.expenseId) };
}

export const recordExpense = (store, input, actorId) => runCommand(store, { scope:'expense', requestId:input.requestId, payload:input, actorId }, tx => recordExpenseTx(tx, input, actorId));
export const payExpense = (store, input, actorId) => runCommand(store, { scope:'expense-payment', requestId:input.requestId, payload:input, actorId }, tx => payExpenseTx(tx, input, actorId));
export const recordExpenseRecovery = (store, input, actorId) => runCommand(store, { scope:'expense-recovery', requestId:input.requestId, payload:input, actorId }, tx => recordExpenseRecoveryTx(tx, input, actorId));
