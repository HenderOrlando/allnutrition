import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HEKA_ADAPTER_VERSION, HEKA_LOGIN_URL, HEKA_PORTAL_URL, getHekaIdentity, captureHeka } from './providers/heka.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const MAX_BYTES = 10 * 1024 * 1024;
const LOGIN_PAGE = new URL(HEKA_LOGIN_URL), PORTAL_PAGE = new URL(HEKA_PORTAL_URL);
const FAILURES = new Set(['login_required', 'challenge_required', 'contract_changed', 'incomplete', 'limit_exceeded', 'timeout', 'provider_error', 'account_mismatch']);
const MESSAGES = {
  ready: 'Empareja este dispositivo con el panel HTTPS.',
  vault_loading: 'Abriendo el almacén seguro del sistema. Si solicita autorización, concédela personalmente o cancélala.',
  login_required: 'Inicia sesión personalmente en la ventana oficial de Heka.',
  challenge_required: 'Heka requiere una verificación personal. Resuélvela en su ventana oficial; no se omiten controles.',
  contract_changed: 'El portal o su contrato no es el clásico compatible. No se realizó una lectura aproximada.',
  incomplete: 'La lectura fue incompleta. No se envió una captura parcial.',
  limit_exceeded: 'La consulta supera 31 días, 10 MiB o 10.000 filas. Reduce el intervalo.',
  timeout: 'La lectura excedió su tiempo o perdió su autorización. Solicita una consulta nueva.',
  provider_error: 'Heka no pudo completar la lectura. No se modificaron guías ni pagos.',
  account_mismatch: 'La cuenta Heka no coincide con la cuenta fijada. No se consultarán datos de otra cuenta.',
  vault_unavailable: 'El almacén seguro del sistema no está disponible. No se usa almacenamiento en texto plano.',
  vault_read_failed: 'No se pudo abrir la vinculación cifrada. Reabre la aplicación cuando el almacén seguro esté disponible, o desconecta localmente.',
  pair_failed: 'No se pudo emparejar. Comprueba el origen HTTPS y genera un código nuevo si ya fue consumido.',
  pair_save_failed: 'El código fue consumido, pero no se pudo guardar la vinculación segura. Genera otro código en el panel.',
  disconnected: 'Vinculación local eliminada. Para revocar también el dispositivo, usa Configuración del panel.',
  revoked: 'El panel rechazó o revocó la autorización. Se eliminaron la vinculación local y la sesión Heka.',
  network: 'No hay respuesta segura del panel. La vinculación se conserva; se reintentará mientras esta ventana esté abierta.',
  confirmation_required: 'Confirma explícitamente esta fuente y cuenta en Configuración del panel antes de consultar.',
  connected: 'Cuenta confirmada. Esperando consultas del panel.',
  reading: 'Leyendo Heka, sin modificar guías, pagos ni bancos…',
  delivering: 'Enviando la misma captura al panel. No se repetirá la lectura si se pierde la respuesta.',
  complete: 'Captura recibida por el panel. La revisión e importación se aceptan únicamente allí.',
  job_rejected: 'El panel rechazó esta consulta o su lease. No se repetirá la captura. Solicita una consulta nueva.',
};
let localWindow, hekaWindow, hekaSession, binding = null;
let closing = false, pollTimer = null, polling = false, actionBusy = false;
let vaultBlocked = false, providerBlock = null, pending = null, activeCapture = null, lastIdentity = null, lastContact = 0;
let cleanupSession = Promise.resolve();
const requests = new Set(), seenQueries = new Set();
const view = { code: 'ready', sourceName: '', sourceId: '', account: null, confirmed: false, lastCaptureAt: null, queryId: null };

