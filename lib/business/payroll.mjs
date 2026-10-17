import { fail, integer, text } from '../validation-core.mjs';
import { audit, bumpRevision, entity, hash, insertRow, newId, runCommand, stamp, updateVersioned } from './commands.mjs';
import { addDays, bogotaDate, businessDate, periodBounds } from './dates.mjs';
import { moneyMinor, roundRatio } from './money.mjs';
import { postCashEntryTx, reverseLinkedCashTx } from './cash.mjs';
import { expenseBalanceTx } from './expenses.mjs';
import { effectiveShipmentEvents } from './shipments.mjs';

const signed = value => moneyMinor(value, 'Importe', { signed: true });
const sum = (rows, get = row => row.amountMinor) => signed(Number(rows.reduce((n, row) => n + BigInt(signed(get(row))), 0n)));
const oldest = (a, b) => (a.incurredOn || a.effectiveOn || '').localeCompare(b.incurredOn || b.effectiveOn || '') || a.id.localeCompare(b.id);
const active = rows => { const reversed = new Set(rows.map(row => row.reversalOf).filter(Boolean)); return rows.filter(row => !row.reversalOf && !reversed.has(row.id)); };
const rows = async (tx, table, where = '', args = []) => (await tx.db.all(`SELECT * FROM ${tx.t(table)} ${where}`, args)).map(entity);
async function requirePerson(tx, id) {
  const person = entity(await tx.db.get(`SELECT * FROM ${tx.t('people')} WHERE id=?`, [id]));
  if (!person) fail('Persona no encontrada.', 404);
  return person;
}
function periodInput(input) {
  const startOn = businessDate(input.startOn), endOnExclusive = businessDate(input.endOnExclusive);
  if (startOn >= endOnExclusive) fail('El fin debe ser posterior al inicio.');
  return { startOn, endOnExclusive };
}
const dayCount = (start, end) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
function salaryBounds(frequency, on) {
  if (frequency === 'weekly') return periodBounds('week', on);
  const bounds = periodBounds('month', on);
  if (frequency === 'monthly') return bounds;
  if (frequency !== 'halfmonthly') fail('Frecuencia de sueldo no válida.');
  const middle = on.slice(0, 8) + '16';
  return on < middle ? { startDate: bounds.startDate, endDateExclusive: middle } : { startDate: middle, endDateExclusive: bounds.endDateExclusive };
}
function salaryFacts(person, throughOn, startOn = null) {
  const facts = [], agreements = (person.salaryAgreements || []).filter(a => a.enabled !== false).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let i = 0; i < agreements.length; i++) {
    const agreement = agreements[i];
    businessDate(agreement.effectiveFrom);
    if (agreement.effectiveTo) businessDate(agreement.effectiveTo);
    if (i && (!agreements[i - 1].effectiveTo || agreements[i - 1].effectiveTo >= agreement.effectiveFrom)) fail('Los convenios de sueldo no pueden superponerse.');
    const amount = moneyMinor(agreement.amountPerPeriodMinor, 'Sueldo');
    const end = agreement.effectiveTo && agreement.effectiveTo < throughOn ? agreement.effectiveTo : throughOn;
    let on = startOn && startOn > agreement.effectiveFrom ? startOn : agreement.effectiveFrom;
    for (; on <= end; on = addDays(on, 1)) {
      const bounds = salaryBounds(agreement.frequency, on), count = dayCount(bounds.startDate, bounds.endDateExclusive), index = dayCount(bounds.startDate, on);
      const daily = Number(BigInt(amount) / BigInt(count)) + (index < Number(BigInt(amount) % BigInt(count)) ? 1 : 0);
      facts.push({ personId: person.id, incurredOn: on, amountMinor: daily, sourceKey: `salary:${person.id}:${agreement.id}:${on}`, agreementId: agreement.id, agreementSnapshot: agreement, periodStartOn: bounds.startDate, periodEndOnExclusive: bounds.endDateExclusive });
    }
  }
  return facts;
}
async function createExpense(tx, { category, amountMinor, incurredOn, personId, orderId = null, sourceKey, ...data }, actorId) {
  const now = stamp(), id = newId();
  await insertRow(tx, 'expenses', { id, category, amount_minor: signed(amountMinor), incurred_on: incurredOn, person_id: personId, order_id: orderId, shipment_id: null, source_key: sourceKey, version: 1, recorded_at: now, created_at: now, updated_at: now, data: JSON.stringify(data) });
  const result = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE id=?`, [id]));
  await audit(tx, { entityType: 'expense', entityId: id, actorId, next: result, reason: data.reason || '', source: category });
  await bumpRevision(tx, [incurredOn]);
  return result;
}

// The scheduler passes yesterday; confirmation may explicitly complete the last day today.
export async function materializePayrollAccrualsTx(tx, { throughOn, personId = null, actorId, completeCurrentDay = false }) {
  throughOn = businessDate(throughOn);
  if (throughOn > (completeCurrentDay ? bogotaDate() : addDays(bogotaDate(), -1))) fail('Solo se pueden devengar días completados; la confirmación completa el último día del período.');
  const people = personId ? [await requirePerson(tx, personId)] : await rows(tx, 'people');
  const created = [];
  for (const person of people) {
    const stored = await rows(tx, 'expenses', 'WHERE person_id=? AND category=?', [person.id, 'salary']);
    const existing = new Set(stored.map(e => e.sourceKey));
    const completedDates = new Set(stored.filter(e => e.agreementId).map(e => e.incurredOn));
    const frozen = await rows(tx, 'payroll_periods', 'WHERE person_id=?', [person.id]);
    for (const fact of salaryFacts(person, throughOn)) {
      if (existing.has(fact.sourceKey) || completedDates.has(fact.incurredOn) || frozen.some(p => p.startOn <= fact.incurredOn && p.endOnExclusive > fact.incurredOn)) continue;
      // Zero is a known daily allocation, not an unknown expense.
      created.push(await createExpense(tx, { ...fact, category: 'salary', concept: 'Sueldo diario devengado' }, actorId));
    }
  }
  return { throughOn, createdCount: created.length, amountMinor: sum(created), expenses: created };
}

// A scheduler cursor advances by civil dates, including dates already frozen by
// a confirmed payroll. Never build the person's entire historical salary array.
export async function materializePayrollAccrualsChunkTx(tx, { throughOn, startOn = null, personId, actorId, maxDays = 90, now = stamp() }) {
  throughOn = businessDate(throughOn);
  if (throughOn > addDays(bogotaDate(now), -1)) fail('Solo se pueden devengar días completados.');
  if (startOn) startOn = businessDate(startOn);
  maxDays = integer(maxDays, 'Días por turno', 1, 90);
  const person = await requirePerson(tx, personId);
  const agreements = (person.salaryAgreements || []).filter(a => a.enabled !== false && a.effectiveFrom <= throughOn && (!a.effectiveTo || !startOn || a.effectiveTo >= startOn));
  const first = agreements.map(a => startOn && startOn > a.effectiveFrom ? startOn : a.effectiveFrom).sort()[0];
  if (!first || first > throughOn) return { throughOn, complete: true, createdCount: 0, scannedDays: 0 };
  const endOn = [throughOn, addDays(first, maxDays - 1)].sort()[0];
  const stored = await rows(tx, 'expenses', "WHERE person_id=? AND category='salary' AND incurred_on>=? AND incurred_on<=?", [personId, first, endOn]);
  const existing = new Set(stored.map(e => e.sourceKey));
  const completedDates = new Set(stored.filter(e => e.agreementId).map(e => e.incurredOn));
  const frozen = await rows(tx, 'payroll_periods', 'WHERE person_id=? AND start_on<=? AND end_on_exclusive>?', [personId, endOn, first]);
  let createdCount = 0;
  for (const fact of salaryFacts(person, endOn, first)) {
    if (existing.has(fact.sourceKey) || completedDates.has(fact.incurredOn) || frozen.some(p => p.startOn <= fact.incurredOn && p.endOnExclusive > fact.incurredOn)) continue;
    await createExpense(tx, { ...fact, category: 'salary', concept: 'Sueldo diario devengado' }, actorId);
    createdCount++;
  }
  const remaining = agreements.some(a => (!a.effectiveTo || a.effectiveTo > endOn) && a.effectiveFrom <= throughOn && endOn < throughOn);
  return { throughOn: remaining ? endOn : throughOn, complete: !remaining, createdCount, scannedDays: dayCount(first, endOn) + 1 };
}

async function expenseCandidates(tx, personId, endOnExclusive) {
  return (await rows(tx, 'expenses', "WHERE person_id=? AND category IN ('salary','commission','bonus') AND incurred_on<?", [personId, endOnExclusive])).sort(oldest);
}
async function advanceAvailable(tx, advance) {
  if (advance.reversalOf || await tx.db.get(`SELECT id FROM ${tx.t('cash_entries')} WHERE reversal_of=?`, [advance.id])) return 0;
  const payments = await rows(tx, 'expense_payments', 'WHERE cash_entry_id=?', [advance.id]);
  return Math.max(0, -advance.amountMinor - sum(payments));
}
async function availableAdvances(tx, personId, throughOn) {
  const result = [];
  for (const entry of await rows(tx, 'cash_entries', "WHERE kind='advance' AND effective_on<=?", [throughOn])) {
    if (entry.personId !== personId || entry.amountMinor >= 0 || entry.reversalOf) continue;
    const availableMinor = await advanceAvailable(tx, entry);
    if (availableMinor) result.push({ ...entry, availableMinor });
  }
  return result.sort(oldest);
}
async function allocations(tx, payrollId) { return rows(tx, 'payroll_allocations', 'WHERE payroll_id=?', [payrollId]); }
export async function getPayroll(tx, id) {
  const payroll = entity(await tx.db.get(`SELECT * FROM ${tx.t('payroll_periods')} WHERE id=?`, [id]));
  if (!payroll) fail('Período de sueldo no encontrado.', 404);
  const assigned = await allocations(tx, id), obligations = [];
  for (const allocation of assigned.filter(a => a.sourceType === 'expense')) {
    const expense = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE id=?`, [allocation.sourceId]));
    if (expense) obligations.push({ ...expense, allocationId: allocation.id, allocatedMinor: allocation.amountMinor, ...await expenseBalanceTx(tx, expense.id) });
  }
  const offsets = await rows(tx, 'payroll_offsets', 'WHERE payroll_id=?', [id]);
  const payments = (await rows(tx, 'cash_entries', "WHERE source_type='payroll_payment' AND reversal_of IS NULL")).filter(p => p.payrollId === id);
  const reversed = new Set((await rows(tx, 'cash_entries', 'WHERE reversal_of IS NOT NULL')).map(e => e.reversalOf));
  const activePayments = payments.filter(p => !reversed.has(p.id));
  const outstandingMinor = sum(obligations, e => e.outstandingMinor);
  const creditMinor = sum(obligations.filter(e => e.amountMinor < 0), e => e.creditMinor);
  const appliedAdvances = (await rows(tx, 'expense_payments')).filter(p => p.payrollId === id && p.advance);
  const carriedCredits = [];
  for (const expense of (await expenseCandidates(tx, payroll.personId, payroll.endOnExclusive)).filter(e => e.amountMinor < 0)) {
    const balance = await expenseBalanceTx(tx, expense.id);
    if (balance.creditMinor) carriedCredits.push({ ...expense, ...balance });
  }
  const advances = await availableAdvances(tx, payroll.personId, bogotaDate());
  const availableCreditMinor = sum(carriedCredits, e => e.creditMinor);
  const advanceAvailableMinor = sum(advances, a => a.availableMinor);
  const paidMinor = sum(obligations, e => e.paidMinor), offsetMinor = sum(active(offsets));
  const state = payroll.state === 'draft' ? 'draft' : outstandingMinor === 0 && creditMinor === 0 ? 'paid' : paidMinor > 0 || offsetMinor > 0 ? 'partial' : 'confirmed';
  return { ...payroll, state, obligations, allocations: assigned, offsets, activeOffsets: active(offsets), advances, carriedCredits, availableCreditMinor, advanceAvailableMinor, payments, activePayments, earnedMinor: sum(obligations), paidMinor, offsetMinor, advanceAppliedMinor: sum(appliedAdvances), outstandingMinor, creditMinor, netMinor: signed(outstandingMinor - creditMinor), amountToPayMinor: Math.max(0, outstandingMinor - availableCreditMinor - advanceAvailableMinor), payrollPaymentId: activePayments.at(-1)?.sourceId || null };
}

