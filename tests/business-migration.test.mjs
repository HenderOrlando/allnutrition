import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { schemas } from '../lib/schema.mjs';
import { BUSINESS_TABLES, convertV2Bundle, migrateBusinessV3, migrateInventoryV4 } from '../lib/db/migrations.mjs';
import { resolveOrderRecognition } from '../lib/business/orders.mjs';

const CREATED = '2026-09-01T04:59:59.000Z';
const UPDATED = '2026-09-03T15:00:00.000Z';
const MIGRATED = '2026-10-01T05:00:00.000Z';
const idFor = (type, original) => createHash('sha256').update(`v3:${type}:${original}`).digest('hex').slice(0, 32);
const plain = value => JSON.parse(JSON.stringify(value));
const BASE_TABLES = ['migrations', 'records', 'settings', 'users', 'sessions', 'attempts', 'orders', 'order_events', 'order_audit', 'counters', 'idempotency'];

function legacyOrder(id, overrides = {}) {
  return {
    id, number: 1, version: 7, createdAt: CREATED, updatedAt: UPDATED,
    customerName: 'Cliente sintético', phone: '3001234567', city: 'Bogotá', department: 'Bogotá', address: 'Dirección de prueba',
    notes: 'Conservar estas notas', status: 'sent', deliveryMethod: 'carrier', carrier: 'Transportadora sintética', tracking: '0000123456789',
    estimatedDelivery: '2026-09-04', shippingCost: 12000,
    items: [{ lineId: 'linea-historica', kind: 'products', itemId: 'product-a', title: 'Producto histórico', presentation: 'Presentación histórica', quantity: 2, unitPrice: 55000, components: [] }],
    subtotal: 110000, total: 122000, paymentStatus: 'partial', paymentAmount: 20000, paymentDate: '2026-09-02',
    paymentMethod: 'Efectivo contraentrega', paymentReference: 'abono-sintetico', paymentReceiptUrl: '',
    history: [{ orderVersion: 7, nextStatus: 'sent', actorId: 'original-user', createdAt: UPDATED, changedFields: ['status'] }],
    ...overrides
  };
}
function legacyBundle() {
  const bundle = { format: 'allnutrition-export-v2', exportedAt: MIGRATED, settings: { launchApproved: false, version: 9 } };
  for (const kind of Object.keys(schemas)) bundle[kind] = [];
  bundle.products = [
    { id: 'product-a', title: 'Producto publicado', slug: 'producto-publicado', status: 'published', sort: 2, price: 55000, version: 4, createdAt: CREATED, updatedAt: UPDATED },
    { id: 'product-archived', title: 'Producto archivado', slug: 'producto-archivado', status: 'archived', sort: 3, price: 10000, version: 6, createdAt: CREATED, updatedAt: UPDATED }
  ];
  bundle.combos = [{ id: 'combo-a', title: 'Combo histórico', slug: 'combo-historico', status: 'archived', price: 55000, items: [{ productId: 'product-archived', quantity: 2 }], version: 3, createdAt: CREATED, updatedAt: UPDATED }];
  bundle.orders = [
    legacyOrder('partial'),
    legacyOrder('paid-cod', { number: 2, status: 'delivered', paymentStatus: 'paid', paymentAmount: 122000 }),
    legacyOrder('refunded', { number: 3, status: 'returned', tracking: '0000000000002', paymentStatus: 'refunded', paymentAmount: 122000, paymentReference: 'reembolso-ambiguo' }),
    legacyOrder('no-shipment', { number: 4, status: 'new', carrier: '', tracking: '', estimatedDelivery: '', paymentStatus: 'pending', paymentAmount: 0, paymentDate: '' }),
    legacyOrder('combo', {
      number: 5, tracking: '0000000000003', subtotal: 55000, total: 67000, paymentAmount: 0, paymentStatus: 'pending', paymentDate: '',
      items: [{ kind: 'combos', itemId: 'combo-a', title: 'Combo vendido', presentation: '', quantity: 1, unitPrice: 55000, components: [{ productId: 'product-archived', title: 'Producto antiguo', presentation: 'Anterior', quantity: 2 }] }]
    })
  ];
  // The converter preserves these when handed an internal bundle, unlike a commercial export.
  bundle.users = [{ id: 'original-user', email: 'synthetic@example.test', password: 'hash-sintetico', active: 1 }];
  bundle.sessions = [{ token_hash: 'synthetic-token-hash', user_id: 'original-user', csrf: 'synthetic-csrf', expires: 2100000000000 }];
  return bundle;
}

