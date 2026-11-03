import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyArgv, classifyCommand, delegationMetrics, readEvidence } from './delegation-metrics.mjs';

const step = (n, name, args, result, runId = 'main') => ({ step: n, index: n, runId, startedMs: n * 1000, endedMs: n * 1000 + 100, startedAt: new Date(n * 1000).toISOString(), modelSec: 0.1, status: 'completed', reasoning: '', reasoningTokens: 10, inputTokens: 100, cachedTokens: 50, credit: 0.1, prefixStatus: n === 1 ? 'first' : 'compared', prefix: null, gapAfterSec: null, toolCalls: name ? [{ id: `call${n}`, name, arguments: JSON.stringify(args) }] : [], results: name ? [{ role: 'tool', toolCallId: `call${n}`, content: JSON.stringify(result) }] : [] });
const report = steps => delegationMetrics({ steps, workspace: '/app' });

test('classifies only simple explicit shell operations, preserving unknown compounds and scripts', () => {
  for (const [command, expected] of [
    ['cat src/a.ts', 'read'], ['sed -n "5,20p" src/a.ts', 'read'], ['head -n 10 src/a.ts', 'read'], ['tail -5 src/a.ts', 'read'],
    ['cd /app && rg x src', 'search'], ['ls src', 'search'], ['find src -name a.ts', 'search'], ['grep x src/a.ts', 'search'],
    ['echo text > src/a.ts', 'write'], ['pytest tests', 'test'], ['python -m pytest tests', 'test'], ['npm run test', 'test'], ['git diff --stat', 'git'],
    ['cat a | head', 'read'], ['sleep 120; tail file', 'unknown'], ['python -c "open(\'a\',\'w\').write(\'x\')"', 'unknown'], ['cat > /tmp/script.py <<EOF\nopen("src/a.py", "w")\nEOF\npython /tmp/script.py', 'unknown'],
  ]) assert.equal(classifyCommand(command).kind, expected, command);
  assert.deepEqual(classifyCommand("cd '/app' && sed -n 10,20p src/a.ts"), { kind: 'read', cwd: '/app', path: 'src/a.ts', section: '10:20' });
});

test('same file hash and same range prove repeated reads; pagination and changed hashes do not', () => {
  const steps = [
    step(1, 'file_read', { path: 'src/a.ts', offset: 1, limit: 10 }, { content: 'a', hash: 'first' }),
    step(2, 'file_read', { path: 'src/a.ts', offset: 11, limit: 10 }, { content: 'b', hash: 'first' }),
    step(3, 'file_read', { path: 'src/a.ts', offset: 1, limit: 10 }, { content: 'a', hash: 'first' }),
    step(4, 'file_read', { path: 'src/a.ts', offset: 1, limit: 10 }, { content: 'c', hash: 'second' }),
  ];
  assert.equal(report(steps).runs[0].exploration.confirmedDuplicateReads, 1);
});

test('failed writes or absent writes never substitute for observed read hashes', () => {
  const steps = [
    step(1, 'file_read', { path: 'src/a.ts' }, {}),
    step(2, 'shell_exec', { command: 'python script.py' }, { error: 'timeout after partial write' }),
    step(3, 'file_read', { path: 'src/a.ts' }, {}),
    step(4, 'file_read', { path: 'src/a.ts' }, {}),
  ];
  const r = report(steps).runs[0].exploration;
  assert.equal(r.confirmedDuplicateReads, 0);
  assert.equal(r.unknownRepeatReads, 2);
});

test('identical shell output proves only unchanged range text, not the entire file', () => {
  const r = report([
    step(1, 'shell_exec', { command: 'sed -n 1,10p src/a.ts' }, { exitCode: 0, stdout: 'text' }),
    step(2, 'file_read', { path: 'src/a.ts', offset: 1, limit: 10 }, { content: 'text' }),
    step(3, 'shell_exec', { command: 'sed -n 1,10p src/a.ts' }, { exitCode: 0, stdout: 'text', truncated: true }),
  ]).runs[0].exploration;
  assert.equal(r.confirmedDuplicateReads, 0);
  assert.equal(r.unchangedRangeReads, 1);
  assert.equal(r.unknownRepeatReads, 1);
});

