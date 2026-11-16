import { fail, integer } from '../validation-core.mjs';
import { entity, hash, insertRow, newId, stamp, assertLease, audit } from './commands.mjs';
import { getSocialConnection } from './social.mjs';
import { SOCIAL_BUSINESS_OBJECTIVES, socialMeasurementDTO } from '../social/measurement-model.mjs';
import { loadSocialRuntime } from '../social/config.mjs';
import { decryptCredentials } from '../social/credentials.mjs';
import { queueJobTx, claimJob, finishJob, withLeaseHeartbeat } from './job-leases.mjs';
import { createMetaAccountHistoryReader, currentHistoryRules, metaHistoryPeriod, initialHistoryTasks, resourceHistoryTasks, exactDecimal } from '../social/meta-account-history.mjs';

const PREFIX = 'social:account-analysis:';
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const OBJECTIVES = new Set(SOCIAL_BUSINESS_OBJECTIVES);
const parse = row => row ? JSON.parse(row.data) : null;
const validResource = value => typeof value === 'string' && /^(?:act_)?\d+$/.test(value);
const objectiveOf = connection => {
  const objective = socialMeasurementDTO(connection).objective;
  return OBJECTIVES.has(objective) ? objective : 'reach';
};
const connectionFence = connection => hash({ epoch: connection.sessionEpoch || 0, configuration: connection.configurationFingerprint || null, identities: connection.identities || {}, resources: connection.resources || {}, authenticationMethod: connection.authenticationMethod || 'oauth', revalidationRequired: connection.revalidationRequired === true });
async function assertActor(tx, actorId) {
  if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
}
function safeResource(kind, row, pageId = null) {
  if (!validResource(row?.id)) return null;
  return { kind, id: kind === 'ad_account' ? `act_${row.id.replace(/^act_/, '')}` : row.id, tasks: Array.isArray(row.tasks) ? row.tasks.filter(value => ['ANALYZE', 'AA_ANALYZE', 'MANAGE', 'ADVERTISE'].includes(value)) : [], ...(pageId ? { pageId } : {}), ...(kind === 'ad_account' ? { currency: /^[A-Z]{3}$/.test(row.currency || '') ? row.currency : null, timeZone: typeof row.timeZone === 'string' && /^[A-Za-z_\-/+]{1,100}$/.test(row.timeZone) ? row.timeZone : null } : {}) };
}
function addResource(data, resource) {
  if (!resource) return;
  const key = `${resource.kind}:${resource.id}`;
  if (data.resources[key]) return;
  data.resources[key] = resource;
  data.coverage[key] = { kind: resource.kind, resourceId: resource.id, state: 'pending', completedUnits: 0, pages: 0, objects: 0, missing: [], notice: resource.kind === 'facebook' ? 'Contenido actualmente devuelto por published_posts, incluso anterior al año. Meta puede limitar a aproximadamente 600 posts clasificados por año; no equivale a inventario exhaustivo.' : resource.kind === 'instagram' ? 'Contenido actualmente accesible por media, incluso anterior al año; fecha de publicación y métricas lifetime separadas. Stories vencidas no recuperables.' : 'Insights del intervalo anual y campañas/adsets actuales sin corte por fecha de creación; reglas actuales no acreditan las históricas.' };
  data.work.push(...resourceHistoryTasks(resource.kind, resource.id, resource.pageId).map(task => ({ ...task, resourceTasks: resource.tasks, ...(resource.timeZone ? { timeZone: resource.timeZone } : {}), coverageKey: key })));
  data.stats.resources++;
}
async function persistAnalysis(tx, row, data, state, now) {
  await tx.db.run(`UPDATE ${tx.t('social_account_analyses')} SET state=?,data=?,version=version+1,updated_at=? WHERE id=? AND version=?`, [state, JSON.stringify(data), now, row.id, row.version]);
}
async function cancelTx(tx, row, now, reason = 'cancelled_by_user') {
  const data = parse(row); data.phase = 'cancelled'; data.error = { code: reason, notice: 'Análisis local cancelado; no se modificó Meta.' }; data.retryAt = null;
  await persistAnalysis(tx, row, data, 'cancelled', now);
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL,error_code=?,finished_at=?,updated_at=?,version=version+1 WHERE key=?`, [reason, now, now, PREFIX + row.id]);
}
/** Called inside the connection transaction, after encrypted credentials are saved.
 * No provider I/O, nested transactions, settings revision or remote mutation. */
export async function queueMetaAccountAnalysisTx(tx, connection, actorId, { now = stamp(), force = false } = {}) {
  if (connection.provider !== 'meta' || connection.integrationMethod !== 'api' || connection.state !== 'connected') return null;
  now = new Date(now).toISOString();
  await assertActor(tx, actorId);
  const credential = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  if (!credential) fail('La conexión necesita autenticarse de nuevo.', 409);
  const configuration = await tx.db.get(`SELECT version FROM ${tx.t('social_integration_settings')} WHERE id=1`);
  const fence = connectionFence(connection);
  const prior = await tx.db.get(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [connection.id]);
  const old = parse(prior);
  const fresh = old?.period?.until === now.slice(0, 10) || ACTIVE.has(prior?.state);
  if (!force && prior && fresh && old.fence === fence && old.credentialVersion === credential.version && old.configurationVersion === (configuration?.version || 0) && !['cancelled', 'failed'].includes(prior.state)) return { id: prior.id, state: prior.state };
  const active = await tx.db.all(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE connection_id=? AND state IN ('queued','running','waiting')`, [connection.id]);
  for (const row of active) await cancelTx(tx, row, now, 'superseded');
  const id = newId();
  const data = { schemaVersion: 1, fence, credentialVersion: credential.version, configurationVersion: configuration?.version || 0, period: metaHistoryPeriod(now), rules: currentHistoryRules(now), resources: {}, coverage: {
    discovery_facebook: { kind: 'facebook', resourceId: null, state: 'pending', missing: [] },
    discovery_instagram: { kind: 'instagram', resourceId: null, state: 'pending', missing: [] },
    discovery_ads: { kind: 'ad_account', resourceId: null, state: 'pending', missing: [] }
  }, work: initialHistoryTasks(), stats: { completedUnits: 0, pages: 0, objects: 0, resources: 0 }, phase: 'discovery', retryAt: null, attempts: 0, error: null };
  for (const row of connection.resources?.adAccounts || []) addResource(data, safeResource('ad_account', row));
  for (const row of connection.resources?.pages || []) {
    addResource(data, safeResource('facebook', row));
    if (validResource(row.instagramId)) addResource(data, safeResource('instagram', { id: row.instagramId, tasks: row.tasks }, row.id));
  }
  const createdAt = prior && prior.created_at >= now ? new Date(Date.parse(prior.created_at) + 1).toISOString() : now;
  await insertRow(tx, 'social_account_analyses', { id, connection_id: connection.id, actor_id: actorId, state: 'queued', data: JSON.stringify(data), version: 1, created_at: createdAt, updated_at: now });
  await queueJobTx(tx, PREFIX + id, { analysisId: id, connectionId: connection.id, phase: 'read' }, { now });
  return { id, state: 'queued' };
}
async function fenceTx(tx, row, data, runtime, now) {
  await assertActor(tx, row.actor_id);
  const connection = await getSocialConnection(tx, row.connection_id);
  const credential = await tx.db.get(`SELECT * FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [row.connection_id]);
  const configuration = await tx.db.get(`SELECT version FROM ${tx.t('social_integration_settings')} WHERE id=1`);
  if (connection.state !== 'connected' || connection.revalidationRequired || connection.disconnectPending || connectionFence(connection) !== data.fence || credential?.version !== data.credentialVersion || (configuration?.version || 0) !== data.configurationVersion || runtime && (runtime.configurationVersion !== data.configurationVersion || connection.configurationFingerprint !== runtime.fingerprint)) fail('La autorización, los recursos o la configuración cambiaron. Actualiza el análisis.', 409);
  if (connection.expiresAt && connection.expiresAt <= now) fail('La autorización de Meta venció. Reconecta la cuenta.', 409);
  return { connection, credential };
}
// A retry delay is stored durably. Scan in bounded DB pages, not an unbounded
// response, so an earlier throttled connection cannot starve a runnable one.
async function runnableAnalysis(store, now) {
  let after = '';
  for (;;) {
    const rows = await store.db.all(`SELECT a.* FROM ${store.t('social_account_analyses')} a JOIN ${store.t('job_runs')} j ON j.key=? || a.id WHERE a.id>? AND a.state IN ('queued','running','waiting') AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?)) ORDER BY a.id LIMIT 100`, [PREFIX, after, now]);
    for (const row of rows) { const data = parse(row); if (!data.retryAt || data.retryAt <= now) return row; }
    if (rows.length < 100) return null;
    after = rows.at(-1).id;
  }
}
function workCoverageKey(task) {
  return task.coverageKey || (task.kind === 'discover_ads' ? 'discovery_ads' : 'discovery_facebook');
}
function recordMissing(coverage, { stage = 'access', reason, objectId = null }) {
  let entry = coverage.missing.find(value => value.stage === stage && value.reason === reason);
  if (!entry) { entry = { stage, reason, count: 0, sampleObjectIds: [] }; coverage.missing.push(entry); }
  entry.count++;
  if (objectId && entry.sampleObjectIds.length < 3 && !entry.sampleObjectIds.includes(objectId)) entry.sampleObjectIds.push(objectId);
}
function updateCoverage(data, task, { objects = 0, pages = 1, next = false, error = null } = {}) {
  const key = workCoverageKey(task), coverage = data.coverage[key];
  if (!coverage) return;
  coverage.completedUnits = (coverage.completedUnits || 0) + 1;
  coverage.pages = (coverage.pages || 0) + (error ? 0 : pages);
  coverage.objects = (coverage.objects || 0) + objects;
  if (error) recordMissing(coverage, { stage: task.kind, objectId: task.kind === 'organic_metrics' ? task.resourceId : null, reason: error });
  const pending = next || data.work.some(work => workCoverageKey(work) === key);
  coverage.state = pending ? 'running' : coverage.missing.length ? coverage.pages ? 'partial' : error === 'permission' ? 'denied' : 'unavailable' : 'accessible_complete';
  if (task.kind === 'discover_pages') data.coverage.discovery_instagram = { ...coverage, missing: coverage.missing.map(value => ({ ...value, sampleObjectIds: [...value.sampleObjectIds] })), kind: 'instagram', notice: error ? 'No se pudo descubrir Instagram profesional por los permisos/acceso de Facebook; no se omite este canal.' : 'Solo cuentas profesionales vinculadas y accesibles; no se afirma acceso a cuentas no concedidas.' };
}
async function saveItemsTx(tx, row, items, now) {
  let inserted = 0;
  for (const item of items) {
    const id = hash([row.id, item.kind, item.resourceId]);
    const result = await tx.db.run(`INSERT INTO ${tx.t('social_account_analysis_items')}(id,analysis_id,resource_kind,resource_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(analysis_id,resource_kind,resource_id) DO NOTHING`, [id, row.id, item.kind, item.resourceId, JSON.stringify(item.data), now, now]);
    inserted += result.changes ? 1 : 0;
  }
  return inserted;
}
function errorCode(error) { return ['permission', 'reconnect_required', 'rate_limit', 'transport', 'unavailable', 'invalid_response', 'account_mismatch', 'rejected', 'unsafe_url', 'aborted'].includes(error?.kind) ? error.kind : 'authorization_or_configuration_changed'; }
async function releaseTurnTx(tx, lease, state, now, errorCode = null) {
  await assertLease(tx, { ...lease, now });
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state=?,lease_token=NULL,lease_until=NULL,finished_at=?,error_code=?,updated_at=?,version=version+1 WHERE key=? AND lease_token=?`, [state, state === 'queued' ? null : now, errorCode, now, lease.key, lease.token]);
}
async function saveTurn(store, lease, runtime, result, failure, now) {
  return store.transaction(async tx => {
    await tx.lockWrites(); await assertLease(tx, { ...lease, now });
    const row = await tx.db.get(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE id=?`, [lease.analysisId]);
    if (!row || !ACTIVE.has(row.state)) fail('El análisis ya no está activo.', 409);
    const data = parse(row), task = data.work[0];
    // A fence failure is itself a terminal, safe local cancellation. Never save
    // the provider response from an obsolete credential/configuration epoch.
    try { await fenceTx(tx, row, data, runtime, now); }
    catch { await cancelTx(tx, row, now, 'authorization_or_configuration_changed'); return { cancelled: true }; }
    const kind = failure ? errorCode(failure) : null;
    if (kind === 'authorization_or_configuration_changed') {
      await cancelTx(tx, row, now, kind);
      return { cancelled: true };
    }
    data.retryAt = null;
    data.limits = result?.limits || failure?.limits || data.limits || { status: 'unknown', usage: [], retryAfter: null };
    data.permissions = result?.permissions || failure?.permissions || data.permissions || [];
    if (kind === 'rate_limit' || ['transport', 'unavailable', 'aborted'].includes(kind)) {
      data.attempts++;
      const delay = Math.max(kind === 'rate_limit' ? 60 : Math.min(3600, 30 * 2 ** Math.min(data.attempts, 7)), Number(failure.retryAfter) || 0);
      data.retryAt = new Date(Date.parse(now) + delay * 1000).toISOString();
      data.error = { code: kind, notice: 'Lectura interrumpida. Se conserva el cursor; se reintentará sin modificar Meta.', retryAfter: delay };
      data.phase = 'waiting';
      await persistAnalysis(tx, row, data, 'waiting', now);
      await releaseTurnTx(tx, lease, 'queued', now);
      return { state: 'queued' };
    }
    if (kind === 'reconnect_required') {
      const connectionRow = await tx.db.get(`SELECT * FROM ${tx.t('social_connections')} WHERE id=?`, [row.connection_id]);
      const connectionData = parse(connectionRow);
      connectionData.revalidationRequired = true;
      if (connectionData.capabilities) for (const key of Object.keys(connectionData.capabilities)) connectionData.capabilities[key] = false;
      await tx.db.run(`UPDATE ${tx.t('social_connections')} SET state='reconnect_required',data=?,version=version+1,updated_at=? WHERE id=?`, [JSON.stringify(connectionData), now, row.connection_id]);
      data.phase = 'failed'; data.error = { code: kind, notice: 'Meta revocó o venció el acceso. Reconecta antes de actualizar el análisis.' };
      for (const coverage of Object.values(data.coverage)) if (['pending', 'running'].includes(coverage.state)) { coverage.state = coverage.pages ? 'partial' : 'unavailable'; recordMissing(coverage, { reason: kind }); }
      await persistAnalysis(tx, row, data, 'failed', now);
      await releaseTurnTx(tx, lease, 'failed', now, kind);
      return { state: 'failed', errorCode: kind };
    }
    data.work.shift();
    let inserted = 0;
    if (!failure) {
      for (const resource of result.resources) addResource(data, safeResource(resource.kind, resource, resource.pageId));
      inserted = await saveItemsTx(tx, row, result.items, now);
      const coverage = data.coverage[workCoverageKey(task)];
      if (coverage) for (const reason of result.missing || []) recordMissing(coverage, { stage: task.kind, reason });
      data.work.unshift(...result.tasks.map(work => ({ ...work, resourceTasks: task.resourceTasks, coverageKey: task.coverageKey })));
      if (result.next) data.work.push(result.next);
      data.stats.pages += result.pages || 0; data.stats.objects += inserted; data.attempts = 0; data.error = null;
    } else {
      data.error = { code: kind, notice: 'Parte de los datos no está disponible; revisa la cobertura y los permisos. No se ha interpretado como cero.' };
    }
    if (task.kind === 'organic_metrics') {
      const contentKind = task.channel === 'instagram' ? 'instagram_media' : 'facebook_post';
      const content = await tx.db.get(`SELECT id,data FROM ${tx.t('social_account_analysis_items')} WHERE analysis_id=? AND resource_kind=? AND resource_id=?`, [row.id, contentKind, task.resourceId]);
      if (content) {
        const snapshot = parse(content);
        snapshot.metricsAvailability = failure ? kind === 'permission' ? 'denied' : 'unavailable' : result.missing?.length ? 'partial' : 'available';
        snapshot.metricsItemIds = (result?.items || []).map(item => hash([row.id, item.kind, item.resourceId]));
        await tx.db.run(`UPDATE ${tx.t('social_account_analysis_items')} SET data=?,updated_at=? WHERE id=?`, [JSON.stringify(snapshot), now, content.id]);
      }
    }
    data.stats.completedUnits++;
    updateCoverage(data, task, { objects: inserted, pages: result?.pages || 0, next: Boolean(result?.next), error: kind });
    if (!failure && task.kind === 'discover_pages' && !result.next && !Object.values(data.resources).some(resource => resource.kind === 'instagram')) {
      data.coverage.discovery_instagram.state = 'unavailable';
      recordMissing(data.coverage.discovery_instagram, { reason: 'no_accessible_professional_account_or_missing_permissions' });
    }
    const complete = !data.work.length;
    const usageDelay = Math.max(0, Number(data.limits.retryAfter) || 0, ...(data.limits.usage || []).map(value => (value.estimatedTimeToRegainAccess || 0) * 60));
    if (!complete && usageDelay > 0) data.retryAt = new Date(Date.parse(now) + usageDelay * 1000).toISOString();
    data.phase = complete ? 'completed' : data.retryAt ? 'waiting' : data.work[0].kind;
    const state = complete ? Object.values(data.coverage).some(value => ['partial', 'denied', 'unavailable'].includes(value.state)) ? 'partial' : 'completed' : data.retryAt ? 'waiting' : 'queued';
    await persistAnalysis(tx, row, data, state, now);
    await releaseTurnTx(tx, lease, complete ? 'succeeded' : 'queued', now);
    return { state: complete ? 'succeeded' : 'queued' };
  });
}
export async function processMetaAccountAnalysisTurn(store, { now = stamp(), env = process.env, transport = {} } = {}) {
  now = new Date(now).toISOString();
  const candidate = await runnableAnalysis(store, now);
  if (!candidate) return { processed: 0, hasMore: false };
  const lease = await claimJob(store, { key: PREFIX + candidate.id, now });
  if (!lease) return { processed: 0, hasMore: Boolean(await runnableAnalysis(store, now)) };
  let runtime;
  try {
    await withLeaseHeartbeat(store, lease, async ({ clock, assertActive }) => {
      let context;
      try {
        runtime = await loadSocialRuntime(store, { env });
        context = await store.transaction(async tx => {
          await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
          const row = await tx.db.get(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE id=?`, [lease.analysisId]);
          if (!row || !ACTIVE.has(row.state)) fail('El análisis ya no está activo.', 409);
          const data = parse(row), snapshot = await fenceTx(tx, row, data, runtime, clock());
          await persistAnalysis(tx, row, data, 'running', clock());
          return { ...snapshot, data };
        });
      } catch {
        return store.transaction(async tx => {
          await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
          const row = await tx.db.get(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE id=?`, [lease.analysisId]);
          if (row && ACTIVE.has(row.state)) await cancelTx(tx, row, clock(), 'authorization_or_configuration_changed');
          return { cancelled: true };
        });
      }
      let result = null, failure = null;
      try {
        const credentials = decryptCredentials(context.connection, context.credential, runtime);
        if (!credentials?.accessToken) fail('Faltan credenciales.', 409);
        const reader = createMetaAccountHistoryReader({ connection: context.connection, credentials, runtime, transport, now: clock() });
        let debug = null;
        try {
          debug = await reader.validate(); assertActive();
          result = await reader.read(context.data.work[0], context.data.period, debug);
          result.limits = reader.usageSnapshot();
          result.permissions = debug.permissions;
        } catch (error) { error.limits = reader.usageSnapshot(); error.permissions = debug?.permissions || null; throw error; }
      } catch (error) { failure = error; }
      assertActive();
      return saveTurn(store, lease, runtime, result, failure, clock());
    }, { now });
  } catch (error) {
    // Cancellation/supersession revokes the lease while the GET is in flight.
    // That stale response must never be retried or committed by this worker.
    const job = await store.db.get(`SELECT state,lease_token FROM ${store.t('job_runs')} WHERE key=?`, [lease.key]);
    if (job?.state === 'running' && job.lease_token === lease.token) await finishJob(store, lease, { state: 'queued', errorCode: 'read_interrupted', now });
    else if (error.status !== 409) throw error;
  }
  return { processed: 1, hasMore: Boolean(await runnableAnalysis(store, now)) };
}
function positive(value) { const raw = exactDecimal(value); return raw !== null && /[1-9]/.test(raw.replace('.', '')); }
function evidenceOf(item, metric) {
  return { itemId: item.id, resourceId: item.resourceId, accountId: item.accountId || null, ownerId: item.ownerId || null, contentId: item.contentId || null, metric, result: item.values[metric], period: item.period, dimensions: item.dimensions, scope: item.scope, currency: item.currency || null };
}
function compatibleEvidence(item, candidate, metric) {
  return item.id !== candidate.id && positive(item.values?.[metric]?.value)
    && item.values[metric].sourceMetric === candidate.values[metric].sourceMetric
    && item.values[metric].unit === candidate.values[metric].unit
    && item.accountId === candidate.accountId && item.scope === candidate.scope && item.currency === candidate.currency
    && hash(item.period) === hash(candidate.period) && hash(item.dimensions) === hash(candidate.dimensions);
}
/** Retains at most three canonical candidates and one compatible result each.
 * Every row is evaluated, including rows after all three candidates are chosen. */
function proposalReducer(connection, { complete = false } = {}) {
  const objective = objectiveOf(connection), config = socialMeasurementDTO(connection);
  const entries = [], stats = { examined: 0, qualifying: 0 };
  const metricNames = { reach: ['reach'], engagement: ['interactions', 'post_engagement', 'likes', 'reactions'], traffic: ['inline_link_clicks', 'linkClicks', 'link_click'], whatsapp: ['onsite_conversion.messaging_conversation_started_7d'], sales: ['offsite_conversion.fb_pixel_purchase', 'omni_purchase'] }[objective];
  const limits = ['Propuesta local revisable; no cambia presupuesto, segmentación ni contenido remoto.', 'Las reglas históricas no recuperables son no verificables; la configuración actual no prueba la pasada.', 'No se suman reach ni métricas de periodos, monedas, fuentes o dimensiones incompatibles. La atribución no es causalidad.', ...(!complete ? ['Análisis en curso o cobertura parcial; evidencia incompleta.'] : [])];
  const measurement = (notice, evidence = []) => [{ id: `measurement:${objective}`, objective, type: 'measurement', title: 'Completar medición antes de optimizar', change: notice, evidence, comparables: [], limitations: limits }];
  return {
    stats,
    consider(item) {
      stats.examined++;
      if (!item.values || !item.period) return;
      const metric = metricNames.find(name => positive(item.values[name]?.value));
      if (!metric) return;
      stats.qualifying++;
      for (const entry of entries) if (!entry.comparable && compatibleEvidence(item, entry.item, entry.metric)) entry.comparable = item;
      if (entries.length < 3) {
        const comparable = entries.find(entry => compatibleEvidence(entry.item, item, metric))?.item || null;
        entries.push({ item, metric, comparable });
      }
    },
    finish() {
      if (objective === 'sales') {
        if (config.verification?.status !== 'verified' || !['meta_pixel', 'dataset'].includes(config.source) || !config.events?.some(event => event.objective === 'sales' && /^(?:purchase|compra)$/i.test(event.name))) return measurement('Configura y verifica el pixel/dataset y un evento Purchase para ventas. Acceso al origen, clics, contactos o una fuente externa no prueban compras.');
        return measurement('Verifica Purchase y la asociación del origen con la cuenta, campaña y periodo. El histórico agregado no permite comprobar qué pixel/evento originó las compras; no se recomienda optimización de ventas por inferencia.', entries.map(entry => evidenceOf(entry.item, entry.metric)));
      }
      if (!entries.length) return measurement(`Faltan resultados comparables para ${objective}. Confirma permisos, fuente, evento y periodo; captura una línea base antes de cambiar campañas.`);
      return entries.map(({ item, metric, comparable }) => ({
        id: `${objective}:${item.id}`, objective, type: 'reviewable_experiment', title: `Preparar una prueba de ${objective}`,
        change: {
          reach: 'Probar una variante creativa con el mismo periodo y audiencia elegible; comparar alcance único sin sumar campañas ni asumir incremento.',
          engagement: 'Probar una variante de contenido y llamada a interacción; comparar la misma definición de interacción y exposición.',
          traffic: 'Revisar destino y etiquetado; probar una variante de llamada a la acción y medir visitas verificadas, no asumir que clic equivale a visita.',
          whatsapp: 'Probar una llamada a conversación con consentimiento; contrastar conversaciones iniciadas, no ventas ni personas únicas.'
        }[objective],
        evidence: [evidenceOf(item, metric), ...(comparable ? [evidenceOf(comparable, metric)] : [])],
        comparables: comparable ? [comparable.id] : [],
        limitations: [...limits,
          ...(item.period.type === 'lifetime' ? ['Lifetime orgánico no equivale a resultados obtenidos durante los últimos 12 meses.'] : []),
          ...(!comparable ? ['No existe comparable compatible entre todos los resultados examinados; no se afirma ganador ni mejora cuantificada.'] : [])
        ]
      }));
    }
  };
}
/** Pure equivalent of the streaming reducer, for callers with bounded inputs. */
export function buildMetaAccountProposals(connection, items, options = {}) {
  const reducer = proposalReducer(connection, options);
  for (const item of items) reducer.consider(item);
  return reducer.finish();
}
async function scanAnalysisItems(store, analysisId, kinds, consume) {
  let after = '', examined = 0;
  const placeholders = kinds.map(() => '?').join(',');
  for (;;) {
    const rows = await store.db.all(`SELECT * FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=? AND resource_kind IN (${placeholders}) AND id>? ORDER BY id LIMIT 100`, [analysisId, ...kinds, after]);
    for (const row of rows) { consume(entity(row)); examined++; }
    if (rows.length < 100) break;
    after = rows.at(-1).id;
  }
  const count = await store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=? AND resource_kind IN (${placeholders})`, [analysisId, ...kinds]);
  return { examined, total: Number(count.total) };
}
function matchesCurrentConfiguration(item, evidence) {
  if (['campaigns', 'adsets'].includes(item.resourceKind)) {
    if (!evidence.accountId || item.accountId !== evidence.accountId) return false;
    if (evidence.dimensions.level === 'account') return true;
    return evidence.dimensions.level === 'campaign' && (item.resourceKind === 'campaigns' ? item.resourceId === evidence.resourceId : item.configuration?.campaignId === evidence.resourceId);
  }
  return Boolean(evidence.contentId && item.resourceId === evidence.contentId && item.ownerId === evidence.ownerId);
}
async function evaluateAllAnalysisEvidence(store, row, connection, data, stale) {
  const reducer = proposalReducer(connection, { complete: row.state === 'completed' && !stale });
  const metricCoverage = await scanAnalysisItems(store, row.id, ['ads_account', 'ads_campaign', 'organic_metrics'], item => reducer.consider(item));
  const proposals = stale ? buildMetaAccountProposals(connection, [], { complete: false }) : reducer.finish();
  const contexts = proposals.map(proposal => ({ proposal, matched: 0, retained: [], byKind: {}, statuses: new Set(), objectives: new Set(), optimizationGoals: new Set(), minimumTargetAge: null, maximumTargetAge: null }));
  const configurationCoverage = await scanAnalysisItems(store, row.id, ['campaigns', 'adsets', 'facebook_post', 'instagram_media'], item => {
    for (const context of contexts) {
      if (!context.proposal.evidence.some(evidence => matchesCurrentConfiguration(item, evidence))) continue;
      context.matched++;
      const configuration = item.configuration || {};
      if (configuration.status) context.statuses.add(configuration.status);
      if (configuration.objective) context.objectives.add(configuration.objective);
      if (configuration.optimization_goal) context.optimizationGoals.add(configuration.optimization_goal);
      const age = configuration.targeting?.age_min;
      if (Number.isSafeInteger(age)) {
        context.minimumTargetAge = context.minimumTargetAge === null ? age : Math.min(context.minimumTargetAge, age);
        context.maximumTargetAge = context.maximumTargetAge === null ? age : Math.max(context.maximumTargetAge, age);
      }
      const retained = context.byKind[item.resourceKind] || 0;
      if (retained < 3) {
        context.byKind[item.resourceKind] = retained + 1;
        context.retained.push({ itemId: item.id, resourceId: item.resourceId, resourceKind: item.resourceKind, accountId: item.accountId || null, observedAt: item.observedAt, period: item.period, configuration, source: item.source, relationship: context.proposal.evidence.some(evidence => evidence.dimensions.level === 'account') ? 'same_account_current_snapshot' : item.resourceKind === 'adsets' ? 'same_campaign_current_adset' : 'same_campaign_or_content_current_snapshot' });
      }
    }
  });
  for (const context of contexts) {
    const proposal = context.proposal;
    proposal.configurationEvidence = context.retained;
    proposal.configurationCoverage = { examined: configurationCoverage.examined, matched: context.matched, retained: context.retained.length, complete: configurationCoverage.examined === configurationCoverage.total, statuses: [...context.statuses].sort(), campaignObjectives: [...context.objectives].sort(), optimizationGoals: [...context.optimizationGoals].sort(), minimumTargetAge: context.minimumTargetAge, maximumTargetAge: context.maximumTargetAge, notice: 'Se revisaron todas las configuraciones actuales correspondientes; se conservan hasta tres referencias compactas por tipo, sin sumar presupuestos ni deducir reglas históricas.' };
    proposal.applicableRules = data.rules.current.map(rule => ({ ...rule, observedAt: data.rules.observedAt, sourceReviewedAt: data.rules.sourceReviewedAt }));
    proposal.historicalConfiguration = data.rules.historical;
    if (context.matched) {
      proposal.change += ' Revisar en las capturas actuales citadas el estado, objetivo, presupuesto y segmentación aplicables antes de diseñar la prueba; no asumir que esa configuración regía en el periodo histórico.';
      if (context.objectives.size) proposal.change += ` Objetivos actuales observados: ${[...context.objectives].sort().join(', ')}; comprobar su alineación con el objetivo del negocio ${proposal.objective}, sin atribuirles retrospectivamente el desempeño anual.`;
    } else proposal.limitations.push('No se recuperó una configuración actual correspondiente a esta evidencia; no se infieren presupuestos, segmentación ni reglas actuales.');
  }
  const current = await store.db.get(`SELECT version,state FROM ${store.t('social_account_analyses')} WHERE id=?`, [row.id]);
  const stable = current?.version === row.version;
  const complete = metricCoverage.examined === metricCoverage.total && configurationCoverage.examined === configurationCoverage.total && stable;
  if (!complete) for (const proposal of proposals) proposal.limitations.push('El análisis cambió durante la lectura local; vuelve a consultar para obtener cobertura consistente.');
  return {
    proposals,
    evidenceCoverage: { examined: metricCoverage.examined, qualifying: reducer.stats.qualifying, total: metricCoverage.total, complete, eligibleForProposals: !stale, configurations: configurationCoverage, notice: 'Todos los resultados guardados se examinan en páginas acotadas. Se muestran hasta tres propuestas canónicas, no un ranking; comparables buscados en todo el inventario, sin sumar métricas incompatibles.' }
  };
}
function analysisDTO(row, data) {
  const terminal = !ACTIVE.has(row.state);
  return { id: row.id, connectionId: row.connection_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at, period: data.period, progress: { phase: data.phase, completed: data.stats.completedUnits, total: terminal && ['completed', 'partial'].includes(row.state) ? data.stats.completedUnits : null, pendingKnownUnits: data.work.length, resources: data.stats.resources, pages: data.stats.pages, objects: data.stats.objects, notice: terminal ? 'Unidades de lectura terminadas no equivalen a historia completa; consulta cobertura.' : 'El total permanece abierto mientras se descubren páginas y objetos; no se estima un porcentaje ficticio.' }, coverage: Object.values(data.coverage), rules: data.rules, error: data.error, retryAt: data.retryAt, limits: data.limits || { status: 'unknown', usage: [], retryAfter: null } };
}
export async function getMetaAccountAnalysis(store, connectionId, query = {}, actorId) {
  await assertActor(store, actorId);
  const connection = await getSocialConnection(store, connectionId);
  const page = integer(Number(query.page || 1), 'Página', 1, 1000000), pageSize = integer(Number(query.pageSize || 20), 'Tamaño de página', 1, 50);
  const row = await store.db.get(`SELECT * FROM ${store.t('social_account_analyses')} WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [connectionId]);
  if (!row) return { analysis: null, objective: objectiveOf(connection), items: [], pagination: { page, pageSize, total: 0 }, proposals: [], evidenceCoverage: { examined: 0, qualifying: 0, total: 0, complete: true, eligibleForProposals: false, configurations: { examined: 0, total: 0 } }, readOnly: connection.authenticationMethod === 'token' || connection.readOnly === true };
  const count = await store.db.get(`SELECT COUNT(*) AS total FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=?`, [row.id]);
  const rows = await store.db.all(`SELECT * FROM ${store.t('social_account_analysis_items')} WHERE analysis_id=? ORDER BY resource_kind,resource_id LIMIT ? OFFSET ?`, [row.id, pageSize, (page - 1) * pageSize]);
  const [credential, configuration] = await Promise.all([
    store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connectionId]),
    store.db.get(`SELECT version FROM ${store.t('social_integration_settings')} WHERE id=1`)
  ]);
  const data = parse(row), stale = connection.state !== 'connected' || connection.revalidationRequired || Boolean(connection.disconnectPending) || connectionFence(connection) !== data.fence || credential?.version !== data.credentialVersion || (configuration?.version || 0) !== data.configurationVersion;
  const analysis = analysisDTO(row, data); analysis.stale = stale; analysis.permissions = data.permissions || [];
  const { proposals, evidenceCoverage } = await evaluateAllAnalysisEvidence(store, row, connection, data, stale);
  return { analysis, objective: objectiveOf(connection), readOnly: connection.authenticationMethod === 'token' || connection.readOnly === true, items: rows.map(entity), pagination: { page, pageSize, total: Number(count.total) }, proposals, evidenceCoverage };
}
export async function metaAccountAnalysisAction(store, connectionId, input, actorId, { now = stamp() } = {}) {
  if (!['refresh', 'cancel'].includes(input?.action)) fail('Acción de análisis no válida.');
  now = new Date(now).toISOString();
  await store.transaction(async tx => {
    await tx.lockWrites(); await assertActor(tx, actorId);
    const connection = await getSocialConnection(tx, connectionId);
    if (connection.provider !== 'meta' || connection.integrationMethod !== 'api') fail('El análisis histórico requiere la conexión oficial API de Meta.', 409);
    if (input.action === 'refresh') {
      if (connection.state !== 'connected' || connection.revalidationRequired || connection.disconnectPending) fail('Reconecta o valida la cuenta antes de actualizar el análisis.', 409);
      await queueMetaAccountAnalysisTx(tx, connection, actorId, { now, force: true });
    } else {
      const rows = await tx.db.all(`SELECT * FROM ${tx.t('social_account_analyses')} WHERE connection_id=? AND state IN ('queued','running','waiting')`, [connectionId]);
      for (const row of rows) await cancelTx(tx, row, now);
    }
    await audit(tx, { entityType: 'social_connection', entityId: connectionId, actorId, next: { analysisAction: input.action }, reason: 'Análisis local de solo lectura; sin cambios remotos', recordedAt: now });
  });
  return getMetaAccountAnalysis(store, connectionId, {}, actorId);
}
