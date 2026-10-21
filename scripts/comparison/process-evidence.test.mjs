import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';
import { agentChecksPassed, agentTestsPassed } from './process-evidence.mjs';

const tests = ['tests/history-catalog.test.ts', 'tests/cli-history.test.ts', 'tests/context.test.ts'];
const modules = 'E:/project/node_modules/';
const summary = '\n Tests  27 passed (27)\n';
const evidence = (script, args, extra = {}) => ({
  request: { arguments: JSON.stringify({ program: process.execPath, args: [modules + script, ...args] }) },
  result: { exitCode: 0, capturedComplete: true, stdout: summary, ...extra },
});
const native = (command, extra = {}) => ({ command, status: 'completed', exitCode: 0, output: summary, ...extra });
const checks = () => [evidence('typescript/bin/tsc', ['-p', 'tsconfig.build.json']), evidence('typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json']), evidence('eslint/bin/eslint.js', ['src', 'tests', 'scripts'])];

test('supplied Node commands prove all required tests and separate build/typecheck/lint', () => {
  assert.equal(agentTestsPassed([evidence('vitest/vitest.mjs', ['run', ...tests])], { tests }), true);
  assert.equal(agentTestsPassed(tests.map(file => evidence('vitest/vitest.mjs', ['run', file])), { tests }), true);
  assert.equal(agentChecksPassed(checks()), true);
  assert.equal(agentChecksPassed(checks().slice(0, 2)), false);
  assert.equal(agentChecksPassed([evidence('typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.build.json']), ...checks().slice(1)]), false);
});

test('test filtering, missing files, skipped/partial summaries and incomplete capture fail', () => {
  for (const flags of [['-t', 'one'], ['--testNamePattern=one'], ['--exclude', tests[0]], ['--shard=1/2'], ['--project', 'one'], ['--passWithNoTests']]) {
    assert.equal(agentTestsPassed([evidence('vitest/vitest.mjs', ['run', ...tests, ...flags])], { tests }), false, flags.join(' '));
  }
  assert.equal(agentTestsPassed([evidence('vitest/vitest.mjs', ['run', tests[0]])], { tests }), false);
  for (const result of [{ exitCode: 1 }, { capturedComplete: false }, { truncated: true }, { cancelled: true }, { stdout: 'Tests 1 passed | 26 skipped (27)' }, { stdout: 'Tests 0 passed (0)' }]) {
    assert.equal(agentTestsPassed([evidence('vitest/vitest.mjs', ['run', ...tests], result)], { tests }), false);
  }
});

test('full-suite runs and npm scripts match the frozen package scripts', () => {
  assert.equal(agentTestsPassed([evidence('vitest/vitest.mjs', ['run', '--reporter=verbose'])], { tests }), true);
  assert.equal(agentTestsPassed([native('npm test')], { native: true, tests }), true);
  assert.equal(agentTestsPassed([native('npm run test -- ' + tests.join(' '))], { native: true, tests }), true);
  assert.equal(agentChecksPassed([native('npm run build && npm run check')], { native: true }), true);
  assert.equal(agentChecksPassed([native('npm test && npm run check')], { native: true }), true);
  assert.equal(agentChecksPassed([evidence('npm/bin/npm-cli.js', ['run', 'build']), evidence('npm/bin/npm-cli.js', ['run', 'check'])]), true);
  assert.equal(agentChecksPassed([native('npm run build -- --noEmit && npm run check')], { native: true }), false);
  assert.equal(agentChecksPassed([native('npm build && npm check')], { native: true }), false);
});

test('quoted Windows paths, PowerShell invocation and ordinary && syntax remain usable', () => {
  const node = `"${process.execPath}"`;
  const invoke = `& ${node} "E:\\project\\node_modules\\vitest\\vitest.mjs" run ${tests.join(' ')} --reporter verbose`;
  assert.equal(agentTestsPassed([native(invoke)], { native: true, tests }), true);
  const command = `${node} "${modules}typescript/bin/tsc" -p tsconfig.build.json && ${node} "${modules}typescript/bin/tsc" --noEmit -p tsconfig.json && ${node} "${modules}eslint/bin/eslint.js" src tests scripts`;
  assert.equal(agentChecksPassed([native(command)], { native: true }), true);
  assert.equal(agentChecksPassed([native('& npm run build && & npm run check\n')], { native: true }), true);
});

test('echo/eval and filenames in unrelated arguments cannot impersonate verification', () => {
  const fake = { request: { arguments: JSON.stringify({ program: process.execPath, args: ['-e', '0', 'tsconfig.build.json'] }) }, result: { exitCode: 0, capturedComplete: true, stdout: summary } };
  assert.equal(agentChecksPassed([fake, ...checks().slice(1)]), false);
  for (const command of [
    'echo vitest run ' + tests.join(' '),
    'node -e "console.log(1)" E:/project/node_modules/vitest/vitest.mjs run ' + tests.join(' '),
    'echo ok && npm test', 'npm test || echo ok', 'npm test; echo ok', 'npm test | head',
    'npm test\necho ok', 'npm test > output.txt', 'npm test &&', 'npm test && echo check',
    'node "$(echo E:/project/node_modules/vitest/vitest.mjs)" run',
  ]) assert.equal(agentTestsPassed([native(command)], { native: true, tests }), false, command);
  const wrongProgram = evidence('vitest/vitest.mjs', ['run', ...tests]);
  wrongProgram.request.arguments = JSON.stringify({ program: 'echo', args: [modules + 'vitest/vitest.mjs', 'run', ...tests] });
  assert.equal(agentTestsPassed([wrongProgram], { tests }), false);
});

test('lint must cover all project roots and native success evidence must be complete', () => {
  assert.equal(agentChecksPassed([...checks().slice(0, 2), evidence('eslint/bin/eslint.js', ['src'])]), false);
  assert.equal(agentChecksPassed([...checks().slice(0, 2), evidence('eslint/bin/eslint.js', ['src', 'tests', 'scripts', '--ignore-pattern', '**/*'])]), false);
  for (const result of [{ exitCode: 1 }, { status: 'error' }, { truncated: true }, { cancelled: true }]) {
    assert.equal(agentTestsPassed([native('npm test', result)], { native: true, tests }), false);
  }
  assert.equal(agentTestsPassed([{ request: { arguments: '{' }, result: { exitCode: 0, capturedComplete: true } }], { tests }), false);
});

test('fixed progress echoes in successful && chains do not discard real verification', () => {
  const node = `"${process.execPath}"`;
  const command = `${node} "${modules}typescript/bin/tsc" -p tsconfig.build.json && echo BUILD_OK && ${node} "${modules}typescript/bin/tsc" --noEmit -p tsconfig.json && echo TYPECHECK_OK && ${node} "${modules}eslint/bin/eslint.js" src tests scripts && echo LINT_OK`;
  assert.equal(agentChecksPassed([native(command)], { native: true }), true);
  assert.equal(agentChecksPassed([native(command, { exitCode: 1 })], { native: true }), false);
  assert.equal(agentChecksPassed([native('echo BUILD_OK && echo TYPECHECK_OK && echo LINT_OK')], { native: true }), false);
  assert.equal(agentTestsPassed([native('echo BUILD_OK')], { native: true, tests }), false);
  assert.equal(agentChecksPassed([native(command.replace('echo LINT_OK', 'echo "Tests 27 passed (27)"'))], { native: true }), false);
});
