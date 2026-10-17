import { fail, text, integer } from '../validation-core.mjs';
import { businessDate, bogotaDate } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { entity, runCommand, insertRow, updateVersioned, audit, bumpRevision, stamp, newId } from './commands.mjs';

const KINDS = new Set(['opening', 'collection', 'refund', 'settlement', 'expense_payment', 'payroll_payment', 'advance', 'income', 'owner_funding', 'other_non_sale', 'transfer', 'adjustment', 'recovery', 'reversal']);
const PUBLIC_REVERSIBLE = new Set(['income', 'owner_funding', 'other_non_sale', 'adjustment', 'transfer']);
const command = (store, scope, input, actorId, fn) => runCommand(store, { scope, requestId: input.requestId, payload: input, actorId }, fn);

async function accountTx(tx, id, { active = false } = {}) {
  id = text(id, 'Cuenta', 100, true);
  const account = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_accounts')} WHERE id=?`, [id]));
  if (!account) fail('Cuenta no encontrada.', 404);
  if (active && !account.active) fail('La cuenta está archivada. Reactívala antes de registrar movimientos.', 409);
  return account;
}
async function personTx(tx, id) {
  id = text(id, 'Responsable', 100, true);
  if (!await tx.db.get(`SELECT id FROM ${tx.t('people')} WHERE id=? AND active=1`, [id])) fail('El responsable debe ser una persona activa existente.');
  return id;
}
function confirmedDate(value, label = 'Fecha del movimiento') {
  const on = businessDate(value, label);
  if (on > bogotaDate()) fail(`${label}: no se permiten movimientos confirmados futuros.`);
  return on;
}
async function validateAccountDate(tx, account, on) {
  if (on < account.openingOn) fail('La fecha del movimiento es anterior a la apertura de la cuenta.');
  if (account.type === 'cash') {
    const closed = await tx.db.get(`SELECT id,closing_on FROM ${tx.t('cash_closings')} WHERE account_id=? AND state='closed' AND closing_on>=? ORDER BY closing_on DESC LIMIT 1`, [account.id, on]);
    if (closed) fail(`La caja está cerrada hasta ${closed.closing_on}. Reabre el cierre ${closed.id} antes de registrar este movimiento.`, 409);
  }
}
function checkedBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}: se esperaba sí o no.`);
  return value;
}
function safeTotal(value, label) {
  const total = BigInt(value);
  if (total < BigInt(Number.MIN_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label}: excede el rango entero seguro.`);
  return Number(total);
}

export async function accountBalance(tx, accountId, on = bogotaDate()) {
  await accountTx(tx, accountId);
  on = businessDate(on, 'Fecha de saldo');
  const row = await tx.db.get(`SELECT COALESCE(SUM(amount_minor),0) AS balance_minor FROM ${tx.t('cash_entries')} WHERE account_id=? AND effective_on<=?`, [accountId, on]);
  return safeTotal(row.balance_minor, 'Saldo');
}
async function withBalance(tx, entry) {
  const balanceMinor = await accountBalance(tx, entry.accountId);
  return { ...entry, balanceMinor, warnings: balanceMinor < 0 ? ['La cuenta tiene saldo negativo.'] : [] };
}

