import { fail, integer, text } from '../validation-core.mjs';
import { audit, bumpRevision, entity, hash, insertRow, newId, runCommand, stamp } from './commands.mjs';
import { moneyMinor, roundRatio } from './money.mjs';
import { bogotaDate, businessDate, instant } from './dates.mjs';
import { getOrder, loadOrderData, persistOrderData, resolveOrderRecognition } from './orders.mjs';
import { postCashEntryTx, reverseLinkedCashTx } from './cash.mjs';
import { reconcileCommissionsTx } from './payroll.mjs';

function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Datos financieros no válidos.');
  return input;
}
const opaque = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(`${label}: identificador no válido.`);
  return value;
};
const positive = (value, label = 'Importe') => {
  const amount = moneyMinor(value, label);
  if (!amount) fail(`${label}: debe ser mayor que cero.`);
  return amount;
};
function actualDate(value, label = 'Fecha') {
  const date = businessDate(value, label);
  if (date > bogotaDate()) fail(`${label}: no se permiten hechos confirmados futuros.`);
  return date;
}
async function checkedOrder(tx, input) {
  validInput(input);
  const order = await loadOrderData(tx, text(input.orderId, 'Pedido', 100, true));
  if (!order) fail('Pedido no encontrado.', 404);
  integer(input.version, 'Versión del pedido', 1);
  if (order.version !== input.version) fail('El pedido cambió en otra sesión. Recarga antes de guardar.', 409);
  return order;
}
async function touchOrder(tx, order, actorId, reason, source = 'manual') {
  return persistOrderData(tx, order, { actorId, reason, source });
}
async function identity(tx, input) {
  if (input.externalKey == null) return { externalKey: null, externalId: null, sourceId: input.sourceId || null };
  const externalId = opaque(input.externalKey, 'Referencia externa');
  const sourceId = opaque(input.sourceId, 'Fuente');
  if (!await tx.db.get(`SELECT id FROM ${tx.t('platform_sources')} WHERE id=?`, [sourceId])) fail('Fuente no encontrada.', 404);
  return { externalKey: `collection:${hash([sourceId, externalId])}`, externalId, sourceId };
}
async function collectionContext(tx, input, kind, { allowUnknownDate = false } = {}) {
  validInput(input);
  const id = await identity(tx, input);
  const holder = text(input.holder, 'Quién tiene el dinero', 20, true);
  if (!['business', 'platform'].includes(holder)) fail('El origen del dinero debe ser negocio o plataforma.');
  const amountMinor = positive(input.amountMinor);
  const undatedObservation = allowUnknownDate && input.occurredOn == null;
  const sourceAsOf = input.sourceAsOf == null ? null : instant(input.sourceAsOf, 'Corte de la fuente');
  if (undatedObservation && (kind !== 'receipt' || holder !== 'platform' || input.source !== 'excel' || !input.sourceId || !sourceAsOf)) fail('Un recaudo sin fecha exige una observación Excel de plataforma y su corte real.');
  const occurredOn = undatedObservation ? null : actualDate(input.occurredOn);
  const method = text(input.method, 'Método', 100, true);
  const reference = text(input.reference, 'Referencia', 200, true);
  const reason = kind === 'refund' ? text(input.reason, 'Motivo del reembolso', 1000, true) : text(input.reason || '', 'Motivo', 1000);
  let shipment = null;
  if (input.shipmentId) {
    shipment = entity(await tx.db.get(`SELECT * FROM ${tx.t('shipments')} WHERE id=?`, [text(input.shipmentId, 'Envío', 100, true)]));
    if (!shipment || shipment.orderId !== input.orderId) fail('El envío no pertenece al pedido.');
  }
  if (holder === 'platform' && (!shipment || !shipment.platformId)) fail('Un recaudo de plataforma requiere envío y plataforma identificados.');
  if (input.platformId && input.platformId !== shipment?.platformId) fail('La plataforma no corresponde al envío.');
  const sourceId = id.sourceId || shipment?.sourceId || null;
  if (sourceId && shipment && sourceId !== shipment.sourceId) fail('La fuente no corresponde al envío.');
  if (sourceId && !await tx.db.get(`SELECT id FROM ${tx.t('platform_sources')} WHERE id=?`, [sourceId])) fail('Fuente no encontrada.', 404);
  const accountId = holder === 'business' ? text(input.accountId, 'Cuenta', 100, true) : null;
  if (holder === 'platform' && input.accountId) fail('Un recaudo de plataforma no genera movimiento bancario.');
  const data = { method, reference, reason, source: input.source || 'manual', sourceId, platformId: shipment?.platformId || null, externalId: id.externalId, allowCredit: input.allowCredit === true };
  const signature = hash({ orderId: input.orderId, kind, holder, amountMinor, occurredOn, shipmentId: shipment?.id || null, accountId, ...data });
  if (id.externalKey) {
    const prior = entity(await tx.db.get(`SELECT * FROM ${tx.t('order_collections')} WHERE external_key=?`, [id.externalKey]));
    if (prior) {
      if (prior.identityHash !== signature) fail('La referencia externa ya existe con otros datos. Revisa el documento original.', 409);
      return { prior };
    }
  }
  return { externalKey: id.externalKey, holder, amountMinor, occurredOn, accountId, shipmentId: shipment?.id || null, data: { ...data, identityHash: signature, ...(sourceAsOf ? { sourceAsOf } : {}), ...(undatedObservation ? { requiresDateReview: true } : {}) } };
}
async function appendCollection(tx, { orderId, kind, holder, amountMinor, occurredOn, accountId = null, shipmentId = null, externalKey = null, data = {}, cash = true }, actorId) {
  const id = newId();
  let cashEntry = null;
  if (holder === 'business' && cash) cashEntry = await postCashEntryTx(tx, { accountId, effectiveOn: occurredOn, amountMinor: kind === 'refund' ? -amountMinor : amountMinor, kind: kind === 'refund' ? 'refund' : 'collection', sourceType: kind === 'refund' ? 'refund' : 'collection', sourceId: id, data: { ...data, orderId } }, actorId);
  const row = { id, order_id: orderId, shipment_id: shipmentId, kind, holder, amount_minor: amountMinor, occurred_on: occurredOn, cash_entry_id: cashEntry?.id || null, reversal_of: null, external_key: externalKey, recorded_at: stamp(), data: JSON.stringify({ ...data, actorId }) };
  await insertRow(tx, 'order_collections', row);
  const document = entity(row);
  await audit(tx, { entityType: kind === 'refund' ? 'refund' : 'collection', entityId: id, actorId, next: document, reason: data.reason, source: data.source || 'manual' });
  await bumpRevision(tx, [occurredOn]);
  return document;
}
function platformAvailable(order, sourceId, platformId) {
  const reversed = new Set(order.collections.filter(row => row.reversalOf).map(row => row.reversalOf));
  const shipments = new Map(order.shipments.map(row => [row.id, row]));
  const pool = order.collections.filter(row => {
    if (row.holder !== 'platform' || row.reversalOf || reversed.has(row.id)) return false;
    const shipment = shipments.get(row.shipmentId);
    const rowSourceId = row.sourceId || shipment?.sourceId || null;
    return sourceId ? rowSourceId === sourceId : !rowSourceId && (row.platformId || shipment?.platformId) === platformId;
  });
  const ids = new Set(pool.map(row => row.id));
  const reversedReceipts = new Set(order.settlementReceipts.filter(row => row.reversalOf).map(row => row.reversalOf));
  const settled = order.settlementReceipts.filter(row => !row.reversalOf && !reversedReceipts.has(row.id)).reduce((sum, row) => sum + (row.lines || []).filter(line => ids.has(line.collectionId)).reduce((gross, line) => gross + line.grossMinor, 0), 0);
  return pool.reduce((sum, row) => sum + (row.kind === 'refund' ? -row.amountMinor : row.amountMinor), 0) - settled;
}
async function recordMoneyTx(tx, input, actorId, kind, options) {
  // Stable external facts may be retried with a new command key and the original order version.
  const context = await collectionContext(tx, input, kind, options);
  if (context.prior) return { ...context.prior, order: await getOrder(tx, context.prior.orderId) };
  const order = await checkedOrder(tx, input);
  const current = await getOrder(tx, order.id, { history: false });
  if (current.paymentSummary.legacyReview) fail('Concilia primero el pago histórico del pedido.', 409);
  if (kind === 'receipt' && context.amountMinor > current.paymentSummary.outstandingMinor && input.allowCredit !== true) fail('El cobro supera el saldo del cliente. Confirma explícitamente el saldo a favor.');
  if (kind === 'refund') {
    if (context.amountMinor > current.paymentSummary.netCollectedMinor) fail('El reembolso supera lo efectivamente cobrado.');
    if (context.holder === 'platform' && context.amountMinor > platformAvailable(current, context.data.sourceId, context.data.platformId)) fail('La plataforma ya entregó esos fondos. Registra el reembolso desde una cuenta del negocio.', 409);
  }
  const document = await appendCollection(tx, { ...context, orderId: order.id, kind }, actorId);
  await touchOrder(tx, order, actorId, context.data.reason || (kind === 'refund' ? 'Reembolso registrado' : 'Cobro registrado'), context.data.source);
  await reconcileCommissionsTx(tx, order.id, { actorId, adjustmentOn: context.occurredOn, reason: context.data.reason });
  return { ...document, order: await getOrder(tx, order.id) };
}
export const recordCollectionTx = (tx, input, actorId, options) => recordMoneyTx(tx, input, actorId, 'receipt', options);
export const recordRefundTx = (tx, input, actorId) => recordMoneyTx(tx, input, actorId, 'refund');
const command = (store, scope, input, actorId, fn) => runCommand(store, { scope, requestId: validInput(input).requestId, payload: input, actorId }, tx => fn(tx, input, actorId));
export const recordCollection = (store, input, actorId) => command(store, 'finance:collection', input, actorId, recordCollectionTx);
export const recordRefund = (store, input, actorId) => command(store, 'finance:refund', input, actorId, recordRefundTx);

