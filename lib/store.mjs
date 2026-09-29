/** Repositorio común y asíncrono. Las dos bases ejecutan el mismo flujo de negocio. */
import { randomUUID, createHash } from 'node:crypto';
import { defaults, schemas } from './schema.mjs';
import { fail, integer, text, validateRecord, validateSettings, validateOrder, validateTransition } from './validation.mjs';
const decode = row => row ? { ...JSON.parse(row.data), id: row.id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');

export class Store {
  constructor(adapter) { this.db = adapter; this.provider = adapter.provider; }
  t(name) { return this.db.table(name); }
  close() { return this.db.close(); }
  async initialize() {
    await this.db.run(`INSERT INTO ${this.t('settings')}(id,data) VALUES(1,?) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(defaults)]);
    await this.db.run(`INSERT INTO ${this.t('counters')}(id,value) VALUES('write_lock',0) ON CONFLICT(id) DO NOTHING`);
  }
  transaction(fn) { return this.db.transaction(tx => fn(new Store(tx))); }
  // Evita carreras de relaciones JSON entre borrar/archivar productos, combos y crear pedidos.
  async lockWrites() { await this.db.run(`UPDATE ${this.t('counters')} SET value=value WHERE id='write_lock'`); }
  ensureKind(kind) { if (!Object.hasOwn(schemas, kind)) fail('Sección no encontrada.', 404); }
  async list(kind, { published = false } = {}) {
    this.ensureKind(kind);
    return (await this.db.all(`SELECT * FROM ${this.t('records')} WHERE kind=? ${published ? "AND status='published'" : ''} ORDER BY sort_order,created_at,id`, [kind])).map(decode);
  }
  async get(kind, id) { this.ensureKind(kind); return decode(await this.db.get(`SELECT * FROM ${this.t('records')} WHERE kind=? AND id=?`, [kind, id])); }
  async bySlug(kind, slug) { this.ensureKind(kind); return decode(await this.db.get(`SELECT * FROM ${this.t('records')} WHERE kind=? AND slug=? AND status='published'`, [kind, slug])); }
  async settings() { const row = await this.db.get(`SELECT * FROM ${this.t('settings')} WHERE id=1`); return { ...defaults, ...JSON.parse(row.data), version: row.version }; }
  async saveSettings(data, version) {
    integer(version, 'Versión', 1);
    const clean = validateSettings(data);
    const result = await this.db.run(`UPDATE ${this.t('settings')} SET data=?,version=version+1 WHERE id=1 AND version=?`, [JSON.stringify(clean), version]);
    if (!result.changes) fail('La configuración cambió en otra sesión. Recarga antes de guardar.', 409);
    return { ...clean, version: version + 1 };
  }
  async validateRelations(kind, data) {
    for (const id of data.catalogIds || []) if (!await this.get('catalogs', id)) fail('Uno de los catálogos no existe.');
    if (kind === 'combos') for (const line of data.items) {
      const product = await this.get('products', line.productId);
      if (!product) fail('Uno de los productos del combo no existe.');
      if (data.status === 'published' && product.status !== 'published') fail('Publica primero los productos que contiene el combo.');
    }
  }
  async save(kind, input, id = null, version = null) {
    const data = validateRecord(kind, input);
    if (id) integer(version, 'Versión', 1);
    try {
      return await this.transaction(async store => {
        await store.lockWrites();
        await store.validateRelations(kind, data);
        const stamp = now(), key = id || randomUUID();
        if (id) {
          const old = await store.get(kind, id);
          if (!old) fail('Registro no encontrado.', 404);
          const result = await store.db.run(`UPDATE ${store.t('records')} SET slug=?,title=?,status=?,sort_order=?,data=?,version=version+1,updated_at=? WHERE id=? AND kind=? AND version=?`, [data.slug, data.title, data.status, data.sort, JSON.stringify(data), stamp, key, kind, version]);
          if (!result.changes) fail('Otro usuario modificó este registro. Recarga antes de guardar.', 409);
        } else await store.db.run(`INSERT INTO ${store.t('records')}(id,kind,slug,title,status,sort_order,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, [key, kind, data.slug, data.title, data.status, data.sort, JSON.stringify(data), stamp, stamp]);
        return store.get(kind, key);
      });
    } catch (error) { if (error.code === '23505' || /UNIQUE constraint/.test(error.message)) fail('Ya existe un registro con esa dirección corta.', 409); throw error; }
  }
  async remove(kind, id, version) {
    integer(version, 'Versión', 1);
    return this.transaction(async store => {
      await store.lockWrites();
      const old = await store.get(kind, id);
      if (!old) fail('Registro no encontrado.', 404);
      if (old.version !== version) fail('El registro cambió. Recarga antes de eliminar.', 409);
      if (['products', 'combos'].includes(kind)) {
        for (const order of await store.orders()) {
          if (order.items.some(line => (line.kind === kind && line.itemId === id) || (kind === 'products' && line.components?.some(c => c.productId === id)))) fail('La referencia tiene pedidos. Archívala para conservar el historial.', 409);
        }
      }
      if (kind === 'products' && (await store.list('combos')).some(c => c.items.some(i => i.productId === id))) fail('El producto forma parte de un combo. Archívalo o retíralo del combo.', 409);
      if (kind === 'catalogs') for (const k of ['products', 'combos']) if ((await store.list(k)).some(r => r.catalogIds.includes(id))) fail('Retira el catálogo de sus referencias antes de eliminarlo.', 409);
      await store.db.run(`DELETE FROM ${store.t('records')} WHERE id=? AND kind=? AND version=?`, [id, kind, version]);
      return { ok: true };
    });
  }
  async orders() { return (await this.db.all(`SELECT * FROM ${this.t('orders')} ORDER BY number DESC`)).map(row => ({ ...decode(row), number: row.number })); }
  async pageOrders({ page = 1, q = '', status = '', paymentStatus = '' } = {}) {
    integer(page, 'Página', 1, 100000); q = text(q, 'Búsqueda', 100);
    const conditions = [], values = [];
    const extract = field => this.provider === 'sqlite' ? `json_extract(data,'$.${field}')` : `(data::jsonb->>'${field}')`;
    if (status) { conditions.push(`${extract('status')}=?`); values.push(status); }
    if (paymentStatus) { conditions.push(`${extract('paymentStatus')}=?`); values.push(paymentStatus); }
    if (q) {
      // Escapar comodines del LIKE: % y _ ingresados por el operador se buscan literalmente.
      const escaped = q.toLowerCase().replace(/[!%_]/g, ch => `!${ch}`);
      conditions.push(`(LOWER(${extract('customerName')}) LIKE ? ESCAPE '!' OR ${extract('phone')} LIKE ? ESCAPE '!' OR ${extract('tracking')} LIKE ? ESCAPE '!' OR CAST(number AS TEXT)=?)`);
      values.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, q.replace(/^AN-0*/i, ''));
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = Number((await this.db.get(`SELECT COUNT(*) AS count FROM ${this.t('orders')}${where}`, values)).count);
    const records = (await this.db.all(`SELECT * FROM ${this.t('orders')}${where} ORDER BY number DESC LIMIT 20 OFFSET ?`, [...values, (page - 1) * 20])).map(row => ({ ...decode(row), number: row.number }));
    return { records, total, page, pageSize: 20 };
  }
  async order(id) {
    const row = await this.db.get(`SELECT * FROM ${this.t('orders')} WHERE id=?`, [id]);
    if (!row) return null;
    const history = (await this.db.all(`SELECT a.*,u.email AS actor_email FROM ${this.t('order_audit')} a LEFT JOIN ${this.t('users')} u ON u.id=a.actor_id WHERE a.order_id=? ORDER BY a.created_at,a.id`, [id])).map(event => ({ ...JSON.parse(event.data), actorId: event.actor_id, actorEmail: event.actor_email || null, createdAt: event.created_at }));
    const legacy = await this.db.all(`SELECT previous_status AS "previousStatus",next_status AS "nextStatus",actor_id AS "actorId",created_at AS "createdAt" FROM ${this.t('order_events')} WHERE order_id=? ORDER BY created_at,id`, [id]);
    return { ...decode(row), number: row.number, history: [...legacy.map(h => ({ ...h, legacy: true })), ...history.sort((a,b)=>(a.orderVersion||0)-(b.orderVersion||0)||a.createdAt.localeCompare(b.createdAt))] };
  }
  async saveOrder(input, actor, id = null, version = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Datos del pedido no válidos.');
    if (id) integer(version, 'Versión', 1);
    const requestKey = id ? null : text(input.requestId, 'Identificador de guardado', 100, true);
    if (requestKey && !/^[\w-]{16,100}$/.test(requestKey)) fail('Identificador de guardado no válido.');
    const payloadHash = digest(JSON.stringify(input));
    return this.transaction(async store => {
      await store.lockWrites();
      if (requestKey) {
        const previous = await store.db.get(`SELECT * FROM ${store.t('idempotency')} WHERE key=?`, [requestKey]);
        if (previous) {
          if (previous.actor_id !== actor || previous.payload_hash !== payloadHash) fail('Este intento ya fue guardado con otros datos. Abre el pedido existente o inicia uno nuevo.', 409);
          return store.order(previous.order_id);
        }
      }
      const old = id ? await store.order(id) : null;
      if (id && !old) fail('Pedido no encontrado.', 404);
      if (old && old.version !== version) fail('El pedido cambió en otra sesión. Recarga antes de guardar.', 409);
      const data = await validateOrder(input, (kind, key) => store.get(kind, key), old);
      validateTransition(old?.status || null, data.status);
      const key = id || randomUUID(), stamp = now();
      if (old) {
        const result = await store.db.run(`UPDATE ${store.t('orders')} SET data=?,version=version+1,updated_at=? WHERE id=? AND version=?`, [JSON.stringify(data), stamp, key, version]);
        if (!result.changes) fail('El pedido cambió en otra sesión.', 409);
      } else {
        await store.db.run(`UPDATE ${store.t('counters')} SET value=value+1 WHERE id='orders'`);
        const number = (await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`)).value;
        await store.db.run(`INSERT INTO ${store.t('orders')}(id,number,data,created_at,updated_at) VALUES(?,?,?,?,?)`, [key, number, JSON.stringify(data), stamp, stamp]);
        await store.db.run(`INSERT INTO ${store.t('idempotency')}(key,actor_id,payload_hash,order_id) VALUES(?,?,?,?)`, [requestKey, actor, payloadHash, key]);
      }
      const changedFields = Object.keys(data).filter(field => JSON.stringify(old?.[field]) !== JSON.stringify(data[field]));
      const audit = { orderVersion: old ? old.version + 1 : 1, previousStatus: old?.status || null, nextStatus: data.status, previousPaymentStatus: old?.paymentStatus || null, nextPaymentStatus: data.paymentStatus, changedFields, reason: data.statusReason || '' };
      await store.db.run(`INSERT INTO ${store.t('order_audit')}(id,order_id,actor_id,data,created_at) VALUES(?,?,?,?,?)`, [randomUUID(), key, actor, JSON.stringify(audit), stamp]);
      return store.order(key);
    });
  }
  async publicData() {
    const fullSettings = await this.settings();
    const settings = Object.fromEntries(['brandName','tagline','logo','whatsapp','whatsappTemplate','facebook','instagram','email','hours','paymentInfo','launchApproved'].map(k => [k, fullSettings[k]]));
    const products = await this.list('products', { published: true });
    const catalogs = await this.list('catalogs', { published: true });
    const allowed = new Map(products.map(p => [p.id, p]));
    const combos = (await this.list('combos', { published: true })).filter(c => c.items.every(i => allowed.has(i.productId))).map(c => ({ ...c, availability: c.items.some(i => allowed.get(i.productId).availability === 'soldout') ? 'soldout' : 'consult' }));
    const output = { settings, products, catalogs, combos };
    for (const kind of ['faqs', 'messages', 'shipping']) output[kind] = await this.list(kind, { published: true });
    return output;
  }
  async exportData() {
    return this.transaction(async store => {
      await store.lockWrites();
      const result = { format: 'allnutrition-export-v2', exportedAt: now(), settings: await store.settings(), orders: [] };
      for (const kind of Object.keys(schemas)) result[kind] = await store.list(kind);
      for (const order of await store.orders()) result.orders.push(await store.order(order.id));
      // No exportar hashes de contraseña, sesiones o claves de conexión desde el panel.
      return result;
    });
  }
}
