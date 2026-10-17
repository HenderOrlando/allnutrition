import { fail, text, integer } from '../validation-core.mjs';
import { businessDate, bogotaDate } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { entity, runCommand, insertRow, updateVersioned, audit, stamp, newId } from './commands.mjs';

export const ALERT_TYPES = ['shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing'];
export const RESOURCE_TABLES = Object.freeze({ people: 'people', platforms: 'platforms', sources: 'platform_sources', profiles: 'import_profiles', accounts: 'cash_accounts' });
export function businessDefaults(today = bogotaDate()) {
  return { currency: 'COP', timeZone: 'America/Bogota', setupCompleted: false, rulesVersions: [{ id: 'initial', effectiveOn: today, saleRecognition: 'delivered', commission: { enabled: false, mode: 'percent', rateBps: 0, fixedMinor: 0, basis: 'net_products', earnWhen: 'business_received' }, shippingExpenseDate: 'dispatch_date', returnExpenseDate: 'charge_date', platformFeeExpenseDate: 'charge_date' }], defaultReceiptAccountId: null, defaultPaymentAccountId: null, reportPeriods: ['day','week','month','quarter','halfyear','year'], reportGenerationTime: '06:00', reportsStartOn: today, alertDefaults: { responsibleId: null, reminderHours: 24 } };
}
export async function initializeBusinessDefaults(tx) {
  await tx.db.run(`INSERT INTO ${tx.t('counters')}(id,value) VALUES('business_revision',0) ON CONFLICT(id) DO NOTHING`);
  const now = stamp();
  await tx.db.run(`INSERT INTO ${tx.t('business_settings')}(id,data,version,created_at,updated_at) VALUES(1,?,1,?,?) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(businessDefaults()), now, now]);
  const thresholds = { shipment_label_stale: { hours: 48 }, shipment_no_update: { hours: 72 }, platform_not_updated: { hours: 24 }, settlement_overdue: { days: 7 } };
  for (const type of ALERT_TYPES) await tx.db.run(`INSERT INTO ${tx.t('alert_rules')}(id,type,enabled,version,data,created_at,updated_at) VALUES(?,?,1,1,?,?,?) ON CONFLICT(id) DO NOTHING`, [type, type, JSON.stringify({ thresholds: thresholds[type] || {}, selectedStatuses: ['incident','return_in_transit'], responsibleId: null, reminderHours: 24 }), now, now]);
}
export async function getBusinessSettings(store) { return entity(await store.db.get(`SELECT * FROM ${store.t('business_settings')} WHERE id=1`)); }
const choice = (value, allowed, label) => { if (!allowed.includes(value)) fail(`${label}: opción no válida.`); return value; };
function commission(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Comisión no válida.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('Activación de comisión no válida.');
  return { enabled: value.enabled ?? false, mode: choice(value.mode || 'percent', ['percent','fixed'], 'Comisión'), rateBps: integer(value.rateBps ?? 0, 'Porcentaje en puntos básicos', 0, 10000), fixedMinor: moneyMinor(value.fixedMinor ?? 0, 'Comisión fija'), basis: 'net_products', earnWhen: choice(value.earnWhen || 'business_received', ['delivered','customer_paid','business_received'], 'Momento de comisión') };
}
function rulesVersions(versions) {
  if (!Array.isArray(versions) || !versions.length || versions.length > 100) fail('Configura al menos una versión de reglas.');
  if (versions.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))) fail('Versión de reglas no válida.');
  const rows = versions.map(rule => ({ id: text(rule.id || newId(), 'ID de regla', 100, true), effectiveOn: businessDate(rule.effectiveOn), saleRecognition: choice(rule.saleRecognition, ['confirmed','dispatched','delivered'], 'Reconocer venta'), commission: commission(rule.commission), shippingExpenseDate: choice(rule.shippingExpenseDate || 'dispatch_date', ['charge_date','dispatch_date'], 'Fecha flete'), returnExpenseDate: choice(rule.returnExpenseDate || 'charge_date', ['charge_date','returned_date'], 'Fecha retorno'), platformFeeExpenseDate: choice(rule.platformFeeExpenseDate || 'charge_date', ['charge_date','settlement_date'], 'Fecha cargo') }));
  if (new Set(rows.map(r => r.id)).size !== rows.length || new Set(rows.map(r => r.effectiveOn)).size !== rows.length) fail('Reglas repetidas en ID o vigencia.');
  return rows.sort((a,b) => a.effectiveOn.localeCompare(b.effectiveOn));
}
export async function saveBusinessSettings(store, input, actorId) {
  return runCommand(store, { scope: 'settings', requestId: input.requestId, payload: input, actorId }, async tx => {
    const old = await getBusinessSettings(tx);
    const next = { ...businessDefaults(), ...old, ...input, currency: 'COP', timeZone: 'America/Bogota', rulesVersions: rulesVersions(input.rulesVersions || old.rulesVersions), reportsStartOn: businessDate(input.reportsStartOn || old.reportsStartOn) };
    for (const field of ['defaultReceiptAccountId','defaultPaymentAccountId']) if (next[field] && !await tx.db.get(`SELECT id FROM ${tx.t('cash_accounts')} WHERE id=? AND active=1`, [next[field]])) fail('La cuenta predeterminada no existe o está archivada.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.reportGenerationTime)) fail('Hora del informe no válida.');
    if (!Array.isArray(next.reportPeriods) || next.reportPeriods.some(p => !['day','week','month','quarter','halfyear','year'].includes(p))) fail('Periodicidad no válida.');
    next.reportPeriods = [...new Set(next.reportPeriods)];
    if (!next.reportPeriods.length) fail('Selecciona al menos una periodicidad.');
    const alertDefaults = input.alertDefaults ?? old.alertDefaults;
    if (!alertDefaults || typeof alertDefaults !== 'object' || Array.isArray(alertDefaults)) fail('Avisos generales no válidos.');
    const responsibleId = alertDefaults.responsibleId ? text(alertDefaults.responsibleId,'Responsable general',100,true) : null;
    if (responsibleId && !await tx.db.get(`SELECT id FROM ${tx.t('people')} WHERE id=? AND active=1`, [responsibleId])) fail('El responsable general no existe o está archivado.');
    next.alertDefaults = { responsibleId, reminderHours: integer(alertDefaults.reminderHours ?? 24, 'Recordatorio en horas', 1, 87600) };
    for (const field of ['setupCompleted','setupPolicyConfirmed']) {
      if (next[field] !== undefined && typeof next[field] !== 'boolean') fail('Estado de configuración no válido.');
    }
    if (next.setupCompleted) {
      const person = await tx.db.get(`SELECT id FROM ${tx.t('people')} WHERE active=1`);
      const account = await tx.db.get(`SELECT id FROM ${tx.t('cash_accounts')} WHERE active=1`);
      if (!person || !next.setupPolicyConfirmed || !account || !next.defaultReceiptAccountId || !next.defaultPaymentAccountId || !responsibleId) fail('Completa responsables, cuenta y cuentas predeterminadas, y confirma las reglas antes de finalizar.');
    }
    delete next.requestId; delete next.id; delete next.version; delete next.createdAt; delete next.updatedAt; delete next.reason; delete next.automation;
    await updateVersioned(tx, 'business_settings', 1, input.version, { data: JSON.stringify(next) });
    await audit(tx, { entityType: 'business_settings', entityId: '1', actorId, previous: old, next, reason: input.reason || 'Configuración del negocio' });
    return getBusinessSettings(tx);
  });
}
export async function listResources(store, resource, { active, source, platform } = {}) {
  const table = RESOURCE_TABLES[resource]; if (!table) fail('Recurso no encontrado.', 404);
  const where = [], values = [];
  if (active && ['people','platforms','sources','accounts'].includes(resource)) { where.push('active=1'); }
  if (source && resource === 'profiles') { where.push('source_id=?'); values.push(source); }
  if (platform && resource === 'sources') { where.push('platform_id=?'); values.push(platform); }
  return (await store.db.all(`SELECT * FROM ${store.t(table)}${where.length ? ' WHERE '+where.join(' AND ') : ''} ORDER BY name,id`, values)).map(entity);
}
export async function getResource(store, resource, id) { const table = RESOURCE_TABLES[resource]; if (!table) fail('Recurso no encontrado.',404); return entity(await store.db.get(`SELECT * FROM ${store.t(table)} WHERE id=?`, [id])); }
function salaryAgreements(input = []) {
  if (!Array.isArray(input) || input.length > 100) fail('Acuerdos de sueldo no válidos.');
  if (input.some(agreement => !agreement || typeof agreement !== 'object' || Array.isArray(agreement) || agreement.enabled !== undefined && typeof agreement.enabled !== 'boolean')) fail('Convenio de sueldo no válido.');
  const rows = input.map(a => ({ id: text(a.id || newId(), 'ID del convenio',100,true), enabled: a.enabled !== false, amountPerPeriodMinor: moneyMinor(a.amountPerPeriodMinor, 'Sueldo'), frequency: choice(a.frequency, ['weekly','halfmonthly','monthly'], 'Frecuencia'), effectiveFrom: businessDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? businessDate(a.effectiveTo) : null, payDayOffset: integer(a.payDayOffset ?? 0,'Días para pago',0,90) })).sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if(new Set(rows.map(a=>a.id)).size!==rows.length)fail('ID de convenio repetido.');
  let previousActive=null;
  for(const agreement of rows){
    if(agreement.effectiveTo&&agreement.effectiveTo<agreement.effectiveFrom)fail('Fin de convenio anterior al inicio.');
    if(!agreement.enabled)continue;
    if(previousActive&&(!previousActive.effectiveTo||previousActive.effectiveTo>=agreement.effectiveFrom))fail('Los convenios de sueldo no pueden superponerse.');
    previousActive=agreement;
  }
  return rows;
}
export async function saveResource(store, resource, input, actorId, id = null) {
  if (!['people','platforms','sources','profiles'].includes(resource)) fail('Recurso no editable aquí.',404);
  return runCommand(store, { scope: `${resource}:${id || 'new'}`, requestId: input.requestId, payload: input, actorId }, async tx => {
    const old = id ? await getResource(tx,resource,id) : null;
    if (id && !old) fail('Registro no encontrado.',404);
    const key=id || newId(), now=stamp(), name=text(input.name,'Nombre',150,true), table=RESOURCE_TABLES[resource];
    const fields = { name };
    let data={};
    if(resource!=='profiles'){
      if(input.active!=null&&typeof input.active!=='boolean')fail('Disponibilidad: valor no válido.');
      fields.active=Number(input.active??old?.active??true);
    }
    if(resource==='people') {
      const userId = input.userId === undefined ? old?.userId || null : input.userId || null;
      if (userId && !await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=?`, [text(userId,'Usuario vinculado',100,true)])) fail('El usuario vinculado no existe.');
      const overrides = input.commissionOverrides || old?.commissionOverrides || [];
      if (!Array.isArray(overrides) || overrides.length > 100) fail('Versiones de comisión no válidas.');
      if (overrides.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))) fail('Versión de comisión no válida.');
      const commissionOverrides = overrides.map(r => ({id:text(r.id || newId(),'ID',100,true),effectiveOn:businessDate(r.effectiveOn),...commission(r)}));
      if (new Set(commissionOverrides.map(r=>r.id)).size !== commissionOverrides.length || new Set(commissionOverrides.map(r=>r.effectiveOn)).size !== commissionOverrides.length) fail('Versión o vigencia de comisión repetida.');
      commissionOverrides.sort((a,b)=>a.effectiveOn.localeCompare(b.effectiveOn));
      data={ userId, salaryAgreements: salaryAgreements(input.salaryAgreements || old?.salaryAgreements || []), commissionOverrides };
      fields.data=JSON.stringify(data);
    }
    if(resource==='platforms') {
      fields.name_key=name.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ');
      if(await tx.db.get(`SELECT id FROM ${tx.t(table)} WHERE name_key=? AND id<>?`,[fields.name_key,key])) fail('Ya existe esa plataforma.',409);
    }
    if(resource==='sources') {
      fields.platform_id=text(input.platformId || old?.platformId,'Plataforma',100,true);
      if(!await getResource(tx,'platforms',fields.platform_id)) fail('Plataforma no encontrada.',404);
      if(old && old.platformId!==fields.platform_id) fail('Una fuente no puede cambiar de plataforma.',409);
      if(await tx.db.get(`SELECT id FROM ${tx.t(table)} WHERE platform_id=? AND name=? AND id<>?`,[fields.platform_id,name,key]))fail('Ya existe una cuenta de plataforma con ese nombre.',409);
    }
    if(resource==='profiles') {
      fields.source_id=text(input.sourceId || old?.sourceId,'Cuenta de plataforma',100,true);
      if(!await getResource(tx,'sources',fields.source_id)) fail('Fuente no encontrada.',404);
      if(old&&old.sourceId!==fields.source_id)fail('Un perfil no puede cambiar de cuenta de plataforma. Crea otro perfil.',409);
      const {validateImportConfig}=await import('./imports.mjs');
      fields.data=JSON.stringify(validateImportConfig(input.profile || input.data || {}));
    }
    if(id) await updateVersioned(tx,table,key,input.version,fields);
    else await insertRow(tx,table,{id:key,...fields,version:1,created_at:now,updated_at:now});
    if(resource==='platforms' && !id) await insertRow(tx,'platform_sources',{id:newId(),platform_id:key,name:'Principal',active:1,version:1,created_at:now,updated_at:now});
    const next=await getResource(tx,resource,key);
    await audit(tx,{entityType:table,entityId:key,actorId,previous:old,next,reason:input.reason || 'Guardar configuración'});
    return next;
  });
}
export async function ruleForOrder(tx, placedOn, sellerId) {
  const settings=await getBusinessSettings(tx);
  const rule=placedOn ? [...settings.rulesVersions].reverse().find(r=>r.effectiveOn<=placedOn) : null;
  if(!rule) return null;
  const result=structuredClone(rule);
  if(sellerId) {
    const person=await getResource(tx,'people',sellerId);
    if(!person) fail('Vendedor no encontrado.',404);
    const override=[...(person.commissionOverrides || [])].sort((a,b)=>b.effectiveOn.localeCompare(a.effectiveOn)).find(r=>r.effectiveOn<=placedOn);
    if(override) result.commission={...result.commission,...override};
  }
  return result;
}
