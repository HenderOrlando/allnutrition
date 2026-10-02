import { randomUUID } from 'node:crypto';
import { schemas, settingsFields, defaults, orderStates, paymentStates, paymentMethods, orderTransitions } from './schema.mjs';
export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const fail = (message, status = 400) => { throw new AppError(message, status); };
export function text(value, label, max = 1000, required = false) {
  if (typeof value !== 'string') { if (value == null && !required) return ''; fail(`${label}: se esperaba texto.`); }
  const out = value.trim();
  if (required && !out) fail(`${label}: este campo es obligatorio.`);
  if (out.length > max) fail(`${label}: máximo ${max} caracteres.`);
  return out;
}
export function integer(value, label, min = 0, max = 1000000000) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label}: usa un número entero entre ${min} y ${max}.`);
  return value;
}
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
  const out = {}; for (const field of schemas[kind].fields) out[field.name] = fieldValue(field, input[field.name], { allowLocalMedia: kind === 'products' && field.localUpload === true });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.slug)) fail('La dirección corta solo admite letras minúsculas, números y guiones.');
  if (kind === 'products' && out.status === 'published' && (!out.image || !out.presentation || out.price <= 0)) fail('Para publicar un producto completa imagen, presentación y un precio mayor que cero.');
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
function date(value, label) {
  const s = text(value ?? '', label, 10); if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) fail(`${label}: fecha no válida.`);
  return s;
}
export function validateTransition(previous, next) {
  if (previous === next) return;
  const allowed = previous ? orderTransitions[previous] : ['new', 'preparing'];
  if (!allowed?.includes(next)) fail('El cambio de estado no sigue el flujo configurado. Revisa los pasos de preparación, envío y entrega.', 409);
}
export async function validateOrder(input, resolveItem, old = null) {
  object(input, 'Pedido'); const out = {};
  for (const [name, label, required, max] of [
    ['customerName','Nombre del destinatario',true,150],['phone','Celular',true,30],['city','Ciudad',true,100],
    ['department','Departamento',false,100],['address','Dirección exacta',false,500],['addressNotes','Barrio y referencias',false,500],
    ['email','Correo del destinatario',false,254],['documentType','Tipo de documento',false,30],['documentNumber','Número de documento',false,80],
    ['notes','Notas internas',false,3000],['carrier','Transportadora',false,150],['tracking','Número de guía',false,150],
    ['paymentReference','Referencia de pago',false,200],['statusReason','Motivo de cancelación/devolución',false,500]
  ]) out[name] = text(input[name] ?? '', label, max, required);
  if (!/^\+?[0-9 ()-]{7,30}$/.test(out.phone)) fail('Teléfono no válido.');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail('Correo del destinatario no válido.');
  if (!!out.documentType !== !!out.documentNumber) fail('Completa tipo y número de documento o deja ambos vacíos.');
  out.status = oneOf(input.status, orderStates.map(s => s.value), 'Estado del pedido');
  out.paymentStatus = oneOf(input.paymentStatus, paymentStates.map(s => s.value), 'Estado del pago');
  out.paymentMethod = oneOf(input.paymentMethod, paymentMethods, 'Método de pago');
  out.deliveryMethod = oneOf(input.deliveryMethod || 'carrier', ['carrier', 'local', 'pickup'], 'Modalidad de entrega');
  out.shippingCost = integer(input.shippingCost ?? 0, 'Costo de envío');
  out.estimatedDelivery = date(input.estimatedDelivery, 'Fecha estimada de entrega');
  out.paymentDate = date(input.paymentDate, 'Fecha del pago');
  out.paymentReceiptUrl = publicUrl(input.paymentReceiptUrl || '', 'Enlace del comprobante');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail('El pedido necesita entre 1 y 50 líneas.');
  out.items = [];
  for (const line of input.items) {
    object(line, 'Línea');
    const kind = oneOf(line.kind, ['products', 'combos'], 'Tipo de referencia');
    const itemId = text(line.itemId, 'Referencia', 100, true);
    const lineId = text(line.lineId || randomUUID(), 'Identificador de línea', 100, true);
    const previous = old?.items.find(p => p.lineId === lineId) || old?.items.find(p => !p.lineId && p.kind === kind && p.itemId === itemId);
    const same = previous?.kind === kind && previous?.itemId === itemId;
    const item = await resolveItem(kind, itemId);
    if (!item && !same) fail('Una referencia del pedido ya no existe.');
    if (!same && item.status !== 'published') fail('Solo puedes agregar referencias publicadas a un pedido.');
    if (!same && kind === 'products' && item.availability === 'soldout') fail('La referencia está agotada. Confirma disponibilidad y actualiza el producto antes de agregarla.');
    let components = same ? (previous.components || []) : [];
    if (!same && kind === 'combos') {
      for (const component of item.items) {
        const product = await resolveItem('products', component.productId);
        if (!product || product.status !== 'published' || product.availability === 'soldout') fail('El combo contiene una referencia no disponible para nuevos pedidos.');
        components.push({ productId: product.id, title: product.title, presentation: product.presentation, quantity: component.quantity });
      }
    }
    out.items.push({ lineId, kind, itemId, title: same ? previous.title : item.title, presentation: same ? previous.presentation : (item.presentation || ''), components, quantity: integer(line.quantity, 'Cantidad', 1, 999), unitPrice: integer(line.unitPrice, 'Precio unitario', 1) });
  }
  if (new Set(out.items.map(line => line.lineId)).size !== out.items.length) fail('Identificadores de línea repetidos.');
  out.subtotal = integer(out.items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), 'Subtotal', 1, 100000000000);
  out.total = integer(out.subtotal + out.shippingCost, 'Total', 1, 100000000000);
  out.paymentAmount = integer(input.paymentAmount ?? (old?.paymentStatus === 'paid' ? out.total : 0), 'Valor registrado del pago', 0, out.total);
  if (out.paymentStatus === 'paid' && (out.paymentAmount !== out.total || !out.paymentDate)) fail('Para marcar Pagado, registra el valor total y la fecha del pago.');
  if (out.paymentStatus === 'partial' && (out.paymentAmount <= 0 || out.paymentAmount >= out.total || !out.paymentDate)) fail('Un abono requiere fecha y un valor mayor a cero y menor al total.');
  if (out.paymentStatus === 'pending' && out.paymentAmount !== 0) fail('Si registraste un abono, usa Abono parcial; si recibiste el total, usa Pagado.');
  if (out.paymentStatus === 'refunded' && !out.paymentReference) fail('Registra una referencia o nota del reembolso.');
  if (['cancelled', 'returned'].includes(out.status) && !out.statusReason) fail('Indica el motivo de la cancelación o devolución.');
  if (['sent', 'delivered'].includes(out.status)) {
    if (out.deliveryMethod !== 'pickup' && (!out.address || !out.department)) fail('Antes de despachar completa dirección y departamento.');
    if (out.deliveryMethod === 'carrier' && (!out.carrier || !out.tracking)) fail('Para el despacho por transportadora registra transportadora y guía.');
  }
  if (old && ['sent','delivered','returned','cancelled'].includes(old.status)) {
    const shape = rows => rows.map(({kind,itemId,quantity,unitPrice}) => ({kind,itemId,quantity,unitPrice}));
    if (JSON.stringify(shape(out.items)) !== JSON.stringify(shape(old.items)) || out.shippingCost !== old.shippingCost) fail('Después de despachar o cerrar el pedido no se cambian sus líneas ni totales. Registra un nuevo pedido para una nueva compra.', 409);
  }
  return out;
}
