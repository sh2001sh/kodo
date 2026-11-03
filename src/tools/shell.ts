import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';
import type { ToolExecutionContext, ToolRegistration } from './registry.js';

export interface ShellInvocation { program: string; args: string[]; background: boolean; timeoutMs: number }
export interface ShellToolOptions {
  /** Host-resolved absolute Bash executable. Never controlled by model arguments. */
  program: string;
  /** Host process executor owns the total lifetime and any returned background handle. */
  executeProcess(context: ToolExecutionContext, invocation: ShellInvocation, signal: AbortSignal): Promise<unknown>;
}

export const shellToolDescription = 'Run Bash in the workspace. For long tests use background:true, then process.read({id: background.id, waitMs:30000}) to collect output and exit status. Do not start jobs with nohup ... & or bare &: the host must register them. A foreground command still running at the host tool timeout moves to the background when capacity permits. timeoutMs is total process lifetime including background time, default 600000 ms, bounded by the remaining run budget. Supports pipes and redirects. Each call starts a fresh host-selected Bash with profiles disabled and pipefail enabled. Possible writes still require effect reconciliation after an interrupted lifetime.';
export const shellToolParameters = { type: 'object', additionalProperties: false, properties: {
  command: { type: 'string', minLength: 1, maxLength: 32_000 },
  background: { type: 'boolean', description: 'Return a managed background handle immediately after startup; read it with process.read.' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 86_400_000, description: 'Total command lifetime in milliseconds, including background time; default 600000. Separate from the host foreground wait limit.' },
}, required: ['command'] };

/** Reject explicit shell job operators before execution; this is not a general shell parser. */
export function assertManagedShell(command: string): void {
  let quote = '';
  const documents: { delimiter: string; tabs: boolean }[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === '\\' && quote !== "'") i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '#' && (i === 0 || /[\s;|&]/.test(command[i - 1]!))) { while (i < command.length && command[i] !== '\n') i++; }
    if (command[i] === '\n' && documents.length) {
      for (const document of documents.splice(0)) {
        let found = false;
        while (i < command.length) {
          const end = command.indexOf('\n', i + 1);
          const line = command.slice(i + 1, end < 0 ? command.length : end).replace(/\r$/, '');
          i = end < 0 ? command.length : end;
          if ((document.tabs ? line.replace(/^\t+/, '') : line) === document.delimiter) { found = true; break; }
        }
        if (!found) return; // Bash reports malformed here-documents; no body text is a job operator.
      }
      continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const match = /^<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))/.exec(command.slice(i));
      if (match) { documents.push({ delimiter: match[2] ?? match[3] ?? match[4]!, tabs: Boolean(match[1]) }); i += match[0].length - 1; continue; }
    }
    if (c !== '&') continue;
    if (command[i + 1] === '&') { i++; continue; }
    if (command[i + 1] === '>' || /[<>|]/.test(command[i - 1] ?? '')) continue;
    throw new KodoError('SHELL_BACKGROUND', 'shell & jobs are not registered; remove nohup and the trailing &, use shell.exec with background:true, then process.read with the returned background.id');
  }
}

/** Narrow process diagnostic; executable selection remains subject to host exec permission. */
export function readOnlyProcess(program: unknown, args: unknown): boolean {
  if (!['pgrep', '/bin/pgrep', '/usr/bin/pgrep'].includes(String(program)) || !Array.isArray(args) || !args.length || !args.every(arg => typeof arg === 'string')) return false;
  return args.every(arg => !arg.startsWith('-') || /^-[aflxcno]+$/.test(arg));
}

/**
 * A literal subset of Bash: every command in a sequence or pipeline must be a
 * known read/wait operation. No expansion, background jobs or file output.
 * This is host command classification, not an OS isolation boundary.
 */
