import './env.mjs';
import { pathToFileURL } from 'node:url';
import { openStore } from '../lib/db/index.mjs';
import { verifySocialMediaFiles } from '../lib/business/social-media.mjs';
import { backupSocialMedia, restoreSocialMedia, resetSocialAfterPhysicalRestore, requireSocialRestoreDisabled } from '../lib/social/media-backup.mjs';

export function parseSocialMediaBackupArgs(args) {
  const [command, directory, ...extra] = args;
  if (extra.length || !['backup', 'restore', 'verify', 'reset-after-physical-restore'].includes(command) || (['backup', 'restore'].includes(command) ? !directory || directory.startsWith('-') : directory !== undefined)) {
    throw new Error('Uso: node scripts/social-media-backup.mjs backup <directorio-nuevo> | restore <directorio> | verify | reset-after-physical-restore');
  }
  return { command, directory };
}

export async function runSocialMediaBackupCLI(args = process.argv.slice(2), env = process.env) {
  const { command, directory } = parseSocialMediaBackupArgs(args);
  if (['restore', 'reset-after-physical-restore'].includes(command)) requireSocialRestoreDisabled(env);
  const store = await openStore(env);
  try {
    const options = { env };
    const result = command === 'backup' ? await backupSocialMedia(store, directory, options)
      : command === 'restore' ? await restoreSocialMedia(store, directory, options)
        : command === 'verify' ? await verifySocialMediaFiles(store, options)
          : await resetSocialAfterPhysicalRestore(store, options);
    return { command, ...result };
  } finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runSocialMediaBackupCLI())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