test('temp scripts, failed calls and no-op native patches are not source modification evidence', () => {
  const r = report([
    step(1, 'shell_exec', { command: 'echo value > /tmp/script.py' }, { exitCode: 0, stdout: '' }),
    step(2, 'file_patch', { path: 'src/a.ts', expectedHash: 'same' }, { hash: 'same' }),
    step(3, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { error: 'denied', hash: 'new' }),
    step(4, 'file_patch', { path: '/etc/a.ts', expectedHash: 'old' }, { hash: 'new' }),
  ]);
  assert.equal(r.sourceModification.firstObserved, null);
});

test('native hash changes are evidence, later diff only bounds an earlier candidate command', () => {
  const r = report([
    step(1, 'shell_exec', { command: 'python -c "write src/a.ts"' }, { exitCode: 0, stdout: '' }),
    step(2, 'shell_exec', { command: 'git diff --stat' }, { exitCode: 0, stdout: ' src/a.ts | 3 +++\n' }),
    step(3, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { hash: 'new' }),
  ]);
  assert.equal(r.sourceModification.firstObserved.step, 2);
  assert.equal(r.sourceModification.firstObserved.kind, 'diff-observation');
  assert.deepEqual(r.sourceModification.candidateSteps, [1]);
  assert.equal(r.runs[0].exploration.beforeDispatchOrChange.boundaryBasis, 'candidate-change-not-proven');
  const direct = report([step(1, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { hash: 'new' })]);
  assert.equal(direct.sourceModification.firstObserved.kind, 'hash-change');
});

test('snapshot intervals do not invent precise source modification timestamps', () => {
  const r = delegationMetrics({ workspace: '/app', steps: [step(1, 'shell_exec', { command: 'python mutate.py src/a.py' }, { exitCode: 0 })], snapshots: [
    { at: new Date(1050).toISOString(), bytes: 0 },
    { at: new Date(5000).toISOString(), bytes: 50, patch: 'diff --git a/src/a.py b/src/a.py\n+changed\n' },
  ] });
  assert.deepEqual(r.sourceModification.firstObserved.interval, { afterMs: 1050, byMs: 5000 });
  assert.equal(r.sourceModification.firstObserved.step, null);
  assert.deepEqual(r.sourceModification.candidateSteps, [1]);
});

test('dispatch and startup costs are per run; review reads are excluded and failure remains failure', () => {
  const steps = [
    step(1, 'spawn_agent', {}, { error: 'WRITE_SCOPE_CONFLICT: src' }),
    step(2, 'spawn_agent', { inputs: ['src/a.ts exports run'], scope: { write: ['src'] } }, { id: 'child' }),
    step(3, 'file_search', { path: 'src/a.ts', query: 'run' }, { matches: [] }, 'child'),
    step(4, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { hash: 'new' }, 'child'),
    step(5, 'file_read', { path: 'src/a.ts' }, { hash: 'new', content: 'new' }),
    step(6, null, {}, {}),
  ];
  const r = delegationMetrics({ steps, workspace: '/app', runs: [
    { id: 'main', status: 'failed', createdAt: new Date(0).toISOString() },
    { id: 'child', parentId: 'main', status: 'completed', permissions: ['write'], createdAt: new Date(2500).toISOString() },
  ], events: [
    { runId: 'child', type: 'run.queued', time: new Date(2500).toISOString(), data: {} },
    { runId: 'child', type: 'run.completed', time: new Date(4500).toISOString(), data: {} },
    { runId: 'main', type: 'completion.checked', time: new Date(5000).toISOString(), data: { passed: false } },
    { runId: 'main', type: 'run.failed', time: new Date(7000).toISOString(), data: {} },
  ] });
  assert.equal(r.runs[0].dispatch.successful, 1);
  assert.equal(r.runs[0].dispatch.failed.length, 1);
  assert.equal(r.runs[0].dispatch.first.requests, 2);
  assert.equal(r.runs[0].exploration.readsOfDelegatedScopeAfterDispatch, 1);
  assert.equal(r.runs[1].exploration.searchesOfHandedPaths, 1);
  assert.equal(r.runs[0].acceptance.requestsAfterLastChildDelivery, 2);
  assert.equal(r.runs[0].children[0].statusAtParentEnd, 'completed');
  assert.equal(r.runs[0].fullDelivery, 'not-confirmed');
  assert.equal(r.parallelism.conflictCalls.length, 1);
  const reviewer = delegationMetrics({ workspace: '/app', steps: [step(1, 'file_read', { path: 'a.ts' }, { hash: 'same' }), step(2, 'file_read', { path: 'a.ts' }, { hash: 'same' })], runs: [{ id: 'main', card: { id: 'kodo/reviewer' } }] });
  assert.equal(reviewer.runs[0].exploration.confirmedDuplicateReads, 0);
});