class BridgeError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
function issue(code) { view.code = code; }
function safeState() {
  return { paired: Boolean(binding), origin: binding?.origin || '', deviceId: binding?.deviceId || '',
    connectionId: binding?.connectionId || '', sourceName: view.sourceName, sourceId: view.sourceId,
    account: view.account, confirmed: view.confirmed, hekaOpen: Boolean(hekaWindow && !hekaWindow.isDestroyed()),
    code: view.code, message: MESSAGES[view.code] || MESSAGES.provider_error,
    lastCaptureAt: view.lastCaptureAt, queryId: view.queryId, busy: actionBusy, vaultBlocked };
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function text(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function identity(value) {
  if (!exact(value, ['userId', 'centerCost']) || !text(value.userId) || !text(value.centerCost)) throw new BridgeError('contract_changed');
  return { userId: value.userId, centerCost: value.centerCost };
}
function sameAccount(a, b) { return a?.userId === b?.userId && a?.centerCost === b?.centerCost; }
function originOf(value) {
  if (!text(value, 2048)) throw new BridgeError('pair_failed');
  let url; try { url = new URL(value); } catch { throw new BridgeError('pair_failed'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin === 'null') throw new BridgeError('pair_failed');
  return url.origin;
}
function envelope(value) {
  if (!exact(value, ['origin', 'deviceId', 'connectionId', 'bearer']) || originOf(value.origin) !== value.origin || !text(value.deviceId, 128) || !text(value.connectionId, 128) || typeof value.bearer !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.bearer)) throw new BridgeError('vault_read_failed');
  return value;
}
async function secureStorage() {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new BridgeError('vault_unavailable');
  if (process.platform === 'linux' && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())) throw new BridgeError('vault_unavailable');
  // Async availability alone also succeeds with Chromium's hardcoded POSIX v10 fallback.
  if (process.platform === 'linux') {
    const probe = await safeStorage.encryptStringAsync('shipping-bridge-storage-provider');
    if (!Buffer.isBuffer(probe) || probe.length <= 3 || probe.subarray(0, 3).toString('ascii') === 'v10') throw new BridgeError('vault_unavailable');
  }
}
async function privateDirectory() {
  const userData = app.getPath('userData');
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  const base = await fs.lstat(userData);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new BridgeError('vault_unavailable');
  await fs.chmod(userData, 0o700);
  const directory = path.join(userData, 'bridge-vault');
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BridgeError('vault_unavailable');
  await fs.chmod(directory, 0o700);
  return directory;
}
async function saveBinding(value) {
  await secureStorage();
  const bytes = await safeStorage.encryptStringAsync(JSON.stringify(envelope(value)));
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new BridgeError('vault_unavailable');
  if (process.platform === 'linux' && bytes.subarray(0, 3).toString('ascii') === 'v10') throw new BridgeError('vault_unavailable');
  const directory = await privateDirectory(), destination = path.join(directory, 'binding.enc');
  try { const current = await fs.lstat(destination); if (!current.isFile() || current.isSymbolicLink()) throw new BridgeError('vault_unavailable'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.binding-${randomUUID()}`);
  let file;
  try {
    file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await fs.rename(temporary, destination);
  } finally {
    await file?.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function loadBinding() {
  let file;
  try {
    const directory = await privateDirectory(), filename = path.join(directory, 'binding.enc');
    const entry = await fs.lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new BridgeError('vault_read_failed');
    file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.size === 0) throw new BridgeError('vault_read_failed');
    await file.chmod(0o600);
    await secureStorage();
    const encrypted = await file.readFile();
    await file.close(); file = null;
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    const value = envelope(JSON.parse(decrypted.result));
    if (decrypted.shouldReEncrypt) await saveBinding(value);
    binding = value; issue('login_required');
  } catch (error) {
    if (error.code !== 'ENOENT') { vaultBlocked = true; issue(error.code === 'vault_unavailable' ? 'vault_unavailable' : 'vault_read_failed'); }
  } finally { await file?.close().catch(() => {}); }
}
async function removeBinding() {
  const directory = await privateDirectory(), filename = path.join(directory, 'binding.enc');
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BridgeError('vault_unavailable');
    await fs.unlink(filename);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function cancelRequests() { for (const controller of requests) controller.abort(); requests.clear(); }
function stopCapture(code = 'login_required') {
  if (activeCapture) { activeCapture.errorCode = code; activeCapture.controller.abort(); }
}
async function clearHeka() {
  stopCapture(); providerBlock = null; lastIdentity = null; view.account = null; view.confirmed = false;
  const window = hekaWindow, isolated = hekaSession;
  hekaWindow = null; hekaSession = null;
  if (window && !window.isDestroyed()) window.destroy();
  if (isolated) {
    await isolated.closeAllConnections().catch(() => {});
    await isolated.clearStorageData();
    await isolated.clearCache();
  }
}
async function disconnect(code = 'disconnected') {
  binding = null; pending = null; seenQueries.clear(); lastContact = 0;
  cancelRequests(); stopCapture();
  view.sourceName = ''; view.sourceId = ''; view.queryId = null; view.lastCaptureAt = null;
  cleanupSession = cleanupSession.catch(() => {}).then(clearHeka);
  await cleanupSession.catch(() => {});
  try { await removeBinding(); vaultBlocked = false; issue(code); }
  catch { vaultBlocked = true; issue('vault_unavailable'); }
}
async function api(route, body, current = binding, paired = true) {
  if (!current || (paired && current !== binding)) throw new BridgeError('revoked');
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new BridgeError('limit_exceeded');
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${current.origin}/api/shipping/bridge/${route}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(paired ? { Authorization: `Bearer ${current.bearer}` } : {}) }, body: encoded,
    });
    if (paired && current !== binding) throw new BridgeError('revoked');
    if (paired && [401, 403].includes(response.status)) { await response.body?.cancel(); await disconnect('revoked'); throw new BridgeError('revoked', response.status); }
    if (!response.ok) { await response.body?.cancel(); throw new BridgeError(response.status >= 500 || response.status === 429 ? 'network' : 'job_rejected', response.status); }
    if (!(response.headers.get('content-type') || '').includes('application/json') || Number(response.headers.get('content-length') || 0) > 131072) { await response.body?.cancel(); throw new BridgeError('contract_changed'); }
    const reader = response.body?.getReader(); if (!reader) throw new BridgeError('contract_changed');
    let total = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 131072) { await reader.cancel(); throw new BridgeError('contract_changed'); }
      chunks.push(Buffer.from(value));
    }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('contract_changed'); }
    if (!object(result)) throw new BridgeError('contract_changed');
    return result;
  } catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('network'); }
  finally { clearTimeout(timer); requests.delete(controller); }
}
function denySession(isolated) {
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
}
function hekaDestination(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return (url.origin === LOGIN_PAGE.origin && /^\/ingreso\/?$/.test(url.pathname)) ||
      (url.origin === PORTAL_PAGE.origin && url.pathname === PORTAL_PAGE.pathname);
  } catch { return false; }
}
function classicPage(raw) {
  try { const url = new URL(raw); return url.origin === PORTAL_PAGE.origin && url.pathname === PORTAL_PAGE.pathname; } catch { return false; }
}
function blockHekaDestination(raw) {
  let code = 'contract_changed';
  try { if (/challenge|captcha|verify|verification/i.test(new URL(raw).pathname)) code = 'challenge_required'; } catch {}
  providerBlock = code; issue(code); stopCapture(code); lastIdentity = null;
}
async function openHeka() {
  if (!binding) throw new BridgeError('pair_failed');
  await cleanupSession;
  if (hekaWindow && !hekaWindow.isDestroyed()) {
    if (!providerBlock) { hekaWindow.show(); hekaWindow.focus(); return; }
    await clearHeka();
  }
  const isolated = session.fromPartition(`heka-${binding.connectionId}-${randomUUID()}`, { cache: false });
  denySession(isolated); hekaSession = isolated;
  const window = new BrowserWindow({ width: 1150, height: 850, title: 'Heka · inicio de sesión oficial',
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, devTools: false, navigateOnDragDrop: false, spellcheck: false, webviewTag: false } });
  hekaWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, target) => { if (!hekaDestination(target)) { event.preventDefault(); blockHekaDestination(target); } });
  window.webContents.on('will-redirect', (event, target, _inPlace, isMainFrame) => { if (isMainFrame && !hekaDestination(target)) { event.preventDefault(); blockHekaDestination(target); } });
  window.webContents.on('did-navigate', (_event, target) => {
    lastIdentity = null;
    providerBlock = null;
    if (!classicPage(target)) { issue('login_required'); stopCapture('login_required'); }
  });
  window.webContents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
    if (isMainFrame && !hekaDestination(target)) blockHekaDestination(target);
  });
  window.webContents.on('render-process-gone', () => { issue('login_required'); stopCapture('login_required'); });
  window.on('closed', () => {
    if (hekaWindow !== window) return;
    issue('login_required');
    cleanupSession = cleanupSession.catch(() => {}).then(clearHeka);
  });
  issue('login_required');
  try { await window.loadURL(HEKA_LOGIN_URL); } catch { if (hekaWindow === window) issue('provider_error'); }
}
function validateJob(job) {
  if (!exact(job, ['queryId', 'connectionId', 'query', 'account', 'lease', 'adapterVersion']) || job.connectionId !== binding?.connectionId || !text(job.queryId, 128) || job.adapterVersion !== HEKA_ADAPTER_VERSION) throw new BridgeError('contract_changed');
  const query = job.query;
  if (!exact(query, ['queryId', 'from', 'to', 'tracking']) || query.queryId !== job.queryId || typeof query.tracking !== 'string' || query.tracking.length > 200 || /[\u0000-\u001f\u007f]/.test(query.tracking)) throw new BridgeError('contract_changed');
  for (const day of [query.from, query.to]) if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new BridgeError('contract_changed');
  const duration = Date.parse(query.to) - Date.parse(query.from);
  if (duration < 0 || duration >= 31 * 86400000) throw new BridgeError('limit_exceeded');
  const lease = job.lease;
  if (!exact(lease, ['key', 'token', 'leaseUntil']) || !text(lease.key, 512) || !text(lease.token, 256) || !text(lease.leaseUntil, 64) || !Number.isFinite(Date.parse(lease.leaseUntil)) || lease.key !== `shipping:${job.connectionId}:${job.queryId}`) throw new BridgeError('contract_changed');
  job.account = identity(job.account);
  return job;
}
function failureCode(error) { return FAILURES.has(error?.code) ? error.code : 'provider_error'; }
async function reportIdentity(current) {
  if (!hekaWindow || hekaWindow.isDestroyed() || !classicPage(hekaWindow.webContents.getURL())) return false;
  if (providerBlock) throw new BridgeError(providerBlock);
  const candidate = identity(await getHekaIdentity(hekaWindow.webContents));
  if (current !== binding) return false;
  if ((view.confirmed && !sameAccount(candidate, view.account)) || (lastIdentity && !sameAccount(candidate, lastIdentity))) throw new BridgeError('account_mismatch');
  if (lastIdentity && sameAccount(candidate, lastIdentity)) return true;
  let reported;
  try { reported = await api('identity', { deviceId: current.deviceId, identity: candidate }, current); }
  catch (error) { if (error.status === 409) throw new BridgeError('account_mismatch'); throw error; }
  if (current !== binding) return false;
  if (reported.connectionId !== current.connectionId || !sameAccount(identity(reported.candidateIdentity), candidate)) throw new BridgeError('contract_changed');
  if (reported.confirmedIdentity && !sameAccount(identity(reported.confirmedIdentity), candidate)) throw new BridgeError('account_mismatch');
  lastIdentity = candidate; view.account = candidate; view.confirmed = Boolean(reported.confirmedIdentity);
  if (text(reported.sourceName)) view.sourceName = reported.sourceName;
  if (text(reported.sourceId, 128)) view.sourceId = reported.sourceId;
  issue(view.confirmed ? 'connected' : 'confirmation_required');
  return true;
}
async function deliverPending() {
  const delivery = pending;
  if (!delivery || delivery.binding !== binding) { pending = null; return; }
  const { job, binding: current } = delivery;
  try {
    if (delivery.snapshot) {
      issue('delivering');
      const result = await api(`jobs/${encodeURIComponent(job.queryId)}/complete`, { deviceId: current.deviceId, lease: job.lease, snapshot: delivery.snapshot }, current);
      if (!text(result.snapshotId, 128) || result.queryId !== job.queryId || !text(result.payloadHash, 128)) throw new BridgeError('contract_changed');
      view.lastCaptureAt = delivery.snapshot.capturedAt; issue('complete');
    } else {
      await api(`jobs/${encodeURIComponent(job.queryId)}/fail`, { deviceId: current.deviceId, lease: job.lease, errorCode: delivery.errorCode }, current);
      issue(delivery.errorCode);
    }
    if (pending === delivery) { pending = null; view.queryId = null; }
  } catch (error) {
    if (error.code !== 'network' && pending === delivery) { pending = null; view.queryId = null; }
    throw error;
  }
}
async function executeJob(job, current) {
  view.queryId = job.queryId;
  const controller = new AbortController(), capture = { controller, errorCode: null };
  activeCapture = capture;
  let heartbeatTimer, deadlineTimer, heartbeatBusy = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  const abortPromise = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new BridgeError(capture.errorCode || 'timeout')), { once: true }));
  const rejectCapture = code => { capture.errorCode = code; controller.abort(); };
  deadlineTimer = setTimeout(() => rejectCapture('timeout'), Math.max(1, deadline - Date.now()));
  const heartbeat = async () => {
    if (heartbeatBusy || controller.signal.aborted || current !== binding) return;
    heartbeatBusy = true;
    try {
      const result = await api('heartbeat', { deviceId: current.deviceId, queryId: job.queryId, lease: job.lease }, current);
      if (result.state !== 'running') rejectCapture('timeout');
      else if (result.lease && text(result.lease.leaseUntil, 64)) job.lease.leaseUntil = result.lease.leaseUntil;
    } catch (error) { if (error.code !== 'network') rejectCapture(error.code === 'revoked' ? 'login_required' : 'timeout'); }
    finally { heartbeatBusy = false; }
  };
  heartbeatTimer = setInterval(() => { void heartbeat(); }, 30000);
  try {
    if (seenQueries.has(job.queryId)) throw new BridgeError('timeout');
    seenQueries.add(job.queryId);
    if (providerBlock) throw new BridgeError(providerBlock);
    if (!hekaWindow || hekaWindow.isDestroyed() || !classicPage(hekaWindow.webContents.getURL())) throw new BridgeError('login_required');
    const observed = identity(await Promise.race([getHekaIdentity(hekaWindow.webContents), abortPromise]));
    if (!sameAccount(observed, job.account) || (view.account && !sameAccount(observed, view.account))) throw new BridgeError('account_mismatch');
    view.account = observed; view.confirmed = true; issue('reading');
    const snapshot = await Promise.race([captureHeka(hekaWindow.webContents, { query: job.query, account: job.account, signal: controller.signal, deadline }), abortPromise]);
    if (controller.signal.aborted || Date.now() > deadline) throw new BridgeError(capture.errorCode || 'timeout');
    if (!object(snapshot) || !sameAccount(snapshot.account, job.account)) throw new BridgeError('account_mismatch');
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) throw new BridgeError('limit_exceeded');
    const after = identity(await Promise.race([getHekaIdentity(hekaWindow.webContents), abortPromise]));
    if (!sameAccount(after, job.account)) throw new BridgeError('account_mismatch');
    if (current === binding) pending = { binding: current, job, snapshot };
  } catch (error) {
    const code = failureCode(error);
    if (current === binding) { pending = { binding: current, job, errorCode: code }; issue(code); }
  } finally {
    clearInterval(heartbeatTimer); clearTimeout(deadlineTimer);
    if (activeCapture === capture) activeCapture = null;
  }
  if (pending && current === binding) await deliverPending();
}
async function tick() {
  if (closing || !localWindow || localWindow.isDestroyed() || !binding || polling || actionBusy) return;
  polling = true; const current = binding;
  try {
    if (pending) { await deliverPending(); return; }
    if (Date.now() - lastContact >= 30000) {
      const contact = await api('heartbeat', { deviceId: current.deviceId }, current);
      lastContact = Date.now();
      if (contact.state === 'connected' && view.account) view.confirmed = true;
    }
    try { await reportIdentity(current); }
    catch (error) { if (FAILURES.has(error.code)) { issue(error.code); lastIdentity = null; } else throw error; }
    if (current !== binding) return;
    const result = await api('claim', { deviceId: current.deviceId }, current);
    if (!Object.hasOwn(result, 'job')) throw new BridgeError('contract_changed');
    if (result.job !== null) {
      let job;
      try { job = validateJob(result.job); } catch (error) { issue(failureCode(error)); return; }
      await executeJob(job, current);
    } else if (view.confirmed && lastIdentity && ['network', 'confirmation_required'].includes(view.code)) issue('connected');
  } catch (error) { if (current === binding) issue(MESSAGES[error.code] ? error.code : 'provider_error'); }
  finally { polling = false; }
}
function schedulePoll() {
  if (closing) return;
  pollTimer = setTimeout(async () => { await tick(); schedulePoll(); }, 5000);
}
function validateSender(event) {
  if (!localWindow || localWindow.isDestroyed() || event.sender !== localWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== LOCAL_URL || event.sender.getURL() !== LOCAL_URL) throw new BridgeError('provider_error');
}
function registerIPC() {
  ipcMain.handle('bridge:get-state', (event, ...args) => { validateSender(event); if (args.length) throw new BridgeError('provider_error'); return safeState(); });
  ipcMain.handle('bridge:pair', async (event, input, ...args) => {
    validateSender(event);
    if (args.length || actionBusy || binding || vaultBlocked || !exact(input, ['origin', 'code', 'confirmedOrigin']) || input.confirmedOrigin !== input.origin || typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code)) return { ok: false, state: safeState() };
    actionBusy = true;
    let consumed = false;
    try {
      const origin = originOf(input.origin);
      await secureStorage(); await privateDirectory();
      const deviceId = randomUUID(), result = await api('pair', { deviceId, code: input.code }, { origin }, false);
      consumed = true;
      if (result.deviceId !== deviceId || !text(result.connectionId, 128)) throw new BridgeError('pair_failed');
      const value = envelope({ origin, deviceId, connectionId: result.connectionId, bearer: result.bearer });
      const account = result.confirmedIdentity ? identity(result.confirmedIdentity) : null;
      await saveBinding(value); binding = value; lastContact = 0;
      view.sourceName = text(result.sourceName) ? result.sourceName : ''; view.sourceId = text(result.sourceId, 128) ? result.sourceId : '';
      view.account = account; view.confirmed = Boolean(account); issue('login_required');
      return { ok: true, state: safeState() };
    } catch (error) { issue(consumed ? 'pair_save_failed' : error.code === 'vault_unavailable' ? error.code : 'pair_failed'); return { ok: false, state: safeState() }; }
    finally { actionBusy = false; }
  });
  ipcMain.handle('bridge:open-heka', async (event, ...args) => {
    validateSender(event); if (args.length || actionBusy || !binding) return { ok: false, state: safeState() };
    actionBusy = true;
    try { await openHeka(); return { ok: true, state: safeState() }; }
    catch { issue('provider_error'); return { ok: false, state: safeState() }; }
    finally { actionBusy = false; }
  });
  ipcMain.handle('bridge:disconnect', async (event, ...args) => {
    validateSender(event); if (args.length || actionBusy) return { ok: false, state: safeState() };
    actionBusy = true;
    try { await disconnect(); return { ok: !vaultBlocked, state: safeState() }; }
    finally { actionBusy = false; }
  });
}
async function shutdown() {
  if (closing) return;
  closing = true; clearTimeout(pollTimer); cancelRequests(); stopCapture(); pending = null;
  try { await cleanupSession.catch(() => {}); await clearHeka(); } catch { /* Quitting still destroys all memory-only sessions. */ }
  app.quit();
}
app.on('window-all-closed', () => { void shutdown(); });
app.on('before-quit', event => { if (!closing) { event.preventDefault(); void shutdown(); } });
app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault());
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (localWindow && !localWindow.isDestroyed()) { if (localWindow.isMinimized()) localWindow.restore(); localWindow.focus(); } });
  app.whenReady().then(async () => {
    registerIPC(); actionBusy = true; issue('vault_loading');
    const isolated = session.fromPartition(`bridge-ui-${randomUUID()}`, { cache: false }); denySession(isolated);
    localWindow = new BrowserWindow({ width: 800, height: 820, minWidth: 620, minHeight: 700, title: 'All Nutrition · Heka',
      webPreferences: { session: isolated, preload: path.join(ROOT, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, devTools: false, navigateOnDragDrop: false, spellcheck: false, webviewTag: false } });
    localWindow.removeMenu();
    localWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    localWindow.webContents.on('will-navigate', event => event.preventDefault());
    localWindow.webContents.on('will-redirect', event => event.preventDefault());
    localWindow.on('closed', () => { localWindow = null; void shutdown(); });
    await localWindow.loadURL(LOCAL_URL);
    await loadBinding();
    actionBusy = false;
    if (view.code === 'vault_loading') issue('ready');
    schedulePoll();
  }).catch(() => { void shutdown(); });
}
