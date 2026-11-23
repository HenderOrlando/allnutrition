import { readAdminView } from '../admin-view.mjs';
import { projectActiveAlertEpisodes } from '../business/alerts.mjs';
import { bogotaDate } from '../business/dates.mjs';
import { insightDetails, INSIGHT_ISSUES } from '../business/insights.mjs';
import { formatMoneyMinor, roundRatio } from '../business/money.mjs';
import { buildBusinessReportTx } from '../business/reports.mjs';
import { readSocialAnalysis } from '../business/social-analysis.mjs';
import { fail } from '../validation-core.mjs';
import { readAdvisorPreferencesTx } from './advisor-preferences.mjs';
import { createAssistantEvidence } from './evidence.mjs';
import { readAssistantBusiness, resumeAssistantBusinessRead } from './readers.mjs';
import { hashAssistantInput } from './repository.mjs';
import { assertAssistantAccess, getAssistantSettings } from './settings.mjs';

export const ADVISOR_RECOMMENDATION_ID = /^rec_[a-f0-9]{64}$/;
const LIMIT = 12;
const RECENT_IMPORT_MS = 7 * 86400000;
const PRIORITY = { critical: 0, warning: 1, info: 2 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATE_LABEL = {
  open: 'Abierta', acknowledged: 'Reconocida y aún activa', resolved: 'Episodio cerrado',
  review: 'En revisión', queued: 'En cola', previewing: 'Preparando la revisión', applying: 'En aplicación',
  completed: 'Terminada', completed_with_errors: 'Terminada con incidencias', failed: 'Detenida por fallo',
  uploaded: 'Pendiente de revisar', expired: 'Vencida', cancelled: 'Cancelada',
};
const SOCIAL_TITLES = {
  measurement_gap: 'Revisa qué datos faltan en publicidad', weak_link_ctr: 'Revisa la respuesta al enlace',
  possible_fatigue: 'Revisa la posible fatiga de la pieza', placement_cost_gap: 'Compara las ubicaciones medidas',
  organic_response: 'Revisa la respuesta orgánica', posting_window: 'Revisa la franja de publicación',
  declared_return_gap: 'Revisa la contribución después de pauta',
};
const formatNumber = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 6 });

// Compose readers on the caller's snapshot/transaction. A nested snapshot would
// deadlock SQLite; passing through only the needed capabilities also excludes writes.
function snapshot(tx) {
  const reader = { provider: tx.provider, t: tx.t.bind(tx), db: { get: tx.db.get.bind(tx.db), all: tx.db.all.bind(tx.db) } };
  for (const method of ['get', 'list', 'order', 'settings']) if (typeof tx[method] === 'function') reader[method] = tx[method].bind(tx);
  reader.readSnapshot = fn => fn(reader);
  return reader;
}
const jsonField = (tx, alias, path) => tx.provider === 'sqlite'
  ? `json_extract(${alias}.data,'$.${path}')` : `(${alias}.data::jsonb#>>'{${path.replaceAll('.', ',')}}')`;
const clock = now => new Date(typeof now === 'function' ? now() : now).toISOString();
const isCut = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const action = (label, view) => {
  const checked = readAdminView(view);
  if (view.record === 'new' || view.batch === 'new' || Object.entries(view).some(([key, value]) => checked[key] !== value)) return null;
  return { label, capabilityId: 'advisor.recommendations', view, focus: null, selection: null };
};
const fact = (domain, entityId, field, label, value, asOf, next, details = {}) => createAssistantEvidence({
  domain, entityId, field, label, value, asOf, asOfPrecision: asOf ? DATE.test(asOf) ? 'date' : 'instant' : 'unknown',
  href: next?.view ?? null, ...details,
});
const stateFact = (domain, id, label, state, asOf, next, version) => fact(domain, id, 'state', label, state, asOf, next, {
  recordVersion: version ?? null, formattedValue: STATE_LABEL[state] ?? 'Estado no informado',
});
const sortByPriority = focus => (a, b) => PRIORITY[a.card.severity] - PRIORITY[b.card.severity]
  || Number(b.card.area === focus) - Number(a.card.area === focus) || b.card.asOf.localeCompare(a.card.asOf)
  || a.card.id.localeCompare(b.card.id);
