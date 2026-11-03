// Read-only pytest command candidates and repeated checks; never executes shell text.
export function pytestInvocations(command) {
  const tokens = command.match(/\d*(?:>>?|<<?)(?:&\d+)?|(?:[^\s'";&|<>\n]+|'[^']*'|"(?:\\.|[^"\\])*")+|&&|\|\||[;&|\n]/g) ?? [];
  const segments = [[]];
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;&|\n])$/.test(token)) segments.push([]);
    else segments.at(-1).push(token.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_, single, double) => single ?? double));
  }
  return segments.flatMap(argv => {
    let i = 0;
    const assignments = () => { while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(argv[i] ?? '')) i++; };
    assignments();
    if (argv[i] === 'env') { i++; if (argv[i] === '--') i++; assignments(); }
    if (argv[i] === 'timeout') {
      i++;
      while (argv[i]?.startsWith('-')) {
        const option = argv[i++];
        if (['-s', '--signal', '-k', '--kill-after'].includes(option)) i++;
      }
      if (/^\d+(?:\.\d+)?[smhd]?$/.test(argv[i] ?? '')) i++; else return [];
    }
    if (argv[i] === 'uv' && argv[i + 1] === 'run') i += 2;
    const executable = (argv[i] ?? '').split(/[\\/]/).at(-1);
    if (/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(executable) && argv[i + 1] === '-m' && argv[i + 2] === 'pytest') return [argv.slice(i + 3)];
    if (/^pytest(?:\.exe)?$/.test(executable)) return [argv.slice(i + 1)];
    return [];
  });
}
export function pytestDetails(args) {
  const valueOptions = new Set(['-n', '--numprocesses', '-p', '-o', '--override-ini', '-c', '--config-file', '-W', '--pythonwarnings', '-k', '-m', '--ignore', '--ignore-glob', '--deselect', '--rootdir', '--confcutdir', '--basetemp', '--cov', '--cov-report', '--cov-config', '--cov-fail-under', '--junitxml', '--junit-xml', '--maxfail', '--dist', '--durations', '--tb', '--capture']);
  const filteredArgs = [], targets = [], exclusions = [];
  let selection = false, collection = false, information = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\d*(?:>>?|<<?)(?:&\d+)?$/.test(arg)) { if (!arg.includes('&')) i++; continue; }
    filteredArgs.push(arg);
    if (['--version', '-V', '--help', '-h'].includes(arg)) information = true;
    if (['--collect-only', '--co'].includes(arg)) collection = true;
    const option = arg.split('=')[0];
    if (['-k', '-m', '--lf', '--last-failed', '--deselect'].includes(option)) selection = true;
    if (['--ignore', '--ignore-glob', '--deselect'].includes(option)) exclusions.push({ option, value: arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1] });
    if (valueOptions.has(option)) {
      if (!arg.includes('=') && args[i + 1] !== undefined) filteredArgs.push(args[++i]);
    } else if (!arg.startsWith('-')) targets.push(arg);
  }
  const scope = information ? 'information' : collection ? 'collection' : selection || targets.some(target => /\.py(?:::|$)/.test(target)) ? 'targeted' : targets.some(target => /[$`]/.test(target)) ? 'unknown' : targets.some(target => !['.', './', 'tests', 'tests/'].includes(target)) ? 'targeted' : 'full-candidate';
  return { args, filteredArgs, targets, exclusions, scope, excludesDjango: exclusions.some(item => /django/.test(item.value ?? '')) };
}

// Keep quotes and command boundaries for status attribution. Unsupported shell
// constructs stay unknown; this is deliberately not a shell interpreter.
function statusSegments(command) {
  const segments = [];
  let quote = null, start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== "'" && (c === '`' || c === '$' && command[i + 1] === '(')) return null;
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('\\()#'.includes(c) || c === '<') return null;
    if (c === '&' && command[i - 1] === '>') continue; // 2>&1, not a pipeline boundary.
    if (!';\n&|'.includes(c)) continue;
    const after = (c === '&' || c === '|') && command[i + 1] === c ? c + c : c;
    segments.push({ text: command.slice(start, i).trim(), after });
    i += after.length - 1; start = i + 1;
  }
  if (quote) return null;
  const tail = command.slice(start).trim();
  if (tail) segments.push({ text: tail, after: null });
  return segments.filter(segment => segment.text);
}

const exitNumber = value => Number.isInteger(value) && value >= 0 && value <= 255;
const displayOnly = text => /^(?:tail|cat)\s+[\w\s./:"'-]+$/.test(text);

function echoMarker(text, variable) {
  const argument = /^echo\s+(?:"([^"\\]+)"|([^\s'"\\]+))\s*$/.exec(text);
  const marker = /^(exit=|EXIT:)(\$\?|\$[A-Za-z_][A-Za-z_0-9]*|\$\{[A-Za-z_][A-Za-z_0-9]*\})$/.exec(argument?.[1] ?? argument?.[2] ?? '');
  if (!marker) return null;
  const expected = variable ? [`$${variable}`, '${' + variable + '}'] : ['$?'];
  return expected.includes(marker[2]) ? marker[1] : null;
}