test('repeated tests have unknown code state even without intervening successful writes', () => {
  const r = report([step(1, 'shell_exec', { command: 'pytest tests' }, { exitCode: 0 }), step(2, 'shell_exec', { command: 'pytest tests' }, { exitCode: 0 })]);
  assert.equal(r.runs[0].acceptance.repeatedChecksUnknownState, 1);
  assert.equal(r.runs[0].acceptance.confirmedUnchangedStateReruns, null);
});

test('reads an evidence directory and database without changing either', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const cell = await mkdtemp(path.join(tmpdir(), 'fh-metrics-'));
  try {
    await mkdir(path.join(cell, 'relay'));
    await mkdir(path.join(cell, 'state', 'kodo'), { recursive: true });
    const file = path.join(cell, 'state', 'kodo', 'kodo.sqlite');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE runs (data TEXT); CREATE TABLE sessions (data TEXT); CREATE TABLE calls (data TEXT); CREATE TABLE events (seq INTEGER, time TEXT, run_id TEXT, type TEXT, data TEXT);');
    db.prepare('INSERT INTO runs VALUES (?)').run(JSON.stringify({ id: 'main', sessionId: 's', status: 'failed' }));
    db.prepare('INSERT INTO sessions VALUES (?)').run(JSON.stringify({ id: 's', workspace: '/app' }));
    db.close();
    await writeFile(path.join(cell, 'relay', 'calls.json'), JSON.stringify([{ index: 1, startedMs: 1000, elapsedMs: 100 }]));
    await writeFile(path.join(cell, 'relay', 'request-1.json'), JSON.stringify({ messages: [{ role: 'system', content: 'Run ID: main.' }] }));
    await writeFile(path.join(cell, 'verifier.log'), '[verifier] reward.json={"reward":1}\n');
    const before = await readFile(file);
    const r = await readEvidence(cell);
    assert.equal(r.workspace, '/app');
    assert.equal(r.runs[0].status, 'failed');
    assert.deepEqual(r.externalVerifier, { reward: 1 });
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(cell, { recursive: true, force: true }); }
});


test('overlap counts writer activity only and keeps child state at parent exit distinct from final state', () => {
  const r = delegationMetrics({ workspace: '/app', steps: [
    step(1, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { hash: 'new' }, 'a'),
    step(2, 'file_patch', { path: 'src/b.ts', expectedHash: 'old' }, { hash: 'new' }, 'b'),
    step(3, null, {}, {}, 'parent'),
  ], runs: [
    { id: 'parent', status: 'failed' },
    { id: 'a', parentId: 'parent', permissions: ['write'], status: 'cancelled' },
    { id: 'b', parentId: 'parent', permissions: ['write'], status: 'completed' },
  ], timings: [{ callId: 'call1', startMs: 1000, endMs: 3000 }, { callId: 'call2', startMs: 2000, endMs: 4000 }], events: [
    { runId: 'a', type: 'run.started', time: new Date(500).toISOString(), data: {} },
    { runId: 'parent', type: 'run.failed', time: new Date(5000).toISOString(), data: {} },
    { runId: 'a', type: 'run.cancelled', time: new Date(5500).toISOString(), data: {} },
  ] });
  assert.equal(r.parallelism.observedWriterActivitySpanOverlapSec, 1);
  const parent = r.runs.find(run => run.runId === 'parent');
  assert.equal(parent.children[0].statusAtParentEnd, 'started');
  assert.equal(parent.children[0].finalStatus, 'cancelled');
});


