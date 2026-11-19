'use client';

import { useEffect, useId, useState } from 'react';
import { parseMoneyMinor } from '../lib/business/money.mjs';
import { formatSocialMoneyMinor, selectSocialEconomicForecast, socialBreakEven, socialBusinessAmounts, socialCurrency, socialExpectedCost, socialPrimaryForecastRange } from '../lib/business/social-economics.mjs';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const PRIMARY = { traffic: 'linkClicks', whatsapp: 'conversations', reach: 'reach', engagement: 'interactions' };
const METRICS = {
  impressions: 'Impresiones', clicks: 'Clics totales', inline_link_clicks: 'Clics de enlace en línea',
  link_click: 'Clics de enlace (acción reportada)', linkClicks: 'Clics de enlace',
  reach: 'Personas alcanzadas', conversations: 'Conversaciones iniciadas por WhatsApp',
  interactions: 'Interacciones', post_engagement: 'Interacciones con la publicación',
  'onsite_conversion.messaging_conversation_started_7d': 'Conversaciones de mensajería iniciadas en 7 días',
  'offsite_conversion.fb_pixel_purchase': 'Compras de sitio web atribuidas por Meta (píxel)',
  omni_purchase: 'Compras atribuidas por Meta (varios canales)',
  spend: 'Gasto reportado', spendMinor: 'Gasto reportado',
};
const PER_RESULT = { linkClicks: 'clic de enlace', conversations: 'conversación', reach: 'persona alcanzada', interactions: 'interacción' };
const CHANNELS = { facebook: 'Facebook', instagram: 'Instagram', meta_ads: 'Entrega pagada' };
const decimal = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 8 });
const captureDate = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
const noData = 'Sin datos';

function date(value) {
  if (!value) return 'Sin fecha informada';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? `${captureDate.format(time)} (hora de Bogotá)` : 'Sin fecha informada';
}

export function economicPeriod(from, to, timeZone) {
  if (!from && !to) return 'Sin período informado';
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return `${from} a ${to}${timeZone ? ` · ${timeZone}` : ''}`;
  }
  if (timeZone) {
    try {
      const format = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone });
      if (Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))) return `${format.format(new Date(from))} a ${format.format(new Date(to))} · ${timeZone}`;
    } catch { /* Fall back to the explicitly labeled display zone. */ }
  }
  return `${date(from)} a ${date(to)}`;
}

const money = (value, currency) => formatSocialMoneyMinor(value, currency) ?? noData;

function parseAmount(value) {
  if (!value.trim()) return null;
  try { return parseMoneyMinor(value); } catch { return null; }
}

function Facts({ rows }) {
  return <dl className={`summary-values ${styles.summaryGrid}`}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd style={{ overflowWrap: 'anywhere' }}>{value ?? noData}</dd></div>)}</dl>;
}