function candidate(userId, source, stamp, criterion, card) {
  const id = `rec_${hashAssistantInput([userId, source.kind, source.id, stamp])}`;
  return { card: { id, ...card }, source, criterion };
}

function alertAction(id) {
  return action('Abrir el registro de la alerta', { section: 'business', tab: 'alerts', status: 'all', record: id });
}
async function alertRecommendations(tx, userId) {
  const episodes = await projectActiveAlertEpisodes(tx);
  const cards = [];
  for (const episode of episodes) {
    const { id, title, reason, severity, asOf, material } = episode, next = alertAction(id);
    if (!next || !isCut(asOf)) continue;
    const area = episode.action.view?.section || (episode.action.orderId ? 'orders' : 'business');
    const evidence = [stateFact('alerts', id, 'Estado del episodio', material.state, asOf, next)];
    const available = material.facts.availableUnits;
    if (available != null && Number.isSafeInteger(Number(available))) {
      evidence.push(fact('alerts', id, 'availableUnits', 'Unidades disponibles en el corte', Number(available), asOf, next, { unit: 'count' }));
    }
    cards.push(candidate(userId, { kind: 'alert', id }, material, 'Comprobar si este episodio sigue activo.', {
      area, severity, title, reason, asOf, evidence, action: next,
      limitation: 'Es el último estado guardado de este episodio. No confirma por sí solo que la causa comercial se haya corregido.',
    }));
  }
  return cards;
}
async function alertState(tx, id) {
  return tx.db.get(`SELECT a.state,a.version,a.episode,a.rule_id,a.last_seen_at,r.enabled,r.version AS rule_version,r.updated_at AS rule_updated_at,
    ${jsonField(tx, 'a', 'resolvedAt')} AS resolved_at,${jsonField(tx, 'a', 'resolutionCode')} AS resolution_code
    FROM ${tx.t('alerts')} a JOIN ${tx.t('alert_rules')} r ON r.id=a.rule_id WHERE a.id=?`, [id]);
}

