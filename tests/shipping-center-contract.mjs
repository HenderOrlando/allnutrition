import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runShippingGuideContracts } from './shipping-guides-contract.mjs';
import { runShippingRecipientContracts } from './shipping-recipients-contract.mjs';
import { runShippingPreparationContracts } from './shipping-preparations-contract.mjs';
import { runShippingQuoteContracts } from './shipping-quotes-contract.mjs';
import { runShippingNoveltiesContracts } from './shipping-novelties-contract.mjs';
import { runShippingPushContracts } from './shipping-push-contract.mjs';
import { runShippingFinanceContracts } from './shipping-finance-contract.mjs';
import { migrateHekaWebhookV19, migrateShippingCenterV18, SHIPPING_COMMERCIAL_TABLES, SHIPPING_INTERNAL_TABLES } from '../lib/db/migrations.mjs';
import { saveShippingRecipient } from '../lib/business/shipping-recipients.mjs';
import { saveShippingPreparation } from '../lib/business/shipping-preparations.mjs';
import { insertRow } from '../lib/business/commands.mjs';
import { initializeBusinessDefaults } from '../lib/business/settings.mjs';
import { importData } from '../lib/import.mjs';
import { adminHref, adminReturnTo } from '../lib/admin-view.mjs';

export async function runShippingCenterContracts(t,factory,openRuntime) {
  await t.test('v17 exporta, v18 y v19 migran una vez y el respaldo restaura solo hechos comerciales',async t=>{
    let store=await factory();
    t.after(()=>store.close());
    await initializeBusinessDefaults(store);
    const item=await store.save('products',{title:'Referencia de prueba',slug:'referencia-de-prueba',status:'draft',packedWeightG:375});
    await store.transaction(async tx=>{
      await tx.lockWrites();
      for (const table of [...SHIPPING_COMMERCIAL_TABLES,...SHIPPING_INTERNAL_TABLES].reverse()) await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
      for (const column of ['webhook_ciphertext','webhook_iv','webhook_auth_tag','webhook_revision','webhook_generation']) {
        await tx.db.exec(`ALTER TABLE ${tx.t('heka_api_settings')} DROP COLUMN ${column}`);
      }
      await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version IN (18,19)`);
    });
    let historical, current;
    try {
      if(openRuntime)await assert.rejects(openRuntime,/Centro de envíos v18/);
      historical=await store.exportData();
      assert.equal(historical.shippingVersion,undefined);
      assert.ok(SHIPPING_COMMERCIAL_TABLES.every(table=>!Object.hasOwn(historical.business,table)));
      assert.deepEqual(await migrateShippingCenterV18(store),{migrated:true,version:18});
      assert.deepEqual(await migrateShippingCenterV18(store),{migrated:false,version:18});
      if(openRuntime)await assert.rejects(openRuntime,/webhook Heka v19/);
      assert.deepEqual(await migrateHekaWebhookV19(store),{migrated:true,version:19});
      assert.deepEqual(await migrateHekaWebhookV19(store),{migrated:false,version:19});
      assert.equal((await store.get('products',item.id)).packedWeightG,375);
      const id=randomUUID(), at='2026-01-01T00:00:00.000Z';
      await insertRow(store,'users',{id,email:`${id}@example.test`,password:'unused',active:1});
      const recipient={customerName:'Contacto sintético',city:'Bogotá',department:'Cundinamarca',address:'Dirección sintética',phone:'3000000000'};
      await saveShippingRecipient(store,{recipient},id);
      await saveShippingPreparation(store,{requestId:randomUUID(),recipient,parcel:{weightG:400},lines:[{kind:'products',itemId:item.id,quantity:1}]},id);
      await insertRow(store,'shipping_push_vapid',{id:1,public_key:'vapid-public-fixture',ciphertext:'vapid-do-not-export',iv:'fixture',auth_tag:'fixture',created_at:at});
      current=await store.exportData();
      assert.equal(current.shippingVersion,1);
      assert.ok(!JSON.stringify(current).includes('vapid-do-not-export'));
    } finally {
      await migrateShippingCenterV18(store);
      await migrateHekaWebhookV19(store);
    }
    async function fresh() {await store.close();store=await factory();}
    await fresh();
    await importData(store,historical);
    assert.deepEqual((await store.exportData()).business.shipping_preparations,[]);
    await fresh();
    await assert.rejects(importData(store,{...current,shipping_push_vapid:[{ciphertext:'not portable'}]}),/datos internos/);
    await assert.rejects(importData(store,{...current,shipping_guide_observations:[{guide_id:'not portable'}]}),/datos internos/);
    await assert.rejects(importData(store,{...current,shippingVersion:2}),/Versión del Centro/);
    await importData(store,current);
    const restored=await store.exportData();
    for (const table of SHIPPING_COMMERCIAL_TABLES) assert.deepEqual(restored.business[table],current.business[table]);
    assert.equal(restored.products.find(product=>product.id===item.id).packedWeightG,375);
    assert.equal(await store.db.get(`SELECT id FROM ${store.t('shipping_push_vapid')}`),null);
  });
  await t.test('los destinos de login solo conservan paneles conocidos e IDs locales pertinentes',()=>{
    const id=randomUUID();
    assert.equal(adminReturnTo(`/admin?section=orders&tab=heka&panel=freight&orderId=${id}&address=privada&phone=3000000000`),adminHref({section:'orders',tab:'heka',panel:'freight',orderId:id}));
    assert.equal(adminReturnTo(`/admin?section=orders&tab=heka&panel=novelties&orderId=${id}&preparationId=leaked`),'/admin?section=orders&tab=heka&panel=novelties');
    assert.equal(adminReturnTo(`/admin?section=orders&tab=heka&panel=desconocido&shipmentId=${id}`),'/admin?section=orders&tab=heka');
  });
  for (const run of [runShippingGuideContracts,runShippingRecipientContracts,runShippingPreparationContracts,runShippingQuoteContracts,runShippingNoveltiesContracts,runShippingPushContracts,runShippingFinanceContracts]) await run(t,factory);
}
