import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../lib/db/index.mjs';
import { exportReadonlySQLite } from '../lib/sqlite-restore.mjs';
import { importData } from '../lib/import.mjs';
import { createCommercialBackupScenario, restoreCommercialBackupScenario, assertInvalidBackupsAtomic, assertLegacyPartialRestore, legacyPartialBackup } from './backup-contract.mjs';

const factory = () => openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
const checksum = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');

test('commercial v3 round trip keeps financial facts, retained Excel, revisions and queued actors without auth or leases',async () => {
  const source = await factory(), target = await factory();
  try {
    const scenario = await createCommercialBackupScenario(source);
    await restoreCommercialBackupScenario(target,scenario);
  } finally { await source.close(); await target.close(); }
});

test('invalid commercial bundles leave contents, business settings, rules and counters untouched',async () => {
  const source = await factory(), target = await factory();
  try {
    const scenario = await createCommercialBackupScenario(source);
    await assertInvalidBackupsAtomic(target,scenario.bundle);
  } finally { await source.close(); await target.close(); }
});

test('restoration preserves a v2 partial 20000 COP as 2000000 cents and never invents cash',async () => {
  const target = await factory();
  try { await assertLegacyPartialRestore(target); }
  finally { await target.close(); }
});

test('a person keeps a user link only when that identity exists locally, without replacing authentication',async () => {
  const source = await factory(), target = await factory();
  try {
    const {createAdmin} = await import('../lib/auth.mjs');
    const {saveResource} = await import('../lib/business/settings.mjs');
    await createAdmin(source,'source-user@example.test','source-password-only');
    const sourceUser = await source.db.get(`SELECT id FROM ${source.t('users')}`);
    const person = await saveResource(source,'people',{requestId:'linked-person-source',name:'Persona vinculada',userId:sourceUser.id},'backup-admin');
    const bundle = await source.exportData();
    await createAdmin(target,'local-user@example.test','local-password-only');
    await target.db.run(`UPDATE ${target.t('users')} SET id=?`,[sourceUser.id]);
    const localAuth = await target.db.get(`SELECT * FROM ${target.t('users')}`);
    await importData(target,bundle);
    assert.equal(JSON.parse((await target.db.get(`SELECT data FROM ${target.t('people')} WHERE id=?`,[person.id])).data).userId,sourceUser.id);
    assert.deepEqual(await target.db.get(`SELECT * FROM ${target.t('users')}`),localAuth);
  } finally { await source.close(); await target.close(); }
});

test('snapshot aggregates can exceed the document ceiling while individual money and integers remain bounded',async () => {
  const source = await factory(), target = await factory();
  try {
    const {saveResource} = await import('../lib/business/settings.mjs');
    const {saveAccount} = await import('../lib/business/cash.mjs');
    const {generateReportSnapshot} = await import('../lib/business/reports.mjs');
    const person = await saveResource(source,'people',{requestId:'large-report-person',name:'Responsable'},'backup-admin');
    for (let index=0;index<2;index++) await saveAccount(source,{requestId:`large-report-account-${index}`,name:`Banco ${index}`,type:'bank',openingOn:'2025-09-01',openingBalanceMinor:6000000000000,responsibleId:person.id},'backup-admin');
    const snapshot = await generateReportSnapshot(source,{period:'month',anchorDate:'2025-09-01'},'backup-admin');
    assert.equal(snapshot.metrics.cashAvailable.value,12000000000000);
    const bundle = await source.exportData(); await importData(target,bundle);
    const restored = await target.exportData();
    assert.equal(JSON.parse(restored.business.report_snapshots[0].data).metrics.cashAvailable.value,12000000000000);
    assert.deepEqual(restored.business.report_snapshots,bundle.business.report_snapshots);
  } finally { await source.close(); await target.close(); }
});

test('a commercially occupied destination cannot be overwritten even when no contents or orders exist',async () => {
  const source = await factory(), target = await factory();
  try {
    const {saveResource} = await import('../lib/business/settings.mjs');
    await saveResource(target,'people',{requestId:'destination-person',name:'Persona local'},'local-admin');
    const before = await target.exportData();
    const bundle = await source.exportData();
    await assert.rejects(() => importData(target,bundle));
    const after = await target.exportData();
    delete before.exportedAt; delete after.exportedAt;
    assert.deepEqual(after,before);
  } finally { await source.close(); await target.close(); }
});

