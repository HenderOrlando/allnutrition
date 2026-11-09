import { randomBytes } from 'node:crypto';
import { fail, integer, text } from '../validation-core.mjs';
import { instant } from './dates.mjs';
import { assertLease, hash, insertRow, newId, runCommand, stamp } from './commands.mjs';
import { claimJob, finishJob, jobClock, queueJobTx, renewJob } from './job-leases.mjs';
import { HEKA_ADAPTER_VERSION, normalizeHekaIdentity, normalizeHekaQuery, normalizeHekaSnapshot } from '../shipping/heka.mjs';

const READ_MS = 300000, QUEUE_MS = 1800000, SNAPSHOT_MS = 7 * 86400000;
const ERROR_CODES = new Set(['login_required', 'challenge_required', 'contract_changed', 'incomplete', 'limit_exceeded', 'timeout', 'provider_error', 'account_mismatch']);
const after = (now, ms) => new Date(Date.parse(now) + ms).toISOString();
const dataOf = row => JSON.parse(row.data);
const identityOf = value => value ? JSON.parse(value) : null;
const clockFor = options => jobClock(instant(options.now || stamp()));
const inTransaction = tx => ({ transaction: fn => fn(tx) });
const jobKey = (connectionId, queryId) => `shipping:${connectionId}:${queryId}`;
const deviceIdOf = value => {
  const id = text(value, 'Dispositivo', 100, true);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) fail('Dispositivo no válido.');
  return id;
};
async function actorTx(tx, actorId) {
  if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
}
async function sourceTx(tx, sourceId) {
  const row = await tx.db.get(`SELECT s.*,p.name AS platform_name,p.active AS platform_active FROM ${tx.t('platform_sources')} s JOIN ${tx.t('platforms')} p ON p.id=s.platform_id WHERE s.id=?`, [sourceId]);
  if (!row || !row.active || !row.platform_active) fail('La fuente comercial no está activa.', 403);
  return row;
}
async function connectionTx(tx, id, { allowRevoked = false } = {}) {
  const row = await tx.db.get(`SELECT * FROM ${tx.t('shipping_connections')} WHERE id=?`, [text(id, 'Conexión', 100, true)]);
  if (!row) fail('Conexión no encontrada.', 404);
  await actorTx(tx, row.actor_id);
  const source = await sourceTx(tx, row.source_id);
  if (!allowRevoked && row.state === 'revoked') fail('La conexión fue revocada.', 403);
  return { row, source };
}
function connectionDTO(row, source, now, deviceId = null) {
  const candidateIdentity = identityOf(row.candidate_identity), confirmedIdentity = identityOf(row.confirmed_identity);
  return { id: row.id, connectionId: row.id, sourceId: row.source_id, sourceName: source.name, platformId: source.platform_id, platformName: source.platform_name,
    provider: row.provider, version: row.version, epoch: row.epoch, state: row.state, candidateIdentity, confirmedIdentity,
    identityFingerprint: candidateIdentity ? hash(candidateIdentity) : row.identity_fingerprint, lastSeenAt: row.last_seen_at,
    deviceStatus: row.last_seen_at && Date.parse(now) - Date.parse(row.last_seen_at) <= 60000 && row.state !== 'revoked' && deviceId ? 'connected' : 'disconnected', deviceId };
}
async function dtoTx(tx, id, now) {
  const { row, source } = await connectionTx(tx, id, { allowRevoked: true });
  const credential = await tx.db.get(`SELECT device_id FROM ${tx.t('shipping_bridge_credentials')} WHERE connection_id=? AND epoch=? AND revoked_at IS NULL`, [id, row.epoch]);
  await expireJobsTx(tx, id, now);
  const latest = await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key LIKE ? ESCAPE '!' ORDER BY created_at DESC,key DESC LIMIT 1`, [`shipping:${id.replace(/[!%_]/g, c => '!' + c)}:%`]);
  const snapshot = await tx.db.get(`SELECT id FROM ${tx.t('shipping_snapshots')} WHERE connection_id=? AND expires_at>? ORDER BY captured_at DESC,id DESC LIMIT 1`, [id, now]);
  return { ...connectionDTO(row, source, now, credential?.device_id || null), latestQuery: latest ? progress(latest) : null, latestSnapshotId: snapshot?.id || null };
}
function versionOf(row, input) {
  if (integer(input.version, 'Versión', 1) !== row.version) fail('La conexión cambió. Recarga antes de continuar.', 409);
}
async function changeTx(tx, id, fields, now) {
  const keys = Object.keys(fields);
  await tx.db.run(`UPDATE ${tx.t('shipping_connections')} SET ${keys.map(k => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=?`, [...keys.map(k => fields[k]), now, id]);
}
async function touchTx(tx, id, now) {
  await tx.db.run(`UPDATE ${tx.t('shipping_connections')} SET last_seen_at=?,updated_at=? WHERE id=?`, [now, now, id]);
}
function adminCommand(store, { scope, input, actorId, connectionId = null, sourceId = null, clock }, fn) {
  const authorized = { transaction: fn => store.transaction(async tx => {
    await tx.lockWrites(); await actorTx(tx, actorId);
    if (connectionId) {
      const { row } = await connectionTx(tx, connectionId, { allowRevoked: !scope.startsWith('shipping:query:') && !scope.startsWith('shipping:identity:') });
      if (scope.startsWith('shipping:query:')) {
        const prior = await tx.db.get(`SELECT result_json FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [scope, input.requestId]);
        if (prior) {
          const job = await queryTx(tx, JSON.parse(prior.result_json).queryId, connectionId), data = dataOf(job);
          await actorTx(tx, data.actorId);
          const device = await tx.db.get(`SELECT device_id FROM ${tx.t('shipping_bridge_credentials')} WHERE connection_id=? AND epoch=? AND revoked_at IS NULL`, [connectionId, row.epoch]);
          if (data.epoch !== row.epoch || device?.device_id !== data.deviceId) fail('La consulta pertenece a un emparejamiento anterior.', 409);
        }
      }
    }
    if (sourceId) await sourceTx(tx, sourceId);
    return fn(tx);
  }) };
  return runCommand(authorized, { scope, requestId: input.requestId, payload: input, actorId, affectsIndicators: false }, tx => fn(tx, clock()));
}
async function revokeCustodyTx(tx, row, now) {
  await tx.db.run(`UPDATE ${tx.t('shipping_bridge_credentials')} SET revoked_at=? WHERE connection_id=? AND revoked_at IS NULL`, [now, row.id]);
  await tx.db.run(`UPDATE ${tx.t('shipping_pairings')} SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL`, [now, row.id]);
  const jobs = await jobsTx(tx, row.id);
  for (const job of jobs) if (['queued', 'running'].includes(job.state)) await failJobTx(tx, job, 'revoked', now);
}
async function authenticateTx(tx, input, auth, now) {
  const deviceId = deviceIdOf(input.deviceId);
  const bearer = text(auth?.bearer, 'Credencial del dispositivo', 100, true);
  if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) fail('Credencial del dispositivo no válida.', 401);
  const credential = await tx.db.get(`SELECT * FROM ${tx.t('shipping_bridge_credentials')} WHERE device_id=? AND bearer_hash=? AND revoked_at IS NULL`, [deviceId, hash(bearer)]);
  if (!credential) fail('El dispositivo no está autorizado.', 401);
  const bound = await connectionTx(tx, credential.connection_id);
  if (credential.epoch !== bound.row.epoch) fail('El dispositivo fue revocado.', 403);
  await touchTx(tx, bound.row.id, now);
  return { ...bound, credential, deviceId };
}
async function locked(store, options, fn) {
  const clock = clockFor(options);
  return store.transaction(async tx => { await tx.lockWrites(); return fn(tx, clock); });
}
async function jobsTx(tx, connectionId) {
  return tx.db.all(`SELECT * FROM ${tx.t('job_runs')} WHERE key LIKE ? ESCAPE '!' AND state IN ('queued','running') ORDER BY created_at,key`, [`shipping:${connectionId.replace(/[!%_]/g, c => '!' + c)}:%`]);
}
async function failJobTx(tx, row, code, now) {
  await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL,error_code=?,finished_at=?,updated_at=?,version=version+1 WHERE key=?`, [code, now, now, row.key]);
}
async function expireJobsTx(tx, connectionId, now) {
  const jobs = await jobsTx(tx, connectionId);
  for (const row of jobs) {
    if ((row.state === 'queued' && after(row.created_at, QUEUE_MS) <= now) ||
      (row.state === 'running' && row.started_at && after(row.started_at, READ_MS) <= now)) await failJobTx(tx, row, 'timeout', now);
  }
}
async function queryTx(tx, queryId, connectionId = null) {
  queryId = text(queryId, 'Consulta', 100, true);
  const row = connectionId
    ? await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key=?`, [jobKey(connectionId, queryId)])
    : await tx.db.get(`SELECT * FROM ${tx.t('job_runs')} WHERE key LIKE ? ESCAPE '!'`, [`shipping:%:${queryId.replace(/[!%_]/g, c => '!' + c)}`]);
  if (!row) fail('Consulta no encontrada.', 404);
  return row;
}
function progress(row) {
  const data = dataOf(row);
  return { queryId: data.queryId, connectionId: data.connectionId, sourceId: data.sourceId, query: data.query, state: row.state, errorCode: row.error_code,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, snapshotId: data.snapshotId || null, payloadHash: data.payloadHash || null };
}
function leaseOf(input, row, now) {
  const lease = input.lease;
  if (!lease || lease.key !== row.key || typeof lease.token !== 'string') fail('Lease de consulta no válido.', 409);
  return { key: row.key, token: lease.token, now };
}
async function assertJobTx(tx, row, bound, lease, now) {
  const data = dataOf(row);
  if (data.connectionId !== bound.row.id || data.sourceId !== bound.row.source_id || data.epoch !== bound.row.epoch || data.deviceId !== bound.deviceId) fail('La consulta no pertenece al dispositivo.', 403);
  if (row.state === 'failed' && row.error_code === 'timeout') return false;
  await assertLease(tx, lease);
  if (!row.started_at || after(row.started_at, READ_MS) <= now) fail('La lectura excedió el tiempo permitido.', 409);
  return true;
}

