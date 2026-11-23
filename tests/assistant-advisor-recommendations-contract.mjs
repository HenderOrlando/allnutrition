import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readAdvisorRecommendations } from '../lib/assistant/advisor-recommendations.mjs';
import { writeAdvisorPreferences } from '../lib/assistant/advisor-preferences.mjs';
import { getAdvisorTask, reserveAdvisorTask, updateAdvisorTask } from '../lib/assistant/advisor-tasks.mjs';
import { validateEvidence } from '../lib/assistant/contracts.mjs';
import { evaluateAlerts, getAlertRule, saveAlertRule } from '../lib/business/alerts.mjs';
import { recordExpense } from '../lib/business/expenses.mjs';
import { analyzeSocialCampaign, prepareSocialAnalysisRequest } from '../lib/business/social-analysis.mjs';
import { seedAdvisorAlert, seedAdvisorImport, stockEpisode } from './assistant-advisor-fixtures.mjs';
import { createBusinessFixture } from './business-fixtures.mjs';
import { CUT, createImprovementStoreFixture, exactMetric } from './social-improvements-fixture.mjs';

const firstCut = '2026-11-19T12:00:00.000Z';
const nextCut = '2026-11-19T13:00:00.000Z';
const clock = at => ({ now: () => Date.parse(at) });
const list = async (store, session, at = firstCut) => (await readAdvisorRecommendations(store, session, clock(at))).items;
const followInput = recommendationId => ({ id: randomUUID(), capabilityId: 'advisor.follow-recommendation', recommendationId });
const resultOf = task => task.data.progress.followUp;
const jobs = store => store.db.all(`SELECT * FROM ${store.t('job_runs')} ORDER BY key`);
const cutAfter = asOf => new Date(Math.max(Date.now(), Date.parse(asOf)) + 1000).toISOString();
const alerts = (items, id) => items.find(item => item.evidence.some(ref => ref.domain === 'alerts' && ref.entityId === id));

async function analyze(f, asOf) {
  const request = await prepareSocialAnalysisRequest(f.store, f.campaignId, { asOf });
  return analyzeSocialCampaign(f.store, f.campaignId,
    { asOf, requestId: request.requestId, expectedEvidenceHash: request.evidenceHash }, f.actorId);
}

async function setImportPreview(store, id, { at, conflicts, previewHash }) {
  const old = await store.db.get(`SELECT data FROM ${store.t('import_batches')} WHERE id=?`, [id]);
  const data = { ...JSON.parse(old.data), preview: { previewHash, summary: {
    total: 1, conflict: conflicts, rejected: 0, skipped: 0, settlementsPending: 0,
  } } };
  await store.db.run(`UPDATE ${store.t('import_batches')} SET state='review',updated_at=?,data=?,version=version+1 WHERE id=?`, [at, JSON.stringify(data), id]);
}

