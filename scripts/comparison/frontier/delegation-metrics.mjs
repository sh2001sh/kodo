// Read-only analysis. Usage: node delegation-metrics.mjs CELL_DIR [--database DB] [--source-root PATH,PATH] [--out FILE]
// Unknown evidence remains unknown; a model's claim or a successful process exit is not proof of a source change.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildSteps, summarize } from './trace.mjs';

const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const jsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [];
const hash = text => createHash('sha256').update(text).digest('hex');
const shellNames = new Set(['shell.exec', 'process.exec', 'bash', 'shell']);
const normalizeName = name => name.replace(/^(file|shell|process|artifact|todo|agent)_(?=[a-z])/u, '$1.');
const millis = value => typeof value === 'number' ? value : Date.parse(value);
const seconds = (end, start) => Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) / 1000 : null;
const count = values => { const out = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return out; };
/** A bounded lexer for evidence, never an executor. Unsupported expansion/control syntax stays unknown. */
function shellWords(source) {
  if (/[\r\n`]/u.test(source)) return null;
  const tokens = [];
  let word = '', quote = null, present = false;
  const flush = () => { if (present) tokens.push({ word }); word = ''; present = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '$' && quote === '"') return null;
      if (c === '\\' && quote === '"' && /[\\"$`]/u.test(source[i + 1] ?? '')) { word += source[++i]; continue; }
      word += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; present = true; continue; }
    if (c === '\\') { if (i + 1 === source.length) return null; word += source[++i]; present = true; continue; }
    if (/[${}()#]/u.test(c)) return null;
    if (/\s/u.test(c)) { flush(); continue; }
    if (';&|<>'.includes(c)) {
      if (c === '<') return null;
      const fd = c === '>' && /^\d+$/u.test(word) ? word : '';
      if (fd) { word = ''; present = false; } else flush();
      if (c === '&') { if (source[++i] !== '&') return null; tokens.push({ op: '&&' }); }
      else if (c === '|') { if (source[i + 1] === '|') return null; tokens.push({ op: '|' }); }
      else if (c === '>') { const extra = ['>', '&'].includes(source[i + 1]) ? source[++i] : ''; tokens.push({ op: `${fd}>${extra}` }); }
      else tokens.push({ op: ';' });
      continue;
    }
    word += c; present = true;
  }
  if (quote) return null;
  flush();
  return tokens;
}

const commandName = program => program.replaceAll('\\', '/').split('/').at(-1).replace(/\.exe$/iu, '');
const plainFile = value => typeof value === 'string' && value !== '-' && !/[*?[~]/u.test(value);

/** Classification describes requested operations, not whether every command in a chain actually ran. */
export function classifyCommand(command) {
  if (typeof command !== 'string') return { kind: 'unknown' };
  const tokens = shellWords(command.trim());
  if (!tokens?.length) return { kind: 'unknown' };
  const groups = [];
  let argv = [], redirections = [], after = null;
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    if (token?.word !== undefined) { argv.push(token.word); continue; }
    if (token?.op?.includes('>')) {
      const destination = tokens[++i]?.word;
      if (destination === undefined) return { kind: 'unknown' };
      redirections.push([token.op, destination]); continue;
    }
    if (!argv.length) return { kind: 'unknown' };
    groups.push({ argv, redirections, after: token?.op ?? null, before: after });
    after = token?.op ?? null; argv = []; redirections = [];
  }
  let cwd;
  if (groups[0].argv[0] === 'cd') {
    const first = groups.shift();
    const paths = first.argv.slice(1).filter(value => value !== '--');
    if (first.after !== '&&' || first.redirections.length || paths.length !== 1 || !plainFile(paths[0]) || paths[0].startsWith('-')) return { kind: 'unknown' };
    cwd = paths[0];
  }
  if (!groups.length) return { kind: 'unknown' };
  const output = (kind, extra = {}) => ({ kind, ...(cwd ? { cwd } : {}), ...extra });
  // A single literal output redirection is an intended write. Its completion still needs separate evidence.
  if (groups.length === 1 && ['echo', 'printf'].includes(groups[0].argv[0]) && groups[0].redirections.length === 1 && groups[0].redirections[0][0] === '>') return output('write', { path: groups[0].redirections[0][1] });
  const components = [];
  const reads = [];
  for (const group of groups) {
    if (group.redirections.some(([op, value]) => !(op === '2>' && value === '/dev/null' || op === '2>&' && value === '1'))) return output('unknown');
    let [program, ...args] = group.argv;
    if (program === 'timeout' && /^\d+(?:[smh])?$/u.test(args[0] ?? '') && args.length > 1) [program, ...args] = args.slice(1);
    const name = commandName(program);
    const piped = group.before === '|';
    const filter = piped && (
      ['head', 'tail'].includes(name) && (args.length === 0 || args.length === 1 && /^-\d+$/u.test(args[0]) || args.length === 2 && args[0] === '-n' && /^\d+$/u.test(args[1]))
      || name === 'sed' && args.length === 2 && args[0] === '-n' && /^\d+(?:,\d+)?p$/u.test(args[1])
      || name === 'wc' && args.every(arg => /^-[lwc]$/u.test(arg))
      || ['grep', 'rg'].includes(name) && args.length > 0 && args.every(arg => !/^--pre(?:=|$)/u.test(arg)));
    if (piped && !filter) return output('unknown');
    if (filter) { components.push({ kind: ['grep', 'rg'].includes(name) ? 'search' : 'filter', program: name }); continue; }
    const classified = classifyArgv(program, args);
    if (classified.kind === 'unknown' && classified.reason !== 'non-file-operation') return output('unknown');
    components.push(classified.reason === 'non-file-operation' ? { kind: 'non-file-operation' } : classified);
    if (classified.kind === 'read' && plainFile(classified.path)) reads.push({ path: classified.path, section: classified.section, ...(cwd ? { cwd } : {}), outputAttributable: groups.length === 1 && group.redirections.length === 0 });
  }
  const kinds = components.map(component => component.kind);
  const kind = ['write', 'test', 'git', 'search', 'read'].find(candidate => kinds.includes(candidate)) ?? 'unknown';
  if (kind === 'unknown' && kinds.every(value => value === 'non-file-operation' || value === 'filter')) return output('unknown', { reason: 'non-file-operation' });
  // Retain the original single-read shape, while compounds retain all requested paths/ranges.
  if (groups.length === 1) {
    const component = components[0];
    return output(kind, component.path && plainFile(component.path) ? { path: component.path, section: component.section, ...(groups[0].redirections.length ? { outputAttributable: false } : {}) } : {});
  }
  return output(kind, { components, reads, compound: true, outputAttributable: false });
}

