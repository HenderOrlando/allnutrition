import { fail, integer } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { stamp } from './commands.mjs';
import { claimJob, finishJob, jobClock, withLeaseHeartbeat } from './job-leases.mjs';
import { analyzeSocialCampaign, prepareSocialAnalysisRequest } from './social-analysis.mjs';

const JOB = /^social:analysis:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const unavailable = error => error.status === 503 || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '40001', '40P01', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code);
const after = (now, delay) => new Date(Date.parse(now) + delay).toISOString();
function due(store) {
  const next = store.provider === 'sqlite' ? "json_extract(j.data,'$.nextRunAt')" : "j.data::jsonb->>'nextRunAt'";
  return `(${next} IS NULL OR ${next}<=?)`;
}
async function candidates(store, now) {
  return store.db.all(`SELECT j.key FROM ${store.t('job_runs')} j WHERE j.key LIKE 'social:analysis:%' AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?)) AND ${due(store)} ORDER BY j.created_at,j.key`, [now, now]);
}
export async function processSocialAnalysisTurn(store, { now = stamp(), maxCampaigns = 1 } = {}) {
  now = instant(now); integer(maxCampaigns, 'Campañas por turno de análisis', 1, 10);
  const clock = jobClock(now), results = [];
  for (const candidate of await candidates(store, clock())) {
    if (results.length >= maxCampaigns) break;
    const match = JOB.exec(candidate.key); if (!match) continue;
    const lease = await claimJob(store, { key: candidate.key, now: clock() }); if (!lease) continue;
    const campaignId = match[1], generation = lease.generation;
    try {
      if (lease.kind !== 'analysis' || lease.id !== campaignId || !Number.isSafeInteger(generation) || generation < 1) fail('Intención de análisis no válida.');
      const result = await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
        const asOf = instant(lease.asOf, 'Corte durable del análisis');
        const identity = await prepareSocialAnalysisRequest(store, campaignId, { asOf });
        assertActive();
        const analysis = await analyzeSocialCampaign(store, campaignId, { asOf, requestId: identity.requestId, expectedEvidenceHash: identity.evidenceHash, lease: { ...lease, now: clock() } }, 'scheduler');
        assertActive();
        // Generation is checked while clearing the fence: a link or capture that
        // arrived during this reader remains queued, even if evidence is equal.
        const finished = await finishJob(store, lease, { now: clock(), expectedGeneration: generation, data: { lastProcessedGeneration: generation, lastEvidenceHash: analysis.evidenceHash, nextRunAt: null,
          lastResult: { campaignId, evidenceHash: analysis.evidenceHash, asOf: analysis.asOf, checkedAt: analysis.checkedAt, recommendationIds: analysis.recommendationIds } } });
        return { campaignId, state: finished.state, evidenceHash: analysis.evidenceHash, recommendationIds: analysis.recommendationIds, errorCode: null };
      }, { now: clock() });
      results.push(result);
    } catch (error) {
      const retry = unavailable(error) || error.analysisCode === 'EVIDENCE_CHANGED';
      const errorCode = retry ? unavailable(error) ? 'DB_UNAVAILABLE' : 'EVIDENCE_CHANGED' : error.analysisCode || (error.status === 404 ? 'CAMPAIGN_MISSING' : error.status === 409 ? 'LEASE_LOST' : 'ANALYSIS_INVALID');
      try {
        const finished = await finishJob(store, lease, { state: retry ? 'queued' : 'failed', errorCode, now: clock(), expectedGeneration: generation,
          data: { nextRunAt: retry ? after(clock(), unavailable(error) ? 60000 : 1000) : null } });
        results.push({ campaignId, state: finished.state, errorCode });
      } catch (fence) { if (fence.status !== 409) throw fence; results.push({ campaignId, state: 'lease_lost', errorCode: 'LEASE_LOST' }); }
    }
  }
  return { processed: results.length, hasMore: (await candidates(store, clock())).some(value => JOB.test(value.key)), results };
}
