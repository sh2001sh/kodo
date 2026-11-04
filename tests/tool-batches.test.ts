import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { ReadOnlyCommand } from '../src/tools/index.js';
import { ToolRegistry, toolFingerprint } from '../src/tools/registry.js';
import type { ToolRegistration } from '../src/tools/registry.js';
import { toolBatches } from '../src/runtime/tool-batch.js';
import type { Message, Permission, ToolRequest } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const card = (tools: string[]): string => `---\nschema_version: 1\nid: test/batch\nversion: 1.0.0\nname: Batch\ndescription: Batch test agent\ncapabilities:\n  tools: [${tools.join(', ')}]\n---\nWork carefully`;

interface Trace { active: number; peak: number; spans: Map<string, { start: number; end: number }> }
const trace = (): Trace => ({ active: 0, peak: 0, spans: new Map() });

/** A read tool that waits `waitMs` (or until aborted) and records when each value ran. */
function probe(name: string, state: Trace, concurrencySafe?: boolean): ToolRegistration {
  return {
    name, description: 'Wait briefly and echo a value.', permission: 'read', effect: 'read',
    ...(concurrencySafe === undefined ? {} : { concurrencySafe }),
    parameters: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' }, waitMs: { type: 'integer' } }, required: ['value'] },
    async execute(context, args) {
      const span = { start: performance.now(), end: 0 };
      state.spans.set(args.value as string, span);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, (args.waitMs as number | undefined) ?? 40);
          context.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        context.signal.throwIfAborted();
        return { value: args.value };
      } finally { state.active--; span.end = performance.now(); }
    },
  };
}

async function runBatch(options: { tools?: ToolRegistration[]; cardTools: string[]; requests: ToolRequest[]; permissions?: Permission[]; readOnlyCommands?: ReadOnlyCommand[]; files?: Record<string, string> }, inspect: (app: Application, runId: string, seen: Message[]) => void): Promise<void> {
  const root = temp();
  for (const [name, content] of Object.entries(options.files ?? {})) writeFileSync(path.join(root, name), content);
  let seen: Message[] = [];
  const app = new Application(path.join(root, '.state'), scripted(calls(...options.requests), async request => { seen = request.messages; return answer(); }), undefined, { tools: options.tools ?? [], readOnlyCommands: options.readOnlyCommands ?? [] });
  try {
    const created = app.createRun({ objective: 'Run the batch.', workspace: root, binding, permissions: options.permissions ?? ['read'], card: app.parseCard(card(options.cardTools)) });
    const run = await app.run(created.id);
    expect(run.status, run.error).toBe('completed');
    inspect(app, run.id, seen);
  } finally { await app.shutdown(); }
}

const callOf = (app: Application, runId: string, id: string) => app.store.calls(runId).find(item => item.kind === 'tool' && item.id.endsWith(`:${id}`))!;
const resultOf = (app: Application, runId: string, id: string) => app.store.readBlob<Record<string, unknown>>(callOf(app, runId, id).resultRef!);

