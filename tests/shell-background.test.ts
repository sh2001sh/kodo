import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, call, calls, fixture } from './helpers.js';

interface Page { background?: { id: string; reason: string }; id: string; state: string; stdout: string; stdoutOffset: number; stderrOffset: number; exitCode?: number; timedOut?: boolean }
const lastTool = (messages: Message[]): Page => JSON.parse(messages.findLast(message => message.role === 'tool')!.content);

describe('managed Bash lifecycle', () => {
  it.each([true, false])('collects shell output and saves subsequent work (explicit background: %s)', async background => {
    let step = 0;
    let id = '';
    let output = '';
    const provider: Provider = { async complete(request) {
      if (step++ === 0) {
        expect(request.tools?.some(tool => tool.name === 'process.read')).toBe(true);
        return calls(call('shell.exec', { command: "sleep 2; printf result > suite.txt; printf finished", background }, 'start'));
      }
      const page = lastTool(request.messages);
      if (page.background) {
        id = page.background.id;
        expect(page.background.reason).toBe(background ? 'requested' : 'foreground time limit reached');
        return calls(call('process.read', { id, waitMs: 5000 }));
      }
      if (page.id) {
        output += page.stdout;
        if (page.state === 'running') return calls(call('process.read', { id, stdoutOffset: page.stdoutOffset, stderrOffset: page.stderrOffset, waitMs: 5000 }));
        expect(page).toMatchObject({ state: 'exited', exitCode: 0 });
        expect(output).toBe('finished');
        return calls(call('file.apply_patch', { path: 'saved.txt', expectedHash: null, content: 'saved after tests' }));
      }
      return answer('Tests finished and result saved.');
    } };
    const { app, root, runId } = fixture(provider, ['read', 'write', 'exec']);
    const run = app.store.run(runId);
    // A shell-only execution card must still expose process.read.
    const card = { ...run.card, tools: ['shell.exec', 'file.apply_patch'] };
    app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, toolTimeoutMs: 1000 } });
    const final = await app.run(runId);
    expect(final.status, final.error).toBe('completed');
    expect(readFileSync(path.join(root, 'suite.txt'), 'utf8')).toBe('result');
    expect(readFileSync(path.join(root, 'saved.txt'), 'utf8')).toBe('saved after tests');
    expect(app.store.calls(runId).find(item => item.id.endsWith(':start'))?.status).toBe('succeeded');
    expect(app.store.events(runId, { types: ['process.background.finished'] })).toHaveLength(1);
    expect(app.store.unresolvedWrites(root)).toEqual([]);
  });

  it('rejects an explicit shell job before execution and accepts a managed retry', async () => {
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const execute = (args: Record<string, unknown>) => app.coordinator.tools.execute(runId, 'shell.exec', args, new AbortController().signal);
    await expect(execute({ command: 'nohup sh -c "printf untracked > marker.txt" > suite.log 2>&1 &' })).rejects.toMatchObject({ code: 'SHELL_BACKGROUND' });
    expect(existsSync(path.join(root, 'marker.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'suite.log'))).toBe(false);
    expect(app.coordinator.tools.backgroundRunning(runId)).toBe(false);
    const result = await execute({ command: 'sleep 0.2; printf managed > marker.txt', background: true }) as Page;
    expect(result.background?.id).toBeTruthy();
    await app.coordinator.tools.backgroundSettled();
    const page = await app.coordinator.tools.execute(runId, 'process.read', { id: result.background!.id }, new AbortController().signal);
    expect(page).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(readFileSync(path.join(root, 'marker.txt'), 'utf8')).toBe('managed');
  });

  it.each([false, true])('retains the total lifetime after returning a handle (write: %s)', async write => {
    let step = 0;
    let id = '';
    const provider: Provider = { async complete(request) {
      if (step++ === 0) return calls(call('shell.exec', { command: write ? 'printf partial > partial.txt; sleep 30' : 'sleep 30', background: true, timeoutMs: 1500 }, 'start'));
      const page = lastTool(request.messages);
      if (page.background) {
        id = page.background.id;
        return calls(call('process.read', { id, waitMs: 10_000 }));
      }
      if (page.id) {
        if (page.state === 'running') return calls(call('process.read', { id, stdoutOffset: page.stdoutOffset, stderrOffset: page.stderrOffset, waitMs: 10_000 }));
        expect(page).toMatchObject({ state: 'stopped', timedOut: true });
        if (!write) return calls(call('file.apply_patch', { path: 'saved.txt', expectedHash: null, content: 'saved' }));
      }
      return answer('The command timed out.');
    } };
    const { app, root, runId } = fixture(provider, ['read', 'write', 'exec']);
    const final = await app.run(runId);
    // Without a sandbox, a stopped write is settled from a post-stop scan of its write roots.
    expect(final.status, final.error).toBe('completed');
    const started = app.store.calls(runId).find(item => item.id.endsWith(':start'))!;
    expect(started).toMatchObject({ status: 'failed', ...(write ? { effectOutcome: 'applied' } : {}) });
    expect(app.store.unresolvedWrites(root)).toHaveLength(0);
    if (write) expect(readFileSync(path.join(root, 'partial.txt'), 'utf8')).toBe('partial');
    else expect(readFileSync(path.join(root, 'saved.txt'), 'utf8')).toBe('saved');
  });
});
