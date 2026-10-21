import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectMetrics, aggregateMetrics } from './metrics.mjs';

test('HTTP 429 counts as zero tokens but still counts as a request; cache and reasoning are not added twice', () => {
  const metrics = collectMetrics({ profile: 'pi-256k', outcome: { stats: { toolCalls: 1 } }, executionMs: 123, elapsedMs: 150,
    traceEvents: [{ type: 'tool.started', callId: 'a' }, { type: 'tool.finished', callId: 'a', status: 'failed' }],
    wire: { requests: 2, tokens: 9999, estimated: true, rejected: ['UPSTREAM_HTTP_429'], calls: [
      { contextChars: 1000, usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, cached_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } } },
      { httpStatus: 429, reserve: 9869 },
    ] } });
  assert.equal(metrics.totalTokens, 130);
  assert.equal(metrics.cachedInputTokens, 80);
  assert.equal(metrics.tokenUsageComplete, true);
  assert.equal(metrics.missingUsageRequests, 0);
  assert.equal(metrics.zeroToken429Requests, 1);
  assert.equal(metrics.providerUsageComplete, false);
  assert.equal(metrics.modelRequests, 2);
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.toolCallsFailed, 1);
  assert.equal(metrics.toolExecutions, 1);
  assert.equal(metrics.cacheUsageComplete, true);
  assert.equal(metrics.contextWindowUsageVerified, true);
});

test('non-429 missing usage stays unknown and an all-429 trial consumes zero', () => {
  const result = { profile: 'pi-256k', traceEvents: [], outcome: { stats: { toolCalls: 0 } },
    wire: { requests: 1, tokens: 9999, estimated: true, rejected: ['UPSTREAM_HTTP_429'], calls: [{ httpStatus: 429 }] } };
  assert.equal(collectMetrics(result).totalTokens, 0);
  assert.equal(collectMetrics(result).cachedInputTokens, 0);
  assert.equal(collectMetrics(result).tokenUsageComplete, true);
  assert.equal(collectMetrics(result).contextWindowUsageVerified, false);
  result.wire.calls[0].httpStatus = 502;
  assert.equal(collectMetrics(result).tokenUsageComplete, false);
  assert.equal(collectMetrics(result).missingUsageRequests, 1);
});

test('256k window verification includes the reserved output at the exact boundary', () => {
  const result = { profile: 'pi-256k', traceEvents: [],
    wire: { requests: 1, tokens: 253028, estimated: false, rejected: [], calls: [{ outputLimit: 3072, usage: { prompt_tokens: 252928, completion_tokens: 100 } }] } };
  assert.equal(collectMetrics(result).contextWindowUsageVerified, true);
  result.wire.calls[0].usage.prompt_tokens++;
  assert.equal(collectMetrics(result).contextWindowUsageVerified, false);
});

test('model-declared windows replace the legacy 256k threshold, including the full reserved output', () => {
  const result = { profile: 'kodo-max', contextWindowTokens: 1000000,
    wire: { requests: 1, tokens: 700000, calls: [{ outputLimit: 393216, usage: { prompt_tokens: 606784, completion_tokens: 90000 } }], rejected: [] } };
  assert.equal(collectMetrics(result).contextWindowTokens, 1000000);
  assert.equal(collectMetrics(result).contextWindowUsageVerified, true);
  result.wire.calls[0].usage.prompt_tokens++;
  assert.equal(collectMetrics(result).contextWindowUsageVerified, false);
});

test('native session includes unfinished tools omitted by CLI events; fallback is incomplete', () => {
  const result = { profile: 'opencode', wire: { requests: 0, tokens: 0, calls: [], rejected: [] },
    outcome: { toolParts: [{ id: 'part1', callID: 'a', state: { status: 'completed' } }, { id: 'part2', callID: 'b', state: { status: 'error' } }, { id: 'part3', callID: 'c', state: { status: 'running' } }, { id: 'other-part', callID: 'a', state: { status: 'completed' } }],
      events: [{ type: 'tool_use', part: { callID: 'a', state: { status: 'completed' } } }] } };
  const metrics = collectMetrics(result);
  assert.equal(metrics.toolCalls, 3);
  assert.equal(metrics.toolCallsSucceeded, 1);
  assert.equal(metrics.toolCallsFailed, 1);
  assert.equal(metrics.toolCallsUnfinished, 1);
  assert.equal(metrics.toolCountComplete, true);
  delete result.outcome.toolParts;
  assert.equal(collectMetrics(result).toolCountComplete, false);
  assert.equal(collectMetrics(result).toolCalls, 1);
});

test('Pi schema rejection before execute is still a tool invocation', () => {
  const metrics = collectMetrics({ profile: 'pi-256k', traceEvents: [],
    outcome: { stats: { toolCalls: 0 }, messages: [{ role: 'tool', tool_call_id: 'rejected', content: 'invalid arguments' }] },
    wire: { requests: 1, tokens: 12, estimated: false, rejected: [], calls: [{ usage: { prompt_tokens: 10, completion_tokens: 2 } }] } });
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.toolCallsFailed, 1);
  assert.equal(metrics.toolExecutions, 0);
  assert.equal(metrics.cachedInputTokens, null);
});

test('success means exclude failed attempts and unknown usage; failure costs remain visible', () => {
  const row = (passed, total, complete) => ({ profile: 'kodo-256k', task: 'repair', passed,
    metrics: { modelRequests: 2, toolCalls: 3, toolCountComplete: true, inputTokens: total - 10, outputTokens: 10, totalTokens: total, tokenUsageComplete: complete,
      cacheUsageComplete: false, cachedInputTokens: null, executionMs: 50, missingUsageRequests: complete ? 0 : 1 } });
  const [group] = aggregateMetrics([row(true, 100, true), row(true, 200, false), row(false, 900, false)]);
  assert.equal(group.successes, 2);
  assert.equal(group.successMean.totalTokens, 100);
  assert.equal(group.tokenMeanSamples, 1);
  assert.equal(group.successMean.cachedInputTokens, null);
  assert.deepEqual(group.failedCost, { attempts: 1, modelRequests: 2, toolCalls: 3, measuredTokens: 900, missingUsageRequests: 1 });
});
