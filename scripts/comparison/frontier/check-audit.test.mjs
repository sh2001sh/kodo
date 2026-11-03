import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRepeatedChecks, pytestDetails, pytestInvocations } from './check-audit.mjs';

const event = (callId, version = 'v1', cwd = '/app', runId = 'main') => ({ type: 'check.started', runId, data: { callId, version, cwd } });
const call = (id, command, startMs = 1000, extra = {}) => ({ id, runId: 'main', name: 'shell.exec', args: { command },
  status: 'succeeded', result: { exitCode: 0 }, startMs, endMs: startMs + 100, ...extra });

test('classifies actual pytest invocations with environment, wrappers, redirection and exclusions', () => {
  const [args] = pytestInvocations('cd /app && COVERAGE_FILE=/tmp/cov timeout 300 python -m pytest -n4 --ignore tests/django_project >/tmp/result 2>&1 | tail -2');
  const parsed = pytestDetails(args);
  assert.equal(parsed.scope, 'full-candidate');
  assert.equal(parsed.excludesDjango, true);
  assert.deepEqual(parsed.targets, []);
  assert.ok(args.includes('/tmp/result'));
  assert.ok(!parsed.filteredArgs.includes('/tmp/result'));
  assert.equal(pytestDetails(pytestInvocations('uv run pytest tests/test_a.py')[0]).scope, 'targeted');
  assert.equal(pytestDetails(pytestInvocations('pytest "$TMPDIR/test_a.py"')[0]).scope, 'targeted');
  assert.equal(pytestDetails(pytestInvocations('pytest --collect-only')[0]).scope, 'collection');
  assert.equal(pytestInvocations('grep pytest pyproject.toml; echo "python -m pytest"').length, 0);
  assert.equal(pytestInvocations('python -c "import pytest; print(pytest)"').length, 0);
});

test('groups broad checks by run, directory and known version without equating different commands', () => {
  const calls = [call('a', 'pytest -q'), call('b', 'pytest -q', 2000), call('c', 'pytest --cov=app', 3000),
    call('d', 'pytest -q', 4000), call('e', 'pytest -q', 5000), call('f', 'pytest -q', 6000, { runId: 'child' })];
  const report = auditRepeatedChecks(calls, [event('a'), event('b'), event('c'), event('d', 'v2'), event('e', 'v1', '/other'), event('f', 'v1', '/app', 'child')]);
  assert.equal(report.broadByVersion.length, 4);
  assert.equal(report.repeatedBroadInvocations, 2);
  assert.equal(report.knownRepeatedBroadCallSeconds, 0.2);
  assert.equal(report.tests.find(item => item.id === 'b').previousSuccessfulCallId, 'a');
  assert.equal(report.tests.find(item => item.id === 'c').previousSuccessfulCallId, null);
  assert.equal(report.tests.find(item => item.id === 'd').previousSuccessfulCallId, null);
});

test('failed, unsettled and unfinished earlier checks are not successful-repeat evidence', () => {
  for (const bad of [{ result: { exitCode: 1 } }, { result: { exitCode: 0, timedOut: true } }, { effectOutcome: 'unknown' }, { status: 'running' }, { endMs: 5000 }]) {
    const report = auditRepeatedChecks([call('a', 'pytest', 1000, bad), call('b', 'pytest', 2000)], [event('a'), event('b')]);
    assert.equal(report.tests[1].previousSuccessfulCallId, null);
    assert.equal(report.repeatedBroadInvocations, 1); // Frequency is independent of success.
  }
});

test('unknown versions are retained without inventing repeat groups', () => {
  const report = auditRepeatedChecks([call('a', 'pytest'), call('b', 'pytest', 2000)], [event('a', null)]);
  assert.deepEqual(report.unknownVersionCallIds, ['a', 'b']);
  assert.equal(report.repeatedBroadInvocations, 0);
});

