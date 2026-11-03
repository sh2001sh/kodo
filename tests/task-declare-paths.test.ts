import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { declareTasks } from '../src/runtime/task-declare.js';
import { readTaskGraph } from '../src/runtime/task-graph.js';
import { taskStore } from './task-fixture.js';
import { fixture } from './helpers.js';

describe('task declaration path diagnostics', () => {
  it('rejects through the real tool before freezing workspace mode or creating a child', () => {
    const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3 });
    const main = f.app.store.run(f.runId), mailbox = f.app.coordinator.mailbox;
    const args = mailbox.validate(main, 'delegate', JSON.stringify({ tasks: [{ id: 'edit', goal: 'Create a file', scope: ['src/new.ts (implement here)'] }] }));
    expect(() => mailbox.execute(main, 'invalid-scope', 'delegate', args)).toThrow('scope must contain only literal paths');
    expect(readTaskGraph(f.app.store, main.id).nodes).toEqual([]);
    expect(f.app.store.hasEvent(main.id, { types: ['task.workspace_mode'] })).toBe(false);
    expect(f.app.store.listRuns(main.sessionId)).toHaveLength(1);
  });

  it('rejects annotated paths and missing check targets before recording any task', () => {
    const { store, directory } = taskStore();
    const declare = () => declareTasks(store, 'main', { tasks: [
      { id: 'valid', goal: 'An independent task', scope: ['src'] },
      { id: 'tests', goal: 'Create tests', scope: ['tests/x.py (new file, you own it)'], check: { program: 'pytest', args: ['tests/x.py'] } },
    ] });
    expect(declare).toThrow('scope must contain only literal paths');
    expect(declare).toThrow('missing check path "tests/x.py" is outside scope');
    try { declare(); } catch (error) { expect(error).toMatchObject({ code: 'TASK_GRAPH_INVALID' }); }
    expect(readTaskGraph(store, 'main').nodes).toEqual([]);
    expect(store.countEvents('main', { types: ['task.dispatch.prepared', 'task.node.updated'] })).toBe(0);
    // A corrected literal declaration can create a file that does not exist yet.
    declareTasks(store, 'main', { tasks: [{ id: 'tests', goal: 'Create tests', scope: ['tests/x.py'], check: { program: 'pytest', args: ['tests/x.py::TestNew::test_case'] } }] });
    expect(readTaskGraph(store, 'main').nodes[0]!.scope).toEqual(['tests/x.py']);
    expect(directory).toBe(store.session('session').workspace);
  });

  it('rejects whitespace annotations without requiring an executable check', () => {
    const { store } = taskStore();
    expect(() => declareTasks(store, 'main', { tasks: [{ id: 'edit', goal: 'Edit', scope: ['src/new.ts (implement here)'] }] })).toThrow('put explanations in goal or acceptance');
    expect(readTaskGraph(store, 'main').nodes).toEqual([]);
  });

  it('preserves existing filenames with spaces and parentheses, and new literal parentheses', () => {
    const { store, directory } = taskStore();
    mkdirSync(path.join(directory, 'tests'));
    writeFileSync(path.join(directory, 'tests', 'existing (copy).py'), '');
    declareTasks(store, 'main', { tasks: [{ id: 'edit', goal: 'Edit literal files', scope: ['tests/existing (copy).py', 'tests/new(copy).py'], check: { program: 'pytest', args: ['tests/existing (copy).py', 'tests/new(copy).py'] } }] });
    expect(readTaskGraph(store, 'main').nodes[0]!.scope).toEqual(['tests/existing (copy).py', 'tests/new(copy).py']);
  });

  it('allows existing read-only tests outside write scope and missing tests under a declared directory', () => {
    const { store, directory } = taskStore();
    mkdirSync(path.join(directory, 'tests'));
    writeFileSync(path.join(directory, 'tests', 'regression.py'), '');
    declareTasks(store, 'main', { tasks: [
      { id: 'source', goal: 'Change source', scope: ['src'], check: { program: 'pytest', args: ['tests/regression.py'] } },
      { id: 'test', goal: 'Create tests', scope: ['tests'], check: { program: 'pytest', args: ['tests/new.py'] } },
    ] });
    expect(readTaskGraph(store, 'main').nodes).toHaveLength(2);
  });

  it('checks missing relative targets without treating inline code, selectors or option values as paths', () => {
    const { store } = taskStore();
    expect(() => declareTasks(store, 'main', { tasks: [{ id: 'bad', goal: 'Check', scope: ['src'], check: { program: 'pytest', args: ['missing.py'] } }] })).toThrow('missing check path "missing.py"');
    declareTasks(store, 'main', { tasks: [
      { id: 'node', goal: 'Check source', scope: ['src'], check: { program: 'node', args: ['-e', "require('fs').readFileSync('tests/x.py')"] } },
      { id: 'pytest', goal: 'Check repository', scope: ['src'], check: { program: 'pytest', args: ['--ignore', 'tests/unavailable', '-k', 'a/b', '--junitxml', 'logs/report.xml', '--cov-report=xml:logs/coverage.xml'] } },
    ] });
    expect(readTaskGraph(store, 'main').nodes.map(node => node.id)).toEqual(['node', 'pytest']);
  });
});
