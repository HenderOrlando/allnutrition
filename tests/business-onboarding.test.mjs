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
const operationalTables = ['orders', 'order_audit', 'order_events', 'idempotency', 'business_audit', 'records', 'product_costs', 'commission_entries', 'expenses', 'cash_entries', 'counters', 'report_snapshots'];
async function operationalState(store) {
  return Object.fromEntries(await Promise.all(operationalTables.map(async table =>
    [table, await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY ${table === 'idempotency' ? 'key' : 'id'}`)])));
}
async function existingBusiness(store, user) {
  await prepare(store, user);
  const state = await product(store, user);
  for (let index = 0; index < 2; index++) {
    await store.saveOrder({ requestId: requestId(), customerName: 'Cliente existente', phone: '3001234567', city: 'Bogotá', placedOn: bogotaDate(), deliveryMethod: 'pickup', items: [{ kind: 'products', itemId: state.products[0].id, quantity: 1, unitPriceMinor: state.products[0].price * 100 }] }, user.id);
  }
  return getOnboarding(store, user);
}

test('cuenta vacía muestra defaults del administrador y no declara listo nada', () => fixture(async (store, user) => {
  const state = await getOnboarding(store, user.id);
  assert.equal(state.defaults.responsibleName, user.email);
  assert.deepEqual(state.readiness, { cash: false, product: false, orders: false, completed: false });
  assert.equal(state.trialOrder, null);
  assert.deepEqual(state.existingOrders, { count: 0, latestNumber: null });
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

for (const finalizer of ['onboarding', 'settings']) {
  test(`pedidos reales reconocen la puesta en marcha sin confirmar otra vez ni exigir importaciones (${finalizer})`, () => fixture(async (store, user) => {
    const state = await existingBusiness(store, user);
    assert.deepEqual(state.existingOrders, { count: 2, latestNumber: 2 });
    assert.notEqual(state.settings.setupPolicyConfirmed, true);
    assert.deepEqual(state.readiness, { cash: true, product: true, orders: true, completed: false });
    const before = await operationalState(store);
    const requestsBefore = await store.db.all(`SELECT * FROM ${store.t('business_requests')} ORDER BY scope,request_id`);
    assert.deepEqual(await getOnboarding(store, user), state);
    assert.deepEqual(await operationalState(store), before);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_requests')} ORDER BY scope,request_id`), requestsBefore);
    assert.equal((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('import_batches')}`)).count, 0);
    if (finalizer === 'settings') {
      await saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), setupCompleted: true }, user.id);
    } else {
      await action(store, user, 'complete');
    }
    const completed = await getOnboarding(store, user);
    assert.equal(completed.readiness.completed, true);
    assert.notEqual(completed.settings.setupPolicyConfirmed, true);
    assert.equal(completed.trialOrder, null);
  }));
}

test('pedidos existentes no sustituyen caja válida, reglas vigentes ni existencias disponibles', () => fixture(async (store, user) => {
  let state = await existingBusiness(store, user);
  const currentRules = state.settings.rulesVersions;
  const tomorrow = bogotaDate(new Date(Date.now() + 86400000));
  await saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), rulesVersions: currentRules.map(rule => ({ ...rule, effectiveOn: tomorrow })) }, user.id);
  state = await getOnboarding(store, user);
  assert.equal(state.existingOrders.count, 2);
  assert.equal(state.readiness.orders, false);
  await assert.rejects(() => action(store, user, 'complete'), { status: 400 });
  await assert.rejects(() => saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), setupCompleted: true }, user.id), { status: 400 });
  await saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), rulesVersions: currentRules }, user.id);
  const person = state.people[0];
  await saveResource(store, 'people', { ...person, active: false, requestId: requestId() }, user.id, person.id);
  state = await getOnboarding(store, user);
  assert.equal(state.readiness.cash, false);
  assert.equal(state.readiness.orders, false);
  await assert.rejects(() => action(store, user, 'complete'), { status: 400 });
  await assert.rejects(() => saveBusinessSettings(store, { version: state.settings.version, requestId: requestId(), setupCompleted: true }, user.id), { status: 400 });
  await saveResource(store, 'people', { ...state.people[0], active: true, requestId: requestId() }, user.id, person.id);
  const item = state.products[0];
  await store.save('products', { ...item, stockQuantity: item.stockReserved }, item.id, item.version, user.id);
  state = await getOnboarding(store, user);
  assert.equal(state.readiness.product, false);
  assert.equal(state.readiness.completed, false);
  await assert.rejects(() => action(store, user, 'complete'), { status: 400 });
  assert.notEqual((await getBusinessSettings(store)).setupCompleted, true);
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

test('prácticas repetidas persisten recibos distintos y revierten toda la operación real incluso con fechas empatadas', t => fixture(async (store, user) => {
  const state = await ready(store, user);
  const input = { action: 'trial', requestId: 'zzzzzzzz-trial-first', productId: state.products[0].id };
  const before = await operationalState(store);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const received = await runOnboardingAction(store, input, user);
  const trial = received.trialOrder;
  assert.equal(trial.isTest, true);
  assert.match(trial.id, /^trial:/);
  assert.equal(Object.hasOwn(trial, 'number'), false);
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
  assert.deepEqual(await operationalState(store), before);
  assert.equal((await store.orders()).length, 0);
  assert.deepEqual((await runOnboardingAction(store, input, user)).trialOrder, trial);
  assert.deepEqual((await getOnboarding(store, user.id)).trialOrder, trial);
  const secondInput = { ...input, requestId: 'aaaaaaaa-trial-second' };
  const second = (await runOnboardingAction(store, secondInput, user)).trialOrder;
  assert.notEqual(second.id, trial.id);
  assert.equal(second.items[0].itemId, trial.productId);
  assert.ok(second.receivedAt > trial.receivedAt);
  assert.deepEqual((await runOnboardingAction(store, secondInput, user)).trialOrder, second);
  assert.deepEqual((await runOnboardingAction(store, input, user)).trialOrder, trial);
  assert.deepEqual((await getOnboarding(store, user)).trialOrder, second);
  assert.deepEqual(await operationalState(store), before);
  const receipts = await store.db.all(`SELECT actor_id,result_json,created_at FROM ${store.t('business_requests')} WHERE scope='onboarding:trial' ORDER BY request_id`);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].created_at, receipts[1].created_at);
  assert.ok(receipts.every(row => row.actor_id === user.id));
  assert.deepEqual(receipts.map(row => JSON.parse(row.result_json)), [second, trial]);
  await assert.rejects(() => action(store, user, 'trial', { amountMinor: 100 }), /no pertenece/);
  await assert.rejects(() => recordCollection(store, { requestId: requestId(), orderId: trial.id, amountMinor: 100, occurredOn: bogotaDate(), holder: 'business', accountId: state.accounts[0].id, method: 'Efectivo', reference: 'Prueba sin cobro' }, user.id), { status: 404 });
  await createAdmin(store, 'other@example.com', 'Strong-test-password-123');
  const other = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['other@example.com']);
  assert.equal((await getOnboarding(store, other.id)).trialOrder, null);
}));

test('fallo después de crear pedido, reserva y auditoría revierte el sandbox sin reemplazar el recibo anterior', () => fixture(async (store, user) => {
  await ready(store, user);
  const prior = (await action(store, user, 'trial')).trialOrder;
  const before = await operationalState(store);
  const receiptsBefore = await store.db.all(`SELECT * FROM ${store.t('business_requests')} ORDER BY scope,request_id`);
  const input = { action: 'trial', requestId: requestId() };
  await store.db.exec(`CREATE TEMP TRIGGER reject_trial_order_audit BEFORE INSERT ON ${store.t('order_audit')} BEGIN SELECT RAISE(ABORT,'fallo deliberado después de guardar el pedido'); END`);
  try {
    await assert.rejects(() => runOnboardingAction(store, input, user), /fallo deliberado después de guardar el pedido/);
    assert.deepEqual(await operationalState(store), before);
    assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('business_requests')} ORDER BY scope,request_id`), receiptsBefore);
    assert.deepEqual((await getOnboarding(store, user)).trialOrder, prior);
  } finally {
    await store.db.exec('DROP TRIGGER reject_trial_order_audit');
  }
  const retried = (await runOnboardingAction(store, input, user)).trialOrder;
  assert.notEqual(retried.id, prior.id);
  assert.deepEqual(await operationalState(store), before);
}));
