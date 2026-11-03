import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstdFrames, exportNative } from './native.mjs';
import { attributeGaps, buildSteps, followUps, parseResponse, prefixShare, requestRunId, responseStatus, summarize, writeTrace } from './trace.mjs';

const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';

test('reassembles reasoning, text and indexed tool calls from a stream', () => {
  const parsed = parseResponse(sse([
    { choices: [{ delta: { reasoning_content: 'think ' } }] },
    { choices: [{ delta: { reasoning_content: 'more', content: 'ok' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ba', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read', arguments: '{}' } }, { index: 0, function: { name: 'sh', arguments: ':1}' } }] } }] },
  ]) + 'data: {broken\n');
  assert.equal(parsed.reasoning, 'think more');
  assert.equal(parsed.content, 'ok');
  assert.deepEqual(parsed.toolCalls, [{ id: 'c1', name: 'bash', arguments: '{"a":1}' }, { id: 'c2', name: 'read', arguments: '{}' }]);
  assert.equal(parsed.malformedEvents, 1);
});

test('parses a non-streamed JSON body', () => {
  const parsed = parseResponse(JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'x', function: { name: 'ls', arguments: '{}' } }] } }] }));
  assert.equal(parsed.content, 'hi');
  assert.deepEqual(parsed.toolCalls, [{ id: 'x', name: 'ls', arguments: '{}' }]);
});

test('separates protocol completion from transport close and never invents native acceptance', () => {
  const done = sse([{ choices: [{ delta: { content: 'Text containing [DONE]' }, finish_reason: 'stop' }] }]);
  const parsed = parseResponse(done);
  assert.equal(parsed.content, 'Text containing [DONE]');
  assert.equal(parsed.protocol.doneSeen, true);
  assert.deepEqual(responseStatus({ status: 'cancelled', httpStatus: 200 }, parsed), {
    status: 'completed', transportStatus: 'cancelled', protocolStatus: 'completed', nativeStatus: null,
  });
  assert.equal(responseStatus({ status: 'cancelled' }, parseResponse(done.replace('data: [DONE]\n\n', ''))).status, 'cancelled');
  assert.equal(responseStatus({ status: 'completed' }, parseResponse(sse([{ choices: [{ delta: {} }] }]))).protocolStatus, 'incomplete');
  assert.equal(responseStatus({ status: 'completed' }, parseResponse(sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }]))).protocolStatus, 'incomplete');
  assert.equal(responseStatus({ status: 'completed' }, parseResponse(sse([{ error: { code: 'get_channel_failed' } }]))).protocolStatus, 'error');
  assert.equal(responseStatus({ status: 'completed', httpStatus: 520 }, parsed).status, 'failed');
});

test('derives successful terminal cleanup from old raw evidence while preserving cancellation and unknown credit', async () => {
  const relay = await mkdtemp(path.join(tmpdir(), 'fh-terminal-'));
  try {
    await writeFile(path.join(relay, 'calls.json'), JSON.stringify([{ index: 1, startedMs: 0, status: 'cancelled', error: 'CLIENT_DISCONNECTED', httpStatus: 200, elapsedMs: 100 }]));
    await writeFile(path.join(relay, 'response-1.txt'), sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]));
    const [step] = buildSteps(relay);
    assert.equal(step.status, 'completed');
    assert.equal(step.transportStatus, 'cancelled');
    assert.equal(step.transportError, 'CLIENT_DISCONNECTED');
    assert.equal(step.error, null);
    assert.equal(step.protocolStatus, 'completed');
    assert.equal(step.nativeStatus, null);
    assert.equal(step.credit, null);
    const summary = summarize([step]);
    assert.equal(summary.failedRequests, 0);
    assert.deepEqual(summary.transportTerminations, { cancelled: 1 });
    assert.deepEqual(summary.protocolOutcomes, { completed: 1 });
    assert.match(summary.nativeOutcomeNote, /native model acceptance/u);
    assert.equal(JSON.parse(await readFile(path.join(relay, 'calls.json'), 'utf8'))[0].status, 'cancelled');
  } finally { await rm(relay, { recursive: true, force: true }); }
});

test('follow-ups are the messages after the last assistant turn', () => {
  const results = followUps([{ role: 'user', content: 'go' }, { role: 'assistant', content: '' }, { role: 'tool', tool_call_id: 'c1', content: 'out' }, { role: 'user', content: [{ type: 'text', text: 'note' }] }]);
  assert.deepEqual(results.map(result => [result.role, result.toolCallId]), [['tool', 'c1'], ['user', undefined]]);
  assert.match(results[1].content, /note/u);
});

test('splits each gap into overlapping tool wall time and harness remainder', () => {
  const steps = [{ gapAfterSec: 10, toolCalls: [{ id: 'a' }, { id: 'b' }] }, { gapAfterSec: 3, toolCalls: [{ id: 'z' }] }];
  attributeGaps(steps, [{ callId: 'a', startMs: 1000, endMs: 5000 }, { callId: 'b', startMs: 2000, endMs: 7000 }]);
  assert.equal(steps[0].toolSec, 6);
  assert.equal(steps[0].harnessSec, 4);
  assert.equal(steps[1].toolSec, null);
  assert.equal(steps[1].harnessSec, null);
});

