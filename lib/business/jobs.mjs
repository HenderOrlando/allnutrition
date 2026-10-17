import { integer } from '../validation-core.mjs';
import { addDays, bogotaDate, BUSINESS_PERIODS, instant, periodBounds } from './dates.mjs';
import { assertLease, entity, hash, insertRow, stamp } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, updateJobProgressTx, withLeaseHeartbeat } from './job-leases.mjs';
import { expireImportFiles, processImportTurn } from './imports.mjs';
import { evaluateAlerts } from './alerts.mjs';
import { materializePayrollAccrualsChunkTx, reconcileCommissionsTx } from './payroll.mjs';
import { processReportTurn, queueScheduledReportTx } from './reports.mjs';
import { getBusinessSettings } from './settings.mjs';

const SYSTEM_ACTOR = 'scheduler';
const iso = value => instant(value instanceof Date ? value.toISOString() : value);
const after = (now, milliseconds) => new Date(Date.parse(now) + milliseconds).toISOString();
const revision = async tx => Number((await tx.db.get(`SELECT value FROM ${tx.t('counters')} WHERE id='business_revision'`)).value);
export const isJobAvailabilityError = error => error.status === 503 || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '40001', '40P01', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code);
export const businessJobsDelay = result => result.hasMore ? 100 : 60000;

// Queuing is not a worker commit. Claims and every subsequent mutation are
// fenced independently; a process waiting for another worker never owns its token.
async function claimStage(store, key, { now, initial, due = () => false }) {
  const clock = jobClock(now);
  await store.transaction(async tx => {
    await tx.lockWrites();
    const row = entity(await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [key]));
    if (row?.state === 'running' && row.leaseUntil > clock()) return;
    if (!row) await queueJobTx(tx, key, initial, { now: clock() });
    else if (['succeeded', 'failed'].includes(row.state) && due(row)) await queueJobTx(tx, key, initialForRestart(row, initial), { now: clock() });
  });
  return claimJob(store, { key, now: clock() });
}
function initialForRestart(row, initial) {
  // Do not persist database/lease columns inside commercial progress JSON.
  const { key, state, leaseToken, leaseUntil, startedAt, finishedAt, errorCode, version, createdAt, updatedAt, ...data } = row;
  return { ...data, ...initial };
}
async function leasedWrite(store, lease, clock, fn) {
  return store.transaction(async tx => {
    await tx.lockWrites();
    await assertLease(tx, { ...lease, now: clock() });
    const result = await fn(tx);
    await assertLease(tx, { ...lease, now: clock() });
    return result;
  });
}
async function stageFailure(store, lease, error, clock, code) {
  const retry = isJobAvailabilityError(error);
  try {
    await finishJob(store, lease, { state: retry ? 'queued' : 'failed', errorCode: retry ? 'DB_UNAVAILABLE' : code, now: clock() });
  } catch (finishError) {
    if (finishError.status === 409) return { hasMore: true, errorCode: 'LEASE_LOST' };
    throw finishError;
  }
  if (!error.status && !retry) throw error;
  return { hasMore: retry, errorCode: retry ? 'DB_UNAVAILABLE' : code };
}

export async function touchSchedulerHeartbeat(store, { now = stamp() } = {}) {
  now = iso(now);
  const lease = await claimStage(store, 'scheduler:heartbeat', { now, initial: { requestedBy: SYSTEM_ACTOR }, due: row => !row.nextRunAt || row.nextRunAt <= now });
  if (!lease) return false;
  const clock = jobClock(now);
  await finishJob(store, lease, { now: clock(), data: { nextRunAt: after(now, 30000) } });
  return true;
}

