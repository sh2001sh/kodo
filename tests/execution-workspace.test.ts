import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExecutionWorkspace, discardExecutionWorkspace, executionDelivery, runWorkspace } from '../src/runtime/execution-workspace.js';
import type { Provider, Run } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';
import { preparePendingExecution } from '../src/runtime/execution-admission.js';
import { readTodoSnapshot, todoTools } from '../src/tools/todo.js';
import type { TodoItem } from '../src/tools/todo.js';
import { todoRunReady } from '../src/runtime/todo-dependencies.js';

const clones: NonNullable<Run['execution']>[] = [];
afterEach(() => { for (const clone of clones.splice(0)) discardExecutionWorkspace(clone); });
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
const signal = () => new AbortController().signal;

function setup(sandbox = false, provider?: Provider) {
  const f = fixture(provider, ['read', 'write', 'exec'], { taskProtocol: 2, instructions: { global: false }, ...(sandbox ? { sandbox: {} } : {}) });
  git(f.root, 'init');
  writeFileSync(path.join(f.root, 'value.js'), 'module.exports = "base";\n');
  writeFileSync(path.join(f.root, 'other.txt'), 'unchanged\n');
  git(f.root, 'add', 'value.js', 'other.txt'); git(f.root, 'commit', '-m', 'baseline');
  const run = f.app.store.run(f.runId);
  f.app.store.updateRun(run.id, { card: { ...run.card, tools: [...new Set([...run.card.tools, 'workspace.integrate', 'workspace.commit', 'process.exec'])] } });
  const child = () => {
    const parent = f.app.store.run(f.runId);
    const id = randomUUID();
    const execution = createExecutionWorkspace(f.app.store, parent, id);
    clones.push(execution);
    const run: Run = { ...parent, id, parentId: parent.id, execution, status: 'running', scope: { read: ['.'], write: ['.'] } };
    f.app.store.putRun(run);
    return run;
  };
  return { ...f, child, tools: f.app.coordinator.tools };
}