test('external SQLite restore reads a WAL-consistent private copy without upgrading or changing the original',async () => {
  const directory = await mkdtemp(join(tmpdir(),'allnutrition-backup-test-'));
  const filename = join(directory,'original.sqlite');
  const native = new DatabaseSync(filename);
  let target;
  try {
    native.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    native.exec(await readFile(resolve('db/sqlite.sql'),'utf8'));
    const legacy = legacyPartialBackup(), product = legacy.products[0], order = legacy.orders[0];
    native.prepare('INSERT INTO settings(id,data,version) VALUES(1,?,1)').run(JSON.stringify(legacy.settings));
    const {id,version,createdAt,updatedAt,...productData} = product;
    native.prepare('INSERT INTO records(id,kind,slug,title,status,sort_order,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'products',productData.slug,productData.title,productData.status,0,JSON.stringify(productData),version,createdAt,updatedAt);
    const {id:orderId,number,version:orderVersion,createdAt:placedAt,updatedAt:changedAt,history,...data} = order;
    native.prepare('INSERT INTO orders(id,number,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(orderId,number,JSON.stringify(data),orderVersion,placedAt,changedAt);
    native.prepare('UPDATE counters SET value=? WHERE id=?').run(number,'orders');
    const mainBefore = await checksum(filename), walBefore = await checksum(`${filename}-wal`);
    const modeBefore = (await stat(filename)).mode & 0o777;
    await chmod(filename,0o400);
    const bundle = await exportReadonlySQLite(filename);
    assert.equal(bundle.format,'allnutrition-export-v3');
    assert.equal(bundle.orders[0].id,orderId,'The uncheckpointed order must be included');
    assert.equal(bundle.business.order_collections[0].amount_minor,2000000);
    assert.equal(bundle.business.cash_entries.length,0);
    assert.equal(await checksum(filename),mainBefore);
    assert.equal(await checksum(`${filename}-wal`),walBefore);
    assert.equal((await stat(filename)).mode & 0o777,0o400,'Restore must not chmod the source');
    assert.equal(native.prepare('SELECT COUNT(*) AS n FROM migrations WHERE version=3').get().n,0);
    assert.equal(native.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='business_settings'").get().n,0);
    target = await factory(); await importData(target,bundle);
    assert.equal((await target.orders())[0].totalMinor,5500000);
    await chmod(filename,modeBefore);
  } finally {
    await target?.close(); native.close(); await rm(directory,{recursive:true,force:true});
  }
});

test('a failed external SQLite copy leaves the source bytes and permissions intact',async () => {
  const directory = await mkdtemp(join(tmpdir(),'allnutrition-invalid-backup-'));
  const filename = join(directory,'invalid.sqlite');
  const {writeFile} = await import('node:fs/promises');
  try {
    await writeFile(filename,'not a sqlite database',{mode:0o400});
    const before = await checksum(filename);
    await assert.rejects(() => exportReadonlySQLite(filename));
    assert.equal(await checksum(filename),before);
    assert.equal((await stat(filename)).mode & 0o777,0o400);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('pre-inventory v3 backups receive a historical baseline without re-deducting issued physical units',async () => {
  const source = await factory(), target = await factory();
  try {
    const scenario = await createCommercialBackupScenario(source);
    const bundle = structuredClone(scenario.bundle);
    delete bundle.inventoryVersion;
    for (const product of bundle.products) delete product.stockReserved;
    for (const order of bundle.orders) delete order.inventory;
    const quantities = new Map(bundle.products.map(product => [product.id,product.stockQuantity]));
    const original = structuredClone(bundle);
    await importData(target,bundle);
    assert.deepEqual(bundle,original);
    const restored = await target.exportData();
    assert.equal(restored.inventoryVersion,1);
    for (const product of restored.products) assert.equal(product.stockQuantity,quantities.get(product.id));
    assert.deepEqual(restored.orders.map(order => order.inventory),scenario.bundle.orders.map(order => order.inventory));
    assert.deepEqual(restored.business.cash_entries,bundle.business.cash_entries);
    assert.deepEqual(restored.business.shipment_events,bundle.business.shipment_events);
    assert.deepEqual(restored.order_audit,bundle.order_audit);
  } finally { await source.close(); await target.close(); }
});

test('counted stock and pending reservations survive a new backup while public DTOs omit counts',async () => {
  const source = await factory(), target = await factory();
  try {
    await importData(source,legacyPartialBackup());
    const product = (await source.list('products'))[0];
    await source.save('products',{...product,status:'published',image:'/brand/creatina-vital-force.jpg',stockQuantity:5},product.id,product.version,'backup-admin');
    const bundle = await source.exportData();
    assert.equal(bundle.products[0].stockQuantity,5);
    assert.equal(bundle.products[0].stockReserved,1);
    assert.equal(bundle.orders[0].inventory.products[0].reserved,1);
    const inconsistent = structuredClone(bundle);
    inconsistent.products[0].stockQuantity = 0;
    await assert.rejects(() => importData(target,inconsistent),/reservas|existencia/i);
    assert.equal((await target.list('products')).length,0);
    assert.equal((await target.orders()).length,0);
    await importData(target,bundle);
    const restored = await target.exportData();
    assert.equal(restored.products[0].stockQuantity,5);
    assert.equal(restored.products[0].stockReserved,1);
    assert.deepEqual(restored.orders[0].inventory,bundle.orders[0].inventory);
    const publicData = await target.publicData();
    assert.equal(publicData.products.length,1);
    for (const record of [...publicData.products,...publicData.combos]) {
      for (const field of ['stockQuantity','stockReserved','stockAvailable','inventory']) assert.equal(Object.hasOwn(record,field),false);
    }
  } finally { await source.close(); await target.close(); }
});
