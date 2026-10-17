import { fail, integer, text } from '../validation-core.mjs';
import { addDays, bogotaDate, businessDate, BUSINESS_PERIODS, instant, periodBounds } from './dates.mjs';
import { formatMoneyMinor, roundRatio } from './money.mjs';
import { assertLease, entity, hash, insertRow, newId, runCommand, stamp } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, withLeaseHeartbeat } from './job-leases.mjs';
import { effectiveShipmentEvents, effectiveShipmentState, SHIPMENT_STATUSES } from './shipments.mjs';
import { insightDetails } from './insights.mjs';

const ORDER_STATUSES = ['new', 'preparing', 'sent', 'delivered', 'returned', 'cancelled'];
const FILTERS = ['seller', 'product', 'platform', 'carrier', 'status', 'account', 'source'];
const REPORT_VERSION = 1;
const PAGE_SIZE = 20;
const PAYROLL = new Set(['salary', 'commission', 'bonus']);
const expenseMetric = { shipping_out:'shippingCosts', shipping_return:'shippingCosts', platform_fee:'platformFees', commission:'commissions', salary:'fixedSalary', bonus:'bonuses', other:'otherExpenses' };
const specs = {
  netProductSales:['Ventas netas de productos','minor'], shippingRevenue:['Flete cobrado reconocido','minor'],
  costOfGoods:['Costo vendido','minor'], giftCost:['Costo de obsequios gratuitos','minor'], shippingCosts:['Transporte real','minor'],
  platformFees:['Cargos de plataforma','minor'], commissions:['Comisiones ganadas','minor'], fixedSalary:['Sueldo fijo devengado','minor'],
  bonuses:['Bonificaciones','minor'], otherExpenses:['Otros gastos','minor'], grossMargin:['Margen bruto','minor'],
  contribution:['Contribución','minor'], operatingResult:['Resultado operativo registrado','minor'], cashAvailable:['Disponible al corte','minor'],
  onTimeDeliveries:['Entregas a tiempo','bps'], shipmentReturnRate:['Devoluciones de envíos resueltos','bps'],
  recognizedOrders:['Pedidos reconocidos','count'], soldUnits:['Unidades vendidas','count'], giftUnits:['Obsequios despachados','count'],
  returnedUnits:['Unidades devueltas comercialmente','count'], cancelledUnits:['Unidades canceladas','count'],
  customerCollections:['Cobros netos de clientes','minor'], platformPending:['Recaudo pendiente en plataforma al corte','minor'],
  payrollEarned:['Remuneración devengada','minor'], payrollPaid:['Remuneración pagada en el período','minor'], payrollOutstanding:['Remuneración pendiente al corte','minor'],
  shipmentCount:['Guías con actividad','count'], shippedOrders:['Pedidos con actividad logística','count'], transitDays:['Tiempo de tránsito conocido','days'],
  cashClosingDifference:['Diferencia de cierres de caja','minor'],
};
const reasonLabels = {
  recognition_date_unknown:'Venta pendiente de fecha real o de política histórica',
  product_cost_unknown:'Costo histórico de producto pendiente',
  product_cost_and_recognition_date_unknown:'Costo histórico y fecha de venta pendientes',
  gift_cost_unknown:'Costo histórico de obsequio pendiente',
  gift_dispatch_date_unknown:'Fecha real de despacho de obsequio pendiente',
  recovered_cost_unknown:'Costo recuperado de devolución pendiente',
  return_loss_cost_unknown:'Costo de mercancía devuelta antes de reconocimiento pendiente',
  expense_date_unknown:'Fecha real de gasto pendiente',
  expense_cost_unknown:'Costo de gasto pendiente',
  shipment_cost_unknown:'Costo logístico pendiente',
  excel_collection_date_unknown:'Recaudo Excel conocido, con fecha real pendiente y sin movimiento de caja',
  collection_balance_date_unknown:'Saldo histórico de recaudo sin fecha inicial comprobada',
  collection_date_unknown:'Fecha real de cobro pendiente',
  legacy_collection_unreconciled:'Pago histórico declarado, pendiente de conciliación',
  delivery_date_unknown:'Fecha real de entrega pendiente',
  estimated_delivery_unknown:'Fecha estimada de entrega pendiente',
  resolution_date_unknown:'Fecha real de resolución logística pendiente',
  transit_dates_unknown:'Fechas de recogida o entrega pendientes',
  transit_dates_inconsistent:'Entrega anterior a recogida: requiere corrección',
  salary_accrual_pending:'Devengo de sueldo pendiente de actualización automática',
};
const exact = value => {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(result)) fail('El agregado del informe excede el rango entero seguro.');
  return result;
};
const sum = values => exact(values.reduce((total, value) => total + BigInt(value), 0n));
const net = line => exact(BigInt(line.quantity) * BigInt(line.unitPriceMinor) - BigInt(line.discountMinor));
const freeGift = line => line.productType === 'gift' && line.unitPriceMinor === 0;
const on = event => event.occurredOn || (event.occurredAt ? bogotaDate(event.occurredAt) : null);
const days = (start, end) => (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
const index = rows => new Map(rows.map(row => [row.id, row]));
function grouped(rows, key) {
  const result = new Map();
  for (const row of rows) { const id = key(row); if (!result.has(id)) result.set(id, []); result.get(id).push(row); }
  return result;
}

export function normalizeReportQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Consulta del informe no válida.');
  const period = input.period ?? 'month';
  if (!BUSINESS_PERIODS.includes(period)) fail('Período no válido.');
  const asOf = instant(input.asOf ?? stamp(), 'Corte del informe');
  const anchorDate = periodBounds(period, businessDate(input.anchorDate ?? bogotaDate(asOf))).startDate;
  if (input.filters != null && (typeof input.filters !== 'object' || Array.isArray(input.filters))) fail('Filtros no válidos.');
  const filters = {};
  for (const key of FILTERS) {
    const value = input.filters?.[key];
    if (value == null || value === '') continue;
    filters[key] = text(value, key, key === 'carrier' ? 150 : 100, true);
    if (key === 'status' && ![...ORDER_STATUSES, ...SHIPMENT_STATUSES].includes(filters[key])) fail('Estado del informe no válido.');
  }
  return { period, anchorDate, filters, asOf };
}
const queryIdentity = query => ({ period:query.period, ...periodBounds(query.period, query.anchorDate), filters:query.filters });

/** Exact signed largest-remainder allocation. Ties use stable line identities, never input order. */
export function allocateReportAmount(amountMinor, lines) {
  exact(amountMinor);
  if (!lines.length) return [];
  const sales = lines.map(line => Math.max(0, net(line)));
  const weights = sales.some(Boolean) ? sales : lines.map(line => line.quantity);
  const denominator = weights.reduce((n, weight) => n + BigInt(weight), 0n);
  if (denominator <= 0n) fail('La distribución requiere unidades o ventas.');
  const magnitude = BigInt(amountMinor < 0 ? -amountMinor : amountMinor);
  const sign = amountMinor < 0 ? -1 : 1;
  const parts = lines.map((line, i) => ({ lineId:line.lineId, amountMinor:exact(magnitude * BigInt(weights[i]) / denominator), remainder:magnitude * BigInt(weights[i]) % denominator }));
  let remainder = magnitude - parts.reduce((n, part) => n + BigInt(part.amountMinor), 0n);
  for (const part of [...parts].sort((a,b) => a.remainder === b.remainder ? a.lineId.localeCompare(b.lineId) : a.remainder > b.remainder ? -1 : 1)) {
    if (remainder-- <= 0n) break;
    part.amountMinor++;
  }
  return parts.map(({lineId,amountMinor:amount}) => ({lineId,amountMinor:amount === 0 ? 0 : sign * amount}));
}

function json(tx, alias, path) {
  return tx.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${path}')` : `(${alias}.data::jsonb#>>'{${path.split('.').join(',')}}')`;
}
async function readFilterOptions(tx) {
  const carriers = await tx.db.all(`SELECT DISTINCT carrier FROM ${tx.t('shipments')} WHERE carrier<>'' ORDER BY carrier`);
  const statuses = await tx.db.all(`SELECT DISTINCT status FROM ${tx.t('shipments')} UNION SELECT DISTINCT ${json(tx,'o','status')} AS status FROM ${tx.t('orders')} o`);
  return {
    carriers:carriers.map(({carrier}) => ({value:carrier,label:carrier})),
    statuses:statuses.filter(({status}) => [...ORDER_STATUSES,...SHIPMENT_STATUSES].includes(status)).map(({status}) => ({value:status,label:status})).sort((a,b) => a.value.localeCompare(b.value)),
  };
}
const rows = async (tx, table, where = '', values = []) => (await tx.db.all(`SELECT * FROM ${tx.t(table)} ${where}`, values)).map(entity);
async function byIds(tx, table, column, ids) {
  const result = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    result.push(...await rows(tx, table, `WHERE ${column} IN (${batch.map(() => '?').join(',')}) ORDER BY id`, batch));
  }
  return result;
}

