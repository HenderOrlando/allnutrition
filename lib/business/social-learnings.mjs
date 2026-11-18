import { entity, hash, stamp } from './commands.mjs';
import { fail, integer } from '../validation-core.mjs';
import { SOCIAL_ANALYSIS_VERSION } from './social-analysis.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const field = (tx, alias, name) => tx.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${name}')` : `${alias}.data::jsonb#>>'{${name.split('.').join(',')}}'`;

export async function socialImprovementCards(tx, campaigns) {
  if (!campaigns.length) return new Map();
  const ids = campaigns.map(campaign => campaign.id), slots = ids.map(() => '?').join(','), lookup = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  const [rows, latest, counter] = await Promise.all([
    tx.db.all(`SELECT r.campaign_id,r.id,r.state,r.evidence_hash,r.data,c.state AS trial_child_state,j.state AS analysis_job_state,${field(tx, 'j', 'analysisRequestedAt')} AS analysis_requested_at FROM ${tx.t('social_recommendations')} r LEFT JOIN ${tx.t('social_campaigns')} c ON c.id=${field(tx, 'r', 'childCampaignId')} LEFT JOIN ${tx.t('job_runs')} j ON j.key=('social:analysis:' || r.campaign_id) WHERE r.campaign_id IN (${slots}) AND r.state IN ('suggested','applied','evaluated')`, ids),
    tx.db.all(`SELECT d.campaign_id,COUNT(m.id) AS measurement_count,MAX(m.fetched_at) AS fetched_at,MAX(${field(tx, 'd', 'pausedAt')}) AS paused_at,MAX(${field(tx, 'd', 'activatedAt')}) AS active_at,MAX(${field(tx, 'd', 'finalizedAt')}) AS finalized_at,MAX(${field(tx, 'd', 'lastContentChangedAt')}) AS changed_at FROM ${tx.t('social_deliveries')} d LEFT JOIN ${tx.t('social_measurements')} m ON m.delivery_id=d.id WHERE d.campaign_id IN (${slots}) GROUP BY d.campaign_id`, ids),
    tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)
  ]);
  const freshness = new Map(latest.map(row => [row.campaign_id, row]));
  const priority = { observing: 3, suggested: 2, concluded: 1 };
  const result = new Map();
  for (const row of rows) {
    const campaign = lookup.get(row.campaign_id), analysis = campaign.analysis, last = freshness.get(campaign.id), data = JSON.parse(row.data), checkedAt = analysis?.checkedAt || analysis?.asOf;
    const pending = ['queued','running'].includes(row.analysis_job_state) || row.analysis_job_state === 'failed' && row.analysis_requested_at > checkedAt;
    const changed = last && [last.fetched_at, last.paused_at, last.active_at, last.finalized_at, last.changed_at].some(value => value && value > checkedAt);
    const current = analysis?.analysisVersion === SOCIAL_ANALYSIS_VERSION && analysis.evidenceHash === row.evidence_hash && analysis.recommendationIds?.includes(row.id) &&
      analysis.businessRevision === Number(counter.value) && !pending && !changed && (analysis.measurementCount == null || Number(last?.measurement_count || 0) === analysis.measurementCount);
    const state = row.state === 'suggested' && !Object.keys(data.changeDrafts || {}).length && current ? 'suggested' : data.conclusion ? 'concluded' : row.state === 'applied' && (data.trial || row.trial_child_state && !['draft', 'cancelled', 'failed'].includes(row.trial_child_state)) ? 'observing' : null;
    if (state && (!result.has(campaign.id) || priority[state] > priority[result.get(campaign.id)])) result.set(campaign.id, state);
  }
  return result;
}

function readCursor(value, context) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 400 || !/^[\w-]+$/.test(value)) fail('Cursor de aprendizajes no válido.');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('Cursor de aprendizajes no válido.'); }
  if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== context || !/^\d{4}-\d{2}-\d{2}T/.test(cursor[1]) || !UUID.test(cursor[2])) fail('Cursor de aprendizajes no válido.');
  return cursor.slice(1);
}
function idea(row) {
  const improved = row.conclusion === 'improved', type = row.proposedChange?.type;
  const example = type === 'copy' ? 'el texto' : type === 'creative' ? 'la composición' : null;
  if (example) return { field: type === 'copy' ? 'caption' : 'recommendationInstructions', text: improved
    ? `Revisa ${example} de la versión que alcanzó el criterio de esta prueba. Puedes partir de su enfoque, sin cambiar los hechos vigentes de la oferta.`
    : `Revisa ${example} probado: no alcanzó el criterio. Úsalo como referencia de lo que se probó, no como una fórmula que funciona.` };
  return null;
}

