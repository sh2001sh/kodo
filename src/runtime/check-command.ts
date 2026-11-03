/**
 * Recognizes a test-runner invocation inside a shell command line so check reuse and
 * the repository-wide pass notice can ignore output filtering and timeout wrappers.
 * Anything this parser cannot read with confidence yields undefined, never a guess.
 */

type Separator = ';' | '&&' | '||' | '|' | '';
interface Segment { words: string[]; next: Separator; outputFiltered: boolean; inputRedirected: boolean }

/**
 * The comparable identity of a test command, whether it selects the whole default suite, and how its
 * result is observable: the command's own exit code, a final `echo PREFIX$status` line, or not at all.
 */
export interface CheckCommand { key: string; wholeSuite: boolean; exit: 'code' | 'marker' | 'unknown'; marker?: string }

/** Split on separators outside quotes; substitutions, heredocs and background jobs are not parsed. */
function segments(command: string): Segment[] | undefined {
  const result: Segment[] = [];
  let words: string[] = [], word = '', inWord = false, quotedWord = false, quote: string | undefined;
  let redirect: { operator: string; fd: string } | undefined, outputFiltered = false, inputRedirected = false, valid = true;
  const flush = (): void => {
    if (inWord) {
      if (redirect) {
        // Duplicating stdout/stderr keeps captured content; files, closed FDs and other FDs do not.
        outputFiltered ||= redirect.operator.includes('>')
          && !(redirect.operator === '>&' && /^[12]$/.test(word) && /^[12]?$/.test(redirect.fd));
        redirect = undefined;
      } else words.push(word);
    }
    word = ''; inWord = false; quotedWord = false;
  };
  const end = (next: Separator): void => {
    flush(); if (redirect) valid = false;
    if (words.length) result.push({ words, next, outputFiltered, inputRedirected });
    words = []; outputFiltered = false; inputRedirected = false;
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!, following = command[index + 1];
    if (quote) {
      if (quote === '"' && (character === '`' || (character === '$' && following === '('))) return undefined;
      if (character === quote) quote = undefined;
      else if (character === '\\' && quote === '"') word += command[++index] ?? '';
      else word += character;
      continue;
    }
    if (character === '`' || character === '(' || character === ')' || (character === '$' && following === '(') || (character === '<' && following === '<')) return undefined;
    if (character === "'" || character === '"') { quote = character; inWord = true; quotedWord = true; continue; }
    if (character === '\\') { word += command[++index] ?? ''; inWord = true; quotedWord = true; continue; }
    if (character === ' ' || character === '\t') { flush(); continue; }
    if (character === '>' || character === '<' || (character === '&' && following === '>')) {
      const fd = !quotedWord && /^\d+$/.test(word) ? word : '';
      if (fd) { word = ''; inWord = false; } else flush();
      if (redirect) return undefined;
      let operator = character;
      if (character === '&') { operator += '>'; index++; }
      else if (following === character || following === '&' || following === '|') { operator += following; index++; }
      redirect = { operator, fd };
      inputRedirected ||= operator.includes('<');
      continue;
    }
    if (character === ';' || character === '\n') { end(';'); continue; }
    if (character === '&') {
      if (following !== '&') return undefined;
      end('&&'); index++; continue;
    }
    if (character === '|') { end(following === '|' ? '||' : '|'); if (following === '|') index++; continue; }
    word += character; inWord = true;
  }
  if (quote) return undefined;
  end('');
  return valid ? result : undefined;
}

const viewers = new Set(['tail', 'head', 'grep', 'egrep', 'rg', 'cat', 'echo', 'printf', 'wc', 'cut', 'sort', 'uniq', 'tee', 'true', 'awk']);
const gitViews = new Set(['status', 'diff', 'log', 'show']);
const isViewer = (words: string[]): boolean => viewers.has(words[0]!) || (words[0] === 'sed' && !words.some(word => word.startsWith('-i')))
  || (words[0] === 'git' && gitViews.has(words[1]!) && !words.some(word => word.startsWith('--output')));