export async function preparePayroll(store, input, actorId) {
  const execute = async tx => {
    const { startOn, endOnExclusive } = periodInput(input), person = await requirePerson(tx, input.personId);
    const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('payroll_periods')} WHERE person_id=? AND start_on=? AND end_on_exclusive=?`, [person.id, startOn, endOnExclusive]));
    if (existing) return getPayroll(tx, existing.id);
    const throughOn = addDays(endOnExclusive, -1) <= bogotaDate() ? addDays(endOnExclusive, -1) : addDays(bogotaDate(), -1);
    const facts = salaryFacts(person, throughOn), expenses = await expenseCandidates(tx, person.id, endOnExclusive);
    const assigned = new Set((await rows(tx, 'payroll_allocations', "WHERE source_type='expense'")).map(a => a.sourceId));
    const sources = new Set(expenses.map(e => e.sourceKey));
    const completedDates = new Set(expenses.filter(e => e.agreementId).map(e => e.incurredOn));
    const frozen = await rows(tx, 'payroll_periods', 'WHERE person_id=?', [person.id]);
    const missingAccruals = facts.filter(f => !sources.has(f.sourceKey) && !completedDates.has(f.incurredOn) && !frozen.some(p => p.startOn <= f.incurredOn && p.endOnExclusive > f.incurredOn));
    const obligations = [];
    for (const expense of expenses) if (!assigned.has(expense.id)) obligations.push({ ...expense, ...await expenseBalanceTx(tx, expense.id) });
    const carriedCredits = [];
    for (const expense of expenses.filter(e => e.amountMinor < 0)) {
      const balance = await expenseBalanceTx(tx, expense.id);
      if (balance.creditMinor) carriedCredits.push({ ...expense, ...balance });
    }
    const advances = await availableAdvances(tx, person.id, bogotaDate());
    const outstandingMinor = sum(obligations, e => e.outstandingMinor) + sum(missingAccruals);
    const creditMinor = sum(carriedCredits, e => e.creditMinor), advanceAvailableMinor = sum(advances, a => a.availableMinor);
    const advanceToApplyMinor = Math.min(advanceAvailableMinor, Math.max(0, outstandingMinor - creditMinor));
    return { id: null, version: null, state: 'draft', personId: person.id, startOn, endOnExclusive, obligations, missingAccruals, missingDayCount: missingAccruals.length, carriedCredits, advances, earnedMinor: signed(sum(obligations) + sum(missingAccruals)), outstandingMinor: moneyMinor(outstandingMinor), creditMinor, advanceAvailableMinor, advanceToApplyMinor, netMinor: signed(outstandingMinor - creditMinor - advanceToApplyMinor), amountToPayMinor: Math.max(0, outstandingMinor - creditMinor - advanceToApplyMinor) };
  };
  return store.readSnapshot ? store.readSnapshot(execute) : execute(store);
}

async function writePayment(tx, expenseId, amountMinor, cashEntryId, data, reversalOf = null) {
  const id = newId();
  await insertRow(tx, 'expense_payments', { id, expense_id: expenseId, kind: reversalOf ? 'reversal' : 'payment', cash_entry_id: cashEntryId, settlement_receipt_id: null, amount_minor: signed(amountMinor), reversal_of: reversalOf, recorded_at: stamp(), data: JSON.stringify(data) });
  return id;
}
async function allocateExpense(tx, payrollId, expense) {
  const previous = await tx.db.get(`SELECT id,payroll_id FROM ${tx.t('payroll_allocations')} WHERE source_type='expense' AND source_id=?`, [expense.id]);
  if (previous) return previous.payroll_id === payrollId;
  const balance = await expenseBalanceTx(tx, expense.id);
  const amountMinor = expense.amountMinor > 0 ? balance.outstandingMinor : -balance.creditMinor;
  if (!amountMinor) return false;
  await insertRow(tx, 'payroll_allocations', { id: newId(), payroll_id: payrollId, source_type: 'expense', source_id: expense.id, amount_minor: amountMinor, recorded_at: stamp() });
  return true;
}
async function applyOffsetsAndAdvances(tx, payroll, actorId) {
  const assigned = await allocations(tx, payroll.id), positives = [];
  for (const a of assigned.filter(a => a.sourceType === 'expense')) {
    const expense = entity(await tx.db.get(`SELECT * FROM ${tx.t('expenses')} WHERE id=?`, [a.sourceId]));
    if (expense?.amountMinor > 0) positives.push(expense);
  }
  positives.sort(oldest);
  const credits = (await expenseCandidates(tx, payroll.personId, payroll.endOnExclusive)).filter(e => e.amountMinor < 0);
  for (const debit of positives) {
    for (const credit of credits) {
      const debitBalance = await expenseBalanceTx(tx, debit.id), creditBalance = await expenseBalanceTx(tx, credit.id);
      const amount = Math.min(debitBalance.outstandingMinor, creditBalance.creditMinor);
      if (!amount) continue;
      const offset = { id: newId(), payroll_id: payroll.id, debit_expense_id: debit.id, credit_expense_id: credit.id, amount_minor: amount, reversal_of: null, recorded_at: stamp() };
      await insertRow(tx, 'payroll_offsets', offset);
      await audit(tx, { entityType: 'payroll_offset', entityId: offset.id, actorId, next: offset });
    }
  }
  for (const advance of await availableAdvances(tx, payroll.personId, bogotaDate())) {
    let available = advance.availableMinor;
    const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('payroll_allocations')} WHERE payroll_id=? AND source_type='advance' AND source_id=?`, [payroll.id, advance.id]));
    const applications = [];
    for (const expense of positives) {
      const amount = Math.min(available, (await expenseBalanceTx(tx, expense.id)).outstandingMinor);
      if (amount) { applications.push({ expense, amount }); available -= amount; }
    }
    const applied = advance.availableMinor - available;
    if (!applied) continue;
    // Reapplication references the same immutable allocation, within its original cap.
    const priorApplied = existing ? sum((await rows(tx, 'expense_payments', 'WHERE cash_entry_id=?', [advance.id])).filter(p => p.advanceAllocationId === existing.id)) : 0;
    if (existing && applied + priorApplied > existing.amountMinor) continue;
    const allocationId = existing?.id || newId();
    if (!existing) await insertRow(tx, 'payroll_allocations', { id: allocationId, payroll_id: payroll.id, source_type: 'advance', source_id: advance.id, amount_minor: applied, recorded_at: stamp() });
    for (const { expense, amount } of applications) await writePayment(tx, expense.id, amount, advance.id, { payrollId: payroll.id, advance: true, advanceAllocationId: allocationId });
  }
}
async function refreshPayroll(tx, payrollId) {
  const detail = await getPayroll(tx, payrollId);
  const state = detail.outstandingMinor === 0 && detail.creditMinor === 0 ? 'paid' : detail.paidMinor > 0 || detail.offsetMinor > 0 ? 'partial' : 'confirmed';
  await updateVersioned(tx, 'payroll_periods', detail.id, detail.version, { state });
  return getPayroll(tx, payrollId);
}
export async function confirmPayrollTx(tx, input, actorId) {
  const { startOn, endOnExclusive } = periodInput(input), endOn = addDays(endOnExclusive, -1);
  if (endOn > bogotaDate()) fail('No se puede confirmar un período futuro.');
  const person = await requirePerson(tx, input.personId);
  const existing = entity(await tx.db.get(`SELECT * FROM ${tx.t('payroll_periods')} WHERE person_id=? AND start_on=? AND end_on_exclusive=?`, [person.id, startOn, endOnExclusive]));
  if (input.payrollId && input.payrollId !== existing?.id) fail('Período de sueldo no encontrado.', 404);
  if (existing) {
    integer(input.version, 'Versión', 1);
    if (input.version !== existing.version) fail('El período cambió. Recarga antes de confirmar.', 409);
    fail('El período ya está confirmado.', 409);
  }
  const overlapping = await tx.db.get(`SELECT id FROM ${tx.t('payroll_periods')} WHERE person_id=? AND start_on<? AND end_on_exclusive>?`, [person.id, endOnExclusive, startOn]);
  if (overlapping) fail('El período se superpone con otro sueldo confirmado.', 409);
  await materializePayrollAccrualsTx(tx, { throughOn: endOn, personId: person.id, actorId, completeCurrentDay: true });
  const now = stamp(), id = newId(), bonusMinor = moneyMinor(input.bonusMinor ?? 0, 'Bonificación'), discountMinor = moneyMinor(input.discountMinor ?? 0, 'Descuento');
  const candidates = await expenseCandidates(tx, person.id, endOnExclusive);
  const alreadyAssigned = new Set((await rows(tx, 'payroll_allocations', "WHERE source_type='expense'")).map(a => a.sourceId));
  const base = candidates.filter(e => e.amountMinor > 0 && !alreadyAssigned.has(e.id));
  let remunerationAvailableMinor = bonusMinor;
  for (const expense of base) remunerationAvailableMinor = moneyMinor(remunerationAvailableMinor + (await expenseBalanceTx(tx, expense.id)).outstandingMinor);
  if (discountMinor > remunerationAvailableMinor) fail('El descuento supera la remuneración disponible de origen.');
  const reason = bonusMinor || discountMinor ? text(input.reason, 'Concepto de bonificación/descuento', 1000, true) : text(input.reason || '', 'Motivo', 1000);
  const agreement = (person.salaryAgreements || []).find(a => a.enabled !== false && a.effectiveFrom <= endOn && (!a.effectiveTo || a.effectiveTo >= endOn));
  await insertRow(tx, 'payroll_periods', { id, person_id: person.id, start_on: startOn, end_on_exclusive: endOnExclusive, due_on: addDays(endOn, agreement?.payDayOffset || 0), state: 'confirmed', version: 1, created_at: now, updated_at: now, data: JSON.stringify({ reason, bonusMinor, discountMinor, salaryAgreements: person.salaryAgreements || [] }) });
  if (bonusMinor) {
    const bonus = await createExpense(tx, { category: 'bonus', personId: person.id, amountMinor: bonusMinor, incurredOn: endOn, sourceKey: `payroll:${id}:bonus`, payrollId: id, reason }, actorId);
    candidates.push(bonus);
    base.push(bonus);
  }
  if (discountMinor) candidates.push(await createExpense(tx, { category: 'salary', personId: person.id, amountMinor: -discountMinor, incurredOn: endOn, sourceKey: `payroll:${id}:discount`, payrollId: id, baseExpenseIds: base.map(e => e.id), reason }, actorId));
  for (const expense of candidates) await allocateExpense(tx, id, expense);
  const payroll = entity(await tx.db.get(`SELECT * FROM ${tx.t('payroll_periods')} WHERE id=?`, [id]));
  await applyOffsetsAndAdvances(tx, payroll, actorId);
  await audit(tx, { entityType: 'payroll', entityId: id, actorId, next: await getPayroll(tx, id), reason });
  await bumpRevision(tx, [startOn, endOn]);
  return refreshPayroll(tx, id);
}
export function confirmPayroll(store, input, actorId) { return runCommand(store, { scope: 'payroll-confirm', requestId: input.requestId, payload: input, actorId }, tx => confirmPayrollTx(tx, input, actorId)); }
export async function payPayrollTx(tx, input, actorId) {
  const payroll = await getPayroll(tx, input.payrollId);
  integer(input.version, 'Versión', 1);
  if (payroll.version !== input.version) fail('El período cambió. Recarga antes de pagar.', 409);
  const effectiveOn = businessDate(input.effectiveOn), amountMinor = moneyMinor(input.amountMinor, 'Pago');
  if (!amountMinor) fail('El pago debe ser positivo.');
  await applyOffsetsAndAdvances(tx, payroll, actorId);
  const current = await getPayroll(tx, payroll.id);
  if (amountMinor > current.outstandingMinor) fail('El pago supera el saldo pendiente.');
  const payrollPaymentId = newId();
  const cash = await postCashEntryTx(tx, { accountId: input.accountId, effectiveOn, amountMinor: -amountMinor, kind: 'payroll_payment', sourceType: 'payroll_payment', sourceId: payrollPaymentId, data: { payrollId: payroll.id, personId: payroll.personId, concept: 'Pago de remuneración' } }, actorId);
  let remaining = amountMinor;
  for (const expense of current.obligations.filter(e => e.amountMinor > 0).sort(oldest)) {
    const amount = Math.min(remaining, (await expenseBalanceTx(tx, expense.id)).outstandingMinor);
    if (amount) { await writePayment(tx, expense.id, amount, cash.id, { payrollId: payroll.id, payrollPaymentId }); remaining -= amount; }
  }
  await audit(tx, { entityType: 'payroll_payment', entityId: payrollPaymentId, actorId, next: { payrollId: payroll.id, amountMinor, effectiveOn, cashEntryId: cash.id } });
  await bumpRevision(tx, [effectiveOn]);
  return { ...await refreshPayroll(tx, payroll.id), payrollPaymentId, cashEntryId: cash.id };
}
export function payPayroll(store, input, actorId) { return runCommand(store, { scope: 'payroll-pay', requestId: input.requestId, payload: input, actorId }, tx => payPayrollTx(tx, input, actorId)); }

