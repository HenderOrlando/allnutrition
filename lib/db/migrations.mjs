import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { schemas } from '../schema.mjs';
import { fail } from '../validation.mjs';
import { initializeBusinessDefaults } from '../business/settings.mjs';
import { inventoryState } from '../business/inventory.mjs';
import { effectiveShipmentEvents } from '../business/shipments.mjs';
import { audit, canonicalJSON, entity } from '../business/commands.mjs';

// Parents precede children; restoration deletes in the reverse order.
export const BUSINESS_TABLES = Object.freeze([
  'business_settings', 'people', 'platforms', 'platform_sources', 'product_costs',
  'shipments', 'shipment_events', 'import_profiles', 'import_batches', 'import_revisions',
  'import_rows', 'external_links', 'cash_accounts', 'cash_entries', 'cash_closings',
  'order_collections', 'settlements', 'settlement_receipts', 'expenses', 'expense_payments',
  'order_returns', 'payroll_periods', 'payroll_allocations', 'payroll_offsets',
  'commission_entries', 'report_snapshots', 'alert_rules', 'alerts', 'business_audit',
  'business_requests', 'job_runs'
]);

const MAX_MINOR = 10000000000000;
const RETIRED_ORDER_FIELDS = [
  'unitPrice', 'subtotal', 'total', 'shippingCost', 'carrier', 'tracking', 'estimatedDelivery',
  'paymentStatus', 'paymentAmount', 'paymentDate', 'paymentMethod', 'paymentReference', 'paymentReceiptUrl'
];
const PAYMENT_FIELDS = ['paymentStatus', 'paymentAmount', 'paymentDate', 'paymentMethod', 'paymentReference', 'paymentReceiptUrl'];
const derivedId = (type, originalId) => createHash('sha256').update(`v3:${type}:${originalId}`).digest('hex').slice(0, 32);
const select = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const bogotaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

function instant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label}: instante no válido en el respaldo.`);
  return value;
}
function businessDay(value) {
  const parts = Object.fromEntries(bogotaDay.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function legacyDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Fecha comercial histórica no válida.');
  return value;
}
function pesosToMinor(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}: el respaldo debe contener pesos enteros no negativos.`);
  const minor = BigInt(value) * 100n;
  if (minor > BigInt(MAX_MINOR)) fail(`${label}: importe fuera del límite de negocio.`);
  return Number(minor);
}
function quantity(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) fail('Cantidad histórica fuera del rango 1–999.');
  return value;
}
function guideKey(order) {
  if (!order.tracking) return null;
  return JSON.stringify([String(order.carrier || '').normalize('NFKC').trim().toLocaleLowerCase('es-CO').replace(/\s+/g, ' '), String(order.tracking)]);
}