describe('run-owned execution workspaces', () => {
  it('routes file reads, guarded writes and real process imports to the same independent checkout', async () => {
    const { app, root, child, tools } = setup(); const run = child();
    const read = await tools.execute(run.id, 'file.read', { path: 'value.js' }, signal()) as { hash: string };
    await tools.execute(run.id, 'file.patch', { path: 'value.js', expectedHash: read.hash, edits: [{ oldText: 'base', newText: 'child' }] }, signal());
    const output = await tools.execute(run.id, 'process.exec', { program: process.execPath, args: ['-e', 'console.log(process.cwd()); console.log(require("./value.js"))'] }, signal()) as { stdout: string; exitCode: number };
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain(run.execution!.root); expect(output.stdout).toContain('child');
    expect(readFileSync(path.join(root, 'value.js'), 'utf8')).toContain('base');
    expect(runWorkspace(app.store, app.store.run(run.id))).toBe(run.execution!.root);
    expect(git(run.execution!.root, 'rev-parse', '--git-common-dir').trim()).toBe('.git');
    expect(git(run.execution!.root, 'remote').trim()).toBe('');
  });

  it('keeps native writes to two independent roots separate and unsandboxed process locks conservative', async () => {
    const { child, tools, root } = setup(); const a = child(), b = child();
    const reads = await Promise.all([a, b].map(run => tools.execute(run.id, 'file.read', { path: 'value.js' }, signal()) as Promise<{ hash: string }>));
    await Promise.all([a, b].map((run, i) => tools.execute(run.id, 'file.patch', { path: 'value.js', expectedHash: reads[i]!.hash, edits: [{ oldText: 'base', newText: String(i) }] }, signal())));
    expect(readFileSync(path.join(a.execution!.root, 'value.js'), 'utf8')).toContain('"0"');
    expect(readFileSync(path.join(b.execution!.root, 'value.js'), 'utf8')).toContain('"1"');
    expect(tools.effectRoots(a.id, 'process.exec', {})).toEqual(expect.arrayContaining([root, a.execution!.root, b.execution!.root]));
    expect(tools.effectRoots(a.id, 'file.patch', { path: 'value.js' })).toEqual([path.join(a.execution!.root, 'value.js')]);
  });

  it('previews and applies a committed child diff without changing unrelated staged work', async () => {
    const { app, root, runId, child, tools } = setup(); const run = child();
    writeFileSync(path.join(run.execution!.root, 'value.js'), 'module.exports = "delivered";\n');
    git(run.execution!.root, 'add', 'value.js'); git(run.execution!.root, 'commit', '-m', 'child change');
    app.store.updateRun(run.id, { status: 'completed' });
    writeFileSync(path.join(root, 'other.txt'), 'parent change\n'); git(root, 'add', 'other.txt');
    const preview = await tools.execute(runId, 'workspace.integrate', { run_id: run.id }, signal()) as { files: string[]; applied: boolean; diff: string };
    expect(preview.files).toEqual(['value.js']); expect(preview.applied).toBe(false); expect(preview.diff).toContain('delivered');
    expect(readFileSync(path.join(root, 'value.js'), 'utf8')).toContain('base');
    const result = await tools.execute(runId, 'workspace.integrate', { run_id: run.id, apply: true }, signal()) as { staged: boolean };
    expect(result.staged).toBe(true);
    expect(readFileSync(path.join(root, 'value.js'), 'utf8')).toContain('delivered');
    expect(git(root, 'diff', '--cached', '--name-only').trim().split(/\r?\n/u).sort()).toEqual(['other.txt', 'value.js']);
    expect(app.store.events(runId, { types: ['execution.integrated'] })).toHaveLength(1);
  });

  it('reports integration conflicts without overwriting parent edits and retains the child for recovery', async () => {
    const { app, root, runId, child, tools } = setup(); const run = child();
    writeFileSync(path.join(run.execution!.root, 'value.js'), 'module.exports = "child";\n');
    git(run.execution!.root, 'add', 'value.js'); git(run.execution!.root, 'commit', '-m', 'child change');
    app.store.updateRun(run.id, { status: 'completed' });
    writeFileSync(path.join(root, 'value.js'), 'module.exports = "parent";\n');
    await expect(tools.execute(runId, 'workspace.integrate', { run_id: run.id, apply: true }, signal())).rejects.toMatchObject({ code: 'EXECUTION_GIT' });
    expect(readFileSync(path.join(root, 'value.js'), 'utf8')).toContain('parent');
    expect(executionDelivery(app.store, app.store.run(runId), run.id).diff).toContain('child');
    expect(git(root, 'diff', '--cached').trim()).toBe('');
  });

  it('does not silently drop uncommitted tracked source changes when creating an isolated task', () => {
    const { root, child } = setup();
    writeFileSync(path.join(root, 'value.js'), 'module.exports = "pending";\n');
    expect(child).toThrow('commit tracked changes');
  });

  it('allows main native work outside a running shared child claim and keeps overlapping edits blocked', async () => {
    const { app, runId, child, tools } = setup(); const template = child();
    const shared = { ...template, id: randomUUID(), execution: undefined, scope: { read: ['.'], write: ['value.js'] } };
    app.store.putRun(shared);
    const other = await tools.execute(runId, 'file.read', { path: 'other.txt' }, signal()) as { hash: string };
    await tools.execute(runId, 'file.patch', { path: 'other.txt', expectedHash: other.hash, edits: [{ oldText: 'unchanged', newText: 'independent' }] }, signal());
    const value = await tools.execute(runId, 'file.read', { path: 'value.js' }, signal()) as { hash: string };
    await expect(tools.execute(runId, 'file.patch', { path: 'value.js', expectedHash: value.hash, edits: [{ oldText: 'base', newText: 'overlap' }] }, signal())).rejects.toMatchObject({ code: 'WRITE_SCOPE_CONFLICT' });
  });

  it.skipIf(process.platform !== 'win32')('delivers a real OS-sandboxed process change through host Git without exposing .git', async () => {
    const { app, root, runId, child, tools } = setup(true); const run = child();
    const processResult = await tools.execute(run.id, 'process.exec', { program: process.execPath, args: ['-e', 'const fs=require("node:fs"); console.log(require("./value.js")); fs.writeFileSync("created.txt","sandbox delivery\\n")'] }, signal()) as { exitCode: number; stdout: string; stderr: string };
    expect(processResult.exitCode, processResult.stderr).toBe(0);
    expect(processResult.stdout).toContain('base');
    const committed = await tools.execute(run.id, 'workspace.commit', { message: 'Deliver isolated change' }, signal()) as { commit: string; files: string[] };
    expect(committed.files).toEqual(['created.txt']); expect(committed.commit).toMatch(/^[0-9a-f]{40}$/u);
    app.store.updateRun(run.id, { status: 'completed' });
    await tools.execute(runId, 'workspace.integrate', { run_id: run.id, apply: true }, signal());
    expect(readFileSync(path.join(root, 'created.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('sandbox delivery\n');
  }, 60_000);

  it('stops only the selected owned background process and waits for settlement', async () => {
    const { runId, tools } = setup();
    const result = await tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)'], background: true }, signal()) as { background: { id: string } };
    const stopped = await tools.execute(runId, 'process.read', { id: result.background.id, stop: true }, signal()) as { state: string; complete: boolean };
    expect(stopped.state).toBe('stopped'); expect(stopped.complete).toBe(true);
    expect(tools.hasPendingEffects()).toBe(false);
  }, 20_000);

  it('creates an isolated child through the real mailbox and retains its root on follow-up', () => {
    const { app, runId } = setup();
    const parent = app.store.run(runId);
    const session = app.store.session(parent.sessionId);
    app.store.putSession({ ...session, taskProtocol: 2 });
    const mailbox = app.coordinator.mailbox;
    const args = { objective: 'Implement a bounded change in an independent checkout', execution: 'isolated', scope: { read: ['.'], write: ['.'] } };
    const dispatched = mailbox.execute(parent, randomUUID(), 'spawn_agent', mailbox.validate(parent, 'spawn_agent', JSON.stringify(args))) as { id: string };
    expect(app.store.run(dispatched.id).executionPending).toBeDefined();
    const child = preparePendingExecution(app.store, app.store.run(dispatched.id))!;
    expect(child.execution?.baseCommit).toMatch(/^[0-9a-f]{40}$/u); clones.push(child.execution!);
    expect(JSON.stringify(app.store.readBlob(child.contextRef))).toContain(child.execution!.root.replaceAll('\\', '\\\\'));
    app.store.updateRun(child.id, { status: 'completed' });
    const nextArgs = { target: child.id, objective: 'Continue the same committed work' };
    const followup = mailbox.execute(parent, randomUUID(), 'followup_task', mailbox.validate(parent, 'followup_task', JSON.stringify(nextArgs))) as { id: string };
    const next = app.store.run(followup.id);
    expect(next.execution).toEqual(child.execution);
    expect(runWorkspace(app.store, next)).toBe(child.execution!.root);
    expect(() => executionDelivery(app.store, parent, child.id)).toThrow('continuation still owns');
  });

  it('prepares a dependent isolated verifier only after prerequisite commits, then reads and imports that code', async () => {
    const provider = scripted(
      async request => {
        expect(JSON.stringify(request.messages)).toContain('fresh prerequisite instructions');
        return calls(call('file.read', { path: 'value.js' }, 'read-new-source'));
      },
      async request => {
        expect(JSON.stringify(request.messages)).toContain('prerequisite delivered');
        return calls(call('process.exec', { program: process.execPath, args: ['-e', 'console.log(require("./value.js"))'] }, 'import-new-source'));
      },
      async request => {
        const result = request.messages.filter(message => message.role === 'tool').at(-1);
        expect(result?.content).toContain('prerequisite delivered');
        return answer('Verified the committed prerequisite through a file read and a real import.');
      },
    );
    const { app, root, runId } = setup(false, provider);
    const parent = app.store.run(runId), mailbox = app.coordinator.mailbox;
    const update = (items: TodoItem[]) => todoTools(app.store)[1]!.execute({ run: app.store.run(runId), session: app.store.session(parent.sessionId), signal: signal(), markEffectStarted() {} }, { expectedRevision: readTodoSnapshot(app.store, runId).revision, items });
    const items: TodoItem[] = [{ id: 'implementation', content: 'Commit prerequisite implementation', executor: 'main', status: 'in_progress' }, { id: 'verify', content: 'Verify committed implementation', executor: 'agent', status: 'in_progress', dependsOn: ['implementation'] }];
    update(items);
    const args = { objective: 'Verify the completed prerequisite', todoId: 'verify', execution: 'isolated', scope: { read: ['.'], write: ['.'] } };
    const spawned = mailbox.execute(parent, randomUUID(), 'spawn_agent', mailbox.validate(parent, 'spawn_agent', JSON.stringify(args))) as { id: string };
    const pending = app.store.run(spawned.id);
    expect(pending.execution).toBeUndefined();
    expect(existsSync(path.join(path.dirname(root), '.kodo-executions', parent.sessionId, pending.id))).toBe(false);
    expect(todoRunReady(app.store, pending)).toBe(false);
    await expect(app.coordinator.tools.execute(pending.id, 'file.read', { path: 'value.js' }, signal())).rejects.toMatchObject({ code: 'EXECUTION_PENDING' });
    writeFileSync(path.join(root, 'value.js'), 'module.exports = "prerequisite delivered";\n');
    writeFileSync(path.join(root, 'AGENTS.md'), 'Use fresh prerequisite instructions.\n');
    git(root, 'add', 'value.js', 'AGENTS.md'); git(root, 'commit', '-m', 'Prerequisite delivery');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    update(items.map(item => item.id === 'implementation' ? { ...item, status: 'completed' } : item));
    const completed = await app.coordinator.wake(pending.id);
    if (completed.execution) clones.push(completed.execution);
    expect(completed.status, completed.error).toBe('completed');
    expect(completed.execution?.baseCommit).toBe(head);
    expect(app.store.calls(completed.id).filter(call => call.kind === 'tool' && call.status === 'succeeded').map(call => call.name)).toEqual(['file.read', 'process.exec']);
    expect(readFileSync(path.join(completed.execution!.root, 'value.js'), 'utf8')).toContain('prerequisite delivered');
  }, 30_000);

  it('keeps a dirty prerequisite queued with one actionable notice, then prepares after commit', () => {
    const { app, root, runId } = setup();
    const parent = app.store.run(runId), mailbox = app.coordinator.mailbox;
    const args = { objective: 'Check the next committed baseline', execution: 'isolated', scope: { read: ['.'], write: ['.'] } };
    const spawned = mailbox.execute(parent, randomUUID(), 'spawn_agent', mailbox.validate(parent, 'spawn_agent', JSON.stringify(args))) as { id: string };
    writeFileSync(path.join(root, 'value.js'), 'module.exports = "awaiting commit";\n'); git(root, 'add', 'value.js');
    for (let index = 0; index < 2; index++) expect(preparePendingExecution(app.store, app.store.run(spawned.id))).toBeUndefined();
    expect(app.store.run(spawned.id).status).toBe('queued');
    expect(app.store.calls(spawned.id)).toHaveLength(0);
    expect(app.store.events(spawned.id, { types: ['execution.blocked'] })).toHaveLength(1);
    expect(app.store.inbox(runId).filter(message => message.id === `execution-blocked:${spawned.id}`)).toHaveLength(1);
    git(root, 'commit', '-m', 'Ready baseline');
    const prepared = preparePendingExecution(app.store, app.store.run(spawned.id))!;
    clones.push(prepared.execution!);
    expect(prepared.executionPending).toBeUndefined();
    expect(readFileSync(path.join(prepared.execution!.root, 'value.js'), 'utf8')).toContain('awaiting commit');
  });
});