export async function reverseAdvanceTx(tx, advanceId, { effectiveOn, reason, actorId }) {
  const advance = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE id=? AND kind='advance'`, [advanceId]));
  if (!advance || advance.reversalOf) fail('Anticipo no encontrado.', 404);
  const dependencies = active(await rows(tx, 'expense_payments', 'WHERE cash_entry_id=?', [advance.id]));
  if (dependencies.length) fail(`Deshaz primero la aplicación del anticipo en el sueldo ${dependencies[0].payrollId || dependencies[0].id}.`, 409);
  return reverseLinkedCashTx(tx, advance.id, effectiveOn, text(reason, 'Motivo', 1000, true), actorId);
}
export async function reversePayrollPaymentTx(tx, paymentId, { effectiveOn, reason, actorId }) {
  const cash = entity(await tx.db.get(`SELECT * FROM ${tx.t('cash_entries')} WHERE (id=? OR source_id=?) AND source_type='payroll_payment' AND reversal_of IS NULL`, [paymentId, paymentId]));
  reason = text(reason, 'Motivo', 1000, true);
  effectiveOn = businessDate(effectiveOn);
  if (effectiveOn > bogotaDate()) fail('No se puede revertir en una fecha futura.');
  const payrollId = cash?.payrollId || paymentId;
  let reversal = null;
  if (cash) {
    reversal = await reverseLinkedCashTx(tx, cash.id, effectiveOn, reason, actorId);
    for (const payment of active(await rows(tx, 'expense_payments', 'WHERE cash_entry_id=?', [cash.id]))) await writePayment(tx, payment.expenseId, -payment.amountMinor, reversal.id, { payrollId, payrollPaymentId: cash.sourceId, reason }, payment.id);
  }
  const detail = await getPayroll(tx, payrollId);
  if (!cash && (detail.activePayments.length || (!detail.activeOffsets.length && !detail.advanceAppliedMinor))) fail('No hay una aplicación sin caja que se pueda revertir; selecciona el pago vigente.', 409);
  // Shared compensation/advance facts belong to the confirmed period. Undo both faces
  // when its last real payment is undone; partial-payment reversals do not steal them.
  if (!detail.activePayments.length) {
    for (const offset of detail.activeOffsets) await insertRow(tx, 'payroll_offsets', { id: newId(), payroll_id: detail.id, debit_expense_id: offset.debitExpenseId, credit_expense_id: offset.creditExpenseId, amount_minor: offset.amountMinor, reversal_of: offset.id, recorded_at: stamp() });
    const advances = active((await rows(tx, 'expense_payments')).filter(p => p.payrollId === detail.id && p.advance));
    const reversedIds = new Set(detail.reversedAdvanceAllocationIds || []);
    for (const payment of advances) {
      await writePayment(tx, payment.expenseId, -payment.amountMinor, payment.cashEntryId, { payrollId: detail.id, advance: true, advanceAllocationId: payment.advanceAllocationId, reason }, payment.id);
      reversedIds.add(payment.advanceAllocationId);
    }
    const raw = await tx.db.get(`SELECT data FROM ${tx.t('payroll_periods')} WHERE id=?`, [detail.id]);
    await updateVersioned(tx, 'payroll_periods', detail.id, detail.version, { data: JSON.stringify({ ...JSON.parse(raw.data), reversedAdvanceAllocationIds: [...reversedIds] }) });
  }
  await audit(tx, { entityType: 'payroll_payment', entityId: cash?.sourceId || payrollId, actorId, previous: cash || detail, next: reversal || { applicationsReversed: true }, reason });
  await bumpRevision(tx, [effectiveOn]);
  return { ...await refreshPayroll(tx, payrollId), reversalId: reversal?.id || null, payrollPaymentId: cash?.sourceId || payrollId };
}

function commissionAmount(rule, base, originalBase) {
  if (base <= 0 || originalBase <= 0) return 0;
  return moneyMinor(rule.mode === 'fixed' ? roundRatio(BigInt(rule.fixedMinor) * BigInt(base), BigInt(originalBase)) : roundRatio(BigInt(base) * BigInt(rule.rateBps), 10000n), 'Comisión');
}
function collectionSign(row, byId) {
  if (row.kind !== 'reversal') return row.kind === 'refund' ? -1 : 1;
  const original = byId.get(row.reversalOf);
  if (!original) fail('Cobro original no encontrado.', 409);
  return -collectionSign(original, byId);
}
async function deliveryDate(tx, order) {
  if (!order.deliverySummary?.complete) return null;
  const shipments = await rows(tx, 'shipments', 'WHERE order_id=?', [order.id]);
  const replaced = new Set(shipments.map(s => s.replacesShipmentId).filter(Boolean)), delivered = new Map();
  let on = null;
  for (const shipment of shipments) {
    if (replaced.has(shipment.id) || shipment.status === 'cancelled') continue;
    const events = effectiveShipmentEvents(await rows(tx, 'shipment_events', 'WHERE shipment_id=?', [shipment.id]));
    const event = events.filter(e => e.status === 'delivered' && (e.occurredOn || e.occurredAt)).sort((a, b) => (a.occurredOn || bogotaDate(a.occurredAt)).localeCompare(b.occurredOn || bogotaDate(b.occurredAt)))[0];
    if (!event) continue;
    const date = event.occurredOn || bogotaDate(event.occurredAt);
    on = !on || date > on ? date : on;
    for (const allocation of shipment.assignments || []) delivered.set(allocation.lineId, (delivered.get(allocation.lineId) || 0) + allocation.quantity);
  }
  return order.items.every(line => (delivered.get(line.lineId) || 0) >= line.quantity) ? on : null;
}

// Compare the desired historical ledger by date, not just its final sum. Corrections
// therefore move/withdraw expense recognition without rewriting a paid monetary fact.
export async function reconcileCommissionsTx(tx, orderId, { actorId, asOf = stamp(), adjustmentOn = null, reason = 'Reconciliación de comisión' }) {
  const raw = await tx.db.get(`SELECT * FROM ${tx.t('orders')} WHERE id=?`, [orderId]);
  if (!raw) fail('Pedido no encontrado.', 404);
  const order = { ...JSON.parse(raw.data), id: raw.id }, throughOn = bogotaDate(asOf);
  if (adjustmentOn) businessDate(adjustmentOn);
  const entries = await rows(tx, 'commission_entries', 'WHERE order_id=?', [orderId]);
  const collections = await rows(tx, 'order_collections', 'WHERE order_id=?', [orderId]);
  const returns = (await rows(tx, 'order_returns', 'WHERE order_id=?', [orderId])).filter(r => r.occurredOn <= throughOn);
  const collectionIds = new Set(collections.map(c => c.id)), byId = new Map(collections.map(c => [c.id, c]));
  const receipts = (await rows(tx, 'settlement_receipts')).filter(r => (r.lines || []).some(line => collectionIds.has(line.collectionId)));
  const rule = order.ruleSnapshot?.commission;
  // An undated imported platform observation is not dated payment evidence.
  // Delivery or an actual settlement receipt can still supply their own dates.
  const unresolvedCollections = active(collections).some(c => c.holder === 'legacy' || c.requiresReconciliation === true || (!c.occurredOn && c.requiresDateReview !== true));
  const legacyBlocked = order.policyReviewRequired || order.legacyPolicyReview || (order.legacyFinancialReview?.required && !['resolved', 'reconciled'].includes(order.legacyFinancialReview.state)) || unresolvedCollections;
  const desired = new Map();
  const originalBase = sum(order.items, line => line.quantity * line.unitPriceMinor - line.discountMinor);
  if (rule?.enabled && order.sellerId && order.recognition?.on && !legacyBlocked && originalBase > 0) {
    const deliveredOn = rule.earnWhen === 'delivered' ? await deliveryDate(tx, order) : null;
    const timeline = new Set([order.recognition.on, deliveredOn, ...collections.map(c => c.occurredOn), ...receipts.map(r => r.receivedOn), ...returns.map(r => r.occurredOn)].filter(on => on && on <= throughOn));
    let previous = 0;
    for (const on of [...timeline].sort()) {
      if (on < order.recognition.on) continue;
      const credits = returns.filter(r => r.occurredOn <= on), productCredits = sum(credits, r => sum(r.lines || [], l => l.salesCreditMinor || 0));
      const shippingCredits = sum(credits, r => r.shippingCreditMinor || 0);
      const base = Math.max(0, originalBase - productCredits), due = Math.max(0, order.totalMinor - productCredits - shippingCredits);
      // Reversing an undated observation cannot withdraw dated eligibility it never supplied.
      const facts = collections.filter(c => c.occurredOn && c.occurredOn <= on && (!c.reversalOf || byId.get(c.reversalOf)?.occurredOn));
      let paid = 0;
      if (rule.earnWhen === 'business_received') {
        paid = sum(facts.filter(c => c.holder === 'business' || c.kind === 'refund' || (c.kind === 'reversal' && byId.get(c.reversalOf)?.kind === 'refund')), c => collectionSign(c, byId) * c.amountMinor);
        paid += sum(receipts.filter(r => r.receivedOn <= on), r => (r.reversalOf ? -1 : 1) * sum(r.lines || [], l => collectionIds.has(l.collectionId) ? l.grossMinor : 0));
      } else paid = sum(facts, c => collectionSign(c, byId) * c.amountMinor);
      const eligible = rule.earnWhen === 'delivered' ? deliveredOn && deliveredOn <= on : paid >= due;
      const target = eligible ? commissionAmount(rule, base, originalBase) : 0;
      const delta = signed(target - previous);
      if (delta) desired.set(`${order.sellerId}|${on}`, delta);
      previous = target;
    }
  }
  const actual = new Map();
  for (const entry of entries.filter(e => e.earnedOn <= throughOn)) {
    const key = `${entry.personId}|${entry.earnedOn}`;
    actual.set(key, signed((actual.get(key) || 0) + entry.amountMinor));
  }
  const created = [];
  for (const key of new Set([...actual.keys(), ...desired.keys()])) {
    const delta = signed((desired.get(key) || 0) - (actual.get(key) || 0));
    if (!delta) continue;
    const separator = key.lastIndexOf('|'), personId = key.slice(0, separator), earnedOn = key.slice(separator + 1);
    const original = [...entries, ...created].find(e => e.personId === personId && e.amountMinor > 0);
    const sourceKey = `commission:${orderId}:${hash({ key, desired: desired.get(key) || 0, previous: actual.get(key) || 0, sequence: entries.length + created.length }).slice(0, 32)}`;
    const expense = await createExpense(tx, { category: 'commission', amountMinor: delta, incurredOn: earnedOn, personId, orderId, sourceKey, originalCommissionId: original?.id || null, originalExpenseId: original?.expenseId || null, reason, correction: !returns.some(r => r.occurredOn === earnedOn), ruleSnapshot: order.ruleSnapshot }, actorId);
    const id = newId();
    await insertRow(tx, 'commission_entries', { id, order_id: orderId, person_id: personId, earned_on: earnedOn, amount_minor: delta, source_key: sourceKey, expense_id: expense.id, rule_snapshot: JSON.stringify(order.ruleSnapshot || {}), recorded_at: stamp() });
    await audit(tx, { entityType: 'commission', entityId: id, actorId, previous: { amountMinor: actual.get(key) || 0, earnedOn }, next: { amountMinor: desired.get(key) || 0, adjustmentMinor: delta, expenseId: expense.id, earnedOn }, reason, source: 'commission' });
    created.push({ id, expenseId: expense.id, amountMinor: delta, earnedOn, personId });
  }
  return { orderId, blocked: !!legacyBlocked, amountMinor: sum([...desired.values()], value => value), createdCount: created.length, entries: created };
}