function BreakEven({ budget, currency, source, organic, alreadyRan }) {
  const helpId = useId();
  const [scenario, setScenario] = useState({ budget: '', margin: '', currency: '' });
  const fixed = Number.isSafeInteger(budget) && budget >= 0 && socialCurrency(currency);
  const chosenCurrency = fixed ? currency : scenario.currency;
  const result = socialBreakEven({ organic, budgetMinor: fixed ? budget : parseAmount(scenario.budget), budgetCurrency: chosenCurrency,
    contributionMinor: parseAmount(scenario.margin), contributionCurrency: chosenCurrency });
  const change = key => event => {
    const value = key === 'currency' ? event.target.value.toUpperCase().trim() : event.target.value;
    setScenario(previous => ({ ...previous, [key]: value }));
  };
  const reasons = {
    missing_budget: 'Indica el presupuesto total de la pauta.',
    incompatible_currency: 'Indica la misma moneda para ambos importes con un código como COP o USD.',
    missing_contribution: 'Indica cuánto esperas que deje cada venta antes de publicidad.',
  };
  return <div className={styles.card}>
    <h4>Simular punto de equilibrio</h4>
    {alreadyRan && <p><strong>Simulación actual</strong> · No es una previsión guardada antes de pautar.</p>}
    {fixed && <Facts rows={[["Presupuesto total de la pauta", <>{money(budget, currency)} · {source}</>]]}/>}
    {!organic && (!fixed || budget > 0) && <>
      <p id={helpId} className={styles.help}>Usa punto para miles y coma para decimales. La contribución es lo que deja el pedido después de producto, obsequios, envíos y comisiones aplicables; no es su precio.</p>
      <div className={styles.fieldGrid}>
        {!fixed && <>
          <div><label className="field">Presupuesto total de la pauta<input inputMode="decimal" maxLength={100} value={scenario.budget} onChange={change('budget')} aria-describedby={`${helpId} ${helpId}-budget`} placeholder="100.000"/></label><small id={`${helpId}-budget`}>Supuesto tuyo</small></div>
          <label className="field">Moneda del escenario<input maxLength={3} autoCapitalize="characters" spellCheck={false} value={scenario.currency} onChange={change('currency')} placeholder="COP"/></label>
        </>}
        <div><label className="field">Contribución esperada por venta<input inputMode="decimal" maxLength={100} value={scenario.margin} onChange={change('margin')} aria-describedby={`${helpId} ${helpId}-margin`} placeholder="30.000"/></label><small id={`${helpId}-margin`}>Supuesto tuyo, antes de publicidad{socialCurrency(chosenCurrency) ? `, en ${chosenCurrency}` : ''}.</small></div>
      </div>
      <p className={styles.help}>Este escenario no se guarda ni cambia el presupuesto, la aprobación o los resultados.</p>
    </>}
    <p role="status" aria-live="polite">{result.status === 'estimated' ? <><strong>{decimal.format(result.sales)} {result.sales === 1 ? 'venta' : 'ventas'}</strong> para cubrir la pauta.</>
      : result.status === 'no_investment' ? <strong>Sin inversión publicitaria</strong>
      : result.status === 'nonpositive_contribution' ? 'Con ese margen, ninguna cantidad de ventas cubre la pauta.'
      : <><strong>Sin base para estimar</strong>. {reasons[result.status]}</>}</p>
  </div>;
}

function ForecastSummary({ forecast, spec, linked, forecastError, forecastPending, onForecastRetry }) {
  const primary = PRIMARY[spec?.objective];
  const organic = spec?.mode === 'organic';
  const keys = primary ? organic ? (spec.platforms || []).map(channel => `${channel}.${primary}`) : [primary] : [];
  const manual = forecast?.manualScenario;
  return <div className={styles.card}>
    <h4>Rango esperado de resultados</h4>
    {linked && <p>Fuente local: previsión de la ficha propia vinculada. No se reconstruye con resultados de Meta.</p>}
    {forecastError && <p className={styles.warning}>No se pudo leer la previsión de la ficha propia.{onForecastRetry && <> <button type="button" className="text-button" onClick={onForecastRetry}>Reintentar lectura de la ficha propia</button></>}</p>}
    {forecastPending ? <p role="status">Cargando previsión de la ficha propia…</p> : keys.length ? keys.map(key => {
      const range = socialPrimaryForecastRange(forecast, key), cost = !organic && range ? socialExpectedCost(forecast, range) : null;
      const label = `${key.includes('.') ? `${CHANNELS[key.split('.')[0]]} · ` : ''}${METRICS[primary]}`;
      return <div key={key}>
        <h5>{label}</h5>
        {range ? <>
          <Facts rows={[["Q25–Q75", `${decimal.format(range.lower)}–${decimal.format(range.upper)}`], ['Mediana', decimal.format(range.median)],
            ['Muestra', `${range.sampleCount} campañas finalizadas comparables para esta métrica`],
            ['Presupuesto de la previsión', organic ? 'Sin inversión publicitaria' : money(forecast.budgetMinor, forecast.currency)],
            ['Horizonte', organic ? `${range.horizon} días` : economicPeriod(range.horizon?.startAt, range.horizon?.endAt, spec.timeZone)],
            ['Fuente y fecha', `Historial comparable · ${date(forecast.generatedAt)}`]]}/>
          <p className={styles.help}>Son cuartiles observados{organic ? '' : ' escalados al presupuesto de la previsión'}, no una probabilidad de éxito ni un pronóstico de ventas.</p>
        </> : <p><strong>Sin base para estimar</strong>. Se necesitan al menos cinco campañas finalizadas comparables para este indicador.</p>}
        {!organic && <>
          <p><strong>Costo esperado por resultado:</strong> {cost ? `${money(cost.medianMinor, forecast.currency)} por ${PER_RESULT[primary]}` : 'Sin base para estimar'}.</p>
          {cost?.interval && <p>Intervalo orientativo: {money(cost.interval.lowMinor, forecast.currency)} a {money(cost.interval.highMinor, forecast.currency)} por {PER_RESULT[primary]}.</p>}
          {cost && range.lower === 0 && <p>No hay un máximo finito para el costo cuando Q25 es cero.</p>}
          {range?.median === 0 && <p>No se divide el presupuesto por una mediana de cero.</p>}
        </>}
      </div>;
    }) : <p><strong>Sin base para estimar</strong> el rango o el costo por resultado.</p>}
    {manual && <details className={styles.technicalDetails}><summary>Hipótesis manual del usuario</summary><p>{METRICS[manual.metric?.split('.').at(-1)] || manual.metric}: {decimal.format(manual.lower)}–{decimal.format(manual.upper)}</p><p>Fundamento: {manual.basis}</p><p>No es un rango observado ni sirve para calcular un costo esperado.</p></details>}
  </div>;
}

