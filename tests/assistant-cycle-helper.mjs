import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAssistantTurn, advanceAssistantTurn } from '../lib/assistant/engine.mjs';

/** Drives the production checkpoint protocol; never retries an initial request. */
export async function completeAssistantCycle(store, session, input, options = {}) {
  let status = await startAssistantTurn(store, session, input, { now: options.now });
  for (let steps = 0; status.state === 'running'; steps++) {
    assert.ok(steps < 256, 'the recoverable cycle must make bounded progress');
    options.onStatus?.(status);
    status = await advanceAssistantTurn(store, session, status.turnId, {
      requestId: randomUUID(), version: status.revision,
    }, options);
  }
  options.onStatus?.(status);
  assert.ok(status.result, `terminal ${status.state} must retain a public result`);
  return status.result;
}

/** The script belongs to the test, not to any individual native sequence. */
export function scriptedAssistantProvider(...steps) {
  let index = 0;
  const factory = runtime => ({ async next(args) {
    assert.ok(index < steps.length, 'the engine must not make an extra model request');
    return steps[index++]({ ...args, results: args.results ?? args.context?.results ?? [] }, runtime);
  } });
  return { factory, calls: () => index };
}