const isCapture = (words: string[]): string | undefined => words.length === 1 ? /^(\w+)=\$\?$/.exec(words[0]!)?.[1] : undefined;

/** Drop `timeout [options] DURATION`; environment assignments stay because they change the check. */
function withoutTimeout(words: string[]): string[] {
  let index = words.findIndex(word => !/^\w+=/.test(word));
  if (index < 0 || words[index] !== 'timeout') return words;
  const prefix = words.slice(0, index);
  index++;
  while (words[index]?.startsWith('-')) index += ['-s', '-k', '--signal', '--kill-after'].includes(words[index]!) ? 2 : 1;
  return [...prefix, ...words.slice(index + 1)];
}

const pytestValueFlags = new Set(['-n', '-p', '-c', '-o', '-r', '-W', '--rootdir', '--cov-report', '--cov-config', '--cov-fail-under', '--junitxml', '--junit-xml', '--maxfail', '--tb', '--durations', '--basetemp', '--confcutdir', '--log-level', '--timeout', '--dist', '--import-mode', '--color']);
const narrowing = new Set(['-k', '-m', '--lf', '--last-failed', '--sw', '--stepwise', '--deselect', '--ignore', '--ignore-glob', '--collect-only', '--co', '--setup-only', '--setup-plan', '--fixtures', '--markers', '--version', '-V', '--help', '-h', '-t', '--testNamePattern', '--changed', '--related']);

/** Runner arguments, or undefined when the words are not a recognized test runner. */
function runnerArguments(words: string[]): { runner: string; args: string[] } | undefined {
  const start = words.findIndex(word => !/^\w+=/.test(word));
  let rest = start < 0 ? [] : words.slice(start);
  if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch'].includes(rest[0]!) && rest[1] === 'run') rest = rest.slice(2);
  if (rest[0] === 'npx' || rest[0] === 'bunx') rest = rest.slice(1);
  const [first, second] = rest;
  if (/^python(3(\.\d+)?)?$/.test(first ?? '') && second === '-m' && rest[2] === 'pytest') return { runner: 'pytest', args: rest.slice(3) };
  if (first === 'pytest' || first === 'py.test') return { runner: 'pytest', args: rest.slice(1) };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(first ?? '') && (second === 'test' || (second === 'run' && rest[2] === 'test'))) return { runner: 'script', args: rest.slice(second === 'test' ? 2 : 3) };
  if (first === 'vitest' || first === 'jest') return { runner: 'js', args: rest.slice(1).filter(word => word !== 'run') };
  if (first === 'go' && second === 'test') return { runner: 'go', args: rest.slice(2) };
  if (first === 'cargo' && second === 'test') return { runner: 'cargo', args: rest.slice(2) };
  return undefined;
}

/** Whether the arguments select the whole default suite; unknown value-taking flags read as narrowing. */
function wholeSuite(runner: string, args: string[]): boolean {
  if (runner === 'script') return args.length === 0;
  if (runner === 'go') return args.filter(word => !word.startsWith('-')).every(word => word === './...') && args.includes('./...');
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!, flag = word.split('=')[0]!;
    if (narrowing.has(flag)) return false;
    if (!word.startsWith('-')) return false;
    if (runner === 'pytest' && !word.includes('=') && pytestValueFlags.has(word)) index++;
  }
  return true;
}

/** `echo PREFIX$v` printing a captured status; returns PREFIX. */
function echoMarker(words: string[], variable: string): string | undefined {
  if (words[0] !== 'echo' || words.length !== 2) return undefined;
  const word = words[1]!;
  for (const reference of [`$${variable}`, `\${${variable}}`]) {
    if (word.endsWith(reference) && !word.slice(0, -reference.length).includes('$')) return word.slice(0, -reference.length);
  }
  return undefined;
}

