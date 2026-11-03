import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fatalReason } from './run.mjs';

const report = (overrides = {}) => ({
  status: 'completed',
  relay: { rejected: [] },
  protected: { ok: true },
  metrics: { usageComplete: true, unknownCalls: 0, agentCancelledUnknown: 0, providerFailures: 0 },
  pollution: { excused: [] },
  ...overrides,
});
const context = count => ({ plan: Array.from({ length: count }, (_, index) => ({ key: `case:r${index + 1}` })) });
const state = results => ({ results });

test('a transient upstream transport rejection does not abort the matrix', () => {
  const results = [report({ relay: { rejected: ['UPSTREAM_TRANSPORT'] } })];
  assert.equal(fatalReason(context(1), state(results)), null);
});

test('a budget rejection is still fatal', () => {
  const results = [report({ relay: { rejected: ['TOKEN_BUDGET'] } })];
  assert.equal(fatalReason(context(1), state(results)), 'RELAY_REJECTED: TOKEN_BUDGET');
});

test('a mix of transient and budget rejections stays fatal on the budget code', () => {
  const results = [report({ relay: { rejected: ['UPSTREAM_TRANSPORT', 'MODEL_CALL_BUDGET'] } })];
  assert.equal(fatalReason(context(1), state(results)), 'RELAY_REJECTED: MODEL_CALL_BUDGET');
});

test('usage missing only for recorded provider failure attempts is explained, not fatal', () => {
  const explained = [report({ metrics: { usageComplete: false, unknownCalls: 1, agentCancelledUnknown: 0, providerFailures: 1 } })];
  assert.equal(fatalReason(context(1), state(explained)), null);
  const unexplained = [report({ metrics: { usageComplete: false, unknownCalls: 2, agentCancelledUnknown: 0, providerFailures: 1 } })];
  assert.equal(fatalReason(context(1), state(unexplained)), 'USAGE_UNRECONCILED');
});
