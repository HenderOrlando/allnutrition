import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { createAdmin } from '../lib/auth.mjs';
import { bogotaDate, addDays } from '../lib/business/dates.mjs';
import { getOnboarding, runOnboardingAction } from '../lib/business/onboarding.mjs';
import { buildBusinessReport, generateReportSnapshot, getReportSnapshot } from '../lib/business/reports.mjs';
import { exportBusinessReport } from '../lib/business/report-export.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { createBusinessFixture, businessOrderInput } from './business-fixtures.mjs';
import { COMMERCIAL_TABLES, CORE_BACKUP_TABLES } from '../lib/backup-schema.mjs';

const XLSX = createRequire(import.meta.url)('xlsx');
const requestId = () => randomUUID();
function reportEvidence(report) {
  const { factHash, dataRevision, metrics, groups, coverage, facts, filterOptions } = report;
  return { factHash, dataRevision, metrics, groups, coverage, facts, filterOptions };
}
function workbookEvidence(report) {
  const workbook = XLSX.read(exportBusinessReport(report), { type: 'buffer' });
  return Object.fromEntries(['Resumen', 'Detalle'].map(name => [name,
    XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true })]));
}
async function operationalState(store) {
  const tables = {
    orders: { key: ['id'] }, records: { key: ['id'] }, settings: { key: ['id'] }, counters: { key: ['id'] }, job_runs: { key: ['key'] },
    ...CORE_BACKUP_TABLES, ...COMMERCIAL_TABLES
  };
  return Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([table, definition]) =>
    [table, await store.db.all(`SELECT * FROM ${store.t(table)}${table === 'business_requests' ? " WHERE scope<>'onboarding:trial'" : ''} ORDER BY ${definition.key.join(',')}`)])));
}

test('dos prácticas persisten sin alterar la operación existente, informes posteriores, snapshots, Excel, caja ni stock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allnutrition-onboarding-reports-'));
  const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(directory, 'business.sqlite') };
  let store = await openStore(env);
  try {
    const email = await createAdmin(store, 'report-practice@example.test', 'clave-local-aislamiento-2026');
    const user = await store.db.get(`SELECT id,email FROM ${store.t('users')} WHERE email=?`, [email]);
    const today = bogotaDate(), historicalYear = Number(today.slice(0, 4)) - 1;
    const fixture = await createBusinessFixture(store, { year: historicalYear, actorId: user.id });
    await runOnboardingAction(store, { action: 'prepare', requestId: requestId(), responsibleId: fixture.person.id, accountId: fixture.account.id, openingConfirmed: true }, user);
    const existing = await getOnboarding(store, user);
    assert.deepEqual(existing.existingOrders, { count: 1, latestNumber: 1 });
    assert.equal(existing.readiness.orders, true);
    assert.notEqual(existing.settings.setupPolicyConfirmed, true);
    await runOnboardingAction(store, { action: 'complete', requestId: requestId() }, user);

    const historicalQuery = { period: 'month', anchorDate: `${historicalYear}-09-01`, asOf: `${historicalYear + 1}-02-01T12:00:00.000Z` };
    const trialPeriodQuery = { period: 'month', anchorDate: today, asOf: `${addDays(today, 40)}T12:00:00.000Z` };
    const futureQuery = { period: 'year', anchorDate: `${Number(today.slice(0, 4)) + 1}-01-01`, asOf: `${Number(today.slice(0, 4)) + 2}-02-01T12:00:00.000Z` };
    const queries = [historicalQuery, trialPeriodQuery, futureQuery];
    const reportsBefore = await Promise.all(queries.map(query => buildBusinessReport(store, query)));
    assert.equal(reportsBefore[0].metrics.netProductSales.value, fixture.a.price * 100 * 2);
    const saved = await generateReportSnapshot(store, historicalQuery, user.id);
    const savedBefore = await getReportSnapshot(store, saved.snapshot.id);
    const currentSaved = await generateReportSnapshot(store, trialPeriodQuery, user.id);
    const currentSavedBefore = await getReportSnapshot(store, currentSaved.snapshot.id);
    const stateBefore = await operationalState(store);
    const workbooksBefore = reportsBefore.map(workbookEvidence);
    const settingsBefore = (await getOnboarding(store, user)).settings;

    const input = { action: 'trial', requestId: requestId(), productId: fixture.a.id };
    const result = await runOnboardingAction(store, input, user);
    const trial = result.trialOrder;
    assert.equal(trial.isTest, true);
    assert.equal(trial.status, 'received');
    assert.equal(trial.items[0].itemId, fixture.a.id);
    assert.match(trial.id, /^trial:/);
    assert.equal(Object.hasOwn(trial, 'number'), false);
    assert.equal(trial.totalMinor, fixture.a.price * 100);
    assert.deepEqual((await runOnboardingAction(store, input, user)).trialOrder, trial);
    assert.equal(await store.order(trial.id), null);
    await assert.rejects(() => recordCollection(store, { requestId: requestId(), orderId: trial.id, version: 1, holder: 'business', accountId: fixture.account.id, amountMinor: trial.totalMinor, occurredOn: today, method: 'Efectivo', reference: 'Intento inválido de cobro de práctica' }, user.id), { status: 404 });
    assert.deepEqual(await operationalState(store), stateBefore);
    assert.deepEqual((await getOnboarding(store, user)).settings, settingsBefore);
    const secondInput = { action: 'trial', requestId: requestId(), productId: fixture.b.id };
    const secondTrial = (await runOnboardingAction(store, secondInput, user)).trialOrder;
    assert.notEqual(secondTrial.id, trial.id);
    assert.ok(secondTrial.receivedAt > trial.receivedAt);
    assert.equal(secondTrial.items[0].itemId, fixture.b.id);
    assert.equal(secondTrial.totalMinor, fixture.b.price * 100);
    assert.deepEqual((await runOnboardingAction(store, secondInput, user)).trialOrder, secondTrial);
    assert.deepEqual((await runOnboardingAction(store, input, user)).trialOrder, trial);
    assert.deepEqual((await getOnboarding(store, user)).trialOrder, secondTrial);
    assert.equal(await store.order(secondTrial.id), null);
    assert.deepEqual(await operationalState(store), stateBefore);
    const receipts = await store.db.all(`SELECT actor_id,result_json FROM ${store.t('business_requests')} WHERE scope='onboarding:trial' ORDER BY request_id`);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(row => row.actor_id === user.id));
    assert.deepEqual(receipts.map(row => JSON.parse(row.result_json).id).sort(), [trial.id, secondTrial.id].sort());

    await store.close();
    store = null;
    store = await openStore(env);
    assert.deepEqual((await getOnboarding(store, user)).trialOrder, secondTrial);
    assert.deepEqual(await operationalState(store), stateBefore);
    const reportsAfter = await Promise.all(queries.map(query => buildBusinessReport(store, query)));
    assert.deepEqual(reportsAfter.map(reportEvidence), reportsBefore.map(reportEvidence));
    assert.deepEqual(await getReportSnapshot(store, saved.snapshot.id), savedBefore);
    assert.deepEqual(await getReportSnapshot(store, currentSaved.snapshot.id), currentSavedBefore);
    assert.deepEqual(reportsAfter.map(workbookEvidence), workbooksBefore);

    const next = await store.saveOrder(businessOrderInput(fixture.a, { placedOn: today, deliveryMethod: 'pickup', shippingChargeMinor: 0 }), user.id);
    assert.equal(next.number, 2);
    assert.equal(next.items[0].itemId, fixture.a.id);
    assert.equal((await store.get('products', fixture.a.id)).stockReserved, 1);
  } finally {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
