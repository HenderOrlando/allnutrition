import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAdmin, login } from '../lib/auth.mjs';
import { ASSISTANT_ADVISOR_INTERNAL_TABLES, migrateAssistantAdvisorV17 } from '../lib/db/migrations.mjs';
import { deleteAdvisorTask, getAdvisorTask, listAdvisorTasks, reserveAdvisorTask, updateAdvisorTask } from '../lib/assistant/advisor-tasks.mjs';
import { listAdvisorInbox, updateAdvisorInbox } from '../lib/assistant/inbox.mjs';
import { importData } from '../lib/import.mjs';
import { businessOrderInput, createBusinessBasics, createBusinessFixture } from './business-fixtures.mjs';
import { runAdvisorImportContracts } from './assistant-advisor-imports-contract.mjs';
import { runAdvisorCashContracts } from './assistant-advisor-cash-contract.mjs';
import { runAdvisorPreferenceContracts } from './assistant-advisor-preferences-contract.mjs';
import { runAdvisorRecommendationContracts } from './assistant-advisor-recommendations-contract.mjs';
import { runAdvisorCommandContracts } from './assistant-advisor-commands-contract.mjs';
import { saveShipment } from '../lib/business/shipments.mjs';
import { evaluateAlerts } from '../lib/business/alerts.mjs';
import { seedAdvisorAlert, seedAdvisorImport, setAdvisorImportResult, stockEpisode } from './assistant-advisor-fixtures.mjs';

const time = '2026-11-19T12:00:00.000Z';
const nextHour = '2026-11-19T13:00:00.000Z';
const clock = { now: () => Date.parse(time) };
const password = 'advisor-synthetic-test-passphrase';

async function authenticate(store, name) {
  const email = `advisor-${name}@example.test`;
  await createAdmin(store, email, password);
  const { user, csrf, token } = await login(store, email, password);
  return { user, csrf, sessionTokenHash: createHash('sha256').update(token).digest('hex') };
}

async function fixture(t, factory) {
  const store = await factory();
  t.after(() => store.close());
  const alice = await authenticate(store, 'a');
  const bob = await authenticate(store, 'b');
  return { store, alice, bob };
}