test('process.exec argv is classified as literal arguments, with no implicit shell parsing', () => {
  assert.deepEqual(classifyArgv('/usr/bin/cat', ['src/a|b.ts']), { kind: 'read', path: 'src/a|b.ts', section: 'all' });
  assert.deepEqual(classifyArgv('sed', ['-n', '1,5p', 'src/a file.ts']), { kind: 'read', path: 'src/a file.ts', section: '1:5' });
  assert.equal(classifyArgv('python', ['-m', 'pytest', 'tests']).kind, 'test');
  assert.equal(classifyArgv('bash', ['-c', 'pytest']).kind, 'unknown');
  assert.equal(classifyArgv('find', ['src', '-delete']).kind, 'unknown');
  assert.equal(classifyCommand('find src -delete').kind, 'unknown');
  const r = report([
    step(1, 'process_exec', { program: 'python', args: ['-m', 'pytest', 'tests'] }, { exitCode: 0 }),
    step(2, 'process_exec', { program: 'git', args: ['diff', '--stat'] }, { exitCode: 0, stdout: ' src/a.ts | 2 ++\n' }),
  ]);
  assert.equal(r.runs[0].acceptance.checkCalls, 1);
  assert.equal(r.sourceModification.firstObserved.step, 2);
});

test('ambiguous bare timing IDs do not produce fake writer overlap across runs', () => {
  const a = step(1, 'file_patch', { path: 'src/a.ts', expectedHash: 'old' }, { hash: 'new' }, 'a');
  const b = step(2, 'file_patch', { path: 'src/b.ts', expectedHash: 'old' }, { hash: 'new' }, 'b');
  b.toolCalls[0].id = 'call1'; b.results[0].toolCallId = 'call1';
  const runs = [{ id: 'a', parentId: 'p', permissions: ['write'] }, { id: 'b', parentId: 'p', permissions: ['write'] }];
  const unknown = delegationMetrics({ workspace: '/app', steps: [a, b], runs, timings: [{ callId: 'call1', startMs: 1000, endMs: 5000 }] });
  assert.equal(unknown.parallelism.writersWithObservedTools, 0);
  const known = delegationMetrics({ workspace: '/app', steps: [a, b], runs, timings: [{ runId: 'a', callId: 'call1', startMs: 1000, endMs: 5000 }, { runId: 'b', callId: 'call1', startMs: 2000, endMs: 6000 }] });
  assert.equal(known.parallelism.observedWriterActivitySpanOverlapSec, 3);
});


test('a preexisting dirty diff does not imply a clean baseline at run start', () => {
  const r = report([step(1, 'shell_exec', { command: 'git diff --stat' }, { exitCode: 0, stdout: ' src/a.ts | 2 ++\n' })]);
  assert.equal(r.sourceModification.firstObserved.baselineKnownClean, false);
  assert.equal(r.sourceModification.firstObserved.interval.afterMs, null);
});


test('successful native source rename and deletion count despite preserving the old content hash', () => {
  const renamed = report([step(1, 'file_rename', { path: 'src/old.ts', destination: 'src/new.ts', expectedHash: 'same' }, { path: 'src/old.ts', destination: 'src/new.ts', hash: 'same', bytes: 4 })]);
  assert.equal(renamed.sourceModification.firstObserved.kind, 'native-rename');
  assert.deepEqual(renamed.sourceModification.firstObserved.paths, ['src/old.ts', 'src/new.ts']);
  const deleted = report([step(1, 'file_delete', { path: 'src/old.ts', expectedHash: 'same' }, { path: 'src/old.ts', deleted: true, hash: 'same' })]);
  assert.equal(deleted.sourceModification.firstObserved.kind, 'native-delete');
  assert.equal(deleted.sourceModification.firstObserved.step, 1);
  const renamedIntoSource = report([step(1, 'file_rename', { path: 'backup.txt', destination: 'src/new.ts', expectedHash: 'same' }, { path: 'backup.txt', destination: 'src/new.ts', hash: 'same', bytes: 4 })]);
  assert.deepEqual(renamedIntoSource.sourceModification.firstObserved.paths, ['src/new.ts']);
});

