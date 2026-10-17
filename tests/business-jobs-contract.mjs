import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { entity, runCommand } from '../lib/business/commands.mjs';
import { bogotaDate, BUSINESS_PERIODS } from '../lib/business/dates.mjs';
import { claimJob, finishJob, queueJobTx, schedulerHealth } from '../lib/business/job-leases.mjs';
import { getBusinessSettings, saveBusinessSettings, saveResource } from '../lib/business/settings.mjs';
import { materializePayrollAccrualsChunkTx } from '../lib/business/payroll.mjs';
import { recordIncome, saveAccount } from '../lib/business/cash.mjs';
import { saveReportSnapshot } from '../lib/business/reports.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import { createImportBatch, downloadImportOriginal, expireImportFiles, getImportBatch, processImportTurn, uploadImportFile } from '../lib/business/imports.mjs';
import { businessJobsDelay, processPayrollTurn, runBusinessJobs, touchSchedulerHeartbeat } from '../lib/business/jobs.mjs';

const actor = 'scheduler-contract-original-admin';
const requestId = () => randomUUID();
const now = '2026-10-16T12:00:00.000Z';
const select = async (store, table, clause = '', values = []) => (await store.db.all(`SELECT * FROM ${store.t(table)} ${clause}`, values)).map(entity);
const agreement = (effectiveFrom, effectiveTo, id = 'historical-salary') => ({ id, enabled: true, frequency: 'monthly', amountPerPeriodMinor: 3100, effectiveFrom, effectiveTo, payDayOffset: 0 });
async function person(store, agreements) {
  return saveResource(store, 'people', { name: 'Responsable de prueba de trabajos', salaryAgreements: agreements, requestId: requestId() }, actor);
}
async function settings(store, input) {
  const old = await getBusinessSettings(store);
  return saveBusinessSettings(store, { ...old, ...input, requestId: requestId() }, actor);
}
async function drain(store, at = now, limit = 100) {
  for (let turns = 0; turns < limit; turns++) {
    const result = await runBusinessJobs(store, { now: at });
    assert.ok(result.imports.processed <= 25);
    assert.ok(result.reports.processed <= 10);
    if (!result.hasMore) return result;
  }
  assert.fail('El trabajo durable no terminó dentro del número de turnos del escenario.');
}