async function importRows(tx, userId, { id = null, cutoff = null } = {}) {
  const field = path => jsonField(tx, 'b', path);
  return tx.db.all(`SELECT b.id,b.state,b.source_id,b.version,b.updated_at,
    COALESCE(${field('completedAt')},${field('finishedAt')},b.updated_at) AS finished_at,
    ${field('preview.previewHash')} AS preview_hash,${field('preview.summary.total')} AS groups_total,
    ${field('preview.summary.conflict')} AS conflicts,${field('preview.summary.rejected')} AS rejected,
    ${field('preview.summary.skipped')} AS skipped,${field('preview.summary.settlementsPending')} AS settlements_pending,
    ${field('progress.errors')} AS errors,${field('progress.omitted')} AS omitted,
    ${field('progress.processed')} AS processed,${field('progress.total')} AS total,
    r.revision AS revision,r.preview_hash AS accepted_hash
    FROM ${tx.t('import_batches')} b LEFT JOIN ${tx.t('import_revisions')} r ON r.batch_id=b.id
      AND CAST(r.revision AS TEXT)=CAST(${field('acceptedRevision')} AS TEXT)
    WHERE ${field('createdBy')}=? ${id === null ? `AND (b.state='review' OR (b.state IN ('completed_with_errors','failed') AND b.updated_at>=?))` : 'AND b.id=?'}`,
  [userId, id ?? cutoff]);
}
const importAction = id => action('Abrir el lote de importación', { section: 'orders', tab: 'imports', batch: id });
function importRead(row) {
  const { id, state, version } = row, next = importAction(id);
  const asOf = ['completed', 'completed_with_errors'].includes(state) ? row.finished_at : row.updated_at;
  if (!next || !isCut(asOf)) return null;
  const conflicts = count(row.conflicts), rejected = count(row.rejected), groupsTotal = count(row.groups_total);
  const review = state === 'review' && HASH.test(row.preview_hash ?? '') && conflicts !== null && rejected !== null && groupsTotal !== null
    ? { groups: conflicts + rejected, settlements: count(row.settlements_pending), skipped: count(row.skipped), total: groupsTotal } : null;
  const errors = count(row.errors);
  const evidence = [stateFact('imports', id, 'Estado del lote', state, asOf, next, version)];
  if (review) {
    evidence.push(fact('imports', id, 'reviewGroupsWithIssues', 'Grupos en conflicto o rechazados', review.groups, asOf, next, { unit: 'count', recordVersion: version }));
    if (review.settlements !== null) evidence.push(fact('imports', id, 'pendingSettlements', 'Liquidaciones pendientes', review.settlements, asOf, next, { unit: 'count', recordVersion: version }));
  } else if (state === 'completed_with_errors' && errors !== null) {
    evidence.push(fact('imports', id, 'operationsWithIssues', 'Operaciones con incidencia (grupos o liquidaciones)', errors, asOf, next, { unit: 'count', recordVersion: version }));
  }
  return { asOf, action: next, evidence, review, errors };
}
async function importRecommendations(tx, userId, at) {
  const cutoff = new Date(Date.parse(at) - RECENT_IMPORT_MS).toISOString(), cards = [];
  for (const row of await importRows(tx, userId, { cutoff })) {
    const read = importRead(row);
    if (!read) continue;
    const { review } = read;
    let title, reason;
    if (review?.groups > 0 || review?.settlements > 0) {
      title = 'Revisa las incidencias de la importación';
      reason = 'La revisión guardada registra conflictos, rechazos o liquidaciones pendientes que puedes revisar en el lote.';
    } else if (row.state === 'completed_with_errors' && read.asOf >= cutoff) {
      title = 'Revisa el resultado de la importación';
      reason = 'El lote terminó con incidencias. No todo se aplicó; revisa el resultado guardado.';
    } else if (row.state === 'failed') {
      title = 'Revisa por qué se detuvo la importación';
      reason = 'El lote conserva un fallo. Consulta el diagnóstico antes de decidir si haces otra revisión.';
    } else continue;
    cards.push(candidate(userId, { kind: 'import', id: row.id }, row.version,
      'Comprobar si consta una revisión del mismo alcance sin incidencias, o un resultado final verificable del mismo lote.', {
        area: 'orders', severity: 'warning', title, reason, asOf: read.asOf, action: read.action, evidence: read.evidence,
        limitation: 'Los grupos y las liquidaciones son unidades distintas, no filas de Excel. Una revisión no aplica cambios.',
      }));
  }
  return cards;
}
async function importScope(tx, row) {
  const groups = await tx.db.all(`SELECT DISTINCT entity_key FROM ${tx.t('import_rows')} WHERE batch_id=? ORDER BY entity_key`, [row.id]);
  return groups.length ? hashAssistantInput([row.source_id, groups.map(group => group.entity_key)]) : null;
}

