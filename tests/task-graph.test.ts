import { describe, expect, it } from 'vitest';
import type { Store } from '../src/storage/index.js';
import { assertTaskTransition, dependenciesCurrent, readTaskGraph, requireTaskNode, taskNodeEvent, writeTaskNode } from '../src/runtime/task-graph.js';
import { declareTasks, findTaskCycle } from '../src/runtime/task-declare.js';
import { acceptStaleTask, acknowledgeTaskFailure, completeSelfTask, dropTask, finishTaskIntegration, needsInputAnswer, recordTaskRunOutcome, redoTask, resumeTask, taskIntegrationCurrent } from '../src/runtime/task-lifecycle.js';
import { taskGraphCompletionState, taskGraphTerminalCheck } from '../src/runtime/task-completion.js';
import { scheduleTasks } from '../src/runtime/task-dispatch.js';
import { fakeHost, reopen, taskStore } from './task-fixture.js';

const node = (store: Store, id: string) => requireTaskNode(readTaskGraph(store, 'main'), id);
/** Drives a running node through a completed run and successful integration. */
function finish(store: Store, id: string, finalText = 'implemented') {
  const current = node(store, id);
  recordTaskRunOutcome(store, 'main', id, current.runId!, { status: 'completed', finalText, integrate: true });
  return finishTaskIntegration(store, 'main', id, current.generation, { status: 'integrated' });
}

describe('task graph declaration', () => {
  it('rejects cycles, unknown references, duplicates and invalid roles atomically', () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'base', goal: 'keep me' }] });
    const reject = (tasks: Parameters<typeof declareTasks>[2]['tasks']) => expect(() => declareTasks(store, 'main', { tasks })).toThrow(/TASK_GRAPH_INVALID|delegate rejected/);
    reject([{ id: 'a', goal: 'x', after: ['b'] }, { id: 'b', goal: 'y', after: ['a'] }]);
    reject([{ id: 'a', goal: 'x', after: ['missing'] }]);
    reject([{ id: 'a', goal: 'x' }, { id: 'a', goal: 'y' }]);
    reject([{ id: 'a', goal: 'x', role: 'wizard' }]);
    reject([{ id: 'a', goal: 'x', after: ['a'] }]);
    reject([{ id: 'a', goal: 'x', owner: 'self', role: 'implementer' }]);
    expect(() => declareTasks(store, 'main', { tasks: [{ id: 'a', goal: 'x' }, { id: 'b', goal: 'y' }] }, { maxTaskNodes: 2 })).toThrow(/session limit is 2/);
    expect(readTaskGraph(store, 'main').nodes.map(item => item.id)).toEqual(['base']);
    expect(findTaskCycle([{ id: 'a', after: ['c'] }, { id: 'b', after: ['a'] }, { id: 'c', after: ['b'] }])).toEqual(['a', 'c', 'b', 'a']);
    expect(findTaskCycle([{ id: 'a', after: [] }, { id: 'b', after: ['a'] }])).toBeUndefined();
  });

  it('modifies or removes only unstarted nodes and rebuilds the graph after restart', async () => {
    const { store, directory } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', owner: 'self', goal: 'core' }, { id: 'mw', role: 'implementer', goal: 'middleware', scope: ['mw.py'] }, { id: 'tests', role: 'tester', goal: 'tests', after: ['core'] }] });
    declareTasks(store, 'main', { tasks: [{ id: 'tests', role: 'tester', goal: 'regression tests', after: ['core', 'mw'] }] });
    await scheduleTasks(store, 'main', fakeHost(store));
    expect(() => declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'changed' }] })).toThrow(/already started/);
    expect(() => declareTasks(store, 'main', { tasks: [], remove: ['mw'] })).toThrow(/only unstarted/);
    expect(() => declareTasks(store, 'main', { tasks: [], remove: ['core'] })).toThrow(/after references unknown task "core"/);
    const reopened = reopen(store, directory);
    const graph = readTaskGraph(reopened, 'main');
    expect(graph.nodes.map(item => [item.id, item.state, item.owner])).toEqual([['core', 'pending', 'self'], ['mw', 'running', 'agent'], ['tests', 'pending', 'agent']]);
    expect(requireTaskNode(graph, 'tests')).toMatchObject({ goal: 'regression tests', after: ['core', 'mw'] });
    expect(reopened.countEvents('main', { types: [taskNodeEvent] })).toBeGreaterThan(3);
  });

  it('enforces the node state machine', () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'self-task', owner: 'self', goal: 'g' }, { id: 'child', goal: 'g' }] });
    expect(() => assertTaskTransition(node(store, 'self-task'), 'running')).toThrow(/owned by self/);
    expect(() => assertTaskTransition(node(store, 'child'), 'integrating')).toThrow(/cannot move from pending to integrating/);
    dropTask(store, 'main', 'child', 'not needed');
    expect(() => assertTaskTransition(node(store, 'child'), 'queued')).toThrow(/cannot move from dropped/);
    expect(() => dropTask(store, 'main', 'self-task', ' ')).toThrow(/written reason/);
    expect(needsInputAnswer('  NEEDS_INPUT: which port?')).toBe(true);
    expect(needsInputAnswer('Done. NEEDS_INPUT: no')).toBe(false);
  });
});

