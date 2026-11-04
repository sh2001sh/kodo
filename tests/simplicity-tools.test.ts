import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { simpleDefaultCard } from '../src/agents/card.js';
import { mainGuidance } from '../src/runtime/main-guidance.js';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import type { Permission } from '../src/runtime/types.js';
import { answer, binding, fixture, fullToolCard, scripted, temp } from './helpers.js';

const signal = () => new AbortController().signal;
/** A run on the application's single default card (the shared fixture run uses the full test card). */
function defaultRun(permissions: Permission[]): { app: Application; root: string; runId: string } {
  const { app, root } = fixture(undefined, permissions, { instructions: { global: false } });
  const run = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions });
  return { app, root, runId: run.id };
}

describe('complete coding loop with the default card', () => {
  it('runs a command and collects its managed result on the main agent without delegation', async () => {
    const { app, runId } = defaultRun(['read', 'write', 'exec']);
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const tools = app.coordinator.tools;
    const specs = () => toolSpecs(app.coordinator, app.store.run(runId), session);
    const before = specs();
    expect(before).toHaveLength(16);
    expect(before.map(spec => spec.name)).toEqual(expect.arrayContaining([
      'shell.exec', 'process.read', 'file.read', 'file.search', 'file.patch', 'file.apply_patch',
      'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
      'spawn_agent', 'wait_for_events', 'inspect_run', 'ask_user', 'cancel_agent',
    ]));
    for (const name of ['process.exec', 'file.list', 'file.mkdir', 'file.rename', 'file.delete', 'artifact.write', 'history.search', 'list_agents', 'update_progress', 'agent.derive', 'followup_task', 'send_message', 'interrupt_agent', 'explore']) {
      expect(before.map(spec => spec.name)).not.toContain(name);
    }
    const result = await tools.execute(runId, 'shell.exec', { command: 'printf simple-main', background: true }, signal()) as { background: { id: string } };
    let observed: { state: string; stdout: string; stdoutOffset: number; stderrOffset: number; exitCode?: number } | undefined;
    let stdoutOffset = 0, stderrOffset = 0, output = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      observed = await tools.execute(runId, 'process.read', { id: result.background.id, stdoutOffset, stderrOffset, waitMs: 1000 }, signal()) as typeof observed;
      output += observed!.stdout;
      if (observed!.state !== 'running') break;
      ({ stdoutOffset, stderrOffset } = observed!);
    }
    expect(observed).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(output).toContain('simple-main');
    expect(app.store.listRuns(session.id)).toHaveLength(1);
    expect(specs()).toEqual(before);
  });

  it('keeps localized edits usable beyond the whole-file replacement limit', async () => {
    const { app, root, runId } = defaultRun(['read', 'write', 'exec']);
    const original = `replace-this\n${'ordinary fixture\n'.repeat(5000)}`;
    writeFileSync(path.join(root, 'large.txt'), original);
    const execute = (name: string, args: Record<string, unknown>) => app.coordinator.tools.execute(runId, name, args, signal());
    const read = await execute('file.read', { path: 'large.txt', limit: 1 }) as { hash: string };
    await execute('file.patch', { path: 'large.txt', expectedHash: read.hash, edits: [{ oldText: 'replace-this', newText: 'changed' }] });
    expect(readFileSync(path.join(root, 'large.txt'), 'utf8')).toBe(original.replace('replace-this', 'changed'));
    await execute('file.apply_patch', { path: 'created.txt', expectedHash: null, content: 'created' });
    expect(readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('created');
  });

  it('retains native directory, rename and deletion operations when execution is unavailable', async () => {
    const { app, root, runId } = defaultRun(['read', 'write']);
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['file.list', 'file.mkdir', 'file.rename', 'file.delete']));
    expect(names).not.toContain('shell.exec');
    const execute = (name: string, args: Record<string, unknown>) => app.coordinator.tools.execute(runId, name, args, signal());
    await execute('file.mkdir', { path: 'output' });
    await execute('file.apply_patch', { path: 'output/original.txt', expectedHash: null, content: 'ordinary fixture' });
    const read = await execute('file.read', { path: 'output/original.txt' }) as { hash: string };
    await execute('file.rename', { path: 'output/original.txt', destination: 'output/renamed.txt', expectedHash: read.hash });
    const moved = await execute('file.read', { path: 'output/renamed.txt' }) as { hash: string };
    await execute('file.delete', { path: 'output/renamed.txt', expectedHash: moved.hash });
    expect(existsSync(path.join(root, 'output/renamed.txt'))).toBe(false);
    expect(names).toEqual(toolSpecs(app.coordinator, run, session).map(tool => tool.name));
  });

  it('narrows a child with no exec without losing its inherited native file operations', () => {
    const { app, runId } = defaultRun(['read', 'write', 'exec']);
    const parent = app.store.run(runId);
    const child = app.spawnAgent(parent.sessionId, { objective: 'Update the assigned file.', permissions: ['read', 'write'], scope: { read: ['.'], write: ['result.txt'] } });
    expect(child.card.digest).toBe(parent.card.digest);
    expect(child.card.report).toBeUndefined();
    expect(child.permissions).toEqual(['read', 'write']);
    const names = toolSpecs(app.coordinator, child, app.store.session(child.sessionId)).map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['file.mkdir', 'file.rename', 'file.delete']));
    expect(names).not.toContain('shell.exec');
    expect(names).not.toContain('report.submit');
  });

  it('keeps explicitly configured specialist and custom-card capabilities', () => {
    const custom = { card: { ...fullToolCard, id: 'custom/member' }, permissions: ['read', 'write', 'exec'] as const };
    const session = { permissions: ['read', 'write', 'exec'] as const };
    for (const name of ['shell.exec', 'file.list', 'artifact.write', 'history.search', 'web.fetch', 'lsp.references', 'agent.route']) {
      expect(roleAllows({ ...custom, permissions: [...custom.permissions] }, { ...session, permissions: [...session.permissions] }, name)).toBe(true);
    }
    const configured = { card: { ...simpleDefaultCard, id: 'builtin/general-simple-web-lsp' } };
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'web.fetch')).toBe(true);
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'lsp.hover')).toBe(true);
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'update_progress')).toBe(false);
  });

  it('keeps the single default identity and complete-loop main guidance', () => {
    expect(simpleDefaultCard.id).toBe('builtin/general-simple');
    expect(simpleDefaultCard.version).toBe('1.4.0');
    expect(roleAllows({ card: simpleDefaultCard }, { permissions: ['read', 'write', 'exec'] }, 'shell.exec')).toBe(true);
    expect(mainGuidance).toContain('Do not create a child solely to run a command');
    expect(mainGuidance).not.toContain('Command and specialist tools are assigned');
    // 1d: the todo paragraph is a plain checklist.
    expect(mainGuidance).toContain('Independent items may be in_progress together.');
    for (const removed of ['keep only one item in_progress', 'dependsOn', 'todoId']) expect(mainGuidance).not.toContain(removed);
  });

  it('persists the default tool view across reopening', async () => {
    const root = temp(), directory = path.join(root, '.state');
    const app = new Application(directory, scripted(answer()), undefined, { instructions: { global: false } });
    const run = app.createRun({ objective: 'Preserve a complete coding loop.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
    const session = app.store.session(run.sessionId);
    const before = toolSpecs(app.coordinator, run, session);
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const restored = reopened.store.run(run.id);
      expect(toolSpecs(reopened.coordinator, restored, reopened.store.session(session.id))).toEqual(before);
    } finally { await reopened.shutdown(); }
  });
});
