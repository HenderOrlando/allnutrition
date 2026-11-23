import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { getAdvisorTask, reserveAdvisorTask, updateAdvisorTask } from '../lib/assistant/advisor-tasks.mjs';
import { closeCash, recordIncome, reopenCash, reverseCashEntry, saveAccount } from '../lib/business/cash.mjs';
import { addDays, bogotaDate } from '../lib/business/dates.mjs';
import { financeQuery } from '../lib/business/finance.mjs';
import { saveResource } from '../lib/business/settings.mjs';

const capabilityId = 'cash.close-day';
const cashView = { section: 'cash', tab: 'overview' };
const password = 'synthetic-cash-advisor-password';

async function fixture(t, factory) {
  const store = await factory();
  t.after(() => store.close());
  async function authenticate(email) {
    await createAdmin(store, email, password);
    const { user, csrf, token } = await login(store, email, password);
    return { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') };
  }
  const owner = await authenticate('advisor-cash-owner@example.test');
  const other = await authenticate('advisor-cash-other@example.test');
  const now = new Date().toISOString(), actor = owner.user.id;
  await store.db.run(`INSERT INTO ${store.t('assistant_settings')} (id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,created_at,updated_at) VALUES(1,1,1,?,?,?,?,?,?,?)`, [
    JSON.stringify({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:3339/v1', model: 'synthetic-cash', allowPrivateNetwork: true, connectionStatus: 'ready', verifiedAt: now }),
    'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', actor, now, now,
  ]);
  const today = bogotaDate(), openingOn = addDays(today, -3), closingOn = addDays(today, -1);
  const person = await saveResource(store, 'people', { name: 'Responsable sintético', requestId: randomUUID() }, actor);
  const account = overrides => saveAccount(store, { requestId: randomUUID(), name: 'Caja A', type: 'cash', openingOn, openingBalanceMinor: 10_000_000, responsibleId: person.id, ...overrides }, actor);
  const reserve = () => reserveAdvisorTask(store, owner, { id: randomUUID(), capabilityId });
  const get = task => getAdvisorTask(store, owner, task.id);
  const answer = (task, value) => {
    const { id: questionId, field } = task.data.progress.question;
    return updateAdvisorTask(store, owner, task.id, { action: 'answer', version: task.version, step: task.step, questionId, field, value });
  };
  const resume = task => updateAdvisorTask(store, owner, task.id, { action: 'resume', version: task.version });
  const compare = (task, cash) => answer(task, cash.id).then(next => answer(next, closingOn)).then(next => answer(next, '98.000'));
  const review = cash => financeQuery(store, 'closings', { account: cash.id, closingOn, preview: '1', review: '1' });
  const facts = () => Promise.all(['cash_entries', 'cash_closings', 'business_audit', 'business_requests'].map(table =>
    store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY ${table === 'business_requests' ? 'scope,request_id' : 'id'}`)));
  return { store, owner, other, actor, today, openingOn, closingOn, person, account, reserve, get, answer, resume, compare, review, facts };
}

function nativeInput(selection) {
  const { id: accountId, version: accountVersion, closingOn, countedMinor, expectedMinor, reviewKey } = selection;
  return { requestId: randomUUID(), accountId, closingOn, countedMinor, cashClosingReview: { accountVersion, expectedMinor, reviewKey } };
}

export async function runAdvisorCashContracts(t, factory) {
  await t.test('C4 guía exige caja, fecha y conteo explícitos; cancela sin negocio y prueba el cierre nativo sin ajuste', async t => {
    const f = await fixture(t, factory);
    const empty = await f.reserve();
    assert.equal(empty.status, 'blocked');
    assert.equal(empty.step, 'configure-account');
    assert.deepEqual(empty.data.progress.action, { capabilityId, view: cashView, focus: 'cash-close-account', label: 'Abrir el formulario de una caja de efectivo', selection: null });
    const cash = await f.account();
    const bank = await f.account({ name: 'Banco sintético', type: 'bank' });
    const archived = await f.account({ name: 'Caja archivada' });
    await saveAccount(f.store, { requestId: randomUUID(), active: false, version: archived.version }, f.actor, archived.id);
    const before = await f.facts();
    const select = await f.resume(empty);
    assert.deepEqual(select.data.progress.question.options, [{ id: cash.id, label: cash.name }]);
    await assert.rejects(f.answer(select, cash.name), { status: 422 });
    await assert.rejects(f.answer(select, bank.id), { status: 422 });
    const date = await f.answer(select, cash.id);
    assert.equal(date.data.progress.question.field, 'closingOn');
    assert.equal(date.data.cash.closingOn, undefined);
    await assert.rejects(f.answer(date, 'hoy'), { status: 400 });
    await assert.rejects(f.answer(date, addDays(f.today, 1)), { status: 400 });
    const early = await f.answer(date, addDays(f.openingOn, -1));
    assert.equal(early.data.progress.question.field, 'closingOn');
    assert.match(early.data.progress.message, /anterior a la apertura/);
    const count = await f.answer(early, f.closingOn);
    assert.equal(count.data.progress.question.field, 'countedMinor');
    assert.equal(count.data.cash.countedMinor, undefined);
    await assert.rejects(f.answer(count, '98k'), { status: 400 });
    await assert.rejects(f.answer(count, '-98.000'), { status: 400 });
    const review = await f.answer(count, '98.000');
    assert.equal(review.status, 'waiting_human');
    assert.equal(review.step, 'review-close');
    const { focus, view, selection } = review.data.progress.action;
    assert.equal(focus, 'cash-close-form');
    assert.deepEqual(view, { ...cashView, account: cash.id, record: cash.id });
    assert.equal(selection.expectedMinor, 10_000_000);
    assert.equal(selection.countedMinor, 9_800_000);
    assert.equal(selection.closingOn, f.closingOn);
    assert.match(selection.reviewKey, /^[a-f0-9]{64}$/);
    assert.match(review.data.progress.known.find(({ label }) => label === 'Diferencia').value, /^-.*2\.000.*COP$/);
    const personal = await f.store.db.get(`SELECT data FROM ${f.store.t('assistant_advisor_tasks')} WHERE id=?`, [review.id]);
    const stored = JSON.parse(personal.data);
    assert.deepEqual(stored.cash, { accountId: cash.id, closingOn: f.closingOn, countedMinor: 9_800_000 });
    assert.deepEqual(stored.progress, { message: review.data.progress.message });
    await assert.rejects(getAdvisorTask(f.store, f.other, review.id), { status: 404 });
    await assert.rejects(updateAdvisorTask(f.store, f.owner, review.id, { action: 'cancel', version: count.version }), { status: 409 });
    await updateAdvisorTask(f.store, f.owner, review.id, { action: 'cancel', version: review.version });
    assert.deepEqual(await f.facts(), before);
    const again = await f.compare(await f.reserve(), cash);
    const saved = await closeCash(f.store, nativeInput(again.data.progress.action.selection), f.actor);
    const [entries] = await f.facts();
    assert.deepEqual(entries, before[0]);
    assert.deepEqual([saved.expectedMinor, saved.countedMinor, saved.differenceMinor, saved.revision], [10_000_000, 9_800_000, -200_000, 1]);
    const done = await f.resume(again);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.data.progress.proof, { kind: 'record', label: 'Cierre vigente de caja', entityId: saved.id, recordVersion: saved.version, committedAt: saved.recordedAt });
    assert.deepEqual(done.data.progress.action.selection, { kind: 'cash-closing', id: saved.id, version: saved.version, accountId: cash.id, closingOn: f.closingOn });
    assert.equal(done.data.progress.known.find(({ label }) => label === 'Registrado por').value, 'Tú');
    await reopenCash(f.store, { requestId: randomUUID(), closingId: saved.id, version: saved.version, reason: 'Revisar conteo sintético' }, f.actor);
    const noLongerCurrent = await f.get(done);
    assert.equal(noLongerCurrent.status, 'completed');
    assert.equal(noLongerCurrent.data.progress.proof, undefined);
    assert.equal(noLongerCurrent.data.progress.action, undefined);
  });

  await t.test('C4 el POST rechaza revisión anterior aunque el saldo vuelva a ser igual y conserva el conteo', async t => {
    const f = await fixture(t, factory), cash = await f.account();
    const guided = await f.compare(await f.reserve(), cash), original = guided.data.progress.action.selection;
    assert.deepEqual(await f.review(cash), { accountId: cash.id, accountName: cash.name, accountVersion: cash.version, closingOn: f.closingOn, expectedMinor: original.expectedMinor, reviewKey: original.reviewKey });
    const income = await recordIncome(f.store, { requestId: randomUUID(), accountId: cash.id, effectiveOn: f.closingOn, concept: 'owner_funding', amountMinor: 500_000 }, f.actor);
    const changed = await f.facts();
    const stale = nativeInput(original);
    await assert.rejects(closeCash(f.store, stale, f.actor), { status: 409 });
    assert.deepEqual(await f.facts(), changed);
    const newer = (await f.get(guided)).data.progress.action.selection;
    assert.equal(newer.expectedMinor, 10_500_000);
    assert.equal(newer.countedMinor, original.countedMinor);
    assert.notEqual(newer.reviewKey, original.reviewKey);
    await reverseCashEntry(f.store, { requestId: randomUUID(), cashEntryId: income.id, effectiveOn: f.closingOn, reason: 'Deshacer aporte sintético' }, f.actor);
    const sameBalance = (await f.get(guided)).data.progress.action.selection;
    assert.equal(sameBalance.expectedMinor, original.expectedMinor);
    assert.notEqual(sameBalance.reviewKey, original.reviewKey);
    const beforeClose = await f.facts();
    await assert.rejects(closeCash(f.store, stale, f.actor), { status: 409 });
    assert.deepEqual(await f.facts(), beforeClose);
    const input = nativeInput(sameBalance), saved = await closeCash(f.store, input, f.other.user.id);
    assert.equal(saved.differenceMinor, -200_000);
    assert.deepEqual(await closeCash(f.store, input, f.other.user.id), saved);
    const done = await f.resume(guided);
    assert.equal(done.data.progress.proof.entityId, saved.id);
    assert.match(done.data.progress.message, /Ya hay un cierre vigente/);
    assert.equal(done.data.progress.known.find(({ label }) => label === 'Registrado por').value, f.other.user.email);
    const [entries, closings] = await f.facts();
    assert.deepEqual(entries, beforeClose[0]);
    assert.equal(closings.length, 1);
  });

  await t.test('C4 guía problemas de apertura y responsable al control correspondiente', async t => {
    const f = await fixture(t, factory);
    const missingOpening = await f.account({ name: 'Caja sin apertura registrada' });
    const cash = await f.account({ name: 'Caja con responsable inactivo' });
    // Imported legacy data can be incomplete; native saveAccount always writes its opening.
    await f.store.db.run(`DELETE FROM ${f.store.t('cash_entries')} WHERE account_id=? AND kind='opening'`, [missingOpening.id]);
    await saveResource(f.store, 'people', { requestId: randomUUID(), name: f.person.name, active: false, version: f.person.version }, f.actor, f.person.id);
    const before = await f.facts();
    const opening = await f.answer(await f.reserve(), missingOpening.id);
    assert.equal(opening.status, 'blocked');
    assert.match(opening.data.progress.message, /no tiene una apertura registrada/);
    assert.equal(opening.data.progress.action.selection, null);
    const responsible = await f.answer(opening, cash.id);
    assert.equal(responsible.status, 'blocked');
    assert.match(responsible.data.progress.message, /responsable activa/);
    assert.equal(responsible.data.progress.action.focus, 'cash-close-account');
    assert.deepEqual(responsible.data.progress.action.selection, { kind: 'cash-account', id: cash.id, version: cash.version });
    assert.deepEqual(responsible.data.progress.action.view, { ...cashView, record: cash.id, account: cash.id });
    assert.deepEqual(await f.facts(), before);
    const person = await saveResource(f.store, 'people', { name: 'Reemplazo sintético', requestId: randomUUID() }, f.actor);
    await saveAccount(f.store, { requestId: randomUUID(), responsibleId: person.id, version: cash.version }, f.actor, cash.id);
    const resumed = await f.resume(responsible);
    assert.equal(resumed.data.progress.question.field, 'closingOn');
    assert.equal(resumed.data.cash.accountId, cash.id);
  });
}
