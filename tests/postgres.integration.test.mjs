import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { openPostgres } from '../lib/db/postgres.mjs';
import { databaseConfig } from '../lib/db/config.mjs';
import { runContracts } from './contract.mjs';
import { resetPostgresStore, withPostgresTestDatabase } from './postgres-fixture.mjs';
import { BUSINESS_TABLES, SOCIAL_TABLES, SOCIAL_INTERNAL_TABLES, INTEGRATION_INTERNAL_TABLES, ASSISTANT_INTERNAL_TABLES, ASSISTANT_OAUTH_INTERNAL_TABLES, ASSISTANT_WORK_INTERNAL_TABLES, migrateBusinessV3, migrateInventoryV4, migrateImportCancellationV5, migrateShippingInsuranceV6, migrateWorkbookImportV7, migrateSocialV8, migrateStockAlertsV9, migrateRuntimeIntegrationsV10, migrateAssistantV11, migrateAssistantOAuthV12, migrateAssistantWorkV13 } from '../lib/db/migrations.mjs';
import { runBusinessContracts } from './business-contract.mjs';
import { createCommercialBackupScenario,restoreCommercialBackupScenario,assertInvalidBackupsAtomic,assertLegacyPartialRestore,runSocialBackupContracts } from './backup-contract.mjs';
import { runImportCancellationContracts } from './business-import-cancellation-contract.mjs';
import { runWorkbookImportContracts } from './business-workbook-contract.mjs';
import { createBusinessFixture, returnBusinessFixture, requestId } from './business-fixtures.mjs';
import { confirmPayroll } from '../lib/business/payroll.mjs';
import { runSocialContracts } from './social-contract.mjs';
import { runSocialMediaContracts } from './social-media-contract.mjs';
import { runSocialCampaignContracts } from './social-campaign-contract.mjs';
import { runSocialApiJobContracts } from './social-api-jobs-contract.mjs';
import { runSocialBrowserJobContracts } from './social-browser-jobs-contract.mjs';
import { runSocialMetricsContracts } from './social-metrics-contract.mjs';
import { runSocialAnalysisContracts } from './social-analysis-contract.mjs';
import { runSocialLinkContracts } from './social-links-contract.mjs';
import { runSocialImprovementContracts } from './social-improvements-contract.mjs';
import { runSocialSettingsContracts } from './social-settings-contract.mjs';
import { runShippingBridgeContracts } from './shipping-bridge-contract.mjs';
import { runHekaImportContracts } from './heka-import-contract.mjs';
import { runAssistantPersistenceContracts } from './assistant-persistence.test.mjs';
import { runAssistantMigrationContracts } from './assistant-migration.test.mjs';
import { runAssistantMemoryContracts } from './assistant-memory.test.mjs';
import { runAssistantEngineContracts } from './assistant-engine-contract.mjs';
import { runAssistantActionsContracts } from './assistant-actions-contract.mjs';
import { runBusinessPayrollContracts } from './business-payroll.test.mjs';