export async function registerReturnTx(tx, input, actorId) {
  const order = await checkedOrder(tx, input);
  if (order.status === 'cancelled') fail('Un pedido cancelado ya tiene su crédito comercial.', 409);
  const occurredOn = actualDate(input.occurredOn);
  const reason = text(input.reason, 'Motivo de devolución', 1000, true);
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > order.items.length) fail('Selecciona las líneas devueltas.');
  const returns = (await tx.db.all(`SELECT * FROM ${tx.t('order_returns')} WHERE order_id=?`, [order.id])).map(entity);
  const seen = new Set(), lines = [];
  for (const requested of input.lines) {
    validInput(requested);
    const line = order.items.find(item => item.lineId === requested.lineId);
    if (!line || seen.has(line.lineId)) fail('La devolución contiene líneas ajenas o repetidas.');
    seen.add(line.lineId);
    const quantity = integer(requested.quantity, 'Cantidad devuelta', 1, 999);
    const condition = text(requested.condition, 'Condición', 30, true);
    if (!['recoverable', 'non_recoverable'].includes(condition)) fail('Selecciona si la mercancía es recuperable.');
    const previous = returns.flatMap(document => document.lines || []).filter(item => item.lineId === line.lineId);
    const returnedQuantity = previous.reduce((sum, item) => sum + item.quantity, 0);
    if (returnedQuantity + quantity > line.quantity) fail('La cantidad devuelta supera la comprada.');
    const net = moneyMinor(line.quantity * line.unitPriceMinor - line.discountMinor);
    const cumulativeCredit = roundRatio(BigInt(net) * BigInt(returnedQuantity + quantity), BigInt(line.quantity));
    const salesCreditMinor = moneyMinor(cumulativeCredit - previous.reduce((sum, item) => sum + item.salesCreditMinor, 0));
    lines.push({ lineId: line.lineId, quantity, condition, salesCreditMinor, recoveredCostMinor: condition === 'non_recoverable' ? 0 : line.unitCostMinor == null ? null : moneyMinor(line.unitCostMinor * quantity) });
  }
  const shippingCreditMinor = moneyMinor(input.shippingCreditMinor ?? 0, 'Crédito de flete');
  if (shippingCreditMinor + returns.reduce((sum, item) => sum + (item.shippingCreditMinor || 0), 0) > order.shippingChargeMinor) fail('El crédito de flete supera el flete cobrado.');
  const now = stamp(), id = newId();
  const row = { id, order_id: order.id, occurred_on: occurredOn, reason, kind: 'return', source_key: null, version: 1, recorded_at: now, created_at: now, updated_at: now, data: JSON.stringify({ lines, shippingCreditMinor, source: input.source || 'manual' }) };
  await insertRow(tx, 'order_returns', row);
  await audit(tx, { entityType: 'order_return', entityId: id, actorId, next: entity(row), reason, source: input.source || 'manual' });
  const updated = await resolveOrderRecognition(tx, order.id, actorId, { reason, source: input.source || 'manual', adjustmentOn: occurredOn });
  if (updated.version === order.version) await touchOrder(tx, updated, actorId, reason, input.source || 'manual');
  await bumpRevision(tx, [occurredOn, order.recognition?.on]);
  await reconcileCommissionsTx(tx, order.id, { actorId, adjustmentOn: occurredOn, reason });
  return { ...entity(await tx.db.get(`SELECT * FROM ${tx.t('order_returns')} WHERE id=?`, [id])), order: await getOrder(tx, order.id) };
}
export const registerReturn = (store, input, actorId) => command(store, 'finance:return', input, actorId, registerReturnTx);