export function InvestmentEstimate({ title = 'Estimación antes de invertir', spec, budget, currency, source, forecast, alreadyRan, linked, forecastError, forecastPending, onForecastRetry }) {
  const id = useId();
  return <section className={`${styles.panel} ${styles.stack}`} aria-labelledby={id}>
    <h3 id={id}>{title}</h3><p>¿Cuántas ventas necesito para cubrir la pauta?</p>
    <BreakEven budget={budget} currency={currency} source={source} organic={spec?.mode === 'organic'} alreadyRan={alreadyRan}/>
    <ForecastSummary forecast={forecast} spec={spec} linked={linked} forecastError={forecastError} forecastPending={forecastPending} onForecastRetry={onForecastRetry}/>
  </section>;
}

function reportedValue(metric, currency) {
  if (metric?.value == null) return noData;
  if (metric.unit === 'minor_currency') return money(metric.value, currency);
  if (metric.precision === 'rounded' && metric.displayValue) return metric.displayValue;
  const value = typeof metric.value === 'string' ? metric.value : decimal.format(metric.value);
  return metric.unit === 'account_currency_decimal' ? `${value} ${currency || '(moneda no informada)'}` : value;
}

export function MetaReportedPerformance({ sectionId, readings, empty, context, children }) {
  const id = useId();
  return <section id={sectionId} tabIndex={sectionId ? -1 : undefined} className={`${styles.panel} ${styles.stack}`} aria-labelledby={id}>
    <h3 id={id}>Rendimiento reportado por Meta</h3><p>¿Qué devolvió para esta cuenta y este período?</p>
    {context}
    {!readings.length && <p>{empty}</p>}
    {readings.map(reading => <article className={styles.card} key={reading.id}>
      {reading.channel && <h4>{CHANNELS[reading.channel] || reading.channel}</h4>}
      <Facts rows={[
        ...(reading.paid ? [['Cuenta publicitaria', reading.account], ['ID de campaña', reading.campaignId]] : []),
        ['Período de Meta', reading.period], ['Fecha de captura', date(reading.observedAt)],
        ...(reading.paid ? [['Moneda reportada', reading.currency || 'No informada']] : []),
        ...reading.metrics.map(([key, value]) => [METRICS[key] || key, <>{reportedValue(value, reading.currency)}{value?.value != null && value.status === 'estimated' && ' · Estimado'}{value?.value != null && value.precision === 'rounded' && ' · Redondeado'}</>])
      ]}/>
      {reading.history && <p className={styles.warning}>Histórico guardado. No acredita acceso vigente a Meta.</p>}
      {reading.partial && <p className={styles.warning}>Métricas parciales: no son un total completo.</p>}
      {reading.newerPartial && <p className={styles.warning}>La lectura más reciente fue parcial; se conserva la captura completa anterior.</p>}
      {reading.source && <p className={styles.help}>{reading.source}</p>}
      {reading.evidence}
    </article>)}
    {readings.length > 0 && <p className={styles.help}>Impresiones son veces que se mostró el contenido; alcance son personas según esa consulta. Los clics totales no son clics de enlace. Conversaciones y compras atribuidas por Meta no son pedidos reconocidos. No se suman cuentas, alcances ni ventanas.</p>}
    {children}
  </section>;
}