test('mixed calls count broad invocations once and retain indivisible duration', () => {
  const report = auditRepeatedChecks([call('a', 'pytest'), call('b', 'pytest tests/a.py && pytest -q && pytest --cov=app', 2000)], [event('a'), event('b')]);
  assert.equal(report.repeatedBroadInvocations, 2);
  assert.equal(report.knownRepeatedBroadCallSeconds, 0.1);
  assert.deepEqual(report.broadByVersion[0].mixedCallIds, ['b']);
  assert.equal(report.tests[1].invocations.length, 3);
});

test('background launch timings remain unknown, including detached shell commands', () => {
  for (const background of [call('b', 'pytest', 2000, { result: { processId: 'job' } }), call('b', 'pytest &', 2000)]) {
    const report = auditRepeatedChecks([call('a', 'pytest'), background], [event('a'), event('b')]);
    assert.equal(report.tests[1].executionSec, null);
    assert.equal(report.knownRepeatedBroadCallSeconds, 0);
    assert.equal(report.broadByVersion[0].unknownDurationCalls, 1);
  }
});

test('help and version queries do not count as tests; collection remains distinct', () => {
  const report = auditRepeatedChecks(['--help', '-h', '--version', '-V'].map((arg, i) => call(String(i), `python -m pytest ${arg}`)), []);
  assert.deepEqual(report.tests, []);
  const mixed = auditRepeatedChecks([call('a', 'pytest --version && pytest tests/a.py')], []);
  assert.equal(mixed.tests[0].invocations.length, 1);
  assert.equal(mixed.tests[0].broadCount, 0);
  assert.equal(pytestDetails(['--collect-only']).scope, 'collection');
});

test('background completion measures execution and resource readiness excludes lock wait', () => {
  const at = (type, id, ms, data = {}) => ({ type, time: new Date(ms).toISOString(), data: { callId: id, ...data } });
  const events = [event('a'), event('b'), at('tool.resource_ready', 'a', 2000),
    at('process.background.finished', 'a', 45000, { state: 'exited', exitCode: 0 }),
    at('tool.resource_ready', 'b', 45000)];
  const report = auditRepeatedChecks([call('a', 'pytest', 1000), call('b', 'pytest', 3000, { endMs: 46000 })], events);
  assert.equal(report.tests[0].executionSec, 43);
  assert.equal(report.tests[1].executionSec, 1);
  assert.equal(report.tests[1].previousSuccessfulCallId, null); // started before prior background completion
  assert.equal(report.knownRepeatedBroadCallSeconds, 1);
  assert.equal(report.tests[0].endMs, 1100); // original launch retained
  assert.equal(report.tests[0].executionEndMs, 45000);
});

test('explicit wrapped pytest failure preserves shell exit but invalidates success evidence', () => {
  const command = 'cd /app && timeout 300 python -m pytest -q > /tmp/out 2>&1; echo "exit=$?"; tail -20 /tmp/out';
  const report = auditRepeatedChecks([call('a', command, 1000, { result: { exitCode: 0, stdout: 'exit=1\n1 failed\n' } }), call('b', command, 2000)], [event('a'), event('b')]);
  assert.equal(report.tests[0].exitCode, 0);
  assert.equal(report.tests[0].testExitCode, 1);
  assert.equal(report.tests[0].succeeded, false);
  assert.equal(report.tests[1].previousSuccessfulCallId, null);
  for (const ambiguous of ['pytest; true; echo "exit=$?"', 'pytest | tail; echo "exit=$?"', 'pytest; pytest; echo "exit=$?"']) {
    const observed = auditRepeatedChecks([call('a', ambiguous, 1000, { result: { exitCode: 0, stdout: 'exit=1\n' } })], []).tests[0];
    assert.equal(observed.testExitCode, null);
    assert.equal(observed.succeeded, null);
  }
});