/**
 * Parse `[cd DIR &&] RUNNER ARGS [| viewers] [&& viewers | ; v=$? ; viewers ; exit $v | echo X$v]`.
 * The key is the directory plus runner argv without redirects or timeouts. The host runs Bash with
 * pipefail (tools/shell.ts), so viewer pipelines and `&&` chains keep the runner's failure; `;` and
 * `||` hide it unless the status is captured and returned or printed last.
 */
export function parseCheckCommand(command: string): CheckCommand | undefined {
  const parts = segments(command);
  if (!parts?.length) return undefined;
  // Input redirection changes the check's inputs, not just its presentation.
  if (parts.some(part => part.inputRedirected)) return undefined;
  const runnerIndex = parts.findIndex(part => runnerArguments(withoutTimeout(part.words)));
  if (runnerIndex < 0) return undefined;
  const before = parts.slice(0, runnerIndex);
  if (!before.every(part => part.words[0] === 'cd' && part.words.length === 2 && part.next === '&&')) return undefined;
  const runnerWords = withoutTimeout(parts[runnerIndex]!.words);
  const { runner, args } = runnerArguments(runnerWords)!;
  const result = (exit: CheckCommand['exit'], marker?: string): CheckCommand => ({
    key: JSON.stringify([...before.map(part => part.words[1]!), ...runnerWords]), wholeSuite: wholeSuite(runner, args), exit, ...(marker === undefined ? {} : { marker }),
  });
  let end = runnerIndex;
  while (parts[end]!.next === '|') { end++; if (!parts[end] || !isViewer(parts[end]!.words)) return undefined; }
  const rest = parts.slice(end + 1);
  const capture = parts[end]!.next === ';' ? isCapture(rest[0]?.words ?? []) : undefined;
  if (capture) {
    const after = rest.slice(1), last = after.at(-1);
    if (!after.slice(0, -1).every(part => isViewer(part.words))) return undefined;
    if (!last) return result('unknown');
    // The saved status must be captured in this shell and consumed unconditionally.
    // Viewer pipelines are allowed between semicolons, but cannot gate the final result.
    if (rest[0]!.next !== ';' || rest.at(-2)!.next !== ';'
      || after.slice(0, -1).some(part => part.next !== ';' && part.next !== '|')) return result('unknown');
    if (last.words.length === 2 && last.words[0] === 'exit' && last.words[1] === `$${capture}`) return result('code');
    const marker = echoMarker(last.words, capture);
    if (marker !== undefined) return result('marker', marker);
    return isViewer(last.words) ? result('unknown') : undefined;
  }
  let chained = true;
  for (const [offset, part] of rest.entries()) {
    if (!isViewer(part.words)) return undefined;
    const joiner = offset === 0 ? parts[end]!.next : rest[offset - 1]!.next;
    if (joiner !== '&&' && joiner !== '|') chained = false;
  }
  return result(chained ? 'code' : 'unknown');
}

/** Call-format guidance only, not a shell permission classifier. Unknown shell syntax stays unknown. */
export function checkOutputFiltered(command: string): boolean {
  return segments(command)?.some(part => Boolean(runnerArguments(withoutTimeout(part.words)))
    && (part.outputFiltered || part.next === '|')) ?? false;
}

/**
 * Whether a recorded result shows the check passing. Unparsed commands remain unknown;
 * a printed status must be the complete output's last line.
 */
export function checkPassed(command: string, result: unknown): boolean {
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (value.exitCode !== 0 || value.timedOut === true || value.cancelled === true || value.outputLimitExceeded === true) return false;
  const parsed = parseCheckCommand(command);
  if (!parsed) return false;
  if (parsed.exit === 'code') return true;
  if (parsed.exit === 'unknown' || value.truncated === true || typeof value.stdout !== 'string') return false;
  return value.stdout.trimEnd().split('\n').at(-1)?.trim() === `${parsed.marker}0`;
}
