import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runAssistantEngineContracts } from './assistant-engine-contract.mjs';
import assert from 'node:assert/strict';
import { createAssistantEvidence, deriveAssistantFact } from '../lib/assistant/evidence.mjs';

test('assistant engine acceptance with SQLite', async t => {
  const store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  try {
    await store.initialize();
    await runAssistantEngineContracts(t, store);
  } finally {
    await store.close();
  }
});

test('derived facts use exact source-bound arithmetic and never grant action authority', () => {
  const fact = (value, extra = {}) => createAssistantEvidence({ domain: 'reports', field: 'netSalesMinor', label: 'Ventas comprobadas', value, unit: 'minor', ...extra });
  const source = { currency: 'COP', interval: { startDate: '2026-09-01', endDateExclusive: '2026-10-01' }, semantic: 'netSalesMinor', sourceStamp: 'report-a' };
  const derive = (operation, left, right, rightSource = source) => deriveAssistantFact({ operation, left, right, leftSource: source, rightSource });
  const left = fact(7), right = fact(3);
  const difference = derive('difference', left, right);
  assert.equal(difference.evidence.value, 4);
  assert.deepEqual(difference.metadata.derivedFrom, [left.id, right.id]);
  assert.equal(difference.metadata.actionAuthority, false);
  assert.equal(derive('ratio_bps', left, right).evidence.value, 23333);
  assert.equal(derive('ratio_bps', left, fact(-3)).evidence.value, -23333);
  const zero = derive('ratio_bps', left, fact(0)).evidence;
  assert.equal(zero.value, null);
  assert.equal(zero.coverage.state, 'unknown');
  assert.ok(zero.coverage.reasons.includes('no_comparison_base'));
  for (const [operand, metadata] of [
    [fact(null), source], [fact(0.5), source], [fact(3, { unit: 'units' }), source],
    [fact(3, { domain: 'cash' }), source], [right, { ...source, currency: 'USD' }],
    [right, { ...source, interval: { startDate: '2026-08-01', endDateExclusive: '2026-09-01' } }],
    [right, { ...source, semantic: 'contributionMinor' }], [right, null],
  ]) assert.throws(() => derive('difference', left, operand, metadata), error => error.code === 'invalid_query');
  assert.throws(() => derive('difference', fact(Number.MAX_SAFE_INTEGER), fact(-1)), error => error.code === 'invalid_query');
});