/** A disposable real SQLite v2 database; bypasses openStore's automatic v3 upgrade intentionally. */
async function v2Store({ failMarker = false, failInventoryMarker = false } = {}) {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON;');
  native.exec(await readFile(new URL('../db/sqlite.sql', import.meta.url), 'utf8'));
  const direct = {
    provider: 'sqlite', table: name => `"${name}"`,
    all: async (sql, params = []) => native.prepare(sql).all(...params),
    get: async (sql, params = []) => native.prepare(sql).get(...params) || null,
    run: async (sql, params = []) => {
      if (failMarker && sql.startsWith('INSERT INTO "migrations"(version,applied_at)')) throw new Error('Fallo sintético al guardar marcador v3');
      if (failInventoryMarker && sql.startsWith('INSERT INTO "migrations"(version,applied_at) VALUES(4,')) throw new Error('Fallo sintético al guardar marcador v4');
      return { changes: Number(native.prepare(sql).run(...params).changes) };
    },
    exec: async sql => native.exec(sql)
  };
  const adapter = {
    ...direct, close: async () => native.close(),
    transaction: async fn => {
      native.exec('BEGIN IMMEDIATE');
      try { const result = await fn(direct); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    }
  };
  const store = new Store(adapter);
  await store.initialize();
  return store;
}
async function seedV2(store, bundle = legacyBundle()) {
  for (const kind of Object.keys(schemas)) {
    for (const record of bundle[kind]) {
      const { id, version, createdAt, updatedAt, ...data } = record;
      await store.db.run(`INSERT INTO ${store.t('records')}(id,kind,slug,title,status,sort_order,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, kind, data.slug, data.title, data.status, data.sort || 0, JSON.stringify(data), version, createdAt, updatedAt]);
    }
  }
  for (const order of bundle.orders) {
    const { id, number, version, createdAt, updatedAt, history, ...data } = order;
    await store.db.run(`INSERT INTO ${store.t('orders')}(id,number,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?)`, [id, number, JSON.stringify(data), version, createdAt, updatedAt]);
    await store.db.run(`INSERT INTO ${store.t('order_audit')}(id,order_id,actor_id,data,created_at) VALUES(?,?,?,?,?)`, [`audit-${id}`, id, 'original-user', JSON.stringify(history[0]), UPDATED]);
  }
  await store.db.run(`INSERT INTO ${store.t('order_events')}(id,order_id,actor_id,previous_status,next_status,created_at) VALUES(?,?,?,?,?,?)`, ['original-event', 'partial', 'original-user', 'preparing', 'sent', UPDATED]);
  await store.db.run(`INSERT INTO ${store.t('idempotency')}(key,actor_id,payload_hash,order_id) VALUES(?,?,?,?)`, ['original-request', 'original-user', 'original-hash', 'partial']);
  const user = bundle.users[0], session = bundle.sessions[0];
  await store.db.run(`INSERT INTO ${store.t('users')}(id,email,password,active) VALUES(?,?,?,?)`, [user.id, user.email, user.password, user.active]);
  await store.db.run(`INSERT INTO ${store.t('sessions')}(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)`, [session.token_hash, session.user_id, session.csrf, session.expires]);
  await store.db.run(`UPDATE ${store.t('counters')} SET value=? WHERE id='orders'`, [bundle.orders.length]);
}
async function rows(store, table) {
  const result = plain(await store.db.all(`SELECT * FROM ${store.t(table)}`));
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function snapshot(store, tables) {
  const result = {};
  for (const table of tables) result[table] = await rows(store, table);
  return result;
}

test('conversión pura conserva identidades/historia y convierte pesos exactamente, sin crear caja', () => {
  const source = legacyBundle(), original = structuredClone(source);
  const converted = convertV2Bundle(source, { migrationAt: MIGRATED });
  assert.deepEqual(source, original);
  assert.equal(converted.format, 'allnutrition-export-v3');
  assert.deepEqual(converted.users, source.users);
  assert.deepEqual(converted.sessions, source.sessions);
  assert.deepEqual(converted.combos, source.combos);
  assert.equal(converted.products[0].orderable, true);
  assert.equal(converted.products[1].orderable, false);
  assert.equal(converted.products[0].price, 55000);
  assert.equal(converted.products[0].unitCostMinor, null);
  assert.equal(converted.products[0].version, 4);
  const order = converted.orders.find(row => row.id === 'partial');
  assert.equal(order.number, 1);
  assert.equal(order.version, 7);
  assert.equal(order.createdAt, CREATED);
  assert.equal(order.updatedAt, UPDATED);
  assert.deepEqual(order.history, source.orders[0].history);
  assert.equal(order.placedOn, '2026-08-31');
  assert.equal(order.dateSource, 'legacy_record');
  assert.equal(order.sellerId, null);
  assert.equal(order.subtotalMinor, 11000000);
  assert.equal(order.shippingChargeMinor, 1200000);
  assert.equal(order.totalMinor, 12200000);
  assert.equal(order.items[0].unitPriceMinor, 5500000);
  assert.equal(order.items[0].discountMinor, 0);
  assert.equal(order.items[0].unitCostMinor, null);
  assert.equal(order.items[0].lineId, 'linea-historica');
  for (const field of ['subtotal','total','shippingCost','carrier','tracking','estimatedDelivery','paymentStatus','paymentAmount','paymentDate','paymentMethod','paymentReference','paymentReceiptUrl']) assert.equal(Object.hasOwn(order, field), false, field);
  assert.equal(Object.hasOwn(order.items[0], 'unitPrice'), false);
  const collection = converted.business.order_collections.find(row => row.order_id === 'partial');
  assert.equal(collection.amount_minor, 2000000);
  assert.equal(collection.holder, 'legacy');
  assert.equal(collection.occurred_on, '2026-09-02');
  assert.equal(collection.cash_entry_id, null);
  assert.equal(collection.id, idFor('collection', 'partial'));
  assert.equal(converted.business.cash_entries.length, 0);
  assert.equal(converted.business.cash_accounts.length, 0);
  assert.equal(converted.business.product_costs.length, 0);
  assert.equal(converted.business.platforms.length, 0);
  assert.equal(converted.business.platform_sources.length, 0);
  assert.deepEqual(convertV2Bundle(source, { migrationAt: MIGRATED }), converted);
  assert.deepEqual(convertV2Bundle(converted), converted);
});

test('contraentrega, reembolso ambiguo y guías repetidas no inventan depósitos ni fechas', () => {
  const converted = convertV2Bundle(legacyBundle(), { migrationAt: MIGRATED });
  const paid = converted.orders.find(order => order.id === 'paid-cod');
  assert.equal(paid.legacyFinancialReview.required, true);
  assert.equal(paid.legacyFinancialReview.paymentMethod, 'Efectivo contraentrega');
  assert.equal(converted.business.order_collections.find(row => row.order_id === paid.id).amount_minor, 12200000);
  const refunded = converted.orders.find(order => order.id === 'refunded');
  assert.equal(refunded.legacyFinancialReview.reason, 'ambiguous_refund');
  assert.equal(refunded.legacyFinancialReview.paymentAmount, 122000);
  assert.equal(refunded.legacyFinancialReview.paymentReference, 'reembolso-ambiguo');
  assert.equal(converted.business.order_collections.some(row => row.order_id === refunded.id), false);
  assert.equal(converted.business.order_collections.some(row => row.kind === 'refund'), false);
  const duplicates = converted.business.shipments.filter(row => ['partial', 'paid-cod'].includes(row.order_id));
  assert.equal(duplicates.length, 2);
  for (const shipment of duplicates) {
    assert.equal(shipment.identity_key, null);
    assert.equal(shipment.tracking, '0000123456789');
    assert.equal(shipment.platform_id, null);
    assert.equal(shipment.source_id, null);
    assert.equal(JSON.parse(shipment.data).duplicateTrackingReview, true);
  }
  assert.equal(converted.business.shipments.some(row => row.order_id === 'no-shipment'), false);
  for (const event of converted.business.shipment_events) {
    assert.equal(event.occurred_at, null);
    assert.equal(event.occurred_on, null);
    assert.equal(event.source_as_of, null);
    assert.equal(event.recorded_at, UPDATED);
  }
  const combo = converted.orders.find(order => order.id === 'combo').items[0];
  assert.equal(combo.lineId, idFor('line', 'combo:0'));
  assert.equal(combo.components[0].productId, 'product-archived');
  assert.equal(combo.components[0].unitCostMinor, null);
  const audit = JSON.parse(converted.business.business_audit.find(row => row.entity_id === 'partial').data);
  assert.equal(audit.previous.paymentAmount, 20000);
  assert.equal(audit.previous.shippingCost, 12000);
  assert.equal(audit.previous.tracking, '0000123456789');
  assert.equal(audit.previous.items[0].unitPrice, 55000);
  assert.equal(Object.hasOwn(audit.previous, 'phone'), false);
  assert.equal(Object.hasOwn(audit.previous, 'documentNumber'), false);
});

test('la conversión rechaza dinero no entero, totales corruptos y valores fuera de rango sin modificar origen', () => {
  for (const mutate of [
    bundle => { bundle.orders[0].paymentAmount = 20000.5; },
    bundle => { bundle.orders[0].total++; },
    bundle => { bundle.orders[0].items[0].unitPrice = 100000000001; },
    bundle => { bundle.orders[0].items[0].quantity = 1000; }
  ]) {
    const bundle = legacyBundle(); mutate(bundle); const before = structuredClone(bundle);
    assert.throws(() => convertV2Bundle(bundle, { migrationAt: MIGRATED }));
    assert.deepEqual(bundle, before);
  }
  assert.throws(() => convertV2Bundle(legacyBundle()), /migración/);
});

test('migración SQLite real es atómica, conserva versiones/sesiones/auditoría y repetir no muta filas', async () => {
  const store = await v2Store();
  try {
    await seedV2(store);
    const preserved = await snapshot(store, ['users', 'sessions', 'order_audit', 'order_events', 'idempotency']);
    const beforeOrders = await rows(store, 'orders');
    assert.deepEqual(await migrateBusinessV3(store), { migrated: true, version: 3 });
    assert.deepEqual(await snapshot(store, Object.keys(preserved)), preserved);
    const afterOrders = await rows(store, 'orders');
    for (const original of beforeOrders) {
      const converted = afterOrders.find(row => row.id === original.id);
      assert.deepEqual([converted.id, converted.number, converted.version, converted.created_at, converted.updated_at], [original.id, original.number, original.version, original.created_at, original.updated_at]);
      assert.equal(JSON.parse(converted.data).totalMinor, JSON.parse(original.data).total * 100);
    }
    const collections = await rows(store, 'order_collections');
    assert.equal(collections.find(row => row.order_id === 'partial').amount_minor, 2000000);
    assert.equal((await rows(store, 'cash_entries')).length, 0);
    assert.equal((await rows(store, 'business_audit')).length, beforeOrders.length);
    assert.equal((await rows(store, 'business_settings')).length, 1);
    assert.equal((await rows(store, 'platforms')).length, 0);
    assert.equal((await rows(store, 'people')).length, 0);
    assert.equal((await rows(store, 'migrations')).filter(row => row.version === 3).length, 1);
    assert.equal((await rows(store, 'counters')).find(row => row.id === 'business_revision').value, 0);
    const complete = await snapshot(store, [...BASE_TABLES, ...BUSINESS_TABLES]);
    assert.deepEqual(await migrateBusinessV3(store), { migrated: false, version: 3 });
    assert.deepEqual(await snapshot(store, [...BASE_TABLES, ...BUSINESS_TABLES]), complete);
  } finally { await store.close(); }
});

test('fallo al final revierte DDL, conversión, defaults y marcador, dejando intacta la base v2', async () => {
  const store = await v2Store({ failMarker: true });
  try {
    await seedV2(store);
    const before = await snapshot(store, BASE_TABLES);
    await assert.rejects(migrateBusinessV3(store), /Fallo sintético/);
    assert.deepEqual(await snapshot(store, BASE_TABLES), before);
    const tables = await store.db.all("SELECT name FROM sqlite_master WHERE type='table'");
    assert.equal(tables.some(row => BUSINESS_TABLES.includes(row.name)), false);
  } finally { await store.close(); }
});

test('conversión de respaldo restaurable produce las mismas filas comerciales que el upgrade persistido', async () => {
  const source = legacyBundle();
  const converted = JSON.parse(JSON.stringify(convertV2Bundle(source, { migrationAt: MIGRATED })));
  const store = await v2Store();
  try {
    await seedV2(store, source);
    await migrateBusinessV3(store);
    for (const table of ['shipments', 'shipment_events', 'order_collections']) {
      const actual = await rows(store, table);
      const expected = converted.business[table].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(actual, expected);
    }
    for (const order of converted.orders) {
      const row = await store.db.get(`SELECT * FROM ${store.t('orders')} WHERE id=?`, [order.id]);
      const { id, number, version, createdAt, updatedAt, history, ...expected } = order;
      assert.deepEqual(JSON.parse(row.data), expected);
    }
  } finally { await store.close(); }
});

test('esquema contiene las 31 tablas con FK restrictivas y protege importes/estados/unicidad', async () => {
  const store = await v2Store();
  try {
    await migrateBusinessV3(store);
    assert.equal(BUSINESS_TABLES.length, 31);
    for (const table of BUSINESS_TABLES) {
      assert.ok(await store.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]));
      const foreignKeys = await store.db.all(`PRAGMA foreign_key_list(${store.t(table)})`);
      assert.ok(foreignKeys.every(key => key.on_delete === 'RESTRICT'), table);
    }
    const insertPerson = id => store.db.run(`INSERT INTO ${store.t('people')}(id,name,created_at,updated_at) VALUES(?,?,?,?)`, [id, 'Persona sintética', CREATED, CREATED]);
    await insertPerson('responsible');
    await store.db.run(`INSERT INTO ${store.t('cash_accounts')}(id,name,type,opening_on,responsible_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, ['bank', 'Banco sintético', 'bank', '2026-08-31', 'responsible', CREATED, CREATED]);
    const cashEntry = (id, amount, kind) => store.db.run(`INSERT INTO ${store.t('cash_entries')}(id,account_id,effective_on,amount_minor,kind,source_type,source_id,recorded_at) VALUES(?,?,?,?,?,?,?,?)`, [id, 'bank', '2026-09-01', amount, kind, 'synthetic', id, CREATED]);
    await cashEntry('opening', 0, 'opening');
    await cashEntry('positive-boundary', 10000000000000, 'income');
    await cashEntry('negative-boundary', -10000000000000, 'adjustment');
    await assert.rejects(cashEntry('opening-again', 0, 'opening'));
    await assert.rejects(cashEntry('zero-income', 0, 'income'));
    await assert.rejects(cashEntry('too-large', 10000000000001, 'income'));
    await assert.rejects(cashEntry('too-small', -10000000000001, 'income'));
    await assert.rejects(cashEntry('fraction', 0.5, 'income'));
    await assert.rejects(cashEntry('bad-kind', 1, 'sale'));
    await assert.rejects(store.db.run(`DELETE FROM ${store.t('people')} WHERE id=?`, ['responsible']));
    await assert.rejects(store.db.run(`DELETE FROM ${store.t('cash_accounts')} WHERE id=?`, ['bank']));
    const settings = await store.db.get(`SELECT * FROM ${store.t('business_settings')} WHERE id=1`);
    assert.ok(settings.created_at);
    assert.ok(settings.updated_at);
    assert.equal(settings.version, 1);
  } finally { await store.close(); }
});

test('inventario v4 conserva existencias físicas, toma reservas históricas y no modifica caja ni historia', async () => {
  const store = await v2Store();
  try {
    await seedV2(store);
    await migrateBusinessV3(store);
    const row = await store.db.get(`SELECT * FROM ${store.t('records')} WHERE id='product-a'`);
    await store.db.run(`UPDATE ${store.t('records')} SET data=? WHERE id=?`, [JSON.stringify({...JSON.parse(row.data),stockQuantity:10,availability:'soldout'}),row.id]);
    const preserved = await snapshot(store, ['users','sessions','order_audit','order_events','idempotency','cash_entries','order_collections','shipment_events','counters']);
    const beforeOrders = await rows(store,'orders');
    assert.deepEqual(await migrateInventoryV4(store),{migrated:true,version:4});
    assert.deepEqual(await snapshot(store,Object.keys(preserved)),preserved);
    const product = await store.get('products','product-a');
    assert.equal(product.stockQuantity,10);
    assert.equal(product.stockReserved,2);
    assert.equal(product.version,row.version+1);
    assert.equal(Object.hasOwn(JSON.parse((await store.db.get(`SELECT data FROM ${store.t('records')} WHERE id='product-a'`)).data),'availability'),false);
    const archived = await store.get('products','product-archived');
    assert.equal(archived.stockQuantity,null);
    assert.equal(archived.stockReserved,0);
    for (const original of beforeOrders) {
      const current = await store.db.get(`SELECT * FROM ${store.t('orders')} WHERE id=?`,[original.id]);
      const data = JSON.parse(current.data); delete data.inventory;
      assert.deepEqual(data,JSON.parse(original.data));
      assert.deepEqual([current.version,current.created_at,current.updated_at],[original.version,original.created_at,original.updated_at]);
    }
    const complete = await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]);
    assert.deepEqual(await migrateInventoryV4(store),{migrated:false,version:4});
    assert.deepEqual(await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]),complete);
    await store.transaction(async tx=>{await tx.lockWrites();await resolveOrderRecognition(tx,'partial','migration-contract');});
    const unchanged=await store.get('products','product-a');
    assert.equal(unchanged.stockQuantity,10,'Reevaluar un despacho histórico no descuenta unidades otra vez');
    assert.equal(unchanged.stockReserved,2);
  } finally { await store.close(); }
});

