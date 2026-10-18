import { fail, integer, text, validateOrder } from '../validation.mjs';
import { emptyRecord, slugify } from '../schema.mjs';
import { bogotaDate } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { newId, runCommand, stamp } from './commands.mjs';
import { getBusinessSettings, isOnboardingProduct, listResources, saveBusinessSettingsTx, saveResourceTx, setupReadiness } from './settings.mjs';
import { saveAccountTx } from './cash.mjs';
import { snapshotCatalogItem } from './catalog.mjs';

const ACTION_FIELDS = {
  prepare: ['responsibleId', 'responsibleName', 'accountId', 'accountName', 'openingOn', 'openingBalanceMinor', 'openingConfirmed'],
  product: ['title', 'price', 'stockQuantity', 'presentation', 'sku', 'unitCostMinor'],
  orders: ['policyConfirmed'],
  trial: ['productId'],
  complete: []
};

async function administrator(store, user) {
  const id = text(typeof user === 'string' ? user : user?.id, 'Administrador', 100, true);
  const saved = await store.db.get(`SELECT id,email FROM ${store.t('users')} WHERE id=? AND active=1`, [id]);
  if (!saved) fail('La cuenta de acceso no está activa. Inicia sesión de nuevo.', 401);
  return { ...saved, name: typeof user === 'object' ? user.name : null };
}

async function onboardingTx(tx, user) {
  const settings = await getBusinessSettings(tx);
  const people = await listResources(tx, 'people');
  const accounts = await listResources(tx, 'accounts');
  const products = await tx.list('products');
  const prior = await tx.db.get(`SELECT result_json FROM ${tx.t('business_requests')} WHERE scope='onboarding:trial' AND actor_id=? ORDER BY created_at DESC,request_id DESC LIMIT 1`, [user.id]);
  return {
    settings, people, accounts, products,
    defaults: { responsibleName: user.name || user.email, accountName: 'Caja principal', openingOn: bogotaDate(), openingBalanceMinor: 0 },
    readiness: setupReadiness({ settings, people, accounts, products }),
    trialOrder: prior ? JSON.parse(prior.result_json) : null
  };
}

export async function getOnboarding(store, user) {
  return store.readSnapshot(async tx => onboardingTx(tx, await administrator(tx, user)));
}

async function prepareTx(tx, input, user, state) {
  const activePeople = new Map(state.people.filter(person => person.active).map(person => [person.id, person]));
  const usableAccounts = state.accounts.filter(account => account.active && activePeople.has(account.responsibleId));
  let account = input.accountId ? usableAccounts.find(row => row.id === input.accountId) :
    usableAccounts.find(row => row.id === state.settings.defaultReceiptAccountId) || usableAccounts[0];
  if (input.accountId && !account) fail('Selecciona una cuenta activa con responsable activo. Usa el editor de cuentas para corregirla.');
  let person = input.responsibleId ? activePeople.get(input.responsibleId) :
    state.people.find(row => row.active && row.userId === user.id) || activePeople.get(account?.responsibleId);
  if (input.responsibleId && !person) fail('Selecciona una persona activa como responsable.');
  if (!person) {
    const name = text(input.responsibleName ?? state.defaults.responsibleName, 'Nombre del responsable', 150, true);
    person = await saveResourceTx(tx, 'people', { name, userId: user.id, salaryAgreements: [], commissionOverrides: [] }, user.id);
  }
  if (!account) {
    if (input.openingConfirmed !== true) fail('Confirma el saldo inicial real de la caja, incluso si es cero.');
    if (input.openingBalanceMinor == null || input.openingBalanceMinor === '') fail('Indica el saldo inicial real de la caja, incluso si es cero.');
    account = await saveAccountTx(tx, {
      name: input.accountName ?? state.defaults.accountName, type: 'cash', responsibleId: person.id,
      openingOn: input.openingOn ?? state.defaults.openingOn,
      openingBalanceMinor: moneyMinor(input.openingBalanceMinor, 'Saldo inicial', { signed: true })
    }, user.id);
  }
  const validAccounts = new Set([...usableAccounts.map(row => row.id), account.id]);
  const patch = {};
  for (const key of ['defaultReceiptAccountId', 'defaultPaymentAccountId']) {
    if (!validAccounts.has(state.settings[key])) patch[key] = account.id;
  }
  if (!activePeople.has(state.settings.alertDefaults?.responsibleId)) {
    patch.alertDefaults = { ...state.settings.alertDefaults, responsibleId: person.id };
  }
  if (Object.keys(patch).length) {
    await saveBusinessSettingsTx(tx, { ...patch, version: state.settings.version, reason: 'Preparar caja desde la guía de inicio' }, user.id);
  }
  return { accountId: account.id, responsibleId: person.id };
}

