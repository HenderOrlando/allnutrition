import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getAdvisorTask, reserveAdvisorTask, updateAdvisorTask } from '../lib/assistant/advisor-tasks.mjs';
import { listAdvisorInbox } from '../lib/assistant/inbox.mjs';
import { writeExcelSheets } from '../lib/business/excel.mjs';
import {
  cancelImportBatch, commitImport, createImportBatch, expireImportFiles, getImportBatch,
  processImportTurn, requestImportPreview, updateImportBatch, uploadImportFile,
} from '../lib/business/imports.mjs';
import { listResources, saveResource } from '../lib/business/settings.mjs';

const request = () => ({ requestId: randomUUID() });
const capabilityId = 'imports.resolve-issues';
const invalidAmount = 'Importe privado por verificar';
const privateConcept = 'Concepto sintético privado C4';

export function advisorImportWorkbook({ extraIssue = false } = {}) {
  const destinations = ['expenseExternalId', 'expenseDate', 'expenseConcept', 'expenseAmount'];
  const headers = ['ID gasto', 'Fecha', 'Concepto', 'Importe'];
  const sheet = 'Gastos C4';
  const tables = [{ name: sheet, rows: [headers, ['C4-OK', '2026-09-01', 'Gasto válido C4', 12000], ['C4-PENDING', '2026-09-02', privateConcept, invalidAmount]] }];
  if (extraIssue) tables.push({ name: 'A C4', rows: [headers, ['C4-OTHER', '2026-09-03', 'Otra incidencia C4', invalidAmount]] });
  const config = { formatVersion: 2, sheets: tables.map(({ name }) => ({
    sheetName: name, enabled: true, headerRow: 1, purpose: 'expenses', layout: 'expense_rows',
    dateFormat: 'ISO', decimalSeparator: '.', groupSeparator: ',', reportAsOf: '2026-09-05',
    identityMode: 'provided', defaults: { expenseCategory: 'operating' },
    columns: destinations.map((destination, index) => ({ index, header: headers[index].toLowerCase(), destination, group: 0 })),
  })) };
  const correction = { action: 'cell_value', sheet, rowNumber: 3, columnIndex: 3, value: 9800, reason: 'Confirmé el importe en el soporte sintético.' };
  return { filename: 'asesor-c4-sintetico.xlsx', bytes: writeExcelSheets(tables), config, correction };
}

export async function prepareAdvisorImportBatch(store, { sourceId, actorId, extraIssue }) {
  const { filename, bytes, config } = advisorImportWorkbook({ extraIssue });
  let batch = await createImportBatch(store, { ...request(), sourceId }, actorId);
  await uploadImportFile(store, batch.id, { ...request(), filename, bytes, version: batch.version }, actorId);
  batch = await inspectPhase(store, batch.id, 'inspect');
  batch = await updateImportBatch(store, batch.id, { ...request(), version: batch.version, config }, actorId);
  if (batch.state === 'uploaded') batch = await inspectPhase(store, batch.id, 'inspect');
  const samples = batch.workbook?.inspections || [batch.workbook];
  assert.ok(config.sheets.every(sheet => samples.some(sample => sample?.sheetName === sheet.sheetName && Number(sample.headerRow) === sheet.headerRow)),
    'La revisión del fixture requiere muestras persistidas de sus encabezados elegidos.');
  return preview(store, batch, actorId);
}