async function dropAssistantSchema(tx) {
 for(const table of [...ASSISTANT_WORK_INTERNAL_TABLES].reverse())if((await tx.db.get('SELECT to_regclass(?) AS relation',[tx.t(table)])).relation)await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
 for(const table of [...ASSISTANT_OAUTH_INTERNAL_TABLES].reverse())if((await tx.db.get('SELECT to_regclass(?) AS relation',[tx.t(table)])).relation)await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
 for(const table of [...ASSISTANT_INTERNAL_TABLES].reverse())if((await tx.db.get('SELECT to_regclass(?) AS relation',[tx.t(table)])).relation)await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
 await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version IN (11,12,13)`);
}

async function restoreAssistantSchema(store) {
 await migrateAssistantV11(store);
 await migrateAssistantOAuthV12(store);
 await migrateAssistantWorkV13(store);
}

async function migrationRows(store,{includeInternals=false}={}) {
 const assistantTables=[...ASSISTANT_INTERNAL_TABLES,...ASSISTANT_OAUTH_INTERNAL_TABLES,...ASSISTANT_WORK_INTERNAL_TABLES];
 const internalTables=includeInternals?[...SOCIAL_TABLES,...SOCIAL_INTERNAL_TABLES,...INTEGRATION_INTERNAL_TABLES,...assistantTables]:assistantTables;
 const tables=['migrations','records','settings','users','sessions','attempts','orders','order_events','order_audit','counters','idempotency',...BUSINESS_TABLES,...internalTables];
 const result={};
 for(const table of tables) {
  if(!(await store.db.get('SELECT to_regclass(?) AS relation',[store.t(table)])).relation)continue;
  result[table]=(await store.db.all(`SELECT * FROM ${store.t(table)}`)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 }
 return result;
}

async function expenseSchema(store) {
 return {
  relation:await store.db.get("SELECT oid,relowner,relacl,reloptions,relrowsecurity FROM pg_class WHERE oid='allnutrition.expenses'::regclass"),
  indexes:await store.db.all("SELECT indexrelid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid='allnutrition.expenses'::regclass ORDER BY indexrelid"),
  constraints:await store.db.all("SELECT oid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE (conrelid='allnutrition.expenses'::regclass OR confrelid='allnutrition.expenses'::regclass) AND conname<>'expenses_category_check' ORDER BY oid"),
  category:await store.db.get("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='allnutrition.expenses'::regclass AND conname='expenses_category_check'")
 };
}

async function insertInsurance(store,fixture) {
 await store.db.run(`INSERT INTO ${store.t('expenses')}(id,category,amount_minor,incurred_on,person_id,order_id,shipment_id,source_key,version,recorded_at,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['insurance-v6','shipping_insurance',100000,'2025-09-02',fixture.person.id,fixture.orderId,fixture.shipmentId,`${fixture.shipmentId}:shipping_insurance`,1,'2025-09-05T12:00:00.000Z',JSON.stringify({datePolicy:'charge_date',source:'manual'}),'2025-09-05T12:00:00.000Z','2025-09-05T12:00:00.000Z']);
}