// Indexed dated domains select candidate orders; historical JSON recognition is evaluated in SQL.
// There is no orders() scan, per-order query, or write-side reconciliation in this reader.
async function loadDomains(tx, query, bounds) {
  const through = bogotaDate(query.asOf) < bounds.endDateExclusive ? bogotaDate(query.asOf) : addDays(bounds.endDateExclusive, -1);
  const end = through < bounds.startDate ? bounds.startDate : addDays(through, 1);
  const recognition = json(tx,'o','recognition.on');
  const placed = json(tx,'o','placedOn');
  const giftRows = tx.provider === 'sqlite' ? `json_each(o.data,'$.giftDispatches') g` : `jsonb_array_elements(COALESCE(o.data::jsonb->'giftDispatches','[]'::jsonb)) g`;
  const giftOn = tx.provider === 'sqlite' ? `json_extract(g.value,'$.on')` : `g->>'on'`;
  const selected = await tx.db.all(`SELECT o.* FROM ${tx.t('orders')} o WHERE
    (${recognition}>=? AND ${recognition}<?) OR
    (${recognition} IS NULL AND (${placed}<? OR ${placed} IS NULL)) OR
    EXISTS(SELECT 1 FROM ${giftRows} WHERE ${giftOn}>=? AND ${giftOn}<?) OR
    o.id IN (SELECT order_id FROM ${tx.t('order_returns')} WHERE occurred_on>=? AND occurred_on<?) OR
    o.id IN (SELECT COALESCE(e.order_id,s.order_id) FROM ${tx.t('expenses')} e LEFT JOIN ${tx.t('shipments')} s ON s.id=e.shipment_id WHERE (e.incurred_on>=? AND e.incurred_on<?) OR e.incurred_on IS NULL OR (e.category IN ('salary','commission','bonus') AND e.incurred_on<=?)) OR
    o.id IN (SELECT order_id FROM ${tx.t('shipments')} WHERE id IN (SELECT shipment_id FROM ${tx.t('shipment_events')} WHERE (occurred_on>=? AND occurred_on<?) OR (occurred_at>=? AND occurred_at<?) OR (occurred_on IS NULL AND occurred_at IS NULL AND (source_as_of<=? OR source_as_of IS NULL)))) OR
    o.id IN (SELECT order_id FROM ${tx.t('order_collections')} WHERE occurred_on<=? OR occurred_on IS NULL) ORDER BY o.number,o.id`,
  [bounds.startDate,end,end,bounds.startDate,end,bounds.startDate,end,bounds.startDate,end,through,bounds.startDate,end,bounds.startAt,`${end}T05:00:00.000Z`,query.asOf,through]);
  const orders = selected.map(entity);
  const shipments = [...await rows(tx,'shipments','WHERE order_id IS NULL'),...await byIds(tx,'shipments','order_id',orders.map(o => o.id))];
  const events = await byIds(tx,'shipment_events','shipment_id',shipments.map(s => s.id));
  const expenses = await rows(tx,'expenses', `WHERE (incurred_on>=? AND incurred_on<?) OR incurred_on IS NULL OR (category IN ('salary','commission','bonus') AND incurred_on<=?)`,[bounds.startDate,end,through]);
  const collections = await rows(tx,'order_collections',`WHERE occurred_on<=? OR occurred_on IS NULL OR (kind='reversal' AND reversal_of IN (SELECT id FROM ${tx.t('order_collections')} WHERE occurred_on IS NULL))`,[through]);
  const returns = await byIds(tx,'order_returns','order_id',orders.map(o => o.id));
  const cash = await rows(tx,'cash_entries','WHERE effective_on<=?',[through]);
  const receipts = await rows(tx,'settlement_receipts','WHERE received_on<=?',[through]);
  const payments = (await tx.db.all(`SELECT p.*,COALESCE(c.effective_on,r.received_on) AS payment_on,COALESCE(c.account_id,r.account_id) AS payment_account_id FROM ${tx.t('expense_payments')} p LEFT JOIN ${tx.t('cash_entries')} c ON c.id=p.cash_entry_id LEFT JOIN ${tx.t('settlement_receipts')} r ON r.id=p.settlement_receipt_id WHERE COALESCE(c.effective_on,r.received_on)<=?`,[through])).map(entity);
  const offsetCutoff = query.asOf < `${addDays(through,1)}T05:00:00.000Z` ? query.asOf : `${addDays(through,1)}T05:00:00.000Z`;
  const offsets = await rows(tx,'payroll_offsets','WHERE recorded_at<?',[offsetCutoff]);
  const accounts = await rows(tx,'cash_accounts','WHERE opening_on<=?',[through]);
  const closings = await rows(tx,'cash_closings','WHERE closing_on<=? ORDER BY closing_on,revision',[through]);
  const payrollPeriods = await rows(tx,'payroll_periods','WHERE start_on<=?',[through]);
  const people = await rows(tx,'people');
  const completedAt = tx.provider === 'sqlite' ? "json_extract(b.data,'$.completedAt')" : "b.data::jsonb->>'completedAt'";
  const imports = (await tx.db.all(`SELECT b.source_id,${completedAt} AS completed_at,s.name AS source_name,s.platform_id,p.name AS platform_name FROM ${tx.t('import_batches')} b JOIN ${tx.t('platform_sources')} s ON s.id=b.source_id JOIN ${tx.t('platforms')} p ON p.id=s.platform_id WHERE b.state IN ('completed','completed_with_errors','expired')`)).map(entity);
  const sources = (await tx.db.all(`SELECT s.id,s.name,s.platform_id,p.name AS platform_name FROM ${tx.t('platform_sources')} s JOIN ${tx.t('platforms')} p ON p.id=s.platform_id`)).map(entity);
  const filterOptions = await readFilterOptions(tx);
  const revision = exact(Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`))?.value ?? 0));
  return {orders,shipments,events,expenses,collections,returns,cash,receipts,payments,offsets,accounts,closings,payrollPeriods,people,imports,sources,filterOptions,revision,through,end};
}

function minimalOrder(order) {
  return {orderId:order.id,orderNumber:Number(order.number),sellerId:order.sellerId || null,sellerLabel:order.sellerId ? order.sellerSnapshot?.name || 'Nombre histórico sin registrar' : 'Sin vendedor',ruleVersionId:order.recognition?.ruleVersionId || order.ruleSnapshot?.id || null};
}
function lineFields(order,line) { return {...minimalOrder(order),lineId:line.lineId,productId:line.itemId,productKind:line.kind,productLabel:line.title,productType:line.productType}; }
function freshness(domain, query) {
  const sources = new Map(), throughOn = bogotaDate(query.asOf);
  const precisionRank = {unknown:0,day:1,instant:2};
  const update = (id, fields) => {
    if (!id) return;
    const old = sources.get(id) || {sourceId:id,platformId:null,sourceName:null,platformName:null,importedAt:null,sourceAsOf:null,precision:null,sourceDate:null};
    for (const key of ['sourceName','platformId','platformName']) if (fields[key] != null) old[key] = fields[key];
    if (fields.importedAt && (!old.importedAt || fields.importedAt > old.importedAt)) old.importedAt = fields.importedAt;
    if (fields.sourceAsOf) {
      const precision = fields.precision || 'unknown';
      const sourceDate = fields.sourceDate || bogotaDate(fields.sourceAsOf);
      const withinCut = precision === 'instant' ? fields.sourceAsOf <= query.asOf : sourceDate <= throughOn;
      if (withinCut && (!old.sourceAsOf || fields.sourceAsOf > old.sourceAsOf || fields.sourceAsOf === old.sourceAsOf && precisionRank[precision] > (precisionRank[old.precision] ?? -1))) {
        old.sourceAsOf = fields.sourceAsOf;
        old.precision = precision;
        old.sourceDate = sourceDate;
      }
    }
    sources.set(id,old);
  };
  for (const batch of domain.imports) update(batch.sourceId,{sourceName:batch.sourceName,platformId:batch.platformId,platformName:batch.platformName,importedAt:batch.completedAt || null});
  for (const shipment of domain.shipments) {
    const cuts = Object.entries(shipment.sourceCuts || {});
    if (!cuts.length) update(shipment.sourceId,{platformId:shipment.platformId,sourceAsOf:shipment.sourceAsOf});
    for (const [sourceId,cut] of cuts) update(sourceId,{platformId:shipment.platformId,sourceAsOf:cut.sourceAsOf,precision:cut.precision,sourceDate:cut.precision === 'day' ? cut.value : null});
    for (const observation of Object.values(shipment.costObservations || {})) update(observation.sourceId || shipment.sourceId,{sourceAsOf:observation.sourceAsOf});
  }
  for (const collection of domain.collections) update(collection.sourceId,{sourceAsOf:collection.sourceAsOf});
  for (const source of domain.sources) if (sources.has(source.id)) update(source.id,{sourceName:source.name,platformId:source.platformId,platformName:source.platformName});
  return [...sources.values()].filter(source => (!query.filters.source || source.sourceId === query.filters.source) && (!query.filters.platform || source.platformId === query.filters.platform)).sort((a,b) => a.sourceId.localeCompare(b.sourceId));
}

export function buildBusinessReport(store, input = {}) {
  return store.readSnapshot(tx => buildBusinessReportTx(tx,input));
}
// Composable read-only projection; the caller must already hold readSnapshot.
// A shorter bound is only for completed-day comparison, never snapshot identity.
export async function buildBusinessReportTx(tx, input = {}, {endDateExclusive} = {}) {
  const query = normalizeReportQuery(input), bounds = periodBounds(query.period,query.anchorDate);
  if (endDateExclusive != null) {
    const end = businessDate(endDateExclusive);
    if (end <= bounds.startDate || end > bounds.endDateExclusive) fail('Fin del tramo de comparación no válido.');
    bounds.endDateExclusive=end;bounds.endAt=`${end}T05:00:00.000Z`;
  }
  const eventCut=endDateExclusive!=null&&query.asOf>=bounds.endAt?new Date(Date.parse(bounds.endAt)-1).toISOString():query.asOf;
  return calculateReport(await loadDomains(tx,query,bounds),query,bounds,eventCut);
}

function calculateReport(domain, query, bounds, eventCut) {
  const {filters} = query;
  const inPeriod = date => !!date && date >= bounds.startDate && date < domain.end && date < bounds.endDateExclusive;
  const beforeCut = date => !!date && date <= domain.through;
  const ordersById = index(domain.orders), shipmentsById = index(domain.shipments), cashById = index(domain.cash);
  const eventsByShipment = grouped(domain.events,event => event.shipmentId);
  const effective = new Map(domain.shipments.map(shipment => {
    const events = eventsByShipment.get(shipment.id) || [];
    // Timeless observations explain coverage only; never borrow recordedAt as an occurrence.
    const timeless = effectiveShipmentEvents(events).filter(event => !event.occurredAt && !event.occurredOn && !event.sourceAsOf);
    const undated=effectiveShipmentEvents(events,{asOf:query.asOf}).filter(event=>!event.occurredAt&&!event.occurredOn);
    const dated=effectiveShipmentEvents(events,{asOf:eventCut}).filter(event=>event.occurredAt||event.occurredOn);
    return [shipment.id,effectiveShipmentEvents([...timeless,...undated,...dated])];
  }));
  const states = new Map(domain.shipments.map(shipment => [shipment.id,effectiveShipmentState(effective.get(shipment.id))]));
  const shipmentScope = shipment => (!filters.platform || shipment.platformId === filters.platform) && (!filters.source || shipment.sourceId === filters.source) && (!filters.carrier || shipment.carrier === filters.carrier);
  const shipmentMatches = shipment => shipmentScope(shipment) && (!filters.status || !SHIPMENT_STATUSES.includes(filters.status) || states.get(shipment.id) === filters.status);
  const hasShipmentFilter = !!(filters.platform || filters.source || filters.carrier || filters.status && !ORDER_STATUSES.includes(filters.status));
  const shipmentsByOrder = grouped(domain.shipments,s => s.orderId);
  const lineMatches = line => !!line && (!filters.product || line.itemId === filters.product || (line.components || []).some(component => component.productId === filters.product));
  const orderScope = order => (!filters.seller || order.sellerId === filters.seller) && order.items.some(lineMatches);
  const orderMatches = order => orderScope(order) && (!filters.status || !ORDER_STATUSES.includes(filters.status) || order.status === filters.status) && (!hasShipmentFilter || (shipmentsByOrder.get(order.id) || []).some(shipmentMatches));
  const selectedOrders = domain.orders.filter(orderMatches), selectedIds = new Set(selectedOrders.map(o => o.id));
  // Shared status words apply independently: a physical return need not be a commercial return.
  const selectedShipments = domain.shipments.filter(shipment => shipmentMatches(shipment) && (shipment.orderId ? orderScope(ordersById.get(shipment.orderId)) && (!filters.status || SHIPMENT_STATUSES.includes(filters.status) || ordersById.get(shipment.orderId).status === filters.status) : !filters.seller && !filters.product && (!filters.status || SHIPMENT_STATUSES.includes(filters.status))));
  const shipmentIds = new Set(selectedShipments.map(s => s.id));
  const facts = Object.fromEntries(Object.keys(specs).map(key => [key,[]]));
  const add = (metric, fact) => {
    const known = fact.value != null && fact.known !== false;
    facts[metric].push({unit:specs[metric][1],...fact,known,value:known ? exact(fact.value) : null});
  };
  const financialFact = (metric, source, value, extra = {}) => add(metric,{id:`${metric}:${source.id}:${extra.lineId || ''}`,entityType:source.entityType || 'order',entityId:source.entityId || source.id,label:specs[metric][0],occurredOn:null,value,...extra});
  const returnsByOrder = grouped(domain.returns.filter(r => beforeCut(r.occurredOn)),r => r.orderId);
  const rules = new Map();
  for (const order of selectedOrders) {
    const base = minimalOrder(order), recognitionOn = order.recognition?.on;
    if (order.ruleSnapshot) rules.set(hash(order.ruleSnapshot), {
      id:order.ruleSnapshot.id,effectiveOn:order.ruleSnapshot.effectiveOn,saleRecognition:order.ruleSnapshot.saleRecognition,
      shippingExpenseDate:order.ruleSnapshot.shippingExpenseDate,returnExpenseDate:order.ruleSnapshot.returnExpenseDate,platformFeeExpenseDate:order.ruleSnapshot.platformFeeExpenseDate,commission:order.ruleSnapshot.commission,
    });
    const documents = returnsByOrder.get(order.id) || [];
    const pendingRecognition = !recognitionOn && (order.policyReviewRequired || order.legacyPolicyReview || ['sent','delivered','returned'].includes(order.status) && (order.ruleSnapshot?.saleRecognition !== 'delivered' || order.deliverySummary?.complete));
    if (inPeriod(recognitionOn)) financialFact('recognizedOrders',order,1,{...base,occurredOn:recognitionOn,basis:order.recognition.basis});
    else if (pendingRecognition) financialFact('recognizedOrders',order,null,{...base,reason:'recognition_date_unknown'});
    for (const line of order.items.filter(lineMatches)) {
      const fields = lineFields(order,line), source = {id:`${order.id}:${line.lineId}`,entityId:order.id};
      const returned = documents.flatMap(document => (document.lines || []).filter(r => r.lineId === line.lineId).map(r => ({...r,document})));
      const pre = returned.filter(r => recognitionOn && (r.document.occurredOn < recognitionOn || r.document.occurredOn === recognitionOn && r.unrecognizedCostQuantity > 0));
      if (!freeGift(line)) {
        if (inPeriod(recognitionOn)) {
          const quantity = line.quantity - sum(pre.map(r => r.unrecognizedCostQuantity ?? r.quantity));
          financialFact('netProductSales',source,net(line)-sum(pre.map(r => r.salesCreditMinor)),{...fields,occurredOn:recognitionOn,quantity,unitPriceMinor:line.unitPriceMinor,discountMinor:line.discountMinor,basis:order.recognition.basis});
          financialFact('soldUnits',source,quantity,{...fields,occurredOn:recognitionOn});
          if (quantity) financialFact('costOfGoods',source,line.unitCostMinor == null ? null : exact(BigInt(quantity)*BigInt(line.unitCostMinor)),{...fields,occurredOn:recognitionOn,quantity,unitCostMinor:line.unitCostMinor,reason:line.unitCostMinor == null ? 'product_cost_unknown' : null});
        } else if (pendingRecognition) {
          financialFact('netProductSales',source,null,{...fields,amountMinor:net(line),reason:'recognition_date_unknown'});
          financialFact('costOfGoods',source,null,{...fields,reason:line.unitCostMinor == null ? 'product_cost_and_recognition_date_unknown' : 'recognition_date_unknown'});
        }
      } else {
        const dispatches = (order.giftDispatches || []).filter(fact => fact.lineId === line.lineId && inPeriod(fact.on));
        for (const dispatch of dispatches) {
          const dispatchSource = {...source,id:`${source.id}:${dispatch.eventId || dispatch.shipmentId}:${dispatch.on}`};
          financialFact('giftCost',dispatchSource,line.unitCostMinor == null ? null : exact(BigInt(dispatch.quantity)*BigInt(line.unitCostMinor)),{...fields,occurredOn:dispatch.on,shipmentId:dispatch.shipmentId,quantity:dispatch.quantity,unitCostMinor:line.unitCostMinor,reason:line.unitCostMinor == null ? 'gift_cost_unknown' : null});
          financialFact('giftUnits',dispatchSource,dispatch.quantity,{...fields,occurredOn:dispatch.on,shipmentId:dispatch.shipmentId});
        }
        const knownDispatched = sum((order.giftDispatches || []).filter(fact => fact.lineId === line.lineId && beforeCut(fact.on)).map(fact => fact.quantity));
        const orderShipments = shipmentsByOrder.get(order.id) || [];
        const observedQuantity = sum(orderShipments.filter(shipment => effective.get(shipment.id).some(event => ['collected','in_transit','out_for_delivery','delivered','return_in_transit','returned'].includes(event.status))).flatMap(shipment => (shipment.assignments || []).filter(assignment => assignment.lineId === line.lineId).map(assignment => assignment.quantity)));
        const expectedDispatched = Math.min(line.quantity,orderShipments.length ? observedQuantity : ['sent','delivered'].includes(order.status) ? line.quantity : 0);
        if (expectedDispatched > knownDispatched) financialFact('giftCost',source,null,{...fields,quantity:expectedDispatched-knownDispatched,reason:'gift_dispatch_date_unknown'});
      }
      for (const returnedLine of returned) {
        const document = returnedLine.document;
        if (!inPeriod(document.occurredOn)) continue;
        const returnSource = {id:`${document.id}:${line.lineId}`,entityId:document.id,entityType:'order_return'};
        const details = {...fields,returnId:document.id,occurredOn:document.occurredOn,condition:returnedLine.condition,quantity:returnedLine.quantity,kind:document.kind};
        financialFact(document.kind === 'cancellation' ? 'cancelledUnits' : 'returnedUnits',returnSource,returnedLine.quantity,details);
        if (recognitionOn && recognitionOn <= document.occurredOn && !pre.includes(returnedLine) && !freeGift(line)) financialFact('netProductSales',returnSource,-returnedLine.salesCreditMinor,details);
        const recognizedQuantity = returnedLine.recognizedCostQuantity ?? (freeGift(line) ? Math.min(returnedLine.quantity,sum((order.giftDispatches || []).filter(d => d.lineId === line.lineId && d.on <= document.occurredOn).map(d => d.quantity))) : recognitionOn && recognitionOn <= document.occurredOn ? returnedLine.quantity : 0);
        if (recognizedQuantity) {
          const recovery = returnedLine.condition === 'non_recoverable' ? 0 : returnedLine.recoveredCostMinor == null ? null : roundRatio(BigInt(returnedLine.recoveredCostMinor)*BigInt(recognizedQuantity),BigInt(returnedLine.quantity));
          financialFact(freeGift(line) ? 'giftCost' : 'costOfGoods',returnSource,recovery == null ? null : -recovery,{...details,recognizedCostQuantity:recognizedQuantity,recoveredCostMinor:recovery,reason:recovery == null ? 'recovered_cost_unknown' : null});
        }
        const unrecognized = returnedLine.unrecognizedCostQuantity ?? returnedLine.quantity-recognizedQuantity;
        // The domain writes known pre-recognition nonrecoverable losses as expenses.
        // Unknown losses have no invented zero expense row, so retain explicit coverage here.
        if (unrecognized && line.unitCostMinor == null && document.kind !== 'cancellation') financialFact('otherExpenses',returnSource,null,{...details,reason:'return_loss_cost_unknown'});
      }
    }
    if (inPeriod(recognitionOn)) {
      const preCredits = documents.filter(r => r.occurredOn < recognitionOn);
      const amount = order.shippingChargeMinor - sum(preCredits.map(r => r.shippingCreditMinor || 0));
      allocateShared('shippingRevenue',order,amount,{occurredOn:recognitionOn,...base});
    } else if (pendingRecognition && order.shippingChargeMinor) allocateShared('shippingRevenue',order,null,{...base,reason:'recognition_date_unknown'});
    for (const document of documents.filter(r => inPeriod(r.occurredOn) && recognitionOn && recognitionOn <= r.occurredOn)) if (document.shippingCreditMinor) allocateShared('shippingRevenue',order,-document.shippingCreditMinor,{...base,entityType:'order_return',entityId:document.id,referenceId:document.id,occurredOn:document.occurredOn});
  }

  // The charge is one financial fact; its exact line shares belong only to product grouping.
  function allocateShared(metric, order, amount, fields) {
    const allocationBasis=order.items.some(line=>net(line)>0)?'net_products':'units';
    const allocation=amount==null?order.items.map(line=>({lineId:line.lineId,amountMinor:allocationBasis==='net_products'&&net(line)===0?0:null})):allocateReportAmount(amount,order.items);
    const lines=new Map(order.items.map(line=>[line.lineId,line]));
    const parts=[];
    for (const part of allocation) {
      const line=lines.get(part.lineId);
      if (!lineMatches(line)) continue;
      parts.push({...lineFields(order,line),quantity:line.quantity,unitPriceMinor:line.unitPriceMinor,discountMinor:line.discountMinor,value:part.amountMinor,known:part.amountMinor!=null});
    }
    if (!parts.length) return;
    const value=parts.some(part=>!part.known)?null:sum(parts.map(part=>part.value));
    financialFact(metric,{id:fields.referenceId || order.id},value,{...minimalOrder(order),...fields,reason:value==null?fields.reason:null,originalAmountMinor:amount,allocationBasis,allocations:parts});
  }

  const paymentsByExpense = grouped(domain.payments,p => p.expenseId);
  const reversedOffsets = new Set(domain.offsets.map(o => o.reversalOf).filter(Boolean));
  const activeOffsets = domain.offsets.filter(o => !o.reversalOf && !reversedOffsets.has(o.id));
  const expenses = domain.expenses.filter(expense => {
    const orderId = expense.orderId || shipmentsById.get(expense.shipmentId)?.orderId;
    return (!orderId || selectedIds.has(orderId)) && (!expense.shipmentId || !hasShipmentFilter || shipmentIds.has(expense.shipmentId)) && (orderId || !(filters.product || hasShipmentFilter)) && (!filters.seller || (orderId ? selectedIds.has(orderId) : expense.personId === filters.seller));
  });
  const costGroups = [], payrollGroups = new Map();
  const people = index(domain.people);
  const payrollGroup = personId => {
    if (!payrollGroups.has(personId)) payrollGroups.set(personId,{id:personId || 'unassigned',label:people.get(personId)?.name || 'Sin asignar',earnedMinor:0,paidMinor:0,outstandingMinor:0,advanceMinor:0,creditMinor:0});
    return payrollGroups.get(personId);
  };
  for (const expense of expenses) {
    const order = ordersById.get(expense.orderId || shipmentsById.get(expense.shipmentId)?.orderId);
    const payments = paymentsByExpense.get(expense.id) || [];
    const paidMinor = sum(payments.map(p => p.amountMinor));
    const offsetMinor = sum(activeOffsets.filter(o => o.debitExpenseId === expense.id || o.creditExpenseId === expense.id).map(o => o.debitExpenseId === expense.id ? o.amountMinor : -o.amountMinor));
    const remaining = exact(expense.amountMinor-paidMinor-offsetMinor);
    const fields = {...(order ? minimalOrder(order) : {}),shipmentId:expense.shipmentId,expenseId:expense.id,category:expense.category,occurredOn:expense.incurredOn,dateSource:expense.dateSource || null,sourceAsOf:expense.sourceAsOf || null,sourceId:expense.sourceId || null,amountMinor:expense.amountMinor};
    if (inPeriod(expense.incurredOn) || !expense.incurredOn) {
      const amount = !expense.incurredOn || expense.costPending ? null : expense.amountMinor;
      const details = {...fields,entityType:'expense',entityId:expense.id,referenceId:expense.id,reason:!expense.incurredOn ? 'expense_date_unknown' : expense.costPending ? 'expense_cost_unknown' : null};
      if (order && ['shippingCosts','platformFees','commissions'].includes(expenseMetric[expense.category])) allocateShared(expenseMetric[expense.category],order,amount,details);
      else financialFact(expenseMetric[expense.category],{id:expense.id,entityType:'expense'},amount,details);
      costGroups.push({id:expense.id,category:expense.category,label:expense.concept || specs[expenseMetric[expense.category]][0],orderId:order?.id || null,orderNumber:order?.number || null,shipmentId:expense.shipmentId,occurredOn:expense.incurredOn,amountMinor:expense.amountMinor,paidMinor,outstandingMinor:Math.max(0,remaining),creditMinor:Math.max(0,-remaining)});
    }
    if (PAYROLL.has(expense.category)) {
      const group = payrollGroup(expense.personId);
      if (inPeriod(expense.incurredOn) || !expense.incurredOn) {
        financialFact('payrollEarned',{id:expense.id,entityType:'expense'},expense.incurredOn ? expense.amountMinor : null,{...fields,personId:expense.personId,reason:expense.incurredOn ? null : 'expense_date_unknown'});
        if (expense.incurredOn) group.earnedMinor = exact(group.earnedMinor+expense.amountMinor);
      }
      for (const payment of payments.filter(p => inPeriod(p.paymentOn) && (!filters.account || p.paymentAccountId === filters.account))) {
        financialFact('payrollPaid',{id:payment.id,entityType:'expense_payment'},payment.amountMinor,{...fields,occurredOn:payment.paymentOn,personId:expense.personId,cashEntryId:payment.cashEntryId,settlementReceiptId:payment.settlementReceiptId,advance:!!payment.advance});
        group.paidMinor = exact(group.paidMinor+payment.amountMinor);
        if (payment.advance) group.advanceMinor = exact(group.advanceMinor+payment.amountMinor);
      }
      if (beforeCut(expense.incurredOn)) {
        financialFact('payrollOutstanding',{id:expense.id,entityType:'expense'},Math.max(0,remaining),{...fields,personId:expense.personId,paidMinor,offsetMinor,creditMinor:Math.max(0,-remaining)});
        group.outstandingMinor = exact(group.outstandingMinor+Math.max(0,remaining));
        group.creditMinor = exact(group.creditMinor+Math.max(0,-remaining));
      } else if (!expense.incurredOn) {
        financialFact('payrollOutstanding',{id:expense.id,entityType:'expense'},null,{...fields,personId:expense.personId,reason:'expense_date_unknown'});
        group.complete = false;
      }
    }
  }
  // Missing scheduled accruals are coverage gaps, not zero salary or reader-side writes.
  if (!filters.product && !hasShipmentFilter) for (const person of domain.people.filter(p => !filters.seller || p.id === filters.seller)) {
    const existingDates = new Set(domain.expenses.filter(e => e.personId === person.id && e.category === 'salary' && e.agreementId).map(e => e.incurredOn));
    const completedThrough = addDays(bogotaDate(query.asOf),-1);
    for (const agreement of person.salaryAgreements || []) {
      if (agreement.enabled === false) continue;
      const start = agreement.effectiveFrom > bounds.startDate ? agreement.effectiveFrom : bounds.startDate;
      const finish = [agreement.effectiveTo || domain.through,domain.through,completedThrough].sort()[0];
      for (let date = start; date <= finish; date = addDays(date,1)) {
        if (existingDates.has(date) || domain.payrollPeriods.some(p => p.personId === person.id && p.startOn <= date && p.endOnExclusive > date)) continue;
        const fields = {personId:person.id,agreementId:agreement.id,occurredOn:date,reason:'salary_accrual_pending'};
        const source = {id:`${person.id}:${agreement.id}:${date}`,entityType:'person',entityId:person.id};
        financialFact('fixedSalary',source,null,fields);
        financialFact('payrollEarned',source,null,fields);
        financialFact('payrollOutstanding',source,null,fields);
        payrollGroup(person.id).complete = false;
      }
    }
  }

  for (const shipment of selectedShipments) {
    const order = ordersById.get(shipment.orderId), events = effective.get(shipment.id);
    const activity = events.some(event => inPeriod(on(event))) || !!order && inPeriod(order.recognition?.on);
    const undated = events.some(event => !on(event));
    if (!activity && !undated) continue;
    const statuses = {...shipment.costStatuses};
    if (!Object.hasOwn(statuses,'shipping_out')) statuses.shipping_out = shipment.costStatus === 'known' ? 'known' : 'unknown';
    for (const [category,status] of Object.entries(statuses)) {
      if (status !== 'unknown') continue;
      const fields = {shipmentId:shipment.id,tracking:shipment.tracking,sourceId:shipment.sourceId,sourceAsOf:shipment.sourceAsOf,reason:'shipment_cost_unknown',entityType:'shipment',entityId:shipment.id,referenceId:`${shipment.id}:${category}`,category};
      if (order) allocateShared(expenseMetric[category] || 'shippingCosts',order,null,fields);
      else financialFact(expenseMetric[category] || 'shippingCosts',{id:`${shipment.id}:${category}`,entityType:'shipment'},null,fields);
    }
  }

  const collectionById = index(domain.collections);
  const collectionSign = (collection, seen = new Set()) => {
    if (collection.kind !== 'reversal') return collection.kind === 'refund' ? -1 : 1;
    if (seen.has(collection.id) || !collectionById.has(collection.reversalOf)) fail('Reversión de cobro sin origen válido.');
    seen.add(collection.id);
    return -collectionSign(collectionById.get(collection.reversalOf),seen);
  };
  // Annulment of an undated observation corrects its existence, not a dated cash
  // receipt. Retain both ledger rows for audit; neither can pollute any period.
  const undatedVoids=new Set(domain.collections.filter(c=>c.reversalOf&&collectionById.has(c.reversalOf)&&!collectionById.get(c.reversalOf).occurredOn).flatMap(c=>[c.id,c.reversalOf]));
  const matchingCollections = domain.collections.filter(collection => !undatedVoids.has(collection.id) && selectedIds.has(collection.orderId) && (!hasShipmentFilter || shipmentIds.has(collection.shipmentId)));
  const settledByCollection=new Map();
  for(const receipt of domain.receipts)for(const line of receipt.lines||receipt.allocations||[]){
    settledByCollection.set(line.collectionId,(settledByCollection.get(line.collectionId)||0n)+(receipt.reversalOf?-1n:1n)*BigInt(line.grossMinor));
  }
  for (const collection of matchingCollections) {
    const order = ordersById.get(collection.orderId), value = exact(collectionSign(collection)*collection.amountMinor);
    const fields = {...minimalOrder(order),shipmentId:collection.shipmentId,holder:collection.holder,sourceId:collection.sourceId || null,sourceAsOf:collection.sourceAsOf || null,occurredOn:collection.occurredOn,cashEntryId:collection.cashEntryId};
    const legacyReview = collection.holder === 'legacy' && collection.requiresReconciliation !== false;
    if (inPeriod(collection.occurredOn) || !collection.occurredOn) financialFact('customerCollections',{id:collection.id,entityType:'collection'},collection.occurredOn && !legacyReview ? value : null,{...fields,amountMinor:value,reason:legacyReview ? 'legacy_collection_unreconciled' : collection.occurredOn ? null : collection.requiresDateReview ? 'excel_collection_date_unknown' : 'collection_date_unknown'});
    if (collection.holder === 'platform') {
      const knownBalance=Boolean(collection.occurredOn || collection.sourceAsOf&&bogotaDate(collection.sourceAsOf)<=domain.through || (settledByCollection.get(collection.id)||0n)>=BigInt(collection.amountMinor));
      financialFact('platformPending',{id:collection.id,entityType:'collection'},knownBalance?value:null,{...fields,amountMinor:value,undated:!collection.occurredOn,reason:knownBalance?null:'collection_balance_date_unknown'});
    }
  }
  const selectedCollections = new Set(matchingCollections.filter(c => c.holder === 'platform').map(c => c.id));
  for (const receipt of domain.receipts) {
    const sign = receipt.reversalOf ? -1 : 1;
    for (const line of receipt.lines || receipt.allocations || []) if (selectedCollections.has(line.collectionId)) {
      const collection = collectionById.get(line.collectionId), order = ordersById.get(collection.orderId);
      financialFact('platformPending',{id:`${receipt.id}:${line.collectionId}`,entityId:receipt.id,entityType:'settlement_receipt'},-sign*line.grossMinor,{...minimalOrder(order),shipmentId:collection.shipmentId,collectionId:collection.id,occurredOn:receipt.receivedOn});
    }
  }

  const accountGroups = [];
  for (const account of domain.accounts.filter(a => !filters.account || a.id === filters.account)) {
    const entries = domain.cash.filter(entry => entry.accountId === account.id);
    const openingMinor = sum(entries.filter(e => e.effectiveOn < bounds.startDate).map(e => e.amountMinor));
    const periodEntries = entries.filter(e => inPeriod(e.effectiveOn));
    const rootKind = entry => entry.reversalOf ? cashById.get(entry.reversalOf)?.kind || entry.kind : entry.kind;
    const closing = domain.closings.filter(c => c.accountId === account.id).at(-1);
    const group = {id:account.id,label:account.name,openingMinor,openingEntriesMinor:0,inflowMinor:0,outflowMinor:0,transferMinor:0,balanceMinor:sum(entries.map(e => e.amountMinor)),breakdown:{},closing:closing ? {id:closing.id,closingOn:closing.closingOn,revision:closing.revision,state:closing.state,expectedMinor:closing.expectedMinor,countedMinor:closing.countedMinor,differenceMinor:closing.differenceMinor} : null};
    for (const entry of periodEntries) {
      const kind = rootKind(entry);
      group.breakdown[kind] = exact((group.breakdown[kind] || 0)+entry.amountMinor);
      if (rootKind(entry) === 'opening') group.openingEntriesMinor = exact(group.openingEntriesMinor+entry.amountMinor);
      else if (rootKind(entry) === 'transfer') group.transferMinor = exact(group.transferMinor+entry.amountMinor);
      else if (entry.amountMinor > 0) group.inflowMinor = exact(group.inflowMinor+entry.amountMinor);
      else group.outflowMinor = exact(group.outflowMinor-entry.amountMinor);
    }
    for (const entry of entries) financialFact('cashAvailable',{id:entry.id,entityType:'cash_entry'},entry.amountMinor,{accountId:account.id,accountLabel:account.name,occurredOn:entry.effectiveOn,kind:entry.kind,sourceType:entry.sourceType,sourceId:entry.sourceId,transferId:entry.transferId,reversalOf:entry.reversalOf});
    for (const closing of domain.closings.filter(c => c.accountId === account.id && c.state === 'closed' && inPeriod(c.closingOn))) financialFact('cashClosingDifference',{id:closing.id,entityType:'cash_closing'},closing.differenceMinor,{accountId:account.id,accountLabel:account.name,occurredOn:closing.closingOn,revision:closing.revision,expectedMinor:closing.expectedMinor,countedMinor:closing.countedMinor});
    accountGroups.push(group);
  }

  const shipmentGroups = [], logisticOrders = new Set();
  for (const shipment of selectedShipments) {
    const events = effective.get(shipment.id), state = states.get(shipment.id), order = ordersById.get(shipment.orderId);
    const dateOf = status => events.filter(event => event.status === status).map(on).filter(Boolean).sort()[0] || null;
    const deliveredOn = dateOf('delivered'), returnedOn = dateOf('returned'), collectedOn = dateOf('collected');
    const finalEvents = events.filter(event => event.status === state);
    const resolutionOn = [...finalEvents].reverse().map(on).find(Boolean) || null;
    const undatedResolution = ['delivered','returned'].includes(state) && !resolutionOn;
    const activity = events.some(event => inPeriod(on(event))) || undatedResolution;
    if (!activity) continue;
    const fields = {shipmentId:shipment.id,orderId:shipment.orderId,orderNumber:order?.number || null,tracking:shipment.tracking,carrier:shipment.carrier,status:state,sourceId:shipment.sourceId,sourceAsOf:shipment.sourceAsOf};
    financialFact('shipmentCount',{id:shipment.id,entityType:'shipment'},1,fields);
    if (shipment.orderId) logisticOrders.add(shipment.orderId);
    if (inPeriod(deliveredOn) || state === 'delivered' && !deliveredOn) financialFact('onTimeDeliveries',{id:shipment.id,entityType:'shipment'},deliveredOn && shipment.estimatedDeliveryOn ? Number(deliveredOn <= shipment.estimatedDeliveryOn) : null,{...fields,occurredOn:deliveredOn,estimatedDeliveryOn:shipment.estimatedDeliveryOn || null,reason:!deliveredOn ? 'delivery_date_unknown' : !shipment.estimatedDeliveryOn ? 'estimated_delivery_unknown' : null});
    if (['delivered','returned'].includes(state) && (inPeriod(resolutionOn) || undatedResolution)) financialFact('shipmentReturnRate',{id:shipment.id,entityType:'shipment'},resolutionOn ? Number(state === 'returned') : null,{...fields,occurredOn:resolutionOn,reason:resolutionOn ? null : 'resolution_date_unknown'});
    const transitDays = collectedOn && deliveredOn ? days(collectedOn,deliveredOn) : null;
    if (inPeriod(deliveredOn) || state === 'delivered' && !deliveredOn) financialFact('transitDays',{id:shipment.id,entityType:'shipment'},transitDays != null && transitDays >= 0 ? transitDays : null,{...fields,occurredOn:deliveredOn,collectedOn,reason:transitDays == null ? 'transit_dates_unknown' : transitDays < 0 ? 'transit_dates_inconsistent' : null});
    shipmentGroups.push({id:shipment.id,...fields,labelCreatedOn:dateOf('label_created'),collectedOn,deliveredOn,returnedOn,estimatedDeliveryOn:shipment.estimatedDeliveryOn || null,transitDays:transitDays != null && transitDays >= 0 ? transitDays : null});
  }
  for (const orderId of logisticOrders) financialFact('shippedOrders',{id:orderId},1,minimalOrder(ordersById.get(orderId)));

  const derive = (key, terms) => {
    for (const [metric,sign] of terms) for (const fact of facts[metric]) {
      const allocations=sign===1?fact.allocations:fact.allocations?.map(part=>({...part,value:part.known?sign*part.value:null}));
      add(key,{...fact,id:`${key}:${fact.id}`,componentMetric:metric,value:fact.known?sign*fact.value:null,...(allocations?{allocations}:{})});
    }
  };
  derive('grossMargin',[['netProductSales',1],['costOfGoods',-1]]);
  derive('contribution',[['grossMargin',1],['shippingRevenue',1],['giftCost',-1],['shippingCosts',-1],['platformFees',-1],['commissions',-1]]);
  derive('operatingResult',[['contribution',1],['fixedSalary',-1],['bonuses',-1],['otherExpenses',-1]]);
  const metrics = {};
  for (const [key,[label,unit]] of Object.entries(specs)) {
    const eligible = facts[key], known = eligible.filter(f => f.known), excluded = eligible.filter(f => !f.known);
    const reasons = grouped(excluded,f => f.reason || 'unknown');
    const knownValue = sum(known.map(f => f.value));
    const ratio = ['onTimeDeliveries','shipmentReturnRate'].includes(key);
    const mean = key === 'transitDays';
    const value = ratio ? known.length ? roundRatio(BigInt(knownValue)*10000n,BigInt(known.length)) : null : mean ? known.length ? knownValue/known.length : null : excluded.length ? null : knownValue;
    metrics[key] = {label,value,unit,complete:excluded.length === 0,knownValue:mean ? known.length ? knownValue/known.length : null : knownValue,eligibleCount:eligible.length,knownCount:known.length,excludedCount:excluded.length,exclusionReasons:[...reasons].map(([code,list]) => ({code,label:reasonLabels[code] || 'Dato pendiente',count:list.length})),detailsQuery:{metric:key,period:query.period,anchorDate:query.anchorDate,filters},...(ratio ? {numerator:knownValue,denominator:known.length,noComparisonBase:known.length === 0} : {})};
  }
  const groupEconomics = type => {
    const buckets = new Map();
    const contributionFacts=type==='products'?facts.contribution.flatMap(fact=>fact.allocations || [fact]):facts.contribution;
    for (const fact of contributionFacts) {
      if (!fact.orderId) continue;
      const id = type === 'products' ? `${fact.productKind}:${fact.productId}` : fact.sellerId || 'unassigned';
      if (type === 'products' && !fact.productId) continue;
      if (!buckets.has(id)) buckets.set(id,{id:type === 'products' ? fact.productId : id,kind:type === 'products' ? fact.productKind : undefined,label:type === 'products' ? fact.productLabel : fact.sellerLabel,orderIds:new Set(),units:0,netSalesMinor:0,knownContributionMinor:0,eligibleCount:0,knownCount:0});
      const group = buckets.get(id);
      group.orderIds.add(fact.orderId); group.eligibleCount++;
      if (fact.known) { group.knownCount++; group.knownContributionMinor = exact(group.knownContributionMinor+fact.value); }
    }
    for (const fact of facts.netProductSales) {
      const id = type === 'products' ? `${fact.productKind}:${fact.productId}` : fact.sellerId || 'unassigned';
      if (buckets.has(id) && fact.known) buckets.get(id).netSalesMinor = exact(buckets.get(id).netSalesMinor+fact.value);
    }
    for (const fact of facts.soldUnits) {
      const id = type === 'products' ? `${fact.productKind}:${fact.productId}` : fact.sellerId || 'unassigned';
      if (buckets.has(id) && fact.known) buckets.get(id).units = exact(buckets.get(id).units+fact.value);
    }
    return [...buckets.values()].map(({orderIds,...group}) => ({...group,orderCount:orderIds.size,complete:group.eligibleCount === group.knownCount,contributionMinor:group.eligibleCount === group.knownCount ? group.knownContributionMinor : null})).sort((a,b) => b.knownContributionMinor-a.knownContributionMinor || a.id.localeCompare(b.id));
  };
  const returnGroups = domain.returns.filter(r => selectedIds.has(r.orderId) && inPeriod(r.occurredOn)).map(document => {
    const order = ordersById.get(document.orderId), lines = document.lines.filter(returned => lineMatches(order.items.find(line => line.lineId === returned.lineId)));
    return {id:document.id,orderId:order.id,orderNumber:order.number,kind:document.kind,occurredOn:document.occurredOn,reason:document.reason,quantity:sum(lines.map(l => l.quantity)),salesCreditMinor:sum(lines.map(l => l.salesCreditMinor)),shippingCreditMinor:document.shippingCreditMinor || 0,recoveredCostMinor:lines.some(l => l.recoveredCostMinor == null) ? null : sum(lines.map(l => l.recoveredCostMinor))};
  });
  const pending = [];
  for (const [metric,value] of Object.entries(metrics)) {
    if (['grossMargin','contribution','operatingResult','payrollEarned'].includes(metric)) continue;
    for (const reason of value.exclusionReasons) pending.push({...reason,metric,detailsQuery:value.detailsQuery});
  }
  const coverage = {pending,datedCollections:matchingCollections.filter(c => c.occurredOn).length,undatedCollections:matchingCollections.filter(c => !c.occurredOn).length,notes:['Los registros sin fecha real quedan excluidos del período y visibles en cobertura.','El recaudo Excel sin fecha conserva el saldo de plataforma; no acredita una fecha de pago ni un movimiento de caja.']};
  const criteria = [
    `COP; zona America/Bogota; fechas desde ${bounds.startDate} hasta ${bounds.endDateExclusive}, sin incluir el fin.`,
    'Saldos al menor entre la fecha de corte y el último día del período; ventas por reconocimiento, gastos por ocurrencia y caja por fecha efectiva.',
    'Vendedor/producto limitan pedidos y costos vinculados; cuenta limita caja y pagos, no ventas.',
    'Plataforma/fuente/transportadora limitan guías y sus pedidos; no se duplican ventas por varias guías.',
    'Estado compartido se aplica al pedido en cifras comerciales y al estado efectivo de la guía en logística; estados exclusivos de pedido requieren una guía vinculada.',
    'Los datos desconocidos no son cero. Tasas sin denominador: sin base de comparación. Los reembolsos no vuelven a restar ventas.',
  ];
  const definitions = Object.entries(specs).map(([key,[label,unit]]) => ({key,label,unit,formula:{
    netProductSales:'Productos reconocidos menos créditos comerciales posteriores; descuentos incluidos una sola vez.',
    costOfGoods:'Costo histórico reconocido menos recuperación documentada de unidades previamente reconocidas.',
    giftCost:'Obsequios gratuitos despachados menos recuperación de su costo reconocido. Un regalo con precio positivo usa costo vendido.',
    grossMargin:'Ventas netas de productos − costo vendido.',
    contribution:'Margen bruto + flete reconocido − obsequios gratuitos − transporte − plataforma − comisiones.',
    operatingResult:'Contribución − sueldo fijo − bonificaciones − otros gastos; no es utilidad neta después de impuestos.',
    cashAvailable:'Suma de movimientos efectivos al corte; no incluye dinero en plataforma. Aperturas y transferencias no son ingreso operativo.',
    cashClosingDifference:'Diferencias de cierres vigentes del período; no ajustan el saldo de caja.',
    onTimeDeliveries:'Entregas dentro de fecha estimada / entregas con ambas fechas reales, en el período de entrega.',
    shipmentReturnRate:'Guías efectivamente devueltas / guías entregadas o devueltas, una vez por guía en su período de resolución.',
    transitDays:'Promedio de días calendario entre recogida y entrega reales; no horas inferidas de fechas sin hora.',
    payrollPaid:'Pagos de obligaciones en su fecha efectiva, incluidos anticipos aplicados; no es un nuevo costo.',
    payrollOutstanding:'Obligaciones devengadas al corte menos pagos y compensaciones; créditos separados.',
  }[key] || 'Suma de hechos del dominio en su fecha económica; no se usa updatedAt.',criteria}));
  const ruleVersions = [...rules].sort(([aKey,a],[bKey,b]) => (a.id || '').localeCompare(b.id || '') || aKey.localeCompare(bKey)).map(([,rule])=>rule);
  const moments={confirmed:'confirmación del acuerdo',dispatched:'recogida real',delivered:'entrega completa real',customer_paid:'cobro total al cliente',business_received:'recepción del bruto conciliado por el negocio'};
  const expenseDates={charge_date:'fecha real del cargo',dispatch_date:'recogida real',returned_date:'retorno recibido',settlement_date:'primer recibo confirmado que pague el cargo'};
  const ruleCriteria=ruleVersions.map(rule=>{
    const commission=!rule.commission?.enabled?'deshabilitada':`${rule.commission.mode==='fixed'?`${formatMoneyMinor(rule.commission.fixedMinor)} por pedido, proporcional a la venta retenida`:`${rule.commission.rateBps/100}% de productos netos, sin flete`}; devengo por ${moments[rule.commission.earnWhen]}`;
    return `${rule.id}: vigente desde ${rule.effectiveOn}; venta por ${moments[rule.saleRecognition]}; comisión ${commission}. Flete de ida: ${expenseDates[rule.shippingExpenseDate] || 'criterio no registrado'}; retorno: ${expenseDates[rule.returnExpenseDate] || 'criterio no registrado'}; cargo de plataforma: ${expenseDates[rule.platformFeeExpenseDate] || 'criterio no registrado'}.`;
  });
  definitions.push({key:'rules',label:'Reglas históricas aplicadas',unit:'count',formula:'Versión conservada en cada pedido; cambiar configuración no reescribe la historia. Los criterios de cobro requieren el total comercial, no solo el depósito neto.',criteria:ruleCriteria,ruleVersions});
  definitions.push({key:'allocation',label:'Distribución por producto',unit:'minor',formula:'Flete/cargos/comisiones ligados al pedido: proporción de venta neta y mayor residuo; sin ventas, por unidades. Sueldos y gastos sin vínculo no se distribuyen.',criteria:[`Versión de cálculo ${REPORT_VERSION}. Las asignaciones conservan exactamente el importe original, también en ajustes negativos.`]});
  // Stable ordering is part of the material fingerprint, independent of SQL query plans.
  for (const list of Object.values(facts)) list.sort((a,b) => (a.occurredOn || '').localeCompare(b.occurredOn || '') || a.id.localeCompare(b.id));
  const payrollRows = [...payrollGroups.values()].map(group => {
    const matches = fact => (fact.personId || 'unassigned') === group.id;
    const earnedComplete = !facts.payrollEarned.some(fact => matches(fact) && !fact.known);
    const outstandingComplete = !facts.payrollOutstanding.some(fact => matches(fact) && !fact.known);
    return {...group,knownEarnedMinor:group.earnedMinor,knownOutstandingMinor:group.outstandingMinor,earnedMinor:earnedComplete ? group.earnedMinor : null,outstandingMinor:outstandingComplete ? group.outstandingMinor : null,complete:earnedComplete && outstandingComplete};
  });
  const groups = {products:groupEconomics('products'),sellers:groupEconomics('sellers'),accounts:accountGroups,payroll:payrollRows,shipments:shipmentGroups,returns:returnGroups,costs:costGroups};
  for (const key of ['accounts','payroll','shipments','returns','costs']) groups[key].sort((a,b) => a.id.localeCompare(b.id));
  const lastImportAt = freshness(domain,query);
  const queryKey = hash(queryIdentity(query));
  const factHash = hash({version:REPORT_VERSION,identity:queryIdentity(query),facts,definitions,groups,sourceCuts:lastImportAt.map(({importedAt,...source}) => source)});
  return {query,bounds,closed:query.asOf >= bounds.endAt,empty:Object.values(facts).every(list => !list.length),generatedAt:stamp(),dataAsOf:query.asOf,dataRevision:domain.revision,queryKey,factHash,lastImportAt,metrics,groups,coverage,definitions,facts,filterOptions:domain.filterOptions};
}

export function reportDetails(report, {metric=null,issue=null,page=1,pageSize=PAGE_SIZE} = {}) {
  if (metric != null && (!Object.hasOwn(specs,metric) || !Array.isArray(report.facts?.[metric]))) fail('Métrica no válida.');
  page = integer(page,'Página',1,100000);
  if (pageSize !== null) pageSize = integer(pageSize,'Tamaño de página',1,100);
  const subset=issue?insightDetails(report,{metric,issue}):null;
  const derived = new Set(['grossMargin','contribution','operatingResult']);
  const records = subset ? subset.records : metric == null
    ? Object.keys(specs).filter(key => !derived.has(key)).flatMap(key => (report.facts[key] || []).map(fact => ({...fact,metric:key})))
    : report.facts[metric];
  return {records:pageSize === null ? records : records.slice((page-1)*pageSize,page*pageSize),total:records.length,page:pageSize === null ? 1 : page,pageSize,
    ...(subset?{metricSummary:{...subset.summary,exclusionReasons:subset.summary.complete?[]:report.metrics[metric].exclusionReasons}}:{})};
}

function snapshotMeta(row) {
  return {id:row.id,queryKey:row.query_key,revision:Number(row.revision),state:row.state,staleSince:row.stale_since,generatedAt:row.generated_at,dataRevision:Number(row.data_revision),factHash:row.fact_hash};
}
function snapshotReport(row) { return {...JSON.parse(row.data),snapshot:snapshotMeta(row)}; }
export function saveReportSnapshot(store,input,actorId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Solicitud de informe no válida.');
  const query = normalizeReportQuery({period:input.period,anchorDate:input.anchorDate,filters:input.filters});
  // The request payload excludes the default clock so exact retries remain actor-bound and replayable.
  const payload = {period:query.period,anchorDate:query.anchorDate,filters:query.filters};
  const queryKey = hash(queryIdentity(query)), jobKey = `report:${queryKey}`;
  return runCommand(store,{scope:'report:request',requestId:input.requestId,payload,actorId,affectsIndicators:false},async tx => {
    const old = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`,[jobKey]);
    if (old && (old.state === 'queued' || old.state === 'running')) return {jobKey,queryKey,state:old.state,period:query.period,anchorDate:query.anchorDate};
    await queueJobTx(tx,jobKey,{query:payload,requestedBy:actorId});
    return {jobKey,queryKey,state:'queued',period:query.period,anchorDate:query.anchorDate};
  });
}