/** Native process.exec supplies argv, not shell source; metacharacters in arguments are literal. */
export function classifyArgv(program, argv = []) {
  if (typeof program !== 'string' || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) return { kind: 'unknown' };
  const name = commandName(program);
  if (name === 'cat' && argv.length === 1 && !argv[0].startsWith('-')) return { kind: 'read', path: argv[0], section: 'all' };
  const sed = name === 'sed' && argv.length === 3 && argv[0] === '-n' && /^(\d+)(?:,(\d+))?p$/u.exec(argv[1]);
  if (sed) return { kind: 'read', path: argv[2], section: `${sed[1]}:${sed[2] ?? sed[1]}` };
  if (['head', 'tail'].includes(name)) {
    if (argv.length === 3 && argv[0] === '-c' && /^\d+$/u.test(argv[1]) && !argv[2].startsWith('-')) return { kind: 'read', path: argv[2], section: name === 'head' ? `head-bytes:${argv[1]}` : `tail-bytes:${argv[1]}` };
    const amount = argv.length === 3 && argv[0] === '-n' && /^\d+$/u.test(argv[1]) ? argv[1] : argv.length === 2 && /^-\d+$/u.test(argv[0]) ? argv[0].slice(1) : argv.length === 1 ? '10' : null;
    if (amount && !argv.at(-1).startsWith('-')) return { kind: 'read', path: argv.at(-1), section: name === 'head' ? `1:${amount}` : `tail:${amount}` };
  }
  if (['rg', 'grep', 'find', 'ls'].includes(name) && !argv.some(arg => /^-(?:exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$|^--pre(?:=|$)/u.test(arg))) return { kind: 'search' };
  if (name === 'git') return { kind: 'git' };
  if (['echo', 'printf', 'pwd', 'true', 'pgrep', 'which', 'wc'].includes(name)) return { kind: 'unknown', reason: 'non-file-operation' };
  if (['pytest', 'vitest'].includes(name) || /^python\d*$/u.test(name) && argv[0] === '-m' && argv[1] === 'pytest' || name === 'node' && argv[0] === '--test' || ['npm', 'pnpm', 'yarn'].includes(name) && (argv[0] === 'test' || argv[0] === 'run' && argv[1] === 'test')) return { kind: 'test' };
  return { kind: 'unknown' };
}

function sourcePath(candidate, workspace, sourceRoots) {
  if (typeof candidate !== 'string') return null;
  const windows = /^[A-Za-z]:[\\/]/u.test(workspace);
  const platform = windows ? path.win32 : path.posix;
  const base = workspace || '/';
  const relative = platform.relative(base, platform.resolve(base, candidate)).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || platform.isAbsolute(relative) || /^(?:\.git|\.kodo|node_modules|tmp)(?:\/|$)/u.test(relative)) return null;
  if (sourceRoots.length) return sourceRoots.some(root => relative === root || relative.startsWith(`${root}/`)) ? relative : null;
  return /\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|cs|swift|kt|rb|php|sh|sql|html|css|vue|svelte)$/iu.test(relative) ? relative : null;
}