export async function runAdvisorRecommendationContracts(t, factory, { fixture, ready }) {
  await t.test('C5 recomendaciones visibles: corte, evidencia, prioridad, foco privado y reserva explícita sin efectos', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    await assert.rejects(() => list(store, alice), { code: 'ASSISTANT_DISABLED' });
    await assert.rejects(() => list(store, { user: alice.user }), { status: 401 });
    await ready(store, alice);
    const older = '2026-11-19T10:00:00.000Z';
    const stock = await seedAdvisorAlert(store, { title: 'Inventario sintético', actorId: alice.user.id, now: older });
    const critical = await seedAdvisorAlert(store, { title: 'Inventario urgente sintético', actorId: alice.user.id, now: older });
    await store.db.run(`UPDATE ${store.t('alerts')} SET severity='critical' WHERE id=?`, [critical.alert.id]);
    const batch = await seedAdvisorImport(store, { actorId: alice.user.id, now: firstCut, state: 'completed_with_errors', label: 'archivo-sintetico-privado-A.xlsx' });
    const before = await jobs(store), initial = await list(store, alice);
    assert.equal(initial[0].severity, 'critical');
    assert.equal(initial[1].area, 'orders');
    const card = initial.find(item => item.action.view.batch === batch);
    assert.equal(card.evidence.find(ref => ref.field === 'operationsWithIssues').formattedValue, '1');
    assert.doesNotMatch(JSON.stringify(card), /archivo-sintetico-privado-A|fileHash|filename/);
    for (const item of initial) {
      assert.ok(item.reason && item.asOf && item.limitation);
      assert.equal(item.action.capabilityId, 'advisor.recommendations');
      assert.equal(item.action.selection, null);
      assert.equal(item.action.focus, null);
      item.evidence.forEach(validateEvidence);
    }
    await writeAdvisorPreferences(store, alice, { version: 0, focusArea: 'products', detail: 'brief', showAnnouncements: false });
    const focused = await list(store, alice), other = await list(store, bob);
    assert.equal(focused[0].severity, 'critical');
    assert.equal(focused[1].id, alerts(initial, stock.alert.id).id);
    assert.ok(!other.some(item => item.action.view.batch === batch));
    assert.notEqual(other[0].id, focused[0].id);
    const input = followInput(card.id);
    await assert.rejects(() => reserveAdvisorTask(store, bob, input, clock(firstCut)), { status: 404 });
    await assert.rejects(() => reserveAdvisorTask(store, alice, { ...input, sourceRef: { kind: 'import', id: batch } }, clock(firstCut)), { status: 422 });
    await assert.rejects(() => reserveAdvisorTask(store, alice, followInput('rec_' + 'f'.repeat(64)), clock(firstCut)), { status: 404 });
    const saved = await reserveAdvisorTask(store, alice, input, clock(firstCut));
    assert.equal(resultOf(saved).state, 'pending');
    assert.equal(resultOf(saved).baseline.value, 'completed_with_errors');
    assert.deepEqual(await reserveAdvisorTask(store, alice, input, clock(firstCut)), saved);
    await assert.rejects(() => getAdvisorTask(store, bob, saved.id), { status: 404 });
    assert.doesNotMatch(JSON.stringify(saved), /archivo-sintetico-privado-A|fileHash|filename/);
    assert.deepEqual(await jobs(store), before);
  });

  await t.test('C5 el episodio corregido se retira; desactivar una regla no equivale a resolverlo', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    const { product, alert } = await seedAdvisorAlert(store, { title: 'Existencias corregibles', actorId: alice.user.id, now: firstCut });
    const card = alerts(await list(store, alice), alert.id), input = followInput(card.id);
    const saved = await reserveAdvisorTask(store, alice, input, clock(firstCut));
    const { baseline } = resultOf(saved);
    assert.equal(resultOf(saved).state, 'pending');
    assert.equal(resultOf(saved).current, null);
    await stockEpisode(store, product, alice.user.id, nextCut, 200);
    const closed = await updateAdvisorTask(store, alice, saved.id, { action: 'resume', version: saved.version }, clock(nextCut));
    assert.equal(closed.status, 'completed');
    assert.equal(resultOf(closed).state, 'resolved');
    assert.deepEqual(resultOf(closed).baseline, baseline);
    assert.equal(resultOf(closed).current.asOf, nextCut);
    assert.equal(resultOf(closed).current.value, 'resolved');
    assert.equal(alerts(await list(store, alice, nextCut), alert.id), undefined);
    await assert.rejects(() => reserveAdvisorTask(store, alice, followInput(card.id), clock(nextCut)), { status: 404 });
    assert.equal((await reserveAdvisorTask(store, alice, input, clock(nextCut))).id, saved.id);

    const second = await seedAdvisorAlert(store, { title: 'Otra condición', actorId: alice.user.id, now: nextCut });
    const secondCard = alerts(await list(store, alice, nextCut), second.alert.id);
    const following = await reserveAdvisorTask(store, alice, followInput(secondCard.id), clock(nextCut));
    const rule = await getAlertRule(store, 'stock_low');
    await saveAlertRule(store, { requestId: randomUUID(), version: rule.version, enabled: false }, alice.user.id, rule.id);
    await evaluateAlerts(store, { now: '2026-11-19T14:00:00.000Z' });
    const changed = await getAdvisorTask(store, alice, following.id);
    assert.equal(resultOf(changed).state, 'changed');
    assert.equal(resultOf(changed).current.value, false);
    assert.notEqual(changed.status, 'completed');
  });

  await t.test('C5 una revisión de importación solo resuelve incidencias si conserva el alcance', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    const batch = await seedAdvisorImport(store, { actorId: alice.user.id, now: firstCut, state: 'queued' });
    await store.db.run(`INSERT INTO ${store.t('import_rows')} (batch_id,sheet,row_number,entity_key,state,data,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [batch, 'Hoja sintética privada', 7, 'grupo-inicial', 'conflict', '{}', 1, firstCut, firstCut]);
    await setImportPreview(store, batch, { at: firstCut, conflicts: 1, previewHash: 'a'.repeat(64) });
    const item = (await list(store, alice)).find(card => card.action.view.batch === batch);
    assert.equal(item.evidence.find(ref => ref.field === 'reviewGroupsWithIssues').value, 1);
    const task = await reserveAdvisorTask(store, alice, followInput(item.id), clock(firstCut));
    assert.doesNotMatch(JSON.stringify(task), /Hoja sintética privada|grupo-inicial/);

    await setImportPreview(store, batch, { at: nextCut, conflicts: 0, previewHash: 'b'.repeat(64) });
    await store.db.run(`UPDATE ${store.t('import_rows')} SET entity_key=?,state='new' WHERE batch_id=?`, ['grupo-nuevo', batch]);
    const mismatched = await getAdvisorTask(store, alice, task.id);
    assert.equal(resultOf(mismatched).state, 'not_comparable');
    assert.equal(resultOf(mismatched).current.asOf, nextCut);
    assert.equal(resultOf(mismatched).current.value, 'review');
    assert.equal((await list(store, alice, nextCut)).find(card => card.action.view.batch === batch), undefined);

    await store.db.run(`UPDATE ${store.t('import_rows')} SET entity_key=? WHERE batch_id=?`, ['grupo-inicial', batch]);
    const comparable = await updateAdvisorTask(store, alice, task.id, { action: 'resume', version: task.version }, clock(nextCut));
    assert.equal(resultOf(comparable).state, 'resolved');
    assert.match(comparable.data.progress.message, /no aplica cambios/i);
  });

  await t.test('C5 un informe relee la misma medida, unidad y mes sin copiar informes ni atribuir causas', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    const facts = await createBusinessFixture(store, { year: 2025, actorId: alice.user.id, reportsStartOn: '2025-09-01' });
    const asOf = '2025-09-28T12:00:00.000Z';
    const item = (await list(store, alice, asOf)).find(card => card.action.view.issue === 'shipping_absorbed');
    assert.equal(item.evidence[0].value, 300000);
    const task = await reserveAdvisorTask(store, alice, followInput(item.id), clock(asOf)), baseline = resultOf(task).baseline;
    const current = await store.db.get(`SELECT version FROM ${store.t('expenses')} WHERE id=?`, [facts.shippingExpenseId]);
    await recordExpense(store, { id: facts.shippingExpenseId, version: current.version, requestId: randomUUID(), amountMinor: 1600000,
      reason: 'Corrección sintética de un costo observado' }, alice.user.id);
    const before = await jobs(store);
    const updated = await updateAdvisorTask(store, alice, task.id, { action: 'resume', version: task.version }, clock(cutAfter(baseline.asOf)));
    assert.equal(resultOf(updated).state, 'changed');
    assert.deepEqual(resultOf(updated).baseline, baseline);
    assert.equal(resultOf(updated).current.value, 400000);
    assert.equal(resultOf(updated).current.unit, baseline.unit);
    assert.equal(updated.data.progress.known[1].value, '2025-09-01 a 2025-10-01 (fin excluido)');
    assert.match(updated.data.progress.message, /no demuestra/i);
    assert.deepEqual(await jobs(store), before);
    assert.deepEqual(await store.db.all(`SELECT id FROM ${store.t('report_snapshots')}`), []);
  });

  await t.test('C5 la publicidad usa capturas locales comparables y retira análisis obsoletos sin iniciar trabajos', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    const social = await createImprovementStoreFixture(store);
    const analysis = await analyze(social, CUT), native = analysis.recommendations.find(item => item.ruleKey === 'weak_link_ctr');
    const item = (await list(store, alice, CUT)).find(card => card.evidence[0].entityId === native.id);
    assert.equal(item.asOf, CUT);
    assert.equal(item.evidence[0].value, 1);
    assert.equal(item.evidence[0].unit, 'percent');
    const before = await jobs(store);
    const task = await reserveAdvisorTask(store, alice, followInput(item.id), clock(CUT));
    assert.equal(resultOf(task).state, 'pending');
    const later = '2026-11-02T12:01:00.000Z';
    await social.addMeasurement({ query: social.measurement.query, fetchedAt: later, values: { linkClicks: exactMetric(120) } });
    assert.ok(!(await list(store, alice, later)).some(card => card.id === item.id));
    const stale = await updateAdvisorTask(store, alice, task.id, { action: 'resume', version: task.version }, clock(later));
    assert.equal(resultOf(stale).state, 'not_comparable');
    assert.deepEqual(await jobs(store), before);
    const refreshed = await analyze(social, later);
    assert.ok(refreshed.recommendations.some(item => item.ruleKey === 'weak_link_ctr'));
    const nextJobs = await jobs(store);
    const changed = await updateAdvisorTask(store, alice, task.id, { action: 'resume', version: stale.version }, clock(later));
    assert.equal(resultOf(changed).state, 'changed', changed.data.progress.message);
    assert.equal(resultOf(changed).current.value, 1.2);
    assert.equal(resultOf(changed).current.unit, 'percent');
    assert.deepEqual(await jobs(store), nextJobs);
  });
}
