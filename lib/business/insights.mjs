import { fail } from '../validation-core.mjs';
import { businessDate, instant } from './dates.mjs';
import { formatMoneyMinor, roundRatio } from './money.mjs';

// These are report drilldown issues, not alert types. Every advertised subset is
// computed here as well as in buildInsights, so its count and signed sum agree.
export const INSIGHT_ISSUES = Object.freeze([
  'missing', 'negative_contribution', 'positive_contribution', 'late_deliveries',
  'shipping_returns', 'shipping_absorbed', 'costly_returns', 'positive_products', 'positive_sellers',
]);
const issueMetric = {
  negative_contribution:'contribution', positive_contribution:'contribution',
  late_deliveries:'onTimeDeliveries', shipping_returns:'shipmentReturnRate',
  shipping_absorbed:'shippingCosts', costly_returns:'returnedUnits',
  positive_products:'contribution', positive_sellers:'contribution',
};
const known = fact => fact.known !== false && fact.value != null;
const facts = (report, metric) => report.facts?.[metric] || [];
const stable = (a, b) => String(a.id).localeCompare(String(b.id));
function sum(values) {
  const value = values.reduce((total, amount) => total + BigInt(amount), 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('Total de observación fuera de rango seguro.');
  return Number(value);
}
const total = records => sum(records.filter(known).map(record => record.value));
const completeMetric = metric => metric?.complete === true && metric.value != null;
function buckets(records, key) {
  const result = new Map();
  for (const record of records) {
    const id = key(record);
    if (id == null) continue;
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(record);
  }
  return [...result].map(([id, records]) => ({id,records,complete:records.every(known),value:total(records)}));
}
function orderContributions(report) {
  return buckets(facts(report,'contribution'), fact => fact.orderId);
}
function positiveGroups(report, type) {
  return (report.groups?.[type] || []).filter(row => row.complete === true && row.contributionMinor > 0 && row.knownCount === row.eligibleCount && row.eligibleCount > 0)
    .filter(row => type !== 'sellers' || row.id !== 'unassigned')
    .sort((a,b) => b.contributionMinor-a.contributionMinor || stable(a,b));
}
function returnReason(report) {
  // Commercial credits are exposure, not an inferred profit loss or a logistics
  // return. Cancellations are deliberately not mixed into this observation.
  return buckets((report.groups?.returns || []).filter(row => row.kind === 'return' && row.salesCreditMinor + row.shippingCreditMinor > 0)
    .map(row => ({...row,value:sum([row.salesCreditMinor,row.shippingCreditMinor]),known:true})), row => row.reason || 'Sin motivo registrado')
    .sort((a,b) => b.value-a.value || stable(a,b))[0] || null;
}
function absorbedShipping(report) {
  const records = [
    ...facts(report,'shippingCosts').map(fact => ({...fact,metric:'shippingCosts',sourceValue:fact.value})),
    ...facts(report,'shippingRevenue').map(fact => ({...fact,metric:'shippingRevenue',sourceValue:fact.value,value:known(fact) ? -fact.value : null})),
  ];
  return buckets(records, fact => fact.orderId).filter(group => group.complete && group.value > 0);
}
function subsetSummary(records, label, unit, extra = {}) {
  const knownRecords = records.filter(known), complete = knownRecords.length === records.length;
  const knownValue = total(records);
  return {label,value:complete ? knownValue : null,knownValue,unit,complete,eligibleCount:records.length,knownCount:knownRecords.length,excludedCount:records.length-knownRecords.length,...extra};
}

/** Exact, unpaginated source records; callers paginate only AFTER selecting.
 * missing: unknown facts of any existing metric.
 * negative/positive_contribution: ALL period contribution facts of complete
 * orders with a negative/positive signed period sum (never accumulated profit).
 * late_deliveries/shipping_returns: only the known 0/1 numerator subset.
 * shipping_absorbed: complete per-order period shipping cost minus revenue >0;
 * revenue facts have a negative value and retain sourceValue and metric.
 * costly_returns: commercial return documents of the greatest credit reason;
 * value = product + shipping credit, not loss; ties use the literal reason.
 * positive_products/sellers: source contribution facts of complete positive
 * groups; product facts use the report's exact allocations, not duplicated costs.
 */
export function insightDetails(report, {metric,issue} = {}) {
  if (issue == null || issue === '') return null;
  if (!INSIGHT_ISSUES.includes(issue)) fail('Observación no válida.');
  if (!Array.isArray(report.facts?.[metric]) || !report.metrics?.[metric]) fail('Métrica no válida.');
  if (issue !== 'missing' && issueMetric[issue] !== metric) fail('La observación no corresponde a esta métrica.');
  let records, label, unit = report.metrics[metric].unit, extra = {};
  if (issue === 'missing') {
    records = facts(report,metric).filter(fact => !known(fact));
    label = 'Datos pendientes del período';
  } else if (issue === 'negative_contribution' || issue === 'positive_contribution') {
    const positive = issue === 'positive_contribution';
    const groups = orderContributions(report).filter(group => group.complete && (positive ? group.value > 0 : group.value < 0));
    records = groups.flatMap(group => group.records);
    label = `Contribución ${positive ? 'positiva' : 'negativa'} de pedidos en el período (no acumulada)`;
    extra.orderCount = groups.length;
  } else if (issue === 'late_deliveries' || issue === 'shipping_returns') {
    const value = issue === 'late_deliveries' ? 0 : 1;
    records = facts(report,metric).filter(fact => known(fact) && fact.value === value);
    records = records.map(fact=>({...fact,sourceValue:fact.value,value:1,unit:'count'}));
    label = issue === 'late_deliveries' ? 'Entregas fuera de plazo del período' : 'Guías devueltas en el período de resolución';
    // A subset of failures is a count, never a rate with a changed denominator.
    unit = 'count';
    extra = {value:records.length,knownValue:records.length,numerator:records.length,denominator:report.metrics[metric].denominator};
  } else if (issue === 'shipping_absorbed') {
    const groups = absorbedShipping(report);
    records = groups.flatMap(group => group.records);
    label = 'Transporte menos flete reconocido en el período, solo pedidos con diferencia positiva';
    extra.orderCount = groups.length;
  } else if (issue === 'costly_returns') {
    const reason = returnReason(report);
    records = (reason?.records || []).map(row => ({...row,entityType:'order_return',entityId:row.id,returnId:row.id,unit:'minor'}));
    label = 'Créditos comerciales del principal motivo de devolución del período';
    unit = 'minor';
    extra.reason = reason?.id || null;
  } else {
    const type = issue === 'positive_products' ? 'products' : 'sellers';
    const groups = positiveGroups(report,type);
    const ids = new Set(groups.map(group => type === 'products' ? `${group.kind}:${group.id}` : group.id));
    records = type === 'products'
      ? facts(report,'contribution').flatMap(fact => (fact.allocations || [fact]).filter(part => ids.has(`${part.productKind}:${part.productId}`)).map(part => ({...fact,...part,id:`${fact.id}:product:${part.productKind}:${part.productId}:${part.lineId || ''}`,sourceFactId:fact.id})))
      : facts(report,'contribution').filter(fact => ids.has(fact.sellerId));
    label = `Contribución del período de ${type === 'products' ? 'productos' : 'vendedores'} con datos completos y saldo positivo`;
    extra.groupCount = groups.length;
  }
  records = [...records].sort(stable);
  return {records,summary:subsetSummary(records,label,unit,extra)};
}

function action(report, metric, issue, label = 'Ver registros del período') {
  const tab = metric === 'onTimeDeliveries' || metric === 'shipmentReturnRate' ? 'shipping' : metric === 'returnedUnits' ? 'returns' : 'overview';
  return {label:issue === 'comparison_elapsed' ? 'Ver registros del tramo comparado' : label,view:{section:'reports',tab,period:report.query.period,anchor:report.query.anchorDate,record:metric,...(issue ? {issue} : {})}};
}
function range(report) {
  return {startDate:report.bounds.startDate,endDateExclusive:report.bounds.endDateExclusive};
}
function observation(report, id, title, explanation, value, unit, evidence, metric, issue) {
  return {id,title,explanation,value,unit,evidence:{...range(report),...evidence},action:action(report,metric,issue)};
}
function ratio(report, metric) {
  const all = facts(report,metric), dated = all.filter(fact => known(fact) && fact.occurredOn && (metric !== 'onTimeDeliveries' || fact.estimatedDeliveryOn));
  const numerator = sum(dated.map(fact => fact.value));
  return {numerator,denominator:dated.length,knownCount:dated.length,eligibleCount:all.length,value:dated.length ? roundRatio(BigInt(numerator)*10000n,BigInt(dated.length)) : null};
}
function freshnessEvidence(current, previous, metric, sources, now) {
  const relevant = new Set([...facts(current,metric),...facts(previous,metric)].map(fact => fact.sourceId || null));
  const cuts = Array.isArray(sources) ? sources.filter(source => relevant.has(source.sourceId || null)) : [];
  const missing = [...relevant].some(id => !cuts.some(source => (source.sourceId || null) === id));
  const checked = cuts.map(source => {
    let earliest = NaN, latest = NaN;
    if (source.precision === 'day') {
      const date = source.sourceDate || (/^\d{4}-\d{2}-\d{2}$/.test(source.sourceAsOf || '') ? source.sourceAsOf : null);
      if (date) {
        businessDate(date);
        earliest = Date.parse(`${date}T05:00:00.000Z`);
        latest = earliest + 86400000;
      }
    } else if (source.precision === 'instant' && source.sourceAsOf) {
      earliest = latest = Date.parse(instant(source.sourceAsOf));
    }
    const fresh = Number.isFinite(earliest) && earliest <= now && now-earliest <= 86400000;
    return {sourceId:source.sourceId || null,sourceAsOf:source.sourceAsOf || null,sourceDate:source.sourceDate || null,precision:source.precision || 'unknown',fresh,uncertain:Number.isFinite(latest) && !fresh && latest > now-86400000};
  });
  return {fresh:relevant.size > 0 && !missing && checked.length > 0 && checked.every(cut => cut.fresh),sources:checked,missing};
}
function safeComparison(comparison, current, previous) {
  const values = report => Object.fromEntries(['netProductSales','contribution','operatingResult','onTimeDeliveries','shipmentReturnRate'].map(key => [key,report?.metrics?.[key]?.value ?? null]));
  return {equivalent:comparison?.equivalent === true && !!previous,mode:comparison?.mode || null,reason:comparison?.reason || null,currentBounds:comparison?.currentBounds ? range({bounds:comparison.currentBounds}) : range(current),previousBounds:comparison?.previousBounds ? range({bounds:comparison.previousBounds}) : previous ? range(previous) : null,currentValues:values(current),previousValues:values(previous)};
}

/** Pure deterministic analysis. Omitted now uses the report's own cut, never
 * the wall clock. Reports/comparison slices remain internal and are not copied
 * into the returned DTO. All monetary values and differences are centavos. */
export function buildInsights(report, comparison, {now=report.dataAsOf,sourceFreshness=report.lastImportAt} = {}) {
  const checkedAt = now instanceof Date ? now.getTime() : Date.parse(instant(now));
  const current = comparison?.currentReport || report, previous = comparison?.report;
  const currentRange = range({bounds:comparison?.currentBounds || current.bounds});
  const previousRange = previous ? range({bounds:comparison?.previousBounds || previous.bounds}) : null;
  const equivalent = comparison?.equivalent === true && !!previous;
  const improvements = [], successes = [], notes = [];
  const addNote = (id,text,metric,issue) => notes.push({id,text,...(metric ? {action:action(report,metric,issue)} : {})});
  const addSubset = (issue, metric, title, explanation, list=improvements) => {
    const detail = insightDetails(report,{metric,issue});
    if (!detail.records.length) return;
    list.push(observation(report,issue,title,explanation(detail.summary),detail.summary.value,detail.summary.unit,{...detail.summary,currentValue:detail.summary.value},metric,issue));
  };
  addSubset('negative_contribution','contribution','Pedidos con contribución negativa en el período', summary => `${summary.orderCount} pedidos suman ${formatMoneyMinor(summary.value)} de contribución en este período; no es su rentabilidad acumulada. Revisar sus ingresos y costos registrados.`);
  addSubset('costly_returns','returnedUnits','Principal motivo de devolución por importe', summary => `«${summary.reason}»: ${summary.eligibleCount} devoluciones y ${formatMoneyMinor(summary.value)} en créditos comerciales del período. Es importe acreditado, no pérdida ni reembolso pagado.`);
  addSubset('shipping_absorbed','shippingCosts','Transporte no cubierto por el flete del período', summary => `${summary.orderCount} pedidos tienen ${formatMoneyMinor(summary.value)} de transporte por encima del flete reconocido en este período. Las fechas de costo y venta pueden ser distintas; no prueba una pérdida acumulada.`);

  const resultKnown = completeMetric(report.metrics.operatingResult);
  const healthy = resultKnown && report.metrics.operatingResult.value >= 0;
  if (!resultKnown) addNote('economic_incomplete','Resultado por completar: los subtotales conocidos no acreditan una ganancia. Completar costos y fechas pendientes.','operatingResult','missing');
  else if (!healthy) addNote('economic_negative','El resultado operativo registrado es negativo; un aumento de ventas no se presenta como un acierto económico.','operatingResult');
  if (!equivalent) addNote('comparison_not_equivalent',`Comparación no equivalente. ${comparison?.reason || 'Falta un tramo anterior completo de la misma duración.'}`);

  if (equivalent) {
    const economic = current.metrics.contribution, prior = previous.metrics.contribution;
    if (completeMetric(economic) && completeMetric(prior)) {
      const difference = sum([economic.value,-prior.value]);
      if (prior.value === 0) addNote('economic_zero_base',`Sin base anterior: diferencia absoluta de contribución ${formatMoneyMinor(difference)}; no se calcula un porcentaje.`, 'contribution',comparison.mode==='elapsed'?'comparison_elapsed':undefined);
      else if (prior.value > 0) {
        const changeBps = roundRatio(BigInt(difference)*10000n,BigInt(prior.value));
        const evidence = {...currentRange,currentValue:economic.value,previousValue:prior.value,difference,changeBps,previousStartDate:previousRange.startDate,previousEndDateExclusive:previousRange.endDateExclusive,mode:comparison.mode};
        const issue = comparison.mode === 'elapsed' ? 'comparison_elapsed' : undefined;
        if (BigInt(difference)*10n <= -BigInt(prior.value)) improvements.push(observation(report,'contribution_decline','La contribución disminuyó',`Contribución de ${formatMoneyMinor(economic.value)} frente a ${formatMoneyMinor(prior.value)} en tramos equivalentes. Revisar los hechos del tramo, sin atribuir una causa.`,economic.value,'minor',evidence,'contribution',issue));
        if (BigInt(difference)*10n >= BigInt(prior.value) && economic.value > 0 && healthy && completeMetric(current.metrics.operatingResult) && current.metrics.operatingResult.value >= 0) successes.push(observation(report,'contribution_growth','La contribución creció con costos completos',`${formatMoneyMinor(economic.value)} frente a ${formatMoneyMinor(prior.value)} en tramos equivalentes; el resultado operativo registrado es conocido y no negativo.`,economic.value,'minor',evidence,'contribution',issue));
      } else addNote('economic_negative_base','La contribución anterior no es positiva; se muestran los importes sin afirmar una tendencia porcentual.','contribution');
    } else addNote('comparison_costs_missing','La comparación económica requiere costos y fechas completos en ambos tramos.','contribution', facts(report,'contribution').some(fact => !known(fact)) ? 'missing' : undefined);

    for (const metric of ['onTimeDeliveries','shipmentReturnRate']) {
      const a = ratio(current,metric), b = ratio(previous,metric);
      const enough = a.denominator >= 20 && b.denominator >= 20;
      const coverage = a.knownCount*10 >= a.eligibleCount*9 && b.knownCount*10 >= b.eligibleCount*9;
      const fresh = report.closed === true ? {fresh:true,sources:[]} : freshnessEvidence(current,previous,metric,sourceFreshness,checkedAt);
      if (!enough || !coverage || !fresh.fresh) {
        const gaps = [
          ...(!enough ? ['Se requieren al menos 20 guías con fechas en cada tramo.'] : []),
          ...(!coverage ? ['La cobertura de fechas debe alcanzar 90% en ambos tramos.'] : []),
          ...(!fresh.fresh ? ['Falta un corte verificable dentro de 24 horas de todas las fuentes relevantes; un archivo recién cargado no confirma frescura y una fecha sin hora puede ser ambigua.'] : []),
        ];
        addNote(`${metric}_insufficient`,`${metric === 'onTimeDeliveries' ? 'Entregas a tiempo' : 'Devoluciones logísticas'}: sin tendencia fiable. Fechas conocidas: ${a.knownCount}/${a.eligibleCount} guías actuales y ${b.knownCount}/${b.eligibleCount} anteriores. ${gaps.join(' ')}`,metric, a.knownCount < a.eligibleCount ? 'missing' : undefined);
        continue;
      }
      const numerator = BigInt(a.numerator)*BigInt(b.denominator)-BigInt(b.numerator)*BigInt(a.denominator);
      const denominator = BigInt(a.denominator)*BigInt(b.denominator);
      const changeBps = roundRatio(numerator*10000n,denominator);
      if ((numerator < 0n ? -numerator : numerator)*10000n < denominator*500n) {
        addNote(`${metric}_stable`,`${metric === 'onTimeDeliveries' ? 'Entregas a tiempo' : 'Devoluciones logísticas'}: variación inferior a 5 puntos porcentuales; no se presenta como mejora ni deterioro.`,metric);
        continue;
      }
      const better = metric === 'onTimeDeliveries' ? numerator > 0n : numerator < 0n;
      const evidence = {...currentRange,currentValue:a.value,previousValue:b.value,difference:changeBps,changeBps,numerator:a.numerator,denominator:a.denominator,previousNumerator:b.numerator,previousDenominator:b.denominator,knownCount:a.knownCount,eligibleCount:a.eligibleCount,previousKnownCount:b.knownCount,previousEligibleCount:b.eligibleCount,previousStartDate:previousRange.startDate,previousEndDateExclusive:previousRange.endDateExclusive,sourceFreshness:fresh.sources};
      const issue = comparison.mode === 'elapsed' ? 'comparison_elapsed' : better ? undefined : metric === 'onTimeDeliveries' ? 'late_deliveries' : 'shipping_returns';
      (better ? successes : improvements).push(observation(report,`${metric}_${better ? 'improved' : 'worsened'}`,`${metric === 'onTimeDeliveries' ? 'Entregas a tiempo' : 'Devoluciones logísticas'}: ${better ? 'mejora' : 'deterioro'} observable`,`${a.numerator}/${a.denominator} guías frente a ${b.numerator}/${b.denominator} en tramos equivalentes. La diferencia no identifica una causa.`,a.value,'bps',evidence,metric,issue));
    }
  }

  const noHistory = !previous || facts(previous,'contribution').length === 0;
  const completeOrders = orderContributions(report).filter(group => group.complete);
  if (healthy && completeMetric(report.metrics.contribution) && report.metrics.contribution.value > 0 && completeOrders.length >= 5) {
    if (noHistory) addSubset('positive_contribution','contribution','Pedidos con contribución positiva, sin afirmar tendencia', summary => `${summary.orderCount} pedidos con contribución positiva y datos completos del período: ${formatMoneyMinor(summary.value)}. Base: ${completeOrders.length} pedidos completos; no hay historial comparable.`,successes);
    for (const type of ['products','sellers']) {
      const rows = positiveGroups(report,type);
      if (!rows.length) continue;
      const issue = type === 'products' ? 'positive_products' : 'positive_sellers';
      const detail = insightDetails(report,{metric:'contribution',issue});
      if (!detail.records.length) continue;
      // All eligible groups appear in the exact drilldown; the compact evidence
      // preview is ordered by contribution, without calling anyone "the best".
      const preview = rows.slice(0,3).map(({id,label,contributionMinor,orderCount,units,knownCount,eligibleCount}) => ({id,label,contributionMinor,orderCount,units,knownCount,eligibleCount}));
      successes.push(observation(report,issue,`${type === 'products' ? 'Productos' : 'Vendedores'} con contribución positiva completa`,`${rows.length} ${type === 'products' ? 'productos' : 'vendedores'} con contribución conocida positiva. Volumen y cobertura se muestran por grupo; no es un ranking de desempeño ni una tendencia.`,detail.summary.value,'minor',{...detail.summary,currentValue:detail.summary.value,groups:preview,completeOrders:completeOrders.length},'contribution',issue));
    }
  } else if (noHistory) addNote('history_insufficient','Sin historial comparable: se necesitan al menos 5 pedidos con contribución completa y un resultado registrado conocido no negativo para destacar evidencia económica.','contribution', facts(report,'contribution').some(fact => !known(fact)) ? 'missing' : undefined);
  if (!improvements.length && !successes.length) addNote('evidence_insufficient','No hay evidencia suficiente para destacar mejoras o aciertos. Revisar la cobertura y registrar hechos reales antes de comparar.','operatingResult',resultKnown ? undefined : 'missing');
  const priority = item => item.unit === 'minor' ? Math.abs(item.evidence.difference < 0 ? item.evidence.difference : item.value || 0) : 0;
  const order = (a,b) => priority(b)-priority(a) || (b.evidence.orderCount || b.evidence.denominator || b.evidence.eligibleCount || 0)-(a.evidence.orderCount || a.evidence.denominator || a.evidence.eligibleCount || 0) || stable(a,b);
  improvements.sort(order); successes.sort(order); notes.sort(stable);
  return {improvements:improvements.slice(0,3),successes:successes.slice(0,3),notes,comparison:safeComparison(comparison,current,previous)};
}