// Automatic catch-up shares the exact query identity and queue used by explicit
// administrator requests. Failed data jobs require a new explicit request.
export async function queueScheduledReportTx(tx, input, { now = stamp(), requestedBy = 'scheduler' } = {}) {
  const query = normalizeReportQuery({ ...input, asOf: now });
  const queryKey = hash(queryIdentity(query)), key = `report:${queryKey}`;
  const old = await tx.db.get(`SELECT state,data FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (old && ['queued', 'running', 'failed'].includes(old.state)) return false;
  const latest = await tx.db.get(`SELECT state FROM ${tx.t('report_snapshots')} WHERE query_key=? ORDER BY revision DESC LIMIT 1`, [queryKey]);
  if (latest?.state === 'current') return false;
  await queueJobTx(tx, key, { query: { period: query.period, anchorDate: query.anchorDate, filters: query.filters }, requestedBy: old ? JSON.parse(old.data).requestedBy || requestedBy : requestedBy, automatic: true }, { now });
  return true;
}

export async function generateReportSnapshot(store,input,actorId,{lease=null,now=stamp(),requiredPayrollRevision=null} = {}) {
  text(actorId,'Administrador',100,true);
  now = instant(now);
  const clock = jobClock(now);
  const report = await buildBusinessReport(store,{...input,asOf:input.asOf || now});
  return store.transaction(async tx => {
    await tx.lockWrites();
    if (lease) await assertLease(tx,{...lease,now:clock()});
    const revision = Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
    const stale = revision !== report.dataRevision || requiredPayrollRevision !== null && report.dataRevision !== requiredPayrollRevision;
    const latest = await tx.db.get(`SELECT * FROM ${tx.t('report_snapshots')} WHERE query_key=? ORDER BY revision DESC LIMIT 1`,[report.queryKey]);
    if (latest?.fact_hash === report.factHash) {
      // A later run may clear stale metadata only after capturing the current business revision.
      await tx.db.run(`UPDATE ${tx.t('report_snapshots')} SET state=?,stale_since=?,updated_at=?,version=version+1 WHERE id=?`,[stale?'stale':'current',stale ? latest.stale_since || now : null,now,latest.id]);
      if (lease) await assertLease(tx,{...lease,now:clock()});
      return snapshotReport({...latest,state:stale?'stale':'current',stale_since:stale ? latest.stale_since || now : null});
    }
    if (latest) await tx.db.run(`UPDATE ${tx.t('report_snapshots')} SET state='superseded',updated_at=?,version=version+1 WHERE query_key=? AND state<>'superseded'`,[now,report.queryKey]);
    const row = {id:newId(),query_key:report.queryKey,period:report.query.period,start_on:report.bounds.startDate,end_on_exclusive:report.bounds.endDateExclusive,revision:latest ? Number(latest.revision)+1 : 1,generated_at:report.generatedAt,state:stale?'stale':'current',stale_since:stale?now:null,data_revision:report.dataRevision,fact_hash:report.factHash,data:JSON.stringify(report),version:1,created_at:now,updated_at:now};
    if (lease) await assertLease(tx,{...lease,now:clock()});
    await insertRow(tx,'report_snapshots',row);
    if (lease) await assertLease(tx,{...lease,now:clock()});
    return snapshotReport(row);
  });
}

export function listReportSnapshots(store,input={}) {
  const page = integer(input.page ?? 1,'Página',1,100000);
  if (input.period != null && !BUSINESS_PERIODS.includes(input.period)) fail('Período no válido.');
  const query = normalizeReportQuery({period:input.period,anchorDate:input.anchorDate,filters:input.filters});
  return store.readSnapshot(async tx => {
    const conditions = [], values = [];
    if (input.period) { conditions.push('period=?'); values.push(input.period); }
    if (input.anchorDate || input.filters && Object.keys(input.filters).length) {
      const query = normalizeReportQuery({period:input.period,anchorDate:input.anchorDate,filters:input.filters});
      conditions.push('query_key=?'); values.push(hash(queryIdentity(query)));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('report_snapshots')} ${where}`,values)).count);
    const coverage = json(tx,'s','coverage');
    const records = await tx.db.all(`SELECT s.id,s.query_key,s.period,s.start_on,s.end_on_exclusive,s.revision,s.generated_at,s.state,s.stale_since,s.data_revision,s.fact_hash,${coverage} AS coverage FROM ${tx.t('report_snapshots')} s ${where} ORDER BY s.generated_at DESC,s.revision DESC,s.id LIMIT ${PAGE_SIZE} OFFSET ?`,[...values,(page-1)*PAGE_SIZE]);
    const jobRow = await tx.db.get(`SELECT key,state,error_code,finished_at FROM ${tx.t('job_runs')} WHERE key=?`,[`report:${hash(queryIdentity(query))}`]);
    const job = jobRow ? {key:jobRow.key,state:jobRow.state,errorCode:jobRow.error_code,finishedAt:jobRow.finished_at} : null;
    const filterOptions = await readFilterOptions(tx);
    return {records:records.map(row => ({...snapshotMeta(row),period:row.period,startOn:row.start_on,endOnExclusive:row.end_on_exclusive,anchorDate:row.start_on,coverage:typeof row.coverage === 'string' ? JSON.parse(row.coverage) : row.coverage})),total,page,pageSize:PAGE_SIZE,job,filterOptions};
  });
}
export function getReportSnapshot(store,id) {
  id = text(id,'Informe',100,true);
  return store.readSnapshot(async tx => {
    const row = await tx.db.get(`SELECT * FROM ${tx.t('report_snapshots')} WHERE id=?`,[id]);
    if (!row) fail('Informe no encontrado.',404);
    return snapshotReport(row);
  });
}

