/** Repositorio común y asíncrono. Las dos bases ejecutan el mismo flujo de negocio. */
import { randomUUID } from 'node:crypto';
import { defaults, schemas } from './schema.mjs';
import { fail, integer, validateRecord, validateSettings } from './validation.mjs';
import { recordProductCost } from './business/catalog.mjs';
import { inventoryAvailability, stockAvailable } from './inventory.mjs';
import { audit, bumpRevision } from './business/commands.mjs';
import { bogotaDate } from './business/dates.mjs';
import { getOrder, pageOrders, saveOrder } from './business/orders.mjs';
import { exportCommercialData } from './business-backup.mjs';
const decode = row => row ? { ...JSON.parse(row.data), id: row.id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null;
const now = () => new Date().toISOString();

export class Store {
  constructor(adapter) { this.db = adapter; this.provider = adapter.provider; }
  t(name) { return this.db.table(name); }
  close() { return this.db.close(); }
  async initialize() {
    await this.db.run(`INSERT INTO ${this.t('settings')}(id,data) VALUES(1,?) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(defaults)]);
    await this.db.run(`INSERT INTO ${this.t('counters')}(id,value) VALUES('write_lock',0) ON CONFLICT(id) DO NOTHING`);
  }
  transaction(fn) { return this.db.transaction(tx => fn(new Store(tx))); }
  readSnapshot(fn) { return this.db.readSnapshot(reader => fn(new Store(reader))); }
  // Evita carreras de relaciones JSON entre borrar/archivar productos, combos y crear pedidos.
  async lockWrites() { await this.db.run(`UPDATE ${this.t('counters')} SET value=value WHERE id='write_lock'`); }
  ensureKind(kind) { if (!Object.hasOwn(schemas, kind)) fail('Sección no encontrada.', 404); }
  async withInventory(kind, records, allProducts = null) {
    if (!['products','combos'].includes(kind) || !records.length) return records;
    const products = allProducts || (kind === 'combos' || records.some(record => record.productType === 'gift') ? (await this.db.all(`SELECT * FROM ${this.t('records')} WHERE kind='products'`)).map(decode) : records);
    const byId = new Map(products.map(product => [product.id, product]));
    return records.map(record => ({...record,...(kind === 'products' ? {stockQuantity:record.stockQuantity ?? null,stockReserved:record.stockReserved || 0} : {}),stockAvailable:stockAvailable(record,byId),availability:inventoryAvailability(record,byId)}));
  }
  async list(kind, { published = false } = {}) {
    this.ensureKind(kind);
    const records = (await this.db.all(`SELECT * FROM ${this.t('records')} WHERE kind=? ${published ? "AND status='published'" : ''} ORDER BY sort_order,created_at,id`, [kind])).map(decode);
    return this.withInventory(kind, records, kind === 'products' && !published ? records : null);
  }
  async get(kind, id) { this.ensureKind(kind); const record=decode(await this.db.get(`SELECT * FROM ${this.t('records')} WHERE kind=? AND id=?`, [kind, id])); return record ? (await this.withInventory(kind,[record]))[0] : null; }
  async bySlug(kind, slug) { this.ensureKind(kind); const record=decode(await this.db.get(`SELECT * FROM ${this.t('records')} WHERE kind=? AND slug=? AND status='published'`, [kind, slug])); return record ? (await this.withInventory(kind,[record]))[0] : null; }
  async settings() { const row = await this.db.get(`SELECT * FROM ${this.t('settings')} WHERE id=1`); return { ...defaults, ...JSON.parse(row.data), version: row.version }; }
  async saveSettings(data, version) {
    integer(version, 'Versión', 1);
    const clean = validateSettings(data);
    const result = await this.db.run(`UPDATE ${this.t('settings')} SET data=?,version=version+1 WHERE id=1 AND version=?`, [JSON.stringify(clean), version]);
    if (!result.changes) fail('La configuración cambió en otra sesión. Recarga antes de guardar.', 409);
    return { ...clean, version: version + 1 };
  }
  async validateRelations(kind, data, ownId = null) {
    for (const id of data.catalogIds || []) if (!await this.get('catalogs', id)) fail('Uno de los catálogos no existe.');
    if (kind === 'products' && data.productType === 'gift' && ownId) {
      for (const container of [...await this.list('products'), ...await this.list('combos')]) if (container.id !== ownId && container.items?.some(i => i.productId === ownId)) fail('Retira este producto de sus composiciones antes de convertirlo en obsequio.', 409);
    }
    if (kind === 'products' && data.sku && (await this.list('products')).some(p => p.id !== ownId && p.sku === data.sku)) fail('Ya existe un producto con ese SKU.', 409);
    if (kind === 'combos' || (kind === 'products' && data.productType === 'gift')) for (const line of data.items) {
      const product = await this.get('products', line.productId);
      if (!product || product.id === ownId || product.productType === 'gift') fail('Los componentes deben ser productos normales existentes.');
      if (kind === 'combos' && data.status === 'published' && product.status !== 'published') fail('Publica primero los productos que contiene el combo.');
    }
  }
  async save(kind, input, id = null, version = null, actorId = 'system') {
    try {
      return await this.transaction(store => store.saveTx(kind, input, id, version, actorId));
    } catch (error) { if (error.code === '23505' || /UNIQUE constraint/.test(error.message)) fail('Ya existe un registro con esa dirección corta.', 409); throw error; }
  }
  // Reuses an existing write transaction; callers own command idempotency.
  async saveTx(kind, input, id = null, version = null, actorId = 'system') {
    const store = this, data = validateRecord(kind, input);
    if (id) integer(version, 'Versión', 1);
    await store.lockWrites();
    await store.validateRelations(kind, data, id);
        const stamp = now(), key = id || randomUUID();
        const previous = id ? await store.get(kind, id) : null;
        if (kind === 'products') {
          data.stockReserved = previous?.stockReserved || 0;
          if (previous && previous.productType !== data.productType) {
            if (previous.stockQuantity > 0 || previous.stockReserved > 0 || (await store.orders()).some(order => order.items.some(line => line.itemId === key || line.components?.some(component => component.productId === key)))) fail('El tipo de una referencia con existencias o pedidos no se puede cambiar. Crea otra referencia.',409);
          }
          if (previous?.stockQuantity != null && data.productType !== 'gift' && data.stockQuantity == null) fail('Las existencias contadas no pueden volver a quedar sin definir.');
          if (data.stockQuantity != null && data.stockQuantity < data.stockReserved) fail(`El conteo físico no puede ser menor que las ${data.stockReserved} unidades reservadas.`,409);
        }
        if (kind === 'products' && data.productType === 'product' && data.status === 'published' && previous?.status !== 'published') data.orderable = true;
        if (kind === 'products' && data.productType !== 'gift' && !data.costEffectiveOn) data.costEffectiveOn = previous?.costEffectiveOn || bogotaDate();
        if (id) {
          const old = await store.get(kind, id);
          if (!old) fail('Registro no encontrado.', 404);
          const result = await store.db.run(`UPDATE ${store.t('records')} SET slug=?,title=?,status=?,sort_order=?,data=?,version=version+1,updated_at=? WHERE id=? AND kind=? AND version=?`, [data.slug, data.title, data.status, data.sort, JSON.stringify(data), stamp, key, kind, version]);
          if (!result.changes) fail('Otro usuario modificó este registro. Recarga antes de guardar.', 409);
        } else await store.db.run(`INSERT INTO ${store.t('records')}(id,kind,slug,title,status,sort_order,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, [key, kind, data.slug, data.title, data.status, data.sort, JSON.stringify(data), stamp, stamp]);
        if (kind === 'products' && data.productType !== 'gift') await recordProductCost(store, key, data, previous, actorId);
        if (kind === 'products' && data.productType !== 'gift' && (previous?.stockQuantity ?? null) !== data.stockQuantity) await audit(store,{entityType:'inventory',entityId:key,actorId,previous:{stockQuantity:previous?.stockQuantity ?? null,stockReserved:previous?.stockReserved || 0},next:{stockQuantity:data.stockQuantity,stockReserved:data.stockReserved},reason:'Conteo físico de existencias'});
        if (['products','combos'].includes(kind)) await bumpRevision(store);
        return store.get(kind, key);
  }
  async remove(kind, id, version) {
    integer(version, 'Versión', 1);
    return this.transaction(async store => {
      await store.lockWrites();
      const old = await store.get(kind, id);
      if (!old) fail('Registro no encontrado.', 404);
      if (old.version !== version) fail('El registro cambió. Recarga antes de eliminar.', 409);
      if (kind === 'products' && (old.stockQuantity > 0 || old.stockReserved > 0)) fail('La referencia tiene existencias o reservas. Archívala para conservar el inventario.',409);
      if (['products', 'combos'].includes(kind)) {
        for (const order of await store.orders()) {
          if (order.items.some(line => (line.kind === kind && line.itemId === id) || (kind === 'products' && line.components?.some(c => c.productId === id)))) fail('La referencia tiene pedidos. Archívala para conservar el historial.', 409);
        }
      }
      if (kind === 'products' && (await store.list('combos')).some(c => c.items.some(i => i.productId === id))) fail('El producto forma parte de un combo. Archívalo o retíralo del combo.', 409);
      if (kind === 'products' && (await store.list('products')).some(p => p.items?.some(i => i.productId === id))) fail('El producto forma parte de un obsequio. Archívalo o retíralo del obsequio.', 409);
      if (kind === 'products') await store.db.run(`DELETE FROM ${store.t('product_costs')} WHERE product_id=?`, [id]);
      if (kind === 'catalogs') for (const k of ['products', 'combos']) if ((await store.list(k)).some(r => r.catalogIds.includes(id))) fail('Retira el catálogo de sus referencias antes de eliminarlo.', 409);
      await store.db.run(`DELETE FROM ${store.t('records')} WHERE id=? AND kind=? AND version=?`, [id, kind, version]);
      if (['products','combos'].includes(kind)) await bumpRevision(store);
      return { ok: true };
    });
  }
  async orders() { return (await this.db.all(`SELECT * FROM ${this.t('orders')} ORDER BY number DESC`)).map(row => ({ ...decode(row), number: row.number })); }
  pageOrders(filters = {}) { return this.db.readSnapshot ? this.readSnapshot(tx => pageOrders(tx, filters)) : pageOrders(this, filters); }
  order(id) { return this.db.readSnapshot ? this.readSnapshot(tx => getOrder(tx, id)) : getOrder(this, id); }
  saveOrder(input, actor, id = null, version = null) { return saveOrder(this, input, actor, id, version); }
  async publicData() {
    const fullSettings = await this.settings();
    const settings = Object.fromEntries(['brandName','tagline','logo','whatsapp','whatsappTemplate','facebook','instagram','email','hours','paymentInfo','launchApproved'].map(k => [k, fullSettings[k]]));
    const pick = (row, fields) => Object.fromEntries(fields.filter(k => Object.hasOwn(row,k)).map(k => [k,row[k]]));
    const common = ['id','version','createdAt','updatedAt','title','slug','status','sort'];
    const allProducts = await this.list('products');
    const products = allProducts.filter(p => p.status === 'published').map(p => pick(p,[...common,'image','description','presentation','flavor','price','availability','featured','catalogIds','productInfo']));
    const catalogs = (await this.list('catalogs', { published: true })).map(c => pick(c,[...common,'description','image']));
    const allowed = new Map(products.map(p => [p.id, p]));
    const combos = (await this.list('combos', { published: true })).filter(c => c.items.every(i => allowed.has(i.productId))).map(c => pick(c,[...common,'description','image','price','items','catalogIds','conditions','availability']));
    const output = { settings, products, catalogs, combos };
    const publicFields = {faqs:['answer'],messages:['placement','body','buttonText'],shipping:['zone','costText','estimatedTime','cashOnDelivery','details']};
    for (const kind of ['faqs', 'messages', 'shipping']) output[kind] = (await this.list(kind, { published: true })).map(r => pick(r,[...common,...publicFields[kind]]));
    return output;
  }
  exportData() { return this.readSnapshot(exportCommercialData); }
}