test('incomplete native mutation evidence stays unknown; mkdir and refused deletion do not count', () => {
  const r = report([
    step(1, 'file_mkdir', { path: 'src/directory.ts' }, { path: 'src/directory.ts', created: true }),
    step(2, 'file_delete', { path: 'src/a.ts', expectedHash: 'same' }, { path: 'src/a.ts', hash: 'same' }),
    step(3, 'file_rename', { path: 'src/a.ts', destination: 'src/b.ts', expectedHash: 'same' }, { error: 'process interrupted' }),
    step(4, 'file_delete', { path: 'src/c.ts', expectedHash: 'same' }, { error: 'denied', notStarted: true }),
  ]);
  assert.equal(r.sourceModification.firstObserved, null);
  assert.deepEqual(r.sourceModification.unconfirmedNativeMutations.map(item => item.step), [2, 3]);
  assert.equal(classifyCommand('find src -exec touch changed +').kind, 'unknown');
  assert.equal(classifyCommand('find src -delete').kind, 'unknown');
  assert.equal(classifyArgv('find', ['src', '-exec', 'touch', 'changed', '+']).kind, 'unknown');
});


test('classifies quoted search pipelines and simple compound reads under a static cd prefix', () => {
  const search = classifyCommand('cd /app && grep -n "^from\\|^import" fastapi/routing.py | head -40; echo ===; sed -n 10,20p fastapi/routing.py');
  assert.equal(search.kind, 'search');
  assert.equal(search.cwd, '/app');
  assert.deepEqual(search.reads, [{ path: 'fastapi/routing.py', section: '10:20', cwd: '/app', outputAttributable: false }]);
  const reads = classifyCommand("cd '/app/project space' && sed -n 1,10p src/a.ts; echo '=== divider'; sed -n 11,20p src/a.ts");
  assert.equal(reads.kind, 'read');
  assert.deepEqual(reads.reads.map(read => read.section), ['1:10', '11:20']);
  assert.equal(classifyCommand('cd /app && ls src/* 2>/dev/null | head -10').kind, 'search');
  assert.equal(classifyCommand('cd /app && python -m pytest tests -q 2>&1 | tail -40').kind, 'test');
  assert.equal(classifyCommand('cd /app && timeout 1800 python -m pytest tests -q 2>&1 | tail -40').kind, 'test');
});

test('compound outputs are not misattributed as independent file observations', () => {
  const command = 'cd /app && sed -n 1,10p src/a.ts; echo ---; sed -n 1,10p src/b.ts';
  const r = report([step(1, 'shell_exec', { command }, { exitCode: 0, stdout: 'a\n---\nb\n' }), step(2, 'shell_exec', { command }, { exitCode: 0, stdout: 'a\n---\nb\n' }), step(3, 'todo_write', {}, { ok: true })]);
  const run = r.runs[0];
  assert.equal(run.tools.shellClasses.read, 2);
  assert.equal(run.tools.nativeClasses.other, 1);
  assert.equal('other' in run.tools.shellClasses, false);
  assert.equal(Object.values(run.tools.shellClasses).reduce((sum, n) => sum + n, 0), run.tools.shellProcessCalls);
  assert.equal(run.tools.requestedShellReadRanges.length, 4);
  assert.equal(run.exploration.confirmedDuplicateReads, 0);
  assert.equal(run.exploration.unchangedRangeReads, 0);
  assert.equal(run.exploration.unknownRepeatReads, 2);
});