async function ready(store, session) {
  // The task endpoint checks verification state but must not open a model connection.
  await store.db.run(`INSERT INTO ${store.t('assistant_settings')} (id,version,enabled,data,api_key_ciphertext,api_key_iv,api_key_tag,actor_id,created_at,updated_at) VALUES(1,1,1,?,?,?,?,?,?,?)`, [
    JSON.stringify({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:3339/v1', model: 'advisor-fixture', allowPrivateNetwork: true, connectionStatus: 'ready', verifiedAt: time }),
    'synthetic-ciphertext', 'synthetic-iv', 'synthetic-tag', session.user.id, time, time,
  ]);
}

async function commercial(store) {
  const { exportedAt, ...facts } = await store.exportData();
  return facts;
}

async function tableExists(store, table) {
  if (store.provider === 'sqlite') return Boolean(await store.db.get('SELECT name FROM sqlite_master WHERE type=? AND name=?', ['table', table]));
  return Boolean((await store.db.get('SELECT to_regclass(?) AS name', [store.t(table)])).name);
}

const reminder = (label = 'Revisar existencias') => ({ id: randomUUID(), capabilityId: 'advisor.reminder', dueAt: nextHour, label });
const status = value => error => error.status === value;

export async function runAdvisorSchemaContracts(t, factory, { openRuntime } = {}) {
  await t.test('C1 v17 revierte DDL fallido, respeta v16 y conserva historial al repetir', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    await createBusinessFixture(store, { year: 2025, actorId: alice.user.id });
    const fact = await commercial(store);
    await store.transaction(async tx => {
      await tx.lockWrites();
      for (const table of [...ASSISTANT_ADVISOR_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
      await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=17`);
    });
    if (openRuntime) await assert.rejects(openRuntime, /v17/);
    const collision = 'assistant_advisor_notice_state';
    const v16 = await store.db.get(`SELECT applied_at FROM ${store.t('migrations')} WHERE version=16`);
    await store.db.run(`DELETE FROM ${store.t('migrations')} WHERE version=16`);
    try { await assert.rejects(migrateAssistantAdvisorV17(store), /v16/); }
    finally { await store.db.run(`INSERT INTO ${store.t('migrations')} (version,applied_at) VALUES(16,?)`, [v16.applied_at]); }
    await store.db.exec(`CREATE TABLE ${store.t(collision)} (collision INTEGER)`);
    try {
      await assert.rejects(migrateAssistantAdvisorV17(store), /already exists/i);
      assert.equal(await tableExists(store, 'assistant_advisor_tasks'), false);
      assert.equal(await tableExists(store, 'assistant_advisor_preferences'), false);
      assert.equal(await store.db.get(`SELECT version FROM ${store.t('migrations')} WHERE version=17`), null);
    } finally {
      await store.db.exec(`DROP TABLE ${store.t(collision)}`);
      assert.deepEqual(await migrateAssistantAdvisorV17(store), { migrated: true, version: 17 });
    }
    const saved = await reserveAdvisorTask(store, alice, reminder(), clock);
    const oversized = JSON.stringify({ objective: '🥑'.repeat(4100) });
    assert.ok(oversized.length < 16384 && Buffer.byteLength(oversized, 'utf8') > 16384);
    await assert.rejects(store.db.run(`UPDATE ${store.t('assistant_advisor_tasks')} SET data=? WHERE user_id=? AND id=?`, [oversized, alice.user.id, saved.id]), error =>
      error.code === '23514' || /CHECK constraint failed/i.test(error.message));
    assert.deepEqual(await migrateAssistantAdvisorV17(store), { migrated: false, version: 17 });
    assert.deepEqual(await getAdvisorTask(store, alice, saved.id), saved);
    assert.deepEqual(await commercial(store), fact);
    if (store.provider === 'sqlite') assert.deepEqual(await store.db.all('PRAGMA foreign_key_check'), []);
  });
}

export async function runAdvisorContracts(t, factory) {
  await t.test('C1 solo el administrador dueño reserva, lee y cambia su tarea versionada', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    const input = reminder();
    await assert.rejects(reserveAdvisorTask(store, alice, input, clock), error => error.code === 'ASSISTANT_DISABLED');
    await ready(store, alice);
    const [one, repeated] = await Promise.all([reserveAdvisorTask(store, alice, input, clock), reserveAdvisorTask(store, alice, input, clock)]);
    assert.deepEqual(repeated, one);
    assert.equal(one.version, 1);
    assert.equal(one.data.label, input.label);
    await assert.rejects(reserveAdvisorTask(store, alice, { ...input, label: 'Otro asunto' }, clock), status(409));
    await assert.rejects(reserveAdvisorTask(store, alice, { ...input, owner: bob.user.id }, clock), status(422));
    await assert.rejects(getAdvisorTask(store, bob, one.id), status(404));
    await assert.rejects(updateAdvisorTask(store, bob, one.id, { version: 1, action: 'cancel' }, clock), status(404));
    await assert.rejects(deleteAdvisorTask(store, bob, one.id, { version: 1 }), status(404));
    assert.deepEqual(await listAdvisorTasks(store, bob), { items: [], page: 1, total: 0 });
    const bobTask = await reserveAdvisorTask(store, bob, { ...input, label: 'Solo B' }, clock);
    assert.equal((await getAdvisorTask(store, alice, one.id)).data.label, input.label);
    assert.equal(bobTask.data.label, 'Solo B');
    await assert.rejects(updateAdvisorTask(store, alice, one.id, { version: 1, action: 'cancel', status: 'completed' }, clock), status(422));
    const cancelled = await updateAdvisorTask(store, alice, one.id, { version: 1, action: 'cancel' }, clock);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.version, 2);
    await assert.rejects(deleteAdvisorTask(store, alice, one.id, { version: 1 }), status(409));
    await store.db.run(`UPDATE ${store.t('assistant_settings')} SET enabled=0,version=2 WHERE id=1`);
    assert.equal((await getAdvisorTask(store, alice, one.id)).status, 'cancelled');
    await deleteAdvisorTask(store, alice, one.id, { version: 2 });
    assert.equal((await getAdvisorTask(store, bob, one.id)).data.label, 'Solo B');
    await store.db.run(`UPDATE ${store.t('sessions')} SET expires=0 WHERE token_hash=?`, [bob.sessionTokenHash]);
    await assert.rejects(listAdvisorTasks(store, bob), status(401));
    await assert.rejects(deleteAdvisorTask(store, bob, one.id, { version: 1 }), status(401));
  });

  await t.test('C1 respaldo no exporta ni importa datos personales; tampoco los purga al restaurar', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    const baseline = await commercial(store);
    const backup = { ...baseline, exportedAt: time };
    await store.db.run(`INSERT INTO ${store.t('assistant_advisor_preferences')} (user_id, version, focus_area, detail, show_announcements) VALUES(?,1,'cash','brief',0)`, [bob.user.id]);
    await assert.rejects(importData(store, backup), /destino debe estar vacío/i);
    assert.deepEqual(await commercial(store), baseline);
    for (const table of ASSISTANT_ADVISOR_INTERNAL_TABLES) {
      await assert.rejects(importData(store, { ...backup, business: { ...backup.business, [table]: [{ user_id: bob.user.id }] } }), /no admite datos internos/i);
    }
    await ready(store, alice);
    const saved = await reserveAdvisorTask(store, bob, reminder('Asunto privado de prueba'), clock);
    await store.db.run(`INSERT INTO ${store.t('assistant_advisor_notice_state')} (user_id, source_key, seen_fingerprint, version) VALUES(?,?,?,1)`, [bob.user.id, 'reminder:' + saved.id, 'synthetic-state']);
    const exported = JSON.stringify(await commercial(store));
    for (const table of ASSISTANT_ADVISOR_INTERNAL_TABLES) assert.ok(!exported.includes(table), table);
    assert.ok(!exported.includes(saved.data.label));
    assert.equal((await getAdvisorTask(store, bob, saved.id)).id, saved.id);
    await store.db.run(`DELETE FROM ${store.t('users')} WHERE id=?`, [bob.user.id]);
    for (const table of ASSISTANT_ADVISOR_INTERNAL_TABLES) {
      assert.equal(await store.db.get(`SELECT user_id FROM ${store.t(table)} WHERE user_id=?`, [bob.user.id]), null);
    }
    assert.deepEqual(await commercial(store), baseline);
  });

  await t.test('C2 bandeja personal relee alertas, lotes y vencimientos sin ejecutar negocio', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    await ready(store, alice);
    const actorId = alice.user.id;
    const { product, alert } = await seedAdvisorAlert(store, { actorId, now: time, title: 'Agotado C2' });
    const batchId = await seedAdvisorImport(store, { actorId, now: time });
    assert.equal(alert.state, 'open');
    const read = (session, at = time) => listAdvisorInbox(store, session, { now: () => Date.parse(at) });
    const find = (result, sourceId) => result.items.find(card => card.source.id === sourceId);
    const change = (session, card, action, at = time, extra = {}) => updateAdvisorInbox(store, session, {
      key: card.key, fingerprint: card.fingerprint, version: card.version, action, ...extra,
    }, { now: () => Date.parse(at) });
    const current = () => store.db.get(`SELECT state,version,responsible_id FROM ${store.t('alerts')} WHERE id=?`, [alert.id]);
    const prior = await current();
    let a = await read(alice), b = await read(bob);
    assert.equal(a.items.filter(card => card.source.id === alert.id).length, 1);
    assert.equal(find(b, alert.id).read, false);
    const queued = find(a, batchId);
    assert.match(queued.title, /proceso/i);
    assert.equal(find(b, batchId), undefined);
    await assert.rejects(change(bob, queued, 'seen'), status(404));
    const episode = find(a, alert.id);
    await change(alice, episode, 'seen');
    await assert.rejects(change(alice, episode, 'seen'), status(409));
    assert.deepEqual(await current(), prior);
    await evaluateAlerts(store, { now: time });
    await evaluateAlerts(store, { now: time });
    a = await read(alice);
    assert.equal(find(a, alert.id).read, true);
    assert.equal(find(a, alert.id).fingerprint, episode.fingerprint);
    assert.equal(a.items.filter(card => card.source.id === alert.id).length, 1);
    assert.equal(find(await read(bob), alert.id).read, false);

    const snooze = '2026-11-19T12:30:00.000Z';
    await change(alice, find(a, alert.id), 'snooze', time, { until: snooze });
    assert.equal(find(await read(alice), alert.id), undefined);
    assert.equal(find(await read(bob), alert.id).read, false);
    a = await read(alice, snooze);
    const revived = find(a, alert.id);
    assert.equal(revived.read, false);
    assert.equal(revived.fingerprint, episode.fingerprint);
    await change(alice, revived, 'seen', snooze);
    assert.equal(find(await read(alice, snooze), alert.id).read, true);
    await change(alice, find(await read(alice, snooze), alert.id), 'snooze', snooze, { until: nextHour });
    const free = await reserveAdvisorTask(store, alice, reminder('Revisar resultados C2'), clock);
    const conditional = await reserveAdvisorTask(store, alice, { ...reminder('Revisar si persiste'), sourceRef: { kind: 'alert', id: alert.id } }, clock);
    const replenished = await stockEpisode(store, product, actorId, '2026-11-19T12:45:00.000Z', 20);
    assert.equal(replenished.alert.state, 'resolved');
    a = await read(alice, nextHour);
    assert.equal(find(a, alert.id), undefined);
    assert.equal(find(a, conditional.id), undefined);
    assert.equal(find(a, free.id).kind, 'reminder');
    assert.equal(find(await read(bob, nextHour), free.id), undefined);
    const replacement = await stockEpisode(store, replenished.product, actorId, nextHour);
    assert.notEqual(replacement.alert.id, alert.id);
    assert.equal(find(await read(alice, nextHour), replacement.alert.id).read, false);

    await setAdvisorImportResult(store, batchId, { state: 'completed_with_errors', now: nextHour, label: 'C2-muestra.xlsx' });
    const business = await commercial(store);
    a = await read(alice, nextHour);
    const partial = find(a, batchId);
    assert.match(partial.title, /incidencias/i);
    assert.notEqual(partial.fingerprint, queued.fingerprint);
    assert.doesNotMatch(partial.reason, /filas duplicadas|todo aplicado/i);
    assert.equal(find(await read(bob, nextHour), batchId), undefined);
    await reserveAdvisorTask(store, bob, { id: randomUUID(), capabilityId: 'imports.resolve-issues', sourceRef: { kind: 'import', id: batchId } }, clock);
    b = await read(bob, nextHour);
    assert.equal(b.items.filter(card => card.source.id === batchId).length, 1);
    assert.equal((await listAdvisorInbox(store, alice, { summary: true, now: () => Date.parse(nextHour) })).unreadCount, a.unreadCount);
    const acknowledged = await updateAdvisorTask(store, alice, free.id, { version: free.version, action: 'acknowledge-reminder' }, { now: () => Date.parse(nextHour) });
    assert.equal(acknowledged.status, 'completed');
    assert.equal(find(await read(alice, nextHour), free.id), undefined);
    await store.db.run(`UPDATE ${store.t('assistant_settings')} SET enabled=0,version=2 WHERE id=1`);
    await assert.rejects(read(alice, nextHour), error => error.code === 'ASSISTANT_DISABLED');
    assert.equal((await getAdvisorTask(store, alice, free.id)).status, 'completed');
    assert.deepEqual(await commercial(store), business);
  });

  await t.test('C2 cuenta todas las tarjetas antes de paginar', async t => {
    const { store, alice } = await fixture(t, factory);
    await ready(store, alice);
    await store.transaction(async tx => {
      for (let index = 1; index <= 21; index++) {
        const id = `stock-episode-c2-${String(index).padStart(2, '0')}`;
        await tx.db.run(`INSERT INTO ${tx.t('alerts')}
          (id,rule_id,entity_type,entity_id,episode,state,severity,first_seen_at,last_seen_at,version,data,created_at,updated_at)
          VALUES(?,'stock_low','product',?,1,'open',?,?,?,1,?,?,?)`, [
          id, id, index === 21 ? 'critical' : 'warning', time, time,
          JSON.stringify({ title: `Existencias C2 ${index}`, reason: 'Stock observado en fixture', availableUnits: '0', orderedUnits: '0' }), time, time,
        ]);
      }
    });
    const first = await listAdvisorInbox(store, alice, clock);
    const second = await listAdvisorInbox(store, alice, { ...clock, page: 2 });
    const summary = await listAdvisorInbox(store, alice, { ...clock, summary: true });
    assert.equal(first.items.length, 20);
    assert.equal(first.items[0].severity, 'critical');
    assert.equal(second.items.length, 1);
    assert.ok(!first.items.some(card => card.key === second.items[0].key));
    assert.equal(first.total, 21);
    assert.deepEqual(summary, { unreadCount: 21, asOf: first.asOf });
  });

  await t.test('C3 retoma respuestas, invalida la revisión del pedido editado y acredita el vínculo real', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    await ready(store, alice);
    const actorId = alice.user.id;
    const { a, b } = await createBusinessBasics(store, { year: 2025, actorId });
    let order = await store.saveOrder(businessOrderInput(a, { year: 2025, items: [a, b].map(product => ({
      lineId: randomUUID(), kind: 'products', itemId: product.id, quantity: 1, unitPriceMinor: product.price * 100, discountMinor: 0,
    })) }), actorId);
    const taskId = randomUUID(), get = () => getAdvisorTask(store, alice, taskId);
    const answer = (task, value) => {
      const { id: questionId, field } = task.data.progress.question;
      return updateAdvisorTask(store, alice, taskId, { action: 'answer', version: task.version, step: task.step, questionId, field, value });
    };
    const resume = task => updateAdvisorTask(store, alice, taskId, { action: 'resume', version: task.version });
    let task = await reserveAdvisorTask(store, alice, { id: taskId, capabilityId: 'orders.ship-order' });
    task = await answer(task, `AN-${String(order.number).padStart(6, '0')}`);
    const stale = task;
    task = await answer(task, 'GUÍA-C3-001');
    await assert.rejects(answer(stale, 'OTRA-GUIA'), status(409));
    await assert.rejects(getAdvisorTask(store, bob, taskId), status(404));
    task = await resume(await get());
    assert.equal(task.data.progress.question.field, 'carrier');
    assert.equal(task.data.shipment.tracking, 'GUÍA-C3-001');
    assert.deepEqual(task.data.progress.known.filter(row => /por asignar/.test(row.value)).map(row => row.value), ['1 por asignar', '1 por asignar']);
    task = await answer(task, 'Transportadora C3');
    assert.equal(task.data.progress.action.focus, 'order-shipment-create');
    assert.equal(task.data.progress.action.selection.id, order.id);
    assert.deepEqual((await store.order(order.id)).shipments, []);
    order = await store.saveOrder({ ...order, addressNotes: 'Cambio concurrente sintético' }, bob.user.id, order.id, order.version);
    task = await resume(task);
    assert.equal(task.step, 'compare-order');
    assert.equal(task.data.shipment.tracking, 'GUÍA-C3-001');
    assert.equal(task.data.progress.action.focus, 'order-compare');
    task = await answer(task, String(order.version));
    assert.equal(task.step, 'review-create');
    const requestId = randomUUID(), input = { orderId: order.id, tracking: 'GUÍA-C3-001', carrier: 'Transportadora C3', requestId };
    const saved = await saveShipment(store, input, bob.user.id);
    assert.equal((await saveShipment(store, input, bob.user.id)).id, saved.id);
    task = await resume(task);
    assert.equal(task.status, 'completed');
    assert.equal(task.data.progress.proof.entityId, saved.id);
    assert.equal(task.data.progress.proof.kind, 'record');
    assert.match(task.data.progress.message, /ya consta/);
    assert.equal((await store.order(order.id)).shipments.length, 1);
  });

  await runAdvisorCashContracts(t, factory);
  await runAdvisorImportContracts(t, factory, { fixture, ready });
  await runAdvisorPreferenceContracts(t, factory, { fixture, ready });
  await runAdvisorRecommendationContracts(t, factory, { fixture, ready });
  await runAdvisorCommandContracts(t, factory);
}
