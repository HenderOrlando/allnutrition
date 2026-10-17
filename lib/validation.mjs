import { randomUUID } from 'node:crypto';
import { schemas, settingsFields, defaults, orderStates } from './schema.mjs';
import { AppError, fail, text, integer } from './validation-core.mjs';
import { moneyMinor } from './business/money.mjs';
import { businessDate } from './business/dates.mjs';
export { AppError, fail, text, integer } from './validation-core.mjs';
function oneOf(value, options, label) { if (!options.includes(value)) fail(`${label}: opción no válida.`); return value; }
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label}: valor no válido.`); return value; }
function object(value, label = 'Datos') { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: objeto no válido.`); }

/** Solo guardar el enlace: nunca descargar/proxy/optimizar imágenes en el servidor. */
export function publicUrl(value, label = 'Enlace') {
  const s = text(value, label, 2048); if (!s) return '';
  let url; try { url = new URL(s); } catch { fail(`${label}: URL no válida.`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`${label}: usa HTTPS sin credenciales.`);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || host === 'localhost' || /\.(localhost|local|internal|lan)$/.test(host)) fail(`${label}: utiliza un dominio público, no una dirección interna.`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)) fail(`${label}: no se admiten redes privadas.`);
  }
  return url.toString();
}
export function imageUrl(value, { allowLocalMedia = false } = {}) {
  const s = text(value, 'Imagen', 2048);
  if (allowLocalMedia && /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
  // Únicas imágenes incorporadas al proyecto original: no son cargas nuevas al servidor.
  if (['/brand/logo.jpg', '/brand/creatina-vital-force.jpg'].includes(s)) return s;
  return publicUrl(s, 'Imagen');
}
export function idList(value, label) {
  if (!Array.isArray(value) || value.length > 100) fail(`${label}: lista no válida.`);
  return [...new Set(value.map(v => text(v, label, 100, true)))];
}
function fieldValue(field, value, { allowLocalMedia = false } = {}) {
  switch (field.type) {
    case 'checkbox': return bool(value ?? false, field.label);
    case 'moneyOptionalMinor': return value === '' || value == null ? null : moneyMinor(value, field.label);
    case 'optionalNumber': return value === '' || value == null ? null : integer(value, field.label, field.min || 0, Number.MAX_SAFE_INTEGER);
    case 'date': return businessDate(value || null, field.label, { nullable: true });
    case 'money': case 'number': return integer(value ?? 0, field.label, field.min || 0);
    case 'select': return oneOf(value, field.options.map(o => o.value), field.label);
    case 'multi': return idList(value ?? [], field.label);
    case 'image': return imageUrl(value ?? '', { allowLocalMedia });
    case 'url': return publicUrl(value ?? '', field.label);
    case 'email': { const email = text(value ?? '', field.label, 254); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Correo no válido.'); return email; }
    case 'comboItems': {
      if (!Array.isArray(value) || value.length > 30) fail('El combo debe tener una lista válida de productos.');
      const rows = value.map(row => { object(row); return { productId: text(row.productId, 'Producto', 100, true), quantity: integer(row.quantity, 'Cantidad', 1, 999) }; });
      if (new Set(rows.map(r => r.productId)).size !== rows.length) fail('Un producto está repetido en el combo. Ajusta su cantidad.');
      return rows;
    }
    default: return text(value ?? '', field.label, field.max || 2000, !!field.required);
  }
}
export function validateRecord(kind, input) {
  if (!Object.hasOwn(schemas, kind)) fail('Sección no válida.', 404); object(input);
  const values = kind === 'products' ? { productType:'product', items:[], ...input } : input;
  const out = {}; for (const field of schemas[kind].fields) out[field.name] = fieldValue(field, values[field.name], { allowLocalMedia: kind === 'products' && field.localUpload === true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.slug)) fail('La dirección corta solo admite letras minúsculas, números y guiones.');
  if (kind === 'products') {
    if (input.orderable == null) out.orderable = out.productType === 'gift' || out.status === 'published';
    if (out.productType === 'gift') {
      out.stockQuantity = null;
      if (!out.items.length) fail('El obsequio requiere componentes.');
      if (out.unitCostMinor !== null) fail('El costo del obsequio se calcula desde sus componentes.');
    } else {
      if (out.items.length) fail('Solo los obsequios admiten componentes.');
      if (out.status === 'published' && (!out.image || !out.presentation || out.price <= 0)) fail('Para publicar un producto completa imagen, presentación y un precio mayor que cero.');
    }
  }
  if (kind === 'combos' && out.status === 'published' && (!out.items.length || out.price <= 0)) fail('Para publicar un combo completa sus productos y un precio mayor que cero.');
  return out;
}
export function validateSettings(input) {
  object(input); const out = {};
  for (const field of settingsFields) out[field.name] = fieldValue(field, input[field.name] ?? defaults[field.name]);
  if (!/^\d{10,15}$/.test(out.whatsapp)) fail('WhatsApp: incluye el código de país y usa entre 10 y 15 números.');
  if (!out.whatsappTemplate) fail('Completa el mensaje de consulta.');
  for (const [field, allowed] of [['facebook', ['facebook.com', 'fb.com']], ['instagram', ['instagram.com']]]) {
    if (out[field]) { const host = new URL(out[field]).hostname; if (!allowed.some(domain => host === domain || host.endsWith(`.${domain}`))) fail(`${field}: utiliza el enlace oficial del perfil, no un enlace de otro servicio.`); }
  }
  return out;
}
export function validateTransition(previous, next) {
  if (previous === next) return;
  const allowed = previous == null ? ['new','preparing'] : ['new','preparing'].includes(previous) ? ['preparing','cancelled'] : [];
  if (!allowed.includes(next)) fail('Cambia la preparación aquí; registra despacho, entrega o devolución desde su acción correspondiente.', 409);
}
export async function validateOrder(input, resolveItem, old = null, options = {}) {
  object(input, 'Pedido'); const out = {};
  for (const [name, label, required, max] of [
    ['customerName','Nombre del destinatario',true,150],['phone','Celular',true,30],['city','Ciudad',true,100],
    ['department','Departamento',false,100],['address','Dirección exacta',false,500],['addressNotes','Barrio y referencias',false,500],
    ['email','Correo del destinatario',false,254],['documentType','Tipo de documento',false,30],['documentNumber','Número de documento',false,80],
    ['notes','Notas internas',false,3000],['statusReason','Motivo de cancelación',false,500]
  ]) out[name] = text(input[name] ?? '', label, max, required);
  if (!/^\+?[0-9 ()-]{7,30}$/.test(out.phone)) fail('Teléfono no válido.');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail('Correo del destinatario no válido.');
  if (!!out.documentType !== !!out.documentNumber) fail('Completa tipo y número de documento o deja ambos vacíos.');
  out.placedOn = businessDate(input.placedOn === '' ? null : (input.placedOn ?? old?.placedOn ?? null), 'Fecha del pedido', { nullable: !!old && (old.dateSource==='legacy_record' || old.placedOn==null) });
  out.sellerId = input.sellerId ? text(input.sellerId, 'Vendedor', 100, true) : null;
  out.sellerSnapshot = old?.sellerId === out.sellerId ? old?.sellerSnapshot ?? null : null;
  if (out.sellerId && options.resolveSeller) {
    const seller = await options.resolveSeller(out.sellerId);
    if (!seller || (!seller.active && old?.sellerId !== out.sellerId)) fail('Selecciona un vendedor existente y activo.');
    if (!old || old.sellerId !== out.sellerId) out.sellerSnapshot = { id:seller.id, name:seller.name, version:seller.version };
  }
  out.status = oneOf(input.status ?? old?.status ?? 'new', orderStates.map(s => s.value), 'Estado del pedido');
  validateTransition(old?.status ?? null,out.status);
  const frozen = old && (old.economicLocked || options.dispatched || ['sent','delivered','returned','cancelled'].includes(old.status));
  if (frozen && out.status!==old.status) fail('Un pedido despachado o cerrado no cambia de estado desde el formulario.',409);
  out.deliveryMethod = oneOf(input.deliveryMethod || 'carrier', ['carrier','local','pickup'], 'Modalidad de entrega');
  out.shippingChargeMinor = moneyMinor(input.shippingChargeMinor ?? 0, 'Flete cobrado');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail('El pedido necesita entre 1 y 50 líneas.');
  out.items = [];
  for (const line of input.items) {
    object(line, 'Línea');
    const kind = oneOf(line.kind, ['products','combos'], 'Tipo de referencia');
    const itemId = text(line.itemId, 'Referencia', 100, true);
    const lineId = text(line.lineId || randomUUID(), 'Identificador de línea', 100, true);
    const previous = old?.items.find(p => p.lineId === lineId);
    const same = previous?.kind === kind && previous?.itemId === itemId;
    let snapshot;
    if (same) {
      snapshot = { productType:previous.productType || (kind === 'combos' ? 'combo' : 'product'), title:previous.title, presentation:previous.presentation || '', unitCostMinor:previous.unitCostMinor ?? null, components:structuredClone(previous.components || []) };
    } else if (options.snapshotItem) {
      snapshot = await options.snapshotItem(kind, itemId, out.placedOn);
    } else {
      const item = await resolveItem(kind, itemId);
      if (!item) fail('Una referencia del pedido ya no existe.');
      if (kind === 'products' ? !(item.orderable ?? item.status === 'published') : item.status !== 'published') fail('La referencia no está disponible para pedidos.');
      const components = [];
      for (const component of item.items || []) {
        const product = await resolveItem('products', component.productId);
        if (!product || product.productType === 'gift' || !(product.orderable ?? product.status === 'published')) fail('La composición contiene una referencia no disponible.');
        components.push({ productId:component.productId, title:product.title, presentation:product.presentation || '', quantity:integer(component.quantity,'Cantidad del componente',1,999), unitCostMinor:null });
      }
      snapshot = { productType:kind === 'combos' ? 'combo' : item.productType || 'product', title:item.title, presentation:item.presentation || '', unitCostMinor:null, components };
    }
    const quantity = integer(line.quantity, 'Cantidad', 1, 999);
    if (same && quantity>previous.quantity) {
      if (options.snapshotItem) await options.snapshotItem(kind,itemId,out.placedOn);
      else {
        const current=await resolveItem(kind,itemId);
        if (!current || !(current.orderable ?? current.status==='published')) fail('Habilita la referencia para pedidos antes de aumentar la cantidad.');
      }
    }
    const unitPriceMinor = moneyMinor(line.unitPriceMinor, 'Precio unitario');
    if (!unitPriceMinor && snapshot.productType !== 'gift') fail('Solo los obsequios admiten precio cero.');
    const grossMinor = moneyMinor(quantity * unitPriceMinor, 'Importe de la línea');
    const discountMinor = moneyMinor(line.discountMinor ?? 0, 'Descuento');
    if (discountMinor > grossMinor) fail('El descuento no puede superar el importe de la línea.');
    out.items.push({ lineId, kind, itemId, ...snapshot, quantity, unitPriceMinor, discountMinor });
  }
  if (new Set(out.items.map(line => line.lineId)).size !== out.items.length) fail('Identificadores de línea repetidos.');
  out.subtotalMinor = moneyMinor(out.items.reduce((sum,line) => sum + line.quantity * line.unitPriceMinor - line.discountMinor, 0), 'Subtotal');
  out.totalMinor = moneyMinor(out.subtotalMinor + out.shippingChargeMinor, 'Total');
  if (out.totalMinor===0 && out.items.some(line=>line.productType!=='gift')) fail('Un pedido sin cobro solo puede contener obsequios.');
  if (frozen) {
    const shape = rows => rows.map(({lineId,kind,itemId,quantity,unitPriceMinor,discountMinor}) => ({lineId,kind,itemId,quantity,unitPriceMinor,discountMinor}));
    if (JSON.stringify(shape(out.items)) !== JSON.stringify(shape(old.items)) || out.shippingChargeMinor !== old.shippingChargeMinor || out.placedOn !== old.placedOn || out.sellerId !== (old.sellerId ?? null) || out.deliveryMethod !== old.deliveryMethod) fail('Después de despachar o cerrar el pedido no se cambia el acuerdo. Registra una devolución o ajuste explícito.', 409);
  }
  if (out.status === 'cancelled' && old?.status !== 'cancelled') {
    if (!out.statusReason) fail('Indica el motivo de la cancelación.');
    out.cancellationOn = businessDate(input.cancellationOn, 'Fecha de cancelación');
  } else if (old?.cancellationOn) out.cancellationOn = old.cancellationOn;
  return out;
}