const reportAction = view => action('Abrir los datos del informe', view);
const comparisonInsight = id => /^(contribution_(decline|growth)|(onTimeDeliveries|shipmentReturnRate)_(improved|worsened))$/.test(id);
function reportView(href) {
  if (!href) return null;
  const url = new URL(href, 'https://assistant.invalid');
  if (url.origin !== 'https://assistant.invalid' || url.pathname !== '/admin') return null;
  const { section, tab, record, period, anchor, issue } = readAdminView(url.searchParams);
  return section === 'reports' && tab && record && period && anchor ? { section, tab, record, period, anchor, ...(issue ? { issue } : {}) } : null;
}
async function reportRevision(tx) {
  return count((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`))?.value);
}
async function reportRecommendations(tx, userId, session, at) {
  const store = snapshot(tx), revision = await reportRevision(tx);
  // The existing reader uses buildInsights (including its adequacy rules). Report
  // observations come first; alert episodes and social snapshots are loaded below
  // by their own native readers for their source dates and recheck criteria.
  let page = await readAssistantBusiness(store, session, {
    domain: 'recommendations', query: { period: 'month', anchor: bogotaDate(at) }, select: { mode: 'records', limit: LIMIT },
  });
  const comparison = page.summary.comparison, bounds = page._dataset;
  const cards = [];
  for (;;) {
    for (const record of page.records) append(record);
    if (!page._continuation || page.continuation.remainingRecords === 0
      || page.records.some(record => record.category != null && !['improvement', 'success'].includes(record.category))) break;
    page = await resumeAssistantBusinessRead(store, session, page._continuation);
  }
  return cards;

  function append(record) {
    const view = reportView(record.href), next = view && reportAction(view);
    if (!next || !['improvement', 'success'].includes(record.category)) return;
    const sourceFacts = page.evidence.filter(ref => ref.entityId === record.id && record.evidenceIds?.includes(ref.id));
    const ref = sourceFacts.find(item => item.field === 'value');
    const subset = INSIGHT_ISSUES.includes(record.id) ? record.id : null;
    const compared = comparisonInsight(record.id);
    const interval = compared ? comparison?.currentBounds : bounds;
    if (!ref || !Number.isSafeInteger(ref.value) || !isCut(ref.asOf) || !interval?.startDate || !interval.endDateExclusive || (!subset && !compared)) return;
    const source = { kind: 'report', id: record.id, metric: view.record, subset, interval: {
      startDate: interval.startDate, endDateExclusive: interval.endDateExclusive,
    }, elapsed: compared && comparison.mode === 'elapsed', revision };
    const evidence = [ref, ...sourceFacts.filter(item => item.field === 'previousValue' && item.value !== null)];
    cards.push(candidate(userId, source, [revision, view, source.interval, ref.value, ref.unit],
      'Comparar la misma medida en el mismo período, unidad y alcance cuando haya otro corte.', {
        area: 'reports', severity: record.category === 'improvement' ? 'warning' : 'info', title: record.title,
        reason: record.reason, asOf: ref.asOf, action: next, evidence,
        limitation: `Período: ${source.interval.startDate} a ${source.interval.endDateExclusive} (fin excluido). La cobertura del informe limita lo que se puede concluir; no se identifica una causa.`,
      }));
  }
}

const socialAction = campaign => action('Abrir recomendaciones guardadas de la campaña', {
  section: 'advertising', tab: 'results', record: campaign, resultsFocus: 'recommendations',
});
function socialUnit(metric) {
  if (metric?.endsWith('Minor')) return 'minor';
  if (metric?.endsWith('Percent')) return 'percent';
  if (metric === 'organicResponse') return 'ratio';
  if (metric === 'reach') return 'count';
  return null;
}
function socialGapScope(analysis) {
  const windows = (analysis.comparisons || []).filter(read => read.metric === analysis.primary && read.periodStart && read.periodEnd)
    .map(read => hashAssistantInput([read.channel, read.periodStart, read.periodEnd,
      read.forecastRange?.scope ?? null, read.forecastRange?.unit ?? null, read.forecastRange?.horizon ?? null])).sort();
  return analysis.specHash && analysis.primary && windows.length
    ? hashAssistantInput([analysis.specHash, analysis.primary, windows]) : null;
}
function socialGapEvidence(campaign, asOf, gaps, item) {
  return fact('advertising', item?.id ?? campaign, 'measurementGaps', 'Requisitos de medición pendientes', gaps, asOf, socialAction(campaign), {
    unit: 'count', recordVersion: item?.version,
    coverage: { state: gaps ? 'partial' : 'complete', knownCount: null, eligibleCount: null, excludedCount: null, reasons: [] },
  });
}
async function socialRead(tx, campaign, analysis, item) {
  const next = socialAction(campaign), primary = item.primaryEvidence, asOf = item.evidenceAsOf ?? analysis.asOf;
  if (!next || !isCut(asOf) || !primary) return null;
  const field = primary.metric || 'measurementCoverage';
  if (item.ruleKey === 'measurement_gap') {
    if (!Array.isArray(primary.missing) || !primary.missing.length) return null;
    return { evidence: socialGapEvidence(campaign, asOf, primary.missing.length, item), scope: socialGapScope(analysis) };
  }
  const unit = socialUnit(field);
  if (!Number.isFinite(primary.value) || !unit) return null;
  const periods = Array.isArray(primary.periods) ? primary.periods : [];
  // resultKey carries source/definition, entity, attribution, unit and reporting
  // scope. The saved window and delivery identify the interval, not the capture ID.
  const ids = [...new Set(periods.map(period => period.captureId))];
  const saved = ids.length ? await tx.db.all(`SELECT m.id,m.delivery_id,
      ${jsonField(tx, 'm', 'resultKey')} AS result_key,${jsonField(tx, 'm', 'currency')} AS currency
      FROM ${tx.t('social_measurements')} m JOIN ${tx.t('social_deliveries')} d ON d.id=m.delivery_id
      WHERE d.campaign_id=? AND m.id IN (${ids.map(() => '?').join(',')})`, [campaign, ...ids]) : [];
  const source = new Map(saved.map(row => [row.id, row]));
  const currency = saved.find(row => row.currency)?.currency ?? null;
  const scope = analysis.specHash && periods.length && saved.length === ids.length && saved.every(row => HASH.test(row.result_key ?? ''))
    ? hashAssistantInput([analysis.specHash, field, primary.channel ?? null, primary.window ?? null, primary.placement ?? null,
      primary.comparedPlacement ?? null, primary.primaryMetric ?? null,
      // Financial coverage depends on the linked facts too, not just impressions.
      field === 'contributionAfterAdvertisingMinor' ? analysis.linkVersions ?? null : null,
      periods.map(period => hashAssistantInput([source.get(period.captureId).delivery_id, source.get(period.captureId).result_key,
        period.start, period.end, period.timeZone])).sort()]) : null;
  const value = primary.value;
  const formattedValue = unit === 'minor' ? `${formatNumber.format(value / 100)} ${currency || '· moneda no informada'}`
    : unit === 'percent' ? `${formatNumber.format(value)} %` : formatNumber.format(value);
  return { evidence: fact('advertising', item.id, field, SOCIAL_TITLES[item.ruleKey] || 'Valor guardado en el análisis', value, asOf, next, {
    unit, recordVersion: item.version, formattedValue,
  }), scope };
}
async function socialRecommendations(tx, userId, at) {
  const cards = [], store = snapshot(tx);
  const campaigns = await tx.db.all(`SELECT c.id FROM ${tx.t('social_campaigns')} c
    WHERE ${jsonField(tx, 'c', 'analysis.evidenceHash')} IS NOT NULL
    ORDER BY ${jsonField(tx, 'c', 'analysis.asOf')} DESC,c.id`);
  for (const { id: campaign } of campaigns) {
    const analysis = await readSocialAnalysis(store, campaign, { asOf: at });
    if (analysis.status !== 'current') continue;
    for (const item of analysis.recommendations) {
      const title = SOCIAL_TITLES[item.ruleKey];
      if (item.state !== 'suggested' || !title || !item.observation) continue;
      const read = await socialRead(tx, campaign, analysis, item);
      if (!read) continue;
      const gap = item.ruleKey === 'measurement_gap';
      cards.push(candidate(userId, { kind: 'social', id: item.id, campaign, rule: item.ruleKey, scope: read.scope, checkedAt: analysis.checkedAt ?? analysis.asOf },
        [item.version, analysis.evidenceHash], gap ? 'Comprobar si un corte posterior aporta la medición que falta con el mismo alcance.'
          : 'Comparar la misma medida, período y alcance de la campaña en otro corte guardado.', {
          area: 'advertising', severity: 'info', title, reason: item.observation, asOf: read.evidence.asOf,
          evidence: [read.evidence], action: socialAction(campaign),
          limitation: 'Solo usa el análisis local guardado. No consulta Meta ni propone publicar, invertir o atribuir una causa.',
        }));
    }
    if (cards.length >= LIMIT) break;
  }
  return cards;
}

async function visibleRecommendations(tx, session, at) {
  const { version } = await getAssistantSettings(tx);
  const { userId } = await assertAssistantAccess(tx, session, version);
  const { focusArea } = await readAdvisorPreferencesTx(tx, userId);
  const candidates = [
    ...await alertRecommendations(tx, userId), ...await importRecommendations(tx, userId, at),
    ...await reportRecommendations(tx, userId, session, at), ...await socialRecommendations(tx, userId, at),
  ];
  candidates.sort(sortByPriority(focusArea));
  return candidates.filter((item, index) => index < LIMIT || item.card.severity === 'critical');
}
export function readAdvisorRecommendations(store, session, { now = Date.now } = {}) {
  return store.readSnapshot(async tx => ({ items: (await visibleRecommendations(tx, session, clock(now))).map(item => item.card) }));
}

// Resolve against the visible, session-scoped set again. The client supplies a
// recommendation identity, not its evidence, criterion, destination or source.
export async function captureAdvisorRecommendation(tx, session, id, { now = Date.now } = {}) {
  if (typeof id !== 'string' || !ADVISOR_RECOMMENDATION_ID.test(id)) fail('Recomendación no válida.', 422);
  const item = (await visibleRecommendations(tx, session, clock(now))).find(entry => entry.card.id === id);
  if (!item) fail('La recomendación ya no está disponible. Vuelve a revisar Hoy.', 404);
  const { source, criterion, card } = item;
  let baseline = card.evidence[0];
  if (source.kind === 'alert') {
    const row = await alertState(tx, source.id);
    if (!row || !Number(row.enabled) || row.state !== baseline.value || row.last_seen_at !== baseline.asOf) fail('La alerta cambió. Vuelve a revisar Hoy.', 409);
    Object.assign(source, { episode: row.episode, ruleId: row.rule_id, ruleVersion: row.rule_version });
    baseline = stateFact('alerts', source.id, 'Estado del episodio', row.state, row.last_seen_at, card.action, row.version);
  }
  if (source.kind === 'import') {
    const [row] = await importRows(tx, session.user.id, { id: source.id });
    if (!row || row.version !== baseline.recordVersion) fail('El lote cambió. Vuelve a revisar Hoy.', 409);
    const read = importRead(row);
    Object.assign(source, { scope: await importScope(tx, row), revision: row.revision, review: read.review });
  }
  if (source.kind === 'report' && source.subset === 'costly_returns') {
    const { view } = card.action;
    const report = await buildBusinessReportTx(tx, { period: view.period, anchorDate: view.anchor, asOf: baseline.asOf });
    const summary = insightDetails(report, { metric: source.metric, issue: source.subset })?.summary;
    source.scope = summary?.reason != null && summary.value === baseline.value ? hashAssistantInput(summary.reason) : null;
  }
  return { source, baseline, criterion, action: card.action };
}

const result = (state, message, current = null) => ({ state, message, current });
const notComparable = (message, current) => result('not_comparable', message, current);
const pending = (message, current) => result('pending', message, current);
const changed = (message, current) => result('changed', message, current);
const resolved = (message, current) => result('resolved', message, current);

async function compareAlert(tx, { source, baseline, action: next }) {
  const row = await alertState(tx, source.id);
  if (!row || row.episode !== source.episode || row.rule_id !== source.ruleId) {
    return { ...notComparable('No se encuentra el mismo episodio. No puedo confirmar un resultado.'), sourceUnavailable: true };
  }
  const current = stateFact('alerts', source.id, 'Estado del episodio', row.state, row.last_seen_at, next, row.version);
  if (!Number(row.enabled) || row.resolution_code === 'rule_disabled' || row.rule_version !== source.ruleVersion) {
    const rule = fact('alerts', source.id, 'ruleEnabled', 'Regla que originó la alerta', Boolean(Number(row.enabled)), row.rule_updated_at, next, {
      recordVersion: row.rule_version, formattedValue: Number(row.enabled) ? 'Sigue activa, con otra revisión' : 'Desactivada',
    });
    return changed('Cambió la regla de la alerta. Eso no confirma que se haya corregido la situación comercial.', rule);
  }
  if (row.state === 'resolved') {
    return row.resolution_code === 'condition_not_confirmed' && row.resolved_at > baseline.asOf
      ? resolved('El corte posterior registra el cierre de este episodio. No demuestra qué hizo que dejara de estar activo.', current)
      : notComparable('El episodio figura cerrado, pero no hay una comprobación posterior comparable de la condición.', current);
  }
  return pending(row.last_seen_at > baseline.asOf ? 'El episodio sigue activo en la lectura posterior.' : 'El episodio sigue activo; todavía no hay un corte posterior.',
    row.version !== baseline.recordVersion ? current : null);
}

async function compareImport(tx, session, { source, baseline }) {
  const [row] = await importRows(tx, session.user.id, { id: source.id });
  const current = row && importRead(row);
  if (!current) return { ...notComparable('No se encuentra el mismo lote en tu ámbito. No hay un resultado comprobable.'), sourceUnavailable: true };
  if (row.version === baseline.recordVersion) return pending('El mismo lote sigue pendiente de otra revisión o un resultado posterior.');
  const evidence = current.evidence[0];
  if (['expired', 'cancelled'].includes(row.state)) return changed('El lote cambió de estado. No confirma que se hayan resuelto sus incidencias.', evidence);
  if (['previewing', 'queued', 'applying'].includes(row.state)) return pending('El lote tiene trabajo en proceso. Aún no hay un resultado final.', evidence);
  if (current.asOf <= baseline.asOf || !source.scope || await importScope(tx, row) !== source.scope) {
    return notComparable('No hay un corte posterior con el mismo alcance de grupos. No puedo confirmar que se resolvieran las incidencias.', evidence);
  }
  const { review } = current;
  if (review && source.review && review.total === source.review.total && review.skipped === 0 && review.settlements === 0 && review.groups === 0) {
    return resolved('La nueva revisión del mismo alcance ya no registra esas incidencias. La revisión no aplica cambios.', evidence);
  }
  if (row.state === 'completed' && row.revision !== source.revision && row.revision != null && HASH.test(row.accepted_hash ?? '')
    && current.errors === 0 && count(row.omitted) === 0 && count(row.total) > 0 && count(row.processed) === count(row.total)) {
    const incomplete = await tx.db.get(`SELECT 1 AS pending FROM ${tx.t('import_rows')} ir WHERE ir.batch_id=?
      AND ir.state<>'applied' AND NOT (ir.state='skipped' AND ${jsonField(tx, 'ir', 'applied')} IS NOT NULL) LIMIT 1`, [row.id]);
    if (!incomplete) return resolved('El lote registra una revisión aceptada posterior, terminada sin operaciones omitidas ni con incidencias. No se aplicó desde Ali.', evidence);
  }
  if (review?.groups > 0 || review?.settlements > 0 || ['failed', 'completed_with_errors'].includes(row.state)) {
    return pending('El lote aún registra incidencias. Revisa su estado en lugar de asumir que todo se aplicó.', evidence);
  }
  return notComparable('El estado es distinto, pero no acredita un resultado para las incidencias que seguías.', evidence);
}

function reportRate(report, metric) {
  const all = report.facts[metric] || [], known = all.filter(fact => fact.known !== false && fact.value != null && fact.occurredOn
    && (metric !== 'onTimeDeliveries' || fact.estimatedDeliveryOn));
  if (known.length < 20 || known.length * 10 < all.length * 9) return null;
  return roundRatio(known.reduce((sum, fact) => sum + BigInt(fact.value), 0n) * 10000n, known.length);
}
async function compareReport(tx, { source, baseline, action: next }, at) {
  const revision = await reportRevision(tx);
  if (revision === source.revision) return pending('Todavía no hay otra revisión de los datos del informe.');
  const { view } = next, interval = source.interval;
  const report = await buildBusinessReportTx(tx, { period: view.period, anchorDate: view.anchor, asOf: at },
    source.elapsed ? { endDateExclusive: interval.endDateExclusive } : undefined);
  const metric = report.metrics[source.metric];
  if (!metric || report.bounds.startDate !== interval.startDate || report.bounds.endDateExclusive !== interval.endDateExclusive || report.dataAsOf <= baseline.asOf) {
    return notComparable('No hay un nuevo corte con el mismo período y alcance. No comparo cifras de ventanas distintas.');
  }
  const detail = source.subset ? insightDetails(report, { metric: source.metric, issue: source.subset })?.summary : null;
  const rate = baseline.unit === 'bps' && !detail;
  const unit = detail ? detail.unit : metric.unit;
  const value = detail ? detail.complete && (detail.eligibleCount > 0 || metric.complete) ? detail.value : null
    : rate ? reportRate(report, source.metric) : metric.complete ? metric.value : null;
  const formattedValue = value == null ? null : unit === 'minor' ? formatMoneyMinor(value) : unit === 'bps' ? `${formatNumber.format(value / 100)} %` : null;
  const current = fact('reports', source.id, 'value', baseline.label, value, report.dataAsOf, next, { unit, formattedValue, recordVersion: revision });
  if (source.subset === 'costly_returns' && (!source.scope || detail?.reason == null || hashAssistantInput(detail.reason) !== source.scope)) {
    return notComparable('El motivo principal no corresponde al mismo grupo de devoluciones. No comparo ambos importes como si fueran el mismo alcance.', current);
  }
  if (value === null || unit !== baseline.unit) return notComparable('El corte posterior no tiene cobertura o unidad comparable para esta medida.', current);
  return value === baseline.value ? pending('El corte posterior comparable conserva el mismo valor.', current)
    : changed('El valor cambió en un corte comparable del mismo período y alcance. No demuestra qué causó el cambio.', current);
}

async function compareSocial(tx, { source, baseline }, at) {
  const campaign = await tx.db.get(`SELECT id FROM ${tx.t('social_campaigns')} WHERE id=?`, [source.campaign]);
  if (!campaign) return { ...notComparable('La campaña ya no está disponible en los registros locales.'), sourceUnavailable: true };
  const analysis = await readSocialAnalysis(snapshot(tx), source.campaign, { asOf: at });
  if (analysis.status !== 'current') return notComparable('No hay un análisis local vigente y comparable. No consulté Meta ni solicité otro análisis.');
  const item = analysis.recommendations.find(entry => entry.ruleKey === source.rule);
  const checkedAt = analysis.checkedAt ?? analysis.asOf;
  if (checkedAt <= source.checkedAt && item?.id === source.id && item.state === 'suggested') return pending('Todavía no hay un corte posterior guardado de esta campaña.');
  if (source.rule === 'measurement_gap' && analysis.asOf > baseline.asOf && Array.isArray(analysis.gaps)) {
    const gapCount = analysis.gaps.length, current = socialGapEvidence(source.campaign, analysis.asOf, gapCount, item);
    if (!source.scope || socialGapScope(analysis) !== source.scope) {
      return notComparable('El análisis posterior no acredita el mismo horizonte y alcance de medición.', current);
    }
    if (gapCount === 0 && analysis.observationComplete === true) {
      return resolved('El análisis local posterior registra observación completa y no encuentra requisitos de medición pendientes para el mismo alcance.', current);
    }
    return gapCount !== baseline.value ? changed('Cambió la cantidad de requisitos de medición pendientes. Aún no consta una observación completa.', current)
      : pending('El análisis posterior aún no acredita una observación completa.', current);
  }
  const current = item && await socialRead(tx, source.campaign, analysis, item);
  if (!current || current.evidence.asOf <= baseline.asOf || !source.scope || current.scope !== source.scope
    || current.evidence.field !== baseline.field || current.evidence.unit !== baseline.unit || current.evidence.value === null) {
    return notComparable('La señal pudo cambiar, pero el análisis guardado no permite comparar la misma medida, período y alcance.', current?.evidence ?? null);
  }
  return current.evidence.value === baseline.value ? pending('El mismo valor consta en la captura posterior comparable.', current.evidence)
    : changed('El valor cambió en una captura posterior comparable. No lo atribuyo a la recomendación.', current.evidence);
}

export async function resolveAdvisorFollowUp(tx, session, task, { now = Date.now } = {}) {
  if (task.status === 'cancelled') return task;
  const saved = task.data.recommendation, { source, baseline } = saved;
  const at = clock(now);
  let comparison;
  switch (source.kind) {
    case 'alert': comparison = await compareAlert(tx, saved); break;
    case 'import': comparison = await compareImport(tx, session, saved); break;
    case 'report': comparison = await compareReport(tx, saved, at); break;
    case 'social': comparison = await compareSocial(tx, saved, at); break;
    default: fail('Fuente de seguimiento no válida.', 422);
  }
  const { state, message, current, sourceUnavailable } = comparison;
  const done = state === 'resolved';
  const known = [{ label: 'Qué estás siguiendo', value: saved.criterion }];
  if (source.kind === 'report') known.push({ label: 'Período del informe', value: `${source.interval.startDate} a ${source.interval.endDateExclusive} (fin excluido)` });
  return { ...task, status: done ? 'completed' : 'waiting_result', step: done ? 'done' : 'review-follow-up', data: {
    ...task.data, progress: { message, known, action: sourceUnavailable ? null : saved.action, followUp: { state, baseline, current } },
  } };
}