/** Pure restoration conversion: does not read the clock, mutate its input, or access a database. */
export function convertV2Bundle(bundle, { migrationAt } = {}) {
  if (!bundle || !['allnutrition-export-v2', 'allnutrition-export-v3'].includes(bundle.format)) fail('Formato de respaldo no reconocido.');
  if (bundle.format === 'allnutrition-export-v3') return structuredClone(bundle);
  instant(migrationAt, 'Fecha de migración');
  const converted = structuredClone(bundle);
  converted.format = 'allnutrition-export-v3';
  // Raw SQL rows are confined to business. Content and order DTOs keep their existing shape.
  converted.business = Object.fromEntries(BUSINESS_TABLES.map(table => [table, []]));
  if (!Array.isArray(converted.products) || !Array.isArray(converted.orders)) fail('El respaldo no contiene productos y pedidos válidos.');
  converted.products = converted.products.map(product => ({
    ...product, productType: 'product', sku: '', unitCostMinor: null, costEffectiveOn: null,
    orderable: product.status === 'published'
  }));
  const guideCounts = new Map();
  for (const order of converted.orders) {
    const key = guideKey(order);
    if (key) guideCounts.set(key, (guideCounts.get(key) || 0) + 1);
  }
  converted.orders = converted.orders.map(order => {
    if (typeof order.id !== 'string' || !order.id) fail('Pedido histórico sin identificador.');
    const createdAt = instant(order.createdAt, 'Creación del pedido');
    const updatedAt = instant(order.updatedAt || createdAt, 'Actualización del pedido');
    if (!Array.isArray(order.items) || !order.items.length) fail('Pedido histórico sin líneas.');
    const items = order.items.map((line, index) => {
      const { unitPrice, ...rest } = line;
      const components = (line.components || []).map(component => ({ ...component, quantity: quantity(component.quantity), unitCostMinor: null }));
      return {
        ...rest, lineId: line.lineId || derivedId('line', `${order.id}:${index}`), productType: 'product',
        quantity: quantity(line.quantity), unitPriceMinor: pesosToMinor(unitPrice, 'Precio unitario'),
        discountMinor: 0, unitCostMinor: null, components
      };
    });
    const subtotalMinor = pesosToMinor(order.subtotal, 'Subtotal');
    const shippingChargeMinor = pesosToMinor(order.shippingCost ?? 0, 'Flete cobrado');
    const totalMinor = pesosToMinor(order.total, 'Total');
    const calculatedSubtotal = items.reduce((sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitPriceMinor), 0n);
    if (calculatedSubtotal !== BigInt(subtotalMinor) || BigInt(subtotalMinor) + BigInt(shippingChargeMinor) !== BigInt(totalMinor)) fail('Los totales históricos no coinciden con sus líneas.');
    if (!['pending', 'partial', 'paid', 'refunded'].includes(order.paymentStatus)) fail('Estado de pago histórico no válido.');
    const amountMinor = pesosToMinor(order.paymentAmount ?? 0, 'Pago histórico');
    if (amountMinor > totalMinor) fail('El pago histórico excede el total del pedido.');
    const paymentOn = legacyDate(order.paymentDate);
    const originalPayment = select(order, PAYMENT_FIELDS);
    const requiresReview = order.paymentStatus === 'refunded' || amountMinor > 0;
    const result = {
      ...order, items, placedOn: businessDay(createdAt), dateSource: 'legacy_record', sellerId: null,
      shippingChargeMinor, subtotalMinor, totalMinor,
      legacyFinancialReview: {
        ...originalPayment, amountMinor, occurredOn: paymentOn,
        required: requiresReview, state: requiresReview ? 'pending' : 'not_required',
        source: 'legacy', reason: order.paymentStatus === 'refunded' ? 'ambiguous_refund' : 'legacy_payment_unreconciled'
      },
      legacyPolicyReview: true
    };
    for (const field of RETIRED_ORDER_FIELDS) delete result[field];
    let shipmentId = null;
    const hasShipment = !!(order.carrier || order.tracking || order.estimatedDelivery || ['sent', 'delivered', 'returned'].includes(order.status));
    if (hasShipment) {
      shipmentId = derivedId('shipment', order.id);
      const observedStatus = ({ sent: 'in_transit', delivered: 'delivered', returned: 'returned', cancelled: 'cancelled' })[order.status] || 'unknown';
      const duplicateGuide = (guideCounts.get(guideKey(order)) || 0) > 1;
      converted.business.shipments.push({
        id: shipmentId, order_id: order.id, platform_id: null, source_id: null, external_id: null,
        identity_key: null, status: observedStatus, carrier: order.carrier || '', tracking: order.tracking || '',
        source_as_of: null, version: 1, created_at: createdAt, updated_at: updatedAt,
        data: JSON.stringify({
          source: 'legacy', rawStatus: order.status, deliveryMethod: order.deliveryMethod || 'carrier',
          estimatedDeliveryOn: legacyDate(order.estimatedDelivery), costStatus: 'unknown',
          assignments: items.map(line => ({ lineId: line.lineId, quantity: line.quantity })),
          duplicateTrackingReview: duplicateGuide,
          reviewReasons: duplicateGuide ? ['duplicate_legacy_guide'] : []
        })
      });
      converted.business.shipment_events.push({
        id: derivedId('shipment_event', order.id), shipment_id: shipmentId, external_key: `legacy:${order.id}:observed`,
        status: observedStatus, occurred_at: null, occurred_on: null, recorded_at: updatedAt, source_as_of: null,
        data: JSON.stringify({ source: 'legacy', rawStatus: order.status, occurrencePrecision: 'unknown' })
      });
    }
    // A refunded v2 row does not tell us what was received or refunded. Preserve it for review only.
    if (order.paymentStatus !== 'refunded' && amountMinor > 0) {
      converted.business.order_collections.push({
        id: derivedId('collection', order.id), order_id: order.id, shipment_id: shipmentId, kind: 'receipt', holder: 'legacy',
        amount_minor: amountMinor, occurred_on: paymentOn, cash_entry_id: null, reversal_of: null,
        external_key: `legacy:${order.id}:payment`, recorded_at: updatedAt,
        data: JSON.stringify({ source: 'legacy', declaredStatus: order.paymentStatus, requiresReconciliation: true, ...originalPayment })
      });
    }
    converted.business.business_audit.push({
      id: derivedId('audit', order.id), entity_type: 'order', entity_id: order.id, actor_id: 'migration:v3', recorded_at: migrationAt,
      data: JSON.stringify({
        previous: {
          ...select(order, [...RETIRED_ORDER_FIELDS, 'status', 'deliveryMethod']),
          items: order.items.map(line => select(line, ['lineId', 'kind', 'itemId', 'quantity', 'unitPrice', 'components']))
        },
        next: { items, shippingChargeMinor, subtotalMinor, totalMinor, placedOn: result.placedOn, dateSource: result.dateSource },
        reason: 'Conversión de datos históricos v2 a v3 sin inferir caja, costos ni fechas logísticas.', source: 'legacy'
      })
    });
    return result;
  });
  return converted;
}

