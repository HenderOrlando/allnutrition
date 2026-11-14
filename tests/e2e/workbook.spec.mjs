import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { unzipSync } from 'fflate';
import { login, navigate, openConfigurationTask, openDisclosure, selectWorkspace } from './helpers.mjs';
import { readExcel, writeExcelSheets } from '../../lib/business/excel.mjs';
import { IMPORT_TABLES } from '../../lib/business/import-templates.mjs';
import { formatMoneyMinor } from '../../lib/business/money.mjs';
import { emptyRecord } from '../../lib/schema.mjs';

test.use({ actionTimeout: 30000 });

const require = createRequire(import.meta.url);
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const timeout = 120000;
const records = value => Array.isArray(value) ? value : value.records;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const wizard = page => page.getByRole('region', { name: 'Importar Excel', exact: true });

async function get(page, path) {
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(200);
  return response.json();
}
async function batch(page) {
  const id = new URL(page.url()).searchParams.get('batch');
  expect(id, 'El borrador debe tener una URL retomable').toBeTruthy();
  return get(page, `/api/admin/imports/${encodeURIComponent(id)}`);
}
async function downloaded(page, name) {
  const event = page.waitForEvent('download');
  await button(wizard(page), name).click();
  const download = await event;
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(await download.failure()).toBeNull();
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function moneyAndPeople(page) {
  const [overview, movements, people, payroll, settings] = await Promise.all([
    get(page, '/api/admin/finance/overview'), get(page, '/api/admin/finance/movements'),
    get(page, '/api/admin/business/people'), get(page, '/api/admin/finance/payroll'),
    get(page, '/api/admin/business/settings'),
  ]);
  return {
    accounts: overview.accounts.map(row => ({ id: row.id, balanceMinor: row.balanceMinor })).sort((a, b) => a.id.localeCompare(b.id)),
    availableMinor: overview.availableMinor, movements: movements.total,
    people: records(people), payroll: payroll.total,
    receipt: settings.defaultReceiptAccountId, payment: settings.defaultPaymentAccountId,
  };
}
function syntheticWorkbook(f, { corrected = false, reordered = false } = {}) {
  const tables = [
    { name: 'REVISION', rows: [] },
    { name: 'VENTAS', rows: [IMPORT_TABLES.sales.columns.map(column => column.header),
      [f.orderKey, 'LINE-A', `${f.year}-09-28`, f.customer, corrected ? f.phone : '', 'Bogotá', 'Cundinamarca', 'Dirección exclusivamente sintética 123', f.productKey, 1, 55000, 20000, 0, 0, f.campaign, 'Primera línea sintética'],
      [f.orderKey, 'LINE-B', `${f.year}-09-28`, f.customer, corrected ? f.phone : '', 'Bogotá', 'Cundinamarca', 'Dirección exclusivamente sintética 123', f.productKey, 1, 55000, 20000, 0, 0, f.campaign, 'Primera línea sintética'],
    ] },
    { name: 'ENVIOS', rows: [IMPORT_TABLES.shipments.columns.map(column => column.header),
      [f.shipmentKey, f.orderKey, 'Transportadora sintética', f.tracking, 'ENTREGADO', `${f.year}-09-30`, f.cutoff, 12000, `${f.year}-09-29`, '', '', 1000, `${f.year}-09-29`, '', ''],
    ] },
    { name: 'PUBLICIDAD POR CAMPAÑAS', rows: [
      ['FECHA', f.campaign, 'VALOR', 'CAMPAÑA SECUNDARIA', 'VALOR', 'CAMPAÑA TRES', 'VALOR', 'CAMPAÑA CUATRO', 'VALOR', 'TOTAL CHATS', 'TOTAL VALOR'],
      [`${f.year}-09-28`, 5, 2000, 2, 1000, '', '', '', '', 7, 12000],
      [`${f.year}-09-29`, 5, 2000, 3, 1000, '', '', '', '', 8, 13000],
    ] },
    { name: 'GASTOS OPERACION', rows: [IMPORT_TABLES.operating.columns.map(column => column.header),
      [f.expenseKey, `${f.year}-09-29`, f.expenseConcept, 10000, 'Proveedor exclusivamente sintético', 'REF-OPERACION', 'No registra un pago'],
    ] },
    { name: 'INSTRUCCIONES', rows: [['INSTRUCCIONES'], ['Notas sintéticas: no son transacciones.']] },
  ];
  return writeExcelSheets(reordered ? tables.reverse().map(table => ({ ...table, rows: table.rows.length ? [table.rows[0], ...table.rows.slice(1).reverse()] : [] })) : tables);
}
async function preparePolicy(page, f) {
  await navigate(page, 'Configuración');
  await openConfigurationTask(page, 'rules');
  await button(page, 'Agregar nueva vigencia').click();
  const dialog = page.getByRole('dialog', { name: 'Agregar vigencia de reglas', exact: true });
  await dialog.getByLabel('Vigente desde (Bogotá)', { exact: true }).fill(`${f.year}-09-01`);
  await dialog.getByRole('combobox', { name: 'Reconocer la venta', exact: true }).selectOption('delivered');
  await dialog.getByLabel('Generar comisión para ventas con vendedor').uncheck();
  await openDisclosure(dialog, 'Fechas de gastos logísticos');
  for (const label of ['Flete de ida', 'Flete de retorno', 'Cargo de plataforma']) await dialog.getByRole('combobox', { name: label, exact: true }).selectOption('charge_date');
  await dialog.getByLabel('Motivo del cambio').fill(`Regla explícita del libro sintético ${f.marker}`);
  await dialog.getByLabel('Revisé la fecha de vigencia y entiendo que no cambia los pedidos anteriores.').check();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/business/settings' && response.request().method() === 'PUT');
  await button(dialog, 'Agregar vigencia').click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const settings = await get(page, '/api/admin/business/settings');
  f.ruleId = settings.rulesVersions.find(rule => rule.effectiveOn === `${f.year}-09-01`).id;
}
async function upload(page, bytes, filename) {
  await wizard(page).getByLabel('Archivo Excel', { exact: true }).setInputFiles({ name: filename, mimeType, buffer: bytes });
  await button(wizard(page), 'Guardar archivo y continuar').click();
  await expect(wizard(page).locator('[data-import-sheet]').first()).toBeVisible({ timeout });
}
async function confirmDecision(page, title, confirmLabel, affected) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('region', { name: 'Elementos afectados', exact: true }).getByRole('listitem');
  await expect(list).toHaveCount(affected.length);
  expect(await list.locator('strong').allTextContents()).toEqual(affected.map(item => item.label));
  expect(await list.locator('p').allTextContents()).toEqual(affected.map(item => item.detail));
  await button(dialog, confirmLabel).click();
  await expect(dialog).toHaveCount(0);
}
async function configureReading(page) {
  const w = wizard(page);
  await openDisclosure(w, /^Cómo leer fechas y números/);
  await w.getByLabel('Orden explícito de las fechas', { exact: true }).selectOption('ISO');
  await w.getByLabel('Separador decimal', { exact: true }).selectOption('.');
  await w.getByLabel('Separador de miles', { exact: true }).selectOption('');
}
async function readSamples(page) {
  const w = wizard(page), samples = button(w, 'Leer muestras de esta hoja y encabezado');
  await expect(samples).toBeVisible({ timeout });
  const sheetName = await w.getByRole('combobox', { name: 'Hoja actual', exact: true }).inputValue();
  if (await samples.isEnabled()) await samples.click();
  await expect.poll(async () => (await batch(page)).workbook?.inspections?.some(sheet => sheet.sheetName === sheetName && sheet.headerRow === 1), { timeout }).toBe(true);
  await expect(samples).toBeDisabled({ timeout });
}
async function configureSheets(page, f) {
  const w = wizard(page), uploaded = await batch(page);
  const proposals = uploaded.workbook.suggestions.sheets.filter(sheet => !sheet.possibleDuplicateOf && sheet.config.columns.some(column => column.destination && column.destination !== 'ignore'));
  await button(w, 'Aplicar propuesta del libro').click();
  await confirmDecision(page, 'Revisar propuesta del libro', 'Usar estas propuestas', [
    ...proposals.map(sheet => ({ label: sheet.sheetName, detail: 'Incluir y usar propuesta' })),
    ...uploaded.workbook.sheets.filter(sheet => !proposals.some(proposal => proposal.sheetName === sheet.name)).map(sheet => ({ label: sheet.name, detail: 'No importar' })),
  ]);
  await readSamples(page);
  for (const sheet of uploaded.workbook.sheets) {
    const card = w.locator(`[data-import-sheet=${JSON.stringify(sheet.name)}]`);
    await expect(card).toHaveCount(1);
    if (sheet.empty === true || ['INSTRUCCIONES', 'POR COMPLETAR'].includes(sheet.name)) continue;
    await button(card, `Usar propuesta de ${sheet.name}`).click();
    await w.getByRole('combobox', { name: 'Hoja actual', exact: true }).selectOption(sheet.name);
    await readSamples(page);
    await configureReading(page);
    if (sheet.name === 'ENVIOS') {
      await openDisclosure(w, 'Equivalencias del estado de entrega / seguimiento');
      const external = 'ENTREGADO';
      const mapping = w.locator('.order-line').filter({ hasText: `Identificador exacto del archivo: ${external}` });
      if (!await mapping.count()) {
        await w.getByLabel('Identificador exacto del archivo').fill(external);
        await button(w, 'Añadir para revisar (sin identificar)').click();
      }
      await mapping.getByRole('combobox', { name: 'Estado en All Nutrition', exact: true }).selectOption('delivered');
    }
    if (sheet.name === 'PUBLICIDAD POR CAMPAÑAS') {
      await w.getByRole('checkbox', { name: /Generar identidad técnica para cada gasto sin ID/ }).check();
      for (const [index, name] of [f.campaign, 'CAMPAÑA SECUNDARIA', 'CAMPAÑA TRES', 'CAMPAÑA CUATRO'].entries()) await expect(w.getByLabel(`Grupo de campaña ${index + 1}`, { exact: true })).toHaveValue(name);
      await expect(w.getByRole('combobox', { name: 'Distribución de los gastos', exact: true })).toHaveValue('expense_columns');
      // TOTAL CHATS is a control count, not another expense or an implicit exclusion.
      const totalChats = button(w, 'Destino de columna 10');
      await totalChats.click();
      const mapping = page.getByRole('dialog', { name: /^Asignar columna / });
      await button(mapping, 'Ignorar esta columna').click();
      await expect(mapping).toHaveCount(0);
      await expect(totalChats).toBeFocused();
    }
  }
  await confirmWorkbookCutoff(page, f);
}
async function confirmWorkbookCutoff(page, f) {
  const w = wizard(page);
  const chosen = (await batch(page)).config.sheets.filter(sheet => sheet.enabled && !sheet.columns.some(column => column.destination === 'reportAsOf'));
  if (!chosen.length) { await noOverflow(page); return; }
  await w.getByLabel('Este archivo está actualizado hasta…', { exact: true }).fill(f.cutoff);
  await button(w, 'Confirmar corte para hojas elegidas').click();
  await confirmDecision(page, 'Confirmar corte del archivo', 'Confirmar este corte', chosen.map(sheet => ({ label: sheet.sheetName, detail: `Corte: ${f.cutoff}` })));
  await noOverflow(page);
}
async function preview(page, label) {
  const requested = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/preview') && response.request().method() === 'POST');
  await wizard(page).getByRole('button', { name: label || /^(Guardar columnas y revisar|Guardar cambios y revisar)$/, exact: true }).click();
  expect((await requested).status()).toBe(202);
  await expect.poll(async () => (await batch(page)).state, { timeout }).toBe('review');
  await expect(wizard(page).locator('[data-import-operation]').first()).toBeVisible({ timeout });
  return batch(page);
}
async function repairPhones(page, f) {
  const w = wizard(page);
  await openDisclosure(w, /^Filas originales y motivos/);
  for (const number of [2, 3]) {
    const row = w.locator('article').filter({ has: page.getByRole('heading', { name: `VENTAS · fila ${number}`, exact: true }) });
    await openDisclosure(row, 'Valores originales por posición');
    await button(row, 'Completar o corregir columna 5').click();
    const dialog = page.getByRole('dialog', { name: 'Completar o corregir celda', exact: true });
    await expect(dialog.getByText('Original conservado:')).toContainText('(vacío)');
    await expect(dialog.getByLabel('Hoja de la celda')).toHaveValue('VENTAS');
    await expect(dialog.getByLabel('Columna de la celda')).toHaveValue('5');
    await dialog.getByLabel('Valor corregido', { exact: true }).fill(f.phone);
    await dialog.getByLabel('Motivo de la resolución').fill('Celular sintético confirmado por el negocio, no deducido de otra columna');
    await button(dialog, 'Preparar corrección').click();
    await expect(dialog).toHaveCount(0);
    await expect(button(row, 'Completar o corregir columna 5')).toBeFocused();
  }
}
function operation(page, key) {
  return wizard(page).locator('article').filter({ has: page.getByRole('checkbox', { name: `Seleccionar operación ${key}`, exact: true }) });
}
async function createProductFromReview(page, f, reviewed) {
  const group = reviewed.preview.groups.find(group => group.kind === 'commercial');
  const card = operation(page, group.entityKey || group.key);
  await openDisclosure(card, 'Otras opciones de corrección');
  await button(card, 'Vincular producto').click();
  const resolver = page.getByRole('dialog', { name: 'Vincular producto', exact: true });
  await openDisclosure(resolver, 'Cambiar ubicación o identificación');
  await resolver.getByLabel('Identificador exacto del archivo', { exact: false }).fill(f.productKey);
  await button(resolver, 'Guardar lote y crear producto').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Precio en pesos colombianos')).toBeVisible();
  await dialog.getByLabel('Nombre', { exact: false }).fill(f.productName);
  await dialog.getByLabel('Presentación / contenido').fill('Unidad exclusivamente sintética');
  await dialog.getByLabel('Precio en pesos colombianos').fill('55000');
  await dialog.getByLabel('Existencias físicas (unidades)').fill('10');
  await openDisclosure(dialog, 'Costos y obsequios');
  await dialog.getByLabel('Disponible para pedidos', { exact: true }).check();
  await dialog.getByLabel('Costo unitario', { exact: true }).fill('23000');
  await dialog.getByLabel('Vigente desde', { exact: true }).fill(`${f.year}-08-01`);
  await button(dialog, 'Crear producto').click();
  await expect(dialog).toHaveCount(0);
  await expect(wizard(page)).toBeVisible();
  f.product = records(await get(page, '/api/admin/products')).find(product => product.title === f.productName);
  expect(f.product.stockQuantity).toBe(10);
  expect(f.product.unitCostMinor).toBe(2300000);
}
async function confirmHistoricalPolicy(page, f, reviewed) {
  const group = reviewed.preview.groups.find(group => group.kind === 'commercial');
  await button(wizard(page), 'Todas las operaciones').click();
  const card = operation(page, group.key);
  await openDisclosure(card, 'Otras opciones de corrección');
  await button(card, 'Aprobar política histórica').click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('combobox', { name: 'Versión de regla aprobada', exact: true }) });
  await dialog.getByRole('combobox', { name: 'Versión de regla aprobada', exact: true }).selectOption(f.ruleId);
  await dialog.getByLabel('Motivo de la resolución').fill('Reconocer al entregar y usar las fechas reales de cargos; comisiones deshabilitadas en este caso sintético');
  await button(dialog, 'Preparar corrección').click();
  await expect(dialog).toHaveCount(0);
}
async function assertValid(page) {
  const reviewed = await batch(page);
  expect(reviewed.preview.groups.flatMap(group => group.errors || []), 'No se omiten grupos problemáticos para hacer pasar la prueba').toEqual([]);
  expect(reviewed.preview.groups.length).toBeGreaterThan(0);
  await expect(button(wizard(page), 'Continuar a confirmación')).toBeEnabled();
  return reviewed;
}
async function apply(page) {
  await assertValid(page);
  await button(wizard(page), 'Continuar a confirmación').click();
  await button(wizard(page), 'Confirmar e importar').click();
  await expect.poll(async () => (await batch(page)).state, { timeout, intervals: [1000, 2000, 3000] }).toBe('completed');
  return batch(page);
}
async function businessFacts(page, f) {
  const orders = await get(page, '/api/admin/orders?' + new URLSearchParams({ q: f.customer, page: '1' }));
  expect(orders.total).toBe(1);
  const order = await get(page, `/api/admin/orders/${orders.records[0].id}`);
  expect(order.customerName).toBe(f.customer);
  expect(order.phone).toBe(f.phone);
  expect(order.marketingCampaign).toBe(f.campaign);
  expect(order.totalMinor).toBe(11000000);
  expect(order.ruleSnapshot).toMatchObject({ id: f.ruleId, saleRecognition: 'delivered', shippingExpenseDate: 'charge_date', commission: { enabled: false } });
  expect(order.recognition).toMatchObject({ on: `${f.year}-09-30`, ruleVersionId: f.ruleId, basis: 'delivered' });
  expect(order.items).toHaveLength(2);
  expect(new Set(order.items.map(line => line.lineId)).size).toBe(2);
  expect(order.items.map(line => [line.itemId, line.quantity, line.unitCostMinor, line.unitPriceMinor])).toEqual(Array(2).fill([f.product.id, 1, 2000000, 5500000]));
  expect(order.inventoryOpening.on).toBe(f.opening);
  expect(order.inventory.version).toBe(2);
  expect(order.collections).toEqual([]);
  expect(order.paymentSummary.netCollectedMinor).toBe(0);
  expect(order.shipments).toHaveLength(1);
  const shipment = await get(page, `/api/admin/business/shipments/${order.shipments[0].id}`);
  expect(shipment.orderId).toBe(order.id);
  expect(shipment.tracking).toBe(f.tracking);
  expect(shipment.status).toBe('delivered');
  expect(shipment.events.filter(event => event.status === 'delivered')).toHaveLength(1);
  expect(shipment.events.find(event => event.status === 'delivered').occurredOn).toBe(`${f.year}-09-30`);
  expect(shipment.assignments.map(assignment => ({ lineId: assignment.lineId, quantity: assignment.quantity })).sort((a, b) => a.lineId.localeCompare(b.lineId))).toEqual(order.items.map(line => ({ lineId: line.lineId, quantity: 1 })).sort((a, b) => a.lineId.localeCompare(b.lineId)));
  const product = records(await get(page, '/api/admin/products')).find(product => product.id === f.product.id);
  expect({ stock: product.stockQuantity, reserved: product.stockReserved, catalogCost: product.unitCostMinor }).toEqual({ stock: 10, reserved: 0, catalogCost: 2300000 });
  const expenses = await get(page, '/api/admin/finance/expenses?' + new URLSearchParams({ startDate: `${f.year}-09-01`, endDateExclusive: f.opening }));
  expect(expenses.total).toBe(7);
  const amounts = Object.fromEntries(['shipping_out', 'shipping_insurance', 'advertising', 'operating'].map(category => [category, expenses.records.filter(expense => expense.category === category).reduce((sum, expense) => sum + expense.amountMinor, 0)]));
  expect(amounts).toEqual({ shipping_out: 1200000, shipping_insurance: 100000, advertising: 2500000, operating: 1000000 });
  for (const expense of expenses.records) {
    const detail = await get(page, '/api/admin/finance/expenses?record=' + encodeURIComponent(expense.id));
    expect(detail.payments).toEqual([]);
    expect(detail.paidMinor).toBe(0);
    if (['advertising', 'operating'].includes(detail.category)) {
      expect(detail.sourceId).toBe(f.sourceId);
      expect(detail.importIdentity.externalId).toBeTruthy();
    }
    if (detail.category === 'advertising') {
      expect(Number.isInteger(detail.quantity)).toBe(true);
      expect(detail.quantity * detail.unitCostMinor).toBe(detail.amountMinor);
      expect([f.campaign, 'CAMPAÑA SECUNDARIA']).toContain(detail.campaign);
    }
  }
  const report = await get(page, `/api/admin/reports?period=month&anchor=${f.year}-09-01`);
  for (const [metric, value] of Object.entries({ netProductSales: 11000000, costOfGoods: 4000000, shippingCosts: 1300000, advertisingExpenses: 2500000, operatingExpenses: 1000000, contribution: 5700000, operatingResult: 2200000 })) expect(report.metrics[metric].value, metric).toBe(value);
  return { order, shipment, expenses: expenses.records.map(expense => ({ id: expense.id, category: expense.category, amountMinor: expense.amountMinor, identity: expense.importIdentity, campaign: expense.campaign, quantity: expense.quantity, unitCostMinor: expense.unitCostMinor })).sort((a, b) => a.id.localeCompare(b.id)), product, report };
}
async function inspectDownloads(page, f, original) {
  const template = await downloaded(page, 'Descargar plantilla vacía');
  expect(template.name).toBe('plantilla-negocio.xlsx');
  const catalog = await readExcel(template.bytes, { filename: template.name, mode: 'catalog' });
  expect(catalog.sheets.map(sheet => sheet.name)).toEqual(['VENTAS', 'ENVIOS', 'GASTOS PAUTA', 'GASTOS OPERACION', 'INSTRUCCIONES']);
  for (const sheet of catalog.sheets.filter(sheet => sheet.name !== 'INSTRUCCIONES')) {
    const parsed = await readExcel(template.bytes, { filename: template.name, mode: 'rows', sheetName: sheet.name, headerRow: 1 });
    expect(parsed.rows).toHaveLength(1);
  }
  const expanded = await downloaded(page, 'Descargar copia con hoja de gastos de operación');
  // This synthetic original already contains the expected operation sheet: expansion must return it intact.
  expect(sha(expanded.bytes)).toBe(sha(original));
  const before = unzipSync(original), after = unzipSync(expanded.bytes);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const name of Object.keys(before)) expect(sha(after[name]), name).toBe(sha(before[name]));
  const privateOriginal = await downloaded(page, 'Descargar original');
  expect(sha(privateOriginal.bytes)).toBe(sha(original));
  const prepared = await downloaded(page, 'Descargar datos preparados para volver a importar');
  const XLSX = require('xlsx'), workbook = XLSX.read(prepared.bytes, { type: 'buffer', cellDates: false });
  const data = name => XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
  expect(data('VENTAS')).toHaveLength(2);
  expect(data('VENTAS').every(row => row['ID PEDIDO'] === f.orderKey && row.CELULAR === f.phone && row['CAMPAÑA'] === f.campaign)).toBe(true);
  expect(new Set(data('VENTAS').map(row => row['ID LINEA'])).size).toBe(2);
  expect(data('ENVIOS').every(row => row['ID ENVIO'] === f.shipmentKey && row['ID PEDIDO'] === f.orderKey)).toBe(true);
  const expenses = data('GASTOS');
  expect(expenses).toHaveLength(5);
  expect(new Set(expenses.map(row => row['ID GASTO'])).size).toBe(5);
  expect(expenses.every(row => ['advertising', 'operating'].includes(row.CATEGORIA))).toBe(true);
  expect(data('ASIGNACIONES')).toHaveLength(2);
  expect(data('ASIGNACIONES').every(row => row['ID PEDIDO'] === f.orderKey && row['ID ENVIO'] === f.shipmentKey && row.CANTIDAD === 1)).toBe(true);
  const expenseObservations = data('OBSERVACIONES').filter(row => row.AMBITO === 'expense');
  expect(expenseObservations.some(row => row['TIPO VALOR'] === 'integer' && Number.isInteger(row.VALOR))).toBe(true);
  expect(expenseObservations.some(row => row['TIPO VALOR'] === 'money_minor' && [100000, 200000].includes(row.VALOR))).toBe(true);
  expect(expenseObservations.every(row => expenses.some(expense => expense['ID GASTO'] === row['ID ENTIDAD']))).toBe(true);
  const tables = workbook.SheetNames.reverse().map(name => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
    return { name, rows: rows.length ? [rows[0], ...rows.slice(1).reverse()] : [] };
  });
  return writeExcelSheets(tables);
}