test('safe relative cd uses the recorded workspace and preserves native argv filenames literally', () => {
  const r = report([
    step(1, 'shell_exec', { command: 'cd src && cat a.ts' }, { exitCode: 0, stdout: 'same' }),
    step(2, 'shell_exec', { command: 'cat /app/src/a.ts' }, { exitCode: 0, stdout: 'same' }),
    step(3, 'process_exec', { program: 'cat', args: ['src/a|b.ts'] }, { exitCode: 0, stdout: 'literal' }),
  ]);
  assert.equal(r.runs[0].exploration.unchangedRangeReads, 1);
  assert.equal(r.runs[0].tools.requestedShellReadRanges[2].path, 'src/a|b.ts');
});

test('ambiguous shell expansion, executable pipelines and output writes remain unknown', () => {
  for (const command of [
    'cd /app; cat src/a.ts', 'cd "$PROJECT" && cat src/a.ts', 'cd ~/project && cat src/a.ts',
    'cat $(pick-file)', 'cat `pick-file`', 'cat a | bash', 'cat a | sed "s/a/b/e"',
    'sed -n 1,10p src/a.ts > output.txt', 'find src -fprintf report.txt "%p"', 'find src -exec touch out +',
    'ls src || cat fallback', '(cat src/a.ts)', 'cat > /tmp/a.py <<EOF\nprint(1)\nEOF',
    'python -c "print(1)"; cat src/a.ts', 'cd src && cd nested && cat a.ts',
  ]) assert.equal(classifyCommand(command).kind, 'unknown', command);
  const piped = report([step(1, 'shell_exec', { command: 'cat src/a.ts | head -10' }, { exitCode: 0, stdout: 'x' }), step(2, 'shell_exec', { command: 'cat src/a.ts | head -10' }, { exitCode: 0, stdout: 'x' })]);
  assert.equal(piped.runs[0].exploration.unchangedRangeReads, 0);
  assert.equal(piped.runs[0].exploration.unknownRepeatReads, 1);
});


test('byte-bounded tail reads and line ranges remain distinct, and grep filters retain search classification', () => {
  assert.deepEqual(classifyCommand('tail -c 1500 /tmp/log'), { kind: 'read', path: '/tmp/log', section: 'tail-bytes:1500' });
  assert.equal(classifyCommand('cat src/a.ts | grep import').kind, 'search');
  const r = report([
    step(1, 'shell_exec', { command: 'tail -c 10 src/a.ts' }, { exitCode: 0, stdout: 'same' }),
    step(2, 'shell_exec', { command: 'tail -10 src/a.ts' }, { exitCode: 0, stdout: 'same' }),
  ]);
  assert.equal(r.runs[0].exploration.unchangedRangeReads, 0);
  assert.deepEqual(r.runs[0].tools.requestedShellReadRanges.map(read => read.section), ['tail-bytes:10', 'tail:10']);
});


test('non-file shell diagnostics stay outside file-operation categories and separate from native other', () => {
  const r = report([
    step(1, 'shell_exec', { command: 'pwd' }, { exitCode: 0, stdout: '/app' }),
    step(2, 'shell_exec', { command: 'echo alive' }, { exitCode: 0, stdout: 'alive' }),
    step(3, 'process_exec', { program: 'pgrep', args: ['pytest'] }, { exitCode: 0, stdout: '123' }),
    step(4, 'todo_write', {}, { ok: true }),
  ]);
  const tools = r.runs[0].tools;
  assert.equal(tools.shellClasses.unknown, 3);
  assert.equal(tools.nonFileShellCalls, 3);
  assert.equal('other' in tools.shellClasses, false);
  assert.equal(tools.nativeClasses.other, 1);
  assert.ok(tools.unknownShellCalls.every(call => call.reason === 'non-file-operation'));
});

const graphEvent = (type, runId, data, at) => ({ type, runId, data, time: new Date(at).toISOString() });

