import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { openStore } from '../../lib/db/index.mjs';
import { databaseConfig } from '../../lib/db/config.mjs';
import { createAdmin, login, getSession } from '../../lib/auth.mjs';
import { productData, orderData } from '../contract.mjs';
import { testDatabaseEnv, resetPostgresStore } from '../postgres-fixture.mjs';
import { createBusinessBasics, createBusinessWorkbooks } from '../business-fixtures.mjs';
import { bogotaDate } from '../../lib/business/dates.mjs';
import { writeExcelSheets } from '../../lib/business/excel.mjs';
import { entity } from '../../lib/business/commands.mjs';
import { accountBalance } from '../../lib/business/cash.mjs';
import { buildBusinessReport } from '../../lib/business/reports.mjs';

const command = process.argv[2];
const snapshotFile = '/artifacts/operational.json';
function ensure(condition, message) { if (!condition) throw new Error(message); }
async function commercialSnapshot(store) {
  const { exportedAt, ...bundle } = await store.exportData();
  ensure(bundle.format === 'allnutrition-export-v3', 'El respaldo comercial no usa v3.');
  return bundle;
}
async function prepareBusiness(store) {
  const session = await login(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
  const fixture = await createBusinessBasics(store, { actorId: session.user.id, withPlatform: false, reportsStartOn: bogotaDate() });
  const workbooks = createBusinessWorkbooks('/artifacts', { year: fixture.year });
  const headers = ['ID envío', 'Guía', 'Transportadora', 'Estado', 'Corte'];
  const fields = ['externalShipmentId', 'tracking', 'carrier', 'rawStatus', 'reportAsOf'];
  const restartFile = '/artifacts/seguimiento-SINTETICO-reinicio-60.xlsx';
  writeFileSync(restartFile, writeExcelSheets([{ name: 'Seguimiento sintético', rows: [
    headers, ...Array.from({ length: 60 }, (_, i) => [`RESTART-${String(i + 1).padStart(3, '0')}`, `009900${String(i + 1).padStart(7, '0')}`, 'Transportadora sintética', 'Etiqueta sintética', `${fixture.year}-10-03`]),
  ] }]), { mode: 0o600 });
  const manifest = {
    year: fixture.year, actorId: fixture.actorId,
    ids: { person: fixture.person.id, account: fixture.account.id, productA: fixture.a.id, productB: fixture.b.id, gift: fixture.gift.id },
    workbooks: { main: workbooks.main, reordered: workbooks.reordered, restart: restartFile },
    profile: workbooks.profile,
    aliases: { products: { 'PRODUCT-A': fixture.a.id, 'GIFT-G': fixture.gift.id }, people: { 'SELLER-V': fixture.person.id } },
    restartProfile: { sheetName: 'Seguimiento sintético', headerRow: 1, dateFormat: 'ISO', purpose: 'tracking', layout: 'item_rows', oneOrderPerGuide: false, statusMap: { 'Etiqueta sintética': 'label_created' }, columns: headers.map((header, index) => ({ index, header, destination: fields[index] })) },
    ownerFundingReference: 'APORTE-SINTETICO-500',
  };
  ensure((await store.pageOrders()).total === 0, 'business-prepare no debe crear pedidos.');
  for (const table of ['order_collections', 'settlements', 'expenses', 'payroll_periods', 'shipments', 'report_snapshots']) {
    ensure(Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n) === 0, `business-prepare no debe preparar ${table}.`);
  }
  writeFileSync('/artifacts/business.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Preparados únicamente productos A/B/G, persona V, reglas, apertura bancaria explícita y tres Excel SINTÉTICOS. Manifest: /artifacts/business.json.');
}
async function assertBusiness(store) {
  const manifest = JSON.parse(readFileSync('/artifacts/business.json', 'utf8')), { year, ids } = manifest;
  const rows = async table => (await store.db.all(`SELECT * FROM ${store.t(table)}`)).map(entity);
  const checkpointFile = '/artifacts/business-golden.json';
  const checkpoint = existsSync(checkpointFile) ? JSON.parse(readFileSync(checkpointFile, 'utf8')) : null;
  const shipments = await rows('shipments'), restart = shipments.filter(row => row.externalId?.startsWith('RESTART-'));
  ensure(restart.length === (checkpoint ? 60 : 0) && restart.every(row => row.orderId === null), 'Se debe comprobar el corte golden sin guías adicionales y luego exactamente60 guías reanudadas sin venta.');
  const links = (await rows('external_links')).filter(link => link.entityType === 'order' && link.externalKey === 'ORDER-P');
  ensure(links.length === 1, 'ORDER-P debe tener exactamente un vínculo externo de fuente.');
  const order = await store.order(links[0].internalId);
  ensure(order?.totalMinor === 12200000 && order.items.length === 2, 'ORDER-P requiere dos líneas y total 122000 COP.');
  const orderPage = await store.pageOrders();
  ensure(orderPage.total === 2, 'Se requieren exactamente ORDER-P y un pedido nuevo de octubre para comprobar costo30000; reimportar/seguir guías no debe crear otros pedidos.');
  const octoberRow = orderPage.records.find(row => row.id !== order.id);
  const octoberOrder = octoberRow ? await store.order(octoberRow.id) : null;
  ensure(octoberOrder?.placedOn === `${year}-10-01` && ['new', 'preparing'].includes(octoberOrder.status) && octoberOrder.shippingChargeMinor === 0 && octoberOrder.items.length === 1 && octoberOrder.items[0].itemId === ids.productA && octoberOrder.items[0].quantity === 1 && octoberOrder.items[0].unitCostMinor === 3000000, 'El nuevo pedido de octubre debe conservar A×1 con snapshot de costo30000 COP, fecha1octubre y flete0.');
  ensure(octoberOrder.shipments.length === 0 && octoberOrder.collections.length === 0 && octoberOrder.returns.length === 0 && !octoberOrder.recognition?.on, 'El pedido de comprobación de costo debe quedar sin despachar, cobrar, devolver ni reconocer venta.');
  if (checkpoint) ensure(checkpoint.octoberOrderId === octoberOrder.id, 'El reinicio debe conservar el mismo pedido de comprobación de costo de octubre.');
  const a = order.items.find(line => line.itemId === ids.productA), gift = order.items.find(line => line.itemId === ids.gift);
  ensure(a?.quantity === 2 && a.unitCostMinor === 2300000 && gift?.quantity === 1 && gift.unitPriceMinor === 0, 'Cantidades, costo histórico de A u obsequio G incorrectos.');
  const currentA = await store.get('products', ids.productA);
  ensure(currentA.unitCostMinor === 3000000 && currentA.costEffectiveOn === `${year}-10-01`, 'Falta cambio real de costo A a 30000 COP desde octubre.');
  const costs = (await rows('product_costs')).filter(cost => cost.productId === ids.productA);
  ensure(costs.some(cost => cost.effectiveOn === `${year}-08-01` && cost.unitCostMinor === 2300000) && costs.some(cost => cost.effectiveOn === `${year}-10-01` && cost.unitCostMinor === 3000000), 'El cambio de ficha perdió el historial de costos.');
  const collections = (await rows('order_collections')).filter(row => row.orderId === order.id);
  ensure(collections.length === 2 && collections.some(row => row.kind === 'receipt' && row.holder === 'platform' && row.amountMinor === 12200000) && collections.some(row => row.kind === 'refund' && row.amountMinor === 5500000 && row.occurredOn === `${year}-10-03`), 'Recaudo o reembolso duplicado/incorrecto.');
  ensure(order.paymentSummary.netCollectedMinor === 6700000 && order.paymentSummary.platformHeldMinor === 0 && order.paymentSummary.refundDueMinor === 0, 'Resumen de cobro/reembolso/liquidación incorrecto.');
  const returned = order.returns.filter(row => row.kind === 'return');
  ensure(returned.length === 1 && returned[0].occurredOn === `${year}-10-02` && returned[0].lines.length === 1 && returned[0].lines[0].quantity === 1 && returned[0].lines[0].salesCreditMinor === 5500000 && returned[0].lines[0].recoveredCostMinor === 2300000 && returned[0].shippingCreditMinor === 0, 'Devolución comercial no conserva crédito 55000/recuperación 23000 sin crédito de flete.');
  const settlements = (await rows('settlements')).filter(row => row.sourceId === links[0].sourceId);
  const receipts = await rows('settlement_receipts');
  ensure(settlements.length === 1 && settlements[0].state === 'confirmed' && settlements[0].netMinor === 10500000, 'Liquidación declarada no está confirmada por 105000 COP.');
  const receipt = receipts.filter(row => row.settlementId === settlements[0].id);
  ensure(receipt.length === 1 && receipt[0].netMinor === 10500000 && receipt[0].accountId === ids.account && receipt[0].receivedOn === `${year}-09-05`, 'Recepción bancaria incorrecta o duplicada.');
  const expensePayments = await rows('expense_payments');
  ensure(expensePayments.filter(row => row.settlementReceiptId === receipt[0].id).reduce((sum, row) => sum + row.amountMinor, 0) === 1700000, 'Retenciones deben pagar 17000 COP sin segundo egreso bancario.');
  const expenses = await rows('expenses'), commissions = await rows('commission_entries');
  ensure(commissions.length === 2 && commissions.some(row => row.amountMinor === 550000) && commissions.some(row => row.amountMinor === -275000 && row.earnedOn === `${year}-10-02`), 'Comisión original/ajuste posterior debe ser 5500/−2750 COP una vez.');
  const september = await buildBusinessReport(store, { period: 'month', anchorDate: `${year}-09-01` });
  const expected = { netProductSales:11000000, shippingRevenue:1200000, costOfGoods:4600000, giftCost:600000, shippingCosts:1500000, platformFees:200000, commissions:550000, contribution:4750000, fixedSalary:1000000, operatingResult:3750000 };
  for (const [metric, value] of Object.entries(expected)) {
    const actual = september.metrics[metric];
    ensure((checkpoint ? actual.knownValue === value : actual.value === value && actual.complete), `Septiembre: ${metric} debe conservar ${value} centavos conocidos; el corte golden requiere cobertura completa.`);
  }
  const october = await buildBusinessReport(store, { period: 'month', anchorDate: `${year}-10-01` });
  ensure(checkpoint ? october.metrics.contribution.knownValue === -3625000 : october.metrics.contribution.value === -3625000 && october.metrics.contribution.complete, 'Contribución octubre debe conservar −36250 COP conocidos; el corte golden requiere cobertura completa.');
  if (checkpoint) for (const report of [september, october]) {
    const missing = report.metrics.shippingCosts.exclusionReasons.find(reason => reason.code === 'shipment_cost_unknown');
    ensure(missing?.count === 60 && report.metrics.operatingResult.value === null && !report.metrics.operatingResult.complete, 'Las60 guías sin costo deben quedar explícitamente pendientes, nunca ganancia completa ficticia.');
  }
  ensure(expenses.filter(row => row.category === 'salary' && row.personId === ids.person).reduce((sum, row) => sum + row.amountMinor, 0) === 1000000, 'Sueldo septiembre debe devengarse una sola vez por 10000 COP.');
  const ledger = (await rows('cash_entries')).filter(row => row.accountId === ids.account);
  const funding = ledger.filter(row => row.kind === 'income' && row.reference === manifest.ownerFundingReference);
  ensure(funding.length === 1 && funding[0].amountMinor === 50000 && funding[0].concept === 'owner_funding' && funding[0].nonSale === true, 'Falta ingreso real no comercial de 500 COP con referencia APORTE-SINTETICO-500.');
  ensure(await accountBalance(store, ids.account) === 12800000, 'Saldo final debe ser 128000 COP.');
  const original = ledger.filter(row => row.id !== funding[0].id);
  ensure(original.reduce((sum, row) => sum + row.amountMinor, 0) === 12750000, 'Corte original antes del aporte debe conservar 127500 COP.');
  const amounts = { opening:10000000, settlement:10500000, payroll_payment:-1550000, refund:-5500000, expense_payment:-700000 };
  ensure(original.length === Object.keys(amounts).length, 'El escenario tiene movimientos bancarios adicionales o duplicados.');
  for (const [kind, amount] of Object.entries(amounts)) ensure(original.filter(row => row.kind === kind).length === 1 && original.find(row => row.kind === kind).amountMinor === amount, `Movimiento ${kind} debe ser único por ${amount} centavos.`);
  const payrollEntry = original.find(row => row.kind === 'payroll_payment'), returnPayment = original.find(row => row.kind === 'expense_payment');
  ensure(payrollEntry.effectiveOn === `${year}-09-30` && returnPayment.effectiveOn === `${year}-10-03`, 'Fechas reales de pago de sueldo/retorno incorrectas.');
  const accounts = await rows('cash_accounts');
  ensure(accounts.find(row => row.id === ids.account)?.minimumMinor === 12800000, 'Mínimo de cuenta debe conservar 128000 COP.');
  const rules = await rows('alert_rules'), minimumRules = new Set(rules.filter(row => row.type === 'cash_below_minimum').map(row => row.id));
  const minimumAlerts = (await rows('alerts')).filter(row => minimumRules.has(row.ruleId) && row.entityId === ids.account);
  ensure(minimumAlerts.length === 1 && minimumAlerts[0].state === 'resolved' && minimumAlerts[0].episode === 1, 'Saldo bajo debe ser un solo episodio resuelto, no ocultado/duplicado.');
  const audits = await rows('business_audit'), alert = minimumAlerts[0];
  const acknowledged = audits.find(row => row.entityType === 'alert' && row.entityId === alert.id && row.next?.state === 'acknowledged');
  ensure(acknowledged?.next.amountMinor === 12750000 && acknowledged.previous?.minimumMinor === 12800000 && acknowledged.recordedAt <= funding[0].recordedAt, 'Falta evidencia de En atención conservando saldo bajo antes del aporte.');
  ensure(alert.firstSeenAt <= acknowledged.recordedAt && alert.lastSeenAt >= funding[0].recordedAt, 'La resolución debe pertenecer al mismo episodio posterior al aporte.');
  const snapshots = (await rows('report_snapshots')).filter(row => row.period === 'month' && row.startOn === `${year}-09-01` && Object.keys(row.query?.filters || {}).length === 0);
  ensure(snapshots.length >= 1 && new Set(snapshots.map(row => row.factHash)).size === snapshots.length, 'Snapshot septiembre ausente o duplicado por contenido.');
  for (const saved of snapshots) for (const [metric, value] of Object.entries(expected)) ensure(checkpoint ? saved.metrics?.[metric]?.knownValue === value : saved.metrics?.[metric]?.value === value, `Snapshot septiembre alterado: ${metric}.`);
  const immutableSnapshots = await store.db.all(`SELECT id,data FROM ${store.t('report_snapshots')} WHERE period='month' AND start_on=? ORDER BY id`, [`${year}-09-01`]);
  if (checkpoint) for (const original of checkpoint.snapshots) ensure(immutableSnapshots.some(saved => saved.id === original.id && saved.data === original.data), 'El nuevo seguimiento modificó las cifras/hechos de un snapshot histórico inmutable.');
  ensure(snapshots.some(saved => saved.generatedAt <= funding[0].recordedAt && saved.generatedAt >= returnPayment.recordedAt), 'Falta snapshot septiembre generado en el corte real127500, antes del aporte500.');
  const requests = await rows('business_requests');
  ensure(requests.some(request => request.scope === 'report:request' && request.actorId === manifest.actorId && JSON.parse(request.resultJson).anchorDate === `${year}-09-01`), 'El snapshot histórico debe proceder de una solicitud real del administrador.');
  const batches = await rows('import_batches');
  for (const filename of ['pedidos-sinteticos.xlsx', 'pedidos-sinteticos-reordenados.xlsx']) ensure(batches.some(row => row.filename === filename && row.state === 'completed' && row.fileBytesBase64), `Falta importación completa con original retenido: ${filename}.`);
  const restartBatch = batches.filter(row => row.filename === 'seguimiento-SINTETICO-reinicio-60.xlsx');
  ensure(restartBatch.length === 1 && restartBatch[0].state === (checkpoint ? 'completed' : 'queued') && restartBatch[0].fileBytesBase64, 'Lote de reinicio requiere original retenido y estado queued antes/completed después del reinicio.');
  ensure(order.shipments.length === 1 && order.shipments[0].tracking === '0000123456789', 'Reimportar duplicó o perdió la guía principal con ceros iniciales.');
  const events = await rows('shipment_events');
  const mainEvents = events.filter(event => event.shipmentId === order.shipments[0].id);
  ensure(mainEvents.filter(event => event.status === 'collected').length === 1 && mainEvents.find(event => event.status === 'collected').occurredOn === `${year}-09-02` && mainEvents.filter(event => event.status === 'delivered').length === 1 && mainEvents.find(event => event.status === 'delivered').occurredOn === `${year}-09-03`, 'Reimportar debe conservar una sola recogida2septiembre y entrega3septiembre con fechas reales.');
  ensure(restart.every(shipment => events.filter(event => event.shipmentId === shipment.id).length === 1), 'Reanudar duplicó eventos de seguimiento.');
  if (!checkpoint) writeFileSync(checkpointFile, JSON.stringify({ year, orderId:order.id, octoberOrderId:octoberOrder.id, recordedAt:new Date().toISOString(), septemberMetrics:september.metrics, octoberMetrics:october.metrics, snapshots:immutableSnapshots }, null, 2) + '\n', { mode:0o600, flag:'wx' });
  console.log(checkpoint ? 'Corte golden preservado:127500→128000, mismo episodio, snapshots inmutables y60 guías reanudadas sin ventas/dinero duplicados; costos de nuevas guías explícitamente pendientes.' : 'Corte golden real completo:127500→128000, episodio acusado/resuelto, septiembre37500, octubre−36250, costos históricos, retenciones y sueldo verificados antes del seguimiento adicional.');
}

