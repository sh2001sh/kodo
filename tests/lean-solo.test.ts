import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { leanDefaultCard, simpleDefaultCard } from '../src/agents/card.js';
import { digest } from '../src/storage/index.js';
import { answer, call, calls, fixture } from './helpers.js';
import type { Message, Permission, Provider } from '../src/runtime/types.js';
import { leanStateFrame } from '../src/runtime/state-frame.js';

vi.mock('node:fs/promises', { spy: true });

type Request = Parameters<Provider['complete']>[0];
type Step = ReturnType<typeof calls> | ((request: Request) => ReturnType<typeof calls>);

/** Scripted provider that keeps every request it saw. */
function recording(...steps: Step[]): { provider: Provider; requests: Request[] } {
  const requests: Request[] = [];
  return { requests, provider: { async complete(request) {
    requests.push(structuredClone(request));
    const next = steps.shift();
    if (!next) throw new Error('unexpected model request');
    return typeof next === 'function' ? next(request) : next;
  } } };
}

function lean(permissions: Permission[], ...steps: Step[]) {
  const { provider, requests } = recording(...steps);
  const f = fixture(provider, permissions, { toolProfile: 'lean-solo', taskProtocol: 3 });
  return { ...f, requests };
}

const toolResults = (request: Request): Message[] => request.messages.filter(message => message.role === 'tool');
const lastResult = (request: Request): string => String(toolResults(request).at(-1)?.content ?? '');
const names = (request: Request): string[] => request.tools.map(tool => tool.name);