test('one delegate request can dispatch multiple native children without counting self or queued nodes', () => {
  const tasks = [{ id: 'mine', owner: 'self', goal: 'Integrate' }, { id: 'a', goal: 'Change module a', start: ['src/a.ts exports run'], scope: ['src/a.ts'] }, { id: 'b', goal: 'Change module b' }, { id: 'later', goal: 'Wait for capacity' }];
  const steps = [step(1, 'delegate', { tasks }, { nodes: tasks.map(task => ({ id: task.id, state: 'queued' })) }), step(2, 'file_search', { path: 'src/a.ts', query: 'run' }, { matches: [] }, 'child-a'), step(3, 'file_read', { path: 'src/a.ts' }, { hash: 'new', content: 'new' })];
  const r = delegationMetrics({ steps, runs: [
    { id: 'main', createdAt: new Date(0).toISOString() },
    { id: 'child-a', parentId: 'main', taskNode: { nodeId: 'a', generation: 1 }, createdAt: new Date(1500).toISOString() },
    { id: 'child-b', parentId: 'main', taskNode: { nodeId: 'b', generation: 1 }, createdAt: new Date(1501).toISOString() },
  ], events: [graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 1, runId: 'child-a' }, 1500), graphEvent('agent.spawned', 'child-a', { parentId: 'main', nodeId: 'a' }, 1500), graphEvent('task.dispatch.committed', 'main', { nodeId: 'b', generation: 1, runId: 'child-b' }, 1501), graphEvent('task.dispatch.prepared', 'main', { nodeId: 'later', runId: 'not-created' }, 1502)] });
  const main = r.runs.find(run => run.runId === 'main');
  assert.equal(main.dispatch.delegateRequests, 1);
  assert.equal(main.dispatch.successfulRequests, 1);
  assert.equal(main.dispatch.actualDispatches, 2);
  assert.equal(main.dispatch.successful, 2);
  assert.deepEqual(main.dispatch.observedChildRuns.map(run => [run.id, run.modelRequestObserved]), [['child-a', true], ['child-b', false]]);
  assert.equal(main.dispatch.first.seconds, 1.5);
  assert.equal(main.dispatch.first.requests, 1);
  assert.equal(main.exploration.readsOfDelegatedScopeAfterDispatch, 1);
  assert.equal(r.runs.find(run => run.runId === 'child-a').exploration.searchesOfHandedPaths, 1);
});

test('prepared or queued task nodes do not become dispatched runs even with allocated run IDs', () => {
  const r = delegationMetrics({ steps: [step(1, 'delegate', { tasks: [{ id: 'later', goal: 'Queued' }] }, { nodes: [{ id: 'later', runId: 'reserved', state: 'queued' }] })], runs: [{ id: 'main' }], events: [graphEvent('task.dispatch.prepared', 'main', { nodeId: 'later', runId: 'reserved' }, 1500)] });
  assert.equal(r.runs[0].dispatch.actualDispatches, 0);
  assert.equal(r.runs[0].dispatch.successfulRequests, 1);
  assert.equal(r.runs[0].dispatch.first, null);
  assert.deepEqual(r.runs[0].dispatch.observedChildRuns, []);
});

test('resume and redo count distinct committed runs without counting repeated declaration or event records', () => {
  const r = delegationMetrics({ steps: [
    step(1, 'delegate', { tasks: [{ id: 'a', goal: 'Implement' }] }, { nodes: [{ id: 'a', state: 'queued' }] }),
    step(2, 'task', { action: 'resume', node_id: 'a', input: 'Complete the check' }, { id: 'a', state: 'pending' }),
    step(3, 'task', { action: 'redo', node_id: 'a', input: 'Use latest source' }, { id: 'a', state: 'pending' }),
  ], runs: [{ id: 'main' }, ...['first', 'resumed', 'redone'].map((id, index) => ({ id, parentId: 'main', agentId: 'stable', taskNode: { nodeId: 'a', generation: index === 2 ? 2 : 1 }, ...(index ? { continuationOf: index === 1 ? 'first' : 'resumed' } : {}), createdAt: new Date(1500 + index * 1000).toISOString() }))], events: [
    graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 1, runId: 'first' }, 1500),
    graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 1, runId: 'resumed' }, 2500),
    graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 1, runId: 'resumed' }, 2500),
    graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 2, runId: 'redone' }, 3500),
  ] });
  const dispatch = r.runs[0].dispatch;
  assert.equal(dispatch.delegateRequests, 1);
  assert.equal(dispatch.continuationRequests, 2);
  assert.equal(dispatch.actualDispatches, 3);
  assert.deepEqual(dispatch.observedChildRuns.map(run => [run.id, run.generation, run.continuationOf ?? null]), [['first', 1, null], ['resumed', 1, 'first'], ['redone', 2, 'resumed']]);
});