export const businessJobsContracts = [
  ['bounded salary cursors cross old years, survive concurrent turns, and do not regenerate completed facts', async store => {
    const employee = await person(store, [agreement('2001-12-25', '2002-01-08')]);
    const first = await processPayrollTurn(store, { now, maxUnits: 1, maxDays: 3 });
    assert.equal(first.created, 3);
    assert.equal(first.ready, false);
    let salary = await select(store, 'expenses', "WHERE category='salary' ORDER BY incurred_on");
    assert.deepEqual(salary.map(row => row.incurredOn), ['2001-12-25', '2001-12-26', '2001-12-27']);
    await Promise.all([processPayrollTurn(store, { now, maxUnits: 1, maxDays: 3 }), processPayrollTurn(store, { now, maxUnits: 1, maxDays: 3 })]);
    let finished;
    for (let i = 0; i < 20; i++) {
      finished = await processPayrollTurn(store, { now, maxUnits: 1, maxDays: 3 });
      if (finished.ready) break;
    }
    assert.equal(finished.ready, true);
    salary = await select(store, 'expenses', "WHERE category='salary' ORDER BY incurred_on");
    assert.equal(salary.length, 15);
    assert.equal(new Set(salary.map(row => row.sourceKey)).size, 15);
    assert.equal(salary.reduce((total, row) => total + row.amountMinor, 0), 1500);
    const before = (await select(store, 'counters', "WHERE id='business_revision'"))[0].value;
    assert.equal((await processPayrollTurn(store, { now })).units, 0);
    assert.equal((await select(store, 'counters', "WHERE id='business_revision'"))[0].value, before);
    const changed = await saveResource(store, 'people', { ...employee, salaryAgreements: [agreement('2001-12-24', '2002-01-08', 'corrected-agreement')], requestId: requestId() }, actor, employee.id);
    assert.equal(changed.id, employee.id);
    for (let i = 0; i < 20; i++) if ((await processPayrollTurn(store, { now, maxUnits: 1, maxDays: 3 })).ready) break;
    salary = await select(store, 'expenses', "WHERE category='salary' ORDER BY incurred_on");
    assert.equal(salary.length, 16);
    assert.equal(salary[0].incurredOn, '2001-12-24');
    assert.equal(salary.reduce((total, row) => total + row.amountMinor, 0), 1600);
  }],
  ['an expired scheduler token cannot commit salary after a restart claims its real queued job', async store => {
    const employee = await person(store, [agreement('2026-09-01', '2026-09-30')]);
    await processPayrollTurn(store, { now, maxUnits: 1, maxDays: 1 });
    const old = await claimJob(store, { key: 'scheduler:payroll', now });
    const later = '2026-10-16T12:02:01.000Z';
    const replacement = await claimJob(store, { key: 'scheduler:payroll', now: later });
    assert.notEqual(replacement.token, old.token);
    await assert.rejects(() => runCommand(store, { scope: 'salary:expired-worker', requestId: requestId(), payload: { personId: employee.id }, actorId: actor, lease: { ...old, now: later } }, tx => materializePayrollAccrualsChunkTx(tx, { personId: employee.id, throughOn: '2026-09-30', maxDays: 1, startOn: '2026-09-02', actorId: actor, now: later })), { status: 409 });
    assert.equal((await select(store, 'expenses', "WHERE category='salary'")).length, 1);
    // A dead replacement is reclaimed without losing the first committed day.
    const resumed = await processPayrollTurn(store, { now: '2026-10-16T12:04:02.000Z' });
    assert.equal(resumed.ready, true);
    assert.equal((await select(store, 'expenses', "WHERE category='salary'")).length, 30);
  }],
  ['explicit historical closes wait for all salary catch-up and preserve their requesting administrator', async store => {
    await settings(store, { reportsStartOn: '2026-10-16' });
    await person(store, [agreement('2020-01-01', '2021-12-31')]);
    const requested = await saveReportSnapshot(store, { period: 'month', anchorDate: '2020-01-10', requestId: requestId() }, actor);
    const first = await runBusinessJobs(store, { now });
    assert.equal(first.payroll.ready, false);
    assert.equal(first.reports.processed, 0);
    assert.equal((await select(store, 'report_snapshots')).length, 0);
    await Promise.all([runBusinessJobs(store, { now }), runBusinessJobs(store, { now })]);
    await drain(store);
    const snapshots = await select(store, 'report_snapshots');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].state, 'current');
    assert.equal(snapshots[0].metrics.fixedSalary.value, 3100);
    assert.equal(snapshots[0].metrics.fixedSalary.complete, true);
    assert.equal((await select(store, 'expenses', "WHERE category='salary'")).length, 731);
    const job = (await select(store, 'job_runs', 'WHERE key=?', [requested.jobKey]))[0];
    assert.equal(job.requestedBy, actor);
    assert.equal(job.state, 'succeeded');
    await drain(store);
    assert.equal((await select(store, 'report_snapshots')).length, 1);
    assert.equal((await select(store, 'expenses', "WHERE category='salary'")).length, 731);
  }],
  ['automatic reports catch up after Bogota deadlines without authorizing partial activation calendars or duplicating revisions', async store => {
    const at = '2026-10-01T11:00:00.000Z';
    await settings(store, { reportsStartOn: '2026-09-01', reportGenerationTime: '06:00', reportPeriods: BUSINESS_PERIODS });
    const before = await runBusinessJobs(store, { now: '2026-10-01T10:59:59.000Z' });
    assert.ok(before.reports.processed <= 10);
    await drain(store, at);
    let snapshots = await select(store, 'report_snapshots');
    const eligibleBoundaries = [
      ...Array.from({ length: 30 }, (_, index) => ({
        period: 'day', startOn: `2026-09-${String(index + 1).padStart(2, '0')}`,
        endOnExclusive: index === 29 ? '2026-10-01' : `2026-09-${String(index + 2).padStart(2, '0')}`,
      })),
      { period: 'week', startOn: '2026-09-07', endOnExclusive: '2026-09-14' },
      { period: 'week', startOn: '2026-09-14', endOnExclusive: '2026-09-21' },
      { period: 'week', startOn: '2026-09-21', endOnExclusive: '2026-09-28' },
      { period: 'month', startOn: '2026-09-01', endOnExclusive: '2026-10-01' },
    ];
    const boundaryKey = row => `${row.period}:${row.startOn}:${row.endOnExclusive}`;
    const expectedKeys = eligibleBoundaries.map(boundaryKey).sort();
    assert.deepEqual(snapshots.map(boundaryKey).sort(), expectedKeys);
    // August 31 starts before activation; September 28 does not close by October 1.
    assert.ok(!snapshots.some(row => row.period === 'week' && ['2026-08-31', '2026-09-28'].includes(row.startOn)));
    assert.ok(snapshots.every(row => row.startOn >= '2026-09-01' && row.state === 'current'));
    const originals = new Map(snapshots.map(row => [row.id, row.factHash]));
    await person(store, []); // New unrelated metadata changes the global revision, not the financial facts.
    await drain(store, at);
    snapshots = await select(store, 'report_snapshots');
    assert.deepEqual(snapshots.map(boundaryKey).sort(), expectedKeys);
    assert.ok(snapshots.every(row => row.revision === 1 && originals.get(row.id) === row.factHash && row.state === 'current'));
  }],
  ['the worker heartbeat is durable, bounded by its own deadline, and becomes stale without a web request', async store => {
    assert.equal(await touchSchedulerHeartbeat(store, { now }), true);
    assert.equal(await touchSchedulerHeartbeat(store, { now: '2026-10-16T12:00:29.000Z' }), false);
    const first = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`);
    assert.equal(schedulerHealth(first, '2026-10-16T12:02:59.000Z').status, 'running');
    assert.equal(schedulerHealth(first, '2026-10-16T12:03:01.000Z').status, 'stale');
    await touchSchedulerHeartbeat(store, { now: '2026-10-16T12:03:02.000Z' });
    const renewed = await store.db.get(`SELECT * FROM ${store.t('job_runs')} WHERE key='scheduler:heartbeat'`);
    assert.equal(schedulerHealth(renewed, '2026-10-16T12:03:03.000Z').status, 'running');
    assert.equal(renewed.lease_token, null);
    assert.equal(businessJobsDelay({ hasMore: true }), 100);
    assert.equal(businessJobsDelay({ hasMore: false }), 60000);
  }],
  ['domain changes wake alert evaluation before its idle deadline and resolve the same cash episode', async store => {
    await settings(store, { reportsStartOn: '2026-10-16' });
    const responsible = await person(store, []);
    const account = await saveAccount(store, { requestId: requestId(), name: 'Banco con umbral de prueba', type: 'bank', openingOn: '2026-09-01', openingBalanceMinor: 1000, minimumMinor: 1500, responsibleId: responsible.id }, actor);
    await drain(store);
    const first = (await select(store, 'alerts', "WHERE rule_id='cash_below_minimum' AND entity_id=?", [account.id]))[0];
    assert.equal(first.state, 'open');
    assert.equal(first.firstSeenAt, now);
    assert.equal(first.lastSeenAt, now);
    const notDue = await runBusinessJobs(store, { now });
    assert.equal(notDue.alerts.evaluated, 0);
    await recordIncome(store, { requestId: requestId(), accountId: account.id, effectiveOn: '2026-10-16', amountMinor: 500, concept: 'other_non_sale', description: 'Ingreso real sintético para completar el mínimo' }, actor);
    const cash = await select(store, 'cash_entries', 'WHERE account_id=? AND effective_on<=?', [account.id, bogotaDate(now)]);
    assert.equal(cash.reduce((total, entry) => total + entry.amountMinor, 0), account.minimumMinor);
    const awakened = await runBusinessJobs(store, { now });
    assert.ok(awakened.alerts.evaluated > 0);
    const after = await select(store, 'alerts', "WHERE rule_id='cash_below_minimum' AND entity_id=?", [account.id]);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, first.id);
    assert.equal(after[0].state, 'resolved');
    assert.equal(after[0].lastSeenAt, now);
  }],
  ['retention honors persisted expiry boundaries and resumes bounded pages without an expired token deleting bytes', async store => {
    const platform = await saveResource(store, 'platforms', { name: 'Origen sintético de retención', requestId: requestId() }, actor);
    const source = (await select(store, 'platform_sources', 'WHERE platform_id=?', [platform.id]))[0];
    const bytes = writeExcelSheets([{ name: 'Seguimiento', rows: [['Guía'], ['000000123']] }]);
    const batches = [];
    for (let index = 0; index < 3; index++) {
      let batch = await createImportBatch(store, { sourceId: source.id, requestId: requestId() }, actor);
      await uploadImportFile(store, batch.id, { filename: `retencion-${index}.xlsx`, bytes, version: batch.version, requestId: requestId() }, actor);
      await processImportTurn(store, { batchId: batch.id });
      batch = await getImportBatch(store, batch.id);
      batches.push(batch);
    }
    const firstExpiry = Math.min(...batches.map(batch => Date.parse(batch.expiresAt)));
    const lastExpiry = Math.max(...batches.map(batch => Date.parse(batch.expiresAt)));
    const at = new Date(lastExpiry).toISOString();
    assert.equal((await expireImportFiles(store, { now: new Date(firstExpiry - 1).toISOString(), maxBatches: 1 })).expired, 0);
    await settings(store, { reportsStartOn: bogotaDate(at) });
    await store.transaction(async tx => { await tx.lockWrites(); await queueJobTx(tx, 'scheduler:retention', { requestedBy: 'scheduler' }, { now: at }); });
    const old = await claimJob(store, { key: 'scheduler:retention', now: at });
    const first = await expireImportFiles(store, { now: at, maxBatches: 1, lease: old });
    assert.equal(first.expired, 1); assert.equal(first.hasMore, true);
    const later = new Date(lastExpiry + 121000).toISOString();
    const resumed = await claimJob(store, { key: 'scheduler:retention', now: later });
    await assert.rejects(() => expireImportFiles(store, { now: later, maxBatches: 1, lease: old }), { status: 409 });
    assert.equal(Number((await store.db.get(`SELECT COUNT(*) AS count FROM ${store.t('import_batches')} WHERE file_bytes_base64 IS NOT NULL`)).count), 2);
    assert.equal((await expireImportFiles(store, { now: later, maxBatches: 1, lease: resumed })).expired, 1);
    await finishJob(store, resumed, { state: 'queued', now: later });
    const last = await runBusinessJobs(store, { now: later });
    assert.equal(last.retention.expired, 1);
    assert.equal(last.retention.hasMore, false);
    for (const original of batches) {
      const expired = await getImportBatch(store, original.id);
      assert.equal(expired.fileExpired, true);
      assert.equal(expired.fileHash, original.fileHash);
      await assert.rejects(() => downloadImportOriginal(store, original.id), { status: 404 });
    }
    assert.equal((await select(store, 'business_audit', "WHERE entity_type='import_file'")).length, 3);
    assert.equal((await runBusinessJobs(store, { now: later })).retention.expired, 0);
    assert.equal((await select(store, 'business_audit', "WHERE entity_type='import_file'")).length, 3);
    assert.equal((await select(store, 'orders')).length, 0);
  }],
];


