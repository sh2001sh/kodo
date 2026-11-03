import { expect, it } from 'vitest';
import { checkOutputFiltered, checkPassed, parseCheckCommand } from '../src/runtime/check-command.js';

// Recorded commands. The first pair is from the 2026-11-01 roundtrip run (same check, different filters);
// the rest are from the follow-up run, whose printed-status and pipeline shapes the first parser missed.
const first = 'cd /app && timeout 240 python -m pytest -n 4 -q --cov=statemachine --cov-report=term-missing --cov-branch > /tmp/cov-full.txt 2>&1; code=$?; grep -E "99%|98%|97%|TOTAL|failed|passed" /tmp/cov-full.txt | tail -20; exit $code';
const second = 'cd /app && timeout 240 python -m pytest -n 4 -q --cov=statemachine --cov-report=term-missing --cov-branch > /tmp/cov-full.txt 2>&1; code=$?; grep -E "TOTAL|failed|passed|99%|98%" /tmp/cov-full.txt | tail -20; exit $code';
const withAwk = 'cd /app && timeout 180 python -m pytest -n 4 -q --cov=statemachine --cov-report=term-missing --cov-branch > /tmp/cov.txt 2>&1; code=$?; awk "/TOTAL|failed|passed/" /tmp/cov.txt | tail -10; exit $code';
const printed = (file: string, lines: number) => `cd /app && timeout 180 python -m pytest -n 4 -q --no-cov > /tmp/${file} 2>&1; code=$?; tail -${lines} /tmp/${file}; echo EXIT:$code`;
const piped = 'cd /app && timeout 120 python -m pytest -q -n 4 --no-cov 2>&1 | tail -60';
const printedEarly = 'cd /app && timeout 180 python -m pytest -n 4 --cov=statemachine --cov-report=term-missing --cov-branch -q > /tmp/fullcov.txt 2>&1; echo EXIT:$?; tail -80 /tmp/fullcov.txt';
const withStatus = 'cd /app && timeout 120 python -m pytest -n 4 -q 2>&1 | tail -12 && echo "--- status ---" && git status --short | tail -25';

it('gives one check the same key across output filters, log files and timeouts', () => {
  const a = parseCheckCommand(first), b = parseCheckCommand(second.replace('timeout 240', 'timeout 180')), c = parseCheckCommand(withAwk);
  expect(a).toEqual({ key: JSON.stringify(['/app', 'python', '-m', 'pytest', '-n', '4', '-q', '--cov=statemachine', '--cov-report=term-missing', '--cov-branch']), wholeSuite: true, exit: 'code' });
  expect(b).toEqual(a);
  expect(c).toEqual(a);
  expect(parseCheckCommand(printed('pytest-out2.txt', 40))).toEqual(parseCheckCommand(printed('pytest-final3.txt', 15)));
});

it.each([
  [printed('pytest-out.txt', 60), { wholeSuite: true, exit: 'marker', marker: 'EXIT:' }],
  [piped, { wholeSuite: true, exit: 'code' }],
  [withStatus, { wholeSuite: true, exit: 'code' }],
  [printedEarly, { wholeSuite: true, exit: 'unknown' }],
  ['cd /app && timeout 120 python -m pytest tests/test_state_data.py -q --no-cov 2>&1 | tail -60', { wholeSuite: false, exit: 'code' }],
  ['cd /app && timeout 120 python -m pytest tests/test_state_data.py --cov=statemachine.data --cov-branch -q > /tmp/cov.txt 2>&1; tail -40 /tmp/cov.txt', { wholeSuite: false, exit: 'unknown' }],
])('reads the recorded shape %s', (command, expected) => {
  expect(parseCheckCommand(command)).toMatchObject(expected);
});

it.each([
  ['python -m pytest -q', true],
  ['pytest', true],
  ['uv run pytest -x', true],
  ['cd /app && npm test', true],
  ['pnpm run test', true],
  ['npx vitest run', true],
  ['go test ./...', true],
  ['cargo test', true],
  ['pytest tests/test_state.py -q', false],
  ['pytest tests/test_state.py::test_one', false],
  ['pytest -k data', false],
  ['pytest --lf', false],
  ['pytest --collect-only', false],
  ['npm test -- src/a.test.ts', false],
  ['go test ./pkg/...', false],
])('classifies %s as whole-suite: %s', (command, suite) => {
  expect(parseCheckCommand(command)?.wholeSuite).toBe(suite);
});

it.each([
  ['pytest -q | tail -5', 'code'],
  ['pytest -q && echo done', 'code'],
  ['pytest -q; tail -5 log.txt', 'unknown'],
  ['pytest -q || true', 'unknown'],
  ['pytest -q > log; v=$?; tail log', 'unknown'],
  ['pytest -q > log; v=$?; tail log; echo "status ${v}"', 'marker'],
])('reports how %s exposes its result: %s', (command, exit) => {
  expect(parseCheckCommand(command)?.exit).toBe(exit);
});

it.each([
  'echo ok',
  'make test',
  'pytest $(cat targets)',
  "python - <<'PY'\nprint(1)\nPY",
  'pytest -q &',
  'cd /app && python setup.py build && pytest',
  'pytest -q; rm -rf build',
  'pytest -q | python summarize.py',
  'pytest "unterminated',
])('does not guess about %s', command => {
  expect(parseCheckCommand(command)).toBeUndefined();
});

