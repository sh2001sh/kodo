import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

const signal = (): AbortSignal => new AbortController().signal;
const delegated = ['shell.exec', 'process.exec', 'process.read', 'image.read', 'web.fetch', 'lsp.hover', 'lsp.references', 'lsp.definition', 'lsp.diagnostics', 'lsp.symbols'];

describe('stable role tool view', () => {
  it('limits only the top-level specialized tools and keeps ordinary tools and coordination', async () => {
    const command = { program: process.execPath, args: ['--version'] };
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { agentFactors: { E: true }, readOnlyCommands: [command] });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const tools = app.coordinator.tools;
    const names = toolSpecs(app.coordinator, run, session).map(spec => spec.name);
    for (const name of delegated) {
      expect(names).not.toContain(name);
      expect(() => tools.validate(name, '{}', run.card.tools, session, run)).toThrow('delegated to child agents');
      await expect(tools.execute(runId, name, {}, signal())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
      expect(roleAllows({ parentId: runId }, session, name)).toBe(true);
      expect(roleAllows(run, { agentFactors: { E: false } }, name)).toBe(true);
    }
    for (const name of ['file.read', 'file.apply_patch', 'artifact.write', 'history.read', 'recovery.inspect', 'ask_user', 'spawn_agent', 'wait_for_events', 'inspect_run', 'cancel_agent', 'process.run']) expect(names).toContain(name);
    expect(await tools.execute(runId, 'process.run', command, signal())).toMatchObject({ exitCode: 0 });
    expect(tools.executeAtomic(runId, 'artifact.write', { name: 'role-test', content: 'isolated ordinary artifact' }, signal())).toHaveProperty('id');
    // process.read is implied by shell.exec, but its own role check must still apply.
    expect(() => tools.validate('process.read', '{"id":"ordinary-fixture"}', ['shell.exec'], session, run)).toThrow('delegated to child agents');
  });

  it('retains child execution and reading of its managed process by child identity', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { agentFactors: { E: true } });
    const run = app.store.run(runId);
    const mailbox = app.coordinator.mailbox;
    const args = { objective: 'Run an ordinary local check', scope: { write: ['child.txt'] } };
    const spawned = mailbox.execute(run, 'child-process-fixture', 'spawn_agent', mailbox.validate(run, 'spawn_agent', JSON.stringify(args))) as { id: string };
    const child = app.store.run(spawned.id);
    const tools = app.coordinator.tools;
    const names = toolSpecs(app.coordinator, child, app.store.session(child.sessionId)).map(spec => spec.name);
    expect(names).toContain('shell.exec');
    expect(names).toContain('process.read');
    const result = await tools.execute(child.id, 'process.exec', { program: process.execPath, args: ['-e', "process.stdout.write('child check')"], background: true }, signal()) as { background: { id: string } };
    expect(result.background.id).toBeTruthy();
    await expect(tools.execute(child.id, 'process.read', { id: result.background.id, waitMs: 1000 }, signal())).resolves.toHaveProperty('state');
  });

  it('does not put delegated tools in lazy catalog descriptions or load them through tool.describe', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { agentFactors: { E: true }, lazyTools: true });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const tools = app.coordinator.tools;
    const specs = tools.requestSpecs(run, session, 1);
    const catalog = specs.find(spec => spec.name === 'tool.describe')!.description;
    for (const name of delegated) expect(catalog).not.toContain(`${name}:`);
    await expect(tools.execute(runId, 'tool.describe', { names: ['shell.exec'] }, signal())).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect(await tools.execute(runId, 'tool.describe', { names: ['file.read'] }, signal())).toMatchObject({ tools: [{ name: 'file.read' }] });
  });

  it('leaves disabled-factor tool bytes unchanged and does not vary them with todo ownership', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { agentFactors: { B: true } });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const bytes = () => JSON.stringify(toolSpecs(app.coordinator, app.store.run(runId), app.store.session(run.sessionId)));
    const before = bytes();
    expect(JSON.stringify(toolSpecs(app.coordinator, run, { ...session, agentFactors: { ...session.agentFactors, E: false } }))).toBe(before);
    await app.coordinator.tools.execute(runId, 'todo.write', { expectedRevision: 0, items: [{ id: 'work', content: 'Delegated task', status: 'in_progress' }] }, signal());
    expect(bytes()).toBe(before);
  });

  it('loads directory instructions before writing through an absolute path', async () => {
    let target = '';
    const { app, root, runId } = fixture(scripted(
      async () => calls(call('file.apply_patch', { path: target, expectedHash: null, content: 'first' })),
      async request => {
        expect(request.messages.some(message => message.content?.includes('Use the local report format.'))).toBe(true);
        expect(request.messages.findLast(message => message.role === 'tool')?.content).toContain('INSTRUCTIONS_CHANGED');
        return calls(call('file.apply_patch', { path: target, expectedHash: null, content: 'replanned' }, 'replanned'));
      }, answer(),
    ), undefined, { instructions: { global: false } });
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'AGENTS.md'), 'Use the local report format.');
    target = path.join(root, 'sub', 'report.txt');
    expect((await app.run(runId)).status).toBe('completed');
    expect(readFileSync(target, 'utf8')).toBe('replanned');
    expect(app.store.run(runId).instructions?.loaded).toContain('sub/AGENTS.md');
  });
});
