import './env.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../lib/db/index.mjs';
import { businessJobsDelay, isJobAvailabilityError, runBusinessJobs, touchSchedulerHeartbeat } from '../lib/business/jobs.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--once') || args.length > 1) {
  console.error('Uso: node scripts/business-jobs.mjs [--once]');
  process.exitCode = 1;
} else {
  const once = args.includes('--once'), idle = new AbortController();
  let store, stopping = false, heartbeatTimer, heartbeatPending = null;
  const stop = () => { stopping = true; idle.abort(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const heartbeat = () => {
    if (stopping || heartbeatPending) return;
    heartbeatPending = touchSchedulerHeartbeat(store).catch(error => {
      // Never print connection strings, imported values, or a raw database error.
      console.error(isJobAvailabilityError(error) ? 'Heartbeat: DB_UNAVAILABLE' : 'Heartbeat: SCHEDULER_ERROR');
    }).finally(() => { heartbeatPending = null; });
  };
  try {
    store = await openStore();
    heartbeat();
    heartbeatTimer = setInterval(heartbeat, 30000);
    do {
      let sleep = 60000;
      try {
        const result = await runBusinessJobs(store);
        sleep = businessJobsDelay(result);
        if (once) {
          console.log(JSON.stringify({ imports: result.imports.processed, payroll: result.payroll.created, commissions: result.payroll.commissions, alerts: result.alerts, reports: result.reports.processed, expiredFiles: result.retention.expired, hasMore: result.hasMore }));
          if ([result.payroll, result.alerts, result.scheduling, result.retention].some(stage => stage.errorCode && stage.errorCode !== 'LEASE_LOST')) process.exitCode = 1;
        }
      } catch (error) {
        if (!isJobAvailabilityError(error) || once) throw error;
        console.error('Trabajos de negocio: DB_UNAVAILABLE; se conserva el progreso.');
      }
      if (once || stopping) break;
      try { await delay(sleep, undefined, { signal: idle.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!stopping);
  } catch (error) {
    console.error(isJobAvailabilityError(error) ? 'Trabajos de negocio: DB_UNAVAILABLE.' : 'Trabajos de negocio: SCHEDULER_ERROR; revisa el estado durable del trabajo.');
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeatTimer);
    stopping = true;
    if (heartbeatPending) await heartbeatPending;
    await store?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