// Transaction-only helper: financial documents retain ownership of their linked entries.
export async function postCashEntryTx(tx, input, actorId) {
  const account = await accountTx(tx, input.accountId, { active: true });
  const effectiveOn = confirmedDate(input.effectiveOn);
  await validateAccountDate(tx, account, effectiveOn);
  const amountMinor = moneyMinor(input.amountMinor, 'Movimiento', { signed: true });
  if (!KINDS.has(input.kind)) fail('Tipo de movimiento no válido.');
  if (!amountMinor && input.kind !== 'opening') fail('El movimiento debe ser distinto de cero.');
  const sourceType = text(input.sourceType, 'Tipo de documento', 100, true);
  const sourceId = text(input.sourceId, 'Documento de origen', 100, true);
  actorId = text(actorId, 'Administrador', 100, true);
  if (input.kind === 'opening') {
    if (effectiveOn !== account.openingOn) fail('La apertura debe tener la fecha inicial de la cuenta.');
    if (await tx.db.get(`SELECT id FROM ${tx.t('cash_entries')} WHERE account_id=?`, [account.id])) fail('La cuenta ya tiene movimientos; no se puede añadir otra apertura.', 409);
  } else if (!await tx.db.get(`SELECT id FROM ${tx.t('cash_entries')} WHERE account_id=? AND kind='opening'`, [account.id])) {
    fail('La cuenta requiere su apertura explícita antes de registrar movimientos.', 409);
  }
  const reversalOf = input.reversalOf == null ? null : text(input.reversalOf, 'Movimiento original', 100, true);
  if (input.kind === 'reversal' || reversalOf) {
    if (input.kind !== 'reversal' || !reversalOf) fail('Una reversión debe identificar su movimiento original.');
    const original = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE id=?`, [reversalOf]));
    if (!original) fail('Movimiento original no encontrado.', 404);
    if (original.reversalOf || original.kind === 'opening') fail('No se puede revertir una apertura ni otra reversión.', 409);
    if (original.accountId !== account.id || amountMinor !== -original.amountMinor || sourceType !== original.sourceType || sourceId !== original.sourceId || (input.transferId ?? null) !== original.transferId) fail('La reversión no corresponde al movimiento original.');
    if (effectiveOn < original.effectiveOn) fail('La reversión no puede ser anterior al movimiento original.');
    if (await tx.db.get(`SELECT id FROM ${tx.t('cash_entries')} WHERE reversal_of=?`, [original.id])) fail('El movimiento ya fue revertido.', 409);
  }
  const data = { ...input.data, actorId, concept: text(input.data?.concept || input.kind, 'Concepto', 500, true), reference: text(input.data?.reference, 'Referencia', 300), reason: text(input.data?.reason, 'Motivo', 1000) };
  if (reversalOf && !data.reason) fail('Indica el motivo de la reversión.');
  const row = { id: input.id == null ? newId() : text(input.id, 'Movimiento', 100, true), account_id: account.id, effective_on: effectiveOn, amount_minor: amountMinor, kind: input.kind, source_type: sourceType, source_id: sourceId, transfer_id: input.transferId == null ? null : text(input.transferId, 'Transferencia', 100, true), reversal_of: reversalOf, recorded_at: stamp(), data: JSON.stringify(data) };
  await insertRow(tx, 'cash_entries', row);
  await accountBalance(tx, account.id);
  const next = entity(row);
  await audit(tx, { entityType: 'cash_entry', entityId: row.id, actorId, next, reason: data.reason, source: sourceType });
  await bumpRevision(tx, [effectiveOn]);
  return next;
}

export async function saveAccount(store, input, actorId, id = null) {
  return command(store, `account:${id || input.id || 'new'}`, input, actorId, async tx => {
    const key = id || input.id || newId();
    const old = id || input.id ? await accountTx(tx, key) : null;
    const name = text(input.name ?? old?.name, 'Nombre de cuenta', 150, true);
    const type = input.type ?? old?.type;
    if (!['cash', 'bank', 'wallet'].includes(type)) fail('Tipo de cuenta no válido.');
    const responsibleId = await personTx(tx, input.responsibleId ?? old?.responsibleId);
    const active = checkedBoolean(input.active ?? old?.active ?? true, 'Cuenta activa');
    if (!old && !active) fail('La cuenta debe estar activa al registrar su apertura.');
    const openingOn = confirmedDate(input.openingOn ?? old?.openingOn, 'Fecha de apertura');
    if (old && (openingOn !== old.openingOn || type !== old.type)) fail('La fecha de apertura y el tipo de cuenta no pueden cambiar después de su apertura.', 409);
    const minimumMinor = input.minimumMinor === undefined ? old?.minimumMinor ?? null : input.minimumMinor === null ? null : moneyMinor(input.minimumMinor, 'Saldo mínimo', { signed: true });
    const closingEnabled = checkedBoolean(input.closingEnabled ?? old?.closingEnabled ?? false, 'Cierre habilitado');
    const closingTime = input.closingTime === undefined ? old?.closingTime ?? null : input.closingTime;
    if (closingTime !== null && (typeof closingTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(closingTime))) fail('Hora de cierre no válida.');
    if (closingEnabled && (type !== 'cash' || closingTime === null)) fail('Solo las cajas con una hora configurada pueden exigir cierre.');
    const toleranceMinor = moneyMinor(input.toleranceMinor ?? old?.toleranceMinor ?? 0, 'Tolerancia de cierre');
    const data = { minimumMinor, closingEnabled, closingTime, toleranceMinor };
    const fields = { name, type, opening_on: openingOn, responsible_id: responsibleId, active: active ? 1 : 0, data: JSON.stringify(data) };
    if (old) {
      if (input.openingBalanceMinor !== undefined) {
        const opening = await tx.db.get(`SELECT amount_minor FROM ${tx.t('cash_entries')} WHERE account_id=? AND kind='opening'`, [key]);
        if (moneyMinor(input.openingBalanceMinor, 'Saldo inicial', { signed: true }) !== opening.amount_minor) fail('El saldo inicial es un hecho registrado y no puede editarse.', 409);
      }
      await updateVersioned(tx, 'cash_accounts', key, input.version, fields);
    } else {
      const openingBalanceMinor = moneyMinor(input.openingBalanceMinor, 'Saldo inicial', { signed: true });
      const now = stamp();
      await insertRow(tx, 'cash_accounts', { id: key, ...fields, version: 1, created_at: now, updated_at: now });
      await postCashEntryTx(tx, { accountId: key, effectiveOn: openingOn, amountMinor: openingBalanceMinor, kind: 'opening', sourceType: 'account', sourceId: key, data: { concept: 'Saldo inicial', reference: input.reference, reason: input.reason } }, actorId);
    }
    const next = await accountTx(tx, key);
    await audit(tx, { entityType: 'cash_account', entityId: key, actorId, previous: old, next, reason: text(input.reason, 'Motivo', 1000) || (old ? 'Actualizar cuenta' : 'Abrir cuenta') });
    const balanceMinor = await accountBalance(tx, key);
    return { ...next, balanceMinor, warnings: balanceMinor < 0 ? ['La cuenta tiene saldo negativo.'] : [] };
  });
}

export async function recordIncome(store, input, actorId) {
  return command(store, 'cash:income', input, actorId, async tx => {
    if (!['owner_funding', 'other_non_sale'].includes(input.concept)) fail('Elige aporte del propietario u otro ingreso no ligado a ventas.');
    const amountMinor = moneyMinor(input.amountMinor, 'Ingreso');
    if (!amountMinor) fail('El ingreso debe ser positivo.');
    const id = newId();
    const entry = await postCashEntryTx(tx, { id, accountId: input.accountId, effectiveOn: input.effectiveOn, amountMinor, kind: 'income', sourceType: 'income', sourceId: id, data: { concept: input.concept, description: text(input.description, 'Descripción', 500), reference: input.reference, reason: input.reason, nonSale: true } }, actorId);
    return withBalance(tx, entry);
  });
}
export async function recordAdvance(store, input, actorId) {
  return command(store, 'cash:advance', input, actorId, async tx => {
    const personId = await personTx(tx, input.personId);
    const amountMinor = moneyMinor(input.amountMinor, 'Anticipo');
    if (!amountMinor) fail('El anticipo debe ser positivo.');
    const id = newId();
    const entry = await postCashEntryTx(tx, { id, accountId: input.accountId, effectiveOn: input.effectiveOn, amountMinor: -amountMinor, kind: 'advance', sourceType: 'advance', sourceId: id, data: { personId, concept: text(input.concept, 'Concepto', 500, true), reference: input.reference, reason: input.reason } }, actorId);
    return withBalance(tx, entry);
  });
}
export async function transferMoney(store, input, actorId) {
  return command(store, 'cash:transfer', input, actorId, async tx => {
    if (input.fromAccountId === input.toAccountId) fail('El origen y el destino deben ser cuentas distintas.');
    const amountMinor = moneyMinor(input.amountMinor, 'Transferencia');
    if (!amountMinor) fail('La transferencia debe ser positiva.');
    const transferId = newId();
    const data = { concept: text(input.concept, 'Concepto', 500, true), reference: input.reference, reason: input.reason };
    const entries = [];
    for (const [accountId, sign] of [[input.fromAccountId, -1], [input.toAccountId, 1]]) entries.push(await postCashEntryTx(tx, { accountId, effectiveOn: input.effectiveOn, amountMinor: sign * amountMinor, kind: 'transfer', sourceType: 'transfer', sourceId: transferId, transferId, data }, actorId));
    return { transferId, entries: await Promise.all(entries.map(entry => withBalance(tx, entry))) };
  });
}

export async function closeCash(store, input, actorId) {
  return command(store, 'cash:close', input, actorId, async tx => {
    const account = await accountTx(tx, input.accountId, { active: true });
    if (account.type !== 'cash') fail('Solo las cuentas de efectivo tienen cierre de caja.');
    const closingOn = confirmedDate(input.closingOn, 'Fecha del cierre');
    await validateAccountDate(tx, account, closingOn);
    const responsibleId = await personTx(tx, input.responsibleId ?? account.responsibleId);
    const countedMinor = moneyMinor(input.countedMinor, 'Efectivo contado');
    const expectedMinor = moneyMinor(await accountBalance(tx, account.id, closingOn), 'Saldo esperado', { signed: true });
    const differenceMinor = moneyMinor(countedMinor - expectedMinor, 'Diferencia de cierre', { signed: true });
    const prior = await tx.db.get(`SELECT revision FROM ${tx.t('cash_closings')} WHERE account_id=? AND closing_on=? ORDER BY revision DESC LIMIT 1`, [account.id, closingOn]);
    const now = stamp();
    const row = { id: newId(), account_id: account.id, closing_on: closingOn, revision: (prior?.revision ?? 0) + 1, state: 'closed', expected_minor: expectedMinor, counted_minor: countedMinor, difference_minor: differenceMinor, responsible_id: responsibleId, recorded_at: now, data: JSON.stringify({ actorId, concept: 'Cierre de caja', reference: text(input.reference, 'Referencia', 300), reason: text(input.reason, 'Motivo', 1000) }), version: 1, created_at: now, updated_at: now };
    await insertRow(tx, 'cash_closings', row);
    const next = entity(row);
    await audit(tx, { entityType: 'cash_closing', entityId: row.id, actorId, next, reason: next.reason });
    return next;
  });
}
export async function reopenCash(store, input, actorId) {
  return command(store, 'cash:reopen', input, actorId, async tx => {
    const id = text(input.closingId, 'Cierre', 100, true);
    const old = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_closings')} WHERE id=?`, [id]));
    if (!old) fail('Cierre no encontrado.', 404);
    integer(input.version, 'Versión', 1);
    if (old.state !== 'closed') fail('Este cierre ya fue reabierto.', 409);
    const reason = text(input.reason, 'Motivo de reapertura', 1000, true);
    const later = await tx.db.get(`SELECT id,closing_on FROM ${tx.t('cash_closings')} WHERE account_id=? AND state='closed' AND closing_on>? ORDER BY closing_on DESC LIMIT 1`, [old.accountId, old.closingOn]);
    if (later) fail(`Reabre primero el cierre posterior ${later.id} (${later.closing_on}).`, 409);
    const data = JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('cash_closings')} WHERE id=?`, [id])).data);
    await updateVersioned(tx, 'cash_closings', id, input.version, { state: 'reopened', data: JSON.stringify({ ...data, reopenedAt: stamp(), reopenedBy: actorId, reopenReason: reason }) });
    const next = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_closings')} WHERE id=?`, [id]));
    await audit(tx, { entityType: 'cash_closing', entityId: id, actorId, previous: old, next, reason });
    return next;
  });
}