async function reverseFact(tx, original, { effectiveOn, reason, actorId, legacyResolution = false }) {
  if (original.reversalOf || original.kind === 'reversal') fail('No se puede revertir una reversión.', 409);
  if (await tx.db.get(`SELECT id FROM ${tx.t('order_collections')} WHERE reversal_of=?`, [original.id])) fail('El documento ya fue revertido.', 409);
  const current = await getOrder(tx, original.orderId, { history: false });
  const reversedReceipts = new Set(current.settlementReceipts.filter(receipt => receipt.reversalOf).map(receipt => receipt.reversalOf));
  const dependency = current.settlementReceipts.find(receipt => !receipt.reversalOf && !reversedReceipts.has(receipt.id) && (receipt.lines || []).some(line => line.collectionId === original.id));
  if (dependency) fail(`Revierte primero el recibo de liquidación ${dependency.id}.`, 409);
  if (!legacyResolution && original.kind === 'receipt' && current.paymentSummary.netCollectedMinor < original.amountMinor) fail('Revierte primero los reembolsos que dependen del cobro.', 409);
  if (original.holder === 'platform' && original.kind === 'receipt' && platformAvailable(current, original.sourceId, original.platformId || current.shipments.find(row => row.id === original.shipmentId)?.platformId) < original.amountMinor) fail('Revierte primero las liquidaciones o reembolsos de esta fuente.', 409);
  const cashEntry = original.cashEntryId ? await reverseLinkedCashTx(tx, original.cashEntryId, effectiveOn, reason, actorId) : null;
  const row = { id: newId(), order_id: original.orderId, shipment_id: original.shipmentId, kind: 'reversal', holder: original.holder, amount_minor: original.amountMinor, occurred_on: effectiveOn, cash_entry_id: cashEntry?.id || null, reversal_of: original.id, external_key: null, recorded_at: stamp(), data: JSON.stringify({ reason, actorId, source: 'manual', legacyResolution }) };
  await insertRow(tx, 'order_collections', row);
  await audit(tx, { entityType: 'collection_reversal', entityId: row.id, actorId, previous: original, next: entity(row), reason });
  await bumpRevision(tx, [original.occurredOn, effectiveOn]);
  return entity(row);
}
export async function reverseCollectionTx(tx, documentId, { effectiveOn, reason, actorId }) {
  effectiveOn = actualDate(effectiveOn);
  reason = text(reason, 'Motivo de reversión', 1000, true);
  const original = entity(await tx.db.get(`SELECT * FROM ${tx.t('order_collections')} WHERE id=?`, [text(documentId, 'Documento', 100, true)]));
  if (!original) fail('Cobro o reembolso no encontrado.', 404);
  if (original.holder === 'legacy') fail('Concilia primero el pago histórico.', 409);
  if (original.occurredOn && effectiveOn < original.occurredOn) fail('La reversión no puede ser anterior al documento.');
  const reversal = await reverseFact(tx, original, { effectiveOn, reason, actorId });
  const order = await loadOrderData(tx, original.orderId);
  await touchOrder(tx, order, actorId, reason);
  await reconcileCommissionsTx(tx, order.id, { actorId, adjustmentOn: effectiveOn, reason });
  return { ...reversal, order: await getOrder(tx, order.id) };
}

