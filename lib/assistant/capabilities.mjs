import { adminAreas, readAdminView } from '../admin-view.mjs';
import { adminCapabilities } from './capability-admin.mjs';
import { advertisingCapabilities } from './capability-advertising.mjs';
import { cashCapabilities } from './capability-cash.mjs';
import { orderCapabilities } from './capability-orders.mjs';

const PAGE_SIZE = 5;
const MODES = new Set(['read', 'prepare', 'confirm', 'human']);
const AREAS = new Set(adminAreas.map(area => area.id));
const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();

function capability(id, area, label, aliases, mode, target, view, focus, prerequisite, proof) {
  const canonical = readAdminView(view);
  if (!/^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/.test(id) || !AREAS.has(area) || !MODES.has(mode)
      || Object.entries(view).some(([key, value]) => canonical[key] !== value) || !focus || !prerequisite || !proof) {
    throw new Error(`Capacidad de Ali mal definida: ${id}`);
  }
  return Object.freeze({ id, area, label, aliases: Object.freeze(aliases), mode, target,
    destination: Object.freeze({ view: Object.freeze(view), focus }), prerequisite, proof });
}

const entries = [
  capability('advisor.reminder', 'home', 'Programar un recordatorio', ['recordarme', 'avísame', 'recordar mañana'], 'confirm', 'advisor-reminder',
    { section: 'home' }, 'advisor-reminder-form', 'Asunto o fuente válida, fecha futura y confirmación personal.', 'Recordatorio guardado solo en la cuenta del operador, con fecha y hora precisas.'),
  capability('orders.ship-order', 'orders', 'Preparar y vincular un envío a un pedido', ['enviar pedido', 'asignar guía', 'despacho'], 'confirm', 'shipment-create',
    { section: 'orders', tab: 'shipments' }, 'shipment-link-order', 'Pedido inequívoco, cantidades elegibles, guía y revisión de la asignación.', 'Guía persistida y vinculada al pedido elegido; un evento se acredita aparte.'),
  capability('cash.close-day', 'cash', 'Contar y cerrar la caja del día', ['cierre de efectivo', 'cuadre', 'arqueo'], 'confirm', 'business-action:cash-close',
    { section: 'cash', tab: 'overview' }, 'cash-close', 'Cuenta de efectivo, fecha, responsable válido y conteo físico.', 'Cierre vigente de la cuenta y fecha con el conteo y la diferencia acreditados, sin asiento de ajuste.'),
  capability('imports.resolve-issues', 'orders', 'Resolver una incidencia de Excel', ['resolver fila', 'corregir importación', 'duplicados'], 'human', 'import-resolver',
    { section: 'orders', tab: 'imports' }, 'import-row-resolution', 'Lote y revisión actuales y hoja/fila inequívocas.', 'Resolutor de la fila exacta; el operador elige, guarda y revisa la nueva vista previa antes de aceptar.'),
  ...cashCapabilities.map(definition => capability(...definition)),
  ...advertisingCapabilities.map(definition => capability(...definition)),
  ...orderCapabilities.map(definition => capability(...definition)),
  ...adminCapabilities.map(definition => capability(...definition)),
];

const byId = new Map(entries.map(entry => [entry.id, entry]));
if (byId.size !== entries.length) throw new Error('Identificador duplicado en el directorio de Ali.');
const indexed = entries.map(entry => {
  const label = normalize(entry.label);
  const aliases = entry.aliases.map(normalize);
  return { entry, label, aliases, searchable: `${label} ${aliases.join(' ')} ${entry.area} ${entry.id.replace(/[.-]/g, ' ')}` };
});

export function getAssistantCapability(id) {
  return byId.get(id) ?? null;
}

export function searchAssistantCapabilities(query = '', { area = null, page = 1 } = {}) {
  const normalized = typeof query === 'string' ? normalize(query.slice(0, 200)).replace(/\s+/g, ' ') : '';
  const tokens = normalized ? normalized.split(' ') : [];
  const safePage = Number.isSafeInteger(page) && page > 0 && page <= 100000 ? page : 1;
  const ranked = [];
  for (const { entry, label, aliases, searchable } of indexed) {
    if (area && area !== entry.area || !tokens.every(token => searchable.includes(token))) continue;
    const rank = !normalized ? 0 : label === normalized ? 4 : aliases.includes(normalized) ? 3 : label.startsWith(normalized) ? 2 : label.includes(normalized) ? 1 : 0;
    ranked.push({ entry, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.entry.label.localeCompare(b.entry.label, 'es') || a.entry.id.localeCompare(b.entry.id));
  const offset = (safePage - 1) * PAGE_SIZE;
  return { items: ranked.slice(offset, offset + PAGE_SIZE).map(item => item.entry), page: safePage, total: ranked.length };
}
