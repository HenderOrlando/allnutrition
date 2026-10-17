import { fail, text, integer } from '../validation-core.mjs';
import { businessDate, bogotaDate, instant } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { entity, runCommand, insertRow, updateVersioned, audit, bumpRevision, newId, stamp, hash } from './commands.mjs';
import { postCashEntryTx, reverseLinkedCashTx } from './cash.mjs';
import { expenseBalanceTx } from './expenses.mjs';
import { reconcileCommissionsTx } from './payroll.mjs';

const signed = value => moneyMinor(value, 'Importe', { signed:true });
const byId = async (tx, table, id) => entity(await tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`, [id]));
const active = rows => { const reversed = new Set(rows.map(row => row.reversalOf).filter(Boolean)); return rows.filter(row => !row.reversalOf && !reversed.has(row.id)); };
function identity(sourceId, externalKey) {
  if (externalKey == null || externalKey === '') return null;
  if (typeof externalKey !== 'string' || !externalKey.trim() || externalKey.length > 300) fail('Referencia externa no válida.');
  return hash([sourceId, externalKey]);
}
const sum = (rows, value) => signed(Number(rows.reduce((total, row) => total + BigInt(value(row)), 0n)));
function normalizeLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 10000) fail('La liquidación requiere entre 1 y 10.000 líneas conciliables.');
  const seen = new Set();
  const expenseDirections = new Map();
  return lines.map(line => {
    const collectionId = text(line.collectionId, 'Cobro', 100, true);
    if (seen.has(collectionId)) fail('Agrupa el bruto de cada cobro en una sola línea.');
    seen.add(collectionId);
    const grossMinor = moneyMinor(line.grossMinor, 'Bruto');
    if (!Array.isArray(line.deductions || []) || (line.deductions || []).length > 1000) fail('Deducciones no válidas.');
    const expenseIds = new Set();
    const deductions = (line.deductions || []).map(deduction => {
      const expenseId = text(deduction.expenseId, 'Gasto retenido', 100, true);
      if (expenseIds.has(expenseId)) fail('Agrupa cada gasto una sola vez por línea.');
      expenseIds.add(expenseId);
      const amountMinor = signed(deduction.amountMinor);
      if (!amountMinor) fail('Una deducción debe tener importe distinto de cero.');
      const direction = Math.sign(amountMinor);
      if (expenseDirections.has(expenseId) && expenseDirections.get(expenseId) !== direction) fail('Un mismo gasto no puede pagarse y recuperarse en el mismo documento.');
      expenseDirections.set(expenseId, direction);
      return { expenseId, amountMinor };
    });
    if (!grossMinor && !deductions.length) fail('Una línea no puede estar vacía.');
    return { collectionId, grossMinor, deductions };
  });
}
const linesNet = lines => sum(lines, line => line.grossMinor - sum(line.deductions, deduction => deduction.amountMinor));
function allocations(lines) {
  const gross = new Map(), expenses = new Map();
  for (const line of lines) {
    gross.set(line.collectionId, signed((gross.get(line.collectionId) || 0) + line.grossMinor));
    for (const deduction of line.deductions) expenses.set(deduction.expenseId, signed((expenses.get(deduction.expenseId) || 0) + deduction.amountMinor));
  }
  return { gross, expenses };
}
function accumulated(receipts) { return allocations(receipts.flatMap(receipt => receipt.lines || [])); }
function fits(value, declared) { return declared >= 0 ? value >= 0 && value <= declared : value <= 0 && value >= declared; }
function assertWithin(received, declaration, label) {
  for (const [id, value] of received) if (!declaration.has(id) || !fits(value, declaration.get(id))) fail(`${label} ${id}: la asignación excede lo declarado.`, 409);
}
function sameAmounts(left, right) { return left.size === right.size && [...left].every(([id, value]) => right.has(id) && right.get(id) === value); }
async function receiptsFor(tx, settlementId) { return (await tx.db.all(`SELECT * FROM ${tx.t('settlement_receipts')} WHERE settlement_id=? ORDER BY recorded_at,id`, [settlementId])).map(entity); }
async function allActiveReceipts(tx, sourceId) {
  return active((await tx.db.all(`SELECT r.* FROM ${tx.t('settlement_receipts')} r JOIN ${tx.t('settlements')} s ON s.id=r.settlement_id WHERE s.source_id=?`, [sourceId])).map(entity));
}

async function rowsByIds(tx,table,ids,column='id',fields='*'){
  const values=[...new Set(ids)],rows=[];
  for(let offset=0;offset<values.length;offset+=1000){
    const chunk=values.slice(offset,offset+1000);
    rows.push(...await tx.db.all(`SELECT ${fields} FROM ${tx.t(table)} WHERE ${column} IN (${chunk.map(()=>'?').join(',')})`,chunk));
  }
  return rows.map(entity);
}
async function validateReferences(tx,sourceId,lines){
  if(!await byId(tx,'platform_sources',sourceId))fail('Cuenta de plataforma no encontrada.',404);
  const collectionIds=lines.map(line=>line.collectionId),expenseIds=lines.flatMap(line=>line.deductions.map(d=>d.expenseId));
  const collections=new Map((await rowsByIds(tx,'order_collections',collectionIds)).map(row=>[row.id,row]));
  const expenses=new Map((await rowsByIds(tx,'expenses',expenseIds)).map(row=>[row.id,row]));
  const reversed=new Set((await rowsByIds(tx,'order_collections',collectionIds,'reversal_of')).map(row=>row.reversalOf));
  const shipments=new Map((await rowsByIds(tx,'shipments',[...collections.values(),...expenses.values()].map(row=>row.shipmentId).filter(Boolean),'id','id,source_id')).map(row=>[row.id,row]));
  const orders=new Set();
  for(const line of lines){
    const collection=collections.get(line.collectionId);
    if(!collection)fail('Cobro no encontrado.',404);
    if(collection.kind!=='receipt'||collection.holder!=='platform'||collection.reversalOf||reversed.has(collection.id))fail('La línea requiere un cobro de plataforma vigente.',409);
    const shipment=shipments.get(collection.shipmentId);
    if((collection.sourceId||shipment?.sourceId)!==sourceId)fail('El cobro pertenece a otra cuenta de plataforma.',409);
    if(line.grossMinor>collection.amountMinor)fail('El bruto supera el cobro.',409);
    orders.add(collection.orderId);
    for(const deduction of line.deductions){
      const expense=expenses.get(deduction.expenseId);
      if(!expense)fail('Gasto no encontrado.',404);
      if(['salary','commission','bonus'].includes(expense.category)||expense.amountMinor<0)fail('La retención requiere un gasto operativo, no una obligación salarial.');
      const expenseShipment=shipments.get(expense.shipmentId);
      if(expenseShipment?.sourceId&&expenseShipment.sourceId!==sourceId)fail('El gasto pertenece a otra cuenta de plataforma.',409);
      if(expense.orderId&&expense.orderId!==collection.orderId)fail('El gasto corresponde a otro pedido.',409);
      if(expense.sourceId&&expense.sourceId!==sourceId)fail('El gasto pertenece a otra fuente.',409);
      if(!expenseShipment&&!expense.orderId&&expense.sourceId!==sourceId)fail('Vincula el gasto al pedido, envío o fuente de la liquidación.',409);
    }
  }
  return orders;
}

export async function getSettlement(store, id) {
  const settlement = await byId(store, 'settlements', id);
  if (!settlement) fail('Liquidación no encontrada.', 404);
  const receipts = await receiptsFor(store, id), effective = active(receipts);
  const declared = allocations(settlement.lines || []), received = accumulated(effective);
  const receivedByLine = new Map();
  for (const receipt of effective) for (const line of receipt.lines || []) {
    const deductions = receivedByLine.get(line.collectionId) || new Map();
    for (const deduction of line.deductions) deductions.set(deduction.expenseId, signed((deductions.get(deduction.expenseId) || 0) + deduction.amountMinor));
    receivedByLine.set(line.collectionId, deductions);
  }
  const remainingLines = (settlement.lines || []).map(line => ({
    collectionId:line.collectionId,
    grossMinor:line.grossMinor - (received.gross.get(line.collectionId) || 0),
    deductions:line.deductions.map(deduction => ({
      expenseId:deduction.expenseId,
      amountMinor:deduction.amountMinor - (receivedByLine.get(line.collectionId)?.get(deduction.expenseId) || 0),
    })).filter(deduction => deduction.amountMinor !== 0),
  })).filter(line => line.grossMinor || line.deductions.length);
  const receivedNetMinor = sum(effective, receipt => receipt.netMinor);
  const unresolved=settlement.unresolvedLines||[],grossComplete=unresolved.every(line=>line.grossMinor!=null);
  const knownDeclaredGrossMinor=signed(sum([...declared.gross.values()],value=>value)+sum(unresolved.filter(line=>line.grossMinor!=null),line=>line.grossMinor));
  return {...settlement,receipts,receivedNetMinor,remainingNetMinor:signed(settlement.netMinor-receivedNetMinor),remainingLines,declaredGrossMinor:grossComplete?knownDeclaredGrossMinor:null,knownDeclaredGrossMinor,declaredGrossComplete:grossComplete};
}

async function refreshSettlement(tx, id, actorId, reason) {
  const old = await byId(tx, 'settlements', id);
  const receipts = active(await receiptsFor(tx, id));
  const declared = allocations(old.lines), received = accumulated(receipts);
  const complete = !old.reconciliationRequired && receipts.length > 0 && sameAmounts(received.gross, declared.gross) && sameAmounts(received.expenses, declared.expenses) && sum(receipts, receipt => receipt.netMinor) === old.netMinor;
  const state = complete ? 'confirmed' : receipts.length ? 'partial' : 'pending';
  await updateVersioned(tx, 'settlements', id, old.version, { state });
  await audit(tx, { entityType:'settlement', entityId:id, actorId, previous:old, next:await byId(tx, 'settlements', id), reason });
}

async function unresolvedDeclarationLines(tx,sourceId,input){
  if(input==null)return [];
  if(!Array.isArray(input)||input.length>10000)fail('Referencias pendientes de liquidación no válidas: máximo 10.000.');
  const rows=[];
  for(const line of input){
    if(!line||typeof line!=='object'||Array.isArray(line))fail('Referencia pendiente no válida.');
    const row={};
    for(const key of ['shipmentId','externalOrderId','externalShipmentId','externalCollectionId','tracking','carrier','reference','sheet','batchId','groupKey']){
      if(line[key]!=null&&line[key]!=='')row[key]=text(line[key],key,300,true);
    }
    if(line.rowNumber!=null)row.rowNumber=integer(line.rowNumber,'Fila de origen',1,10000);
    for(const key of ['grossMinor','netMinor','shippingOutCostMinor','shippingReturnCostMinor','platformFeeMinor']){
      if(Object.hasOwn(line,key))row[key]=line[key]==null?null:moneyMinor(line[key],key,{signed:key==='netMinor'});
    }
    if(!row.shipmentId&&!row.externalOrderId&&!row.externalShipmentId&&!row.externalCollectionId&&!row.tracking&&!row.reference)fail('La declaración pendiente necesita una referencia de origen.');
    rows.push(row);
  }
  const shipments=new Map((await rowsByIds(tx,'shipments',rows.map(row=>row.shipmentId).filter(Boolean),'id','id,source_id')).map(row=>[row.id,row]));
  const batches=new Map((await rowsByIds(tx,'import_batches',rows.map(row=>row.batchId).filter(Boolean),'id','id,source_id')).map(row=>[row.id,row]));
  for(const row of rows){
    if(row.shipmentId){const shipment=shipments.get(row.shipmentId);if(!shipment)fail('Envío pendiente no encontrado.',404);if(shipment.sourceId!==sourceId)fail('El envío pendiente pertenece a otra cuenta de plataforma.',409);}
    if(row.batchId&&batches.get(row.batchId)?.sourceId!==sourceId)fail('Lote de origen no válido.');
  }
  return rows;
}

export async function saveSettlementTx(tx, input, actorId) {
  const id = input.id || input.settlementId || null;
  const old = id ? await byId(tx, 'settlements', id) : null;
  if (id && !old) fail('Liquidación no encontrada.', 404);
  const sourceId = text(input.sourceId || old?.sourceId, 'Cuenta de plataforma', 100, true);
  const unresolvedLines=await unresolvedDeclarationLines(tx,sourceId,input.unresolvedLines);
  const pendingDeclaration=input.source==='excel'&&input.reconciliationRequired===true&&unresolvedLines.length>0;
  if(unresolvedLines.length&&!pendingDeclaration)fail('Las referencias pendientes deben conservar una declaración Excel explícita.');
  const lines=pendingDeclaration&&Array.isArray(input.lines)&&input.lines.length===0?[]:normalizeLines(input.lines),netMinor=signed(input.netMinor);
  await validateReferences(tx, sourceId, lines);
  const externalKey = Object.hasOwn(input, 'externalKey') ? identity(sourceId, input.externalKey) : old?.externalKey || null;
  if (old && (sourceId !== old.sourceId || externalKey !== old.externalKey)) fail('No se puede cambiar la identidad de una liquidación.', 409);
  if (externalKey && await tx.db.get(`SELECT id FROM ${tx.t('settlements')} WHERE external_key=? AND id<>?`, [externalKey, id || ''])) fail('La liquidación externa ya existe. Edita el documento original.', 409);
  const reportedOn = Object.hasOwn(input, 'reportedOn') ? businessDate(input.reportedOn, 'Fecha declarada', { nullable:true }) : old?.reportedOn || null;
  const reason = text(input.reason, 'Motivo', 1000);
  const reconciliationRequired=unresolvedLines.length>0||linesNet(lines)!==netMinor;
  const data={lines,unresolvedLines,externalId:Object.hasOwn(input,'externalKey')?input.externalKey||null:old?.externalId||null,reconciliationRequired,source:input.source||old?.source||'manual',sourceAsOf:input.sourceAsOf?instant(input.sourceAsOf,'Corte de liquidación'):old?.sourceAsOf||null};
  const key = id || newId(), now = stamp();
  if (old) {
    integer(input.version, 'Versión', 1);
    if (!reason) fail('La corrección requiere motivo.');
    const receipts = active(await receiptsFor(tx, id)), applied = accumulated(receipts), declaration = allocations(lines);
    assertWithin(applied.gross, declaration.gross, 'Cobro'); assertWithin(applied.expenses, declaration.expenses, 'Gasto');
    // A receipt is tied to its collection/deduction pairing, not only document totals.
    assertLineAllocations(receipts.flatMap(receipt => receipt.lines || []), lines);
    await updateVersioned(tx, 'settlements', id, input.version, { reported_on:reportedOn, net_minor:netMinor, data:JSON.stringify(data) });
    await refreshSettlement(tx, id, actorId, reason);
  } else await insertRow(tx, 'settlements', { id:key, source_id:sourceId, external_key:externalKey, reported_on:reportedOn, state:'pending', net_minor:netMinor, version:1, data:JSON.stringify(data), created_at:now, updated_at:now });
  await audit(tx, { entityType:'settlement', entityId:key, actorId, previous:old, next:await byId(tx, 'settlements', key), reason:reason || 'Declaración de liquidación sin movimiento de caja' });
  await bumpRevision(tx, [old?.reportedOn, reportedOn]);
  return getSettlement(tx, key);
}

function assertLineAllocations(receivedLines, declaredLines) {
  const declared = new Map(declaredLines.map(line => [line.collectionId, line]));
  const received = new Map();
  for (const line of receivedLines) {
    const target = received.get(line.collectionId) || { grossMinor:0, deductions:new Map() };
    target.grossMinor += line.grossMinor;
    for (const deduction of line.deductions) target.deductions.set(deduction.expenseId, (target.deductions.get(deduction.expenseId) || 0) + deduction.amountMinor);
    received.set(line.collectionId, target);
  }
  for (const [collectionId, line] of received) {
    const target = declared.get(collectionId);
    if (!target || line.grossMinor > target.grossMinor) fail(`Cobro ${collectionId}: supera el bruto declarado.`, 409);
    assertWithin(line.deductions, new Map(target.deductions.map(deduction => [deduction.expenseId, deduction.amountMinor])), 'Deducción');
  }
}

async function validateAvailable(tx, sourceId, lines, globalReceipts) {
  const global = accumulated(globalReceipts), current = allocations(lines), orders = new Map();
  for (const [collectionId, amount] of current.gross) {
    const collection = await byId(tx, 'order_collections', collectionId);
    if (amount + (global.gross.get(collectionId) || 0) > collection.amountMinor) fail(`Cobro ${collectionId}: bruto ya asignado a otra recepción.`, 409);
    orders.set(collection.orderId, (orders.get(collection.orderId) || 0) + amount);
  }
  for (const [orderId, gross] of orders) {
    const facts = active((await tx.db.all(`SELECT * FROM ${tx.t('order_collections')} WHERE order_id=? AND holder='platform'`, [orderId])).map(entity));
    let held = 0;
    const scopedIds = new Set();
    for (const fact of facts) {
      const shipment = fact.shipmentId ? await byId(tx, 'shipments', fact.shipmentId) : null;
      if ((fact.sourceId || shipment?.sourceId) !== sourceId) continue;
      held += fact.kind === 'receipt' ? fact.amountMinor : -fact.amountMinor;
      if (fact.kind === 'receipt') scopedIds.add(fact.id);
    }
    const assigned = sum(globalReceipts.flatMap(receipt => receipt.lines || []).filter(line => scopedIds.has(line.collectionId)), line => line.grossMinor);
    if (gross > held - assigned) fail(`Pedido ${orderId}: el bruto excede el recaudo de plataforma restante después de reembolsos.`, 409);
  }
  for (const [expenseId, amount] of current.expenses) {
    const balance = await expenseBalanceTx(tx, expenseId);
    if (amount > 0 && amount > balance.outstandingMinor) fail(`Gasto ${expenseId}: la retención supera el saldo pendiente.`, 409);
    if (amount < 0 && -amount > balance.creditMinor) fail(`Gasto ${expenseId}: la recuperación supera el sobrepago real.`, 409);
  }
}

export async function refreshSettlementExpenseDatesTx(tx, expenseIds, actorId, reason) {
  for (const expenseId of expenseIds) {
    const expense = await byId(tx, 'expenses', expenseId);
    if (!expense || expense.dateSource !== 'settlement_date') continue;
    const rows = await tx.db.all(`SELECT r.received_on FROM ${tx.t('expense_payments')} p JOIN ${tx.t('settlement_receipts')} r ON r.id=p.settlement_receipt_id WHERE p.expense_id=? AND p.kind='payment' AND p.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ${tx.t('expense_payments')} x WHERE x.reversal_of=p.id) AND r.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ${tx.t('settlement_receipts')} x WHERE x.reversal_of=r.id) ORDER BY r.received_on,r.id`, [expenseId]);
    const incurredOn = rows[0]?.received_on || null;
    if (expense.incurredOn === incurredOn) continue;
    const raw = await tx.db.get(`SELECT data FROM ${tx.t('expenses')} WHERE id=?`, [expenseId]);
    await updateVersioned(tx, 'expenses', expenseId, expense.version, { incurred_on:incurredOn, data:raw.data });
    await audit(tx, { entityType:'expense', entityId:expenseId, actorId, previous:expense, next:await byId(tx, 'expenses', expenseId), reason, source:'settlement' });
    await bumpRevision(tx, [expense.incurredOn, incurredOn]);
  }
}

export async function confirmSettlementTx(tx, input, actorId) {
  const settlement = await byId(tx, 'settlements', input.settlementId);
  if (!settlement) fail('Liquidación no encontrada.', 404);
  integer(input.version, 'Versión', 1);
  if (input.version !== settlement.version) fail('La liquidación cambió. Recarga antes de confirmar.', 409);
  if (settlement.reconciliationRequired || linesNet(settlement.lines) !== settlement.netMinor) fail('La declaración no concilia. Completa el soporte de la diferencia antes de recibir.', 409);
  const receivedOn = businessDate(input.receivedOn, 'Fecha de recepción');
  if (receivedOn > bogotaDate()) fail('No se puede confirmar dinero futuro.');
  const lines = normalizeLines(input.lines), netMinor = linesNet(lines);
  if (input.netMinor != null && signed(input.netMinor) !== netMinor) fail('Bruto menos deducciones no coincide con el neto recibido.');
  const orderIds = await validateReferences(tx, settlement.sourceId, lines);
  for (const line of lines) {
    const collection = await byId(tx, 'order_collections', line.collectionId);
    if (collection.occurredOn && receivedOn < collection.occurredOn) fail('La recepción no puede ser anterior al recaudo del cliente.');
  }
  const effective = active(await receiptsFor(tx, settlement.id));
  assertLineAllocations([...effective.flatMap(receipt => receipt.lines || []), ...lines], settlement.lines);
  const declaration = allocations(settlement.lines), received = accumulated([...effective, { lines }]);
  assertWithin(received.gross, declaration.gross, 'Cobro'); assertWithin(received.expenses, declaration.expenses, 'Gasto');
  await validateAvailable(tx, settlement.sourceId, lines, await allActiveReceipts(tx, settlement.sourceId));
  const externalKey = identity(settlement.sourceId, input.externalKey);
  if (externalKey && await tx.db.get(`SELECT id FROM ${tx.t('settlement_receipts')} WHERE external_key=?`, [externalKey])) fail('La recepción externa ya fue registrada; no es otro abono.', 409);
  const id = newId(), accountId = input.accountId || null;
  const cash = netMinor ? await postCashEntryTx(tx, { accountId, effectiveOn:receivedOn, amountMinor:netMinor, kind:'settlement', sourceType:'settlement_receipt', sourceId:id, data:{ settlementId:settlement.id, sourceId:settlement.sourceId, concept:'Recepción de liquidación', reference:text(input.reference || input.externalKey, 'Referencia', 300) } }, actorId) : null;
  if (!netMinor && accountId && !await byId(tx, 'cash_accounts', accountId)) fail('Cuenta no encontrada.', 404);
  await insertRow(tx, 'settlement_receipts', { id, settlement_id:settlement.id, received_on:receivedOn, account_id:accountId, net_minor:netMinor, cash_entry_id:cash?.id || null, external_key:externalKey, reversal_of:null, recorded_at:stamp(), data:JSON.stringify({ lines, externalId:input.externalKey || null, sourceId:settlement.sourceId, reason:text(input.reason, 'Motivo', 1000) }) });
  for (const [expenseId, amountMinor] of allocations(lines).expenses) {
    if (!amountMinor) continue;
    await insertRow(tx, 'expense_payments', { id:newId(), expense_id:expenseId, kind:amountMinor > 0 ? 'payment' : 'recovery', cash_entry_id:null, settlement_receipt_id:id, amount_minor:amountMinor, reversal_of:null, recorded_at:stamp(), data:JSON.stringify({ effectiveOn:receivedOn, sourceId:settlement.sourceId }) });
  }
  await refreshSettlementExpenseDatesTx(tx, allocations(lines).expenses.keys(), actorId, 'Fecha del primer cargo conciliado');
  await refreshSettlement(tx, settlement.id, actorId, 'Recepción de liquidación');
  await audit(tx, { entityType:'settlement_receipt', entityId:id, actorId, next:await byId(tx, 'settlement_receipts', id), reason:'Recepción conciliada: bruto menos gastos retenidos' });
  for (const orderId of orderIds) await reconcileCommissionsTx(tx, orderId, { actorId, adjustmentOn:receivedOn, reason:'Recepción de plataforma conciliada' });
  await bumpRevision(tx, [receivedOn]);
  return { receipt:await byId(tx, 'settlement_receipts', id), settlement:await getSettlement(tx, settlement.id) };
}

export async function reverseSettlementReceiptTx(tx, receiptId, { effectiveOn, reason, actorId }) {
  const receipt = await byId(tx, 'settlement_receipts', receiptId);
  if (!receipt) fail('Recepción no encontrada.', 404);
  reason = text(reason, 'Motivo', 1000, true);
  effectiveOn = businessDate(effectiveOn, 'Fecha de reversión');
  if (effectiveOn > bogotaDate() || effectiveOn < receipt.receivedOn) fail('La reversión requiere una fecha real no anterior a la recepción.');
  if (receipt.reversalOf || await tx.db.get(`SELECT id FROM ${tx.t('settlement_receipts')} WHERE reversal_of=?`, [receipt.id])) fail('La recepción ya fue reversada.', 409);
  const payments = (await tx.db.all(`SELECT * FROM ${tx.t('expense_payments')} WHERE settlement_receipt_id=?`, [receipt.id])).map(entity);
  for (const payment of payments) {
    if (payment.reversalOf || await tx.db.get(`SELECT id FROM ${tx.t('expense_payments')} WHERE reversal_of=?`, [payment.id])) fail(`El pago ${payment.id} tiene una reversión dependiente.`, 409);
    const balance = await expenseBalanceTx(tx, payment.expenseId);
    if (payment.amountMinor > 0 && balance.paidMinor < payment.amountMinor) fail(`Revierte primero las recuperaciones del gasto ${payment.expenseId}.`, 409);
  }
  const cash = receipt.cashEntryId ? await reverseLinkedCashTx(tx, receipt.cashEntryId, effectiveOn, reason, actorId) : null;
  const id = newId();
  await insertRow(tx, 'settlement_receipts', { id, settlement_id:receipt.settlementId, received_on:effectiveOn, account_id:receipt.accountId, net_minor:-receipt.netMinor, cash_entry_id:cash?.id || null, external_key:null, reversal_of:receipt.id, recorded_at:stamp(), data:JSON.stringify({ lines:receipt.lines, reversal:true, reason, sourceId:receipt.sourceId }) });
  for (const payment of payments) await insertRow(tx, 'expense_payments', { id:newId(), expense_id:payment.expenseId, kind:'reversal', cash_entry_id:null, settlement_receipt_id:id, amount_minor:-payment.amountMinor, reversal_of:payment.id, recorded_at:stamp(), data:JSON.stringify({ reason, effectiveOn }) });
  await refreshSettlementExpenseDatesTx(tx, payments.map(payment => payment.expenseId), actorId, reason);
  await refreshSettlement(tx, receipt.settlementId, actorId, reason);
  const orderIds = new Set();
  for (const line of receipt.lines) { const collection = await byId(tx, 'order_collections', line.collectionId); orderIds.add(collection.orderId); }
  for (const orderId of orderIds) await reconcileCommissionsTx(tx, orderId, { actorId, adjustmentOn:effectiveOn, reason });
  await audit(tx, { entityType:'settlement_receipt', entityId:id, actorId, previous:receipt, next:await byId(tx, 'settlement_receipts', id), reason });
  await bumpRevision(tx, [effectiveOn, receipt.receivedOn]);
  return { receipt:await byId(tx, 'settlement_receipts', id), settlement:await getSettlement(tx, receipt.settlementId) };
}

export async function reverseSettlementTx(tx, settlementId, { effectiveOn, reason, actorId, version }) {
  const settlement = await byId(tx, 'settlements', settlementId);
  if (!settlement) fail('Liquidación no encontrada.', 404);
  integer(version, 'Versión', 1);
  if (version !== settlement.version) fail('La liquidación cambió. Recarga antes de reversar.', 409);
  const receipts = active(await receiptsFor(tx, settlementId));
  if (!receipts.length) fail('La liquidación no tiene recibos vigentes.', 409);
  // Recoveries must be unwound before the positive payments they consumed.
  receipts.sort((a, b) => Number(b.lines.some(line => line.deductions.some(deduction => deduction.amountMinor < 0))) - Number(a.lines.some(line => line.deductions.some(deduction => deduction.amountMinor < 0))) || b.receivedOn.localeCompare(a.receivedOn) || b.recordedAt.localeCompare(a.recordedAt));
  for (const receipt of receipts) await reverseSettlementReceiptTx(tx, receipt.id, { effectiveOn, reason, actorId });
  return getSettlement(tx, settlementId);
}

export const saveSettlement = (store, input, actorId) => runCommand(store, { scope:'settlement-save', requestId:input.requestId, payload:input, actorId }, tx => saveSettlementTx(tx, input, actorId));
export const confirmSettlement = (store, input, actorId) => runCommand(store, { scope:'settlement-confirm', requestId:input.requestId, payload:input, actorId }, tx => confirmSettlementTx(tx, input, actorId));