test('inventario v4 rechaza existencias conocidas inválidas o insuficientes sin escribir parcialmente', async () => {
  for (const quantity of [-1,1.5,1,Number.MAX_SAFE_INTEGER+1]) {
    const store = await v2Store();
    try {
      await seedV2(store); await migrateBusinessV3(store);
      const row = await store.db.get(`SELECT data FROM ${store.t('records')} WHERE id='product-a'`);
      await store.db.run(`UPDATE ${store.t('records')} SET data=? WHERE id='product-a'`,[JSON.stringify({...JSON.parse(row.data),stockQuantity:quantity})]);
      const before = await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]);
      await assert.rejects(migrateInventoryV4(store),/inventario|existencia|reservas/i);
      assert.deepEqual(await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]),before);
    } finally { await store.close(); }
  }
});

test('un fallo del marcador v4 revierte reservas, línea base y auditoría', async () => {
  const store = await v2Store({failInventoryMarker:true});
  try {
    await seedV2(store); await migrateBusinessV3(store);
    const before = await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]);
    await assert.rejects(migrateInventoryV4(store),/Fallo sintético/);
    assert.deepEqual(await snapshot(store,[...BASE_TABLES,...BUSINESS_TABLES]),before);
  } finally { await store.close(); }
});

test('la línea base usa correcciones efectivas y devoluciones sin descontar físicamente el pasado', async () => {
  const store = await v2Store();
  try {
    await seedV2(store); await migrateBusinessV3(store);
    const event = (await rows(store,'shipment_events')).find(row => row.shipment_id===idFor('shipment','partial'));
    await store.db.run(`INSERT INTO ${store.t('shipment_events')}(id,shipment_id,external_key,status,recorded_at,data) VALUES(?,?,?,?,?,?)`,['corrected-event',event.shipment_id,'corrected-legacy-event','unknown',MIGRATED,JSON.stringify({source:'manual',correctionOf:event.id})]);
    await store.db.run(`INSERT INTO ${store.t('order_returns')}(id,order_id,occurred_on,reason,kind,recorded_at,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)`,['historical-return','no-shipment','2026-09-04','Baja histórica','return',MIGRATED,MIGRATED,MIGRATED,JSON.stringify({shippingCreditMinor:0,lines:[{lineId:'linea-historica',quantity:1,condition:'non_recoverable',salesCreditMinor:0,recoveredCostMinor:0}]})]);
    await migrateInventoryV4(store);
    const orders = await store.orders();
    assert.deepEqual(orders.find(order => order.id==='partial').inventory.products,[{productId:'product-a',reserved:2,consumed:0}]);
    assert.deepEqual(orders.find(order => order.id==='no-shipment').inventory.products,[{productId:'product-a',reserved:1,consumed:1}]);
    const product = await store.get('products','product-a');
    assert.equal(product.stockQuantity,null);
    assert.equal(product.stockReserved,3);
    assert.equal((await rows(store,'cash_entries')).length,0);
  } finally { await store.close(); }
});

test('inventario v4 acepta existencias enteras seguras sin imponer el límite comercial de importes', async () => {
  const store = await v2Store();
  try {
    await seedV2(store); await migrateBusinessV3(store);
    const row = await store.db.get(`SELECT data FROM ${store.t('records')} WHERE id='product-a'`);
    await store.db.run(`UPDATE ${store.t('records')} SET data=? WHERE id='product-a'`,[JSON.stringify({...JSON.parse(row.data),stockQuantity:Number.MAX_SAFE_INTEGER})]);
    await migrateInventoryV4(store);
    const product = await store.get('products','product-a');
    assert.equal(product.stockQuantity,Number.MAX_SAFE_INTEGER);
    assert.equal(product.stockReserved,2);
  } finally { await store.close(); }
});