describe('tool batch orchestration', () => {
  it('groups consecutive concurrency-safe calls into batches of at most eight', () => {
    const safe = (id: string): ToolRequest => call('safe', {}, id);
    const plain = (id: string): ToolRequest => call('plain', {}, id);
    const requests = [safe('a'), safe('b'), plain('c'), safe('d'), ...Array.from({ length: 9 }, (_, index) => safe(`e${index}`))];
    expect(toolBatches(requests, request => request.name === 'safe').map(batch => batch.map(request => request.id)))
      .toEqual([['a', 'b'], ['c'], ['d', 'e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'], ['e7', 'e8']]);
  });

  it('runs concurrency-safe reads in parallel and records results in request order', async () => {
    const state = trace();
    await runBatch({
      tools: [probe('probe.safe', state, true)], cardTools: ['probe.safe'],
      requests: [call('probe.safe', { value: 'a', waitMs: 80 }, 'a'), call('probe.safe', { value: 'b', waitMs: 10 }, 'b'), call('probe.safe', { value: 'c', waitMs: 40 }, 'c')],
    }, (app, runId, seen) => {
      expect(state.peak).toBe(3);
      expect(seen.filter(message => message.role === 'tool').map(message => message.role === 'tool' && message.tool_call_id)).toEqual(['a', 'b', 'c']);
      const finished = app.store.events(runId, { types: ['tool.finished'] }).map(event => String(event.data.callId).split(':').at(-1));
      expect(finished).toEqual(['a', 'b', 'c']);
    });
  });

  it('keeps undeclared tools serial between parallel batches', async () => {
    const state = trace();
    await runBatch({
      tools: [probe('probe.safe', state, true), probe('probe.plain', state)], cardTools: ['probe.safe', 'probe.plain'],
      requests: [call('probe.safe', { value: 'a' }, 'a'), call('probe.safe', { value: 'b' }, 'b'), call('probe.plain', { value: 'c' }, 'c'), call('probe.plain', { value: 'd' }, 'd')],
    }, () => {
      expect(state.peak).toBe(2);
      const span = (value: string) => state.spans.get(value)!;
      expect(span('c').start).toBeGreaterThanOrEqual(Math.max(span('a').end, span('b').end));
      expect(span('d').start).toBeGreaterThanOrEqual(span('c').end);
    });
  });

  it('caps one parallel batch at eight calls', async () => {
    const state = trace();
    await runBatch({
      tools: [probe('probe.safe', state, true)], cardTools: ['probe.safe'],
      requests: Array.from({ length: 10 }, (_, index) => call('probe.safe', { value: `v${index}`, waitMs: 60 }, `v${index}`)),
    }, () => expect(state.peak).toBe(8));
  });

  it('allows a later independent batch after a failed command', async () => {
    await runBatch({
      cardTools: ['process.exec', 'file.read'], permissions: ['read', 'write', 'exec'], files: { 'a.txt': 'alpha' },
      requests: [call('process.exec', { program: process.execPath, args: ['-e', 'process.exit(3)'] }, 'cmd'), call('file.read', { path: 'a.txt' }, 'read')],
    }, (app, runId) => {
      expect(callOf(app, runId, 'cmd').status).toBe('succeeded');
      expect(resultOf(app, runId, 'cmd').exitCode).toBe(3);
      expect(callOf(app, runId, 'read').status).toBe('succeeded');
      expect(resultOf(app, runId, 'read').content).toBe('alpha');
      expect(app.store.hasEvent(runId, { types: ['tool.started'], match: { callId: callOf(app, runId, 'read').id } })).toBe(true);
    });
  });

  it('stops in-flight parallel siblings when a host command fails', async () => {
    const state = trace();
    const failing = { program: process.execPath, args: ['-e', 'process.exit(2)'] };
    const started = performance.now();
    await runBatch({
      tools: [probe('probe.safe', state, true)], cardTools: ['probe.safe', 'process.run'], readOnlyCommands: [failing],
      requests: [call('probe.safe', { value: 'slow', waitMs: 60_000 }, 'slow'), call('process.run', failing, 'cmd')],
    }, (app, runId) => {
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(resultOf(app, runId, 'cmd').exitCode).toBe(2);
      expect(callOf(app, runId, 'slow').status).toBe('cancelled');
      expect(String(resultOf(app, runId, 'slow').error)).toMatch(/^SIBLING_FAILED: /);
    });
  });
});

describe('tool concurrency declarations', () => {
  const registration = (overrides: Partial<ToolRegistration> = {}): ToolRegistration => ({ name: 'custom.read', description: 'Read a value.', permission: 'read', effect: 'read', parameters: { type: 'object' }, execute: () => null, ...overrides });

  it('accepts concurrency only for read effects and keeps it out of the pinned contract', () => {
    const registry = new ToolRegistry();
    registry.register(registration({ concurrencySafe: true }));
    expect(registry.get('custom.read')!.concurrencySafe).toBe(true);
    expect(toolFingerprint(registration({ concurrencySafe: true }))).toBe(toolFingerprint(registration()));
    expect(() => registry.register(registration({ name: 'custom.write', permission: 'write', effect: 'write', concurrencySafe: true }))).toThrow('concurrency');
    expect(() => registry.register(registration({ name: 'custom.flag', concurrencySafe: 'yes' as unknown as boolean }))).toThrow('concurrency');
  });
});
