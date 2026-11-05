import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { audit, runCommand, stamp, updateVersioned } from '../business/commands.mjs';
import { verifySocialMediaFiles } from '../business/social-media.mjs';
import { openSocialMediaFile, stageSocialMediaFile } from './media-files.mjs';
import { socialConfig } from './config.mjs';
import { clearSocialMetricWork, SOCIAL_ASSET_INTERNAL_FIELDS } from './evidence.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^(${UUID})/(original\\.(?:jpg|png|webp|mp4|mov)|derivative\\.(?:jpg|mp4))$`);
const SHA = /^[0-9a-f]{64}$/;
const OPERATOR = 'system:social-media-restore';
const invalid = message => { throw new Error(message); };

export function requireSocialRestoreDisabled(env = process.env) {
  if (env.SOCIAL_PUBLISHING_ENABLED !== 'false' || env.SOCIAL_BROWSER_ENABLED !== 'false') {
    invalid('Restaurar exige SOCIAL_PUBLISHING_ENABLED=false y SOCIAL_BROWSER_ENABLED=false explícitos; detén web, scheduler y runner antes de continuar.');
  }
}

// The backup root is operator-selected, unlike the code-owned asset keys. Reject
// symlinks in every existing component, not just the last filename.
async function privateDirectory(directory, { create = false } = {}) {
  const absolute = resolve(directory);
  const parent = dirname(absolute);
  if (parent !== absolute) await privateDirectory(parent);
  if (create) await mkdir(absolute, { mode: 0o700 }); // EEXIST never reuses an old backup.
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) invalid('Directorio de copia no canónico o con enlaces simbólicos.');
  return absolute;
}
async function canonicalLocation(path) {
  try { return await realpath(path); }
  catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    return join(await canonicalLocation(parent), basename(path));
  }
}
async function separateRoots(backupRoot, env) {
  const configured = socialConfig(env).mediaRoot;
  let info;
  try { info = await lstat(configured); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && (!info.isDirectory() || info.isSymbolicLink())) invalid('El volumen de medios no es un directorio seguro.');
  const [canonicalBackup, mediaRoot] = await Promise.all([canonicalLocation(backupRoot), canonicalLocation(configured)]);
  for (const [parent, child] of [[canonicalBackup, mediaRoot], [mediaRoot, canonicalBackup]]) {
    const rel = relative(parent, child);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) invalid('La copia debe estar separada del volumen de medios.');
  }
}
function fileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'assetId,bytes,key,sha256') invalid('Entrada de manifest inválida.');
  const match = typeof record.key === 'string' && KEY.exec(record.key);
  if (!match || match[1] !== record.assetId || !SHA.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > 250 * 1024 * 1024) invalid('Clave, hash o tamaño de archivo no válido.');
  return record;
}
async function databaseFiles(store) {
  const rows = await store.readSnapshot(tx => tx.db.all(`SELECT * FROM ${tx.t('social_assets')} ORDER BY id`));
  const files = new Map();
  for (const row of rows) {
    const data = JSON.parse(row.data);
    for (const variant of ['original', 'derivative']) {
      const key = data[`${variant}Key`], sha256 = data[`${variant}Sha256`], bytes = data[`${variant}Bytes`];
      // A reserved key without a completed hash is an incomplete upload, not a file.
      if (sha256 == null && bytes == null) continue;
      const record = fileRecord({ assetId: row.id, key, sha256, bytes });
      if (!record.key.split('/')[1].startsWith(`${variant}.`) || (variant === 'derivative' && row.sha256 !== sha256)) invalid('Metadatos de archivo inconsistentes en la base de datos.');
      if (files.has(key)) invalid('Clave de archivo duplicada en la base de datos.');
      files.set(key, record);
    }
  }
  return files;
}
async function readManifest(root) {
  const handle = await open(join(root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) invalid('Manifest no válido o demasiado grande.');
    const manifest = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (Object.keys(manifest).sort().join(',') !== 'createdAt,files,version' || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files)) invalid('Formato de manifest no admitido.');
    const keys = new Set();
    for (const record of manifest.files) {
      fileRecord(record);
      if (keys.has(record.key)) invalid('Manifest con claves duplicadas.');
      keys.add(record.key);
    }
    return manifest;
  } finally { await handle.close(); }
}
const expected = record => ({ expectedSha256: record.sha256, expectedBytes: record.bytes });
async function copyFile(record, sourceEnv, targetEnv) {
  const source = await openSocialMediaFile(record.key, { env: sourceEnv, ...expected(record) });
  let staged;
  try {
    staged = await stageSocialMediaFile(record.key, source.handle.createReadStream({ autoClose: false, start: 0 }), { env: targetEnv, ...expected(record), maxBytes: record.bytes });
    await staged.publish();
  } finally {
    await staged?.discard();
    await source.handle.close();
  }
}

