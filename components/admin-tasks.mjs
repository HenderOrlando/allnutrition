import { adminSections } from '@/lib/admin-view.mjs';

// UI destinations only. Existing view parsing and guarded navigation remain authoritative.
export const adminTaskGroups = [
  { id: 'orders', label: 'Pedidos y envíos', icon: 'receipt', description: 'Del pedido al seguimiento de la entrega.', tasks: [
    { id: 'orders', label: 'Gestionar pedidos', description: 'Crear, buscar y atender pedidos y cobros.', view: { section: 'orders', tab: 'list' } },
    { id: 'shipments', label: 'Seguimiento de envíos', description: 'Guías, novedades y entregas.', view: { section: 'orders', tab: 'shipments' } },
    { id: 'imports', label: 'Importar Excel', description: 'Cargar archivos y revisar cada lote antes de aplicarlo.', view: { section: 'orders', tab: 'imports' } },
  ] },
  { id: 'products', label: 'Productos y colecciones', icon: 'box', description: 'Organiza lo que vendes y lo que publicas.', tasks: [
    { id: 'products', label: 'Gestionar productos', description: 'Fichas, precios, costos y disponibilidad.', view: { section: 'products' } },
    { id: 'gifts', label: 'Obsequios', description: 'Referencias de regalo y sus componentes.', view: { section: 'products', productType: 'gift' } },
    { id: 'combos', label: 'Combos', description: 'Productos incluidos y condiciones de la oferta.', view: { section: 'combos' } },
    { id: 'catalogs', label: 'Catálogos', description: 'Colecciones para organizar la vitrina.', view: { section: 'catalogs' } },
  ] },
  { id: 'cash', label: 'Caja y pagos', icon: 'wallet', description: 'Distingue saldos, obligaciones y dinero recibido.', tasks: [
    { id: 'cash', label: 'Cuentas y saldos', description: 'Cuentas, ingresos, transferencias y cierres.', view: { section: 'cash', tab: 'overview' } },
    { id: 'movements', label: 'Movimientos de caja', description: 'Entradas, salidas y sus documentos.', view: { section: 'cash', tab: 'movements' } },
    { id: 'settlements', label: 'Liquidaciones', description: 'Recaudos de plataformas y abonos recibidos.', view: { section: 'cash', tab: 'settlements' } },
    { id: 'expenses', label: 'Gastos', description: 'Registrar gastos, pagar saldos y recuperar sobrepagos.', view: { section: 'cash', tab: 'expenses' } },
    { id: 'payroll', label: 'Sueldos y anticipos', description: 'Preparar períodos y registrar pagos internos.', view: { section: 'cash', tab: 'payroll' } },
  ] },
  { id: 'reports', label: 'Informes', icon: 'chart', description: 'Consulta cifras y la cobertura de sus datos.', tasks: [
    { id: 'reports', label: 'Resumen de informes', description: 'Cifras generales, revisiones guardadas y exportación.', view: { section: 'reports', tab: 'overview' } },
    { id: 'sales-report', label: 'Informe de ventas', description: 'Productos, vendedores y ventas reconocidas.', view: { section: 'reports', tab: 'sales' } },
    { id: 'shipping-report', label: 'Informe de envíos', description: 'Guías, fechas y entregas a tiempo.', view: { section: 'reports', tab: 'shipping' } },
    { id: 'returns-report', label: 'Informe de devoluciones', description: 'Devoluciones y cancelaciones comerciales.', view: { section: 'reports', tab: 'returns' } },
    { id: 'costs-report', label: 'Informe de costos', description: 'Gastos registrados, pagos y saldos pendientes.', view: { section: 'reports', tab: 'costs' } },
    { id: 'payroll-report', label: 'Informe de sueldos', description: 'Devengos, pagos y saldos por persona.', view: { section: 'reports', tab: 'payroll' } },
    { id: 'cash-report', label: 'Informe de caja', description: 'Saldos y movimientos al corte del informe.', view: { section: 'reports', tab: 'cash' } },
  ] },
  { id: 'business', label: 'Negocio y acceso', icon: 'settings', description: 'Personas, plataformas y reglas de operación.', tasks: [
    { id: 'setup', label: 'Primeros pasos', action: 'Revisar primeros pasos', description: 'Revisar responsables, apertura de cuentas y reglas iniciales.', view: { section: 'business', tab: 'setup' } },
    { id: 'people', label: 'Personas responsables', action: 'Gestionar personas y sueldos', description: 'Responsables, vendedores, sueldos y comisiones. No crea accesos al panel.', view: { section: 'business', tab: 'people' } },
    { id: 'accounts', label: 'Cuentas del negocio', action: 'Configurar cuentas del negocio', description: 'Caja, bancos, saldos de apertura y cuentas predeterminadas.', view: { section: 'business', tab: 'accounts' } },
    { id: 'platforms', label: 'Plataformas y cuentas', action: 'Configurar plataformas de venta', description: 'Orígenes del Excel, cuentas de plataforma y perfiles de columnas. No son cuentas de caja.', view: { section: 'business', tab: 'platforms' } },
    { id: 'rules', label: 'Reglas del negocio', action: 'Revisar reglas y preferencias', description: 'Reconocimiento de ventas, comisiones e informes; conserva la historia.', view: { section: 'business', tab: 'rules' } },
    { id: 'alerts', label: 'Alertas y avisos', action: 'Revisar alertas y configurar avisos', description: 'Atender pendientes y ajustar umbrales y responsables dentro del panel.', view: { section: 'business', tab: 'alerts' } },
    { id: 'users', label: 'Usuarios del panel', action: 'Gestionar usuarios del panel', icon: 'users', description: 'Consultar administradores y crear accesos. Es distinto de registrar una persona responsable.', view: { section: 'users' } },
  ] },
  { id: 'storefront', label: 'Contenido de la vitrina', icon: 'edit', description: 'Información pública, distinta de la operación.', tasks: [
    { id: 'settings', label: 'Datos y publicación', action: 'Editar datos y publicación de la vitrina', description: 'Marca, logo, contacto, WhatsApp, redes, métodos de pago y publicación global.', view: { section: 'settings' } },
    { id: 'faqs', label: 'Preguntas frecuentes', action: 'Gestionar preguntas frecuentes', description: 'Crear o editar preguntas y respuestas confirmadas para tus clientes.', view: { section: 'faqs' } },
    { id: 'messages', label: 'Mensajes comerciales', action: 'Editar mensajes de la vitrina', description: 'Textos y botones de la web. No envía campañas ni respuestas automáticas.', view: { section: 'messages' } },
    { id: 'shipping', label: 'Condiciones de envío', action: 'Editar condiciones de envío', description: 'Cobertura, costos y plazos públicos. No crea ni sigue guías.', view: { section: 'shipping' } },
  ] },
];

export const adminTasks = [
  { id: 'home', label: 'Inicio', description: 'Resumen del negocio y tareas pendientes.', icon: 'home', group: 'Tu negocio', view: { section: 'home' } },
  ...adminTaskGroups.flatMap(group => group.tasks.map(task => ({ ...task, icon: task.icon || group.icon, group: group.label }))),
];

const defaultTabs = { orders: 'list', cash: 'overview', reports: 'overview', business: 'setup' };
export function isCurrentAdminTask(task, view) {
  return task.view.section === view.section
    && (!task.view.tab || task.view.tab === (view.tab || defaultTabs[view.section]))
    && (task.view.productType || '') === (view.productType || '');
}

export function adminLocationLabel(view) {
  return adminTasks.find(task => isCurrentAdminTask(task, view))?.label
    || adminSections.find(section => section.id === view.section)?.label
    || 'Inicio';
}