test('libro sintético: cuatro pasos, apertura, corrección, perfil y reimportación real sin duplicados ni caja', async ({ page }, info) => {
  test.setTimeout(1200000);
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const marker = `Workbook-${info.project.name}-${randomUUID().slice(0, 8)}`;
  await login(page);
  const settings = await get(page, '/api/admin/business/settings');
  const usedYears = new Set(settings.rulesVersions.map(rule => Number(rule.effectiveOn.slice(0, 4))));
  const year = Array.from({ length: 20 }, (_, index) => 2001 + index).find(year => !usedYears.has(year));
  expect(year, 'Se necesita un septiembre sintético sin otra vigencia de esta prueba').toBeTruthy();
  const f = { marker, year, customer: `Cliente sintético ${marker}`, phone: '3001234567', productKey: `SKU-${marker}`, productName: `Producto sintético ${marker}`, campaign: `CAMP-${marker}`, orderKey: `ORDER-${marker}`, shipmentKey: `SHIP-${marker}`, tracking: `GUIA-${marker}`, expenseKey: `OP-${marker}`, expenseConcept: `Operación sintética ${marker}`, cutoff: `${year}-10-03`, opening: `${year}-10-01`, profileName: `Perfil sintético ${marker}` };
  const consoleErrors = [], pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const baseline = await moneyAndPeople(page);
  await preparePolicy(page, f);

  await test.step('Entrar desde primeros pasos y crear origen sin caja', async () => {
    await navigate(page, 'Configuración');
    await button(page, 'Ya llevo mi negocio en Excel').click();
    await expect(page).toHaveURL(url => url.searchParams.get('section') === 'orders' && url.searchParams.get('tab') === 'imports');
    if (await button(wizard(page), 'Nueva importación').count()) await button(wizard(page), 'Nueva importación').click();
    await button(wizard(page), 'Crear un origen para mis archivos').click();
    await wizard(page).getByLabel('Nombre del origen', { exact: true }).fill(`Origen ${marker}`);
    await button(wizard(page), 'Crear origen').click();
    await expect(wizard(page)).toContainText('Principal');
    expect(await moneyAndPeople(page)).toEqual(baseline);
  });
  const original = syntheticWorkbook(f);
  await test.step('Catálogo multihoja, exclusiones, publicidad por grupos, corte y apertura', async () => {
    await upload(page, original, `libro-${marker}.xlsx`);
    await expect(wizard(page).getByRole('combobox', { name: 'Hoja actual', exact: true })).toHaveValue('');
    await expect(wizard(page).locator('[data-import-sheet]')).toHaveCount(6);
    await expect(wizard(page).locator('[data-import-sheet="REVISION"]')).toContainText(/vacía/i);
    await configureSheets(page, f);
    await openDisclosure(wizard(page), 'Guardar una configuración para próximas importaciones');
    await wizard(page).getByLabel('Nombre de la configuración', { exact: true }).fill(f.profileName);
    await button(wizard(page), 'Guardar configuración').click();
    await expect.poll(async () => (await batch(page)).profileId, { timeout }).toBeTruthy();
    const saved = await batch(page);
    f.sourceId = saved.sourceId;
    f.profileId = saved.profileId;
    f.profileConfig = saved.config;
    expect(f.profileId).toBeTruthy();
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(wizard(page).locator('[data-import-sheet]')).toHaveCount(6, { timeout });
    expect((await batch(page)).config).toEqual(saved.config);
    expect((await batch(page)).config.sheets.filter(sheet => !sheet.enabled).map(sheet => sheet.sheetName).sort()).toEqual(['INSTRUCCIONES', 'REVISION']);
  });
  await test.step('Completar celular literal, crear producto real con diez unidades y revisar efectos', async () => {
    let reviewed = await preview(page);
    expect(reviewed.preview.groups.some(group => group.errors?.some(error => error.code === 'IMPORT_ORDER_INCOMPLETE'))).toBe(true);
    await repairPhones(page, f);
    reviewed = await preview(page, 'Guardar cambios y revisar');
    await createProductFromReview(page, f, reviewed);
    reviewed = await preview(page);
    await wizard(page).getByLabel('Fecha del conteo físico', { exact: true }).fill(f.opening);
    await wizard(page).getByRole('checkbox', { name: 'Confirmo que las existencias guardadas son el conteo físico real de esta fecha', exact: true }).check();
    await confirmHistoricalPolicy(page, f, reviewed);
    await preview(page, 'Guardar cambios y revisar');
    reviewed = await assertValid(page);
    expect(reviewed.inventoryOpening).toEqual({ on: f.opening, confirmed: true });
    expect(reviewed.preview.inventory.find(effect => effect.productId === f.product.id)).toMatchObject({ stockQuantity: 10, stockReserved: 0, consumptionDelta: 0, reservationDelta: 0 });
    await noOverflow(page);
    await wizard(page).screenshot({ path: info.outputPath('synthetic-workbook-review.png') });
    f.prepared = await inspectDownloads(page, f, original);
    const resume = page.url();
    await navigate(page, 'Inicio');
    await page.goto(resume);
    await expect(button(wizard(page), 'Continuar a confirmación')).toBeEnabled({ timeout });
    await expect(wizard(page).getByLabel('Fecha del conteo físico', { exact: true })).toHaveValue(f.opening);
    await expect(wizard(page).getByRole('checkbox', { name: 'Confirmo que las existencias guardadas son el conteo físico real de esta fecha', exact: true })).toBeChecked();
    await apply(page);
  });
  let first;
  await test.step('Consultar pedido, campaña, envío, gastos, inventario e informe exactos', async () => {
    first = await businessFacts(page, f);
    expect(await moneyAndPeople(page)).toEqual(baseline);
    await navigate(page, 'Pedidos');
    await selectWorkspace(page, 'Vistas de pedidos', 'Pedidos');
    await page.getByRole('textbox', { name: 'Buscar pedidos', exact: true }).fill(f.customer);
    await button(page, `Abrir pedido AN-${String(first.order.number).padStart(6, '0')}`).click();
    const order = page.getByRole('dialog');
    await expect(order).toContainText(f.campaign);
    await expect(order.locator('input[name="phone"]')).toHaveValue(f.phone);
    await selectWorkspace(order, 'Detalle del pedido', 'Envíos');
    await expect(order).toContainText(f.tracking);
    await selectWorkspace(order, 'Detalle del pedido', 'Cobros');
    await expect(order).toContainText(/No hay cobros|Sin cobros|No se han registrado cobros/);
    await button(order, 'Cerrar pedido').click();
    await navigate(page, 'Caja');
    await selectWorkspace(page, 'Vistas de caja', 'Gastos y pagos');
    await page.getByLabel('Fecha de referencia', { exact: true }).fill(`${year}-09-01`);
    await page.getByRole('textbox', { name: /Buscar/ }).fill(f.expenseConcept);
    await expect(page.getByText(f.expenseConcept, { exact: true })).toBeVisible();
    const expense = page.locator('article.cash-row').filter({ has: page.getByRole('heading', { name: f.expenseConcept, exact: true }) });
    await button(expense, 'Ver detalle').click();
    await expect(page.locator('.cash-detail')).toContainText(f.expenseConcept);
    await expect(page.locator('.cash-detail')).toContainText(formatMoneyMinor(1000000));
    await button(page.locator('.cash-detail'), 'Cerrar detalle').click();
    await navigate(page, 'Informes');
    await page.getByLabel('Fecha de referencia', { exact: true }).fill(`${year}-09-01`);
    await expect(page.locator('.report-metrics')).toContainText(formatMoneyMinor(2200000), { timeout });
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('synthetic-workbook-report.png') });
  });
  await test.step('Otro nombre y filas reordenadas reutilizan perfil sin duplicar hechos', async () => {
    await page.goto(`/admin?section=orders&tab=imports&batch=new&source=${f.sourceId}&record=${f.profileId}`);
    await expect(wizard(page).getByRole('combobox', { name: 'Usar una configuración guardada (opcional)', exact: true })).toHaveValue(f.profileId, { timeout });
    await upload(page, syntheticWorkbook(f, { corrected: true, reordered: true }), `otro-mes-${marker}.xlsx`);
    expect((await batch(page)).config).toEqual({ ...f.profileConfig, sheets: f.profileConfig.sheets.map(sheet => ({ ...sheet, reportAsOf: null })) });
    await confirmWorkbookCutoff(page, f);
    await preview(page);
    await apply(page);
    const second = await businessFacts(page, f);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.items.map(line => line.lineId).sort()).toEqual(first.order.items.map(line => line.lineId).sort());
    expect(second.shipment.id).toBe(first.shipment.id);
    expect(second.shipment.events.map(event => event.id)).toEqual(first.shipment.events.map(event => event.id));
    expect(second.expenses).toEqual(first.expenses);
    expect(second.order.inventoryOpening).toEqual(first.order.inventoryOpening);
    expect(await moneyAndPeople(page)).toEqual(baseline);
  });
  await test.step('El preparado descargado antes de aplicar vuelve a cargar con sus IDs y correcciones', async () => {
    await page.goto(`/admin?section=orders&tab=imports&batch=new&source=${f.sourceId}`);
    await expect(wizard(page).getByRole('combobox', { name: 'Usar una configuración guardada (opcional)', exact: true })).toBeVisible({ timeout });
    await upload(page, f.prepared, `preparado-reordenado-${marker}.xlsx`);
    await configureSheets(page, f);
    await preview(page);
    await apply(page);
    const third = await businessFacts(page, f);
    expect(third.order.id).toBe(first.order.id);
    expect(third.order.items.map(line => line.lineId).sort()).toEqual(first.order.items.map(line => line.lineId).sort());
    expect(third.shipment.id).toBe(first.shipment.id);
    expect(third.shipment.events.map(event => event.id)).toEqual(first.shipment.events.map(event => event.id));
    expect(third.expenses).toEqual(first.expenses);
    expect(third.order.inventoryOpening).toEqual(first.order.inventoryOpening);
    expect(await moneyAndPeople(page)).toEqual(baseline);
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('descarga privada amplía un libro sintético conservando las partes originales y una operación vacía', async ({ page }, info) => {
  test.setTimeout(180000);
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await login(page);
  await navigate(page, 'Pedidos');
  await selectWorkspace(page, 'Vistas de pedidos', 'Importar Excel');
  await button(wizard(page), 'Nueva importación').click();
  const marker = `Descarga-${info.project.name}-${randomUUID().slice(0, 8)}`;
  await button(wizard(page), 'Crear un origen para mis archivos').click();
  await wizard(page).getByLabel('Nombre del origen', { exact: true }).fill(marker);
  await button(wizard(page), 'Crear origen').click();
  const original = writeExcelSheets([
    { name: 'REVISION', rows: [] },
    { name: 'VENTAS', rows: [IMPORT_TABLES.sales.columns.map(column => column.header)] },
  ]);
  await upload(page, original, `${marker}.xlsx`);
  const expanded = await downloaded(page, 'Descargar copia con hoja de gastos de operación');
  expect(expanded.name).toBe(`${marker} - con operacion.xlsx`);
  const catalog = await readExcel(expanded.bytes, { filename: expanded.name, mode: 'catalog' });
  expect(catalog.sheets.map(sheet => sheet.name)).toEqual(['REVISION', 'VENTAS', 'GASTOS OPERACION']);
  const operation = await readExcel(expanded.bytes, { filename: expanded.name, mode: 'rows', sheetName: 'GASTOS OPERACION', headerRow: 1 });
  expect(operation.rows).toHaveLength(1);
  expect(operation.rows[0].cells.map(cell => cell.value)).toEqual(IMPORT_TABLES.operating.columns.map(column => column.header));
  const before = unzipSync(original), after = unzipSync(expanded.bytes);
  const changedMetadata = new Set(['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'docProps/app.xml']);
  for (const [name, bytes] of Object.entries(before)) {
    expect(after[name], `No se elimina ${name}`).toBeDefined();
    if (!changedMetadata.has(name)) expect(sha(after[name]), name).toBe(sha(bytes));
  }
  expect(sha((await downloaded(page, 'Descargar original')).bytes)).toBe(sha(original));
  const saved = await batch(page);
  expect(saved.acceptedRevision).toBeNull();
  await noOverflow(page);
});

test('vínculo de producto existente: guarda sin crear, retoma la selección filtrada y conserva el borrador al cancelar un alta', async ({ page }, info) => {
  test.setTimeout(360000);
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await login(page);
  const marker = `Vinculo-${info.project.name}-${randomUUID().slice(0, 8)}`;
  const productName = `Producto existente sintético ${marker}`;
  const productKeys = [`SKU-EXISTENTE-${marker}`, `SKU-CANCELAR-${marker}`];
  const reasons = ['Producto existente confirmado sin dar de alta otro', 'Conservar este motivo al cancelar el alta separada'];
  const customer = `Cliente exclusivamente sintético ${marker}`;

  await navigate(page, 'Productos');
  await button(page, 'Crear producto').click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Nombre', { exact: false }).fill(productName);
  await button(editor, 'Ingresar URL HTTPS').click();
  await editor.getByLabel('URL pública de la fotografía', { exact: true }).fill('/brand/creatina-vital-force.jpg');
  await editor.getByLabel('Presentación / contenido').fill('Unidad sintética para vincular, no duplicar');
  await editor.getByLabel('Precio en pesos colombianos').fill('55000');
  await editor.getByLabel('Existencias físicas (unidades)').fill('10');
  await openDisclosure(editor, 'Costos y obsequios');
  await editor.getByLabel('Disponible para pedidos', { exact: true }).check();
  await editor.getByLabel('Costo unitario', { exact: true }).fill('20000');
  await editor.getByLabel('Vigente desde', { exact: true }).fill('2026-01-01');
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/products' && response.request().method() === 'POST');
  await button(editor, 'Crear producto').click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const product = await created.json();
  expect(product.id).toBeTruthy();
  await expect(editor).toHaveCount(0);
  const productsBefore = records(await get(page, '/api/admin/products')).map(({ id }) => id).sort();
  const unexpectedWrites = [];
  let previewRequests = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/preview')) previewRequests++;
    if (request.method() === 'POST' && (path === '/api/admin/products' || path === '/api/admin/orders' || path.endsWith('/commit'))) unexpectedWrites.push(path);
  });

  await navigate(page, 'Pedidos');
  await selectWorkspace(page, 'Vistas de pedidos', 'Importar Excel');
  const w = wizard(page);
  await button(w, 'Nueva importación').click();
  await button(w, 'Crear un origen para mis archivos').click();
  await w.getByLabel('Nombre del origen', { exact: true }).fill(`Origen sintético ${marker}`);
  await button(w, 'Crear origen').click();
  const original = writeExcelSheets([{ name: 'VENTAS', rows: [
    IMPORT_TABLES.sales.columns.map(column => column.header),
    ...productKeys.map((key, index) => [`PEDIDO-${index + 1}-${marker}`, `LINEA-${index + 1}`, '2026-10-20', customer, '3001234567', 'Bogotá', 'Cundinamarca', 'Dirección sintética 123', key, 1, 55000, 20000, 0, 0, 'CAMPAÑA SINTÉTICA', 'Solo revisión, nunca aplicar en este escenario']),
  ] }]);
  await upload(page, original, `${marker}-2026.xlsx`);
  await button(w.locator('[data-import-sheet="VENTAS"]'), 'Usar propuesta de VENTAS').click();
  await w.getByRole('combobox', { name: 'Hoja actual', exact: true }).selectOption('VENTAS');
  await readSamples(page);
  await configureReading(page);
  await confirmWorkbookCutoff(page, { cutoff: '2026-10-21' });
  let reviewed = await preview(page);
  expect(reviewed.preview.groups).toHaveLength(2);
  expect(reviewed.preview.groups.flatMap(group => group.errors || []).filter(error => error.code === 'IMPORT_PRODUCT_LINK').map(error => error.externalKey).sort()).toEqual([...productKeys].sort());
  const batchPath = `/api/admin/imports/${encodeURIComponent(reviewed.id)}`;
  const links = saved => saved.resolutions.filter(resolution => resolution.action === 'link_product');
  const groupForRow = (saved, rowNumber) => saved.preview.groups.find(group => group.rowRefs.some(ref => ref.sheet === 'VENTAS' && ref.rowNumber === rowNumber));
  const resolver = page.getByRole('dialog', { name: 'Vincular producto', exact: true });
  const selection = resolver.getByRole('combobox', { name: 'Registro que se vinculará', exact: true });
  const search = resolver.getByLabel('Buscar registro real', { exact: true });
  const savedLinks = w.locator('details[aria-label="Vínculos de productos guardados"]');
  const openProductLink = async rowNumber => {
    const group = groupForRow(reviewed, rowNumber);
    expect(group).toBeTruthy();
    const card = operation(page, group.key);
    await openDisclosure(card, 'Otras opciones de corrección');
    await button(card, 'Vincular producto').click();
    await expect(resolver).toBeVisible();
    await openDisclosure(resolver, 'Cambiar ubicación o identificación');
  };
  const selectExisting = async () => {
    await search.fill(productName);
    await expect(selection.locator('option').filter({ hasText: productName })).toHaveCount(1);
    await selection.selectOption(product.id);
    await expect(selection).toHaveValue(product.id);
    await expect(button(resolver, 'Guardar lote y crear producto')).toBeDisabled();
    await expect(button(resolver, 'Guardar vínculo')).toBeEnabled();
  };
  const saveExisting = async (externalKey, reason) => {
    const previewsBefore = previewRequests;
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === batchPath && response.request().method() === 'PUT');
    await button(resolver, 'Guardar vínculo').click();
    const response = await saving;
    expect(response.status()).toBe(200);
    expect(links(await response.json())).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'link_product', externalKey, internalId: product.id, reason })]));
    await expect(resolver).toHaveCount(0);
    const saved = await batch(page);
    expect(links(saved)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'link_product', externalKey, internalId: product.id, reason })]));
    expect(saved.preview).toBeNull();
    expect(saved.acceptedRevision).toBeNull();
    expect(previewRequests).toBe(previewsBefore);
    await openDisclosure(w, /^Vínculos guardados/);
    await expect(savedLinks).toContainText(externalKey);
    await expect(savedLinks).toContainText(productName);
    await expect(button(w, 'Guardar cambios y revisar')).toBeVisible();
    expect(unexpectedWrites).toEqual([]);
    return saved;
  };

  await openProductLink(2);
  await resolver.getByLabel('Identificador exacto del archivo', { exact: false }).fill(productKeys[0]);
  await resolver.getByLabel('Motivo de la resolución', { exact: true }).fill(reasons[0]);
  await selectExisting();
  const absentQuery = `SIN-COINCIDENCIAS-${marker}`;
  await search.fill(absentQuery);
  await expect(selection.locator('option')).toHaveCount(2);
  await expect(selection).toHaveValue(product.id);
  await expect(selection.locator('option:checked')).toContainText(productName);
  await expect(button(resolver, 'Guardar lote y crear producto')).toBeDisabled();
  const firstSaved = await saveExisting(productKeys[0], reasons[0]);
  expect(links(firstSaved)).toHaveLength(1);
  const pendingLinks=w.getByRole('region', { name: 'Productos por vincular', exact: true });
  await expect(button(pendingLinks, `Vincular o crear ${productKeys[1]}`)).toBeVisible();

  const resume = page.url(), previewsBeforeReload = previewRequests;
  await page.reload();
  await expect(page).toHaveURL(resume);
  await expect(savedLinks).toBeVisible({ timeout });
  await openDisclosure(w, /^Vínculos guardados/);
  await expect(savedLinks).toContainText(productName, { timeout });
  expect(links(await batch(page))).toEqual(links(firstSaved));
  expect(previewRequests).toBe(previewsBeforeReload);
  await expect(button(pendingLinks, `Vincular o crear ${productKeys[1]}`)).toBeVisible();
  await button(savedLinks, `Cambiar vínculo de ${productKeys[0]}`).click();
  await expect(resolver).toBeVisible();
  await openDisclosure(resolver, 'Cambiar ubicación o identificación');
  await expect(resolver.getByLabel('Identificador exacto del archivo', { exact: false })).toHaveValue(productKeys[0]);
  await expect(resolver.getByLabel('Motivo de la resolución', { exact: true })).toHaveValue(reasons[0]);
  await expect(selection).toHaveValue(product.id);
  await expect(selection.locator('option:checked')).toContainText(productName);
  await search.fill(absentQuery);
  await expect(selection.locator('option')).toHaveCount(2);
  await expect(selection).toHaveValue(product.id);
  await expect(selection.locator('option:checked')).toContainText(productName);
  await expect(button(resolver, 'Guardar lote y crear producto')).toBeDisabled();
  await saveExisting(productKeys[0], reasons[0]);
  await button(pendingLinks, `Vincular o crear ${productKeys[1]}`).click();
  await expect(resolver).toBeVisible();
  await openDisclosure(resolver, 'Cambiar ubicación o identificación');
  await resolver.getByLabel('Identificador exacto del archivo', { exact: false }).fill(productKeys[1]);
  await resolver.getByLabel('Motivo de la resolución', { exact: true }).fill(reasons[1]);
  await search.fill(absentQuery);
  await expect(selection.locator('option')).toHaveCount(1);
  await expect(selection).toHaveValue('');
  await expect(button(resolver, 'Guardar lote y crear producto')).toBeEnabled();
  const previewsBeforeCancel = previewRequests;
  await button(resolver, 'Guardar lote y crear producto').click();
  const newProduct = page.getByRole('dialog').filter({ has: page.getByLabel('Precio en pesos colombianos') });
  await expect(newProduct).toBeVisible();
  expect(links(await batch(page))).toEqual(links(firstSaved));
  await newProduct.getByLabel('Nombre', { exact: false }).fill(`Alta cancelada ${marker}`);
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  await button(newProduct, 'Cancelar').click();
  await expect(resolver).toBeVisible();
  await expect(resolver.getByLabel('Identificador exacto del archivo', { exact: false })).toHaveValue(productKeys[1]);
  await expect(resolver.getByLabel('Motivo de la resolución', { exact: true })).toHaveValue(reasons[1]);
  await expect(search).toHaveValue(absentQuery);
  await expect(selection).toHaveValue('');
  const cancelled = await batch(page);
  expect(links(cancelled)).toEqual(links(firstSaved));
  expect(cancelled.preview).toBeNull();
  expect(previewRequests).toBe(previewsBeforeCancel);
  expect(unexpectedWrites).toEqual([]);
  await selectExisting();
  const bothSaved = await saveExisting(productKeys[1], reasons[1]);
  expect(links(bothSaved)).toHaveLength(2);
  expect(links(bothSaved).find(link => link.externalKey === productKeys[0])).toEqual(links(firstSaved)[0]);
  await expect(pendingLinks).toHaveCount(0);

  reviewed = await preview(page, 'Guardar cambios y revisar');
  expect(reviewed.preview.groups.flatMap(group => group.errors || []).filter(error => error.code === 'IMPORT_PRODUCT_LINK')).toEqual([]);
  for (const [index, externalKey] of productKeys.entries()) {
    expect(groupForRow(reviewed, index + 2).lines).toEqual([expect.objectContaining({ kind: 'products', itemId: product.id, title: productName, productExternalKey: externalKey, quantity: 1, unitPriceMinor: 5500000 })]);
  }
  expect(reviewed.acceptedRevision).toBeNull();
  expect((await get(page, '/api/admin/orders?' + new URLSearchParams({ q: customer, page: '1' }))).total).toBe(0);
  expect(records(await get(page, '/api/admin/products')).map(({ id }) => id).sort()).toEqual(productsBefore);
  expect(unexpectedWrites).toEqual([]);
  await noOverflow(page);
});