test('a successful delegate response without native records leaves actual child count unknown', () => {
  const r = report([step(1, 'delegate', { tasks: [{ id: 'a', goal: 'Work' }] }, { nodes: [{ id: 'a', state: 'running', runId: 'claimed-child' }] })]);
  assert.equal(r.runs[0].dispatch.delegateRequests, 1);
  assert.equal(r.runs[0].dispatch.successfulRequests, 1);
  assert.equal(r.runs[0].dispatch.actualDispatches, null);
  assert.equal(r.runs[0].dispatch.successful, null);
  assert.match(r.runs[0].dispatch.limitation, /unknown/);
});

test('graph delivery accounting waits for node integration rather than child model completion', () => {
  const r = delegationMetrics({ steps: [step(1, 'delegate', { tasks: [{ id: 'a', goal: 'Work' }] }, { nodes: [{ id: 'a', state: 'queued' }] }), step(3, null, {}, {}), step(5, null, {}, {})], runs: [{ id: 'main' }, { id: 'child', parentId: 'main', taskNode: { nodeId: 'a', generation: 1 }, createdAt: new Date(1500).toISOString() }], events: [
    graphEvent('run.completed', 'child', {}, 2500),
    graphEvent('task.node.updated', 'main', { node: { id: 'a', owner: 'agent', state: 'integrating', runId: 'child' } }, 2600),
    graphEvent('task.node.updated', 'main', { node: { id: 'a', owner: 'agent', state: 'done', runId: 'child' } }, 4500),
  ] });
  assert.equal(r.runs[0].acceptance.requestsAfterLastChildDelivery, 1);
});

test('legacy spawn metrics keep the original result shape and successful-request semantics', () => {
  const r = report([step(1, 'explore', { questions: [{ question: 'a' }, { question: 'b' }] }, { runs: [{ id: 'a' }, { id: 'b' }] })]);
  assert.deepEqual(r.runs[0].dispatch, { attempts: 1, successful: 1, failed: [], first: { step: 1, seconds: 0.1, requests: 1 } });
});

test('graph dispatches remain measurable from exported host events when the database is absent', async () => {
  const cell = await mkdtemp(path.join(tmpdir(), 'fh-graph-metrics-'));
  try {
    await mkdir(path.join(cell, 'relay'));
    await mkdir(path.join(cell, 'process', 'native'), { recursive: true });
    await writeFile(path.join(cell, 'relay', 'calls.json'), JSON.stringify([{ index: 1, startedMs: 1000, elapsedMs: 100 }]));
    await writeFile(path.join(cell, 'relay', 'request-1.json'), JSON.stringify({ messages: [{ role: 'system', content: 'Run ID: main.' }] }));
    const native = path.join(cell, 'process', 'native', 'kodo-events.jsonl');
    const content = [graphEvent('task.dispatch.committed', 'main', { nodeId: 'a', generation: 1, runId: 'child' }, 1500), graphEvent('agent.spawned', 'child', { parentId: 'main', nodeId: 'a' }, 1500)].map(event => JSON.stringify(event)).join('\n') + '\n';
    await writeFile(native, content);
    const r = await readEvidence(cell);
    assert.equal(r.runs.find(run => run.runId === 'main').dispatch.actualDispatches, 1);
    assert.deepEqual(r.runs.find(run => run.runId === 'main').children, [{ id: 'child', statusAtParentEnd: null, finalStatus: 'unknown' }]);
    assert.equal(r.runs.find(run => run.runId === 'child').parentId, 'main');
    assert.equal(await readFile(native, 'utf8'), content);
  } finally { await rm(cell, { recursive: true, force: true }); }
});
