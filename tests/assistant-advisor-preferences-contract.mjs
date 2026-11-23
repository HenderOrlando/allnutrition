import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminAreas } from '../lib/admin-view.mjs';
import { readAdvisorPreferences, writeAdvisorPreferences } from '../lib/assistant/advisor-preferences.mjs';
import { reserveAdvisorTask } from '../lib/assistant/advisor-tasks.mjs';
import { listAdvisorInbox } from '../lib/assistant/inbox.mjs';
import { seedAdvisorAlert, seedAdvisorImport } from './assistant-advisor-fixtures.mjs';

const defaults = { version: 0, focusArea: null, detail: 'guided', showAnnouncements: true };
const personal = { ...defaults, focusArea: 'cash', detail: 'brief', showAnnouncements: false };
const conflictWith = current => error => {
  assert.equal(error.status, 409);
  assert.equal(error.code, 'ASSISTANT_CONFLICT');
  assert.deepEqual(error.current, current);
  return true;
};

export async function runAdvisorPreferenceContracts(t, factory, { fixture, ready }) {
  await t.test('I5 preferencias explícitas, aisladas y accesibles sin configurar Ali', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    const preferences = store.t('assistant_advisor_preferences');
    assert.deepEqual(await readAdvisorPreferences(store, alice), defaults);
    assert.deepEqual(await readAdvisorPreferences(store, bob), defaults);
    assert.deepEqual(await store.db.all(`SELECT user_id FROM ${preferences}`), []);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('assistant_settings')} WHERE id=1`), null);

    const saved = await writeAdvisorPreferences(store, alice, personal);
    assert.deepEqual(saved, { ...personal, version: 1 });
    assert.deepEqual(await readAdvisorPreferences(store, alice), saved);
    assert.deepEqual(await readAdvisorPreferences(store, bob), defaults);
    const other = await writeAdvisorPreferences(store, bob, { ...defaults, focusArea: 'products' });
    assert.deepEqual(await readAdvisorPreferences(store, alice), saved);

    const restored = await writeAdvisorPreferences(store, alice, { ...defaults, version: saved.version });
    assert.deepEqual(restored, { ...defaults, version: 2 });
    await assert.rejects(writeAdvisorPreferences(store, alice, { ...personal, version: saved.version }), conflictWith(restored));
    assert.deepEqual(await readAdvisorPreferences(store, alice), restored);
    assert.deepEqual(await readAdvisorPreferences(store, bob), other);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('assistant_settings')} WHERE id=1`), null);

    const forged = { ...alice, user: bob.user, csrf: bob.csrf };
    for (const unauthorized of [null, forged]) {
      await assert.rejects(readAdvisorPreferences(store, unauthorized), { status: 401 });
      await assert.rejects(writeAdvisorPreferences(store, unauthorized, personal), { status: 401 });
    }
    await store.db.run(`DELETE FROM ${store.t('sessions')} WHERE token_hash=?`, [alice.sessionTokenHash]);
    await assert.rejects(readAdvisorPreferences(store, alice), { status: 401 });
    await assert.rejects(writeAdvisorPreferences(store, alice, { ...personal, version: restored.version }), { status: 401 });
    assert.deepEqual(await readAdvisorPreferences(store, bob), other);
  });

  await t.test('I5 contrato cerrado y CAS tanto al guardar por primera vez como al editar', async t => {
    const { store, alice } = await fixture(t, factory);
    const write = input => writeAdvisorPreferences(store, alice, input);
    for (const invalid of [
      null, [], { version: 0 }, { ...personal, userId: alice.user.id }, { ...personal, authorization: true },
      { ...personal, version: -1 }, { ...personal, version: '0' }, { ...personal, version: 2147483648 },
      { ...personal, focusArea: 'shipping' }, { ...personal, focusArea: 'Caja' }, { ...personal, focusArea: '' },
      { ...personal, focusArea: undefined }, { ...personal, detail: 'long' }, { ...personal, showAnnouncements: 0 },
    ]) await assert.rejects(write(invalid), { status: 422 });
    await assert.rejects(write({ ...personal, version: 1 }), conflictWith(defaults));
    assert.deepEqual(await readAdvisorPreferences(store, alice), defaults);

    async function race(version) {
      const choices = [{ ...personal, focusArea: 'orders', version }, { ...personal, focusArea: 'reports', version }];
      const results = await Promise.allSettled(choices.map(write));
      const winner = results.findIndex(result => result.status === 'fulfilled');
      assert.notEqual(winner, -1);
      const current = { ...choices[winner], version: version + 1 };
      assert.deepEqual(results[winner].value, current);
      const loser = results[1 - winner];
      assert.equal(loser.status, 'rejected');
      assert.ok(conflictWith(current)(loser.reason));
      assert.deepEqual(await readAdvisorPreferences(store, alice), current);
    }
    await race(0);
    await race(1);

    let current = await readAdvisorPreferences(store, alice);
    for (const { id } of adminAreas) {
      const version = current.version;
      current = await write({ ...current, focusArea: id });
      assert.equal(current.focusArea, id);
      assert.equal(current.version, version + 1);
    }
  });

  await t.test('I5 ocultar avisos informativos no silencia alertas ni recordatorios pedidos', async t => {
    const { store, alice, bob } = await fixture(t, factory);
    await ready(store, alice);
    const createdAt = '2026-11-19T12:00:00.000Z';
    const dueAt = '2026-11-19T13:00:00.000Z';
    const now = () => Date.parse(dueAt);
    const actorId = alice.user.id;
    const { alert } = await seedAdvisorAlert(store, { actorId, now: createdAt, title: 'Existencias sintéticas I5' });
    // La alerta nativa y el recordatorio conservan visibilidad incluso con la misma severidad que el aviso.
    await store.db.run(`UPDATE ${store.t('alerts')} SET severity='info' WHERE id=?`, [alert.id]);
    const batch = await seedAdvisorImport(store, { actorId, now: createdAt });
    const reminder = await reserveAdvisorTask(store, alice, {
      id: randomUUID(), capabilityId: 'advisor.reminder', label: 'Revisar ventas I5', dueAt,
      sourceRef: { kind: 'import', id: batch },
    }, { now: () => Date.parse(createdAt) });
    const item = (list, key) => list.items.find(card => card.key === key);
    const read = (session, summary = false) => listAdvisorInbox(store, session, { now, summary });
    const before = await read(alice);
    const keys = { alert: `alert:${alert.id}`, import: `import:${batch}`, reminder: `reminder:${reminder.id}` };
    assert.equal(item(before, keys.alert)?.severity, 'info');
    assert.equal(item(before, keys.import)?.severity, 'info');
    assert.equal(item(before, keys.reminder)?.severity, 'info');

    const { version } = await writeAdvisorPreferences(store, alice, { ...defaults, showAnnouncements: false });
    const after = await read(alice);
    assert.equal(item(after, keys.import), undefined);
    assert.deepEqual(item(after, keys.alert), item(before, keys.alert));
    assert.deepEqual(item(after, keys.reminder), item(before, keys.reminder));
    assert.equal(after.unreadCount, before.unreadCount - 1);
    assert.equal((await read(alice, true)).unreadCount, after.unreadCount);
    assert.deepEqual(await readAdvisorPreferences(store, bob), defaults);

    await writeAdvisorPreferences(store, alice, { ...defaults, version });
    assert.deepEqual(item(await read(alice), keys.import), item(before, keys.import));
  });
}