async function rejectConnection(connectionString, ssl, expectedCodes) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString, ssl, connectionTimeoutMillis: 10000 });
  let code;
  try { await client.connect(); }
  catch (error) { code = error.code; }
  finally { await client.end(); }
  ensure(expectedCodes.includes(code), 'La conexión insegura no fue rechazada por el motivo TLS/HBA requerido.');
}

let store;
try {
  ensure(['prepare', 'assert', 'reject-insecure', 'business-prepare', 'business-assert'].includes(command), 'Comando operativo desconocido.');
  ensure(process.env.TEST_ALLOW_DATABASE_RESET === 'allnutrition_test', 'Operación Docker no autorizada para esta base.');
  const config = databaseConfig();
  const allowed = command === 'assert' ? ['allnutrition_test', 'allnutrition_restore'] : ['allnutrition_test'];
  ensure(config.provider === 'supabase' && allowed.includes(new URL(config.url).pathname.slice(1)), 'Operaciones limitadas a la base descartable de prueba/restore.');
  if (command === 'business-prepare') {
    const resetStore = await openStore(testDatabaseEnv(), { migrate: true });
    try {
      await resetPostgresStore(resetStore);
      await createAdmin(resetStore, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    } finally { await resetStore.close(); }
  }
  store = await openStore(process.env, { migrate: true });
  const connection = await store.db.get('SELECT current_database() AS name, current_user AS role, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
  ensure(allowed.includes(connection?.name), 'La base real no coincide con la guarda de prueba/restore.');
  ensure(connection.role === 'allnutrition_app' && connection.ssl === true, 'La operación requiere rol runtime limitado y TLS verificado.');

  if (command === 'business-prepare') {
    await prepareBusiness(store);
  } else if (command === 'business-assert') {
    await assertBusiness(store);
  } else if (command === 'prepare') {
    const session = await login(store, 'e2e@example.test', 'clave-e2e-solo-pruebas');
    const product = await store.save('products', productData({ slug: 'docker-verification', image: '/brand/creatina-vital-force.jpg', price: 55000 }));
    const payload = orderData(product);
    payload.items[0].quantity = 2;
    const order = await store.saveOrder(payload, session.user.id);
    ensure(order.totalMinor === 11900000 && order.subtotalMinor === 11000000 && order.shippingChargeMinor === 900000, 'Total operativo incorrecto: se requieren 11900000 centavos.');
    const counter = await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`);
    const account = await store.db.get(`SELECT id,email,password,active FROM ${store.t('users')} WHERE id=?`, [session.user.id]);
    const snapshot = { product, payload, actor: session.user.id, order, session, account, counter: counter.value, orderCount: (await store.orders()).length, commercial: await commercialSnapshot(store) };
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Snapshot operativo privado creado: pedido de 119000, historial, cuenta, sesión e idempotencia.');
  } else if (command === 'assert') {
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    ensure(isDeepStrictEqual(await store.get('products', snapshot.product.id), snapshot.product), 'El producto persistido difiere del snapshot.');
    ensure(isDeepStrictEqual(await store.order(snapshot.order.id), snapshot.order), 'El pedido, número, versión, total o historial difiere del snapshot.');
    const session = await getSession(store, snapshot.session.token);
    ensure(isDeepStrictEqual(session, { csrf: snapshot.session.csrf, expires: snapshot.session.expires, user: snapshot.session.user }), 'La sesión persistida dejó de ser válida.');
    const account = await store.db.get(`SELECT id,email,password,active FROM ${store.t('users')} WHERE id=?`, [snapshot.actor]);
    ensure(isDeepStrictEqual(account, snapshot.account), 'La cuenta o su contraseña cambió.');
    ensure(isDeepStrictEqual(await store.saveOrder(snapshot.payload, snapshot.actor), snapshot.order), 'Replay no conservó el pedido original.');
    ensure((await store.orders()).length === snapshot.orderCount, 'El número de pedidos cambió o replay duplicó un pedido.');
    ensure((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='orders'`)).value === snapshot.counter, 'El contador de numeración cambió.');
    ensure(isDeepStrictEqual(await commercialSnapshot(store), snapshot.commercial), 'El respaldo comercial v3 cambió: relaciones, centavos, costos, Excel retenidos, informes, auditoría o idempotencia.');
    let denied;
    try { await store.db.exec('CREATE TABLE allnutrition.permission_probe(id int)'); }
    catch (error) { denied = error.code; }
    ensure(denied === '42501', 'El runtime no rechazó CREATE TABLE con 42501.');
    console.log('Persistencia, cuenta, sesión, replay, numeración, historial, TLS y prohibición DDL verificados.');
  } else {
    const url = new URL(config.url);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
    await rejectConnection(url.toString(), { rejectUnauthorized: true, ca: readFileSync('/artifacts/https-ca.crt', 'utf8') }, ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
    await rejectConnection(url.toString(), false, ['28000']);
    console.log('CA equivocada rechazada por cadena TLS; TCP sin TLS rechazado por HBA con 28000.');
  }
} catch (error) {
  // Never dump assertion objects: operational.json includes an active session and password hash.
  console.error(`Verificación operativa falló: ${error.code || error.message}`);
  process.exitCode = 1;
} finally { await store?.close(); }
