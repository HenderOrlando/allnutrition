import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Cola por conexión: una transacción asíncrona no se intercala con otra solicitud. */
export async function openSQLite(filename) {
  const { DatabaseSync } = await import('node:sqlite');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const native = new DatabaseSync(filename);
  if (filename !== ':memory:' && process.platform !== 'win32') chmodSync(filename, 0o600);
  native.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  native.exec(readFileSync(resolve(process.cwd(), 'db/sqlite.sql'), 'utf8'));
  let tail = Promise.resolve();
  const exclusive = task => { const next = tail.then(task); tail = next.catch(() => {}); return next; };
  const direct = {
    provider: 'sqlite', native,
    table: name => `"${name}"`,
    async all(sql, params = []) { return native.prepare(sql).all(...params); },
    async get(sql, params = []) { return native.prepare(sql).get(...params) || null; },
    async run(sql, params = []) { const r = native.prepare(sql).run(...params); return { changes: Number(r.changes) }; },
    async exec(sql) { native.exec(sql); },
    async transaction() { throw new Error('No se admiten transacciones anidadas.'); }
  };
  return {
    provider: 'sqlite', native, table: direct.table,
    all: (...args) => exclusive(() => direct.all(...args)),
    get: (...args) => exclusive(() => direct.get(...args)),
    run: (...args) => exclusive(() => direct.run(...args)),
    exec: (...args) => exclusive(() => direct.exec(...args)),
    transaction(fn) { return exclusive(async () => {
      native.exec('BEGIN IMMEDIATE');
      try { const result = await fn(direct); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    }); },
    close: () => exclusive(() => native.close())
  };
}
