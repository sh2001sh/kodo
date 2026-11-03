import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryManager } from '../src/runtime/recovery.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { resolveToolCall } from '../src/runtime/tool-view.js';
import { KodoError } from '../src/runtime/types.js';
import type { Call, Provider, ToolRequest } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

const signal = () => new AbortController().signal;
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
function setup(provider?: Provider, permissions: ('read' | 'write' | 'exec')[] = ['read', 'write', 'exec']) {
  const f = fixture(provider, permissions, { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
  git(f.root, 'init', '-b', 'main');
  writeFileSync(path.join(f.root, 'value.txt'), 'original\n');
  git(f.root, 'add', 'value.txt');
  git(f.root, 'commit', '-m', 'baseline');
  const head = git(f.root, 'rev-parse', 'HEAD').trim();
  return { ...f, head, tools: f.app.coordinator.tools };
}

/** Isolated synthetic crash record: no real command is interrupted or replayed. */
function uncertain(f: ReturnType<typeof setup>, request: ToolRequest): Call {
  const modelId = `synthetic-model:${f.runId}`;
  f.app.store.putCall({ id: modelId, runId: f.runId, step: 0, kind: 'model', name: 'fixture', status: 'succeeded', effect: 'read', requestRef: f.app.store.blob({}), resultRef: f.app.store.blob(calls(request)), reservedTokens: 0 });
  const effect: Call = { id: `${modelId}:${request.id}`, runId: f.runId, step: 0, kind: 'tool', name: request.name, effect: 'write', status: 'unknown', effectState: 'started', effectOutcome: 'unknown', effectRoots: [f.root], requestRef: f.app.store.blob(request), resultRef: f.app.store.blob({ error: 'synthetic lost outcome' }), reservedTokens: 0 };
  f.app.store.putCall(effect);
  f.app.store.updateRun(f.runId, { status: 'interrupted', stepCallId: modelId });
  return effect;
}

describe('Git delivery through lean view and real Tools', () => {
  it.each([false, true])('classifies a mocked Git execution error with started=%s without assuming delivery succeeded', async started => {
    let head = '';
    const f = setup(scripted(
      async () => calls(call('job', { action: 'git', git: { action: 'branch', name: 'feature/mock-outcome', expectedHead: head } }, 'mock-git')),
      answer('The Git operation reported an error.'),
    ));
    head = f.head;
    const execute = f.tools.execute.bind(f.tools);
    const mock = vi.spyOn(f.tools, 'execute').mockImplementation(async (runId, name, args, abort, onEffectStart, options) => {
      if (name !== 'workspace.git') return execute(runId, name, args, abort, onEffectStart, options);
      if (started) onEffectStart?.();
      throw new KodoError('EXECUTION_GIT', 'synthetic Git operation failure');
    });
    const ended = await f.app.coordinator.wake(f.runId);
    mock.mockRestore();
    const record = f.app.store.calls(f.runId).find(entry => entry.name === 'workspace.git')!;
    expect(record).toMatchObject(started
      ? { status: 'unknown', effectState: 'started', effectOutcome: 'unknown' }
      : { status: 'failed', effectState: 'not_started', effectOutcome: 'not_applied' });
    expect(git(f.root, 'branch', '--show-current').trim()).toBe('main');
    if (started) {
      expect(ended).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/u) });
      await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'branch', name: 'feature/later', expectedHead: head }, signal())).rejects.toMatchObject({ code: 'UNKNOWN_WRITE' });
    } else {
      expect(ended.status).toBe('completed');
      expect(f.app.store.unresolvedWrites(f.root)).toEqual([]);
    }
  });

  it('runs main job Git status, branch and commit and records canonical calls beside model aliases', async () => {
    let head = '';
    const f = setup(scripted(
      async request => {
        expect(request.tools.map(tool => tool.name)).toEqual(['read', 'edit', 'write', 'bash', 'job', 'delegate', 'task', 'find_agents', 'ask_user']);
        const job = request.tools.find(tool => tool.name === 'job')!;
        expect(job.parameters.properties).toHaveProperty('git');
        return calls(call('job', { action: 'git', git: { action: 'status' } }, 'git-status'));
      },
      async () => calls(call('job', { action: 'git', git: { action: 'branch', name: 'feature/real-delivery', expectedHead: head } }, 'git-branch')),
      async () => calls(call('job', { action: 'git', git: { action: 'commit', files: ['value.txt'], message: 'Deliver fixture change', expectedHead: head } }, 'git-commit')),
      answer('Delivered the requested branch and commit.'),
    ));
    head = f.head;
    writeFileSync(path.join(f.root, 'value.txt'), 'delivered\n');
    expect((await f.app.coordinator.wake(f.runId)).status).toBe('completed');
    expect(git(f.root, 'branch', '--show-current').trim()).toBe('feature/real-delivery');
    expect(git(f.root, 'show', 'HEAD:value.txt')).toBe('delivered\n');
    const records = f.app.store.calls(f.runId).filter(record => record.kind === 'tool');
    expect(records).toHaveLength(3);
    expect(records.map(record => [record.name, record.effect, record.status])).toEqual([
      ['workspace.git', 'read', 'succeeded'], ['workspace.git', 'write', 'succeeded'], ['workspace.git', 'write', 'succeeded'],
    ]);
    for (const record of records) {
      expect(f.app.store.readBlob<ToolRequest>(record.requestRef).name).toBe('workspace.git');
      expect(f.app.store.readBlob<ToolRequest>(record.modelRequestRef!).name).toBe('job');
    }
  });

  it('allows status with read/exec but rejects mutations without write permission', async () => {
    const f = setup(undefined, ['read', 'exec']);
    await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'status' }, signal())).resolves.toMatchObject({ head: f.head, branch: 'main' });
    const started = vi.fn();
    await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'branch', name: 'feature/read-only', expectedHead: f.head }, signal(), started)).rejects.toMatchObject({ code: 'EXECUTION_PERMISSION' });
    expect(started).not.toHaveBeenCalled();
    expect(git(f.root, 'branch', '--show-current').trim()).toBe('main');
  });

  it('omits Git from child job views and retains the ordinary process job interface', async () => {
    const f = setup();
    const parent = f.app.store.run(f.runId);
    const child = { ...parent, id: randomUUID(), parentId: parent.id, status: 'completed' as const, taskNode: { ownerId: parent.id, nodeId: 'child', role: 'implementer', generation: 1 } };
    f.app.store.putRun(child);
    const specs = toolSpecs(f.app.coordinator, child, f.app.store.session(parent.sessionId));
    const job = specs.find(spec => spec.name === 'job')!;
    expect(job.parameters.properties).not.toHaveProperty('git');
    expect(job.parameters.required).toEqual(['id']);
    expect(resolveToolCall('lean-team', call('job', { id: 'ordinary-job' }), true, 'implementer').name).toBe('process.read');
    expect(() => resolveToolCall('lean-team', call('job', { action: 'git', git: { action: 'status' } }), true, 'implementer')).toThrow('main job');
    await expect(f.tools.execute(child.id, 'workspace.git', { action: 'status' }, signal())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('requires shell execution authorization for the implicit main Git capability', async () => {
    const f = setup(undefined, ['read', 'write']);
    const run = f.app.store.run(f.runId);
    expect(toolSpecs(f.app.coordinator, run, f.app.store.session(run.sessionId)).map(spec => spec.name)).not.toContain('job');
    await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'status' }, signal())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('keeps an uncertain Git effect blocked while permitting status inspection and never uses ordinary file reconciliation', async () => {
    const f = setup();
    const effect = uncertain(f, call('workspace.git', { action: 'branch', name: 'feature/uncertain', expectedHead: f.head }, 'uncertain-git'));
    const native = vi.spyOn(f.tools, 'probeNativeForRecovery');
    const patch = vi.spyOn(f.tools, 'probePatchForRecovery');
    const plan = await new RecoveryManager(f.app.store, f.tools).inspect(f.runId);
    expect(plan.blocked).toEqual([effect.id]);
    expect(plan.resolutions).toEqual([]);
    expect(plan.observations[0]?.evidence).toContain('No automatic verifier');
    expect(native).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(f.app.store.call(effect.id).status).toBe('unknown');
    const started = vi.fn();
    await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'branch', name: 'feature/next', expectedHead: f.head }, signal(), started)).rejects.toMatchObject({ code: 'UNKNOWN_WRITE' });
    await expect(f.tools.execute(f.runId, 'workspace.git', { action: 'status' }, signal())).resolves.toMatchObject({ head: f.head });
    expect(started).not.toHaveBeenCalled();
  });
});
