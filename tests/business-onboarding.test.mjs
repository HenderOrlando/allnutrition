import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { emptyRecord } from '../lib/schema.mjs';
import { bogotaDate } from '../lib/business/dates.mjs';
import { getOnboarding, runOnboardingAction } from '../lib/business/onboarding.mjs';
import { getBusinessSettings, saveBusinessSettings, saveResource } from '../lib/business/settings.mjs';
import { saveAccount } from '../lib/business/cash.mjs';
import { recordCollection } from '../lib/business/collections.mjs';

const requestId = () => randomUUID();
async function fixture(fn) {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await createAdmin(store, 'onboarding@example.com', 'Strong-test-password-123');
    const user = await store.db.get(`SELECT id,email FROM ${store.t('users')} WHERE email=?`, ['onboarding@example.com']);
    await fn(store, user);
  } finally { await store.close(); }
}
const action = (store, user, name, fields = {}) => runOnboardingAction(store, { action: name, requestId: requestId(), ...fields }, user);
const prepare = (store, user, fields = {}) => action(store, user, 'prepare', { openingBalanceMinor: 0, openingConfirmed: true, ...fields });
const product = (store, user, fields = {}) => action(store, user, 'product', { title: 'Primera proteína', price: 55000, stockQuantity: 3, ...fields });
async function ready(store, user) {
  await prepare(store, user);
  await product(store, user);
  return action(store, user, 'orders', { policyConfirmed: true });
}

test('cuenta vacía muestra defaults del administrador y no declara listo nada', () => fixture(async (store, user) => {
  const state = await getOnboarding(store, user.id);
  assert.equal(state.defaults.responsibleName, user.email);
  assert.deepEqual(state.readiness, { cash: false, product: false, orders: false, completed: false });
  assert.equal(state.trialOrder, null);
  assert.equal(state.people.length, 0);
  assert.equal((await getOnboarding(store, { ...user, name: 'Nombre autenticado' })).defaults.responsibleName, 'Nombre autenticado');
  await assert.rejects(() => action(store, user, 'complete'), /cuenta activa/);
  await assert.rejects(() => action(store, user, 'complete', { readiness: { cash: true } }), /no pertenece/);
  await assert.rejects(() => getOnboarding(store, 'missing'), { status: 401 });
}));

test('apertura requiere saldo real confirmado; fallo no deja responsables ni caja parciales', () => fixture(async (store, user) => {
  for (const fields of [{}, { openingBalanceMinor: 0 }, { openingConfirmed: true }, { openingConfirmed: true, openingBalanceMinor: null }, { openingConfirmed: true, openingBalanceMinor: '' }, { openingConfirmed: true, openingBalanceMinor: 1.2 }]) {
    await assert.rejects(() => action(store, user, 'prepare', fields), { status: 400 });
    const state = await getOnboarding(store, user);
    assert.equal(state.people.length, 0);
    assert.equal(state.accounts.length, 0);
  }
  const state = await prepare(store, user, { responsibleName: 'Responsable real', accountName: 'Mi caja', openingBalanceMinor: 123400 });
  assert.equal(state.people[0].name, 'Responsable real');
  assert.equal(state.people[0].userId, user.id);
  assert.deepEqual(state.people[0].salaryAgreements, []);
  assert.deepEqual(state.people[0].commissionOverrides, []);
  assert.equal(state.accounts[0].name, 'Mi caja');
  assert.equal(state.readiness.cash, true);
  const opening = await store.db.get(`SELECT amount_minor,kind FROM ${store.t('cash_entries')}`);
  assert.equal(opening.amount_minor, 123400);
  assert.equal(opening.kind, 'opening');
}));

test('reintentos y preparación concurrente reutilizan persona/caja sin nuevas aperturas', () => fixture(async (store, user) => {
  const input = { action: 'prepare', requestId: requestId(), openingBalanceMinor: 0, openingConfirmed: true };
  const first = await runOnboardingAction(store, input, user);
  const repeated = await runOnboardingAction(store, input, user);
  assert.deepEqual(repeated, first);
  await assert.rejects(() => runOnboardingAction(store, { ...input, openingBalanceMinor: 1 }, user), { status: 409 });
  const concurrent = await Promise.all([prepare(store, user), prepare(store, user), prepare(store, user)]);
  for (const state of concurrent) {
    assert.equal(state.accounts.length, 1);
    assert.equal(state.people.length, 1);
    assert.equal(state.accounts[0].id, first.accounts[0].id);
  }
  const count = await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('cash_entries')}`);
  assert.equal(count.count, 1);
}));

test('dos preparaciones iniciales concurrentes crean una sola caja y responsable', () => fixture(async (store, user) => {
  const states = await Promise.all([prepare(store, user), prepare(store, user)]);
  assert.ok(states.every(state => state.people.length === 1 && state.accounts.length === 1));
  assert.equal(states[0].people[0].id, states[1].people[0].id);
  assert.equal(states[0].accounts[0].id, states[1].accounts[0].id);
  assert.equal((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('cash_entries')}`)).count, 1);
}));

