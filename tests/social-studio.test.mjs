import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore } from '../lib/db/index.mjs';
import { readAdminView, adminHref } from '../lib/admin-view.mjs';
import { runSocialStudioContracts, runStudioMigrationContract } from './social-studio-contract.mjs';

test('estudio de publicaciones SQLite', t => runSocialStudioContracts(t, () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' })));
test('migración del estudio en SQLite persistente', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'social-studio-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const open = () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: join(directory, 'fixture.sqlite') });
  await runStudioMigrationContract(t, open, open);
});
test('el enlace al estudio solo conserva el UUID en Publicaciones y nunca el contenido', () => {
  const studio = randomUUID(), view = { section: 'advertising', tab: 'campaigns', record: 'new', studio, prompt: 'PRIVATE-prompt', asset: 'PRIVATE-image', csrf: 'PRIVATE-secret' };
  assert.equal(adminHref(view), `/admin?section=advertising&tab=campaigns&record=new&studio=${studio}`);
  assert.equal(readAdminView(new URL(adminHref(view), 'https://example.test').searchParams).studio, studio);
  for (const patch of [{ record: randomUUID() }, { tab: 'assets' }, { tab: 'results' }, { section: 'business' }, { studio: 'not-a-uuid' }]) assert.ok(!adminHref({ ...view, ...patch }).includes('studio='));
});
