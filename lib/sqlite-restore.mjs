import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openStore } from './db/index.mjs';

/**
 * The original is never opened by an initializing adapter. SQLite's native
 * backup reads its WAL consistently; only the private copy can be upgraded.
 */
export async function exportReadonlySQLite(filename) {
  const directory = await mkdtemp(join(tmpdir(),'allnutrition-restore-'));
  let original, copy;
  try {
    await chmod(directory,0o700);
    original = new DatabaseSync(resolve(filename),{readOnly:true});
    const destination = join(directory,'source.sqlite');
    await backup(original,destination);
    original.close(); original = null;
    await chmod(destination,0o600);
    copy = await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:destination});
    return await copy.exportData();
  } finally {
    try { original?.close(); }
    finally {
      try { await copy?.close(); }
      finally { await rm(directory,{recursive:true,force:true}); }
    }
  }
}
