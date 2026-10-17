import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db/index.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { runCommand } from '../lib/business/commands.mjs';
import { bogotaDate, addDays } from '../lib/business/dates.mjs';
import { MAX_MONEY_MINOR } from '../lib/business/money.mjs';
import { saveAccount, accountBalance, postCashEntryTx, reverseLinkedCashTx, recordIncome, recordAdvance, transferMoney, closeCash, reopenCash, reverseCashEntry } from '../lib/business/cash.mjs';

async function fixture(fn) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  let sequence = 0;
  const request = () => `cash-test-${String(++sequence).padStart(5, '0')}`;
  const today = bogotaDate(), openingOn = addDays(today, -6);
  const actor = 'cash-admin';
  try {
    const person = await saveResource(store, 'people', { name: 'Responsable real', requestId: request() }, actor);
    const account = (overrides = {}) => saveAccount(store, { name: 'Cuenta de prueba', type: 'bank', responsibleId: person.id, openingOn, openingBalanceMinor: 0, requestId: request(), ...overrides }, actor);
    const income = (accountId, amountMinor, effectiveOn = today, overrides = {}) => recordIncome(store, { accountId, amountMinor, effectiveOn, concept: 'owner_funding', requestId: request(), ...overrides }, actor);
    const post = input => runCommand(store, { scope: 'test:cash-entry', requestId: request(), payload: input, actorId: actor }, tx => postCashEntryTx(tx, input, actor));
    await fn({ store, request, actor, today, openingOn, person, account, income, post });
  } finally { await store.close(); }
}
const count = async (store, table) => (await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n;

test('cuentas exigen apertura explícita, responsable activo, importes seguros y configuración versionada', () => fixture(async ({ store, account, person, request, actor, openingOn, today }) => {
  for (const overrides of [{ openingBalanceMinor: undefined }, { responsibleId: '' }, { responsibleId: 'missing' }, { openingOn: addDays(today, 1) }, { openingBalanceMinor: 0.5 }, { openingBalanceMinor: MAX_MONEY_MINOR + 1 }, { closingEnabled: true }, { closingTime: '25:00' }, { toleranceMinor: -1 }]) {
    await assert.rejects(() => account(overrides), { status: 400 });
  }
  assert.equal(await count(store, 'cash_accounts'), 0);
  assert.equal(await count(store, 'cash_entries'), 0);
  const cash = await account({ type: 'cash', closingEnabled: true, closingTime: '18:30', minimumMinor: 100, toleranceMinor: 5 });
  assert.equal(cash.balanceMinor, 0);
  assert.equal(cash.minimumMinor, 100);
  assert.equal(cash.closingEnabled, true);
  const opening = await store.db.get(`SELECT * FROM ${store.t('cash_entries')} WHERE account_id=?`, [cash.id]);
  assert.equal(opening.kind, 'opening');
  assert.equal(opening.amount_minor, 0);
  assert.equal(opening.effective_on, openingOn);
  assert.equal(JSON.parse(opening.data).actorId, actor);
  const edited = await saveAccount(store, { version: cash.version, name: 'Caja local', minimumMinor: null, requestId: request() }, actor, cash.id);
  assert.equal(edited.version, 2);
  assert.equal(edited.minimumMinor, null);
  assert.equal(edited.closingTime, '18:30');
  await assert.rejects(() => saveAccount(store, { version: 1, name: 'Obsoleto', requestId: request() }, actor, cash.id), { status: 409 });
  for (const change of [{ openingOn: addDays(openingOn, 1) }, { openingBalanceMinor: 1 }, { type: 'bank' }]) await assert.rejects(() => saveAccount(store, { ...change, version: edited.version, requestId: request() }, actor, cash.id), { status: 409 });
  await saveResource(store, 'people', { name: person.name, active: false, version: person.version, requestId: request() }, actor, person.id);
  await assert.rejects(() => account(), { status: 400 });
  assert.equal(await count(store, 'cash_accounts'), 1);
}));

test('saldos usan fecha efectiva inclusiva; ingresos no son ventas y anticipos no generan gasto', () => fixture(async ({ store, account, income, today, openingOn, person, actor, request }) => {
  const bank = await account({ openingBalanceMinor: 1000 });
  const firstOn = addDays(openingOn, 1), secondOn = addDays(openingOn, 3);
  const receipt = await income(bank.id, 500, firstOn, { concept: 'other_non_sale', description: 'Recuperación no comercial', reference: 'REF-01' });
  assert.equal(receipt.kind, 'income');
  assert.equal(receipt.concept, 'other_non_sale');
  assert.equal(receipt.nonSale, true);
  const advance = await recordAdvance(store, { personId: person.id, accountId: bank.id, effectiveOn: secondOn, amountMinor: 2000, concept: 'Anticipo acordado', reference: 'ADV-01', requestId: request() }, actor);
  assert.equal(advance.kind, 'advance');
  assert.equal(advance.sourceId, advance.id);
  assert.equal(advance.personId, person.id);
  assert.equal(advance.amountMinor, -2000);
  assert.equal(advance.balanceMinor, -500);
  assert.equal(advance.warnings.length, 1);
  assert.equal(await accountBalance(store, bank.id, addDays(openingOn, -1)), 0);
  assert.equal(await accountBalance(store, bank.id, openingOn), 1000);
  assert.equal(await accountBalance(store, bank.id, firstOn), 1500);
  assert.equal(await accountBalance(store, bank.id, secondOn), -500);
  assert.equal(await accountBalance(store, bank.id, today), -500);
  assert.equal(await count(store, 'expenses'), 0);
  assert.equal(await count(store, 'order_collections'), 0);
  const audit = await store.db.get(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='cash_entry' AND entity_id=?`, [advance.id]);
  assert.equal(JSON.parse(audit.data).next.reference, 'ADV-01');
  await assert.rejects(() => income(bank.id, 1, addDays(today, 1)), { status: 400 });
  await assert.rejects(() => income(bank.id, 1, addDays(openingOn, -1)), { status: 400 });
  await assert.rejects(() => income(bank.id, 0), { status: 400 });
  await assert.rejects(() => income(bank.id, 1, today, { concept: 'sale' }), { status: 400 });
  await assert.rejects(() => recordAdvance(store, { personId: 'missing', accountId: bank.id, effectiveOn: today, amountMinor: 1, concept: 'Anticipo', requestId: request() }, actor), { status: 400 });
}));

test('transferencias son atómicas, conservan el consolidado y se revierten completas una sola vez', () => fixture(async ({ store, account, request, actor, openingOn, today }) => {
  const bank = await account({ openingBalanceMinor: 1000 });
  const wallet = await account({ type: 'wallet', openingOn: addDays(openingOn, 2) });
  const input = { fromAccountId: bank.id, toAccountId: wallet.id, amountMinor: 200, effectiveOn: addDays(openingOn, 1), concept: 'Traslado entre cuentas', requestId: request() };
  await assert.rejects(() => transferMoney(store, input, actor), { status: 400 });
  assert.equal(await count(store, 'cash_entries'), 2);
  assert.equal(await accountBalance(store, bank.id), 1000);
  const transferred = await transferMoney(store, { ...input, effectiveOn: today, requestId: request() }, actor);
  assert.equal(transferred.entries.length, 2);
  assert.equal(transferred.entries.reduce((sum, row) => sum + row.amountMinor, 0), 0);
  assert.ok(transferred.entries.every(row => row.transferId === transferred.transferId && row.kind === 'transfer'));
  assert.equal(await accountBalance(store, bank.id), 800);
  assert.equal(await accountBalance(store, wallet.id), 200);
  const reverseInput = { cashEntryId: transferred.entries[0].id, effectiveOn: today, reason: 'Traslado equivocado', requestId: request() };
  const reversed = await reverseCashEntry(store, reverseInput, actor);
  assert.equal(reversed.entries.length, 2);
  assert.ok(reversed.entries.every(row => row.kind === 'reversal' && row.reason === reverseInput.reason));
  assert.equal(await accountBalance(store, bank.id), 1000);
  assert.equal(await accountBalance(store, wallet.id), 0);
  assert.deepEqual(await reverseCashEntry(store, reverseInput, actor), reversed);
  await assert.rejects(() => reverseCashEntry(store, { ...reverseInput, cashEntryId: transferred.entries[1].id, requestId: request() }, actor), { status: 409 });
  await assert.rejects(() => transferMoney(store, { ...input, fromAccountId: wallet.id, toAccountId: wallet.id, requestId: request() }, actor), { status: 400 });
  assert.equal(await count(store, 'cash_entries'), 6);
}));

test('cierres comparan sin ajustar caja; reapertura auditada conserva revisión y libera el corte', () => fixture(async ({ store, account, income, request, actor, openingOn, today }) => {
  const cash = await account({ type: 'cash', openingBalanceMinor: 1000 });
  const bank = await account();
  const closingOn = addDays(openingOn, 2);
  await income(cash.id, 100, closingOn);
  const closed = await closeCash(store, { accountId: cash.id, closingOn, countedMinor: 1090, requestId: request() }, actor);
  assert.equal(closed.expectedMinor, 1100);
  assert.equal(closed.countedMinor, 1090);
  assert.equal(closed.differenceMinor, -10);
  assert.equal(closed.revision, 1);
  assert.equal(closed.responsibleId, cash.responsibleId);
  assert.equal(await accountBalance(store, cash.id), 1100);
  for (const on of [openingOn, closingOn]) await assert.rejects(() => income(cash.id, 1, on), { status: 409 });
  await income(cash.id, 10, addDays(closingOn, 1));
  await assert.rejects(() => closeCash(store, { accountId: cash.id, closingOn, countedMinor: 1100, requestId: request() }, actor), { status: 409 });
  await assert.rejects(() => closeCash(store, { accountId: bank.id, closingOn, countedMinor: 0, requestId: request() }, actor), { status: 400 });
  await assert.rejects(() => closeCash(store, { accountId: cash.id, closingOn: addDays(today, 1), countedMinor: 0, requestId: request() }, actor), { status: 400 });
  await assert.rejects(() => reopenCash(store, { closingId: closed.id, version: 2, reason: 'Corregir conteo', requestId: request() }, actor), { status: 409 });
  await assert.rejects(() => reopenCash(store, { closingId: closed.id, version: 1, reason: '', requestId: request() }, actor), { status: 400 });
  const reopened = await reopenCash(store, { closingId: closed.id, version: 1, reason: 'Conteo incompleto', requestId: request() }, actor);
  assert.equal(reopened.state, 'reopened');
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.version, 2);
  await income(cash.id, 20, closingOn);
  const closedAgain = await closeCash(store, { accountId: cash.id, closingOn, countedMinor: 1120, requestId: request() }, actor);
  assert.equal(closedAgain.revision, 2);
  assert.equal(closedAgain.expectedMinor, 1120);
  assert.equal(await accountBalance(store, cash.id), 1130);
  assert.equal(await count(store, 'cash_closings'), 2);
  const audits = await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='cash_closing' AND entity_id=?`, [closed.id]);
  assert.ok(audits.some(row => JSON.parse(row.data).previous?.state === 'closed' && JSON.parse(row.data).next.state === 'reopened'));
}));

test('cierres posteriores y archivo protegen transferencias/reversiones sin dejar una sola cara', () => fixture(async ({ store, account, request, actor, openingOn, today, income }) => {
  const bank = await account({ openingBalanceMinor: 1000 });
  const cash = await account({ type: 'cash' });
  const transfer = await transferMoney(store, { fromAccountId: bank.id, toAccountId: cash.id, effectiveOn: addDays(openingOn, 1), amountMinor: 100, concept: 'Provisión caja', requestId: request() }, actor);
  const early = await closeCash(store, { accountId: cash.id, closingOn: addDays(openingOn, 2), countedMinor: 100, requestId: request() }, actor);
  const later = await closeCash(store, { accountId: cash.id, closingOn: today, countedMinor: 100, requestId: request() }, actor);
  await assert.rejects(() => reopenCash(store, { closingId: early.id, version: 1, reason: 'Corregir historia', requestId: request() }, actor), { status: 409 });
  await assert.rejects(() => reverseCashEntry(store, { cashEntryId: transfer.entries[0].id, effectiveOn: today, reason: 'Corregir transferencia', requestId: request() }, actor), { status: 409 });
  assert.equal((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('cash_entries')} WHERE reversal_of IS NOT NULL`)).n, 0);
  assert.equal(await accountBalance(store, bank.id), 900);
  assert.equal(await accountBalance(store, cash.id), 100);
  await reopenCash(store, { closingId: later.id, version: 1, reason: 'Corregir historia', requestId: request() }, actor);
  await reopenCash(store, { closingId: early.id, version: 1, reason: 'Corregir historia', requestId: request() }, actor);
  const archived = await saveAccount(store, { active: false, version: bank.version, requestId: request() }, actor, bank.id);
  assert.equal(archived.active, false);
  await assert.rejects(() => income(bank.id, 1), { status: 409 });
  await assert.rejects(() => reverseCashEntry(store, { cashEntryId: transfer.entries[0].id, effectiveOn: today, reason: 'Cuenta archivada', requestId: request() }, actor), { status: 409 });
  assert.equal(await count(store, 'cash_entries'), 4);
  await saveAccount(store, { active: true, version: archived.version, requestId: request() }, actor, bank.id);
  await reverseCashEntry(store, { cashEntryId: transfer.entries[0].id, effectiveOn: today, reason: 'Traslado anulado', requestId: request() }, actor);
  assert.equal(await accountBalance(store, bank.id), 1000);
}));

test('comandos son idempotentes por actor y payload y reversión pública protege documentos financieros', () => fixture(async ({ store, account, person, actor, request, today, post }) => {
  const create = { name: 'Banco', type: 'bank', openingOn: today, openingBalanceMinor: 0, responsibleId: person.id, requestId: request() };
  const first = await saveAccount(store, create, actor);
  assert.deepEqual(await saveAccount(store, create, actor), first);
  await assert.rejects(() => saveAccount(store, { ...create, openingBalanceMinor: 1 }, actor), { status: 409 });
  await assert.rejects(() => saveAccount(store, create, 'another-admin'), { status: 409 });
  const input = { accountId: first.id, effectiveOn: today, amountMinor: 10, concept: 'owner_funding', requestId: request() };
  const [one, two] = await Promise.all([recordIncome(store, input, actor), recordIncome(store, input, actor)]);
  assert.deepEqual(one, two);
  assert.equal(await accountBalance(store, first.id), 10);
  const reversed = await reverseCashEntry(store, { cashEntryId: one.id, effectiveOn: today, reason: 'Aporte duplicado', requestId: request() }, actor);
  assert.equal(reversed.reversalOf, one.id);
  assert.equal(reversed.balanceMinor, 0);
  await assert.rejects(() => reverseCashEntry(store, { cashEntryId: reversed.id, effectiveOn: today, reason: 'Reversión inválida', requestId: request() }, actor), { status: 409 });
  const opening = await store.db.get(`SELECT id FROM ${store.t('cash_entries')} WHERE account_id=? AND kind='opening'`, [first.id]);
  await assert.rejects(() => reverseCashEntry(store, { cashEntryId: opening.id, effectiveOn: today, reason: 'Eliminar apertura', requestId: request() }, actor), { status: 409 });
  for (const kind of ['collection', 'refund', 'settlement', 'expense_payment', 'payroll_payment', 'advance', 'recovery']) {
    const row = await post({ accountId: first.id, effectiveOn: today, amountMinor: 1, kind, sourceType: kind, sourceId: `doc-${kind}` });
    await assert.rejects(() => reverseCashEntry(store, { cashEntryId: row.id, effectiveOn: today, reason: 'Reversión por caja no permitida', requestId: request() }, actor), { status: 409 });
  }
  const adjustment = await post({ accountId: first.id, effectiveOn: today, amountMinor: -1, kind: 'adjustment', sourceType: 'adjustment', sourceId: 'manual-adjustment', data: { concept: 'Ajuste explicado', reference: 'ADJ-01', reason: 'Corregir diferencia real' } });
  const reversal = await runCommand(store, { scope: 'test:linked-reversal', requestId: request(), actorId: actor, payload: { id: adjustment.id } }, tx => reverseLinkedCashTx(tx, adjustment.id, today, 'Documento corregido', actor));
  assert.equal(reversal.amountMinor, 1);
  assert.equal(reversal.sourceId, adjustment.sourceId);
  assert.equal(reversal.reference, 'ADJ-01');
  assert.ok(reversal.recordedAt);
  assert.equal(await count(store, 'cash_accounts'), 1);
}));

test('helper de caja rechaza cero, apertura repetida, reversión discrepante y fechas anteriores al original', () => fixture(async ({ store, account, post, actor, today, openingOn, request, income }) => {
  const bank = await account();
  const common = { accountId: bank.id, effectiveOn: today, sourceType: 'adjustment', sourceId: 'manual' };
  for (const fields of [{ amountMinor: 0, kind: 'adjustment' }, { amountMinor: 1, kind: 'invalid' }, { amountMinor: 0, kind: 'opening', effectiveOn: openingOn }, { amountMinor: MAX_MONEY_MINOR + 1, kind: 'adjustment' }, { amountMinor: 1, kind: 'reversal' }]) await assert.rejects(() => post({ ...common, ...fields }));
  const original = await income(bank.id, 10);
  await assert.rejects(() => post({ ...common, amountMinor: -9, kind: 'reversal', sourceType: 'income', sourceId: original.sourceId, reversalOf: original.id, data: { reason: 'Monto equivocado' } }), { status: 400 });
  await assert.rejects(() => reverseCashEntry(store, { cashEntryId: original.id, effectiveOn: addDays(today, -1), reason: 'Fecha inválida', requestId: request() }, actor), { status: 400 });
  assert.equal(await accountBalance(store, bank.id), 10);
  assert.equal(await count(store, 'cash_entries'), 2);
}));