test('captured pytest status survives tail/cat and overrides a successful outer shell', () => {
  for (const command of [
    'cd /app && timeout 120 python -m pytest -n 4 tests/test_state_data.py > /tmp/check.txt 2>&1; code=$?; tail -80 /tmp/check.txt; echo EXIT:$code',
    'pytest -q >/tmp/check.txt 2>&1; status="$?"; cat /tmp/check.txt; echo "EXIT:${status}"',
    'pytest -q > /tmp/check.txt\ncode=$?\ncat /tmp/check.txt\necho EXIT:$code',
  ]) {
    for (const code of [0, 1, 2, 5]) {
      const result = { exitCode: 0, stdout: `test output\nEXIT:${code}\n`, truncated: false };
      const observed = auditRepeatedChecks([call('a', command, 1000, { result }), call('b', command, 2000, { result })], [event('a'), event('b')]);
      assert.equal(observed.tests[0].exitCode, 0);
      assert.equal(observed.tests[0].testExitCode, code);
      assert.equal(observed.tests[0].succeeded, code === 0);
      assert.equal(observed.tests[1].previousSuccessfulCallId, code === 0 ? 'a' : null);
    }
  }
});

test('ambiguous or unrelated markers cannot create pytest status or successful-repeat evidence', () => {
  const ambiguous = [
    'pytest; true; code=$?; echo EXIT:$code',
    'pytest | cat; code=$?; echo EXIT:$code',
    'pytest; code=$?; code=0; echo EXIT:$code',
    'pytest; code=$?; export code=0; echo EXIT:$code',
    'pytest; code=$?; unset code; echo EXIT:$code',
    'pytest; code=$?; echo EXIT:$other',
    "pytest; code=$?; echo 'EXIT:$code'",
    'pytest; code=$?; echo EXIT:0',
    'pytest; echo "code=$?; echo EXIT:$code"',
    'pytest; code=$?; cat /tmp/out | cat; echo EXIT:$code',
    'pytest; code=$?; cat "$(echo /tmp/out)"; echo EXIT:$code',
    'pytest; code=$?; echo EXIT:$code; echo EXIT:$code',
    'pytest; code=$?; pytest tests/a.py; echo EXIT:$code',
    'pytest && code=$?; echo EXIT:$code',
    'pytest; code=$?; if true; then echo EXIT:$code; fi',
    'pytest; code=$?; echo EXIT:$code > /tmp/marker',
  ];
  for (const command of ambiguous) {
    const result = { exitCode: 0, stdout: 'EXIT:0\n' };
    const observed = auditRepeatedChecks([call('a', command, 1000, { result }), call('b', command, 2000, { result })], [event('a'), event('b')]);
    assert.equal(observed.tests[0].testExitCode, null, command);
    assert.equal(observed.tests[0].succeeded, null, command);
    assert.equal(observed.tests[1].previousSuccessfulCallId, null, command);
  }
});

test('missing, duplicate, invalid and truncated capture output remains unknown', () => {
  const command = 'pytest; code=$?; cat /tmp/out; echo EXIT:$code';
  for (const result of [
    { stdout: '1 failed\n' }, { stdout: 'EXIT:0\nEXIT:1\n' }, { stdout: 'EXIT:0\nEXIT:0\n' },
    { stdout: 'EXIT:0\nexit=1\n' }, { stdout: 'EXIT:256\n' }, { stdout: 'EXIT:-1\n' },
    { stdout: 'EXIT:0\n', truncated: true }, { stdout: 'EXIT:0\n', outputLimitExceeded: true },
  ]) {
    const observed = auditRepeatedChecks([call('a', command, 1000, { result: { exitCode: 0, ...result } })], []).tests[0];
    assert.equal(observed.testExitCode, null);
    assert.equal(observed.succeeded, null);
  }
  // A string printed by pytest itself is not an explicit shell capture.
  const direct = auditRepeatedChecks([call('a', 'pytest -q', 1000, { result: { exitCode: 0, stdout: 'EXIT:1\n' } })], []).tests[0];
  assert.equal(direct.testExitCode, 0);
  assert.equal(direct.testExitBasis, 'direct pytest command shell status');
});