test('preparación conserva cuentas, responsables y defaults válidos; no edita una caja existente', () => fixture(async (store, user) => {
  const owner = await saveResource(store, 'people', { name: 'Dueña existente', userId: user.id, requestId: requestId() }, user.id);
  const other = await saveResource(store, 'people', { name: 'Responsable avisos', requestId: requestId() }, user.id);
  const account = await saveAccount(store, { name: 'Banco existente', type: 'bank', responsibleId: owner.id, openingOn: bogotaDate(), openingBalanceMinor: 900, requestId: requestId() }, user.id);
  const second = await saveAccount(store, { name: 'Otra cuenta', type: 'wallet', responsibleId: owner.id, openingOn: bogotaDate(), openingBalanceMinor: 0, requestId: requestId() }, user.id);
  const settings = await getBusinessSettings(store);
  await saveBusinessSettings(store, { version: settings.version, requestId: requestId(), defaultReceiptAccountId: account.id, defaultPaymentAccountId: second.id, alertDefaults: { responsibleId: other.id, reminderHours: 48 } }, user.id);
  const state = await prepare(store, user, { accountId: account.id, accountName: 'No sobrescribir', openingBalanceMinor: 999999 });
  assert.equal(state.accounts.length, 2);
  assert.equal(state.people.length, 2);
  assert.equal(state.accounts.find(row => row.id === account.id).name, account.name);
  assert.equal(state.accounts.find(row => row.id === account.id).version, account.version);
  assert.equal(state.settings.defaultReceiptAccountId, account.id);
  assert.equal(state.settings.defaultPaymentAccountId, second.id);
  assert.deepEqual(state.settings.alertDefaults, { responsibleId: other.id, reminderHours: 48 });
  assert.equal(state.settings.version, settings.version + 1);
  assert.equal(state.readiness.cash, true);
}));

test('preparación repara defaults archivados sin reactivar ni editar datos existentes', () => fixture(async (store, user) => {
  const original = await prepare(store, user);
  const account = original.accounts[0];
  await saveAccount(store, { ...account, active: false, requestId: requestId() }, user.id, account.id);
  const state = await prepare(store, user, { openingBalanceMinor: 500 });
  assert.equal(state.people.length, 1);
  assert.equal(state.accounts.length, 2);
  assert.equal(state.accounts.find(row => row.id === account.id).active, false);
  const active = state.accounts.find(row => row.active);
  assert.equal(state.settings.defaultReceiptAccountId, active.id);
  assert.equal(state.settings.defaultPaymentAccountId, active.id);
  assert.equal(state.readiness.cash, true);
}));

test('el primer producto requiere precio/conteo reales y queda vendible en panel sin publicar ni inventar costo o imagen', () => fixture(async (store, user) => {
  for (const fields of [{ price: undefined }, { price: 0 }, { price: 1.5 }, { stockQuantity: undefined }, { stockQuantity: 0 }, { stockQuantity: null }, { stockQuantity: 1.5 }]) {
    await assert.rejects(() => product(store, user, fields), { status: 400 });
  }
  const input = { action: 'product', requestId: requestId(), title: 'Primera proteína', price: 55000, stockQuantity: 3 };
  const state = await runOnboardingAction(store, input, user);
  const item = state.products[0];
  assert.equal(item.status, 'draft');
  assert.equal(item.orderable, true);
  assert.equal(item.productType, 'product');
  assert.equal(item.price, 55000);
  assert.equal(item.stockQuantity, 3);
  assert.equal(item.stockReserved, 0);
  assert.equal(item.image, '');
  assert.equal(item.unitCostMinor, null);
  assert.equal(state.readiness.product, true);
  assert.equal((await store.publicData()).products.length, 0);
  assert.deepEqual(await runOnboardingAction(store, input, user), state);
  const repeated = await Promise.all([product(store, user), product(store, user)]);
  assert.ok(repeated.every(result => result.products.length === 1 && result.products[0].id === item.id));
  const order = await store.saveOrder({ requestId: requestId(), customerName: 'Destinatario real', phone: '3001234567', city: 'Bogotá', placedOn: bogotaDate(), deliveryMethod: 'pickup', items: [{ kind: 'products', itemId: item.id, quantity: 1, unitPriceMinor: 5500000 }] }, user.id);
  assert.equal(order.items[0].itemId, item.id);
  assert.equal((await store.get('products', item.id)).stockReserved, 1);
}));

test('producto genera slug único y conserva presentación/SKU/costo explícitos', () => fixture(async (store, user) => {
  await store.save('products', { ...emptyRecord('products'), title: 'Primera proteína', slug: 'primera-proteina' });
  const state = await product(store, user, { sku: 'SKU-REAL', presentation: '900 gramos', unitCostMinor: 1200000 });
  const item = state.products.find(row => row.orderable);
  assert.equal(item.slug, 'primera-proteina-2');
  assert.equal(item.sku, 'SKU-REAL');
  assert.equal(item.presentation, '900 gramos');
  assert.equal(item.unitCostMinor, 1200000);
}));