const BUSINESS_REASONS = {
  linked_orders_pending_recognition: 'Hay pedidos pendientes de reconocimiento económico.',
  meta_currency_not_cop: 'La pauta y los pedidos están en monedas distintas; no se convierte ni se resta el gasto.',
  complete_exact_cumulative_spend_unavailable: 'Falta gasto acumulado exacto con cobertura, moneda, ventana y zona compatibles.',
  newer_spend_capture_incomplete: 'La lectura de gasto más reciente está incompleta; se conserva la anterior.',
  meta_spend_stale: 'La lectura de gasto está desactualizada.',
  organic_spend_not_applicable: 'No aplica gasto Meta a una publicación orgánica.',
  canonical_paid_delivery_unavailable: 'Falta una única entrega pagada comprobada para verificar el gasto.',
  approved_spec_unavailable: 'No se pudo verificar la aprobación de la entrega pagada.',
  recognition_date_unknown: 'Falta una fecha real de reconocimiento de venta.',
  product_cost_unknown: 'Falta un costo histórico de producto.',
  product_cost_and_recognition_date_unknown: 'Faltan costos históricos y fechas de venta.',
  gift_cost_unknown: 'Falta un costo histórico de obsequio.',
  gift_dispatch_date_unknown: 'Falta una fecha de despacho de obsequio.',
  recovered_cost_unknown: 'Falta el costo recuperado de una devolución.',
  return_loss_cost_unknown: 'Falta el costo de mercancía devuelta antes del reconocimiento.',
  expense_cost_unknown: 'Falta el importe de un gasto.',
  expense_date_unknown: 'Falta la fecha real de un gasto.',
  shipment_cost_unknown: 'Falta un costo logístico.',
};

function commercialValue(component) {
  if (component?.valueMinor == null) return noData;
  const value = money(component.valueMinor, 'COP');
  return component.complete ? value : `Componente conocido: ${value} · Cobertura incompleta`;
}