export async function backupSocialMedia(store, directory, { env = process.env, now = stamp() } = {}) {
  await separateRoots(resolve(directory), env);
  const files = await databaseFiles(store);
  const root = await privateDirectory(directory, { create: true });
  const targetEnv = { ...env, SOCIAL_MEDIA_DIR: root };
  for (const record of files.values()) await copyFile(record, env, targetEnv);
  const manifest = { version: 1, createdAt: now, files: [...files.values()] };
  const handle = await open(join(root, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(manifest, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  return { files: files.size, bytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0) };
}

export async function restoreSocialMedia(store, directory, { env = process.env, now = stamp() } = {}) {
  requireSocialRestoreDisabled(env);
  const root = await privateDirectory(directory);
  await separateRoots(root, env);
  const manifest = await readManifest(root), dbFiles = await databaseFiles(store);
  const sourceEnv = { ...env, SOCIAL_MEDIA_DIR: root };
  const pending = [];
  // Preflight every entry against the restored DB and both volumes before writing.
  // The DB hashes remain authoritative even when the manifest is internally valid.
  for (const record of manifest.files) {
    const db = dbFiles.get(record.key);
    if (!db || db.assetId !== record.assetId || db.sha256 !== record.sha256 || db.bytes !== record.bytes) invalid('El manifest no corresponde a los hashes de la base restaurada.');
    const source = await openSocialMediaFile(record.key, { env: sourceEnv, ...expected(record) });
    await source.handle.close();
    try {
      const target = await openSocialMediaFile(record.key, { env, ...expected(record) });
      await target.handle.close();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      pending.push(record);
    }
  }
  for (const record of pending) await copyFile(record, sourceEnv, env);
  const verification = await verifySocialMediaFiles(store, { env, now });
  return { restored: pending.length, unchanged: manifest.files.length - pending.length, verification };
}

export async function resetSocialAfterPhysicalRestore(store, { env = process.env, now = stamp(), requestId = randomUUID() } = {}) {
  requireSocialRestoreDisabled(env);
  return runCommand(store, { scope: 'social:physical-restore:reset', requestId, payload: { now }, actorId: OPERATOR, affectsIndicators: false }, async tx => {
    const counts = { connections: 0, campaigns: 0, assets: 0, browserCredentials: 0, controls: 0, jobs: 0 };
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_connections')}`)) {
      const data = JSON.parse(row.data), epoch = data.sessionEpoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch === Number.MAX_SAFE_INTEGER) invalid('Epoch de conexión inválido.');
      delete data.disconnectPending;
      await updateVersioned(tx, 'social_connections', row.id, row.version, { state: 'reconnect_required', data: JSON.stringify({ ...data, sessionEpoch: epoch + 1, capabilities: { facebookPublish: false, instagramPublish: false, adsPublish: false, insights: false, whatsappAds: false } }) });
      if (row.integration_method === 'browser') counts.browserCredentials += (await tx.db.run(`DELETE FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [row.id])).changes;
      counts.connections++;
    }
    counts.controls = (await tx.db.run(`DELETE FROM ${tx.t('social_browser_controls')}`)).changes;
    await tx.db.run(`DELETE FROM ${tx.t('social_oauth_states')}`);
    counts.jobs = (await tx.db.run(`DELETE FROM ${tx.t('job_runs')} WHERE key LIKE 'social:%'`)).changes;
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_campaigns')}`)) {
      await updateVersioned(tx, 'social_campaigns', row.id, row.version, { data: JSON.stringify({ ...JSON.parse(row.data), restore_hold: true }) });
      counts.campaigns++;
    }
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_deliveries')}`)) {
      const data = JSON.parse(row.data), before = JSON.stringify(data);
      const clean = JSON.stringify(clearSocialMetricWork(data));
      if (row.next_sync_at != null || before !== clean) await updateVersioned(tx, 'social_deliveries', row.id, row.version, { next_sync_at: null, data: clean });
    }
    for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_assets')}`)) {
      const data = JSON.parse(row.data);
      for (const key of SOCIAL_ASSET_INTERNAL_FIELDS) delete data[key];
      await updateVersioned(tx, 'social_assets', row.id, row.version, { state: 'missing_file', data: JSON.stringify({ ...data, restoreState: data.restoreState || row.state, reservedBytes: 0, diagnostic: { code: 'RESTORE_VERIFICATION_REQUIRED', message: 'Verifica la copia separada del volumen mediante SHA-256 antes de usar esta pieza.' } }) });
      counts.assets++;
    }
    await audit(tx, { entityType: 'social_physical_restore', entityId: requestId, actorId: OPERATOR, recordedAt: now, next: counts, reason: 'Restauración física: custodia revocada, campañas bloqueadas; no confirma pausa remota.', source: 'system' });
    return counts;
  });
}