export async function processReportTurn(store,{maxReports=10,now=stamp(),requiredPayrollRevision=null}={}) {
  maxReports = integer(maxReports,'Informes por turno',1,10); now = instant(now);
  const clock = jobClock(now);
  let processed = 0;
  while (processed < maxReports) {
    const lease = await claimJob(store,{prefix:'report:',now:clock()});
    if (!lease) break;
    try {
      await withLeaseHeartbeat(store,lease,async ({clock,assertActive}) => {
        const report = await generateReportSnapshot(store,lease.query,lease.requestedBy,{lease,now:clock(),requiredPayrollRevision});
        assertActive();
        await finishJob(store,lease,{state:report.snapshot.state === 'stale' ? 'queued' : 'succeeded',data:{snapshotId:report.snapshot.id,revision:report.snapshot.revision},now:clock()});
      },{now:clock()});
    } catch (error) {
      const retry = error.status === 503 || ['ECONNRESET','ECONNREFUSED','57P01','40001','SQLITE_BUSY'].includes(error.code);
      try { await finishJob(store,lease,{state:retry?'queued':'failed',errorCode:retry?'DB_UNAVAILABLE':error.status === 409?'LEASE_LOST':'REPORT_INVALID',now:clock()}); }
      catch (finishError) { if (finishError.status !== 409) throw finishError; }
      if (retry) { processed++; break; }
    }
    processed++;
    if (requiredPayrollRevision !== null && Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value) !== requiredPayrollRevision) break;
  }
  const pending = await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'report:%' AND (state='queued' OR (state='running' AND lease_until<=?)) LIMIT 1`,[clock()]);
  return {processed,hasMore:!!pending};
}
