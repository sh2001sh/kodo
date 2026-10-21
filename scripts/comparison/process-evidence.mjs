import path from 'node:path';
import process from 'node:process';
import { hasCompleteTestSummary } from './assessment.mjs';

// Complex-task evidence only. Recognize the supplied Node commands and frozen
// npm scripts, not arbitrary shell programs. This is not a shell sandbox: it
// cannot prove a binary/script's identity or detect every possible shell trick.
const normalize = value => value.replaceAll('\\', '/').replace(/^\.\//, '');
const isNode = value => ['node', 'node.exe'].includes(value.toLowerCase())
  || normalize(value).toLowerCase() === normalize(process.execPath).toLowerCase();
const isNpm = value => ['npm', 'npm.cmd', 'npm.exe'].includes(path.win32.basename(value).toLowerCase());
const isScript = (value, suffix) => normalize(value).endsWith(`node_modules/${suffix}`);
const namesFile = (value, file) => normalize(value) === file || normalize(value).endsWith(`/${file}`);

// Accept one command or &&-joined commands, including PowerShell's leading &.
// Preserve Windows backslashes. Reject pipelines, substitutions, redirections,
// alternate branches, and semicolon/newline chains whose final exit hides errors.
function nativeCommands(command) {
  if (typeof command !== 'string') return [];
  command = command.trim();
  if (/[\r\n`$|;<>]/.test(command)) return [];
  const commands = [], tokens = [];
  let token = '', quote = '', active = false, invocation = false;
  const finishToken = () => { if (active) tokens.push(token); token = ''; active = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) finishToken();
    else if (char === '&') {
      finishToken();
      if (command[index + 1] === '&') {
        if (!tokens.length) return [];
        commands.push(tokens.splice(0));
        invocation = false;
        index++;
      } else if (tokens.length || invocation) return [];
      else invocation = true;
    } else { token += char; active = true; }
  }
  if (quote) return [];
  finishToken();
  if (!tokens.length) return [];
  commands.push(tokens);
  return commands;
}

function testTargets(args) {
  const targets = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--no-color', '--color=false', '--no-file-parallelism'].includes(arg)) continue;
    if (arg === '--reporter') {
      if (!args[++index] || args[index].startsWith('-')) return null;
      continue;
    }
    if (/^--reporter=[a-z-]+$/i.test(arg)) continue;
    // Unknown options fail closed, including -t, --exclude, --shard, --changed,
    // --project, --watch and --passWithNoTests. These can omit required tests.
    if (arg.startsWith('-') || !arg) return null;
    targets.push(arg);
  }
  return targets;
}

function classify(tokens) {
  let [program, ...args] = tokens;
  if (typeof program !== 'string' || args.some(arg => typeof arg !== 'string')) return null;
  // Fixed progress markers in an && chain cannot hide a failed verification.
  // They contribute no checks or test evidence; arbitrary echo stays rejected.
  if (program.toLowerCase() === 'echo' && args.length === 1
    && ['BUILD_OK', 'TYPECHECK_OK', 'LINT_OK'].includes(args[0])) return { checks: [] };
  if (isNode(program)) {
    if (args[0] === '--no-warnings') args = args.slice(1);
    const [script, ...scriptArgs] = args;
    if (!script) return null;
    if (isScript(script, 'npm/bin/npm-cli.js')) { program = 'npm'; args = scriptArgs; }
    else if (isScript(script, 'vitest/vitest.mjs')) {
      if (scriptArgs[0] !== 'run') return null;
      const targets = testTargets(scriptArgs.slice(1));
      return targets === null ? null : { tests: targets, checks: [] };
    } else if (isScript(script, 'typescript/bin/tsc')) {
      const remaining = [...scriptArgs];
      let project = 'tsconfig.json', noEmit = false;
      while (remaining.length) {
        const arg = remaining.shift();
        if (arg === '--noEmit') noEmit = true;
        else if (['-p', '--project'].includes(arg)) {
          project = remaining.shift();
          if (!project) return null;
        } else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
        else if (arg === '--pretty' && ['true', 'false'].includes(remaining[0])) remaining.shift();
        else return null;
      }
      if (noEmit && namesFile(project, 'tsconfig.json')) return { checks: ['typecheck'] };
      if (!noEmit && namesFile(project, 'tsconfig.build.json')) return { checks: ['build'] };
      return null;
    } else if (isScript(script, 'eslint/bin/eslint.js')) {
      const targets = scriptArgs.filter(arg => !['--no-warn-ignored', '--no-ignore', '--max-warnings=0'].includes(arg));
      return targets.length === 3 && ['src', 'tests', 'scripts'].every(file => targets.some(target => namesFile(target, file)))
        ? { checks: ['lint'] } : null;
    } else return null;
  }
  if (!isNpm(program)) return null;
  const npmRun = args[0] === 'run' || args[0] === 'run-script';
  if (npmRun) args = args.slice(1);
  if (npmRun && args.length === 1 && args[0] === 'build') return { checks: ['build'] };
  if (npmRun && args.length === 1 && args[0] === 'check') return { checks: ['typecheck', 'lint'] };
  if (args[0] !== 'test') return null;
  if (args.length > 1 && args[1] !== '--') return null;
  const targets = testTargets(args.slice(2));
  return targets === null ? null : { tests: targets, checks: ['build'] };
}

function accepted(evidence, native) {
  return evidence.flatMap(item => {
    if (native) {
      if (item.status !== 'completed' || item.exitCode !== 0 || item.truncated || item.outputLimitExceeded || item.cancelled) return [];
      const commands = nativeCommands(item.command);
      const classified = commands.map(classify);
      // A successful final command cannot lend its exit code to an unrecognized
      // command in the same shell expression.
      return commands.length && classified.every(Boolean)
        ? classified.map(value => ({ ...value, output: item.output ?? '' })) : [];
    }
    if (item.result?.exitCode !== 0 || item.result.capturedComplete !== true
      || item.result.truncated || item.result.outputLimitExceeded || item.result.cancelled) return [];
    let request;
    try { request = JSON.parse(item.request?.arguments); } catch { return []; }
    if (!request || !Array.isArray(request.args)) return [];
    const value = classify([request.program, ...request.args]);
    return value ? [{ ...value, output: item.result.stdout ?? '' }] : [];
  });
}

export function agentTestsPassed(evidence, { native = false, tests }) {
  const commands = accepted(evidence, native).filter(value => value.tests && hasCompleteTestSummary(value.output));
  return tests.every(test => commands.some(value => !value.tests.length || value.tests.some(target => namesFile(target, test))));
}

export function agentChecksPassed(evidence, { native = false } = {}) {
  const checks = new Set(accepted(evidence, native).flatMap(value => value.checks));
  return ['build', 'typecheck', 'lint'].every(check => checks.has(check));
}
