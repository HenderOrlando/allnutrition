'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from './Fields';
import useDialog from './useDialog';
import styles from './AdvertisingWorkspace.module.css';

const ROOT = '/api/admin/social';
const metricLabels = {
  spendMinor: 'Gasto reportado', impressions: 'Impresiones', reach: 'Alcance único', linkClicks: 'Clics de enlace',
  conversations: 'Conversaciones WhatsApp', interactions: 'Interacciones', views: 'Visualizaciones', plays: 'Reproducciones',
  likes: 'Me gusta', comments: 'Comentarios', shares: 'Compartidos', saved: 'Guardados', saves: 'Guardados',
  ctrLinkPercent: 'Porcentaje de clics en el enlace (CTR)', cpcLinkMinor: 'Costo por clic en el enlace (CPC)', cpmMinor: 'Costo por mil impresiones (CPM)', frequency: 'Frecuencia',
  costPerConversationMinor: 'Costo por conversación', averageWatchTime: 'Tiempo medio de reproducción',
};
const states = { draft: 'Borrador', ready: 'Preparada, sin activar', queued: 'En cola', preparing: 'Preparando', scheduled: 'Programada', publishing: 'Publicando', partial: 'Resultado parcial', published: 'Publicada', in_review: 'En revisión', active: 'Activa', paused: 'Pausada', completed: 'Finalizada', failed: 'Fallida', needs_attention: 'Requiere atención', uncertain: 'Envío incierto', blocked: 'Bloqueada', cancelled: 'Cancelada', prepared: 'Intención preparada', sent: 'Enviada, sin confirmar', retry_wait: 'En espera', confirmed: 'Confirmada' };
const channels = { facebook: 'Facebook', instagram: 'Instagram', meta_ads: 'Anuncio Meta' };
const scopes = { paid: 'Anuncio pagado', organic: 'Publicación sin inversión', mixed: 'Mixto: no comparable como orgánico' };
const dimensions = { aggregate: 'Agregado del período', daily: 'Evolución diaria', placement: 'Ubicación', age_gender: 'Edad y género', country: 'País' };
const windows = { cumulative: 'Acumulado', recent: 'Período reciente', recent_3d: 'Últimos tres días', previous_3d: 'Tres días anteriores', horizon: 'Horizonte de observación' };
const metricHelp = { reach: 'Personas únicas según esta consulta de la red', impressions: 'Veces que se mostró; una persona puede verlo varias veces', linkClicks: 'Clics en el enlace; no visitas ni ventas confirmadas' };
const RESULT_FILTERS = [['integrationMethod', 'Origen de los datos', { api: 'Conexión oficial de Meta (API)', browser: 'Acceso asistido por navegador' }], ['scope', 'Tipo de resultados', scopes], ['dimension', 'Ver por', dimensions]];
const comparisonStates = { below: 'Debajo del rango', within: 'Dentro del rango', above: 'Encima del rango', in_progress: 'En curso: avance, no evaluación final', not_comparable: 'No comparable' };
const reasonLabels = {
  no_linked_orders: 'Sin pedidos vinculados', linked_orders_pending_recognition: 'Hay pedidos pendientes de reconocimiento económico',
  meta_currency_not_cop: 'La moneda de Meta no es COP', positive_meta_spend_required: 'Se necesita gasto Meta positivo',
  complete_exact_cumulative_spend_unavailable: 'Falta gasto acumulado exacto con cobertura completa',
  newer_spend_capture_incomplete: 'Hay una lectura de gasto más reciente pero incompleta', meta_spend_stale: 'El gasto reportado está desactualizado',
  organic_spend_not_applicable: 'No aplica gasto Meta a una publicación orgánica', missing_denominator_or_numerator: 'Falta numerador o denominador',
  rounded_or_unknown_input: 'Las cifras redondeadas o desconocidas impiden este cálculo', zero_denominator: 'El denominador es cero',
  incomplete_coverage: 'Cobertura incompleta', objective_has_no_conversation_kpi: 'Este objetivo no tiene KPI de conversaciones',
  fewer_than_five_comparable_complete_campaigns: 'Menos de cinco campañas completas comparables',
  external_configuration_change: 'La configuración remota cambió respecto a la aprobación', approved_horizon_mismatch: 'El horizonte no coincide con el aprobado',
  expense_date_unknown: 'Fecha del gasto desconocida', expense_cost_unknown: 'Importe del gasto pendiente',
  expense_payment_date_unknown: 'Fecha del pago desconocida', configuration_not_verified: 'No se pudo verificar la configuración remota',
};
const method = value => value === 'api' ? 'Conexión oficial de Meta (API)' : value === 'browser' ? 'Acceso asistido por navegador' : 'Vía sin informar';
const label = key => metricLabels[key] || key;
const reasonText = value => typeof value === 'string' ? reasonLabels[value] || value : value?.reason ? `${value.metric ? label(value.metric) + ': ' : ''}${reasonLabels[value.reason] || value.reason}${value.sampleCount != null ? ` (${value.sampleCount} muestras)` : ''}` : JSON.stringify(value);
const text = value => value == null || value === '' ? 'Sin dato' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const number = value => value == null || !Number.isFinite(value) ? 'Sin dato' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 8 }).format(value);
function money(value, currency) {
  if (value == null || !Number.isFinite(value)) return 'Sin dato';
  if (!currency) return `${number(value)} centésimas · moneda desconocida`;
  return `${currency} ${new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)}`;
}
function date(value, timeZone = 'America/Bogota') {
  if (!value) return 'Sin fecha';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return text(value);
  try { return `${new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(parsed)} (${timeZone})`; }
  catch { return parsed.toISOString(); }
}
function age(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'Antigüedad desconocida';
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 1440)} días ${Math.floor(minutes % 1440 / 60)} h`;
}
function metricValue(metric, currency) {
  if (!metric || metric.value == null) return 'No disponible';
  if (metric.precision === 'rounded' && metric.displayValue) return metric.displayValue;
  if (metric.unit === 'minor_currency') return money(metric.value, currency);
  return `${number(metric.value)}${metric.unit === 'percent' ? '%' : metric.unit === 'seconds' ? ' s' : metric.unit === 'milliseconds' ? ' ms' : ''}`;
}
function Reasons({ values = [] }) {
  return values.length ? <ul className={styles.help}>{[...new Set(values.map(reasonText))].map(value => <li key={value}>{value}</li>)}</ul> : null;
}
function Facts({ rows }) {
  return <dl className={`summary-values ${styles.summaryGrid}`}>{rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd style={{ overflowWrap: 'anywhere' }}>{value == null ? 'Sin dato' : value}</dd></div>)}</dl>;
}
function Metric({ value, currency }) {
  return <><strong>{metricValue(value, currency)}</strong>{value && <small className={styles.help}>{value.status === 'estimated' ? 'Estimado' : value.status === 'reported' ? 'Reportado' : value.status === 'unsupported' ? 'No soportado' : 'No disponible'} · {value.precision === 'exact' ? 'Precisión exacta de lectura' : value.precision === 'rounded' ? 'Redondeado; no apto para ratios exactos' : 'Precisión desconocida'}</small>}{value?.reason && <small className={styles.help}>{reasonText(value.reason)}</small>}{value && <details className={styles.evidence}><summary>Evidencia de la métrica</summary><p>Definición original: {value.sourceMetric || 'Sin definición acreditada'} · Unidad técnica: {value.unit || 'Sin unidad informada'}</p></details>}</>;
}
function Measurement({ item, delivery, onCampaign }) {
  const [rowPage, setRowPage] = useState(1);
  useEffect(() => setRowPage(1), [item.id]);
  const visibleRows = (item.rows || []).slice((rowPage - 1) * 20, rowPage * 20);
  const metrics = Object.entries(item.values || {}), ratioEntries = Object.entries(item.ratios || {});
  const rowKeys = [...new Set((item.rows || []).flatMap(row => Object.keys(row.values || {})))];
  return <article className={styles.card} id={`social-measurement-${item.id}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <header><p className={styles.eyebrow}>{method(item.integrationMethod)} · {scopes[item.scope] || item.scope}</p><h3>{channels[delivery?.channel] || item.entity?.type || 'Medición'} · {dimensions[item.dimension] || item.dimension}</h3></header>
    {onCampaign && delivery && <button type="button" className="text-button" onClick={() => onCampaign(delivery.campaignId)}>Abrir publicación de esta entrega</button>}
    <p>{date(item.periodStart, item.timeZone)} — {date(item.periodEnd, item.timeZone)} · {windows[item.query?.window] || item.query?.window || 'Ventana sin informar'}{item.query?.horizon ? ` · horizonte ${item.query.horizon} días` : ''} · Moneda: {item.currency || 'No informada'}</p>
    <p className={styles.muted}>Capturada {date(item.fetchedAt)} · antigüedad {age(item.ageMilliseconds)}. El proveedor puede retrasar datos hasta {item.providerDelayHours ?? 48} horas; captura no equivale a fecha de interacción.</p>
    {item.stale && <p className={styles.warning} role="status">Datos desactualizados. No se acredita una lectura reciente.</p>}
    {!item.coverage?.complete && <p className={styles.warning}>Cobertura parcial: no tratar esta captura como total completo.</p>}
    {item.newerPartial && <p className={styles.warning}>Se conserva la última captura completa del {date(item.fetchedAt)}. El intento más reciente ({date(item.latestAttempt?.fetchedAt)}) es parcial y no reemplaza estos valores por cero.</p>}
    <Reasons values={item.coverage?.reasons || []}/>
    {!!metrics.length && <div className={styles.metricGrid}>{metrics.map(([key, value]) => <div key={key}><h4>{label(key)}</h4>{metricHelp[key] && <p className={styles.help}>{metricHelp[key]}</p>}<div className={styles.metricValue}><Metric value={value} currency={item.currency}/></div></div>)}</div>}
    {!!ratioEntries.length && <details><summary>Ratios de esta misma consulta</summary><div className={styles.metricGrid}>{ratioEntries.map(([key, value]) => <div key={key}><h4>{label(key)}</h4><Metric value={value} currency={item.currency}/></div>)}</div><p className={styles.help}>CTR de enlace usa clics de enlace / impresiones, no todos los clics. Los ratios no combinan ventanas ni cifras redondeadas.</p></details>}
    {item.dimension !== 'aggregate' && (item.rows?.length ? <><div className={styles.tableWrap} tabIndex={0} role="region" aria-label={`Desglose ${dimensions[item.dimension] || item.dimension}`} style={{ maxWidth: '100%', overflowX: 'auto' }}><table className={styles.table}><caption>{dimensions[item.dimension]} · {item.coverage?.complete ? 'Cobertura completa' : 'Cobertura parcial'} · sin sumar alcance ni frecuencias</caption><thead><tr><th scope="col">Dimensión / período</th>{rowKeys.map(key => <th scope="col" key={key}>{label(key)}{metricHelp[key] && <small className={styles.help}>{metricHelp[key]}</small>}</th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={`${JSON.stringify(row.dimensions)}-${row.periodStart}-${index}`}><th scope="row">{Object.entries(row.dimensions || {}).map(([key, value]) => `${key}: ${text(value)}`).join(' · ') || 'Sin dimensión'}<small className={styles.help}>{date(row.periodStart, item.timeZone)} — {date(row.periodEnd, item.timeZone)}</small></th>{rowKeys.map(key => <td key={key}><Metric value={row.values?.[key]} currency={item.currency}/></td>)}</tr>)}</tbody></table></div><div className={styles.pagination}><button type="button" className="button subtle" disabled={rowPage <= 1} onClick={() => setRowPage(value => value - 1)}>Filas anteriores</button><span>Filas {(rowPage - 1) * 20 + 1}–{Math.min(rowPage * 20, item.rows.length)} de {item.rows.length}</span><button type="button" className="button subtle" disabled={rowPage * 20 >= item.rows.length} onClick={() => setRowPage(value => value + 1)}>Filas siguientes</button></div></> : <p>No hay filas disponibles para este desglose; no equivale a cero.</p>)}
    {!metrics.length && item.dimension === 'aggregate' && <p>No hay métricas agregadas disponibles para esta consulta.</p>}
    <details className={styles.evidence}><summary>Definición, cobertura y evidencia de esta captura</summary>
      <Facts rows={[["ID de captura", item.id], ["Entrega", item.deliveryId], ["Definición", item.definitionVersion], ["Adaptador", item.adapterVersion], ["Versión API", item.apiVersion || 'No aplica al navegador'], ["Moneda", item.currency], ["Zona de la consulta", item.timeZone], ["Atribución", text(item.attributionSetting)], ["Momento de acciones", item.actionReportTime], ["Cobertura", text(item.coverage)], ["Selección de lectura", item.selectedReason], ["Filtro de período", text(item.selection)], ["Origen técnico", text(item.evidence)]]}/>
      <p>No se suman personas entre días, redes o campañas. Visualizaciones, impresiones y reproducciones son conceptos distintos. No se completa esta vía con datos de otra integración.</p>
    </details>
  </article>;
}
function ApprovedCampaign({ campaign, onNavigate }) {
  const approved = campaign.revisions?.at(-1), spec = approved?.spec, forecast = approved?.forecast;
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => setPreviewError(false), [spec?.assetId, spec?.assetHash]);
  if (!spec) return <section className={styles.panel}><h3>Sin configuración aprobada</h3><p>Este borrador aún no acredita publicación ni inversión. La configuración editable no se presenta como una revisión aprobada.</p><button type="button" className="button subtle" onClick={() => onNavigate?.({ section: 'advertising', tab: 'campaigns', record: campaign.id })}>Abrir borrador</button></section>;
  const matchingAsset = campaign.asset?.id === spec.assetId && campaign.asset.sha256 === spec.assetHash;
  return <section className={styles.panel} style={{ minWidth: 0 }}><h3>Configuración aprobada · Solo lectura</h3>
    <p>Revisión {approved.revision} · {spec.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'} · {(spec.platforms || []).map(value => channels[value] || value).join(', ')}. Aprobó {approved.actorId} · {date(approved.approvedAt)}. Una corrección requiere otro borrador.</p>
    <details className={styles.technicalDetails}><summary>Ver configuración aprobada</summary>
    {matchingAsset && !previewError && campaign.asset.state !== 'missing_file' ? <div className={styles.assetPreview}>{spec.assetType === 'video' ? <video className={styles.previewVideo} controls preload="metadata" src={`${ROOT}/assets/${encodeURIComponent(spec.assetId)}/content?variant=derivative`} onError={() => setPreviewError(true)} aria-label="Video preparado aprobado"/> : <img className={styles.previewImage} src={`${ROOT}/assets/${encodeURIComponent(spec.assetId)}/content?variant=derivative`} alt={`Imagen preparada aprobada: ${spec.name}`} onError={() => setPreviewError(true)}/>}</div> : <p className={styles.warning}>Vista previa aprobada no disponible o hash del archivo no coincidente. Se conserva su historia, sin sustituirla por otro archivo.</p>}
    <Facts rows={[["Conexión", method(spec.integrationMethod)], ["Tipo de publicación", spec.mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión'], ["Objetivo", { whatsapp: 'Consultas por WhatsApp', traffic: 'Clics de enlace a web, no visitas confirmadas', reach: 'Alcance', engagement: 'Interacción' }[spec.objective] || spec.objective], ["Redes", (spec.platforms || []).map(value => channels[value] || value).join(', ')], ["Ubicaciones", (spec.placements || []).join(', ')], ["Identidades verificadas", text(spec.identities)], ["Imagen o video / SHA-256 del derivado", `${spec.assetId} / ${spec.assetHash}`], ["Texto", spec.caption], ["Título o llamada a la acción", spec.headline], ["Destino", spec.destinationUrl || spec.whatsappNumber], ["Presupuesto total, no diario", spec.mode === 'paid' ? money(spec.budgetMinor, spec.currency) : 'Sin inversión'], ["Inicio", date(spec.startAt || spec.publishAt, spec.timeZone)], ["Fin", spec.mode === 'paid' ? date(spec.endAt, spec.timeZone) : `Observación ${spec.observationDays} días, sin borrado automático`], ["Divulgación de IA", spec.aiDisclosure === true ? 'Declarada' : spec.aiDisclosure === false ? 'Sin IA declarado' : 'Sin dato']]}/>
    {spec.timeZone && spec.timeZone !== 'America/Bogota' && <p>En Bogotá: {date(spec.startAt || spec.publishAt)} — {date(spec.endAt)}.</p>}
    <details><summary>Audiencia y aceptación conservadas</summary><p style={{ overflowWrap: 'anywhere' }}>{spec.mode === 'paid' ? text(spec.audience) : 'Distribución pública de la página/cuenta; sin segmentación comprada ni alcance garantizado.'}</p><Facts rows={[["Advertencias aceptadas", text(approved.acceptedWarnings)], ["Derechos de imagen o video/audio", approved.rightsAccepted ? 'Aceptados' : 'Sin acreditación'], ["Hash de especificación", approved.specHash], ["Estimación conservada", approved.forecastId]]}/></details>
    {forecast && <details><summary>Estimación aprobada: fuentes separadas</summary><h4>Audiencia potencial de Meta</h4><p>No es alcance comprado, entrega garantizada ni pronóstico de ventas.</p><Facts rows={[["Fuente / fecha", `${forecast.audienceEstimate?.source || 'Sin fuente'} · ${date(forecast.audienceEstimate?.fetchedAt)}`], ["Rango y definición original", text(forecast.audienceEstimate)]]}/><h4>Historial comparable</h4><p>{forecast.sampleCount ?? 0} publicaciones en la cohorte general. Los mínimos y muestras se verifican por métrica, no se completan con una hipótesis manual. No se analizó visualmente la imagen o video.</p><Reasons values={forecast.unavailableReasons || []}/><Reasons values={forecast.assumptions || []}/>{Object.entries(forecast.metricRanges || {}).map(([key, range]) => <p key={key}>{label(range.metric || key)} · {channels[range.channel] || range.channel}: rango habitual (25 %–75 %) {number(range.lower)}–{number(range.upper)}, mediana (valor central) {number(range.median)} · {range.sampleCount} muestras. Mitad central de los resultados comparables; no es una probabilidad de éxito.</p>)}<h4>Hipótesis declarada por el usuario</h4>{forecast.manualScenario ? <p>{label(forecast.manualScenario.metric)}: {number(forecast.manualScenario.lower)}–{number(forecast.manualScenario.upper)}. Fundamento: {forecast.manualScenario.basis}. No es predicción del sistema ni tiene mediana inferida.</p> : <p>Sin hipótesis declarada.</p>}</details>}
    </details>
  </section>;
}
function Comparisons({ analysis, currency, stale }) {
  return <section className={styles.panel}><h3>Estimación aprobada frente a resultados</h3>{stale && <p className={styles.warning}>Evaluación obsoleta o pendiente. Las conclusiones conservadas no se presentan como vigentes.</p>}<p>Se compara únicamente el mismo horizonte, definición, alcance y moneda. Una pauta en curso muestra avance, no un fallo contra todo su presupuesto.</p>
    {analysis?.comparisons?.length ? <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Comparación de previsión aprobada" style={{ maxWidth: '100%', overflowX: 'auto' }}><table className={styles.table}><caption>Rangos históricos congelados en la aprobación · análisis {date(analysis.asOf)}</caption><thead><tr><th scope="col">Métrica / red</th><th scope="col">Rango / mediana</th><th scope="col">Reportado</th><th scope="col">Diferencia frente a mediana</th><th scope="col">Comparabilidad y evidencia</th></tr></thead><tbody>{analysis.comparisons.map((entry, index) => <tr key={`${entry.metric}-${entry.channel}-${index}`}><th scope="row">{label(entry.metric)}<small className={styles.help}>{channels[entry.channel] || entry.channel}</small></th><td>{number(entry.forecastRange?.lower)}–{number(entry.forecastRange?.upper)}<small className={styles.help}>Mediana {number(entry.forecastRange?.median)} · {entry.forecastRange?.sampleCount ?? 'Sin dato'} muestras</small></td><td><Metric value={entry.reported} currency={currency}/>{entry.spendMinor && <small className={styles.help}>Gasto observado: {metricValue(entry.spendMinor, currency)}</small>}</td><td>{entry.differenceAbsolute == null ? 'No disponible' : number(entry.differenceAbsolute)}{entry.differencePercent != null && entry.forecastRange?.median !== 0 && <small className={styles.help}>{number(entry.differencePercent)}%</small>}</td><td>{comparisonStates[entry.status] || entry.status}<Reasons values={entry.reasons || []}/><details><summary>Ventana y capturas</summary><p>{date(entry.periodStart)} — {date(entry.periodEnd)}</p><p>Captura {date(entry.fetchedAt)}{entry.captureAgeMilliseconds != null ? ` · edad al horizonte ${age(entry.captureAgeMilliseconds)}` : ''}</p><EvidenceIds ids={entry.measurementIds}/><p>Muestras: {(entry.forecastRange?.sampleIds || []).join(', ') || 'Sin muestras'}</p></details></td></tr>)}</tbody></table></div> : <p>No hay una comparación histórica disponible. {analysis?.source === 'manual' ? 'El escenario del usuario se conserva separado, sin inventar una mediana.' : 'Se necesita una previsión aprobada y evidencia comparable.'}</p>}
    <Reasons values={analysis?.unavailableReasons || []}/>
  </section>;
}
function EvidenceIds({ ids = [] }) {
  return ids.length ? <ul>{ids.map(id => <li key={id}><a href={`#social-measurement-${id}`}>{id}</a></li>)}</ul> : <p>Sin capturas identificadas.</p>;
}
function UserCostTarget({ campaign, measurements }) {
  if (campaign.targetCostMinor == null) return null;
  const approved = campaign.revisions?.at(-1)?.spec;
  const ratioKey = { traffic: 'cpcLinkMinor', whatsapp: 'costPerConversationMinor' }[approved?.objective];
  const readings = ratioKey ? measurements.filter(item => item.scope === 'paid' && item.dimension === 'aggregate' && item.query?.window === 'cumulative' && item.integrationMethod === approved.integrationMethod && item.currency === approved.currency && item.ratios?.[ratioKey]) : [];
  return <section className={styles.panel}><h3>Meta de costo definida por el usuario</h3><p>{money(campaign.targetCostMinor, campaign.currency)} por resultado. No es un benchmark de mercado ni un compromiso de entrega.</p>{readings.length ? readings.map(item => <div key={item.id}><h4>{label(ratioKey)}</h4><Metric value={item.ratios[ratioKey]} currency={item.currency}/><p>{date(item.periodStart, item.timeZone)} — {date(item.periodEnd, item.timeZone)} · captura {date(item.fetchedAt)}{item.stale || item.newerPartial ? ' · lectura anterior o desactualizada, no evaluación vigente' : ''}</p><EvidenceIds ids={[item.id]}/></div>) : <p>No hay un costo por resultado reportado compatible en esta selección. No se sustituye por CPM, clics de otro tipo ni un cálculo entre ventanas diferentes.</p>}</section>;
}
function BusinessAmount({ title, description, value, currency, stale = false }) {
  return <article className={styles.card}><h4>{title}</h4>{description && <p className={styles.help}>{description}</p>}<strong className={styles.metricValue}>{money(value?.valueMinor ?? value?.amountMinor, value?.currency || currency)}</strong>{value && value.complete === false && <><p className={styles.warning}>Cobertura incompleta; no es un total definitivo.</p>{value.knownMinor != null && <p>Componente conocido: {money(value.knownMinor, value.currency || currency)}</p>}</>}{stale && <p className={styles.warning}>Evaluación conservada, pendiente de actualización.</p>}<Reasons values={value?.reasons || []}/></article>;
}
function BusinessPanel({ business, stale, onNavigate, links, onLink }) {
  if (!business) return null;
  const financialCurrent = !stale && business.coverage?.complete === true;
  const returnKnown = financialCurrent && business.metaSpend?.currency === 'COP' && business.metaSpend?.complete === true && business.metaSpend.valueMinor > 0 && business.declaredReturn?.complete === true && business.declaredReturn.value != null;
  const contributionKnown = !stale && business.knownContribution?.complete === true && business.metaSpend?.complete === true && business.metaSpend.currency === 'COP' && business.contributionAfterAdvertising?.complete === true;
  return <section className={styles.panel}><h3>Pedidos y gastos vinculados</h3><p><strong>Origen declarado por el administrador · acumulado de pedidos vinculados al corte {date(business.asOf)}.</strong> Independiente del filtro de fechas de las métricas sociales y del fin del anuncio; incluye devoluciones y hechos posteriores reconocidos al corte.</p>
    <p>Revisión contable de esta lectura: {business.businessRevision ?? 'Sin dato'}. No prueba causalidad, atribución de Meta ni ventas producidas por la imagen o video.</p>
    {stale && <p className={styles.warning} role="status">La evaluación comercial está obsoleta o tiene vínculos/finanzas pendientes de recalcular. No tomar el retorno ni la recomendación financiera conservada como vigentes.</p>}
    {business.coverage?.noLinkedOrders && <p className={styles.notice}>Sin pedidos vinculados. No se afirma que la publicidad haya causado cero ventas.</p>}
    <h4>Cuatro magnitudes independientes</h4><div className={styles.metricGrid}><BusinessAmount title="Presupuesto total autorizado" description="Total que autorizaste, no gasto ni pago realizado." value={business.budget} currency={business.budget?.currency}/><BusinessAmount title="Gasto acumulado reportado por Meta" description="Importe informado por la plataforma." value={business.metaSpend} currency={business.metaSpend?.currency}/><BusinessAmount title="Gastos publicitarios registrados y vinculados" description="Documentos registrados en Caja." value={business.registeredAdvertising} currency="COP"/><BusinessAmount title="Pagos de esos gastos" description="Dinero pagado de esos documentos." value={business.advertisingPayments} currency="COP"/></div>
    <p className={styles.help}>No se suman ni se descuentan juntos estos cuatro importes. Sincronizar no registra gastos ni pagos; un gasto compartido no se reparte automáticamente.</p>
    <p>Gasto Meta al {date(business.metaSpend?.asOf)}, capturado {date(business.metaSpend?.fetchedAt)} · {method(business.metaSpend?.integrationMethod)}.{business.metaSpend?.newerPartial ? ' Se conserva una lectura anterior: la más reciente es parcial.' : ''}</p>
    <div className={styles.metricGrid}><BusinessAmount title="Ventas netas de producto reconocidas" value={business.recognizedProductSales} currency="COP"/><BusinessAmount title="Contribución conocida de los pedidos" value={business.knownContribution} currency="COP"/><BusinessAmount title="Cobros de pedidos vinculados" value={business.collections} currency="COP"/></div>
    <Facts rows={[["Retorno declarado al corte", returnKnown ? `${number(business.declaredReturn.value)} veces` : 'No disponible con la cobertura/moneda actual'], ["Contribución después de pauta", contributionKnown ? money(business.contributionAfterAdvertising.valueMinor, 'COP') : 'No disponible como resultado final']]}/>
    <p>Retorno declarado = ventas netas de productos reconocidas / gasto Meta positivo, únicamente COP y cobertura completa; no es ROAS atribuido por Meta ni utilidad. La contribución posterior resta el gasto Meta una sola vez, sin descontar otra vez los gastos registrados vinculados.</p>
    <Reasons values={business.declaredReturn?.reasons || []}/><Reasons values={business.contributionAfterAdvertising?.reasons || []}/><Reasons values={business.coverage?.reasons || []}/>
    <h4>Vínculos y trazabilidad</h4><div className={styles.actions}><button type="button" className="button subtle" onClick={() => onLink('order')}>Vincular pedido existente</button><button type="button" className="button subtle" onClick={() => onLink('expense')}>Vincular gasto publicitario existente</button><button type="button" className="button subtle" onClick={() => onNavigate?.({ section: 'cash', tab: 'expenses', category: 'advertising' })}>Consultar gastos en Caja</button></div>
    {['order', 'expense'].map(kind => <div key={kind}><h4>{kind === 'order' ? 'Pedidos vinculados' : 'Gastos vinculados'}</h4>{!(links?.[kind === 'order' ? 'orders' : 'expenses'] || business[kind === 'order' ? 'orders' : 'expenses'] || []).length && <p>Sin {kind === 'order' ? 'pedidos' : 'gastos'} vinculados.</p>}{(links?.[kind === 'order' ? 'orders' : 'expenses'] || business[kind === 'order' ? 'orders' : 'expenses'] || []).map(record => <article className={styles.card} key={record.id}><h5>{kind === 'order' ? `Pedido ${record.number}` : record.concept || 'Gasto publicitario'}</h5><p>{kind === 'order' ? `${states[record.status] || record.status} · ${record.pendingRecognition ? 'Reconocimiento pendiente; no es venta reconocida' : `Reconocimiento ${record.recognitionOn || 'Sin fecha'}`}` : `${money(record.amountMinor, 'COP')} · ${record.incurredOn || 'Fecha desconocida'}${record.costPending ? ' · costo pendiente' : ''}`}</p><p>Etiqueta histórica, sin atribución automática: {record.marketingCampaign || record.campaign || 'Sin etiqueta'}</p><p>Origen declarado por {record.link?.actorId || 'Sin actor'} · {date(record.link?.updatedAt || record.link?.createdAt)} · versión de vínculo {record.link?.version ?? 'Sin dato'}</p><p>Motivo: {record.link?.reason || 'Sin motivo'}</p><div className={styles.actions}><button type="button" className="button subtle" onClick={() => onNavigate?.(kind === 'order' ? { section: 'orders', record: record.id } : { section: 'cash', tab: 'expenses', record: record.id, category: 'advertising' })}>Abrir {kind === 'order' ? 'pedido' : 'gasto en Caja'}</button><button type="button" className="button subtle" disabled={!record.link?.version} onClick={() => onLink(kind, record)}>Rectificar o retirar vínculo</button></div></article>)}</div>)}
    <details className={styles.evidence}><summary>Hechos y cobertura comercial</summary><Facts rows={[["Inicio económico conocido", business.coverage?.economicStartOn], ["Corte acumulado", business.accumulatedThrough || business.coverage?.through], ["Versiones de vínculos", text(business.linkVersions)], ["Hash de hechos", business.factHash], ["Hechos de ventas", text(business.recognizedProductSales?.factIds)], ["Hechos de contribución", text(business.knownContribution?.factIds)], ["Pagos de gastos", text(business.advertisingPayments?.payments)]]}/><EvidenceIds ids={business.metaSpend?.measurementIds}/></details>
  </section>;
}
function Recommendations({ analysis, stale, commercialStale, onAction, onAnalyze, busy, measurements }) {
  const recommendations = [...new Map((analysis?.recommendations || []).map(item => [item.ruleKey, item])).values()].slice(0, 5);
  return <section className={styles.panel}><div className={styles.toolbar}><h3>Ideas para tu próxima publicación</h3><button type="button" className="button subtle" disabled={busy} onClick={onAnalyze}>Solicitar análisis local</button></div>
    <p>Observaciones e hipótesis, no explicaciones causales. Ninguna idea genera la imagen o video ni aumenta presupuesto o publica automáticamente.</p>
    <p>Estado: {{ current: 'Actualizado', stale: 'Desactualizado', pending: 'Pendiente', unavailable: 'No disponible' }[analysis?.status || 'unavailable'] || analysis.status} · corte {date(analysis?.asOf)}{analysis?.job ? ` · procesamiento ${states[analysis.job.state] || analysis.job.state} · próxima ejecución ${date(analysis.job.nextRunAt)}` : ''}</p>
    {analysis?.job?.errorCode && <p className={styles.warning}>Error del análisis: {analysis.job.errorCode}. Se conserva la evaluación anterior.</p>}
    {stale && <p className={styles.warning}>Análisis obsoleto o en curso; esperar recalculo antes de aplicar propuestas conservadas.</p>}
    {!recommendations.length && <p>{analysis?.status === 'current' ? 'No hay una propuesta específica sustentada en esta evaluación. Una próxima prueba debe cambiar una sola variable; no se promete un porcentaje de mejora.' : 'Aún no hay una evaluación vigente con propuestas. Los datos faltantes no justifican aumentar inversión.'}</p>}
    {recommendations.map(item => {
      const obsolete = stale || item.ruleKey === 'declared_return_gap' && commercialStale;
      return <article className={styles.card} key={item.id} style={{ overflowWrap: 'anywhere' }}><h4>{text(item.observation)}</h4><p className={styles.eyebrow}>Prioridad {item.priority} · {{ suggested: 'Idea disponible', dismissed: 'Descartada', applied: 'Usada en un borrador' }[item.state] || item.state}</p>{obsolete && <p className={styles.warning}>Idea conservada, no vigente: depende de una evaluación pendiente u obsoleta.</p>}<p><strong>Hipótesis:</strong> {text(item.hypothesis)}</p><p><strong>Próximo cambio:</strong> {text(item.proposedChange?.text || item.proposedChange)}</p><p><strong>Criterio de éxito:</strong> {text(item.successCriterion?.text || item.successCriterion)}</p><Reasons values={item.limitations || []}/>{item.conclusion && <p>Evaluación: {{ improved: 'Mejoró según el criterio y evidencia compatible', not_improved: 'No mejoró según el criterio', inconclusive: 'Inconclusa' }[item.conclusion] || item.conclusion}. {text(item.evaluation)}</p>}
        <details className={styles.evidence}><summary>Ver evidencia y cohortes</summary><Facts rows={[["Regla", item.ruleKey], ["Versión de análisis", item.analysisVersion], ["Hash de evidencia", item.evidenceHash], ["Publicaciones de muestra", (item.sampleIds || []).join(', ') || 'Sin muestras'], ["Evaluación", text(item.evaluation)]]}/><EvidenceIds ids={item.metricIds}/>{(item.metricIds || []).map(id => { const capture = measurements.find(value => value.id === id); return capture ? <p key={id}>{id}: {date(capture.periodStart, capture.timeZone)} — {date(capture.periodEnd, capture.timeZone)} · {method(capture.integrationMethod)} · {capture.definitionVersion} · {date(capture.fetchedAt)}</p> : <p key={id}>{id}: captura de evidencia fuera de la selección actual de métricas; su ausencia en este filtro no significa cero.</p>; })}{(item.sampleIds || []).map(id => <p key={id}><button type="button" className="text-button" onClick={() => onAction({ type: 'open-sample', campaignId: id })}>Abrir publicación de muestra {id}</button></p>)}</details>
        {item.state === 'suggested' && <div className={styles.actions}><button type="button" className="button primary" disabled={busy || obsolete} onClick={() => onAction({ type: 'duplicate-from-recommendation', recommendation: item })}>Crear borrador con esta idea</button><button type="button" className="button subtle" disabled={busy} onClick={() => onAction({ type: 'dismiss', recommendation: item })}>Descartar con motivo</button></div>}
      </article>;
    })}
  </section>;
}
function ResultActionDialog({ action, campaignId, api, requestIds, onClose, onSaved, onInteractionStateChange }) {
  const ref = useRef(null), errorRef = useRef(null), controllers = useRef(new Set()), mounted = useRef(true), searchSequence = useRef(0);
  const [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [search, setSearch] = useState({ q: '', page: 1 }), [candidates, setCandidates] = useState(null), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const initialRecord = action.record ? { ...action.record, recordId: action.record.id, link: { ...action.record.link, campaignId } } : null;
  const [selected, setSelected] = useState(initialRecord), [unlink, setUnlink] = useState(false);
  const isLink = action.type === 'link', dirty = Boolean(reason || acknowledged || selected?.recordId !== initialRecord?.recordId || unlink);
  const close = useDialog(ref, { busy, dirty, onClose });
  useEffect(() => { onInteractionStateChange({ dirty, busy }); }, [dirty, busy, onInteractionStateChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); onInteractionStateChange({ dirty: false, busy: false }); }; }, [onInteractionStateChange]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (!isLink) return;
    const controller = new AbortController(), sequence = ++searchSequence.current;
    controllers.current.add(controller); setSearching(true); setSearchError('');
    api(`${ROOT}/campaigns/${encodeURIComponent(campaignId)}/links?${new URLSearchParams({ kind: action.kind, q: search.q, page: String(search.page) })}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && sequence === searchSequence.current) setCandidates(result.candidates);
    }).catch(cause => { if (cause.name !== 'AbortError' && !controller.signal.aborted && sequence === searchSequence.current) setSearchError(cause.message); }).finally(() => { controllers.current.delete(controller); if (!controller.signal.aborted && sequence === searchSequence.current) setSearching(false); });
    return () => controller.abort();
  }, [api, campaignId, isLink, action.kind, search]);
  const title = isLink ? action.record ? 'Rectificar vínculo declarado' : `Vincular ${action.kind === 'order' ? 'pedido' : 'gasto publicitario'} existente` : action.type === 'dismiss' ? 'Descartar propuesta con motivo' : 'Crear borrador con esta idea';
  const changingOrigin = selected?.link?.campaignId && selected.link.campaignId !== campaignId;
  async function submit(event) {
    event.preventDefault();
    if (busy || isLink && !selected) return;
    if ((isLink || action.type === 'dismiss') && !reason.trim()) { setError('Escribe un motivo para conservar la trazabilidad.'); return; }
    if (!acknowledged) { setError('Confirma explícitamente el alcance de esta acción.'); return; }
    const body = isLink ? { kind: action.kind, recordId: selected.recordId, campaignId: unlink ? null : campaignId, version: selected.link?.version ?? 0, reason: reason.trim() } : { action: action.type, version: action.recommendation.version, ...(action.type === 'dismiss' ? { reason: reason.trim() } : {}) };
    const path = isLink ? `${ROOT}/campaigns/${encodeURIComponent(campaignId)}/links` : `${ROOT}/recommendations/${encodeURIComponent(action.recommendation.id)}/actions`;
    const key = `${path}:${JSON.stringify(body)}`;
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    const controller = new AbortController(); controllers.current.add(controller); setBusy(true); setError('');
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify({ ...body, requestId: requestIds.current.get(key) }), signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      requestIds.current.delete(key);
      await onSaved(result, isLink ? 'link' : action.type);
    } catch (cause) { if (cause.name !== 'AbortError' && mounted.current && !controller.signal.aborted) setError(`${cause.message}${cause.status === 409 ? ' El registro cambió: cierra y vuelve a abrir para revisar su versión actual.' : ' Si la respuesta se perdió, reintentar la misma acción conserva su identificador; no se crea otra intención.'}`); }
    finally { controllers.current.delete(controller); if (mounted.current) setBusy(false); }
  }
  return <dialog ref={ref} className={styles.dialog} aria-labelledby="social-results-action-title" style={{ maxWidth: 'min(48rem, calc(100vw - 2rem))', overflowWrap: 'anywhere' }}><header className={styles.dialogHeader}><h2 id="social-results-action-title">{title}</h2><button type="button" className="button subtle" onClick={close} disabled={busy}>Cerrar</button></header><div className={styles.dialogBody}>
    {isLink && <><p>Origen declarado por el administrador, no atribución automática. No cambia etiquetas históricas ni crea pedidos, gastos o pagos. Un registro solo puede pertenecer a una campaña.</p><form method="post" onSubmit={event => { event.preventDefault(); setSearch({ q: query.trim(), page: 1 }); }}><div className={styles.fieldGrid}><Field field={{ name: 'linkSearch', label: action.kind === 'order' ? 'Buscar por número o etiqueta histórica' : 'Buscar por concepto o etiqueta histórica', max: 200 }} value={query} onChange={setQuery}/><button type="submit" className="button subtle" disabled={busy || searching}>Buscar registros</button></div></form>
      {searching && <p role="status">Consultando candidatos locales…</p>}{searchError && <p role="alert" className={styles.error}>{searchError} Los candidatos anteriores no se consideran una búsqueda nueva.</p>}
      {candidates && <><p>Resultados para «{candidates.q || 'todos'}» · página {candidates.page} · {candidates.total} registros.</p><div className={styles.choiceList}>{candidates.items.map(item => <article className={styles.card} key={item.recordId}><p><strong>{action.kind === 'order' ? `Pedido ${item.number}` : item.concept}</strong> · {money(item.totalMinor ?? item.amountMinor, 'COP')}</p><p>Etiqueta histórica: {item.marketingCampaign || item.campaign || 'Sin etiqueta'}. No crea vínculo por coincidencia.</p>{item.link && <p>Vínculo actual: {item.link.campaignName || item.link.campaignId} · versión {item.link.version} · {item.link.actorId} · {date(item.link.updatedAt)} · motivo: {item.link.reason}</p>}<button type="button" className="button subtle" disabled={busy || searching || Boolean(searchError)} aria-pressed={selected?.recordId === item.recordId} onClick={() => { setSelected(item); setUnlink(false); setAcknowledged(false); }}>{item.link?.campaignId && item.link.campaignId !== campaignId ? 'Cambiar vínculo a esta campaña' : item.link ? 'Rectificar vínculo de esta campaña' : 'Seleccionar para vincular'}</button></article>)}</div>{!candidates.items.length && <p>No hay registros coincidentes elegibles. Los gastos candidatos pertenecen únicamente a Publicidad.</p>}<div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || searching || candidates.page <= 1} onClick={() => setSearch({ q: candidates.q, page: candidates.page - 1 })}>Anterior</button><button type="button" className="button subtle" disabled={busy || searching || candidates.page * candidates.pageSize >= candidates.total} onClick={() => setSearch({ q: candidates.q, page: candidates.page + 1 })}>Siguiente</button></div></>}
    </>}
    <form method="post" onSubmit={submit} aria-busy={busy} className={styles.stack}>
      {error && <div role="alert" tabIndex={-1} ref={errorRef} className={styles.error}>{error}</div>}
      <fieldset disabled={busy} className="editor-fieldset">
        {isLink && selected && <><p>Seleccionado: {action.kind === 'order' ? `Pedido ${selected.number}` : selected.concept} · versión del vínculo {selected.link?.version ?? 0} {selected.link ? '(existente)' : '(nuevo)'}</p>{changingOrigin && <p className={styles.warning}>Cambiar vínculo: se retirará de {selected.link.campaignName || selected.link.campaignId} y se asociará a esta campaña. Ambas evaluaciones comerciales deberán recalcularse.</p>}{selected.link?.campaignId === campaignId && <label className={styles.checkRow}><input type="checkbox" checked={unlink} onChange={event => { setUnlink(event.target.checked); setAcknowledged(false); }}/>Retirar este vínculo sin borrar el pedido/gasto original</label>}</>}
        {!isLink && action.type === 'duplicate-from-recommendation' && <><p>Se creará un borrador nuevo vinculado a la publicación y a esta idea, sin fechas, aceptación, IDs remotos, estimación ni vínculos comerciales anteriores. El presupuesto no aumenta y no se autoriza publicación ni gasto.</p><p>Idea: {text(action.recommendation.proposedChange?.text || action.recommendation.proposedChange)}</p><p>Debes aportar o editar la imagen o video o su texto y confirmar el cambio cuando corresponda.</p></>}
        {(isLink || action.type === 'dismiss') && <Field field={{ name: 'reason', label: 'Motivo de la rectificación o decisión', type: 'textarea', required: true, max: 500, description: 'Entre 1 y 500 caracteres. Se conserva con actor, fecha y versión para auditoría.' }} value={reason} onChange={setReason}/>}
        <label className={styles.checkRow}><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} data-dialog-initial-focus/>{isLink ? changingOrigin ? 'Confirmo cambiar explícitamente el origen declarado a esta campaña.' : unlink ? 'Confirmo retirar solo el vínculo declarado, conservando el documento original.' : 'Confirmo este origen declarado, no una atribución causal.' : action.type === 'dismiss' ? 'Confirmo descartar esta propuesta con el motivo indicado.' : 'Confirmo crear solo un borrador para revisión, sin publicación ni inversión.'}</label>
      </fieldset><div className={styles.actions}><button type="button" className="button subtle" disabled={busy} onClick={close}>Cancelar</button><button type="submit" className="button primary" disabled={busy || isLink && !selected}>{busy ? 'Guardando…' : isLink ? changingOrigin ? 'Cambiar vínculo' : unlink ? 'Retirar vínculo' : 'Guardar vínculo' : action.type === 'dismiss' ? 'Descartar propuesta' : 'Crear próximo borrador'}</button></div>
    </form>
  </div></dialog>;
}

export default function AdvertisingResults({ api, campaignId = null, view = {}, onViewChange, onNavigate, onInteractionStateChange, onMutation, revision = 0 }) {
  const id = campaignId && campaignId !== 'new' ? campaignId : null;
  const integrationMethod = view.integrationMethod || '', scope = view.scope || '', dimension = view.dimension || '';
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  const [campaignSearch, setCampaignSearch] = useState(''), [campaignQuery, setCampaignQuery] = useState({ q: '', page: 1 }), [campaignList, setCampaignList] = useState(null), [listError, setListError] = useState(''), [listLoading, setListLoading] = useState(false);
  const [from, setFrom] = useState(view.from || ''), [to, setTo] = useState(view.to || '');
  const [action, setAction] = useState(null), [actionBusy, setActionBusy] = useState(false), [dialogInteraction, setDialogInteraction] = useState({ dirty: false, busy: false }), [notice, setNotice] = useState(''), [invalidatedAnalysis, setInvalidatedAnalysis] = useState(null);
  const sequence = useRef(0), reads = useRef(null), requestIds = useRef(new Map()), mutationControllers = useRef(new Set()), mounted = useRef(true), parentInteraction = useRef(onInteractionStateChange), headingRef = useRef(null), errorRef = useRef(null), listErrorRef = useRef(null), filterSummary = useRef(null), focusId = useRef(null);
  parentInteraction.current = onInteractionStateChange;
  const actionBusyRef = useRef(false), dialogInteractionRef = useRef(dialogInteraction);
  const reportDialog = useCallback(state => {
    dialogInteractionRef.current = state; setDialogInteraction(state);
    parentInteraction.current?.({ dirty: state.dirty, busy: state.busy || actionBusyRef.current });
  }, []);
  const reportAction = useCallback(value => {
    actionBusyRef.current = value; setActionBusy(value);
    const state = dialogInteractionRef.current;
    parentInteraction.current?.({ dirty: state.dirty, busy: state.busy || value });
  }, []);
  const busy = actionBusy || dialogInteraction.busy;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current?.abort(); for (const controller of mutationControllers.current) controller.abort(); parentInteraction.current?.({ dirty: false, busy: false }); }; }, []);
  useEffect(() => { setFrom(view.from || ''); setTo(view.to || ''); }, [view.from, view.to]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (listError) listErrorRef.current?.focus(); }, [listError]);
  const queryKey = JSON.stringify({ campaignId: id, from: view.from || '', to: view.to || '', integrationMethod, scope, dimension, page: view.page || 1 });
  const current = snapshot?.key === queryKey;
  const campaign = snapshot?.campaign;
  const results = snapshot?.results;
  const pending = current && (campaign?.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review'].includes(item.state)) || campaign?.operations?.some(item => ['prepared', 'sent', 'retry_wait'].includes(item.state) && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())) || ['pending', 'running', 'queued'].includes(results?.analysis?.job?.state));
  useEffect(() => {
    const controller = new AbortController(), seq = ++sequence.current; reads.current?.abort(); reads.current = controller;
    setLoading(true);
    const params = new URLSearchParams({ page: String(view.page || 1) });
    if (id) params.set('campaignId', id);
    for (const [key, value] of Object.entries({ from: view.from, to: view.to, integrationMethod, scope, dimension })) if (value) params.set(key, value);
    Promise.all([api(`${ROOT}/results?${params}`, { signal: controller.signal }), id ? api(`${ROOT}/campaigns/${encodeURIComponent(id)}`, { signal: controller.signal }) : null, id ? api(`${ROOT}/campaigns/${encodeURIComponent(id)}/links`, { signal: controller.signal }) : null]).then(([result, detail, links]) => {
      if (controller.signal.aborted || seq !== sequence.current) return;
      setError('');
      setSnapshot({ key: queryKey, campaignId: id, from: view.from || null, to: view.to || null, results: result, campaign: detail, links, loadedAt: new Date().toISOString() });
      if (focusId.current !== id) { focusId.current = id; headingRef.current?.focus({ preventScroll: true }); }
    }).catch(cause => { if (cause.name !== 'AbortError' && !controller.signal.aborted && seq === sequence.current) setError(cause.message); }).finally(() => { if (!controller.signal.aborted && seq === sequence.current) setLoading(false); });
    return () => controller.abort();
  }, [api, id, queryKey, view.from, view.to, view.page, integrationMethod, scope, dimension, revision, refresh]);
  useEffect(() => {
    let timer;
    const schedule = () => { clearTimeout(timer); if (document.visibilityState === 'visible') timer = setTimeout(() => { if (!action && !busy) setRefresh(value => value + 1); schedule(); }, pending ? 5000 : 60000); };
    const visible = () => { if (document.visibilityState === 'visible' && !action && !busy) setRefresh(value => value + 1); schedule(); };
    schedule(); document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [pending, action, busy]);
  useEffect(() => {
    const controller = new AbortController(); setListLoading(true);
    api(`${ROOT}/campaigns?${new URLSearchParams({ q: campaignQuery.q, page: String(campaignQuery.page) })}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setListError(''); setCampaignList(result); } }).catch(cause => { if (cause.name !== 'AbortError' && !controller.signal.aborted) setListError(cause.message); }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [api, campaignQuery, revision]);
  const change = patch => { if (!busy && !action) onViewChange?.({ ...patch, page: patch.page ?? 1 }); };
  const resultFilters = [...RESULT_FILTERS.map(([key, title, options]) => [key, title, options[view[key]]]), ['from', 'Desde', view.from], ['to', 'Hasta', view.to]].filter(([key]) => Boolean(view[key]));
  const removeResultFilter = key => { change({ [key]: null, page: 1 }); filterSummary.current?.focus(); };
  const clearResultFilters = () => { setFrom(''); setTo(''); change({ integrationMethod: null, scope: null, dimension: null, from: null, to: null, page: 1 }); filterSummary.current?.focus(); };
  const analysis = results?.analysis;
  const locallyInvalid = Boolean(invalidatedAnalysis && invalidatedAnalysis.campaignId === snapshot?.campaignId && invalidatedAnalysis.evidenceHash === (analysis?.evidenceHash || null) && invalidatedAnalysis.asOf === (analysis?.asOf || null) && !(snapshot.loadedAt !== invalidatedAnalysis.loadedAt && analysis?.status === 'current' && ['succeeded', 'failed'].includes(analysis?.job?.state)));
  const analysisStale = Boolean(locallyInvalid || analysis?.stale || analysis?.status && analysis.status !== 'current' || !analysis);
  const commercialStale = Boolean(locallyInvalid || analysis?.commercialStale || analysisStale);
  async function saved(result, type) {
    setAction(null); reportDialog({ dirty: false, busy: false });
    if (type === 'link') setInvalidatedAnalysis({ campaignId: id, evidenceHash: analysis?.evidenceHash || null, asOf: analysis?.asOf || null, loadedAt: snapshot?.loadedAt });
    setNotice(type === 'link' ? 'Vínculo guardado. Recalculo comercial encolado; no se han modificado pedidos, gastos ni pagos.' : type === 'dismiss' ? 'Propuesta descartada con motivo.' : 'Nuevo borrador creado, sin publicación ni gasto.');
    setRefresh(value => value + 1);
    try { await onMutation?.(); } catch (cause) { if (mounted.current) setNotice(`Guardado; actualización global pendiente: ${cause.message}`); }
    if (type === 'duplicate-from-recommendation' && mounted.current) onNavigate?.({ section: 'advertising', tab: 'campaigns', record: result.id });
  }
  async function campaignAction(name) {
    if (!current || !campaign || busy || action) return;
    const body = { action: name, version: campaign.version }, path = `${ROOT}/campaigns/${encodeURIComponent(id)}/actions`, key = `${path}:${JSON.stringify(body)}`;
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    const controller = new AbortController(); mutationControllers.current.add(controller); reportAction(true); setError('');
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify({ ...body, requestId: requestIds.current.get(key) }), signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      requestIds.current.delete(key);
      if (name === 'analyze') setInvalidatedAnalysis({ campaignId: id, evidenceHash: analysis?.evidenceHash || null, asOf: analysis?.asOf || null, loadedAt: snapshot?.loadedAt });
      setNotice(`${name === 'sync' ? 'Consulta al proveedor' : 'Análisis local'} encolado${result.operationId ? ` · operación ${result.operationId}` : ''}. Esto no confirma publicación ni resultados nuevos.`); setRefresh(value => value + 1);
      try { await onMutation?.(); } catch (cause) { if (mounted.current) setNotice(`Acción encolada; actualización global pendiente: ${cause.message}`); }
    } catch (cause) { if (cause.name !== 'AbortError' && mounted.current && !controller.signal.aborted) setError(cause.message); }
    finally { mutationControllers.current.delete(controller); if (mounted.current) reportAction(false); }
  }
  function applyPeriod(event) {
    event.preventDefault();
    if (from && to && from > to) { setError('La fecha desde debe ser anterior o igual a la fecha hasta.'); return; }
    change({ from: from || null, to: to || null, page: 1 });
  }
  const grouped = new Map();
  for (const item of results?.measurements || []) {
    const delivery = results.deliveries?.find(value => value.id === item.deliveryId);
    const key = `${item.integrationMethod}:${item.scope}:${item.currency || ''}:${delivery?.channel || ''}`;
    if (!grouped.has(key)) grouped.set(key, { title: `${method(item.integrationMethod)} · ${scopes[item.scope] || item.scope} · ${item.currency || 'Sin moneda'} · ${channels[delivery?.channel] || 'Destino sin informar'}`, items: [] });
    grouped.get(key).items.push({ item, delivery });
  }
  return <section className={styles.stack} style={{ minWidth: 0 }} aria-label="Resultados de publicidad">
    <header className={styles.toolbar}><div><p className={styles.eyebrow}>Evidencia, no atribución causal</p><h2 ref={headingRef} tabIndex={-1}>{current && campaign ? campaign.name : id ? 'Resultados de la publicación' : 'Resultados por fuente y tipo'}</h2></div><button type="button" className="button subtle" disabled={loading || busy || !!action} onClick={() => setRefresh(value => value + 1)}>Actualizar vista</button></header>
    <section className={styles.queryPanel} aria-label="Seleccionar publicación y fechas"><form method="post" onSubmit={event => { event.preventDefault(); setCampaignQuery({ q: campaignSearch.trim(), page: 1 }); }}><div className={styles.fieldGrid}><Field field={{ name: 'campaignSearch', label: 'Buscar publicaciones', max: 100 }} value={campaignSearch} onChange={setCampaignSearch}/><button type="submit" className="button subtle" disabled={busy || !!action || listLoading}>Buscar publicaciones</button></div></form>
      {listError && <p ref={listErrorRef} tabIndex={-1} role="alert" className={styles.error}>{listError}<button type="button" className="text-button" onClick={() => setCampaignQuery(value => ({ ...value }))}>Reintentar listado</button></p>}
      <label className="field">Publicación<select value={id || ''} disabled={busy || !!action || listLoading || Boolean(listError)} onChange={event => change({ record: event.target.value || null, page: 1 })}><option value="">Todas: grupos separados, sin sumar personas</option>{id && !campaignList?.campaigns?.some(item => item.id === id) && <option value={id}>{current && campaign ? campaign.name : id}</option>}{campaignList?.campaigns?.map(item => <option key={item.id} value={item.id}>{item.name} · {method(item.integrationMethod)} · {states[item.state] || item.state}</option>)}</select></label>
      {id && <button type="button" className="button subtle" disabled={busy || !!action} onClick={() => change({ record: null, page: 1 })}>Ver todas las publicaciones</button>}
      {listLoading && <p role="status">Cargando publicaciones…</p>}{campaignList && <div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || !!action || listLoading || campaignList.page <= 1} onClick={() => setCampaignQuery({ q: campaignQuery.q, page: campaignList.page - 1 })}>Publicaciones anteriores</button><span>Página {campaignList.page} de {campaignList.pages} · {campaignList.total} publicaciones · búsqueda «{campaignQuery.q || 'todas'}»</span><button type="button" className="button subtle" disabled={busy || !!action || listLoading || campaignList.page >= campaignList.pages} onClick={() => setCampaignQuery({ q: campaignQuery.q, page: campaignList.page + 1 })}>Publicaciones siguientes</button></div>}
      <form method="post" onSubmit={applyPeriod}><fieldset disabled={busy || !!action} className="editor-fieldset"><div className={styles.fieldGrid}><Field field={{ name: 'from', type: 'date', label: 'Desde' }} value={from} onChange={value => setFrom(value || '')}/><Field field={{ name: 'to', type: 'date', label: 'Hasta' }} value={to} onChange={value => setTo(value || '')}/></div><div className={styles.actions}><button type="submit" className="button subtle">Aplicar fechas</button></div></fieldset></form>
      <details className={styles.filterDetails}><summary ref={filterSummary}>Más filtros de resultados</summary><div className={styles.fieldGrid}>{RESULT_FILTERS.map(([key, title, options]) => <label className="field" key={key}>{title}<select name={key} value={view[key] || ''} disabled={busy || !!action} onChange={event => change({ [key]: event.target.value || null, page: 1 })}><option value="">Todas, por separado</option>{Object.entries(options).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></label>)}</div></details>
      {!!resultFilters.length && <div className="active-filters" aria-label="Filtros de resultados">{resultFilters.map(([key, title, value]) => <button type="button" className="filter-chip" key={key} disabled={busy || !!action} aria-label={`Quitar filtro: ${title}: ${value}`} onClick={() => removeResultFilter(key)}>{title}: {value} <span aria-hidden="true">×</span></button>)}<button type="button" className="text-button" disabled={busy || !!action} onClick={clearResultFilters}>Limpiar filtros de resultados</button></div>}
      <p className={styles.help}>Las fechas seleccionan capturas compatibles; solo el desglose diario filtra días. No recortan el acumulado comercial de pedidos y gastos vinculados.</p>
      <p className={styles.help}>Actualizar vista solo lee datos locales. Pedir actualización a Meta encola una consulta al proveedor, sujeta a permisos y espera. Las lecturas locales automáticas ocurren cada {pending ? '5 segundos mientras hay trabajo pendiente' : '60 segundos con esta vista visible'}.</p>
    </section>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <div role="alert" tabIndex={-1} ref={errorRef} className={styles.error}>{error}<button type="button" className="button subtle" disabled={busy || !!action} onClick={() => setRefresh(value => value + 1)}>Reintentar lectura</button>{snapshot && <p>Se conservan los datos de {snapshot.campaign?.name || 'la consulta agrupada'} cargados {date(snapshot.loadedAt)}; no acreditan una actualización exitosa.</p>}</div>}
    {loading && <p role="status">{snapshot ? 'Actualizando sin borrar la evidencia anterior…' : 'Cargando resultados…'}</p>}
    {snapshot && !current && <p className={styles.warning}>Evidencia conservada de la selección anterior: {snapshot.campaign?.name || 'vista agrupada'} · {snapshot.from || 'sin límite inicial'} — {snapshot.to || 'sin límite final'} · lectura local {date(snapshot.loadedAt)}. No corresponde aún a los filtros actuales; las acciones sobre ella están deshabilitadas.</p>}
    {snapshot && <div style={{ minWidth: 0 }} inert={!current ? true : undefined} className={styles.stack}>
      <p className={styles.muted}>Corte de lectura social {date(results.asOf)} · cargado localmente {date(snapshot.loadedAt)}. Alcance único entre entregas: no disponible sin deduplicación; no se suman personas de redes o campañas.</p>
      {campaign && <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || !!action} onClick={() => onNavigate?.({ section: 'advertising', tab: 'campaigns', record: campaign.id })}>Administrar publicación</button>{campaign.deliveries?.length > 0 && <button type="button" className="button subtle" disabled={busy || !!action} onClick={() => campaignAction('sync')}>Pedir actualización a Meta</button>}<button type="button" className="button subtle" disabled={busy || !!action} onClick={() => onNavigate?.({ section: 'business', tab: 'social', record: campaign.connectionId })}>Redes sociales</button></div>}
      <section className={styles.panel}><h3>Estado de publicación por red</h3>{campaign?.restoreHold && <p className={styles.warning}>Bloqueo de restauración: comprobar el estado en Meta sin reenviar y aceptar la recuperación antes de continuar. Restaurar no detiene anuncios activos.</p>}{campaign?.state === 'scheduled' && campaign.revisions?.at(-1)?.spec?.publishAt && Date.parse(campaign.revisions.at(-1).spec.publishAt) < Date.now() && <p className={styles.warning}>La hora programada ya pasó y no hay confirmación de publicación en este estado. Revisa el procesamiento en segundo plano y las operaciones; el reloj local no acredita que se haya publicado.</p>}{!results.deliveries?.length && <p>No hay entregas aprobadas en esta selección. No significa cero resultados publicados fuera del módulo.</p>}{results.deliveries?.map(delivery => <article className={styles.card} key={delivery.id}><h4>{channels[delivery.channel] || delivery.channel} · {method(delivery.integrationMethod)}</h4><p>Estado local: {states[delivery.state] || delivery.state} · último estado confirmado: {states[delivery.lastConfirmedState] || delivery.lastConfirmedState || 'Sin confirmación remota'}</p><p>Última consulta correcta {date(delivery.metricSync?.lastSuccessAt)} · próximo turno {date(delivery.nextSyncAt || delivery.metricSync?.nextAt)}</p>{delivery.metricSync?.lastError && <p className={styles.warning}>Último error: {text(delivery.metricSync.lastError)}. Se conserva evidencia anterior.</p>}{delivery.metricSync?.blocked && <p className={styles.warning}>Consulta bloqueada: revisar conexión/permisos/interfaz. Actualizar no evade este bloqueo.</p>}{['uncertain', 'blocked', 'needs_attention', 'partial'].includes(delivery.state) && <p className={styles.warning}>Revisar operaciones y comprobar el estado en Meta sin reenviar desde la publicación.</p>}</article>)}</section>
      {grouped.size ? [...grouped].map(([key, group]) => <section key={key} className={styles.stack} style={{ minWidth: 0 }}><h3>{group.title}</h3>{group.items.map(({ item, delivery }) => <Measurement key={item.id} item={item} delivery={delivery} onCampaign={!snapshot.campaignId ? campaignId => change({ record: campaignId }) : null}/>)}</section>) : current && !loading && !error && <section className={styles.empty}><h3>{results.total > 0 && !results.deliveries?.length ? 'Esta página no tiene entregas' : 'Sin capturas en esta selección'}</h3><p>No disponible no equivale a cero. Puede faltar una entrega, el horizonte, permiso para consultar resultados o una captura completa compatible con las fechas.</p><div className={styles.actions}>{results.total > 0 && !results.deliveries?.length ? <button type="button" className="button subtle" onClick={() => change({ page: 1 })}>Ir a la primera página</button> : resultFilters.length > 0 ? <button type="button" className="button subtle" onClick={clearResultFilters}>Limpiar filtros de resultados</button> : !campaign && <button type="button" className="button subtle" onClick={() => onNavigate?.({ section: 'advertising', tab: 'campaigns', record: 'new' })}>Crear publicación</button>}</div></section>}
      {results.pages > 1 && <div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || !!action || results.page <= 1} onClick={() => change({ page: results.page - 1 })}>Entregas anteriores</button><span>Página {results.page} de {results.pages} · {results.total} entregas</span><button type="button" className="button subtle" disabled={busy || !!action || results.page >= results.pages} onClick={() => change({ page: results.page + 1 })}>Entregas siguientes</button></div>}
      {campaign && <>
        {results.business && <BusinessPanel business={results.business} stale={commercialStale} links={snapshot.links} onNavigate={onNavigate} onLink={(kind, record) => setAction({ type: 'link', kind, record })}/>}
        {analysis && <Recommendations analysis={analysis} stale={analysisStale} commercialStale={commercialStale} measurements={results.measurements || []} busy={busy || !!action} onAnalyze={() => campaignAction('analyze')} onAction={next => next.type === 'open-sample' ? onNavigate?.({ section: 'advertising', tab: 'results', record: next.campaignId }) : setAction(next)}/>}
        {analysisStale && <p className={styles.warning}>Análisis obsoleto o pendiente: las comparaciones conservadas no acreditan una evaluación vigente.</p>}
        <details className={styles.technicalDetails}><summary>Comparar con la estimación y mi meta de costo</summary><Comparisons analysis={analysis} currency={campaign.currency} stale={analysisStale}/><UserCostTarget campaign={campaign} measurements={results.measurements || []}/></details>
        <ApprovedCampaign campaign={campaign} onNavigate={onNavigate}/>
      </>}
    </div>}
    {action && current && <ResultActionDialog action={action} campaignId={id} api={api} requestIds={requestIds} onClose={() => setAction(null)} onSaved={saved} onInteractionStateChange={reportDialog}/>}
  </section>;
}
