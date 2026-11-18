import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openStore } from '../../lib/db/index.mjs';
import * as migrations from '../../lib/db/migrations.mjs';
import { seed } from '../../lib/seed.mjs';
import { testDatabaseEnv } from '../postgres-fixture.mjs';

const [phase, input] = process.argv.slice(2);
const target = Number(input);
assert(['prepare', 'observe'].includes(phase) && /^[1-9]\d*$/.test(input || '') && Number.isSafeInteger(target));
const store = await openStore(testDatabaseEnv(), { migrate: phase === 'prepare' });
try {
  assert.equal((await store.db.get('SELECT current_database() AS name')).name, 'allnutrition_test');
  if (phase === 'prepare') {
    assert.equal((await store.db.get("SELECT to_regclass('allnutrition.migrations') AS relation")).relation, null, 'La actualización requiere una base nueva');
    await store.db.exec(readFileSync(new URL('../../db/supabase.sql', import.meta.url), 'utf8'));
    await store.initialize();
    const ordered = Object.entries(migrations).flatMap(([name, execute]) => {
      const match = /^migrate.+V(\d+)$/.exec(name);
      return match && typeof execute === 'function' ? [[Number(match[1]), execute]] : [];
    }).sort(([a], [b]) => a - b);
    for (const [version, execute] of ordered) if (version <= target) await execute(store);
    assert.equal(await seed(store), true, 'Semilla sintética de actualización no aplicada');
  }
  const { version } = await store.db.get('SELECT max(version) AS version FROM allnutrition.migrations');
  assert.equal(Number(version), target);
  const products = await store.list('products');
  assert.equal(products.length, 1);
  const evidence = products.map(({ id, title, slug, price, catalogIds, status }) => ({ id, title, slug, price, catalogIds, status }));
  console.log(JSON.stringify({ version: Number(version), factsSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') }));
} finally { await store.close(); }