describe('generations and redo', () => {
  it('invalidates completed and running transitive successors before the new generation starts', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [
      { id: 'a', goal: 'a' }, { id: 'b', goal: 'b', after: ['a'] },
      { id: 'c', goal: 'c', after: ['b'] }, { id: 'd', goal: 'd', after: ['c'] },
    ] });
    const host = fakeHost(store);
    for (const id of ['a', 'b', 'c']) { await scheduleTasks(store, 'main', host); finish(store, id); }
    await scheduleTasks(store, 'main', host);
    const graphBefore = readTaskGraph(store, 'main');
    expect(dependenciesCurrent(graphBefore, node(store, 'c'))).toBe(true);
    expect(() => resumeTask(store, 'main', 'a')).toThrow(/already feeds started successors/);
    const { notices } = redoTask(store, 'main', 'a');
    expect(notices.map(notice => [notice.nodeId, notice.reason])).toEqual([['b', 'became_stale'], ['c', 'became_stale'], ['d', 'dependency_changed']]);
    expect(node(store, 'c')).toMatchObject({ state: 'stale', generation: 1, dependencies: [{ id: 'b', generation: 1 }] });
    // b's generation is unchanged, but its stale result must not count as an accepted prerequisite.
    expect(dependenciesCurrent(readTaskGraph(store, 'main'), node(store, 'c'))).toBe(false);
    expect(() => acceptStaleTask(store, 'main', 'c', 'still valid')).toThrow(/predecessors are done again/);
    const running = node(store, 'd');
    expect(recordTaskRunOutcome(store, 'main', 'd', running.runId!, { status: 'completed', integrate: true })).toMatchObject({ state: 'stale' });
    expect(taskIntegrationCurrent(store, 'main', 'd', running.generation)).toBe(false);
  });

  it('resumes a shared read-only explorer without a checkout but requires retained execution for writers', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'read', role: 'explorer', goal: 'read' }, { id: 'write', role: 'implementer', goal: 'write' }] });
    await scheduleTasks(store, 'main', fakeHost(store));
    for (const id of ['read', 'write']) {
      const current = node(store, id);
      recordTaskRunOutcome(store, 'main', id, current.runId!, { status: 'completed', finalText: 'NEEDS_INPUT: what next?', integrate: id === 'write' });
      writeTaskNode(store, 'main', { ...node(store, id), checkout: undefined });
    }
    expect(resumeTask(store, 'main', 'read', 'check the public API')).toMatchObject({ state: 'pending', generation: 1, continuation: { mode: 'resume', input: 'check the public API' } });
    expect(() => resumeTask(store, 'main', 'write', 'proceed')).toThrow(/no retained run and checkout/);
  });

  it('invalidates the old generation on accepted redo and makes done successors stale', async () => {
    const { store, directory } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'docs', goal: 'docs', after: ['core'] }, { id: 'tests', goal: 'tests', after: ['core'] }] });
    const host = fakeHost(store);
    await scheduleTasks(store, 'main', host);
    finish(store, 'core');
    await scheduleTasks(store, 'main', host);
    finish(store, 'docs');
    expect(node(store, 'tests').state).toBe('running');
    const { node: redone, notices } = redoTask(store, 'main', 'core', 'use the new header name');
    expect(redone).toMatchObject({ state: 'pending', generation: 2, superseded: [1], continuation: { mode: 'redo', input: 'use the new header name' } });
    expect(redone.retiredCheckouts).toHaveLength(1);
    expect(node(store, 'docs').state).toBe('stale');
    expect(node(store, 'tests')).toMatchObject({ state: 'running', dependencyChanged: true });
    expect(notices.map(item => [item.nodeId, item.reason])).toEqual([['docs', 'became_stale'], ['tests', 'dependency_changed']]);
    // Re-check at successor integration: a run built on generation 1 never integrates.
    const tests = node(store, 'tests');
    expect(recordTaskRunOutcome(store, 'main', 'tests', tests.runId!, { status: 'completed', finalText: 'ok', integrate: true })).toMatchObject({ state: 'stale' });
    expect(readTaskGraph(reopen(store, directory), 'main').nodes.find(item => item.id === 'docs')!.state).toBe('stale');
  });

  it('re-checks generations before integration and when integration finishes', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'tests', goal: 'tests', after: ['core'] }] });
    const host = fakeHost(store);
    await scheduleTasks(store, 'main', host);
    finish(store, 'core');
    await scheduleTasks(store, 'main', host);
    const tests = node(store, 'tests');
    recordTaskRunOutcome(store, 'main', 'tests', tests.runId!, { status: 'completed', finalText: 'ok', integrate: true });
    expect(taskIntegrationCurrent(store, 'main', 'tests', tests.generation)).toBe(true);
    redoTask(store, 'main', 'core');
    expect(node(store, 'tests').state).toBe('stale');
    expect(taskIntegrationCurrent(store, 'main', 'tests', tests.generation)).toBe(false);
    expect(finishTaskIntegration(store, 'main', 'tests', tests.generation, { status: 'integrated' })).toBeUndefined();
    expect(() => acceptStaleTask(store, 'main', 'tests', 'still valid')).toThrow(/predecessors are done again/);
    await scheduleTasks(store, 'main', host);
    finish(store, 'core');
    expect(acceptStaleTask(store, 'main', 'tests', 'header name does not affect these tests')).toMatchObject({ state: 'done', dependencies: [{ id: 'core', generation: 2 }] });
  });

  it('resume keeps the generation and checkout; outcomes of superseded runs are ignored', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'mw', goal: 'middleware' }] });
    const host = fakeHost(store);
    await scheduleTasks(store, 'main', host);
    const first = node(store, 'mw');
    recordTaskRunOutcome(store, 'main', 'mw', first.runId!, { status: 'completed', finalText: 'NEEDS_INPUT: which header?', integrate: true });
    expect(node(store, 'mw').state).toBe('needs_input');
    expect(resumeTask(store, 'main', 'mw', 'Deprecation')).toMatchObject({ state: 'pending', generation: 1, continuation: { mode: 'resume', fromRunId: first.runId, input: 'Deprecation' } });
    await scheduleTasks(store, 'main', host);
    const second = node(store, 'mw');
    expect(second.runId).not.toBe(first.runId);
    expect(second.checkout).toEqual(first.checkout);
    expect(recordTaskRunOutcome(store, 'main', 'mw', first.runId!, { status: 'failed', integrate: false })).toBeUndefined();
    dropTask(store, 'main', 'mw', 'out of scope');
    expect(() => resumeTask(store, 'main', 'mw')).toThrow(/resume applies/);
    expect(() => redoTask(store, 'main', 'mw')).toThrow(/redo applies/);
  });
});