export function CommercialSummary({ business, linked = true, error, onRetry, preserved = false }) {
  const id = useId();
  const amounts = business ? socialBusinessAmounts(business) : null;
  const spend = business?.metaSpend;
  const reasons = new Set([...(business?.recognizedProductSales?.reasons || []), ...(business?.contributionAfterAdvertising?.reasons || [])]);
  reasons.delete('no_linked_orders');
  const notices = [...new Set([...reasons].map(reason => BUSINESS_REASONS[reason] || 'Falta acreditar un hecho comercial de los pedidos vinculados.'))];
  return <section className={`${styles.panel} ${styles.stack}`} aria-labelledby={id}>
    <h3 id={id}>Resultado comercial en All Nutrition</h3><p>¿Qué dejaron los pedidos vinculados?</p>
    {!linked ? <p><strong>Sin campaña propia vinculada</strong>. Vínculo no comprobado.</p>
      : error ? <p className={styles.warning}>No se pudo leer el resumen comercial.{onRetry && <> <button type="button" className="text-button" onClick={onRetry}>Reintentar lectura de la ficha propia</button></>}</p>
      : !amounts && <p role="status">Cargando resumen comercial…</p>}
    {amounts && <>
      {preserved && <p className={styles.warning}>Lectura comercial conservada. Falta actualizar antes de tomarla como resultado vigente.</p>}
      {!amounts.orderCount && <p><strong>Sin pedidos vinculados</strong>. No significa que la publicidad haya generado cero ventas.</p>}
      <Facts rows={[
        ['Pedidos vinculados', amounts.orderCount], ['Corte comercial', date(business.accumulatedThrough || business.coverage?.through || business.asOf)],
        ['Ventas netas de producto reconocidas', commercialValue(amounts.sales)],
        ['Contribución antes de pauta', commercialValue(amounts.contribution)],
        ['Gasto acumulado de la entrega en Meta', spend?.valueMinor == null ? noData : <>{money(spend.valueMinor, spend.currency)} · {spend.complete ? 'Verificado' : 'Lectura anterior, no verificada al corte'} · captura {date(spend.fetchedAt)}</>],
        ['Contribución después de pauta', !preserved && amounts.afterAdvertising != null ? money(amounts.afterAdvertising, 'COP') : 'Sin datos como resultado final'],
      ]}/>
      {notices.length > 0 && <ul className={styles.help}>{notices.map(notice => <li key={notice}>{notice}</li>)}</ul>}
      <p>Las ventas netas incluyen créditos y devoluciones; la contribución ya descuenta los costos aplicables. El corte es acumulado e incluye devoluciones reconocidas después de la pauta; el período de Meta no recorta los pedidos.</p>
      <p>Solo se resta una vez el gasto verificado de Meta. Presupuesto, gasto registrado en Caja y pagos son importes separados.</p>
    </>}
    <p className={styles.help}>Sobre pedidos vinculados por el administrador; no demuestra que el anuncio causara estas ventas.</p>
  </section>;
}

export function EconomicRecommendation({ recommendation, business, measurementsAvailable, unpublished, spec, linked = true, linkError }) {
  const id = useId();
  const businessGap = business && (!business.orders.length || business.knownContribution?.complete !== true);
  let tip;
  if (unpublished) tip = 'Confirma el indicador principal del objetivo antes de publicar. El borrador aún no tiene una entrega de la que se pueda obtener evidencia.';
  else if (!measurementsAvailable) tip = 'Comprueba que la cuenta tenga permiso para leer el indicador principal en Meta. La captura disponible no aporta mediciones suficientes para justificar cambios de pauta.';
  else if (linkError) tip = 'Vuelve a leer el resumen de la ficha propia. Sin el corte comercial no se puede comprobar qué dejaron los pedidos vinculados.';
  else if (businessGap) tip = 'Revisa si faltan pedidos por vincular o costos por completar. Sin esos datos no se conoce la contribución comercial; no aumentes el presupuesto por esta lectura.';
  else if (recommendation) {
    const horizon = spec?.mode === 'paid' && spec.startAt && spec.endAt
      ? `en una ventana equivalente a la aprobada (${economicPeriod(spec.startAt, spec.endAt, spec.timeZone)})`
      : spec?.observationDays ? `en los primeros ${spec.observationDays} días` : 'en una ventana comparable';
    tip = <><strong>Observación:</strong> {recommendation.observation}<br/><strong>Qué probar:</strong> {recommendation.proposedChange.text}<br/><strong>Cómo evaluarlo:</strong> {recommendation.successCriterion?.text} Evalúalo {horizon}.</>;
  }
  else if (!linked) tip = 'Comprueba si existe una campaña propia inequívocamente vinculada antes de comparar con pedidos. Las cifras de Meta no demuestran ventas de All Nutrition.';
  else if (!business) tip = 'Comprueba el corte de los pedidos vinculados antes de valorar cambios. El resumen comercial aún no está disponible.';
  else if (business?.metaSpend?.complete !== true && spec?.mode !== 'organic') tip = 'Comprueba el gasto acumulado de la entrega en Meta en la misma ventana y moneda. Sin ese dato no se puede evaluar la contribución después de pauta.';
  else tip = 'Conserva el presupuesto y espera una medición comparable antes de cambiar una variable. Con esta lectura no hay un cambio comprobado que sugerir.';
  return <section className={styles.panel} aria-labelledby={id}><h3 id={id}>Qué conviene probar ahora</h3><p>{tip}</p></section>;
}

