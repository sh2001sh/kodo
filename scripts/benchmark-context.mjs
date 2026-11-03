import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import console from 'node:console';
import process from 'node:process';
import { Application } from '../dist/application/index.js';
import { estimateTextTokens, estimateInputTokens } from '../dist/runtime/context-tokens.js';
import { buildContext } from '../dist/runtime/context.js';

// Repeatable local measurements, not a wall-clock threshold in the unit suite.
const directory = mkdtempSync(path.join(os.tmpdir(), 'kodo-context-benchmark-'));
const app = new Application(path.join(directory, 'data'));
const sample = 'Evidence 中文かな한글 😀 source_code = value + 123;\n';
function median(operation) {
  operation(); // warm up
  const times = [];
  for (let count = 0; count < 5; count++) {
    const started = performance.now();
    operation();
    times.push(performance.now() - started);
  }
  return Number(times.sort((a, b) => a - b)[2].toFixed(2));
}
try {
  const results = [];
  for (const chars of [100_000, 1_000_000]) {
    const text = sample.repeat(Math.ceil(chars / sample.length)).slice(0, chars);
    const run = app.createRun({ objective: 'Benchmark bounded context; preserve evidence.', workspace: directory,
      binding: { model: 'benchmark', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED_BENCHMARK', limits: { context: 1_000_000, output: 16384 } } });
    const initial = app.store.readBlob(run.contextRef);
    const messages = [...initial];
    for (let index = 0; index < 100; index++) messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `read-${index}`, name: 'file.read', arguments: '{"path":"proof.txt"}' }] },
      { role: 'tool', tool_call_id: `read-${index}`, content: text.slice(index * chars / 100, (index + 1) * chars / 100) },
    );
    app.store.updateRun(run.id, { contextRef: app.store.blob(messages) });
    const current = app.store.run(run.id);
    const contextOptions = { maxContextTokens: Math.floor(chars / 8), maxOutputTokens: 1024 };
    const tokens = estimateTextTokens(text);
    const textMs = median(() => estimateTextTokens(text));
    const rawInputMs = median(() => estimateInputTokens(app.store, current, messages, []));
    const compactionMs = median(() => buildContext(app.store, current, null, [], contextOptions));
    const requestRef = app.store.blob({ binding: current.binding, messages, tools: [], maxOutputTokens: 16384 });
    const resultRef = app.store.blob({ usage: { input: tokens, output: 10 } });
    app.store.putCall({ id: `measured-${run.id}`, runId: run.id, step: 0, kind: 'model', name: 'benchmark', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef, resultRef });
    const withTail = [...messages, { role: 'user', content: 'Next: verify the actual final evidence.' }];
    const measuredInputMs = median(() => estimateInputTokens(app.store, current, withTail, []));
    results.push({ chars, tokens, textMs, rawInputMs, measuredInputMs, compactionMs });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, rounds: 100, medianSamples: 5, results }, null, 2));
} finally { await app.shutdown(); rmSync(directory, { recursive: true, force: true }); }