test('fechas originales: 101 correcciones seleccionadas se conservan por celda al guardar y retomar', async ({ page }, info) => {
  test.setTimeout(360000);
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await login(page);
  const marker = `Fechas-${info.project.name}-${randomUUID().slice(0, 8)}`;
  const sheetName = 'GASTOS OPERACION', cutoff = '2026-10-03';
  const dates = Array.from({ length: 101 }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
  const original = writeExcelSheets([{ name: sheetName, rows: [
    IMPORT_TABLES.operating.columns.map(column => column.header),
    ...dates.map((date, index) => [`${marker}-${index + 1}`, date, `Gasto sintético de fecha ${index + 1}`, index + 1, 'Proveedor sintético de fechas', `REF-${index + 1}`, 'Solo revisión, sin aplicar']),
  ] }]);
  const financialBefore = await moneyAndPeople(page);
  const expensesBefore = await get(page, '/api/admin/finance/expenses');
  const reportBefore = await get(page, '/api/admin/reports?period=year&anchor=2026-01-01');
  const metricValues = report => Object.fromEntries(Object.entries(report.metrics).map(([key, metric]) => [key, metric.value]));
  await navigate(page, 'Pedidos');
  await selectWorkspace(page, 'Vistas de pedidos', 'Importar Excel');
  const w = wizard(page);
  await button(w, 'Nueva importación').click();
  await button(w, 'Crear un origen para mis archivos').click();
  await w.getByLabel('Nombre del origen', { exact: true }).fill(`Origen ${marker}`);
  await button(w, 'Crear origen').click();
  await upload(page, original, `${marker}-2027.xlsx`);
  await button(w.locator(`[data-import-sheet="${sheetName}"]`), `Usar propuesta de ${sheetName}`).click();
  await w.getByRole('combobox', { name: 'Hoja actual', exact: true }).selectOption(sheetName);
  await readSamples(page);
  await configureReading(page);
  await confirmWorkbookCutoff(page, { cutoff });
  const first = await preview(page);
  expect(first.preview.groups).toHaveLength(101);
  const initialWarnings = first.preview.groups.flatMap(group => group.errors || []).filter(error => error.code === 'IMPORT_YEAR_CONFIRMATION');
  expect(initialWarnings).toHaveLength(101);
  expect(initialWarnings.map(error => ({ sheet: error.sheet, rowNumber: error.rowNumber, columnIndex: error.columnIndex, date: error.normalizedDate })).sort((a, b) => a.rowNumber - b.rowNumber)).toEqual(dates.map((date, index) => ({ sheet: sheetName, rowNumber: index + 2, columnIndex: 1, date })));
  await w.getByRole('region', { name: 'Problemas por resolver', exact: true }).getByRole('button', { name: /^Año de fecha por confirmar/ }).click();
  await button(w, `Seleccionar todas las ${initialWarnings.length} filtradas`).click();
  await w.getByRole('region', { name: 'Acciones para seleccionadas', exact: true }).getByRole('button', { name: new RegExp(`Conservar fechas originales.*${dates.length}`) }).click();
  await confirmDecision(page, 'Conservar fechas originales', 'Confirmar estas fechas', dates.map((date, index) => ({
    label: `${sheetName} · fila ${index + 2} · columna 2`,
    detail: `Original: ${date} · Interpretación: ${date}`,
  })));
  await preview(page, 'Guardar cambios y revisar');
  const expectedCells = dates.map((value, index) => ({ sheet: sheetName, rowNumber: index + 2, columnIndex: 1, value }));
  const savedCells = reviewed => reviewed.resolutions.filter(resolution => resolution.action === 'cell_value').map(({ sheet, rowNumber, columnIndex, value }) => ({ sheet, rowNumber, columnIndex, value })).sort((a, b) => a.rowNumber - b.rowNumber);
  const preparedDates = reviewed => reviewed.preview.groups.flatMap(group => group.expenses.map(expense => ({ rowNumber: expense.rowRefs?.[0]?.rowNumber ?? group.rowRefs[0].rowNumber, date: expense.input.incurredOn }))).sort((a, b) => a.rowNumber - b.rowNumber);
  let reviewed = await assertValid(page);
  expect(savedCells(reviewed)).toEqual(expectedCells);
  expect(savedCells(reviewed).at(-1)).toEqual({ sheet: sheetName, rowNumber: 102, columnIndex: 1, value: dates.at(-1) });
  expect(preparedDates(reviewed)).toEqual(dates.map((date, index) => ({ rowNumber: index + 2, date })));
  expect(reviewed.preview.groups.flatMap(group => group.errors || []).some(error => error.code === 'IMPORT_YEAR_CONFIRMATION')).toBe(false);
  expect(reviewed.acceptedRevision).toBeNull();
  const resume = page.url();
  await page.reload();
  await expect(page).toHaveURL(resume);
  await expect(button(w, 'Continuar a confirmación')).toBeEnabled({ timeout });
  reviewed = await assertValid(page);
  expect(savedCells(reviewed)).toEqual(expectedCells);
  expect(preparedDates(reviewed)).toEqual(dates.map((date, index) => ({ rowNumber: index + 2, date })));
  expect(preparedDates(reviewed).every(row => row.date.startsWith('2026-'))).toBe(true);
  expect(reviewed.state).toBe('review');
  expect(reviewed.acceptedRevision).toBeNull();
  expect(sha((await downloaded(page, 'Descargar original')).bytes)).toBe(sha(original));
  expect(await moneyAndPeople(page)).toEqual(financialBefore);
  const expensesAfter = await get(page, '/api/admin/finance/expenses');
  expect(expensesAfter.total).toBe(expensesBefore.total);
  expect(expensesAfter.records).toEqual(expensesBefore.records);
  expect(metricValues(await get(page, '/api/admin/reports?period=year&anchor=2026-01-01'))).toEqual(metricValues(reportBefore));
  await noOverflow(page);
});

const sourceRows = page => wizard(page).locator('details:has(> summary[data-import-source-rows])');
const sourceRow = (page, sheet, rowNumber) => sourceRows(page).locator('article').filter({ has: page.getByRole('heading', { name: `${sheet} · fila ${rowNumber}`, exact: true }) });
async function startOwnImport(page, marker) {
  await page.goto('/admin?section=orders&tab=imports&batch=new');
  await button(wizard(page), 'Crear un origen para mis archivos').click();
  await wizard(page).getByLabel('Nombre del origen', { exact: true }).fill(`Origen ${marker}`);
  await button(wizard(page), 'Crear origen').click();
  await expect(button(wizard(page), 'Guardar archivo y continuar')).toBeDisabled();
}
function waitForRows(page, id, filters = {}) {
  const expected = { page: '1', state: '', q: '', sheet: '', rowNumber: '', ...filters };
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === `/api/admin/imports/${encodeURIComponent(id)}` &&
      Object.entries(expected).every(([key, value]) => (url.searchParams.get(key) || '') === String(value));
  }, { timeout });
}
async function rowsFromResponse(response) {
  expect(response.status()).toBe(200);
  return (await response.json()).rows;
}
async function expectSourceRows(page, rows) {
  await expect(sourceRows(page).locator('article > h4')).toHaveText(rows.records.map(row => `${row.sheet} · fila ${row.rowNumber}`));
}
async function correctSourceCell(page, sheet, rowNumber, column, value, reason) {
  const row = sourceRow(page, sheet, rowNumber);
  await openDisclosure(row, 'Valores originales por posición');
  await button(row, `Completar o corregir columna ${column}`).click();
  const dialog = page.getByRole('dialog', { name: 'Completar o corregir celda', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Hoja de la celda', exact: true })).toHaveValue(sheet);
  await expect(dialog.getByLabel('Columna de la celda', { exact: true })).toHaveValue(String(column));
  await dialog.getByLabel('Valor corregido', { exact: true }).fill(value);
  await dialog.getByLabel('Motivo de la resolución', { exact: true }).fill(reason);
  await button(dialog, 'Preparar corrección').click();
  await expect(dialog).toHaveCount(0);
}
async function reviewPending(page) {
  const previous = await batch(page), writes = [];
  const observe = request => {
    if (new URL(request.url()).pathname.startsWith(`/api/admin/imports/${previous.id}`) && request.method() !== 'GET') writes.push({ path: new URL(request.url()).pathname, method: request.method() });
  };
  page.on('request', observe);
  try {
    const requested = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/imports/${previous.id}/preview` && response.request().method() === 'POST');
    await button(wizard(page), 'Revisar pendientes').click();
    const response = await requested;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toMatchObject({ version: previous.version, requestId: expect.any(String) });
    await expect.poll(async () => (await batch(page)).state, { timeout }).toBe('review');
    await expect(wizard(page).locator('[data-import-operation]').first()).toBeVisible({ timeout });
    expect(writes).toEqual([{ path: `/api/admin/imports/${previous.id}/preview`, method: 'POST' }]);
    const reviewed = await batch(page);
    expect(reviewed.version).toBeGreaterThan(previous.version);
    expect(reviewed.preview.previewHash).not.toBe(previous.preview.previewHash);
    expect(reviewed.acceptedRevision).toBe(previous.acceptedRevision);
    return reviewed;
  } finally {
    page.off('request', observe);
  }
}

test('una importación parcial exige autorización y permite completar solo el gasto pendiente sin duplicar ni mover caja', async ({ page }, info) => {
  test.setTimeout(600000);
  await login(page);
  const marker = `Parcial-${info.project.name}-${randomUUID().slice(0, 8)}`, sheet = 'GASTOS OPERACION';
  const baseline = await moneyAndPeople(page);
  const original = writeExcelSheets([{ name: sheet, rows: [
    IMPORT_TABLES.operating.columns.map(column => column.header),
    [`${marker}-1`, '2026-10-20', `${marker} gasto completo`, 10000, 'Proveedor sintético', `${marker}-REF-1`, 'No registra un pago'],
    [`${marker}-2`, '2026-10-20', `${marker} gasto pendiente`, '', 'Proveedor sintético', `${marker}-REF-2`, 'Importe pendiente, no cero'],
  ] }]);
  await startOwnImport(page, marker);
  await upload(page, original, `${marker}.xlsx`);
  await configureSheets(page, { cutoff: '2026-10-31' });
  const first = await preview(page);
  expect(first.preview.summary).toMatchObject({ valid: 1, rejected: 1, total: 2 });
  expect(first.acceptedRevision).toBeNull();
  const commits = [];
  const observeCommit = request => {
    if (new URL(request.url()).pathname === `/api/admin/imports/${first.id}/commit` && request.method() === 'POST') commits.push(request.postDataJSON());
  };
  page.on('request', observeCommit);
  await button(wizard(page), 'Revisar importación parcial').click();
  const partial = wizard(page).getByRole('checkbox', { name: 'Importar 1 operaciones válidas y dejar 1 pendientes', exact: true });
  await expect(partial).not.toBeChecked();
  await expect(button(wizard(page), 'Confirmar e importar')).toBeDisabled();
  expect(commits).toEqual([]);
  expect((await get(page, '/api/admin/finance/expenses?' + new URLSearchParams({ q: marker }))).total).toBe(0);
  await partial.check();
  await button(wizard(page), 'Confirmar e importar').click();
  await expect.poll(async () => (await batch(page)).state, { timeout }).toBe('completed_with_errors');
  await expect(wizard(page).locator('[data-result="partial"]')).toBeVisible({ timeout });
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ version: first.version, previewHash: first.preview.previewHash, includeValidOnly: true, requestId: expect.any(String) });
  const applied = await batch(page);
  expect(applied.progress.expenseIds).toHaveLength(1);
  expect(applied.progress.orderIds).toEqual([]);
  const one = await get(page, '/api/admin/finance/expenses?' + new URLSearchParams({ q: marker }));
  expect(one.total).toBe(1);
  expect(one.records[0].amountMinor).toBe(1000000);
  const firstDetail = await get(page, `/api/admin/finance/expenses?record=${encodeURIComponent(one.records[0].id)}`);
  expect(firstDetail.payments).toEqual([]);
  expect(firstDetail.paidMinor).toBe(0);
  expect(await moneyAndPeople(page)).toEqual(baseline);
  const pending = await reviewPending(page);
  expect(pending.preview.summary).toMatchObject({ valid: 0, applied: 1, rejected: 1 });
  expect(commits).toHaveLength(1);
  await page.reload();
  await expect(button(wizard(page), 'Resolver primer pendiente')).toBeEnabled({ timeout });
  await openDisclosure(wizard(page), /^Filas originales y motivos/);
  const filtered = waitForRows(page, first.id, { state: 'rejected' });
  await sourceRows(page).getByRole('combobox', { name: 'Filtrar filas', exact: true }).selectOption('rejected');
  const rejectedRows = await rowsFromResponse(await filtered);
  expect(rejectedRows.records.map(row => [row.sheet, row.rowNumber])).toEqual([[sheet, 3]]);
  await expectSourceRows(page, rejectedRows);
  await expect(sourceRows(page).getByRole('combobox', { name: 'Filtrar filas', exact: true })).toBeEnabled();
  const reason = `Importe 20000 COP confirmado explícitamente para ${marker}, no deducido del gasto anterior`;
  await correctSourceCell(page, sheet, 3, 4, '20000', reason);
  const corrected = await preview(page);
  expect(corrected.resolutions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'cell_value', sheet, rowNumber: 3, columnIndex: 3, value: '20000', reason })]));
  expect(corrected.preview.summary).toMatchObject({ valid: 1, applied: 1, rejected: 0 });
  await apply(page);
  const final = await batch(page);
  expect(final.acceptedRevision).toBeGreaterThan(applied.acceptedRevision);
  const expenses = await get(page, '/api/admin/finance/expenses?' + new URLSearchParams({ q: marker }));
  expect(expenses.total).toBe(2);
  expect(new Set(expenses.records.map(expense => expense.id)).size).toBe(2);
  expect(expenses.records.map(expense => expense.amountMinor).sort((a, b) => a - b)).toEqual([1000000, 2000000]);
  expect(expenses.records.map(expense => expense.importIdentity.externalId).sort()).toEqual([`${marker}-1`, `${marker}-2`]);
  expect(expenses.records.find(expense => expense.amountMinor === 1000000).id).toBe(one.records[0].id);
  for (const expense of expenses.records) {
    const detail = await get(page, `/api/admin/finance/expenses?record=${encodeURIComponent(expense.id)}`);
    expect(detail.payments).toEqual([]);
    expect(detail.paidMinor).toBe(0);
  }
  expect(commits).toHaveLength(2);
  expect(commits[1].includeValidOnly).toBe(false);
  expect(await moneyAndPeople(page)).toEqual(baseline);
  page.off('request', observeCommit);
});

test('los problemas abren su fila exacta entre hojas y conservan filtros y búsqueda al revisar pendientes y paginar', async ({ page }, info) => {
  test.setTimeout(480000);
  await login(page);
  const marker = `Filas-${info.project.name}-${randomUUID().slice(0, 8)}`;
  const pageSize = (await get(page, '/api/admin/imports')).pageSize;
  const sheet = 'GASTOS OPERACION', copySheet = 'ZZ GASTOS OPERACION';
  const expense = (id, concept, amount) => [id, '2026-10-20', concept, amount, 'Proveedor sintético de filas', `REF-${id}`, 'Solo datos sintéticos'];
  const duplicate = expense(`${marker}-DUP`, `${marker} copia identificada`, 10000);
  const validRows = Array.from({ length: pageSize * 2 + 1 }, (_, index) => expense(`${marker}-${index}`, `${marker} concepto ${index}`, index + 100));
  const original = writeExcelSheets([
    { name: sheet, rows: [IMPORT_TABLES.operating.columns.map(column => column.header), duplicate, ...validRows, expense(`${marker}-PEND`, `${marker} importe pendiente`, '')] },
    { name: copySheet, rows: [IMPORT_TABLES.operating.columns.map(column => column.header), duplicate] },
  ]);
  await startOwnImport(page, marker);
  await upload(page, original, `${marker}.xlsx`);
  await configureSheets(page, { cutoff: '2026-10-31' });
  let reviewed = await preview(page);
  expect(reviewed.rows.total).toBeGreaterThan(reviewed.rows.pageSize);
  const duplicateGroup = reviewed.preview.groups.find(group => group.errors.some(issue => issue.code === 'IMPORT_DUPLICATE_EXPENSE'));
  expect(duplicateGroup.rowRefs).toEqual(expect.arrayContaining([{ sheet, rowNumber: 2 }, { sheet: copySheet, rowNumber: 2 }]));
  const rows = sourceRows(page), path = `/api/admin/imports/${reviewed.id}`;
  await openDisclosure(wizard(page), /^Filas originales y motivos/);
  const filter = rows.getByRole('combobox', { name: 'Filtrar filas', exact: true }), search = rows.getByLabel('Buscar en las filas de este archivo', { exact: true });
  let response = waitForRows(page, reviewed.id, { state: 'new' });
  await filter.selectOption('new');
  await rowsFromResponse(await response);
  response = waitForRows(page, reviewed.id, { state: 'new', q: marker });
  await search.fill(marker);
  await button(rows, 'Buscar filas').click();
  await rowsFromResponse(await response);
  response = waitForRows(page, reviewed.id, { page: '2', state: 'new', q: marker });
  await button(rows, 'Siguiente').click();
  const secondPage = await rowsFromResponse(await response);
  expect(secondPage.page).toBe(2);
  expect(secondPage.records.every(row => row.sheet === sheet)).toBe(true);
  await expectSourceRows(page, secondPage);
  await expect(sourceRow(page, copySheet, 2)).toHaveCount(0);
  const card = operation(page, duplicateGroup.key);
  const locations = card.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Ubicaciones de las posibles repeticiones$/ }) }).first();
  await locations.locator('summary').click();
  const copyLocation = locations.locator(':scope > div').filter({ has: page.getByText(`${copySheet} · fila 2`, { exact: true }) });
  response = waitForRows(page, reviewed.id, { sheet: copySheet, rowNumber: '2' });
  await button(copyLocation, 'Ver fila original').click();
  const exact = await rowsFromResponse(await response);
  expect(exact.total).toBe(1);
  expect(exact.records.map(row => [row.sheet, row.rowNumber])).toEqual([[copySheet, 2]]);
  expect(exact.records[0].source[0].value).toBe(duplicate[0]);
  await expectSourceRows(page, exact);
  await expect(filter).toHaveValue('');
  await expect(search).toHaveValue('');
  response = waitForRows(page, reviewed.id);
  await button(rows, 'Ver todas las filas').click();
  const restored = await rowsFromResponse(await response);
  expect(restored.page).toBe(1);
  expect(restored.total).toBe(reviewed.rows.total);
  await expectSourceRows(page, restored);
  await button(copyLocation, 'Omitir esta repetición').click();
  const resolver = page.getByRole('dialog', { name: 'Marcar fila duplicada', exact: true });
  await openDisclosure(resolver, 'Cambiar ubicación o identificación');
  await expect(resolver.getByRole('combobox', { name: 'Hoja de origen', exact: true })).toHaveValue(copySheet);
  await expect(resolver.getByLabel('Fila de origen (si aplica)', { exact: true })).toHaveValue('2');
  await resolver.getByLabel('Motivo de la resolución', { exact: true }).fill('Esta es la copia sintética exacta del mismo gasto, no una operación independiente');
  await button(resolver, 'Preparar corrección').click();
  await expect(resolver).toHaveCount(0);

  // A real preview keeps the active row query through its server-polling GET.
  response = waitForRows(page, reviewed.id, { state: 'new' });
  await filter.selectOption('new');
  await rowsFromResponse(await response);
  const query = `${marker} concepto 0`;
  response = waitForRows(page, reviewed.id, { state: 'new', q: query });
  await search.fill(query);
  await button(rows, 'Buscar filas').click();
  const matching = await rowsFromResponse(await response);
  expect(matching.records).toHaveLength(1);
  await correctSourceCell(page, sheet, 3, 7, 'Nota sintética confirmada durante esta revisión', 'Conservar una observación explícita, sin cambiar importes ni identidades');
  const pollingQueries = [];
  const observeRows = request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === path) pollingQueries.push({ state: url.searchParams.get('state'), q: url.searchParams.get('q') });
  };
  page.on('request', observeRows);
  const polled = waitForRows(page, reviewed.id, { state: 'new', q: query });
  reviewed = await preview(page);
  await rowsFromResponse(await polled);
  page.off('request', observeRows);
  expect(pollingQueries.length).toBeGreaterThan(0);
  expect(pollingQueries.every(filters => filters.state === 'new' && filters.q === query)).toBe(true);
  await expectSourceRows(page, (await get(page, `${path}?${new URLSearchParams({ state: 'new', q: query })}`)).rows);
  await expect(filter).toHaveValue('new');
  await expect(search).toHaveValue(query);
  expect(new URL(page.url()).searchParams.has('q')).toBe(false);
  expect(page.url()).not.toContain(encodeURIComponent(query));
  expect(reviewed.preview.groups.filter(group => group.errors.length)).toHaveLength(1);

  const assertFilter = async (state, q = '') => {
    const expected = await get(page, `${path}?${new URLSearchParams({ state, q, page: '1' })}`);
    const changing = waitForRows(page, reviewed.id, { state, q });
    if (await search.inputValue() !== q) {
      await search.fill(q);
      await button(rows, 'Buscar filas').click();
    } else {
      await filter.selectOption(state);
    }
    const actual = await rowsFromResponse(await changing);
    expect(actual).toEqual(expected.rows);
    expect(actual.page).toBe(1);
    expect(actual.records.every(row => !state || row.state === state)).toBe(true);
    await expectSourceRows(page, actual);
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    expect(new URL(page.url()).searchParams.has('state')).toBe(false);
    return actual;
  };
  // Search first retains the existing state; then a state change must reset page 2.
  await assertFilter('new');
  response = waitForRows(page, reviewed.id, { page: '2', state: 'new' });
  await button(rows, 'Siguiente').click();
  await rowsFromResponse(await response);
  expect((await assertFilter('rejected')).records.length).toBeGreaterThan(0);
  expect((await assertFilter('applied')).total).toBe(0);
  expect((await assertFilter('skipped')).records.map(row => [row.sheet, row.rowNumber])).toEqual([[copySheet, 2]]);
  await assertFilter('skipped', `${marker} copia identificada`);
  expect((await assertFilter('skipped', `${marker}-inexistente`)).total).toBe(0);
  await assertFilter('skipped');
  await button(wizard(page), 'Revisar importación parcial').click();
  await wizard(page).getByRole('checkbox', { name: /^Importar \d+ operaciones válidas y dejar 1 pendientes$/ }).check();
  await button(wizard(page), 'Confirmar e importar').click();
  await expect.poll(async () => (await batch(page)).state, { timeout }).toBe('completed_with_errors');
  await expect(wizard(page).locator('[data-result="partial"]')).toBeVisible({ timeout });
  expect((await assertFilter('applied')).records.length).toBeGreaterThan(0);
  reviewed = await reviewPending(page);
  await openDisclosure(wizard(page), /^Filas originales y motivos/);
  response = waitForRows(page, reviewed.id);
  await filter.selectOption('');
  await rowsFromResponse(await response);
  response = waitForRows(page, reviewed.id, { page: '2' });
  await button(rows, 'Siguiente').click();
  await rowsFromResponse(await response);
  await expect(button(wizard(page), 'Resolver primer pendiente')).toBeEnabled();
  await page.reload();
  await expect(button(wizard(page), 'Resolver primer pendiente')).toBeEnabled({ timeout });
  await openDisclosure(wizard(page), /^Filas originales y motivos/);
  response = waitForRows(page, reviewed.id, { state: 'rejected' });
  await filter.selectOption('rejected');
  const pending = await rowsFromResponse(await response);
  expect(pending.records).toHaveLength(1);
  await openDisclosure(sourceRow(page, pending.records[0].sheet, pending.records[0].rowNumber), 'Valores originales por posición');
  await expect(button(sourceRow(page, pending.records[0].sheet, pending.records[0].rowNumber), 'Completar o corregir columna 4')).toBeEnabled();
});

test('la cantidad común de obsequios resuelve el bloqueo y se conserva al retomar la hoja',async({page},info)=>{
  // The inspection and both preview jobs may each wait through the worker's 60s idle interval.
  test.setTimeout(360000);
  const panelRequest=page.waitForRequest(request=>new URL(request.url()).pathname.startsWith('/api/admin/')&&Boolean(request.headers()['x-csrf-token']));
  await login(page);
  const marker=`Obsequios-${info.project.name}-${randomUUID().slice(0,8)}`;
  const f={marker,year:'2026',cutoff:'2026-09-30'};
  const headers={Origin:new URL(page.url()).origin,'x-csrf-token':await (await panelRequest).headerValue('x-csrf-token')};
  const product=(await get(page,'/api/admin/products')).records.find(row=>row.slug==='creatina-vital-force-70-servicios');
  const giftResponse=await page.request.post('/api/admin/products',{headers,data:{...emptyRecord('products'),title:`Obsequio ${marker}`,slug:marker.toLowerCase(),status:'draft',productType:'gift',orderable:true,price:0,items:[{productId:product.id,quantity:1}]}});
  expect(giftResponse.status()).toBe(201);
  const gift=await giftResponse.json();
  const columns=IMPORT_TABLES.sales.columns.map(column=>column.header);
  const bytes=writeExcelSheets([{name:'VENTAS',rows:[
    [...columns,'Referencia del obsequio'],
    [marker,'LINE-A','2026-09-28',marker,'3001234567','Bogotá','Cundinamarca','Dirección sintética',`${marker}-producto`,1,55000,20000,0,0,'','',`${marker}-obsequio`],
  ]}]);
  await startOwnImport(page,marker);
  await upload(page,bytes,`${marker}.xlsx`);
  await configureSheets(page,f);
  await button(wizard(page),`Destino de columna ${columns.length+1}`).click();
  const mapping=page.getByRole('dialog',{name:/^Asignar columna /});
  await mapping.getByLabel('Buscar destino').fill('Referencia del obsequio');
  await mapping.getByRole('button',{name:/^Referencia del obsequio/}).click();
  await expect(mapping).toHaveCount(0);
  const current=await batch(page),saving=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/admin/imports/${current.id}`&&response.request().method()==='PUT');
  await button(wizard(page),'Guardar borrador').click();
  const saved=await (await saving).json();
  const linked=await page.request.put(`/api/admin/imports/${saved.id}`,{headers,data:{version:saved.version,requestId:randomUUID(),resolutions:[
    {action:'link_product',externalKey:`${marker}-producto`,internalId:product.id},
    {action:'link_product',externalKey:`${marker}-obsequio`,internalId:gift.id},
  ]}});
  expect(linked.status()).toBe(200);
  await page.reload();
  const codes=value=>value.preview.groups.flatMap(group=>group.errors||[]).map(error=>error.code);
  expect(codes(await preview(page))).toContain('IMPORT_GIFT_QUANTITY');
  await button(wizard(page),'Revisar columnas y valores de obsequios').click();
  const quantity=wizard(page).getByLabel('Confirmar cantidad de obsequios por fila en esta hoja');
  await quantity.fill('2');
  const reviewed=await preview(page);
  expect(codes(reviewed)).not.toContain('IMPORT_GIFT_QUANTITY');
  expect(reviewed.config.sheets.find(sheet=>sheet.sheetName==='VENTAS').defaults.giftQuantity).toBe(2);
  await page.reload();
  await button(wizard(page),'Atrás').click();
  await expect(quantity).toHaveValue('2');
  expect((await get(page,'/api/admin/orders?'+new URLSearchParams({q:marker}))).total).toBe(0);
});