test('reglas se confirman sin reescribir política ni exigir prueba; finalizar exige todos los datos', () => fixture(async (store, user) => {
  const initial = await getOnboarding(store, user);
  await assert.rejects(() => action(store, user, 'orders'), /Confirma/);
  await prepare(store, user);
  const confirmed = await action(store, user, 'orders', { policyConfirmed: true });
  assert.deepEqual(confirmed.settings.rulesVersions, initial.settings.rulesVersions);
  assert.equal(confirmed.readiness.orders, true);
  await assert.rejects(() => action(store, user, 'complete'), /producto/);
  const beforeProduct = await getBusinessSettings(store);
  await assert.rejects(() => saveBusinessSettings(store, { version: beforeProduct.version, requestId: requestId(), setupCompleted: true }, user.id), /producto/);
  await product(store, user);
  const completed = await action(store, user, 'complete');
  assert.equal(completed.trialOrder, null);
  assert.equal(completed.readiness.completed, true);
  assert.equal(completed.settings.setupCompleted, true);
  const again = await action(store, user, 'complete');
  assert.equal(again.settings.version, completed.settings.version);
}));

test('reglas futuras no se pueden confirmar como vigentes', () => fixture(async (store, user) => {
  const settings = await getBusinessSettings(store);
  const tomorrow = bogotaDate(new Date(Date.now() + 86400000));
  await saveBusinessSettings(store, { version: settings.version, requestId: requestId(), rulesVersions: settings.rulesVersions.map(rule => ({ ...rule, effectiveOn: tomorrow })) }, user.id);
  await assert.rejects(() => action(store, user, 'orders', { policyConfirmed: true }), /regla vigente/);
  assert.equal((await getOnboarding(store, user)).readiness.orders, false);
}));

test('readiness vuelve a ser falsa si se archivan recursos o se agotan existencias, aunque setupCompleted esté guardado', () => fixture(async (store, user) => {
  let state = await ready(store, user);
  state = await action(store, user, 'complete');
  const item = state.products[0];
  await store.save('products', { ...item, stockQuantity: 0 }, item.id, item.version, user.id);
  state = await getOnboarding(store, user);
  assert.equal(state.settings.setupCompleted, true);
  assert.equal(state.readiness.product, false);
  assert.equal(state.readiness.completed, false);
  await assert.rejects(() => action(store, user, 'complete'), /producto/);
  await assert.rejects(() => action(store, user, 'trial'), /producto/);
  const preferences = await saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), reportGenerationTime: '07:30' }, user.id);
  assert.equal(preferences.setupCompleted, true);
  assert.equal(preferences.reportGenerationTime, '07:30');
  const person = state.people[0];
  await saveResource(store, 'people', { ...person, active: false, requestId: requestId() }, user.id, person.id);
  state = await getOnboarding(store, user);
  assert.equal(state.readiness.cash, false);
  assert.equal(state.readiness.orders, false);
}));

test('práctica recibida persiste snapshots reales y no consume stock, numeración, caja ni cambios de settings', () => fixture(async (store, user) => {
  const state = await ready(store, user);
  const input = { action: 'trial', requestId: requestId(), productId: state.products[0].id };
  const beforeCounters = await store.db.all(`SELECT * FROM ${store.t('counters')} ORDER BY id`);
  const beforeCash = await store.db.all(`SELECT * FROM ${store.t('cash_entries')}`);
  const received = await runOnboardingAction(store, input, user);
  const trial = received.trialOrder;
  assert.equal(trial.isTest, true);
  assert.equal(trial.status, 'received');
  assert.equal(trial.deliveryMethod, 'pickup');
  assert.match(trial.customerName, /ficticio/);
  assert.equal(trial.items[0].itemId, state.products[0].id);
  assert.equal(trial.items[0].title, state.products[0].title);
  assert.equal(trial.items[0].unitCostMinor, null);
  assert.equal(trial.items[0].quantity, 1);
  assert.equal(trial.totalMinor, state.products[0].price * 100);
  assert.deepEqual(received.products, state.products);
  assert.deepEqual(received.settings, state.settings);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('counters')} ORDER BY id`), beforeCounters);
  assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('cash_entries')}`), beforeCash);
  assert.equal((await store.orders()).length, 0);
  assert.deepEqual((await runOnboardingAction(store, input, user)).trialOrder, trial);
  assert.deepEqual((await getOnboarding(store, user.id)).trialOrder, trial);
  await assert.rejects(() => action(store, user, 'trial', { amountMinor: 100 }), /no pertenece/);
  await assert.rejects(() => recordCollection(store, { requestId: requestId(), orderId: trial.id, amountMinor: 100, occurredOn: bogotaDate(), holder: 'business', accountId: state.accounts[0].id, method: 'Efectivo', reference: 'Prueba sin cobro' }, user.id), { status: 404 });
  await createAdmin(store, 'other@example.com', 'Strong-test-password-123');
  const other = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['other@example.com']);
  assert.equal((await getOnboarding(store, other.id)).trialOrder, null);
}));