describe('taskGraphCompletionState', () => {
  it('waits without feedback when only self-advancing nodes remain', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'a', goal: 'a' }, { id: 'b', goal: 'b' }, { id: 'c', goal: 'c', after: ['a'] }] });
    await scheduleTasks(store, 'main', fakeHost(store, 1));
    const state = taskGraphCompletionState(store, 'main');
    expect(state.decision).toBe('wait');
    expect(state.feedback).toBeUndefined();
    expect(state.autonomous.map(item => [item.id, item.state])).toEqual([['a', 'running'], ['b', 'queued'], ['c', 'pending']]);
    recordTaskRunOutcome(store, 'main', 'a', node(store, 'a').runId!, { status: 'completed', finalText: 'ok', integrate: true });
    expect(taskGraphCompletionState(store, 'main').autonomous.find(item => item.id === 'a')!.state).toBe('integrating');
  });

  it('gives immediate feedback for failed, dropped, needs_input and self-waiting prerequisites even while others run', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [
      { id: 'core', owner: 'self', goal: 'core' }, { id: 'after-self', goal: 'x', after: ['core'] },
      { id: 'flaky', goal: 'f' }, { id: 'after-failed', goal: 'x', after: ['flaky'] },
      { id: 'gone', goal: 'g' }, { id: 'after-dropped', goal: 'x', after: ['gone'] },
      { id: 'asks', goal: 'q' }, { id: 'busy', goal: 'b' }, { id: 'deep', goal: 'x', after: ['after-failed'] },
    ] });
    dropTask(store, 'main', 'gone', 'superseded by core');
    await scheduleTasks(store, 'main', fakeHost(store));
    recordTaskRunOutcome(store, 'main', 'flaky', node(store, 'flaky').runId!, { status: 'failed', integrate: false });
    recordTaskRunOutcome(store, 'main', 'asks', node(store, 'asks').runId!, { status: 'completed', finalText: 'NEEDS_INPUT: port?', integrate: true });
    const state = taskGraphCompletionState(store, 'main');
    expect(state.decision).toBe('feedback');
    expect(Object.fromEntries(state.needsMain.map(item => [item.id, item.blockers ?? item.state]))).toEqual({
      core: 'pending', 'after-self': ['core'], flaky: 'failed', 'after-failed': ['flaky'], 'after-dropped': ['gone'], asks: 'needs_input', deep: ['flaky'],
    });
    expect(state.autonomous.map(item => item.id)).toEqual(['busy']);
    expect(state.feedback).toMatch(/TASK_GRAPH_INCOMPLETE[\s\S]*after-dropped \(pending\).*blocked by gone/);
    expect(state.droppedHint).toBe('Dropped tasks (disclose them in the final answer): gone: superseded by core');
    acknowledgeTaskFailure(store, 'main', 'flaky');
    expect(taskGraphCompletionState(store, 'main').needsMain.map(item => item.id)).not.toContain('flaky');
    expect(taskGraphCompletionState(store, 'main').needsMain.map(item => item.id)).toContain('after-failed');
  });

  it('passes with only done and dropped nodes, and the terminal re-check detects later changes', async () => {
    const { store } = taskStore();
    declareTasks(store, 'main', { tasks: [{ id: 'core', goal: 'core' }, { id: 'tests', goal: 't', after: ['core'] }, { id: 'extra', goal: 'e' }, { id: 'mine', owner: 'self', goal: 'm', after: ['core'] }] });
    dropTask(store, 'main', 'extra', 'not required');
    const host = fakeHost(store);
    await scheduleTasks(store, 'main', host);
    expect(() => completeSelfTask(store, 'main', 'mine')).toThrow(/unfinished tasks/);
    finish(store, 'core');
    await scheduleTasks(store, 'main', host);
    finish(store, 'tests');
    completeSelfTask(store, 'main', 'mine', 'wired the header');
    const accepted = taskGraphCompletionState(store, 'main');
    expect(accepted).toMatchObject({ decision: 'complete', needsMain: [], autonomous: [], dropped: [{ id: 'extra', reason: 'not required' }] });
    expect(taskGraphTerminalCheck(store, 'main', accepted.fingerprint)).toMatchObject({ valid: true, staleDone: [] });
    redoTask(store, 'main', 'core');
    const terminal = taskGraphTerminalCheck(store, 'main', accepted.fingerprint);
    expect(terminal.valid).toBe(false);
    expect(terminal.state.decision).toBe('feedback');
    expect(terminal.state.needsMain.map(item => [item.id, item.state])).toEqual([['tests', 'stale'], ['mine', 'stale']]);
  });
});