export function readOnlyShell(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim() || /[\r\n]/.test(command)) return false;
  const words: string[] = [];
  const pattern = /\s*(?:'([^']*)'|"((?:[^"\\$`]|\\[^$`\r\n])*)"|((?!2>)[^\s'";&|<>`$\\(){}#*?[\]~]+)|(&&|\|\||[;|])|((?:2>\s*\/dev\/null|2>&1)(?=[\s;&|)]|$))|([()]))/gy;
  let offset = 0;
  let lastOperator: string | undefined;
  // One level of `( ... )` subshell grouping; `((` would be arithmetic evaluation.
  let depth = 0;
  let closed = false;
  while (offset < command.length) {
    if (!command.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(command);
    if (!match) return false;
    // A literal word must end here: do not accept shell concatenation or output redirection.
    if (!match[4] && !match[6] && pattern.lastIndex < command.length && !/[\s;&|)]/.test(command[pattern.lastIndex]!)) return false;
    if (match[6] === '(') {
      if (words.length || closed || depth) return false;
      depth++;
      lastOperator = '(';
    } else if (match[6] === ')') {
      if (!depth) return false;
      if (words.length) { if (!readOnlyCommand(words)) return false; words.length = 0; }
      else if (lastOperator !== ';') return false;
      depth--;
      closed = true;
      lastOperator = undefined;
    } else if (match[4]) {
      if (closed) closed = false;
      else if (!readOnlyCommand(words)) return false;
      words.length = 0;
      lastOperator = match[4];
    } else if (match[5]) {
      if (!words.length && !closed) return false;
    } else {
      if (closed) return false;
      words.push(match[1] ?? match[2]?.replace(/\\([\\"])/g, '$1') ?? match[3]!);
      lastOperator = undefined;
    }
    offset = pattern.lastIndex;
  }
  if (depth) return false;
  return closed || (words.length ? readOnlyCommand(words) : lastOperator === ';');
}

function readOnlyCommand(words: string[]): boolean {
  const [program, ...args] = words;
  if (program === 'sleep') return args.length > 0 && args.every(arg => /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(arg));
  if (program === 'cd') return (args.length === 1 && !args[0]!.startsWith('-')) || (args.length === 2 && args[0] === '--');
  if (program === 'echo') return true;
  if (program === 'true' || program === 'false') return !args.length;
  if (program === 'cat') return args.every(arg => !arg.startsWith('-') || arg === '--' || /^-[AbEnsTuvet]+$/.test(arg));
  if (program === 'head' || program === 'tail') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--') return true;
      if (['-n', '-c'].includes(arg)) { if (!/^[+-]?\d+$/.test(args[++index] ?? '')) return false; continue; }
      if (arg.startsWith('-') && !/^-(?:\d+|[nc][+-]?\d+|[qv]|f|F)$/.test(arg)) return false;
    }
    return true;
  }
  if (program === 'grep') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--') return true;
      if (['-e', '-f'].includes(arg)) { if (++index >= args.length) return false; continue; }
      if (['-m', '-A', '-B', '-C'].includes(arg)) { if (!/^\d+$/.test(args[++index] ?? '')) return false; continue; }
      if (arg.startsWith('-') && !/^-[EFGivnclLqwhHosrx]+$/.test(arg)) return false;
    }
    return args.length > 0;
  }
  if (program === 'pwd') return args.every(arg => ['-L', '-P'].includes(arg));
  if (program === 'pgrep') return readOnlyProcess(program, args);
  if (program === 'ps') return args.every(arg => /^-?[aefluxwAo]+$/.test(arg) || /^(?:pid|ppid|user|stat|etime|time|args|cmd|comm)(?:,(?:pid|ppid|user|stat|etime|time|args|cmd|comm))*$/.test(arg));
  if (program === 'wc') return args.every(arg => !arg.startsWith('-') || /^-[lcwm]+$/.test(arg) || arg === '--');
  if (program === 'ls') return args.every(arg => !arg.startsWith('-') || /^-[alhAdFprtR1]+$/.test(arg) || ['--', '--all', '--almost-all', '--directory', '--human-readable'].includes(arg));
  if (program === 'git' && args[0] === 'status') return args.slice(1).every(arg => ['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all'].includes(arg));
  if (program === 'rg') {
    // -e/-g and positional literals are safe; pre-processors and output commands are not accepted.
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (['-e', '-g', '--glob', '--regexp'].includes(arg)) { if (++index >= args.length) return false; continue; }
      if (arg.startsWith('-') && !['--', '-n', '-l', '-i', '-F', '-s', '-w', '-x', '--files', '--hidden', '--no-ignore', '--line-number', '--files-with-matches', '--fixed-strings', '--no-heading', '--no-config', '--count'].includes(arg)) return false;
    }
    return args.length > 0;
  }
  return false;
}

/** Resolve installed Bash without searching the current directory or accepting WSL scope translation. */
export async function resolveBashProgram(options: { program?: string } = {}): Promise<string> {
  const candidates = options.program ? [options.program] : process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe')]
    : ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !/^bash(?:\.exe)?$/i.test(path.basename(candidate))) {
      if (options.program) throw new KodoError('SHELL_CONFIG', 'provide an absolute path to an installed Bash executable');
      continue;
    }
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new KodoError('SHELL_UNAVAILABLE', 'Bash is not installed at an approved location; configure its absolute executable path');
}

export function createShellTool(options: ShellToolOptions): ToolRegistration {
  if (!path.isAbsolute(options.program) || typeof options.executeProcess !== 'function') throw new KodoError('SHELL_CONFIG', 'shell requires a host-selected absolute Bash path and the governed process executor');
  return {
    name: 'shell.exec', permission: 'exec', effect: 'write', version: `2:${createHash('sha256').update(options.program).digest('hex')}`,
    readOnly: args => readOnlyShell(args.command), concurrencySafe: args => readOnlyShell(args.command),
    description: shellToolDescription,
    parameters: shellToolParameters,
    async execute(context, args) {
      context.signal.throwIfAborted();
      assertManagedShell(args.command as string);
      // The executor keeps the lifetime timer alive after returning a handle.
      return await options.executeProcess(context, { program: options.program, args: ['--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', args.command as string], background: args.background === true, timeoutMs: args.timeoutMs as number | undefined ?? 600_000 }, context.signal);
    },
  };
}