it('keeps environment assignments and directories in the key', () => {
  expect(parseCheckCommand('CI=1 pytest')!.key).not.toBe(parseCheckCommand('pytest')!.key);
  expect(parseCheckCommand('cd a && pytest')!.key).not.toBe(parseCheckCommand('cd b && pytest')!.key);
});

it('matches the historical awk/git-diff wrapper without trusting its masked status', () => {
  const runner = 'cd /app && timeout 600 python -m pytest -n 4 -q --cov=statemachine --cov-report=term-missing --cov-branch';
  const masked = `${runner} 2>&1 | grep -E "TOTAL|passed|failed" | awk '$NF != "100%" || /passed|failed/' ; git diff --stat`;
  const direct = parseCheckCommand(runner)!;
  expect(parseCheckCommand(masked)).toEqual({ ...direct, exit: 'unknown' });
  expect(parseCheckCommand(`${runner} 2>&1 | tail -3`)?.key).toBe(direct.key);
  expect(checkPassed(masked, { exitCode: 0, stdout: 'passed' })).toBe(false);
  expect(parseCheckCommand(runner.replace('--cov-branch', '--no-cov'))?.key).not.toBe(direct.key);
});

it.each([
  ['pytest -q | tail -5', true],
  ['npm test > results.log 2>&1; tail results.log', true],
  ['pytest>results.log', true],
  ['pytest &>results.log', true],
  ['pytest 1>&-', true],
  ['pytest 2>/dev/null', true],
  ['cd /app && pytest 2>&1', false],
  ['pytest 1>&2', false],
  ['pytest -k "a > b"', false],
  ['pytest ">literal.py"', false],
  ['echo "pytest | tail"', false],
  ['cat results.log | tail -5', false],
  ['git diff --stat && npm test | tail', true],
])('detects output-losing check syntax without treating quoted data as shell syntax: %s', (command, filtered) => {
  expect(checkOutputFiltered(command)).toBe(filtered);
});

it('does not drop quoted arguments that look like redirections', () => {
  expect(parseCheckCommand('pytest ">literal.py"')?.key).toBe(JSON.stringify(['pytest', '>literal.py']));
  expect(parseCheckCommand('pytest "2">log')?.key).toBe(JSON.stringify(['pytest', '2']));
  expect(parseCheckCommand('pytest -q >')).toBeUndefined();
  expect(parseCheckCommand('pytest < test-input')).toBeUndefined();
  expect(parseCheckCommand('pytest <(cat targets)')).toBeUndefined();
  expect(parseCheckCommand('pytest "$(cat targets)"')).toBeUndefined();
  expect(checkPassed('pytest', { exitCode: 0, outputLimitExceeded: true })).toBe(false);
});

it('accepts a printed status only as the last line of complete output', () => {
  const command = printed('out.txt', 20);
  expect(checkPassed(command, { exitCode: 0, stdout: '1565 passed in 23.6s\nEXIT:0\n' })).toBe(true);
  expect(checkPassed(command, { exitCode: 0, stdout: '1 failed\nEXIT:1\n' })).toBe(false);
  expect(checkPassed(command, { exitCode: 0, stdout: 'EXIT:0\nmore', truncated: false })).toBe(false);
  expect(checkPassed(command, { exitCode: 0, stdout: 'EXIT:0', truncated: true })).toBe(false);
  expect(checkPassed(printedEarly, { exitCode: 0, stdout: 'EXIT:0\nTOTAL 100%' })).toBe(false);
  expect(checkPassed(piped, { exitCode: 0, stdout: '' })).toBe(true);
  expect(checkPassed(piped, { exitCode: 1, stdout: '' })).toBe(false);
  expect(checkPassed('echo ok', { exitCode: 0 })).toBe(false);
});

it.each([
  'pytest -q; python -c "print(123)"',
  "python - <<'PY'\nprint(123)\nPY\npytest -q; echo done",
])('does not use an unparsed command exit as test evidence: %s', command => {
  expect(parseCheckCommand(command)).toBeUndefined();
  expect(checkPassed(command, { exitCode: 0, stdout: 'EXIT:0\n' })).toBe(false);
});

it.each([
  'pytest -q; v=$?; tail log || exit $v',
  'pytest -q; v=$?; tail log && exit $v',
  'pytest -q; v=$? && tail log; echo EXIT:$v',
  'pytest -q; v=$?; tail log || echo EXIT:$v',
  'pytest -q; v=$? | tail log; echo EXIT:$v',
  'pytest -q; v=$?; tail log | exit $v',
])('does not trust a conditional or piped saved status: %s', command => {
  expect(parseCheckCommand(command)?.exit).toBe('unknown');
  expect(checkPassed(command, { exitCode: 0, stdout: 'EXIT:0\n' })).toBe(false);
});

it.each([
  'pytest -q; v=$?; exit $v',
  'pytest -q; v=$?; grep passed log | tail -5; exit $v',
  'pytest -q; v=$?; grep passed log | tail -5; echo EXIT:$v',
])('preserves unconditional saved-status results: %s', command => {
  expect(checkPassed(command, { exitCode: 0, stdout: 'EXIT:0\n' })).toBe(true);
});
