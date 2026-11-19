'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from './Fields';
import useDialog from './useDialog';
import { useAssistantForm } from './AssistantBridge.jsx';
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
const objectives = { reach: 'Llegar a más personas', engagement: 'Conseguir interacciones', traffic: 'Llevar personas al sitio web', whatsapp: 'Conseguir consultas por WhatsApp' };
const primaryLabels = { reach: 'Personas alcanzadas', interactions: 'Interacciones', linkClicks: 'Clics al enlace', conversations: 'Conversaciones' };
const conclusions = { improved: 'Mejoró según este criterio', not_improved: 'No mejoró según este criterio', inconclusive: 'No se puede concluir' };
const comparisonStates = { below: 'Debajo del rango', within: 'Dentro del rango', above: 'Encima del rango', in_progress: 'En curso: avance, no evaluación final', not_comparable: 'No comparable' };
const campaignState = campaign => campaign.state === 'ready' && campaign.mode === 'organic'
  ? campaign.deliveries?.length ? 'Preparada' : 'Aprobada, pendiente de publicar'
  : states[campaign.state] || campaign.state;
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
  incompatible_or_unknown_market: 'Los mercados de la pieza original y la variante son distintos o no se confirmaron.',
  primary_kpi_unavailable: 'La red no informó el indicador principal en una captura compatible.',
  complete_primary_capture_unavailable: 'Falta una captura completa del indicador principal.',
  newer_capture_incomplete: 'La captura más reciente no tiene cobertura completa.',
  stale_metrics: 'La última captura completa es antigua.',
  fewer_than_three_complete_days: 'Aún no transcurrieron tres días completos de pauta.',
  organic_horizon_not_reached: 'Aún no termina el horizonte de observación del post.'
};
const method = value => value === 'api' ? 'Conexión oficial de Meta (API)' : value === 'browser' ? 'Acceso asistido por navegador' : 'Vía sin informar';
const label = key => metricLabels[key] || key;
const reasonText = value => {
  if (typeof value === 'string') {
    const [channel, reason] = value.split(':', 2);
    if (channels[channel] && reasonLabels[reason]) return `${channels[channel]}: ${reasonLabels[reason]}`;
    return reasonLabels[value] || value;
  }
  return value?.reason ? `${value.metric ? label(value.metric) + ': ' : ''}${reasonLabels[value.reason] || value.reason}${value.sampleCount != null ? ` (${value.sampleCount} muestras)` : ''}` : JSON.stringify(value);
};
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
function Measurement({ item, delivery, onCampaign, anchor = true }) {
  const [rowPage, setRowPage] = useState(1);
  useEffect(() => setRowPage(1), [item.id]);
  const visibleRows = (item.rows || []).slice((rowPage - 1) * 20, rowPage * 20);
  const metrics = Object.entries(item.values || {}), ratioEntries = Object.entries(item.ratios || {});
  const rowKeys = [...new Set((item.rows || []).flatMap(row => Object.keys(row.values || {})))];
  return <article className={styles.card} id={anchor ? `social-measurement-${item.id}` : undefined} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
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
  return ids.length ? <ul>{ids.map(id => <li key={id}><a href={`#social-measurement-${id}`} onClick={openCaptures}>{id}</a></li>)}</ul> : <p>Sin capturas identificadas.</p>;
}
function openCaptures() { const details = document.getElementById('social-results-captures'); if (details) details.open = true; }
function RecommendationCaptureLinks({ recommendation, onOpen }) {
  return recommendation.metricIds?.length > 0 ? <ul>{recommendation.metricIds.map((id, index) => <li key={id}><button type="button" className="text-button" onClick={() => onOpen(recommendation, id)}>Abrir captura citada {recommendation.metricIds.length > 1 ? index + 1 : ''}</button></li>)}</ul> : <p>Sin capturas identificadas.</p>;
}
function RecommendationEvidence({ item, asOf, campaign }) {
  const evidence = item.primaryEvidence, criterion = item.successCriterion;
  const format = (value, key = evidence?.metric) => key?.endsWith('Minor') ? money(value, campaign.currency) : key === 'ctrLinkPercent' ? `${number(value)} %` : key === 'organicResponse' ? `${number(value * 100)} %` : number(value);
  const numbers = [
    !evidence?.placement && ['Observado', evidence?.value], ['Cuartil inferior comparable', evidence?.historicalLower], ['Mediana comparable', evidence?.historicalMedian],
    ['Período anterior', evidence?.previousValue], ['Frecuencia observada', evidence?.frequency, 'frequency'],
    ['Mediana en franja propuesta', evidence?.observedBandMedian], ['Mediana de la otra franja', evidence?.referenceBandMedian],
    [evidence?.placement, evidence?.selectedCostMinor, 'costPerPrimaryResultMinor'], [evidence?.comparedPlacement, evidence?.comparedCostMinor, 'costPerPrimaryResultMinor'],
    ['Pedidos vinculados', evidence?.orderCount, 'orders'], ['Costo por resultado observado', evidence?.costPerResultMinor, 'costPerPrimaryResultMinor'],
  ].filter(row => row && row[0] && Number.isFinite(row[1]));
  const threshold = { gt: 'Más de', gte: 'Al menos', lt: 'Menos de', lte: 'No más de' }[criterion?.operator];
  return <>
    {numbers.length > 0 && <Facts rows={numbers.map(([title, value, key]) => [title, format(value, key)])}/>}
    {evidence?.selectedResults != null && <p>Volumen observado: {number(evidence.selectedResults)} resultados en {evidence.placement} frente a {number(evidence.comparedResults)} en {evidence.comparedPlacement}.</p>}
    {evidence?.periods?.length ? <ul className={styles.help}>{evidence.periods.map(period => <li key={period.captureId}>{[channels[period.channel], windows[period.window]].filter(Boolean).join(' · ')}: {date(period.start, period.timeZone)} — {date(period.end, period.timeZone)} · lectura del {date(period.fetchedAt)} · {method(period.integrationMethod)}</li>)}</ul> : <p className={styles.help}>Corte del análisis: {date(asOf)}{item.metricIds?.length ? '. El período exacto consta en la captura citada.' : '. No hay captura compatible para esta observación.'}</p>}
    <p className={styles.help}>{item.sampleIds?.length ? `Comparación con ${item.sampleIds.length} piezas compatibles.` : numbers.length > 1 ? 'Sin cohorte histórica; los valores son de esta pieza.' : 'No hay una comparación histórica compatible para esta observación.'}</p>
    <p><strong>Cómo sabremos si mejoró:</strong> {criterion?.text}{threshold && Number.isFinite(criterion.target) && <> {threshold} {format(criterion.target, criterion.metric)}.</>}{criterion?.minimumResults && <> Mínimo: {number(criterion.minimumResults)} resultados.</>}{criterion?.maxCostPerResultMinor != null && <> Costo máximo: {money(criterion.maxCostPerResultMinor, campaign.currency)}.</>}</p>
  </>;
}
function EvidenceDialog({ evidence, api, onClose }) {
  const ref = useRef(null), [data, setData] = useState(null), [error, setError] = useState('');
  const close = useDialog(ref, { onClose });
  useEffect(() => {
    const controller = new AbortController();
    const { recommendation, captureId } = evidence;
    const params = new URLSearchParams({ campaignId: recommendation.campaignId, evidenceHash: recommendation.evidenceHash, captureId });
    api(`${ROOT}/recommendations/${encodeURIComponent(recommendation.id)}/evidence?${params}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [api, evidence]);
  return <dialog ref={ref} className={`admin-dialog ${styles.dialog}`} aria-labelledby="social-evidence-title">
    <header className={styles.dialogHeader}><h2 id="social-evidence-title">Captura exacta del análisis</h2></header>
    <div className={styles.dialogBody}>{error ? <p role="alert">{error}</p> : data ? <><p>Corte: {date(data.asOf)}. Lectura conservada, independiente de los filtros de la ficha.</p><Measurement item={data.measurement} delivery={data.delivery} anchor={false}/></> : <p role="status">Cargando la captura citada…</p>}</div>
    <footer className={styles.actions}><button type="button" className="button subtle" onClick={close} data-dialog-initial-focus>Cerrar captura</button></footer>
  </dialog>;
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
function Recommendations({ analysis, campaign, stale, onAction, onAnalyze, busy, onEvidence }) {
  const options = new Map(campaign.recommendations?.map(item => [item.id, item]) || []);
  const recommendations = (analysis?.recommendations || []).slice(0, 5).map(item => ({ ...item, inPlace: options.get(item.id)?.inPlace || [] }));
  const card = item => {
    const type = item.proposedChange?.type, maintenance = ['measurement', 'offer_costs'].includes(type);
    const available = item.inPlace.filter(option => option.allowed), changeDrafts = Object.values(item.changeDrafts || {});
    const observed = item.primaryEvidence;
    return <article className={styles.card} key={item.id}>
      <h4>{type === 'measurement' ? 'Falta evidencia suficiente' : label(observed?.metric || item.successCriterion?.metric || 'Resultado')}</h4>
      <p><strong>Qué observamos:</strong> {item.observation}</p>
      <p><strong>Qué probar:</strong> {item.proposedChange?.text}</p>
      <RecommendationEvidence item={item} asOf={analysis.asOf} campaign={campaign}/>
      {stale && <p className={styles.warning}>Propuesta conservada, no vigente. Revisa mejoras después de la lectura o el cambio de estado.</p>}
      {item.state === 'dismissed' && <p>Descartada, no evaluada.</p>}
      {item.state === 'applied' && <p>{item.trial ? 'Cambio remoto comprobado.' : 'Borrador preparado; no significa que se publicó.'}</p>}
      {item.conclusion && <p>{conclusions[item.conclusion]}.</p>}
      <details className={styles.evidence}><summary>Hipótesis, limitaciones y capturas</summary><p><strong>Hipótesis:</strong> {item.hypothesis}</p><Reasons values={item.limitations || []}/><RecommendationCaptureLinks recommendation={item} onOpen={onEvidence}/>{item.sampleIds?.map(id => <p key={id}><button type="button" className="text-button" onClick={() => onAction({ type: 'open-sample', campaignId: id })}>Abrir publicación de muestra {id}</button></p>)}</details>
      {item.state === 'suggested' && <><div className={styles.actions}>
        {maintenance ? <button type="button" className="button primary" disabled={busy} onClick={() => onAction({ type })}>{type === 'measurement' ? 'Completar medición' : 'Revisar pedidos y costos vinculados'}</button> : changeDrafts.length ? changeDrafts.map(id => <button type="button" className="button primary" key={id} disabled={busy} onClick={() => onAction({ type: 'open-draft', campaignId: id })}>Retomar cambio en la misma pieza</button>) : <>
          {available.map(option => <button type="button" className="button primary" key={option.deliveryId} disabled={busy || stale} onClick={() => onAction({ type: 'prepare-in-place', recommendation: item, option })}>Cambiar aquí{option.channel === 'facebook' ? ' · solo Facebook' : ''}</button>)}
          <button type="button" className="button subtle" disabled={busy || stale} onClick={() => onAction({ type: 'duplicate-from-recommendation', recommendation: item })}>Preparar una variante</button>
        </>}
        {!changeDrafts.length && <button type="button" className="button subtle" disabled={busy} onClick={() => onAction({ type: 'dismiss', recommendation: item })}>Descartar con motivo</button>}
      </div>{!maintenance && !changeDrafts.length && item.inPlace.filter(option => !option.allowed).map(option => <p className={styles.help} key={option.deliveryId}>{channels[option.channel]}: {option.reason}</p>)}</>}
    </article>;
  };
  return <section id="social-results-recommendations" tabIndex={-1} className={styles.panel}>
    <div className={styles.toolbar}><h3>Qué probar ahora</h3><button type="button" className="button subtle" disabled={busy || !campaign.revisions?.length} onClick={onAnalyze}>Revisar mejoras</button></div>
    <p>Una observación no diagnostica la causa. Consultar propuestas no publica ni autoriza gasto.</p>
    {analysis?.job?.errorCode && <p className={styles.warning}>La evaluación local falló; se conserva la anterior.</p>}
    {!recommendations.length && <p>{analysis?.status === 'current' ? 'No hay un cambio justificado por ahora.' : 'Aún no hay una evaluación vigente. Comprueba la medición antes de cambiar la pieza o invertir más.'}</p>}
    {recommendations.length > 0 && card(recommendations[0])}
    {recommendations.length > 1 && <details><summary>Ver las demás ({recommendations.length - 1})</summary>{recommendations.slice(1).map(card)}</details>}
  </section>;
}

function Offer({ offer }) {
  const name = variant => [variant?.title, variant?.presentation, variant?.flavor].filter(Boolean).join(' · ');
  return <p>{offer?.primary ? <><strong>{name(offer.primary)}</strong>{offer.gift && <> · Obsequio: {name(offer.gift)} · Condición: {offer.gift.condition || 'Sin definir'}</>}</> : 'Publicación de marca, sin oferta seleccionada'}</p>;
}

function Performance({ campaign, rows }) {
  const approved = campaign.revisions?.at(-1);
  const effective = campaign.deliveries?.find(delivery => delivery.effectiveSpec && delivery.effectiveSpec.assetId !== campaign.asset?.id)?.effectiveSpec;
  const asset = effective ? { id: effective.assetId, kind: effective.assetType, state: 'ready' } : campaign.asset;
  const unavailable = { early: 'Aún es pronto', unavailable: 'Sin dato reportado', unsupported: 'No compatible con este destino', zero: '0 reportado' };
  return <section className={styles.panel} aria-labelledby="social-result-kpi">
    <h3 id="social-result-kpi">¿Se logró el objetivo?</h3>
    <div className={styles.campaignSummary}>
      {asset?.kind === 'image' && asset.state === 'ready' && <img className={styles.cardThumb} width="80" height="80" src={`${ROOT}/assets/${encodeURIComponent(asset.id)}/content?variant=derivative`} alt="Vista previa de la pieza aprobada"/>}
      {asset?.kind === 'video' && asset.state === 'ready' && <video className={styles.cardThumb} width="160" controls preload="metadata" src={`${ROOT}/assets/${encodeURIComponent(asset.id)}/content?variant=derivative`} aria-label="Vista previa de la pieza aprobada"/>}
      <div><p><strong>Objetivo:</strong> {objectives[campaign.objective]}</p><Offer offer={approved?.offerSnapshot || (!approved ? campaign.offerSnapshot : null)}/>
        {approved?.spec?.marketCountries?.length ? <p>Mercados elegidos: {approved.spec.marketCountries.join(', ')}{campaign.mode === 'organic' ? ' · No limitan ni garantizan la distribución.' : ''}</p> : <p>Mercado histórico sin confirmar.</p>}
      </div>
    </div>
    <ul className={styles.deliveryStates} aria-label="Estado por destino">{campaign.deliveries?.map(delivery => <li key={delivery.id}><strong>{channels[delivery.channel]}: </strong>{states[delivery.state] || delivery.state}{delivery.remoteRefs?.permalink && <> · <a href={delivery.remoteRefs.permalink} target="_blank" rel="noreferrer">Ver en Meta</a></>}{delivery.effectiveSpec && <> · Cambio confirmado en la misma entrega.</>}</li>)}</ul>
    {!rows?.length && <p>Sin dato para esta selección de fechas o filtros.</p>}
    <div className={styles.metricGrid}>{rows?.map(row => <article className={styles.card} key={row.deliveryId}>
      <h4>{primaryLabels[row.metric]} · {channels[row.channel]}</h4><strong className={styles.metricValue}>{unavailable[row.status] || metricValue(row.value, row.currency)}</strong>
      {row.fetchedAt ? <p>{date(row.periodStart, row.timeZone)} — {date(row.periodEnd, row.timeZone)} · última captura {date(row.fetchedAt)} · fuente: {method(row.integrationMethod)}{row.value?.sourceMetric ? ` (${row.value.sourceMetric})` : ''}</p> : <p>Sin captura del indicador para esta selección.</p>}
      {row.authorized != null && <p>{row.partial ? 'Gasto de la captura parcial' : 'Gasto confirmado por lectura'}: {metricValue(row.spend, row.currency)} · Presupuesto autorizado: {money(row.authorized, row.currency)}{row.costMinor != null && <> · Costo por resultado: {money(row.costMinor, row.currency)}</>}</p>}
      {row.stale && <p className={styles.warning}>Datos desactualizados.</p>}
      {row.newerPartial ? <p className={styles.warning}>La lectura más reciente fue parcial; se conserva la captura completa anterior.</p> : row.partial && <p className={styles.warning}>Cobertura parcial: no es un total completo.</p>}
      {row.lastError && <p className={styles.warning}>La última lectura falló. {row.lastError.message}</p>}
      {row.nextReadAt && <p className={styles.help}>Próxima comprobación programada: {date(row.nextReadAt)}.</p>}
      {row.reason && <Reasons values={[row.reason]}/>}
      {row.captureId && <a href={`#social-measurement-${row.captureId}`} onClick={openCaptures}>Ver evidencia de este dato</a>}
    </article>)}</div>
    <p className={styles.help}>{campaign.mode === 'paid' ? 'El gasto se reporta para el anuncio; autorizar ubicaciones no demuestra distribución en cada red.' : 'No se suman personas entre redes.'} Una conversación o un clic no es una venta. La previsión no es una garantía.</p>
  </section>;
}

function Learnings({ id, api, refresh, onNavigate, onEvidence }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [cursor, setCursor] = useState(null);
  useEffect(() => {
    const controller = new AbortController(), query = new URLSearchParams({ campaignId: id });
    if (cursor) query.set('cursor', cursor);
    api(`${ROOT}/learnings?${query}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted && cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [id, api, refresh, cursor]);
  const navigate = (record, tab) => onNavigate?.({ section: 'advertising', tab, record, ...(tab === 'results' ? { resultsFocus: 'learnings' } : {}) });
  return <section id="social-results-learnings" tabIndex={-1} className={styles.panel}><h3>Qué aprendimos</h3>
    {error && <p role="alert">{error} {data && 'Se conserva la lectura anterior.'}</p>}
    {!data && !error && <p role="status">Cargando historial de pruebas…</p>}
    {data?.learnings.length === 0 && <p>Aún no hay pruebas. Cuando una propuesta tenga evidencia, elige probar una variable en esta pieza o en una nueva.</p>}
    {data?.learnings.map(item => <article key={item.id} className={styles.card}>
      <h4>{item.proposedChange?.text || item.observation}</h4>
      <p>{[objectives[item.objective], channels[item.channel], item.applicationMode === 'same' ? 'Misma entrega' : item.applicationMode === 'new' ? 'Pieza nueva' : null].filter(Boolean).join(' · ')}</p><Offer offer={item.offerSnapshot}/>
      <p>Propuesta {date(item.createdAt)}{item.childCampaignId || Object.keys(item.changeDrafts || {}).length ? ' → borrador preparado' : ''}{item.transition ? ` → cambio comprobado ${date(item.transition.through)}` : item.childApprovedAt ? ' → pieza aprobada' : ''}</p>
      {item.before != null && item.after != null && <Facts rows={[[item.applicationMode === 'same' ? 'Antes' : 'Original', text(item.before)], [item.applicationMode === 'same' ? 'Después' : 'Variante', text(item.after)]]}/>}
      <p><strong>Criterio:</strong> {item.criterion?.text || 'No se congeló un criterio comparable.'}</p>
      {item.state === 'dismissed' ? <p>Descartada, no evaluada. {item.reason}</p> : item.conclusion ? <><strong>{conclusions[item.conclusion]}</strong>
        {item.evaluation?.reasons?.includes('lifetime_cannot_isolate_change') ? <p>No se puede aislar el efecto del cambio con el total acumulado de esta publicación.</p> : <Reasons values={item.evaluation?.reasons || []}/>}
        <p>{date(item.period.from)} — {date(item.period.to)} · {label(item.evaluation?.metric || '')}: {number(item.evaluation?.parentValue)} → {number(item.evaluation?.childValue)}</p>
        {[item.evaluation?.beforePeriod, item.evaluation?.afterPeriod].map((period, index) => period && (period.impressions != null || period.reach != null) ?
          <p key={index}>{index === 0 ? 'Exposición anterior' : 'Exposición posterior'}: {number(period.impressions ?? period.reach)} {period.impressions != null ? 'impresiones' : 'personas alcanzadas'} en una captura completa.</p> : null)}
      </> : item.transition || item.childState && !['draft', 'cancelled'].includes(item.childState) ? <p>Aún estamos midiendo{item.expectedAt ? ` · horizonte ${date(item.expectedAt)}` : ''}.</p> : item.childCampaignId ? <p>Borrador preparado; todavía no acredita publicación.</p> : null}
      {item.metricIds?.length > 0 && <details className={styles.evidence}><summary>Capturas que fundamentaron la propuesta</summary><RecommendationCaptureLinks recommendation={item} onOpen={onEvidence}/></details>}
      {item.state === 'suggested' && Object.values(item.changeDrafts || {}).map(draftId => <button type="button" className="button subtle" key={draftId} onClick={() => navigate(draftId, 'campaigns')}>Retomar cambio preparado</button>)}
      <div className={styles.actions}>{item.campaignId !== id && <button type="button" className="button subtle" onClick={() => navigate(item.campaignId, 'results')}>Ver pieza original</button>}{item.childCampaignId && item.childCampaignId !== id && <button type="button" className="button subtle" onClick={() => navigate(item.childCampaignId, item.childState === 'draft' ? 'campaigns' : 'results')}>{item.childState === 'draft' ? 'Retomar borrador' : 'Ver variante'}</button>}{item.operationId && <a href="#social-results-captures" onClick={openCaptures}>Comprobar la misma entrega</a>}</div>
    </article>)}
    <div className={styles.pagination}>{cursor && <button type="button" className="button subtle" onClick={() => setCursor(null)}>Volver a las más recientes</button>}{data?.nextCursor && <button type="button" className="button subtle" onClick={() => setCursor(data.nextCursor)}>Pruebas anteriores</button>}</div>
  </section>;
}
function ResultActionDialog({ action, campaignId, api, requestIds, onClose, onSaved, onInteractionStateChange }) {
  const ref = useRef(null), errorRef = useRef(null), controllers = useRef(new Set()), mounted = useRef(true), searchSequence = useRef(0), submitLocked = useRef(false);
  const [reason, setReason] = useState(''), [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [search, setSearch] = useState({ q: '', page: 1 }), [candidates, setCandidates] = useState(null), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const initialRecord = action.record ? { ...action.record, recordId: action.record.id, link: { ...action.record.link, campaignId } } : null;
  const [selected, setSelected] = useState(initialRecord), [unlink, setUnlink] = useState(false);
  const isLink = action.type === 'link', dirty = Boolean(reason || acknowledged || selected?.recordId !== initialRecord?.recordId || unlink);
  const assistant = useAssistantForm({
    target: 'advertising-result-action',
    entityId: action.record?.id || action.recommendation?.id || null,
    recordVersion: action.record?.link?.version ?? action.recommendation?.version ?? null,
    values: { reason }, dirty, busy,
    enabled: isLink || action.type === 'dismiss',
    generationKey: JSON.stringify([campaignId, action.type, action.kind, selected?.recordId, selected?.link?.version, unlink, acknowledged]),
    applyPatch: patch => {
      if (Object.keys(patch).some(key => key !== 'reason')) throw new Error('La selección y confirmación de esta acción son manuales.');
      if (Object.hasOwn(patch, 'reason')) changeReason(patch.reason);
    },
  });
  const close = useDialog(ref, { busy: busy || assistant.assistantBusy, dirty, onClose });
  useEffect(() => { onInteractionStateChange({ dirty, busy: busy || assistant.assistantBusy }); }, [dirty, busy, assistant.assistantBusy, onInteractionStateChange]);
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
  const inPlace = action.type === 'prepare-in-place';
  const title = isLink ? action.record ? 'Rectificar vínculo declarado' : `Vincular ${action.kind === 'order' ? 'pedido' : 'gasto publicitario'} existente` : action.type === 'dismiss' ? 'Descartar propuesta con motivo' : inPlace ? 'Revisar cambio en la misma pieza' : 'Preparar una variante';
  const changingOrigin = selected?.link?.campaignId && selected.link.campaignId !== campaignId;
  function changeReason(value) { setReason(value); setAcknowledged(false); }
  async function submit(event) {
    event.preventDefault();
    if (submitLocked.current || busy || assistant.assistantBusy || isLink && !selected) return;
    if ((isLink || action.type === 'dismiss') && !reason.trim()) { setError('Escribe un motivo para conservar la trazabilidad.'); return; }
    if (!acknowledged) { setError('Confirma explícitamente el alcance de esta acción.'); return; }
    const body = isLink ? { kind: action.kind, recordId: selected.recordId, campaignId: unlink ? null : campaignId, version: selected.link?.version ?? 0, reason: reason.trim() }
      : { action: action.type, version: action.recommendation.version, evidenceHash: action.recommendation.evidenceHash,
        ...(action.type === 'dismiss' ? { reason: reason.trim() } : {}), ...(inPlace ? { deliveryId: action.option.deliveryId } : {}) };
    const path = isLink ? `${ROOT}/campaigns/${encodeURIComponent(campaignId)}/links` : `${ROOT}/recommendations/${encodeURIComponent(action.recommendation.id)}/actions`;
    const key = `${path}:${JSON.stringify(body)}`;
    if (!requestIds.current.has(key)) requestIds.current.set(key, crypto.randomUUID());
    const saveUnassisted = async () => {
      const controller = new AbortController(); controllers.current.add(controller); submitLocked.current = true; setBusy(true); setError('');
      try {
        const result = await api(path, { method: 'POST', body: JSON.stringify({ ...body, requestId: requestIds.current.get(key) }), signal: controller.signal });
        if (!mounted.current || controller.signal.aborted) return false;
        requestIds.current.delete(key);
        await onSaved(result, isLink ? 'link' : action.type);
        return result;
      } catch (cause) {
        if (cause.name !== 'AbortError' && mounted.current && !controller.signal.aborted) setError(`${cause.message}${cause.status === 409 ? ' El registro cambió: cierra y vuelve a abrir para revisar su versión actual.' : ' Si la respuesta se perdió, reintentar la misma acción conserva su identificador; no se crea otra intención.'}`);
        return false;
      } finally { controllers.current.delete(controller); submitLocked.current = false; if (mounted.current) setBusy(false); }
    };
    await saveUnassisted();
  }
  return <dialog ref={ref} className={styles.dialog} aria-labelledby="social-results-action-title" inert={assistant.assistantBusy} style={{ maxWidth: 'min(48rem, calc(100vw - 2rem))', overflowWrap: 'anywhere' }}><header className={styles.dialogHeader}><h2 id="social-results-action-title">{title}</h2><button type="button" className="button subtle" onClick={close} disabled={busy || assistant.assistantBusy}>Cerrar</button></header><div className={styles.dialogBody}>
    {isLink && <><p>Origen declarado por el administrador, no atribución automática. No cambia etiquetas históricas ni crea pedidos, gastos o pagos. Un registro solo puede pertenecer a una campaña.</p><form method="post" onSubmit={event => { event.preventDefault(); if (!busy && !assistant.assistantBusy) setSearch({ q: query.trim(), page: 1 }); }}><fieldset disabled={busy || assistant.assistantBusy} className="editor-fieldset"><div className={styles.fieldGrid}><Field field={{ name: 'linkSearch', label: action.kind === 'order' ? 'Buscar por número o etiqueta histórica' : 'Buscar por concepto o etiqueta histórica', max: 200 }} value={query} onChange={setQuery}/><button type="submit" className="button subtle" disabled={busy || searching || assistant.assistantBusy}>Buscar registros</button></div></fieldset></form>
      {searching && <p role="status">Consultando candidatos locales…</p>}{searchError && <p role="alert" className={styles.error}>{searchError} Los candidatos anteriores no se consideran una búsqueda nueva.</p>}
      {candidates && <><p>Resultados para «{candidates.q || 'todos'}» · página {candidates.page} · {candidates.total} registros.</p><div className={styles.choiceList}>{candidates.items.map(item => <article className={styles.card} key={item.recordId}><p><strong>{action.kind === 'order' ? `Pedido ${item.number}` : item.concept}</strong> · {money(item.totalMinor ?? item.amountMinor, 'COP')}</p><p>Etiqueta histórica: {item.marketingCampaign || item.campaign || 'Sin etiqueta'}. No crea vínculo por coincidencia.</p>{item.link && <p>Vínculo actual: {item.link.campaignName || item.link.campaignId} · versión {item.link.version} · {item.link.actorId} · {date(item.link.updatedAt)} · motivo: {item.link.reason}</p>}<button type="button" className="button subtle" disabled={busy || searching || Boolean(searchError)} aria-pressed={selected?.recordId === item.recordId} onClick={() => { setSelected(item); setUnlink(false); setAcknowledged(false); }}>{item.link?.campaignId && item.link.campaignId !== campaignId ? 'Cambiar vínculo a esta campaña' : item.link ? 'Rectificar vínculo de esta campaña' : 'Seleccionar para vincular'}</button></article>)}</div>{!candidates.items.length && <p>No hay registros coincidentes elegibles. Los gastos candidatos pertenecen únicamente a Publicidad.</p>}<div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || searching || candidates.page <= 1} onClick={() => setSearch({ q: candidates.q, page: candidates.page - 1 })}>Anterior</button><button type="button" className="button subtle" disabled={busy || searching || candidates.page * candidates.pageSize >= candidates.total} onClick={() => setSearch({ q: candidates.q, page: candidates.page + 1 })}>Siguiente</button></div></>}
    </>}
    <form method="post" onSubmit={submit} aria-busy={busy} className={styles.stack}>
      {error && <div role="alert" tabIndex={-1} ref={errorRef} className={styles.error}>{error}</div>}
      <fieldset disabled={busy || assistant.assistantBusy} className="editor-fieldset">
        {isLink && selected && <><p>Seleccionado: {action.kind === 'order' ? `Pedido ${selected.number}` : selected.concept} · versión del vínculo {selected.link?.version ?? 0} {selected.link ? '(existente)' : '(nuevo)'}</p>{changingOrigin && <p className={styles.warning}>Cambiar vínculo: se retirará de {selected.link.campaignName || selected.link.campaignId} y se asociará a esta campaña. Ambas evaluaciones comerciales deberán recalcularse.</p>}{selected.link?.campaignId === campaignId && <label className={styles.checkRow}><input type="checkbox" checked={unlink} onChange={event => { setUnlink(event.target.checked); setAcknowledged(false); }}/>Retirar este vínculo sin borrar el pedido/gasto original</label>}</>}
        {!isLink && action.type === 'duplicate-from-recommendation' && <><p>La variante conserva la oferta, el texto y la pieza como punto de partida, sin copiar fechas, aprobación, autorizaciones de gasto ni vínculos financieros. No hereda comentarios, resultados ni enlace del original.</p><p>Idea: {action.recommendation.proposedChange?.text}</p><p>Elige los destinos y confirma un cambio real en la variable propuesta. La publicación y la inversión son decisiones posteriores.</p></>}
        {inPlace && <><p>Destino: {channels[action.option.channel]}. Solo cambiará {({ caption: 'el texto', asset: 'la imagen', placement: 'las ubicaciones' })[action.option.variable]}; se conservará la entrega y su aprobación histórica. No se escribe en Meta al preparar el borrador.</p><p>{action.option.channel === 'meta_ads' ? 'Conserva el total, público y fechas. Una pauta pausada no se reanuda sola y Meta puede volver a revisar el anuncio.' : 'Los totales acumulados no permiten aislar el efecto de un cambio de texto.'}</p></>}
        {(isLink || action.type === 'dismiss') && <Field field={{ name: 'reason', label: 'Motivo de la rectificación o decisión', type: 'textarea', required: true, max: 500, description: 'Entre 1 y 500 caracteres. Se conserva con actor, fecha y versión para auditoría.' }} value={reason} onChange={changeReason}/>}
        {(isLink || action.type === 'dismiss') && <button type="button" className="button subtle" disabled={assistant.assistantBusy || busy} onClick={assistant.openAssistant}>Ayúdame con el motivo</button>}
        <label className={styles.checkRow}><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/>{isLink ? 'Confirmo el registro seleccionado y el cambio de vínculo declarado; no atribuye ventas ni modifica dinero.' : action.type === 'dismiss' ? 'Revisé esta propuesta y confirmo que la descarto con el motivo indicado.' : 'Confirmo que solo se preparará un borrador; no autoriza publicación ni inversión.'}</label>
      </fieldset><div className={styles.actions}><button type="button" className="button subtle" disabled={busy || assistant.assistantBusy} onClick={close}>Cancelar</button><button type="submit" className="button primary" disabled={busy || assistant.assistantBusy || isLink && !selected}>{busy ? 'Guardando…' : isLink ? changingOrigin ? 'Cambiar vínculo' : unlink ? 'Retirar vínculo' : 'Guardar vínculo' : action.type === 'dismiss' ? 'Descartar propuesta' : inPlace ? 'Preparar cambio' : 'Crear variante'}</button></div>
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
  const [evidence, setEvidence] = useState(null);
  const sequence = useRef(0), reads = useRef(null), requestIds = useRef(new Map()), mutationControllers = useRef(new Set()), mounted = useRef(true), parentInteraction = useRef(onInteractionStateChange), headingRef = useRef(null), errorRef = useRef(null), listErrorRef = useRef(null), filterSummary = useRef(null), focusId = useRef(null), focusAccount = useRef(false);
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
  useEffect(() => { setError(''); setNotice(''); setAction(null); setEvidence(null); }, [id]);
  useEffect(() => {
    if (id || (!focusId.current && !focusAccount.current)) return;
    focusId.current = null;
    const target = focusAccount.current ? document.getElementById('social-account-measurement') : headingRef.current;
    focusAccount.current = false;
    target?.focus();
  }, [id]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (listError) listErrorRef.current?.focus(); }, [listError]);
  const queryKey = JSON.stringify({ campaignId: id, from: view.from || '', to: view.to || '', integrationMethod, scope, dimension, page: view.page || 1 });
  const current = snapshot?.key === queryKey, sameRecord = Boolean(id && snapshot?.campaignId === id);
  const campaign = sameRecord ? snapshot.campaign : null;
  const results = sameRecord ? snapshot.results : null;
  const hasDeliveries = Boolean(campaign?.deliveries?.length);
  const pending = current && (campaign?.deliveries?.some(item => ['queued', 'preparing', 'publishing', 'in_review'].includes(item.state)) || campaign?.operations?.some(item => ['prepared', 'sent', 'retry_wait'].includes(item.state) && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())) || ['pending', 'running', 'queued'].includes(results?.analysis?.job?.state));
  useEffect(() => {
    if (!id) { setLoading(false); return; }
    const controller = new AbortController(), seq = ++sequence.current; reads.current?.abort(); reads.current = controller;
    setLoading(true);
    const params = new URLSearchParams({ page: String(view.page || 1) });
    if (id) params.set('campaignId', id);
    for (const [key, value] of Object.entries({ from: view.from, to: view.to, integrationMethod, scope, dimension })) if (value) params.set(key, value);
    Promise.all([api(`${ROOT}/results?${params}`, { signal: controller.signal }), api(`${ROOT}/campaigns/${encodeURIComponent(id)}`, { signal: controller.signal }), api(`${ROOT}/campaigns/${encodeURIComponent(id)}/links`, { signal: controller.signal })]).then(([result, detail, links]) => {
      if (controller.signal.aborted || seq !== sequence.current) return;
      setError('');
      setSnapshot({ key: queryKey, campaignId: id, from: view.from || null, to: view.to || null, results: result, campaign: detail, links, loadedAt: new Date().toISOString() });
    }).catch(cause => { if (cause.name !== 'AbortError' && !controller.signal.aborted && seq === sequence.current) setError(cause.message); }).finally(() => { if (!controller.signal.aborted && seq === sequence.current) setLoading(false); });
    return () => controller.abort();
  }, [api, id, queryKey, view.from, view.to, view.page, integrationMethod, scope, dimension, revision, refresh]);
  useEffect(() => {
    if (!sameRecord || focusId.current === id) return;
    focusId.current = id;
    headingRef.current?.focus();
  }, [sameRecord, id]);
  useEffect(() => {
    if (sameRecord && view.resultsFocus) {
      const section = document.getElementById(`social-results-${view.resultsFocus}`);
      section?.focus({ preventScroll: true }); section?.scrollIntoView({ block: 'start' });
    }
  }, [sameRecord, id, view.resultsFocus]);
  useEffect(() => {
    let timer;
    const schedule = () => { clearTimeout(timer); if (document.visibilityState === 'visible') timer = setTimeout(() => { if (!action && !busy) setRefresh(value => value + 1); schedule(); }, pending ? 5000 : 60000); };
    const visible = () => { if (document.visibilityState === 'visible' && !action && !busy) setRefresh(value => value + 1); schedule(); };
    schedule(); document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [pending, action, busy]);
  useEffect(() => {
    if (id) return;
    const controller = new AbortController(); setListLoading(true);
    api(`${ROOT}/campaigns?${new URLSearchParams({ q: campaignQuery.q, page: String(campaignQuery.page) })}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setListError(''); setCampaignList(result); } }).catch(cause => { if (cause.name !== 'AbortError' && !controller.signal.aborted) setListError(cause.message); }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [api, campaignQuery, revision, id]);
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
    if (['duplicate-from-recommendation', 'prepare-in-place'].includes(type) && mounted.current) onNavigate?.({ section: 'advertising', tab: 'campaigns', record: result.id });
  }
  async function campaignAction(name) {
    if (!current || !campaign || busy || action || !hasDeliveries && ['analyze', 'sync'].includes(name)) return;
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
  function openEvidence(recommendation, captureId) {
    setEvidence({ recommendation, captureId });
  }
  function recommendationAction(next) {
    if (next.type === 'open-sample' || next.type === 'open-draft') return onNavigate?.({ section: 'advertising', tab: next.type === 'open-draft' ? 'campaigns' : 'results', record: next.campaignId });
    if (next.type === 'measurement' || next.type === 'offer_costs') {
      const section = document.getElementById(next.type === 'measurement' ? 'social-results-detail' : 'social-results-business');
      if (section) { section.open = true; section.scrollIntoView({ block: 'start' }); section.querySelector('summary')?.focus({ preventScroll: true }); }
    } else setAction(next);
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
    <header className={styles.heading}><div><p className={styles.eyebrow}>{id ? 'Resultados de esta publicación' : 'Rendimiento en Facebook e Instagram'}</p><h2 ref={headingRef} tabIndex={-1}>{campaign?.name || (id ? 'Resultados de la publicación' : 'Elige una publicación o campaña')}</h2>
      {!id && <p>Consulta qué reportó Meta para una publicación o baja a <a href="#social-account-measurement">Medición de la cuenta</a> para revisar fuentes y análisis histórico.</p>}</div>
      {id && <button type="button" className="button subtle" disabled={busy || !!action} onClick={() => change({ record: null, resultsFocus: null, page: 1 })}>Elegir otra publicación o campaña</button>}
    </header>
    {!id && <section className={styles.queryPanel} aria-label="Seleccionar publicación"><form method="post" onSubmit={event => { event.preventDefault(); setCampaignQuery({ q: campaignSearch.trim(), page: 1 }); }}><div className={styles.filterBar}><Field field={{ name: 'campaignSearch', label: 'Buscar publicaciones', max: 100 }} value={campaignSearch} onChange={setCampaignSearch}/><button type="submit" className="button subtle" disabled={listLoading}>Buscar publicaciones</button></div></form>
      {listError && <p ref={listErrorRef} tabIndex={-1} role="alert" className={styles.error}>{listError}<button type="button" className="text-button" onClick={() => setCampaignQuery(value => ({ ...value }))}>Reintentar listado</button></p>}
      <label className="field">Publicación o campaña<select value="" disabled={listLoading || Boolean(listError)} onChange={event => change({ record: event.target.value || null, resultsFocus: null, page: 1 })}><option value="">Elige por nombre</option>{campaignList?.campaigns?.map(item => <option key={item.id} value={item.id}>{item.name} · {campaignState(item)}</option>)}</select></label>
      {listLoading && <p role="status">Cargando publicaciones…</p>}{campaignList && campaignList.pages > 1 && <div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || !!action || listLoading || campaignList.page <= 1} onClick={() => setCampaignQuery({ q: campaignQuery.q, page: campaignList.page - 1 })}>Publicaciones anteriores</button><span>Página {campaignList.page} de {campaignList.pages} · {campaignList.total} publicaciones · búsqueda «{campaignQuery.q || 'todas'}»</span><button type="button" className="button subtle" disabled={busy || !!action || listLoading || campaignList.page >= campaignList.pages} onClick={() => setCampaignQuery({ q: campaignQuery.q, page: campaignList.page + 1 })}>Publicaciones siguientes</button></div>}
      {!listLoading && campaignList?.campaigns?.length === 0 && <p>{campaignQuery.q ? 'No hay coincidencias con ese nombre.' : 'Aún no hay piezas para consultar.'} <button type="button" className="text-button" onClick={() => onNavigate?.({ section: 'advertising', tab: 'campaigns', record: 'new' })}>Crear publicidad</button></p>}
    </section>}
    {notice && id && <p role="status" className={styles.notice}>{notice}</p>}{error && id && <div role="alert" tabIndex={-1} ref={errorRef} className={styles.error}>{error}<button type="button" className="button subtle" disabled={busy || !!action} onClick={() => setRefresh(value => value + 1)}>Reintentar lectura</button>{sameRecord && <p>Se conserva la lectura de esta ficha del {date(snapshot.loadedAt)}; no acredita una actualización exitosa.</p>}</div>}
    {loading && id && <p role="status">{sameRecord ? 'Actualizando sin borrar la evidencia anterior…' : 'Cargando resultados…'}</p>}
    {sameRecord && !current && <p className={styles.warning}>La lectura de esta ficha del {date(snapshot.loadedAt)} todavía corresponde a los filtros anteriores.</p>}
    {sameRecord && (hasDeliveries ? <Performance campaign={campaign} rows={results.performance}/> : <>
      <p className={styles.notice}><strong>{campaignState(campaign)}</strong> · Sin entregas; aún no hay rendimiento que analizar. Guardar o aprobar no equivale a publicar.</p>
      <ApprovedCampaign campaign={campaign} onNavigate={onNavigate}/>
    </>)}
    {sameRecord && <div className={styles.actions}><button type="button" className="button subtle" disabled={busy || !!action} onClick={() => onNavigate?.({ section: 'advertising', tab: 'campaigns', record: id })}>Administrar publicación</button>
      <button type="button" className="button subtle" disabled={loading || busy || !!action} onClick={() => setRefresh(value => value + 1)}>Actualizar vista</button>
      {campaign.deliveries?.length > 0 && <button type="button" className="button subtle" disabled={busy || !!action || !current} onClick={() => campaignAction('sync')}>Actualizar desde Meta</button>}
      {campaign.operations?.some(op => op.step.startsWith('amend:') && ['sent','uncertain'].includes(op.state)) && <button type="button" className="button subtle" disabled={busy || !!action || !current} onClick={() => campaignAction('reconcile')}>Comprobar el cambio sin reenviar</button>}
    </div>}
    {hasDeliveries && <Recommendations analysis={analysis} campaign={campaign} stale={analysisStale || !current || Boolean(error)} busy={busy || !!action || !current} onAnalyze={() => campaignAction('analyze')} onAction={recommendationAction} onEvidence={openEvidence}/>}
    {hasDeliveries && <Learnings id={id} key={id} api={api} refresh={snapshot.loadedAt} onNavigate={onNavigate} onEvidence={openEvidence}/>}
    {sameRecord && <details id="social-results-detail" className={styles.technicalDetails}><summary>Medición de esta pieza y filtros</summary>
    <div className={styles.queryPanel} aria-label="Filtrar métricas">
      <form method="post" onSubmit={applyPeriod}><fieldset disabled={busy || !!action} className="editor-fieldset"><div className={styles.fieldGrid}><Field field={{ name: 'from', type: 'date', label: 'Desde' }} value={from} onChange={value => setFrom(value || '')}/><Field field={{ name: 'to', type: 'date', label: 'Hasta' }} value={to} onChange={value => setTo(value || '')}/></div><div className={styles.actions}><button type="submit" className="button subtle">Aplicar fechas</button></div></fieldset></form>
      <details className={styles.filterDetails}><summary ref={filterSummary}>Más filtros de resultados</summary><div className={styles.fieldGrid}>{RESULT_FILTERS.map(([key, title, options]) => <label className="field" key={key}>{title}<select name={key} value={view[key] || ''} disabled={busy || !!action} onChange={event => change({ [key]: event.target.value || null, page: 1 })}><option value="">Todas, por separado</option>{Object.entries(options).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></label>)}</div></details>
      {!!resultFilters.length && <div className="active-filters" aria-label="Filtros de resultados">{resultFilters.map(([key, title, value]) => <button type="button" className="filter-chip" key={key} disabled={busy || !!action} aria-label={`Quitar filtro: ${title}: ${value}`} onClick={() => removeResultFilter(key)}>{title}: {value} <span aria-hidden="true">×</span></button>)}<button type="button" className="text-button" disabled={busy || !!action} onClick={clearResultFilters}>Limpiar filtros de resultados</button></div>}
      <p className={styles.help}>Las fechas seleccionan capturas compatibles; solo el desglose diario filtra días. No recortan el acumulado comercial de pedidos y gastos vinculados.</p>
      <p className={styles.help}>Actualizar vista solo lee datos locales. Pedir actualización a Meta encola una consulta al proveedor, sujeta a permisos y espera. Las lecturas locales automáticas ocurren cada {pending ? '5 segundos mientras hay trabajo pendiente' : '60 segundos con esta vista visible'}.</p>
    </div>
    <p>Si faltan permisos o la cuenta no está configurada, abre la medición de la cuenta para comprobar el acceso y las fuentes.</p>
    <button type="button" className="button subtle" disabled={busy || !!action} onClick={() => { focusAccount.current = true; change({ record: null, resultsFocus: null }); }}>Medición de la cuenta</button>
    </details>}
    {hasDeliveries && <details id="social-results-captures" className={styles.technicalDetails}><summary>Métricas completas, capturas y estado por destino</summary><div style={{ minWidth: 0 }} inert={!current ? true : undefined} className={styles.stack}>
      <p className={styles.muted}>Corte de lectura social {date(results.asOf)} · cargado localmente {date(snapshot.loadedAt)}. Alcance único entre entregas: no disponible sin deduplicación; no se suman personas de redes o campañas.</p>
      <section className={styles.panel}><h3>Estado de publicación por red</h3>{campaign?.restoreHold && <p className={styles.warning}>Bloqueo de restauración: comprobar el estado en Meta sin reenviar y aceptar la recuperación antes de continuar. Restaurar no detiene anuncios activos.</p>}{campaign?.state === 'scheduled' && campaign.revisions?.at(-1)?.spec?.publishAt && Date.parse(campaign.revisions.at(-1).spec.publishAt) < Date.now() && <p className={styles.warning}>La hora programada ya pasó y no hay confirmación de publicación en este estado. Revisa el procesamiento en segundo plano y las operaciones; el reloj local no acredita que se haya publicado.</p>}{!results.deliveries?.length && <p>No hay entregas aprobadas en esta selección. No significa cero resultados publicados fuera del módulo.</p>}{results.deliveries?.map(delivery => <article className={styles.card} key={delivery.id}><h4>{channels[delivery.channel] || delivery.channel} · {method(delivery.integrationMethod)}</h4><p>Estado local: {states[delivery.state] || delivery.state} · último estado confirmado: {states[delivery.lastConfirmedState] || delivery.lastConfirmedState || 'Sin confirmación remota'}</p><p>Última consulta correcta {date(delivery.metricSync?.lastSuccessAt)} · próximo turno {date(delivery.nextSyncAt || delivery.metricSync?.nextAt)}</p>{delivery.metricSync?.lastError && <p className={styles.warning}>Último error: {text(delivery.metricSync.lastError)}. Se conserva evidencia anterior.</p>}{delivery.metricSync?.blocked && <p className={styles.warning}>Consulta bloqueada: revisar conexión/permisos/interfaz. Actualizar no evade este bloqueo.</p>}{['uncertain', 'blocked', 'needs_attention', 'partial'].includes(delivery.state) && <p className={styles.warning}>Revisar operaciones y comprobar el estado en Meta sin reenviar desde la publicación.</p>}</article>)}</section>
      {grouped.size ? [...grouped].map(([key, group]) => <section key={key} className={styles.stack} style={{ minWidth: 0 }}><h3>{group.title}</h3>{group.items.map(({ item, delivery }) => <Measurement key={item.id} item={item} delivery={delivery}/>)}</section>) : current && !loading && !error && <section className={styles.empty}><h3>Sin capturas en esta selección</h3><p>No disponible no equivale a cero. Puede faltar una entrega, el horizonte, permiso para consultar resultados o una captura compatible con las fechas.</p>{resultFilters.length > 0 && <button type="button" className="button subtle" onClick={clearResultFilters}>Limpiar filtros de resultados</button>}</section>}
      {results.pages > 1 && <div className={styles.pagination}><button type="button" className="button subtle" disabled={busy || !!action || results.page <= 1} onClick={() => change({ page: results.page - 1 })}>Entregas anteriores</button><span>Página {results.page} de {results.pages} · {results.total} entregas</span><button type="button" className="button subtle" disabled={busy || !!action || results.page >= results.pages} onClick={() => change({ page: results.page + 1 })}>Entregas siguientes</button></div>}
        <details className={styles.technicalDetails}><summary>Comparar con la estimación y mi meta de costo</summary><Comparisons analysis={analysis} currency={campaign.currency} stale={analysisStale}/><UserCostTarget campaign={campaign} measurements={results.measurements || []}/></details>
        <ApprovedCampaign campaign={campaign} onNavigate={onNavigate}/>
    </div></details>}
    {hasDeliveries && results.business && <details id="social-results-business" className={styles.technicalDetails}><summary>Pedidos y gastos vinculados (separados de Meta)</summary><BusinessPanel business={results.business} stale={commercialStale} links={snapshot.links} onNavigate={onNavigate} onLink={(kind, record) => setAction({ type: 'link', kind, record })}/></details>}
    {action && current && <ResultActionDialog action={action} campaignId={id} api={api} requestIds={requestIds} onClose={() => setAction(null)} onSaved={saved} onInteractionStateChange={reportDialog}/>}
    {evidence && <EvidenceDialog key={evidence.captureId} evidence={evidence} api={api} onClose={() => setEvidence(null)}/>}
  </section>;
}