const REMOTE_CORE = ['spend', 'impressions', 'clicks', 'reach'];
const REMOTE_OPTIONAL = ['inline_link_clicks', 'link_click', 'post_engagement', 'onsite_conversion.messaging_conversation_started_7d', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

export function MetaCampaignEconomics({ api, item }) {
  const localId = item.localCampaignId;
  const [read, setRead] = useState(null), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!localId) return;
    const controller = new AbortController(), id = encodeURIComponent(localId);
    const options = { signal: controller.signal };
    Promise.allSettled([api(`${ROOT}/results?campaignId=${id}`, options), api(`${ROOT}/campaigns/${id}`, options)]).then(([result, detail]) => {
      if (!controller.signal.aborted) setRead({ localId, business: result.value?.business, businessError: result.status === 'rejected', campaign: detail.value, forecastError: detail.status === 'rejected' });
    });
    return () => controller.abort();
  }, [api, localId, reload]);
  const current = localId && read?.localId === localId ? read : null;
  const business = current?.business, localCampaign = current?.campaign;
  const spec = localCampaign?.revisions?.at(-1)?.spec || localCampaign;
  const forecast = selectSocialEconomicForecast(localCampaign);
  const history = Boolean(item.historical || item.snapshot?.stale);
  const account = [item.accountName, item.ownerId].filter(Boolean).join(' · ');
  const retry = () => { setRead(null); setReload(value => value + 1); };
  const readings = (item.metrics || []).map((metric, index) => {
    const timeZone = metric.period?.timeZone;
    return { id: metric.id || index, paid: true, account, campaignId: item.resourceId,
      period: economicPeriod(metric.period?.since, metric.period?.until, timeZone === 'provider_account_timezone' ? 'Zona de la cuenta en Meta' : timeZone),
      currency: metric.currency, observedAt: metric.observedAt || item.observedAt,
      partial: Boolean(item.coverage && item.coverage.state !== 'accessible_complete' || REMOTE_CORE.some(key => metric.values?.[key]?.value == null)), history,
      source: 'Fuente: Insights de campaña de Meta en la lectura guardada; sin combinar con otras capturas.',
      metrics: [...REMOTE_CORE, ...REMOTE_OPTIONAL.filter(key => metric.values?.[key]?.value != null)].map(key => [key, metric.values?.[key]]) };
  });
  const empty = item.object ? 'Configuración disponible · Sin métricas para este período' : 'Sin datos de métricas para este período';
  return <div className={styles.stack}>
    <InvestmentEstimate key={`${item.ownerId}:${item.resourceId}`} spec={spec} budget={item.observedBudgetMinor} currency={item.accountCurrency} source="Configuración observada"
      forecast={forecast} linked={Boolean(localId)} forecastError={current?.forecastError} forecastPending={Boolean(localId && !current)}
      onForecastRetry={current?.businessError ? undefined : retry} alreadyRan={readings.length > 0}/>
    <MetaReportedPerformance readings={readings} empty={empty} context={!readings.length && <>
      <Facts rows={[['Cuenta publicitaria', account], ['ID de campaña', item.resourceId], ['Período solicitado (sin métricas)', economicPeriod(item.period?.since, item.period?.until)], ['Fecha de la lectura guardada', date(item.observedAt)], ['Gasto reportado', noData]]}/>
      {history && <p className={styles.warning}>Histórico guardado. No acredita acceso vigente a Meta.</p>}
    </>}/>
    <CommercialSummary business={business} linked={Boolean(localId)} error={current?.businessError} onRetry={retry}/>
    <EconomicRecommendation linked={Boolean(localId)} spec={spec} business={business} linkError={current?.businessError}
      measurementsAvailable={readings.some(reading => !reading.history && !reading.partial && reading.metrics.some(([key, value]) => key !== 'spend' && value?.value != null))}/>
  </div>;
}