/** Attribute only a direct command status or one explicitly captured and printed status. */
function pytestExit(command, result, outerExitCode) {
  const unknown = { code: null, basis: 'unknown; shell exit is not attributable to pytest' };
  if (pytestInvocations(command).length !== 1) return unknown;
  const segments = statusSegments(command);
  if (!segments) return unknown;
  const index = segments.findIndex(segment => pytestInvocations(segment.text).length === 1);
  if (index < 0 || segments.slice(0, index).some(segment => segment.after !== '&&' || !/^cd\s+[\w\s./:"'-]+$/.test(segment.text))) return unknown;
  if (index === segments.length - 1 && !['|', '||', '&', '&&'].includes(segments[index].after)) {
    return exitNumber(outerExitCode) ? { code: outerExitCode, basis: 'direct pytest command shell status' } : unknown;
  }
  if (![';', '\n'].includes(segments[index].after) || result?.truncated || result?.outputLimitExceeded) return unknown;
  const rest = segments.slice(index + 1);
  if (rest.some(segment => segment.after !== null && ![';', '\n'].includes(segment.after))) return unknown;
  const capture = /^([A-Za-z_][A-Za-z_0-9]*)=(?:\$\?|"\$\?")$/.exec(rest[0]?.text ?? '');
  const variable = capture?.[1];
  const output = capture ? rest.slice(1) : rest;
  const markerIndex = output.findIndex(segment => echoMarker(segment.text, variable));
  if (markerIndex < 0 || !capture && markerIndex !== 0 || output.some((segment, i) => i !== markerIndex && !displayOnly(segment.text))) return unknown;
  const prefix = echoMarker(output[markerIndex].text, variable);
  const values = [...(result?.stdout ?? '').matchAll(/^(exit=|EXIT:)(\d+)[\t ]*\r?$/gm)];
  if (values.length !== 1 || values[0][1] !== prefix || !exitNumber(Number(values[0][2]))) return unknown;
  return { code: Number(values[0][2]), basis: capture ? 'single pytest status captured immediately and printed unchanged' : 'single pytest status printed immediately' };
}

/** Calls carry decoded args/results; check.started supplies the existing workspace version. */
export function auditRepeatedChecks(calls, events) {
  const starts = new Map(events.filter(event => event.type === 'check.started').map(event => [event.data.callId, event]));
  const began = new Map(events.filter(event => event.type === 'tool.started').map(event => [event.data.callId, event]));
  const ended = new Map(events.filter(event => event.type === 'tool.finished').map(event => [event.data.callId, event]));
  const ready = new Map(events.filter(event => event.type === 'tool.resource_ready').map(event => [event.data.callId, event]));
  const backgroundEnds = new Map(events.filter(event => event.type === 'process.background.finished').map(event => [event.data.callId, event]));
  const tests = calls.flatMap(call => {
    if (!['shell.exec', 'process.exec'].includes(call.name) || typeof call.args?.command !== 'string') return [];
    const command = call.args.command, invocations = pytestInvocations(command).map(pytestDetails).filter(item => item.scope !== 'information');
    if (!invocations.length) return [];
    const start = starts.get(call.id), end = ended.get(call.id);
    const startMs = call.startMs ?? Date.parse(began.get(call.id)?.time ?? start?.time);
    const endMs = call.endMs ?? Date.parse(end?.time);
    const backgroundEnd = backgroundEnds.get(call.id);
    const background = Boolean(backgroundEnd || call.result?.processId || call.result?.jobId || end?.data.background);
    const detached = /(?:^|\s)nohup\s|(?<![&>])&(?![&>\d])/.test(command);
    const readyMs = Date.parse(ready.get(call.id)?.time);
    const executionStartMs = Number.isFinite(readyMs) && readyMs >= startMs ? readyMs : startMs;
    const executionEndMs = background ? Date.parse(backgroundEnd?.time) : endMs;
    const intervalKnown = !detached && Number.isFinite(executionStartMs) && Number.isFinite(executionEndMs) && executionEndMs >= executionStartMs;
    const exitCode = backgroundEnd?.data.exitCode ?? call.result?.exitCode ?? null;
    const testExit = pytestExit(command, call.result, exitCode), testExitCode = testExit.code;
    const settled = call.status === 'succeeded' && call.effectOutcome !== 'unknown' && exitCode === 0 && !call.result?.timedOut && !call.result?.cancelled && (!background || backgroundEnd?.data.state === 'exited') && !detached;
    return [{ id: call.id, runId: call.runId, command, originalArgs: call.args, invocations,
      version: typeof start?.data.version === 'string' ? start.data.version : null, cwd: start?.data.cwd ?? null,
      broadCount: invocations.filter(item => item.scope === 'full-candidate').length,
      status: call.status, exitCode, testExitCode, testExitBasis: testExit.basis,
      succeeded: !settled ? false : testExitCode === null ? null : testExitCode === 0,
      startMs: Number.isFinite(startMs) ? startMs : null, endMs: Number.isFinite(endMs) ? endMs : null,
      executionStartMs: Number.isFinite(executionStartMs) ? executionStartMs : null,
      executionEndMs: Number.isFinite(executionEndMs) && !detached ? executionEndMs : null,
      executionSec: intervalKnown ? (executionEndMs - executionStartMs) / 1000 : null,
      durationBasis: intervalKnown ? `${background ? 'background lifecycle' : 'foreground call'} from ${executionStartMs === readyMs ? 'resource ready' : 'tool start'}, including shell setup and chained checks` : 'unknown; background launch is not execution duration' }];
  }).sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
  const groups = new Map(), exact = new Map();
  for (const test of tests) {
    if (test.version === null || test.cwd === null) continue;
    const identity = [test.runId, test.cwd, test.version];
    const exactKey = JSON.stringify([...identity, test.command]), previous = exact.get(exactKey);
    test.previousSuccessfulCallId = previous?.succeeded && previous.executionEndMs !== null && test.startMs !== null && previous.executionEndMs <= test.startMs ? previous.id : null;
    exact.set(exactKey, test);
    if (!test.broadCount) continue;
    const key = JSON.stringify(identity);
    const group = groups.get(key) ?? { runId: test.runId, cwd: test.cwd, version: test.version, calls: [], invocations: 0, repeatedInvocations: 0, knownCallSeconds: 0, knownRepeatedCallSeconds: 0, unknownDurationCalls: 0, mixedCallIds: [] };
    const repeated = group.invocations > 0;
    group.repeatedInvocations += repeated ? test.broadCount : Math.max(0, test.broadCount - 1);
    group.invocations += test.broadCount;
    group.calls.push(test.id);
    if (test.executionSec === null) group.unknownDurationCalls++;
    else { group.knownCallSeconds += test.executionSec; if (repeated) group.knownRepeatedCallSeconds += test.executionSec; }
    if (test.invocations.length !== 1) group.mixedCallIds.push(test.id);
    groups.set(key, group);
  }
  const broadByVersion = [...groups.values()];
  return { tests, broadByVersion,
    repeatedBroadInvocations: broadByVersion.reduce((sum, group) => sum + group.repeatedInvocations, 0),
    knownRepeatedBroadCallSeconds: broadByVersion.reduce((sum, group) => sum + group.knownRepeatedCallSeconds, 0),
    unknownVersionCallIds: tests.filter(test => test.version === null || test.cwd === null).map(test => test.id),
    note: 'Pytest execution candidates only; help/version queries are excluded and chained commands may not reach pytest. Repetition groups are per run, directory and recorded start version, not proof of redundant work or environment equivalence. Durations start at resource readiness when recorded, use background completion when available, and exclude unmeasured detached work. Multiple invocations in one call cannot be timed separately. Success requires an attributable direct status or one complete, unique marker from a single pytest immediately printing or saving its status; saved status allows only tail/cat before printing. Unparsed or ambiguous wrappers remain unknown, never successful solely because the shell exited zero.' };
}