export async function getSocialLearnings(store, query = {}) {
  const allowed = ['campaignId', 'offerHash', 'mode', 'objective', 'channel', 'cursor', 'limit'];
  if (Object.keys(query).some(key => !allowed.includes(key))) fail('Filtro de aprendizajes no válido.');
  const { campaignId, offerHash, mode, objective, channel } = query, limit = integer(Number(query.limit || 10), 'Cantidad de aprendizajes', 1, 30);
  if (campaignId ? !UUID.test(campaignId) || ['offerHash', 'mode', 'objective', 'channel'].some(key => Object.hasOwn(query, key)) : !HASH.test(offerHash || '') || !['organic', 'paid'].includes(mode) || !['reach', 'engagement', 'traffic', 'whatsapp'].includes(objective) || !['facebook', 'instagram', 'meta_ads'].includes(channel)) fail('Identifica la ficha o la oferta, modalidad, objetivo y red del borrador.');
  const context = hash({ campaignId, offerHash, mode, objective, channel }), cursor = readCursor(query.cursor, context);
  return store.readSnapshot(async tx => {
    if (campaignId && !await tx.db.get(`SELECT id FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaignId])) fail('Campaña no encontrada.', 404);
    const child = field(tx, 'r', 'childCampaignId');
    const where = campaignId ? `(r.campaign_id=? OR ${child}=? OR ${field(tx, 'r', 'trial.draftId')}=?)`
      : `(${field(tx, 'r', 'conclusion')} IN ('improved','not_improved')) AND ${field(tx, 'r', 'proposedChange.type')} IN ('copy','creative') AND ${field(tx, 'v', 'spec.offerHash')}=? AND c.mode=? AND c.objective=? AND (COALESCE(${field(tx, 'r', 'trial.channel')},${field(tx, 'r', 'primaryEvidence.channel')},CASE WHEN c.mode='paid' THEN 'meta_ads' END)=?)`;
    const args = campaignId ? [campaignId, campaignId, campaignId] : [offerHash, mode, objective, channel];
    const sql = `SELECT r.*,c.mode AS trial_mode,c.objective AS trial_objective,c.name AS campaign_name,v.data AS approval_data,cv.data AS child_approval_data,cv.approved_at AS child_approved_at,cc.state AS child_state,cc.name AS child_name FROM ${tx.t('social_recommendations')} r JOIN ${tx.t('social_campaigns')} c ON c.id=r.campaign_id JOIN ${tx.t('social_revisions')} v ON v.campaign_id=c.id AND v.revision=1 LEFT JOIN ${tx.t('social_campaigns')} cc ON cc.id=${child} LEFT JOIN ${tx.t('social_revisions')} cv ON cv.campaign_id=cc.id AND cv.revision=1 WHERE ${where}${cursor ? ' AND (r.created_at<? OR (r.created_at=? AND r.id<?))' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`;
    if (cursor) args.push(cursor[0], cursor[0], cursor[1]);
    const rows = await tx.db.all(sql, [...args, limit + 1]), learnings = [];
    for (const row of rows.slice(0, limit)) {
      const item = entity(row), approval = JSON.parse(row.approval_data), spec = approval.spec, childSpec = row.child_approval_data && JSON.parse(row.child_approval_data).spec;
      const evaluation = item.evaluation || null, trial = item.trial || null, change = item.proposedChange;
      const fieldToCompare = { copy: 'caption', creative: 'assetId', placement: 'placements', posting_window: 'publishAt' }[change?.type];
      const period = { from: evaluation?.beforePeriod?.start || trial?.transition?.from || item.createdAt, to: evaluation?.afterPeriod?.end || evaluation?.asOf || null };
      if (!campaignId) {
        const orientation = idea(item);
        const exampleCampaignId = row.child_approved_at && childSpec?.offerHash === offerHash && item.childCampaignId ? item.childCampaignId : item.campaignId;
        if (orientation) learnings.push({ id: item.id, campaignId: exampleCampaignId, conclusion: item.conclusion, period, idea: orientation });
        continue;
      }
      learnings.push({ id: item.id, campaignId: item.campaignId, campaignName: row.campaign_name, childCampaignId: item.childCampaignId || null, childName: row.child_name || null,
        childState: row.child_state || null, childApprovedAt: row.child_approved_at || null, applicationMode: trial?.applicationMode || (item.childCampaignId ? 'new' : null),
        changeDrafts: item.changeDrafts || {}, deliveryId: trial?.deliveryId || null, operationId: trial?.operationId || null,
        state: item.state, conclusion: item.conclusion || null, reason: item.dismissalReason || null, createdAt: item.createdAt, appliedAt: item.appliedAt || null,
        observation: item.observation, proposedChange: change, criterion: trial?.criterion || item.successCriterion, evaluation, period, transition: trial?.transition || null,
        before: trial?.before ?? (fieldToCompare ? spec[fieldToCompare] : null) ?? null, after: trial?.after ?? (fieldToCompare ? childSpec?.[fieldToCompare] : null) ?? null,
        mode: row.trial_mode, objective: row.trial_objective, channel: trial?.channel || item.primaryEvidence?.channel || (spec.mode === 'paid' ? 'meta_ads' : null),
        offerSnapshot: approval.offerSnapshot || null, expectedAt: trial?.expectedAt || (childSpec?.mode === 'paid' ? childSpec.endAt : null) });
    }
    const last = rows[limit - 1];
    return { learnings, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([context, last.created_at, last.id])).toString('base64url') : null, asOf: stamp() };
  });
}