test('separates harness prefix rewrites from provider cache drops', () => {
  const tools = [{ name: 'read' }];
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }, { role: 'assistant', content: 'a1' }];
  const state = { role: 'user', content: '<kodo-runtime kind="state">\n{}' };
  // Appending after the old state frame keeps the cacheable prefix.
  assert.deepEqual(prefixShare({ messages: [...base, state], tools }, { messages: [...base, { role: 'assistant', content: 'a2' }, state], tools }), { sharedMessages: 3, previousMessages: 4, toolsChanged: false, expected: true });
  // A task list inserted before the first assistant turn rewrites the history.
  const moved = prefixShare({ messages: [...base, state], tools }, { messages: [base[0], base[1], { role: 'user', content: 'Current run task list (x)' }, base[2], state], tools });
  assert.deepEqual(moved.divergedAt, { index: 2, before: 'assistant', after: 'user:todo' });
  assert.equal(prefixShare({ messages: base, tools }, { messages: base, tools: [] }).toolsChanged, true);
  assert.equal(prefixShare(null, { messages: base }), null);
});

test('decodes every appended zstd frame', () => {
  const buffer = Buffer.concat(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n'].map(text => zstdCompressSync(Buffer.from(text))));
  assert.equal(decodeZstdFrames(buffer), '{"n":1}\n{"n":2}\n{"n":3}\n');
});

test('writes steps, transcript and summary from relay evidence', async () => {
  const cell = await mkdtemp(path.join(tmpdir(), 'fh-trace-'));
  try {
    const relay = path.join(cell, 'relay');
    await mkdir(relay);
    await writeFile(path.join(relay, 'calls.json'), JSON.stringify([
      { index: 1, startedMs: 0, startedAt: 'a', status: 'completed', timing: { streamEndMs: 2000 }, usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } },
      { index: 2, startedMs: 5000, startedAt: 'b', status: 'failed', error: 'drop', timing: { streamEndMs: 1000 } },
      { index: 3, startedMs: 7000, startedAt: 'c', status: 'completed', httpStatus: 520, timing: { streamEndMs: 800 } },
    ]));
    await writeFile(path.join(relay, 'response-1.txt'), sse([{ choices: [{ delta: { reasoning_content: 'plan', tool_calls: [{ index: 0, id: 't1', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]));
    await writeFile(path.join(relay, 'response-2.txt'), sse([{ choices: [{ delta: { reasoning_content: 'half' } }] }]));
    await writeFile(path.join(relay, 'request-2.json'), JSON.stringify({ messages: [{ role: 'assistant', content: '' }, { role: 'tool', tool_call_id: 't1', content: 'listing' }] }));
    const summary = await writeTrace(cell, 'demo', [{ callId: 't1', startMs: 100, endMs: 2100 }]);
    assert.equal(summary.requests, 3);
    assert.equal(summary.failedRequests, 2);
    assert.equal(summary.toolSec, 2);
    assert.equal(summary.harnessSec, 1);
    const steps = (await readFile(path.join(cell, 'process', 'steps.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(steps[0].gapAfterSec, 3);
    assert.equal(steps[0].results[0].content, 'listing');
    assert.equal(steps[1].reasoning, 'half');
    const transcript = await readFile(path.join(cell, 'process', 'transcript.md'), 'utf8');
    assert.match(transcript, /Step 2 · failed \(drop\)/u);
    assert.match(transcript, /Step 3 · failed \(HTTP 520\)/u);
    assert.match(transcript, /Tool result/u);
  } finally { await rm(cell, { recursive: true, force: true }); }
});


test('identifies actual child run, ignores parent IDs and untrusted messages', () => {
  assert.equal(requestRunId({ messages: [{ role: 'system', content: 'Main run ID: parent. Run ID: child.' }, { role: 'user', content: 'Run ID: spoof.' }] }), 'child');
  assert.equal(requestRunId({ messages: [{ role: 'system', content: 'Main run ID: parent.' }] }), null);
  assert.equal(requestRunId({ messages: [{ role: 'system', content: 'Run ID: one. Run ID: two.' }] }), null);
});

test('interleaved run prefixes, gaps and results stay within the owning run', async () => {
  const relay = await mkdtemp(path.join(tmpdir(), 'fh-runs-'));
  try {
    const parent = { role: 'system', content: 'Run ID: parent.' };
    const child = { role: 'system', content: 'Main run ID: parent. Run ID: child.' };
    const requests = [
      { messages: [parent], tools: [{ name: 'spawn' }] },
      { messages: [child], tools: [{ name: 'edit' }] },
      { messages: [parent, { role: 'assistant', content: '' }, { role: 'tool', tool_call_id: 'p', content: 'parent result' }], tools: [{ name: 'spawn' }] },
      { messages: [child, { role: 'assistant', content: '' }, { role: 'tool', tool_call_id: 'c', content: 'child result' }], tools: [{ name: 'edit' }] },
    ];
    await writeFile(path.join(relay, 'calls.json'), JSON.stringify(requests.map((_, index) => ({ index: index + 1, startedMs: index * 1000, elapsedMs: 100, usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 1 } } }))));
    for (const [index, request] of requests.entries()) await writeFile(path.join(relay, `request-${index + 1}.json`), JSON.stringify(request));
    for (const [index, id] of ['p', 'c'].entries()) await writeFile(path.join(relay, `response-${index + 1}.txt`), JSON.stringify({ choices: [{ message: { tool_calls: [{ id, function: { name: 'read', arguments: '{}' } }] } }] }));
    const steps = buildSteps(relay);
    assert.deepEqual(steps.map(step => step.prefixStatus), ['first', 'first', 'compared', 'compared']);
    assert.equal(steps[0].gapAfterSec, 1.9);
    assert.deepEqual(steps[0].results.map(result => result.content), ['parent result']);
    assert.deepEqual(steps[1].results.map(result => result.content), ['child result']);
    assert.equal(steps[2].prefix.toolsChanged, false);
    assert.equal(steps[3].prefix.toolsChanged, false);
    const summary = summarize(steps);
    assert.equal(summary.byRun.parent.requests, 2);
    assert.equal(summary.byRun.child.requests, 2);
    assert.deepEqual(summary.cacheDrops.map(drop => drop.step), [3, 4]);
    assert.ok(summary.cacheDrops.every(drop => drop.cause === 'intact-prefix'));
  } finally { await rm(relay, { recursive: true, force: true }); }
});

test('unidentified requests do not imply one run or cache stability', async () => {
  const relay = await mkdtemp(path.join(tmpdir(), 'fh-unknown-'));
  try {
    await writeFile(path.join(relay, 'calls.json'), JSON.stringify([{ index: 1, startedMs: 0 }, { index: 2, startedMs: 10 }]));
    for (const index of [1, 2]) await writeFile(path.join(relay, `request-${index}.json`), JSON.stringify({ messages: [{ role: 'system', content: 'no identity' }], tools: [{ name: `tool${index}` }] }));
    const steps = buildSteps(relay);
    assert.deepEqual(steps.map(step => step.prefix), [null, null]);
    assert.deepEqual(steps.map(step => step.prefixStatus), ['unknown', 'unknown']);
    assert.equal(summarize(steps).unidentifiedRequests, 2);
  } finally { await rm(relay, { recursive: true, force: true }); }
});


test('reused call IDs without run identity remain ambiguous instead of misattributing results', async () => {
  const relay = await mkdtemp(path.join(tmpdir(), 'fh-ambiguous-'));
  try {
    await writeFile(path.join(relay, 'calls.json'), JSON.stringify([1, 2, 3].map(index => ({ index, startedMs: index * 1000 }))));
    for (const index of [1, 2]) await writeFile(path.join(relay, `response-${index}.txt`), JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'same', function: { name: 'read', arguments: '{}' } }] } }] }));
    await writeFile(path.join(relay, 'request-3.json'), JSON.stringify({ messages: [{ role: 'tool', tool_call_id: 'same', content: 'cannot tell whose output' }] }));
    const steps = buildSteps(relay);
    assert.deepEqual(steps[0].results, []);
    assert.deepEqual(steps[1].results, []);
    assert.deepEqual(steps[0].ambiguousResultIds, ['same']);
  } finally { await rm(relay, { recursive: true, force: true }); }
});