async function saveSalaryCursorTx(tx, personId, data, now) {
  const key = `scheduler:salary:${personId}`;
  const old = await tx.db.get(`SELECT key FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (old) await tx.db.run(`UPDATE ${tx.t('job_runs')} SET data=?,state='succeeded',updated_at=?,version=version+1 WHERE key=?`, [JSON.stringify(data), now, key]);
  else await insertRow(tx, 'job_runs', { key, state: 'succeeded', lease_token: null, lease_until: null, started_at: now, finished_at: now, error_code: null, data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
}

export async function processPayrollTurn(store, { now = stamp(), maxUnits = 5, maxDays = 90 } = {}) {
  now = iso(now); maxUnits = integer(maxUnits, 'Unidades de devengo por turno', 1, 25);
  maxDays = integer(maxDays, 'Días de devengo por unidad', 1, 90);
  const clock = jobClock(now), throughOn = addDays(bogotaDate(now), -1), currentRevision = await revision(store);
  const previous = entity(await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key='scheduler:payroll'`));
  if (previous?.state === 'succeeded' && previous.throughOn === throughOn && previous.completedRevision === currentRevision) return { ready: true, hasMore: false, created: 0, commissions: 0, units: 0, completedRevision: currentRevision };
  const initial = { requestedBy: SYSTEM_ACTOR, throughOn, phase: 'salary', peopleAfter: '', ordersAfter: '', rescan: false, expectedRevision: currentRevision, completedRevision: null };
  const lease = await claimStage(store, 'scheduler:payroll', { now, initial, due: row => row.state === 'succeeded' || row.expectedRevision !== currentRevision || row.throughOn !== throughOn });
  if (!lease) return { ready: false, hasMore: previous?.state !== 'failed', created: 0, commissions: 0, units: 0, errorCode: previous?.state === 'failed' ? previous.errorCode : null };
  let units = 0, created = 0, commissions = 0, complete = false, completedRevision = null;
  try {
    await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
      while (units < maxUnits && !complete) {
        const result = await leasedWrite(store, lease, clock, async tx => {
          const data = JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`, [lease.key])).data);
          const before = await revision(tx);
          if (data.expectedRevision !== before || data.throughOn !== throughOn) data.rescan = true;
          data.throughOn = throughOn;
          let salaryCount = 0, commissionCount = 0;
          if (data.phase === 'salary') {
            const person = entity(await tx.db.get(`SELECT * FROM ${tx.t('people')} WHERE id>? ORDER BY id LIMIT 1`, [data.peopleAfter || '']));
            if (!person) { data.phase = 'commission'; data.ordersAfter = ''; }
            else {
              const agreementHash = hash(person.salaryAgreements || []);
              const cached = entity(await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [`scheduler:salary:${person.id}`]));
              const sameAgreement = cached?.agreementHash === agreementHash;
              if (sameAgreement && cached.throughOn >= throughOn) data.peopleAfter = person.id;
              else {
                const chunk = await materializePayrollAccrualsChunkTx(tx, { personId: person.id, throughOn, startOn: sameAgreement && cached.throughOn ? addDays(cached.throughOn, 1) : null, maxDays, actorId: lease.requestedBy, now: clock() });
                salaryCount = chunk.createdCount;
                await saveSalaryCursorTx(tx, person.id, { agreementHash, throughOn: chunk.throughOn, requestedBy: lease.requestedBy }, clock());
                if (chunk.complete) data.peopleAfter = person.id;
              }
            }
          } else {
            const order = await tx.db.get(`SELECT id FROM ${tx.t('orders')} WHERE id>? ORDER BY id LIMIT 1`, [data.ordersAfter || '']);
            if (order) {
              const reconciled = await reconcileCommissionsTx(tx, order.id, { actorId: lease.requestedBy, asOf: clock() });
              commissionCount = reconciled.createdCount; data.ordersAfter = order.id;
            } else if (data.rescan) { data.phase = 'salary'; data.peopleAfter = ''; data.rescan = false; }
            else { data.phase = 'complete'; data.completedRevision = await revision(tx); }
          }
          data.expectedRevision = await revision(tx);
          await updateJobProgressTx(tx, lease, data, { now: clock() });
          return { created: salaryCount, commissions: commissionCount, complete: data.phase === 'complete', completedRevision: data.completedRevision };
        });
        units++; created += result.created; commissions += result.commissions;
        complete = result.complete; completedRevision = result.completedRevision;
        assertActive();
        await new Promise(resolve => setImmediate(resolve));
      }
      await finishJob(store, lease, { state: complete ? 'succeeded' : 'queued', now: clock() });
    }, { now });
  } catch (error) {
    return { ready: false, created, commissions, units, ...await stageFailure(store, lease, error, clock, 'PAYROLL_INVALID') };
  }
  const ready = complete && completedRevision === await revision(store);
  return { ready, hasMore: !ready, created, commissions, units, completedRevision };
}

// Calendar catch-up is a durable cursor, not an all-history scan each loop.
// A partial first week/quarter/year is deliberately not authorized by activation.
export function automaticReportSchedule(settings, { now = stamp(), cursors = {}, rotation = 0, maxPeriods = 25 } = {}) {
  now = iso(now); maxPeriods = integer(maxPeriods, 'Períodos por turno', 1, 25);
  const today = bogotaDate(now), time = settings.reportGenerationTime || '06:00';
  const todayDue = `${today}T${time}:00.000-05:00`;
  const dueUntil = now >= instant(todayDue) ? today : addDays(today, -1);
  const periods = BUSINESS_PERIODS.filter(period => settings.reportPeriods.includes(period));
  const next = { ...cursors }, queries = [];
  for (const period of periods) {
    if (!next[period]) {
      const first = periodBounds(period, settings.reportsStartOn);
      next[period] = first.startDate < settings.reportsStartOn ? first.endDateExclusive : first.startDate;
    }
  }
  let misses = 0;
  while (queries.length < maxPeriods && misses < periods.length) {
    const period = periods[rotation % periods.length]; rotation = (rotation + 1) % periods.length;
    const bounds = periodBounds(period, next[period]);
    if (bounds.endDateExclusive > dueUntil) { misses++; continue; }
    queries.push({ period, anchorDate: bounds.startDate });
    next[period] = bounds.endDateExclusive; misses = 0;
  }
  const hasMore = periods.some(period => periodBounds(period, next[period]).endDateExclusive <= dueUntil);
  const nextOn = now < instant(todayDue) ? today : addDays(today, 1);
  return { queries, cursors: next, rotation, hasMore, dueUntil, nextRunAt: instant(`${nextOn}T${time}:00.000-05:00`) };
}

async function queueReportTurn(store, { now, payrollReady }) {
  const clock = jobClock(now), settings = await getBusinessSettings(store);
  const signature = hash({ periods: settings.reportPeriods, start: settings.reportsStartOn, time: settings.reportGenerationTime });
  const currentRevision = await revision(store);
  const lease = await claimStage(store, 'scheduler:reports', { now, initial: { requestedBy: SYSTEM_ACTOR }, due: row => row.state === 'succeeded' && (row.scheduleSignature !== signature || row.dataRevision !== currentRevision || !row.nextRunAt || row.nextRunAt <= now) });
  if (!lease) return { queued: 0, hasMore: false };
  try {
    return await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
      const result = await leasedWrite(store, lease, clock, async tx => {
        const old = JSON.parse((await tx.db.get(`SELECT data FROM ${tx.t('job_runs')} WHERE key=?`, [lease.key])).data);
        const schedule = automaticReportSchedule(settings, { now, cursors: old.scheduleSignature === signature ? old.cursors : {}, rotation: old.rotation || 0 });
        let queued = 0;
        for (const query of schedule.queries) if (await queueScheduledReportTx(tx, query, { now: clock() })) queued++;
        const queryJSON = tx.provider === 'sqlite' ? `json_extract(s.data,'$.query')` : `s.data::jsonb->>'query'`;
        const stale = await tx.db.all(`SELECT ${queryJSON} AS query FROM ${tx.t('report_snapshots')} s WHERE s.state='stale' AND s.end_on_exclusive<=? AND NOT EXISTS (SELECT 1 FROM ${tx.t('job_runs')} j WHERE j.key=('report:' || s.query_key) AND j.state IN ('queued','running','failed')) ORDER BY s.start_on,s.query_key LIMIT 25`, [schedule.dueUntil]);
        for (const row of stale) if (await queueScheduledReportTx(tx, typeof row.query === 'string' ? JSON.parse(row.query) : row.query, { now: clock() })) queued++;
        const data = { scheduleSignature: signature, cursors: schedule.cursors, rotation: schedule.rotation, nextRunAt: schedule.nextRunAt, dataRevision: await revision(tx), catchupPending: schedule.hasMore };
        // More stale pages require another turn even when the calendar cursor is current.
        const hasMore = schedule.hasMore || stale.length === 25;
        await updateJobProgressTx(tx, lease, data, { now: clock() });
        return { queued, hasMore };
      });
      assertActive();
      await finishJob(store, lease, { state: result.hasMore ? 'queued' : 'succeeded', now: clock() });
      return { ...result, payrollReady };
    }, { now });
  } catch (error) { return { queued: 0, ...await stageFailure(store, lease, error, clock, 'REPORT_SCHEDULE_INVALID') }; }
}

async function alertTurn(store, { now, clock }) {
  const currentRevision = await revision(store);
  const rulesRevision = Number((await store.db.get(`SELECT COALESCE(SUM(version),0) AS value FROM ${store.t('alert_rules')}`)).value);
  const lease = await claimStage(store, 'scheduler:alerts', { now: clock(), initial: { requestedBy: SYSTEM_ACTOR }, due: row => row.state === 'succeeded' && (row.dataRevision !== currentRevision || row.rulesRevision !== rulesRevision || !row.nextRunAt || row.nextRunAt <= now) });
  if (!lease) return { evaluated: 0, opened: 0, updated: 0, resolved: 0, hasMore: false };
  try {
    return await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
      const result = await evaluateAlerts(store, { now, lease, clock });
      assertActive();
      await finishJob(store, lease, { state: result.stale ? 'queued' : 'succeeded', data: { nextRunAt: after(clock(), 60000), dataRevision: currentRevision, rulesRevision, lastResult: result }, now: clock() });
      return { ...result, hasMore: !!result.stale };
    }, { now: clock() });
  } catch (error) { return { evaluated: 0, ...await stageFailure(store, lease, error, clock, 'ALERT_EVALUATION_INVALID') }; }
}

async function retentionTurn(store, { now }) {
  const lease = await claimStage(store, 'scheduler:retention', { now, initial: { requestedBy: SYSTEM_ACTOR }, due: row => row.state === 'succeeded' && (!row.nextRunAt || row.nextRunAt <= now) });
  if (!lease) return { expired: 0, hasMore: false };
  const clock = jobClock(now);
  try {
    return await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
      const result = await expireImportFiles(store, { now, maxBatches: 25, lease, clock });
      assertActive();
      await finishJob(store, lease, { state: result.hasMore ? 'queued' : 'succeeded', data: { nextRunAt: after(clock(), 3600000) }, now: clock() });
      return result;
    }, { now });
  } catch (error) { return { expired: 0, ...await stageFailure(store, lease, error, clock, 'RETENTION_INVALID') }; }
}

export async function runBusinessJobs(store, { now = stamp() } = {}) {
  now = iso(now); const clock = jobClock(now);
  await touchSchedulerHeartbeat(store, { now });
  const imports = await processImportTurn(store, { maxGroups: 25, now: clock() });
  const payroll = await processPayrollTurn(store, { now: clock() });
  // Observations share the requested cutoff; elapsed work advances only the lease
  // clock, otherwise a faster next turn at the same cutoff looks older.
  const alerts = await alertTurn(store, { now, clock });
  const scheduling = await queueReportTurn(store, { now: clock(), payrollReady: payroll.ready });
  // Even an explicit historical request waits for completed-day accrual catch-up.
  // A concurrent domain edit forces a stale snapshot, never a false current close.
  const reports = payroll.ready ? await processReportTurn(store, { maxReports: 10, now: clock(), requiredPayrollRevision: payroll.completedRevision }) : { processed: 0, hasMore: false, waitingForPayroll: true };
  const retention = await retentionTurn(store, { now: clock() });
  const hasMore = imports.hasMore || payroll.hasMore || alerts.hasMore || scheduling.hasMore || reports.hasMore || retention.hasMore;
  return { imports, payroll, alerts, scheduling, reports, retention, hasMore, backlog: !!hasMore };
}
