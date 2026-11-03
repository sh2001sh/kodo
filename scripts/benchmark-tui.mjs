import assert from 'node:assert/strict';
import console from 'node:console';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout, clearTimeout } from 'node:timers';
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import { KodoTui, visibleTranscript } from '../dist/tui/view.js';
import { terminalText } from '../dist/cli/terminal.js';

// Run after npm run build. This isolated fixture never opens a Store or calls a model.
const { values } = parseArgs({ options: { samples: { type: 'string', default: '60' }, columns: { type: 'string', default: '48,80,120' }, terminal: { type: 'boolean', default: false }, scroll: { type: 'boolean', default: false }, stream: { type: 'boolean', default: false }, output: { type: 'string' } } });
const samples = Number(values.samples);
const widths = values.terminal ? [process.stdout.columns] : values.columns.split(',').map(Number);
if (!Number.isInteger(samples) || samples < 10 || samples > 200) throw new Error('--samples must be an integer between 10 and 200');
if (values.terminal && !process.stdout.isTTY) throw new Error('--terminal requires a real terminal; omit it for the in-memory TTY stream');
if (widths.some(width => !Number.isInteger(width) || width < 20 || width > 300)) throw new Error('--columns must contain integers between 20 and 300');

const largeOutput = '工具输出中文 English '.repeat(8_000);
const entries = Array.from({ length: 10_000 }, (_, index) => index % 127 === 0 || index === 9_999
  ? { id: String(index), kind: 'tool', title: 'shell.exec', status: 'succeeded', text: `call ${index}\n${largeOutput}\nexit 0` }
  : { id: String(index), kind: index % 17 === 0 ? 'error' : index % 3 === 0 ? 'assistant' : 'tool', title: index % 3 ? 'file.read' : undefined, status: index % 3 ? 'succeeded' : undefined, text: `本地合成记录 ${index} · English 与中文证据` });