export async function resolveLegacyPaymentTx(tx, input, actorId) {
  const order = await checkedOrder(tx, input);
  const current = await getOrder(tx, order.id, { history: false });
  if (!current.paymentSummary.legacyReview) fail('El pedido no tiene un pago histórico pendiente de conciliación.', 409);
  const mode = text(input.mode, 'Forma de conciliación', 30, true);
  if (!['opening_balance', 'cash_movement'].includes(mode)) fail('Elige incluido en saldo inicial o movimiento real.');
  if (mode === 'opening_balance' && (input.accountId || input.cashMovement === true)) fail('Incluido en saldo inicial no puede registrar otro movimiento de caja.');
  const reason = text(input.reason, 'Motivo de conciliación', 1000, true);
  const review = order.legacyFinancialReview || {};
  const reversedIds = new Set(current.collections.filter(item => item.reversalOf).map(item => item.reversalOf));
  const originals = current.collections.filter(item => item.holder === 'legacy' && !item.reversalOf && !reversedIds.has(item.id));
  const ambiguous = review.reason === 'ambiguous_refund';
  let receiptAmountMinor, refundAmountMinor, receiptOn, refundOn;
  if (ambiguous) {
    receiptAmountMinor = positive(input.receiptAmountMinor, 'Importe efectivamente cobrado');
    refundAmountMinor = moneyMinor(input.refundAmountMinor, 'Importe efectivamente reembolsado');
    if (refundAmountMinor > receiptAmountMinor) fail('El reembolso histórico supera el cobro confirmado.');
    receiptOn = actualDate(input.receiptOn, 'Fecha del cobro histórico');
    refundOn = refundAmountMinor ? actualDate(input.refundOn, 'Fecha del reembolso histórico') : null;
    if (refundOn && refundOn < receiptOn) fail('El reembolso histórico no puede preceder al cobro.');
  } else {
    if (input.receiptAmountMinor != null || input.refundAmountMinor != null) fail('El importe histórico conocido no se modifica durante la conciliación.');
    receiptAmountMinor = moneyMinor(originals.reduce((sum, item) => sum + (item.kind === 'refund' ? -item.amountMinor : item.amountMinor), 0));
    refundAmountMinor = 0;
    receiptOn = input.occurredOn ? actualDate(input.occurredOn) : mode === 'cash_movement' ? actualDate(input.occurredOn) : null;
    refundOn = null;
  }
  const accountId = mode === 'cash_movement' && (receiptAmountMinor || refundAmountMinor) ? text(input.accountId, 'Cuenta', 100, true) : null;
  const method = mode === 'cash_movement' ? text(input.method, 'Método', 100, true) : 'opening_balance';
  const reference = mode === 'cash_movement' ? text(input.reference, 'Referencia', 200, true) : `legacy:${order.id}:opening_balance`;
  const resolutionOn = input.occurredOn ? actualDate(input.occurredOn) : receiptOn || bogotaDate();
  for (const original of originals) await reverseFact(tx, original, { effectiveOn: resolutionOn, reason, actorId, legacyResolution: true });
  const documents = [];
  const common = { orderId: order.id, holder: 'business', accountId, cash: mode === 'cash_movement', data: { method, reference, reason, source: 'legacy_resolution', requiresReconciliation: false, resolutionMode: mode, legacyDocumentIds: originals.map(item => item.id) } };
  if (ambiguous) {
    documents.push(await appendCollection(tx, { ...common, kind: 'receipt', amountMinor: receiptAmountMinor, occurredOn: receiptOn }, actorId));
    if (refundAmountMinor) documents.push(await appendCollection(tx, { ...common, kind: 'refund', amountMinor: refundAmountMinor, occurredOn: refundOn }, actorId));
  } else if (receiptAmountMinor) {
    // Preserve individual known dates for opening-balance reconciliation, rather than fabricate one.
    for (const original of originals) documents.push(await appendCollection(tx, { ...common, kind: original.kind, amountMinor: original.amountMinor, occurredOn: receiptOn || original.occurredOn || null, shipmentId: original.shipmentId }, actorId));
  }
  const next = { ...order, legacyFinancialReview: { ...review, required: false, state: 'resolved', resolution: { mode, reason, actorId, recordedAt: stamp(), originalDocumentIds: originals.map(item => item.id), replacementDocumentIds: documents.map(item => item.id) } } };
  await touchOrder(tx, next, actorId, reason, 'legacy_resolution');
  await audit(tx, { entityType: 'legacy_payment_resolution', entityId: order.id, actorId, previous: { review, collections: originals }, next: { review: next.legacyFinancialReview, collections: documents }, reason, source: 'legacy_resolution' });
  await reconcileCommissionsTx(tx, order.id, { actorId, adjustmentOn: receiptOn || undefined, reason });
  return { mode, documents, order: await getOrder(tx, order.id) };
}
export const resolveLegacyPayment = (store, input, actorId) => command(store, 'finance:resolve-legacy-payment', input, actorId, resolveLegacyPaymentTx);
