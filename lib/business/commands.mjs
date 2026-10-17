import { createHash, randomUUID } from 'node:crypto';
import { fail, text, integer } from '../validation-core.mjs';

export function canonicalJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  fail('Datos del comando no válidos.');
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJSON(value)).digest('hex');
export const stamp = () => new Date().toISOString();
export const newId = () => randomUUID();
export function entity(row) {
  if (!row) return null;
  const result = row.data ? JSON.parse(row.data) : {};
  for (const [key, value] of Object.entries(row)) if (key !== 'data') result[key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  if (Object.hasOwn(result, 'active')) result.active = Boolean(result.active);
  if (Object.hasOwn(result, 'enabled')) result.enabled = Boolean(result.enabled);
  return result;
}
// Table/column names below are code-owned literals, never HTTP input.
export async function insertRow(tx, table, row) {
  const names = Object.keys(row);
  await tx.db.run(`INSERT INTO ${tx.t(table)}(${names.map(n => '"' + n + '"').join(',')}) VALUES(${names.map(() => '?').join(',')})`, names.map(n => row[n]));
  return row;
}
export async function updateVersioned(tx, table, id, version, fields) {
  integer(version, 'Versión', 1);
  const names = Object.keys(fields);
  const result = await tx.db.run(`UPDATE ${tx.t(table)} SET ${names.map(n => '"' + n + '"=?').join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`, [...names.map(n => fields[n]), stamp(), id, version]);
  if (!result.changes) fail('El registro cambió en otra sesión. Recarga antes de guardar.', 409);
}
export async function audit(tx, { entityType, entityId, actorId, previous = null, next = null, reason = '', source = 'manual', recordedAt = stamp() }) {
  await insertRow(tx, 'business_audit', { id: newId(), entity_type: entityType, entity_id: entityId, actor_id: actorId, recorded_at: recordedAt, data: JSON.stringify({ previous, next, reason, source }) });
}
export async function bumpRevision(tx, affectedDates = null) {
  await tx.db.run(`UPDATE ${tx.t('counters')} SET value=value+1 WHERE id='business_revision'`);
  if (affectedDates?.length) {
    for (const date of new Set(affectedDates.filter(Boolean))) await tx.db.run(`UPDATE ${tx.t('report_snapshots')} SET state='stale',stale_since=COALESCE(stale_since,?) WHERE state='current' AND start_on<=? AND end_on_exclusive>?`, [stamp(), date, date]);
  } else {
    await tx.db.run(`UPDATE ${tx.t('report_snapshots')} SET state='stale',stale_since=COALESCE(stale_since,?) WHERE state='current'`, [stamp()]);
  }
}
export async function runCommand(store, { scope, requestId, payload, actorId, lease = null, affectsIndicators = true }, fn) {
  const leaseOrigin=lease?Date.parse(lease.now||stamp()):null,leaseStarted=Date.now();
  const verifyLease=tx=>assertLease(tx,{...lease,now:new Date(leaseOrigin+Date.now()-leaseStarted).toISOString()});
  scope = text(scope, 'Operación', 200, true); requestId = text(requestId, 'Identificador de operación', 100, true); actorId = text(actorId, 'Administrador', 100, true);
  if (!/^[\w:-]{8,100}$/.test(requestId)) fail('Identificador de operación no válido.');
  const payloadHash = hash(payload);
  return store.transaction(async tx => {
    await tx.lockWrites();
    if (lease) await verifyLease(tx);
    const prior = await tx.db.get(`SELECT * FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, requestId]);
    if (prior) {
      if (prior.actor_id !== actorId || prior.payload_hash !== payloadHash) fail('La operación ya se recibió con otro administrador o datos distintos.', 409);
      return JSON.parse(prior.result_json);
    }
    const result = await fn(tx);
    if (lease) await verifyLease(tx);
    if (affectsIndicators) await bumpRevision(tx);
    await insertRow(tx, 'business_requests', { scope, request_id: requestId, actor_id: actorId, payload_hash: payloadHash, result_json: JSON.stringify(result), created_at: stamp() });
    if (lease) await verifyLease(tx);
    return result;
  });
}
export async function assertLease(tx, { key, token, now = stamp() }) {
  const lease = await tx.db.get(`SELECT state,lease_token,lease_until FROM ${tx.t('job_runs')} WHERE key=?`, [key]);
  if (!lease || lease.state !== 'running' || lease.lease_token !== token || lease.lease_until <= now) fail('El trabajo fue tomado por otro proceso.', 409);
}
