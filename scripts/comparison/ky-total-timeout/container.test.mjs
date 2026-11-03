import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_TESTS, selectTests, summarizeAva } from './container/run-tests.mjs';
import { feedback, testRunTool } from './container/test-tool.mjs';
import { RECOVERY, recoveryObjective } from './recovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('test selection accepts only public test files under test/', () => {
  assert.deepEqual(selectTests(undefined), [...PUBLIC_TESTS]);
  assert.deepEqual(selectTests(['./test/retry.ts', 'test\\hooks.ts']), ['test/retry.ts', 'test/hooks.ts']);
  for (const bad of [['../oracle.ts'], ['test/../source/index.ts'], ['source/index.ts'], ['test/helpers/index.ts'], ['test/retry.js'], [], ['test/a.ts; rm -rf /']]) {
    assert.throws(() => selectTests(bad), /test file|1-16/u, JSON.stringify(bad));
  }
});

test('AVA summaries count passes even when the passed total is omitted, and collect every failing title', () => {
  const output = [
    '  ✔ retry › network error (1s)',
    '  ✔ hooks › init hook runs once (2s)',
    '  ✘ [fail]: retry › shouldRetry: works with TimeoutError',
    '  ─',
    '',
    '  retry › caller cancellation during the retry delay stops further requests',
    '',
    '  test/retry.ts:2025',
    '',
    '  retry › shouldRetry: works with TimeoutError',
    '',
    '  test/retry.ts:1319',
    '',
    '  2 tests failed',
  ].join('\n');
  const summary = summarizeAva(output);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.failures, ['retry › shouldRetry: works with TimeoutError', 'retry › caller cancellation during the retry delay stops further requests']);
  assert.equal(summarizeAva('  241 tests passed').passed, 241);
});

test('agent feedback is bounded and the tool reads, never writes, the workspace', () => {
  const long = feedback({ ok: false, exitCode: 1, timedOut: false, durationMs: 1, files: ['test/retry.ts'], summary: {}, stdout: 'x'.repeat(20_000), stderr: 'TAIL' });
  assert.ok(long.output.length < 6_100);
  assert.match(long.output, /earlier characters omitted[\s\S]*TAIL$/u);
  const tool = testRunTool();
  assert.equal(tool.effect, 'read');
  assert.equal(tool.permission, 'exec');
  assert.ok(tool.parameters.additionalProperties === false);
});

test('the recovery registration gives equal repair budgets and never shows oracle assertions', () => {
  assert.equal(RECOVERY.id, 'ky-total-timeout-recovery-r1');
  assert.deepEqual(RECOVERY.order, ['A1', 'D1']);
  assert.deepEqual(RECOVERY.repairBudget, { maxModelCalls: 60 });
  assert.ok(RECOVERY.testToolTimeoutMs < RECOVERY.toolTimeoutMs, 'the container is reaped before the tool call times out');
  const oracle = readFileSync(path.join(here, 'oracle.mjs'), 'utf8');
  const hidden = [...oracle.matchAll(/record\('(T\d+)'/gu)].map(match => match[1]);
  for (const key of RECOVERY.order) {
    const objective = recoveryObjective(key);
    assert.match(objective, /test\.run/u);
    assert.doesNotMatch(objective, /oracle|T1[0-4]\b|actualRegression/u);
    for (const id of hidden) assert.equal(objective.includes(`${id}:`), false, id);
  }
});