const url=process.env.TEST_DATABASE_URL;
test('Contrato completo con PostgreSQL real (base descartable)',{skip:!url},async t=>{
 await withPostgresTestDatabase(async env=>{
 const first=await openStore(env,{migrate:true});try{await first.db.exec(readFileSync(new URL('../db/supabase.sql',import.meta.url),'utf8'));await first.initialize();await migrateBusinessV3(first);await migrateInventoryV4(first);await migrateImportCancellationV5(first);await migrateShippingInsuranceV6(first);await migrateWorkbookImportV7(first);await migrateSocialV8(first);await migrateStockAlertsV9(first);await migrateRuntimeIntegrationsV10(first);await restoreAssistantSchema(first);assert.ok(await first.db.get(`SELECT version FROM ${first.t('migrations')} WHERE version=13`));}finally{await first.close();}
 const factory=async()=>{
  const store=await openStore(env);
  try { await resetPostgresStore(store); return store; }
  catch (error) { await store.close(); throw error; }
 };
 await t.test('una transacción posterior no confirma escrituras cuyo rollback quedó incierto',async context=>{
  const observer=await factory(),table=observer.t('transaction_timeout_'+requestId().replaceAll('-',''));
  let db,backend;
  context.after(async()=>{
   try{
    if(backend)await observer.db.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=? AND backend_start::text=? AND datname='allnutrition_test'",[backend.pid,backend.started]);
   }finally{
    try{await db?.close();}
    finally{try{await observer.db.exec({text:`DROP TABLE IF EXISTS ${table}`,query_timeout:120000});}finally{await observer.close();}}
   }
  });
  db=await openPostgres({...databaseConfig(env),max:1});
  await observer.db.exec({text:`CREATE TABLE ${table}(id INTEGER PRIMARY KEY)`,query_timeout:120000});
  backend=await db.get('SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()');
  await assert.rejects(()=>db.transaction(async tx=>{
   await tx.run(`INSERT INTO ${table}(id) VALUES(1)`);
   await tx.exec({text:'SELECT pg_sleep(300)',query_timeout:50});
  }));
  await db.transaction(async tx=>{await tx.run(`INSERT INTO ${table}(id) VALUES(2)`);});
  assert.deepEqual(await db.all(`SELECT id FROM ${table} ORDER BY id`),[{id:2}]);
 });
 await t.test('publicidad v8 conserva negocio v7, revierte DDL y exige migración al arrancar',async()=>{
  const store=await factory();
  try{
   await createBusinessFixture(store,{year:2025,pay:true});
   await store.transaction(async tx=>{
    await tx.lockWrites();
    await dropAssistantSchema(tx);
    for(const table of [...INTEGRATION_INTERNAL_TABLES].reverse())await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=10`);
    for(const table of [...SOCIAL_INTERNAL_TABLES].reverse().concat([...SOCIAL_TABLES].reverse()))await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.exec('DROP FUNCTION allnutrition.social_connection_method_guard()');
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=8`);
   });
   await assert.rejects(()=>openStore(env));
   const before=await migrationRows(store);
   const markerFailure=new Error('synthetic social marker failure');
   const failingStore={provider:store.provider,transaction:fn=>store.transaction(tx=>{
    const run=tx.db.run;
    tx.db={...tx.db,run:async(sql,params)=>{
     if(sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(8,`))throw markerFailure;
     return run(sql,params);
    }};
    return fn(tx);
   })};
   await assert.rejects(()=>migrateSocialV8(failingStore),error=>error===markerFailure);
   assert.deepEqual(await migrationRows(store),before);
   for(const table of [...SOCIAL_TABLES,...SOCIAL_INTERNAL_TABLES])assert.equal((await store.db.get('SELECT to_regclass(?) AS relation',[store.t(table)])).relation,null,table);
   assert.equal((await store.db.get("SELECT to_regprocedure('allnutrition.social_connection_method_guard()') AS routine")).routine,null);
   assert.deepEqual(await migrateSocialV8(store),{migrated:true,version:8});
   const after=await migrationRows(store);
   assert.deepEqual(after.migrations.filter(row=>row.version!==8),before.migrations);
   delete after.migrations;delete before.migrations;assert.deepEqual(after,before);
   const at='2026-10-01T00:00:00.000Z';
   await store.db.run(`INSERT INTO ${store.t('social_connections')}(id,provider,integration_method,state,created_at,updated_at) VALUES('social-connection','meta','api','connected',?,?)`,[at,at]);
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('social_connections')} SET integration_method='browser' WHERE id='social-connection'`),{code:'23514'});
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('social_connections')} SET data='invalid' WHERE id='social-connection'`));
   await store.db.run(`INSERT INTO ${store.t('social_campaigns')}(id,connection_id,name,mode,objective,state,created_at,updated_at) VALUES('social-campaign','social-connection','Campaña','organic','reach','draft',?,?)`,[at,at]);
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('social_connections')} WHERE id='social-connection'`),{code:'23503'});
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=? WHERE id='social-campaign'`,[JSON.stringify({budgetMinor:9007199254740992})]),{code:'23514'});
   await store.db.run(`INSERT INTO ${store.t('social_revisions')}(campaign_id,revision,spec_hash,approved_at,actor_id) VALUES('social-campaign',1,?,?,'actor')`,['a'.repeat(64),at]);
   const delivery=revision=>store.db.run(`INSERT INTO ${store.t('social_deliveries')}(id,campaign_id,revision,channel,state,created_at,updated_at) VALUES('social-delivery','social-campaign',?,'facebook','queued',?,?)`,[revision,at,at]);
   await assert.rejects(()=>delivery(2),{code:'23503'});
   await delivery(1);
   await assert.rejects(()=>delivery(1),{code:'23505'});
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('social_revisions')} WHERE campaign_id='social-campaign'`),{code:'23503'});
   const migrated=await migrationRows(store);
   const connection=await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id='social-connection'`);
   assert.deepEqual(await migrateSocialV8(store),{migrated:false,version:8});
   assert.deepEqual(await migrationRows(store),migrated);
   assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id='social-connection'`),connection);
  }finally{try{await migrateSocialV8(store);await migrateRuntimeIntegrationsV10(store);await restoreAssistantSchema(store);}finally{await store.close();}}
 });
 await t.test('avisos v9 amplía solo alert_rules_type_check y conserva reglas, episodios, permisos y marcadores',async()=>{
  const store=await factory();
  const schema=async()=>({
   relation:await store.db.get("SELECT oid,relowner,relacl,reloptions,relrowsecurity FROM pg_class WHERE oid='allnutrition.alert_rules'::regclass"),
   indexes:await store.db.all("SELECT indexrelid,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid='allnutrition.alert_rules'::regclass ORDER BY indexrelid"),
   constraints:await store.db.all("SELECT oid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE (conrelid='allnutrition.alert_rules'::regclass OR confrelid='allnutrition.alert_rules'::regclass) AND conname<>'alert_rules_type_check' ORDER BY oid"),
   type:await store.db.get("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='allnutrition.alert_rules'::regclass AND conname='alert_rules_type_check'"),
  });
  try{
   const fixture=await createBusinessFixture(store,{year:2025});
   await store.transaction(async tx=>{
    await tx.lockWrites();
    await dropAssistantSchema(tx);
    await tx.db.run("DELETE FROM allnutrition.alert_rules WHERE type IN ('stock_low','cash_difference')");
    await tx.db.exec("ALTER TABLE allnutrition.alert_rules DROP CONSTRAINT alert_rules_type_check; ALTER TABLE allnutrition.alert_rules ADD CONSTRAINT alert_rules_type_check CHECK(type IN ('shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing'));");
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=9`);
    await tx.db.run("UPDATE allnutrition.alert_rules SET enabled=0,version=4,data=? WHERE id='shipment_incident'",[JSON.stringify({thresholds:{},selectedStatuses:['returned'],responsibleId:fixture.person.id,reminderHours:9})]);
    await tx.db.run("INSERT INTO allnutrition.alerts(id,rule_id,entity_type,entity_id,episode,state,severity,first_seen_at,last_seen_at,data,version,created_at,updated_at) VALUES('stock-migration-kept','shipment_incident','shipment',?,1,'acknowledged','warning',?,?,'{}',3,?,?)",[fixture.shipmentId,'2025-09-02','2025-09-03','2025-09-02','2025-09-03']);
   });
   await assert.rejects(()=>openStore(env),/v9/);
   const before=await migrationRows(store),oldSchema=await schema();
   const markerFailure=new Error('synthetic stock marker failure');
   const failingStore={provider:store.provider,transaction:fn=>store.transaction(tx=>{
    const run=tx.db.run;
    tx.db={...tx.db,run:async(sql,params)=>{
     if(sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(9,`))throw markerFailure;
     return run(sql,params);
    }};
    return fn(tx);
   })};
   await assert.rejects(()=>migrateStockAlertsV9(failingStore),error=>error===markerFailure);
   assert.deepEqual(await migrationRows(store),before);assert.deepEqual(await schema(),oldSchema);
   assert.deepEqual(await migrateStockAlertsV9(store),{migrated:true,version:9});
   const after=await migrationRows(store),newSchema=await schema();
   assert.deepEqual(after.migrations.filter(row=>row.version!==9),before.migrations);
   const stock=after.alert_rules.find(row=>row.type==='stock_low');
   assert.deepEqual(JSON.parse(stock.data).thresholds,{amount:1,unit:'week'});
   assert.equal(stock.enabled,1);assert.equal(stock.version,1);
   assert.equal(after.alert_rules.some(row=>row.type==='cash_difference'),false);
   after.alert_rules=after.alert_rules.filter(row=>row.type!=='stock_low');
   delete after.migrations;delete before.migrations;
   assert.deepEqual(after,before);
   assert.match(newSchema.type.definition,/stock_low/);
   delete newSchema.type;delete oldSchema.type;assert.deepEqual(newSchema,oldSchema);
   await assert.rejects(()=>store.db.run("DELETE FROM allnutrition.alert_rules WHERE id='shipment_incident'"),{code:'23503'});
   await assert.rejects(()=>store.db.run("UPDATE allnutrition.alert_rules SET type='invented' WHERE id='stock_low'"),{code:'23514'});
   await store.db.run("UPDATE allnutrition.alert_rules SET enabled=0,version=3,data=? WHERE id='stock_low'",[JSON.stringify({thresholds:{amount:2,unit:'month'},reminderHours:7,responsibleId:fixture.person.id,selectedStatuses:[]})]);
   const migrated=await migrationRows(store);
   assert.deepEqual(await migrateStockAlertsV9(store),{migrated:false,version:9});
   assert.deepEqual(await migrationRows(store),migrated);
  }finally{try{await migrateStockAlertsV9(store);await restoreAssistantSchema(store);}finally{await store.close();}}
 });
 await t.test('integraciones v10 conserva negocio, invalida OAuth pendiente y revierte DDL con su marcador',async()=>{
  const store=await factory();
  const at='2026-10-01T00:00:00.000Z';
  let original=null,downgraded=false;
  try{
   const fixture=await createBusinessFixture(store,{year:2025,pay:true});
   original=await migrationRows(store,{includeInternals:true});
   await store.transaction(async tx=>{
    await tx.lockWrites();
    await dropAssistantSchema(tx);
    for(const table of [...INTEGRATION_INTERNAL_TABLES].reverse())await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
    await tx.db.exec(`ALTER TABLE ${tx.t('social_oauth_states')} DROP COLUMN configuration_version`);
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=10`);
    for(const [hash,consumed] of [['pending',null],['consumed',at]])await tx.db.run(`INSERT INTO ${tx.t('social_oauth_states')}(state_hash,actor_id,csrf_hash,expires_at,consumed_at) VALUES(?,?,?,?,?)`,[hash,fixture.actorId,'synthetic-csrf',at,consumed]);
   });
   downgraded=true;
   await assert.rejects(()=>openStore(env),/v10/);
   const before=await migrationRows(store),oauthBefore=await store.db.all(`SELECT * FROM ${store.t('social_oauth_states')} ORDER BY state_hash`);
   const markerFailure=new Error('synthetic integration marker failure');
   const failingStore={provider:store.provider,transaction:fn=>store.transaction(tx=>{
    const run=tx.db.run;
    tx.db={...tx.db,run:async(sql,params)=>{
     if(sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(10,`))throw markerFailure;
     return run(sql,params);
    }};
    return fn(tx);
   })};
   await assert.rejects(()=>migrateRuntimeIntegrationsV10(failingStore),error=>error===markerFailure);
   assert.deepEqual(await migrationRows(store),before);
   assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_oauth_states')} ORDER BY state_hash`),oauthBefore);
   for(const table of INTEGRATION_INTERNAL_TABLES)assert.equal((await store.db.get('SELECT to_regclass(?) AS relation',[store.t(table)])).relation,null,table);
   assert.deepEqual(await migrateRuntimeIntegrationsV10(store),{migrated:true,version:10});
   const after=await migrationRows(store);
   assert.deepEqual(after.migrations.filter(row=>row.version!==10),before.migrations);
   delete after.migrations;delete before.migrations;assert.deepEqual(after,before);
   assert.deepEqual(await store.db.all(`SELECT * FROM ${store.t('social_oauth_states')} ORDER BY state_hash`),[{...oauthBefore.find(row=>row.state_hash==='consumed'),configuration_version:0}]);
   assert.equal((await store.db.get(`SELECT COUNT(*) AS n FROM ${store.t('social_integration_settings')}`)).n,0);
   await store.db.run(`INSERT INTO ${store.t('social_integration_settings')}(id,actor_id,created_at,updated_at) VALUES(1,?,?,?)`,[fixture.actorId,at,at]);
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('social_integration_settings')} SET app_secret_iv='incomplete'`),{code:'23514'});
   const connection=(id,source)=>store.db.run(`INSERT INTO ${store.t('shipping_connections')}(id,source_id,actor_id,state,identity_fingerprint,created_at,updated_at) VALUES(?,?,?,'connected',?,?,?)`,[id,source,fixture.actorId,id,at,at]);
   await connection('shipping-connection',fixture.source.id);
   await assert.rejects(()=>connection('duplicate-source',fixture.source.id),{code:'23505'});
   await assert.rejects(()=>connection('missing-source','absent-source'),{code:'23503'});
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('shipping_connections')} SET epoch=0`),{code:'23514'});
   await store.db.run(`INSERT INTO ${store.t('shipping_pairings')}(hash,connection_id,epoch,actor_id,expires_at) VALUES('synthetic-pairing','shipping-connection',1,?,?)`,[fixture.actorId,at]);
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('shipping_connections')} WHERE id='shipping-connection'`),{code:'23503'});
   const migrated=await migrationRows(store),connectionBefore=await store.db.get(`SELECT * FROM ${store.t('shipping_connections')}`);
   assert.deepEqual(await migrateRuntimeIntegrationsV10(store),{migrated:false,version:10});
   assert.deepEqual(await migrationRows(store),migrated);
   assert.deepEqual(await store.db.get(`SELECT * FROM ${store.t('shipping_connections')}`),connectionBefore);
  }finally{
   try{
    if(downgraded){
     // Remove every synthetic v10/v11 row before rebuilding and comparing the original snapshot.
     await store.transaction(async tx=>{
      await tx.lockWrites();
      await tx.db.run(`DELETE FROM ${tx.t('social_oauth_states')}`);
      await dropAssistantSchema(tx);
      for(const table of [...INTEGRATION_INTERNAL_TABLES].reverse())if((await tx.db.get('SELECT to_regclass(?) AS relation',[tx.t(table)])).relation)await tx.db.exec(`DROP TABLE ${tx.t(table)}`);
      await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=10`);
      if(await tx.db.get("SELECT 1 FROM information_schema.columns WHERE table_schema='allnutrition' AND table_name='social_oauth_states' AND column_name='configuration_version'"))await tx.db.exec(`ALTER TABLE ${tx.t('social_oauth_states')} DROP COLUMN configuration_version`);
     });
     await migrateRuntimeIntegrationsV10(store);
     await restoreAssistantSchema(store);
     for(const marker of original.migrations.filter(row=>[10,11,12,13].includes(row.version)))await store.db.run(`UPDATE ${store.t('migrations')} SET applied_at=? WHERE version=?`,[marker.applied_at,marker.version]);
     assert.deepEqual(await migrationRows(store,{includeInternals:true}),original);
    }else{
     await migrateRuntimeIntegrationsV10(store);
     await restoreAssistantSchema(store);
    }
   }finally{await store.close();}
  }
 });
 await t.test('seguro v6 migra el CHECK v5 real, revierte fallos y conserva ownership, permisos y relaciones',async()=>{
  // The factory verifies the connected database is the explicitly authorized allnutrition_test.
  const store=await factory();
  try{
   await store.transaction(async tx=>{
    await tx.lockWrites();
    await dropAssistantSchema(tx);
    await tx.db.exec("ALTER TABLE allnutrition.expenses DROP CONSTRAINT expenses_category_check; ALTER TABLE allnutrition.expenses ADD CONSTRAINT expenses_category_check CHECK(category IN ('shipping_out','shipping_return','platform_fee','commission','salary','bonus','other'));");
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version IN (6,7)`);
   });
   await assert.rejects(()=>openStore(env));
   const fixture=await createBusinessFixture(store,{year:2025,pay:true});
   await returnBusinessFixture(store,fixture,{refund:true});
   await confirmPayroll(store,{requestId:requestId(),personId:fixture.person.id,startOn:'2025-10-01',endOnExclusive:'2025-11-01',bonusMinor:1000000,discountMinor:0,reason:'Aplicar crédito histórico antes de migrar'},fixture.actorId);
   for(const table of ['expense_payments','settlement_receipts','payroll_allocations','payroll_offsets','commission_entries']){
    assert.ok((await store.db.all(`SELECT id FROM ${store.t(table)}`)).length,`La fixture v5 debe contener ${table}`);
   }
   const payments=await store.db.all(`SELECT * FROM ${store.t('expense_payments')}`);
   assert.ok(payments.some(row=>row.cash_entry_id));assert.ok(payments.some(row=>row.settlement_receipt_id));
   await assert.rejects(()=>insertInsurance(store,fixture),{code:'23514'});
   const before=await migrationRows(store),schema=await expenseSchema(store);
   const failingStore={provider:store.provider,transaction:fn=>store.transaction(tx=>{
    const run=tx.db.run;
    tx.db={...tx.db,run:async(sql,params)=>{
     if(sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(6,`))throw new Error('Fallo sintético al guardar marcador v6');
     return run(sql,params);
    }};
    return fn(tx);
   })};
   await assert.rejects(()=>migrateShippingInsuranceV6(failingStore),/Fallo sintético al guardar marcador v6/);
   assert.deepEqual(await migrationRows(store),before);assert.deepEqual(await expenseSchema(store),schema);
   await assert.rejects(()=>insertInsurance(store,fixture),{code:'23514'});
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('expenses')} WHERE id=?`,[fixture.shippingExpenseId]),{code:'23503'});
   assert.deepEqual(await migrateShippingInsuranceV6(store),{migrated:true,version:6});
   const after=await migrationRows(store),nextSchema=await expenseSchema(store);
   assert.deepEqual(after.migrations.filter(row=>row.version!==6),before.migrations);
   assert.equal(after.migrations.filter(row=>row.version===6).length,1);
   delete after.migrations;delete before.migrations;assert.deepEqual(after,before);
   assert.deepEqual(nextSchema.relation,schema.relation);assert.deepEqual(nextSchema.indexes,schema.indexes);assert.deepEqual(nextSchema.constraints,schema.constraints);
   await insertInsurance(store,fixture);
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('expenses')} SET category='invalid' WHERE id='insurance-v6'`),{code:'23514'});
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('expenses')} WHERE id=?`,[fixture.shippingExpenseId]),{code:'23503'});
   const migrated=await migrationRows(store),migratedSchema=await expenseSchema(store);
   assert.deepEqual(await migrateShippingInsuranceV6(store),{migrated:false,version:6});
   assert.deepEqual(await migrationRows(store),migrated);assert.deepEqual(await expenseSchema(store),migratedSchema);
  }finally{
   try{await migrateShippingInsuranceV6(store);await migrateWorkbookImportV7(store);await restoreAssistantSchema(store);}finally{await store.close();}
  }
 });
 await runContracts(t,factory);await runBusinessContracts(t,factory);
 await runBusinessPayrollContracts(t,factory);
 await runImportCancellationContracts(t,factory);
 await runWorkbookImportContracts(t,factory);
 await runSocialContracts(t,factory);
 await runSocialSettingsContracts(t,factory);
 await runSocialMediaContracts(t,factory);
 await runSocialCampaignContracts(t,factory);
 await runSocialApiJobContracts(t,factory);
 await runSocialBrowserJobContracts(t,factory);
 await runSocialMetricsContracts(t,factory);
 await runSocialAnalysisContracts(t,factory);
 await runSocialLinkContracts(t,factory);
 await runSocialImprovementContracts(t,factory);
 await runSocialBackupContracts(t,factory);
 await runShippingBridgeContracts(t,factory);
 await runHekaImportContracts(t,factory);
 await runAssistantMigrationContracts(t,factory,{openRuntime:()=>openStore(env)});
 await runAssistantPersistenceContracts(t,factory,{openPeer:()=>openStore(env)});
 await runAssistantMemoryContracts(t);
 await runAssistantActionsContracts(t,factory);
 await t.test('motor conversacional de Ali con PostgreSQL',async context=>{
  const store=await factory();
  try{await runAssistantEngineContracts(context,store);}finally{await store.close();}
 });
 await t.test('libro v7 conserva pagos, ownership, índices y FK y revierte el CHECK al fallar el marcador',async()=>{
  const store=await factory();
  try{
   const fixture=await createBusinessFixture(store,{year:2025,pay:true});
   await returnBusinessFixture(store,fixture,{refund:true});
   await store.transaction(async tx=>{
    await tx.lockWrites();
    await dropAssistantSchema(tx);
    await tx.db.exec("ALTER TABLE allnutrition.expenses DROP CONSTRAINT expenses_category_check; ALTER TABLE allnutrition.expenses ADD CONSTRAINT expenses_category_check CHECK(category IN ('shipping_out','shipping_return','platform_fee','shipping_insurance','commission','salary','bonus','other'));");
    await tx.db.run(`DELETE FROM ${tx.t('migrations')} WHERE version=7`);
   });
   const insert=category=>store.db.run(`INSERT INTO ${store.t('expenses')}(id,category,amount_minor,incurred_on,source_key,recorded_at,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,[`v7-${category}`,category,0,'2025-09-02',`excel-expense:${category}`,'2025-10-01T05:00:00.000Z','{}','2025-10-01T05:00:00.000Z','2025-10-01T05:00:00.000Z']);
   for(const category of ['advertising','operating'])await assert.rejects(()=>insert(category),{code:'23514'});
   const before=await migrationRows(store),schema=await expenseSchema(store);
   const failingStore={provider:store.provider,transaction:fn=>store.transaction(tx=>{
    const run=tx.db.run;
    tx.db={...tx.db,run:async(sql,params)=>{
     if(sql.startsWith(`INSERT INTO ${tx.t('migrations')}(version,applied_at) VALUES(7,`))throw new Error('Fallo sintético al guardar marcador v7');
     return run(sql,params);
    }};
    return fn(tx);
   })};
   await assert.rejects(()=>migrateWorkbookImportV7(failingStore),/Fallo sintético al guardar marcador v7/);
   assert.deepEqual(await migrationRows(store),before);assert.deepEqual(await expenseSchema(store),schema);
   await assert.rejects(()=>insert('advertising'),{code:'23514'});
   await assert.rejects(()=>store.db.run(`DELETE FROM ${store.t('expenses')} WHERE id=?`,[fixture.shippingExpenseId]),{code:'23503'});
   assert.deepEqual(await migrateWorkbookImportV7(store),{migrated:true,version:7});
   const after=await migrationRows(store),nextSchema=await expenseSchema(store);
   assert.deepEqual(after.migrations.filter(row=>row.version!==7),before.migrations);
   delete after.migrations;delete before.migrations;assert.deepEqual(after,before);
   assert.deepEqual(nextSchema.relation,schema.relation);assert.deepEqual(nextSchema.indexes,schema.indexes);assert.deepEqual(nextSchema.constraints,schema.constraints);
   for(const category of ['advertising','operating'])await insert(category);
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('expenses')} SET category='invalid' WHERE id='v7-operating'`),{code:'23514'});
   await assert.rejects(()=>store.db.run(`UPDATE ${store.t('expenses')} SET source_key='excel-expense:advertising' WHERE id='v7-operating'`),{code:'23505'});
   const migrated=await migrationRows(store),migratedSchema=await expenseSchema(store);
   assert.deepEqual(await migrateWorkbookImportV7(store),{migrated:false,version:7});
   assert.deepEqual(await migrationRows(store),migrated);assert.deepEqual(await expenseSchema(store),migratedSchema);
  }finally{try{await migrateWorkbookImportV7(store);await restoreAssistantSchema(store);}finally{await store.close();}}
 });
 await t.test('restaura negocio SQLite en PostgreSQL y reanuda trabajo con el actor original',async()=>{
  const source=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  let target;
  try{const scenario=await createCommercialBackupScenario(source);target=await factory();await restoreCommercialBackupScenario(target,scenario);}
  finally{await source.close();await target?.close();}
 });
 await t.test('restaura negocio PostgreSQL en SQLite sin secretos ni diferencias monetarias',async()=>{
  const source=await factory(),target=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try{await restoreCommercialBackupScenario(target,await createCommercialBackupScenario(source));}
  finally{await source.close();await target.close();}
 });
 await t.test('respaldo inválido revierte configuración y negocio completos en PostgreSQL',async()=>{
  const source=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  let target;
  try{const scenario=await createCommercialBackupScenario(source);target=await factory();await assertInvalidBackupsAtomic(target,scenario.bundle);}
  finally{await source.close();await target?.close();}
 });
 await t.test('restauración histórica en PostgreSQL conserva abono de 20000 COP sin inventar caja',async()=>{
  const target=await factory();
  try{await assertLegacyPartialRestore(target);}finally{await target.close();}
 });
 });
});
