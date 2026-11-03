import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { compactDefaultCard, defaultCard, simpleDefaultCard } from '../src/agents/card.js';
import { parallelMainGuidance } from '../src/runtime/agent-factors.js';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';

const factors = { A: true, B: true, C: true, D: true, E: true };
const signal = () => new AbortController().signal;
const simple = { taskProtocol: 3 as const, toolProfile: 'compact-v2' as const, agentFactors: factors, instructions: { global: false as const } };

describe('complete coding loop with a simple tool profile', () => {
  it('runs a command and collects its managed result on the main agent without delegation', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], simple);
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const tools = app.coordinator.tools;
    const specs = () => toolSpecs(app.coordinator, app.store.run(runId), session);
    const before = specs();
    expect(before).toHaveLength(19);
    expect(before.map(spec => spec.name)).toEqual(expect.arrayContaining([
      'shell.exec', 'process.read', 'file.read', 'file.search', 'file.patch', 'file.apply_patch',
      'artifact.read', 'history.read', 'recovery.inspect', 'todo.read', 'todo.write',
      'spawn_agent', 'followup_task', 'send_message', 'wait_for_events', 'inspect_run', 'ask_user', 'interrupt_agent', 'cancel_agent',
    ]));
    for (const name of ['process.exec', 'file.list', 'file.mkdir', 'file.rename', 'file.delete', 'artifact.write', 'history.search', 'list_agents', 'update_progress', 'agent.derive']) {
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
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec'], simple);
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
    const { app, root, runId } = fixture(undefined, ['read', 'write'], simple);
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
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], simple);
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
    const custom = { card: { ...defaultCard, id: 'custom/member' }, permissions: ['read', 'write', 'exec'] as const };
    const session = { toolProfile: 'compact-v2' as const, agentFactors: factors, permissions: ['read', 'write', 'exec'] as const };
    for (const name of ['shell.exec', 'file.list', 'artifact.write', 'history.search', 'web.fetch', 'lsp.references', 'agent.route']) {
      expect(roleAllows({ ...custom, permissions: [...custom.permissions] }, { ...session, permissions: [...session.permissions] }, name)).toBe(true);
    }
    const configured = { card: { ...simpleDefaultCard, id: 'builtin/general-simple-web-lsp' } };
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'web.fetch')).toBe(true);
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'lsp.hover')).toBe(true);
    expect(roleAllows(configured, { ...session, permissions: [...session.permissions] }, 'update_progress')).toBe(false);
  });

  it('keeps the compact and simple identities distinct', () => {
    expect(simpleDefaultCard.id).not.toBe(compactDefaultCard.id);
    expect(compactDefaultCard.version).toBe('1.2.0');
    expect(simpleDefaultCard.version).toBe('1.3.0');
    expect(roleAllows({ card: compactDefaultCard }, { toolProfile: 'compact-v1', agentFactors: factors }, 'shell.exec')).toBe(false);
    for (const taskProtocol of [1, 2, 3] as const) {
      const guidance = parallelMainGuidance(factors, taskProtocol, 'compact-v2');
      expect(guidance).toContain('Do not create a child solely to run a command');
      expect(guidance).not.toContain('Command and specialist tools are assigned');
    }
    expect(parallelMainGuidance(factors, 1, 'compact-v2')).toContain('keep only one item in_progress');
    expect(parallelMainGuidance(factors, 3, 'compact-v2')).toContain('dependsOn only for actual prerequisite outputs');
  });

  it('persists the new default tool view across reopening with legacy host defaults', async () => {
    const root = temp(), directory = path.join(root, '.state');
    const app = new Application(directory, scripted(answer()), undefined, { instructions: { global: false } });
    const run = app.createRun({ objective: 'Preserve a complete coding loop.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
    const session = app.store.session(run.sessionId);
    const before = toolSpecs(app.coordinator, run, session);
    expect(session).toMatchObject({ taskProtocol: 3, toolProfile: 'compact-v2' });
    await app.shutdown();
    const reopened = new Application(directory, scripted(answer()), undefined, { taskProtocol: 1, toolProfile: 'full', instructions: { global: false } });
    try {
      const restored = reopened.store.run(run.id);
      expect(toolSpecs(reopened.coordinator, restored, reopened.store.session(session.id))).toEqual(before);
    } finally { await reopened.shutdown(); }
  });
});