async function preview(store, batch, actorId) {
  await requestImportPreview(store, batch.id, { ...request(), version: batch.version }, actorId);
  return inspectPhase(store, batch.id, 'preview');
}
async function inspectPhase(store, batchId, phase) {
  // A running Next worker can claim the same job first. Observe its durable
  // state rather than assuming our call acquired the lease.
  for (let attempt = 0; attempt < 9; attempt++) {
    await processImportTurn(store, { batchId, ...(phase === 'inspect' ? { expectedPhase: phase } : null) });
    const batch = await getImportBatch(store, batchId);
    if (!['uploaded', 'previewing'].includes(batch.state)) {
      assert.ok(phase === 'inspect' ? batch.workbook : batch.preview?.previewHash, batch.error?.message || `El lote no terminó ${phase}`);
      return batch;
    }
    if (attempt < 8) await delay(125);
  }
  assert.fail(`El lote sintético ${batchId} sigue en ${phase} después de nueve lecturas.`);
}
const accept = (store, batch, actorId, includeValidOnly = false) => commitImport(store, batch.id, {
  ...request(), version: batch.version, previewHash: batch.preview.previewHash, includeValidOnly,
}, actorId);
const taskInput = batch => ({ id: randomUUID(), capabilityId, sourceRef: { kind: 'import', id: batch.id } });
const resume = (store, session, task) => updateAdvisorTask(store, session, task.id, { action: 'resume', version: task.version });
const answer = (store, session, task, index) => {
  const { id: questionId, field, options } = task.data.progress.question;
  return updateAdvisorTask(store, session, task.id, { action: 'answer', version: task.version, step: task.step, questionId, field, value: options[index].id });
};
const expenses = store => store.db.all(`SELECT id,version,amount_minor,source_key FROM ${store.t('expenses')} ORDER BY id`);
const nativeCount = async (store, table) => Number((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t(table)}`)).n);

export async function runAdvisorImportContracts(t, factory, { fixture, ready }) {
  async function setup(t, extraIssue = false) {
    const { store, alice, bob } = await fixture(t, factory);
    await ready(store, alice);
    const actorId = alice.user.id;
    const platform = await saveResource(store, 'platforms', { ...request(), name: 'Origen sintético C4' }, actorId);
    const [source] = await listResources(store, 'sources', { platform: platform.id });
    const batch = await prepareAdvisorImportBatch(store, { sourceId: source.id, actorId, extraIssue });
    assert.equal(batch.state, 'review', batch.error?.message);
    assert.equal(batch.preview.summary.valid, 1);
    return { store, alice, bob, actorId, batch };
  }

  await t.test('C4 importación parcial: corrige la fila real, acepta una revisión nueva y no repite lo aplicado', async t => {
    const { store, alice, bob, actorId, batch } = await setup(t);
    const { correction } = advisorImportWorkbook();
    const inbox = await listAdvisorInbox(store, alice);
    assert.ok(inbox.items.some(item => item.source.id === batch.id));
    assert.ok(!(await listAdvisorInbox(store, bob)).items.some(item => item.source.id === batch.id));
    await assert.rejects(() => reserveAdvisorTask(store, bob, { id: randomUUID(), capabilityId }), { status: 422 });
    const cashBefore = await nativeCount(store, 'cash_entries');
    let task = await reserveAdvisorTask(store, alice, taskInput(batch));
    assert.equal(task.step, 'import-row');
    assert.deepEqual(task.data.progress.action.selection, {
      kind: 'import', batchId: batch.id, version: batch.version, previewHash: batch.preview.previewHash, sheet: correction.sheet, rowNumber: 3,
    });
    assert.deepEqual(task.data.progress.action.view, { section: 'orders', tab: 'imports', batch: batch.id });
    assert.doesNotMatch(JSON.stringify(task), new RegExp(`${privateConcept}|${invalidAmount}`));
    await assert.rejects(() => getAdvisorTask(store, bob, task.id), { status: 404 });
    assert.deepEqual(await expenses(store), []);
    assert.deepEqual((await getAdvisorTask(store, alice, task.id)).data.progress.action, task.data.progress.action);

    await assert.rejects(() => accept(store, batch, actorId), { status: 409 });
    await accept(store, batch, actorId, true); // Acceptance is native; simulate ignoring its HTTP response.
    task = await resume(store, alice, task);
    assert.equal(task.status, 'waiting_result');
    assert.equal(task.data.progress.action.focus, 'import-result');
    assert.equal(task.data.progress.proof, undefined);
    await processImportTurn(store, { batchId: batch.id });
    let native = await getImportBatch(store, batch.id);
    assert.equal(native.state, 'completed_with_errors');
    const [initialExpense] = await expenses(store);
    assert.equal(Number(initialExpense.amount_minor), 1200000);
    task = await resume(store, alice, task);
    assert.equal(task.step, 'import-pending');
    assert.equal(task.data.progress.action.focus, 'import-pending');
    assert.ok(task.data.progress.known.some(({ label, value }) => /incidencia/.test(label) && value === '1'));
    assert.equal(task.data.progress.proof, undefined);

    native = await preview(store, native, actorId);
    task = await resume(store, alice, task);
    assert.equal(task.step, 'import-row');
    assert.equal(task.data.progress.action.selection.rowNumber, 3);
    assert.equal(task.data.progress.action.selection.revision, 1);
    native = await updateImportBatch(store, native.id, { ...request(), version: native.version, resolutions: [correction] }, actorId);
    task = await resume(store, alice, task);
    assert.equal(task.step, 'import-review');
    assert.equal(task.data.progress.proof, undefined);
    assert.deepEqual(await expenses(store), [initialExpense]);
    native = await preview(store, native, actorId);
    assert.equal(native.preview.summary.applied, 1);
    assert.equal(native.preview.summary.valid, 1);
    assert.notEqual(native.preview.previewHash, batch.preview.previewHash);
    await assert.rejects(() => commitImport(store, native.id, { ...request(), version: native.version, previewHash: batch.preview.previewHash }, actorId), { status: 409 });
    await accept(store, native, actorId);
    task = await resume(store, alice, task);
    assert.equal(task.status, 'waiting_result');
    const { accepted_at: acceptedAt } = await store.db.get(`SELECT accepted_at FROM ${store.t('import_revisions')} WHERE batch_id=? AND revision=2`, [native.id]);
    // A worker turn can capture its clock before the newly queued revision is visible.
    await processImportTurn(store, { batchId: native.id, now: new Date(Date.parse(acceptedAt) - 1000).toISOString() });
    native = await getImportBatch(store, native.id);
    task = await resume(store, alice, task);
    assert.equal(native.state, 'completed');
    assert.equal(native.acceptedRevision, 2);
    assert.ok(native.completedAt >= acceptedAt, 'El trabajo aplicado nunca puede constar terminado antes de su aceptación');
    assert.equal(task.status, 'completed');
    const proof = { kind: 'record', label: 'Lote aplicado · revisión 2', entityId: native.id, recordVersion: native.version, committedAt: native.completedAt };
    assert.deepEqual(task.data.progress.proof, proof);
    assert.deepEqual((await getAdvisorTask(store, alice, task.id)).data.progress.proof, proof);
    const applied = await expenses(store);
    assert.equal(applied.length, 2);
    assert.deepEqual(applied.find(({ id }) => id === initialExpense.id), initialExpense);
    assert.equal(Number(applied.find(({ id }) => id !== initialExpense.id).amount_minor), 980000);
    assert.equal(await nativeCount(store, 'cash_entries'), cashBefore);
  });

  await t.test('C4 opciones ordenadas por hoja/fila; una opción obsoleta no se reasigna y cancelar la tarea no cancela Excel', async t => {
    const { store, alice, actorId, batch } = await setup(t, true);
    const task = await reserveAdvisorTask(store, alice, taskInput(batch));
    assert.equal(task.status, 'waiting_input');
    const labels = ['A C4 · fila 2', 'Gastos C4 · fila 3'];
    assert.deepEqual(task.data.progress.question.options.map(({ label }) => label), labels);
    const dbTask = await store.db.get(`SELECT data FROM ${store.t('assistant_advisor_tasks')} WHERE id=?`, [task.id]);
    for (const label of labels) assert.ok(!dbTask.data.includes(label));
    const current = await preview(store, batch, actorId);
    await assert.rejects(() => answer(store, alice, task, 1), { status: 409 });
    const refreshed = await resume(store, alice, task);
    assert.deepEqual(refreshed.data.progress.question.options.map(({ label }) => label), labels);
    assert.notEqual(refreshed.data.progress.question.options[1].id, task.data.progress.question.options[1].id);
    const selected = await answer(store, alice, refreshed, 1);
    assert.equal(selected.data.progress.action.selection.sheet, 'Gastos C4');
    assert.equal(selected.data.progress.action.selection.version, current.version);
    assert.deepEqual((await getAdvisorTask(store, alice, selected.id)).data.progress.action, selected.data.progress.action);
    const cancelled = await updateAdvisorTask(store, alice, selected.id, { action: 'cancel', version: selected.version });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await getImportBatch(store, batch.id)).version, current.version);
    assert.deepEqual(await expenses(store), []);
  });

  await t.test('C4 cancelación nativa y caducidad no acreditan guardados ni reconstruyen originales', async t => {
    const { store, alice, actorId, batch } = await setup(t);
    const cancelledTask = await reserveAdvisorTask(store, alice, taskInput(batch));
    await cancelImportBatch(store, batch.id, request(), actorId);
    const cancelled = await resume(store, alice, cancelledTask);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.data.progress.proof, undefined);
    assert.equal((await getAdvisorTask(store, alice, cancelled.id)).data.progress.action.focus, 'import-result');
    const other = await prepareAdvisorImportBatch(store, { sourceId: batch.sourceId, actorId });
    const pending = await reserveAdvisorTask(store, alice, taskInput(other));
    await expireImportFiles(store, { now: new Date(Date.parse(other.expiresAt) + 1).toISOString() });
    const expired = await resume(store, alice, pending);
    assert.equal(expired.status, 'blocked');
    assert.equal(expired.data.progress.action.focus, 'import-result');
    assert.match(expired.data.progress.message, /original ya no está disponible/);
    assert.equal(expired.data.progress.proof, undefined);
    assert.deepEqual(await expenses(store), []);
  });
}