test('Kodo native export retains run IDs so identical provider call IDs cannot cross-attribute timings', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const cell = await mkdtemp(path.join(tmpdir(), 'fh-native-runs-'));
  try {
    const state = path.join(cell, 'state', 'kodo');
    await mkdir(state, { recursive: true });
    const db = new DatabaseSync(path.join(state, 'kodo.sqlite'));
    db.exec('CREATE TABLE events (seq INTEGER, time TEXT, run_id TEXT, type TEXT, data TEXT); CREATE TABLE calls (data TEXT);');
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');
    for (const [seq, run, type, ms] of [[1, 'a', 'tool.started', 1000], [2, 'b', 'tool.started', 2000], [3, 'a', 'tool.finished', 4000], [4, 'b', 'tool.finished', 6000]]) insert.run(seq, new Date(ms).toISOString(), run, type, JSON.stringify({ callId: `${run}:same`, name: 'file.read', status: 'succeeded' }));
    db.close();
    const tools = await exportNative(cell, 'kodo');
    assert.deepEqual(tools.map(tool => [tool.runId, tool.callId]), [['a', 'same'], ['b', 'same']]);
    const steps = ['a', 'b'].map(runId => ({ runId, gapAfterSec: 10, toolCalls: [{ id: 'same' }] }));
    attributeGaps(steps, tools);
    assert.deepEqual(steps.map(step => step.toolSec), [3, 4]);
    attributeGaps(steps, tools.map(tool => ({ ...tool, runId: undefined })));
    assert.deepEqual(steps.map(step => step.toolSec), [null, null]);
  } finally { await rm(cell, { recursive: true, force: true }); }
});