function contentData(record) {
  const { id, version, createdAt, updatedAt, ...data } = record;
  return data;
}

/** Upgrade is the only DDL entry point. PostgreSQL calls this from the migration CLI, never runtime. */
export async function migrateBusinessV3(store) {
  if (!['sqlite', 'supabase'].includes(store.provider)) fail('Motor de base de datos no admitido.');
  return store.transaction(async tx => {
    await tx.lockWrites();
    if (await tx.db.get(`SELECT version FROM ${tx.t('migrations')} WHERE version=3`)) return { migrated: false, version: 3 };
    if (!await tx.db.get(`SELECT version FROM ${tx.t('migrations')} WHERE version=2`)) fail('La migración requiere el esquema base v2.');
    const migrationAt = new Date().toISOString();
    const ddl = await readFile(resolve(process.cwd(), 'db', `business-v3.${store.provider === 'sqlite' ? 'sqlite' : 'postgres'}.sql`), 'utf8');
    await tx.db.exec(ddl);
    const bundle = { format: 'allnutrition-export-v2', exportedAt: migrationAt, orders: [] };
    for (const kind of Object.keys(schemas)) bundle[kind] = [];
    const records = await tx.db.all(`SELECT * FROM ${tx.t('records')} ORDER BY id`);
    for (const row of records) {
      if (!bundle[row.kind]) fail('El catálogo contiene una sección histórica no reconocida.');
      bundle[row.kind].push({ ...JSON.parse(row.data), id: row.id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
    }
    const orders = await tx.db.all(`SELECT * FROM ${tx.t('orders')} ORDER BY number,id`);
    bundle.orders = orders.map(row => ({ ...JSON.parse(row.data), id: row.id, number: row.number, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }));
    const converted = convertV2Bundle(bundle, { migrationAt });
    for (const product of converted.products) await tx.db.run(`UPDATE ${tx.t('records')} SET data=? WHERE id=?`, [JSON.stringify(contentData(product)), product.id]);
    for (const order of converted.orders) {
      const { number, history, ...record } = order;
      await tx.db.run(`UPDATE ${tx.t('orders')} SET data=? WHERE id=?`, [JSON.stringify(contentData(record)), order.id]);
    }
    for (const table of BUSINESS_TABLES) {
      for (const row of converted.business[table]) {
        const columns = Object.keys(row);
        await tx.db.run(`INSERT INTO ${tx.t(table)}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, columns.map(column => row[column]));
      }
    }
    await initializeBusinessDefaults(tx);
    await tx.db.run(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(3,?)`, [migrationAt]);
    return { migrated: true, version: 3 };
  });
}

const stockCount = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}: cantidad de inventario no válida.`);
  return value;
};

/** Shared historical cutover and restore validation; never changes physical quantities. */
export function normalizeInventoryBundle(bundle, { baseline = false } = {}) {
  const products = new Map(bundle.products.map(product => [product.id, product]));
  const orders = new Map(bundle.orders.map(order => [order.id, order]));
  const shipments = (bundle.business.shipments || []).map(entity);
  const shipmentIds = new Set(shipments.map(shipment => shipment.id));
  const events = new Map(shipments.map(shipment => [shipment.id, []]));
  for (const row of bundle.business.shipment_events || []) {
    const event = entity(row);
    if (!shipmentIds.has(event.shipmentId)) fail('Evento de inventario sin envío existente.');
    events.get(event.shipmentId).push(event);
  }
  for (const [id, values] of events) events.set(id, effectiveShipmentEvents(values));
  for (const shipment of shipments) if (shipment.orderId && !orders.has(shipment.orderId)) fail('Envío de inventario sin pedido existente.');
  const returns = (bundle.business.order_returns || []).map(entity);
  for (const returned of returns) if (!orders.has(returned.orderId)) fail('Devolución de inventario sin pedido existente.');
  const reserved = new Map();
  for (const order of bundle.orders) {
    const expected = inventoryState(order, shipments.filter(shipment => shipment.orderId === order.id), events, returns.filter(returned => returned.orderId === order.id));
    if (!baseline || Object.hasOwn(order, 'inventory')) {
      if (!order.inventory || canonicalJSON(order.inventory) !== canonicalJSON(expected)) fail('El inventario del pedido no coincide con sus envíos y devoluciones.');
    }
    for (const item of expected.products) {
      const product = products.get(item.productId);
      if (!product || product.productType === 'gift') fail('Inventario asociado a un producto físico inexistente.');
      stockCount(item.reserved, 'Reserva'); stockCount(item.consumed, 'Consumo');
      reserved.set(item.productId, stockCount((reserved.get(item.productId) || 0) + item.reserved, 'Reserva acumulada'));
    }
    order.inventory = expected;
  }
  for (const product of bundle.products) {
    const quantity = product.stockQuantity === undefined && baseline ? null : product.stockQuantity;
    if (quantity !== null) stockCount(quantity, 'Existencia física');
    const aggregate = reserved.get(product.id) || 0;
    if (!baseline || Object.hasOwn(product, 'stockReserved')) {
      stockCount(product.stockReserved, 'Reserva de producto');
      if (product.stockReserved !== aggregate) fail('Las reservas del producto no coinciden con sus pedidos.');
    }
    if (product.productType === 'gift' && (quantity !== null || aggregate !== 0)) fail('Un obsequio no puede tener existencias propias.');
    if (quantity !== null && aggregate > quantity) fail('Las reservas exceden la existencia física del producto.');
    product.stockQuantity = quantity;
    product.stockReserved = aggregate;
    delete product.availability;
    delete product.stockAvailable;
  }
  for (const combo of bundle.combos || []) delete combo.availability;
  bundle.inventoryVersion = 1;
  return bundle;
}

/** JSON-only inventory baseline, serialized with normal business writers. */
export async function migrateInventoryV4(store) {
  if (!['sqlite', 'supabase'].includes(store.provider)) fail('Motor de base de datos no admitido.');
  return store.transaction(async tx => {
    await tx.lockWrites();
    if (await tx.db.get(`SELECT version FROM ${tx.t('migrations')} WHERE version=4`)) return { migrated: false, version: 4 };
    if (!await tx.db.get(`SELECT version FROM ${tx.t('migrations')} WHERE version=3`)) fail('La migración de inventario requiere el esquema comercial v3.');
    const migrationAt = new Date().toISOString();
    const productRows = await tx.db.all(`SELECT * FROM ${tx.t('records')} WHERE kind IN ('products','combos') ORDER BY id`);
    const orderRows = await tx.db.all(`SELECT * FROM ${tx.t('orders')} ORDER BY id`);
    const decode = row => ({ ...JSON.parse(row.data), id: row.id });
    const bundle = { products: productRows.filter(row => row.kind === 'products').map(decode), combos: productRows.filter(row => row.kind === 'combos').map(decode), orders: orderRows.map(decode), business: {} };
    for (const table of ['shipments', 'shipment_events', 'order_returns']) bundle.business[table] = await tx.db.all(`SELECT * FROM ${tx.t(table)} ORDER BY id`);
    normalizeInventoryBundle(bundle, { baseline: true });
    for (const row of productRows) {
      const next = (row.kind === 'products' ? bundle.products : bundle.combos).find(product => product.id === row.id);
      const data = contentData(next);
      if (canonicalJSON(data) === canonicalJSON(JSON.parse(row.data))) continue;
      await tx.db.run(`UPDATE ${tx.t('records')} SET data=?,version=version+1,updated_at=? WHERE id=?`, [JSON.stringify(data), migrationAt, row.id]);
      await audit(tx, { entityType: row.kind === 'products' ? 'product' : 'combo', entityId: row.id, actorId: 'migration:v4', recordedAt: migrationAt, previous: select(JSON.parse(row.data), ['stockQuantity', 'stockReserved', 'availability']), next: select(data, ['stockQuantity', 'stockReserved']), reason: 'Inventario histórico inicial sin inventar existencias ni descontar despachos anteriores.', source: 'legacy' });
    }
    for (const order of bundle.orders) {
      const original = orderRows.find(row => row.id === order.id);
      await tx.db.run(`UPDATE ${tx.t('orders')} SET data=? WHERE id=?`, [JSON.stringify(contentData(order)), order.id]);
      await audit(tx, { entityType: 'order', entityId: order.id, actorId: 'migration:v4', recordedAt: migrationAt, previous: { inventory: JSON.parse(original.data).inventory ?? null }, next: { inventory: order.inventory }, reason: 'Línea base de inventario histórico sin movimientos físicos ni cambios de caja.', source: 'legacy' });
    }
    await tx.db.run(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(4,?)`, [migrationAt]);
    return { migrated: true, version: 4 };
  });
}
