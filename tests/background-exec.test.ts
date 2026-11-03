import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { attachmentKind } from '../src/runtime/attachments.js';
import type { Message, ModelResponse, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, temp } from './helpers.js';

type Step = ModelResponse | ((messages: Message[]) => ModelResponse | Promise<ModelResponse>);

function setup(steps: Step[]): { app: Application; root: string; runId: string; requests: Message[][] } {
  const root = temp();
  const requests: Message[][] = [];
  const provider: Provider = { async complete(request) {
    requests.push(request.messages);
    const step = steps.shift();
    if (!step) throw new Error('unexpected model request');
    return typeof step === 'function' ? await step(request.messages) : step;
  } };
  const app = new Application(path.join(root, '.state'), provider, undefined, { toolProfile: 'full', agentFactors: { B: false, D: false, E: false } });
  const run = app.createRun({ objective: 'Run the program.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
  return { app, root, runId: run.id, requests };
}
const lastTool = (messages: Message[]): Record<string, unknown> => JSON.parse(messages.findLast(message => message.role === 'tool')!.content) as Record<string, unknown>;
const handle = (messages: Message[]): string => (lastTool(messages).background as { id: string }).id;
const notices = (messages: Message[]): string[] => messages.filter(message => attachmentKind(message) === 'task-notification').map(message => message.role === 'user' ? message.content : '');
const node = (source: string): Record<string, unknown> => ({ program: process.execPath, args: ['-e', source], background: true });

describe('background process.exec', () => {
  it('returns a handle at once, reads output incrementally and notifies once on exit', async () => {
    let id = '';
    let root = '';
    const script = "process.stdout.write('first\\n'); const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync('go')) { clearInterval(t); process.stdout.write('second\\n'); } }, 20);";
    const fixture = setup([
      calls(call('process.exec', node(script), 'start')),
      messages => {
        id = handle(messages);
        expect(lastTool(messages).background).toMatchObject({ state: 'running', readWith: 'process.read' });
        return calls(call('process.read', { id, waitMs: 10_000 }, 'read1'));
      },
      messages => {
        const page = lastTool(messages);
        expect(page).toMatchObject({ id, stdout: 'first\n', stdoutOffset: 6 });
        writeFileSync(path.join(root, 'go'), '');
        return calls(call('process.read', { id, stdoutOffset: 6, waitMs: 10_000 }, 'read2'));
      },
      messages => {
        expect(lastTool(messages).stdout).toBe('second\n');
        return answer('started and read');
      },
      answer('done'),
    ]);
    root = fixture.root;
    const { app, runId, requests } = fixture;
    try {
      const final = await app.run(runId);
      expect(final.status, final.error).toBe('completed');
      const all = notices(requests.at(-1)!);
      expect(all).toHaveLength(1);
      expect(all[0]).toContain(id);
      expect(all[0]).toContain('exit code 0');
      const exec = app.store.calls(runId).find(item => item.name === 'process.exec')!;
      expect(exec.status).toBe('succeeded');
      expect(app.store.events(runId).filter(event => event.type === 'process.background.finished')).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('settles a running background task before the run can complete', async () => {
    const { app, root, runId, requests } = setup([
      calls(call('process.exec', node("setTimeout(() => { require('node:fs').writeFileSync('out.txt', 'late'); console.log('late'); }, 500)"), 'start')),
      answer('finished early'),
      messages => {
        expect(notices(messages)).toHaveLength(1);
        return answer('done after the background task exited');
      },
    ]);
    try {
      const final = await app.run(runId);
      expect(final.status, final.error).toBe('completed');
      expect(readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe('late');
      expect(requests).toHaveLength(3);
      expect(app.store.events(runId).some(event => event.type === 'completion.deferred')).toBe(true);
    } finally { await app.shutdown(); }
  });

  it('stops a background task when its run is cancelled and reconciles the stop', async () => {
    const owner: { app?: Application; runId?: string } = {};
    const { app, runId } = setup([
      calls(call('process.exec', node('setInterval(() => {}, 1000)'), 'start')),
      () => { owner.app!.coordinator.cancel(owner.runId!); return answer('cancelled'); },
    ]);
    Object.assign(owner, { app, runId });
    try {
      expect((await app.run(runId)).status).toBe('cancelled');
      await app.coordinator.tools.backgroundSettled();
      expect(app.coordinator.tools.hasPendingEffects()).toBe(false);
      const finished = app.store.events(runId).find(event => event.type === 'process.background.finished');
      expect(finished?.data).toMatchObject({ state: 'stopped' });
      // Without an OS sandbox the stop is settled by a post-stop scan of the write roots; outside effects stay unobserved.
      const operation = app.store.calls(runId).find(item => item.name === 'process.exec')!;
      expect(operation.status).toBe('cancelled');
      expect(app.store.readBlob(operation.resultRef!)).toMatchObject({ cancelled: true, effects: { verified: true, basis: 'workspace-change-time', unobserved: 'outside-roots' } });
    } finally { await app.shutdown(); }
  });

  it('keeps the write lock until the background process exits', async () => {
    const { app, root, runId } = setup([
      calls(call('process.exec', node('setTimeout(() => {}, 400)'), 'start')),
      calls(call('file.apply_patch', { path: 'after.txt', expectedHash: null, content: 'written' }, 'write')),
      answer('done'),
      answer('done'),
    ]);
    try {
      const final = await app.run(runId);
      expect(final.status, final.error).toBe('completed');
      expect(existsSync(path.join(root, 'after.txt'))).toBe(true);
      const events = app.store.events(runId);
      const exited = events.find(event => event.type === 'process.background.finished')!;
      const written = events.find(event => event.type === 'tool.finished' && String(event.data.callId).endsWith(':write'))!;
      expect(exited.seq).toBeLessThan(written.seq);
    } finally { await app.shutdown(); }
  });

  it('enforces a total lifetime after a process has moved to the background', async () => {
    const { app, runId } = setup([]);
    try {
      const result = await app.coordinator.tools.execute(runId, 'process.exec', { ...node('setInterval(() => {}, 1000)'), timeoutMs: 150 }, new AbortController().signal) as { background: { id: string } };
      await app.coordinator.tools.backgroundSettled();
      const output = await app.coordinator.tools.execute(runId, 'process.read', { id: result.background.id }, new AbortController().signal);
      expect(output).toMatchObject({ state: 'stopped', timedOut: true, effects: { verified: true, basis: 'workspace-change-time' } });
      expect(app.coordinator.tools.hasPendingEffects()).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('rejects unknown handles and handles owned by another run', async () => {
    const { app, root, runId } = setup([calls(call('process.exec', node('setTimeout(() => {}, 200)'), 'start')), answer(), answer()]);
    try {
      const other = app.createRun({ objective: 'Other run.', workspace: root, binding, permissions: ['read', 'exec'] });
      await expect(app.coordinator.tools.execute(other.id, 'process.read', { id: 'missing' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PROCESS_HANDLE' });
      expect((await app.run(runId)).status).toBe('completed');
      const id = (app.store.readBlob<{ background: { id: string } }>(app.store.calls(runId).find(item => item.name === 'process.exec')!.resultRef!)).background.id;
      await expect(app.coordinator.tools.execute(other.id, 'process.read', { id }, new AbortController().signal)).rejects.toMatchObject({ code: 'PROCESS_HANDLE' });
    } finally { await app.shutdown(); }
  });
});