export async function listShippingConnections(store, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const rows = await tx.db.all(`SELECT id FROM ${tx.t('shipping_connections')} ORDER BY created_at,id`), connections = [];
    for (const row of rows) {
      try { connections.push(await dtoTx(tx, row.id, clock())); } catch (error) { if (error.status !== 403) throw error; }
    }
    return { connections };
  });
}
export async function createShippingConnection(store, input, actorId, options = {}) {
  const sourceId = text(input.sourceId, 'Fuente', 100, true), clock = clockFor(options);
  return adminCommand(store, { scope: 'shipping:create', input, actorId, sourceId, clock }, async (tx, now) => {
    if (await tx.db.get(`SELECT id FROM ${tx.t('shipping_connections')} WHERE source_id=?`, [sourceId])) fail('La fuente ya tiene una conexión.', 409);
    const id = newId();
    await insertRow(tx, 'shipping_connections', { id, source_id: sourceId, provider: 'heka', version: 1, epoch: 1, actor_id: actorId, candidate_identity: null, confirmed_identity: null, identity_fingerprint: null, state: 'awaiting_pairing', last_seen_at: null, data: '{}', created_at: now, updated_at: now });
    return dtoTx(tx, id, now);
  });
}
export async function createShippingPairing(store, connectionId, input, actorId, options = {}) {
  const clock = clockFor(options); let code = null;
  const result = await adminCommand(store, { scope: `shipping:pairing:${connectionId}`, input, actorId, connectionId, clock }, async (tx, now) => {
    const { row } = await connectionTx(tx, connectionId, { allowRevoked: true }); versionOf(row, input);
    await tx.db.run(`UPDATE ${tx.t('shipping_pairings')} SET consumed_at=? WHERE connection_id=? AND consumed_at IS NULL`, [now, connectionId]);
    code = randomBytes(32).toString('base64url');
    const expiresAt = after(now, 300000);
    await insertRow(tx, 'shipping_pairings', { hash: hash(code), connection_id: connectionId, epoch: row.epoch, actor_id: actorId, expires_at: expiresAt, consumed_at: null });
    return { expiresAt, connectionId, sourceId: row.source_id };
  });
  if (!code) fail('El código solo se entrega una vez. Genera otro con una nueva operación.', 409);
  return { ...result, code };
}
export async function pairShippingBridge(store, input, options = {}) {
  const code = text(input.code, 'Código', 100, true), deviceId = deviceIdOf(input.deviceId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) fail('Código no válido.', 401);
  return locked(store, options, async (tx, clock) => {
    const now = clock(), pairing = await tx.db.get(`SELECT * FROM ${tx.t('shipping_pairings')} WHERE hash=?`, [hash(code)]);
    if (!pairing || pairing.consumed_at || pairing.expires_at <= now) fail('El código venció o ya fue utilizado.', 401);
    const { row, source } = await connectionTx(tx, pairing.connection_id, { allowRevoked: true });
    await actorTx(tx, pairing.actor_id);
    if (pairing.epoch !== row.epoch) fail('El código fue revocado.', 401);
    const previousDevice = await tx.db.get(`SELECT connection_id FROM ${tx.t('shipping_bridge_credentials')} WHERE device_id=?`, [deviceId]);
    if (previousDevice && previousDevice.connection_id !== row.id) fail('El dispositivo pertenece a otra fuente.', 409);
    if (row.identity_fingerprint && await tx.db.get(`SELECT id FROM ${tx.t('shipping_connections')} WHERE identity_fingerprint=? AND id<>? AND state<>'revoked'`, [row.identity_fingerprint, row.id])) fail('La cuenta ya pertenece a otra fuente.', 409);
    await revokeCustodyTx(tx, row, now);
    const epoch = row.epoch + 1, bearer = randomBytes(32).toString('base64url');
    if (previousDevice) await tx.db.run(`DELETE FROM ${tx.t('shipping_bridge_credentials')} WHERE device_id=?`, [deviceId]);
    await insertRow(tx, 'shipping_bridge_credentials', { device_id: deviceId, connection_id: row.id, epoch, bearer_hash: hash(bearer), revoked_at: null, created_at: now });
    await changeTx(tx, row.id, { epoch, actor_id: pairing.actor_id, state: 'awaiting_identity', candidate_identity: null, last_seen_at: now }, now);
    return { bearer, deviceId, connectionId: row.id, sourceId: row.source_id, sourceName: source.name, epoch, confirmedIdentity: identityOf(row.confirmed_identity) };
  });
}
export async function reportShippingIdentity(store, input, auth, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const now = clock(), bound = await authenticateTx(tx, input, auth, now), identity = normalizeHekaIdentity(input.identity), fingerprint = hash(identity);
    if (bound.row.confirmed_identity && hash(identityOf(bound.row.confirmed_identity)) !== fingerprint) fail('La cuenta Heka cambió. Utiliza otra fuente comercial.', 409);
    await changeTx(tx, bound.row.id, { candidate_identity: JSON.stringify(identity), state: bound.row.confirmed_identity ? 'connected' : 'confirmation_required' }, now);
    return dtoTx(tx, bound.row.id, now);
  });
}
export async function confirmShippingIdentity(store, connectionId, input, actorId, options = {}) {
  return adminCommand(store, { scope: `shipping:identity:${connectionId}`, input, actorId, connectionId, clock: clockFor(options) }, async (tx, now) => {
    const { row } = await connectionTx(tx, connectionId); versionOf(row, input);
    const candidate = identityOf(row.candidate_identity);
    if (input.sourceId !== row.source_id || !candidate || input.fingerprint !== hash(candidate)) fail('Confirma la fuente y la identidad actuales.', 409);
    if (row.confirmed_identity && hash(identityOf(row.confirmed_identity)) !== input.fingerprint) fail('La cuenta confirmada no puede cambiar.', 409);
    if (await tx.db.get(`SELECT id FROM ${tx.t('shipping_connections')} WHERE identity_fingerprint=? AND id<>? AND state<>'revoked'`, [input.fingerprint, row.id])) fail('La cuenta ya está vinculada a otra fuente.', 409);
    await changeTx(tx, row.id, { confirmed_identity: JSON.stringify(candidate), identity_fingerprint: input.fingerprint, state: 'connected' }, now);
    return dtoTx(tx, row.id, now);
  });
}
export async function revokeShippingConnection(store, connectionId, input, actorId, options = {}) {
  return adminCommand(store, { scope: `shipping:revoke:${connectionId}`, input, actorId, connectionId, clock: clockFor(options) }, async (tx, now) => {
    const { row } = await connectionTx(tx, connectionId, { allowRevoked: true }); versionOf(row, input);
    await revokeCustodyTx(tx, row, now);
    await changeTx(tx, row.id, { epoch: row.epoch + 1, state: 'revoked', candidate_identity: null, last_seen_at: null }, now);
    return dtoTx(tx, row.id, now);
  });
}
export async function requestShippingQuery(store, connectionId, input, actorId, options = {}) {
  return adminCommand(store, { scope: `shipping:query:${connectionId}`, input, actorId, connectionId, clock: clockFor(options) }, async (tx, now) => {
    const { row } = await connectionTx(tx, connectionId); versionOf(row, input);
    if (!row.confirmed_identity || row.state !== 'connected') fail('Confirma primero la cuenta Heka del dispositivo.', 409);
    const credential = await tx.db.get(`SELECT device_id FROM ${tx.t('shipping_bridge_credentials')} WHERE connection_id=? AND epoch=? AND revoked_at IS NULL`, [row.id, row.epoch]);
    if (!credential) fail('Empareja un dispositivo antes de consultar.', 409);
    await expireJobsTx(tx, row.id, now);
    if ((await jobsTx(tx, row.id)).some(job => ['queued', 'running'].includes(job.state))) fail('Ya hay una consulta activa.', 409);
    const queryId = newId(), query = normalizeHekaQuery({ queryId, from: input.from, to: input.to, tracking: input.tracking ?? '' });
    await queueJobTx(tx, jobKey(row.id, queryId), { queryId, connectionId: row.id, sourceId: row.source_id, actorId, epoch: row.epoch, deviceId: credential.device_id, query }, { now });
    return { queryId, connectionId: row.id, state: 'queued', ...query };
  });
}
export async function getShippingQuery(store, queryId, options = {}) {
  return locked(store, options, async (tx, clock) => {
    let row = await queryTx(tx, queryId); const data = dataOf(row);
    await connectionTx(tx, data.connectionId, { allowRevoked: true }); await actorTx(tx, data.actorId);
    await expireJobsTx(tx, data.connectionId, clock()); row = await queryTx(tx, queryId, data.connectionId);
    return progress(row);
  });
}
export async function claimShippingQuery(store, input, auth, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const now = clock(), bound = await authenticateTx(tx, input, auth, now);
    await expireJobsTx(tx, bound.row.id, now);
    if (!bound.row.confirmed_identity || bound.row.state !== 'connected') return { job: null };
    const jobs = await jobsTx(tx, bound.row.id), candidate = jobs.find(row => row.state === 'queued' || (row.state === 'running' && row.lease_until <= now));
    if (!candidate) return { job: null };
    const data = dataOf(candidate); await actorTx(tx, data.actorId);
    if (data.epoch !== bound.row.epoch || data.deviceId !== bound.deviceId || data.sourceId !== bound.row.source_id) fail('La consulta no pertenece al dispositivo.', 403);
    const lease = await claimJob(inTransaction(tx), { key: candidate.key, now: clock() });
    return { job: { queryId: data.queryId, connectionId: bound.row.id, query: data.query, account: identityOf(bound.row.confirmed_identity),
      lease: { key: lease.key, token: lease.token, leaseUntil: lease.leaseUntil }, adapterVersion: HEKA_ADAPTER_VERSION } };
  });
}
export async function heartbeatShippingQuery(store, input, auth, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const now = clock(), bound = await authenticateTx(tx, input, auth, now);
    if (!input.queryId) return { state: bound.row.state };
    await expireJobsTx(tx, bound.row.id, now);
    const row = await queryTx(tx, input.queryId, bound.row.id), lease = leaseOf(input, row, now);
    await actorTx(tx, dataOf(row).actorId);
    if (!await assertJobTx(tx, row, bound, lease, now)) return { state: 'failed', errorCode: 'timeout' };
    return { state: 'running', lease: await renewJob(inTransaction(tx), lease, { now: clock() }) };
  });
}
export async function completeShippingQuery(store, queryId, input, auth, options = {}) {
  const result = await locked(store, options, async (tx, clock) => {
    const now = clock(), bound = await authenticateTx(tx, input, auth, now);
    await expireJobsTx(tx, bound.row.id, now);
    const row = await queryTx(tx, queryId, bound.row.id), data = dataOf(row);
    await actorTx(tx, data.actorId);
    if (data.epoch !== bound.row.epoch || data.deviceId !== bound.deviceId || data.sourceId !== bound.row.source_id) fail('La consulta no pertenece al dispositivo.', 403);
    const snapshot = normalizeHekaSnapshot(input.snapshot), payloadHash = hash(snapshot);
    if (hash(snapshot.query) !== hash(data.query) || hash(snapshot.account) !== hash(identityOf(bound.row.confirmed_identity))) fail('La captura no corresponde a la consulta o cuenta confirmada.', 409);
    const prior = await tx.db.get(`SELECT * FROM ${tx.t('shipping_snapshots')} WHERE query_id=?`, [queryId]);
    if (prior) {
      if (prior.connection_id !== bound.row.id || prior.source_id !== bound.row.source_id || prior.payload_hash !== payloadHash) fail('La consulta ya recibió una captura distinta.', 409);
      if (prior.expires_at <= clock()) fail('La captura venció.', 410);
      return { snapshotId: prior.id, queryId, payloadHash };
    }
    const reservationNow = clock(), lease = leaseOf(input, row, reservationNow);
    if (row.state === 'running' && row.started_at && after(row.started_at, READ_MS) <= reservationNow) {
      await failJobTx(tx, row, 'timeout', reservationNow);
      return { timedOut: true };
    }
    if (!await assertJobTx(tx, row, bound, lease, reservationNow)) return { timedOut: true };
    if (Date.parse(snapshot.capturedAt) < Date.parse(row.started_at) || Date.parse(snapshot.capturedAt) > Date.parse(clock()) + 60000) fail('La fecha de captura no corresponde a la lectura.', 409);
    const snapshotId = newId();
    await insertRow(tx, 'shipping_snapshots', { id: snapshotId, connection_id: bound.row.id, source_id: bound.row.source_id, query_id: queryId, schema_version: 1,
      adapter_version: HEKA_ADAPTER_VERSION, payload_hash: payloadHash, data: JSON.stringify(snapshot), captured_at: snapshot.capturedAt, expires_at: after(now, SNAPSHOT_MS), import_batch_id: null });
    await finishJob(inTransaction(tx), lease, { now: clock(), data: { snapshotId, payloadHash } });
    return { snapshotId, queryId, payloadHash };
  });
  if (result.timedOut) fail('La lectura excedió cinco minutos.', 409);
  return result;
}
export async function failShippingQuery(store, queryId, input, auth, options = {}) {
  if (!ERROR_CODES.has(input.errorCode)) fail('Código de error no válido.');
  return locked(store, options, async (tx, clock) => {
    const now = clock(), bound = await authenticateTx(tx, input, auth, now);
    await expireJobsTx(tx, bound.row.id, now);
    const row = await queryTx(tx, queryId, bound.row.id), lease = leaseOf(input, row, now);
    await actorTx(tx, dataOf(row).actorId);
    if (await assertJobTx(tx, row, bound, lease, now)) {
      await finishJob(inTransaction(tx), lease, { state: 'failed', errorCode: input.errorCode, now: clock() });
      if (input.errorCode === 'login_required') await changeTx(tx, bound.row.id, { state: 'login_required' }, now);
    }
    return progress(await queryTx(tx, queryId, bound.row.id));
  });
}
export async function getShippingSnapshot(store, snapshotId, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const row = await tx.db.get(`SELECT * FROM ${tx.t('shipping_snapshots')} WHERE id=?`, [text(snapshotId, 'Captura', 100, true)]);
    if (!row) fail('Captura no encontrada.', 404);
    await connectionTx(tx, row.connection_id, { allowRevoked: true });
    const job = await queryTx(tx, row.query_id, row.connection_id); await actorTx(tx, dataOf(job).actorId);
    if (row.expires_at <= clock()) fail('La captura venció.', 410);
    return { id: row.id, sourceId: row.source_id, connectionId: row.connection_id, queryId: row.query_id, payloadHash: row.payload_hash,
      capturedAt: row.captured_at, expiresAt: row.expires_at, importBatchId: row.import_batch_id, snapshot: dataOf(row) };
  });
}
export async function expireShippingSnapshots(store, options = {}) {
  return locked(store, options, async (tx, clock) => {
    const now = clock();
    if (options.lease) await assertLease(tx, { ...options.lease, now });
    // Import batches have their own immutable origin manifest and retention policy.
    const rows = await tx.db.all(`SELECT id FROM ${tx.t('shipping_snapshots')} WHERE expires_at<=? ORDER BY expires_at,id LIMIT 25`, [now]);
    let expired = 0;
    for (const row of rows) expired += (await tx.db.run(`DELETE FROM ${tx.t('shipping_snapshots')} WHERE id=? AND expires_at<=?`, [row.id, now])).changes;
    const pending = await tx.db.get(`SELECT id FROM ${tx.t('shipping_snapshots')} WHERE expires_at<=? LIMIT 1`, [now]);
    if (options.lease) await assertLease(tx, { ...options.lease, now: clock() });
    return { expired, hasMore: Boolean(pending) };
  });
}
