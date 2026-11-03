import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { leanBuiltinAgentCards } from '../src/agents/card.js';
import { initialContext } from '../src/runtime/context.js';
import { roleAllows } from '../src/runtime/role-view.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { canonicalRequest } from '../src/runtime/tool-view.js';
import { workspaceGitParameters } from '../src/runtime/workspace-git.js';
import type { Run } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

function team() {
  const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
  return { ...f, store: f.app.store, host: f.app.coordinator, main: f.app.store.run(f.runId) };
}

function child(f: ReturnType<typeof team>, role: string): Run {
  const card = leanBuiltinAgentCards.find(item => item.id === `kodo/${role}`)!;
  const run: Run = { ...f.main, id: `child-${role}`, parentId: f.runId, card, permissions: role === 'explorer' ? ['read'] : ['read', 'write', 'exec'],
    taskNode: { ownerId: f.runId, nodeId: role, role, generation: 1 }, toolBindings: f.host.tools.bindingSnapshot(card.tools), contextRef: f.store.blob([]) };
  f.store.putRun(run);
  return run;
}

describe('lean-team frozen role views', () => {
  it('advertises the same conditional Git arguments that execution validates', () => {
    const f = team(), session = f.store.session(f.main.sessionId);
    const job = toolSpecs(f.host, f.main, session).find(spec => spec.name === 'job')!;
    const ajv = new Ajv({ strict: false });
    const model = ajv.compile(job.parameters), kernel = ajv.compile(workspaceGitParameters);
    const head = 'a'.repeat(40);
    for (const git of [
      { action: 'status' }, { action: 'diff', files: ['src.ts'] },
      { action: 'branch', name: 'feature/work', expectedHead: head },
      { action: 'commit', files: ['src.ts'], message: 'Change', expectedHead: head },
    ]) {
      expect(model({ action: 'git', git })).toBe(true);
      expect(kernel(git)).toBe(true);
      for (const key of Object.keys(git).filter(key => key !== 'action')) {
        const incomplete = Object.fromEntries(Object.entries(git).filter(([name]) => name !== key));
        expect(kernel(incomplete)).toBe(false);
        expect(model({ action: 'git', git: incomplete })).toBe(false);
      }
    }
  });

  it('offers nine main tools, freezes the lean roster, and keeps the default profile unchanged', () => {
    const f = team(), session = f.store.session(f.main.sessionId);
    const specs = toolSpecs(f.host, f.main, session);
    expect(specs.map(spec => spec.name)).toEqual(['read', 'edit', 'write', 'bash', 'job', 'delegate', 'task', 'find_agents', 'ask_user']);
    expect(JSON.stringify(specs).length).toBeLessThanOrEqual(9000);
    expect(session).toMatchObject({ toolProfile: 'lean-team', taskProtocol: 3, maxTaskNodes: 32 });
    const members = f.store.cards.rosterSnapshot(session.id)!.members.filter(member => member.fixedOrder !== undefined);
    expect(members).toHaveLength(4);
    expect(members.every(member => member.card.version === '1.4.0')).toBe(true);
    const context = f.store.readBlob<{ role: string; content: string }[]>(f.main.contextRef);
    expect(context.filter(message => message.role === 'system').map(message => message.content).join('\n').length).toBeLessThanOrEqual(2000);
    expect(context.some(message => message.content.includes('kind="agents"'))).toBe(false);
    child(f, 'implementer');
    expect(toolSpecs(f.host, f.main, session)).toEqual(specs);
    const defaults = fixture(undefined, ['read'], { toolProfile: undefined });
    expect(defaults.app.store.session(defaults.app.store.run(defaults.runId).sessionId).toolProfile).toBe('compact-v2');
  });

  it.each([
    ['explorer', ['read', 'search', 'list']],
    ['implementer', ['read', 'edit', 'write', 'bash', 'job']],
    ['tester', ['read', 'edit', 'write', 'bash', 'job']],
    ['reviewer', ['read', 'bash', 'job', 'search']],
  ])('uses the %s role view and short child prompt', (role, expected) => {
    const f = team(), run = child(f, role as string), session = f.store.session(run.sessionId);
    const tools = toolSpecs(f.host, run, session);
    expect(tools.map(tool => tool.name)).toEqual(expected);
    const context = initialContext(f.root, run.permissions!, run.card, 'Inspect the assigned module.', run, undefined, { toolProfile: 'lean-team', taskProtocol: 3 });
    const system = context.filter(message => message.role === 'system').map(message => message.content).join('\n');
    expect(system.length).toBeLessThanOrEqual(2000);
    expect(system).toContain('NEEDS_INPUT:');
    expect(system).not.toContain('spawn_agent');
    expect(run.card.report).toBeUndefined();
    expect(run.card.inputs).toBeUndefined();
    expect(roleAllows(run, session, 'workspace.commit')).toBe(false);
    expect(roleAllows(run, session, 'task')).toBe(false);
    expect(canonicalRequest(run, session, { id: 'bad', name: 'delegate', arguments: '{}' }).error?.code).toBe('TOOL_DENIED');
  });

  it('lets every child resolve history and artifact reads and lets reviewers search with exec', () => {
    const f = team();
    for (const role of ['explorer', 'implementer', 'tester', 'reviewer']) {
      const run = child(f, role), session = f.store.session(run.sessionId);
      for (const [args, name] of [[{ history: 'a'.repeat(64) }, 'history.read'], [{ history_query: 'contract' }, 'history.search'], [{ artifact: 'artifact-id' }, 'artifact.read']] as const) {
        expect(canonicalRequest(run, session, { id: 'read', name: 'read', arguments: JSON.stringify(args) })).toMatchObject({ request: { name } });
        expect(roleAllows(run, session, name)).toBe(true);
      }
    }
    const reviewer = child(f, 'reviewer');
    expect(canonicalRequest(reviewer, f.store.session(reviewer.sessionId), { id: 'search', name: 'search', arguments: JSON.stringify({ path: '.', query: 'value' }) }).request.name).toBe('file.search');
  });

  it('applies observed-version editing to team children without a model-supplied hash', async () => {
    const f = team(), run = child(f, 'implementer');
    writeFileSync(path.join(f.root, 'a.txt'), 'original\n');
    const signal = new AbortController().signal;
    await f.host.tools.execute(run.id, 'file.read', { path: 'a.txt' }, signal);
    const args = f.host.tools.validate('file.patch', JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'original', newText: 'edited' }] }), run.card.tools, f.store.session(run.sessionId), run);
    await f.host.tools.execute(run.id, 'file.patch', args, signal);
    writeFileSync(path.join(f.root, 'a.txt'), 'changed outside\n');
    await expect(f.host.tools.execute(run.id, 'file.patch', args, signal)).rejects.toMatchObject({ code: 'FILE_STALE' });
  });

  it('rejects non-v3 lean sessions and invalid node limits, and persists an explicit limit', () => {
    expect(() => fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 2 })).toThrow('lean profiles require taskProtocol 3');
    expect(() => fixture(undefined, ['read'], { toolProfile: 'lean-solo', taskProtocol: 1 })).toThrow('lean profiles require taskProtocol 3');
    for (const maxTaskNodes of [0, -1, 1.5, Infinity]) expect(() => fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3, maxTaskNodes })).toThrow('maxTaskNodes');
    const f = fixture(undefined, ['read'], { toolProfile: 'lean-team', taskProtocol: 3, maxTaskNodes: 5 });
    expect(f.app.store.session(f.app.store.run(f.runId).sessionId).maxTaskNodes).toBe(5);
  });
});
