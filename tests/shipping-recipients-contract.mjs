import assert from 'node:assert/strict';
import { businessOrderInput, createBusinessBasics } from './business-fixtures.mjs';
import { getShippingRecipient, pageShippingRecipients, saveShippingRecipient } from '../lib/business/shipping-recipients.mjs';

const ACTOR = 'agenda-contrato';
const CONTACT = {
  customerName: 'Ana de la Mesa', city: 'Bogotá', department: 'Bogotá', address: 'Calle 10 %_ · Entrada principal',
  addressNotes: 'Apto 301', phone: '3001234567', email: 'ana@example.test', documentType: 'Cédula', documentNumber: '001002',
};

export async function runShippingRecipientContracts(t, factory) {
  await t.test('agenda local prioriza fichas guardadas solo cuando coincide cada campo y no modifica pedidos', async () => {
    const store = await factory();
    try {
      const { a, year } = await createBusinessBasics(store, { actorId: ACTOR, withPlatform: false });
      const addOrder = patch => store.saveOrder(businessOrderInput(a, { year, ...CONTACT, ...patch }), ACTOR);
      const primary = await addOrder({});
      await addOrder({});
      const alternate = await addOrder({ address: 'Carrera 25', addressNotes: 'Apto 303' });
      const saved = await saveShippingRecipient(store, { recipient: {
        ...CONTACT, customerName: '  ANA DE LA MESA ', city: 'BOGOTÁ', phone: '(300) 123-4567', documentType: 'CÉDULA',
      } }, ACTOR);
      assert.equal(saved.recipient.customerName, 'ANA DE LA MESA');
      assert.equal(saved.version, 1);

      const directory = await pageShippingRecipients(store);
      assert.equal(directory.total, 2);
      assert.equal(directory.page, 1);
      assert.equal(directory.pageSize, 20);
      assert.deepEqual(directory.records.map(row => row.address).sort(), [CONTACT.address, 'Carrera 25']);
      assert.ok(directory.records.every(row => row.phoneEnding === '4567'));
      for (const row of directory.records) {
        assert.match(row.id, /^[so]_[A-Za-z0-9_-]+$/);
        assert.equal(row.id.includes(CONTACT.phone), false);
        for (const key of ['documentNumber', 'email', 'phone']) assert.equal(Object.hasOwn(row, key), false);
      }
      assert.deepEqual((await pageShippingRecipients(store, { query: '%_' })).records.map(row => row.id), [saved.id]);
      assert.equal((await pageShippingRecipients(store, { query: 'BOGOTÁ' })).total, 2);
      assert.equal((await pageShippingRecipients(store, { query: '(300) 123' })).total, 2);
      assert.deepEqual((await pageShippingRecipients(store, { source: 'saved' })).records.map(row => row.id), [saved.id]);
      const orderPage = await pageShippingRecipients(store, { source: 'order' });
      assert.equal(orderPage.total, 1);
      const orderId = orderPage.records[0].id;
      const orderDetail = await getShippingRecipient(store, orderId);
      assert.deepEqual(orderDetail, { id: orderId, source: 'order', recipient: { ...CONTACT, address: 'Carrera 25', addressNotes: 'Apto 303' } });
      await assert.rejects(saveShippingRecipient(store, { recipient: CONTACT, version: 1 }, ACTOR, orderId), { status: 404 });
      await assert.rejects(getShippingRecipient(store, CONTACT.phone), { status: 404 });

      const updatedContact = { ...saved.recipient, address: 'Calle 30', addressNotes: 'Apto 505' };
      const edited = await saveShippingRecipient(store, { recipient: updatedContact, version: saved.version }, ACTOR, saved.id);
      assert.deepEqual(edited, { ...saved, version: 2, recipient: updatedContact });
      await assert.rejects(saveShippingRecipient(store, { recipient: CONTACT, version: saved.version }, ACTOR, saved.id), { status: 409 });
      assert.deepEqual(await getShippingRecipient(store, saved.id), edited);
      assert.equal((await store.order(primary.id)).address, CONTACT.address);
      assert.equal((await pageShippingRecipients(store, { source: 'order' })).total, 2);

      await store.saveOrder({ ...alternate, addressNotes: 'Apto 404' }, ACTOR, alternate.id, alternate.version);
      assert.deepEqual((await pageShippingRecipients(store, { query: 'Apto 404' })).records.map(row => row.id), [orderId]);
      assert.equal((await getShippingRecipient(store, orderId)).recipient.addressNotes, 'Apto 404');
      assert.equal((await getShippingRecipient(store, saved.id)).recipient.addressNotes, 'Apto 505');

      const audit = await store.db.all(`SELECT data FROM ${store.t('business_audit')} WHERE entity_type='shipping_recipient'`);
      assert.equal(audit.length, 2);
      for (const row of audit) {
        const { previous, next } = JSON.parse(row.data);
        assert.deepEqual(Object.keys(next), ['version']);
        assert.deepEqual(Object.keys(previous ?? {}), previous ? ['version'] : []);
      }
    } finally { await store.close(); }
  });

  await t.test('cada dato del contacto distingue fichas y la agenda pagina de forma estable', async () => {
    const store = await factory();
    try {
      const variations = [
        { customerName: 'María de la Mesa' }, { city: 'Soacha' }, { department: 'Cundinamarca' },
        { address: 'Calle 99' }, { addressNotes: 'Apto 302' }, { phone: '3001234568' },
        { email: 'otra@example.test' }, { documentType: 'Pasaporte' }, { documentNumber: '001003' },
      ];
      for (const patch of [{}, ...variations]) await saveShippingRecipient(store, { recipient: { ...CONTACT, ...patch } }, ACTOR);
      assert.equal((await pageShippingRecipients(store, { source: 'saved' })).total, 10);
      for (let n = 0; n < 12; n++) await saveShippingRecipient(store, { recipient: { ...CONTACT, addressNotes: `Interno ${n}` } }, ACTOR);
      const first = await pageShippingRecipients(store, { page: 1 }), second = await pageShippingRecipients(store, { page: 2 });
      assert.equal(first.total, 22);
      assert.equal(second.total, 22);
      assert.equal(first.records.length, 20);
      assert.equal(second.records.length, 2);
      assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 22);
      assert.deepEqual(await pageShippingRecipients(store, { page: 1 }), first);
      assert.deepEqual(await pageShippingRecipients(store, { page: 3 }), { page: 3, pageSize: 20, total: 22, records: [] });
      await assert.rejects(pageShippingRecipients(store, { source: ['saved'] }), { status: 400 });
      await assert.rejects(pageShippingRecipients(store, { page: 0 }), { status: 400 });
    } finally { await store.close(); }
  });
}
