import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import type { Call } from './types.js';
import { readOnlyShell } from '../tools/shell.js';

const evalFlags = new Set(['-e', '--eval', '-p', '--print']);
const readCall = /\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir)\s*\(/;
const sideEffect = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|cpSync|spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;
const literalPath = /\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir)\s*\(\s*(['"`])([^'"`]{1,256})\1/;

/** Diagnostic subset only: literal reading pipelines/sequences, optionally starting with cd. */
function shellRead(command: string): { script: string; target?: string } | undefined {
  if (!command.trim() || /[\r\n]/.test(command)) return undefined;
  const token = /\s*(?:'([^']*)'|"([^"$`\\]*)"|([^\s'";&|<>`$\\(){}#]+)|(&&|[;|]))/gy;
  let offset = 0;
  let start = 0;
  let words: string[] = [];
  let reads = 0;
  let target: string | undefined;
  const accept = (end: number): boolean => {
    const [program, ...args] = words;
    if (program === 'cd') return reads === 0 && readOnlyShell(command.slice(start, end));
    if (program === 'sed') {
      // Count only literal print ranges; editing scripts are not investigation.
      if (args[0] !== '-n' || !/^\d+(?:,\d+)?p$/.test(args[1] ?? '') || args.length < 3 || args.slice(2).some(arg => arg.startsWith('-'))) return false;
    } else if (program === 'nl') {
      if (!args.every(arg => !arg.startsWith('-') || ['-ba', '-bt', '-bn', '--'].includes(arg))) return false;
    } else if (!['cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ls'].includes(program ?? '') || !readOnlyShell(command.slice(start, end))) return false;
    reads++;
    const last = args.at(-1);
    if (last && !last.startsWith('-') && /[./]/.test(last)) target = last;
    return true;
  };
  while (offset < command.length) {
    if (!command.slice(offset).trim()) break;
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match) return undefined;
    if (match[4]) {
      if (!accept(offset)) return undefined;
      words = [];
      start = token.lastIndex;
    } else {
      if (token.lastIndex < command.length && !/[\s;&|]/.test(command[token.lastIndex]!)) return undefined;
      words.push(match[1] ?? match[2] ?? match[3]!);
    }
    offset = token.lastIndex;
  }
  if (!words.length || !accept(command.length) || !reads) return undefined;
  return { script: command, ...(target ? { target } : {}) };
}

/** Inline Node script or literal shell reading sequence, or undefined. */
function readScript(name: string, args: Record<string, unknown>): { script: string; target?: string } | undefined {
  if (name === 'shell.exec') {
    const command = typeof args.command === 'string' ? args.command : '';
    return shellRead(command);
  }
  if (name !== 'process.exec' || typeof args.program !== 'string' || !Array.isArray(args.args)) return undefined;
  if (path.basename(args.program).toLowerCase().replace(/\.exe$/, '') !== 'node') return undefined;
  const flag = args.args.findIndex(value => typeof value === 'string' && evalFlags.has(value));
  const script = args.args[flag + 1];
  if (flag < 0 || typeof script !== 'string' || !readCall.test(script) || sideEffect.test(script)) return undefined;
  const target = literalPath.exec(script)?.[2];
  return { script, ...(target ? { target } : {}) };
}

/** Read-only script classification from the request alone, independent of the call's outcome. */
export function scriptReadRequest(store: Store, call: Call): { script: string; target?: string } | undefined {
  if (call.kind !== 'tool' || !['process.exec', 'shell.exec'].includes(call.name)) return undefined;
  try { return readScript(call.name, JSON.parse(store.readBlob<{ arguments: string }>(call.requestRef).arguments) as Record<string, unknown>); }
  catch { return undefined; }
}

/**
 * Classifies a successful exec call that only reads files through an inline
 * Node script (`node -e "fs.readFileSync(...)"`) or a plain read command. Such
 * calls bypass `file.read`, so progress checks count them as investigation and
 * key unchanged repeats by script text plus output hash. Detection is a
 * heuristic over literal arguments, never a permission or sandbox decision.
 */
export function scriptRead(store: Store, call: Call): { key: string; label: string } | undefined {
  if (call.status !== 'succeeded' || !call.resultRef) return undefined;
  const read = scriptReadRequest(store, call);
  if (!read) return undefined;
  try {
    const result = store.readBlob<{ exitCode?: unknown; stdout?: unknown }>(call.resultRef);
    if (result.exitCode !== 0 || typeof result.stdout !== 'string') return undefined;
    const output = createHash('sha256').update(result.stdout).digest('hex');
    return { key: JSON.stringify([call.name, read.script, output]), label: `${read.target ?? 'inline script'} (via ${call.name})` };
  } catch { return undefined; }
}
