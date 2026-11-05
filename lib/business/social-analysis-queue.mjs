import { fail, integer, text } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { stamp } from './commands.mjs';
import { queueJobTx } from './job-leases.mjs';

// Call inside the caller's write transaction: links and measurements become
// visible together with their request. A running reader keeps its own fence;
// its finisher compares generation before marking the request complete.
export async function queueSocialAnalysisTx(tx, campaignId, { now = stamp(), requestedBy = 'scheduler', asOf = now, businessRevision = null, staleKey = null } = {}) {
  if (typeof campaignId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)) fail('Campaña de análisis no válida.');
  now = instant(now); asOf = instant(asOf); requestedBy = text(requestedBy, 'Actor del análisis', 200, true);
  if (staleKey !== null && !/^[a-f0-9]{64}$/.test(staleKey)) fail('La huella de recálculo no es válida.');
  const key = `social:analysis:${campaignId}`, old = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  const previous = old ? JSON.parse(old.data) : {}, generation = integer(previous.generation ?? 0, 'Generación del análisis', 0, Number.MAX_SAFE_INTEGER - 1) + 1;
  const data = { kind: 'analysis', id: campaignId, requestedBy, asOf, analysisRequestedAt: now, generation, nextRunAt: now, ...(businessRevision === null ? {} : { businessRevision: integer(businessRevision, 'Revisión comercial', 0) }), ...(staleKey ? { staleKey } : {}) };
  if (old?.state === 'running' && old.lease_until > now) {
    await tx.db.run(`UPDATE ${tx.t('job_runs')} SET data=?,updated_at=?,version=version+1 WHERE key=?`, [JSON.stringify({ ...previous, ...data }), now, key]);
  } else await queueJobTx(tx, key, data, { now });
  return { key, generation };
}