const percentile = (data, quantile) => [...data].sort((a, b) => a - b)[Math.ceil(data.length * quantile) - 1];
const distribution = data => ({ samples: data.length, p50Ms: Number(percentile(data, 0.5).toFixed(3)), p95Ms: Number(percentile(data, 0.95).toFixed(3)), maxMs: Number(Math.max(...data).toFixed(3)) });
const megabytes = bytes => Number((bytes / 1024 / 1024).toFixed(2));
const timeout = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not render within 5 seconds`)), 5_000); })]).finally(() => clearTimeout(timer));
};

async function measure(columns) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(enabled) { this.isRaw = enabled; return this; } });
  const listeners = new Set();
  const rows = values.terminal ? process.stdout.rows : 24;
  let pending, ready;
  let bytesWritten = 0, frames = 0;
  const renderTimes = [];
  const readiness = new Promise(resolve => { ready = resolve; });
  const stdout = Object.assign(new Writable({ write(chunk, encoding, callback) {
    bytesWritten += chunk.length;
    const written = terminalText(chunk.toString());
    const complete = () => {
      callback();
      if (written.includes('发给主代理')) ready();
      if (pending && written.includes(pending.character)) { const { resolve, started } = pending; pending = undefined; resolve(performance.now() - started); }
    };
    if (values.terminal) process.stdout.write(chunk, encoding, complete);
    else complete();
  } }), { isTTY: true, columns, rows });
  let errors = '';
  const stderr = new Writable({ write(chunk, _encoding, callback) { errors += chunk.toString(); callback(); } });
  let snapshot = { workspace: 'synthetic-benchmark', model: 'no-model-called', status: 'idle', entries, tasks: [], questions: [], queue: [], usage: '合成性能场景；无模型调用', busy: false, quitting: false };
  const controller = { snapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, submit: async () => {}, dismissPanel() {}, interrupt: async () => {}, quit: async () => {}, onText() {}, close: async () => {} };
  const before = process.memoryUsage();
  const instance = render(createElement(KodoTui, { controller, columns, rows }), { stdin, stdout, stderr, interactive: true, alternateScreen: true, incrementalRendering: true, maxFps: 25, exitOnCtrlC: false, patchConsole: false, onRender: metric => { frames++; renderTimes.push(metric.renderTime); } });
  try {
    await timeout(readiness, 'Initial frame');
    await instance.waitUntilRenderFlush();
    const latency = [];
    for (let sample = 0; sample < samples + 5; sample++) {
      const character = String.fromCodePoint(0x9e00 + sample);
      const elapsed = await timeout(new Promise(resolve => {
        pending = { character, started: performance.now(), resolve };
        if (values.stream) {
          snapshot = { ...snapshot, entries: [...entries, { id: 'live-output', kind: 'assistant', text: `收到新增流式记录 ${sample}` }] };
          listeners.forEach(listener => listener());
        }
        if (values.scroll) stdin.write('\u001b[5~');
        stdin.write(character);
      }), `Input ${sample}`);
      await instance.waitUntilRenderFlush();
      if (sample >= 5) latency.push(elapsed);
    }
    assert.equal(errors, '', 'Ink wrote an error');
    const after = process.memoryUsage();
    return { columns, rows, inputToOutput: { ...distribution(latency), samplesMs: latency.map(value => Number(value.toFixed(3))) }, inkRender: distribution(renderTimes), frames, bytesWritten, memory: { rssMb: megabytes(after.rss), heapUsedMb: megabytes(after.heapUsed), rssDeltaMb: megabytes(after.rss - before.rss), heapDeltaMb: megabytes(after.heapUsed - before.heapUsed) } };
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    instance.cleanup();
    assert.equal(stdin.isRaw, false, 'Raw mode was not restored');
    assert.equal(listeners.size, 0, 'TUI subscription leaked');
    stdin.destroy(); stdout.destroy(); stderr.destroy();
  }
}

const viewports = [];
for (const columns of widths) viewports.push(await measure(columns));
const coldPageTimes = [];
const coldPages = entries.map(entry => ({ ...entry }));
let offset = 0;
for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
  const started = performance.now();
  const page = visibleTranscript(coldPages, 80, 16, offset + 14);
  offset = page.offset;
  coldPageTimes.push(performance.now() - started);
  assert(page.lines.length > 0 && page.lines.length <= 16);
}
const coldStarted = performance.now();
visibleTranscript(entries, 80, 16, 100_000, true);
const coldOldestProjectionMs = Number((performance.now() - coldStarted).toFixed(3));
const deepScrolling = [];
for (let sample = 0; sample < 10; sample++) {
  const started = performance.now();
  const page = visibleTranscript(entries, 80, 16, 100_000, true);
  deepScrolling.push(performance.now() - started);
  assert(page.lines.length > 0 && page.lines.length <= 16);
  assert.equal(page.hasOlder, false, 'Deep scrolling did not reach the oldest record');
}
const report = {
  environment: { timestamp: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ink: '8.0.0', maxFps: 25 },
  method: { records: entries.length, largeToolCharacters: largeOutput.length, transport: values.terminal ? 'real terminal stdout' : 'in-memory TTY stream', scrollingDuringInput: values.scroll, streamingDuringInput: values.stream, latency: 'Injected input to completion of Ink stdout write; excludes OS painting, real keyboard transport, IME composition, model and network latency.', warmupInputs: 5, thresholds: 'Reported measurements only; no timing assertion.' },
  viewports, consecutiveColdPages: { ...distribution(coldPageTimes), samplesMs: coldPageTimes.map(value => Number(value.toFixed(3))) }, oldestPageProjection: { coldMs: coldOldestProjectionMs, cached: distribution(deepScrolling), note: 'Direct oldest-page projection is a cold jump across all records; normal PageUp visits and caches only the next viewport.' },
};
const json = JSON.stringify(report, null, 2);
if (values.output) await writeFile(values.output, `${json}\n`, 'utf8');
console.log(json);