const requestedReads = action => action.classification.reads ?? (action.classification.kind === 'read' && action.classification.path ? [action.classification] : []);
const hasKind = (action, kind) => action.classification.kind === kind || action.classification.components?.some(component => component.kind === kind);

function readIdentities(action, workspace) {
  const { args, result, name } = action;
  if (action.status !== 'succeeded') return [];
  const native = name === 'file.read';
  const sources = native ? [{ path: args.path }] : requestedReads(action);
  return sources.filter(source => source.path).map(source => {
    const platform = /^[A-Za-z]:/u.test(workspace) ? path.win32 : path.posix;
    const absolute = platform.resolve(workspace, args.cwd ?? '.', source.cwd ?? '.', source.path).replaceAll('\\', '/');
    const offset = result?.offset ?? args.offset ?? 1;
    const limit = result?.limit ?? args.limit;
    const section = native ? `${offset}:${limit === undefined ? 'end' : offset + limit - 1}${result?.truncated || result?.contentOffset || args.contentOffset ? `:chars:${result?.contentOffset ?? args.contentOffset ?? 0}:${args.maxChars ?? 'default'}` : ''}` : source.section;
    // A compound's combined output cannot be split into invented per-file content/hash observations.
    const content = native ? result?.content : result?.stdout;
    const attributable = native || source.outputAttributable !== false && !action.classification.compound;
    const completeOutput = attributable && result && !result.truncated && !result.outputLimitExceeded;
    const observedHash = native && typeof result?.hash === 'string' ? `file:${result.hash}` : completeOutput && typeof content === 'string' ? `range:${hash(content)}` : null;
    return { path: absolute, section, observedHash };
  });
}

function actionsFor(steps, timings, records) {
  const occurrences = count(steps.flatMap(step => step.toolCalls.map(tool => tool.id)));
  const byId = new Map(timings.filter(tool => tool.runId || occurrences[tool.callId] === 1).map(tool => [tool.runId ? `${tool.runId}:${tool.callId}` : tool.callId, tool]));
  const persisted = new Map(records.map(call => [`${call.runId}:${call.id.slice(call.id.indexOf(':') + 1)}`, call]));
  return steps.flatMap(step => step.toolCalls.map(tool => {
    const name = normalizeName(tool.name);
    const args = parse(tool.arguments) ?? {};
    const raw = step.results.find(result => result.toolCallId === tool.id)?.content;
    const result = parse(raw);
    const timing = byId.get(`${step.runId}:${tool.id}`) ?? byId.get(tool.id);
    const record = persisted.get(`${step.runId}:${tool.id}`);
    const resultFailed = result?.error || result?.isError || result?.timedOut || result?.cancelled || result?.exitCode && result.exitCode !== 0;
    const status = resultFailed ? 'failed' : record?.status ?? (result ? 'succeeded' : 'unknown');
    const command = name === 'process.exec' && typeof args.program === 'string' ? [args.program, ...(args.args ?? []).map(arg => JSON.stringify(arg))].join(' ') : typeof args.command === 'string' ? args.command : '';
    const classification = name === 'process.exec' && args.program ? classifyArgv(args.program, args.args) : shellNames.has(name) ? classifyCommand(command) : { kind: name === 'file.read' ? 'read' : ['file.list', 'file.search'].includes(name) ? 'search' : /^file\.(?:patch|apply_patch|mkdir|rename|delete)$/u.test(name) ? 'write' : 'other' };
    return { step: step.step, runId: step.runId, callId: tool.id, name, args, result, status, classification, command,
      startMs: timing?.startMs ?? step.endedMs ?? millis(step.startedAt), endMs: timing?.endMs ?? null };
  }));
}

function diffPaths(text) {
  return [...text.matchAll(/^(?:diff --git a\/.*? b\/(.+)|\s*([^\n|]+?)\s+\|\s+\d+\s+[+-]+)/gmu)].map(match => (match[1] ?? match[2]).trim());
}

