import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateInputTokens } from '../../dist/runtime/context-tokens.js';
import { commonPrefix, divergence, stateTolerantStore, trialFindings } from './v3-compaction-diagnosis.mjs';

const system = { role: 'system', content: 'You are Kodo. Run ID: r1.' };
const user = { role: 'user', content: 'Fix the pager.' };
const state = step => ({ role: 'system', content: `Kernel execution state: {"step":${step}}` });
const assistant = { role: 'assistant', content: 'Reading src/pager.mjs.' };
const tool = { role: 'tool', tool_call_id: 'read', content: 'export const page = 1;\n'.repeat(40) };
const tools = [{ name: 'file.read', description: 'Read a file', parameters: { type: 'object', properties: {} } }];
const run = { id: 'r1', binding: { provider: 'openai', model: 'm' } };

/** Store adapter over one recorded call: request blob plus measured usage. */
function recorded(messages, input) {
  const blobs = { req: { binding: run.binding, messages, tools }, res: { usage: { input } } };
  return {
    at() { return this; },
    readBlob: ref => blobs[ref],
    run: () => run,
    events: () => [],
    recentModelCalls: () => [{ kind: 'model', status: 'succeeded', requestRef: 'req', resultRef: 'res' }],
  };
}

test('commonPrefix and divergence name what broke the shared prefix', () => {
  const previous = [system, user, state(0)];
  const next = [system, user, assistant, tool, state(1)];
  assert.equal(commonPrefix(previous, next), 2);
  assert.deepEqual(divergence(previous, next), { at: 2, kind: 'kernel-state', previousLength: 3, tail: 1 });
  assert.deepEqual(divergence([system, user], next), { at: 2, kind: 'none' });
  const summarized = [system, { role: 'user', content: 'Task handoff summary: …' }, state(4)];
  assert.equal(divergence([system, user, assistant], summarized).kind, 'user-changed');
  assert.equal(divergence(summarized, [system, user]).kind, 'summary-marker');
});

test('the estimator now calibrates across the replaced kernel-state message, matching the counterfactual store without undercounting', () => {
  const previous = [system, user, state(0)];
  const next = [system, user, assistant, tool, state(1)];
  const measured = 900;
  const store = recorded(previous, measured);
  const calibrated = estimateInputTokens(store, run, next, tools);
  const none = estimateInputTokens({ ...store, recentModelCalls: () => [] }, run, next, tools);
  assert.notEqual(calibrated, none, 'the measured prefix is reused across the replaced state message');
  assert.ok(calibrated > measured, 'new messages are added on top of the full measured input, never subtracted');
  // The diagnosis counterfactual and the shipped estimator agree, so replays of old evidence stay comparable.
  assert.equal(estimateInputTokens(stateTolerantStore(store), run, next, tools), calibrated);
});

test('the tolerant store leaves requests without a trailing state message unchanged', () => {
  const previous = [system, user, assistant];
  const next = [system, user, assistant, tool];
  const store = recorded(previous, 700);
  assert.equal(estimateInputTokens(stateTolerantStore(store), run, next, tools), estimateInputTokens(store, run, next, tools));
});

test('trialFindings separates work and compaction calls and counts divergence kinds', () => {
  const row = (purpose, extra) => ({ purpose, input: 100, cacheRead: 50, estimate: 170, calibrated: false, estimateRatio: 1.7, candidateCalibrated: true, candidateRatio: 1.2, prefixWithPrevious: 2, toolsSame: true, toolChoice: null, messages: 4, divergence: { kind: 'kernel-state' }, ...extra });
  const rows = [row('work', { divergence: null, candidateCalibrated: false, candidateRatio: 2 }), row('work'), row('compaction', { cacheRead: 1, toolChoice: 'none' }), row('work', { divergence: { kind: 'summary-marker' } })];
  const findings = trialFindings(rows, { attempts: 1, installs: 1, skips: [], installsDetail: [] });
  assert.equal(findings.workCalls, 3);
  assert.equal(findings.compactionCalls, 1);
  assert.equal(findings.calibratedShare, 0);
  assert.equal(findings.candidateCalibratedShare, 1);
  assert.equal(findings.minCandidateRatio, 1.2);
  assert.deepEqual(findings.divergenceKinds, { 'kernel-state': 1, 'summary-marker': 1 });
  assert.equal(findings.workCacheReadShare, 0.5);
  assert.equal(findings.compactionCacheReadShare, 0.01);
  assert.equal(findings.compactionPrefix[0].toolChoice, 'none');
});