describe('lean-solo view', () => {
  it('retains settled failures in history without repeating them as pending state, while preserving unknown calls', async () => {
    const f = lean(['read', 'write'], calls(call('read', { path: 'missing.txt' }, 'missing')), answer());
    await f.app.run(f.runId);
    const run = f.app.store.run(f.runId), session = f.app.store.session(run.sessionId);
    const failure = f.app.store.calls(f.runId).find(item => item.kind === 'tool')!;
    expect(failure.status).toBe('failed');
    expect(lastResult(f.requests[1]!)).toContain('NOT_FOUND');
    expect(leanStateFrame(f.app.coordinator, run, session)).toBeUndefined();
    f.app.store.putCall({ ...failure, status: 'unknown' });
    expect(leanStateFrame(f.app.coordinator, run, session)?.content).toContain('unknown');
  });
  it('sends a short frozen request with the renamed tool view', async () => {
    const f = lean(['read', 'write', 'exec'], calls(call('read', { path: 'a.txt' })), answer());
    writeFileSync(path.join(f.root, 'a.txt'), 'alpha\n');
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    const [first, second] = f.requests as [Request, Request];
    expect(names(first)).toEqual(['read', 'edit', 'write', 'bash', 'job', 'ask_user']);
    const system = first.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
    expect(system.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(first.tools).length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(system).not.toContain('spawn_agent');
    expect(first.messages.some(message => String(message.content).includes('kind="agents"'))).toBe(false);
    // Nothing dynamic is pending on the first request, so no state frame is sent.
    expect(first.messages.at(-1)?.role).toBe('user');
    expect(lastResult(second)).toContain('alpha');
  });

  it('records the canonical kernel call beside the model call', async () => {
    const f = lean(['read', 'write'], calls(call('read', { path: 'a.txt' }, 'r1')), answer());
    writeFileSync(path.join(f.root, 'a.txt'), 'alpha\n');
    await f.app.coordinator.wake(f.runId);
    const record = f.app.store.calls(f.runId).find(item => item.kind === 'tool')!;
    expect(record.name).toBe('file.read');
    expect(f.app.store.readBlob<{ name: string; arguments: string }>(record.requestRef)).toMatchObject({ id: 'r1', name: 'file.read' });
    expect(f.app.store.readBlob<{ name: string }>(record.modelRequestRef!)).toMatchObject({ id: 'r1', name: 'read' });
  });

  it('rejects tools outside the view and malformed read targets before execution', async () => {
    const f = lean(['read', 'write'], calls(call('spawn_agent', { objective: 'x' }, 's'), call('read', { path: 'a.txt', artifact: 'x' }, 'r')), answer());
    await f.app.coordinator.wake(f.runId);
    const results = toolResults(f.requests[1]!).map(message => String(message.content));
    expect(results[0]).toContain('not part of this run');
    expect(results[1]).toContain('exactly one of path');
    expect(f.app.store.calls(f.runId).filter(item => item.kind === 'tool').every(item => item.status === 'failed')).toBe(true);
  });

  it('allows an exact unread edit while retaining observed-version checks', async () => {
    const f = lean(['read', 'write'],
      calls(call('edit', { path: 'old.txt', edits: [{ oldText: 'one', newText: 'two' }] }, 'e1')),
      calls(call('write', { path: 'new.txt', content: 'fresh\n' }, 'w1')),
      calls(call('read', { path: 'old.txt' }, 'r1')),
      request => { writeFileSync(path.join(f.root, 'old.txt'), 'one changed\n'); void request; return calls(call('edit', { path: 'old.txt', edits: [{ oldText: 'one', newText: 'two' }] }, 'e2')); },
      calls(call('read', { path: 'old.txt' }, 'r2')),
      calls(call('edit', { path: 'old.txt', edits: [{ oldText: 'one', newText: 'two' }] }, 'e3')),
      answer());
    writeFileSync(path.join(f.root, 'old.txt'), 'one\n');
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(lastResult(f.requests[1]!)).toContain('hash');
    expect(lastResult(f.requests[1]!)).not.toContain('FILE_UNREAD');
    expect(readFileSync(path.join(f.root, 'new.txt'), 'utf8')).toBe('fresh\n');
    expect(lastResult(f.requests[4]!)).toContain('FILE_STALE');
    expect(lastResult(f.requests[4]!)).not.toContain('file.read');
    const stale = JSON.parse(lastResult(f.requests[4]!)) as { error: string };
    expect(stale.error).toContain('read with {"path":"old.txt"}');
    expect(stale.error).toContain('Shell reads do not refresh');
    expect(readFileSync(path.join(f.root, 'old.txt'), 'utf8')).toBe('two changed\n');
  });

  it.each(['lean-solo', 'lean-team'] as const)('reuses exact content and records writes for subsequent edits in %s', async toolProfile => {
    const { app, root, runId } = fixture(undefined, ['read', 'write'], { toolProfile, taskProtocol: 3 });
    const file = path.join(root, 'known.txt');
    writeFileSync(file, 'alpha beta');
    const edit = (edits: { oldText: string; newText: string }[]) => app.coordinator.tools.execute(runId, 'file.patch', { path: 'known.txt', edits }, new AbortController().signal);
    await edit([{ oldText: 'alpha', newText: 'gamma' }, { oldText: 'beta', newText: 'delta' }]);
    expect(readFileSync(file, 'utf8')).toBe('gamma delta');
    await edit([{ oldText: 'gamma', newText: 'epsilon' }]);
    expect(readFileSync(file, 'utf8')).toBe('epsilon delta');
    writeFileSync(file, 'epsilon delta external change');
    await expect(edit([{ oldText: 'epsilon', newText: 'zeta' }])).rejects.toMatchObject({ code: 'FILE_STALE' });
    expect(readFileSync(file, 'utf8')).toBe('epsilon delta external change');
  });

  it.each([
    { content: 'same same', edits: [{ oldText: 'same', newText: 'next' }] },
    { content: 'alpha beta', edits: [{ oldText: 'missing', newText: 'next' }] },
    { content: 'alpha beta', edits: [{ oldText: 'alpha', newText: 'next' }, { oldText: 'missing', newText: 'last' }] },
  ])('leaves an unread file unchanged if any replacement cannot match uniquely: %j', async ({ content, edits }) => {
    const f = lean(['read', 'write'], calls(call('edit', { path: 'a.txt', edits })), answer());
    writeFileSync(path.join(f.root, 'a.txt'), content);
    await f.app.run(f.runId);
    expect(lastResult(f.requests[1]!)).toContain('PATCH_MATCH');
    expect(readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe(content);
  });

  it('still requires reading before a whole-file overwrite', async () => {
    const f = lean(['read', 'write'], calls(call('write', { path: 'a.txt', content: 'replacement' })), answer());
    writeFileSync(path.join(f.root, 'a.txt'), 'original');
    await f.app.run(f.runId);
    expect(lastResult(f.requests[1]!)).toContain('FILE_STALE');
    expect(readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('original');
  });

  it('preserves a concurrent change while preparing an initially unread edit', async () => {
    const { app, root, runId } = lean(['read', 'write']);
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'original');
    const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const spy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (typeof args[0] === 'string' && path.basename(args[0]).startsWith('.kodo-')) writeFileSync(file, 'external change');
    });
    try {
      await expect(app.coordinator.tools.execute(runId, 'file.patch', {
        path: 'a.txt', edits: [{ oldText: 'original', newText: 'replacement' }],
      }, new AbortController().signal)).rejects.toMatchObject({ code: 'FILE_STALE' });
      expect(readFileSync(file, 'utf8')).toBe('external change');
    } finally { spy.mockRestore(); }
  });

  it.each(['full', 'compact-v1', 'compact-v2'] as const)('retains the read prerequisite in %s', async toolProfile => {
    const { app, root, runId } = fixture(undefined, ['read', 'write'], { toolProfile });
    const run = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...run.card, tools: [...new Set([...run.card.tools, 'file.patch'])] } });
    writeFileSync(path.join(root, 'a.txt'), 'original');
    await expect(app.coordinator.tools.execute(runId, 'file.patch', {
      path: 'a.txt', expectedHash: digest('original'), edits: [{ oldText: 'original', newText: 'replacement' }],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'FILE_UNREAD' });
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('original');
  });

  it('reports FILE_STALE when a missing write target appears before the write', async () => {
    const f = lean(['read', 'write'],
      calls(call('read', { path: 'race.txt' }, 'r1')),
      request => { writeFileSync(path.join(f.root, 'race.txt'), 'theirs\n'); void request; return calls(call('write', { path: 'race.txt', content: 'mine\n' }, 'w1')); },
      answer());
    await f.app.coordinator.wake(f.runId);
    expect(lastResult(f.requests[2]!)).toMatch(/FILE_STALE|FILE_UNREAD/);
    expect(readFileSync(path.join(f.root, 'race.txt'), 'utf8')).toBe('theirs\n');
  });

  it('offers file management without exec and creates nested directories one level at a time', async () => {
    const f = lean(['read', 'write'],
      calls(call('mkdir', { path: 'a' }, 'm1')),
      calls(call('mkdir', { path: 'a/b' }, 'm2')),
      calls(call('read', { path: 'x.txt' }, 'r1')),
      calls(call('move', { path: 'x.txt', destination: 'a/b/y.txt' }, 'mv')),
      calls(call('read', { path: 'gone.txt' }, 'r2')),
      calls(call('delete', { path: 'gone.txt' }, 'd1')),
      calls(call('list', { path: 'a/b' }, 'l1'), call('search', { path: '.', query: 'payload' }, 's1')),
      answer());
    writeFileSync(path.join(f.root, 'x.txt'), 'payload\n');
    writeFileSync(path.join(f.root, 'gone.txt'), 'bye\n');
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(names(f.requests[0]!)).toEqual(['read', 'edit', 'write', 'search', 'list', 'mkdir', 'move', 'delete', 'ask_user']);
    expect(readFileSync(path.join(f.root, 'a', 'b', 'y.txt'), 'utf8')).toBe('payload\n');
    expect(existsSync(path.join(f.root, 'gone.txt'))).toBe(false);
    expect(toolResults(f.requests[7]!).map(message => String(message.content)).join('\n')).toContain('y.txt');
  });

  it('batches canonical read calls concurrently', async () => {
    const f = lean(['read', 'write'], calls(call('read', { path: 'a.txt' }, 'a'), call('read', { path: 'b.txt' }, 'b')), answer());
    writeFileSync(path.join(f.root, 'a.txt'), 'A\n');
    writeFileSync(path.join(f.root, 'b.txt'), 'B\n');
    await f.app.coordinator.wake(f.runId);
    const results = toolResults(f.requests[1]!);
    expect(results.map(message => (message as { tool_call_id?: string }).tool_call_id)).toEqual(['a', 'b']);
    expect(results.map(message => String(message.content)).join('')).toMatch(/A[\s\S]*B/);
  });

  it('appends one durable time hint per crossed threshold', async () => {
    const f = lean(['read', 'write'], calls(call('read', { path: 'a.txt' })), answer());
    writeFileSync(path.join(f.root, 'a.txt'), 'alpha\n');
    const session = f.app.store.session(f.app.store.run(f.runId).sessionId);
    f.app.store.putSession({ ...session, budget: { ...session.budget, maxDurationMs: 3_600_000 }, activeMs: 2_800_000 });
    await f.app.coordinator.wake(f.runId);
    const hints = (request: Request) => request.messages.filter(message => String(message.content).includes('session time budget remain')).length;
    expect(hints(f.requests[0]!)).toBe(1);
    expect(hints(f.requests[1]!)).toBe(1);
    expect(f.app.store.countEvents(f.runId, { types: ['run.time_hint'] })).toBe(1);
  });

  it('leaves legacy profiles without view tools and keeps published cards', async () => {
    const { provider, requests } = recording(answer());
    const f = fixture(provider, ['read', 'write', 'exec'], { toolProfile: 'compact-v2' });
    mkdirSync(path.join(f.root, 'unused'));
    await f.app.coordinator.wake(f.runId);
    expect(names(requests[0]!)).not.toContain('read');
    expect(names(requests[0]!)).toContain('file.read');
    expect(String(requests[0]!.messages[0]!.content)).not.toContain('You are Kodo, a coding agent.');
    expect(simpleDefaultCard.version).toBe('1.1.0');
    expect(leanDefaultCard.version).toBe('1.4.0');
    expect(() => fixture(undefined, ['read'], { toolProfile: 'lean-future' as never })).toThrow('toolProfile must be');
  });
});