/** Finds observed source changes; interval/candidate fields intentionally do not claim exact causation. */
function modificationEvidence(actions, snapshots, workspace, sourceRoots, startMs) {
  const observations = [];
  const unconfirmedNativeMutations = [];
  for (const action of actions) {
    const target = sourcePath(action.args.path, workspace, sourceRoots);
    if (target && ['file.patch', 'file.apply_patch'].includes(action.name) && action.status === 'succeeded' && Object.hasOwn(action.args, 'expectedHash') && action.result?.hash && action.args.expectedHash !== action.result.hash) {
      observations.push({ step: action.step, atMs: action.endMs ?? action.startMs, kind: 'hash-change', paths: [target], interval: { afterMs: action.startMs, byMs: action.endMs } });
    }
    if (['file.rename', 'file.delete'].includes(action.name)) {
      const destination = action.name === 'file.rename' ? sourcePath(action.args.destination, workspace, sourceRoots) : null;
      const paths = [...new Set([target, destination].filter(Boolean))];
      // These tools return the old content hash: unchanged bytes do not mean unchanged source paths.
      const validResult = action.status === 'succeeded' && typeof action.args.expectedHash === 'string'
        && action.result?.hash === action.args.expectedHash && action.result?.path === action.args.path
        && (action.name === 'file.delete' ? action.result.deleted === true
          : typeof action.args.destination === 'string' && action.result.destination === action.args.destination && action.args.path !== action.args.destination);
      if (paths.length && validResult) observations.push({ step: action.step, atMs: action.endMs ?? action.startMs,
        kind: action.name === 'file.delete' ? 'native-delete' : 'native-rename', paths,
        interval: { afterMs: action.startMs, byMs: action.endMs } });
      else if (paths.length && !action.result?.notStarted) unconfirmedNativeMutations.push({ step: action.step, callId: action.callId, name: action.name, status: action.status, paths, reason: 'No complete successful native mutation result was recorded.' });
    }
    if ((/\bgit\s+diff\b/u.test(action.command) || action.name === 'process.exec' && /(?:^|[\\/])git(?:\.exe)?$/u.test(action.args.program ?? '') && action.args.args?.[0] === 'diff') && action.result?.stdout) {
      const paths = diffPaths(action.result.stdout).map(value => sourcePath(value, workspace, sourceRoots)).filter(Boolean);
      if (paths.length) observations.push({ step: action.step, atMs: action.endMs ?? action.startMs, kind: 'diff-observation', paths });
    }
  }
  let cleanAt = null;
  for (const snapshot of snapshots) {
    if (snapshot.bytes === 0) { cleanAt = millis(snapshot.at); continue; }
    const paths = diffPaths(snapshot.patch ?? '').map(value => sourcePath(value, workspace, sourceRoots)).filter(Boolean);
    if (paths.length) observations.push({ step: null, atMs: millis(snapshot.at), kind: 'snapshot-observation', paths, interval: { afterMs: cleanAt, byMs: millis(snapshot.at) } });
  }
  observations.sort((a, b) => a.atMs - b.atMs);
  const first = observations[0] ?? null;
  if (!first) return { firstObserved: null, candidateSteps: [], unconfirmedNativeMutations, limitation: 'No target source change was proved by recorded hashes or diff output.' };
  const lastClean = snapshots.filter(snapshot => snapshot.bytes === 0 && millis(snapshot.at) <= first.atMs).at(-1);
  first.interval ??= { afterMs: lastClean ? millis(lastClean.at) : null, byMs: first.atMs };
  first.baselineKnownClean = Boolean(lastClean);
  const candidates = actions.filter(action => action.startMs <= first.atMs && (action.endMs ?? action.startMs) >= (first.interval.afterMs ?? startMs) && (action.classification.kind === 'write' || action.classification.kind === 'unknown') && first.paths.some(target => action.args.path === target || action.command.includes(target)));
  return { firstObserved: first, candidateSteps: [...new Set(candidates.map(action => action.step))], unconfirmedNativeMutations, limitation: ['hash-change', 'native-delete', 'native-rename'].includes(first.kind) ? 'Observed native source mutation; timestamp bounded by call execution.' : 'Diff proves observed project changes, not which prior command caused them; candidate steps require manual inspection.' };
}