async function productTx(tx, input, user, state) {
  const title = text(input.title, 'Nombre del producto', 160, true);
  const price = integer(input.price, 'Precio en pesos colombianos', 1);
  const stockQuantity = integer(input.stockQuantity, 'Existencias físicas contadas', 1, Number.MAX_SAFE_INTEGER);
  const existing = state.products.find(isOnboardingProduct);
  if (existing) return { productId: existing.id };
  const base = slugify(title) || 'producto';
  const slugs = new Set(state.products.map(product => product.slug));
  let slug = base, suffix = 2;
  while (slugs.has(slug)) slug = `${base.slice(0, 165).replace(/-$/, '')}-${suffix++}`;
  const product = await tx.saveTx('products', {
    ...emptyRecord('products'), title, slug, price, stockQuantity,
    presentation: input.presentation ?? '', sku: input.sku ?? '', unitCostMinor: input.unitCostMinor ?? null,
    productType: 'product', status: 'draft', orderable: true
  }, null, null, user.id);
  return { productId: product.id };
}

async function trialTx(tx, input, state) {
  requireReady(state.readiness);
  const product = input.productId ? state.products.find(row => row.id === input.productId && isOnboardingProduct(row)) : state.products.find(isOnboardingProduct);
  if (!product) fail('Selecciona un producto habilitado, no archivado, con precio y al menos una unidad disponible.');
  const clean = await validateOrder({
    customerName: 'Destinatario ficticio · pedido de prueba', phone: '0000000000', city: 'Ciudad ficticia',
    address: 'Sin dirección real · práctica aislada', notes: 'Práctica de la guía de inicio. Precio de ejemplo; sin cobro real.',
    placedOn: bogotaDate(), status: 'new', deliveryMethod: 'pickup', shippingChargeMinor: 0,
    items: [{ kind: 'products', itemId: product.id, quantity: 1, unitPriceMinor: moneyMinor(product.price * 100, 'Precio de ejemplo'), discountMinor: 0 }]
  }, (kind, id) => tx.get(kind, id), null, { snapshotItem: (kind, id, on) => snapshotCatalogItem(tx, kind, id, on) });
  return {
    id: `trial:${newId()}`, isTest: true, status: 'received', receivedAt: stamp(),
    customerName: clean.customerName, deliveryMethod: clean.deliveryMethod, items: clean.items,
    subtotalMinor: clean.subtotalMinor, totalMinor: clean.totalMinor, productId: product.id
  };
}

function requireReady(readiness) {
  if (!readiness.cash) fail('Prepara una cuenta activa con responsable y cuentas/avisos predeterminados válidos antes de continuar.');
  if (!readiness.product) fail('Añade un producto habilitado con precio mayor que cero y existencias disponibles antes de continuar.');
  if (!readiness.orders) fail('Confirma las reglas vigentes de pedidos antes de continuar.');
}

export async function runOnboardingAction(store, input, user) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Datos de la guía no válidos.');
  const fields = ACTION_FIELDS[input.action];
  if (!Object.hasOwn(ACTION_FIELDS, input.action)) fail('Acción de la guía no válida.');
  for (const key of Object.keys(input)) if (!['action', 'requestId', ...fields].includes(key)) fail(`El campo ${key} no pertenece a esta acción de la guía.`);
  const admin = await administrator(store, user);
  const { action } = input;
  await runCommand(store, { scope: `onboarding:${action}`, requestId: input.requestId, payload: input, actorId: admin.id, affectsIndicators: false }, async tx => {
    const state = await onboardingTx(tx, admin);
    if (action === 'prepare') return prepareTx(tx, input, admin, state);
    if (action === 'product') return productTx(tx, input, admin, state);
    if (action === 'trial') return trialTx(tx, input, state);
    if (action === 'orders') {
      if (input.policyConfirmed !== true) fail('Confirma las reglas vigentes antes de guardar.');
      if (!state.settings.rulesVersions.some(rule => rule.effectiveOn <= bogotaDate())) fail('Configura una regla vigente desde las opciones avanzadas antes de confirmarla.');
      if (!state.settings.setupPolicyConfirmed) await saveBusinessSettingsTx(tx, { version: state.settings.version, setupPolicyConfirmed: true, reason: 'Confirmar reglas vigentes desde la guía de inicio' }, admin.id);
    } else {
      requireReady(state.readiness);
      if (!state.settings.setupCompleted) await saveBusinessSettingsTx(tx, { version: state.settings.version, setupCompleted: true, reason: 'Finalizar puesta en marcha autónoma' }, admin.id);
    }
    return { ok: true };
  });
  return getOnboarding(store, admin);
}