export async function reverseLinkedCashTx(tx, entryId, effectiveOn, reason, actorId) {
  const original = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE id=?`, [text(entryId, 'Movimiento', 100, true)]));
  if (!original) fail('Movimiento no encontrado.', 404);
  reason = text(reason, 'Motivo de reversión', 1000, true);
  return postCashEntryTx(tx, { accountId: original.accountId, effectiveOn, amountMinor: -original.amountMinor, kind: 'reversal', sourceType: original.sourceType, sourceId: original.sourceId, transferId: original.transferId, reversalOf: original.id, data: { concept: `Reversión: ${original.concept}`, reference: original.reference, reason, personId: original.personId ?? null } }, actorId);
}
async function protectDocumentDependencies(tx, entry) {
  for (const [table, label] of [['order_collections', 'cobro o reembolso'], ['settlement_receipts', 'recibo de liquidación'], ['expense_payments', 'pago de gasto']]) {
    const dependent = await tx.db.get(`SELECT id FROM ${tx.t(table)} WHERE cash_entry_id=?`, [entry.id]);
    if (dependent) fail(`El movimiento pertenece a ${label} ${dependent.id}. Usa Revertir documento para mantener sus asignaciones coherentes.`, 409);
  }
  const allocation = await tx.db.get(`SELECT payroll_id FROM ${tx.t('payroll_allocations')} WHERE source_type='advance' AND source_id=? AND amount_minor<>0 LIMIT 1`, [entry.id]);
  if (allocation) fail(`El anticipo está aplicado al sueldo ${allocation.payroll_id}. Deshaz primero su aplicación desde el documento de sueldo.`, 409);
}
export async function reverseCashEntry(store, input, actorId) {
  return command(store, 'cash:reverse', input, actorId, async tx => {
    const entryId = text(input.cashEntryId, 'Movimiento', 100, true);
    const original = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE id=?`, [entryId]));
    if (!original) fail('Movimiento no encontrado.', 404);
    if (original.reversalOf) fail('No se puede revertir una reversión.', 409);
    await protectDocumentDependencies(tx, original);
    if (!PUBLIC_REVERSIBLE.has(original.kind) || !['income', 'owner_funding', 'other_non_sale', 'adjustment', 'transfer'].includes(original.sourceType)) fail('Este movimiento pertenece a una apertura o documento financiero. Usa Revertir documento (cobro, reembolso, liquidación, pago o anticipo); una apertura no se elimina.', 409);
    const reason = text(input.reason, 'Motivo de reversión', 1000, true);
    if (original.kind === 'transfer') {
      const entries = (await tx.db.all(`SELECT * FROM ${tx.t('cash_entries')} WHERE transfer_id=? AND reversal_of IS NULL ORDER BY id`, [original.transferId])).map(entity);
      if (entries.length !== 2 || entries[0].accountId === entries[1].accountId || entries[0].amountMinor !== -entries[1].amountMinor || entries.some(entry => entry.kind !== 'transfer' || entry.sourceType !== 'transfer' || entry.sourceId !== original.transferId)) fail('La transferencia no tiene sus dos movimientos coherentes. Revisa el documento antes de revertir.', 409);
      const reversed = [];
      for (const entry of entries) {
        await protectDocumentDependencies(tx, entry);
        reversed.push(await reverseLinkedCashTx(tx, entry.id, input.effectiveOn, reason, actorId));
      }
      return { transferId: original.transferId, entries: await Promise.all(reversed.map(entry => withBalance(tx, entry))) };
    }
    return withBalance(tx, await reverseLinkedCashTx(tx, original.id, input.effectiveOn, reason, actorId));
  });
}