function overlappingSeconds(intervals) {
  const events = intervals.flatMap(([from, to]) => [[from, 1], [to, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, previous = 0, overlap = 0;
  for (const [time, delta] of events) { if (active > 1) overlap += time - previous; active += delta; previous = time; }
  return overlap / 1000;
}

/** Run rows and committed host events prove dispatch; declarations and preparation reservations do not. */
function observedDispatches(runs, events) {
  const records = new Map();
  const add = (id, parentId, data, source, at, committed = false) => {
    if (typeof id !== 'string' || typeof parentId !== 'string' || id === parentId) return;
    const previous = records.get(id);
    // A persisted run row wins over inconsistent event metadata; never count the same run twice.
    if (previous && previous.parentId !== parentId) return;
    const time = millis(at);
    records.set(id, { ...data, ...Object.fromEntries(Object.entries(previous ?? {}).filter(([, value]) => value !== undefined)), id, parentId, atMs: committed && Number.isFinite(time) ? time : previous?.atMs ?? (Number.isFinite(time) ? time : null), sources: [...new Set([...(previous?.sources ?? []), source])] });
  };
  for (const run of runs) if (run.parentId) add(run.id, run.parentId, { nodeId: run.taskNode?.nodeId, generation: run.taskNode?.generation, role: run.taskNode?.role, agentId: run.agentId, continuationOf: run.continuationOf }, 'run.parentId', run.createdAt);
  for (const event of events) {
    if (event.type === 'task.dispatch.committed') add(event.data?.runId, event.runId, { nodeId: event.data?.nodeId, generation: event.data?.generation }, event.type, event.time, true);
    if (event.type === 'agent.spawned') add(event.runId, event.data?.parentId, { nodeId: event.data?.nodeId, generation: event.data?.generation }, event.type, event.time);
  }
  return [...records.values()];
}

function graphHandoff(actions, dispatch) {
  if (!dispatch?.nodeId || dispatch.atMs === null) return undefined;
  const own = actions.filter(action => action.runId === dispatch.parentId && action.status === 'succeeded' && (dispatch.atMs === null || action.startMs <= dispatch.atMs));
  const declaration = own.flatMap(action => action.name === 'delegate' ? (action.args.tasks ?? []).filter(task => task.id === dispatch.nodeId && task.owner !== 'self').map(task => ({ action, task })) : []).at(-1);
  if (!declaration) return undefined;
  const continuation = own.filter(action => action.name === 'task' && ['resume', 'redo'].includes(action.args.action) && action.args.node_id === dispatch.nodeId).at(-1);
  const action = continuation ?? declaration.action;
  return { ...action, args: { ...action.args, inputs: [...(declaration.task.start ?? []), ...(continuation?.args.input ? [continuation.args.input] : [])], scope: { write: declaration.task.scope ?? [] } } };
}

/** Pure entry point for deterministic fixtures. Database and source files are never mutated. */
export function delegationMetrics({ steps, runs = [], events = [], calls = [], timings = [], snapshots = [], workspace = '/', sourceRoots = [], verifier = null, nativeEvidenceAvailable = runs.length > 0 || events.length > 0 }) {
  const actions = actionsFor(steps, timings, calls);
  const graphEvidence = actions.some(action => ['delegate', 'task'].includes(action.name)) || runs.some(run => run.taskNode) || events.some(event => event.type.startsWith('task.'));
  const actualDispatches = graphEvidence ? observedDispatches(runs, events) : [];
  const dispatchedIds = action => [action.result?.id, action.result?.runId, ...(action.result?.runs ?? []).map(run => run.id)].filter(Boolean);
  const handoffFor = id => actions.find(action => ['spawn_agent', 'followup_task', 'explore'].includes(action.name) && dispatchedIds(action).includes(id)) ?? graphHandoff(actions, actualDispatches.find(dispatch => dispatch.id === id));
  const knownIds = [...new Set([...steps.map(step => step.runId).filter(Boolean), ...runs.map(run => run.id), ...actualDispatches.flatMap(dispatch => [dispatch.parentId, dispatch.id])])];
  const allStart = Math.min(...steps.map(step => step.startedMs ?? millis(step.startedAt)));
  const allEnd = Math.max(...steps.map(step => step.endedMs ?? millis(step.startedAt) + step.modelSec * 1000));
  const modifications = modificationEvidence(actions, snapshots, workspace, sourceRoots, allStart);
  const perRun = knownIds.map(id => {
    const run = runs.find(item => item.id === id);
    const own = actions.filter(action => action.runId === id);
    const requests = steps.filter(step => step.runId === id);
    const start = run?.createdAt ? millis(run.createdAt) : requests[0]?.startedMs;
    const dispatches = own.filter(action => ['spawn_agent', 'followup_task', 'explore'].includes(action.name) || action.name === 'delegate' || action.name === 'task' && ['resume', 'redo'].includes(action.args.action));
    const successful = dispatches.filter(action => action.status === 'succeeded' && (action.result?.id || action.result?.runId || action.result?.runs?.length));
    const actual = actualDispatches.filter(dispatch => dispatch.parentId === id);
    const firstActual = actual.filter(dispatch => dispatch.atMs !== null).sort((a, b) => a.atMs - b.atMs)[0];
    const firstDispatch = graphEvidence ? firstActual ? { step: requests.filter(step => (step.startedMs ?? millis(step.startedAt)) <= firstActual.atMs).at(-1)?.step ?? null, startMs: firstActual.atMs, endMs: firstActual.atMs } : undefined : successful[0];
    const handoff = handoffFor(id);
    const handoffInputs = handoff?.args.inputs ?? handoff?.args.questions?.flatMap(question => question.inputs ?? []) ?? [];
    const handedPaths = [...new Set(handoffInputs.flatMap(input => String(input).match(/[\w.-]+(?:\/[\w.-]+)+/gu) ?? []))];
    const searchesOfHandedPaths = own.filter(action => hasKind(action, 'search') && handedPaths.some(target => JSON.stringify(action.args).includes(target) || action.args.path === path.posix.dirname(target)));
    const scopeDispatches = graphEvidence ? actual.flatMap(dispatch => { const packet = graphHandoff(actions, dispatch); return packet && dispatch.atMs !== null ? [{ ...packet, dispatchedAt: dispatch.atMs }] : []; }) : successful;
    const readsAfterDispatch = own.filter(action => (action.name === 'file.read' || requestedReads(action).length) && scopeDispatches.some(dispatch => (graphEvidence ? dispatch.dispatchedAt < action.startMs : dispatch.step < action.step) && (dispatch.args.scope?.write ?? dispatch.result?.scope?.write ?? []).some(root => {
      const targets = action.name === 'file.read' ? [action.args.path] : requestedReads(action).map(read => read.path);
      return targets.some(target => typeof target === 'string' && (target === root || target.startsWith(`${root}/`)));
    })));
    const childCompletionTimes = graphEvidence
      ? events.filter(event => event.runId === id && event.type === 'task.node.updated' && event.data?.node?.owner === 'agent' && event.data.node.state === 'done').map(event => millis(event.time))
      : runs.filter(child => child.parentId === id).map(child => events.find(event => event.runId === child.id && event.type === 'run.completed')?.time).filter(Boolean).map(millis);
    const deliveredAt = childCompletionTimes.length ? Math.max(...childCompletionTimes) : null;
    const ownModification = modificationEvidence(own, run?.parentId ? [] : snapshots, workspace, sourceRoots, start);
    const boundary = Math.min(firstDispatch?.step ?? Infinity, ownModification.candidateSteps[0] ?? ownModification.firstObserved?.step ?? Infinity);
    const before = requests.filter(step => step.step < boundary);
    const reads = new Map();
    let confirmedDuplicateReads = 0, unchangedRangeReads = 0, unknownRepeatReads = 0;
    const isReviewer = /review/iu.test(run?.card?.id ?? '') || run?.taskNode?.role === 'reviewer';
    for (const action of own) {
      for (const identity of readIdentities(action, workspace)) {
      const key = `${identity.path}:${identity.section}`;
      const previous = reads.get(key);
      if (previous && !isReviewer) {
        if (!identity.observedHash || !previous.observedHash) unknownRepeatReads++;
        else if (identity.observedHash === previous.observedHash) {
          if (identity.observedHash.startsWith('file:')) confirmedDuplicateReads++; else unchangedRangeReads++;
        }
      }
      reads.set(key, identity);
      }
    }
    const checks = own.filter(action => action.classification.kind === 'test');
    const priorChecks = new Map();
    let repeatedChecksUnknownState = 0;
    for (const action of checks) { if (priorChecks.has(action.command)) repeatedChecksUnknownState++; priorChecks.set(action.command, true); }
    const toolsChanges = requests.filter(step => step.prefix?.toolsChanged).map(step => step.step);
    const input = requests.reduce((n, step) => n + (step.inputTokens ?? 0), 0);
    const cached = requests.reduce((n, step) => n + (step.cachedTokens ?? 0), 0);
    const ended = events.find(event => event.runId === id && /^run\.(completed|failed|cancelled)$/u.test(event.type));
    const children = graphEvidence ? actual.map(dispatch => runs.find(child => child.id === dispatch.id) ?? { id: dispatch.id, parentId: id, status: events.filter(event => event.runId === dispatch.id && /^run\.(queued|started|waiting|interrupted|completed|failed|cancelled)$/u.test(event.type)).at(-1)?.type.slice(4) ?? 'unknown' }) : runs.filter(child => child.parentId === id);
    const childStates = children.map(child => {
      const history = events.filter(event => event.runId === child.id && (!ended || millis(event.time) <= millis(ended.time)) && /^run\.(queued|started|waiting|interrupted|completed|failed|cancelled)$/u.test(event.type));
      const event = history.at(-1);
      return { id: child.id, statusAtParentEnd: ended ? event ? event.type.slice(4) : 'unknown' : null, finalStatus: child.status };
    });
    return { runId: id, parentId: run?.parentId ?? actualDispatches.find(dispatch => dispatch.id === id)?.parentId ?? null, status: run?.status ?? 'unknown', requests: requests.length,
      dispatch: { attempts: dispatches.length, successful: graphEvidence ? nativeEvidenceAvailable ? actual.length : null : successful.length, failed: dispatches.filter(action => action.status === 'failed').map(action => ({ step: action.step, error: action.result?.error ?? 'see persisted call' })), first: firstDispatch ? { step: firstDispatch.step, seconds: seconds(firstDispatch.endMs ?? firstDispatch.startMs, start), requests: requests.filter(step => graphEvidence ? (step.startedMs ?? millis(step.startedAt)) <= firstDispatch.startMs : step.step <= firstDispatch.step).length, ...(graphEvidence ? { atMs: firstDispatch.startMs, stepBasis: 'last-parent-request-started-before-host-dispatch' } : {}) } : null,
        ...(graphEvidence ? { delegateRequests: own.filter(action => action.name === 'delegate').length, continuationRequests: own.filter(action => action.name === 'task' && ['resume', 'redo'].includes(action.args.action)).length, successfulRequests: dispatches.filter(action => action.status === 'succeeded').length,
          actualDispatches: nativeEvidenceAvailable ? actual.length : null, observedChildRuns: actual.map(dispatch => ({ ...dispatch, modelRequestObserved: steps.some(step => step.runId === dispatch.id) })), limitation: nativeEvidenceAvailable ? 'Counts distinct child run IDs confirmed by native run rows or host dispatch events, including continuation runs. Queued task declarations and dispatch preparations do not count. Dispatch does not prove that a model request began.' : 'No native run or host-event evidence is available; successful declarations do not establish child dispatch. Actual dispatch count is unknown.' } : {}) },
      startup: { modification: ownModification, secondsToFirstObservedChange: seconds(ownModification.firstObserved?.atMs, start) },
      tools: { calls: own.length, shellProcessCalls: own.filter(action => shellNames.has(action.name)).length, shellClasses: Object.fromEntries(['read', 'search', 'write', 'test', 'git', 'unknown'].map(kind => [kind, own.filter(action => shellNames.has(action.name) && action.classification.kind === kind).length])), nonFileShellCalls: own.filter(action => shellNames.has(action.name) && action.classification.reason === 'non-file-operation').length, nativeClasses: count(own.filter(action => !shellNames.has(action.name)).map(action => action.classification.kind)), requestedShellReadRanges: own.filter(action => shellNames.has(action.name)).flatMap(action => requestedReads(action).map(read => ({ step: action.step, callId: action.callId, path: read.path, section: read.section, cwd: read.cwd ?? action.args.cwd ?? workspace, outputAttributable: read.outputAttributable !== false && !action.classification.compound }))), unknownShellCalls: own.filter(action => shellNames.has(action.name) && action.classification.kind === 'unknown').map(action => ({ step: action.step, callId: action.callId, reason: action.classification.reason ?? 'unsupported-or-ambiguous-syntax' })) },
      exploration: { handedPaths, searchesOfHandedPaths: handoff ? searchesOfHandedPaths.length : null, readsOfDelegatedScopeAfterDispatch: readsAfterDispatch.length, confirmedDuplicateReads, unchangedRangeReads, unknownRepeatReads, reviewerExcluded: isReviewer,
        beforeDispatchOrChange: { boundaryStep: Number.isFinite(boundary) ? boundary : null, boundaryBasis: firstDispatch?.step === boundary ? 'successful-dispatch' : ownModification.candidateSteps.includes(boundary) ? 'candidate-change-not-proven' : 'first-observed-change', tools: own.filter(action => action.step < boundary).length, shellProcessCalls: own.filter(action => action.step < boundary && shellNames.has(action.name)).length, shellReads: own.filter(action => action.step < boundary && shellNames.has(action.name) && requestedReads(action).length).length, requestedShellReadOperations: own.filter(action => action.step < boundary && shellNames.has(action.name)).reduce((total, action) => total + requestedReads(action).length, 0), reasoningTokens: before.reduce((n, step) => n + (step.reasoningTokens ?? 0), 0), credit: before.reduce((n, step) => n + (step.credit ?? 0), 0) } },
      acceptance: { requestsAfterLastChildDelivery: deliveredAt === null ? null : requests.filter(step => (step.startedMs ?? millis(step.startedAt)) > deliveredAt).length, checkCalls: checks.length, repeatedChecksUnknownState, confirmedUnchangedStateReruns: null, completionRejections: events.filter(event => event.runId === id && event.type === 'completion.checked' && event.data?.passed === false).map(event => ({ time: event.time, data: event.data })) },
      children: childStates, toolsStable: requests.length ? toolsChanges.length === 0 : null, toolChangeSteps: toolsChanges, toolChanges: requests.flatMap((step, index) => step.prefix?.toolsChanged ? [{ step: step.step, before: requests[index - 1]?.requestToolNames ?? null, after: step.requestToolNames ?? null }] : []),
      cachedShare: input ? cached / input : null, credit: requests.reduce((n, step) => n + (step.credit ?? 0), 0),
      fullDelivery: run?.status === 'completed' && run?.finalResponse ? 'requires-review-of-commit-and-final-evidence' : 'not-confirmed',
    };
  });
  const writers = runs.filter(run => run.parentId && (run.permissions?.includes('write') || run.card?.routing?.mode === 'write'));
  const intervals = writers.flatMap(run => {
    const own = actions.filter(action => action.runId === run.id && action.classification.kind === 'write' && Number.isFinite(action.endMs));
    return own.length ? [[Math.min(...own.map(action => action.startMs)), Math.max(...own.map(action => action.endMs))]] : [];
  });
  return { schemaVersion: 1, workspace, sourceRoots, relayWallSec: seconds(allEnd, allStart), persistedRunWallSec: events.length ? seconds(Math.max(...events.map(event => millis(event.time))), Math.min(...events.map(event => millis(event.time)))) : null, trace: summarize(steps), runs: perRun,
    sourceModification: modifications,
    parallelism: { observedWriterActivitySpanOverlapSec: overlappingSeconds(intervals), writersWithObservedTools: intervals.length, limitation: 'Activity spans bound observed write calls; they do not prove simultaneous useful work.', conflictCalls: actions.filter(action => /WRITE_SCOPE_CONFLICT|WRITE_LOCK|LOCK_CONFLICT/u.test(action.result?.error ?? '')).map(action => ({ runId: action.runId, step: action.step, error: action.result.error })) },
    shellProcessCalls: actions.filter(action => shellNames.has(action.name)).length, unknownIdentityRequests: steps.filter(step => !step.runId).length, externalVerifier: verifier,
    limitations: ['Unknown shell syntax is not classified as read/write. Compound categories use write/test/git/search/read precedence; non-file operations are unknown with a separate reason; component reads are requested operations, not proof each command ran.', 'Equal range text does not prove equal whole-file hashes.', 'Repeated tests without exact code-state evidence remain unknown.', 'Run success and passing external tests alone do not prove complete delivery.', 'Cache labels describe observed request structure, not causation.'] };
}

export async function readEvidence(cell, options = {}) {
  const savedSteps = new Map(jsonl(path.join(cell, 'process', 'steps.jsonl')).map(step => [step.index, step]));
  const steps = buildSteps(path.join(cell, 'relay')).map(step => ({ ...savedSteps.get(step.index), ...step }));
  const database = options.database ?? path.join(cell, 'state', 'kodo', 'kodo.sqlite');
  let runs = [], events = [], calls = [], workspace = options.workspace ?? '/';
  if (existsSync(database)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      runs = db.prepare('select data from runs').all().map(row => JSON.parse(row.data));
      calls = db.prepare('select data from calls').all().map(row => JSON.parse(row.data));
      events = db.prepare('select time, run_id as runId, type, data from events order by seq').all().map(row => ({ ...row, data: JSON.parse(row.data) }));
      const sessions = db.prepare('select data from sessions').all().map(row => JSON.parse(row.data));
      workspace = options.workspace ?? sessions.find(session => session.id === runs[0]?.sessionId)?.workspace ?? '/';
    } finally { db.close(); }
  } else {
    // Recorded graph events remain usable after the database is omitted from an evidence bundle.
    // Keep legacy-only evidence behavior unchanged; never derive child counts from delegate task arrays.
    const exported = jsonl(path.join(cell, 'process', 'native', 'kodo-events.jsonl'));
    if (exported.some(event => event.type.startsWith('task.'))) {
      events = exported;
      calls = jsonl(path.join(cell, 'process', 'native', 'kodo-calls.jsonl'));
    }
  }
  const snapshots = jsonl(path.join(cell, 'process', 'workspace.jsonl')).map(snapshot => ({ ...snapshot, patch: snapshot.file && existsSync(path.join(cell, 'process', snapshot.file)) ? readFileSync(path.join(cell, 'process', snapshot.file), 'utf8') : '' }));
  const verifierLog = path.join(cell, 'verifier.log');
  const verifier = existsSync(verifierLog) ? parse(/\[verifier\] reward.json=(\{[^\n]+\})/u.exec(readFileSync(verifierLog, 'utf8'))?.[1]) : null;
  return delegationMetrics({ steps, runs, events, calls, timings: jsonl(path.join(cell, 'process', 'tools.jsonl')), snapshots, workspace, sourceRoots: options.sourceRoots ?? [], verifier, nativeEvidenceAvailable: existsSync(database) || events.length > 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), cell = args.shift();
  if (!cell) throw new Error('Usage: delegation-metrics.mjs CELL_DIR [--database DB] [--source-root PATH,PATH] [--out FILE]');
  const options = {};
  let out;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--database') options.database = value;
    else if (flag === '--source-root') options.sourceRoots = value.split(',');
    else if (flag === '--out') out = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  const report = JSON.stringify(await readEvidence(path.resolve(cell), options), null, 2) + '\n';
  if (out) writeFileSync(path.resolve(out), report, 'utf8'); else process.stdout.write(report);
}
