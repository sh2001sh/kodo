import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historicRates, usageScorecard, summarizeTrials } from './real-scorecard.mjs';

test('cache and reasoning remain input/output subsets, with the historical cost basis', () => {
  const score = usageScorecard({ requests: 1, calls: [{ httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 90 } } }] });
  assert.equal(score.total, 1100); assert.equal(score.cacheHitRate, 0.8);
  assert.equal(score.estimatedCny.high, (200 * 0.5 + 800 * 0.01 + 100 * 2) / 1e6);
  assert.deepEqual(score.estimatedCny, { low: score.estimatedCny.high, high: score.estimatedCny.high, complete: true });
  assert.equal(historicRates.perMillion.input, 0.5);
});
test('missing cache fields produce an interval, not a fabricated zero cache hit', () => {
  const score = usageScorecard({ requests: 1, calls: [{ httpStatus: 200, usage: { prompt_tokens: 1000, completion_tokens: 10 } }] });
  assert.equal(score.cacheHitRate, null); assert.equal(score.missingCacheInput, 1000);
  assert.equal(score.estimatedCny.low, (1000 * 0.01 + 10 * 2) / 1e6);
  assert.equal(score.estimatedCny.high, (1000 * 0.5 + 10 * 2) / 1e6);
});
test('429 follows the explicit zero rule, while other missing usage stays unknown', () => {
  const score = usageScorecard({ requests: 2, calls: [{ httpStatus: 429 }, { httpStatus: 503 }] });
  assert.equal(score.zeroToken429, 1); assert.equal(score.unknownUsageRequests, 1);
  assert.equal(score.usageComplete, false); assert.equal(score.estimatedCny.complete, false);
});
test('delivery amortization includes failed attempts and never divides by zero', () => {
  const row = { profile: 'kodo', acceptance: { passed: true, coverage: 1, score: 100 }, executionMs: 1000, usage: { requests: 1, input: 10, output: 1, total: 11, usageComplete: true, unknownUsageRequests: 0, estimatedCny: { low: 1, high: 2 } }, tools: { total: 2, failed: 0 } };
  const failure = { ...row, executionMs: 3000, acceptance: { passed: false, coverage: 0.5, score: 50 } };
  const summary = summarizeTrials([row, failure])[0];
  assert.equal(summary.completionRate, 0.5); assert.equal(summary.meanSuccessSeconds, 1); assert.equal(summary.secondsPerSuccessfulDelivery, 4);
  assert.deepEqual(summary.estimatedCnyPerSuccess, { low: 2, high: 4 });
  assert.equal(summarizeTrials([failure])[0].secondsPerSuccessfulDelivery, null);
});
